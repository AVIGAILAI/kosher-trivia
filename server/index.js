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
  };

  session.on('update', pushState);
  // אירועי מחזור חיים — מועברים גם לשער הטלפוני בשלב 2. כרגע רק לוג.
  session.on('question', (d) => io.to(`host-${pin}`).emit('host:event', { type: 'question', ...d }));
  session.on('reveal', (d) => io.to(`host-${pin}`).emit('host:event', { type: 'reveal', ...d }));
  session.on('gameover', (d) => io.to(`host-${pin}`).emit('host:event', { type: 'gameover', ...d }));
}

io.on('connection', (socket) => {
  // --- צד מנחה ---
  // host:hello — יצירת משחק חדש או חיבור-מחדש למשחק קיים (רענון/נפילת רשת).
  // המנחה שומר hostToken+pin בדפדפן; אם הם תואמים למשחק קיים — חוזרים אליו במקום ליצור חדש.
  const attachHost = (session) => {
    session.hostId = socket.id;
    socket.data.role = 'host';
    socket.data.pin = session.pin;
    socket.join(`host-${session.pin}`);
  };
  socket.on('host:hello', ({ hostToken, pin, gameType = 'trivia', quizId } = {}, ack) => {
    // ניסיון חיבור-מחדש למשחק קיים
    const existing = pin ? gameManager.getSession(pin) : null;
    if (existing && hostToken && existing.hostToken === hostToken) {
      attachHost(existing);
      existing.lastActive = Date.now();
      if (typeof ack === 'function') {
        ack({ ok: true, pin: existing.pin, resumed: true, quizId: existing.quizId, state: existing.hostState() });
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
      ack({ ok: true, pin: session.pin, resumed: false, quizId: quiz ? quiz.id : null, state: session.hostState() });
    }
  });

  // החלפת מאגר השאלות של המשחק (מותר רק בלובי, לפני שהתחיל).
  socket.on('host:setQuiz', ({ quizId } = {}) => {
    const session = gameManager.getSession(socket.data.pin);
    if (!session || session.hostId !== socket.id) return;
    const quiz = quizStore.getQuiz(quizId);
    if (quiz && typeof session.game.loadQuestions === 'function') {
      session.game.loadQuestions(quiz.questions, quiz.name);
      session.quizId = quiz.id;
    }
  });

  socket.on('host:start', () => {
    const session = gameManager.getSession(socket.data.pin);
    if (session && session.hostId === socket.id) session.start();
  });

  socket.on('host:action', ({ action } = {}) => {
    const session = gameManager.getSession(socket.data.pin);
    if (session && session.hostId === socket.id) session.hostAction(action);
  });

  // --- צד שחקן (דפדפן) ---
  // player:join — הצטרפות חדשה או חיבור-מחדש (השחקן שומר playerId בדפדפן ושורד רענון).
  socket.on('player:join', ({ pin, name, playerId } = {}, ack) => {
    const session = gameManager.getSession(pin);
    if (!session) {
      if (typeof ack === 'function') ack({ ok: false, error: 'קוד משחק לא קיים' });
      return;
    }
    let player = playerId ? session.getPlayer(playerId) : null;
    if (player) {
      // חיבור-מחדש: שומרים ניקוד ושם, מסמנים כמחובר
      if (name) player.name = String(name).slice(0, 20);
      player.connected = true;
    } else {
      player = session.addPlayer({ name, kind: 'web' });
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
    if (now - (session.lastActive || session.createdAt) > SESSION_TTL_MS) {
      gameManager.removeSession(pin);
    }
  }
}, 30 * 60 * 1000);

// טעינת מאגרי השאלות מהאחסון הקבוע לפני שמתחילים להאזין.
await quizStore.init();

httpServer.listen(PORT, () => {
  console.log(`\n🎯 שרת הטריוויה רץ על http://localhost:${PORT}`);
  console.log(`   מסך מנחה:   http://localhost:${PORT}/`);
  console.log(`   שלט דפדפן:  http://localhost:${PORT}/controller`);
  console.log(`   סימולטור כשר: http://localhost:${PORT}/kosher-sim  (שלב 2)\n`);
});
