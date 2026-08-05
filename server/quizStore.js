import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const QUIZZES_PATH = join(DATA_DIR, 'quizzes.json');
const LEGACY_PATH = join(DATA_DIR, 'questions.json');

/**
 * ניהול מאגרי שאלות (quizzes) עם **אחסון קבוע**.
 *
 * הבעיה שנפתרת: הדיסק של Render החינמי הוא זמני — בכל אתחול/פריסה הקובץ המקומי
 * חוזר לגרסת ה-git, וכל עריכה נמחקת. הפתרון: אחסון ב-Upstash Redis (חינמי, קבוע)
 * אם מוגדרים משתני הסביבה; אחרת נפילה-חזרה לקובץ מקומי (לפיתוח).
 *
 * כל מאגר: { id, name, questions: [ { category, text, options[4], correct, timeLimit, points } ] }.
 */

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REDIS_KEY = 'kosher-trivia:quizzes';
const redisEnabled = () => !!(REDIS_URL && REDIS_TOKEN);

let db = { quizzes: [], roster: {}, classes: [], gameHistory: [], classResetAt: 0 };

function newId() {
  return 'q-' + randomUUID().slice(0, 8);
}

// --- כיתות: קוד קבוע וייחודי לכל כיתה (הקוד שהתלמידות מקישות בטלפון) ---
function genClassCode(used) {
  let code;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (used.has(code));
  used.add(code);
  return code;
}

// 8 הכיתות של בית הספר (id יציב → שם). הקוד נוצר פעם אחת ונשאר קבוע.
const SCHOOL_CLASSES = [
  ['t1', 'ט1'], ['t2', 'ט2'], ['y1', 'י1'], ['y2', 'י2'],
  ['ya1', 'יא1'], ['ya2', 'יא2'], ['yb1', 'יב1'], ['yb2', 'יב2'],
];
const CLASS_SCHEMA = 'v2-8'; // גרסת מבנה הכיתות; שינוי → מיגרציה חד-פעמית

/** רשימת ברירת מחדל: סלון (כל בית הספר) + 8 כיתות, כל אחת עם קוד קבוע. */
function defaultClasses() {
  const used = new Set();
  const mk = (id, name, salon) => ({ id, name, code: genClassCode(used), salon: !!salon });
  return [mk('salon', 'סלון', true), ...SCHOOL_CLASSES.map(([id, name]) => mk(id, name))];
}

/** מוודא שכל השדות קיימים אחרי טעינה (Redis/קובץ ישן) + יוצר כיתות ברירת מחדל. מחזיר true אם שינה. */
function ensureDbShape() {
  let changed = false;
  if (!Array.isArray(db.quizzes)) { db.quizzes = []; changed = true; }
  if (!db.roster || typeof db.roster !== 'object') { db.roster = {}; changed = true; }
  if (!Array.isArray(db.gameHistory)) { db.gameHistory = []; changed = true; }
  if (typeof db.classResetAt !== 'number') { db.classResetAt = 0; changed = true; }
  if (!Array.isArray(db.classes) || db.classes.length === 0) { db.classes = defaultClasses(); changed = true; }
  // מיגרציה חד-פעמית ל-8 הכיתות האמיתיות (שומרת את הסלון הקיים + הקוד שלו).
  if (db.classSchema !== CLASS_SCHEMA) {
    const salon = (db.classes || []).find((c) => c.salon);
    const used = new Set(salon ? [salon.code] : []);
    const eight = SCHOOL_CLASSES.map(([id, name]) => ({ id, name, code: genClassCode(used), salon: false }));
    db.classes = [salon || { id: 'salon', name: 'סלון', code: genClassCode(used), salon: true }, ...eight];
    db.classSchema = CLASS_SCHEMA;
    changed = true;
  }
  // השלמת קוד קבוע לכל כיתה שאין לה (הקוד לא משתנה לעולם — התלמידות מקישות אותו)
  const used = new Set(db.classes.map((c) => c.code).filter(Boolean));
  for (const c of db.classes) {
    if (!c.code) { c.code = genClassCode(used); changed = true; }
  }
  return changed;
}

/**
 * נרמול מספר טלפון לצורה אחידה: ספרות בלבד, המרת קידומת בינ"ל 972 ל-0.
 * מאפשר התאמה בין מה שהמורה הזינה (עם/בלי מקפים) למה שימות מדווחת.
 */
export function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('972')) d = '0' + d.slice(3);
  return d;
}

