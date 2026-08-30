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
- `server/questions-default.json` — built-in general-knowledge question set (400
  entries: everyday trivia — geography, history, science, pop culture, food, animals,
  sports, art, language, etc.).
- `server/questions-webdev.json` — built-in web-dev question set (400 entries: HTML, CSS,
  JavaScript, React, general tooling).
- `server/questions-hard.json` — built-in "Hard Mode" question set (400 entries): harder/
  trickier general-knowledge questions across geography, history, science, literature,
  mythology, math/logic, sports, etymology, and astronomy — many deliberately built
  around common misconceptions (e.g. "which gas do humans exhale most?" → nitrogen, not
  CO₂) rather than just obscure facts.
  Each entry in all three files carries a `"difficulty"` field (1-5) used by
  `config.difficultyRamp` — see "Difficulty ramp" further down.
- `public/index.html` — landing (host or join).
- `public/host.html` + `public/js/host.js` — room creation, config form, lobby, live
  spectator view (always the `'overview'` camera — whole map, scroll-wheel zoom), end
  screen + rematch.
- `public/player.html` + `public/js/player.js` — join/avatar picker, keyboard + virtual-
  joystick/pinch-zoom touch input, gameplay view. Picks `'follow'` vs `'overview'`
  camera mode from a viewport-width breakpoint — see "Camera system" below.
- `public/js/arena-render.js` — the only place canvas drawing happens. Shared by host
  and player. Owns its own animation state (door-opening, fall/respawn, cage pulses,
  death/blood-puddle, per-player RUN!/SAFE! prompts, pen gate) via `onLockIn/onReveal/
  onDropped/onCaught/onDogsReleased/onRoundComplete/onNewQuestion` — callers just tell
  it what happened, it handles timing/interpolation internally using `Date.now()`. Also
  home to the optional sprite-loading plumbing (see `public/sprites/README.md`),
  `setArena`/`setTrapdoors` (arena geometry can change per-room per-round now — see
  dynamic cell scaling below), and the camera/zoom system, joystick rendering, and
  off-screen trapdoor indicators — see "Camera system" below.
- `public/css/style.css` — GBA/retro pixel styling, single stylesheet, no preprocessor.

## Camera system, virtual joystick, zoom, off-screen indicators (client-side only)

Added when real mobile testing showed the old "whole map always visible, narrow
portrait canvas" approach didn't give players enough room to see or control precisely.
**No server/wire-protocol changes were needed for any of this** — the server still just
receives the same `{dx,dy}` input it always has; camera/zoom/joystick are purely
client-side rendering + input concerns.

- **Two view modes**, chosen per `render()` call via `viewMode: 'follow' | 'overview'`:
  `'overview'` (host always; player above the mobile breakpoint) centers the camera on
  the world center with no panning, zoom-only, default zoom = whole world fits the
  canvas. `'follow'` (player below the breakpoint) centers on the player's own
  interpolated position instead, clamped (`updateCamera` in `arena-render.js`) so the
  viewport never shows past the world edges — if half the viewport in world units would
  exceed the world size on an axis, it just centers on that axis instead of clamping.
  `player.js` decides the mode from `window.innerWidth <= MOBILE_BREAKPOINT` (820px,
  matching style.css's breakpoint below), rechecked on `resize`/`orientationchange`;
  `host.js` always passes `'overview'`.
- **Camera state** (`{x, y, zoom, panX, panY}`) is owned by `arena-render.js`, recomputed
  every `render()` call by `updateCamera()`. Zoom range is always `[wholeWorldFits, ...]`
  — you can never zoom out past seeing the entire map — with a mode-specific max
  (`OVERVIEW_ZOOM_MAX_MULT`/`FOLLOW_ZOOM_MAX_MULT`, relative to that mode's default
  zoom). Resets to the mode's default zoom on a mode switch; otherwise just clamps into
  range each frame, so wheel/pinch-set zoom persists frame to frame and survives resize.
  `adjustZoom(factor, viewMode, canvas)` is called from wheel (desktop) and pinch
  (`player.js` only).
- **Panning** (`overview` only — `follow` always tracks the player): `panX/panY` are a
  world-unit offset on top of the derived world-centre, re-clamped to the world edges
  each `updateCamera()` and forced to 0 whenever the whole map already fits (zoom ==
  fit). `panBy(dxCss, dyCss)` (drag delta ÷ zoom), `resetPan()`, and `resetView()`
  (pan 0 + zoom back to the mode default) are exported. Drag gestures: **host** —
  left-drag while spectating, middle-drag or shift+left-drag while playing; **desktop
  player** — right-button *drag* (a right-button *click* with no movement is still a
  jump, disambiguated on `pointerup` by total movement). Double-click → `resetView()`.
  `screenToWorld()` derives from `camera.x/y` (which now include pan) so click-to-walk
  targeting stays correct with no extra math.
- **Rendering**: `render()` wraps the *entire pre-existing* world-space draw sequence
  (`drawFloor`/`drawDogPen`/`drawTrapdoors`/players/dogs/etc. — none of them changed
  internally) in one `ctx.translate → ctx.scale(camera.zoom) → ctx.translate(-camera.x,
  -camera.y)` transform, then `ctx.restore()`s back to screen space to draw UI that
  isn't part of the world: the joystick (`drawJoystick`, only while `joystick` is passed
  in), an idle touch hint (`drawTouchHint`, replaces the old world-space "Hold & drag..."
  watermark), and off-screen trapdoor indicators (`drawOffscreenIndicators` — always
  runs; self-limiting, since a door that's actually in view is a no-op, so it does
  nothing in default `'overview'` zoom and only matters once zoomed in enough — mobile
  `'follow'` mode or a zoomed-in desktop `'overview'` — that a door falls outside the
  visible (margin-inset) viewport, in which case it clamps to the inset edge along the
  ray from screen-center and draws a colored arrow + letter there).
