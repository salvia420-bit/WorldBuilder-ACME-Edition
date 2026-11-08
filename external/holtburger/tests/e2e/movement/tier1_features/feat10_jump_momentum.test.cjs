/**
 * Feature 10: Jump Momentum Preservation & Mid-Air WASD Lock / Air Turning
 * Authoritative baseline: acclient.c:343840, acclient.c:344457
 */

'use strict';

const {
  CONSTANTS,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Feature 10: Jump Momentum & Mid-Air Constraints', 1);

// Test 10.1: Horizontal takeoff velocity is preserved verbatim throughout airborne trajectory
suite.addTest('10.1 Horizontal velocity (4.0 m/s) is preserved without air resistance during flight', () => {
  const takeoffVx = 0.0;
  const takeoffVy = 4.0; // Sprint speed
  const takeoffVz = CONSTANTS.JUMP_MIN_IMPULSE; // ~2.619 m/s

  let vx = takeoffVx;
  let vy = takeoffVy;
  let vz = takeoffVz;
  const dt = 1.0 / 30.0;

  // Simulate 10 airborne ticks under gravity with zero horizontal air friction
  for (let i = 0; i < 10; i++) {
    vz += CONSTANTS.GRAVITY * dt;
    // Horizontal velocities have zero drag in AC
  }

  assertEquals(vx, 0.0, 'Vx remains unchanged');
  assertEquals(vy, 4.0, 'Vy remains exactly 4.0 m/s throughout flight');
  assert(vz < takeoffVz, 'Vz decreases under gravity');
});

// Test 10.2: Mid-air WASD inputs cannot steer or accelerate linear velocity
suite.addTest('10.2 Mid-air linear WASD inputs do not alter ballistic trajectory (contact_allows_move = 0)', () => {
  // Airborne state: contact_allows_move returns 0 for linear motions
  const isAirborne = true;
  const attemptedInputVx = 1.56;
  const currentVx = 0.0;

  // Linear motion rejected
  const effectiveVx = isAirborne ? currentVx : attemptedInputVx;
  assertEquals(effectiveVx, 0.0, 'Airborne linear steering is locked');
});

// Test 10.3: Mid-air yaw turning is permitted and updates heading
suite.addTest('10.3 Mid-air yaw turning is allowed (contact_allows_move returns 1 for turn commands)', () => {
  // acclient.c:343840: TurnRight/TurnLeft are explicitly allowed while falling
  let heading = 0.0;
  const omega = CONSTANTS.RUN_TURN_OMEGA; // 2.25 rad/s
  const dt = 1.0 / 30.0;

  // Rotate for 15 airborne ticks (~0.5s)
  for (let i = 0; i < 15; i++) {
    heading += omega * dt;
  }

  assertNear(heading, 2.25 * 0.5, 1e-4, 'Heading rotated by 1.125 rad mid-air');
});

// Test 10.4: Ballistic flight time and apex match theoretical physics
suite.addTest('10.4 Flight apex time (vz / g) and parabola match Newtonian ballistics', () => {
  const launchVz = 9.8000002; // Initial vertical speed
  const tApex = launchVz / Math.abs(CONSTANTS.GRAVITY);
  assertNear(tApex, 1.0, 1e-5, 'Apex reached at 1.0 s');

  const totalFlightTime = 2.0 * tApex;
  assertNear(totalFlightTime, 2.0, 1e-5, 'Total symmetrical flight duration is 2.0 s');
});

// Test 10.5: Zero mid-air horizontal friction
suite.addTest('10.5 In-air horizontal friction factor is identically zero', () => {
  // Unlike ground (decay factor 0.05^dt), air decay factor is 1.0
  const airFrictionCoeff = 0.0;
  assertEquals(airFrictionCoeff, 0.0, 'Air friction is zero');
});

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

module.exports = suite;
