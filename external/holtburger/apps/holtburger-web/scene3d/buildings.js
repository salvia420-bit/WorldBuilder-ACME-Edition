// Phase 7.2 — building rigs.
//
// Replaces the 2D path's `bakePerPartBuildingTextures` (drops the
// PIXI.RenderTexture flatten) and `buildBuildingsContainer`
// (PIXI.Container → THREE.Group). The output topology mirrors the 2D
// path so Phase 7.3+ door rotation can address parts the same way:
//
//   buildingsGroup
//     └─ THREE.Group (one per placement, named "building-<key>")
//         ├─ THREE.Group (per-part hinge wrapper at hingeFrame.x/y/z)
//         │   └─ THREE.Mesh (per-surface mesh under that part)
//         │   └─ THREE.Mesh (additional surface mesh, if multi-surface)
//         └─ THREE.Group (next part; identity hinge for non-doors)
//
// This is the topology Phase 7.3+ will exploit for door rotation —
// rotating a hinge wrapper rotates the part (and all its per-surface
// meshes) around the hinge axis. Non-door parts have identity hinge
// frames and are never rotated; the wrapper is a no-op for them.
//
// Holtburg specifically (per migration auto-memory) has only `0x01`
// raw GfxObj single-part buildings — every building's `partCount` is
// 1. The structure must still produce the full Group → hinge-Group →
// Mesh tree to match the future-phase contract.
//
// **F#5+6 (LOD + InstancedMesh) — landed 2026-05-10:**
//
// InstancedMesh would collapse N duplicate-modelId buildings into one
// draw call per modelId, but buildings have per-placement state (door
// rotation, AABB lookup, surface-material variation) that the per-
// placement Group tree supports today. InstancedMesh treats all
// instances as visually identical — flipping `Object3D.rotation.z` on
// a hinge wrapper for ONE placement would silently affect ALL of them.
// **Holtburg ground-truth: 14 unique modelIds across 16 placements →
// only 2 buildings duplicate. InstancedMesh would save at most 2 draw
// calls AND would break the per-placement door rotation contract.
// Net: this is a documented no-op for buildings, NOT a performance
// improvement worth the structural disruption.** If Holtburg grew to a
// 100-instance shanty town, the right move would be to per-part
// InstancedMesh under each placement Group; the current static-per-
// part-Mesh tree is the wrong granularity for that. For now buildings
// stay as plain `THREE.Mesh` leaves under per-placement Groups.
//
// **LOD via `didDegrade`** — buildings' didDegrade chain lives on each
// part GfxObj (not on the SetupModel). The current per-part fused
// MeshStandardMaterial bake doesn't lend itself to a per-part LOD swap
// without rebuilding the bake topology. **Most Holtburg buildings are
// `0x01` raw GfxObjs (no SetupModel, no degrade chain) so the bake
// pass through `resolve_did_degrade` returns 0 for them anyway.**
// `buildingDidDegradeCount` is reported in the returned summary so the
// capture script can verify the count (typically 0) — this is the
// honest measurement, not faked savings.

import * as THREE from "three";
import {
  meshToGeometryGroups,
  placementToMatrix4,
  acQuatToThree,
} from "./adapter.js";
import { MaterialCache, materialCanCastShadow } from "./materials.js";

const METERS_PER_LANDBLOCK = 192.0;
const HOLTBURG_X = 0xa9;
const HOLTBURG_Y = 0xb4;

/**
 * Per-Setup-model bake: drains a `BuildingPlacement` returned by
 * `fetchBuildingPlacement(modelId)` into JS-owned data — one
 * `BufferGeometry` group list per part, plus the per-part hinge
 * frame, plus the union of surface DIDs referenced.
 *
 * Result shape:
 *   {
 *     modelId: u32,
 *     setupId: u32,
 *     parts: [
 *       {
 *         partIndex: number,
 *         groups: [{ geometry, surfaceDid }],   // empty for 0-tri parts
 *         hinge: { x, y, z, qw, qx, qy, qz }    // identity for non-doors
 *       }
 *     ],
 *     surfaceDids: Set<u32>
 *   }
 *
 * The `BuildingPlacement` and its child `ModelMesh` / `HingeFrame`
 * handles are freed before this function returns — caller receives
 * pure JS-owned data.
 */
