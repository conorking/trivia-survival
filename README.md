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

## Playing over WiFi (same network, no deploy needed)

Other devices on the same network (phones, laptops) can join without any deployment —
they just need your computer's LAN address instead of `localhost`, which only means "this
device" to anyone else. If the host opens the dashboard via `localhost:3000`, it
auto-detects your machine's LAN IP (via a small `/api/lan-info` endpoint) and swaps it
into the join link/QR code automatically, so scanning it from another phone on the same
wifi just works. If that detection fails (unusual network setup, VPN interference, etc.),
find your IP manually (`ipconfig` on Windows / `ifconfig` or `ip addr` on Mac/Linux) and
open `http://YOUR_LOCAL_IP:3000/index.html` on the host machine instead of `localhost`.

## Playing over the internet without hosting costs or port forwarding

For a one-off session where you don't want to deploy anywhere or open a port on your
router, a tunnel exposes your local `npm start` process at a temporary public URL:

- **ngrok**: `npm run tunnel:ngrok` (or `npx ngrok http 3000`). Free tier requires a
  quick account + authtoken setup at [ngrok.com](https://ngrok.com) the first time; after
  that it prints a public `https://*.ngrok-free.app` URL that proxies straight to your
  local server, WebSockets included.
- **Cloudflare Tunnel**: `npm run tunnel:cloudflared` (requires installing the
  [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  CLI first). No account needed for a quick anonymous tunnel — prints a public
  `https://*.trycloudflare.com` URL.

Either way, open the *tunnel's* URL (not `localhost`) on the host machine — the join
link/QR code is built from whatever URL the browser is actually on
(`window.location.origin`), so it'll automatically be the public tunnel address once you
do. Keep the room code private if you don't want strangers finding it; anyone with the
tunnel URL and a valid room code can join like any other player.

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
  by a 25Hz server-authoritative tick loop (movement, dog AI, phase timers). The server is
  the source of truth for positions and outcomes; clients just send input and render.
- **Client** (`public/`):
  - `index.html` — landing (host or join)
  - `host.html` / `js/host.js` — room creation, config, lobby, live spectator view
  - `player.html` / `js/player.js` — join/avatar picker, keyboard + hold-drag/tap touch
    input, gameplay view
  - `js/arena-render.js` — shared canvas renderer (floor, trapdoors, cages, dogs, players,
    ghosts) used by both host and player views. Both client files render via a
    `requestAnimationFrame` loop that interpolates between the last couple of server
    snapshots, decoupling visual smoothness from the server's 25Hz tick rate and network
    jitter.
- **Reconnect**: each player gets a secret token stored in `localStorage`. On disconnect the
  player object stays in the room (frozen in place, still vulnerable to trapdoors/dogs); if
  they reload/reconnect within the same session, `player:rejoin` restores control instantly.
- **Session lifecycle**: a room is cleaned up once neither the host nor any player is
  connected (checked every 30s), or after a 3-hour hard cap.

## Round reveal sequence

After the answer timer ends: cages rise on **all three** trapdoors (even empty ones) →
after a 3s suspense delay the correct answer is highlighted, that door glows green and
stays locked (you can move around inside it, just not leave), and the wrong doors open →
anyone in a wrong cage now has a few seconds to run clear before the pit actually becomes
lethal (a shudder warns you right before it snaps open — get out before then, a personal
"RUN!"/"SAFE!" prompt over your head tells you which applies) → dogs are released and
hunt down anyone still exposed, each one capping out after eating a share of the group (or
giving up after a while) and heading back to the pen — a round can end with survivors even
if not everyone was caught → the safe door opens and the next question begins. A global
timer bar with the current objective (e.g. "Survive the dogs for another Xs...") runs
through every phase of this sequence.

## Rematch

Once a game ends, the host sees a **Rematch** button that resets everyone's alive/ghost
state and sends the room back to the lobby — no need for players to re-scan the QR code or
rejoin, they're already there and just need to ready up again.

## Configuring a round

The host sets everything on the lobby screen — sliders/number boxes and a couple of
opt-in toggles — and it all applies the moment **START GAME** is pressed (no separate
save step). Game length is simply answer-time × number of questions; there's no separate
overall duration cap to set.
- Answer time per question
- Number of questions (up to 200)
- Question set: the built-in 120-question general-knowledge set, a 200-question web-dev
  set (HTML/CSS/JS/React/tooling), or a custom uploaded `.json` file in this shape:

```json
[
  { "q": "What planet is known as the Red Planet?",
    "options": { "A": "Venus", "B": "Mars", "C": "Jupiter" },
    "correct": "B" }
]
```
  (Each question's correct answer is reshuffled onto a random A/B/C slot every game, so
  it's never a fixed, learnable position.)
- 🪤 **Bear traps** (opt-in): a couple of one-shot traps appear during the escape window
  and root anyone who steps on one for a couple seconds.
- 🐕‍🦺 **Dog lunge** (off / low / high): hunting dogs occasionally telegraph and burst
  toward their target for extra threat, at a frequency you choose.
- 📉 **Dynamic cell scaling** (opt-in): the trapdoor cages start larger and shrink round
  by round, so fewer players can physically fit in one by the later questions. Cages also
  always grow taller (regardless of this setting) in a big room so a full crowd can
  actually fit.

Game needs at least 2 connected players before the host can start.

## Current scope / what's simplified for this first pass

This build prioritizes a complete, correct gameplay loop end-to-end over visual polish:
- Avatars and characters are drawn procedurally (colored pixel-blocks) by default; sprite-
  loading plumbing exists (see `public/sprites/README.md`) and is picked up automatically
  the moment real art is dropped in, but none ships with the project yet.
- No audio yet (structure is easy to extend — just add `<audio>` triggers on the socket
  events already firing: `game:question`, `game:lockin`, `game:reveal`, `player:caught`,
  `game:end`).
- Jump gives a small directional speed burst while moving (rate-limited by an
  exponentially growing cooldown, capped at a couple of seconds) rather than being
  purely cosmetic.
- Dog AI does local steering (seek + obstacle avoidance) with persistent per-dog
  targeting, a catch-capacity/give-up system, and optional lunge bursts — tune via the
  `DOG_*` constants at the top of `server/rooms.js`.

Natural next steps if you want to keep building: sound effects/music, more question-set
management (multiple saved sets), and a lightweight admin view to remove disruptive
players.
