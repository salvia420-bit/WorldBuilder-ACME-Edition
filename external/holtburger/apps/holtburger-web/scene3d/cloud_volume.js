// scene3d/cloud_volume.js — Clouds-C state bridge.
//
// Wraps the takram-three-clouds `CloudsEffect` and exposes a tick API
// that maps an AC `SkyState` snapshot onto the 5 DayGroup uniforms
// that brunetonStubs.glsl reads:
//
//   uSunColor      ← state.dirColorArgb (ARGB u32 → 0..1 RGB vec3)
//   uAmbientColor  ← state.ambColorArgb
//   uHorizonColor  ← state.fogColorArgb
//   uFogDensity    ← derived from state.fogMin / state.fogMax
//   uSunIntensity  ← state.dirBright (DEGREES per Sky-C lesson →
//                    scalar multiplier; default 1.0)
//
// And the existing `sunDirection` uniform (a unit vec3 in the
// post-`worldRoot.rotation.x = -π/2` three.js space) is updated from
// state.dirHeading + state.dirPitch via the shared
// `./sun_direction.js::sunDirFromHeadingPitch` utility.
// (2026-10-07: the pitch is the SKY's night-ramped art elevation, not the raw
// retail one — `?cloudNight`, see cloud_night.js and tick() below.)
//
// **Not wired into loop.js yet.** That's Clouds-D — when the cloud
// volume actually attaches to skyCell and renders. This module is
// validated against mocked SkyStates in `cloud_bridge_test.html`.
//
// Cross-refs:
//  - `vendor/takram-three-clouds/src/shaders/brunetonStubs.glsl` —
//    the 5-uniform contract this module produces
//  - `vendor/takram-three-clouds/src/CloudsMaterial.ts:194-219` —
//    where the uniforms live on the material
//  - `scene3d/sky_lighting.js::_applyState` — the existing
//    parallel sink for the same SkyState (sun light + ambient + fog)
//  - `docs/skybox-volumetric-clouds-handoff-2026-05-15.md` —
//    Clouds-C in the overall volumetric-clouds plan

import * as THREE from 'three';
import { sunDirFromHeadingPitch } from './sun_direction.js';
import { CloudsEffect, CloudLayers } from '@takram/three-clouds';
import { AtmosphereParameters } from '@takram/three-atmosphere';
// W3 (2026-05-29): the weather-state UPDATE (updateFromDayGroup /
// weatherForState) lives in loop.js::tickWeatherState (clouds-independent).
// This module only READS the storm flag (real DayGroup SkyObject signal).
import { readWeatherFlags } from './weather_state.js';
import { applyCloudLook, cloudLayersMatchLook } from './cloud_storm_look.js';
// 2026-10-07 — ?cloudNight (DEFAULT ON): light the clouds with the sky's
// night-ramped elevation instead of the raw never-setting retail pitch, and
// fade cloud shadows + light shafts with the direct sun. Rationale: cloud_night.js.
import {
  cloudNightLighting,
  cloudNightEnabled,
  cloudNightColor,
  cloudNightLevel,
  cloudNightAmbientRadiance,
  CLOUD_SHADOW_STRENGTH_DEFAULT,
  DISPLAY_EXPOSURE_DEFAULT,
} from './cloud_night.js';
import { rustFlag } from './rust/scene_core.js';
// Lane F2 (2026-10-26) — `?hotTerrainShared` (DEFAULT OFF): the terrain cloud
// shadow uniforms as one shared `{value}` each (scene3d/terrain_shared_uniforms.js).
import {
  sharedPushCloudOff,
  sharedPushCloudOn,
  sharedObserveCloud,
  sharedUnbindCloudStrength,
  sharedReleaseCloud,
} from './terrain_shared_uniforms.js';

// 2026-10-26 (lane F2) — `?hotTerrainShared` (DEFAULT OFF): `_pushCloudShadowsToTerrain`
// writes uCloudShadowEnabled / Map / Matrix0 / Strength ONCE, into shared `{value}`
// objects the registry's terrain materials point at (bound lazily at a push,
// unbound to a frozen copy when they leave the registry). Every material holds
// the value the per-material loops would leave, at every moment; a registry
// entry the shipped loop would throw on sends the whole push back to it.
// docs/2026-10-26-rust-hotspots-2.md §G1.
let _hotTerrainShared;
function hotTerrainSharedOn() {
  if (_hotTerrainShared === undefined) _hotTerrainShared = rustFlag('hotTerrainShared', false);
  return _hotTerrainShared;
}
/** Test seam: force `?hotTerrainShared` for this module (`undefined` re-reads the URL). */
export function __setHotTerrainSharedForTest(on) {
  _hotTerrainShared = on === undefined ? undefined : !!on;
}

// 2026-10-26 (lane F hot spots) — `?hotCloudPush` (DEFAULT ON since 2026-10-26;
// `=off` escape): the two per-material loops of
// `_pushCloudShadowsToTerrain` with every uniform looked up ONCE per material
// (the shipped loops re-read `u.uCloudShadowEnabled` three times and walk the
// ~150-entry uniforms objects again for each write) and the cloud shadow
// matrix's 16 source elements read once per frame instead of once per material
// (Matrix4.copy re-reads them). Same uniforms, same values, same write
// conditions, same order; a destination that is not a plain Matrix4 still
// gets `.copy()`. 1070 2026-10-23 run: 0.066 ms/frame self for the push.
let _hotCloudPush;
function hotCloudPushEnabled() {
  if (_hotCloudPush === undefined) _hotCloudPush = rustFlag('hotCloudPush', true);
  return _hotCloudPush;
}
/** Test seam: force `?hotCloudPush` (`undefined` re-reads the URL flag). */
export function __setHotCloudPushForTest(on) {
  _hotCloudPush = on === undefined ? undefined : !!on;
}
const _M4_COPY = THREE.Matrix4.prototype.copy;
function _cloudShadowsOffFast(terrainMats) {
  for (let i = 0; i < terrainMats.length; i++) {
    const ue = terrainMats[i]?.uniforms?.uCloudShadowEnabled;
    if (ue && ue.value !== 0.0) ue.value = 0.0;
  }
}
function _cloudShadowsPushFast(terrainMats, shadowTex, src, strength) {
  const fin = Number.isFinite(strength);
  const e = src.elements;
  // No elements: let the shipped loop meet that (and throw where it throws).
  if (e == null) return false;
  const e0 = e[0], e1 = e[1], e2 = e[2], e3 = e[3], e4 = e[4], e5 = e[5], e6 = e[6], e7 = e[7];
  const e8 = e[8], e9 = e[9], e10 = e[10], e11 = e[11], e12 = e[12], e13 = e[13], e14 = e[14], e15 = e[15];
  for (let i = 0; i < terrainMats.length; i++) {
    const u = terrainMats[i]?.uniforms;
    const ue = u?.uCloudShadowEnabled;
    if (!ue) continue;
    if (ue.value !== 1.0) ue.value = 1.0;
    const um = u.uCloudShadowMap;
    if (um.value !== shadowTex) um.value = shadowTex;
    const mv = u.uCloudShadowMatrix0.value;
    if (mv.copy === _M4_COPY) {
      const te = mv.elements;
      te[0] = e0; te[1] = e1; te[2] = e2; te[3] = e3; te[4] = e4; te[5] = e5; te[6] = e6; te[7] = e7;
      te[8] = e8; te[9] = e9; te[10] = e10; te[11] = e11; te[12] = e12; te[13] = e13; te[14] = e14; te[15] = e15;
    } else {
      mv.copy(src);
    }
    if (fin) {
      const us = u.uCloudShadowStrength;
      if (us && us.value !== strength) us.value = strength;
    }
  }
  return true;
}

