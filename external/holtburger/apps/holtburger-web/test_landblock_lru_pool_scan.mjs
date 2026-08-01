// Park-pool pressure scan cost — the all-young fast path (2026-08-01).
//
// THE BUG. The steady state of a continuous OUTDOOR RUN is: park-pool byte
// budget exceeded, live-geometry governor NOT engaged, every parked slot still
// inside the 30 s DBOCache UseTime floor. In that state `_tickParkPoolPressure`
// disposes nothing — so its `disposed >= 1` precondition never lets the
// PARK_DISPOSE_BUDGET_MS break fire, and it
//   (a) allocates a spread copy of the WHOLE pool,
//   (b) SORTS that copy (farthest-first, two lbChebyshev per comparison), and
//   (c) walks every entry only to defer it,
// on EVERY FRAME. That is per-frame work proportional to the PARKED
// (non-resident) landblock set, which only grows the longer the player runs —
// the exact "per-frame work scales with ever-seen landblocks instead of
// resident ones" class. Measured on a 4000-frame simulated run (30 geoms/LB):
// 564,450 pool entries examined over 3,423 pressure ticks (~165/frame), 99.7%
// of them UseTime deferrals; the sort+scan alone cost 18 µs/frame at pool=127
// and 94 µs/frame at pool=500, plus ~pool × [key,value] pairs of garbage/frame.
//
// THE FIX. The OLDEST parked slot bounds eligibility: if even it is inside the
// floor, nothing can be disposed this tick. One allocation-free min pass
// detects that and returns with the identical end state (the deferral counters
// are bumped for every pooled slot — precisely what the full scan produced,
// because nothing disposed ⇒ overBudget() stayed true ⇒ no early break ⇒ every
// entry deferred). No flag: behaviour-identical, strictly less work.
//
// Run from apps/holtburger-web/:  node test_landblock_lru_pool_scan.mjs

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? (passed += 1) : (failed += 1);
}

// Virtual frame clock so the UseTime floor behaves as it does in a browser.
let VT = 0;
globalThis.performance = { now: () => VT };

let importSeq = 0;
async function loadLru(search) {
  globalThis.window = { location: { search } };
  return import(`./scene3d/landblock_lru.js?ps=${importSeq += 1}`);
}

/** Map that counts `entries()` calls — the sort path's first act is
 *  `[...this.parkPool.entries()]`, so 0 calls proves it was skipped. */
class SpyMap extends Map {
  constructor() { super(); this.entriesCalls = 0; }
  entries() { this.entriesCalls += 1; return super.entries(); }
}

function makeScene(untracked = 0) {
  return {
    terrainBakedLbs: new Set(), buildingsBakedLbs: new Set(),
    staticsBakedLbs: new Set(), envCellLoadedLbs: new Set(),
    terrainMaterials: [], activeLights: [],
    _streamGuardState: { inFlight: new Set() },
    renderer: { info: { memory: { geometries: untracked } } },
    terrainGroup: { children: [], remove() {}, add() {} },
    buildingsGroup: { children: [], remove() {}, add() {} },
    staticsGroup: { children: [], remove() {}, add() {} },
    cellsGroup: { remove() {}, add() {} },
    cellContainers3d: new Map(),
  };
}

const MB = 1024 * 1024;
function fillPool(lru, lbKeyFromXY, n, atMs, bytes = 1.5 * MB) {
  for (let i = 0; i < n; i += 1) {
    const k = lbKeyFromXY(0x40 + (i % 200), 0x40 + Math.floor(i / 200));
    lru.parkPool.set(k, {
      parkedAtMs: atMs, bytes,
      terrain: [], buildings: [], statics: [], cells: [],
      detachedLights: [], parkedTerrainMats: [],
      disposables: { geometries: [], materials: [], textures: [], lights: [], instancedNodes: [] },
    });
    lru.parkedBytes += bytes;
  }
}

console.log("park-pool pressure scan — all-young fast path");

