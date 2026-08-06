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
//   3. For each unique modelId: meshToGeometryGroups → one
//      `BufferGeometry` PER SURFACE the model uses (RP1, 2026-06-08).
//      Pre-RP1 this fused the model into ONE geometry painted with its
//      FIRST ("dominant") surface — so ~47.5% of placements (whole-Dereth
//      measurement: 1,486,218 of 3,131,844) that use multi-surface models
//      rendered every non-dominant polygon with the WRONG texture (a
//      tree's leaves painted with bark, etc.). RP1 partitions per-surface
//      (the buildings.js path) and builds one InstancedMesh/Mesh per
//      surface, each with `materialCache.getCached(surfaceDid)`. A
//      single-surface model is byte-identical to pre-RP1 (one node, one
//      material); a multi-surface model gets one node per surface so each
//      polygon gets its correct texture. Draw calls become O(unique
//      model×surface) — still O(1) in placement count.
//   4. **F#5+6 (LOD + InstancedMesh)** — landed 2026-05-10:
//      - Group placements by `modelId`, then emit one node per surface
//        group. Models with `>=2` instances are collapsed into a single
//        `THREE.InstancedMesh` per surface (one draw call per (model,
//        surface) instead of N). Singletons stay as plain `THREE.Mesh`.
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
import { BAKE_PREWARM, prewarmSubtree } from "./bake_prewarm.js";
import { meshToGeometryGroups } from "./adapter.js";
// NB single line: test_static_batch.mjs / test_static_callpes.mjs load this
// module by stripping `^\s*import .*$` LINE-wise, so a multi-line import
// specifier list would leave a dangling `} from "./materials.js";`.
import { MaterialCache, materialCanCastShadow, materialRendersNothing, skipDeadBatchEnabled, VFX_GLOBALS, installVfxComponentPatch } from "./materials.js";
import { lbKeyOf, isNearPlayerLb } from "./landblock_lru.js";
// A7-F1 (2026-07-11 s13) — shared per-cellId LandblockInfo fetch (buildings.js
// runs the SAME fetch_landblock_objects for this LB). See lb_objects_shared.js.
import { fetchLandblockObjectsShared } from "./lb_objects_shared.js";
// 2026-08-05 atlas-staging seam — "can pixels for this surface be supplied",
// which is the honest form of the batching gate below (see its comment).
import { canSupplyPlanes } from "./surface_planes.js";
import { modelMeshFetcher, surfacePixelsFetcher } from "./bake_worker_client.js";
import { CULL_DIST_SQ } from "./culling.js";
// A11-S3: `?particleClock` flag parse — when "loop"/"sim" the static
// ParticleManager is ticked from the main loop (loop.js manager phase) and
// the private rAF below never arms. time_rng.js is dependency-free, so this
// second specifier into the sibling particles/ package is cycle-safe.
import { particleClockMode, rng } from "./particles/time_rng.js";
// Task #7 — true mesh-animated scenery (flags/foliage). Static import is
// cycle-safe: animated_scenery.js imports statics.js only via a deferred
// dynamic import() inside a function, never at module load.
import { attachAnimatedScenery, animSceneryEnabled, attachWindTrees } from "./animated_scenery.js";
// Tree wind sway (?treeWind, default-OFF). When off, the peel below never runs
// and `statics` is unchanged → byte-identical frozen instanced path.
import { treeWindEnabled, isTreeDid, windGeoEnabled, windSwayGpuEnabled } from "./tree_wind.js";
import { statAtlasEnabled, addSingletonsToCrossLbAtlas, hasAtlasLb, isBc7AtlasTexture } from "./static_atlas.js";
// ?statBatchCrossLb (default-OFF, 1070 eye-test pending) — cross-LB variant of the
// per-LB ?staticBatch consolidation: same >=2-per-material groups, persistent
// per-material BatchedMeshes spanning the ring instead of one per (LB, surface).
import { statBatchChunkEnabled, consolidateStaticSingletonsCrossLb, stampStaticContentKeys, setDeadBatchPredicate } from "./static_batch_x.js";
// VFX descriptor catalog (?visual, default-OFF). Generalizes the wind divert: a
// placement also goes to the wind player if its catalog descriptor carries
// deformation.windBend. Off/absent-catalog ⇒ frozen path unchanged.
import { visualEnabled, ensureVfxCatalog, vfxDescriptorFor, windResponds, descriptorMechs } from "./vfx_catalog.js";
// Phase 3 (?gemSparkle, default-OFF) — SYNTHESIZED additive particle emitters.
// A placement whose catalog descriptor carries a `particle` mech gets one or
// more client-local additive billboard emitters attached ON TOP of its frozen
// mesh. Unlike the windBend peel (which REMOVES the placement so the animated
// player renders the mesh), the particle collect is NON-DESTRUCTIVE: the mesh
// stays in the frozen instanced path and the emitter is a pure overlay. Owner
// key `static:<lbKey>` → the LRU per-LB evict tears it down (statics installs
// `scene3d._evictStaticParticlesForLb`). DEPENDS ON P3.1 (particle_attach.js) +
// P3.3 (gemSparkleEnabled + COMPONENT_MECH "particle.gemSparkle").
import { attachParticleEmitters, staticOwnerKeyForLb } from "./vfx/particle_attach.js";
import { readParticleEnv } from "./vfx/particle_env.js"; // P3.7 derived day/weather/season for ctx.env
// VFX fragment effects (?visual, P1.14 activation). frag_attach maps a DID's
// descriptor → its registered FRAG components + per-component config ("plan");
// frag_install (slice 02) turns a plan into the cached per-SET material variant.
// Plan null (off / no descriptor / no frag comp) ⇒ the plain getCached material
// is kept ⇒ byte-identical frozen path. ensureVfxHashVarying = the slice-03
// per-instance vVfxHash prelude installed FIRST in each variant's chain.
import { fragPlanForDid } from "./vfx/frag_attach.js";
import { buildFragVariant } from "./vfx/frag_install.js";
import { ensureVfxHashVarying } from "./vfx/per_instance.js";
// Barrel — registers ALL Phase-1 frag/light components so fragPlanForDid can
// resolve them at bake time when ?visual is on. Side-effect-only (registration);
// byte-identical when ?visual is off (the registry is consulted only then).
import "./vfx/components/index.js";

// VFX frag variant (?visual, P1.14). frag_attach selects + merges per the
// descriptor; frag_install builds the per-SET cloned variant (one program per
// SET — the firewall). Off / no frag plan ⇒ base material ⇒ byte-identical. The
// vVfxHash prelude (slice 03) runs FIRST in the chain so component injects that
// read it see the varying declared. Deps are injected so frag_install stays
// THREE-free (the material surgery lives in materials.js).
const VFX_HASH_PRELUDE = { id: "infra.vfxHash", inject: (s) => ensureVfxHashVarying(s) };
// Built LAZILY on the first frag attach (visual-on only). Deferring the
// VFX_GLOBALS/installVfxComponentPatch references out of module-eval keeps the
// eval-based test_static_batch harness (which shims neither import) loadable, and
// it's a single shared object (no per-call alloc; bake-time, not hot frame path).
let _vfxFragDeps = null;
function _fragMat(base, materialCache, surfaceDid, fragPlan) {
  if (!fragPlan) return base;
  if (!_vfxFragDeps) {
    _vfxFragDeps = { globals: VFX_GLOBALS, installComponentPatch: installVfxComponentPatch, sharedPrelude: VFX_HASH_PRELUDE };
  }
  return buildFragVariant(materialCache, surfaceDid, fragPlan.entries, _vfxFragDeps) || base;
}

const METERS_PER_LANDBLOCK = 192.0;
// HOLTBURG_X/HOLTBURG_Y retired (spawn-driven-boot): the bake-time shadow gate
// and the buildHoltburg* wrapper that referenced them are gone.

// F13-4 — `?fullPlacementQuat=on`: orient a singleton/instanced static from
// the FULL AC quaternion (qw/qx/qy/qz, carried on the placement record from
// ObjectPlacement) instead of the yaw-only `rotationZ`. ~0.11% of outdoor
// LandblockInfo stabs (48 of 42,942 — tilted props on slopes, deliberate 90°
// lay-downs) carry a non-yaw orientation that the yaw-only path renders bolt
// upright at a garbage heading. Default OFF → yaw-only (byte-identical), and
// a stale pkg without the quat getters degrades to yaw-only too. The quat is
// in AC's z-up frame — the SAME frame the yaw-only `setFromAxisAngle((0,0,1),
// rotationZ)` uses (both are applied under worldRoot's z-up→y-up transform),
// so it composes correctly. Pending a 1070 eye-test (e.g. LB 0x7D64).
// INTEGRATED always-on — 2026-06-10. User-accepted (not individually eye-tested;
// the tilted-prop A/B at LB 0x7D64 was set up but the user opted to integrate the
// remaining deferred flags directly). Safe: degrades to yaw-only on a stale pkg or
// degenerate quat. Was the default-OFF `?fullPlacementQuat=on` gate.
const FULL_PLACEMENT_QUAT = true;

// F13-4 — apply a placement's orientation to a THREE.Quaternion. Full AC quat
// when the flag is on AND the record carries finite, non-degenerate quat
// fields (non-zero norm); otherwise the yaw-only fallback (the default and the
// stale-pkg path). `outQuat` is mutated and returned. `axisZ` is a reusable
// (0,0,1) Vector3 the caller owns (avoids per-call allocation on hot paths).
function applyPlacementOrientation(outQuat, placement, axisZ) {
  if (FULL_PLACEMENT_QUAT) {
    const { qw, qx, qy, qz } = placement;
    if (
      Number.isFinite(qw) && Number.isFinite(qx) &&
      Number.isFinite(qy) && Number.isFinite(qz) &&
      (qw * qw + qx * qx + qy * qy + qz * qz) > 1e-6
    ) {
      // three.js Quaternion is (x, y, z, w); normalize defensively since the
      // wire frame is unit but float round-trips can drift slightly.
      outQuat.set(qx, qy, qz, qw).normalize();
      return outQuat;
    }
  }
  return outQuat.setFromAxisAngle(axisZ, placement.rotationZ ?? 0);
}

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
// SPAWN_REF_X/Y retired (spawn-driven-boot): no hardcoded spawn anchor. The live
// tickShadowReceiveGate (loop.js) culls receive-shadow by distance from the real
// player position every frame.

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
  // Spawn-driven boot: the bake-time Holtburg distance gate is retired. The live
  // tickShadowReceiveGate (loop.js) re-tags receive-shadow from the real player
  // position every frame, so just honour the preset bool here. (worldX/worldY
  // retained for caller/signature parity.)
  return !!staticsReceiveShadow;
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

// R-JS-T4a (render-audit G2) — coerce the degraded argument into an ordered
// array of `{ geometry, dist, degradeMode }` band levels. Accepts:
//   - an Array (the new multi-band shape — passed through as-is),
//   - null/undefined/empty (→ `[]`, i.e. no LOD),
//   - a bare BufferGeometry (back-compat: wrap as a single band, reading
//     dist/degradeMode off `geom.userData`).
// Never throws; a malformed entry just yields an empty chain.
function normalizeDegradedLevels(degraded) {
  if (!degraded) return [];
  if (Array.isArray(degraded)) {
    return degraded.filter((l) => l && l.geometry);
  }
  // Bare geometry (legacy callers) → single band.
  if (degraded.isBufferGeometry || degraded.attributes) {
    return [
      {
        geometry: degraded,
        dist:
          (degraded.userData && degraded.userData.lodDist) != null
            ? degraded.userData.lodDist
            : null,
        degradeMode: (degraded.userData && degraded.userData.degradeMode) || 0,
      },
    ];
  }
  return [];
}

// R-JS-T4a (render-audit G2) — derive the per-band LOD swap distance array
// from the band chain. Each band swaps at its authored `min_dist` (`dist`);
// bands lacking one fall back to a monotonically increasing spread anchored
// at LOD_DISTANCE_M so multiple level boundaries never collide. The result
// is forced strictly ascending — THREE.LOD sorts levels by distance, and
// two equal distances would make one band unreachable. Mirrors retail
// `GfxObjDegradeInfo::get_degrade` (acclient.c:332374) ordering ALL bands by
// distance. Pure / never throws.
function bandSwapDistances(levels) {
  const out = new Array(levels.length);
  let prev = 0;
  for (let i = 0; i < levels.length; i += 1) {
    const authored =
      levels[i] && typeof levels[i].dist === "number" && levels[i].dist > 0
        ? levels[i].dist
        : null;
    // Authored distance when present; otherwise space bands out from the
    // 100m default so each successive band swaps farther than the last.
    let d = authored != null ? authored : LOD_DISTANCE_M * (i + 1);
    // Enforce strictly ascending so no band is shadowed by an earlier one.
    if (d <= prev) d = prev + 0.001;
    out[i] = d;
    prev = d;
  }
  return out;
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

// Phase 3 — NON-destructive particle collect. Returns the subset of `statics`
// whose catalog descriptor carries a `particle` mech, WITHOUT removing them from
// `statics` (the mesh must keep rendering in the frozen instanced path — a
// particle emitter is an ADDITIVE overlay, not a mesh replacement; contrast the
// windBend peel which splices). Gated visualEnabled() && gemSparkleEnabled();
// OFF ⇒ null ⇒ no attach ⇒ byte-identical. The catalog is already loaded by the
// windBend peel block that runs just before each caller (ensureVfxCatalog()).
// `?wireParticles=1` — opt static particle emitters BACK IN under ?wireframe=1
// (default OFF: wireframe skips them, see _collectParticlePlacements). For
// debugging particle-emitter placement in the wire view. Cached per session.
let _wireParticlesFlag;
function _wireParticlesEnabled() {
  if (_wireParticlesFlag !== undefined) return _wireParticlesFlag;
  let on = false;
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      const v = (new URLSearchParams(globalThis.location.search).get("wireParticles") || "").toLowerCase();
      on = v === "1" || v === "on" || v === "true" || v === "yes";
    }
  } catch (_) { on = false; }
  _wireParticlesFlag = on;
  return on;
}

function _collectParticlePlacements(statics, scene3d) {
  // Wire-agent (?wireframe=1): a debug/scene-graph/protocol view that already
  // skips atmosphere/clouds/skydome/CSM/shadows. Static particle emitters are
  // pure VFX with zero inspection value, and they DOMINATE the wireframe cost —
  // a live 121-LB Holtburg census measured 3,873 emitters (96% foliagePollen)
  // pre-allocating ~61k slot meshes (~15k parented, only ~4.9k ever visible).
  // Each slot clones its base material → in wireframe a unique `wire-did-*`
  // clone that can't batch and gets no fill companion. Skipping them here drops
  // the whole population (proven equivalent to ?visual=off: statics scene nodes
  // 17,459 → 2,532). `?wireParticles=1` re-enables for VFX-placement debugging.
  if (scene3d && scene3d.wireframeMode && !_wireParticlesEnabled()) return null;
  // Gate on the ?visual master only — the PER-EFFECT flag (gemSparkle / brazier /
  // foliage*) is enforced downstream by particleEntriesForDescriptor (comp.enabled()),
  // so a placement is dropped from the plan when its specific effect is off. Gating
  // here on gemSparkleEnabled() alone (the old bug) starved brazier/foliage statics.
  if (!visualEnabled()) return null;
  const hasParticle = (p) =>
    descriptorMechs(vfxDescriptorFor((p?.modelId >>> 0) || 0)).has("particle");
  const out = statics.filter(hasParticle);
  return out.length > 0 ? out : null;
}

// P3.7 — opts.buildParent for the STATIC seam: a parent frame at the placement's
// position+orientation IN `staticsGroup`-local coords (the static ParticleManager's
// scene = scene3d.staticsGroup), matching exactly the static MESH transform
// (buildSingletonNode: position (lbX*MPL+x, lbY*MPL+y, z), applyPlacementOrientation).
// So the emitter anchors where the gem/brazier mesh actually stands. partFrames are
// omitted (root/model-offset anchoring) — a future geometryFor can add per-part bboxes.
const _PARTICLE_PARENT_AXISZ = new THREE.Vector3(0, 0, 1);
function _buildStaticParticleParent(p) {
  if (!p) return null;
  const lbX = (p.landblockId >>> 24) & 0xff;
  const lbY = (p.landblockId >>> 16) & 0xff;
  const position = new THREE.Vector3(
    lbX * METERS_PER_LANDBLOCK + p.x,
    lbY * METERS_PER_LANDBLOCK + p.y,
    p.z,
  );
  const quaternion = new THREE.Quaternion();
  applyPlacementOrientation(quaternion, p, _PARTICLE_PARENT_AXISZ);
  return { position, quaternion };
}

/** opts passed to attachParticleEmitters at BOTH static seams (per-LB + ring). */
function _staticParticleOpts(scene3d) {
  return {
    ensureManager: _ensureStaticParticleManager,
    buildParent: _buildStaticParticleParent,
    env: readParticleEnv(scene3d),
    clockNow: () => (scene3d.frameTime && scene3d.frameTime.tsSec) || 0,
  };
}

// A2 (busted-world load fix) — concurrent-call dedup for the per-LB
// baker. The permanent `scene3d.staticsBakedLbs.add(lbKey)` now runs
// AFTER the load-bearing fetch+drain succeeds (so a throw leaves the LB
// un-baked and retryable, instead of permanently stripping its statics
// for the whole session). That move loses the old "set.add doubles as
// concurrent dedup" property, so this module-local in-flight Set takes
// over that job: two overlapping calls for the same LB still short-
// circuit, but a failed fetch no longer poisons the LB.
const _staticsInFlight = new Set();

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
    // Phase-5 — wasm namespace for the baked-roughness by-key suite fetch.
    wasmExports: scene3d.wasmExports ?? null,
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
    // 2026-07-04 — ?wireFill=0 disables the solid-fill companion pass
    // (`addFillCompanions`). Default ON when unset (scene3d.wireFill
    // undefined on legacy/capture flows that bypass index.js).
    wireFill: scene3d.wireFill,
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
        // F13-4 — full AC orientation quaternion (undefined on a stale pkg →
        // applyPlacementOrientation falls back to rotationZ). Only consulted
        // under ?fullPlacementQuat=on.
        qw: p.qw,
        qx: p.qx,
        qy: p.qy,
        qz: p.qz,
        isBuilding: false,
        scale: 1,
        // SetupModel `default_script` (0x33) DID, resolved by
        // `fetch_landblock_objects` (the `ObjectPlacement.defaultScriptId`
        // getter). 0 = none / stale pkg. Mirrors the scenery drain
        // (`fetchAndDrainScenery`) so placed LandblockInfo props
        // (braziers / fountains / torches) feed `attachStaticDefaultScripts`
        // and emit their retail ambient particle chains. Read here, before
        // `p.free()` below releases the wasm record.
        defaultScriptId:
          typeof p.defaultScriptId === "number" ? p.defaultScriptId >>> 0 : 0,
        // Task #7 — default_animation (0x03) for placed animated props.
        defaultAnimationId:
          typeof p.defaultAnimationId === "number" ? p.defaultAnimationId >>> 0 : 0,
        objId: p.modelId,
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
async function fetchAndDrainScenery(cellIds, wasmExports, urgent = false) {
  if (
    !wasmExports ||
    typeof wasmExports.fetch_landblock_scenery !== "function"
  ) {
    return [];
  }
  ensureSceneryInit(wasmExports);
  let scenery;
  try {
    // streamFix urgent lane (2026-07-02): `urgent` rides through to the
    // wasm export's SetupModel-resolve prefetch (see lib.rs). Extra arg is
    // ignored by a stale wasm bundle — fail-soft.
    scenery = await wasmExports.fetch_landblock_scenery(cellIds, urgent);
  } catch (e) {
    // A transient `fetch_landblock_scenery` failure (e.g. a dropped/timed-out
    // shard fetch over a flaky tunnel, or load spike) must NOT be swallowed:
    // returning [] here lets the bake finish TREELESS and then unconditionally
    // mark the LB `staticsBakedLbs` (~line 1737), which permanently strips that
    // LB's scenery (trees/foliage) for the WHOLE session — no retry until a
    // re-login, since the idempotency guard then short-circuits every re-bake.
    // Re-throw instead, so the scenery fetch is load-bearing exactly like the
    // LandblockInfo fetch above: the LB is left un-baked + retryable,
    // `_guardedStreamBake` cooldowns it, and the next PVS-expansion tick re-bakes
    // it — so a transient failure self-heals IN-SESSION. (A genuinely-empty LB
    // is unaffected: the fetch SUCCEEDS and returns an empty array, draining to
    // [] via the loop below — this catch only fires on a real fetch throw.)
    // eslint-disable-next-line no-console
    console.warn(
      "[scene3d.statics] fetch_landblock_scenery failed; leaving LB retryable:",
      String(e).slice(0, 200)
    );
    throw e;
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
    // Task #7 — carry default_animation (0x03) through to the bake so
    // attachAnimatedScenery can peel + animate these. Plus the full quat +
    // sourceObjIdx the animated node-builder needs (placeNode uses the quat for
    // non-yaw orientation; placementKey uses sourceObjIdx for dedupe). 0/absent
    // on a pre-rebuild pkg → soft-degrade to frozen.
    const defaultAnimationId =
      typeof p.defaultAnimationId === "number" ? p.defaultAnimationId >>> 0 : 0;
    out.push({
      landblockId: p.landblockId,
      modelId: p.objId,
      objId: p.objId,
      x: p.x,
      y: p.y,
      z: p.z,
      qw, qx, qy, qz,
      rotationZ: yaw,
      isBuilding: false,
      scale: p.scale && p.scale > 0 ? p.scale : 1,
      source: "scenery",
      defaultScriptId,
      defaultAnimationId,
      sourceObjIdx: typeof p.sourceObjIdx === "number" ? p.sourceObjIdx : undefined,
    });
    if (typeof p.free === "function") p.free();
  }
  return out;
}

