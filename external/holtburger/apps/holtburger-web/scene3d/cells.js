// Phase 7.3 — interior EnvCell groups (dungeons / apartments).
//
// Mirrors `buildings.js` for `0x0D…` Environment cells: per-EnvCell
// `THREE.Group` with surface meshes + per-static-object meshes, plus
// portal-graph metadata stashed on the group's `userData` so the
// cell-visibility BFS tick can flip `.visible` per frame.
//
// Coordinate semantics (per `lib.rs:4828-5021`):
//   - `cellOriginX/Y/Z` — already world coords (LB-corner offset added
//     on the wasm side; `landblock_origin_x = (lb_x_byte * 192)` is
//     pre-applied). DO NOT layer another worldOffset on top.
//   - `cellOrientationQw/Qx/Qy/Qz` — full quaternion in AC convention;
//     pass through `acQuatToThree`.
//   - The cell mesh (`takeMesh()`) carries cell-local vertex coords
//     (relative to `cellOrigin`). It must live under a child group
//     whose transform IS `(cellOrigin, cellOrientation)`.
//   - Static-object placements (`takeStaticObjects()`) carry
//     **world-frame** x/y/z + qw/qx/qy/qz. Stab frames are stored
//     landblock-local in the DAT — NOT cell-relative (retail applies
//     them verbatim: CEnvCell::init_static_objects, acclient.c:347955)
//     — so the wasm side adds ONLY the landblock corner offset, never
//     the cell frame. They render as direct children of the cell
//     container with NO additional transform from the cell.
//   - Surface DIDs in the wasm mesh are pre-OR'd with `0x08000000`
//     (Phase 6C closure at commit `bc71009`); the existing
//     `MaterialCache.preload()` chain handles them as ordinary surface
//     fetches.
//
// Output topology (per cell):
//   cellContainer (Group, identity transform; named `envcell-<cellIdHex>`)
//     ├─ meshGroup (Group, position = cellOrigin, quaternion = cellOrientation)
//     │   ├─ Mesh (per-surface geometry — cell-local vertex coords)
//     │   └─ ...
//     └─ Mesh (per-static-object — world-frame, no parent transform)
//
// `cellContainer.userData = { cellId, environmentId, portalCellIds,
// isEnvCell: true }`. The visibility BFS pulls the renderSet from the
// session handle and flips `.visible` on the outer container so both
// the per-cell mesh and the per-static-object children blink in unison.

import * as THREE from "three";
import {
  meshToGeometryGroups,
  meshToFusedGeometry,
  placementToMatrix4,
  acQuatToThree,
} from "./adapter.js";
import { materialCanCastShadow } from "./materials.js";
import { lbKeyOf } from "./landblock_lru.js";
import { STREAM_BAKE_DEFAULT_MAX_IN_FLIGHT } from "./stream_bake_guard.js";
import { modelMeshFetcher, surfacePixelsFetcher } from "./bake_worker_client.js";
import { attachStaticDefaultScriptsWorld } from "./statics.js";
// Task #9 — interior animated scenery (banners/flags via default_animation 0x03).
import { attachAnimatedScenery, animSceneryEnabled } from "./animated_scenery.js";

// ?cellBugParity=retail keeps indoor cells visible from outdoors — matches a known retail rendering quirk for nostalgia research.
const CELL_BUG_PARITY = (() => {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.search) {
      return new URLSearchParams(globalThis.location.search).get("cellBugParity") === "retail";
    }
  } catch (_) {}
  return false;
})();

// C1 (2026-06-20 busted-world load fix): cap the per-frame PVS-ring bake
// fan-out. `tickPvsLoadExpansion` otherwise fires the whole radius-N ring
// (~363 hooks at radius 5) on every LB-crossing all at once, saturating the
// bake worker/network and multiplying the late-paint stall + the single-fetch-
// throw poison. With the cap, only up to K NEW (not-yet-baked) LBs are STARTED
// per call, nearest-to-player first; the fire signature is held until the ring
// fully drains so subsequent frames keep filling progressively.
//
// `?pvsBakeCap` — default-ON, K = PVS_BAKE_DEFAULT_K (4). `=off` restores the
// legacy uncapped all-at-once fan-out. `=N` (positive integer) overrides K.
// NOTE: K needs 1070 roam-feel tuning.
const PVS_BAKE_DEFAULT_K = 4;
const PVS_BAKE_CAP = (() => {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.search) {
      const raw = new URLSearchParams(globalThis.location.search).get("pvsBakeCap");
      if (raw === "off") return { enabled: false, k: PVS_BAKE_DEFAULT_K };
      if (raw != null) {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n > 0) return { enabled: true, k: n };
      }
    }
  } catch (_) {}
  return { enabled: true, k: PVS_BAKE_DEFAULT_K };
})();

// Goal-1 draw-distance throttle (2026-06-22): a bounded distance-priority
// bake-START gate that supersedes PVS_BAKE_CAP's "K new starts per frame".
// The K-per-frame cap fires a FIXED number of new LBs each frame regardless
// of how many bakes are already running, so at large `pvsRingRadius` it keeps
// kicking off new fan-outs (and re-firing the ones the guard's global
// maxInFlight rejects) every frame — wasted fire-and-forget churn that scales
// with ring area. Instead, drain the (already distance-sorted, already
// `isNewBake`-filtered) ring into the stream guard's AVAILABLE in-flight slots
// only: each frame start nearest-unbaked LBs while the guard's in-flight count
// is below `targetInFlight`, then hold the fire signature (re-enter next frame)
// while new LBs remain. This makes ring radius set EVENTUAL coverage with a
// FIXED bake-start ceiling, instead of an instantaneous per-frame multiplier.
//
// Invariants preserved by construction (see the failure-mode map): no separate
// queue structure — the SOURCE OF TRUTH stays `isNewBake` (the per-domain
// baked-Sets, written only AFTER a bake succeeds) + the guard's own in-flight
// Set, so a starved/cooling/evicted LB is never marked baked and stays
// retryable (no mark-baked-before-fetch poison, nothing to evict). The
// signature is held (`skipped != done`) until no new LB remains. The guard's
// `maxInFlight` (default 6) is the HARD backstop; `targetInFlight` is the soft
// pacing target (a single dequeue fires up to 3 domains, so actual in-flight
// can briefly exceed `targetInFlight` but never the guard's hard cap).
//
// `?pvsStreamQueue` — default-ON, targetInFlight = STREAM_BAKE_DEFAULT_MAX_IN_FLIGHT
// (6). `=off` falls back to the PVS_BAKE_CAP K-per-frame path (and, if that is
// also `?pvsBakeCap=off`, to the legacy uncapped fan-out). `=N` (positive
// integer) overrides targetInFlight. NOTE: targetInFlight needs 1070 roam-feel
// tuning vs the guard's maxInFlight.
const PVS_STREAM_QUEUE = (() => {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.search) {
      const raw = new URLSearchParams(globalThis.location.search).get("pvsStreamQueue");
      if (raw === "off") return { enabled: false, targetInFlight: STREAM_BAKE_DEFAULT_MAX_IN_FLIGHT };
      if (raw != null) {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n > 0) return { enabled: true, targetInFlight: n };
      }
    }
  } catch (_) {}
  return { enabled: true, targetInFlight: STREAM_BAKE_DEFAULT_MAX_IN_FLIGHT };
})();

// Phase 4 PView port (2026-05-25): module-scope scratch for the
// per-frame MVP matrix passed to `getRenderSetWithFrustum`. Allocated
// lazily on first call so capture-time setups without a Three.js
// scene don't pay for them.
let _mvpScratch = null;
let _mvpMatrixScratch = null;

/**
 * Top-level: load every EnvCell for a single landblock and add the
 * resulting Groups under `scene3d.cellsGroup`. Idempotent — second
 * call for the same `landblockId` no-ops via the
 * `scene3d.envCellLoadedLbs` set.
 *
 * Pipeline:
 *   1. fetchEnvCellsInLandblock(landblockId)  // wasm round-trip.
 *   2. Preload all referenced cell-mesh surface DIDs via
 *      `materialCache.preload()`.
 *   3. Union of unique static-object DIDs across cells →
 *      `fetch_model_meshes()` round-trip → fused geometries per DID
 *      (mirrors `buildHoltburgStatics`'s shape, but per-cell in flow).
 *      Skip statics whose model_id has 0 triangles or whose fetch
 *      failed.
 *   4. For each placement: `buildOneEnvCell()` → add Group to
 *      `cellsGroup`. Track in `scene3d.cellContainers3d:
 *      Map<cellId, Group>`.
 *
 * Returns:
 *   {
 *     landblockId: u32,
 *     cellCount: number,        // groups added to cellsGroup
 *     surfaceCount: number,      // unique cell-mesh surface DIDs
 *     staticObjectCount: number, // sum of statics attached across cells
 *     skippedZeroTri: number,    // static DIDs whose model has 0 tris
 *     skippedNoMesh: number,     // static DIDs whose model fetch failed
 *   }
 */