- **Canvas sizing** (`fitCanvas`, in `arena-render.js`): sizes the backing buffer to the
  canvas's actual *displayed* CSS size × `devicePixelRatio` (crisp on high-DPI screens),
  independent of the world's aspect ratio now that the camera handles world→screen
  mapping — `ctx.setTransform(dpr,0,0,dpr,0,0)` (not `ctx.scale`, so repeated calls never
  compound). Called on load *and* on `resize`/`orientationchange` in both `host.js` and
  `player.js` (previously only once, when showing the game view).
- **Virtual joystick, touch only** (`player.js`): real multi-touch via Pointer Events
  keyed by `pointerId`. First finger down (no joystick already active, and
  `e.pointerType !== 'mouse'`) becomes the joystick — origin = where it touched down,
  direction each frame = the dead-zone-filtered vector from origin to the current
  position, sampled on an interval (not every `pointermove`, to keep the network send
  rate sane) and sent via the same `sendDirInput()` keyboard input already used. A
  second finger held at the same time is tracked for *both* possible meanings,
  disambiguated by what it does next: lifted quickly with little movement →
  `triggerJump()`; inter-finger distance changes meaningfully → pinch-zoom (joystick
  steering from finger 1 keeps working the whole time either way). Lifting the joystick
  finger always stops movement immediately even if another finger is still down — no
  automatic hand-off. The joystick visual itself (`drawJoystick`) renders whenever
  active; the idle hint (`drawTouchHint`) shows otherwise, in `'follow'` mode.
- **Mouse control, desktop: direct click-to-walk, not the joystick** (reverted back to
  this from a brief stint sharing the joystick with touch — a relative-direction
  joystick didn't feel as natural with a mouse as click-and-hold-toward-a-point does).
  Left-click-and-hold walks straight toward that point in the world; holding the mouse
  still after the click keeps walking there until arrival, dragging continuously
  retargets. Unlike the joystick (screen-space direction only, no conversion needed),
  this genuinely needs the click point in *world* coordinates so the target doesn't
  drift as the camera does — `ArenaRender.screenToWorld(canvas, cssX, cssY)` inverts
  `render()`'s camera transform for this (the one reintroduced piece of screen↔world
  conversion; touch still needs none). Steered toward on the same interval as the
  joystick, using the live `latestPlayers` position each tick so the direction converges
  as you approach. Right-click is still jump (`e.button === 2` in `pointerdown`, checked
  before the click-to-walk branch, doesn't touch it at all) and `contextmenu` is still
  preventDefault'd on the canvas. No screen-space visual is drawn for this (unlike the
  joystick) — `render()`'s `mouseActive` flag just suppresses the idle desktop hint
  (`drawDesktopHint`) while a click-hold is in progress.
- **CSS breakpoint** (`style.css`, `@media (max-width: 820px)`, matching `player.js`'s
  `MOBILE_BREAKPOINT`): scoped to `canvas#arena.arena-follow` (that class is only set in
  `player.html`, so `host.html` — always whole-map regardless of its own window size —
  is never affected). Drops the desktop `aspect-ratio`/`max-width`/`max-height` box and
  goes genuinely edge-to-edge via the `margin: 6px calc(50% - 50vw); width: 100vw;`
  breakout trick, which reaches past `.container`'s padding/max-width without having to
  touch `#gameView` or its other (HUD) children — those stay exactly as contained/
  centered as they are on desktop, only the canvas itself goes full-bleed.

## Arena geometry (server/rooms.js)

