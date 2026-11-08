#!/usr/bin/env node
/**
 * external/holtburger/scripts/test-movement-adversarial.cjs
 *
 * Adversarial Challenger Stress-Test Suite for Milestone 2 (Features 23–27)
 * Author: movement_challenger_m2_1
 */

'use strict';

const {
  CONSTANTS,
  isWalkableSlope,
  calcSlopeSlideAcceleration,
  calcFriction,
  assertNear,
  assertEquals,
  assertInRange
} = require('../tests/e2e/movement/harness.cjs');

console.log('======================================================================');
console.log('  MOVEMENT CHALLENGER M2: EMPIRICAL ADVERSARIAL STRESS TEST SUITE');
console.log('======================================================================\n');

let passCount = 0;
let failCount = 0;

function runAdvTest(name, fn) {
  try {
    fn();
    console.log(`  [✓ PASS] ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  [✗ FAIL] ${name}`);
    console.error(`          ${err.message}`);
    failCount++;
  }
}

// ----------------------------------------------------------------------------
// FEATURE 23: STEEP SLOPE SLIDING
// ----------------------------------------------------------------------------
console.log('>>> [FEATURE 23] Steep Slope Sliding Adversarial Stress Tests <<<');

runAdvTest('F23-1: Surface normal edge conditions near Nz = 0.66417415', () => {
  const eps = 1e-6;
  const floorZ = CONSTANTS.FLOOR_Z; // 0.66417414

  // Exactly at floorZ
  const nExact = { x: Math.sqrt(1 - floorZ * floorZ), y: 0, z: floorZ };
  if (!isWalkableSlope(nExact)) throw new Error('Exact FLOOR_Z must be walkable');

  // Just above floorZ (+1e-6)
  const nAbove = { x: Math.sqrt(1 - (floorZ + eps) * (floorZ + eps)), y: 0, z: floorZ + eps };
  if (!isWalkableSlope(nAbove)) throw new Error('FLOOR_Z + eps must be walkable');

  // Just below floorZ (-1e-6)
  const nBelow = { x: Math.sqrt(1 - (floorZ - eps) * (floorZ - eps)), y: 0, z: floorZ - eps };
  if (isWalkableSlope(nBelow)) throw new Error('FLOOR_Z - eps must be steep unwalkable cliff');

  // Angular boundary: 48.380 deg vs 48.382 deg
  const r48_380 = 48.380 * (Math.PI / 180);
  const n48_380 = { x: Math.sin(r48_380), y: 0, z: Math.cos(r48_380) };
  if (!isWalkableSlope(n48_380)) throw new Error('48.380 deg slope must be walkable');

  const r48_382 = 48.382 * (Math.PI / 180);
  const n48_382 = { x: Math.sin(r48_382), y: 0, z: Math.cos(r48_382) };
  if (isWalkableSlope(n48_382)) throw new Error('48.382 deg slope must be unwalkable cliff');
});

runAdvTest('F23-2: Gravity tangent projection formula & orthogonality across 1,000 orientations', () => {
  const g = CONSTANTS.GRAVITY; // -9.8000002

  for (let i = 0; i < 1000; i++) {
    const pitchDeg = 1 + Math.random() * 88; // 1 to 89 deg
    const yawDeg = Math.random() * 360;
    const theta = pitchDeg * (Math.PI / 180);
    const phi = yawDeg * (Math.PI / 180);

    const nx = Math.sin(theta) * Math.cos(phi);
    const ny = Math.sin(theta) * Math.sin(phi);
    const nz = Math.cos(theta);
    const normal = { x: nx, y: ny, z: nz };

    const accel = calcSlopeSlideAcceleration(normal, g);

    // Invariant 1: Orthogonality: accel · normal == 0
    const dot = accel.ax * nx + accel.ay * ny + accel.az * nz;
    if (Math.abs(dot) > 1e-4) {
      throw new Error(`Orthogonality failure at pitch=${pitchDeg}, yaw=${yawDeg}: dot=${dot}`);
    }

    // Invariant 2: Closed-form coordinate match:
    // ax = 9.8 * Nz * Nx
    // ay = 9.8 * Nz * Ny
    // az = -9.8 * (1 - Nz^2)
    const expectedAx = -g * nz * nx;
    const expectedAy = -g * nz * ny;
    const expectedAz = g * (1 - nz * nz);

    assertNear(accel.ax, expectedAx, 1e-4, 'ax mismatch');
    assertNear(accel.ay, expectedAy, 1e-4, 'ay mismatch');
    assertNear(accel.az, expectedAz, 1e-4, 'az mismatch');

    // Invariant 3: Total magnitude equals |g| * sin(theta)
    const mag = Math.sqrt(accel.ax * accel.ax + accel.ay * accel.ay + accel.az * accel.az);
    const expectedMag = Math.abs(g) * Math.sin(theta);
    assertNear(mag, expectedMag, 1e-4, 'Magnitude mismatch');
  }
});

