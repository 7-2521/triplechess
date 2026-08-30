import { Chess } from 'chess.js';

/**
 * Rebuild the whole game from its move list: one frame per ply, each carrying
 * the position and — the part that matters for Triple Chess — what all six
 * clocks read at that moment.
 *
 * The server already sends each move's SAN, which clock paid for it, how long
 * it took and what was left, so nothing extra has to be stored server-side.
 */
export function buildTimeline(state) {
  const chess = new Chess();
  const clocks = {
    white: state.spec.map((c) => c.initial * 1000),
    black: state.spec.map((c) => c.initial * 1000),
  };
  const played = { white: 0, black: 0 };

  const frame = (extra) => ({
    fen: chess.fen(),
    turn: chess.turn() === 'w' ? 'white' : 'black',
    check: chess.isCheck() ? (chess.turn() === 'w' ? 'white' : 'black') : null,
    clocks: { white: [...clocks.white], black: [...clocks.black] },
    activeIndex: { white: played.white % 3, black: played.black % 3 },
    movesPlayed: { ...played },
    ...extra,
  });

  const frames = [frame({ ply: 0, lastMove: null, san: null })];

  for (const move of state.history) {
    let applied;
    try {
      applied = chess.move(move.san);
    } catch {
      break; // desync: stop rather than render a wrong position
    }
    if (!applied) break;
    clocks[move.color][move.clockIndex] = move.leftMs;
    played[move.color] += 1;
    frames.push(
      frame({
        ply: frames.length,
        lastMove: [applied.from, applied.to],
        san: move.san,
        color: move.color,
        clockIndex: move.clockIndex,
        spentMs: move.spentMs,
      }),
    );
  }

  return frames;
}

/** "1:03", "8.4s" — how long a move took, for the review readout. */
export function formatSpent(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