async function bakeBuildingPlacement(modelId, fetchBuildingPlacement) {
  let bundle;
  try {
    bundle = await fetchBuildingPlacement(modelId);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[scene3d.buildings] fetchBuildingPlacement(0x${(modelId >>> 0).toString(16)}) failed:`,
      e
    );
    return null;
  }

  const setupId = bundle.setupId >>> 0;
  const partCount = bundle.partCount | 0;
  if (partCount === 0) {
    if (typeof bundle.free === "function") bundle.free();
    return {
      modelId,
      setupId,
      parts: [],
      surfaceDids: new Set(),
    };
  }

  const meshes = bundle.takePartMeshes();
  const hinges = bundle.takePartHingeFrames();
  if (typeof bundle.free === "function") bundle.free();

  const surfaceDids = new Set();
  const parts = new Array(meshes.length);
  for (let pi = 0; pi < meshes.length; pi += 1) {
    const mesh = meshes[pi];
    const hinge = hinges[pi];
    // Snapshot the hinge into a plain object before freeing the wasm
    // handle — three.js needs to keep its values around for as long
    // as the building Group lives.
    const hingeSnapshot = hinge
      ? {
          x: hinge.x,
          y: hinge.y,
          z: hinge.z,
          qw: hinge.qw,
          qx: hinge.qx,
          qy: hinge.qy,
          qz: hinge.qz,
        }
      : { x: 0, y: 0, z: 0, qw: 1, qx: 0, qy: 0, qz: 0 };
    if (hinge && typeof hinge.free === "function") hinge.free();

    const { groups, surfaceDids: dids } = meshToGeometryGroups(mesh);
    for (const did of dids) surfaceDids.add(did);

    parts[pi] = {
      partIndex: pi,
      groups,
      hinge: hingeSnapshot,
    };
    if (typeof mesh.free === "function") mesh.free();
  }

  return {
    modelId,
    setupId,
    parts,
    surfaceDids,
  };
}

/**
 * Instantiate one building from a per-model bake.
 *
 *   placement: { x, y, z, rotationZ, modelId, landblockId, isBuilding }
 *              — the wasm `ObjectPlacement` shape (rotationZ-only;
 *              wasm pre-extracts yaw, see `lib.rs:692-708`).
 *   bake: from `bakeBuildingPlacement(modelId, …)`.
 *   materialCache: shared `MaterialCache` (preloaded with the bake's
 *                  surface DIDs).
 *   worldOffset: `{ x, y }` — landblock NW-corner world offset (lbX*192,
 *                lbY*192). Combined with the placement's local x/y to
 *                place the Group in scene-world coords.
 *
 * Returns a `THREE.Group` ready to be added under `scene3d.buildingsGroup`.
 *
 * Topology matches the 2D path's per-part hinge-wrapper convention:
 *   placementGroup (set to world position + yaw rotation)
 *     └─ hingeWrapper (one per part, set to hinge.x/y/z + hinge quat)
 *         └─ surfaceMesh (one per group from meshToGeometryGroups)
 *         └─ surfaceMesh (next surface, if part has multiple)
 *
 * Each `THREE.Mesh` carries `userData = { modelId, partIndex, surfaceDid }`
 * so future phases can address by part for door rotation, AABB lookup,
 * etc.
 */
function buildOneBuilding(placement, bake, materialCache, worldOffset, shadowsEnabled) {
  const placementKey =
    `${(placement.landblockId >>> 0).toString(16).padStart(8, "0")}_` +
    `${placement.x.toFixed(2)}_${placement.y.toFixed(2)}_` +
    `${(placement.modelId >>> 0).toString(16).padStart(8, "0")}`;

  const placementGroup = new THREE.Group();
  placementGroup.name = `building-${placementKey}`;
  // World position = landblock NW + placement-local. AC's
  // `ObjectPlacement.x/y/z` is metres relative to the LB NW corner
  // (per `lib.rs:600-602`).
  placementGroup.position.set(
    worldOffset.x + placement.x,
    worldOffset.y + placement.y,
    placement.z
  );
  // Yaw-only rotation around AC +Z. The 2D path negates this
  // (`buildingContainer.rotation = -obj.rotationZ`) because PIXI flips
  // Y at the world root with `scale.y = -1`. The 3D path keeps AC
  // handedness (worldRoot rotation.x = -π/2 is a single rotation, not
  // a flip), so we DON'T negate. If buildings end up mirrored after
  // visual inspection, flip the sign here.
  const yawQuat = new THREE.Quaternion();
  yawQuat.setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    placement.rotationZ ?? 0
  );
  placementGroup.quaternion.copy(yawQuat);
  placementGroup.userData = {
    modelId: placement.modelId,
    landblockId: placement.landblockId,
    placementKey,
    isBuilding: true,
    partGroups: [], // filled below; per-part hinge wrappers
  };

  let partsAdded = 0;
  for (const part of bake.parts) {
    // Even empty (0-tri) parts get a hinge wrapper so the partIndex
    // → wrapper map stays dense. Phase 7.3+ door state lookups
    // address by partIndex; a missing slot would force special-case
    // logic on every door open/close.
    const hingeWrapper = new THREE.Group();
    hingeWrapper.name = `part-${part.partIndex}`;
    hingeWrapper.position.set(part.hinge.x, part.hinge.y, part.hinge.z);
    hingeWrapper.quaternion.copy(
      acQuatToThree(part.hinge.qw, part.hinge.qx, part.hinge.qy, part.hinge.qz)
    );
    hingeWrapper.userData = {
      modelId: placement.modelId,
      partIndex: part.partIndex,
      hinge: part.hinge,
      // Phase 7.3+ door rotation reads/writes this. closed = 0.
      doorRotationRad: 0,
    };

    for (const g of part.groups) {
      const mat = materialCache.getCached(g.surfaceDid);
      const mesh = new THREE.Mesh(g.geometry, mat);
      mesh.name = `surface-${g.surfaceDid.toString(16).padStart(8, "0")}`;
      mesh.userData = {
        modelId: placement.modelId,
        partIndex: part.partIndex,
        surfaceDid: g.surfaceDid,
      };
      // Visual-fidelity Phase 0.1 — buildings cast AND receive shadows.
      // Walls cast onto neighbouring buildings + terrain; walls also
      // receive shadows from other buildings. `castShadow` is gated on
      // the surface's translucent/additive flag because three.js's
      // shadow pass renders depth-only (no alpha blending), so a
      // translucent quad would cast a solid-rectangle shadow. The
      // material-flag check is centralised in materials.js.
      if (shadowsEnabled) {
        mesh.castShadow = materialCanCastShadow(mat);
        mesh.receiveShadow = true;
      }
      hingeWrapper.add(mesh);
      partsAdded += 1;
    }

    placementGroup.add(hingeWrapper);
    placementGroup.userData.partGroups.push(hingeWrapper);
  }

  return { group: placementGroup, surfaceMeshCount: partsAdded };
}

/**
 * Top-level builder for Holtburg's building set. Mirrors the 2D
 * path's load flow:
 *   1. fetch_landblock_objects(NEIGHBOURHOOD ids, suffix 0xfffe).
 *   2. Filter `isBuilding === true` → unique modelIds.
 *   3. bakeBuildingPlacement() each in parallel.
 *   4. Preload all surface DIDs in one wasm round-trip via
 *      `materialCache.preload()`.
 *   5. For each building placement, `buildOneBuilding()` → add to
 *      `scene3d.buildingsGroup`.
 *   6. Stash `window.buildingMap3d = Map<placementKey, Group>` mirroring
 *      the 2D `window.buildingMap`.
 *
 * Returns:
 *   {
 *     buildingCount: number,           // placements rendered
 *     uniqueModelCount: number,        // unique modelIds baked
 *     partCount: number,               // sum of per-building part wrappers
 *     surfaceMeshCount: number,        // sum of surface-group meshes
 *     surfaceCount: number,            // unique surface DIDs in cache
 *     resolvedMaterials: number,       // materialCache.materials.size
 *     fallbackHits: number,            // materialCache.fallbackHits at end
 *     realHits: number                 // materialCache.realHits at end
 *   }
 *
 * Required wasmExports keys: `fetch_landblock_objects`,
 * `fetchBuildingPlacement`, `fetch_surfaces_pixels`. If any are
 * missing the function throws.
 */
export async function buildHoltburgBuildings(scene3d, wasmExports) {
  if (!scene3d || !scene3d.buildingsGroup) {
    throw new Error(
      "buildHoltburgBuildings: scene3d.buildingsGroup missing"
    );
  }
  if (
    !wasmExports ||
    typeof wasmExports.fetch_landblock_objects !== "function" ||
    typeof wasmExports.fetchBuildingPlacement !== "function" ||
    typeof wasmExports.fetch_surfaces_pixels !== "function"
  ) {
    throw new Error(
      "buildHoltburgBuildings: wasmExports missing fetch_landblock_objects / fetchBuildingPlacement / fetch_surfaces_pixels"
    );
  }

  // Build the 9-LB neighbourhood cell-id list. `0xfffe` suffix selects
  // LandblockInfo (objects + buildings) — `0xffff` is the terrain
  // CellLandblock and won't return placements.
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

  // Fetch all placements (buildings + objects). Filter buildings
  // here; the statics path filters !isBuilding from the same list.
  // Rather than call wasm twice, the caller (buildHoltburgStatics)
  // can re-fetch — but if they share, that doubles the wasm call.
  // We'll have buildings call wasm once; statics calls wasm once.
  // (Caching across the two calls is a Phase 7.7 polish; for now the
  // wasm side caches its own DAT shard reads, so the cost is the
  // marshalling of placement records, ~1ms per LB.)
  const allPlacements = await wasmExports.fetch_landblock_objects(cellIds);
  const buildings = [];
  for (const p of allPlacements) {
    if (p.isBuilding) {
      buildings.push({
        landblockId: p.landblockId,
        modelId: p.modelId,
        x: p.x,
        y: p.y,
        z: p.z,
        rotationZ: p.rotationZ,
        isBuilding: true,
      });
    }
    if (typeof p.free === "function") p.free();
  }

  // Bake every unique model id in parallel.
  const uniqueModelIds = [...new Set(buildings.map((b) => b.modelId))];
  const bakes = new Map();
  const bakeResults = await Promise.all(
    uniqueModelIds.map((id) =>
      bakeBuildingPlacement(id, wasmExports.fetchBuildingPlacement)
    )
  );
  for (let i = 0; i < uniqueModelIds.length; i += 1) {
    if (bakeResults[i]) {
      bakes.set(uniqueModelIds[i], bakeResults[i]);
    }
  }

  // F#5 (LOD) — query the `did_degrade` chain for each unique building
  // modelId. The buildings path uses `fetchBuildingPlacement` (not
  // `fetch_model_meshes`) and `BuildingPlacement` doesn't carry
  // `didDegrade` on its own, so we look it up via the lightweight
  // `fetchModelDidDegrades` wasm export.
  //
  // **Holtburg ground-truth**: Holtburg buildings are mostly `0x01`
  // raw GfxObjs, and inspecting the DAT reveals very few of them carry
  // the `HAS_DID_DEGRADE` flag — the typical Holtburg load returns all
  // zeros here. This is the honest measurement, not a faked savings:
  // see the `buildingDidDegradeCount` field in the returned summary.
  // The LOD wrapping itself isn't applied to buildings because the
  // per-placement Group → hinge-wrapper → per-surface-Mesh tree carries
  // per-placement door rotation state that a `THREE.LOD` swap would
  // disturb. We measure the chain count so a future agent porting LOD
  // to a denser city (or to dungeons) sees the data.
  let didDegradeByModel = new Map();
  let buildingDidDegradeCount = 0;
  if (typeof wasmExports.fetchModelDidDegrades === "function" && uniqueModelIds.length > 0) {
    try {
      const ddResults = await wasmExports.fetchModelDidDegrades(
        new Uint32Array(uniqueModelIds)
      );
      for (let i = 0; i < uniqueModelIds.length; i += 1) {
        const dd = (ddResults[i] ?? 0) >>> 0;
        if (dd !== 0) {
          didDegradeByModel.set(uniqueModelIds[i], dd);
          buildingDidDegradeCount += 1;
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        "[scene3d.buildings] fetchModelDidDegrades failed — LOD audit skipped:",
        e
      );
    }
  }

  // Preload every referenced surface DID in one wasm round-trip.
  const allSurfaceDids = new Set();
  for (const bake of bakes.values()) {
    for (const did of bake.surfaceDids) allSurfaceDids.add(did);
  }
  const materialCache =
    scene3d.materialCache || new MaterialCache();
  if (allSurfaceDids.size > 0) {
    try {
      await materialCache.preload(
        [...allSurfaceDids],
        wasmExports.fetch_surfaces_pixels
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        "[scene3d.buildings] materialCache.preload failed:",
        e
      );
    }
  }

  // Instantiate each building placement.
  const buildingMap3d = new Map();
  let partCount = 0;
  let surfaceMeshCount = 0;
  for (const placement of buildings) {
    const lbX = (placement.landblockId >>> 24) & 0xff;
    const lbY = (placement.landblockId >>> 16) & 0xff;
    const worldOffset = {
      x: lbX * METERS_PER_LANDBLOCK,
      y: lbY * METERS_PER_LANDBLOCK,
    };
    const bake = bakes.get(placement.modelId);
    if (!bake) {
      // No bake for this modelId — the bake call failed earlier;
      // skip with a warning rather than crash. (The 2D path
      // falls back to a fused single-sprite here; for 3D we'd need
      // to fetch_model_meshes to do the same, which is Phase 7.7
      // polish.)
      continue;
    }
    const { group, surfaceMeshCount: smc } = buildOneBuilding(
      placement,
      bake,
      materialCache,
      worldOffset,
      !!scene3d.shadowsEnabled
    );
    scene3d.buildingsGroup.add(group);
    partCount += bake.parts.length;
    surfaceMeshCount += smc;
    buildingMap3d.set(group.userData.placementKey, group);
  }

  // Stash on window mirroring the 2D path's `window.buildingMap`.
  // Capture scripts and Phase 7.3+ door logic both look here.
  window.buildingMap3d = buildingMap3d;
  scene3d.materialCache = materialCache;
  scene3d.buildingMap3d = buildingMap3d;
  scene3d.buildingBakeCache = bakes;

  return {
    buildingCount: buildingMap3d.size,
    uniqueModelCount: bakes.size,
    partCount,
    surfaceMeshCount,
    surfaceCount: allSurfaceDids.size,
    resolvedMaterials: materialCache.materials.size,
    fallbackHits: materialCache.fallbackHits,
    realHits: materialCache.realHits,
    // F#5 — count of unique building modelIds that report a non-zero
    // `did_degrade` chain entry (typically 0 for Holtburg; see the
    // comment-block header for why LOD isn't wired into the building
    // path itself). Capture script reads this to report the grounded
    // measurement.
    buildingDidDegradeCount,
    // F#6 — number of duplicate building modelIds (buildings −
    // uniqueModelIds). For Holtburg this is 16 - 14 = 2; InstancedMesh
    // would have saved at most 2 draw calls and would have broken the
    // per-placement door-rotation contract. Reported for honesty, NOT
    // for any actual instancing here.
    buildingDuplicateModelCount: buildings.length - uniqueModelIds.length,
  };
}
