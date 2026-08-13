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
- `server/questions-default.json` — built-in general-knowledge question set (120 entries).
- `server/questions-webdev.json` — built-in web-dev question set (200 entries: HTML, CSS,
  JavaScript, React, general tooling).
- `public/index.html` — landing (host or join).
- `public/host.html` + `public/js/host.js` — room creation, config form, lobby, live
  spectator view, end screen + rematch.
- `public/player.html` + `public/js/player.js` — join/avatar picker, keyboard + touch/
  pointer input capture, gameplay view.
- `public/js/arena-render.js` — the only place canvas drawing happens. Shared by host
  and player. Owns its own animation state (door-opening, fall/respawn, cage pulses,
  death/blood-puddle, per-player RUN!/SAFE! prompts, pen gate) via `onLockIn/onReveal/
  onDropped/onCaught/onDogsReleased/onRoundComplete/onNewQuestion` — callers just tell
  it what happened, it handles timing/interpolation internally using `Date.now()`. Also
  home to the optional sprite-loading plumbing (see `public/sprites/README.md`) and
  `setArena`/`setTrapdoors` (arena geometry can change per-room per-round now — see
  dynamic cell scaling below).
- `public/css/style.css` — GBA/retro pixel styling, single stylesheet, no preprocessor.

## Arena geometry (server/rooms.js)

Portrait orientation, `ARENA_W=400`/`ARENA_H=720` (phone-friendly). Dog pen top-center,
trapdoor row along the bottom, open field between. `TRAPDOORS` (module constant) is the
*base* layout; each `Room` also has its own `this.trapdoors`, recomputed by
`computeTrapdoorsForRound()`, which layers two independent adjustments on top of the
base width/height:
- **Width** (opt-in, `config.dynamicCellScaling`): shrinks each door, centered on its
  fixed horizontal midpoint, from `CELL_SCALE_START` (1.15x) at round 1 down to
  `CELL_SCALE_END` (0.55x, floored by `MIN_DOOR_DIM`) by the last round, interpolated on
  `currentQuestionIndex`. Off by default = always base width.
- **Height** (always on, not a setting): grows with `this.players.size` so a full room
  can physically fit in one cage — `PLAYER_COUNT_HEIGHT_PER_PLAYER` per player above
  `PLAYER_COUNT_HEIGHT_THRESHOLD` (20), capped at `PLAYER_COUNT_HEIGHT_MAX_BOOST` (90px).
  Anchored to the door's *bottom* edge (grows upward) rather than centered, so it can
  never push the floor below the canvas regardless of how much it grows.

**Every in-method reference to cage geometry uses `this.trapdoors`, never the module
`TRAPDOORS` constant** — that distinction matters if you're adding new trapdoor-aware
logic. Recomputed in `start()` and `advanceRound()`'s continue branch; sent to clients
in `emitQuestion()`'s payload (`trapdoors: this.trapdoors`) since it can differ round to
round, plus once up front via `player:joined`/`player:rejoined`/`host:roomState`'s
`arena` field. Client-side, `ArenaRender.setArena()` sets the whole geometry once;
`setTrapdoors()` is the lighter per-round update for just the cage rects.

The dog pen (`DOG_PEN`, fixed, not room-scoped) is solid for players at all times now
(`resolveCircleRect` push-out alongside the trapdoor-cage one, both containment passes
in `tick()`) — walking through it during the answer phase used to be possible, no longer
is. Dogs are never checked against it (they live there); ghosts still pass through
everything, unaffected.

## Game state machine (server/rooms.js, `Room.tick()`)

Per-room states, driven by a single tick loop (`TICK_MS`, currently 40ms / 25Hz):

```
lobby → question → reveal → escape → fall_pause? → resolve → death_anim → (loop to question, or → ended)
```

- **question**: answer timer running, players move freely.
- **reveal**: (3s, `REVEAL_DELAY_MS`) cages already risen on all 3 doors (visual only —
  `doLockIn` computed real occupancy into `this.cages`/`this.exposed` right before this,
  and set `cageSolid` true on all 3). Suspense delay before the correct answer is shown.
  Caged players can move/jump inside their own cage during this whole phase — they're
  contained, not frozen (see movement rule below).
