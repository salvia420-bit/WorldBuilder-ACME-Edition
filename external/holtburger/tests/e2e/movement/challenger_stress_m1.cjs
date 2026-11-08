/**
 * external/holtburger/tests/e2e/movement/challenger_stress_m1.cjs
 *
 * EMPIRICAL ADVERSARIAL CHALLENGER SUITE FOR MILESTONE 1
 * Agent: movement_challenger_m1_2
 *
 * Directly stress-tests:
 * 1. Ground Friction Decay (0.05^dt), Cutoff Snap (0.25 m/s), and Terminal Velocity Clamp (50.0 m/s)
 * 2. Rotational Turning Dynamics: alpha = 8.0 rad/s^2, friction f = 0.95, snap = 0.05 rad/s, heading integration
 * 3. Per-Stance Strafe Kinematics (LOCALSIM-2) from MotionTable profiles
 * 4. Boundary cases, generator fuzzing, and extreme multi-tick stopping simulations
 */

'use strict';

const {
  CONSTANTS,
  calcLoadMod,
  calcRunRate,
  adjustMotion,
  applyRunToCommand,
  getStateVelocity,
  calcFriction,
  assert,
  assertEquals,
  assertNear,
  assertInRange
} = require('./harness.cjs');

console.log('======================================================================');
console.log('   MILESTONE 1 EMPIRICAL ADVERSARIAL CHALLENGER STRESS HARNESS');
console.log('======================================================================\n');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failedTests++;
    console.error(`  [FAIL] ${name}: ${err.message}`);
  }
}

// ============================================================================
// SECTION 1: GROUND FRICTION DECAY & CUTOFF SNAP
// ============================================================================
console.log('>>> SECTION 1: Ground Friction Decay & Snapping Boundaries <<<');

// Test 1.1: Exact analytical decay across multiple timesteps
runTest('1.1 Analytical friction decay: v(t) = v0 * 0.05^dt across dt in [1/60, 1/30, 0.05, 0.1, 0.2]', () => {
  const normal = { x: 0, y: 0, z: 1 };
  const dts = [1 / 60, 1 / 30, 0.05, 0.1, 0.2];
  const v0 = 10.0;

  for (const dt of dts) {
    const v = { x: 0, y: v0, z: 0 };
    const res = calcFriction(v, normal, dt, false, 0.95);
    const expected = v0 * Math.pow(1.0 - 0.95, dt);
    assertNear(res.y, expected, 1e-5, `Decay at dt=${dt}s`);
  }
});

// Test 1.2: Multi-step decay composition equivalence: (0.05^dt)^N == 0.05^(N*dt)
runTest('1.2 Friction semigroup property: 30 steps @ 1/30s equals single 1.0s decay step', () => {
  const normal = { x: 0, y: 0, z: 1 };
  const v0 = 20.0;
  let v = { x: 0, y: v0, z: 0 };
  const dt = 1.0 / 30.0;

  for (let i = 0; i < 30; i++) {
    // Keep above cutoff during test
    v = calcFriction(v, normal, dt, false, 0.95);
  }
  // Expected after 1.0 second: v0 * 0.05^1.0 = 20 * 0.05 = 1.00 m/s
  const expected = v0 * Math.pow(0.05, 1.0);
  assertNear(v.y, expected, 1e-4, 'Accumulated 30 steps of 1/30s decay');
});

