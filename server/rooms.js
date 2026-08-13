const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const DEFAULT_QUESTIONS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'questions-default.json'), 'utf8')
);

// ---- Arena constants (logical units, client scales to fit canvas) ----
const ARENA_W = 800;
const ARENA_H = 500;
const PLAYER_RADIUS = 14;
const PLAYER_SPEED = 235; // px/sec
const DOG_SPEED = 185; // px/sec
const DOG_CATCH_RADIUS = 24;
const REVEAL_DELAY_MS = 3000;
const DOOR_OPEN_ANIM_MS = 1100; // window for door-opening + fall animation before dogs release
const DOG_PHASE_TIMEOUT_MS = 14000;
const JUMP_MS = 320;
const TICK_MS = 40; // 25Hz

const TRAPDOORS = {
  A: { x: 130, y: 400, w: 110, h: 90 },
  B: { x: 345, y: 400, w: 110, h: 90 },
  C: { x: 560, y: 400, w: 110, h: 90 }
};
const DOG_PEN = { x: 330, y: 20, w: 140, h: 60 };

function rectContains(rect, x, y) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function randomSpawn() {
  // Spawn in the open area, avoiding trapdoor row and dog pen
  const x = 40 + Math.random() * (ARENA_W - 80);
  const y = 100 + Math.random() * (ARENA_H - 220);
  return { x, y };
}

function shortCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

class Room {
  constructor(code, hostSocketId) {
    this.code = code;
    this.hostSocketId = hostSocketId;
    this.hostConnected = true;
    this.players = new Map(); // playerId -> player object
    this.config = {
      durationSec: 600, // total game length cap (10 min default)
      answerTimeSec: 15,
      questionCount: 10,
      questionSet: 'default' // 'default' | 'custom'
    };
    this.customQuestions = null;
    this.state = 'lobby'; // lobby | question | reveal | resolve | ended
    this.questions = [];
    this.currentQuestionIndex = -1;
    this.currentQuestion = null;
    this.phaseEndsAt = 0;
    this.gameEndsAt = 0;
    this.dogPhaseTimeoutAt = 0;
    this.dogs = [];
    this.cages = { A: [], B: [], C: [] };
    this.exposed = [];
    this.manualEnd = false;
    this.loop = null;
    this.createdAt = Date.now();
  }

  addPlayer(name, avatarColor) {
    const id = uuidv4();
    const token = uuidv4();
    const spawn = randomSpawn();
    const player = {
      id,
      token,
      name: name.slice(0, 16) || 'Player',
      color: avatarColor || '#4f8fef',
      x: spawn.x,
      y: spawn.y,
      input: { up: false, down: false, left: false, right: false },
      jumpUntil: 0,
      alive: true,
      isGhost: false,
      connected: true,
      ready: false,
      cagedAt: null,
      socketId: null
    };
    this.players.set(id, player);
    return player;
  }

