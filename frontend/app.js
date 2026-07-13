// ---- CONFIG ----
// Replace this with your deployed backend URL (e.g. https://your-backend.onrender.com)
const BACKEND_URL = 'https://telegram-game-app-production.up.railway.app';

// ---- Telegram init ----
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}
const initData = tg?.initData || '';

// ---- Screens ----
const screens = {
  loading: document.getElementById('screen-loading'),
  menu: document.getElementById('screen-menu'),
  waiting: document.getElementById('screen-waiting'),
  chess: document.getElementById('screen-chess'),
  ludo: document.getElementById('screen-ludo'),
  gameover: document.getElementById('screen-gameover'),
};
function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

// ---- Socket connection ----
const socket = io(BACKEND_URL);

let myUserId = null;
let currentRoomId = null;
let currentGame = null; // 'chess' | 'ludo'

socket.on('connect', () => {
  socket.emit('auth', initData);
});

socket.on('auth_error', (msg) => {
  alert('Auth failed: ' + msg + '\nOpen this app from Telegram (not a plain browser).');
});

socket.on('auth_success', ({ user, points }) => {
  myUserId = String(user.id);
  document.getElementById('player-name').textContent = user.first_name || 'Player';
  document.getElementById('points-value').textContent = points;
  showScreen('menu');
});

socket.on('points_update', ({ points }) => {
  document.getElementById('points-value').textContent = points;
});

// ---- Menu actions ----
document.getElementById('btn-chess').onclick = () => joinQueue('chess');
document.getElementById('btn-ludo').onclick = () => joinQueue('ludo');
document.getElementById('btn-cancel-queue').onclick = () => {
  socket.emit('leave_queue', { game: currentGame });
  showScreen('menu');
};
document.getElementById('btn-back-to-menu').onclick = () => {
  socket.emit('get_points');
  showScreen('menu');
};

function joinQueue(game) {
  currentGame = game;
  socket.emit('join_queue', { game });
  showScreen('waiting');
}

socket.on('match_found', (data) => {
  currentRoomId = data.roomId;
  if (data.game === 'chess') {
    startChess(data);
  } else if (data.game === 'ludo') {
    startLudo(data);
  }
});

socket.on('invalid_move', (reason) => {
  console.warn('Invalid move:', reason);
});

socket.on('game_over', ({ winnerId }) => {
  const won = winnerId === myUserId;
  document.getElementById('result-icon').textContent = won ? '🏆' : winnerId ? '😔' : '🤝';
  document.getElementById('result-text').textContent = won
    ? 'You Won!'
    : winnerId
    ? 'You Lost'
    : 'Game Over';
  document.getElementById('result-points').textContent = won ? '+10 points added!' : '';
  showScreen('gameover');
});

// =========================================================
// CHESS
// =========================================================
const PIECE_UNICODE = {
  p: '♟', r: '♜', n: '♞', b: '♝', q: '♛', k: '♚',
  P: '♙', R: '♖', N: '♘', B: '♗', Q: '♕', K: '♔',
};

let chessMyColor = 'w';
let chessSelected = null;
let chessLastMove = null;
let chessFen = null;

function startChess(data) {
  chessMyColor = data.color;
  chessFen = data.fen;
  chessSelected = null;
  chessLastMove = null;
  document.getElementById('chess-opponent').textContent = 'vs ' + data.opponent;
  updateChessTurn(data.turn);
  renderChessBoard();
  showScreen('chess');
}

function updateChessTurn(turn) {
  const isMyTurn = turn === myUserId;
  document.getElementById('chess-turn-indicator').textContent = isMyTurn ? 'Your turn' : "Opponent's turn";
}

socket.on('chess_update', ({ fen, lastMove, turn }) => {
  chessFen = fen;
  chessLastMove = lastMove;
  chessSelected = null;
  updateChessTurn(turn);
  renderChessBoard();
});

function fenToBoard(fen) {
  const rows = fen.split(' ')[0].split('/');
  const board = [];
  for (const row of rows) {
    const line = [];
    for (const ch of row) {
      if (/\d/.test(ch)) {
        for (let i = 0; i < Number(ch); i++) line.push(null);
      } else {
        line.push(ch);
      }
    }
    board.push(line);
  }
  return board; // board[0] = rank 8 ... board[7] = rank 1
}

