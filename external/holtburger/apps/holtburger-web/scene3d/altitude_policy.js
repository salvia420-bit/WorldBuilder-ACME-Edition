// scene3d/altitude_policy.js — the FLIGHT VIEW policy (`?flightView`, flight experience Phases 3-4).
//
// One function of the camera's height above ground (and whether an aircraft is flying) drives everything that
// decides how far the world reaches: the world tier (scene3d/world_terrain.js), the range-fog band, the camera's
// far plane, the layered-haze strength and the clouds' camera height. Today each of those is a constant tuned
// for a player on foot: the fog closes at the far ring's edge (~1.5 km), the far plane is 5 km, the haze reads
// every pixel past 1.4 km as distance — from an aircraft at 80 m that is a white wall 1.5 km away, and from
// 4.5 km up the whole ground is fog.
//
// CONTRACT
//   * On foot (no flight hint, camera < FLY_ENTER_AGL) nothing changes: the weight `w` is 0 and every consumer
//     keeps its own value (Q7: the on-foot look is byte-identical).
//   * Flying (residency.js flight hint), or the PLAYER high above ground (a bail-out fall; the debug free camera
//     counts its own height) → the world tier is requested; once it has
//     DRAWN a few frames (never before: the far ring's edge would show) `w` eases 0 → 1 over ~2.5 s and:
//       - fog band → near 0.35·D, far D, with D = 8 km + 12 × AGL (8.9 km at 80 m, 62 km at 4.5 km) — the
//         world tier draws to the horizon, so the fog is depth, not a wall; takram's aerial perspective (which
//         reads depth and models altitude) carries the physical haze;
//       - camera far → quantized ×1.5 steps ≥ 1.25·D (raised at once, lowered after 3 s), so nothing keyed on far
//         churns per frame (lane C §2.4);
//       - layered haze strength × (1 − smoothstep(300, 1500, AGL)) (it would wash the far field flat);
//       - clouds' camera height → the RADIAL altitude (AC z + d²/2R), consistent with the cloud march geometry,
//         so climbing through a layer takes the right branch (lane C §1.3), blended by `w`.
//   * Landing / exit: `w` eases back to 0, the far plane returns to 5 km, the world tier is released.
//
// Phase 3 (residency radii by altitude) reads `altitudePolicyState()` — see residency.js.

import { getFlightHint } from "./residency.js";
import { setWorldTierWanted, tickWorldTerrain, worldGroundHeight, worldTerrainDiag, prefetchWorldTier } from "./world_terrain.js";
import { setFarForestWanted, tickFarForest, farForestDiag, prefetchFarForest } from "./far_forest.js";
import { tickDericostWorld } from "./dericost_world.js";
import { setObjRadiusPolicy } from "./object_radius.js";
import { flightViewFlag } from "./flight_view_flag.js";

/**
 * The height that decides "high" without a flight hint: the debug free camera's own AGL when it is parked
 * (`?camDebug` probes), else the player's (`subject`, AC metres) — never the chase camera's. null = unknown.
 */
export function highSubjectAgl(cameraAgl, subject, freeCam, groundAt) {
  if (freeCam) return Number.isFinite(cameraAgl) ? cameraAgl : null;
  if (!subject || !Number.isFinite(subject.z) || typeof groundAt !== "function") return null;
  const g = groundAt(subject.x, subject.y);
  return Number.isFinite(g) ? subject.z - g : null;
}

/**
 * Object-window radius by AGL band, with hysteresis (null = the page's own setting). Bands: < 600 m → the page
 * default (4), or 3 while an aircraft is airborne (`flying`, above 40 m); 600-1,500 → 3; 1,500-2,500 → 2; above
 * 2,500 → 1 (exits 150-300 m lower). The far forests carry
 * the trees past the window on the presence complement. 1070 arm G: at 5 km the radius-2 window still baked ~45
 * statics / buildings landblocks per 3 s for objects 5 km below (a few pixels), with frames up to 0.8 s.
 */
