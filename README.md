# Trivia Survival

A fast, browser-based multiplayer icebreaker: answer trivia, sprint to the right trapdoor,
survive the dogs. Built for 30–100 players, ~10 minute rounds, GBA-style pixel visuals.

## Run it locally

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start
```

Then open:
- Host: `http://localhost:3000/index.html` → "Host a Game"
- Players: `http://localhost:3000/player.html` (or scan the QR code / use the join code
  shown on the host screen)

To test multiplayer locally, open the host in one tab and a few player tabs (or your phone
on the same wifi network, using your computer's local IP instead of `localhost`).

## Deploying for a real session

This needs a **persistent Node.js process** (not a static host) because it uses WebSockets
(Socket.io) for real-time gameplay. Good free/cheap options:

- **Railway** / **Render** / **Fly.io** — connect the repo, they auto-detect `npm start`.
- Any VPS — `npm install && npm start`, put it behind a reverse proxy (nginx/Caddy) with
  HTTPS so the QR code and join links work cleanly over the internet.

Once deployed, the join URL/QR code the host sees will automatically use that deployment's
domain (it's built client-side from `window.location.origin`), so no config changes needed.

## How it works (architecture)

- **Server** (`server/`): Express serves the static client; Socket.io handles all real-time
  events. `rooms.js` contains the full game state machine — one `Room` per session, driven
  by a 20Hz server-authoritative tick loop (movement, dog AI, phase timers). The server is
  the source of truth for positions and outcomes; clients just send input and render.
- **Client** (`public/`):
  - `index.html` — landing (host or join)
  - `host.html` / `js/host.js` — room creation, config, lobby, live spectator view
  - `player.html` / `js/player.js` — join/avatar picker, keyboard input, gameplay view
  - `js/arena-render.js` — shared canvas renderer (floor, trapdoors, cages, dogs, players,
    ghosts) used by both host and player views
- **Reconnect**: each player gets a secret token stored in `localStorage`. On disconnect the
  player object stays in the room (frozen in place, still vulnerable to trapdoors/dogs); if
  they reload/reconnect within the same session, `player:rejoin` restores control instantly.
- **Session lifecycle**: a room is cleaned up once neither the host nor any player is
  connected (checked every 30s), or after a 3-hour hard cap.

## Round reveal sequence

After the answer timer ends: cages rise on **all three** trapdoors (even empty ones) →
after a 3s suspense delay the correct answer is highlighted in the question panel and the
correct door glows green and stays caged → wrong doors visibly swing open and those
players fall through, respawning nearby as ghosts a moment later → dogs are released and
chase down anyone left in the open → once they're all caught, the safe cage opens and the
next question begins.

## Rematch

Once a game ends, the host sees a **Rematch** button that resets everyone's alive/ghost
state and sends the room back to the lobby — no need for players to re-scan the QR code or
rejoin, they're already there and just need to ready up again.

## Configuring a round

The host can set, before starting:
- Total game duration (safety cap on overall length)
- Answer time per question
- Number of questions
- Question set: the built-in default set, or a custom uploaded `.json` file in this shape:

```json
[
  { "q": "What planet is known as the Red Planet?",
    "options": { "A": "Venus", "B": "Mars", "C": "Jupiter" },
    "correct": "B" }
]
```

Game needs at least 2 connected players before the host can start.

## Current scope / what's simplified for this first pass

This build prioritizes a complete, correct gameplay loop end-to-end over visual polish:
- Avatars and characters are drawn procedurally (colored pixel-blocks), no sprite sheets yet.
- No audio yet (structure is easy to extend — just add `<audio>` triggers on the socket
  events already firing: `game:question`, `game:lockin`, `game:reveal`, `player:caught`,
  `game:end`).
- Jump is a visual-only animation (no gameplay effect), matching the brief.
- Dog AI is a straightforward "nearest target" chase — good enough for the fast, chaotic
  feel the game wants, easy to tune via `DOG_SPEED` / `DOG_CATCH_RADIUS` in `server/rooms.js`.

Natural next steps if you want to keep building: sprite-sheet based animated characters,
sound effects/music, more question-set management (multiple saved sets), a lightweight
admin view to remove disruptive players, and client-side interpolation for extra-smooth
movement at very high player counts.
