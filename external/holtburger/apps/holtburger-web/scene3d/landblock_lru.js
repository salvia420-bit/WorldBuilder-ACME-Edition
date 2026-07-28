// Landblock LRU — bounds the resident set of baked landblocks.
//
// Today (pre-LRU) the 13×13 spawn ring + every LB the player has ever
// walked into stays resident forever. Each LB owns:
//   - 1 terrain mesh (per-LB ShaderMaterial + per-LB BufferGeometry +
//     per-LB vertexTypesTex DataTexture)
//   - N building placement Groups (each Group's meshes share materials
//     via MaterialCache — those are NOT per-LB and must NOT be
//     disposed at LB eviction)
//   - N statics singleton Mesh/LOD nodes (same MaterialCache caveat)
//   - N EnvCell containers (one per cellId; LB owns all cells whose
//     cellId & 0xffff_0000 === lbKey)
//
// Cross-LB shared resources (NEVER touched here):
//   - statics InstancedMesh (one InstancedMesh per modelId batches
//     placements across the ENTIRE ring; no per-LB userData tag)
//   - MaterialCache surfaces (per-DID, shared across all LBs)
//   - terrain atlas / road texture (once-per-ring opts)
//   - building bake cache (`buildingBakeCache` Map)
//
// The LRU evicts containers + their PER-LB geometry/material/texture
// disposables. Cross-LB shares stay live. Re-entry to an evicted LB
// re-bakes via the existing lazy hooks (`loadTerrainForLandblock`
// etc.) — the bake's idempotency Sets are cleared on eviction so the
// re-entry actually re-runs the bake.

const LB_KEY_MASK = 0xffff_0000 >>> 0;

// Sealed-dungeon purge budget (2026-07-08): max LBs evicted per frame when
// entering a fully-enclosed dungeon (see tickEviction's sealedKeepLbKey path).
// Bounds the one-time dispose cost — a ~127-LB backlog drains in ~5-6 frames
// rather than one big hitch; nothing re-bakes (radius-0 prefetch), so it sticks.
// R-12 (net-fixwave P5, 2026-07-10): the count-per-FRAME budget inverted its
// own premise — it assumed frames are cheap, but the purge exists because
// frames are seconds apart at TN entry, so a ~127-LB backlog @24/frame meant
// ~6 near-frozen frames (a 10+ s crawl) instead of one accepted hitch. The
// default is now a TIME-budgeted drain: the first sealed tick gets a generous
// burst (~250 ms — one visible loading blip that clears most/all of the
// backlog, and lands every wasm collision clear in ONE TickMovement drain =
// one Arc-COW clone per table instead of six), subsequent ticks a few ms.
// This constant remains as the `?sealedEvictBurst=off` legacy arm.
const SEALED_EVICT_PER_TICK = 24;
const SEALED_FIRST_BURST_MS = 250;
const SEALED_STEADY_BUDGET_MS = 6;
const SEALED_EVICT_BURST_ON = (() => {
  try {
    const v = new URLSearchParams(window.location?.search || "").get("sealedEvictBurst");
    return !(v === "off" || v === "0" || v === "false");
  } catch (_) {
    return true;
  }
})();

// Sealed-purge keep-ring (session 11, 1118 §4 — the measured TN park↔unpark
// storm root cause). The sealed purge parks EVERY resident LB except the
// dungeon's own, bypassing the 3×3 always-resident floor "because no outdoor
// LB is visible" (tickEviction's sealed path). But `world_stream.js::
// onPositionUpdate` fires `loadTerrainForLandblock` for the player's FULL 3×3
// on every local-player position packet, and the loaders' already-baked
// fast-path (index.js loadTerrainForLandblock) UNPARKS any parked LB it hits.
// So the two systems fight over the keep LB's own 3×3 outdoor ring: the purge
// parks it, the very next position packet unparks it, the next purge tick
// re-parks it — a ping-pong that ran the whole sealed dwell. Measured (s11
// diagnostic, `s11-tn-storm-*/tn-storm-PRE.json`, ~9 ring LBs, stable sealed
// key = flaps 0-1 over 25 s): Town Network 3459 park / 3445 unpark, Underground
// 3027/3018, Storage 5961/5952 — i.e. park≈unpark, a pure re-attach ping-pong
// (matches the 1118 §4 battery's 3–4k TN reclaims; classic mode is WORSE — an
// evict clears the baked mark so onPositionUpdate re-DECODES instead of
// re-attaching). Fix: exempt the keep LB's 3×3 (Chebyshev ≤ 1) from the sealed
// purge — exactly the always-resident floor the normal path and the streaming
// layer already honor, so the two stop disagreeing. The purge still reclaims
// everything BEYOND the 3×3 (the ~118-of-127 backlog that motivated
// `sealedEvict`); the 9 kept LBs are flat ocean/mountain-skirt terrain already
// hidden by `sealedCull` (zero draw) — a ~1.4 MB residency concession for a
// 3–6k-op/stop storm. DEFAULT ON (matches the sealed family: `sealedCull`,
// `sealedEvict`, `sealedEvictBurst` are all unconditional default-on); applies
// in classic and warm-park alike since the fight exists in both.
// `?sealedKeepRing=off` restores the park-everything-but-keep behavior.
const SEALED_KEEP_RING_ON = (() => {
  try {
    const v = new URLSearchParams(window.location?.search || "").get("sealedKeepRing");
    return !(v === "off" || v === "0" || v === "false");
  } catch (_) {
    return true;
  }
})();
// The keep LB's exempted radius (Chebyshev): 1 = its 3×3 (what onPositionUpdate
// re-streams) when the fix is on, 0 = keep only (legacy) when off.
const SEALED_KEEP_RING_FLOOR = SEALED_KEEP_RING_ON ? 1 : 0;

// Phase 9a warm-park eviction (W4 residency design §3, 2026-07-10).
// Eviction PARKS instead of disposing — containers detach from the scene
// groups into a byte-budgeted pool, baked marks and the wasm collision
// stay, and re-entry re-ATTACHES instead of re-baking (retail's DBOCache
// freelist applied at our built-render-state layer). True dispose happens
// only under pool budget pressure, farthest/oldest first, amortized.
// DEFAULT ON (2026-07-10 session 6, W4 §3.1 flip): two consecutive
// full-telepoi batteries won on every axis (best arm 588 s vs 682/688 s
// controls, capped stops 10 vs 15/17), the 1070 real-render screenshot
// pairs (shots-wp-on vs -off, Eastham/Eastwatch at cap) are
// content-identical, and the functional round-trip probe (ci-smoke S6)
// parks/keeps-marks/unparks/re-attaches with 0 errors. The TN-entry
// park↔unpark storm (1114 §2b: track() after park → dual state → the next
// park() true-disposed the pool copy) is FIXED in session 7 by the
// in-flight-bake reclaim deferral + the track-while-parked merge (see
// _hasInFlightBake and track()). `?warmPark=off` escape;
// `?warmParkBudgetMb=N` tunes the pool (default 160 MB, lowered from 256 in the
// #7 outdoor-tour fix — counts CPU *and* GPU residency: detached objects keep
// their GL buffers until dispose(); the MAX_LIVE_GEOM governor below is the
// primary heap bound, this byte budget a secondary backstop).
const WARM_PARK_ON = (() => {
  try {
    const v = new URLSearchParams(window.location?.search || "").get("warmPark");
    return !(v === "off" || v === "0" || v === "false");
  } catch (_) {
    // No window/URLSearchParams = headless unit-test env: keep CLASSIC
    // eviction so the LRU suites keep exercising the dispose paths.
    return false;
  }
})();
const WARM_PARK_BUDGET_BYTES = (() => {
  try {
    const v = parseInt(
      new URLSearchParams(window.location?.search || "").get("warmParkBudgetMb") ?? "",
      10,
    );
    return (Number.isFinite(v) && v > 0 ? v : 160) * 1024 * 1024;
  } catch (_) {
    return 160 * 1024 * 1024;
  }
})();
// Amortize true-dispose from the pool (retail §1.3 style: eviction work per
// tick is bounded; the pool absorbs the burst).
const WARM_PARK_MAX_DISPOSE_PER_TICK = 2;

// ── R-outdoor residency governor (2026-07-14, tasks #6/#7/#8/#10) ──────────────
// The resident set has NO byte budget: `maxResident` is an LB COUNT cap (~203 at
// the full ring) that index.js says "effectively never fires", so a continuous
// multi-POI tour accumulates live GPU geometry unbounded (battery: geometries
// 6.5k→48.6k, heap→7 GB, a 22.6 s bulk-dispose stall). We govern directly on
// `renderer.info.memory.geometries` — the ACCURATE live-geometry counter
// (three.js ++ on first GPU use, -- in onGeometryDispose; verified). Crucially it
// responds to disposeParked (true dispose) but NOT to park (park detaches, keeps
// the GL buffer), so it is the right pool-pressure trigger: dispose parked LBs
// until live geometry ≤ MAX_LIVE_GEOM. `?maxLiveGeom=N` overrides; `off` disables
// (pre-fix count-cap-only). Default ON, 8000 — VALIDATED on the 2026-07-14 1070
// A/B (8-town continuous slice, gov-off vs cap=8000): it eliminated the mid-run
// stalls (OFF had a 34,106 ms freeze + 4541/2866 ms; ON's only >1 s frames were
// the first-POI cold-shader compile), lifted late-run fps 1.4-2.4× (Rithwic
// 13→32), and cut resident LBs 200→35 — while a single area stays ~few-hundred
// geometries (≪8000, so normal one-area play never engages it) and eviction is
// oldest-first (trailing edge), protecting the visible working set. `?maxLiveGeom=N`
// tunes; `off` disables. (The absolute heap floor is still #11-limited — a large
// fraction of geometry is untracked entities/atlas the LRU can't evict.)
const MAX_LIVE_GEOM = (() => {
  try {
    const raw = new URLSearchParams(window.location?.search || "").get("maxLiveGeom");
    if (raw == null) return 8000;
    if (raw === "off" || raw === "false" || raw === "0") return Infinity;
    const v = parseInt(raw, 10);
    return (Number.isFinite(v) && v > 0) ? v : 8000;
  } catch (_) { return 8000; }
})();
// #7/#10 resident→pool feed: when live geometry is over MAX_LIVE_GEOM, park this
// many EXTRA oldest-beyond-ring resident LBs per tick (beyond the count cap) to
// feed the pool — pool pressure then disposes them. Bounded so a big overage
// drains over a few ticks, not one hitch.
const GEOM_PRESSURE_PARK_PER_TICK = 6;
// #8 dispose-rate time budget for pool pressure. The flat 2/tick couldn't keep up
// with the ~2.5k-geom/POI inflow (dispose clumped → the 22.6 s Cragstone frame).
// Dispose parked LBs until this elapsed budget is spent (min 1/tick so it always
// makes progress). `?parkDisposeBudgetMs=0` restores the legacy 2/tick count.
const PARK_DISPOSE_BUDGET_MS = (() => {
  try {
    const raw = new URLSearchParams(window.location?.search || "").get("parkDisposeBudgetMs");
    if (raw == null) return 6;
    const v = parseInt(raw, 10);
    return (Number.isFinite(v) && v >= 0) ? v : 6;
  } catch (_) { return 6; }
})();

