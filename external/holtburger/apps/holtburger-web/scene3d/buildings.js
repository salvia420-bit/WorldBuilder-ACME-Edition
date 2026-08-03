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
import { prewarmSubtree } from "./bake_prewarm.js";
import {
  meshToGeometryGroups,
  placementToMatrix4,
} from "./adapter.js";
import { MaterialCache, materialCanCastShadow } from "./materials.js";
import { surfacePixelsFetcher } from "./bake_worker_client.js";
import { isNearPlayerLb } from "./landblock_lru.js";
// A7-F1 (2026-07-11 s13) — shared per-cellId LandblockInfo fetch. statics.js
// runs the SAME fetch_landblock_objects for this LB; both route through this
// so the wasm unpack + setup-resolution happens ONCE. See lb_objects_shared.js.
import { fetchLandblockObjectsShared } from "./lb_objects_shared.js";
// A9-Stage2 (unification survey 2026-06-11): adopt the single-owner
// part-transform composition. A building's per-part hinge frame is the same
// rest-pose frame an entity part carries (position + AC-ordered quaternion);
// routing it through `applyRestPoseFrame` keeps that semantic in one place
// (`scene3d/setup_rig.js`). Byte-identical to the prior inline
// `hingeWrapper.position.set(...)` + `acQuatToThree(...)`.
import { applyRestPoseFrame } from "./setup_rig.js";
// ?buildingBatch (default-OFF) — reuse the SAME cross-LB static atlas statics feed.
import { statAtlasEnabled, addSingletonsToCrossLbAtlas } from "./static_atlas.js";

const METERS_PER_LANDBLOCK = 192.0;
// HOLTBURG_X/HOLTBURG_Y retired (spawn-driven-boot): the bake-time shadow gate
// and the buildHoltburg* wrapper that referenced them are gone.

// 2026-06-15 — building-floor-vs-terrain z-fight fix. SetupModel buildings
// (layer 0) sit ON the terrain (layer 0); their floor geometry is coplanar with
// the grass to ~cm. Under logarithmicDepthBuffer both write the identical
// gl_FragDepth, so GL_LESS breaks the tie nondeterministically → the "floor and
// grass both show / flicker" bug. We render building surfaces through the
// floor-bias material variant (gl_FragDepth -= 2e-4, see materials.js
// getCachedFloorBias/applyFloorDepthBias) so the floor wins the coplanar tie.
// Buildings are opaque solids, so this has NO see-through risk (walls occlude
// the floor from outside) and needs no per-cell gating. The epsilon is too
// small to override real separation (a building behind a hill is unaffected);
// it is a harmless no-op on non-coplanar walls/roofs. Opt-out ?buildingFloorBias=off.
// DEFAULT-ON (user decision 2026-06-15): it's the proven applyFillDepthBias
// mechanism sign-flipped. NOTE the headless swiftshader rasterizer does NOT
// reproduce GPU z-fighting (it resolves coplanar depth deterministically), so
// the visual A/B must be eye-tested on real GPU hardware (the 1070) via
// ?buildingFloorBias=off — queued in url-flags.md.
const BUILDING_FLOOR_BIAS = (() => {
  try {
    return new URLSearchParams(window.location.search).get("buildingFloorBias") !== "off";
  } catch (_) {
    return true;
  }
})();

// ?buildingBatch (default-ON, user decision 2026-07-14; ?buildingBatch=off escapes) —
// feed static building surfaces into the SAME
// cross-LB size-bucket atlas statics use (static_atlas.js), collapsing the per-placement
// building draw calls (measured ~59-60% of building draws are duplicate geom+material
// across placements — RESULTS-taskL2 sizing, Cragstone+Holtburg). SAFE because building
// setup parts never articulate in the 3D client: the door-part rotation path was RETIRED
// 2026-06-18 (index.html:4005 "Zero 3D readers") — doors are separate ENTITIES animated by
// the Rust door-swing (entities.js:683), so every building surface is static and batchable.
// Trade-off (documented, loop.js:1240): a batched bucket shares ONE receiveShadow, so
// batched buildings lose the per-placement distance receive-shadow gate (tickShadowReceiveGate
// walks buildingsGroup.children — batched surfaces move under staticsGroup and follow the
// atlas's uniform gate). castShadow is preserved per-bucket (walls still shadow the ground).
// Fail-soft: any surface the atlas can't take (no map/uv/image.data, layer overflow) passes
// through to buildingsGroup unchanged, so props NEVER vanish. Requires ?statAtlas on (default).
const BUILDING_BATCH = (() => {
  try {
    return new URLSearchParams(window.location.search).get("buildingBatch") !== "off";
  } catch (_) {
    return true;
  }
})();

// Flatten built placementGroups' surface meshes into staticsGroup-relative singletons and
// feed them to the cross-LB atlas. Each placementGroup is DETACHED (no parent) here, so
// `updateMatrixWorld(true)` makes every leaf mesh's `matrixWorld` equal its transform in the
// worldRoot-child space that staticsGroup and buildingsGroup share (both sit at identity
// under worldRoot). Decomposing that into the mesh's local TRS is exactly what the atlas
// reads (`n.updateMatrix()` → setMatrixAt). Stamps `landblockId` so the per-LB eviction hook
// (evictStaticAtlasForLb, keyed by node.userData.landblockId) excises them on LB evict.
// Returns the count of passthrough meshes added to buildingsGroup (fail-soft, unbatched).
function _feedBuildingGroupsToAtlas(groups, scene3d) {
  const singletons = [];
  for (const g of groups) {
    g.updateMatrixWorld(true); // detached → subtree matrixWorld == staticsGroup-relative
    const lbId = (g.userData?.landblockId ?? 0) >>> 0;
    g.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      o.matrixWorld.decompose(o.position, o.quaternion, o.scale); // bake chain into local TRS
      o.matrixAutoUpdate = true;
      if (!o.userData) o.userData = {};
      o.userData.landblockId = lbId;
      singletons.push(o);
    });
  }
  const { passthrough } = addSingletonsToCrossLbAtlas(singletons, scene3d);
  for (const n of passthrough) scene3d.buildingsGroup.add(n); // world-baked TRS → correct under buildingsGroup
  return passthrough.length;
}

