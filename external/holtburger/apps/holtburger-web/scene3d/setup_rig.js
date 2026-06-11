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
    onGeometry,
  } = args;
  if (!conv) return;
  for (const g of conv.groups) {
    const did = g.surfaceDid >>> 0;
    const mat = resolveMaterial(g);
    const m = new THREE.Mesh(g.geometry, mat);
    m.name = `part_${partIndex}_surface_${did.toString(16)}`;
    m.userData = { guid, partIndex, surfaceDid: did };
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
