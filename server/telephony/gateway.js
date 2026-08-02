import * as quizStore from '../quizStore.js';
import { KEYPAD_INSTRUCTIONS, decodeHebrewName } from './hebrewKeypad.js';

/**
 * שער טלפוני גנרי (IVR) — בלתי-תלוי בספק.
 *
 * מקבל "ספק" (provider) שמייצג את חיבור הטלפוניה בפועל: היום ספק מדומה
 * (דף פלאפון וירטואלי), בעתיד Twilio. הספק מודיע לשער על אירועי שיחה
 * (התחלה / הקשה / ניתוק), והשער מבקש מהספק לבצע פעולות (say / gather / endCall).
 *
 * השער מדבר מול ה-Session בדיוק כמו שלט דפדפן: הצטרפות דרך addPlayer,
 * ותשובות דרך handleInput. הוא מאזין לאירועי המשחק (question / reveal / gameover)
 * ומקריא למתקשר את הטקסט ש-promptFor מחזיר.
 *
 * מכונת מצבים לכל שיחה:
 *   pin  — נאמרה ברכה, אוספים ספרות קוד המשחק.
 *   game — המתקשר מחובר כשחקן; מגיב לאירועי המשחק ולהקשות תשובה.
 */
export class TelephonyGateway {
  constructor(provider, gameManager) {
    this.provider = provider;
    this.gm = gameManager;
    this.calls = new Map(); // callId -> call

    provider.onCallStart = (callId, meta) => this.handleCallStart(callId, meta);
    provider.onDigit = (callId, digit) => this.handleDigit(callId, digit);
    provider.onCallEnd = (callId) => this.handleCallEnd(callId);
  }

  handleCallStart(callId, meta = {}) {
    this.calls.set(callId, {
      callId,
      state: 'pin',
      pinBuffer: '',
      phone: meta.phone || '',
      session: null,
      playerId: null,
      listeners: null,
    });
    this.provider.say(
      callId,
      'ברוכים הבאים למשחק הטריוויה. הקישו את קוד המשחק בן ארבע הספרות.'
    );
    this.provider.gather(callId, { hint: 'הקישו את קוד המשחק (4 ספרות)' });
  }

  handleDigit(callId, digit) {
    const call = this.calls.get(callId);
    if (!call) return;
    digit = String(digit);
    if (call.state === 'pin') return this.handlePinDigit(call, digit);
    if (call.state === 'nameEntry') return this.handleNameDigit(call, digit);
    if (call.state === 'game') return this.handleGameDigit(call, digit);
  }

  handlePinDigit(call, digit) {
    if (digit === '*') {
      call.pinBuffer = '';
      this.provider.say(call.callId, 'הקוד נמחק. הקישו את קוד המשחק מחדש.');
      return;
    }
    if (digit === '#') return this.tryJoin(call);
    if (/^[0-9]$/.test(digit)) {
      call.pinBuffer += digit;
      if (call.pinBuffer.length >= 4) this.tryJoin(call);
    }
  }

  tryJoin(call) {
    const pin = call.pinBuffer.slice(0, 4);
    call.pinBuffer = '';
    const session = this.gm.getSession(pin);
    if (!session) {
      this.provider.say(call.callId, 'קוד שגוי. נסו שוב, הקישו את קוד המשחק.');
      this.provider.gather(call.callId, { hint: 'הקישו את קוד המשחק (4 ספרות)' });
      return;
    }
    const digits = String(call.phone || '').replace(/\D/g, '');
    const rosterName = quizStore.lookupName(call.phone);
    const name = rosterName || (call.phone ? 'פלאפון ' + digits.slice(-4) : 'מתקשר');
    const player = session.addPlayer({ name, kind: 'phone', meta: { callId: call.callId, phone: digits } });
    call.session = session;
    call.playerId = player.id;
    // מחייגת חדשה שאינה ברשימה — מציעים לה להקליד את שמה במקשים; אחרת ישר למשחק.
    if (!rosterName) {
      call.state = 'nameEntry';
      call.nameBuffer = '';
      this.provider.say(call.callId, 'לא זוהית ברשימת השמות. ' + KEYPAD_INSTRUCTIONS);
      this.provider.gather(call.callId, { hint: 'הקלד/י את שמך ואז סולמית (#)' });
      return;
    }
    call.state = 'game';
    this.subscribe(call);
    // מכריזים על המצב הנוכחי (לובי, או שאלה אם המשחק כבר רץ).
    this.announcePhase(call);
  }

  /** קליטת הקלדת שם במקשים (מחייגת שאינה ברשימה). מסיימים בסולמית. */
  handleNameDigit(call, digit) {
    if (digit === '*') { // מחיקה — מתחילים מחדש
      call.nameBuffer = '';
      this.provider.say(call.callId, 'נמחק. הקלד/י את שמך מחדש.');
      return;
    }
    if (digit === '#') { // סיום
      const decoded = decodeHebrewName(call.nameBuffer || '');
      if (decoded && call.session) {
        const p = call.session.getPlayer(call.playerId);
        if (p) { p.name = decoded; call.session.emit('update'); }
        this.provider.say(call.callId, 'שמך נקלט: ' + decoded);
      }
      call.state = 'game';
      this.subscribe(call);
      this.announcePhase(call);
      return;
    }
    if (/^[0-9]$/.test(digit)) call.nameBuffer += digit;
  }

  subscribe(call) {
    const s = call.session;
    const onQuestion = () => this.announcePhase(call);
    const onReveal = () => this.speakPrompt(call);
    const onGameover = () => {
      this.speakPrompt(call);
      setTimeout(() => {
        this.provider.endCall(call.callId);
        this.handleCallEnd(call.callId);
      }, 8000);
    };
    s.on('question', onQuestion);
    s.on('reveal', onReveal);
    s.on('gameover', onGameover);
    call.listeners = { onQuestion, onReveal, onGameover };
  }

  /** מקריא את הטקסט המתאים לשלב הנוכחי, ומבקש הקשה אם צריך לענות. */
  announcePhase(call) {
    if (!call.session) return;
    this.speakPrompt(call);
    if (call.session.game.phase === 'question') {
      this.provider.gather(call.callId, { hint: 'הקישו 1 עד 4' });
    }
  }

  speakPrompt(call) {
    const text = call.session ? call.session.promptFor(call.playerId) : '';
    if (text) this.provider.say(call.callId, text);
  }

  handleGameDigit(call, digit) {
    const s = call.session;
    if (!s || s.game.phase !== 'question') return;
    if (/^[1-4]$/.test(digit)) {
      const value = Number(digit) - 1;
      s.handleInput(call.playerId, { type: 'answer', value });
      this.provider.say(call.callId, 'תשובתך נקלטה. המתינו לתוצאות.');
    }
  }

  handleCallEnd(callId) {
    const call = this.calls.get(callId);
    if (!call) return;
    if (call.session && call.listeners) {
      call.session.off('question', call.listeners.onQuestion);
      call.session.off('reveal', call.listeners.onReveal);
      call.session.off('gameover', call.listeners.onGameover);
    }
    if (call.session && call.playerId) call.session.removePlayer(call.playerId);
    this.calls.delete(callId);
  }
}
