import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

/**
 * ליבת משחק גנרית — לא יודעת כלום על טריוויה ספציפית.
 *
 * מושגים:
 *  - Session: חדר משחק יחיד עם קוד PIN. עוטף אובייקט "משחק" שמממש את ממשק Game.
 *  - Player : שחקן בחדר. יכול להיות מסוג 'web' (דפדפן) או 'phone' (שיחה/סימולציה).
 *
 * עיקרון מפתח: כל קלט נכנס דרך session.handleInput(playerId, input) — לא משנה
 * אם הגיע משלט דפדפן או מהקשה בטלפון. המשחק לא יודע ולא אכפת לו מאיפה בא הקלט.
 *
 * ה-Session הוא EventEmitter. המשחק פולט אירועים ('update', 'question', 'reveal',
 * 'gameover'), וכל מי שמאזין (שכבת ה-Socket.IO, השער הטלפוני) מתרגם אותם לעולם שלו.
 */

let gameFactories = {};

/** רישום סוג משחק חדש. מאפשר "לחבר כל משחק" לאותה תשתית. */
export function registerGame(type, factory) {
  gameFactories[type] = factory;
}

export class Session extends EventEmitter {
  constructor(pin, gameType, config = {}) {
    super();
    this.pin = pin;
    this.gameType = gameType;
    this.players = new Map(); // playerId -> Player
    this.createdAt = Date.now();
    this.hostId = null;

    const factory = gameFactories[gameType];
    if (!factory) throw new Error(`משחק לא מוכר: ${gameType}`);
    // המשחק מקבל הפניה ל-Session כהקשר ("החדר" שלו).
    this.game = factory(this, config);
  }

  addPlayer({ name, kind = 'web', id = null, meta = {} }) {
    const playerId = id || `p-${randomUUID().slice(0, 8)}`;
    const player = {
      id: playerId,
      name: (name || 'שחקן').toString().slice(0, 20),
      kind, // 'web' | 'phone'
      score: 0,
      joinedAt: Date.now(),
      meta,
    };
    this.players.set(playerId, player);
    if (typeof this.game.onPlayerJoin === 'function') this.game.onPlayerJoin(player);
    this.emit('update');
    return player;
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    this.players.delete(playerId);
    if (typeof this.game.onPlayerLeave === 'function') this.game.onPlayerLeave(player);
    this.emit('update');
  }

  getPlayer(playerId) {
    return this.players.get(playerId) || null;
  }

  playerList() {
    return [...this.players.values()];
  }

  /** נקודת כניסה אחידה לכל קלט שחקן (דפדפן או טלפון). */
  handleInput(playerId, input) {
    const player = this.players.get(playerId);
    if (!player) return;
    if (typeof this.game.handleInput === 'function') this.game.handleInput(player, input);
  }

  /** התחלת המשחק (המנחה לוחץ "התחל"). */
  start() {
    if (typeof this.game.start === 'function') this.game.start();
  }

  /** בקרות מנחה כלליות (הבא / דלג / סיים) — מועברות למשחק אם הוא תומך. */
  hostAction(action, payload = {}) {
    if (typeof this.game.hostAction === 'function') this.game.hostAction(action, payload);
  }

  /** מצב מלא עבור מסך המנחה (המקרן). */
  hostState() {
    return {
      pin: this.pin,
      gameType: this.gameType,
      players: this.playerList().map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        score: p.score,
      })),
      game: typeof this.game.hostState === 'function' ? this.game.hostState() : {},
    };
  }

  /** מצב עבור שלט של שחקן ספציפי (מה להציג לו כרגע). */
  playerView(playerId) {
    const player = this.players.get(playerId);
    if (!player) return null;
    return {
      pin: this.pin,
      player: { id: player.id, name: player.name, score: player.score },
      view: typeof this.game.playerView === 'function' ? this.game.playerView(player) : {},
    };
  }

  /** טקסט שה-IVR צריך להשמיע לשחקן טלפון כרגע (משמש את השער הטלפוני בשלב 2). */
  promptFor(playerId) {
    const player = this.players.get(playerId);
    if (!player) return '';
    return typeof this.game.promptFor === 'function' ? this.game.promptFor(player) : '';
  }

  destroy() {
    if (typeof this.game.destroy === 'function') this.game.destroy();
    this.removeAllListeners();
  }
}

export class GameManager {
  constructor() {
    this.sessions = new Map(); // pin -> Session
  }

  generatePin() {
    let pin;
    do {
      pin = Math.floor(1000 + Math.random() * 9000).toString();
    } while (this.sessions.has(pin));
    return pin;
  }

  createSession(gameType = 'trivia', config = {}) {
    const pin = this.generatePin();
    const session = new Session(pin, gameType, config);
    this.sessions.set(pin, session);
    return session;
  }

  getSession(pin) {
    return this.sessions.get(String(pin).trim()) || null;
  }

  removeSession(pin) {
    const session = this.sessions.get(pin);
    if (session) {
      session.destroy();
      this.sessions.delete(pin);
    }
  }
}

export const gameManager = new GameManager();