// Storm-reactive cloud look (default ON; `?cloudWeather=off` freezes the
// fair-weather baseline and ignores storms). 2026-08-01: the WMO
// weather→layer machinery this flag used to gate is deleted — see
// cloud_storm_look.js. Cached; read once.
let _cloudWeatherAutoCache;
function readCloudWeatherAutoFlag() {
  if (_cloudWeatherAutoCache !== undefined) return _cloudWeatherAutoCache;
  try {
    if (typeof window === 'undefined' || !window.location?.search) {
      _cloudWeatherAutoCache = true;
    } else {
      const v = new URLSearchParams(window.location.search).get('cloudWeather');
      _cloudWeatherAutoCache = !(typeof v === 'string' && v.toLowerCase() === 'off');
    }
  } catch (_) {
    _cloudWeatherAutoCache = true;
  }
  return _cloudWeatherAutoCache;
}

// ---------------------------------------------------------------------------
// 2026-10-20 (improvement hunt gpu-shading-4, OWNER-APPROVED look trade) —
// `?cloudShadowEvery=N`, DEFAULT 2: march the takram cloud-shadow cascades
// (ShadowPass: 3 × 512² at `high`, + its temporal resolve) every Nth cloud
// frame instead of every frame.
//
// Why it is cheap in look: the shadow resolve runs at temporalAlpha 0.05 (the
// constructor below, anti-cycling 2026-08-01), so each fresh march only moves
// ~5% of a ~20-run exponential history. Marching every 2nd frame keeps the
// same steady state; the time constant goes ~20 → ~40 frames (≈0.3 s more lag
// on a drifting shadow edge). Estimated 0.3-0.6 ms GPU at N=2, high/ultra
// outdoors (verifier's figure; NOT measured — 1070 arm queued).
//
// How (no vendor edit): instance-method wrappers on `effect.shadowMaps.update`
// (the cascade fit, called from CloudsEffect.updateSharedUniforms) and
// `effect.shadowPass.update` (march + resolve + copyReprojection + swap). On a
// skipped frame BOTH are held, so the cascade matrices (→ cloudsPass.copyShadow
// → clouds march, AerialPerspective shafts, the terrain push below) and
// `shadowPass.outputBuffer` (no swap → same texture) stay a consistent pair in
// world space. The shadow march gets its OWN frame counter (+1 per executed
// march) instead of effect.frame, so the shader's `frame % 64` STBN slice still
// advances one slice per march — handing it effect.frame at N=2 would only ever
// sample the even slices (the 64-frame cycling fight, constructor comment).
//
// Forced runs (and the cadence restarts from them): the first frame after
// install; any change of cascade count / map size / the shadow render target
// (quality preset, ?cloudShadowRes, temporalPass toggle — a resized target has
// lost its contents and a new cascade starts as identity); a camera jump of
// more than CLOUD_SHADOW_JUMP_M since the last march (teleport / camera cut —
// running moves < 1 m per frame).
//
// Precedent to respect: 6638fd9b frame-skipped the whole cloud composer and was
// reverted (928841d5, owner: "30 Hz … looks awful") — that held the VISIBLE
// clouds. This holds only the EMA-filtered shadow map; the clouds still march
// every frame. Eye test (1070): cloud shadows sweeping over Holtburg fields,
// shafts during a fast 360° spin, a storm DayGroup.
//
// `=1` (or `off`/`0`/`false`) installs NOTHING — the vendor prototype methods
// run with effect.frame, i.e. exactly the pre-2026-10-20 path. Live A/B:
// `window.__setCloudShadowEvery(n)` (n ≤ 1 uninstalls). Diag:
// `window.__cloudStateDiag().shadowCadence`.
// ---------------------------------------------------------------------------
export const CLOUD_SHADOW_EVERY_DEFAULT = 2;
export const CLOUD_SHADOW_EVERY_MAX = 8;
export const CLOUD_SHADOW_JUMP_M = 25;

/**
 * `?cloudShadowEvery=N` → the march cadence (integer 1..CLOUD_SHADOW_EVERY_MAX).
 * Absent / empty / junk / negative → the default (2); `off|false|no|0|1` → 1
 * (every frame, nothing installed); fractions floor; > MAX clamps.
 */
export function parseCloudShadowEvery(search) {
  let raw = null;
  try {
    raw = new URLSearchParams(search ?? '').get('cloudShadowEvery');
  } catch (_) {
    raw = null;
  }
  if (raw == null) return CLOUD_SHADOW_EVERY_DEFAULT;
  const s = String(raw).trim().toLowerCase();
  if (s === '') return CLOUD_SHADOW_EVERY_DEFAULT;
  if (s === 'off' || s === 'false' || s === 'no') return 1;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return CLOUD_SHADOW_EVERY_DEFAULT;
  if (n <= 1) return 1;
  return Math.min(CLOUD_SHADOW_EVERY_MAX, Math.floor(n));
}

/**
 * Install the cloud-shadow cadence on a takram CloudsEffect (see the block
 * above). Returns a controller: `every`, `installed`, `setEvery(n)` (n ≤ 1
 * uninstalls → vendor path), `uninstall()`, `diag()`. Zero allocation per
 * frame. If the effect has no shadowMaps/shadowPass update methods (vendor
 * change), nothing is installed and `every` reads 1.
 * @param {object} effect — a takram CloudsEffect (or a duck-typed stub)
 * @param {number} every
 */
