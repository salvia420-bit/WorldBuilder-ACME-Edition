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
import { RENDER_LAYER_PORTAL_CELL } from "./portal_stencil.js";
import {
  clipAperturesForPunch,
  makeNearPlane,
  makeLosCache,
  isCameraBelowTerrain,
  nodeInLandblock,
} from "./portal_clip.js";
import {
  meshToGeometryGroups,
  meshToFusedGeometry,
  placementToMatrix4,
  acQuatToThree,
} from "./adapter.js";
import { materialCanCastShadow, VERTEX_BAKE } from "./materials.js";
import { lbKeyOf, isNearPlayerLb } from "./landblock_lru.js";
// ST8 stage A (?frameWork, SPEC §3 T21) — W6 chunk-yield adapter; flag OFF
// returns exactly today's setTimeout(0) macrotask yield (byte-identical).
import { frameWorkW6Yield } from "./frame_work.js";
import { STREAM_BAKE_DEFAULT_MAX_IN_FLIGHT } from "./stream_bake_guard.js";
import { guardedCompileAsync } from "./bake_prewarm.js";
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

// ?cellStaticBias — default-ON (2026-07-06). Nudge EnvCell décor props (wall/
// floor-flush SetupModels — tapestries, sconces, signs, rugs) a hair toward the
// camera in log-depth space via getCachedStaticBias, so they win the coplanar
// depth tie against the cell wall/floor they sit on instead of z-fighting it
// (the "z-fight near walls" seen in dungeon hallways + building interiors). The
// biased material is a cache-owned CLONE — the shared getCached base is never
// mutated. `=off` restores the plain shared getCached material (A/B escape).
const CELL_STATIC_BIAS = (() => {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.search) {
      return new URLSearchParams(globalThis.location.search).get("cellStaticBias") !== "off";
    }
  } catch (_) {}
  return true;
})();

// ?indoorDepthSplit (2026-08-04) — TERRAIN-OVER-INTERIORS, camera-inside case.
//
// Retail's indoor frame is NOT a shared-depth pass. `SmartBox::RenderNormalMode`
// (acclient.c:144889) branches on `(viewer.objcell_id & 0xFFFF) < 0x100`; the
// EnvCell branch calls `DrawInside` → `PView::DrawCells(pview, 0)`
// (acclient.c:461450), which does, in order:
//   1. `if (outside_view.view_count)` → `LScape::draw` (:461480), the landscape
//      SCREEN-CLIPPED to the accumulated exterior-portal view polygons
//      (`cliplandscape = 1`, acclient.c:45789);
//   2. `Clear(4 /*Z only*/, …, 1.0f)` (:461484) — a FULL-SCREEN depth wipe
//      (`RenderDeviceD3D::Clear` resets to the full presentation rect first,
//      acclient.c:457577), colour untouched;
//   3. `DrawPortalPolyInternal(portal, /*zClear=*/0)` (:461536) for every portal
//      with `other_cell_id == -1`, re-stamping the exterior portal PLANES at
//      their true depth;
//   4. `DrawEnvCell` per cell of `cell_draw_list`, then `DrawObjCellForDummies`.
// There is no terrain-vs-building exclusion anywhere in retail — the Z wipe IS
// the mechanism. So terrain physically cannot occlude an interior indoors.
//
// Our pipeline dropped the equivalent split on 2026-05-29 (see the long note in
// atmosphere_pipeline.js `preFrameSkySync`) because it fired whenever the
// player's cell classified indoor — and building plots ARE EnvCells, so it drew
// interiors/basements/downhill cottages THROUGH terrain while the player stood
// visually outside. The regression was NOT the clear; retail does the clear.
// It was (a) the trigger and (b) WHAT the second pass drew: retail draws
// `cell_draw_list` — the portal-clipped BFS from the viewer's own cell — while
// we draw the UNION of the PView walk and the raw AABB-frustum set, which under
// `?stablist` admits every frustum-visible SeenOutside cell in town.
//
// Modes:
//   off    (DEFAULT) — byte-identical to today. No split, no set restriction.
//   on               — arm when `isCurrentCellIndoor()` AND the camera is
//                      BELOW the terrain surface at its own (x, y). That
//                      second clause is the precise anti-regression: standing
//                      on a Holtburg plot the camera is ABOVE terrain, so the
//                      split cannot arm; a camera under the surface is exactly
//                      the case where the heightfield encloses it and terrain
//                      wins depth in every horizontal direction (the reported
//                      Yaraq bug). Fails CLOSED on an unbaked landblock.
//   retail           — arm on `isCurrentCellIndoor()` alone (retail :144889),
//                      for A/B against the historical see-through.
// In BOTH armed modes the cells pass is restricted to the portal set (retail
// `cell_draw_list`), dropping the frustum/stablist admissions.
const INDOOR_DEPTH_SPLIT = (() => {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location) {
      const v = new URLSearchParams(globalThis.location.search || "").get(
        "indoorDepthSplit",
      );
      if (v === "off") return "off";
      if (v === "retail") return "retail";
      if (v === "strict") return "strict";
      return "on"; // DEFAULT-ON (2026-08-04 — user-verified live indoors on R9 290)
    }
  } catch (_) {}
  return "off";
})();

// ROUND 5 BOOT BANNER. The round-4 transition log never reached the user's
// console even though the behaviour changed — the signature of a STALE
// service-worker bundle (`holtburger-content-v2` caches JS across Ctrl+R and
// browser restarts; only `?nosw=1` clears it), which would also explain the
// round-4 report exactly: round-3 code armed off the CAMERA (so it worked when
// fully inside, where the camera is also below grade) and had no log at all.
// This line is emitted at MODULE LOAD, before any tick, so its ABSENCE is
// itself the diagnosis: no banner ⇒ stale bundle ⇒ add `?nosw=1`.
const INDOOR_SPLIT_BUILD = "2026-08-04-r5";

// ?punchSidedness (2026-08-04 round 7) — DEFAULT OFF, and off is the RESTORED
// round-4 behaviour the user confirmed working outdoors.
//
// The round-5 sidedness gate (`apertureFacesAway`) regressed the outdoor punch.
// It rests on the sign of "is the room centre inside or outside this doorway",
// derived from the cell's AABB centre, and that sign is unreliable for real AC
// rooms: a doorway in a long wall puts the AABB centre near the wall plane, and
// an L-shaped or multi-part cell can put it outside the room entirely. Round 7
// added an orientation-confidence guard (`SIDEDNESS_MIN_INWARD_M`) so the gate
// fails OPEN when the sign is untrustworthy — but "outdoor punch works" is a
// confirmed-good state and a speculative gate does not get to risk it by
// default. `?punchSidedness=on` to A/B the far-side-door fix it was written for.
const PUNCH_SIDEDNESS = (() => {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location) {
      return new URLSearchParams(globalThis.location.search || "")
        .get("punchSidedness") === "on";
    }
  } catch (_) {}
  return false;
})();

/** Mirrors the `?portalPunch` reader in index.js so the diag can report it. */
const PORTAL_PUNCH_FLAG_ON = (() => {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location) {
      return new URLSearchParams(globalThis.location.search || "")
        .get("portalPunch")?.toLowerCase() !== "off"; // DEFAULT-ON 2026-08-04
    }
  } catch (_) {}
  return false;
})();

// Boot banner + flag mirror (round 7). `_portalPunchDiag === undefined` cost a
// round-trip because it could mean "flag off", "stale bundle", or "the tick
// never ran". `window.__portalPunch` is stamped at MODULE LOAD, so its absence
// means STALE BUNDLE and nothing else; `enabled` settles flag presence at a
// glance; and `_portalPunchDiag` is stamped on EVERY tick when the flag is on,
// including every early-return path.
try {
  globalThis.__portalPunch = {
    build: INDOOR_SPLIT_BUILD,
    enabled: PORTAL_PUNCH_FLAG_ON,
    sidedness: PUNCH_SIDEDNESS,
  };
  if (PORTAL_PUNCH_FLAG_ON) {
    // eslint-disable-next-line no-console
    console.log(
      `[portalPunch] build=${INDOOR_SPLIT_BUILD} enabled=true sidedness=${PUNCH_SIDEDNESS} ` +
      `— if you do not see this line, your bundle is STALE: add ?nosw=1`,
    );
  }
} catch (_) {}
/** Last logged `armed|reason`, module-scoped so a scene rebuild cannot reset it. */
let _indoorSplitLastLog = null;
if (INDOOR_DEPTH_SPLIT !== "off") {
  try {
    // eslint-disable-next-line no-console
    console.log(
      `[indoorDepthSplit] build=${INDOOR_SPLIT_BUILD} mode=${INDOOR_DEPTH_SPLIT} ` +
      `— if you do not see this line, your bundle is STALE: add ?nosw=1`,
    );
  } catch (_) {}
}

/** Metres the camera must sit below the terrain surface before "on" arms. */
const INDOOR_SPLIT_BELOW_TERRAIN_M = 0.5;

