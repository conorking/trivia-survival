# Trivia Survival — Project Context

This file is auto-read by Claude Code at the start of a session in this project.
It summarizes design decisions and current state so context isn't lost when moving
between tools/chats.

## What this is

A browser-based multiplayer icebreaker game for 30-100 participants, ~10 min rounds.
Host creates a room (join code + URL + QR), players join on their phones, and everyone
plays "Trivia Survival": answer a question by standing on trapdoor A/B/C, wrong answers
drop you through the floor, survivors get chased by dogs, last ones standing win.

Full gameplay spec, architecture rationale, and setup/deploy instructions are in `README.md`
— read that first for the "why". This file is more of a running engineering log / state
snapshot.

## Stack

- Server: Node.js, Express (static file serving) + Socket.io (realtime), no database —
  all state lives in memory in `server/rooms.js`, one `Room` object per session.
- Client: vanilla JS, no build step, no framework. Canvas 2D for the arena.
- Server is fully authoritative: it owns positions, timers, and outcomes. Clients send
  input and render; they never compute game logic themselves (avoids cheating, keeps
  every client in sync regardless of device).

## File map

- `server/server.js` — Express + Socket.io wiring, all socket event handlers, reconnect
  token lookup (`tokenIndex` Map: token → {roomCode, playerId}).
- `server/rooms.js` — the actual game: `Room` class with the full state machine, arena
  constants, tick loop. `GameManager` just tracks rooms by code.
- `server/questions-default.json` — built-in question set.
- `public/index.html` — landing (host or join).
- `public/host.html` + `public/js/host.js` — room creation, config form, lobby, live
  spectator view, end screen + rematch.
- `public/player.html` + `public/js/player.js` — join/avatar picker, keyboard input
  capture, gameplay view.
- `public/js/arena-render.js` — the only place canvas drawing happens. Shared by host
  and player. Owns its own animation state (door-opening, fall/respawn, cage pulses) via
  `onLockIn/onReveal/onDropped/onRoundComplete/onNewQuestion` — callers just tell it what
  happened, it handles timing/interpolation internally using `Date.now()`.
- `public/css/style.css` — GBA/retro pixel styling, single stylesheet, no preprocessor.

## Game state machine (server/rooms.js, `Room.tick()`)

Per-room states, driven by a single tick loop (`TICK_MS`, currently 40ms / 25Hz):

```
lobby → question → reveal → door_anim → resolve → (loop to question, or → ended)
```

- **question**: answer timer running, players move freely.
- **reveal**: (3s, `REVEAL_DELAY_MS`) cages already risen on all 3 doors (visual only —
  `doLockIn` computed real occupancy into `this.cages`/`this.exposed` right before this).
  Suspense delay before the correct answer is shown.
- At the end of `reveal`, `doReveal()` fires: kills+respawns wrong-cage players
  immediately (server truth), emits `game:reveal` + `game:dropped`, then holds in
  **door_anim** (`DOOR_OPEN_ANIM_MS`, ~1.1s) purely so clients have time to *play* the
  door-opening/fall animation before dogs show up. Server state is already "true" by
  this point — the delay is cosmetic pacing, not logic.
- **resolve**: dogs released, chase `this.exposed` (players never caged at all — NOT
  wrong-cage players, those already fell). Nearest-target chase AI, `DOG_PHASE_TIMEOUT_MS`
  safety net (~14s) force-kills stragglers so a round can never hang forever.
- On resolve complete: safe-cage players freed (`cagedAt = null`), `advanceRound()`
  decides next question vs `endGame()` (reasons: `all_eliminated`, `questions_complete`,
  `time_up`, `host_ended`).
- **ended → lobby**: `host:rematch` calls `Room.resetForRematch()` — same room/code/
  players, resets alive/ghost/cagedAt/ready, does NOT require players to rejoin.

Movement rule used throughout: a player only moves if `!player.cagedAt` — this is the
single flag that freezes someone in a cage. Ghosts (`isGhost=true`) always have
`cagedAt=null` so they roam freely, per spec.

## Known tuning constants (server/rooms.js top)

`PLAYER_SPEED=235`, `DOG_SPEED=185`, `DOG_CATCH_RADIUS=24`, `JUMP_MS=320`,
`REVEAL_DELAY_MS=3000`, `DOOR_OPEN_ANIM_MS=1100`, `DOG_PHASE_TIMEOUT_MS=14000`,
`TICK_MS=40`. If gameplay feels off, these are the first things to touch — tune before
restructuring logic.

## Reconnect model

Player gets a random `token` on join, stored client-side in `localStorage` keyed by room
code. Server keeps a `tokenIndex` Map (token → {code, playerId}) for O(1) rejoin lookup.
Disconnected players stay in `room.players` (frozen in place — input cleared, still
vulnerable to trapdoors/dogs); reconnecting within the session just re-attaches the socket.
**This token index is in-memory only** — a server restart invalidates all active sessions.
Fine for a live event; would need persistence (Redis, etc.) for anything that must survive
a redeploy mid-game.

Host reconnect is simpler/weaker: `sessionStorage` (per-tab) holds the room code, and
`host:rejoin` just re-attaches by code with no token check — anyone who knows the code
could claim host. Acceptable for the MVP/trusted-icebreaker use case; would need a real
host token if this were ever exposed to hostile users.

## Deliberately simplified for now (see README "Current scope")

- Avatars are procedural pixel-blocks (canvas rects), no sprite sheets.
- No audio yet — hook points are the socket events already firing (`game:question`,
  `game:lockin`, `game:reveal`, `game:dropped`, `player:caught`, `game:end`).
- Dog AI is simple nearest-target chase, no pathfinding/obstacle avoidance (arena is open,
  so this is fine).
- No persistence layer — rooms/tokens are in-memory, wiped on restart or after 3hr/no-
  connection sweep (`GameManager.sweep()`).

## Feedback already implemented (most recent round)

Reveal/door/fall animation sequence, colored trapdoors matching answer choices, rematch
flow, always-visible cages on lockin, copy-code buttons + toast, yellow name highlight for
"you" (no more circle), faster/more responsive movement + jump prediction, alive-count
shown to players (not just host), more prominent question-number display. All server
timing changes and client animation-state ownership described above are a result of that
round — if picking this back up, this is the most current ground truth, more current than
anything a chat transcript would say.

## If extending this

- New round-phase visuals: add state to `arena-render.js`'s internal animation state +
  a new `on___()` entry point, call it from both `host.js` and `player.js` socket
  handlers (they must stay in sync — it's easy to update one and forget the other).
- New config options: extend `sanitizeConfig()` in `server.js`, `Room.config` defaults in
  `rooms.js`, and the form in `host.html`/`host.js` — three places, always all three.
- Multiple saved question sets (vs. just default/custom): would need the server to persist
  sets somewhere (currently `customQuestions` lives only on the `Room` object, gone when
  the room ends).
