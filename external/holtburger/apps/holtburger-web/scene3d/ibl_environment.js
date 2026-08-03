// scene3d/ibl_environment.js — T3 (terrainplan.md, 2026-07-28): image-based
// lighting from the Bruneton sky. Opt-in `?ibl=on` (strict), default OFF.
//
// What this adds on top of the existing Sky-K.3 lighting (which already
// provides DIFFUSE sky irradiance via the takram SkyLightProbe SH):
//
//   1. `scene.environment` — a PMREM render of `skyDome.skyScene`, so every
//      MeshStandardMaterial (statics / buildings / creatures) gains indirect
//      SPECULAR (and env-driven indirect diffuse). Refreshed at low cadence
//      as the day cycle moves — not per frame.
//   2. A small mipmapped HDR cube (`envCubeTexture`) of the same sky for the
//      custom terrain ShaderMaterial, which can't consume three's PMREM
//      chunks. terrain.js samples it for a per-layer gloss term (ice/snow).
//   3. Diffuse ownership handoff: with `scene.environment` set, three feeds
//      standard materials indirect diffuse FROM THE ENV MAP, so the
//      SkyLightProbe would double-count ambient. While active this mutes the
//      probe (intensity 0 — the LIGHT LIST IS NEVER CHANGED, honoring the
//      frozen-light-count invariant in lighting.js) and drives
//      `scene.environmentIntensity` from the same retail diurnal ambient
//      term the probe used (AtmosphereLights.lastProbeIntensity), keeping
//      the L1 ambBright curve + 0.2 night floor contract intact.
//
// Cost model: one PMREM fromScene + one 6-face cube render every
// `refreshMs` (default 15000 — matches the retail 15 s light tick that
// tickTerrainSunDir already quantises to). Zero per-frame draw calls.
// First `scene.environment` assignment recompiles standard materials once
// (envMap define toggles on); subsequent refreshes swap texture objects
// only — no recompiles.

import * as THREE from "three";
// NIGHT RAMP (2026-08-02, ?nightRamp / ?nightEnv). `lastProbeIntensity` is
// arithmetically PINNED at exactly 0.2 for the whole AC day — it is
// max(0.2, max(0.2, ambBright) * worldLightScale) and Dereth's ambBright never
// exceeds 0.5, so the 0.4 world-light scale pushes the signal below the 0.2
// floor it is then re-clamped to. Characters, statics and the terrain env term
// therefore get IDENTICAL indirect fill at noon and at midnight. This applies
// the missing diurnal term as a multiplier on the indirect path ONLY: placed
// lights and emissive surfaces are absolute and stay exactly as authored, so
// hearths and lit windows gain contrast instead of being crushed with the rest.
import { nightFactorFromAuthoredPitch, nightEnvScale, nightRampEnabled } from "./night_ramp.js";

export function readIblFlag() {
  // DEFAULT ON as of 2026-07-28 (escape `?ibl=off`) after the off-screen
  // 1070 pass together with ?pbrTerrain — the `!== "off"` shape is the
  // DELIBERATE default-on idiom (url-flags.md 2026-07-23 box). Still a
  // no-op when the atmosphere stack is absent (construct site guards on
  // skyDome.skyScene + atmosphereLights).
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("ibl");
    return !(typeof v === "string" && v.toLowerCase() === "off");
  } catch (_) {
    return true;
  }
}

export function readIblRefreshMs() {
  try {
    const v = Number.parseFloat(
      new URLSearchParams(window.location.search).get("iblRefreshMs")
    );
    return Number.isFinite(v) && v >= 1000 ? v : 15000;
  } catch (_) {
    return 15000;
  }
}

const ENV_CUBE_SIZE = 128;