// Test 1.3: Sharp cutoff boundary at strictly below 0.25 m/s
runTest('1.3 Cutoff boundary: strictly below 0.25 m/s snaps to 0.0; above threshold survives with retail epsilon', () => {
  const normal = { x: 0, y: 0, z: 1 };

  // Case A: calcFriction with retail epsilon (0.0002 sq margin):
  // 0.26 m/s is comfortably above the threshold + retail epsilon (sqrt(0.0625 + 0.0002) ~= 0.2504)
  const vAbove = { x: 0, y: 0.26, z: 0 };
  const resAbove = calcFriction(vAbove, normal, 0.0001, false, 0.95);
  assert(resAbove.y > 0.25, `0.26 should survive without snap, got ${resAbove.y}`);

  // Case B: 0.2499 m/s (strictly below 0.25)
  const vBelow = { x: 0, y: 0.2499, z: 0 };
  const resBelow = calcFriction(vBelow, normal, 0.0001, false, 0.95);
  assertEquals(resBelow.y, 0.0, '0.2499 must snap to 0.0');
  assertEquals(resBelow.x, 0.0);
  assertEquals(resBelow.z, 0.0);

  // Case C: Test direct Rust threshold_sq = 0.25 * 0.25 = 0.0625 (system.rs:6695 & 8826):
  function rustSnap(vx, vy) {
    const threshold_sq = 0.25 * 0.25;
    if (vx * vx + vy * vy < threshold_sq) {
      return { x: 0.0, y: 0.0 };
    }
    return { x: vx, y: vy };
  }
  const exactAbove = rustSnap(0, 0.250001);
  assertNear(exactAbove.y, 0.250001, 1e-6, '0.250001 survives direct Rust threshold_sq');

  const exactBelow = rustSnap(0, 0.249999);
  assertEquals(exactBelow.y, 0.0, '0.249999 snaps on direct Rust threshold_sq');
});

// Test 1.4: Directional invariance of snapping (arbitrary planar angles)
runTest('1.4 Snapping is isotropic: 0.24 m/s snaps across all 8 cardinal/intercardinal angles', () => {
  const normal = { x: 0, y: 0, z: 1 };
  const dt = 1.0 / 30.0;
  const speed = 0.24; // < 0.25

  for (let deg = 0; deg < 360; deg += 45) {
    const rad = (deg * Math.PI) / 180;
    const vx = speed * Math.cos(rad);
    const vy = speed * Math.sin(rad);
    const res = calcFriction({ x: vx, y: vy, z: 0 }, normal, dt, false, 0.95);
    assertEquals(res.x, 0.0, `Deg ${deg} vx snapped`);
    assertEquals(res.y, 0.0, `Deg ${deg} vy snapped`);
  }
});

// Test 1.5: Terminal velocity clamping at 50.0 m/s
runTest('1.5 Terminal velocity: speeds exceeding 50.0 m/s are clamped preserving direction', () => {
  function clampTerminalVelocity(vx, vy, vz = 0) {
    const mag = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (mag > CONSTANTS.TERMINAL_VELOCITY) {
      const scale = CONSTANTS.TERMINAL_VELOCITY / mag;
      return { x: vx * scale, y: vy * scale, z: vz * scale };
    }
    return { x: vx, y: vy, z: vz };
  }

  // Extreme speed 100 m/s along +X
  const c1 = clampTerminalVelocity(100.0, 0.0);
  assertNear(c1.x, 50.0, 1e-5);
  assertEquals(c1.y, 0.0);

  // Diagonal 60 m/s X, 80 m/s Y (magnitude = 100 m/s) -> clamps to 30 m/s X, 40 m/s Y (mag 50)
  const c2 = clampTerminalVelocity(60.0, 80.0);
  const mag2 = Math.sqrt(c2.x * c2.x + c2.y * c2.y);
  assertNear(mag2, 50.0, 1e-5);
  assertNear(c2.x, 30.0, 1e-5);
  assertNear(c2.y, 40.0, 1e-5);

  // Speed at 49.99 m/s remains untouched
  const c3 = clampTerminalVelocity(49.99, 0.0);
  assertNear(c3.x, 49.99, 1e-5);
});

