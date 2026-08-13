# Sprite assets (optional)

This folder is empty by default — the game renders every character procedurally with
plain canvas shapes (see `public/js/arena-render.js`) and looks/plays identically
whether or not anything is here. Drop in real art and it's picked up automatically,
no code changes required.

## What's recognized

`arena-render.js` attempts to load these two files once, at page load:

- `sprites/player.png` — used for every player avatar. Drawn as a single top-down
  image roughly 28×40px (portrait-ish, a little taller than wide), centered on the
  player's feet. One image is reused for all players/colors (the game doesn't
  currently tint or swap frames per-player) — a single neutral/character-agnostic
  design reads best, since the existing colored-block fallback is what currently
  carries per-player color identity.
- `sprites/dog.png` — used for every dog. Drawn top-down, roughly 34×26px (wider than
  tall), assumed to face along its own +x axis — the game rotates it to match each
  dog's current heading, so draw it facing right.

Both are simple single-frame images for now (no spritesheet/animation frames yet) —
if a file is missing or fails to load, that character just keeps using the existing
procedural drawing with no error shown to players.

## Adding a sprite

1. Drop a PNG (transparent background recommended) at the path above.
2. Reload the page — no server restart or code change needed.
3. If it doesn't show up, check the browser console for a 404 (wrong filename/path) —
   everything else fails silently by design.
