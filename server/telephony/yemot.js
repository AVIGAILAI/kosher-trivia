import { YemotRouter } from 'yemot-router2';

/**
 * מתאם "ימות המשיח" — מסלול טלפוניה אמיתי לפלאפונים כשרים.
 *
 * משתמש בספריית yemot-router2 שעוטפת את פרוטוקול מודול ה-API של ימות.
 * ימות קורא לכתובת שלנו בזמן שיחה; אנחנו מקריאים טקסט בעברית (TTS) וקולטים
 * הקשות (1-4). שימוש חוזר *מלא* בלוגיקת המשחק: addPlayer / promptFor / handleInput
 * / playerView — בדיוק כמו מתאם Twilio. המשחק עצמו לא משתנה.
 *
 * זרימה (לולאה תלוית-שלב, מסונכרנת עם המנחה):
 *   קוד → הצטרפות → [שאלה: הקראה + קליטת הקשה] / [המתנה: לובי/חשיפה/טבלה] → סיום
 */
export function createYemotRouter(gameManager) {
  const router = YemotRouter({
    timeout: '30m',
    printLog: false,
    uncaughtErrorHandler: (err, call) => {
      console.error('Yemot handler error:', err && err.message);
      try {
        return call.id_list_message([
          { type: 'text', data: 'אירעה שגיאה זמנית. נסו שוב מאוחר יותר', removeInvalidChars: true },
        ]);
      } catch { /* השיחה כבר נותקה */ }
    },
  });

  const callMap = new Map(); // callId -> { pin, playerId }

  function cleanup(callId) {
    const rec = callMap.get(callId);
    if (!rec) return;
    const session = gameManager.getSession(rec.pin);
    if (session && rec.playerId) session.removePlayer(rec.playerId);
    callMap.delete(callId);
  }

  // ניתוק שיחה ע"י המחייג → הסרת השחקן מהמשחק
  router.events.on('call_hangup', (call) => cleanup(call.callId));

  const msg = (text) => [{ type: 'text', data: text, removeInvalidChars: true }];

  router.get('/', async (call) => {
    // 1. קליטת קוד המשחק (עד 3 ניסיונות)
    let session = null;
    for (let attempt = 0; attempt < 3 && !session; attempt++) {
      const greeting = attempt === 0
        ? 'ברוכים הבאים למשחק הטריוויה. הקישו את קוד המשחק בן ארבע הספרות'
        : 'קוד שגוי. נסו שוב, הקישו את קוד המשחק';
      const pin = await call.read(msg(greeting), 'tap', {
        max_digits: 4,
        min_digits: 4,
        sec_wait: 15,
        allow_empty: true,
        empty_val: '',
        block_asterisk_key: true,
      });
      if (pin) session = gameManager.getSession(String(pin).trim());
    }
    if (!session) {
      return call.id_list_message(msg('לא הצלחנו לחבר אתכם למשחק. נסו שוב מאוחר יותר. להתראות'));
    }

    // 2. הצטרפות כשחקן טלפון
    const last4 = String(call.phone || '').replace(/\D/g, '').slice(-4) || '';
    const name = last4 ? 'פלאפון ' + last4 : 'מתקשר';
    const player = session.addPlayer({ name, kind: 'phone', meta: { callId: call.callId } });
    callMap.set(call.callId, { pin: session.pin, playerId: player.id });

    // 3. לולאת המשחק — מסונכרנת עם קצב המנחה
    let lastKey = '';
    while (true) {
      const s = gameManager.getSession(session.pin);
      if (!s) return call.id_list_message(msg('המשחק הסתיים. תודה שהשתתפתם'));
      const pv = s.playerView(player.id);
      if (!pv) return call.hangup();
      const v = pv.view;
      const phase = v.phase;

      if (phase === 'final') {
        return call.id_list_message(msg(s.promptFor(player.id)));
      }

      // שאלה פעילה שעדיין לא ענו עליה → הקראה + קליטת הקשה
      if (phase === 'question' && !v.hasAnswered) {
        const n = v.numOptions || 4;
        const allowed = Array.from({ length: n }, (_, i) => i + 1);
        const wait = Math.max(Math.min(v.timeLeft || 20, 25), 6);
        const digit = await call.read(msg(s.promptFor(player.id)), 'tap', {
          max_digits: 1,
          digits_allowed: allowed,
          sec_wait: wait,
          allow_empty: true,
          empty_val: '',
          block_asterisk_key: true,
          block_zero_key: true,
        });
        if (/^[1-9]$/.test(String(digit))) {
          s.handleInput(player.id, { type: 'answer', value: Number(digit) - 1 });
        }
        continue;
      }

      // מצבי המתנה: לובי / חשיפה / טבלה / שאלה שכבר נענתה.
      // מקריאים את הטקסט המלא רק כשהשלב משתנה, אחרת "רגע" קצר — וממתינים ~7 שניות.
      const key = `${phase}|${v.questionNumber || 0}|${v.hasAnswered ? 1 : 0}`;
      const text = key !== lastKey ? s.promptFor(player.id) : 'רגע, ממתינים';
      lastKey = key;
      await call.read(msg(text), 'tap', {
        max_digits: 1,
        sec_wait: 7,
        allow_empty: true,
        empty_val: '',
        block_asterisk_key: true,
      });
    }
  });

  return router;
}
