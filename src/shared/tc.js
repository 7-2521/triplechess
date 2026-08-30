// Shared time-control model for Triple Chess.
// Used by both the authoritative server and the browser client.

export const CLOCK_COUNT = 3;

// The defaults from the spec: 15+0, 3+2, 1+0.
export const DEFAULT_CLOCKS = [
  { initial: 900, increment: 0 },
  { initial: 180, increment: 2 },
  { initial: 60, increment: 0 },
];

export const LIMITS = {
  initial: { min: 5, max: 10800 }, // 5 seconds .. 3 hours
  increment: { min: 0, max: 180 },
};

// Which of a player's three clocks runs for their next move.
// A player's 1st move uses clock 0, 2nd uses clock 1, 3rd uses clock 2,
// 4th wraps back to clock 0, and so on.
export function clockIndexForMove(movesPlayed) {
  return movesPlayed % CLOCK_COUNT;
}

function clampInt(value, { min, max }, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Never trust the client with time controls: coerce whatever arrives into
// three well-formed clock specs.
export function sanitizeClocks(input) {
  const list = Array.isArray(input) ? input : [];
  return Array.from({ length: CLOCK_COUNT }, (_, i) => {
    const spec = list[i] ?? {};
    const fallback = DEFAULT_CLOCKS[i];
    return {
      initial: clampInt(spec.initial, LIMITS.initial, fallback.initial),
      increment: clampInt(spec.increment, LIMITS.increment, fallback.increment),
    };
  });
}

// "15+0", "3+2", "0.5+1", "30s+0"
export function formatSpec({ initial, increment }) {
  let base;
  if (initial < 60) base = `${initial}s`;
  else if (initial % 60 === 0) base = String(initial / 60);
  else base = (initial / 60).toFixed(1).replace(/\.0$/, '');
  return `${base}+${increment}`;
}

// mm:ss, or m:ss.t once a clock drops under 20 seconds, matching the
// convention players expect from online blitz.
export function formatMs(ms) {
  const clamped = Math.max(0, ms);
  const totalSeconds = clamped / 1000;
  if (clamped < 20000) {
    const s = Math.floor(totalSeconds);
    const tenths = Math.floor((clamped - s * 1000) / 100);
    return `${s}.${tenths}`;
  }
  const total = Math.ceil(totalSeconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
