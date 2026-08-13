const socket = io();
let myId = null;
let myToken = null;
let myRoomCode = null;
let ready = false;
let latestPlayers = []; // raw (non-interpolated) - used for pointer-control targeting and status text
let myAliveGhostState = { alive: true, isGhost: false };
let myLocalJumpUntil = 0;

const AVATAR_COLORS = ['#4f8fef', '#ef4f6b', '#58d68d', '#ffd23f', '#b84fef', '#ef8f4f', '#4fdada', '#ff69b4'];
let selectedColor = AVATAR_COLORS[0];

const params = new URLSearchParams(location.search);
const codeFromUrl = params.get('code');
if (codeFromUrl) document.getElementById('codeInput').value = codeFromUrl.toUpperCase();

const grid = document.getElementById('avatarGrid');
AVATAR_COLORS.forEach((color, i) => {
  const sw = document.createElement('div');
  sw.className = 'avatar-swatch' + (i === 0 ? ' selected' : '');
  sw.style.background = color;
  sw.onclick = () => {
    document.querySelectorAll('.avatar-swatch').forEach(el => el.classList.remove('selected'));
    sw.classList.add('selected');
    selectedColor = color;
  };
  grid.appendChild(sw);
});

// Attempt auto-rejoin if we have a stored token for this code
if (codeFromUrl) {
  const storedToken = localStorage.getItem(`trivia_token_${codeFromUrl.toUpperCase()}`);
  if (storedToken) {
    myToken = storedToken;
    socket.emit('player:rejoin', { token: storedToken });
  }
}

// Explicitly tell the server we're leaving instead of waiting for the connection to
// time out - a socket.disconnect() sends a clean disconnect packet immediately, so the
// host sees accurate presence right away (matters for "need 2 players"/rematch counts).
function backToMenu() {
  socket.disconnect();
  location.href = 'index.html';
}
// Safety net for any other way of leaving (browser back, closing the tab, etc.) -
// pagehide fires reliably across desktop and mobile browsers.
window.addEventListener('pagehide', () => { socket.disconnect(); });

function joinGame() {
  const code = document.getElementById('codeInput').value.trim().toUpperCase();
  const name = document.getElementById('nameInput').value.trim();
  document.getElementById('joinError').textContent = '';
  if (!code) { document.getElementById('joinError').textContent = 'Enter a room code.'; return; }
  if (!name) { document.getElementById('joinError').textContent = 'Enter your name.'; return; }
  socket.emit('player:join', { code, name, color: selectedColor });
}

socket.on('player:joined', ({ code, playerId, token, arena }) => {
  myId = playerId; myToken = token; myRoomCode = code;
  localStorage.setItem(`trivia_token_${code}`, token);
  ArenaRender.setArena(arena);
  showLobby();
});

socket.on('player:rejoined', ({ code, playerId, token, state, config, you, currentQuestion, arena }) => {
  myId = playerId; myToken = token; myRoomCode = code;
  myAliveGhostState = { alive: you.alive, isGhost: you.isGhost };
  localStorage.setItem(`trivia_token_${code}`, token);
  ArenaRender.setArena(arena);
  if (state === 'lobby') {
    showLobby();
  } else if (state === 'ended') {
    // nothing to resume into; go back to menu
    backToMenu();
  } else {
    showGameView();
    if (currentQuestion) renderQuestion(currentQuestion);
  }
});

socket.on('player:error', ({ message }) => {
  const errEl = document.getElementById('joinError');
  if (errEl) errEl.textContent = message;
});

socket.on('room:players', (players) => {
  latestPlayers = players;
  document.getElementById('playerCount').textContent = players.length;
  const list = document.getElementById('playerList');
  if (list) {
    list.innerHTML = players.map(p => `
      <div class="player-chip ${p.ready ? 'ready' : 'not-ready'}">
        <span class="dot" style="background:${p.color}"></span>
        ${p.name}${p.id === myId ? ' (you)' : ''}
        ${p.ready ? '<span class="ready-tick">✔</span>' : ''}
      </div>
    `).join('');
  }
});

function toggleReady() {
  ready = !ready;
  socket.emit('player:ready', ready);
  document.getElementById('readyBtn').textContent = ready ? 'READY ✔' : 'READY UP';
}

socket.on('game:started', () => { showGameView(); });