/** ניקוי ואימות שאלה בודדת — מבטיח מבנה תקין לפני שמירה. */
function sanitizeQuestion(q) {
  // תמיכה ב-2 עד 4 תשובות (2 = שאלת נכון/לא-נכון, 4 = רב-ברירה). לא פוגע בשאלות קיימות.
  let options = Array.isArray(q.options) ? q.options.slice(0, 4).map((o) => String(o).slice(0, 120)) : [];
  while (options.length < 2) options.push('');
  let correct = Number.isInteger(q.correct) ? q.correct : 0;
  if (correct < 0 || correct >= options.length) correct = 0;
  let timeLimit = Number(q.timeLimit);
  if (!Number.isFinite(timeLimit) || timeLimit < 5) timeLimit = 20;
  if (timeLimit > 120) timeLimit = 120;
  let points = Number(q.points);
  if (!Number.isFinite(points) || points < 0) points = 1000;
  if (points > 100000) points = 100000;
  const clean = {
    category: String(q.category || 'כללי').slice(0, 40),
    text: String(q.text || '').slice(0, 300),
    options,
    correct,
    timeLimit: Math.round(timeLimit),
    points: Math.round(points),
  };
  // מדיה אופציונלית (תמונה/סרטון/הקלטה) — מוצגת/מושמעת רק במסך המנחה
  if (q.media && ['image', 'video', 'audio'].includes(q.media.type) && q.media.url) {
    clean.media = { type: q.media.type, url: String(q.media.url).slice(0, 500) };
  }
  return clean;
}

// --- Upstash Redis (REST) ---
async function redisGet() {
  const r = await fetch(`${REDIS_URL}/get/${REDIS_KEY}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  if (!r.ok) throw new Error('redis get ' + r.status);
  const data = await r.json();
  return data.result ? JSON.parse(data.result) : null;
}

async function redisSet(value) {
  const r = await fetch(`${REDIS_URL}/set/${REDIS_KEY}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error('redis set ' + r.status);
}

function loadFromFile() {
  if (existsSync(QUIZZES_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(QUIZZES_PATH, 'utf8'));
      if (Array.isArray(parsed.quizzes)) return parsed;
    } catch (e) {
      console.warn('quizzes.json פגום:', e.message);
    }
  }
  // זריעה ראשונית מהקובץ הישן questions.json
  let seed = [];
  try {
    if (existsSync(LEGACY_PATH)) seed = JSON.parse(readFileSync(LEGACY_PATH, 'utf8'));
  } catch { /* מתעלמים */ }
  return { quizzes: [{ id: newId(), name: 'טריוויה כללית', questions: seed.map(sanitizeQuestion) }] };
}

