// scene3d/setup_rig.js — A9-Stage2 (unification survey 2026-06-11).
//
// Retail funnels EVERY visible object — creature, item, static, building
// part, particle — through ONE class pair: `CPartArray` (parts + sequence
// + scale + pals + lights) over `CSetup` (immutable DAT template). Our JS
// consumption layer had that single pipeline split across ~5 sites, so a
// fix to part-transform / per-surface-mesh wiring in one path didn't reach
// the others (A9 §3 divergence #2, SPLIT-BRAIN). This module is the single
// JS owner of the part-array → Object3D construction *transform semantics*:
//
//   - `applyRestPoseFrame`  — composes a part's rest-pose (origin +
//     AC-ordered quaternion) onto its part Group, mirroring retail
//     `CPartArray::UpdateParts` (`Frame::combine(parts[i].pos.frame, …)`,
//     acclient.c:326601). Anim frames are MODEL-SPACE per part (flat, no
//     runtime parent chain) so the rest frame is just the part's local
//     transform; the AnimationMixer overrides it per frame during playback.
//   - `buildPartSurfaceMeshes` — the per-part per-surface `THREE.Mesh`
//     build loop shared by entity spawn AND the in-place obj-desc hot-swap
//     (retail `CPhysicsPart::SetPart`/`UpdateParts`). Byte-identical to the
//     two formerly-duplicated entity loops.
//   - `createPartFramesProxy` — the live world-frame accessor the particle
//     runtime + child-attach paths read as `parent.partFrames[i]`.
//
// Acceptance bar (A9 §4 Stage 2): **byte-identical transforms** vs the
// pre-extraction inline code. The escape hatch `?rigModule=off` keeps the
// legacy inline paths live in the consumers, so a regression is one flag
// away from rollback. `test_a9_stage2_setup_rig.mjs` pins old-vs-new
// transform equality on a fixture setup.
//
// Seams (A9 §5): A5 owns the per-frame playback that DRIVES the part Groups
// this module creates; A10 owns the material/Surface decisions (passed in
// via the `resolveMaterial` callback — this module makes NO material
// decisions); A11 consumes `root.partFrames` (this module preserves that
// contract verbatim).

// `?rigMeshAlias` (lane B, 2026-10-26) reads its flag through the scene-core
// reader (default off, `=on` opts in). scene_core.js is a leaf module.
import { rustFlag } from "./rust/scene_core.js";

/**
 * Read the `?rigModule=off` escape hatch. Default ON (pure refactor with a
 * byte-identical-transform acceptance bar) — only the literal `off` (any
 * case) disables it, reverting consumers to their inline legacy paths.
 * Mirrors the reader shape of `readEntityLightsFlag` (entities.js:32).
 *
 * @returns {boolean} true when the unified rig module is active.
 */
export function readRigModuleFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("rigModule");
    return !(typeof v === "string" && v.toLowerCase() === "off");
  } catch (_) {
    return true;
  }
}

