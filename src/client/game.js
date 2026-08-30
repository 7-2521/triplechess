import { BoardView } from './board.js';
import { ClockStack } from './clocks.js';
import { Connection } from './net.js';
import { sounds } from './sound.js';
import { formatSpec } from '../shared/tc.js';

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
            <span class="presence" id="top-presence"></span>
          </div>
          <div id="top-clocks"></div>
        </div>

        <div class="status-bar" id="status">Waiting…</div>

        <div class="moves" id="moves"></div>

        <div class="player-block" id="bottom-block">
          <div id="bottom-clocks"></div>
          <div class="player-line">
            <span class="player-name" id="bottom-name">White</span>
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
  const connection = new Connection(gameId, { prefer });

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
    el('top-name').textContent = titleCase(topColor) + (myColor === topColor ? ' (you)' : '');
    el('bottom-name').textContent =
      titleCase(bottomColor) + (myColor === bottomColor ? ' (you)' : '');
    if (state) {
      stacks.top.update(state);
      stacks.bottom.update(state);
      renderPresence();
    }
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
    const rows = [];
    for (let i = 0; i < state.history.length; i += 2) {
      const number = i / 2 + 1;
      const white = state.history[i];
      const black = state.history[i + 1];
      const cell = (m) =>
        m
          ? `<span class="move"><span class="move-san">${m.san}</span><span class="move-clock" title="played on clock ${m.clockIndex + 1}">${m.clockIndex + 1}</span></span>`
          : '<span class="move"></span>';
      rows.push(
        `<div class="move-row"><span class="move-no">${number}.</span>${cell(white)}${cell(black)}</div>`,
      );
    }
    movesEl.innerHTML = rows.join('') || '<p class="moves-empty">No moves yet.</p>';
    movesEl.scrollTop = movesEl.scrollHeight;
  }

  function renderStatus() {
    if (!state) return;

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
      overlay.innerHTML = `
        <div class="overlay-card">
          <h3>${resultLine}</h3>
          <p class="overlay-note">${reason} · ${state.result}</p>
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
    state = next;

    board.update(state, myColor);
    stacks.top.update(state);
    stacks.bottom.update(state);

    renderStatus();
    renderMoves();
    renderPresence();
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
    renderOverlay();
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
