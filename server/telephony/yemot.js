import { YemotRouter } from 'yemot-router2';
import * as quizStore from '../quizStore.js';
import { KEYPAD_INSTRUCTIONS, decodeHebrewName } from './hebrewKeypad.js';

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
    printLog: true,
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
    // לא מסירים את השחקן — רק מסמנים כמנותק, כדי לשמור את הניקוד לחזרה
    if (session && rec.playerId) session.setConnected(rec.playerId, false);
    callMap.delete(callId);
  }

  router.events.on('new_call', (call) => console.log('[yemot] 📞 שיחה נכנסת', call.callId, 'מ-', call.phone));
  // ניתוק שיחה ע"י המחייג → הסרת השחקן מהמשחק
  router.events.on('call_hangup', (call) => cleanup(call.callId));

  const msg = (text) => [{ type: 'text', data: text, removeInvalidChars: true }];

  /**
   * דיאלוג הקלדת שם במקשים — למחייגת שאינה ברשימת השמות.
   * מציע להקליד או לדלג; מקריא את השם שנקלט לאישור. מחזיר '' אם דילגה/נכשל.
   */
  async function askNameByKeypad(call) {
    try {
      const choice = await call.read(
        msg('לא זוהית ברשימת השמות. להקלדת שמך הקישי 1. להמשך בלי שם הקישי 2'),
        'tap',
        { max_digits: 1, digits_allowed: [1, 2], sec_wait: 8, allow_empty: true, empty_val: '2', block_asterisk_key: true }
      );
      if (String(choice) !== '1') return '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const typed = await call.read(msg(KEYPAD_INSTRUCTIONS), 'tap', {
          max_digits: 40, sec_wait: 8, allow_empty: true, empty_val: '',
        });
        const decoded = decodeHebrewName(String(typed || ''));
        if (!decoded) {
          if (attempt < 2) await call.read(msg('לא נקלט שם. ננסה שוב'), 'tap', { max_digits: 1, sec_wait: 2, allow_empty: true, empty_val: '' });
          continue;
        }
        const confirm = await call.read(
          msg('השם שהקלדת: ' + decoded + '. אם נכון הקישי 1, לתיקון הקישי 2'),
          'tap',
          { max_digits: 1, digits_allowed: [1, 2], sec_wait: 8, allow_empty: true, empty_val: '1', block_asterisk_key: true }
        );
        if (String(confirm) !== '2') return decoded;
      }
    } catch { /* השיחה נותקה באמצע — ממשיכים בשם ברירת מחדל */ }
    return '';
  }

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

    // 2. הצטרפות כשחקן טלפון — אם המספר כבר שיחק (ונפל), חוזרים לאותו שחקן ושומרים ניקוד
    const digits = String(call.phone || '').replace(/\D/g, '');
    const last4 = digits.slice(-4) || '';
    // שם אמיתי מרשימת המורה לפי מספר הטלפון; אם אין — "פלאפון XXXX"
    const rosterName = quizStore.lookupName(call.phone);
    const fallbackName = last4 ? 'פלאפון ' + last4 : 'מתקשר';
    // שיוך כיתה: בחדר כיתה — לפי החדר; בסלון — לפי רשימת הטלפונים (זיהוי אוטומטי)
    const cls = (session.classId && session.classId !== 'salon') ? session.className : quizStore.lookupClass(digits);
    let player = digits
      ? session.playerList().find((p) => p.kind === 'phone' && p.meta && p.meta.phone === digits)
      : null;
    if (player) {
      if (rosterName) player.name = rosterName; // עדכון לשם האמיתי אם נוסף לרשימה בינתיים
      if (cls) { player.meta = player.meta || {}; player.meta.className = cls; }
      session.setConnected(player.id, true); // חזר למשחק — הניקוד נשמר, והמסך מתעדכן
    } else {
      // מחייגת חדשה שאינה ברשימה — מציעים לה להקליד את שמה במקשים
      let name = rosterName || fallbackName;
      if (!rosterName) {
        const typed = await askNameByKeypad(call);
        if (typed) name = typed;
      }
      player = session.addPlayer({ name, kind: 'phone', meta: { callId: call.callId, phone: digits, className: cls } });
    }
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
        const opts = v.options || [];
        const n = opts.length || v.numOptions || 4;
        const allowed = Array.from({ length: n }, (_, i) => i + 1);
        const wait = Math.max(Math.min(v.timeLeft || 20, 55), 6);
        // פיצול לקטעים = הפסקות טבעיות בין השאלה לתשובות → הרבה יותר ברור להאזנה
        const segments = [
          { type: 'text', data: `שאלה מספר ${v.questionNumber || ''}`, removeInvalidChars: true },
          { type: 'text', data: v.questionText || '', removeInvalidChars: true },
          ...opts.map((o, i) => ({ type: 'text', data: `לתשובה ${o}, הקש ${i + 1}`, removeInvalidChars: true })),
        ];
        const digit = await call.read(segments, 'tap', {
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
      // מקריאים את הטקסט המלא רק כשהשלב משתנה, אחרת "רגע" קצר.
      const key = `${phase}|${v.questionNumber || 0}|${v.hasAnswered ? 1 : 0}`;
      const changed = key !== lastKey;
      const text = changed ? s.promptFor(player.id) : 'רגע';
      lastKey = key;
      // זמן ההמתנה קובע כמה מהר הטלפון קולט שאלה חדשה. אחרי חשיפה/טבלה/מענה — שאלה
      // הבאה עשויה להגיע כל רגע, אז ממתינים רק ~2ש' (הטלפון יקבל את השאלה תוך ~2ש').
      // בלובי (לפני תחילת המשחק) אין דחיפות, אז ~4ש' — פחות עומס ופחות חזרות על "רגע".
      const waitSec = phase === 'lobby' ? 4 : 2;
      await call.read(msg(text), 'tap', {
        max_digits: 1,
        sec_wait: waitSec,
        allow_empty: true,
        empty_val: '',
        block_asterisk_key: true,
      });
    }
  });

  return router;
}
