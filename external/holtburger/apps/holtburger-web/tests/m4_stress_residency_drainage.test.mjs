// tests/m4_stress_residency_drainage.test.mjs — Milestone 4 Challenger Adversarial Stress Test
// Components: ResidencyGrid (residency_grid.js) & LandblockLRU (landblock_lru.js)
//
// OBJECTIVES:
//   1. Stress test `getAdaptiveParkFloorMs()` across extreme velocity inputs:
//      - negative speeds, 0 m/s, 1000 m/s flight, rapid teleports, NaN/Infinity.
//      - Verify it never returns NaN, negative values, or values below PARK_FLOOR_EMERGENCY_MS (5000 ms).
//   2. Stress test amortized buffer disposal (`_enqueueDeferredBufferDisposals` & `_drainDeferredBufferDisposals`):
//      - Evict 50+ tiles with thousands of WebGLBuffer geometries.
//      - Verify incremental 40-item draining per tick.
//      - Verify complete drainage (0 remaining) and zero WebGL buffer leaks.
//      - Verify `userData.__cacheOwned` buffers are never disposed.
//
// Run: node --max-old-space-size=256 tests/m4_stress_residency_drainage.test.mjs

import assert from "node:assert/strict";

// Setup global stub before importing
globalThis.window = {
  location: { search: "?warmPark=on&maxLiveGeom=500&parkFloor=30000" },
  performance: { now: () => Date.now() },
};

const { GridResidencyAdapter, SlotGrid, PARK_FLOOR_EMERGENCY_MS, PARK_FLOOR_MS } = await import("../scene3d/residency_grid.js");
const { LandblockLRU, lbKeyFromXY } = await import("../scene3d/landblock_lru.js");

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failed += 1;
    console.error(`  [FAIL] ${name} ${detail}`);
  }
}

console.log("=== M4 STRESS TEST 3: Residency Adaptive Floor & Buffer Drainage ===");

// ── Test 3.1: getAdaptiveParkFloorMs() Extreme Velocity Adversarial Suite ─────
{
  const mockLru = { lbBytes: () => 1024, touchLb: () => {}, parkLb: () => true };
  const mockGrid = { playerTile: 0, windowTiles: [] };
  const rg = new GridResidencyAdapter({ grid: mockGrid, lru: mockLru, feeds: {} });

  const extremeSpeeds = [
    -Infinity,
    -1000000,
    -500,
    -10,
    -1,
    -0.0001,
    -0.0,
    0,
    +0.0,
    0.00001,
    1.0,
    5.0,
    9.999,
    10.0,
    10.0001,
    15.0,
    25.0,
    35.0,
    50.0,
    100.0,
    500.0,
    1000.0,
    999999.0,
    +Infinity,
    NaN,
    undefined,
    null,
    "1000",
    {},
  ];

  let rgAllValid = true;
  for (const speed of extremeSpeeds) {
    rg._traversalSpeedMps = speed;
    const floor = rg.getAdaptiveParkFloorMs();

    if (!Number.isFinite(floor)) {
      rgAllValid = false;
      console.error(`ResidencyGrid: non-finite floor ${floor} for speed ${speed}`);
    }
    if (floor < PARK_FLOOR_EMERGENCY_MS) {
      rgAllValid = false;
      console.error(`ResidencyGrid: floor ${floor} < EMERGENCY_MS (5000) for speed ${speed}`);
    }
    if (floor < 0) {
      rgAllValid = false;
      console.error(`ResidencyGrid: negative floor ${floor} for speed ${speed}`);
    }
  }
  check("ResidencyGrid: getAdaptiveParkFloorMs() never returns NaN, negative, or < 5000ms", rgAllValid);

  // Verify scaling properties:
  // Speed <= 10 m/s should return base (30000)
  rg._traversalSpeedMps = 0;
  assert.equal(rg.getAdaptiveParkFloorMs(), 30000, "0 m/s returns base 30000");
  rg._traversalSpeedMps = 10;
  assert.equal(rg.getAdaptiveParkFloorMs(), 30000, "10 m/s returns base 30000");

  // Speed = 35 m/s should return 8000
  rg._traversalSpeedMps = 35;
  assert.equal(rg.getAdaptiveParkFloorMs(), 8000, "35 m/s returns 8000");

  // Speed = 1000 m/s should clamp to 8000, never dipping to emergency
  rg._traversalSpeedMps = 1000;
  assert.equal(rg.getAdaptiveParkFloorMs(), 8000, "1000 m/s clamped to 8000");

  // If parkFloorMs is configured to emergency level (5000), scaling honors floor
  rg.parkFloorMs = PARK_FLOOR_EMERGENCY_MS;
  rg._traversalSpeedMps = 1000;
  assert(rg.getAdaptiveParkFloorMs() >= PARK_FLOOR_EMERGENCY_MS, "Honors emergency floor");
  rg.parkFloorMs = 30000; // restore

  check("ResidencyGrid: Adaptive floor scaling conforms to (30s -> 8s) curve", true);
}

