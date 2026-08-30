import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from '../src/server/game.js';
import { clockIndexForMove, sanitizeClocks, formatMs, formatSpec } from '../src/shared/tc.js';

const SPEC = [
  { initial: 900, increment: 0 }, // 15+0
  { initial: 180, increment: 2 }, // 3+2
  { initial: 60, increment: 0 }, // 1+0
];

function startedGame(spec = SPEC) {
  const game = new Game('test', spec);
  game.seat('white-token', 'white');
  game.seat('black-token', 'black');
  game.setConnected('white', true);
  game.setConnected('black', true);
  return game;
}

test('clock index rotates 0,1,2 per player', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(clockIndexForMove), [0, 1, 2, 0, 1, 2, 0]);
});

test('game starts only once both seats are connected', () => {
  const game = new Game('x', SPEC);
  game.seat('a', 'white');
  game.setConnected('white', true);
  assert.equal(game.status, 'waiting');
  game.seat('b', 'black');
  game.setConnected('black', true);
  assert.equal(game.status, 'active');
});

test('each player rotates through their own three clocks', () => {
  const game = startedGame();
  const moves = [
    ['e2', 'e4'],
    ['e7', 'e5'],
    ['g1', 'f3'],
    ['b8', 'c6'],
    ['f1', 'c4'],
    ['g8', 'f6'],
    ['d2', 'd3'], // white's 4th move — back to clock 0
  ];

  const used = [];
  for (const [from, to] of moves) {
    const color = game.turn;
    used.push([color, game.activeIndex(color)]);
    const res = game.move(color, { from, to });
    assert.equal(res.ok, true, `${from}${to} should be legal`);
  }

  assert.deepEqual(used, [
    ['white', 0],
    ['black', 0],
    ['white', 1],
    ['black', 1],
    ['white', 2],
    ['black', 2],
    ['white', 0], // wrapped
  ]);
  game.clearFlagTimer();
});

test('time is deducted from the active bank and increment is applied to it', () => {
  const game = startedGame();

  // White thinks for ~200ms on clock 0 (15+0, no increment).
  game.turnStartedAt = Date.now() - 200;
  game.move('white', { from: 'e2', to: 'e4' });

  assert.ok(game.remaining.white[0] < 900_000, 'clock 0 should have been charged');
  assert.ok(game.remaining.white[0] > 899_000, 'and only by roughly 200ms');
  assert.equal(game.remaining.white[1], 180_000, 'clock 1 untouched');
  assert.equal(game.remaining.white[2], 60_000, 'clock 2 untouched');

  // Black moves, then white spends time on clock 1 (3+2) and gains 2s.
  game.turnStartedAt = Date.now();
  game.move('black', { from: 'e7', to: 'e5' });

  game.turnStartedAt = Date.now() - 500;
  game.move('white', { from: 'g1', to: 'f3' });

  assert.ok(
    game.remaining.white[1] > 181_000,
    'clock 1 should be above 3:00 after a 2s increment on a 0.5s move',
  );
  game.clearFlagTimer();
});

test('banks persist across rotations', () => {
  const game = startedGame();
  const spend = (from, to, ms) => {
    game.turnStartedAt = Date.now() - ms;
    const res = game.move(game.turn, { from, to });
    assert.equal(res.ok, true);
  };

  spend('e2', 'e4', 1000); // white clock 0
  const afterFirst = game.remaining.white[0];
  spend('e7', 'e5', 10);
  spend('g1', 'f3', 10); // white clock 1
  spend('b8', 'c6', 10);
  spend('f1', 'c4', 10); // white clock 2
  spend('g8', 'f6', 10);

  assert.equal(game.remaining.white[0], afterFirst, 'clock 0 kept its value while idle');
  spend('d2', 'd3', 1000); // white clock 0 again
  assert.ok(game.remaining.white[0] < afterFirst, 'clock 0 charged again on its next turn');
  game.clearFlagTimer();
});

test('running out of time on any bank loses the game', () => {
  const game = startedGame([
    { initial: 900, increment: 0 },
    { initial: 180, increment: 0 },
    { initial: 5, increment: 0 }, // tiny third bank
  ]);
  const quick = (from, to) => {
    game.turnStartedAt = Date.now();
    game.move(game.turn, { from, to });
  };

  quick('e2', 'e4');
  quick('e7', 'e5');
  quick('g1', 'f3');
  quick('b8', 'c6');

  // White is now on clock 2 with 5 seconds. Burn 6.
  assert.equal(game.activeIndex('white'), 2);
  game.turnStartedAt = Date.now() - 6000;
  game.move('white', { from: 'f1', to: 'c4' });

  assert.equal(game.status, 'finished');
  assert.equal(game.result, '0-1');
  assert.equal(game.reason, 'timeout');
  assert.equal(game.remaining.white[2], 0);
});

test('flag timer is armed against the correct bank', () => {
  const game = startedGame([
    { initial: 900, increment: 0 },
    { initial: 180, increment: 0 },
    { initial: 30, increment: 0 },
  ]);
  assert.equal(game.activeIndex('white'), 0);
  game.move('white', { from: 'e2', to: 'e4' });
  assert.equal(game.activeIndex('black'), 0);
  assert.ok(game.flagTimer, 'a flag timer should be pending');
  game.clearFlagTimer();
});

