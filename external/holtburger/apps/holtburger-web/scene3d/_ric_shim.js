// scene3d/_ric_shim.js — side-effect shim for window.requestIdleCallback.
//
// MUST be the FIRST import in `scene3d/index.js`. The takram atmosphere
// stack (`@takram/three-atmosphere/build/shared2.js`) snapshots
// `window.requestIdleCallback` at module evaluation time into a private
// const `H`, then drives the Bruneton precompute generator (`update()`)
// via that snapshot. Once the snapshot lands, runtime overwrites of
// `window.requestIdleCallback` no longer reach the generator.
//
// Why this matters: the takram generator yields between iterations and
// schedules the next iteration via `H(...)` (= `requestIdleCallback`).
// In a live page running a busy three.js rAF loop the browser is never
// idle, so `requestIdleCallback` never fires, so the generator never
// progresses, so `update()`'s Promise never resolves. The atmosphere
// bake hangs forever; everything downstream (`AtmosphereLights`,
// `AtmosphereSky`, the `AerialPerspectiveEffect`, cloud composite) is
// stuck waiting on the same Promise.
//
// The standalone smoke (Sky-K.1) baked in ~8s because nothing else was
// running — the browser was idle, requestIdleCallback fired immediately,
// the generator progressed normally. The in-game regression is invisible
// from the smoke test on purpose.
//
// Fix: install a microtask-driven shim BEFORE any takram module
// evaluates. Then takram's `H` snapshot is the shim, and the bake
// completes in ~700 ms regardless of how busy the render loop is.
//
// Verified 2026-05-16 on GTX 1070 in-game: bake 717 ms post-shim
// (was infinite pre-shim). See
// [[project_holtburger_clouds_e_done_2026-05-15]] for the standalone
// baseline (8.1 s, no rAF loop), and the matching takram-side issue at
// `@takram/three-atmosphere@0.19.1/build/shared2.js` — `H` definition
// near top of file.
//
// SSR safety: this file is a no-op on Node-like environments where
// `window` is undefined. Only the wasm bundle's nodejs build path is
// affected, and that path never instantiates AtmosphereRuntime.

if (typeof window !== "undefined") {
  const original = window.requestIdleCallback;
  // Replace unconditionally. Even if the host provides a native rIC,
  // the takram generator's per-iteration latency dominates the bake's
  // ~700 ms runtime — microtask scheduling is the safer default.
  window.requestIdleCallback = function (cb /* opts unused — see header */) {
    // Mirror the deadline shape the takram code reads
    // (`{didTimeout, timeRemaining()}`). The 50 ms budget is large
    // enough that takram won't preemptively yield mid-iteration even
    // for the multipleScattering precompute (Bruneton's slowest pass).
    const start =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    // Use microtask via Promise.resolve().then so the iteration runs
    // on the next tick without waiting for an idle slot. setTimeout(0)
    // is the next-best fallback if Promises ever become exotic.
    queueMicrotask(function () {
      cb({
        didTimeout: false,
        timeRemaining: function () {
          const elapsed =
            (typeof performance !== "undefined"
              ? performance.now()
              : Date.now()) - start;
          return Math.max(0, 50 - elapsed);
        },
      });
    });
    // Return a non-zero handle so callers that store + cancelIdleCallback
    // it don't get tripped up by 0/undefined.
    return -1;
  };
  // Preserve cancellation as a no-op: callers expect the handle they
  // stored to be cancelable, but our microtask can't be cancelled cheaply.
  // The bake never cancels mid-flight, so this is fine.
  window.cancelIdleCallback = function () {};
  // Expose the original so a follow-on can restore it if a feature ever
  // needs the native scheduler back.
  window.__originalRequestIdleCallback = original;
}
