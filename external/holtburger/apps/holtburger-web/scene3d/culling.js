// FCULL — app-level frustum + distance-LOD render culling (client-only).
//
// WHY THIS EXISTS
// ───────────────
// Three.js's per-mesh `frustumCulled` default is ON, so plain Meshes
// (terrain LBs, building parts, statics singletons, entity part leaves)
// already get a cheap per-object frustum test from the renderer. The gaps
// this pass fills are exactly where that default falls short:
//
//   1. InstancedMesh. The renderer frustum-tests an InstancedMesh by
//      transforming `geometry.boundingSphere` (the SINGLE-instance local
//      sphere) by the NODE's matrixWorld — it never looks at the per-
//      instance matrices. A statics InstancedMesh whose node sits at the
//      origin but whose instances are scattered 100 m out across a
//      landblock would be wrongly culled the moment the origin leaves the
//      frustum. statics.js therefore sets `frustumCulled=false` on every
//      InstancedMesh leaf and we test the AGGREGATE sphere here instead.
//
//   2. Deep entity rigs. An entity `root` is a transform-only Group with
//      no geometry, so the renderer's auto-cull on the root is a no-op; it
//      culls per-leaf-mesh, paying the full hierarchy traversal + world-
//      matrix update for entities that are entirely off-screen or far
//      away. Gating `root.visible` once skips the whole subtree.
//
//   3. Distance culling. Beyond the view frustum there is no distance
//      horizon on statics/entities today (the wasm cell-visibility BFS is
//      a coarse per-CELL gate, not per-object). A conservative large-
//      radius distance cull trims the far tail cheaply.
//
// COORDINATE FRAME (the load-bearing detail)
// ──────────────────────────────────────────
// Every world child group (terrain/buildings/statics/cells/entities) lives
// under `worldRoot`, whose only transform is `rotation.x = -π/2` (AC Z-up →
// THREE Y-up; index.js:585). Node LOCAL transforms — statics placement
// matrices, entity `root.position`, terrain LB offsets — are all authored
// in AC coords (Z up, +Y north, +X east). InstancedMesh `boundingSphere`
// (computed from the instance matrices) is likewise AC-local.
//
// So instead of transforming every node's bounds up into THREE world space
// each frame, we build the frustum DIRECTLY in AC space — exactly mirroring
// cells.js's `tickCellVisibility3D` MVP composition
// (`projection · matrixWorldInverse · worldRoot.matrixWorld`). The frustum
// extracted from that matrix tests AC-space spheres directly, with no per-
// node round-trip. The camera position is likewise pulled back into AC
// space once per frame for the distance test.
//
// GUARDRAIL: render-only, reversible `.visible` gating. We NEVER flip a
// world GROUP's `.visible` (that is the wasm cell-visibility BFS's job and
// we must not fight it) — only per-object `.visible` INSIDE the already-
// visible groups. Zero per-frame allocation in the hot path: all scratch
// is module-scoped + reused.

import * as THREE from "three";

// ── URL flags (read once at module load) ─────────────────────────────
//
//   ?frustumCull=off          disable the whole pass (default ON)
//   ?cullDist=<metres>        OPT-IN distance horizon for statics + entities.
//                             DEFAULT: disabled (frustum-only). The world is
//                             intentionally streamed well past any fixed
//                             metre horizon: the PVS expansion ring
//                             (scene3d/residency.js RESIDENCY_RADIUS_LB /
//                             PVS_RING_RADIUS, default 5 = an 11×11 LB ring
//                             whose far corner sits ~1494 m away —
//                             sqrt((5.5·192)²·2)) streams statics as the player
//                             roams, and the LRU keeps a radius-6 worth of them
//                             resident (~1764 m corner). Stale-comment fix
//                             2026-08-03 (residency #12): this used to credit
//                             "STATICS_RING_RADIUS defaults to 6" as the
//                             streaming horizon; that constant sizes the LRU
//                             cap, it does not stream anything. Meanwhile
//                             clear-weather
//                             fogMax reaches ~2500 m (daygroup_weather.js).
//                             Any fixed default horizon below that would
//                             distance-cull loaded, in-frustum, in-fog
//                             scenery at the horizon → visible popping, which
//                             the "default-on but conservative" guardrail
//                             forbids. The frustum test (bounded by the
//                             camera far plane, 5000) + the wasm cell-
//                             visibility BFS already bound the far tail, so
//                             the distance cull is purely an OPT-IN tighter
//                             trim. `?cullDist=N` (N>0) enables an N-metre
//                             horizon; `0` / negative / non-finite is the
//                             same as omitting it (frustum-only).
//   ?cullTerrain=on          opt-in per-LB terrain frustum cull. Default
//                             OFF because THREE already per-mesh frustum-
//                             culls terrain LB meshes correctly (they are
//                             plain Meshes with a lazily-computed geometry
//                             boundingSphere). Only useful for A/B eye-test.
//
// Read defensively (Node unit harness has no `window`).
function _readFlags() {
  // cullDistSq defaults to Infinity (frustum-only): a fixed metre horizon
  // smaller than the loaded-ring diagonal (~1764 m) or clear-weather fogMax
  // (~2500 m) would pop loaded in-fog scenery. Opt in with ?cullDist=N.
  const out = { enabled: true, cullDistSq: Infinity, terrain: false };
  try {
    const loc =
      (typeof window !== "undefined" && window.location) ||
      (typeof globalThis !== "undefined" && globalThis.location) ||
      null;
    if (!loc || !loc.search) return out;
    const ps = new URLSearchParams(loc.search);
    if (ps.get("frustumCull") === "off") out.enabled = false;
    if (ps.get("cullTerrain") === "on") out.terrain = true;
    const cd = ps.get("cullDist");
    if (cd != null) {
      const n = parseFloat(cd);
      if (Number.isFinite(n) && n > 0) out.cullDistSq = n * n;
      else out.cullDistSq = Infinity; // 0 / negative / NaN → frustum-only
    }
  } catch (_) {
    /* Node / no window → defaults */
  }
  return out;
}

