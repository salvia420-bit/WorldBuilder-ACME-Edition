// scene3d/skip_hidden_matrix.js — the per-frame scene-graph matrix walk skips
// invisible subtrees (`?skipHiddenMatrix`, DEFAULT ON, `=off` escape).
// Perf 2026-10-06.
//
// three r184's `scene.updateMatrixWorld()` (run by every renderer.render) walks
// EVERY node, visible or not: ~7,800 at a settled Holtburg, ~2,000-2,500 of them
// hidden (render-culled / occluded NPC rigs, never-drawn part surfaces, interior
// cells outside the render set). The walk is ~3 ms of a ~34 ms 1070 frame.
// Hidden nodes are never drawn (projectObject stops at `visible === false`), so
// their world matrices are only needed again when they are shown.
//
// THE RULE. Inside a walk rooted at a THREE.Scene (renderer.render's
// `scene.updateMatrixWorld()`), a node with `visible === false` (and a parent)
// neither updates itself nor walks its children; it is marked stale (three's own
// `matrixWorldNeedsUpdate`). A direct updateMatrixWorld() on anything else — a detached group, a camera, a light
// target — keeps three's full behaviour. The first walk that finds it visible again recomputes its WHOLE
// subtree (`force = true`), so a rig that walked, or a part re-posed, while
// hidden is exact on the frame it reappears — before projectObject reads it.
//
// SAFETY. `updateWorldMatrix(updateParents, updateChildren)` — what
// getWorldPosition / getWorldQuaternion / Box3.setFromObject / the partFrames
// proxy use — is a different method and still refreshes hidden nodes on demand.
// The only stale read is a DIRECT `.matrixWorld` read of a hidden node; the
// 2026-10-06 audit of scene3d found those only on visible objects (cameras,
// worldRoot, drawn batches, visible nameplate roots), plus the occlusion
// culler's entity box, which refreshes its (hidden) root explicitly.

const FLAG = (() => {
  try {
    const v = (new URLSearchParams(globalThis.location?.search || "").get("skipHiddenMatrix") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
})();

export function skipHiddenMatrixEnabled() {
  return FLAG;
}

/** Patch `THREE.Object3D.prototype.updateMatrixWorld` once. Returns true if installed. */
export function installSkipHiddenMatrix(THREE, { force = false } = {}) {
  if ((!FLAG && !force) || !THREE?.Object3D) return false;
  const proto = THREE.Object3D.prototype;
  if (proto.__hbSkipHidden) return true;
  const orig = proto.updateMatrixWorld;
  // Only inside a walk rooted at a THREE.Scene (what renderer.render runs): a
  // direct updateMatrixWorld() on a detached group, a camera or a light target
  // keeps three's full behaviour. (`force` cannot be the gate — every
  // matrixAutoUpdate node marks itself dirty each frame and forces its children,
  // so nearly every call in the walk is forced.)
  let sceneWalk = 0;
  const ctl = { on: true }; // live A/B seam: window.__skipHiddenMatrix.on = false
  proto.updateMatrixWorld = function (force) {
    if (sceneWalk > 0 && this.visible === false && this.parent !== null && ctl.on) {
      // three's own "recompute me and force my children" flag — the first walk
      // that finds this node visible again rebuilds its whole subtree. (Not a
      // new property: adding fields to scene nodes multiplies V8 hidden classes
      // in three's hot paths.)
      this.matrixWorldNeedsUpdate = true;
      return;
    }
    return orig.call(this, force);
  };
  const sceneProto = THREE.Scene.prototype;
  const sceneOwn = Object.prototype.hasOwnProperty.call(sceneProto, "updateMatrixWorld") ? sceneProto.updateMatrixWorld : null;
  sceneProto.updateMatrixWorld = function (force) {
    sceneWalk += 1;
    try { return proto.updateMatrixWorld.call(this, force); } finally { sceneWalk -= 1; }
  };
  Object.defineProperty(proto, "__hbSkipHidden", { value: orig, configurable: true });
  Object.defineProperty(sceneProto, "__hbSkipHiddenScene", { value: sceneOwn, configurable: true });
  if (typeof window !== "undefined") {
    try {
      window.__skipHiddenMatrix = {
        enabled: true,
        get on() { return ctl.on; },
        // Turning it back ON is safe at any time; turning it OFF simply resumes
        // three's full walk (stale flags clear on the next forced update).
        set on(v) { ctl.on = !!v; },
      };
    } catch (_) {}
  }
  return true;
}

/** Test hook: restore three's method. */
export function uninstallSkipHiddenMatrix(THREE) {
  const proto = THREE?.Object3D?.prototype;
  if (!proto || !proto.__hbSkipHidden) return;
  proto.updateMatrixWorld = proto.__hbSkipHidden;
  delete proto.__hbSkipHidden;
  const sp = THREE.Scene.prototype;
  if (sp.__hbSkipHiddenScene) sp.updateMatrixWorld = sp.__hbSkipHiddenScene;
  else delete sp.updateMatrixWorld;
  delete sp.__hbSkipHiddenScene;
}
