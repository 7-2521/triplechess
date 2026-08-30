import { CLOCK_COUNT, DEFAULT_CLOCKS, LIMITS, formatSpec } from '../shared/tc.js';
import { LobbyConnection } from './net.js';
import { getIdentity, setName } from './identity.js';

const PRESETS = [
  {
    name: 'Classic Triple',
    hint: 'The original: think, then hurry, then panic.',
    clocks: [
      { initial: 900, increment: 0 },
      { initial: 180, increment: 2 },
      { initial: 60, increment: 0 },
    ],
  },
  {
    name: 'Rapid Ladder',
    hint: 'Gentler drop for longer games.',
    clocks: [
      { initial: 1800, increment: 10 },
      { initial: 600, increment: 5 },
      { initial: 180, increment: 2 },
    ],
  },
  {
    name: 'Blitz Ladder',
    hint: 'Quick throughout, brutal every third move.',
    clocks: [
      { initial: 300, increment: 3 },
      { initial: 120, increment: 1 },
      { initial: 30, increment: 0 },
    ],
  },
  {
    name: 'Pure Chaos',
    hint: 'Bullet, bullet, hyperbullet.',
    clocks: [
      { initial: 120, increment: 1 },
      { initial: 60, increment: 0 },
      { initial: 15, increment: 0 },
    ],
  },
];

const minutesFromSeconds = (s) => Math.round((s / 60) * 100) / 100;
const COLOR_LABEL = { white: 'White', black: 'Black', random: 'Random' };