Widened back out to `ARENA_W=900`/`ARENA_H=640` (landscape-leaning) now that mobile no
longer needs the *entire* map to fit on a small screen — the camera/follow-mode system
above means a player only ever sees a zoomed-in portion of it anyway, so world size is
now purely a gameplay/spacing concern again, not a phone-screen-shape concern. (Was
`400×720` portrait, phone-friendly, before the camera system existed.) Dog pen top-
center, trapdoor row along the bottom, open field between. `TRAPDOORS` (module constant) is the
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
lobby → intro → question → reveal → escape → fall_pause? → resolve → death_anim → (loop to intro, or → ended)
```

- **intro**: the full-screen "read the question" phase, *before* the answer timer.
  `emitQuestion()` fires at the start of this phase (payload carries `phase:'intro'` +
  `introEndsAt`); the client shows `#introOverlay` (big question + 3 door-coloured option
  cards + countdown bar). Players can move during `intro` server-side, but the overlay
  covers the canvas so in practice nobody moves until answering opens.
  **The host client drives the end of this phase, not a fixed timer** — it reads the
  question + each option aloud (Web Speech API, chunked utterances, `speakQuestion()` in
  `host.js`, 🔊 toggle, `localStorage` `trivia_host_speak`) and emits `host:startAnswering`
  a short beat *after the reading actually finishes* (the `onend` of the last utterance),
  so a long question is never cut off. Fallbacks, all in `host.js`: read-aloud off, or
  `speechAvailable()` false, or the engine reports voices but never fires `onstart`/`onend`
  → a word-scaled timed pause (`introMsFor` estimate) instead; a per-read hard timeout;
  and **START ANSWERING** for a manual skip. The server's own intro timer is now just
  `INTRO_HARD_CAP_MS` (90 s) — a safety net for a disconnected host, checked against
  `this.introHardCapAt` in `tick()`, not `phaseEndsAt`. `phaseEndsAt`/`introEndsAt` during
  intro is the word-scaled estimate (`introMsFor` = `INTRO_BASE_MS + words * INTRO_MS_PER_WORD`,
  cap `INTRO_MAX_MS`, all in `TUNING`) and only drives the countdown bar + the no-audio
  pause. `Room.beginAnswering()` (from `host:startAnswering` or the cap) sets
  `state='question'` + the real answer deadline and emits **`game:answering {endsAt}`** so
  every client dismisses the overlay / starts the timer bar on the same instant.
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
  don't stack.
  **Stuck-dog fixes** (`steer()`/`doDogChase()` in `rooms.js`): dogs used to be able to
  get "confused and stuck" approaching a door dead-on (e.g. returning home from directly
  behind it, or hunting a target on its far side) — `steer()`'s tangential-slide
  direction is chosen by a dot-product sign that sits at ~0 in that exact dead-center
  case, so floating-point noise flipped it tick to tick and the dog thrashed
  left-right in place instead of committing to a side. Fixed with a stable per-dog
  tie-break (`bias`, derived from `dog.id`, passed into `steer()`) so the sign never
  flips mid-approach. `AVOID_RADIUS` was also tightened (`DOG_RADIUS + OBSTACLE_MARGIN`,
  dropped an extra `+20`) since at the old value its influence zone from two neighboring
  doors overlapped in the gap between them, which could also stall a dog trying to path
  through. Belt-and-suspenders on top of both: a stuck-progress check
  (`dog.stuckOrigin`/`stuckCheckAt`/`stuckStrikes`) samples whether a hunting/returning
  dog has actually moved every `STUCK_CHECK_MS`; after `STUCK_STRIKES_TO_UNSTICK`
  stalled samples in a row it enters `unstickUntil` mode for `UNSTICK_MS`, during which
  it seeks a lateral "step aside" waypoint (`dog.x + bias*220`, same y — obstacle
  avoidance stays *active*, this just removes the dead-ahead ambiguity that caused the
  stall) instead of the real target. `DOG_PHASE_HARD_TIMEOUT_MS` (~30s) remains the
  outermost safety net regardless — these fixes just mean it should essentially never be
  the thing that actually saves a round in practice.
  Each dog's catch cap (`dog.capacity`) is computed once at release as
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
  and calls `advanceRound()` (reasons: `all_eliminated`, `last_survivor`,
  `questions_complete`, `host_ended` — there's no overall game-duration cap anymore, see
  below). Dogs are *not* cleared here — they're already parked at home.
  `advanceRound()` checks `aliveCount === 1` *before* checking whether the question set
  is exhausted — last player standing wins outright and ends the game right there
  (reason `last_survivor`) rather than playing out the remaining questions against
  nobody; that check runs ahead of the exhausted-questions check so a survivor who
  happens to also be on the final question still gets the more specific reason.
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
The pit underneath the door (`drawPitDepth`, always drawn, only actually visible once
the panel's gone) got a depth treatment so an open door reads as a hole rather than a
flat black square: a vertical gradient (lit rim fading to black, like light falling into
a shaft), a darker inset "floor" rect offset toward the bottom-right (implies looking
down at an angle), and a beveled rim (light on the top/left edge, shadow on the
bottom/right).
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
just converts to a vector before sending; touch (Pointer Events on `#arena`) drives the
virtual joystick — direction = the dead-zone-filtered vector from where the controlling
finger first touched down to its current position, recomputed on an interval — with a
second finger's quick tap triggering a jump instead (see "Camera system" above for the
full multi-touch/pinch-zoom disambiguation). Mouse is its own third source, sharing none
of the joystick's state: direction = vector from the player's own current position to
the click-and-held world point (`ArenaRender.screenToWorld`), also recomputed on the
same interval so it re-converges as the player moves. All three feed the same
`sendDirInput()`.

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