export function objRadiusForAgl(agl, prev = null, flying = false) {
  const a = Number.isFinite(agl) ? agl : 0;
  let r;
  if (prev === 1) r = a > 2200 ? 1 : (a > 1300 ? 2 : (a > 450 ? 3 : null));
  else if (prev === 2) r = a > 2500 ? 1 : (a > 1300 ? 2 : (a > 450 ? 3 : null));
  else if (prev === 3) r = a > 2500 ? 1 : (a > 1500 ? 2 : (a > 450 ? 3 : null));
  else r = a > 2500 ? 1 : (a > 1500 ? 2 : (a > 600 ? 3 : null));
  // an aircraft airborne in the low band: radius 3 (49 landblocks of real meshes instead of 81) — the far forests
  // carry the trees past it on the presence crossfade; at 400 km/h every crossing baked 9 new landblocks of statics /
  // buildings (7 now), and the bakes, their program prewarm and the texture uploads were ~12 % of the main thread
  // at low cruise (1070 arm H profile). Back to the page default on the ground (exit below 25 m).
  if (flying && r === null && a > (prev === 3 ? 25 : 40)) r = 3;
  return r;
}

/** Far-forest range at `agl` (m): 4.5 km low, out to 8 km by 2.5 km up (trees there are a few px tall). */
export function farForestRangeM(agl) {
  const a = Math.max(0, Number.isFinite(agl) ? agl : 0);
  return Math.min(8000, 4500 + 1.4 * a);
}

export const FLY_ENTER_AGL = 60;     // AGL (m) of the player (or the free camera) that counts as "high" without a flight hint
export const GRID_FREEZE_AGL = 3000; // the near grid stops following the aircraft above this AGL (m) ...
export const GRID_THAW_AGL = 2500;   // ... and follows again below this one
export const FLY_EXIT_AGL = 35;
const W_RAMP_S = 2.5;
const BASE_FAR = 5000;
const EARTH_R = 6360000;             // takram bottomRadius (vendor/takram/three-atmosphere.js)

/**
 * `?flightPrewarm` — DEFAULT ON, off / 0 / false / no escape; and only on a page that can fly (`?vehicles`, the
 * vehicles module installs `window.__vehicles`). Prefetches the flight tiers at idle (see tickAltitudePolicy).
 */
export function flightPrewarmEnabled(search, hasVehicles) {
  try {
    const s = search !== undefined ? search : (globalThis.location?.search || "");
    const v = (new URLSearchParams(s).get("flightPrewarm") || "").trim().toLowerCase();
    if (v === "off" || v === "0" || v === "false" || v === "no") return false;
  } catch (_) { /* default */ }
  return hasVehicles !== undefined ? !!hasVehicles : !!globalThis.window?.__vehicles;
}
let _prewarmFlag;
function flightPrewarmOn() {
  if (_prewarmFlag === undefined) {
    // decided once the vehicles module has had a chance to install itself (the policy's first in-world tick)
    _prewarmFlag = flightPrewarmEnabled();
  }
  return _prewarmFlag;
}

/** `?flightView` — DEFAULT ON (2026-11-01, validated on the 1070); off / 0 / false / no escapes. */
export function flightViewEnabled(search) {
  return flightViewFlag(search);
}

