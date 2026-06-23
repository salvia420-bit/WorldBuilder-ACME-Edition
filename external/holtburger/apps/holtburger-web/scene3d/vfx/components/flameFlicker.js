// light.flameFlicker — torch / brazier flame flicker (Visual-Behavior Suite,
// Phase 1, 2026-06-23). The BLOOM + LIGHT-BUDGET slice's only behavioural piece.
//
// MECH "light": there is NO shader patch and NO new material program. The effect
// jitters the per-frame .intensity that the fixed light POOL (lighting.js,
// ?lightPool=on — the spell-freeze fix) copies into each slot, multiplying it by
// a deterministic flame waveform.
//
// THE RULE (binding, spec §1.2): we touch .intensity ONLY — never .visible,
// never the light array, never the per-type light COUNT. A count change relinks
// every MeshStandardMaterial (the exact freeze the light pool exists to kill —
// see lighting.js "Problem-A fix"), so lightCountDelta = 0 and we never add /
// remove / toggle a light. The pool slot's intensity is RE-DERIVED from its
// source every frame by feedSelectedIntoPool BEFORE this runs, so multiplying it
// is non-destructive: there is no state to restore and the authored source
// intensity is never mutated. When ?lightPool=off (the legacy .visible-cap path)
// there are no pool slots to drive, so flameFlicker is a documented no-op.
//
// Per-light phase is seeded ONCE from the light's static spawn origin (a
// deterministic integer hash — NEVER Math.random) and cached on userData, so
// co-located torches flicker out of sync and a static torch's phase never jumps.
//
// Clock: scene3d.frameTime.tsSec — the canonical per-frame wall clock. This is
// the SAME source the oscillator tick copies into VFX_GLOBALS.uTime (slice 01)
// and that tickTerrainUTime uses, so flame flicker shares one timebase with the
// frag shader effects. Reading it directly (rather than importing materials.js /
// VFX_GLOBALS) keeps this module free of the `three` graph so it is
// standalone-testable under plain node, like the other VFX component tests.

import { registerComponent } from "../registry.js";
import { visualEnabled } from "../../vfx_catalog.js";

// Default flame parameters. amp = peak fractional intensity swing; floor =
// hard lower clamp so a flame never goes dark (and so a high amp never crosses
// 0 → a near-relink-looking pop). baseHz/subHz are two incommensurate flicker
// rates; noiseHz drives the smooth value-noise envelope that makes it read as
// fire rather than a pure sine. Tuned against AC torch/brazier intensities
// (authored 20–100, see lighting.js LG1 census).
export const FLAME_DEFAULTS = Object.freeze({
  amp: 0.16,
  floor: 0.74,
  baseHz: 7.3,
  subHz: 2.13,
  noiseHz: 2.7,
});

// Deterministic 32-bit integer hash → [0,1). No Math.random / no Date.now.
function hash01(n) {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Smooth 1D value noise (smoothstep-interpolated hash) → [0,1]. This is the
// same shape the shared oscillator registry's "smoothNoise" provides (slice 01,
// cost_model row notes "smoothNoise/decay"); kept self-contained here so the
// slice is independently testable, and trivially swappable for the shared
// oscillator once oscillators.js lands (queued consolidation — see notes).
function smoothNoise1(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f); // smoothstep
  const a = hash01(i);
  const b = hash01(i + 1);
  return a + (b - a) * u;
}

/**
 * The flame intensity MULTIPLIER for one light at time t. Bounded to
 * [cfg.floor, 1 + cfg.amp*1.28] and strictly > 0 — never relink-adjacent.
 * Pure + deterministic (same phase01,t → same value).
 * @param {number} phase01  per-light phase in [0,1)
 * @param {number} t        seconds (VFX_GLOBALS.uTime)
 * @param {object} cfg      {amp,floor,baseHz,subHz,noiseHz}
 * @returns {number} intensity multiplier
 */
export function flameFlickerMul(phase01, t, cfg = FLAME_DEFAULTS) {
  const a = phase01 * 6.2831853; // 2π phase offset
  const s1 = Math.sin(t * cfg.baseHz + a);
  const s2 = Math.sin(t * cfg.subHz + a * 1.7 + 1.3);
  const n = smoothNoise1(t * cfg.noiseHz + phase01 * 17.0) * 2 - 1; // [-1,1]
  const w = 0.5 * s1 + 0.28 * s2 + 0.5 * n; // ~[-1.28, 1.28]
  const f = 1 + cfg.amp * w;
  return f < cfg.floor ? cfg.floor : f;
}

/**
 * Is this a flame-class source light (torch / brazier / candle / lantern)?
 * Warm = red-dominant with a blue deficit, in the light's LINEAR color (the
 * makeThreeLightForSetupLight constructor decodes AC's sRGB tint to linear).
 * Point lights only (AC braziers/torches author cone_angle 0 → PointLight;
 * spots are ~absent in shipped data). Excludes white / cool / magic-blue
 * lights so portals, ice spells, etc. never flicker.
 * @param {{isPointLight?:boolean, color?:{r:number,g:number,b:number}}} light
 */
export function isFlameLight(light) {
  if (!light || light.isPointLight !== true) return false;
  const c = light.color;
  if (!c) return false;
  return c.r >= 0.30 && c.r >= c.g * 0.92 && c.r > c.b * 1.25;
}