export function installCloudShadowCadence(effect, every) {
  const sm = effect && effect.shadowMaps;
  const sp = effect && effect.shadowPass;
  const ok = !!(sm && sp && typeof sm.update === 'function' && typeof sp.update === 'function');
  const c = {
    every: 1,
    installed: false,
    frames: 0,       // shadowPass.update calls seen while installed
    runs: 0,         // executed marches
    skips: 0,        // held frames
    forced: 0,       // runs forced off-cadence
    lastForced: null, // 'install' | 'resize' | 'jump'
    marchFrame: 0,   // own frame counter handed to ShadowPass.update (STBN slice)
    sinceRun: 0,
    // per-frame decision (shadowMaps.update decides, shadowPass.update obeys)
    run: true,
    why: null,
    decided: false,
    forceNext: null,
    // signature at the last executed march
    cascadeCount: -1, mapW: -1, mapH: -1,
    target: null, targetW: -1, targetH: -1, targetD: -1,
    camX: 0, camY: 0, camZ: 0,
  };
  let smOrig = null, smOrigOwn = false, smWrap = null;
  let spOrig = null, spOrigOwn = false, spWrap = null;

  const decide = (camera) => {
    let why = c.forceNext;
    const rt = sp.currentRenderTarget || null;
    const ms = sm.mapSize;
    const mapW = ms ? ms.x : -1;
    const mapH = ms ? ms.y : -1;
    if (why === null && (
      sm.cascadeCount !== c.cascadeCount || mapW !== c.mapW || mapH !== c.mapH || rt !== c.target ||
      (rt !== null && (rt.width !== c.targetW || rt.height !== c.targetH || rt.depth !== c.targetD))
    )) {
      why = 'resize';
    }
    const e = camera && camera.matrixWorld && camera.matrixWorld.elements;
    if (why === null && e) {
      const dx = e[12] - c.camX, dy = e[13] - c.camY, dz = e[14] - c.camZ;
      if (dx * dx + dy * dy + dz * dz > CLOUD_SHADOW_JUMP_M * CLOUD_SHADOW_JUMP_M) why = 'jump';
    }
    const run = why !== null || c.sinceRun + 1 >= c.every;
    c.run = run;
    c.why = why;
    c.decided = true;
    if (run) {
      c.forceNext = null;
      c.cascadeCount = sm.cascadeCount;
      c.mapW = mapW;
      c.mapH = mapH;
      c.target = rt;
      c.targetW = rt ? rt.width : -1;
      c.targetH = rt ? rt.height : -1;
      c.targetD = rt ? rt.depth : -1;
      if (e) { c.camX = e[12]; c.camY = e[13]; c.camZ = e[14]; }
    }
  };

  const install = () => {
    if (c.installed) return;
    smOrigOwn = Object.prototype.hasOwnProperty.call(sm, 'update');
    spOrigOwn = Object.prototype.hasOwnProperty.call(sp, 'update');
    smOrig = sm.update;
    spOrig = sp.update;
    smWrap = function cloudShadowMapsCadence(camera, sunDirection, distance) {
      decide(camera);
      if (c.run) return smOrig.call(sm, camera, sunDirection, distance);
      return undefined;
    };
    spWrap = function cloudShadowPassCadence(renderer, _frame, deltaTime) {
      // Fallback: decide here if the cascade fit was not called this frame.
      if (!c.decided) decide(effect.camera);
      c.decided = false;
      c.frames++;
      if (!c.run) {
        c.skips++;
        c.sinceRun++;
        return undefined;
      }
      c.runs++;
      c.sinceRun = 0;
      if (c.why !== null) { c.forced++; c.lastForced = c.why; }
      return spOrig.call(sp, renderer, ++c.marchFrame, deltaTime);
    };
    sm.update = smWrap;
    sp.update = spWrap;
    c.forceNext = 'install';
    c.decided = false;
    c.sinceRun = 0;
    c.installed = true;
  };

  const uninstall = () => {
    if (!c.installed) return;
    if (sm.update === smWrap) {
      if (smOrigOwn) sm.update = smOrig;
      else delete sm.update;
    }
    if (sp.update === spWrap) {
      if (spOrigOwn) sp.update = spOrig;
      else delete sp.update;
    }
    smWrap = spWrap = smOrig = spOrig = null;
    c.installed = false;
    c.decided = false;
  };

  const ctl = {
    get every() { return c.every; },
    get installed() { return c.installed; },
    /** n ≤ 1 → uninstall (vendor path); junk / negative → unchanged. Returns the cadence in force. */
    setEvery(n) {
      const v = Number(n);
      if (!Number.isFinite(v) || v < 0) return c.every;
      const N = v <= 1 ? 1 : Math.min(CLOUD_SHADOW_EVERY_MAX, Math.floor(v));
      c.every = ok ? N : 1;
      if (c.every > 1) install();
      else uninstall();
      return c.every;
    },
    uninstall() {
      uninstall();
      c.every = 1;
    },
    /** Plain snapshot for `__cloudStateDiag().shadowCadence` (console use). */
    diag() {
      return {
        every: c.every,
        installed: c.installed,
        frames: c.frames,
        runs: c.runs,
        skips: c.skips,
        forced: c.forced,
        lastForced: c.lastForced,
        marchFrame: c.marchFrame,
        jumpM: CLOUD_SHADOW_JUMP_M,
      };
    },
  };
  ctl.setEvery(every);
  return ctl;
}

/**
 * @typedef {Object} SkyState
 * @property {number} dirColorArgb    — sun color u32 ARGB
 * @property {number} dirBright       — sun intensity scalar
 * @property {number} dirHeading      — sun heading degrees (from +Y north, CW)
 * @property {number} dirPitch        — sun pitch degrees (0=horizon, 90=zenith)
 * @property {number} ambColorArgb    — ambient/sky color u32 ARGB
 * @property {number} ambBright       — ambient intensity scalar (unused here — uSunIntensity covers it for now)
 * @property {number} fogColorArgb    — fog/horizon color u32 ARGB
 * @property {number} fogMin          — fog near distance (units)
 * @property {number} fogMax          — fog far distance (units)
 */

/**
 * Owns the takram CloudsEffect for the current scene. Constructed
 * once at scene init; `tick(state)` is called per-frame from the
 * sky-dome tick loop (Clouds-D wires this).
 */