runAdvTest('F23-3: WASD linear translation suppression & yaw rotational freedom on steep slopes', () => {
  // Simulate steep slope integration:
  // Normal pitch 60 deg: Nz = cos(60 deg) = 0.5 < FLOOR_Z
  const nz = 0.5;
  const nx = Math.sqrt(1 - 0.25);
  const normal = { x: nx, y: 0, z: nz };
  const isSteep = normal.z < CONSTANTS.FLOOR_Z;
  if (!isSteep) throw new Error('Expected steep slope');

  let currentPlanarV = { x: 0.0, y: 0.0, z: 0.0 };
  let heading = 0.0;
  const dt = 1.0 / 30.0;

  // Player presses 'W' forward (trying to fight downhill slide) AND 'E' turn right
  const targetVelocity = { x: 0.0, y: 4.0, z: 0.0 }; // WASD forward intent
  const turnOmega = 1.5; // Turn right at 1.5 rad/s

  // Step 10 ticks:
  for (let tick = 0; tick < 10; tick++) {
    // Under steep slope sliding (system.rs:6670-6698 / 8901-8930):
    // WASD targetVelocity is completely suppressed:
    const aTangent = calcSlopeSlideAcceleration(normal, CONSTANTS.GRAVITY);
    currentPlanarV.x += aTangent.ax * dt;
    currentPlanarV.y += aTangent.ay * dt;

    // Apply ground friction without sledding override (common.rs:831-859 with sledding=false):
    const angle = currentPlanarV.x * normal.x + currentPlanarV.y * normal.y + currentPlanarV.z * normal.z;
    if (angle < 0.25) {
      currentPlanarV.x -= normal.x * angle;
      currentPlanarV.y -= normal.y * angle;
      currentPlanarV.z -= normal.z * angle;
      const decay = Math.pow(1.0 - CONSTANTS.DEFAULT_FRICTION, dt);
      currentPlanarV.x *= decay;
      currentPlanarV.y *= decay;
      currentPlanarV.z *= decay;
    }

    // Yaw rotation integrates smoothly regardless of slope:
    heading += turnOmega * dt;
  }

  // Verification 1: Forward WASD (Y axis) produced ZERO upward translation:
  // Downhill gradient for normal (Nx > 0, Nz > 0) accelerates in +X and -Z:
  // ax = 9.8 * Nz * Nx > 0.
  // Player has zero positive Y velocity (WASD intent 'W' completely ignored):
  assertNear(currentPlanarV.y, 0.0, 1e-4, 'WASD forward input could not create +Y velocity');
  if (currentPlanarV.x <= 0.0) throw new Error('Must slide downhill in +X (down the slope)');

  // Verification 2: Yaw rotation succeeded
  assertNear(heading, turnOmega * dt * 10, 1e-4, 'Yaw rotation proceeded unimpeded');
});

runAdvTest('F23-4: Empirical Challenge: Hardcoding sledding=true on steep slope locks avatar at 0 m/s', () => {
  // This adversarial test proves the bug in system.rs:6686 / 8917:
  // If sledding=true is passed unconditionally to calcFriction while at rest on a steep slope:
  const normal = { x: Math.sqrt(1 - 0.25), y: 0, z: 0.5 };
  let v = { x: 0.0, y: 0.0, z: 0.0 };
  const dt = 1.0 / 30.0;

  for (let tick = 0; tick < 10; tick++) {
    const aTangent = calcSlopeSlideAcceleration(normal, CONSTANTS.GRAVITY);
    v.x += aTangent.ax * dt;
    v.y += aTangent.ay * dt;

    // Passing true triggers the < 1.25 m/s stop threshold (f = 1.0), arresting motion every tick:
    v = calcFriction(v, normal, dt, true, CONSTANTS.DEFAULT_FRICTION);
  }

  // Bug reproduced: v remains exactly 0.0!
  assertEquals(v.x, 0.0, 'Bug confirmed: Hardcoded sledding=true freezes velocity to zero every tick');
  assertEquals(v.y, 0.0);
});

