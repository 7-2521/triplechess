// Material balance, the way lichess and chess.com show it: a running "+3"
// beside whoever is ahead. Kings are not counted; promotions are handled
// naturally because we read the board rather than the captured pieces.

export const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

// Order they are listed in, heaviest first.
const ROLE_ORDER = ['q', 'r', 'b', 'n', 'p'];

/**
 * Count material from the board part of a FEN.
 * @returns {{ white: number, black: number, diff: number, captured: {white: object, black: object} }}
 * `diff` is positive when White is ahead. `captured[color]` counts the pieces
 * that colour is missing relative to a full starting set.
 */
export function materialFromFen(fen) {
  const board = String(fen).split(' ')[0];
  const counts = {
    white: { p: 0, n: 0, b: 0, r: 0, q: 0 },
    black: { p: 0, n: 0, b: 0, r: 0, q: 0 },
  };

  for (const ch of board) {
    if (ch === '/' || (ch >= '1' && ch <= '8')) continue;
    const lower = ch.toLowerCase();
    if (lower === 'k' || !(lower in counts.white)) continue;
    const color = ch === lower ? 'black' : 'white';
    counts[color][lower] += 1;
  }

  const score = (side) =>
    ROLE_ORDER.reduce((total, role) => total + counts[side][role] * PIECE_VALUES[role], 0);

  const white = score('white');
  const black = score('black');

  // What each side has lost, capped at zero so extra queens never read as
  // "negative captures".
  const start = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const missing = (side) => {
    const out = {};
    for (const role of ROLE_ORDER) {
      const gone = start[role] - counts[side][role];
      if (gone > 0) out[role] = gone;
    }
    return out;
  };

  return {
    white,
    black,
    diff: white - black,
    captured: { white: missing('white'), black: missing('black') },
  };
}

/** The badge text for one side: "+3", or empty when not ahead. */
export function advantageFor(color, diff) {
  const lead = color === 'white' ? diff : -diff;
  return lead > 0 ? `+${lead}` : '';
}
