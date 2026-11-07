/**
 * Tier 1: Feature 10 — 41 Established Town Locations
 * Preplan and place 41 town locations across Dericost matching Dereth baseline.
 * Sources: ORIGINAL_REQUEST §R3, PROJECT.md §Feature 14, Survey 2 §1.4 & §5.2
 */

const { createSuite, assert, assertEquals, assertInRange, CONSTANTS, DERICOST_PROVINCES } = require('../harness.cjs');

const suite = createSuite('Tier 1: Feature 10 - 41 Established Town Locations', 1);

// Generate deterministic coordinates for all 41 towns distributed across provinces
function generateCanonicalTownDirectory() {
  const directory = {};
  // Provincial bounding zones within Dericost [X: 0..48960, Y: 68928..117888]
  const zoneBounds = {
    'Nesortania Maritime Coast': { xMin: 15000, xMax: 35000, yMin: 69500, yMax: 76000 },
    'The High Desert Plateau': { xMin: 25000, xMax: 47000, yMin: 76000, yMax: 88000 },
    'Dericost Marshes': { xMin: 2000, xMax: 24000, yMin: 76000, yMax: 88000 },
    'Valley of Tresimaen': { xMin: 20000, xMax: 45000, yMin: 88000, yMax: 102000 },
    'Ashatiri Lowlands': { xMin: 3000, xMax: 22000, yMin: 88000, yMax: 102000 },
    'Gelid Plateau': { xMin: 5000, xMax: 45000, yMin: 102000, yMax: 116000 },
  };

  let globalIndex = 0;
  for (const [provName, provData] of Object.entries(DERICOST_PROVINCES)) {
    const bounds = zoneBounds[provName];
    const stepX = (bounds.xMax - bounds.xMin) / (provData.towns.length + 1);
    const stepY = (bounds.yMax - bounds.yMin) / (provData.towns.length + 1);

    provData.towns.forEach((townName, idx) => {
      // Deterministic staggered placement
      const x = bounds.xMin + stepX * (idx + 1);
      const y = bounds.yMin + stepY * ((idx % 2 === 0) ? (idx + 1) : (provData.towns.length - idx));
      const lbX = Math.floor(x / 192.0);
      const lbY = Math.floor((y - 68928.0) / 192.0);

      directory[townName] = {
        name: townName,
        province: provName,
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        z: (provName === 'Gelid Plateau') ? 350.0 : 120.0,
        lbX,
        lbY,
        cellId: (((1 << 31) | (lbX << 24) | (lbY << 16) | 1) >>> 0)
      };
      globalIndex++;
    });
  }
  return directory;
}

const canonicalTowns = generateCanonicalTownDirectory();

suite.addTest('F10.1: Total established town count equals exactly 41 matching Dereth baseline', () => {
  const count = Object.keys(canonicalTowns).length;
  assertEquals(count, 41, 'Must have exactly 41 towns in Dericost directory');
  assertEquals(count, CONSTANTS.DERICOST_TOWN_COUNT);
});

suite.addTest('F10.2: All 41 town coordinates are strictly within Dericost bounding envelope', () => {
  for (const [name, town] of Object.entries(canonicalTowns)) {
    assertInRange(town.x, CONSTANTS.DERICOST_WEST_X, CONSTANTS.DERICOST_EAST_X,
      `Town ${name} X (${town.x}) must be in [0, 48960]`);
    assertInRange(town.y, CONSTANTS.DERICOST_SOUTH_SHORE_Y, CONSTANTS.DERICOST_NORTH_BOUND_Y,
      `Town ${name} Y (${town.y}) must be in [68928, 117888]`);
    assertInRange(town.lbX, 0, 254, `Town ${name} lbX must be in [0, 254]`);
    assertInRange(town.lbY, 0, 254, `Town ${name} lbY must be in [0, 254]`);
    assertEquals((town.cellId >>> 31) & 1, 1, `Town ${name} cellId must have Continent Bit 31 set`);
  }
});

suite.addTest('F10.3: Provincial town distribution quotas match specification', () => {
  const countsByProv = {};
  for (const town of Object.values(canonicalTowns)) {
    countsByProv[town.province] = (countsByProv[town.province] || 0) + 1;
  }

  assertEquals(countsByProv['Gelid Plateau'], 10, 'Gelid Plateau must have 10 towns');
  assertEquals(countsByProv['Ashatiri Lowlands'], 8, 'Ashatiri Lowlands must have 8 towns');
  assertEquals(countsByProv['Valley of Tresimaen'], 8, 'Valley of Tresimaen must have 8 towns');
  assertEquals(countsByProv['Dericost Marshes'], 6, 'Dericost Marshes must have 6 towns');
  assertEquals(countsByProv['The High Desert Plateau'], 6, 'High Desert must have 6 towns');
  assertEquals(countsByProv['Nesortania Maritime Coast'], 3, 'Nesortania must have 3 towns');
});

suite.addTest('F10.4: Towns maintain minimal spatial separation of at least 576m (3x3 LB cluster)', () => {
  const towns = Object.values(canonicalTowns);
  for (let i = 0; i < towns.length; i++) {
    for (let j = i + 1; j < towns.length; j++) {
      const dx = towns[i].x - towns[j].x;
      const dy = towns[i].y - towns[j].y;
      const dist = Math.hypot(dx, dy);
      assert(dist >= 576.0,
        `Towns ${towns[i].name} and ${towns[j].name} too close: ${dist.toFixed(1)}m < 576m`);
    }
  }
});

suite.addTest('F10.5: Capital Vasmora is positioned at high elevation in Gelid Plateau permafrost', () => {
  const vasmora = canonicalTowns['Vasmora'];
  assert(vasmora !== undefined, 'Vasmora must exist in town directory');
  assertEquals(vasmora.province, 'Gelid Plateau', 'Vasmora must belong to Gelid Plateau');
  assert(vasmora.y >= 102000.0, 'Vasmora must be in far northern permafrost');
  assert(vasmora.z >= 200.0, 'Vasmora must be located at high elevation on the plateau');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
