// Phase 7.2 — non-building static objects (signs, props, foliage,
// scenery details). Mirrors the 2D path's `buildLiveSpriteMap` +
// `buildObjectsContainer` flow but produces three.js Meshes instead
// of pre-rasterised RenderTextures.
//
// Data flow (per migration plan §"Conversion pipelines"):
//   1. fetch_landblock_objects(NEIGHBOURHOOD ids, suffix 0xfffe) →
//      filter `isBuilding === false`. ~225 placements for Holtburg's
//      9-LB ring.
//   2. Unique modelIds → fetch_model_meshes (one round-trip,
//      Uint32Array of u32s).
//   3. For each unique modelId: meshToFusedGeometry → one fused
//      `BufferGeometry`. (Per-surface partitioning is overkill for
//      static props — most are single-surface, and the draw-call cost
//      of N×fused dwarfs the visual win.)
//   4. **F#5+6 (LOD + InstancedMesh)** — landed 2026-05-10:
//      - Group placements by `modelId`. Models with `>=2` instances are
//        collapsed into a single `THREE.InstancedMesh` (one draw call
//        instead of N). Singletons stay as plain `THREE.Mesh`.
//      - When the wasm `ModelMesh.didDegrade` is non-zero (rare for
//        Holtburg — most statics have no degrade chain), the full
//        geometry + degraded geometry are wrapped in `THREE.LOD` with
//        the degraded variant kicking in at LOD_DISTANCE_M. This is a
//        no-op for Holtburg models that lack a chain.
//   5. Stash on `scene3d.staticsGroup`.
//
// **Holtburg ground-truth (2026-05-10):**
//   - 222 placements / 66 unique modelIds → average 3.4 instances per
//     model. InstancedMesh collapses ~222 draw calls down to ~66 + any
//     singleton overhead. Big win.
//   - did_degrade chain: needs to be measured empirically. The
//     `staticsSummary` returned by this function reports `lodCount`
//     (how many models had a non-zero didDegrade) so the capture script
//     can verify whether LOD wrapping kicked in at all.

import * as THREE from "three";
import { meshToFusedGeometry, placementToMatrix4 } from "./adapter.js";
import { MaterialCache, materialCanCastShadow } from "./materials.js";

const METERS_PER_LANDBLOCK = 192.0;
const HOLTBURG_X = 0xa9;
const HOLTBURG_Y = 0xb4;

// F#5 — distance at which the renderer swaps from full to degraded
// geometry. AC retail used ~100m for distant-scenery LOD (trees, hill
// foliage). The exact retail threshold isn't preserved in the DAT, so
// we pick a conservative 100m; anything closer than that gets the full
// mesh, anything farther gets the lower-detail variant.
const LOD_DISTANCE_M = 100.0;

/**
 * Top-level builder for Holtburg's static-object set.
 *
 * Returns:
 *   {
 *     objectCount: number,             // placements rendered
 *     modelCount: number,               // unique models with geometry
 *     surfaceCount: number,             // unique surface DIDs preloaded
 *     skippedZeroTri: number,           // placements whose model had 0 tris
 *     skippedNoMesh: number,            // placements whose model failed to fetch
 *     // F#5+6 additions:
 *     instancedGroupCount: number,      // unique models rendered as InstancedMesh (>=2 instances)
 *     singletonCount: number,           // unique models rendered as plain Mesh (1 instance)
 *     lodCount: number,                 // models wrapped in THREE.LOD (didDegrade resolved)
 *     drawCallReductionEstimate: number // placements − (instancedGroups + singletons)
 *   }
 */