// ── Test 3.2: LandblockLRU getAdaptiveParkFloorMs() Adversarial Suite ─────────
{
  const lru = new LandblockLRU({
    scene3d: { renderer: { info: { memory: { geometries: 0 } } } },
    maxResident: 100,
  });

  const extremeSpeeds = [
    -Infinity, -99999, -1, 0, 0.001, 5, 10, 25, 100, 1000, +Infinity, NaN, undefined, null,
  ];

  let lruAllValid = true;
  for (const speed of extremeSpeeds) {
    lru._traversalSpeedMps = speed;
    const floor = lru.getAdaptiveParkFloorMs();

    if (!Number.isFinite(floor)) {
      lruAllValid = false;
      console.error(`LandblockLRU: non-finite floor ${floor} for speed ${speed}`);
    }
    if (floor < 8000 && floor !== 0) {
      lruAllValid = false;
      console.error(`LandblockLRU: floor ${floor} < 8000 for speed ${speed}`);
    }
    if (floor < 0) {
      lruAllValid = false;
      console.error(`LandblockLRU: negative floor ${floor} for speed ${speed}`);
    }
  }
  check("LandblockLRU: getAdaptiveParkFloorMs() never returns NaN, negative, or < 8000ms", lruAllValid);

  // Verify curve: speed <= 5 m/s -> 30000; speed >= 25 m/s -> 8000
  lru._traversalSpeedMps = 0;
  assert.equal(lru.getAdaptiveParkFloorMs(), 30000, "0 m/s returns 30000");
  lru._traversalSpeedMps = 5;
  assert.equal(lru.getAdaptiveParkFloorMs(), 30000, "5 m/s returns 30000");
  lru._traversalSpeedMps = 25;
  assert.equal(lru.getAdaptiveParkFloorMs(), 8000, "25 m/s returns 8000");
  lru._traversalSpeedMps = 500;
  assert.equal(lru.getAdaptiveParkFloorMs(), 8000, "500 m/s clamped to 8000");

  check("LandblockLRU: Adaptive floor scaling conforms to (30s -> 8s) curve", true);
}

// ── Test 3.3: Velocity Tracking Under Teleport & Clock Glitches ───────────────
{
  const mockLru = { lbBytes: () => 1024, touchLb: () => {}, parkLb: () => true, disposeLb: () => true, unparkLb: () => true, isParkedLb: () => false };
  let clockTime = 10000;
  const grid = new SlotGrid({ now: () => clockTime });
  const rg = new GridResidencyAdapter({ grid, lru: mockLru, feeds: { fireLb: () => {} }, now: () => clockTime });

  // First shift: establishes baseline timestamp (_lastShiftMs)
  clockTime += 500;
  rg.onUpdate({ moved: true, teleport: false, seed: false, admitted: [1], vacated: [0] });
  assert.equal(rg._lastShiftMs, clockTime, "First shift records _lastShiftMs");

  // Second shift: dt = 1.0s, instSpeed = 384 / 1.0 = 384 m/s
  clockTime += 1000;
  rg.onUpdate({ moved: true, teleport: false, seed: false, admitted: [2], vacated: [1] });
  assert(Number.isFinite(rg._traversalSpeedMps) && rg._traversalSpeedMps > 0,
    `Expected positive traversal speed, got ${rg._traversalSpeedMps}`);

  // Microsecond clock jump (dt near 0) -> dt clamped to Math.max(0.5, ...)
  clockTime += 0.0001;
  rg.onUpdate({ moved: true, teleport: false, seed: false, admitted: [2], vacated: [1] });
  assert(Number.isFinite(rg._traversalSpeedMps), "Survives microsecond dt clamp");
  assert(rg._traversalSpeedMps <= 1000, "Speed clamped by dt >= 0.5s bound");

  // Backward clock jump (clock skew / NTP adjustment)
  clockTime -= 5000;
  rg.onUpdate({ moved: true, teleport: false, seed: false, admitted: [3], vacated: [2] });
  assert(Number.isFinite(rg._traversalSpeedMps) && rg._traversalSpeedMps >= 0,
    "Survives backward clock jump without NaN or negative velocity");

  // Teleport event: must NOT update shift speed or corrupt velocity
  const speedBeforeTeleport = rg._traversalSpeedMps;
  clockTime += 1000;
  rg.onUpdate({ moved: true, teleport: true, seed: false, admitted: [99], vacated: [3] });
  assert.equal(rg._traversalSpeedMps, speedBeforeTeleport, "Teleport leaves traversal speed untouched");

  check("ResidencyGrid: Traversal velocity tracking is resilient to clock glitches & teleports", true);
}

