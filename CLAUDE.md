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
lobby → question → reveal → escape → resolve → death_anim → (loop to question, or → ended)
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
  open pit is safe *during* this window and only falls if still there when it ends
  (`doEscapeEnd`, reuses the same `fallIntoPit`/`game:dropped` path as the mid-chase
  pit-fall check below).
- **resolve**: dogs released (`releaseDogs`) hunting whoever currently has `!cagedAt`
  (computed fresh each tick — this is also when standing on an open pit becomes
  instantly lethal, movement-block-gated to this state only). Dogs use persistent
  per-dog target claims + `seek+avoid` steering around the 3 trapdoor rects (always
  avoided, solid or open) so they don't cut through cages/pits, plus a dog-dog
  separation pass so they don't stack. Each dog goes `'returning'` (walks itself home,
  stops hunting) once it's caught `DOG_CATCH_CAPACITY` (2) players or `DOG_GIVEUP_MS`
  (~9s) has passed since release, then `'home'` once it arrives. The phase ends when
  either **all dogs are home** or **everyone outside the safe cage is dead** — a round
  can end with live survivors if the dogs simply got full/gave up first.
  `DOG_PHASE_HARD_TIMEOUT_MS` (~30s) is a last-resort safety net that forces all dogs
  home instantly; it never kills anyone.
- **death_anim**: a short hold before finishing. If the round ended because everyone
  died, this waits until `DEATH_ANIM_MS` (~1.3s) after the last catch so the client's
  fall-over + blood-puddle animation (`player:caught` → `ArenaRender.onCaught`) has
  time to play. If it ended via dogs-all-home with survivors, it's just a small
  (`HOME_SETTLE_MS`) buffer. `finishRound()` then frees the safe cage
  (`cagedAt=null`, `cageSolid[correct]=false`), clears `dogs`, and calls
  `advanceRound()` (reasons: `all_eliminated`, `questions_complete`, `time_up`,
  `host_ended`).
- **ended → lobby**: `host:rematch` calls `Room.resetForRematch()` — same room/code/
  players, resets alive/ghost/cagedAt/ready/hazards, does NOT require players to rejoin.

Movement rule used throughout: caged players (`player.cagedAt` set) can move and jump
but are clamped inside their own trapdoor rect; free players are pushed out of any
`cageSolid` rect they don't belong in (`resolveCircleRect`) and separated from other
players (`separatePairs`) every tick. Ghosts (`isGhost=true`) always have
`cagedAt=null` and skip all collision/containment — they roam freely, per spec.

## Known tuning constants (server/rooms.js top)

`PLAYER_SPEED=235`, `DOG_SPEED=185`, `DOG_RADIUS=13`, `DOG_CATCH_RADIUS=24`,
`DOG_HOME_RADIUS=26`, `DOG_CATCH_CAPACITY=2`, `DOG_GIVEUP_MS=9000`,
`DOG_PHASE_HARD_TIMEOUT_MS=30000`, `JUMP_MS=320`, `REVEAL_DELAY_MS=3000`,
`ESCAPE_MS=2400`, `DEATH_ANIM_MS=1300`, `HOME_SETTLE_MS=500`,
`OBSTACLE_MARGIN=18`, `TICK_MS=40`. If gameplay feels off, these are the first things
to touch — tune before restructuring logic.

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
- Dog AI is local steering (seek target + avoid the 3 trapdoor rects, with a tangential
  slide around whichever edge is closer), not full pathfinding — see the state machine
  section above. Fine for this arena's small, static, all-rectangular obstacle set;
  would need a real nav-mesh/A* if the arena ever grows more complex obstacles.
- No persistence layer — rooms/tokens are in-memory, wiped on restart or after 3hr/no-
  connection sweep (`GameManager.sweep()`).

## Feedback already implemented (most recent round)

Physics collisions: players push apart instead of overlapping, and can't cross a locked
cage's perimeter from outside (but can move/jump freely once caged) — see
`resolveCircleRect`/`separatePairs` in `rooms.js`. Wrong-answer reveal no longer kills
instantly; it opens the door into a real ~2.4s **escape** window (state `escape`) before
the pit becomes lethal. Dog AI reworked: persistent per-dog target claims (no more
dogpiling), `seek+avoid` steering around the trapdoor rects, dog-dog separation, and a
catch-capacity/give-up system where dogs go home once full or bored (`resolve` phase can
now end with survivors still standing — see state machine above). Dog catches now play a
fall-over + blood-puddle death animation (`player:caught` → `ArenaRender.onCaught`) with
a short `death_anim` hold before the round advances, instead of an instant vanish. Dog
sprite redrawn heading-oriented (head/snout/ears/wagging tail) instead of two ellipses,
and a "dogs give up in Xs" countdown renders during the chase. All server state-machine
changes and client animation-state ownership described above are a result of that
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