// ── Which geometry the armed cells pass must draw (2026-08-04 round 2) ──
//
// Round 1 assumed "interior == cellsGroup (layer 1)". Live verification killed
// that: at the Holtburg meeting hall (cell 0xA9B4011A) the split armed
// correctly but the ROOM VANISHED, because `cellContainers3d` was EMPTY and
// `cellsGroup` had no layer-1 meshes there — so the world pass (WORLD_ONLY)
// excluded nothing useful and the cells pass (INDOOR_ONLY) had nothing to draw.
//
// What is actually on screen inside a town building, established by reading
// every layer assignment in scene3d/ (`rg -n 'layers\.(set|enable|disable)'`):
//   · terrainGroup   — index.js:1318, NEVER stamped → layer 0
//   · buildingsGroup — index.js:1319, NEVER stamped → layer 0  ← the room SHELL
//   · staticsGroup   — index.js:1320, NEVER stamped → layer 0  ← interior props
//   · cellsGroup     — index.js:1343 → layer 1 (EnvCell surfaces, when baked)
//   · entitiesGroup  — index.js:1344 → layer 1
// The building MODEL carries the walls you see from inside (retail draws it via
// `DrawBuilding`/`CBuildingObj`, separately from the EnvCells `DrawEnvCell`
// draws). So the interior lives MOSTLY ON LAYER 0, alongside terrain — which is
// exactly why the shared-depth pass lets terrain occlude it, and why splitting
// on the existing layer scheme could never fix it.
//
// (The DAT confirms the EnvCells are real — WorldBuilder.Terminal
// `pvs-visibility-snapshot 0xA9B4011A` returns a 9-cell portal graph
// 0xA9B40116-0xA9B4011E. Their absence from `cellContainers3d` on the probe box
// is a SEPARATE streaming gap, noted in the docs row. The fix below does not
// depend on it either way.)
//
// The fix: while armed, move buildingsGroup + staticsGroup onto the INDOOR
// layer, so the passes become "terrain" vs "everything else" — retail's actual
// division (`LScape::draw` then Z-wipe then the cell/building draws). Chosen
// over moving TERRAIN to a new layer because layer 1 is already the codebase's
// "indoor content" layer and is therefore already covered by:
//   · every light (`lighting.js:276/2466/2642`, `csm.js:245`,
//     `atmosphere_lights.js:174-175` all `layers.enable(1)`) → no black geometry
//   · every raycaster (`picking.js:476`, `ragdoll_env.js:136-137`) → picking,
//     ragdoll ground contact and decal placement keep working
// Moving terrain to a fresh layer 3 would have broken all of those. Terrain
// never moves, so nothing that depends on terrain being on layer 0 is touched.
// Blood decals are parented to entitiesGroup (blood_decals.js:862), not to
// these two groups, so the layer-0 restore cannot strand them.
//
// Consequence: NO mask change is needed in atmosphere_pipeline.js — the armed
// world pass keeps `CAM_LAYER_MASK_WORLD_ONLY` (now = terrain alone) and the
// armed cells pass keeps `CAM_LAYER_MASK_INDOOR_ONLY` (now = shell + props +
// EnvCells + entities). Off-state is still byte-identical: nothing is ever
// re-layered unless the flag arms.
const SPLIT_RELAYER_GROUPS = ["buildingsGroup", "staticsGroup"];
const RENDER_LAYER_WORLD = 0;
const RENDER_LAYER_INDOOR = 1;
/** Backstop re-stamp cadence while armed, in ticks (catches any signature miss). */
const SPLIT_RELAYER_BACKSTOP_TICKS = 60;

/**
 * Does this top-level buildings/statics child belong to landblock `lbKey`?
 *
 * NARROWING GRANULARITY (the honest answer to "operate at whatever granularity
 * the baked path offers"): the baked path offers PER-LANDBLOCK, not per-cell.
 * Top-level children carry `userData.landblockId` (buildings.js:490 per
 * placement, statics.js:1257 per static, static_batch_x:1758 per batched
 * surface); merged instanced statics instead carry `coversLbKeys`
 * (statics.js:1444) and can span several LBs. There is no per-cell mapping to
 * narrow with, so the split narrows to the player's own LB.
 *
 * FAILS CLOSED on an untagged node — it stays on layer 0 and keeps its terrain
 * occlusion. That direction is deliberate: leaving a node behind means the
 * original bug persists for that node (no NEW artifact), whereas hoisting an
 * unknown world-spanning merged batch past the depth clear would manufacture a
 * fresh see-through. The room SHELL is a tagged building placement, so the
 * thing the fix exists for is always covered.
 */
// Implementation lives in portal_clip.js (pure, unit-tested); see the doc
// comment there for the fail-closed rationale and the userData shapes.
const _nodeInLandblock = nodeInLandblock;

/**
 * Move (or restore) the player's-landblock buildings/statics between the WORLD
 * and INDOOR layers. Other landblocks are left on layer 0 on purpose: they then
 * draw in the pre-clear world pass alongside terrain, KEEPING their terrain
 * occlusion, and their colour survives the depth clear — so the town seen
 * through the doorway looks exactly as it does today. Only the LB you are
 * standing in is hoisted past the clear.
 *
 * PERF (2026-08-04). This is re-entered whenever `_splitGroupSignature` moves,
 * and that signature is the raw child count of `buildingsGroup` +
 * `staticsGroup` — which changes on EVERY streaming add anywhere in the ring,
 * i.e. on most frames while a town is still settling. Re-stamping a subtree
 * that is already on the target layer is pure waste, so a node records its
 * stamped layer in `userData.__splitLayer` and is skipped on the next pass.
 * `force` (used by the periodic backstop and by every transition) ignores the
 * tag, so the safety net that catches a node which grew children after being
 * stamped still runs — just at 1/SPLIT_RELAYER_BACKSTOP_TICKS of the cost.
 */
function _stampSplitLayers(scene3d, layer, lbKey, force = false) {
  let hoisted = 0;
  let skipped = 0;
  let already = 0;
  for (const name of SPLIT_RELAYER_GROUPS) {
    const g = scene3d?.[name];
    if (!g || !Array.isArray(g.children)) continue;
    try {
      // Snapshot the child list: a bake completing mid-traverse would
      // otherwise mutate the array we are walking.
      for (const child of g.children.slice()) {
        if (!_nodeInLandblock(child, lbKey)) { skipped++; continue; }
        if (!force && child.userData && child.userData.__splitLayer === layer) {
          already++;
          hoisted++;
          continue;
        }
        child.traverse((o) => o.layers.set(layer));
        if (child.userData) child.userData.__splitLayer = layer;
        hoisted++;
      }
    } catch (_) { /* a mid-traverse mutation must never break the tick */ }
  }
  // DIAGNOSTIC (2026-08-04 round 2). `hoisted === 0` means the split had
  // NOTHING to move and can only be drawing EnvCell geometry — which is
  // precisely the round-1 failure (empty `cellContainers3d` ⇒ blank room).
  // Publishing it makes that state observable from the probe instead of
  // needing a screenshot to notice. See the docs row's atlas caveat: under
  // the default `?statAtlas` / `?buildingBatch` the building shell is merged
  // into cross-LB `BatchedMesh` buckets that deliberately carry NO
  // `userData.landblockId` (static_atlas.js:1012), so it CANNOT be hoisted
  // and `hoisted` will be low or zero.
  if (scene3d) {
    scene3d._splitRelayerDiag = { layer, lbKey, hoisted, skipped, already, force };
  }
  return hoisted;
}

/**
 * Cheap change detector for "did new geometry stream into these groups".
 * Meshes added while armed default to layer 0 and would otherwise be drawn in
 * the pre-clear world pass — i.e. occluded by terrain, the very bug — until
 * the next backstop. Batched surfaces also MOVE between buildingsGroup and
 * staticsGroup (static_batch_x / static_atlas), and any such move changes at
 * least one child count.
 */
// DEFECT 3 (fountain particles vanish when an interior is viewed from outside
// through `?portalPunch`) was fixed at EMISSION TIME on 2026-08-04; the
// per-tick `staticsGroup` sweep and its `INDOOR_PARTICLE_LAYER` gate that used
// to live here are retired.
//
// ROOT CAUSE (unchanged, recorded for the next reader). The static
// ParticleManager is constructed with `scene: scene3d.staticsGroup`
// (statics.js), and the emitter adds each live mesh to THAT SCENE, not to its
// anchor (`particle_emitter.js` `this._scene.add(mesh)`; `particle_manager.js`
// `this._scene.add(im)` for instanced buckets). The anchor Group is only a
// transform frame read via `_resolveAnchorFrame`. So particle meshes are FLAT
// SIBLINGS of the anchor, and they used to be on LAYER 0 — under the punch the
// world pass paints them, the punch stamps far-Z in the aperture, and the cells
// pass paints the interior OVER them. Fully inside there is no split, which is
// why they only vanished when looking in from outside.
//
// THE FIX now lives where the interior/outdoor distinction actually exists:
// statics.js `_runStaticParticleChain` derives `renderLayer` from the anchor's
// `userData.isCellStaticScriptAnchor` and passes it through
// `manager.addEmitter(req)`; the manager stamps every slot mesh in its
// meshFactory and keys instanced buckets by (gfxobj, layer). Interior emitters
// land on layer 1 and ride the cells pass; outdoor ones stay on layer 0 and are
// correctly occluded by the punch — the discrimination the sweep could not do,
// which is why it was never promoted past default-OFF. `?indoorParticleLayer=off`
// (read in statics.js) disables the mechanism.
//
// NOTE for anyone adding a layer sweep here again: `_stampSplitLayers` below
// cannot reach particle meshes anyway — it only descends children that pass
// `nodeInLandblock`, and a particle mesh carries neither `landblockId` nor
// `coversLbKeys`. That is also what makes the emission-time stamp stable.

function _splitGroupSignature(scene3d) {
  let sig = 0;
  for (const name of SPLIT_RELAYER_GROUPS) {
    const g = scene3d?.[name];
    sig = sig * 65537 + (g?.children?.length ?? 0);
  }
  return sig;
}

// Scratch objects for the per-frame AC-space camera derivation (allocation-free).
const _acCamVec = { x: 0, y: 0, z: 0 };
const _acFwdVec = { x: 0, y: 0, z: 0 };
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();

/**
 * Camera position + forward in AC world coords (Z-up), derived by pulling the
 * THREE-space camera back through `worldRoot`'s AC→THREE rotation. The camera
 * lives OUTSIDE worldRoot (see `tickCellVisibility3D`'s MVP note), so
 * `worldToLocal` is the exact inverse of the transform the aperture vertices
 * were authored in. Returns false when the inputs aren't ready.
 */