export class CloudVolume {
  /**
   * @param {Object} opts
   * @param {THREE.Camera} opts.camera — the scene's active camera
   *   (CloudsEffect needs a camera to compute view rays + frustum splits)
   * @param {Object} [opts.cloudOptions] — passthrough to CloudsEffect's
   *   options arg (qualityPreset, coverage, resolutionScale, etc.)
   */
  constructor({ camera, cloudOptions }) {
    if (!camera) throw new Error('CloudVolume: camera is required');

    this.effect = new CloudsEffect(camera, cloudOptions);

    // ECEF transform — LOAD-BEARING.
    //
    // takram-clouds raymarches in ECEF (Earth-Centered Earth-Fixed)
    // coordinates. Cloud layers sit at fixed altitudes above Earth's
    // surface — layer R at altitude 750m = ECEF radius bottomRadius +
    // 750 = 6,360,750m. If the camera's world position maps to ECEF
    // radius 0 (i.e. Earth center, the identity-matrix default), rays
    // travel ~6,371km before hitting the cloud volume — well past
    // `maxRayDistance`, every ray misses, cloud RT is empty.
    //
    // Without this, clouds are invisible regardless of how well the
    // rest of the integration is wired. Discovered via cloud_debug.html
    // on real GPU 2026-05-15 — see [[project_holtburger_clouds_d_done]]
    // notes for the "200 unique colors, 280 cloud-alpha pixels" finding.
    //
    // Strategy: pretend world IS ECEF, plus a vertical offset so the
    // player's world position lands at Earth's surface:
    //   worldToECEFMatrix = translate world +Y by `bottomRadius`
    //   ecefToWorldMatrix = inverse
    //   altitudeCorrection = (0, 0, 0)
    //
    // Camera at world (x, y, z) maps to ECEF (x, bottomRadius + y, z).
    // For an AC player at world Y = 50, ECEF radius ≈ 6,360,050 — 50m
    // above Earth's surface, below the cloud-layer base at 750m. Rays
    // going up hit the cloud volume at the expected distance.
    const atm = AtmosphereParameters.DEFAULT;
    const bottomRadius = atm.bottomRadius;
    this.effect.worldToECEFMatrix.makeTranslation(0, bottomRadius, 0);
    this.effect.ecefToWorldMatrix.copy(this.effect.worldToECEFMatrix).invert();
    this.effect.altitudeCorrection.set(0, 0, 0);
    // CloudsEffect.updateSharedUniforms overwrites altitudeCorrection every
    // frame via getAltitudeCorrectionOffset() unless correctAltitude=false.
    // It uses the WGS-84 ellipsoid which doesn't match our spherical setup
    // (bottomRadius=6.36M vs WGS-84 semi-major 6.378M) → altitudeCorrection
    // gets ~(-92, -18137, -133), pushing cameras "underground" by 18 km.
    // Same problem hits cameraHeight (computed via geodetic.setFromECEF) —
    // see [[project_holtburger_clouds_f_done]]; we patch it in tick().
    this.effect.correctAltitude = false;
    this._bottomRadius = bottomRadius;
    this.material = this.effect.cloudsPass.currentMaterial;

    // Temporal-resolve variance clipping, LOOSENED (2026-08-01, live 1070
    // A/B). takram's varianceGamma=2 clips the history buffer so hard
    // against each frame's noisy raymarch neighborhood that the resolve
    // never converges — the shader's deterministic `frame % 64` STBN slice
    // cycle shows through as a ~2 s "video loop" (64 frames / ~30 fps),
    // EVEN WITH the real blue-noise stbn.bin (the 2026-07-12 fix shipped
    // the right asset but this clipping kept the loop alive). Measured on
    // the 1070 (static cloudy sky, 16-20 frame screenshot bursts, mean
    // consecutive-frame |Δ| over the sky band): γ2 = 2.02 with a strong
    // stroboscopic wave (max 3.18), γ4 = 1.01 dead flat (max 1.12), γ8 =
    // 1.11. Snap-turn ghosting probe: γ4's settle profile matches γ2's
    // (no reprojection-smear penalty). `?cloudVarGamma=N` overrides.
    {
      let gamma = 4;
      try {
        const v = parseFloat(new URLSearchParams(window.location.search).get('cloudVarGamma'));
        if (Number.isFinite(v) && v > 0 && v <= 64) gamma = v;
      } catch (_) {}
      const rm = this.effect.cloudsPass?.resolveMaterial;
      if (rm?.uniforms?.varianceGamma) rm.uniforms.varianceGamma.value = gamma;
      // The SHADOW pass has its own temporal resolve with even tighter
      // defaults (γ=1, α=0.01) — same non-convergence pathology, but it
      // shows as the terrain's cloud-shadow term PULSING (the ground
      // "breathes" on the 64-frame cycle), which reads as cloud cycling
      // when looking at the world. Same loosened γ; α raised 0.01 → 0.05
      // so the shadow history actually accumulates inside a cycle period.
      const sm = this.effect.shadowPass?.resolveMaterial;
      if (sm?.uniforms?.varianceGamma) sm.uniforms.varianceGamma.value = gamma;
      if (sm?.uniforms?.temporalAlpha) sm.uniforms.temporalAlpha.value = 0.05;
      // eslint-disable-next-line no-console
      console.log('[clouds] temporal resolve: varianceGamma=' + gamma +
        ' (clouds+shadow), shadow temporalAlpha=0.05 — anti-cycling 2026-08-01');
    }

    // Weather drift (2026-08-01, owner: "the pattern shouldn't be frozen in
    // place, or else maybe Holtburg would always be cloudy"). Two modes,
    // because LINEAR drift and GEOGRAPHIC anchoring are incompatible — a
    // translating offset would slide `?wxMap=dereth`'s desert-clear zone
    // off the desert and onto the grasslands:
    //  - wxMap=dereth (biome-anchored): a slow Lissajous WOBBLE of
    //    localWeatherOffset (±~3 km, periods 7/11 min — small against the
    //    ~10 km biome blur, so deserts stay dry) + the storm-look cycle
    //    give temporal variety while geography holds.
    //  - anything else (nasa/takram default, not world-anchored): plain
    //    linear drift ≈ 25 km/h — one 90 km tile in ~3.6 h; a front
    //    crosses a town in ~20-40 min.
    // `?cloudDrift=off|0` freezes (pre-2026-08-01 behavior); `?cloudDrift=N`
    // scales speed/amplitude. Applied per-tick for the wobble (cheap trig).
    {
      let scale = 1;
      let wxMap = null;
      try {
        const ps = new URLSearchParams(window.location.search);
        const v = ps.get('cloudDrift');
        if (v === 'off' || v === '0') scale = 0;
        else if (v != null && Number.isFinite(parseFloat(v))) scale = Math.max(0, Math.min(20, parseFloat(v)));
        wxMap = ps.get('wxMap');
      } catch (_) {}
      this._driftScale = scale;
      this._driftWobble = wxMap === 'dereth';
      if (!this._driftWobble) {
        // 25 km/h in tile units: (25/3600) km/s ÷ 90 km/tile ≈ 7.7e-5 tiles/s.
        const SPEED = 7.7e-5 * scale;
        this.effect.localWeatherVelocity.set(SPEED * 0.8, SPEED * 0.6);
      }
      // 2026-10-05 "sky resets every second, never progresses": takram's
      // shapeVelocity/shapeDetailVelocity default to ZERO, so the cloud
      // shapes sat fixed in world space and the only frame-to-frame change
      // was the shader's frame%64 STBN / frame%16 Bayer jitter cycle — a
      // deterministic 64-frame loop (~1.07 s @60fps) that reads as "snaps
      // back". Advect the shapes on the same ~7.7 m/s wind (offset units =
      // m/s × repeat). `?cloudDrift=off` still freezes everything.
      if (scale > 0) {
        const WIND = 7.7 * scale; // m/s
        const wx = -WIND * 0.8, wz = -WIND * 0.6;
        const sr = this.effect.shapeRepeat.x, dr = this.effect.shapeDetailRepeat.x;
        this.effect.shapeVelocity.set(wx * sr, 0, wz * sr);
        this.effect.shapeDetailVelocity.set(wx * dr, 0, wz * dr);
      }
    }

    // 2026-10-20 (improvement hunt gpu-shading-4, owner-approved) — march the
    // cloud-shadow cascades every Nth frame (`?cloudShadowEvery=N`, default 2;
    // `=1` installs nothing). Read once here; rationale at
    // installCloudShadowCadence above.
    {
      let every = CLOUD_SHADOW_EVERY_DEFAULT;
      try {
        every = parseCloudShadowEvery(window.location.search);
      } catch (_) {}
      this._shadowCadence = installCloudShadowCadence(this.effect, every);
      // eslint-disable-next-line no-console
      console.log('[clouds] cloud-shadow march every ' + this._shadowCadence.every +
        ' frame(s) (?cloudShadowEvery, default ' + CLOUD_SHADOW_EVERY_DEFAULT + ') — gpu-shading-4 2026-10-20');
    }

    // Scratch vec3 so tick() doesn't allocate per-frame.
    this._sunDirScratch = new THREE.Vector3();

    // 2026-10-07 — ?cloudNight per-frame result (cloud_night.js
    // cloudNightLighting writes into it; read by _pushCloudShadowsToTerrain
    // and window.__cloudNightState). `null` until the first state arrives →
    // the terrain push keeps its legacy behaviour until then.
    this._cloudNight = null;
    this._cloudNightScratch = {};
    // Un-scaled bases of the two takram uniforms ?cloudNight multiplies,
    // re-captured whenever anything else (quality preset, devtools) writes
    // the uniform — see _scaleCloudUniform.
    this._cloudNightBase = {
      skyLightScale: { base: NaN, written: NaN },
      maxShadowLengthRayDistance: { base: NaN, written: NaN },
    };
    // 2026-10-07 — ?cloudNight NIGHT FLOOR (1070 follow-up: night clouds were
    // pure black). The physical night light really is ~0 (see cloud_night.js),
    // so an art sky-light floor is injected into the cloud in-scatter term.
    // Patched into the shader SOURCE once, here, before the first compile —
    // one program, no define flips, no per-frame cost but one MAD per sample.
    // The colour (?cloudNightColor, URL-immutable) is read once; the level and
    // the display exposure are watched and the floor re-solved on change only.
    this._nightAmbientPatched = cloudNightEnabled() ? this._installNightAmbient() : false;
    this._nightColor = cloudNightColor();
    this._displayExposure = DISPLAY_EXPOSURE_DEFAULT;
    this._nightAmbientBase = [0, 0, 0];
    this._nightAmbientLevel = NaN;
    this._nightAmbientExposure = NaN;

    // Initialise to sane noon-ish values matching CloudsMaterial.ts's
    // construct-time defaults. tick() will overwrite as soon as state
    // arrives.
    this._lastState = null;
    this._atmosphereAttached = false;

    // Storm-look edge detector + zero-alloc weather-flags scratch.
    // undefined → first gated tick applies the current look uncondition-
    // ally (covers a session that boots mid-storm).
    this._stormLookApplied = undefined;
    this._wxFlags = { is_storm: false, temperature_C: NaN };
    // Look bookkeeping for `window.__cloudStateDiag().look` (2026-10-17): how
    // often and why the look was (re)applied, last few applies.
    this._lookApplies = 0;
    this._lookDriftReapplies = 0;
    this._lookInvalidated = null;
    this._lookLog = [];
  }

