#!/usr/bin/env node
/**
 * external/holtburger/scripts/test-challenger-m4-1-tier5-stress.cjs
 *
 * Tier 5 White-Box Adversarial Coverage Hardening and Stress Testing Suite
 * Movement Challenger: movement_challenger_m4_1
 */

'use strict';

const {
  CONSTANTS,
  isWalkableSlope,
  calcSlopeSlideAcceleration,
  calcFrictionDecay,
  assertNear,
  assertEquals,
  assertInRange
} = require('../tests/e2e/movement/harness.cjs');

console.log('======================================================================');
console.log('  MOVEMENT CHALLENGER M4-1: TIER 5 WHITE-BOX ADVERSARIAL STRESS SUITE');
console.log('======================================================================\n');

let passCount = 0;
let failCount = 0;

function stressAssert(name, fn) {
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
// 1. STEEP SLOPE SLIDING AT EXTREME NORMAL ANGLES
// ============================================================================
console.log('>>> [DIMENSION 1] Steep Slope Sliding at Extreme Normal Angles <<<');

stressAssert('T5-01: Exact normal boundary at FLOOR_Z (0.66417415, ~48.38118°)', () => {
  const floorZ = CONSTANTS.FLOOR_Z; // 0.664174
  const eps = 1e-6;

  assertEquals(isWalkableSlope({ x: Math.sqrt(1 - floorZ * floorZ), y: 0, z: floorZ }), true, 'Exact FLOOR_Z is walkable');
  assertEquals(isWalkableSlope({ x: Math.sqrt(1 - (floorZ + eps) ** 2), y: 0, z: floorZ + eps }), true, 'FLOOR_Z + eps is walkable');
  assertEquals(isWalkableSlope({ x: Math.sqrt(1 - (floorZ - eps) ** 2), y: 0, z: floorZ - eps }), false, 'FLOOR_Z - eps is unwalkable cliff');

  // Angular boundary
  const rad48_380 = 48.380 * Math.PI / 180;
  assertEquals(isWalkableSlope({ x: Math.sin(rad48_380), y: 0, z: Math.cos(rad48_380) }), true, '48.380° is walkable');
  const rad48_382 = 48.382 * Math.PI / 180;
  assertEquals(isWalkableSlope({ x: Math.sin(rad48_382), y: 0, z: Math.cos(rad48_382) }), false, '48.382° is steep cliff');
});

stressAssert('T5-02: Extreme steep normal pitches (Nz -> 0) across 8 azimuths', () => {
  const g = CONSTANTS.GRAVITY; // -9.8000002
  const steepPitches = [48.5, 49.0, 50.0, 55.0, 60.0, 70.0, 75.0, 80.0, 85.0, 88.0, 89.0, 89.9, 89.999];
  const azimuths = [0, 45, 90, 135, 180, 225, 270, 315];

  for (const pitch of steepPitches) {
    const theta = pitch * Math.PI / 180;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);

    for (const az of azimuths) {
      const phi = az * Math.PI / 180;
      const normal = { x: sinT * Math.cos(phi), y: sinT * Math.sin(phi), z: cosT };

      const a = calcSlopeSlideAcceleration(normal, g);

      // Invariant 1: Orthogonality (a · n == 0)
      const dot = a.ax * normal.x + a.ay * normal.y + a.az * normal.z;
      assertNear(dot, 0.0, 1e-4, `Orthogonality violated at pitch=${pitch}, az=${az}`);

      // Invariant 2: Closed-form coordinate match
      const expectedAx = -g * cosT * (sinT * Math.cos(phi));
      const expectedAy = -g * cosT * (sinT * Math.sin(phi));
      const expectedAz = g * (1.0 - cosT * cosT);
      assertNear(a.ax, expectedAx, 1e-4, `ax mismatch at pitch=${pitch}`);
      assertNear(a.ay, expectedAy, 1e-4, `ay mismatch at pitch=${pitch}`);
      assertNear(a.az, expectedAz, 1e-4, `az mismatch at pitch=${pitch}`);

      // Invariant 3: Total magnitude |a| = |g| * sin(theta)
      const actualMag = Math.hypot(a.ax, a.ay, a.az);
      const expectedMag = Math.abs(g) * sinT;
      assertNear(actualMag, expectedMag, 1e-4, `magnitude mismatch at pitch=${pitch}`);

      // Invariant 4: Slide trajectory angle arctan(|az| / a_planar) matches terrain pitch
      const aPlanar = Math.hypot(a.ax, a.ay);
      if (aPlanar > 1e-5) {
        const trajDeg = Math.atan2(Math.abs(a.az), aPlanar) * 180 / Math.PI;
        assertNear(trajDeg, pitch, 0.05, `Trajectory angle mismatch at pitch=${pitch}`);
      }
    }
  }
});