// F14-3 — `?cellStaticMultiSurface=on` (default OFF). Cell-static props
// (lanterns, braziers, tables, chests, beds) are multi-surface, but the
// renderer fused each into a single-material mesh painted with only its
// FIRST surface. When ON, each prop is built as ONE fused geometry with
// per-surface addGroups + a parallel materials array (THREE.Mesh binds the
// right material per group), so every surface textures correctly. Default
// OFF pending a 1070 eye-test (changes interior prop textures).
function readCellStaticMultiSurface() {
  // INTEGRATED always-on — 1070 eye-test PASSED 2026-06-10 (interior props
  // texture correctly per-surface). JS, live on reload. Was the default-OFF
  // `?cellStaticMultiSurface=on` gate.
  return true;
}

// F14-3 — build one fused multi-surface BufferGeometry + parallel materials
// array from `meshToGeometryGroups` output (each group = {geometry, surfaceDid}).
// Mirrors the cell-surface fused build but with no opaque/transparent split
// (props are small — the transparent-sort artifact is negligible next to
// whole-prop mistexturing). Returns { geometry, materials } or null.
function buildFusedMultiSurfaceStatic(groups, materialCache) {
  if (!groups || groups.length === 0) return null;
  let totalVerts = 0;
  for (const g of groups) totalVerts += g.geometry.attributes.position.count;
  if (totalVerts === 0) return null;
  const mergedPos = new Float32Array(totalVerts * 3);
  const mergedUv = new Float32Array(totalVerts * 2);
  const mergedNormal = new Float32Array(totalVerts * 3);
  const materials = [];
  const fused = new THREE.BufferGeometry();
  let vertexOffset = 0;
  for (let i = 0; i < groups.length; i += 1) {
    const src = groups[i].geometry;
    const vertCount = src.attributes.position.count;
    mergedPos.set(src.attributes.position.array, vertexOffset * 3);
    mergedUv.set(src.attributes.uv.array, vertexOffset * 2);
    mergedNormal.set(src.attributes.normal.array, vertexOffset * 3);
    fused.addGroup(vertexOffset, vertCount, i);
    vertexOffset += vertCount;
    materials.push(
      materialCache.getCached(groups[i].surfaceDid >>> 0) || materialCache.fallbackMaterial,
    );
  }
  fused.setAttribute("position", new THREE.BufferAttribute(mergedPos, 3, false));
  fused.setAttribute("uv", new THREE.BufferAttribute(mergedUv, 2, false));
  fused.setAttribute("normal", new THREE.BufferAttribute(mergedNormal, 3, false));
  fused.computeBoundingSphere();
  for (const g of groups) { try { g.geometry.dispose?.(); } catch (_) {} }
  return { geometry: fused, materials };
}