// ?frozenPartFast (2026-10-20, improvement hunt entities-fx-1/-2; DEFAULT ON;
// `=off`/`0`/`false`/`no` escape). ONE switch for three bit-identical shortcuts
// on the part-frame read path:
//   - here, `createPartFramesProxy`: a FROZEN part (statics.js
//     `_freezeStaticScriptAnchor` clears both auto-update flags on the whole
//     anchor subtree) is read straight off its matrixWorld with no
//     updateWorldMatrix walk — the walk only recomposes the ancestors
//     (staticsGroup / worldRoot / Scene) and never rewrites a part whose
//     matrixWorldAutoUpdate is false. Any other part does ONE
//     updateWorldMatrix(true,false) and decomposes matrixWorld once, where
//     getWorldPosition + getWorldQuaternion each re-walked the chain (three r184
//     Object3D.js: both call updateWorldMatrix(true,false) again) — three walks
//     for one frame;
//   - particle_manager.js `rp6CullSphere`: a frozen anchor's cull centre is
//     cached per emitter (keyed on the anchor's `__scriptEpoch`);
//   - particle_emitter.js `updateParticles`: the parent-local anchor is
//     resolved once per tick instead of once per live particle.
// bf474c67 gave RP6 a frozen-matrixWorld read, but rp6TrueSphere's part-frame
// branch runs first, so every part-anchored static emitter — all of Linvak's
// drizzle (hooks on part 0) — still went through this proxy's three walks on
// every recheck (refuter's node bench, 5,000 frozen anchors: 7.6 ms per
// recheck through the proxy, 0.8 ms through the frozen matrixWorld read).
// Each module reads the flag once (memoised) — the particle modules keep their
// own reader because test_particles.mjs concatenates them without this file.
let _FROZEN_PART_FAST_ON = null;
export function frozenPartFastEnabled() {
  if (_FROZEN_PART_FAST_ON === null) {
    try {
      const v = (new URLSearchParams(globalThis.location?.search || "").get("frozenPartFast") || "").trim().toLowerCase();
      _FROZEN_PART_FAST_ON = !(v === "off" || v === "0" || v === "false" || v === "no");
    } catch (_) {
      _FROZEN_PART_FAST_ON = true;
    }
  }
  return _FROZEN_PART_FAST_ON;
}
/** Test/A-B seam (`null` re-reads the URL on next use). */
export function setFrozenPartFastFlag(on) { _FROZEN_PART_FAST_ON = on == null ? null : !!on; }

// Throwaway scale for the proxy's matrixWorld decompose (nothing reads it).
let _decomposeScale = null;

/**
 * Compose a part's rest-pose frame onto its part Group. Mirrors the inline
 * block at entities.js spawn (the `if (hasRestPose) { … }` body) and the
 * building hinge-frame application (buildings.js `hingeWrapper`): both set
 * `position` from a flat origin triple and a quaternion from AC wire order
 * `(qw, qx, qy, qz)` reordered to three.js `(qx, qy, qz, qw)`.
 *
 * partMeshes ship part-LOCAL (no placement baked in); the rest frame
 * composes against the entity root the same way PhatSDK's
 * `CPartArray::UpdateParts` composes `entity_world.combine(anim_frame[i])`.
 * During cycle playback the AnimationMixer overrides these values
 * frame-by-frame with the model-space cycle keyframes. With
 * `hasRestPose=false` (old wasm bundle without the getters), the Group
 * stays at identity — matches pre-fix behaviour.
 *
 * @param {object} THREE  three.js namespace (injected; module makes no
 *                        top-level three import so the headless harness can
 *                        pass a minimal fake).
 * @param {object} partGroup  the `THREE.Group` to pose (mutated in place).
 * @param {ArrayLike<number>} origins  flat xyz triples (length ≥ p*3+3).
 * @param {ArrayLike<number>} orientations  flat (qw,qx,qy,qz) quads.
 * @param {number} p  part index.
 * @param {boolean} hasRestPose  when false, leaves the Group at identity.
 */
export function applyRestPoseFrame(THREE, partGroup, origins, orientations, p, hasRestPose) {
  if (!hasRestPose) return;
  partGroup.position.set(
    origins[p * 3 + 0],
    origins[p * 3 + 1],
    origins[p * 3 + 2]
  );
  // AC wire order is (qw, qx, qy, qz); three.js wants (qx, qy, qz, qw).
  const qw = orientations[p * 4 + 0];
  const qx = orientations[p * 4 + 1];
  const qy = orientations[p * 4 + 2];
  const qz = orientations[p * 4 + 3];
  partGroup.quaternion.set(qx, qy, qz, qw);
}