### In-game screen: full-viewport canvas + translucent overlay HUD

The whole game screen was rebuilt around an edge-to-edge canvas (`canvas#arena` is
`position: fixed; inset: 0; width:100vw; height:100dvh; z-index:0`) with every HUD piece
a `position: fixed` overlay on top of it (`.hud` — `z-index:10`, `pointer-events:none`,
re-enabled per interactive child via `.hud button/a/input/.interactive`). Nothing in the
game view is in normal document flow, so the page can't scroll (`body.in-game { overflow:
hidden }`, class toggled by `showGameView()` / `hideAllTopViews()` / the lobby+rematch
paths in both client files) and the arena is always centred and as large as the viewport.
The old `#gameView` flex-column / `aspect-ratio` / `@media (max-width:820px) .arena-follow`
breakout / `@media (max-height:700px)` machinery is **gone**. `showGameView()` now sets
`display:block` (a passthrough — the fixed children are what render), *not* `flex`.

**One gotcha:** `position:fixed` elements report `offsetParent === null` even when
visible, so `drawFrame()`'s "is the canvas hidden?" guard is now
`canvas.clientWidth === 0` (0 only when a `display:none` ancestor hides it), not
`offsetParent === null`.

Rationalised HUD, both host and player (`.hud-*` classes in `style.css`):
- `.hud-topleft` — `Q n/N · X alive` (host also `· Y 👻`) + a small logo/leave link.
  Replaces the old big `.q-indicator` box **and** the `.status-strip` badges.
- `.hud-timer` — top-centre phase label + slim timer bar. Keeps the `#phaseLabel` /
  `#timerBar` ids so `updatePhaseTimer()` is untouched; it also toggles a `.slim` class
  on `.hud-question` (`#questionHud`) for `reveal`/`escape`/`fall_pause`/`resolve`/
  `death_anim` so the question bar shrinks to one line after answering.
- `.hud-question` — bottom-centre question text + A/B/C door-coloured pills
  (`.option-pill.correct/.wrong` reveal styling unchanged).
- `.hud-host` (host, `cast-hide`) — room code + copy, 🔊 read-aloud toggle, LEAVE PLAYER,
  END GAME. `.hud-cast` (host, **not** `cast-hide`, `#castToggleBtnGame`) — bottom-left,
  stays reachable to exit cast mode since `.top-nav` is behind the canvas in-game.