- At the end of `reveal`, `doReveal()` fires: wrong doors open (`cageSolid[key]=false`,
  `pitOpen[key]=true`) and their occupants are freed (`cagedAt=null`) but **not killed**.
  State becomes **escape** (`ESCAPE_MS`, ~2.4s) — a real physics window, not just a
  cosmetic pause: anyone (the freed occupant or anyone who wanders in) standing on an
  open pit is safe *during* this window and only falls if still there when it ends.
  The exact deadline (`escapeEndsAt`) is sent to clients in the `game:reveal` payload so
  the door's visual snap-open (`arena-render.js`) can be timed to the same instant the
  pit actually goes lethal, instead of a fixed local animation duration — see "Trapdoor
  animation timing" below. If enabled, bear traps (`config.bearTraps`) spawn at this
  point (`spawnTraps()`), rooting (`player.rootedUntil`) anyone who steps on an unsprung
  one — **they stay armed all the way through `resolve` too** (extra danger if a dog
  chases you onto one), only clearing in `finishRound()` once the round is fully over.
- At the end of `escape`, `doEscapeEnd()` fires: anyone still on an open pit falls
  (`fallIntoPit`/`game:dropped`). If anyone fell, state becomes **fall_pause**
  (`FALL_ANIM_HOLD_MS`, ~1s) purely so the client's fall animation has time to play
  before dogs show up; if nobody fell, it skips straight to releasing the dogs.
- **resolve**: dogs released (`releaseDogs`) hunting whoever currently has `!cagedAt`
  (computed fresh each tick — this is also when standing on an open pit becomes
  instantly lethal, movement-block-gated to this state only). Dogs are **always
  visible in their pen** (they exist in `'home'` state from room creation onward, not
  just during the chase) and use persistent per-dog target claims (nearest *unclaimed*
  target first, falling back to nearest overall so a dog is never idle while anyone's
  huntable) + `seek+avoid` steering around the 3 trapdoor rects (always avoided, solid
  or open) so they don't cut through cages/pits, plus a dog-dog separation pass so they
  don't stack. Each dog's catch cap (`dog.capacity`) is computed once at release as
  `max(DOG_CATCH_CAPACITY_MIN, round(huntPoolSize * DOG_CATCH_CAPACITY_PCT))` — scales
  with the crowd instead of a flat number. On a catch, a dog pauses in a `'eating'`
  state for `DOG_EAT_MS` (~2.5s, holds position) before resuming the hunt or heading
  home. A dog goes `'returning'` (walks itself home) once it's at/over capacity or
  `DOG_GIVEUP_MS` (~9s) has passed since release, then `'home'` on arrival. If
  `config.dogLunge` is `'low'` or `'high'` (default `'off'`), a hunting dog with a target
  in range gets occasional windup-then-speed-burst lunges (small state machine on the
  dog: `lungePhase` `'idle'→'windup'→'lunging'→'idle'`, cooldown-gated) — frequency/
  cooldown come from `LUNGE_PRESETS[config.dogLunge]` (`{chance, checkIntervalMs,
  cooldownMs}`); windup/duration/speed multiplier stay fixed regardless of preset, only
  frequency differs. Off by default, dogs behave exactly as before when disabled. The
  phase ends when either **all dogs are home** or
  **everyone outside the safe cage is dead**
  — a round can end with live survivors if the dogs simply got full/bored first.
  Whichever way it ends, every dog is snapped back to `'home'` at its exact pen slot
  right then (even if mid-chase/mid-eat) so the pen always reads correctly going into
  the next round. `DOG_PHASE_HARD_TIMEOUT_MS` (~30s) is a last-resort safety net that
  forces all dogs home instantly; it never kills anyone.
- **death_anim**: a short hold before finishing. If the round ended because everyone
  died, this waits until `DEATH_ANIM_MS` (~1.3s) after the last death — dog catch *or*
  pit fall, both update `this.lastDeathAt` — so the client's fall-over + blood-puddle
  animation (`player:caught` → `ArenaRender.onCaught`) has time to play. If it ended via
  dogs-all-home with survivors, it's just a small (`HOME_SETTLE_MS`) buffer.
  `finishRound()` then frees the safe cage (`cagedAt=null`, `cageSolid[correct]=false`)
  and calls `advanceRound()` (reasons: `all_eliminated`, `questions_complete`,
  `host_ended` — there's no overall game-duration cap anymore, see below). Dogs are *not*
  cleared here — they're already parked at home.
- **ended → lobby**: `host:rematch` calls `Room.resetForRematch()` — same room/code/
  players, resets alive/ghost/cagedAt/ready/hazards, does NOT require players to rejoin.

Movement rule used throughout: caged players (`player.cagedAt` set) can move and jump
but are clamped inside their own trapdoor rect; free players are pushed out of any
`cageSolid` rect they don't belong in (`resolveCircleRect`) and separated from other
players (`separatePairs`) every tick. Ghosts (`isGhost=true`) always have
`cagedAt=null` and skip all collision/containment — they roam freely, per spec. A
rooted player (`rootedUntil > now`, from a bear trap) simply has their input ignored for
movement that tick — everything else (separation, containment) still applies normally.

There's no `config.durationSec`/`gameEndsAt` overall-length cap anymore (removed —
it was invisible to players and redundant with `answerTimeSec × questionCount`, which
already bounds a game). If re-adding any kind of wall-clock safety net, surface it to
players somewhere — that lack of visibility was the whole reason it got pulled.

