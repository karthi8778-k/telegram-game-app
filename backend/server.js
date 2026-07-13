require('dotenv').config();
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { Telegraf } = require('telegraf');
const { Chess } = require('chess.js');

const db = require('./db');
const LudoGame = require('./games/ludoGame');

const BOT_TOKEN = process.env.BOT_TOKEN;
const FRONTEND_URL = process.env.FRONTEND_URL || '*';
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN missing. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('Telegram Game Backend is running.'));
app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: FRONTEND_URL } });

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply('Welcome! Tap below to play Ludo or Chess and earn points.', {
    reply_markup: {
      inline_keyboard: [[{ text: '🎮 Play Games', web_app: { url: FRONTEND_URL } }]],
    },
  });
});

bot.command('points', (ctx) => {
  const userId = String(ctx.from.id);
  const points = db.getPoints(userId);
  ctx.reply(`⭐ Your points: ${points}`);
});

bot.command('leaderboard', (ctx) => {
  const top = db.getLeaderboard(10);
  if (top.length === 0) return ctx.reply('No games played yet.');
  const lines = top.map((u, i) => `${i + 1}. ${u.name || u.userId} — ${u.points} pts`);
  ctx.reply(['🏆 Leaderboard', ...lines].join('\n'));
});

// IMPORTANT: catch launch errors so a Telegram polling conflict (409)
// does NOT crash the whole server. The game server (Express + Socket.io)
// must keep running even if the bot itself fails to start.
bot
  .launch({ dropPendingUpdates: true })
  .then(() => console.log('Bot launched'))
  .catch((err) => {
    console.error('Bot launch failed (server will still run):', err.message);
    console.error('This usually means the same BOT_TOKEN is already running elsewhere.');
    console.error('Check: other Railway services, Render, or a local `npm start` using the same token.');
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Extra safety net: never let an unexpected error silently kill the process.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (server will still run):', err);
});

// ---- Telegram WebApp initData verification ----
// This proves the request really came from Telegram for a real user,
// so nobody can fake points by calling the server directly.
function verifyInitData(initData) {
  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');

    const pairs = [];
    for (const [key, value] of urlParams.entries()) pairs.push(`${key}=${value}`);
    pairs.sort();
    const dataCheckString = pairs.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (computedHash !== hash) return null;

    const userStr = urlParams.get('user');
    return userStr ? JSON.parse(userStr) : null;
  } catch (e) {
    return null;
  }
}

// ---- Matchmaking + game rooms ----
const queues = { chess: [], ludo: [] };
const rooms = {}; // roomId -> room state

io.on('connection', (socket) => {
  socket.on('auth', (initData) => {
    const user = verifyInitData(initData);
    if (!user) {
      socket.emit('auth_error', 'Invalid Telegram data. Open this app from Telegram.');
      return;
    }
    socket.userId = String(user.id);
    socket.userName = user.first_name || 'Player';
    db.initUser(socket.userId, socket.userName);
    socket.emit('auth_success', { user, points: db.getPoints(socket.userId) });
  });

  socket.on('get_points', () => {
    if (!socket.userId) return;
    socket.emit('points_update', { points: db.getPoints(socket.userId) });
  });

  socket.on('join_queue', ({ game }) => {
    if (!socket.userId) return socket.emit('auth_error', 'Not authenticated yet.');
    if (!['chess', 'ludo'].includes(game)) return;
    if (queues[game].some((s) => s.id === socket.id)) return;
    queues[game].push(socket);
    socket.emit('queue_joined', { game });
    tryMatch(game);
  });

  socket.on('leave_queue', ({ game }) => {
    if (!queues[game]) return;
    queues[game] = queues[game].filter((s) => s.id !== socket.id);
  });

  // ---- Chess events ----
  socket.on('chess_move', ({ roomId, from, to, promotion }) => {
    const room = rooms[roomId];
    if (!room || room.type !== 'chess') return;
    if (room.turn !== socket.userId) return socket.emit('invalid_move', 'Not your turn');

    let move;
    try {
      move = room.chess.move({ from, to, promotion: promotion || 'q' });
    } catch (e) {
      move = null;
    }
    if (!move) return socket.emit('invalid_move', 'Illegal move');

    const opponent = room.players.find((p) => p.userId !== socket.userId);
    room.turn = opponent.userId;

    io.to(roomId).emit('chess_update', {
      fen: room.chess.fen(),
      lastMove: { from, to },
      turn: room.turn,
    });

    if (room.chess.isGameOver()) {
      let winnerId = null;
      if (room.chess.isCheckmate()) winnerId = socket.userId;
      endGame(roomId, winnerId, room.players.map((p) => p.userId));
    }
  });

  // ---- Ludo events ----
  socket.on('ludo_roll', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.type !== 'ludo') return;
    if (room.game.currentTurnUserId() !== socket.userId) return;

    const result = room.game.rollDice();
    io.to(roomId).emit('ludo_dice', result);

    if (!room.game.hasValidMoves()) {
      const next = room.game.nextTurn();
      io.to(roomId).emit('ludo_turn', { turn: next });
    }
  });

  socket.on('ludo_move', ({ roomId, tokenIndex }) => {
    const room = rooms[roomId];
    if (!room || room.type !== 'ludo') return;
    if (room.game.currentTurnUserId() !== socket.userId) return;

    const result = room.game.moveToken(socket.userId, tokenIndex);
    if (!result.ok) return socket.emit('invalid_move', result.reason);

    io.to(roomId).emit('ludo_update', room.game.getState());

    if (result.winnerId) {
      endGame(roomId, result.winnerId, room.players);
    } else {
      const next = room.game.nextTurn();
      io.to(roomId).emit('ludo_turn', { turn: next });
    }
  });

  socket.on('disconnect', () => {
    for (const g of ['chess', 'ludo']) {
      queues[g] = queues[g].filter((s) => s.id !== socket.id);
    }
  });
});

function tryMatch(game) {
  while (queues[game].length >= 2) {
    const s1 = queues[game].shift();
    const s2 = queues[game].shift();
    const roomId = `${game}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    s1.join(roomId);
    s2.join(roomId);

    if (game === 'chess') {
      const chess = new Chess();
      rooms[roomId] = {
        type: 'chess',
        chess,
        players: [
          { socketId: s1.id, userId: s1.userId, color: 'w' },
          { socketId: s2.id, userId: s2.userId, color: 'b' },
        ],
        turn: s1.userId,
      };
      s1.emit('match_found', { roomId, game, color: 'w', opponent: s2.userName, fen: chess.fen(), turn: s1.userId });
      s2.emit('match_found', { roomId, game, color: 'b', opponent: s1.userName, fen: chess.fen(), turn: s1.userId });
    } else if (game === 'ludo') {
      const ludoGame = new LudoGame([s1.userId, s2.userId]);
      rooms[roomId] = { type: 'ludo', game: ludoGame, players: [s1.userId, s2.userId] };
      const state = ludoGame.getState();
      s1.emit('match_found', { roomId, game, opponent: s2.userName, state, turn: ludoGame.currentTurnUserId() });
      s2.emit('match_found', { roomId, game, opponent: s1.userName, state, turn: ludoGame.currentTurnUserId() });
    }
  }
}

function endGame(roomId, winnerId, participantIds) {
  const room = rooms[roomId];
  if (!room) return;

  if (winnerId) {
    const newTotal = db.addPoints(winnerId, 10);
    bot.telegram.sendMessage(winnerId, `🏆 You won! +10 points. Total: ${newTotal}`).catch(() => {});
  }
  io.to(roomId).emit('game_over', { winnerId });
  delete rooms[roomId];
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
