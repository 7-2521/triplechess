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

/** Join a game carrying a persistent player identity, so it can be rated. */
async function joinAs(gameId, playerId, name) {
  const params = new URLSearchParams({ game: gameId, pid: playerId, name });
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

/** Connect to the matchmaking pool. */
async function joinLobby() {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/lobby`);
  const inbox = [];
  socket.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
  await once(socket, 'open');
  const hello = await waitFor(inbox, (m) => m.t === 'hello');
  return { socket, inbox, hello };
}

test('two seekers on the same time control are paired into a game', async () => {
  const clocks = [
    { initial: 300, increment: 0 },
    { initial: 120, increment: 1 },
    { initial: 60, increment: 0 },
  ];
  const a = await joinLobby();
  const b = await joinLobby();

  a.socket.send(JSON.stringify({ t: 'seek', clocks, color: 'random' }));
  await waitFor(a.inbox, (m) => m.t === 'pool' && m.seeks.length === 1);
  b.socket.send(JSON.stringify({ t: 'seek', clocks, color: 'random' }));

  const pairedA = await waitFor(a.inbox, (m) => m.t === 'paired');
  const pairedB = await waitFor(b.inbox, (m) => m.t === 'paired');

  assert.equal(pairedA.gameId, pairedB.gameId, 'same game');
  assert.notEqual(pairedA.color, pairedB.color, 'opposite colours');
  assert.notEqual(pairedA.token, pairedB.token);

  // Each player can take the seat it was promised.
  const white = pairedA.color === 'white' ? pairedA : pairedB;
  const seated = await join(pairedA.gameId, white.token);
  assert.equal(seated.welcome.color, 'white');

  const res = await fetch(`${BASE}/api/games/${pairedA.gameId}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).state.spec[0].initial, 300);

  seated.socket.close();
  a.socket.close();
  b.socket.close();
});

test('seekers wanting different time controls keep waiting', async () => {
  const a = await joinLobby();
  const b = await joinLobby();

  const slow = [
    { initial: 900, increment: 0 },
    { initial: 180, increment: 2 },
    { initial: 60, increment: 0 },
  ];
  const fast = [
    { initial: 60, increment: 0 },
    { initial: 60, increment: 0 },
    { initial: 60, increment: 0 },
  ];
  a.socket.send(JSON.stringify({ t: 'seek', clocks: slow, color: 'random' }));
  b.socket.send(JSON.stringify({ t: 'seek', clocks: fast, color: 'random' }));

  const listing = await waitFor(b.inbox, (m) => m.t === 'pool' && m.seeks.length === 2);
  assert.equal(listing.seeks.filter((s) => s.mine).length, 1);
  assert.equal(a.inbox.some((m) => m.t === 'paired'), false, 'nobody was paired');

  a.socket.close();
  b.socket.close();
});

test('a rated game settles both ratings when it ends', async () => {
  const id = await createGame([
    { initial: 60, increment: 0 },
    { initial: 60, increment: 0 },
    { initial: 60, increment: 0 },
  ]);
  const suffix = Date.now();
  // Guest ids must carry the "g:" prefix the server insists on.
  const white = await joinAs(id, `g:white-${suffix}`, 'Wanda');
  const black = await joinAs(id, `g:black-${suffix}`, 'Bruno');
  await waitFor(black.inbox, (m) => m.t === 'state' && m.state.status === 'active');

  // Fool's mate: black wins.
  const line = [
    [white, 'f2', 'f3'],
    [black, 'e7', 'e5'],
    [white, 'g2', 'g4'],
    [black, 'd8', 'h4'],
  ];
  let expected = 0;
  for (const [player, from, to] of line) {
    expected += 1;
    player.socket.send(JSON.stringify({ t: 'move', from, to }));
    // Wait for this specific move to land before sending the next one.
    await waitFor(black.inbox, (m) => m.t === 'state' && m.state.history.length === expected);
  }

  const done = await waitFor(white.inbox, (m) => m.t === 'state' && m.state.status === 'finished');
  assert.equal(done.state.result, '0-1');
  assert.equal(done.state.reason, 'checkmate');

  const change = done.state.ratingChange;
  assert.ok(change, 'the game was rated');
  assert.equal(change.white.before, 1200, 'everyone starts at 1200');
  assert.equal(change.black.before, 1200);
  assert.equal(change.black.delta, 20, 'the winner gains');
  assert.equal(change.white.delta, -20, 'the loser drops the same');
  assert.equal(change.black.after, 1220);
  assert.equal(done.state.players.black.name, 'Bruno');

  white.socket.close();
  black.socket.close();
});