  /**
   * Sky-K.6 follow-on — bind takram's Bruneton precomputed-scattering
   * lookup tables to the cloud material. Once attached, the cloud
   * raymarch's irradiance/scattering queries hit the real tables
   * (same data the AerialPerspectiveEffect uses) instead of the
   * ARGB-decoded DayGroup stubs.
   *
   * Idempotent. Call once after `atmosphereRuntime.whenReady()`
   * resolves. Texture refs are pulled live, so if the runtime
   * re-bakes (rare), the cloud material picks up the new tables on
   * the next frame.
   *
   * @param {import('./atmosphere_runtime.js').AtmosphereRuntime} atmosphereRuntime
   */
  attachAtmosphere(atmosphereRuntime) {
    if (!atmosphereRuntime || this._atmosphereAttached) return false;
    const tex = atmosphereRuntime.textures;
    const u = this.material.uniforms;
    // Texture sampler uniforms inherited from AtmosphereMaterialBase.
    if (u.transmittance_texture) u.transmittance_texture.value = tex.transmittanceTexture;
    if (u.scattering_texture) u.scattering_texture.value = tex.scatteringTexture;
    if (u.irradiance_texture) u.irradiance_texture.value = tex.irradianceTexture;
    if (u.single_mie_scattering_texture) {
      u.single_mie_scattering_texture.value = tex.singleMieScatteringTexture ?? null;
    }
    if (u.higher_order_scattering_texture) {
      u.higher_order_scattering_texture.value = tex.higherOrderScatteringTexture ?? null;
    }
    this._atmosphereAttached = true;
    return true;
  }

