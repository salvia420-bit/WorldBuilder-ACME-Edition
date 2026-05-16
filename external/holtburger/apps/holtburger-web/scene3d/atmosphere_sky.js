// scene3d/atmosphere_sky.js — Sky-K.4 visible sky swap.
//
// Replaces the parametric `SkyDome` dome mesh + celestials with takram's
// `SkyMaterial` on a clip-space PlaneGeometry(2,2). The material reads
// the Bruneton scattering tables and produces a physically-grounded
// sky: blue-zenith → horizon haze, twilight reds at low sun, lunar
// glow at night, plus the sun and moon discs themselves.
//
// Stars come from `StarsMaterial` + `StarsGeometry`, fed by takram's
// stars.bin (9,096 Yale Bright Star Catalog entries). Rotation matrix
// drives ECI→ECEF; for now pinned to a constant epoch since AC's
// compressed day cycle decouples from real wall time. K.5 polish can
// refine by mapping AC time to a synthetic Date.
//
// Hand-off:
//   - The existing SkyDome's `skyCell` (parametric dome mesh) and
//     `skyObjectMeshes` (sun, moon, particles, cloud bands) get
//     `visible = false` when this constructor runs.
//   - The new SkyMaterial mesh is added to the SAME `skyDome.skyScene`
//     so the existing render-pass wiring (in cloud_overlay.js for
//     `?clouds=on`, in atmosphere_pipeline.js for `?atmosphere=on`)
//     continues to render the sky scene as a single RenderPass —
//     just now its contents are takram's instead of the dome's.

import * as THREE from "three";
import {
  SkyMaterial,
  StarsMaterial,
  StarsGeometry,
  AtmosphereParameters,
  DEFAULT_STARS_DATA_URL,
  getMoonDirectionECEF,
  getECIToECEFRotationMatrix,
} from "@takram/three-atmosphere";

// AC time anchor — Asheron's Call launch, 1999-11-02 00:00:00 UTC.
// `holtburger-world/src/sky.rs:62: AC_LAUNCH_UNIX_EPOCH = 941_500_800.0`.
const AC_LAUNCH_UNIX_EPOCH_MS = 941_500_800 * 1000;

// Retail Dereth game-day length in real seconds. `holtburger-world/src/sky.rs`
// (header comment around line 344): "day_length=7620s for retail Dereth".
// One game-day = 7620 real seconds = ~2 h 7 min. One real second advances
// `86400 / 7620 ≈ 11.34` game-seconds.
const AC_DAY_LENGTH_S = 7620;
const AC_TIME_COMPRESSION = 86400 / AC_DAY_LENGTH_S;

/**
 * Synthesize a Date that advances at AC game-time pace from the launch
 * anchor. ECI→ECEF rotation + moon direction both move ~11× faster than
 * real wall time, which keeps stars + moon visually correlated with the
 * AC sun (driven by AC heading/pitch) instead of drifting unrelated to
 * the game-world day.
 *
 * Mutates and returns `outDate` (a single Date instance reused per frame).
 */
function gameDateNow(outDate) {
  const realElapsedMs = Date.now() - AC_LAUNCH_UNIX_EPOCH_MS;
  const gameElapsedMs = realElapsedMs * AC_TIME_COMPRESSION;
  outDate.setTime(AC_LAUNCH_UNIX_EPOCH_MS + gameElapsedMs);
  return outDate;
}

export class AtmosphereSky {
  /**
   * @param {Object} opts
   * @param {THREE.Scene} opts.skyScene — the sky-pass scene (typically `skyDome.skyScene`)
   * @param {import('./atmosphere_runtime.js').AtmosphereRuntime} opts.atmosphereRuntime
   * @param {Object} [opts.skyDome] — optional reference; if present, hides skyCell + celestials
   * @param {AtmosphereParameters} [opts.atmosphere] — defaults to DEFAULT
   * @param {string} [opts.starsUrl] — override the stars.bin source URL
   * @param {boolean} [opts.includeStars=true] — set false to skip the stars fetch
   */
  constructor({ skyScene, atmosphereRuntime, skyDome, atmosphere, starsUrl, includeStars = true }) {
    if (!skyScene) throw new Error("AtmosphereSky: skyScene is required");
    if (!atmosphereRuntime) throw new Error("AtmosphereSky: atmosphereRuntime is required");

    const atm = atmosphere ?? AtmosphereParameters.DEFAULT;
    const tex = atmosphereRuntime.textures;

    this.skyScene = skyScene;
    this.skyDome = skyDome ?? null;

    // Hide the existing parametric sky machinery. The skyCell carries
    // the gradient mesh; setParametricSkyObjectsVisible(false) covers
    // sun/moon/particles/cloud bands.
    if (this.skyDome) {
      if (typeof this.skyDome.setParametricSkyObjectsVisible === "function") {
        this.skyDome.setParametricSkyObjectsVisible(false);
      }
      if (this.skyDome.skyCell) {
        this.skyDome.skyCell.visible = false;
      }
    }

    // === SkyMaterial mesh =================================================
    this.skyMaterial = new SkyMaterial();
    if (this.skyMaterial.worldToECEFMatrix) {
      this.skyMaterial.worldToECEFMatrix.makeTranslation(0, atm.bottomRadius, 0);
    }
    if ("correctAltitude" in this.skyMaterial) {
      this.skyMaterial.correctAltitude = false;
    }
    Object.assign(this.skyMaterial, tex);

    // PlaneGeometry(2, 2) covers clip space; SkyMaterial overrides the
    // vertex shader to project view rays from the camera regardless of
    // mesh world transform. frustumCulled=false because the mesh sits
    // at the origin and would otherwise be skipped from far cameras.
    this.skyMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.skyMaterial);
    this.skyMesh.frustumCulled = false;
    // renderOrder = -1 so the sky paints BEFORE skyDome's surviving
    // children (cloud bands etc. if re-enabled via __retroSky). The
    // sky-pass scene uses default sorting which honors renderOrder.
    this.skyMesh.renderOrder = -1;
    this.skyMesh.name = "atmosphere-sky-quad";
    skyScene.add(this.skyMesh);