- `.hud-out` (player) — "👻 YOU'RE OUT" shown only while the local player `isGhost`.
- `#introOverlay` (`.intro-overlay`) — the full-screen question intro, `z-index:30`.
- Small screens: `@media (max-width:640px)` drops the timer to a full-width strip at the
  very top with the corner readout below it (they'd overlap side-by-side on a phone) and
  shrinks the rest.

The touch/desktop control hints (`drawTouchHint`/`drawDesktopHint` in `arena-render.js`)
were nudged up to `viewH - 150/-134` so the bottom `.hud-question` overlay doesn't cover
them.

### App navigation and clipboard copy

A persistent `.top-nav` (logo + optional subtitle) sits outside every view div in both
`host.html` and `player.html` — the lobby / join / end screens' way back to
`index.html`. **In-game it's hidden behind the fixed fullscreen canvas**, so the game
view has its own overlay leave/exit link (`.hud-topleft`) and cast toggle (`.hud-cast`).
On `player.html` the logo calls `backToMenu()` (the same explicit-disconnect function as
the end screen's button, not a bare link) since leaving mid-game should register as
leaving; on `host.html` it's a plain link (no equivalent "presence" concern for the host).
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
`DEATH_ANIM_MS=1300`, `HOME_SETTLE_MS=500`, `OBSTACLE_MARGIN=14` (`AVOID_RADIUS =
DOG_RADIUS + OBSTACLE_MARGIN`, tightened this round - see "Stuck-dog fixes"),
`TRAP_TRIGGER_RADIUS=20`, `TRAP_ROOT_MS=1800`, `TICK_MS=40`. Stuck-dog fallback:
`STUCK_CHECK_MS=700`, `STUCK_DIST_THRESHOLD=10`, `STUCK_STRIKES_TO_UNSTICK=2`,
`UNSTICK_MS=900`. Jump:
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

Question intro phase: `INTRO_BASE_MS=3000`, `INTRO_MS_PER_WORD=320`, `INTRO_MAX_MS=24000`
(in `TUNING`; these drive the countdown bar + the no-read-aloud pause only), plus a fixed
`INTRO_HARD_CAP_MS=90000` auto-advance safety net (the host client normally ends the
intro when its read-aloud finishes — see the `intro` phase above).

**The most-tuned scalars now live on a mutable `TUNING` object** (top of
`rooms.js`), not `const`s — `PLAYER_SPEED`, `DOG_SPEED`, `DOG_CATCH_RADIUS`,
`INTRO_BASE_MS`, `INTRO_MS_PER_WORD`, `INTRO_MAX_MS`,
`DOG_CATCH_CAPACITY_PCT/_MIN`, `DOG_GIVEUP_MS`, `DOG_EAT_MS`, `REVEAL_DELAY_MS`,
`ESCAPE_MS`, `FALL_ANIM_HOLD_MS`, `DEATH_ANIM_MS`, `TRAP_ROOT_MS`,
`LUNGE_SPEED_MULT`, `JUMP_SPEED_MULT`, `JUMP_BASE/MAX_COOLDOWN_MS`. Every use-site
reads `TUNING.X`; `DEFAULT_TUNING` is the frozen baseline, `TUNING_BOUNDS` the
clamp ranges, and `getTuning()/setTuning(patch)/resetTuning()` are the accessors
(exported, used by debug mode). Editing the number in `DEFAULT_TUNING` still
changes the real default. Everything else stays a plain `const`.

## Debug / sandbox mode (`npm run debug`)

Opt-in via `node server/server.js --debug` (or `TS_DEBUG=1`); a normal `npm start`
leaves it fully off — the `debug:*` socket handlers aren't registered and the host
UI stays hidden. `GET /api/debug-enabled` reports the flag; `host:roomCreated` /
`host:roomState` also carry `debug`, `tuning`, `tuningMeta` when on.

- **Bots** (`rooms.js`): `Room.addBot()` = an ordinary player with `isBot`, no
  socket, no `tokenIndex` entry, `ready:true`. `Room.stepBots(now)` runs at the
  top of `tick()` and writes each bot's `p.input` per phase — walk to a chosen
  door in `question` (`room.botAccuracy` = P(correct), default 0.6), bolt off an
  open pit in `escape`, flee the nearest hunting dog in `resolve`, else hold.
  Everything downstream (separation, cage occupancy, hunt pool, alive counts,
  `last_survivor`) treats bots exactly like humans. `getPlayersPublic()` adds
  `isBot`. `Room.removeBots(n)` (lobby/ended only).
- **Debug socket events** (`server.js`, inside `if (DEBUG)`, all host-only):
  `debug:addBots/removeBots/setBotAccuracy`, `debug:sandboxStart {count, config,
  joinAsPlayer}` (adds bots + optionally joins the host as a player + `room.start`,
  **no 2-player check**), `debug:startGame`, `debug:skipPhase` (sets
  `phaseEndsAt`/`hardTimeoutAt` to now — ends whatever the current phase waits
  on, and forces the dog chase to wrap), `debug:replayQuestion` /
  `debug:gotoQuestion {index}` (both → `Room.debugReplayRound(io, i)`, a
  start()-style reset that keeps or sets the question index),
  `debug:killMe/reviveMe/reviveAll`, `debug:endGame`, `debug:setTuning {patch}` /
  `debug:resetTuning` (broadcast `debug:tuning` with the new values — tuning is
  process-global, not per-room).
- **Host UI** (`host.html` / `host.js`, gated by `body.debug-enabled`): a
  "🧪 Sandbox / Debug" card in the lobby (bot buttons, accuracy slider,
  "control an avatar" checkbox, **SANDBOX START**) and a fixed `#debugDock`
  overlay during a game (Skip Phase, Replay Q, Prev/Next/Goto Q, Kill/Revive Me,
  Revive All, End Game, and a collapsible Tuning list built from
  `DEBUG_TUNABLES`). Both are `cast-hide`. `initDebug()` wires it only when the
  server says debug is on; `DEBUG_TUNABLES` in `host.js` is the display list, the
  server re-clamps every value.
- No `arena-render.js` / `player.js` changes — bots render as normal players
  (roster shows 🤖), and the avatar-control path reuses the existing
  `host:joinAsPlayer` flow.

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
internal IPv4 addresses) and `GET /api/tunnel-info` (server-side-only GET to ngrok's own
local admin API at `127.0.0.1:4040/api/tunnels`, fails fast to `{url: null}` if ngrok
isn't running) so the host page can upgrade the join link/QR code from a useless
`localhost` origin to something reachable by other devices, without the host having to
notice and manually copy anything. `host.js`'s `refreshPublicOrigin()` checks both
(tunnel takes priority over LAN — if you bothered starting a tunnel you want the public
URL, not just LAN reach) and re-renders the join link/QR via `renderJoinUrl()` if either
resolved to something better than the origin already in use. Cloudflare's quick tunnel
(`tunnel:cloudflared`) has no equivalent queryable local API, so that path still just
relies on the existing fallback: `window.location.origin` is correct automatically once
the host opens the tunnel's printed URL themselves instead of `localhost`.

For a persistent always-on public deployment (not just a per-session tunnel), see
`docs/deploy-oracle-free-tier.md` + the `deploy/` folder (`trivia-survival.service`,
`Caddyfile`) — an earlier-explored option (rented VPS, own public IP). `server.js` sets
`app.set('trust proxy', true)` for correctness when run behind that kind of reverse
proxy; otherwise no app code differs from any other deployment target. **This is not
what's actually serving traffic** — see the next section.

## Home hosting deployment (live, Cloudflare Tunnel)

The game actually runs from Conor's home network as of 2026-08-30, not on a VPS. Full
architecture rationale and step-by-step setup live in the "Hosting from home network"
Claude project (`home-hosting-blueprint.md`, `home-hosting-implementation-guide.md`) —
not in this repo. Short version for anything touching this codebase:

- **Why not port-forwarding**: home ISP (Skinny NZ) runs CGNAT on every plan — no
  public IP ever reaches the router, so port-forward/DDNS was never on the table.
  Instead, Cloudflare Tunnel (`cloudflared`) dials *out* from the host to Cloudflare's
  edge; nothing on the home network ever listens for inbound traffic.
- **Where it runs**: a separate always-on Windows mini PC (not a dev machine),
  reached over RDP. Orchestration (`docker-compose.yml`, cloudflared's `config.yml` +
  credentials) lives in `C:\hosting\` on that machine — outside this repo, not
  committed to git. This repo's `Dockerfile` + `.dockerignore` (repo root) are what
  that compose file builds from: `build: C:/source/trivia-survival`.
- **Domain**: `cking.co.nz` (bought via Cloudflare Registrar, zone on Cloudflare's
  nameservers already). Live at `triviasurvival.cking.co.nz`.
- **Tunnel**: named `home-hosting`. Its ingress config maps that hostname straight to
  the app's Compose service name — `service: http://triviasurvival:3000` — **not**
  `localhost` (inside the `cloudflared` container, `localhost` means that container,
  not the app container; this exact mix-up caused a "tunnel connects fine, nothing
  loads" bug during setup — check this line first if that happens again). The app
  container publishes no host ports (`ports:` omitted) — the tunnel is the only way in,
  by design.
- **Multiple apps/domains**: supported from this same tunnel — a new app is one more
  Compose service on the same internal network, one more `ingress` line, one
  `cloudflared tunnel route dns` call. No router/ISP changes, ever.
- The Oracle/Caddy path above remains worth revisiting only if a future app needs raw
  TCP/UDP, which Cloudflare Tunnel can't carry (HTTP/HTTPS/WebSocket only).

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
- Four question sources per room (`config.questionSet`): `default`, `hard` (see the
  file map above for what distinguishes it), `webdev` (HTML/CSS/JS/React), or `custom`
  (one JSON upload, lives only on the `Room` object, gone when the room ends). All three
  built-in sets are 400 entries each; `questionCount` can go up to 400 to match. Every
  question's A/B/C letter assignment is reshuffled per-build (`shuffleOptionLetters` in
  `buildQuestionSet()`) regardless of source, so the same question won't always have its
  answer on the same letter across rounds/rematches.
- **Difficulty ramp** (`config.difficultyRamp`, opt-in checkbox next to the question-set
  picker): every entry in the three built-in JSON files carries a `"difficulty"` field
  (integer 1-5, hand-tagged relative to that file's own theme — see each file's own
  round-out-the-curve description in the file map). When enabled, `buildQuestionSet()`
  calls `buildRampedOrder()` instead of a plain shuffle: groups the source pool by tier
  (untagged/out-of-range questions land in tier 3, so a source without full tagging
  degrades gracefully rather than erroring), shuffles within each tier, then spreads
  `questionCount` picks across the 5 tiers as evenly as possible via
  `distributeWithCapacity()` — a thin tier's shortfall rolls over to its neighbors so a
  sparse difficulty doesn't shrink the total question count — and concatenates low→high.
  `buildRampedOrder()` returns `null` if *nothing* in the source has a valid difficulty
  (e.g. a `custom` upload that didn't tag its questions), and `buildQuestionSet()` falls
  back to the normal shuffle in that case — a `custom` set only ramps if the uploaded
  JSON includes its own per-question `"difficulty"` field, nothing else is required to
  make that work. `difficulty` itself never reaches the client — `shuffleOptionLetters`
  (which every question passes through regardless of ramp) only carries `q`/`options`/
  `correct` forward.

## Feedback already implemented (most recent round)

**Game-screen refactor** (touches the wire protocol — see the `intro` phase in "Game
state machine" and "In-game screen" above for the details):
(1) **Full-viewport canvas + overlay HUD** — the in-game screen was rebuilt so the
canvas is `position:fixed inset:0` and all HUD is a translucent fixed overlay on top
(`.hud-*` in `style.css`); the page never scrolls (`body.in-game`), the arena is always
centred/edge-to-edge, and the HUD was rationalised down (corner `Q n/N · X alive`,
top-centre timer, bottom question+options, host controls top-right). Removed the old
`#gameView` flex-column / `aspect-ratio` / breakout `@media` machinery; `showGameView()`
now sets `display:block` not `flex`, and `drawFrame()`'s hidden-check is
`clientWidth === 0` (fixed elements have `offsetParent === null` even when visible).
(2) **Full-screen question intro** — new server `intro` phase before the answer timer:
`#introOverlay` shows the question big + 3 door-coloured option cards + a countdown, the
host page reads it aloud (`speechSynthesis`, chunked per option, 🔊 toggle) and ends the
phase (`host:startAnswering` → `game:answering`) the instant the reading finishes — not a
fixed timer, so long questions/options aren't cut off — with a manual **START ANSWERING**
skip, a no-audio timed-pause fallback, and a 90 s server hard cap. See the `intro` phase
in "Game state machine".
(3) **Camera panning** — `overview` mode gained `panX/panY` (drag to pan when zoomed in,
clamped at the world edges; double-click = `resetView()`). Host: left-drag spectating,
middle/shift-drag while playing. Desktop player: right-button drag (right-*click* still
jumps). `follow` mode still just tracks the player.

Prior round — **debug / sandbox mode** (`npm run debug`): bots, one-click solo start
bypassing the 2-player minimum, in-game phase/question jump controls, and a live tuning
panel. Fully off for a normal `npm start`. See the "Debug / sandbox mode" section above.

Earlier round — four playtesting issues, all touching the wire protocol (new events noted):
(1) **Reconnect resilience** — the real root cause of reported "desync switching tabs":
neither client re-attached to the room after a socket reconnect (each server-side
connection closure resets `playerId`/`isHost` to blank on every new socket), so after any
drop (mobile backgrounding is especially prone to this) input/host-controls silently
no-op'd until a manual reload. `player.js`/`host.js` now listen for `socket.io.on('reconnect',
...)` (fires only on a genuine reconnect, never the initial connect) and re-emit
`player:rejoin`/`host:rejoin`. `pingInterval`/`pingTimeout` also relaxed from `5000/5000`
to `10000/20000` in `server.js` — real leaves are still instant via the existing explicit
`socket.disconnect()` + `pagehide` calls, so this only stops a merely-backgrounded tab
from being mistaken for dead. (2) **QR join flash** — arriving via `?code=` used to
briefly flash the raw code-entry form before the existing skip-ahead logic kicked in;
`player.html` now has a `#connectingView` shown synchronously instead, and every view
transition in `player.js` routes through a new `hideAllTopViews()` helper. (3) **Phantom
ghost players** — disconnected players were never removed, only marked offline, and
`resetForRematch()` carried them into every future lobby forever. `Room.pruneOffline
(graceMs)` (`server/rooms.js`) now drops them — but only in `lobby`/`ended` state, never
mid-round, so disconnecting still can't be used to dodge elimination. A 10s
`server.js` interval prunes with a 30s grace; `startRematch()` prunes immediately (0
grace) since they had the whole prior round to reconnect. (4) **Self-serve rematch
auto-start + host Play/Cast modes** — "Play Another Round" used to only reset the lobby,
still leaving the host to press Start again; `room.awaitingRematchStart` + a 6s
server-side countdown (`maybeStartRematchCountdown`, new `game:rematchCountdown` event)
now auto-starts the next round once 2+ players are ready, while the host's own **START
GAME** still preempts it instantly. The host's old "Play As Player" (a second browser
tab — the actual cause of the desync players hit) is replaced by `host:joinAsPlayer`/
`host:leavePlayer`, letting the host control their own avatar from the same tab/socket as
the host console (reuses the same `playerId` closure the player handlers already keyed
off, restored across a host reconnect via `room.hostPlayerId`); a separate client-only
**Cast View** toggle (`body.cast-mode`, `.cast-hide` in `style.css`) hides the config/
roster/controls for a clean screen-share view without touching Play mode at all.

Prior round: (1) Mouse control reverted from the shared joystick back to
direct click-and-hold-to-walk-toward-a-point — touch keeps the joystick unchanged; see
"Camera system" above for the split and why mouse needed `screenToWorld` reintroduced
while touch still doesn't. (2) Last player standing now wins outright
(`advanceRound()`'s `aliveCount === 1` check, reason `last_survivor`) instead of playing
out the rest of the question set with only one survivor left — see the state machine
section above. (3) Difficulty ramp mode (`config.difficultyRamp`): all three built-in
question sets got a hand-tagged `"difficulty"` field (1-5) added to every existing
entry and were expanded from 120/200/200 to 400 entries each (filling out thin tiers so
the ramp has real depth at every difficulty and repeat games have enough headroom before
questions recur) — see "Difficulty ramp" above for the selection algorithm. None of
these three touch the wire protocol.

Prior round: four items, none touching the wire protocol either: (1) mouse control on
desktop — the virtual joystick already worked for mouse for free (Pointer Events unify
mouse and touch), so this was mainly right-click-to-jump (`contextmenu` preventDefault'd,
handled in `pointerdown` on `e.button === 2`) plus making the joystick visual/hint show
for mouse-drag in `'overview'` mode too, not just touch in `'follow'` mode (superseded by
this round's revert above). (2) A dog-pathing bug where dogs could get "confused and
stuck" behind an open trapdoor, fixed at the root cause (a steering tie-break that sat at ~0 and flipped
on floating-point noise in the dead-center-approach case, plus an `AVOID_RADIUS` tuned
too large for the gap between doors) with a stuck-progress-detection fallback layered on
top as defense in depth — see the "Stuck-dog fixes" paragraph in the state machine
section above. (3) Open trapdoor pits got a depth treatment (gradient + inset floor +
beveled rim) instead of a flat black square — see "Trapdoor animation timing" above.
(4) A new `hard` question set (`questions-hard.json`, 200 harder/trickier general-
knowledge entries) alongside `default`/`webdev`/`custom` — see "Deliberately simplified"
above. If picking this back up, this is the most current ground truth, more current
than anything a chat transcript would say.

Prior round: real mobile device testing surfaced usability issues with the old fixed
whole-map-always-visible canvas and hold-drag-toward-a-point touch control, replaced
with a proper camera system: `'follow'` mode (mobile) zooms the camera on the player
with a genuinely edge-to-edge canvas for maximum visible space/control precision,
`'overview'` mode (host always, desktop players) keeps the old whole-map view; both
support wheel (desktop) / pinch (touch) zoom. Touch input became a real virtual joystick
(arbitrary touch origin, drag-relative direction, second-finger tap to jump,
disambiguated from pinch) instead of hold-drag-toward-an-absolute-point. The world was
widened back out (`900×640`, was `400×720` portrait) now that mobile no longer needs the
whole map to fit on a small screen. Off-screen trapdoor indicators (colored arrows +
letter, screen-edge, self-limiting) point toward doors that fall outside the current
view once zoomed in — see "Camera system, virtual joystick, zoom, off-screen indicators"
and the updated "Arena geometry" above for the full breakdown.

Earlier round: mobile clipboard copy (secure-context fallback, see "App navigation and
clipboard copy" above); config sliders now stack on their own line below ~520px
(`.config-row`) instead of overlapping. Removed `config.durationSec`/`gameEndsAt`
entirely (redundant overall-length cap, invisible to players anyway — see the state
machine section above). Dog lunge went from a flat boolean to `'off'/'low'/'high'`
(`LUNGE_PRESETS`), tuned quieter than the old always-on values. Trapdoor cages now grow
taller (never shrink) with the room's player count, independent of dynamic cell scaling
— see "Arena geometry" above. Text sizes bumped up (and the short-viewport media query
stopped shrinking fonts, only padding) for small-screen readability. Added a persistent
top-nav (logo → home) on every view. New `questions-webdev.json` (200 entries) alongside
the default set, selectable per room, plus `questionCount` cap raised to 200 to match.
Jump is no longer purely cosmetic: it's now a brief directional speed burst with
exponential-backoff cooldown — see "Directional jump + exponential cooldown backoff"
above.

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
