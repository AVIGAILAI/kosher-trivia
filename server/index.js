import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { gameManager } from './gameManager.js';
import './games/trivia.js'; // רישום סוג המשחק 'trivia'
import { TelephonyGateway } from './telephony/gateway.js';
import { SimulatedProvider } from './telephony/providers/simulated.js';
import { createTwilioRouter } from './telephony/twilio.js';
import { createYemotRouter } from './telephony/yemot.js';
import * as quizStore from './quizStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;
// מספר הטלפון שאליו המשתתפים מחייגים (מוצג במסך המנחה). ניתן לשינוי דרך משתנה סביבה.
const YEMOT_PHONE = process.env.YEMOT_PHONE || '0733512469';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// שער טלפוני עם ספק מדומה (בשלב 5 מחליפים ל-TwilioProvider ללא שינוי נוסף).
const telephonyProvider = new SimulatedProvider(io);
const telephony = new TelephonyGateway(telephonyProvider, gameManager);

// --- הגשת קבצים סטטיים ודפים ---
app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.get('/', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'host.html')));
app.get('/controller', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'controller.html')));
app.get('/kosher-sim', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'kosher-sim.html')));
app.get('/editor', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'editor.html')));
app.get('/rooms', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'rooms.html')));
app.get('/classes', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'classes.html')));
app.get('/principal', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'principal.html')));

// --- מסלול טלפוניה אמיתי (Twilio Voice webhooks) ---
app.use('/voice', createTwilioRouter(gameManager));

// --- מסלול טלפוניה אמיתי (ימות המשיח — לפלאפונים כשרים) ---
app.use(express.urlencoded({ extended: true })); // תמיכה גם ב-POST של ימות
app.use('/yemot', createYemotRouter(gameManager));

// --- REST API לניהול מאגרי שאלות ---
app.get('/api/quizzes', (_req, res) => res.json(quizStore.listQuizzes()));
app.get('/api/quizzes/:id', (req, res) => {
  const quiz = quizStore.getQuiz(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'מאגר לא נמצא' });
  res.json(quiz);
});
app.post('/api/quizzes', (req, res) => res.json(quizStore.createQuiz(req.body?.name)));
app.put('/api/quizzes/:id', (req, res) => {
  const quiz = quizStore.updateQuiz(req.params.id, req.body || {});
  if (!quiz) return res.status(404).json({ error: 'מאגר לא נמצא' });
  res.json(quiz);
});
app.delete('/api/quizzes/:id', (req, res) => {
  const ok = quizStore.deleteQuiz(req.params.id);
  if (!ok) return res.status(400).json({ error: 'לא ניתן למחוק (אולי זה המאגר האחרון)' });
  res.json({ ok: true });
});

// --- רשימת שמות לפי טלפון (roster) — למחייגות בטלפון כשר ---
app.get('/api/roster', (_req, res) => res.json(quizStore.listRoster()));
app.put('/api/roster', (req, res) => res.json(quizStore.setRoster(req.body?.entries)));

// --- כיתות + תחרות בין-כיתתית + היסטוריית משחקים ---
app.get('/api/classes', (_req, res) => res.json(quizStore.listClasses()));
app.put('/api/classes', (req, res) => {
  const list = quizStore.setClasses(req.body?.classes);
  for (const c of list) ensureClassSession(c); // חדרים חיים לכל הכיתות (כולל חדשות)
  broadcastClassBoard();
  res.json(list);
});
app.post('/api/classes/rename', (req, res) => {
  const list = quizStore.renameClass(req.body?.id, req.body?.name);
  const cls = quizStore.getClass(req.body?.id);
  if (cls) { const s = gameManager.getSession(cls.code); if (s) s.className = cls.name; } // עדכון החדר החי
  broadcastClassBoard();
  res.json(list || quizStore.listClasses());
});
app.post('/api/classes/reset', (_req, res) => {
  quizStore.resetClassScores();
  broadcastClassBoard();
  res.json({ ok: true });
});
app.get('/api/classes/standings', (_req, res) => res.json(computeClassStandings()));

app.get('/api/games', (_req, res) => res.json(quizStore.listGames()));
app.get('/api/games/:id', (req, res) => {
  const g = quizStore.getGame(req.params.id);
  if (!g) return res.status(404).json({ error: 'משחק לא נמצא' });
  res.json(g);
});
app.delete('/api/games/:id', (req, res) => res.json({ ok: quizStore.deleteGame(req.params.id) }));