export function renderLobby(root) {
  let clocks = DEFAULT_CLOCKS.map((c) => ({ ...c }));
  let prefer = 'random';
  let seeking = false;
  const identity = getIdentity();

  root.innerHTML = `
    <div class="lobby">
      <header class="lobby-head">
        <h1 class="brand">Triple<span>Chess</span></h1>
        <p class="tagline">
          Standard chess, three clocks each. Your clock rotates every move &mdash;
          so every third move you are playing a different time control.
        </p>
        <div class="identity">
          <label for="player-name">Playing as</label>
          <input type="text" id="player-name" maxlength="20" value="${identity.name}" />
          <span class="rating-chip" id="my-rating">&mdash;</span>
        </div>
      </header>

      <section class="panel">
        <h2>Time controls</h2>
        <p class="panel-note">
          Each player gets all three banks. Move 1 runs on clock 1, move 2 on clock 2,
          move 3 on clock 3, move 4 back to clock 1. Every bank keeps its own remaining
          time and its own increment for the whole game.
        </p>
        <div class="preset-row" id="presets"></div>
        <div class="clock-editor" id="editor"></div>
      </section>

      <section class="panel">
        <h2>Your colour</h2>
        <div class="segmented" id="colour">
          <button type="button" data-value="white">White</button>
          <button type="button" data-value="random" class="is-on">Random</button>
          <button type="button" data-value="black">Black</button>
        </div>
      </section>

      <div class="lobby-actions">
        <button type="button" class="btn btn-primary btn-find" id="find">Find an opponent</button>
        <button type="button" class="btn" id="create">Create a private game</button>
        <p class="hint" id="action-hint">
          Find pairs you with anyone waiting on the same three time controls.
          Private gives you a link to send.
        </p>
      </div>

      <section class="panel" id="pool-panel">
        <h2>Players waiting <span class="count" id="pool-count"></span></h2>
        <div class="pool-list" id="pool-list"></div>
      </section>

      <section class="panel join-panel">
        <h2>Join by code</h2>
        <form class="join-row" id="join-form">
          <input type="text" id="join-code" placeholder="Game code or link" autocomplete="off" />
          <button type="submit" class="btn">Join</button>
        </form>
      </section>

      <p class="lobby-error" id="error" hidden></p>
    </div>
  `;

  const el = (id) => root.querySelector(`#${id}`);
  const editor = el('editor');
  const errorEl = el('error');
  const findButton = el('find');
  const poolList = el('pool-list');

  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.hidden = !message;
  };

  // --- time control editor -------------------------------------------------

  function drawEditor() {
    editor.innerHTML = '';
    for (let i = 0; i < CLOCK_COUNT; i++) {
      const card = document.createElement('div');
      card.className = 'clock-card';
      card.innerHTML = `
        <div class="clock-card-head">
          <span class="clock-badge">${i + 1}</span>
          <span class="clock-card-title">Clock ${i + 1}</span>
          <span class="clock-card-summary">${formatSpec(clocks[i])}</span>
        </div>
        <label>
          <span>Initial (minutes)</span>
          <input type="number" step="0.5" min="${LIMITS.initial.min / 60}"
                 max="${LIMITS.initial.max / 60}" value="${minutesFromSeconds(clocks[i].initial)}"
                 data-field="initial" data-index="${i}" />
        </label>
        <label>
          <span>Increment (seconds)</span>
          <input type="number" step="1" min="${LIMITS.increment.min}"
                 max="${LIMITS.increment.max}" value="${clocks[i].increment}"
                 data-field="increment" data-index="${i}" />
        </label>
      `;
      editor.appendChild(card);
    }
  }

  editor.addEventListener('input', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const index = Number(input.dataset.index);
    const field = input.dataset.field;
    const raw = Number(input.value);
    if (!Number.isFinite(raw)) return;

    if (field === 'initial') {
      const seconds = Math.round(raw * 60);
      clocks[index].initial = Math.min(
        LIMITS.initial.max,
        Math.max(LIMITS.initial.min, seconds || LIMITS.initial.min),
      );
    } else {
      clocks[index].increment = Math.min(
        LIMITS.increment.max,
        Math.max(LIMITS.increment.min, Math.round(raw) || 0),
      );
    }
    const summary = editor.querySelectorAll('.clock-card-summary')[index];
    if (summary) summary.textContent = formatSpec(clocks[index]);
    if (seeking) stopSeeking(); // the queue entry no longer matches the form
  });

  const presetRow = el('presets');
  PRESETS.forEach((preset) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preset';
    button.innerHTML = `
      <strong>${preset.name}</strong>
      <span class="preset-specs">${preset.clocks.map(formatSpec).join(' / ')}</span>
      <span class="preset-hint">${preset.hint}</span>
    `;
    button.addEventListener('click', () => {
      clocks = preset.clocks.map((c) => ({ ...c }));
      drawEditor();
      presetRow.querySelectorAll('.preset').forEach((b) => b.classList.remove('is-on'));
      button.classList.add('is-on');
      if (seeking) stopSeeking();
    });
    presetRow.appendChild(button);
  });
  presetRow.firstElementChild?.classList.add('is-on');

  el('colour').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    prefer = button.dataset.value;
    root.querySelectorAll('#colour button').forEach((b) => b.classList.toggle('is-on', b === button));
    if (seeking) stopSeeking();
  });

  el('player-name').addEventListener('change', (event) => {
    const updated = setName(event.target.value);
    event.target.value = updated.name;
  });

  // --- matchmaking ---------------------------------------------------------

  const lobby = new LobbyConnection();

  function startSeeking() {
    seeking = true;
    findButton.textContent = 'Waiting for an opponent…';
    findButton.classList.add('is-waiting');
    lobby.seek(clocks, prefer);
  }

  function stopSeeking() {
    seeking = false;
    findButton.textContent = 'Find an opponent';
    findButton.classList.remove('is-waiting');
    lobby.cancel();
  }

  findButton.addEventListener('click', () => {
    showError('');
    if (seeking) stopSeeking();
    else startSeeking();
  });

  function renderPool(seeks) {
    el('pool-count').textContent = seeks.length ? `(${seeks.length})` : '';
    if (!seeks.length) {
      poolList.innerHTML =
        '<p class="pool-empty">Nobody is waiting right now. Start a seek and you will be paired as soon as someone else does.</p>';
      return;
    }
    poolList.innerHTML = '';
    for (const seek of seeks) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'pool-row' + (seek.mine ? ' is-mine' : '');
      row.disabled = seek.mine;
      row.innerHTML = `
        <span class="pool-specs">${seek.clocks.map(formatSpec).join(' / ')}</span>
        <span class="pool-colour">${COLOR_LABEL[seek.color] ?? 'Random'}</span>
        <span class="pool-action">${seek.mine ? 'Your seek' : 'Play'}</span>
      `;
      if (!seek.mine) row.addEventListener('click', () => lobby.accept(seek.id));
      poolList.appendChild(row);
    }
  }

  lobby
    .on('pool', (msg) => renderPool(msg.seeks || []))
    .on('paired', (msg) => {
      lobby.storeSeat(msg.gameId, msg.token);
      lobby.close();
      location.assign(`/g/${msg.gameId}`);
    })
    .on('error', (msg) => showError(msg.error))
    .on('status', (value) => {
      if (value === 'offline' && seeking) findButton.textContent = 'Reconnecting…';
      else if (value === 'online' && seeking) findButton.textContent = 'Waiting for an opponent…';
    });
  lobby.connect();

  // --- private game + join by code ----------------------------------------

  const createButton = el('create');
  createButton.addEventListener('click', async () => {
    createButton.disabled = true;
    createButton.textContent = 'Creating…';
    showError('');
    try {
      const res = await fetch('/api/games', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clocks }),
      });
      if (!res.ok) throw new Error('Could not create the game.');
      const data = await res.json();
      sessionStorage.setItem(`triplechess:prefer:${data.id}`, prefer);
      location.assign(`/g/${data.id}`);
    } catch (err) {
      showError(err.message || 'Something went wrong.');
      createButton.disabled = false;
      createButton.textContent = 'Create a private game';
    }
  });

  el('join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = el('join-code').value.trim();
    if (!value) return;
    const code = value.includes('/') ? value.split('/').filter(Boolean).pop() : value;
    location.assign(`/g/${encodeURIComponent(code)}`);
  });

  // Show our own rating. A "?" marks a provisional rating, as lichess does.
  fetch(`/api/player/${encodeURIComponent(identity.id)}`)
    .then((r) => r.json())
    .then((me) => {
      el('my-rating').textContent = `${me.rating}${me.provisional ? '?' : ''}`;
      el('my-rating').title = `${me.games} rated game${me.games === 1 ? '' : 's'}`;
    })
    .catch(() => {
      el('my-rating').textContent = '1200?';
    });

  drawEditor();
  renderPool([]);
}