/**
 * Build the per-surface `THREE.Mesh` leaves under one part Group. Shared by
 * the entity spawn loop and the in-place obj-desc hot-swap (retail
 * `CPhysicsPart::SetPart` swaps the gfxobj in place, never rebuilds the
 * part array — A9 §3 divergence #3 / R8). Byte-identical to the two
 * formerly-duplicated entity loops: same mesh name (`part_${p}_surface_${hex}`),
 * same `userData`, same shadow-cast gate, same `partGroup.add` + geometry
 * registration order.
 *
 * The caller owns ALL material + asset decisions (A10 seam): `resolveMaterial`
 * receives the surface-group object and returns the resolved material; this
 * module never touches the material cache or Surface flags.
 *
 * @param {object} THREE  three.js namespace (injected).
 * @param {object} args
 * @param {object} args.partGroup  destination `THREE.Group`.
 * @param {object} args.conv  `{ groups: [{ geometry, surfaceDid, … }], … }`.
 * @param {number} args.partIndex  part index `p`.
 * @param {number} args.guid  entity guid (goes into each mesh `userData`).
 * @param {(g: object) => object} args.resolveMaterial  per-surface material.
 * @param {boolean} args.castShadow  when true, gate each mesh's `castShadow`
 *                  through `materialCanCastShadow`.
 * @param {(mat: object) => boolean} args.materialCanCastShadow  shadow predicate.
 * @param {(mat: object) => boolean} [args.materialRendersNothing]  predicate for
 *                  surfaces that can never put a pixel on screen (fully
 *                  translucent by authored surface data). Injected for the same
 *                  reason as `materialCanCastShadow`: this module never reads
 *                  Surface flags itself. Matching meshes are BUILT but left
 *                  `visible = false` — see the note at the assignment.
 * @param {(geometry: object) => void} [args.onGeometry]  geometry-registration hook.
 */
export function buildPartSurfaceMeshes(THREE, args) {
  const {
    partGroup,
    conv,
    partIndex,
    guid,
    resolveMaterial,
    castShadow,
    materialCanCastShadow,
    materialRendersNothing,
    onGeometry,
  } = args;
  if (!conv) return;
  for (const g of conv.groups) {
    const did = g.surfaceDid >>> 0;
    const mat = resolveMaterial(g);
    const m = new THREE.Mesh(g.geometry, mat);
    m.name = `part_${partIndex}_surface_${did.toString(16)}`;
    m.userData = { guid, partIndex, surfaceDid: did };
    // 2026-08-06 — a fully-translucent surface (authored translucency 1, e.g.
    // 0x08000015) can never be seen, so submitting it is a pure no-op draw:
    // 76 of a measured 519-draw frame at Nanto were exactly this.
    //
    // HIDDEN, NOT SKIPPED. The mesh stays in the graph because consumers index
    // the rig by part and by mesh name — limbs.js resolves parts via
    // `userData.partIndex` (see its note at :359), dismember/recolor walk the
    // same children — so dropping the node would silently change rig topology
    // to save a traverse step. `visible = false` costs nothing at draw time:
    // three skips invisible objects in projectObject before they ever reach a
    // render list.
    if (typeof materialRendersNothing === "function" && materialRendersNothing(mat)) {
      m.visible = false;
    }
    // Visual-fidelity Phase 0.1 — entities cast shadows. receiveShadow
    // stays false (animated rig → shimmer); translucent/additive surfaces
    // self-skip via the material-flag predicate. Phase 3.3 CSM path
    // enables casting on the same meshes.
    if (castShadow && typeof materialCanCastShadow === "function") {
      m.castShadow = materialCanCastShadow(mat);
    }
    partGroup.add(m);
    if (typeof onGeometry === "function") onGeometry(g.geometry);
  }
}

/**
 * Build the live, lazily-evaluated `partFrames` world-frame accessor the
 * particle runtime + child-attach paths read as `parent.partFrames[i]`
 * (particle_emitter.js:336, particle.js:179, setParenting:180). The entity
 * rig is a bare `THREE.Group`; without this every non-root part index
 * silently root-fell-back to the model origin.
 *
 * Returns a Proxy over an empty array that, per integer-index read, returns
 * `{ position, quaternion }` in WORLD space (composes root ⊗ local) for the
 * part Group at that index — the consumer treats it as a drop-in for
 * `parent.position` / `parent.quaternion`, which are world, so the frames
 * must be world too. `0xFFFFFFFF` / out-of-range / undefined → undefined
 * (handled as root anchoring upstream). Frame objects are cached per index
 * so repeated reads don't allocate.
 *
 * @param {object} THREE  three.js namespace (injected).
 * @param {Array<object>} parts  the part Groups (read live; length tracked).
 * @returns {Proxy} the `partFrames` accessor.
 */
