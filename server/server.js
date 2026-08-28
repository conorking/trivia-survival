const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { Server } = require('socket.io');
const {
  GameManager, ARENA_W, ARENA_H, TRAPDOORS, DOG_PEN,
  DEFAULT_TUNING, TUNING_BOUNDS, getTuning, setTuning, resetTuning
} = require('./rooms');

// Debug/sandbox mode (npm run debug, or TS_DEBUG=1). Off for a normal `npm start`:
// the debug socket handlers below aren't registered and the host UI stays hidden.
const DEBUG = process.argv.includes('--debug') || process.env.TS_DEBUG === '1';
if (DEBUG) console.log('[debug] sandbox mode ENABLED - bots, solo start, phase/tuning controls available on the host page');

const app = express();
app.set('trust proxy', true); // correct req.ip/protocol when run behind Caddy/nginx/etc.
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 2e6, // allow custom question JSON uploads up to ~2MB
  // A genuine, explicit leave ("back to menu", tab close) is detected instantly via the
  // clients' own socket.disconnect() + pagehide calls below, so this timeout only needs to
  // catch a socket that's actually gone dark - it doesn't need to be aggressive, and being
  // too aggressive was actively harmful: a merely backgrounded/throttled mobile tab can miss
  // a 5s ping window and get dropped even though the player never left, which read as
  // "desync switching tabs" (see the reconnect re-attach handlers below - the other half of
  // that fix).
  pingInterval: 10000,
  pingTimeout: 20000
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const manager = new GameManager(io);
const DISCONNECT_GRACE_MS = 30000; // lobby/ended only - see Room.pruneOffline
const REMATCH_READY_MIN = 2;
const REMATCH_COUNTDOWN_MS = 6000;

// Periodically sweeps abandoned rooms, and (independently) drops any player who's been
// disconnected for a while in a room that isn't mid-round - see Room.pruneOffline for why
// this never touches an active round.
setInterval(() => {
  manager.sweep();
  for (const room of manager.rooms.values()) {
    const removed = room.pruneOffline(DISCONNECT_GRACE_MS);
    if (removed.length) {
      for (const p of removed) tokenIndex.delete(p.token);
      io.to(room.code).emit('room:players', room.getPlayersPublic());
    }
  }
}, 10000);

// Reconnect lookup: token -> {code, playerId}
const tokenIndex = new Map();

