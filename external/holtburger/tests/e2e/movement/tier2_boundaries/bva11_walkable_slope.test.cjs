/**
 * Tier 2 Boundary: Walkable Slope Threshold
 * Authoritative baseline: acclient.c:800530, acclient.c:322600
 */

'use strict';

const {
  CONSTANTS,
  isWalkableSlope,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Boundary 11: Walkable Slope Threshold', 2);

// Test B11.1: Exact upper limit boundary: Nz = 0.664175 is walkable
suite.addTest('B11.1 Normal with Nz = 0.664175 (>= FLOOR_Z) is walkable', () => {
  const normal = { x: 0, y: Math.sqrt(1.0 - 0.664175 * 0.664175), z: 0.664175 };
  assertEquals(isWalkableSlope(normal), true);
});

// Test B11.2: Exact lower limit boundary: Nz = 0.664173 is non-walkable
suite.addTest('B11.2 Normal with Nz = 0.664173 (< FLOOR_Z) is non-walkable', () => {
  const normal = { x: 0, y: Math.sqrt(1.0 - 0.664173 * 0.664173), z: 0.664173 };
  assertEquals(isWalkableSlope(normal), false);
});

// Test B11.3: Vertical wall (Nz = 0.0, 90 deg) is non-walkable
suite.addTest('B11.3 Vertical wall normal (Nz = 0.0) is non-walkable', () => {
  const normal = { x: 1.0, y: 0.0, z: 0.0 };
  assertEquals(isWalkableSlope(normal), false);
});

// Test B11.4: Overhanging surface (Nz < 0.0) is non-walkable
suite.addTest('B11.4 Overhanging ceiling normal (Nz < 0.0) is non-walkable', () => {
  const normal = { x: 0.0, y: 0.0, z: -1.0 };
  assertEquals(isWalkableSlope(normal), false);
});

// Test B11.5: Unnormalized normal vectors are normalized before threshold comparison
suite.addTest('B11.5 Unnormalized surface normals are normalized before checking walkability', () => {
  // Normal with magnitude 10.0 and nz ratio 0.707 (45 deg)
  const unnormalizedWalkable = { x: 0.0, y: 7.071, z: 7.071 };
  assertEquals(isWalkableSlope(unnormalizedWalkable), true);

  // Normal with magnitude 10.0 and nz ratio 0.5 (60 deg)
  const unnormalizedSteep = { x: 0.0, y: 8.660, z: 5.0 };
  assertEquals(isWalkableSlope(unnormalizedSteep), false);
});

module.exports = suite;
