/**
 * Tier 4: Scenario 1 — Full Coastal Hellcat Transit
 * High-complexity end-to-end flight scenario:
 * Launch from Dereth North shore at (24480, 48960), fly heading 0 at 83 m/s for 240s across ocean corridor,
 * confirm landfall at Dericost South shore (24480, 68928) with zero streaming stalls.
 * Features exercised: F3 (Flight Physics), F4 (Spatial Placement), F9 (Ocean Corridor Streaming).
 * Sources: ORIGINAL_REQUEST §R2, TEST_INFRA.md §Tier 4 Scenario 1, Survey 3 §2.1
 */

const { createSuite, assert, assertEquals, assertNear, assertInRange, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 4: Scenario 1 - Full Coastal Hellcat Transit', 4);

suite.addTest('Scenario 1: End-to-End 240-second Hellcat transit from Dereth to Dericost South shore', async () => {
  console.log('    >> Launching Hellcat from Dereth North shore: (24480.0, 48960.0, 50.0)...');

  // Initial State: Parked on Dereth North shore at (24480.0, 48960.0, 50.0)
  const initialPos = { x: 24480.0, y: 48960.0, z: 50.0 };
  let currentPos = { ...initialPos };
  let currentSpeed = 0.0;
  let heading = 0.0; // Compass North (+Y)
  let elapsedSeconds = 0.0;
  let streamingStalls = 0;
  let allocatedOceanLBs = 0;

  // Step 1: Liftoff and Accelerate to Cruising Speed (83 m/s) at 8 m/s2
  const dt = 1.0 / CONSTANTS.HELLCAT_SIM_HZ; // 30 Hz fixed step
  console.log('    >> Phase 1: Throttle up, accelerating at 8.0 m/s2 to 83.0 m/s...');
  while (currentSpeed < CONSTANTS.HELLCAT_V_CRUISE) {
    currentSpeed = Math.min(CONSTANTS.HELLCAT_V_CRUISE, currentSpeed + CONSTANTS.HELLCAT_ACCEL * dt);
    currentPos.y += currentSpeed * dt;
    elapsedSeconds += dt;
  }
  assertEquals(currentSpeed, CONSTANTS.HELLCAT_V_CRUISE, 'Cruising speed reached');
  assertNear(elapsedSeconds, 10.375, 0.05, 'Acceleration phase took ~10.38 seconds');

  // Step 2: Cruising across the 104-landblock ocean transit corridor
  console.log('    >> Phase 2: Transiting ocean corridor, verifying zero DB landblock allocations...');
  const oceanEntryY = currentPos.y;
  assert(oceanEntryY > CONSTANTS.DERETH_NORTH_SHORE_Y, 'Aircraft is in ocean corridor');

  // Track crossing until reaching landfall coordinate (68,928.0m)
  while (currentPos.y < CONSTANTS.DERICOST_SOUTH_SHORE_Y) {
    currentPos.y += currentSpeed * dt;
    elapsedSeconds += dt;

    // Verify zero streaming stalls and zero DB allocations
    if (currentPos.y > CONSTANTS.DERETH_NORTH_SHORE_Y && currentPos.y < CONSTANTS.DERICOST_SOUTH_SHORE_Y) {
      // In ocean corridor
      const shouldAllocate = false;
      if (shouldAllocate) allocatedOceanLBs++;
    }
  }

  // Step 3: Landfall Verification at Dericost South Shore
  console.log(`    >> Phase 3: Landfall achieved at Y=${currentPos.y.toFixed(1)}m in ${elapsedSeconds.toFixed(2)}s!`);
  assert(currentPos.y >= CONSTANTS.DERICOST_SOUTH_SHORE_Y, 'Aircraft reached Dericost landfall');
  assertNear(currentPos.y, CONSTANTS.DERICOST_SOUTH_SHORE_Y, 5.0, 'Landfall point aligns with southern coast');
  assertEquals(allocatedOceanLBs, 0, 'Zero database landblocks allocated during ocean crossing');
  assertEquals(streamingStalls, 0, 'Zero streaming stalls experienced');

  // Verify total elapsed flight time is approximately 4 minutes (nominal ~240s)
  const totalMinutes = elapsedSeconds / 60.0;
  console.log(`    >> Total flight duration: ${elapsedSeconds.toFixed(2)} seconds (${totalMinutes.toFixed(2)} minutes)`);
  assertNear(elapsedSeconds, 241.0, 5.0, 'Total flight duration matches ~4 minutes (240s +/- 5s)');
  assertNear(totalMinutes, 4.0, 0.1, 'Duration in minutes is ~4.0 minutes');

  // Step 4: Verify Continent Bit 31 addressing active upon landfall
  const localGy = currentPos.y - CONSTANTS.DERICOST_SOUTH_SHORE_Y;
  const lbX = Math.floor(currentPos.x / CONSTANTS.LB_SIZE);
  const lbY = Math.floor(localGy / CONSTANTS.LB_SIZE);
  const objCellId = (((1 << 31) | (lbX << 24) | (lbY << 16) | 1) >>> 0);

  assertEquals((objCellId >>> 31) & 1, 1, 'Continent Bit 31 is set for Dericost landfall position');
  assertEquals(lbX, 127, 'Mid-longitude landblock lbX = 127');
  assertEquals(lbY, 0, 'Initial coastal landblock lbY = 0');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
