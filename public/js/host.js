const socket = io();
let roomCode = null;
let currentConfig = null;
let uploadedQuestions = null;
let myId = null; // set once the host has joined their own room as a player (Play mode)
let myToken = null;
let hostPlaying = false;
let castMode = false;
let latestPlayers = []; // raw (non-interpolated) - needed for mouse-follow steering in Play mode
let rematchCountdownEndsAt = null;

const existingCode = sessionStorage.getItem('trivia_host_room');

function attachToRoom() {
  if (roomCode || existingCode) {
    socket.emit('host:rejoin', { code: roomCode || existingCode });
  } else {
    socket.emit('host:createRoom', {});
  }
}
attachToRoom();
// Re-attach after a genuine reconnect (dropped socket, backgrounded tab, brief network
// blip) - without this the host silently loses control (Start/End/Rematch all quietly
// no-op) until the page is manually reloaded, since the server hands every new socket a
// blank slate. Fires only on an actual reconnect, never the initial connect above.
socket.io.on('reconnect', attachToRoom);

// If the browser tab is closing/navigating away, disconnect immediately rather than
// waiting for the transport to time out - keeps room presence data accurate promptly.
window.addEventListener('pagehide', () => { socket.disconnect(); });

socket.on('host:roomCreated', ({ code, config, debug, tuning, tuningMeta }) => {
  roomCode = code;
  currentConfig = config;
  sessionStorage.setItem('trivia_host_room', code);
  document.getElementById('cfgError').textContent = '';
  document.getElementById('startError').textContent = '';
  showRoomInfo(code);
  populateConfigForm(config);
  initDebug(debug, tuning, tuningMeta);
});

socket.on('host:roomState', (state) => {
  roomCode = state.code;
  currentConfig = state.config;
  ArenaRender.setArena(state.arena);
  showRoomInfo(state.code);
  populateConfigForm(state.config);
  renderPlayerList(state.players);
  initDebug(state.debug, state.tuning, state.tuningMeta);
  setDebugDockVisible(state.state !== 'lobby' && state.state !== 'ended');
  // Restores Play mode across a reconnect - the server remembers who the host's own
  // player entity is (room.hostPlayerId) even though this fresh connection doesn't.
  if (state.hostPlayer) {
    myId = state.hostPlayer.id;
    myToken = state.hostPlayer.token;
    hostPlaying = true;
  } else {
    myId = null; myToken = null; hostPlaying = false;
  }
  updatePlayModeUI();
  if (state.state === 'ended') {
    document.body.classList.remove('in-game');
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
  // If this fired in response to our initial host:rejoin attempt (roomCode never got
  // set), the stored room code is stale - most commonly because the server process
  // restarted since we last hosted (e.g. relaunching the ngrok tunnel) and its in-memory
  // rooms were wiped. Previously this left the host stuck on a dead error with no room
  // until they closed the tab (sessionStorage is per-tab, so a fresh tab skipped the
  // rejoin entirely) - fall back to creating a new room automatically instead.
  if (existingCode && !roomCode && message === 'Room not found.') {
    sessionStorage.removeItem('trivia_host_room');
    socket.emit('host:createRoom', {});
  }
});

socket.on('host:questionsUploaded', ({ count }) => {
  document.getElementById('uploadStatus').textContent = `✔ Loaded ${count} custom questions.`;
});

socket.on('room:config', (config) => { currentConfig = config; populateConfigForm(config); });

socket.on('room:players', (players) => {
  renderPlayerList(players);
});

socket.on('game:started', () => {
  rematchCountdownEndsAt = null;
  updateRematchBanner();
  showGameView();
});

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
  currentQIndex = data.index;
  currentQTotal = data.total;
  if (data.phase === 'intro') showIntro(data);
  else hideIntro();
}

socket.on('game:question', renderQuestion);
socket.on('game:answering', () => hideIntro());

// ---- Full-screen question intro overlay (state 'intro', before the answer timer) ----
// Duplicated in player.js; here INTRO_IS_HOST is on, so the host shows START ANSWERING,
// reads the question aloud, and drives the transition to the answer phase off the exact
// moment the reading finishes (host:startAnswering) rather than a fixed timer - the
// server's own intro timer is now just a long safety cap. See speakQuestion().
const INTRO_IS_HOST = true;
let introActive = false;
let introStartAt = 0, introEndsAt = 0;
let introAdvanceTimer = null;
let lastIntroData = null; // kept so toggling read-aloud back on (with nothing paused) can (re)start it

function showIntro(data) {
  introActive = true;
  introStartAt = Date.now();
  introEndsAt = data.introEndsAt || (introStartAt + 6000);
  lastIntroData = data;
  document.getElementById('introQNum').textContent = data.index + 1;
  document.getElementById('introQTotal').textContent = data.total;
  document.getElementById('introQ').textContent = data.q;
  const opts = document.getElementById('introOptions');
  opts.innerHTML = '';
  for (const key of ['A', 'B', 'C']) {
    if (!data.options[key]) continue;
    const el = document.createElement('div');
    el.className = `intro-opt ${key}`;
    el.innerHTML = `<span class="k">${key}</span>`;
    el.appendChild(document.createTextNode(data.options[key]));
    opts.appendChild(el);
  }
  const btn = document.getElementById('introStartBtn');
  if (btn) btn.style.display = 'inline-block';
  document.getElementById('introOverlay').classList.add('show');
  beginReading(data);
  updateIntroCountdown();
}

