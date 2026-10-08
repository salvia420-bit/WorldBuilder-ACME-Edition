// scene3d/luminous_night.js — `?lumNight` (2026-10-07, DEFAULT ON; `=off`
// escape, `=<0..1>` sets the full-night scale).
//
// THE GLOW. Retail lights a Surface with luminosity L in the fixed-function
// combiner as `texture * saturate(L + ambient + diffuse)` (D3DPolyRender::
// SetSurface, see materials.js). materials.js reproduces that with an
// emissive of L over the texture — in the SAME radiance units as our
// physically-lit world, which at night is many times darker than retail's
// DayGroup ambient. So the 0.5-luminosity tree canopies (surfaces 0x08000AB1 /
// 0x08000E23, ~320 instances around Holtburg) and the 0.1-0.235 brush stayed
// at their noon brightness all night: measured on the 1070 at 23:00 game time
// they read 10-25x brighter than the ground they stand on (retail's own ratio
// is ~3x), i.e. lime-green neon trees under a dark sky.
//
// THE FIX. Ambient-like luminosity (L < LIGHT_SOURCE_LUM) dims with the same
// night fraction the sky, moons and ground dim use (night_ramp.js); true light
// sources (L >= 1: braziers, lanterns, crystals) keep their full glow. Only
// `emissiveIntensity` VALUES change — no define, no program, no per-material
// cache key — and only when the scale moves, so the per-frame cost is one
// compare. Batched-mesh variants mirror `emissiveIntensity` from their member
// material every frame (batched_material_variant.js HOT keys), so they follow.

import { nightFactorFromAuthoredPitch, nightRampEnabled } from "./night_ramp.js";

/** Luminosity at or above this is a light source and is never dimmed. */
export const LIGHT_SOURCE_LUM = 0.99;
/** Default full-night scale for ambient-like luminosity. */
export const LUM_NIGHT_SCALE_DEFAULT = 0.25;

/** The full-night scale in [0, 1]; 1 = feature off. */
export function lumNightScale(search) {
  try {
    const s = search ?? (typeof window !== "undefined" ? window.location?.search : "") ?? "";
    const v = new URLSearchParams(s).get("lumNight");
    if (v == null || v === "") return LUM_NIGHT_SCALE_DEFAULT;
    const lv = String(v).toLowerCase();
    // `off` restores the noon-bright emissive all night; a number (incl. 0)
    // is the full-night scale itself.
    if (lv === "off" || lv === "false" || lv === "no") return 1;
    const n = Number(lv);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : LUM_NIGHT_SCALE_DEFAULT;
  } catch (_) {
    return LUM_NIGHT_SCALE_DEFAULT;
  }
}

/** Emissive multiplier at night fraction `t` for a full-night scale `k`. */
export function lumScaleAt(t, k) {
  const n = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  return 1 + n * (k - 1);
}

const _refs = new Set();
let _scale = 1;
const _hasWeakRef = typeof WeakRef === "function";

/**
 * Track a luminous material. Call once, after its base `emissiveIntensity` is
 * set from the Surface luminosity. Light sources are ignored. The material
 * immediately takes the current scale (a canopy streamed in at midnight must
 * not flash at noon brightness until the next change).
 */
export function registerLuminousMaterial(mat, luminosity) {
  if (!mat || !(luminosity > 0) || luminosity >= LIGHT_SOURCE_LUM) return false;
  if (!Number.isFinite(mat.emissiveIntensity)) return false;
  mat.userData = mat.userData || {};
  if (mat.userData.hbLumBase !== undefined) return false;
  mat.userData.hbLumBase = mat.emissiveIntensity;
  _refs.add(_hasWeakRef ? new WeakRef(mat) : { deref: () => mat });
  if (_scale !== 1) mat.emissiveIntensity = mat.userData.hbLumBase * _scale;
  return true;
}

/** Apply scale `s` to every live tracked material; drops collected ones. */
export function applyLuminousScale(s) {
  _scale = s;
  for (const r of _refs) {
    const m = r.deref();
    if (!m) { _refs.delete(r); continue; }
    const base = m.userData?.hbLumBase;
    if (Number.isFinite(base)) m.emissiveIntensity = base * s;
  }
}

/**
 * Per sky tick: SkyState snapshot -> scale; re-applies only on a change of at
 * least 0.5 %, so steady day and steady night cost a compare.
 */
export function tickLuminousNight(state, search) {
  const k = lumNightScale(search);
  let s = 1;
  if (k < 1 && nightRampEnabled(search) && state && Number.isFinite(state.dirPitch)) {
    s = lumScaleAt(nightFactorFromAuthoredPitch(state.dirPitch), k);
  }
  if (Math.abs(s - _scale) < 0.005 && !(s === 1 && _scale !== 1)) return _scale;
  applyLuminousScale(s);
  return s;
}

/** Diagnostics / tests. */
export function luminousNightState() {
  let live = 0;
  for (const r of _refs) if (r.deref()) live += 1;
  return { scale: _scale, tracked: live, fullNightScale: lumNightScale() };
}

if (typeof window !== "undefined") {
  window.__lumNight = { state: luminousNightState, apply: applyLuminousScale };
}