/**
 * RP1 (2026-06-08) — fetch the per-model PER-SURFACE geometry groups +
 * didDegrade chain from `fetch_model_meshes` for a given set of
 * `uniqueModelIds`.
 *
 * The pre-RP1 path fused each model into ONE BufferGeometry painted with
 * its FIRST ("dominant") surface — so ~47.5% of placements (whole-Dereth
 * measurement: 1,486,218 of 3,131,844) that use multi-surface models
 * rendered every non-dominant polygon with the WRONG texture (e.g. a
 * tree's leaves painted with bark). RP1 replaces the single fused geom
 * with the buildings.js-proven per-surface partition: one BufferGeometry
 * per unique surfaceIndex the model uses (handles two-sided pos/neg
 * surfaces and the 0xFF "no surface" → surfaceDid 0 fallback bucket),
 * via the existing `adapter.meshToGeometryGroups`.
 *
 * Returns `{ groupsByModel, didDegradeByModel, allSurfaceDids,
 * skippedZeroTri }` where `groupsByModel` maps modelId → array of
 * `{ geometry, surfaceDid, doubleSided }`. A single-surface model has a
 * one-element array (and renders byte-identically to the pre-RP1 path —
 * one InstancedMesh/Mesh, one material). A multi-surface model has one
 * entry per surface and renders one InstancedMesh/Mesh per surface, each
 * with `materialCache.getCached(group.surfaceDid)`.
 *
 * Note: this is intentionally separate from `fetchDegradedGeometries`
 * below — the degraded fetch is a SECOND `fetch_model_meshes` round
 * trip and is only meaningful once the primary chain is in hand.
 */
async function fetchPrimaryGeometries(uniqueModelIds, fetchModelMeshes) {
  const groupsByModel = new Map();
  const didDegradeByModel = new Map();
  const allSurfaceDids = new Set();
  let skippedZeroTri = 0;
  // streamFix retryability (2026-07-02): count the TRANSIENT drop classes —
  // `decode-starved` (wasm reported record misses even after its retry; the
  // fetch pipeline was saturated, e.g. mid rapid-teleport backlog) and
  // `no-mesh` (batch shorter than requested). A `zero-tri` WITHOUT misses is
  // a genuinely-empty model and stays a permanent skip. The caller uses
  // `starvedCount > 0` to leave the LB un-marked + retryable instead of
  // permanently baking a hole into the town.
  let starvedCount = 0;

  if (uniqueModelIds.length === 0) {
    return {
      groupsByModel,
      didDegradeByModel,
      allSurfaceDids,
      skippedZeroTri,
      starvedCount,
    };
  }

  let meshes;
  try {
    meshes = await fetchModelMeshes(new Uint32Array(uniqueModelIds));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[scene3d.statics] fetch_model_meshes batch failed:", e);
    return {
      groupsByModel,
      didDegradeByModel,
      allSurfaceDids,
      skippedZeroTri,
      starvedCount,
      fetchFailed: true,
    };
  }

  // geom-audit (2026-07-02): collect every dropped model id + reason so
  // the batch warn below makes silent scene holes impossible.
  const droppedModelIds = [];
  for (let i = 0; i < uniqueModelIds.length; i += 1) {
    const id = uniqueModelIds[i];
    const m = meshes[i];
    if (!m) {
      droppedModelIds.push({ id: id >>> 0, reason: "no-mesh" });
      starvedCount += 1;
      continue;
    }
    if (m.triCount === 0) {
      skippedZeroTri += 1;
      const misses = typeof m.decodeMisses === "number" ? m.decodeMisses >>> 0 : -1;
      const starved = misses > 0;
      if (starved) starvedCount += 1;
      droppedModelIds.push({ id: id >>> 0, reason: starved ? "decode-starved" : "zero-tri" });
      if (typeof m.free === "function") m.free();
      continue;
    }
    // streamFix retryability (2026-07-02): a mesh that decoded with
    // record misses but non-zero tris is PARTIAL (wasm warned "mesh will
    // be partial/empty"). Count it starved so the caller leaves the LB
    // retryable — the throw happens BEFORE any node attach, so the retry
    // re-bake cannot duplicate nodes. Once the retry cap is exhausted the
    // caller accepts this partial output as-is.
    if (((typeof m.decodeMisses === "number" ? m.decodeMisses : 0) >>> 0) > 0) {
      starvedCount += 1;
    }
    // Snapshot every DID this model references — material cache
    // preloads them in one batch below. Each `surfaces` getter
    // allocates a fresh Uint32Array; read once.
    const surfacesArr = m.surfaces;
    for (const did of surfacesArr) allSurfaceDids.add(did >>> 0);

    // F#5 — snapshot didDegrade. 0 = no degrade chain.
    const dd = (m.didDegrade ?? 0) >>> 0;
    if (dd !== 0) {
      didDegradeByModel.set(id, dd);
    }

    // RP1 — per-surface partition (the buildings.js path). One group per
    // unique surfaceIndex; the 0xFF "no surface" bucket comes back with
    // surfaceDid 0 and is painted with the fallback material by
    // `materialCache.getCached(0)` (which returns fallbackMaterial).
    const { groups } = meshToGeometryGroups(m);
    if (groups && groups.length > 0) {
      // ?statGeomDedup (default OFF; no-op + not one byte read when off) —
      // stamp each surface group with its decode-identity content key HERE,
      // the one seam both bakers share and the last point where
      // `doubleSided` is still in scope (the node's userData carries modelId +
      // surfaceDid but NOT sidedness, and statics calls getCached(did) without
      // the side argument, so both sidedness variants share a batch bucket).
      // Cost is O(1) per (model, surface) per LB feed — never per placement.
      stampStaticContentKeys(id, groups);
      groupsByModel.set(id, groups);
    }
    if (typeof m.free === "function") m.free();
  }
  // geom-audit: never drop a static model silently — every skipped id
  // logs with its reason (decode-starved ids were already warned +
  // retried wasm-side; this surfaces the scene-level consequence).
  if (droppedModelIds.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[geom-audit] statics: ${droppedModelIds.length}/${uniqueModelIds.length} models dropped from bake: ` +
        droppedModelIds.map((d) => `0x${d.id.toString(16)}(${d.reason})`).join(" ")
    );
  }

  return {
    groupsByModel,
    didDegradeByModel,
    allSurfaceDids,
    skippedZeroTri,
    starvedCount,
  };
}

// streamFix retryability (2026-07-02): per-LB starved-decode retry budget.
// A decode-starved bake un-marks the LB + throws (the stream guard cooldowns
// it, the PVS expansion re-fires it — the exact self-heal path the scenery
// re-throw above uses), but ONLY up to this many attempts: a model that is
// PERMANENTLY undecodable (absent from the manifest — indistinguishable from
// starvation at this layer) must not turn the LB into an infinite
// bake→throw→cooldown loop. After the cap, the partial bake is accepted and
// warned loudly. A fully-clean bake clears the LB's counter.
const STATICS_STARVED_RETRY_CAP = 3;
const _staticsStarvedRetries = new Map();

/**
 * RP1 — composite key for the degraded surface-group Map. Mirrors the
 * FULL mesh's bucket identity (surfaceIndex, sides) so that under the
 * default `?perPolyCull` a single surfaceDid that splits into a
 * DoubleSide group and a FrontSide group keeps two DISTINCT degraded
 * entries (one per full group), instead of collapsing to one (which
 * would drop+leak one geometry and double-free the survivor). Pairs 1:1
 * with the full group via the same `(surfaceDid, doubleSided)` tuple.
 */
function degradedSurfaceKey(surfaceDid, doubleSided) {
  return `${surfaceDid >>> 0}|${doubleSided ? 1 : 0}`;
}

/**
 * F#5 — fetch degraded variant geometries for every model that
 * reports a non-zero didDegrade. One wasm round-trip resolves them
 * all. Failures (degraded DID not in DAT) silently drop to "no LOD"
 * and the model uses a plain Mesh / InstancedMesh.
 *
 * RP1 (2026-06-08) — the degraded leaf is now ALSO partitioned
 * per-surface (matching the full mesh) so the LOD path keeps the
 * per-surfaceDid material key.
 *
 * R-JS-T4a (render-audit G2, 2026-06-09) — consume the FULL DegradeInfo
 * band CHAIN, not just `bands[0]`. Retail `GfxObjDegradeInfo::get_degrade`
 * (acclient.c:332374) walks ALL bands by distance and builds a multi-level
 * chain; we now mirror that. Returns
 * `Map<modelId, Map<surfaceKey, Array<{geometry, dist, degradeMode}>>>`
 * where surfaceKey is the `(surfaceDid, doubleSided)` composite from
 * `degradedSurfaceKey` — the SAME bucket identity the full mesh uses — so
 * each FULL surface group can pair its LOD with its OWN ordered list of
 * per-band degraded surface groups (one geometry per band per full group,
 * never shared → no LRU double-free). The list is ordered most-detailed
 * degrade first (band 0) to least-detailed (the order the node builders
 * add `addLevel`s, each at its own authored swap distance). A full surface
 * group whose bucket has no degraded counterpart in a band renders that
 * band without a level — it never gets painted with the wrong texture.
 * Per band the authored swap distance (`dist`) and billboard mode
 * (`degradeMode`) ride alongside the geometry in the list entry. Bands
 * whose `0x01` geometry can't be fetched/built are SKIPPED (logged), never
 * silently capping the chain — the remaining buildable bands still emit
 * their levels at their correct distances.
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
  // built. Resolve the chain via the existing `fetch_gfx_obj_degrade_info`
  // getter.
  //
  // R-JS-T4a (render-audit G2, 2026-06-09) — closes the G3 TODO that
  // capped consumption to `bands[0]`. We now resolve EVERY band's `0x01`
  // gfx_obj_id and its authored `min_dist`, ordered most-detailed-degrade
  // first, so the node builders can add one `addLevel` per band swapping at
  // each band's own distance (mirroring retail
  // `GfxObjDegradeInfo::get_degrade`, acclient.c:332374). When only one
  // band exists the result is byte-identical to the prior single-band
  // path. Fail-soft per model AND per band: a parse/fetch error on the
  // whole chain drops the model to "no LOD"; a single unbuildable band is
  // skipped (logged) while the other buildable bands still emit their
  // levels — we never silently cap the chain at the first failure.
  if (typeof fetchDegradeInfo !== "function") {
    return degradedGeomByModel;
  }

  // Resolve each model's chain → ordered list of
  // { gfxId (0x01), dist, degradeMode } bands, in parallel.
  const entries = [...didDegradeByModel.entries()];
  const resolved = await Promise.all(
    entries.map(async ([modelId, chainId]) => {
      try {
        const json = await fetchDegradeInfo(chainId >>> 0);
        if (!json || json === "null") return null;
        const info = JSON.parse(json);
        const bands = Array.isArray(info?.degrades) ? info.degrades : [];
        if (bands.length === 0) return null;
        // R-JS-T4a — walk the WHOLE band list (not just bands[0]). Each
        // band with a usable `0x01` gfx_obj_id becomes one degraded LOD
        // level; bands without one are dropped from the chain (they have
        // no fetchable geometry). Authored distances are kept per band so
        // the swap happens at the band's own `min_dist`.
        const chain = [];
        for (const b of bands) {
          const gfxId = (b.gfx_obj_id ?? 0) >>> 0;
          if (!gfxId) continue;
          const dist =
            typeof b.min_dist === "number" && b.min_dist > 0
              ? b.min_dist
              : null;
          // G1 (waves-2 2026-05-29) — `degrade_mode` is the per-LOD-band
          // billboard-orientation flag from `CPhysicsPart::calc_draw_frame`
          // (acclient.c:315074): 1=fixed (no transform), 2=full billboard,
          // 3/4/5=axis-0/1/2 constrained. Carry it alongside so the
          // per-frame billboard tick can orient the degraded leaf to face
          // the viewer. Default 0 ("no billboard") when the band omits it →
          // tick no-ops.
          const degradeMode =
            typeof b.degrade_mode === "number" ? b.degrade_mode >>> 0 : 0;
          chain.push({ gfxId, dist, degradeMode });
        }
        if (chain.length === 0) return null;
        return { modelId, chain };
      } catch (_) {
        return null;
      }
    })
  );
  const perModel = new Map();
  for (const r of resolved) {
    if (r) perModel.set(r.modelId, r.chain);
  }
  if (perModel.size === 0) return degradedGeomByModel;

  // Batch-fetch the unique band geometries (0x01 GfxObjs). RP1 — each
  // band mesh is partitioned per-surface (matching the full mesh), so a
  // gfxId maps to a `Map<surfaceDid, geometry>` rather than one fused
  // geom. The full surface groups pair their LOD with the degraded
  // surface group of the SAME surfaceDid.
  // R-JS-T4a — the unique-gfxId set now spans EVERY band of EVERY model's
  // chain (not just one per model), so each distinct band geometry is
  // fetched once and shared by reference across the chains that cite it.
  const uniqueGfxIds = [
    ...new Set(
      [...perModel.values()].flatMap((chain) => chain.map((b) => b.gfxId))
    ),
  ];
  const groupsByGfxId = new Map();
  try {
    const meshes = await fetchModelMeshes(new Uint32Array(uniqueGfxIds));
    for (let i = 0; i < uniqueGfxIds.length; i += 1) {
      const m = meshes[i];
      if (!m || m.triCount === 0) {
        if (m && typeof m.free === "function") m.free();
        continue;
      }
      const { groups } = meshToGeometryGroups(m);
      if (groups && groups.length > 0) {
        const bySurface = new Map();
        // RP1 — key by (surfaceDid, doubleSided) to match the FULL mesh's
        // bucket identity. Under default `?perPolyCull`, one surfaceDid can
        // emit TWO groups (DoubleSide + FrontSide); keying by surfaceDid
        // alone would collapse them — the second would overwrite the first
        // (dropped/leaked geometry) AND both full groups would then share
        // one degraded geometry object → double-free on LRU eviction.
        // meshToGeometryGroups returns `doubleSided` on every group, so the
        // composite key keeps the sub-groups distinct and pairing 1:1.
        for (const g of groups) {
          bySurface.set(degradedSurfaceKey(g.surfaceDid, g.doubleSided), g.geometry);
        }
        groupsByGfxId.set(uniqueGfxIds[i], bySurface);
      }
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

  // R-JS-T4a — assemble per model a Map<surfaceKey, [bandLevel, ...]> where
  // each bandLevel = { geometry, dist, degradeMode } in chain order
  // (most-detailed degrade first). The node builders add one `addLevel` per
  // bandLevel, swapping at that band's `dist`.
  //
  // Geometry ownership: a single band gfxId (and thus its `bySurface`
  // geometries) can be cited by MORE THAN ONE model's chain (different
  // models referencing the same shared degraded leaf). The LRU disposes a
  // node's geometries on eviction, so two LOD nodes must NEVER share one
  // BufferGeometry object → double-free. We therefore CLONE each band
  // geometry per (model, surface) consumer; degraded leaves are tiny so the
  // clone cost is negligible, and the per-LB dispose/LRU paths below each
  // own a distinct geometry. (The prior single-band code shared geometries
  // across same-gfxId models, a latent double-free risk this clone closes.)
  // `bandsWithGeom` / `bandsSkipped` feed a one-line summary log so a band
  // whose geometry couldn't be built is visible, not silently dropped.
  let bandsWithGeom = 0;
  let bandsSkipped = 0;
  for (const [modelId, chain] of perModel) {
    // surfaceKey → ordered array of { geometry, dist, degradeMode }.
    const bySurfaceLevels = new Map();
    for (const band of chain) {
      const srcBySurface = groupsByGfxId.get(band.gfxId);
      if (!srcBySurface || srcBySurface.size === 0) {
        // This band's 0x01 geometry wasn't fetchable/buildable. SKIP this
        // level only — the other buildable bands of this chain still get
        // their levels at their own distances. Never cap the chain here.
        bandsSkipped += 1;
        continue;
      }
      bandsWithGeom += 1;
      for (const [surfaceKey, srcGeom] of srcBySurface) {
        // Clone so each consumer owns its geometry (see ownership note).
        let geom;
        try {
          geom = srcGeom.clone();
        } catch (_) {
          // A clone failure must not throw out of the bake — skip this
          // band's surface (it just won't get a degraded level).
          continue;
        }
        // Carry the band's authored swap distance + billboard mode on the
        // cloned geometry's userData so the node builders read them per
        // level exactly as the single-band path did, plus on the list entry
        // for direct access.
        geom.userData = geom.userData || {};
        if (band.dist != null) geom.userData.lodDist = band.dist;
        if (band.degradeMode) geom.userData.degradeMode = band.degradeMode;
        let arr = bySurfaceLevels.get(surfaceKey);
        if (!arr) {
          arr = [];
          bySurfaceLevels.set(surfaceKey, arr);
        }
        arr.push({
          geometry: geom,
          dist: band.dist,
          degradeMode: band.degradeMode,
        });
      }
    }
    if (bySurfaceLevels.size > 0) {
      degradedGeomByModel.set(modelId, bySurfaceLevels);
    }
  }
  // The source `bySurface` geometries in `groupsByGfxId` were only used as
  // clone templates; dispose them so they don't leak (every consumer holds
  // a clone). Fail-soft per geometry.
  for (const bySurface of groupsByGfxId.values()) {
    for (const geom of bySurface.values()) {
      try {
        geom?.dispose?.();
      } catch (_) {}
    }
  }
  if (bandsSkipped > 0) {
    // eslint-disable-next-line no-console
    console.info(
      `[scene3d.statics/R-JS-T4a] degrade chains: ${bandsWithGeom} band(s) built, ` +
        `${bandsSkipped} band(s) skipped (no fetchable 0x01 geometry).`
    );
  }
  return degradedGeomByModel;
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
    // F13-4 — full AC quat under ?fullPlacementQuat=on, else yaw-only.
    applyPlacementOrientation(tmpQuat, placement, tmpAxis);
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
 * Build a singleton plain-Mesh node (no InstancedMesh) for ONE
 * placement's ONE surface group. Used by:
 *   - the ring driver for groups with exactly one instance, and
 *   - the per-LB lazy baker for EVERY placement in the new LB
 *     (because per-LB lazy adds can't be batched into the ring's
 *     existing InstancedMesh without complex re-instantiation).
 *
 * RP1 (2026-06-08) — invoked ONCE PER SURFACE GROUP of the placement's
 * model. A single-surface model = one call = one node (byte-identical
 * to the pre-RP1 fused path); a 2-surface model = two calls = two nodes
 * (correct textures). `geom` / `mat` are this surface group's geometry +
 * `materialCache.getCached(surfaceDid)`; `surfaceDid` is folded into the
 * node name/userData so multiple surface-group nodes for the same
 * placement don't collide and the LRU's per-LB scene-graph eviction
 * (keyed by `userData.landblockId`) catches every one of them.
 *
 * When `degradedLevels` is a non-empty array, wraps the full leaf plus
 * one degraded leaf PER band in a `THREE.LOD` (R-JS-T4a, render-audit G2),
 * each swapping at its own band distance. Most Holtburg statics have no
 * degrade chain so the wrap is a no-op today, but we keep it so the
 * lazy-add code path matches the ring-bake code path exactly. A single-
 * element array reproduces the prior 2-level LOD byte-for-byte.
 *
 * Caller adds the returned node to `scene3d.staticsGroup`.
 */
function buildSingletonNode({
  placement,
  modelId,
  surfaceDid = 0,
  geom,
  degradedLevels,
  mat,
  staticsShadow,
  staticsMatCastsShadow,
  staticsReceiveShadow,
}) {
  const modelKey = (modelId >>> 0).toString(16).padStart(8, "0");
  const surfaceKey = (surfaceDid >>> 0).toString(16).padStart(8, "0");
  const lbX = (placement.landblockId >>> 24) & 0xff;
  const lbY = (placement.landblockId >>> 16) & 0xff;
  const worldX = lbX * METERS_PER_LANDBLOCK + placement.x;
  const worldY = lbY * METERS_PER_LANDBLOCK + placement.y;
  const placementKey =
    `${(placement.landblockId >>> 0).toString(16).padStart(8, "0")}_` +
    `${placement.x.toFixed(2)}_${placement.y.toFixed(2)}_${modelKey}_s${surfaceKey}`;

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
  // F13-4 — full AC quat under ?fullPlacementQuat=on (leans/lays down the
  // ~48 non-yaw outdoor placements), else the yaw-only heading.
  applyPlacementOrientation(
    mesh.quaternion,
    placement,
    new THREE.Vector3(0, 0, 1)
  );
  if (placementScale !== 1) {
    mesh.scale.set(placementScale, placementScale, placementScale);
  }
  mesh.userData = {
    modelId,
    surfaceDid,
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

  // R-JS-T4a (render-audit G2) — `degradedLevels` is the ordered band
  // chain (most-detailed degrade first) for this surface group, or null/
  // empty when this group has no degrade chain. Normalize: also accept a
  // bare geometry for back-compat with any caller that still passes one.
  const levels = normalizeDegradedLevels(degradedLevels);
  if (levels.length === 0) {
    return { node: mesh, isLod: false };
  }

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
  lod.addLevel(mesh, 0);

  // R-JS-T4a (render-audit G2 — closes the prior G3 single-band TODO):
  // build one `addLevel` PER degrade band, each swapping at the band's own
  // authored `min_dist` (falling back to a spread of LOD_DISTANCE_M for
  // bands missing a distance). Mirrors retail
  // `GfxObjDegradeInfo::get_degrade` (acclient.c:332374) walking ALL bands
  // into a multi-level chain instead of capping at bands[0]. A missing/
  // throwing band is skipped (never throws); a single-band chain produces
  // the exact prior 2-level LOD.
  const swapDists = bandSwapDistances(levels);
  let firstBillboardGeom = null;
  for (let li = 0; li < levels.length; li += 1) {
    const lvl = levels[li];
    const dGeom = lvl && lvl.geometry;
    if (!dGeom) continue;
    let degradedMesh;
    try {
      degradedMesh = new THREE.Mesh(dGeom, mat);
    } catch (_) {
      continue; // robustness: skip this band, keep the rest.
    }
    degradedMesh.name = `static-degraded${li}-${placementKey}`;
    if (staticsShadow) {
      degradedMesh.castShadow = staticsMatCastsShadow;
      // FU2 — same per-placement distance gate as the full-detail leaf.
      degradedMesh.receiveShadow = placementReceiveShadow;
    }
    // Child of the LOD — identity local transform (the LOD owns placement).
    degradedMesh.position.set(0, 0, 0);
    degradedMesh.quaternion.identity();
    degradedMesh.scale.set(1, 1, 1);
    degradedMesh.userData = {
      modelId,
      surfaceDid,
      landblockId: placement.landblockId,
      placementKey,
      isBuilding: false,
      isDegraded: true,
      degradeBand: li,
      source,
    };
    lod.addLevel(degradedMesh, swapDists[li]);
    // The first degraded band that carries a billboard mode is the one the
    // tick orients (billboardLevel = 1 = first degraded leaf after the
    // distance-sorted full leaf at index 0).
    if (!firstBillboardGeom && (dGeom.userData?.degradeMode ?? 0) >= 2) {
      firstBillboardGeom = dGeom;
    }
  }
  // If every band failed to build a mesh, fall back to the plain full mesh.
  // 2026-08-03 — the LOD took the placement transform above and the leaf was
  // reset to identity; hand it back or the prop renders at the landblock origin
  // at scale 1.
  if (lod.levels.length <= 1) {
    mesh.position.copy(lod.position);
    mesh.quaternion.copy(lod.quaternion);
    mesh.scale.copy(lod.scale);
    return { node: mesh, isLod: false };
  }
  lod.userData = {
    modelId,
    surfaceDid,
    landblockId: placement.landblockId,
    placementKey,
    isBuilding: false,
    source,
  };
  // G1 (waves-2 2026-05-29) — tag the LOD for the per-frame billboard tick
  // when the (first) degraded band carries a billboard mode (>=2). Mode 1
  // (fixed) / 0 leave the leaf at its authored orientation. `billboardLevel
  // = 1` is the first degraded leaf's index after the distance-sorted full
  // leaf at index 0 — the tick only orients that band.
  if (firstBillboardGeom) tagBillboardLod(lod, firstBillboardGeom);
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
  surfaceDid = 0,
  group,
  geom,
  degradedLevels,
  mat,
  placementMatrix,
  staticsShadow,
  staticsMatCastsShadow,
  staticsReceiveShadow,
}) {
  const modelKey = (modelId >>> 0).toString(16).padStart(8, "0");
  const surfaceKey = (surfaceDid >>> 0).toString(16).padStart(8, "0");
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
  //
  // RP1 (2026-06-08) — this builder is now called ONCE PER SURFACE GROUP
  // of the model, so a multi-surface model produces several distinct
  // InstancedMesh/LOD nodes, EACH owning its own `coversLbKeys` Set (the
  // LRU mutates the Set in-place on eviction, so the per-surface nodes
  // must not share one Set — otherwise the first surface's eviction would
  // empty the Set the other surfaces' refcount depends on). Each node
  // also owns its own geometry (this group's), disposed exactly once by
  // the LRU when its own Set empties.
  const coversLbKeys = new Set();
  for (const p of group) {
    if (p.landblockId != null) coversLbKeys.add(lbKeyOf(p.landblockId >>> 0));
  }
  const instanced = new THREE.InstancedMesh(geom, mat, group.length);
  instanced.name = `static-instanced-${modelKey}-s${surfaceKey}-x${group.length}`;
  instanced.userData = {
    modelId,
    surfaceDid,
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
  // meshToGeometryGroups (per surface group). InstancedMesh additionally
  // needs an aggregate boundingSphere covering all instance positions for
  // accurate frustum culling. three.js's InstancedMesh exposes
  // `computeBoundingSphere()` that walks the per-instance matrices
  // and expands the geometry's sphere.
  instanced.computeBoundingSphere();
  // FCULL (2026-06-08) — DISABLE three.js's built-in frustum cull on the
  // InstancedMesh. The renderer tests an InstancedMesh by transforming the
  // SINGLE-instance `geometry.boundingSphere` by the NODE matrixWorld; it
  // ignores the per-instance matrices, so a node whose instances are
  // scattered across a 192 m landblock (node origin at one corner) gets
  // wrongly culled the instant its origin leaves the frustum. The app-level
  // cull pass (`cullStaticsGroup`) uses the AGGREGATE `boundingSphere`
  // computed just above (it walks the instance matrices) and gates `.visible`
  // correctly. `frustumCulled=false` hands the test to us alone.
  instanced.frustumCulled = false;

  // R-JS-T4a (render-audit G2) — `degradedLevels` is this surface group's
  // ordered band chain (most-detailed degrade first), or null/empty for no
  // LOD. Normalize (also tolerates a bare geometry from legacy callers).
  const levels = normalizeDegradedLevels(degradedLevels);
  if (levels.length === 0) {
    return { node: instanced, isLod: false };
  }

  const lod = new THREE.LOD();
  lod.name = `static-lod-${modelKey}-s${surfaceKey}`;
  lod.addLevel(instanced, 0);

  // R-JS-T4a (render-audit G2 — closes the prior G3 TODO that hardcoded
  // LOD_DISTANCE_M here): build ONE degraded InstancedMesh leaf PER band,
  // each placed with the SAME per-instance matrices and swapped at the
  // band's own authored distance. Mirrors retail
  // `GfxObjDegradeInfo::get_degrade` (acclient.c:332374) walking ALL bands.
  // A band whose geometry is missing/throws is skipped, never throwing; a
  // single-band chain reproduces the prior 2-level instanced LOD (now at
  // the band's real distance rather than the fixed guess).
  const swapDists = bandSwapDistances(levels);
  let firstBillboardMode = 0;
  for (let li = 0; li < levels.length; li += 1) {
    const dGeom = levels[li] && levels[li].geometry;
    if (!dGeom) continue;
    let degradedInstanced;
    try {
      degradedInstanced = new THREE.InstancedMesh(dGeom, mat, group.length);
    } catch (_) {
      continue; // robustness: skip this band, keep the rest.
    }
    degradedInstanced.name = `static-instanced-degraded${li}-${modelKey}-s${surfaceKey}`;
    if (staticsShadow) {
      degradedInstanced.castShadow = staticsMatCastsShadow;
      // C2 + FU2 — same low-preset gate as the full-detail InstancedMesh.
      degradedInstanced.receiveShadow = staticsReceiveShadow;
    }
    for (let i = 0; i < group.length; i += 1) {
      const m4 = placementMatrix(group[i]);
      degradedInstanced.setMatrixAt(i, m4);
    }
    degradedInstanced.instanceMatrix.needsUpdate = true;
    degradedInstanced.computeBoundingSphere();
    // FCULL — same caveat as the full-detail leaf: disable three's broken
    // single-instance frustum test; the app-level pass culls the LOD wrapper
    // coherently using the aggregate sphere.
    degradedInstanced.frustumCulled = false;
    lod.addLevel(degradedInstanced, swapDists[li]);
    if (!firstBillboardMode && (dGeom.userData?.degradeMode ?? 0) >= 2) {
      firstBillboardMode = dGeom.userData.degradeMode;
    }
  }
  // If no band produced a degraded leaf, fall back to the plain InstancedMesh.
  if (lod.levels.length <= 1) {
    return { node: instanced, isLod: false };
  }
  lod.userData = {
    modelId,
    surfaceDid,
    isBuilding: false,
    isInstancedLod: true,
    source,
    sceneryCount,
    landblockInfoCount,
    // C3 #7 — same coversLbKeys Set as the InstancedMesh leaves (the LRU
    // is handed the LOD wrapper for instanced-LOD nodes; ALL LOD levels
    // share these covered lb-keys).
    coversLbKeys,
  };
  // G1 (waves-2 2026-05-29) — billboard orientation is NOT applied to the
  // InstancedMesh degraded leaves. Each instance sits at a distinct world
  // position so a single shared mesh-level rotation can't face all of them
  // at the camera; correct per-instance billboarding would require
  // rewriting the whole instanceMatrix buffer every frame (the exact GPU
  // re-upload cost the InstancedMesh collapse exists to avoid). The
  // plain-Mesh singleton path (`buildSingletonNode`) gets the billboard
  // tick. We record the (first) band's mode for diag visibility only —
  // `tickStaticsBillboards` skips `isInstancedLod` nodes.
  if (firstBillboardMode >= 2) {
    lod.userData.billboardModeInstancedSkipped = firstBillboardMode;
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
// === Problem-B (2026-06-15) — ?staticBatch=on — per-LB singleton BatchedMesh ===
// The per-LB lazy baker emits ONE plain Mesh per placement-per-surface; a
// 5-min town-hop measured these piling up to ~8,400 resident nodes (the
// dominant per-frame traversal + draw-call cost — "CPU overwhelmed by meshes").
// `?staticBatch=on` consolidates a landblock's plain-Mesh singletons that share
// a surface material into ONE THREE.BatchedMesh per surfaceDid (r184): one node
// + one draw call per (LB, surface) instead of one per placement, with
// BatchedMesh's own per-instance GPU frustum culling. LOD wrappers + lone
// singletons are left untouched. The batch is tagged with this LB's
// landblockId, so the EXISTING evict `kill` (landblock_lru.js:238) removes it
// per-LB; the LRU additionally `.dispose()`s it (its GPU buffer/textures, which
// the geometry-disposables list doesn't cover). The source group geometries
// stay in the disposables (BatchedMesh COPIES vertex data) → no double-free.
// ALWAYS-ON (2026-06-15, live-validated); `?staticBatch=off` → byte-identical
// legacy one-Mesh-per-placement path. JS-live.
let _staticBatchFlag;
function readStaticBatchFlag() {
  if (_staticBatchFlag !== undefined) return _staticBatchFlag;
  // ALWAYS-ON since 2026-06-15 — LIVE-VALIDATED on the Dell (6-town run-across-
  // terrain probe): per-LB singletons 8,766→1,951 resident nodes (4.5x), visible
  // statics ~3,194→~561 (~6-10x), no SwiftShader OOM-crash. `?staticBatch=off`
  // reverts to one Mesh per placement-per-surface (escape hatch / A-B).
  let on = true;
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      const v = (new URLSearchParams(globalThis.location.search).get("staticBatch") || "").toLowerCase();
      // Opt-out only — on/true/1/yes are accepted no-ops (it's the default now).
      if (v === "off" || v === "0" || v === "false" || v === "no") on = false;
    }
  } catch (_) { on = true; }
  _staticBatchFlag = on;
  return on;
}
// Test seam.
export function __setStaticBatchForTest(v) { _staticBatchFlag = v; }

let _walkInInstanceFlag;
// ?walkInInstance (DEFAULT-OFF, 2026-07-15) — group the WALK-IN baker's
// placements by modelId and emit an InstancedMesh for any model with >= 2
// placements in this LB, exactly as the ring-wide baker already does (~:2723).
//
// WHY. The walk-in baker builds one plain Mesh PER PLACEMENT with no grouping
// (`for (const placement of statics)` -> buildSingletonNode), and walk-in is how
// you arrive anywhere, so almost every static in a streamed town is
// un-instanced. Those nodes fall through to the chunk batcher, where BatchedMesh
// emits ONE multiDraw range PER INSTANCE. Measured at settled Holtburg on the
// 1070 (net-review/singleton-dedupe-probe.mjs): 17,774 batched instances share
// only 324 DISTINCT geometries (54.9x), the top geometry is drawn 1,736 times,
// and one bucket holds 277 instances of a SINGLE model. `info.render.calls`
// cannot see any of it — it counts a whole multiDraw as 1
// (three.module.js:4449), which is why four sessions optimized a 1,920-draw
// number for a ~7,562-draw frame.
//
// The draw floor by (material, geometry) is ~375 vs ~17,774 today, and
// InstancedMesh is ONE real draw for N instances — measured FREE in this very
// scene (14 nodes / 2,992 instances cost -0.28ms).
//
// DEFAULT-OFF until A/B'd on the 1070. Score it with
// net-review/multidraw-truth-probe.mjs + renderCPU, NOT with info.calls:
// collapsing ranges into instanced draws makes info.calls go UP (183 -> ~375)
// while the frame gets faster. That inversion is the whole trap.
function walkInInstanceEnabled() {
  if (_walkInInstanceFlag !== undefined) return _walkInInstanceFlag;
  let on = false; // opt-IN only: === "on"/"1"/"true"/"yes" enables.
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      const v = (new URLSearchParams(globalThis.location.search).get("walkInInstance") || "").toLowerCase();
      on = v === "on" || v === "1" || v === "true" || v === "yes";
    }
  } catch (_) { on = false; }
  _walkInInstanceFlag = on;
  return on;
}
// Test seam.
export function __setWalkInInstanceForTest(v) { _walkInInstanceFlag = v; }

