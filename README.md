# Triple Chess

Standard chess, played remotely between two people — except each player has **three
clocks instead of one**, and the clock rotates every move.

Your 1st move runs on clock 1, your 2nd on clock 2, your 3rd on clock 3, your 4th
back on clock 1, and so on. Each bank keeps its own remaining time and its own
increment for the whole game. With the default `15+0 / 3+2 / 1+0`, every third move
is effectively a bullet move while the rest of the game stays slow.

The clock you are currently on is highlighted in the sidebar, and it glows green
while it is actually ticking. Your own three clocks always sit above the move list,
whichever colour you are playing.

Because every third move is played on a bullet clock, **premoves** work the way they
do on lichess: on your opponent's turn, drag or click a move and it fires the instant
their move lands. A premove their move made illegal is simply dropped. Right-click or
click elsewhere to cancel one.

The whole game is sized to fit the window, so the board, both sets of clocks and the
buttons stay on screen without scrolling — the move list takes up whatever height is
left over.

## Finding a game

Two ways to start, like lichess:

- **Find an opponent** puts you in a pool. You are paired with anyone waiting on
  the *same three time controls* whose colour preference does not clash with
  yours. Everyone waiting is listed, and clicking someone else's seek accepts it
  on their time controls.
- **Create a private game** gives you a link to send to a specific person.

## Accounts and ratings

Everyone starts at **1200**. Finished games are rated with standard Elo — K=40
until you have played 30 games, then K=20 — and the change is shown on the
result card. A `?` next to a rating means it is still provisional.

You can play as a **guest** or **create an account** (username + password) from
the lobby. The difference is where your rating lives:

- **Guest** — identity is a random id in `localStorage`. The rating is tied to
  that browser profile, so clearing site data or switching device starts you
  over at 1200.
- **Account** — the rating follows you to any browser or device you sign in on.

Games where both seats resolve to the same player are deliberately not rated.

### How the auth works

- Passwords are hashed with **scrypt** and a per-user random salt; the plaintext
  is never stored or logged. Login compares in constant time and gives the same
  message for a wrong password as for an unknown user, so usernames cannot be
  probed. Repeated failures are rate limited per username and IP.
- Sessions are HMAC-signed tokens in an **httpOnly, SameSite=Lax** cookie
  (`Secure` when served over HTTPS), valid 30 days. Being httpOnly, page
  JavaScript cannot read them. They are stateless, so they survive a restart.
- The server takes a player's identity from that cookie and **ignores the id the
  client sends** when signed in. Guest ids must carry a `g:` prefix and account
  ids use `u:`, so an anonymous client cannot claim an account or its rating.
- The signing key comes from `SESSION_SECRET` if set, otherwise one is generated
  and kept in the data file. Set it explicitly if you ever run more than one
  instance, or everyone will be logged out when a request hits the other one.

**There is no email or password reset.** A forgotten password cannot be
recovered, and an account cannot be deleted from the UI — both would need more
than the app currently stores.

### Where the data lives — read this before deploying

Accounts, ratings and the session key are all kept in `data/ratings.json`
(override the directory with `DATA_DIR`).

**Railway's filesystem is ephemeral, so that file is wiped on every redeploy
unless you attach a volume.** Without one, every account and rating disappears
the next time you deploy and everyone is signed out. To keep them:

1. Add a **Volume** to the service and mount it at `/data`.
2. Set `DATA_DIR=/data` in the service variables.

Everything works without a volume — the table just resets on each deploy.

## Reviewing a game

Step back through any game, during play or after it. Use the arrows in the
sidebar, click a move in the list, or use the keyboard: `←`/`→` a move at a
time, `Home`/`End` to jump to the start or the live position.

Because each move records which clock paid for it and what was left, the review
rewinds **all six clocks** to what they read at that point, and shows how long
the move took. Material advantage rewinds with it too. There is no engine
analysis — this is a replay, not an evaluation.

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

Run the tests with `npm test` (82 tests: clock rotation, increments, flag falls,
game endings, seating/reconnection, the WebSocket protocol end to end, pool
pairing, Elo maths, material counting, review reconstruction, password hashing,
session tokens, and the guard that stops a client claiming an account).

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

No environment variables are required to boot (see the volume note above if you
want accounts to survive a redeploy). `PORT` is injected by Railway and the server
binds `0.0.0.0`. `/healthz` is wired up as the healthcheck. WebSockets work over the
generated domain without extra configuration — the client picks `wss://`
automatically on HTTPS.

Set `NODE_VERSION` to `22` in Railway's variables if you want to pin the runtime;
otherwise `engines.node` (`>=20`) applies.

## How it works

```
src/
  shared/
    tc.js             clock model shared by server and client
    material.js       material balance, used live and in review
  server/
    game.js           chess rules + the three-clock state machine
    rooms.js          game registry, broadcast, rematch, expiry sweep
    pool.js           matchmaking: seeks, pairing, colour assignment
    ratings.js        Elo + the player store, persisted to DATA_DIR
    accounts.js       scrypt passwords, signed session cookies
    index.js          express + ws (/ws for a game, /lobby for the pool)
  client/
    board.js          chessground wiring, legal moves, premoves, promotion
    clocks.js         the three-clock stack, smooth local ticking
    review.js         replays the move list into positions + clock snapshots
    identity.js       guest identity when nobody is signed in
    game.js           game screen
    lobby.js          time-control editor + matchmaking
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
resignation, draw offers, rematch with colors swapped, premoves, board flip, move
list annotated with the clock each move was played on, reconnection after a refresh
or dropped connection, spectators, sound cues including a low-time warning,
matchmaking by time control, guest play or username/password accounts, Elo
ratings from a 1200 start, material advantage (`+3`) beside whoever is ahead,
a dismissible result card, and move-by-move review with the clocks rewound.

Deliberately left out, per the brief: engine analysis (Stockfish), openings, and
takebacks. Also absent: email, password reset, and account deletion.

## Credits and licensing

The board UI and the cburnett piece set come from
[chessground](https://github.com/lichess-org/chessground), lichess's own board
library (**GPL-3.0-or-later**). Move generation and validation use
[chess.js](https://github.com/jhlywa/chess.js) (BSD-2-Clause).

Because chessground is GPL-3.0 and is bundled into the JavaScript served to
browsers, this project as a whole is distributed under the **GPL-3.0-or-later**.
If you publish it, keep the source available to your users. Before publishing, drop
the full GPL-3.0 text into `LICENSE` — see the note in that file.
