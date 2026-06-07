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
import { lbKeyOf } from "./landblock_lru.js";
import { modelMeshFetcher, surfacePixelsFetcher } from "./bake_worker_client.js";

const METERS_PER_LANDBLOCK = 192.0;
const HOLTBURG_X = 0xa9;
const HOLTBURG_Y = 0xb4;

// FU2 (perf follow-on 2026-05-18) — distance-tier follow-on for C2's
// `low`-preset receiveShadow gate. At mid/high/ultra a placement gets
// `receiveShadow = true` only when its world-space distance to the
// reference point is under SHADOW_RECEIVE_RANGE_M. Beyond that it
// falls back to `receiveShadow = false`. Reasoning:
//
//   - CSM frustum-test cost scales linearly with receiver count; the
//     audit measured a meaningful win when distant statics were
//     dropped (~16,700 placements over a 13×13 ring with most >60 m
//     from the reference point).
//   - 80 m gives ~1.3× the half-LB radius — comfortably inside the
//     CSM mid-cascade reach (DEFAULT_CSM_SPLITS[1]=100 m in csm.js)
//     AND the Phase-0.1 single-shadow sun frustum (sceneSize=600 m in
//     lighting.js), so shadows up to 80 m always have a covering
//     cascade.
//
// Wave 1.E (2026-05-28) — bake-time tagging stays spawn-anchored as
// the warm cache seed; per-frame `tickShadowReceiveGate` (loop.js)
// re-tags `receiveShadow` from the LIVE player position so distant
// statics light up / dim out as the player traverses landblock
// boundaries instead of staying frozen at the spawn-anchored snapshot.
// Bumped 60→80 m so the warm cache covers the player's first wander
// before the gate first ticks.
export const SHADOW_RECEIVE_RANGE_M = 80.0;
export const SHADOW_RECEIVE_RANGE_SQ_M = SHADOW_RECEIVE_RANGE_M * SHADOW_RECEIVE_RANGE_M;
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

// ── G1 (waves-2 2026-05-29) — degrade-band billboard orientation ──────
//
// `degrade_mode` is the per-LOD-band billboard-orientation flag from
// retail `CPhysicsPart::calc_draw_frame` (acclient.c:315074-315090),
// applied to the degraded LOD leaf each frame:
//   1 = fixed              — no transform (original orientation).
//   2 = full billboard     — `Frame::set_vector_heading` (:357668):
//                            orient the part's facing axis at the viewer
//                            (yaw + pitch from the viewer-direction vec).
//   3 = axis-0 (X) constrained — `rotate_around_axis_to_vector(0)` (:357520)
//   4 = axis-1 (Y) constrained — the common "foliage faces camera but
//                                stays upright" mode (yaw-only billboard).
//   5 = axis-2 (Z) constrained.
//
// AC→three coord convention (adapter.js:1299 `acToThree`): statics live
// under `worldRoot` (rotation.x = -π/2), so each node's LOCAL frame is
// authored in AC coords — Z is up, +Y is north, +X is east. We compute
// the viewer direction IN THAT LOCAL AC FRAME and rotate the degraded
// leaf there, so no worldRoot round-trip is needed.
//
// Axis mapping for modes 3/4/5: AC axis 0→local X, 1→local Y, 2→local Z.
// The grounding identifies mode 4 (axis-1 = Y) as the dominant
// upright-foliage case. AC's vertical in world space is Z, but the
// degrade billboard constrains rotation about the named axis IN THE
// PART'S LOCAL FRAME; for an upright billboard card the constrained
// axis is the one that must stay fixed (the world-up the card stands
// on). We treat the constrained-axis modes as "yaw about the world-up
// (local Z) to face the camera, keep the card upright" because that is
// the observable retail behaviour the grounding describes, and it is
// the only mode that visibly affects Holtburg foliage. Modes 3/5 fall
// back to the same yaw-only billboard (their visible effect on the
// near-vertical foliage cards in Dereth is indistinguishable, and a
// full per-axis pivot risks laying cards flat) — see the TODO in
// `_orientBillboardLeaf` for the exact-axis refinement.
const STATICS_BILLBOARD_FLAG = "billboard"; // ?billboard=off disables G1.

// Tag an LOD node so `tickStaticsBillboards` will orient its degraded
// leaf. No-op unless the degraded band carried a billboard mode (>=2);
// mode 0/1 leave the leaf at its authored orientation (current
// behaviour) so this can only add facing, never regress.
function tagBillboardLod(lod, degradedGeom) {
  const mode = (degradedGeom?.userData?.degradeMode ?? 0) >>> 0;
  if (mode < 2) return;
  lod.userData = lod.userData || {};
  lod.userData.billboardMode = mode;
  // Degraded leaf is the second level added (full=0, degraded=1).
  lod.userData.billboardLevel = 1;
}

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
 *
 * Cold-boot Phase C (2026-05-21) — exported so `scene3d/index.js` can
 * pre-install the MaterialCache BEFORE fanning out parallel bakers
 * (`bakeBuildingsRing`, `bakeStaticsRing`, `buildEnvCellsForLandblock`).
 * Without the pre-install, `cells.js:90` throws because
 * `scene3d.materialCache` only gets stamped after a baker's internal
 * `Promise.all` resolves. Synchronous + idempotent so calling it
 * before the fan-out is cheap.
 */
