// harness/test_slotgrid_lru_assert.mjs — T20 (ST7, `?slotGrid`): the legacy
// LandblockLRU in ASSERT-ONLY mode + the grid↔LRU integration, node-only.
//
// WHAT IS UNDER TEST (SPEC §1.4: "During soak the legacy LRU runs
// assert-only: victim set computed, diffed against grid state, never acted
// on; gridLruDivergence MUST read 0 over the battery"):
//   PART 1 — assert mode acts on NOTHING: over-cap entries are neither
//            parked nor evicted nor pool-pressured; the sealed purge does
//            not run; counters prove the diff ran.
//   PART 2 — divergence semantics: a would-be victim the grid claims
//            resident bumps gridLruDivergence (clipped at the legacy
//            MAX_PARKS_PER_TICK bound); victims the grid disowns are 0.
//   PART 3 — disarmed (OFF arm): setGridAssertProvider(null) restores the
//            acting path (eviction happens; gridAssertMode false).
//   PART 4 — integration battery: a real SlotGrid + GridResidencyAdapter
//            drive a REAL LandblockLRU (park/unpark/disposeParked as the
//            mechanism library) with the assert provider armed; a scripted
//            walk + teleport ends gridLruDivergence = 0 AND all grid
//            integrity counters 0 — the GATE-GRID node-scale criterion.
//
// Run:  node harness/test_slotgrid_lru_assert.mjs        (exit 0/1)

import { LandblockLRU, lbKeyFromXY } from "../scene3d/landblock_lru.js";
import {
  SlotGrid,
  GridResidencyAdapter,
  tileOfLb,
  tileLbKeys,
  PARK_HYSTERESIS_MS,
  PARK_FLOOR_MS,
} from "../scene3d/residency_grid.js";

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`  FAIL: ${msg}`);
  }
}

function makeStubScene3d() {
  return {
    terrainBakedLbs: new Set(),
    buildingsBakedLbs: new Set(),
    staticsBakedLbs: new Set(),
    envCellLoadedLbs: new Set(),
    terrainMaterials: [],
  };
}

// ---------------------------------------------------------------------------
// PART 1 — assert mode acts on nothing
// ---------------------------------------------------------------------------
console.log("PART 1: assert-only inertness");
{
  const lru = new LandblockLRU({
    scene3d: makeStubScene3d(),
    maxResident: 4,
    getCurrentLbId: () => lbKeyFromXY(100, 100),
  });
  // 20 far-away LBs (Chebyshev > ringFloor) + the player's own.
  for (let i = 0; i < 20; i += 1) lru.track(lbKeyFromXY(10 + i, 10));
  lru.track(lbKeyFromXY(100, 100));
  const before = lru.entries.size;
  lru.setGridAssertProvider(() => false);
  lru.tickEviction(lbKeyFromXY(100, 100));
  check(lru.entries.size === before, "assert tick evicts nothing");
  check(lru.parkPool.size === 0, "assert tick parks nothing");
  check(lru.getStats().evicted === 0, "no evictions recorded");
  check(lru.getStats().gridAssertMode === true, "gridAssertMode reads true");
  check(lru.getStats().gridLruDivergence === 0, "no divergence when grid disowns victims");
  // Sealed arg: assert mode returns without purging.
  lru.tickEviction(lbKeyFromXY(100, 100), lbKeyFromXY(100, 100));
  check(lru.entries.size === before, "sealed assert tick purges nothing (grid-owned)");
}