// A3 (busted-world load fix 2026-06-20) — concurrent-call dedup for the
// per-LB buildings baker. The permanent `scene3d.buildingsBakedLbs.add(lbKey)`
// used to double as the in-flight guard, marking an LB "baked" BEFORE the
// load-bearing `fetch_landblock_objects`. A single fetch throw (likelier under
// the heavy boot load) then permanently stripped that LB's cottages/shops for
// the whole session. We now mark the PERMANENT set only AFTER the fetch +
// placement build succeed (so a throw leaves the LB retryable), and use this
// module-local Set to preserve the concurrent-call dedup the permanent add
// previously provided.
const _buildingsInFlight = new Set();

// B3 (busted-world load fix 2026-06-20) — frame-budget the boot buildings ring
// emitter so a building-dense ring doesn't build all per-LB placement Groups in
// one synchronous burst (a multi-frame main-thread stall that delays the entity
// drain hook / frame pump at init3D). Mirrors statics.js's F3 time-slice (~6ms
// chunk + setTimeout(0) macrotask yield). Default-ON; `?buildingsRingTimeSlice=off`
// disables. Guarded for the headless/capture path (no `window`).
const BUILDINGS_RING_TIME_SLICE = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    return new URLSearchParams(window.location.search).get("buildingsRingTimeSlice") !== "off";
  } catch (_) {
    return true;
  }
})();
const BUILDINGS_RING_BUILD_BUDGET_MS = 6;

// FU2 (perf follow-on 2026-05-18) — distance-tier follow-on for C3's
// `low`-preset receiveShadow gate. At mid/high/ultra a building gets
// `receiveShadow = true` only when its world-space distance to the
// reference point is under SHADOW_RECEIVE_RANGE_M. Beyond that it
// falls back to `receiveShadow = false`.
//
// Mirrors statics.js's FU2 predicate (commit-pair w/ C2). 80 m gives
// ~1.3× the half-LB radius, comfortably inside the CSM mid-cascade
// reach (DEFAULT_CSM_SPLITS[1]=100m in csm.js) AND the Phase-0.1
// single-shadow sun frustum (sceneSize=600m in lighting.js); shadows
// rendered up to 80m always have a covering cascade.
//
// Wave 1.E (2026-05-28) — bake-time tagging stays spawn-anchored as
// the warm cache seed; per-frame `tickShadowReceiveGate` (loop.js)
// re-tags `receiveShadow` from the LIVE player position so shadows no
// longer pop at landblock boundaries as the player crosses out of the
// spawn neighbourhood. Bumped 60→80 m so the warm cache covers the
// player's first wander before the gate first ticks (player walks
// 6m/s × ~200ms tick = 1.2m; ample slack).
export const SHADOW_RECEIVE_RANGE_M = 80.0;
export const SHADOW_RECEIVE_RANGE_SQ_M = SHADOW_RECEIVE_RANGE_M * SHADOW_RECEIVE_RANGE_M;
// SPAWN_REF_X/Y retired (spawn-driven-boot): no hardcoded spawn anchor. The live
// tickShadowReceiveGate (loop.js) culls receive-shadow by distance from the real
// player position every frame.

/**
 * FU2 — per-placement receive-shadow predicate. Extends C3's
 * `buildingsReceiveShadow` (the low-preset gate) with a distance check
 * against the spawn point. Applied at the per-placement granularity
 * inside `buildOneBuilding` (every surface mesh under that placement
 * shares the same world position, so one predicate per placement).
 *
 *   buildingsReceiveShadow: the C3 low-preset bool — already false at low.
 *   worldX, worldY: placement world-space position (LB origin + local).
 *
 * Returns false at low (matches C3 behaviour), false beyond the range,
 * true within the range at mid/high/ultra. Building meshes are always
 * plain `THREE.Mesh` under a `THREE.Group` (NOT `InstancedMesh` — the
 * per-placement door-rotation contract precludes instancing; see the
 * module-doc header), so the per-placement gate applies cleanly.
 */
function buildingsReceiveShadowForPlacement(
  buildingsReceiveShadow,
  worldX,
  worldY
) {
  // Spawn-driven boot: the bake-time Holtburg distance gate is retired. The live
  // tickShadowReceiveGate (loop.js) re-tags receive-shadow from the real player
  // position every frame, so just honour the preset bool here. (worldX/worldY
  // retained for caller/signature parity.)
  return !!buildingsReceiveShadow;
}