export function createPartFramesProxy(THREE, parts) {
  const partFrameCache = [];
  return new Proxy([], {
    get(_target, prop) {
      if (prop === "length") return parts.length;
      // Only intercept integer-index reads; anything else (Symbol, string
      // method names) returns undefined so `&&` guards short out.
      const idx = typeof prop === "string" ? Number(prop) : NaN;
      if (!Number.isInteger(idx) || idx < 0 || idx >= parts.length) {
        return undefined;
      }
      const part = parts[idx];
      if (!part) return undefined;
      let frame = partFrameCache[idx];
      if (!frame) {
        frame = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
        partFrameCache[idx] = frame;
      }
      // World-space (composes root ⊗ local). updateWorldMatrix(true,…)
      // ensures the part's world matrix reflects this frame's mixer pose
      // even if the renderer hasn't flushed the scene graph yet.
      // ?frozenPartFast (see the reader above): a frozen part skips the walk
      // (it cannot change its matrixWorld), anything else walks ONCE; both then
      // decompose matrixWorld once. Bit-identical to the three-walk path below:
      // decompose writes position from elements 12-14 exactly as
      // setFromMatrixPosition does, and the quaternion is the same decompose
      // getWorldQuaternion runs. A part without a real matrixWorld (the
      // headless fake THREE in test_a9_stage2_setup_rig.mjs) keeps the old calls.
      if (part.matrixWorld && typeof part.matrixWorld.decompose === "function" && frozenPartFastEnabled()) {
        if (part.matrixWorldAutoUpdate !== false || part.matrixAutoUpdate !== false) {
          part.updateWorldMatrix(true, false);
        }
        part.matrixWorld.decompose(frame.position, frame.quaternion,
          _decomposeScale || (_decomposeScale = new THREE.Vector3()));
        return frame;
      }
      part.updateWorldMatrix(true, false);
      part.getWorldPosition(frame.position);
      part.getWorldQuaternion(frame.quaternion);
      return frame;
    },
    has(_target, prop) {
      const idx = typeof prop === "string" ? Number(prop) : NaN;
      return Number.isInteger(idx) && idx >= 0 && idx < parts.length;
    },
  });
}

// ---------------------------------------------------------------------------
// ?rigMeshAlias (2026-10-26, lane B; DEFAULT OFF, `=on` opts in — an owner
// decision, see docs/2026-10-26-rust-rig.md §10).
//
// WHAT. A rig part's surface meshes sit at the part's origin: identity local
// transform, so three's scene walk computes each mesh's world matrix as
// `part.matrixWorld × I` — a compose of the identity into `mesh.matrix` and a
// 4×4 multiply written into the mesh's own `matrixWorld` array, per mesh, per
// frame. Entity rigs are most of the scene graph and those per-mesh writes are
// most of their walk (lane doc "Measurements"). Under the flag each part walks
// its own children (an own `updateMatrixWorld`, below): an identity mesh SHARES
// the part's `matrixWorld` object (`mesh.matrixWorld === part.matrixWorld`,
// mesh matrixAutoUpdate / matrixWorldAutoUpdate off, so neither three's walk
// nor updateWorldMatrix writes it through the mesh) and costs a few checks
// instead of a compose + multiply + 16 stores.
//
// EXACT AT EVERY WALK. `P × I` equals `P` bit for bit when `P` holds no −0
// and no ±Inf/NaN (×1 and +0 summands are exact; a −0 entry can come out +0,
// an Inf times 0 is NaN). So each walk checks the part's fresh world matrix
// ("clean") and, if it is not clean, gives that part's meshes their own
// matrices again for the frame (three's path). The mesh's local `matrix` is
// composed once, from the exact identity, when it is aliased — what three
// recomposes every frame.
//
// WHICH MESHES. A plain `THREE.Mesh` (not skinned / instanced / batched) with
// no children, visible when first aliased, matrixAutoUpdate and
// matrixWorldAutoUpdate on, no pivot, no own or class override of
// updateMatrix / updateMatrixWorld / updateWorldMatrix, and an EXACT identity
// local transform: position (+0, +0, +0), quaternion (+0, +0, +0, 1), scale
// (1, 1, 1). Re-validated every walk (position, scale, pivot, flags, the
// shared object, no children) plus a hook on the mesh's quaternion and Euler
// change callbacks (any rotation write — dismember's dislocation, applyMatrix4
// — drops the alias); the part's `childremoved` event drops it the moment the
// mesh is detached or reparented (remove / attach / add elsewhere / clear /
// bulk_child_remove all fire it), before anything can walk it elsewhere. Any
// doubt → that mesh walks three's way, from its own matrices, this frame.
//
// WHAT DIFFERS (all of it): a mesh's `matrixWorld` IS its part's between walks
// too, so a reader that refreshes the mesh (updateWorldMatrix / Box3 /
// getWorldPosition) sees `P` where three computes `P × I` — equal unless a
// refresh outside the walk left a −0 in `P` (never seen: worldRoot's −π/2
// rotation leaves no exact zeros in a rig world matrix); a HIDDEN aliased mesh
// tracks its part where three leaves its matrix at the last visible walk (only
// readers that refresh it, or discard hidden hits, look at it); and a reader
// that does not refresh sees the part's matrix as of its last refresh rather
// than the mesh's as of the last walk (no such reader inside the frame —
// picking runs between frames). `Object3D.copy` / `clone` of an aliased mesh
// would copy the auto-update flags off (nothing clones rig meshes). Census
// tools (`__skipHiddenMatrix.census`) do not see the part subtrees this walks.
// ---------------------------------------------------------------------------

