import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
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
// תמונות מותאמות (לוגו, תמונת רקע) נשמרות כל אחת במפתח נפרד (כבדות יחסית) — כדי לא לשלוח
// אותן בכל שמירה של המאגרים. ערך: data URL, או null = ברירת המחדל.
const ASSETS = {
  logo: { key: 'kosher-trivia:logo', path: join(DATA_DIR, 'custom-logo.txt'), version: 'logoVersion' },
  bg:   { key: 'kosher-trivia:bg',   path: join(DATA_DIR, 'custom-bg.txt'),   version: 'bgVersion' },
};
const DEFAULT_THEME = { palette: 'purple', schoolName: 'בנות לאה', logoVersion: 0, bgVersion: 0, bgDim: true };
const assetData = { logo: null, bg: null };
const redisEnabled = () => !!(REDIS_URL && REDIS_TOKEN);
// נכתב ל-Redis רק אחרי קריאה מוצלחת באתחול — הגנה מפני דריסת נתונים חיים אם Redis
// לא נגיש רגעית בעלייה (אחרת נטען קובץ ריק ונדרוס את הרשימות/הניקוד ב-Redis).
let redisReadOK = false;
// שינויים שנעשו בזמן ש-Redis לא היה נגיש (נשמרו רק בזיכרון) — ימוזגו ל-Redis כשיחזור
const offline = { touchedQuizIds: new Set(), deletedQuizIds: new Set(), rosterTouched: false, themeTouched: false, assetsTouched: new Set(), mediaTouched: new Set(), games: [] };
const reloadListeners = [];

let db = { quizzes: [], roster: {}, classes: [], gameHistory: [], classResetAt: 0 };

/** מצב האחסון: 'redis' = קבוע ✓ | 'offline' = Redis מוגדר אך לא נגיש (שמירה זמנית!) | 'file' = פיתוח מקומי */
export function storageStatus() {
  if (!redisEnabled()) return { mode: 'file' };
  return { mode: redisReadOK ? 'redis' : 'offline' };
}
/** רישום פונקציה שתרוץ כשהנתונים נטענים מחדש מ-Redis (למשל ליצירת חדרי הכיתות בקודים הנכונים). */
export function onReload(fn) { reloadListeners.push(fn); }

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
// הקודים הקבועים שהתלמידות מכירות (10/2026). אם מאגר הנתונים יימחק/יתאפס — הכיתות ייווצרו
// מחדש **באותם קודים** ולא בקודים אקראיים חדשים.
const FIXED_CODES = {
  salon: '2299', t1: '6236', t2: '7353', y1: '8231', y2: '1741',
  ya1: '3886', ya2: '4741', yb1: '7732', yb2: '5680',
};
function codeFor(id, used) {
  const f = FIXED_CODES[id];
  if (f && !used.has(f)) { used.add(f); return f; }
  return genClassCode(used);
}

/** רשימת ברירת מחדל: סלון (כל בית הספר) + 8 כיתות, כל אחת עם קוד קבוע. */
function defaultClasses() {
  const used = new Set();
  const mk = (id, name, salon) => ({ id, name, code: codeFor(id, used), salon: !!salon });
  return [mk('salon', 'סלון', true), ...SCHOOL_CLASSES.map(([id, name]) => mk(id, name))];
}

