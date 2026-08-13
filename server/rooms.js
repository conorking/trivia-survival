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
const DOG_RADIUS = 13;
const DOG_HOME_RADIUS = 26; // how close to its pen slot counts as "home"
const DOG_CATCH_RADIUS = 24;
const REVEAL_DELAY_MS = 3000;
const ESCAPE_MS = 2400; // window to flee a just-opened wrong door before it becomes lethal
const DOG_CATCH_CAPACITY = 2; // catches before a dog is "full" and heads home
const DOG_GIVEUP_MS = 9000; // a dog heads home if it hasn't filled up by this long after release
const DOG_PHASE_HARD_TIMEOUT_MS = 30000; // last-resort safety net only, never kills anyone
const DEATH_ANIM_MS = 1300; // grace hold after the last kill so the fall animation can finish
const HOME_SETTLE_MS = 500; // small buffer when the round ends via dogs-all-home w/ survivors
const OBSTACLE_MARGIN = 18; // extra clearance dogs try to keep from trapdoor rects
const JUMP_MS = 320;
const TICK_MS = 40; // 25Hz

const TRAPDOORS = {
  A: { x: 130, y: 400, w: 110, h: 90 },
  B: { x: 345, y: 400, w: 110, h: 90 },
  C: { x: 560, y: 400, w: 110, h: 90 }
};
const DOG_PEN = { x: 330, y: 20, w: 140, h: 60 };
const DOG_OBSTACLES = ['A', 'B', 'C'].map(k => TRAPDOORS[k]);
const AVOID_RADIUS = DOG_RADIUS + OBSTACLE_MARGIN + 20; // steering influence range around obstacles

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function rectContains(rect, x, y) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

// Push a circle out of a rect if it's overlapping (closest-point method).
// Used both for "player can't cross a locked cage wall" and "dog can't clip a trapdoor".
function resolveCircleRect(x, y, r, rect) {
  const closestX = clamp(x, rect.x, rect.x + rect.w);
  const closestY = clamp(y, rect.y, rect.y + rect.h);
  const dx = x - closestX, dy = y - closestY;
  const distSq = dx * dx + dy * dy;
  if (distSq >= r * r) return { x, y };
  const dist = Math.sqrt(distSq);
  if (dist < 1e-4) {
    // Center sits exactly on/in the rect - push out along the nearest side.
    const left = x - rect.x, right = rect.x + rect.w - x;
    const top = y - rect.y, bottom = rect.y + rect.h - y;
    const min = Math.min(left, right, top, bottom);
    if (min === left) return { x: rect.x - r, y };
    if (min === right) return { x: rect.x + rect.w + r, y };
    if (min === top) return { x, y: rect.y - r };
    return { x, y: rect.y + rect.h + r };
  }
  const overlap = r - dist;
  return { x: x + (dx / dist) * overlap, y: y + (dy / dist) * overlap };
}

// Pairwise circle-circle separation - pushes overlapping entities apart. Mutates x/y in place.
// Shared by player-vs-player and dog-vs-dog collision.
function separatePairs(list, radius) {
  const minDist = radius * 2;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= minDist) continue;
      if (dist < 1e-4) {
        // Exactly overlapping - nudge apart along a deterministic axis.
        a.x -= radius * 0.5; b.x += radius * 0.5;
        continue;
      }
      const overlap = (minDist - dist) / 2;
      const nx = dx / dist, ny = dy / dist;
      a.x -= nx * overlap; a.y -= ny * overlap;
      b.x += nx * overlap; b.y += ny * overlap;
    }
  }
}

function normalize(dx, dy) {
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: 0, y: 0, len: 0 };
  return { x: dx / len, y: dy / len, len };
}

