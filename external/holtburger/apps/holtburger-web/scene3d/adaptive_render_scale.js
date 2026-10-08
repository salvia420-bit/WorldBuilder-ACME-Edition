// adaptive_render_scale.js — adaptive resolution + smart initial default.
//
// Problem (2026-07-08, live cloudflare-tunnel session on an AMD R9 290 @ Windows
// 200% display scale): `devicePixelRatio` = 2, so the client renders every frame
// into a 3840×2160 (4K) framebuffer — 4× the pixels — through the atmosphere /
// lighting / composer fragment shaders. On a 2013 mid-range GPU that is seconds
// per frame (a camera turn took ~4 s), even though CPU/memory/scene are all
// healthy. The base `min(devicePixelRatio, 2)` cap doesn't help when DPR is
// exactly 2. `?renderScale=0.5` fixes it manually, but users shouldn't have to
// know that flag exists.
//
// This module (default-on `?adaptiveRes`, opt out `=off`) does two things:
//   (1) SMART DEFAULT — caps the INITIAL rendered-pixel count to a budget, so a
//       HiDPI / OS-scaled display starts near 1080p instead of 4K.
//   (2) ADAPTIVE — measures per-frame time (rAF cadence) and lowers renderScale
//       when frames blow past budget, raising it back when the GPU has headroom.
//       Hysteresis + a post-change cooldown avoid oscillation (and skip the
//       one-frame spike from the render-target rebuild). rAF cadence is NOT
//       GPU-bound by itself: a main-thread-bound frame looks the same. So when
//       a GPU fence probe is wired in (`?adaptiveResGpuCheck`, below), it lowers
//       only when the GPU is actually behind.
//
// An explicit `?renderScale=N` is treated as a fixed user override — adaptation
// is disabled and the smart default is skipped. Also skipped under
// `?nullRender` / `?renderOnDemand` (no real render → no meaningful frame time).

/** `?adaptiveResSettle` — default ON; `=off`/`0`/`false` disables.
 *
 * Oscillation damper (2026-07-28, "screen resolution keeps changing" report,
 * R9 290 @ 4K/200%): the stable band [targetLowMs, targetHighMs] assumes some
 * scale lands INSIDE it, but frame time as a function of scale can jump right
 * across the band (vsync-locked ~16 ms below a threshold scale, >55 ms above
 * it). The controller then raises → drops frames → lowers → has headroom →
 * raises … forever, a visible sharp/blurry resolution churn every
 * cooldown+eval (~3 s) for the entire session.
 *
 * 2026-10-05 — the damper was rewritten as a FAILED-RAISE CEILING. The first
 * version latched only when the last 4 changes strictly alternated
 * (up/down/up/down). The live churn is a SAWTOOTH instead — frame time lags
 * the scale change (RT rebuild, shader warm-up), so the controller overshoots
 * both ways: up×4, down×3, up×4, … (reproduced headless at DPR 2: 0.35→0.83→
 * 0.35 every ~2 s for minutes, `settleLatches` stuck at 0, the canvas
 * visibly resizing "every second, endlessly"). Strict alternation never
 * appears, so it never latched.
 * Now: any DOWN that follows an UP (within `settleWindowMs`) proves that raise
 * was not sustainable, so raises are capped BELOW the failed peak (at the
 * scale the raise started from) for `settleLockMs`. A later failure at or
 * under the cap lowers it again, so a sawtooth converges in a few cycles and
 * a flip-flop stops at its first reversal. Lowering is never blocked (safety
 * first). `controller.settleLatches` counts cap engagements and
 * `controller.raiseCeiling` exposes the live cap (both via
 * `window.__adaptiveRenderScale`).
 */
export function adaptiveResSettleEnabled() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("adaptiveResSettle");
    if (v == null) return true;
    const lv = String(v).toLowerCase();
    return !(lv === "off" || lv === "0" || lv === "false");
  } catch (_) {
    return true;
  }
}