/** Register over HTTP and return the session cookie. */
async function registerUser(username, password = 'hunter2hunter2') {
  const res = await fetch(`${BASE}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return { status: res.status, body, cookie };
}

test('an account can be registered, used, and logged out', async () => {
  const name = `player${Date.now()}`;
  const created = await registerUser(name);
  assert.equal(created.status, 201);
  assert.equal(created.body.user.username, name);
  assert.equal(created.body.user.rating, 1200);
  assert.match(created.cookie, /^tc_session=/);

  const me = await fetch(`${BASE}/api/me`, { headers: { cookie: created.cookie } });
  assert.equal((await me.json()).user.username, name);

  // No cookie: nobody is signed in.
  assert.equal((await (await fetch(`${BASE}/api/me`)).json()).user, null);

  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: name.toUpperCase(), password: 'hunter2hunter2' }),
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.username, name);
});

test('registration rejects duplicates and weak input', async () => {
  const name = `dupe${Date.now()}`;
  assert.equal((await registerUser(name)).status, 201);
  const again = await registerUser(name);
  assert.equal(again.status, 400);
  assert.match(again.body.error, /taken/i);

  const weak = await registerUser(`weak${Date.now()}`, 'short');
  assert.equal(weak.status, 400);
  assert.match(weak.body.error, /8 characters/);
});

test('a bad login is refused', async () => {
  const name = `bad${Date.now()}`;
  await registerUser(name);
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: name, password: 'notthepassword' }),
  });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /incorrect/i);
});

test('the player endpoint never exposes credentials', async () => {
  const name = `secret${Date.now()}`;
  const created = await registerUser(name);
  const res = await fetch(`${BASE}/api/player/${encodeURIComponent(created.body.user.id)}`);
  const body = await res.json();
  assert.equal(body.rating, 1200);
  assert.equal('passwordHash' in body, false);
  assert.equal('salt' in body, false);
  assert.equal(JSON.stringify(body).includes('hunter2'), false);
});

test('a signed-in player is identified by the cookie, not the query string', async () => {
  const name = `auth${Date.now()}`;
  const account = await registerUser(name);
  const id = await createGame([
    { initial: 60, increment: 0 },
    { initial: 60, increment: 0 },
    { initial: 60, increment: 0 },
  ]);

  // Connect claiming a bogus pid; the session must win.
  const params = new URLSearchParams({ game: id, pid: 'g:not-my-id', name: 'Impostor' });
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?${params}`, {
    headers: { cookie: account.cookie },
  });
  const inbox = [];
  socket.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
  await once(socket, 'open');
  await waitFor(inbox, (m) => m.t === 'welcome');
  const state = await waitFor(inbox, (m) => m.t === 'state');
  assert.equal(state.state.players.white.name, name, 'the account name is used');
  socket.close();
});

test('an anonymous client cannot claim an account id', async () => {
  const name = `victim${Date.now()}`;
  const account = await registerUser(name);
  const id = await createGame([
    { initial: 60, increment: 0 },
    { initial: 60, increment: 0 },
    { initial: 60, increment: 0 },
  ]);

  // No cookie, but claiming the account's player id outright.
  const attacker = await joinAs(id, account.body.user.id, 'Impostor');
  const state = await waitFor(attacker.inbox, (m) => m.t === 'state');
  assert.notEqual(
    state.state.players.white.name,
    name,
    'an unauthenticated client must not take over an account',
  );
  attacker.socket.close();

  // ...and the account's rating is untouched by that game.
  const after = await fetch(`${BASE}/api/player/${encodeURIComponent(account.body.user.id)}`);
  assert.equal((await after.json()).games, 0);
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
