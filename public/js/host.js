const socket = io();
let roomCode = null;
let currentConfig = null;
let uploadedQuestions = null;

const existingCode = sessionStorage.getItem('trivia_host_room');

if (existingCode) {
  socket.emit('host:rejoin', { code: existingCode });
} else {
  socket.emit('host:createRoom', {});
}

// If the browser tab is closing/navigating away, disconnect immediately rather than
// waiting for the transport to time out - keeps room presence data accurate promptly.
window.addEventListener('pagehide', () => { socket.disconnect(); });

socket.on('host:roomCreated', ({ code, config }) => {
  roomCode = code;
  currentConfig = config;
  sessionStorage.setItem('trivia_host_room', code);
  showRoomInfo(code);
  populateConfigForm(config);
});

socket.on('host:roomState', (state) => {
  roomCode = state.code;
  currentConfig = state.config;
  ArenaRender.setArena(state.arena);
  showRoomInfo(state.code);
  populateConfigForm(state.config);
  renderPlayerList(state.players);
  if (state.state === 'ended') {
    document.getElementById('lobbyView').style.display = 'none';
    document.getElementById('gameView').style.display = 'none';
    document.getElementById('endView').style.display = 'flex';
    document.getElementById('endReason').textContent = '';
    document.getElementById('winnersList').innerHTML = '<p class="muted">Game already ended.</p>';
  } else if (state.state !== 'lobby') {
    showGameView();
    if (state.currentQuestion) renderQuestion(state.currentQuestion);
  }
});

socket.on('host:error', ({ message }) => {
  document.getElementById('cfgError').textContent = message;
  document.getElementById('startError').textContent = message;
});

socket.on('host:questionsUploaded', ({ count }) => {
  document.getElementById('uploadStatus').textContent = `✔ Loaded ${count} custom questions.`;
});

socket.on('room:config', (config) => { currentConfig = config; populateConfigForm(config); });

socket.on('room:players', (players) => {
  renderPlayerList(players);
});

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
  pushSnapshot(data.players, data.dogs, data.traps || []);
  updateCounts(data.players);
  updatePhaseTimer(data.state, data.phaseEndsAt);
});

socket.on('game:end', ({ reason, winners }) => {
  // Leave gameView (and its last-rendered frame) visible behind the summary overlay,
  // instead of cutting away from the arena entirely.
  document.getElementById('endView').style.display = 'flex';
  const reasonText = {
    all_eliminated: 'Everyone was eliminated!',
    questions_complete: 'All questions answered!',
    time_up: "Time's up!",
    host_ended: 'Game ended by host.'
  }[reason] || '';
  document.getElementById('endReason').textContent = reasonText;
  const list = document.getElementById('winnersList');
  list.innerHTML = winners.length
    ? winners.map(w => `<div class="winner" style="color:${w.color}">🏆 ${w.name}</div>`).join('')
    : '<p class="muted">No survivors this time!</p>';
});

socket.on('game:rematch', ({ config, players }) => {
  currentConfig = config;
  lastPhaseState = null;
  document.getElementById('endView').style.display = 'none';
  document.getElementById('gameView').style.display = 'none';
  document.getElementById('lobbyView').style.display = 'block';
  populateConfigForm(config);
  renderPlayerList(players);
  showToast('Rematch ready — configure and start when set!');
});

function showRoomInfo(code) {
  document.getElementById('roomInfoCard').style.display = 'block';
  document.getElementById('roomCode').textContent = code;
  renderJoinUrl(code);
  maybeUseLanOrigin(code);
}

function renderJoinUrl(code, originOverride) {
  const base = originOverride || location.origin;
  const url = `${base}/player.html?code=${code}`;
  document.getElementById('joinUrl').value = url;
  document.getElementById('qrcode-box').innerHTML = '';
  new QRCode(document.getElementById('qrcode-box'), { text: url, width: 120, height: 120 });
}

// If the host opened this page via localhost/127.0.0.1, that address is meaningless to
// any other device scanning the QR code - swap in the host machine's actual LAN IP
// (reported by the server) so phones on the same wifi can actually reach it.
let lanOriginPromise = null;
function maybeUseLanOrigin(code) {
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (!isLoopback) return;
  if (!lanOriginPromise) {
    lanOriginPromise = fetch('/api/lan-info')
      .then(r => r.json())
      .then(data => (data.ips && data.ips[0]) ? `http://${data.ips[0]}:${data.port}` : null)
      .catch(() => null);
  }
  lanOriginPromise.then(origin => {
    if (origin && roomCode === code) renderJoinUrl(code, origin);
  });
}