/**
 * חיווט אירועי Session אל שקעי Socket.IO.
 * נקרא פעם אחת כשה-session נוצר, כדי לא לרשום מאזינים כפולים.
 */
function wireSession(session) {
  const pin = session.pin;

  const pushState = () => {
    session.lastActive = Date.now();
    io.to(`host-${pin}`).emit('host:state', session.hostState());
    for (const p of session.playerList()) {
      io.to(`pv-${p.id}`).emit('player:state', session.playerView(p.id));
    }
    if (session.classId) { broadcastClassBoard(); broadcastMaster(); } // עדכון לוח התחרות + פאנל המנהלת חי
  };

  session.on('update', pushState);
  session.on('question', (d) => io.to(`host-${pin}`).emit('host:event', { type: 'question', ...d }));
  session.on('reveal', (d) => io.to(`host-${pin}`).emit('host:event', { type: 'reveal', ...d }));
  session.on('gameover', (d) => {
    io.to(`host-${pin}`).emit('host:event', { type: 'gameover', ...d });
    saveFinishedGame(session); // שמירת המשחק להיסטוריה + צבירה כיתתית (פעם אחת)
  });
}

/** יוצר/מחזיר את החדר הקבוע של כיתה (קוד יציב, לא נמחק בניקוי). */
function ensureClassSession(cls) {
  let session = gameManager.getSession(cls.code);
  if (session) { session.className = cls.name; return session; }
  const quiz = quizStore.firstQuiz();
  session = gameManager.createSession('trivia', {
    pin: cls.code, classId: cls.id, className: cls.name, persistent: true,
    questions: quiz ? quiz.questions : [], quizId: quiz ? quiz.id : null, quizName: quiz ? quiz.name : '',
  });
  wireSession(session);
  return session;
}

/** שומר משחק שהסתיים פעם אחת (guard ב-session._saved שמתאפס במשחק חדש). */
function saveFinishedGame(session) {
  try {
    if (session._saved) return;
    const players = session.playerList();
    const classTotal = players.reduce((s, p) => s + (p.score || 0), 0);
    // פירוק לפי כיתה — כך שגם משחק סלון בודד מזין את כל הכיתות שהשתתפו בו
    const classBreakdown = {};
    for (const p of players) {
      const cn = classNameOfPlayer(session, p);
      if (cn) classBreakdown[cn] = (classBreakdown[cn] || 0) + (p.score || 0);
    }
    const data = typeof session.game.exportData === 'function' ? session.game.exportData() : null;
    quizStore.saveGame({
      classId: session.classId,
      className: session.className,
      quizName: (data && data.quizName) || session.game.quizName || '',
      classTotal, classBreakdown, data,
    });
    session._saved = true;
    broadcastClassBoard();
  } catch (e) {
    console.error('שמירת משחק נכשלה:', e.message);
  }
}

/** כיתת השחקן: תיוג אישי (meta.className, למשל בסלון) → אחרת שם החדר (חדר כיתה). */
function classNameOfPlayer(session, player) {
  if (player.meta && player.meta.className) return player.meta.className;
  if (session.classId && session.classId !== 'salon') return session.className || '';
  return '';
}

/**
 * דירוג הכיתות **לפי שם כיתה** (ללא הסלון עצמו): נצבר מההיסטוריה + חי מהמשחקים הפעילים
 * (לא-final, למניעת ספירה כפולה). מקבץ שחקנים לפי כיתתם — כך שגם משחק **סלון** אחד
 * (כשכולן מחייגות לקוד הסלון ומזוהות מהרשימה) מזין את ההישג הכיתתי של כל כיתה.
 */
function computeClassStandings() {
  const classes = quizStore.listClasses().filter((c) => !c.salon);
  const accumulated = quizStore.accumulatedByClass(); // לפי שם כיתה
  const live = {};
  for (const s of gameManager.sessions.values()) {
    if (s.game && s.game.phase === 'final') continue; // כבר נצבר בהיסטוריה
    for (const p of s.playerList()) {
      const cn = classNameOfPlayer(s, p);
      if (cn) live[cn] = (live[cn] || 0) + (p.score || 0);
    }
  }
  return classes
    .map((c) => {
      const acc = accumulated[c.name] || 0;
      const lv = live[c.name] || 0;
      return { id: c.id, name: c.name, code: c.code, accumulated: acc, live: lv, total: acc + lv };
    })
    .sort((a, b) => b.total - a.total);
}

