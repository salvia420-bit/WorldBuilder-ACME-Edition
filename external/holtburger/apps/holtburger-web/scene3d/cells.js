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
        new URLSearchParams(globalThis.location.search).get("envcellFusion") === "1";
    }
  } catch (_) {
    envcellFusion = false;
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
      }
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

    newCells.push({ container: cellContainer, cellId: snap.cellId });
    cellCount += 1;
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
  for (const { container, cellId } of newCells) {
    scene3d.cellsGroup.add(container);
    scene3d.cellContainers3d.set(cellId, container);
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
  if (!loadStatics && !loadBuildings) return;

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
    const lbKey = cellId & 0xffff0000;
    if (lbKey === 0) continue;
    if (seen.has(lbKey)) continue;
    seen.add(lbKey);
    const lbX = (lbKey >>> 24) & 0xff;
    const lbY = (lbKey >>> 16) & 0xff;
    // Fire-and-forget — each hook resolves a Promise but we don't
    // await them from the tick. The per-domain Set checks make
    // re-fires near-free.
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
  }
}