let _rmaFlag = null;
/** `?rigMeshAlias` (read once; `__setRigMeshAliasForTest` overrides). */
export function rigMeshAliasEnabled() {
  if (_rmaFlag === null) {
    try { _rmaFlag = rustFlag("rigMeshAlias", false); } catch (_) { _rmaFlag = false; }
  }
  return _rmaFlag;
}
/** Test seam: force `?rigMeshAlias` (`undefined` re-reads the flag). */
export function __setRigMeshAliasForTest(on) { _rmaFlag = on === undefined ? null : !!on; }

const _rmaStats = {
  parts: 0, // parts walking their own children
  aliased: 0, // alias events (a mesh starting to share its part's matrixWorld)
  unaliased: 0, // alias drops (validation failed, detached, flag off)
  unclean: 0, // walks where a part's world matrix held a −0 / non-finite entry
  shared: 0, // mesh visits served by the alias (no compose / multiply)
  delegated: 0, // child visits handed to three
};
/** Diag snapshot (`window.__rigMeshAlias.stats()`). */
export function rigMeshAliasStats() {
  return { enabled: rigMeshAliasEnabled(), ..._rmaStats };
}

// No −0, no ±Inf, no NaN: then `P × I` (three's multiplyMatrices) is `P`.
function _rmaWorldClean(e) {
  for (let i = 0; i < 16; i += 1) {
    const v = e[i];
    if (v === 0) {
      if (1 / v < 0) return false; // −0
    } else if (!(v - v === 0)) {
      return false; // ±Inf / NaN
    }
  }
  return true;
}

function _rmaCandidate(O3D, m) {
  if (m.isMesh !== true || m.isSkinnedMesh === true || m.isInstancedMesh === true || m.isBatchedMesh === true) return false;
  if (m.visible === false || m.children.length !== 0 || m.pivot !== null) return false;
  if (m.matrixAutoUpdate !== true || m.matrixWorldAutoUpdate !== true) return false;
  if (m.updateMatrixWorld !== O3D.updateMatrixWorld || m.updateMatrix !== O3D.updateMatrix ||
      m.updateWorldMatrix !== O3D.updateWorldMatrix) return false;
  const p = m.position;
  const q = m.quaternion;
  const s = m.scale;
  if (!q || q.isQuaternion !== true || !m.rotation || m.rotation.isEuler !== true) return false;
  return Object.is(p.x, 0) && Object.is(p.y, 0) && Object.is(p.z, 0) &&
    Object.is(q._x, 0) && Object.is(q._y, 0) && Object.is(q._z, 0) && q._w === 1 &&
    s.x === 1 && s.y === 1 && s.z === 1;
}

