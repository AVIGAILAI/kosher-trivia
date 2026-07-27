/**
 * ספק טלפוניה מדומה.
 *
 * מגשר בין השער הטלפוני (gateway) לבין דף "הפלאפון הכשר הווירטואלי" (kosher-sim.html)
 * דרך Socket.IO. "שיחה" = חיבור שקע מהדף. callId = socket.id.
 *
 * הדף שולח:  sim:dial (חיוג) / sim:digit (הקשה) / sim:hangup (ניתוק)
 * הדף מקבל:  sim:say (הקראה) / sim:status (רמז קלט) / sim:ended (השיחה הסתיימה)
 *
 * הממשק כלפי השער זהה למה ש-Twilio יספק בהמשך — החלפת הספק לא נוגעת בשער או במשחק.
 */
export class SimulatedProvider {
  constructor(io) {
    this.io = io;
    // callbacks שהשער מגדיר:
    this.onCallStart = null;
    this.onDigit = null;
    this.onCallEnd = null;
  }

  // --- נקראים מ-index.js לפי אירועי השקע ---

  startCall(socket, meta = {}) {
    if (this.onCallStart) this.onCallStart(socket.id, meta);
  }

  inputDigit(socket, digit) {
    if (this.onDigit) this.onDigit(socket.id, digit);
  }

  userHangup(socketId) {
    if (this.onCallEnd) this.onCallEnd(socketId);
  }

  // --- נקראים מהשער ---

  say(callId, text) {
    this.io.to(callId).emit('sim:say', { text });
  }

  gather(callId, opts = {}) {
    this.io.to(callId).emit('sim:status', { expectingInput: true, hint: opts.hint || '' });
  }

  endCall(callId) {
    this.io.to(callId).emit('sim:ended', {});
  }
}
