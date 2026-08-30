# Triple Chess

Standard chess, played remotely between two people — except each player has **three
clocks instead of one**, and the clock rotates every move.

Your 1st move runs on clock 1, your 2nd on clock 2, your 3rd on clock 3, your 4th
back on clock 1, and so on. Each bank keeps its own remaining time and its own
increment for the whole game. With the default `15+0 / 3+2 / 1+0`, every third move
is effectively a bullet move while the rest of the game stays slow.

The clock you are currently on is highlighted in the sidebar, and it glows green
while it is actually ticking.

## Running it locally

```bash
npm install
npm run build
npm start          # http://localhost:3000
```

Open the lobby, set your three time controls, create a game, and send the link to
your opponent. The game starts as soon as they open it.

For development with rebuild-on-save:

```bash
npm run dev        # esbuild watch, in one terminal
npm start          # server, in another
```

Run the tests with `npm test` (25 tests: clock rotation, increments, flag falls,
game endings, seating/reconnection, and the WebSocket protocol end to end).

### Playing both sides in one browser

Seats are remembered per browser, so opening the same link in a second tab puts you
back in your own seat. To deliberately take the *other* seat from the same browser
(useful for testing), append `?seat=new`:

```
http://localhost:3000/g/<id>?seat=new
```

## Deploying to Railway

The repo is Railway-ready as a single web service — HTTP and WebSocket share one
port, and there is nothing to provision.

1. Push this directory to a Git repo.
2. In Railway: **New Project → Deploy from GitHub repo**, pick it.
3. Deploy. Nixpacks detects Node, runs `npm install` then `npm run build`
   (via `railway.json`), and starts with `npm start`.
4. **Settings → Networking → Generate Domain** to get a public URL.

No environment variables are required. `PORT` is injected by Railway and the server
binds `0.0.0.0`. `/healthz` is wired up as the healthcheck. WebSockets work over the
generated domain without extra configuration — the client picks `wss://`
automatically on HTTPS.

Set `NODE_VERSION` to `22` in Railway's variables if you want to pin the runtime;
otherwise `engines.node` (`>=20`) applies.

## How it works

```
src/
  shared/tc.js        clock model shared by server and client
  server/
    game.js           chess rules + the three-clock state machine
    rooms.js          game registry, broadcast, rematch, expiry sweep
    index.js          express + ws, HTTP API, static assets
  client/
    board.js          chessground wiring, legal moves, promotion picker
    clocks.js         the three-clock stack, smooth local ticking
    game.js           game screen
    lobby.js          time-control editor
    net.js            WebSocket with reconnect + seat persistence
```

**The server is authoritative.** It owns the position and all six clocks. Clients
render, and every move is validated server-side before it is broadcast. Time is
charged from `turnStartedAt` when a move lands, and a timer is armed against the
running bank so a flag fall is pushed out even when nobody is at the keyboard.

Clients extrapolate the running clock locally between server snapshots so the
display stays smooth, then snap back to the server's numbers on every update. Clock
skew therefore never accumulates.

Games live in memory. A redeploy or restart drops games in progress, which is fine
for casual play but worth knowing. Finished games are swept 30 minutes after they
end, unfinished ones after 6 hours.

### Implemented

Full legal move generation and validation, castling, en passant, promotion (with a
piece picker), check/checkmate, stalemate, insufficient material, threefold
repetition, the fifty-move rule, flag falls, timeout-vs-insufficient-material draws,
resignation, draw offers, rematch with colors swapped, board flip, move list
annotated with the clock each move was played on, reconnection after a refresh or
dropped connection, spectators, and sound cues including a low-time warning.

Deliberately left out, per the brief: engine analysis, accounts, ratings, openings,
and takebacks.

## Credits and licensing

The board UI and the cburnett piece set come from
[chessground](https://github.com/lichess-org/chessground), lichess's own board
library (**GPL-3.0-or-later**). Move generation and validation use
[chess.js](https://github.com/jhlywa/chess.js) (BSD-2-Clause).

Because chessground is GPL-3.0 and is bundled into the JavaScript served to
browsers, this project as a whole is distributed under the **GPL-3.0-or-later**.
If you publish it, keep the source available to your users. Before publishing, drop
the full GPL-3.0 text into `LICENSE` — see the note in that file.
