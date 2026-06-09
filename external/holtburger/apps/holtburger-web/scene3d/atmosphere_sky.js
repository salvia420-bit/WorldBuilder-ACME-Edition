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
import { sunDirFromHeadingPitch } from "./sun_direction.js";
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

    // Sky-K.6 cleanup (2026-05-18): the parametric sky machinery
    // (gradient dome, sun/moon/cloud-band rotators) was removed
    // alongside sky_assets.js in this session — there's no longer
    // anything to hide. SkyDome.setParametricSkyObjectsVisible
    // survives as a no-op stub for source-compatibility; skyCell
    // is an empty Group in the sky scene.

    // === SkyMaterial mesh =================================================
    this.skyMaterial = new SkyMaterial();
    if (this.skyMaterial.worldToECEFMatrix) {
      this.skyMaterial.worldToECEFMatrix.makeTranslation(0, atm.bottomRadius, 0);
    }
    if ("correctAltitude" in this.skyMaterial) {
      this.skyMaterial.correctAltitude = false;
    }
    Object.assign(this.skyMaterial, tex);

    // Bump sun angular radius to match AC's chunkier sun disc. Real-world
    // sun is ~0.00465 rad half-angle (0.53° diameter); AC reference
    // screenshots (e.g. Wardiel02.jpg) show the sun as a clearly visible
    // disc several degrees across with a strong halo. ~6.5× real puts
    // the disc at ~3.4° diameter — bigger than physical but still in
    // "sun, not sticker" territory. Override via `?sunSize=N` (radians)
    // or `liveScene3d.atmosphereSky.setSunAngularRadius(N)`.
    {
      let sunR = 0.03;
      try {
        // eslint-disable-next-line no-undef
        const sp = new URLSearchParams(window.location.search).get("sunSize");
        const v = parseFloat(sp ?? "");
        if (Number.isFinite(v) && v > 0) sunR = v;
      } catch (_) { /* keep default */ }
      if ("sunAngularRadius" in this.skyMaterial) {
        this.skyMaterial.sunAngularRadius = sunR;
      }
    }

    // Mirror the sun-disc bump for the moon. takram default 0.0045 rad
    // (~15.5 arcminutes); 0.025 ~5.5× real puts it in roughly the same
    // visual range as the AC billboard moons (renderOrder=800 in
    // ac_moons.js) — only matters when those billboards are hidden via
    // `?moons=off` debug path, but cheap to keep correct either way.
    // Override via `?moonSize=N` (radians) or setMoonAngularRadius(N).
    {
      let moonR = 0.025;
      try {
        // eslint-disable-next-line no-undef
        const sp = new URLSearchParams(window.location.search).get("moonSize");
        const v = parseFloat(sp ?? "");
        if (Number.isFinite(v) && v > 0) moonR = v;
      } catch (_) { /* keep default */ }
      if ("moonAngularRadius" in this.skyMaterial) {
        this.skyMaterial.moonAngularRadius = moonR;
      }
    }

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

    // === Wave R4.b — sky-object live luminosity (2026-05-29) =============
    // Retail interpolates each sky object's luminosity/brightness/transparency
    // between time-of-day keyframes (acclient.c:303122-303128, a plain linear
    // lerp `(next - prev) * ratio + prev` per field). Stars fade in at dusk /
    // out at dawn. The atmosphere stack dropped the parametric SkyObject mesh
    // that used to consume those lerps (Sky-K.6), so the takram star field
    // currently renders at a FIXED intensity regardless of time-of-day.
    //
    // Flag `?skyObjLum=on` (default OFF → byte-identical: starsMaterial.intensity
    // is never touched). When on, tick() scales the StarsMaterial `intensity`
    // uniform from the sun altitude (`sin(dirPitch)`) on the shared SkyState
    // snapshot, ramping linearly across a dawn/dusk band — the same linear
    // "between segments" interpolation intent as the acclient keyframe lerp.
    // The flag is captured ONCE here and consumed via `this._skyObjLum` in
    // tick(); declaration + use share `this` so there's no split-scope
    // ReferenceError (cf. a prior wave that shipped one by reading the flag
    // in a different function than it declared it).
    // render-audit T1d (skyObjLum): default-ON, opt-out via `?skyObjLum=off`.
    // Returns false only when the value is exactly "off"; any other value
    // (incl. absent param) and the no-window case default to ON. Pending
    // 1070 GPU eye-test before this becomes the committed default.
    this._skyObjLum = true;
    try {
      // eslint-disable-next-line no-undef
      const sp = new URLSearchParams(window.location.search).get("skyObjLum");
      this._skyObjLum = sp !== "off";
    } catch (_) { /* no window → default ON */ }
    // Stash the material's default (constructed) intensity so the modulation
    // scales relative to it instead of hard-coding 1.0.
    this._starsBaseIntensity =
      (this.starsMaterial && typeof this.starsMaterial.intensity === "number")
        ? this.starsMaterial.intensity
        : 1.0;
  }

  /**
   * Wave R4.b — night-fraction from sun altitude. Returns 1.0 when the
   * sun is well below the horizon (full night) and 0.0 once it has
   * climbed past the dawn band (full day), with a linear ramp between —
   * mirroring the acclient per-keyframe linear lerp intent. `dirPitch`
   * is the AC sun pitch in DEGREES (positive = above horizon), so
   * `sin(dirPitch)` is the sun's altitude component (-1 nadir .. +1 zenith).
   *
   * @param {Object} state — SkyState snapshot with `dirPitch` (deg)
   * @returns {number} night fraction in [0, 1]
   */
  static nightFractionFromSunAltitude(state) {
    const pitchDeg = +(state && state.dirPitch);
    if (!Number.isFinite(pitchDeg)) return 0.0;
    const sunAlt = Math.sin(pitchDeg * Math.PI / 180);
    // Band: sun-altitude +0.10 (sun ~6deg up, full day, stars off) down to
    // -0.10 (sun ~6deg below, full night, stars on). Linear in between so
    // stars cross-fade smoothly through dawn/dusk rather than popping.
    const SUN_DAY = 0.10;
    const SUN_NIGHT = -0.10;
    const t = (sunAlt - SUN_NIGHT) / (SUN_DAY - SUN_NIGHT);
    return 1.0 - Math.min(1.0, Math.max(0.0, t));
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

    // Sun direction from AC heading/pitch (shared utility).
    sunDirFromHeadingPitch(state.dirHeading, state.dirPitch, this._sunDirScratch);
    this.skyMaterial.sunDirection.copy(this._sunDirScratch);
    if (this.starsMaterial) {
      this.starsMaterial.sunDirection.copy(this._sunDirScratch);

      // Wave R4.b — sky-object live luminosity (default OFF → no-op,
      // byte-identical). When `?skyObjLum=on`, fade the star field in at
      // night / out by day. Linear ramp across the dawn/dusk sun-altitude
      // band (acclient.c:303122 lerp intent). The flag is the instance
      // field captured in the constructor — same `this` scope as here.
      if (this._skyObjLum) {
        const nightFrac = AtmosphereSky.nightFractionFromSunAltitude(state);
        this.starsMaterial.intensity = this._starsBaseIntensity * nightFrac;
      }
    }

    // Celestial sphere advances with AC game-time (~11.34× wall clock).
    // Updating per-frame is cheap (one matrix multiply + one vec3 from
    // astronomy-engine). Moon walks its phase, stars rotate around the
    // celestial pole at AC's compressed pace.
    const gameDate = gameDateNow(this._gameDateScratch);
    getMoonDirectionECEF(gameDate, this._moonDir);
    this.skyMaterial.moonDirection.copy(this._moonDir);
    if (this.stars) {
      getECIToECEFRotationMatrix(gameDate, this._eciToEcefMatrix);
      this.stars.setRotationFromMatrix(this._eciToEcefMatrix);
    }

    this._lastState = state;
    this._tickCount += 1;
  }

  /**
   * Tear down the takram SkyMaterial mesh + stars Points. Post-K.6
   * there's no parametric sky to "restore" — the atmosphere stack
   * is the sole sky renderer — so detach() just removes the meshes
   * from the sky scene.
   */
  detach() {
    if (this.skyMesh.parent) this.skyMesh.parent.remove(this.skyMesh);
    if (this.stars?.parent) this.stars.parent.remove(this.stars);
  }

  /**
   * Live-tune the sun disc size. `radians` is the half-angle the sun
   * subtends; takram default is ~0.00465, AC-look default here is 0.03.
   */
  setSunAngularRadius(radians) {
    if (!Number.isFinite(radians) || radians <= 0) return;
    if ("sunAngularRadius" in this.skyMaterial) {
      this.skyMaterial.sunAngularRadius = radians;
    }
  }

  /**
   * Live-tune the moon disc size. `radians` is the half-angle the moon
   * subtends; takram default is ~0.0045, AC-look default here is 0.025.
   */
  setMoonAngularRadius(radians) {
    if (!Number.isFinite(radians) || radians <= 0) return;
    if ("moonAngularRadius" in this.skyMaterial) {
      this.skyMaterial.moonAngularRadius = radians;
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
