// scene3d/world_stream.js — A15-Q4 renderer-NEUTRAL world-streaming
// core (2026-06-12 unification survey, w3plus spec S3).
//
// Retail analog: world streaming is driven off the player's position
// INSIDE the renderer-neutral tick — CellManager::ChangePosition from
// SmartBox::UseTime (acclient.c:146256/:146278), cell prefetch
// (CellManager::PreFetchCells, acclient.c:146679) + outdoor landscape
// loadpoint (LScape::update_loadpoint, acclient.c:146695). Drawing is
// a separate pass (SmartBox::Draw). Our pre-Q4 shape buried exactly
// this work inside the 2D-named `handlePositionUpdate` local-player
// block (index.html) — load-bearing for BOTH renderers (terrain /
// buildings / statics / spawns / envcell streaming AND the wasm
// physics bakes that gate the integrator). This module is the verbatim
// extraction; it serves BOTH renderers under `?unifiedDispatch=on`.
//
// Pure factory module: no `window`, no DOM, no wasm imports — every
// environment touch is an injected dep, so the A1-O4 (`?singleDriver`)
// re-host can drive it from the scene3d rAF without edits.
//
// Behavioral invariants (each is a live bug if broken — S3 §3 Q4.1):
//   1. Call ORDER and gating exactly as the legacy block — terrain
//      ring is 3×3 with 0x00/0xff edge clamp; buildings / statics /
//      spawns / envcells are single-LB; all fire-and-forget (no await).
//   2. The four wasm bakes (ensure*) run regardless of the 2D
//      `liveScene` — the Workstream-G hoist rationale: that is what
//      keeps the 3D integrator from freezing on the spawn cell (the
//      indoor pre-bake gate; `cell_physics_index` /
//      `building_aabb_index` must populate for the spawn LB).
//   3. `landblockChanged` emits on the first known LB and every
//      transition, never on same-LB heartbeats.
//   4. Call-site Set fast-path checks (`!terrainPrefetchedLbs.has(...)`
//      etc.) are kept — the Sets are shared BY REFERENCE with
//      index.html (the ensure* helpers mutate them internally), so
//      helper-internal `.add()`s remain visible here.

/**
 * @param {object} deps
 * @param {function(): (number|null)} deps.getLocalPlayerGuid
 *   index.html closure `localPlayerGuid` accessor.
 * @param {function(number, number): void} deps.emitLandblockChanged
 *   wraps the `window.__pluginClient` "landblockChanged" emit.
 * @param {function} deps.ensureTerrainAroundLandblock   wasm heightmap
 *   bake (3×3 ring); the PIXI half self-gates on liveScene.
 * @param {function} deps.ensureBuildingAabbsAroundLandblock  pure wasm
 *   bake (3×3 ring), no PIXI work.
 * @param {function} deps.ensureCellContainersForLandblock  wasm
 *   cell_physics_index; the PIXI half self-gates on liveScene.
 * @param {function} deps.ensureLandblockObjectsForLandblock  2D-only;
 *   self-gates on `liveScene.outdoorContainer` (no-op in 3D).
 * @param {function(): (object|null)} deps.getLiveScene3d
 *   `window.liveScene3d` accessor (null pre-init3D / in 2D mode).
 * @param {Set<number>} deps.terrainPrefetchedLbs       shared by ref.
 * @param {Set<number>} deps.buildingAabbsPopulatedLbs  shared by ref.
 * @param {Set<number>} deps.cellContainersPopulatedLbs shared by ref.
 * @param {Set<number>} deps.objectsRenderAddedLbs      shared by ref.
 */
