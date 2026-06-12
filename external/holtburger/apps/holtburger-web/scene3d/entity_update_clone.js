// A15-Q2 (2026-06-11 unification survey, Stage Q2) — ONE EntityUpdate
// clone/field schema for the dual-renderer seam.
//
// Background (A15 §3 row 2): the wasm `EntityUpdate` field schema was
// hand-copied ~5× across the two renderer paths —
//   - `toMeta`                   (scene3d/loop.js, 3D spawn snapshot)
//   - `__scene3dCloneEntityUpdate` (index.html, 3D pre-init backlog clone)
//   - `cloneEntitySpawn`         (index.html, 2D pre-liveScene deferred spawn)
//   - `metaFromSpawn`            (index.html, 2D derived render-meta)
// — each a slightly different subset. The backlog clone in particular
// MISSED fields the LIVE 3D dispatcher reads:
//   - `isAutonomous`        (loop.js dispatchOne KIND_MOTION, ~:2098) — a
//     backlog-replayed motion with no `isAutonomous` key reads
//     `!!undefined === false`, misclassifying a client-predicted gait echo
//     as a server-FORCED pose.
//   - `physicsTranslucency` (loop.js toMeta / entities.js spawn, ~:1642) —
//     object-level translucency lost on backlog-replayed spawns.
//   - `motionSpeed`         (loop.js KIND_MOTION / KIND_MOTION_ACTION,
//     ~:2115/:2149) — per-motion playback speed lost (defaults to 1.0).
//
// This module is the single source of truth for "snapshot a wasm-bindgen
// `EntityUpdate` into a plain, self-contained JS object that survives the
// `.free()` at the end of the drain". It is a PURE function module: no
// DOM, no wasm, no `window` — importable from both `index.html` (the 2D
// host) and `scene3d/loop.js` (the 3D path), and unit-testable headless.
//
// The returned object is a strict SUPERSET of all four legacy shapes, so
// every existing consumer keeps working when handed the unified clone
// (extra keys are ignored by the spawn/velocity/motion arms). The 2D
// `metaFromSpawn` still DERIVES its render-meta (`category`,
// `hasSubstitutions`, null-for-empty arrays) from this raw snapshot; that
// derivation is renderer-specific and stays at its call site.
//
// Wiring is behind `?unifiedClone=on` (default-off); off = the legacy
// per-site clones. See docs/url-flags.md.

// Shared empty Uint32Array sentinel for the (overwhelmingly common)
// no-substitution case, mirroring loop.js `_emptyU32` so the unified
// clone makes the same number of allocations as `toMeta` did.
const _EMPTY_U32 = new Uint32Array(0);

// Default Uint32Array copier: returns the shared empty sentinel for
// null / zero-length sources, else a fresh right-sized copy. The
// wasm-bindgen Vec<u32> getters return views over linear memory that
// grows on later allocations, so a copy is mandatory to make the clone
// self-contained across `await`s and `.free()`.
//
// Callers (loop.js) may pass an `opts.sliceU32(src, slot)` to reuse a
// scratch-backed copier (`_sliceFromScratch`) without this module taking
// a dependency on it; `slot` is 0=modelChanges, 1=textureChanges,
// 2=subPalettes.
function _copyU32(src) {
  if (!src) return _EMPTY_U32;
  const n = src.length | 0;
  if (n === 0) return _EMPTY_U32;
  return Uint32Array.from(src);
}

/**
 * Snapshot a wasm-bindgen `EntityUpdate` into a plain superset JS object.
 *
 * @param {object} upd  the wasm-bindgen `EntityUpdate` (or any object
 *                      exposing the same getters; the headless test feeds
 *                      a plain object).
 * @param {object} [opts]
 * @param {(src:any, slot:number)=>Uint32Array} [opts.sliceU32]  optional
 *        Uint32Array copier (defaults to a plain right-sized copy). loop.js
 *        passes its scratch-backed `_sliceFromScratch` to preserve that
 *        micro-optimization.
 * @returns {object} self-contained plain clone; safe to retain across
 *        `await`s and after the source handle is `.free()`d.
 */