function hideIntro() {
  if (!introActive) return;
  introActive = false;
  clearTimeout(introAdvanceTimer);
  stopSpeak();
  document.getElementById('introOverlay').classList.remove('show');
}

function scheduleAdvance(ms) {
  clearTimeout(introAdvanceTimer);
  introAdvanceTimer = setTimeout(() => { if (introActive) socket.emit('host:startAnswering'); }, Math.max(0, ms));
}
function timedPause() {
  scheduleAdvance(Math.max(1500, introEndsAt - Date.now()) || 5000);
}

// Kicks off the "read it aloud, then advance" flow for the current question - split out
// of showIntro() so toggleSpeak() can re-attempt the exact same thing when unmuting finds
// nothing already paused to resume (started muted, or read-aloud wasn't available and
// already fell back to the timed pause).
function beginReading(data) {
  updateIntroHint();
  if (speakEnabled && speechAvailable()) {
    speakQuestion(data, (didSpeak) => {
      if (didSpeak) {
        // Advance a short beat after the reading actually ends (min ~2s intro total).
        scheduleAdvance(Math.max(650, 2000 - (Date.now() - introStartAt)));
      } else {
        // Engine reported voices but never spoke - fall back to the timed reading pause.
        updateIntroHint('Read the question — answering opens in a moment…');
        timedPause();
      }
    });
  } else {
    // No read-aloud: give players the server's word-scaled reading pause.
    updateIntroHint('Read the question — answering opens in a moment…');
    timedPause();
  }
}

// The intro overlay's own hint doubles as the mute toggle right where the host is
// looking while a question is actually being read - clicking it (see host.html) calls
// toggleSpeak(). `overrideText`, when given, temporarily shows a different status
// message instead (e.g. the no-read-aloud fallback) without touching the mute state.
function updateIntroHint(overrideText) {
  const el = document.getElementById('introHint');
  if (!el) return;
  el.textContent = overrideText || (speakEnabled ? '🔊 Reading Aloud' : '🔇 Reading Muted');
  el.classList.toggle('active', speakEnabled && !overrideText);
}

function updateIntroCountdown() {
  if (!introActive) return;
  const now = Date.now();
  const span = Math.max(1, introEndsAt - introStartAt);
  const frac = Math.max(0, Math.min(1, (introEndsAt - now) / span));
  const bar = document.getElementById('introCountdown');
  if (bar) bar.style.width = (frac * 100) + '%';
}
setInterval(updateIntroCountdown, 150);

function startAnswering() {
  clearTimeout(introAdvanceTimer);
  stopSpeak();
  socket.emit('host:startAnswering');
}

// ---- Read-aloud (host only): speaks the question + each option as its own utterance
// (natural pauses, and short chunks dodge Chrome's ~15s single-utterance cutoff), then
// calls onDone when the last one finishes so the round proceeds the instant the reading
// is actually done. A hard timeout also fires onDone if speech synthesis is silently
// broken (headless / no voices / some Linux) so the intro can never hang on it. ----
let speakEnabled = localStorage.getItem('trivia_host_speak') !== '0';
let speakKeepAlive = null;
let speakTimeout = null;
let speakInsuranceMs = 0; // re-armed on resume (see toggleSpeak) - the hang-safety timeout in speakQuestion
let speakDoneCb = null;
let speakStarted = false; // did the engine actually begin speaking this question?
let speakSessionActive = false; // true once an utterance chain has actually begun for the
                                 // current question - lets toggleSpeak() pause()/resume()
                                 // in place ("tune in and out") instead of restarting.

// Warm the voice list (getVoices() is often empty on first call).
if (window.speechSynthesis) {
  try { window.speechSynthesis.getVoices(); } catch (e) { /* ignore */ }
  window.speechSynthesis.onvoiceschanged = () => { try { window.speechSynthesis.getVoices(); } catch (e) {} };
}
function speechAvailable() {
  try {
    return !!(window.speechSynthesis && window.SpeechSynthesisUtterance &&
      window.speechSynthesis.getVoices && window.speechSynthesis.getVoices().length > 0);
  } catch (e) { return false; }
}