function renderQuestion(data) {
  document.getElementById('qIndex').textContent = data.index + 1;
  document.getElementById('qTotal').textContent = data.total;
  document.getElementById('questionText').textContent = data.q;
  const row = document.getElementById('optionsRow');
  row.innerHTML = '';
  for (const key of ['A', 'B', 'C']) {
    if (!data.options[key]) continue;
    const pill = document.createElement('div');
    pill.className = `option-pill ${key}`;
    pill.textContent = `${key}: ${data.options[key]}`;
    row.appendChild(pill);
  }
  if (data.trapdoors) ArenaRender.setTrapdoors(data.trapdoors);
  ArenaRender.onNewQuestion();
}

socket.on('game:question', renderQuestion);

// ---- Unified phase timer: one bar + label used across every round phase ----
const PHASE_LABELS = {
  question: (s) => `Choose your answer! ${s}s`,
  reveal: (s) => `Revealing the answer... ${s}s`,
  escape: (s) => `Get off the wrong doors! ${s}s`,
  fall_pause: () => 'Uh oh...',
  resolve: (s) => `Survive the dogs for another ${s}s...`,
  death_anim: () => 'Round over...'
};
let lastPhaseState = null;

function updatePhaseTimer(state, phaseEndsAt) {
  const label = document.getElementById('phaseLabel');
  const bar = document.getElementById('timerBar');
  if (!label || !bar) return;
  const build = PHASE_LABELS[state];
  if (!build) { label.textContent = ''; return; }

  const remainingMs = Math.max(0, (phaseEndsAt || 0) - Date.now());
  label.textContent = build(Math.ceil(remainingMs / 1000));

  if (state !== lastPhaseState) {
    lastPhaseState = state;
    bar.style.transition = 'none';
    bar.style.width = '100%';
    requestAnimationFrame(() => {
      bar.style.transition = `width ${remainingMs}ms linear`;
      bar.style.width = '0%';
    });
  }
}

socket.on('game:lockin', (data) => {
  ArenaRender.onLockIn(data.cages);
});

socket.on('game:reveal', (data) => {
  ArenaRender.onReveal(data.correct, data.escapeEndsAt);
  document.querySelectorAll('.option-pill').forEach(el => {
    if (el.classList.contains(data.correct)) el.classList.add('correct');
    else el.classList.add('wrong');
  });
});

socket.on('game:dropped', (data) => {
  ArenaRender.onDropped(data.drops);
});

socket.on('player:caught', (data) => {
  ArenaRender.onCaught(data);
});

socket.on('game:dogs_released', (data) => {
  ArenaRender.onDogsReleased(data);
});

socket.on('game:round_complete', () => {
  ArenaRender.onRoundComplete();
});

socket.on('game:tick', (data) => {
  latestPlayers = data.players;
  pushSnapshot(data.players, data.dogs, data.traps || []);
  const me = data.players.find(p => p.id === myId);
  if (me) {
    myAliveGhostState = { alive: me.alive, isGhost: me.isGhost };
    document.getElementById('youStatus').textContent = me.isGhost ? 'Status: 👻 Ghost' : 'Status: Alive';
  }
  const aliveCount = data.players.filter(p => p.alive && !p.isGhost).length;
  const aliveEl = document.getElementById('aliveCount');
  if (aliveEl) aliveEl.textContent = aliveCount;
  updatePhaseTimer(data.state, data.phaseEndsAt);
});

socket.on('game:end', ({ reason, winners }) => {
  // Leave gameView (and its last-rendered frame) visible behind the summary overlay,
  // instead of cutting away from the arena entirely.
  document.getElementById('endView').style.display = 'flex';
  const iWon = winners.some(w => w.id === myId);
  document.getElementById('endTitle').textContent = iWon ? '🏆 YOU SURVIVED!' : 'GAME OVER';
  const reasonText = {
    all_eliminated: 'Everyone was eliminated!',
    questions_complete: 'All questions answered!',
    time_up: "Time's up!",
    host_ended: 'Game ended by host.'
  }[reason] || '';
  document.getElementById('endReason').textContent = reasonText;
  const list = document.getElementById('winnersList');
  list.innerHTML = winners.length
    ? winners.map(w => `<div class="winner" style="color:${w.color}">🏆 ${w.name}${w.id === myId ? ' (you)' : ''}</div>`).join('')
    : '<p class="muted">No survivors this time!</p>';
  document.getElementById('rematchHint').style.display = 'block';
});