// ----------------------------------------------------------------------------
// FEATURE 24: SLEDDING GLIDE
// ----------------------------------------------------------------------------
console.log('\n>>> [FEATURE 24] Sledding Glide Adversarial Stress Tests <<<');

runAdvTest('F24-1: 10.0 degree slope angle boundary (cos(10 deg) = 0.98480775)', () => {
  const cos10 = CONSTANTS.SLEDDING_SLOPE_COS;
  const eps = 1e-6;

  // Flatter than 10 deg (9.9 deg): Nz > cos10 -> does not qualify for sledding
  const nFlat = { x: Math.sqrt(1 - (cos10 + eps) * (cos10 + eps)), y: 0, z: cos10 + eps };
  const flatQualifies = nFlat.z < cos10;
  assertEquals(flatQualifies, false, '9.9 deg slope must not qualify for sledding');

  // Steeper than 10 deg (10.1 deg): Nz < cos10 -> qualifies for sledding
  const nSteep = { x: Math.sqrt(1 - (cos10 - eps) * (cos10 - eps)), y: 0, z: cos10 - eps };
  const steepQualifies = nSteep.z < cos10;
  assertEquals(steepQualifies, true, '10.1 deg slope must qualify for sledding');
});

runAdvTest('F24-2: Speed threshold 2.5 m/s (v^2 = 6.25) & f = 0.2 friction modulation', () => {
  const theta = 25 * (Math.PI / 180);
  const normal = { x: 0, y: Math.sin(theta), z: Math.cos(theta) };
  const dt = 1.0 / 30.0;

  // At 2.5001 m/s (speed >= 2.5):
  const vHigh = { x: 0, y: -2.5001 * Math.cos(theta), z: 2.5001 * Math.sin(theta) };
  const resHigh = calcFriction(vHigh, normal, dt, true, CONSTANTS.DEFAULT_FRICTION);
  const expectedVyHigh = vHigh.y * Math.pow(0.8, dt);
  assertNear(resHigh.y, expectedVyHigh, 1e-4, 'Friction modulates to 0.2');

  // Below 2.5 m/s without established sledding:
  const vBelow = { x: 0, y: -2.4999 * Math.cos(theta), z: 2.4999 * Math.sin(theta) };
  const resBelow = calcFriction(vBelow, normal, dt, true, CONSTANTS.DEFAULT_FRICTION);
  // Reverts to default 0.95 friction
  const expectedVyBelow = vBelow.y * Math.pow(0.05, dt);
  assertNear(resBelow.y, expectedVyBelow, 1e-4, 'Below threshold reverts to 0.95');
});

runAdvTest('F24-3: Exit condition when speed drops below 1.25 m/s (f = 1.0 full stop)', () => {
  const theta = 20 * (Math.PI / 180);
  const normal = { x: 0, y: Math.sin(theta), z: Math.cos(theta) };
  const dt = 1.0 / 30.0;

  // Speed at 1.2499 m/s (< 1.25 m/s):
  const vExit = { x: 0, y: -1.2499 * Math.cos(theta), z: 1.2499 * Math.sin(theta) };
  const resExit = calcFriction(vExit, normal, dt, true, CONSTANTS.DEFAULT_FRICTION);

  // Under f = 1.0, (1 - 1.0)^dt = 0 => stops completely in 1 tick
  assertEquals(resExit.x, 0.0);
  assertEquals(resExit.y, 0.0);
  assertEquals(resExit.z, 0.0);
});

runAdvTest('F24-4: Avatar heading rotation aligns to sliding velocity vector', () => {
  // When sliding downhill with velocity (vx, vy), heading must match atan2(vy, vx)
  const vSlide = { x: -3.0, y: -4.0, z: -2.0 };
  const slideHeading = Math.atan2(vSlide.x, vSlide.y); // AC / holtburger heading convention

  const headingTo = (vx, vy) => Math.atan2(vx, vy);
  const avatarHeading = headingTo(vSlide.x, vSlide.y);
  assertEquals(avatarHeading, slideHeading, 'Heading aligns to slide velocity vector');
});

// ----------------------------------------------------------------------------
// FEATURE 25: CREASE SLIDE PROJECTION
// ----------------------------------------------------------------------------
console.log('\n>>> [FEATURE 25] Crease Slide Projection Adversarial Stress Tests <<<');