function populateConfigForm(config) {
  document.getElementById('cfgDuration').value = config.durationSec;
  document.getElementById('cfgDurationRange').value = config.durationSec;
  document.getElementById('cfgAnswerTime').value = config.answerTimeSec;
  document.getElementById('cfgAnswerTimeRange').value = config.answerTimeSec;
  document.getElementById('cfgQuestionCount').value = config.questionCount;
  document.getElementById('cfgQuestionCountRange').value = config.questionCount;
  document.getElementById('cfgQuestionSet').value = config.questionSet;
  document.getElementById('cfgBearTraps').checked = !!config.bearTraps;
  document.getElementById('cfgDogLunge').checked = !!config.dogLunge;
  document.getElementById('cfgDynamicCellScaling').checked = !!config.dynamicCellScaling;
  document.getElementById('uploadRow').style.display = config.questionSet === 'custom' ? 'block' : 'none';
}

document.getElementById('cfgQuestionSet').addEventListener('change', (e) => {
  document.getElementById('uploadRow').style.display = e.target.value === 'custom' ? 'block' : 'none';
});

document.getElementById('questionFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const questions = JSON.parse(reader.result);
      socket.emit('host:uploadQuestions', { questions });
    } catch (err) {
      document.getElementById('uploadStatus').textContent = 'Invalid JSON file.';
    }
  };
  reader.readAsText(file);
});

// Keep each slider and its paired number box in sync, both directions.
function linkSlider(rangeId, numberId) {
  const range = document.getElementById(rangeId);
  const number = document.getElementById(numberId);
  range.addEventListener('input', () => { number.value = range.value; });
  number.addEventListener('input', () => {
    const clamped = Math.max(Number(number.min), Math.min(Number(number.max), Number(number.value) || 0));
    range.value = clamped;
  });
}
linkSlider('cfgDurationRange', 'cfgDuration');
linkSlider('cfgAnswerTimeRange', 'cfgAnswerTime');
linkSlider('cfgQuestionCountRange', 'cfgQuestionCount');

function collectConfig() {
  return {
    durationSec: Number(document.getElementById('cfgDuration').value),
    answerTimeSec: Number(document.getElementById('cfgAnswerTime').value),
    questionCount: Number(document.getElementById('cfgQuestionCount').value),
    questionSet: document.getElementById('cfgQuestionSet').value,
    bearTraps: document.getElementById('cfgBearTraps').checked,
    dogLunge: document.getElementById('cfgDogLunge').checked,
    dynamicCellScaling: document.getElementById('cfgDynamicCellScaling').checked
  };
}

function renderPlayerList(players) {
  document.getElementById('playerCount').textContent = players.length;
  const list = document.getElementById('playerList');
  list.innerHTML = players.map(p => `
    <div class="player-chip ${p.ready ? 'ready' : 'not-ready'} ${!p.connected ? 'dead' : ''}">
      <span class="dot" style="background:${p.color}"></span>
      ${p.name} ${p.connected ? '' : '(offline)'}
      ${p.ready ? '<span class="ready-tick">✔</span>' : ''}
    </div>
  `).join('');
  const connectedCount = players.filter(p => p.connected).length;
  document.getElementById('startBtn').disabled = connectedCount < 2;
}

function startGame() {
  document.getElementById('startError').textContent = '';
  document.getElementById('cfgError').textContent = '';
  socket.emit('host:startGame', { config: collectConfig() });
}

function endGameEarly() {
  if (confirm('End the game now? Current survivors will be declared winners.')) {
    socket.emit('host:endGame');
  }
}

function copyLink() {
  const input = document.getElementById('joinUrl');
  input.select();
  navigator.clipboard.writeText(input.value).then(() => showToast('Link copied!'));
}

function copyCode() {
  if (!roomCode) return;
  navigator.clipboard.writeText(roomCode).then(() => showToast('Code copied!'));
}

function rematch() {
  socket.emit('host:rematch');
}

function newRoom() {
  sessionStorage.removeItem('trivia_host_room');
  location.reload();
}

let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

function showGameView() {
  document.getElementById('lobbyView').style.display = 'none';
  document.getElementById('endView').style.display = 'none';
  document.getElementById('gameView').style.display = 'flex';
  document.getElementById('gameCodeVal').textContent = roomCode || '-----';
  const canvas = document.getElementById('arena');
  ArenaRender.fitCanvas(canvas);
}

function updateCounts(players) {
  const alive = players.filter(p => p.alive && !p.isGhost).length;
  const ghosts = players.filter(p => p.isGhost).length;
  document.getElementById('aliveCount').textContent = alive;
  document.getElementById('ghostCount').textContent = ghosts;
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
  ArenaRender.render(ctx, { players: snap.players, dogs: snap.dogs, traps: snap.traps, myId: null });
}

(function renderLoop() {
  drawFrame();
  requestAnimationFrame(renderLoop);
})();