function sanitizeConfig(input, current) {
  const cfg = { ...current };
  if (input.answerTimeSec) cfg.answerTimeSec = Math.max(3, Math.min(120, Number(input.answerTimeSec)));
  if (input.questionCount) cfg.questionCount = Math.max(1, Math.min(400, Number(input.questionCount)));
  if (['default', 'custom', 'webdev', 'hard'].includes(input.questionSet)) cfg.questionSet = input.questionSet;
  if (typeof input.difficultyRamp === 'boolean') cfg.difficultyRamp = input.difficultyRamp;
  if (typeof input.bearTraps === 'boolean') cfg.bearTraps = input.bearTraps;
  if (['off', 'low', 'high'].includes(input.dogLunge)) cfg.dogLunge = input.dogLunge;
  if (typeof input.dynamicCellScaling === 'boolean') cfg.dynamicCellScaling = input.dynamicCellScaling;
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
      config: room.config,
      debug: DEBUG,
      tuning: DEBUG ? getTuning() : null,
      tuningMeta: DEBUG ? { defaults: DEFAULT_TUNING, bounds: TUNING_BOUNDS } : null
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
    // If the host was also playing (host:joinAsPlayer) before this reconnect, re-attach that
    // player too - same idea as a normal player:rejoin, just keyed off the room instead of a
    // client-supplied token.
    if (room.hostPlayerId && room.players.has(room.hostPlayerId)) {
      const hp = room.players.get(room.hostPlayerId);
      hp.connected = true;
      hp.socketId = socket.id;
      playerId = hp.id;
    }
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

  // Host cuts the full-screen question intro short (e.g. once they've read it aloud).
  socket.on('host:startAnswering', () => {
    const room = manager.getRoom(joinedRoomCode);
    if (!room || !isHost || room.state !== 'intro') return;
    room.beginAnswering(io, Date.now());
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
    startRematch(room);
  });

  // ---- Debug / sandbox handlers (only registered when the server runs with --debug) ----
  if (DEBUG) {
    const debugRoom = () => {
      const room = manager.getRoom(joinedRoomCode);
      return (room && isHost) ? room : null;
    };

    // Joins the current socket to the room as a player (same as host:joinAsPlayer) - used
    // by debug:sandboxStart's "control an avatar" option. No-ops if already playing.
    const joinHostAsPlayer = (room, name, color) => {
      if (playerId && room.players.has(playerId)) return;
      const player = room.addPlayer(name || 'Host', color);
      player.socketId = socket.id;
      tokenIndex.set(player.token, { code: room.code, playerId: player.id });
      room.hostPlayerId = player.id;
      playerId = player.id;
      socket.emit('host:joinedAsPlayer', {
        playerId: player.id,
        token: player.token,
        arena: { w: ARENA_W, h: ARENA_H, trapdoors: room.trapdoors, dogPen: DOG_PEN }
      });
    };

    socket.on('debug:addBots', ({ count = 1 } = {}) => {
      const room = debugRoom();
      if (!room || room.state !== 'lobby') return;
      const n = Math.max(1, Math.min(50, Number(count) || 1));
      for (let i = 0; i < n; i++) room.addBot();
      io.to(room.code).emit('room:players', room.getPlayersPublic());
    });

    socket.on('debug:removeBots', ({ count } = {}) => {
      const room = debugRoom();
      if (!room) return;
      room.removeBots(count == null ? Infinity : Math.max(1, Number(count) || 1));
      io.to(room.code).emit('room:players', room.getPlayersPublic());
    });

    socket.on('debug:setBotAccuracy', ({ value } = {}) => {
      const room = debugRoom();
      if (!room) return;
      room.botAccuracy = Math.max(0, Math.min(1, Number(value)));
    });

    socket.on('debug:sandboxStart', ({ count = 5, config, joinAsPlayer, name, color } = {}) => {
      const room = debugRoom();
      if (!room || room.state !== 'lobby') return;
      if (config) room.config = sanitizeConfig(config, room.config);
      const want = Math.max(0, Math.min(50, Number(count) || 0));
      const have = Array.from(room.players.values()).filter(p => p.isBot).length;
      for (let i = have; i < want; i++) room.addBot();
      if (joinAsPlayer) joinHostAsPlayer(room, name, color);
      io.to(room.code).emit('room:players', room.getPlayersPublic());
      room.start(io);
      io.to(room.code).emit('game:started', { config: room.config });
    });

    socket.on('debug:startGame', ({ config } = {}) => {
      const room = debugRoom();
      if (!room || room.state !== 'lobby') return;
      if (config) room.config = sanitizeConfig(config, room.config);
      room.start(io);
      io.to(room.code).emit('game:started', { config: room.config });
    });

    // Ends the current phase immediately. Setting phaseEndsAt/hardTimeoutAt to now makes
    // the next tick fire whichever transition that phase is waiting on (and forces the
    // dog chase to wrap, since 'resolve' has no phaseEndsAt-gated exit of its own).
    socket.on('debug:skipPhase', () => {
      const room = debugRoom();
      if (!room || room.state === 'lobby' || room.state === 'ended') return;
      room.phaseEndsAt = Date.now();
      room.hardTimeoutAt = Date.now();
    });

    socket.on('debug:replayQuestion', () => {
      const room = debugRoom();
      if (!room || room.state === 'lobby') return;
      room.debugReplayRound(io);
    });

    socket.on('debug:gotoQuestion', ({ index = 0 } = {}) => {
      const room = debugRoom();
      if (!room || room.state === 'lobby') return;
      room.debugReplayRound(io, Number(index) || 0);
    });

    socket.on('debug:endGame', () => {
      const room = debugRoom();
      if (!room || room.state === 'lobby') return;
      room.manualEnd = true;
    });

    socket.on('debug:killMe', () => {
      const room = debugRoom();
      if (!room || !playerId) return;
      const p = room.players.get(playerId);
      if (!p) return;
      p.alive = false; p.isGhost = true; p.cagedAt = null;
      io.to(room.code).emit('room:players', room.getPlayersPublic());
    });

    socket.on('debug:reviveMe', () => {
      const room = debugRoom();
      if (!room || !playerId) return;
      const p = room.players.get(playerId);
      if (!p) return;
      p.alive = true; p.isGhost = false; p.cagedAt = null;
      io.to(room.code).emit('room:players', room.getPlayersPublic());
    });

    socket.on('debug:reviveAll', () => {
      const room = debugRoom();
      if (!room) return;
      for (const p of room.players.values()) {
        p.alive = true; p.isGhost = false; p.cagedAt = null;
        if (p.botState) p.botState.decidedForIndex = -1;
      }
      io.to(room.code).emit('room:players', room.getPlayersPublic());
    });

    socket.on('debug:setTuning', ({ patch } = {}) => {
      if (!isHost || !patch) return;
      const vals = setTuning(patch);
      io.emit('debug:tuning', vals); // global - every debug host page stays in sync
    });

    socket.on('debug:resetTuning', () => {
      if (!isHost) return;
      io.emit('debug:tuning', resetTuning());
    });
  }

  socket.on('player:roomInfo', ({ code } = {}) => {
    const room = manager.getRoom(code);
    if (!room) { socket.emit('player:error', { message: 'Room not found.' }); return; }
    socket.emit('player:roomInfo', {
      code: room.code,
      state: room.state,
      players: room.getPlayersPublic().filter(p => p.connected)
    });
  });

  socket.on('player:rematch', () => {
    const room = manager.getRoom(joinedRoomCode);
    if (!room || !playerId) return;
    if (room.state === 'ended') {
      startRematch(room, playerId);
    } else if (room.state === 'lobby' && room.awaitingRematchStart) {
      // Someone else already triggered the reset - this just registers this player as ready
      // for it too (e.g. a second person also hitting "Play Another Round" on their own
      // end screen after the lobby's already showing).
      const player = room.players.get(playerId);
      if (player) player.ready = true;
      io.to(room.code).emit('room:players', room.getPlayersPublic());
    } else {
      return;
    }
    maybeStartRematchCountdown(room);
  });

  socket.on('host:joinAsPlayer', ({ name, color } = {}) => {
    const room = manager.getRoom(joinedRoomCode);
    if (!room || !isHost || room.state !== 'lobby') return;
    if (playerId && room.players.has(playerId)) return; // already playing
    const player = room.addPlayer(name || 'Host', color);
    player.socketId = socket.id;
    tokenIndex.set(player.token, { code: room.code, playerId: player.id });
    room.hostPlayerId = player.id;
    playerId = player.id;
    socket.emit('host:joinedAsPlayer', {
      playerId: player.id,
      token: player.token,
      arena: { w: ARENA_W, h: ARENA_H, trapdoors: room.trapdoors, dogPen: DOG_PEN }
    });
    io.to(room.code).emit('room:players', room.getPlayersPublic());
  });

  socket.on('host:leavePlayer', () => {
    const room = manager.getRoom(joinedRoomCode);
    if (!room || !isHost || !playerId) return;
    const player = room.players.get(playerId);
    if (player) {
      if (room.state === 'lobby') {
        room.players.delete(playerId);
        tokenIndex.delete(player.token);
      } else {
        // Mid-round: leave them exactly as a normal player who disconnected mid-round would
        // be left - frozen in place, still vulnerable - rather than deleting them outright.
        player.connected = false;
        player.disconnectedAt = Date.now();
        player.input = { dx: 0, dy: 0 };
      }
    }
    if (room.hostPlayerId === playerId) room.hostPlayerId = null;
    playerId = null;
    io.to(room.code).emit('room:players', room.getPlayersPublic());
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
      config: room.config,
      arena: { w: ARENA_W, h: ARENA_H, trapdoors: room.trapdoors, dogPen: DOG_PEN }
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
    // A QR rejoin commonly creates a replacement tab before the old tab has closed.
    // Detach the old socket, and make its disconnect handler harmless below.
    if (player.socketId && player.socketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(player.socketId);
      if (oldSocket) oldSocket.disconnect(true);
    }
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
      arena: { w: ARENA_W, h: ARENA_H, trapdoors: room.trapdoors, dogPen: DOG_PEN },
      you: {
        name: player.name, color: player.color, alive: player.alive, isGhost: player.isGhost
      },
      currentQuestion: room.state !== 'lobby' && room.currentQuestion ? {
        index: room.currentQuestionIndex,
        total: room.questions.length,
        q: room.currentQuestion.q,
        options: room.currentQuestion.options,
        phase: room.state,
        introEndsAt: room.state === 'intro' ? room.phaseEndsAt : 0,
        endsAt: room.phaseEndsAt,
        trapdoors: room.trapdoors
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
    maybeStartRematchCountdown(room);
  });

  socket.on('player:input', (input = {}) => {
    const room = manager.getRoom(joinedRoomCode);
    if (!room || !playerId) return;
    const player = room.players.get(playerId);
    if (!player || !player.connected) return;
    const clampAxis = (v) => Math.max(-1, Math.min(1, Number(v) || 0));
    player.input = { dx: clampAxis(input.dx), dy: clampAxis(input.dy) };
  });

  socket.on('player:jump', () => {
    const room = manager.getRoom(joinedRoomCode);
    if (!room || !playerId) return;
    const player = room.players.get(playerId);
    if (!player) return;
    room.attemptJump(player, Date.now());
  });

  socket.on('disconnect', () => {
    const room = manager.getRoom(joinedRoomCode);
    if (!room) return;
    // isHost and playerId aren't mutually exclusive - a host who's also playing (see
    // host:joinAsPlayer) needs both of these to run, not just one.
    if (isHost) room.hostConnected = false;
    if (playerId) {
      const player = room.players.get(playerId);
      // Do not let an obsolete tab mark a replacement connection offline.
      if (player && player.socketId === socket.id) {
        player.connected = false;
        player.disconnectedAt = Date.now();
        player.input = { dx: 0, dy: 0 };
      }
      io.to(room.code).emit('room:players', room.getPlayersPublic());
      maybeStartRematchCountdown(room);
    }
  });

  // triggeringPlayerId (optional): the player whose "Play Another Round" click caused this,
  // marked ready immediately so they don't also have to hit Ready in the lobby that follows.
  function startRematch(room, triggeringPlayerId) {
    room.resetForRematch();
    const removed = room.pruneOffline(0); // they had the whole prior round to reconnect
    for (const p of removed) tokenIndex.delete(p.token);
    if (triggeringPlayerId) {
      const p = room.players.get(triggeringPlayerId);
      if (p) p.ready = true;
    }
    io.to(room.code).emit('game:rematch', {
      config: room.config,
      players: room.getPlayersPublic()
    });
  }

  // Auto-starts the next round once enough players are ready in a post-rematch lobby -
  // never in a brand-new room's first lobby (awaitingRematchStart guards that), since the
  // host may still be actively configuring there.
  function maybeStartRematchCountdown(room) {
    if (!room.awaitingRematchStart || room.state !== 'lobby') return;
    const readyCount = Array.from(room.players.values()).filter(p => p.connected && p.ready).length;
    if (readyCount >= REMATCH_READY_MIN) {
      if (room.rematchTimer) return; // already counting down
      const endsAt = Date.now() + REMATCH_COUNTDOWN_MS;
      io.to(room.code).emit('game:rematchCountdown', { endsAt });
      room.rematchTimer = setTimeout(() => {
        room.rematchTimer = null;
        const stillReady = Array.from(room.players.values()).filter(p => p.connected && p.ready).length;
        if (room.state === 'lobby' && room.awaitingRematchStart && stillReady >= REMATCH_READY_MIN) {
          room.start(io);
          io.to(room.code).emit('game:started', { config: room.config });
        }
      }, REMATCH_COUNTDOWN_MS);
    } else if (room.rematchTimer) {
      room.clearRematchTimer();
      io.to(room.code).emit('game:rematchCountdown', { endsAt: null });
    }
  }
});