const FLAGS = _readFlags();
export const FRUSTUM_CULL_ENABLED = FLAGS.enabled;
export const CULL_DIST_SQ = FLAGS.cullDistSq;
export const CULL_TERRAIN = FLAGS.terrain;

/**
 * Reusable AC-space frustum + camera-position cache. Allocate ONCE per
 * scene3d (stashed on `scene3d._frustumCuller`); `update()` re-derives the
 * frustum each frame with no new allocation. All test methods operate in
 * AC-local coords so they pair directly with statics/entity/terrain node
 * bounds (which are authored in AC space — see file header).
 */
export class FrustumCuller {
  constructor() {
    // AC-space MVP and the frustum extracted from it.
    this._mvp = new THREE.Matrix4();
    this.frustum = new THREE.Frustum();
    // Camera origin pulled back into AC space (for the distance test).
    this._camAc = new THREE.Vector3();
    // Scratch for pulling the camera world position into AC space.
    this._invWorldRoot = new THREE.Matrix4();
    this._camWorld = new THREE.Vector3();
    this.valid = false;
  }

  /**
   * Re-derive the AC-space frustum + camera position for this frame.
   * Returns `true` when a usable frustum was built, `false` when the
   * inputs aren't ready yet (pre-camera-init) — callers must treat a
   * `false` return as "cull nothing" (fail-open, never hide on a bad
   * frame).
   *
   * Mirrors cells.js `tickCellVisibility3D`: the MVP is
   * `projection · matrixWorldInverse · worldRoot.matrixWorld`, so the
   * frustum lives in AC space and AC-local spheres test directly.
   */
  update(camera, worldRoot) {
    this.valid = false;
    if (
      !camera ||
      !camera.projectionMatrix ||
      !camera.matrixWorldInverse ||
      !worldRoot ||
      !worldRoot.matrixWorld
    ) {
      return false;
    }
    // mvp = projection · viewInverse · worldRoot — frustum in AC space.
    this._mvp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._mvp.multiply(worldRoot.matrixWorld);
    this.frustum.setFromProjectionMatrix(this._mvp);

    // Camera origin → AC space: invert worldRoot's transform and apply it
    // to the camera's WORLD position. (worldRoot is a child of the scene
    // root with a pure rotation, so its inverse is exact + cheap.)
    if (typeof camera.getWorldPosition === "function") {
      camera.getWorldPosition(this._camWorld);
    } else if (camera.position) {
      this._camWorld.copy(camera.position);
    } else {
      this._camWorld.set(0, 0, 0);
    }
    this._invWorldRoot.copy(worldRoot.matrixWorld).invert();
    this._camAc.copy(this._camWorld).applyMatrix4(this._invWorldRoot);

    this.valid = true;
    return true;
  }

  /**
   * AC-space sphere-vs-frustum test. `sphere` is a THREE.Sphere in AC
   * coords. Returns `true` (visible) when the frustum is invalid so a
   * pre-init frame never hides anything.
   */
  isSphereInFrustum(sphere) {
    if (!this.valid || !sphere) return true;
    return this.frustum.intersectsSphere(sphere);
  }

