const socket = io();
let roomCode = null;
let currentConfig = null;
let uploadedQuestions = null;
let latestPlayers = [];
let latestDogs = [];

const existingCode = sessionStorage.getItem('trivia_host_room');

if (existingCode) {
  socket.emit('host:rejoin', { code: existingCode });
} else {
  socket.emit('host:createRoom', {});
}

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
  latestPlayers = state.players;
  renderPlayerList(state.players);
  if (state.state === 'ended') {
    document.getElementById('lobbyView').style.display = 'none';
    document.getElementById('gameView').style.display = 'none';
    document.getElementById('endView').style.display = 'block';
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
  latestPlayers = players;
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
  ArenaRender.onNewQuestion();
  const remaining = data.endsAt ? data.endsAt - Date.now() : data.answerTimeMs;
  animateTimer(Math.max(0, remaining));
}

socket.on('game:question', renderQuestion);

function animateTimer(durationMs) {
  const bar = document.getElementById('timerBar');
  bar.style.transition = 'none';
  bar.style.width = '100%';
  requestAnimationFrame(() => {
    bar.style.transition = `width ${durationMs}ms linear`;
    bar.style.width = '0%';
  });
}

socket.on('game:lockin', () => {
  ArenaRender.onLockIn();
});

socket.on('game:reveal', (data) => {
  ArenaRender.onReveal(data.correct);
  document.querySelectorAll('.option-pill').forEach(el => {
    if (el.classList.contains(data.correct)) el.classList.add('correct');
    else el.classList.add('wrong');
  });
});

socket.on('game:dropped', (data) => {
  ArenaRender.onDropped(data.drops);
});

socket.on('game:round_complete', () => {
  ArenaRender.onRoundComplete();
});

socket.on('game:tick', (data) => {
  latestPlayers = data.players;
  latestDogs = data.dogs;
  updateCounts(data.players);
  drawFrame();
});

socket.on('game:end', ({ reason, winners }) => {
  document.getElementById('gameView').style.display = 'none';
  document.getElementById('endView').style.display = 'block';
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
  latestPlayers = players;
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
  const url = `${location.origin}/player.html?code=${code}`;
  document.getElementById('joinUrl').value = url;
  document.getElementById('qrcode-box').innerHTML = '';
  new QRCode(document.getElementById('qrcode-box'), { text: url, width: 120, height: 120 });
}

function populateConfigForm(config) {
  document.getElementById('cfgDuration').value = config.durationSec;
  document.getElementById('cfgAnswerTime').value = config.answerTimeSec;
  document.getElementById('cfgQuestionCount').value = config.questionCount;
  document.getElementById('cfgQuestionSet').value = config.questionSet;
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

function saveConfig() {
  document.getElementById('cfgError').textContent = '';
  socket.emit('host:updateConfig', {
    durationSec: Number(document.getElementById('cfgDuration').value),
    answerTimeSec: Number(document.getElementById('cfgAnswerTime').value),
    questionCount: Number(document.getElementById('cfgQuestionCount').value),
    questionSet: document.getElementById('cfgQuestionSet').value
  });
}

function renderPlayerList(players) {
  document.getElementById('playerCount').textContent = players.length;
  const list = document.getElementById('playerList');
  list.innerHTML = players.map(p => `
    <div class="player-chip ${p.ready ? '' : 'not-ready'} ${!p.connected ? 'dead' : ''}">
      <span class="dot" style="background:${p.color}"></span>
      ${p.name} ${p.connected ? '' : '(offline)'}
    </div>
  `).join('');
  const connectedCount = players.filter(p => p.connected).length;
  document.getElementById('startBtn').disabled = connectedCount < 2;
}

function startGame() {
  document.getElementById('startError').textContent = '';
  socket.emit('host:startGame');
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
  document.getElementById('gameView').style.display = 'block';
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

function drawFrame() {
  const canvas = document.getElementById('arena');
  if (!canvas || canvas.style.display === 'none') return;
  const ctx = canvas.getContext('2d');
  ArenaRender.render(ctx, { players: latestPlayers, dogs: latestDogs, myId: null });
}