// ---------------------------------------------------------------------------
// Pure terms (unit-tested: tests/altitude_policy.test.mjs)
// ---------------------------------------------------------------------------
/** Visibility distance (m) the fog band opens to at `agl` metres above ground. */
export function viewDistanceM(agl) {
  const a = Math.max(0, Number.isFinite(agl) ? agl : 0);
  return Math.min(240000, 8000 + 12 * a);
}
/** The fog band while flying (near, far), before blending with today's band by `w`. */
export function flightFogBand(agl) {
  const d = viewDistanceM(agl);
  return { near: 0.35 * d, far: d };
}
/** Camera far target for a visibility distance: ≥ 1.25·D, quantized to 5 km × 1.5^k, ≤ 250 km. */
export function quantizedFar(viewD) {
  const want = Math.max(BASE_FAR, 1.25 * viewD);
  let f = BASE_FAR;
  while (f < want && f < 250000) f *= 1.5;
  return Math.min(250000, Math.round(f));
}
/** Layered-haze multiplier at `agl`: 1 on the ground, 0 above 1.5 km. */
export function hazeScale(agl) {
  const t = Math.min(1, Math.max(0, (agl - 300) / 1200));
  return 1 - t * t * (3 - 2 * t);
}
function _ecefSmoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * ECEF tangent-sphere anchor for extended world coordinates beyond Dereth (Ocean transit corridor & Dericost).
 * For Dereth south/central (z3 >= -36000, i.e. AC Y <= 36000, including Holtburg), returns {anchorY: 0, anchorZ: 0}
 * so Dereth's spherical frame is 100% byte-identical. North of AC Y = 36 km, anchorZ tracks z3 + 36000 so
 * z_ecef stays at -36000 m (preventing the d^2/2R spherical drop-off and horizon normal tilt at 50-118 km),
 * and anchorY lifts smoothly onto Dericost's plateau datum so the 750 m cumulus deck sits 350-550 m AGL across Dericost.
 */
export function ecefAnchorForWorld(x3, z3) {
  if (!(z3 < -36000)) return { anchorY: 0, anchorZ: 0 };
  const acY = -z3;
  const anchorZ = z3 + 36000;
  const tContinent = _ecefSmoothstep(64000, 74000, acY);
  const tNorth = _ecefSmoothstep(75000, 106000, acY);
  const anchorY = tContinent * (140 + 180 * tNorth);
  return { anchorY, anchorZ };
}

/** takram's radial altitude of a three-world point (anchored for extended Ocean + Dericost coordinates). */
export function radialAltitude(x3, y3, z3) {
  const { anchorY, anchorZ } = ecefAnchorForWorld(x3, z3);
  const yEcef = y3 - anchorY;
  const zEcef = z3 - anchorZ;
  return yEcef + (x3 * x3 + zEcef * zEcef) / (2 * EARTH_R);
}

// ---------------------------------------------------------------------------
// State + per-frame tick
// ---------------------------------------------------------------------------
const _tmpV = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }, copy(v) { return this.set(v.x, v.y, v.z); },
  applyMatrix4(m) { const e = m.elements, x = this.x, y = this.y, z = this.z, w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
    return this.set((e[0] * x + e[4] * y + e[8] * z + e[12]) * w, (e[1] * x + e[5] * y + e[9] * z + e[13]) * w, (e[2] * x + e[6] * y + e[10] * z + e[14]) * w); },
  setFromMatrixPosition(m) { const e = m.elements; return this.set(e[12], e[13], e[14]); } };
const _st = {
  on: null, agl: null, ground: null, flying: false, high: false, wanted: false, w: 0,
  far: BASE_FAR, farLowerAt: 0, lastMs: 0, worldFrames: 0, fog: null,
};

/** Is the near grid frozen (high above the ground; index.js keeps its centre)? */
export function altitudeGridFreeze() { return !!_st.gridFreeze; }

export function altitudePolicyState() {
  return { agl: _st.agl, subjectAgl: _st.subjectAgl ?? null, flying: _st.flying, high: _st.high, wanted: _st.wanted, w: _st.w, far: _st.far, fog: _st.fog,
    farRingOff: !!_st.farRingOff, objR: _st.objR ?? null, gridFreeze: !!_st.gridFreeze };
}

/**
 * Per frame, after the camera is placed. `groundAt(x, y)` = a fallback AC ground height (the session's resident
 * terrain) used until the world grids arrive.
 */