// Start sharing `part`'s matrixWorld. First time per mesh: the alias fields
// (fixed order, one hidden-class transition) and the rotation-write hooks.
function _rmaAlias(m, part) {
  if (m.__rmaSeen !== true) m.__rmaSeen = true;
  if (m.__rmaOwn === undefined) {
    m.__rmaPart = null;
    m.__rmaOwn = m.matrixWorld;
    m.__rmaDirty = false;
    const q = m.quaternion;
    const r = m.rotation;
    const qPrev = q._onChangeCallback;
    const rPrev = r._onChangeCallback;
    q._onChange(function rmaQuaternionChanged() {
      m.__rmaDirty = true;
      qPrev.call(q);
    });
    r._onChange(function rmaRotationChanged() {
      m.__rmaDirty = true;
      rPrev.call(r);
    });
  }
  // What three's walk does to this mesh this frame: compose (from the exact
  // identity) into `matrix`, then multiply — the product IS the part's (clean)
  // world matrix — and clear the flag.
  m.updateMatrix();
  m.__rmaDirty = false;
  m.__rmaPart = part;
  m.matrixWorld = part.matrixWorld;
  m.matrixAutoUpdate = false;
  m.matrixWorldAutoUpdate = false;
  m.matrixWorldNeedsUpdate = false;
  _rmaStats.aliased += 1;
}

// Back to the mesh's own matrixWorld (holding the shared values) and three's
// flags. A flag someone else changed while aliased is left as they set it.
function _rmaUnalias(m) {
  const own = m.__rmaOwn;
  if (m.matrixWorld !== own) {
    own.copy(m.matrixWorld);
    m.matrixWorld = own;
  }
  if (m.matrixAutoUpdate === false) m.matrixAutoUpdate = true;
  if (m.matrixWorldAutoUpdate === false) m.matrixWorldAutoUpdate = true;
  m.__rmaPart = null;
  _rmaStats.unaliased += 1;
}

function _rmaChildRemoved(event) {
  const c = event.child;
  if (c && c.__rmaPart === this) _rmaUnalias(c);
}