### Directional jump + exponential cooldown backoff

Jump stopped being purely cosmetic: while `jumpUntil` is active (`JUMP_MS`, ~320ms) and
the player has direction input, `tick()`'s movement step multiplies their speed by
`JUMP_SPEED_MULT` (1.55x) — so jumping while moving is a small forward burst; jumping
while stationary is still just the visual squash/stretch, nothing to boost. Consecutive
jumps are rate-limited by `Room.attemptJump(player, now)`: cooldown starts at
`JUMP_BASE_COOLDOWN_MS` (300ms) and doubles (`JUMP_COOLDOWN_GROWTH`) each consecutive
jump, capped at `JUMP_MAX_COOLDOWN_MS` (2000ms) — a couple of quick jumps are fine, then
you're locked at the 2s cap until you stop jumping for `JUMP_CHAIN_RESET_MS` (2500ms,
longer than the cap itself, so hitting the cap doesn't immediately reset it), which
resets the chain back to fresh. `server.js`'s `player:jump` handler just calls
`room.attemptJump()` — all the logic lives in `rooms.js`. Client-side, `player.js`
mirrors the exact same formula (`myJumpChain`/`myJumpCooldownUntil`) purely to decide
whether to play the local optimistic jump animation — the server remains the sole
authority on the actual speed-boost effect regardless of what the client predicts.

### Trapdoor animation timing (public/js/arena-render.js)

Two visuals that used to be conflated are now deliberately decoupled: the **cage bars**
fade out fast (`BAR_FADE_MS`, ~250ms) right at `reveal`/escape-start, signaling "you're
free to move" the instant that's actually true; the **door/pit itself** stays visually
shut (shuddering in the last `SHUDDER_MS` before the deadline as a warning) and snaps
open in a fast `SNAP_MS` (~180ms) exactly at the server's `escapeEndsAt` — i.e. the same
instant the pit becomes lethal, driven off the timestamp from `game:reveal`, not a fixed
local duration. The sliding door-half draw calls are wrapped in a canvas clip to the
trapdoor's own rect so a fast snap can never visually spill onto the surrounding floor.
The door no longer carries text captions at all (`LOCKED`/`SAFE ✓`/etc. are gone) — its
letter is now stenciled directly onto the floor of the cage itself (only while the panel
with it painted on is still there — it "leaves" once the door pops open), and the
situational text moved to a **per-player** prompt instead (next section), which reads
far better than a caption pinned to a fixed spot near the bottom of a portrait canvas.

### Per-player RUN!/SAFE! prompts

`game:lockin`'s payload (`{cages, exposed}`) is threaded through to
`ArenaRender.onLockIn(cages)` (previously called with no args even though the data was
already there). `onReveal()` cross-references that with the revealed `correct` key to
build two id sets — wrong-cage occupants get "RUN!" drawn above their head, the
correct-cage occupant(s) get "SAFE!" — visible from `revealedAt` until `escapeEndsAt`.
Both host and player views render this identically (spectator included).

### One global phase timer (public/js/{player,host}.js)