/** מוודא שכל השדות קיימים אחרי טעינה (Redis/קובץ ישן) + יוצר כיתות ברירת מחדל. מחזיר true אם שינה. */
function ensureDbShape() {
  let changed = false;
  if (!Array.isArray(db.quizzes)) { db.quizzes = []; changed = true; }
  if (!db.roster || typeof db.roster !== 'object') { db.roster = {}; changed = true; }
  if (!Array.isArray(db.gameHistory)) { db.gameHistory = []; changed = true; }
  if (typeof db.classResetAt !== 'number') { db.classResetAt = 0; changed = true; }
  if (!db.theme || typeof db.theme !== 'object') { db.theme = { ...DEFAULT_THEME }; changed = true; }
  if (!db.mediaIndex || typeof db.mediaIndex !== 'object') { db.mediaIndex = {}; changed = true; }
  if (!Array.isArray(db.classes) || db.classes.length === 0) { db.classes = defaultClasses(); changed = true; }
  // מיגרציה חד-פעמית ל-8 הכיתות האמיתיות (שומרת את הסלון הקיים + הקוד שלו).
  if (db.classSchema !== CLASS_SCHEMA) {
    const salon = (db.classes || []).find((c) => c.salon);
    const used = new Set(salon ? [salon.code] : []);
    const eight = SCHOOL_CLASSES.map(([id, name]) => ({ id, name, code: codeFor(id, used), salon: false }));
    db.classes = [salon || { id: 'salon', name: 'סלון', code: codeFor('salon', used), salon: true }, ...eight];
    db.classSchema = CLASS_SCHEMA;
    changed = true;
  }
  // השלמת קוד קבוע לכל כיתה שאין לה (הקוד לא משתנה לעולם — התלמידות מקישות אותו)
  const used = new Set(db.classes.map((c) => c.code).filter(Boolean));
  for (const c of db.classes) {
    if (!c.code) { c.code = codeFor(c.id, used); changed = true; }
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
async function redisGet(key = REDIS_KEY) {
  const r = await fetch(`${REDIS_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  if (!r.ok) throw new Error('redis get ' + r.status);
  const data = await r.json();
  return data.result ? JSON.parse(data.result) : null;
}

async function redisSet(value, key = REDIS_KEY) {
  const r = await fetch(`${REDIS_URL}/set/${key}`, {
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
  // כותבים ל-Redis רק אם הקריאה באתחול הצליחה — כדי לא לדרוס נתונים חיים בזמן תקלת Redis
  if (redisEnabled() && redisReadOK) {
    redisSet(db).catch((e) => console.error('שמירה ל-Redis נכשלה:', e.message));
  }
}

// --- פעימה + התחברות-מחדש ל-Redis ---
// Upstash מוחקים בסיס חינמי אחרי 14 יום בלי פעילות (כך אבדו הנתונים ב-09/2026).
// פעימה פעמיים ביום שומרת על הבסיס "פעיל" כל עוד השרת רץ.
const HEARTBEAT_KEY = 'kosher-trivia:heartbeat';
let heartbeatTimer = null;
let reconnectTimer = null;

function startHeartbeat() {
  if (heartbeatTimer) return;
  const beat = () =>
    fetch(`${REDIS_URL}/set/${HEARTBEAT_KEY}/${Date.now()}`, { method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}` } })
      .then((r) => { if (!r.ok) throw new Error('status ' + r.status); })
      .catch((e) => console.error('פעימת Redis נכשלה:', e.message));
  beat();
  heartbeatTimer = setInterval(beat, 12 * 60 * 60 * 1000);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

const isOffline = () => redisEnabled() && !redisReadOK;

/** מיזוג שינויים שנעשו בזמן ניתוק לתוך הנתונים מ-Redis (לא מוחקים כלום — רק מוסיפים/מעדכנים מה שנגעו בו). */
function mergeOffline(remote) {
  const merged = remote;
  const idx = new Map(merged.quizzes.map((q, i) => [q.id, i]));
  for (const id of offline.touchedQuizIds) {
    const q = db.quizzes.find((x) => x.id === id);
    if (!q) continue;
    if (idx.has(id)) merged.quizzes[idx.get(id)] = q; else merged.quizzes.push(q);
  }
  if (offline.rosterTouched) merged.roster = { ...(merged.roster || {}), ...(db.roster || {}) };
  if (offline.games.length) merged.gameHistory = [...(merged.gameHistory || []), ...offline.games];
  if (offline.themeTouched || offline.assetsTouched.size) merged.theme = db.theme;
  if (offline.mediaTouched.size) merged.mediaIndex = { ...(merged.mediaIndex || {}), ...(db.mediaIndex || {}) };
  return merged;
}

/** כש-Redis לא נגיש באתחול — מנסים שוב כל דקה; כשחוזר, טוענים/ממזגים ושומרים לצמיתות. */
function startReconnectLoop() {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(async () => {
    let remote;
    try { remote = await redisGet(); } catch { return; } // עדיין לא נגיש
    clearInterval(reconnectTimer);
    reconnectTimer = null;
    if (remote && Array.isArray(remote.quizzes) && remote.quizzes.length) db = mergeOffline(remote);
    // אחרת Redis ריק — שומרים את מה שבזיכרון (כולל מה שהועלה בזמן הניתוק)
    ensureDbShape();
    redisReadOK = true;
    try { await redisSet(db); } catch (e) { console.error('שמירה אחרי חיבור-מחדש נכשלה:', e.message); }
    for (const name of Object.keys(ASSETS)) {
      if (offline.assetsTouched.has(name)) {
        try { await redisSet(assetData[name], ASSETS[name].key); } catch (e) { console.error(`שמירת ${name} אחרי חיבור-מחדש נכשלה:`, e.message); }
      } else {
        await loadAsset(name);
      }
    }
    for (const id of offline.mediaTouched) {
      const m = mediaCache.get(id) || readMediaFile(id);
      if (m) { try { await redisSet({ mime: m.mime, b64: m.buffer.toString('base64') }, MEDIA_PREFIX + id); } catch (e) { console.error('שמירת קובץ מדיה אחרי חיבור-מחדש נכשלה:', e.message); } }
    }
    offline.touchedQuizIds.clear(); offline.rosterTouched = false; offline.themeTouched = false; offline.assetsTouched.clear(); offline.mediaTouched.clear(); offline.games = [];
    console.log(`✅ Redis חזר — ${db.quizzes.length} מאגרים נטענו/מוזגו ונשמרו לצמיתות`);
    startHeartbeat();
    for (const fn of reloadListeners) { try { fn(); } catch (e) { console.error(e.message); } }
  }, 60 * 1000);
}

/** אתחול — נקרא פעם אחת בעליית השרת (לפני שמתחילים להאזין). */
export async function init() {
  if (redisEnabled()) {
    // עד 3 ניסיונות קריאה — תקלת Redis רגעית בעלייה לא צריכה להוביל לדריסת נתונים חיים
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const remote = await redisGet();
        redisReadOK = true; // קריאה הצליחה → מותר לכתוב ל-Redis
        if (remote && Array.isArray(remote.quizzes) && remote.quizzes.length) {
          db = remote;
          const changed = ensureDbShape();
          if (changed) await redisSet(db);
          console.log(`📚 מאגרי שאלות נטענו מ-Redis (${db.quizzes.length} מאגרים, ${db.classes.length} כיתות) — אחסון קבוע ✓`);
        } else {
          // Redis ריק — זריעה ראשונית מהקובץ ושמירה
          db = loadFromFile();
          ensureDbShape();
          await redisSet(db);
          console.log('📚 Redis היה ריק — נזרע מהקובץ ונשמר. אחסון קבוע ✓');
        }
        await loadAssets();
        startHeartbeat();
        return;
      } catch (e) {
        console.error(`חיבור ל-Redis נכשל (ניסיון ${attempt}/3):`, e.message);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 500));
      }
    }
    // כל הניסיונות נכשלו — עובדים מקובץ מקומי בלבד, בלי לכתוב ל-Redis (הגנה מפני דריסה)
    db = loadFromFile();
    ensureDbShape();
    await loadAssets();
    console.error('⚠️ Redis לא נגיש — עובדים מקומית בלבד, לא נכתוב ל-Redis כדי לא לדרוס נתונים חיים. ננסה להתחבר שוב כל דקה.');
    startReconnectLoop();
    return;
  }
  db = loadFromFile();
  ensureDbShape();
  writeFileBackup();
  await loadAssets();
  console.log('📚 מאגרי שאלות נטענו מקובץ מקומי (אחסון זמני — הגדירי Redis לאחסון קבוע)');
}

