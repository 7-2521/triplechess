import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { sanitizeClocks } from '../shared/tc.js';
import { Rooms, makeToken } from './rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const HEARTBEAT_MS = 25000; // keep proxies (Railway included) from idling us out

const app = express();
const rooms = new Rooms();

app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));
// Bundle filenames are content-hashed, so they can be cached indefinitely.
app.use(
  '/assets',
  express.static(path.join(PUBLIC_DIR, 'assets'), {
    immutable: true,
    maxAge: '1y',
    index: false,
  }),
);
app.use(express.static(PUBLIC_DIR, { maxAge: 0, index: false }));

app.get('/healthz', (_req, res) => res.json({ ok: true, games: rooms.rooms.size }));

app.post('/api/games', (req, res) => {
  const clocks = sanitizeClocks(req.body?.clocks);
  const game = rooms.create(clocks);
  res.status(201).json({ id: game.id, clocks: game.spec });
});

app.get('/api/games/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Game not found.' });
  res.json({ id: room.game.id, state: room.game.serialize() });
});

// Single-page app: the lobby and every game URL serve the same document.
app.get(/^\/(?:g\/[^/]+)?$/, (_req, res) => {
  // The document names the current hashed bundle, so it must never be cached.
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket, req) => {
  socket.sendJson = (payload) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
  };
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });

  const url = new URL(req.url, 'http://localhost');
  const gameId = url.searchParams.get('game');
  const room = gameId ? rooms.get(gameId) : null;

  if (!room) {
    socket.sendJson({ t: 'fatal', error: 'Game not found. It may have expired.' });
    socket.close();
    return;
  }

  const { game } = room;
  // A returning token keeps its seat; a new one takes whatever is free.
  const token = url.searchParams.get('token') || makeToken();
  const preferred = url.searchParams.get('prefer');
  const color = game.seat(token, preferred);

  socket.gameId = gameId;
  socket.token = token;
  socket.color = color; // null for spectators
  room.sockets.add(socket);

  socket.sendJson({ t: 'welcome', token, color, id: game.id });
  if (color) game.setConnected(color, true);
  rooms.broadcast(gameId);

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleMessage(socket, room, msg);
  });

  socket.on('close', () => {
    room.sockets.delete(socket);
    if (color) {
      // Only mark the seat away when no other tab holds it.
      const stillHere = [...room.sockets].some((s) => s.color === color);
      if (!stillHere) game.setConnected(color, false);
    }
    rooms.broadcast(gameId);
  });
});

function handleMessage(socket, room, msg) {
  const { game } = room;
  const color = socket.color;
  const fail = (error) => socket.sendJson({ t: 'error', error });

  if (!color) return fail('You are watching this game, not playing it.');

  let result;
  switch (msg.t) {
    case 'move':
      result = game.move(color, {
        from: String(msg.from ?? ''),
        to: String(msg.to ?? ''),
        promotion: msg.promotion ? String(msg.promotion) : undefined,
      });
      break;
    case 'resign':
      result = game.resign(color);
      break;
    case 'offer-draw':
      result = game.offerDraw(color);
      break;
    case 'accept-draw':
      result = game.acceptDraw(color);
      break;
    case 'decline-draw':
      result = game.declineDraw(color);
      break;
    case 'rematch': {
      result = game.offerRematch(color);
      if (result.ok && result.agreed) {
        const next = rooms.rematch(game);
        for (const s of room.sockets) s.sendJson({ t: 'rematch', id: next.id });
        rooms.broadcast(game.id);
        return;
      }
      break;
    }
    default:
      return;
  }

  if (result && !result.ok) fail(result.error);
  rooms.broadcast(game.id);
}

// Drop sockets that stopped answering, and keep live ones from idling out.
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, HEARTBEAT_MS);
heartbeat.unref?.();

server.listen(PORT, HOST, () => {
  console.log(`Triple Chess listening on http://${HOST}:${PORT}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    clearInterval(heartbeat);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