/** `?adaptiveResGpuCheck` — default ON; `=off`/`0`/`false` disables.
 *
 * 2026-10-07 (owner at the 1070, quality=ultra, full screen): within minutes of
 * play the controller cut the scale 1 → 0.4 and latched it there 7 times. Yet
 * live frame time was the SAME at scale 0.47, 0.88 and 2.0 (3840×2160): about
 * 33 ms p75 each time. The frames were main-thread bound (~600 draws a frame of
 * three.js submission, plus streaming) and the GPU was mostly idle. rAF cadence
 * cannot tell those cases apart, so every CPU stall read as "GPU too slow" and
 * bought a blurrier picture for nothing.
 *
 * The check: a GL fence is inserted at the end of each frame's submission and
 * read at the end of the NEXT frame's. If it has not signalled after a whole
 * frame, the GPU is the bottleneck. Measured live on the 1070: the GPU was
 * behind on 5% of frames at scale 1 (CPU-bound) and 99% at scale 2
 * (GPU-bound). The controller now lowers resolution only when the GPU is
 * behind. When the GPU keeps up, it raises back toward full resolution even if
 * frames are over the band, because there resolution costs nothing. With no
 * fence support (WebGL1, lost context) samples are null and the old rAF-only
 * behaviour applies.
 */
export function adaptiveResGpuCheckEnabled() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("adaptiveResGpuCheck");
    if (v == null) return true;
    const lv = String(v).toLowerCase();
    return !(lv === "off" || lv === "0" || lv === "false");
  } catch (_) {
    return true;
  }
}

/** `?adaptiveResBootGrace` — default ON; `=off`/`0`/`false` disables.
 *
 * 2026-10-07 (owner session on the 1070, quality=ultra, 1920x1080): the
 * controller dropped to 0.52 while the world was still streaming in, the
 * raises it then tried failed against the same load hitches, and the settle
 * latch held the frame at HALF resolution for five minutes — on a GPU that
 * renders that scene at 53 fps at full resolution (measured right after
 * `__setRenderScale(1)`). Boot frames say nothing about steady-state fill
 * cost: they are bakes, decodes and first-use shader links. So until the
 * world has reported `ready` and settled for BOOT_GRACE_MS the controller
 * never lowers and never latches (raises still apply). The HiDPI case this
 * module exists for is already handled at boot by computeInitialRenderScale.
 */
export const BOOT_GRACE_MS = 30_000;
export function adaptiveResBootGraceEnabled() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("adaptiveResBootGrace");
    if (v == null) return true;
    const lv = String(v).toLowerCase();
    return !(lv === "off" || lv === "0" || lv === "false");
  } catch (_) {
    return true;
  }
}

/** True while the client has not yet reported scene `ready`, or did so less
 *  than `graceMs` ago (wall clock, the `__bootStateHistory` timestamps). */
export function bootGraceActive(history, nowMs = Date.now(), graceMs = BOOT_GRACE_MS) {
  if (!Array.isArray(history)) return false;
  const ready = history.find((e) => e && e.state === "ready");
  if (!ready) return true;
  return !(Number.isFinite(ready.ts) && nowMs - ready.ts >= graceMs);
}

/**
 * GPU-behind probe for the controller. The render loop calls `frameEnd()` once
 * per frame AFTER its GL submission. It reads the fence inserted at the end of
 * the previous frame, then inserts a new one. `sample()` returns the newest
 * unread verdict: true = the GPU had not finished the previous frame's work a
 * whole frame later, false = it had, null = nothing new / unknown.
 *
 * The fence must be inserted after a frame's submission and read one full frame
 * later. Reading it at the start of the next frame (no slack) reports "behind"
 * on a CPU-saturated loop too, because the GPU is still on the tail of the work
 * that was just flushed. WebGL2 only updates sync status between tasks, so a
 * next-frame read is also the earliest meaningful one. No explicit flush:
 * Chrome flushes the frame's commands, fence included, when it presents the
 * canvas.
 *
 * @param {WebGL2RenderingContext} gl
 * @returns {{frameEnd(): void, sample(): (boolean|null), dispose(): void} | null}
 */