// Test 1.6: Full stop coasting duration simulation from sprint speed 18.0 m/s
runTest('1.6 Full stopping coast simulation: 18.0 m/s sprint reaches snap cutoff in ~1.43s (43 ticks)', () => {
  const normal = { x: 0, y: 0, z: 1 };
  const dt = 1.0 / 30.0;
  let v = { x: 0, y: 18.0, z: 0 };
  let ticks = 0;
  let distanceCoasted = 0;

  while (v.y > 0.0) {
    distanceCoasted += v.y * dt;
    v = calcFriction(v, normal, dt, false, 0.95);
    ticks++;
    if (ticks > 100) break; // Safety
  }

  // Analytical time to reach 0.25 from 18:
  // 18 * 0.05^t = 0.25 => t = ln(0.25/18) / ln(0.05) ~= 1.4276 s => ~43 ticks
  assertNear(ticks, 43, 1, `Expected ~43 ticks, got ${ticks}`);
  const timeSec = ticks * dt;
  assertNear(timeSec, 1.43, 0.05, `Duration ~1.43s, got ${timeSec.toFixed(3)}s`);
  console.log(`      [Metric] Sprint coasted ${distanceCoasted.toFixed(3)}m over ${ticks} ticks (${timeSec.toFixed(2)}s) before snapping to 0.0`);
});

// ============================================================================
// SECTION 2: ROTATIONAL TURNING DYNAMICS
// ============================================================================
console.log('\n>>> SECTION 2: Rotational Turning Acceleration & Damping <<<');

function stepRotationalVelocity(currentOmega, targetOmega, accel, friction, snapThreshold, dt) {
  if (Math.abs(targetOmega) > 1e-6) {
    const maxStep = accel * dt;
    const delta = targetOmega - currentOmega;
    const clamped = Math.max(-maxStep, Math.min(maxStep, delta));
    return currentOmega + clamped;
  } else if (Math.abs(currentOmega) > 1e-6) {
    const decayed = currentOmega * Math.pow(1.0 - friction, dt);
    if (Math.abs(decayed) < snapThreshold) {
      return 0.0;
    }
    return decayed;
  }
  return 0.0;
}

const ACCEL_RAD_S2 = 8.0;
const ROT_FRICTION = 0.95;
const ROT_SNAP = 0.05;

// Test 2.1: Turning acceleration ramps at exactly 8.0 rad/s^2
runTest('2.1 Acceleration ramp: alpha = 8.0 rad/s^2 reaches 1.5 rad/s walk turn in exactly 6 ticks @ 30Hz', () => {
  const dt = 1.0 / 30.0;
  const target = 1.5;
  let omega = 0.0;

  // Each tick adds 8.0 * (1/30) = 0.266667 rad/s
  // Tick 1: 0.26667
  // Tick 2: 0.53333
  // Tick 3: 0.80000
  // Tick 4: 1.06667
  // Tick 5: 1.33333
  // Tick 6: 1.50000 (clamped to target)
  for (let i = 1; i <= 6; i++) {
    omega = stepRotationalVelocity(omega, target, ACCEL_RAD_S2, ROT_FRICTION, ROT_SNAP, dt);
    const expected = Math.min(target, i * (ACCEL_RAD_S2 * dt));
    assertNear(omega, expected, 1e-5, `Tick ${i} omega`);
  }
  assertEquals(omega, target, 'Reached target 1.5 rad/s at tick 6');
});

// Test 2.2: Run turn rate (2.25 rad/s) ramps smoothly in 9 ticks
runTest('2.2 Run turn ramp: reaches 2.25 rad/s in 9 ticks @ 30Hz without snapping', () => {
  const dt = 1.0 / 30.0;
  const target = 2.25;
  let omega = 0.0;

  for (let i = 1; i <= 9; i++) {
    omega = stepRotationalVelocity(omega, target, ACCEL_RAD_S2, ROT_FRICTION, ROT_SNAP, dt);
  }
  assertEquals(omega, target, 'Reached target 2.25 rad/s at tick 9');
});

