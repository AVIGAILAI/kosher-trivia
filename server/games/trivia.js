import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { registerGame } from '../gameManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUESTIONS_PATH = join(__dirname, '..', '..', 'data', 'questions.json');

const LETTERS = ['1', '2', '3', '4'];

function loadDefaultQuestions() {
  try {
    return JSON.parse(readFileSync(QUESTIONS_PATH, 'utf8'));
  } catch (e) {
    console.warn('לא הצלחתי לטעון questions.json, משתמש בברירת מחדל ריקה:', e.message);
    return [];
  }
}

/**
 * משחק הטריוויה. מממש את ממשק Game שהליבה מצפה לו:
 *   onPlayerJoin, handleInput, start, hostAction,
 *   hostState, playerView, promptFor, destroy
 *
 * שלבים (phase): lobby ← question ← reveal ← leaderboard ← (question... | final)
 */
class TriviaGame {
  constructor(session, config = {}) {
    this.session = session;
    this.questions = (config.questions && config.questions.length)
      ? config.questions
      : loadDefaultQuestions();
    this.quizName = config.quizName || '';

    this.phase = 'lobby';
    this.currentIdx = -1;
    this.timeLeft = 0;
    this.timer = null;
    this.answers = new Map(); // playerId -> { value, timeLeft }
    this.distribution = [0, 0, 0, 0];
    this.scored = false;
  }

  // --- מחזור חיים ---

  start() {
    if (this.phase !== 'lobby') return;
    if (this.questions.length === 0) return;
    this.loadQuestion(0);
  }

  /** החלפת מאגר השאלות — מותר רק בלובי, לפני תחילת המשחק. */
  loadQuestions(questions, quizName = '') {
    if (this.phase !== 'lobby') return false;
    if (!Array.isArray(questions)) return false;
    this.questions = questions;
    if (quizName) this.quizName = quizName;
    this.session.emit('update');
    return true;
  }

  loadQuestion(idx) {
    this.clearTimer();
    this.currentIdx = idx;
    this.answers.clear();
    this.distribution = [0, 0, 0, 0];
    this.scored = false;
    const q = this.questions[idx];
    this.phase = 'question';
    this.timeLeft = q.timeLimit || 20;

    this.session.emit('question', { idx });
    this.session.emit('update');

    this.timer = setInterval(() => {
      this.timeLeft--;
      this.session.emit('update');
      if (this.timeLeft <= 0) this.reveal();
    }, 1000);
  }

  /** חישוב ניקוד לשאלה הנוכחית — נקרא גם ב-reveal וגם במעבר ישיר לשאלה הבאה/סיום (מונע אובדן ניקוד). */
  scoreCurrentQuestion() {
    if (this.scored) return; // כבר נספר — מונע ספירה כפולה
    const q = this.questions[this.currentIdx];
    if (!q) return;
    this.distribution = [0, 0, 0, 0];
    for (const [playerId, ans] of this.answers) {
      const player = this.session.getPlayer(playerId);
      if (!player) continue;
      if (ans.value >= 0 && ans.value < 4) this.distribution[ans.value]++;
      if (ans.value === q.correct) {
        // ניקוד לפי הניקוד שנקבע לשאלה (ברירת מחדל 1000): חצי בסיס + חצי בונוס מהירות
        const maxPts = Number.isFinite(q.points) ? q.points : 1000;
        const tl = q.timeLimit || 20;
        const speedFrac = Math.max(0, Math.min(1, (ans.timeLeft || 0) / tl));
        player.score += Math.round(maxPts * (0.5 + 0.5 * speedFrac));
      }
    }
    this.scored = true;
  }

  reveal() {
    this.clearTimer();
    this.scoreCurrentQuestion();
    const q = this.questions[this.currentIdx];
    this.phase = 'reveal';
    this.session.emit('reveal', { correct: q.correct, distribution: this.distribution });
    this.session.emit('update');
  }

  hostAction(action) {
    if (action === 'start') return this.start();
    if (action === 'leaderboard' && this.phase === 'reveal') {
      this.phase = 'leaderboard';
      this.session.emit('update');
    } else if (action === 'next') {
      // מעבר לשאלה הבאה — אם עדיין בשלב שאלה, קודם נספר את הניקוד כדי שלא יאבד
      if (this.phase === 'question') this.scoreCurrentQuestion();
      if (this.currentIdx >= this.questions.length - 1) {
        this.phase = 'final';
        this.session.emit('gameover', {});
        this.session.emit('update');
      } else {
        this.loadQuestion(this.currentIdx + 1);
      }
    } else if (action === 'skip' && this.phase === 'question') {
      this.reveal();
    } else if (action === 'prev') {
      // חזרה לשאלה הקודמת (בזמן שאלה / חשיפה / טבלה)
      if (this.currentIdx > 0 && (this.phase === 'question' || this.phase === 'reveal' || this.phase === 'leaderboard')) {
        this.loadQuestion(this.currentIdx - 1);
      }
    } else if (action === 'finish') {
      // סיום המשחק והצגת התוצאות שנצברו עד כה
      if (this.phase !== 'lobby' && this.phase !== 'final') {
        if (this.phase === 'question') this.scoreCurrentQuestion();
        this.clearTimer();
        this.phase = 'final';
        this.session.emit('gameover', {});
        this.session.emit('update');
      }
    } else if (action === 'restart' || action === 'stop') {
      // עצירת המשחק וחזרה למסך הראשי (הלובי)
      this.clearTimer();
      this.phase = 'lobby';
      this.currentIdx = -1;
      this.answers.clear();
      for (const p of this.session.playerList()) p.score = 0;
      this.session.emit('update');
    }
  }