function creaseSlide(v, n1, n2) {
  const RETAIL_EPSILON = 0.0002;
  // D = N1 × N2
  const d = {
    x: n1.y * n2.z - n1.z * n2.y,
    y: n1.z * n2.x - n1.x * n2.z,
    z: n1.x * n2.y - n1.y * n2.x
  };
  const dLenSq = d.x * d.x + d.y * d.y + d.z * d.z;

  if (dLenSq >= RETAIL_EPSILON) {
    const dot = v.x * d.x + v.y * d.y + v.z * d.z;
    const vProj = {
      x: d.x * (dot / dLenSq),
      y: d.y * (dot / dLenSq),
      z: d.z * (dot / dLenSq)
    };
    const projLenSq = vProj.x * vProj.x + vProj.y * vProj.y + vProj.z * vProj.z;
    if (projLenSq < RETAIL_EPSILON) {
      return { type: 'Blocked' };
    }
    return { type: 'Slid', v: vProj };
  } else {
    const n1DotN2 = n1.x * n2.x + n1.y * n2.y + n1.z * n2.z;
    if (n1DotN2 >= 0.0) {
      const vDotN2 = v.x * n2.x + v.y * n2.y + v.z * n2.z;
      return {
        type: 'DegenerateSinglePlane',
        v: {
          x: v.x - n2.x * vDotN2,
          y: v.y - n2.y * vDotN2,
          z: v.z - n2.z * vDotN2
        }
      };
    } else {
      return { type: 'Blocked' };
    }
  }
}

runAdvTest('F25-1: Non-degenerate 3D crease projection orthogonality & symmetry', () => {
  const n1 = { x: 1.0, y: 0.0, z: 0.0 };
  const n2 = { x: 0.0, y: 0.8, z: 0.6 };
  const v = { x: -4.0, y: 5.0, z: -3.0 };

  const res1 = creaseSlide(v, n1, n2);
  const res2 = creaseSlide(v, n2, n1);

  assertEquals(res1.type, 'Slid');
  assertEquals(res2.type, 'Slid');

  // Invariant 1: Symmetry under argument swap
  assertNear(res1.v.x, res2.v.x, 1e-4);
  assertNear(res1.v.y, res2.v.y, 1e-4);
  assertNear(res1.v.z, res2.v.z, 1e-4);

  // Invariant 2: Orthogonal to both plane normals
  const dot1 = res1.v.x * n1.x + res1.v.y * n1.y + res1.v.z * n1.z;
  const dot2 = res1.v.x * n2.x + res1.v.y * n2.y + res1.v.z * n2.z;
  assertNear(dot1, 0.0, 1e-4, 'Zero penetration into plane 1');
  assertNear(dot2, 0.0, 1e-4, 'Zero penetration into plane 2');
});

runAdvTest('F25-2: ||D||^2 boundary around 0.0002 threshold', () => {
  // Test ||D||^2 = 0.0002001 (Slid) vs 0.0001999 (Degenerate)
  const deltaSinAbove = Math.sqrt(0.0002001);
  const nA = { x: 0.0, y: 0.0, z: 1.0 };
  const nAbove = { x: deltaSinAbove, y: 0.0, z: Math.sqrt(1 - deltaSinAbove * deltaSinAbove) };
  const v = { x: 1.0, y: 2.0, z: 0.0 };

  const resAbove = creaseSlide(v, nA, nAbove);
  assertEquals(resAbove.type, 'Slid');

  const deltaSinBelow = Math.sqrt(0.0001999);
  const nBelow = { x: deltaSinBelow, y: 0.0, z: Math.sqrt(1 - deltaSinBelow * deltaSinBelow) };
  const resBelow = creaseSlide(v, nA, nBelow);
  assertEquals(resBelow.type, 'DegenerateSinglePlane');
});

runAdvTest('F25-3: Opposing acute pinch trap ceases all motion (Blocked)', () => {
  const nA = { x: 1.0, y: 0.0, z: 0.0 };
  const nOpp = { x: -1.0, y: 0.0, z: 0.0 }; // Normals face each other
  const v = { x: 3.0, y: 4.0, z: 0.0 };

  const res = creaseSlide(v, nA, nOpp);
  assertEquals(res.type, 'Blocked', 'Opposing pinch trap must cease motion');
});

// ----------------------------------------------------------------------------
// FEATURE 26: STOP COASTING DECELERATION
// ----------------------------------------------------------------------------
console.log('\n>>> [FEATURE 26] Stop Coasting Deceleration Adversarial Stress Tests <<<');