`game:tick` now carries `phaseEndsAt: this.phaseEndsAt` (previously only meaningful
during `question`; `releaseDogs()` now also sets it to the dog give-up deadline so
`resolve` has one too — every other phase already set it as part of its own transition).
A single `updatePhaseTimer(state, phaseEndsAt)`, duplicated the same way in both client
files, drives the `#timerBar` width transition (only restarts on an actual state change,
tracked via `lastPhaseState`, reset to `null` on `game:rematch`) plus a `#phaseLabel`
text line recomputed every tick so embedded countdowns (e.g. "Survive the dogs for
another Xs...") stay live. This replaced the old `question`-only `animateTimer()` call
and the on-canvas "dogs give up in Xs" badge (`drawChaseCountdown`, removed from
`arena-render.js`) — there's now exactly one timer UI element used by every phase.

### Input protocol: continuous {dx,dy}, not up/down/left/right booleans

`player:input` now sends `{dx, dy}` (each roughly in [-1,1], re-normalized server-side)
instead of four booleans — `server.js`'s handler clamps and stores it as-is, and
`tick()`'s movement step just normalizes whatever's there. Keyboard input
(`public/js/player.js`) still computes one of 8 discrete directions from WASD/arrows,
just converts to a vector before sending; touch/mouse (Pointer Events on `#arena`) holds
down and drags to continuously steer toward the current pointer position (recomputed on
an interval so it keeps tracking as you approach), or a quick tap (short duration, tiny
movement) triggers a jump instead of a move. Both sources feed the same `sendDirInput()`.

### End-of-game overlay

`game:end` no longer hides `#gameView` — since the server stops ticking once
`state==='ended'`, the canvas simply keeps showing its last-rendered frame. `#endView`
is now a `position:fixed` overlay (`.end-overlay` in `style.css`) drawn on top of that
frozen frame instead of replacing it. `game:rematch` still explicitly hides both before
returning to the lobby. The host's *reconnect* path (`host:roomState` with
`state==='ended'`) keeps the old hide-and-show behavior — no meaningful last frame
exists for a fresh reconnect.

### Client-side rendering: interpolated rAF loop, decoupled from tick arrival

Both `player.js` and `host.js` used to redraw the canvas synchronously inside the
`game:tick` handler — capped at the server's 25Hz broadcast rate and at the mercy of
network jitter, which read as visible stutter. Now `game:tick` only *pushes* the
incoming snapshot into a small ring buffer (`snapshotBuffer`, capped at 8) via
`pushSnapshot(players, dogs, traps)`; an independent `requestAnimationFrame` loop
(`renderLoop()`, started once at load) calls `drawFrame()` every real display frame.
`drawFrame()` asks `getRenderSnapshot()` for the interpolated state at
`Date.now() - INTERP_DELAY_MS` (~80ms, ~2 ticks) — always rendering slightly in the past
so there are always two *real* snapshots on either side to lerp between (no
extrapolation/guessing). Players interpolate by `id`; dogs interpolate by array index
(there are always exactly 3, in a stable order) and also lerp `angle` (shortest-path,
`lerpAngle`) so a turning dog doesn't visually snap. `player.js` keeps a separate raw
`latestPlayers` (not interpolated) alongside the buffer — it's needed for pointer-control
targeting and status-text bookkeeping, which want the *actual* current server state, not
a deliberately-delayed render-only view.

### Responsive layout: fills the screen, fits without scrolling

