import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';

// Derive the port from the pid so back-to-back runs (or a stray dev server)
// never collide on a fixed number.
const PORT = 3500 + (process.pid % 400);
const BASE = `http://127.0.0.1:${PORT}`;
let server;

before(async () => {
  server = spawn(process.execPath, ['src/server/index.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // Wait for the listening banner before hitting the API.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    server.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
});

after(() => server?.kill());

async function createGame(clocks) {
  const res = await fetch(`${BASE}/api/games`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clocks }),
  });
  assert.equal(res.status, 201);
  return (await res.json()).id;
}

/** Open a socket and collect messages, resolving `welcome` first. */
async function join(gameId, token) {
  const params = new URLSearchParams({ game: gameId });
  if (token) params.set('token', token);
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?${params}`);
  const inbox = [];
  socket.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
  await once(socket, 'open');
  const welcome = await waitFor(inbox, (m) => m.t === 'welcome');
  return { socket, inbox, welcome };
}

function waitFor(inbox, predicate, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const poll = () => {
      const hit = inbox.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() > deadline) return reject(new Error('timed out waiting for message'));
      setTimeout(poll, 25);
    };
    poll();
  });
}

test('two clients are seated as white and black', async () => {
  const id = await createGame([
    { initial: 60, increment: 0 },
    { initial: 60, increment: 0 },
    { initial: 60, increment: 0 },
  ]);
  const white = await join(id);
  const black = await join(id);

  assert.equal(white.welcome.color, 'white');
  assert.equal(black.welcome.color, 'black');

  const started = await waitFor(black.inbox, (m) => m.t === 'state' && m.state.status === 'active');
  assert.equal(started.state.running, 'white');

  white.socket.close();
  black.socket.close();
});

test('a third client becomes a spectator and cannot move', async () => {
  const id = await createGame([
    { initial: 60, increment: 0 },
    { initial: 60, increment: 0 },
    { initial: 60, increment: 0 },
  ]);
  const white = await join(id);
  const black = await join(id);
  const watcher = await join(id);

  assert.equal(watcher.welcome.color, null);
  watcher.socket.send(JSON.stringify({ t: 'move', from: 'e2', to: 'e4' }));
  const err = await waitFor(watcher.inbox, (m) => m.t === 'error');
  assert.match(err.error, /watching/i);

  white.socket.close();
  black.socket.close();
  watcher.socket.close();
});

test('reconnecting with the stored token restores the same seat', async () => {
  const id = await createGame([
    { initial: 60, increment: 0 },
    { initial: 60, increment: 0 },
    { initial: 60, increment: 0 },
  ]);
  const white = await join(id);
  const black = await join(id);
  const token = white.welcome.token;

  white.socket.close();
  await once(white.socket, 'close');

  const again = await join(id, token);
  assert.equal(again.welcome.color, 'white', 'same token, same seat');

  again.socket.close();
  black.socket.close();
});

test('the server pushes the result when a clock runs out with no move', async () => {
  // Two-second first bank: white will flag without either side doing anything.
  const id = await createGame([
    { initial: 2, increment: 0 },
    { initial: 60, increment: 0 },
    { initial: 60, increment: 0 },
  ]);
  const white = await join(id);
  const black = await join(id);

  await waitFor(black.inbox, (m) => m.t === 'state' && m.state.status === 'active');

  const finished = await waitFor(
    black.inbox,
    (m) => m.t === 'state' && m.state.status === 'finished',
  );
  assert.equal(finished.state.result, '0-1');
  assert.equal(finished.state.reason, 'timeout');
  assert.equal(finished.state.clocks.white[0], 0);

  white.socket.close();
  black.socket.close();
});

test('moves are relayed to the opponent and rotate the clock', async () => {
  const id = await createGame([
    { initial: 60, increment: 0 },
    { initial: 30, increment: 3 },
    { initial: 15, increment: 0 },
  ]);
  const white = await join(id);
  const black = await join(id);
  await waitFor(black.inbox, (m) => m.t === 'state' && m.state.status === 'active');

  white.socket.send(JSON.stringify({ t: 'move', from: 'e2', to: 'e4' }));
  const afterMove = await waitFor(
    black.inbox,
    (m) => m.t === 'state' && m.state.history.length === 1,
  );

  assert.equal(afterMove.state.history[0].san, 'e4');
  assert.equal(afterMove.state.history[0].clockIndex, 0);
  assert.equal(afterMove.state.turn, 'black');
  assert.equal(afterMove.state.activeIndex.white, 1, 'white advanced to clock 2');
  assert.equal(afterMove.state.running, 'black');

  white.socket.close();
  black.socket.close();
});

test('an illegal move is rejected and the position is unchanged', async () => {
  const id = await createGame([
    { initial: 60, increment: 0 },
    { initial: 60, increment: 0 },
    { initial: 60, increment: 0 },
  ]);
  const white = await join(id);
  const black = await join(id);
  await waitFor(black.inbox, (m) => m.t === 'state' && m.state.status === 'active');

  white.socket.send(JSON.stringify({ t: 'move', from: 'e2', to: 'e5' }));
  const err = await waitFor(white.inbox, (m) => m.t === 'error');
  assert.match(err.error, /illegal/i);

  white.socket.close();
  black.socket.close();
});

test('a rematch swaps colors and keeps both players seated', async () => {
  const id = await createGame([
    { initial: 60, increment: 0 },
    { initial: 60, increment: 0 },
    { initial: 60, increment: 0 },
  ]);
  const white = await join(id);
  const black = await join(id);
  await waitFor(black.inbox, (m) => m.t === 'state' && m.state.status === 'active');

  white.socket.send(JSON.stringify({ t: 'resign' }));
  await waitFor(black.inbox, (m) => m.t === 'state' && m.state.status === 'finished');

  white.socket.send(JSON.stringify({ t: 'rematch' }));
  black.socket.send(JSON.stringify({ t: 'rematch' }));

  const offer = await waitFor(white.inbox, (m) => m.t === 'rematch');
  assert.ok(offer.id && offer.id !== id, 'a new game id is issued');

  white.socket.close();
  black.socket.close();

  // Clients carry their existing tokens to the new game; colors must swap.
  const nowBlack = await join(offer.id, white.welcome.token);
  const nowWhite = await join(offer.id, black.welcome.token);
  assert.equal(nowBlack.welcome.color, 'black', 'white player becomes black');
  assert.equal(nowWhite.welcome.color, 'white', 'black player becomes white');

  const fresh = await waitFor(nowWhite.inbox, (m) => m.t === 'state' && m.state.status === 'active');
  assert.equal(fresh.state.history.length, 0, 'the rematch starts from move one');
  assert.equal(fresh.state.clocks.white[0], 60000, 'clocks are reset');

  nowBlack.socket.close();
  nowWhite.socket.close();
});

test('unknown game ids are refused', async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?game=nope`);
  const inbox = [];
  socket.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
  await once(socket, 'open');
  const fatal = await waitFor(inbox, (m) => m.t === 'fatal');
  assert.match(fatal.error, /not found/i);
  socket.close();
});

test('the lobby and game routes both serve the app shell', async () => {
  for (const path of ['/', '/g/whatever']) {
    const res = await fetch(BASE + path);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<div id="app">/);
    assert.match(body, /\/assets\/app-[A-Z0-9]+\.js/, 'references the hashed bundle');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  }
});
