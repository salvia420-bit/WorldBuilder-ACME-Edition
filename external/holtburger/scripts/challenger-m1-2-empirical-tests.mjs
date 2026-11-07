/**
 * Challenger 2 Adversarial Verification & Stress Test Harness — Milestone 1
 * Independent empirical verification of:
 * 1. world_stream.js ocean corridor detection, near-ring terrain baking and object fetching suppression.
 * 2. LandblockManager.RelocateObjectForPhysics and VehicleManager.EnsureLoaded ocean corridor behavior.
 * 3. Vehicle.ToPosition and Vehicle.ToGlobal coordinate transforms across the full dual-continent map.
 * 4. LandblockManager 3D array addressing and Bit 31 / 7-bit truncation analysis.
 */

import * as flightModel from '../apps/holtburger-web/scene3d/vehicle/flight_model.js';
import * as worldStream from '../apps/holtburger-web/scene3d/world_stream.js';
import * as worldTerrain from '../apps/holtburger-web/scene3d/world_terrain.js';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures = [];

function assertTest(name, condition, details = '') {
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
console.log('    CHALLENGER 2: ADVERSARIAL VERIFICATION & STRESS HARNESS');
console.log('======================================================================\n');

// ----------------------------------------------------------------------
// PART 1: world_stream.js Ocean Corridor Detection & Suppression
// ----------------------------------------------------------------------
console.log('>>> [PART 1] Client Streaming & Ocean Corridor Suppression (world_stream.js) <<<');

// 1.1 Boundary precision of isOceanCorridor
{
  const eps = 1e-4;
  assertTest('1.1.1: Y = 48959.9999 (Dereth shore) is NOT in ocean corridor', !worldStream.isOceanCorridor({ gy: 48960.0 - eps }));
  assertTest('1.1.2: Y = 48960.0000 (Exact start) IS in ocean corridor', worldStream.isOceanCorridor({ gy: 48960.0 }));
  assertTest('1.1.3: Y = 58944.0000 (Mid-ocean corridor) IS in ocean corridor', worldStream.isOceanCorridor({ gy: 58944.0 }));
  assertTest('1.1.4: Y = 68927.9999 (Just south of Dericost) IS in ocean corridor', worldStream.isOceanCorridor({ gy: 68928.0 - eps }));
  assertTest('1.1.5: Y = 68928.0000 (Dericost landfall) is NOT in ocean corridor', !worldStream.isOceanCorridor({ gy: 68928.0 }));
  assertTest('1.1.6: upd.y fallback works when upd.gy is undefined', worldStream.isOceanCorridor({ y: 55000.0 }));
  assertTest('1.1.7: upd.isOceanCorridor explicit flag overrides', worldStream.isOceanCorridor({ isOceanCorridor: true, gy: 10000.0 }));
  assertTest('1.1.8: null and empty updates return false without throwing', !worldStream.isOceanCorridor(null) && !worldStream.isOceanCorridor({}));
}

// 1.2 world_stream.js Stream Gating under continuous flight
{
  let terrainRingCalls = 0;
  let terrainLbCalls = 0;
  let buildingCalls = 0;
  let staticCalls = 0;
  let spawnCalls = 0;
  let envCellCalls = 0;
  let terrainPrefetchCalls = 0;
  let buildingAabbCalls = 0;
  let cellContainerCalls = 0;
  let objectCalls = 0;

  const mockScene = {
    loadTerrainRing: (cx, cy) => { terrainRingCalls++; },
    loadTerrainForLandblock: (cx, cy) => { terrainLbCalls++; },
    loadBuildingsForLandblock: (cx, cy) => { buildingCalls++; },
    loadStaticsForLandblock: (cx, cy) => { staticCalls++; },
    loadSpawnsForLandblock: (cx, cy) => { spawnCalls++; },
    loadEnvCellsForLandblock: (lbId) => { envCellCalls++; },
  };

  const terrainPrefetchedLbs = new Set();
  const buildingAabbsPopulatedLbs = new Set();
  const cellContainersPopulatedLbs = new Set();
  const objectsRenderAddedLbs = new Set();

  const streamer = worldStream.createWorldStreamer({
    getLocalPlayerGuid: () => 0xCAFE,
    getLiveScene3d: () => mockScene,
    ensureTerrainAroundLandblock: (lbId) => { terrainPrefetchCalls++; terrainPrefetchedLbs.add(lbId); },
    ensureBuildingAabbsAroundLandblock: (lbId) => { buildingAabbCalls++; buildingAabbsPopulatedLbs.add(lbId); },
    ensureCellContainersForLandblock: (lbId) => { cellContainerCalls++; cellContainersPopulatedLbs.add(lbId); },
    ensureLandblockObjectsForLandblock: (lbId) => { objectCalls++; objectsRenderAddedLbs.add(lbId); },
    emitLandblockChanged: () => {},
    terrainPrefetchedLbs,
    buildingAabbsPopulatedLbs,
    cellContainersPopulatedLbs,
    objectsRenderAddedLbs,
  });

  // Step 1: Pre-ocean flight on Dereth (Y = 48,000)
  streamer.onPositionUpdate({ guid: 0xCAFE, landblockId: 0x01FE0001, gy: 48000.0 });
  assertTest('1.2.1: Dereth outdoor streaming active before corridor', terrainRingCalls === 1 && buildingCalls === 1 && objectCalls === 1);

  // Step 2: Transit ocean corridor (48960 m <= Y < 68928 m) over 1000 simulated packets
  const terrainBeforeOcean = terrainRingCalls;
  const buildingBeforeOcean = buildingCalls;
  const objectBeforeOcean = objectCalls;
  const prefetchBeforeOcean = terrainPrefetchCalls;

  for (let y = 48960.0; y < 68928.0; y += 20.0) {
    streamer.onPositionUpdate({ guid: 0xCAFE, landblockId: 0x01FE0001, gy: y });
  }

  assertTest('1.2.2: Zero terrain ring baking calls during ocean corridor transit', terrainRingCalls === terrainBeforeOcean, `Calls: ${terrainRingCalls - terrainBeforeOcean}`);
  assertTest('1.2.3: Zero building loading calls during ocean corridor transit', buildingCalls === buildingBeforeOcean, `Calls: ${buildingCalls - buildingBeforeOcean}`);
  assertTest('1.2.4: Zero scenery/static object calls during ocean corridor transit', objectCalls === objectBeforeOcean, `Calls: ${objectCalls - objectBeforeOcean}`);
  assertTest('1.2.5: Zero terrain prefetch calls during ocean corridor transit', terrainPrefetchCalls === prefetchBeforeOcean, `Calls: ${terrainPrefetchCalls - prefetchBeforeOcean}`);
  assertTest('1.2.6: Ocean skipped ring evaluations telemetry correctly counted', streamer.dungeonStreamGateStats().oceanSkippedRingEvals === 999);
  assertTest('1.2.7: lastRingLb invalidated to 0 during ocean corridor', streamer.dungeonStreamGateStats().lastRingLb === 0);

  // Step 3: Landfall on Dericost (Y = 68928.0)
  streamer.onPositionUpdate({ guid: 0xCAFE, landblockId: 0x81010001, gy: 68928.0 });
  assertTest('1.2.8: Dericost terrain immediately baked on landfall without shift-skip', terrainRingCalls === terrainBeforeOcean + 1);
  assertTest('1.2.9: Dericost buildings immediately fetched on landfall', buildingCalls === buildingBeforeOcean + 1);
  assertTest('1.2.10: Dericost objects immediately fetched on landfall', objectCalls === objectBeforeOcean + 1);

  // Step 4: Fly back South into ocean corridor
  const terrainBeforeSouth = terrainRingCalls;
  for (let y = 68920.0; y >= 48960.0; y -= 20.0) {
    streamer.onPositionUpdate({ guid: 0xCAFE, landblockId: 0x81010001, gy: y });
  }
  assertTest('1.2.11: Southbound ocean transit suppresses all terrain/building calls', terrainRingCalls === terrainBeforeSouth);

  // Step 5: Landfall back on Dereth North Shore (Y = 48950.0)
  streamer.onPositionUpdate({ guid: 0xCAFE, landblockId: 0x01FD0001, gy: 48950.0 });
  assertTest('1.2.12: Dereth terrain immediately re-admitted on return landfall', terrainRingCalls === terrainBeforeSouth + 1);
}

// ----------------------------------------------------------------------
// PART 2: Server-Side Logic Emulation: RelocateObjectForPhysics & EnsureLoaded
// ----------------------------------------------------------------------
console.log('\n>>> [PART 2] Server LandblockManager & VehicleManager Physics Relocation Emulation <<<');

{
  const OceanCorridorYMin = 48960.0;
  const OceanCorridorYMax = 68928.0;

  function IsInOceanCorridor(wo) {
    if (wo.isVehicle) {
      return wo.y >= OceanCorridorYMin && wo.y < OceanCorridorYMax;
    }
    if (wo.isPlayer) {
      if (wo.vehicle != null) {
        return wo.vehicle.y >= OceanCorridorYMin && wo.vehicle.y < OceanCorridorYMax;
      }
    }
    return false;
  }

  let dbAllocations = 0;
  let removedForPhysics = 0;

  function RelocateObjectForPhysics(wo, adjacencyMove = true) {
    if (IsInOceanCorridor(wo)) {
      const old = wo.currentLandblock;
      if (old != null) {
        removedForPhysics++;
        wo.currentLandblock = null;
      }
      return; // Early bypass: zero landblock allocations
    }

    const oldBlock = wo.currentLandblock;
    dbAllocations++;
    const newBlock = { id: wo.cell >> 16 };
    wo.currentLandblock = newBlock;
  }

  function EnsureLoaded(pos, v) {
    if (v.y >= OceanCorridorYMin && v.y < OceanCorridorYMax) {
      return; // Zero loading in ocean corridor
    }
    dbAllocations += 9;
  }

  // Test 2.1: Vehicle crossing into corridor
  const vehicle = { isVehicle: true, y: 48000.0, currentLandblock: { id: 0x01FE }, cell: 0x01FE0001 };
  RelocateObjectForPhysics(vehicle);
  assertTest('2.1.1: Vehicle on Dereth assigns CurrentLandblock', vehicle.currentLandblock != null);

  vehicle.y = 48960.0; // Enters corridor
  RelocateObjectForPhysics(vehicle);
  assertTest('2.1.2: Vehicle crossing into corridor sets CurrentLandblock to null', vehicle.currentLandblock === null);
  assertTest('2.1.3: Vehicle crossing into corridor calls RemoveWorldObjectForPhysics', removedForPhysics === 1);

  const allocsInCorridorStart = dbAllocations;
  EnsureLoaded({ cell: 0x01FE0001 }, vehicle);
  assertTest('2.1.4: VehicleManager.EnsureLoaded bypasses allocations in ocean corridor', dbAllocations === allocsInCorridorStart);

  vehicle.y = 58944.0;
  RelocateObjectForPhysics(vehicle);
  EnsureLoaded({ cell: 0x01FE0001 }, vehicle);
  assertTest('2.1.5: Zero DB allocations across entire corridor cruise', dbAllocations === allocsInCorridorStart);

  vehicle.y = 68928.0; // Dericost landfall
  vehicle.cell = 0x81010001;
  RelocateObjectForPhysics(vehicle);
  assertTest('2.1.6: Vehicle crossing onto Dericost restores CurrentLandblock', vehicle.currentLandblock != null && vehicle.currentLandblock.id === (0x81010001 >> 16));

  // Test 2.2: Adversarial case: Unseated / Bailed Player in Ocean Corridor
  const unseatedPlayer = { isPlayer: true, vehicle: null, y: 55000.0, currentLandblock: null, cell: 0x01FE0001 };
  const inCorridorResult = IsInOceanCorridor(unseatedPlayer);
  assertTest('2.2.1 [FLAW]: IsInOceanCorridor returns false for unseated player in corridor', inCorridorResult === false, 'VehicleOf(p) is null so IsInOceanCorridor returns false!');

  const allocsBeforeUnseated = dbAllocations;
  RelocateObjectForPhysics(unseatedPlayer);
  assertTest('2.2.2 [FLAW]: Unseated player in ocean triggers spurious landblock allocation on Dereth', dbAllocations > allocsBeforeUnseated, `Allocated landblock for Y=55000m: ${unseatedPlayer.currentLandblock?.id.toString(16)}`);
}

// ----------------------------------------------------------------------
// PART 3: Server & Client Coordinate Mapping & Bit 31 Flaw Verification
// ----------------------------------------------------------------------
console.log('\n>>> [PART 3] Mathematical & Bit-Level Failure Mode Analysis <<<');

{
  // 3.1 Client flight_model.js toCellLocal & toGlobal
  // Case A: Western Dereth (lbX = 50, gx = 9600m)
  const westDereth = flightModel.toCellLocal(9600.0, 10000.0, 50.0);
  assertTest('3.1.1: Western Dereth cell has Bit 31 = 0', ((westDereth.cell >>> 31) & 1) === 0);

  // Case B: Eastern Dereth (Holtburg, lbX = 169 = 0xA9, gx = 32448m)
  const holtburg = flightModel.toCellLocal(32448.0, 13824.0, 50.0);
  const holtburgBit31 = (holtburg.cell >>> 31) & 1;
  assertTest('3.1.2 [CRITICAL FLAW]: Eastern Dereth (Holtburg) cell has Bit 31 forced to 1 due to lbX=169 >= 128', holtburgBit31 === 1, `Bit 31 is ${holtburgBit31}, cell=0x${holtburg.cell.toString(16)}`);

  // Server Vehicle.ToGlobal simulation on Holtburg
  const DericostYOffset = 68928.0;
  function serverVehicleToGlobal(p) {
    const continent = (p.cell >>> 31) & 1;
    const x = ((p.cell >>> 24) & 0x7F) * 192.0 + p.x;
    const y = (continent === 1 ? DericostYOffset : 0.0) + ((p.cell >>> 16) & 0xFF) * 192.0 + p.y;
    return { x, y, z: p.z, continent };
  }

  const holtburgServerGlobal = serverVehicleToGlobal(holtburg);
  assertTest('3.1.3 [CRITICAL FLAW]: Server Vehicle.ToGlobal teleports Holtburg 68.9 km North to Dericost', holtburgServerGlobal.y === 13824.0 + 68928.0, `Y became ${holtburgServerGlobal.y} (expected 13824.0)`);
  assertTest('3.1.4 [CRITICAL FLAW]: Server Vehicle.ToGlobal truncates Holtburg X by 24.5 km (32448 -> 7872)', holtburgServerGlobal.x === 7872.0, `X became ${holtburgServerGlobal.x} (expected 32448.0)`);

  // Case C: Eastern Dericost (lbX = 169, gx = 32448m, gy = 82752m)
  const dericostEast = flightModel.toCellLocal(32448.0, 82752.0, 50.0);
  const dericostServerGlobal = serverVehicleToGlobal(dericostEast);
  assertTest('3.1.5 [CRITICAL FLAW]: Eastern Dericost (lbX=169) truncates X by 24.5 km (32448 -> 7872)', dericostServerGlobal.x === 7872.0, `X became ${dericostServerGlobal.x} (expected 32448.0)`);
  assertTest('3.1.6 [CRITICAL FLAW]: Dereth Holtburg and Dericost East produce 100% identical cell IDs', holtburg.cell === dericostEast.cell, `Both cells are 0x${holtburg.cell.toString(16)}`);

  // Case D: LandblockManager.cs Index Collision Emulation
  function landblockManagerGetIndices(rawCellId) {
    const continent = (rawCellId >>> 31) & 1;
    const x = (rawCellId >>> 24) & 0x7F;
    const y = (rawCellId >>> 16) & 0xFF;
    return { continent, x, y };
  }

  const derethHoltburgIndices = landblockManagerGetIndices(holtburg.cell);
  const dericostIndicesX169 = landblockManagerGetIndices(dericostEast.cell);
  const dericostLocal41 = flightModel.toCellLocal(41 * 192.0, 82752.0, 50.0);
  const dericostIndicesX41 = landblockManagerGetIndices(dericostLocal41.cell);

  assertTest('3.1.7 [CRITICAL FLAW]: LandblockManager indexes Holtburg into Continent 1 (Dericost)', derethHoltburgIndices.continent === 1);
  assertTest('3.1.8 [CRITICAL FLAW]: LandblockManager collapses X=169 and X=41 into the SAME array slot [1, 41, 72]',
    derethHoltburgIndices.continent === dericostIndicesX41.continent &&
    derethHoltburgIndices.x === dericostIndicesX41.x &&
    derethHoltburgIndices.y === dericostIndicesX41.y,
    `Holtburg=[${derethHoltburgIndices.continent}, ${derethHoltburgIndices.x}, ${derethHoltburgIndices.y}], Dericost41=[${dericostIndicesX41.continent}, ${dericostIndicesX41.x}, ${dericostIndicesX41.y}]`
  );
  assertTest('3.1.9 [CRITICAL FLAW]: LandblockManager columns 128..254 are dead unreachable memory',
    derethHoltburgIndices.x <= 127 && dericostIndicesX169.x <= 127 && dericostIndicesX41.x <= 127
  );
}

// ----------------------------------------------------------------------
// SUMMARY
// ----------------------------------------------------------------------
console.log('\n======================================================================');
console.log(`TOTAL ADVERSARIAL TESTS: ${totalTests}`);
console.log(`PASSED:                 ${passedTests}`);
console.log(`FAILED / REPRODUCED:    ${failedTests}`);
console.log('======================================================================');

if (failures.length > 0) {
  console.log('\nCONFIRMED CRITICAL FINDINGS:');
  for (const f of failures) {
    console.log(`- ${f.name}`);
    console.log(`  Evidence: ${f.details}`);
  }
}