export function createFenceGpuProbe(gl) {
  if (!gl || typeof gl.fenceSync !== "function" || typeof gl.getSyncParameter !== "function") {
    return null;
  }
  let fence = null;
  let unread = null;
  return {
    frameEnd() {
      try {
        if (fence) {
          // A lost context answers null here, which must not read as "behind".
          const st = gl.getSyncParameter(fence, gl.SYNC_STATUS);
          unread = st === gl.SIGNALED ? false : st === gl.UNSIGNALED ? true : null;
          gl.deleteSync(fence);
          fence = null;
        }
        fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); // null on a lost context
      } catch (_) {
        fence = null;
        unread = null;
      }
    },
    sample() {
      const v = unread;
      unread = null;
      return v;
    },
    dispose() {
      try { if (fence) gl.deleteSync(fence); } catch (_) { /* context gone */ }
      fence = null;
      unread = null;
    },
  };
}

/** `?adaptiveRes` — default ON; `=off`/`0`/`false` disables. */
export function adaptiveResEnabled() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("adaptiveRes");
    if (v == null) return true;
    const lv = String(v).toLowerCase();
    return !(lv === "off" || lv === "0" || lv === "false");
  } catch (_) {
    return true;
  }
}

/**
 * Smart initial render scale: cap the rendered-pixel count to `pixelBudget` so a
 * scaled/HiDPI display doesn't start at full 4K. Pure — no globals. Pixels scale
 * with scale², so scale = sqrt(budget / fullPixels). Returns a value in
 * [minScale, maxScale]; returns maxScale when already under budget.
 * @param {{basePixelRatio:number, cssW:number, cssH:number, maxScale?:number, minScale?:number, pixelBudget?:number}} o
 */
export function computeInitialRenderScale({
  basePixelRatio,
  cssW,
  cssH,
  maxScale = 1,
  minScale = 0.35,
  // ~2.6 Mpx ≈ 1080p with a little headroom (1920×1080 = 2.07 Mpx).
  pixelBudget = 2_600_000,
}) {
  // __diag is built during init3D, i.e. after this module loaded — re-stamp so
  // `__diag.renderScale` exists regardless of module/init ordering.
  installRenderScaleDiag();
  const fullPixels = cssW * basePixelRatio * (cssH * basePixelRatio);
  if (!(fullPixels > 0) || !(basePixelRatio > 0)) return maxScale;
  if (fullPixels <= pixelBudget) return maxScale;
  const s = Math.sqrt(pixelBudget / fullPixels);
  return Math.max(minScale, Math.min(maxScale, s));
}


// ---------------------------------------------------------------------------
// RENDER-SCALE VISIBILITY (2026-08-02)
// ---------------------------------------------------------------------------
// Pass-1 finding: off-screen on the 1070 the adaptive controller silently
// dropped renderScale to 0.52 within seconds and everything upscaled from
// there — so "the client looks blurry" was, in that session, a MEASUREMENT of
// a half-resolution frame, and nothing in the client said so. There was no way
// to see the live value short of reading `renderer.getPixelRatio()` by hand.
//
// `window.__renderScaleState()` is now always available (no flag), reports the
// live number next to the device's own ratio, and names WHY it is what it is.
// Also mirrored onto `window.__diag.renderScale` when __diag exists.

/** Live render-scale readback. Never throws; returns `{error}` on any failure. */
export function renderScaleState() {
  try {
    const s = typeof window !== "undefined" ? window.liveScene3d : null;
    const r = s?.renderer ?? null;
    const dpr = typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 1;
    const live = r && typeof r.getPixelRatio === "function" ? r.getPixelRatio() : null;
    // getDrawingBufferSize writes into a THREE.Vector2 (it calls target.set),
    // so a plain {x,y} literal throws. Read the canvas instead — same numbers,
    // no THREE import needed in this module.
    const canvas = r ? r.domElement : null;
    const size = canvas ? { x: canvas.width, y: canvas.height } : null;
    let urlPin = null;
    try {
      const v = new URLSearchParams(window.location.search).get("renderScale");
      if (v != null && v !== "" && Number.isFinite(+v)) urlPin = +v;
    } catch (_) { /* no window */ }
    return {
      // The number that actually decides how many pixels get rendered.
      renderScale: live,
      devicePixelRatio: dpr,
      // live/dpr < 1 means the frame is being UPSCALED to the canvas — the
      // single most common cause of "it looks soft" that is not a shader.
      upscalingFrom: live != null && dpr > 0 ? +(live / dpr).toFixed(3) : null,
      drawingBuffer: size ? [size.x, size.y] : null,
      adaptiveEnabled: adaptiveResEnabled(),
      settleEnabled: adaptiveResSettleEnabled(),
      urlPin,
      source: urlPin != null ? "url" : (adaptiveResEnabled() ? "adaptive" : "initial"),
    };
  } catch (e) {
    return { error: String(e) };
  }
}

