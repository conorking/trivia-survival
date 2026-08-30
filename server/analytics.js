// Lightweight, server-only usage analytics for the game's own lifecycle
// events - no third-party service, no client-side script. This app already
// went to real effort to make zero external network calls (see CLAUDE.md /
// docs/deploy-docker-cicd.md history), and gameplay here is fully server-
// authoritative, so every event logged below is something the server
// already knows firsthand - nothing new needs to phone home from the
// browser, and there's nothing here for a corporate proxy to ever block.
//
// Design constraints that shaped every choice below:
//   - Never block the event loop or a socket handler: every write is
//     fire-and-forget async, wrapped so a failure can never throw upward.
//   - Never grow unbounded: daily-rotated files + a defensive per-file size
//     cap, so a bug or a genuine flood can't fill the disk.
//   - Never log anything a player typed: no names, no custom question
//     text, no raw IPs - only the specific facts the dashboard needs.
//     Every field that *is* attacker-influenced (e.g. the User-Agent a
//     device hint is parsed from) only ever produces a small fixed-shape
//     value, and JSON.stringify escapes every string field regardless, so
//     there's no log-injection surface even so.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.ANALYTICS_DIR || path.join(__dirname, '..', 'data', 'analytics');
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB/day hard stop - see header comment

let dirReady = false;
function ensureDir() {
  if (dirReady) return;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* best-effort */ }
  dirReady = true;
}

function dayFile(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return path.join(DATA_DIR, `events-${y}-${m}-${d}.jsonl`);
}

const warnedFull = new Set(); // one console warning per file, not one per dropped event

function logEvent(type, data) {
  try {
    ensureDir();
    const file = dayFile();
    const line = JSON.stringify({ type, ts: Date.now(), ...data }) + '\n';
    fs.stat(file, (statErr, stats) => {
      if (!statErr && stats.size > MAX_FILE_BYTES) {
        if (!warnedFull.has(file)) {
          warnedFull.add(file);
          console.warn(`[analytics] ${file} exceeded ${MAX_FILE_BYTES} bytes - dropping further events for today`);
        }
        return;
      }
      fs.appendFile(file, line, (writeErr) => {
        if (writeErr) console.warn('[analytics] write failed:', writeErr.message);
      });
    });
  } catch (e) {
    // Logging must never be able to take the app down.
    console.warn('[analytics] logEvent failed:', e.message);
  }
}

// ---- Device / geo hints, parsed from headers already present on every
// request - no client-side reporting needed for either. ----
function deviceHintFromUA(ua) {
  if (!ua) return 'unknown';
  return /Mobi|Android|iPhone|iPad/i.test(ua) ? 'mobile' : 'desktop';
}

// Cloudflare adds this on every request that reaches us through the tunnel
// (see CLAUDE.md "Network access") - free, no geo lookup of our own needed.
function countryFromHeaders(headers) {
  return (headers && headers['cf-ipcountry']) || 'unknown';
}

// ---- Room-creation rate limit ----
// host:createRoom is unauthenticated and public-internet-reachable now.
// Unbounded, it'd let a script spin up unlimited real rooms (each with its
// own tick loop) as easily as it'd spam log writes - the room itself is the
// actual resource being protected here, not just the log file. Generous
// enough that no real host session should ever notice it.
const ROOM_CREATE_WINDOW_MS = 10 * 60 * 1000;
const ROOM_CREATE_MAX = 8;
const roomCreateLog = new Map(); // ip -> [creation timestamps within the window]

function allowRoomCreate(ip) {
  const now = Date.now();
  const key = ip || 'unknown';
  const kept = (roomCreateLog.get(key) || []).filter(t => now - t < ROOM_CREATE_WINDOW_MS);
  if (kept.length >= ROOM_CREATE_MAX) {
    roomCreateLog.set(key, kept);
    return false;
  }
  kept.push(now);
  roomCreateLog.set(key, kept);
  return true;
}
// Periodic sweep so this map can't grow forever across many distinct IPs.
setInterval(() => {
  const now = Date.now();
  for (const [key, arr] of roomCreateLog) {
    const kept = arr.filter(t => now - t < ROOM_CREATE_WINDOW_MS);
    if (kept.length) roomCreateLog.set(key, kept); else roomCreateLog.delete(key);
  }
}, 5 * 60 * 1000).unref();

// ---- Reader / aggregator for the /admin/analytics dashboard ----