test('checkmate ends the game with the right result', () => {
  const game = startedGame();
  const line = [
    ['f2', 'f3'],
    ['e7', 'e5'],
    ['g2', 'g4'],
    ['d8', 'h4'], // Fool's mate
  ];
  for (const [from, to] of line) {
    game.turnStartedAt = Date.now();
    game.move(game.turn, { from, to });
  }
  assert.equal(game.status, 'finished');
  assert.equal(game.reason, 'checkmate');
  assert.equal(game.result, '0-1');
});

test('illegal moves are rejected without ending the turn', () => {
  const game = startedGame();
  const res = game.move('white', { from: 'e2', to: 'e5' });
  assert.equal(res.ok, false);
  assert.equal(game.turn, 'white', 'still white to move');
  assert.equal(game.movesPlayed.white, 0);
  game.clearFlagTimer();
});

test('a player cannot move out of turn', () => {
  const game = startedGame();
  const res = game.move('black', { from: 'e7', to: 'e5' });
  assert.equal(res.ok, false);
  assert.match(res.error, /not your turn/i);
  game.clearFlagTimer();
});

test('promotion is honoured', () => {
  const game = startedGame();
  game.chess.load('8/P6k/8/8/8/8/7K/8 w - - 0 1');
  game.turnStartedAt = Date.now();
  const res = game.move('white', { from: 'a7', to: 'a8', promotion: 'q' });
  assert.equal(res.ok, true);
  assert.equal(game.history.at(-1).san, 'a8=Q');
  assert.equal(game.chess.get('a8').type, 'q');
  game.clearFlagTimer();
});

test('resignation and draw agreement freeze the clocks', () => {
  const resigned = startedGame();
  resigned.resign('white');
  assert.equal(resigned.result, '0-1');
  assert.equal(resigned.reason, 'resignation');
  assert.equal(resigned.turnStartedAt, null);

  const drawn = startedGame();
  drawn.offerDraw('white');
  assert.equal(drawn.drawOffer, 'white');
  drawn.acceptDraw('black');
  assert.equal(drawn.result, '1/2-1/2');
  assert.equal(drawn.reason, 'agreement');
});

test('a move withdraws a pending draw offer', () => {
  const game = startedGame();
  game.offerDraw('white');
  game.turnStartedAt = Date.now();
  game.move('white', { from: 'e2', to: 'e4' });
  assert.equal(game.drawOffer, null);
  game.clearFlagTimer();
});

test('timeout against bare king is a draw, not a loss', () => {
  const game = startedGame([
    { initial: 5, increment: 0 },
    { initial: 5, increment: 0 },
    { initial: 5, increment: 0 },
  ]);
  game.chess.load('7k/8/8/8/8/8/8/7K w - - 0 1'); // K vs K
  game.turnStartedAt = Date.now() - 6000;
  game.flag('white');
  assert.equal(game.result, '1/2-1/2');
  assert.equal(game.reason, 'timeout-vs-insufficient-material');
});

test('reconnecting with the same token keeps the seat', () => {
  const game = new Game('r', SPEC);
  assert.equal(game.seat('tok-a'), 'white');
  assert.equal(game.seat('tok-b'), 'black');
  assert.equal(game.seat('tok-a'), 'white', 'same token returns to its seat');
  assert.equal(game.seat('tok-c'), null, 'third player spectates');
});

test('serialize exposes live clocks and the active index for both players', () => {
  const game = startedGame();
  game.turnStartedAt = Date.now();
  game.move('white', { from: 'e2', to: 'e4' });
  const s = game.serialize();

  assert.equal(s.turn, 'black');
  assert.equal(s.running, 'black');
  assert.equal(s.activeIndex.white, 1, 'white is now on clock 2 for their next move');
  assert.equal(s.activeIndex.black, 0);
  assert.equal(s.clocks.white.length, 3);
  assert.deepEqual(s.lastMove, ['e2', 'e4']);
  assert.equal(s.history[0].clockIndex, 0);
  game.clearFlagTimer();
});

test('time-control helpers', () => {
  assert.equal(formatSpec({ initial: 900, increment: 0 }), '15+0');
  assert.equal(formatSpec({ initial: 180, increment: 2 }), '3+2');
  assert.equal(formatSpec({ initial: 30, increment: 0 }), '30s+0');
  assert.equal(formatSpec({ initial: 90, increment: 1 }), '1.5+1');

  assert.equal(formatMs(900_000), '15:00');
  assert.equal(formatMs(65_000), '1:05');
  assert.equal(formatMs(19_400), '19.4');
  assert.equal(formatMs(0), '0.0');
  assert.equal(formatMs(-500), '0.0');
  assert.equal(formatMs(3_600_000), '1:00:00');

  // Garbage in, sane defaults out.
  const cleaned = sanitizeClocks([{ initial: -5, increment: 999 }, null]);
  assert.equal(cleaned.length, 3);
  assert.equal(cleaned[0].initial, 5);
  assert.equal(cleaned[0].increment, 180);
  assert.equal(cleaned[1].initial, 180);
});