function publicRoomState(room) {
  return {
    code: room.code,
    state: room.state,
    config: room.config,
    players: room.getPlayersPublic(),
    arena: { w: ARENA_W, h: ARENA_H, trapdoors: room.trapdoors, dogPen: DOG_PEN },
    currentQuestion: room.currentQuestion ? {
      index: room.currentQuestionIndex,
      total: room.questions.length,
      q: room.currentQuestion.q,
      options: room.currentQuestion.options,
      phase: room.state,
      introEndsAt: room.state === 'intro' ? room.phaseEndsAt : 0,
      endsAt: room.phaseEndsAt,
      trapdoors: room.trapdoors
    } : null,
    hostPlayer: (room.hostPlayerId && room.players.has(room.hostPlayerId))
      ? { id: room.hostPlayerId, token: room.players.get(room.hostPlayerId).token }
      : null,
    debug: DEBUG,
    tuning: DEBUG ? getTuning() : null,
    tuningMeta: DEBUG ? { defaults: DEFAULT_TUNING, bounds: TUNING_BOUNDS } : null
  };
}

app.get('/api/arena', (req, res) => {
  res.json({ w: ARENA_W, h: ARENA_H, trapdoors: TRAPDOORS, dogPen: DOG_PEN });
});

app.get('/api/debug-enabled', (req, res) => {
  res.json({ enabled: DEBUG });
});