function listRecentFiles(days) {
  ensureDir();
  let names;
  try { names = fs.readdirSync(DATA_DIR); } catch (e) { return []; }
  // Filenames are events-YYYY-MM-DD.jsonl - that date substring sorts and
  // compares lexically identically to chronological order, so a plain
  // string comparison against the cutoff date is enough, no date parsing.
  const cutoffStr = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return names
    .filter(n => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
    .filter(n => n.slice(7, 17) >= cutoffStr)
    .sort()
    .map(n => path.join(DATA_DIR, n));
}

function readEvents(days) {
  const events = [];
  for (const file of listRecentFiles(days)) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch (e) { /* skip a malformed line, never fatal */ }
    }
  }
  return events;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function countBy(arr, key) {
  return arr.reduce((acc, e) => {
    const k = String((typeof key === 'function' ? key(e) : e[key]) ?? 'unknown');
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}

// Like countBy, but for a field that's an array (questionSets - multi-select
// categories) - a game selecting ['general','music'] increments both tallies
// by 1 rather than fragmenting into a joint "general,music" bucket.
function countByArrayField(arr, getArray) {
  return arr.reduce((acc, e) => {
    for (const v of (getArray(e) || [])) {
      const k = String(v);
      acc[k] = (acc[k] || 0) + 1;
    }
    return acc;
  }, {});
}

// "Real player" is deliberately not a stored field - it's computed here
// (!isBot && playedActively) so the definition can be tuned later without
// needing to re-log anything.
function getSummary({ days = 30 } = {}) {
  const events = readEvents(days);

  const roomsCreated = events.filter(e => e.type === 'room_created');
  const gamesStarted = events.filter(e => e.type === 'game_started');
  const gamesEnded = events.filter(e => e.type === 'game_ended');
  const playersLeft = events.filter(e => e.type === 'player_left');
  const realPlayers = playersLeft.filter(e => !e.isBot);
  const activePlayers = realPlayers.filter(e => e.playedActively);

  const durations = activePlayers.map(e => e.durationMs).filter(n => Number.isFinite(n) && n >= 0);
  const avgDurationMs = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

  const playersPerRoom = {};
  for (const e of gamesStarted) {
    playersPerRoom[e.roomCode] = Math.max(playersPerRoom[e.roomCode] || 0, e.playerCount || 0);
  }
  const roomSizes = Object.values(playersPerRoom);

  const perDay = {};
  for (const e of roomsCreated) {
    const d = new Date(e.ts).toISOString().slice(0, 10);
    perDay[d] = (perDay[d] || 0) + 1;
  }

  return {
    generatedAt: Date.now(),
    windowDays: days,
    roomsCreated: roomsCreated.length,
    gamesStarted: gamesStarted.length,
    gamesEnded: gamesEnded.length,
    realPlayersSeen: realPlayers.length,
    realPlayersActive: activePlayers.length,
    bounceRatePct: realPlayers.length ? Math.round(100 * (1 - activePlayers.length / realPlayers.length)) : 0,
    avgSessionMs: Math.round(avgDurationMs),
    medianSessionMs: Math.round(median(durations)),
    avgPlayersPerRoom: roomSizes.length ? Math.round((roomSizes.reduce((a, b) => a + b, 0) / roomSizes.length) * 10) / 10 : 0,
    maxPlayersInARoom: roomSizes.length ? Math.max(...roomSizes) : 0,
    endReasons: countBy(gamesEnded, 'reason'),
    deviceBreakdown: countBy(realPlayers, 'deviceHint'),
    countryBreakdown: countBy(realPlayers, 'country'),
    config: {
      questionSets: countByArrayField(gamesStarted, e => e.config && e.config.questionSets),
      difficultyRamp: countBy(gamesStarted, e => e.config && !!e.config.difficultyRamp),
      bearTraps: countBy(gamesStarted, e => e.config && !!e.config.bearTraps),
      dogLunge: countBy(gamesStarted, e => e.config && e.config.dogLunge),
      dynamicCellScaling: countBy(gamesStarted, e => e.config && !!e.config.dynamicCellScaling)
    },
    roomsPerDay: perDay
  };
}

// Raw concatenated JSONL for the export download - reads the actual files rather than
// re-stringifying parsed events, so a malformed line (already tolerated as "skip, don't
// crash" everywhere else here) doesn't quietly get dropped from someone's own export too.
function exportJsonl({ days = 30 } = {}) {
  let out = '';
  for (const file of listRecentFiles(days)) {
    try { out += fs.readFileSync(file, 'utf8'); } catch (e) { /* skip unreadable file */ }
  }
  return out;
}

module.exports = {
  logEvent, deviceHintFromUA, countryFromHeaders, allowRoomCreate, getSummary, exportJsonl, DATA_DIR
};
