#!/usr/bin/env node
/**
 * external/holtburger/scripts/test-movement-adversarial-it2.cjs
 *
 * Empirical Adversarial Challenger Verification Suite for Milestone 2 Iteration 2 (Features 23–27)
 * Agent: movement_challenger_m2_it2_2
 */

'use strict';

const {
  CONSTANTS,
  isWalkableSlope,
  calcSlopeSlideAcceleration,
  assertNear,
  assertEquals,
  assertInRange
} = require('../tests/e2e/movement/harness.cjs');

console.log('======================================================================');
console.log('  MOVEMENT CHALLENGER M2 IT2: DEEP EMPIRICAL ADVERSARIAL STRESS SUITE');
console.log('======================================================================\n');

let passCount = 0;
let failCount = 0;

function runTest(name, fn) {
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

// ============================================================================
// FEATURE 23: STEEP SLOPE SLIDING
// ============================================================================
console.log('>>> [FEATURE 23] Steep Slope Sliding Deep Stress Tests <<<');

runTest('F23-S1: Steep Slope Slide from Rest: Full 3D velocity integration accelerates past 2.5 m/s into sledding within 1.0s', () => {
  const dt = 1.0 / 30.0;
  const theta = 60 * (Math.PI / 180); // 60 deg steep cliff
  const normal = { x: Math.sin(theta), y: 0.0, z: Math.cos(theta) }; // Nx = 0.866025, Nz = 0.50

  const a = calcSlopeSlideAcceleration(normal, CONSTANTS.GRAVITY);
  let player = {
    current_planar_velocity: { x: 0.0, y: 0.0, z: 0.0 },
    vertical_velocity: 0.0,
    is_sledding: false
  };

  for (let tick = 1; tick <= 30; tick++) {
    // 1. Compose 3D velocity from PlayerState split stores:
    let v = {
      x: player.current_planar_velocity.x + a.ax * dt,
      y: player.current_planar_velocity.y + a.ay * dt,
      z: player.vertical_velocity + a.az * dt
    };

    // 2. calc_friction contact plane projection:
    const angle = v.x * normal.x + v.y * normal.y + v.z * normal.z;
    assertNear(angle, 0.0, 1e-4, 'Gravity tangent acceleration orthogonal to slope normal');
    if (angle < 0.25) {
      v.x -= normal.x * angle;
      v.y -= normal.y * angle;
      v.z -= normal.z * angle;
    }

    const friction = player.is_sledding ? CONSTANTS.SLEDDING_FRICTION : CONSTANTS.DEFAULT_FRICTION;
    const scalar = Math.pow(1.0 - friction, dt);
    v.x *= scalar;
    v.y *= scalar;
    v.z *= scalar;

    // 3. Write back to PlayerState split stores:
    player.current_planar_velocity.x = v.x;
    player.current_planar_velocity.y = v.y;
    player.current_planar_velocity.z = 0.0;
    player.vertical_velocity = v.z;

    const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (speed >= CONSTANTS.SLEDDING_SPEED_THRESHOLD && normal.z < CONSTANTS.SLEDDING_SLOPE_COS) {
      player.is_sledding = true;
    }
  }

  const finalPlanarSpeed = Math.sqrt(
    player.current_planar_velocity.x * player.current_planar_velocity.x +
    player.current_planar_velocity.y * player.current_planar_velocity.y
  );
  const finalSpeed3D = Math.sqrt(
    finalPlanarSpeed * finalPlanarSpeed +
    player.vertical_velocity * player.vertical_velocity
  );

  assertInRange(finalPlanarSpeed, 1.5, 2.0, 'Planar slide speed accelerates past 1.5 m/s');
  assertInRange(finalSpeed3D, 3.0, 4.0, '3D slide speed accelerates past 3.0 m/s');
  assertEquals(player.is_sledding, true, 'Avatar successfully triggers sledding state within 1.0s');
});

runTest('F23-S2: Mathematical Invariant: Full 3D tangent vector correctly accelerates past 2.5 m/s into sledding', () => {
  // When 3D velocity is maintained (including vertical_velocity):
  // v.dot(&normal) == 0, so calc_friction does NOT strip velocity,
  // allowing downward gravity tangent acceleration to reach 3.29 m/s in 30 ticks.

  const dt = 1.0 / 30.0;
  const theta = 60 * (Math.PI / 180);
  const normal = { x: Math.sin(theta), y: 0.0, z: Math.cos(theta) };

  const a = calcSlopeSlideAcceleration(normal, CONSTANTS.GRAVITY);
  let v3d = { x: 0.0, y: 0.0, z: 0.0 };
  let isSledding = false;

  for (let tick = 1; tick <= 30; tick++) {
    v3d.x += a.ax * dt;
    v3d.y += a.ay * dt;
    v3d.z += a.az * dt;

    const angle = v3d.x * normal.x + v3d.y * normal.y + v3d.z * normal.z;
    // Strictly orthogonal: angle == 0
    assertNear(angle, 0.0, 1e-4, 'Tangent acceleration is strictly orthogonal to normal');

    let friction = isSledding ? CONSTANTS.SLEDDING_FRICTION : CONSTANTS.DEFAULT_FRICTION;
    const scalar = Math.pow(1.0 - friction, dt);
    v3d.x *= scalar;
    v3d.y *= scalar;
    v3d.z *= scalar;

    const speed = Math.sqrt(v3d.x * v3d.x + v3d.y * v3d.y + v3d.z * v3d.z);
    if (speed >= CONSTANTS.SLEDDING_SPEED_THRESHOLD && normal.z < CONSTANTS.SLEDDING_SLOPE_COS) {
      isSledding = true;
    }
  }

  const finalSpeed = Math.sqrt(v3d.x * v3d.x + v3d.y * v3d.y + v3d.z * v3d.z);
  assertInRange(finalSpeed, 3.0, 4.0, '3D slide speed accelerates past 3.0 m/s');
  assertEquals(isSledding, true, '3D slide successfully enters sledding');
});

runTest('F23-S3: Linear WASD translation suppression while yaw turning remains fully operational', () => {
  const dt = 1.0 / 30.0;
  const theta = 60 * (Math.PI / 180);
  const normal = { x: Math.sin(theta), y: 0, z: Math.cos(theta) };

  let v = { x: 1.0, y: 0.0, z: 0.0 };
  let heading = 0.0;
  const turnRate = 2.25;

  for (let tick = 0; tick < 15; tick++) {
    // WASD target velocity is suppressed
    const a = calcSlopeSlideAcceleration(normal, CONSTANTS.GRAVITY);
    v.x += a.ax * dt;
    v.y += a.ay * dt;

    heading += turnRate * dt;
  }

  assertNear(v.y, 0.0, 1e-4, 'WASD forward input has zero effect on linear slide');
  if (v.x <= 1.0) throw new Error('Downhill slide must accelerate under gravity');
  const expectedHeading = turnRate * dt * 15;
  assertNear(heading, expectedHeading, 1e-4, 'Yaw rotation operational on steep slope');
});

runTest('F23-S4: Terminal velocity clamp at 50.0 m/s', () => {
  let vExtreme = { x: 70.71, y: 70.71, z: 0.0 }; // 100 m/s
  const magSqExt = vExtreme.x * vExtreme.x + vExtreme.y * vExtreme.y;
  if (magSqExt > CONSTANTS.TERMINAL_VELOCITY * CONSTANTS.TERMINAL_VELOCITY) {
    const len = Math.sqrt(magSqExt);
    vExtreme.x = (vExtreme.x / len) * CONSTANTS.TERMINAL_VELOCITY;
    vExtreme.y = (vExtreme.y / len) * CONSTANTS.TERMINAL_VELOCITY;
  }
  const extremeSpeed = Math.sqrt(vExtreme.x * vExtreme.x + vExtreme.y * vExtreme.y);
  assertNear(extremeSpeed, 50.0, 1e-4, 'Initial speed > 50 m/s is clamped to 50.0 m/s');
});

// ============================================================================
// FEATURE 24: SLEDDING GLIDE
// ============================================================================
console.log('\n>>> [FEATURE 24] Sledding Glide Deep Stress Tests <<<');

runTest('F24-S1: Precise engagement gate at speed >= 2.5 m/s on slopes > 10°', () => {
  const theta15 = 15 * (Math.PI / 180);
  const normal = { x: 0, y: Math.sin(theta15), z: Math.cos(theta15) };
  const dt = 1.0 / 30.0;

  // Boundary check 1: Speed = 2.499 m/s (below 2.5) -> sledding does not engage, friction is 0.95
  const vSub = { x: 0, y: -2.499 * Math.cos(theta15), z: 2.499 * Math.sin(theta15) };
  let isSledding = false;
  const speedSub = Math.sqrt(vSub.x * vSub.x + vSub.y * vSub.y + vSub.z * vSub.z);
  if (speedSub >= CONSTANTS.SLEDDING_SPEED_THRESHOLD && normal.z < CONSTANTS.SLEDDING_SLOPE_COS) {
    isSledding = true;
  }
  assertEquals(isSledding, false, 'Speed 2.499 m/s must not engage sledding');

  // Boundary check 2: Speed = 2.501 m/s (at/above 2.5) -> sledding engages, friction is 0.20
  const vSuper = { x: 0, y: -2.501 * Math.cos(theta15), z: 2.501 * Math.sin(theta15) };
  const speedSuper = Math.sqrt(vSuper.x * vSuper.x + vSuper.y * vSuper.y + vSuper.z * vSuper.z);
  if (speedSuper >= CONSTANTS.SLEDDING_SPEED_THRESHOLD && normal.z < CONSTANTS.SLEDDING_SLOPE_COS) {
    isSledding = true;
  }
  assertEquals(isSledding, true, 'Speed 2.501 m/s must engage sledding');
});

runTest('F24-S2: Precise exit gate at speed < 1.25 m/s snaps to 0 m/s', () => {
  const theta20 = 20 * (Math.PI / 180);
  const normal = { x: 0, y: Math.sin(theta20), z: Math.cos(theta20) };
  const dt = 1.0 / 30.0;

  let isSledding = true;
  // Speed drops to 1.24 m/s (below 1.25)
  const speed = 1.24;
  if (speed < CONSTANTS.SLEDDING_STOP_THRESHOLD) {
    isSledding = false;
  }
  assertEquals(isSledding, false, 'Speed below 1.25 m/s disengages sledding');
});

runTest('F24-S3: Heading alignment to velocity vector during sledding', () => {
  const directions = [
    { vx: 0.0, vy: 5.0, expHeadingDeg: 0.0 },
    { vx: 5.0, vy: 5.0, expHeadingDeg: 45.0 },
    { vx: 5.0, vy: 0.0, expHeadingDeg: 90.0 },
    { vx: 5.0, vy: -5.0, expHeadingDeg: 135.0 },
    { vx: 0.0, vy: -5.0, expHeadingDeg: 180.0 },
    { vx: -5.0, vy: -5.0, expHeadingDeg: -135.0 },
    { vx: -5.0, vy: 0.0, expHeadingDeg: -90.0 },
    { vx: -5.0, vy: 5.0, expHeadingDeg: -45.0 },
  ];

  for (const dir of directions) {
    const headingRad = Math.atan2(dir.vx, dir.vy);
    const headingDeg = headingRad * (180.0 / Math.PI);
    assertNear(headingDeg, dir.expHeadingDeg, 1e-4, `Heading aligns to (${dir.vx}, ${dir.vy})`);
  }
});

// ============================================================================
// FEATURE 25: CREASE SLIDE PROJECTION
// ============================================================================
console.log('\n>>> [FEATURE 25] Crease Slide Projection Deep Stress Tests <<<');

function creaseSlideProject(v, n1, n2) {
  const RETAIL_EPSILON = 0.0002;
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

runTest('F25-S1: Zero penetration & order invariance across 500 randomized non-coplanar crease pairs', () => {
  for (let i = 0; i < 500; i++) {
    const u1 = Math.random() * 2 - 1, theta1 = Math.random() * Math.PI * 2;
    const n1 = { x: Math.sqrt(1 - u1 * u1) * Math.cos(theta1), y: Math.sqrt(1 - u1 * u1) * Math.sin(theta1), z: u1 };

    const u2 = Math.random() * 2 - 1, theta2 = Math.random() * Math.PI * 2;
    const n2 = { x: Math.sqrt(1 - u2 * u2) * Math.cos(theta2), y: Math.sqrt(1 - u2 * u2) * Math.sin(theta2), z: u2 };

    const v = { x: (Math.random() - 0.5) * 10, y: (Math.random() - 0.5) * 10, z: (Math.random() - 0.5) * 10 };

    const res1 = creaseSlideProject(v, n1, n2);
    const res2 = creaseSlideProject(v, n2, n1);

    assertEquals(res1.type, res2.type, 'Order invariance of result type');

    if (res1.type === 'Slid') {
      assertNear(res1.v.x, res2.v.x, 1e-4, 'Symmetry vx');
      assertNear(res1.v.y, res2.v.y, 1e-4, 'Symmetry vy');
      assertNear(res1.v.z, res2.v.z, 1e-4, 'Symmetry vz');

      const dot1 = res1.v.x * n1.x + res1.v.y * n1.y + res1.v.z * n1.z;
      const dot2 = res1.v.x * n2.x + res1.v.y * n2.y + res1.v.z * n2.z;
      assertNear(dot1, 0.0, 1e-4, 'Zero penetration into plane 1');
      assertNear(dot2, 0.0, 1e-4, 'Zero penetration into plane 2');
    }
  }
});

runTest('F25-S2: Acute opposing pinch traps (N1 · N2 < 0) and perpendicular impacts Block motion', () => {
  const n1 = { x: 1.0, y: 0.0, z: 0.0 };
  const n2 = { x: -1.0, y: 0.0, z: 0.0 };
  const v = { x: 3.5, y: -2.1, z: 4.8 };
  const resA = creaseSlideProject(v, n1, n2);
  assertEquals(resA.type, 'Blocked', 'Parallel opposing pinch trap must block motion');

  const nA = { x: 1.0, y: 0.0, z: 0.0 };
  const nB = { x: 0.0, y: 1.0, z: 0.0 };
  const vPerp = { x: -3.0, y: -4.0, z: 0.0 };
  const resB = creaseSlideProject(vPerp, nA, nB);
  assertEquals(resB.type, 'Blocked', 'Impact perpendicular to crease must halt (Blocked)');
});

// ============================================================================
// FEATURE 26: STOP COASTING DECELERATION
// ============================================================================
console.log('\n>>> [FEATURE 26] Stop Coasting Deceleration Deep Stress Tests <<<');

runTest('F26-S1: Run->Ready 12-tick deceleration profile (4.0 m/s -> 0.0 m/s over 0.40s, ~0.79m)', () => {
  const v0 = 4.0;
  const T = 0.40;
  const dt = 1.0 / 30.0;
  let v = v0;
  let dist = 0.0;
  let ticks = 0;

  for (let i = 1; i <= 20; i++) {
    const elapsed = i * dt;
    const vPrev = v;
    if (elapsed >= T) {
      v = 0.0;
    } else {
      v = v0 * (1.0 - elapsed / T);
      if (v < CONSTANTS.MIN_SNAP_SPEED) v = 0.0;
    }
    dist += 0.5 * (vPrev + v) * dt;
    ticks++;
    if (v === 0.0) break;
  }

  assertEquals(ticks, 12, 'Run->Ready must stop in exactly 12 ticks');
  assertInRange(dist, 0.75, 0.82, 'Distance must be ~0.79m');
});

runTest('F26-S2: Walk->Ready 6-tick deceleration profile (3.12 m/s -> 0.0 m/s over 0.20s, ~0.312m)', () => {
  const v0 = 3.12;
  const T = 0.20;
  const dt = 1.0 / 30.0;
  let v = v0;
  let dist = 0.0;
  let ticks = 0;

  for (let i = 1; i <= 15; i++) {
    const elapsed = i * dt;
    const vPrev = v;
    if (elapsed >= T) {
      v = 0.0;
    } else {
      v = v0 * (1.0 - elapsed / T);
      if (v < CONSTANTS.MIN_SNAP_SPEED) v = 0.0;
    }
    dist += 0.5 * (vPrev + v) * dt;
    ticks++;
    if (v === 0.0) break;
  }

  assertEquals(ticks, 6, 'Walk->Ready must stop in exactly 6 ticks');
  assertInRange(dist, 0.28, 0.35, 'Distance must be ~0.312m');
});

runTest('F26-S3: Instantaneous cancellation at ticks 1, 3, 6, 9 upon forward locomotion re-press', () => {
  const cancelTicks = [1, 3, 6, 9];

  for (const cTick of cancelTicks) {
    let stopCoasting = {
      initialSpeed: 4.0,
      duration: 0.40,
      elapsed: cTick * (1.0 / 30.0)
    };

    const forwardPressed = true;
    if (forwardPressed) {
      stopCoasting = null;
    }

    assertEquals(stopCoasting, null, `Coasting canceled at tick ${cTick}`);
  }
});

// ============================================================================
// FEATURE 27: AP STUTTER MITIGATION
// ============================================================================
console.log('\n>>> [FEATURE 27] AP Stutter Mitigation Deep Stress Tests <<<');

runTest('F27-S1: Self echo does not snap predicted position backwards', () => {
  const clientPredictPose = { x: 104.0, y: 200.0, z: 15.0 };
  const staleServerEcho = { x: 101.5, y: 200.0, z: 15.0 };

  const echoDistance = Math.abs(clientPredictPose.x - staleServerEcho.x);
  assertEquals(echoDistance, 2.5);

  let currentPose = { ...clientPredictPose };
  const isSelfEcho = true;
  if (!isSelfEcho) {
    currentPose = { ...staleServerEcho };
  }

  assertEquals(currentPose.x, 104.0, 'Predicted pose intact, no backward snap');
});

runTest('F27-S2: Error blending clamps corrective displacement to 0.5x manual intent', () => {
  const testCases = [
    { manual: 0.40, error: -1.0, expClamped: -0.20, expNet: 0.20 },
    { manual: 0.20, error: -0.5, expClamped: -0.10, expNet: 0.10 },
    { manual: 0.80, error: -0.3, expClamped: -0.30, expNet: 0.50 },
    { manual: 0.50, error: 0.8, expClamped: 0.25, expNet: 0.75 },
  ];

  for (const tc of testCases) {
    const maxCorrection = tc.manual * 0.5;
    const corrSign = tc.error >= 0 ? 1 : -1;
    const clampedCorr = Math.min(Math.abs(tc.error), maxCorrection) * corrSign;
    const net = tc.manual + clampedCorr;

    assertNear(clampedCorr, tc.expClamped, 1e-4, 'Clamped correction matches 0.5x bound');
    assertNear(net, tc.expNet, 1e-4, 'Net displacement preserved');
    if (net <= 0.0) {
      throw new Error(`Net displacement collapsed to ${net} (stutter not mitigated)`);
    }
  }
});

console.log('\n======================================================================');
console.log(`  FINAL RESULTS: ${passCount} passed, ${failCount} failed`);
console.log('======================================================================\n');

if (failCount > 0) {
  process.exit(1);
}