  /**
   * Squared distance (m²) from the camera to an AC-space point. Squared so
   * callers compare against `CULL_DIST_SQ` without a sqrt.
   */
  getDistanceSq(x, y, z) {
    const dx = x - this._camAc.x;
    const dy = y - this._camAc.y;
    const dz = z - this._camAc.z;
    return dx * dx + dy * dy + dz * dz;
  }

  /** Camera X in AC space (for callers that need the raw component). */
  get camAcX() {
    return this._camAc.x;
  }
  get camAcY() {
    return this._camAc.y;
  }
  get camAcZ() {
    return this._camAc.z;
  }
}

/**
 * Lazily build + return the shared per-scene FrustumCuller. One instance
 * per scene3d, reused every frame.
 */
export function getFrustumCuller(scene3d) {
  if (!scene3d) return null;
  let c = scene3d._frustumCuller;
  if (!c) {
    c = new FrustumCuller();
    scene3d._frustumCuller = c;
  }
  return c;
}

/**
 * ── CRITICAL per-frame cull pass (loop.js step, never deferred). ──────
 *
 * Runs AFTER the wasm cell-visibility BFS (#1) so the world GROUPS already
 * carry their correct `.visible` state, and BEFORE lighting (#5). We only
 * gate per-OBJECT visibility inside groups that are already visible; we
 * never touch the group `.visible` flags themselves.
 *
 * Cheap + fail-soft: a missing camera/worldRoot, an unbuilt group, or a
 * thrown sub-pass leaves everything visible (the pre-FCULL behaviour).
 *
 * The statics + entity + terrain sub-passes are imported lazily-by-binding
 * — loop.js wires the concrete cullers in via `setCullers()` to avoid a
 * static import cycle (statics.js / entities.js / terrain.js all import
 * THREE + each other's siblings). loop.js owns the import graph; this file
 * stays a leaf that only depends on three.
 */
let _staticsCuller = null;
let _entityCuller = null;
let _terrainCuller = null;

/**
 * Wire the per-domain cull functions. Called once from loop.js (which owns
 * the imports of statics/entities/terrain) so culling.js stays a leaf
 * module. Each fn has signature `(scene3d, culler) => void` and must be
 * individually fail-soft.
 */
export function setCullers({ statics, entities, terrain } = {}) {
  if (typeof statics === "function") _staticsCuller = statics;
  if (typeof entities === "function") _entityCuller = entities;
  if (typeof terrain === "function") _terrainCuller = terrain;
}

/**
 * One-shot per-frame cull. Returns the FrustumCuller (for diag/tests) or
 * null when disabled / no scene.
 */
export function tickFrustumCull(scene3d) {
  if (!FRUSTUM_CULL_ENABLED || !scene3d) return null;
  const camera =
    scene3d.cameraSwitcher?.activeCamera ?? scene3d.camera ?? null;
  const worldRoot = scene3d.worldRoot ?? null;
  const culler = getFrustumCuller(scene3d);
  if (!culler) return null;
  if (!culler.update(camera, worldRoot)) {
    // Pre-init frame: do nothing (leave everything visible). Do NOT run the
    // sub-passes — they fail-open on an invalid frustum anyway, but skipping
    // saves the walk entirely.
    return culler;
  }
  if (_staticsCuller) {
    try {
      _staticsCuller(scene3d, culler);
    } catch (e) {
      if (!scene3d._fcullStaticsWarned) {
        scene3d._fcullStaticsWarned = true;
        // eslint-disable-next-line no-console
        console.warn("[fcull] statics cull threw:", e);
      }
    }
  }
  if (_entityCuller) {
    try {
      _entityCuller(scene3d, culler);
    } catch (e) {
      if (!scene3d._fcullEntitiesWarned) {
        scene3d._fcullEntitiesWarned = true;
        // eslint-disable-next-line no-console
        console.warn("[fcull] entity cull threw:", e);
      }
    }
  }
  // Terrain is opt-in (THREE already per-mesh frustum-culls terrain LBs).
  if (CULL_TERRAIN && _terrainCuller) {
    try {
      _terrainCuller(scene3d, culler);
    } catch (e) {
      if (!scene3d._fcullTerrainWarned) {
        scene3d._fcullTerrainWarned = true;
        // eslint-disable-next-line no-console
        console.warn("[fcull] terrain cull threw:", e);
      }
    }
  }
  return culler;
}