// Lets the host page swap a localhost/127.0.0.1 origin for a real LAN address, so the
// QR code / join link it builds actually works for other devices on the same wifi
// (scanning a "localhost" URL from another phone would just point back at that phone).
function getLanIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

app.get('/api/lan-info', (req, res) => {
  res.json({ ips: getLanIPs(), port: PORT });
});

// Ad-hoc internet exposure (see README "Playing over the internet"): when the host runs
// `npm run tunnel:ngrok` alongside this server, ngrok exposes its own local admin API on
// 127.0.0.1:4040 listing the public URL it assigned. Polling that here (server-side, so
// it's a plain localhost-to-localhost request with no CORS/mixed-content concerns) lets
// the host page auto-swap the join link/QR to the real public tunnel URL instead of
// requiring the host to notice and manually copy it from ngrok's own console output.
// Resolves to null (fast) if ngrok isn't running - this is a best-effort convenience,
// not something callers should treat as authoritative.
function getNgrokPublicUrl() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 4040, path: '/api/tunnels', timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const tunnels = JSON.parse(body).tunnels || [];
          const best = tunnels.find(t => t.proto === 'https') || tunnels[0];
          resolve(best ? best.public_url : null);
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

app.get('/api/tunnel-info', async (req, res) => {
  res.json({ url: await getNgrokPublicUrl() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Trivia Survival running on http://localhost:${PORT}`));
