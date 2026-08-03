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
//   (2) ADAPTIVE — measures per-frame time (rAF cadence, which is GPU-bound) and
//       lowers renderScale when frames blow past budget, raising it back when the
//       GPU has headroom. Hysteresis + a post-change cooldown avoid oscillation
//       (and skip the one-frame spike from the render-target rebuild).
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
 * cooldown+eval (~3 s) for the entire session. The damper watches the change
 * history; when the last `settleFlips` changes strictly alternate direction
 * inside `settleWindowMs`, it latches: snaps to the LOWEST scale of the
 * flip-flop (the sustainable side), suppresses raises for `settleLockMs`
 * (lowering stays allowed — safety first), and counts the latch in
 * `controller.settleLatches` (reachable via `window.__adaptiveRenderScale`).
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
    settleFlips = 4,
    settleWindowMs = 120_000,
    settleLockMs = 300_000,
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
    this._settleFlips = settleFlips;
    this._settleWindowMs = settleWindowMs;
    this._settleLockMs = settleLockMs;
    this._settleUntil = 0;
    this._dirHistory = []; // [{dir, to, t}] — last few applied changes
    this.settleLatches = 0; // reachability counter for the damper
  }

  /** Call once per frame. Records the inter-frame delta and evaluates on cadence. */
  recordFrame() {
    const t = this._now();
    const prev = this._last;
    this._last = t;
    if (this._lastEval == null) this._lastEval = t;
    if (prev == null) return;
    const dt = t - prev;
    // Ignore absurd deltas (tab backgrounded / an unrelated GC pause).
    if (!(dt >= 0 && dt < 60_000)) return;
    this._samples.push(dt);
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
    const catastrophic = dt > this._highMs * 3;
    const prevCatastrophic = this._prevCatastrophic === true;
    this._prevCatastrophic = catastrophic;
    if (catastrophic && prevCatastrophic && t >= this._cooldownUntil) {
      const s = this._getScale();
      if (s > this._minScale) {
        const over = dt / this._highMs;
        const st = over > 4 ? this._step * 2 : this._step;
        const next = Math.max(this._minScale, Math.round((s - st) * 1000) / 1000);
        if (next < s) {
          this._apply(next, t, dt, "down");
          this._samples = [];
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
    if (t < this._cooldownUntil) return; // let the last change settle
    if (samples.length < this._minSamples) return;
    const p75 = percentile(samples, 0.75);
    let s = this._getScale();
    if (p75 > this._highMs && s > this._minScale) {
      // Bigger step when we are WAY over budget (e.g. the 4 s / 4K case).
      const over = p75 / this._highMs;
      const st = over > 4 ? this._step * 2 : this._step;
      const next = Math.max(this._minScale, Math.round((s - st) * 1000) / 1000);
      if (next < s) this._apply(next, t, p75, "down");
    } else if (p75 < this._lowMs && s < this._maxScale) {
      // Settle latch: while latched, headroom does NOT raise (raising is
      // exactly what re-enters the dropped-frames side of the flip-flop).
      // Lowering stays allowed above — safety first.
      if (this._settle && t < this._settleUntil) return;
      const next = Math.min(this._maxScale, Math.round((s + this._step) * 1000) / 1000);
      if (next > s) this._apply(next, t, p75, "up");
    }
  }

  _apply(scale, t, p75, dir) {
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
    if (this._log) this._log(`[adaptive-res] ${dir} → scale=${scale} (p75 frame ${Math.round(p75)}ms)`);
    if (this._settle) this._noteChangeForSettle(scale, t, dir);
  }

  /** Track applied changes; latch when the tail is a strict up/down flip-flop
   *  inside the window. On latch: snap to the LOWEST scale of the flip-flop
   *  (the sustainable side) and suppress raises for settleLockMs. */
  _noteChangeForSettle(scale, t, dir) {
    const h = this._dirHistory;
    h.push({ dir, to: scale, t });
    while (h.length && (h.length > 8 || t - h[0].t > this._settleWindowMs)) h.shift();
    const n = this._settleFlips;
    if (h.length < n) return;
    if (t < this._settleUntil) return; // already latched
    const tail = h.slice(-n);
    for (let i = 1; i < tail.length; i++) {
      if (tail[i].dir === tail[i - 1].dir) return; // not alternating
    }
    const floor = Math.min(...tail.map((e) => e.to));
    this._settleUntil = t + this._settleLockMs;
    this.settleLatches += 1;
    const cur = this._getScale();
    if (floor < cur) {
      try { this._applyScale(floor); } catch (_) { /* keep latch anyway */ }
      this.changes += 1;
    }
    if (this._log) {
      this._log(
        `[adaptive-res] oscillation latch #${this.settleLatches} — holding scale=${Math.min(floor, cur)} ` +
        `(no raises for ${Math.round(this._settleLockMs / 1000)}s; ?adaptiveResSettle=off disables)`
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
}
