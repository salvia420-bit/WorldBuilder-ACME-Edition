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
 * Resolve the once-per-ring opts used by `bakeBuildingsForLandblock`.
 * The driver calls this once; the per-LB baker re-reads the resolved
 * fields without re-allocating.
 *
 * `bakeCache: Map<modelId, bake>` is the shared per-Setup-model bake
 * cache — populated lazily as LBs are baked. Holtburg's 14 unique
 * modelIds across 16 placements means a 13×13 ring (~46 buildings)
 * still hits the cache for the majority of placements. Without the
 * shared cache the lazy hook would re-fetch each modelId per LB
 * entry — at 169 LBs that's ~169 × O(unique-models) wasm calls.
 */
function resolveBuildingsOpts(scene3d) {
  const materialCache =
    scene3d.materialCache ||
    new MaterialCache({
      detailTileCache: scene3d.detailTileCache ?? null,
      forceDetail: !!scene3d.forceDetail,
      csmState: scene3d.csmState ?? null,
      pomEnabled: !!scene3d.pomEnabled,
      forcePom: !!scene3d.forcePom,
    });
  // Stash on scene3d so subsequent ring calls (and the lazy hook in
  // Objective 6) share the same MaterialCache. Phase 7.3 EnvCells +
  // Phase 7.2 statics also share this cache — the very first ring
  // bake to install it wins; subsequent installs are no-ops.
  scene3d.materialCache = materialCache;

  return {
    bakeCache: scene3d.buildingBakeCache instanceof Map
      ? scene3d.buildingBakeCache
      : new Map(),
    buildingMap3d: scene3d.buildingMap3d instanceof Map
      ? scene3d.buildingMap3d
      : new Map(),
    materialCache,
    // Phase 3.3 — flip castShadow + receiveShadow on when EITHER the
    // Phase 0.1 single-shadow path OR the CSM path is active. The
    // two paths share the same caster/receiver tagging — only the
    // shadow-map projection differs. Captured once at ring entry.
    shadowsEnabled: !!scene3d.shadowsEnabled || !!scene3d.csmEnabled,
  };
}

/**
 * Bake ONE landblock's buildings. Idempotent via
 * `scene3d.buildingsBakedLbs: Set<u32>` keyed by
 * `(lbX << 24) | (lbY << 16)`.
 *
 * Pipeline (mirrors the legacy `buildHoltburgBuildings` body but
 * scoped to a single LB):
 *   1. `fetch_landblock_objects(new Uint32Array([cellId]))` for this
 *      LB only (cellId = `lbKey | 0xfffe` selects LandblockInfo).
 *   2. Filter `isBuilding === true`.
 *   3. For each unique modelId in THIS LB, hit-check `opts.bakeCache`;
 *      on miss, call `bakeBuildingPlacement` and populate the cache.
 *      This is the per-Setup-model fused-mesh bake — across a 169-LB
 *      ring with ~14 unique Aluvian cottage / shop models, the cache
 *      hit rate is high.
 *   4. Preload referenced surface DIDs through `opts.materialCache`.
 *      MaterialCache.preload is idempotent on already-loaded DIDs so
 *      cross-LB redundancy is a cheap dedupe.
 *   5. Instantiate each placement (per-placement `THREE.Group` with
 *      per-part hinge wrappers — door rotation contract is preserved
 *      verbatim from the legacy body).
 *   6. Stash each Group in `opts.buildingMap3d` AND mirror to
 *      `scene3d.buildingMap3d` + `window.buildingMap3d` so the
 *      door-rotation `findClosestBuildingPart` spatial-match path
 *      (index.html:4367) keeps working at ring scope.
 *
 * Returns this LB's contribution:
 *   {
 *     idempotent: bool,       // true if LB was already baked
 *     placementCount: number, // placements rendered in this LB
 *     modelCount: number,     // unique modelIds in this LB (cache hit + miss)
 *     surfaceCount: number,   // unique surface DIDs in this LB
 *     partCount: number,      // sum of per-building part wrappers
 *     surfaceMeshCount: number, // sum of surface-group meshes
 *   }
 */
