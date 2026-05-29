// scene3d/atmosphere_lights.js — Sky-K.3 physical lighting.
//
// Wraps takram's `SunDirectionalLight` + `SkyLightProbe`, sourcing radiance
// from the Bruneton transmittance + irradiance lookups baked by
// `AtmosphereRuntime`. Replaces the parametric `THREE.DirectionalLight` +
// `THREE.AmbientLight` writes that `SkyLightingController` (sky_lighting.js)
// has been driving.
//
// Sun direction continues to come from AC's existing DayGroup
// heading/pitch (preserves AC's compressed day cycle); only the COLOR
// + INTENSITY of the resulting light is now physically derived.
//
// Output units: physical radiance (W/m²/sr typical). REQUIRES tone
// mapping downstream — atmosphere_pipeline.js's EffectPass chain
// inserts ToneMappingEffect(AGX). Without that, lit surfaces saturate
// to white. With it, dynamic range collapses to perceptual sRGB.
//
// ECEF setup mirrors cloud_volume.js / atmosphere_pipeline.js:
//   worldToECEFMatrix = translate(0, bottomRadius, 0)
//   correctAltitude   = false
// (takram defaults to WGS-84 ellipsoid + altitude correction which
// would push the camera 18 km underground in our spherical setup.)

import * as THREE from "three";
import { sunDirFromHeadingPitch } from "./sun_direction.js";
import {
  SunDirectionalLight,
  SkyLightProbe,
  AtmosphereParameters,
} from "@takram/three-atmosphere";

// === L1 (render-completeness waves-2, 2026-05-29) — AC diurnal ambient ===
// Retail floors the per-channel ambient term at LSCAPE_LIGHT_MINIMUM = 0.2
// (acclient.c:40344; applied in LScape::set_landscape_lighting
// acclient.c:307024; combine at acclient.c:353860-353899). On the atmosphere
// path the SkyLightProbe's SH irradiance is physically derived (and carries
// its own diurnal color), so we drive the AC `ambBright` level + 0.2 floor
// into the probe's `intensity` multiplier (THREE.LightProbe.intensity is
// applied in the standard PBR `lights_pars_begin` lookup — no recompile).
// This guarantees indirect sky light never crushes fully to black at night
// (the 0.2 floor) and tracks AC's authored diurnal ambient curve. Tint stays
// physical (Bruneton SH) to avoid double-tinting the already-colored probe.
const LSCAPE_LIGHT_MINIMUM = 0.2;

/**
 * Owns the takram SunDirectionalLight + SkyLightProbe and updates them
 * each frame from an AC SkyState snapshot.
 */
export class AtmosphereLights {
  /**
   * @param {Object} opts
   * @param {THREE.Scene} opts.scene — root scene; lights are added here
   * @param {import('./atmosphere_runtime.js').AtmosphereRuntime} opts.atmosphereRuntime
   * @param {AtmosphereParameters} [opts.atmosphere] — defaults to DEFAULT
   * @param {number} [opts.sunDistance=1000] — DirectionalLight target offset.
   *   Doesn't affect shading (DirectionalLight is parallel); only shadow camera.
   *   Match sky_lighting.js's SUN_POSITION_DISTANCE for visual continuity.
   */
  constructor({ scene, atmosphereRuntime, atmosphere, sunDistance = 1000 }) {
    if (!scene) throw new Error("AtmosphereLights: scene is required");
    if (!atmosphereRuntime) throw new Error("AtmosphereLights: atmosphereRuntime is required");

    const atm = atmosphere ?? AtmosphereParameters.DEFAULT;
    const bottomRadius = atm.bottomRadius;
    const tex = atmosphereRuntime.textures;

    // Sun — physical directional light. Color/intensity comes from
    // sampling the transmittance lookup at the camera's altitude
    // toward sunDirection. `correctAltitude=false` because our world
    // is a spherical shell, not the WGS-84 ellipsoid.
    this.sun = new SunDirectionalLight({
      transmittanceTexture: tex.transmittanceTexture,
    });
    this.sun.worldToECEFMatrix.makeTranslation(0, bottomRadius, 0);
    this.sun.correctAltitude = false;
    this.sun.distance = sunDistance;

    // Sky probe — indirect sky irradiance as spherical harmonics.
    // Replaces THREE.AmbientLight; SH gives directional ambient that
    // correctly tints bottom-up vs top-down (e.g. ground vs underside
    // of an eave) instead of uniform.
    this.skyProbe = new SkyLightProbe({
      irradianceTexture: tex.irradianceTexture,
    });
    this.skyProbe.worldToECEFMatrix.makeTranslation(0, bottomRadius, 0);
    this.skyProbe.correctAltitude = false;

    scene.add(this.sun);
    scene.add(this.sun.target);
    scene.add(this.skyProbe);

    this._sunDirScratch = new THREE.Vector3();
    this._tickCount = 0;
    this._lastState = null;
  }

  /**
   * Per-frame update. Pass the AC SkyState snapshot (or null) + the
   * current camera world position. When state is null, leaves the
   * lights at their last applied values — same idle semantics as
   * sky_lighting.js's tick.
   *
   * @param {Object|null} state — SkyState with dirHeading, dirPitch (DEG)
   * @param {THREE.Vector3} [cameraWorldPos] — used for probe position +
   *   sun shadow-camera anchor. Defaults to origin if omitted.
   */
  tick(state, cameraWorldPos) {
    if (!state) return;

    sunDirFromHeadingPitch(state.dirHeading, state.dirPitch, this._sunDirScratch);
    this.sun.sunDirection.copy(this._sunDirScratch);
    this.skyProbe.sunDirection.copy(this._sunDirScratch);

    if (cameraWorldPos) {
      // sun.target.position anchors the parallel light's shadow
      // camera. SunDirectionalLight.update() reads target.position
      // for the transmittance lookup.
      this.sun.target.position.copy(cameraWorldPos);
      this.skyProbe.position.copy(cameraWorldPos);
    }

    this.sun.update();
    this.skyProbe.update();

    // === L1 (waves-2, 2026-05-29) — drive the probe intensity from AC's
    // diurnal ambient level with the 0.2 floor. Fail-soft: a missing /
    // non-finite ambBright leaves the probe at its default intensity (1.0).
    const ambBright = +state.ambBright;
    if (Number.isFinite(ambBright)) {
      this.skyProbe.intensity = Math.max(LSCAPE_LIGHT_MINIMUM, ambBright);
    }

    this._lastState = state;
    this._tickCount += 1;
  }

  /**
   * Public sun-direction read for downstream consumers (cloud volume,
   * lens flare in K.5). Read-only — clone if you need to mutate.
   */
  getSunDirection(outVec3) {
    if (outVec3) {
      outVec3.copy(this._sunDirScratch);
      return outVec3;
    }
    return this._sunDirScratch.clone();
  }

  dispose() {
    if (this.sun.parent) this.sun.parent.remove(this.sun);
    if (this.sun.target.parent) this.sun.target.parent.remove(this.sun.target);
    if (this.skyProbe.parent) this.skyProbe.parent.remove(this.skyProbe);
  }
}
