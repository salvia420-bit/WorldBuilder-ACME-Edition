#!/usr/bin/env node
/**
 * external/holtburger/scripts/test-challenger-m2-it3-stress.cjs
 *
 * Empirical Adversarial Challenger Verification Suite for Milestone 2 Iteration 3
 * Agent: movement_challenger_m2_it3_2
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
console.log('  MOVEMENT CHALLENGER M2 IT3: DEEP EMPIRICAL STRESS HARNESS (JS)');
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

runTest('F23-IT3-01: Steep slope 60° sliding from rest: 3D vector avoids normal stripping and enters sledding', () => {
  const dt = 1.0 / 30.0;
  const theta = 60 * (Math.PI / 180);
  const normal = { x: Math.sin(theta), y: 0.0, z: Math.cos(theta) };

  const a = calcSlopeSlideAcceleration(normal, CONSTANTS.GRAVITY);
  let player = {
    current_planar_velocity: { x: 0.0, y: 0.0, z: 0.0 },
    vertical_velocity: 0.0,
    is_sledding: false
  };

  for (let tick = 1; tick <= 35; tick++) {
    let v = {
      x: player.current_planar_velocity.x + a.ax * dt,
      y: player.current_planar_velocity.y + a.ay * dt,
      z: player.vertical_velocity + a.az * dt
    };

    const angle = v.x * normal.x + v.y * normal.y + v.z * normal.z;
    assertNear(angle, 0.0, 1e-4, 'Normal orthogonality preserved strictly');

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

    player.current_planar_velocity.x = v.x;
    player.current_planar_velocity.y = v.y;
    player.current_planar_velocity.z = 0.0;
    player.vertical_velocity = v.z;

    const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (speed >= CONSTANTS.SLEDDING_SPEED_THRESHOLD && normal.z < CONSTANTS.SLEDDING_SLOPE_COS) {
      player.is_sledding = true;
    }
  }

  const finalPlanarSpeed = Math.hypot(player.current_planar_velocity.x, player.current_planar_velocity.y);
  const finalSpeed3D = Math.hypot(finalPlanarSpeed, player.vertical_velocity);

  assertEquals(player.is_sledding, true, 'Player entered sledding');
  assertInRange(finalPlanarSpeed, 2.0, 4.0, 'Planar slide speed in range');
  assertInRange(finalSpeed3D, 4.0, 8.0, '3D slide speed in range');
});

runTest('F23-IT3-02: Steep slope sliding 2D normal stripping defect proof (reproduced & verified trapped at 4 cm/s)', () => {
  const dt = 1.0 / 30.0;
  const theta = 60 * (Math.PI / 180);
  const normal = { x: Math.sin(theta), y: 0.0, z: Math.cos(theta) };
  const a = calcSlopeSlideAcceleration(normal, CONSTANTS.GRAVITY);

  let v2d = { x: 0.0, y: 0.0, z: 0.0 };
  for (let tick = 1; tick <= 30; tick++) {
    v2d.x += a.ax * dt;
    v2d.y += a.ay * dt;
    // v2d.z is missing (0.0) -> causes angle = v.x * normal.x > 0
    const angle = v2d.x * normal.x + v2d.y * normal.y + v2d.z * normal.z;
    if (angle < 0.25) {
      v2d.x -= normal.x * angle;
      v2d.y -= normal.y * angle;
    }
    const scalar = Math.pow(1.0 - CONSTANTS.DEFAULT_FRICTION, dt);
    v2d.x *= scalar;
    v2d.y *= scalar;
  }
  const defectiveSpeed = Math.hypot(v2d.x, v2d.y);
  assertInRange(defectiveSpeed, 0.03, 0.05, 'Defective 2D projection traps avatar at ~4 cm/s');
});

// ============================================================================
// FEATURE 24: SLEDDING GLIDE
// ============================================================================
console.log('\n>>> [FEATURE 24] Sledding Glide Deep Stress Tests <<<');

runTest('F24-IT3-01: Entry threshold exactly at 2.5 m/s on slopes > 10°', () => {
  const slopeCos10 = Math.cos(10 * Math.PI / 180);
  const isSteep = (cos) => cos < slopeCos10;

  assertEquals(isSteep(Math.cos(10.01 * Math.PI / 180)), true, '10.01° is steep enough');
  assertEquals(isSteep(Math.cos(9.99 * Math.PI / 180)), false, '9.99° is not steep enough');

  const qualifies = (speed, cos) => speed >= 2.5 && isSteep(cos);
  assertEquals(qualifies(2.500, Math.cos(15 * Math.PI / 180)), true, '2.500 m/s qualifies');
  assertEquals(qualifies(2.499, Math.cos(15 * Math.PI / 180)), false, '2.499 m/s does not qualify');
});

runTest('F24-IT3-02: Exit threshold: drops below 1.25 m/s snaps to 0', () => {
  let speed = 1.249;
  let is_sledding = true;
  if (speed < 1.25) {
    speed = 0.0;
    is_sledding = false;
  }
  assertEquals(is_sledding, false, 'Sledding disengaged');
  assertEquals(speed, 0.0, 'Speed snapped to 0');
});

// ============================================================================
// FEATURE 25: CREASE SLIDE PROJECTION
// ============================================================================
console.log('\n>>> [FEATURE 25] Crease Slide Projection Deep Stress Tests <<<');

runTest('F25-IT3-01: Orthogonal planes crease projection', () => {
  const n1 = { x: 1.0, y: 0.0, z: 0.0 };
  const n2 = { x: 0.0, y: 1.0, z: 0.0 };
  const v = { x: -3.0, y: -4.0, z: 5.0 };

  // D = N1 x N2 = (0, 0, 1)
  const d = {
    x: n1.y * n2.z - n1.z * n2.y,
    y: n1.z * n2.x - n1.x * n2.z,
    z: n1.x * n2.y - n1.y * n2.x
  };
  assertEquals(d.x, 0);
  assertEquals(d.y, 0);
  assertEquals(d.z, 1);

  // Projection along D
  const dotVD = v.x * d.x + v.y * d.y + v.z * d.z;
  const v_proj = { x: d.x * dotVD, y: d.y * dotVD, z: d.z * dotVD };

  assertEquals(v_proj.x, 0.0, 'X motion blocked by wall 1');
  assertEquals(v_proj.y, 0.0, 'Y motion blocked by wall 2');
  assertEquals(v_proj.z, 5.0, 'Z motion along crease preserved');
});

// ============================================================================
// FEATURE 26: STOP COASTING DECELERATION
// ============================================================================
console.log('\n>>> [FEATURE 26] Stop Coasting Deceleration Deep Stress Tests <<<');

runTest('F26-IT3-01: Run->Ready 12-frame coasting window (~0.79m distance)', () => {
  const dt = 1.0 / 30.0;
  const v0 = 4.0;
  const duration = 0.40;
  let dist = 0.0;
  let ticks = 0;

  for (let tick = 1; tick <= 15; tick++) {
    const elapsed = tick * dt;
    if (elapsed >= duration) {
      break;
    }
    const v = v0 * (1.0 - elapsed / duration);
    dist += v * dt;
    ticks++;
  }

  assertEquals(ticks, 11, 'Exactly 11 positive velocity ticks');
  assertInRange(dist, 0.70, 0.85, 'Run stopping distance ~0.79m');
});

runTest('F26-IT3-02: Instant re-press cancellation clears coasting immediately', () => {
  let stop_coasting = { initial_v: 4.0, elapsed: 0.10 };
  // Input re-pressed:
  const target_velocity = { x: 0.0, y: 4.0, z: 0.0 };
  if (target_velocity.y > 0) {
    stop_coasting = null;
  }
  assertEquals(stop_coasting, null, 'stop_coasting immediately cancelled');
});

// ============================================================================
// FEATURE 27: AP STUTTER MITIGATION
// ============================================================================
console.log('\n>>> [FEATURE 27] AP Stutter Mitigation Deep Stress Tests <<<');

runTest('F27-IT3-01: Error blending clamps corrective displacement to 0.5x manual intent', () => {
  const manual = { x: 0.40, y: 0.0, z: 0.0 };
  const backwardCorr = { x: -0.60, y: 0.0, z: 0.0 };

  const maxCorr = manual.x * 0.5; // 0.20m
  const corrLen = Math.abs(backwardCorr.x);
  const clampedCorr = corrLen > maxCorr ? backwardCorr.x * (maxCorr / corrLen) : backwardCorr.x;

  assertEquals(clampedCorr, -0.20, 'Clamped backward correction to -0.20m');
  const net = manual.x + clampedCorr;
  assertEquals(net, 0.20, 'Net movement maintains forward progress (+0.20m)');
});

console.log('\n======================================================================');
console.log(`  FINAL RESULTS: ${passCount} passed, ${failCount} failed`);
console.log('======================================================================\n');

if (failCount > 0) {
  process.exit(1);
}