/** Install the readback on `window` (+ `__diag` when it already exists). */
export function installRenderScaleDiag() {
  if (typeof window === "undefined") return;
  window.__renderScaleState = renderScaleState;
  try {
    if (window.__diag) window.__diag.renderScale = renderScaleState;
  } catch (_) { /* diagnostics never block boot */ }
}

if (typeof window !== "undefined") installRenderScaleDiag();

function percentile(arr, p) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const idx = Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)));
  return a[idx];
}

/**
 * Adaptive render-scale controller. Testable: call `recordFrame()` once per
 * frame (production wires it to its own rAF loop via `start()`), with `now`,
 * `getScale`, and `applyScale` injectable. The stable band is
 * [targetLowMs, targetHighMs]; below it (GPU has headroom / hitting vsync) it
 * raises, above it (frames dropping) it lowers — faster when far over budget.
 */
export class AdaptiveRenderScaleController {
  constructor({
    getScale,
    applyScale,
    minScale = 0.35,
    maxScale = 1,
    // Stable band. On a vsync-locked display a healthy frame ≈ refresh interval
    // (~16–34 ms); >55 ms means the GPU is dropping frames; <35 ms means it is
    // keeping up at vsync and (probably) has headroom to raise.
    targetLowMs = 35,
    targetHighMs = 55,
    step = 0.12,
    evalIntervalMs = 1000,
    cooldownMs = 2000,
    minSamples = 6,
    // Oscillation damper (see adaptiveResSettleEnabled above). `settle`
    // defaults ON here so headless/unit constructions get it; production
    // wiring passes the URL-flag reader explicitly.
    settle = true,
    settleWindowMs = 120_000,
    settleLockMs = 300_000,
    // GPU-behind probe (see adaptiveResGpuCheckEnabled / createFenceGpuProbe).
    // null = rAF cadence only (the pre-2026-10-07 behaviour).
    gpuProbe = null,
    // Boot grace (see adaptiveResBootGraceEnabled): `() => true` while the
    // world is still loading — no lowering and no settle latch then.
    isBooting = null,
    now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
    log = null,
  } = {}) {
    this._getScale = getScale;
    this._applyScale = applyScale;
    this._minScale = minScale;
    this._maxScale = maxScale;
    this._lowMs = targetLowMs;
    this._highMs = targetHighMs;
    this._step = step;
    this._evalMs = evalIntervalMs;
    this._cooldownMs = cooldownMs;
    this._minSamples = minSamples;
    this._now = now;
    this._log = log;
    this._samples = [];
    this._last = null;
    this._lastEval = null;
    this._cooldownUntil = 0;
    this._raf = null;
    this.changes = 0; // for tests/telemetry
    // Reachability counters (2026-08-03): applyScale threw / applyScale
    // returned normally but the scale did not move. Both should stay 0; a
    // climbing `applyNoOps` next to a flat `changes` is the "controller is
    // running but nothing happens" signature.
    this.applyFailures = 0;
    this.applyNoOps = 0;
    this._prevCatastrophic = false;
    this._settle = !!settle;
    this._settleWindowMs = settleWindowMs;
    this._settleLockMs = settleLockMs;
    this._settleUntil = 0;
    this._lastChange = null; // {dir, from, to, t} — the last applied change
    this.raiseCeiling = maxScale; // raises never exceed this while latched
    this.settleLatches = 0; // reachability counter for the damper
    this._gpuProbe = gpuProbe;
    this._isBooting = typeof isBooting === "function" ? isBooting : null;
    this.bootHolds = 0; // lowers suppressed by the boot grace
    this._gpuKnown = 0; // frames in this eval window with a GPU verdict
    this._gpuBehind = 0; // ...of which the GPU was still behind
    this._prevGpuBehind = null;
    // Over-budget windows in which the GPU kept up, so the scale was held
    // instead of lowered. The "[adaptive-res] holding" log fires once per run.
    this.cpuBoundHolds = 0;
    this._holdLogged = false;
  }