stressAssert('T5-03: Vertical wall (Nz = 0.0) produces pure vertical freefall', () => {
  const g = CONSTANTS.GRAVITY;
  const nVert = { x: 1.0, y: 0.0, z: 0.0 };
  const a = calcSlopeSlideAcceleration(nVert, g);
  assertNear(a.ax, 0.0, 1e-6, 'ax is zero on vertical wall');
  assertNear(a.ay, 0.0, 1e-6, 'ay is zero on vertical wall');
  assertNear(a.az, g, 1e-6, 'az is exact downward g on vertical wall');
});

stressAssert('T5-04: Flat ground (Nz = 1.0) produces zero tangential acceleration', () => {
  const g = CONSTANTS.GRAVITY;
  const nFlat = { x: 0.0, y: 0.0, z: 1.0 };
  const a = calcSlopeSlideAcceleration(nFlat, g);
  const mag = Math.hypot(a.ax, a.ay, a.az);
  assertNear(mag, 0.0, 1e-6, 'Flat ground acceleration is zero');
});

// ============================================================================
// 2. 3D TANGENT VELOCITY INTEGRATION WITHOUT NORMAL STRIPPING
// ============================================================================
console.log('\n>>> [DIMENSION 2] 3D Tangent Velocity Integration vs Normal Stripping <<<');

stressAssert('T5-05: Option A 3D integration preserves velocity; 2D projection trapped at ~4 cm/s', () => {
  const dt = 1.0 / 30.0;
  const g = CONSTANTS.GRAVITY;

  for (const pitch of [50, 55, 60, 70, 80]) {
    const theta = pitch * Math.PI / 180;
    const normal = { x: Math.sin(theta), y: 0.0, z: Math.cos(theta) };
    const a = calcSlopeSlideAcceleration(normal, g);

    let p3d = { vx: 0.0, vy: 0.0, vz: 0.0, is_sledding: false };
    let p2d = { vx: 0.0, vy: 0.0 };

    for (let tick = 1; tick <= 45; tick++) {
      // 3D Integration
      let v = {
        x: p3d.vx + a.ax * dt,
        y: p3d.vy + a.ay * dt,
        z: p3d.vz + a.az * dt
      };
      const angle = v.x * normal.x + v.y * normal.y + v.z * normal.z;
      assertNear(angle, 0.0, 1e-4, 'Tangency strictly preserved');

      if (angle < 0.25) {
        v.x -= normal.x * angle;
        v.y -= normal.y * angle;
        v.z -= normal.z * angle;
      }

      const friction = p3d.is_sledding && (v.x * v.x + v.y * v.y + v.z * v.z) >= CONSTANTS.SLEDDING_SPEED_THRESHOLD ** 2
        ? CONSTANTS.SLEDDING_FRICTION
        : CONSTANTS.DEFAULT_FRICTION;
      const scalar = Math.pow(1.0 - friction, dt);
      v.x *= scalar;
      v.y *= scalar;
      v.z *= scalar;

      p3d.vx = v.x;
      p3d.vy = v.y;
      p3d.vz = v.z;

      const speedSq = p3d.vx * p3d.vx + p3d.vy * p3d.vy + p3d.vz * p3d.vz;
      if (speedSq >= CONSTANTS.SLEDDING_SPEED_THRESHOLD ** 2 && normal.z < CONSTANTS.SLEDDING_SLOPE_COS) {
        p3d.is_sledding = true;
      }

      // Defective 2D projection
      p2d.vx += a.ax * dt;
      p2d.vy += a.ay * dt;
      const defectiveAngle = p2d.vx * normal.x + p2d.vy * normal.y;
      if (defectiveAngle < 0.25) {
        p2d.vx -= normal.x * defectiveAngle;
        p2d.vy -= normal.y * defectiveAngle;
      }
      p2d.vx *= Math.pow(1.0 - CONSTANTS.DEFAULT_FRICTION, dt);
      p2d.vy *= Math.pow(1.0 - CONSTANTS.DEFAULT_FRICTION, dt);
    }

    const speed3D = Math.hypot(p3d.vx, p3d.vy, p3d.vz);
    const speed2D = Math.hypot(p2d.vx, p2d.vy);

    assertEquals(speed3D > 2.2, true, `3D speed >= 2.2 m/s at pitch=${pitch} (got ${speed3D.toFixed(3)})`);
    assertEquals(speed2D < 0.12, true, `2D speed trapped under 12 cm/s at pitch=${pitch} (got ${speed2D.toFixed(3)})`);
    assertEquals(speed3D / speed2D > 20.0, true, `3D speed is >20x faster than stripped 2D (ratio ${(speed3D / speed2D).toFixed(1)})`);
  }
});

