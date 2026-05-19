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
//
// ── World-expand step 1 — Objective 4 (2026-05-14) ────────────────────
// This file is now structured in THREE layers (per
// `docs/world-expand-step-1-handoff.md` §Objective 4):
//
//   1. `bakeStaticsForLandblock(scene3d, lbX, lbY, opts, wasmExports)`
//      — bakes ONE LB. Idempotent via `scene3d.staticsBakedLbs`.
//      **Uses plain `THREE.Mesh` adds (no InstancedMesh)** because this
//      path is the lazy-add hook surface for Objective 6 (the rare
//      walk-into-new-LB case). Per-instance draw cost is fine at one
//      LB's-worth of statics (~5 placements median across the 13×13
//      ring); the bake-time cost of re-instancing the existing
//      ring-wide InstancedMesh per new placement would be far worse.
//
//   2. `bakeStaticsRing(scene3d, centreLbX, centreLbY, radius,
//      wasmExports)` — driver that COLLECTS placements + unique
//      modelIds across all LBs in the ring, then instantiates ONE
//      `THREE.InstancedMesh` per modelId with ≥2 instances (preserving
//      today's F#5+6 collapse win). Singletons get plain
//      `THREE.Mesh`. After the InstancedMesh batch is added, the
//      driver marks all ring LBs as baked in `staticsBakedLbs`. This
//      is the **first objective where per-LB and ring shapes diverge
//      meaningfully** — see comments at the head of `bakeStaticsRing`.
//
//   3. `buildHoltburgStatics(scene3d, wasmExports)` — one-line
//      back-compat wrapper calling `bakeStaticsRing(scene3d, 0xa9,
//      0xb4, 1, wasmExports)` so existing callers (init3D radius=1,
//      Phase 7.2 capture, F#5+6 capture) stay green.

import * as THREE from "three";
import { meshToFusedGeometry, placementToMatrix4 } from "./adapter.js";
import { MaterialCache, materialCanCastShadow } from "./materials.js";

const METERS_PER_LANDBLOCK = 192.0;
const HOLTBURG_X = 0xa9;
const HOLTBURG_Y = 0xb4;

// FU2 (perf follow-on 2026-05-18) — distance-tier follow-on for C2's
// `low`-preset receiveShadow gate. At mid/high/ultra a placement gets
// `receiveShadow = true` only when its world-space distance to the
// spawn point (Holtburg LB centre) is under SHADOW_RECEIVE_RANGE_M.
// Beyond that it falls back to `receiveShadow = false`. Reasoning:
//
//   - CSM frustum-test cost scales linearly with receiver count; the
//     audit measured a meaningful win when distant statics were
//     dropped (~16,700 placements over a 13×13 ring with most >60 m
//     from spawn).
//   - 60 m is a conservative half-LB radius — well inside the
//     near-field where shadow receivers visually matter.
//   - **Static reference, not player-tracking.** We compare against
//     the spawn point at bake time; we don't re-bake on movement.
//     The world-expand step 1 ring is ≤6 LBs around Holtburg (≤576 m
//     radius), so the spawn-point distance is a stable proxy for
//     "near the player" at session start. TODO(FU2-future): player-
//     tracking gate that updates `receiveShadow` on LB-cross would
//     need a per-frame walk of `staticsGroup` children — defer until
//     we have movement-driven re-bake infrastructure.
const SHADOW_RECEIVE_RANGE_M = 60.0;
const SHADOW_RECEIVE_RANGE_SQ_M = SHADOW_RECEIVE_RANGE_M * SHADOW_RECEIVE_RANGE_M;
// Spawn point = Holtburg LB centre. Matches the convention used by
// scene3d/index.js to seed the initial camera at session start.
const SPAWN_REF_X = HOLTBURG_X * METERS_PER_LANDBLOCK + METERS_PER_LANDBLOCK / 2;
const SPAWN_REF_Y = HOLTBURG_Y * METERS_PER_LANDBLOCK + METERS_PER_LANDBLOCK / 2;

/**
 * FU2 — per-placement receive-shadow predicate. Extends C2's
 * `staticsReceiveShadow` (the low-preset gate) with a distance check
 * against the spawn point. Applied ONLY to plain `THREE.Mesh`
 * singletons (and their degraded LOD leaves). `InstancedMesh` keeps the
 * simple low-preset gate per the audit's option (b) — per-instance
 * `receiveShadow` isn't a thing in three.js, and splitting each
 * InstancedMesh by tier is deferred.
 *
 *   staticsReceiveShadow: the C2 low-preset bool — already false at low.
 *   worldX, worldY: placement world-space position (LB origin + local).
 *
 * Returns false at low (matches C2 behaviour), false beyond the range,
 * true within the range at mid/high/ultra.
 */
function staticsReceiveShadowForPlacement(
  staticsReceiveShadow,
  worldX,
  worldY
) {
  if (!staticsReceiveShadow) return false;
  const dx = worldX - SPAWN_REF_X;
  const dy = worldY - SPAWN_REF_Y;
  return dx * dx + dy * dy < SHADOW_RECEIVE_RANGE_SQ_M;
}

// F#5 — distance at which the renderer swaps from full to degraded
// geometry. AC retail used ~100m for distant-scenery LOD (trees, hill
// foliage). The exact retail threshold isn't preserved in the DAT, so
// we pick a conservative 100m; anything closer than that gets the full
// mesh, anything farther gets the lower-detail variant.
const LOD_DISTANCE_M = 100.0;

// Phase C.3 — base URL for the baked scenery JSONL files. Mirrors
// index.html's `MANIFEST_URL = "../../dist/manifest.json"`; scenery
// files live at `../../dist/scenery/0xXXXX.scenery.jsonl`. Init is
// idempotent + module-local so the second baker call (per-LB lazy +
// ring driver overlap) doesn't re-call `init_scenery_base_url`.
const SCENERY_BASE_URL = "../../dist/scenery/";
let _sceneryBaseUrlInitialized = false;

/**
 * Phase C.3 — fail-soft scenery base-URL init. Called once per page
 * by the first scenery-fetching baker. If `init_scenery_base_url`
 * is not in wasmExports (older bundle, unit-test stub) OR the call
 * throws, we mark "tried" and move on — `fetch_landblock_scenery`
 * will reject, and the per-baker call wraps that in a soft skip so
 * the rest of the bake (LandblockInfo path) still lands.
 */