// park→DBOCache UseTime floor (S15a, PLAN-fixed-slot-grid-residency §2/§5,
// 2026-07-11). Retail's DBOCache (acclient.c:83485 `GetIfUsing`) holds decoded
// resources behind a ~30 s `UseTime` freelist floor: release ≠ free. Applied at
// our park layer — a parked slot younger than this floor is NOT true-disposed
// by park-pool byte PRESSURE (_tickParkPoolPressure), so a short-hop re-entry
// within the window is a pointer re-adopt (unpark), zero decode, zero bake.
// This generalizes sealedKeepRing ("keep the sealed ring") to "keep ANY
// recently-parked slot". The byte-budget LRU stays the memory backstop BEHIND
// the floor: pressure disposes only entries OLDER than the floor; if the budget
// is still exceeded with everything young, the overage is RECORDED (getStats
// useTimeDeferred* counters) and entries age out on later ticks — pressure
// never violates the floor. Explicit dispose paths that are NOT pressure-driven
// (evict-on-teleport whole-LB invalidation, flushParked, dispose()) are
// unchanged — the floor gates only pressure reclaim. `?parkUseTimeMs=N`
// overrides (0/off/false disables the floor entirely = pre-S15 behavior);
// absent → 30000. Footgun-safe: only an explicit numeric or the off-tokens
// change behavior.
const PARK_USE_TIME_MS = (() => {
  try {
    const raw = new URLSearchParams(window.location?.search || "").get("parkUseTimeMs");
    if (raw == null) return 30_000;
    if (raw === "off" || raw === "false") return 0;
    const v = parseInt(raw, 10);
    if (Number.isFinite(v) && v >= 0) return v;
    return 30_000;
  } catch (_) {
    // No window/URLSearchParams (headless unit-test env): keep the floor at
    // its default so the pressure path exercises the retention gate; suites
    // that need it off import with an explicit ?parkUseTimeMs=0 window stub.
    return 30_000;
  }
})();
// The cross-LB consolidators excise per-LB geometry destructively — park has
// no hide/show seam for them in v1, so their presence downgrades park to
// classic evict (correctness first; see W4 §3.6 risk table).
//
// ?terrainBatch is NO LONGER in this list (2026-07-28). It was never actually
// caught by the guard anyway — the URL-flag audit (2026-07-27) noted the
// DESYNC: terrain_batch has been DEFAULT-ON since 2026-07-03 while this test
// only detects an EXPLICIT `?terrainBatch=on|1|true`, so every default session
// already ran park concurrently with the terrain consolidator. Rather than
// disable warm-park for the whole default fleet, terrain_batch grew the
// missing seam: `_parkTerrainBatchForLb` / `_unparkTerrainBatchForLb`
// hide/show the LB's row (see park() and unpark() below), with a slot-steal
// fallback for the hard 256-layer cap. Dropping the term here just makes the
// EXPLICIT `?terrainBatch=on` session behave like the default one.
const WARM_PARK_SUPPORTED = (() => {
  try {
    const ps = new URLSearchParams(window.location?.search || "");
    const on = (v) => v === "on" || v === "1" || v === "true";
    return !on(ps.get("statBatchCrossLb"));
  } catch (_) {
    return true;
  }
})();

// Reclaim-center freshness gate (battery follow-up #1, 2026-07-10).
// `getCurrentLbId` is rig-position-derived and can stay STALE through the
// post-teleport window (the documented `pose.landblockId` freeze): the ring
// loaders are already baking the ARRIVING ring while the reclaim center
// still points at the OLD one, so at-cap reclaim victimizes the fresh bakes
// (the ringFloor=ringMax A/B amplified it to 8515 park ops by protecting
// the OLD ring wholesale). The gate: when the center JUMPS ≥2 LBs (a
// teleport — a walk moves 1), hold the normal at-cap reclaim until the new
// center LB's own bake is tracked (its `entries` mark is the "loaders have
// caught up" signal), with a hard timeout so a never-tracked center (e.g.
// sealed-dungeon POI whose LB routes through the sealed path) can't starve
// eviction forever. Sealed purge + park-pool byte pressure are NOT gated.
//
// DEFAULT FOLLOWS ?warmPark (session-6 7-arm battery, findings s6 doc):
// under warm-park the gate+hysteresis pair is a clear win (588 vs 682 s
// active, capped 10 vs 15) because a reclaim is a cheap re-attach; in
// CLASSIC mode the same pair REGRESSES the cycle (805 vs 688 s) — plain
// LRU recency already protects the arriving ring when reclaim means
// dispose+re-bake. `?reclaimGate=on|off` overrides either way.
const RECLAIM_GATE_ON = (() => {
  try {
    const v = new URLSearchParams(window.location?.search || "").get("reclaimGate");
    if (v === "on" || v === "1" || v === "true") return true;
    if (v === "off" || v === "0" || v === "false") return false;
    return WARM_PARK_ON && WARM_PARK_SUPPORTED;
  } catch (_) {
    return false;
  }
})();
const RECLAIM_GATE_MAX_HOLD_MS = 10_000;

// Park hysteresis (A11-F7, battery follow-up #2, 2026-07-10): the normal
// at-cap candidate filter skips entries touched less than this many ms ago,
// so a freshly-baked ring LB can't be reclaimed in the same second it lands
// (the park↔unpark ping-pong half that the gate alone doesn't cover:
// mid-stream, cap exceeded, center already fresh). The cap is soft — a
// tick where every candidate is young simply evicts nothing; candidates
// age in within seconds. `?reclaimMinAgeMs=N` overrides (0 disables);
// DEFAULT FOLLOWS ?warmPark exactly like the gate above (2000 under
// warm-park, 0 classic — same session-6 battery verdict).
const RECLAIM_MIN_AGE_MS = (() => {
  try {
    const v = parseInt(
      new URLSearchParams(window.location?.search || "").get("reclaimMinAgeMs") ?? "",
      10,
    );
    if (Number.isFinite(v) && v >= 0) return v;
    return WARM_PARK_ON && WARM_PARK_SUPPORTED ? 2000 : 0;
  } catch (_) {
    return 0;
  }
})();

function lbKeyFromXY(lbX, lbY) {
  return (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16)) >>> 0;
}

function lbKeyOf(landblockIdOrLbKey) {
  return (landblockIdOrLbKey & LB_KEY_MASK) >>> 0;
}

// 3×3 ring around a given lb-key (the player's current LB + 8
// neighbours). Wraps at world edges — out-of-range neighbours are
// dropped, never wrap to the other side of the world.
function ringKeysAround(lbKey) {
  const cx = (lbKey >>> 24) & 0xff;
  const cy = (lbKey >>> 16) & 0xff;
  const out = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx > 0xff || ny < 0 || ny > 0xff) continue;
      out.push(lbKeyFromXY(nx, ny));
    }
  }
  return out;
}