function acCameraFrame(camera, worldRoot) {
  if (!camera || !worldRoot) return false;
  try {
    camera.getWorldPosition(_v3a);
    // A point one metre down the view axis; the DIFFERENCE of the two
    // worldToLocal results is the rotated direction (translation cancels).
    camera.getWorldDirection(_v3b);
    _v3b.add(_v3a);
    worldRoot.worldToLocal(_v3a);
    worldRoot.worldToLocal(_v3b);
    if (!Number.isFinite(_v3a.x) || !Number.isFinite(_v3b.x)) return false;
    _acCamVec.x = _v3a.x; _acCamVec.y = _v3a.y; _acCamVec.z = _v3a.z;
    _acFwdVec.x = _v3b.x - _v3a.x;
    _acFwdVec.y = _v3b.y - _v3a.y;
    _acFwdVec.z = _v3b.z - _v3a.z;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * DEFECT 1 (2026-08-04 round 4) — the local player's position in AC WORLD
 * metres, or null.
 *
 * Round 3 armed the split from the CAMERA position alone. In third person the
 * camera trails the player and sits ABOVE the terrain surface while the player
 * is under it — which is exactly a sunken Yaraq shop, and exactly why the user
 * saw "no difference". Arming needs the player position too.
 *
 * TWO TRAPS this function exists to encapsulate:
 *   · `getLocalPlayerPose()` returns LANDBLOCK-LOCAL x/y. `terrainHeightAt`
 *     wants AC world metres, so the landblock corner (192 m per LB, byte-packed
 *     into the id) must be folded in — the same conversion camera.js's
 *     `__cam.world()` does at camera.js:1204-1218. Passing the raw local x/y
 *     would sample a landblock near the world origin and return null or a
 *     wildly wrong height.
 *   · the returned pose is a WASM BOX and must be `.free()`d or it leaks every
 *     frame (same note as camera.js `_integratorWorldPose`).
 */
function playerAcPosition(sessionHandle) {
  if (!sessionHandle || typeof sessionHandle.getLocalPlayerPose !== "function") {
    return null;
  }
  let p = null;
  try {
    p = sessionHandle.getLocalPlayerPose();
    if (!p) return null;
    const lb = p.landblockId >>> 0;
    const out = {
      x: ((lb >>> 24) & 0xff) * 192 + p.x,
      y: ((lb >>> 16) & 0xff) * 192 + p.y,
      z: p.z,
    };
    return Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z)
      ? out
      : null;
  } catch (_) {
    return null;
  } finally {
    try { p?.free?.(); } catch (_) { /* already released */ }
  }
}

/**
 * `terrainHeightAt` bound to a session handle, or null when unavailable
 * (missing export on a stale `pkg/` → callers degrade to "unknown height",
 * which fails CLOSED for the split arm and OPEN for the LOS cull).
 *
 * Memoised on the handle so the two per-frame consumers don't allocate a
 * fresh closure every rAF tick.
 */
let _heightSamplerHandle = null;
let _heightSampler = null;
function heightSamplerFor(sessionHandle) {
  if (!sessionHandle || typeof sessionHandle.terrainHeightAt !== "function") {
    return null;
  }
  if (_heightSamplerHandle === sessionHandle) return _heightSampler;
  _heightSamplerHandle = sessionHandle;
  _heightSampler = (x, y) => {
    try {
      return sessionHandle.terrainHeightAt(x, y);
    } catch (_) {
      return null;
    }
  };
  return _heightSampler;
}

// RND-04 (2026-07-27) — pick the material for one EnvCell surface group.
// `baked` is decided ONCE PER CELL (every group of a cell comes from the same
// packed ModelMesh, so the `acBakedLight` attribute is present on all of them
// or none) and must agree with whether the geometry handed to the Mesh
// actually carries the attribute: under `?vertexBake`'s retail arm the baked
// material drops its direct lighting, so a baked material on un-baked
// geometry reads (0,0,0) and renders the surface black. Falls back to the
// shared `getCached` material whenever the bake is unavailable, which is what
// makes a pre-RND-04 wasm bundle a no-op rather than a blackout.
function cellMaterialFor(scene3d, group, baked) {
  return baked
    ? scene3d.materialCache.getCachedCellBaked(group.surfaceDid)
    : scene3d.materialCache.getCached(group.surfaceDid);
}

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

// Step 1a (2026-07-07) — indoor PVS-ring radius. Indoors (a dungeon / cell
// interior) there is no line-of-sight to the surface landblocks the radius-N
// prefetch ring pulls in, so `tickPvsLoadExpansion` collapses the ring to this
// small skirt when `isCurrentCellIndoor()` is true. Default 1 (a 1-LB skirt =
// 3×3, vs the outdoor 121-LB radius-5 ring) — the render-set (`getRenderSet`)
// already bakes everything the PVS can actually see (incl. surface visible
// through a dungeon mouth), so the ring is pure outdoor-roam prefetch. This
// trims residency at the SOURCE (Town Network 68 LBs → single digits), which
// shrinks every downstream per-frame statics walk proportionally. `=0` = most
// aggressive (render-set only); `=N >= pvsRingRadius` disables the gate.
// 2026-08-03 residency task #10 — `?fogRingCap` (DEFAULT ON, `=off` escape).
// Cap the outdoor prefetch ring by the AUTHORED fog band: night fog is
// 0→400 m, so baking terrain/statics/buildings to the radius-5 edge
// (~1056 m) made ~80 % of the night working set invisible. The cap reads
// `scene3d._authoredFogMaxM` (published by loop.js::tickDistanceFogColor
// from the SkyState snapshot — authored values, NOT the drawn-edge-derived
// fogFar, which would feed back). Absent snapshot (headless / boot) → no
// cap, fail-open to the full ring. The capped radius feeds `fireSig`, so a
// dawn fogMax lerp re-fires the sweep and the ring reopens by itself.
const FOG_RING_CAP_ENABLED = (() => {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.search) {
      const v = new URLSearchParams(globalThis.location.search).get("fogRingCap");
      if (v != null) {
        const t = String(v).toLowerCase();
        return !(t === "off" || t === "0" || t === "false" || t === "no");
      }
    }
  } catch (_) {}
  return true;
})();

const INDOOR_PVS_RING_RADIUS = (() => {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.search) {
      const raw = new URLSearchParams(globalThis.location.search).get("indoorPvsRing");
      if (raw != null) {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n >= 0) return n;
      }
    }
  } catch (_) {}
  return 1;
})();

// Step 1b (2026-07-08) — sealed-dungeon outdoor cull. Default ON;
// `?sealedCull=off` (or `0`/`false`) restores the Phase 5 unconditional
// "outdoor groups always visible indoors" behaviour. When ON,
// `tickCellVisibility3D` hides terrainGroup / buildingsGroup / staticsGroup
// whenever the current indoor dungeon has zero outdoor-facing portals — a
// fully-enclosed hub like Town Network (LB 0x0007: 205 cells, PVS
// interior-only, 0 exterior portals, sitting on flat deep-sea ocean beside
// the 416 m world-edge mountain wall). Retail's PVS from such a cell is
// interior-only, so that ocean + mountain paint is drawn every frame and
// never seen. Mouthed dungeons / cottages (any outdoor-facing portal) keep
// the current always-visible behaviour. Detection: `sessionHandle
// .currentDungeonHasOutdoorPortal()` (see src/lib.rs).
const SEALED_CULL_ENABLED = (() => {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.search) {
      const raw = new URLSearchParams(globalThis.location.search).get("sealedCull");
      if (raw === "off" || raw === "0" || raw === "false") return false;
    }
  } catch (_) {}
  return true;
})();

// Step 1c (2026-07-08) — sealed-dungeon residency reclaim. Default ON;
// `?sealedEvict=off` keeps the visibility cull but leaves the outdoor
// terrain/statics RESIDENT (baked + walked per frame). When ON, a fully-
// enclosed indoor dungeon (detected by ?sealedCull) both (a) drops the PVS
// prefetch skirt to radius 0 so no outdoor LB re-bakes and (b) evicts every
// resident LB except the dungeon's own via the LRU — reclaiming the ~127
// resident LBs / millions of triangles that pegged the main thread. Requires
// SEALED_CULL_ENABLED (the sealed detection); independent escape so the
// aggressive dispose/re-bake half can be rolled back without losing the cull.
const SEALED_EVICT_ENABLED = (() => {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.search) {
      const raw = new URLSearchParams(globalThis.location.search).get("sealedEvict");
      if (raw === "off" || raw === "0" || raw === "false") return false;
    }
  } catch (_) {}
  return true;
})();

// Step 1 perf (2026-07-08) — freeze static EnvCell matrices. Default ON;
// `?freezeStaticMatrix=off` restores per-frame matrix updates. Interior cell
// geometry (walls/floors/props + fixed torch point lights) never moves, but
// three's per-frame `updateMatrixWorld` still traversed all of it — ~8% of the
// frame at a dense hub (a CPU profile at Town Network: `updateMatrixWorld` 7.7%,
// cellsGroup ≈ 1,100 of ~2,900 scene nodes). When ON, each cell container's
// world matrix is computed once at attach (ancestor-safe via
// updateWorldMatrix(true,true)) then `matrixWorldAutoUpdate=false` makes three
// skip the whole subtree every frame. SAFE: interior animated scenery +
// default-script particles live in `staticsGroup` (world-frame), NOT under the
// cell container, so they still animate.
const FREEZE_STATIC_MATRIX = (() => {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.search) {
      const raw = new URLSearchParams(globalThis.location.search).get("freezeStaticMatrix");
      if (raw === "off" || raw === "0" || raw === "false") return false;
    }
  } catch (_) {}
  return true;
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

// Session-monotonic EnvCell build tokens (see `buildGen` in
// buildEnvCellsForLandblock). Must never be reissued for the same lbKey.
let _envCellBuildSeq = 0;