// --- עיצוב: צבע רקע + לוגו + שם בית הספר (משותף לכל המסכים) ---

/** טעינת תמונה מותאמת: מ-Redis כשמחובר, אחרת מהגיבוי המקומי. */
async function loadAsset(name) {
  const a = ASSETS[name];
  if (redisEnabled() && redisReadOK) {
    try { assetData[name] = (await redisGet(a.key)) || null; return; }
    catch (e) { console.error(`טעינת ${name} מ-Redis נכשלה:`, e.message); }
  }
  try { assetData[name] = existsSync(a.path) ? (readFileSync(a.path, 'utf8').trim() || null) : null; }
  catch { assetData[name] = null; }
}
async function loadAssets() { for (const name of Object.keys(ASSETS)) await loadAsset(name); }

export function getTheme() {
  return { ...DEFAULT_THEME, ...(db.theme || {}), hasLogo: !!assetData.logo, hasBg: !!assetData.bg };
}

export function setTheme({ palette, schoolName, bgDim } = {}) {
  const t = { ...DEFAULT_THEME, ...(db.theme || {}) };
  if (typeof palette === 'string' && /^[a-z0-9-]{1,24}$/.test(palette)) {
    t.palette = palette;
    if (palette !== 'image') t.prevPalette = palette; // הצבע שחוזרים אליו כשמסירים את תמונת הרקע
  }
  if (typeof schoolName === 'string') t.schoolName = schoolName.trim().slice(0, 60) || DEFAULT_THEME.schoolName;
  if (typeof bgDim === 'boolean') t.bgDim = bgDim;
  db.theme = t;
  if (isOffline()) offline.themeTouched = true;
  save();
  return getTheme();
}

