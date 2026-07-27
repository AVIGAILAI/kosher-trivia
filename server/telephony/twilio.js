import express from 'express';

/**
 * מודול Twilio Voice — מסלול טלפוניה אמיתי (שלב 5).
 *
 * בניגוד לספק המדומה שה"דוחף" הקראות דרך socket, Twilio עובד ב"משיכה":
 * הוא קורא ל-webhooks שלנו ומצפה לקבל TwiML (XML של הוראות שיחה). לכן זהו
 * מודול webhooks נפרד — אבל הוא עושה שימוש חוזר *מלא* בלוגיקת המשחק:
 * addPlayer / promptFor / handleInput / playerView. המשחק עצמו לא משתנה כלל.
 *
 * זרימת השיחה (מכונת מצבים דרך redirects):
 *   /voice/incoming → ברכה + קליטת קוד (4 ספרות)
 *   /voice/pin      → אימות קוד, צירוף המתקשר כשחקן, מעבר ללולאה
 *   /voice/loop     → לפי שלב המשחק: ממתין / מקריא שאלה ואוסף הקשה / מסיים
 *   /voice/answer   → קליטת תשובה, חזרה ללולאה
 *   /voice/status   → ניתוק → הסרת השחקן
 */

const VOICE = process.env.TWILIO_VOICE || 'Polly.Tomer';
const LANG = process.env.TWILIO_LANG || 'he-IL';

function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function say(text) {
  return `<Say voice="${VOICE}" language="${LANG}">${xmlEscape(text)}</Say>`;
}

function twiml(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

function last4(num) {
  return String(num || '').replace(/\D/g, '').slice(-4) || '0000';
}

export function createTwilioRouter(gameManager) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

  const calls = new Map(); // CallSid -> { pin, playerId, lastKey }

  const send = (res, inner) => res.type('text/xml').send(twiml(inner));

  // ברכה + קליטת קוד המשחק
  const incoming = (req, res) => {
    send(
      res,
      `<Gather numDigits="4" timeout="10" action="/voice/pin" method="POST">` +
        say('ברוכים הבאים למשחק הטריוויה. הקישו את קוד המשחק בן ארבע הספרות.') +
        `</Gather>` +
        say('לא התקבל קוד.') +
        `<Redirect method="POST">/voice/incoming</Redirect>`
    );
  };
  router.post('/incoming', incoming);
  router.get('/incoming', incoming);

  // אימות הקוד וצירוף המתקשר כשחקן
  router.post('/pin', (req, res) => {
    const pin = String(req.body.Digits || '').trim();
    const session = gameManager.getSession(pin);
    if (!session) {
      return send(res, say('קוד שגוי. נסו שוב.') + `<Redirect method="POST">/voice/incoming</Redirect>`);
    }
    const name = 'פלאפון ' + last4(req.body.From);
    const player = session.addPlayer({ name, kind: 'phone', meta: { callSid: req.body.CallSid } });
    calls.set(req.body.CallSid, { pin, playerId: player.id, lastKey: '' });
    send(res, say('התחברת בהצלחה.') + `<Redirect method="POST">/voice/loop</Redirect>`);
  });

  // הלולאה הראשית — מגיבה לשלב המשחק הנוכחי
  router.post('/loop', (req, res) => {
    const call = calls.get(req.body.CallSid);
    if (!call) return send(res, `<Redirect method="POST">/voice/incoming</Redirect>`);
    const session = gameManager.getSession(call.pin);
    if (!session) return send(res, say('המשחק הסתיים. תודה שהשתתפתם.') + '<Hangup/>');

    const pv = session.playerView(call.playerId);
    const view = (pv && pv.view) || {};
    const phase = view.phase || 'lobby';
    const answered = !!view.hasAnswered;

    // מקריאים רק כשמשהו השתנה (מונע חזרה על אותו טקסט כל 2 שניות)
    const key = `${phase}|${view.numOptions || ''}|${answered}|${session.hostState().game.questionNumber}`;
    const changed = key !== call.lastKey;
    call.lastKey = key;
    const speech = changed ? say(session.promptFor(call.playerId)) : '';

    if (phase === 'question' && !answered) {
      return send(
        res,
        `<Gather numDigits="1" timeout="15" action="/voice/answer" method="POST">${speech}</Gather>` +
          `<Redirect method="POST">/voice/loop</Redirect>`
      );
    }
    if (phase === 'final') {
      return send(res, speech + '<Hangup/>');
    }
    // lobby / reveal / leaderboard / question-answered → ממתינים ובודקים שוב
    return send(res, speech + `<Pause length="2"/><Redirect method="POST">/voice/loop</Redirect>`);
  });

  // קליטת תשובה
  router.post('/answer', (req, res) => {
    const call = calls.get(req.body.CallSid);
    if (!call) return send(res, `<Redirect method="POST">/voice/incoming</Redirect>`);
    const session = gameManager.getSession(call.pin);
    if (session) {
      const digit = String(req.body.Digits || '');
      if (/^[1-4]$/.test(digit)) {
        session.handleInput(call.playerId, { type: 'answer', value: Number(digit) - 1 });
      }
    }
    send(res, say('תשובתך נקלטה.') + `<Redirect method="POST">/voice/loop</Redirect>`);
  });

  // ניתוק שיחה → הסרת השחקן
  router.post('/status', (req, res) => {
    const call = calls.get(req.body.CallSid);
    if (call) {
      const session = gameManager.getSession(call.pin);
      if (session && call.playerId) session.removePlayer(call.playerId);
      calls.delete(req.body.CallSid);
    }
    res.sendStatus(204);
  });

  return router;
}
