const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { GameManager, ARENA_W, ARENA_H, TRAPDOORS, DOG_PEN, JUMP_MS } = require('./rooms');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 2e6 // allow custom question JSON uploads up to ~2MB
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const manager = new GameManager(io);
setInterval(() => manager.sweep(), 30000);

// Reconnect lookup: token -> {code, playerId}
const tokenIndex = new Map();

function sanitizeConfig(input, current) {
  const cfg = { ...current };
  if (input.durationSec) cfg.durationSec = Math.max(30, Math.min(3600, Number(input.durationSec)));
  if (input.answerTimeSec) cfg.answerTimeSec = Math.max(3, Math.min(120, Number(input.answerTimeSec)));
  if (input.questionCount) cfg.questionCount = Math.max(1, Math.min(100, Number(input.questionCount)));
  if (input.questionSet === 'default' || input.questionSet === 'custom') cfg.questionSet = input.questionSet;
  if (typeof input.bearTraps === 'boolean') cfg.bearTraps = input.bearTraps;
  return cfg;
}

io.on('connection', socket => {
  let joinedRoomCode = null;
  let playerId = null;
  let isHost = false;

  socket.on('host:createRoom', (payload = {}) => {
    const room = manager.createRoom(socket.id);
    room.config = sanitizeConfig(payload, room.config);
    joinedRoomCode = room.code;
    isHost = true;
    socket.join(room.code);
    socket.emit('host:roomCreated', {
      code: room.code,
      config: room.config
    });
  });

  socket.on('host:uploadQuestions', (payload = {}) => {
    const room = manager.getRoom(joinedRoomCode);
    if (!room || !isHost || room.state !== 'lobby') return;
    try {
      const list = Array.isArray(payload.questions) ? payload.questions : [];
      const valid = list.filter(q =>
        q && typeof q.q === 'string' &&
        q.options && typeof q.options.A === 'string' &&
        typeof q.options.B === 'string' && typeof q.options.C === 'string' &&
        ['A', 'B', 'C'].includes(q.correct)
      );
      if (valid.length === 0) {
        socket.emit('host:error', { message: 'No valid questions found in upload.' });
        return;
      }
      room.customQuestions = valid;
      room.config.questionSet = 'custom';
      socket.emit('host:questionsUploaded', { count: valid.length });
      io.to(room.code).emit('room:config', room.config);
    } catch (e) {
      socket.emit('host:error', { message: 'Could not parse question file.' });
    }
  });

  socket.on('host:rejoin', ({ code } = {}) => {
    const room = manager.getRoom(code);
    if (!room) { socket.emit('host:error', { message: 'Room not found.' }); return; }
    room.hostSocketId = socket.id;
    room.hostConnected = true;
    joinedRoomCode = room.code;
    isHost = true;
    socket.join(room.code);
    socket.emit('host:roomState', publicRoomState(room));
  });

  socket.on('host:startGame', (payload = {}) => {
    const room = manager.getRoom(joinedRoomCode);
    if (!room || !isHost || room.state !== 'lobby') return;
    if (payload.config) room.config = sanitizeConfig(payload.config, room.config);
    const readyCount = Array.from(room.players.values()).filter(p => p.connected).length;
    if (readyCount < 2) {
      socket.emit('host:error', { message: 'Need at least 2 players to start.' });
      return;
    }
    room.start(io);
    io.to(room.code).emit('game:started', { config: room.config });
  });

  socket.on('host:endGame', () => {
    const room = manager.getRoom(joinedRoomCode);
    if (!room || !isHost) return;
    if (room.state === 'lobby') return;
    room.manualEnd = true;
  });

  socket.on('host:rematch', () => {
    const room = manager.getRoom(joinedRoomCode);
    if (!room || !isHost || room.state !== 'ended') return;
    room.resetForRematch();
    io.to(room.code).emit('game:rematch', {
      config: room.config,
      players: room.getPlayersPublic()
    });
  });

  socket.on('player:join', ({ code, name, color } = {}) => {
    const room = manager.getRoom(code);
    if (!room) { socket.emit('player:error', { message: 'Room not found.' }); return; }
    if (room.state !== 'lobby') { socket.emit('player:error', { message: 'Game already in progress.' }); return; }
    const player = room.addPlayer(name, color);
    player.socketId = socket.id;
    tokenIndex.set(player.token, { code: room.code, playerId: player.id });
    joinedRoomCode = room.code;
    playerId = player.id;
    socket.join(room.code);
    socket.emit('player:joined', {
      code: room.code,
      playerId: player.id,
      token: player.token,
      config: room.config
    });
    io.to(room.code).emit('room:players', room.getPlayersPublic());
  });

  socket.on('player:rejoin', ({ token } = {}) => {
    const ref = tokenIndex.get(token);
    if (!ref) { socket.emit('player:error', { message: 'Session expired.' }); return; }
    const room = manager.getRoom(ref.code);
    if (!room) { socket.emit('player:error', { message: 'Room no longer exists.' }); return; }
    const player = room.players.get(ref.playerId);
    if (!player) { socket.emit('player:error', { message: 'Player not found.' }); return; }
    player.connected = true;
    player.socketId = socket.id;
    joinedRoomCode = room.code;
    playerId = player.id;
    socket.join(room.code);
    socket.emit('player:rejoined', {
      code: room.code,
      playerId: player.id,
      token: player.token,
      state: room.state,
      config: room.config,
      you: {
        name: player.name, color: player.color, alive: player.alive, isGhost: player.isGhost
      },
      currentQuestion: room.state !== 'lobby' && room.currentQuestion ? {
        index: room.currentQuestionIndex,
        total: room.questions.length,
        q: room.currentQuestion.q,
        options: room.currentQuestion.options,
        endsAt: room.phaseEndsAt
      } : null
    });
    io.to(room.code).emit('room:players', room.getPlayersPublic());
  });

  socket.on('player:ready', (readyState) => {
    const room = manager.getRoom(joinedRoomCode);
    if (!room || !playerId) return;
    const player = room.players.get(playerId);
    if (!player) return;
    player.ready = !!readyState;
    io.to(room.code).emit('room:players', room.getPlayersPublic());
  });

  socket.on('player:input', (input = {}) => {
    const room = manager.getRoom(joinedRoomCode);
    if (!room || !playerId) return;
    const player = room.players.get(playerId);
    if (!player || !player.connected) return;
    player.input = {
      up: !!input.up, down: !!input.down, left: !!input.left, right: !!input.right
    };
  });

  socket.on('player:jump', () => {
    const room = manager.getRoom(joinedRoomCode);
    if (!room || !playerId) return;
    const player = room.players.get(playerId);
    if (!player) return;
    player.jumpUntil = Date.now() + JUMP_MS;
  });

  socket.on('disconnect', () => {
    const room = manager.getRoom(joinedRoomCode);
    if (!room) return;
    if (isHost) {
      room.hostConnected = false;
    } else if (playerId) {
      const player = room.players.get(playerId);
      if (player) {
        player.connected = false;
        player.input = { up: false, down: false, left: false, right: false };
      }
      io.to(room.code).emit('room:players', room.getPlayersPublic());
    }
  });
});

function publicRoomState(room) {
  return {
    code: room.code,
    state: room.state,
    config: room.config,
    players: room.getPlayersPublic(),
    arena: { w: ARENA_W, h: ARENA_H, trapdoors: TRAPDOORS, dogPen: DOG_PEN },
    currentQuestion: room.currentQuestion ? {
      index: room.currentQuestionIndex,
      total: room.questions.length,
      q: room.currentQuestion.q,
      options: room.currentQuestion.options,
      endsAt: room.phaseEndsAt
    } : null
  };
}

app.get('/api/arena', (req, res) => {
  res.json({ w: ARENA_W, h: ARENA_H, trapdoors: TRAPDOORS, dogPen: DOG_PEN });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Trivia Survival running on http://localhost:${PORT}`));