  // --- קלט שחקן (מגיע מדפדפן או מטלפון — אותו נתיב) ---

  handleInput(player, input) {
    if (this.phase !== 'question') return;
    if (!input || input.type !== 'answer') return;
    const value = Number(input.value);
    if (!Number.isInteger(value) || value < 0 || value > 3) return;
    if (this.answers.has(player.id)) return; // כבר ענה
    this.answers.set(player.id, { value, timeLeft: this.timeLeft });
    this.session.emit('update');
  }

  // --- מצבים לתצוגה ---

  hostState() {
    const q = this.currentIdx >= 0 ? this.questions[this.currentIdx] : null;
    const base = {
      phase: this.phase,
      quizName: this.quizName,
      questionNumber: this.currentIdx + 1,
      totalQuestions: this.questions.length,
      answersCount: this.answers.size,
      totalPlayers: this.session.players.size,
      answeredIds: [...this.answers.keys()], // מי ענה על השאלה הנוכחית
      timeLeft: this.timeLeft,
      timeLimit: q ? q.timeLimit || 20 : 20,
    };

    if (q && (this.phase === 'question' || this.phase === 'reveal')) {
      base.question = { category: q.category, text: q.text, options: q.options };
      if (q.media) base.question.media = q.media;
    }
    if (this.phase === 'reveal') {
      base.correct = q.correct;
      base.distribution = this.distribution;
    }
    if (this.phase === 'leaderboard' || this.phase === 'final') {
      base.leaderboard = this.leaderboard();
      base.isLast = this.currentIdx >= this.questions.length - 1;
    }
    return base;
  }

  playerView(player) {
    const q = this.currentIdx >= 0 ? this.questions[this.currentIdx] : null;
    const ans = this.answers.get(player.id);
    const view = { phase: this.phase, score: player.score };

    if (this.phase === 'question') {
      view.numOptions = q ? q.options.length : 4;
      view.hasAnswered = !!ans;
      view.myAnswer = ans ? ans.value : null;
      view.timeLeft = this.timeLeft;
      if (q) {
        view.category = q.category;
        view.questionText = q.text;
        view.options = q.options;
        view.questionNumber = this.currentIdx + 1;
        view.totalQuestions = this.questions.length;
      }
    } else if (this.phase === 'reveal') {
      view.correct = q.correct;
      view.correctText = q ? q.options[q.correct] : '';
      view.options = q ? q.options : [];
      view.myAnswer = ans ? ans.value : null;
      view.wasCorrect = ans ? ans.value === q.correct : false;
      view.didAnswer = !!ans;
    } else if (this.phase === 'final' || this.phase === 'leaderboard') {
      const board = this.leaderboard();
      view.rank = board.findIndex((p) => p.id === player.id) + 1;
    }
    return view;
  }

  // --- טקסט קולי למתקשר בטלפון (משמש את השער הטלפוני בשלב 2) ---

  promptFor(player) {
    const q = this.currentIdx >= 0 ? this.questions[this.currentIdx] : null;
    const ans = this.answers.get(player.id);

    if (this.phase === 'lobby') {
      return 'התחברת בהצלחה למשחק. המתן בבקשה, המנחה יתחיל את המשחק בקרוב.';
    }
    if (this.phase === 'question' && q) {
      if (ans) return 'תשובתך נקלטה. המתן לתוצאות.';
      let text = `שאלה ${this.currentIdx + 1}. ${q.text}. `;
      q.options.forEach((opt, i) => {
        text += `לתשובה ${opt}, הקש ${LETTERS[i]}. `;
      });
      return text;
    }
    if (this.phase === 'reveal' && q) {
      let text = `התשובה הנכונה היא: ${q.options[q.correct]}. `;
      if (ans) text += ans.value === q.correct ? 'כל הכבוד, ענית נכון! ' : 'הפעם טעית. ';
      text += `הניקוד שלך: ${player.score} נקודות.`;
      return text;
    }
    if (this.phase === 'leaderboard') {
      return `הניקוד שלך: ${player.score} נקודות. ממתינים לשאלה הבאה.`;
    }
    if (this.phase === 'final') {
      const board = this.leaderboard();
      const rank = board.findIndex((p) => p.id === player.id) + 1;
      return `המשחק הסתיים! סיימת במקום ${rank} עם ${player.score} נקודות. תודה שהשתתפת.`;
    }
    return 'המתן בבקשה.';
  }

  leaderboard() {
    return this.session
      .playerList()
      .map((p) => ({ id: p.id, name: p.name, score: p.score, kind: p.kind }))
      .sort((a, b) => b.score - a.score);
  }

  clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  destroy() {
    this.clearTimer();
  }
}

registerGame('trivia', (session, config) => new TriviaGame(session, config));

export default TriviaGame;
