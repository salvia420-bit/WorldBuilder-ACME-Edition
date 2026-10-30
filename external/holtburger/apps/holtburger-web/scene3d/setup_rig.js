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