socket.on('game:rematch', () => {
  ready = false;
  lastPhaseState = null;
  document.getElementById('endView').style.display = 'none';
  document.getElementById('gameView').style.display = 'none';
  const readyBtn = document.getElementById('readyBtn');
  if (readyBtn) readyBtn.textContent = 'READY UP';
  showLobby();
  showToast('Host started a rematch — ready up!');
});

let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function showLobby() {
  document.getElementById('joinView').style.display = 'none';
  document.getElementById('lobbyView').style.display = 'block';
}

function showGameView() {
  document.getElementById('joinView').style.display = 'none';
  document.getElementById('lobbyView').style.display = 'none';
  document.getElementById('gameView').style.display = 'flex';
  const canvas = document.getElementById('arena');
  ArenaRender.fitCanvas(canvas);
}

// ---- Rendering: a requestAnimationFrame loop decoupled from network tick arrival ----
// The server only broadcasts state at 25Hz and network delivery is jittery on top of
// that; redrawing exactly when a message lands looks stuttery. Instead we buffer the
// last few snapshots and render a point in time slightly in the past (INTERP_DELAY_MS),
// smoothly interpolated between the two real snapshots that bracket it - this runs at
// the display's actual refresh rate and reads much smoother, at the cost of a small,
// constant, imperceptible visual latency.
const INTERP_DELAY_MS = 80; // ~2 server ticks behind "now"
let snapshotBuffer = [];

function pushSnapshot(players, dogs, traps) {
  snapshotBuffer.push({ t: Date.now(), players, dogs, traps });
  if (snapshotBuffer.length > 8) snapshotBuffer.shift();
}

function lerp(a, b, t) { return a + (b - a) * t; }

function lerpAngle(a, b, t) {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

function interpolateEntities(older, newer, t, angleKey) {
  const byKey = new Map(older.map((e, i) => [e.id !== undefined ? e.id : i, e]));
  return newer.map((eb, i) => {
    const ea = byKey.get(eb.id !== undefined ? eb.id : i);
    if (!ea) return eb;
    const out = { ...eb, x: lerp(ea.x, eb.x, t), y: lerp(ea.y, eb.y, t) };
    if (angleKey && typeof eb[angleKey] === 'number' && typeof ea[angleKey] === 'number') {
      out[angleKey] = lerpAngle(ea[angleKey], eb[angleKey], t);
    }
    return out;
  });
}

function getRenderSnapshot() {
  if (snapshotBuffer.length === 0) return { players: [], dogs: [], traps: [] };
  const renderAt = Date.now() - INTERP_DELAY_MS;
  const first = snapshotBuffer[0], last = snapshotBuffer[snapshotBuffer.length - 1];
  if (renderAt <= first.t) return first;
  if (renderAt >= last.t) return last;
  for (let i = 0; i < snapshotBuffer.length - 1; i++) {
    const a = snapshotBuffer[i], b = snapshotBuffer[i + 1];
    if (renderAt >= a.t && renderAt <= b.t) {
      const span = b.t - a.t;
      const t = span > 0 ? (renderAt - a.t) / span : 1;
      return {
        players: interpolateEntities(a.players, b.players, t, null),
        dogs: interpolateEntities(a.dogs, b.dogs, t, 'angle'),
        traps: b.traps
      };
    }
  }
  return last;
}

function drawFrame() {
  const canvas = document.getElementById('arena');
  if (!canvas || canvas.offsetParent === null) return;
  const ctx = canvas.getContext('2d');
  const snap = getRenderSnapshot();
  let players = snap.players;
  if (myLocalJumpUntil > Date.now()) {
    players = players.map(p => {
      if (p.id !== myId) return p;
      const serverJump = p.jumpUntil || 0;
      return serverJump >= myLocalJumpUntil ? p : { ...p, jumpUntil: myLocalJumpUntil };
    });
  }
  ArenaRender.render(ctx, { players, dogs: snap.dogs, traps: snap.traps, myId });
}

(function renderLoop() {
  drawFrame();
  requestAnimationFrame(renderLoop);
})();

// ---- Input handling ----
// Two sources feed the same {dx,dy} direction vector sent to the server: keyboard
// (desktop, discrete 8-way) and pointer/touch (hold-drag to walk toward the touch
// point, quick tap to jump instead - see setupPointerControls below).
let lastSentDx = 0, lastSentDy = 0;
function sendDirInput(dx, dy) {
  if (dx === lastSentDx && dy === lastSentDy) return;
  lastSentDx = dx; lastSentDy = dy;
  socket.emit('player:input', { dx, dy });
}

function triggerJump() {
  myLocalJumpUntil = Date.now() + 320; // instant local feedback, matches server JUMP_MS
  socket.emit('player:jump');
}

const keyState = { up: false, down: false, left: false, right: false };

function keyToDir(code) {
  switch (code) {
    case 'ArrowUp': case 'KeyW': return 'up';
    case 'ArrowDown': case 'KeyS': return 'down';
    case 'ArrowLeft': case 'KeyA': return 'left';
    case 'ArrowRight': case 'KeyD': return 'right';
    default: return null;
  }
}

function updateKeyboardInput() {
  let dx = 0, dy = 0;
  if (keyState.up) dy -= 1;
  if (keyState.down) dy += 1;
  if (keyState.left) dx -= 1;
  if (keyState.right) dx += 1;
  const len = Math.hypot(dx, dy);
  sendDirInput(len > 0 ? dx / len : 0, len > 0 ? dy / len : 0);
}

window.addEventListener('keydown', (e) => {
  if (document.getElementById('gameView').style.display === 'none') return;
  const dir = keyToDir(e.code);
  if (dir) {
    e.preventDefault();
    keyState[dir] = true;
    updateKeyboardInput();
  } else if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) triggerJump();
  }
});

