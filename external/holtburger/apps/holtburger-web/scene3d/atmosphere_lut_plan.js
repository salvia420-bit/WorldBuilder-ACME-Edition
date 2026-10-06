// scene3d/atmosphere_lut_plan.js — where the atmosphere LUTs come from
// (`?atmosphereLut`). Pure + import-light (only the bandwidth tier) so the
// Node suites can test it without loading @takram/three-atmosphere; the
// runtime (atmosphere_runtime.js) re-exports everything here.

import { lowBandwidth } from './bandwidth_tier.js';

// 2026-10-06 — the LUT source is chosen per session, not assumed.
//
// The "FAST" EXR path (atmosphere_runtime.js) is ~7.4 MB of downloads (scattering 3.9 MB +
// higher-order 3.4 MB + small ones), and the sky, the composer pipeline AND
// the `ready` boot state all wait on it (scene3d/index.js awaits
// `atmosphereRuntimePromise` before building the composer). Measured on the
// 1070 through a shaped 666 kbps link those EXRs had received 0 bytes three
// minutes after in-world and never completed inside 30 min — the session ran
// with no sky at all. The GPU bake produces the same LUTs from
// `AtmosphereParameters.DEFAULT` without a byte of download.
//
// `?atmosphereLut=load` — EXR download only (the pre-2026-10-06 behaviour,
//                         GPU bake only as the failure fallback).
// `?atmosphereLut=bake` — GPU bake, never download.
// absent / `auto`       — `?bandwidth` LOW ⇒ bake; otherwise download, but if
//                         the download is still running after
//                         ATMOSPHERE_LOAD_TIMEOUT_MS, bake instead (a link the
//                         tier misjudged must not leave the world skyless).
export const ATMOSPHERE_LOAD_TIMEOUT_MS = 15000;

/** `?atmosphereLut` → "load" | "bake" | "auto". */
export function atmosphereLutMode(search) {
  try {
    const s = search !== undefined
      ? search
      : typeof window !== 'undefined' && window.location ? window.location.search : '';
    const v = new URLSearchParams(s).get('atmosphereLut');
    if (v == null) return 'auto';
    const t = String(v).toLowerCase();
    if (t === 'load' || t === 'exr' || t === 'download') return 'load';
    if (t === 'bake' || t === 'gpu' || t === 'generate') return 'bake';
    return 'auto';
  } catch (_) {
    return 'auto';
  }
}

/** Resolve the plan: `{ preferLoad, timeoutMs }`. Pure — the tests drive it. */
export function atmosphereLutPlan({ mode = atmosphereLutMode(), low = undefined } = {}) {
  if (mode === 'load') return { preferLoad: true, timeoutMs: 0, reason: 'url:load' };
  if (mode === 'bake') return { preferLoad: false, timeoutMs: 0, reason: 'url:bake' };
  const isLow = low === undefined ? lowBandwidth() : !!low;
  if (isLow) return { preferLoad: false, timeoutMs: 0, reason: 'bandwidth:low' };
  return { preferLoad: true, timeoutMs: ATMOSPHERE_LOAD_TIMEOUT_MS, reason: 'bandwidth:high' };
}