export function cloneEntityUpdate(upd, opts) {
  const slice = (opts && opts.sliceU32) || ((src) => _copyU32(src));
  const modelId = (upd.modelId ?? 0) >>> 0;
  return {
    // --- dispatch discriminator + identity ---------------------------
    kind: upd.kind,
    guid: (upd.guid ?? 0) >>> 0,
    modelId,
    // `setupId` alias: the 3D rig builder (toMeta consumer) reads
    // `meta.setupId`; it is identical to `modelId` for spawns.
    setupId: modelId,
    landblockId: (upd.landblockId ?? 0) >>> 0,
    // --- wire position / orientation (kind 0/1) ----------------------
    x: upd.x ?? 0,
    y: upd.y ?? 0,
    z: upd.z ?? 0,
    qw: upd.qw ?? 1,
    qx: upd.qx ?? 0,
    qy: upd.qy ?? 0,
    qz: upd.qz ?? 0,
    // --- weenie description / render meta (kind SPAWN/META_REFRESH) ---
    wcid: (upd.wcid ?? 0) >>> 0,
    itemType: (upd.itemType ?? 0) >>> 0,
    name: upd.name || "",
    objScale: upd.objScale > 0 ? upd.objScale : 1.0,
    iconId: (upd.iconId ?? 0) >>> 0,
    paletteId: (upd.paletteId ?? 0) >>> 0,
    mtableId: (upd.mtableId ?? 0) >>> 0,
    // A9-Stage1 (2026-06-12): wire placement id (PhysicsDesc
    // .animation_frame; Spawn only, 0 = absent). Consumed by the
    // ?placementId=on rest-pose chain in entities.js.
    placementId: (upd.placementId ?? 0) >>> 0,
    // Portal destination text — populated on a kind=3 META_REFRESH for
    // portals; empty otherwise. (2D path only consumer today.)
    portalDestination: upd.portalDestination || "",
    // Object-level physics Translucency (render audit rank 6): 0=opaque,
    // 1=fully transparent. entities.js spawn() applies it as whole-object
    // opacity. Previously MISSING from the backlog clone (A15 §3 row 2).
    physicsTranslucency: +(upd.physicsTranslucency ?? 0),
    // ObjectDescription/WeenieHeader classifier inputs (entity-completeness
    // E.B). 0 for non-Spawn.
    objDescFlags: (upd.objDescFlags ?? 0) >>> 0,
    weenieFlags: (upd.weenieFlags ?? 0) >>> 0,
    // --- substitution arrays (Uint32Array; copied, self-contained) ---
    modelChanges: slice(upd.modelChanges, 0),
    textureChanges: slice(upd.textureChanges, 1),
    subPalettes: slice(upd.subPalettes, 2),
    // --- in-world effect DIDs (kind SPAWN) ---------------------------
    physicsScriptDid: (upd.physicsScriptDid ?? 0) >>> 0,
    soundTableDid: (upd.soundTableDid ?? 0) >>> 0,
    // --- motion-state hints (kind MOTION / MOTION_ACTION / TURN) -----
    motionCommand: (upd.motionCommand ?? 0) >>> 0,
    motionStance: (upd.motionStance ?? 0) >>> 0,
    // Per-motion playback speed (UpdateMotion forward_speed). 1.0 = no
    // scaling / identity. Previously MISSING from the backlog clone.
    motionSpeed: +(upd.motionSpeed ?? 1.0),
    // UpdateMotion is_autonomous bit: true = client-predicted gait echo
    // (skip), false = server-forced pose. Previously MISSING from the
    // backlog clone → replayed motions misclassified as server-FORCED
    // (A15 §3 row 2). `false` for non-MOTION updates.
    isAutonomous: !!upd.isAutonomous,
    // --- velocity hints (kind VELOCITY) ------------------------------
    vx: +(upd.vx ?? 0),
    vy: +(upd.vy ?? 0),
    vz: +(upd.vz ?? 0),
    omegaZ: +(upd.omegaZ ?? 0),
  };
}

// Re-export the empty sentinel for callers/tests that want to assert the
// shared-allocation behaviour.
export const EMPTY_U32 = _EMPTY_U32;