  /** The newest GPU-behind verdict from the probe: true / false / null. */
  _sampleGpu() {
    if (!this._gpuProbe) return null;
    try {
      const v = this._gpuProbe.sample();
      return v === true || v === false ? v : null;
    } catch (_) {
      return null;
    }
  }

  /** Window verdict, then reset: true = the GPU is the bottleneck, false = it
   *  kept up (frames are main-thread bound), null = unknown or mixed (fall
   *  back to rAF cadence alone). */
  _takeGpuVerdict() {
    const known = this._gpuKnown;
    const behind = this._gpuBehind;
    this._gpuKnown = 0;
    this._gpuBehind = 0;
    if (known < Math.max(3, this._minSamples >> 1)) return { verdict: null, keptUpPct: null };
    const frac = behind / known;
    const keptUpPct = Math.round((1 - frac) * 100);
    if (frac >= 0.5) return { verdict: true, keptUpPct };
    if (frac <= 0.25) return { verdict: false, keptUpPct };
    return { verdict: null, keptUpPct };
  }

  _noteHold(p75, s, verdictText) {
    this.cpuBoundHolds += 1;
    if (this._holdLogged || !this._log) return;
    this._holdLogged = true;
    this._log(
      `[adaptive-res] holding scale=${s} — p75 frame ${Math.round(p75)}ms but ${verdictText}: ` +
      `no sign the GPU is the bottleneck, so a lower resolution would not help ` +
      `(?adaptiveResGpuCheck=off disables)`
    );
  }

  /** True while the boot grace holds every lower (never throws). */
  _booting() {
    if (!this._isBooting) return false;
    try { return this._isBooting() === true; } catch (_) { return false; }
  }

  /** The highest scale a raise may reach right now. */
  _raiseCap(t) {
    if (!this._settle) return this._maxScale;
    if (t >= this._settleUntil) this.raiseCeiling = this._maxScale; // lock expired
    return this.raiseCeiling;
  }