// ---------------------------------------------------------------------
// C5 (perf plan 2026-05-18) — material/geometry disposal helpers.
//
// These mirror the `__disposable` / `__cacheOwned` convention introduced
// by B3 (commit `5f4b8a6` in entities.js:243-286 + materials.js). We
// duplicate them locally rather than importing from entities.js to avoid
// broadening that module's export surface for a 20-line helper pair.
// The convention itself is shared verbatim — see entities.js's module
// docstring for the canonical write-up; tracked-only change here is to
// keep the buildings unload path independent of entities.js refactors.
//
// Convention recap:
//   - `mat.userData.__cacheOwned === true`    → cache material; NEVER dispose.
//   - `mat.userData.__disposable === true`    → per-rig clone; SAFE to dispose.
//   - `geom.userData.__disposable === true`   → per-rig geometry; SAFE to dispose.
//
// `MaterialCache` install paths in materials.js tag every cache-resident
// material with `__cacheOwned: true`; the assertion below catches a
// programmer error where a clone site forgot to tag and a cache material
// got mis-tagged.
//
// AUDIT RESULT (2026-05-18, C5 implementation):
//   buildings.js contains ZERO `material.clone()` / `geometry.clone()`
//   sites — every per-placement Mesh reads materials from
//   `materialCache.getCached(did)` (cache-owned) and geometries from
//   `bake.parts[].groups[].geometry` (cache-shared across placements of
//   the same modelId via `opts.bakeCache: Map<modelId, bake>`). Both
//   are NOT `__disposable`; the helpers below will no-op for buildings
//   today. The helpers exist so the future unload path is correct from
//   day one if/when per-placement clones are introduced (e.g. for
//   per-instance material tints or per-instance geometry deformation).
// ---------------------------------------------------------------------
function _disposeMaterialIfOwned(mat) {
  if (!mat) return;
  const ud = mat.userData;
  if (!ud) return;
  if (ud.__cacheOwned === true && ud.__disposable === true) {
    // Programmer error: a cache material was tagged disposable at some
    // clone site that should have stayed cache-owned. Dispose would
    // free the shared GPU resource other placements still reference.
    // eslint-disable-next-line no-console
    console.error(
      "[buildings/C5] _disposeMaterialIfOwned: material is BOTH __cacheOwned and __disposable —" +
        " refusing to dispose. Audit the clone site that produced it.",
      { name: mat.name, userData: ud }
    );
    return;
  }
  if (ud.__disposable !== true) return;
  try {
    mat.dispose();
  } catch (_) {}
}

function _disposeMeshChildren(root) {
  if (!root) return;
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    // Geometry: building geometries are shared across placements of the
    // same modelId via `opts.bakeCache`. Gate on `__disposable` rather
    // than disposing unconditionally (which would crash the next
    // placement that re-uses the cached bake). Matches the more
    // conservative half of B3's convention; entities.js disposes
    // unconditionally because entity geometries are per-rig.
    if (obj.geometry?.userData?.__disposable === true) {
      try {
        obj.geometry.dispose();
      } catch (_) {}
    }
    if (Array.isArray(obj.material)) {
      for (const m of obj.material) _disposeMaterialIfOwned(m);
    } else {
      _disposeMaterialIfOwned(obj.material);
    }
  });
}

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
  // streamFix retryability (2026-07-02): the wasm walk's record-miss count
  // (see fetch_building_placement's geom-audit retry). Non-zero = one or
  // more parts decoded empty under fetch starvation — the bake is
  // INCOMPLETE and must NOT enter the cross-LB `opts.bakeCache` (a poisoned
  // entry strips this cottage/shop model from EVERY future LB for the whole
  // session). Getter is absent on a stale wasm bundle → 0 (fail-soft to the
  // pre-fix behavior).
  const decodeMisses =
    typeof bundle.decodeMisses === "number" ? bundle.decodeMisses >>> 0 : 0;
  if (partCount === 0) {
    if (typeof bundle.free === "function") bundle.free();
    return {
      modelId,
      setupId,
      parts: [],
      surfaceDids: new Set(),
      incomplete: decodeMisses > 0,
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
    incomplete: decodeMisses > 0,
  };
}

