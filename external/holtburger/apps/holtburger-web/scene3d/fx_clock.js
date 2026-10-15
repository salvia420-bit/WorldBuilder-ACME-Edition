// scene3d/fx_clock.js — the clock the GPU FX modules animate on (2026-10-15).
//
// WHY: film mode's stepped takes (?filmMode=on, DEFAULT OFF) render frame k at a film timestamp, often slower than
// real time. Effects that read performance.now() directly (portal swirl / fire heat shimmer, ground decals, the
// portal-disc and lifestone-aura showcase, light-pool flicker and flash envelopes, trails, lifestone breath) then
// advanced by the WALL time between rendered frames: too fast, jumpy on a render hitch, out of phase with everything
// that follows the film clock. particles/particle_fx.js setFxTimeSource (installed by film/runtime/film_clock.js for
// a stepped take, restored with null) now also installs its source here, and those modules read fxNowMs().
//
// WHAT: setFxClockSource(fn|null) — fn() → milliseconds on the performance.now() base; fxNowMs() — that source, or
// performance.now() (Date.now() without it) when none is installed or it returns a non-finite value. With no source
// (every non-film session) fxNowMs() IS performance.now(): behaviour unchanged. Dependency-free on purpose (the VFX
// modules and their node tests import it without pulling in the particle system).

let _src = null;

/**
 * Install (fn) or clear (null) the FX clock source.
 * @param {(() => number)|null} fn milliseconds on the performance.now() base
 */
export function setFxClockSource(fn) {
  if (fn !== null && fn !== undefined && typeof fn !== "function") {
    throw new TypeError("setFxClockSource: expected a function or null");
  }
  _src = fn || null;
}

/** @returns {number} the FX clock in milliseconds (film time during a stepped take, else performance.now()). */
export function fxNowMs() {
  if (_src !== null) {
    let t = NaN;
    try { t = _src(); } catch (_) { t = NaN; }
    if (Number.isFinite(t)) return t;
  }
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}
