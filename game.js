(() => {
  "use strict";

  // Render at a low internal resolution then scale up via CSS for a crisp pixel vibe.
  // Taller viewport for a deeper canyon.
  const W = 240;
  const H = 360;
  const DPR_CAP = 2;
  // Pee is limited per run (zen session).
  const UNLIMITED_PEE = false;

  const canvas = document.getElementById("game");
  const hintEl = document.getElementById("hint");
  const ctx = canvas.getContext("2d", { alpha: false });

  let dpr = 1;
  function applyCanvasBackingStore() {
    dpr = Math.max(1, Math.min(DPR_CAP, window.devicePixelRatio || 1));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    // Draw in logical (W/H) units.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }
  applyCanvasBackingStore();

  function onResize() {
    // Re-apply DPR backing store (handles orientation changes + zoom changes).
    applyCanvasBackingStore();
  }
  window.addEventListener("resize", onResize, { passive: true });
  window.addEventListener("orientationchange", onResize, { passive: true });

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  const palette = {
    // Sunset backdrop + silhouette foreground.
    // Slightly brighter sunset for higher contrast against near-black silhouettes.
    bgTop: "#3a1b68",
    bgMid: "#c24a66",
    bgBot: "#ffe3a1",
    sun: "rgba(255,244,225,0.80)",
    haze: "rgba(255,248,238,0.12)",

    // Foreground: near-black silhouettes (including pee).
    fg: "#0b0b10",
    fg2: "rgba(11,11,16,0.75)",
    fgSoft: "rgba(11,11,16,0.25)",

    // UI / panels (still minimalist, but readable).
    ui: "rgba(11,11,16,0.92)",
    uiDim: "rgba(11,11,16,0.55)",
    panel: "rgba(255,255,255,0.10)",
    panelEdge: "rgba(11,11,16,0.18)",
  };

  // --- Scene ---
  const State = {
    START: "start",
    START_IN: "start_in",
    START_FADING: "start_fading",
    ZEN: "zen",
    DONE_WAIT: "done_wait",
    DONE: "done",
  };

  const input = {
    mx: W / 2,
    my: H / 2,
    down: false,
    justPressed: false,
    justReleased: false,
    wantsStart: false,
  };

  const world = {
    state: State.START,
    t: 0,
    dt: 0,
    bgT: 0,
    peeLeft: 1.0, // soft limiter so "spray" feels intentional
    peeSecondsMax: 10,
    peeCooldown: 0,
    hasPeeed: false,
    startFade: 1, // 1 = overlay fully visible, 0 = gone
    // Extra pause AFTER the last drop disappears, BEFORE starting "Ahhhhhh".
    // Adjust this to change the gap between last drop and Ahhh.
    doneDelay: 1.0,
    doneDelayLeft: 0,
    ahhT: 0,
    ahhIn: 0.85,
    ahhHold: 1.8,
    ahhOut: 1.2,
  };

  const player = {
    x: W * 0.5,
    // Foot position (stands on rim). Set in resetRun() after constants are defined.
    y: 0,
    aimX: W * 0.5,
    aimY: 80,
    wobble: 0,
  };

  /** @type {{x:number,y:number,vx:number,vy:number,r:number,life:number,ttl:number,seed:number}[]} */
  const drops = [];
  /** @type {{x:number,y:number,vx:number,vy:number,life:number,ttl:number,color:string,size:number}[]} */
  const particles = [];
  /** @type {{x:number,y:number,r:number,life:number,ttl:number}[]} */
  const ripples = [];

  const RIM_Y = 64;
  const headBoops = {
    nextAt: 0,
    startAt: 0,
    upEndAt: 0,
    holdEndAt: 0,
    endAt: 0,
    amp: 0,
  };

  function resetRun() {
    drops.length = 0;
    particles.length = 0;
    ripples.length = 0;

    world.t = 0;
    world.dt = 0;
    // NOTE: do not reset world.bgT (keeps clouds continuous between runs)
    // ~10s of pee, with a bit of randomness per run.
    world.peeSecondsMax = rand(8.8, 11.6);
    world.peeLeft = 1.0;
    world.peeCooldown = 0;
    world.hasPeeed = false;
    world.startFade = 1;
    world.doneDelayLeft = 0;
    world.ahhT = 0;
    headBoops.nextAt = 0;
    headBoops.startAt = 0;
    headBoops.upEndAt = 0;
    headBoops.holdEndAt = 0;
    headBoops.endAt = 0;
    headBoops.amp = 0;

    // Place the player atop the left canyon edge (no separate platform geometry).
    const rimEdge = xLeft(RIM_Y);
    player.x = clamp(rimEdge - 3, 4, W - 4);
    // Treat this as the foot position resting on a 1px rim line.
    player.y = RIM_Y - 1;
    player.aimX = W * 0.60;
    player.aimY = H * 0.55;
    player.wobble = 0;
  }

  function splat(x, y, dirX, dirY, intensity) {
    // Fewer particles = calmer / cleaner.
    const n = Math.round(lerp(4, 10, clamp(intensity, 0, 1)));
    for (let i = 0; i < n; i++) {
      const a = rand(-Math.PI, Math.PI);
      const s = rand(0.25, 1.1) + intensity * 0.9;
      particles.push({
        x,
        y,
        vx: Math.cos(a) * s + dirX * rand(0.3, 1.2),
        vy: Math.sin(a) * s + dirY * rand(0.3, 1.2),
        life: 0,
        ttl: rand(0.35, 0.75),
        color: i % 4 === 0 ? palette.fg2 : palette.fg,
        size: rand(1, 2.1),
      });
    }
  }

  function addRipple(x, y) {
    ripples.push({
      x,
      y,
      r: 1.5,
      life: 0,
      ttl: rand(1.4, 2.4),
    });
  }

  function getPlayerPose() {
    const peeing = input.down ? 1 : 0;

    // Occasional smooth nod: low -> up -> hold -> down (disabled while peeing).
    let headBob = 0;
    if (peeing) {
      // Avoid an immediate nod on release.
      headBoops.nextAt = Math.max(headBoops.nextAt, world.t + 0.25);
      headBoops.endAt = 0;
    } else {
      if (headBoops.nextAt <= 0) headBoops.nextAt = world.t + rand(0.9, 2.2);

      if (world.t >= headBoops.nextAt) {
        headBoops.startAt = world.t;
        const upDur = rand(0.12, 0.20);
        const holdDur = rand(0.38, 0.75);
        const downDur = rand(0.16, 0.26);
        headBoops.upEndAt = headBoops.startAt + upDur;
        headBoops.holdEndAt = headBoops.upEndAt + holdDur;
        headBoops.endAt = headBoops.holdEndAt + downDur;
        headBoops.amp = rand(0.55, 1.05);
        headBoops.nextAt = headBoops.endAt + rand(1.0, 3.0);
      }

      if (headBoops.endAt > headBoops.startAt && world.t >= headBoops.startAt && world.t <= headBoops.endAt) {
        let v = 0;
        if (world.t <= headBoops.upEndAt) {
          const p = clamp((world.t - headBoops.startAt) / (headBoops.upEndAt - headBoops.startAt), 0, 1);
          v = Math.sin(p * Math.PI * 0.5); // 0->1
        } else if (world.t <= headBoops.holdEndAt) {
          v = 1; // hold
        } else {
          const p = clamp((world.t - headBoops.holdEndAt) / (headBoops.endAt - headBoops.holdEndAt), 0, 1);
          v = Math.cos(p * Math.PI * 0.5); // 1->0
        }
        // Negative = head moves up.
        headBob = -headBoops.amp * v;
      }
    }
    const leanX = peeing ? 2 : 0;
    const leanY = peeing ? 1 : 0;

    return { headBob, leanX, leanY, peeing };
  }

  function getPeeOrigin() {
    // Stream comes from mid-height of the character.
    const pose = getPlayerPose();
    const x = player.x + pose.leanX;
    const y = player.y - 10 + pose.leanY; // mid-height (player is ~20px tall)
    return { x, y };
  }

  function addDrop(targetX, targetY, strength01) {
    const o = getPeeOrigin();
    const sx = o.x;
    const sy = o.y;

    const dx = targetX - sx;
    // Allow aiming anywhere (up/down/left/right). Avoid a near-zero vector.
    let dy = targetY - sy;
    if (Math.abs(dx) + Math.abs(dy) < 0.001) dy = 1;

    const base = Math.atan2(dy, dx);
    // Slight spread for a "stream" feel, but keep it controllable at long range.
    // (Too much spread + drag = edge shots sometimes fall short.)
    // Tighter cone => neater stream.
    // Tighter cone => narrow stream.
    const spread = rand(-0.02, 0.02) * (0.40 + (1 - strength01) * 0.12);
    const a = base + spread;

    // Lower-pressure stream (less fountain-y), but still reaches into the canyon.
    // Slightly lower speed helps reduce spacing between drops at a fixed emission rate.
    const speed = lerp(1.45, 2.85, strength01) + rand(-0.03, 0.08);

    const vx = Math.cos(a) * speed;
    const vy = Math.sin(a) * speed;

    drops.push({
      // Less spawn jitter keeps the stream tight.
      x: sx + rand(-0.25, 0.25),
      y: sy + rand(-0.25, 0.25),
      vx,
      vy,
      // Smaller drops => neater-looking stream.
      // Smaller drops (stream stays dense via emission rate).
      r: rand(0.50, 0.95),
      life: 0,
      ttl: rand(1.3, 2.2),
      seed: Math.random(),
    });
  }

  function toGameCoords(ev) {
    const rect = canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * W;
    const y = ((ev.clientY - rect.top) / rect.height) * H;
    return {
      x: clamp(x, 0, W),
      y: clamp(y, 0, H),
    };
  }

  // --- Input ---
  canvas.addEventListener("pointerdown", (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    const p = toGameCoords(ev);
    input.mx = p.x;
    input.my = p.y;
    input.justPressed = true;

    // If run is finished: let the "Ahhhhhh" finish and return to menu automatically.
    if (world.state === State.DONE) {
      return;
    }

    // Start screen click: begin fade, and also start peeing.
    if (world.state === State.START || world.state === State.START_IN || world.state === State.START_FADING) {
      if (world.state === State.START || world.state === State.START_IN) {
        world.state = State.START_FADING;
      }
      // First click both starts and aims.
      input.down = true;
      return;
    }

    // In ZEN: single click starts the stream (no need to hold).
    input.down = true;
  });

  // iOS Safari sometimes still tries to scroll/zoom during touch despite pointer events.
  // This keeps interaction stable.
  canvas.addEventListener(
    "touchmove",
    (ev) => {
      ev.preventDefault();
    },
    { passive: false }
  );

  canvas.addEventListener("pointermove", (ev) => {
    const p = toGameCoords(ev);
    input.mx = p.x;
    input.my = p.y;
  });

  canvas.addEventListener("pointerup", (ev) => {
    const p = toGameCoords(ev);
    input.mx = p.x;
    input.my = p.y;
    // Don't stop peeing on release; stream is tap-to-start and ends when pee runs out.
    input.justReleased = true;
  });

  window.addEventListener("keydown", (ev) => {
    // Simple reset (still feels fine for a toy).
    if (ev.key === "r" || ev.key === "R") resetRun();
  });

  // --- Drawing helpers ---
  function pxRect(x, y, w, h, c) {
    ctx.fillStyle = c;
    ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
  }

  function fRect(x, y, w, h, c) {
    // Float rect for smoother (sub-pixel) motion when desired.
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  }

  function drawDitherBackground(t) {
    // Sunset background (no jitter): gradient + soft sun + subtle haze.
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0.0, palette.bgTop);
    g.addColorStop(0.55, palette.bgMid);
    g.addColorStop(1.0, palette.bgBot);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Subtle light shaft to help the dark stream read against the canyon sky.
    // (Background-only: does not change pee color/size.)
    {
      const cx = W * 0.45;
      const cy = H * 0.45;
      const r = Math.max(W, H) * 0.85;
      const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      rg.addColorStop(0.0, "rgba(255,255,255,0.12)");
      rg.addColorStop(0.6, "rgba(255,255,255,0.05)");
      rg.addColorStop(1.0, "rgba(255,255,255,0.00)");
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, W, H);
    }

    // Sun
    // Sun parked at the bottom-right of the canyon.
    const sx = W * 0.82;
    // Push it below the canvas so only the upper half peeks out (no bob).
    const sy = H - 20;
    ctx.fillStyle = palette.sun;
    ctx.beginPath();
    ctx.arc(sx, sy, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.arc(sx, sy, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Haze bands
    ctx.fillStyle = palette.haze;
    for (let i = 0; i < 4; i++) {
      // Use sub-pixel coordinates to avoid visible stepping/jitter.
      const period = W + 140;
      const x0 = (i * 90 + t * (i % 2 ? 4.5 : -3.8)) % period;
      const x = x0 - 70;
      const y = H * 0.44 + i * 14 + Math.sin(t * 0.28 + i * 1.7) * 2.2;
      // Draw tiled copies so bands slide in/out instead of "popping" on wrap.
      for (let k = -1; k <= 1; k++) {
        ctx.fillRect(x + k * period, y, 120, 7);
      }
    }
  }

  function xLeft(y) {
    const t = clamp((y - RIM_Y) / (H - RIM_Y), 0, 1);
    const inset = lerp(18, 44, t);
    // Static canyon geometry (no time-based "breathing"), so refreshes look identical.
    const w = Math.sin(y * 0.055) * lerp(1.5, 4.5, t);
    return inset + w;
  }

  function xRight(y) {
    const t = clamp((y - RIM_Y) / (H - RIM_Y), 0, 1);
    const inset = lerp(16, 52, t);
    // Static canyon geometry (no time-based "breathing"), so refreshes look identical.
    const w = Math.sin(y * 0.048 + 1.7) * lerp(1.5, 4.0, t);
    return W - (inset + w);
  }

  function floorY(x) {
    const t = clamp(x / W, 0, 1);
    const base = H - 14;
    // Static canyon floor.
    return base + Math.sin(t * Math.PI * 2) * 2;
  }

  function drawCanyon() {
    // Canyon opening starts at RIM_Y. Keep the top clean/minimal.
    const rimEdge = xLeft(RIM_Y);
    // A single-pixel rim line so the player reads as standing on the canyon.
    ctx.fillStyle = palette.fg;
    ctx.fillRect(0, (RIM_Y - 1) | 0, rimEdge | 0, 1);

    // Left wall
    ctx.fillStyle = palette.fg2;
    ctx.beginPath();
    ctx.moveTo(0, RIM_Y);
    ctx.lineTo(rimEdge, RIM_Y);
    for (let y = RIM_Y; y <= H + 2; y += 2) ctx.lineTo(xLeft(y), y);
    ctx.lineTo(0, H + 2);
    ctx.closePath();
    ctx.fill();

    // Right wall
    ctx.beginPath();
    ctx.moveTo(W, RIM_Y);
    ctx.lineTo(xRight(RIM_Y), RIM_Y);
    for (let y = RIM_Y; y <= H + 2; y += 2) ctx.lineTo(xRight(y), y);
    ctx.lineTo(W, H + 2);
    ctx.closePath();
    ctx.fill();

    // Floor silhouette
    ctx.fillStyle = palette.fg;
    ctx.beginPath();
    const y0 = floorY(0);
    ctx.moveTo(0, y0);
    for (let x = 0; x <= W; x += 4) ctx.lineTo(x, floorY(x));
    ctx.lineTo(W, H + 2);
    ctx.lineTo(0, H + 2);
    ctx.closePath();
    ctx.fill();
  }

  function drawToiletMan() {
    // Taller, minimalist/geometric silhouette.
    const pose = getPlayerPose();
    const x = (player.x + pose.leanX) | 0;
    const y = player.y | 0; // foot y (body does not bob)
    // Match canyon edge translucency.
    const fg = palette.fg2;
    
    // Height reference: total ~20px.
    // Head
    // Sub-pixel head bob so it feels smooth even at low res.
    fRect(x - 2, y - 20 + pose.headBob, 5, 5, fg);

    // Body: simple geometric column (no neck/shoulders/arms).
    pxRect(x - 2, y - 14, 5, 10, fg);

    // Legs (slightly apart)
    pxRect(x - 2, y - 4, 2, 4, fg);
    pxRect(x + 1, y - 4, 2, 4, fg);
  }

  function drawDrops() {
    for (const d of drops) {
      // Stretch drop a bit based on speed for a more "liquid" feel.
      const sp = Math.hypot(d.vx, d.vy);
      const sx = d.x | 0;
      const sy = d.y | 0;
      // Keep stretch subtle so the stream reads "tight" instead of chunky.
      const w = Math.max(1, (d.r * (1.05 + sp * 0.22)) | 0);
      const h = Math.max(1, (d.r * (1.10 + sp * 0.55)) | 0);

      // Body (fade out gently)
      const a = clamp(1 - d.life / d.ttl, 0, 1);
      ctx.globalAlpha = 0.88 * a;
      ctx.fillStyle = palette.fg;
      ctx.fillRect(sx - (w >> 1), sy - (h >> 1), w, h);

      // Tiny trail (subtle, still silhouette)
      if (sp > 2.2 && (world.t * 60) % 3 < 1) {
        ctx.globalAlpha = 0.18 * a;
        ctx.fillStyle = palette.fg2;
        ctx.fillRect((sx - d.vx * 2) | 0, (sy - d.vy * 2) | 0, 1, 1);
      }
      ctx.globalAlpha = 1;
    }
  }

  function drawParticles() {
    for (const p of particles) {
      const a = 1 - p.life / p.ttl;
      ctx.fillStyle = p.color;
      ctx.globalAlpha = clamp(a, 0, 1);
      ctx.fillRect(p.x | 0, p.y | 0, p.size | 0, p.size | 0);
    }
    ctx.globalAlpha = 1;
  }

  function drawRipples() {
    for (const r of ripples) {
      const a = clamp(1 - r.life / r.ttl, 0, 1);
      ctx.globalAlpha = 0.22 * a;
      ctx.fillStyle = palette.fg2;
      const steps = 16;
      for (let i = 0; i < steps; i++) {
        const ang = (i / steps) * Math.PI * 2;
        const x = (r.x + Math.cos(ang) * r.r) | 0;
        const y = (r.y + Math.sin(ang) * (r.r * 0.35)) | 0;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawStartOverlay(alpha) {
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);

    // Pixel-ish translucent panel
    const pw = 170;
    const ph = 78;
    const px = ((W - pw) / 2) | 0;
    const py = (H * 0.18) | 0;

    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, pw, ph);

    // Title + studio
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.font = "18px ui-monospace, Menlo, Consolas, monospace";
    ctx.fillText("PEE BREAK", (W / 2) | 0, (py + 14 + 1) | 0);
    ctx.fillStyle = palette.fg;
    ctx.fillText("PEE BREAK", (W / 2) | 0, (py + 14) | 0);

    ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillText("Pensive Pixel Studios", (W / 2) | 0, (py + 46 + 1) | 0);
    ctx.fillStyle = palette.fg2;
    ctx.fillText("Pensive Pixel Studios", (W / 2) | 0, (py + 46) | 0);

    ctx.restore();
  }

  function drawAhhFade() {
    const total = world.ahhIn + world.ahhHold + world.ahhOut;
    const tt = clamp(world.ahhT, 0, total);
    const ease = (p) => p * p * (3 - 2 * p);

    const text = "Ahhhhhh";

    // Timing curve: fast rise, longer hold, slower release.
    let a = 0;
    let drift01 = 0; // 0->1 across the whole "ahh" for exhale drift
    let scale = 1;

    if (tt < world.ahhIn) {
      const p = clamp(tt / world.ahhIn, 0, 1);
      a = ease(p);
      // Tiny overshoot into the hold (feels like a release).
      const overshoot = 1 + 0.06 * Math.sin(p * Math.PI);
      scale = overshoot;
      drift01 = p * 0.35;
    } else if (tt < world.ahhIn + world.ahhHold) {
      const p = clamp((tt - world.ahhIn) / world.ahhHold, 0, 1);
      a = 1;
      // Settle back to 1 during the hold.
      scale = 1 + 0.01 * Math.sin(p * Math.PI * 2);
      drift01 = 0.35 + p * 0.45;
    } else {
      const p = clamp((tt - (world.ahhIn + world.ahhHold)) / world.ahhOut, 0, 1);
      a = 1 - ease(p);
      // Slight shrink on the way out (like the last breath leaving).
      scale = 1 - 0.02 * ease(p);
      drift01 = 0.80 + p * 0.20;
    }

    // Near-player placement (no bubble): slightly above and to the right.
    const x = clamp(player.x + 10, 8, W - 120);
    const baseY = clamp(player.y - 64, 16, H - 40);
    // Exhale motion: gentle upward drift + a tiny float.
    const y = baseY - drift01 * 12 + Math.sin(world.t * 1.1) * 0.8;

    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = "22px ui-monospace, Menlo, Consolas, monospace";

    // Scale around the text anchor for a subtle overshoot/settle.
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.translate(-x, -y);

    // Afterglow lingers longer than the main text.
    const glowA = Math.min(1, a + 0.18) * 0.28;
    ctx.globalAlpha = glowA;
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.fillText(text, x + 3, y + 3);

    // Main text
    ctx.globalAlpha = 0.9 * a;
    ctx.fillStyle = palette.fg;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function drawZen() {
    drawDitherBackground(world.bgT);
    drawCanyon();
    drawRipples();
    drawDrops();
    drawParticles();
    drawToiletMan();

    if (world.state === State.START || world.state === State.START_IN || world.state === State.START_FADING) {
      drawStartOverlay(world.startFade);
      if (hintEl) hintEl.style.opacity = "0";
    } else if (world.state === State.DONE) {
      drawAhhFade();
    } else {
      // Minimal hint until first interaction.
      if (hintEl) hintEl.style.opacity = world.hasPeeed ? "0" : "1";
    }
  }

  // --- Simulation ---
  function updateZen(dt) {
    // Aim
    player.aimX = lerp(player.aimX, input.mx, 1 - Math.pow(0.001, dt));
    player.aimY = lerp(player.aimY, input.my, 1 - Math.pow(0.001, dt));

    // Pee drain + cooldown
    world.peeCooldown = Math.max(0, world.peeCooldown - dt);

    // Start fade transition
    if (world.state === State.START_FADING) {
      const fadeSeconds = 0.4;
      world.startFade = Math.max(0, world.startFade - dt / fadeSeconds);
      if (world.startFade <= 0) {
        world.state = State.ZEN;
      }
    }

    // Start fade-in (when returning to menu)
    if (world.state === State.START_IN) {
      const fadeInSeconds = 0.6;
      world.startFade = Math.min(1, world.startFade + dt / fadeInSeconds);
      if (world.startFade >= 1) world.state = State.START;
    }

    // If holding click: continuous stream (still satisfies "click to pee" but feels better).
    // Allow peeing during START_FADING so the first click can start the stream.
    if (world.state === State.START) return;

    // Drain while holding click (independent of emission rate).
    if (!UNLIMITED_PEE && input.down && world.state !== State.START) {
      world.peeLeft = Math.max(0, world.peeLeft - dt / world.peeSecondsMax);
      if (world.peeLeft <= 0) {
        world.peeLeft = 0;
        input.down = false;
        // Wait until the last drop disappears, then start the Ahhh sail.
        world.state = State.DONE_WAIT;
      }
    }

    if (world.state === State.DONE_WAIT) {
      // Keep simulating existing drops/particles. Once drops are gone, start the sail.
      if (drops.length === 0) {
        if (world.doneDelayLeft <= 0) world.doneDelayLeft = world.doneDelay;
        world.doneDelayLeft = Math.max(0, world.doneDelayLeft - dt);
        if (world.doneDelayLeft <= 0) {
          world.state = State.DONE;
          world.ahhT = 0;
        }
      }
    }

    if (world.state === State.DONE) {
      world.ahhT += dt;
      const total = world.ahhIn + world.ahhHold + world.ahhOut;
      if (world.ahhT >= total) {
        resetRun();
        world.state = State.START_IN;
        world.startFade = 0;
        input.down = false;
        return;
      }
      // Let existing drops/particles continue, but stop spawning new drops.
    }

    if (world.state !== State.DONE && world.state !== State.DONE_WAIT && input.down && world.peeCooldown <= 0 && (UNLIMITED_PEE || world.peeLeft > 0.05)) {
      world.hasPeeed = true;
      const strength = UNLIMITED_PEE ? 1 : clamp(world.peeLeft, 0, 1);
      // More frequent drops, but keep "gush" constant by keeping burst steady.
      const burst = 2;
      for (let i = 0; i < burst; i++) addDrop(player.aimX, player.aimY, strength);

      // Slightly faster emission => less space between drops.
      world.peeCooldown = 0.015;
    }

    // Update drops
    const g = 5.6; // px/s^2-ish (scaled by dt) - lower so the stream carries farther

    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.life += dt;

      // Slight wobble / air drift
      // Less side-to-side drift => narrow stream.
      const wob = Math.sin((world.t * 6 + d.seed * 20)) * 0.03;

      d.vy += g * dt;
      d.vx += wob * dt;

      // Drag
      d.vx *= Math.pow(0.993, dt * 60);
      d.vy *= Math.pow(0.994, dt * 60);

      d.x += d.vx * 60 * dt;
      d.y += d.vy * 60 * dt;

      // Canyon collisions (walls + floor)
      // Don't collide with the rim itself; start collisions a bit below the edge.
      if (d.y >= RIM_Y + 10) {
        const xl = xLeft(d.y);
        const xr = xRight(d.y);
        if (d.x <= xl + 1 || d.x >= xr - 1) {
          splat(d.x, d.y, d.vx * 0.15, d.vy * 0.15, 0.35);
          drops.splice(i, 1);
          continue;
        }

        const fy = floorY(d.x);
        if (d.y >= fy) {
          const yHit = fy;
          splat(d.x, yHit, d.vx * 0.1, -0.2, 0.25);
          addRipple(d.x, yHit);
          drops.splice(i, 1);
          continue;
        }
      }

      // Expired
      if (d.life > d.ttl || d.y > H + 30 || d.x < -30 || d.x > W + 30) {
        drops.splice(i, 1);
        continue;
      }
    }

    // Update particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      p.vy += 6.5 * dt;
      p.vx *= Math.pow(0.96, dt * 60);
      p.vy *= Math.pow(0.96, dt * 60);
      p.x += p.vx * 60 * dt;
      p.y += p.vy * 60 * dt;
      if (p.life > p.ttl) particles.splice(i, 1);
    }

    // Update ripples
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      r.life += dt;
      r.r += dt * 22;
      if (r.life > r.ttl) ripples.splice(i, 1);
    }
  }

  // --- Main loop ---
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;

    world.t += dt;
    world.dt = dt;
    // Background time: clouds always drift.
    world.bgT += dt;

    updateZen(dt);

    // Draw
    ctx.save();
    drawZen();

    ctx.restore();

    // Clear one-frame input edges
    input.justPressed = false;
    input.justReleased = false;

    requestAnimationFrame(frame);
  }

  // Boot
  resetRun();
  world.state = State.START;
  world.bgT = 0;
  requestAnimationFrame(frame);
})();
