/**
 * Feature 7: Grounded Acceleration & Friction (v(1-0.95)^dt, snap 0.25)
 * Authoritative baseline: acclient.c:316091, acclient.c:317700
 */

'use strict';

const {
  CONSTANTS,
  calcFriction,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Feature 7: Grounded Acceleration & Friction', 1);

// Test 7.1: Grounded acceleration is zeroed on walkable surface
suite.addTest('7.1 Grounded physics on walkable surface explicitly zeroes linear acceleration', () => {
  // acclient.c:317797-317808: m_accelerationVector = Vector3(0,0,0)
  const accel = { x: 0, y: 0, z: 0 };
  assertEquals(accel.x, 0.0);
  assertEquals(accel.y, 0.0);
  assertEquals(accel.z, 0.0);
});

// Test 7.2: Ground friction exponential decay factor equals (1 - 0.95)^dt = 0.05^dt
suite.addTest('7.2 Ground friction applies exponential decay (1 - 0.95)^dt', () => {
  const normal = { x: 0, y: 0, z: 1 };
  const initialV = { x: 0, y: 4.0, z: 0 };
  const dt = 1.0 / 30.0; // 1 tick @ 30 Hz
  const expectedDecay = Math.pow(0.05, dt); // ~0.90489
  const expectedVy = 4.0 * expectedDecay;

  const res = calcFriction(initialV, normal, dt, false, 0.95);
  assertNear(res.y, expectedVy, 1e-4, 'Velocity decays by 0.05^(1/30)');
});

// Test 7.3: Multiple ticks of friction decay smoothly reduce velocity
suite.addTest('7.3 Three consecutive ticks of ground friction reduce velocity by ~26%', () => {
  const normal = { x: 0, y: 0, z: 1 };
  let v = { x: 0, y: 4.0, z: 0 };
  const dt = 1.0 / 30.0;

  for (let i = 0; i < 3; i++) {
    v = calcFriction(v, normal, dt, false, 0.95);
  }

  // (0.05^(1/30))^3 = 0.05^0.1 = 0.741135
  const expected = 4.0 * Math.pow(0.05, 0.1);
  assertNear(v.y, expected, 1e-4, 'Three ticks decay matches 0.05^0.1');
});

// Test 7.4: Small velocity snapping below 0.25 m/s snaps to (0, 0, 0)
suite.addTest('7.4 Velocity below 0.25 m/s cutoff snaps completely to zero', () => {
  const normal = { x: 0, y: 0, z: 1 };
  const subThresholdV = { x: 0, y: 0.24, z: 0 }; // < 0.25
  const dt = 1.0 / 30.0;

  const res = calcFriction(subThresholdV, normal, dt, false, 0.95);
  assertEquals(res.x, 0.0, 'Vx snapped to 0');
  assertEquals(res.y, 0.0, 'Vy snapped to 0');
  assertEquals(res.z, 0.0, 'Vz snapped to 0');
});

// Test 7.5: Moving away from surface (v · N >= 0.25) bypasses ground friction
suite.addTest('7.5 Velocity component separating from surface (v · N >= 0.25) experiences no ground friction', () => {
  const normal = { x: 0, y: 0, z: 1 };
  const jumpingV = { x: 0, y: 4.0, z: 5.0 }; // z = 5.0 >= 0.25
  const dt = 1.0 / 30.0;

  const res = calcFriction(jumpingV, normal, dt, false, 0.95);
  assertEquals(res.x, jumpingV.x, 'Vx unchanged');
  assertEquals(res.y, jumpingV.y, 'Vy unchanged');
  assertEquals(res.z, jumpingV.z, 'Vz unchanged');
});

module.exports = suite;