/** תמונה מותאמת ('logo' | 'bg') כ-{ mime, buffer }, או null אם משתמשים בברירת המחדל. */
export function getAsset(name) {
  const m = /^data:(image\/(?:png|webp|jpeg|gif));base64,(.+)$/.exec(assetData[name] || '');
  return m ? { mime: m[1], buffer: Buffer.from(m[2], 'base64') } : null;
}

/** החלפת תמונה מותאמת (data URL), או null לחזרה לברירת המחדל. */
export function setAsset(name, dataUrl) {
  const a = ASSETS[name];
  if (!a) throw new Error('סוג תמונה לא מוכר');
  if (dataUrl != null) {
    if (typeof dataUrl !== 'string' || !/^data:image\/(png|webp|jpeg|gif);base64,/.test(dataUrl)) throw new Error('קובץ תמונה לא תקין');
    if (dataUrl.length > 900000) throw new Error('התמונה גדולה מדי');
  }
  assetData[name] = dataUrl || null;
  const t = { ...DEFAULT_THEME, ...(db.theme || {}), [a.version]: Date.now() };
  if (name === 'bg') {
    // העלאת תמונת רקע → מציגים אותה; הסרה → חזרה לצבע הקודם
    if (dataUrl) { if (t.palette !== 'image') t.prevPalette = t.palette; t.palette = 'image'; }
    else if (t.palette === 'image') t.palette = t.prevPalette || DEFAULT_THEME.palette;
  }
  db.theme = t;
  try { writeFileSync(a.path, assetData[name] || '', 'utf8'); } catch (e) { console.warn(`גיבוי מקומי של ${name} נכשל:`, e.message); }
  if (redisEnabled() && redisReadOK) {
    redisSet(assetData[name], a.key).catch((e) => console.error(`שמירת ${name} ל-Redis נכשלה:`, e.message));
  } else if (isOffline()) {
    offline.assetsTouched.add(name);
  }
  save();
  return getTheme();
}

// --- קבצי מדיה לשאלות (תמונה / הקלטה / סרטון קצר) ---
// כל קובץ במפתח Redis משלו (`kosher-trivia:media:<id>`), כ-{ mime, b64 }. Upstash חינמי: עד 10MB
// לבקשה ו-256MB בסך הכל — לכן קובץ עד 7MB (base64 מנפח ב-33%) וסך הכל עד 150MB.
// קבצים נשמרים גם בזיכרון השרת (מטמון), כדי לא למשוך אותם מ-Redis בכל הצגה.
const MEDIA_PREFIX = 'kosher-trivia:media:';
const MEDIA_DIR = join(DATA_DIR, 'media');
export const MEDIA_MAX_BYTES = 7 * 1024 * 1024;
const MEDIA_TOTAL_MAX = 150 * 1024 * 1024;
const MEDIA_CACHE_MAX = 80 * 1024 * 1024;
const MEDIA_MIME = /^(image\/(jpeg|png|gif|webp)|audio\/(mpeg|mp3|mp4|x-m4a|m4a|aac|wav|x-wav|wave|ogg|webm)|video\/(mp4|webm|quicktime|ogg))$/;
const mediaCache = new Map(); // id → { mime, buffer } (סדר הכנסה = LRU פשוט)
let mediaCacheBytes = 0;

