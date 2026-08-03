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

// ── PHY-25 dungeon stream gate (P0.1, 2026-07-27) ─────────────────────────
// Retail NEVER streams outdoor landblocks while the player is indoors:
// `CellManager::UpdateLoadPoint` (acclient.c:146439) gates its whole body on
// `(u16)objcell_id < 0x100` — the low word of the object cell id is the
// EnvCell index, and >= 0x100 means "inside an EnvCell" (dungeon / building
// interior). And `LScape::update_loadpoint` (acclient.c:308283) rebuilds the
// landscape ring ONLY on a real block shift (:308340) — not on every position
// tick.
//
// We violated both. This module's `onPositionUpdate` fires the 3×3 render
// terrain ring + the per-LB buildings / statics / spawns loaders on EVERY
// local-player position packet, indoors included. Two costs:
//   (a) indoors, an entire outdoor ring the player cannot see keeps baking
//       (TER-06, the only severity-3 answer in the live questionnaire);
//   (b) the per-packet re-fire is the documented park↔unpark storm driver —
//       see landblock_lru.js SEALED_KEEP_RING_ON ("the ring onPositionUpdate
//       re-streams every position packet", measured 3–6k park/unpark pairs
//       per sealed dwell), because the loaders' already-baked fast path
//       (index.js loadTerrainForLandblock :3062 / :3273 / :3332) UNPARKS any
//       parked LB it touches.
//
// Two effects, both default-ON per the project's "validated gate ships
// default-ON with an `=off` escape" convention:
//
//   `?dungeonStreamGate=off`  — effect (A). While the player's cell low word
//        is >= 0x100, admit NO new outdoor render-layer work: no terrain ring,
//        no buildings / statics / spawns loaders, no 2D object paint. Already
//        resident outdoor LBs are LEFT ALONE (retail keeps its loaded ring
//        too; the LRU/sealed purge own reclaim, not us) and streaming resumes
//        on the first outdoor position packet.
//   `?loadPointShiftOnly=off` — effect (B). Re-evaluate the outdoor ring only
//        on a real load-point shift (the ring LB actually changed), not on
//        every position packet. Defaults to whatever `?dungeonStreamGate`
//        resolves to, and can be turned off independently. Safe because the
//        LRU's always-resident floor (`lbChebyshev(current, key) <= ringFloor`
//        in tickEviction) already protects the player's own 3×3 from reclaim,
//        so nothing under the player can silently vanish between shifts.
//        (Retail carries its own belt-and-braces here: update_loadpoint's
//        rebuild condition at acclient.c:308339 is
//        `x_shift || y_shift || !land_blocks || v7 || check_loading`, where
//        `check_loading` is set by the :308307 scan when ANY slot in the
//        `land_blocks` grid is still NULL — i.e. a hole in the resident grid
//        also forces a rebuild. Our equivalents are the LRU ring floor above
//        and cells.js `tickPvsLoadExpansion`, which re-fires its own sweep on
//        every render-set/ring-radius signature change.)
//
// NOT gated by either effect (deliberately): `ensureTerrainAroundLandblock`,
// `ensureBuildingAabbsAroundLandblock`, `ensureCellContainersForLandblock`.
// Those are the wasm COLLISION bakes, one-shot per LB behind their shared
// Sets, and behavioral invariant 2 above is explicit that they must populate
// for the spawn LB *including an indoor spawn* or the 3D integrator freezes.
// One-shot-per-LB is not the hitch source; the per-packet render ring is.
//
// Precedence with `?eagerDungeons=on`: eagerDungeons WINS (it disables effect
// A). Verified semantics — `?eagerDungeons` is NOT an outdoor-prefetch flag:
// scene3d/index.js:1784 uses it to opt back IN to the boot-time eager EnvCell
// bake of Mite Maze (0x01F80000) + Holtburg Dungeon (0x01F60000) for capture
// scripts that assert those meshes exist immediately. It is therefore a
// "capture script: load dungeon content eagerly, do not withhold anything"
// signal, and a capture script that asks for eager dungeon content is exactly
// the caller that also wants the surrounding ring baked for its screenshots.
// Making it win keeps every existing `?eagerDungeons=on` capture path
// byte-identical to today. It costs nothing in normal play (default off).
const DUNGEON_STREAM_GATE_ON = (() => {
  try {
    const ps = new URLSearchParams(globalThis.location?.search || "");
    // Explicit comparison — the `!== "off"` idiom reads ON for garbage
    // values, but here ON *is* the default, so `=== "off"` is the whole
    // contract: absent → ON, `off`/`0`/`false` → OFF, anything else → ON.
    const v = ps.get("dungeonStreamGate");
    if (v === "off" || v === "0" || v === "false") return false;
    // ?eagerDungeons=on wins (see the precedence note above).
    if (ps.get("eagerDungeons") === "on") return false;
    return true;
  } catch (_) {
    // Headless unit-test env (no globalThis.location): keep the gate ON so
    // the suites exercise the shipped default.
    return true;
  }
})();
// s13 indoor 2D-gate (2026-07-11, 1120-appendix A5/T08) — MIRRORED HERE
// 2026-08-03 (round 10). s13 applied this gate to index.html's legacy copy
// ONLY, and `?unifiedDispatch` is default-ON, so the gate has been sitting in
// the DEAD path while this file — the live one — kept double-decoding.
//
// Under `?renderer=3d` the 2D `liveScene` is permanently null, so
// `ensureCellContainersForLandblock` fetches the landblock's EnvCells purely
// to discard them at its own `!app` gate, while `cells.js
// buildEnvCellsForLandblock` (reached via `loadEnvCellsForLandblock` a few
// lines below, unconditionally) re-fetches the very same cells under its own
// dedup set. Every cold indoor landblock decoded 2×.
//
// Why dropping the call cannot cost us physics: the wasm-side
// `fetchEnvCellsInLandblock` is what queues CELL_PHYSICS_PENDING /
// CELL_BSP_PENDING, and the cells.js path calls that same export — so the
// collision data still lands, from the fetch we keep. (The older comment in
// index.html saying "the wasm push above already shipped all the data the 3D
// path needs" predates s13 and describes why marking populated is safe, not
// that this is the only producer.) A duplicate fetch is merely wasteful
// rather than corrupting since S14 (A5) moved the drain to
// `replace_cell_triangles`, which replaces instead of appending.
//
// ⚠ NO RENDERER-MODE CHECK HERE, deliberately. s13 expressed this as
// `renderer === "2d"`, but the 2D PIXI renderer was RETIRED 2026-06-18
// (docs/2d-pixi-retirement-HANDOFF.md): `liveScene` is declared at
// index.html:3501 and never reassigned, the bake tail moved to
// legacy/render_2d.js, and nothing imports that file. So `liveScene` is
// permanently null in EVERY mode, `ensureCellContainersForLandblock` always
// bails at its own `!app` gate, and `?renderer=2d` no longer selects a mode
// with a real consumer. Gating on it would read as "the 2D path needs this"
// — a claim that has not been true since June. The condition that actually
// matters is the one below: call this ONLY when cells.js cannot.
const LOAD_POINT_SHIFT_ONLY = (() => {
  try {
    const v = new URLSearchParams(globalThis.location?.search || "").get("loadPointShiftOnly");
    if (v === "off" || v === "0" || v === "false") return false;
    if (v === "on" || v === "1" || v === "true") return true;
    return DUNGEON_STREAM_GATE_ON;
  } catch (_) {
    return DUNGEON_STREAM_GATE_ON;
  }
})();