  /** Call once per frame. Records the inter-frame delta and evaluates on cadence. */
  recordFrame() {
    const t = this._now();
    // Drain the probe every frame, even ones skipped below, so a verdict is
    // never counted against the wrong frame.
    const behind = this._sampleGpu();
    const prevBehind = this._prevGpuBehind;
    this._prevGpuBehind = behind;
    const prev = this._last;
    this._last = t;
    if (this._lastEval == null) this._lastEval = t;
    if (prev == null) return;
    const dt = t - prev;
    // Ignore absurd deltas (tab backgrounded / an unrelated GC pause).
    if (!(dt >= 0 && dt < 60_000)) return;
    this._samples.push(dt);
    if (behind != null) {
      this._gpuKnown += 1;
      if (behind) this._gpuBehind += 1;
    }
    // FAST PATH: a single catastrophically-slow frame (≫ budget, e.g. the 4 s /
    // 4K turn) drops the scale IMMEDIATELY rather than waiting a full eval window
    // — otherwise, at ~4 fps there aren't enough samples per window to evaluate.
    // A single catastrophic frame is NOT evidence of a GPU that cannot keep
    // up (2026-08-03 review). The module header calls rAF cadence "GPU-bound",
    // but it cannot distinguish fill cost from a MAIN-THREAD stall — a terrain
    // bake, a shard decode, a GC pause and a 4 K camera turn all look like one
    // long frame. Dropping resolution does nothing for the first three; it
    // just degrades the image, and repeated often enough it trips the 5-minute
    // settle latch. Requiring two CONSECUTIVE over-budget frames keeps the
    // sustained case (a genuinely fill-bound GPU produces a run of them, which
    // is the ~4 fps case this path exists for) while ignoring isolated hitches.
    // With a GPU probe, lower only when the GPU was BEHIND on both frames.
    // 2026-10-07 (later): "kept up" alone was too weak a gate. A load-time
    // stall (shader compiles, landblock bakes) gives unknown verdicts, and
    // those still dropped the scale (live: 0.47 -> 0.35 latched during a
    // teleport/login). No evidence of a GPU bottleneck now means hold.
    const catastrophic = dt > this._highMs * 3;
    const prevCatastrophic = this._prevCatastrophic === true;
    this._prevCatastrophic = catastrophic;
    const gpuBehindBoth = behind === true && prevBehind === true;
    if (catastrophic && prevCatastrophic && t >= this._cooldownUntil) {
      const s = this._getScale();
      if (s > this._minScale && this._booting()) {
        this.bootHolds += 1;
      } else if (s > this._minScale && this._gpuProbe && !gpuBehindBoth) {
        this._noteHold(dt, s, behind === false && prevBehind === false
          ? "the GPU kept up on both frames"
          : "there is no evidence the GPU was behind");
      } else if (s > this._minScale) {
        const over = dt / this._highMs;
        const st = over > 4 ? this._step * 2 : this._step;
        const next = Math.max(this._minScale, Math.round((s - st) * 1000) / 1000);
        if (next < s) {
          this._apply(next, t, dt, "down");
          this._samples = [];
          this._gpuKnown = 0;
          this._gpuBehind = 0;
          this._lastEval = t;
          return;
        }
      }
    }
    // WINDOWED PATH: steady-state moderate over/under budget (needs enough
    // samples to be robust — only reached when frames are fast enough to fill a
    // window, i.e. not the catastrophic case the fast path already handles).
    if (t - this._lastEval >= this._evalMs && this._samples.length >= this._minSamples) {
      this._evaluate(t);
    }
  }

  _evaluate(t) {
    const samples = this._samples;
    this._samples = [];
    this._lastEval = t;
    // Taken before the cooldown return so every window's GPU counts reset.
    const gpu = this._takeGpuVerdict();
    if (t < this._cooldownUntil) return; // let the last change settle
    if (samples.length < this._minSamples) return;
    const p75 = percentile(samples, 0.75);
    let s = this._getScale();
    const overBudget = p75 > this._highMs;
    // GPU kept up (verdict false): frames are main-thread bound, so lowering
    // resolution cannot help them and raising it costs nothing.
    const gpuKeptUp = gpu.verdict === false;
    // 2026-10-07 (later): with a probe, lowering needs a GPU-BOUND verdict
    // (>= 50% of frames behind). Mixed (25-50%) and unknown windows used to
    // fall back to the rAF-only rule and drop the scale. Live, two "GPU behind
    // on 29-30%" windows during streaming ratcheted the owner to 0.35. With no
    // probe at all (WebGL1), the rAF-only rule still applies.
    const booting = this._booting();
    const mayLower = (!this._gpuProbe || gpu.verdict === true) && !booting;
    if (overBudget && booting && s > this._minScale) this.bootHolds += 1;
    if (!overBudget || gpu.verdict === true) this._holdLogged = false;
    if (overBudget && s > this._minScale && mayLower) {
      // Bigger step when we are WAY over budget (e.g. the 4 s / 4K case).
      const over = p75 / this._highMs;
      const st = over > 4 ? this._step * 2 : this._step;
      const next = Math.max(this._minScale, Math.round((s - st) * 1000) / 1000);
      // Say what let the drop through, so a drop in a log explains itself.
      const why = this._gpuProbe ? `GPU behind on ${100 - gpu.keptUpPct}% of frames` : "";
      if (next < s) this._apply(next, t, p75, "down", why);
      return;
    }
    if (s < this._maxScale && (p75 < this._lowMs || gpuKeptUp)) {
      // Settle cap: headroom only raises up to the ceiling left by the last
      // failed raise (raising past it is exactly what re-enters the
      // dropped-frames side of the churn). Lowering stays allowed above.
      const cap = this._raiseCap(t);
      const next = Math.min(cap, Math.round((s + this._step) * 1000) / 1000);
      if (next > s + 1e-9) {
        const why = p75 < this._lowMs ? "" : `GPU kept up on ${gpu.keptUpPct}% of frames`;
        this._apply(next, t, p75, "up", why);
        return;
      }
    }
    if (overBudget && !mayLower && !booting && s > this._minScale) {
      this._noteHold(p75, s, gpu.keptUpPct == null
        ? "there was no GPU verdict this window"
        : `the GPU kept up on ${gpu.keptUpPct}% of frames`);
    }
  }

