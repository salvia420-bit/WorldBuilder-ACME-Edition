// VFX material-oscillator registry — Visual-Behavior Suite, Phase 1 (2026-06-23).
//
// THE SINGLE per-frame VFX tick. Build spec §7 ("Material-oscillator layer —
// persistent oscillator registry … pulse/glint sweep") + design doc §9.7. One
// O(1) pass drives every shared VFX uniform from ONE clock so every emissive /
// weathering effect is phase-locked across the whole scene (the same "single
// time source" rule terrain.js's uTime push obeys — see loop.js tickTerrainUTime
// + INTERACTING_LAYERS_ANALYSIS.md "three time sources" hazard).
//
//   VFX_GLOBALS.uTime IS THE MASTER CLOCK.  It is the only thing the suite reads
//   for "time"; every oscillator is a deterministic function of that one clock.
//   This module is uTime's SOLE writer (it was dormant at 0 in Phase 0 —
//   test_vfx_material_substrate.mjs locks "uTime starts at 0, driven by the
//   Phase-1 oscillator tick").
//
// LEAF MODULE — INTENTIONALLY DEPENDENCY-FREE (no THREE, no materials.js import).
// The master-clock uniform + any driven uniform are injected BY REFERENCE
// (setMasterClock / target:{value}), so this file stays node-testable in bare
// node (materials.js drags in `three`, which the test runner can't resolve) and
// has no import cycle with the render stack. The THREE-side wiring (binding
// VFX_GLOBALS.uTime, resolving the frame clock) lives in loop.js.
//
// THE RULE (§1.2) — this infra reads ONLY the client clock (a scalar injected by
// the caller) and writes ONLY cloned-material `materialUniform` {value} objects
// the server neither stores nor replicates. It is deterministic (no Math.random,
// no argless Date.now — t is a pure parameter), touches no per-instance state, no
// customProgramCacheKey, no light count, no wire/physics. O(1)/frame: cost is one
// clock write + one write per registered channel (a handful), never per-instance.
// It is INFRA, not a VisualComponent, so it is not in the component registry; the
// audit-facing pseudo-manifest is exported below (OSCILLATOR_INFRA_MANIFEST).

// ── Waveform primitives ─────────────────────────────────────────────────────
// Each is a PURE function (t, config) -> number. `t` is the master clock in
// seconds; output is centered on `bias` with half-amplitude `amp` (so a caller
// picks bias/amp to land in whatever [lo,hi] a uniform needs). Stateless: a
// given (t, config) always yields the same value (deterministic, frame-rate
// independent, resume-safe).

const TWO_PI = Math.PI * 2;

/** bias + amp·sin(2π·freq·t + phase). The canonical pulse/shimmer driver. */
function sine(t, c) {
  const freq = c.freq ?? 1, amp = c.amp ?? 1, phase = c.phase ?? 0, bias = c.bias ?? 0;
  return bias + amp * Math.sin(TWO_PI * freq * t + phase);
}

/** Symmetric triangle in [bias-amp, bias+amp], period 1/freq. Linear ramps —
 *  a cheaper, harder-edged alternative to sine for sweeps. */
function triangle(t, c) {
  const freq = c.freq ?? 1, amp = c.amp ?? 1, phase = c.phase ?? 0, bias = c.bias ?? 0;
  const cycles = t * freq + phase / TWO_PI;
  const frac = cycles - Math.floor(cycles);       // [0,1)
  const tri = 1 - 4 * Math.abs(frac - 0.5);        // -1 at edges, +1 at frac=0.5
  return bias + amp * tri;
}

// Deterministic integer hash -> [0,1). xorshift-mul finalizer (no Math.random,
// no float-precision sin-hash) so smoothNoise is portable + resume-stable.
function _noiseHash(n) {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

/** Value-noise: smoothstep-interpolated hashed lattice. Output centered on bias,
 *  half-amplitude amp (range [bias-amp, bias+amp]). Use for organic flicker
 *  (flame, candle) where a clean sine reads "mechanical". `seed` (int) decorrelates
 *  independent channels; deterministic — same (t,seed) → same value, forever. */
function smoothNoise(t, c) {
  const freq = c.freq ?? 1, amp = c.amp ?? 1, bias = c.bias ?? 0;
  const seed = (c.seed ?? 0) | 0;
  const x = t * freq;
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);                    // smoothstep ease
  const a = _noiseHash(i + seed * 1013904223);
  const b = _noiseHash(i + 1 + seed * 1013904223);
  const n = a + (b - a) * u;                         // [0,1)
  return bias + amp * (n * 2 - 1);                   // -> [bias-amp, bias+amp]
}

/** One-shot exponential decay from a trigger `t0`: bias before t0; at/after,
 *  bias + amp·e^-((t-t0)/tau), optionally damped-oscillating when `wobbleFreq`>0
 *  (the soft-item "decayWobble" jiggle primitive, design doc §row-12). Pure in t —
 *  the caller advances/sets t0 (e.g. on a client-local trigger); no internal state. */
function decay(t, c) {
  const t0 = c.t0 ?? 0, amp = c.amp ?? 1, bias = c.bias ?? 0;
  const tau = (c.tau ?? 1) > 0 ? c.tau ?? 1 : 1e-6;
  if (t < t0) return bias;
  const env = Math.exp(-(t - t0) / tau);
  const osc = c.wobbleFreq ? Math.cos(TWO_PI * c.wobbleFreq * (t - t0) + (c.phase ?? 0)) : 1;
  return bias + amp * env * osc;
}

/** The waveform table. Exported so components/tests share the EXACT math the tick
 *  runs (no second copy to drift). Keys are the legal `kind` values. */
