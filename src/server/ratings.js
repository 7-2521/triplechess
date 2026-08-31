import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

export const START_RATING = 1200;
const PROVISIONAL_GAMES = 30; // higher K until a player has settled
const K_PROVISIONAL = 40;
const K_ESTABLISHED = 20;
const SAVE_DEBOUNCE_MS = 2000;
const MAX_NAME = 20;

/** Standard Elo expectation for `rating` against `opponent`. */
export function expectedScore(rating, opponent) {
  return 1 / (1 + 10 ** ((opponent - rating) / 400));
}

export function kFactor(gamesPlayed) {
  return gamesPlayed < PROVISIONAL_GAMES ? K_PROVISIONAL : K_ESTABLISHED;
}

/**
 * New ratings for a finished game.
 * @param {number} scoreA 1 = A won, 0.5 = draw, 0 = A lost
 */
export function computeElo(a, b, scoreA) {
  const expectedA = expectedScore(a.rating, b.rating);
  const deltaA = Math.round(kFactor(a.games) * (scoreA - expectedA));
  const deltaB = Math.round(kFactor(b.games) * (1 - scoreA - (1 - expectedA)));
  return { deltaA, deltaB };
}

export function sanitizeName(name) {
  const trimmed = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '') // strip control characters
    .trim()
    .slice(0, MAX_NAME);
  return trimmed || null;
}

/**
 * Ratings for anonymous players, keyed by a browser-held player id.
 *
 * Persisted as a small JSON file. On a platform with an ephemeral filesystem
 * (Railway without a volume) that file does not survive a redeploy — see the
 * README; point DATA_DIR at a mounted volume to keep ratings.
 */
export class Ratings {
  /** Pass `dir: null` for an in-memory store that never touches disk. */
  constructor({ dir = process.env.DATA_DIR || path.join(process.cwd(), 'data') } = {}) {
    this.dir = dir;
    this.persist = dir !== null;
    this.file = this.persist ? path.join(dir, 'ratings.json') : null;
    this.players = new Map();
    this.secret = null; // HMAC key for session tokens, generated on first use
    this.saveTimer = null;
    this.load();
  }

  load() {
    if (!this.persist) return;
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      this.secret = raw.secret ?? null;
      for (const [id, player] of Object.entries(raw.players ?? {})) {
        this.players.set(id, {
          name: player.name ?? null,
          rating: Number(player.rating) || START_RATING,
          games: Number(player.games) || 0,
          wins: Number(player.wins) || 0,
          losses: Number(player.losses) || 0,
          draws: Number(player.draws) || 0,
          // Account fields, absent for guests.
          username: player.username ?? null,
          usernameLower: player.usernameLower ?? null,
          salt: player.salt ?? null,
          passwordHash: player.passwordHash ?? null,
          createdAt: player.createdAt ?? null,
        });
      }
      console.log(`Loaded ratings for ${this.players.size} players`);
    } catch (err) {
      console.error('Could not read ratings file, starting fresh:', err.message);
    }
  }

  save() {
    if (!this.persist) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const payload = { secret: this.secret ?? null, players: Object.fromEntries(this.players) };
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload));
      renameSync(tmp, this.file); // atomic swap so a crash cannot truncate it
    } catch (err) {
      console.error('Could not write ratings file:', err.message);
    }
  }

  scheduleSave() {
    if (!this.persist || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  /** Everyone starts at 1200; unknown ids are created on first sight. */
  get(id, name) {
    if (!id) return null;
    let player = this.players.get(id);
    if (!player) {
      player = { name: null, rating: START_RATING, games: 0, wins: 0, losses: 0, draws: 0 };
      this.players.set(id, player);
    }
    const clean = sanitizeName(name);
    if (clean && clean !== player.name) {
      player.name = clean;
      this.scheduleSave();
    }
    return player;
  }

  /**
   * Apply a finished game's result. Returns the rating change for each side,
   * or null when the game should not count (same player on both sides, a
   * missing identity, or a game that never really started).
   */
  applyResult(game) {
    if (game.rated) return null;
    const white = game.playerIds.white;
    const black = game.playerIds.black;
    if (!white || !black || white === black) return null;
    if (!game.result) return null;

    const a = this.get(white, game.playerNames.white);
    const b = this.get(black, game.playerNames.black);
    const before = { white: a.rating, black: b.rating };

    const scoreWhite = game.result === '1-0' ? 1 : game.result === '0-1' ? 0 : 0.5;
    const { deltaA, deltaB } = computeElo(a, b, scoreWhite);

    a.rating += deltaA;
    b.rating += deltaB;
    a.games += 1;
    b.games += 1;
    if (scoreWhite === 1) {
      a.wins += 1;
      b.losses += 1;
    } else if (scoreWhite === 0) {
      a.losses += 1;
      b.wins += 1;
    } else {
      a.draws += 1;
      b.draws += 1;
    }

    game.rated = true;
    game.ratingChange = {
      white: { before: before.white, after: a.rating, delta: deltaA },
      black: { before: before.black, after: b.rating, delta: deltaB },
    };
    this.scheduleSave();
    return game.ratingChange;
  }

  /**
   * Read a rating without creating a record for someone who never played.
   * Only public fields are returned — credentials must never leave here.
   */
  peek(id) {
    const player = this.players.get(id);
    if (!player) {
      return { rating: START_RATING, games: 0, wins: 0, losses: 0, draws: 0, provisional: true };
    }
    return {
      name: player.username ?? player.name ?? null,
      username: player.username ?? null,
      rating: player.rating,
      games: player.games,
      wins: player.wins,
      losses: player.losses,
      draws: player.draws,
      provisional: player.games < PROVISIONAL_GAMES,
    };
  }

  leaderboard(limit = 10) {
    return [...this.players.values()]
      .filter((p) => p.games > 0)
      .sort((x, y) => y.rating - x.rating)
      .slice(0, limit)
      .map((p) => ({
        name: p.username ?? p.name ?? 'Anonymous',
        registered: Boolean(p.username),
        rating: p.rating,
        games: p.games,
      }));
  }
}