function broadcastClassBoard() {
  io.to('classboard').emit('classes:state', { standings: computeClassStandings(), at: Date.now() });
}

// --- פאנל מנהלת: שליטה בכל חדרי הכיתות בו-זמנית (לא כולל סלון) ---
function classSessions() {
  const out = [];
  for (const cls of quizStore.listClasses()) {
    if (cls.salon) continue;
    const s = gameManager.getSession(cls.code);
    if (s) out.push({ cls, s });
  }
  return out;
}
function masterState() {
  return classSessions().map(({ cls, s }) => {
    const hs = s.hostState();
    const g = hs.game;
    const classTotal = hs.players.reduce((a, p) => a + (p.score || 0), 0);
    return {
      id: cls.id, name: cls.name, code: cls.code,
      phase: g.phase, questionNumber: g.questionNumber, totalQuestions: g.totalQuestions,
      players: hs.players.length, classTotal, quizName: g.quizName || '',
      // נתוני השאלה הנוכחית — כדי שהמנהלת תראה בעצמה מה מוצג + הזמן שרץ
      question: g.question ? { text: g.question.text, options: g.question.options } : null,
      timeLeft: g.timeLeft, timeLimit: g.timeLimit, answersCount: g.answersCount,
      correct: (g.phase === 'reveal') ? g.correct : null,
    };
  });
}
function broadcastMaster() {
  io.to('master').emit('master:state', { rooms: masterState(), at: Date.now() });
}

/**
 * מחיל מאגר שאלות על משחק בצורה חסינה, כך ש**כל שאלון שנבחר אכן נשמע בטלפון**:
 * - בלובי: רענון לא-הרסני (קולט גם עריכות של אותו מאגר).
 * - אחרי/באמצע משחק ומאגר שונה: איפוס ללובי + טעינה (אחרת החדר "נתקע" על הישן).
 * - אחרי/באמצע משחק ואותו מאגר: לא נוגעים (חיבור-מחדש לא יאפס משחק רץ).
 */
function applyQuizToSession(session, quiz) {
  if (!quiz || !session || !session.game) return;
  const phase = session.game.phase;
  if (phase === 'lobby') {
    if (typeof session.game.loadQuestions === 'function') session.game.loadQuestions(quiz.questions, quiz.name);
    session.quizId = quiz.id;
  } else if (quiz.id !== session.quizId) {
    if (typeof session.game.resetWithQuestions === 'function') session.game.resetWithQuestions(quiz.questions, quiz.name);
    session.quizId = quiz.id;
    session._saved = false;
  }
}

