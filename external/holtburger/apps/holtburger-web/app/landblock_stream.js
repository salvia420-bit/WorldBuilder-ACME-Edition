// app/landblock_stream.js — landblock streaming + the legacy (flag-off)
// entity-update handlers: the per-LB bookkeeping Sets (terrain prefetch,
// building/statics AABBs, scenery colliders, EnvCell containers, object
// render adds), ensureTerrainAroundLandblock / ensureBuildingAabbsAroundLandblock
// / ensureCellContainersForLandblock / ensureLandblockObjectsForLandblock, the
// shared worldStreamer (scene3d/world_stream.js), handlePositionUpdate and the
// A15-Q4-SYNC legacy streaming block, the handleEntity* arms, and the
// __dispatch2d entity dispatcher.
//
// Moved VERBATIM out of index.html's inline script (2026-10-05). index.html
// calls createLandblockStream() at the point this code used to run (so the
// window.* exposures and Set creation happen in the same order) and receives
// the handlers the net pump + ClientEvent dispatcher use. The module-scope
// `let`s index.html still owns (worldObjectManager, liveScene, localPlayerGuid,
// lastLocalPlayerLb) are read/written through D's live accessors.

import { createWorldStreamer } from "../scene3d/world_stream.js";
import { KIND as ENTITY_KIND, createEntityDispatcher } from "../scene3d/entity_dispatch.js";

// `?interiorBuildShare` (2026-10-09, cold-load structural pass) — ONE in-flight
// `fetchEnvCellsInLandblock` per landblock on the main wasm instance.
//
// WHY. Two callers build the same landblock's interior: this module's
// `ensureCellContainersForLandblock` (collision / cell graph — the spawn kick,
// the cell-residency watchdog) and scene3d/cells.js `buildEnvCellsForLandblock`
// (the meshes). The spawn kick and the watchdog fire both in the same turn, and
// their dedup sets are separate, so the academy (568 cells) ran the whole
// wasm build twice at once — every record walk and the ~1.7 s per-cell loop on
// the main thread, twice. The second build bought nothing: it re-reads the
// same records and re-queues the same products (`CELL_GRAPH_PENDING`,
// `CELL_PHYSICS_PENDING`, `CELL_BSP_PENDING`, `CELL_MEMBERSHIP_PENDING`,
// `CELL_STATIC_BSP_PENDING`). Most drains are idempotent (map inserts,
// `replace_cell_triangles`, de-duplicated portal edges); two APPEND —
// `insert_cell_static_physics_bsp` and `insert_cell_portal_polygon` — so the
// duplicate build doubled every cell static's collision BSP and every portal
// polygon until the next eviction clear. One build per landblock is both enough
// and more correct.
//
// HOW. A registry on `globalThis.__hbInteriorBuildShare`, installed by
// `createLandblockStream` (index.html calls it at boot, before scene3d loads).
// No new module: a static import from here into scene3d/ would add files to the
// modulepreload block, and cells.js only needs to read the global (it falls back
// to the direct call when the registry is absent — capture pages, unit tests).
// `share.fetch(lbId, fn, {who, reads, thisArg})` returns the SAME promise to
// every concurrent caller for that landblock and drops the entry when it
// settles (resolve or reject — a rejection reaches every caller), so a later
// call starts a fresh build. `fn` is called synchronously, so `?interiorEarlyBake`'s
// same-turn request sharing is unchanged.
//
// OWNERSHIP of the returned `EnvCellPlacement` handles (wasm-bindgen objects
// with destructive `take*` + `free()`): a build has at most ONE reader — the
// caller that drains and frees them (cells.js, `reads: true`). A second reader
// never joins: it starts its own build (a parked-then-rebuilt landblock can have
// two cells.js builds in flight, and two drains of one array would be a
// use-after-free). Observers (this module) never touch the elements of a shared
// array; `share.consumersOf(placements)` tells an observer whether it was the
// only caller, and only then does it free them. `forget(lb)` (eviction) makes
// the next call start a fresh build, so a re-entry never joins a build whose
// early products the eviction's collision clear may have already dropped.
//
// Escape: `?interiorBuildShare=off`/`0`/`false`/`no` → every call runs its own
// build, exactly as before. Diag: `__hbInteriorBuildShare.stats` (builds,
// joined, readerBypass, fnMismatch, rejected, forgotten) and one
// `[interiorBuildShare]` console line per join.
const INTERIOR_BUILD_SHARE_VERSION = 1;

/** `?interiorBuildShare` reader: default ON; `off`/`0`/`false`/`no` disable. */
export function interiorBuildShareEnabled(search = "") {
  try {
    const v = new URLSearchParams(search || "").get("interiorBuildShare");
    if (v === null) return true;
    const s = String(v).trim().toLowerCase();
    return !(s === "off" || s === "0" || s === "false" || s === "no");
  } catch (_) {
    return true;
  }
}

/**
 * Install (once) and return the shared-build registry on `g`. Idempotent: a
 * registry of the same version already on `g` is returned as-is. Exported for
 * the unit suite (`tests/interior_build_share.test.mjs`).
 */
export function installInteriorBuildShare(g = globalThis) {
  const prior = g.__hbInteriorBuildShare;
  if (prior && prior.version === INTERIOR_BUILD_SHARE_VERSION) return prior;
  let search = "";
  try {
    search = g.location?.search || "";
  } catch (_) {
    search = "";
  }
  const enabled = interiorBuildShareEnabled(search);
  const inFlight = new Map(); // lbKey -> { fn, promise, consumers, readers, who, t0 }
  const settled = new WeakMap(); // placements array -> its build's entry
  const stats = { builds: 0, joined: 0, readerBypass: 0, fnMismatch: 0, rejected: 0, forgotten: 0 };
  const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const hex = (k) => "0x" + k.toString(16).padStart(8, "0");
  const share = {
    version: INTERIOR_BUILD_SHARE_VERSION,
    enabled,
    inFlight,
    stats,
    /**
     * `fn(lbId)` (called with `opts.thisArg`), shared with any build of the same
     * landblock already in flight through the SAME `fn`. `opts.reads` marks the
     * caller that drains + frees the handles (at most one per build).
     */
    fetch(lbId, fn, opts = {}) {
      const who = opts.who || "?";
      const reads = opts.reads === true;
      if (!enabled) return fn.call(opts.thisArg, lbId);
      const k = (lbId & 0xffff0000) >>> 0;
      const cur = inFlight.get(k);
      if (cur) {
        if (cur.fn !== fn) {
          // Another wasm instance / a stub: never hand its result across.
          stats.fnMismatch += 1;
          return fn.call(opts.thisArg, lbId);
        }
        if (!(reads && cur.readers > 0)) {
          cur.consumers += 1;
          if (reads) cur.readers += 1;
          stats.joined += 1;
          try {
            console.log(
              `[interiorBuildShare] envcells ${hex(k)}: ${who} joined the in-flight build ` +
                `(${cur.who}, +${Math.round(nowMs() - cur.t0)} ms) — one wasm build instead of two`,
            );
          } catch (_) { /* logging must never affect the build */ }
          return cur.promise;
        }
        // A second READER: its own build (see OWNERSHIP above), which becomes
        // the one later observers join.
        stats.readerBypass += 1;
      }
      let raw;
      try {
        raw = fn.call(opts.thisArg, lbId);
      } catch (e) {
        raw = Promise.reject(e);
      }
      const entry = { fn, promise: null, consumers: 1, readers: reads ? 1 : 0, who, t0: nowMs() };
      entry.promise = Promise.resolve(raw).then(
        (placements) => {
          if (inFlight.get(k) === entry) inFlight.delete(k);
          if (placements && typeof placements === "object") settled.set(placements, entry);
          return placements;
        },
        (e) => {
          if (inFlight.get(k) === entry) inFlight.delete(k);
          stats.rejected += 1;
          throw e;
        },
      );
      inFlight.set(k, entry);
      stats.builds += 1;
      return entry.promise;
    },
    /** How many callers received this placements array (1 = a sole, unshared caller). */
    consumersOf(placements) {
      const e = placements && typeof placements === "object" ? settled.get(placements) : null;
      return e ? e.consumers : 1;
    },
    /** Eviction: the next call for this landblock starts a fresh build. */
    forget(lbId) {
      if (inFlight.delete((lbId & 0xffff0000) >>> 0)) stats.forgotten += 1;
    },
  };
  g.__hbInteriorBuildShare = share;
  return share;
}