  _apply(scale, t, p75, dir, why = "") {
    let before = scale;
    try { before = this._getScale(); } catch (_) { /* keep the target */ }
    try {
      this._applyScale(scale);
    } catch (_) {
      this.applyFailures = (this.applyFailures | 0) + 1;
      return;
    }
    // Did the scale ACTUALLY move? The production `applyScale` wraps
    // `window.__setRenderScale` in its own swallowing try/catch
    // (scene3d/index.js), so a failure there returns normally and this method
    // would count a change, arm the cooldown and log "down -> 0.88" forever
    // while the rendered resolution never moved — telemetry reporting a
    // controller that is working when it structurally cannot (2026-08-03
    // review). Verify against the getter rather than trusting the setter.
    let applied = scale;
    try { applied = this._getScale(); } catch (_) { /* keep the optimistic value */ }
    if (Number.isFinite(applied) && Math.abs(applied - scale) > 1e-6) {
      this.applyNoOps = (this.applyNoOps | 0) + 1;
      return;
    }
    this.changes += 1;
    this._cooldownUntil = t + this._cooldownMs;
    if (this._log) {
      this._log(
        `[adaptive-res] ${dir} → scale=${scale} (p75 frame ${Math.round(p75)}ms)` +
        (why ? ` — ${why}` : "")
      );
    }
    if (this._settle) this._noteChangeForSettle(scale, t, dir);
    this._lastChange = { dir, from: before, to: scale, t };
  }

  /** A DOWN right after an UP means that raise was not sustainable: cap
   *  raises at the scale the raise started from (strictly below the failed
   *  peak) for settleLockMs. Repeated failures only ever lower the cap. */
  _noteChangeForSettle(scale, t, dir) {
    const prev = this._lastChange;
    if (dir !== "down" || !prev || prev.dir !== "up") return;
    if (t - prev.t > this._settleWindowMs) return;
    const ceiling = Math.max(this._minScale, prev.from);
    const latched = t < this._settleUntil;
    if (latched && ceiling >= this.raiseCeiling) return;
    this.raiseCeiling = latched ? Math.min(this.raiseCeiling, ceiling) : ceiling;
    this._settleUntil = t + this._settleLockMs;
    this.settleLatches += 1;
    if (this._log) {
      this._log(
        `[adaptive-res] oscillation latch #${this.settleLatches} — raise to ${prev.to} failed; ` +
        `holding scale <= ${this.raiseCeiling} for ${Math.round(this._settleLockMs / 1000)}s ` +
        `(?adaptiveResSettle=off disables)`
      );
    }
  }

  /** Production: drive `recordFrame` from its own rAF loop. */
  start() {
    if (typeof requestAnimationFrame !== "function") return;
    const loop = () => {
      this.recordFrame();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this._raf != null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this._raf);
    }
    this._raf = null;
  }

  /** Telemetry for `window.__adaptiveRenderScale.gpuState()`. */
  gpuState() {
    return {
      probe: !!this._gpuProbe,
      windowFrames: this._gpuKnown,
      windowBehind: this._gpuBehind,
      cpuBoundHolds: this.cpuBoundHolds,
    };
  }
}