// ── Test 1: over byte budget, every slot young ⇒ NO sort/scan, but the
//    deferral telemetry is byte-identical to the full scan. ────────────────
{
  const mod = await loadLru("?warmPark=on");
  const { LandblockLRU, lbKeyFromXY } = mod;
  const s = makeScene(0);                       // liveGeom 0 ⇒ governor idle
  const centre = lbKeyFromXY(0x40, 0x40);
  const lru = new LandblockLRU({ scene3d: s, maxResident: 8, getCurrentLbId: () => centre });
  const spy = new SpyMap();
  lru.parkPool = spy;
  VT = 1_000_000;                               // arbitrary non-zero frame clock
  const POOL = 300;
  fillPool(lru, lbKeyFromXY, POOL, VT);         // all parked "now"
  const bytes = lru.parkedBytes;
  check("Test1: pool is over the byte budget", bytes > lru.parkBudgetBytes,
    `${(bytes / MB) | 0} MB > ${(lru.parkBudgetBytes / MB) | 0} MB`);

  const TICKS = 120;                            // 120 × 16 ms ≈ 1.9 s ≪ 30 s floor
  for (let i = 0; i < TICKS; i += 1) { VT += 16; lru._tickParkPoolPressure(centre); }

  const st = lru.getStats();
  check("Test1: the pool sort/scan never ran", spy.entriesCalls === 0,
    `entries() calls=${spy.entriesCalls}`);
  check("Test1: nothing was disposed (the floor still holds)",
    st.parked === POOL && st.evicted === 0, `parked=${st.parked} evicted=${st.evicted}`);
  check("Test1: deferral count == pool × ticks (telemetry preserved)",
    st.useTimeDeferredCount === POOL * TICKS, `n=${st.useTimeDeferredCount}`);
  check("Test1: deferred bytes == parkedBytes × ticks (telemetry preserved)",
    st.useTimeDeferredBytes === bytes * TICKS, `n=${st.useTimeDeferredBytes}`);
}

// ── Test 2: the fast path must NOT swallow an eligible slot. One aged-out
//    entry in an otherwise young pool still gets disposed. ─────────────────
{
  const mod = await loadLru("?warmPark=on");
  const { LandblockLRU, lbKeyFromXY } = mod;
  const s = makeScene(0);
  const centre = lbKeyFromXY(0x40, 0x40);
  const lru = new LandblockLRU({ scene3d: s, maxResident: 8, getCurrentLbId: () => centre });
  const spy = new SpyMap();
  lru.parkPool = spy;
  VT = 1_000_000;
  fillPool(lru, lbKeyFromXY, 200, VT);                 // young
  fillPool(lru, lbKeyFromXY, 1, VT - 40_000);          // ONE past the 30 s floor
  // (the second fill reuses key 0x40,0x40 — overwrite is fine, it is the old one)
  const poolBefore = lru.parkPool.size;
  VT += 16;
  lru._tickParkPoolPressure(centre);
  check("Test2: an aged-out slot re-arms the full scan", spy.entriesCalls === 1,
    `entries() calls=${spy.entriesCalls}`);
  check("Test2: the aged-out slot was actually disposed",
    lru.parkPool.size === poolBefore - 1, `pool ${poolBefore} → ${lru.parkPool.size}`);
}

// ── Test 3: the floor never gates the geometry governor. Over MAX_LIVE_GEOM
//    the fast path must not engage (floorMs is 0 there), so an all-young pool
//    still drains. ──────────────────────────────────────────────────────────
{
  const mod = await loadLru("?warmPark=on&maxLiveGeom=10");
  const { LandblockLRU, lbKeyFromXY } = mod;
  const s = makeScene(500);                     // untracked geometry ≫ cap 10
  const centre = lbKeyFromXY(0x40, 0x40);
  const lru = new LandblockLRU({ scene3d: s, maxResident: 8, getCurrentLbId: () => centre });
  const spy = new SpyMap();
  lru.parkPool = spy;
  VT = 1_000_000;
  fillPool(lru, lbKeyFromXY, 50, VT);           // ALL young
  const before = lru.parkPool.size;
  VT += 16;
  lru._tickParkPoolPressure(centre);
  check("Test3: governor breach bypasses the fast path", spy.entriesCalls === 1,
    `entries() calls=${spy.entriesCalls}`);
  check("Test3: young slots still drained under the governor",
    lru.parkPool.size < before, `pool ${before} → ${lru.parkPool.size}`);
  check("Test3: no UseTime deferrals recorded under the governor",
    lru.getStats().useTimeDeferredCount === 0);
}

// ── Test 4: `?parkUseTimeMs=0` (floor disabled) is byte-identical to before —
//    the fast path is floor-gated and must never run there. ────────────────
{
  const mod = await loadLru("?warmPark=on&parkUseTimeMs=0");
  const { LandblockLRU, lbKeyFromXY } = mod;
  const s = makeScene(0);
  const centre = lbKeyFromXY(0x40, 0x40);
  const lru = new LandblockLRU({ scene3d: s, maxResident: 8, getCurrentLbId: () => centre });
  const spy = new SpyMap();
  lru.parkPool = spy;
  VT = 1_000_000;
  fillPool(lru, lbKeyFromXY, 200, VT);          // all young, but no floor
  const before = lru.parkPool.size;
  VT += 16;
  lru._tickParkPoolPressure(centre);
  check("Test4: floor off ⇒ full scan path", spy.entriesCalls === 1,
    `entries() calls=${spy.entriesCalls}`);
  check("Test4: floor off ⇒ young slots dispose immediately",
    lru.parkPool.size < before, `pool ${before} → ${lru.parkPool.size}`);
}

console.log(`\npark-pool pressure scan: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
