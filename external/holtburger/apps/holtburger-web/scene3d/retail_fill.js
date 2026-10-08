// scene3d/retail_fill.js — `?retailFill` (2026-10-07, DEFAULT gain 4.5;
// `=off` escape, `=<number>` sets the gain).
//
// Owner on the 1070, Holtburg street at noon: "the building on the left is
// frankly too dark". Measured: the shaded wall of a stone cottage displayed at
// sRGB (7,6,6) while the sunlit stall roof beside it was (68,61,54) — a
// shade/sun ratio of ~3.5 %. Retail lit statics as
//   texture * saturate(ambient + sun * N.L)          (D3D fixed function)
// with Dereth's daytime DayGroup ambient around 0.3-0.6, so a wall facing away
// from the sun kept ~40 % of its sunlit brightness, and the TERRAIN here still
// uses exactly that retail Gouraud term — which is why the buildings read far
// darker than the ground they stand on. The physically-derived fills that light
// statics instead (the takram sky probe, muted while IBL owns indirect diffuse,
// and an IBL environment whose horizontal irradiance is half dark planet
// ground) give a vertical wall almost nothing, and the Neutral curve's toe then
// crushes what is left.
//
// THE FIX: drive the scene's hemisphere fill (sky b0c8ff / ground 504030, a
// constant 0.15 until now) from the same retail diurnal ambient the terrain
// uses: intensity = clamp(gain * max(0.2, ambBright), 0.15, 2.0), faded at
// night like the indirect light (night_ramp.js), cut in enclosed cells
// (dungeons keep their authored lighting; SeenOutside building interiors are
// lit like the street outside, the 2026-07-05 lighting.js rule). One uniform
// value per sky tick: no light added or removed (the light list is frozen —
// lighting.js contract), no program change.
// Live A/B on the 1070: gain 4.5 at ambBright 0.28 (~1.25) took the wall from
// (7,6,6) to ~(16,20,25) — stone courses, door and roof planks readable, still
// clearly the shaded side.

import { nightFactorFromAuthoredPitch, nightRampEnabled } from "./night_ramp.js";

export const RETAIL_FILL_GAIN_DEFAULT = 4.5;
/** The pre-2026-10-07 constant (lighting.js HEMI_INTENSITY) — floor + off value. */
export const RETAIL_FILL_BASE = 0.15;
export const RETAIL_FILL_MAX = 2.0;
/** Fraction of the daytime fill left at full night. */
export const RETAIL_FILL_NIGHT_SCALE = 0.12;
const LSCAPE_LIGHT_MINIMUM = 0.2;

/** Gain >= 0; 0 = feature off (the constant 0.15 hemisphere). */
export function retailFillGain(search) {
  try {
    const s = search ?? (typeof window !== "undefined" ? window.location?.search : "") ?? "";
    const v = new URLSearchParams(s).get("retailFill");
    if (v == null || v === "") return RETAIL_FILL_GAIN_DEFAULT;
    const lv = String(v).toLowerCase();
    if (lv === "off" || lv === "false" || lv === "no") return 0;
    if (lv === "on" || lv === "true" || lv === "yes") return RETAIL_FILL_GAIN_DEFAULT;
    const n = Number(lv);
    return Number.isFinite(n) ? Math.min(20, Math.max(0, n)) : RETAIL_FILL_GAIN_DEFAULT;
  } catch (_) {
    return RETAIL_FILL_GAIN_DEFAULT;
  }
}

/** The hemisphere intensity for a SkyState snapshot. Pure. */
export function retailFillIntensity(state, gain = retailFillGain(), indoor = false, search) {
  if (!(gain > 0) || indoor || !state) return RETAIL_FILL_BASE;
  const ab = Number.isFinite(+state.ambBright) ? Math.max(LSCAPE_LIGHT_MINIMUM, +state.ambBright) : LSCAPE_LIGHT_MINIMUM;
  let night = 0;
  if (nightRampEnabled(search) && Number.isFinite(state.dirPitch)) night = nightFactorFromAuthoredPitch(state.dirPitch);
  const v = gain * ab * (1 + night * (RETAIL_FILL_NIGHT_SCALE - 1));
  return Math.min(RETAIL_FILL_MAX, Math.max(RETAIL_FILL_BASE, v));
}

let _hemi = null;
let _last = NaN;
let _gain = null; // parsed once (the URL is fixed for the page); setGain overrides

/** Per sky tick: find the scene's hemisphere light once, then write its intensity. */
export function tickRetailFill(scene3d, state) {
  if (!scene3d || !state) return null;
  if (!_hemi || !_hemi.parent) {
    _hemi = null;
    _last = NaN;
    try { scene3d.scene?.traverse?.((o) => { if (!_hemi && o.isHemisphereLight) _hemi = o; }); } catch (_) { /* none */ }
    if (!_hemi) return null;
  }
  if (_gain === null) _gain = retailFillGain();
  // Enclosed cells only — the same flag that mutes the sun (lighting.js sets it
  // false for SeenOutside building interiors, so stepping through a cottage
  // door is no lighting cut; dungeons keep their authored darkness).
  const indoor = scene3d.atmosphereLights?._indoorMute === true;
  const v = retailFillIntensity(state, _gain, indoor);
  if (v !== _last) { _hemi.intensity = v; _last = v; }
  return v;
}

export function retailFillState() {
  return { gain: _gain ?? retailFillGain(), intensity: _hemi ? _hemi.intensity : null };
}

/** Live A/B: a new gain (clamped like the URL value); the next sky tick applies it. */
export function setRetailFillGain(g) {
  const n = Number(g);
  _gain = Number.isFinite(n) ? Math.min(20, Math.max(0, n)) : RETAIL_FILL_GAIN_DEFAULT;
  _last = NaN;
  return _gain;
}

if (typeof window !== "undefined") {
  window.__retailFill = { state: retailFillState, setGain: setRetailFillGain };
}