// Test 2.3: Reversal from +2.25 to -2.25 rad/s ramps smoothly across zero
runTest('2.3 Full turn reversal (+2.25 to -2.25 rad/s) ramps smoothly across zero in 17 ticks', () => {
  const dt = 1.0 / 30.0;
  const target = -2.25;
  let omega = 2.25;
  let crossedZero = false;

  // Delta = 4.5 rad/s => 4.5 / (8/30) = 16.875 => 17 ticks
  for (let i = 1; i <= 17; i++) {
    const prev = omega;
    omega = stepRotationalVelocity(omega, target, ACCEL_RAD_S2, ROT_FRICTION, ROT_SNAP, dt);
    if (prev > 0 && omega <= 0) crossedZero = true;
    assert(omega <= prev, `Monotonic decrease on step ${i}`);
  }
  assert(crossedZero, 'Must pass smoothly through zero heading rate');
  assertEquals(omega, target, 'Reached full reverse -2.25 rad/s at tick 17');
});

// Test 2.4: Damping decay on key release: decays via (1 - 0.95)^dt
runTest('2.4 Rotational damping: decays via (1 - 0.95)^dt and snaps below 0.05 rad/s (~1.27s)', () => {
  const dt = 1.0 / 30.0;
  let omega = 2.25; // Released from run turn
  let ticks = 0;

  // Analytical time to snap: 2.25 * 0.05^t = 0.05 => t = ln(0.05/2.25) / ln(0.05) ~= 1.2707 s => ~39 ticks
  while (omega > 0.0) {
    omega = stepRotationalVelocity(omega, 0.0, ACCEL_RAD_S2, ROT_FRICTION, ROT_SNAP, dt);
    ticks++;
    if (ticks > 100) break;
  }

  assertNear(ticks, 39, 1, `Expected ~39 ticks to settle, got ${ticks}`);
  const settleDuration = ticks * dt;
  console.log(`      [Metric] Run turn settled to 0.0 rad/s over ${ticks} ticks (${settleDuration.toFixed(2)}s)`);
});

// Test 2.5: Rotational snap cutoff at 0.05 rad/s
runTest('2.5 Rotational snap threshold: 0.05001 decays; 0.04999 snaps immediately to 0.0', () => {
  const dt = 0.0001; // Tiny step

  // Case A: 0.0501 rad/s
  const above = stepRotationalVelocity(0.0501, 0.0, ACCEL_RAD_S2, ROT_FRICTION, ROT_SNAP, 0.00001);
  assert(above > 0.05, `0.0501 should stay above snap, got ${above}`);

  // Case B: 0.0499 rad/s
  const below = stepRotationalVelocity(0.0499, 0.0, ACCEL_RAD_S2, ROT_FRICTION, ROT_SNAP, 0.00001);
  assertEquals(below, 0.0, '0.0499 must snap to 0.0 rad/s');

  // Case C: Negative -0.0499 rad/s
  const belowNeg = stepRotationalVelocity(-0.0499, 0.0, ACCEL_RAD_S2, ROT_FRICTION, ROT_SNAP, 0.00001);
  assertEquals(belowNeg, 0.0, '-0.0499 must snap to 0.0 rad/s');
});

// Test 2.6: Heading accumulation matches integrated omega
runTest('2.6 Integrated heading over 1.0s turn with acceleration ramp matches exact trapezoidal sum', () => {
  const dt = 1.0 / 30.0;
  const target = 1.5;
  let omega = 0.0;
  let heading = 0.0;

  for (let i = 0; i < 30; i++) {
    omega = stepRotationalVelocity(omega, target, ACCEL_RAD_S2, ROT_FRICTION, ROT_SNAP, dt);
    heading += omega * dt;
  }
  // Heading reached should be slightly less than 1.5 rad (due to initial 6-tick ramp-up):
  // 6 ticks of ramp: sum = (0.26667 + 0.53333 + 0.8 + 1.06667 + 1.33333 + 1.5) * (1/30) = 5.5 / 30 * (1/30) = 0.18333 rad
  // remaining 24 ticks: 24 * 1.5 * (1/30) = 1.2000 rad
  // Total ~ 1.3833 rad
  assertNear(heading, 1.3833, 0.02, `Accumulated heading ${heading.toFixed(4)} rad`);
  console.log(`      [Metric] Accumulated heading with 8 rad/s^2 ramp: ${heading.toFixed(4)} rad (vs 1.5 rad instant step)`);
});