// Retail's outdoor discriminator: the low word of the cell id is the EnvCell
// index; < 0x100 == an outdoor landcell (acclient.c:146439, and mirrored at
// scene3d/camera.js:1313 `(landblockId & 0xffff) >= 0x0100`).
function isIndoorCell(landblockId) {
  return ((landblockId >>> 0) & 0xffff) >= 0x100;
}

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
  // PHY-25 effect (B): the LB the outdoor ring was last actually evaluated
  // for — retail's `LScape` load point, which only moves when the ring is
  // rebuilt. Distinct from `lastLb` on purpose: walking OUT of a dungeon
  // whose LB you teleported into is not an `lbId` change but IS a real load
  // point shift (the ring was never built for that LB), and keying on
  // `lastLb` would strand the player in an unstreamed world.
  let lastRingLb = 0;
  // PHY-25 telemetry. `held*` = suppressed by the indoor gate; `would*` is
  // incremented in BOTH arms so a `?dungeonStreamGate=off` control run is
  // directly comparable to a gated one.
  const gateStats = {
    gateOn: DUNGEON_STREAM_GATE_ON,
    shiftOnly: LOAD_POINT_SHIFT_ONLY,
    indoorNow: false,
    lastCell: 0,
    positionPackets: 0,
    indoorPackets: 0,
    // Ring evaluations the indoor gate actually suppressed.
    heldRingEvals: 0,
    // Ring evaluations that WOULD have been suppressed if the gate were on
    // (== heldRingEvals when it is). The control-arm column.
    wouldHoldRingEvals: 0,
    // Ring evaluations suppressed by effect (B) — no real load-point shift.
    shiftSkippedRingEvals: 0,
    // Ring evaluations that actually ran (renderer present).
    ringEvals: 0,
    // Outdoor packets that arrived BEFORE `window.liveScene3d` existed —
    // the init3D window. These deliberately do NOT claim the load point
    // (see onPositionUpdate). A non-zero value here is normal at boot; it
    // is only a problem if `ringEvals` stays 0 afterwards.
    preRendererRingEvals: 0,
  };
  const noteHeld = (s3d) => {
    try { s3d?.landblockLru?.noteStreamGateHold?.(); } catch (_) {}
  };
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
      // ── PHY-25 load-point gate (see the module header) ──────────────────
      // `upd.landblockId` is the server-authoritative packed cell id, so its
      // low word is retail's `objcell_id` low word with no pose-freeze lag —
      // the same discriminator `CellManager::UpdateLoadPoint` gates on.
      const indoors = isIndoorCell(upd.landblockId);
      gateStats.positionPackets += 1;
      gateStats.indoorNow = indoors;
      gateStats.lastCell = (upd.landblockId >>> 0) & 0xffff;
      if (indoors) gateStats.indoorPackets += 1;
      // Effect (A): indoors → no new outdoor render-layer admissions.
      const gateHeld = indoors && DUNGEON_STREAM_GATE_ON;
      // Effect (B): outdoors (or gate off) → only rebuild on a real shift.
      const shiftSkipped =
        !gateHeld && LOAD_POINT_SHIFT_ONLY && lbId !== 0 && lbId === lastRingLb;
      const streamOutdoor = lbId !== 0 && !gateHeld && !shiftSkipped;
      if (indoors) gateStats.wouldHoldRingEvals += 1;
      if (gateHeld) {
        gateStats.heldRingEvals += 1;
        // INVALIDATE the load point while indoors (live probe 2026-07-27
        // caught this): the round trip Holtburg → dungeon → Holtburg ends on
        // the SAME lbId the ring was last built for, so effect (B) would skip
        // the re-evaluation — but the dwell is exactly when the sealed purge
        // parks everything beyond the dungeon's own 3×3, so that ring may be
        // gone. Clearing the load point costs one ring evaluation on exit and
        // guarantees the outdoor world is re-admitted whenever the gate
        // stops holding. (Retail gets this for free: `UpdateLoadPoint` never
        // ran indoors, so its stored load point is likewise stale on return.)
        lastRingLb = 0;
        noteHeld(getLiveScene3d());
      } else if (shiftSkipped) {
        gateStats.shiftSkippedRingEvals += 1;
      } else if (streamOutdoor) {
        // Stamp the load point ONLY when a renderer exists to receive the
        // ring (2026-08-03 review F4). The net pump starts before the
        // renderer does — index.html fires `requestAnimationFrame(drainEvents)`
        // and only then `await renderHoltburg()` → `await init3D(...)`, and
        // `getLiveScene3d()` reads `window.liveScene3d`, which index.js does
        // not assign until init3D is done. Every `s3d?.load*` call below is
        // therefore a no-op during that window, so stamping `lastRingLb` here
        // marked a ring that nothing built: with `?loadPointShiftOnly` (which
        // follows the default-ON `?dungeonStreamGate`) every LATER packet in
        // the same LB is then shift-skipped, and the spawn landblock never
        // streams terrain/buildings/statics/spawns until the player crosses an
        // LB boundary. Reproduced headless: 1 pre-init3D packet + 20 after it
        // ⇒ shiftSkippedRingEvals=20 and zero loader calls.
        if (getLiveScene3d()) {
          gateStats.ringEvals += 1;
          lastRingLb = lbId;
        } else {
          // Renderer not up yet: the load point stays unclaimed so the first
          // post-init3D packet does a real evaluation.
          gateStats.preRendererRingEvals += 1;
        }
      }
      try {
        const _s = getLiveScene3d();
        if (_s) _s._dungeonStreamGate = gateStats;
      } catch (_) {}
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
      // See the s13 note above. Once the renderer is up this fetch is
      // discarded at ensureCellContainersForLandblock's own `!app` gate and
      // re-done by cells.js immediately below — pure duplicated decode.
      //
      // INVARIANT 2 (the Workstream-G hoist, pinned by
      // test_a15_q4_renderer_neutral_core.mjs (vii)): when `getLiveScene3d()`
      // is null the wasm collision bakes must STILL fire, or the 3D
      // integrator freezes on the spawn cell. `loadEnvCellsForLandblock` —
      // the cells.js path that otherwise queues the cell physics — is skipped
      // in exactly that window, so an unconditional skip would leave an
      // INDOOR SPAWN with no cell collision until after init3D.
      //
      // Hence the whole contract, in one line: call this only while nothing
      // else will.
      const rendererUpForCells = !!getLiveScene3d();
      if (
        lbId !== 0
        && !cellContainersPopulatedLbs.has(lbId)
        && !rendererUpForCells
      ) {
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
      //
      // PHY-25: everything from here to the end of the sequence is the
      // OUTDOOR load point — suppressed while indoors (effect A) and, when
      // the ring LB is unchanged, between load-point shifts (effect B).
      // `streamOutdoor` already folds in the `lbId !== 0` guard the
      // per-call `lbId !== 0 &&` tests below keep for lockstep with the
      // legacy index.html copy.
      if (streamOutdoor && s3d?.loadTerrainForLandblock) {
        const cx = (lbId >>> 24) & 0xff;
        const cy = (lbId >>> 16) & 0xff;
        // A4 (2026-07-11 s13): collect-then-handoff to the batched
        // loadTerrainRing facade — ONE fetch_landblock_heightmaps for the
        // ring's not-yet-baked LBs (the per-LB guard/LRU/warm-park path is
        // reused unchanged; ?terrainRingBatch=off restores 9-solo inside the
        // facade). Fall back to the solo loop when the facade is absent
        // (older scene3d bundle). Keep this block byte-parallel to the legacy
        // index.html copy — the A15-Q4-SYNC drift guard enforces it.
        if (s3d.loadTerrainRing) {
          s3d.loadTerrainRing(cx, cy);
        } else {
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
      }
      if (streamOutdoor && s3d?.loadBuildingsForLandblock) {
        const cx = (lbId >>> 24) & 0xff;
        const cy = (lbId >>> 16) & 0xff;
        s3d.loadBuildingsForLandblock(cx, cy);
      }
      if (streamOutdoor && s3d?.loadStaticsForLandblock) {
        const cx = (lbId >>> 24) & 0xff;
        const cy = (lbId >>> 16) & 0xff;
        s3d.loadStaticsForLandblock(cx, cy);
      }
      // Phase D.1 — synthetic ACE entity-spawn injection for the new
      // LB (pre-staged JSONL replayed through the same dispatcher a
      // live ACE wire feeds). Idempotent per LB; see scene3d/spawns.js.
      if (streamOutdoor && s3d?.loadSpawnsForLandblock) {
        const cx = (lbId >>> 24) & 0xff;
        const cy = (lbId >>> 16) & 0xff;
        s3d.loadSpawnsForLandblock(cx, cy);
      }
      // Paint building meshes + non-building object sprites for the
      // new LB (2D-only; the helper self-gates on
      // liveScene.outdoorContainer and is a no-op in 3D mode).
      if (streamOutdoor && !objectsRenderAddedLbs.has(lbId)) {
        ensureLandblockObjectsForLandblock(lbId);
      }
      // A15-Q4-SYNC: end streaming sequence.
    },
    _debugState() {
      return { lastLb, lastRingLb, ...gateStats };
    },
    /** PHY-25 counters (also mirrored onto `liveScene3d._dungeonStreamGate`). */
    dungeonStreamGateStats() {
      return { ...gateStats, lastRingLb };
    },
  };
}