// ─────────────────────────────────────────────────────────────────
// `?envcellUrgent=on` — DEFAULT OFF. Strict `=== "on"` opt-in (an
// absent param is OFF; see docs/url-flags.md on the `!== "off"`
// footgun).
//
// BUG-2 (2026-08-04, interiors arrive minutes after the outdoors).
// The 2026-07-02 "streamFix urgent lane" gave every OUTDOOR per-LB
// baker a player-proximity urgency hint that it threads into its wasm
// fetches — statics.js:1837/:1963-1969, buildings.js:744/:864-869,
// terrain_ring.js:116-124 all do
//   `const urgent = isNearPlayerLb(scene3d, lbKey)`
//   `const spFetch = (dids) => spFetchRaw(dids, urgent)`.
// The interior path never got it. On the Rust side only the EnvCell
// RECORD prefetch is urgent (lib.rs `fetch_env_cells_in_landblock`
// :20448/:20473/:20511/:20539 call `prefetch_urgent`); the two stages
// the visible geometry actually blocks on —
//   Step B  `materialCache.preload(cellSurfaceDids, spFetch)`
//   Step C  `mmFetch(uniqueStaticDids)` + its own surface preload
// — were called with NO trailing `urgent`, so `fetch_surfaces_pixels` /
// `fetch_model_meshes` took `urgent.unwrap_or(false)` (lib.rs:12055)
// and every one of their shard rounds went out on the NORMAL lane:
//   • `fetch_sem.acquire()` FIFO, 32 permits SPLIT across the main
//     wasm instance and the bake worker (concurrency.rs:19-29, :49),
//     shared with the speculative outdoor ring flood;
//   • `FetchPriority::Low` on the browser fetch itself
//     (manifest_source.rs:742-753) — the browser then deprioritises
//     them behind every outdoor shard;
//   • lane 1/2 instead of lane 0 in the bake-worker dispatch queue
//     (bake_worker_client.js:439-447, laneForBakeMessage :699-701).
// `prefetch.rs::run_walk_loop` runs up to 8 SEQUENTIAL discovery rounds
// (:375, Setup→GfxObj→Surface→SurfaceTexture→RenderSurface→Palette),
// each at least one full RTT, so over a high-latency cloudflared tunnel
// the interior build is round-trip bound AND queued last.
//
// ON: thread the same `isNearPlayerLb` hint the outdoor bakers use into
// the EnvCell bake's two fetchers. No new requests, no new queue — the
// same batches move to the lane that already exists for exactly this
// ("the player is IN this landblock; its interior is player-blocking").
// Behind a flag because it reprioritises streaming; promote to on-when-
// absent once a live capture confirms the interior latency drop.
const ENVCELL_URGENT_ON = (() => {
  try {
    return (
      new URLSearchParams(globalThis.location?.search || "").get("envcellUrgent")
      ?.toLowerCase() !== "off"
    );
  } catch (_) {
    return false;
  }
})();

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
      (CELL_STATIC_BIAS
        ? materialCache.getCachedStaticBias(groups[i].surfaceDid >>> 0)
        : materialCache.getCached(groups[i].surfaceDid >>> 0)) || materialCache.fallbackMaterial,
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
  const mmFetchRaw = modelMeshFetcher(wasmExports);
  const spFetchRaw = surfacePixelsFetcher(wasmExports);
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

  // Perf C1 — EnvCell surface-mesh fusion: fuse all surface BufferGeometries
  // within a cell into a single (or two — split when the cell mixes opaque +
  // transparent) `THREE.Mesh` with a parallel materials array and
  // `addGroup(start, count, materialIndex)`. Three.js binds the correct
  // material per group automatically. Each cell drops from N draws to 1 (or
  // 2), killing the 96–832 per-frame material binds indoor measurements
  // report at Academy PVS depth.
  //
  // W3 net-fixwave (2026-07-10, A08-5): default-ON for EVERY url, including
  // BARE ones. The old reader defaulted the `let` to false and only read the
  // flag inside an `if (location.search)` PRESENCE guard — so fusion was ON
  // whenever ANY query string was present (every fleet A/B and probe ran it)
  // but OFF on a bare field URL: every prior bare-URL measurement ran a
  // config no probe ever exercised. `?envcellFusion=off` (also 0/false)
  // disables.
  let envcellFusion = true;
  try {
    if (typeof globalThis !== "undefined" && globalThis.location) {
      const v = new URLSearchParams(globalThis.location.search || "")
        .get("envcellFusion")?.toLowerCase();
      envcellFusion = !(v === "off" || v === "0" || v === "false");
    }
  } catch (_) {
    envcellFusion = true;
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
  // `?envcellUrgent=on` (see ENVCELL_URGENT_ON above) — close the bake's lane
  // over both fetchers, exactly as statics.js:1963-1969 does for the outdoor
  // props. `isNearPlayerLb` is Chebyshev<=1, i.e. the player's own 3x3, and is
  // itself fail-soft `false` (and `?streamFix=off`-aware). Flag OFF => the
  // trailing arg is `false`, which is what `Option<bool>` already defaulted to,
  // so the off-path is byte-identical to pre-fix.
  const urgent = ENVCELL_URGENT_ON && isNearPlayerLb(scene3d, lbKey);
  const mmFetch = (ids) => mmFetchRaw(ids, urgent);
  const spFetch = (dids) => spFetchRaw(dids, urgent);
  if (scene3d.envCellLoadedLbs.has(lbKey)) {
    // Phase 9a warm-park: the loaded mark stays set while parked, so this
    // idempotent short-circuit is the envcell unpark seam (mirrors the
    // terrain/buildings/statics fast-paths in index.js).
    try {
      if (scene3d.landblockLru?.isParked?.(lbKey)) scene3d.landblockLru.unpark(lbKey);
    } catch (_) {}
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
  // 2026-08-03 — the token is drawn from a SESSION-MONOTONIC sequence, not
  // from the map. Deriving it from `get(lbKey) | 0` restarted the count at 1
  // after every evict (evict DELETES the entry), so the next build was handed
  // the cancelled build's own token: its attach guard matched, both builds
  // attached, and the loser's containers were orphaned in cellsGroup outside
  // `cellContainers3d` (unevictable) — plus its `finally` cleared the winner's
  // in-flight marker. A number that is never reissued cannot alias.
  const buildGen = ++_envCellBuildSeq;
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
          staticMatByDid.set(
            id,
            CELL_STATIC_BIAS
              ? scene3d.materialCache.getCachedStaticBias(dom)
              : scene3d.materialCache.getCached(dom),
          );
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
      // RND-04: cell-wide, because material choice and the fused attribute
      // must agree (see cellMaterialFor). `VERTEX_BAKE.enabled` short-circuits
      // so `?vertexBake=off` never even looks at the attribute.
      const cellBaked =
        VERTEX_BAKE.enabled &&
        snap.surfaceGroups.length > 0 &&
        snap.surfaceGroups.every((g) => g.geometry.getAttribute("acBakedLight"));
      // RND-04 handshake with lighting.js: the pool only drops interior
      // static lights once a real baked attribute has been seen, so a wasm
      // bundle without the bake leaves dungeon lighting exactly as it was.
      if (cellBaked) scene3d._acVertexBakeActive = true;
      for (const g of snap.surfaceGroups) {
        const mat = cellMaterialFor(scene3d, g, cellBaked);
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
        // RND-04: fuse the baked colours alongside. ALL-OR-NOTHING per bucket
        // — a partially-baked fusion would feed (0,0,0) to the un-baked runs,
        // which under the suppress-direct arm renders them black.
        const mergedBaked = cellBaked ? new Uint8Array(totalVerts * 3) : null;

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
          if (mergedBaked) {
            mergedBaked.set(
              srcGeom.getAttribute("acBakedLight").array,
              vertexOffset * 3,
            );
          }

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
        if (mergedBaked) {
          fused.setAttribute(
            "acBakedLight",
            new THREE.BufferAttribute(mergedBaked, 3, true),
          );
        }
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
      const cellBakedUnfused =
        VERTEX_BAKE.enabled &&
        snap.surfaceGroups.length > 0 &&
        snap.surfaceGroups.every((g) => g.geometry.getAttribute("acBakedLight"));
      if (cellBakedUnfused) scene3d._acVertexBakeActive = true;
      for (const g of snap.surfaceGroups) {
        const mat = cellMaterialFor(scene3d, g, cellBakedUnfused);
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
          // 2026-07-07 leak fix: thread the LB (as the animated sibling does at
          // :876) so the interior owner key can be `static:<lbKey>` and LB
          // eviction reaps these emitters via `_evictStaticParticlesForLb`.
          landblockId,
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
    // ST8 W6 registration (?frameWork): the 6 ms chunk loop is unchanged;
    // only the resume moves under the global P4 cap when the flag is ON.
    if (envcellTimeSlice && (performance.now() - _chunkStart) > ENVCELL_BUILD_BUDGET_MS) {
      await frameWorkW6Yield("cellsBuild", performance.now() - _chunkStart);
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
  if (newCells.length > 0 && renderer && camera && typeof renderer.compile === "function") {
    const tempParent = new THREE.Group();
    for (const { container } of newCells) tempParent.add(container);
    try {
      // guardedCompileAsync (bake_prewarm.js, P6 hardening 2026-07-10): same
      // semantics as renderer.compileAsync but a material disposed mid-link
      // (sealed purge racing the warm) counts as done instead of throwing an
      // uncatchable TypeError inside three's own ready-poll timer.
      await guardedCompileAsync(renderer, tempParent, camera, scene3d.scene);
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
    // Step 1 perf (2026-07-08) — freeze the static interior's matrices. The
    // cell walls/floors/props + fixed torch lights never move, so skip their
    // per-frame updateMatrixWorld (see FREEZE_STATIC_MATRIX). Compute the world
    // matrix ONCE now — updateWorldMatrix(true,…) walks ancestors first, so this
    // is correct regardless of whether the render loop has updated worldRoot yet
    // this frame — then stop three from re-composing the subtree each frame.
    // Cell VISIBILITY still toggles freely (that never touches the matrix), and
    // animated scenery/particles live in staticsGroup, not here.
    if (FREEZE_STATIC_MATRIX) {
      container.updateWorldMatrix(true, true);
      container.matrixWorldAutoUpdate = false;
    }
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
    }).then((r) => {
      // 2026-08-03 (#7 follow-up) — re-freeze what the animated builder could
      // not turn into a live node (over-cap / build failure / pre-rebuild
      // pkg). The peel above SKIPPED these props' frozen meshes, so without
      // this they render nowhere; the interior contract matches statics.js's
      // — a prop is at worst STATIC, never invisible.
      const failed = Array.isArray(r?.failed) ? r.failed : [];
      if (failed.length === 0) return;
      // Residency check: the attach is fire-and-forget, so the LB may have
      // been evicted while it ran — the containers are gone and a
      // re-approach rebuilds from scratch.
      if (scene3d.envCellBuildGen.get(lbKey) !== buildGen) return;
      const shadow = !!scene3d.shadowsEnabled || !!scene3d.csmEnabled;
      let refrozen = 0;
      for (const p of failed) {
        const container = cellContainerById.get(p.sourceObjIdx >>> 0);
        const geom = staticGeomByDid.get(p.objId >>> 0);
        if (!container || !geom) continue;
        const mat = staticMatByDid.get(p.objId >>> 0) || scene3d.materialCache.fallbackMaterial;
        const m = new THREE.Mesh(geom, mat);
        m.name = `cellstatic-${(p.sourceObjIdx >>> 0).toString(16).padStart(8, "0")}-${(p.objId >>> 0).toString(16).padStart(8, "0")}`;
        if (shadow) {
          m.castShadow = Array.isArray(mat)
            ? mat.some((sub) => materialCanCastShadow(sub))
            : materialCanCastShadow(mat);
          m.receiveShadow = true;
        }
        const xform = placementToMatrix4(p);
        xform.decompose(m.position, m.quaternion, m.scale);
        m.userData = {
          cellId: p.sourceObjIdx >>> 0,
          modelId: p.objId >>> 0,
          isCellStatic: true,
        };
        // Match the attach-time container state: layer 1 (cells render
        // layer) and a one-shot world-matrix compose (the container is
        // matrix-frozen, but its own matrixWorld is already correct).
        m.layers.set(1);
        container.add(m);
        m.updateWorldMatrix(false, false);
        if (typeof container.userData?.peeledAnimated === "number") {
          container.userData.peeledAnimated -= 1;
        }
        refrozen += 1;
      }
      if (refrozen > 0) {
        // eslint-disable-next-line no-console
        console.info(`[envcell] re-froze ${refrozen} interior scenery prop(s) the animated builder dropped`);
      }
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

  // Fix B (2026-07-02) — `?outdoorPview=off` rollback escape for the
  // outdoor portal-clipped interior walk (default ON in the wasm).
  // One-time, typeof-guarded: a stale pkg without the export degrades
  // to its built-in behaviour silently (F18-2 policy).
  if (!scene3d._outdoorPviewFlagSent) {
    scene3d._outdoorPviewFlagSent = true;
    try {
      if (
        typeof sessionHandle.setOutdoorPview === "function" &&
        new URLSearchParams(globalThis.location?.search || "").get("outdoorPview") === "off"
      ) {
        sessionHandle.setOutdoorPview(false);
      }
    } catch (_) {}
  }

  // 2026-07-05 (?stablist) — retail SeenOutside outdoor visibility: admit
  // frustum-visible SeenOutside interior cells to the outdoor render set so a
  // building's static content (furniture/fountains) renders from an outdoor
  // camera, not just the server NPCs. One-time, typeof-guarded (stale pkg
  // degrades silently). Default OFF in the wasm — unclipped, so multi-story
  // satellite cells can float until the portal clip lands.
  if (!scene3d._stablistFlagSent) {
    scene3d._stablistFlagSent = true;
    try {
      if (typeof sessionHandle.setStablistRender === "function") {
        // DEFAULT ON (user-validated 2026-07-05): a building's interior static
        // content renders from an outdoor camera. Off-escape: `?stablist=off`.
        // The wasm setter's own default is false, so JS drives the default here
        // each session (the conservative floating-satellite cull in
        // get_render_set_with_frustum keeps sky-floaters out). Typeof-guarded so
        // a stale pkg without the export degrades to the wasm default (off).
        const on =
          new URLSearchParams(globalThis.location?.search || "").get(
            "stablist",
          ) !== "off";
        sessionHandle.setStablistRender(on);
      }
    } catch (_) {}
  }

  let cellId = 0;
  let renderSetArr = null;
  let isIndoor = false;
  // PERF (2026-08-04): the `?indoorDepthSplit` narrowing below needs the SAME
  // portal walk this block already runs, composed from the SAME MVP. Stash it
  // so the armed path reuses it instead of paying a second
  // `getRenderSetWithPView` (a depth-8 portal-clipped BFS) every frame.
  let pviewSetThisTick = null;
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
          pviewSetThisTick = pviewSet ?? null;
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

  // ---- ?indoorDepthSplit arm (2026-08-04) — see the flag block up top ----
  //
  // Decides ONE boolean per frame and publishes it to the atmosphere pipeline,
  // which turns it into retail's `PView::DrawCells` structure (world pass →
  // depth clear → cells pass). When armed we also narrow the cell set to the
  // portal walk — retail's `cell_draw_list` (acclient.c:461450) — because the
  // 2026-05-29 see-through was the frustum/stablist admissions painting through
  // the wiped depth, not the wipe itself.
  //
  // Every step is guarded and every failure path leaves `splitArmed = false`,
  // so a stale `pkg/` (no `terrainHeightAt`), a pre-spawn frame, or a throwing
  // getter all degrade to today's exact behaviour.
  let splitArmed = false;
  let splitReason = INDOOR_DEPTH_SPLIT === "off" ? "flag-off" : (isIndoor ? "" : "not-indoor");
  if (INDOOR_DEPTH_SPLIT !== "off" && isIndoor) {
    if (INDOOR_DEPTH_SPLIT === "on" || INDOOR_DEPTH_SPLIT === "retail") {
      // ROUND 5 — ARM ON "CURRENT CELL IS INDOOR", full stop.
      //
      // Round 4 additionally required the player to be BELOW terrain. That
      // fixed the fully-inside case but left the reported gap: standing at
      // entry level ABOVE a below-ground room, the player is above grade so the
      // gate declined — yet the room below IS visible down its stairwell and
      // still got painted over by terrain.
      //
      // The below-terrain clause was only ever a proxy for "the 2026-05-29
      // see-through cannot recur". That guarantee no longer lives in the ARM
      // gate — it lives in the CONTENT narrowing that rounds 2-3 added: the
      // cells pass is restricted to the portal set (retail `cell_draw_list`)
      // and the re-layering is restricted to the player's own landblock. With
      // those in place, arming on the retail condition (`viewer.objcell_id &
      // 0xFFFF >= 0x100`, acclient.c:144889) is both correct and sufficient,
      // and it closes the entry-level gap because standing in a building's
      // entry IS an EnvCell.
      //
      // `=strict` keeps the round-4 below-terrain-only behaviour as the A/B
      // escape if the see-through ever returns.
      splitArmed = true;
      const sh = heightSamplerFor(sessionHandle);
      const pp = sh ? playerAcPosition(sessionHandle) : null;
      const pBelow = !!(sh && pp && isCameraBelowTerrain(sh, pp.x, pp.y, pp.z, INDOOR_SPLIT_BELOW_TERRAIN_M));
      splitReason = `indoor-cell(playerBelowTerrain=${pBelow})`;
    } else {
      // DEFECT 1 (round 4): arm if EITHER the player OR the camera is below
      // grade. Round 3 tested the camera alone, which in third person trails
      // ABOVE the surface while the player stands in a sunken shop — the
      // reported "no difference". The player test is the primary one (it is
      // what "am I in a below-grade room" actually means); the camera test is
      // kept so a first-person / clipped-into-the-hill camera still arms.
      const cam = scene3d.cameraSwitcher?.activeCamera ?? scene3d.camera ?? null;
      const wr = scene3d.worldRoot ?? null;
      const sampleHeight = heightSamplerFor(sessionHandle);
      if (sampleHeight) {
        const pp = playerAcPosition(sessionHandle);
        if (pp && isCameraBelowTerrain(sampleHeight, pp.x, pp.y, pp.z, INDOOR_SPLIT_BELOW_TERRAIN_M)) {
          splitArmed = true;
          splitReason = "player-below-terrain";
        } else if (
          acCameraFrame(cam, wr) &&
          isCameraBelowTerrain(sampleHeight, _acCamVec.x, _acCamVec.y, _acCamVec.z, INDOOR_SPLIT_BELOW_TERRAIN_M)
        ) {
          splitArmed = true;
          splitReason = "camera-below-terrain";
        } else {
          // Capture WHY we declined, so the one console line below is
          // actionable instead of just "not armed".
          const h = pp ? sampleHeight(pp.x, pp.y) : null;
          splitReason =
            !pp ? "no-player-pose"
            : h == null || !Number.isFinite(h) ? "terrain-height-unknown"
            : `above-terrain(playerZ=${pp.z.toFixed(1)} terrainZ=${Number(h).toFixed(1)})`;
        }
      } else {
        splitReason = "no-terrainHeightAt-export";
      }
    }
  }
  // One line per TRANSITION (never per frame) so the user can simply paste
  // their console back. Covers both the armed and the declined case — a
  // silent "nothing happened" is what cost us rounds 1-3.
  // Module-level (not on scene3d) so a scene rebuild cannot silently reset it
  // and swallow the first transition. Also mirrored to `window.__indoorDepthSplit`
  // so the state can be READ on demand instead of waiting for a transition —
  // one more way for the diagnostic to survive a filtered console.
  if (INDOOR_DEPTH_SPLIT !== "off") {
    try {
      globalThis.__indoorDepthSplit = {
        build: INDOOR_SPLIT_BUILD,
        mode: INDOOR_DEPTH_SPLIT,
        armed: splitArmed,
        reason: splitReason,
        indoor: isIndoor,
        cell: `0x${(cellId >>> 0).toString(16)}`,
        relayered: scene3d._splitRelayered === true,
        relayerDiag: scene3d._splitRelayerDiag ?? null,
        path: scene3d.skyDome?._indoorSplitPath ?? null,
      };
    } catch (_) {}
  }
  if (INDOOR_DEPTH_SPLIT !== "off" && _indoorSplitLastLog !== `${splitArmed}|${splitReason}`) {
    _indoorSplitLastLog = `${splitArmed}|${splitReason}`;
    try {
      // eslint-disable-next-line no-console
      console.log(
        `[indoorDepthSplit] ${splitArmed ? "ARMED" : "disarmed"} (${splitReason}) ` +
        `mode=${INDOOR_DEPTH_SPLIT} indoor=${isIndoor} cell=0x${(cellId >>> 0).toString(16)}`,
      );
    } catch (_) {}
  }
  if (splitArmed) {
    // Retail `cell_draw_list`: the portal-clipped BFS from the viewer's own
    // cell (`PView::ConstructView`, acclient.c:462423), UNIONed with the cheap
    // depth-1 snapshot BFS so a cell whose portal has a vertex behind the near
    // plane (which `getRenderSetWithPView` conservatively skips) isn't lost.
    // NOT the frustum set — that is what painted downhill cottages through
    // terrain in 2026-05-29.
    try {
      const portalSet = new Set();
      const bfs = sessionHandle.getRenderSet(1);
      if (bfs) for (const v of bfs) portalSet.add(v >>> 0);
      // PERF: reuse the walk the visibility block above already ran off the
      // IDENTICAL MVP (projection · matrixWorldInverse · worldRoot.matrixWorld)
      // — same camera, same frame, same result. Only fall back to a fresh call
      // when that block did not run (no frustum export / camera not wired /
      // it threw), which is exactly the pre-2026-08-04 behaviour.
      if (pviewSetThisTick) {
        for (const v of pviewSetThisTick) portalSet.add(v >>> 0);
      } else if (typeof sessionHandle.getRenderSetWithPView === "function") {
        const cam = scene3d.cameraSwitcher?.activeCamera ?? scene3d.camera ?? null;
        const wr = scene3d.worldRoot ?? null;
        if (cam?.projectionMatrix && cam.matrixWorldInverse && wr) {
          const mvp = _mvpScratch ?? (_mvpScratch = new Float32Array(16));
          const m = _mvpMatrixScratch ?? (_mvpMatrixScratch = new THREE.Matrix4());
          m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
          m.multiply(wr.matrixWorld);
          for (let i = 0; i < 16; i++) mvp[i] = m.elements[i];
          const pv = sessionHandle.getRenderSetWithPView(mvp, 0);
          if (pv) for (const v of pv) portalSet.add(v >>> 0);
        }
      }
      portalSet.add(cellId >>> 0); // never lose the "where am I" anchor
      if (portalSet.size) renderSetArr = Array.from(portalSet);
      else splitArmed = false; // nothing to draw → don't wipe depth for nothing
    } catch (_) {
      splitArmed = false;
    }
  }
  // Apply / undo the buildings+statics re-layering that makes the armed split
  // mean "terrain" vs "everything else" (see SPLIT_RELAYER_GROUPS above).
  // Idempotent and transition-driven: a steady armed frame with no streaming
  // does ZERO traverses.
  const wasRelayered = scene3d._splitRelayered === true;
  const splitLbKey = (cellId & 0xffff0000) >>> 0;
  if (splitArmed) {
    const sig = _splitGroupSignature(scene3d);
    scene3d._splitRelayerTick = ((scene3d._splitRelayerTick | 0) + 1) | 0;
    const backstopDue =
      scene3d._splitRelayerTick % SPLIT_RELAYER_BACKSTOP_TICKS === 0;
    const lbChanged = scene3d._splitRelayerLb !== splitLbKey;
    if (lbChanged && wasRelayered) {
      // Walked/teleported to a new LB while armed — put the OLD landblock back
      // before hoisting the new one, or its buildings stay stranded on layer 1.
      _stampSplitLayers(scene3d, RENDER_LAYER_WORLD, scene3d._splitRelayerLb >>> 0, true);
    }
    if (!wasRelayered || lbChanged || sig !== scene3d._splitRelayerSig || backstopDue) {
      // `force` only on the transitions and the periodic backstop; the
      // signature-driven re-entries (one per streaming add, i.e. most frames
      // while a town settles) ride the per-node `__splitLayer` tag and touch
      // only geometry that actually arrived.
      _stampSplitLayers(
        scene3d,
        RENDER_LAYER_INDOOR,
        splitLbKey,
        backstopDue || lbChanged || !wasRelayered,
      );
      scene3d._splitRelayerSig = sig;
      scene3d._splitRelayerLb = splitLbKey;
      scene3d._splitRelayered = true;
    }
  } else if (wasRelayered) {
    _stampSplitLayers(scene3d, RENDER_LAYER_WORLD, scene3d._splitRelayerLb >>> 0, true);
    scene3d._splitRelayered = false;
    scene3d._splitRelayerSig = -1;
    scene3d._splitRelayerLb = 0;
  }
  // DEFECT 3 is no longer handled here. The per-tick staticsGroup sweep that
  // used to live at this point is RETIRED (2026-08-04): interior particles now
  // get the INDOOR layer at EMISSION time, from the one call site that knows
  // the emitter is interior-anchored — statics.js `_runStaticParticleChain`
  // derives `renderLayer` from the anchor's `isCellStaticScriptAnchor` and
  // passes it in `addEmitter(req)`, which stamps each slot mesh in the
  // manager's meshFactory and keys instanced buckets by (gfxobj, layer).
  // That is scoped to interior emitters, so outdoor torches/swamp mist keep
  // layer 0 and correctly do NOT bleed through a punched doorway — the
  // over-hoisting exposure that kept the sweep default-OFF. `?indoorParticleLayer=off`
  // still disables the whole mechanism (read in statics.js).
  scene3d._indoorSplitArmed = splitArmed;
  try {
    scene3d.atmospherePipeline?.setIndoorSplitArmed?.(splitArmed);
  } catch (_) {}

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
  //
  // Step 1b (2026-07-08) — sealed-dungeon exception. The Phase 5 keep-
  // visible rule exists for the cottage-DOORWAY case: an opening through
  // which the landscape is seen. A fully-enclosed hub dungeon (Town
  // Network et al.) has no opening, so keeping terrain/buildings/statics
  // visible draws its ocean + 416 m mountain-wall skirt every frame for
  // nothing (retail's PVS from a sealed cell is interior-only — proven:
  // pvs-visibility-snapshot 0x00070143 = 205 interior / 0 surface cells).
  // Hide the outdoor groups when indoor AND the dungeon has no outdoor-
  // facing portal. Re-checked per frame while indoor: the wasm side is a
  // ~140-entry integer scan, far cheaper than a single terrain draw call,
  // and it returns "keep visible" until the cell set loads (no entry-time
  // flicker at a mouthed dungeon). `?sealedCull=off` disables. When the
  // export is missing (stale pkg) the typeof guard leaves terrain visible.
  let wantOutdoorVisible = true;
  if (
    SEALED_CULL_ENABLED &&
    isIndoor &&
    typeof sessionHandle.currentDungeonHasOutdoorPortal === "function"
  ) {
    try {
      wantOutdoorVisible = !!sessionHandle.currentDungeonHasOutdoorPortal();
    } catch (_) {
      wantOutdoorVisible = true;
    }
  }
  if (scene3d.terrainGroup && scene3d.terrainGroup.visible !== wantOutdoorVisible) {
    scene3d.terrainGroup.visible = wantOutdoorVisible;
  }
  if (scene3d.buildingsGroup && scene3d.buildingsGroup.visible !== wantOutdoorVisible) {
    scene3d.buildingsGroup.visible = wantOutdoorVisible;
  }
  if (scene3d.staticsGroup && scene3d.staticsGroup.visible !== wantOutdoorVisible) {
    scene3d.staticsGroup.visible = wantOutdoorVisible;
  }

  // Step 1c (2026-07-08) — sealed-dungeon RESIDENCY reclaim. Hiding the
  // outdoor groups (above) kills the DRAW cost, but the surrounding ocean-
  // skirt + mountain-wall terrain/statics stay BAKED and are walked every
  // frame (a sealed hub kept ~127 LBs / millions of resident tris → the main
  // thread pegged, the "still very bad in Town Network" report). Publish the
  // sealed state so the two residency systems reclaim it: `tickPvsLoadExpansion`
  // drops its prefetch skirt to radius 0 (nothing outdoor re-bakes) and the
  // LRU eviction tick (index.js) purges every resident LB except the dungeon's
  // own. `_sealedEvictLbKey` is the dungeon's LB key when the reclaim should
  // run (0 = don't). Gated by ?sealedEvict (default on); requires the
  // ?sealedCull detection (`wantOutdoorVisible === false` ⇒ sealed).
  const sealed = SEALED_CULL_ENABLED && isIndoor && !wantOutdoorVisible;
  scene3d._sealedEvictLbKey =
    sealed && SEALED_EVICT_ENABLED ? (cellId & 0xffff0000) >>> 0 : 0;

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

// Portal-stencil feed (2026-07-05, ?portalStencil). Runs each frame AFTER
// tickCellVisibility3D: when OUTDOORS, hands the PortalStencilPass (a) the
// wasm-computed door/window aperture polygons for the current view and (b) the
// portal-visible interior cell containers to draw through them. The pass is
// null when the flag is off → this whole function no-ops. Milestone 1: outdoor
// only (indoor cells render normally in the world pass). See portal_stencil.js
// + docs/RETAIL-PORTAL-RENDERER-AND-CELL-TERRAIN-WATER-RELATIONSHIPS.md.
const _psMvp = new THREE.Matrix4();
const _psMvpArr = new Float32Array(16);
/**
 * Terrain line-of-sight memo for `tickPortalPunch`'s `clipAperturesForPunch`
 * call (see `makeLosCache` in portal_clip.js). Module-scoped: there is exactly
 * one punch pass per client, and the cache keys are AC world coordinates, so a
 * scene rebuild cannot make an entry mean something different.
 */
const _punchLosCache = makeLosCache();

// Near-plane aperture cull (2026-07-06). `getVisiblePortalApertures` emits RAW
// world-space aperture polygons with no near-plane clip and no sidedness check
// (unlike retail's `ConstructView` sidedness + `DrawPortalPolyInternal`
// `polyClipFinish`, and unlike our own near-plane-clipped `getRenderSetWithPView`).
// When the camera is close to / past a doorway some aperture vertices fall behind
// the near plane; the punch pass (`depthFunc=Always`, `frustumCulled=false`) then
// rasterizes the near-plane-straddling polygon over a HUGE screen area → near
// terrain/statics get FAR-punched and the cells pass overdraws them → geometry
// DISAPPEARS as you walk up to a building (real GPUs; SwiftShader clipped the
// degenerate poly and hid the bug — verified live: 2/14 apertures behind near at
// 0.4 m). Drop any aperture with a vertex within the near plane so the punch only
// covers well-formed, fully-in-front doorways; distant apertures (the actual
// terrain-over-entrance reveal) are untouched. `clip.w` = view-forward metres.
const _APERTURE_NEAR_CULL_M = 0.2; // > camera.near (0.1); margin for fp slop
function nearPlaneCullApertures(flat, mvpArr) {
  if (!flat || flat.length < 1) return flat;
  const e = mvpArr;
  let k = 0;
  const count = flat[k++] | 0;
  if (count <= 0) return flat;
  const out = [0];
  let kept = 0;
  for (let a = 0; a < count; a++) {
    const nv = flat[k++] | 0;
    const start = k;
    let minW = Infinity;
    for (let v = 0; v < nv; v++) {
      const x = flat[k], y = flat[k + 1], z = flat[k + 2];
      k += 3;
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (w < minW) minW = w;
    }
    if (nv >= 3 && minW > _APERTURE_NEAR_CULL_M) {
      out.push(nv);
      for (let i = 0; i < nv * 3; i++) out.push(flat[start + i]);
      kept++;
    }
  }
  out[0] = kept;
  return out;
}
// Move an interior cell container's whole subtree between its home layer
// (RENDER_LAYER_INDOOR=1, drawn by the world pass) and the portal-cell layer
// (RENDER_LAYER_PORTAL_CELL=2, drawn ONLY by the stencil pass, masked).
function _setCellLayer(container, layer) {
  container.traverse((o) => o.layers.set(layer));
}
export function tickPortalStencil(scene3d, sessionHandle) {
  const pass = scene3d?._portalStencilPass;
  if (!pass || !sessionHandle) return;
  if (typeof sessionHandle.getVisiblePortalApertures !== "function") return;

  // Containers currently parked on the portal-cell layer, so we can move them
  // back to layer 1 when they leave the set / the player goes indoors.
  const moved = scene3d._portalMovedCells ?? (scene3d._portalMovedCells = new Set());
  const restoreAll = () => {
    if (moved.size) {
      for (const c of moved) _setCellLayer(c, 1); // RENDER_LAYER_INDOOR
      moved.clear();
    }
  };

  // The pass disabled itself after a render error → behave as if the flag were
  // off: un-park every cell (the world pass draws them again — interiors stay
  // visible via the default path) and stop feeding the pass.
  if (pass._errored) {
    pass.setApertures(null);
    pass.setCells([]);
    restoreAll();
    return;
  }

  let indoor = false;
  try {
    indoor = !!sessionHandle.isCurrentCellIndoor?.();
  } catch (_) {}
  const camera = scene3d.cameraSwitcher?.activeCamera ?? scene3d.camera ?? null;
  const worldRoot = scene3d.worldRoot ?? null;
  // Keep the pass drawing with the ACTIVE camera (ortho/persp switch safe).
  if (camera) pass.mainCamera = camera;

  // Milestone: outdoor only. Indoor (or no camera) → clear + un-park all cells
  // so the world pass draws them normally again.
  if (indoor || !camera?.projectionMatrix || !camera.matrixWorldInverse || !worldRoot) {
    pass.setApertures(null);
    pass.setCells([]);
    restoreAll();
    return;
  }

  try {
    // Same MVP composition tickCellVisibility3D uses: fold worldRoot's AC→three
    // rotation in so the AC-space aperture verts project correctly.
    _psMvp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _psMvp.multiply(worldRoot.matrixWorld);
    for (let i = 0; i < 16; i++) _psMvpArr[i] = _psMvp.elements[i];

    // ROUND 5: prefer the export that carries the owning cell's AABB centre,
    // which is what makes retail's ConstructView sidedness reject possible
    // (fixes far-side doors being punched through the near wall). Typeof-guarded
    // — a stale `pkg/` falls back to v1 and simply loses that one gate.
    const hasV2 =
      typeof sessionHandle.getVisiblePortalAperturesWithCellCenter === "function";
    const flat = hasV2
      ? sessionHandle.getVisiblePortalAperturesWithCellCenter(_psMvpArr, 0)
      : sessionHandle.getVisiblePortalApertures(_psMvpArr, 0);
    pass.setApertures(nearPlaneCullApertures(flat, _psMvpArr));

    // Portal-visible interior cells (idx >= 0x100): PARK each on the portal-cell
    // layer (so the world pass skips it → no terrain-occluded double draw), and
    // un-park any that dropped out of the set this frame.
    const registry = scene3d.cellContainers3d;
    const cells = [];
    const wanted = new Set();
    if (registry instanceof Map) {
      for (const [cid, container] of registry) {
        if (!container?.visible) continue;
        if (((cid >>> 0) & 0xffff) < 0x100) continue; // interior cells only
        cells.push(container);
        wanted.add(container);
        if (!moved.has(container)) {
          _setCellLayer(container, RENDER_LAYER_PORTAL_CELL);
          moved.add(container);
        }
      }
    }
    if (moved.size > wanted.size) {
      for (const c of moved) {
        if (!wanted.has(c)) {
          _setCellLayer(c, 1); // RENDER_LAYER_INDOOR
          moved.delete(c);
        }
      }
    }
    pass.setCells(cells);
  } catch (_) {
    pass.setApertures(null);
    pass.setCells([]);
    restoreAll();
  }
}

// Portal-punch feed (2026-07-05, ?portalPunch). Runs each frame AFTER
// tickCellVisibility3D: when OUTDOORS, hands the PortalPunchPass the wasm-computed
// door/window aperture polygons for the current view. The pass punches depth to
// FAR inside them so the interior EnvCells (already on layer 1 and set visible by
// tickCellVisibility3D) win depth through the doorway when the atmosphere
// pipeline draws them in the INDOOR_ONLY cells pass. Unlike tickPortalStencil,
// this does NOT re-layer cells — the world/cells split does the masking. The pass
// is null when the flag is off → this whole function no-ops. Milestone: outdoor
// only (indoor cells render normally in the shared world pass).
/**
 * Stamp `_portalPunchDiag` on EVERY early-return path so `undefined` can only
 * ever mean "flag off, or stale bundle" — never "the tick silently bailed".
 * `reason` names the bail so one paste is self-describing.
 */
function _punchDiag(scene3d, reason, extra = null) {
  if (!scene3d || !PORTAL_PUNCH_FLAG_ON) return;
  scene3d._portalPunchDiag = {
    reason,
    offered: 0,
    kept: 0,
    dropped: { boundary: 0, backface: 0, straddle: 0, nearPlane: 0, project: 0, oversize: 0, terrain: 0 },
    rect: null,
    gates: { sidedness: PUNCH_SIDEDNESS, terrainLos: true, straddle: true },
    ...(extra || {}),
  };
}

export function tickPortalPunch(scene3d, sessionHandle) {
  const pass = scene3d?._portalPunchPass;
  if (!pass || !sessionHandle) {
    _punchDiag(scene3d, !sessionHandle ? "no-session" : "no-punch-pass(flag off?)");
    return;
  }
  if (typeof sessionHandle.getVisiblePortalApertures !== "function") {
    _punchDiag(scene3d, "stale-pkg-no-aperture-export");
    return;
  }
  // Pass disabled itself after a render error → stop feeding it; interiors fall
  // back to the default (occluded) world-pass draw and preFrameSkySync stops
  // splitting (its punchActive gate reads pass.hasApertures, cleared below).
  if (pass._errored) {
    pass.setApertures(null);
    _punchDiag(scene3d, "pass-errored");
    return;
  }

  let indoor = false;
  try {
    indoor = !!sessionHandle.isCurrentCellIndoor?.();
  } catch (_) {}
  const camera = scene3d.cameraSwitcher?.activeCamera ?? scene3d.camera ?? null;
  const worldRoot = scene3d.worldRoot ?? null;
  if (camera) pass.mainCamera = camera;

  // Outdoor only. Indoor / no camera → clear apertures so the split disarms and
  // the shared world pass draws interiors normally again.
  if (
    indoor ||
    !camera?.projectionMatrix ||
    !camera.matrixWorldInverse ||
    !worldRoot
  ) {
    pass.setApertures(null);
    // Indoors is the EXPECTED bail (the punch is an outdoor mechanism), but it
    // is also the single most likely explanation for "kept is always 0", so it
    // gets named rather than left silent.
    _punchDiag(scene3d, indoor ? "indoor(punch is outdoor-only)" : "no-camera-or-worldroot");
    return;
  }

  try {
    // Same MVP composition tickCellVisibility3D / tickPortalStencil use: fold
    // worldRoot's AC→three rotation in so the AC-space aperture verts project
    // correctly.
    _psMvp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _psMvp.multiply(worldRoot.matrixWorld);
    for (let i = 0; i < 16; i++) _psMvpArr[i] = _psMvp.elements[i];
    const flat = sessionHandle.getVisiblePortalApertures(_psMvpArr, 0);

    // OVER-PUNCH FIX (2026-08-04) — the 2026-07-06 R9-290 blackout.
    //
    // The old feed was `nearPlaneCullApertures`, which DROPS any aperture with
    // a vertex near the near plane and does nothing else. Retail's
    // `DrawPortalPolyInternal` (acclient.c:453882) runs four gates our port had
    // none of, and `clipAperturesForPunch` (scene3d/portal_clip.js) is the port
    // of all four:
    //   · the all-±12 LandCell-wall degenerate reject (:453919-453932);
    //   · `ACRender::polyClipFinish` (:453941) — CLIP against the near plane
    //     (retail `cdstW` ≈ 0.0999999, acclient.c:60530) rather than discard
    //     the whole doorway, plus `if (clip_pts >= 3)` (:453942);
    //   · a screen-area sanity clamp — retail's second polyClipFinish stage
    //     clips to the current portal-view POLYGON, which we cannot reproduce
    //     without a full PView port, so the clamp + the scissor below stand in
    //     for its bounding effect;
    //   · a terrain line-of-sight cull, standing in for
    //     `PView::ConstructView`'s sidedness reject (acclient.c:462513-462543),
    //     which we cannot port verbatim because `getVisiblePortalApertures`
    //     does not carry `portal_side`.
    //
    // Deliberately NOT a depth test against the world pass. Retail's punch is
    // `DEPTHTEST_ALWAYS` (:453953) and it has to be: the bug being fixed is
    // "terrain wrongly wins depth in front of the interior", so depth-testing
    // the aperture against that same buffer would reject exactly the apertures
    // that need punching. The bound is the CLIP, as it is in retail.
    let punchFlat = null;
    let punchRect = null;
    const nearPlane = acCameraFrame(camera, worldRoot)
      ? makeNearPlane(_acCamVec, _acFwdVec)
      : null;
    if (!nearPlane) _punchDiag(scene3d, "no-near-plane(degenerate camera)");
    if (nearPlane) {
      const res = clipAperturesForPunch(flat, _psMvpArr, {
        nearPlane,
        camAc: _acCamVec,
        sampleHeight: heightSamplerFor(sessionHandle),
        withCellCenter: hasV2 && PUNCH_SIDEDNESS,
        // PERF (2026-08-04): the terrain-LOS gate is 11 `terrainHeightAt`
        // wasm calls PER SURVIVING APERTURE PER FRAME — in a town that is
        // several hundred boundary crossings every frame, re-deriving an
        // answer that only changes when the camera moves. The memo is owned
        // here (module-scoped, one per client) so `clipAperturesForPunch`
        // stays a pure function for the unit tests.
        losCache: _punchLosCache,
      });
      if (res.kept > 0) {
        punchFlat = res.flat;
        punchRect = res.rect;
      }
      // ONE-PASTE DIAGNOSTIC. `kept > 0` with the interior visible is the
      // success condition; if `kept === 0` the `dropped` breakdown names the
      // exact gate responsible, and `gates` says which optional gates were even
      // running, so a single paste is self-describing.
      scene3d._portalPunchDiag = {
        reason: res.kept > 0 ? "ok" : "all-apertures-dropped",
        offered: (flat && flat.length ? flat[0] | 0 : 0),
        kept: res.kept,
        dropped: res.dropped,
        rect: res.rect,
        gates: {
          sidedness: !!(hasV2 && PUNCH_SIDEDNESS),
          sidednessExportPresent: hasV2,
          terrainLos: true,
          straddle: true,
        },
      };
    }
    pass.setApertures(punchFlat, punchRect);
  } catch (_) {
    pass.setApertures(null, null);
  }
}

/**
 * Portal-SEAL feed (2026-08-04 round 6, `?indoorDepthSplit`). The indoor twin of
 * `tickPortalPunch`: while the split is armed, hands the seal pass the current
 * view's outdoor-facing apertures so it can re-stamp them at TRUE depth between
 * the depth wipe and the cells pass — retail `PView::DrawCells` step 3
 * (`DrawPortalPolyInternal(portal, zClear=0)`, acclient.c:461536).
 *
 * PASS-SLOT CONTRACT this exists to make true (round-6 particle ordering):
 *   · layer-0 content — terrain, other-LB buildings/statics, and EVERY outdoor
 *     particle (particle meshes are plain scene-graph children of staticsGroup;
 *     there is NO separate particle render pass — zero `renderer.render()` calls
 *     under scene3d/particles or scene3d/vfx) — is drawn by the WORLD pass with
 *     world depth intact, and its colour inside the aperture is then PROTECTED
 *     by this seal.
 *   · layer-1 content — the interior shell, EnvCells, entities, and (once the
 *     emitter-side `renderLayer` threading lands) interior-anchored particles —
 *     is drawn by the CELLS pass against the interior's own fresh depth.
 * Without the seal, the wipe leaves layer-0 colour with no depth at all, so the
 * cells pass overpaints it even where it is genuinely nearer — which is the
 * reported doorway-full-of-fountain-blobs / interior-particles-missing frame.
 *
 * Deliberately NOT sidedness- or terrain-culled: retail seals every
 * outdoor-facing portal of the cells it draws, unconditionally. Only the
 * near-plane clip and the straddle drop apply (a doorway the camera is standing
 * in has no meaningful plane to seal).
 */
export function tickPortalSeal(scene3d, sessionHandle) {
  const pass = scene3d?.atmospherePipeline?.portalSealPass ?? null;
  if (!pass || !sessionHandle) return;
  if (typeof sessionHandle.getVisiblePortalApertures !== "function") return;
  if (pass._errored || !scene3d._indoorSplitArmed) {
    pass.setApertures(null, null);
    return;
  }
  const camera = scene3d.cameraSwitcher?.activeCamera ?? scene3d.camera ?? null;
  const worldRoot = scene3d.worldRoot ?? null;
  if (!camera?.projectionMatrix || !camera.matrixWorldInverse || !worldRoot) {
    pass.setApertures(null, null);
    return;
  }
  try {
    _psMvp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _psMvp.multiply(worldRoot.matrixWorld);
    for (let i = 0; i < 16; i++) _psMvpArr[i] = _psMvp.elements[i];
    const flat = sessionHandle.getVisiblePortalApertures(_psMvpArr, 0);
    const nearPlane = acCameraFrame(camera, worldRoot)
      ? makeNearPlane(_acCamVec, _acFwdVec)
      : null;
    if (!nearPlane) {
      pass.setApertures(null, null);
      return;
    }
    // No sampleHeight and no withCellCenter → terrain-LOS and sidedness are
    // skipped by construction, matching retail's unconditional seal.
    const res = clipAperturesForPunch(flat, _psMvpArr, {
      nearPlane,
      camAc: _acCamVec,
    });
    // The seal is a depth WALL, not a hole: no scissor. Bounding it to the
    // aperture rects would be harmless but pointless, and a wrong rect would
    // silently drop part of the wall.
    pass.setApertures(res.kept > 0 ? res.flat : null, null);
    scene3d._portalSealDiag = { kept: res.kept, dropped: res.dropped };
  } catch (_) {
    pass.setApertures(null, null);
  }
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
  let ringRadius =
    Number.isFinite(scene3d.pvsRingRadius) && scene3d.pvsRingRadius >= 0
      ? scene3d.pvsRingRadius | 0
      : 1;
  // Step 1a (2026-07-07) — indoor gate: a dungeon/interior can't see the
  // surface LBs the ring would pull, so at a hub dungeon the outdoor radius-5
  // ring (121 LBs) makes ~68 LBs resident and the per-frame statics tick O(that).
  // Collapse to INDOOR_PVS_RING_RADIUS indoors. The render-set (`seen`) is baked
  // regardless of ring radius, so anything the PVS actually sees (incl. surface
  // through a dungeon mouth) still loads. `isCurrentCellIndoor` is a cheap wasm
  // bool; only consulted when the gate could tighten the ring. Zero effect
  // outdoors (isIndoor=false). Fold into the fireSig below so an indoor↔outdoor
  // transition re-fires the sweep at the new radius.
  // Step 1c (2026-07-08) — sealed dungeon: NOTHING outdoor is visible (no
  // exterior portal), so prefetch nothing beyond the interior render-set.
  // Collapse the ring to 0 so the ocean-skirt / mountain-wall LBs never bake
  // (the LRU eviction tick reclaims any already resident). `_sealedEvictLbKey`
  // is published by `tickCellVisibility3D` (runs earlier this frame) and is
  // non-zero only when ?sealedCull + ?sealedEvict are on and the dungeon is
  // sealed. Takes precedence over the radius-1 indoor skirt below.
  if (scene3d._sealedEvictLbKey) {
    ringRadius = 0;
  } else if (ringRadius > INDOOR_PVS_RING_RADIUS) {
    let indoor = false;
    try {
      if (typeof sessionHandle.isCurrentCellIndoor === "function") {
        indoor = !!sessionHandle.isCurrentCellIndoor();
      }
    } catch (_) {
      indoor = false;
    }
    if (indoor) ringRadius = INDOOR_PVS_RING_RADIUS;
  }
  // Residency task #10 — authored-fog cap (see FOG_RING_CAP_ENABLED above).
  // `+1` keeps one LB of margin past full fog so the fogged edge itself is
  // always backed by real terrain (mirrors the fog-before-edge invariant
  // from the other side). Ceil quantizes the dawn/dusk lerp to LB steps, so
  // the fireSig churn during a transition is a handful of re-sweeps, not
  // per-frame. Applies AFTER the indoor/sealed collapses (never widens).
  if (FOG_RING_CAP_ENABLED && ringRadius > 1) {
    const fogMaxM = +scene3d._authoredFogMaxM;
    if (Number.isFinite(fogMaxM) && fogMaxM > 0) {
      const fogRadiusLb = Math.ceil(fogMaxM / 192) + 1;
      if (fogRadiusLb < ringRadius) ringRadius = fogRadiusLb;
    }
  }
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
