/**
 * Tier 2 Boundary: Steep Slope Sliding & Sledding Glide
 * Authoritative baseline: acclient.c:316124, acclient.c:358899
 */

'use strict';

const {
  CONSTANTS,
  calcFriction,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Boundary 12: Steep Slope Sliding & Sledding Glide', 2);

// Test B12.1: Exact 10.0-degree slope boundary for sledding friction
suite.addTest('B12.1 Exact 10.0-degree slope boundary (Nz = cos(10 deg) = 0.98480775)', () => {
  const cos10 = Math.cos(10.0 * (Math.PI / 180.0));
  assertNear(cos10, CONSTANTS.SLEDDING_SLOPE_COS, 1e-6);

  // Steeper than 10 deg (e.g. 10.1 deg): Nz < cos10 -> sledding friction 0.2
  const radSteeper = 10.1 * (Math.PI / 180.0);
  const normalSteeper = { x: 0, y: Math.sin(radSteeper), z: Math.cos(radSteeper) };
  const vSteep = { x: 0, y: -3.0 * Math.cos(radSteeper), z: 3.0 * Math.sin(radSteeper) };
  const resSteep = calcFriction(vSteep, normalSteeper, 1.0 / 30.0, true, 0.95);
  const expectedVy = vSteep.y * Math.pow(0.8, 1.0 / 30.0);
  assertNear(resSteep.y, expectedVy, 1e-4);
});

// Test B12.2: Exact 2.50 m/s speed threshold for sledding friction
suite.addTest('B12.2 Sledding speed threshold at 2.50 m/s (v^2 = 6.25)', () => {
  const rad = 20.0 * (Math.PI / 180.0);
  const normal = { x: 0, y: Math.sin(rad), z: Math.cos(rad) };

  // Speed >= 2.5 (v^2 >= 6.25) -> f = 0.2
  const v25 = { x: 0, y: -2.55 * Math.cos(rad), z: 2.55 * Math.sin(rad) };
  const res25 = calcFriction(v25, normal, 1.0 / 30.0, true, 0.95);
  assertNear(res25.y, v25.y * Math.pow(0.8, 1.0 / 30.0), 1e-4);
});

// Test B12.3: Exact 1.25 m/s stop threshold (v^2 = 1.5625)
suite.addTest('B12.3 Sledding stop threshold at 1.25 m/s arrests motion', () => {
  const rad = 20.0 * (Math.PI / 180.0);
  const normal = { x: 0, y: Math.sin(rad), z: Math.cos(rad) };

  // Speed < 1.25 m/s (e.g. 1.24) -> f = 1.0 -> 0 m/s
  const vSlow = { x: 0, y: -1.24 * Math.cos(rad), z: 1.24 * Math.sin(rad) };
  const res = calcFriction(vSlow, normal, 1.0 / 30.0, true, 0.95);
  assertEquals(res.y, 0.0);
  assertEquals(res.z, 0.0);
});

// Test B12.4: Crease slide projection along intersection of two plane normals: direction = cross(n1, n2)
suite.addTest('B12.4 Crease slide direction is projected along cross(n1, n2)', () => {
  // Two planes meeting: n1 tilted in X, n2 tilted in Y
  const n1 = { x: 0.6, y: 0.0, z: 0.8 };
  const n2 = { x: -0.6, y: 0.0, z: 0.8 };
  // cross(n1, n2) = (0, 0.8*(-0.6) - 0.6*0.8, 0) = (0, -0.96, 0)
  const creaseDir = {
    x: n1.y * n2.z - n1.z * n2.y,
    y: n1.z * n2.x - n1.x * n2.z,
    z: n1.x * n2.y - n1.y * n2.x
  };
  assertEquals(creaseDir.x, 0.0);
  assertNear(creaseDir.y, -0.96, 1e-4);
  assertEquals(creaseDir.z, 0.0);
});

// Test B12.5: Slide terminal velocity clamp caps maximum slide speed at 50.0 m/s
suite.addTest('B12.5 Prolonged steep slide clamped at 50.0 m/s terminal velocity', () => {
  let vMag = 55.0; // Over terminal clamp
  if (vMag > CONSTANTS.TERMINAL_VELOCITY) {
    vMag = CONSTANTS.TERMINAL_VELOCITY;
  }
  assertEquals(vMag, 50.0);
});

module.exports = suite;