export function createWorldStreamer(deps) {
  const {
    getLocalPlayerGuid,
    emitLandblockChanged,
    ensureTerrainAroundLandblock,
    ensureBuildingAabbsAroundLandblock,
    ensureCellContainersForLandblock,
    ensureLandblockObjectsForLandblock,
    getLiveScene3d,
    terrainPrefetchedLbs,
    buildingAabbsPopulatedLbs,
    cellContainersPopulatedLbs,
    objectsRenderAddedLbs,
  } = deps;
  // Streamer-private replacement for index.html's module-scope
  // `lastLocalPlayerLb` (the `landblockChanged` edge detector). The
  // legacy flag-off block keeps its own copy; the two never run in the
  // same session (the flag is read once at load).
  let lastLb = 0;
  return {
    /**
     * KIND_POSITION neutral hook — the verbatim move of the
     * index.html `handlePositionUpdate` local-player streaming block
     * (paired `A15-Q4-SYNC` markers there; the headless drift guard in
     * test_a15_q4_renderer_neutral_core.mjs enforces call-sequence
     * parity between the two copies until graduation deletes the
     * legacy one). Gates internally on local-guid + lbId !== 0 exactly
     * as the source block does.
     */
    onPositionUpdate(upd) {
      const guid = upd.guid >>> 0;
      const lpg = getLocalPlayerGuid();
      if (lpg === null || lpg === undefined || guid !== (lpg >>> 0)) return;
      const lbId = ((upd.landblockId >>> 16) << 16) >>> 0;
      // Session 8: stamp the server-authoritative LB BEFORE the load hooks
      // fire — teleport-destination urgent lane (see landblock_lru.js
      // noteServerLb / isNearPlayerLb; lockstep with the legacy copy).
      try { getLiveScene3d()?.landblockLru?.noteServerLb?.(lbId); } catch (_) {}
      // A15-Q4-SYNC: begin streaming sequence (keep in lockstep with
      // the legacy block in index.html#handlePositionUpdate).
      // Emit `landblockChanged` on the first known LB and on any
      // subsequent LB transition. Plugins subscribe to clear
      // zone-scoped state (e.g. combat-bar's armed spell).
      if (lbId !== 0 && lbId !== lastLb) {
        const prevLb = lastLb;
        lastLb = lbId;
        emitLandblockChanged(prevLb, lbId);
      }
      if (lbId !== 0 && !terrainPrefetchedLbs.has(lbId)) {
        // Fire-and-forget; the integrator preserves pose Z on
        // cache miss until the prefetch lands.
        ensureTerrainAroundLandblock(lbId);
      }
      // Mirror the terrain prefetch for building AABBs. Same trigger
      // (every position update for the local player), same 3x3 ring,
      // same lazy gate. Until this lands collision, the player walks
      // through walls outside the spawn neighbourhood.
      if (lbId !== 0 && !buildingAabbsPopulatedLbs.has(lbId)) {
        ensureBuildingAabbsAroundLandblock(lbId);
      }
      // Lazy-fetch + bake EnvCells when entering a landblock.
      // Single-LB scope (not a 3x3 ring) because interior cells only
      // matter when the player is inside the building.
      if (lbId !== 0 && !cellContainersPopulatedLbs.has(lbId)) {
        ensureCellContainersForLandblock(lbId);
      }
      const s3d = getLiveScene3d();
      if (lbId !== 0 && s3d?.loadEnvCellsForLandblock) {
        s3d.loadEnvCellsForLandblock(lbId);
      }
      // World-expand step 1 Objective 6: mirror the wasm-side
      // terrain/building/cell prefetch ring for the 3D mesh layers.
      // Each baker is idempotent via its respective `Set<lbKey>`.
      // Scope split matches the wasm-side hooks: terrain warrants a
      // 3×3 ring (LOD + edge stitching); buildings + statics are 1-LB.
      if (lbId !== 0 && s3d?.loadTerrainForLandblock) {
        const cx = (lbId >>> 24) & 0xff;
        const cy = (lbId >>> 16) & 0xff;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || nx > 0xff || ny < 0 || ny > 0xff) continue;
            // Fire-and-forget; per-LB baker is idempotent via
            // terrainBakedLbs.
            s3d.loadTerrainForLandblock(nx, ny);
          }
        }
      }
      if (lbId !== 0 && s3d?.loadBuildingsForLandblock) {
        const cx = (lbId >>> 24) & 0xff;
        const cy = (lbId >>> 16) & 0xff;
        s3d.loadBuildingsForLandblock(cx, cy);
      }
      if (lbId !== 0 && s3d?.loadStaticsForLandblock) {
        const cx = (lbId >>> 24) & 0xff;
        const cy = (lbId >>> 16) & 0xff;
        s3d.loadStaticsForLandblock(cx, cy);
      }
      // Phase D.1 — synthetic ACE entity-spawn injection for the new
      // LB (pre-staged JSONL replayed through the same dispatcher a
      // live ACE wire feeds). Idempotent per LB; see scene3d/spawns.js.
      if (lbId !== 0 && s3d?.loadSpawnsForLandblock) {
        const cx = (lbId >>> 24) & 0xff;
        const cy = (lbId >>> 16) & 0xff;
        s3d.loadSpawnsForLandblock(cx, cy);
      }
      // Paint building meshes + non-building object sprites for the
      // new LB (2D-only; the helper self-gates on
      // liveScene.outdoorContainer and is a no-op in 3D mode).
      if (lbId !== 0 && !objectsRenderAddedLbs.has(lbId)) {
        ensureLandblockObjectsForLandblock(lbId);
      }
      // A15-Q4-SYNC: end streaming sequence.
    },
    _debugState() {
      return { lastLb };
    },
  };
}
