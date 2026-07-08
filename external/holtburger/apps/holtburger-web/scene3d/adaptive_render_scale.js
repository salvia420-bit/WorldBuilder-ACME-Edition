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
  const fullPixels = cssW * basePixelRatio * (cssH * basePixelRatio);
  if (!(fullPixels > 0) || !(basePixelRatio > 0)) return maxScale;
  if (fullPixels <= pixelBudget) return maxScale;
  const s = Math.sqrt(pixelBudget / fullPixels);
  return Math.max(minScale, Math.min(maxScale, s));
}

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
    if (dt > this._highMs * 3 && t >= this._cooldownUntil) {
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
      const next = Math.min(this._maxScale, Math.round((s + this._step) * 1000) / 1000);
      if (next > s) this._apply(next, t, p75, "up");
    }
  }

  _apply(scale, t, p75, dir) {
    try {
      this._applyScale(scale);
    } catch (_) {
      return;
    }
    this.changes += 1;
    this._cooldownUntil = t + this._cooldownMs;
    if (this._log) this._log(`[adaptive-res] ${dir} → scale=${scale} (p75 frame ${Math.round(p75)}ms)`);
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