export const WAVES = Object.freeze({ sine, triangle, smoothNoise, decay });

/** Pure sampler — evaluate a waveform without registering it (tests / one-shots). */
export function sampleWave(kind, t, config = {}) {
  const fn = WAVES[kind];
  if (!fn) throw new Error(`[vfx-osc] unknown waveform "${kind}" (have: ${Object.keys(WAVES).join(",")})`);
  return fn(t, config);
}

// ── Registry ────────────────────────────────────────────────────────────────
// Named oscillators, each writing one shared {value} uniform once/frame.

const _oscillators = new Map();   // name -> { name, kind, config, target, value }
let _masterClock = null;          // the VFX_GLOBALS.uTime {value} object (by reference)

/**
 * Bind the master clock uniform (VFX_GLOBALS.uTime). Idempotent — called once
 * from loop.js at module load. Kept out of this leaf's imports so the file stays
 * THREE-free; the SAME {value} object getCachedVariant binds into every patched
 * material is passed here, so `tickOscillators` writing `_masterClock.value`
 * propagates to all VFX shaders by reference.
 * @param {{value:number}} clockUniform
 */
export function setMasterClock(clockUniform) {
  if (clockUniform && typeof clockUniform === "object" && "value" in clockUniform) {
    _masterClock = clockUniform;
  }
}

/**
 * Register a named oscillator. On each tick its `target.value` is set to
 * WAVES[kind](t, config). Re-registering the same name replaces it (idempotent
 * wiring). Returns the entry.
 * @param {string} name
 * @param {{kind:string, config?:object, target?:{value:number}}} spec
 *        kind: "sine"|"triangle"|"smoothNoise"|"decay";
 *        target: a shared {value} uniform (e.g. VFX_GLOBALS.uWetness) — omit to
 *        only stash the sampled value on the entry (.value), for derived readers.
 */
export function registerOscillator(name, spec) {
  if (typeof name !== "string" || !name) throw new Error("[vfx-osc] oscillator needs a name");
  const kind = spec?.kind;
  if (!WAVES[kind]) {
    throw new Error(`[vfx-osc] "${name}": bad kind "${kind}" (have: ${Object.keys(WAVES).join(",")})`);
  }
  const target = spec.target ?? null;
  if (target && !(typeof target === "object" && "value" in target)) {
    throw new Error(`[vfx-osc] "${name}": target must be a {value} uniform object`);
  }
  const entry = { name, kind, config: { ...(spec.config || {}) }, target, value: 0 };
  _oscillators.set(name, entry);
  return entry;
}

/** Live-tune a registered oscillator's config (e.g. weather raising gust amp).
 *  Shallow-merges; no-op if the name is unknown. */
export function updateOscillator(name, partialConfig) {
  const e = _oscillators.get(name);
  if (e && partialConfig) Object.assign(e.config, partialConfig);
  return e;
}

export function getOscillator(name) { return _oscillators.get(name); }
export function listOscillators() { return [..._oscillators.keys()]; }
export function unregisterOscillator(name) { return _oscillators.delete(name); }
/** Test-only: drop every oscillator + unbind the clock. */
export function _clearOscillators() { _oscillators.clear(); _masterClock = null; }

/**
 * THE per-frame VFX tick. O(1): one master-clock write + one write per
 * registered channel (a handful). NO per-instance work, NO allocation in the hot
 * path. Idempotent for a fixed `t` (deterministic). Call exactly once/frame,
 * BEFORE anything reads the VFX uniforms.
 *
 *   1. master clock  : VFX_GLOBALS.uTime.value = t   (the single source of "time")
 *   2. each channel  : target.value = WAVES[kind](t, config)
 *
 * @param {number} tSec  the shared frame wall-clock in seconds (loop.js resolves
 *                       it from scene3d.frameTime.tsSec — the SAME snapshot the
 *                       terrain uTime push reads, so no multi-clock drift).
 * @param {number} [dt]  frame delta in seconds. Unused by the stateless Phase-1
 *                       waveforms; threaded for future integrator-style channels.
 */
export function tickOscillators(tSec, dt) {
  // 0) Bound the clock to avoid float32 precision drift over long sessions
  //    (handoff R-D / kit R6): uTime feeds GLSL float32 uniforms, and a raw
  //    seconds value loses sub-frame precision inside sin()/fract() after a few
  //    hours of uptime. 3600s is a safe period — every Phase-1 waveform is
  //    periodic at ≤1 Hz, so the wrap is phase-continuous. The master clock AND
  //    every channel read the SAME wrapped value, so they stay phase-locked.
  const t = tSec % 3600;
  // 1) master clock first — oscillators below are functions of THIS value, and
  //    every VFX shader reads it by reference this same frame.
  if (_masterClock) _masterClock.value = t;
  // 2) drive each channel. Fail-soft per entry so one bad config can't kill the
  //    frame (and can't corrupt a sibling channel's uniform).
  for (const e of _oscillators.values()) {
    let v;
    try {
      v = WAVES[e.kind](t, e.config);
    } catch (_) {
      continue;
    }
    e.value = v;
    if (e.target) e.target.value = v;
  }
}

// ── Audit-facing pseudo-manifest (this is INFRA, not a VisualComponent) ──────
// Not enforced by registry.js (which only governs components), but it states the
// capabilities so slice-16's legacy-safety audit can assert THE RULE holds for
// the shared tick too: reads only the client clock, writes only cloned-material
// uniforms, deterministic, no light-count change, no per-instance program key.
export const OSCILLATOR_INFRA_MANIFEST = Object.freeze({
  id: "infra.oscillators",
  reads: Object.freeze(["clock"]),
  writes: Object.freeze(["materialUniform"]),
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "none",
});