function syncSpeakToggle() {
  const b = document.getElementById('speakToggle');
  if (b) { b.textContent = speakEnabled ? '🔊 READ' : '🔇 MUTED'; b.classList.toggle('active', speakEnabled); }
  updateIntroHint();
}
function toggleSpeak() {
  speakEnabled = !speakEnabled;
  localStorage.setItem('trivia_host_speak', speakEnabled ? '1' : '0');
  syncSpeakToggle();
  if (!speakEnabled) {
    // "Tune out": pause exactly where the reading is (if it's actually mid-read) rather
    // than cancelling it outright - also pause the hang-safety timeout so a long mute
    // doesn't get mistaken for a stuck engine.
    if (speakSessionActive) {
      if (speakTimeout) { clearTimeout(speakTimeout); speakTimeout = null; }
      try { window.speechSynthesis.pause(); } catch (e) { /* ignore */ }
    }
  } else if (speakSessionActive) {
    // "Tune in": resume exactly where we paused - the round still advances normally via
    // the onDone callback already wired up for whenever the (resumed) reading finishes.
    try {
      window.speechSynthesis.resume();
      speakTimeout = setTimeout(finishSpeak, speakInsuranceMs);
    } catch (e) { /* ignore */ }
  } else if (introActive) {
    // Nothing was playing yet for this question (started muted, or read-aloud wasn't
    // available and we'd already fallen back to the timed pause) - (re)attempt it fresh.
    clearTimeout(introAdvanceTimer);
    beginReading(lastIntroData);
  }
}

function finishSpeak() {
  speakSessionActive = false;
  if (speakTimeout) { clearTimeout(speakTimeout); speakTimeout = null; }
  if (speakKeepAlive) { clearInterval(speakKeepAlive); speakKeepAlive = null; }
  const cb = speakDoneCb;
  speakDoneCb = null;
  if (cb) cb(speakStarted); // true = the reading really happened; false = engine never spoke
}
function stopSpeak() {
  speakSessionActive = false;
  if (speakTimeout) { clearTimeout(speakTimeout); speakTimeout = null; }
  if (speakKeepAlive) { clearInterval(speakKeepAlive); speakKeepAlive = null; }
  speakDoneCb = null;
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
}
function speakQuestion(data, onDone) {
  stopSpeak();
  if (!speakEnabled || !speechAvailable()) { if (onDone) onDone(); return; }
  const chunks = [String(data.q)];
  for (const key of ['A', 'B', 'C']) {
    if (data.options[key]) chunks.push(`Option ${key}. ${data.options[key]}`);
  }
  speakDoneCb = onDone;
  speakStarted = false;
  speakSessionActive = true;
  const totalWords = chunks.reduce((n, c) => n + c.trim().split(/\s+/).length, 0);
  // Insurance: onend/onerror should fire, but if the engine goes silent, don't hang.
  // ~480ms/word is slower than any real TTS, so this never preempts a working read.
  speakInsuranceMs = totalWords * 480 + 3500;
  speakTimeout = setTimeout(finishSpeak, speakInsuranceMs);

  // Some environments report voices but never actually speak (headless, sandboxed) -
  // if nothing has started ~1.2s in, treat speech as unavailable and bail (onDone gets
  // false, so showIntro falls back to the timed reading pause).
  setTimeout(() => { if (speakDoneCb !== null && !speakStarted) finishSpeak(); }, 1200);

  let i = 0;
  const next = () => {
    if (speakDoneCb === null) return; // stopped/superseded/already finished
    if (i >= chunks.length) { finishSpeak(); return; }
    try {
      const u = new SpeechSynthesisUtterance(chunks[i++]);
      u.rate = 0.98;
      u.onstart = () => { speakStarted = true; };
      u.onend = next;
      u.onerror = next;
      window.speechSynthesis.speak(u);
    } catch (e) { finishSpeak(); }
  };
  // Chrome silently pauses speechSynthesis after ~15s of continuous speech; a
  // pause()/resume() nudge keeps a long read going.
  speakKeepAlive = setInterval(() => {
    try {
      const s = window.speechSynthesis;
      if (s && s.speaking && !s.paused) { s.pause(); s.resume(); }
    } catch (e) { /* ignore */ }
  }, 8000);
  next();
}
syncSpeakToggle();

// ---- Unified phase timer: one bar + label used across every round phase ----
const PHASE_LABELS = {
  intro: () => 'Get ready…',
  question: (s) => `Choose your answer! ${s}s`,
  reveal: (s) => `Revealing the answer... ${s}s`,
  escape: (s) => `Get off the wrong doors! ${s}s`,
  fall_pause: () => 'Uh oh...',
  resolve: (s) => `Survive the dogs for another ${s}s...`,
  death_anim: () => 'Round over...'
};
const SLIM_QUESTION_STATES = new Set(['reveal', 'escape', 'fall_pause', 'resolve', 'death_anim']);
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
    const qhud = document.getElementById('questionHud');
    if (qhud) qhud.classList.toggle('slim', SLIM_QUESTION_STATES.has(state));
    bar.style.transition = 'none';
    bar.style.width = '100%';
    requestAnimationFrame(() => {
      bar.style.transition = `width ${remainingMs}ms linear`;
      bar.style.width = '0%';
    });
  }
}

// Big centered "3... 2... 1..." flash during the final seconds of a phase that actually
// demands player action - not the passive holds (reveal/fall_pause/death_anim).
const BIG_COUNTDOWN_STATES = new Set(['question', 'escape', 'resolve']);
const BIG_COUNTDOWN_THRESHOLD_MS = 3000;
let lastBigCountdownNum = null;

