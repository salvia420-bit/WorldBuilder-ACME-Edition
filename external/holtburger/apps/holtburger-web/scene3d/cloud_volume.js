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
import {
  getWeatherState as wxGetState,
  updateFromDayGroup as wxUpdateFromDayGroup,
} from './weather_state.js';
import { weatherForState } from './daygroup_weather.js';

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

    // Scratch vec3 so tick() doesn't allocate per-frame.
    this._sunDirScratch = new THREE.Vector3();

    // Initialise to sane noon-ish values matching CloudsMaterial.ts's
    // construct-time defaults. tick() will overwrite as soon as state
    // arrives.
    this._lastState = null;
    this._atmosphereAttached = false;
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

    // sunDirection — still load-bearing for the cloud raymarch. Same
    // conversion from AC heading/pitch as before.
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

    // Clouds-E.3 — WMO-anchored weather state is updated from the
    // active DayGroup so downstream readers (weather_state.getState,
    // future weather HUD) see live values. We do NOT auto-call
    // `_applyWeatherToCloudLayers()` from the tick — rewriting takram
    // CloudLayer channel/altitude/density per frame appears to break
    // the cloud-shadow → terrain pipeline (terrain reads invisible).
    // The state update alone is cheap and side-effect-free; the layer
    // apply stays opt-in via `window.__applyCloudWeather()` until the
    // per-frame regression is root-caused.
    try {
      const profile = weatherForState(state, state.dayGroupIndex);
      wxUpdateFromDayGroup(profile);
    } catch (_) {
      // Weather wiring must not block the cloud raymarch.
    }

    // Clouds-L — push the cloud effect's cascade-0 shadow buffer +
    // matrix into all terrain materials so the terrain shader can
    // sample cloud occlusion. takram's cloud raymarch already
    // produces these for self-shadowing; we just borrow them.
    this._pushCloudShadowsToTerrain();
  }

  _pushCloudShadowsToTerrain() {
    const ls = typeof window !== 'undefined' ? window.liveScene3d : null;
    const terrainMats = ls?.terrainMaterials;
    if (!Array.isArray(terrainMats) || terrainMats.length === 0) return;
    const cp = this.effect?.cloudsPass;
    const shadowTex = cp?.shadowBuffer;
    const mats = this.material?.uniforms?.shadowMatrices?.value;
    if (!shadowTex || !mats || !mats[0]) return;
    for (const m of terrainMats) {
      const u = m?.uniforms;
      if (!u?.uCloudShadowEnabled) continue;
      u.uCloudShadowEnabled.value = 1.0;
      u.uCloudShadowMap.value = shadowTex;
      u.uCloudShadowMatrix0.value.copy(mats[0]);
    }
  }

  /**
   * Configure takram's 4 CloudLayer entries based on weather state.
   *   R = low étage cumulus, base at LCL (Espy)
   *   G = low étage stratocumulus, pressure-derived base
   *   B = middle étage altocumulus / altostratus
   *   A = high étage cirrus — OR cumulonimbus tall column when storm
   */
  _applyWeatherToCloudLayers() {
    // Transparency-preserving WMO config. Findings from probe 2026-05-16:
    //   densityScale > 0.05 kills soft alpha (cloud edges go opaque)
    //   shapeAmount < 1.0 removes puff breaks → uniform sheet
    //   LCL < 600m brings cumulus too close to camera → less haze, harder edges
    //   Heavy layer overlap (cumulus AT stratocumulus altitudes) stacks density
    //
    // Strategy: keep takram's visually-tuned cumulus+cirrus base
    // (high altitudes, default densities, full shapeAmount). Use WMO
    // state only to RAISE cumulus base when LCL says clouds should
    // be higher (drier air), never to lower it. Stratocumulus and
    // altocumulus get cirrus-class densities (≤ 0.005) so they
    // contribute texture without going opaque.
    const layers = this.effect?.cloudLayers;
    if (!layers || layers.length < 4) return;
    const w = wxGetState();
    const e = w.etage_m;

    // Coverage stays near takram's 0.3 default. Humidity nudges in
    // a narrow visual-quality-preserving band.
    const spread = Math.max(0, w.temperature_C - w.dewpoint_C);
    const coverage = THREE.MathUtils.clamp(0.25 + (10 - spread) * 0.01, 0.2, 0.4);

    // R: low cumulus. Base = max(LCL, 600m) so we never drop below the
    // visually-tuned default. height stays default 650m. Density and
    // shape stay at takram defaults to preserve puffy alpha edges.
    const cumulusBase = Math.max(600, Math.min(w.lcl_m, e.low.max - 650));
    layers[0].channel = 'r';
    layers[0].altitude = cumulusBase;
    layers[0].height = 650;
    layers[0].densityScale = 0.2;
    layers[0].shapeAmount = 1.0;
    layers[0].shapeDetailAmount = 1.0;
    layers[0].weatherExponent = 1.0;
    layers[0].shapeAlteringBias = 0.35;
    layers[0].coverageFilterWidth = 0.6;

    // G: second cumulus layer, sits above R like takram default
    // (R 750-1400, G 1000-2200 → 250m vertical stagger). Match takram
    // density and full shape to preserve transparency.
    layers[1].channel = 'g';
    layers[1].altitude = cumulusBase + 250;
    layers[1].height = 1200;
    layers[1].densityScale = 0.2;
    layers[1].shapeAmount = 1.0;
    layers[1].shapeDetailAmount = 1.0;
    layers[1].weatherExponent = 1.0;
    layers[1].shapeAlteringBias = 0.35;
    layers[1].coverageFilterWidth = 0.6;

    // B: altocumulus, lower-middle étage (~3 km), water-droplet patches.
    // Sits well BELOW cirrus so they read as separate layers in the
    // sky. shapeAmount 0.4 + low density for thin texture.
    layers[2].channel = 'b';
    layers[2].altitude = e.middle.min + (e.middle.max - e.middle.min) * 0.25;
    layers[2].height = 800;
    layers[2].densityScale = 0.005;
    layers[2].shapeAmount = 0.4;
    layers[2].shapeDetailAmount = 0;
    layers[2].weatherExponent = 1.0;
    layers[2].shapeAlteringBias = 0.35;
    layers[2].coverageFilterWidth = 0.5;

    // A: cirrus — TRUE high-étage, ice crystals. Place mid-way through
    // the high étage (~9 km mid-lat) so it's clearly above altocumulus
    // and gets full ice-albedo boost. Storm flag still flips to tall
    // cumulonimbus convective column.
    layers[3].channel = 'a';
    if (w.is_storm) {
      layers[3].altitude = e.low.min + 600;
      layers[3].height = e.high.max - e.low.min - 600;
      layers[3].densityScale = 0.35;
      layers[3].shapeAmount = 1.0;
      layers[3].shapeDetailAmount = 1.0;
      layers[3].weatherExponent = 1.2;
      layers[3].shapeAlteringBias = 0.4;
      layers[3].coverageFilterWidth = 0.7;
    } else {
      layers[3].altitude = e.high.min + (e.high.max - e.high.min) * 0.5;
      layers[3].height = 600;
      layers[3].densityScale = 0.002;  // very thin ice crystal sheet
      layers[3].shapeAmount = 0.3;
      layers[3].shapeDetailAmount = 0;
      layers[3].weatherExponent = 0.7;
      layers[3].shapeAlteringBias = 0.3;
      layers[3].coverageFilterWidth = 0.4;
    }

    if (this.effect.clouds && 'coverage' in this.effect.clouds) {
      this.effect.clouds.coverage = coverage;
    }
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

// Devtools opt-in for the WMO-driven layer config. Call from console:
//   liveScene3d.cloudOverlay.volume.applyCloudWeather()
// Reverts to takram defaults via __resetCloudLayers().
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
    co.volume.effect.clouds.coverage = 0.3;
    return true;
  };
  // Clouds-L knob: live tune cloud shadow darkness on terrain.
  // window.__setCloudShadowStrength(2.5) — higher = darker shadows.
  // Default 2.0 from terrain.js. Pass 0 to effectively disable.
  // eslint-disable-next-line no-undef
  window.__setCloudShadowStrength = (s) => {
    const mats = window.liveScene3d?.terrainMaterials || [];
    for (const m of mats) {
      if (m?.uniforms?.uCloudShadowStrength) {
        m.uniforms.uCloudShadowStrength.value = s;
      }
    }
    return s;
  };
}

// Exported for direct testing without instantiating a CloudVolume
// (cloud_bridge_test.html drives the conversion fns alone).
export const _internals = {
  sunDirFromHeadingPitch,
};