export async function buildEnvCellsForLandblock(scene3d, landblockId, wasmExports) {
  if (!scene3d || !scene3d.cellsGroup) {
    throw new Error("buildEnvCellsForLandblock: scene3d.cellsGroup missing");
  }
  if (
    !wasmExports ||
    typeof wasmExports.fetchEnvCellsInLandblock !== "function" ||
    typeof wasmExports.fetch_surfaces_pixels !== "function"
  ) {
    throw new Error(
      "buildEnvCellsForLandblock: wasmExports missing fetchEnvCellsInLandblock / fetch_surfaces_pixels"
    );
  }
  // M2 (worker-based asset bake): worker-routed decoders when enabled
  // (`?bakeWorker=1`); identical references to wasmExports.* when disabled
  // (byte-identical to pre-M2). Drop-in results (consumers guard `.free()`).
  const mmFetch = modelMeshFetcher(wasmExports);
  const spFetch = surfacePixelsFetcher(wasmExports);
  if (!scene3d.materialCache) {
    throw new Error(
      "buildEnvCellsForLandblock: scene3d.materialCache missing — Phase 7.2 should have installed it before EnvCell load"
    );
  }
  if (!(scene3d.cellContainers3d instanceof Map)) {
    scene3d.cellContainers3d = new Map();
  }
  if (!(scene3d.envCellLoadedLbs instanceof Set)) {
    scene3d.envCellLoadedLbs = new Set();
  }

  // Perf C1 — flag-gated EnvCell surface-mesh fusion. When `?envcellFusion=1`
  // is set, fuse all surface BufferGeometries within a cell into a single
  // (or two — split when the cell mixes opaque + transparent) `THREE.Mesh`
  // with a parallel materials array and `addGroup(start, count, materialIndex)`.
  // Three.js binds the correct material per group automatically. Each cell
  // drops from N draws to 1 (or 2) draws, killing the 96–832 per-frame
  // material binds indoor measurements report at Academy PVS depth.
  //
  // Default OFF until SSIM-validated against the per-surface baseline. See
  // `docs/fps-perf-plan-2026-05-18.md` § C1 for the briefing.
  let envcellFusion = false;
  try {
    if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.search) {
      envcellFusion =
        new URLSearchParams(globalThis.location.search).get("envcellFusion") !== "off";
    }
  } catch (_) {
    envcellFusion = false;
  }

  // F3 (2026-06-01): time-slice the Step-D per-cell instantiation loop so a
  // landblock with hundreds of EnvCells (Academy = 568) doesn't build them all
  // in one synchronous burst — the documented ~567ms first-sight hitch. (The
  // compileAsync prewarm below handles the GPU upload/compile; THIS handles the
  // synchronous JS geometry construction, which is what still hitches on a real
  // GPU.) Builds in ~6ms chunks, yielding to the event loop between chunks.
  // Default ON; disable with `?noEnvcellTimeSlice=1`. Safe to yield here: Pass 1
  // already drained+freed every wasm handle, so no wasm linear memory is held
  // across the await. Uses setTimeout — NOT requestIdleCallback (the `_ric_shim`
  // replaces rIC with a microtask) and NOT rAF (never re-arms under
  // `?renderOnDemand=1`).
  let envcellTimeSlice = true;
  try {
    if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.search) {
      envcellTimeSlice =
        new URLSearchParams(globalThis.location.search).get("noEnvcellTimeSlice") !== "1";
    }
  } catch (_) {
    envcellTimeSlice = true;
  }
  const ENVCELL_BUILD_BUDGET_MS = 6;

  const lbKey = (landblockId & 0xffff_0000) >>> 0;
  if (scene3d.envCellLoadedLbs.has(lbKey)) {
    return {
      landblockId: lbKey,
      cellCount: 0,
      surfaceCount: 0,
      staticObjectCount: 0,
      skippedZeroTri: 0,
      skippedNoMesh: 0,
      idempotent: true,
      disposables: { geometries: [], materials: [], textures: [] },
    };
  }
  // geom-audit (2026-07-02): the LB used to be marked LOADED before the
  // wasm fetch — a failed/starved fetch then left the interior empty for
  // the whole session with no retry (the missing-grocer-furniture class).
  // Mark loaded only on SUCCESS; dedupe concurrent callers (world_stream
  // fires this on every position update) via an in-flight set that also
  // serves as the mid-build eviction signal (landblock_lru clears it).
  if (!(scene3d.envCellBuildInFlight instanceof Set)) {
    scene3d.envCellBuildInFlight = new Set();
  }
  if (!(scene3d.envCellBuildGen instanceof Map)) {
    scene3d.envCellBuildGen = new Map();
  }
  if (scene3d.envCellBuildInFlight.has(lbKey)) {
    return {
      landblockId: lbKey,
      cellCount: 0,
      surfaceCount: 0,
      staticObjectCount: 0,
      skippedZeroTri: 0,
      skippedNoMesh: 0,
      inFlight: true,
      disposables: { geometries: [], materials: [], textures: [] },
    };
  }
  scene3d.envCellBuildInFlight.add(lbKey);
  // Generation token: an evict during this build deletes the gen entry
  // (and the in-flight marker), and any LATER rebuild bumps it — either
  // way this build's attach guard sees a mismatch and bails instead of
  // attaching stale duplicates.
  const buildGen = ((scene3d.envCellBuildGen.get(lbKey) | 0) + 1) | 0;
  scene3d.envCellBuildGen.set(lbKey, buildGen);
  try {

  const placements = await wasmExports.fetchEnvCellsInLandblock(lbKey);
  // geom-audit: one bounded breadcrumb per interior LB build so a
  // stalled/failed interior is diagnosable from the console (the
  // 2026-07-02 grocer bug ran for whole sessions with zero evidence).
  // eslint-disable-next-line no-console
  console.log(
    `[scene3d.cells] envcells 0x${lbKey.toString(16).padStart(8, "0")}: ` +
      `${placements ? placements.length : 0} placements fetched`
  );
  if (!placements || placements.length === 0) {
    // Legit no-interior LB (open countryside) — mark loaded so the
    // per-position-update re-fires stay cheap. A prefetch ERROR throws
    // out of this function instead (not marked → retried).
    scene3d.envCellLoadedLbs.add(lbKey);
    return {
      landblockId: lbKey,
      cellCount: 0,
      surfaceCount: 0,
      staticObjectCount: 0,
      skippedZeroTri: 0,
      skippedNoMesh: 0,
      disposables: { geometries: [], materials: [], textures: [] },
    };
  }

  // The wasm-side `EnvCellPlacement` exposes destructive `takeMesh`,
  // `takeStaticObjects`, `takePortalCellIds`. To avoid juggling wasm
  // handles across the (preload → instantiate) boundary, we drain
  // every placement up-front into JS-owned snapshots (Pass 1), then
  // run material preload + static geometry fetch (Steps B + C), then
  // instantiate THREE Groups from the snapshots (Step D). Mirrors the
  // 7.2 buildings phase's bake-then-preload-then-instantiate shape.

  const uniqueStaticDids = new Set();

  // ---- Pass 1: drain placements into JS-owned snapshots --------------
  const snapshots = [];
  const allCellSurfaceDids = new Set();
  for (const pl of placements) {
    const cellId = pl.cellId >>> 0;
    const environmentId = pl.environmentId >>> 0;
    const cellOriginX = pl.cellOriginX;
    const cellOriginY = pl.cellOriginY;
    const cellOriginZ = pl.cellOriginZ;
    const cellOrientationQw = pl.cellOrientationQw;
    const cellOrientationQx = pl.cellOrientationQx;
    const cellOrientationQy = pl.cellOrientationQy;
    const cellOrientationQz = pl.cellOrientationQz;

    const portalCellIds = Array.from(pl.takePortalCellIds(), (v) => v >>> 0);

    // Drain mesh → geometry groups + DIDs. The `meshToGeometryGroups`
    // helper handles the wasm `ModelMesh.surfaces` getter (which
    // already carries the 0x08000000 OR mask for env-cell surfaces
    // per the wasm-side helper).
    const mesh = pl.takeMesh();
    const { groups: surfaceGroups, surfaceDids } = meshToGeometryGroups(mesh);
    for (const did of surfaceDids) allCellSurfaceDids.add(did >>> 0);
    if (mesh && typeof mesh.free === "function") mesh.free();

    // Snapshot static placements into plain objects + free wasm sides.
    const staticSnaps = [];
    const stPlacements = pl.takeStaticObjects();
    for (const so of stPlacements) {
      const did = so.did >>> 0;
      uniqueStaticDids.add(did);
      staticSnaps.push({
        did,
        x: so.x, y: so.y, z: so.z,
        qw: so.qw, qx: so.qx, qy: so.qy, qz: so.qz,
        // 2026-06-23: interior default_script (0x33) for the ambient
        // particle chain (braziers/torches/fountains). typeof-guarded —
        // soft-degrades to 0 until the wasm exposes `defaultScriptId` on
        // EnvCell statics (batched rebuild); 0 is skipped at zero cost by
        // the attach filter, so this is a no-op until then.
        defaultScriptId:
          typeof so.defaultScriptId === "number" ? so.defaultScriptId >>> 0 : 0,
        // Task #9 — interior default_animation (0x03) for animated props
        // (banners/flags). typeof-guarded; soft-degrades to 0 pre-rebuild.
        defaultAnimationId:
          typeof so.defaultAnimationId === "number" ? so.defaultAnimationId >>> 0 : 0,
      });
      if (typeof so.free === "function") so.free();
    }

    snapshots.push({
      cellId,
      environmentId,
      cellOriginX,
      cellOriginY,
      cellOriginZ,
      cellOrientationQw,
      cellOrientationQx,
      cellOrientationQy,
      cellOrientationQz,
      portalCellIds,
      surfaceGroups,
      staticSnaps,
    });

    if (typeof pl.free === "function") pl.free();
  }

  // LRU wave H4 — per-LB owned BufferGeometries get accumulated through
  // Step C (cell-static fused geoms) + Step D (cell surface meshes + any
  // fused opaque/transparent meshes) so `loadEnvCellsForLandblock` can hand
  // them to `landblockLru.track()` for eviction-time dispose(). Materials
  // and textures stay empty: every material (cell surfaces + cell-static
  // surfaces) is `materialCache.getCached`-shared cross-LB.
  const lbDisposableGeometries = [];

  // ---- Step B: preload all referenced cell-mesh surface DIDs --------
  if (allCellSurfaceDids.size > 0) {
    try {
      await scene3d.materialCache.preload(
        [...allCellSurfaceDids],
        spFetch
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        "[scene3d.cells] materialCache.preload (cell surfaces) failed:",
        e
      );
    }
  }

  // ---- Step C: fetch per-DID fused static geometries -----------------
  // Mirrors `buildHoltburgStatics` shape but only for the DIDs this
  // landblock's cells actually reference. Skip the round-trip if no
  // statics; many sentinel cells in dungeon graphs are empty.
  const staticGeomByDid = new Map();
  const staticMatByDid = new Map();
  let skippedZeroTri = 0;
  let skippedNoMesh = 0;
  // geom-audit: every dropped stab DID with its reason — surfaced in the
  // per-build warn below + stamped for __diag.geometry.audit().
  const droppedStaticDids = [];
  if (uniqueStaticDids.size > 0 && typeof wasmExports.fetch_model_meshes === "function") {
    const ids = [...uniqueStaticDids];
    let staticMeshes;
    try {
      staticMeshes = await mmFetch(new Uint32Array(ids));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[scene3d.cells] fetch_model_meshes (cell statics) failed:", e);
      skippedNoMesh = ids.length;
      for (const id of ids) droppedStaticDids.push({ did: id >>> 0, reason: "batch-failed" });
    }
    if (staticMeshes) {
      const allStaticSurfaceDids = new Set();
      const dominantByDid = new Map();
      // F14-3 — when ON, keep each prop's per-surface groups so it can be
      // built as a multi-material mesh after the surfaces preload below.
      const multiSurface = readCellStaticMultiSurface();
      const staticGroupsByDid = new Map();
      for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i];
        const m = staticMeshes[i];
        if (!m) {
          skippedNoMesh += 1;
          droppedStaticDids.push({ did: id >>> 0, reason: "no-mesh" });
          continue;
        }
        if (m.triCount === 0) {
          skippedZeroTri += 1;
          // geom-audit: decodeMisses > 0 = decode-starved (records were
          // unavailable — wasm already warned + retried); 0 = authored-
          // empty. typeof-guarded for a stale pkg/worker payload.
          const misses = typeof m.decodeMisses === "number" ? m.decodeMisses >>> 0 : -1;
          droppedStaticDids.push({ did: id >>> 0, reason: misses > 0 ? "decode-starved" : "zero-tri" });
          if (typeof m.free === "function") m.free();
          continue;
        }
        const surfacesArr = m.surfaces;
        for (const did of surfacesArr) allStaticSurfaceDids.add(did >>> 0);
        if (surfacesArr.length > 0) {
          dominantByDid.set(id, surfacesArr[0] >>> 0);
        }
        if (multiSurface) {
          // Per-surface groups; the fused multi-material build runs after
          // the surfaces are preloaded (materials must be cached first).
          const { groups } = meshToGeometryGroups(m);
          if (groups && groups.length > 0) staticGroupsByDid.set(id, groups);
        } else {
          const geom = meshToFusedGeometry(m);
          if (geom) staticGeomByDid.set(id, geom);
        }
        if (typeof m.free === "function") m.free();
      }
      // Preload static-side surfaces too (cheap if already cached;
      // dedupes via MaterialCache#preload).
      if (allStaticSurfaceDids.size > 0) {
        try {
          await scene3d.materialCache.preload(
            [...allStaticSurfaceDids],
            spFetch
          );
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(
            "[scene3d.cells] materialCache.preload (static surfaces) failed:",
            e
          );
        }
      }
      // F14-3 — flag ON: build the fused multi-material geometry + materials
      // array now that the surfaces are cached. Stored the same way as the
      // single-material path so the mesh-creation loop is unchanged (THREE.Mesh
      // binds an array of materials per geometry group automatically).
      if (multiSurface) {
        for (const [id, groups] of staticGroupsByDid) {
          const built = buildFusedMultiSurfaceStatic(groups, scene3d.materialCache);
          if (!built) continue;
          staticGeomByDid.set(id, built.geometry);
          staticMatByDid.set(id, built.materials);
          lbDisposableGeometries.push(built.geometry);
        }
      }
      for (const [id, geom] of staticGeomByDid) {
        // Multi-surface props (F14-3) already have their geometry pushed to
        // lbDisposableGeometries and their materials array set above.
        if (staticMatByDid.has(id)) continue;
        const dom = dominantByDid.get(id);
        if (typeof dom === "number" && dom !== 0) {
          staticMatByDid.set(id, scene3d.materialCache.getCached(dom));
        } else {
          staticMatByDid.set(id, scene3d.materialCache.fallbackMaterial);
        }
        // Per-LB owned: staticGeomByDid is fresh for each bake call (no
        // cross-LB cache), so each cell-static fused geometry is owned by
        // this LB even when multiple cells share the same DID within it.
        lbDisposableGeometries.push(geom);
      }
    }
  }
  // geom-audit (2026-07-02): NOTHING dropped from an interior may be
  // silent — every skipped stab DID logs with its reason so the class
  // "furniture missing, no console evidence" cannot recur.
  if (droppedStaticDids.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[geom-audit] envcells 0x${lbKey.toString(16).padStart(8, "0")}: ` +
        `${droppedStaticDids.length}/${uniqueStaticDids.size} cell-static models dropped: ` +
        droppedStaticDids
          .map((d) => `0x${d.did.toString(16)}(${d.reason})`)
          .join(" ")
    );
  }

  // ---- Step D: instantiate each cell from snapshots -----------------
  let cellCount = 0;
  let staticObjectCount = 0;
  // Perf C1 — telemetry for the validation pass. Counts how many cells
  // had at least one transparent surface so we can validate the split
  // policy against real Academy data in the A/B run.
  let fusedCellsWithTransparent = 0;
  let fusedCellsOpaqueOnly = 0;
  // 2026-05-21 — Accumulate cellContainers into a local array instead
  // of adding to scene3d.cellsGroup in the for-loop. Lets us batch
  // `renderer.compileAsync(subtree, camera, scene)` once at the end
  // to pre-warm shader programs + texture uploads via
  // KHR_parallel_shader_compile, killing the 567ms (low-agent) /
  // 708ms (wire-agent) hitch that fires when 1269 cell meshes hit
  // the renderer in one tick (cell-visibility BFS flips them visible
  // on first sight). The compile runs in the driver's background
  // thread on real GPUs; on SwiftShader/llvmpipe it falls back to
  // sync compile but the code shape is the same.
  const newCells = [];
  // 2026-06-23: interior static props (braziers/torches/fountains) whose
  // SetupModel carries a `default_script` (0x33). Collected during the
  // cell build (world-frame transform + defaultScriptId already on the
  // snapshot) and handed to `attachStaticDefaultScriptsWorld` after the
  // cells attach — the indoor twin of the outdoor scenery path. Stays
  // empty (no-op) until the wasm exposes `defaultScriptId` on EnvCell
  // statics (batched rebuild).
  const scriptedInteriorStatics = [];
  // Task #9 — interior props with a default_animation (0x03); peeled out of the
  // frozen per-cell mesh path (when ?animScenery is on) and handed to the
  // world-frame animated builder so banners/flags wave indoors too.
  const animatedInteriorStatics = [];
  const animSceneryOn = animSceneryEnabled();
  let _chunkStart = performance.now();
  for (const snap of snapshots) {
    const cellContainer = new THREE.Group();
    cellContainer.name = `envcell-${snap.cellId.toString(16).padStart(8, "0")}`;
    cellContainer.userData = {
      cellId: snap.cellId,
      environmentId: snap.environmentId,
      portalCellIds: snap.portalCellIds,
      isEnvCell: true,
      // geom-audit: expected vs attached stab accounting for
      // __diag.geometry.audit(). `expectedStatics` = the EnvCell's
      // authored stab count; `peeledAnimated` counts stabs routed to
      // the animated-scenery builder (attached under this container a
      // beat later); `missingStaticDids` lists stabs dropped for lack
      // of geometry (each already console-warned with a reason).
      expectedStatics: snap.staticSnaps.length,
      peeledAnimated: 0,
      missingStaticDids: [],
    };

    const meshGroup = new THREE.Group();
    meshGroup.name = `mesh-${snap.cellId.toString(16).padStart(8, "0")}`;
    meshGroup.position.set(snap.cellOriginX, snap.cellOriginY, snap.cellOriginZ);
    meshGroup.quaternion.copy(
      acQuatToThree(
        snap.cellOrientationQw,
        snap.cellOrientationQx,
        snap.cellOrientationQy,
        snap.cellOrientationQz
      )
    );

    // Phase 3.3 — CSM and Phase 0.1 are mutually exclusive paths but
    // share the caster/receiver tagging. Flip on for either.
    const cellsShadow = !!scene3d.shadowsEnabled || !!scene3d.csmEnabled;
    if (envcellFusion) {
      // Perf C1 — fused path. Build at most TWO meshes per cell: one
      // for opaque surfaces, one for transparent. Splitting on the
      // material's `.transparent` flag preserves Three.js's per-mesh
      // transparent-queue gating; mixing both in a single Mesh breaks
      // depth-sorting for the transparent triangles.
      //
      // Each surface group already has its own non-indexed
      // BufferGeometry (position[N*9], uv[N*6], normal[N*9]) from
      // `meshToGeometryGroups`. We concatenate per-bucket, then use
      // `addGroup(vertexStart, vertexCount, materialIndex)` to map
      // each surface's run of vertices to the materialIndex slot in
      // the parallel materials array. Three.js will bind the correct
      // material per group automatically at draw time.
      //
      // castShadow / receiveShadow are per-Mesh in Three.js, not
      // per-group — under fused mode the cell's castShadow becomes
      // the OR of contributing surfaces' shadow-cast flags
      // (`materialCanCastShadow`). This is a deliberate semantic
      // shift documented in § C1 of the perf plan; for translucent-
      // bearing cells the artifact is shadow-on-glass, considered
      // acceptable per the briefing. The opaque/transparent split
      // limits the OR fold to within-bucket only — opaque cells stay
      // exact; transparent cells lump glows together (rare in retail).
      const opaqueGroups = [];
      const transparentGroups = [];
      for (const g of snap.surfaceGroups) {
        const mat = scene3d.materialCache.getCached(g.surfaceDid);
        if (mat && mat.transparent === true) {
          transparentGroups.push({ group: g, material: mat });
        } else {
          opaqueGroups.push({ group: g, material: mat });
        }
      }
      if (transparentGroups.length > 0) fusedCellsWithTransparent += 1;
      else fusedCellsOpaqueOnly += 1;

      const buildFusedMesh = (bucket, kind) => {
        if (bucket.length === 0) return null;

        // Materials parallel to addGroup's materialIndex slots. The
        // `.filter(Boolean)` guards against the (unexpected) case
        // where getCached returns null/undefined; the cache returns
        // its fallbackMaterial for misses so this is belt-and-braces
        // — but a `THREE.Mesh(geom, [undefined, m, ...])` silently
        // paints with the default purple lambert at the undefined
        // slot, which is a visually obvious regression we want to
        // shout about, not absorb.
        const materials = bucket.map((b) => b.material).filter(Boolean);
        if (materials.length !== bucket.length) {
          throw new Error(
            `buildEnvCellsForLandblock: cell ${snap.cellId.toString(16)} ${kind} ` +
              `bucket has ${bucket.length} groups but only ${materials.length} ` +
              `non-null materials — refusing to construct fused Mesh with sparse holes`
          );
        }

        // Compute total vertex count across the bucket. Each per-
        // surface BufferGeometry has identical attribute layout
        // (position[3]/uv[2]/normal[3]) — all non-indexed,
        // 9-floats-per-tri for position+normal, 6-floats-per-tri
        // for uv. We pre-allocate the merged Float32Arrays then
        // copy each surface group's slabs into the right slot.
        let totalVerts = 0;
        for (const b of bucket) {
          totalVerts += b.group.geometry.attributes.position.count;
        }

        const mergedPos = new Float32Array(totalVerts * 3);
        const mergedUv = new Float32Array(totalVerts * 2);
        const mergedNormal = new Float32Array(totalVerts * 3);

        const fused = new THREE.BufferGeometry();
        let vertexOffset = 0;
        for (let i = 0; i < bucket.length; i += 1) {
          const srcGeom = bucket[i].group.geometry;
          const srcPos = srcGeom.attributes.position.array;
          const srcUv = srcGeom.attributes.uv.array;
          const srcNorm = srcGeom.attributes.normal.array;
          const vertCount = srcGeom.attributes.position.count;

          mergedPos.set(srcPos, vertexOffset * 3);
          mergedUv.set(srcUv, vertexOffset * 2);
          mergedNormal.set(srcNorm, vertexOffset * 3);

          // addGroup is in *vertex* units for non-indexed
          // geometry (the docs use "index/vertex" interchangeably
          // depending on whether setIndex was called). Our source
          // geometries are non-indexed → start/count count
          // vertices, materialIndex picks the slot in `materials`.
          fused.addGroup(vertexOffset, vertCount, i);
          vertexOffset += vertCount;
        }

        fused.setAttribute("position", new THREE.BufferAttribute(mergedPos, 3, false));
        fused.setAttribute("uv", new THREE.BufferAttribute(mergedUv, 2, false));
        fused.setAttribute("normal", new THREE.BufferAttribute(mergedNormal, 3, false));
        fused.computeBoundingSphere();
        lbDisposableGeometries.push(fused);

        const m = new THREE.Mesh(fused, materials);
        m.name = `surfaces-fused-${kind}-${snap.cellId.toString(16).padStart(8, "0")}`;
        m.userData = {
          cellId: snap.cellId,
          fused: true,
          fusedKind: kind,
          surfaceCount: bucket.length,
        };
        if (cellsShadow) {
          // OR of per-material cast flags within the bucket. Single
          // transparent surface in the transparent bucket already
          // returns false from `materialCanCastShadow` (Translucent
          // bit), so the OR there is typically false — matching
          // the per-surface gate's outcome for those surfaces.
          let cast = false;
          for (const b of bucket) {
            if (materialCanCastShadow(b.material)) {
              cast = true;
              break;
            }
          }
          m.castShadow = cast;
          m.receiveShadow = true;
        }
        return m;
      };

      const opaqueMesh = buildFusedMesh(opaqueGroups, "opaque");
      if (opaqueMesh) meshGroup.add(opaqueMesh);
      const transparentMesh = buildFusedMesh(transparentGroups, "transparent");
      if (transparentMesh) meshGroup.add(transparentMesh);
    } else {
      for (const g of snap.surfaceGroups) {
        const mat = scene3d.materialCache.getCached(g.surfaceDid);
        const m = new THREE.Mesh(g.geometry, mat);
        m.name = `surface-${(g.surfaceDid >>> 0).toString(16).padStart(8, "0")}`;
        m.userData = {
          cellId: snap.cellId,
          surfaceDid: g.surfaceDid,
        };
        // Visual-fidelity Phase 0.1 — interior walls / floors / ceilings
        // cast AND receive shadows from each other. Translucent /
        // additive surfaces (windows, magical glows) skip casting.
        if (cellsShadow) {
          m.castShadow = materialCanCastShadow(mat);
          m.receiveShadow = true;
        }
        meshGroup.add(m);
        lbDisposableGeometries.push(g.geometry);
      }
    }
    cellContainer.add(meshGroup);

    for (const so of snap.staticSnaps) {
      // Collect scripted interior props for the ambient particle chain
      // (independent of geometry — a script-only static still emits).
      if ((so.defaultScriptId >>> 0) !== 0) {
        scriptedInteriorStatics.push({
          defaultScriptId: so.defaultScriptId >>> 0,
          x: so.x, y: so.y, z: so.z,
          qw: so.qw, qx: so.qx, qy: so.qy, qz: so.qz,
        });
      }
      // Task #9 — peel animated interior props (flag-gated) to the world-frame
      // animated builder and SKIP their frozen mesh (no double-render). When the
      // flag is off, fall through to the frozen path (byte-identical).
      if (animSceneryOn && (so.defaultAnimationId >>> 0) !== 0) {
        animatedInteriorStatics.push({
          objId: so.did,
          defaultAnimationId: so.defaultAnimationId >>> 0,
          x: so.x, y: so.y, z: so.z,
          qw: so.qw, qx: so.qx, qy: so.qy, qz: so.qz,
          scale: 1,
          worldFrame: true,
          landblockId,
          sourceObjIdx: snap.cellId >>> 0,
        });
        cellContainer.userData.peeledAnimated += 1;
        continue;
      }
      const geom = staticGeomByDid.get(so.did);
      if (!geom) {
        // geom-audit: per-cell record of the dropped stab (already
        // warned per-DID above; the stamp lets __diag.geometry.audit()
        // attribute the hole to its cell).
        cellContainer.userData.missingStaticDids.push(so.did >>> 0);
        continue;
      }
      const mat = staticMatByDid.get(so.did) || scene3d.materialCache.fallbackMaterial;
      const m = new THREE.Mesh(geom, mat);
      m.name = `cellstatic-${snap.cellId.toString(16).padStart(8, "0")}-${so.did.toString(16).padStart(8, "0")}`;
      // Cell-static props (furniture, lanterns, decorations).
      if (cellsShadow) {
        // F14-3: `mat` is an array for multi-surface props — cast if ANY
        // surface casts (per-Mesh flag, mirrors the cell-surface OR fold).
        m.castShadow = Array.isArray(mat)
          ? mat.some((sub) => materialCanCastShadow(sub))
          : materialCanCastShadow(mat);
        m.receiveShadow = true;
      }
      const xform = placementToMatrix4(so);
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const sc = new THREE.Vector3();
      xform.decompose(p, q, sc);
      m.position.copy(p);
      m.quaternion.copy(q);
      m.scale.copy(sc);
      m.userData = {
        cellId: snap.cellId,
        modelId: so.did,
        isCellStatic: true,
      };
      cellContainer.add(m);
      staticObjectCount += 1;
    }

    // Cells default to hidden; the visibility tick flips `.visible`
    // once the player enters one. Keeping them hidden by default
    // avoids paying the frustum-cull cost every frame for cells the
    // BFS would never include.
    cellContainer.visible = false;

    newCells.push({ container: cellContainer, cellId: snap.cellId });
    cellCount += 1;

    // F3 time-slice: once this chunk has spent its frame budget, yield to the
    // event loop so the build spreads across frames instead of one long hitch.
    if (envcellTimeSlice && (performance.now() - _chunkStart) > ENVCELL_BUILD_BUDGET_MS) {
      await new Promise((r) => setTimeout(r, 0));
      _chunkStart = performance.now();
    }
  }

  // Pre-warm GPU programs + texture uploads for all new cells before
  // they hit the scene graph. compileAsync walks the subtree, finds
  // every material, and dispatches shader compile + texture upload
  // requests. With KHR_parallel_shader_compile (real GPUs), the work
  // happens in the driver background while JS continues. Without it
  // (SwiftShader), compileAsync falls back to sync compile but still
  // returns a Promise so the call shape is identical. Use a temp
  // parent so we hand compileAsync a single subtree.
  const renderer = scene3d.renderer;
  const camera = scene3d.camera;
  if (newCells.length > 0 && renderer && camera && typeof renderer.compileAsync === "function") {
    const tempParent = new THREE.Group();
    for (const { container } of newCells) tempParent.add(container);
    try {
      await renderer.compileAsync(tempParent, camera, scene3d.scene);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[envcell-compileAsync] failed (cells will lazy-compile on first render):", e);
    }
  }

  // Attach the pre-warmed cells to the live scene graph. Cells default
  // to `.visible=false`; the visibility tick flips them on as the
  // player walks/looks. By this point the GPU programs are ready, so
  // the first-frame-visible cost is minimal.
  //
  // Phase 5 PView render-order fix (2026-05-25): assign every node in the
  // new cell container to layer 1 (RENDER_LAYER_INDOOR). Three.js layer
  // masks are per-object — they don't inherit from `scene3d.cellsGroup`'s
  // mask. Without this, EnvCell meshes render on layer 0 (alongside terrain)
  // and the depth-clear split in atmosphere_pipeline.js can't isolate them.
  // Recursive traverse covers cellContainer, meshGroup, and every Mesh.
  // F3 cancellation guard: if this LB was evicted while this build was
  // suspended at ANY await point, do NOT attach — evict() already removed
  // lbKey from envCellLoadedLbs, so attaching now would orphan these cells
  // and let a later re-approach rebuild duplicates. Dispose the per-LB
  // geometries we built (materials are cache-shared, never disposed here)
  // and bail.
  // envcell-guard (#likely): the `envcellTimeSlice &&` qualifier was
  // WRONG — even the non-time-sliced ("sync") path awaits
  // `renderer.compileAsync` above, which yields to the event loop and lets
  // an eviction tick run before we reach this attach. Guarding only the
  // time-sliced path left the sync path able to re-attach an evicted LB's
  // cells (duplicate cells on re-approach). Always re-check residency.
  // geom-audit (2026-07-02): the LOADED mark now lands only on success, so
  // the mid-build eviction signal is the generation token (landblock_lru's
  // evict deletes it; a later rebuild bumps it — both mismatch).
  if (scene3d.envCellBuildGen.get(lbKey) !== buildGen) {
    for (const g of lbDisposableGeometries) {
      try { if (g && typeof g.dispose === "function") g.dispose(); } catch (_) {}
    }
    return {
      landblockId: lbKey,
      cellCount: 0,
      surfaceCount: allCellSurfaceDids.size,
      staticObjectCount: 0,
      skippedZeroTri,
      skippedNoMesh,
      evictedDuringBuild: true,
      disposables: { geometries: [], materials: [], textures: [] },
    };
  }

  for (const { container, cellId } of newCells) {
    container.traverse((o) => o.layers.set(1));
    scene3d.cellsGroup.add(container);
    scene3d.cellContainers3d.set(cellId, container);
  }
  // geom-audit: build reached attach — NOW the LB counts as loaded.
  scene3d.envCellLoadedLbs.add(lbKey);

  // 2026-06-23: light up interior props' default_script particle chains
  // (braziers/torches/fountains) — the indoor twin of the outdoor
  // `attachStaticDefaultScripts`. Fire-and-forget: the cells are already
  // attached, so the chains light up a beat later without blocking the
  // build result. No-op until the wasm exposes `defaultScriptId` on
  // EnvCell statics (the list stays empty); honours `?staticScripts=off`.
  if (scriptedInteriorStatics.length > 0) {
    attachStaticDefaultScriptsWorld(
      scene3d,
      scriptedInteriorStatics,
      wasmExports
    ).catch((e) => {
      // eslint-disable-next-line no-console
      console.warn("[envcell] interior default_script attach failed:", e);
    });
  }

  // Task #9 — interior animated props (banners/flags) via the world-frame
  // animated-scenery builder. Parent each node to ITS cell container (keyed by
  // sourceObjIdx = cellId) so it inherits the cell's enter-to-show visibility
  // gate AND is evicted with the container (the rAF detects the orphaned node).
  // Fire-and-forget; no-op when ?animScenery is off or pre-rebuild.
  if (animatedInteriorStatics.length > 0) {
    const cellContainerById = new Map(newCells.map(({ container, cellId }) => [cellId >>> 0, container]));
    attachAnimatedScenery(scene3d, animatedInteriorStatics, wasmExports, {
      resolveParent: (item) => cellContainerById.get(item.sourceObjIdx >>> 0) || null,
    }).catch((e) => {
      // eslint-disable-next-line no-console
      console.warn("[envcell] interior animated scenery attach failed:", e);
    });
  }

  return {
    landblockId: lbKey,
    cellCount,
    surfaceCount: allCellSurfaceDids.size,
    staticObjectCount,
    skippedZeroTri,
    skippedNoMesh,
    // Perf C1 telemetry — populated only when `?envcellFusion=1`. Lets
    // the validation pass compute the transparent-bearing-cell rate
    // against real Academy data (briefing's 5% threshold).
    fusedEnabled: envcellFusion,
    fusedCellsWithTransparent: envcellFusion ? fusedCellsWithTransparent : 0,
    fusedCellsOpaqueOnly: envcellFusion ? fusedCellsOpaqueOnly : 0,
    // LRU wave H4 — per-LB owned BufferGeometries (cell surface meshes +
    // optional fused meshes + cell-static fused meshes). All materials and
    // textures stay shared via materialCache, so those arrays are empty.
    disposables: {
      geometries: lbDisposableGeometries,
      materials: [],
      textures: [],
    },
  };

  // geom-audit: the try wraps the whole build (indentation left as-is to
  // keep the diff reviewable); the finally releases the in-flight marker
  // on EVERY exit — success, legit-empty, eviction, or thrown error — so
  // a failed build is retried by the next position-update fire instead
  // of wedging the LB. Gen-guarded: if an evict cleared the marker and a
  // NEWER build re-set it, this stale build must not clear the newer one's.
  } finally {
    if (scene3d.envCellBuildGen?.get(lbKey) === buildGen) {
      scene3d.envCellBuildInFlight.delete(lbKey);
    }
  }
}

/**
 * Visibility tick — runs per rAF inside the scene3d loop.
 *
 * Reads the wasm-side cell BFS via `sessionHandle`:
 *   - `getCurrentCellId() → u32`
 *   - `getRenderSet(maxDistance) → Uint32Array`
 *   - `isCurrentCellIndoor() → bool`
 *
 * Flips:
 *   - `terrainGroup.visible / buildingsGroup.visible /
 *     staticsGroup.visible = !isIndoor`
 *   - `cellContainer.visible = renderSet.has(cellId)` for every
 *     entry in `cellContainers3d`.
 *
 * Cheap no-op when `sessionHandle` is null/missing or its methods
 * throw — capture-time setups without a live ACE session must still
 * be able to run a render loop.
 */
export function tickCellVisibility3D(scene3d, sessionHandle) {
  if (!scene3d || !sessionHandle) return;
  if (
    typeof sessionHandle.getCurrentCellId !== "function" ||
    typeof sessionHandle.getRenderSet !== "function" ||
    typeof sessionHandle.isCurrentCellIndoor !== "function"
  ) {
    return;
  }

  let cellId = 0;
  let renderSetArr = null;
  let isIndoor = false;
  try {
    cellId = sessionHandle.getCurrentCellId() >>> 0;
    isIndoor = !!sessionHandle.isCurrentCellIndoor();
    // F14-6 — stamp the local player's indoor state for the per-frame
    // nameplate LOD tick (nameplate_sprite.js), which flips nameplate /
    // buff-badge depthTest on indoors under ?nameplateOcclusion so dungeon
    // walls occlude overhead names instead of X-raying through.
    scene3d._currentCellIndoor = isIndoor;

    // Phase 4 PView port (2026-05-25): if the wasm exposes the
    // frustum-aware visibility method AND we have a live camera with
    // a valid view+projection, use it. Mirrors WB's
    // `EnvCellManager.GetVisibleCells` (cottage-interior visible from
    // outside via frustum culling on EnvCell AABBs). Fallback to the
    // legacy depth-1 BFS render set when either the helper is absent
    // (older wasm), the camera isn't initialised yet, or the matrix
    // composition throws.
    const camera =
      scene3d.cameraSwitcher?.activeCamera ?? scene3d.camera ?? null;
    const worldRoot = scene3d.worldRoot ?? null;
    const useFrustum =
      typeof sessionHandle.getRenderSetWithFrustum === "function" &&
      camera &&
      camera.projectionMatrix &&
      camera.matrixWorldInverse &&
      worldRoot;
    if (useFrustum) {
      try {
        // Cell AABBs in the wasm spatial scene are stored in AC world
        // coords (Z-up). The camera lives outside `worldRoot` so its
        // view matrix is in THREE world coords (Y-up). To frustum-cull
        // AABBs in AC space, fold `worldRoot.matrixWorld` (the
        // -π/2 X-rotation that maps AC→THREE per adapter.js:1155) into
        // the MVP. Then the frustum extracted from that matrix is
        // already in AC space; AABBs test directly.
        //
        // Composition: mvp = projection · matrixWorldInverse · worldRoot.matrixWorld
        // Three.js's Matrix4.multiplyMatrices(a, b) computes a·b.
        const mvp = _mvpScratch ?? (_mvpScratch = new Float32Array(16));
        const m = _mvpMatrixScratch ?? (_mvpMatrixScratch = new THREE.Matrix4());
        m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        m.multiply(worldRoot.matrixWorld);
        for (let i = 0; i < 16; i++) mvp[i] = m.elements[i];
        // Phase 5 PView port (2026-05-25): when the wasm exposes the
        // screen-space portal-polygon walk, UNION it with the Phase 4
        // AABB-frustum cull. PView is tighter (precise portal-clip
        // visibility) but has two limitations: (a) LandCell-rooted
        // walks return {current_cell} only because outdoor cells have
        // no portals, and (b) portals with any vertex behind the
        // camera near plane are conservatively skipped. The frustum
        // cull catches both cases — its AABB-vs-frustum is correct
        // from outdoor cameras and isn't sensitive to near-plane
        // geometry. Union = correctness; intersection would be
        // tighter but lose near-portal cells.
        const frustumSet = sessionHandle.getRenderSetWithFrustum(mvp);
        if (typeof sessionHandle.getRenderSetWithPView === "function") {
          // 2026-05-25 diag(pvs) parametric depth: wasm `getRenderSetWithPView`
          // now takes an optional `max_depth: u8`. Production caller passes
          // `0` (= use the default `PVIEW_MAX_DEPTH=8`); only the
          // `run-diag-pview-depth-tuning.cjs` harness varies it.
          const pviewSet = sessionHandle.getRenderSetWithPView(mvp, 0);
          if (pviewSet && pviewSet.length > 1) {
            // Indoor case: PView returned more than just the seed
            // cell, so the portal walk produced real refined results.
            // Union with frustum to keep near-portal-robust cells.
            const union = new Set();
            for (const v of pviewSet) union.add(v >>> 0);
            for (const v of frustumSet) union.add(v >>> 0);
            renderSetArr = Array.from(union);
          } else {
            // Outdoor case (or PView returned just {current}):
            // PView gives nothing useful, use the frustum cull alone.
            renderSetArr = frustumSet;
          }
        } else {
          renderSetArr = frustumSet;
        }
      } catch (_) {
        renderSetArr = sessionHandle.getRenderSet(1);
      }
    } else {
      renderSetArr = sessionHandle.getRenderSet(1);
    }
  } catch (_) {
    return;
  }

  // Pre-snapshot: cellId === 0 means no current cell yet (player
  // hasn't spawned). Mirror the 2D path's tickCellVisibility — leave
  // visibility alone until the first non-zero cell.
  if (cellId === 0) return;

  // Phase 5 PView render-order fix (2026-05-25, WB.GameScene.cs:1610):
  // terrain + outdoor buildings + outdoor statics stay VISIBLE when
  // indoor. Previously this code hid them; that broke retail behaviour
  // through cottage doorways (the doorway-shaped portal opening would
  // show the clear color instead of the landscape outside) and was an
  // incomplete substitute for the proper depth-clear-between-passes
  // pattern WB uses.
  //
  // The atmosphere pipeline's `preFrameSkySync` now reads the SAME
  // indoor flag (via skyDome._lastIsIndoor) and:
  //   1. Renders terrain/buildings/statics on layer 0 first.
  //   2. Clears the depth buffer (color stays).
  //   3. Renders EnvCells + entities on layer 1 with fresh depth.
  // Cottage floors win the second pass; terrain shows through portals
  // because the color buffer still holds the landscape paint.
  //
  // We explicitly force visible=true here so any prior frame's hidden
  // state (from before this fix or from a transitional flip) is cleared.
  // Cost is one comparison per group per tick — negligible.
  if (scene3d.terrainGroup && !scene3d.terrainGroup.visible) {
    scene3d.terrainGroup.visible = true;
  }
  if (scene3d.buildingsGroup && !scene3d.buildingsGroup.visible) {
    scene3d.buildingsGroup.visible = true;
  }
  if (scene3d.staticsGroup && !scene3d.staticsGroup.visible) {
    scene3d.staticsGroup.visible = true;
  }

  // Per-cell: build a Set out of the renderSet array for O(1) lookups.
  const visibleSet = new Set();
  if (renderSetArr) {
    for (const v of renderSetArr) visibleSet.add(v >>> 0);
  }
  const registry = scene3d.cellContainers3d;
  if (!(registry instanceof Map)) return;
  // 2026-05-28 perf: instead of iterating the whole registry (typically
  // 600+ entries with only ~10 actually visible), diff against the prior
  // frame's visible set. Cell becomes visible → set true; cell drops out
  // → set false; unchanged cells are skipped entirely. Steady-state diff
  // is 0-3 cells per tick, so the inner loop usually does no work at all.
  // Falls back to full-registry scan under CELL_BUG_PARITY because that
  // mode wants every EnvCell visible regardless of the diff.
  if (CELL_BUG_PARITY) {
    for (const [thisCellId, container] of registry) {
      const want = container?.userData?.isEnvCell
        ? true
        : visibleSet.has(thisCellId >>> 0);
      if (container.visible !== want) {
        container.visible = want;
      }
    }
  } else {
    const lastVisible = scene3d._lastCellVisibleSet ?? (scene3d._lastCellVisibleSet = new Set());
    // Visible this frame: ensure container.visible=true. Always check
    // (not just newly-visible) so an LRU-evicted-and-re-baked cell
    // converges — re-bake assigns a fresh container with visible=false
    // even though the cellId may already be in lastVisible. Cost is
    // bounded by visibleSet.size (~11 typically).
    for (const cellId of visibleSet) {
      const container = registry.get(cellId);
      if (container && container.visible !== true) {
        container.visible = true;
      }
    }
    // Newly-hidden cells: iterate prior frame's set and flip out anything
    // no longer visible. Typical diff is 0-3 entries.
    for (const cellId of lastVisible) {
      if (visibleSet.has(cellId)) continue;
      const container = registry.get(cellId);
      if (container && container.visible !== false) {
        container.visible = false;
      }
    }
    // Roll the snapshot forward. Replace contents in place so the Set
    // object is stable across frames (avoids per-frame allocation).
    lastVisible.clear();
    for (const cellId of visibleSet) lastVisible.add(cellId);
  }

  // Wave-3 diag hook: post-flip notify so diag.pvs can detect transitions
  // against the just-applied visibility state. Reuses `cellId` resolved
  // above — no extra wasm call. Optional-chained throughout; never throws.
  try { window.__diag?.pvs?.onCellTick?.(cellId); } catch (_) { /* swallow */ }
}

/**
 * Per-frame PVS-driven content-load expander (2026-05-16 bandwidth pass).
 *
 * The boot rings cover a tight neighborhood (statics + buildings both at
 * radius=2 = 5×5 = 25 LBs) instead of the prior 13×13 = 169 to cut
 * setup/mesh/surface-pixel fetches by ~85 %. This function fills the
 * gap by reading the wasm renderSet each frame and firing
 * `loadStaticsForLandblock` + `loadBuildingsForLandblock` for any LB
 * whose cell is now visible but hasn't been baked. Both hooks are
 * idempotent — `staticsBakedLbs.has(lbKey)` / `buildingsBakedLbs.has(lbKey)`
 * early-return on re-fires — so calling them every rAF is cheap even
 * at 60 Hz × dozens of visible cells.
 *
 * Complement to `handlePositionUpdate`'s per-LB-entry hook in
 * `index.html`: that catches LBs the player is STANDING in; PVS catches
 * LBs the player can SEE without standing in them yet (cross-LB
 * line-of-sight, e.g. looking across a flat field at distant buildings).
 *
 * Cheap no-op when sessionHandle is null/missing or both load hooks are
 * absent — capture-time setups without a live session continue to run
 * the render loop unaffected.
 */
export function tickPvsLoadExpansion(scene3d, sessionHandle) {
  if (!scene3d || !sessionHandle) return;
  if (typeof sessionHandle.getRenderSet !== "function") return;
  const loadStatics =
    typeof scene3d.loadStaticsForLandblock === "function"
      ? scene3d.loadStaticsForLandblock.bind(scene3d)
      : null;
  const loadBuildings =
    typeof scene3d.loadBuildingsForLandblock === "function"
      ? scene3d.loadBuildingsForLandblock.bind(scene3d)
      : null;
  // 2026-06-20 barren-wilderness fix: terrain MESH must widen in lockstep with
  // the statics/scenery ring, otherwise baking statics at radius>1 floats trees
  // over the void terrain beyond the 3×3 startup patch (index.html
  // ensureTerrainAroundLandblock). The per-LB terrain baker is self-contained
  // (fetches its own heightmaps) and idempotent via terrainBakedLbs. Distant
  // terrain only needs to be VISIBLE — wasm collision (populateTerrain) stays a
  // tight 3×3 around the player via the index.html prefetch, unchanged here.
  const loadTerrain =
    typeof scene3d.loadTerrainForLandblock === "function"
      ? scene3d.loadTerrainForLandblock.bind(scene3d)
      : null;
  if (!loadStatics && !loadBuildings && !loadTerrain) return;

  let renderSetArr = null;
  try {
    renderSetArr = sessionHandle.getRenderSet(1);
  } catch (_) {
    return;
  }
  if (!renderSetArr || renderSetArr.length === 0) return;

  // Extract unique LB keys (high 16 bits of cell ID) from the renderSet
  // and fire the per-LB hooks for each. Re-fires for already-baked LBs
  // are no-ops via the per-domain idempotency Set checks.
  const seen = scene3d._pvsSeenLbScratch || (scene3d._pvsSeenLbScratch = new Set());
  seen.clear();
  for (let i = 0; i < renderSetArr.length; i += 1) {
    const cellId = renderSetArr[i] >>> 0;
    // pvs-signed-key — `cellId & 0xffff0000` (a raw bitwise AND) yields a
    // SIGNED 32-bit int when bit 31 is set (e.g. 0xA9B40000 → negative),
    // which then mismatches the unsigned lb-keys the bake/idempotency
    // Sets are keyed on. `lbKeyOf` applies `>>> 0` as its LAST op so the
    // key is always the canonical unsigned 32-bit lb-key.
    const lbKey = lbKeyOf(cellId);
    if (lbKey === 0) continue;
    if (seen.has(lbKey)) continue;
    seen.add(lbKey);
  }
  // 2026-05-28 perf: expand the load ring by one LB so prefetch leads
  // motion. Drive-2 captured a 3.3s spike at +101.9s when the player
  // approached the edge of the original PVS-driven ring and 6 new LBs
  // had to load all at once. By also firing load hooks for the 8-LB
  // neighbour ring around every PVS-visible LB, those loads start ~5s
  // earlier (one ring's traversal time at run speed). Idempotency in
  // both loadStatics + loadBuildings makes redundant calls free.
  //
  // 2026-06-20 barren-wilderness fix: the ring radius is now player-tunable
  // (`scene3d.pvsRingRadius`, default 5 = 11×11 ≈ 960 m). Outdoors `seen` is a
  // single LB (the player's — outdoor renderSet is structurally {current}), so
  // this is exactly a player-centered radius-N ring, matching the radius-6 boot
  // ring's "full visible horizon" intent as the player roams away from the
  // Holtburg-hardcoded boot bake. Falls back to 1 (the legacy 3×3) when the
  // property is absent (older build / capture path).
  const ringRadius =
    Number.isFinite(scene3d.pvsRingRadius) && scene3d.pvsRingRadius >= 0
      ? scene3d.pvsRingRadius | 0
      : 1;
  // Per-frame fire-storm guard: the fire loop below makes
  // (ringSize × 3-domain) idempotent hook calls — at radius 5 that is
  // 121×3 ≈ 363 calls/frame, each allocating a guarded-bake Promise even
  // for already-baked LBs (the baked-Set short-circuit lives inside the
  // async closure, past the allocation). The LBs to (re)fire only change
  // when the player's `seen` set or the ring radius changes (an LB
  // crossing / renderSet shift), so skip the whole sweep when the
  // signature is unchanged since last frame — collapsing the steady-state
  // cost to one sweep per LB-crossing while still leading motion. `seen`
  // derives from a wasm-sorted renderSet so its iteration order is stable
  // frame-to-frame. (A cooldown-backed-off failed bake retries on the next
  // signature change, which roaming produces within seconds.)
  let fireSig = String(ringRadius);
  for (const lbKey of seen) fireSig += "," + lbKey;
  // Steady-state short-circuit: skip the whole sweep when the signature is
  // unchanged since last frame. Under the bake cap, the signature is recorded
  // ONLY once the ring is fully drained (a partially-drained ring stores a
  // sentinel below that can't match `fireSig`), so the cap still re-enters each
  // frame to fill the remaining LBs progressively while a fully-baked ring
  // collapses to one sweep per LB-crossing — exactly as the uncapped path does.
  if (scene3d._pvsLastFireSig === fireSig) return;
  const ringSeen = scene3d._pvsRingLbScratch || (scene3d._pvsRingLbScratch = new Set());
  ringSeen.clear();
  for (const lbKey of seen) {
    ringSeen.add(lbKey);
    const lbX = (lbKey >>> 24) & 0xff;
    const lbY = (lbKey >>> 16) & 0xff;
    for (let dx = -ringRadius; dx <= ringRadius; dx += 1) {
      for (let dy = -ringRadius; dy <= ringRadius; dy += 1) {
        if (dx === 0 && dy === 0) continue;
        const nx = lbX + dx;
        const ny = lbY + dy;
        if (nx < 0 || nx > 0xff || ny < 0 || ny > 0xff) continue;
        ringSeen.add(((nx << 24) | (ny << 16)) >>> 0);
      }
    }
  }

  // Fire-and-forget the three per-domain hooks for one ring LB. Each hook
  // resolves a Promise but we don't await it; the per-domain baked-Set + the
  // stream guard's in-flight/cooldown dedup make re-fires near-free.
  const fireOne = (lbKey) => {
    const lbX = (lbKey >>> 24) & 0xff;
    const lbY = (lbKey >>> 16) & 0xff;
    if (loadTerrain) {
      try {
        loadTerrain(lbX, lbY);
      } catch (e) {
        if (!scene3d._pvsLoadTerrainWarned) {
          scene3d._pvsLoadTerrainWarned = true;
          // eslint-disable-next-line no-console
          console.warn("[scene3d.cells] PVS loadTerrainForLandblock threw:", e);
        }
      }
    }
    if (loadStatics) {
      try {
        loadStatics(lbX, lbY);
      } catch (e) {
        if (!scene3d._pvsLoadStaticsWarned) {
          scene3d._pvsLoadStaticsWarned = true;
          // eslint-disable-next-line no-console
          console.warn("[scene3d.cells] PVS loadStaticsForLandblock threw:", e);
        }
      }
    }
    if (loadBuildings) {
      try {
        loadBuildings(lbX, lbY);
      } catch (e) {
        if (!scene3d._pvsLoadBuildingsWarned) {
          scene3d._pvsLoadBuildingsWarned = true;
          // eslint-disable-next-line no-console
          console.warn("[scene3d.cells] PVS loadBuildingsForLandblock threw:", e);
        }
      }
    }
  };

  if (!PVS_BAKE_CAP.enabled && !PVS_STREAM_QUEUE.enabled) {
    // Legacy uncapped fan-out (`?pvsBakeCap=off&pvsStreamQueue=off`): fire the
    // whole ring at once, then record the signature so the steady-state sweep
    // is one per LB-crossing.
    scene3d._pvsLastFireSig = fireSig;
    for (const lbKey of ringSeen) fireOne(lbKey);
    return;
  }

  // Capped path: an LB is a "new bake" if ANY present domain hasn't baked it
  // yet. Start at most K new bakes per call, nearest-to-player first, so the
  // ring fills progressively instead of saturating the bake worker/network all
  // at once. Already-fully-baked LBs are skipped (their hooks are no-ops).
  const tBaked = scene3d.terrainBakedLbs instanceof Set ? scene3d.terrainBakedLbs : null;
  const sBaked = scene3d.staticsBakedLbs instanceof Set ? scene3d.staticsBakedLbs : null;
  const bBaked = scene3d.buildingsBakedLbs instanceof Set ? scene3d.buildingsBakedLbs : null;
  const isNewBake = (lbKey) => {
    if (loadTerrain && tBaked && !tBaked.has(lbKey)) return true;
    if (loadStatics && sBaked && !sBaked.has(lbKey)) return true;
    if (loadBuildings && bBaked && !bBaked.has(lbKey)) return true;
    // No baked-Set wired for a present domain → can't prove baked; treat as new
    // so we still make progress (and the per-key guard dedups the re-fire).
    if (loadTerrain && !tBaked) return true;
    if (loadStatics && !sBaked) return true;
    if (loadBuildings && !bBaked) return true;
    return false;
  };

  // Sort the ring by Chebyshev distance to the nearest `seen` (player) LB so
  // the closest unbaked LBs paint first.
  const ringArr = scene3d._pvsRingSortScratch || (scene3d._pvsRingSortScratch = []);
  ringArr.length = 0;
  for (const lbKey of ringSeen) ringArr.push(lbKey);
  const distToPlayer = (lbKey) => {
    const lbX = (lbKey >>> 24) & 0xff;
    const lbY = (lbKey >>> 16) & 0xff;
    let best = Infinity;
    for (const pKey of seen) {
      const pX = (pKey >>> 24) & 0xff;
      const pY = (pKey >>> 16) & 0xff;
      const d = Math.max(Math.abs(lbX - pX), Math.abs(lbY - pY));
      if (d < best) best = d;
    }
    return best;
  };
  ringArr.sort((a, b) => distToPlayer(a) - distToPlayer(b));

  if (PVS_STREAM_QUEUE.enabled) {
    // Goal-1 stream-queue path: start nearest-unbaked LBs only while the stream
    // guard's in-flight count is below `targetInFlight`, so the number of bakes
    // (and their fetch fan-outs) live at once is bounded by `targetInFlight`
    // regardless of ring radius. Re-read `inFlight.size` each iteration: a
    // `fireOne` enqueues up to 3 guarded bakes which the guard adds to its
    // in-flight Set synchronously (stream_bake_guard.js), so the next
    // iteration's read reflects the previous start. The guard state may not
    // exist until the first guarded bake creates it, so treat a missing Set as
    // size 0 (the first fireOne then creates it). A `fireOne` for an LB whose
    // domains are all in-flight/cooling is a cheap no-op (the guard resolves
    // null without growing in-flight), so a cooling-down nearest LB does NOT
    // block the drain — the next iteration simply advances to the next-nearest.
    const target = PVS_STREAM_QUEUE.targetInFlight | 0;
    let remaining = false;
    for (let i = 0; i < ringArr.length; i += 1) {
      const lbKey = ringArr[i];
      if (!isNewBake(lbKey)) continue; // already fully baked — skip cheaply
      const guard = scene3d._streamGuardState;
      const inFlightSize =
        guard && guard.inFlight instanceof Set ? guard.inFlight.size : 0;
      if (inFlightSize >= target) {
        remaining = true; // budget full — more new bakes left for a later frame
        break;
      }
      fireOne(lbKey);
    }
    // Hold the signature (re-enter next frame) while new LBs remain, so the ring
    // fills progressively as in-flight slots free; record it once nothing new
    // remains so the steady-state cost collapses to one sweep per LB-crossing.
    // (A bake that fails sets a guard cooldown but leaves its baked-Set unset;
    // it is retried on the next LB-crossing, matching the legacy capped path.)
    scene3d._pvsLastFireSig = remaining ? null : fireSig;
    return;
  }

  const maxNew = PVS_BAKE_CAP.k | 0;
  let started = 0;
  let remaining = false;
  for (let i = 0; i < ringArr.length; i += 1) {
    const lbKey = ringArr[i];
    if (!isNewBake(lbKey)) continue; // already fully baked — skip cheaply
    if (started >= maxNew) {
      remaining = true; // more new bakes left for a later frame
      break;
    }
    fireOne(lbKey);
    started += 1;
  }
  // Hold the signature (force a re-entry next frame) until the ring is fully
  // drained, so subsequent frames keep filling the remaining LBs progressively
  // instead of re-deciding from scratch. Once nothing new remains, record the
  // signature so the steady-state cost collapses to one sweep per LB-crossing.
  if (!remaining) {
    scene3d._pvsLastFireSig = fireSig;
  } else {
    scene3d._pvsLastFireSig = null;
  }
}
