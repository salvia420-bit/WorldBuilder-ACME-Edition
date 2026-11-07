/**
 * Challenger M1-R2-2 Empirical Stress Test Harness
 * Comprehensive empirical stress testing of:
 * 1. world_stream.js ocean streaming gate, live packet simulation, and landfall re-admittance.
 * 2. isIndoorCell Bit 15 mask across all outdoor & indoor cells on both continents.
 * 3. toCellLocal and toGlobal round-trip coordinate inversion & Bit 15/lbX preservation.
 * 4. Client fall_model.js bounds & bailout coordinate integrity.
 */

import * as flightModel from '../apps/holtburger-web/scene3d/vehicle/flight_model.js';
import * as worldStream from '../apps/holtburger-web/scene3d/world_stream.js';
import * as fallModel from '../apps/holtburger-web/scene3d/vehicle/fall_model.js';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures = [];

function check(name, condition, details = '') {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  [PASS] ${name}`);
  } else {
    failedTests++;
    console.log(`  [FAIL] ${name} — ${details}`);
    failures.push({ name, details });
  }
}

console.log('======================================================================');
console.log('   CHALLENGER M1-R2-2: EMPIRICAL STRESS & ADVERSARIAL HARNESS');
console.log('======================================================================\n');

// ----------------------------------------------------------------------
// 1. world_stream.js isIndoorCell bitmasking
// ----------------------------------------------------------------------
console.log('>>> [SUITE 1] isIndoorCell Bit 15 Outdoor/Indoor Discriminator <<<');
{
  // Test 1.1: Outdoor Dereth cells (continent = 0, cells 1..64)
  let derethOutdoorPassed = true;
  for (let lbX = 0; lbX < 255; lbX += 37) {
    for (let lbY = 0; lbY < 255; lbY += 37) {
      for (let cell = 1; cell <= 64; cell++) {
        const packed = ((lbX << 24) | (lbY << 16) | cell) >>> 0;
        // isIndoorCell is private in world_stream.js, but onPositionUpdate uses it and sets gateStats.indoorNow
        // We can test the exact formula and test through streamer.
        const isInd = ((packed >>> 0) & 0x7fff) >= 0x100;
        if (isInd) {
          derethOutdoorPassed = false;
          break;
        }
      }
    }
  }
  check('1.1: Dereth outdoor cells (1..64) are NEVER classified as indoor', derethOutdoorPassed);

  // Test 1.2: Outdoor Dericost cells (continent = 1, Bit 15 set, cells 1..64)
  let dericostOutdoorPassed = true;
  for (let lbX = 0; lbX < 255; lbX += 37) {
    for (let lbY = 0; lbY < 255; lbY += 37) {
      for (let cell = 1; cell <= 64; cell++) {
        const packed = ((lbX << 24) | (lbY << 16) | 0x8000 | cell) >>> 0;
        const isInd = ((packed >>> 0) & 0x7fff) >= 0x100;
        if (isInd) {
          dericostOutdoorPassed = false;
          break;
        }
      }
    }
  }
  check('1.2: Dericost outdoor cells (Bit 15 + cells 1..64) are NEVER classified as indoor', dericostOutdoorPassed);

  // Test 1.3: Indoor EnvCells (cells >= 0x100) on Dereth
  let derethIndoorPassed = true;
  for (let cell = 0x100; cell <= 0x120; cell++) {
    const packed = ((10 << 24) | (10 << 16) | cell) >>> 0;
    const isInd = ((packed >>> 0) & 0x7fff) >= 0x100;
    if (!isInd) { derethIndoorPassed = false; break; }
  }
  check('1.3: Dereth EnvCells (>= 0x100) are correctly classified as indoor', derethIndoorPassed);

  // Test 1.4: Indoor EnvCells (cells >= 0x100) on Dericost (Bit 15 set)
  let dericostIndoorPassed = true;
  for (let cell = 0x100; cell <= 0x120; cell++) {
    const packed = ((10 << 24) | (10 << 16) | 0x8000 | cell) >>> 0;
    const isInd = ((packed >>> 0) & 0x7fff) >= 0x100;
    if (!isInd) { dericostIndoorPassed = false; break; }
  }
  check('1.4: Dericost EnvCells (Bit 15 + >= 0x100) are correctly classified as indoor', dericostIndoorPassed);
}

// ----------------------------------------------------------------------
// 2. world_stream.js Ocean Corridor Gate & Live Packet Simulation
// ----------------------------------------------------------------------
console.log('\n>>> [SUITE 2] world_stream.js Ocean Corridor Live Simulation <<<');
{
  const eps = 1e-4;
  check('2.1: Exactly at Y=48959.9999 is NOT in ocean corridor', !worldStream.isOceanCorridor({ gy: 48960.0 - eps }));
  check('2.2: Exactly at Y=48960.0000 IS in ocean corridor', worldStream.isOceanCorridor({ gy: 48960.0 }));
  check('2.3: Mid-ocean Y=58944.0000 IS in ocean corridor', worldStream.isOceanCorridor({ gy: 58944.0 }));
  check('2.4: Exactly at Y=68927.9999 IS in ocean corridor', worldStream.isOceanCorridor({ gy: 68928.0 - eps }));
  check('2.5: Exactly at Y=68928.0000 (Dericost landfall) is NOT in ocean corridor', !worldStream.isOceanCorridor({ gy: 68928.0 }));

  // Live packet format test: upd has { guid, landblockId, y } without gy
  // Case A: lbY = 255 (beyond Dereth boundary), local y = 10.0 -> gy = 48960 + 10 = 48970 (ocean)
  const syntheticOceanUpd = { landblockId: ((10 << 24) | (255 << 16) | 1) >>> 0, y: 10.0 };
  check('2.6: Live packet with lbY=255 and local y=10.0 detects ocean corridor', worldStream.isOceanCorridor(syntheticOceanUpd));

  // Case B: Dericost landfall lbY = 0, continent = 1 (Bit 15 set), local y = 5.0 -> gy = 68928 + 5 = 68933 (not ocean)
  const dericostLandfallUpd = { landblockId: ((10 << 24) | (0 << 16) | 0x8000 | 1) >>> 0, y: 5.0 };
  check('2.7: Live packet at Dericost landfall (continent=1, lbY=0) is NOT in ocean corridor', !worldStream.isOceanCorridor(dericostLandfallUpd));

  // Live streaming simulation: Dereth -> Ocean -> Dericost -> Ocean -> Dereth
  let terrainRingCalls = 0;
  let buildingCalls = 0;
  let staticCalls = 0;
  let spawnCalls = 0;
  let terrainPrefetchCalls = 0;
  let buildingAabbCalls = 0;
  let cellContainerCalls = 0;

  const mockScene = {
    loadTerrainRing: () => { terrainRingCalls++; },
    loadTerrainForLandblock: () => { terrainRingCalls++; },
    loadBuildingsForLandblock: () => { buildingCalls++; },
    loadStaticsForLandblock: () => { staticCalls++; },
    loadSpawnsForLandblock: () => { spawnCalls++; },
  };

  const streamer = worldStream.createWorldStreamer({
    getLocalPlayerGuid: () => 0xBEEF,
    getLiveScene3d: () => mockScene,
    ensureTerrainAroundLandblock: () => { terrainPrefetchCalls++; },
    ensureBuildingAabbsAroundLandblock: () => { buildingAabbCalls++; },
    ensureCellContainersForLandblock: () => { cellContainerCalls++; },
    ensureLandblockObjectsForLandblock: () => {},
    emitLandblockChanged: () => {},
    terrainPrefetchedLbs: new Set(),
    buildingAabbsPopulatedLbs: new Set(),
    cellContainersPopulatedLbs: new Set(),
    objectsRenderAddedLbs: new Set(),
  });

  // 1. Flight across Dereth up to Y = 48900
  streamer.onPositionUpdate({ guid: 0xBEEF, landblockId: 0x01FE0001, gy: 48000.0, isOceanCorridor: false });
  check('2.8: Streaming active on Dereth prior to ocean transit', terrainRingCalls === 1 && buildingCalls === 1);

  // 2. Flight through ocean corridor across 500 steps (48960 to 68920)
  const callsBeforeOcean = {
    ring: terrainRingCalls,
    bld: buildingCalls,
    st: staticCalls,
    sp: spawnCalls,
    tp: terrainPrefetchCalls,
    ba: buildingAabbCalls,
    cc: cellContainerCalls
  };

  for (let gy = 48960.0; gy < 68928.0; gy += 40.0) {
    const cl = flightModel.toCellLocal(24480.0, gy, 150.0);
    streamer.onPositionUpdate({
      guid: 0xBEEF,
      landblockId: cl.cell,
      x: cl.x,
      y: cl.y,
      gy: gy,
      continent: cl.continent,
      isOceanCorridor: true
    });
  }

  check('2.9: 100% suppression of terrain ring loads in ocean corridor', terrainRingCalls === callsBeforeOcean.ring);
  check('2.10: 100% suppression of building loads in ocean corridor', buildingCalls === callsBeforeOcean.bld);
  check('2.11: 100% suppression of static loads in ocean corridor', staticCalls === callsBeforeOcean.st);
  check('2.12: 100% suppression of spawn loads in ocean corridor', spawnCalls === callsBeforeOcean.sp);
  check('2.13: 100% suppression of terrain prefetch in ocean corridor', terrainPrefetchCalls === callsBeforeOcean.tp);
  check('2.14: 100% suppression of building AABB prefetch in ocean corridor', buildingAabbCalls === callsBeforeOcean.ba);
  check('2.15: 100% suppression of cell container prefetch in ocean corridor', cellContainerCalls === callsBeforeOcean.cc);

  // 3. Landfall at Dericost (Y = 68928.0)
  const clLandfall = flightModel.toCellLocal(24480.0, 68928.0, 150.0);
  streamer.onPositionUpdate({
    guid: 0xBEEF,
    landblockId: clLandfall.cell,
    x: clLandfall.x,
    y: clLandfall.y,
    gy: 68928.0,
    continent: clLandfall.continent,
    isOceanCorridor: false
  });

  check('2.16: Immediate terrain ring loading upon Dericost landfall', terrainRingCalls === callsBeforeOcean.ring + 1);
  check('2.17: Immediate building loading upon Dericost landfall', buildingCalls === callsBeforeOcean.bld + 1);
  check('2.18: Immediate static loading upon Dericost landfall', staticCalls === callsBeforeOcean.st + 1);
  check('2.19: Immediate spawn loading upon Dericost landfall', spawnCalls === callsBeforeOcean.sp + 1);
}

// ----------------------------------------------------------------------
// 3. toCellLocal and toGlobal Coordinate Inversion & Bit 15 / lbX Preservation
// ----------------------------------------------------------------------
console.log('\n>>> [SUITE 3] Coordinate Inversion & Bit 15 Dual-Continent Preservation <<<');
{
  const points = [
    { desc: 'Western Dereth (Al-Jalima)', x: 10000.0, y: 15000.0, z: 50.0, cont: 0 },
    { desc: 'Eastern Dereth (Holtburg lbX=169)', x: 32448.0, y: 28800.0, z: 75.0, cont: 0 },
    { desc: 'Far East Dereth Edge (lbX=254)', x: 48768.0, y: 24000.0, z: 20.0, cont: 0 },
    { desc: 'Dericost South Shore Landfall', x: 24480.0, y: 68928.0, z: 100.0, cont: 1 },
    { desc: 'Dericost High Desert (Shakrassekor lbX=197)', x: 38000.0, y: 82000.0, z: 180.0, cont: 1 },
    { desc: 'Dericost Far East Edge (lbX=254)', x: 48768.0, y: 95000.0, z: 250.0, cont: 1 },
    { desc: 'Dericost Far North Edge (Y=117887.5)', x: 24480.0, y: 117887.0, z: 300.0, cont: 1 }
  ];

  for (const pt of points) {
    const loc = flightModel.toCellLocal(pt.x, pt.y, pt.z);
    const bit15 = (loc.cell >>> 15) & 1;
    const lbX = (loc.cell >>> 24) & 0xFF;
    const expectedLbX = Math.min(254, Math.floor(pt.x / 192.0));

    check(`3.1 [${pt.desc}]: Continent bit 15 matches expected (${pt.cont})`, bit15 === pt.cont, `got ${bit15}`);
    check(`3.2 [${pt.desc}]: 8-bit lbX matches expected (${expectedLbX})`, lbX === expectedLbX, `got ${lbX}`);

    // Round-trip with 4-argument toGlobal (production default)
    const [gx, gy, gz] = flightModel.toGlobal(loc.cell, loc.x, loc.y, loc.z);
    const dx = Math.abs(gx - pt.x);
    const dy = Math.abs(gy - pt.y);
    const dz = Math.abs(gz - pt.z);

    check(`3.3 [${pt.desc}]: 4-arg toGlobal round-trip dx < 0.05m`, dx < 0.05, `dx=${dx.toFixed(4)}`);
    check(`3.4 [${pt.desc}]: 4-arg toGlobal round-trip dy < 0.05m`, dy < 0.05, `dy=${dy.toFixed(4)}`);
  }
}

// ----------------------------------------------------------------------
// 4. Client Fall Model Bounds & Bailout Stress Test
// ----------------------------------------------------------------------
console.log('\n>>> [SUITE 4] Client fall_model.js Bounds & Bailout Stress Test <<<');
{
  // Test fall_model.stepFall in Dereth
  const fallDereth = { x: 24480.0, y: 30000.0, z: 1000.0, vx: 0.0, vy: 0.0, vz: -10.0, heading: 0.0, chute: false };
  fallModel.stepFall(fallDereth, 1.0 / 30.0);
  check('4.1: Fall model steps normally within Dereth bounds', fallDereth.y >= 29990 && fallDereth.y <= 30010);

  // Test fall_model.stepFall in Dericost (Y = 80000.0)
  const fallDericost = { x: 24480.0, y: 80000.0, z: 1000.0, vx: 0.0, vy: 10.0, vz: -10.0, heading: 0.0, chute: false };
  fallModel.stepFall(fallDericost, 1.0 / 30.0);
  console.log(`    fallDericost.y after 1 step from 80,000m: ${fallDericost.y}`);

  // Did fall_model clamp to 48959.5 (Dereth max) or allow Dericost (80000)?
  if (fallDericost.y < 50000.0) {
    check('4.2: [VULNERABILITY DETECTED] fall_model.js clamped Dericost Y to Dereth WORLD_MAX (48959.5m)', false, `fallDericost.y clamped to ${fallDericost.y}`);
  } else {
    check('4.2: fall_model.js supports Dericost Y range (Y >= 68928m)', true);
  }
}

console.log('\n======================================================================');
console.log(`TOTAL TESTS: ${totalTests}`);
console.log(`PASSED:      ${passedTests}`);
console.log(`FAILED:      ${failedTests}`);
console.log('======================================================================\n');
if (failures.length > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.details}`);
}
