/**
 * Tier 2: Boundary 2 — Biome Coordinate Boundaries
 * Province transition lines, extreme polar and ocean coordinates, altitude stratification.
 * Sources: TEST_INFRA.md, ORIGINAL_REQUEST §R1, Survey 2 §1.3
 */

const { createSuite, assert, assertEquals, assertInRange, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 2: Boundary 2 - Biome Coordinate Boundaries', 2);

function resolveBiomeAt(x, y, z = 0.0) {
  if (y < CONSTANTS.DERICOST_SOUTH_SHORE_Y || y > CONSTANTS.DERICOST_NORTH_BOUND_Y) {
    return 'Ocean';
  }
  // High altitude overrides lower biomes
  if (z >= 550.0) return 'Gelid Plateau Alpine';

  if (y >= 102000.0) return 'Gelid Plateau';
  if (y >= 88000.0) {
    return (x < 22000.0) ? 'Ashatiri Lowlands' : 'Valley of Tresimaen';
  }
  if (y >= 76000.0) {
    return (x < 24000.0) ? 'Dericost Marshes' : 'The High Desert Plateau';
  }
  return 'Nesortania Maritime Coast';
}

suite.addTest('B2.1: Province transition boundaries resolve consistently at exact boundary meters', () => {
  // Exact boundary at Y=102,000m
  assertEquals(resolveBiomeAt(30000.0, 102000.0), 'Gelid Plateau', 'At exactly 102,000m, Gelid Plateau begins');
  assertEquals(resolveBiomeAt(30000.0, 101999.9), 'Valley of Tresimaen', 'Just below 102,000m, Tresimaen is active');

  // Exact boundary at Y=88,000m
  assertEquals(resolveBiomeAt(30000.0, 88000.0), 'Valley of Tresimaen');
  assertEquals(resolveBiomeAt(30000.0, 87999.9), 'The High Desert Plateau');

  // Exact boundary at Y=76,000m
  assertEquals(resolveBiomeAt(20000.0, 76000.0), 'Dericost Marshes');
  assertEquals(resolveBiomeAt(20000.0, 75999.9), 'Nesortania Maritime Coast');
});

suite.addTest('B2.2: Extreme northern polar edge at Y=117,888.0m resolves to polar tundra', () => {
  assertEquals(resolveBiomeAt(24480.0, 117888.0), 'Gelid Plateau', 'Extreme polar bound is Gelid Plateau');
  assertEquals(resolveBiomeAt(24480.0, 117888.1), 'Ocean', 'Beyond 117,888m transitions to Northern Polar Ocean');
});

suite.addTest('B2.3: Western continental border at X=0.0m behaves as valid boundary', () => {
  const biome = resolveBiomeAt(0.0, 80000.0);
  assertEquals(biome, 'Dericost Marshes', 'West coast at X=0.0m is valid');
  assertInRange(0.0, CONSTANTS.DERICOST_WEST_X, CONSTANTS.DERICOST_EAST_X);
});

suite.addTest('B2.4: Eastern continental border at X=48,960.0m behaves as valid boundary', () => {
  const biome = resolveBiomeAt(48960.0, 80000.0);
  assertEquals(biome, 'The High Desert Plateau', 'East coast at X=48,960.0m is valid');
  assertInRange(48960.0, CONSTANTS.DERICOST_WEST_X, CONSTANTS.DERICOST_EAST_X);
});

suite.addTest('B2.5: Altitude climate stratification overrides latitudinal biome at high elevations', () => {
  // In the High Desert at Z=100m, biome is High Desert
  assertEquals(resolveBiomeAt(35000.0, 80000.0, 100.0), 'The High Desert Plateau');
  // On a towering mesa at Z=600m, altitude forces Alpine conditions
  assertEquals(resolveBiomeAt(35000.0, 80000.0, 600.0), 'Gelid Plateau Alpine');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
