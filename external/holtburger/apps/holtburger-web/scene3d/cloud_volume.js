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
import { CloudsEffect, CloudLayers } from '@takram/three-clouds';
import { AtmosphereParameters } from '@takram/three-atmosphere';
import {
  getWeatherState as wxGetState,
} from './weather_state.js';
// daygroup_weather.js + the rest of weather_state.js stay on disk —
// opt-in via window.__applyCloudWeather() for experimentation.

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

// Earth-realistic atmospheric color model. Inputs sun pitch in degrees
// (0 = horizon, 90 = zenith). Returns RGB triples for:
//   sunColor      — direct sunlight (warm white → orange → red as sun lowers)
//   ambientColor  — Rayleigh-scattered sky tint at zenith
//   horizonColor  — atmospheric haze at view-distance (orange at low sun)
//
// Not a full Bruneton scattering model — just a perceptual approximation
// tuned to match real-Earth sky photography. Smooth across day/night
// transitions to avoid pop. Used when `window.__naturalSky === true` to
// override AC's parametric DayGroup colors so cloud appearance can be
// evaluated against a natural-looking sky.
function naturalSkyColors(sunPitchDeg, out) {
  const sunAlt = Math.sin((sunPitchDeg * Math.PI) / 180); // -1..+1
  const day = Math.max(0, sunAlt);            // 0 at horizon/below, 1 at zenith
  const grazing = Math.max(0, 1 - Math.abs(sunAlt) * 4); // peaks near horizon, 0 beyond ±15°
  const night = Math.max(0, -sunAlt * 2);      // 0 at horizon, 1 deep below

  // Sun direct color: warm white at noon, orange at low angle, dark blue under horizon.
  const sunR = (1.00 * day + 1.00 * grazing) * (1 - night) + 0.10 * night;
  const sunG = (0.97 * day + 0.55 * grazing) * (1 - night) + 0.12 * night;
  const sunB = (0.88 * day + 0.15 * grazing) * (1 - night) + 0.25 * night;

  // Zenith ambient: clear blue at noon, DARKER blue at twilight (B
  // dominant; the violet tint that bothered the user came from
  // grazing R=0.30 > G=0.20 which gave purple). Twilight is BLUE
  // (Earth's atmosphere absorbs red selectively when sun grazes).
  const ambR = 0.30 * day + 0.10 * grazing + 0.02 * night;
  const ambG = 0.55 * day + 0.18 * grazing + 0.03 * night;
  const ambB = 0.95 * day + 0.42 * grazing + 0.10 * night;

  // Horizon haze: pale near-white blue at noon, orange/red at dawn/dusk, dark at night.
  const horR = 0.75 * day + 1.00 * grazing + 0.03 * night;
  const horG = 0.85 * day + 0.55 * grazing + 0.04 * night;
  const horB = 1.00 * day + 0.20 * grazing + 0.10 * night;

  out.sun = [Math.min(1, sunR), Math.min(1, sunG), Math.min(1, sunB)];
  out.amb = [Math.min(1, ambR), Math.min(1, ambG), Math.min(1, ambB)];
  out.hor = [Math.min(1, horR), Math.min(1, horG), Math.min(1, horB)];
  return out;
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
    // Override with natural-Earth atmospheric colors when window.__naturalSky=true
    // (for fair cloud appearance evaluation; AC retail DayGroups push
    // unnatural purples/greens at certain times).
    if (typeof window !== 'undefined' && window.__naturalSky === true) {
      const colors = naturalSkyColors(state.dirPitch, this._naturalSkyOut || (this._naturalSkyOut = {}));
      u.uSunColor.value.set(colors.sun[0], colors.sun[1], colors.sun[2]);
      u.uAmbientColor.value.set(colors.amb[0], colors.amb[1], colors.amb[2]);
      u.uHorizonColor.value.set(colors.hor[0], colors.hor[1], colors.hor[2]);
    } else {
      decodeArgbToRgb01(state.dirColorArgb, u.uSunColor.value);
      decodeArgbToRgb01(state.ambColorArgb, u.uAmbientColor.value);
      decodeArgbToRgb01(state.fogColorArgb, u.uHorizonColor.value);
    }

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

    // (cameraHeight is patched in cloud_overlay.js's preRender — must run
    // AFTER CloudsMaterial.copyCameraSettings overwrites it each frame.)

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
    // Weather-driven layer config disabled — takram default layer
    // altitudes (R cumulus 750m, G cumulus 1000m, B cirrus 7500m,
    // A unused) gave the visually-correct soft cloud appearance.
    // Opt-in via window.__applyCloudWeather() to experiment.
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
