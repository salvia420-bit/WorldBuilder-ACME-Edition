// bake_prewarm.js (Item 4, 2026-06-22) — GPU shader/texture pre-warm for streamed bakes.
//
// The 1070 headless probe (docs/PLAN-goal1-drawdistance-streaming-throttle-2026-06-22.md)
// showed the `pvsRingRadius=10` fill stall is CPU-compute-bound: shader-program LINK
// (`(program)` ≈20–32 %) + texture upload, alongside wasm decode. The terrain/statics/
// buildings lazy bakers attach their meshes straight to the live scene graph, so the
// program link + DataTexture upload happen SYNCHRONOUSLY on the first render frame after
// attach — a per-frame hitch that scales with how many bakes land together.
//
// `prewarmSubtree` runs `renderer.compileAsync(subtree, camera, scene)` BEFORE the subtree
// joins the scene, so on real GPUs (KHR_parallel_shader_compile) the compile + upload happen
// in the driver background while JS continues, and the await also yields to the event loop —
// spreading multiple bakes' attaches across frames. Mirrors the EnvCell prewarm (cells.js).
//
// SAFETY w.r.t. the A1–A4 / envcell-guard invariants: the per-LB bakers are NOT
// LRU-tracked until they RESOLVE (index.js `loadXForLandblock` calls `landblockLru.track`
// AFTER `await bake…`), and the stream guard holds the `(kind,lbKey)` in-flight key for the
// baker's whole duration, so an LB cannot be evicted mid-bake — adding a compileAsync await
// before the attach needs no residency re-check for the synchronous-tail bakers (terrain,
// buildings). statics time-slices its build loop and keeps its own eviction guard, so it
// re-checks residency after the prewarm await (see statics.js).
//
// `?bakePrewarm=off` restores the legacy attach-then-lazy-compile behaviour.

export const BAKE_PREWARM = (() => {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.search) {
      return new URLSearchParams(globalThis.location.search).get("bakePrewarm") !== "off";
    }
  } catch (_) {}
  return true;
})();

/**
 * Pre-warm one Object3D subtree's shader programs + texture uploads.
 * Fail-soft: never throws — on a missing renderer/camera/compileAsync or any compile error
 * the subtree simply lazy-compiles on first render (legacy behaviour). The caller awaits
 * this BEFORE attaching the subtree to the live scene graph.
 *
 * @param {{renderer?: any, camera?: any, scene?: any}} scene3d
 * @param {import("three").Object3D} object subtree to compile (a Mesh, Group, or temp parent)
 * @returns {Promise<void>}
 */
export async function prewarmSubtree(scene3d, object, lbKey = 0) {
  if (!BAKE_PREWARM || !object) return;
  // Non-blocking link + completion poll (scene3d/program_warm.js), replacing the
  // old blocking `await compileAsync` — which linked a program variant the lit
  // render often missed, so the ~1s ACTIVE_UNIFORMS fetch still landed on the
  // first visible frame (the Marketplace freeze). `markLb:false`: these bakes
  // count toward the teleport gate's pendingWarmCount() but must not flip the
  // per-cell reveal flag (cells warm on their own schedule). The subtree still
  // lazy-links safely on first render if warm is unavailable.
  try {
    const { warmSubtree } = await import("./program_warm.js");
    warmSubtree(scene3d, object, lbKey >>> 0, { markLb: false });
  } catch (_) {
    /* fail-soft: the subtree lazy-compiles on first render */
  }
}
