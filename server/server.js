const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { Server } = require('socket.io');
const {
  GameManager, ARENA_W, ARENA_H, TRAPDOORS, DOG_PEN,
  DEFAULT_TUNING, TUNING_BOUNDS, getTuning, setTuning, resetTuning,
  QUESTION_CATEGORIES
} = require('./rooms');
const analytics = require('./analytics');

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
const HOST_LEAVE_GRACE_MS = 45000; // host reconnect grace before a silent disconnect counts as "left for good"

// Reconnect lookup: token -> {code, playerId}
const tokenIndex = new Map();

// Ends a room for everyone - either the host explicitly left (host:leaveRoom) or has
// been disconnected long enough (HOST_LEAVE_GRACE_MS, checked in the sweep interval
// below) that they're not coming back. Every connected client gets kicked to the main
// menu (room:closed) and the room + its players' reconnect tokens are wiped so there's
// nothing left to rejoin.
function closeRoomForHostLeave(room, reason) {
  io.to(room.code).emit('room:closed', { reason });
  for (const p of room.players.values()) tokenIndex.delete(p.token);
  manager.removeRoom(room.code);
}

// Periodically sweeps abandoned rooms, closes any room whose host has been gone past
// the grace period, and (independently) drops any player who's been disconnected for a
// while in a room that isn't mid-round - see Room.pruneOffline for why that part never
// touches an active round.
setInterval(() => {
  manager.sweep();
  const now = Date.now();
  for (const room of manager.rooms.values()) {
    if (!room.hostConnected && room.hostDisconnectedAt && now - room.hostDisconnectedAt >= HOST_LEAVE_GRACE_MS) {
      closeRoomForHostLeave(room, 'host_left');
      continue;
    }
    const removed = room.pruneOffline(DISCONNECT_GRACE_MS);
    if (removed.length) {
      for (const p of removed) tokenIndex.delete(p.token);
      io.to(room.code).emit('room:players', room.getPlayersPublic());
    }
  }
}, 10000);

const VALID_QUESTION_CATEGORIES = Object.keys(QUESTION_CATEGORIES);

function sanitizeConfig(input, current) {
  const cfg = { ...current };
  if (input.answerTimeSec) cfg.answerTimeSec = Math.max(3, Math.min(120, Number(input.answerTimeSec)));
  if (input.questionCount) cfg.questionCount = Math.max(1, Math.min(400, Number(input.questionCount)));
  // Multi-select: at least one valid category required, invalid/unknown keys are
  // dropped rather than rejecting the whole selection. Falls back to the current
  // value (constructor default 'general') if nothing valid was sent.
  if (Array.isArray(input.questionSets)) {
    const picked = input.questionSets.filter(k => VALID_QUESTION_CATEGORIES.includes(k));
    if (picked.length) cfg.questionSets = picked;
  }
  if (typeof input.difficultyRamp === 'boolean') cfg.difficultyRamp = input.difficultyRamp;
  if (typeof input.bearTraps === 'boolean') cfg.bearTraps = input.bearTraps;
  if (['off', 'low', 'high'].includes(input.dogLunge)) cfg.dogLunge = input.dogLunge;
  if (typeof input.dynamicCellScaling === 'boolean') cfg.dynamicCellScaling = input.dynamicCellScaling;
  return cfg;
}

// Real client IP for the socket, if known - Cloudflare's cf-connecting-ip is the
// reliable one once traffic flows through the tunnel (engine.io's own handshake.address
// otherwise just reflects whatever's directly upstream, which behind a reverse proxy is
// the proxy itself, not the actual visitor). Falls back to the raw socket address for
// local/LAN testing where there's no Cloudflare in front at all.
function clientIp(socket) {
  return socket.handshake.headers['cf-connecting-ip'] || socket.handshake.address || 'unknown';
}

// Analytics only (see server/analytics.js) - stamps a freshly-added player with the
// device/country hints derived from the socket that joined them, so recordPlayerLeft can
// include them later. Never sent to any client (getPlayersPublic() doesn't include them).
function tagPlayerHints(player, socket) {
  player.deviceHint = analytics.deviceHintFromUA(socket.handshake.headers['user-agent']);
  player.country = analytics.countryFromHeaders(socket.handshake.headers);
}

