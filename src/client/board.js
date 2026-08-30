import { Chessground } from '@lichess-org/chessground';
import { Chess, SQUARES } from 'chess.js';

const PROMOTION_PIECES = [
  { role: 'queen', letter: 'q' },
  { role: 'knight', letter: 'n' },
  { role: 'rook', letter: 'r' },
  { role: 'bishop', letter: 'b' },
];

/** Legal destinations per origin square, in the shape chessground wants. */
function computeDests(chess) {
  const dests = new Map();
  for (const square of SQUARES) {
    const moves = chess.moves({ square, verbose: true });
    if (moves.length) dests.set(square, moves.map((m) => m.to));
  }
  return dests;
}

export class BoardView {
  /**
   * @param {HTMLElement} root board container
   * @param {HTMLElement} promotionLayer overlay host, positioned over the board
   * @param {(move: {from: string, to: string, promotion?: string}) => void} onMove
   */
  constructor(root, promotionLayer, onMove) {
    this.root = root;
    this.promotionLayer = promotionLayer;
    this.onMove = onMove;
    this.chess = new Chess();
    this.orientation = 'white';
    this.myColor = null;
    this.state = null;
    this.pendingPromotion = null;

    this.ground = Chessground(root, {
      fen: this.chess.fen(),
      orientation: 'white',
      // `movable.events.after` fires only for moves the player actually makes,
      // which is what we want to send. (`events.move` would also fire for
      // moves we apply programmatically from server state.)
      movable: {
        free: false,
        color: undefined,
        dests: new Map(),
        showDests: true,
        events: { after: (orig, dest) => this.handleUserMove(orig, dest) },
      },
      premovable: { enabled: true, showDests: true, castle: true },
      draggable: { showGhost: true },
      highlight: { lastMove: true, check: true },
      animation: { enabled: true, duration: 180 },
      drawable: { enabled: true },
    });
    // The board is sized from the viewport, so it changes size when the window
    // does. chessground observes its own wrapper and re-measures, so there is
    // nothing to wire up here.
  }

  setOrientation(color) {
    this.orientation = color;
    this.ground.set({ orientation: color });
    this.cancelPromotion();
  }

  flip() {
    this.setOrientation(this.orientation === 'white' ? 'black' : 'white');
    return this.orientation;
  }

  /** Apply authoritative state from the server. */
  update(state, myColor) {
    this.state = state;
    this.myColor = myColor;
    this.chess.load(state.fen);
    this.cancelPromotion();

    const playing = Boolean(myColor) && state.status === 'active';
    const myTurn = playing && state.turn === myColor;

    // `movable.color` stays set to our colour even when it is not our turn —
    // that is what lets chessground accept premoves. Real moves are gated by
    // `dests`, which is empty until the turn is actually ours.
    this.ground.set({
      fen: state.fen,
      turnColor: state.turn,
      lastMove: state.lastMove ?? undefined,
      check: state.check ?? false,
      movable: {
        free: false,
        color: playing ? myColor : undefined,
        dests: myTurn ? computeDests(this.chess) : new Map(),
        showDests: true,
      },
      premovable: { enabled: playing, showDests: true, castle: true },
      draggable: { enabled: playing },
      selectable: { enabled: playing },
      viewOnly: state.status === 'finished' && !myColor,
    });

    if (!playing) {
      this.clearPending();
    } else if (myTurn) {
      // Our turn came around: fire any queued premove. chessground validates it
      // against the legal moves we just set and drops it if it no longer works,
      // so a premove that the opponent's move invalidated simply disappears.
      this.ground.playPremove();
    }
  }

  /** Drop any queued premove and leftover square selection. */
  clearPending() {
    this.ground.cancelPremove();
    this.ground.selectSquare(null);
  }

  /** Show a past position while reviewing. The board is look-only here. */
  showFrame(frame) {
    this.cancelPromotion();
    this.ground.set({
      fen: frame.fen,
      turnColor: frame.turn,
      lastMove: frame.lastMove ?? undefined,
      check: frame.check ?? false,
      movable: { free: false, color: undefined, dests: new Map() },
      premovable: { enabled: false },
      draggable: { enabled: false },
      selectable: { enabled: false },
    });
    this.clearPending();
  }

  handleUserMove(orig, dest) {
    const piece = this.chess.get(orig);
    const promotes =
      piece &&
      piece.type === 'p' &&
      ((piece.color === 'w' && dest[1] === '8') || (piece.color === 'b' && dest[1] === '1'));

    if (promotes) {
      this.askPromotion(orig, dest, piece.color === 'w' ? 'white' : 'black');
      return;
    }
    this.onMove({ from: orig, to: dest });
  }

  // --- promotion -----------------------------------------------------------

  askPromotion(from, to, color) {
    this.pendingPromotion = { from, to, color };
    const file = to.charCodeAt(0) - 97; // a=0
    const rank = Number(to[1]) - 1; // 1=0
    const col = this.orientation === 'white' ? file : 7 - file;
    const row = this.orientation === 'white' ? 7 - rank : rank;
    // Fan the choices out from the promotion square, away from the edge.
    const direction = row === 0 ? 1 : -1;

    this.promotionLayer.innerHTML = '';
    this.promotionLayer.classList.add('is-open');

    const backdrop = document.createElement('div');
    backdrop.className = 'promotion-backdrop';
    backdrop.addEventListener('click', () => this.cancelPromotion(true));
    this.promotionLayer.appendChild(backdrop);

    PROMOTION_PIECES.forEach((choice, i) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'promotion-choice';
      cell.style.left = `${col * 12.5}%`;
      cell.style.top = `${(row + direction * i) * 12.5}%`;
      cell.setAttribute('aria-label', `Promote to ${choice.role}`);
      const art = document.createElement('piece');
      art.className = `${choice.role} ${color}`;
      cell.appendChild(art);
      cell.addEventListener('click', () => {
        this.promotionLayer.classList.remove('is-open');
        this.promotionLayer.innerHTML = '';
        this.pendingPromotion = null;
        this.onMove({ from, to, promotion: choice.letter });
      });
      this.promotionLayer.appendChild(cell);
    });
  }

  /** @param {boolean} revert put the dragged pawn back where it came from */
  cancelPromotion(revert = false) {
    if (this.promotionLayer.classList.contains('is-open')) {
      this.promotionLayer.classList.remove('is-open');
      this.promotionLayer.innerHTML = '';
    }
    if (revert && this.pendingPromotion && this.state) {
      // chessground already moved the pawn optimistically; restore the truth.
      this.ground.set({ fen: this.state.fen });
    }
    this.pendingPromotion = null;
  }
}