function writeFileBackup() {
  try {
    writeFileSync(QUIZZES_PATH, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.warn('כתיבת גיבוי מקומי נכשלה:', e.message);
  }
}

/** שמירה: גיבוי מקומי + אחסון קבוע ב-Redis (אם מוגדר). */
function save() {
  writeFileBackup();
  if (redisEnabled()) {
    redisSet(db).catch((e) => console.error('שמירה ל-Redis נכשלה:', e.message));
  }
}

/** אתחול — נקרא פעם אחת בעליית השרת (לפני שמתחילים להאזין). */
export async function init() {
  if (redisEnabled()) {
    try {
      const remote = await redisGet();
      if (remote && Array.isArray(remote.quizzes) && remote.quizzes.length) {
        db = remote;
        const changed = ensureDbShape(); // השלמת כיתות/היסטוריה למאגר קיים
        if (changed) await redisSet(db);
        console.log(`📚 מאגרי שאלות נטענו מ-Redis (${db.quizzes.length} מאגרים, ${db.classes.length} כיתות) — אחסון קבוע ✓`);
        return;
      }
      // Redis ריק — זריעה ראשונית מהקובץ ושמירה ל-Redis
      db = loadFromFile();
      ensureDbShape();
      await redisSet(db);
      console.log('📚 Redis היה ריק — נזרע מהקובץ ונשמר. אחסון קבוע ✓');
      return;
    } catch (e) {
      console.error('חיבור ל-Redis נכשל, משתמש בקובץ מקומי:', e.message);
    }
  }
  db = loadFromFile();
  ensureDbShape();
  writeFileBackup();
  console.log('📚 מאגרי שאלות נטענו מקובץ מקומי (אחסון זמני — הגדירי Redis לאחסון קבוע)');
}

// --- API ציבורי ---

export function listQuizzes() {
  return db.quizzes.map((q) => ({ id: q.id, name: q.name, count: q.questions.length }));
}

export function getQuiz(id) {
  return db.quizzes.find((q) => q.id === id) || null;
}

export function firstQuiz() {
  return db.quizzes[0] || null;
}

export function createQuiz(name) {
  const quiz = { id: newId(), name: String(name || 'מאגר חדש').slice(0, 60), questions: [] };
  db.quizzes.push(quiz);
  save();
  return quiz;
}

export function updateQuiz(id, { name, questions } = {}) {
  const quiz = getQuiz(id);
  if (!quiz) return null;
  if (typeof name === 'string') quiz.name = name.slice(0, 60);
  if (Array.isArray(questions)) quiz.questions = questions.map(sanitizeQuestion);
  save();
  return quiz;
}

export function deleteQuiz(id) {
  if (db.quizzes.length <= 1) return false; // תמיד משאירים מאגר אחד לפחות
  const idx = db.quizzes.findIndex((q) => q.id === id);
  if (idx === -1) return false;
  db.quizzes.splice(idx, 1);
  save();
  return true;
}

// --- רשימת שמות לפי מספר טלפון (roster) — למחייגות בטלפון כשר ---

/**
 * מנרמל ערך רשומה לרשימה לצורת { first, last }.
 * סלחני לפורמט ישן: מחרוזת בודדת → שם פרטי; או { name } → פיצול ברווח ראשון.
 */
function normalizeEntry(val) {
  if (val && typeof val === 'object' && ('first' in val || 'last' in val || 'cls' in val || 'class' in val)) {
    return {
      first: String(val.first || '').trim().slice(0, 40),
      last: String(val.last || '').trim().slice(0, 40),
      cls: String(val.cls || val.class || '').trim().slice(0, 20), // כיתה (ט1, י2 ...)
    };
  }
  const raw = typeof val === 'string' ? val : String((val && val.name) || '');
  const t = raw.trim();
  const sp = t.indexOf(' ');
  if (sp === -1) return { first: t.slice(0, 40), last: '', cls: '' };
  return { first: t.slice(0, sp).slice(0, 40), last: t.slice(sp + 1).trim().slice(0, 40), cls: '' };
}

/** שם תצוגה מלא מרשומה (שם פרטי + משפחה). */
function fullName(entry) {
  const e = normalizeEntry(entry);
  return (e.first + ' ' + e.last).trim();
}

/** מחזיר את רשימת השמות כמערך [{ phone, first, last, class, name }] לתצוגה/עריכה. */
export function listRoster() {
  const roster = db.roster || {};
  return Object.keys(roster).map((phone) => {
    const e = normalizeEntry(roster[phone]);
    return { phone, first: e.first, last: e.last, class: e.cls, name: fullName(e) };
  });
}

/** מחליף את כל הרשימה. מקבל מערך [{ phone, first, last, class }] (או פורמט ישן); מנרמל ושומר. */
export function setRoster(entries) {
  const roster = {};
  if (Array.isArray(entries)) {
    for (const e of entries.slice(0, 2000)) {
      const phone = normalizePhone(e && e.phone);
      const norm = normalizeEntry(e);
      if (phone && (norm.first || norm.last || norm.cls)) roster[phone] = norm;
    }
  }
  db.roster = roster;
  save();
  return listRoster();
}

/** חיפוש הכיתה (מהרשימה) לפי מספר טלפון — לזיהוי אוטומטי כשמחייגות לסלון. */
export function lookupClass(rawPhone) {
  const roster = db.roster || {};
  const norm = normalizePhone(rawPhone);
  if (!norm) return '';
  const hit = roster[norm] || (norm.length >= 9 ? roster[Object.keys(roster).find((k) => k.slice(-9) === norm.slice(-9))] : null);
  return hit ? normalizeEntry(hit).cls : '';
}

/**
 * חיפוש שם מלא (פרטי + משפחה) לפי מספר טלפון. מנרמל את שני הצדדים; אם אין התאמה
 * מדויקת, מנסה התאמה לפי 9 הספרות האחרונות (סלחני לקידומות/אפסים מובילים).
 */
export function lookupName(rawPhone) {
  const roster = db.roster || {};
  const norm = normalizePhone(rawPhone);
  if (!norm) return null;
  if (roster[norm]) return fullName(roster[norm]);
  const suffix = norm.slice(-9);
  if (suffix.length === 9) {
    for (const key of Object.keys(roster)) {
      if (key.slice(-9) === suffix) return fullName(roster[key]);
    }
  }
  return null;
}

// --- כיתות + היסטוריית משחקים (תחרות בין-כיתתית) ---

/** רשימת הכיתות [{ id, name, code, salon }]. הקוד קבוע — התלמידות מקישות אותו בטלפון. */
export function listClasses() {
  return (db.classes || []).map((c) => ({ id: c.id, name: c.name, code: c.code, salon: !!c.salon }));
}

export function getClass(id) {
  return (db.classes || []).find((c) => c.id === id) || null;
}

/** שינוי שם כיתה בלבד — הקוד לעולם לא משתנה (התלמידות זוכרות אותו). */
export function renameClass(id, name) {
  const c = getClass(id);
  if (!c) return null;
  const n = String(name || '').trim().slice(0, 40);
  if (n) c.name = n;
  save();
  return listClasses();
}

/**
 * מחליף את רשימת הכיתות (הוספה/מחיקה/שינוי שם). **משמר את הקוד** של כל כיתה קיימת
 * לפי ה-id — כדי שקודי הטלפון לא ישתנו. כיתה חדשה מקבלת id + קוד ייחודי.
 */
export function setClasses(entries) {
  if (!Array.isArray(entries)) return listClasses();
  const prevById = new Map((db.classes || []).map((c) => [c.id, c]));
  const used = new Set();
  const out = [];
  for (const e of entries.slice(0, 30)) {
    const name = String((e && e.name) || '').trim().slice(0, 40);
    if (!name) continue;
    const existing = e && e.id ? prevById.get(e.id) : null;
    const id = existing ? existing.id : (e && e.salon ? 'salon' : 'c-' + randomUUID().slice(0, 6));
    let code = existing ? existing.code : null;
    if (!code || used.has(code)) code = genClassCode(used); else used.add(code);
    out.push({ id, name, code, salon: existing ? !!existing.salon : !!(e && e.salon) });
  }
  if (out.length === 0) return listClasses(); // לא מוחקים הכל בטעות
  if (!out.some((c) => c.salon)) {
    const s = getClass('salon');
    out.unshift({ id: 'salon', name: s ? s.name : 'סלון', code: s ? s.code : genClassCode(used), salon: true });
  }
  db.classes = out;
  save();
  return listClasses();
}

/** שומר משחק שהסתיים בהיסטוריה (כולל data=exportData לייצוא חוזר). */
export function saveGame(rec = {}) {
  const record = {
    id: 'g-' + randomUUID().slice(0, 8),
    classId: rec.classId || null,
    className: rec.className || '',
    quizName: rec.quizName || '',
    playedAt: Date.now(),
    classTotal: Number(rec.classTotal) || 0,
    data: rec.data || null,
  };
  db.gameHistory.push(record);
  if (db.gameHistory.length > 200) db.gameHistory = db.gameHistory.slice(-200);
  save();
  return record;
}

/** רשימת משחקים קודמים (תקציר, בלי ה-data הכבד), מהחדש לישן. */
export function listGames() {
  return (db.gameHistory || []).slice().reverse().map((g) => ({
    id: g.id, classId: g.classId, className: g.className, quizName: g.quizName,
    playedAt: g.playedAt, classTotal: g.classTotal,
    players: g.data && Array.isArray(g.data.players) ? g.data.players.length : 0,
  }));
}

export function getGame(id) {
  return (db.gameHistory || []).find((g) => g.id === id) || null;
}

export function deleteGame(id) {
  const i = (db.gameHistory || []).findIndex((g) => g.id === id);
  if (i === -1) return false;
  db.gameHistory.splice(i, 1);
  save();
  return true;
}

/** איפוס הצבירה הכיתתית — מסמן חותמת זמן; הצבירה נספרת רק ממשחקים שאחריה. */
export function resetClassScores() {
  db.classResetAt = Date.now();
  save();
  return db.classResetAt;
}

/** נקודות נצברות לכל כיתה = Σ classTotal בהיסטוריה מאז האיפוס (ללא סלון). */
export function accumulatedByClass() {
  const since = db.classResetAt || 0;
  const acc = {};
  for (const g of db.gameHistory || []) {
    if (!g.classId || g.playedAt < since) continue;
    acc[g.classId] = (acc[g.classId] || 0) + (Number(g.classTotal) || 0);
  }
  return acc;
}
