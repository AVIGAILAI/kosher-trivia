import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const QUIZZES_PATH = join(DATA_DIR, 'quizzes.json');
const LEGACY_PATH = join(DATA_DIR, 'questions.json');

/**
 * ניהול מאגרי שאלות (quizzes) עם שמירה קבועה לקובץ data/quizzes.json.
 * כל מאגר: { id, name, questions: [ { category, text, options[4], correct, timeLimit } ] }.
 * מאפשר למשתמשת לנהל כמה מאגרים ולהחליף ביניהם בכל משחק.
 */

let db = { quizzes: [] };

function newId() {
  return 'q-' + randomUUID().slice(0, 8);
}

/** ניקוי ואימות שאלה בודדת — מבטיח מבנה תקין לפני שמירה. */
function sanitizeQuestion(q) {
  const options = Array.isArray(q.options) ? q.options.slice(0, 4) : [];
  while (options.length < 4) options.push('');
  let correct = Number.isInteger(q.correct) ? q.correct : 0;
  if (correct < 0 || correct > 3) correct = 0;
  let timeLimit = Number(q.timeLimit);
  if (!Number.isFinite(timeLimit) || timeLimit < 5) timeLimit = 20;
  if (timeLimit > 120) timeLimit = 120;
  return {
    category: String(q.category || 'כללי').slice(0, 40),
    text: String(q.text || '').slice(0, 300),
    options: options.map((o) => String(o).slice(0, 120)),
    correct,
    timeLimit: Math.round(timeLimit),
  };
}

function save() {
  writeFileSync(QUIZZES_PATH, JSON.stringify(db, null, 2), 'utf8');
}

function load() {
  if (existsSync(QUIZZES_PATH)) {
    try {
      db = JSON.parse(readFileSync(QUIZZES_PATH, 'utf8'));
      if (!Array.isArray(db.quizzes)) db.quizzes = [];
    } catch (e) {
      console.warn('quizzes.json פגום, מתחיל מחדש:', e.message);
      db = { quizzes: [] };
    }
  }
  // זריעה ראשונית מהקובץ הישן questions.json אם אין עדיין מאגרים.
  if (db.quizzes.length === 0) {
    let seed = [];
    try {
      if (existsSync(LEGACY_PATH)) seed = JSON.parse(readFileSync(LEGACY_PATH, 'utf8'));
    } catch { /* מתעלמים */ }
    db.quizzes.push({
      id: newId(),
      name: 'טריוויה כללית',
      questions: seed.map(sanitizeQuestion),
    });
    save();
  }
}

load();

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