    // === Stars (async-loaded) =============================================
    this.starsMaterial = null;
    this.stars = null;
    if (includeStars) {
      this.starsMaterial = new StarsMaterial({
        irradianceTexture: tex.irradianceTexture,
        scatteringTexture: tex.scatteringTexture,
        transmittanceTexture: tex.transmittanceTexture,
      });
      if (this.starsMaterial.worldToECEFMatrix) {
        this.starsMaterial.worldToECEFMatrix.makeTranslation(0, atm.bottomRadius, 0);
      }
      if ("correctAltitude" in this.starsMaterial) {
        this.starsMaterial.correctAltitude = false;
      }

      const url = starsUrl ?? DEFAULT_STARS_DATA_URL;
      // Use plain fetch instead of takram's ArrayBufferLoader so we
      // don't have to wire a Three.js LoadingManager just for this.
      fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`stars.bin HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        .then((buf) => {
          const geom = new StarsGeometry(buf);
          this.stars = new THREE.Points(geom, this.starsMaterial);
          this.stars.frustumCulled = false;
          this.stars.renderOrder = -1;
          this.stars.name = "atmosphere-stars";
          skyScene.add(this.stars);
          // First-frame ECI→ECEF rotation lands here; tick() advances
          // it at AC game-time pace afterwards.
          const eciToEcef = getECIToECEFRotationMatrix(gameDateNow(this._gameDateScratch));
          this.stars.setRotationFromMatrix(eciToEcef);
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn("[sky-k.4] stars.bin load failed:", err);
        });
    }

    this._gameDateScratch = new Date(0);
    this._eciToEcefMatrix = new THREE.Matrix4();
    this._moonDir = new THREE.Vector3();
    // Seed moon direction so first frame isn't (0,0,0).
    getMoonDirectionECEF(gameDateNow(this._gameDateScratch), this._moonDir);
    this.skyMaterial.moonDirection.copy(this._moonDir);

    this._sunDirScratch = new THREE.Vector3();
    this._tickCount = 0;
    this._lastState = null;
  }

  /**
   * Per-frame update from an AC SkyState snapshot. Updates the sun
   * direction on SkyMaterial + StarsMaterial. Moon direction stays
   * pinned to the epoch above.
   *
   * @param {Object|null} state — SkyState with dirHeading, dirPitch (DEG)
   */
  tick(state) {
    if (!state) return;

    // Sun direction from AC heading/pitch.
    const headingRad = (state.dirHeading * Math.PI) / 180.0;
    const pitchRad = (state.dirPitch * Math.PI) / 180.0;
    const cp = Math.cos(pitchRad);
    const sp = Math.sin(pitchRad);
    this._sunDirScratch.set(
      cp * Math.sin(headingRad),
      sp,
      -cp * Math.cos(headingRad)
    );
    this.skyMaterial.sunDirection.copy(this._sunDirScratch);
    if (this.starsMaterial) {
      this.starsMaterial.sunDirection.copy(this._sunDirScratch);
    }

    // Celestial sphere advances with AC game-time (~11.34× wall clock).
    // Updating per-frame is cheap (one matrix multiply + one vec3 from
    // astronomy-engine). Moon walks its phase, stars rotate around the
    // celestial pole at AC's compressed pace.
    const gameDate = gameDateNow(this._gameDateScratch);
    getMoonDirectionECEF(gameDate, this._moonDir);
    this.skyMaterial.moonDirection.copy(this._moonDir);
    if (this.stars) {
      this._eciToEcefMatrix.copy(getECIToECEFRotationMatrix(gameDate));
      this.stars.setRotationFromMatrix(this._eciToEcefMatrix);
    }

    this._lastState = state;
    this._tickCount += 1;
  }

  /**
   * Reverse the hand-off — restore the parametric sky machinery. Used
   * if the user toggles atmosphere off at runtime via devtools.
   */
  detach() {
    if (this.skyMesh.parent) this.skyMesh.parent.remove(this.skyMesh);
    if (this.stars?.parent) this.stars.parent.remove(this.stars);
    if (this.skyDome) {
      if (typeof this.skyDome.setParametricSkyObjectsVisible === "function") {
        this.skyDome.setParametricSkyObjectsVisible(true);
      }
      if (this.skyDome.skyCell) {
        this.skyDome.skyCell.visible = true;
      }
    }
  }

  dispose() {
    this.detach();
    this.skyMaterial.dispose?.();
    this.starsMaterial?.dispose?.();
    this.skyMesh.geometry?.dispose?.();
    this.stars?.geometry?.dispose?.();
  }
}