// streamFix retryability (2026-07-02): per-LB starved-decode retry budget
// for the buildings baker — same shape + rationale as the statics baker's
// `_staticsStarvedRetries` (see statics.js): bounded so a permanently-
// undecodable model can't loop the LB forever, cleared on a clean bake.
const BUILDINGS_STARVED_RETRY_CAP = 3;
const _buildingsStarvedRetries = new Map();

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
function buildOneBuilding(
  placement,
  bake,
  materialCache,
  worldOffset,
  shadowsEnabled,
  buildingsReceiveShadow
) {
  const placementKey =
    `${(placement.landblockId >>> 0).toString(16).padStart(8, "0")}_` +
    `${placement.x.toFixed(2)}_${placement.y.toFixed(2)}_` +
    `${(placement.modelId >>> 0).toString(16).padStart(8, "0")}`;

  const placementGroup = new THREE.Group();
  placementGroup.name = `building-${placementKey}`;
  // World position = landblock NW + placement-local. AC's
  // `ObjectPlacement.x/y/z` is metres relative to the LB NW corner
  // (per `lib.rs:600-602`).
  const worldX = worldOffset.x + placement.x;
  const worldY = worldOffset.y + placement.y;
  placementGroup.position.set(worldX, worldY, placement.z);
  // FU2 — per-placement distance-tier predicate; computed once per
  // building so all surface meshes under this Group share the same
  // shadow-receive decision (they're all at the same world position).
  // False at C3's `low` preset OR when this building is beyond
  // SHADOW_RECEIVE_RANGE_M from spawn; true within range at mid/high/
  // ultra.
  const placementReceiveShadow = buildingsReceiveShadowForPlacement(
    buildingsReceiveShadow,
    worldX,
    worldY
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
    // A9-Stage2: hinge frame = the part rest-pose frame (position + AC-order
    // quaternion). `applyRestPoseFrame` sets `position` then
    // `quaternion.set(qx,qy,qz,qw)` — identical to the prior inline
    // `.set(...)` + `acQuatToThree(qw,qx,qy,qz).copy(...)` (the AC→three
    // reorder is the same). Single part → index 0 over single-element flats.
    applyRestPoseFrame(
      THREE,
      hingeWrapper,
      [part.hinge.x, part.hinge.y, part.hinge.z],
      [part.hinge.qw, part.hinge.qx, part.hinge.qy, part.hinge.qz],
      0,
      true
    );
    hingeWrapper.userData = {
      modelId: placement.modelId,
      partIndex: part.partIndex,
      hinge: part.hinge,
      // Phase 7.3+ door rotation reads/writes this. closed = 0.
      doorRotationRad: 0,
    };

    for (const g of part.groups) {
      const mat = BUILDING_FLOOR_BIAS
        ? materialCache.getCachedFloorBias(g.surfaceDid)
        : materialCache.getCached(g.surfaceDid);
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
        // C3 (perf plan 2026-05-18) — at `low` quality preset every
        // building surface skips CSM receive-shadow participation;
        // mid/high/ultra keep today's all-receivers behaviour.
        // Translucent surfaces already get receiveShadow=false via the
        // per-material gate in materials.js (separate code path).
        // FU2 (perf follow-on 2026-05-18) — distance-tier gate on top
        // of C3's low-preset gate. Foreground (<SHADOW_RECEIVE_RANGE_M
        // from the reference point) at mid/high/ultra keeps
        // receiveShadow=true; everything else (low preset OR beyond
        // range) gets false. Bake-time tag is spawn-anchored as the
        // warm cache seed; per-frame `tickShadowReceiveGate` (loop.js,
        // Wave 1.E 2026-05-28) re-tags from the LIVE player position
        // so shadows stay attached to the player's neighbourhood as
        // they traverse landblock boundaries. Per-placement (not
        // per-surface) since every surface mesh under this Group
        // shares the same world position.
        mesh.receiveShadow = placementReceiveShadow;
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
      // Phase-5 — wasm namespace for the baked-roughness by-key suite fetch.
      wasmExports: scene3d.wasmExports ?? null,
      // === Wave 2.B — procedural normals (2026-05-28) ===
      // Quality-preset gate for Phase 1.1 procedural normal maps. Set on
      // scene3d in index.js from `quality.flags.normalMaps`. Undefined
      // (eg. legacy capture flows) → MaterialCache defaults to `true`
      // (back-compat for any caller that bypasses index.js plumbing).
      normalMapsEnabled: scene3d.normalMapsEnabled,
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
    // C3 (perf plan 2026-05-18) — at the `low` quality preset every
    // building surface skips receiveShadow (CSM frustum-test cost
    // scales linearly with receiver count; ~46 buildings × ~8 parts
    // × ~2-3 meshes/part ≈ 460+ receiver meshes at radius=1). mid/
    // high/ultra keep today's all-receivers behaviour. Mirrors C2's
    // `staticsReceiveShadow` convention (commit 8ceafa0). Captured
    // once at ring entry and threaded into `buildOneBuilding`.
    // FU2 (perf follow-on 2026-05-18) — this is the C3 low-preset
    // bool; the per-placement distance-tier predicate
    // (`buildingsReceiveShadowForPlacement`) consumes it inside
    // `buildOneBuilding`. Buildings are always plain `THREE.Mesh`
    // under per-placement Groups (NOT InstancedMesh — see the
    // module-doc header on door-rotation), so the gate applies per-
    // placement cleanly.
    buildingsReceiveShadow: scene3d.quality?.preset !== "low",
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
  // Spawn-driven boot: the eager Holtburg boot ring no longer stashes
  // scene3d.buildingsOpts, so the per-LB streaming path (loadBuildingsForLandblock)
  // can arrive here with no opts. Lazily resolve + stash them on the first streamed
  // LB — mirrors the terrain loader's self-heal in index.js#loadTerrainForLandblock.
  // Idempotent: resolveBuildingsOpts reuses the already-installed MaterialCache +
  // shared bake cache. (Without this, the bake threw and _guardedStreamBake
  // swallowed it, leaving buildingsGroup permanently empty.)
  if (!opts || !(opts.bakeCache instanceof Map) || !opts.materialCache) {
    opts = resolveBuildingsOpts(scene3d);
    scene3d.buildingsOpts = opts;
  }

  if (!(scene3d.buildingsBakedLbs instanceof Set)) {
    scene3d.buildingsBakedLbs = new Set();
  }
  const lbKey = (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16)) >>> 0;
  // A3: short-circuit on the PERMANENT baked set OR the in-flight set. The
  // in-flight check preserves the concurrent-call dedup the permanent
  // pre-add used to provide; the permanent add now runs only AFTER the
  // load-bearing fetch + placement build succeed (below), so a throw leaves
  // the LB un-baked and retryable instead of permanently stripped.
  if (scene3d.buildingsBakedLbs.has(lbKey) || _buildingsInFlight.has(lbKey)) {
    return {
      idempotent: true,
      placementCount: 0,
      modelCount: 0,
      surfaceCount: 0,
      partCount: 0,
      surfaceMeshCount: 0,
      disposables: { geometries: [], materials: [], textures: [] },
    };
  }
  // A3: from here on the LB is "in flight". The PERMANENT
  // `scene3d.buildingsBakedLbs.add(lbKey)` is deferred to AFTER the
  // load-bearing fetch + placement build succeed (the two success returns
  // below); the `finally` clears the in-flight marker on ANY exit — so a
  // fetch throw leaves the LB un-baked and retryable instead of permanently
  // stripping its cottages/shops for the session.
  _buildingsInFlight.add(lbKey);
  try {
    // streamFix urgent lane (2026-07-02): current-LB/3×3 bakes are
    // player-blocking — their wasm fetches bypass the shared fetch
    // semaphore (see statics.js twin + lib.rs). Snapshot once per bake.
    const urgent = isNearPlayerLb(scene3d, lbKey);
    // Step 1 — fetch this LB's placements. The `0xfffe` suffix selects
    // LandblockInfo (objects + buildings); `0xffff` is the terrain
    // CellLandblock and won't return placements.
    const cellId = (lbKey | 0xfffe) >>> 0;
    // A7-F1 (2026-07-11 s13): shared drained snapshot — statics.js fetches the
    // SAME cellId. The wasm records are drained+freed once inside the shared
    // module, so `allPlacements` here are plain JS records (no `.free`).
    const allPlacements = await fetchLandblockObjectsShared(
      wasmExports,
      cellId,
      urgent
    );

    // Step 2 — filter buildings, reshape into the JS-owned building record
    // this baker consumes. statics.js filters !isBuilding from the same
    // shared snapshot; neither mutates it.
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
    }

    if (buildings.length === 0) {
      // Empty LB (most of the 13×13 ring's outer LBs are wilderness).
      // Still counts as baked so the idempotency set holds. The fetch
      // above succeeded, so it's safe to mark this LB permanently baked.
      scene3d.buildingsBakedLbs.add(lbKey);
      return {
        idempotent: false,
        placementCount: 0,
        modelCount: 0,
        surfaceCount: 0,
        partCount: 0,
        surfaceMeshCount: 0,
        disposables: { geometries: [], materials: [], textures: [] },
      };
    }

    // Step 3 — bake unique modelIds for this LB, hit-checking the
    // ring-shared cache. Holtburg ground truth: 14 unique modelIds
    // across 16 placements (memory note at top of file). Across a
    // larger ring most LBs hit the cache for every building.
    const uniqueModelIds = [...new Set(buildings.map((b) => b.modelId))];
    const toBake = uniqueModelIds.filter((id) => !opts.bakeCache.has(id));
    // streamFix retryability (2026-07-02): local (this-call-only) bakes for
    // models whose decode came back INCOMPLETE — they render this attempt
    // only once the retry budget is exhausted, and NEVER enter the
    // cross-LB cache (a poisoned entry would strip the model everywhere
    // for the whole session).
    const localBakes = new Map();
    if (toBake.length > 0) {
      const bakeResults = await Promise.all(
        toBake.map((id) =>
          // streamFix urgent lane (2026-07-02): forward the bake's lane to
          // fetchBuildingPlacement(modelId, urgent).
          bakeBuildingPlacement(id, (mid) => wasmExports.fetchBuildingPlacement(mid, urgent))
        )
      );
      let starved = 0;
      for (let i = 0; i < toBake.length; i += 1) {
        const bake = bakeResults[i];
        if (!bake) {
          // fetchBuildingPlacement threw (walk failure — transient class).
          starved += 1;
          continue;
        }
        if (bake.incomplete) {
          starved += 1;
          localBakes.set(toBake[i], bake);
          continue;
        }
        opts.bakeCache.set(toBake[i], bake);
      }
      if (starved > 0) {
        const attempts = (_buildingsStarvedRetries.get(lbKey) || 0) + 1;
        if (attempts <= BUILDINGS_STARVED_RETRY_CAP) {
          _buildingsStarvedRetries.set(lbKey, attempts);
          // LB is not yet marked baked (A3 marks below) — throwing here
          // leaves it retryable: the stream guard cooldowns it and the PVS
          // expansion re-fires once the fetch pipeline drains.
          throw new Error(
            `bakeBuildingsForLandblock 0x${lbKey.toString(16)}: ${starved}/${toBake.length} ` +
              `building models decode-starved; leaving LB retryable (attempt ${attempts}/${BUILDINGS_STARVED_RETRY_CAP})`
          );
        }
        // eslint-disable-next-line no-console
        console.warn(
          `[geom-audit] buildings 0x${lbKey.toString(16)}: accepting PARTIAL bake after ` +
            `${BUILDINGS_STARVED_RETRY_CAP} starved retries (${starved} models still incomplete)`
        );
        _buildingsStarvedRetries.delete(lbKey);
      } else if (_buildingsStarvedRetries.has(lbKey)) {
        _buildingsStarvedRetries.delete(lbKey); // clean bake — reset budget
      }
    }

    // Step 4 — preload referenced surface DIDs for this LB's bakes.
    // MaterialCache.preload is idempotent on already-loaded DIDs, so
    // cross-LB redundancy is filtered at the cache layer (see
    // materials.js:1207 `if (this.materials.has(d)) continue`).
    const lbSurfaceDids = new Set();
    for (const id of uniqueModelIds) {
      // streamFix (2026-07-02): fall back to the this-call-only bake for a
      // cap-exhausted incomplete model (never cached cross-LB).
      const bake = opts.bakeCache.get(id) || localBakes.get(id);
      if (!bake) continue;
      for (const did of bake.surfaceDids) lbSurfaceDids.add(did);
    }
    if (lbSurfaceDids.size > 0) {
      try {
        // streamFix urgent lane (2026-07-02): close the bake's lane over the
        // surface fetcher (same pattern as statics.js).
        const spFetchRaw = surfacePixelsFetcher(wasmExports);
        await opts.materialCache.preload(
          [...lbSurfaceDids],
          (dids) => spFetchRaw(dids, urgent)
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
    // Item 4 (2026-06-22): collect this LB's building Groups and pre-warm them as one
    // subtree BEFORE attaching (see below), so the per-DID material program link +
    // texture upload happen in the driver background instead of on the first render frame.
    const _pendingGroups = [];
    for (const placement of buildings) {
      const placementLbX = (placement.landblockId >>> 24) & 0xff;
      const placementLbY = (placement.landblockId >>> 16) & 0xff;
      const worldOffset = {
        x: placementLbX * METERS_PER_LANDBLOCK,
        y: placementLbY * METERS_PER_LANDBLOCK,
      };
      const bake = opts.bakeCache.get(placement.modelId) || localBakes.get(placement.modelId);
      if (!bake) {
        // No bake for this modelId — the bake call failed earlier;
        // skip with a warning rather than crash. The 2D path falls
        // back to a fused single-sprite here; the 3D fallback is
        // Phase 7.7 polish (out of scope for the world-expand step 1
        // refactor). (streamFix 2026-07-02: with the starved-retry
        // throw above, reaching here with a missing bake means the
        // retry budget is exhausted — the skip is now bounded, not
        // permanent-silent.)
        continue;
      }
      // Compute placementKey BEFORE constructing the Group so we can
      // dedup against `opts.buildingMap3d`. MUST match `buildOneBuilding`'s
      // formula at L314: landblockId_x_y_modelId. Without this check, a
      // placement returned by multiple LBs' `fetch_landblock_objects`
      // (cross-LB inclusion for buildings near landblock boundaries)
      // would be baked once per LB that surfaced it — producing N
      // invisible stacked copies at the same world position, each its
      // own draw call. User report 2026-05-20: 26 copies of every
      // surface in the centre LB, 3,885 wasted draw calls scene-wide
      // (~40% of all draws).
      const placementKey =
        `${(placement.landblockId >>> 0).toString(16).padStart(8, "0")}_` +
        `${placement.x.toFixed(2)}_${placement.y.toFixed(2)}_` +
        `${(placement.modelId >>> 0).toString(16).padStart(8, "0")}`;
      if (opts.buildingMap3d.has(placementKey)) {
        // Same placement was already baked by another LB whose
        // fetch_landblock_objects returned it — skip the duplicate.
        continue;
      }
      const { group, surfaceMeshCount: smc } = buildOneBuilding(
        placement,
        bake,
        opts.materialCache,
        worldOffset,
        opts.shadowsEnabled,
        opts.buildingsReceiveShadow
      );
      _pendingGroups.push(group);
      partCount += bake.parts.length;
      surfaceMeshCount += smc;
      opts.buildingMap3d.set(group.userData.placementKey, group);
    }

    // Item 4 (2026-06-22): pre-warm all of this LB's building Groups as one subtree, then
    // attach. compileAsync on a temp parent backgrounds the program link + texture upload;
    // re-parenting to buildingsGroup afterward is transform-independent (program/texture
    // results live on the material/texture objects). Safe without a residency re-check: the
    // LB isn't LRU-tracked until this baker resolves (the attach loop is past all awaits).
    // `?bakePrewarm=off` skips the await and attaches straight away.
    if (_pendingGroups.length > 0) {
      const _tmp = new THREE.Group();
      for (const g of _pendingGroups) _tmp.add(g);
      await prewarmSubtree(scene3d, _tmp);
      for (const g of [..._tmp.children]) _tmp.remove(g);
      if (BUILDING_BATCH && statAtlasEnabled()) {
        _feedBuildingGroupsToAtlas(_pendingGroups, scene3d);
      } else {
        for (const g of _pendingGroups) scene3d.buildingsGroup.add(g);
      }
    }

    // A3: placement build succeeded — NOW mark the LB permanently baked.
    scene3d.buildingsBakedLbs.add(lbKey);
    return {
      idempotent: false,
      placementCount: buildings.length,
      modelCount: uniqueModelIds.length,
      surfaceCount: lbSurfaceDids.size,
      partCount,
      surfaceMeshCount,
      // LRU wave H4 — confirmed zero per-LB disposables: every building
      // BufferGeometry is shared via `opts.bakeCache` (per-modelId,
      // cross-LB) and every material is `materialCache.getCached`-shared
      // (per-DID). Container-remove in the LRU evict path is sufficient.
      // Empty arrays kept for shape uniformity with cells/statics tags.
      disposables: { geometries: [], materials: [], textures: [] },
    };
  } finally {
    // A3: clear the in-flight marker on ANY exit (success, empty-LB
    // return, or throw). On a throw the permanent baked set was never
    // touched, so the LB stays retryable on the next approach.
    _buildingsInFlight.delete(lbKey);
  }
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

  // Cold-boot Phase D (2026-05-21) — break the wasm single-thread
  // bottleneck. The previous shape fanned out N=169 `bakeBuildingsForLandblock`
  // promises in `Promise.all`. Each per-LB baker fired its OWN single-cell
  // `fetch_landblock_objects([cellId])` and its OWN per-LB
  // `fetch_surfaces_pixels([dids])` — 169 separate `pub async fn` wasm
  // round-trips for what could be ONE batched call each.
  //
  // The wasm side already accepts a `Vec<u32>` for both
  // `fetch_landblock_objects` (lib.rs:921) and `fetch_surfaces_pixels`
  // (lib.rs:4881) — each does ONE `prefetch(&keys).await` over the full
  // key set, which itself parallelizes URL fetches via F.35. Calling
  // with single-element arrays N times is N× the wasm-marshalling
  // overhead vs one batched call.
  //
  // `bakeStaticsRing` (statics.js:1054) already proves this pattern works:
  // ONE ring-wide `fetch_landblock_objects(cellIds)`, ONE
  // `fetch_model_meshes`, ONE `fetch_surfaces_pixels`. Mirror that here.
  //
  // The per-LB idempotency check + bake-cache hits + duplicate-placement
  // dedup all survive the shape change — they were already keyed on
  // `(lbX, lbY)` and `placementKey`, not on whose wasm call surfaced the
  // placement.
  const ringLbs = [];
  for (let dy = radius; dy >= -radius; dy -= 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const lbX = centreLbX + dx;
      const lbY = centreLbY + dy;
      if (lbX < 0 || lbX > 0xff || lbY < 0 || lbY > 0xff) continue;
      const lbKey = (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16)) >>> 0;
      ringLbs.push({
        lbX,
        lbY,
        lbKey,
        cellId: (lbKey | 0xfffe) >>> 0,
      });
    }
  }
  if (!(scene3d.buildingsBakedLbs instanceof Set)) {
    scene3d.buildingsBakedLbs = new Set();
  }
  // Filter out already-baked LBs (lazy-hook path may have run first in
  // tests; production cold-boot has all 169 fresh).
  const lbsToBake = ringLbs.filter(
    (l) => !scene3d.buildingsBakedLbs.has(l.lbKey)
  );
  // A3 (busted-world load fix 2026-06-20): the permanent `buildingsBakedLbs.add`
  // used to run HERE, BEFORE the ring's wasm round-trip — so if the ring
  // `fetch_landblock_objects` (or the bake `Promise.all`) threw under the heavy
  // boot load, every LB in the ring was permanently stripped of its
  // cottages/shops for the session. The add is now deferred to Stage 5, AFTER
  // the awaits succeed (per-LB, right before that LB's synchronous
  // instantiation), so a throw leaves the ring's LBs un-baked and retryable.

  const perLbSummaries = [];
  if (lbsToBake.length > 0) {
    // ── Stage 1: ONE wasm round-trip across the ring. ──────────────────
    // `fetch_landblock_objects` returns a flat list of placements
    // tagged with `landblockId`; we demux by LB JS-side. 169 separate
    // wasm awaits → 1 wasm await.
    const allCellIds = new Uint32Array(lbsToBake.map((l) => l.cellId));
    const allPlacementsRaw = await wasmExports.fetch_landblock_objects(
      allCellIds
    );

    // ── Stage 2: demux + filter buildings, free wasm handles. ──────────
    // Group by landblockId so per-LB instantiation reads its slice
    // synchronously below. `landblockId` on each placement is the full
    // `(lbX<<24)|(lbY<<16)|0xfffe` cellId — convert to the lbKey
    // (lbX<<24)|(lbY<<16) by masking off 0xffff so the lookup keys
    // match `lbKey` above.
    const buildingsByLb = new Map();
    for (const p of allPlacementsRaw) {
      if (p.isBuilding) {
        const lbKey = ((p.landblockId >>> 0) & 0xffff0000) >>> 0;
        let arr = buildingsByLb.get(lbKey);
        if (!arr) {
          arr = [];
          buildingsByLb.set(lbKey, arr);
        }
        arr.push({
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

    // ── Stage 3: collect unique modelIds across the entire ring and ───
    // bake them in ONE Promise.all. `bakeBuildingPlacement` is per-
    // modelId, so deduplication across LBs is critical at radius=6
    // (Holtburg has ~14 unique cottage/shop models across hundreds of
    // ring placements). Cache hits in `opts.bakeCache` survive across
    // calls so the radius=1 → radius=6 promotion doesn't re-fetch
    // anything that the lazy hook already baked.
    const allUniqueModelIds = new Set();
    for (const list of buildingsByLb.values()) {
      for (const b of list) allUniqueModelIds.add(b.modelId);
    }
    const toBake = [...allUniqueModelIds].filter(
      (id) => !opts.bakeCache.has(id)
    );
    if (toBake.length > 0) {
      const bakeResults = await Promise.all(
        toBake.map((id) =>
          bakeBuildingPlacement(id, wasmExports.fetchBuildingPlacement)
        )
      );
      for (let i = 0; i < toBake.length; i += 1) {
        const bake = bakeResults[i];
        if (!bake) continue;
        // streamFix parity (2026-08-03) — NEVER cache an incomplete
        // (decode-starved) bake cross-LB: same quarantine as the per-LB
        // baker's localBakes arm above; a poisoned entry strips this model
        // from every future LB for the whole session. Ring placements for
        // an incomplete model just skip this pass (the per-LB streaming
        // path retries under its bounded budget).
        if (bake.incomplete) continue;
        opts.bakeCache.set(toBake[i], bake);
      }
    }

    // ── Stage 4: ONE materialCache.preload over the union of all surface
    // DIDs referenced across the ring's bakes. 169 separate per-LB
    // preload calls → 1. The MaterialCache itself already dedupes DIDs
    // against `this.materials` / `this.pendingFetches`, so the prior
    // shape's cross-LB redundancy got filtered cheaply — but each call
    // still entered `fetch_surfaces_pixels` once per LB. One call here
    // touches the wasm side once.
    const allSurfaceDidsSet = new Set();
    for (const modelId of allUniqueModelIds) {
      const bake = opts.bakeCache.get(modelId);
      if (!bake) continue;
      for (const did of bake.surfaceDids) allSurfaceDidsSet.add(did);
    }
    if (allSurfaceDidsSet.size > 0) {
      try {
        await opts.materialCache.preload(
          [...allSurfaceDidsSet],
          surfacePixelsFetcher(wasmExports)
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          "[scene3d.buildings] ring materialCache.preload failed:",
          e
        );
      }
    }

    // ── Stage 5: per-LB instantiation. Every wasm dependency is already
    // cached above (Stages 1-4). Mirrors the L645-697 instantiation block of
    // the per-LB baker, scoped per LB so the returned summaries keep the
    // legacy shape.
    //
    // B3 (busted-world load fix 2026-06-20): a building-dense ring builds all
    // per-LB placement Groups in one synchronous burst here, a multi-frame
    // main-thread stall at init3D (delaying the entity drain hook / frame
    // pump). Frame-budget it: yield a macrotask once a chunk has spent ~6ms,
    // mirroring statics.js's F3 time-slice. Gated DEFAULT-ON behind
    // `?buildingsRingTimeSlice` (`=off` escape). setTimeout (NOT rIC/rAF — see
    // the statics F3 note).
    let _ringChunkStart = performance.now();
    for (const l of lbsToBake) {
      const buildings = buildingsByLb.get(l.lbKey) ?? [];
      if (buildings.length === 0) {
        // A3: fetch + bakes succeeded above — mark this empty LB baked.
        scene3d.buildingsBakedLbs.add(l.lbKey);
        perLbSummaries.push({
          idempotent: false,
          placementCount: 0,
          modelCount: 0,
          surfaceCount: 0,
          partCount: 0,
          surfaceMeshCount: 0,
        });
        continue;
      }
      const uniqueModelIdsForLb = [
        ...new Set(buildings.map((b) => b.modelId)),
      ];
      const lbSurfaceDids = new Set();
      for (const id of uniqueModelIdsForLb) {
        const bake = opts.bakeCache.get(id);
        if (!bake) continue;
        for (const did of bake.surfaceDids) lbSurfaceDids.add(did);
      }
      let partCount = 0;
      let surfaceMeshCount = 0;
      const lbBatchGroups = BUILDING_BATCH && statAtlasEnabled() ? [] : null;
      for (const placement of buildings) {
        const placementLbX = (placement.landblockId >>> 24) & 0xff;
        const placementLbY = (placement.landblockId >>> 16) & 0xff;
        const worldOffset = {
          x: placementLbX * METERS_PER_LANDBLOCK,
          y: placementLbY * METERS_PER_LANDBLOCK,
        };
        const bake = opts.bakeCache.get(placement.modelId);
        if (!bake) continue;
        const placementKey =
          `${(placement.landblockId >>> 0).toString(16).padStart(8, "0")}_` +
          `${placement.x.toFixed(2)}_${placement.y.toFixed(2)}_` +
          `${(placement.modelId >>> 0).toString(16).padStart(8, "0")}`;
        if (opts.buildingMap3d.has(placementKey)) {
          // Cross-LB duplicate placement (border-spanning building
          // surfaced by multiple LBs' fetch_landblock_objects). Skip.
          continue;
        }
        const { group, surfaceMeshCount: smc } = buildOneBuilding(
          placement,
          bake,
          opts.materialCache,
          worldOffset,
          opts.shadowsEnabled,
          opts.buildingsReceiveShadow
        );
        if (lbBatchGroups) lbBatchGroups.push(group);
        else scene3d.buildingsGroup.add(group);
        partCount += bake.parts.length;
        surfaceMeshCount += smc;
        opts.buildingMap3d.set(group.userData.placementKey, group);
      }
      // ?buildingBatch — feed this LB's static building surfaces into the cross-LB atlas.
      if (lbBatchGroups && lbBatchGroups.length > 0) {
        _feedBuildingGroupsToAtlas(lbBatchGroups, scene3d);
      }
      // A3: this LB's placements are instantiated — mark it permanently baked
      // now (AFTER the ring's awaits + this LB's synchronous build succeeded).
      scene3d.buildingsBakedLbs.add(l.lbKey);
      perLbSummaries.push({
        idempotent: false,
        placementCount: buildings.length,
        modelCount: uniqueModelIdsForLb.length,
        surfaceCount: lbSurfaceDids.size,
        partCount,
        surfaceMeshCount,
      });

      // B3 time-slice: yield a macrotask once this chunk has spent its frame
      // budget so the boot buildings ring doesn't stall the main thread.
      if (
        BUILDINGS_RING_TIME_SLICE &&
        performance.now() - _ringChunkStart > BUILDINGS_RING_BUILD_BUDGET_MS
      ) {
        await new Promise((r) => setTimeout(r, 0));
        _ringChunkStart = performance.now();
      }
    }
  }

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
// buildHoltburgBuildings() retired (spawn-driven-boot): the Holtburg-centred
// back-compat wrapper is gone. Buildings stream per-LB via
// loadBuildingsForLandblock; bakeBuildingsRing remains exported for any
// explicit-centre caller (tests/captures).

// TODO(C5): no unload path exists in buildings.js as of 2026-05-18.
//
// `bakeBuildingsForLandblock` only ADDS — `buildingsBakedLbs` is set
// at L416 and never cleared; `buildingsGroup.add(group)` at L532 has
// no corresponding `.remove(group)` anywhere in the webapp (verified
// with `grep -rn 'unloadBuilding\|removeBuilding\|buildingsGroup.remove'`).
// PVS-driven expansion only LOADS new LBs via the lazy hook in
// `scene3d/index.js:1285` (`loadBuildingsForLandblock`). There is no
// PVS-contraction step that removes building Groups when the player
// walks away.
//
// **Consequence:** the C5 acceptance criterion ("PVS-cycle soak (walk
// in/out of PVS 100 times) leaves `renderer.info.memory.textures` flat
// (±5%)") is currently vacuously satisfied — textures don't grow on
// PVS contraction because nothing contracts. Memory growth bound is
// `lbCount × buildings-per-lb × materials-per-building`, not unbounded
// growth per PVS cycle. Once a PVS-contraction step is added (likely
// alongside terrain LB contraction in a future world-expand step), the
// unload sequence should be:
//
//   1. Find the placement Group(s) for the LB being evicted via the
//      `placementKey` → group entries in `scene3d.buildingMap3d`
//      (filter by `landblockId === lbKey`).
//   2. For each `group`: `_disposeMeshChildren(group)` (defined above)
//      BEFORE `scene3d.buildingsGroup.remove(group)`. Order matters:
//      `traverse` walks the live attached subtree; removing first
//      drops the descendants beyond reach.
//   3. Delete from `scene3d.buildingMap3d` and `window.buildingMap3d`
//      so the door-rotation `findClosestBuildingPart` lookup doesn't
//      return stale Groups.
//   4. Clear the LB key from `scene3d.buildingsBakedLbs` so a later
//      re-expansion re-bakes.
//   5. DO NOT touch `opts.bakeCache` (per-Setup-model fused geometry)
//      or `opts.materialCache` — both are shared singletons that other
//      LBs still reference. Their lifetimes are page-scoped.
//
// The audit at C5 time confirmed buildings.js contains zero
// `material.clone()` / `geometry.clone()` sites (every per-placement
// Mesh reads cache-owned materials via `materialCache.getCached(did)`
// and shared-bake geometries from `bake.parts[].groups[].geometry`).
// Without per-placement clones the `_disposeMeshChildren` walk above is
// effectively a no-op for the current topology — but the convention is
// in place so a future per-placement tint/deform path will dispose
// correctly out of the box (just remember to tag the clone with
// `userData.__disposable = true` at the clone site).