export function createLandblockStream(D) {
  const { fetch_landblock_heightmaps, populateBuildingAabbsForLandblock,
    populateStaticsAabbsForLandblock, fetchEnvCellsInLandblock, __hbWasmNs,
    METERS_PER_LANDBLOCK, applyConfirmedStance, entityMap, __UNIFIED_DISPATCH } = D;
  // `?interiorBuildShare`: installed before scene3d loads, so cells.js finds it.
  const envCellsShare = installInteriorBuildShare(globalThis);
  // Phase 4 step 6 player-fix: pre-liveScene Spawn buffer.
  // ACE sends ObjectCreate for the local player as soon as the
  // spawn handshake completes (Player_Networking.cs:224 —
  // PlayerCreate + ObjectCreate enqueued together). That's
  // typically several seconds BEFORE renderHoltburg's
  // renderNeighbourhood completes and sets `liveScene`.
  // ensureEntitySprite returns null when liveScene is null, so
  // those early Spawns were silently dropped — the local player
  // ended up in entityMap as a placeholder glyph (created by
  // later position updates) with empty meta, never going
  // through Phase A/B/C composition.
  //
  // Fix: buffer pre-liveScene Spawns as plain-JS clones (the
  // wasm-bindgen EntityUpdate gets free()'d at the end of the
  // drain loop, so we can't keep the live struct), then replay
  // through handleEntitySpawn once liveScene is ready.
  // cloneEntitySpawn + 2D placeholder glyph stack RETIRED → legacy/entity_2d.js.

  // Quaternion → yaw extraction. AC is Z-up; top-down view rotates
  // around the Z axis. Standard formula, identical to the static
  // `frame_to_placement` logic in lib.rs:518-525.
  function quaternionToYaw(qw, qx, qy, qz) {
    return Math.atan2(
      2 * (qw * qz + qx * qy),
      1 - 2 * (qy * qy + qz * qz)
    );
  }

  // Per-frame baked sprites face screen-east at heading=0 (the bake
  // pose's natural orientation), so a 90° CCW visual rotation is
  // applied so a north-bound character actually faces screen-up.
  // Under worldContainer.scale.y = -1 a positive sprite.rotation is
  // a CCW visual turn, hence +π/2. Applied symmetrically wherever
  // sprite.rotation is derived from heading and vice versa.
  const SPRITE_HEADING_OFFSET = Math.PI / 2;

  // Landblock-id + landblock-local (x, y) → world (wx, wy) in metres.
  // Matches the existing static-placement conversion at line 994
  // (`n.x * METERS_PER_LANDBLOCK + obj.x`). The wasm side forwards
  // on-wire AC coords unchanged; this is the one place JS turns them
  // into the world-metres coordinate space the scene graph uses.
  function landblockToWorldXY(lbid, x, y) {
    const lbX = (lbid >>> 24) & 0xff;
    const lbY = (lbid >>> 16) & 0xff;
    return {
      wx: lbX * METERS_PER_LANDBLOCK + x,
      wy: lbY * METERS_PER_LANDBLOCK + y,
    };
  }

  // Get-or-create the sprite for a given GUID. Spawn / position
  // updates both call this; only Spawn passes a real modelId, so
  // a position update arriving before its ObjectCreate puts a
  // placeholder glyph on the scene that the later Spawn upgrades to
  // a real model sprite. After upgrade, subsequent position updates
  // (which always pass modelId=0 because the wire message doesn't
  // carry it) keep the existing real sprite — that's the
  // `entry.modelId === 0 && modelId !== 0` swap condition.
  // In-flight on-demand model fetches. Keyed by modelId; value is
  // the Promise resolving to { texture, worldBounds } | null
  // (null = invisible model). Multiple entities arriving with
  // the same csetup_id share the same fetch.
  const pendingModelFetches = new Map();

  // Phase 4 step 2b follow-on: lazily fetch + cache an entity's
  // model the first time we see its csetup_id. ACE streams in
  // creature / NPC models that aren't in the static placement
  // set, so the initial `buildLiveSpriteMap` cache (built from
  // Holtburg's 81 unique placement model IDs) misses on every
  // monster spawn. This fetches the missing model through the
  // exact same `fetch_model_meshes` + `fetch_surfaces_pixels` +
  // `renderModelTile` pipeline and writes the result back into
  // `liveScene.liveSpriteMap` / `invisibleModels` so subsequent
  // spawns of the same model are instant. Already-pending IDs
  // de-dupe through `pendingModelFetches`.
  // 2D entity-sprite stack (fetch/bake/cache + nameplate + handleEntitySpawn +
  // portal swirl) RETIRED 2026-06-18 → legacy/entity_2d.js. 3D: scene3d/entities.js.
  // §9 ruling: 2D per-portal swirl retired; 3D portal VFX = global portal_space.js donut.

  // Track which landblocks have been pushed to the wasm terrain
  // cache so handlePositionUpdate can lazy-fetch new LBs as the
  // player crosses boundaries (or teleports / dies-respawns into
  // a fresh region). Without this, the kind=7 EnteredWorld
  // one-shot prefetch only covers the initial spawn area; any
  // subsequent teleport (including the death-respawn that fired
  // when the user fell off the Holtburg slope before client-side
  // terrain following landed) leaves the integrator's terrain
  // lookup with a cache miss, so heartbeats revert to constant Z
  // and ACE physics applies false gravity again.
  const terrainPrefetchedLbs = new Set();
  const terrainPrefetchInFlight = new Set();
  // 2026-05-09 follow-up: track which landblocks have had their
  // PIXI terrain mesh added to outdoorContainer. Distinct from
  // `terrainPrefetchedLbs` because the wasm-side height cache and
  // the JS-side render are separate concerns: the startup paint
  // (renderHoltburg) renders the initial NEIGHBOURHOOD without
  // touching the cache, and the kind=7 EnteredWorld follow-on
  // populates the cache without re-rendering already-painted
  // tiles. Pre-populated below once renderNeighbourhood has added
  // the initial 9 Holtburg landblocks to outdoorContainer.
  const terrainMeshAddedLbs = new Set();
  // Phase 6 step B follow-up: track which landblocks have had
  // their per-part building AABBs queued into the world's spatial
  // scene. Mirrors `terrainPrefetchedLbs` exactly — same lazy-on-
  // landblock-entry trigger from `handlePositionUpdate`, same
  // teleport / death-respawn coverage. Without this, only the
  // initial spawn neighbourhood would have collision; running
  // into Hebian-To, Cragstone, or any other zone a level-1 might
  // reach via @telepoi would put the player back into the
  // walks-through-walls regime.
  const buildingAabbsPopulatedLbs = new Set();
  const buildingAabbsPopulateInFlight = new Set();
  // DAT-01 phase 2e (2026-07-27): landblocks whose BAKED PROCEDURAL
  // SCENERY colliders (trees/rocks/bushes — COL-01 / COL-29) have been
  // staged into the wasm spatial scene. Its own set rather than riding
  // `buildingAabbsPopulatedLbs` because the scenery populate reads a
  // DIFFERENT source (the `dist/scenery/*.jsonl` bake, not
  // LandblockInfo) and can legitimately return 0 forever on a pre-V3
  // bake while buildings populate fine — sharing the set would hide
  // which half actually ran. Cleared by `__onLandblockEvicted` below;
  // without that clear the LRU's evict + revisit would skip the
  // re-populate and the player would walk through trees again on every
  // second visit.
  const sceneryCollidersPopulatedLbs = new Set();
  // 2026-05-09 follow-up: track which landblocks have had their
  // building meshes + non-building object sprites added to
  // outdoorContainer. Distinct from buildingAabbsPopulatedLbs
  // because that one only loads collision; this one drives the
  // visible PIXI tree. Pre-populated below with the initial 9
  // Holtburg LBs once renderNeighbourhood completes — those
  // already render via the startup buildings/objects bundles.
  const objectsRenderAddedLbs = new Set();
  const objectsRenderAddInFlight = new Set();
  // Models we've already attempted to resolve a representative
  // ARGB for via fetch_object_colours (whether or not the resolve
  // succeeded — null result is recorded as "tried, no colour" so
  // we don't re-fetch on every LB entry).
  const colourResolveAttempted = new Set();
  // Phase 6 step C: track which landblocks have had their EnvCells
  // fetched + baked. Same lazy-on-landblock-entry trigger as
  // `buildingAabbsPopulatedLbs` — when the player crosses into a
  // new landblock, queue an EnvCell load for that LB (and its 3x3
  // ring once Phase D needs neighbour visibility). The bake is
  // expensive (one RenderTexture per cell), so we don't preload —
  // a 50-cell town hall lands one bake per cell on first entry.
  const cellContainersPopulatedLbs = new Set();
  const cellContainersPopulateInFlight = new Set();
  // Cell-container registry: stable across LB entries. JS adds
  // entries on `ensureCellContainersForLandblock`, never removes
  // (capture probe walks the map). Phase D's culling toggles
  // `.visible` per cell, not membership.
  const cellContainerRegistry = new Map();
  // Phase 6 re-entry fix (2026-06-30): scene3d's LandblockLRU evicts an LB
  // (purging the wasm collision via enqueueClearLandblockCollision, removing
  // the 3D meshes, and clearing its OWN bake-dedup in landblock_lru.js). But
  // the COLLISION/cell populate-dedup sets live in THIS module, so the LRU
  // can't reach them — and they were add-only. Without this, an
  // evicted-then-revisited LB stays "populated" forever → the re-entry
  // triggers (ensureBuildingAabbsAroundLandblock / ensureCellContainersForLandblock)
  // SKIP it → the player walks through walls + loses cell collision on
  // revisit. scene3d's onEvictLandblock invokes this hook. Terrain heights
  // are NOT purged on evict and the 3D bake-dedup is cleared by the LRU
  // itself, so we touch only the collision + cell sets here. The wasm purge
  // makes the re-populate REPLACE rather than append.
  window.__onLandblockEvicted = (lbId) => {
    // `>>> 0` AFTER the mask (2026-10-09): `&` yields a SIGNED int32, so for
    // every landblock with an x byte >= 0x80 (e.g. the academy 0x8602) the key
    // was negative and matched none of the unsigned keys the sets hold — the
    // clears below were silent no-ops there and a revisit never re-populated.
    const lb = ((lbId >>> 0) & 0xffff0000) >>> 0;
    buildingAabbsPopulatedLbs.delete(lb);
    buildingAabbsPopulateInFlight.delete(lb);
    cellContainersPopulatedLbs.delete(lb);
    cellContainersPopulateInFlight.delete(lb);
    // DAT-01 phase 2e: the scenery colliders were purged wasm-side by
    // `enqueueClearLandblockCollision` -> `clear_landblocks_collision`
    // (the scenery family is wired into that batched clear), so the
    // dedup entry MUST go too or the re-entry populate is skipped and
    // the LB comes back with no tree collision.
    sceneryCollidersPopulatedLbs.delete(lb);
    // `?interiorBuildShare`: a re-entry must start a FRESH EnvCell build, not
    // join one whose earlier products the collision clear above may drop.
    envCellsShare.forget(lb);
  };
  async function ensureCellContainersForLandblock(centreLb) {
    // Phase 6 step C: lazy-fetch + bake the EnvCells in a single
    // landblock on player entry. Mirrors
    // `ensureBuildingAabbsAroundLandblock` shape but operates on
    // ONE landblock at a time (not a 3x3 ring) — interior cells
    // are only relevant when the player is actually inside the
    // landblock, and a 50-cell town hall already costs ~50
    // RenderTextures. Phase D may extend to neighbour-LB cells
    // once cross-LB portals matter (rare; most dungeons sit in
    // one landblock).
    const lbId = (centreLb & 0xFFFF0000) >>> 0;
    if (
      cellContainersPopulatedLbs.has(lbId)
      || cellContainersPopulateInFlight.has(lbId)
    ) {
      return;
    }
    cellContainersPopulateInFlight.add(lbId);
    try {
      // `?interiorBuildShare`: join cells.js's in-flight build of this LB (or
      // let it join ours) — one wasm build, one set of queued cell products.
      // This caller is an OBSERVER: it never reads the handles, and frees them
      // only when no other caller received the same array (`soleOwner`); a
      // joined reader (cells.js) drains + frees them itself.
      const share = envCellsShare.enabled ? envCellsShare : null;
      const placements = await (share
        ? share.fetch(lbId, fetchEnvCellsInLandblock, { who: "landblock_stream" })
        : fetchEnvCellsInLandblock(lbId));
      const soleOwner = !share || share.consumersOf(placements) <= 1;
      if (!placements || placements.length === 0) {
        cellContainersPopulatedLbs.add(lbId);
        return;
      }
      const app = D.liveScene?.app;
      if (!app) {
        // Nothing below reads the handles; with the share on, the sole owner
        // releases them now instead of leaving them to the wasm-bindgen
        // finalizer (flag off: unchanged — left to GC as before).
        if (share && soleOwner) {
          for (const placement of placements) {
            try { placement?.free?.(); } catch (_) { /* best-effort */ }
          }
        }
        // liveScene is set asynchronously; if a position update
        // arrives before the initial render completes, defer by
        // re-clearing the in-flight bit so the next position
        // update retries the bake.
        //
        // 2026-05-21 lag fix: under `?renderer=3d`, `liveScene`
        // is PERMANENTLY null — the PIXI 2D path is never
        // instantiated. The wasm-side `fetchEnvCellsInLandblock`
        // call above has already queued cell-graph + physics
        // data for the recv-loop drain (the only thing the 3D
        // path needs). Without marking the LB populated here,
        // every subsequent position update re-enters and re-
        // pushes ~1953 cell physics triangles + 123 AABBs + 292
        // portal edges into the wasm queues at 3.5 Hz; the
        // drain then APPENDS them into `cell_physics_index`
        // (insert_cell_triangle is non-idempotent .push), which
        // the unconditional per-tick `scene.clone()` deep-copies.
        //
        // 2026-05-22 follow-on: the original gate (`window
        // .liveScene3d`) was set on the assumption "liveScene3d
        // is set before position updates begin", but boot
        // profiling shows position updates DO arrive before
        // `window.liveScene3d` is assigned (init3D's terrain bake
        // + envcells dungeon load happen between in-world and the
        // liveScene3d assignment ~600ms later). During that
        // window the function repeatedly re-fetches the same
        // landblock — measured 13 duplicate drains over 900ms
        // (892ms of recv-loop time) on the wire-agent boot.
        //
        // Fix: gate on the renderer-mode URL flag directly
        // instead. In `?renderer=3d`, the 2D PIXI bake will
        // NEVER run, so we can safely mark populated immediately
        // — the wasm push above already shipped all the data
        // the 3D path needs. In 2D mode (no `?renderer=3d`),
        // fall through to the existing retry-on-late-liveScene
        // behaviour.
        const wantRenderer3d =
          new URLSearchParams(window.location.search).get("renderer") !== "2d";
        if (wantRenderer3d || window.liveScene3d) {
          cellContainersPopulatedLbs.add(lbId);
        }
        return;
      }
      // 2D PIXI cell-bake tail (bakeCellTextures → buildCellsContainer →
      // liveScene.worldContainer.addChild) RETIRED 2026-06-18 (item 7c) →
      // legacy/render_2d.js. Only reachable when liveScene.app exists (2D);
      // in 3D the function already returned at the `if (!app)` gate above,
      // after the wasm-side fetchEnvCellsInLandblock queued the cell-graph +
      // physics data the 3D path consumes. Bookkeeping kept:
      cellContainersPopulatedLbs.add(lbId);
      // `?interiorBuildShare`: a shared array belongs to its reader.
      if (soleOwner) for (const placement of placements) placement.free();
    } catch (e) {
      console.warn(
        `[phase6.C] fetchEnvCellsInLandblock(0x${lbId.toString(16)}) failed:`, e
      );
    } finally {
      cellContainersPopulateInFlight.delete(lbId);
    }
  }
  // Cell-residency watchdog (2026-07-18, soak-9 door/freeze fix).
  // Every EnvCell load trigger above rides a SERVER position update
  // (world_stream/legacy `handlePositionUpdate`), but the indoor
  // movement pipeline refuses to predict motion until the cell
  // physics lands (`transition.rs` pre-bake gate) — so a player who
  // ARRIVES in an interior cell of a not-yet-fetched landblock
  // (teleport, bot relaunch spawn, LB re-entry after LRU eviction)
  // freezes, sends no further position updates, and the fetch never
  // retriggers: a load-trigger deadlock. Retail keys cell residency
  // off the player's POSE during transit (`LScape::update_block` →
  // synchronous `CEnvCell` load, acclient.c), not off network
  // events — this watchdog is that pose-driven trigger. It fires
  // ONLY when the local pose sits in an interior cell (suffix >=
  // 0x100) whose landblock has no cell containers yet, so the
  // ordinary outdoor-entry path keeps sole ownership of cold-LB
  // fetches (no re-introduction of the s13 double-decode).
  //
  // PORTAL-P0 leg 2 (2026-08-10): per-LB backoff for the MESH-half re-fire
  // added below — `Map<lbKey, {n, nextMs}>`.
  const cellWatchdogMeshRetries = new Map();
  setInterval(() => {
    try {
      const h = window.__sessionHandle;
      if (!h?.getLocalPlayerPose) return;
      const p = h.getLocalPlayerPose();
      if (!p) return;
      let cellId = 0;
      try {
        cellId = p.landblockId >>> 0;
      } finally {
        p.free?.();
      }
      // Indoor-spawn fix (2026-07-23, Town Network no-walk wedge): the raw
      // pose accessor is EXACTLY the reader that breaks in the scenario
      // this watchdog exists for — after a teleport-ish arrival (or a
      // login straight into a dungeon) `getLocalPlayerPose().landblockId`
      // can read 0, or retain the STALE pre-portal outdoor cell, for the
      // whole session (HANDOFF-surveyor-round2-2026-07-21 §OPEN). The
      // `< 0x100` gate below then returns forever, the EnvCell fetch never
      // fires, the wasm scene gets no cell BSPs, and the movement pipeline
      // stays on the geometry-less pre-bake fallback: the bot is frozen in
      // the dungeon with every MoveToPosition a no-op (live 2026-07-23:
      // Vendbot wedged at 0x00070178, `getCurrentCellId()` correct while
      // the raw pose carried no cell). Fall back to the cell-scene
      // snapshot (`getCurrentCellId` — server-truth carried cell, the one
      // accessor verified correct in that wedge) whenever the raw pose
      // does not read as an interior cell.
      if ((cellId & 0xffff) < 0x100) {
        let snapCell = 0;
        try {
          snapCell = typeof h.getCurrentCellId === "function" ? h.getCurrentCellId() >>> 0 : 0;
        } catch (_) { snapCell = 0; }
        if ((snapCell & 0xffff) < 0x100) return; // genuinely outdoors — normal path owns it
        cellId = snapCell;
      }
      const lbId = (cellId & 0xffff0000) >>> 0;
      // PORTAL-P0 leg 2 (2026-08-10) — the watchdog was keyed on the WRONG
      // set. `cellContainersPopulatedLbs`/`…InFlight` track the WASM
      // collision bake only; the MESH bake's success mark is
      // `scene3d.envCellLoadedLbs` (added only on success — cells.js
      // :1049/:1738 — so a thrown/starved build leaves it unset). A
      // succeeded wasm bake + failed mesh bake therefore satisfied this
      // early-return forever and the watchdog went silent for the session:
      // the player has cell physics and an EMPTY interior. Re-fire while
      // EITHER half is missing; each half is re-fired on its own terms
      // (both loaders are self-idempotent — `ensureCellContainersForLandblock`
      // has its own populated/in-flight gate, `buildEnvCellsForLandblock`
      // short-circuits on `envCellLoadedLbs`/`envCellBuildInFlight`).
      //
      // `window.liveScene3d` is stamped LATE (~35 s after in-world) and is
      // a one-time init3D snapshot — while it is null the mesh set cannot
      // be read at all, so treat "unverifiable" as done and keep the
      // pre-2026-08-10 behaviour rather than re-firing at 2 Hz through boot.
      const meshLoadedLbs = window.liveScene3d?.envCellLoadedLbs;
      const meshInFlightLbs = window.liveScene3d?.envCellBuildInFlight;
      const meshDone =
        !(meshLoadedLbs instanceof Set)
        || meshLoadedLbs.has(lbId)
        || (meshInFlightLbs instanceof Set && meshInFlightLbs.has(lbId));
      const wasmDone =
        cellContainersPopulatedLbs.has(lbId)
        || cellContainersPopulateInFlight.has(lbId);
      if (wasmDone && meshDone) return;
      if (!wasmDone) {
        console.log(
          `[cell-watchdog] indoor cell 0x${cellId.toString(16)} in unfetched LB 0x${lbId.toString(16)} — triggering EnvCell fetch`
        );
        ensureCellContainersForLandblock(lbId);
        window.liveScene3d?.loadEnvCellsForLandblock?.(lbId);
        return;
      }
      // wasm half is done, MESH half is not — the newly-covered case. The
      // mesh bake is by far the heavier of the two (Academy = 568 cells),
      // and a build that keeps throwing clears its in-flight marker without
      // marking loaded, so re-firing it at the watchdog's 2 Hz would be a
      // retry storm. Back off per LB and give up after a few tries; the
      // ordinary per-position-update and PVS-ring drivers still own it.
      const now = Date.now();
      const prev = cellWatchdogMeshRetries.get(lbId);
      if (prev && (prev.n >= 5 || now < prev.nextMs)) return;
      cellWatchdogMeshRetries.set(lbId, {
        n: (prev?.n ?? 0) + 1,
        nextMs: now + 3000,
      });
      console.log(
        `[cell-watchdog] indoor cell 0x${cellId.toString(16)} in LB 0x${lbId.toString(16)} `
        + `has cell physics but NO EnvCell meshes — re-firing the mesh bake `
        + `(attempt ${(prev?.n ?? 0) + 1}/5)`
      );
      const meshBake = window.liveScene3d?.loadEnvCellsForLandblock?.(lbId);
      if (meshBake && typeof meshBake.catch === "function") {
        meshBake.catch((e) => {
          console.warn(`[cell-watchdog] mesh re-bake 0x${lbId.toString(16)} failed:`, e);
        });
      }
    } catch (_) {}
  }, 500);
  async function ensureBuildingAabbsAroundLandblock(centreLb) {
    // Same 3x3 ring as `ensureTerrainAroundLandblock`: the player
    // needs collision in the cells surrounding the spawn / current
    // LB so a sprint across an LB boundary doesn't tear through a
    // wall on the far side. Cell IDs use the `XXYYFFFE` low word
    // (LandblockInfo lookup); the wasm export only reads the high
    // 16 bits for resolution.
    const cx = (centreLb >>> 24) & 0xff;
    const cy = (centreLb >>> 16) & 0xff;
    const targets = [];
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx > 0xff || ny < 0 || ny > 0xff) continue;
        const lbId = ((nx << 24) | (ny << 16)) >>> 0;
        if (
          buildingAabbsPopulatedLbs.has(lbId)
          || buildingAabbsPopulateInFlight.has(lbId)
        ) {
          continue;
        }
        buildingAabbsPopulateInFlight.add(lbId);
        targets.push(lbId);
      }
    }
    if (targets.length === 0) return;
    // Bound-parallel the ring (2026-06-30; was strictly serial). Each
    // export pulls a LandblockInfo + N Setup records through the manifest
    // source; a full 9-wide barrage can saturate the catalog HTTP path, but
    // strictly one-at-a-time made collision lag far behind a sprint into a
    // fresh region (the walk-through window). Cap concurrency at 3 and do
    // the player's CURRENT LB first so the cell you're standing in gets
    // collision before its neighbours. Building+statics stay sequential
    // WITHIN each LB (a building failure must not disturb static
    // bookkeeping). Heartbeats remain on the rAF cadence regardless.
    const CENTRE_LB = (centreLb >>> 0) & 0xffff0000;
    targets.sort((a, b) => (a === CENTRE_LB ? -1 : b === CENTRE_LB ? 1 : 0));
    const POPULATE_CONC = 3;
    let nextIdx = 0;
    const populateOne = async (lbId) => {
      try {
        const count = await populateBuildingAabbsForLandblock(lbId);
        buildingAabbsPopulatedLbs.add(lbId);
        // Diagnostic — cross-check against the recv-loop drain
        // log that prints the running building_aabb_count.
        console.log(
          `[phase6.B] queued ${count} building AABBs for landblock 0x${lbId.toString(16).padStart(8, "0")}`
        );
        // B4 Tier-1: also bake outdoor static (tree/sign/prop) AABBs for
        // this landblock so the player integrator's static-collision
        // clamp engages. Same trigger/dedup as the building pass; its own
        // try so a static failure doesn't disturb building bookkeeping.
        try {
          const sCount = await populateStaticsAabbsForLandblock(lbId);
          console.log(
            `[b4] queued ${sCount} static AABBs for landblock 0x${lbId.toString(16).padStart(8, "0")}`
          );
        } catch (se) {
          console.warn(
            `[b4] populateStaticsAabbsForLandblock(0x${lbId.toString(16)}) failed:`, se
          );
        }
        // DAT-01 phase 2e: stage the BAKED PROCEDURAL SCENERY colliders
        // (trees/rocks/bushes) for this landblock. Same trigger and its
        // own try, for the same reason the statics call has one.
        //
        // Reached through `__hbWasmNs?.` rather than a static named
        // import ON PURPOSE: a named import of a missing export is a
        // module-link SyntaxError, which would turn "someone is running
        // a stale pkg/" into a blank page instead of a missing feature.
        // Optional access degrades to "no scenery collision", which is
        // exactly the pre-DAT-01 behaviour.
        //
        // Returns 0 on the currently-shipped PRE-V3 `dist/scenery/`
        // (no `aabb_*` fields to read) — that zero is expected until the
        // phase-3 re-bake, and the LB is still marked populated so we
        // don't re-walk 40k JSONL lines every LB entry for nothing.
        try {
          const scFn = __hbWasmNs?.populateSceneryCollidersForLandblock;
          if (typeof scFn === "function"
              && !sceneryCollidersPopulatedLbs.has(lbId)) {
            const scCount = await scFn(lbId >>> 0);
            sceneryCollidersPopulatedLbs.add(lbId);
            if (scCount > 0) {
              console.log(
                `[dat01] queued ${scCount} scenery colliders for landblock 0x${lbId.toString(16).padStart(8, "0")}`
              );
            }
          }
        } catch (ce) {
          console.warn(
            `[dat01] populateSceneryCollidersForLandblock(0x${lbId.toString(16)}) failed:`, ce
          );
        }
      } catch (e) {
        console.warn(
          `[phase6.B] populateBuildingAabbsForLandblock(0x${lbId.toString(16)}) failed:`, e
        );
      } finally {
        buildingAabbsPopulateInFlight.delete(lbId);
      }
    };
    const worker = async () => {
      while (nextIdx < targets.length) {
        await populateOne(targets[nextIdx++]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(POPULATE_CONC, targets.length) }, worker)
    );
  }
  // 2026-05-09 follow-up: render building meshes + non-building
  // object sprites for an arbitrary landblock when the local
  // player walks/portals into it. Mirrors the startup path
  // (renderNeighbourhood's bakePerPartBuildingTextures +
  // buildBuildingsContainer + buildObjectsContainer pipeline)
  // but scoped to one LB at a time. Called from
  // handlePositionUpdate after the LB-change terrain prefetch
  // fires; idempotent per LB via objectsRenderAddedLbs.
  //
  // Without this, walking out of Holtburg paints terrain (step
  // 1/3) but leaves every building + sign + tree invisible —
  // the player sees a textured ground with no landmarks.
  async function ensureLandblockObjectsForLandblock(lbId) {
    if (
      objectsRenderAddedLbs.has(lbId)
      || objectsRenderAddInFlight.has(lbId)
    ) return;
    if (!D.liveScene || !D.liveScene.outdoorContainer) return;
    // 2D PIXI building/object render body (fetch_landblock_objects +
    // bakePerPartBuildingTextures + buildBuildingsContainer +
    // buildObjectsContainer + worldContainer.addChild) RETIRED 2026-06-18
    // (item 7c) → legacy/render_2d.js. This whole function is pure-2D — it
    // early-returns above on !liveScene, so 3D never reaches here (the 3D
    // path builds objects via init3D / scene3d). No wasm-populate half.
  }

  async function ensureTerrainAroundLandblock(centreLb) {
    // centreLb is the high 16 bits of a cell id (e.g. 0xA9B40000).
    // We prefetch the 3×3 ring around it (9 cells, ~580 m radius
    // — enough headroom that the player can run for ~2 minutes
    // before crossing into an unprefetched LB).
    const cx = (centreLb >>> 24) & 0xff;
    const cy = (centreLb >>> 16) & 0xff;
    const fetchIds = [];
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx > 0xff || ny < 0 || ny > 0xff) continue;
        const lbId = ((nx << 24) | (ny << 16)) >>> 0;
        if (terrainPrefetchedLbs.has(lbId) || terrainPrefetchInFlight.has(lbId)) {
          continue;
        }
        terrainPrefetchInFlight.add(lbId);
        const cellId = (lbId | 0xffff) >>> 0;
        fetchIds.push({ lbId, cellId });
      }
    }
    if (fetchIds.length === 0) return;
    try {
      // Session 8: URGENT lane (fetch-semaphore bypass). This is the
      // rig-blocking collision fetch — the integrator freezes pose Z
      // until it lands, so the player's teleport/LB-entry cannot
      // complete behind speculative ring fetches (s8 capture: first-hop
      // rig flip waited 17.5s in the normal lane under a saturated pipe).
      const meshes = await fetch_landblock_heightmaps(
        new Uint32Array(fetchIds.map(f => f.cellId)),
        true
      );
      for (let i = 0; i < fetchIds.length; i += 1) {
        const { lbId } = fetchIds[i];
        try {
          const h = window.__sessionHandle;
          // F4-4 (bughunt 2026-06-09): pass the per-vertex terrain TYPE
          // codes alongside the heights so the wasm side can cache a water
          // grid for the deep-water walk-block (USE_WATER_COLLISION).
          //
          // Round-10 fix: the `terrainPrefetchedLbs.add(lbId)` used to sit
          // OUTSIDE this `if (h)`, so a null `window.__sessionHandle` latched
          // the landblock as "collision heightmap populated" while the wasm
          // side got nothing — permanently, because the Set is the only gate
          // on every later retry (handlePositionUpdate / world_stream /
          // spawn-kick all test `!terrainPrefetchedLbs.has(lbId)` first).
          // The handle is read AFTER an await, and `fireSubmit()` nulls
          // `window.__sessionHandle` synchronously (~L11076) on every
          // reconnect/retry — so an in-flight ring fetch that straddles a
          // reconnect poisoned up to 9 landblocks for the rest of the page's
          // life: the integrator then misses the height cache and the player
          // sinks/floats across those LBs with no way to re-trigger.
          // Marking only on a real populate keeps the retry path alive (the
          // in-flight bit is still cleared in the `finally` below, so the
          // next position update re-fetches). Same shape as the already-
          // correct throw path: `populateTerrain` throwing skips the add too.
          if (h) {
            h.populateTerrain(lbId, meshes[i].heights, meshes[i].terrainCodes);
            terrainPrefetchedLbs.add(lbId);
          }
          // 2026-05-09 follow-up: also paint this LB's terrain
          // tile into outdoorContainer if it hasn't been painted
          // yet. Without this branch the player walks into a new
          // landblock and sees the void beyond the startup-baked
          // 9-tile patch (collision still works because the wasm
          // cache populated above; the player just walks
          // invisibly across an unrendered terrain). Skipped
          // when liveScene isn't ready yet (renderNeighbourhood
          // hasn't completed) — the startup loop pre-populates
          // terrainMeshAddedLbs for the initial 9 LBs so we
          // don't double-paint them.
          // 2D PIXI terrain-tile paint (addLandblockToScene) RETIRED
          // 2026-06-18 (item 7c) → legacy/render_2d.js. Dead in 3D (gated
          // on liveScene/atlasTexture); the wasm populateTerrain above
          // already ran for collision/physics. The 3D path paints terrain
          // via init3D / scene3d.
        } catch (e) {
          console.warn(`[terrain] populateTerrain failed for 0x${lbId.toString(16)}:`, e);
        } finally {
          terrainPrefetchInFlight.delete(lbId);
          meshes[i].free();
        }
      }
    } catch (e) {
      for (const { lbId } of fetchIds) terrainPrefetchInFlight.delete(lbId);
      console.warn("[terrain] LB-change prefetch failed:", e);
    }
  }

  // A15-Q4 (2026-06-12): the renderer-neutral world streamer — the
  // load-bearing streaming block of handlePositionUpdate, extracted to
  // scene3d/world_stream.js. Instantiated here (after the ensure*
  // helpers + their idempotency Sets) and invoked, under
  // `?unifiedDispatch=on`, as the KIND.POSITION NEUTRAL hook of
  // `__dispatch2d` below — i.e. world streaming is owned by the
  // neutral layer (retail: CellManager::ChangePosition inside
  // SmartBox::UseTime), not by the 2D sprite handler. The four
  // idempotency Sets are passed BY REFERENCE (the ensure* helpers
  // mutate them internally). Flag-off: never invoked; the legacy
  // block inside handlePositionUpdate runs verbatim.
  const worldStreamer = createWorldStreamer({
    getLocalPlayerGuid: () => D.localPlayerGuid,
    emitLandblockChanged: (prevLb, lbId) => {
      if (window.__pluginClient) {
        window.__pluginClient.events.emit("landblockChanged", { prevLb, lbId });
      }
    },
    ensureTerrainAroundLandblock,
    ensureBuildingAabbsAroundLandblock,
    ensureCellContainersForLandblock,
    ensureLandblockObjectsForLandblock,
    getLiveScene3d: () => window.liveScene3d ?? null,
    terrainPrefetchedLbs,
    buildingAabbsPopulatedLbs,
    cellContainersPopulatedLbs,
    objectsRenderAddedLbs,
  });
  window.__worldStreamer = worldStreamer; // headless-test / diag introspection

  function handlePositionUpdate(upd) {
    // No meta on Position — reuse what the prior Spawn deposited
    // on this guid's entry. If Position arrives before any Spawn
    // (PrivateUpdatePosition for the local player), the entry will
    // be a generic-grey placeholder until ObjectCreate lands.
    const guid = upd.guid >>> 0;
    // Workstream G (3D camera/game-feel fix, 2026-05-11): hoist the
    // local-player LB-prefetch out of the `if (!entry) return` early-
    // return at line ~4074. The prior structure gated the prefetch
    // on `ensureEntitySprite(guid, 0, null)` returning a non-null
    // entry — that function returns null when `liveScene` is null
    // (which is the case under `?renderer=3d` because the 2D PIXI
    // `renderNeighbourhood` call site is skipped). Without the
    // hoist, the four wasm-side bake calls (terrain heightmap,
    // building AABBs, EnvCell physics_polygons, objects/buildings
    // visual atlas) never fire for the local player in 3D mode →
    // the integrator's indoor pre-bake gate (academy-rubberband
    // follow-on, 2026-05-10) keeps the player frozen on the
    // spawn cell because `cell_physics_index` and
    // `building_aabb_index` are empty for the Academy LB.
    //
    // The four prefetch helpers are themselves idempotent and
    // guard against missing `liveScene` for their 2D-rendering
    // side effects:
    //   - `ensureTerrainAroundLandblock`     — calls
    //     `h.populateTerrain(lbId, heights)` unconditionally; only
    //     the `addLandblockToScene` PIXI-render branch checks
    //     `liveScene`.
    //   - `ensureBuildingAabbsAroundLandblock` — calls
    //     `populateBuildingAabbsForLandblock(lbId)` unconditionally
    //     (pure wasm-side bake — no PIXI work).
    //   - `ensureCellContainersForLandblock`  — calls
    //     `fetchEnvCellsInLandblock(lbId)` BEFORE the `liveScene`
    //     check, so the wasm-side `cell_physics_index` populates
    //     correctly; only the bake-and-PIXI-attach branch needs
    //     liveScene.
    //   - `ensureLandblockObjectsForLandblock` — short-circuits at
    //     `if (!liveScene || !liveScene.outdoorContainer) return;`
    //     so it stays a no-op in 3D mode (pure 2D PIXI work). The
    //     3D path has its own buildings/objects pipeline via
    //     `init3D` / `buildHoltburgBuildings`.
    // So calling all four for the local player regardless of
    // liveScene is safe + idempotent + correct.
    if (
      D.localPlayerGuid !== null
      && guid === (D.localPlayerGuid >>> 0)
    ) {
      if (__UNIFIED_DISPATCH) {
        // A15-Q4: world streaming is owned by the renderer-NEUTRAL
        // layer — `__dispatch2d`'s KIND.POSITION neutral hook already
        // ran `worldStreamer.onPositionUpdate(upd)` BEFORE this 2D
        // backend handler (entity_dispatch.js runs neutral before
        // backend). Nothing to do here. The legacy block in the
        // `else` is the flag-off copy; the headless drift guard
        // (test_a15_q4_renderer_neutral_core.mjs) enforces
        // call-sequence parity with world_stream.js via the paired
        // A15-Q4-SYNC markers until graduation deletes it.
      } else {
      // A15-Q4-SYNC: begin streaming sequence (keep in lockstep with
      // scene3d/world_stream.js#onPositionUpdate).
      const lbId = ((upd.landblockId >>> 16) << 16) >>> 0;
      // Session 8: stamp the server-authoritative LB BEFORE the load
      // hooks fire so the destination 3×3 rides the urgent lane from
      // its first ask (the rig-derived urgency center can lag a
      // teleport by seconds under bake saturation — s8 capture).
      try { window.liveScene3d?.landblockLru?.noteServerLb?.(lbId); } catch (_) {}
      // Emit `landblockChanged` on the first known LB and on any
      // subsequent LB transition. Plugins subscribe to clear
      // zone-scoped state (e.g. combat-bar's armed spell).
      if (lbId !== 0 && lbId !== D.lastLocalPlayerLb) {
        const prevLb = D.lastLocalPlayerLb;
        D.lastLocalPlayerLb = lbId;
        if (window.__pluginClient) {
          window.__pluginClient.events.emit("landblockChanged", { prevLb, lbId });
        }
      }
      if (lbId !== 0 && !terrainPrefetchedLbs.has(lbId)) {
        // Fire-and-forget; the integrator preserves pose Z on
        // cache miss until the prefetch lands.
        ensureTerrainAroundLandblock(lbId);
      }
      // Phase 6 step B follow-up: mirror the terrain prefetch
      // for building AABBs. Same trigger (every position update
      // for the local player), same 3x3 ring, same lazy gate.
      // Until this lands collision, the player walks through
      // walls outside the spawn neighbourhood.
      if (lbId !== 0 && !buildingAabbsPopulatedLbs.has(lbId)) {
        ensureBuildingAabbsAroundLandblock(lbId);
      }
      // Phase 6 step C: lazy-fetch + bake EnvCells when entering
      // a landblock. Single-LB scope (not a 3x3 ring) because
      // interior cells only matter when the player is inside the
      // building. Phase 6 step D's per-frame `tickCellVisibility`
      // toggles the per-cell `.visible` once the player's cell
      // graph + render set lands.
      // s13 gate (2026-07-11, 1120-appendix A5/T08): 2D renderer ONLY
      // (seventh `renderer` parse site; the others read `!== "2d"`).
      // Under ?renderer=3d the 2D `liveScene` is permanently null, so
      // this path fetched the LB's EnvCells only to DISCARD them at the
      // `!app` gate — while cells.js buildEnvCellsForLandblock
      // re-fetches the same cells under its own dedup set. That made
      // every cold indoor LB decode 2×.
      if (
        lbId !== 0
        && !cellContainersPopulatedLbs.has(lbId)
        && new URLSearchParams(window.location.search).get("renderer") === "2d"
      ) {
        ensureCellContainersForLandblock(lbId);
      }
      if (lbId !== 0 && window.liveScene3d?.loadEnvCellsForLandblock) {
        window.liveScene3d.loadEnvCellsForLandblock(lbId);
      }
      // World-expand step 1 Objective 6 (2026-05-14): mirror the
      // wasm-side terrain/building/cell prefetch ring for the 3D
      // mesh layers. Each baker is idempotent via its respective
      // `Set<lbKey>` (terrainBakedLbs / buildingsBakedLbs /
      // staticsBakedLbs) so walking back into an already-baked LB
      // is an O(1) hash hit. Without these hooks the 3D renderer
      // stays clamped to the initial ring (13×13 at init via
      // Objective 8) and the player sees void tiles when stepping
      // outside it. Scope split matches the wasm-side hooks:
      // terrain warrants a 3×3 ring (LOD + edge stitching);
      // buildings + statics are 1-LB (no cross-LB dependency).
      if (lbId !== 0 && window.liveScene3d?.loadTerrainForLandblock) {
        const cx = (lbId >>> 24) & 0xff;
        const cy = (lbId >>> 16) & 0xff;
        // A4 (2026-07-11 s13): collect-then-handoff to the batched
        // loadTerrainRing facade — ONE fetch_landblock_heightmaps for the
        // ring's not-yet-baked LBs (?terrainRingBatch=off restores 9-solo
        // inside the facade). Fall back to the solo loop when the facade is
        // absent (older scene3d bundle). Keep byte-parallel to the
        // world_stream.js copy — the A15-Q4-SYNC drift guard enforces it.
        if (window.liveScene3d.loadTerrainRing) {
          window.liveScene3d.loadTerrainRing(cx, cy);
        } else {
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              const nx = cx + dx;
              const ny = cy + dy;
              if (nx < 0 || nx > 0xff || ny < 0 || ny > 0xff) continue;
              // Fire-and-forget; per-LB baker is idempotent via
              // terrainBakedLbs.
              window.liveScene3d.loadTerrainForLandblock(nx, ny);
            }
          }
        }
      }
      if (lbId !== 0 && window.liveScene3d?.loadBuildingsForLandblock) {
        const cx = (lbId >>> 24) & 0xff;
        const cy = (lbId >>> 16) & 0xff;
        window.liveScene3d.loadBuildingsForLandblock(cx, cy);
      }
      if (lbId !== 0 && window.liveScene3d?.loadStaticsForLandblock) {
        const cx = (lbId >>> 24) & 0xff;
        const cy = (lbId >>> 16) & 0xff;
        window.liveScene3d.loadStaticsForLandblock(cx, cy);
      }
      // === Phase D.1 (2026-05-14) — synthetic ACE entity-spawn
      // injection for the new LB. Third placement stream alongside
      // loadTerrain / loadBuildings / loadStatics. Reads pre-staged
      // JSONL via `fetch_landblock_spawns`, resolves wcid →
      // setupDid via `wcid_to_setup.json`, then replays each
      // record through `window.__scene3dEntityHook` (the SAME
      // dispatcher a live ACE wire feeds). Idempotent per LB.
      // See `scene3d/spawns.js` for the contract.
      if (lbId !== 0 && window.liveScene3d?.loadSpawnsForLandblock) {
        const cx = (lbId >>> 24) & 0xff;
        const cy = (lbId >>> 16) & 0xff;
        window.liveScene3d.loadSpawnsForLandblock(cx, cy);
      }
      // 2026-05-09 follow-up (open-world step 2/3 + 3/3): paint
      // building meshes + non-building object sprites for the
      // new LB so the player sees landmarks, not just textured
      // ground. Same single-LB scope as the EnvCell trigger;
      // buildings/objects beyond the current LB matter less for
      // immediate exploration than the LB the player is standing
      // in (a follow-up could expand to a 3x3 ring like terrain
      // if performance allows). 3D mode: this helper is gated on
      // `liveScene.outdoorContainer` and is a no-op (the 3D path
      // builds its own outdoor objects via init3D).
      if (lbId !== 0 && !objectsRenderAddedLbs.has(lbId)) {
        ensureLandblockObjectsForLandblock(lbId);
      }
      // A15-Q4-SYNC: end streaming sequence.
      }
    }
    // handlePositionUpdate's 2D-only sprite/lerp/velocity tail RETIRED
    // 2026-06-18 (item 7b) → legacy/entity_2d.js. In 3D (the default)
    // liveScene is null; the shared streaming body above already ran.
    if (!window.liveScene) return;
  }

  function handleEntityRemove(upd) {
    const entry = entityMap.get(upd.guid);
    if (!entry) return;
    if (entry.nameplate) entry.nameplate.destroy();
    if (entry.portalSwirl) entry.portalSwirl.destroy();
    if (entry.portalChip) entry.portalChip.destroy();
    // Guard like the three children above: since the 2D retirement the
    // only populator (dispatch2dSpawn) is a no-op, so an entry can reach
    // here with no `.sprite`. An unguarded throw here would skip the
    // entityMap.delete below AND abort the whole entity-drain loop (it
    // has no per-update try/catch), dropping the batch's remaining
    // upd.free() calls and that frame's tickMovement heartbeat.
    if (entry.sprite) entry.sprite.destroy();
    entityMap.delete(upd.guid);
  }

  // Phase 6 step E follow-up (2026-05-09): given a door entity
  // (entityMap entry whose sprite carries the door's world
  // position), find the closest building part container in
  // liveScene.buildingMap so the kind=15 DoorStateChanged
  // handler can rotate the building's static door part to
  // match the door entity's swing.
  //
  // Fallback path: the wasm-side `Scene::register_door_part`
  // is now wired to live ObjectCreate (recv-loop sweeps the
  // building AABB index for the door's spawn pose and binds
  // the GUID), so the kind=15 handler asks
  // `handle.getBuildingPartForDoor` first and only falls back
  // to this spatial scan when the indexed lookup misses —
  // either because ObjectCreate raced
  // `populateBuildingAabbsForLandblock`, or because the door
  // is admin-spawned in a dynamic dungeon outside the
  // LandblockInfo.buildings flow.
  //
  // The 5 m threshold safely catches the intended part while
  // rejecting wall sprites that happen to be in the same
  // building (Holtburg buildings have at most one or two
  // doors, and the door entity's broadcast position lands
  // within ~0.5 m of the door part's centre). Returns
  // `{ container, sprite }` on a hit (sprite is the per-part
  // PIXI sprite to rotate), null on no match.
  // findClosestBuildingPart (2D PIXI door-part spatial match) was RETIRED
  // 2026-06-18 (2D-PIXI-retirement). It rotated building door-part PIXI
  // sprites in the 2D renderer; the 3D path rotates inst.root / plays the
  // Rust door swing instead. Preserved in legacy/door_2d.js. Zero 3D
  // readers (verified at extraction).

  // Phase 4 step 6f (portal destination chips): merge a kind=3
  // META_REFRESH update into an existing entityMap entry. Today
  // this only carries `portalDestination` (the
  // `AppraisalPortalDestination` text from ACE's
  // IdentifyObjectResponse). Future meta-only updates (sign
  // inscriptions delivered post-spawn, etc.) plug into the same
  // dispatch path with their own field guards.
  function handleEntityMetaRefresh(upd) {
    const guid = upd.guid >>> 0;
    const entry = entityMap.get(guid);
    if (!entry) return;
    const dest = upd.portalDestination;
    if (typeof dest === "string" && dest.length > 0) {
      if (!entry.meta) entry.meta = {};
      entry.meta.portalDestination = dest;
      ensurePortalChip(entry);
    }
  }

  // Phase 4 step 6f: lazy-mint (or refresh) the destination chip
  // text under a portal sprite. Renders as a small italic cream
  // PIXI.Text in nameplateContainer (NOT scaled by camera, so it
  // stays at 11px screen-space at every zoom level — same pattern
  // as nameplates). Position re-projected per frame in
  // updateNameplatePositions; this function only owns the
  // allocation + the text content.
  //
  // Idempotent: if the entry already has a chip, just update the
  // text. Skipped for non-portals + entities without a destination
  // string.
  function ensurePortalChip(entry) {
    if (!D.liveScene || !entry || !entry.meta) return;
    if (entry.meta.category !== "portal") return;
    const dest = entry.meta.portalDestination;
    if (!dest) return;
    const display = `→ ${dest}`;  // → <destination>
    if (entry.portalChip) {
      if (entry.portalChip.text !== display) entry.portalChip.text = display;
      return;
    }
    // 2D PIXI.Text portal-destination chip RETIRED 2026-06-18 (item 8) →
    // legacy/entity_2d.js. The function early-returns above on !liveScene
    // (so this is dead in 3D); it was the last remaining PIXI.* reference
    // in index.html, which let the pixi.js import + importmap pin be removed.
  }

  // Tier 2: per-rAF animation cycler. Walks every entityMap
  // entry; for those with cached walkFrames AND speedMps above
  // the moving threshold, advances a frame index by `dt *
  // walkRate` and swaps `sprite.texture` to the corresponding
  // frame. Idle entities (speed below threshold) revert to the
  // static idle texture cached at bake time.
  //
  // Performance: O(N) per frame over entityMap. The texture-swap
  // itself is a PIXI texture-binding change — cheap; PIXI
  // batches by texture so swapping triggers one batch flush per
  // frame across all walkers, but at ~60 fps that's tens of
  // batches/sec, negligible.
  //
  // Lazy walk-bake: the first time an entity's speed crosses
  // the moving threshold, kickWalkFrameBakeIfNeeded is fired
  // (no-op if already baked or in-flight) so we don't pre-bake
  // walk frames for entities that never move (signs, doors,
  // immobile NPCs). Static placements are also exempt because
  // they don't have a meta with substitutions; only Spawn-fed
  // entries see this path.
  const WALK_MOVING_THRESHOLD_MPS = 0.4;
  const WALK_FRAME_RATE = 12.0;  // frames-per-second cycle rate
  // Position-interpolation polish: ACE pushes
  // PublicUpdatePosition at ~100-300 ms cadence; non-local
  // entities snap-rendered between echoes looked stuttery in
  // crowded zones. handlePositionUpdate seeds lerp state on
  // every kind=0 EntityUpdate (except local player —
  // step 3.5 prediction owns that path), and
  // tickEntityInterpolation eases sprite.x/y from
  // (lerpFromX, lerpFromY) → (lerpToX, lerpToY) over this
  // duration. 150 ms is the sweet spot — long enough to
  // smooth the worst 300 ms gap, short enough that the
  // visual lag stays imperceptible against the ~100 ms
  // best case.
  const ENTITY_LERP_DURATION_MS = 150;
  // Velocity-extrapolation polish: VectorUpdate (kind=4) lands
  // ACE's authoritative `(velocity, omega)` for an entity. We
  // store it on the entityMap entry and use it to keep the
  // sprite moving AFTER the catch-up lerp completes — bridging
  // the gap until the next PublicUpdatePosition echo arrives.
  // If no velocity-hint arrives within this window we treat
  // the velocity as stale and freeze the sprite at lerpTo
  // (rather than extrapolating into the void with potentially
  // stale data).
  const ENTITY_VELOCITY_STALE_MS = 500;
  let walkPhase = 0.0;
  let lastAnimTickTime = null;
  // tickEntityInterpolation (2D sprite lerp) RETIRED → legacy/entity_2d.js.
  function handleEntityVelocity(upd) {
    // Stash ACE's authoritative `(velocity, omega)` on the
    // entityMap entry. The local player skips this — its
    // step 3.5 keystate-driven prediction is what makes WASD
    // feel responsive; using server velocity for the local
    // sprite would chase reconciled positions on top of the
    // already-running prediction.
    const guid = upd.guid >>> 0;
    const isLocal =
      D.localPlayerGuid !== null && guid === (D.localPlayerGuid >>> 0);
    if (isLocal) return;
    const entry = entityMap.get(guid);
    if (!entry) return;
    entry.velX = upd.vx;
    entry.velY = upd.vy;
    // vz / omegaZ surfaced for future use (jump animation,
    // turn-rate prediction); the top-down renderer doesn't
    // consume them today.
    entry.velZ = upd.vz;
    entry.omegaZ = upd.omegaZ;
    entry.velUpdatedMs = performance.now();
  }

  // ENTITY_UPDATE_KIND_MOTION (kind=5) — ACE-authoritative
  // motion-state hint from `UpdateMotion`. Lets
  // tickEntityAnimations gate walk-cycle frames on the server's
  // decision instead of an EMA over PublicUpdatePosition deltas.
  // Raw `InterpretedMotionCommand` u16 values
  // (mirrors `holtburger-protocol::messages::movement::types`):
  const MOTION_CMD_STOP = 0x0004;
  const MOTION_CMD_WALK_FORWARD = 0x0005;
  const MOTION_CMD_WALK_BACKWARDS = 0x0006;
  const MOTION_CMD_RUN_FORWARD = 0x0007;
  const ENTITY_MOTION_STALE_MS = 500;
  function handleEntityMotion(upd) {
    // Same local-player exclusion as handleEntityVelocity: the
    // local sprite's animation state is already driven by step
    // 3.5's keystate prediction; layering a server-confirmed
    // motion command on top would cause animation flicker around
    // the moment ACE acknowledges the keystate change (the
    // server's command is one round-trip behind the local
    // keystate).
    //
    // Exception: stance updates DO apply to the local player —
    // we route them to the vitals-header stance indicator so the
    // hotkey's "pending" label flips to the confirmed label
    // once ACE echoes the change. The animation gate still
    // skips local for kind=5 (the local sprite's predictor owns
    // walk/run frames), but stance display is independent of
    // the animation gate.
    const guid = upd.guid >>> 0;
    const isLocal =
      D.localPlayerGuid !== null && guid === (D.localPlayerGuid >>> 0);
    if (isLocal) {
      if (typeof applyConfirmedStance === "function") {
        applyConfirmedStance(upd.motionStance >>> 0);
      }
      // Bug 2 (2026-10-07): the 3D rig's stance is applied ONCE, by loop.js
      // `_armMotion` (setLocalStance). This second call (Track B9's
      // belt-and-suspenders) ran after the cast gesture had started, saw the
      // held gesture and issued Ready, so your own cast never showed the
      // arms-out hold — the recoil played straight after the raise.
      return;
    }
    const entry = entityMap.get(guid);
    if (!entry) return;
    entry.motionCommand = upd.motionCommand >>> 0;
    entry.motionStance = upd.motionStance >>> 0;
    entry.motionUpdatedMs = performance.now();
  }

  // ── A15-Q4 (2026-06-12): named 2D drain pieces ──────────────────
  // The drainEvents kind-1/kind-2 inline blobs, extracted so BOTH
  // routes (the legacy flag-off if-chain and the flag-on
  // `__dispatch2d` table) call the SAME functions — behavior
  // identical by construction, no second copy.
  //
  // dispatch2dSpawn — the QUARANTINED 2D sprite half of KIND_SPAWN:
  // liveScene-ready spawns go straight to handleEntitySpawn; pre-
  // liveScene spawns are cloned into the `deferredSpawns` ring
  // (A15-Q1 cap) unless `?spawnDefer2dOnly` says 3D mode never
  // drains them.
  function dispatch2dSpawn(upd) {
    // 2D PIXI spawn handler RETIRED 2026-06-18 (item 7b). The 3D
    // EntityManager (scene3d/loop.js em.spawn) owns spawn; under the
    // default ?renderer=3d, liveScene is permanently null so this was
    // already effectively a no-op (the deferredSpawns buffer was never
    // drained). Body moved to legacy/entity_2d.js. No-op now.
  }
  // neutralSpawn — the renderer-NEUTRAL Chorizite worldObjectManager
  // feed (no retail analog; renderer-independent by construction).
  // Entity-Completeness E.B: feeds the three canonical-classifier
  // inputs (item_type + obj_desc_flags + weenie_flags); the manager
  // runs canonicalClassify() — same algorithm as ACPlugin / retail
  // acclient.exe. Read-only over upd; no .free() or mutation.
  // Pre-load spawns silently dropped per manager's loaded-guard.
  function neutralSpawn(upd) {
    if (D.worldObjectManager) {
      D.worldObjectManager.onObjectCreated({
        guid: upd.guid >>> 0,
        classId: upd.wcid >>> 0,
        itemType: upd.itemType >>> 0,
        objDescFlags: upd.objDescFlags >>> 0,
        weenieFlags: upd.weenieFlags >>> 0,
        name: upd.name || null,
      });
    }
  }
  function neutralRemove(upd) {
    if (D.worldObjectManager) {
      D.worldObjectManager.onObjectDeleted({ guid: upd.guid >>> 0 });
    }
  }
  // __dispatch2d — the 2D-host dispatcher over the shared kind table
  // (scene3d/entity_dispatch.js; retail: the single
  // DispatchSmartBoxEvent funnel). Invoked from the drainEvents
  // entity loop ONLY under `?unifiedDispatch=on`; flag-off keeps the
  // legacy if-chain (which calls the same named pieces above).
  // NEUTRAL table = world streaming + worldObjectManager feed (runs
  // exactly once per update, here — the loop.js 3D dispatcher's
  // neutral table is EMPTY by invariant). BACKEND table = the
  // QUARANTINED 2D sprite backend, kinds 0-5 only (RULINGS.md item
  // 2: kinds 6-9 are a documented feature gap of the supported 2D
  // mode — now surfaced via the dispatcher's one-time accounting
  // info instead of silence). Never calls upd.free() — the drain
  // loop owns the wasm-bindgen lifetime.
  const __dispatch2d = createEntityDispatcher({
    label: "2d-drain",
    neutral: {
      // Q4.1 — world streaming is owned by the NEUTRAL layer.
      [ENTITY_KIND.POSITION]: (upd) => worldStreamer.onPositionUpdate(upd),
      [ENTITY_KIND.SPAWN]: neutralSpawn,
      [ENTITY_KIND.REMOVE]: neutralRemove,
    },
    backend: {
      [ENTITY_KIND.POSITION]: handlePositionUpdate, // streaming-skipping under flag-on (Q4.1)
      [ENTITY_KIND.SPAWN]: dispatch2dSpawn,
      [ENTITY_KIND.REMOVE]: handleEntityRemove,
      [ENTITY_KIND.META_REFRESH]: handleEntityMetaRefresh,
      [ENTITY_KIND.VELOCITY]: handleEntityVelocity,
      [ENTITY_KIND.MOTION]: handleEntityMotion,
    },
  });

  // Phase 6 step D: per-frame cell visibility ticker. Reads the
  // wasm-side snapshot of the player's current cell + depth=1 BFS
  // render set, toggles `.visible` on each cell container that
  // changes membership. Diff-only — only walks when the render
  // set or current cell actually changes, so a stationary player
  // pays one set-equality check per frame and zero PIXI mutation.
  //
  // Outdoor terrain handling (2026-05-09 follow-up): when the
  // wasm-side `isCurrentCellIndoor()` is true, hide the entire
  // `outdoorContainer` (terrain + buildings + non-building
  // objects) as one PIXI batch toggle so the outdoor world
  // doesn't bleed through interior walls. Cell containers + live
  // entities stay direct children of `worldContainer`, so they
  // remain visible while indoor. Outdoor mode re-shows the
  // outdoor group; per-cell toggling continues regardless (an
  // empty render_set hides every interior cell).
  let lastCellRenderSetSig = "";
  let lastCurrentCellId = 0;
  let lastOutdoorVisible = null;
  // tickCellVisibility (2D cell .visible toggle) RETIRED → legacy/entity_2d.js.
  return { SPRITE_HEADING_OFFSET, ensureCellContainersForLandblock, ensureBuildingAabbsAroundLandblock, ensureTerrainAroundLandblock, handlePositionUpdate, handleEntityRemove, handleEntityMetaRefresh, handleEntityVelocity, handleEntityMotion, dispatch2dSpawn, neutralSpawn, neutralRemove, __dispatch2d };
}