function renderChessBoard() {
  const boardEl = document.getElementById('chess-board');
  boardEl.innerHTML = '';
  const board = fenToBoard(chessFen);
  const flip = chessMyColor === 'b';

  for (let displayRow = 0; displayRow < 8; displayRow++) {
    for (let displayCol = 0; displayCol < 8; displayCol++) {
      const row = flip ? 7 - displayRow : displayRow;
      const col = flip ? 7 - displayCol : displayCol;
      const file = 'abcdefgh'[col];
      const rank = 8 - row;
      const square = `${file}${rank}`;

      const el = document.createElement('div');
      el.className = 'chess-square ' + ((row + col) % 2 === 0 ? 'light' : 'dark');
      if (chessSelected === square) el.classList.add('selected');
      if (chessLastMove && (chessLastMove.from === square || chessLastMove.to === square)) {
        el.classList.add('last-move');
      }

      const piece = board[row][col];
      if (piece) el.textContent = PIECE_UNICODE[piece];

      el.onclick = () => onChessSquareClick(square);
      boardEl.appendChild(el);
    }
  }
}

function onChessSquareClick(square) {
  if (!chessSelected) {
    chessSelected = square;
    renderChessBoard();
    return;
  }
  if (chessSelected === square) {
    chessSelected = null;
    renderChessBoard();
    return;
  }
  socket.emit('chess_move', { roomId: currentRoomId, from: chessSelected, to: square, promotion: 'q' });
  chessSelected = null;
}

document.getElementById('btn-chess-leave').onclick = () => {
  showScreen('menu');
  socket.emit('get_points');
};

// =========================================================
// LUDO
// =========================================================
const COLOR_CLASS = { red: 'tok-red', green: 'tok-green', yellow: 'tok-yellow', blue: 'tok-blue' };
let ludoState = null;
let ludoLastDice = null;

function startLudo(data) {
  ludoState = data.state;
  ludoLastDice = null;
  document.getElementById('ludo-opponent').textContent = 'vs ' + data.opponent;
  updateLudoTurn(data.turn);
  renderLudoTrack();
  renderLudoTokenButtons();
  showScreen('ludo');
}

function updateLudoTurn(turn) {
  const isMyTurn = turn === myUserId;
  document.getElementById('ludo-turn-indicator').textContent = isMyTurn ? 'Your turn' : "Opponent's turn";
  document.getElementById('btn-roll-dice').disabled = !isMyTurn;
}

socket.on('ludo_dice', ({ dice }) => {
  ludoLastDice = dice;
  document.getElementById('dice-result').textContent = '🎲 ' + dice;
  renderLudoTokenButtons();
});

socket.on('ludo_update', (state) => {
  ludoState = state;
  renderLudoTrack();
  renderLudoTokenButtons();
});

socket.on('ludo_turn', ({ turn }) => {
  ludoLastDice = null;
  document.getElementById('dice-result').textContent = '';
  updateLudoTurn(turn);
  renderLudoTokenButtons();
});

document.getElementById('btn-roll-dice').onclick = () => {
  socket.emit('ludo_roll', { roomId: currentRoomId });
};

document.getElementById('btn-ludo-leave').onclick = () => {
  showScreen('menu');
  socket.emit('get_points');
};

function renderLudoTrack() {
  const trackEl = document.getElementById('ludo-track');
  trackEl.innerHTML = '';
  const length = ludoState.trackLength || 52;

  const cellEls = [];
  for (let i = 0; i < length; i++) {
    const cell = document.createElement('div');
    cell.className = 'ludo-cell';
    trackEl.appendChild(cell);
    cellEls.push(cell);
  }

  ludoState.players.forEach((p) => {
    p.tokens.forEach((steps, tokenIdx) => {
      if (steps === -1 || steps >= ludoState.finishSteps) return;
      const globalPos = (p.offset + steps) % length;
      const tokenEl = document.createElement('div');
      tokenEl.className = 'ludo-token ' + COLOR_CLASS[p.color];
      tokenEl.textContent = tokenIdx + 1;
      cellEls[globalPos].appendChild(tokenEl);
    });
  });
}

function renderLudoTokenButtons() {
  const wrap = document.getElementById('ludo-tokens');
  wrap.innerHTML = '';
  const me = ludoState.players.find((p) => p.userId === myUserId);
  if (!me) return;

  const isMyTurn = ludoState.turn === myUserId;

  me.tokens.forEach((steps, idx) => {
    const btn = document.createElement('button');
    btn.className = 'ludo-token-btn ' + COLOR_CLASS[me.color];
    const finished = steps >= ludoState.finishSteps;
    const inBase = steps === -1;
    btn.textContent = finished ? '✓' : inBase ? 'Base' : String(idx + 1);

    let canMove = false;
    if (isMyTurn && ludoLastDice != null && !finished) {
      canMove = inBase ? ludoLastDice === 6 : true;
    }
    btn.disabled = !canMove;
    btn.onclick = () => {
      socket.emit('ludo_move', { roomId: currentRoomId, tokenIndex: idx });
    };
    wrap.appendChild(btn);
  });
             }