// === ?skipDeadBatch (2026-08-06, DEFAULT-ON) ================================
// "Can this batch bucket ever put a pixel on screen?", composed once here from
// the shared predicate + its own escape flag. BOTH statics batchers use it —
// the per-LB one below and the cross-LB chunk batcher, which takes it by
// injection because static_batch_x.js is a THREE-only leaf (see
// `setDeadBatchPredicate` there for why, and `_markDeadBatch` for the
// every-member-is-invisible and shadow arguments, which apply verbatim to the
// per-LB buckets: both key by the material OBJECT and hand that object to
// `new THREE.BatchedMesh(..., mat)`).
//
// Nothing here loosens `materialRendersNothing` — additive blending and
// `depthWrite === true` still fail it. This is only a second CALLER of the
// unchanged predicate plus a flag of its own.
function _batchRendersNothing(mat) {
  return skipDeadBatchEnabled() && materialRendersNothing(mat);
}
setDeadBatchPredicate(_batchRendersNothing);

// Consolidate a per-LB list of built static nodes: plain-Mesh singletons sharing
// a surface material → one BatchedMesh per surfaceDid; LOD wrappers, lone
// singletons, and any member that won't fit the batch fall through as-is.
// Returns the replacement node list. `outBatches` (optional) collects the
// BatchedMeshes created (for the summary count).
export function consolidateStaticSingletons(nodes, outBatches) {
  const out = [];
  const bySurf = new Map(); // material identity -> Mesh[]
  for (const n of nodes) {
    // !isInstancedMesh (2026-07-15, ?walkInInstance): an InstancedMesh is
    // `isMesh === true`, so without this guard it would be swept in here and
    // addGeometry/addInstance'd ONCE — silently collapsing N placements to one
    // and deleting scenery. Harmless before ?walkInInstance (this path had never
    // been handed an InstancedMesh); load-bearing now.
    if (n && n.isMesh && !n.isInstancedMesh && !n.isLOD && n.geometry && n.material && n.userData) {
      // P1.14 (kit §7 EDIT F): key by the MATERIAL OBJECT, not the surfaceDid.
      // With ?visual on, two DIDs sharing a surfaceDid but carrying different frag
      // SETs resolve to different (surfaceDid|setKey|configKey) variant clones —
      // keying by surfaceDid would fuse them and inherit one SET's material (wrong).
      // ?visual OFF ⇒ every node keeps the SHARED base per surfaceDid (getCached
      // memoizes one object/surfaceDid) ⇒ identical grouping ⇒ byte-identical.
      const key = n.material;
      let arr = bySurf.get(key);
      if (!arr) { arr = []; bySurf.set(key, arr); }
      arr.push(n);
    } else {
      out.push(n); // LOD wrappers / unexpected nodes — keep verbatim
    }
  }
  for (const group of bySurf.values()) {
    if (group.length < 2) { out.push(...group); continue; } // nothing to batch
    const mat = group[0].material;
    let maxVerts = 0, maxIdx = 0;
    for (const m of group) {
      maxVerts += m.geometry.attributes.position.count;
      if (m.geometry.index) maxIdx += m.geometry.index.count;
    }
    let bm;
    try { bm = new THREE.BatchedMesh(group.length, maxVerts, maxIdx, mat); }
    catch (_) { out.push(...group); continue; }
    let added = 0;
    for (const m of group) {
      try {
        m.updateMatrix();
        const gid = bm.addGeometry(m.geometry);
        const iid = bm.addInstance(gid);
        bm.setMatrixAt(iid, m.matrix);
        added += 1;
      } catch (_) {
        // Geometry didn't fit this batch's layout — keep it as a standalone
        // Mesh so nothing goes invisible (fail-soft, no dropped props).
        out.push(m);
      }
    }
    if (added === 0) { try { bm.dispose(); } catch (_) {} continue; }
    // surf is no longer the map key (now material identity) — read it from the
    // group (every node in a group shares one material ⇒ one surfaceDid).
    const surf = (group[0].userData.surfaceDid >>> 0);
    const lbId = group[0].userData.landblockId;
    bm.userData = { landblockId: lbId, surfaceDid: surf, __staticBatch: true };
    bm.name = `static-batch-lb${(lbId >>> 0).toString(16)}-s${surf.toString(16).padStart(8, "0")}-x${added}`;
    // Uniform per-surface shadow flags (the per-instance distance gate is a
    // documented fidelity trade under this flag).
    bm.castShadow = !!group[0].castShadow;
    bm.receiveShadow = !!group[0].receiveShadow;
    // ?skipDeadBatch — a per-LB bucket is built once from an immutable member
    // material and is never re-fed, so there is no lifecycle to track here: the
    // decision is taken once and `cullStaticsGroup` enforces it every frame off
    // `__deadBatch`. (The cross-LB buckets DO re-derive on the optimize tick;
    // they outlive the material re-seat window, these do not — a re-bake
    // REPLACES this node outright.) `castShadow` is checked for the same reason
    // as there: the depth-only shadow pass ignores opacity.
    if (!bm.castShadow && _batchRendersNothing(mat)) {
      bm.userData.__deadBatch = true;
      bm.visible = false;
    }
    out.push(bm);
    if (outBatches) outBatches.push(bm);
  }
  return out;
}

