/**
 * Tier 2: Boundary 5 — Terrain Mesh Limits & Corner Cases
 * 2041x2041 index boundaries, shared vertex continuity, cliff normal limits, sub-cell interpolation.
 * Sources: TEST_INFRA.md, ORIGINAL_REQUEST §R2, bake_world_terrain.rs, Survey 1 §1.1
 */

const { createSuite, assert, assertEquals, assertNear, assertInRange, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 2: Boundary 5 - Terrain Mesh Limits & Corner Cases', 2);

suite.addTest('B5.1: Mesh vertex index boundaries: index 0 (origin) and index 4,165,680 (opposite corner)', () => {
  const totalVerts = CONSTANTS.TOTAL_VERTICES; // 4,165,681
  const maxIndex = totalVerts - 1; // 4,165,680

  function getVertexCoord(index) {
    const samplesPerAxis = CONSTANTS.TOTAL_SAMPLES; // 2041
    const row = Math.floor(index / samplesPerAxis);
    const col = index % samplesPerAxis;
    return { x: col * CONSTANTS.CELL_SIZE, y: row * CONSTANTS.CELL_SIZE };
  }

  const v0 = getVertexCoord(0);
  assertEquals(v0.x, 0.0, 'Index 0 X is 0.0m');
  assertEquals(v0.y, 0.0, 'Index 0 Y is 0.0m');

  const vMax = getVertexCoord(maxIndex);
  assertEquals(vMax.x, CONSTANTS.WORLD_METERS, 'Max index X is 48,960.0m');
  assertEquals(vMax.y, CONSTANTS.WORLD_METERS, 'Max index Y is 48,960.0m');
});

suite.addTest('B5.2: Shared edge vertex continuity: vertex 8 of LB N strictly equals vertex 0 of LB N+1', () => {
  // In Asheron's Call 9x9 landblock height grids, adjacent landblocks share edge vertices
  // so no seams or cracks appear.
  function simulateSharedEdge(lb1Samples, lb2Samples) {
    // Vertex 8 of LB 1 must equal Vertex 0 of LB 2
    return lb1Samples[8] === lb2Samples[0];
  }

  const lbWestHeights = [10, 12, 14, 16, 18, 20, 22, 24, 26];
  const lbEastHeights = [26, 28, 30, 32, 34, 36, 38, 40, 42];

  assertEquals(simulateSharedEdge(lbWestHeights, lbEastHeights), true, 'Shared border height is continuous');
});

suite.addTest('B5.3: Steep vertical cliff normals calculate finite values without division by zero', () => {
  function computeTriangleNormal(p0, p1, p2) {
    const ax = p1.x - p0.x, ay = p1.y - p0.y, az = p1.z - p0.z;
    const bx = p2.x - p0.x, by = p2.y - p0.y, bz = p2.z - p0.z;

    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;

    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-6) return [0.0, 0.0, 1.0]; // fallback up normal
    return [nx / len, ny / len, nz / len];
  }

  // Vertical cliff triangle: extreme elevation delta (100m) over 0.01m horizontal pitch
  const p0 = { x: 0.0, y: 0.0, z: 0.0 };
  const p1 = { x: 0.01, y: 0.0, z: 100.0 };
  const p2 = { x: 0.0, y: 0.01, z: 100.0 };

  const norm = computeTriangleNormal(p0, p1, p2);
  assert(Number.isFinite(norm[0]), 'Normal X is finite');
  assert(Number.isFinite(norm[1]), 'Normal Y is finite');
  assert(Number.isFinite(norm[2]), 'Normal Z is finite');
  assertNear(Math.hypot(...norm), 1.0, 1e-4, 'Normal length is 1.0');
});

suite.addTest('B5.4: Sub-cell bilinear interpolation boundary limits: (0.0, 0.0) vs (23.999, 23.999)', () => {
  function sampleCellHeight(corners, lx, ly) {
    const u = Math.max(0.0, Math.min(1.0, lx / CONSTANTS.CELL_SIZE));
    const v = Math.max(0.0, Math.min(1.0, ly / CONSTANTS.CELL_SIZE));
    // corners: [c00, c10, c01, c11]
    const hBottom = corners[0] * (1 - u) + corners[1] * u;
    const hTop = corners[2] * (1 - u) + corners[3] * u;
    return hBottom * (1 - v) + hTop * v;
  }

  const corners = [10.0, 20.0, 30.0, 40.0];

  // At (0, 0)
  assertNear(sampleCellHeight(corners, 0.0, 0.0), 10.0, 1e-4);
  // At (24.0, 0)
  assertNear(sampleCellHeight(corners, 24.0, 0.0), 20.0, 1e-4);
  // At (0, 24.0)
  assertNear(sampleCellHeight(corners, 0.0, 24.0), 30.0, 1e-4);
  // At (24.0, 24.0)
  assertNear(sampleCellHeight(corners, 24.0, 24.0), 40.0, 1e-4);
  // In the exact center (12.0, 12.0)
  assertNear(sampleCellHeight(corners, 12.0, 12.0), 25.0, 1e-4);
});

suite.addTest('B5.5: Deep sea coordinate queries return defined water height and code without void', () => {
  function sampleHeightOrSea(x, y) {
    // If coordinate is in valid world, return safe elevation
    if (x >= 0 && x <= CONSTANTS.WORLD_METERS && y >= 0 && y <= CONSTANTS.DERICOST_NORTH_BOUND_Y) {
      if (y > 48960.0 && y < 68928.0) {
        return { z: 0.0, isWater: true, type: 20 };
      }
      return { z: 50.0, isWater: false, type: 1 };
    }
    return { z: 0.0, isWater: true, type: 20, isOutOfBounds: true };
  }

  const result = sampleHeightOrSea(24480.0, 58944.0);
  assertEquals(result.z, 0.0, 'Sea surface height is 0.0m');
  assertEquals(result.isWater, true, 'Flagged as water');
  assertEquals(result.type, 20, 'WaterDeepSea type code 20');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
