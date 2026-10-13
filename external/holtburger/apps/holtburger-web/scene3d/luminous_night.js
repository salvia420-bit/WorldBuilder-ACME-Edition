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
//
// CLONES (`?lumCloneAdopt`, 2026-10-13, DEFAULT ON; `off/0/false/no` escape).
// A per-entity material (entities.js `_getOrCloneEntityMaterial`: object
// translucency, Transparent / Luminous / Diffuse hooks, TextureVelocity, the
// camera fade) is a `.clone()` of a tracked material. three's Material.copy
// JSON-copies userData, so the clone carries `hbLumBase` — which makes
// `registerLuminousMaterial` refuse it — and it was never tracked: its glow
// froze at the scale live when it was cloned (cloned at noon = full glow all
// night, 4x its untouched peers; cloned at night = dim all day).
// `adoptLuminousClone` tracks it at the live scale; `releaseLuminousMaterial`
// hands a material's emissive to a Luminous hook (its raw write must not be
// overwritten by the next scale change). Weapon / lifestone VFX variants
// (vfx/weapon_fx.js, vfx/lifestone_fx.js) are NOT adopted: they mirror their
// base's `emissiveIntensity` every tick (MATERIAL_SURFACE_FIELDS), so they
// follow through the base.

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

/**
 * `?lumCloneAdopt` — per-entity clones follow the night scale. Default ON;
 * `off` / `0` / `false` / `no` restores the freeze-at-clone-time behaviour.
 */
export function lumCloneAdoptEnabled(search) {
  try {
    const s = search ?? (typeof window !== "undefined" ? window.location?.search : "") ?? "";
    const v = new URLSearchParams(s).get("lumCloneAdopt");
    if (v == null) return true;
    const t = String(v).toLowerCase();
    return !(t === "off" || t === "0" || t === "false" || t === "no");
  } catch (_) {
    return true;
  }
}

// The page's own answer is read once (the query does not change in a session);
// an explicit `search` (tests) is always re-read.
let _adoptMemo = null;
function _adoptOn(search) {
  if (search !== undefined) return lumCloneAdoptEnabled(search);
  if (_adoptMemo === null) _adoptMemo = lumCloneAdoptEnabled();
  return _adoptMemo;
}

const _refs = new Set();
// material -> its `_refs` entry. Membership lives HERE, not in userData,
// because userData is copied into every clone.
const _tracked = new WeakMap();
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
  const ref = _hasWeakRef ? new WeakRef(mat) : { deref: () => mat };
  _refs.add(ref);
  _tracked.set(mat, ref);
  if (_scale !== 1) mat.emissiveIntensity = mat.userData.hbLumBase * _scale;
  return true;
}

/**
 * Track a per-entity `.clone()` of a tracked material (see CLONES above). The
 * clone keeps the `hbLumBase` it copied and takes the LIVE scale at once.
 * Idempotent; a material without a finite `hbLumBase` (non-luminous, a light
 * source, or one a Luminous hook released) is ignored. `search` is for tests.
 */
export function adoptLuminousClone(mat, search) {
  if (!mat || _tracked.has(mat)) return false;
  const base = mat.userData?.hbLumBase;
  if (!Number.isFinite(base)) return false;
  if (!_adoptOn(search)) return false;
  const ref = _hasWeakRef ? new WeakRef(mat) : { deref: () => mat };
  _refs.add(ref);
  _tracked.set(mat, ref);
  mat.emissiveIntensity = base * _scale;
  return true;
}

/**
 * Stop tracking `mat` because a Luminous(8/9) hook now owns its emissive
 * (entities.js `_applyRampValueToMaterial` writes `emissiveIntensity = 1.0`
 * raw, retail SetLuminositySimple) — otherwise the next scale change would
 * overwrite the hook's value with `hbLumBase × scale`. Drops `hbLumBase` too,
 * so the material is never re-adopted. Only per-entity materials reach the
 * hook, never a shared cache material. No-op under `?lumCloneAdopt=off`.
 */
export function releaseLuminousMaterial(mat, search) {
  const ref = mat ? _tracked.get(mat) : undefined;
  if (!ref || !_adoptOn(search)) return false;
  _tracked.delete(mat);
  _refs.delete(ref);
  if (mat.userData) delete mat.userData.hbLumBase;
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
  return { scale: _scale, tracked: live, fullNightScale: lumNightScale(), cloneAdopt: lumCloneAdoptEnabled() };
}

if (typeof window !== "undefined") {
  window.__lumNight = { state: luminousNightState, apply: applyLuminousScale };
}