  getPlayersPublic() {
    return Array.from(this.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      x: p.x,
      y: p.y,
      alive: p.alive,
      isGhost: p.isGhost,
      connected: p.connected,
      ready: p.ready,
      caged: !!p.cagedAt,
      jumpUntil: p.jumpUntil
    }));
  }

  connectedOrGhostPlayers() {
    return Array.from(this.players.values());
  }

  buildQuestionSet() {
    let source = this.config.questionSet === 'custom' && this.customQuestions
      ? this.customQuestions
      : DEFAULT_QUESTIONS;
    // shuffle copy
    const arr = [...source].sort(() => Math.random() - 0.5);
    const count = Math.min(this.config.questionCount, arr.length);
    this.questions = arr.slice(0, count);
  }

  start(io) {
    this.buildQuestionSet();
    this.state = 'question';
    this.currentQuestionIndex = 0;
    this.currentQuestion = this.questions[0];
    this.phaseEndsAt = Date.now() + this.config.answerTimeSec * 1000;
    this.gameEndsAt = Date.now() + this.config.durationSec * 1000;
    for (const p of this.players.values()) {
      p.alive = true;
      p.isGhost = false;
      p.cagedAt = null;
      const spawn = randomSpawn();
      p.x = spawn.x;
      p.y = spawn.y;
    }
    this.emitQuestion(io);
    this.startLoop(io);
  }

  emitQuestion(io) {
    io.to(this.code).emit('game:question', {
      index: this.currentQuestionIndex,
      total: this.questions.length,
      q: this.currentQuestion.q,
      options: this.currentQuestion.options,
      answerTimeMs: this.config.answerTimeSec * 1000,
      endsAt: this.phaseEndsAt
    });
  }

  startLoop(io) {
    if (this.loop) clearInterval(this.loop);
    this.loop = setInterval(() => this.tick(io), TICK_MS);
  }

  stopLoop() {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
  }

  endGame(io, reason) {
    this.state = 'ended';
    const winners = Array.from(this.players.values()).filter(p => p.alive && !p.isGhost);
    io.to(this.code).emit('game:end', {
      reason,
      winners: winners.map(p => ({ id: p.id, name: p.name, color: p.color }))
    });
    this.stopLoop();
  }

  tick(io) {
    const now = Date.now();
    const dt = TICK_MS / 1000;

    // Movement for everyone not currently locked in a cage
    for (const p of this.players.values()) {
      if (p.cagedAt) continue;
      let dx = 0, dy = 0;
      if (p.input.up) dy -= 1;
      if (p.input.down) dy += 1;
      if (p.input.left) dx -= 1;
      if (p.input.right) dx += 1;
      if (dx !== 0 || dy !== 0) {
        const len = Math.sqrt(dx * dx + dy * dy);
        dx /= len; dy /= len;
        p.x += dx * PLAYER_SPEED * dt;
        p.y += dy * PLAYER_SPEED * dt;
        p.x = Math.max(PLAYER_RADIUS, Math.min(ARENA_W - PLAYER_RADIUS, p.x));
        p.y = Math.max(PLAYER_RADIUS, Math.min(ARENA_H - PLAYER_RADIUS, p.y));
      }
    }

    if (this.manualEnd) {
      this.endGame(io, 'host_ended');
      return;
    }

    if (this.state === 'question' && now >= this.phaseEndsAt) {
      this.doLockIn(io, now);
    } else if (this.state === 'reveal' && now >= this.phaseEndsAt) {
      this.doReveal(io, now);
    } else if (this.state === 'door_anim' && now >= this.phaseEndsAt) {
      this.releaseDogs(io, now);
    } else if (this.state === 'resolve') {
      this.doDogChase(io, now);
    }

    // Broadcast world state every tick
    io.to(this.code).emit('game:tick', {
      state: this.state,
      players: this.getPlayersPublic(),
      dogs: this.dogs.map(d => ({ x: d.x, y: d.y }))
    });
  }

  doLockIn(io, now) {
    this.cages = { A: [], B: [], C: [] };
    this.exposed = [];
    for (const p of this.players.values()) {
      if (p.isGhost || !p.alive) continue;
      let placed = null;
      for (const key of ['A', 'B', 'C']) {
        if (rectContains(TRAPDOORS[key], p.x, p.y)) { placed = key; break; }
      }
      if (placed) {
        this.cages[placed].push(p.id);
        p.cagedAt = placed;
      } else {
        this.exposed.push(p.id);
      }
    }
    this.state = 'reveal';
    this.phaseEndsAt = now + REVEAL_DELAY_MS;
    io.to(this.code).emit('game:lockin', {
      cages: this.cages,
      exposed: this.exposed
    });
  }

  doReveal(io, now) {
    const correct = this.currentQuestion.correct;
    io.to(this.code).emit('game:reveal', { correct });

    // Kill anyone caged under a wrong answer, and respawn their ghost nearby
    const drops = [];
    for (const key of ['A', 'B', 'C']) {
      if (key === correct) continue;
      const door = TRAPDOORS[key];
      for (const pid of this.cages[key]) {
        const p = this.players.get(pid);
        if (!p) continue;
        const fromX = p.x, fromY = p.y;
        p.alive = false;
        p.isGhost = true;
        p.cagedAt = null; // trapdoor opened, they fall through
        // Respawn just above/beside the door, back in the open arena
        const jitter = (Math.random() - 0.5) * 60;
        p.x = Math.max(PLAYER_RADIUS, Math.min(ARENA_W - PLAYER_RADIUS, door.x + door.w / 2 + jitter));
        p.y = Math.max(PLAYER_RADIUS, Math.min(ARENA_H - PLAYER_RADIUS, door.y - 30));
        drops.push({ id: p.id, doorKey: key, fromX, fromY, toX: p.x, toY: p.y });
      }
    }
    if (drops.length) io.to(this.code).emit('game:dropped', { drops });

    // Give clients time to play the door-opening / falling animation before dogs appear
    this.state = 'door_anim';
    this.phaseEndsAt = now + DOOR_OPEN_ANIM_MS;
  }

  releaseDogs(io, now) {
    this.dogs = [
      { x: DOG_PEN.x + 20, y: DOG_PEN.y + 30 },
      { x: DOG_PEN.x + 70, y: DOG_PEN.y + 30 },
      { x: DOG_PEN.x + 120, y: DOG_PEN.y + 30 }
    ];
    this.dogPhaseTimeoutAt = now + DOG_PHASE_TIMEOUT_MS;
    this.state = 'resolve';
    io.to(this.code).emit('game:dogs_released', { exposed: this.exposed });
  }

  doDogChase(io, now) {
    const dt = TICK_MS / 1000;
    const targets = this.exposed
      .map(id => this.players.get(id))
      .filter(p => p && p.alive && !p.isGhost);

    if (targets.length > 0) {
      for (const dog of this.dogs) {
        let nearest = null, nearestDist = Infinity;
        for (const t of targets) {
          const d = Math.hypot(t.x - dog.x, t.y - dog.y);
          if (d < nearestDist) { nearestDist = d; nearest = t; }
        }
        if (nearest) {
          const dx = nearest.x - dog.x, dy = nearest.y - dog.y;
          const len = Math.hypot(dx, dy) || 1;
          dog.x += (dx / len) * DOG_SPEED * dt;
          dog.y += (dy / len) * DOG_SPEED * dt;
          if (Math.hypot(nearest.x - dog.x, nearest.y - dog.y) < DOG_CATCH_RADIUS) {
            nearest.alive = false;
            nearest.isGhost = true;
            io.to(this.code).emit('player:caught', { id: nearest.id });
          }
        }
      }
    }

    const remaining = this.exposed
      .map(id => this.players.get(id))
      .filter(p => p && p.alive && !p.isGhost);

    if (remaining.length === 0 || now >= this.dogPhaseTimeoutAt) {
      // force-kill stragglers if timeout hit
      for (const p of remaining) { p.alive = false; p.isGhost = true; }
      // release the safe cage
      const correct = this.currentQuestion.correct;
      for (const pid of this.cages[correct]) {
        const p = this.players.get(pid);
        if (p) p.cagedAt = null;
      }
      this.dogs = [];
      io.to(this.code).emit('game:round_complete', {});
      this.advanceRound(io, now);
    }
  }

  advanceRound(io, now) {
    const aliveCount = Array.from(this.players.values()).filter(p => p.alive && !p.isGhost).length;
    const nextIndex = this.currentQuestionIndex + 1;
    const outOfQuestions = nextIndex >= this.questions.length;
    const outOfTime = now >= this.gameEndsAt;

    if (aliveCount === 0) {
      this.endGame(io, 'all_eliminated');
      return;
    }
    if (outOfQuestions) {
      this.endGame(io, 'questions_complete');
      return;
    }
    if (outOfTime) {
      this.endGame(io, 'time_up');
      return;
    }

    this.currentQuestionIndex = nextIndex;
    this.currentQuestion = this.questions[nextIndex];
    this.state = 'question';
    this.phaseEndsAt = now + this.config.answerTimeSec * 1000;
    this.emitQuestion(io);
  }

  resetForRematch() {
    this.stopLoop();
    this.state = 'lobby';
    this.questions = [];
    this.currentQuestionIndex = -1;
    this.currentQuestion = null;
    this.phaseEndsAt = 0;
    this.gameEndsAt = 0;
    this.dogPhaseTimeoutAt = 0;
    this.dogs = [];
    this.cages = { A: [], B: [], C: [] };
    this.exposed = [];
    this.manualEnd = false;
    for (const p of this.players.values()) {
      p.alive = true;
      p.isGhost = false;
      p.cagedAt = null;
      p.ready = false;
      const spawn = randomSpawn();
      p.x = spawn.x;
      p.y = spawn.y;
    }
  }
}

class GameManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
  }

  createRoom(hostSocketId) {
    let code;
    do { code = shortCode(); } while (this.rooms.has(code));
    const room = new Room(code, hostSocketId);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get((code || '').toUpperCase());
  }

  removeRoom(code) {
    const room = this.rooms.get(code);
    if (room) room.stopLoop();
    this.rooms.delete(code);
  }

  // Called periodically to clean up abandoned rooms
  sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms.entries()) {
      const anyConnected = room.hostConnected ||
        Array.from(room.players.values()).some(p => p.connected);
      const stale = now - room.createdAt > 1000 * 60 * 60 * 3; // 3hr hard cap
      if ((!anyConnected) || stale) {
        this.removeRoom(code);
      }
    }
  }
}

module.exports = { GameManager, ARENA_W, ARENA_H, TRAPDOORS, DOG_PEN, PLAYER_RADIUS, JUMP_MS };