export async function bakeBuildingsForLandblock(
  scene3d,
  lbX,
  lbY,
  opts,
  wasmExports
) {
  if (!scene3d || !scene3d.buildingsGroup) {
    throw new Error(
      "bakeBuildingsForLandblock: scene3d.buildingsGroup missing"
    );
  }
  if (
    !wasmExports ||
    typeof wasmExports.fetch_landblock_objects !== "function" ||
    typeof wasmExports.fetchBuildingPlacement !== "function" ||
    typeof wasmExports.fetch_surfaces_pixels !== "function"
  ) {
    throw new Error(
      "bakeBuildingsForLandblock: wasmExports missing fetch_landblock_objects / fetchBuildingPlacement / fetch_surfaces_pixels"
    );
  }
  if (!opts || !(opts.bakeCache instanceof Map) || !opts.materialCache) {
    throw new Error(
      "bakeBuildingsForLandblock: opts missing bakeCache / materialCache — call resolveBuildingsOpts first"
    );
  }

  if (!(scene3d.buildingsBakedLbs instanceof Set)) {
    scene3d.buildingsBakedLbs = new Set();
  }
  const lbKey = (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16)) >>> 0;
  if (scene3d.buildingsBakedLbs.has(lbKey)) {
    return {
      idempotent: true,
      placementCount: 0,
      modelCount: 0,
      surfaceCount: 0,
      partCount: 0,
      surfaceMeshCount: 0,
    };
  }
  scene3d.buildingsBakedLbs.add(lbKey);

  // Step 1 — fetch this LB's placements. The `0xfffe` suffix selects
  // LandblockInfo (objects + buildings); `0xffff` is the terrain
  // CellLandblock and won't return placements.
  const cellId = (lbKey | 0xfffe) >>> 0;
  const allPlacements = await wasmExports.fetch_landblock_objects(
    new Uint32Array([cellId])
  );

  // Step 2 — filter buildings, snapshot to JS-owned plain objects,
  // and free the wasm side. The statics path filters !isBuilding from
  // a separate wasm call (no shared state across the two readers).
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

  if (buildings.length === 0) {
    // Empty LB (most of the 13×13 ring's outer LBs are wilderness).
    // Still counts as baked so the idempotency set holds.
    return {
      idempotent: false,
      placementCount: 0,
      modelCount: 0,
      surfaceCount: 0,
      partCount: 0,
      surfaceMeshCount: 0,
    };
  }

  // Step 3 — bake unique modelIds for this LB, hit-checking the
  // ring-shared cache. Holtburg ground truth: 14 unique modelIds
  // across 16 placements (memory note at top of file). Across a
  // larger ring most LBs hit the cache for every building.
  const uniqueModelIds = [...new Set(buildings.map((b) => b.modelId))];
  const toBake = uniqueModelIds.filter((id) => !opts.bakeCache.has(id));
  if (toBake.length > 0) {
    const bakeResults = await Promise.all(
      toBake.map((id) =>
        bakeBuildingPlacement(id, wasmExports.fetchBuildingPlacement)
      )
    );
    for (let i = 0; i < toBake.length; i += 1) {
      if (bakeResults[i]) {
        opts.bakeCache.set(toBake[i], bakeResults[i]);
      }
    }
  }

  // Step 4 — preload referenced surface DIDs for this LB's bakes.
  // MaterialCache.preload is idempotent on already-loaded DIDs, so
  // cross-LB redundancy is filtered at the cache layer (see
  // materials.js:1207 `if (this.materials.has(d)) continue`).
  const lbSurfaceDids = new Set();
  for (const id of uniqueModelIds) {
    const bake = opts.bakeCache.get(id);
    if (!bake) continue;
    for (const did of bake.surfaceDids) lbSurfaceDids.add(did);
  }
  if (lbSurfaceDids.size > 0) {
    try {
      await opts.materialCache.preload(
        [...lbSurfaceDids],
        wasmExports.fetch_surfaces_pixels
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[scene3d.buildings] materialCache.preload failed for lb 0x${lbKey.toString(16)}:`,
        e
      );
    }
  }

  // Step 5 — instantiate each building placement in this LB. The
  // per-placement Group → hinge wrapper → per-surface Mesh topology
  // is the door-rotation contract (Phase 7.3+); preserved verbatim
  // by routing through `buildOneBuilding`.
  let partCount = 0;
  let surfaceMeshCount = 0;
  for (const placement of buildings) {
    const placementLbX = (placement.landblockId >>> 24) & 0xff;
    const placementLbY = (placement.landblockId >>> 16) & 0xff;
    const worldOffset = {
      x: placementLbX * METERS_PER_LANDBLOCK,
      y: placementLbY * METERS_PER_LANDBLOCK,
    };
    const bake = opts.bakeCache.get(placement.modelId);
    if (!bake) {
      // No bake for this modelId — the bake call failed earlier;
      // skip with a warning rather than crash. The 2D path falls
      // back to a fused single-sprite here; the 3D fallback is
      // Phase 7.7 polish (out of scope for the world-expand step 1
      // refactor).
      continue;
    }
    const { group, surfaceMeshCount: smc } = buildOneBuilding(
      placement,
      bake,
      opts.materialCache,
      worldOffset,
      opts.shadowsEnabled
    );
    scene3d.buildingsGroup.add(group);
    partCount += bake.parts.length;
    surfaceMeshCount += smc;
    opts.buildingMap3d.set(group.userData.placementKey, group);
  }

  return {
    idempotent: false,
    placementCount: buildings.length,
    modelCount: uniqueModelIds.length,
    surfaceCount: lbSurfaceDids.size,
    partCount,
    surfaceMeshCount,
  };
}

/**
 * Ring driver: bakes every LB in `[centreLbX-radius, centreLbX+radius]
 * × [centreLbY-radius, centreLbY+radius]` (clamped to `[0, 255]^2`)
 * via `bakeBuildingsForLandblock`. Returns the aggregated summary in
 * the legacy `buildHoltburgBuildings` shape so existing callers
 * (capture scripts, init3D summary log line) keep working.
 *
 * The ring-shared `bakeCache` is created here and threaded through
 * `opts` to each per-LB call — across a 169-LB ring with ~14-100
 * unique building models, this collapses what would otherwise be
 * 169 × O(unique) wasm fetches into one fetch per truly-unique model.
 *
 * After the ring bakes:
 *   - F#5 LOD didDegrade audit runs once on the union of unique
 *     modelIds (cache keys). Reporting only; the per-placement Group
 *     contract still wins over LOD swap for buildings.
 *   - `scene3d.materialCache` / `scene3d.buildingMap3d` /
 *     `scene3d.buildingBakeCache` are stashed so subsequent ring
 *     bakes (or the Objective 6 lazy hook) share state.
 *   - `window.buildingMap3d` mirrors `scene3d.buildingMap3d` so the
 *     door-rotation `findClosestBuildingPart` lookup in index.html
 *     keeps working at ring scope.
 */
export async function bakeBuildingsRing(
  scene3d,
  centreLbX,
  centreLbY,
  radius,
  wasmExports
) {
  if (!scene3d || !scene3d.buildingsGroup) {
    throw new Error("bakeBuildingsRing: scene3d.buildingsGroup missing");
  }
  if (
    !wasmExports ||
    typeof wasmExports.fetch_landblock_objects !== "function" ||
    typeof wasmExports.fetchBuildingPlacement !== "function" ||
    typeof wasmExports.fetch_surfaces_pixels !== "function"
  ) {
    throw new Error(
      "bakeBuildingsRing: wasmExports missing fetch_landblock_objects / fetchBuildingPlacement / fetch_surfaces_pixels"
    );
  }

  const opts = resolveBuildingsOpts(scene3d);
  // World-expand step 1 Objective 5 — persist the resolved ring opts
  // on scene3d so the `liveScene3d.loadBuildingsForLandblock(lbX, lbY)`
  // lazy hook in `scene3d/index.js` can call `bakeBuildingsForLandblock`
  // without redoing the MaterialCache / bakeCache wiring. Persist
  // BEFORE the per-LB fan-out runs so a concurrent caller observing
  // mid-ring state (e.g. an early `handlePositionUpdate` fired by a
  // login-flow position event arriving before the ring resolves) sees
  // a populated opts bag. The bag carries references to the SAME
  // `bakeCache` / `materialCache` / `buildingMap3d` maps — not copies
  // — so lazy adds extend the same caches the ring populates.
  scene3d.buildingsOpts = opts;

  // Fan out the per-LB bakes. Each call is independent (per-LB wasm
  // fetch + per-LB instantiation); the shared bakeCache is read-then-
  // populate so concurrent misses on the same modelId can race —
  // tolerable because `bakeBuildingPlacement` is deterministic and
  // the second write wins (a harmless replace of identical data).
  // At radius=1 (9 LBs) the cost is 9 sequential-ish wasm calls
  // instead of one batched 9-LB call; at radius=6 (169 LBs) it's
  // 169 small fetches. The wasm side caches its own DAT shard reads,
  // so the marginal cost is the marshalling per call.
  const perLbSummaries = [];
  const promises = [];
  for (let dy = radius; dy >= -radius; dy -= 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const lbX = centreLbX + dx;
      const lbY = centreLbY + dy;
      if (lbX < 0 || lbX > 0xff || lbY < 0 || lbY > 0xff) continue;
      promises.push(
        bakeBuildingsForLandblock(scene3d, lbX, lbY, opts, wasmExports).then(
          (s) => {
            perLbSummaries.push(s);
            return s;
          }
        )
      );
    }
  }
  await Promise.all(promises);

  // F#5 (LOD) — query the `did_degrade` chain for each unique
  // building modelId baked into the ring. The buildings path uses
  // `fetchBuildingPlacement` (not `fetch_model_meshes`) and
  // `BuildingPlacement` doesn't carry `didDegrade` on its own, so we
  // look it up via the lightweight `fetchModelDidDegrades` wasm
  // export. The audit is once-per-ring (not once-per-LB) because the
  // wasm call is batched on unique modelIds.
  //
  // **Holtburg ground-truth**: Holtburg buildings are mostly `0x01`
  // raw GfxObjs, and inspecting the DAT reveals very few of them
  // carry the `HAS_DID_DEGRADE` flag — the typical Holtburg load
  // returns all zeros here. This is the honest measurement, not a
  // faked savings: see `buildingDidDegradeCount` in the returned
  // summary. The LOD wrapping itself isn't applied to buildings
  // because the per-placement Group → hinge-wrapper →
  // per-surface-Mesh tree carries per-placement door rotation state
  // that a `THREE.LOD` swap would disturb.
  const uniqueModelIds = [...opts.bakeCache.keys()];
  let buildingDidDegradeCount = 0;
  if (
    typeof wasmExports.fetchModelDidDegrades === "function" &&
    uniqueModelIds.length > 0
  ) {
    try {
      const ddResults = await wasmExports.fetchModelDidDegrades(
        new Uint32Array(uniqueModelIds)
      );
      for (let i = 0; i < uniqueModelIds.length; i += 1) {
        const dd = (ddResults[i] ?? 0) >>> 0;
        if (dd !== 0) {
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

  // Aggregate the per-LB summaries into the legacy shape.
  let buildingCount = 0;
  let partCount = 0;
  let surfaceMeshCount = 0;
  // Surface DID union across the ring is the materialCache's resolved
  // set size after preload. (Per-LB `surfaceCount` overlaps across LBs;
  // the cache-resolved size is the de-duplicated truth.)
  for (const s of perLbSummaries) {
    buildingCount += s.placementCount;
    partCount += s.partCount;
    surfaceMeshCount += s.surfaceMeshCount;
  }
  const allSurfaceDids = new Set();
  for (const bake of opts.bakeCache.values()) {
    for (const did of bake.surfaceDids) allSurfaceDids.add(did);
  }

  // F#6 — number of duplicate building modelIds. At Holtburg radius=1
  // this is 16 - 14 = 2 (the 0x01 cottage and shop models repeat).
  // At larger rings the duplicate count grows roughly linearly with
  // placement count while uniqueModels grows sub-linearly (most
  // Aluvian-region buildings reuse the same dozen-or-so cottage
  // models). InstancedMesh would have saved at most these draw calls
  // and would have broken the per-placement door-rotation contract.
  // Reported for honesty, NOT for any actual instancing here.
  const buildingDuplicateModelCount =
    buildingCount - uniqueModelIds.length;

  // Stash on window mirroring the 2D path's `window.buildingMap`.
  // Capture scripts and Phase 7.3+ door logic both look here.
  window.buildingMap3d = opts.buildingMap3d;
  scene3d.materialCache = opts.materialCache;
  scene3d.buildingMap3d = opts.buildingMap3d;
  scene3d.buildingBakeCache = opts.bakeCache;

  return {
    buildingCount,
    uniqueModelCount: opts.bakeCache.size,
    partCount,
    surfaceMeshCount,
    surfaceCount: allSurfaceDids.size,
    resolvedMaterials: opts.materialCache.materials.size,
    fallbackHits: opts.materialCache.fallbackHits,
    realHits: opts.materialCache.realHits,
    // F#5 — count of unique building modelIds in the ring that report
    // a non-zero `did_degrade` chain entry (typically 0 for Holtburg).
    buildingDidDegradeCount,
    // F#6 — see comment above.
    buildingDuplicateModelCount,
    // Ring topology — useful for capture-script assertions at larger
    // radii. At radius=1 this is `lbCount=9`; the back-compat caller
    // can ignore it.
    lbCount: scene3d.buildingsBakedLbs.size,
  };
}

/**
 * Back-compat wrapper: bakes the radius-1 (3×3) ring around Holtburg.
 *
 * Existing capture scripts (`capture_phase7_2_buildings.cjs`) and the
 * `init3D` summary-log call site rely on this entry point; preserving
 * it keeps those callers green during world-expand step 1. The
 * radius-flip to 6 (13×13) lives at the init3D call site (Objective 8)
 * and re-targets to `bakeBuildingsRing` directly there.
 *
 * Top-level builder for Holtburg's building set. Mirrors the 2D
 * path's load flow:
 *   1. fetch_landblock_objects(NEIGHBOURHOOD ids, suffix 0xfffe).
 *   2. Filter `isBuilding === true` → unique modelIds.
 *   3. bakeBuildingPlacement() each in parallel (cached across the
 *      ring via the shared bakeCache on opts).
 *   4. Preload all surface DIDs through `materialCache.preload()`.
 *   5. For each building placement, `buildOneBuilding()` → add to
 *      `scene3d.buildingsGroup`.
 *   6. Stash `window.buildingMap3d = Map<placementKey, Group>`
 *      mirroring the 2D `window.buildingMap`.
 *
 * Returns:
 *   {
 *     buildingCount: number,             // placements rendered
 *     uniqueModelCount: number,          // unique modelIds baked
 *     partCount: number,                 // sum of per-building part wrappers
 *     surfaceMeshCount: number,          // sum of surface-group meshes
 *     surfaceCount: number,              // unique surface DIDs in cache
 *     resolvedMaterials: number,         // materialCache.materials.size
 *     fallbackHits: number,              // materialCache.fallbackHits at end
 *     realHits: number,                  // materialCache.realHits at end
 *     buildingDidDegradeCount: number,   // F#5 audit
 *     buildingDuplicateModelCount: number, // F#6 audit
 *     lbCount: number,                   // total LBs baked into ring
 *   }
 *
 * Required wasmExports keys: `fetch_landblock_objects`,
 * `fetchBuildingPlacement`, `fetch_surfaces_pixels`. If any are
 * missing the function throws.
 */
export async function buildHoltburgBuildings(scene3d, wasmExports) {
  return bakeBuildingsRing(scene3d, HOLTBURG_X, HOLTBURG_Y, 1, wasmExports);
}
