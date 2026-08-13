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
  const DEATH_ANIM_DUR = 1200; // roughly matches server DEATH_ANIM_MS

  // ---- animation state ----
  let doorsCaged = { A: false, B: false, C: false };
  let correctDoor = null;
  let revealedAt = 0;
  let doorOpenStart = {};
  let dropAnims = new Map(); // playerId -> {start, fromX, fromY, toX, toY}
  let deathAnims = new Map(); // playerId -> {start, x, y, dogX, dogY, color, name}
  let chaseGiveUpAt = 0;

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
    deathAnims.clear();
    chaseGiveUpAt = 0;
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
    deathAnims.clear();
    chaseGiveUpAt = 0;
  }

  function onCaught(data) {
    if (!data || !data.id) return;
    deathAnims.set(data.id, {
      start: Date.now(),
      x: data.x, y: data.y,
      dogX: data.dogX, dogY: data.dogY
    });
  }

  function onDogsReleased(data) {
    chaseGiveUpAt = (data && data.giveUpAt) || 0;
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
    const now = Date.now();
    const angle = dog.angle || 0;
    const resting = dog.state === 'home';
    const wag = resting ? 0.15 : Math.sin(now / 90) * 0.55;
    const trot = resting ? 0 : Math.sin(now / 70) * 2;

    ctx.save();
    ctx.translate(dog.x, dog.y);
    ctx.rotate(angle);
    if (resting) ctx.globalAlpha = 0.75;

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(0, 10, 13, 5, 0, 0, Math.PI * 2);
    ctx.fill();

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

    // Head (toward heading, +x)
    ctx.fillStyle = furColor;
    ctx.beginPath();
    ctx.ellipse(11, 0, 7, 6.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Snout
    ctx.fillStyle = furDark;
    ctx.beginPath();
    ctx.moveTo(15, -3);
    ctx.lineTo(21, -1);
    ctx.lineTo(21, 1);
    ctx.lineTo(15, 3);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = furDarker;
    ctx.beginPath();
    ctx.arc(20.5, 0, 1.6, 0, Math.PI * 2);
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
    ctx.arc(13, -2.5, 1.3, 0, Math.PI * 2);
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

  function drawChaseCountdown(ctx) {
    if (!chaseGiveUpAt) return;
    const remainingMs = chaseGiveUpAt - Date.now();
    if (remainingMs <= 0) return;
    const secs = Math.ceil(remainingMs / 1000);
    const label = `🐾 dogs give up in ${secs}s`;
    const cx = DOG_PEN.x + DOG_PEN.w / 2;
    const y = DOG_PEN.y + DOG_PEN.h + 34;
    ctx.save();
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    const textWidth = ctx.measureText(label).width;
    const padX = 10, padY = 6;
    ctx.fillStyle = 'rgba(16,16,42,0.85)';
    ctx.strokeStyle = '#f4f1de';
    ctx.lineWidth = 2;
    const boxW = textWidth + padX * 2, boxH = 20 + padY;
    ctx.beginPath();
    ctx.rect(cx - boxW / 2, y - boxH / 2, boxW, boxH);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffd23f';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, y + 1);
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
    for (const [id, anim] of deathAnims.entries()) {
      if (now - anim.start > DEATH_ANIM_DUR) deathAnims.delete(id);
    }

    const sorted = [...players].sort((a, b) => a.y - b.y);
    for (const p of sorted) {
      const deathAnim = deathAnims.get(p.id);
      const dropAnim = dropAnims.get(p.id);
      if (deathAnim) drawDeathAnim(ctx, p, deathAnim, p.id === myId);
      else if (dropAnim) drawFallingGhost(ctx, p, dropAnim, p.id === myId);
      else drawPlayer(ctx, p, p.id === myId);
    }
    for (const d of (dogs || [])) drawDog(ctx, d);
    drawChaseCountdown(ctx);
  }

  return {
    setArena, fitCanvas, render,
    onNewQuestion, onLockIn, onReveal, onDropped, onRoundComplete,
    onCaught, onDogsReleased,
    get ARENA_W() { return ARENA_W; }, get ARENA_H() { return ARENA_H; }
  };
})();