export class IblEnvironment {
  /**
   * @param {Object} opts
   * @param {THREE.WebGLRenderer} opts.renderer
   * @param {THREE.Scene} opts.scene — the world scene (environment sink)
   * @param {THREE.Scene} opts.skyScene — skyDome.skyScene (environment source)
   * @param {import('./atmosphere_lights.js').AtmosphereLights} [opts.atmosphereLights]
   * @param {number} [opts.refreshMs=15000]
   */
  constructor({ renderer, scene, skyScene, atmosphereLights, refreshMs = 15000 }) {
    if (!renderer || !scene || !skyScene) {
      throw new Error("IblEnvironment: renderer, scene and skyScene are required");
    }
    this.renderer = renderer;
    this.scene = scene;
    this.skyScene = skyScene;
    this.atmosphereLights = atmosphereLights ?? null;
    this.refreshMs = refreshMs;

    this._pmrem = new THREE.PMREMGenerator(renderer);
    this._pmrem.compileCubemapShader();
    this._pmremRT = null;

    // HDR half-float — the takram sky writes physical radiance well above
    // 1.0; an RGBA8 cube would clip the sun-side sky and kill the sparkle
    // the terrain gloss term exists for.
    this._cubeRT = new THREE.WebGLCubeRenderTarget(ENV_CUBE_SIZE, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this._cubeRT.texture.name = "scene3d-ibl-env-cube";
    // Near/far span the sky-scene content: the SkyMaterial quad is
    // clip-space (unaffected) but the stars Points sit at a large radius.
    this._cubeCam = new THREE.CubeCamera(0.1, 1e7, this._cubeRT);
    this.envCubeTexture = this._cubeRT.texture;

    this._lastRefreshMs = -Infinity;
    this.refreshCount = 0;

    if (this.atmosphereLights) this.atmosphereLights.iblOwnsDiffuse = true;
  }

  /** Re-render both environment products from the current sky. */
  refresh(nowMs) {
    // PMREM for standard materials. New RT per call (three has no reuse
    // API for fromScene); texture-object swap does not recompile programs.
    const rt = this._pmrem.fromScene(this.skyScene, 0.03, 0.1, 1e7);
    const old = this._pmremRT;
    this.scene.environment = rt.texture;
    this._pmremRT = rt;
    if (old) old.dispose();

    // Raw mipmapped cube for the terrain shader.
    this._cubeCam.update(this.renderer, this.skyScene);

    this._lastRefreshMs = nowMs;
    this.refreshCount += 1;
  }

  /**
   * Per-frame. Cheap except on refresh frames. `terrainMaterials` is the
   * live per-LB ShaderMaterial registry (scene3d.terrainMaterials) — walked
   * every frame like tickTerrainSunDir so bake/ibl init order never matters.
   */
  /**
   * Night multiplier for the indirect term, in (0, 1]. 1.0 by day and whenever
   * `?nightRamp=off`, so the legacy behaviour is exactly preserved.
   */
  _nightEnvMul() {
    try {
      if (!nightRampEnabled()) return 1.0;
      // AtmosphereLights.tick stashes the SkyState snapshot it was handed
      // (atmosphere_lights.js `this._lastState = state`), which is the same
      // object skyLightingController produced — so this needs no new plumbing
      // and cannot go stale relative to the lights it is modulating.
      const st = this.atmosphereLights?._lastState ?? null;
      const pitch = st && Number.isFinite(st.dirPitch) ? st.dirPitch : null;
      if (pitch == null) return 1.0;
      const n = nightFactorFromAuthoredPitch(pitch);
      return 1.0 + n * (nightEnvScale() - 1.0);
    } catch (_) {
      return 1.0;
    }
  }

  tick(nowMs, terrainMaterials) {
    if (nowMs - this._lastRefreshMs >= this.refreshMs) this.refresh(nowMs);

    // Diurnal intensity: reuse the exact retail ambient term the muted
    // probe would have used (L1 ambBright curve, 0.2 floor, worldLightScale).
    let p = this.atmosphereLights?.lastProbeIntensity;
    if (Number.isFinite(p)) p *= this._nightEnvMul();
    if (Number.isFinite(p)) this.scene.environmentIntensity = p;

    if (Array.isArray(terrainMaterials)) {
      const envI = Number.isFinite(p) ? p : 1.0;
      for (const mat of terrainMaterials) {
        const u = mat?.uniforms;
        if (!u || !u.uIblEnabled) continue;
        u.uIblEnabled.value = 1.0;
        u.uEnvCube.value = this.envCubeTexture;
        u.uEnvIntensity.value = envI;
      }
    }
  }

  dispose() {
    if (this.atmosphereLights) this.atmosphereLights.iblOwnsDiffuse = false;
    this.scene.environment = null;
    if (this._pmremRT) this._pmremRT.dispose();
    this._pmrem.dispose();
    this._cubeRT.dispose();
  }
}
