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

let db = { quizzes: [], roster: {} };

function newId() {
  return 'q-' + randomUUID().slice(0, 8);
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
        console.log(`📚 מאגרי שאלות נטענו מ-Redis (${db.quizzes.length} מאגרים) — אחסון קבוע ✓`);
        return;
      }
      // Redis ריק — זריעה ראשונית מהקובץ ושמירה ל-Redis
      db = loadFromFile();
      await redisSet(db);
      console.log('📚 Redis היה ריק — נזרע מהקובץ ונשמר. אחסון קבוע ✓');
      return;
    } catch (e) {
      console.error('חיבור ל-Redis נכשל, משתמש בקובץ מקומי:', e.message);
    }
  }
  db = loadFromFile();
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
  if (val && typeof val === 'object' && ('first' in val || 'last' in val)) {
    return {
      first: String(val.first || '').trim().slice(0, 40),
      last: String(val.last || '').trim().slice(0, 40),
    };
  }
  const raw = typeof val === 'string' ? val : String((val && val.name) || '');
  const t = raw.trim();
  const sp = t.indexOf(' ');
  if (sp === -1) return { first: t.slice(0, 40), last: '' };
  return { first: t.slice(0, sp).slice(0, 40), last: t.slice(sp + 1).trim().slice(0, 40) };
}

/** שם תצוגה מלא מרשומה (שם פרטי + משפחה). */
function fullName(entry) {
  const e = normalizeEntry(entry);
  return (e.first + ' ' + e.last).trim();
}

/** מחזיר את רשימת השמות כמערך [{ phone, first, last, name }] לתצוגה/עריכה. */
export function listRoster() {
  const roster = db.roster || {};
  return Object.keys(roster).map((phone) => {
    const e = normalizeEntry(roster[phone]);
    return { phone, first: e.first, last: e.last, name: fullName(e) };
  });
}

/** מחליף את כל הרשימה. מקבל מערך [{ phone, first, last }] (או פורמט ישן); מנרמל ושומר. */
export function setRoster(entries) {
  const roster = {};
  if (Array.isArray(entries)) {
    for (const e of entries.slice(0, 2000)) {
      const phone = normalizePhone(e && e.phone);
      const norm = normalizeEntry(e);
      if (phone && (norm.first || norm.last)) roster[phone] = norm;
    }
  }
  db.roster = roster;
  save();
  return listRoster();
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
