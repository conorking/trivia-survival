// Shared rendering used by both host (spectator) and player views.
// Draws a top-down GBA-style pixel arena onto a canvas.
// Animation state (lockin/reveal/drop) is owned internally and driven by
// onLockIn / onReveal / onDropped / onRoundComplete / onNewQuestion calls.

const ArenaRender = (() => {
  let ARENA_W = 800, ARENA_H = 500;
  let TRAPDOORS = {
    A: { x: 130, y: 400, w: 110, h: 90 },
    B: { x: 345, y: 400, w: 110, h: 90 },
    C: { x: 560, y: 400, w: 110, h: 90 }
  };
  let DOG_PEN = { x: 330, y: 20, w: 140, h: 60 };

  const DOOR_COLORS = { A: '#ef8f4f', B: '#4fb8ef', C: '#b84fef' };
  const DOOR_OPEN_DUR = 900;
  const FALL_DUR = 900;

  // ---- animation state ----
  let doorsCaged = { A: false, B: false, C: false };
  let correctDoor = null;
  let revealedAt = 0;
  let doorOpenStart = {};
  let dropAnims = new Map(); // playerId -> {start, fromX, fromY, toX, toY}

  function setArena(arena) {
    if (!arena) return;
    ARENA_W = arena.w; ARENA_H = arena.h;
    TRAPDOORS = arena.trapdoors; DOG_PEN = arena.dogPen;
  }

  function fitCanvas(canvas) {
    canvas.width = ARENA_W;
    canvas.height = ARENA_H;
  }

  function onNewQuestion() {
    doorsCaged = { A: false, B: false, C: false };
    correctDoor = null;
    revealedAt = 0;
    doorOpenStart = {};
  }

  function onLockIn() {
    // Cages rise on ALL doors, regardless of who's actually standing there.
    doorsCaged = { A: true, B: true, C: true };
    correctDoor = null;
    revealedAt = 0;
    doorOpenStart = {};
  }

  function onReveal(correct) {
    correctDoor = correct;
    revealedAt = Date.now();
    for (const key of ['A', 'B', 'C']) {
      if (key !== correct) doorOpenStart[key] = Date.now();
    }
  }

  function onDropped(drops) {
    const now = Date.now();
    for (const d of drops || []) {
      dropAnims.set(d.id, { start: now, fromX: d.fromX, fromY: d.fromY, toX: d.toX, toY: d.toY });
    }
  }

  function onRoundComplete() {
    doorsCaged = { A: false, B: false, C: false };
    correctDoor = null;
    revealedAt = 0;
    doorOpenStart = {};
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

  function drawDogPen(ctx) {
    ctx.fillStyle = '#5b3a29';
    ctx.fillRect(DOG_PEN.x, DOG_PEN.y, DOG_PEN.w, DOG_PEN.h);
    ctx.strokeStyle = '#2e1c14';
    ctx.lineWidth = 4;
    ctx.strokeRect(DOG_PEN.x, DOG_PEN.y, DOG_PEN.w, DOG_PEN.h);
    ctx.fillStyle = '#2e1c14';
    for (let x = DOG_PEN.x + 8; x < DOG_PEN.x + DOG_PEN.w; x += 12) {
      ctx.fillRect(x, DOG_PEN.y, 3, DOG_PEN.h);
    }
    ctx.fillStyle = '#e8d7b0';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('DOG PEN', DOG_PEN.x + DOG_PEN.w / 2, DOG_PEN.y + DOG_PEN.h + 14);
  }

  function drawTrapdoors(ctx) {
    const now = Date.now();
    for (const key of ['A', 'B', 'C']) {
      const d = TRAPDOORS[key];
      const color = DOOR_COLORS[key];
      const isCorrect = revealedAt && correctDoor === key;
      const isWrong = revealedAt && correctDoor && correctDoor !== key;
      const openProgress = isWrong && doorOpenStart[key]
        ? Math.min(1, (now - doorOpenStart[key]) / DOOR_OPEN_DUR)
        : 0;

      // Pit (always underneath)
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(d.x, d.y, d.w, d.h);

      // Wood/colored door halves
      if (openProgress < 1) {
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
        if (openProgress > 0) {
          ctx.fillStyle = '#0a0a0a';
          ctx.fillRect(d.x + shift, d.y, d.w - shift * 2, d.h);
        }
        ctx.strokeStyle = '#20140c';
        ctx.lineWidth = 3;
        ctx.strokeRect(d.x - shift, d.y, halfW, d.h);
        ctx.strokeRect(d.x + halfW + shift, d.y, halfW, d.h);
      }

      // Letter label
      ctx.fillStyle = color;
      ctx.font = 'bold 20px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(key, d.x + d.w / 2, d.y - 14);

      // Cage bars
      if (doorsCaged[key]) {
        let barAlpha = 1;
        if (isWrong) barAlpha = 1 - openProgress;
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

      // Caption
      let caption = '';
      let capColor = '#f4f1de';
      if (doorsCaged[key] && !revealedAt) { caption = 'LOCKED'; capColor = '#dddddd'; }
      else if (isCorrect) { caption = 'SAFE \u2713'; capColor = '#58d68d'; }
      else if (isWrong && openProgress < 1) { caption = 'OPENING...'; capColor = '#ef4f6b'; }
      if (caption) {
        ctx.fillStyle = capColor;
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(caption, d.x + d.w / 2, d.y + d.h + 16);
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

    ctx.fillStyle = isGhost ? '#cfd8ff' : color;
    ctx.fillRect(-10, -14, 20, 18);
    ctx.fillRect(-8, -24, 16, 12);
    ctx.strokeStyle = '#10102a';
    ctx.lineWidth = 2;
    ctx.strokeRect(-10, -14, 20, 18);
    ctx.strokeRect(-8, -24, 16, 12);

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
    const label = p.isGhost ? `\uD83D\uDC7B ${p.name}` : p.name;
    drawPlayerBody(ctx, p.x, p.y + bob + squashY, p.color, p.isGhost, isMe, label, alpha, scale);
  }

  function drawFallingGhost(ctx, p, anim, isMe) {
    const now = Date.now();
    const t = Math.max(0, Math.min(1, (now - anim.start) / FALL_DUR));
    const x = anim.fromX + (anim.toX - anim.fromX) * t;
    const y = anim.fromY + (anim.toY - anim.fromY) * t;
    const scale = 1 - 0.55 * Math.sin(t * Math.PI);
    const alpha = 0.35 + 0.65 * t;
    const label = `\uD83D\uDC7B ${p.name}`;
    drawPlayerBody(ctx, x, y, p.color, true, isMe, label, alpha, Math.max(0.35, scale));
  }

  function drawDog(ctx, dog) {
    ctx.save();
    ctx.fillStyle = '#5b3a29';
    ctx.beginPath();
    ctx.ellipse(dog.x, dog.y, 12, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#3a2418';
    ctx.beginPath();
    ctx.ellipse(dog.x + 9, dog.y - 2, 5, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#1e1209';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  function render(ctx, { players, dogs, myId }) {
    ctx.clearRect(0, 0, ARENA_W, ARENA_H);
    drawFloor(ctx);
    drawDogPen(ctx);
    drawTrapdoors(ctx);

    const now = Date.now();
    for (const [id, anim] of dropAnims.entries()) {
      if (now - anim.start > FALL_DUR) dropAnims.delete(id);
    }

    const sorted = [...players].sort((a, b) => a.y - b.y);
    for (const p of sorted) {
      const anim = dropAnims.get(p.id);
      if (anim) drawFallingGhost(ctx, p, anim, p.id === myId);
      else drawPlayer(ctx, p, p.id === myId);
    }
    for (const d of (dogs || [])) drawDog(ctx, d);
  }

  return {
    setArena, fitCanvas, render,
    onNewQuestion, onLockIn, onReveal, onDropped, onRoundComplete,
    get ARENA_W() { return ARENA_W; }, get ARENA_H() { return ARENA_H; }
  };
})();
