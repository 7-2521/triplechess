import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
import './styles.css';

import { renderLobby } from './lobby.js';
import { renderGame } from './game.js';

const root = document.getElementById('app');
const match = location.pathname.match(/^\/g\/([^/]+)\/?$/);

if (match) {
  renderGame(root, decodeURIComponent(match[1]));
} else {
  renderLobby(root);
}
