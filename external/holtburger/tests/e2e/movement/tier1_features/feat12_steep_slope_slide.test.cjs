/**
 * Feature 12: Steep Slope Sliding (Nz < 0.664174) & Sledding Glide (f=0.2)
 * Authoritative baseline: acclient.c:316124, acclient.c:358899
 */

'use strict';

const {
  CONSTANTS,
  calcSlopeSlideAcceleration,
  calcFriction,
  assertNear,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Feature 12: Steep Slope Sliding & Sledding Glide', 1);

// Test 12.1: Sliding downhill on 60-degree slope accelerates down the surface tangent
suite.addTest('12.1 Slide acceleration on 60-degree slope directs along tangent', () => {
  const theta = 60.0 * (Math.PI / 180.0);
  // Normal sloping up in +Y: Normal = (0, -sin(theta), cos(theta))
  const normal = { x: 0, y: -Math.sin(theta), z: Math.cos(theta) };
  const accel = calcSlopeSlideAcceleration(normal, CONSTANTS.GRAVITY);

  // Incline descends in -Y, so acceleration should have negative Y and negative Z components
  assert(accel.ay < 0, 'ay must accelerate downhill');
  assert(accel.az < 0, 'az must accelerate downward');
  assertEquals(accel.ax, 0.0, 'ax is zero on 2D pitch');
});

// Test 12.2: Tangential acceleration magnitude matches g * sin(theta)
suite.addTest('12.2 Tangential slide acceleration magnitude equals g * sin(theta)', () => {
  const theta = 60.0 * (Math.PI / 180.0);
  const normal = { x: 0, y: -Math.sin(theta), z: Math.cos(theta) };
  const accel = calcSlopeSlideAcceleration(normal, CONSTANTS.GRAVITY);

  const mag = Math.sqrt(accel.ax * accel.ax + accel.ay * accel.ay + accel.az * accel.az);
  const expectedMag = Math.abs(CONSTANTS.GRAVITY) * Math.sin(theta);
  assertNear(mag, expectedMag, 1e-4, 'Slide acceleration magnitude matches g * sin(theta)');
});

// Test 12.3: Sledding friction f = 0.2 applies on slopes > 10 deg when speed >= 2.5 m/s
suite.addTest('12.3 High-speed slide (v >= 2.5 m/s) on slope > 10 deg uses sledding friction f = 0.2', () => {
  const slopeRad = 30.0 * (Math.PI / 180.0);
  const normal = { x: 0, y: Math.sin(slopeRad), z: Math.cos(slopeRad) };
  // Tangent perpendicular to normal: (0, -cos(theta), sin(theta)) -> dot product = 0
  const speed = 3.0; // >= 2.5 m/s
  const v = { x: 0, y: -speed * Math.cos(slopeRad), z: speed * Math.sin(slopeRad) };
  const dt = 1.0 / 30.0;

  const res = calcFriction(v, normal, dt, true, 0.95);
  // Expected decay = (1.0 - 0.2)^dt = 0.8^dt
  const expectedVy = v.y * Math.pow(0.8, dt);
  const expectedVz = v.z * Math.pow(0.8, dt);
  assertNear(res.y, expectedVy, 1e-4, 'Sledding decay Vy matches 0.8^dt');
  assertNear(res.z, expectedVz, 1e-4, 'Sledding decay Vz matches 0.8^dt');
});

// Test 12.4: Slide speed below 1.25 m/s triggers full stop friction f = 1.0
suite.addTest('12.4 Sledding slide speed below 1.25 m/s triggers immediate full stop (f = 1.0)', () => {
  const slopeRad = 30.0 * (Math.PI / 180.0);
  const normal = { x: 0, y: Math.sin(slopeRad), z: Math.cos(slopeRad) };
  const speed = 1.20; // 1.20 m/s < 1.25 m/s
  const subV = { x: 0, y: -speed * Math.cos(slopeRad), z: speed * Math.sin(slopeRad) };
  const dt = 1.0 / 30.0;

  const res = calcFriction(subV, normal, dt, true, 0.95);
  assertEquals(res.y, 0.0, 'Arrests motion Vy to 0 m/s');
  assertEquals(res.z, 0.0, 'Arrests motion Vz to 0 m/s');
});

// Test 12.5: Sledding on flat ground (Nz >= cos(10 deg)) reverts to default 0.95 friction
suite.addTest('12.5 Sledding state on flat ground reverts to default friction (0.95)', () => {
  const flatNormal = { x: 0, y: 0, z: 1.0 }; // Nz = 1.0 >= cos(10 deg)
  const v = { x: 0, y: 3.0, z: 0 };
  const dt = 1.0 / 30.0;

  const res = calcFriction(v, flatNormal, dt, true, 0.95);
  const expectedVy = v.y * Math.pow(0.05, dt);
  assertNear(res.y, expectedVy, 1e-4, 'Reverts to 0.95 ground friction');
});

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

module.exports = suite;