function ensureSceneryInit(wasmExports) {
  if (_sceneryBaseUrlInitialized) return;
  _sceneryBaseUrlInitialized = true;
  if (
    !wasmExports ||
    typeof wasmExports.init_scenery_base_url !== "function"
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      "[scene3d.statics] init_scenery_base_url not in wasmExports; " +
        "scenery placements will be skipped"
    );
    return;
  }
  try {
    wasmExports.init_scenery_base_url(SCENERY_BASE_URL);
    // eslint-disable-next-line no-console
    console.log(
      "[scene3d.statics] scenery base URL initialized:",
      SCENERY_BASE_URL
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      "[scene3d.statics] init_scenery_base_url threw; scenery placements will be skipped:",
      String(e).slice(0, 120)
    );
  }
}

/**
 * Encode an `(lbX, lbY)` pair as the `Set<u32>` key used by
 * `scene3d.staticsBakedLbs`. Matches the shape used by Phase 6's
 * lazy-LB sets (`(lbX << 24) | (lbY << 16)`). Returning a `>>> 0`
 * unsigned int keeps the key stable across `Set.has` lookups in
 * Chrome / Firefox / Node.
 */
function lbSetKey(lbX, lbY) {
  return (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16)) >>> 0;
}

/**
 * Acquire (or create) `scene3d.materialCache`. Lifted out of the old
 * inline body so both the per-LB and ring drivers can share the same
 * lazy-init. Matches the existing buildings.js / cells.js pattern.
 *
 * Phase 0.2 / 3.3 — detail-tile cache + CSM state propagation. See
 * buildings.js for the full rationale; same wiring here.
 */
function getOrCreateMaterialCache(scene3d) {
  if (scene3d.materialCache) return scene3d.materialCache;
  const mc = new MaterialCache({
    detailTileCache: scene3d.detailTileCache ?? null,
    forceDetail: !!scene3d.forceDetail,
    csmState: scene3d.csmState ?? null,
    pomEnabled: !!scene3d.pomEnabled,
    forcePom: !!scene3d.forcePom,
  });
  scene3d.materialCache = mc;
  return mc;
}

/**
 * Snapshot every non-building placement out of a `fetch_landblock_objects`
 * result into plain JS objects. The wasm-side `ObjectPlacement`s are
 * freed in the same loop; keeping them around through subsequent
 * model + surface fetches risks detached buffers if linear memory
 * grows. Returns `{ statics: PlainPlacement[] }`.
 *
 * Each emitted record carries `source = "landblockinfo"` so post-bake
 * code can distinguish DAT-explicit placements from
 * `fetchAndDrainScenery`'s `source = "scenery"` placements without
 * inspecting the wasm-side type. `scale = 1` is the implicit
 * LandblockInfo convention (the DAT `Frame` doesn't carry per-object
 * scale; only `LandblockInfo.objects` scales come through the building
 * pipeline). Scenery's `placement.scale` carries the baked value.
 */
function drainPlacements(allPlacements) {
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
        scale: 1,
        source: "landblockinfo",
      });
    }
    if (typeof p.free === "function") p.free();
  }
  return statics;
}

/**
 * Phase C.3 — fetch baked scenery placements for `cellIds` and convert
 * each `ScenicPlacementJs` into the same shape as
 * `drainPlacements`-output records, so the rest of the baker can
 * treat both streams identically.
 *
 * Conversion details:
 *   - `objId` → `modelId` (top byte 0x01 = GfxObj, 0x02 = SetupModel —
 *     matches LandblockInfo's `modelId` namespace).
 *   - Yaw-only quaternion → `rotationZ`. The bake emits
 *     `Quaternion.CreateFromYawPitchRoll(0, 0, rot)` so the quaternion
 *     is z-axis-only: `qw = cos(yaw/2)`, `qz = sin(yaw/2)`, xy zero.
 *     We extract yaw via the same `atan2(2(qw·qz + qx·qy), 1 - 2(qy² +
 *     qz²))` formula `fetch_landblock_objects` uses on its way out.
 *   - `scale` is preserved (baked, may be 0.5 – 3.0 across retail
 *     scenery).
 *   - `isBuilding` is always false (scenery is never a building).
 *   - `source = "scenery"` distinguishes from LandblockInfo placements.
 *
 * `wasmExports.fetch_landblock_scenery` returns `Vec<ScenicPlacementJs>`
 * with the wasm-bindgen camelCased field names (`objId`, `qw`, …,
 * `landblockId`). The ScenicPlacementJs objects are freed inline so
 * their wasm-side bookkeeping doesn't leak.
 *
 * Fail-soft contract:
 *   - If `fetch_landblock_scenery` is not in `wasmExports` (older bundle,
 *     unit-test stub), returns `[]`.
 *   - If the call rejects (init not done, HTTP error, JSON-parse fail),
 *     returns `[]` after logging a warning. The bake continues with
 *     LandblockInfo-only placements.
 *   - Empty result (LB has 0 baked scenery, 55 of 169 ring LBs per
 *     Phase B.3 oracle) returns `[]` cleanly — no logging.
 */
async function fetchAndDrainScenery(cellIds, wasmExports) {
  if (
    !wasmExports ||
    typeof wasmExports.fetch_landblock_scenery !== "function"
  ) {
    return [];
  }
  ensureSceneryInit(wasmExports);
  let scenery;
  try {
    scenery = await wasmExports.fetch_landblock_scenery(cellIds);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      "[scene3d.statics] fetch_landblock_scenery failed; " +
        "skipping baked scenery for this batch:",
      String(e).slice(0, 200)
    );
    return [];
  }
  const out = [];
  for (const p of scenery) {
    const qw = p.qw;
    const qx = p.qx;
    const qy = p.qy;
    const qz = p.qz;
    // Standard yaw extraction. Matches the formula in
    // lib.rs:`frame_to_placement` used by `fetch_landblock_objects`
    // so LandblockInfo + scenery rotations agree on convention.
    const sinyCosp = 2.0 * (qw * qz + qx * qy);
    const cosyCosp = 1.0 - 2.0 * (qy * qy + qz * qz);
    const yaw = Math.atan2(sinyCosp, cosyCosp);
    out.push({
      landblockId: p.landblockId,
      modelId: p.objId,
      x: p.x,
      y: p.y,
      z: p.z,
      rotationZ: yaw,
      isBuilding: false,
      scale: p.scale && p.scale > 0 ? p.scale : 1,
      source: "scenery",
    });
    if (typeof p.free === "function") p.free();
  }
  return out;
}