export async function bakeStaticsForLandblock(
  scene3d,
  lbX,
  lbY,
  // FCULL (2026-06-08): the per-LB baker reads shared state (materialCache,
  // shadowsEnabled, staticsBakedLbs) directly off `scene3d`, never this bag —
  // it's a stub today (see `scene3d.staticsOpts` persist in bakeStaticsRing).
  // It is the FOURTH POSITIONAL parameter and the live caller
  // (index.js loadStaticsForLandblock) passes `this.staticsOpts` here, so it
  // can't be dropped without shifting `wasmExports`; renamed `_opts` to mark
  // it intentionally-unused while keeping the positional signature intact.
  _opts,
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
  if (scene3d.staticsBakedLbs.has(lbKey) || _staticsInFlight.has(lbKey)) {
    // Idempotent — second call for the same LB no-ops. Already-baked
    // OR currently-in-flight (a concurrent overlapping call, e.g. two
    // `handlePositionUpdate` events for the same LB) both short-circuit
    // here. The in-flight guard replaces the old pre-add to the
    // permanent set as the concurrent-dedup mechanism (A2).
    return null;
  }
  // A2 — claim the in-flight slot (NOT the permanent baked set). The
  // permanent `staticsBakedLbs.add(lbKey)` is deferred until AFTER the
  // load-bearing fetch+drain succeeds, so a fetch throw leaves the LB
  // un-baked and retryable instead of permanently stripping its statics.
  // The `finally` after the bake body releases this slot.
  _staticsInFlight.add(lbKey);
  try {

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
  // streamFix urgent lane (2026-07-02): a bake for the player's current LB
  // (or its 3×3) is player-blocking — its wasm fetches bypass the shared
  // fetch semaphore so a rapid-teleport speculative backlog from previous
  // towns can't starve the town the player is standing in (the measured
  // "by the third town nothing loads" mechanism, layer 2). Speculative
  // ring LBs keep the pre-fix normal lane. Snapshot ONCE at bake start so
  // one bake never mixes lanes mid-flight.
  const urgent = isNearPlayerLb(scene3d, lbKey);
  // A7-F1 (2026-07-11 s13): shared drained snapshot — buildings.js fetches the
  // SAME cellId. The wasm records are drained+freed once inside the shared
  // module, so `allPlacements` are plain JS records; drainPlacements' p.free()
  // guard is a harmless no-op on them and its field reads are unchanged.
  const allPlacements = await fetchLandblockObjectsShared(
    wasmExports,
    cellId,
    urgent
  );
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
  const sceneryStatics = await fetchAndDrainScenery(cellIds, wasmExports, urgent);
  // Concatenate. The merged array is the single source of truth for
  // the rest of the per-LB bake. Order is LandblockInfo first then
  // scenery — purely for log-readability; the renderer doesn't care.
  let statics = landblockInfoStatics.concat(sceneryStatics);
  // Task #7 — peel animated scenery (defaultAnimationId != 0) out of the frozen
  // instanced path so it isn't double-rendered; attachAnimatedScenery builds
  // per-part animated nodes for it. Flag-gated; when off, statics is unchanged
  // (byte-identical frozen path).
  let animatedStatics = null;
  if (animSceneryEnabled()) {
    const anim = statics.filter((p) => ((p?.defaultAnimationId >>> 0) || 0) !== 0);
    if (anim.length > 0) {
      animatedStatics = anim;
      statics = statics.filter((p) => ((p?.defaultAnimationId >>> 0) || 0) === 0);
    }
  }
  // GPU tree sway (?treeWindGpu, default-ON) + the frag suite read the descriptor
  // catalog at the frag seam below; ensure it's loaded (cached promise; the first
  // LB cold-load briefly awaits the fetch). ?visual=off or ?treeWindGpu=off skips it.
  if (windSwayGpuEnabled() && visualEnabled()) { try { await ensureVfxCatalog(); } catch (_) {} }
  // Tree wind (?treeWind) — peel allowlisted tree DIDs out of the frozen path,
  // AFTER the anim peel so the two sets are disjoint. Off ⇒ statics unchanged.
  let windTrees = null;
  // 2026-06-27 perf fix: gate the wind GEOMETRY peel on windGeoEnabled() (DEFAULT-OFF),
  // NOT visualEnabled() (default-ON). Coupling it to the visual suite de-instanced ~4096
  // Holtburg trees into ~17k individual meshes -> 1 fps / 968 ms CPU (measured, GTX 1070);
  // keeping them frozen+instanced restores 12 fps / 47 ms CPU. The frag-VFX suite stays on
  // via visualEnabled() elsewhere; ?treeWind=on or ?windGeo=on opts back into animated trees.
  if (treeWindEnabled() || windGeoEnabled()) {
    if (windGeoEnabled()) { try { await ensureVfxCatalog(); } catch (_) {} }
    const isWind = (p) => {
      const did = (p?.modelId >>> 0) || 0;
      return (treeWindEnabled() && isTreeDid(did)) ||
             (windGeoEnabled() && windResponds(vfxDescriptorFor(did)));
    };
    const t = statics.filter(isWind);
    if (t.length > 0) {
      windTrees = t;
      statics = statics.filter((p) => !isWind(p));
    }
  }
  // Phase 3 (?gemSparkle) — collect particle placements to overlay ON TOP of the
  // frozen path (non-destructive: `statics` is unchanged so the mesh still
  // renders). OFF ⇒ null.
  const particlePlacements = _collectParticlePlacements(statics, scene3d);
  // A2 — the load-bearing fetch+drain (fetch_landblock_objects +
  // fetchAndDrainScenery) has now SUCCEEDED. Mark the LB permanently
  // baked HERE (not at function entry) so a throw above this line leaves
  // the LB un-baked and retryable. An empty result is still a success —
  // mark before the `statics.length === 0` early-return so a subsequent
  // call doesn't re-fetch the empty LB. `_staticsInFlight` is released
  // in the `finally` regardless.
  scene3d.staticsBakedLbs.add(lbKey);
  if (statics.length === 0) {
    return makeEmptySummary();
  }

  // P4.3 coverage-gated peel fallback — attach the peeled wind trees HERE, BEFORE
  // the frozen build consumes `statics`, so any placement whose wind node fails to
  // build (a future fetch-not-synthesize clip miss, a build error, or the animated
  // cap) flows back into the frozen instanced path via `statics.concat(failed)`
  // instead of vanishing. On today's always-succeeds synthesis path `failed` is
  // empty ⇒ `statics` is unchanged ⇒ the frozen build is byte-identical. windTrees
  // is null whenever ?treeWind / ?visual are both off ⇒ this block is skipped on
  // the off-trace (the materialCache used by attachWindTrees was already created at
  // the head of this baker, so no ordering hazard).
  //
  // 2026-08-03 — same treatment for ANIMATED SCENERY. The peel above already
  // removed these from `statics`, so anything the animated path can't take (over
  // the ?animSceneryMax cap, a failed build, a pre-rebuild pkg) renders NOWHERE
  // unless it flows back here. Empty `failed` ⇒ statics unchanged ⇒ byte-identical.
  if (animatedStatics) {
    try {
      const { failed } = await attachAnimatedScenery(scene3d, animatedStatics, wasmExports);
      if (failed && failed.length) statics = statics.concat(failed);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[scene3d.statics] attachAnimatedScenery threw; re-freezing all animated scenery:", e);
      statics = statics.concat(animatedStatics);
    }
    animatedStatics = null; // consumed — the post-build attach below is now a no-op.
  }
  if (windTrees) {
    try {
      const { failed } = await attachWindTrees(scene3d, windTrees, wasmExports);
      if (failed && failed.length) statics = statics.concat(failed);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[scene3d.statics] attachWindTrees threw; re-freezing all wind trees:", e);
      statics = statics.concat(windTrees);
    }
    windTrees = null; // consumed — the post-build attach below is now a no-op.
  }

  const uniqueModelIds = [...new Set(statics.map((s) => s.modelId))];
  // M2 (worker-based asset bake): route the model-mesh decode through the
  // bake worker when enabled (`?bakeWorker=1`). When disabled, `mmFetch`
  // IS `wasmExports.fetch_model_meshes` (identical reference) — byte-
  // identical to pre-M2. Worker results are drop-in (same field surface).
  // streamFix urgent lane (2026-07-02): close the bake's `urgent` over the
  // fetchers so every downstream helper (primary + degraded geometry,
  // material preload) rides the same lane without signature churn.
  const mmFetchRaw = modelMeshFetcher(wasmExports);
  const spFetchRaw = surfacePixelsFetcher(wasmExports);
  const mmFetch = (ids) => mmFetchRaw(ids, urgent);
  const spFetch = (dids) => spFetchRaw(dids, urgent);
  const primary = await fetchPrimaryGeometries(uniqueModelIds, mmFetch);
  if (primary.fetchFailed) {
    // streamFix retryability (2026-07-02): the whole model-mesh batch fetch
    // THREW after the LB was already marked baked above (A2 marks after the
    // placement drain, but the geometry decode is equally load-bearing).
    // Returning an empty summary here permanently stripped every static in
    // the LB for the session. Un-mark + re-throw instead so the guard
    // cooldowns and the PVS expansion re-bakes it — identical semantics to
    // the fetchAndDrainScenery re-throw above.
    scene3d.staticsBakedLbs.delete(lbKey);
    throw new Error(
      `bakeStaticsForLandblock 0x${lbKey.toString(16)}: fetch_model_meshes batch failed; leaving LB retryable`
    );
  }
  if (primary.starvedCount > 0) {
    // streamFix retryability (2026-07-02): one or more models decoded
    // empty/partial under fetch starvation (decodeMisses>0 / missing batch
    // entry). Pre-fix these were silently dropped while the LB stayed
    // marked baked — the permanent missing-buildings/props class the
    // 12-town portal circuit reproduced. Un-mark + throw (bounded per-LB by
    // STATICS_STARVED_RETRY_CAP) so the guard cooldown + PVS re-fire retry
    // the bake once the fetch pipeline drains. No nodes were attached yet,
    // so the retry cannot duplicate scene content.
    const attempts = (_staticsStarvedRetries.get(lbKey) || 0) + 1;
    if (attempts <= STATICS_STARVED_RETRY_CAP) {
      _staticsStarvedRetries.set(lbKey, attempts);
      scene3d.staticsBakedLbs.delete(lbKey);
      throw new Error(
        `bakeStaticsForLandblock 0x${lbKey.toString(16)}: ${primary.starvedCount}/${uniqueModelIds.length} ` +
          `models decode-starved; leaving LB retryable (attempt ${attempts}/${STATICS_STARVED_RETRY_CAP})`
      );
    }
    // Cap exhausted — accept the partial bake (visible content beats a bake
    // loop on a permanently-missing record) and say so loudly.
    // eslint-disable-next-line no-console
    console.warn(
      `[geom-audit] statics 0x${lbKey.toString(16)}: accepting PARTIAL bake after ` +
        `${STATICS_STARVED_RETRY_CAP} starved retries (${primary.starvedCount} models still incomplete)`
    );
    _staticsStarvedRetries.delete(lbKey);
  } else if (_staticsStarvedRetries.has(lbKey)) {
    _staticsStarvedRetries.delete(lbKey); // clean bake — reset the budget
  }
  // A7-F2 (2026-07-11 s13): fetchDegradedGeometries (LOD-mesh batch) and the
  // per-LB materialCache.preload (surface decode) both depend only on
  // `primary`, not on each other — run them concurrently so the LOD-mesh
  // batch hides under the surface decode instead of serializing behind it.
  const [degradedGeomByModel] = await Promise.all([
    fetchDegradedGeometries(
      primary.didDegradeByModel,
      mmFetch,
      wasmExports.fetch_gfx_obj_degrade_info
    ),
    // Per-LB surface preload. The ring driver preloads ALL ring DIDs in a
    // single batch (Phase 7.2 buildings.js pattern); the lazy-add path only
    // sees this LB's DIDs so the preload is local. Self-contained IIFE so its
    // own try/catch keeps a preload failure from rejecting the Promise.all.
    (async () => {
      if (primary.allSurfaceDids.size > 0) {
        try {
          await materialCache.preload([...primary.allSurfaceDids], spFetch);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(
            "[scene3d.statics] per-LB materialCache.preload failed:",
            e
          );
        }
      }
    })(),
  ]);

  // === Per-LB instantiation — plain Mesh per placement PER SURFACE GROUP,
  //     no InstancedMesh ===
  // Document the per-LB vs ring shape divergence: this loop emits one
  // node per placement (per surface group), even when two placements in
  // the same LB share a modelId. The ring driver collapses those
  // duplicates into InstancedMesh; the per-LB lazy baker does not,
  // because the expected per-LB placement count (~5 median across the
  // 13×13 ring) makes the InstancedMesh round-trip cost higher than the
  // saved draw calls.
  //
  // RP1 (2026-06-08) — materials are resolved PER SURFACE GROUP via
  // `materialCache.getCached(group.surfaceDid)` (the buildings.js path),
  // not from a per-model dominant-surface map. A single-surface model
  // still emits one node (byte-identical to the pre-RP1 fused path); a
  // multi-surface model emits one node per surface so each polygon gets
  // its correct texture.
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
  // ?walkInInstance pass 2 only; both stay 0 on the default path, which keeps
  // every existing count (and the flag-off summary) unchanged.
  let instancedGroupCount = 0;
  let _walkInInstanceSavedNodes = 0;
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
  // ?walkInInstance (default-OFF) — pre-group this LB's placements by modelId so
  // a model placed >= 2 times here emits ONE InstancedMesh instead of N plain
  // Meshes (each of which becomes its own multiDraw range downstream). The
  // grouped models are SKIPPED by the per-placement loop below and emitted in
  // pass 2, which keeps the singleton loop's iteration order — and therefore
  // flag-off — byte-identical.
  const _walkInInstance = walkInInstanceEnabled();
  const _instanceable = new Set();
  const _placementsByModel = new Map();
  if (_walkInInstance) {
    for (const p of statics) {
      if (!primary.groupsByModel.has(p.modelId)) continue;
      let arr = _placementsByModel.get(p.modelId);
      if (!arr) { arr = []; _placementsByModel.set(p.modelId, arr); }
      arr.push(p);
    }
    for (const [modelId, group] of _placementsByModel) {
      // >= 2 mirrors the ring baker's `isInstanced` threshold (~:2723): at 1
      // placement an InstancedMesh is still 1 draw and costs an extra
      // instanceMatrix buffer, so a lone placement stays a plain Mesh.
      if (group.length >= 2) _instanceable.add(modelId);
    }
  }
  for (const placement of statics) {
    const groups = primary.groupsByModel.get(placement.modelId);
    if (!groups || groups.length === 0) {
      skippedNoMesh += 1;
      continue;
    }
    if (_instanceable.has(placement.modelId)) continue; // emitted grouped, in pass 2
    // RP1 — degraded surface groups keyed by surfaceDid for this model.
    const degradedBySurface =
      degradedGeomByModel.get(placement.modelId) || null;
    // One node per surface group. Single-surface model → one node
    // (byte-identical to the pre-RP1 fused path); multi-surface model →
    // one node per surface, each painted with its own material.
    // P1.14 — frag plan once per placement (descriptor keyed by modelId; windBend
    // MECH-A DIDs were already peeled to the wind player above, so this loop sees
    // only non-windBend placements). ?visual off / no plan ⇒ _fragMat keeps base
    // ⇒ byte-identical. One program per component-SET (every surface of this DID
    // shares the SAME setKey, so a multi-surface model adds clones, not programs).
    const fragPlan = visualEnabled() ? fragPlanForDid(placement.modelId) : null;
    for (const g of groups) {
      let mat = _fragMat(materialCache.getCached(g.surfaceDid), materialCache, g.surfaceDid, fragPlan);
      // Pair the LOD with the degraded surface group of the SAME
      // (surfaceDid, doubleSided) bucket; a group with no degraded
      // counterpart renders without an LOD wrapper (always full-detail),
      // never with a wrong texture. The composite key keeps each full
      // group bound to ITS OWN degraded geometries so a degraded geom is
      // never shared by two full groups (no LRU double-free).
      // R-JS-T4a — value is now the ORDERED band-level array for this
      // surface (one entry per degrade band), passed straight through as
      // `degradedLevels`.
      const degradedLevels =
        (degradedBySurface &&
          degradedBySurface.get(degradedSurfaceKey(g.surfaceDid, g.doubleSided))) ||
        null;
      const staticsMatCastsShadow = materialCanCastShadow(mat);
      const { node, isLod } = buildSingletonNode({
        placement,
        modelId: placement.modelId,
        surfaceDid: g.surfaceDid >>> 0,
        geom: g.geometry,
        degradedLevels,
        mat,
        staticsShadow,
        staticsMatCastsShadow,
        staticsReceiveShadow,
      });
      addedNodes.push(node);
      singletonCount += 1;
      if (isLod) lodCount += 1;
    }
    // `objectCount` counts PLACEMENTS rendered (one per placement,
    // regardless of how many surface groups it spans); `singletonCount`
    // counts NODES (≥ objectCount for multi-surface models).
    objectCount += 1;
    if (placement.source === "scenery") sceneryObjectCount += 1;
    else landblockInfoObjectCount += 1;

    // F3 time-slice: yield once the chunk has spent its frame budget.
    if (staticsTimeSlice && (performance.now() - _chunkStart) > STATICS_BUILD_BUDGET_MS) {
      await new Promise((r) => setTimeout(r, 0));
      _chunkStart = performance.now();
    }
  }

  // ?walkInInstance PASS 2 — one InstancedMesh per (model, surface) for the
  // models placed >= 2 times in this LB. Mirrors the ring baker's instanced
  // branch (~:2756); the only differences are per-LB scope:
  //   - every placement here shares ONE landblockId, so the node covers exactly
  //     one lb-key and carries `userData.landblockId` -> the EXISTING per-LB
  //     eviction walker (landblock_lru.js ~:955, "kill by userData.landblockId")
  //     removes it. The ring baker's nodes span LBs and must instead be
  //     refcounted into the LRU via `coversLbKeys`; we deliberately do NOT use
  //     that contract here, because a per-LB node needs no refcount.
  //   - nodes go into `addedNodes` (attached after the loop) rather than
  //     straight into staticsGroup, so the time-slice / prewarm cancellation
  //     guards below can still drop this LB cleanly.
  if (_walkInInstance && _instanceable.size > 0) {
    const placementMatrix = makePlacementMatrixHelper();
    for (const modelId of _instanceable) {
      const group = _placementsByModel.get(modelId);
      const surfaceGroups = primary.groupsByModel.get(modelId);
      if (!group || !surfaceGroups || surfaceGroups.length === 0) continue;
      const degradedBySurface = degradedGeomByModel.get(modelId) || null;
      const fragPlan = visualEnabled() ? fragPlanForDid(modelId) : null;
      for (const sg of surfaceGroups) {
        let mat = _fragMat(materialCache.getCached(sg.surfaceDid), materialCache, sg.surfaceDid, fragPlan);
        const staticsMatCastsShadow = materialCanCastShadow(mat);
        const degradedLevels =
          (degradedBySurface &&
            degradedBySurface.get(degradedSurfaceKey(sg.surfaceDid, sg.doubleSided))) ||
          null;
        const { node, isLod } = buildInstancedNode({
          modelId,
          surfaceDid: sg.surfaceDid >>> 0,
          group,
          geom: sg.geometry,
          degradedLevels,
          mat,
          placementMatrix,
          staticsShadow,
          staticsMatCastsShadow,
          staticsReceiveShadow,
        });
        // The per-LB eviction contract (see above). buildInstancedNode sets
        // `coversLbKeys` for the ring path's refcount; stamping landblockId
        // routes this node to the per-LB walker instead. Both leaves of an LOD
        // wrapper are covered because the walker removes the WRAPPER.
        // Read off the placement (not lbX/lbY) so it is the SAME value
        // buildSingletonNode stamps (`landblockId: placement.landblockId`) —
        // every placement in this group came from this LB's own `statics`.
        node.userData.landblockId = group[0].landblockId >>> 0;
        addedNodes.push(node);
        instancedGroupCount += 1;
        // This node replaces `group.length` plain Meshes with 1.
        _walkInInstanceSavedNodes += group.length - 1;
        if (isLod) lodCount += 1;
      }
      objectCount += group.length;
      for (const p of group) {
        if (p.source === "scenery") sceneryObjectCount += 1;
        else landblockInfoObjectCount += 1;
      }
      if (staticsTimeSlice && (performance.now() - _chunkStart) > STATICS_BUILD_BUDGET_MS) {
        await new Promise((r) => setTimeout(r, 0));
        _chunkStart = performance.now();
      }
    }
  }

  // F3 cancellation guard: if this LB was evicted while we time-sliced the
  // build, do NOT attach — evict() already cleared staticsBakedLbs[lbKey], so
  // attaching now would orphan these nodes and let a re-approach rebuild
  // duplicates. Dispose the per-LB geometries and bail. The nodes were never
  // added to the scene graph, so nothing is GPU-resident to leak.
  //
  // sealedStaticsSkip extension: a build that started BEFORE the sealed
  // purge engaged (the TN probe measured sealed detection ~5 s after
  // landing) aborts here the same way — the content is invisible under
  // sealedCull and the only exit is a portal. Clear the baked mark so a
  // future non-sealed approach rebuilds.
  //
  // 2026-08-03 — the residency re-check is UNCONDITIONAL. It used to be gated
  // on `staticsTimeSlice`, but that flag only controls the build loop's yields:
  // this baker awaits the placement drain, the animated/wind attach, the model
  // + degrade fetches, the surface preload and the prewarm regardless, so an
  // eviction can land in any of them. Under `?noStaticsTimeSlice=1` the gate
  // therefore attached a full LB the LRU had already torn down (orphans + a
  // duplicate bake on re-walk).
  const _sealedAbort = SEALED_STATICS_SKIP_ON && _sealedNow(scene3d);
  if (_sealedAbort) { try { scene3d.staticsBakedLbs.delete(lbKey); } catch (_) {} }
  if (!scene3d.staticsBakedLbs.has(lbKey) || _sealedAbort) {
    // RP1 — dispose every per-surface group geometry (full + degraded)
    // for this LB's models. groupsByModel: modelId → [{geometry,...}];
    // R-JS-T4a — degradedGeomByModel: modelId → Map<surfaceKey, [{geometry,
    // dist, degradeMode}, ...]> (one entry per degrade band), so each
    // surface value is now an array of band levels — dispose every band.
    for (const groups of primary.groupsByModel.values()) {
      for (const g of groups) { try { g?.geometry?.dispose?.(); } catch (_) {} }
    }
    for (const bySurface of degradedGeomByModel.values()) {
      for (const levels of bySurface.values()) {
        for (const lvl of levels) { try { lvl?.geometry?.dispose?.(); } catch (_) {} }
      }
    }
    return {
      ...makeEmptySummary(),
      evictedDuringBuild: true,
      disposables: { geometries: [], materials: [], textures: [] },
    };
  }
  // Problem-B — consolidate this LB's plain-Mesh singletons into per-surface
  // BatchedMeshes (no-op unless ?staticBatch=on). Fail-soft: on any error fall
  // back to the unbatched nodes so the LB still renders.
  let nodesToAdd = addedNodes;
  let staticBatchCount = 0;
  if (readStaticBatchFlag() && addedNodes.length > 1) {
    // ?statBatchChunk (default OFF, moving-A/B pending) — feed the SAME
    // >=2-per-material groups into REGION-CHUNKED (3x3-LB) per-material
    // BatchedMeshes (static_batch_x.js v2) instead of per-(LB, surface) ones.
    // consolidateStaticSingletonsCrossLb NEVER throws; it returns null when
    // nothing was consumed, in which case the unchanged per-LB path below
    // runs (no double-render window). Flag-off short-circuits to null →
    // byte-identical legacy behavior.
    const crossRes = statBatchChunkEnabled()
      ? consolidateStaticSingletonsCrossLb(addedNodes, scene3d, lbKey)
      : null;
    if (crossRes) {
      nodesToAdd = crossRes.out;
      staticBatchCount = crossRes.bucketsTouched;
    } else {
      try {
        const batches = [];
        nodesToAdd = consolidateStaticSingletons(addedNodes, batches);
        staticBatchCount = batches.length;
      } catch (e) {
        nodesToAdd = addedNodes;
        // eslint-disable-next-line no-console
        console.warn("[scene3d.statics/staticBatch] consolidation failed, using unbatched:", e);
      }
    }
  }
  // Item 4 (2026-06-22): pre-warm this LB's static/scenery nodes (per-DID material program
  // link + texture upload) in the driver background BEFORE attaching, so the first render
  // frame after attach doesn't hitch — the cost the 1070 r10 probe flagged. Unlike terrain/
  // buildings, statics time-slices its build loop and CAN be evicted across an await, so the
  // prewarm await re-checks residency afterward (mirrors the cancellation guard above).
  // `?bakePrewarm=off` skips straight to the attach. Use the post-batch `nodesToAdd`.
  if (BAKE_PREWARM && nodesToAdd.length > 0) {
    const _tmp = new THREE.Group();
    for (const n of nodesToAdd) _tmp.add(n);
    await prewarmSubtree(scene3d, _tmp);
    for (const n of [..._tmp.children]) _tmp.remove(n);
    // Unconditional — the prewarm await yields regardless of ?noStaticsTimeSlice.
    if (!scene3d.staticsBakedLbs.has(lbKey)) {
      // Evicted while the prewarm await was outstanding — dispose this LB's per-surface
      // group geometries (full + degraded) and bail without attaching (same as the
      // time-slice cancellation guard above; nodes were never added to the scene graph).
      for (const groups of primary.groupsByModel.values()) {
        for (const g of groups) { try { g?.geometry?.dispose?.(); } catch (_) {} }
      }
      for (const bySurface of degradedGeomByModel.values()) {
        for (const levels of bySurface.values()) {
          for (const lvl of levels) { try { lvl?.geometry?.dispose?.(); } catch (_) {} }
        }
      }
      return {
        ...makeEmptySummary(),
        evictedDuringBuild: true,
        disposables: { geometries: [], materials: [], textures: [] },
      };
    }
  }
  // ?statAtlas (default-ON; ?statAtlas=off escapes) — SECOND feed seam: route this LB's plain-Mesh
  // singletons (walk-in / re-entry) into the SAME global cross-LB size buckets the
  // boot ring feeds, so movement past the boot ring keeps the draw-call win. Keyed
  // on _atlasBakedLbs (hasAtlasLb), INDEPENDENT of staticsBakedLbs/step-6b. LOD /
  // transparent-without-image.data / no-uv singletons fall through to the existing
  // staticsGroup.add path. Flag-off: the whole block is skipped → byte-identical.
  if (statAtlasEnabled() && !hasAtlasLb(lbKey)) {
    try {
      const atlasable = [];
      const rest = [];
      for (const node of nodesToAdd) {
        const m = node && node.material;
        const t = m && m.map;
        const img = t && t.image;
        // !isInstancedMesh (2026-07-15, ?walkInInstance) — the atlas re-emits an
        // atlasable node as a single batched entry, so an InstancedMesh routed
        // here would lose every placement but one. Same guard, same reason, as
        // the two consolidators above.
        // X6 (2026-08-03) — accept EITHER pixel source. A BC7 map has no
        // `image.data` (bytes live in `mipmaps[0].data`), so the bare `img.data`
        // test used to route every BC7 static past the atlas as an unbatched
        // singleton on the walk-in path while the boot ring batched it fine.
        // 2026-08-05 — ask whether pixels CAN be supplied, not whether this
        // texture still carries them. Identical today (tier 1 of
        // `canSupplyPlanes` is the `img.data` test), but it is the gate that
        // decides BATCHED vs unbatched, and once the CPU copies are released
        // (task 4) an `img.data` test would answer no for everything and route
        // every static to a singleton — silently walking back into the
        // ~5,400-draw-call wall the atlas exists to remove. A frame-rate
        // regression no eye-test for blackness would ever catch, which is
        // exactly why it is changed here BEFORE anything releases anything.
        const canPixels =
          (img && img.data) || isBc7AtlasTexture(t) ||
          canSupplyPlanes(node?.material, node?.material?.userData?.surfaceDid);
        if (node && node.isMesh && !node.isInstancedMesh && !node.isBatchedMesh && !node.isLOD && node.geometry && node.geometry.attributes?.uv && t && img && canPixels && !node.userData?.__staticBatch) {
          atlasable.push(node);
        } else {
          rest.push(node);
        }
      }
      if (atlasable.length > 0) {
        const { passthrough } = addSingletonsToCrossLbAtlas(atlasable, scene3d);
        nodesToAdd = rest.concat(passthrough);
      }
    } catch (e) {
      // fail-soft: keep the unbatched nodesToAdd as-is.
      // eslint-disable-next-line no-console
      console.warn("[scene3d.statics/statAtlas per-LB] failed, adding singletons unbatched:", String(e?.message ?? e));
    }
  }
  for (const node of nodesToAdd) scene3d.staticsGroup.add(node);

  // V1 (2026-05-29) — run each scenery placement's `default_script`
  // ambient particle chain (fountains/braziers/torches). Fail-soft +
  // zero-cost when no placement carries a script (the pre-re-bake case).
  try {
    await attachStaticDefaultScripts(scene3d, statics, wasmExports);
    // (animated scenery + wind trees are attached ABOVE, before the frozen build,
    //  so an over-cap / failed build re-freezes via statics.concat(failed)
    //  instead of vanishing — P4.3 + 2026-08-03.)
    // Phase 3 — attach synthesized additive emitters to the particle
    // placements. ALL placements in THIS per-LB path share one landblock → one
    // constant owner key `static:<lbKey>` (lbKey is in scope from the bake
    // head). OFF ⇒ particlePlacements is null ⇒ skipped ⇒ byte-identical.
    if (particlePlacements) {
      await attachParticleEmitters(
        scene3d, particlePlacements, wasmExports, () => staticOwnerKeyForLb(lbKey),
        _staticParticleOpts(scene3d),
      );
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[scene3d.statics/V1] per-LB default_script attach failed:", e);
  }

  // LRU wave H4 — per-LB owned BufferGeometries. The per-LB baker doesn't
  // share a cross-LB `bakeCache` (unlike buildings.js), so every entry in
  // `groupsByModel` / `degradedGeomByModel` is owned by THIS bake call even
  // when a later LB happens to bake the same modelId. Materials are
  // cache-shared via `materialCache.getCached` → empty here.
  //
  // RP1 (2026-06-08) — a multi-surface model now owns N per-surface group
  // geometries (full) + its degraded surface-group geometries. Track EVERY
  // one so the LRU disposes each exactly once on eviction (matching the
  // singleton nodes built above, which each reference one group geometry).
  //
  // R-JS-T4a — the degraded value per surface is now an ARRAY of band
  // levels (one BufferGeometry per degrade band). Each band geometry is
  // owned once (shared by reference across all placements of the model in
  // this LB, exactly like the full geometry), so push each band's geometry
  // ONCE here → the LRU disposes each band exactly once on eviction.
  const lbDisposableGeometries = [];
  for (const groups of primary.groupsByModel.values()) {
    for (const g of groups) {
      if (g && g.geometry) lbDisposableGeometries.push(g.geometry);
    }
  }
  for (const bySurface of degradedGeomByModel.values()) {
    for (const levels of bySurface.values()) {
      for (const lvl of levels) {
        if (lvl && lvl.geometry) lbDisposableGeometries.push(lvl.geometry);
      }
    }
  }

  // Draw-call savings for the per-LB path: by default every placement becomes
  // its own draw call (plain Mesh, no instancing), so the count is identical to
  // `objectCount` and the "savings" relative to per-Mesh is zero — by design for
  // the lazy-walk path (see the comment block above).
  //
  // ?walkInInstance (2026-07-15) changes that for models placed >= 2 times in
  // this LB: each emits ONE InstancedMesh. `instancedGroupCount` is no longer
  // unconditionally 0 — it was hardcoded because this path could not produce an
  // instanced node, and a hardcoded 0 would now under-report the flag's whole
  // effect to every caller and diag that reads this summary.
  // `drawCallReductionEstimate` stays a per-node estimate: each instanced group
  // replaces `group.length` plain Meshes with 1 node.
  return {
    objectCount,
    modelCount: primary.groupsByModel.size,
    surfaceCount: primary.allSurfaceDids.size,
    skippedZeroTri: primary.skippedZeroTri,
    skippedNoMesh,
    instancedGroupCount,
    staticBatchGroupCount: staticBatchCount,
    singletonCount,
    lodCount,
    drawCallReductionEstimate: _walkInInstanceSavedNodes,
    sceneryObjectCount,
    landblockInfoObjectCount,
    disposables: {
      geometries: lbDisposableGeometries,
      materials: [],
      textures: [],
    },
  };

  } finally {
    // A2 — release the in-flight slot on EVERY exit path (success, empty
    // summary, eviction-guard return, or a throw). The permanent
    // `staticsBakedLbs` membership is what gates future calls now; the
    // in-flight Set only deduped the concurrent window.
    _staticsInFlight.delete(lbKey);
  }
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
  let statics = landblockInfoStatics.concat(sceneryStatics);
  // Task #7 — peel animated scenery (defaultAnimationId != 0) out of the frozen
  // instanced path so it isn't double-rendered; attachAnimatedScenery builds
  // per-part animated nodes for it. Flag-gated; when off, statics is unchanged
  // (byte-identical frozen path).
  let animatedStatics = null;
  if (animSceneryEnabled()) {
    const anim = statics.filter((p) => ((p?.defaultAnimationId >>> 0) || 0) !== 0);
    if (anim.length > 0) {
      animatedStatics = anim;
      statics = statics.filter((p) => ((p?.defaultAnimationId >>> 0) || 0) === 0);
    }
  }
  // GPU tree sway (?treeWindGpu, default-ON) + the frag suite read the descriptor
  // catalog at the frag seam below; ensure it's loaded (cached promise; the first
  // LB cold-load briefly awaits the fetch). ?visual=off or ?treeWindGpu=off skips it.
  if (windSwayGpuEnabled() && visualEnabled()) { try { await ensureVfxCatalog(); } catch (_) {} }
  // Tree wind (?treeWind) — peel allowlisted tree DIDs (ring path), AFTER the
  // anim peel so the sets are disjoint. Off ⇒ statics unchanged.
  let windTrees = null;
  // 2026-06-27 perf fix: gate the wind GEOMETRY peel on windGeoEnabled() (DEFAULT-OFF),
  // NOT visualEnabled() (default-ON). Coupling it to the visual suite de-instanced ~4096
  // Holtburg trees into ~17k individual meshes -> 1 fps / 968 ms CPU (measured, GTX 1070);
  // keeping them frozen+instanced restores 12 fps / 47 ms CPU. The frag-VFX suite stays on
  // via visualEnabled() elsewhere; ?treeWind=on or ?windGeo=on opts back into animated trees.
  if (treeWindEnabled() || windGeoEnabled()) {
    if (windGeoEnabled()) { try { await ensureVfxCatalog(); } catch (_) {} }
    const isWind = (p) => {
      const did = (p?.modelId >>> 0) || 0;
      return (treeWindEnabled() && isTreeDid(did)) ||
             (windGeoEnabled() && windResponds(vfxDescriptorFor(did)));
    };
    const t = statics.filter(isWind);
    if (t.length > 0) {
      windTrees = t;
      statics = statics.filter((p) => !isWind(p));
    }
  }
  // Phase 3 (?gemSparkle) — non-destructive particle collect (mesh stays frozen).
  const particlePlacements = _collectParticlePlacements(statics, scene3d);
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

  // P4.3 coverage-gated peel fallback (ring path) — attach the peeled wind trees
  // HERE, BEFORE the ring's primary-geometry fetch consumes `statics`, so any
  // placement whose wind node fails to build (a future fetch-not-synthesize clip
  // miss, a build error, or the animated cap) flows back into the frozen
  // instanced path via `statics.concat(failed)` instead of vanishing. On today's
  // always-succeeds synthesis path `failed` is empty ⇒ `statics` is unchanged ⇒
  // the frozen build is byte-identical. windTrees is null whenever ?treeWind /
  // ?visual are both off ⇒ this block is skipped on the off-trace.
  //
  // 2026-08-03 — same treatment for ANIMATED SCENERY (ring path). The peel above
  // already removed these from `statics`, so an over-cap / failed build must flow
  // back here or it renders NOWHERE. Empty `failed` ⇒ statics unchanged.
  if (animatedStatics) {
    try {
      const { failed } = await attachAnimatedScenery(scene3d, animatedStatics, wasmExports);
      if (failed && failed.length) statics = statics.concat(failed);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[scene3d.statics] ring attachAnimatedScenery threw; re-freezing all animated scenery:", e);
      statics = statics.concat(animatedStatics);
    }
    animatedStatics = null; // consumed — the post-build attach below is now a no-op.
  }
  if (windTrees) {
    try {
      const { failed } = await attachWindTrees(scene3d, windTrees, wasmExports);
      if (failed && failed.length) statics = statics.concat(failed);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[scene3d.statics] ring attachWindTrees threw; re-freezing all wind trees:", e);
      statics = statics.concat(windTrees);
    }
    windTrees = null; // consumed — the post-build attach below is now a no-op.
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
  // buildInstancedNode see `degradedLevels: null` and return the
  // primary leaf without an LOD wrapper (normalizeDegradedLevels → []).
  // Profile data 2026-05-22: this fetch accounted for 86% (341.9ms of
  // 394ms) of wire-mode statics bake on Chromium+SwiftShader.
  // Wire-agent: skip the degraded (LOD) geometry fetch entirely. In
  // wireframe rendering there's no visual difference between full-
  // detail and degraded leaves — the LOD switch only matters for
  // textured perspective at distance. Empty Map → buildSingletonNode /
  // buildInstancedNode see `degradedLevels: null` and return the
  // primary leaf without an LOD wrapper (normalizeDegradedLevels → []).
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

  // ── Stage 3: ring-wide group-by-modelId + per-surface InstancedMesh/
  //    Mesh emit ──
  // This is the divergent step vs the per-LB baker: placements
  // sharing a modelId across LBs are batched into a single
  // InstancedMesh. Singletons stay as plain Mesh.
  //
  // RP1 (2026-06-08) — for EACH model we now build one InstancedMesh
  // (or plain Mesh for singletons) PER SURFACE GROUP, each painted with
  // `materialCache.getCached(group.surfaceDid)`. A single-surface model
  // produces one node per modelId exactly as before (byte-identical); a
  // multi-surface model produces one node per surface so every polygon
  // gets its correct texture. Draw calls become O(unique model×surface),
  // still O(1) in placement count — the accepted, measured tradeoff.
  const placementsByModel = new Map();
  for (const placement of statics) {
    if (!primary.groupsByModel.has(placement.modelId)) continue;
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
  // ?statAtlas (default-ON; ?statAtlas=off escapes): collect singleton-branch nodes for texture-array
  // batching after the loop. Flag off => stays empty, singletons add directly.
  const ringSingletons = [];
  // B3 (busted-world load fix) — frame-budget the BOOT RING emit loop.
  // The per-LB baker already time-slices its singleton build (F3, the
  // `?noStaticsTimeSlice` gate); the radius-6 boot ring previously
  // emitted ALL ~130 (model×surface) InstancedMesh/Mesh groups in one
  // synchronous burst, blocking the main thread for ~hundreds of ms at
  // init (a big share of the ~25s init3D stall). Yield to a macrotask
  // once each chunk has spent ~6ms so the frame pump / entity drain can
  // run between groups. Default ON; `?staticsRingTimeSlice=off` disables.
  // setTimeout (NOT rIC/rAF — same rationale as the per-LB F3 path).
  // Headless/capture-safe: the flag read is guarded by the globalThis
  // location check (mirrors the per-LB `staticsTimeSlice` read).
  let staticsRingTimeSlice = true;
  try {
    if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.search) {
      staticsRingTimeSlice =
        new URLSearchParams(globalThis.location.search).get("staticsRingTimeSlice") !== "off";
    }
  } catch (_) {
    staticsRingTimeSlice = true;
  }
  const STATICS_BUILD_BUDGET_MS = 6;
  let _ringChunkStart = (typeof performance !== "undefined" ? performance.now() : Date.now());
  for (const [modelId, group] of placementsByModel) {
    const surfaceGroups = primary.groupsByModel.get(modelId);
    if (!surfaceGroups || surfaceGroups.length === 0) continue;
    // RP1 — degraded surface groups keyed by surfaceDid for this model.
    const degradedBySurface = degradedGeomByModel.get(modelId) || null;

    // Count scenery vs LandblockInfo placements within this model's group.
    let groupSceneryCount = 0;
    for (const p of group) {
      if (p.source === "scenery") groupSceneryCount += 1;
    }
    const groupLandblockInfoCount = group.length - groupSceneryCount;
    sceneryObjectCount += groupSceneryCount;
    landblockInfoObjectCount += groupLandblockInfoCount;

    // `objectCount` counts PLACEMENTS rendered (independent of how many
    // surface groups each model spans); `instancedGroupCount` /
    // `singletonCount` count NODES (draw calls): one per surface group.
    objectCount += group.length;

    const isInstanced = group.length >= 2;
    if (isInstanced && groupSceneryCount > 0) {
      // A model is scenery-bearing once; count it per model (not per
      // surface) so the headline metric stays comparable to pre-RP1.
      sceneryBearingInstancedGroupCount += 1;
    }

    // RP1 — one node PER SURFACE GROUP. Single-surface model → one node
    // per modelId (byte-identical to the pre-RP1 fused path).
    // P1.14 — frag plan once per model (descriptor keyed by modelId). One swap
    // covers both the InstancedMesh and Singleton branches (both read `mat`).
    // ?visual off / no plan ⇒ _fragMat keeps base ⇒ byte-identical.
    const fragPlan = visualEnabled() ? fragPlanForDid(modelId) : null;
    for (const sg of surfaceGroups) {
      let mat = _fragMat(materialCache.getCached(sg.surfaceDid), materialCache, sg.surfaceDid, fragPlan);
      const staticsMatCastsShadow = materialCanCastShadow(mat);
      // Pair the LOD with the degraded surface group of the SAME
      // (surfaceDid, doubleSided) bucket; a group with no degraded
      // counterpart renders without an LOD wrapper (never with a wrong
      // texture). The composite key binds each full group to ITS OWN
      // degraded geometries so a degraded geom is never shared by two
      // full groups → each degraded leaf is disposed exactly once on
      // LRU eviction (no double-free).
      // R-JS-T4a — value is the ORDERED band-level array for this surface
      // (one entry per degrade band), passed through as `degradedLevels`.
      const degradedLevels =
        (degradedBySurface &&
          degradedBySurface.get(degradedSurfaceKey(sg.surfaceDid, sg.doubleSided))) ||
        null;

      if (isInstanced) {
        // === InstancedMesh path ===
        // One draw call per (model, surface) PER LOD band.
        const { node, isLod } = buildInstancedNode({
          modelId,
          surfaceDid: sg.surfaceDid >>> 0,
          group,
          geom: sg.geometry,
          degradedLevels,
          mat,
          placementMatrix,
          staticsShadow,
          staticsMatCastsShadow,
          staticsReceiveShadow,
        });
        scene3d.staticsGroup.add(node);
        instancedNodes.push(node);
        instancedGroupCount += 1;
        if (isLod) lodCount += 1;
      } else {
        // === Singleton Mesh path ===
        // Only one placement; InstancedMesh has no draw-call advantage
        // over plain Mesh here (still 1 draw call) AND costs an extra
        // instanceMatrix attribute buffer. Stick with plain Mesh.
        const placement = group[0];
        const { node, isLod } = buildSingletonNode({
          placement,
          modelId,
          surfaceDid: sg.surfaceDid >>> 0,
          geom: sg.geometry,
          degradedLevels,
          mat,
          staticsShadow,
          staticsMatCastsShadow,
          staticsReceiveShadow,
        });
        if (statAtlasEnabled()) ringSingletons.push(node); // batched after the loop (perf, default-on; ?statAtlas=off escapes)
        else scene3d.staticsGroup.add(node);
        singletonCount += 1;
        if (isLod) lodCount += 1;
      }
    }

    // B3 — yield to a macrotask once this chunk has spent its frame
    // budget so the entity drain / frame pump runs between model groups
    // instead of after the entire ring's worth of nodes. Checked at the
    // end of each model iteration (group granularity) — fine-grained
    // enough at ~130 groups, and keeps each group's per-surface nodes
    // attached atomically.
    if (staticsRingTimeSlice && (
      (typeof performance !== "undefined" ? performance.now() : Date.now()) - _ringChunkStart
    ) > STATICS_BUILD_BUDGET_MS) {
      await new Promise((r) => setTimeout(r, 0));
      _ringChunkStart = (typeof performance !== "undefined" ? performance.now() : Date.now());
    }
  }
  // Wire-agent (?wireframe=1): the texture-array atlas below rejects wireframe
  // MeshBasic materials (no `.map`/image.data — static_atlas.js gate ~389), so
  // EVERY ring singleton would fall through UNBATCHED (measured live: ~4,200
  // plain Mesh draws, each then doubled by the wireFill companion pass →
  // statics node count tripled). Wireframe materials are the ~32 SHARED bucket
  // objects (materials._wireframeMaterialFor), so material-identity
  // consolidation batches them trivially — the SAME cross-LB machinery the
  // per-LB walk-in path (consolidateStaticSingletonsCrossLb) already uses in
  // wireframe. That function keys region + per-LB eviction membership off ONE
  // lbId per feed, so we must group the ring's cross-LB singletons by their
  // landblockId and feed one LB at a time (mixed-LB feeds would misattribute
  // eviction → orphaned batches). Batched nodes are BatchedMeshes → the
  // wireFill companion pass skips them (materials.js ~2213), so no fills, no
  // node explosion. Lone-by-material leftovers come back in `.out` and are
  // added as plain Meshes carrying userData.landblockId (per-LB walker evicts
  // them, exactly as today). Fail-soft: any miss adds the node unbatched.
  if (scene3d.wireframeMode && ringSingletons.length > 0) {
    try {
      const byLb = new Map();
      for (const n of ringSingletons) {
        const lbId = (n.userData?.landblockId ?? 0) >>> 0;
        let arr = byLb.get(lbId);
        if (!arr) { arr = []; byLb.set(lbId, arr); }
        arr.push(n);
      }
      let batchedGroups = 0;
      for (const [lbId, group] of byLb) {
        const res = statBatchChunkEnabled()
          ? consolidateStaticSingletonsCrossLb(group, scene3d, lbId)
          : null;
        if (res) {
          batchedGroups += res.bucketsTouched;
          for (const n of res.out) scene3d.staticsGroup.add(n);
        } else {
          // flag off, or nothing consumed for this LB — add its singletons as-is
          for (const n of group) scene3d.staticsGroup.add(n);
        }
      }
      mark(`stage3: wire ring ${ringSingletons.length} singletons -> ${batchedGroups} cross-LB wire batches (${byLb.size} LBs)`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[scene3d.statics/wireRingBatch] failed, adding singletons unbatched:", String(e?.message ?? e));
      for (const n of ringSingletons) { if (!n.parent) scene3d.staticsGroup.add(n); }
    }
  } else if (statAtlasEnabled() && ringSingletons.length > 0) {
    // ?statAtlas (default-ON; ?statAtlas=off escapes): collapse the ring's unique-material
    // singletons into GLOBAL (cross-LB) size-bucket BatchedMeshes — ~5,400 lone draws
    // -> ~20-30 multidraw calls. The bucket BatchedMeshes self-add to staticsGroup;
    // each LB's per-LB eviction is handled by scene3d._evictStaticAtlasForLb (installed
    // by addSingletonsToCrossLbAtlas). Fail-soft: on error add the singletons unbatched.
    try {
      const { passthrough } = addSingletonsToCrossLbAtlas(ringSingletons, scene3d);
      for (const n of passthrough) scene3d.staticsGroup.add(n);
      mark(`stage3: statAtlas ${ringSingletons.length} singletons -> cross-LB buckets + ${passthrough.length} passthrough`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[scene3d.statics/statAtlas] failed, adding singletons unbatched:", String(e?.message ?? e));
      for (const n of ringSingletons) scene3d.staticsGroup.add(n);
    }
  }
  // (statAtlas off, non-wire: ringSingletons is never populated — line ~2738
  //  adds those nodes inline during the build loop — so no trailing branch.)
  mark(`stage3: build+add ${placementsByModel.size} groups (inst=${instancedGroupCount}, single=${singletonCount})`);

  // V1 (2026-05-29) — run each scenery placement's `default_script`
  // ambient particle chain (fountains/braziers/torches). Runs over the
  // full ring `statics` stream so an InstancedMesh-collapsed scripted
  // model still gets one anchor PER placement. Fail-soft + zero-cost
  // when no placement carries a script (the pre-re-bake case).
  try {
    await attachStaticDefaultScripts(scene3d, statics, wasmExports);
    // (animated scenery + wind trees are attached ABOVE, before the frozen build,
    //  so an over-cap / failed build re-freezes via statics.concat(failed)
    //  instead of vanishing — P4.3 + 2026-08-03.)
    // Phase 3 — the ring path spans MANY landblocks, so key each emitter to
    // ITS placement's landblock: owner `static:<lbKey(p)>`. Each LB's emitters
    // then tear down independently when THAT LB evicts. OFF ⇒ null ⇒ skipped ⇒
    // byte-identical. (lbKeyOf == lbSetKey == the LRU evict key: mask 0xffff0000.)
    if (particlePlacements) {
      await attachParticleEmitters(
        scene3d, particlePlacements, wasmExports,
        (p) => staticOwnerKeyForLb(p.landblockId),
        _staticParticleOpts(scene3d),
      );
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[scene3d.statics/V1] ring default_script attach failed:", e);
  }
  mark("stage3: attachStaticDefaultScripts (V1)");

  // Count placements that had no geometry (the model failed to fetch
  // OR was 0-tri AND got dropped from `groupsByModel`). The
  // `skippedZeroTri` count is per-model; `skippedNoMesh` here is
  // per-placement of models we couldn't render. Per-LB break-out is
  // accumulated alongside so the [phase7.2] statics log can name the
  // landblocks losing placements (ring-wide aggregate alone hides
  // which LB regressed).
  const skippedNoMeshByLb = new Map();
  for (const placement of statics) {
    if (!primary.groupsByModel.has(placement.modelId)) {
      skippedNoMesh += 1;
      const lb = placement.landblockId;
      if (lb != null) {
        skippedNoMeshByLb.set(lb, (skippedNoMeshByLb.get(lb) || 0) + 1);
      }
    }
  }

  // Draw-call savings: a full per-placement Mesh path would have produced
  // `objectCount × (avg surfaces/model)` draw calls. Instancing collapses
  // each multi-instance (model, surface) to 1 node. Singletons remain 1
  // node per surface. So the post-fix draw call count for statics is
  // `instancedGroupCount + singletonCount` (both now count NODES — one per
  // (model, surface) — RP1 2026-06-08, was per-model pre-RP1). The
  // estimate is `objectCount − nodeCount`; for single-surface-dominated
  // rings this is unchanged from pre-RP1, and it shrinks (fewer collapsed
  // calls) in proportion to the share of multi-surface models — the
  // accepted, measured tradeoff for correct per-polygon textures.
  const drawCallReductionEstimate =
    objectCount - (instancedGroupCount + singletonCount);

  return {
    objectCount,
    modelCount: primary.groupsByModel.size,
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
// buildHoltburgStatics() retired (spawn-driven-boot): the Holtburg-centred
// back-compat wrapper is gone. Statics stream per-LB via loadStaticsForLandblock;
// bakeStaticsRing remains exported for any explicit-centre caller (tests/captures).

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

// ── #14 — LOD band hit/miss telemetry (?lodBandDiag=on, default OFF) ──
//
// The explicit-band reader (`ui/ac_lod.js pickDegradeBand`, which fires
// the diag `onBandHit/onBandMiss` counters) has NO callers — statics do
// their LOD via `THREE.LOD`, whose `.update(camera)` picks the active
// level internally at render each frame. So without an observer the
// band counters never move. This walk OBSERVES that render-time
// selection and drives the counters, emitting ONLY on a level
// TRANSITION (not every frame) so the counts are meaningful event
// tallies rather than frame-rate noise.
//
// Mapping to the ac_lod band semantics: active level 0 is the
// full-detail leaf (nearest LOD band = "no degrade applied") → a
// bandMiss; any active level > 0 is a degraded band → a bandHit.
//
// Cost discipline: `window.__diag` is installed EAGERLY+UNCONDITIONALLY
// at boot (index.js installDiag), so its mere presence is NOT a gate.
// This surface is measurement-only telemetry (for the outdoor-run band
// analysis), so it sits behind a default-OFF url flag `?lodBandDiag=on`
// cached in a lazy module flag — when unarmed (the production default)
// `tickLodBandDiag` returns on its first line and the per-frame statics
// walk is byte-identical to before (mirrors `_renderDiagArmed`).
let _lodBandDiagArmed;
function _lodBandDiagEnabled() {
  if (_lodBandDiagArmed === undefined) {
    try {
      _lodBandDiagArmed =
        typeof globalThis !== "undefined" &&
        /(?:^|[?&])lodBandDiag=(on|1|true|yes)(?:&|$)/i.test(
          globalThis.location?.search || ""
        );
    } catch (_) {
      _lodBandDiagArmed = false;
    }
  }
  return _lodBandDiagArmed;
}
const _lodDiagCamWorld = new THREE.Vector3();
const _lodDiagNodeWorld = new THREE.Vector3();

/**
 * Observe THREE.LOD active-level transitions across the statics group
 * and drive the diag band counters (diag/lod.js). No-op unless armed by
 * `?lodBandDiag=on`. Returns the number of transitions emitted this call
 * (for tests).
 */
export function tickLodBandDiag(scene3d) {
  if (!_lodBandDiagEnabled()) return 0;
  const diagLod =
    typeof window !== "undefined" ? window.__diag?.lod : null;
  if (!diagLod || !scene3d || !scene3d.staticsGroup) return 0;
  const children = scene3d.staticsGroup.children;
  if (!children || children.length === 0) return 0;

  const camera =
    scene3d.cameraSwitcher?.activeCamera ?? scene3d.camera ?? null;
  let camWorld = null;
  if (camera) {
    camera.getWorldPosition(_lodDiagCamWorld);
    camWorld = _lodDiagCamWorld;
  }

  let emitted = 0;
  for (const child of children) {
    if (!child || !child.isLOD) continue;
    const lvls = child.levels;
    if (!Array.isArray(lvls) || lvls.length < 2) continue;
    // Active level = the first visible leaf. `THREE.LOD.update()`
    // toggles `levels[i].object.visible`; reading it is version-robust
    // (matches the billboard tick) and needs no private `_currentLevel`.
    let active = -1;
    for (let i = 0; i < lvls.length; i++) {
      const o = lvls[i] && lvls[i].object;
      if (o && o.visible !== false) { active = i; break; }
    }
    if (active < 0) continue;
    const prev = child.userData.__lodBandPrev;
    if (prev === active) continue; // steady state — no event.
    child.userData.__lodBandPrev = active;
    emitted += 1;

    let dist = 0;
    if (camWorld) {
      dist = child
        .getWorldPosition(_lodDiagNodeWorld)
        .distanceTo(camWorld);
    }
    const meta = {
      degradeId: child.userData.modelId ?? 0,
      distance: dist,
      gfxObjId: child.userData.modelId ?? 0,
      bandCount: lvls.length,
    };
    if (active > 0) diagLod.onBandHit(meta);
    else diagLod.onBandMiss(meta);
  }
  return emitted;
}

// ── FCULL — per-node frustum + distance render cull (2026-06-08) ──────
//
// Walks `scene3d.staticsGroup.children` once per frame and gates each
// node's `.visible` against the AC-space FrustumCuller. Statics are
// immobile, so each node's cull sphere is computed ONCE (lazily, cached on
// `node.userData._cullSphere`) and reused every frame — zero per-frame
// allocation in the hot path (one reused scratch sphere is only used during
// the one-time build, not per frame).
//
// COHERENT-BY-CONSTRUCTION multi-surface culling: a multi-surface model
// emits one node per (modelId, surface) — but every such node covers the
// SAME placement set (singleton) or the SAME instance matrices (instanced),
// so they all carry identical bounds and therefore flip `.visible` together
// on the same frustum/distance decision. No explicit per-modelId grouping
// is needed; testing each node independently yields the unit behaviour.
//
// INSTANCEDMESH CAVEAT: `frustumCulled=false` was set on every instanced
// leaf at bake (so three's broken single-instance test is off); here we use
// the AGGREGATE `node.boundingSphere` (computed from the instance matrices)
// as the cull sphere, so scattered instances are never wrongly culled.
//
// We only gate per-OBJECT `.visible` INSIDE the already-visible
// `staticsGroup`; we never touch the group flag (that's the wasm cell-
// visibility BFS's job).

// Reused scratch — only touched during the one-time per-node sphere BUILD,
// never per frame after the cache is warm. Kept module-scoped so even the
// cold path allocates nothing.
const _cullCenterScratch = new THREE.Vector3();

/**
 * Resolve (and cache) the AC-local cull sphere for one statics node.
 * Returns a THREE.Sphere in AC coords, or `null` when bounds can't be
 * derived (caller treats null as "leave visible").
 *
 * - InstancedMesh: the aggregate `boundingSphere` (already AC-local — the
 *   node has identity local transform and the instance matrices bake AC
 *   world coords). Recomputed if absent.
 * - LOD wrapper: the LOD node's AC-local position (its children sit at
 *   LOD-local origin) + the largest level geometry's bounding radius,
 *   scaled by the node scale. For instanced-LOD, the inner level's
 *   aggregate `boundingSphere` radius is used (it already spans instances).
 * - plain Mesh (singleton): the node position (AC-local) + the geometry
 *   bounding radius × node scale.
 */
function _resolveStaticCullSphere(node) {
  const cached = node.userData && node.userData._cullSphere;
  if (cached) return cached;

  let sphere = null;
  if (node.isInstancedMesh) {
    if (!node.boundingSphere) {
      try {
        node.computeBoundingSphere();
      } catch (_) {
        /* fall through to null */
      }
    }
    if (node.boundingSphere) {
      sphere = node.boundingSphere.clone();
    }
  } else if (node.isLOD) {
    // Largest-radius level decides the cull bound (conservative — keep the
    // node visible if ANY level would be on-screen). LOD children are at
    // local origin; the LOD node itself carries the AC placement.
    const lvls = node.levels;
    let bestR = 0;
    if (Array.isArray(lvls)) {
      for (const lvl of lvls) {
        const obj = lvl && lvl.object;
        if (!obj) continue;
        if (obj.isInstancedMesh) {
          if (!obj.boundingSphere) {
            try {
              obj.computeBoundingSphere();
            } catch (_) {}
          }
          // Instanced-LOD: the inner sphere already spans the instances in
          // the node's local frame; its radius + |center| bounds the lot.
          if (obj.boundingSphere) {
            const bs = obj.boundingSphere;
            const r = bs.radius + bs.center.length();
            if (r > bestR) bestR = r;
          }
        } else if (obj.geometry) {
          if (!obj.geometry.boundingSphere) {
            try {
              obj.geometry.computeBoundingSphere();
            } catch (_) {}
          }
          // Use the rotation/offset-invariant bound (radius + |center|) so a
          // LOD level whose geometry sphere is offset from the local origin
          // (e.g. a tall model whose origin sits at its base) is fully
          // contained by a sphere centred at node.position — mirrors the
          // instanced-LOD sub-case above. Dropping |center| here would let
          // the cull sphere miss the geometry's top and pop at the frustum
          // edge.
          const bs = obj.geometry.boundingSphere;
          if (bs) {
            const r = bs.radius + bs.center.length();
            if (r > bestR) bestR = r;
          }
        }
      }
    }
    const sx = Math.abs(node.scale?.x ?? 1);
    const sy = Math.abs(node.scale?.y ?? 1);
    const sz = Math.abs(node.scale?.z ?? 1);
    const maxScale = Math.max(sx, sy, sz, 1e-6);
    _cullCenterScratch.copy(node.position || _cullCenterScratch.set(0, 0, 0));
    sphere = new THREE.Sphere(_cullCenterScratch.clone(), bestR * maxScale);
  } else if (node.isMesh && node.geometry) {
    if (!node.geometry.boundingSphere) {
      try {
        node.geometry.computeBoundingSphere();
      } catch (_) {}
    }
    const bs = node.geometry.boundingSphere;
    if (bs) {
      const sx = Math.abs(node.scale?.x ?? 1);
      const sy = Math.abs(node.scale?.y ?? 1);
      const sz = Math.abs(node.scale?.z ?? 1);
      const maxScale = Math.max(sx, sy, sz, 1e-6);
      // Rotation-invariant bound: centre the cull sphere at node.position
      // (the AC placement) and inflate the radius by the scaled geometry
      // sphere offset (|center|). Singleton statics carry a real yaw
      // (mesh.quaternion, statics.js:799); translating the center by an
      // un-rotated bs.center would mis-place the sphere for horizontally
      // asymmetric geometry, so we fold |center| into the radius instead —
      // this always contains the geometry under any rotation.
      _cullCenterScratch.copy(node.position || _cullCenterScratch.set(0, 0, 0));
      sphere = new THREE.Sphere(
        _cullCenterScratch.clone(),
        (bs.radius + bs.center.length()) * maxScale
      );
    }
  }

  if (sphere) {
    node.userData = node.userData || {};
    node.userData._cullSphere = sphere;
  }
  return sphere;
}

/**
 * True when a statics node owns an active SetupModel SetLight (lighting.js
 * parents the THREE light as a direct child of the static's mesh — see
 * lighting.js recordStatics / the `object3D.add(inst)` attach). Culling such
 * a node (`node.visible = false`) makes THREE's projectObject skip the whole
 * subtree, extinguishing the light — a lighting pop at the frustum edge for a
 * lamp/brazier just off-screen that still illuminates on-screen geometry.
 * We therefore exempt light-bearing nodes from culling (conservative: keep
 * them rendered). Result is cached on userData and re-derived only when the
 * node's child count changes (lights are attached AFTER node creation, so the
 * cache must invalidate when a light is added/removed). Zero allocation.
 */
function _staticOwnsLight(node) {
  const kids = node.children;
  const n = kids ? kids.length : 0;
  const ud = node.userData || (node.userData = {});
  if (ud._lightScanCount === n) return ud._ownsLight === true;
  ud._lightScanCount = n;
  let owns = false;
  for (let i = 0; i < n; i++) {
    const c = kids[i];
    if (c && c.isLight) {
      owns = true;
      break;
    }
  }
  ud._ownsLight = owns;
  return owns;
}

/**
 * Per-frame statics cull. `culler` is the shared FrustumCuller (already
 * `.update()`d this frame by loop.js). Fail-soft: missing group / camera /
 * sphere → leave nodes visible. Returns `{ tested, culled }` for diag.
 */
export function cullStaticsGroup(scene3d, culler) {
  const group = scene3d?.staticsGroup;
  if (!group || !culler || !culler.valid) return { tested: 0, culled: 0 };
  const children = group.children;
  if (!children || children.length === 0) return { tested: 0, culled: 0 };

  // Hoist the horizon sqrt out of the per-node loop (was recomputed per node
  // per frame). `cullHorizon` is the metre horizon; the per-node test only
  // needs to add the sphere radius to it.
  const distEnabled = CULL_DIST_SQ !== Infinity;
  const cullHorizon = distEnabled ? Math.sqrt(CULL_DIST_SQ) : 0;

  let tested = 0;
  let culled = 0;
  for (const node of children) {
    if (!node) continue;
    // RP6 owns particle visibility — this pass must not be a second writer.
    // `_staticParticleManager` is built with `scene: staticsGroup`, so
    // emitParticle() adds every per-slot particle mesh as a DIRECT CHILD here,
    // and the `node.visible = want` below would compete with RP6's own cull
    // (particles/particle_manager.js tick). RP6 wins on paper and loses in
    // practice: it culls per EMITTER on a TRANSITION, from its own rAF
    // (`_spLoop`) every `_RP6.recheckInterval` ticks, while this pass rewrites
    // `visible` EVERY frame from tickPerFrame. So a particle whose emitter RP6
    // culled gets resurrected on the next frame by a plain frustum "want=true"
    // — measured 140 of 152 drawn particles (92%) at a settled Cragstone.
    // The two tests are not equivalent and this one cannot stand in: RP6 also
    // applies a distance cap (`_RP6.maxDistance`) that this pass does not
    // (`CULL_DIST_SQ` is Infinity unless ?cullDist=N), which is exactly the
    // population that leaks — in frustum, far past the cap, frozen mid-air.
    // Skipping BEFORE `tested` also keeps the diag counts about real statics,
    // consistent with the census particle fix (de24059d).
    const ud = node.userData;
    if (ud && (ud.__particle === true || ud.isParticleInstanced === true)) continue;
    // BatchedMesh statics (static-batch consolidation, stat-atlas buckets)
    // sit at the group origin with their placements in per-instance matrices,
    // so the isMesh sphere derivation below would center the cull sphere at
    // (0,0,0) — tens of km from any player — and the whole batch is
    // permanently out-of-frustum (the 2026-07-02 vanished-forests bug).
    // BatchedMesh already frustum-culls per instance at draw time (r184
    // perObjectFrustumCulled, default true), so node-level culling adds
    // nothing — keep the node visible and let the batch cull itself.
    if (node.isBatchedMesh) {
      // ?skipDeadBatch (2026-08-06) — EXCEPT a bucket already proven incapable
      // of putting a pixel on screen. The unconditional restore below is what
      // makes this pass the only per-frame writer of BatchedMesh visibility;
      // that is a feature (see the RP6 particle note above — two writers of
      // `.visible` is the recurring bug), so the hide is expressed as a marker
      // this pass HONOURS rather than as a competing write that would survive
      // exactly one frame. `__deadBatch` is only ever set by the batchers'
      // `materialRendersNothing` proof and is re-derived on the ~10 Hz optimize
      // tick, so a bucket that stops qualifying clears it and lands back on the
      // restore path below.
      if (ud && ud.__deadBatch === true) {
        if (node.visible !== false) node.visible = false;
        continue;
      }
      if (node.visible === false) node.visible = true;
      continue;
    }
    const sphere = _resolveStaticCullSphere(node);
    if (!sphere) {
      // No derivable bounds — never hide (fail-open).
      if (node.visible === false) node.visible = true;
      continue;
    }
    // GUARDRAIL: never cull a node that owns an active SetLight — hiding it
    // would extinguish the light and pop on-screen illumination.
    if (_staticOwnsLight(node)) {
      if (node.visible === false) node.visible = true;
      continue;
    }
    tested += 1;
    let want = culler.isSphereInFrustum(sphere);
    // Distance horizon (conservative; disabled by default — Infinity unless
    // ?cullDist=N opts in).
    if (want && distEnabled) {
      const c = sphere.center;
      const distSq = culler.getDistanceSq(c.x, c.y, c.z);
      // Add the sphere radius to the horizon so a large node straddling the
      // boundary isn't clipped at its near edge: (cullHorizon + r)².
      const r = sphere.radius;
      const padded = cullHorizon + r;
      if (distSq > padded * padded) {
        want = false;
      }
    }
    if (node.visible !== want) {
      node.visible = want;
      if (!want) culled += 1;
    } else if (!want) {
      culled += 1;
    }
  }
  return { tested, culled };
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

// A11-S2 (unification survey 2026-06-11): `?particleOwner=on` routes static
// emitter lifecycle through the shared owner facade — one owner key per
// script anchor (`"static:<n>"`), single `destroyAllForOwner` teardown
// instead of the whole-table nuke in `disposeStaticParticles`. Off-path =
// the legacy unscoped manager table, byte-identical.
import { ownerRegistry, particleOwnerOn } from "./particles/owner_registry.js";
let _staticOwnerSeq = 0;
// CreateParticle hook types (mirrors entities.js `_attachParticleChainForEntity`).
const STATIC_HOOK_CREATE_PARTICLE = 13;
const STATIC_HOOK_CREATE_BLOCKING_PARTICLE = 26;

// CallPES (2026-06-23) — hook type 19. Retail re-plays a PhysicsScript after a
// random [0, pause]s delay (CPhysicsObj::CallPES, acclient.c:318973-319000 →
// play_script_internal). This is the LOOP that keeps ambient swarms
// (butterflies/insects) refreshing: e.g. script 0x33000455 is
// `CreateParticle(Swarm 0x320002b5, finite total=60) + CallPES(self, pause=35)`,
// so without this arm the swarm bursts once at LB-load and never returns.
// The static walker had explicitly skipped CallPES as "entity-targeted"
// (header note above) — that was wrong for self-looping scenery scripts.
const STATIC_HOOK_CALL_PES = 19;
// Cross-reference (callPesDid !== own scriptId) recursion cap — mirrors
// entities.js MAX_CALL_PES_DEPTH. A SELF-reference (the ambient loop) is NOT
// depth-capped (retail loops it forever via the re-added FPHook); it is bounded
// instead by anchor liveness (anchor.parent) + `_spDisposed` + the cancel set.
const STATIC_MAX_CALL_PES_DEPTH = 3;
// Pending CallPES re-run timers, so disposeStaticParticles can cancel a
// still-pending loop (a 0–35s window can outlive a teardown). Module-level,
// consistent with `_spRafId`/`_spDisposed` below.
const _staticCallPesTimeouts = new Set();
// `?staticCallPes=off` disables ONLY the CallPES re-play loop (default on),
// while keeping the one-shot CreateParticle emitters. Lets the 1070 A/B isolate
// the loop (timers + repeated finite-swarm re-spawns) from the base emitter
// render. The whole static-script system still has the coarser
// `?staticScripts=off`. Read once at module load.
const STATIC_CALL_PES_ON = (() => {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      return new URLSearchParams(globalThis.location.search)
        .get("staticCallPes")?.toLowerCase() !== "off";
    }
  } catch (_) {}
  return true;
})();

// Perf (2026-07-08) — time-slice the default_script ambient-emitter attach.
// A dense town has hundreds of scripted statics per landblock (torches /
// braziers / fountains); building their emitter chains ran as ONE macrotask
// (the per-emitter `await` only yields microtasks, which don't let the browser
// render or process input), so arriving at a town froze the main thread ~2 s
// (a battery measured Linvak Tukal/Fiun/Lytelthorpe ~57k static nodes → ~1.9 s
// teleport freeze). When on, the attach loop yields a macrotask whenever a
// synchronous chunk exceeds STATIC_SCRIPT_SLICE_MS, spreading the emitters
// across frames — same content, no freeze. `?staticScriptSlice=off` reverts.
const STATIC_SCRIPT_SLICE_ON = (() => {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      // P4/A03-F6: honor all three OFF spellings (docs promised 0/false;
      // the reader only matched "off" — probes using =0 silently ran ON).
      const v = new URLSearchParams(globalThis.location.search)
        .get("staticScriptSlice")?.toLowerCase();
      return !(v === "off" || v === "0" || v === "false");
    }
  } catch (_) {}
  return true;
})();

// sealedStaticsSkip (2026-07-11, TN portal-entry probe campaign): while the
// player is inside a SEALED dungeon (cells.js `_sealedEvictLbKey` nonzero —
// same signal the sealed purge keys on), every outdoor statics build is
// invisible (`sealedCull` hides staticsGroup) and the only exit is a portal
// (a sealed dungeon has no mouth), so the arrival LB streams its own ring
// fresh. Skipping the build entirely removes a measured ~2,500-child
// mountain-wall/ocean-skirt scenery build (plus its script-anchor attach
// chain) that landed on the main thread right when the player wants chat
// input at Town Network. Skipped LBs are NOT marked baked, so any future
// non-sealed approach builds normally. `?sealedStaticsSkip=off|0|false`
// escapes.
export const SEALED_STATICS_SKIP_ON = (() => {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      const v = new URLSearchParams(globalThis.location.search)
        .get("sealedStaticsSkip")?.toLowerCase();
      return !(v === "off" || v === "0" || v === "false");
    }
  } catch (_) {}
  return true;
})();
const _sealedNow = (scene3d) => {
  try { return !!scene3d?._sealedEvictLbKey; } catch (_) { return false; }
};
const STATIC_SCRIPT_SLICE_MS = 6;

// Survey A11-S0 (2026-06-11): `?blockingParticleParity` — DEFAULT-ON
// (`!== "off"` reader; `=off` restores replace semantics).
// When on, hook 26 (CreateBlockingParticle) takes retail blocking
// semantics (acclient.c:329528-329565: no-replace if emitter id already
// live). Mirrors entities.js BLOCKING_PARTICLE_PARITY_ON. Note: the
// statics walker auto-assigns emitter ids (it never passes an explicit
// `emitterId`), so blocking is observationally inert here today; routed
// for cross-walker consistency so a future explicit-id static can't
// silently take replace semantics.
function _blockingParticleParityOn() {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      return (
        new URLSearchParams(globalThis.location.search)
          .get("blockingParticleParity")?.toLowerCase() !== "off"
      );
    }
  } catch (_) {}
  return false;
}