function cacheMedia(id, m) {
  if (mediaCache.has(id)) { mediaCacheBytes -= mediaCache.get(id).buffer.length; mediaCache.delete(id); }
  mediaCache.set(id, m); mediaCacheBytes += m.buffer.length;
  for (const [k, v] of mediaCache) {
    if (mediaCacheBytes <= MEDIA_CACHE_MAX) break;
    mediaCache.delete(k); mediaCacheBytes -= v.buffer.length;
  }
}
function readMediaFile(id) {
  try {
    const p = join(MEDIA_DIR, id + '.json');
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return { mime: j.mime, buffer: Buffer.from(j.b64, 'base64') };
  } catch { return null; }
}

/** שמירת קובץ מדיה חדש. מחזיר { id, url }. */
export async function saveMedia(buffer, mime) {
  mime = String(mime || '').split(';')[0].trim().toLowerCase();
  if (!MEDIA_MIME.test(mime)) throw new Error('סוג קובץ לא נתמך — אפשר תמונה, הקלטה (mp3/m4a/wav) או סרטון (mp4)');
  if (!buffer || !buffer.length) throw new Error('הקובץ ריק');
  if (buffer.length > MEDIA_MAX_BYTES) throw new Error('הקובץ גדול מדי (עד 7MB)');
  const used = Object.values(db.mediaIndex || {}).reduce((s, m) => s + (m.size || 0), 0);
  if (used + buffer.length > MEDIA_TOTAL_MAX) throw new Error('המקום לקבצים מלא — מחקי קבצים משאלות ישנות, או השתמשי בקישור מגוגל דרייב');
  const id = randomUUID().replace(/-/g, '').slice(0, 16);
  const rec = { mime, b64: buffer.toString('base64') };
  if (redisEnabled() && redisReadOK) await redisSet(rec, MEDIA_PREFIX + id); // ממתינים — כדי לדעת שבאמת נשמר
  else if (isOffline()) offline.mediaTouched.add(id);
  try { mkdirSync(MEDIA_DIR, { recursive: true }); writeFileSync(join(MEDIA_DIR, id + '.json'), JSON.stringify(rec)); } catch (e) { console.warn('גיבוי מדיה מקומי נכשל:', e.message); }
  cacheMedia(id, { mime, buffer });
  db.mediaIndex[id] = { mime, size: buffer.length, createdAt: Date.now() };
  save();
  return { id, url: '/api/media/' + id };
}

/** קובץ מדיה לפי מזהה: { mime, buffer } או null. */
export async function getMedia(id) {
  if (!/^[a-f0-9]{16}$/.test(String(id))) return null;
  const hit = mediaCache.get(id);
  if (hit) { cacheMedia(id, hit); return hit; }
  let m = null;
  if (redisEnabled() && redisReadOK) {
    try { const r = await redisGet(MEDIA_PREFIX + id); if (r && r.b64) m = { mime: r.mime, buffer: Buffer.from(r.b64, 'base64') }; }
    catch (e) { console.error('טעינת מדיה מ-Redis נכשלה:', e.message); }
  }
  if (!m) m = readMediaFile(id);
  if (m) cacheMedia(id, m);
  return m;
}