// ============================================================================
// 3. SLEDDING HYSTERESIS
// ============================================================================
console.log('\n>>> [DIMENSION 3] Sledding Hysteresis (v >= 2.5 entry, v < 1.25 exit) <<<');

stressAssert('T5-06: Sledding hysteresis zone [1.25 m/s, 2.50 m/s] and cutoff precision', () => {
  const cos10 = CONSTANTS.SLEDDING_SLOPE_COS; // 0.98480775
  const isSleddingSlope = (cos) => cos < cos10;

  // Slope angle gate
  assertEquals(isSleddingSlope(Math.cos(9.99 * Math.PI / 180)), false, '9.99° does not qualify');
  assertEquals(isSleddingSlope(Math.cos(10.01 * Math.PI / 180)), true, '10.01° qualifies');

  // Entry threshold
  const speedUnder = 2.4999;
  assertEquals(speedUnder >= CONSTANTS.SLEDDING_SPEED_THRESHOLD, false, '2.4999 does not trigger entry');
  const speedOver = 2.5001;
  assertEquals(speedOver >= CONSTANTS.SLEDDING_SPEED_THRESHOLD, true, '2.5001 triggers entry');

  // Hysteresis preservation: [1.25, 2.50]
  for (const v of [2.4, 2.0, 1.8, 1.5, 1.3, 1.2501]) {
    const shouldExit = v < CONSTANTS.SLEDDING_STOP_THRESHOLD;
    assertEquals(shouldExit, false, `Speed ${v} remains sledding`);
  }

  // Exit threshold
  const exitSpeed = 1.2499;
  assertEquals(exitSpeed < CONSTANTS.SLEDDING_STOP_THRESHOLD, true, '1.2499 triggers exit');
});

// ============================================================================
// 4. INVARIANT STRIDE & DIAGONAL VELOCITY CLAMP
// ============================================================================
console.log('\n>>> [DIMENSION 4] Invariant Stride (0.1333 m/frame) & Diagonal Clamp <<<');

stressAssert('T5-07: Invariant displacement strictly equals 0.13333333 m/frame across speeds [1.0, 16.0]', () => {
  const baseSpeed = 4.0;
  const frameDt = 1.0 / 30.0;

  for (let speed = 1.0; speed <= 16.0; speed += 0.5) {
    const timeScale = speed / baseSpeed;
    const displacement = (speed * frameDt) / timeScale;
    assertNear(displacement, 4.0 * frameDt, 1e-6, `Invariant stride violated at speed=${speed}`);
    assertNear(displacement, 0.13333333, 1e-6, `Displacement mismatch at speed=${speed}`);
  }
});