export async function buildHoltburgStatics(scene3d, wasmExports) {
  if (!scene3d || !scene3d.staticsGroup) {
    throw new Error("buildHoltburgStatics: scene3d.staticsGroup missing");
  }
  if (
    !wasmExports ||
    typeof wasmExports.fetch_landblock_objects !== "function" ||
    typeof wasmExports.fetch_model_meshes !== "function" ||
    typeof wasmExports.fetch_surfaces_pixels !== "function"
  ) {
    throw new Error(
      "buildHoltburgStatics: wasmExports missing fetch_landblock_objects / fetch_model_meshes / fetch_surfaces_pixels"
    );
  }

  const neighbourhood = [];
  for (let dy = 1; dy >= -1; dy -= 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const lbX = HOLTBURG_X + dx;
      const lbY = HOLTBURG_Y + dy;
      neighbourhood.push({
        x: lbX,
        y: lbY,
        cellId: ((lbX << 24) | (lbY << 16) | 0xfffe) >>> 0,
      });
    }
  }
  const cellIds = new Uint32Array(neighbourhood.map((n) => n.cellId));
  const allPlacements = await wasmExports.fetch_landblock_objects(cellIds);

  // Filter to non-building statics. Snapshot wasm fields into plain
  // objects before freeing the wasm handles — keeping the wasm-side
  // ObjectPlacement around through model + surface fetches risks
  // detached buffers if linear memory grows.
  const statics = [];
  for (const p of allPlacements) {
    if (!p.isBuilding) {
      statics.push({
        landblockId: p.landblockId,
        modelId: p.modelId,
        x: p.x,
        y: p.y,
        z: p.z,
        rotationZ: p.rotationZ,
        isBuilding: false,
      });
    }
    if (typeof p.free === "function") p.free();
  }

  // Unique model ids — one wasm round-trip resolves all geometry.
  const uniqueModelIds = [...new Set(statics.map((s) => s.modelId))];
  if (uniqueModelIds.length === 0) {
    return {
      objectCount: 0,
      modelCount: 0,
      surfaceCount: 0,
      skippedZeroTri: 0,
      skippedNoMesh: 0,
      instancedGroupCount: 0,
      singletonCount: 0,
      lodCount: 0,
      drawCallReductionEstimate: 0,
    };
  }

  let meshes;
  try {
    meshes = await wasmExports.fetch_model_meshes(
      new Uint32Array(uniqueModelIds)
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      "[scene3d.statics] fetch_model_meshes batch failed:",
      e
    );
    return {
      objectCount: 0,
      modelCount: 0,
      surfaceCount: 0,
      skippedZeroTri: 0,
      skippedNoMesh: statics.length,
      instancedGroupCount: 0,
      singletonCount: 0,
      lodCount: 0,
      drawCallReductionEstimate: 0,
    };
  }

  // Build the per-model fused geometry map and collect surface DIDs.
  // Models with 0 triangles (engine anchors, light markers, etc) are
  // recorded as skipped — same as the 2D `invisibleModels` set.
  // Snapshot each model's "dominant surface" (surfaces[0]) BEFORE
  // freeing the wasm handle so the material assignment loop below
  // doesn't read detached memory.
  const geomByModel = new Map();
  const dominantSurfaceByModel = new Map();
  // F#5 — capture did_degrade for each model before the wasm mesh is
  // freed. The degraded DID resolves to a separate geometry via a
  // second fetch_model_meshes call below; 0 means "no degrade chain".
  const didDegradeByModel = new Map();
  const allSurfaceDids = new Set();
  let skippedZeroTri = 0;
  for (let i = 0; i < uniqueModelIds.length; i += 1) {
    const id = uniqueModelIds[i];
    const m = meshes[i];
    if (!m) {
      continue;
    }
    if (m.triCount === 0) {
      skippedZeroTri += 1;
      if (typeof m.free === "function") m.free();
      continue;
    }
    // Snapshot every DID this model references — material cache
    // preloads them in one batch below. Each `surfaces` getter
    // allocates a fresh Uint32Array, so we read once and stash the
    // first entry as the dominant DID.
    const surfacesArr = m.surfaces;
    for (const did of surfacesArr) allSurfaceDids.add(did >>> 0);
    if (surfacesArr.length > 0) {
      dominantSurfaceByModel.set(id, surfacesArr[0] >>> 0);
    }

    // F#5 — snapshot didDegrade. 0 = no degrade chain.
    const dd = (m.didDegrade ?? 0) >>> 0;
    if (dd !== 0) {
      didDegradeByModel.set(id, dd);
    }

    const geom = meshToFusedGeometry(m);
    if (geom) {
      geomByModel.set(id, geom);
    }
    if (typeof m.free === "function") m.free();
  }

  // F#5 — fetch the degraded variant geometry for every model that
  // reports a non-zero didDegrade. One wasm round-trip resolves them
  // all. Failures (degraded DID not in DAT) silently drop to "no LOD"
  // and the model uses a plain Mesh / InstancedMesh.
  const degradedGeomByModel = new Map();
  const degradedIds = [...didDegradeByModel.values()];
  if (degradedIds.length > 0) {
    try {
      const degradedMeshes = await wasmExports.fetch_model_meshes(
        new Uint32Array(degradedIds)
      );
      // Walk the degraded-id list in parallel with the result; map the
      // mesh back to its source model_id.
      let didx = 0;
      for (const [modelId, _degradeId] of didDegradeByModel) {
        const m = degradedMeshes[didx];
        didx += 1;
        if (!m || m.triCount === 0) {
          if (m && typeof m.free === "function") m.free();
          continue;
        }
        const geom = meshToFusedGeometry(m);
        if (geom) degradedGeomByModel.set(modelId, geom);
        if (typeof m.free === "function") m.free();
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        "[scene3d.statics] degraded variant fetch failed (LOD will be no-op):",
        e
      );
    }
  }

  // Preload every surface so even though we use a single dominant
  // material per model for now, the cache is warm for Phase 7.3+
  // refinement. Reuse the same MaterialCache the buildings phase
  // installed so we share the cost.
  // Phase 0.2 — detail tile cache propagation. See buildings.js.
  // Phase 3.3 — CSM bundle propagation. See buildings.js.
  const materialCache =
    scene3d.materialCache ||
    new MaterialCache({
      detailTileCache: scene3d.detailTileCache ?? null,
      forceDetail: !!scene3d.forceDetail,
      csmState: scene3d.csmState ?? null,
      pomEnabled: !!scene3d.pomEnabled,
      forcePom: !!scene3d.forcePom,
    });
  if (allSurfaceDids.size > 0) {
    try {
      await materialCache.preload(
        [...allSurfaceDids],
        wasmExports.fetch_surfaces_pixels
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        "[scene3d.statics] materialCache.preload failed:",
        e
      );
    }
  }
  scene3d.materialCache = materialCache;

  // Pick the "dominant" material per modelId from `surfaces[0]`
  // (first DID listed by the wasm export — typically the model's
  // primary albedo). Falls back to the cache's fallback material if
  // the surface didn't resolve. Per-surface statics is Phase 7.7
  // polish; this gives us "real textures, draw-call-friendly".
  const matByModel = new Map();
  for (const [modelId] of geomByModel) {
    const did = dominantSurfaceByModel.get(modelId);
    if (typeof did === "number" && did !== 0) {
      matByModel.set(modelId, materialCache.getCached(did));
    } else {
      matByModel.set(modelId, materialCache.fallbackMaterial);
    }
  }

  // F#6 — group placements by modelId. Models with >=2 instances get
  // a single InstancedMesh; singletons stay as plain Mesh.
  const placementsByModel = new Map();
  for (const placement of statics) {
    if (!geomByModel.has(placement.modelId)) continue;
    let arr = placementsByModel.get(placement.modelId);
    if (!arr) {
      arr = [];
      placementsByModel.set(placement.modelId, arr);
    }
    arr.push(placement);
  }

  // Helper: build the world-space matrix for one placement. Mirrors
  // the old per-Mesh `position.set` + `quaternion.copy` pattern.
  const tmpQuat = new THREE.Quaternion();
  const tmpAxis = new THREE.Vector3(0, 0, 1);
  const tmpScale = new THREE.Vector3(1, 1, 1);
  const tmpPos = new THREE.Vector3();
  const tmpMat = new THREE.Matrix4();
  function placementMatrix(placement) {
    const lbX = (placement.landblockId >>> 24) & 0xff;
    const lbY = (placement.landblockId >>> 16) & 0xff;
    const worldX = lbX * METERS_PER_LANDBLOCK + placement.x;
    const worldY = lbY * METERS_PER_LANDBLOCK + placement.y;
    tmpPos.set(worldX, worldY, placement.z);
    tmpQuat.setFromAxisAngle(tmpAxis, placement.rotationZ ?? 0);
    tmpMat.compose(tmpPos, tmpQuat, tmpScale);
    return tmpMat;
  }

  // Instantiate placements. For each modelId group, emit one
  // InstancedMesh (or LOD-wrapped InstancedMesh) for groups >=2, or a
  // plain Mesh (or LOD-wrapped Mesh) for singletons.
  let objectCount = 0;
  let skippedNoMesh = 0;
  let instancedGroupCount = 0;
  let singletonCount = 0;
  let lodCount = 0;
  for (const [modelId, group] of placementsByModel) {
    const geom = geomByModel.get(modelId);
    const mat = matByModel.get(modelId) || materialCache.fallbackMaterial;
    const degradedGeom = degradedGeomByModel.get(modelId) || null;
    const modelKey = (modelId >>> 0).toString(16).padStart(8, "0");

    // Visual-fidelity Phase 0.1 — static-object shadow tagging. Statics
    // (props, signs, posts) cast shadows on terrain + buildings; they
    // also receive shadows from buildings. Translucent / additive
    // surfaces are skipped via the material-flag check; the rest get
    // both flags. Effectively a no-op when shadowsEnabled is false.
    // Phase 3.3 — flip on for the CSM path too (mutually exclusive
    // with the single-shadow path; either path needs caster/receiver
    // tagging).
    const staticsShadow = !!scene3d.shadowsEnabled || !!scene3d.csmEnabled;
    const staticsMatCastsShadow = materialCanCastShadow(mat);
    if (group.length >= 2) {
      // === InstancedMesh path ===
      // One draw call per modelId, regardless of placement count.
      const instanced = new THREE.InstancedMesh(geom, mat, group.length);
      instanced.name = `static-instanced-${modelKey}-x${group.length}`;
      instanced.userData = {
        modelId,
        isBuilding: false,
        instanceCount: group.length,
      };
      if (staticsShadow) {
        instanced.castShadow = staticsMatCastsShadow;
        instanced.receiveShadow = true;
      }
      for (let i = 0; i < group.length; i += 1) {
        const m4 = placementMatrix(group[i]);
        instanced.setMatrixAt(i, m4);
      }
      instanced.instanceMatrix.needsUpdate = true;
      // BoundingSphere for the geometry is already computed in
      // meshToFusedGeometry. InstancedMesh additionally needs an
      // aggregate boundingSphere covering all instance positions for
      // accurate frustum culling. three.js's InstancedMesh exposes
      // `computeBoundingSphere()` that walks the per-instance matrices
      // and expands the geometry's sphere.
      instanced.computeBoundingSphere();
      instancedGroupCount += 1;
      objectCount += group.length;

      if (degradedGeom) {
        // Wrap the full + degraded InstancedMesh siblings in a LOD.
        // three.js picks the active child based on distance-from-camera
        // to the LOD object's origin. We give the LOD the same matrix
        // as the first instance so the distance check is meaningful
        // (the LOD's position is a representative point; LOD swap is
        // per-LOD-object, not per-instance, so all instances in this
        // group flip together — fine for Holtburg's small clusters,
        // but worth noting for future agents).
        const degradedInstanced = new THREE.InstancedMesh(
          degradedGeom,
          mat,
          group.length
        );
        degradedInstanced.name = `static-instanced-degraded-${modelKey}`;
        if (staticsShadow) {
          degradedInstanced.castShadow = staticsMatCastsShadow;
          degradedInstanced.receiveShadow = true;
        }
        for (let i = 0; i < group.length; i += 1) {
          const m4 = placementMatrix(group[i]);
          degradedInstanced.setMatrixAt(i, m4);
        }
        degradedInstanced.instanceMatrix.needsUpdate = true;
        degradedInstanced.computeBoundingSphere();

        const lod = new THREE.LOD();
        lod.name = `static-lod-${modelKey}`;
        lod.addLevel(instanced, 0);
        lod.addLevel(degradedInstanced, LOD_DISTANCE_M);
        lod.userData = { modelId, isBuilding: false, isInstancedLod: true };
        scene3d.staticsGroup.add(lod);
        lodCount += 1;
      } else {
        scene3d.staticsGroup.add(instanced);
      }
    } else {
      // === Singleton Mesh path ===
      // Only one placement; InstancedMesh has no draw-call advantage
      // over plain Mesh here (still 1 draw call) AND costs an extra
      // instanceMatrix attribute buffer. Stick with plain Mesh.
      const placement = group[0];
      const lbX = (placement.landblockId >>> 24) & 0xff;
      const lbY = (placement.landblockId >>> 16) & 0xff;
      const worldX = lbX * METERS_PER_LANDBLOCK + placement.x;
      const worldY = lbY * METERS_PER_LANDBLOCK + placement.y;
      const placementKey =
        `${(placement.landblockId >>> 0).toString(16).padStart(8, "0")}_` +
        `${placement.x.toFixed(2)}_${placement.y.toFixed(2)}_${modelKey}`;

      const mesh = new THREE.Mesh(geom, mat);
      mesh.name = `static-${placementKey}`;
      mesh.position.set(worldX, worldY, placement.z);
      const yawQuat = new THREE.Quaternion();
      yawQuat.setFromAxisAngle(
        new THREE.Vector3(0, 0, 1),
        placement.rotationZ ?? 0
      );
      mesh.quaternion.copy(yawQuat);
      mesh.userData = {
        modelId,
        landblockId: placement.landblockId,
        placementKey,
        isBuilding: false,
      };
      if (staticsShadow) {
        mesh.castShadow = staticsMatCastsShadow;
        mesh.receiveShadow = true;
      }
      singletonCount += 1;
      objectCount += 1;

      if (degradedGeom) {
        const degradedMesh = new THREE.Mesh(degradedGeom, mat);
        degradedMesh.name = `static-degraded-${placementKey}`;
        if (staticsShadow) {
          degradedMesh.castShadow = staticsMatCastsShadow;
          degradedMesh.receiveShadow = true;
        }
        degradedMesh.position.copy(mesh.position);
        degradedMesh.quaternion.copy(mesh.quaternion);
        degradedMesh.userData = {
          modelId,
          landblockId: placement.landblockId,
          placementKey,
          isBuilding: false,
          isDegraded: true,
        };
        const lod = new THREE.LOD();
        lod.name = `static-lod-${placementKey}`;
        lod.position.copy(mesh.position);
        lod.quaternion.copy(mesh.quaternion);
        // Children of LOD inherit no transform unless explicitly
        // applied — three.js LOD positions its children at the LOD's
        // own transform, and the per-child mesh's position becomes a
        // local offset. Reset the child positions to identity so the
        // LOD's transform alone places the cluster.
        mesh.position.set(0, 0, 0);
        mesh.quaternion.identity();
        degradedMesh.position.set(0, 0, 0);
        degradedMesh.quaternion.identity();
        lod.addLevel(mesh, 0);
        lod.addLevel(degradedMesh, LOD_DISTANCE_M);
        lod.userData = {
          modelId,
          landblockId: placement.landblockId,
          placementKey,
          isBuilding: false,
        };
        scene3d.staticsGroup.add(lod);
        lodCount += 1;
      } else {
        scene3d.staticsGroup.add(mesh);
      }
    }
  }

  // Count placements that had no geometry (the model failed to fetch
  // OR was 0-tri AND got dropped from `geomByModel`). The
  // `skippedZeroTri` count is per-model; `skippedNoMesh` here is
  // per-placement of models we couldn't render.
  for (const placement of statics) {
    if (!geomByModel.has(placement.modelId)) skippedNoMesh += 1;
  }

  // Draw-call savings: full per-placement Mesh path would have
  // produced `objectCount` draw calls. Instancing collapses each
  // multi-instance group to 1. Singletons remain 1 each. So the
  // post-fix draw call count for statics is
  // `instancedGroupCount + singletonCount`.
  const drawCallReductionEstimate =
    objectCount - (instancedGroupCount + singletonCount);

  return {
    objectCount,
    modelCount: geomByModel.size,
    surfaceCount: allSurfaceDids.size,
    skippedZeroTri,
    skippedNoMesh,
    instancedGroupCount,
    singletonCount,
    lodCount,
    drawCallReductionEstimate,
  };
}
