// scene3d/atmosphere_runtime.js — Sky-K.1 foundation, EXR-load fast path.
//
// Owns takram's Bruneton LUTs (transmittance, scattering, irradiance,
// optional single-mie, optional higher-order). These are what every
// downstream takram component reads: `SkyMaterial`, `SunDirectionalLight`,
// `SkyLightProbe`, `AerialPerspectiveEffect`. Without them all of those
// degenerate to black.
//
// Two paths:
//   1. FAST — `PrecomputedTexturesLoader` fetches pre-baked EXRs from
//      `./assets/atmosphere/` (vendored from takram's published assets at
//      commit eac10398). ~150-300 ms HTTP+parse on cold network; ~5 ms on
//      warm cache. This is the happy path for every cold boot.
//   2. SLOW (FALLBACK) — `PrecomputedTexturesGenerator` runs the GPU bake
//      against `AtmosphereParameters.DEFAULT` (~8-22 s on the main thread).
//      Only fires if the EXR load failed.
//
// Determinism: both paths produce the same LUTs for `AtmosphereParameters.DEFAULT`
// — the EXR files ARE the canonical output of the generator for that constant.
// The `combinedScattering: true` mode (default for both classes) packs Mie
// data into scattering.exr's alpha channel, so `single_mie_scattering.exr`
// is NOT fetched on the fast path. It stays vendored on disk as insurance
// for a future `combinedScattering: false` switch.
//
// Gated by `?atmosphere=on`. When the flag is off this module is never
// imported (see scene3d/index.js).

import {
  PrecomputedTexturesGenerator,
  PrecomputedTexturesLoader,
  AtmosphereParameters,
} from '@takram/three-atmosphere';

const LOCAL_LUT_URL = new URL('./assets/atmosphere/', import.meta.url).href;

export class AtmosphereRuntime {
  /**
   * @param {Object} opts
   * @param {THREE.WebGLRenderer} opts.renderer — the live renderer; bake
   *   fallback draws into RenderTargets owned by this renderer
   * @param {AtmosphereParameters} [opts.atmosphere] — defaults to
   *   `AtmosphereParameters.DEFAULT` (same constant cloud_volume.js uses for
   *   the ECEF transform's bottomRadius)
   * @param {boolean} [opts.preferLoad=true] — set false to force the bake
   *   path (debug / determinism testing).
   */
  constructor({ renderer, atmosphere, preferLoad = true } = {}) {
    if (!renderer) throw new Error('AtmosphereRuntime: opts.renderer is required');
    this.renderer = renderer;
    this.atmosphere = atmosphere ?? AtmosphereParameters.DEFAULT;
    this.generator = null;
    this._textures = null;
    this.ready = false;
    this.error = null;
    // `bakeMs` is populated when the GPU fallback ran; `loadMs` when the
    // EXR fast path won. Callers check `source` to know which.
    this.bakeMs = null;
    this.loadMs = null;
    this.source = null; // "load" | "bake"
    this._readyPromise = this._init(preferLoad);
  }

  async _init(preferLoad) {
    const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    if (preferLoad) {
      try {
        const loader = new PrecomputedTexturesLoader({
          format: 'exr',
          combinedScattering: true,
          higherOrderScattering: true,
        });
        loader.setPath(LOCAL_LUT_URL);
        const textures = await new Promise((resolve, reject) => {
          loader.load('', resolve, undefined, reject);
        });
        this._textures = textures;
        this.loadMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
        this.ready = true;
        this.source = 'load';
        return;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[sky-k.1] PrecomputedTexturesLoader failed, falling back to GPU bake:', err);
      }
    }

    try {
      this.generator = new PrecomputedTexturesGenerator(this.renderer);
      await this.generator.update(this.atmosphere);
      this._textures = this.generator.textures;
      this.bakeMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
      this.ready = true;
      this.source = 'bake';
    } catch (err) {
      this.error = err;
      this.ready = false;
      // eslint-disable-next-line no-console
      console.warn('[sky-k.1] PrecomputedTexturesGenerator.update failed:', err);
    }
  }

  /** Bruneton lookup tables. Object shape:
   *   { transmittanceTexture, scatteringTexture, irradianceTexture,
   *     singleMieScatteringTexture?, higherOrderScatteringTexture }
   * `singleMieScattering` is `undefined` on the EXR-load path (combinedScattering=true).
   * Texture references valid once `ready`. Returns `{}` before the promise resolves. */
  get textures() {
    return this._textures ?? {};
  }

  /** Returns a Promise that resolves when init is complete (or rejects
   * if both paths failed). Safe to call multiple times. */
  whenReady() {
    return this._readyPromise;
  }

  dispose() {
    this.generator?.dispose?.();
  }
}