io.on('connection', (socket) => {
  // --- צד מנחה ---
  // host:hello — יצירת משחק חדש או חיבור-מחדש למשחק קיים (רענון/נפילת רשת).
  // המנחה שומר hostToken+pin בדפדפן; אם הם תואמים למשחק קיים — חוזרים אליו במקום ליצור חדש.
  const attachHost = (session) => {
    session.hostId = socket.id;
    socket.data.role = 'host';
    socket.data.pin = session.pin;
    socket.data.hostToken = session.hostToken; // טוקן יציב לאימות פעולות אחרי חיבור-מחדש
    socket.join(`host-${session.pin}`);
  };

  /**
   * מאתר את המשחק שהמנחה הזה מורשה לשלוט בו. מאמת לפי **הטוקן היציב** (ששורד
   * ניתוק/רענון), לא רק לפי socket.id שמשתנה בכל חיבור-מחדש — כדי שלחיצות המנחה
   * (כמו "שאלה הבאה", שמפעילה את חישוב הניקוד) לא ייפלו בשקט אחרי נפילת רשת קצרה.
   */
  const authorizedSession = () => {
    const session = gameManager.getSession(socket.data.pin);
    if (!session) return null;
    const okById = session.hostId === socket.id;
    const okByToken = session.hostToken && socket.data.hostToken && session.hostToken === socket.data.hostToken;
    if (!okById && !okByToken) return null;
    if (!okById) { session.hostId = socket.id; socket.join(`host-${session.pin}`); } // סנכרון מחדש
    return session;
  };
  socket.on('host:hello', ({ hostToken, pin, gameType = 'trivia', quizId, classId } = {}, ack) => {
    // חדר כיתה — מתחברים ל-session הקבוע של הכיתה (לפי הקוד הקבוע), לא יוצרים אקראי
    if (classId) {
      const cls = quizStore.getClass(classId);
      if (cls) {
        const session = ensureClassSession(cls);
        if (hostToken) session.hostToken = hostToken; // המנחה הנוכחי מאמץ שליטה
        attachHost(session);
        session.lastActive = Date.now();
        if (typeof ack === 'function') {
          ack({ ok: true, pin: session.pin, code: session.pin, resumed: true, classId: cls.id, className: cls.name, quizId: session.quizId, phone: YEMOT_PHONE, state: session.hostState() });
        }
        return;
      }
    }
    // ניסיון חיבור-מחדש למשחק קיים
    const existing = pin ? gameManager.getSession(pin) : null;
    if (existing && hostToken && existing.hostToken === hostToken) {
      attachHost(existing);
      existing.lastActive = Date.now();
      if (typeof ack === 'function') {
        ack({ ok: true, pin: existing.pin, resumed: true, quizId: existing.quizId, phone: YEMOT_PHONE, state: existing.hostState() });
      }
      return;
    }
    // אחרת — יצירת משחק חדש
    const quiz = quizStore.getQuiz(quizId) || quizStore.firstQuiz();
    const session = gameManager.createSession(gameType, {
      questions: quiz ? quiz.questions : [],
      quizId: quiz ? quiz.id : null,
      quizName: quiz ? quiz.name : '',
      hostToken: hostToken || null,
    });
    attachHost(session);
    wireSession(session);
    if (typeof ack === 'function') {
      ack({ ok: true, pin: session.pin, resumed: false, quizId: quiz ? quiz.id : null, phone: YEMOT_PHONE, state: session.hostState() });
    }
  });

  // החלפת מאגר השאלות של המשחק (מותר רק בלובי, לפני שהתחיל).
  socket.on('host:setQuiz', ({ quizId } = {}) => {
    const session = authorizedSession();
    if (!session) return;
    const quiz = quizStore.getQuiz(quizId);
    if (quiz) applyQuizToSession(session, quiz);
  });

  socket.on('host:start', () => {
    const session = authorizedSession();
    if (session) session.start();
  });

  socket.on('host:action', ({ action } = {}) => {
    const session = authorizedSession();
    if (!session) return;
    session.hostAction(action);
    // "עצור" / "משחק חדש" → מוציאים את כל המשתתפים (מסך + טלפון) כדי שיבינו שהסתיים
    if (action === 'stop' || action === 'restart') {
      for (const p of session.playerList()) io.to(`pv-${p.id}`).emit('game:ended');
      session.clearPlayers();
      session._saved = false; // מאפשר שמירה מחדש של המשחק הבא
    }
  });

  // ייצוא תשובות המשחק לאקסל — המנחה מבקש בסוף המשחק, מקבל את כל הנתונים בחזרה.
  socket.on('host:export', (_data, ack) => {
    const session = authorizedSession();
    if (!session) {
      if (typeof ack === 'function') ack({ ok: false, error: 'אין הרשאה' });
      return;
    }
    const data = typeof session.game.exportData === 'function' ? session.game.exportData() : null;
    if (typeof ack === 'function') ack({ ok: !!data, data });
  });

  // --- צד שחקן (דפדפן) ---
  // player:join — הצטרפות חדשה או חיבור-מחדש (השחקן שומר playerId בדפדפן ושורד רענון).
  socket.on('player:join', ({ pin, name, playerId } = {}, ack) => {
    const session = gameManager.getSession(pin);
    if (!session) {
      if (typeof ack === 'function') ack({ ok: false, error: 'קוד משחק לא קיים' });
      return;
    }
    // שיוך כיתה: בחדר כיתה — לפי החדר; בסלון/רגיל לשחקן דפדפן אין טלפון לזהות
    const cls = (session.classId && session.classId !== 'salon') ? session.className : '';
    let player = playerId ? session.getPlayer(playerId) : null;
    if (player) {
      // חיבור-מחדש: שומרים ניקוד ושם, מסמנים כמחובר
      if (name) player.name = String(name).slice(0, 20);
      if (cls) { player.meta = player.meta || {}; player.meta.className = cls; }
      player.connected = true;
    } else {
      player = session.addPlayer({ name, kind: 'web', meta: { className: cls } });
    }
    socket.data.role = 'player';
    socket.data.pin = session.pin;
    socket.data.playerId = player.id;
    socket.join(`pv-${player.id}`);
    session.emit('update');
    if (typeof ack === 'function') {
      ack({ ok: true, playerId: player.id, name: player.name, view: session.playerView(player.id) });
    }
  });

  socket.on('player:answer', ({ value } = {}) => {
    const session = gameManager.getSession(socket.data.pin);
    if (session && socket.data.playerId) {
      session.handleInput(socket.data.playerId, { type: 'answer', value });
    }
  });

  // --- לוח תחרות כיתתי (מסך גדול) ---
  socket.on('classboard:hello', (_data, ack) => {
    socket.join('classboard');
    if (typeof ack === 'function') ack({ ok: true, standings: computeClassStandings() });
  });

  // --- פאנל מנהלת: מפעילה/שולטת בכל חדרי הכיתות יחד ---
  socket.on('master:hello', (_data, ack) => {
    socket.join('master');
    if (typeof ack === 'function') ack({ ok: true, rooms: masterState() });
  });
  // בחירת מאגר שאלות לכל הכיתות בבת אחת (בלובי בלבד)
  socket.on('master:setQuiz', ({ quizId } = {}) => {
    const quiz = quizStore.getQuiz(quizId);
    if (!quiz) return;
    for (const { s } of classSessions()) applyQuizToSession(s, quiz);
    broadcastMaster();
  });
  // פעולה על כל הכיתות יחד: start / next / skip / finish / restart
  socket.on('master:action', ({ action } = {}) => {
    for (const { s } of classSessions()) {
      s.hostAction(action);
      if (action === 'stop' || action === 'restart') {
        for (const p of s.playerList()) io.to(`pv-${p.id}`).emit('game:ended');
        s.clearPlayers();
        s._saved = false;
      }
    }
    broadcastMaster();
    broadcastClassBoard();
  });

  // --- צד סימולטור פלאפון כשר (טלפוניה מדומה) ---
  socket.on('sim:dial', ({ phone } = {}) => {
    socket.data.role = 'sim';
    telephonyProvider.startCall(socket, { phone });
  });
  socket.on('sim:digit', ({ digit } = {}) => telephonyProvider.inputDigit(socket, digit));
  socket.on('sim:hangup', () => telephonyProvider.userHangup(socket.id));

  socket.on('disconnect', () => {
    if (socket.data.role === 'sim') {
      telephonyProvider.userHangup(socket.id);
      return;
    }
    const session = gameManager.getSession(socket.data.pin);
    if (!session) return;
    if (socket.data.role === 'player' && socket.data.playerId) {
      // לא מסירים את השחקן — רק מסמנים כמנותק, כדי לשרוד רענון/נפילת רשת.
      session.setConnected(socket.data.playerId, false);
    }
    // מנחה שהתנתק: לא הורסים את המשחק! הוא יחזור אליו דרך host:hello.
    // ניקוי משחקים נטושים מתבצע ע"י sessionCleanup לפי חוסר פעילות ארוך.
  });
});