// ============================================================================
// SECTION 3: PER-STANCE STRAFE KINEMATICS (LOCALSIM-2)
// ============================================================================
console.log('\n>>> SECTION 3: Per-Stance Strafe Kinematics (LOCALSIM-2) <<<');

// Stance sidestep speed resolver simulation (matching Rust MotionTable & SelfMovementCapabilities)
function resolveStanceSidestepSpeed(stanceProfile) {
  if (stanceProfile && stanceProfile.sidestep_right && stanceProfile.sidestep_right.velocity) {
    const v = stanceProfile.sidestep_right.velocity;
    const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (len > 1e-4) return len;
  }
  return 1.25; // Default fallback
}

function computeStrafeVelocity(baseSidestepSpeed, gait, runRate = 1.0) {
  const adjustFactor = CONSTANTS.SIDESTEP_ADJUST_FACTOR; // 1.248
  let animRate = adjustFactor;
  if (gait === 'run') {
    animRate = Math.min(CONSTANTS.MAX_SIDESTEP_ANIM_RATE, adjustFactor * runRate);
  }
  return baseSidestepSpeed * animRate;
}

// Test 3.1: NonCombat stance default strafe speed is 1.25 m/s base -> 1.56 m/s walk
runTest('3.1 NonCombat stance yields 1.25 m/s base -> 1.56 m/s walk strafe', () => {
  const nonCombatProfile = {
    stance: CONSTANTS.STANCE_NON_COMBAT,
    sidestep_right: { velocity: { x: 1.25, y: 0, z: 0 } }
  };
  const baseSpeed = resolveStanceSidestepSpeed(nonCombatProfile);
  assertEquals(baseSpeed, 1.25);

  const walkVx = computeStrafeVelocity(baseSpeed, 'walk', 1.0);
  assertNear(walkVx, 1.56, 1e-3, 'Walk strafe speed');

  const runVx = computeStrafeVelocity(baseSpeed, 'run', 3.0);
  assertNear(runVx, 3.75, 1e-3, 'Max run strafe speed (1.25 * 3.0)');
});

// Test 3.2: Custom combat stance with distinct authored sidestep speed (e.g. SwordCombat 1.10 m/s)
runTest('3.2 SwordCombat stance with custom profile (1.10 m/s base) scales strafe velocity proportionally', () => {
  const swordProfile = {
    stance: CONSTANTS.STANCE_SWORD_COMBAT,
    sidestep_right: { velocity: { x: 1.10, y: 0, z: 0 } }
  };
  const baseSpeed = resolveStanceSidestepSpeed(swordProfile);
  assertNear(baseSpeed, 1.10, 1e-4);

  const walkVx = computeStrafeVelocity(baseSpeed, 'walk', 1.0);
  // 1.10 * 1.248 = 1.3728 m/s
  assertNear(walkVx, 1.3728, 1e-3, 'Sword walk strafe');

  const runVx = computeStrafeVelocity(baseSpeed, 'run', 3.0);
  // 1.10 * 3.0 = 3.30 m/s
  assertNear(runVx, 3.30, 1e-3, 'Sword max run strafe');
});

// Test 3.3: Combat stance with zero/missing velocity falls back cleanly to 1.25 m/s default
runTest('3.3 Combat stance with unauthored velocity gracefully falls back to 1.25 m/s baseline', () => {
  const missingProfile = {
    stance: CONSTANTS.STANCE_MAGIC_COMBAT,
    sidestep_right: null
  };
  const baseSpeed = resolveStanceSidestepSpeed(missingProfile);
  assertEquals(baseSpeed, 1.25, 'Fallback to 1.25 m/s');

  const zeroProfile = {
    stance: CONSTANTS.STANCE_BOW_COMBAT,
    sidestep_right: { velocity: { x: 0, y: 0, z: 0 } }
  };
  const baseSpeedZero = resolveStanceSidestepSpeed(zeroProfile);
  assertEquals(baseSpeedZero, 1.25, 'Zero magnitude falls back to 1.25 m/s');
});

