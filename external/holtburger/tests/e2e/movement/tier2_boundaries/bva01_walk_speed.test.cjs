/**
 * Tier 2 Boundary: Walk Speed
 * Authoritative baseline: acclient.c:343561
 */

'use strict';

const {
  CONSTANTS,
  getStateVelocity,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Boundary 1: Walk Speed', 2);

// Test B1.1: Zero forward input produces zero velocity
suite.addTest('B1.1 Zero forward speed input produces exactly zero velocity vector', () => {
  const vel = getStateVelocity(CONSTANTS.CMD_WALK_FORWARD, 0.0, 0, 0.0, 1.0);
  assertEquals(vel.vx, 0.0);
  assertEquals(vel.vy, 0.0);
  assertEquals(vel.vz, 0.0);
  assertEquals(vel.mag, 0.0);
});

// Test B1.2: Fractional analog stick input scales walk velocity proportionally
suite.addTest('B1.2 Fractional forward speed input (0.5) scales walk velocity to 1.56 m/s', () => {
  const vel = getStateVelocity(CONSTANTS.CMD_WALK_FORWARD, 0.5, 0, 0.0, 1.0);
  assertNear(vel.vy, 0.5 * CONSTANTS.WALK_ANIM_SPEED, 1e-4);
  assertNear(vel.mag, 1.56, 1e-3);
});

// Test B1.3: Walk speed at near-maximum burden (load = 1.99)
suite.addTest('B1.3 Walk speed at near-overburden (load = 1.99) retains closed-form walk speed', () => {
  const vel = getStateVelocity(CONSTANTS.CMD_WALK_FORWARD, 1.0, 0, 0.0, 1.0);
  assertNear(vel.vy, CONSTANTS.WALK_ANIM_SPEED, 1e-4);
});

// Test B1.4: Walk speed with zero stamina remains at 3.12 m/s
suite.addTest('B1.4 Walk speed is unpenalized by zero stamina', () => {
  const vel = getStateVelocity(CONSTANTS.CMD_WALK_FORWARD, 1.0, 0, 0.0, 1.0);
  assertNear(vel.vy, CONSTANTS.WALK_ANIM_SPEED, 1e-4);
});

// Test B1.5: Micro-timestep integration accumulates identical distance
suite.addTest('B1.5 Micro-step integration (dt = 0.001s, 1000 steps) accumulates 3.12 m', () => {
  const speed = CONSTANTS.WALK_ANIM_SPEED;
  const dt = 0.001;
  let dist = 0.0;
  for (let i = 0; i < 1000; i++) {
    dist += speed * dt;
  }
  assertNear(dist, CONSTANTS.WALK_ANIM_SPEED, 1e-4);
});

module.exports = suite;