// Steering for dogs: blend a seek-the-target vector with avoidance of inflated obstacle rects,
// sliding tangentially around whichever edge keeps them closest to their original heading
// instead of stalling head-on. Local steering, not pathfinding - fine for 3 static rects.
function steer(x, y, tx, ty, obstacles) {
  const seek = normalize(tx - x, ty - y);
  let avoidX = 0, avoidY = 0;
  for (const rect of obstacles) {
    const closestX = clamp(x, rect.x, rect.x + rect.w);
    const closestY = clamp(y, rect.y, rect.y + rect.h);
    const dx = x - closestX, dy = y - closestY;
    const dist = Math.hypot(dx, dy);
    if (dist >= AVOID_RADIUS) continue;
    const strength = (AVOID_RADIUS - dist) / AVOID_RADIUS;
    if (dist < 1e-4) {
      const left = x - rect.x, right = rect.x + rect.w - x;
      const top = y - rect.y, bottom = rect.y + rect.h - y;
      const min = Math.min(left, right, top, bottom);
      if (min === left) avoidX -= 1;
      else if (min === right) avoidX += 1;
      else if (min === top) avoidY -= 1;
      else avoidY += 1;
      continue;
    }
    const nx = dx / dist, ny = dy / dist;
    avoidX += nx * strength;
    avoidY += ny * strength;
    // Tangential slide - pick whichever rotation keeps us pointed more toward the target.
    const tanX = -ny, tanY = nx;
    const sign = (tanX * seek.x + tanY * seek.y) >= 0 ? 1 : -1;
    avoidX += tanX * sign * strength * 0.6;
    avoidY += tanY * sign * strength * 0.6;
  }
  const out = normalize(seek.x + avoidX * 1.6, seek.y + avoidY * 1.6);
  return out.len > 0 ? out : seek;
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

const DOG_PEN_SLOTS = [
  { x: DOG_PEN.x + 20, y: DOG_PEN.y + 30 },
  { x: DOG_PEN.x + 70, y: DOG_PEN.y + 30 },
  { x: DOG_PEN.x + 120, y: DOG_PEN.y + 30 }
];

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
    this.state = 'lobby'; // lobby | question | reveal | escape | resolve | death_anim | ended
    this.questions = [];
    this.currentQuestionIndex = -1;
    this.currentQuestion = null;
    this.phaseEndsAt = 0;
    this.gameEndsAt = 0;
    this.dogs = [];
    this.cages = { A: [], B: [], C: [] };
    this.exposed = [];
    this.cageSolid = { A: false, B: false, C: false }; // true while a cage's perimeter blocks entry
    this.pitOpen = { A: false, B: false, C: false }; // true while a sprung door is a fall hazard
    this.lastCatchAt = 0;
    this.hardTimeoutAt = 0;
    this.chaseGiveUpAt = 0;
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

  resetHazards() {
    this.cageSolid = { A: false, B: false, C: false };
    this.pitOpen = { A: false, B: false, C: false };
  }

  start(io) {
    this.buildQuestionSet();
    this.state = 'question';
    this.currentQuestionIndex = 0;
    this.currentQuestion = this.questions[0];
    this.phaseEndsAt = Date.now() + this.config.answerTimeSec * 1000;
    this.gameEndsAt = Date.now() + this.config.durationSec * 1000;
    this.dogs = [];
    this.resetHazards();
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

    // 1. Input-driven movement for everyone, then per-state containment rules.
    for (const p of this.players.values()) {
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
      }
      p.x = clamp(p.x, PLAYER_RADIUS, ARENA_W - PLAYER_RADIUS);
      p.y = clamp(p.y, PLAYER_RADIUS, ARENA_H - PLAYER_RADIUS);

      if (p.isGhost) continue; // ghosts roam freely - no cages, no collisions

      if (p.cagedAt) {
        // Contained but mobile: can move and jump, can't cross the cage wall.
        const rect = TRAPDOORS[p.cagedAt];
        p.x = clamp(p.x, rect.x + PLAYER_RADIUS, rect.x + rect.w - PLAYER_RADIUS);
        p.y = clamp(p.y, rect.y + PLAYER_RADIUS, rect.y + rect.h - PLAYER_RADIUS);
      } else {
        for (const key of ['A', 'B', 'C']) {
          if (!this.cageSolid[key]) continue;
          const pushed = resolveCircleRect(p.x, p.y, PLAYER_RADIUS, TRAPDOORS[key]);
          p.x = pushed.x; p.y = pushed.y;
        }
      }
    }

    // 2. Player-vs-player separation, then re-apply containment (a shove shouldn't punch
    // someone out of the arena or into/out of a solid cage).
    const solidPlayers = Array.from(this.players.values()).filter(p => p.alive && !p.isGhost);
    separatePairs(solidPlayers, PLAYER_RADIUS);
    for (const p of solidPlayers) {
      p.x = clamp(p.x, PLAYER_RADIUS, ARENA_W - PLAYER_RADIUS);
      p.y = clamp(p.y, PLAYER_RADIUS, ARENA_H - PLAYER_RADIUS);
      if (p.cagedAt) {
        const rect = TRAPDOORS[p.cagedAt];
        p.x = clamp(p.x, rect.x + PLAYER_RADIUS, rect.x + rect.w - PLAYER_RADIUS);
        p.y = clamp(p.y, rect.y + PLAYER_RADIUS, rect.y + rect.h - PLAYER_RADIUS);
      } else {
        for (const key of ['A', 'B', 'C']) {
          if (!this.cageSolid[key]) continue;
          const pushed = resolveCircleRect(p.x, p.y, PLAYER_RADIUS, TRAPDOORS[key]);
          p.x = pushed.x; p.y = pushed.y;
        }
      }
    }

    // 3. Pit-fall hazard - only live once the chase is actually on, never during the escape
    // window itself (that's the whole point of giving players a couple seconds to flee).
    if (this.state === 'resolve') {
      const drops = [];
      for (const p of solidPlayers) {
        if (p.cagedAt) continue;
        for (const key of ['A', 'B', 'C']) {
          if (!this.pitOpen[key]) continue;
          if (rectContains(TRAPDOORS[key], p.x, p.y)) {
            drops.push(this.fallIntoPit(p, key));
            break;
          }
        }
      }
      if (drops.length) io.to(this.code).emit('game:dropped', { drops });
    }

    if (this.manualEnd) {
      this.endGame(io, 'host_ended');
      return;
    }

    if (this.state === 'question' && now >= this.phaseEndsAt) {
      this.doLockIn(io, now);
    } else if (this.state === 'reveal' && now >= this.phaseEndsAt) {
      this.doReveal(io, now);
    } else if (this.state === 'escape' && now >= this.phaseEndsAt) {
      this.doEscapeEnd(io, now);
    } else if (this.state === 'resolve') {
      this.doDogChase(io, now);
    } else if (this.state === 'death_anim' && now >= this.phaseEndsAt) {
      this.finishRound(io, now);
    }

    // Broadcast world state every tick
    io.to(this.code).emit('game:tick', {
      state: this.state,
      players: this.getPlayersPublic(),
      dogs: this.dogs.map(d => ({ x: d.x, y: d.y, angle: d.angle, state: d.state }))
    });
  }

  // Shared by the mid-chase pit-fall check and the escape-window straggler sweep.
  fallIntoPit(p, key) {
    const door = TRAPDOORS[key];
    const fromX = p.x, fromY = p.y;
    p.alive = false;
    p.isGhost = true;
    p.cagedAt = null;
    const jitter = (Math.random() - 0.5) * 60;
    p.x = clamp(door.x + door.w / 2 + jitter, PLAYER_RADIUS, ARENA_W - PLAYER_RADIUS);
    p.y = clamp(door.y - 30, PLAYER_RADIUS, ARENA_H - PLAYER_RADIUS);
    return { id: p.id, doorKey: key, fromX, fromY, toX: p.x, toY: p.y };
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
    this.cageSolid = { A: true, B: true, C: true };
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

    // Wrong doors swing open and their occupants are freed - but not killed yet.
    // They (and anyone else) now have ESCAPE_MS to get off the pit before it's lethal.
    for (const key of ['A', 'B', 'C']) {
      if (key === correct) continue;
      this.cageSolid[key] = false;
      this.pitOpen[key] = true;
      for (const pid of this.cages[key]) {
        const p = this.players.get(pid);
        if (p && p.cagedAt === key) p.cagedAt = null;
      }
    }

    this.state = 'escape';
    this.phaseEndsAt = now + ESCAPE_MS;
  }

  doEscapeEnd(io, now) {
    // Anyone still standing on an open pit when the grace window closes falls through.
    const drops = [];
    for (const p of this.players.values()) {
      if (!p.alive || p.isGhost) continue;
      for (const key of ['A', 'B', 'C']) {
        if (!this.pitOpen[key]) continue;
        if (rectContains(TRAPDOORS[key], p.x, p.y)) {
          drops.push(this.fallIntoPit(p, key));
          break;
        }
      }
    }
    if (drops.length) io.to(this.code).emit('game:dropped', { drops });
    this.releaseDogs(io, now);
  }

  releaseDogs(io, now) {
    const giveUpAt = now + DOG_GIVEUP_MS;
    this.dogs = DOG_PEN_SLOTS.map((slot, i) => ({
      id: i,
      x: slot.x,
      y: slot.y,
      angle: -Math.PI / 2,
      targetId: null,
      catches: 0,
      state: 'hunting',
      giveUpAt,
      homeSlot: slot
    }));
    this.chaseGiveUpAt = giveUpAt;
    this.hardTimeoutAt = now + DOG_PHASE_HARD_TIMEOUT_MS;
    this.lastCatchAt = 0;
    this.state = 'resolve';
    io.to(this.code).emit('game:dogs_released', { giveUpAt });
  }

  doDogChase(io, now) {
    const dt = TICK_MS / 1000;
    const huntPool = Array.from(this.players.values())
      .filter(p => p.alive && !p.isGhost && !p.cagedAt);
    const claimed = new Set(
      this.dogs.filter(d => d.state === 'hunting' && d.targetId).map(d => d.targetId)
    );

    for (const dog of this.dogs) {
      if (dog.state === 'home') continue;

      if (dog.state === 'hunting') {
        if (dog.catches >= DOG_CATCH_CAPACITY || now >= dog.giveUpAt) {
          dog.state = 'returning';
          dog.targetId = null;
        } else {
          let target = dog.targetId ? this.players.get(dog.targetId) : null;
          if (!target || !target.alive || target.isGhost || target.cagedAt) target = null;
          if (!target) {
            let nearest = null, nearestDist = Infinity;
            for (const p of huntPool) {
              if (claimed.has(p.id)) continue;
              const d = Math.hypot(p.x - dog.x, p.y - dog.y);
              if (d < nearestDist) { nearestDist = d; nearest = p; }
            }
            if (nearest) { dog.targetId = nearest.id; claimed.add(nearest.id); }
          }
        }
      }

      let tx = dog.x, ty = dog.y;
      if (dog.state === 'returning') {
        tx = dog.homeSlot.x; ty = dog.homeSlot.y;
      } else if (dog.targetId) {
        const target = this.players.get(dog.targetId);
        if (target) { tx = target.x; ty = target.y; }
      }

      const dir = steer(dog.x, dog.y, tx, ty, DOG_OBSTACLES);
      if (dir.x !== 0 || dir.y !== 0) {
        const nx = dog.x + dir.x * DOG_SPEED * dt;
        const ny = dog.y + dir.y * DOG_SPEED * dt;
        if (nx !== dog.x || ny !== dog.y) dog.angle = Math.atan2(ny - dog.y, nx - dog.x);
        dog.x = nx; dog.y = ny;
      }
      dog.x = clamp(dog.x, DOG_RADIUS, ARENA_W - DOG_RADIUS);
      dog.y = clamp(dog.y, DOG_RADIUS, ARENA_H - DOG_RADIUS);
      // Hard guarantee on top of steering: a dog can never actually clip a trapdoor rect,
      // solid cage or open pit alike.
      for (const key of ['A', 'B', 'C']) {
        const pushed = resolveCircleRect(dog.x, dog.y, DOG_RADIUS, TRAPDOORS[key]);
        dog.x = pushed.x; dog.y = pushed.y;
      }

      if (dog.state === 'returning' && Math.hypot(dog.x - dog.homeSlot.x, dog.y - dog.homeSlot.y) < DOG_HOME_RADIUS) {
        dog.state = 'home';
      }
    }

    separatePairs(this.dogs, DOG_RADIUS);
    for (const dog of this.dogs) {
      dog.x = clamp(dog.x, DOG_RADIUS, ARENA_W - DOG_RADIUS);
      dog.y = clamp(dog.y, DOG_RADIUS, ARENA_H - DOG_RADIUS);
    }

    // Catch checks (hunting dogs only)
    for (const dog of this.dogs) {
      if (dog.state !== 'hunting' || !dog.targetId) continue;
      const target = this.players.get(dog.targetId);
      if (!target || !target.alive || target.isGhost) { dog.targetId = null; continue; }
      if (Math.hypot(target.x - dog.x, target.y - dog.y) < DOG_CATCH_RADIUS) {
        target.alive = false;
        target.isGhost = true;
        dog.catches += 1;
        dog.targetId = null;
        this.lastCatchAt = now;
        io.to(this.code).emit('player:caught', {
          id: target.id, x: target.x, y: target.y, dogX: dog.x, dogY: dog.y
        });
      }
    }

    const hard = now >= this.hardTimeoutAt;
    if (hard) {
      // Last-resort safety net: send every dog home instantly. Never kills survivors.
      for (const dog of this.dogs) dog.state = 'home';
    }

    const huntPoolAlive = huntPool.filter(p => p.alive && !p.isGhost);
    const allDogsHome = this.dogs.every(d => d.state === 'home');
    const allDead = huntPoolAlive.length === 0;

    if (allDead || allDogsHome || hard) {
      this.state = 'death_anim';
      this.phaseEndsAt = allDead
        ? Math.max(now, (this.lastCatchAt || now) + DEATH_ANIM_MS)
        : now + HOME_SETTLE_MS;
    }
  }

  finishRound(io, now) {
    const correct = this.currentQuestion.correct;
    for (const pid of this.cages[correct]) {
      const p = this.players.get(pid);
      if (p) p.cagedAt = null;
    }
    this.cageSolid[correct] = false;
    this.dogs = [];
    io.to(this.code).emit('game:round_complete', {});
    this.advanceRound(io, now);
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

    this.resetHazards();
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
    this.dogs = [];
    this.cages = { A: [], B: [], C: [] };
    this.exposed = [];
    this.resetHazards();
    this.lastCatchAt = 0;
    this.hardTimeoutAt = 0;
    this.chaseGiveUpAt = 0;
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