  /**
   * Apply an AC SkyState snapshot to the cloud material's uniforms.
   * No-op if `state` is null/undefined (matches sky_lighting.js's
   * tick semantics — when no session is up, leave defaults).
   *
   * @param {SkyState|null} state
   * @param {Array|null} [_objStates] — sky object states from
   *   `sessionHandle.getSkyObjectStates()`. Currently unused;
   *   reserved for Clouds-E (coverage / weather animation).
   */
  tick(state, _objStates) {
    if (!state) return;
    const u = this.material.uniforms;

    // Sky-K.6 follow-on: clouds now sample the real Bruneton tables
    // (wired via attachAtmosphere). The five DayGroup uniforms
    // (uSunColor/uAmbientColor/uHorizonColor/uFogDensity/uSunIntensity)
    // are gone from CloudsMaterial — physics-derived irradiance and
    // aerial perspective in the real bruneton/runtime replaces them.
    //
    // The cameraHeight patch in cloud_overlay.js's preRender still
    // runs (must run AFTER CloudsMaterial.copyCameraSettings each
    // frame).

    // sunDirection — still load-bearing for the cloud raymarch.
    //
    // 2026-10-07 — ?cloudNight (DEFAULT ON). This used to pass the RAW
    // `state.dirPitch`, which never drops below 0.9 deg (Dereth's sun never
    // sets), while the sky raymarches the night-ramped elevation (−14 deg at
    // night, atmosphere_sky.js tick). Same Bruneton LUTs, two different suns:
    // all night the clouds were lit as a sunset — orange-red direct light
    // through a full air-mass plus sunset sky irradiance and inscatter —
    // under a night-dark sky. The clouds now take the sky's elevation from
    // the same function on the same snapshot (no seam). Heading is untouched.
    // `?cloudNight=off` restores the raw pitch and skips every write below.
    const cn = cloudNightLighting(state, this._cloudNightScratch);
    this._cloudNight = cn;
    sunDirFromHeadingPitch(
      state.dirHeading,
      cn.pitchDeg,
      this._sunDirScratch
    );
    if (this.effect.sunDirection && this.effect.sunDirection.copy) {
      this.effect.sunDirection.copy(this._sunDirScratch);
    }
    // Also mirror into the material's `sunDirection` uniform directly
    // in case the effect's accessor doesn't propagate immediately.
    if (u.sunDirection && u.sunDirection.value && u.sunDirection.value.copy) {
      u.sunDirection.value.copy(this._sunDirScratch);
    }

    // 2026-10-07 — ?cloudNight intensity side (uniform writes only; no
    // define flips, so no shader relink at dusk/dawn):
    //  - skyLightScale × skyLightMul: 1 unless ?cloudNightSkyLight lifts the
    //    night sky-light fill (faint "moonlit" read for the eye test);
    //  - maxShadowLengthRayDistance × directFactor: light shafts fade with the
    //    direct sun and are 0 (march exits on step one) once it has set — the
    //    beer-shadow map they read is built along a below-horizon sun then.
    if (cn.enabled) {
      this._scaleCloudUniform(u, 'skyLightScale', cn.skyLightMul);
      this._scaleCloudUniform(u, 'maxShadowLengthRayDistance', cn.directFactor);
      // Night floor: weight 0 while the sun is up → (0,0,0), i.e. golden
      // hour and day are untouched; smoothstep to full by −6 deg.
      if (this._nightAmbientPatched && u.cloudNightAmbient) {
        const level = cloudNightLevel();
        if (level !== this._nightAmbientLevel || this._displayExposure !== this._nightAmbientExposure) {
          cloudNightAmbientRadiance(this._nightColor, level, this._displayExposure, this._nightAmbientBase);
          this._nightAmbientLevel = level;
          this._nightAmbientExposure = this._displayExposure;
        }
        const b = this._nightAmbientBase;
        const w = cn.ambientWeight;
        u.cloudNightAmbient.value.set(b[0] * w, b[1] * w, b[2] * w);
      }
    }

    this._lastState = state;

    // Biome-anchored wobble drift (see constructor): move the sample
    // window on a slow Lissajous so the sky over any town keeps changing
    // while the map's geography stays put. Zero-alloc, plain trig.
    if (this._driftWobble && this._driftScale > 0 && this.effect.localWeatherOffset) {
      const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
      const amp = (18 / 512) * this._driftScale;   // ±18 texels ≈ ±3.2 km
      this.effect.localWeatherOffset.set(
        amp * Math.sin((2 * Math.PI * t) / 420),
        amp * Math.sin((2 * Math.PI * t) / 660 + 1.3)
      );
    }

    // Storm-reactive look (2026-08-01, replaces the WMO layer config).
    // `is_storm` is the real DayGroup SkyObject signal (loop.js W4 scan →
    // weather_state); the look is written on a flag EDGE (or once at boot,
    // or after invalidateCloudLook), never per-frame. `?cloudWeather=off`
    // freezes the fair-weather baseline cloud_overlay applied at construct time.
    //
    // 2026-10-17 (1070, Holtburg pinned): under a storm DayGroup, sessions
    // whose first raymarch ran on the legacy private composer before the main
    // pass adopted the effect rendered the FAIR sky although `_stormLookApplied`
    // said storm (and a storm toggled later rendered correctly) — an edge
    // applied before adoption did not survive it, and the edge never fired
    // again. So adoption now invalidates the edge (CloudOverlay.adoptMainPass →
    // invalidateCloudLook) and the next tick re-applies; and whenever the
    // layers stop carrying the look the flag says is applied (40 compares, at
    // the sky-tick rate), the look is written again (`driftReapplies`).
    if (readCloudWeatherAutoFlag()) {
      const storm = !!readWeatherFlags(this._wxFlags).is_storm;
      const drift = storm === this._stormLookApplied && !cloudLayersMatchLook(this.effect, storm);
      if (storm !== this._stormLookApplied || drift) {
        const why = drift ? 'drift'
          : this._stormLookApplied === undefined ? (this._lookInvalidated ?? 'boot') : 'edge';
        this._applyLook(storm, why);
      }
    }

    // Cloud-shadow push to terrain moved to CloudOverlay.preRender so
    // it runs AFTER composer.render fills the cascade matrices for
    // THIS frame. Pushing here would copy last-frame's matrix into
    // the terrain uniform, producing a one-frame lag visible as
    // shadow drift on fast time-of-day changes.
  }

  /**
   * 2026-10-07 — ?cloudNight night floor: splice one uniform and one line into
   * the takram clouds fragment shader, right after its own sky-light term:
   *   radiance += skyIrradiance * RECIPROCAL_PI4 * skyGradient * skyLightScale;
   *   radiance += cloudNightAmbient * skyGradient;          // ← added
   * so the floor is scattered, shadowed by alpha and integrated exactly like
   * sky light (bases darker than tops, thin edges blend into the sky). The
   * vendor string is never re-assigned after construction (CloudsMaterial
   * builds it once). Fail-soft: if either anchor is missing (vendor update),
   * nothing is patched and the clouds render as before.
   * @returns {boolean} patched
   */
  _installNightAmbient() {
    const m = this.material;
    const fs = m && m.fragmentShader;
    const UNI = 'uniform float skyLightScale;';
    const SKY = 'radiance += skyIrradiance * RECIPROCAL_PI4 * skyGradient * skyLightScale;';
    if (typeof fs !== 'string' || fs.indexOf(UNI) < 0 || fs.indexOf(SKY) < 0) {
      // eslint-disable-next-line no-console
      console.warn('[clouds] cloudNight: shader anchors not found — night floor NOT installed');
      return false;
    }
    m.fragmentShader = fs
      .replace(UNI, UNI + '\nuniform vec3 cloudNightAmbient; // 2026-10-07 cloudNight art night floor')
      .replace(SKY, SKY + '\n      radiance += cloudNightAmbient * skyGradient;');
    m.uniforms.cloudNightAmbient = new THREE.Uniform(new THREE.Vector3());
    m.needsUpdate = true;
    return true;
  }