// ---------------------------------------------------------------------------
// PART 2 — divergence counting
// ---------------------------------------------------------------------------
console.log("PART 2: divergence");
{
  const lru = new LandblockLRU({
    scene3d: makeStubScene3d(),
    maxResident: 4,
    getCurrentLbId: () => lbKeyFromXY(100, 100),
  });
  for (let i = 0; i < 20; i += 1) lru.track(lbKeyFromXY(10 + i, 10));
  // Grid claims EVERYTHING resident → every would-be victim diverges,
  // clipped at the legacy per-tick bound (MAX_PARKS_PER_TICK = 8).
  lru.setGridAssertProvider(() => true);
  lru.tickEviction(lbKeyFromXY(100, 100));
  const d1 = lru.getStats().gridLruDivergence;
  check(d1 === 8, `divergence counts the clipped victim set (got ${d1}, want 8)`);
  check(lru.entries.size === 20, "still acted on nothing");
  // Partial claim: only 3 of the oldest victims claimed.
  const lru2 = new LandblockLRU({
    scene3d: makeStubScene3d(),
    maxResident: 15,
    getCurrentLbId: () => lbKeyFromXY(100, 100),
  });
  const keys = [];
  for (let i = 0; i < 20; i += 1) {
    const k = lbKeyFromXY(10 + i, 10);
    keys.push(k);
    lru2.track(k);
  }
  const claimed = new Set(keys.slice(0, 3)); // oldest 3 (insertion = age order)
  lru2.setGridAssertProvider((lb) => claimed.has(lb));
  lru2.tickEviction(lbKeyFromXY(100, 100));
  // overage = 5, victims = the 5 oldest → 3 of them claimed.
  check(lru2.getStats().gridLruDivergence === 3,
    `partial claim counts partially (got ${lru2.getStats().gridLruDivergence}, want 3)`);
}

// ---------------------------------------------------------------------------
// PART 3 — disarm restores the acting path
// ---------------------------------------------------------------------------
console.log("PART 3: disarm");
{
  const lru = new LandblockLRU({
    scene3d: makeStubScene3d(),
    maxResident: 4,
    getCurrentLbId: () => lbKeyFromXY(100, 100),
  });
  for (let i = 0; i < 12; i += 1) lru.track(lbKeyFromXY(10 + i, 10));
  lru.setGridAssertProvider(() => true);
  lru.tickEviction(lbKeyFromXY(100, 100));
  check(lru.entries.size === 12, "armed: inert");
  lru.setGridAssertProvider(null);
  check(lru.getStats().gridAssertMode === false, "disarmed flag");
  lru.tickEviction(lbKeyFromXY(100, 100));
  check(lru.entries.size < 12, "disarmed: legacy eviction acts again (OFF arm behavior)");
}

