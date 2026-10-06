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
import { atmosphereLutPlan } from './atmosphere_lut_plan.js';
export { ATMOSPHERE_LOAD_TIMEOUT_MS, atmosphereLutMode, atmosphereLutPlan } from './atmosphere_lut_plan.js';

const LOCAL_LUT_URL = new URL('./assets/atmosphere/', import.meta.url).href;

/** Upper bound on how long a LOW-session bake waits for in-world (then bakes
 *  anyway — a login that never completes must not leave the client skyless). */
export const IN_WORLD_WAIT_MAX_MS = 60000;

/** Resolve once the session has been in-world (sticky: `__bootState` itself
 *  can move on to `ready`), or after `maxMs`. No window ⇒ immediately. */
export function waitForInWorld(maxMs) {
  if (typeof window === 'undefined') return Promise.resolve(false);
  const t0 = Date.now();
  const inWorld = () => {
    try {
      if (window.__bootState === 'in-world' || window.__bootState === 'ready') return true;
      return (window.__bootStateHistory || []).some((h) => h && h.state === 'in-world');
    } catch (_) {
      return true;
    }
  };
  return new Promise((resolve) => {
    const tick = () => {
      if (inWorld()) return resolve(true);
      if (Date.now() - t0 >= maxMs) return resolve(false);
      setTimeout(tick, 250);
      return undefined;
    };
    tick();
  });
}

export class AtmosphereRuntime {
  /**
   * @param {Object} opts
   * @param {THREE.WebGLRenderer} opts.renderer — the live renderer; bake
   *   fallback draws into RenderTargets owned by this renderer
   * @param {AtmosphereParameters} [opts.atmosphere] — defaults to
   *   `AtmosphereParameters.DEFAULT` (same constant cloud_volume.js uses for
   *   the ECEF transform's bottomRadius)
   * @param {boolean} [opts.preferLoad] — false forces the bake path
   *   (debug / determinism testing). Absent ⇒ `atmosphereLutPlan()`.
   * @param {number} [opts.loadTimeoutMs] — race the download against a GPU
   *   bake after this long (0 = wait for the download). Absent ⇒ the plan.
   */
  constructor({ renderer, atmosphere, preferLoad, loadTimeoutMs } = {}) {
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
    // Why this source was chosen ("url:load" | "url:bake" | "bandwidth:low" |
    // "bandwidth:high" | "explicit") and whether the download lost the race.
    const plan = preferLoad === undefined ? atmosphereLutPlan() : { preferLoad: !!preferLoad, timeoutMs: 0, reason: 'explicit' };
    this.plan = plan.reason;
    this.loadTimedOut = false;
    const timeoutMs = Number.isFinite(loadTimeoutMs) ? loadTimeoutMs : plan.timeoutMs;
    this._readyPromise = this._init(plan.preferLoad, timeoutMs);
  }

  _now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  _loadExr() {
    const loader = new PrecomputedTexturesLoader({
      format: 'exr',
      combinedScattering: true,
      higherOrderScattering: true,
    });
    loader.setPath(LOCAL_LUT_URL);
    return new Promise((resolve, reject) => {
      loader.load('', resolve, undefined, reject);
    });
  }

  async _init(preferLoad, timeoutMs = 0) {
    const start = this._now();
    let pendingLoad = null;

    if (preferLoad) {
      const loadP = this._loadExr().then((t) => ({ kind: 'load', t }));
      let timer = null;
      const timeoutP = timeoutMs > 0
        ? new Promise((r) => { timer = setTimeout(() => r({ kind: 'timeout' }), timeoutMs); })
        : null;
      try {
        const first = await (timeoutP ? Promise.race([loadP, timeoutP]) : loadP);
        if (first.kind === 'load') {
          if (timer) clearTimeout(timer);
          this._textures = first.t;
          this.loadMs = this._now() - start;
          this.ready = true;
          this.source = 'load';
          return;
        }
        // The download is still in flight: bake now, keep the download as the
        // fallback should the bake fail.
        this.loadTimedOut = true;
        pendingLoad = loadP;
        // eslint-disable-next-line no-console
        console.warn(
          `[sky-k.1] atmosphere LUT download still running after ${timeoutMs} ms — ` +
            'generating the LUTs on the GPU instead (?atmosphereLut=load to wait for the download)'
        );
      } catch (err) {
        if (timer) clearTimeout(timer);
        // eslint-disable-next-line no-console
        console.warn('[sky-k.1] PrecomputedTexturesLoader failed, falling back to GPU bake:', err);
      }
    }

    try {
      // A LOW session bakes instead of downloading — but not DURING the login
      // handshake: the bake is main-thread GPU work (0.7–7.4 s measured on the
      // 1070 at 666 kbps), and while the net worker's script is still arriving
      // the session itself runs on the main thread. Measured: a bake that
      // landed mid-handshake pushed CharacterList past the auto-login's 25 s
      // budget. Nothing draws the sky before in-world, so wait for it (bounded).
      if (this.plan === 'bandwidth:low') await waitForInWorld(IN_WORLD_WAIT_MAX_MS);
      this.generator = new PrecomputedTexturesGenerator(this.renderer);
      await this.generator.update(this.atmosphere);
      this._textures = this.generator.textures;
      this.bakeMs = this._now() - start;
      this.ready = true;
      this.source = 'bake';
      if (pendingLoad) {
        // The losing download's textures are never bound — free them on arrival.
        pendingLoad
          .then(({ t }) => { for (const tex of Object.values(t || {})) tex?.dispose?.(); })
          .catch(() => {});
      }
    } catch (err) {
      if (pendingLoad) {
        // Bake failed but the download may still land: it is the fallback now.
        try {
          const { t } = await pendingLoad;
          this._textures = t;
          this.loadMs = this._now() - start;
          this.ready = true;
          this.source = 'load';
          return;
        } catch (_) { /* both paths failed — report the bake error below */ }
      }
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
