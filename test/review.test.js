import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTimeline, formatSpent } from '../src/client/review.js';
import { Game } from '../src/server/game.js';
import { materialFromFen } from '../src/shared/material.js';

const SPEC = [
  { initial: 900, increment: 0 },
  { initial: 180, increment: 2 },
  { initial: 60, increment: 0 },
];

/** Play a line on a real Game so the timeline is built from real data. */
function playGame(moves, spec = SPEC) {
  const game = new Game('review', spec);
  game.seat('w', 'white');
  game.seat('b', 'black');
  game.setConnected('white', true);
  game.setConnected('black', true);
  for (const [from, to, spent] of moves) {
    game.turnStartedAt = Date.now() - (spent ?? 10);
    const res = game.move(game.turn, { from, to });
    assert.equal(res.ok, true, `${from}${to} should be legal`);
  }
  game.clearFlagTimer();
  return game;
}

test('the timeline has one frame per ply plus the starting position', () => {
  const game = playGame([
    ['e2', 'e4'],
    ['e7', 'e5'],
    ['g1', 'f3'],
  ]);
  const frames = buildTimeline(game.serialize());

  assert.equal(frames.length, 4, 'start + three moves');
  assert.equal(frames[0].ply, 0);
  assert.equal(frames[0].san, null);
  assert.equal(frames[0].lastMove, null);
  assert.equal(frames[1].san, 'e4');
  assert.deepEqual(frames[1].lastMove, ['e2', 'e4']);
  assert.equal(frames[3].san, 'Nf3');
  assert.equal(frames.at(-1).fen, game.chess.fen(), 'the last frame is the live position');
});

test('each frame records which clock was rotating at that point', () => {
  const game = playGame([
    ['e2', 'e4'],
    ['e7', 'e5'],
    ['g1', 'f3'],
    ['b8', 'c6'],
    ['f1', 'c4'],
    ['g8', 'f6'],
  ]);
  const frames = buildTimeline(game.serialize());

  // After White's first move they are on clock 2; after their third, clock 1 again.
  assert.equal(frames[0].activeIndex.white, 0);
  assert.equal(frames[1].activeIndex.white, 1);
  assert.equal(frames[3].activeIndex.white, 2);
  assert.equal(frames[5].activeIndex.white, 0, 'wrapped back around');
  assert.equal(frames[5].clockIndex, 2, 'that move was paid for by clock 3');
});

test('clock readings are reconstructed for every ply', () => {
  const game = playGame([
    ['e2', 'e4', 3000], // white spends 3s on clock 1
    ['e7', 'e5', 500],
    ['g1', 'f3', 400], // white on clock 2 (3+2), gains the increment
  ]);
  const frames = buildTimeline(game.serialize());

  assert.equal(frames[0].clocks.white[0], 900_000, 'starts full');
  assert.ok(frames[1].clocks.white[0] < 898_000, 'clock 1 charged after move one');
  assert.equal(frames[1].clocks.white[1], 180_000, 'clock 2 still untouched at ply 1');
  assert.ok(frames[3].clocks.white[1] > 180_000, 'clock 2 is above 3:00 after its increment');
  assert.equal(
    frames[3].clocks.white[0],
    frames[1].clocks.white[0],
    'clock 1 holds its value while idle',
  );
});

test('a captured piece shows up as a material swing in the timeline', () => {
  const game = playGame([
    ['e2', 'e4'],
    ['d7', 'd5'],
    ['e4', 'd5'], // white wins a pawn
  ]);
  const frames = buildTimeline(game.serialize());

  assert.equal(materialFromFen(frames[2].fen).diff, 0, 'level before the capture');
  assert.equal(materialFromFen(frames[3].fen).diff, 1, 'a pawn up after it');
  assert.equal(frames[3].san, 'exd5');
});

test('check is flagged on the frame where it happens', () => {
  const game = playGame([
    ['f2', 'f3'],
    ['e7', 'e5'],
    ['g2', 'g4'],
    ['d8', 'h4'], // fool's mate
  ]);
  const frames = buildTimeline(game.serialize());
  assert.equal(frames[3].check, null);
  assert.equal(frames[4].check, 'white', 'white is the one in check');
});

test('an empty game still produces the starting frame', () => {
  const game = new Game('empty', SPEC);
  const frames = buildTimeline(game.serialize());
  assert.equal(frames.length, 1);
  assert.equal(frames[0].turn, 'white');
  assert.equal(frames[0].clocks.black[2], 60_000);
});

test('formatSpent is readable at every scale', () => {
  assert.equal(formatSpent(1500), '1.5s');
  assert.equal(formatSpent(9900), '9.9s');
  assert.equal(formatSpent(42_000), '42s');
  assert.equal(formatSpent(65_000), '1:05');
  assert.equal(formatSpent(-1), '');
});