window.addEventListener('keyup', (e) => {
  const dir = keyToDir(e.code);
  if (dir) {
    keyState[dir] = false;
    updateKeyboardInput();
  }
});

// Stop movement if window loses focus (avoids stuck keys)
window.addEventListener('blur', () => {
  keyState.up = keyState.down = keyState.left = keyState.right = false;
  updateKeyboardInput();
});

// ---- Pointer/touch: hold-drag to walk toward the point, quick tap to jump ----
const TAP_MAX_MS = 220;
const TAP_MAX_MOVE = 12; // arena px

let pointerActive = false;
let pointerDownAt = 0;
let pointerDownPos = null;
let pointerCurrentPos = null;

function toArenaCoords(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}

function setupPointerControls() {
  const canvas = document.getElementById('arena');
  if (!canvas) return;

  canvas.addEventListener('pointerdown', (e) => {
    if (document.getElementById('gameView').style.display === 'none') return;
    pointerActive = true;
    pointerDownAt = Date.now();
    pointerDownPos = toArenaCoords(canvas, e.clientX, e.clientY);
    pointerCurrentPos = pointerDownPos;
    if (canvas.setPointerCapture) {
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointerActive) return;
    pointerCurrentPos = toArenaCoords(canvas, e.clientX, e.clientY);
  });

  function endPointer(e) {
    if (!pointerActive) return;
    const heldMs = Date.now() - pointerDownAt;
    const endPos = pointerCurrentPos || pointerDownPos;
    const moved = Math.hypot(endPos.x - pointerDownPos.x, endPos.y - pointerDownPos.y);
    pointerActive = false;
    pointerCurrentPos = null;
    sendDirInput(0, 0);
    if (heldMs <= TAP_MAX_MS && moved <= TAP_MAX_MOVE) {
      triggerJump();
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
}
setupPointerControls();

// While held, continuously steer toward the current touch/cursor point - runs on an
// interval (rather than only on pointermove) so the direction keeps updating as the
// player's own position moves closer to a finger held still.
setInterval(() => {
  if (!pointerActive || !pointerCurrentPos) return;
  const me = latestPlayers.find(p => p.id === myId);
  const originX = me ? me.x : pointerCurrentPos.x;
  const originY = me ? me.y : pointerCurrentPos.y;
  const dx = pointerCurrentPos.x - originX, dy = pointerCurrentPos.y - originY;
  const len = Math.hypot(dx, dy);
  sendDirInput(len < 4 ? 0 : dx / len, len < 4 ? 0 : dy / len);
}, 50);