export function getOrCreateMaterialCache(scene3d) {
  if (scene3d.materialCache) return scene3d.materialCache;
  const mc = new MaterialCache({
    detailTileCache: scene3d.detailTileCache ?? null,
    forceDetail: !!scene3d.forceDetail,
    csmState: scene3d.csmState ?? null,
    pomEnabled: !!scene3d.pomEnabled,
    forcePom: !!scene3d.forcePom,
    // Render-completeness audit (2026-05-29) — animated SurfaceTextures.
    animFramesFetch: scene3d.wasmExports?.fetchSurfaceAnimFrames ?? null,
    // === Wave 2.B — procedural normals (2026-05-28) ===
    // Quality-preset gate for Phase 1.1 procedural normal maps. Set on
    // scene3d in index.js from `quality.flags.normalMaps`. Undefined
    // (eg. legacy capture flows that bypass index.js) → MaterialCache
    // defaults to `true` (back-compat).
    normalMapsEnabled: scene3d.normalMapsEnabled,
    // Wire-agent (?wireframe=1) — orthogonal to quality preset. When
    // true, cache returns shared MeshBasicMaterial({wireframe:true})
    // and preload no-ops the surface-pixel fetch.
    wireframeMode: !!scene3d.wireframeMode,
    // 2026-05-22 — wire-agent per-DID dominant-colour map. When non-
    // null, `_wireframeMaterialFor` mints a per-DID material pair
    // using the manifest's RGB instead of the 32-bucket HSL hash.
    // Loaded by init3D from `data/surface-colors.json`; null if the
    // fetch failed (fallback path stays intact).
    surfaceColors: scene3d.surfaceColors ?? null,
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
    // V1 (render-completeness Wave 3, 2026-05-29) — the SetupModel's
    // `default_script` ambient-chain DID (0x33 PhysicsScript), baked
    // into the scenery JSONL. `0` (or absent in a pre-V1 bake — the
    // getter then reads 0) means "no ambient chain"; non-zero is a
    // continuous CreateParticle/Sound emitter (fountains/braziers/
    // torches). Carried through to the per-placement render path which
    // anchors `runStaticDefaultScript` at the placement world position.
    // Fail-soft: the getter is absent on older wasm bundles → 0.
    const defaultScriptId =
      typeof p.defaultScriptId === "number" ? p.defaultScriptId >>> 0 : 0;
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
      defaultScriptId,
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
async function fetchDegradedGeometries(
  didDegradeByModel,
  fetchModelMeshes,
  fetchDegradeInfo
) {
  const degradedGeomByModel = new Map();
  if (!didDegradeByModel || didDegradeByModel.size === 0) {
    return degradedGeomByModel;
  }

  // Render-completeness audit (2026-05-29): `GfxObj.did_degrade` is a
  // `0x11` GfxObjDegradeInfo CHAIN id (verified on real portal.dat —
  // GfxObj `0x0100376A`.did_degrade = `0x11000001`), NOT a directly
  // fetchable mesh. The prior code passed these `0x11` ids straight to
  // `fetch_model_meshes` (which only accepts `0x01`/`0x02`), so every
  // degraded fetch silently returned nothing and NO static LOD was ever
  // built — the hardcoded-100m swap never fired. Resolve the chain via the
  // existing `fetch_gfx_obj_degrade_info` getter, take the first
  // (most-detailed) degrade band's `0x01` gfx_obj_id as the degraded leaf,
  // and stash that band's authored `min_dist` on `geom.userData.lodDist`
  // so `buildSingletonNode` swaps at the real distance instead of 100m.
  // Fail-soft per model: any parse / fetch error drops to "no LOD" (plain
  // mesh), exactly the prior (dead-path) behaviour — so this can only add
  // working LOD, never regress.
  if (typeof fetchDegradeInfo !== "function") {
    return degradedGeomByModel;
  }

  // Resolve each model's chain → { gfxId (0x01), dist } in parallel.
  const entries = [...didDegradeByModel.entries()];
  const resolved = await Promise.all(
    entries.map(async ([modelId, chainId]) => {
      try {
        const json = await fetchDegradeInfo(chainId >>> 0);
        if (!json || json === "null") return null;
        const info = JSON.parse(json);
        const bands = Array.isArray(info?.degrades) ? info.degrades : [];
        if (bands.length === 0) return null;
        const b = bands[0];
        const gfxId = (b.gfx_obj_id ?? 0) >>> 0;
        if (!gfxId) return null;
        const dist =
          typeof b.min_dist === "number" && b.min_dist > 0 ? b.min_dist : null;
        // G1 (waves-2 2026-05-29) — `degrade_mode` is the per-LOD-band
        // billboard-orientation flag from `CPhysicsPart::calc_draw_frame`
        // (acclient.c:315074): 1=fixed (no transform), 2=full billboard,
        // 3/4/5=axis-0/1/2 constrained. Carry it alongside so the per-frame
        // billboard tick can orient the degraded leaf to face the viewer.
        // Default 0 ("no billboard") when the band omits it → tick no-ops.
        const degradeMode =
          typeof b.degrade_mode === "number" ? b.degrade_mode >>> 0 : 0;
        return { modelId, gfxId, dist, degradeMode };
      } catch (_) {
        return null;
      }
    })
  );
  const perModel = new Map();
  for (const r of resolved) {
    if (r)
      perModel.set(r.modelId, {
        gfxId: r.gfxId,
        dist: r.dist,
        degradeMode: r.degradeMode,
      });
  }
  if (perModel.size === 0) return degradedGeomByModel;

  // Batch-fetch the unique band geometries (0x01 GfxObjs).
  const uniqueGfxIds = [...new Set([...perModel.values()].map((v) => v.gfxId))];
  const geomByGfxId = new Map();
  try {
    const meshes = await fetchModelMeshes(new Uint32Array(uniqueGfxIds));
    for (let i = 0; i < uniqueGfxIds.length; i += 1) {
      const m = meshes[i];
      if (!m || m.triCount === 0) {
        if (m && typeof m.free === "function") m.free();
        continue;
      }
      const geom = meshToFusedGeometry(m);
      if (geom) geomByGfxId.set(uniqueGfxIds[i], geom);
      if (typeof m.free === "function") m.free();
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      "[scene3d.statics] degrade band geom fetch failed (LOD no-op):",
      e
    );
    return degradedGeomByModel;
  }

  for (const [modelId, { gfxId, dist, degradeMode }] of perModel) {
    const geom = geomByGfxId.get(gfxId);
    if (!geom) continue;
    // Stash the authored swap distance on the geometry so the node
    // builders can read it without changing their (Map-shaped) interface.
    if (dist != null) {
      geom.userData = geom.userData || {};
      geom.userData.lodDist = dist;
    }
    // G1 — carry the band's billboard mode the same way. The node
    // builders copy it onto the LOD node so `tickStaticsBillboards`
    // can orient the degraded leaf each frame. `geom` is shared across
    // every placement of this modelId, so the value is identical for
    // all of that model's LOD nodes (correct — degrade_mode is per-band,
    // not per-placement).
    if (degradeMode) {
      geom.userData = geom.userData || {};
      geom.userData.degradeMode = degradeMode;
    }
    degradedGeomByModel.set(modelId, geom);
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
    // C2's low-preset gate. Foreground (<SHADOW_RECEIVE_RANGE_M from
    // the reference point) at mid/high/ultra keeps receiveShadow=true;
    // everything else (low preset OR beyond range) gets false. Bake-
    // time tag is spawn-anchored as the warm cache seed; per-frame
    // `tickShadowReceiveGate` (loop.js, Wave 1.E 2026-05-28) re-tags
    // from the LIVE player position so the gate tracks the player
    // across landblock boundaries instead of staying frozen at spawn.
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
  // Render-completeness audit (2026-05-29): swap at the DegradeInfo band's
  // authored `min_dist` (stashed on the degraded geometry's userData by
  // fetchDegradedGeometries) rather than the fixed 100m guess. Falls back
  // to LOD_DISTANCE_M when no authored distance was resolved.
  // G3 (waves-2 2026-05-29, LOW — left as TODO): retail
  // `GfxObjDegradeInfo::get_degrade` (acclient.c:332374) walks ALL bands
  // by ideal_dist/max_dist with a bias multiplier and builds a multi-level
  // chain. We consume only bands[0]'s gfx_obj_id + min_dist (one degraded
  // leaf, swapped at this single authored distance). The grounding agent
  // judged the single-band path acceptable for the current phase, so this
  // stays a 2-level THREE.LOD; a full multi-level + bias-aware walk is the
  // future refinement (build one addLevel per band, swap at the bias-scaled
  // ideal_dist).
  const swapDist =
    (degradedGeom.userData && degradedGeom.userData.lodDist) || LOD_DISTANCE_M;
  lod.addLevel(degradedMesh, swapDist);
  lod.userData = {
    modelId,
    landblockId: placement.landblockId,
    placementKey,
    isBuilding: false,
    source,
  };
  // G1 (waves-2 2026-05-29) — tag the LOD for the per-frame billboard
  // tick when the degraded band carries a billboard mode (>=2). Mode 1
  // (fixed) and absent/0 leave the leaf at its authored orientation
  // (current behaviour). `billboardLevel = 1` is the degraded leaf's
  // index in `lod.levels` (full=0, degraded=1) so the tick only orients
  // the leaf that's the billboard band, never the full-detail mesh.
  tagBillboardLod(lod, degradedGeom);
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
  // C3 #7 — set of lb-keys this batched node covers. The LRU refcounts
  // eviction against this Set: the node's geometry is only disposed when
  // the LAST covered LB evicts (until then the node still draws statics
  // for the other resident LBs). Built once here from the group's
  // placements (each carries the full 32-bit landblockId → lbKeyOf masks
  // it to the 16-bit lb-key). Shared by reference onto BOTH the
  // InstancedMesh and the LOD wrapper so either object handed to the LRU
  // refcounts the same Set.
  const coversLbKeys = new Set();
  for (const p of group) {
    if (p.landblockId != null) coversLbKeys.add(lbKeyOf(p.landblockId >>> 0));
  }
  const instanced = new THREE.InstancedMesh(geom, mat, group.length);
  instanced.name = `static-instanced-${modelKey}-x${group.length}`;
  instanced.userData = {
    modelId,
    isBuilding: false,
    instanceCount: group.length,
    source,
    sceneryCount,
    landblockInfoCount,
    coversLbKeys,
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
  // G3 note: the instanced path still uses the fixed LOD_DISTANCE_M
  // guess rather than the band's authored distance — see the
  // `degradedGeom.userData.lodDist` G3 TODO in `buildSingletonNode`.
  lod.addLevel(degradedInstanced, LOD_DISTANCE_M);
  lod.userData = {
    modelId,
    isBuilding: false,
    isInstancedLod: true,
    source,
    sceneryCount,
    landblockInfoCount,
    // C3 #7 — same coversLbKeys Set as the InstancedMesh leaves (the LRU
    // is handed the LOD wrapper for instanced-LOD nodes; both LOD levels
    // share these covered lb-keys).
    coversLbKeys,
  };
  // G1 (waves-2 2026-05-29) — billboard orientation is NOT applied to
  // the InstancedMesh degraded leaf. Each instance sits at a distinct
  // world position so a single shared mesh-level rotation can't face
  // all of them at the camera; correct per-instance billboarding would
  // require rewriting the whole instanceMatrix buffer every frame (the
  // exact GPU re-upload cost the InstancedMesh collapse exists to
  // avoid). The plain-Mesh singleton path (`buildSingletonNode`) gets
  // the billboard tick. We record the band's mode for diag visibility
  // only — `tickStaticsBillboards` skips `isInstancedLod` nodes.
  if (degradedGeom?.userData?.degradeMode >= 2) {
    lod.userData.billboardModeInstancedSkipped =
      degradedGeom.userData.degradeMode;
  }
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
    // LRU wave H4 — per-LB disposables; empty for early-return / failure
    // paths so the LRU `track()` call gets a uniform shape.
    disposables: { geometries: [], materials: [], textures: [] },
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
  // M2 (worker-based asset bake): route the model-mesh decode through the
  // bake worker when enabled (`?bakeWorker=1`). When disabled, `mmFetch`
  // IS `wasmExports.fetch_model_meshes` (identical reference) — byte-
  // identical to pre-M2. Worker results are drop-in (same field surface).
  const mmFetch = modelMeshFetcher(wasmExports);
  const spFetch = surfacePixelsFetcher(wasmExports);
  const primary = await fetchPrimaryGeometries(uniqueModelIds, mmFetch);
  if (primary.fetchFailed) {
    return {
      ...makeEmptySummary(),
      skippedNoMesh: statics.length,
    };
  }
  const degradedGeomByModel = await fetchDegradedGeometries(
    primary.didDegradeByModel,
    mmFetch,
    wasmExports.fetch_gfx_obj_degrade_info
  );

  // Per-LB surface preload. The ring driver preloads ALL ring DIDs in
  // a single batch (Phase 7.2 buildings.js pattern); the lazy-add
  // path only sees this LB's DIDs so the preload is local.
  if (primary.allSurfaceDids.size > 0) {
    try {
      await materialCache.preload(
        [...primary.allSurfaceDids],
        spFetch
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
  // F3 (2026-06-01): time-slice the per-placement instantiation in ~6ms chunks
  // so a static-dense LB doesn't build all singleton nodes in one synchronous
  // burst (the run-around hitch when crossing into a new landblock). Nodes are
  // accumulated and attached AFTER the loop (rather than added in-loop) so an
  // eviction mid-build — the LB dropping out of the LRU while we yield across
  // frames — can be cancelled cleanly. Default ON; `?noStaticsTimeSlice=1`
  // disables. setTimeout (NOT rIC — `_ric_shim` poisons it; NOT rAF — dies
  // under renderOnDemand). Wasm placements were already drained in
  // drainPlacements/fetchAndDrainScenery above, so no wasm memory is held here.
  let staticsTimeSlice = true;
  try {
    if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.search) {
      staticsTimeSlice =
        new URLSearchParams(globalThis.location.search).get("noStaticsTimeSlice") !== "1";
    }
  } catch (_) {
    staticsTimeSlice = true;
  }
  const STATICS_BUILD_BUDGET_MS = 6;
  const addedNodes = [];
  let _chunkStart = performance.now();
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
    addedNodes.push(node);
    objectCount += 1;
    singletonCount += 1;
    if (isLod) lodCount += 1;
    if (placement.source === "scenery") sceneryObjectCount += 1;
    else landblockInfoObjectCount += 1;

    // F3 time-slice: yield once the chunk has spent its frame budget.
    if (staticsTimeSlice && (performance.now() - _chunkStart) > STATICS_BUILD_BUDGET_MS) {
      await new Promise((r) => setTimeout(r, 0));
      _chunkStart = performance.now();
    }
  }

  // F3 cancellation guard: if this LB was evicted while we time-sliced the
  // build, do NOT attach — evict() already cleared staticsBakedLbs[lbKey], so
  // attaching now would orphan these nodes and let a re-approach rebuild
  // duplicates. Dispose the per-LB geometries and bail. The nodes were never
  // added to the scene graph, so nothing is GPU-resident to leak.
  if (staticsTimeSlice && !scene3d.staticsBakedLbs.has(lbKey)) {
    for (const geom of primary.geomByModel.values()) { try { geom?.dispose?.(); } catch (_) {} }
    for (const geom of degradedGeomByModel.values()) { try { geom?.dispose?.(); } catch (_) {} }
    return {
      ...makeEmptySummary(),
      evictedDuringBuild: true,
      disposables: { geometries: [], materials: [], textures: [] },
    };
  }
  for (const node of addedNodes) scene3d.staticsGroup.add(node);

  // V1 (2026-05-29) — run each scenery placement's `default_script`
  // ambient particle chain (fountains/braziers/torches). Fail-soft +
  // zero-cost when no placement carries a script (the pre-re-bake case).
  try {
    await attachStaticDefaultScripts(scene3d, statics, wasmExports);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[scene3d.statics/V1] per-LB default_script attach failed:", e);
  }

  // LRU wave H4 — per-LB owned BufferGeometries. The per-LB baker doesn't
  // share a cross-LB `bakeCache` (unlike buildings.js), so every entry in
  // `geomByModel` / `degradedGeomByModel` is owned by THIS bake call even
  // when a later LB happens to bake the same modelId. Materials are
  // cache-shared via `materialCache.getCached` → empty here.
  const lbDisposableGeometries = [];
  for (const geom of primary.geomByModel.values()) {
    if (geom) lbDisposableGeometries.push(geom);
  }
  for (const geom of degradedGeomByModel.values()) {
    if (geom) lbDisposableGeometries.push(geom);
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
    disposables: {
      geometries: lbDisposableGeometries,
      materials: [],
      textures: [],
    },
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

  // 2026-05-22 — opt-in profile instrumentation via `?profileStatics=1`.
  // When the flag is absent (default), `mark()` is a no-op. When set,
  // each call logs a `[profileStatics] <phase> +<ms>` line. Zero perf
  // cost in the default path — the flag is read once at function
  // entry and the timestamp captures only fire under truthy check.
  let _profStatT0 = 0, _profStatLast = 0, _profStatOn = false;
  try {
    if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.search) {
      _profStatOn = new URLSearchParams(globalThis.location.search).get("profileStatics") === "1";
    }
  } catch (_) { _profStatOn = false; }
  const mark = _profStatOn
    ? (phase) => {
        const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
        if (_profStatT0 === 0) { _profStatT0 = now; _profStatLast = now; }
        const dPhase = now - _profStatLast;
        const dTotal = now - _profStatT0;
        // eslint-disable-next-line no-console
        console.log(`[profileStatics] ${phase.padEnd(36)} +${dPhase.toFixed(1)}ms  (total ${dTotal.toFixed(1)}ms)`);
        _profStatLast = now;
      }
    : () => {};
  mark("bakeStaticsRing entry");

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
  mark("stage1: fetch_landblock_objects");
  const landblockInfoStatics = drainPlacements(allPlacements);
  mark("stage1: drainPlacements (JS)");
  const sceneryStatics = await fetchAndDrainScenery(cellIds, wasmExports);
  mark("stage1: fetchAndDrainScenery");
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
  // M2: worker-routed model-mesh decode when enabled; IS
  // wasmExports.fetch_model_meshes when disabled (byte-identical to pre-M2).
  const mmFetch = modelMeshFetcher(wasmExports);
  const spFetch = surfacePixelsFetcher(wasmExports);
  const primary = await fetchPrimaryGeometries(uniqueModelIds, mmFetch);
  mark(`stage2: fetchPrimaryGeometries (${uniqueModelIds.length} models)`);
  if (primary.fetchFailed) {
    return {
      ...makeEmptySummary(),
      skippedNoMesh: statics.length,
    };
  }
  // Wire-agent: skip the degraded (LOD) geometry fetch entirely. In
  // wireframe rendering there's no visual difference between full-
  // detail and degraded leaves — the LOD switch only matters for
  // textured perspective at distance. Empty Map → buildSingletonNode /
  // buildInstancedNode see `degradedGeom: null` and return the
  // primary leaf without an LOD wrapper (guarded paths at L593/L727).
  // Profile data 2026-05-22: this fetch accounted for 86% (341.9ms of
  // 394ms) of wire-mode statics bake on Chromium+SwiftShader.
  // Wire-agent: skip the degraded (LOD) geometry fetch entirely. In
  // wireframe rendering there's no visual difference between full-
  // detail and degraded leaves — the LOD switch only matters for
  // textured perspective at distance. Empty Map → buildSingletonNode /
  // buildInstancedNode see `degradedGeom: null` and return the
  // primary leaf without an LOD wrapper (guarded paths at L593/L727).
  // Profile data 2026-05-22: this fetch accounted for 86% (341.9ms of
  // 394ms) of wire-mode statics bake on Chromium+SwiftShader. A/B
  // measured total boot 5087→4218ms median (-869ms, -17%).
  const degradedGeomByModel = scene3d.wireframeMode
    ? new Map()
    : await fetchDegradedGeometries(
        primary.didDegradeByModel,
        mmFetch,
        wasmExports.fetch_gfx_obj_degrade_info
      );
  mark(`stage2: fetchDegradedGeometries (${primary.didDegradeByModel?.size ?? 0} degraded${scene3d.wireframeMode ? " — SKIPPED in wire" : ""})`);

  // Material cache shared across all 3D phases (Phase 0.2 / 3.3
  // propagation; see buildings.js).
  const materialCache = getOrCreateMaterialCache(scene3d);
  if (primary.allSurfaceDids.size > 0) {
    try {
      await materialCache.preload(
        [...primary.allSurfaceDids],
        spFetch
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        "[scene3d.statics] ring materialCache.preload failed:",
        e
      );
    }
  }
  mark(`stage2: materialCache.preload (${primary.allSurfaceDids.size} surfaces)`);

  const matByModel = buildMaterialMap(
    primary.geomByModel,
    primary.dominantSurfaceByModel,
    materialCache
  );
  mark("stage2: buildMaterialMap (JS)");

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
  // C3 #7 — collect the cross-LB InstancedMesh / LOD nodes so the caller
  // can hand each to the LRU under every lb-key it covers (refcount
  // eviction). Singletons carry `userData.landblockId` and are evicted by
  // the existing per-LB walker, so they are NOT collected here.
  const instancedNodes = [];
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
      instancedNodes.push(node);
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
  mark(`stage3: build+add ${placementsByModel.size} groups (inst=${instancedGroupCount}, single=${singletonCount})`);

  // V1 (2026-05-29) — run each scenery placement's `default_script`
  // ambient particle chain (fountains/braziers/torches). Runs over the
  // full ring `statics` stream so an InstancedMesh-collapsed scripted
  // model still gets one anchor PER placement. Fail-soft + zero-cost
  // when no placement carries a script (the pre-re-bake case).
  try {
    await attachStaticDefaultScripts(scene3d, statics, wasmExports);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[scene3d.statics/V1] ring default_script attach failed:", e);
  }
  mark("stage3: attachStaticDefaultScripts (V1)");

  // Count placements that had no geometry (the model failed to fetch
  // OR was 0-tri AND got dropped from `geomByModel`). The
  // `skippedZeroTri` count is per-model; `skippedNoMesh` here is
  // per-placement of models we couldn't render. Per-LB break-out is
  // accumulated alongside so the [phase7.2] statics log can name the
  // landblocks losing placements (ring-wide aggregate alone hides
  // which LB regressed).
  const skippedNoMeshByLb = new Map();
  for (const placement of statics) {
    if (!primary.geomByModel.has(placement.modelId)) {
      skippedNoMesh += 1;
      const lb = placement.landblockId;
      if (lb != null) {
        skippedNoMeshByLb.set(lb, (skippedNoMeshByLb.get(lb) || 0) + 1);
      }
    }
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
    // Raw uint32 landblockId → skip count, sorted desc. Upper 16 bits
    // carry lbX/lbY (e.g. Holtburg 0xA9B4 → 0xA9B40000). Empty {} when
    // no skips.
    skippedNoMeshByLb: Object.fromEntries(
      [...skippedNoMeshByLb.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([lb, n]) => [
          `0x${(lb >>> 0).toString(16).toUpperCase().padStart(8, "0")}`,
          n,
        ])
    ),
    instancedGroupCount,
    singletonCount,
    lodCount,
    drawCallReductionEstimate,
    sceneryObjectCount,
    landblockInfoObjectCount,
    sceneryBearingInstancedGroupCount,
    // C3 #7 — the cross-LB InstancedMesh / LOD nodes (each carries a
    // `userData.coversLbKeys` Set). The caller fans these into the LRU
    // under every covered lb-key for refcounted eviction.
    instancedNodes,
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
 *     skippedNoMeshByLb: Record<string,number>, // per-LB break-out of skippedNoMesh (key: hex landblockId, sorted desc)
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

// ── G1 — per-frame billboard tick ────────────────────────────────────
//
// Orients the degraded LOD leaf of billboard-tagged statics toward the
// viewer each frame, mirroring retail `CPhysicsPart::calc_draw_frame`.
// Bounded cost: we touch ONLY nodes that are (a) `THREE.LOD`, (b) tagged
// `billboardMode >= 2`, and (c) currently rendering their degraded
// (billboard) band. Everything else pays one `userData` read and a
// `continue`. The camera position is transformed into each node's LOCAL
// AC frame (Z-up) so the orientation math needs no worldRoot round-trip.

// Reused scratch — no per-frame allocation in the hot path.
const _bbCamWorld = new THREE.Vector3();
const _bbCamLocal = new THREE.Vector3();
const _bbInvMat = new THREE.Matrix4();
const _bbEuler = new THREE.Euler();
const _bbQuatFull = new THREE.Quaternion();
const _bbDir = new THREE.Vector3();

/**
 * Orient one degraded leaf mesh toward `camLocal` (camera position in
 * the leaf's parent LOD-node LOCAL frame, AC Z-up coords). `mode` is the
 * band's degrade_mode (2 = full billboard, 3/4/5 = axis-constrained).
 * Writes `leaf.quaternion`.
 */
function _orientBillboardLeaf(leaf, camLocal, mode) {
  // Vector from the leaf (at local origin) to the camera, in the AC
  // local frame (X east, Y north, Z up).
  _bbDir.copy(camLocal);
  const lenSq = _bbDir.lengthSq();
  if (lenSq < 1e-8) return; // camera coincident — leave as-is.

  if (mode === 2) {
    // Full billboard — `Frame::set_vector_heading`: the part's facing
    // axis (+X in AC) points straight at the viewer, yaw AND pitch.
    // yaw about Z from atan2(dy, dx); pitch about the post-yaw Y from
    // the height delta. Build via an Euler in AC's ZYX-ish order using
    // the standard heading/pitch decomposition.
    const yaw = Math.atan2(_bbDir.y, _bbDir.x);
    const horiz = Math.sqrt(_bbDir.x * _bbDir.x + _bbDir.y * _bbDir.y);
    const pitch = Math.atan2(_bbDir.z, horiz);
    // Rotation that maps local +X onto the camera direction: first yaw
    // about Z (+yaw), then pitch up about the local Y after yaw. Compose
    // as Z-yaw * Y-(-pitch) (negative because +pitch raises +X toward +Z
    // which is a negative rotation about +Y in a right-handed frame).
    _bbEuler.set(0, -pitch, yaw, "ZYX");
    leaf.quaternion.setFromEuler(_bbEuler);
    return;
  }

  // Modes 3/4/5 — axis-constrained. The grounded dominant case (mode 4,
  // foliage) is "yaw to face the camera, stay upright": rotate about the
  // world-up (local Z) only, dropping pitch. Modes 3/5 fall back to the
  // same yaw-only billboard — on Dereth's near-vertical foliage cards the
  // visible difference from an exact per-axis pivot is nil, and a true
  // X/Z-axis pivot risks laying the card flat. TODO(waves-3): exact
  // per-axis `rotate_around_axis_to_vector` (acclient.c:357520) keyed to
  // axis = mode-3 when a model is found that visibly needs X/Z pivots.
  const yaw = Math.atan2(_bbDir.y, _bbDir.x);
  _bbEuler.set(0, 0, yaw, "ZYX");
  leaf.quaternion.setFromEuler(_bbEuler);
}

/**
 * Per-frame billboard update for degrade-band statics. Walks
 * `scene3d.staticsGroup.children`; for each billboard-tagged `THREE.LOD`
 * whose active level is the degraded (billboard) leaf, orients that leaf
 * toward the active camera. Fail-soft: missing camera / group / flag →
 * no-op. Returns the count of leaves oriented (for diag / tests).
 */
export function tickStaticsBillboards(scene3d) {
  if (!scene3d || !scene3d.staticsGroup) return 0;
  const group = scene3d.staticsGroup;
  const children = group.children;
  if (!children || children.length === 0) return 0;
  // No module-level "has billboards" latch: lazy-LB walks can add new
  // tagged LOD nodes at any time, so a sticky false flag would silently
  // freeze them. The per-child cost for a non-billboard node is one
  // `isLOD` check + one `userData` read + `continue`, which is what the
  // discipline budget ("non-billboard instances pay ~nothing") allows.

  const camera =
    scene3d.cameraSwitcher?.activeCamera ?? scene3d.camera ?? null;
  if (!camera) return 0;
  // Camera world position (three.js world coords).
  camera.getWorldPosition(_bbCamWorld);

  let oriented = 0;
  for (const child of children) {
    if (!child || !child.isLOD) continue;
    const mode = child.userData?.billboardMode ?? 0;
    if (mode < 2) continue;
    // Only orient when the degraded billboard leaf is the active level.
    // `THREE.LOD.update()` (run by the renderer each frame) toggles
    // `levels[i].object.visible`; we read the leaf's `.visible` rather
    // than the private `_currentLevel`. It's at worst one frame stale
    // (our rAF runs alongside, not inside, the render walk) which is
    // fine for a distance band. If the LOD has never been rendered
    // (`visible` still default true on both leaves) we orient anyway —
    // harmless, since a non-rendered leaf's orientation is invisible.
    const level = child.userData.billboardLevel ?? 1;
    const lvls = child.levels;
    const leaf = lvls && lvls[level] ? lvls[level].object : null;
    if (!leaf) continue;
    if (leaf.visible === false) continue; // full-detail band showing.
    // Camera position in the LOD node's LOCAL frame (AC Z-up coords).
    // `child.matrixWorld` is current — the renderer updates world
    // matrices before render; statics never move so it's stable anyway.
    _bbInvMat.copy(child.matrixWorld).invert();
    _bbCamLocal.copy(_bbCamWorld).applyMatrix4(_bbInvMat);
    _orientBillboardLeaf(leaf, _bbCamLocal, mode);
    oriented += 1;
  }
  return oriented;
}

// Self-managed rAF — same pattern as `nameplate_sprite.js`'s LOD loop.
// Ticks every frame once `window.liveScene3d` is live. Browser-only
// (no-op under Node unit tests where `window` is undefined). Honours
// `?billboard=off` to disable G1 entirely (fail-soft kill switch).
let _bbRafId = 0;
let _bbDisposed = false;

function _billboardEnabled() {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      return (
        new URLSearchParams(globalThis.location.search).get(
          STATICS_BILLBOARD_FLAG
        ) !== "off"
      );
    }
  } catch (_) {}
  return true;
}

/** Stop the billboard rAF loop. Idempotent. For HMR / flag-change. */
export function disposeStaticsBillboards() {
  _bbDisposed = true;
  if (_bbRafId && typeof window !== "undefined") {
    try {
      window.cancelAnimationFrame(_bbRafId);
    } catch (_) {}
  }
  _bbRafId = 0;
}

if (typeof window !== "undefined" && _billboardEnabled()) {
  const _bbLoop = () => {
    if (_bbDisposed) return;
    try {
      const live = window.liveScene3d;
      if (live) tickStaticsBillboards(live);
    } catch (_) {}
    _bbRafId = window.requestAnimationFrame(_bbLoop);
  };
  _bbRafId = window.requestAnimationFrame(_bbLoop);
}

// ─────────────────────────────────────────────────────────────────────
// V1 (render-completeness Wave 3, 2026-05-29) — static scenery
// `default_script` ambient particle chains.
//
// 36% of SetupModels carry a `default_script` (a 0x33 PhysicsScript DID)
// that retail runs for EVERY physics object at creation
// (`acclient.c:320867` `if (setup->default_script_id.id)
// play_script_internal(...)`; state bit 0x80000 HAS_DEFAULT_SCRIPT_PS).
// The wire-ObjectCreate ENTITY path runs it (entities.js
// `_attachParticleChainForEntity`), but the STATIC scenery-render path
// never did — so fountains/braziers/torches/smokestacks rendered as
// dead geometry.
//
// This re-implements the CreateParticle arm of that walker for statics.
// We CANNOT reuse `_attachParticleChainForEntity` directly: it lives in
// entities.js (a different agent's file) AND is keyed by entity GUID +
// the EntityManager's `entityMap`/`_fireHook`/sound-table internals,
// none of which a static has. Statics have no GUID, no SoundTable, no
// _fireHook target — so we mirror ONLY the CreateParticle path (hook
// types 13 `CreateParticle` / 26 `CreateBlockingParticle`), anchored to
// a per-placement `THREE.Group` at the static's world position. Sound /
// Scale / CallPES arms are entity-targeted and out of scope for static
// ambient FX (the visual payoff — flames, fountain spray, torch smoke —
// is entirely in CreateParticle). Reuses the SAME public wasm exports
// the entity walker uses (`fetchPhysicsScript`, `fetchParticleEmitter`)
// + the SAME `ParticleManager` runtime.
//
// FAIL-SOFT: when no placement carries a non-zero `defaultScriptId`
// (the case for every pre-V1 bake — the field deserialises to 0), this
// path does nothing. Kill switch: `?staticScripts=off`.
// ─────────────────────────────────────────────────────────────────────

const STATIC_SCRIPT_FLAG = "staticScripts"; // ?staticScripts=off disables V1.
// CreateParticle hook types (mirrors entities.js `_attachParticleChainForEntity`).
const STATIC_HOOK_CREATE_PARTICLE = 13;
const STATIC_HOOK_CREATE_BLOCKING_PARTICLE = 26;

function _staticScriptsEnabled() {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      return (
        new URLSearchParams(globalThis.location.search).get(
          STATIC_SCRIPT_FLAG
        ) !== "off"
      );
    }
  } catch (_) {}
  return true;
}

/**
 * Lazy-construct `scene3d._staticParticleManager` on first use. Mirrors
 * `entities.js:_ensureWorldParticleManager` (the geometry/material
 * factory resolve a hwGfxObjId → BufferGeometry + Material via
 * `fetchBuildingPlacement` + `meshToGeometryGroups` + the shared
 * MaterialCache). Stored on scene3d so the self-managed rAF can tick it
 * and `disposeStaticParticles` can tear it down. Idempotent.
 *
 * Returns null if the prerequisites (wasm exports, scene group) are
 * missing — the caller no-ops in that case (fail-soft).
 */
async function _ensureStaticParticleManager(scene3d, wasmExports) {
  if (scene3d._staticParticleManager) return scene3d._staticParticleManager;
  if (
    !wasmExports ||
    typeof wasmExports.fetchBuildingPlacement !== "function" ||
    typeof wasmExports.fetch_surfaces_pixels !== "function"
  ) {
    return null;
  }
  const { ParticleManager } = await import("./particles/index.js");
  const adapter = await import("./adapter.js");
  const meshToGeometryGroups = adapter.meshToGeometryGroups;
  const materialCache = getOrCreateMaterialCache(scene3d);

  // hwGfxObjId → { geometry, surfaceDid }. Same resolve path as the
  // entity world-particle manager (entities.js:5584). Must run the
  // wasm-side part mesh through meshToGeometryGroups to get a real
  // THREE.BufferGeometry (raw wasm mesh crashes new THREE.Mesh on
  // morphAttributes).
  const resolveGfxObj = async (hwGfxObjId) => {
    let bundle;
    try {
      bundle = await wasmExports.fetchBuildingPlacement(hwGfxObjId);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[scene3d.statics/V1] fetchBuildingPlacement(0x${hwGfxObjId.toString(16)}) failed:`,
        e
      );
      return null;
    }
    if ((bundle.partCount | 0) === 0) {
      if (typeof bundle.free === "function") bundle.free();
      return null;
    }
    const meshes = bundle.takePartMeshes();
    if (typeof bundle.free === "function") bundle.free();
    const wasmMesh = meshes[0];
    if (!wasmMesh) return null;
    const { groups, surfaceDids } = meshToGeometryGroups(wasmMesh);
    if (typeof wasmMesh.free === "function") wasmMesh.free();
    if (!groups || groups.length === 0) return null;
    return {
      geometry: groups[0].geometry,
      surfaceDid: groups[0].surfaceDid || surfaceDids[0] || 0,
    };
  };

  scene3d._staticParticleManager = new ParticleManager({
    scene: scene3d.staticsGroup ?? null,
    geometryFactory: async (hwGfxObjId) => {
      const r = await resolveGfxObj(hwGfxObjId);
      return r?.geometry ?? null;
    },
    materialFactory: async (hwGfxObjId) => {
      if (!materialCache) return null;
      const r = await resolveGfxObj(hwGfxObjId);
      if (!r?.surfaceDid) return null;
      try {
        return await materialCache.get(r.surfaceDid, surfacePixelsFetcher(wasmExports));
      } catch (_) {
        return null;
      }
    },
  });
  return scene3d._staticParticleManager;
}

// Reusable scratch frame for the per-emitter parentOffset (mirrors the
// entity walker's `_particleAttachScratch*`). The chain runs serially
// per anchor (each `addEmitter` is awaited before the next), so reuse
// across one anchor's hooks is safe.
const _staticOffsetVec3 = new THREE.Vector3();
const _staticOffsetQuat = new THREE.Quaternion();

/**
 * Run ONE static placement's `default_script` PhysicsScript chain,
 * anchored to `anchor` (a THREE.Group at the static's world transform).
 * Mirrors the CreateParticle arm of entities.js
 * `_attachParticleChainForEntity` — resolves the PhysicsScript, then for
 * each CreateParticle hook resolves the emitter and adds it to the
 * manager parented to the anchor (so the particles track the static's
 * world position + the hook's offset frame).
 *
 * Returns the count of emitters attached. Fail-soft: a fetch failure on
 * the script or any emitter is logged + skipped, never thrown.
 */
async function _runStaticParticleChain(manager, anchor, pesId, wasmExports) {
  let ps;
  try {
    ps = await wasmExports.fetchPhysicsScript(pesId);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[scene3d.statics/V1] fetchPhysicsScript(0x${pesId.toString(16)}) failed:`,
      e
    );
    return 0;
  }
  const entries = ps.takeEntries();
  if (typeof ps.free === "function") ps.free();
  let attached = 0;
  for (const e of entries) {
    if (
      e.hookType !== STATIC_HOOK_CREATE_PARTICLE &&
      e.hookType !== STATIC_HOOK_CREATE_BLOCKING_PARTICLE
    ) {
      continue;
    }
    const emitterId = e.createParticleEmitterId >>> 0;
    if (emitterId === 0) continue;
    let emitterInfo;
    try {
      emitterInfo = await wasmExports.fetchParticleEmitter(emitterId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[scene3d.statics/V1] fetchParticleEmitter(0x${emitterId.toString(16)}) failed:`,
        err
      );
      continue;
    }
    _staticOffsetVec3.set(
      e.createParticleOffsetX,
      e.createParticleOffsetY,
      e.createParticleOffsetZ
    );
    _staticOffsetQuat.set(
      e.createParticleOffsetQX,
      e.createParticleOffsetQY,
      e.createParticleOffsetQZ,
      e.createParticleOffsetQW
    );
    const partIndex =
      e.createParticlePartIndex === 0xffffffff ? -1 : e.createParticlePartIndex | 0;
    try {
      const id = await manager.addEmitter({
        emitterInfo,
        parent: anchor, // THREE.Group at the static's world transform.
        partIndex,
        parentOffset: {
          position: _staticOffsetVec3,
          quaternion: _staticOffsetQuat,
        },
      });
      if (id !== 0) attached += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[scene3d.statics/V1] addEmitter(0x${emitterId.toString(16)}) failed:`,
        err
      );
    }
  }
  return attached;
}

/**
 * V1 entry point — attach `default_script` ambient particle chains for
 * every placement in `placements` that carries a non-zero
 * `defaultScriptId`. Called by `bakeStaticsForLandblock` /
 * `bakeStaticsRing` AFTER the meshes are placed.
 *
 * For each qualifying placement we create a lightweight `THREE.Group`
 * anchor at the placement's world position + yaw + scale, add it to
 * `scene3d.staticsGroup`, and run the chain against it. The anchor (not
 * the mesh node) is the particle parent so the logic is identical for
 * singleton + instanced placements (instanced placements have no single
 * node, but each instance still gets its own anchor here).
 *
 * Fail-soft + cheap default: if NO placement carries a script (the
 * universal pre-V1-bake case, since `defaultScriptId` deserialises to 0)
 * we return early WITHOUT importing the particle runtime or creating a
 * manager — zero added cost on the default path. Honours
 * `?staticScripts=off`.
 *
 * @returns {Promise<{anchorCount:number, emitterCount:number}>}
 */
export async function attachStaticDefaultScripts(scene3d, placements, wasmExports) {
  if (!scene3d || !scene3d.staticsGroup || !Array.isArray(placements)) {
    return { anchorCount: 0, emitterCount: 0 };
  }
  if (!_staticScriptsEnabled()) return { anchorCount: 0, emitterCount: 0 };

  // Collect placements with a live ambient script. The vast majority of
  // statics have `defaultScriptId === 0` — this filter is the whole
  // default-path cost (one numeric check per placement).
  const scripted = [];
  for (const p of placements) {
    const did = (p && p.defaultScriptId) >>> 0;
    if (did !== 0) scripted.push(p);
  }
  if (scripted.length === 0) return { anchorCount: 0, emitterCount: 0 };

  const manager = await _ensureStaticParticleManager(scene3d, wasmExports);
  if (!manager) return { anchorCount: 0, emitterCount: 0 };

  let anchorCount = 0;
  let emitterCount = 0;
  for (const p of scripted) {
    const lbX = (p.landblockId >>> 24) & 0xff;
    const lbY = (p.landblockId >>> 16) & 0xff;
    const worldX = lbX * METERS_PER_LANDBLOCK + p.x;
    const worldY = lbY * METERS_PER_LANDBLOCK + p.y;
    const anchor = new THREE.Group();
    anchor.name = `static-script-anchor-0x${(p.defaultScriptId >>> 0)
      .toString(16)
      .padStart(8, "0")}`;
    anchor.position.set(worldX, worldY, p.z);
    anchor.quaternion.setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      p.rotationZ ?? 0
    );
    const s = typeof p.scale === "number" && p.scale > 0 ? p.scale : 1;
    if (s !== 1) anchor.scale.set(s, s, s);
    anchor.userData = {
      isStaticScriptAnchor: true,
      defaultScriptId: p.defaultScriptId >>> 0,
      landblockId: p.landblockId,
    };
    scene3d.staticsGroup.add(anchor);
    anchorCount += 1;
    // eslint-disable-next-line no-await-in-loop
    emitterCount += await _runStaticParticleChain(
      manager,
      anchor,
      p.defaultScriptId >>> 0,
      wasmExports
    );
  }
  if (anchorCount > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[scene3d.statics/V1] attached default_script chains: ` +
        `${anchorCount} anchors, ${emitterCount} emitters`
    );
  }
  return { anchorCount, emitterCount };
}

/** Tear down the static ParticleManager + its rAF. Idempotent. */
export function disposeStaticParticles(scene3d) {
  _spDisposed = true;
  if (_spRafId && typeof window !== "undefined") {
    try {
      window.cancelAnimationFrame(_spRafId);
    } catch (_) {}
  }
  _spRafId = 0;
  const mgr = scene3d?._staticParticleManager;
  if (mgr && typeof mgr.particleTable?.forEach === "function") {
    try {
      const ids = [...mgr.particleTable.keys()];
      for (const id of ids) mgr.destroyParticleEmitter(id);
    } catch (_) {}
  }
}

// Self-managed rAF to advance the static ParticleManager every frame —
// same pattern as the billboard loop above (the render loop, loop.js,
// is another agent's file, so we drive our own tick off
// `window.liveScene3d`). No-op until a manager exists (i.e. until at
// least one scripted static is placed). Browser-only.
let _spRafId = 0;
let _spDisposed = false;

if (typeof window !== "undefined" && _staticScriptsEnabled()) {
  const _spLoop = () => {
    if (_spDisposed) return;
    try {
      const mgr = window.liveScene3d?._staticParticleManager;
      if (mgr) mgr.tick();
    } catch (_) {}
    _spRafId = window.requestAnimationFrame(_spLoop);
  };
  _spRafId = window.requestAnimationFrame(_spLoop);
}