// ניקוי משחקים נטושים — כל 30 דקות, מסיר משחקים ללא פעילות מעל 3 שעות.
const SESSION_TTL_MS = 3 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [pin, session] of gameManager.sessions) {
    if (session.persistent) continue; // חדרי כיתה קבועים — לא נמחקים (הקוד תמיד חי)
    if (now - (session.lastActive || session.createdAt) > SESSION_TTL_MS) {
      gameManager.removeSession(pin);
    }
  }
}, 30 * 60 * 1000);

// עדכון תקופתי של לוח התחרות ופאנל המנהלת (גיבוי לעדכונים החיים)
setInterval(() => { broadcastClassBoard(); broadcastMaster(); }, 4000);

// טעינת מאגרי השאלות מהאחסון הקבוע לפני שמתחילים להאזין.
await quizStore.init();

// יצירת חדר קבוע (קוד יציב) לכל כיתה — כדי שהתלמידות יוכלו לחייג בכל רגע.
for (const cls of quizStore.listClasses()) ensureClassSession(cls);

httpServer.listen(PORT, () => {
  console.log(`\n🎯 שרת הטריוויה רץ על http://localhost:${PORT}`);
  console.log(`   מסך מנחה:   http://localhost:${PORT}/`);
  console.log(`   שלט דפדפן:  http://localhost:${PORT}/controller`);
  console.log(`   סימולטור כשר: http://localhost:${PORT}/kosher-sim  (שלב 2)\n`);
});
