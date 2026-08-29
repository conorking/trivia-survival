// Shared rendering used by both host (spectator) and player views.
// Draws a top-down GBA-style pixel arena onto a canvas.
// Animation state (lockin/reveal/drop) is owned internally and driven by
// onLockIn / onReveal / onDropped / onRoundComplete / onNewQuestion calls.

const ArenaRender = (() => {
  // Fallback defaults, overwritten by setArena()/setTrapdoors() once real data arrives
  // from the server - kept in sync with server/rooms.js's constants as a sane baseline.
  let ARENA_W = 900, ARENA_H = 640;
  let TRAPDOORS = {
    A: { x: 125, y: 480, w: 150, h: 120 },
    B: { x: 375, y: 480, w: 150, h: 120 },
    C: { x: 625, y: 480, w: 150, h: 120 }
  };
  let DOG_PEN = { x: 350, y: 20, w: 200, h: 70 };

  const DOOR_COLORS = { A: '#ef8f4f', B: '#4fb8ef', C: '#b84fef' };
  const BAR_FADE_MS = 250; // cage bars vanish fast right when a wrong door's occupant is freed
  const SHUDDER_MS = 500; // warning shudder in the last stretch before a door snaps open
  const SNAP_MS = 180; // the door itself opens fast, timed to the real lethal instant
  const FALL_DUR = 900;
  const DEATH_ANIM_DUR = 1200; // roughly matches server DEATH_ANIM_MS
  const GATE_ANIM_MS = 450;
  const GATE_W = 46;

  // ---- Camera system ----
  // Everything below draws in world coordinates (unchanged); render() wraps that
  // existing draw sequence in a single camera transform (translate to screen center,
  // scale by zoom, translate by -camera.x/-camera.y) so 'overview' (whole map, host +
  // desktop players) and 'follow' (zoomed on the player, mobile) are just two different
  // camera targets/zoom levels through the same rendering path.
  let camera = { x: ARENA_W / 2, y: ARENA_H / 2, zoom: 0, panX: 0, panY: 0, anchorX: 0, anchorY: 0 };
  let cameraMode = null; // tracks the last viewMode render() was called with
  let lastFollowX = null, lastFollowY = null; // last known follow target, for gaps in player data
  const OVERVIEW_ZOOM_MAX_MULT = 2.5; // how far 'overview' can zoom in past whole-map-fit
  // 'follow' mode's default zoom (world px -> CSS px) - kept close to whole-map-fit so
  // players see plenty of surrounding arena without having to manually zoom out first;
  // they can still zoom in further (FOLLOW_ZOOM_MAX_MULT) whenever they want a closer view.
  const FOLLOW_DEFAULT_ZOOM = 1.0;
  const FOLLOW_ZOOM_MAX_MULT = 2.9; // how far 'follow' can zoom in past its own default (same absolute max zoom-in as before this default was lowered)
  const OFFSCREEN_MARGIN = 26; // screen-space inset the off-screen door arrows clamp to
  const JOYSTICK_RADIUS = 52;
  const JOYSTICK_KNOB_RADIUS = 22;
  // 'follow' mode renders the player above true screen-center by this fraction of the
  // viewport height, reserving extra room below them for the bottom question HUD so it
  // can never render on top of (obscure) the player's own sprite - see updateCamera().
  const FOLLOW_BOTTOM_BUFFER_FRAC = 0.13;
  // 'overview' mode (host + desktop players) reserves the same kind of bottom band, but
  // has to do it differently: it's already showing the *entire* map edge-to-edge, so
  // there's no slack to just shift the render anchor within (that would either crop the
  // top of the map or leave it oversized). Instead it fits the map into a slightly
  // *shorter* usable height, so the trapdoor row itself never renders low enough to sit
  // under the fixed question HUD - see usableViewH()/fitZoom().
  const OVERVIEW_BOTTOM_RESERVE_FRAC = 0.17;

  function clampNum(v, min, max) { return Math.max(min, Math.min(max, v)); }

  // The vertical CSS-px extent actually available for the world render, after setting
  // aside 'overview' mode's bottom reserve band (see OVERVIEW_BOTTOM_RESERVE_FRAC above).
  // 'follow' mode doesn't shrink anything here - it reserves its buffer purely by shifting
  // the render anchor (see FOLLOW_BOTTOM_BUFFER_FRAC/updateCamera), since it's already
  // zoomed in past whole-map-fit and has no "does the whole map still fit" constraint.
  function usableViewH(viewH, mode) {
    return mode === 'overview' ? viewH * (1 - OVERVIEW_BOTTOM_RESERVE_FRAC) : viewH;
  }

  // Zoom that exactly contains the whole world in the given (CSS-pixel) viewport -
  // the shared floor for both modes' minimum zoom ("can't zoom out past the whole map").
  function fitZoom(viewW, viewH, mode) {
    return Math.min(viewW / ARENA_W, usableViewH(viewH, mode) / ARENA_H) * 0.96; // slight padding so the border isn't clipped
  }

  function getZoomRange(mode, viewW, viewH) {
    const fit = fitZoom(viewW, viewH, mode);
    if (mode === 'follow') {
      const def = Math.max(fit, FOLLOW_DEFAULT_ZOOM);
      return { min: fit, max: Math.max(def * FOLLOW_ZOOM_MAX_MULT, fit), default: def };
    }
    return { min: fit, max: fit * OVERVIEW_ZOOM_MAX_MULT, default: fit };
  }

  // Recomputes camera.zoom (clamped into range, reset to the mode's default on a mode
  // switch) and camera.x/y every frame. 'follow' centers on the player (pan ignored -
  // it always tracks you). 'overview' centers on the world, plus a user pan offset
  // (panX/panY, set by panBy() from a drag) - re-clamped here so you can never drag the
  // view past a world edge, and forced to 0 whenever the whole map already fits.
  function updateCamera(mode, players, myId, viewW, viewH) {
    const range = getZoomRange(mode, viewW, viewH);
    if (cameraMode !== mode || !camera.zoom) {
      camera.zoom = range.default;
      camera.panX = 0; camera.panY = 0;
    } else {
      camera.zoom = clampNum(camera.zoom, range.min, range.max);
    }
    cameraMode = mode;

    let targetX = ARENA_W / 2, targetY = ARENA_H / 2;
    if (mode === 'follow') {
      const me = myId != null && players ? players.find(p => p.id === myId) : null;
      if (me) { targetX = me.x; targetY = me.y; lastFollowX = me.x; lastFollowY = me.y; }
      else if (lastFollowX != null) { targetX = lastFollowX; targetY = lastFollowY; }
      camera.panX = 0; camera.panY = 0;
    }

    const halfW = viewW / (2 * camera.zoom);
    const halfH = viewH / (2 * camera.zoom);
    const fitsW = halfW * 2 >= ARENA_W;
    const fitsH = halfH * 2 >= ARENA_H;
    if (mode !== 'follow' && (fitsW && fitsH)) { camera.panX = 0; camera.panY = 0; }
    // Clamp the pan so target+pan stays within the world-edge bounds.
    if (mode !== 'follow') {
      if (!fitsW) camera.panX = clampNum(targetX + camera.panX, halfW, ARENA_W - halfW) - targetX;
      else camera.panX = 0;
      if (!fitsH) camera.panY = clampNum(targetY + camera.panY, halfH, ARENA_H - halfH) - targetY;
      else camera.panY = 0;
    }
    const px = mode === 'follow' ? 0 : camera.panX;
    const py = mode === 'follow' ? 0 : camera.panY;
    camera.x = fitsW ? ARENA_W / 2 : clampNum(targetX + px, halfW, ARENA_W - halfW);
    camera.y = fitsH ? ARENA_H / 2 : clampNum(targetY + py, halfH, ARENA_H - halfH);

    // Screen-space point that world (camera.x, camera.y) projects to. Normally dead
    // center; 'follow' shifts it up so the player renders above true center, and
    // 'overview' centers within its shrunk usable height instead of the full viewport -
    // both leave the same kind of extra room below for the bottom question HUD.
    camera.anchorX = viewW / 2;
    camera.anchorY = mode === 'follow'
      ? viewH * (0.5 - FOLLOW_BOTTOM_BUFFER_FRAC)
      : usableViewH(viewH, mode) / 2;
  }

  // Called from wheel (desktop) / pinch (touch) handlers in player.js/host.js. Multiplies
  // the current zoom by `factor` and clamps into the current mode's range - camera
  // position isn't independently pannable (it's always derived from world-center or the
  // player's own position, see updateCamera), so there's no anchor-point math needed:
  // the next render() call recomputes x/y from that same formula regardless.
  function adjustZoom(factor, viewMode, canvas) {
    if (!canvas || !factor) return;
    const dpr = window.devicePixelRatio || 1;
    const viewW = canvas.clientWidth || (canvas.width / dpr);
    const viewH = canvas.clientHeight || (canvas.height / dpr);
    const range = getZoomRange(viewMode, viewW, viewH);
    const base = camera.zoom || range.default;
    camera.zoom = clampNum(base * factor, range.min, range.max);
    cameraMode = viewMode; // so the next render() clamps instead of resetting to default
    if (camera.zoom <= fitZoom(viewW, viewH, viewMode) + 1e-4) { camera.panX = 0; camera.panY = 0; }
  }

  // Drag-to-pan the 'overview' camera (host + desktop players). dxCss/dyCss are the
  // pointer's movement in CSS px this drag step; dividing by zoom converts to world
  // units, negated so the content follows the cursor. updateCamera() re-clamps the
  // result to the world edges and ignores it entirely in 'follow' mode.
  function panBy(dxCss, dyCss) {
    if (!camera.zoom) return;
    camera.panX -= dxCss / camera.zoom;
    camera.panY -= dyCss / camera.zoom;
  }
  function resetPan() { camera.panX = 0; camera.panY = 0; }
  // Full "reset view": drop the pan and snap zoom back to the current mode's default
  // (whole-map for overview, the follow default for follow) - used by double-click.
  function resetView() { camera.zoom = 0; camera.panX = 0; camera.panY = 0; }

  // Inverse of render()'s camera transform - converts a canvas-relative CSS-px point
  // (e.g. clientX/Y minus the canvas's getBoundingClientRect() offset) into world
  // coordinates. Used by player.js's desktop mouse control (click-and-hold walks toward
  // an absolute world point, unlike the touch joystick which only needs screen-space
  // direction) - see drawJoystick's comment for why touch never needed this.
  function screenToWorld(canvas, cssX, cssY) {
    return {
      x: camera.x + (cssX - camera.anchorX) / camera.zoom,
      y: camera.y + (cssY - camera.anchorY) / camera.zoom
    };
  }

  // ---- optional sprite support ----
  // No art assets ship with the project yet - this just wires up the loading/fallback
  // plumbing so dropping real files into public/sprites/ (see its README) is picked up
  // automatically without further code changes. Until then every draw call below just
  // takes the "not loaded" branch and renders the existing procedural vector shapes.
  const SPRITES = {};
  function trySprite(key, src) {
    const entry = { img: new Image(), loaded: false };
    entry.img.onload = () => { entry.loaded = true; };
    entry.img.onerror = () => { /* no sprite shipped - keep using procedural drawing */ };
    entry.img.src = src;
    SPRITES[key] = entry;
  }
  trySprite('player', 'sprites/player.png');
  trySprite('dog', 'sprites/dog.png');

  // ---- animation state ----
  let doorsCaged = { A: false, B: false, C: false };
  let correctDoor = null;
  let revealedAt = 0;
  let escapeEndsAt = 0; // when the wrong doors actually snap open / become lethal
  let lastCages = { A: [], B: [], C: [] }; // from game:lockin - who ended up where
  let promptRunIds = new Set(); // players who should see "RUN!" above their head
  let promptSafeIds = new Set(); // players who should see "SAFE!" above their head
  let dropAnims = new Map(); // playerId -> {start, fromX, fromY, toX, toY, doorKey}
  let deathAnims = new Map(); // playerId -> {start, x, y, dogX, dogY}
  let releasedAt = 0; // when dogs were released - drives the pen gate animation

  function setArena(arena) {
    if (!arena) return;
    ARENA_W = arena.w; ARENA_H = arena.h;
    TRAPDOORS = arena.trapdoors; DOG_PEN = arena.dogPen;
  }

  // Lighter-weight update for just the cage rects - used every round (dynamic cell
  // scaling can resize them round to round even when the rest of the arena is static).
  function setTrapdoors(trapdoors) {
    if (!trapdoors) return;
    TRAPDOORS = trapdoors;
  }

  // Sizes the canvas backing buffer to its actual displayed CSS size x devicePixelRatio
  // (for crispness on high-DPI screens), independent of the world's aspect ratio now
  // that the camera transform handles world->screen mapping rather than a fixed-aspect
  // canvas. Called on load AND on resize/orientation-change (previously only once).
  function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(1, canvas.clientWidth || ARENA_W);
    const cssH = Math.max(1, canvas.clientHeight || ARENA_H);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    // setTransform (not scale) so repeated calls never compound - every subsequent
    // coordinate (camera transform, screen-space UI, pointer events) works in CSS px.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function onNewQuestion() {
    doorsCaged = { A: false, B: false, C: false };
    correctDoor = null;
    revealedAt = 0;
    escapeEndsAt = 0;
    promptRunIds = new Set();
    promptSafeIds = new Set();
    deathAnims.clear();
    releasedAt = 0;
  }

  function onLockIn(cages) {
    // Cages rise on ALL doors, regardless of who's actually standing there.
    doorsCaged = { A: true, B: true, C: true };
    correctDoor = null;
    revealedAt = 0;
    escapeEndsAt = 0;
    lastCages = cages || { A: [], B: [], C: [] };
  }

  function onReveal(correct, escapeEndsAtParam) {
    correctDoor = correct;
    revealedAt = Date.now();
    escapeEndsAt = escapeEndsAtParam || (revealedAt + 2400);
    promptRunIds = new Set();
    promptSafeIds = new Set();
    for (const key of ['A', 'B', 'C']) {
      const ids = lastCages[key] || [];
      if (key === correct) ids.forEach(id => promptSafeIds.add(id));
      else ids.forEach(id => promptRunIds.add(id));
    }
  }

  function onDropped(drops) {
    const now = Date.now();
    for (const d of drops || []) {
      dropAnims.set(d.id, {
        start: now, fromX: d.fromX, fromY: d.fromY, toX: d.toX, toY: d.toY, doorKey: d.doorKey
      });
    }
  }

  function onRoundComplete() {
    doorsCaged = { A: false, B: false, C: false };
    correctDoor = null;
    revealedAt = 0;
    escapeEndsAt = 0;
    promptRunIds = new Set();
    promptSafeIds = new Set();
    deathAnims.clear();
    releasedAt = 0;
  }

  function onCaught(data) {
    if (!data || !data.id) return;
    deathAnims.set(data.id, {
      start: Date.now(),
      x: data.x, y: data.y,
      dogX: data.dogX, dogY: data.dogY
    });
  }

  function onDogsReleased() {
    releasedAt = Date.now(); // drives the pen gate opening animation
  }

  function shade(hex, factor) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.max(0, Math.min(255, Math.round(r * factor)));
    g = Math.max(0, Math.min(255, Math.round(g * factor)));
    b = Math.max(0, Math.min(255, Math.round(b * factor)));
    return `rgb(${r},${g},${b})`;
  }

  function drawFloor(ctx) {
    ctx.fillStyle = '#3a6b35';
    ctx.fillRect(0, 0, ARENA_W, ARENA_H);
    const tile = 32;
    for (let y = 0; y < ARENA_H; y += tile) {
      for (let x = 0; x < ARENA_W; x += tile) {
        if (((x / tile) + (y / tile)) % 2 === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.035)';
          ctx.fillRect(x, y, tile, tile);
        }
      }
    }
    ctx.strokeStyle = '#1a3a17';
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, ARENA_W - 8, ARENA_H - 8);
  }

  // Faint screen-space watermark reminding mobile players how the joystick works -
  // shown only while no touch is currently active, so it never competes with the
  // joystick itself. Drawn after the camera transform is undone (fixed screen position),
  // near the top so it doesn't sit over the bottom question overlay or the trapdoor row.
  function drawTouchHint(ctx, viewW, viewH) {
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Touch & drag anywhere to move · second finger tap = jump', viewW / 2, viewH * 0.14);
    ctx.restore();
  }

  // Desktop equivalent of drawTouchHint - same idea, different device. Unlike touch
  // (a relative-direction joystick), mouse control is a direct walk-to-point: click and
  // hold walks you toward that spot in the world, holding still after a click keeps
  // walking there, dragging keeps retargeting. Suppressed via `mouseActive` in render()
  // while a click-hold is in progress (see player.js).
  function drawDesktopHint(ctx, viewW, viewH) {
    ctx.save();
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Click & hold to walk (or WASD) · right-drag pan · scroll zoom · right-click / Space jump', viewW / 2, viewH * 0.14);
    ctx.restore();
  }

  // The virtual joystick itself - screen-space, drawn right where the controlling
  // finger first touched down. `joystick` is {originX, originY, curX, curY}, all in CSS
  // px screen coordinates (not world coordinates - the knob's direction is all that
  // matters, so no screen->world conversion is needed here).
  function drawJoystick(ctx, joystick) {
    const { originX, originY, curX, curY } = joystick;
    const dx = curX - originX, dy = curY - originY;
    const dist = Math.hypot(dx, dy);
    const clampedDist = Math.min(dist, JOYSTICK_RADIUS);
    const angle = Math.atan2(dy, dx);
    const knobX = dist > 0.01 ? originX + Math.cos(angle) * clampedDist : originX;
    const knobY = dist > 0.01 ? originY + Math.sin(angle) * clampedDist : originY;

    ctx.save();
    ctx.fillStyle = '#10102a';
    ctx.globalAlpha = 0.32;
    ctx.beginPath();
    ctx.arc(originX, originY, JOYSTICK_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#f4f1de';
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.5;
    ctx.stroke();

    ctx.globalAlpha = 0.8;
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath();
    ctx.arc(knobX, knobY, JOYSTICK_KNOB_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#10102a';
    ctx.lineWidth = 2;
    ctx.globalAlpha = 1;
    ctx.stroke();
    ctx.restore();
  }

  // Off-screen trapdoor indicators: project each door's world center through the current
  // camera transform, and if it falls outside the visible (margin-inset) viewport, clamp
  // it to the inset edge along the ray from screen-center and draw a colored arrow +
  // letter there. Self-limiting - a no-op for any door that's actually in view, so it
  // naturally does nothing in 'overview' mode at its default zoom (whole world visible).
  function drawOffscreenIndicators(ctx, viewW, viewH) {
    // Anchored to the same screen point render()'s world transform uses (not necessarily
    // true screen-center - see FOLLOW_BOTTOM_BUFFER_FRAC), so an arrow always points
    // correctly toward a door that's actually off the visible portion of the world.
    const cx = camera.anchorX, cy = camera.anchorY;
    const insetHalfW = Math.min(cx, viewW - cx) - OFFSCREEN_MARGIN;
    const insetHalfH = Math.min(cy, viewH - cy) - OFFSCREEN_MARGIN;
    if (insetHalfW <= 0 || insetHalfH <= 0) return;

    for (const key of ['A', 'B', 'C']) {
      const d = TRAPDOORS[key];
      if (!d) continue;
      const wx = d.x + d.w / 2, wy = d.y + d.h / 2;
      const sx = (wx - camera.x) * camera.zoom + cx;
      const sy = (wy - camera.y) * camera.zoom + cy;
      const dx = sx - cx, dy = sy - cy;
      if (Math.abs(dx) <= insetHalfW && Math.abs(dy) <= insetHalfH) continue; // already visible

      const scaleX = dx !== 0 ? insetHalfW / Math.abs(dx) : Infinity;
      const scaleY = dy !== 0 ? insetHalfH / Math.abs(dy) : Infinity;
      const scale = Math.min(scaleX, scaleY);
      const ax = cx + dx * scale, ay = cy + dy * scale;
      const angle = Math.atan2(dy, dx);

      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(angle);
      ctx.fillStyle = DOOR_COLORS[key];
      ctx.strokeStyle = '#10102a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(12, 0);
      ctx.lineTo(-8, -8);
      ctx.lineTo(-8, 8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.rotate(-angle);
      ctx.fillStyle = '#10102a';
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(key, 0, -18);
      ctx.restore();
    }
  }

  function drawDogPen(ctx) {
    const now = Date.now();
    const gateT = releasedAt ? Math.min(1, (now - releasedAt) / GATE_ANIM_MS) : 0;
    const gateOpen = gateT > 0.02;
    const gx = DOG_PEN.x + DOG_PEN.w / 2 - GATE_W / 2;
    const gy = DOG_PEN.y + DOG_PEN.h;

    ctx.fillStyle = '#5b3a29';
    ctx.fillRect(DOG_PEN.x, DOG_PEN.y, DOG_PEN.w, DOG_PEN.h);
    ctx.fillStyle = '#2e1c14';
    for (let x = DOG_PEN.x + 8; x < DOG_PEN.x + DOG_PEN.w; x += 12) {
      if (gateOpen && x > gx - 4 && x < gx + GATE_W + 4) continue; // gap where the gate opened
      ctx.fillRect(x, DOG_PEN.y, 3, DOG_PEN.h);
    }
    ctx.strokeStyle = '#2e1c14';
    ctx.lineWidth = 4;
    ctx.strokeRect(DOG_PEN.x, DOG_PEN.y, DOG_PEN.w, DOG_PEN.h);

    // Gate: two hinged panels that swing open from the bottom edge when dogs are released.
    const t = gateT * 1.3;
    const panelLen = GATE_W / 2;
    ctx.save();
    ctx.strokeStyle = '#e8d7b0';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.lineTo(gx + Math.cos(t) * panelLen, gy + Math.sin(t) * panelLen);
    ctx.moveTo(gx + GATE_W, gy);
    ctx.lineTo(gx + GATE_W - Math.cos(t) * panelLen, gy + Math.sin(t) * panelLen);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = '#e8d7b0';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('DOG PEN', DOG_PEN.x + DOG_PEN.w / 2, DOG_PEN.y + DOG_PEN.h + 14);
  }

  // The pit under a trapdoor - drawn underneath the door panel always, but only actually
  // visible once the panel's gone (open door). A flat black rect used to read as a blank
  // square; this gives it a sense of depth instead: a vertical gradient (lit rim fading
  // to black, like light falling into a shaft), a darker inset "floor" offset toward the
  // bottom-right (implies looking down at an angle rather than straight into a flat
  // tile), and a beveled rim (light catching the top/left edge, shadow along the
  // bottom/right) so the opening itself reads as a raised lip you could fall through.
  function drawPitDepth(ctx, d) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(d.x, d.y, d.w, d.h);
    ctx.clip();

    const grad = ctx.createLinearGradient(d.x, d.y, d.x, d.y + d.h);
    grad.addColorStop(0, '#2e2a26');
    grad.addColorStop(0.22, '#151311');
    grad.addColorStop(1, '#000000');
    ctx.fillStyle = grad;
    ctx.fillRect(d.x, d.y, d.w, d.h);

    const inset = Math.min(d.w, d.h) * 0.24;
    ctx.fillStyle = '#000000';
    ctx.fillRect(d.x + inset * 0.7, d.y + inset * 1.3, d.w - inset * 1.4, d.h - inset * 1.6);

    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath();
    ctx.moveTo(d.x + 2, d.y + d.h - 2);
    ctx.lineTo(d.x + 2, d.y + 2);
    ctx.lineTo(d.x + d.w - 2, d.y + 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.moveTo(d.x + d.w - 2, d.y + 2);
    ctx.lineTo(d.x + d.w - 2, d.y + d.h - 2);
    ctx.lineTo(d.x + 2, d.y + d.h - 2);
    ctx.stroke();

    ctx.restore();
  }

  function drawTrapdoors(ctx) {
    const now = Date.now();
    for (const key of ['A', 'B', 'C']) {
      const d = TRAPDOORS[key];
      const color = DOOR_COLORS[key];
      const isCorrect = revealedAt && correctDoor === key;
      const isWrong = revealedAt && correctDoor && correctDoor !== key;

      // Timing: a wrong door stays visually shut through the whole escape window
      // (shuddering as the deadline nears) and snaps open fast exactly when it becomes
      // lethal - synced to the server's real escapeEndsAt, not a fixed local duration.
      let openProgress = 0;
      let shudderMag = 0;
      if (isWrong) {
        const untilLethal = escapeEndsAt - now;
        if (untilLethal <= 0) {
          openProgress = Math.min(1, -untilLethal / SNAP_MS);
        } else if (untilLethal <= SHUDDER_MS) {
          shudderMag = 1 - untilLethal / SHUDDER_MS;
        }
      }

      // Pit (always underneath)
      drawPitDepth(ctx, d);

      // Wood/colored door - clipped to the hole's own footprint so a fast snap can never
      // visibly spill panels onto the surrounding floor.
      if (openProgress < 1) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(d.x, d.y, d.w, d.h);
        ctx.clip();

        if (openProgress === 0) {
          const jitterX = shudderMag ? Math.sin(now / 30) * 2.5 * shudderMag : 0;
          const jitterY = shudderMag ? Math.sin(now / 21 + 1) * 1.5 * shudderMag : 0;
          ctx.fillStyle = color;
          ctx.fillRect(d.x + jitterX, d.y + jitterY, d.w, d.h);
          if (shudderMag > 0.4) {
            ctx.save();
            ctx.globalAlpha = (shudderMag - 0.4) * 0.6;
            ctx.fillStyle = '#ef4f6b';
            ctx.fillRect(d.x, d.y, d.w, d.h);
            ctx.restore();
          }
          // Letter stenciled onto the floor tile itself - only while the panel with it
          // painted on is actually still there (it "leaves" once the door pops open).
          ctx.save();
          ctx.globalAlpha = 0.38;
          ctx.fillStyle = '#000';
          ctx.font = `bold ${Math.round(Math.min(d.w, d.h) * 0.55)}px monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(key, d.x + d.w / 2 + jitterX, d.y + d.h / 2 + jitterY);
          ctx.restore();
        } else {
          const halfW = d.w / 2;
          const shift = openProgress * halfW;
          ctx.fillStyle = color;
          ctx.fillRect(d.x - shift, d.y, halfW, d.h);
          ctx.fillRect(d.x + halfW + shift, d.y, halfW, d.h);
          ctx.strokeStyle = shade(color, 0.6);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(d.x - shift + halfW / 2, d.y); ctx.lineTo(d.x - shift + halfW / 2, d.y + d.h);
          ctx.moveTo(d.x + halfW + shift + halfW / 2, d.y); ctx.lineTo(d.x + halfW + shift + halfW / 2, d.y + d.h);
          ctx.stroke();
        }

        ctx.strokeStyle = '#20140c';
        ctx.lineWidth = 3;
        ctx.strokeRect(d.x, d.y, d.w, d.h);
        ctx.restore();
      }

      // Cage bars - the wrong doors' bars vanish FAST right when their occupant is
      // freed (reveal instant), decoupled from the later door-snap timing, so players
      // get a crisp "you can move now" signal.
      if (doorsCaged[key]) {
        let barAlpha = 1;
        if (isWrong) barAlpha = Math.max(0, 1 - (now - revealedAt) / BAR_FADE_MS);
        if (barAlpha > 0.02) {
          ctx.save();
          ctx.globalAlpha = barAlpha;
          ctx.strokeStyle = isCorrect ? '#58d68d' : (isWrong ? '#ef4f6b' : '#dddddd');
          ctx.lineWidth = 3;
          for (let x = d.x + 6; x < d.x + d.w; x += 10) {
            ctx.beginPath();
            ctx.moveTo(x, d.y - 6);
            ctx.lineTo(x, d.y + d.h + 6);
            ctx.stroke();
          }
          ctx.strokeRect(d.x - 4, d.y - 8, d.w + 8, d.h + 16);
          ctx.restore();
        }
      }

      // Pulsing "safe" glow ring around the correct door
      if (isCorrect) {
        const pulse = 0.5 + 0.5 * Math.sin((now - revealedAt) / 150);
        ctx.save();
        ctx.globalAlpha = 0.5 + pulse * 0.3;
        ctx.strokeStyle = '#58d68d';
        ctx.lineWidth = 4;
        ctx.strokeRect(d.x - 8, d.y - 12, d.w + 16, d.h + 20);
        ctx.restore();
      }
    }
  }

  function drawPlayerBody(ctx, x, y, color, isGhost, isMe, label, alpha, scale) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.scale(scale, scale);

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(0, 12, 12, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    if (SPRITES.player && SPRITES.player.loaded) {
      ctx.globalAlpha = isGhost ? alpha * 0.6 : alpha;
      ctx.drawImage(SPRITES.player.img, -14, -28, 28, 40);
    } else {
      ctx.fillStyle = isGhost ? '#cfd8ff' : color;
      ctx.fillRect(-10, -14, 20, 18);
      ctx.fillRect(-8, -24, 16, 12);
      ctx.strokeStyle = '#10102a';
      ctx.lineWidth = 2;
      ctx.strokeRect(-10, -14, 20, 18);
      ctx.strokeRect(-8, -24, 16, 12);
    }

    ctx.globalAlpha = Math.min(1, alpha + 0.4);
    ctx.fillStyle = isMe ? '#ffd23f' : '#f4f1de';
    ctx.font = isMe ? 'bold 11px monospace' : '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, 0, -30);
    ctx.restore();
  }

  function drawPlayer(ctx, p, isMe) {
    const now = Date.now();
    const bob = p.isGhost ? Math.sin(now / 300 + p.x) * 3 : 0;
    const jumping = p.jumpUntil && p.jumpUntil > now;
    let squashY = 0, scale = 1;
    if (jumping) {
      const remaining = p.jumpUntil - now;
      const t = 1 - Math.max(0, Math.min(1, remaining / 320));
      squashY = -Math.sin(t * Math.PI) * 10;
      scale = 1 + Math.sin(t * Math.PI) * 0.12;
    }
    const alpha = p.isGhost ? 0.45 : (p.connected === false ? 0.6 : 1);
    const label = p.isGhost ? `👻 ${p.name}` : p.name;
    drawPlayerBody(ctx, p.x, p.y + bob + squashY, p.color, p.isGhost, isMe, label, alpha, scale);
  }

  // "RUN!" / "SAFE!" prompt above a player who just found out which door they were in.
  function drawPlayerPrompt(ctx, p) {
    if (!revealedAt || Date.now() >= escapeEndsAt) return;
    let text = null, color = null;
    if (promptSafeIds.has(p.id)) { text = 'SAFE!'; color = '#58d68d'; }
    else if (promptRunIds.has(p.id)) { text = 'RUN!'; color = '#ef4f6b'; }
    if (!text) return;
    const now = Date.now();
    const bob = Math.sin(now / 120) * 2;
    ctx.save();
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.strokeStyle = '#10102a';
    ctx.lineWidth = 3;
    ctx.strokeText(text, p.x, p.y - 44 + bob);
    ctx.fillStyle = color;
    ctx.fillText(text, p.x, p.y - 44 + bob);
    ctx.restore();
  }

  function drawFallingGhost(ctx, p, anim, isMe) {
    const now = Date.now();
    const t = Math.max(0, Math.min(1, (now - anim.start) / FALL_DUR));
    const door = TRAPDOORS[anim.doorKey];
    const pitX = door ? door.x + door.w / 2 : anim.fromX;
    const pitY = door ? door.y + door.h / 2 : anim.fromY;

    let x, y, scale, alpha;
    if (t < 0.4) {
      // Phase 1: sink down into the hole they fell through.
      const pt = t / 0.4;
      x = anim.fromX + (pitX - anim.fromX) * pt;
      y = anim.fromY + (pitY - anim.fromY) * pt;
      scale = 1 - 0.85 * pt;
      alpha = 1 - 0.7 * pt;
    } else {
      // Phase 2: pop back up nearby as a ghost.
      const pt = (t - 0.4) / 0.6;
      const rise = Math.sin(pt * Math.PI * 0.5);
      x = pitX + (anim.toX - pitX) * pt;
      y = pitY + (anim.toY - pitY) * pt;
      scale = 0.15 + 0.85 * rise;
      alpha = 0.3 + 0.7 * pt;
    }
    const label = `👻 ${p.name}`;
    drawPlayerBody(ctx, x, y, p.color, true, isMe, label, alpha, Math.max(0.15, scale));
  }

  function drawDog(ctx, dog) {
    const now = Date.now();
    const angle = dog.angle || 0;
    const resting = dog.state === 'home';
    const eating = dog.state === 'eating';
    const windup = !!dog.windup;
    const lunging = !!dog.lunging;
    const wag = resting ? 0.15 : (eating ? 0.05 : Math.sin(now / 90) * 0.55);
    const trot = (resting || eating) ? 0 : Math.sin(now / 70) * 2;
    const chewBob = eating ? Math.abs(Math.sin(now / 160)) * 2 : 0;

    ctx.save();
    ctx.translate(dog.x, dog.y + chewBob);
    ctx.rotate(angle);
    // Lunge tells: a brief crouch (windup) then an elongated forward burst (lunging).
    const lungeScaleX = lunging ? 1.3 : (windup ? 0.9 : 1);
    const lungeScaleY = lunging ? 0.85 : (windup ? 0.92 : 1);
    ctx.scale(lungeScaleX, lungeScaleY);
    if (resting) ctx.globalAlpha = 0.75;

    if (windup) {
      ctx.save();
      ctx.strokeStyle = 'rgba(239,79,107,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(0, 10, 13, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    if (SPRITES.dog && SPRITES.dog.loaded) {
      ctx.drawImage(SPRITES.dog.img, -17, -13, 34, 26);
      ctx.restore();
      return;
    }

    const furColor = '#8a5a3b';
    const furDark = '#5b3a29';
    const furDarker = '#3a2418';

    // Tail (rear = -x in local space since +x is "forward")
    ctx.save();
    ctx.translate(-12, 0);
    ctx.rotate(wag);
    ctx.fillStyle = furDark;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(-8, -8, -10, -14);
    ctx.lineWidth = 3;
    ctx.strokeStyle = furDark;
    ctx.stroke();
    ctx.restore();

    // Legs (simple running ticks)
    ctx.strokeStyle = furDarker;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-6, 6); ctx.lineTo(-6 - trot, 12);
    ctx.moveTo(5, 6); ctx.lineTo(5 + trot, 12);
    ctx.moveTo(-6, -6); ctx.lineTo(-6 + trot, -12);
    ctx.moveTo(5, -6); ctx.lineTo(5 - trot, -12);
    ctx.stroke();

    // Body
    ctx.fillStyle = furColor;
    ctx.beginPath();
    ctx.ellipse(-2, 0, 13, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = furDarker;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Head (toward heading, +x) - dips slightly while eating
    const headY = eating ? 3 : 0;
    ctx.fillStyle = furColor;
    ctx.beginPath();
    ctx.ellipse(11, headY, 7, 6.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Snout
    ctx.fillStyle = furDark;
    ctx.beginPath();
    ctx.moveTo(15, headY - 3);
    ctx.lineTo(21, headY - 1);
    ctx.lineTo(21, headY + 1);
    ctx.lineTo(15, headY + 3);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = furDarker;
    ctx.beginPath();
    ctx.arc(20.5, headY, 1.6, 0, Math.PI * 2);
    ctx.fill();

    // Ears
    ctx.fillStyle = furDarker;
    ctx.beginPath();
    ctx.moveTo(6, -6); ctx.lineTo(4, -13); ctx.lineTo(10, -8); ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(6, 6); ctx.lineTo(4, 13); ctx.lineTo(10, 8); ctx.closePath();
    ctx.fill();

    // Eye
    ctx.fillStyle = '#0f0a06';
    ctx.beginPath();
    ctx.arc(13, headY - 2.5, 1.3, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawBearTrap(ctx, trap) {
    const r = 11;
    ctx.save();
    ctx.translate(trap.x, trap.y);

    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(0, 3, r, r * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#4a4a4a';
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const jawColor = trap.sprung ? '#8a1c1c' : '#c9c9c9';
    const spread = trap.sprung ? 0.15 : 1; // sprung = jaws mostly closed
    ctx.strokeStyle = jawColor;
    ctx.lineWidth = 2.2;
    const teeth = 6;
    for (let side = -1; side <= 1; side += 2) {
      ctx.save();
      ctx.rotate(side * (0.5 + spread * 0.55));
      for (let i = 0; i < teeth; i++) {
        const a = -0.8 + (i / (teeth - 1)) * 1.6;
        const tx1 = Math.cos(a) * r * 0.45, ty1 = Math.sin(a) * r * 0.45;
        const tx2 = Math.cos(a) * r, ty2 = Math.sin(a) * r;
        ctx.beginPath();
        ctx.moveTo(tx1, ty1);
        ctx.lineTo(tx2, ty2);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.fillStyle = '#8a1c1c';
    ctx.beginPath();
    ctx.arc(0, 0, 2.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawBloodPuddle(ctx, x, y, t) {
    const grow = Math.min(1, t / 0.4);
    const w = 22 * grow, h = 11 * grow;
    ctx.save();
    ctx.globalAlpha = 0.75 * Math.min(1, grow + 0.2);
    ctx.fillStyle = '#7a0f14';
    ctx.beginPath();
    ctx.ellipse(x, y, w, h, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.45 * Math.min(1, grow + 0.2);
    ctx.fillStyle = '#4a0a0d';
    ctx.beginPath();
    ctx.ellipse(x, y, w * 0.5, h * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawDeathAnim(ctx, p, anim, isMe) {
    const now = Date.now();
    const t = Math.max(0, (now - anim.start) / 1000);
    const x = anim.x, y = anim.y;

    drawBloodPuddle(ctx, x, y, t);

    const fallT = Math.min(1, t / 0.45);
    const rotate = fallT * (Math.PI / 2); // tips over onto its side
    const alpha = t > 0.9 ? Math.max(0.3, 1 - (t - 0.9) * 2) : 1;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(rotate);
    ctx.fillStyle = p.color;
    ctx.fillRect(-10, -14, 20, 18);
    ctx.fillRect(-8, -24, 16, 12);
    ctx.strokeStyle = '#10102a';
    ctx.lineWidth = 2;
    ctx.strokeRect(-10, -14, 20, 18);
    ctx.strokeRect(-8, -24, 16, 12);
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = Math.min(1, alpha + 0.3);
    ctx.fillStyle = isMe ? '#ffd23f' : '#f4f1de';
    ctx.font = isMe ? 'bold 11px monospace' : '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(p.name, x, y - 30);
    ctx.restore();
  }

  // `viewMode`: 'overview' (whole map, host + desktop players) or 'follow' (zoomed on
  // the player, mobile). `joystick`, if present ({originX,originY,curX,curY} in CSS px),
  // is the touch virtual joystick, drawn in place of the idle touch hint. `mouseActive`
  // just suppresses the idle desktop hint while a click-and-hold move is in progress -
  // desktop mouse control is a direct walk-to-point (see player.js), not a joystick, so
  // there's nothing screen-space to draw for it. All the draw calls between the camera
  // translate and ctx.restore() below are unchanged from before this system existed -
  // they just draw in world coordinates same as always.
  function render(ctx, { players, dogs, traps, myId, viewMode = 'overview', joystick, mouseActive } = {}) {
    const canvas = ctx.canvas;
    const dpr = window.devicePixelRatio || 1;
    const viewW = canvas.clientWidth || (canvas.width / dpr);
    const viewH = canvas.clientHeight || (canvas.height / dpr);

    updateCamera(viewMode, players, myId, viewW, viewH);

    ctx.save();
    // Opaque fill of the whole viewport first - doubles as the clear, and covers any
    // letterbox margin outside the world (e.g. a viewport aspect ratio that doesn't
    // exactly match the world's, or overview zoomed in past whole-map-fit).
    ctx.fillStyle = '#111120';
    ctx.fillRect(0, 0, viewW, viewH);

    ctx.translate(camera.anchorX, camera.anchorY);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    drawFloor(ctx);
    drawDogPen(ctx);
    drawTrapdoors(ctx);
    for (const trap of (traps || [])) drawBearTrap(ctx, trap);

    const now = Date.now();
    for (const [id, anim] of dropAnims.entries()) {
      if (now - anim.start > FALL_DUR) dropAnims.delete(id);
    }
    for (const [id, anim] of deathAnims.entries()) {
      if (now - anim.start > DEATH_ANIM_DUR) deathAnims.delete(id);
    }

    const sorted = [...(players || [])].sort((a, b) => a.y - b.y);
    for (const p of sorted) {
      const deathAnim = deathAnims.get(p.id);
      const dropAnim = dropAnims.get(p.id);
      if (deathAnim) {
        drawDeathAnim(ctx, p, deathAnim, p.id === myId);
      } else if (dropAnim) {
        drawFallingGhost(ctx, p, dropAnim, p.id === myId);
      } else {
        if (!p.isGhost && p.rootedUntil && p.rootedUntil > now) {
          drawBearTrap(ctx, { x: p.x, y: p.y + 9, sprung: true });
        }
        drawPlayer(ctx, p, p.id === myId);
        if (!p.isGhost) drawPlayerPrompt(ctx, p);
      }
    }
    for (const d of (dogs || [])) drawDog(ctx, d);

    ctx.restore(); // back to screen space for the UI below

    drawOffscreenIndicators(ctx, viewW, viewH);
    if (myId) {
      // The joystick itself works identically for mouse and touch (Pointer Events unify
      // both), so it's shown for either regardless of viewMode - only the idle hint text
      // differs, since "touch & drag"/right-click phrasing depends on the input device.
      if (joystick) drawJoystick(ctx, joystick);
      else if (viewMode === 'follow') drawTouchHint(ctx, viewW, viewH);
      else if (!mouseActive) drawDesktopHint(ctx, viewW, viewH);
    }
  }

  return {
    setArena, setTrapdoors, fitCanvas, render, adjustZoom, panBy, resetPan, resetView, screenToWorld,
    onNewQuestion, onLockIn, onReveal, onDropped, onRoundComplete,
    onCaught, onDogsReleased,
    get ARENA_W() { return ARENA_W; }, get ARENA_H() { return ARENA_H; }
  };
})();