  /**
   * The renderer's `toneMappingExposure` (CloudOverlay.preRender reports it
   * each frame). The night floor is solved in DISPLAY terms, so a changed
   * exposure re-solves it and the night clouds keep their on-screen colour.
   */
  setDisplayExposure(v) {
    if (Number.isFinite(v) && v > 0) this._displayExposure = v;
  }

  /**
   * 2026-10-07 — ?cloudNight: write `base × mul` into a takram clouds uniform
   * without losing the un-scaled base. If the live value is not the one we
   * last wrote, someone else set it (qualityPreset Object.assign, devtools),
   * so that value becomes the new base. Zero-alloc; writes only on change.
   */
  _scaleCloudUniform(uniforms, key, mul) {
    const un = uniforms?.[key];
    if (!un || typeof un.value !== 'number') return;
    const slot = this._cloudNightBase[key];
    if (!slot) return;
    if (un.value !== slot.written) slot.base = un.value;
    const v = slot.base * (Number.isFinite(mul) ? mul : 1);
    if (un.value !== v) un.value = v;
    slot.written = v;
  }

  _pushCloudShadowsToTerrain() {
    const ls = typeof window !== 'undefined' ? window.liveScene3d : null;
    const terrainMats = ls?.terrainMaterials;
    const shared = hotTerrainSharedOn();
    if (!Array.isArray(terrainMats) || terrainMats.length === 0) {
      if (shared) sharedReleaseCloud();
      return;
    }
    // Clouds-L URL knob — `?cloudShadow=off` (or runtime
    // `window.__setCloudShadowEnabled(false)`) flips uCloudShadowEnabled
    // to 0 once and skips the per-frame texture/matrix copy. Cheaper
    // than nulling out the texture each frame.
    //
    // 2026-10-07 — ?cloudNight: the same off-branch once the direct sun has
    // SET (directFactor 0, art elevation <= 0). The beer-shadow map is built
    // along the cloud sun direction, which is then below the horizon — a map
    // looking up from under the ground. Off is exact ("no cloud shadow", the
    // terrain's own `exp(-depth*0)` is 1 anyway) and skips the sample.
    const cn = this._cloudNight;
    const sunSet = !!(cn && cn.enabled && !(cn.directFactor > 0));
    const disabled = ls?.__cloudShadowDisabled === true || sunSet;
    const fast = hotCloudPushEnabled();
    if (disabled) {
      if (shared && sharedPushCloudOff(terrainMats)) return;
      if (fast) { _cloudShadowsOffFast(terrainMats); return; }
      for (const m of terrainMats) {
        const u = m?.uniforms;
        if (u?.uCloudShadowEnabled && u.uCloudShadowEnabled.value !== 0.0) {
          u.uCloudShadowEnabled.value = 0.0;
        }
      }
      return;
    }
    const cp = this.effect?.cloudsPass;
    const shadowTex = cp?.shadowBuffer;
    const mats = this.material?.uniforms?.shadowMatrices?.value;
    if (!shadowTex || !mats || !mats[0]) {
      if (shared) sharedObserveCloud(terrainMats);
      return;
    }
    // Optional per-frame strength override (drives `?cloudShadowStrength=N`
    // + runtime `__setCloudShadowStrength`). Applied here so newly-baked
    // LBs pick up the value as their materials register, without the
    // caller having to chase the terrainMaterials array.
    const strengthOverride = ls?.__cloudShadowStrength;
    // 2026-10-07 — ?cloudNight: through dusk/dawn the extinction is scaled by
    // the direct-sun factor (1 above ?cloudShadowFadeDeg, → 0 at the horizon),
    // so cloud shadows fade with the sun instead of popping off at sunset.
    // Base = the override if set, else the terrain.js initialiser (2.0).
    // Flag off (cn null / !enabled) → the legacy override-only write, exactly.
    const dayScaled = !!(cn && cn.enabled);
    const strength = dayScaled
      ? (Number.isFinite(strengthOverride) ? strengthOverride : CLOUD_SHADOW_STRENGTH_DEFAULT) * cn.directFactor
      : strengthOverride;
    if (shared && sharedPushCloudOn(terrainMats, shadowTex, mats[0], strength)) return;
    if (fast && _cloudShadowsPushFast(terrainMats, shadowTex, mats[0], strength)) return;
    for (const m of terrainMats) {
      const u = m?.uniforms;
      if (!u?.uCloudShadowEnabled) continue;
      if (u.uCloudShadowEnabled.value !== 1.0) u.uCloudShadowEnabled.value = 1.0;
      if (u.uCloudShadowMap.value !== shadowTex) u.uCloudShadowMap.value = shadowTex;
      u.uCloudShadowMatrix0.value.copy(mats[0]);
      if (Number.isFinite(strength) && u.uCloudShadowStrength &&
          u.uCloudShadowStrength.value !== strength) {
        u.uCloudShadowStrength.value = strength;
      }
    }
  }

  /**
   * Re-apply the current storm/fair cloud look (cloud_storm_look.js).
   * Kept as a method for the `__applyCloudWeather` devtools hook; the
   * per-frame path calls `applyCloudLook` directly on storm-flag edges.
   */
  _applyWeatherToCloudLayers() {
    const storm = !!readWeatherFlags(this._wxFlags).is_storm;
    return this._applyLook(storm, 'devtools');
  }

  /** Write the look and record why (see the tick's storm block). */
  _applyLook(storm, why) {
    this._stormLookApplied = storm;
    this._lookInvalidated = null;
    const ok = applyCloudLook(this.effect, storm);
    this._lookApplies++;
    if (why === 'drift') this._lookDriftReapplies++;
    const t = typeof performance !== 'undefined' ? Math.round(performance.now()) : Date.now();
    this._lookLog.push({ t, storm, why });
    if (this._lookLog.length > 8) this._lookLog.shift();
    return ok;
  }

  /**
   * Forget which look is applied, so the next tick writes the current one
   * again (CloudOverlay.adoptMainPass / releaseMainPass: whatever the effect
   * went through before the hand-over, the look is re-asserted after it).
   * @param {string} [reason]
   */
  invalidateCloudLook(reason = 'invalidated') {
    this._stormLookApplied = undefined;
    this._lookInvalidated = reason;
  }