let _rmaWalk = null;
let _rmaWalkProto = null;
// The part's own updateMatrixWorld: three r184 Object3D.updateMatrixWorld for
// the part itself (a hidden part goes to three's — skip_hidden_matrix-patched
// — method, which alone knows whether this is a scene walk), then its
// children: aliased meshes re-validated and served by the alias, new identity
// meshes aliased, everything else handed to its own updateMatrixWorld exactly
// as three's loop does.
function _rmaWalkFor(O3D) {
  if (_rmaWalk !== null && _rmaWalkProto === O3D) return _rmaWalk;
  _rmaWalkProto = O3D;
  _rmaWalk = function rigMeshAliasPartUpdateMatrixWorld(force) {
    if (this.visible === false) {
      // three's (patched) method: in a scene walk it marks the part stale and
      // stops; otherwise (a direct call) it updates the part and walks the
      // children, where an aliased mesh writes nothing. If that update left a
      // −0 / non-finite entry, those meshes get three's own product now.
      O3D.updateMatrixWorld.call(this, force);
      if (this.matrixWorldNeedsUpdate === false && !_rmaWorldClean(this.matrixWorld.elements)) {
        _rmaStats.unclean += 1;
        const ch = this.children;
        for (let i = 0, l = ch.length; i < l; i += 1) {
          const c = ch[i];
          if (c.__rmaPart === this) {
            _rmaUnalias(c);
            c.updateMatrixWorld(true);
          }
        }
      }
      return;
    }
    if (this.matrixAutoUpdate) this.updateMatrix();
    if (this.matrixWorldNeedsUpdate || force) {
      if (this.matrixWorldAutoUpdate === true) {
        if (this.parent === null) this.matrixWorld.copy(this.matrix);
        else this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
      }
      this.matrixWorldNeedsUpdate = false;
      force = true;
    }
    const mw = this.matrixWorld;
    // Clean = the alias is on and P × I === P bit for bit: no −0, no ±Inf /
    // NaN (inlined: a call per part here measured as most of the saving).
    let clean = (_rmaFlag ?? rigMeshAliasEnabled()) === true;
    if (clean) {
      const e = mw.elements;
      for (let k = 0; k < 16; k += 1) {
        const v = e[k];
        if (v === 0 ? 1 / v < 0 : !(v - v === 0)) {
          clean = false;
          _rmaStats.unclean += 1;
          break;
        }
      }
    }
    // A mesh is offered the alias on the first walk that meets it; one that
    // did not qualify (or lost it) is re-tested on one walk in eight
    // (staggered by index) — it walks three's way meanwhile, which is exact,
    // and the test is the expensive part for meshes that never qualify.
    const tick = (this.__rmaTick = (this.__rmaTick + 1) | 0);
    let shared = 0;
    let delegated = 0;
    const children = this.children;
    for (let i = 0, l = children.length; i < l; i += 1) {
      const c = children[i];
      if (c.__rmaPart === this) {
        const p = c.position;
        const sc = c.scale;
        // Per-walk re-validation (inlined). `p.x === 0` also accepts −0: with
        // a clean P the WORLD matrix of a −0-positioned mesh is still P bit
        // for bit; only its unread local matrix would hold +0 where three
        // composes −0 (lane doc §10).
        if (clean && c.__rmaDirty === false && c.matrixWorld === mw &&
            c.matrixAutoUpdate === false && c.matrixWorldAutoUpdate === false &&
            p.x === 0 && p.y === 0 && p.z === 0 && sc.x === 1 && sc.y === 1 && sc.z === 1 &&
            c.pivot === null && c.children.length === 0) {
          // Visible: three would compose the identity and multiply — the
          // shared matrix already is that product. Hidden: three's method
          // decides (skip + mark in a scene walk), and with the flags off it
          // writes nothing.
          if (c.visible === false) c.updateMatrixWorld(force);
          else c.matrixWorldNeedsUpdate = false;
          shared += 1;
          continue;
        }
        _rmaUnalias(c);
      } else if (clean && c.isMesh === true && (c.__rmaSeen !== true || ((tick + i) & 7) === 0)) {
        if (_rmaCandidate(O3D, c)) {
          _rmaAlias(c, this);
          shared += 1;
          continue;
        }
        c.__rmaSeen = true;
      }
      delegated += 1;
      c.updateMatrixWorld(force);
    }
    _rmaStats.shared += shared;
    _rmaStats.delegated += delegated;
  };
  return _rmaWalk;
}

/**
 * ?rigMeshAlias: give a rig part Group the alias walk (EntityInstance
 * constructor). Only a part that walks like a plain Object3D qualifies.
 * Returns true when installed (false when the flag is off).
 * @param {object} THREE  three.js namespace (injected).
 * @param {object} part  a part Group (`inst.parts[i]`).
 */
export function installRigMeshAlias(THREE, part) {
  if (!rigMeshAliasEnabled() || !part || part.isObject3D !== true) return false;
  const O3D = THREE && THREE.Object3D && THREE.Object3D.prototype;
  if (!O3D) return false;
  const walk = _rmaWalkFor(O3D);
  if (part.updateMatrixWorld === walk) return true;
  if (Object.prototype.hasOwnProperty.call(part, "updateMatrixWorld") || part.updateMatrixWorld !== O3D.updateMatrixWorld) return false;
  if (typeof part.addEventListener !== "function") return false;
  part.__rmaTick = 0;
  part.updateMatrixWorld = walk;
  part.addEventListener("childremoved", _rmaChildRemoved);
  _rmaStats.parts += 1;
  if (_rmaStats.parts === 1 && typeof window !== "undefined" && window && !window.__rigMeshAlias) {
    try { window.__rigMeshAlias = { stats: rigMeshAliasStats }; } catch (_) { /* diag only */ }
  }
  return true;
}

/** True when `mesh` currently shares its part's matrixWorld (diag / tests). */
export function rigMeshAliased(mesh) {
  return !!mesh && !!mesh.__rmaPart && mesh.matrixWorld === mesh.__rmaPart.matrixWorld;
}
