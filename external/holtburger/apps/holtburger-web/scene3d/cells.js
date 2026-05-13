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
//     **world-frame** x/y/z + qw/qx/qy/qz (cell rotation × stab
//     orientation already composed; cell origin already added).
//     They render as direct children of the cell container with NO
//     additional transform from the cell.
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
    };
  }
  scene3d.envCellLoadedLbs.add(lbKey);

  const placements = await wasmExports.fetchEnvCellsInLandblock(lbKey);
  if (!placements || placements.length === 0) {
    return {
      landblockId: lbKey,
      cellCount: 0,
      surfaceCount: 0,
      staticObjectCount: 0,
      skippedZeroTri: 0,
      skippedNoMesh: 0,
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

  // ---- Step B: preload all referenced cell-mesh surface DIDs --------
  if (allCellSurfaceDids.size > 0) {
    try {
      await scene3d.materialCache.preload(
        [...allCellSurfaceDids],
        wasmExports.fetch_surfaces_pixels
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
  if (uniqueStaticDids.size > 0 && typeof wasmExports.fetch_model_meshes === "function") {
    const ids = [...uniqueStaticDids];
    let staticMeshes;
    try {
      staticMeshes = await wasmExports.fetch_model_meshes(new Uint32Array(ids));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[scene3d.cells] fetch_model_meshes (cell statics) failed:", e);
      skippedNoMesh = ids.length;
    }
    if (staticMeshes) {
      const allStaticSurfaceDids = new Set();
      const dominantByDid = new Map();
      for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i];
        const m = staticMeshes[i];
        if (!m) {
          skippedNoMesh += 1;
          continue;
        }
        if (m.triCount === 0) {
          skippedZeroTri += 1;
          if (typeof m.free === "function") m.free();
          continue;
        }
        const surfacesArr = m.surfaces;
        for (const did of surfacesArr) allStaticSurfaceDids.add(did >>> 0);
        if (surfacesArr.length > 0) {
          dominantByDid.set(id, surfacesArr[0] >>> 0);
        }
        const geom = meshToFusedGeometry(m);
        if (geom) staticGeomByDid.set(id, geom);
        if (typeof m.free === "function") m.free();
      }
      // Preload static-side surfaces too (cheap if already cached;
      // dedupes via MaterialCache#preload).
      if (allStaticSurfaceDids.size > 0) {
        try {
          await scene3d.materialCache.preload(
            [...allStaticSurfaceDids],
            wasmExports.fetch_surfaces_pixels
          );
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(
            "[scene3d.cells] materialCache.preload (static surfaces) failed:",
            e
          );
        }
      }
      for (const [id] of staticGeomByDid) {
        const dom = dominantByDid.get(id);
        if (typeof dom === "number" && dom !== 0) {
          staticMatByDid.set(id, scene3d.materialCache.getCached(dom));
        } else {
          staticMatByDid.set(id, scene3d.materialCache.fallbackMaterial);
        }
      }
    }
  }

  // ---- Step D: instantiate each cell from snapshots -----------------
  let cellCount = 0;
  let staticObjectCount = 0;
  for (const snap of snapshots) {
    const cellContainer = new THREE.Group();
    cellContainer.name = `envcell-${snap.cellId.toString(16).padStart(8, "0")}`;
    cellContainer.userData = {
      cellId: snap.cellId,
      environmentId: snap.environmentId,
      portalCellIds: snap.portalCellIds,
      isEnvCell: true,
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
    }
    cellContainer.add(meshGroup);

    for (const so of snap.staticSnaps) {
      const geom = staticGeomByDid.get(so.did);
      if (!geom) continue;
      const mat = staticMatByDid.get(so.did) || scene3d.materialCache.fallbackMaterial;
      const m = new THREE.Mesh(geom, mat);
      m.name = `cellstatic-${snap.cellId.toString(16).padStart(8, "0")}-${so.did.toString(16).padStart(8, "0")}`;
      // Cell-static props (furniture, lanterns, decorations).
      if (cellsShadow) {
        m.castShadow = materialCanCastShadow(mat);
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

    scene3d.cellsGroup.add(cellContainer);
    scene3d.cellContainers3d.set(snap.cellId, cellContainer);
    cellCount += 1;
  }

  return {
    landblockId: lbKey,
    cellCount,
    surfaceCount: allCellSurfaceDids.size,
    staticObjectCount,
    skippedZeroTri,
    skippedNoMesh,
  };
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
    renderSetArr = sessionHandle.getRenderSet(1);
    isIndoor = !!sessionHandle.isCurrentCellIndoor();
  } catch (_) {
    return;
  }

  // Pre-snapshot: cellId === 0 means no current cell yet (player
  // hasn't spawned). Mirror the 2D path's tickCellVisibility — leave
  // visibility alone until the first non-zero cell.
  if (cellId === 0) return;

  // Outdoor groups toggle as one batch: terrain + buildings + statics
  // all hide when indoor. (Lights stay on; entities stay visible —
  // they're rendered separately.)
  const wantOutdoor = !isIndoor;
  if (scene3d.terrainGroup && scene3d.terrainGroup.visible !== wantOutdoor) {
    scene3d.terrainGroup.visible = wantOutdoor;
  }
  if (scene3d.buildingsGroup && scene3d.buildingsGroup.visible !== wantOutdoor) {
    scene3d.buildingsGroup.visible = wantOutdoor;
  }
  if (scene3d.staticsGroup && scene3d.staticsGroup.visible !== wantOutdoor) {
    scene3d.staticsGroup.visible = wantOutdoor;
  }

  // Per-cell: build a Set out of the renderSet array for O(1) lookups.
  const visibleSet = new Set();
  if (renderSetArr) {
    for (const v of renderSetArr) visibleSet.add(v >>> 0);
  }
  const registry = scene3d.cellContainers3d;
  if (!(registry instanceof Map)) return;
  for (const [thisCellId, container] of registry) {
    const want = visibleSet.has(thisCellId >>> 0);
    if (container.visible !== want) {
      container.visible = want;
    }
  }
}
