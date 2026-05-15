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
// state.dirHeading + state.dirPitch via the same conversion Sky-C
// uses in `sky_lighting.js::sunPositionFromHeadingPitch`.
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
import { CloudsEffect } from '@takram/three-clouds';
import { AtmosphereParameters } from '@takram/three-atmosphere';

// Match sky_lighting.js's defaults so the cloud volume's initial
// uniforms are sane even before the first SkyState arrives.
const DEFAULT_FOG_MIN = 200.0;
const DEFAULT_FOG_MAX = 2500.0;

// fogDensity calibration: matches the exponential model in
// brunetonStubs.glsl (`fogAmount = 1 - exp(-density * dist)`) against
// the linear model the three.js `Fog` uses (`amount = (dist - near) /
// (far - near)`). We choose density so fogAmount ≈ 0.5 at the half-
// way point between near + far, which gives a perceptually similar
// drop-off without making the exponential bottom out too hard.
//
// Solve `1 - exp(-d * halfRange) = 0.5` → `d = ln(2) / halfRange`.
const FOG_HALF_LN2 = Math.LN2;

function decodeArgbToRgb01(argb, /** out */ vec3) {
  const r = ((argb >>> 16) & 0xff) / 255;
  const g = ((argb >>> 8) & 0xff) / 255;
  const b = (argb & 0xff) / 255;
  vec3.set(r, g, b);
}

/**
 * Convert AC sun heading (deg from north, CW) + pitch (deg from
 * horizon) to a unit direction vector in three.js space (after the
 * scene's `worldRoot.rotation.x = -π/2` flip that's already applied
 * to other lighting in `sky_lighting.js`).
 *
 * Returns the existing `outVec3` for chaining.
 */
function sunDirFromHeadingPitch(headingDeg, pitchDeg, outVec3) {
  const headingRad = (headingDeg * Math.PI) / 180;
  const pitchRad = (pitchDeg * Math.PI) / 180;
  const cp = Math.cos(pitchRad);
  const sp = Math.sin(pitchRad);
  // (sin(h)*cos(p), sin(p), -cos(h)*cos(p)) — derived in Sky-C, verified
  // empirically by Sky-I-C's sun_visibility_probe (NE→ENE→N→W→SW arc
  // across t∈[0.04, 0.18] matches canonical east-to-west sky path).
  outVec3.set(
    cp * Math.sin(headingRad),
    sp,
    -cp * Math.cos(headingRad)
  );
  return outVec3;
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
    this._bottomRadius = bottomRadius;
    this.material = this.effect.cloudsPass.currentMaterial;

    // Scratch vec3 so tick() doesn't allocate per-frame.
    this._sunDirScratch = new THREE.Vector3();

    // Initialise to sane noon-ish values matching CloudsMaterial.ts's
    // construct-time defaults. tick() will overwrite as soon as state
    // arrives.
    this._lastState = null;
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

    // 1. uSunColor / uAmbientColor / uHorizonColor — ARGB decode.
    decodeArgbToRgb01(state.dirColorArgb, u.uSunColor.value);
    decodeArgbToRgb01(state.ambColorArgb, u.uAmbientColor.value);
    decodeArgbToRgb01(state.fogColorArgb, u.uHorizonColor.value);

    // 2. uSunIntensity — pass dirBright through. retail DayGroups
    // typically have values in [0.5, 1.0]; stub fn caps via clamp().
    u.uSunIntensity.value = Number.isFinite(state.dirBright) ? state.dirBright : 1.0;

    // 3. uFogDensity — derive from fogMin/fogMax. Calibration: density
    // s.t. fog amount = 0.5 at the midpoint between near + far,
    // matching the perceptual midpoint of three.js's linear Fog. See
    // FOG_HALF_LN2 comment above for the derivation.
    const fogMin = Number.isFinite(state.fogMin) ? state.fogMin : DEFAULT_FOG_MIN;
    const fogMax = Number.isFinite(state.fogMax) ? state.fogMax : DEFAULT_FOG_MAX;
    const halfRange = Math.max(1.0, (fogMax - fogMin) * 0.5);
    u.uFogDensity.value = FOG_HALF_LN2 / halfRange;

    // 4. sunDirection (existing atmosphere uniform that
    // brunetonStubs.glsl's GetSun*Irradiance fns read as the
    // `sun_direction` arg via clouds.vert/frag's `sunDirection`
    // uniform).
    sunDirFromHeadingPitch(
      state.dirHeading,
      state.dirPitch,
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

    this._lastState = state;
  }

  /**
   * Read back the current uniform values as a plain object. Used by
   * `cloud_bridge_test.html` to assert the tick() mapping is correct.
   */
  snapshotUniforms() {
    const u = this.material.uniforms;
    return {
      uSunColor:     u.uSunColor.value.toArray(),
      uAmbientColor: u.uAmbientColor.value.toArray(),
      uHorizonColor: u.uHorizonColor.value.toArray(),
      uFogDensity:   u.uFogDensity.value,
      uSunIntensity: u.uSunIntensity.value,
      sunDirection:  u.sunDirection?.value?.toArray?.() ?? null,
    };
  }

  /**
   * Tear-down. Frees the underlying CloudsEffect's GPU resources.
   */
  dispose() {
    if (this.effect && typeof this.effect.dispose === 'function') {
      this.effect.dispose();
    }
    this.effect = null;
    this.material = null;
    this._lastState = null;
  }
}

// Exported for direct testing without instantiating a CloudVolume
// (cloud_bridge_test.html drives the conversion fns alone).
export const _internals = {
  decodeArgbToRgb01,
  sunDirFromHeadingPitch,
  FOG_HALF_LN2,
  DEFAULT_FOG_MIN,
  DEFAULT_FOG_MAX,
};