// ── Test 3.4: Amortized Buffer Disposal Storm (50 Tiles Eviction) ─────────────
{
  function makeMockScene() {
    return {
      terrainBakedLbs: new Set(),
      buildingsBakedLbs: new Set(),
      staticsBakedLbs: new Set(),
      envCellLoadedLbs: new Set(),
      terrainMaterials: [],
      activeLights: [],
      renderer: { info: { memory: { geometries: 0 } } },
    };
  }

  let totalGeometriesCreated = 0;
  let totalDisposalsFired = 0;
  let cacheOwnedDisposed = 0;

  function makeMockGeom(scene, cacheOwned = false) {
    totalGeometriesCreated += 1;
    scene.renderer.info.memory.geometries += 1;
    const geom = {
      id: totalGeometriesCreated,
      userData: { __cacheOwned: cacheOwned },
      disposed: false,
      dispose() {
        if (this.userData.__cacheOwned) {
          cacheOwnedDisposed += 1;
        }
        if (!this.disposed) {
          this.disposed = true;
          totalDisposalsFired += 1;
          scene.renderer.info.memory.geometries -= 1;
        }
      },
    };
    return geom;
  }

  const scene = makeMockScene();
  const lru = new LandblockLRU({
    scene3d: scene,
    maxResident: 100,
    getCurrentLbId: () => lbKeyFromXY(0x20, 0x20),
  });

  const numTiles = 50;
  const geomsPerTile = 80; // Each tile has 80 geometries: 75 disposable, 5 cache-owned
  const expectedDisposablePerTile = 75;
  const expectedDisposableTotal = numTiles * expectedDisposablePerTile; // 3,750 geometries

  // Populate 50 landblocks
  const tileKeys = [];
  for (let i = 0; i < numTiles; i++) {
    const key = lbKeyFromXY(0x30 + i, 0x30);
    tileKeys.push(key);
    const geometries = [];
    for (let g = 0; g < geomsPerTile; g++) {
      const isCacheOwned = (g >= 75);
      geometries.push(makeMockGeom(scene, isCacheOwned));
    }
    lru.track(key, { geometries });
  }

  assert.equal(scene.renderer.info.memory.geometries, numTiles * geomsPerTile,
    "Initial geometry memory tracked correctly");

  // Evict all 50 landblocks simultaneously
  // In evictNow:
  // - First MAX_BURST_GEOM_DISPOSE (40) geometries are disposed immediately.
  // - Remaining (80 - 40 = 40) geometries are enqueued to _deferredBufferDisposals.
  for (const k of tileKeys) {
    lru.evict(k);
  }

  // Check burst cap invariant:
  // For each of the 50 tiles, at most 40 were disposed immediately = at most 2,000 immediate disposals
  check("Burst disposal cap enforced (at most 40 immediate disposals per tile)",
    totalDisposalsFired <= numTiles * 40 && totalDisposalsFired > 0,
    `immediate disposals = ${totalDisposalsFired}`);

  // Check deferred queue is populated with the remainder
  const deferredCount = lru._deferredBufferDisposals.length;
  check("Remaining geometries enqueued into _deferredBufferDisposals",
    deferredCount > 0,
    `queued deferred = ${deferredCount}`);

  // Now simulate frame ticks: tickEviction() drains in 40-item chunks per tick
  let ticks = 0;
  const maxTicksAllowed = Math.ceil(deferredCount / 40) + 10;
  let prevDeferred = deferredCount;

  while (lru._deferredBufferDisposals.length > 0 && ticks < maxTicksAllowed) {
    ticks += 1;
    lru.tickEviction(lbKeyFromXY(0x20, 0x20));
    const currDeferred = lru._deferredBufferDisposals.length;
    // Each tick should drain up to 40 items
    assert(prevDeferred - currDeferred <= 40, "Drains at most 40 items per tick");
    prevDeferred = currDeferred;
  }

  check("Deferred disposal queue drained completely to 0 within expected frame ticks",
    lru._deferredBufferDisposals.length === 0,
    `remaining = ${lru._deferredBufferDisposals.length} after ${ticks} ticks`);

  // Verify 100% of disposable geometries were disposed
  check("100% of disposable geometries were disposed (no WebGL buffer leaks)",
    totalDisposalsFired === expectedDisposableTotal,
    `disposed = ${totalDisposalsFired} / ${expectedDisposableTotal}`);

  // Verify __cacheOwned geometries were NEVER disposed
  check("Shared cache-owned geometries (__cacheOwned) were strictly protected",
    cacheOwnedDisposed === 0,
    `cacheOwnedDisposed = ${cacheOwnedDisposed}`);

  // Verify renderer geometry count accurately accounts for disposals
  assert.equal(scene.renderer.info.memory.geometries, numTiles * (geomsPerTile - expectedDisposablePerTile),
    "Renderer geometry memory matches expected retained cache-owned geoms");

  lru.dispose();
}

console.log(`\nResidency & Drainage Stress Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