io.on('connection', socket => {
  let joinedRoomCode = null;
  let playerId = null;
  let isHost = false;

  socket.on('host:createRoom', (payload = {}) => {
    // Unauthenticated and public-internet-reachable now - see server/analytics.js for
    // why this is rate-limited (the room itself, not just the log write, is the thing
    // being protected: each one gets its own tick loop).
    if (!analytics.allowRoomCreate(clientIp(socket))) {
      socket.emit('host:error', { message: 'Too many rooms created recently - please wait a bit and try again.' });
      return;
    }
    const room = manager.createRoom(socket.id);
    room.config = sanitizeConfig(payload, room.config);
    joinedRoomCode = room.code;
    isHost = true;
    socket.join(room.code);
    analytics.logEvent('room_created', {
      roomCode: room.code,
      hostDeviceHint: analytics.deviceHintFromUA(socket.handshake.headers['user-agent']),
      hostCountry: analytics.countryFromHeaders(socket.handshake.headers)
    });
    socket.emit('host:roomCreated', {
      code: room.code,
      config: room.config,
      debug: DEBUG,
      tuning: DEBUG ? getTuning() : null,
      tuningMeta: DEBUG ? { defaults: DEFAULT_TUNING, bounds: TUNING_BOUNDS } : null
    });
  });

  socket.on('host:rejoin', ({ code } = {}) => {
    const room = manager.getRoom(code);
    if (!room) { socket.emit('host:error', { message: 'Room not found.' }); return; }
    room.hostSocketId = socket.id;
    room.hostConnected = true;
    room.hostDisconnectedAt = 0;
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

  // Explicit "the host is leaving the room" signal (nav-away links in host.html, routed
  // through leaveRoom() in host.js rather than a plain link) - unlike a bare disconnect
  // (which might just be a reload/reconnect, see HOST_LEAVE_GRACE_MS), this always closes
  // the room immediately for everyone in it.
  socket.on('host:leaveRoom', () => {
    const room = manager.getRoom(joinedRoomCode);
    if (!room || !isHost) return;
    closeRoomForHostLeave(room, 'host_left');
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
      tagPlayerHints(player, socket);
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
      room.introHardCapAt = Date.now();
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
    tagPlayerHints(player, socket);
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
        room.removePlayer(playerId, 'left_lobby');
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
    tagPlayerHints(player, socket);
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
    const dx = clampAxis(input.dx), dy = clampAxis(input.dy);
    player.input = { dx, dy };
    // Analytics only - cheap one-time flag flip, first real movement proves this player
    // is actually trying the game, not just sitting in the lobby (see recordPlayerLeft).
    if (!player.playedActively && (dx !== 0 || dy !== 0)) player.playedActively = true;
  });

  socket.on('player:jump', () => {
    const room = manager.getRoom(joinedRoomCode);
    if (!room || !playerId) return;
    const player = room.players.get(playerId);
    if (!player) return;
    player.playedActively = true; // analytics only - see player:input above
    room.attemptJump(player, Date.now());
  });

  socket.on('disconnect', () => {
    const room = manager.getRoom(joinedRoomCode);
    if (!room) return;
    // isHost and playerId aren't mutually exclusive - a host who's also playing (see
    // host:joinAsPlayer) needs both of these to run, not just one.
    if (isHost) { room.hostConnected = false; room.hostDisconnectedAt = Date.now(); }
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

// Display metadata for the host's category picker - single source of truth
// (QUESTION_CATEGORIES in rooms.js) so host.html never hardcodes a category
// list that could drift out of sync with what's actually loaded. Only
// categories with real content are ever in QUESTION_CATEGORIES to begin
// with (see the comment there) - Politics/Science/New Zealand are follow-up
// work and simply don't appear here yet.
const CATEGORY_LABELS = {
  general: '🎲 General Trivia',
  'movies-tv': '🎬 Movies and TV shows',
  music: '🎵 Music',
  history: '🏛️ History',
  literature: '📚 Literature',
  webdev: '💻 Web Developer Trivia'
};
app.get('/api/question-categories', (req, res) => {
  res.json(Object.keys(QUESTION_CATEGORIES).map(key => ({
    key,
    label: CATEGORY_LABELS[key] || key,
    count: QUESTION_CATEGORIES[key].length
  })));
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

// ---- Analytics dashboard (see server/analytics.js) ----
// Gated behind ANALYTICS_TOKEN - if it's unset, both routes 404 rather than defaulting
// to open, so there's no way to accidentally ship this world-readable. 404 (not 401/403)
// on a bad/missing token too, so a prober can't even tell the route exists.
function checkAnalyticsToken(req, res) {
  const token = process.env.ANALYTICS_TOKEN;
  if (!token || req.query.token !== token) { res.status(404).end(); return false; }
  return true;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtMs(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function renderCountTable(counts, labelHeader) {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return '<p class="muted">No data yet.</p>';
  return `<table style="width:100%; border-collapse:collapse;">
    <tr><th style="text-align:left;">${esc(labelHeader)}</th><th style="text-align:right;">Count</th></tr>
    ${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td style="text-align:right;">${v}</td></tr>`).join('')}
  </table>`;
}

function renderDashboardHtml(summary) {
  const perDayRows = Object.entries(summary.roomsPerDay).sort().reverse().slice(0, 14);
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<title>Analytics - Trivia Survival</title>
<link rel="stylesheet" href="/css/style.css">
</head><body>
<div class="container">
  <div class="top-nav"><span class="pixel-title" style="font-family:'Press Start 2P',monospace; font-size:14px; color:var(--accent);">🐾 TRIVIA SURVIVAL ANALYTICS</span></div>

  <div class="card">
    <h2>Overview <span class="muted" style="font-size:var(--fs-vt-xs);">(last ${summary.windowDays} days)</span></h2>
    <div class="config-row">
      <div><label>Rooms created</label><div>${summary.roomsCreated}</div></div>
      <div><label>Games started</label><div>${summary.gamesStarted}</div></div>
      <div><label>Games ended</label><div>${summary.gamesEnded}</div></div>
    </div>
    <div class="config-row" style="margin-top:12px;">
      <div><label>Real players seen</label><div>${summary.realPlayersSeen}</div></div>
      <div><label>Actually played (not just joined)</label><div>${summary.realPlayersActive} (${100 - summary.bounceRatePct}%)</div></div>
      <div><label>Bounce rate</label><div>${summary.bounceRatePct}%</div></div>
    </div>
    <div class="config-row" style="margin-top:12px;">
      <div><label>Avg session (active players)</label><div>${fmtMs(summary.avgSessionMs)}</div></div>
      <div><label>Median session</label><div>${fmtMs(summary.medianSessionMs)}</div></div>
    </div>
  </div>

  <div class="card">
    <h2>Reach</h2>
    <p class="muted">How many people a single host brings into a room.</p>
    <div class="config-row">
      <div><label>Avg players per room</label><div>${summary.avgPlayersPerRoom}</div></div>
      <div><label>Largest room</label><div>${summary.maxPlayersInARoom}</div></div>
    </div>
  </div>

  <div class="card">
    <h2>Config popularity</h2>
    <div class="config-row">
      <div>${renderCountTable(summary.config.questionSets, 'Question category')}</div>
      <div>${renderCountTable(summary.config.dogLunge, 'Dog lunge')}</div>
    </div>
    <div class="config-row" style="margin-top:16px;">
      <div>${renderCountTable(summary.config.difficultyRamp, 'Ramp difficulty')}</div>
      <div>${renderCountTable(summary.config.bearTraps, 'Bear traps')}</div>
      <div>${renderCountTable(summary.config.dynamicCellScaling, 'Dynamic cell scaling')}</div>
    </div>
  </div>

  <div class="card">
    <h2>Outcomes &amp; audience</h2>
    <div class="config-row">
      <div>${renderCountTable(summary.endReasons, 'How games ended')}</div>
      <div>${renderCountTable(summary.deviceBreakdown, 'Device')}</div>
      <div>${renderCountTable(summary.countryBreakdown, 'Country')}</div>
    </div>
  </div>

  <div class="card">
    <h2>Rooms per day <span class="muted" style="font-size:var(--fs-vt-xs);">(last 14 shown)</span></h2>
    ${renderCountTable(Object.fromEntries(perDayRows), 'Date')}
  </div>

  <p class="muted center">
    <a href="/admin/analytics/export.jsonl?token=${esc(process.env.ANALYTICS_TOKEN)}" style="color:var(--accent2);">Download raw JSONL</a>
  </p>
</div>
</body></html>`;
}

app.get('/admin/analytics', (req, res) => {
  if (!checkAnalyticsToken(req, res)) return;
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  res.send(renderDashboardHtml(analytics.getSummary({ days })));
});

app.get('/admin/analytics/export.jsonl', (req, res) => {
  if (!checkAnalyticsToken(req, res)) return;
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  res.type('application/jsonl');
  res.setHeader('Content-Disposition', 'attachment; filename="trivia-survival-analytics.jsonl"');
  res.send(analytics.exportJsonl({ days }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Trivia Survival running on http://localhost:${PORT}`));