// Chebyshev distance in LB units (max of |dx|, |dy|) between two
// packed lb-keys. Used as the "always-resident" floor: 0 == same LB,
// 1 == 3×3 ring around player.
function lbChebyshev(a, b) {
  const ax = (a >>> 24) & 0xff;
  const ay = (a >>> 16) & 0xff;
  const bx = (b >>> 24) & 0xff;
  const by = (b >>> 16) & 0xff;
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

// streamFix urgent lane (2026-07-02): is `lbKey` within `radius` (Chebyshev,
// default 1 = the player's 3×3) of the player's CURRENT landblock? Used by
// the per-LB bakers (terrain/statics/buildings) to route their wasm fetches
// through the urgent lane (fetch-semaphore bypass — see
// manifest_source.rs::prefetch_urgent) so the town the player is standing in
// can't starve behind a rapid-teleport speculative ring backlog. Reads the
// player LB through the LRU's own `getCurrentLbId` (rig-position-derived —
// fresh across teleports, unlike `scene3d.playerLbKey` which is stamped by
// the terrain reconcile). Fail-soft `false` (normal lane) when the LRU/pose
// isn't wired (unit tests, capture paths) or `?streamFix=off`.
const STREAM_URGENCY_ENABLED = (() => {
  try {
    const v = new URLSearchParams(window.location?.search || "").get("streamFix");
    return v !== "off" && v !== "0" && v !== "false";
  } catch (_) {
    return true;
  }
})();

function isNearPlayerLb(scene3d, lbKey, radius = 1) {
  if (!STREAM_URGENCY_ENABLED) return false;
  try {
    const lru = scene3d?.landblockLru;
    const key = lbKeyOf(lbKey >>> 0);
    const cur = lru?.getCurrentLbId?.();
    if (
      typeof cur === "number" &&
      cur !== 0 &&
      lbChebyshev(lbKeyOf(cur >>> 0), key) <= radius
    ) {
      return true;
    }
    // Session 8 teleport-destination lane (1115 §4): the rig-derived
    // current LB flips only when the wasm rig actually moves, which under
    // bake saturation lags the teleport by many seconds (s8 capture: 17.5s
    // first-hop, destination 3×3 cap-skipped 299× in the normal lane the
    // whole time). The server position update names the destination ~1s
    // after the teleport — `noteServerLb` stamps it below, and urgency
    // honors EITHER center so destination bakes go urgent before the rig
    // catches up. The two keys agree outside the teleport window, so this
    // is a no-op for walking.
    const srv = lru?._serverLbKey;
    return typeof srv === "number" && srv !== 0 && lbChebyshev(srv, key) <= radius;
  } catch (_) {
    return false;
  }
}

export class LandblockLRU {
  constructor({ scene3d, maxResident, getCurrentLbId, onEvictLandblock = null, ringFloor = 1, debug = false } = {}) {
    if (!scene3d) throw new Error("LandblockLRU: scene3d required");
    this.scene3d = scene3d;
    // Server-authoritative player LB (see noteServerLb) — null until the
    // first position update stamps it.
    this._serverLbKey = null;
    // Phase 6 collision-leak fix (2026-05-29): optional hook fired in evict()
    // to purge the evicted LB's wasm-side SpatialScene collision (see evict()).
    this._onEvictLandblock = typeof onEvictLandblock === "function" ? onEvictLandblock : null;
    // No clamp: the 3×3 always-resident ring is enforced inside
    // tickEviction's candidate filter (Chebyshev distance ≤ 1 skipped),
    // so `?lbCap=1` still keeps the 9-LB floor cleanly.
    this.maxResident = Math.max(1, maxResident | 0);
    // Battery finding (2026-07-10, full-telepoi cycle): at cap, reclaim
    // ping-pongs with the ring loaders (~75 reclaims/stop — evict↔re-bake
    // in classic mode, park↔unpark under ?warmPark). A ringFloor=ringMax
    // A/B made it WORSE (see index.js construction note: stale reclaim
    // center right after a teleport). Default stays 1 (the 3×3); the param
    // remains for the follow-up once the center-freshness issue is fixed.
    this.ringFloor = Math.max(1, ringFloor | 0);
    this.getCurrentLbId = typeof getCurrentLbId === "function"
      ? getCurrentLbId
      : () => null;
    this.debug = !!debug;

    // Map<lbKey, { lastTouchMs: number, disposables: { geometries:[],
    //   materials:[], textures:[], lights:[], instancedNodes:[] } }>
    this.entries = new Map();

    this._evictedTotal = 0;
    this._lastEvictedLbKey = null;

    // Phase 9a warm-park pool: Map<lbKey, ParkedLb> (see park() for shape).
    this.parkPool = new Map();
    this.parkedBytes = 0;
    this.parkBudgetBytes = WARM_PARK_BUDGET_BYTES;
    this._parkedTotal = 0;
    this._unparkedTotal = 0;

    // park→DBOCache UseTime floor telemetry (S15a): how much reclaim the
    // floor deferred because the victim was younger than PARK_USE_TIME_MS.
    // Cumulative event counters (one bump per deferred parked entry per
    // pressure tick), sibling to _parkedTotal. Stay 0 when the floor is
    // disabled (?parkUseTimeMs=0) — the pre-S15 pressure path never defers.
    this._useTimeDeferredCount = 0;
    this._useTimeDeferredBytes = 0;

    // Reclaim-center freshness gate state (see the RECLAIM_GATE_ON note).
    this._lastCenterKey = null;
    this._centerJumpAtMs = 0;
    this._centerJumpsTotal = 0;
    this._gateHeldTicks = 0;

    // TN-storm fix telemetry (session 7, 1114 §2b/§5): dual-state
    // near-misses resolved by the track()-while-parked merge, and reclaim
    // victims deferred because a guarded bake was still in flight.
    this._trackMergedWhileParked = 0;
    this._reclaimDeferredInFlight = 0;

    // #7/#10 geom-pressure telemetry: extra oldest-beyond-ring resident LBs
    // parked to feed the pool because live geometry was over MAX_LIVE_GEOM.
    this._geomPressureParks = 0;

    // PHY-25 dungeon stream gate (P0.1, 2026-07-27): how many outdoor
    // load-point evaluations world_stream.js suppressed because the player
    // was indoors (cell low word >= 0x100). Surfaced here rather than in a
    // private streamer field because this is the counter that pairs with
    // parkedTotal / unparkedTotal — the per-packet ring re-fire this gate
    // removes is the documented park↔unpark storm driver (SEALED_KEEP_RING_ON
    // note above). Stays 0 outdoors and under ?dungeonStreamGate=off.
    this._streamGateHolds = 0;
  }

  // PHY-25 — bumped by scene3d/world_stream.js when the indoor gate holds an
  // outdoor load-point evaluation. Pure telemetry; never throws.
  noteStreamGateHold(n = 1) {
    this._streamGateHolds += n;
  }

  // #10 — the accurate live-geometry counter (three.js renderer.info; ++ on
  // first GPU use, -- on geometry.dispose). Responds to disposeParked, not to
  // park. Fail-soft 0 (headless unit-test env / pre-render).
  _liveGeometries() {
    try { return this.scene3d?.renderer?.info?.memory?.geometries ?? 0; }
    catch (_) { return 0; }
  }

  // TN-storm fix (2026-07-10 session 7, 1114 §2b root cause): an LB with an
  // in-flight guarded bake must not be parked — the bake's completion calls
  // track() AFTER park() detached the containers, leaving the LB in
  // `entries` AND `parkPool` (dual state), and the next park() of that key
  // true-disposes the pool copy (the measured 74–614 disposes/run behind
  // the S6 noDisposeStorm bound). The stream guard's in-flight set
  // (scene3d._streamGuardState — stream_bake_guard.js; keys
  // `<kind>:<decimal lbKey>`) is the authoritative "a track() is coming"
  // signal, and the three loaders call track() INSIDE the guarded run, so
  // membership here exactly brackets the race window. Victims skipped on
  // this signal are reclaimed a tick or two later once the bake lands.
  // Applied under warm-park only: classic evict+re-bake never had the
  // dual-state hazard, and its battery baseline stays byte-identical.
  _hasInFlightBake(lbKey) {
    const inFlight = this.scene3d?._streamGuardState?.inFlight;
    if (!(inFlight instanceof Set) || inFlight.size === 0) return false;
    return inFlight.has(`terrain:${lbKey}`)
      || inFlight.has(`buildings:${lbKey}`)
      || inFlight.has(`statics:${lbKey}`);
  }

  get warmParkEnabled() {
    return WARM_PARK_ON && WARM_PARK_SUPPORTED;
  }

  isParked(lbKey) {
    return this.parkPool.has(lbKeyOf(lbKey >>> 0));
  }

  // Session 8 teleport-destination lane — stamp the server-authoritative
  // player LB (from the position-update stream, both A15-Q4-SYNC copies).
  // Consumed only by `isNearPlayerLb` as a second urgency center; eviction
  // and reclaim keep reading the rig-derived `getCurrentLbId` unchanged.
  // Accepts a full landblockId or an lb-key; 0/invalid clears the note.
  noteServerLb(landblockId) {
    const k = lbKeyOf((landblockId ?? 0) >>> 0);
    this._serverLbKey = k === 0 ? null : k;
  }

  // Register an LB as resident. Idempotent — re-tracking the same lbKey
  // refreshes its disposable list (subsequent bakes that produced new
  // resources can extend the tracked refs).
  track(lbKey, options = {}) {
    const key = lbKeyOf(lbKey >>> 0);
    const now = (typeof performance !== "undefined")
      ? performance.now()
      : Date.now();
    // TN-storm fix, defensive half (see _hasInFlightBake): a track() that
    // still lands while the LB is parked (a bake the deferral couldn't see —
    // an envcell build resolving past its park-time cancellation, a
    // setup-lights rescan fanning in, a bake that STARTED against a parked
    // LB's unset kind-mark) must NOT create an `entries` entry next to the
    // pool copy. Merge the incoming disposables into the parked copy
    // instead: any containers the caller attached carry this LB's userData
    // tag, so BOTH pool exits stay consistent — unpark() re-attaches the
    // stashed containers alongside them and restores the merged disposables
    // as the entry, while disposeParked()→evict() removes them from the
    // scene groups by tag and disposes the merged lists. No attach/detach
    // happens here — the rejected unpark-on-track alternative (1114 §2b)
    // could duplicate same-kind scene content.
    const parked = this.parkPool.get(key);
    if (parked && !this.entries.has(key)) {
      this._trackMergedWhileParked += 1;
      this._appendDisposables(parked.disposables, options);
      return;
    }
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        lastTouchMs: now,
        disposables: { geometries: [], materials: [], textures: [], lights: [], instancedNodes: [] },
      };
      this.entries.set(key, entry);
    } else {
      entry.lastTouchMs = now;
      // Back-compat: entries created before the lights / instancedNodes
      // buckets existed (or by a stale shape) get them lazily so the
      // appends below + evict steps 5b/5c never touch undefined.
      if (!Array.isArray(entry.disposables.lights)) entry.disposables.lights = [];
      if (!Array.isArray(entry.disposables.instancedNodes)) entry.disposables.instancedNodes = [];
    }
    this._appendDisposables(entry.disposables, options);
  }

  // Shared disposable-append for track()'s normal path and its
  // track-while-parked merge branch. C3 #6 — per-LB SetupModel light
  // instances so eviction can splice/detach/dispose them synchronously.
  // C3 #7 — the cross-LB statics InstancedMesh / LOD nodes that cover this
  // LB so eviction can refcount them (each node carries a
  // `userData.coversLbKeys` Set; the node's geometry is disposed only when
  // the LAST covered LB evicts); dedup so re-tracking the same LB
  // (idempotent re-bake / re-walk) doesn't list a node twice under one
  // key. Callers omitting any bucket behave exactly as before
  // (back-compatible).
  _appendDisposables(d, options) {
    if (!Array.isArray(d.lights)) d.lights = [];
    if (!Array.isArray(d.instancedNodes)) d.instancedNodes = [];
    if (Array.isArray(options.geometries)) {
      for (const g of options.geometries) if (g) d.geometries.push(g);
    }
    if (Array.isArray(options.materials)) {
      for (const m of options.materials) if (m) d.materials.push(m);
    }
    if (Array.isArray(options.textures)) {
      for (const t of options.textures) if (t) d.textures.push(t);
    }
    if (Array.isArray(options.lights)) {
      for (const l of options.lights) if (l) d.lights.push(l);
    }
    if (Array.isArray(options.instancedNodes)) {
      const bucket = d.instancedNodes;
      for (const n of options.instancedNodes) {
        if (n && !bucket.includes(n)) bucket.push(n);
      }
    }
  }

  touch(lbKey) {
    const key = lbKeyOf(lbKey >>> 0);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.lastTouchMs = (typeof performance !== "undefined")
      ? performance.now()
      : Date.now();
  }

  // Per-frame eviction tick. Touches the player's LB + 3×3 ring (the
  // always-resident floor), then evicts the oldest entries beyond
  // `maxResident` until the resident count is ≤ maxResident.
  tickEviction(currentLbKeyArg, sealedKeepLbKeyArg = 0) {
    const currentLbKey = currentLbKeyArg != null
      ? lbKeyOf(currentLbKeyArg >>> 0)
      : null;

    // Sealed-dungeon residency purge (2026-07-08). When the player is in a
    // fully-enclosed indoor dungeon (isCurrentCellIndoor && no exterior
    // portal — see cells.js `_sealedEvictLbKey`), NO outdoor landblock is
    // ever visible, so evict every resident LB except the dungeon's OWN —
    // bypassing both `maxResident` and the 3×3 always-resident ring (which
    // only exists to keep the surface you can see, and here you can't). This
    // reclaims the surrounding ocean-skirt + mountain-wall terrain/statics
    // that otherwise stay baked and get walked every frame, pegging the main
    // thread at a hub dungeon. The dungeon LB itself is kept: its EnvCells are
    // the interior, and its flat outdoor terrain is cheap + already hidden by
    // the render cull. Time-sliced (SEALED_EVICT_PER_TICK/frame) so a ~127-LB
    // backlog drains over a few frames instead of one big dispose hitch;
    // `tickPvsLoadExpansion`'s radius-0 gate means nothing re-bakes, so the
    // purge sticks. `sealedKeepLbKeyArg === 0` disables (normal path below).
    if (sealedKeepLbKeyArg) {
      const keep = lbKeyOf(sealedKeepLbKeyArg >>> 0);
      if (!SEALED_EVICT_BURST_ON) {
        // Legacy `?sealedEvictBurst=off` arm — the 2026-07-08 24/frame
        // count staircase, byte-identical (park substitutes per-victim
        // reclaim under ?warmPark=on; order unchanged).
        const victims = [];
        for (const key of this.entries.keys()) {
          // Keep the dungeon LB AND (unless ?sealedKeepRing=off) its 3×3
          // always-resident floor — the ring onPositionUpdate re-streams
          // every position packet (see SEALED_KEEP_RING_ON: parking it just
          // feeds the loaders' unpark fast-path, the s11 storm).
          if (lbChebyshev(keep, key) <= SEALED_KEEP_RING_FLOOR) continue;
          // TN-storm fix (see _hasInFlightBake): the sealed purge at TN
          // entry is exactly where the park↔unpark storm was measured —
          // an in-flight bake's LB is skipped this tick and purged as a
          // normal straggler once its completion track() lands.
          if (this.warmParkEnabled && this._hasInFlightBake(key)) {
            this._reclaimDeferredInFlight += 1;
            continue;
          }
          victims.push(key);
          if (victims.length >= SEALED_EVICT_PER_TICK) break;
        }
        for (const key of victims) this._reclaim(key);
        this._tickParkPoolPressure(keep);
        return;
      }
      // R-12 time-budgeted drain. First tick after seal gets the big
      // burst; later ticks (stragglers that completed their bake after
      // the purge and re-tracked) a few ms. Measure ELAPSED, not count —
      // at least one eviction always runs so the drain can't starve.
      const victims = [];
      for (const key of this.entries.keys()) {
        // Keep the dungeon LB + its 3×3 floor (see SEALED_KEEP_RING_ON /
        // the legacy arm above) — parking the ring onPositionUpdate
        // re-streams is the s11 park↔unpark storm.
        if (lbChebyshev(keep, key) <= SEALED_KEEP_RING_FLOOR) continue;
        // TN-storm fix (see _hasInFlightBake + the legacy arm above):
        // defer in-flight-bake LBs to the straggler flow.
        if (this.warmParkEnabled && this._hasInFlightBake(key)) {
          this._reclaimDeferredInFlight += 1;
          continue;
        }
        victims.push(key);
      }
      if (victims.length === 0) {
        this._sealedDrainActive = false;
        this._tickParkPoolPressure(keep);
        return;
      }
      // Phase 9a (W4 §3.4): under warm-park, reclaim in DESCENDING Chebyshev
      // distance from the keep-LB — under later budget pressure the LBs
      // nearest the hub (the return path) park last and dispose last.
      if (this.warmParkEnabled) {
        victims.sort((a, b) => lbChebyshev(keep, b) - lbChebyshev(keep, a));
      }
      const budgetMs = this._sealedDrainActive
        ? SEALED_STEADY_BUDGET_MS
        : SEALED_FIRST_BURST_MS;
      this._sealedDrainActive = true;
      // O5 (A11): bucket the four scene groups' children by lb-key in ONE
      // pass for the whole tick — the per-victim rescans were K×4 full
      // group walks (~100k userData reads on a town backlog).
      const buckets = this._bucketGroupChildren(victims);
      const t0 = performance.now();
      let evicted = 0;
      for (const key of victims) {
        this._reclaim(key, buckets);
        evicted += 1;
        if (performance.now() - t0 > budgetMs) break;
      }
      if (evicted >= victims.length) this._sealedDrainActive = false;
      this._tickParkPoolPressure(keep);
      return;
    }
    // Not sealed (or no longer sealed): re-arm the first-burst budget for
    // the next sealed entry.
    this._sealedDrainActive = false;

    // lru-null-lb (2026-06-07): bail out entirely when we don't know the
    // player's current LB yet (getCurrentLbId() returned null during
    // pre-spawn boot, between LB transitions, or whenever the player pos
    // is unresolved). Without a current key the Chebyshev always-resident
    // ring is unknown, so eviction would pick candidates purely by
    // lastTouchMs and could blow away the player's own LB + its 3×3 ring
    // (e.g. ?lbCap=4 at boot → pre-spawn ring flicker). Skipping this
    // tick keeps everything resident until a real current LB resolves.
    if (currentLbKey == null) return;

    const nowMs = (typeof performance !== "undefined")
      ? performance.now()
      : Date.now();

    // Reclaim-center freshness gate (see RECLAIM_GATE_ON). A ≥2-LB center
    // jump = teleport (a walk transition moves exactly 1); from that moment
    // hold the at-cap reclaim below until the NEW center's own bake lands
    // in `entries` (the "loaders caught up" mark) or the hard timeout runs
    // out. The always-resident floor touch + park-pool byte pressure still
    // run every tick — the gate only pauses victim selection while the
    // arriving ring and the (possibly still stale) center disagree.
    if (RECLAIM_GATE_ON) {
      if (this._lastCenterKey != null
          && lbChebyshev(currentLbKey, this._lastCenterKey) >= 2) {
        this._centerJumpAtMs = nowMs;
        this._centerJumpsTotal += 1;
      }
      this._lastCenterKey = currentLbKey;
    }

    // Refresh the always-resident floor's timestamps so they're never
    // candidates for eviction even under adversarial maxResident < 9.
    this.touch(currentLbKey);
    for (const k of ringKeysAround(currentLbKey)) this.touch(k);

    if (RECLAIM_GATE_ON && this._centerJumpAtMs > 0) {
      if (nowMs - this._centerJumpAtMs < RECLAIM_GATE_MAX_HOLD_MS
          && !this.entries.has(currentLbKey)) {
        this._gateHeldTicks += 1;
        this._tickParkPoolPressure(currentLbKey);
        return;
      }
      this._centerJumpAtMs = 0; // released (center tracked, or timed out)
    }

    // Always drain the park pool (byte + live-geometry pressure) even when the
    // resident COUNT is under maxResident — parked LBs must flow out
    // continuously, not only when the count cap is exceeded (the pre-fix early
    // return skipped pressure on every under-cap tick, so parked geometry only
    // drained once resident > ~203). `overGeom` also forces candidate selection
    // below so resident LBs feed the pool when live geometry is over budget even
    // though the count cap hasn't fired.
    const overGeom = this._liveGeometries() > MAX_LIVE_GEOM;
    if (this.entries.size <= this.maxResident && !overGeom) {
      this._tickParkPoolPressure(currentLbKey);
      return;
    }

    // Collect eviction candidates: every tracked LB OUTSIDE the streaming
    // ring (`lbChebyshev(currentLbKey, key) > ringFloor` — see the
    // constructor note; was 1, which made the live ring self-cannibalize at
    // cap) AND older than the hysteresis window (RECLAIM_MIN_AGE_MS — a
    // fresh bake can't be a victim in the same second it lands). Sort
    // ascending by lastTouchMs → oldest evicted first.
    const candidates = [];
    for (const [key, entry] of this.entries) {
      if (currentLbKey != null && lbChebyshev(currentLbKey, key) <= this.ringFloor) continue;
      if (RECLAIM_MIN_AGE_MS > 0 && nowMs - entry.lastTouchMs < RECLAIM_MIN_AGE_MS) continue;
      // TN-storm fix: never park an LB whose guarded bake is still in
      // flight (its completion track() would land next to the pool copy —
      // see _hasInFlightBake). It ages into a victim a tick or two later.
      if (this.warmParkEnabled && this._hasInFlightBake(key)) {
        this._reclaimDeferredInFlight += 1;
        continue;
      }
      candidates.push({ key, ts: entry.lastTouchMs });
    }
    candidates.sort((a, b) => a.ts - b.ts);

    // Victims = the count overage (oldest first) PLUS, when live geometry is
    // over MAX_LIVE_GEOM, up to GEOM_PRESSURE_PARK_PER_TICK extra oldest LBs to
    // feed the pool (#7/#10). One bucketed group scan for the whole tick (#6)
    // instead of a full 4-group rescan per victim.
    const victims = [];
    let toEvict = Math.max(0, this.entries.size - this.maxResident);
    for (const c of candidates) {
      if (toEvict <= 0) break;
      victims.push(c.key);
      toEvict -= 1;
    }
    if (overGeom) {
      let extra = GEOM_PRESSURE_PARK_PER_TICK;
      for (const c of candidates) {
        if (extra <= 0) break;
        if (victims.includes(c.key)) continue;
        victims.push(c.key);
        this._geomPressureParks += 1;
        extra -= 1;
      }
    }
    const buckets = victims.length > 1 ? this._bucketGroupChildren(victims) : null;
    for (const key of victims) this._reclaim(key, buckets);
    this._tickParkPoolPressure(currentLbKey);
  }

  // Phase 9a: one reclaim = park (warm) or evict (classic), by flag.
  _reclaim(lbKey, buckets = null) {
    if (this.warmParkEnabled) return this.park(lbKey, buckets);
    return this.evict(lbKey, buckets);
  }

  // Phase 9a pool-pressure pass: true-dispose parked LBs until the pool fits
  // the byte budget — farthest-from-player first, oldest breaking ties,
  // amortized to ≤ WARM_PARK_MAX_DISPOSE_PER_TICK per tick (retail §1.3
  // style: bounded eviction work per frame).
  //
  // S15a park→DBOCache UseTime floor (PLAN §2/§5): a parked slot younger than
  // PARK_USE_TIME_MS since its parkedAtMs is NOT eligible for pressure
  // disposal — release ≠ free within the floor window (retail's DBOCache
  // freelist floor). The byte LRU stays the backstop BEHIND the floor: we
  // dispose only entries older than the floor; if the budget is still exceeded
  // once every eligible entry is gone, we DO NOT violate the floor — the
  // overage is recorded (_useTimeDeferred*) and the young entries age into
  // eligibility on later ticks. `?parkUseTimeMs=0` sets the floor to 0 → the
  // young-skip below is never taken → byte-identical to the pre-S15 path.
  _tickParkPoolPressure(refLbKey) {
    if (this.parkPool.size === 0) return;
    // Fire when EITHER the byte backstop OR the live-geometry governor is
    // exceeded. Re-evaluated each iteration so we stop the instant enough
    // parked LBs have been disposed to bring live geometry back under cap.
    const overBudget = () =>
      this.parkedBytes > this.parkBudgetBytes || this._liveGeometries() > MAX_LIVE_GEOM;
    if (!overBudget()) return;
    const ref = refLbKey != null ? lbKeyOf(refLbKey >>> 0) : null;
    const nowMs = (typeof performance !== "undefined") ? performance.now() : Date.now();
    // The live-geometry governor is a HARD resource ceiling: when we're over it,
    // the DBOCache UseTime floor (a re-adoptability nicety) MUST yield — during a
    // continuous run every parked LB is "young", so an honored floor defers them
    // all and the pool can never free geometry (measured: 72 parked, 3 disposed,
    // liveGeom stuck 2.7× over cap). Byte-only pressure still honors the floor;
    // only a genuine geometry-ceiling breach bypasses it (normal play, under the
    // high default cap, never engages this).
    const overGeomAtEntry = this._liveGeometries() > MAX_LIVE_GEOM;
    const floorMs = overGeomAtEntry ? 0 : PARK_USE_TIME_MS;
    const order = [...this.parkPool.entries()].sort((a, b) => {
      if (ref != null) {
        const d = lbChebyshev(ref, b[0]) - lbChebyshev(ref, a[0]);
        if (d !== 0) return d;
      }
      return a[1].parkedAtMs - b[1].parkedAtMs;
    });
    // #8 — time-budget the dispose rate (min 1/tick) so a heavy inflow can't
    // outrun the flat 2/tick and clump into a multi-second stall.
    const useTimeBudget = PARK_DISPOSE_BUDGET_MS > 0;
    const nowPerf = () => (typeof performance !== "undefined") ? performance.now() : Date.now();
    const t0 = nowPerf();
    let disposed = 0;
    for (const [key, p] of order) {
      if (!overBudget()) break;
      if (useTimeBudget) {
        if (disposed >= 1 && (nowPerf() - t0) > PARK_DISPOSE_BUDGET_MS) break;
      } else if (disposed >= WARM_PARK_MAX_DISPOSE_PER_TICK) {
        break;
      }
      // UseTime floor: keep a recently-parked slot re-adoptable (unpark =
      // zero decode). Record the deferral and move on — a later tick reclaims
      // it once it ages past the floor. floorMs === 0 disables the gate.
      if (floorMs > 0 && (nowMs - p.parkedAtMs) < floorMs) {
        this._useTimeDeferredCount += 1;
        this._useTimeDeferredBytes += p.bytes || 0;
        continue;
      }
      this.disposeParked(key);
      disposed += 1;
    }
  }

  // O5 (A11, net-fixwave P5 2026-07-10): ONE pass over the four scene
  // groups bucketing children by owning lb-key. A multi-victim sealed
  // drain tick previously rescanned every group per victim — K victims ×
  // 4 O(total-children) walks. The buckets feed `evict(key, buckets)`,
  // which then removes exactly the same nodes in exactly the same
  // per-victim order (dispose-order semantics unchanged). Children with
  // no owning-LB tag (cross-LB InstancedMesh, registry-owned billboards)
  // are skipped here exactly as the per-victim scans skipped them.
  _bucketGroupChildren(victimKeys) {
    const want = victimKeys instanceof Set ? victimKeys : new Set(victimKeys);
    const buckets = new Map();
    const bucketFor = (key) => {
      let b = buckets.get(key);
      if (!b) {
        b = { terrain: [], buildings: [], statics: [], cells: [] };
        buckets.set(key, b);
      }
      return b;
    };
    const s = this.scene3d;
    if (s.terrainGroup?.children) {
      for (const c of s.terrainGroup.children) {
        const ud = c.userData;
        if (!ud || ud.lbX == null || ud.lbY == null) continue;
        const key = lbKeyFromXY(ud.lbX, ud.lbY);
        if (want.has(key)) bucketFor(key).terrain.push(c);
      }
    }
    if (s.buildingsGroup?.children) {
      for (const c of s.buildingsGroup.children) {
        const lb = c.userData?.landblockId;
        if (lb == null) continue;
        const key = lbKeyOf(lb >>> 0);
        if (want.has(key)) bucketFor(key).buildings.push(c);
      }
    }
    if (s.staticsGroup?.children) {
      for (const c of s.staticsGroup.children) {
        const lb = c.userData?.landblockId;
        if (lb == null) continue;
        const key = lbKeyOf(lb >>> 0);
        if (want.has(key)) bucketFor(key).statics.push(c);
      }
    }
    if (s.cellContainers3d instanceof Map) {
      for (const [cellId, container] of s.cellContainers3d) {
        const key = lbKeyOf(cellId >>> 0);
        if (want.has(key)) bucketFor(key).cells.push([cellId, container]);
      }
    }
    return buckets;
  }

  // Remove the LB's containers from the scene + dispose the per-LB
  // resources we own. Cross-LB shares (MaterialCache surfaces, statics
  // InstancedMesh, terrain atlas / road texture) are NEVER touched.
  // `_buckets` (optional, O5): a `_bucketGroupChildren` result — when
  // provided, steps 1–4 read this LB's pre-bucketed children instead of
  // rescanning the groups (same nodes, same order; a missing bucket means
  // the LB simply had no tagged children this tick).
  evict(lbKeyArg, _buckets = null) {
    const lbKey = lbKeyOf(lbKeyArg >>> 0);
    const entry = this.entries.get(lbKey);
    if (!entry) return false;

    const s = this.scene3d;
    const lbX = (lbKey >>> 24) & 0xff;
    const lbY = (lbKey >>> 16) & 0xff;
    const bucket = _buckets
      ? _buckets.get(lbKey) || { terrain: [], buildings: [], statics: [], cells: [] }
      : null;

    // 1. Terrain — every child of terrainGroup whose userData.lbX/lbY
    //    matches. Wire-fill companion meshes (userData.lbX/lbY also
    //    set) are caught by the same filter.
    if (bucket) {
      for (const c of bucket.terrain) s.terrainGroup?.remove(c);
    } else if (s.terrainGroup?.children) {
      const kill = [];
      for (const c of s.terrainGroup.children) {
        const ud = c.userData;
        if (!ud) continue;
        if (ud.lbX === lbX && ud.lbY === lbY) kill.push(c);
      }
      for (const c of kill) s.terrainGroup.remove(c);
    }

    // 2. Buildings — per-placement Groups with userData.landblockId
    //    (full 32-bit; mask to lb-key). Each Group's child Meshes
    //    reference cached materials/geometries — DO NOT dispose those.
    if (bucket || s.buildingsGroup?.children) {
      const kill = [];
      if (bucket) {
        kill.push(...bucket.buildings);
        for (const c of kill) s.buildingsGroup?.remove(c);
      } else {
        for (const c of s.buildingsGroup.children) {
          const lb = c.userData?.landblockId;
          if (lb == null) continue;
          if (lbKeyOf(lb >>> 0) === lbKey) kill.push(c);
        }
        for (const c of kill) s.buildingsGroup.remove(c);
      }
      if (s.buildingMap3d instanceof Map) {
        for (const c of kill) {
          const k = c.userData?.placementKey;
          if (k) s.buildingMap3d.delete(k);
        }
      }
    }

    // 3. Statics — singletons (Mesh / LOD) AND per-LB BatchedMesh consolidations
    //    (?staticBatch) carry userData.landblockId. InstancedMesh nodes have NO
    //    landblockId (they batch across all LBs in the ring) and are skipped.
    if (bucket || s.staticsGroup?.children) {
      const kill = [];
      if (bucket) {
        kill.push(...bucket.statics);
      } else {
        for (const c of s.staticsGroup.children) {
          const lb = c.userData?.landblockId;
          if (lb == null) continue;
          if (lbKeyOf(lb >>> 0) === lbKey) kill.push(c);
        }
      }
      for (const c of kill) {
        s.staticsGroup?.remove(c);
        // A per-LB BatchedMesh owns a GPU vertex buffer + per-instance
        // DataTextures that the geometry-disposables list does NOT cover (its
        // source group geoms are tracked separately). Dispose it here so
        // ?staticBatch consolidations don't leak GPU memory on eviction.
        //
        // isInstancedMesh (2026-07-15, ?walkInInstance): a walk-in InstancedMesh
        // is per-LB, so it arrives here carrying userData.landblockId — unlike
        // the RING baker's instanced nodes, which span LBs, carry no
        // landblockId, and are refcount-evicted via coversLbKeys (they never
        // reach this loop; the comment above still describes them correctly).
        // Its instanceMatrix is an InstancedBufferAttribute holding a GPU
        // buffer that the geometry-disposables list does not cover either, so
        // it needs the same explicit dispose. Traverse: an LOD-wrapped node is
        // a Group whose LEAVES are the InstancedMeshes.
        c.traverse((n) => {
          if ((n.isBatchedMesh || n.isInstancedMesh) && typeof n.dispose === "function") {
            try { n.dispose(); } catch (_) { /* fail-soft */ }
          }
        });
      }
    }

    // 4. EnvCells — cellContainers3d is keyed by full cellId. Remove
    //    every container whose cellId & 0xffff_0000 === lbKey.
    if (s.cellContainers3d instanceof Map && s.cellsGroup) {
      if (bucket) {
        for (const [cellId, container] of bucket.cells) {
          s.cellsGroup.remove(container);
          s.cellContainers3d.delete(cellId);
        }
      } else {
        const killIds = [];
        for (const [cellId, container] of s.cellContainers3d) {
          if (lbKeyOf(cellId >>> 0) === lbKey) {
            killIds.push(cellId);
            s.cellsGroup.remove(container);
          }
        }
        for (const id of killIds) s.cellContainers3d.delete(id);
      }
    }

    // NOTE: world ENTITIES (EntityManager objects — players/creatures/items)
    // are deliberately NOT culled here. The LRU owns render resources; the
    // entity set is server-authoritative. Client-side culling on LB eviction
    // races ACE's per-player ObjMaint grace (~25s): a player who portals out
    // of and back into a landblock within that window (e.g. a PvP dungeon
    // chase — a dungeon EnvCell can sit 35 LBs away) would have its opponents
    // culled here while ACE still considers them visible (ACE won't re-send
    // within the grace) → invisible players. In-session entity cleanup is
    // instead done GRACE-AWARE by `EntityManager.reapStaleEntities()` (culls
    // only after an LB has been out of PVS longer than ACE's 25s grace; driven
    // from the per-frame LRU tick in index.js). Session-end cleanup is
    // `EntityManager.clearWorldEntities()` (disconnect handler), and ACE
    // ObjectDelete (0xF747) is handled by the normal remove path.

    // 5b. C3 #6 — release per-LB SetupModel lights SYNCHRONOUSLY before
    //    the geom/mat/tex loops (and before `entries.delete`) so the
    //    next frame's `capActiveLightsByDistance` never sorts/sees a
    //    stale, detached light. This INLINES lighting.js#releaseLight
    //    (splice scene3d.activeLights → detach from parent → dispose)
    //    to keep landblock_lru a ZERO-IMPORT leaf (no cycle with
    //    lighting.js, which imports lbKeyOf from here). Fail-soft.
    const tracked = entry.disposables.lights;
    if (Array.isArray(tracked) && tracked.length > 0) {
      const activeLights = s.activeLights;
      for (const light of tracked) {
        if (!light) continue;
        try {
          if (Array.isArray(activeLights)) {
            const idx = activeLights.indexOf(light);
            if (idx !== -1) activeLights.splice(idx, 1);
          }
        } catch (_) {}
        try {
          if (light.parent && typeof light.parent.remove === "function") {
            light.parent.remove(light);
          } else if (typeof light.removeFromParent === "function") {
            light.removeFromParent();
          }
        } catch (_) {}
        try {
          if (typeof light.dispose === "function") light.dispose();
        } catch (_) {}
      }
    }

    // 5. Dispose per-LB owned resources. Skip anything tagged
    //    `__cacheOwned` (shared MaterialCache surfaces) defensively
    //    even though track() callers shouldn't be passing those in.
    for (const g of entry.disposables.geometries) {
      if (!g) continue;
      // A11-F3 (landed with Phase 9a): honor the __cacheOwned tag on
      // geometries too — the comment above always claimed it, and park
      // widens the population flowing through this loop.
      if (g.userData?.__cacheOwned === true) continue;
      try { g.dispose && g.dispose(); } catch (_) {}
    }
    for (const m of entry.disposables.materials) {
      if (!m) continue;
      if (m.userData?.__cacheOwned === true) continue;
      try { m.dispose && m.dispose(); } catch (_) {}
    }
    for (const t of entry.disposables.textures) {
      if (!t) continue;
      if (t.userData?.__cacheOwned === true) continue;
      try { t.dispose && t.dispose(); } catch (_) {}
    }

    // 5c. C3 #7 — refcount the cross-LB statics InstancedMesh / LOD nodes.
    //    Each node batches placements from EVERY LB in the bake ring into
    //    one draw call, so it must NOT be removed/disposed until the LAST
    //    covered LB evicts. Each node carries `userData.coversLbKeys`
    //    (a Set of lb-keys it covers). On eviction: drop THIS lbKey from
    //    that Set; if the Set is now empty the node is no longer needed —
    //    remove it from staticsGroup and dispose its GEOMETRY ONLY (the
    //    material is `__cacheOwned`, shared cross-LB via MaterialCache —
    //    NEVER dispose it). Otherwise the node stays live for the LBs it
    //    still covers, and this LB must be re-marked statics-baked AFTER
    //    step 6's `staticsBakedLbs.delete` (see below) so a re-walk into
    //    it doesn't re-bake duplicate singletons on top of the surviving
    //    InstancedMesh. Fail-soft per node. LOD-wrapped nodes carry the
    //    coversLbKeys on the LOD wrapper; geometry disposal walks both
    //    LOD levels' instanced leaves.
    let keptInstancedForThisLb = false;
    const trackedNodes = entry.disposables.instancedNodes;
    if (Array.isArray(trackedNodes) && trackedNodes.length > 0) {
      for (const node of trackedNodes) {
        if (!node) continue;
        try {
          const covers = node.userData?.coversLbKeys;
          if (covers instanceof Set) {
            covers.delete(lbKey);
            if (covers.size > 0) {
              keptInstancedForThisLb = true;
              continue;
            }
          }
          // No remaining covered LBs (or no Set at all → treat as a
          // single-LB node) — remove + dispose geometry only.
          if (s.staticsGroup && typeof s.staticsGroup.remove === "function") {
            s.staticsGroup.remove(node);
          } else if (typeof node.removeFromParent === "function") {
            node.removeFromParent();
          }
          // Dispose every InstancedMesh leaf's geometry. Plain
          // InstancedMesh exposes `.geometry`; a THREE.LOD wrapper exposes
          // `.levels[i].object.geometry`. Materials are skipped entirely.
          if (Array.isArray(node.levels)) {
            for (const lvl of node.levels) {
              const g = lvl?.object?.geometry;
              try { g?.dispose && g.dispose(); } catch (_) {}
            }
          } else if (node.geometry) {
            try { node.geometry.dispose && node.geometry.dispose(); } catch (_) {}
          }
        } catch (_) { /* fail-soft per node */ }
      }
    }

    // 6. Clear idempotency sets so a re-entry actually re-bakes.
    //    Without this, the lazy hooks would short-circuit and leave
    //    the LB visually empty until a hard reload.
    if (s.terrainBakedLbs instanceof Set) s.terrainBakedLbs.delete(lbKey);
    if (s.buildingsBakedLbs instanceof Set) s.buildingsBakedLbs.delete(lbKey);
    if (s.staticsBakedLbs instanceof Set) s.staticsBakedLbs.delete(lbKey);
    if (s.envCellLoadedLbs instanceof Set) s.envCellLoadedLbs.delete(lbKey);
    // geom-audit (2026-07-02): also cancel any IN-FLIGHT envcell build for
    // this LB — buildEnvCellsForLandblock's attach guard reads the gen
    // token (the loaded mark now lands only on success, so it can't carry
    // the eviction signal any more). Deleting the gen entry mismatches
    // every in-flight build's token; deleting the marker lets a fresh
    // re-approach start a new build immediately.
    if (s.envCellBuildInFlight instanceof Set) s.envCellBuildInFlight.delete(lbKey);
    if (s.envCellBuildGen instanceof Map) s.envCellBuildGen.delete(lbKey);
    // Spawns idempotency lives in scene3d/spawns.js (its own module-local
    // Set, not on scene3d). It installs `_evictSpawnsInjectedLb` onto
    // scene3d so we can clear its per-LB mark without an import — letting a
    // re-walk into this LB re-inject its NPCs/spawns. Guard with typeof.
    if (typeof s._evictSpawnsInjectedLb === "function") {
      try { s._evictSpawnsInjectedLb(lbKey); } catch (_) { /* fail-soft */ }
    }
    // Phase 3 — tear down this LB's SYNTHESIZED particle emitters (owner key
    // `static:<lbKey>`). statics.js installs this hook when its particle manager
    // is first created (mirrors `_evictSpawnsInjectedLb`); absent ⇒ no static
    // particle manager was ever built ⇒ nothing to tear down. Persistent
    // (totalSeconds:0) gemSparkle/brazier emitters never auto-finish and the RP6
    // 220m cull only stops DRAWING them, so eviction MUST destroy them or they
    // leak in the manager table for the rest of the session. Fail-soft; the
    // facade no-ops for an LB that placed no particles (empty-owner fast path).
    if (typeof s._evictStaticParticlesForLb === "function") {
      try { s._evictStaticParticlesForLb(lbKey); } catch (_) { /* fail-soft */ }
    }
    // ?statAtlas (default-ON; ?statAtlas=off escapes) — excise this LB's geometry from
    // the cross-LB size-bucket BatchedMeshes (per-instance deleteGeometry; same-frame, no
    // rebuild, no orphan). Hook is wired onto liveScene3d at LRU construction (index.js)
    // and re-installed by each feed; absent ⇒ ?statAtlas=off ⇒ nothing to excise.
    // Fail-soft. Mirrors the _evictStaticParticlesForLb facade above.
    if (typeof s._evictStaticAtlasForLb === "function") {
      try { s._evictStaticAtlasForLb(lbKey); } catch (_) { /* fail-soft */ }
    }
    // ?statBatchCrossLb (default-OFF) — excise this LB's geometry from the cross-LB
    // per-material ?staticBatch BatchedMeshes (per-gid deleteGeometry; same-frame,
    // instances cascade, other LBs' gids untouched). Hook wired at LRU construction
    // (index.js) and re-installed by each feed; a no-op for an LB that never fed
    // (flag off ⇒ nothing was ever fed). Mirrors the _evictStaticAtlasForLb facade.
    if (typeof s._evictStaticBatchXForLb === "function") {
      try { s._evictStaticBatchXForLb(lbKey); } catch (_) { /* fail-soft */ }
    }
    // ?terrainBatch (default-ON) — excise this LB's terrain geometry from the
    // cross-LB terrain BatchedMesh (per-instance deleteGeometry; same-frame, no
    // rebuild). The hidden per-LB proxy mesh was already removed by the terrain
    // scan in step 1; this drops the batch copy. Covers a parked LB too
    // (disposeParked re-enters the pool copy and runs this evict), which is
    // where a hidden row's slot is finally returned. Hook installed by
    // terrain_batch.js on first absorb; absent ⇒ flag off ⇒ no-op. Mirrors the
    // _evictStaticAtlasForLb facade above.
    if (typeof s._evictTerrainBatchForLb === "function") {
      try { s._evictTerrainBatchForLb(lbKey); } catch (_) { /* fail-soft */ }
    }

    // 6b. C3 #7 — if a cross-LB InstancedMesh node survived step 5c (it
    //    still covers other resident LBs), this LB's statics are STILL on
    //    screen via that shared node. Re-mark it statics-baked (undoing
    //    the unconditional delete above) so a re-walk into this LB takes
    //    the idempotent short-circuit instead of re-baking duplicate
    //    singleton meshes layered on top of the live InstancedMesh
    //    (z-fight + double-draw). Only the singleton statics-baked LBs
    //    (no surviving node) stay unmarked and correctly re-bake on
    //    re-entry.
    if (keptInstancedForThisLb && s.staticsBakedLbs instanceof Set) {
      s.staticsBakedLbs.add(lbKey);
    }

    // 7. Also drop the per-LB ShaderMaterial entry off scene3d's
    //    terrainMaterials registry (the per-rAF uTime push iterates
    //    this; a stale dispose'd entry would still receive a push
    //    until the next bake replaces it).
    if (Array.isArray(s.terrainMaterials) && entry.disposables.materials.length > 0) {
      const dropped = new Set(entry.disposables.materials);
      s.terrainMaterials = s.terrainMaterials.filter((m) => !dropped.has(m));
    }

    // Phase 6 collision-leak fix (2026-05-29): the THREE.js render objects are
    // gone, but the wasm SpatialScene's per-LB collision (cell + building
    // AABBs + physics triangles + portal graph + building origins) must be
    // purged too — `insert_cell_triangle` / `insert_building_aabb` are
    // append-only, so without this a later re-entry re-bake APPENDS duplicates
    // and the indices grow unbounded on every LB re-load.
    if (this._onEvictLandblock) {
      try { this._onEvictLandblock(lbKey); } catch (_) { /* fail-soft */ }
    }

    this.entries.delete(lbKey);
    this._evictedTotal += 1;
    this._lastEvictedLbKey = lbKey;

    if (this.debug) {
      // eslint-disable-next-line no-console
      console.log(
        `[lbLru/evict] id=0x${lbKey.toString(16).padStart(8, "0")} ` +
        `resident=${this.entries.size} totalEvicted=${this._evictedTotal}`
      );
    }
    // Wave 3 / A6 instrumentation (2026-05-28) — investigation-first for
    // the R2 hypothesis (Three.js internal program cache may retain
    // compiled programs of disposed materials). Records a snapshot of
    // renderer.info.{programs,memory.{geometries,textures}} keyed by
    // the just-evicted LB so operators can trend program count vs
    // eviction count over a long traversal session. Ring-buffered to
    // 200 entries; lazy-initialised on first call so the namespace
    // doesn't exist until something has been evicted.
    this._recordProgramSnapshot(lbKey);
    return true;
  }

  // ── Phase 9a warm-park (W4 §3) ────────────────────────────────────────────

  // Byte estimate for a ParkedLb: geometry attribute arrays (deduped by
  // uuid) across every stashed subtree + tracked DataTexture payloads. This
  // counts CPU *and* GPU residency — detached three.js objects keep their GL
  // buffers until dispose(), so the pool budget is a VRAM budget too.
  _estimateParkedBytes(p) {
    let bytes = 0;
    const seenGeom = new Set();
    const addGeom = (g) => {
      if (!g || seenGeom.has(g.uuid)) return;
      seenGeom.add(g.uuid);
      try {
        for (const name of Object.keys(g.attributes || {})) {
          bytes += g.attributes[name]?.array?.byteLength || 0;
        }
        bytes += g.index?.array?.byteLength || 0;
      } catch (_) {}
    };
    const walk = (root) => {
      try {
        root.traverse((o) => {
          if (o.geometry) addGeom(o.geometry);
          if (Array.isArray(o.levels)) {
            for (const lvl of o.levels) if (lvl?.object?.geometry) addGeom(lvl.object.geometry);
          }
        });
      } catch (_) {}
    };
    for (const c of p.terrain) walk(c);
    for (const c of p.buildings) walk(c);
    for (const c of p.statics) walk(c);
    for (const [, container] of p.cells) walk(container);
    for (const g of p.disposables?.geometries || []) addGeom(g);
    for (const t of p.disposables?.textures || []) {
      try { bytes += t?.image?.data?.byteLength || 0; } catch (_) {}
    }
    return bytes;
  }

  // Park an LB: detach its containers from the scene groups (evict steps
  // ①–④ minus every dispose), stash the refs in the pool, KEEP the baked
  // marks / spawns idempotency / wasm collision. Re-entry re-attaches via
  // unpark() (the loaders' baked-mark fast-path is the seam). Per-frame
  // tickers that can't be frozen (static script emitters) are destroyed and
  // rebuilt on unpark from the stashed anchors.
  park(lbKeyArg, _buckets = null) {
    const lbKey = lbKeyOf(lbKeyArg >>> 0);
    const entry = this.entries.get(lbKey);
    if (!entry) return false;
    if (this.parkPool.has(lbKey)) {
      // Shouldn't happen (an LB lives in `entries` XOR `parkPool`; the
      // session-7 TN-storm fix enforces it at both ends — in-flight-bake
      // victims are deferred and a late track() merges into the pool copy).
      // Last-resort resolution: true-dispose the stale pool copy first,
      // then park fresh.
      this.disposeParked(lbKey);
    }

    const s = this.scene3d;
    const lbX = (lbKey >>> 24) & 0xff;
    const lbY = (lbKey >>> 16) & 0xff;
    const bucket = _buckets
      ? _buckets.get(lbKey) || { terrain: [], buildings: [], statics: [], cells: [] }
      : null;

    const p = {
      parkedAtMs: (typeof performance !== "undefined") ? performance.now() : Date.now(),
      bytes: 0,
      terrain: [],
      buildings: [],
      statics: [],
      cells: [],
      detachedLights: [], // [light, parent] for lights parented OUTSIDE the stashed subtrees
      parkedTerrainMats: [],
      disposables: entry.disposables,
    };

    // ① terrain (incl. wire-fill companions — same lbX/lbY tag).
    if (bucket) {
      p.terrain = [...bucket.terrain];
    } else if (s.terrainGroup?.children) {
      for (const c of s.terrainGroup.children) {
        const ud = c.userData;
        if (ud && ud.lbX === lbX && ud.lbY === lbY) p.terrain.push(c);
      }
    }
    for (const c of p.terrain) { try { s.terrainGroup?.remove(c); } catch (_) {} }
    // ?terrainBatch (default-ON) — detaching the proxies is NOT enough: an
    // absorbed LB renders from the cross-LB BatchedMesh, and its proxy is a
    // hidden data-carrier. Without this the parked LB kept painting from the
    // batch (a ghost) AND kept its DataArrayTexture slot, so a long tour
    // exhausted all 256 slots with landblocks the player left minutes ago
    // (measured 2026-07-28: resident 32, parked 347, slotsUsed 256, ghosts
    // 256) and every LB baked after that fell back to a per-LB draw — which
    // park DOES detach, so terrain started flickering with the park↔unpark
    // churn. The hook HIDES the row (keeps the slot, reclaimable under
    // pressure); unpark below un-hides or re-absorbs it. Absent ⇒ flag off.
    if (typeof s._parkTerrainBatchForLb === "function") {
      try { s._parkTerrainBatchForLb(lbKey); } catch (_) { /* fail-soft */ }
    }

    // ② buildings (+ buildingMap3d bookkeeping, restored on unpark).
    if (bucket) {
      p.buildings = [...bucket.buildings];
    } else if (s.buildingsGroup?.children) {
      for (const c of s.buildingsGroup.children) {
        const lb = c.userData?.landblockId;
        if (lb != null && lbKeyOf(lb >>> 0) === lbKey) p.buildings.push(c);
      }
    }
    for (const c of p.buildings) {
      try { s.buildingsGroup?.remove(c); } catch (_) {}
      const k = c.userData?.placementKey;
      if (k && s.buildingMap3d instanceof Map) s.buildingMap3d.delete(k);
    }

    // ③ statics — singletons, ?staticBatch BatchedMesh consolidations AND
    //   the static-script anchors (all carry userData.landblockId). NOTHING
    //   is disposed; the BatchedMesh keeps its GPU buffers (that's the point).
    if (bucket) {
      p.statics = [...bucket.statics];
    } else if (s.staticsGroup?.children) {
      for (const c of s.staticsGroup.children) {
        const lb = c.userData?.landblockId;
        if (lb != null && lbKeyOf(lb >>> 0) === lbKey) p.statics.push(c);
      }
    }
    for (const c of p.statics) { try { s.staticsGroup?.remove(c); } catch (_) {} }

    // ④ EnvCells.
    if (s.cellContainers3d instanceof Map && s.cellsGroup) {
      if (bucket) {
        p.cells = [...bucket.cells];
      } else {
        for (const [cellId, container] of s.cellContainers3d) {
          if (lbKeyOf(cellId >>> 0) === lbKey) p.cells.push([cellId, container]);
        }
      }
      for (const [cellId, container] of p.cells) {
        try { s.cellsGroup.remove(container); } catch (_) {}
        s.cellContainers3d.delete(cellId);
      }
    }
    // Cancel any in-flight envcell build exactly like evict does — a build
    // resolving after park would attach cells the pool also holds.
    if (s.envCellBuildInFlight instanceof Set) s.envCellBuildInFlight.delete(lbKey);
    if (s.envCellBuildGen instanceof Map) s.envCellBuildGen.delete(lbKey);

    // ⑤b lights: splice from activeLights (the capper must not sort parked
    // lights) but do NOT dispose. A light parented inside a stashed subtree
    // rides along; one parented elsewhere is detached and remembered.
    const stashRoots = new Set([...p.terrain, ...p.buildings, ...p.statics]);
    for (const [, container] of p.cells) stashRoots.add(container);
    const insideStash = (obj) => {
      for (let o = obj; o; o = o.parent) if (stashRoots.has(o)) return true;
      return false;
    };
    const tracked = entry.disposables.lights;
    if (Array.isArray(tracked)) {
      for (const light of tracked) {
        if (!light) continue;
        try {
          const idx = Array.isArray(s.activeLights) ? s.activeLights.indexOf(light) : -1;
          if (idx !== -1) s.activeLights.splice(idx, 1);
        } catch (_) {}
        try {
          if (light.parent && !insideStash(light)) {
            p.detachedLights.push([light, light.parent]);
            light.parent.remove(light);
          }
        } catch (_) {}
      }
    }

    // ⑦ terrainMaterials registry: parked ShaderMaterials must not receive
    // the per-rAF uTime push; remember exactly which ones we filtered.
    if (Array.isArray(s.terrainMaterials) && entry.disposables.materials.length > 0) {
      const mine = new Set(entry.disposables.materials);
      p.parkedTerrainMats = s.terrainMaterials.filter((m) => mine.has(m));
      if (p.parkedTerrainMats.length > 0) {
        s.terrainMaterials = s.terrainMaterials.filter((m) => !mine.has(m));
      }
    }

    // Static script emitters tick per frame — destroy now (same as evict),
    // rebuild on unpark from the stashed anchors (they carry
    // defaultScriptId + particleOwnerKey + landblockId in userData).
    if (typeof s._evictStaticParticlesForLb === "function") {
      try { s._evictStaticParticlesForLb(lbKey); } catch (_) {}
    }
    // ?statAtlas members: hide, keep membership (nothing deleted → the
    // optimize() compactor is untouched). Facade installed by index.js.
    if (typeof s._parkStaticAtlasForLb === "function") {
      try { s._parkStaticAtlasForLb(lbKey); } catch (_) {}
    }

    // KEPT deliberately (the whole point of park): baked marks (step ⑥),
    // spawns idempotency, wasm collision (`_onEvictLandblock` NOT fired).

    p.bytes = this._estimateParkedBytes(p);
    this.entries.delete(lbKey);
    this.parkPool.set(lbKey, p);
    this.parkedBytes += p.bytes;
    this._parkedTotal += 1;
    if (this.debug) {
      // eslint-disable-next-line no-console
      console.log(
        `[lbLru/park] id=0x${lbKey.toString(16).padStart(8, "0")} ` +
        `bytes=${p.bytes} pool=${this.parkPool.size} poolBytes=${this.parkedBytes}`
      );
    }
    return true;
  }

  // Re-attach a parked LB. The baked marks never cleared, so the loaders'
  // fast-path (which calls this) short-circuits the re-bake; this is a pure
  // re-attach — no decode, no geometry build, no wasm collision insert.
  unpark(lbKeyArg) {
    const lbKey = lbKeyOf(lbKeyArg >>> 0);
    const p = this.parkPool.get(lbKey);
    if (!p) return false;
    const s = this.scene3d;

    for (const c of p.terrain) { try { s.terrainGroup?.add(c); } catch (_) {} }
    // ?terrainBatch — mirror of the park hook: un-hide the LB's batch row, or
    // re-absorb it from the stashed proxy if its slot was reclaimed while
    // parked, or fall back to a visible per-LB draw. Passing the stash lets
    // the re-absorb read the still-live geometry + DataTextures (park disposes
    // nothing). Absent ⇒ flag off ⇒ the proxies re-attach exactly as before.
    if (typeof s._unparkTerrainBatchForLb === "function") {
      try { s._unparkTerrainBatchForLb(lbKey, p.terrain); } catch (_) { /* fail-soft */ }
    }
    for (const c of p.buildings) {
      try { s.buildingsGroup?.add(c); } catch (_) {}
      const k = c.userData?.placementKey;
      if (k && s.buildingMap3d instanceof Map) s.buildingMap3d.set(k, c);
    }
    for (const c of p.statics) { try { s.staticsGroup?.add(c); } catch (_) {} }
    if (s.cellContainers3d instanceof Map && s.cellsGroup) {
      for (const [cellId, container] of p.cells) {
        try { s.cellsGroup.add(container); } catch (_) {}
        s.cellContainers3d.set(cellId, container);
      }
    }
    for (const [light, parent] of p.detachedLights) {
      try { parent.add(light); } catch (_) {}
    }
    // Re-register the LB's lights with the capper.
    const lights = p.disposables?.lights;
    if (Array.isArray(lights) && Array.isArray(s.activeLights)) {
      for (const light of lights) {
        if (light && !s.activeLights.includes(light)) s.activeLights.push(light);
      }
    }
    if (p.parkedTerrainMats.length > 0 && Array.isArray(s.terrainMaterials)) {
      for (const m of p.parkedTerrainMats) {
        if (!s.terrainMaterials.includes(m)) s.terrainMaterials.push(m);
      }
    }
    if (typeof s._unparkStaticAtlasForLb === "function") {
      try { s._unparkStaticAtlasForLb(lbKey); } catch (_) {}
    }
    // Rebuild the static script emitters from the stashed anchors (statics
    // children AND interior anchors inside cell containers — both stamp
    // userData.isStaticScriptAnchor). Fire-and-forget: the rebuild is
    // time-sliced in statics.js and carries the R-10 residency guard.
    if (typeof s._rebuildStaticParticlesForAnchors === "function") {
      const anchors = [];
      const collect = (root) => {
        try {
          root.traverse((o) => { if (o.userData?.isStaticScriptAnchor) anchors.push(o); });
        } catch (_) {}
      };
      for (const c of p.statics) collect(c);
      for (const [, container] of p.cells) collect(container);
      if (anchors.length > 0) {
        try { s._rebuildStaticParticlesForAnchors(anchors); } catch (_) {}
      }
    }

    this.parkPool.delete(lbKey);
    this.parkedBytes = Math.max(0, this.parkedBytes - p.bytes);
    this._unparkedTotal += 1;
    const now = (typeof performance !== "undefined") ? performance.now() : Date.now();
    this.entries.set(lbKey, { lastTouchMs: now, disposables: p.disposables });
    if (this.debug) {
      // eslint-disable-next-line no-console
      console.log(
        `[lbLru/unpark] id=0x${lbKey.toString(16).padStart(8, "0")} ` +
        `pool=${this.parkPool.size} poolBytes=${this.parkedBytes}`
      );
    }
    return true;
  }

  // True-dispose a parked LB (pool budget pressure / flushParked). Re-enters
  // the pool copy as a normal entry and runs today's evict against it — the
  // scene-group scans find nothing (already detached), and every teardown
  // contract (disposables, 5c refcount, mark clears, facades, wasm collision
  // clear) fires exactly as a classic eviction. Park is strictly an
  // interposed state (W4 §3.2).
  disposeParked(lbKeyArg) {
    const lbKey = lbKeyOf(lbKeyArg >>> 0);
    const p = this.parkPool.get(lbKey);
    if (!p) return false;
    // The stashed ?staticBatch BatchedMesh consolidations are detached, so
    // evict's staticsGroup scan can't dispose them — do it here.
    for (const c of p.statics) {
      if (c?.isBatchedMesh && typeof c.dispose === "function") {
        try { c.dispose(); } catch (_) {}
      }
    }
    // Detached lights outside stash roots were already removed from their
    // parents at park; evict's 5b dispose covers them via disposables.lights.
    this.parkPool.delete(lbKey);
    this.parkedBytes = Math.max(0, this.parkedBytes - p.bytes);
    this.entries.set(lbKey, { lastTouchMs: 0, disposables: p.disposables });
    const ok = this.evict(lbKey);
    // cellContainers3d entries were removed at park; per-LB envcell
    // geometry disposal rode disposables, matching classic evict.
    if (this.debug && ok) {
      // eslint-disable-next-line no-console
      console.log(
        `[lbLru/disposeParked] id=0x${lbKey.toString(16).padStart(8, "0")} ` +
        `pool=${this.parkPool.size} poolBytes=${this.parkedBytes}`
      );
    }
    return ok;
  }

  // WorldBuilder live-rebake analog of retail KeepFreeObjects(false):
  // true-dispose the whole pool (parked state would be stale after a
  // manifest change; sessions are manifest-immutable so this is only for
  // explicit flows).
  flushParked() {
    for (const key of [...this.parkPool.keys()]) this.disposeParked(key);
  }

  /**
   * Snapshot the WebGLRenderer's program cache + memory counters to
   * `window.__diag.renderer.evictionProgramSnapshots` (ring buffer cap
   * 200). Detached from `evict` to keep the hot eviction path readable;
   * any throw inside is swallowed so a diag failure can't kill an LB
   * eviction.
   */
  _recordProgramSnapshot(lbKey) {
    if (typeof window === "undefined") return;
    try {
      const renderer = this.scene3d?.renderer;
      if (!renderer || !renderer.info) return;
      const programCount = Array.isArray(renderer.info.programs)
        ? renderer.info.programs.length
        : 0;
      if (!window.__diag) window.__diag = {};
      if (!window.__diag.renderer) {
        window.__diag.renderer = {
          evictionProgramSnapshots: [],
          maxSnapshots: 200,
          peakPrograms: 0,
          lastPrograms: 0,
        };
      }
      const d = window.__diag.renderer;
      d.lastPrograms = programCount;
      if (programCount > d.peakPrograms) d.peakPrograms = programCount;
      d.evictionProgramSnapshots.push({
        ts: typeof performance !== "undefined" ? performance.now() : Date.now(),
        lbKey: lbKey >>> 0,
        programs: programCount,
        geometries: renderer.info.memory?.geometries ?? 0,
        textures: renderer.info.memory?.textures ?? 0,
        residentLbs: this.entries.size,
        evictionsTotal: this._evictedTotal,
      });
      while (d.evictionProgramSnapshots.length > d.maxSnapshots) {
        d.evictionProgramSnapshots.shift();
      }
    } catch (_) {
      // Never let a diag throw kill an eviction.
    }
  }

  dispose() {
    this.flushParked();
    const keys = [...this.entries.keys()];
    for (const k of keys) this.evict(k);
  }

  getStats() {
    return {
      resident: this.entries.size,
      evicted: this._evictedTotal,
      lastEvictedLbId: this._lastEvictedLbKey,
      maxResident: this.maxResident,
      warmPark: this.warmParkEnabled,
      parked: this.parkPool.size,
      parkedBytes: this.parkedBytes,
      parkBudgetBytes: this.parkBudgetBytes,
      parkedTotal: this._parkedTotal,
      unparkedTotal: this._unparkedTotal,
      // #10 residency governor: the accurate live-geometry counter + its cap,
      // and how many extra resident LBs the geom-pressure feed parked (#7).
      liveGeom: this._liveGeometries(),
      maxLiveGeom: Number.isFinite(MAX_LIVE_GEOM) ? MAX_LIVE_GEOM : null,
      geomPressureParks: this._geomPressureParks,
      parkDisposeBudgetMs: PARK_DISPOSE_BUDGET_MS,
      // park→DBOCache UseTime floor (S15a): the floor value in effect + how
      // much pressure reclaim it deferred (young slots kept re-adoptable).
      parkUseTimeMs: PARK_USE_TIME_MS,
      useTimeDeferredCount: this._useTimeDeferredCount,
      useTimeDeferredBytes: this._useTimeDeferredBytes,
      // Reclaim-center gate + hysteresis telemetry (battery columns).
      ringFloor: this.ringFloor,
      reclaimGate: RECLAIM_GATE_ON,
      reclaimMinAgeMs: RECLAIM_MIN_AGE_MS,
      centerJumps: this._centerJumpsTotal,
      gateHeldTicks: this._gateHeldTicks,
      // TN-storm fix telemetry (session 7): dual-state near-misses.
      trackMergedWhileParked: this._trackMergedWhileParked,
      reclaimDeferredInFlight: this._reclaimDeferredInFlight,
      // PHY-25 dungeon stream gate: outdoor load-point evaluations suppressed
      // because the player was indoors (see noteStreamGateHold). The richer
      // per-effect breakdown lives on `scene3d._dungeonStreamGate`.
      streamGateHolds: this._streamGateHolds,
    };
  }
}

// Helper exported for callers that need the same lb-key shape used
// internally (e.g. the bake site converting (lbX, lbY) → lbKey for
// `track`; lbChebyshev for loop.js's teleport spawn-flush distance test).
export { lbKeyFromXY, lbKeyOf, lbChebyshev, isNearPlayerLb };