`#gameView` is a flex column with its height bound to the viewport
(`calc(100dvh - 76px)`, `vh` fallback first for older browsers — the 76px reserves room
for `.container`'s own padding plus the persistent `.top-nav` above it) — every child
except `canvas#arena` is `flex: 0 0 auto` (sized to its own content), and the canvas is
the one `flex: 1 1 auto` element that absorbs whatever vertical space is left, with
`aspect-ratio: 400/720` deriving its width from that resolved height (capped by
`max-width`/`max-height` so it doesn't get silly on a huge monitor). This one mechanism
handles both ends: on a short phone viewport the canvas shrinks to guarantee everything
(HUD + canvas) fits without scrolling; on a tall/large display there's a lot of leftover
height, so the canvas — and therefore the whole game — renders correspondingly bigger.
A `@media (max-height: 700px)` pass further trims HUD padding/margins (not font sizes —
readability took priority over a few extra px of canvas after a previous pass shrank
text too aggressively) on very short screens. Because CSS now controls `#gameView`'s
`display` value (`flex`, not `block`), `showGameView()` in both client files must set
`style.display = 'flex'` — setting `'block'` there would silently break this layout
(inline styles beat the stylesheet). The touch-control reminder used to be a `<p>` below
the canvas costing its own line of vertical space; it's now drawn as a faint watermark
inside the canvas itself (`drawControlsHint()` in `arena-render.js`, player view only).

### App navigation and clipboard copy

A persistent `.top-nav` (logo + optional subtitle) sits outside every view div in both
`host.html` and `player.html`, so there's always a one-tap way back to `index.html` —
previously the only escape from a live game was closing the tab. On `player.html` the
logo calls `backToMenu()` (the same explicit-disconnect function as the end screen's
button, not a bare link) since leaving mid-game should register as leaving; on
`host.html` it's a plain link (no equivalent "presence" concern for the host).
`copyLink()`/`copyCode()` in `host.js` route through a shared `copyToClipboard()` that
tries `navigator.clipboard` (requires a secure context — HTTPS/localhost) first and
falls back to a hidden-textarea + `execCommand('copy')` otherwise, since a LAN-IP host
page is plain HTTP and `navigator.clipboard` silently isn't there on a lot of mobile
browsers in that case.

## Known tuning constants (server/rooms.js top)

`PLAYER_SPEED=235`, `DOG_SPEED=185`, `DOG_RADIUS=13`, `DOG_CATCH_RADIUS=24`,
`DOG_HOME_RADIUS=26`, `DOG_CATCH_CAPACITY_PCT=0.25`, `DOG_CATCH_CAPACITY_MIN=2`,
`DOG_GIVEUP_MS=9000`, `DOG_EAT_MS=2500`, `DOG_PHASE_HARD_TIMEOUT_MS=30000`,
`JUMP_MS=320`, `REVEAL_DELAY_MS=3000`, `ESCAPE_MS=2400`, `FALL_ANIM_HOLD_MS=1000`,
`DEATH_ANIM_MS=1300`, `HOME_SETTLE_MS=500`, `OBSTACLE_MARGIN=18`,
`TRAP_TRIGGER_RADIUS=20`, `TRAP_ROOT_MS=1800`, `TICK_MS=40`. Jump:
`JUMP_SPEED_MULT=1.55`, `JUMP_BASE_COOLDOWN_MS=300`, `JUMP_COOLDOWN_GROWTH=2`,
`JUMP_MAX_COOLDOWN_MS=2000`, `JUMP_CHAIN_RESET_MS=2500`. Dog lunge (opt-in, `'low'`/
`'high'`): `LUNGE_RANGE=140`, `LUNGE_WINDUP_MS=150`, `LUNGE_DURATION_MS=450`,
`LUNGE_SPEED_MULT=2.1`, plus per-preset `LUNGE_PRESETS.low/high` (`chance`,
`checkIntervalMs`, `cooldownMs`). Dynamic cell scaling (opt-in): `CELL_SCALE_START=1.15`,
`CELL_SCALE_END=0.55`, `MIN_DOOR_DIM=40`. Cage player-count height boost (always on):
`PLAYER_COUNT_HEIGHT_THRESHOLD=20`, `PLAYER_COUNT_HEIGHT_PER_PLAYER=1.4`,
`PLAYER_COUNT_HEIGHT_MAX_BOOST=90`. Client-side mirrors: `arena-render.js` has
`BAR_FADE_MS=250`, `SHUDDER_MS=500`, `SNAP_MS=180`, `GATE_ANIM_MS=450`; `player.js`
mirrors the jump-cooldown constants for local animation prediction. If gameplay feels
off, these are the first things to touch — tune before restructuring logic.

## Reconnect model

Player gets a random `token` on join, stored client-side in `localStorage` keyed by room
code. Server keeps a `tokenIndex` Map (token → {code, playerId}) for O(1) rejoin lookup.
Disconnected players stay in `room.players` (frozen in place — input cleared, still
vulnerable to trapdoors/dogs); reconnecting within the session just re-attaches the socket.
**This token index is in-memory only** — a server restart invalidates all active sessions.
Fine for a live event; would need persistence (Redis, etc.) for anything that must survive
a redeploy mid-game.

`player.connected` (and the "need 2 players"/rematch-eligible counts derived from it) used
to lag reality by up to Socket.IO's default ~45s ping timeout — long enough that a host
clicking Rematch right after a player hit "back to menu" would still see that player
counted as present. Two fixes, belt-and-suspenders: `new Server(server, {...})` now sets
`pingInterval: 5000, pingTimeout: 5000` (detects a genuinely dead connection within ~10s
instead of ~45s), and both client files proactively call `socket.disconnect()` — which
sends an immediate, clean disconnect rather than waiting on the transport to time out —
on the explicit "back to menu" action and on the `pagehide` event (fires reliably on both
desktop and mobile for any other way of leaving: closing the tab, browser back, etc.).

Host reconnect is simpler/weaker: `sessionStorage` (per-tab) holds the room code, and
`host:rejoin` just re-attaches by code with no token check — anyone who knows the code
could claim host. Acceptable for the MVP/trusted-icebreaker use case; would need a real
host token if this were ever exposed to hostile users.

## Network access (LAN + internet without hosting)

`server.js` exposes `GET /api/lan-info` (uses `os.networkInterfaces()` to find non-
internal IPv4 addresses) so the host page can detect when it's been opened via
`localhost`/`127.0.0.1` (meaningless to any *other* device) and swap in the machine's
real LAN address for the join link/QR code — see `maybeUseLanOrigin()` in `host.js`.
Getting the join link right always comes down to "what origin is the browser actually
on" — the same reasoning is why a tunnel (documented in README's "Playing over the
internet" section — `npm run tunnel:ngrok` / `tunnel:cloudflared`) needs no server code
changes at all: the join link is built from `window.location.origin`, which is correctly
the tunnel's public URL once the host opens *that* URL instead of `localhost`.

## Deliberately simplified for now (see README "Current scope")

- Avatars are procedural pixel-blocks (canvas rects) by default — sprite-loading
  plumbing exists (`public/sprites/README.md`, `arena-render.js`'s `trySprite`/`SPRITES`)
  and is used automatically the moment `sprites/player.png`/`sprites/dog.png` exist, but
  no actual art ships with the project yet.
- No audio yet — hook points are the socket events already firing (`game:question`,
  `game:lockin`, `game:reveal`, `game:dropped`, `player:caught`, `game:dogs_released`,
  `game:end`).
- Dog AI is local steering (seek target + avoid the 3 trapdoor rects, with a tangential
  slide around whichever edge is closer), not full pathfinding — see the state machine
  section above. Fine for this arena's small, static, all-rectangular obstacle set;
  would need a real nav-mesh/A* if the arena ever grows more complex obstacles.
- No persistence layer — rooms/tokens are in-memory, wiped on restart or after 3hr/no-
  connection sweep (`GameManager.sweep()`).
- Three question sources per room (`config.questionSet`): `default` (120 general-
  knowledge entries), `webdev` (200 HTML/CSS/JS/React entries), or `custom` (one JSON
  upload, lives only on the `Room` object, gone when the room ends). `questionCount` can
  go up to 200 to match the larger set. Every question's A/B/C letter assignment is
  reshuffled per-build (`shuffleOptionLetters` in `buildQuestionSet()`) regardless of
  source, so the same question won't always have its answer on the same letter across
  rounds/rematches.

## Feedback already implemented (most recent round)

Bug fixes: mobile clipboard copy (secure-context fallback, see "App navigation and
clipboard copy" above); config sliders now stack on their own line below ~520px
(`.config-row`) instead of overlapping. Removed `config.durationSec`/`gameEndsAt`
entirely (redundant overall-length cap, invisible to players anyway — see the state
machine section above). Dog lunge went from a flat boolean to `'off'/'low'/'high'`
(`LUNGE_PRESETS`), tuned quieter than the old always-on values. Trapdoor cages now grow
taller (never shrink) with the room's player count, independent of dynamic cell scaling
— see "Arena geometry" above. Text sizes bumped up (and the short-viewport media query
stopped shrinking fonts, only padding) for small-screen readability. Added a persistent
top-nav (logo → home) on every view, and moved the touch-controls reminder off its own
`<p>` line into a faint canvas watermark — see "App navigation" and "Responsive layout"
above. New `questions-webdev.json` (200 entries) alongside the default set, selectable
per room, plus `questionCount` cap raised to 200 to match. Jump is no longer purely
cosmetic: it's now a brief directional speed burst with exponential-backoff cooldown —
see "Directional jump + exponential cooldown backoff" above. All of the above is a
result of that round — if picking this back up, this is the most current ground truth,
more current than anything a chat transcript would say.

## If extending this

- New round-phase visuals: add state to `arena-render.js`'s internal animation state +
  a new `on___()` entry point, call it from both `host.js` and `player.js` socket
  handlers (they must stay in sync — it's easy to update one and forget the other).
- New config options: extend `sanitizeConfig()` in `server.js`, `Room.config` defaults in
  `rooms.js`, and the form in `host.html`/`host.js` (now applied at `host:startGame` time
  via `collectConfig()` in `host.js` — there's no separate save step/event anymore).
- Multiple saved question sets (vs. just default/custom): would need the server to persist
  sets somewhere (currently `customQuestions` lives only on the `Room` object, gone when
  the room ends).
