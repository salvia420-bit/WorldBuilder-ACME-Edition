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
// W3 (2026-05-29): the weather-state UPDATE (updateFromDayGroup /
// weatherForState) lives in loop.js::tickWeatherState (clouds-independent).
// This module only READS the storm flag (real DayGroup SkyObject signal).
import { readWeatherFlags } from './weather_state.js';
import { applyCloudLook } from './cloud_storm_look.js';

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
    }

    // Scratch vec3 so tick() doesn't allocate per-frame.
    this._sunDirScratch = new THREE.Vector3();

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
    // weather_state); the look is re-applied only on a flag EDGE (or once
    // at boot), never per-frame. `?cloudWeather=off` freezes the
    // fair-weather baseline cloud_overlay applied at construct time.
    if (readCloudWeatherAutoFlag()) {
      const storm = !!readWeatherFlags(this._wxFlags).is_storm;
      if (storm !== this._stormLookApplied) {
        this._stormLookApplied = storm;
        applyCloudLook(this.effect, storm);
      }
    }

    // Cloud-shadow push to terrain moved to CloudOverlay.preRender so
    // it runs AFTER composer.render fills the cascade matrices for
    // THIS frame. Pushing here would copy last-frame's matrix into
    // the terrain uniform, producing a one-frame lag visible as
    // shadow drift on fast time-of-day changes.
  }

  _pushCloudShadowsToTerrain() {
    const ls = typeof window !== 'undefined' ? window.liveScene3d : null;
    const terrainMats = ls?.terrainMaterials;
    if (!Array.isArray(terrainMats) || terrainMats.length === 0) return;
    // Clouds-L URL knob — `?cloudShadow=off` (or runtime
    // `window.__setCloudShadowEnabled(false)`) flips uCloudShadowEnabled
    // to 0 once and skips the per-frame texture/matrix copy. Cheaper
    // than nulling out the texture each frame.
    const disabled = ls?.__cloudShadowDisabled === true;
    if (disabled) {
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
    if (!shadowTex || !mats || !mats[0]) return;
    // Optional per-frame strength override (drives `?cloudShadowStrength=N`
    // + runtime `__setCloudShadowStrength`). Applied here so newly-baked
    // LBs pick up the value as their materials register, without the
    // caller having to chase the terrainMaterials array.
    const strengthOverride = ls?.__cloudShadowStrength;
    for (const m of terrainMats) {
      const u = m?.uniforms;
      if (!u?.uCloudShadowEnabled) continue;
      if (u.uCloudShadowEnabled.value !== 1.0) u.uCloudShadowEnabled.value = 1.0;
      if (u.uCloudShadowMap.value !== shadowTex) u.uCloudShadowMap.value = shadowTex;
      u.uCloudShadowMatrix0.value.copy(mats[0]);
      if (Number.isFinite(strengthOverride) && u.uCloudShadowStrength &&
          u.uCloudShadowStrength.value !== strengthOverride) {
        u.uCloudShadowStrength.value = strengthOverride;
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
    this._stormLookApplied = storm;
    return applyCloudLook(this.effect, storm);
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
    // Sole owner of the CloudsEffect: CloudOverlay detaches the
    // EffectPass before composer.dispose() so the effect is freed here
    // only. Null `this.effect` FIRST so a re-entrant dispose() (or a
    // racing tick reading this.effect) sees the torn-down state and
    // never double-disposes.
    const effect = this.effect;
    this.effect = null;
    this.material = null;
    this._lastState = null;
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
}

// Exported for direct testing without instantiating a CloudVolume
// (cloud_bridge_test.html drives the conversion fns alone).
export const _internals = {
  sunDirFromHeadingPitch,
};