  /**
   * 2026-10-20 (gpu-shading-4) — live cloud-shadow march cadence for the 1070
   * A/B (`window.__setCloudShadowEvery`). n ≤ 1 restores the vendor path
   * (wrappers removed); junk leaves it unchanged. Returns the cadence in force.
   */
  setShadowCadence(n) {
    return this._shadowCadence ? this._shadowCadence.setEvery(n) : null;
  }

  /** `window.__cloudStateDiag().shadowCadence` — {every, installed, runs, skips, …}. */
  shadowCadenceDiag() {
    return this._shadowCadence ? this._shadowCadence.diag() : null;
  }

  /**
   * Read back the current uniform values as a plain object. Used by
   * `cloud_bridge_test.html` to assert the tick() mapping is correct.
   *
   * 2026-08-03 — the five DayGroup uniforms (uSunColor / uAmbientColor /
   * uHorizonColor / uFogDensity / uSunIntensity) were REMOVED from
   * CloudsMaterial by the Sky-K.6 Bruneton switch — which tick() above states
   * outright, and which is verifiable: zero occurrences anywhere in
   * vendor/takram-three-clouds. This method nevertheless dereferenced
   * `u.uSunColor.value.toArray()` unguarded, i.e. it threw a TypeError on its
   * FIRST line on every call, which is why `cloud_bridge_test.html` has been
   * silently dead since K.6 (it also still calls `_internals.decodeArgbToRgb01`,
   * likewise removed). Each field is now read defensively and reports `null`
   * when the uniform is absent, so the snapshot documents what the material
   * ACTUALLY carries instead of crashing. `sunDirection` is the one survivor and
   * the only value tick() still writes. The `this.material?.` guard also makes
   * this safe to call after dispose() (which nulls it).
   */
  snapshotUniforms() {
    const u = this.material?.uniforms ?? null;
    const vec = (name) => {
      const v = u?.[name]?.value;
      return typeof v?.toArray === "function" ? v.toArray() : null;
    };
    const num = (name) => {
      const v = u?.[name]?.value;
      return typeof v === "number" ? v : null;
    };
    return {
      // Retired by Sky-K.6 — explicit nulls so a stale caller reads "gone".
      uSunColor:     vec("uSunColor"),
      uAmbientColor: vec("uAmbientColor"),
      uHorizonColor: vec("uHorizonColor"),
      uFogDensity:   num("uFogDensity"),
      uSunIntensity: num("uSunIntensity"),
      sunDirection:  vec("sunDirection"),
    };
  }

  /**
   * Tear-down. Frees the underlying CloudsEffect's GPU resources.
   */
  dispose() {
    // Sole owner of the CloudsEffect: CloudOverlay detaches the
    // EffectPass before composer.dispose() so the effect is freed here
    // only. Null `this.effect` FIRST so a re-entrant dispose() (or a
    // racing tick reading this.effect) sees the torn-down state and
    // never double-disposes.
    const effect = this.effect;
    this.effect = null;
    this.material = null;
    this._lastState = null;
    // ?hotTerrainShared: no further pushes — every terrain material back on its
    // own cloud uniforms (frozen at the values it shows now), nothing retained.
    if (hotTerrainSharedOn()) {
      try { sharedReleaseCloud(); } catch (_) { /* tear-down */ }
    }
    // Drop the shadow-cadence wrappers (back to the vendor methods).
    if (this._shadowCadence) {
      this._shadowCadence.uninstall();
      this._shadowCadence = null;
    }
    if (effect && typeof effect.dispose === 'function') {
      effect.dispose();
    }
  }
}

// Devtools: force a re-apply of the storm/fair cloud look. Call from console:
//   window.__applyCloudWeather()
// Reverts to bare takram defaults via __resetCloudLayers().
if (typeof window !== 'undefined') {
  // eslint-disable-next-line no-undef
  window.__applyCloudWeather = () => {
    const co = window.liveScene3d?.cloudOverlay;
    if (!co) return false;
    co.volume._applyWeatherToCloudLayers?.();
    return true;
  };
  // eslint-disable-next-line no-undef
  window.__resetCloudLayers = () => {
    const co = window.liveScene3d?.cloudOverlay;
    if (!co?.volume?.effect?.cloudLayers) return false;
    // NOTE: takram's cloudLayers.reset() is broken — it copies the
    // single CloudLayer.DEFAULT (all-zero altitudes, all channel 'r')
    // instead of the CloudLayers.DEFAULT collection. Use .copy() with
    // the static collection to restore the visually-correct config.
    co.volume.effect.cloudLayers.copy(CloudLayers.DEFAULT);
    // Top-level property (same dead-knob trap as _applyWeatherToCloudLayers).
    if (typeof co.volume.effect.coverage === 'number') {
      co.volume.effect.coverage = 0.3;
    }
    return true;
  };
  // Clouds-L knob: live tune cloud shadow darkness on terrain.
  // window.__setCloudShadowStrength(2.5) — higher = darker shadows.
  // Default 2.0 from terrain.js. Pass 0 to effectively disable.
  // eslint-disable-next-line no-undef
  window.__setCloudShadowStrength = (s) => {
    const v = +s;
    if (!Number.isFinite(v)) return null;
    if (window.liveScene3d) window.liveScene3d.__cloudShadowStrength = v;
    // ?hotTerrainShared: this writer is not the push — put every material back
    // on its own uCloudShadowStrength first (the next push re-binds).
    if (hotTerrainSharedOn()) sharedUnbindCloudStrength();
    const mats = window.liveScene3d?.terrainMaterials || [];
    for (const m of mats) {
      if (m?.uniforms?.uCloudShadowStrength) {
        m.uniforms.uCloudShadowStrength.value = v;
      }
    }
    return v;
  };
  // Clouds-L knob: gate cloud shadows on/off without reloading.
  // window.__setCloudShadowEnabled(false) — mirrors ?cloudShadow=off.
  // eslint-disable-next-line no-undef
  window.__setCloudShadowEnabled = (on) => {
    if (!window.liveScene3d) return null;
    window.liveScene3d.__cloudShadowDisabled = !on;
    return !!on;
  };
  // 2026-10-20 (gpu-shading-4): live ?cloudShadowEvery — march the cloud
  // shadow every N frames; 1 = every frame (vendor path, wrappers removed).
  // eslint-disable-next-line no-undef
  window.__setCloudShadowEvery = (n) => {
    const vol = window.liveScene3d?.cloudOverlay?.volume;
    return vol && typeof vol.setShadowCadence === 'function' ? vol.setShadowCadence(n) : null;
  };
}

// Exported for direct testing without instantiating a CloudVolume
// (cloud_bridge_test.html drives the conversion fns alone).
export const _internals = {
  sunDirFromHeadingPitch,
};