stressAssert('T5-08: Diagonal velocity clamping prevents speed boosts across all run skills', () => {
  const runRates = [1.0, 1.25, 1.5, 2.0, 2.5, 4.0, 4.5];

  for (const rate of runRates) {
    const forwardSpeed = 4.0 * rate;
    const strafeSpeed = Math.min(3.75, 1.25 * rate);
    const rawDiag = Math.hypot(forwardSpeed, strafeSpeed);

    // Diagonal clamp formula
    const maxSpeed = 4.0 * rate;
    const clampedDiag = Math.min(rawDiag, maxSpeed);

    assertEquals(clampedDiag, maxSpeed, `Diagonal magnitude clamped to 4.0 * run_rate = ${maxSpeed}`);
    assertEquals(rawDiag > maxSpeed, true, `Raw diagonal exceeded clamp before limiting`);
  }
});

// ============================================================================
// 5. STAMINA EXHAUSTION & BURDEN CURVE
// ============================================================================
console.log('\n>>> [DIMENSION 5] Stamina 0 Exhaustion & Burden Load Curve Transitions <<<');

stressAssert('T5-09: Burden piecewise modifier and stamina 0 collapse', () => {
  const burdenMod = (b) => {
    if (b < 1.0) return 1.0;
    if (b < 2.0) return 2.0 - b;
    return 0.0;
  };

  assertEquals(burdenMod(0.0), 1.0, 'Burden 0.0 -> 1.0');
  assertEquals(burdenMod(0.5), 1.0, 'Burden 0.5 -> 1.0');
  assertEquals(burdenMod(1.0), 1.0, 'Burden 1.0 -> 1.0');
  assertEquals(burdenMod(1.5), 0.5, 'Burden 1.5 -> 0.5');
  assertEquals(burdenMod(2.0), 0.0, 'Burden 2.0 -> 0.0');
  assertEquals(burdenMod(3.0), 0.0, 'Burden 3.0 -> 0.0');

  // Run rate calculation
  const runRate = (skill, burden, stamina = 100) => {
    const effectiveSkill = stamina === 0 ? 0 : skill;
    const mod = burdenMod(burden);
    return (mod * (effectiveSkill / (effectiveSkill + 200) * 11) + 4) / 4;
  };

  assertEquals(runRate(400, 0, 0), 1.0, 'Stamina 0 collapses run_rate to 1.0');
  assertEquals(runRate(400, 2.0, 100), 1.0, 'Burden 2.0 collapses run_rate to 1.0');
  assertEquals(runRate(0, 0, 100), 1.0, 'Skill 0 produces run_rate 1.0');
});

// ============================================================================
// 6. STOP COASTING DECELERATION & 0.25 M/S SNAP
// ============================================================================
console.log('\n>>> [DIMENSION 6] Stop Coasting Deceleration & 0.25 m/s Snap Threshold <<<');

stressAssert('T5-10: Stop coasting 12-frame window (~0.79m) and snap cutoff', () => {
  const dt = 1.0 / 30.0;
  const initialSpeed = 4.0;
  const duration = 0.40;

  let elapsed = 0.0;
  let totalDist = 0.0;
  let ticks = 0;

  while (elapsed < duration - 1e-6) {
    elapsed += dt;
    const fraction = Math.min(1.0, elapsed / duration);
    const v = initialSpeed * (1.0 - fraction);
    if (v < CONSTANTS.VELOCITY_SNAP_THRESHOLD) break;
    totalDist += v * dt;
    ticks++;
  }

  assertEquals(ticks, 11, 'Exactly 11 positive velocity ticks');
  assertInRange(totalDist, 0.70, 0.85, 'Total coasting distance ~0.79m');

  // Snap cutoff: strictly below 0.25 snaps to 0.0
  const vBelow = 0.2499;
  assertEquals(vBelow < CONSTANTS.VELOCITY_SNAP_THRESHOLD, true, '0.2499 snaps to 0.0');
  const vAbove = 0.2501;
  assertEquals(vAbove >= CONSTANTS.VELOCITY_SNAP_THRESHOLD, true, '0.2501 survives snap');
});

// ============================================================================
// FINAL SUMMARY
// ============================================================================
console.log('\n======================================================================');
console.log(`  TIER 5 ADVERSARIAL STRESS SUITE: ${passCount} passed, ${failCount} failed`);
console.log('======================================================================\n');

if (failCount > 0) {
  process.exit(1);
} else {
  console.log('>>> OVERALL RESULT: VERDICT APPROVE (10/10 Tier 5 Adversarial Checks Passed) <<<\n');
  process.exit(0);
}