function updateBigCountdown(state, phaseEndsAt) {
  const el = document.getElementById('bigCountdown');
  if (!el) return;
  const remainingMs = (phaseEndsAt || 0) - Date.now();
  const show = BIG_COUNTDOWN_STATES.has(state) && remainingMs > 0 && remainingMs <= BIG_COUNTDOWN_THRESHOLD_MS;
  if (!show) {
    el.classList.remove('show');
    lastBigCountdownNum = null;
    return;
  }
  const num = Math.ceil(remainingMs / 1000);
  if (num !== lastBigCountdownNum) {
    lastBigCountdownNum = num;
    el.textContent = num;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
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
  updateCounts(data.players);
  if (data.state !== 'intro' && introActive) hideIntro();
  updatePhaseTimer(data.state, data.phaseEndsAt);
  updateBigCountdown(data.state, data.phaseEndsAt);
});

socket.on('game:end', ({ reason, winners }) => {
  hideIntro();
  // Leave gameView (and its last-rendered frame) visible behind the summary overlay,
  // instead of cutting away from the arena entirely.
  document.getElementById('endView').style.display = 'flex';
  const reasonText = {
    all_eliminated: 'Everyone was eliminated!',
    last_survivor: 'Last one standing!',
    questions_complete: 'All questions answered!',
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
  lastBigCountdownNum = null;
  document.getElementById('bigCountdown').classList.remove('show');
  rematchCountdownEndsAt = null;
  updateRematchBanner();
  hideIntro();
  document.getElementById('endView').style.display = 'none';
  document.getElementById('gameView').style.display = 'none';
  document.body.classList.remove('in-game');
  document.getElementById('lobbyView').style.display = 'block';
  populateConfigForm(config);
  renderPlayerList(players);
  setDebugDockVisible(false);
  showToast('Rematch! Players can ready up to auto-start, or hit Start Game yourself.');
});

socket.on('game:rematchCountdown', ({ endsAt }) => {
  rematchCountdownEndsAt = endsAt;
  updateRematchBanner();
});

// Mirrors updatePhaseTimer's polling approach for the "next round starting in Xs..."
// banner that appears once enough players are ready in a post-rematch lobby.
function updateRematchBanner() {
  const el = document.getElementById('rematchBanner');
  if (!el) return;
  if (!rematchCountdownEndsAt) { el.style.display = 'none'; return; }
  const s = Math.max(0, Math.ceil((rematchCountdownEndsAt - Date.now()) / 1000));
  el.textContent = `Starting next round in ${s}s...`;
  el.style.display = 'block';
}
setInterval(updateRematchBanner, 250);

function showRoomInfo(code) {
  document.getElementById('roomInfoCard').style.display = 'block';
  document.getElementById('roomCode').textContent = code;
  renderJoinUrl(code);
  refreshPublicOrigin(code);
}

function renderJoinUrl(code, originOverride) {
  const base = originOverride || location.origin;
  const url = `${base}/player.html?code=${code}`;
  document.getElementById('joinUrl').value = url;
  document.getElementById('qrcode-box').innerHTML = '';
  new QRCode(document.getElementById('qrcode-box'), { text: url, width: 120, height: 120 });
}

// Best-effort upgrade of the join link/QR to whatever address actually reaches this
// server from outside this one machine, checked in priority order:
//   1. An ad-hoc tunnel (npm run tunnel:ngrok) - if ngrok is running, its local admin
//      API (queried server-side via /api/tunnel-info) reports the public URL it
//      assigned, so this works from anywhere on the internet with zero manual steps.
//      (Cloudflare's quick tunnel has no equivalent local API to query, so that path
//      still means reading the URL cloudflared prints to its own terminal.)
//   2. If neither a tunnel is running nor the host is off localhost, the origin the
//      browser is already on works as-is (e.g. already opened via a LAN IP, a real
//      domain, or an Oracle/VPS deployment) - nothing to do.
//   3. Otherwise, if the host opened this page via localhost/127.0.0.1 (meaningless to
//      any other device), fall back to the machine's detected LAN address so at least
//      same-wifi devices can join.
let publicOriginPromise = null;
function refreshPublicOrigin(code) {
  if (!publicOriginPromise) {
    const tunnelCheck = fetch('/api/tunnel-info')
      .then(r => r.json()).then(d => d.url || null).catch(() => null);
    const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const lanCheck = isLoopback
      ? fetch('/api/lan-info')
          .then(r => r.json())
          .then(d => (d.ips && d.ips[0]) ? `http://${d.ips[0]}:${d.port}` : null)
          .catch(() => null)
      : Promise.resolve(null);
    publicOriginPromise = Promise.all([tunnelCheck, lanCheck])
      .then(([tunnelOrigin, lanOrigin]) => ({ tunnelOrigin, lanOrigin }));
  }
  publicOriginPromise.then(({ tunnelOrigin, lanOrigin }) => {
    if (roomCode !== code) return;
    if (tunnelOrigin) {
      renderJoinUrl(code, tunnelOrigin);
      showToast('Tunnel detected - join link is now public!');
    } else if (lanOrigin) {
      renderJoinUrl(code, lanOrigin);
    }
  });
}

function populateConfigForm(config) {
  document.getElementById('cfgAnswerTime').value = config.answerTimeSec;
  document.getElementById('cfgAnswerTimeRange').value = config.answerTimeSec;
  document.getElementById('cfgQuestionCount').value = config.questionCount;
  document.getElementById('cfgQuestionCountRange').value = config.questionCount;
  document.getElementById('cfgQuestionSet').value = config.questionSet;
  document.getElementById('cfgDifficultyRamp').checked = !!config.difficultyRamp;
  document.getElementById('cfgBearTraps').checked = !!config.bearTraps;
  document.getElementById('cfgDogLunge').value = config.dogLunge || 'off';
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
linkSlider('cfgAnswerTimeRange', 'cfgAnswerTime');
linkSlider('cfgQuestionCountRange', 'cfgQuestionCount');

function collectConfig() {
  return {
    answerTimeSec: Number(document.getElementById('cfgAnswerTime').value),
    questionCount: Number(document.getElementById('cfgQuestionCount').value),
    questionSet: document.getElementById('cfgQuestionSet').value,
    difficultyRamp: document.getElementById('cfgDifficultyRamp').checked,
    bearTraps: document.getElementById('cfgBearTraps').checked,
    dogLunge: document.getElementById('cfgDogLunge').value,
    dynamicCellScaling: document.getElementById('cfgDynamicCellScaling').checked
  };
}

function renderPlayerList(players) {
  document.getElementById('playerCount').textContent = players.length;
  const list = document.getElementById('playerList');
  list.innerHTML = players.map(p => `
    <div class="player-chip ${p.ready ? 'ready' : 'not-ready'} ${!p.connected ? 'dead' : ''}">
      <span class="dot" style="background:${p.color}"></span>
      ${p.name}${p.isBot ? ' 🤖' : ''} ${p.connected || p.isBot ? '' : '(offline)'}
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

// navigator.clipboard requires a secure context (HTTPS) and isn't reliably available on
// every mobile browser - falls back to the older execCommand('copy') technique (via a
// temporary offscreen textarea) so the copy buttons still work over plain HTTP on a LAN,
// which is how this is most often opened on a phone.
function copyToClipboard(text, successMessage) {
  const done = () => showToast(successMessage);
  const fail = () => showToast('Copy failed - long-press to copy manually');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, () => copyViaExecCommand(text, done, fail));
  } else {
    copyViaExecCommand(text, done, fail);
  }
}

function copyViaExecCommand(text, done, fail) {
  const el = document.createElement('textarea');
  el.value = text;
  el.style.position = 'fixed';
  el.style.opacity = '0';
  document.body.appendChild(el);
  el.focus();
  el.select();
  el.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
  document.body.removeChild(el);
  if (ok) done(); else fail();
}

function copyLink() {
  const input = document.getElementById('joinUrl');
  input.select();
  copyToClipboard(input.value, 'Link copied!');
}

function copyCode() {
  if (!roomCode) return;
  copyToClipboard(roomCode, 'Code copied!');
}

// ---- Play mode: the host joins their own room as a real player, in this same tab/socket
// (replaces the old "open a second tab" playAsPlayer, which is exactly what caused the
// desync players reported - two independent sockets/sessions instead of one).
const HOST_AVATAR_COLORS = ['#4f8fef', '#ef4f6b', '#58d68d', '#ffd23f', '#b84fef', '#ef8f4f', '#4fdada', '#ff69b4'];
let hostSelectedColor = HOST_AVATAR_COLORS[0];

(function setupHostAvatarGrid() {
  const grid = document.getElementById('hostAvatarGrid');
  if (!grid) return;
  HOST_AVATAR_COLORS.forEach((color, i) => {
    const sw = document.createElement('div');
    sw.className = 'avatar-swatch' + (i === 0 ? ' selected' : '');
    sw.style.background = color;
    sw.onclick = () => {
      grid.querySelectorAll('.avatar-swatch').forEach(el => el.classList.remove('selected'));
      sw.classList.add('selected');
      hostSelectedColor = color;
    };
    grid.appendChild(sw);
  });
})();

function showJoinAsPlayerPicker() {
  document.getElementById('hostPlayerPicker').style.display = 'block';
}
function cancelJoinAsPlayer() {
  document.getElementById('hostPlayerPicker').style.display = 'none';
}
function confirmJoinAsPlayer() {
  const name = document.getElementById('hostPlayerName').value.trim() || 'Host';
  socket.emit('host:joinAsPlayer', { name, color: hostSelectedColor });
  document.getElementById('hostPlayerPicker').style.display = 'none';
}
function leavePlayer() {
  socket.emit('host:leavePlayer');
  myId = null; myToken = null; hostPlaying = false;
  updatePlayModeUI();
}

socket.on('host:joinedAsPlayer', ({ playerId, token, arena }) => {
  myId = playerId; myToken = token; hostPlaying = true;
  ArenaRender.setArena(arena);
  updatePlayModeUI();
});

function updatePlayModeUI() {
  const joinBtn = document.getElementById('joinAsPlayerBtn');
  const leaveBtn = document.getElementById('leavePlayerBtn');
  const leaveBtnGame = document.getElementById('leavePlayerBtnGame');
  if (joinBtn) joinBtn.style.display = hostPlaying ? 'none' : 'inline-block';
  if (leaveBtn) leaveBtn.style.display = hostPlaying ? 'inline-block' : 'none';
  if (leaveBtnGame) leaveBtnGame.style.display = hostPlaying ? 'inline-block' : 'none';
}

// ---- Cast mode: purely client-side, no server involvement - hides the config/roster/
// controls for a clean full-screen view suited to projecting on a call, leaving just the
// arena + question/timer visible. See body.cast-mode .cast-hide in style.css.
function toggleCastMode() {
  castMode = !castMode;
  document.body.classList.toggle('cast-mode', castMode);
  const label = castMode ? 'EXIT CAST VIEW' : 'CAST VIEW';
  ['castToggleBtn', 'castToggleBtnGame'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.textContent = label;
  });
}

function rematch() {
  socket.emit('host:rematch');
}

function newRoom() {
  sessionStorage.removeItem('trivia_host_room');
  location.reload();
}

// Explicit "the host is leaving" signal (top-nav logo / in-game EXIT link) - tells the
// server to close the room for everyone right now, rather than leaving players stuck
// waiting on a host who isn't coming back. Distinct from a bare disconnect (page
// reload/network blip), which still gets a reconnect grace period - see server.js.
function leaveRoom() {
  socket.emit('host:leaveRoom');
  sessionStorage.removeItem('trivia_host_room');
  socket.disconnect();
  location.href = 'index.html';
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
  document.body.classList.add('in-game');
  document.getElementById('gameCodeVal').textContent = roomCode || '-----';
  const canvas = document.getElementById('arena');
  ArenaRender.fitCanvas(canvas);
  setDebugDockVisible(true);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !socket.connected) socket.connect();
});

// The host always sees the whole map (no follow mode, no joystick) regardless of window
// size - just needs to stay correctly sized/zoomable as the window resizes.
window.addEventListener('resize', () => {
  const canvas = document.getElementById('arena');
  if (canvas) ArenaRender.fitCanvas(canvas);
});

function setupZoomControls() {
  const canvas = document.getElementById('arena');
  if (!canvas) return;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    ArenaRender.adjustZoom(e.deltaY < 0 ? 1.08 : 1 / 1.08, 'overview', canvas);
  }, { passive: false });
}
setupZoomControls();

// ---- Play mode input: desktop-only subset of player.js's controls (no touch/joystick -
// this is a host console). Every handler is gated on hostPlaying so nothing fires (or
// sends input) while just spectating.
let lastSentDx = 0, lastSentDy = 0;
function sendDirInput(dx, dy) {
  if (!hostPlaying) return;
  if (dx === lastSentDx && dy === lastSentDy) return;
  lastSentDx = dx; lastSentDy = dy;
  socket.emit('player:input', { dx, dy });
}

// Mirrors the server's exponential jump-cooldown formula (server/rooms.js attemptJump)
// purely for local "instant feedback" animation prediction - see player.js's own copy.
const JUMP_BASE_COOLDOWN_MS = 300;
const JUMP_COOLDOWN_GROWTH = 2;
const JUMP_MAX_COOLDOWN_MS = 2000;
const JUMP_CHAIN_RESET_MS = 2500;
let myJumpChain = 0, myJumpCooldownUntil = 0, myLastJumpAt = 0, myLocalJumpUntil = 0;

function triggerJump() {
  if (!hostPlaying) return;
  const now = Date.now();
  socket.emit('player:jump');
  if (now < myJumpCooldownUntil) return;
  if (now - myLastJumpAt > JUMP_CHAIN_RESET_MS) myJumpChain = 0;
  const cooldown = Math.min(JUMP_MAX_COOLDOWN_MS, JUMP_BASE_COOLDOWN_MS * Math.pow(JUMP_COOLDOWN_GROWTH, myJumpChain));
  myJumpChain += 1;
  myLastJumpAt = now;
  myJumpCooldownUntil = now + cooldown;
  myLocalJumpUntil = now + 320;
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
  if (!hostPlaying) return;
  if (document.getElementById('gameView').style.display === 'none') return;
  if (introActive) return;
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
  if (dir) { keyState[dir] = false; updateKeyboardInput(); }
});
window.addEventListener('blur', () => {
  keyState.up = keyState.down = keyState.left = keyState.right = false;
  updateKeyboardInput();
  mouseFollowActive = false;
  mouseFollowTarget = null;
});

// Mouse (host, desktop): while spectating, left-drag pans the (zoomed) overview. While
// playing, left-drag walks toward that world point instead and panning moves to a
// middle-button drag or shift+left-drag; right-click still jumps. Double-click recentres.
let mouseFollowActive = false;
let mouseFollowTarget = null; // {x,y} world coords
let mousePanActive = false;
let mousePanLast = null; // {x,y} CSS px
const MOUSE_ARRIVE_DIST = 4; // world px - closer than this to the target counts as "arrived"

function getCanvasPoint(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function setupPlayModeControls() {
  const canvas = document.getElementById('arena');
  if (!canvas) return;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (document.getElementById('gameView').style.display === 'none') return;
    const wantsPan = !hostPlaying ? (e.button === 0)
      : (e.button === 1 || (e.button === 0 && e.shiftKey));
    if (wantsPan) {
      mousePanActive = true;
      mousePanLast = getCanvasPoint(canvas, e);
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      e.preventDefault();
      return;
    }
    if (!hostPlaying) return;
    if (e.button === 2) { triggerJump(); e.preventDefault(); return; } // right-click = jump
    if (e.button !== 0) return;
    if (introActive) return;
    const pt = getCanvasPoint(canvas, e);
    mouseFollowActive = true;
    mouseFollowTarget = ArenaRender.screenToWorld(canvas, pt.x, pt.y);
    if (canvas.setPointerCapture) {
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (mousePanActive) {
      const pt = getCanvasPoint(canvas, e);
      ArenaRender.panBy(pt.x - mousePanLast.x, pt.y - mousePanLast.y);
      mousePanLast = pt;
      return;
    }
    if (!hostPlaying || !mouseFollowActive) return;
    const pt = getCanvasPoint(canvas, e);
    mouseFollowTarget = ArenaRender.screenToWorld(canvas, pt.x, pt.y);
  });

  function endPointer(e) {
    if (e.pointerType !== 'mouse') return;
    if (mousePanActive) { mousePanActive = false; mousePanLast = null; return; }
    if (!mouseFollowActive) return;
    mouseFollowActive = false;
    mouseFollowTarget = null;
    sendDirInput(0, 0);
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('dblclick', (e) => { e.preventDefault(); ArenaRender.resetView(); });
}
setupPlayModeControls();

// Continuously steers toward the (fixed-until-dragged) mouse-follow target while active,
// same cadence as player.js's equivalent loop.
setInterval(() => {
  if (!hostPlaying || !mouseFollowActive || !mouseFollowTarget) return;
  const me = latestPlayers.find(p => p.id === myId);
  const originX = me ? me.x : mouseFollowTarget.x;
  const originY = me ? me.y : mouseFollowTarget.y;
  const dx = mouseFollowTarget.x - originX, dy = mouseFollowTarget.y - originY;
  const len = Math.hypot(dx, dy);
  sendDirInput(len < MOUSE_ARRIVE_DIST ? 0 : dx / len, len < MOUSE_ARRIVE_DIST ? 0 : dy / len);
}, 50);

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
  if (!canvas || canvas.clientWidth === 0) return; // hidden (fixed elements have null offsetParent even when visible)
  const ctx = canvas.getContext('2d');
  const snap = getRenderSnapshot();
  let players = snap.players;
  if (hostPlaying && myLocalJumpUntil > Date.now()) {
    players = players.map(p => {
      if (p.id !== myId) return p;
      const serverJump = p.jumpUntil || 0;
      return serverJump >= myLocalJumpUntil ? p : { ...p, jumpUntil: myLocalJumpUntil };
    });
  }
  ArenaRender.render(ctx, {
    players, dogs: snap.dogs, traps: snap.traps,
    myId: hostPlaying ? myId : null,
    viewMode: 'overview',
    mouseActive: (hostPlaying && mouseFollowActive) || mousePanActive
  });
}

(function renderLoop() {
  drawFrame();
  requestAnimationFrame(renderLoop);
})();

// ---- Debug / sandbox mode (host side) ----
// Everything here is inert unless the server was launched with --debug: initDebug()
// only wires up when told the server is in debug mode, and the DOM it controls is
// hidden by CSS until body.debug-enabled is set.
let debugEnabled = false;
let debugTuningMeta = null;
let currentQIndex = 0, currentQTotal = 0;

// The curated knobs the panel exposes, in display order. Ranges are UI hints only -
// the server re-clamps everything in setTuning().
const DEBUG_TUNABLES = [
  { key: 'PLAYER_SPEED', label: 'Player speed', min: 40, max: 600, step: 5 },
  { key: 'DOG_SPEED', label: 'Dog speed', min: 40, max: 600, step: 5 },
  { key: 'DOG_CATCH_RADIUS', label: 'Dog catch radius', min: 6, max: 120, step: 1 },
  { key: 'DOG_CATCH_CAPACITY_PCT', label: 'Dog catch cap (% of pool)', min: 0, max: 1, step: 0.01 },
  { key: 'DOG_CATCH_CAPACITY_MIN', label: 'Dog catch cap (min)', min: 0, max: 20, step: 1 },
  { key: 'DOG_GIVEUP_MS', label: 'Dog give-up (ms)', min: 1000, max: 40000, step: 250 },
  { key: 'DOG_EAT_MS', label: 'Dog eat pause (ms)', min: 0, max: 8000, step: 100 },
  { key: 'LUNGE_SPEED_MULT', label: 'Lunge speed x', min: 1, max: 5, step: 0.1 },
  { key: 'INTRO_BASE_MS', label: 'Question intro base (ms)', min: 0, max: 20000, step: 250 },
  { key: 'INTRO_MS_PER_WORD', label: 'Question intro per-word (ms)', min: 0, max: 1000, step: 10 },
  { key: 'INTRO_MAX_MS', label: 'Question intro cap (ms)', min: 1000, max: 30000, step: 250 },
  { key: 'REVEAL_DELAY_MS', label: 'Reveal delay (ms)', min: 0, max: 10000, step: 100 },
  { key: 'ESCAPE_MS', label: 'Escape window (ms)', min: 400, max: 12000, step: 100 },
  { key: 'FALL_ANIM_HOLD_MS', label: 'Fall hold (ms)', min: 0, max: 5000, step: 100 },
  { key: 'DEATH_ANIM_MS', label: 'Death hold (ms)', min: 0, max: 5000, step: 100 },
  { key: 'TRAP_ROOT_MS', label: 'Bear-trap root (ms)', min: 0, max: 8000, step: 100 },
  { key: 'JUMP_SPEED_MULT', label: 'Jump speed x', min: 1, max: 3, step: 0.05 },
  { key: 'JUMP_BASE_COOLDOWN_MS', label: 'Jump base cooldown (ms)', min: 0, max: 3000, step: 50 },
  { key: 'JUMP_MAX_COOLDOWN_MS', label: 'Jump max cooldown (ms)', min: 0, max: 8000, step: 100 }
];

function initDebug(enabled, tuning, tuningMeta) {
  if (!enabled) return;
  debugEnabled = true;
  debugTuningMeta = tuningMeta || debugTuningMeta;
  document.body.classList.add('debug-enabled');
  if (!document.getElementById('debugTuning').dataset.built) buildTuningRows();
  if (tuning) populateTuning(tuning);
}

function setDebugDockVisible(show) {
  const dock = document.getElementById('debugDock');
  if (dock) dock.style.display = (debugEnabled && show) ? 'block' : 'none';
}

function buildTuningRows() {
  const wrap = document.getElementById('debugTuning');
  wrap.dataset.built = '1';
  wrap.innerHTML = DEBUG_TUNABLES.map(t => `
    <div class="debug-tune-row">
      <label for="tune_${t.key}">${t.label}</label>
      <input type="range" id="tune_${t.key}" min="${t.min}" max="${t.max}" step="${t.step}">
      <input type="number" id="tunen_${t.key}" min="${t.min}" max="${t.max}" step="${t.step}">
    </div>
  `).join('');
  for (const t of DEBUG_TUNABLES) {
    const range = document.getElementById(`tune_${t.key}`);
    const num = document.getElementById(`tunen_${t.key}`);
    const send = debounce(() => socket.emit('debug:setTuning', { patch: { [t.key]: Number(num.value) } }), 150);
    range.addEventListener('input', () => { num.value = range.value; send(); });
    num.addEventListener('input', () => { range.value = num.value; send(); });
  }
}

function populateTuning(vals) {
  for (const t of DEBUG_TUNABLES) {
    if (vals[t.key] == null) continue;
    const range = document.getElementById(`tune_${t.key}`);
    const num = document.getElementById(`tunen_${t.key}`);
    if (range) range.value = vals[t.key];
    if (num) num.value = vals[t.key];
  }
}

function debounce(fn, ms) {
  let h = null;
  return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
}

socket.on('debug:tuning', (vals) => populateTuning(vals));

function debugEmit(evt) { socket.emit(evt); }

function debugAddBots(n) { socket.emit('debug:addBots', { count: n }); }
function debugClearBots() { socket.emit('debug:removeBots', {}); }
function debugSetBotAccuracy(pct) {
  document.getElementById('botAccVal').textContent = pct;
  socket.emit('debug:setBotAccuracy', { value: Number(pct) / 100 });
}

function debugSandboxStart() {
  socket.emit('debug:sandboxStart', {
    count: 5,
    config: collectConfig(),
    joinAsPlayer: document.getElementById('dbgControlAvatar').checked,
    name: 'Host',
    color: hostSelectedColor
  });
}

function debugGoto(delta) {
  const target = currentQIndex + delta;
  if (target < 0 || target >= currentQTotal) return;
  socket.emit('debug:gotoQuestion', { index: target });
}
function debugGotoExact() {
  const v = Number(document.getElementById('dbgGotoQ').value);
  if (!v) return;
  socket.emit('debug:gotoQuestion', { index: v - 1 }); // UI is 1-based
}
