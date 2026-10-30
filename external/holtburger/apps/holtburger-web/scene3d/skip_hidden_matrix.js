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
  _walkHooks = { proto, method: proto.updateMatrixWorld, isSceneWalk: () => sceneWalk > 0, skipOn: () => ctl.on };
  if (typeof window !== "undefined") {
    try {
      window.__skipHiddenMatrix = {
        enabled: true,
        get on() { return ctl.on; },
        // Turning it back ON is safe at any time; turning it OFF simply resumes
        // three's full walk (stale flags clear on the next forced update).
        set on(v) { ctl.on = !!v; },
        /** Per-frame census of the scene walk over `frames` rAF frames (see walkCensus). */
        census: (frames = 120) => walkCensusFrames(frames),
      };
    } catch (_) {}
  }
  return true;
}

// ---------------------------------------------------------------------------
// WALK CENSUS (fps review 2026-10-19) — what the scene walk spends its visits
// on, so the "freeze the static containers" idea is decided by a number. The
// Scene, worldRoot and the five world groups compose every frame, which sets
// `force` for every node below them; a root freeze can only save the
// `forcedOnly` multiplies (a node that neither composes nor was flagged, i.e.
// recomputed purely because an ancestor forced it) — every `matrixAutoUpdate`
// node, the animated rigs, composes and forces its own subtree anyway. That
// freeze is the opt-in `?freezeWorldRoots` (freeze_world_roots.js), which also
// flags every add()ed child: a node parented without a flag of its own (the
// animated-scenery InstancedMesh at identity) gets its world matrix ONLY from
// the cascade. Armed only for the census window (the counting wrapper is
// installed and removed around it), so it costs nothing otherwise.
// ---------------------------------------------------------------------------
let _walkHooks = null;
const _census = { walks: 0, visited: 0, hidden: 0, composed: 0, multiplied: 0, forcedOnly: 0, frozen: 0 };

/**
 * What the patched method does for a node visited RIGHT NOW, for code that
 * walks a subtree itself and must reproduce it exactly (scene3d/entity_world.js,
 * `?rustEntityWorld`, walks entity rig subtrees):
 *   0 — three's full update: the patch is not installed, the walk is not
 *       rooted at a THREE.Scene, or the live seam is off;
 *   1 — inside a scene walk with skipping on: a node with `visible === false`
 *       and a parent is marked stale (`matrixWorldNeedsUpdate = true`) and its
 *       subtree is not walked;
 *   2 — the walk census is counting: leave every node to the patched method so
 *       that it is counted.
 * Read-only; costs two closure calls.
 */
export function skipHiddenWalkMode() {
  const h = _walkHooks;
  if (h === null) return 0;
  if (h.counting) return 2;
  return h.isSceneWalk() && h.skipOn() ? 1 : 0;
}

/** The installed `Object3D.prototype.updateMatrixWorld` (null when not installed). */
export function skipHiddenMethod() {
  return _walkHooks === null ? null : _walkHooks.method;
}

/** Start counting scene-walk visits. Returns false when the patch is not installed. */
export function startWalkCensus() {
  if (!_walkHooks || _walkHooks.counting) return false;
  const { proto } = _walkHooks;
  const patched = proto.updateMatrixWorld;
  const hooks = _walkHooks;
  for (const k of Object.keys(_census)) _census[k] = 0;
  proto.updateMatrixWorld = function (force) {
    if (hooks.isSceneWalk()) {
      _census.visited += 1;
      if (this.parent === null) _census.walks += 1;
      if (this.visible === false && this.parent !== null && hooks.skipOn()) {
        _census.hidden += 1;
      } else {
        const auto = this.matrixAutoUpdate === true;
        if (auto) _census.composed += 1;
        if ((auto || this.matrixWorldNeedsUpdate || force) && this.matrixWorldAutoUpdate === true) {
          _census.multiplied += 1;
          if (!auto && !this.matrixWorldNeedsUpdate && force) _census.forcedOnly += 1;
        }
        if (!auto && this.matrixWorldAutoUpdate === false) _census.frozen += 1;
      }
    }
    return patched.call(this, force);
  };
  hooks.counting = { patched };
  return true;
}

/** Stop counting; returns the totals since start (null if not counting). */
export function stopWalkCensus() {
  if (!_walkHooks || !_walkHooks.counting) return null;
  _walkHooks.proto.updateMatrixWorld = _walkHooks.counting.patched;
  _walkHooks.counting = null;
  return { ..._census };
}

function walkCensusFrames(frames) {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function" || !startWalkCensus()) { resolve(null); return; }
    let n = 0;
    const tick = () => {
      if (++n <= frames) { requestAnimationFrame(tick); return; }
      const t = stopWalkCensus();
      const per = (v) => +(v / frames).toFixed(1);
      resolve({
        frames,
        walksPerFrame: per(t.walks),
        visitedPerFrame: per(t.visited),
        hiddenSkippedPerFrame: per(t.hidden),
        composedPerFrame: per(t.composed),
        multipliedPerFrame: per(t.multiplied),
        forcedOnlyPerFrame: per(t.forcedOnly),
        frozenPerFrame: per(t.frozen),
      });
    };
    requestAnimationFrame(tick);
  });
}

/** Test hook: restore three's method. */
export function uninstallSkipHiddenMatrix(THREE) {
  const proto = THREE?.Object3D?.prototype;
  if (!proto || !proto.__hbSkipHidden) return;
  if (_walkHooks && _walkHooks.counting) stopWalkCensus();
  _walkHooks = null;
  proto.updateMatrixWorld = proto.__hbSkipHidden;
  delete proto.__hbSkipHidden;
  const sp = THREE.Scene.prototype;
  if (sp.__hbSkipHiddenScene) sp.updateMatrixWorld = sp.__hbSkipHiddenScene;
  else delete sp.updateMatrixWorld;
  delete sp.__hbSkipHiddenScene;
}
