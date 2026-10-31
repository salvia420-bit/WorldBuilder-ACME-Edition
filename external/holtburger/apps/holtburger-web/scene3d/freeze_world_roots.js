// scene3d/freeze_world_roots.js — `?freezeWorldRoots` (fps review 2026-10-19;
// DEFAULT ON since 2026-10-30, `off`/`0`/`false`/`no` opt out). 1070 decision bench
// D1 (batch-R3-D1, 3 reps + A/A, clean box): moving +1.6 fps, real under R1, still /
// tour unchanged; the owner's criterion is overall fps.
//
// three r184's scene walk (Object3D.updateMatrixWorld) recomputes a node's world
// matrix when the node composes itself (matrixAutoUpdate), when it is flagged
// (matrixWorldNeedsUpdate), or when an ancestor did either (`force`). The Scene,
// worldRoot and the five world groups (terrain, buildings, statics, cells,
// entities) never move after init3D, yet they compose every frame, so `force`
// reaches every node under them and each `matrixAutoUpdate = false` node is
// multiplied again for nothing — `forcedOnly` in `__skipHiddenMatrix.census()`
// (41 of 1,151 visits per frame at the laptop spawn, 2026-10-19). Armed, this
// composes those seven containers once and stops them auto-updating: the next
// walk computes their world matrices, and after that the walk no longer forces
// their subtrees. Nodes that compose themselves (the animated rigs) are
// unaffected — they still recompute themselves and force their own children.
//
// EXACT, given the two things the cascade used to cover:
//  - a node parented under the frozen chain needs its world matrix computed:
//    `Object3D.prototype.add` is wrapped to flag the child (three's `add` does
//    not — the cascade made it unnecessary). `attach` computes the child's world
//    matrix itself.
//  - a `matrixAutoUpdate = false` node that changes its `.matrix` must flag
//    itself (three's `updateMatrix()` does). The 2026-10-19 audit of scene3d
//    found every such site calls updateMatrix(), flags, writes its own
//    matrixWorld (occlusion proxies), or lives in a scene of its own
//    (far-terrain bake root, particle / glow / decal scenes).
// `await window.__freezeWorldRoots.verify()` checks this live, in either mode:
// right after the next main-scene render, every visible node whose world matrix
// three maintains must equal parent.matrixWorld × matrix.