export function tickAltitudePolicy(scene3d, camera, { nowMs, groundAt = null, subject = null, freeCam = false } = {}) {
  if (_st.on === null) _st.on = flightViewEnabled();
  if (!_st.on || !scene3d || !camera) return;
  const dt = _st.lastMs ? Math.min(0.25, Math.max(0, (nowMs - _st.lastMs) / 1000)) : 0;
  _st.lastMs = nowMs;
  // camera in AC metres (three world (x, y, z) = AC (x, z, −y))
  const cp = camera.getWorldPosition ? camera.getWorldPosition(_tmpV) : camera.position;
  const ax = cp.x, ay = -cp.z, az = cp.y;
  let g = worldGroundHeight(ax, ay);
  if (g == null && typeof groundAt === "function") {
    try { const v = groundAt(ax, ay); if (Number.isFinite(v)) g = v; } catch (_) { /* fallback */ }
  }
  _st.ground = g;
  _st.agl = g == null ? null : az - g;
  _st.flying = !!getFlightHint(nowMs);
  // "high" (the view engages without an aircraft): the PLAYER high above the ground — a bail-out free fall, a
  // chute — or the debug free camera high up. Never the chase camera of a player standing on the ground: at a
  // cliff edge it can hang 60+ m over the valley, and the on-foot view must not change there (Q7).
  _st.subjectAgl = highSubjectAgl(_st.agl, subject, freeCam, (x, y) => {
    const wg = worldGroundHeight(x, y);
    if (wg != null) return wg;
    if (typeof groundAt === "function") { try { const v = groundAt(x, y); if (Number.isFinite(v)) return v; } catch (_) { /* none */ } }
    return null;
  });
  if (_st.subjectAgl != null) {
    if (!_st.high && _st.subjectAgl > FLY_ENTER_AGL) _st.high = true;
    else if (_st.high && _st.subjectAgl < FLY_EXIT_AGL) _st.high = false;
  } else _st.high = false;
  const onDericostOrOcean = ay > 48500.0;
  _st.wanted = _st.flying || _st.high || onDericostOrOcean;
  // ?flightPrewarm (default ON, only on a page with vehicles): 20 s into the world, prefetch the flight tiers at idle
  // (world grids + program, far-forest index + programs + the impostors trickled one at a time) so a take-off only
  // opens the view (world_terrain.js prefetchWorldTier)
  if (subject && _st.inWorldMs == null) _st.inWorldMs = nowMs;
  if (!_st.wanted && _st.inWorldMs != null && nowMs - _st.inWorldMs > 2000 && flightPrewarmOn()) {
    prefetchWorldTier(scene3d, camera);
    prefetchFarForest(scene3d, { nowMs, frameMs: dt * 1000 });
  }
  setWorldTierWanted(scene3d, _st.wanted);
  tickWorldTerrain(scene3d, camera);
  setFarForestWanted(scene3d, _st.wanted, { rangeM: farForestRangeM(_st.agl) });
  tickFarForest(scene3d, camera);
  tickDericostWorld(scene3d, camera, nowMs);
  // the weight opens only once the world tier is actually on screen
  const wd = worldTerrainDiag();
  _st.worldFrames = wd.active && wd.nodes > 0 ? _st.worldFrames + 1 : 0;
  const wTarget = _st.wanted && _st.worldFrames > 6 ? 1 : 0;
  const step = dt / W_RAMP_S;
  _st.w = wTarget > _st.w ? Math.min(wTarget, _st.w + step) : Math.max(wTarget, _st.w - step);
  const w = _st.w * _st.w * (3 - 2 * _st.w); // smoothstep ease
  const agl = Math.max(0, _st.agl ?? 0);

  // fog: loop.js blends today's band toward this by w (scene3d._flightFogOverride)
  const fb = flightFogBand(agl);
  if (onDericostOrOcean && !_st.flying && agl < 150) {
    const lowT = Math.min(1, Math.max(0, agl / 150));
    _st.fog = { near: 650 + (fb.near - 650) * lowT, far: 4500 + (fb.far - 4500) * lowT, w };
  } else {
    _st.fog = { near: fb.near, far: fb.far, w };
  }
  scene3d._flightFogOverride = w > 0 ? _st.fog : null;

  // far plane: quantized, raised at once, lowered after 3 s
  const farTarget = w > 0.01 ? quantizedFar(viewDistanceM(agl)) : BASE_FAR;
  if (farTarget > _st.far) { _st.far = farTarget; _st.farLowerAt = 0; }
  else if (farTarget < _st.far) {
    if (!_st.farLowerAt) _st.farLowerAt = nowMs + 3000;
    else if (nowMs >= _st.farLowerAt) { _st.far = farTarget; _st.farLowerAt = 0; }
  } else _st.farLowerAt = 0;
  if (camera.far !== _st.far) {
    camera.far = _st.far;
    camera.updateProjectionMatrix();
  }

  // Phase 3 residency terms (hysteretic): the far ring off high up (the world tier owns its area), the object
  // window narrowed with altitude, the subdivided 3x3 frozen while airborne
  const aglNow = _st.agl;
  if (aglNow != null) {
    if (!_st.farRingOff && w > 0.5 && aglNow > 700) _st.farRingOff = true;
    else if (_st.farRingOff && (w < 0.5 || aglNow < 550)) _st.farRingOff = false;
  }
  scene3d._farRingSuppressed = !!_st.farRingOff;
  _st.objR = _st.wanted ? objRadiusForAgl(aglNow, _st.objR ?? null, _st.flying) : null;
  setObjRadiusPolicy(_st.objR, scene3d);
  scene3d._lodRebakeFrozen = _st.wanted;
  // the near grid stops following the aircraft high up (index.js grid tick): the world tier draws the ground below
  // at that height and every grid move re-baked 2x2-landblock tiles nobody can tell apart from it (1070 arm N: ~25
  // bakes and 12 tile moves in one second at 5 km, a 0.5 s frame). On above 3 km AGL, off below 2.5 km — ~100 s of a
  // 25 m/s descent (or ~50 s of a free fall) to re-stream before the ground.
  if (aglNow != null) {
    if (!_st.gridFreeze && _st.wanted && aglNow > GRID_FREEZE_AGL) _st.gridFreeze = true;
    else if (_st.gridFreeze && (!_st.wanted || aglNow < GRID_THAW_AGL)) _st.gridFreeze = false;
  } else if (!_st.wanted) _st.gridFreeze = false;
  // layered haze (layered_haze.js syncUniforms reads the global multiplier)
  globalThis.__hbFlightHazeScale = 1 - w * (1 - hazeScale(agl));
  // clouds: radial camera height, blended (cloud_overlay.js reads it)
  globalThis.__hbCloudRadialW = w;
  // clouds (cloud_storm_look.js lookLayers): a storm's cumulonimbus tower fades out while the aircraft is up — target 1
  // above 900 m AGL, 0 below 700 m, eased over ~10 s (the look re-applies per 1 % step) — so the storm reads as its
  // cumulus deck from the air instead of a murk with vertical walls (1070 A/B, bench/cloud-ab-1070.mjs)
  const ease = (cur, target) => { const step = dt / 10, c = cur ?? 0; return c < target ? Math.min(target, c + step) : Math.max(target, c - step); };
  const hbTarget = w > 0.5 && _st.agl != null ? (_st.agl > 900 ? 1 : (_st.agl < 700 ? 0 : (_st.hb ?? 0) >= 0.5 ? 1 : 0)) : 0;
  _st.hb = ease(_st.hb, hbTarget);
  globalThis.__hbCloudHighBand = _st.hb;
  // above the deck (> 1.8 km AGL, back below 1.4 km): the clouds' every-pixel march (cloud_volume.js ?cloudHighBand)
  const deckTarget = w > 0.5 && _st.agl != null ? (_st.agl > 1800 ? 1 : (_st.agl < 1400 ? 0 : (_st.deck ?? 0) >= 0.5 ? 1 : 0)) : 0;
  _st.deck = ease(_st.deck, deckTarget);
  globalThis.__hbCloudAboveDeck = _st.deck;
}

/** Diag: `window.__flightView()`. */
export function flightViewDiag() {
  return { enabled: !!_st.on, ...altitudePolicyState(), ground: _st.ground, worldFrames: _st.worldFrames, world: worldTerrainDiag(), farForest: farForestDiag() };
}
