import { Chess } from 'chess.js';
import { CLOCK_COUNT, clockIndexForMove, sanitizeClocks } from '../shared/tc.js';

const COLORS = ['white', 'black'];
const other = (color) => (color === 'white' ? 'black' : 'white');

/**
 * One game of Triple Chess.
 *
 * The server is authoritative for both the rules and the clocks. Each player
 * owns three independent time banks; the bank that runs is chosen by how many
 * moves that player has already made, so the clocks rotate 0,1,2,0,1,2,...
 * through the game. Each bank keeps whatever time it has left between its
 * turns, and carries its own Fischer increment.
 */
export class Game {
  constructor(id, clockSpecs) {
    this.id = id;
    this.spec = sanitizeClocks(clockSpecs);
    this.chess = new Chess();

    this.remaining = {
      white: this.spec.map((c) => c.initial * 1000),
      black: this.spec.map((c) => c.initial * 1000),
    };
    this.movesPlayed = { white: 0, black: 0 };

    this.status = 'waiting'; // waiting | active | finished
    this.result = null; // '1-0' | '0-1' | '1/2-1/2'
    this.reason = null;

    this.turnStartedAt = null;
    this.flagTimer = null;

    this.seats = { white: null, black: null }; // per-game seat token
    this.connected = { white: false, black: false };
    // Stable, browser-held identity used for ratings (distinct from the seat token).
    this.playerIds = { white: null, black: null };
    this.playerNames = { white: null, black: null };
    this.playerRatings = { white: null, black: null };
    this.rated = false;
    this.ratingChange = null;
    this.onFinish = null;
    this.drawOffer = null; // color that offered
    this.rematchOffer = null;

    this.history = []; // { san, from, to, color, clockIndex, spentMs, leftMs }
    this.createdAt = Date.now();
    this.endedAt = null;

    // Set by the room layer so clock expiry can be broadcast.
    this.onChange = null;
  }

  get turn() {
    return this.chess.turn() === 'w' ? 'white' : 'black';
  }

  activeIndex(color) {
    return clockIndexForMove(this.movesPlayed[color]);
  }

  /** Milliseconds burned on the current turn so far. */
  elapsed() {
    if (this.status !== 'active' || this.turnStartedAt === null) return 0;
    return Date.now() - this.turnStartedAt;
  }

  /** Remaining time on a bank right now, accounting for the running turn. */
  liveRemaining(color, index) {
    const stored = this.remaining[color][index];
    if (this.status === 'active' && color === this.turn && index === this.activeIndex(color)) {
      return Math.max(0, stored - this.elapsed());
    }
    return stored;
  }

  // --- seating -------------------------------------------------------------

  /** Seat a token, preferring an existing seat so refreshes reconnect cleanly. */
  seat(token, preferred) {
    for (const color of COLORS) {
      if (this.seats[color] === token) return color;
    }
    const order =
      preferred === 'white' || preferred === 'black' ? [preferred, other(preferred)] : COLORS;
    for (const color of order) {
      if (this.seats[color] === null) {
        this.seats[color] = token;
        return color;
      }
    }
    return null; // spectator
  }

  setConnected(color, isConnected) {
    if (!color) return;
    this.connected[color] = isConnected;
    this.maybeStart();
  }

  bothSeated() {
    return this.seats.white !== null && this.seats.black !== null;
  }

  /** Clocks begin as soon as both players are seated and present. */
  maybeStart() {
    if (this.status !== 'waiting') return;
    if (!this.bothSeated()) return;
    if (!this.connected.white || !this.connected.black) return;
    this.status = 'active';
    this.turnStartedAt = Date.now();
    this.armFlagTimer();
  }

  // --- clock plumbing ------------------------------------------------------

  armFlagTimer() {
    this.clearFlagTimer();
    if (this.status !== 'active') return;
    const color = this.turn;
    const index = this.activeIndex(color);
    const left = this.liveRemaining(color, index);
    this.flagTimer = setTimeout(() => {
      this.flagTimer = null;
      this.flag(color);
    }, Math.max(0, left) + 20); // small cushion so we never fire early
    if (typeof this.flagTimer.unref === 'function') this.flagTimer.unref();
  }

  clearFlagTimer() {
    if (this.flagTimer) {
      clearTimeout(this.flagTimer);
      this.flagTimer = null;
    }
  }

  /** Commit the time spent on the current turn back into its bank. */
  freezeClock() {
    if (this.status !== 'active' || this.turnStartedAt === null) return;
    const color = this.turn;
    const index = this.activeIndex(color);
    this.remaining[color][index] = Math.max(0, this.remaining[color][index] - this.elapsed());
    this.turnStartedAt = null;
  }

  flag(color) {
    if (this.status !== 'active') return;
    if (color !== this.turn) return;
    const index = this.activeIndex(color);
    this.remaining[color][index] = 0;
    this.turnStartedAt = null;

    // A player cannot lose on time if the opponent has no way to deliver mate.
    if (this.chess.isInsufficientMaterial()) {
      this.end('1/2-1/2', 'timeout-vs-insufficient-material');
    } else {
      this.end(color === 'white' ? '0-1' : '1-0', 'timeout');
    }
    this.onChange?.();
  }

  // --- moves ---------------------------------------------------------------