/**
 * Fetch the per-model fused geometries + dominant surface DIDs +
 * didDegrade chain from `fetch_model_meshes` for a given set of
 * `uniqueModelIds`. Mirrors the inner body of the pre-refactor
 * `buildHoltburgStatics`. Returns `{ geomByModel, dominantSurfaceByModel,
 * didDegradeByModel, allSurfaceDids, skippedZeroTri }`.
 *
 * Note: this is intentionally separate from `fetchDegradedGeometries`
 * below — the degraded fetch is a SECOND `fetch_model_meshes` round
 * trip and is only meaningful once the primary chain is in hand.
 */
async function fetchPrimaryGeometries(uniqueModelIds, fetchModelMeshes) {
  const geomByModel = new Map();
  const dominantSurfaceByModel = new Map();
  const didDegradeByModel = new Map();
  const allSurfaceDids = new Set();
  let skippedZeroTri = 0;

  if (uniqueModelIds.length === 0) {
    return {
      geomByModel,
      dominantSurfaceByModel,
      didDegradeByModel,
      allSurfaceDids,
      skippedZeroTri,
    };
  }

  let meshes;
  try {
    meshes = await fetchModelMeshes(new Uint32Array(uniqueModelIds));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[scene3d.statics] fetch_model_meshes batch failed:", e);
    return {
      geomByModel,
      dominantSurfaceByModel,
      didDegradeByModel,
      allSurfaceDids,
      skippedZeroTri,
      fetchFailed: true,
    };
  }

  for (let i = 0; i < uniqueModelIds.length; i += 1) {
    const id = uniqueModelIds[i];
    const m = meshes[i];
    if (!m) continue;
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

  return {
    geomByModel,
    dominantSurfaceByModel,
    didDegradeByModel,
    allSurfaceDids,
    skippedZeroTri,
  };
}

/**
 * F#5 — fetch degraded variant geometries for every model that
 * reports a non-zero didDegrade. One wasm round-trip resolves them
 * all. Failures (degraded DID not in DAT) silently drop to "no LOD"
 * and the model uses a plain Mesh / InstancedMesh.
 */
async function fetchDegradedGeometries(didDegradeByModel, fetchModelMeshes) {
  const degradedGeomByModel = new Map();
  const degradedIds = [...didDegradeByModel.values()];
  if (degradedIds.length === 0) return degradedGeomByModel;

  try {
    const degradedMeshes = await fetchModelMeshes(new Uint32Array(degradedIds));
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
  return degradedGeomByModel;
}

/**
 * Build the "dominant" material map per modelId. Falls back to the
 * cache's fallback material when the model has no resolved surface.
 * Same shape used by both bakers.
 */
function buildMaterialMap(geomByModel, dominantSurfaceByModel, materialCache) {
  const matByModel = new Map();
  for (const [modelId] of geomByModel) {
    const did = dominantSurfaceByModel.get(modelId);
    if (typeof did === "number" && did !== 0) {
      matByModel.set(modelId, materialCache.getCached(did));
    } else {
      matByModel.set(modelId, materialCache.fallbackMaterial);
    }
  }
  return matByModel;
}

/**
 * Compute the world-space matrix for a placement. Mirrors the old
 * inline `placementMatrix` helper from the pre-refactor body. Reuses
 * per-call temporaries to avoid GC churn in long-running ring bakes.
 */
function makePlacementMatrixHelper() {
  const tmpQuat = new THREE.Quaternion();
  const tmpAxis = new THREE.Vector3(0, 0, 1);
  const tmpScale = new THREE.Vector3(1, 1, 1);
  const tmpPos = new THREE.Vector3();
  const tmpMat = new THREE.Matrix4();
  return function placementMatrix(placement) {
    const lbX = (placement.landblockId >>> 24) & 0xff;
    const lbY = (placement.landblockId >>> 16) & 0xff;
    const worldX = lbX * METERS_PER_LANDBLOCK + placement.x;
    const worldY = lbY * METERS_PER_LANDBLOCK + placement.y;
    tmpPos.set(worldX, worldY, placement.z);
    tmpQuat.setFromAxisAngle(tmpAxis, placement.rotationZ ?? 0);
    // Phase C.3 — honour per-placement scale. LandblockInfo placements
    // arrive with `scale = 1` (set by `drainPlacements`); scenery
    // placements carry the baked value (0.5 – 3.0 typical for retail
    // trees/rocks). Uniform-scale only; AC's `ObjectDesc` uses a
    // single float.
    const s =
      typeof placement.scale === "number" && placement.scale > 0
        ? placement.scale
        : 1;
    tmpScale.set(s, s, s);
    tmpMat.compose(tmpPos, tmpQuat, tmpScale);
    return tmpMat;
  };
}

/**
 * Build a singleton plain-Mesh node (no InstancedMesh) for one
 * placement. Used by:
 *   - the ring driver for groups with exactly one instance, and
 *   - the per-LB lazy baker for EVERY placement in the new LB
 *     (because per-LB lazy adds can't be batched into the ring's
 *     existing InstancedMesh without complex re-instantiation).
 *
 * When `degradedGeom` is non-null, wraps the full + degraded leaves
 * in a `THREE.LOD`. Most Holtburg statics have no degrade chain so
 * the wrap is a future-proofing no-op today, but we keep it so the
 * lazy-add code path matches the ring-bake code path exactly.
 *
 * Caller adds the returned node to `scene3d.staticsGroup`.
 */
function buildSingletonNode({
  placement,
  modelId,
  geom,
  degradedGeom,
  mat,
  staticsShadow,
  staticsMatCastsShadow,
  staticsReceiveShadow,
}) {
  const modelKey = (modelId >>> 0).toString(16).padStart(8, "0");
  const lbX = (placement.landblockId >>> 24) & 0xff;
  const lbY = (placement.landblockId >>> 16) & 0xff;
  const worldX = lbX * METERS_PER_LANDBLOCK + placement.x;
  const worldY = lbY * METERS_PER_LANDBLOCK + placement.y;
  const placementKey =
    `${(placement.landblockId >>> 0).toString(16).padStart(8, "0")}_` +
    `${placement.x.toFixed(2)}_${placement.y.toFixed(2)}_${modelKey}`;

  // Phase C.3 — uniform per-placement scale. LandblockInfo placements
  // arrive with `scale = 1` (set by `drainPlacements`); scenery
  // placements carry the baked value. AC's `ObjectDesc.scale` is a
  // single float — uniform across xyz.
  const placementScale =
    typeof placement.scale === "number" && placement.scale > 0
      ? placement.scale
      : 1;
  const source = placement.source || "landblockinfo";

  // FU2 — per-placement receive-shadow decision. Singleton path uses
  // the distance-tier predicate; falls back to false at `low` preset
  // (C2) OR beyond SHADOW_RECEIVE_RANGE_M from spawn.
  const placementReceiveShadow = staticsReceiveShadowForPlacement(
    staticsReceiveShadow,
    worldX,
    worldY
  );

  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = `static-${placementKey}`;
  mesh.position.set(worldX, worldY, placement.z);
  const yawQuat = new THREE.Quaternion();
  yawQuat.setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    placement.rotationZ ?? 0
  );
  mesh.quaternion.copy(yawQuat);
  if (placementScale !== 1) {
    mesh.scale.set(placementScale, placementScale, placementScale);
  }
  mesh.userData = {
    modelId,
    landblockId: placement.landblockId,
    placementKey,
    isBuilding: false,
    source,
  };
  if (staticsShadow) {
    mesh.castShadow = staticsMatCastsShadow;
    // FU2 (perf follow-on 2026-05-18) — distance-tier gate on top of
    // C2's low-preset gate. Foreground (<60 m from spawn) at mid/high/
    // ultra keeps receiveShadow=true; everything else (low preset OR
    // >=60 m) gets false. Spawn-anchored at bake time, not player-
    // tracked. TODO(FU2-future): per-frame walk on LB-cross to update
    // when we have movement-driven re-bake infra.
    mesh.receiveShadow = placementReceiveShadow;
  }

  if (!degradedGeom) {
    return { node: mesh, isLod: false };
  }

  const degradedMesh = new THREE.Mesh(degradedGeom, mat);
  degradedMesh.name = `static-degraded-${placementKey}`;
  if (staticsShadow) {
    degradedMesh.castShadow = staticsMatCastsShadow;
    // FU2 — same per-placement distance gate as the full-detail leaf
    // above. Both LOD levels share the placement's spawn-distance so
    // the gate decision is identical; reusing the cached predicate
    // result keeps the two leaves consistent.
    degradedMesh.receiveShadow = placementReceiveShadow;
  }
  degradedMesh.position.copy(mesh.position);
  degradedMesh.quaternion.copy(mesh.quaternion);
  if (placementScale !== 1) {
    degradedMesh.scale.set(placementScale, placementScale, placementScale);
  }
  degradedMesh.userData = {
    modelId,
    landblockId: placement.landblockId,
    placementKey,
    isBuilding: false,
    isDegraded: true,
    source,
  };
  const lod = new THREE.LOD();
  lod.name = `static-lod-${placementKey}`;
  lod.position.copy(mesh.position);
  lod.quaternion.copy(mesh.quaternion);
  if (placementScale !== 1) {
    lod.scale.set(placementScale, placementScale, placementScale);
  }
  // Children of LOD inherit no transform unless explicitly applied —
  // three.js LOD positions its children at the LOD's own transform,
  // and the per-child mesh's position becomes a local offset. Reset
  // the child positions to identity so the LOD's transform alone
  // places the cluster.
  mesh.position.set(0, 0, 0);
  mesh.quaternion.identity();
  mesh.scale.set(1, 1, 1);
  degradedMesh.position.set(0, 0, 0);
  degradedMesh.quaternion.identity();
  degradedMesh.scale.set(1, 1, 1);
  lod.addLevel(mesh, 0);
  lod.addLevel(degradedMesh, LOD_DISTANCE_M);
  lod.userData = {
    modelId,
    landblockId: placement.landblockId,
    placementKey,
    isBuilding: false,
    source,
  };
  return { node: lod, isLod: true };
}

/**
 * Build an `InstancedMesh` (optionally LOD-wrapped) covering all
 * placements that share the given modelId. Used by the ring driver
 * only — the per-LB lazy baker uses `buildSingletonNode` for every
 * placement because re-instantiating the ring's existing InstancedMesh
 * to absorb one new instance is far more expensive than emitting a
 * single extra plain-Mesh draw call.
 *
 * Caller adds the returned node to `scene3d.staticsGroup`.
 */
function buildInstancedNode({
  modelId,
  group,
  geom,
  degradedGeom,
  mat,
  placementMatrix,
  staticsShadow,
  staticsMatCastsShadow,
  staticsReceiveShadow,
}) {
  const modelKey = (modelId >>> 0).toString(16).padStart(8, "0");
  // Phase C.3 — track per-source counts so post-bake queries can
  // distinguish "this instanced group is 30% LandblockInfo + 70%
  // scenery" without walking every matrix. Single-source groups (the
  // common case — a tree modelId only appears in scenery, a sign only
  // in LandblockInfo) get a single string; mixed groups get an
  // object.
  let sceneryCount = 0;
  let landblockInfoCount = 0;
  for (const p of group) {
    if (p.source === "scenery") sceneryCount += 1;
    else landblockInfoCount += 1;
  }
  const source =
    sceneryCount === 0
      ? "landblockinfo"
      : landblockInfoCount === 0
      ? "scenery"
      : "mixed";
  const instanced = new THREE.InstancedMesh(geom, mat, group.length);
  instanced.name = `static-instanced-${modelKey}-x${group.length}`;
  instanced.userData = {
    modelId,
    isBuilding: false,
    instanceCount: group.length,
    source,
    sceneryCount,
    landblockInfoCount,
  };
  if (staticsShadow) {
    instanced.castShadow = staticsMatCastsShadow;
    // C2 (perf plan 2026-05-18) — `low` preset: receiveShadow off across
    // all 16,700 placements; mid/high/ultra keep today's all-receivers
    // behaviour. FU2 (perf follow-on) — InstancedMesh deliberately KEEPS
    // the simple low-preset gate; `THREE.InstancedMesh.receiveShadow`
    // is per-mesh (not per-instance) so the distance-tier gate can't
    // discriminate between foreground + background instances under the
    // same draw call. The audit's option (a) — splitting each
    // InstancedMesh by tier — is deferred until the singleton-path win
    // (FU2 (b)) demonstrably falls short. See FU2 in
    // docs/fps-perf-followon-2026-05-18.md.
    instanced.receiveShadow = staticsReceiveShadow;
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

  if (!degradedGeom) {
    return { node: instanced, isLod: false };
  }

  const degradedInstanced = new THREE.InstancedMesh(
    degradedGeom,
    mat,
    group.length
  );
  degradedInstanced.name = `static-instanced-degraded-${modelKey}`;
  if (staticsShadow) {
    degradedInstanced.castShadow = staticsMatCastsShadow;
    // C2 + FU2 — same low-preset gate as the full-detail InstancedMesh
    // above. InstancedMesh is excluded from the distance-tier gate by
    // design (per-mesh, not per-instance); see the comment block on
    // the full-detail leaf for the full audit reasoning.
    degradedInstanced.receiveShadow = staticsReceiveShadow;
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
  lod.userData = {
    modelId,
    isBuilding: false,
    isInstancedLod: true,
    source,
    sceneryCount,
    landblockInfoCount,
  };
  return { node: lod, isLod: true };
}

/**
 * Empty per-call summary used by both the early-return paths and as
 * the starting accumulator for the ring driver.
 */
function makeEmptySummary() {
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
    // Phase C.3 — per-source counts so capture scripts / smoke can
    // assert "the scenery wire-up landed non-zero placements". Sum to
    // `objectCount` (sceneryObjectCount + landblockInfoObjectCount).
    sceneryObjectCount: 0,
    landblockInfoObjectCount: 0,
  };
}

/**
 * **Per-LB baker** — bakes ONE landblock's non-building static objects.
 * Idempotent via `scene3d.staticsBakedLbs: Set<u32>`. Designed for the
 * Objective 6 lazy-walk path; uses **single-instance plain `THREE.Mesh`
 * adds** (no `InstancedMesh`) because:
 *
 *   - The lazy-add hook is rare enough (one LB per walk-into-new-LB
 *     event, ~5 statics median across the 13×13 ring per Objective 4
 *     planning) that per-instance draw cost is fine.
 *   - Re-instantiating the existing ring InstancedMesh to absorb a
 *     single new instance would require rebuilding the entire
 *     per-modelId InstanceMatrix buffer and re-uploading to the GPU,
 *     which costs more than the saved draw call.
 *
 * The ring driver (`bakeStaticsRing`) is the one that gets the
 * InstancedMesh collapse win across the initial ring bake. The two
 * shapes diverge meaningfully — see the comment block at the head of
 * `bakeStaticsRing`.
 *
 * Returns the per-LB summary in the canonical shape, or `null` when
 * the LB has already been baked.
 */
export async function bakeStaticsForLandblock(
  scene3d,
  lbX,
  lbY,
  opts,
  wasmExports
) {
  if (!scene3d || !scene3d.staticsGroup) {
    throw new Error("bakeStaticsForLandblock: scene3d.staticsGroup missing");
  }
  if (
    !wasmExports ||
    typeof wasmExports.fetch_landblock_objects !== "function" ||
    typeof wasmExports.fetch_model_meshes !== "function" ||
    typeof wasmExports.fetch_surfaces_pixels !== "function"
  ) {
    throw new Error(
      "bakeStaticsForLandblock: wasmExports missing fetch_landblock_objects / fetch_model_meshes / fetch_surfaces_pixels"
    );
  }
  if (!(scene3d.staticsBakedLbs instanceof Set)) {
    scene3d.staticsBakedLbs = new Set();
  }

  const lbKey = lbSetKey(lbX, lbY);
  if (scene3d.staticsBakedLbs.has(lbKey)) {
    // Idempotent — second call for the same LB no-ops.
    return null;
  }
  // Mark BEFORE the bake completes so a concurrent caller (e.g. two
  // overlapping `handlePositionUpdate` events for the same LB) sees
  // the gate and short-circuits. Matches the pattern in
  // `buildEnvCellsForLandblock`.
  scene3d.staticsBakedLbs.add(lbKey);

  // Materials shared with buildings / cells phases (Phase 0.2 / 3.3
  // propagation). The ring driver creates this first; the per-LB
  // baker re-uses it if present, otherwise creates a fresh cache
  // (the lazy-walk path may run before the ring bake has installed
  // one, e.g. in unit tests).
  const materialCache = getOrCreateMaterialCache(scene3d);

  // Single-LB fetch — `0xfffe` suffix selects LandblockInfo (objects
  // + buildings). `0xffff` is the terrain CellLandblock and won't
  // return placements.
  const cellId = (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16) | 0xfffe) >>> 0;
  const cellIds = new Uint32Array([cellId]);
  const allPlacements = await wasmExports.fetch_landblock_objects(cellIds);
  const landblockInfoStatics = drainPlacements(allPlacements);
  // Phase C.3 — fetch baked scenery placements in parallel-ish (after
  // the LandblockInfo drain so the wasm `ObjectPlacement` linear-memory
  // free-loop completes first; scenery's `ScenicPlacementJs` records are
  // a separate wasm pool and don't interfere). The result is the
  // SCENERY placement stream with `source = "scenery"`; LandblockInfo
  // is tagged `source = "landblockinfo"` by `drainPlacements`. Both
  // arrays carry the same shape so the rest of the bake (group-by-
  // modelId, materialCache.preload, buildSingletonNode) treats them
  // identically.
  //
  // Many LBs have 0 baked scenery (55 of 169 ring LBs per Phase B.3
  // oracle — buildings collide all candidates out, or the terrain
  // codes don't reference any scene). Empty-scenery is the common
  // case; we treat it as "nothing to add" and continue with whatever
  // LandblockInfo placements survived.
  const sceneryStatics = await fetchAndDrainScenery(cellIds, wasmExports);
  // Concatenate. The merged array is the single source of truth for
  // the rest of the per-LB bake. Order is LandblockInfo first then
  // scenery — purely for log-readability; the renderer doesn't care.
  const statics = landblockInfoStatics.concat(sceneryStatics);
  if (statics.length === 0) {
    return makeEmptySummary();
  }

  const uniqueModelIds = [...new Set(statics.map((s) => s.modelId))];
  const primary = await fetchPrimaryGeometries(
    uniqueModelIds,
    wasmExports.fetch_model_meshes
  );
  if (primary.fetchFailed) {
    return {
      ...makeEmptySummary(),
      skippedNoMesh: statics.length,
    };
  }
  const degradedGeomByModel = await fetchDegradedGeometries(
    primary.didDegradeByModel,
    wasmExports.fetch_model_meshes
  );

  // Per-LB surface preload. The ring driver preloads ALL ring DIDs in
  // a single batch (Phase 7.2 buildings.js pattern); the lazy-add
  // path only sees this LB's DIDs so the preload is local.
  if (primary.allSurfaceDids.size > 0) {
    try {
      await materialCache.preload(
        [...primary.allSurfaceDids],
        wasmExports.fetch_surfaces_pixels
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        "[scene3d.statics] per-LB materialCache.preload failed:",
        e
      );
    }
  }

  const matByModel = buildMaterialMap(
    primary.geomByModel,
    primary.dominantSurfaceByModel,
    materialCache
  );

  // === Per-LB instantiation — plain Mesh per placement, no InstancedMesh ===
  // Document the per-LB vs ring shape divergence: this loop emits one
  // node per placement, even when two placements in the same LB share
  // a modelId. The ring driver collapses those duplicates into
  // InstancedMesh; the per-LB lazy baker does not, because the
  // expected per-LB placement count (~5 median across the 13×13 ring)
  // makes the InstancedMesh round-trip cost higher than the saved
  // draw calls.
  const staticsShadow = !!scene3d.shadowsEnabled || !!scene3d.csmEnabled;
  // C2 (perf plan 2026-05-18) — at the `low` quality preset every
  // static skips receiveShadow (CSM frustum-test cost scales linearly
  // with receiver count, ~16,700 placements in Holtburg). mid/high/ultra
  // keep today's all-receivers behaviour. Read mirrors the convention
  // used elsewhere in scene3d (e.g. terrain.js `scene3d.quality?.flags`).
  // FU2 (perf follow-on 2026-05-18) — this is the C2 low-preset bool;
  // the per-placement distance-tier predicate
  // (`staticsReceiveShadowForPlacement`) consumes it inside
  // `buildSingletonNode` for plain `THREE.Mesh` singletons + LOD leaves.
  // InstancedMesh (not on this path — the per-LB baker only emits
  // singletons) keeps the simple low-preset gate.
  const staticsReceiveShadow = scene3d.quality?.preset !== "low";
  let objectCount = 0;
  let singletonCount = 0;
  let lodCount = 0;
  let skippedNoMesh = 0;
  let sceneryObjectCount = 0;
  let landblockInfoObjectCount = 0;
  for (const placement of statics) {
    const geom = primary.geomByModel.get(placement.modelId);
    if (!geom) {
      skippedNoMesh += 1;
      continue;
    }
    const mat =
      matByModel.get(placement.modelId) || materialCache.fallbackMaterial;
    const degradedGeom = degradedGeomByModel.get(placement.modelId) || null;
    const staticsMatCastsShadow = materialCanCastShadow(mat);
    const { node, isLod } = buildSingletonNode({
      placement,
      modelId: placement.modelId,
      geom,
      degradedGeom,
      mat,
      staticsShadow,
      staticsMatCastsShadow,
      staticsReceiveShadow,
    });
    scene3d.staticsGroup.add(node);
    objectCount += 1;
    singletonCount += 1;
    if (isLod) lodCount += 1;
    if (placement.source === "scenery") sceneryObjectCount += 1;
    else landblockInfoObjectCount += 1;
  }

  // Draw-call savings for the per-LB path: every placement becomes
  // its own draw call (plain Mesh, no instancing). So the count is
  // identical to `objectCount`; the "savings" relative to per-Mesh
  // is zero. That's by design for the lazy-walk path — see the
  // comment block above.
  return {
    objectCount,
    modelCount: primary.geomByModel.size,
    surfaceCount: primary.allSurfaceDids.size,
    skippedZeroTri: primary.skippedZeroTri,
    skippedNoMesh,
    instancedGroupCount: 0,
    singletonCount,
    lodCount,
    drawCallReductionEstimate: 0,
    sceneryObjectCount,
    landblockInfoObjectCount,
  };
}

/**
 * **Ring driver** — collects placements + unique modelIds across ALL
 * LBs in a `(centreLbX, centreLbY)` ± `radius` window, then
 * instantiates ONE `THREE.InstancedMesh` per modelId with ≥2
 * instances (preserving today's F#5+6 collapse win). Singletons get
 * plain `THREE.Mesh`. After the InstancedMesh batch is added, marks
 * every LB in the ring as baked in `scene3d.staticsBakedLbs`.
 *
 * ── Per-LB vs ring shape divergence (load-bearing) ────────────────────
 *
 * This is the **first World-expand step 1 objective where the per-LB
 * baker and the ring driver diverge meaningfully in their output
 * topology**. The reason:
 *
 *   - Today the 3×3 ring has 222 placements / 66 unique modelIds →
 *     222 draw calls collapse to ~66 via InstancedMesh. At radius=6
 *     (13×13 = 169 LBs ≈ 766 statics per Objective 4 planning) the
 *     collapse becomes even more important (~130 unique modelIds vs
 *     766 placements, ~6× draw-call reduction).
 *
 *   - The lazy-walk path (Objective 6) bakes ONE NEW LB at a time
 *     when the player walks into it. Re-instantiating the ring's
 *     existing InstancedMesh to absorb a single new placement
 *     requires rebuilding the entire per-modelId InstanceMatrix
 *     buffer and re-uploading to the GPU — far more expensive than
 *     emitting one extra plain-Mesh draw call per new placement.
 *     The lazy-add count is small (~5 statics per LB median across
 *     the ring per Objective 4 planning) so per-instance draw cost
 *     is acceptable.
 *
 * Therefore:
 *   - `bakeStaticsForLandblock` (per-LB, Objective 4 + Objective 6
 *     consumer) uses plain `THREE.Mesh` per placement.
 *   - `bakeStaticsRing` (ring, Objective 4 driver + Objective 8
 *     consumer for radius=6 initial bake) uses InstancedMesh per
 *     modelId with ≥2 instances; singletons remain plain Mesh.
 *
 * Both paths share `buildSingletonNode`'s LOD wrapping logic when a
 * model has a non-zero `didDegrade` chain.
 *
 * The two also diverge in surface preload: the ring driver preloads
 * ALL ring DIDs in a single batched `fetch_surfaces_pixels` call
 * (matches buildings.js Phase 7.2 pattern); the per-LB baker only
 * preloads the new LB's DIDs.
 *
 * ── Idempotency ───────────────────────────────────────────────────────
 *
 * Per-LB cells in the ring that were already baked (e.g. a prior
 * `bakeStaticsForLandblock` call from the lazy-walk path) are
 * skipped — their placements are dropped from the ring's accumulator
 * BEFORE the InstancedMesh batch, so the existing per-LB nodes stay
 * in `staticsGroup` un-touched.
 *
 * In practice for World-expand step 1 the ring driver runs first at
 * init (radius=1 today, radius=6 at Objective 8) and the per-LB
 * baker runs second from the lazy hook; the idempotency check
 * mainly guards the test-time path where the order can flip.
 */
export async function bakeStaticsRing(
  scene3d,
  centreLbX,
  centreLbY,
  radius,
  wasmExports
) {
  if (!scene3d || !scene3d.staticsGroup) {
    throw new Error("bakeStaticsRing: scene3d.staticsGroup missing");
  }
  if (
    !wasmExports ||
    typeof wasmExports.fetch_landblock_objects !== "function" ||
    typeof wasmExports.fetch_model_meshes !== "function" ||
    typeof wasmExports.fetch_surfaces_pixels !== "function"
  ) {
    throw new Error(
      "bakeStaticsRing: wasmExports missing fetch_landblock_objects / fetch_model_meshes / fetch_surfaces_pixels"
    );
  }
  if (!(scene3d.staticsBakedLbs instanceof Set)) {
    scene3d.staticsBakedLbs = new Set();
  }

  // World-expand step 1 Objective 5 — persist a marker opts bag on
  // scene3d so `liveScene3d.loadStaticsForLandblock(lbX, lbY)` has a
  // non-undefined value to forward into `bakeStaticsForLandblock`.
  // Set up-front (not after the bake) so the lazy hook can fire
  // concurrently with the initial ring bake — both call paths see a
  // populated field. The per-LB baker currently reads shared state
  // (materialCache, shadowsEnabled, staticsBakedLbs) directly off
  // `scene3d` rather than `opts`, so the payload is a stub today.
  // See the matching terrain.js (`scene3d.terrainOpts`) and
  // buildings.js (`scene3d.buildingsOpts`) persists.
  scene3d.staticsOpts = {
    centreLbX,
    centreLbY,
    radius,
  };

  // Collect every LB in the ring that hasn't already been baked.
  // Phase 7.2-era code unconditionally walked the 3×3; the new shape
  // honours the per-LB bake gate so the lazy-walk path's prior bakes
  // are preserved. (At init time the set is empty so all `radius²`
  // LBs go through.)
  const neighbourhood = [];
  const newlyBakingKeys = [];
  for (let dy = radius; dy >= -radius; dy -= 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const lbX = centreLbX + dx;
      const lbY = centreLbY + dy;
      if (lbX < 0 || lbX > 0xff || lbY < 0 || lbY > 0xff) continue;
      const lbKey = lbSetKey(lbX, lbY);
      if (scene3d.staticsBakedLbs.has(lbKey)) continue;
      neighbourhood.push({
        x: lbX,
        y: lbY,
        cellId: (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16) | 0xfffe) >>> 0,
      });
      newlyBakingKeys.push(lbKey);
    }
  }
  if (neighbourhood.length === 0) {
    return makeEmptySummary();
  }
  const cellIds = new Uint32Array(neighbourhood.map((n) => n.cellId));

  // ── Stage 1: drain placements across the full ring ──────────────────
  // Phase C.3 — TWO parallel sources merge into one placement stream:
  //   (a) LandblockInfo.objects (props, signs, named statics) via
  //       `fetch_landblock_objects` — DAT-determined, baked into
  //       `client_cell_1.dat` at retail-bake-time.
  //   (b) Procedural scenery (trees, rocks, bushes) via
  //       `fetch_landblock_scenery` — the JSONL files emitted by
  //       `holtburger-scenery-bake` at C.2 close. ACE-Scenery.Load
  //       algorithm parity, ~14k placements across the 169-LB ring
  //       (~83 per LB average; 55 of 169 LBs have 0 due to building-
  //       collision rejection or zero scene_type codes).
  //
  // The two are concatenated BEFORE the unique-modelId pass so the
  // F#5+6 InstancedMesh collapse spans BOTH streams — a tree modelId
  // shared between LandblockInfo (rare) and scenery (common) batches
  // into a single InstancedMesh, single draw call. Per-placement
  // attribution lives in `placement.source = "landblockinfo" |
  // "scenery"` (also forwarded into emitted `userData.source`).
  //
  // Empty-scenery is the common case for many LBs and is NOT an
  // error — `fetchAndDrainScenery` returns [] cleanly. The merged
  // `statics` array still drives the bake; if it's also empty,
  // nothing renders for this LB (expected for ocean / terrain-only
  // LBs).
  const allPlacements = await wasmExports.fetch_landblock_objects(cellIds);
  const landblockInfoStatics = drainPlacements(allPlacements);
  const sceneryStatics = await fetchAndDrainScenery(cellIds, wasmExports);
  const statics = landblockInfoStatics.concat(sceneryStatics);
  // Mark every newly-baked LB in the set BEFORE instantiation runs
  // so a concurrent caller observing mid-instantiation state sees the
  // bake-in-progress LBs as baked. Matches the per-LB baker's
  // pre-instantiation set.add() pattern.
  for (const k of newlyBakingKeys) scene3d.staticsBakedLbs.add(k);

  if (statics.length === 0) {
    // Empty ring — terrain-only LBs (118 of 169 in the 13×13 ring per
    // Objective 4 planning) trip this path. Return the empty summary
    // but keep the set-marking above so a subsequent ring call doesn't
    // re-fetch empty-LB placements.
    return makeEmptySummary();
  }

  // ── Stage 2: unified primary geometry + degraded + material fetch ──
  // ONE round trip across the entire ring — preserves the F#5+6 win.
  const uniqueModelIds = [...new Set(statics.map((s) => s.modelId))];
  if (uniqueModelIds.length === 0) {
    return makeEmptySummary();
  }
  const primary = await fetchPrimaryGeometries(
    uniqueModelIds,
    wasmExports.fetch_model_meshes
  );
  if (primary.fetchFailed) {
    return {
      ...makeEmptySummary(),
      skippedNoMesh: statics.length,
    };
  }
  const degradedGeomByModel = await fetchDegradedGeometries(
    primary.didDegradeByModel,
    wasmExports.fetch_model_meshes
  );

  // Material cache shared across all 3D phases (Phase 0.2 / 3.3
  // propagation; see buildings.js).
  const materialCache = getOrCreateMaterialCache(scene3d);
  if (primary.allSurfaceDids.size > 0) {
    try {
      await materialCache.preload(
        [...primary.allSurfaceDids],
        wasmExports.fetch_surfaces_pixels
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        "[scene3d.statics] ring materialCache.preload failed:",
        e
      );
    }
  }

  const matByModel = buildMaterialMap(
    primary.geomByModel,
    primary.dominantSurfaceByModel,
    materialCache
  );

  // ── Stage 3: ring-wide group-by-modelId + InstancedMesh/Mesh emit ──
  // This is the divergent step vs the per-LB baker: placements
  // sharing a modelId across LBs are batched into a single
  // InstancedMesh. Singletons stay as plain Mesh.
  const placementsByModel = new Map();
  for (const placement of statics) {
    if (!primary.geomByModel.has(placement.modelId)) continue;
    let arr = placementsByModel.get(placement.modelId);
    if (!arr) {
      arr = [];
      placementsByModel.set(placement.modelId, arr);
    }
    arr.push(placement);
  }

  const placementMatrix = makePlacementMatrixHelper();
  const staticsShadow = !!scene3d.shadowsEnabled || !!scene3d.csmEnabled;
  // C2 (perf plan 2026-05-18) — at the `low` quality preset every
  // static skips receiveShadow (CSM frustum-test cost scales linearly
  // with receiver count, ~16,700 placements in Holtburg). mid/high/ultra
  // keep today's all-receivers behaviour. Read mirrors the convention
  // used elsewhere in scene3d (e.g. terrain.js `scene3d.quality?.flags`).
  // FU2 (perf follow-on 2026-05-18) — the per-placement distance-tier
  // predicate (`staticsReceiveShadowForPlacement`) consumes this bool
  // inside `buildSingletonNode` for plain `THREE.Mesh` singletons
  // (group.length === 1 + the LOD leaf). `InstancedMesh` (group.length
  // >= 2, via `buildInstancedNode`) keeps the simple low-preset gate
  // because `THREE.InstancedMesh.receiveShadow` is per-mesh, not
  // per-instance — see the comment block in `buildInstancedNode`.
  const staticsReceiveShadow = scene3d.quality?.preset !== "low";
  let objectCount = 0;
  let skippedNoMesh = 0;
  let instancedGroupCount = 0;
  let singletonCount = 0;
  let lodCount = 0;
  // Phase C.3 — per-source attribution. Group-level counts (across all
  // grouped placements) feed the summary; per-instance counting works
  // for both branches because the inner `group` array carries each
  // placement's `source`.
  let sceneryObjectCount = 0;
  let landblockInfoObjectCount = 0;
  // Track InstancedMesh groups that contain at least one scenery
  // placement — this is the headline metric the C.3 brief asks for
  // ("instancedGroupCount should jump significantly when scenery is
  // wired in"). A group is scenery-bearing if any of its placements
  // carry `source === "scenery"`.
  let sceneryBearingInstancedGroupCount = 0;
  for (const [modelId, group] of placementsByModel) {
    const geom = primary.geomByModel.get(modelId);
    const mat = matByModel.get(modelId) || materialCache.fallbackMaterial;
    const degradedGeom = degradedGeomByModel.get(modelId) || null;
    const staticsMatCastsShadow = materialCanCastShadow(mat);

    // Count scenery vs LandblockInfo placements within this group.
    let groupSceneryCount = 0;
    for (const p of group) {
      if (p.source === "scenery") groupSceneryCount += 1;
    }
    const groupLandblockInfoCount = group.length - groupSceneryCount;
    sceneryObjectCount += groupSceneryCount;
    landblockInfoObjectCount += groupLandblockInfoCount;

    if (group.length >= 2) {
      // === InstancedMesh path ===
      // One draw call per modelId, regardless of placement count.
      const { node, isLod } = buildInstancedNode({
        modelId,
        group,
        geom,
        degradedGeom,
        mat,
        placementMatrix,
        staticsShadow,
        staticsMatCastsShadow,
        staticsReceiveShadow,
      });
      scene3d.staticsGroup.add(node);
      instancedGroupCount += 1;
      objectCount += group.length;
      if (isLod) lodCount += 1;
      if (groupSceneryCount > 0) sceneryBearingInstancedGroupCount += 1;
    } else {
      // === Singleton Mesh path ===
      // Only one placement; InstancedMesh has no draw-call advantage
      // over plain Mesh here (still 1 draw call) AND costs an extra
      // instanceMatrix attribute buffer. Stick with plain Mesh.
      const placement = group[0];
      const { node, isLod } = buildSingletonNode({
        placement,
        modelId,
        geom,
        degradedGeom,
        mat,
        staticsShadow,
        staticsMatCastsShadow,
        staticsReceiveShadow,
      });
      scene3d.staticsGroup.add(node);
      singletonCount += 1;
      objectCount += 1;
      if (isLod) lodCount += 1;
    }
  }

  // Count placements that had no geometry (the model failed to fetch
  // OR was 0-tri AND got dropped from `geomByModel`). The
  // `skippedZeroTri` count is per-model; `skippedNoMesh` here is
  // per-placement of models we couldn't render.
  for (const placement of statics) {
    if (!primary.geomByModel.has(placement.modelId)) skippedNoMesh += 1;
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
    modelCount: primary.geomByModel.size,
    surfaceCount: primary.allSurfaceDids.size,
    skippedZeroTri: primary.skippedZeroTri,
    skippedNoMesh,
    instancedGroupCount,
    singletonCount,
    lodCount,
    drawCallReductionEstimate,
    sceneryObjectCount,
    landblockInfoObjectCount,
    sceneryBearingInstancedGroupCount,
  };
}

/**
 * Top-level builder for Holtburg's static-object set (back-compat
 * wrapper around `bakeStaticsRing` at radius=1).
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
 *     drawCallReductionEstimate: number,// placements − (instancedGroups + singletons)
 *     // Phase C.3 additions:
 *     sceneryObjectCount: number,       // placements from fetch_landblock_scenery
 *     landblockInfoObjectCount: number, // placements from fetch_landblock_objects
 *     sceneryBearingInstancedGroupCount: number // InstancedMesh groups with ≥1 scenery placement (ring only)
 *   }
 *
 * Preserved so existing init3D callers, the Phase 7.2 capture, and the
 * F#5+6 capture stay green during World-expand step 1's per-objective
 * commit roll-out. Objective 8 flips the init3D call site to
 * `bakeStaticsRing(..., 6, ...)` directly.
 */
export async function buildHoltburgStatics(scene3d, wasmExports) {
  return bakeStaticsRing(scene3d, HOLTBURG_X, HOLTBURG_Y, 1, wasmExports);
}
