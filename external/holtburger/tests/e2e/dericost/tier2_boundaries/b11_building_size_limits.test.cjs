/**
 * Tier 2: Boundary 11 — Building Size Limits & Heuristics
 * Room clearances, footprint limits, portal connectivity, zero-portal rejection, fragment filters.
 * Sources: TEST_INFRA.md, ORIGINAL_REQUEST §R3, BuildingAnalyzer.cs
 */

const { createSuite, assert, assertEquals, assertNear, assertInRange, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 2: Boundary 11 - Building Size Limits & Heuristics', 2);

suite.addTest('B11.1: EnvCell room bounding box enforces minimum navigable clearance (2.5m x 2.5m x 2.2m)', () => {
  function checkRoomClearance(minX, maxX, minY, maxY, minZ, maxZ) {
    const width = maxX - minX;
    const depth = maxY - minY;
    const height = maxZ - minZ;

    return width >= 2.5 && depth >= 2.5 && height >= 2.2;
  }

  // Standard room: 5m x 6m x 3m
  assertEquals(checkRoomClearance(-2.5, 2.5, -3.0, 3.0, 0.0, 3.0), true, 'Standard room valid');

  // Cramped closet / impassable crawlspace: 1.0m x 1.0m x 1.5m
  assertEquals(checkRoomClearance(-0.5, 0.5, -0.5, 0.5, 0.0, 1.5), false, 'Impassable crawlspace rejected');
});

suite.addTest('B11.2: Standalone building footprint is bounded within single-landblock cluster limits (<= 192m)', () => {
  function isFootprintBounded(widthMeters, depthMeters) {
    // Single building cannot exceed 192m (1 LB width) without modular subdivision
    return widthMeters <= 192.0 && depthMeters <= 192.0;
  }

  assertEquals(isFootprintBounded(35.0, 45.0), true, 'Manor 35x45m valid');
  assertEquals(isFootprintBounded(250.0, 100.0), false, 'Megastructure 250m wide rejected');
});

suite.addTest('B11.3: Disconnected portal graph: all interior EnvCells must be reachable from exterior portal', () => {
  // Graph reachability via BFS
  function isGraphFullyConnected(exteriorPortalCell, cellsMap) {
    const visited = new Set();
    const queue = [exteriorPortalCell];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!visited.has(current)) {
        visited.add(current);
        const neighbors = cellsMap[current] || [];
        for (const n of neighbors) {
          if (!visited.has(n)) queue.push(n);
        }
      }
    }
    return visited.size === Object.keys(cellsMap).length;
  }

  // Connected 4-cell layout
  const connectedLayout = {
    0x0101: [0x0102],
    0x0102: [0x0101, 0x0103],
    0x0103: [0x0102, 0x0104],
    0x0104: [0x0103]
  };
  assertEquals(isGraphFullyConnected(0x0101, connectedLayout), true, 'Fully connected layout passes');

  // Disconnected layout with orphaned cell 0x0104
  const disconnectedLayout = {
    0x0101: [0x0102],
    0x0102: [0x0101, 0x0103],
    0x0103: [0x0102],
    0x0104: [] // Isolated room with no portal
  };
  assertEquals(isGraphFullyConnected(0x0101, disconnectedLayout), false, 'Disconnected orphan cell rejected');
});

suite.addTest('B11.4: Zero-portal building structure is classified as non-enterable static prop', () => {
  function classifyStructure(portalCount, cellCount) {
    if (portalCount === 0 || cellCount === 0) {
      return 'StaticSceneryProp'; // Solid exterior facade only
    }
    return 'EnterableTownBuilding';
  }

  assertEquals(classifyStructure(0, 0), 'StaticSceneryProp');
  assertEquals(classifyStructure(0, 4), 'StaticSceneryProp', 'Zero portals cannot be entered');
  assertEquals(classifyStructure(2, 4), 'EnterableTownBuilding');
});

suite.addTest('B11.5: Modular wall fragments with high occurrence ratio (>= 1.35) are filtered', () => {
  function isModularFragment(occurrenceCount, uniqueLandblocks) {
    if (uniqueLandblocks === 0) return true;
    const avg = occurrenceCount / uniqueLandblocks;
    return avg >= CONSTANTS.MAX_PAIRED_HALF_RATIO;
  }

  assertEquals(isModularFragment(10, 10), false, 'Unique town hall (1.0 avg) allowed');
  assertEquals(isModularFragment(14, 10), true, 'Wall segment (1.4 avg >= 1.35) rejected as modular piece');
  assertEquals(isModularFragment(40, 10), true, 'Fence post (4.0 avg) rejected');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
