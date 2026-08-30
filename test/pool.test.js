import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool, poolKey, colorsCompatible, assignColors } from '../src/server/pool.js';
import { Rooms } from '../src/server/rooms.js';
import { computeElo, expectedScore, kFactor, sanitizeName, Ratings } from '../src/server/ratings.js';
import { materialFromFen, advantageFor } from '../src/shared/material.js';

const CLOCKS = [
  { initial: 900, increment: 0 },
  { initial: 180, increment: 2 },
  { initial: 60, increment: 0 },
];

/** Minimal stand-in for a websocket. */
function fakeSocket(token) {
  const sent = [];
  return { token, sent, sendJson: (m) => sent.push(m) };
}

function newPool() {
  const rooms = new Rooms();
  return { pool: new Pool(rooms), rooms };
}

test('pool key depends on all three time controls', () => {
  assert.equal(poolKey(CLOCKS), '900+0|180+2|60+0');
  const different = [...CLOCKS.slice(0, 2), { initial: 61, increment: 0 }];
  assert.notEqual(poolKey(different), poolKey(CLOCKS));
});

test('colour preferences pair only when they do not clash', () => {
  assert.equal(colorsCompatible('random', 'random'), true);
  assert.equal(colorsCompatible('random', 'white'), true);
  assert.equal(colorsCompatible('white', 'black'), true);
  assert.equal(colorsCompatible('white', 'white'), false);
  assert.equal(colorsCompatible('black', 'black'), false);
});

test('assignColors honours an expressed preference', () => {
  const a = { color: 'white', token: 'a' };
  const b = { color: 'random', token: 'b' };
  assert.equal(assignColors(a, b).white.token, 'a');
  assert.equal(assignColors(b, a).white.token, 'a', 'order does not matter');

  const c = { color: 'black', token: 'c' };
  const d = { color: 'random', token: 'd' };
  assert.equal(assignColors(c, d).black.token, 'c');
});

test('two matching seeks are paired into one game', () => {
  const { pool } = newPool();
  const alice = fakeSocket('alice');
  const bob = fakeSocket('bob');
  pool.join(alice);
  pool.join(bob);

  assert.equal(pool.seek(alice, { clocks: CLOCKS, color: 'random' }), null, 'alice waits');
  assert.equal(pool.seeks.size, 1);

  const game = pool.seek(bob, { clocks: CLOCKS, color: 'random' });
  assert.ok(game, 'bob is paired immediately');
  assert.equal(pool.seeks.size, 0, 'the pool is emptied');

  const seats = [game.seats.white, game.seats.black].sort();
  assert.deepEqual(seats, ['alice', 'bob'], 'both tokens are pre-seated');

  for (const socket of [alice, bob]) {
    const paired = socket.sent.find((m) => m.t === 'paired');
    assert.ok(paired, 'each player is told');
    assert.equal(paired.gameId, game.id);
    assert.equal(paired.token, socket.token);
    assert.equal(game.seats[paired.color], socket.token, 'told the colour it was seated as');
  }
});

test('different time controls do not pair', () => {
  const { pool } = newPool();
  const a = fakeSocket('a');
  const b = fakeSocket('b');
  pool.join(a);
  pool.join(b);

  pool.seek(a, { clocks: CLOCKS, color: 'random' });
  const faster = [{ initial: 60, increment: 0 }, ...CLOCKS.slice(1)];
  assert.equal(pool.seek(b, { clocks: faster, color: 'random' }), null);
  assert.equal(pool.seeks.size, 2, 'both keep waiting');
});

test('two players both demanding white do not pair', () => {
  const { pool } = newPool();
  const a = fakeSocket('a');
  const b = fakeSocket('b');
  pool.join(a);
  pool.join(b);
  pool.seek(a, { clocks: CLOCKS, color: 'white' });
  assert.equal(pool.seek(b, { clocks: CLOCKS, color: 'white' }), null);
  assert.equal(pool.seeks.size, 2);
});

test('a player is never paired with themselves', () => {
  const { pool } = newPool();
  const socket = fakeSocket('solo');
  pool.join(socket);
  assert.equal(pool.seek(socket, { clocks: CLOCKS, color: 'random' }), null);
  assert.equal(pool.seek(socket, { clocks: CLOCKS, color: 'random' }), null);
  assert.equal(pool.seeks.size, 1, 're-seeking replaces the old seek');
});

test('accepting a seek takes on that seek time control', () => {
  const { pool } = newPool();
  const host = fakeSocket('host');
  const taker = fakeSocket('taker');
  pool.join(host);
  pool.join(taker);

  const fast = [
    { initial: 120, increment: 1 },
    { initial: 60, increment: 0 },
    { initial: 30, increment: 0 },
  ];
  pool.seek(host, { clocks: fast, color: 'random' });
  const seekId = [...pool.seeks.keys()][0];

  const { game, error } = pool.accept(taker, seekId);
  assert.equal(error, undefined);
  assert.equal(game.spec[0].initial, 120, 'the host time control is used');
  assert.equal(pool.seeks.size, 0);
});

test('accepting a stale seek reports an error', () => {
  const { pool } = newPool();
  const socket = fakeSocket('a');
  pool.join(socket);
  const { error } = pool.accept(socket, 'does-not-exist');
  assert.match(error, /no longer available/i);
});

test('disconnecting withdraws the seek', () => {
  const { pool } = newPool();
  const socket = fakeSocket('a');
  pool.join(socket);
  pool.seek(socket, { clocks: CLOCKS, color: 'random' });
  assert.equal(pool.seeks.size, 1);
  pool.leave(socket);
  assert.equal(pool.seeks.size, 0);
});