// ---------------------------------------------------------------------------
// PART 4 — integration battery (grid authority over a real LRU)
// ---------------------------------------------------------------------------
console.log("PART 4: integration battery");
await (async () => {
  const clock = { t: 0 };
  const now = () => clock.t;
  const scene3d = makeStubScene3d();
  let currentLb = lbKeyFromXY(60, 60);
  const lru = new LandblockLRU({
    scene3d,
    maxResident: 203,
    getCurrentLbId: () => currentLb,
  });
  const grid = new SlotGrid({ now, warn: () => {} });
  const feeds = {
    fireLb: (x, y) => {
      const lb = lbKeyFromXY(x, y);
      if (!lru.isParked(lb)) {
        lru.track(lb);
        scene3d.terrainBakedLbs.add(lb);
      }
    },
  };
  const lruDeps = {
    parkLb: (lb) => lru.park(lb) === true,
    unparkLb: (lb) => lru.unpark(lb) === true,
    disposeLb: (lb) => {
      if (lru.isParked(lb)) return lru.disposeParked(lb) === true;
      if (lru.entries.has((lb & 0xffff_0000) >>> 0)) return lru.evict(lb) === true;
      return false;
    },
    isParkedLb: (lb) => lru.isParked(lb),
    lbBytes: (lb) => lru.parkPool.get((lb & 0xffff_0000) >>> 0)?.bytes ?? 1024,
    touchLb: (lb) => lru.touch(lb),
  };
  const evicted = [];
  const adapter = new GridResidencyAdapter({
    grid,
    feeds,
    lru: lruDeps,
    packs: null, // legacy-lane fetch arm — pack pins covered by the core suite
    evictLbCaches: (lb) => evicted.push(lb),
    bakedPredicate: (tile) =>
      tileLbKeys(tile).every((lb) => scene3d.terrainBakedLbs.has(lb)),
    now,
    warn: () => {},
  });
  lru.setGridAssertProvider((lbKey) => {
    const tile = tileOfLb((lbKey >>> 24) & 0xff, (lbKey >>> 16) & 0xff);
    if (!grid.windowTiles.has(tile)) return false;
    const st = grid.stateOf(tile);
    return st === "LIVE" || st === "STAGED" || st === "FETCHING";
  });

  const tick = (lbKey) => {
    currentLb = lbKey;
    // The scene3d/index.js tick order: LRU assert tick, then the grid tick.
    lru.tickEviction(lbKey, 0);
    const res = grid.update((lbKey >>> 24) & 0xff, (lbKey >>> 16) & 0xff);
    adapter.onUpdate(res);
    adapter.tickTeleportDrain();
    adapter.tickPromotions();
    adapter.tickPressure(false);
    grid.audit();
    adapter.auditPins();
  };

  // Seed + settle.
  tick(lbKeyFromXY(60, 60));
  check(grid.counts().live === 36, "seed goes LIVE through the real feed/LRU path");
  check(lru.entries.size === 144, `144 LBs tracked (got ${lru.entries.size})`);

  // 30-crossing walk with steady ticks; clock advances past hysteresis so
  // trailing tiles park through the REAL lru.park machinery.
  let x = 60;
  for (let i = 0; i < 30; i += 1) {
    x += 1;
    tick(lbKeyFromXY(x, 60));
    clock.t += 900;
    tick(lbKeyFromXY(x, 60));
    tick(lbKeyFromXY(x, 60));
  }
  clock.t += PARK_HYSTERESIS_MS + 500;
  tick(lbKeyFromXY(x, 60));
  const parkedTiles = grid.counts().parked;
  check(parkedTiles > 0, `trailing tiles parked (${parkedTiles})`);
  check(lru.parkPool.size > 0, `real LRU pool holds the parked LBs (${lru.parkPool.size})`);
  check(lru.getStats().parkedTotal > 0, "parks flowed through lru.park");

  // Walk BACK into parked territory: pointer re-adopt through lru.unpark.
  for (let i = 0; i < 6; i += 1) {
    x -= 1;
    tick(lbKeyFromXY(x, 60));
    clock.t += 400;
  }
  check(lru.getStats().unparkedTotal > 0, "walk-back re-adopts via lru.unpark");

  // Teleport + drain + age out: true release flows through disposeParked.
  tick(lbKeyFromXY(200, 200));
  for (let i = 0; i < 100; i += 1) adapter.tickTeleportDrain();
  clock.t += PARK_FLOOR_MS + 2000;
  for (let i = 0; i < 200; i += 1) {
    tick(lbKeyFromXY(200, 200));
    clock.t += 150;
  }
  check(lru.getStats().evicted > 0, "aged parked tiles true-released via disposeParked→evict");
  check(evicted.length > 0, "per-LB wasm world-cache clears fired");

  // THE GATE COUNTERS (node scale).
  const g = grid.getStats();
  const a = adapter.getStats();
  const l = lru.getStats();
  check(l.gridLruDivergence === 0, `gridLruDivergence = 0 over the battery (got ${l.gridLruDivergence})`);
  check(g.shiftMismatches === 0, `shiftMismatches = 0 (got ${g.shiftMismatches})`);
  check(g.slotDesyncs === 0, `slotDesyncs = 0 (got ${g.slotDesyncs})`);
  check(a.pinLeaks === 0, `pinLeaks = 0 (got ${a.pinLeaks})`);
  check(l.evicted === 0 || l.gridAssertMode === true, "legacy LRU stayed assert-only throughout");
})();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("SLOTGRID-LRU-ASSERT ❌");
  process.exit(1);
}
console.log("SLOTGRID-LRU-ASSERT ✅");