// `?indoorParticleLayer=off` (2026-08-04) — DEFAULT ON. Interior-anchored
// static particle chains are emitted onto the INDOOR render layer (1) so they
// composite with the interior pass instead of the world pass. Outdoor chains
// are untouched (layer 0), which is what keeps torches/swamp mist from bleeding
// through a punched doorway — the defect that kept the previous per-tick
// staticsGroup sweep (retired with this change) default-OFF.
//
// NOTE the `search || ""`: this reader must NOT be gated on a NON-EMPTY
// `location.search` the way `_blockingParticleParityOn` above is. That shape
// returns false on a bare URL — the opposite of its documented default — and
// statics.js:4171-4174 already carries a workaround for the same bug in
// `particleOwnerOn()`. A default-ON escape hatch has to read ON when the query
// string is absent, which is the production case.
function _indoorParticleLayerEnabled() {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location) {
      return (
        new URLSearchParams(globalThis.location.search || "")
          .get("indoorParticleLayer")?.toLowerCase() !== "off"
      );
    }
  } catch (_) {}
  return true;
}

/** The INDOOR render layer (cells.js `RENDER_LAYER_INDOOR`). */
const _RENDER_LAYER_INDOOR = 1;

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

// Statics-node leak fix (2026-07-07): default_script ambient emitters
// (braziers/torches/fountains/gemSparkle) registered their staticsGroup
// billboards under a per-anchor monotonic owner key `static:<seq>`, which the
// per-LB teardown `_evictStaticParticlesForLb` (owner `static:<lbKey>`) could
// never match — so the billboards leaked as you roamed (measured: staticsGroup
// grew 573 -> ~114k nodes, cull 1 -> 25 ms/frame, teleport freeze 150 ms -> 5 s).
// Default ON keys them by landblock via `staticOwnerKeyForLb(landblockId)` — the
// same contract the sibling `attachParticleEmitters` seam already uses — so LB
// eviction reaps them through the tested `destroyAllForOwner` path (which routes
// each billboard through `destroyParticleEmitter`, correctly disposing the
// per-slot material + syncing the particle table; a raw `staticsGroup.remove`
// would leak both). `?staticParticleEvict=off` reverts to the old seq key.
function _staticParticleEvictEnabled() {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      return (
        new URLSearchParams(globalThis.location.search).get(
          "staticParticleEvict"
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
  if (scene3d._staticParticleManager) { _staticParticleMgrRef = scene3d._staticParticleManager; return scene3d._staticParticleManager; }
  // Phase 3 — expose the per-LB particle evictor on scene3d so landblock_lru
  // (same object as `this.scene3d`, a zero-import leaf) can tear down THIS LB's
  // synthesized emitters on eviction. Mirrors spawns.js `_evictSpawnsInjectedLb`
  // (spawns.js:508). Persistent (totalSeconds:0) emitters never auto-finish and
  // the RP6 220m cull only stops DRAWING them — without this they leak per LB.
  // Idempotent assignment. Owner-scoped teardown holds while the emitters are
  // registered in ownerRegistry — i.e. when `particleOwnerOn()` OR (for static
  // default_script emitters) `_staticParticleEvictEnabled()` is on (the gate in
  // `_runStaticParticleChain`). Not literally flag-independent, but default-on.
  if (scene3d._evictStaticParticlesForLb !== _evictStaticParticlesForLb) {
    scene3d._evictStaticParticlesForLb = _evictStaticParticlesForLb;
  }
  if (
    !wasmExports ||
    typeof wasmExports.fetchBuildingPlacement !== "function" ||
    typeof wasmExports.fetch_surfaces_pixels !== "function"
  ) {
    return null;
  }
  // Phase 9a warm-park: expose the anchor-driven emitter rebuild for
  // landblock_lru.unpark() (zero-import leaf — same facade pattern as the
  // evictor above). Installed only past the wasm check: the rebuild replays
  // `_runStaticParticleChain`, which needs live wasm fetchers. Idempotent.
  if (typeof scene3d._rebuildStaticParticlesForAnchors !== "function") {
    scene3d._rebuildStaticParticlesForAnchors = (anchors) =>
      rebuildStaticScriptEmittersForAnchors(scene3d, anchors, wasmExports);
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
    // ?particleInstancing=on (default OFF) — collapse this manager's additive
    // default_script billboards (fountains/braziers/torches) to 1 draw per
    // emitter. Measured ~627 of 808 draws/frame at Cragstone. Still gated by
    // the URL flag inside ParticleManager, so OFF ⇒ byte-identical.
    instancing: true,
    geometryFactory: async (hwGfxObjId) => {
      const r = await resolveGfxObj(hwGfxObjId);
      return r?.geometry ?? null;
    },
    // Retail deg_mode facing (2026-07-28) — hw GfxObj → did_degrade chain DID
    // for the particle billboard-mode resolve (particle_manager.js
    // `_billboardModeFor`). Cached per-gfxobj manager-side, so this runs once
    // per unique particle gfxobj per session. Uses the byte-level
    // `fetchModelDidDegrades` export: the `fetchBuildingPlacement` ModelMesh
    // does NOT populate `.didDegrade` (verified live 2026-07-28 — 0 for
    // 0x010016FD whose DAT record carries chain 0x11000126). Typeof-guarded:
    // a stale bundle resolves 0 → facing soft-off.
    degradeInfoFactory: async (hwGfxObjId) => {
      if (typeof wasmExports?.fetchModelDidDegrades !== "function") return 0;
      const r = await wasmExports.fetchModelDidDegrades(new Uint32Array([hwGfxObjId >>> 0]));
      return (r && r[0]) >>> 0;
    },
    materialFactory: async (hwGfxObjId) => {
      if (!materialCache) return null;
      const r = await resolveGfxObj(hwGfxObjId);
      if (!r?.surfaceDid) return null;
      try {
        // 2026-06-20 ParticleViewer parity: UNLIT scenery-particle billboard
        // (texture × opacity, additive/alpha from the surface flag), NOT the
        // lit MeshStandard entity path. `?particleUnlit=off` → legacy lit.
        return await materialCache.getParticleUnlit(r.surfaceDid, surfacePixelsFetcher(wasmExports));
      } catch (_) {
        return null;
      }
    },
  });
  _staticParticleMgrRef = scene3d._staticParticleManager; // decouple the tick driver from the scene-facade
  return scene3d._staticParticleManager;
}

// Reusable scratch frame for the per-emitter parentOffset (mirrors the
// entity walker's `_particleAttachScratch*`). The chain runs serially
// per anchor (each `addEmitter` is awaited before the next), so reuse
// across one anchor's hooks is safe.
const _staticOffsetVec3 = new THREE.Vector3();
const _staticOffsetQuat = new THREE.Quaternion();

/**
 * CallPES (hook 19) arm for the static script walker (2026-06-23). Decodes the
 * sub-script DID + pause from the entry's raw `hookData` (PhysicsScriptEntryJs
 * exposes no callPes getters, so we read the bytes exactly like the entity
 * walker does — entities.js:9184-9185: callPesDid = u32 LE @[0..4], callPesPause
 * = f32 LE @[4..8]) and schedules a re-run of `_runStaticParticleChain` on that
 * sub-script after a retail-style random [0, pause]s jitter (+ the hook's own
 * start_time). This is what makes finite ambient swarms (e.g. 0x33000455 →
 * Swarm 0x320002b5, total=60) refresh instead of bursting once at LB-load.
 *
 * SELF-reference (callPesDid === scriptId) is the perpetual ambient loop and is
 * NOT depth-capped (retail re-adds it forever); it is bounded instead by anchor
 * liveness + `_spDisposed` + the cancel set. CROSS-reference is capped at
 * STATIC_MAX_CALL_PES_DEPTH to stop a cyclic script graph from spawn-storming.
 * The timer is tracked in `_staticCallPesTimeouts` so disposeStaticParticles
 * can cancel a still-pending loop. No-op in non-browser contexts (tests).
 */
function _scheduleStaticCallPes(manager, anchor, scriptId, entry, wasmExports, ownerKey, depth) {
  if (!STATIC_CALL_PES_ON) return; // `?staticCallPes=off` — base emitters only.
  if (typeof setTimeout !== "function") return; // headless tests — no loop.
  const bytes = entry.hookData;
  if (!bytes || bytes.byteLength < 8) return;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const callPesDid = dv.getUint32(0, true) >>> 0;
  if (callPesDid === 0) return;
  const callPesPause = dv.getFloat32(4, true);
  const isSelf = callPesDid === (scriptId >>> 0);
  if (!isSelf && depth >= STATIC_MAX_CALL_PES_DEPTH) {
    // eslint-disable-next-line no-console
    console.warn(
      `[scene3d.statics/CallPES] depth guard hit (depth=${depth} >= ` +
        `${STATIC_MAX_CALL_PES_DEPTH}); dropping cross-script ` +
        `0x${callPesDid.toString(16)} from 0x${(scriptId >>> 0).toString(16)}`
    );
    return;
  }
  // Retail rolls a UNIFORM random duration in [0, pause] (Random::RollDice,
  // acclient.c:318987); a sub-0.0002 pause fires immediately. Add the hook's
  // own start_time offset within the script. rng() = Math.random by default.
  const pauseW = +callPesPause || 0;
  const randPause = pauseW < 0.0002 ? 0 : rng() * pauseW;
  const delayMs = Math.max(0, ((+entry.startTime || 0) + randPause) * 1000);
  const nextDepth = isSelf ? depth : depth + 1; // self-loop never caps.
  const tid = setTimeout(() => {
    _staticCallPesTimeouts.delete(tid);
    if (_spDisposed) return; // scene torn down.
    if (!anchor || !anchor.parent) return; // LB evicted — anchor detached.
    _runStaticParticleChain(
      manager, anchor, callPesDid, wasmExports, ownerKey, nextDepth
    ).catch(() => {});
  }, delayMs);
  _staticCallPesTimeouts.add(tid);
}

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
async function _runStaticParticleChain(manager, anchor, pesId, wasmExports, ownerKey = null, depth = 0) {
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
    // CallPES (19): re-play arm — the ambient loop that refreshes finite
    // swarms. Schedule the sub-script re-run (self = perpetual loop) and move
    // on. Fire-and-forget; never blocks the create-particle hooks below.
    if ((e.hookType | 0) === STATIC_HOOK_CALL_PES) {
      _scheduleStaticCallPes(manager, anchor, pesId, e, wasmExports, ownerKey, depth);
      continue;
    }
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
      const req = {
        emitterInfo,
        parent: anchor, // THREE.Group at the static's world transform.
        partIndex,
        parentOffset: {
          position: _staticOffsetVec3,
          quaternion: _staticOffsetQuat,
        },
        // Interior particle layering (2026-08-04) — DERIVED FROM THE ANCHOR,
        // deliberately NOT threaded as a `_runStaticParticleChain` parameter.
        // The anchor already IS the interior/outdoor discriminator
        // (`attachStaticDefaultScriptsWorld` stamps `isCellStaticScriptAnchor`
        // at :4451, the outdoor twin at :4318 does not), and every one of the
        // five call sites passes the anchor through unchanged — including the
        // CallPES self-loop at :4078, which re-runs the chain on a timer and
        // is how a looping emitter (e.g. the town-portal swirl, 2.7 s period)
        // gets rebuilt over and over. A parameter would have to be plumbed
        // correctly through all five, and the loop site is exactly the one a
        // future edit would forget; reading the anchor cannot drift.
        renderLayer:
          (_indoorParticleLayerEnabled() && anchor?.userData?.isCellStaticScriptAnchor)
            ? _RENDER_LAYER_INDOOR
            : 0,
        blocking:
          ((e.hookType | 0) === STATIC_HOOK_CREATE_BLOCKING_PARTICLE) &&
          _blockingParticleParityOn(),
      };
      // A11-S2: per-anchor owner scoping when `?particleOwner=on`. The
      // statics walker auto-assigns ids (no explicit handle), so the
      // facade's win here is the scoped teardown (`destroyAllForOwner`
      // per anchor) replacing the whole-table nuke.
      // Leak fix (2026-07-07): ALSO route through ownerRegistry whenever the
      // static-particle eviction fix is on, so owner-scoped teardown works on a
      // BARE URL too. `particleOwnerOn()` returns false on an empty
      // location.search (its empty-search default disagrees with this fix's
      // default-on gate); without this, the re-key to `static:<lbKey>` would be
      // inert in production (no query string) and the billboards would leak.
      const id =
        (ownerKey !== null && (particleOwnerOn() || _staticParticleEvictEnabled()))
          ? await ownerRegistry.addEmitter(ownerKey, manager, req)
          : await manager.addEmitter(req);
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
/**
 * Sky-particle (bird / aurora) chain attach — task #4 (2026-06-23).
 *
 * Region SkyObjects carry a `default_pes` (0x33 PhysicsScript) that, for the
 * sky swarms, does CreateParticle → ParticleEmitter(ParticleType.Swarm). e.g.
 * the region's 0x330007db spawns 0x32000455/456/457 (Swarm, gfxobj
 * 0x01001a61/a62/a63) — the "birds in the sky". sky_dome.js never walked this
 * chain (its W1 weather path draws billboards only — see the TODO there), so
 * those swarms never rendered.
 *
 * This reuses the EXACT scenery infrastructure — the shared ParticleManager
 * (`_ensureStaticParticleManager`), the chain walker (`_runStaticParticleChain`
 * incl. the fixed Swarm trajectory and the CallPES loop arm), and the
 * gfxobj→surface material path — but the caller supplies a CAMERA-FOLLOWING
 * `anchor` (moved every frame in sky_dome.js::tick) instead of a fixed world
 * placement, so the swarm orbits overhead wherever the player goes (retail
 * anchors sky particles to the camera-following sky cell). Honors the shared
 * `?staticScripts=off` kill switch; ticks on the same manager as scenery.
 *
 * @returns {Promise<number>} emitter count attached (0 on no-op / fail-soft).
 */
export async function attachSkyParticleChain(scene3d, anchor, pesId, wasmExports, ownerKey = null) {
  if (!scene3d || !anchor || !_staticScriptsEnabled()) return 0;
  if (((pesId >>> 0) === 0)) return 0;
  const manager = await _ensureStaticParticleManager(scene3d, wasmExports);
  if (!manager) return 0;
  return _runStaticParticleChain(manager, anchor, pesId >>> 0, wasmExports, ownerKey, 0);
}

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
  let _sliceStart = performance.now();
  // P4/R-10 residency guard (mirrors the F3 build guard at the
  // `staticsBakedLbs.has(lbKey)` check before the batch step): the slice
  // yields + per-emitter awaits let LRU eviction interleave with this loop,
  // and an attach into an evicted LB orphans anchors+emitters that tick
  // every frame and are only reaped by a SECOND eviction of that LB — which
  // a sealed dungeon's radius-0 residency never delivers (A03-F1 ≡ A13-L1).
  // Guard per PLACEMENT (ring calls span many LBs) on the same set
  // eviction clears; both bake paths mark the LB baked BEFORE this attach
  // runs, so a first attach never spuriously skips. Gated on the slice flag
  // like F3 — `?staticScriptSlice=off` restores the pre-slice burst attach.
  const _lbLive = (lbId) =>
    !STATIC_SCRIPT_SLICE_ON ||
    !(scene3d.staticsBakedLbs instanceof Set) ||
    scene3d.staticsBakedLbs.has(lbKeyOf(lbId >>> 0));
  const _deadLbs = new Set();
  for (const p of scripted) {
    // Abort the whole remaining run for an LB that went non-resident —
    // don't just skip one emitter (the rest of its placements are equally
    // dead, and re-entry re-runs the attach from scratch).
    const pLbKey = lbKeyOf(p.landblockId >>> 0);
    if (_deadLbs.has(pLbKey)) continue;
    if (!_lbLive(p.landblockId)) {
      _deadLbs.add(pLbKey);
      continue;
    }
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
    // A11-S2: one owner key per anchor (the static placement IS the
    // retail CPhysicsObj analog here). Stashed on userData so a future
    // per-landblock eviction can `destroyAllForOwner` per anchor.
    // Leak fix (2026-07-07): key by LANDBLOCK so `_evictStaticParticlesForLb`
    // (owner `static:<lbKey>`) reaps these emitters' billboards on LB eviction
    // — placements in one LB share the key, reaped together (retail-correct).
    // `?staticParticleEvict=off` reverts to the old (leaky) per-anchor seq key.
    const ownerKey = _staticParticleEvictEnabled()
      ? staticOwnerKeyForLb(p.landblockId)
      : `static:${++_staticOwnerSeq}`;
    anchor.userData = {
      isStaticScriptAnchor: true,
      defaultScriptId: p.defaultScriptId >>> 0,
      landblockId: p.landblockId,
      particleOwnerKey: ownerKey,
    };
    scene3d.staticsGroup.add(anchor);
    anchorCount += 1;
    // eslint-disable-next-line no-await-in-loop
    emitterCount += await _runStaticParticleChain(
      manager,
      anchor,
      p.defaultScriptId >>> 0,
      wasmExports,
      ownerKey
    );
    // P4/R-10 late-completion re-check: the chain's OWN awaits (script +
    // emitter fetches) can straddle an eviction too — the LRU's one-shot
    // reap already ran, so tear down what this anchor just registered and
    // stop attaching into that LB. Removing the anchor also breaks the
    // CallPES self-loop (`!anchor.parent` bail in _scheduleStaticCallPes).
    if (!_lbLive(p.landblockId)) {
      _deadLbs.add(pLbKey);
      try { ownerRegistry.destroyAllForOwner(ownerKey); } catch (_) {}
      try { scene3d.staticsGroup.remove(anchor); } catch (_) {}
      anchorCount -= 1;
      continue;
    }
    // Perf time-slice (2026-07-08): the per-emitter `await` above only yields
    // microtasks, so a town's hundreds of emitters would build in one macrotask
    // and freeze the frame. Yield a real macrotask once a synchronous chunk
    // exceeds the budget, spreading the attach across frames (no visual change,
    // just progressive pop-in instead of a stall). `?staticScriptSlice=off`.
    if (
      STATIC_SCRIPT_SLICE_ON &&
      performance.now() - _sliceStart > STATIC_SCRIPT_SLICE_MS
    ) {
      await new Promise((r) => setTimeout(r, 0));
      _sliceStart = performance.now();
    }
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

/**
 * World-frame sibling of `attachStaticDefaultScripts` for INTERIOR
 * EnvCell statics (2026-06-23). `cells.js` places interior props with a
 * fully-resolved world transform (cell rotation × stab — a FULL
 * quaternion, not yaw-only), so this variant takes ready world-frame
 * items instead of recomputing `lbX*192 + localX` + yaw. Otherwise
 * identical: it reuses the SAME `_ensureStaticParticleManager` +
 * `_runStaticParticleChain` + owner-key plumbing + `?staticScripts=off`
 * gate as the outdoor path, so interior braziers/torches/fountains emit
 * their `default_script` particle chains exactly like their outdoor twins.
 *
 * Each item: `{ defaultScriptId:number, x, y, z:number, qw, qx, qy,
 * qz?:number, scale?:number }` (x/y/z + q already in world frame).
 * Items with `defaultScriptId === 0` are skipped — the overwhelming
 * majority, so the filter is the whole default-path cost (one numeric
 * check per item; no manager/runtime imported when nothing is scripted).
 *
 * NOTE (first cut): anchors are added to `scene3d.staticsGroup` (always
 * visible), mirroring the outdoor path — NOT parented to the per-cell
 * container. A follow-up could parent to the EnvCell container so the
 * effect inherits the cell's enter-to-show visibility gate; for now the
 * emitter sits at the brazier's world position regardless of cell BFS.
 *
 * @returns {Promise<{anchorCount:number, emitterCount:number}>}
 */
export async function attachStaticDefaultScriptsWorld(scene3d, items, wasmExports) {
  if (!scene3d || !scene3d.staticsGroup || !Array.isArray(items)) {
    return { anchorCount: 0, emitterCount: 0 };
  }
  if (!_staticScriptsEnabled()) return { anchorCount: 0, emitterCount: 0 };

  const scripted = [];
  for (const it of items) {
    const did = (it && it.defaultScriptId) >>> 0;
    if (did !== 0) scripted.push(it);
  }
  if (scripted.length === 0) return { anchorCount: 0, emitterCount: 0 };

  const manager = await _ensureStaticParticleManager(scene3d, wasmExports);
  if (!manager) return { anchorCount: 0, emitterCount: 0 };

  let anchorCount = 0;
  let emitterCount = 0;
  let _sliceStart = performance.now();
  // P4/R-10 residency guard — interior twin of the outdoor guard above,
  // keyed on `envCellLoadedLbs` (set by the envcell build at cells.js:1083
  // BEFORE this attach fires; cleared by LRU eviction). Items without a
  // landblockId (the dormant pre-wasm-defaultScriptId path) can't be
  // guarded and keep the old behavior.
  const _cellLbLive = (it) =>
    !STATIC_SCRIPT_SLICE_ON ||
    it.landblockId == null ||
    !(scene3d.envCellLoadedLbs instanceof Set) ||
    scene3d.envCellLoadedLbs.has(lbKeyOf(it.landblockId >>> 0));
  const _deadLbs = new Set();
  for (const it of scripted) {
    const itLbKey = it.landblockId != null ? lbKeyOf(it.landblockId >>> 0) : null;
    if (itLbKey != null && _deadLbs.has(itLbKey)) continue;
    if (!_cellLbLive(it)) {
      _deadLbs.add(itLbKey);
      continue;
    }
    const anchor = new THREE.Group();
    anchor.name = `cellstatic-script-anchor-0x${(it.defaultScriptId >>> 0)
      .toString(16)
      .padStart(8, "0")}`;
    anchor.position.set(+it.x, +it.y, +it.z);
    // Full world-frame quaternion (interior cells can be arbitrarily
    // rotated, so yaw-only would mis-orient directional emitters).
    // THREE quaternion component order is (x, y, z, w).
    const qw = Number.isFinite(it.qw) ? it.qw : 1;
    const qx = Number.isFinite(it.qx) ? it.qx : 0;
    const qy = Number.isFinite(it.qy) ? it.qy : 0;
    const qz = Number.isFinite(it.qz) ? it.qz : 0;
    anchor.quaternion.set(qx, qy, qz, qw);
    const s = typeof it.scale === "number" && it.scale > 0 ? it.scale : 1;
    if (s !== 1) anchor.scale.set(s, s, s);
    // Leak fix (2026-07-07): key interior emitters by LANDBLOCK too so LB
    // eviction reaps them. Dormant until the wasm exposes EnvCell
    // defaultScriptId; cells.js now threads `it.landblockId`. Falls back to the
    // seq key if landblockId is absent (keeps the dormant path harmless).
    const ownerKey =
      _staticParticleEvictEnabled() && it.landblockId != null
        ? staticOwnerKeyForLb(it.landblockId >>> 0)
        : `static:${++_staticOwnerSeq}`;
    anchor.userData = {
      isStaticScriptAnchor: true,
      isCellStaticScriptAnchor: true,
      defaultScriptId: it.defaultScriptId >>> 0,
      particleOwnerKey: ownerKey,
    };
    // P4/R-10: stamp the owning LB (when known) so the LRU's
    // staticsGroup sweep-by-landblockId reaps interior anchors exactly
    // like outdoor ones (previously only the registry half was reaped —
    // the detached-anchor CallPES bail never fired for interiors).
    if (it.landblockId != null) {
      anchor.userData.landblockId = it.landblockId >>> 0;
    }
    scene3d.staticsGroup.add(anchor);
    anchorCount += 1;
    // eslint-disable-next-line no-await-in-loop
    emitterCount += await _runStaticParticleChain(
      manager,
      anchor,
      it.defaultScriptId >>> 0,
      wasmExports,
      ownerKey
    );
    // P4/R-10 late-completion re-check — see the outdoor twin above.
    if (!_cellLbLive(it)) {
      _deadLbs.add(itLbKey);
      try { ownerRegistry.destroyAllForOwner(ownerKey); } catch (_) {}
      try { scene3d.staticsGroup.remove(anchor); } catch (_) {}
      anchorCount -= 1;
      continue;
    }
    // Perf time-slice (2026-07-08) — see attachStaticDefaultScripts.
    if (
      STATIC_SCRIPT_SLICE_ON &&
      performance.now() - _sliceStart > STATIC_SCRIPT_SLICE_MS
    ) {
      await new Promise((r) => setTimeout(r, 0));
      _sliceStart = performance.now();
    }
  }
  if (anchorCount > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[scene3d.statics/V1] attached interior default_script chains: ` +
        `${anchorCount} anchors, ${emitterCount} emitters`
    );
  }
  return { anchorCount, emitterCount };
}

/**
 * Phase 3 — tear down every SYNTHESIZED particle emitter owned by one landblock
 * (owner key `static:<lbKey>`). Called by the LRU eviction via the
 * `scene3d._evictStaticParticlesForLb` hook installed in
 * `_ensureStaticParticleManager`. `lbKeyOrId` may be a packed lb-key
 * ((lbX<<24)|(lbY<<16)) or a full landblockId — both normalize to the same key
 * via the 0xffff0000 mask, matching `lbSetKey` and the attach-side owner key.
 * No-op for an LB that placed no particles (empty-owner fast path in the facade).
 * This is the ONLY per-LB teardown path (disposeStaticParticles is whole-scene
 * only). It reaps whatever the attach seams registered in ownerRegistry under
 * `static:<lbKey>` — which the default_script seams do whenever `particleOwnerOn()`
 * OR `_staticParticleEvictEnabled()` is on (default-on; see the `_runStaticParticleChain`
 * gate). If neither is on, those emitters bypass the registry and this reaps nothing.
 */
export function _evictStaticParticlesForLb(lbKeyOrId) {
  // D7 — the SAME single-source helper the attach seams use, so the teardown key
  // is char-for-char identical to the attach key (no drift → no persistent leak).
  const key = staticOwnerKeyForLb(lbKeyOrId);
  try { ownerRegistry.destroyAllForOwner(key); } catch (_) { /* fail-soft */ }
}

/**
 * Phase 9a warm-park unpark seam (W4 §3.3 item 4): rebuild static
 * default_script emitters from STASHED anchors. park() destroys an LB's
 * emitters (they tick per frame) but the anchors — Groups stamped with
 * `{ isStaticScriptAnchor, defaultScriptId, landblockId, particleOwnerKey }`
 * — ride the detached subtrees into the pool; unpark re-attaches them and
 * calls this to re-run `_runStaticParticleChain` per anchor. Time-sliced
 * like the bake-time attach, and carries the R-10 residency guard (an
 * unpark can race a re-park/evict: a re-detached anchor or a no-longer-
 * resident LB is skipped, matching the attach path's drop semantics).
 */
export async function rebuildStaticScriptEmittersForAnchors(scene3d, anchors, wasmExports) {
  if (!Array.isArray(anchors) || anchors.length === 0) return 0;
  const manager = await _ensureStaticParticleManager(scene3d, wasmExports);
  if (!manager) return 0;
  const lbLive = (lbId) => {
    const key = lbKeyOf(lbId >>> 0);
    return (
      (scene3d.staticsBakedLbs instanceof Set && scene3d.staticsBakedLbs.has(key)) ||
      (scene3d.envCellLoadedLbs instanceof Set && scene3d.envCellLoadedLbs.has(key))
    );
  };
  let emitters = 0;
  let sliceStart = performance.now();
  for (const anchor of anchors) {
    const ud = anchor?.userData;
    if (!ud?.isStaticScriptAnchor) continue;
    const pesId = ud.defaultScriptId >>> 0;
    if (!pesId) continue;
    if (!anchor.parent || !lbLive(ud.landblockId >>> 0)) continue; // R-10
    // eslint-disable-next-line no-await-in-loop
    emitters += await _runStaticParticleChain(
      manager,
      anchor,
      pesId,
      wasmExports,
      ud.particleOwnerKey ?? null
    );
    if (
      STATIC_SCRIPT_SLICE_ON &&
      performance.now() - sliceStart > STATIC_SCRIPT_SLICE_MS
    ) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 0));
      sliceStart = performance.now();
    }
  }
  return emitters;
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
  // Cancel any pending CallPES re-run timers (a 0–35s ambient-loop window can
  // outlive teardown). The `_spDisposed` guard already no-ops a fire, but clear
  // them so they don't linger.
  if (typeof clearTimeout === "function") {
    for (const tid of _staticCallPesTimeouts) {
      try { clearTimeout(tid); } catch (_) {}
    }
  }
  _staticCallPesTimeouts.clear();
  const mgr = scene3d?._staticParticleManager;
  if (mgr && typeof mgr.particleTable?.forEach === "function") {
    try {
      const ids = [...mgr.particleTable.keys()];
      for (const id of ids) mgr.destroyParticleEmitter(id);
    } catch (_) {}
  }
  // A11-S2: drop the facade's per-anchor owner records too (the destroys
  // above already freed the underlying emitters; this clears tracking +
  // tombstones in-flight creates so a late addEmitter resolve self-destroys
  // instead of repopulating a disposed manager).
  if (particleOwnerOn()) {
    try {
      for (const key of [...ownerRegistry.ownerKeys()]) {
        if (typeof key === "string" && key.startsWith("static:")) {
          ownerRegistry.destroyAllForOwner(key);
        }
      }
    } catch (_) {}
  }
}

/** A11-S3: advance the static ParticleManager from the main loop — retail
 *  runs animate_static_object's UpdateParticles in the SAME
 *  CPhysics::UseTime pass as dynamic objects (acclient.c:311381-311386,
 *  321191-321193), not on a private clock. Called from tickPerFrame's
 *  manager phase (scene3d/loop.js) when `?particleClock=loop|sim`.
 *  No-op until a manager exists. */
// Module-level handle to the static ParticleManager (set in _ensureStaticParticleManager).
// THE BUG (2026-06-24, found on the 1070): the self-rAF tick driver below read
// `window.liveScene3d._staticParticleManager`, but the manager is stamped on
// `scene3dForBuilders` — a DIFFERENT object than the `window.liveScene3d` facade — so
// `mgr` was always undefined and the static manager NEVER ticked: every static particle
// (lifestone gemSparkle, tree foliage, retail default_script statics) stayed invisible
// (visible:0 in __diag.particlesDebug). This ref decouples the tick from that facade
// mismatch, so it works regardless of which scene object the loop/window carry.
let _staticParticleMgrRef = null;

export function tickStaticParticles(scene3d) {
  const mgr = scene3d?._staticParticleManager || _staticParticleMgrRef;
  if (mgr) { try { mgr.tick(); } catch (_) {} }
}

// Self-managed rAF to advance the static ParticleManager every frame —
// same pattern as the billboard loop above (the render loop, loop.js,
// is another agent's file, so we drive our own tick off
// `window.liveScene3d`). No-op until a manager exists (i.e. until at
// least one scripted static is placed). Browser-only.
// A11-S3: never arms when `?particleClock=loop|sim` — the main loop's
// manager phase (tickStaticParticles above) is the single driver then.
let _spRafId = 0;
let _spDisposed = false;

if (typeof window !== "undefined" && _staticScriptsEnabled() && particleClockMode() === "off") {
  const _spLoop = () => {
    if (_spDisposed) return;
    try {
      const mgr = _staticParticleMgrRef || window.liveScene3d?._staticParticleManager;
      if (mgr) mgr.tick();
    } catch (_) {}
    _spRafId = window.requestAnimationFrame(_spLoop);
  };
  _spRafId = window.requestAnimationFrame(_spLoop);
}