/**
 * Lazily resolve & cache the per-light flame phase in [0,1), or -1 for a
 * non-flame light. Cached on userData so it is computed ONCE (deterministic,
 * stable — no per-frame jump). Seed = the static spawn origin
 * (userData.setupLightOrigin, set by makeThreeLightForSetupLight); reading a
 * static derived position is legacy-safe (never the wire/pose).
 */
export function flameSourcePhase(light) {
  if (!light) return -1;
  const ud = light.userData || (light.userData = {});
  const cached = ud.__vfxFlamePhase;
  if (cached !== undefined) return cached;
  if (!isFlameLight(light)) {
    ud.__vfxFlamePhase = -1;
    return -1;
  }
  const o = ud.setupLightOrigin;
  // Quantise to a 0.25 m grid then hash with three large primes so even
  // near-identical positions get distinct phases. Computed once, then cached.
  const seed = o
    ? ((Math.round(o.x * 4) * 73856093) ^
       (Math.round(o.y * 4) * 19349663) ^
       (Math.round(o.z * 4) * 83492791))
    : 0;
  const ph = hash01(seed);
  ud.__vfxFlamePhase = ph;
  return ph;
}

// --- URL flags (default OFF behind ?visual). Memoised, mirrors the
// vfx_catalog.js / tree_wind.js flag idiom. -----------------------------------
function _strFlag(name) {
  try {
    if (typeof window !== "undefined" && window.location) {
      return new URLSearchParams(window.location.search).get(name);
    }
  } catch (_) { /* default */ }
  return null;
}
function _numFlag(name, dflt, lo, hi) {
  const v = parseFloat(_strFlag(name));
  if (!Number.isFinite(v)) return dflt;
  return Math.max(lo, Math.min(hi, v));
}
function _truthy(v) {
  if (v == null) return false;
  const s = String(v).toLowerCase();
  return s !== "off" && s !== "0" && s !== "false" && s !== "no" && s !== "";
}

let _enabled;
/** ?flameFlicker — torch/brazier intensity jitter. Requires ?visual too. OFF. */
export function flameFlickerEnabled() {
  if (_enabled !== undefined) return _enabled;
  _enabled = visualEnabled() && _truthy(_strFlag("flameFlicker"));
  return _enabled;
}

let _cfg;
/** Resolved flame params (?flameFlickerAmp overrides amp; rest are defaults). */
export function flameFlickerConfig() {
  if (_cfg !== undefined) return _cfg;
  const amp = _numFlag("flameFlickerAmp", FLAME_DEFAULTS.amp, 0, 0.6);
  _cfg = amp === FLAME_DEFAULTS.amp ? FLAME_DEFAULTS : { ...FLAME_DEFAULTS, amp };
  return _cfg;
}

/** Test-only: clear the memoised flag/config (URL changed between cases). */
export function _resetFlameFlickerFlagsForTest() {
  _enabled = undefined;
  _cfg = undefined;
}

/**
 * Per-frame post-pass. Runs in loop.js AFTER tickLightingForCellState (which
 * has already re-fed the pool slots from their sources). Reads ONLY the
 * exposed pool descriptor (scene3d.lighting.lightPool) — it never imports or
 * edits lighting.js, and never touches a source light. For each occupied point
 * slot whose source is a flame, multiplies the slot's .intensity by the flame
 * waveform. pool.point[i] ←→ pool.selPoint[i] is the stable slot↔source map
 * feedSelectedIntoPool maintains.
 *
 * No-op (byte-identical render) when ?flameFlicker is off OR ?lightPool=off.
 */
export function tickFlameFlicker(scene3d) {
  if (!flameFlickerEnabled()) return;
  const pool = scene3d && scene3d.lighting && scene3d.lighting.lightPool;
  if (!pool || !pool.enabled) return; // legacy .visible-cap path → no slots
  const t = (scene3d.frameTime && scene3d.frameTime.tsSec) || 0;
  const cfg = flameFlickerConfig();
  const slots = pool.point;
  const srcs = pool.selPoint;
  for (let i = 0; i < slots.length; i += 1) {
    const src = i < srcs.length ? srcs[i] : null;
    if (!src) continue;
    const ph = flameSourcePhase(src);
    if (ph >= 0) slots[i].intensity *= flameFlickerMul(ph, t, cfg);
  }
}

export const flameFlicker = {
  id: "light.flameFlicker",
  family: "emissive", // valid family bucket; NOT on the frag chain (mech=light)
  mech: "light",
  channel: "light",
  linkVariant() { return ""; }, // mech=light: no shader link, no program
  cacheKeyScope: "none",
  deterministic: true,
  lightCountDelta: 0, // THE RULE: intensity-only, never a count/visible change
  // Legacy-safety manifest (spec §1.2): reads the client clock + a per-light
  // identity hash; writes ONLY a render-time light intensity (the pooled slot
  // the server neither stores nor replicates). Never the wire, physics, or a
  // replicated field.
  reads: ["clock", "instanceHash"],
  writes: ["lightIntensity"],
  defaults: { ...FLAME_DEFAULTS },
  // mech=light drives intensity from the dedicated `tickFlameFlicker(scene3d)`
  // post-pass (loop.js) — NOT the shared tick(dt,t) uniform contract — so it is
  // intentionally not assigned to `.tick`. No GLSL inject/declareUniforms/buildClip.
};

registerComponent(flameFlicker);
export default flameFlicker;