test('the pool listing marks your own seek', () => {
  const { pool } = newPool();
  const a = fakeSocket('a');
  const b = fakeSocket('b');
  pool.join(a);
  pool.join(b);
  pool.seek(a, { clocks: CLOCKS, color: 'white' });

  const update = a.sent.filter((m) => m.t === 'pool').at(-1);
  assert.equal(update.seeks.length, 1);
  assert.equal(update.seeks[0].mine, true);
  assert.equal(update.seeks[0].token, undefined, 'tokens are not leaked to clients');

  const otherView = b.sent.filter((m) => m.t === 'pool').at(-1);
  assert.equal(otherView.seeks[0].mine, false);
});

// --- ratings ---------------------------------------------------------------

test('equal players trade 20 points at the provisional K-factor', () => {
  const a = { rating: 1200, games: 0 };
  const b = { rating: 1200, games: 0 };
  assert.equal(expectedScore(1200, 1200), 0.5);
  assert.equal(kFactor(0), 40);
  const { deltaA, deltaB } = computeElo(a, b, 1);
  assert.equal(deltaA, 20);
  assert.equal(deltaB, -20);
});

test('beating a stronger player is worth more', () => {
  const weak = { rating: 1200, games: 50 };
  const strong = { rating: 1600, games: 50 };
  const upset = computeElo(weak, strong, 1).deltaA;
  const expected = computeElo(strong, weak, 1).deltaA;
  assert.ok(upset > expected, `${upset} should beat ${expected}`);
  assert.equal(kFactor(50), 20);
});

test('a draw between equals moves nothing', () => {
  const a = { rating: 1400, games: 40 };
  const b = { rating: 1400, games: 40 };
  const { deltaA, deltaB } = computeElo(a, b, 0.5);
  assert.equal(deltaA, 0);
  assert.equal(deltaB, 0);
});

test('rating changes are zero-sum for equally provisional players', () => {
  const a = { rating: 1350, games: 5 };
  const b = { rating: 1180, games: 5 };
  const { deltaA, deltaB } = computeElo(a, b, 1);
  assert.equal(deltaA + deltaB, 0);
});

test('names are cleaned but keep their spaces', () => {
  assert.equal(sanitizeName('  Jer emy  '), 'Jer emy');
  assert.equal(sanitizeName(''), null);
  assert.equal(sanitizeName('   '), null);
  assert.equal(sanitizeName('x'.repeat(50)).length, 20);
});

test('a finished game moves both ratings and is only counted once', () => {
  const ratings = new Ratings({ dir: null }); // in-memory: never touches disk
  const game = {
    playerIds: { white: 'w', black: 'b' },
    playerNames: { white: 'Wanda', black: 'Bruno' },
    result: '1-0',
    rated: false,
  };

  const change = ratings.applyResult(game);
  assert.equal(change.white.before, 1200);
  assert.equal(change.white.delta, 20);
  assert.equal(change.black.delta, -20);
  assert.equal(ratings.peek('w').rating, 1220);
  assert.equal(ratings.peek('b').rating, 1180);
  assert.equal(ratings.peek('w').games, 1);

  assert.equal(ratings.applyResult(game), null, 'a rated game is not rated twice');
  assert.equal(ratings.peek('w').rating, 1220);
});

test('a game against yourself is not rated', () => {
  const ratings = new Ratings({ dir: null });
  const change = ratings.applyResult({
    playerIds: { white: 'same', black: 'same' },
    playerNames: { white: null, black: null },
    result: '1-0',
    rated: false,
  });
  assert.equal(change, null);
  assert.equal(ratings.peek('same').games, 0);
});

test('an unidentified player is not rated', () => {
  const ratings = new Ratings({ dir: null });
  assert.equal(
    ratings.applyResult({
      playerIds: { white: 'w', black: null },
      playerNames: { white: null, black: null },
      result: '1-0',
      rated: false,
    }),
    null,
  );
});

test('unknown players read as an unplayed 1200', () => {
  const ratings = new Ratings({ dir: null });
  const me = ratings.peek('nobody');
  assert.equal(me.rating, 1200);
  assert.equal(me.games, 0);
  assert.equal(me.provisional, true);
  assert.equal(ratings.players.size, 0, 'peeking does not create a record');
});

// --- material --------------------------------------------------------------

test('the starting position is level', () => {
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  assert.equal(materialFromFen(start).diff, 0);
  assert.equal(advantageFor('white', 0), '');
});

test('being a bishop up reads +3', () => {
  // White is missing nothing; Black has lost a bishop.
  const fen = 'rn1qkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const material = materialFromFen(fen);
  assert.equal(material.diff, 3);
  assert.equal(advantageFor('white', material.diff), '+3');
  assert.equal(advantageFor('black', material.diff), '', 'only the leader is labelled');
  assert.deepEqual(material.captured.black, { b: 1 });
});

test('material counts a promoted queen', () => {
  // Black has an extra queen and no pawns; white has a full set of pawns.
  const fen = '3qk3/8/8/8/8/8/PPPPPPPP/4K3 w - - 0 1';
  const material = materialFromFen(fen);
  assert.equal(material.white, 8, 'eight pawns');
  assert.equal(material.black, 9, 'one queen');
  assert.equal(advantageFor('black', material.diff), '+1');
});

test('kings are not counted', () => {
  assert.equal(materialFromFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1').diff, 0);
});
