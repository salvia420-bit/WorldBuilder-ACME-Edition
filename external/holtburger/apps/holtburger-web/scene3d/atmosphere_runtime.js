// scene3d/atmosphere_runtime.js — Sky-K.1 foundation.
//
// Owns takram's `PrecomputedTexturesGenerator` and its 4-5 bruneton-scattering
// lookup tables (transmittance, scattering, irradiance, singleMieScattering,
// higherOrderScattering). These tables are what every downstream takram
// component reads: `SkyMaterial`, `SunDirectionalLight`, `SkyLightProbe`,
// `AerialPerspectiveEffect`. Without them all of those degenerate to black.
//
// Sky-K.1 is just the bake. No visible change yet:
//   - constructor instantiates the generator and kicks off the async bake
//   - `textures` getter is available immediately (the RT .texture refs exist
//     even before the bake writes pixels)
//   - `ready` becomes true once `gen.update()`'s Promise resolves
//   - `whenReady()` returns a Promise that resolves at the same moment
//
// Sky-K.2 (next phase) wraps the main scene in an EffectComposer and adds
// `AerialPerspectiveEffect` + `DitheringEffect`, sourcing the textures from
// here. Sky-K.3 adds the SkyMaterial + lighting. K.4 stars + moon.
//
// Gated by `?atmosphere=on`. When the flag is off this module is never
// imported (see scene3d/index.js).

import { PrecomputedTexturesGenerator, AtmosphereParameters } from '@takram/three-atmosphere';

export class AtmosphereRuntime {
  /**
   * @param {Object} opts
   * @param {THREE.WebGLRenderer} opts.renderer — the live renderer; bake
   *   draws into RenderTargets owned by this renderer
   * @param {AtmosphereParameters} [opts.atmosphere] — defaults to
   *   `AtmosphereParameters.DEFAULT` (same constant cloud_volume.js uses for
   *   the ECEF transform's bottomRadius)
   */
  constructor({ renderer, atmosphere } = {}) {
    if (!renderer) throw new Error('AtmosphereRuntime: opts.renderer is required');
    this.renderer = renderer;
    this.atmosphere = atmosphere ?? AtmosphereParameters.DEFAULT;
    this.generator = new PrecomputedTexturesGenerator(renderer);
    this.ready = false;
    this.error = null;
    this.bakeMs = null;

    const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._readyPromise = this.generator.update(this.atmosphere)
      .then(() => {
        this.bakeMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
        this.ready = true;
      })
      .catch((err) => {
        this.error = err;
        this.ready = false;
        // eslint-disable-next-line no-console
        console.warn("[sky-k.1] PrecomputedTexturesGenerator.update failed:", err);
      });
  }

  /** Bruneton lookup tables. Object shape:
   *   { transmittanceTexture, scatteringTexture, irradianceTexture,
   *     singleMieScatteringTexture, higherOrderScatteringTexture }
   * Texture references exist immediately; pixel data lands once `ready`. */
  get textures() {
    return this.generator.textures;
  }

  /** Returns a Promise that resolves when the bake is complete (or rejects
   * if the generator's update() failed). Safe to call multiple times. */
  whenReady() {
    return this._readyPromise;
  }

  dispose() {
    this.generator.dispose?.();
  }
}