/** `?freezeWorldRoots` reader (pure). Default ON; only `off`/`0`/`false`/`no` turn it off. */
export function freezeWorldRootsRequested(search) {
  try {
    const v = (new URLSearchParams(search || "").get("freezeWorldRoots") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
}

const FLAG = freezeWorldRootsRequested(globalThis.location?.search || "");

export function freezeWorldRootsEnabled() {
  return FLAG;
}

const _stats = { frozen: 0, addsFlagged: 0 };

/** Wrap `Object3D.prototype.add` so a newly parented child is flagged for the next walk. */
function _patchAdd(THREE) {
  const proto = THREE.Object3D.prototype;
  if (proto.__hbFreezeAdd) return;
  const orig = proto.add;
  proto.add = function (object) {
    const r = orig.apply(this, arguments);
    // Several arguments: three's add() re-enters (this patched) add per object.
    if (arguments.length === 1 && object && object.parent === this) {
      object.matrixWorldNeedsUpdate = true;
      _stats.addsFlagged += 1;
    }
    return r;
  };
  Object.defineProperty(proto, "__hbFreezeAdd", { value: orig, configurable: true });
}

/**
 * Freeze `roots` (the Scene, worldRoot, the world groups). Each is composed once
 * and flagged, so the next walk computes its world matrix; it then stops
 * auto-updating. Returns the number frozen (0 when the flag is off).
 */
export function freezeWorldRoots(THREE, roots, { force = false } = {}) {
  if ((!FLAG && !force) || !THREE?.Object3D) return 0;
  _patchAdd(THREE);
  let n = 0;
  for (const o of roots || []) {
    if (!o || o.isObject3D !== true) continue;
    if (o.matrixAutoUpdate) o.updateMatrix(); // composes and flags the next walk
    else o.matrixWorldNeedsUpdate = true;
    o.matrixAutoUpdate = false;
    n += 1;
  }
  _stats.frozen += n;
  return n;
}

/** Test hook: restore three's `add`. */
export function __unpatchAddForTest(THREE) {
  const proto = THREE?.Object3D?.prototype;
  if (!proto || !proto.__hbFreezeAdd) return;
  proto.add = proto.__hbFreezeAdd;
  delete proto.__hbFreezeAdd;
}

export function getFreezeWorldRootsStats() {
  return { enabled: FLAG, ..._stats };
}

// ---------------------------------------------------------------------------
// verify — the exactness check (either mode)
// ---------------------------------------------------------------------------

// out = a × b, column-major 4×4 (three's Matrix4.multiplyMatrices order).
function _mul(a, b, out) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    for (let r = 0; r < 4; r++) out[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
  }
  return out;
}

/**
 * Every node the next draw would see (visible chain) whose world matrix three
 * maintains (`matrixWorldAutoUpdate`) must hold matrixWorld == parent.matrixWorld
 * × matrix. A node flagged for the next walk (and its subtree) is `pending`, not
 * a mismatch. Run it right after a walk (see installFreezeWorldRootsSeam).
 * @returns {{checked:number, pending:number, mismatches:number, worst:number, samples:string[]}}
 */
export function verifyWorldMatrices(scene, { eps = 1e-6, limit = 8 } = {}) {
  const res = { checked: 0, pending: 0, mismatches: 0, worst: 0, samples: [] };
  if (!scene || !scene.children) return res;
  const tmp = new Array(16);
  const stack = [];
  for (const c of scene.children) stack.push(c);
  while (stack.length) {
    const o = stack.pop();
    if (o.visible === false) continue;
    if (o.matrixWorldNeedsUpdate === true) { res.pending += 1; continue; }
    if (o.matrixWorldAutoUpdate === true && o.parent) {
      const want = _mul(o.parent.matrixWorld.elements, o.matrix.elements, tmp);
      const got = o.matrixWorld.elements;
      let err = 0;
      for (let i = 0; i < 16; i++) {
        const d = Math.abs(got[i] - want[i]) / Math.max(1, Math.abs(want[i]));
        if (d > err) err = d;
      }
      res.checked += 1;
      if (err > eps) {
        res.mismatches += 1;
        if (err > res.worst) res.worst = err;
        if (res.samples.length < limit) res.samples.push(`${o.name || o.type || "?"} (${err.toExponential(2)})`);
      }
    }
    const ch = o.children;
    for (let i = 0; i < ch.length; i++) stack.push(ch[i]);
  }
  return res;
}

/**
 * `window.__freezeWorldRoots` — installed in either mode so the default can be
 * checked too: `await __freezeWorldRoots.verify()` runs verifyWorldMatrices right
 * after the next render() of `scene` (the walk has just run, nothing has moved).
 */
export function installFreezeWorldRootsSeam(renderer, scene) {
  if (typeof window === "undefined" || !renderer || !scene) return false;
  const verify = (opts) => new Promise((resolve) => {
    const orig = renderer.render;
    let done = false;
    const finish = (r) => { if (done) return; done = true; if (renderer.render === wrapped) renderer.render = orig; resolve(r); };
    const wrapped = function (sceneArg) {
      const r = orig.apply(this, arguments);
      if (sceneArg === scene) finish({ frozen: FLAG, ...verifyWorldMatrices(scene, opts) });
      return r;
    };
    renderer.render = wrapped;
    setTimeout(() => finish(null), 5000);
  });
  try {
    window.__freezeWorldRoots = {
      get enabled() { return FLAG; },
      stats: () => getFreezeWorldRootsStats(),
      verify,
    };
  } catch (_) { return false; }
  return true;
}
