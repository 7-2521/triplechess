/**
 * WebSocket connection to one game, with automatic reconnect.
 *
 * The seat token is persisted per game so a refresh (or a dropped phone
 * connection) puts the player back in the same chair instead of turning them
 * into a spectator.
 */
export class Connection {
  constructor(gameId, { prefer } = {}) {
    this.gameId = gameId;
    this.prefer = prefer;
    this.socket = null;
    this.attempts = 0;
    this.closed = false;
    this.handlers = new Map();
    this.storageKey = `triplechess:token:${gameId}`;
    // ?seat=new deliberately claims a fresh seat, so both sides of a game can
    // be opened in one browser (handy for testing, or for two people sharing
    // a machine) without the second tab inheriting the first one's identity.
    this.forceNew = new URLSearchParams(location.search).get('seat') === 'new';
  }

  /**
   * Seat identity lives in sessionStorage (per tab) and mirrors to
   * localStorage (per browser) so that a refresh keeps the seat and reopening
   * the link in a fresh tab still rejoins it.
   */
  get token() {
    try {
      const perTab = sessionStorage.getItem(this.storageKey);
      if (perTab) return perTab;
      if (this.forceNew) return null;
      return localStorage.getItem(this.storageKey);
    } catch {
      return this.memoryToken ?? null;
    }
  }

  set token(value) {
    this.memoryToken = value;
    try {
      sessionStorage.setItem(this.storageKey, value);
      // A forced-new seat must not clobber the other tab's stored identity.
      if (!this.forceNew) localStorage.setItem(this.storageKey, value);
    } catch {
      /* private browsing — fall back to the in-memory copy */
    }
  }

  /**
   * Carry this seat's identity into a follow-up game. A rematch keeps the same
   * two tokens (with colors swapped), but tokens are stored per game id, so
   * without this the players would arrive at the new board as spectators.
   */
  adoptInto(gameId) {
    const token = this.token;
    if (!token) return;
    const key = `triplechess:token:${gameId}`;
    try {
      sessionStorage.setItem(key, token);
      if (!this.forceNew) localStorage.setItem(key, token);
    } catch {
      /* storage unavailable — the seat will be re-taken on arrival */
    }
  }

  on(type, handler) {
    this.handlers.set(type, handler);
    return this;
  }

  emit(type, payload) {
    this.handlers.get(type)?.(payload);
  }

  connect() {
    if (this.closed) return;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const params = new URLSearchParams({ game: this.gameId });
    const token = this.token;
    if (token) params.set('token', token);
    if (this.prefer) params.set('prefer', this.prefer);

    const socket = new WebSocket(`${scheme}://${location.host}/ws?${params}`);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempts = 0;
      this.emit('status', 'online');
    });

    socket.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.t === 'welcome') this.token = msg.token;
      this.emit(msg.t, msg);
    });

    socket.addEventListener('close', () => {
      if (this.closed) return;
      this.emit('status', 'offline');
      this.attempts += 1;
      // Back off, but stay responsive: 0.5s, 1s, 2s, 4s ... capped at 8s.
      const delay = Math.min(8000, 500 * 2 ** (this.attempts - 1));
      setTimeout(() => this.connect(), delay);
    });

    socket.addEventListener('error', () => socket.close());
  }

  send(payload) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  close() {
    this.closed = true;
    this.socket?.close();
  }
}
