import { randomBytes } from 'node:crypto';
import { sanitizeClocks } from '../shared/tc.js';

const SEEK_TTL_MS = 30 * 60 * 1000; // abandon a seek after half an hour

/** Two seeks can pair only if all three time controls match exactly. */
export function poolKey(clocks) {
  return clocks.map((c) => `${c.initial}+${c.increment}`).join('|');
}

/**
 * Colour preferences are compatible unless both players demand the same side.
 * "random" fits with anything.
 */
export function colorsCompatible(a, b) {
  if (a === 'random' || b === 'random') return true;
  return a !== b;
}

/** Decide who gets which side, honouring whatever preference was expressed. */
export function assignColors(a, b) {
  if (a.color === 'white' || b.color === 'black') return { white: a, black: b };
  if (a.color === 'black' || b.color === 'white') return { white: b, black: a };
  return Math.random() < 0.5 ? { white: a, black: b } : { white: b, black: a };
}

/**
 * The waiting room. Players post a seek describing the time controls they
 * want; the first compatible pair is pulled out and given a game.
 */
export class Pool {
  constructor(rooms) {
    this.rooms = rooms;
    /** @type {Map<string, object>} seekId -> seek */
    this.seeks = new Map();
    this.sockets = new Set();
  }

  join(socket) {
    this.sockets.add(socket);
  }

  leave(socket) {
    this.sockets.delete(socket);
    this.withdraw(socket);
    this.broadcast();
  }

  /** Remove whatever seek this socket was advertising. */
  withdraw(socket) {
    for (const [id, seek] of this.seeks) {
      if (seek.socket === socket) this.seeks.delete(id);
    }
  }

  /**
   * Post a seek. If a compatible one is already waiting the two are paired
   * immediately and a game is returned; otherwise the seek starts waiting.
   */
  seek(socket, { clocks, color }) {
    this.withdraw(socket); // one seek per player at a time
    const spec = sanitizeClocks(clocks);
    const pref = ['white', 'black', 'random'].includes(color) ? color : 'random';
    const entry = {
      id: randomBytes(9).toString('base64url'),
      socket,
      token: socket.token,
      clocks: spec,
      key: poolKey(spec),
      color: pref,
      createdAt: Date.now(),
    };

    const match = this.findMatch(entry);
    if (match) {
      this.seeks.delete(match.id);
      return this.pair(match, entry);
    }

    this.seeks.set(entry.id, entry);
    this.broadcast();
    return null;
  }

  findMatch(entry) {
    for (const seek of this.seeks.values()) {
      if (seek.token === entry.token) continue; // never pair with yourself
      if (seek.key !== entry.key) continue;
      if (!colorsCompatible(seek.color, entry.color)) continue;
      return seek;
    }
    return null;
  }

  /** Accept somebody else's seek, taking on their time controls. */
  accept(socket, seekId) {
    const seek = this.seeks.get(seekId);
    if (!seek) return { error: 'That game is no longer available.' };
    if (seek.token === socket.token) return { error: 'That is your own seek.' };
    this.seeks.delete(seekId);
    this.withdraw(socket);
    const taker = {
      socket,
      token: socket.token,
      clocks: seek.clocks,
      color: seek.color === 'random' ? 'random' : seek.color === 'white' ? 'black' : 'white',
    };
    return { game: this.pair(seek, taker) };
  }

  /** Build the game and hand each player the seat token it was given. */
  pair(a, b) {
    const game = this.rooms.create(a.clocks);
    const sides = assignColors(a, b);
    game.seats.white = sides.white.token;
    game.seats.black = sides.black.token;

    for (const color of ['white', 'black']) {
      const player = sides[color];
      player.socket.sendJson?.({ t: 'paired', gameId: game.id, token: player.token, color });
    }
    this.broadcast();
    return game;
  }

  /** Public view of who is waiting, tagged so each client can spot its own. */
  list() {
    const now = Date.now();
    return [...this.seeks.values()]
      .filter((s) => now - s.createdAt < SEEK_TTL_MS)
      .map((s) => ({ id: s.id, clocks: s.clocks, color: s.color, token: s.token }));
  }

  broadcast() {
    const seeks = this.list();
    for (const socket of this.sockets) {
      socket.sendJson?.({
        t: 'pool',
        seeks: seeks.map(({ token, ...rest }) => ({ ...rest, mine: token === socket.token })),
      });
    }
  }

  sweep() {
    const now = Date.now();
    let changed = false;
    for (const [id, seek] of this.seeks) {
      if (now - seek.createdAt > SEEK_TTL_MS) {
        this.seeks.delete(id);
        changed = true;
      }
    }
    if (changed) this.broadcast();
  }
}
