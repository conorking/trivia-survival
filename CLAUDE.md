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
  and player. Owns its own animation state (door-opening, fall/respawn, cage pulses,
  death/blood-puddle, chase countdown) via `onLockIn/onReveal/onDropped/onCaught/
  onDogsReleased/onRoundComplete/onNewQuestion` — callers just tell it what happened, it
  handles timing/interpolation internally using `Date.now()`.
- `public/css/style.css` — GBA/retro pixel styling, single stylesheet, no preprocessor.

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
  animation timing" below. If enabled, bear traps (`config.bearTraps`) spawn for this
  window only (`spawnTraps()`), rooting (`player.rootedUntil`) anyone who steps on an
  unsprung one; cleared the moment escape ends.
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
  `DOG_GIVEUP_MS` (~9s) has passed since release, then `'home'` on arrival. The phase
  ends when either **all dogs are home** or **everyone outside the safe cage is dead**
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
  `time_up`, `host_ended`). Dogs are *not* cleared here — they're already parked at home.
- **ended → lobby**: `host:rematch` calls `Room.resetForRematch()` — same room/code/
  players, resets alive/ghost/cagedAt/ready/hazards, does NOT require players to rejoin.

Movement rule used throughout: caged players (`player.cagedAt` set) can move and jump
but are clamped inside their own trapdoor rect; free players are pushed out of any
`cageSolid` rect they don't belong in (`resolveCircleRect`) and separated from other
players (`separatePairs`) every tick. Ghosts (`isGhost=true`) always have
`cagedAt=null` and skip all collision/containment — they roam freely, per spec. A
rooted player (`rootedUntil > now`, from a bear trap) simply has their input ignored for
movement that tick — everything else (separation, containment) still applies normally.

### Trapdoor animation timing (public/js/arena-render.js)

Two visuals that used to be conflated are now deliberately decoupled: the **cage bars**
fade out fast (`BAR_FADE_MS`, ~250ms) right at `reveal`/escape-start, signaling "you're
free to move" the instant that's actually true; the **door/pit itself** stays visually
shut (shuddering in the last `SHUDDER_MS` before the deadline as a warning) and snaps
open in a fast `SNAP_MS` (~180ms) exactly at the server's `escapeEndsAt` — i.e. the same
instant the pit becomes lethal, driven off the timestamp from `game:reveal`, not a fixed
local duration. The sliding door-half draw calls are wrapped in a canvas clip to the
trapdoor's own rect so a fast snap can never visually spill onto the surrounding floor.

## Known tuning constants (server/rooms.js top)

`PLAYER_SPEED=235`, `DOG_SPEED=185`, `DOG_RADIUS=13`, `DOG_CATCH_RADIUS=24`,
`DOG_HOME_RADIUS=26`, `DOG_CATCH_CAPACITY_PCT=0.25`, `DOG_CATCH_CAPACITY_MIN=2`,
`DOG_GIVEUP_MS=9000`, `DOG_EAT_MS=2500`, `DOG_PHASE_HARD_TIMEOUT_MS=30000`,
`JUMP_MS=320`, `REVEAL_DELAY_MS=3000`, `ESCAPE_MS=2400`, `FALL_ANIM_HOLD_MS=1000`,
`DEATH_ANIM_MS=1300`, `HOME_SETTLE_MS=500`, `OBSTACLE_MARGIN=18`,
`TRAP_TRIGGER_RADIUS=20`, `TRAP_ROOT_MS=1800`, `TICK_MS=40`. Client-side mirrors:
`arena-render.js` has `BAR_FADE_MS=250`, `SHUDDER_MS=500`, `SNAP_MS=180`,
`GATE_ANIM_MS=450`. If gameplay feels off, these are the first things to touch — tune
before restructuring logic.

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
  `game:lockin`, `game:reveal`, `game:dropped`, `player:caught`, `game:dogs_released`,
  `game:end`).
- Dog AI is local steering (seek target + avoid the 3 trapdoor rects, with a tangential
  slide around whichever edge is closer), not full pathfinding — see the state machine
  section above. Fine for this arena's small, static, all-rectangular obstacle set;
  would need a real nav-mesh/A* if the arena ever grows more complex obstacles.
- No persistence layer — rooms/tokens are in-memory, wiped on restart or after 3hr/no-
  connection sweep (`GameManager.sweep()`).
- Question set is single built-in JSON (120 entries) or one custom upload per room —
  each question's A/B/C letter assignment is reshuffled per-build (`shuffleOptionLetters`
  in `buildQuestionSet()`), so the same question won't always have its answer on the same
  letter across rounds/rematches.

## Feedback already implemented (most recent round)

Trapdoor animation resync: cage bars now fade out fast right when a wrong door's
occupant is actually freed, while the door/pit itself stays shut (shuddering as a
warning) and snaps open exactly when the pit goes lethal (`escapeEndsAt`, sent in
`game:reveal`) — see "Trapdoor animation timing" above; sliding door panels are now
clipped to their own rect so they can't visually spill outside the hole. Dogs are always
visible sitting in their pen (not just during the chase), with a gate that visibly splits
open on release (`arena-render.js` `drawDogPen`). Dog targeting now always finds a target
(nearest-unclaimed-first, then nearest-overall fallback), catch capacity is now
`DOG_CATCH_CAPACITY_PCT` of that round's hunt pool instead of a flat number, and a dog
pauses in a chewing `'eating'` pose for `DOG_EAT_MS` after each catch before resuming.
Fall animations are now guaranteed to finish before the game moves on (`fall_pause`
state after escape-window stragglers fall; `death_anim`'s hold now also gates on
pit-fall deaths, not just dog catches, via unified `lastDeathAt`) and read more like
"falling into a hole" (dip to the pit's center, then rise up as a ghost) instead of a
straight slide. Host config: no more Save-then-Start — sliders (paired with the existing
number boxes) plus a bear-traps checkbox now apply directly at `host:startGame`
(`sanitizeConfig` reused server-side, `host:updateConfig` removed). New opt-in bear-trap
hazard (`config.bearTraps`) spawns 2-3 traps only during the escape window, rooting
whoever steps on one. Question bank grown from 20 to 120 entries, and each question's
correct-answer letter is now reshuffled per build instead of hard-coded. All of the
above is a result of that round — if picking this back up, this is the most current
ground truth, more current than anything a chat transcript would say.

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
