/**
 * Feature 11: Walkable Slope Threshold (Nz >= 0.664174 / 48.38 deg)
 * Authoritative baseline: acclient.c:800530, acclient.c:316502
 */

'use strict';

const {
  CONSTANTS,
  isWalkableSlope,
  assertEquals,
  assertNear
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Feature 11: Walkable Slope Threshold', 1);

// Test 11.1: Flat horizontal ground (Nz = 1.0, 0 deg) is walkable
suite.addTest('11.1 Flat horizontal ground (Nz=1.0) is walkable', () => {
  const normal = { x: 0, y: 0, z: 1.0 };
  assertEquals(isWalkableSlope(normal), true, 'Flat ground is walkable');
});

// Test 11.2: Gentle 30-degree slope (Nz = cos(30 deg) = 0.8660) is walkable
suite.addTest('11.2 30-degree slope (Nz ~ 0.8660) is walkable', () => {
  const rad = 30.0 * (Math.PI / 180.0);
  const normal = { x: Math.sin(rad), y: 0, z: Math.cos(rad) };
  assertEquals(isWalkableSlope(normal), true, '30 deg slope is walkable');
});

// Test 11.3: 45-degree slope (Nz = cos(45 deg) = 0.7071) is walkable
suite.addTest('11.3 45-degree slope (Nz ~ 0.7071) is walkable', () => {
  const rad = 45.0 * (Math.PI / 180.0);
  const normal = { x: 0, y: Math.sin(rad), z: Math.cos(rad) };
  assertEquals(isWalkableSlope(normal), true, '45 deg slope is walkable');
});

// Test 11.4: 48-degree slope (Nz = cos(48 deg) = 0.66913 > 0.664174) is walkable
suite.addTest('11.4 48-degree slope (Nz ~ 0.66913) is walkable', () => {
  const rad = 48.0 * (Math.PI / 180.0);
  const normal = { x: Math.sin(rad), y: 0, z: Math.cos(rad) };
  assertEquals(isWalkableSlope(normal), true, '48 deg slope is walkable');
});

// Test 11.5: 49-degree slope (Nz = cos(49 deg) = 0.65606 < 0.664174) is NOT walkable
suite.addTest('11.5 49-degree slope (Nz ~ 0.65606) is NOT walkable (triggers slide/falling)', () => {
  const rad = 49.0 * (Math.PI / 180.0);
  const normal = { x: Math.sin(rad), y: 0, z: Math.cos(rad) };
  assertEquals(isWalkableSlope(normal), false, '49 deg slope must NOT be walkable');
});

module.exports = suite;
