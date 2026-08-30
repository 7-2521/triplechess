import { randomBytes } from 'node:crypto';
import { Game } from './game.js';

const GAME_TTL_MS = 6 * 60 * 60 * 1000; // keep games around for 6 hours
const FINISHED_TTL_MS = 30 * 60 * 1000; // ...but only 30 min after they end
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// Unambiguous alphabet: no 0/O/1/I/l.
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function makeId(length = 8) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

export function makeToken() {
  return randomBytes(24).toString('base64url');
}

export class Rooms {
  constructor(ratings = null) {
    this.ratings = ratings;
    /** @type {Map<string, { game: Game, sockets: Set<any> }>} */
    this.rooms = new Map();
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    if (typeof this.sweeper.unref === 'function') this.sweeper.unref();
  }

  create(clockSpecs) {
    let id = makeId();
    while (this.rooms.has(id)) id = makeId();

    const game = new Game(id, clockSpecs);
    const room = { game, sockets: new Set() };
    // The game ends itself when a clock expires; push that out immediately.
    game.onChange = () => this.broadcast(id);
    // Ratings settle the moment the game ends, whatever ended it.
    game.onFinish = (finished) => this.ratings?.applyResult(finished);
    this.rooms.set(id, room);
    return game;
  }

  get(id) {
    return this.rooms.get(id) ?? null;
  }

  /**
   * Start a fresh game for a rematch, keeping the same time controls but
   * swapping colors, as is customary.
   */
  rematch(previous) {
    const game = this.create(previous.spec);
    // Same two players, opposite colours.
    game.seats.white = previous.seats.black;
    game.seats.black = previous.seats.white;
    for (const field of ['playerIds', 'playerNames', 'playerRatings']) {
      game[field].white = previous[field].black;
      game[field].black = previous[field].white;
    }
    return game;
  }

  broadcast(id) {
    const room = this.rooms.get(id);
    if (!room) return;
    const base = room.game.serialize();
    for (const socket of room.sockets) {
      if (socket.readyState !== socket.OPEN) continue;
      socket.sendJson({ t: 'state', you: socket.color, state: base });
    }
  }

  sweep() {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      const { game } = room;
      const stale =
        now - game.createdAt > GAME_TTL_MS ||
        (game.status === 'finished' && game.endedAt && now - game.endedAt > FINISHED_TTL_MS);
      if (stale && room.sockets.size === 0) {
        game.clearFlagTimer();
        this.rooms.delete(id);
      }
    }
  }
}
