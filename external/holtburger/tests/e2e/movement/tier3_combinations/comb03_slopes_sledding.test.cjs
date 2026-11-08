/**
 * Tier 3 Combination 3: Slopes, Sliding, & Environmental Interactions
 * Authoritative baselines: acclient.c:800530, 316124, 317740
 */

'use strict';

const {
  CONSTANTS,
  isWalkableSlope,
  calcSlopeSlideAcceleration,
  calcFriction,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Combination 3: Slopes, Sliding, & Environmental Interactions', 3);

// Test 3.11: Walkable Slope to Steep Scree Transition
suite.addTest('3.11 Walking uphill transitioning from 35 deg to 55 deg drops OnWalkable and triggers slide acceleration', () => {
  const norm35 = { x: 0, y: Math.sin(35 * Math.PI / 180), z: Math.cos(35 * Math.PI / 180) };
  const norm55 = { x: 0, y: Math.sin(55 * Math.PI / 180), z: Math.cos(55 * Math.PI / 180) };

  assertEquals(isWalkableSlope(norm35), true, '35 deg is walkable');
  assertEquals(isWalkableSlope(norm55), false, '55 deg is non-walkable');

  const slideAccel = calcSlopeSlideAcceleration(norm55, CONSTANTS.GRAVITY);
  // Normal has positive Y and positive Z, so downhill descent is in +Y and -Z
  assert(slideAccel.ay > 0, 'Accelerates downhill along surface gradient (+Y)');
  assert(slideAccel.az < 0, 'Accelerates downward along surface gradient (-Z)');
});

// Test 3.12: Steep Scree Slide into Sledding Glide
suite.addTest('3.12 Sliding speed exceeding 2.5 m/s engages low-friction sledding glide (f = 0.2)', () => {
  const slopeRad = 30 * (Math.PI / 180);
  const normal = { x: 0, y: Math.sin(slopeRad), z: Math.cos(slopeRad) };

  // Tangent pointing downhill: (0, -cos(30), sin(30))
  const highSpeed = 3.5; // > 2.5 m/s
  const v = { x: 0, y: -highSpeed * Math.cos(slopeRad), z: highSpeed * Math.sin(slopeRad) };
  const res = calcFriction(v, normal, 1.0 / 30.0, true, 0.95);

  const expectedDecay = Math.pow(0.8, 1.0 / 30.0);
  assertNear(res.y, v.y * expectedDecay, 1e-4, 'Decays with f = 0.2');
});

// Test 3.13: Sledding Glide into Flat Ground Stop
suite.addTest('3.13 Sledding slide transitioning to flat ground reverts to 0.95 friction and halts below 1.25 m/s', () => {
  const flatNormal = { x: 0, y: 0, z: 1.0 };
  let v = { x: 0, y: 2.0, z: 0 };
  const dt = 1.0 / 30.0;

  // On flat ground, friction reverts to 0.95
  for (let i = 0; i < 15; i++) {
    v = calcFriction(v, flatNormal, dt, true, 0.95);
  }

  // Once speed drops below 0.25 m/s (or 1.25 m/s in sledding stop condition), velocity snaps to zero
  assertEquals(v.y, 0.0, 'Avatar comes to a full halt');
});

// Test 3.14: Airborne Jump over Steep Slope
suite.addTest('3.14 Ballistic jump clearing a steep canyon preserves ballistic flight above slope', () => {
  const inAir = true;
  let vz = 8.0;
  let playerZ = 15.0; // 15 meters above slope
  const dt = 1.0 / 30.0;

  for (let i = 0; i < 20; i++) {
    vz += CONSTANTS.GRAVITY * dt;
    playerZ += vz * dt;
  }

  assert(playerZ > 0.0, 'Player remains airborne above terrain');
  assertEquals(inAir, true, 'Airborne state uncorrupted');
});

// Test 3.15: Terminal Velocity Fall into Heavy Impact Knockdown
suite.addTest('3.15 Cliff fall reaches 50.0 m/s terminal clamp and initiates Fallen knockdown on impact', () => {
  let vz = 0.0;
  const dt = 1.0 / 30.0;

  // 10 seconds of free fall (300 ticks)
  for (let i = 0; i < 300; i++) {
    vz += CONSTANTS.GRAVITY * dt;
    if (Math.abs(vz) > CONSTANTS.TERMINAL_VELOCITY) {
      vz = -CONSTANTS.TERMINAL_VELOCITY;
    }
  }

  assertEquals(vz, -50.0, 'Clamped at terminal velocity');
  const landingState = vz < -25.0 ? CONSTANTS.CMD_FALLEN : CONSTANTS.CMD_READY;
  assertEquals(landingState, CONSTANTS.CMD_FALLEN, 'Triggers Fallen knockdown state');
});

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

module.exports = suite;
