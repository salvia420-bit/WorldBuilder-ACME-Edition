// scene3d/skip_empty_multidraw.js — a BatchedMesh whose rebuild culled every
// instance draws nothing, so do not pay three's per-draw setup for it
// (`?skipEmptyMultiDraw`, DEFAULT ON, `=off` escape). Perf 2026-10-07.
//
// WHY. three r184 decides a BatchedMesh's multidraw list inside the object's
// `onBeforeRender` / `onBeforeShadow`, i.e. AFTER the renderer has committed to
// drawing the node. `renderBufferDirect` then runs in full — `setProgram`
// (uniform + texture refresh, the indirect-texture bind), `state.setMaterial`,
// the VAO setup — and only at the very end does `renderMultiDraw` return on
// `drawCount === 0` (three.module.js :2288). Nothing reaches the GPU and
// `renderer.info` never counts it, so these calls are invisible in every draw
// census, but the setup is most of what a draw costs the CPU on this frame
// (prof3.json, 1070 ultra: `setProgram` is 1.78 s of `renderBufferDirect`'s
// 2.39 s, texture uploads included).
// They are common exactly where the frame is fattest: the ring-spanning
// statAtlas buckets are `frustumCulled = false` (static_atlas.js), so every one
// of them is submitted to every CSM cascade and the colour pass, however few of
// its instances that light's frustum holds (the 30 m near cascade often holds
// none — how often is a LIVE-CHECK item: `window.__skipEmptyMultiDraw.stats`).
//
// WHAT. A wrapper on `renderer.renderBufferDirect` that returns early for a
// BatchedMesh whose `_multiDrawCount` is 0. OUTPUT-IDENTICAL: three would have
// issued no GL draw for it either; the skipped `setProgram` only primed state
// the next real draw sets for itself. `onBeforeRender` / `onAfterRender` /
// `onBeforeShadow` still run (they are called by renderObject, not here).

const FLAG = (() => {
  try {
    const v = (new URLSearchParams(globalThis.location?.search || "").get("skipEmptyMultiDraw") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
})();

export function skipEmptyMultiDrawEnabled() {
  return FLAG;
}

const ctl = { off: false };
const stats = { skipped: 0 };

/** Wrap `renderer.renderBufferDirect`. Returns true when installed (or already). */
export function installSkipEmptyMultiDraw(renderer, { force = false } = {}) {
  if ((!FLAG && !force) || !renderer || typeof renderer.renderBufferDirect !== "function") return false;
  if (renderer.__hbSkipEmptyMultiDraw) return true;
  const orig = renderer.renderBufferDirect;
  renderer.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    if (object && object.isBatchedMesh === true && object._multiDrawCount === 0 && !ctl.off) {
      stats.skipped += 1;
      return;
    }
    return orig.call(this, camera, scene, geometry, material, object, group);
  };
  Object.defineProperty(renderer, "__hbSkipEmptyMultiDraw", { value: orig, configurable: true });
  if (typeof window !== "undefined") {
    try {
      window.__skipEmptyMultiDraw = {
        enabled: true,
        stats,
        get off() { return ctl.off; },
        set off(v) { ctl.off = !!v; },
      };
    } catch (_) {}
  }
  return true;
}

/** Test hook: restore the wrapped method. */
export function uninstallSkipEmptyMultiDraw(renderer) {
  const orig = renderer && renderer.__hbSkipEmptyMultiDraw;
  if (!orig) return;
  renderer.renderBufferDirect = orig;
  delete renderer.__hbSkipEmptyMultiDraw;
  ctl.off = false;
}

export function getSkipEmptyMultiDrawStats() {
  return { ...stats };
}

/** Test seam. */
export function __setSkipEmptyMultiDrawOffForTest(v) { ctl.off = !!v; }