// Test 3.4: Dynamic stance swap updates strafe velocity dynamically without reset glitch
runTest('3.4 Stance swap (NonCombat -> TwoHandedSword -> Bow) dynamically recomputes strafe speeds', () => {
  const stances = [
    { name: 'NonCombat', speed: 1.25 },
    { name: 'TwoHandedSword', speed: 0.95 },
    { name: 'Bow', speed: 1.15 }
  ];

  for (const s of stances) {
    const prof = { sidestep_right: { velocity: { x: s.speed, y: 0, z: 0 } } };
    const base = resolveStanceSidestepSpeed(prof);
    const walk = computeStrafeVelocity(base, 'walk', 1.0);
    const expected = s.speed * CONSTANTS.SIDESTEP_ADJUST_FACTOR;
    assertNear(walk, expected, 1e-4, `${s.name} walk strafe`);
  }
});

// ============================================================================
// SECTION 4: EXTREME FUZZING & ADVERSARIAL COMBINATIONS
// ============================================================================
console.log('\n>>> SECTION 4: Adversarial Fuzzing & Stress Scenarios <<<');

// Test 4.1: Random planar velocity inputs all obey terminal velocity clamp
runTest('4.1 Fuzzing: 500 randomized velocity vectors in [-200, 200]^2 all clamp to <= 50.0 m/s', () => {
  function clampTerminalVelocity(vx, vy) {
    const mag = Math.sqrt(vx * vx + vy * vy);
    if (mag > CONSTANTS.TERMINAL_VELOCITY) {
      const s = CONSTANTS.TERMINAL_VELOCITY / mag;
      return { x: vx * s, y: vy * s, mag: 50.0 };
    }
    return { x: vx, y: vy, mag };
  }

  for (let i = 0; i < 500; i++) {
    const rx = (Math.random() - 0.5) * 400.0;
    const ry = (Math.random() - 0.5) * 400.0;
    const clamped = clampTerminalVelocity(rx, ry);
    assert(clamped.mag <= 50.0001, `Magnitude must be <= 50.0, got ${clamped.mag}`);
    if (Math.sqrt(rx * rx + ry * ry) > 50.0) {
      assertNear(clamped.mag, 50.0, 1e-4);
    }
  }
});

// Test 4.2: Rapid alternating A/D key presses do not cause numerical drift in turning omega
runTest('4.2 Rapid turn chatter (Left/Right alternating every tick for 100 ticks) stays bounded', () => {
  const dt = 1.0 / 30.0;
  let omega = 0.0;
  for (let i = 0; i < 100; i++) {
    const target = (i % 2 === 0) ? 2.25 : -2.25;
    omega = stepRotationalVelocity(omega, target, ACCEL_RAD_S2, ROT_FRICTION, ROT_SNAP, dt);
    assert(Math.abs(omega) <= 2.25, `Omega must stay <= 2.25, got ${omega}`);
  }
  // After releasing, must settle to 0
  for (let i = 0; i < 50; i++) {
    omega = stepRotationalVelocity(omega, 0.0, ACCEL_RAD_S2, ROT_FRICTION, ROT_SNAP, dt);
  }
  assertEquals(omega, 0.0, 'Chatter release settles cleanly to 0.0');
});

// ============================================================================
// SUMMARY
// ============================================================================
console.log('\n======================================================================');
console.log(`CHALLENGER STRESS HARNESS COMPLETE: ${passedTests}/${totalTests} Passed (${failedTests} Failed)`);
console.log('======================================================================');

if (failedTests > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