/** מחיקת קבצים שאף שאלה כבר לא משתמשת בהם (רק אחרי יום — כדי לא למחוק קובץ שהועלה ועוד לא נשמר). */
function gcMedia() {
  const used = new Set();
  for (const q of db.quizzes) for (const qq of q.questions || []) {
    const m = /\/api\/media\/([a-f0-9]{16})/.exec((qq.media && qq.media.url) || '');
    if (m) used.add(m[1]);
  }
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, info] of Object.entries(db.mediaIndex || {})) {
    if (used.has(id) || (info.createdAt || 0) > dayAgo) continue;
    delete db.mediaIndex[id];
    const c = mediaCache.get(id); if (c) { mediaCacheBytes -= c.buffer.length; mediaCache.delete(id); }
    try { unlinkSync(join(MEDIA_DIR, id + '.json')); } catch { /* אין גיבוי מקומי */ }
    if (redisEnabled() && redisReadOK) {
      fetch(`${REDIS_URL}/del/${MEDIA_PREFIX + id}`, { method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}` } })
        .catch((e) => console.error('מחיקת מדיה מ-Redis נכשלה:', e.message));
    }
  }
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
  if (isOffline()) offline.touchedQuizIds.add(quiz.id);
  save();
  return quiz;
}

export function updateQuiz(id, { name, questions } = {}) {
  const quiz = getQuiz(id);
  if (!quiz) return null;
  if (typeof name === 'string') quiz.name = name.slice(0, 60);
  if (Array.isArray(questions)) quiz.questions = questions.map(sanitizeQuestion);
  if (isOffline()) offline.touchedQuizIds.add(quiz.id);
  gcMedia();
  save();
  return quiz;
}

export function deleteQuiz(id) {
  if (db.quizzes.length <= 1) return false; // תמיד משאירים מאגר אחד לפחות
  const idx = db.quizzes.findIndex((q) => q.id === id);
  if (idx === -1) return false;
  db.quizzes.splice(idx, 1);
  gcMedia();
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
  if (isOffline()) offline.rosterTouched = true;
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
    // פירוק ניקוד לפי כיתה (שם) — כך שגם משחק סלון אחד מזין את כל הכיתות שהשתתפו בו
    classBreakdown: (rec.classBreakdown && typeof rec.classBreakdown === 'object') ? rec.classBreakdown : null,
    // מספר משתתפים נשמר בנפרד כדי שהיסטוריית המשחקים תציג אותו גם אחרי גיזום ה-data
    playerCount: (rec.data && Array.isArray(rec.data.players)) ? rec.data.players.length : 0,
    data: rec.data || null,
  };
  db.gameHistory.push(record);
  if (isOffline()) offline.games.push(record);
  // גיזום נפח (מונע ניפוח blob ה-Redis שגרם להאטות/תקלות בשמירה):
  // ה-data הכבד (exportData מלא, לייצוא חוזר) נשמר רק ל-20 המשחקים האחרונים; משחק ישן יותר
  // מאבד רק את ה-data. הרשומה הקלה (סיכום + classBreakdown) נשמרת עד תקרה גבוהה, כך
  // ש**הצבירה הכיתתית לא נעלמת** (accumulatedByClass סופר classBreakdown מאז האיפוס).
  const KEEP_DATA = 20;
  const cutoff = db.gameHistory.length - KEEP_DATA;
  for (let i = 0; i < cutoff; i++) { if (db.gameHistory[i] && db.gameHistory[i].data) db.gameHistory[i].data = null; }
  if (db.gameHistory.length > 500) db.gameHistory = db.gameHistory.slice(-500);
  save();
  return record;
}

/** רשימת משחקים קודמים (תקציר, בלי ה-data הכבד), מהחדש לישן. */
export function listGames() {
  return (db.gameHistory || []).slice().reverse().map((g) => ({
    id: g.id, classId: g.classId, className: g.className, quizName: g.quizName,
    playedAt: g.playedAt, classTotal: g.classTotal,
    players: (g.data && Array.isArray(g.data.players)) ? g.data.players.length : (g.playerCount || 0),
    hasData: !!g.data, // האם ניתן עדיין לייצא את המשחק הזה לאקסל
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

/**
 * נקודות נצברות לכל כיתה (לפי **שם הכיתה**) מההיסטוריה מאז האיפוס.
 * מעדיף פירוק לפי כיתה (classBreakdown) — כך שגם משחק סלון בודד מזין את כל הכיתות
 * שהשתתפו בו. תאימות לאחור: רשומות ישנות בלי פירוק נספרות לפי className/classTotal.
 */
export function accumulatedByClass() {
  const since = db.classResetAt || 0;
  const acc = {};
  for (const g of db.gameHistory || []) {
    if (g.playedAt < since) continue;
    if (g.classBreakdown && typeof g.classBreakdown === 'object') {
      for (const [cn, pts] of Object.entries(g.classBreakdown)) acc[cn] = (acc[cn] || 0) + (Number(pts) || 0);
    } else if (g.className) {
      acc[g.className] = (acc[g.className] || 0) + (Number(g.classTotal) || 0);
    }
  }
  return acc;
}