  /**
   * Play a move for `color`. Returns { ok } or { ok: false, error }.
   * Illegal moves are rejected without touching the clock — the player's own
   * time keeps running, which is punishment enough.
   */
  move(color, { from, to, promotion }) {
    if (this.status === 'finished') return { ok: false, error: 'Game is already over.' };
    if (this.status !== 'active') return { ok: false, error: 'Game has not started yet.' };
    if (color !== this.turn) return { ok: false, error: 'Not your turn.' };

    const index = this.activeIndex(color);
    const spent = this.elapsed();

    // Did they run out while thinking about this move?
    if (this.remaining[color][index] - spent <= 0) {
      this.clearFlagTimer();
      this.flag(color);
      return { ok: true };
    }

    let played;
    try {
      played = this.chess.move({ from, to, promotion: promotion || undefined });
    } catch {
      return { ok: false, error: 'Illegal move.' };
    }
    if (!played) return { ok: false, error: 'Illegal move.' };

    const left = this.remaining[color][index] - spent + this.spec[index].increment * 1000;
    this.remaining[color][index] = left;
    this.movesPlayed[color] += 1;

    this.history.push({
      san: played.san,
      from: played.from,
      to: played.to,
      color,
      clockIndex: index,
      spentMs: spent,
      leftMs: left,
    });

    this.drawOffer = null; // making a move withdraws/declines any offer
    this.turnStartedAt = Date.now();

    if (!this.checkGameOver()) this.armFlagTimer();
    return { ok: true };
  }

  checkGameOver() {
    if (!this.chess.isGameOver()) return false;
    if (this.chess.isCheckmate()) {
      // The side to move is mated, so the other side won.
      this.end(this.turn === 'white' ? '0-1' : '1-0', 'checkmate');
    } else if (this.chess.isStalemate()) {
      this.end('1/2-1/2', 'stalemate');
    } else if (this.chess.isInsufficientMaterial()) {
      this.end('1/2-1/2', 'insufficient-material');
    } else if (this.chess.isThreefoldRepetition()) {
      this.end('1/2-1/2', 'threefold-repetition');
    } else if (this.chess.isDrawByFiftyMoves()) {
      this.end('1/2-1/2', 'fifty-move-rule');
    } else {
      this.end('1/2-1/2', 'draw');
    }
    return true;
  }

  // --- player actions ------------------------------------------------------

  resign(color) {
    if (this.status !== 'active') return { ok: false, error: 'Game is not in progress.' };
    this.freezeClock();
    this.end(color === 'white' ? '0-1' : '1-0', 'resignation');
    return { ok: true };
  }

  offerDraw(color) {
    if (this.status !== 'active') return { ok: false, error: 'Game is not in progress.' };
    if (this.drawOffer === other(color)) return this.acceptDraw(color);
    this.drawOffer = color;
    return { ok: true };
  }

  acceptDraw(color) {
    if (this.status !== 'active') return { ok: false, error: 'Game is not in progress.' };
    if (this.drawOffer !== other(color)) return { ok: false, error: 'No draw offer to accept.' };
    this.freezeClock();
    this.end('1/2-1/2', 'agreement');
    return { ok: true };
  }

  declineDraw(color) {
    if (this.drawOffer === other(color)) this.drawOffer = null;
    return { ok: true };
  }

  /** Returns a fresh Game when both sides have asked for a rematch. */
  offerRematch(color) {
    if (this.status !== 'finished') return { ok: false, error: 'Game is still in progress.' };
    if (this.rematchOffer === other(color)) return { ok: true, agreed: true };
    this.rematchOffer = color;
    return { ok: true };
  }

  end(result, reason) {
    if (this.status === 'finished') return;
    this.clearFlagTimer();
    this.freezeClock();
    this.status = 'finished';
    this.result = result;
    this.reason = reason;
    this.endedAt = Date.now();
    this.turnStartedAt = null;
    this.onFinish?.(this); // settle ratings before anyone is told the result
  }

  // --- serialization -------------------------------------------------------

  serialize() {
    const last = this.history[this.history.length - 1];
    return {
      id: this.id,
      status: this.status,
      result: this.result,
      reason: this.reason,
      fen: this.chess.fen(),
      turn: this.turn,
      lastMove: last ? [last.from, last.to] : null,
      check: this.chess.isCheck() ? this.turn : null,
      spec: this.spec,
      clocks: {
        white: Array.from({ length: CLOCK_COUNT }, (_, i) => this.liveRemaining('white', i)),
        black: Array.from({ length: CLOCK_COUNT }, (_, i) => this.liveRemaining('black', i)),
      },
      activeIndex: {
        white: this.activeIndex('white'),
        black: this.activeIndex('black'),
      },
      // Which side's clock is actually counting down right now.
      running: this.status === 'active' ? this.turn : null,
      movesPlayed: { ...this.movesPlayed },
      seated: { white: this.seats.white !== null, black: this.seats.black !== null },
      connected: { ...this.connected },
      players: {
        white: { name: this.playerNames.white, rating: this.playerRatings.white },
        black: { name: this.playerNames.black, rating: this.playerRatings.black },
      },
      ratingChange: this.ratingChange,
      drawOffer: this.drawOffer,
      rematchOffer: this.rematchOffer,
      history: this.history.map((h) => ({
        san: h.san,
        color: h.color,
        clockIndex: h.clockIndex,
        spentMs: h.spentMs,
        leftMs: h.leftMs,
      })),
    };
  }
}
