/**
 * Tier 2 Boundary: Grounded Acceleration & Friction
 * Authoritative baseline: acclient.c:316091, acclient.c:317750
 */

'use strict';

const {
  CONSTANTS,
  calcFriction,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Boundary 7: Grounded Acceleration & Friction', 2);

// Test B7.1: Velocity snapping right at 0.250001 vs 0.249999
suite.addTest('B7.1 Sharp threshold cutoff at 0.25 m/s: above decays, below snaps to zero', () => {
  const normal = { x: 0, y: 0, z: 1 };
  const dt = 1.0 / 30.0;

  // Below cutoff
  const vBelow = { x: 0, y: 0.2499, z: 0 };
  const resBelow = calcFriction(vBelow, normal, dt, false, 0.95);
  assertEquals(resBelow.y, 0.0, 'Snaps to 0 below 0.25 m/s');

  // Above cutoff: 0.25^2 = 0.0625; let's use 0.35 so that after decay it stays above snap threshold
  // 0.35 * 0.90489 = 0.3167 > 0.25
  const vAbove = { x: 0, y: 0.35, z: 0 };
  const resAbove = calcFriction(vAbove, normal, dt, false, 0.95);
  assert(resAbove.y > 0.25, 'Above threshold decays without snapping');
});

// Test B7.2: Separating velocity exactly at 0.25 vs 0.24
suite.addTest('B7.2 v · N >= 0.25 early-outs without friction; v · N < 0.25 strips normal', () => {
  const normal = { x: 0, y: 0, z: 1 };
  const dt = 1.0 / 30.0;

  // Exactly 0.25 separating: early out
  const vSep = { x: 0, y: 2.0, z: 0.25 };
  const resSep = calcFriction(vSep, normal, dt, false, 0.95);
  assertEquals(resSep.z, 0.25, 'Separating normal preserved');
  assertEquals(resSep.y, 2.0, 'Tangent un-decayed');

  // Below 0.25 separating: normal stripped
  const vContact = { x: 0, y: 2.0, z: 0.20 };
  const resContact = calcFriction(vContact, normal, dt, false, 0.95);
  assertEquals(resContact.z, 0.0, 'Normal component stripped');
});

// Test B7.3: Zero timestep dt = 0 leaves velocity unchanged
suite.addTest('B7.3 Zero timestep dt = 0 leaves velocity completely unchanged (0.05^0 = 1.0)', () => {
  const normal = { x: 0, y: 0, z: 1 };
  const v = { x: 0, y: 3.5, z: 0 };
  const res = calcFriction(v, normal, 0.0, false, 0.95);
  assertEquals(res.y, 3.5);
});

// Test B7.4: Large timestep dt = 0.2s (MAX_QUANTUM) decays stably without going negative
suite.addTest('B7.4 Large timestep dt = 0.2s (MAX_QUANTUM) produces stable non-negative decay', () => {
  const normal = { x: 0, y: 0, z: 1 };
  const v = { x: 0, y: 4.0, z: 0 };
  const res = calcFriction(v, normal, 0.2, false, 0.95);
  const expected = 4.0 * Math.pow(0.05, 0.2);
  assertNear(res.y, expected, 1e-4);
  assert(res.y > 0.0, 'Positive decayed velocity');
});

// Test B7.5: Zero initial velocity stays at 0 indefinitely
suite.addTest('B7.5 Zero initial velocity remains zero across repeated friction steps', () => {
  const normal = { x: 0, y: 0, z: 1 };
  let v = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 10; i++) {
    v = calcFriction(v, normal, 1.0 / 30.0, false, 0.95);
  }
  assertEquals(v.x, 0.0);
  assertEquals(v.y, 0.0);
  assertEquals(v.z, 0.0);
});

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

module.exports = suite;
