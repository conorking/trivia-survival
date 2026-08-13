const socket = io();
let myId = null;
let myToken = null;
let myRoomCode = null;
let ready = false;
let latestPlayers = [];
let latestDogs = [];
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

function joinGame() {
  const code = document.getElementById('codeInput').value.trim().toUpperCase();
  const name = document.getElementById('nameInput').value.trim();
  document.getElementById('joinError').textContent = '';
  if (!code) { document.getElementById('joinError').textContent = 'Enter a room code.'; return; }
  if (!name) { document.getElementById('joinError').textContent = 'Enter your name.'; return; }
  socket.emit('player:join', { code, name, color: selectedColor });
}

socket.on('player:joined', ({ code, playerId, token }) => {
  myId = playerId; myToken = token; myRoomCode = code;
  localStorage.setItem(`trivia_token_${code}`, token);
  showLobby();
});

socket.on('player:rejoined', ({ code, playerId, token, state, config, you, currentQuestion }) => {
  myId = playerId; myToken = token; myRoomCode = code;
  myAliveGhostState = { alive: you.alive, isGhost: you.isGhost };
  localStorage.setItem(`trivia_token_${code}`, token);
  if (state === 'lobby') {
    showLobby();
  } else if (state === 'ended') {
    // nothing to resume into; go back to menu
    location.href = 'index.html';
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
      <div class="player-chip ${p.ready ? '' : 'not-ready'}">
        <span class="dot" style="background:${p.color}"></span>
        ${p.name}${p.id === myId ? ' (you)' : ''}
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
  ArenaRender.onNewQuestion();
  const remaining = data.endsAt - Date.now();
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
  latestDogs = data.dogs;
  const me = data.players.find(p => p.id === myId);
  if (me) {
    myAliveGhostState = { alive: me.alive, isGhost: me.isGhost };
    document.getElementById('youStatus').textContent = me.isGhost ? 'Status: 👻 Ghost' : 'Status: Alive';
  }
  const aliveCount = data.players.filter(p => p.alive && !p.isGhost).length;
  const aliveEl = document.getElementById('aliveCount');
  if (aliveEl) aliveEl.textContent = aliveCount;
  drawFrame();
});

socket.on('game:end', ({ reason, winners }) => {
  document.getElementById('gameView').style.display = 'none';
  document.getElementById('endView').style.display = 'block';
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
  document.getElementById('gameView').style.display = 'block';
  const canvas = document.getElementById('arena');
  ArenaRender.fitCanvas(canvas);
}

function drawFrame() {
  const canvas = document.getElementById('arena');
  if (!canvas || canvas.offsetParent === null) return;
  const ctx = canvas.getContext('2d');
  let players = latestPlayers;
  if (myLocalJumpUntil > Date.now()) {
    players = latestPlayers.map(p => {
      if (p.id !== myId) return p;
      const serverJump = p.jumpUntil || 0;
      return serverJump >= myLocalJumpUntil ? p : { ...p, jumpUntil: myLocalJumpUntil };
    });
  }
  ArenaRender.render(ctx, { players, dogs: latestDogs, myId });
}

// ---- Input handling ----
const keyState = { up: false, down: false, left: false, right: false };
let lastSent = '';

function keyToDir(code) {
  switch (code) {
    case 'ArrowUp': case 'KeyW': return 'up';
    case 'ArrowDown': case 'KeyS': return 'down';
    case 'ArrowLeft': case 'KeyA': return 'left';
    case 'ArrowRight': case 'KeyD': return 'right';
    default: return null;
  }
}

window.addEventListener('keydown', (e) => {
  if (document.getElementById('gameView').style.display === 'none') return;
  const dir = keyToDir(e.code);
  if (dir) {
    e.preventDefault();
    keyState[dir] = true;
    sendInput();
  } else if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) {
      myLocalJumpUntil = Date.now() + 320; // instant local feedback, matches server JUMP_MS
      socket.emit('player:jump');
    }
  }
});

window.addEventListener('keyup', (e) => {
  const dir = keyToDir(e.code);
  if (dir) {
    keyState[dir] = false;
    sendInput();
  }
});

function sendInput() {
  const payload = JSON.stringify(keyState);
  if (payload === lastSent) return;
  lastSent = payload;
  socket.emit('player:input', keyState);
}

// Stop movement if window loses focus (avoids stuck keys)
window.addEventListener('blur', () => {
  keyState.up = keyState.down = keyState.left = keyState.right = false;
  sendInput();
});
