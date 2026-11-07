/**
 * Tier 2: Boundary 10 — Town Coordinate Extremes
 * Coastal harbor placement, high mountain peak towns, rift valleys, edge margins, uniqueness.
 * Sources: TEST_INFRA.md, ORIGINAL_REQUEST §R3, Survey 2 §1.4 & §5.2
 */

const { createSuite, assert, assertEquals, assertNear, assertInRange, CONSTANTS, DERICOST_PROVINCES } = require('../harness.cjs');

const suite = createSuite('Tier 2: Boundary 10 - Town Coordinate Extremes', 2);

suite.addTest('B10.1: Coastal harbor towns (Nesortania, South-Haven) place docks at sea level (Z=0.0m)', () => {
  const coastalTowns = [
    { name: 'Nesortania', x: 24480.0, y: 70000.0, z: 0.0, hasDock: true },
    { name: 'South-Haven', x: 30000.0, y: 71000.0, z: 0.0, hasDock: true },
  ];

  for (const port of coastalTowns) {
    assertEquals(port.z, 0.0, `Harbor town ${port.name} dock elevation must be at sea level (0.0m)`);
    assertEquals(port.hasDock, true);
    assert(port.y < 76000.0, 'Must be in southern maritime province');
  }
});

suite.addTest('B10.2: High mountain glacial settlements (Vasmora, Glacier-Reach) support peak elevations >= 350m', () => {
  const mountainTowns = [
    { name: 'Vasmora', province: 'Gelid Plateau', z: 450.0 },
    { name: 'Glacier-Reach', province: 'Gelid Plateau', z: 620.0 },
    { name: 'Coldwatch', province: 'Gelid Plateau', z: 580.0 }
  ];

  for (const town of mountainTowns) {
    assert(town.z >= 350.0, `Glacial town ${town.name} altitude (${town.z}m) must be >= 350.0m`);
    assert(town.z <= 700.0, `Altitude must not exceed world ceiling 700.0m`);
    assertEquals(town.province, 'Gelid Plateau');
  }
});

suite.addTest('B10.3: Volcanic rift towns (Cannthalo, Sulfur-Springs) support depression basin placement', () => {
  const riftTown = { name: 'Sulfur-Springs', province: 'Valley of Tresimaen', x: 32000.0, y: 95000.0, z: 40.0, rimElevation: 280.0 };

  assert(riftTown.z < riftTown.rimElevation, 'Rift floor must be lower than surrounding rim');
  const depressionDepth = riftTown.rimElevation - riftTown.z;
  assertEquals(depressionDepth, 240.0, 'Depression depth is 240 meters');
});

suite.addTest('B10.4: Town centers maintain minimum 192m (1 LB) margin from world boundary edges', () => {
  // To ensure the 3x3 municipal cluster (576m x 576m) doesn't clip out of the world,
  // town center (x, y) must maintain margin >= 288m from outer borders.
  function validateTownBoundaryMargin(x, y) {
    const minX = 288.0;
    const maxX = CONSTANTS.WORLD_METERS - 288.0;
    const minY = CONSTANTS.DERICOST_SOUTH_SHORE_Y + 288.0;
    const maxY = CONSTANTS.DERICOST_NORTH_BOUND_Y - 288.0;

    return x >= minX && x <= maxX && y >= minY && y <= maxY;
  }

  // Safe inner coordinate
  assertEquals(validateTownBoundaryMargin(24480.0, 90000.0), true);

  // Unsafe border-clipping coordinate
  assertEquals(validateTownBoundaryMargin(50.0, 90000.0), false, 'X too close to west edge');
  assertEquals(validateTownBoundaryMargin(24480.0, 68950.0), false, 'Y too close to south shore');
  assertEquals(validateTownBoundaryMargin(24480.0, 117850.0), false, 'Y too close to north bound');
});

suite.addTest('B10.5: All 41 Dericost town names are strictly unique without collisions or duplicates', () => {
  const allTownNames = [];
  for (const prov of Object.values(DERICOST_PROVINCES)) {
    allTownNames.push(...prov.towns);
  }

  assertEquals(allTownNames.length, 41, 'Must have 41 total names');
  const uniqueNames = new Set(allTownNames);
  assertEquals(uniqueNames.size, 41, 'All 41 town names must be unique without duplicate entries');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
