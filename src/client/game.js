import { BoardView } from './board.js';
import { ClockStack } from './clocks.js';
import { Connection } from './net.js';
import { sounds } from './sound.js';
import { formatSpec } from '../shared/tc.js';
import { advantageFor, materialFromFen } from '../shared/material.js';
import { buildTimeline, formatSpent } from './review.js';
import { getIdentity } from './identity.js';

const REASON_TEXT = {
  checkmate: 'Checkmate',
  stalemate: 'Stalemate',
  'insufficient-material': 'Insufficient material',
  'threefold-repetition': 'Threefold repetition',
  'fifty-move-rule': 'Fifty-move rule',
  timeout: 'Time out',
  'timeout-vs-insufficient-material': 'Time out — insufficient material',
  resignation: 'Resignation',
  agreement: 'Draw agreed',
  draw: 'Draw',
};

const other = (c) => (c === 'white' ? 'black' : 'white');
const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function renderGame(root, gameId) {
  root.innerHTML = `
    <div class="game">
      <div class="board-column">
        <div class="board-wrap">
          <div class="board" id="board"></div>
          <!-- cg-wrap lets the promotion pieces reuse chessground's piece art -->
          <div class="promotion-layer cg-wrap" id="promotion"></div>
          <div class="board-overlay" id="overlay" hidden></div>
        </div>
      </div>

      <aside class="sidebar">
        <div class="side-head">
          <a class="brand brand-sm" href="/">Triple<span>Chess</span></a>
          <span class="conn" id="conn" data-status="connecting">Connecting…</span>
        </div>

        <div class="player-block" id="top-block">
          <div class="player-line">
            <span class="player-name" id="top-name">Black</span>
            <span class="material" id="top-material"></span>
            <span class="presence" id="top-presence"></span>
          </div>
          <div id="top-clocks"></div>
        </div>

        <div class="status-bar" id="status">Waiting…</div>

        <div class="moves" id="moves"></div>

        <div class="review-bar" id="review" hidden>
          <button type="button" class="nav" id="nav-start" title="First move (Home)">&#8676;</button>
          <button type="button" class="nav" id="nav-prev" title="Previous (&larr;)">&#8592;</button>
          <span class="review-info" id="review-info"></span>
          <button type="button" class="nav" id="nav-next" title="Next (&rarr;)">&#8594;</button>
          <button type="button" class="nav" id="nav-end" title="Latest (End)">&#8677;</button>
        </div>

        <div class="player-block" id="bottom-block">
          <div id="bottom-clocks"></div>
          <div class="player-line">
            <span class="player-name" id="bottom-name">White</span>
            <span class="material" id="bottom-material"></span>
            <span class="presence" id="bottom-presence"></span>
          </div>
        </div>

        <div class="prompt" id="prompt" hidden></div>

        <div class="controls" id="controls">
          <button type="button" class="btn btn-sm" id="flip" title="Flip board">Flip</button>
          <button type="button" class="btn btn-sm" id="sound" title="Toggle sound">Sound on</button>
          <button type="button" class="btn btn-sm" id="draw">Offer draw</button>
          <button type="button" class="btn btn-sm btn-danger" id="resign">Resign</button>
        </div>
      </aside>
    </div>
  `;

  const el = (id) => root.querySelector(`#${id}`);
  const boardEl = el('board');
  const overlay = el('overlay');
  const statusEl = el('status');
  const movesEl = el('moves');
  const promptEl = el('prompt');
  const connEl = el('conn');
  const controlsEl = el('controls');

  const prefer = sessionStorage.getItem(`triplechess:prefer:${gameId}`) || undefined;
  const connection = new Connection(gameId, { prefer, identity: getIdentity() });

  const board = new BoardView(boardEl, el('promotion'), (move) => {
    connection.send({ t: 'move', ...move });
  });

  const stacks = {
    top: new ClockStack(el('top-clocks'), 'black'),
    bottom: new ClockStack(el('bottom-clocks'), 'white'),
  };
  stacks.top.onLowTime = () => sounds.lowTime();
  stacks.bottom.onLowTime = () => sounds.lowTime();

  let myColor = null;
  let state = null;
  let orientation = 'white';
  let lastHistoryLength = 0;
  let lastStatus = null;
  let resignArmed = false;

  // Review: `frames` is the whole game rebuilt ply by ply. `ply` is null when
  // following the live position, otherwise the frame being examined.
  let frames = [];
  let ply = null;
  const isReviewing = () => ply !== null && ply < frames.length - 1;
  const currentFrame = () => frames[ply === null ? frames.length - 1 : ply] ?? null;
  const at = () => (ply === null ? frames.length - 1 : ply);

  // --- clock rendering loop ------------------------------------------------
  function frame() {
    stacks.top.render();
    stacks.bottom.render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // --- wiring --------------------------------------------------------------
  function assignStacks() {
    // Your own clocks always sit above the move list, whichever colour you are
    // and whichever way the board is facing. Spectators get board order.
    const topColor = myColor ?? other(orientation);
    const bottomColor = other(topColor);
    stacks.top.color = topColor;
    stacks.top.root.dataset.color = topColor;
    stacks.bottom.color = bottomColor;
    stacks.bottom.root.dataset.color = bottomColor;
    const label = (color) => {
      const player = state?.players?.[color];
      const who = player?.name || titleCase(color);
      const rating = player?.rating ? ` ${player.rating}` : '';
      return `${who}${rating}${myColor === color ? ' (you)' : ''}`;
    };
    el('top-name').textContent = label(topColor);
    el('bottom-name').textContent = label(bottomColor);
    if (state) renderPresence();
  }

  function renderPresence() {
    if (!state) return;
    const set = (nodeId, color) => {
      const node = el(nodeId);
      const seated = state.seated[color];
      const online = state.connected[color];
      node.textContent = !seated ? 'empty' : online ? 'online' : 'away';
      node.dataset.state = !seated ? 'empty' : online ? 'online' : 'away';
    };
    set('top-presence', stacks.top.color);
    set('bottom-presence', stacks.bottom.color);
  }

  function renderMoves() {
    if (!state) return;
    const active = ply === null ? state.history.length : ply;
    const rows = [];
    for (let i = 0; i < state.history.length; i += 2) {
      const number = i / 2 + 1;
      const cell = (m, index) => {
        if (!m) return '<span class="move"></span>';
        const on = index + 1 === active ? ' is-current' : '';
        return `<span class="move${on}" data-ply="${index + 1}" role="button" tabindex="0"><span class="move-san">${m.san}</span><span class="move-clock" title="played on clock ${m.clockIndex + 1}">${m.clockIndex + 1}</span></span>`;
      };
      rows.push(
        `<div class="move-row"><span class="move-no">${number}.</span>${cell(state.history[i], i)}${cell(state.history[i + 1], i + 1)}</div>`,
      );
    }
    movesEl.innerHTML = rows.join('') || '<p class="moves-empty">No moves yet.</p>';
    const current = movesEl.querySelector('.move.is-current');
    if (current) current.scrollIntoView({ block: 'nearest' });
    else movesEl.scrollTop = movesEl.scrollHeight;
  }

  /** Material badge (+3) next to whoever is ahead, live or in review. */
  function renderMaterial() {
    const frame = currentFrame();
    const fen = frame ? frame.fen : state?.fen;
    if (!fen) return;
    const { diff } = materialFromFen(fen);
    el('top-material').textContent = advantageFor(stacks.top.color, diff);
    el('bottom-material').textContent = advantageFor(stacks.bottom.color, diff);
  }

  function renderReviewBar() {
    const total = frames.length - 1;
    const bar = el('review');
    bar.hidden = total < 1;
    if (total < 1) return;

    const at = ply === null ? total : ply;
    el('nav-start').disabled = at === 0;
    el('nav-prev').disabled = at === 0;
    el('nav-next').disabled = at >= total;
    el('nav-end').disabled = at >= total;

    const frame = frames[at];
    if (at === 0) {
      el('review-info').textContent = 'Start';
    } else {
      const moveNo = Math.ceil(at / 2);
      const dots = frame.color === 'black' ? '…' : '.';
      const spent = formatSpent(frame.spentMs);
      el('review-info').textContent =
        `${moveNo}${dots} ${frame.san} · clock ${frame.clockIndex + 1}` + (spent ? ` · ${spent}` : '');
    }
    bar.classList.toggle('is-reviewing', isReviewing());
  }

  /** Move to a ply; `null` returns to the live position. */
  function goTo(target) {
    const total = frames.length - 1;
    if (target === null || target >= total) ply = null;
    else ply = Math.max(0, target);

    const frame = currentFrame();
    if (frame && isReviewing()) {
      board.showFrame(frame);
      stacks.top.update(reviewClockState(frame));
      stacks.bottom.update(reviewClockState(frame));
    } else if (state) {
      board.update(state, myColor);
      stacks.top.update(state);
      stacks.bottom.update(state);
    }
    renderMaterial();
    renderReviewBar();
    renderMoves();
    renderStatus();
  }

  /** Feed the clock stacks a frozen snapshot for the ply being reviewed. */
  function reviewClockState(frame) {
    return {
      spec: state.spec,
      clocks: frame.clocks,
      activeIndex: frame.activeIndex,
      running: null, // nothing ticks while looking at the past
    };
  }

  function renderStatus() {
    if (!state) return;

    if (isReviewing()) {
      const total = frames.length - 1;
      statusEl.textContent = `Reviewing — move ${at()} of ${total}`;
      statusEl.dataset.tone = 'review';
      return;
    }

    if (state.status === 'waiting') {
      const missing = !state.seated.white || !state.seated.black;
      statusEl.textContent = missing
        ? 'Waiting for your opponent to join…'
        : 'Waiting for both players to be ready…';
      statusEl.dataset.tone = 'wait';
      return;
    }

    if (state.status === 'finished') {
      const reason = REASON_TEXT[state.reason] ?? state.reason ?? '';
      let headline;
      if (state.result === '1/2-1/2') headline = 'Draw';
      else {
        const winner = state.result === '1-0' ? 'white' : 'black';
        headline = myColor
          ? winner === myColor
            ? 'You won'
            : 'You lost'
          : `${titleCase(winner)} won`;
      }
      statusEl.textContent = `${headline} — ${reason}`;
      statusEl.dataset.tone = 'done';
      return;
    }

    const toMove = state.turn;
    const clockNo = state.activeIndex[toMove] + 1;
    const spec = formatSpec(state.spec[state.activeIndex[toMove]]);
    const who = myColor === toMove ? 'Your move' : `${titleCase(toMove)} to move`;
    statusEl.textContent = `${who} — clock ${clockNo} (${spec})`;
    statusEl.dataset.tone = myColor === toMove ? 'you' : 'them';
  }

  function renderOverlay() {
    if (!state) return;
    const waitingForOpponent = state.status === 'waiting' && myColor && !state.seated[other(myColor)];

    if (waitingForOpponent) {
      const link = `${location.origin}/g/${state.id}`;
      overlay.hidden = false;
      overlay.innerHTML = `
        <div class="overlay-card">
          <h3>Send this to your opponent</h3>
          <div class="share-row">
            <input type="text" readonly value="${link}" id="share-link" />
            <button type="button" class="btn btn-sm" id="copy">Copy</button>
          </div>
          <p class="overlay-note">The game starts as soon as they open it.</p>
        </div>
      `;
      overlay.querySelector('#copy').addEventListener('click', async () => {
        const input = overlay.querySelector('#share-link');
        input.select();
        try {
          await navigator.clipboard.writeText(link);
        } catch {
          document.execCommand('copy');
        }
        overlay.querySelector('#copy').textContent = 'Copied';
      });
      return;
    }

    if (state.status === 'finished') {
      overlay.hidden = false;
      const reason = REASON_TEXT[state.reason] ?? state.reason ?? '';
      const resultLine =
        state.result === '1/2-1/2'
          ? 'Draw'
          : `${state.result === '1-0' ? 'White' : 'Black'} wins`;
      const offered = state.rematchOffer && state.rematchOffer === myColor;
      const theirOffer = state.rematchOffer && state.rematchOffer !== myColor;
      const change = myColor && state.ratingChange ? state.ratingChange[myColor] : null;
      const ratingLine = change
        ? `<p class="rating-line">Rating ${change.after} <span class="${change.delta >= 0 ? 'up' : 'down'}">${change.delta >= 0 ? '+' : ''}${change.delta}</span></p>`
        : '';
      overlay.innerHTML = `
        <div class="overlay-card">
          <h3>${resultLine}</h3>
          <p class="overlay-note">${reason} · ${state.result}</p>
          ${ratingLine}
          ${
            myColor
              ? `<button type="button" class="btn btn-primary" id="rematch">${
                  offered ? 'Rematch offered…' : theirOffer ? 'Accept rematch' : 'Rematch'
                }</button>`
              : ''
          }
          <a class="btn btn-sm" href="/">New game</a>
        </div>
      `;
      overlay.querySelector('#rematch')?.addEventListener('click', () => {
        connection.send({ t: 'rematch' });
      });
      return;
    }

    overlay.hidden = true;
    overlay.innerHTML = '';
  }

  function renderPrompt() {
    if (!state || !myColor) {
      promptEl.hidden = true;
      return;
    }
    if (state.status === 'active' && state.drawOffer && state.drawOffer !== myColor) {
      promptEl.hidden = false;
      promptEl.innerHTML = `
        <span>Your opponent offers a draw.</span>
        <span class="prompt-actions">
          <button type="button" class="btn btn-sm btn-primary" id="accept">Accept</button>
          <button type="button" class="btn btn-sm" id="decline">Decline</button>
        </span>
      `;
      promptEl.querySelector('#accept').addEventListener('click', () =>
        connection.send({ t: 'accept-draw' }),
      );
      promptEl.querySelector('#decline').addEventListener('click', () =>
        connection.send({ t: 'decline-draw' }),
      );
      return;
    }
    if (state.status === 'active' && state.drawOffer === myColor) {
      promptEl.hidden = false;
      promptEl.innerHTML = '<span>Draw offered. Waiting for a reply…</span>';
      return;
    }
    promptEl.hidden = true;
  }

  function renderControls() {
    const playing = Boolean(myColor) && state?.status === 'active';
    controlsEl.querySelector('#draw').disabled = !playing;
    const resignBtn = controlsEl.querySelector('#resign');
    resignBtn.disabled = !playing;
    if (!playing && resignArmed) {
      resignArmed = false;
      resignBtn.textContent = 'Resign';
      resignBtn.classList.remove('is-armed');
    }
  }

  function playSounds(previousLength, previousStatus) {
    if (!state) return;
    if (state.history.length > previousLength) {
      const last = state.history[state.history.length - 1];
      if (last.san.includes('#')) sounds.end();
      else if (last.san.includes('+')) sounds.check();
      else if (last.san.includes('x')) sounds.capture();
      else sounds.move();
    }
    if (state.status === 'finished' && previousStatus !== 'finished') sounds.end();
  }

  function applyState(next) {
    const previousLength = lastHistoryLength;
    const previousStatus = lastStatus;
    const wasReviewing = isReviewing();
    state = next;
    frames = buildTimeline(state);
    assignStacks(); // names and ratings arrive with the state

    // Stay where the reader is looking if they had stepped back; otherwise
    // follow the live position.
    if (!wasReviewing) ply = null;

    if (isReviewing()) {
      const frame = currentFrame();
      board.showFrame(frame);
      stacks.top.update(reviewClockState(frame));
      stacks.bottom.update(reviewClockState(frame));
    } else {
      board.update(state, myColor);
      stacks.top.update(state);
      stacks.bottom.update(state);
    }

    renderStatus();
    renderMoves();
    renderPresence();
    renderMaterial();
    renderReviewBar();
    renderOverlay();
    renderPrompt();
    renderControls();
    playSounds(previousLength, previousStatus);

    lastHistoryLength = state.history.length;
    lastStatus = state.status;
  }

  // --- controls ------------------------------------------------------------
  el('flip').addEventListener('click', () => {
    orientation = board.flip();
    assignStacks();
    goTo(ply);
    renderOverlay();
  });

  // --- review navigation ---------------------------------------------------
  el('nav-start').addEventListener('click', () => goTo(0));
  el('nav-prev').addEventListener('click', () => goTo(at() - 1));
  el('nav-next').addEventListener('click', () => goTo(at() + 1));
  el('nav-end').addEventListener('click', () => goTo(null));

  movesEl.addEventListener('click', (event) => {
    const move = event.target.closest('.move[data-ply]');
    if (move) goTo(Number(move.dataset.ply));
  });

  document.addEventListener('keydown', (event) => {
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const keys = {
      ArrowLeft: () => goTo(at() - 1),
      ArrowRight: () => goTo(at() + 1),
      Home: () => goTo(0),
      End: () => goTo(null),
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  });

  const soundButton = el('sound');
  soundButton.addEventListener('click', () => {
    const next = !sounds.isEnabled();
    sounds.setEnabled(next);
    if (next) sounds.unlock();
    soundButton.textContent = next ? 'Sound on' : 'Sound off';
    soundButton.classList.toggle('is-off', !next);
  });

  el('draw').addEventListener('click', () => connection.send({ t: 'offer-draw' }));

  // Resignation is one click away from throwing the game, so make it two.
  const resignButton = el('resign');
  resignButton.addEventListener('click', () => {
    if (!resignArmed) {
      resignArmed = true;
      resignButton.textContent = 'Confirm resign';
      resignButton.classList.add('is-armed');
      setTimeout(() => {
        if (!resignArmed) return;
        resignArmed = false;
        resignButton.textContent = 'Resign';
        resignButton.classList.remove('is-armed');
      }, 4000);
      return;
    }
    resignArmed = false;
    resignButton.textContent = 'Resign';
    resignButton.classList.remove('is-armed');
    connection.send({ t: 'resign' });
  });

  document.addEventListener('click', () => sounds.unlock(), { once: true });

  // --- connection ----------------------------------------------------------
  connection
    .on('welcome', (msg) => {
      myColor = msg.color;
      if (myColor) {
        orientation = myColor;
        board.setOrientation(myColor);
      }
      assignStacks();
      controlsEl.hidden = !myColor;
      if (!myColor) statusEl.textContent = 'Watching this game.';
    })
    .on('state', (msg) => {
      if (msg.you !== undefined && msg.you !== null) myColor = msg.you;
      applyState(msg.state);
    })
    .on('rematch', (msg) => {
      // Keep our seat token so the swapped colors in the new game stick.
      connection.adoptInto(msg.id);
      location.assign(`/g/${msg.id}`);
    })
    .on('error', (msg) => {
      statusEl.textContent = msg.error;
      statusEl.dataset.tone = 'error';
      setTimeout(renderStatus, 2500);
    })
    .on('fatal', (msg) => {
      connection.close();
      root.innerHTML = `
        <div class="fatal">
          <h2>${msg.error}</h2>
          <a class="btn btn-primary" href="/">Start a new game</a>
        </div>
      `;
    })
    .on('status', (value) => {
      connEl.dataset.status = value;
      connEl.textContent = value === 'online' ? 'Connected' : 'Reconnecting…';
    });

  connection.connect();
  assignStacks();
}