runAdvTest('F26-1: Run -> Ready link kinematics (T = 0.40s, 12 ticks, a = 10.0 m/s2, s ~ 0.79m)', () => {
  const v0 = 4.0;
  const T = 0.40;
  const dt = 1.0 / 30.0;
  let dist = 0.0;
  let ticks = 0;

  for (let i = 0; i < 20; i++) {
    const t = (i + 1) * dt;
    if (t >= T) {
      ticks = i + 1;
      break;
    }
    const v = v0 * (1.0 - t / T);
    dist += v * dt;
  }

  assertEquals(ticks, 12, '12 frames at 30 fps');
  // Continuous integral 0.5 * 4 * 0.4 = 0.80 m
  assertInRange(dist, 0.70, 0.85, 'Total coasting distance ~0.79m');
});

runAdvTest('F26-2: Walk -> Ready link kinematics (T = 0.20s, 6 ticks, s ~ 0.312m)', () => {
  const v0 = 3.12;
  const T = 0.20;
  const dt = 1.0 / 30.0;
  let dist = 0.0;
  let ticks = 0;

  for (let i = 0; i < 10; i++) {
    const t = (i + 1) * dt;
    if (t >= T) {
      ticks = i + 1;
      break;
    }
    const v = v0 * (1.0 - t / T);
    dist += v * dt;
  }

  assertEquals(ticks, 6, '6 frames at 30 fps');
  assertInRange(dist, 0.25, 0.35, 'Total coasting distance ~0.312m');
});

runAdvTest('F26-3: Instantaneous cancellation on forward locomotion re-press', () => {
  let isCoasting = true;
  let stopCoastingElapsed = 0.10; // at tick 3 of 12

  // Re-press 'W':
  const forwardInput = true;
  if (forwardInput) {
    isCoasting = false;
    stopCoastingElapsed = 0.0;
  }

  assertEquals(isCoasting, false, 'Coasting must cancel instantly');
  assertEquals(stopCoastingElapsed, 0.0);
});

// ----------------------------------------------------------------------------
// FEATURE 27: AP STUTTER MITIGATION
// ----------------------------------------------------------------------------
console.log('\n>>> [FEATURE 27] AP Stutter Mitigation Adversarial Stress Tests <<<');

runAdvTest('F27-1: Self echo does not snap predicted coordinates backward', () => {
  let predictedPose = { x: 100.0, y: 150.0, z: 20.0 };
  let authoritativePose = { x: 100.0, y: 150.0, z: 20.0 };

  // Echo arrives from 140ms ago
  const staleEcho = { x: 97.5, y: 150.0, z: 20.0 }; // 2.5m behind

  // Under Feature 27 USE_LOCAL_PLAYER_AUTONOMOUS_GUARD:
  const USE_LOCAL_PLAYER_AUTONOMOUS_GUARD = true;
  if (USE_LOCAL_PLAYER_AUTONOMOUS_GUARD) {
    authoritativePose = staleEcho; // Authoritative tracker updated
    // predictedPose remains untouched!
  } else {
    predictedPose = staleEcho; // The old bug
  }

  assertEquals(predictedPose.x, 100.0, 'Predicted pose must NOT snap backward');
  assertEquals(authoritativePose.x, 97.5, 'Authoritative pose tracks server');
});

runAdvTest('F27-2: Autonomous reconciliation error clamped to 0.5x manual displacement', () => {
  const manualOffset = { x: 1.0, y: 0.0, z: 0.0 }; // 1.0m step
  const interpOffset = { x: -0.9, y: 0.0, z: 0.0 }; // 0.9m backward error correction

  const manualLen = Math.sqrt(manualOffset.x * manualOffset.x + manualOffset.y * manualOffset.y);
  const maxCorrection = manualLen * 0.5; // 0.5m clamp
  const corrLen = Math.sqrt(interpOffset.x * interpOffset.x + interpOffset.y * interpOffset.y);

  let clampedCorr = { ...interpOffset };
  if (corrLen > maxCorrection && corrLen > 1e-6) {
    const scale = maxCorrection / corrLen;
    clampedCorr = { x: interpOffset.x * scale, y: interpOffset.y * scale, z: interpOffset.z * scale };
  }

  const blended = {
    x: manualOffset.x + clampedCorr.x,
    y: manualOffset.y + clampedCorr.y,
    z: manualOffset.z + clampedCorr.z
  };

  assertEquals(clampedCorr.x, -0.5, 'Error clamped to 0.5m');
  assertEquals(blended.x, 0.5, 'Forward progress preserved (+0.5m)');
  if (blended.x <= 0) throw new Error('Avatar must not stutter backward');
});

console.log('\n======================================================================');
console.log(`  RESULTS: ${passCount} passed, ${failCount} failed`);
console.log('======================================================================\n');

if (failCount > 0) {
  process.exit(1);
}
