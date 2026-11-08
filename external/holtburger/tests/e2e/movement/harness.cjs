/**
 * external/holtburger/tests/e2e/movement/harness.cjs
 *
 * Authoritative E2E Test Harness & Oracle Engine for Holtburger-Web Player Movement System.
 * Mined directly from Asheron's Call client decompilation (acclient.c), OpenAC (MovementSystem.cs,
 * MotionInterpreter.cs, TransitionTypes.cs), and WebAC.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ============================================================================
// 1. AUTHORITATIVE ENGINE CONSTANTS
// ============================================================================
const CONSTANTS = {
  // Motion Command Identifiers (acclient.c:43864-43940)
  CMD_READY: 0x41000003,
  CMD_STOP: 0x40000004,
  CMD_WALK_FORWARD: 0x45000005,
  CMD_WALK_BACKWARD: 0x45000006,
  CMD_RUN_FORWARD: 0x44000007,
  CMD_FALLEN: 0x40000008,
  CMD_TURN_RIGHT: 0x6500000D,
  CMD_TURN_LEFT: 0x6500000E,
  CMD_SIDESTEP_RIGHT: 0x6500000F,
  CMD_SIDESTEP_LEFT: 0x65000010,
  CMD_CROUCH: 0x41000012,
  CMD_SITTING: 0x41000013,
  CMD_SLEEPING: 0x41000014,
  CMD_FALLING: 0x40000015,
  CMD_JUMP: 0x2500003B,
  CMD_JUMP_CHARGING: 0x4000001D,

  // Stance Identifiers (acclient.c:337640-337750)
  STANCE_NON_COMBAT: 0x8000003D,
  STANCE_HAND_COMBAT: 0x8000003C,
  STANCE_SWORD_COMBAT: 0x8000003E,
  STANCE_BOW_COMBAT: 0x8000003F,
  STANCE_SWORD_SHIELD_COMBAT: 0x80000040,
  STANCE_CROSSBOW_COMBAT: 0x80000041,
  STANCE_TWO_HANDED_SWORD_COMBAT: 0x80000044,
  STANCE_TWO_HANDED_STAFF_COMBAT: 0x80000045,
  STANCE_DUAL_WIELD_COMBAT: 0x80000046,
  STANCE_THROWN_WEAPON_COMBAT: 0x80000047,
  STANCE_MAGIC_COMBAT: 0x80000049,

  // Speed and Kinematic Constants (acclient.c:343539-343594, 343746-343804)
  WALK_ANIM_SPEED: 3.1199999,      // Closed-form target walk speed (m/s)
  CYCLE_BASE_WALK_SPEED: 2.6017,   // Authored cycle base speed in 0x09000001 (m/s)
  RUN_ANIM_SPEED: 4.0000000,       // Closed-form target run speed (m/s)
  CYCLE_BASE_RUN_SPEED: 4.0000,    // Authored cycle base speed in 0x09000001 (m/s)
  SIDESTEP_ANIM_SPEED: 1.2500000,  // Sidestep baseline (m/s)
  SIDESTEP_ADJUST_FACTOR: 1.24799996, // 3.1199999 / 1.25 * 0.5
  BACKWARDS_FACTOR: -0.64999998,   // Canonical backward multiplier
  RUN_TURN_FACTOR: 1.5000000,      // Run turn multiplier
  MAX_SIDESTEP_ANIM_RATE: 3.0000000, // Maximum sidestep rate clamp

  // Angular / Turn Velocities (rad/s)
  BASE_TURN_OMEGA: 1.5000000,      // Walk turn rate
  RUN_TURN_OMEGA: 2.2500000,       // Run turn rate (1.5 * 1.5)

  // Physics, Friction, & Timestep Constants (acclient.c:316091, 317700)
  DEFAULT_FRICTION: 0.95,          // Ground friction coefficient
  VELOCITY_SNAP_THRESHOLD: 0.25,   // Below 0.25 m/s snaps to (0,0,0)
  VELOCITY_SNAP_THRESHOLD_SQ: 0.0625,
  TERMINAL_VELOCITY: 50.0,         // Global physics terminal speed clamp (m/s)
  TERMINAL_VELOCITY_SQ: 2500.0,
  GRAVITY: -9.8000002,             // Gravity downward acceleration (m/s2)
  PHYSICS_HZ: 30,                  // Discrete substepped physics frequency
  DT_30HZ: 1.0 / 30.0,

  // Slope and Sledding Constants (acclient.c:800530, 316124)
  FLOOR_Z: 0.66417414,             // cos(3437.74677 deg) = cos(60 * 180 / PI) ~= 48.381 deg
  WALKABLE_SLOPE_MAX_DEG: 48.381,  // Maximum angle walkable without sliding
  SLEDDING_FRICTION: 0.2,          // Low friction on steep terrain slide
  SLEDDING_SLOPE_COS: 0.98480775,  // cos(10 deg)
  SLEDDING_SPEED_THRESHOLD: 2.5,   // Speed required to engage 0.2 sledding friction
  SLEDDING_STOP_THRESHOLD: 1.25,    // Below 1.25 m/s, friction forced to 1.0 (halt)

  // Jump Constants (acclient.c:713808, 443780)
  JUMP_MIN_HEIGHT: 0.35,           // Minimum apex height (meters)
  JUMP_MIN_IMPULSE: Math.sqrt(19.6 * 0.35), // sqrt(6.86) ~= 2.61916 m/s
  JUMP_POWER_FULL_HOLD_S: 1.0,     // 1000 ms full charge

  // Animation Playback & Invariant Metrics (acclient.c:337445, MotionTable 0x09000001)
  RUN_AUTHORED_METERS: 3.200000,
  RUN_AUTHORED_FRAMES: 24,
  RUN_AUTHORED_FPS: 30.0,
  RUN_INVARIANT_FRAME_DISPLACEMENT: 0.13333333, // 3.2 / 24 = 0.13333 m/frame (foot invariant)
  WALK_AUTHORED_METERS: 1.400000,
  WALK_AUTHORED_FRAMES: 36,
  WALK_AUTHORED_FPS: 66.8571,

  // Deceleration & Coasting Metrics (acclient.c:340719, LOCALSIM-3)
  RUN_TO_READY_COAST_DISTANCE: 0.79, // Meters coasted during stopping transition
  RUN_TO_READY_COAST_DURATION: 0.40, // Seconds over which stopping link executes

  // Crossfade Blend Standards (animation.js)
  CROSSFADE_LOCO_MS: 120,
  CROSSFADE_STANCE_MS: 150,
  CROSSFADE_TAKEOFF_MS: 80,
  CROSSFADE_LANDING_MS: 60,
};

// ============================================================================
// 2. AUTHORITATIVE ORACLE MATHEMATICAL FUNCTIONS (acclient.c parity)
// ============================================================================

/**
 * EncumbranceSystem::LoadMod (acclient.c:296777)
 */
function calcLoadMod(load) {
  const l = Number(load);
  if (isNaN(l) || l < 0) return 1.0;
  if (l >= 1.0) {
    if (l >= 2.0) return 0.0;
    return 2.0 - l;
  }
  return 1.0;
}

/**
 * MovementSystem::GetRunRate (acclient.c:713789)
 */
function calcRunRate(load, runSkill, stamina = 100, scaling = 1.0) {
  let skill = Number(runSkill);
  if (isNaN(skill) || skill < 0) skill = 0;
  if (stamina <= 0) skill = 0; // Exhaustion clamp (acclient.c:443695)
  if (skill === 800.0) return 18.0 / 4.0; // Exact retail cap 4.5

  const loadMod = calcLoadMod(load);
  const s = scaling > 0 ? scaling : 1.0;
  return (loadMod * (skill / (skill + 200.0) * 11.0) + 4.0) / s / 4.0;
}

/**
 * MovementSystem::GetJumpHeight (acclient.c:713808)
 */
function calcJumpHeight(load, jumpSkill, power = 1.0, stamina = 100, scaling = 1.0) {
  let skill = Number(jumpSkill);
  if (isNaN(skill) || skill < 0) skill = 0;
  if (stamina <= 0) skill = 0; // Exhaustion clamp (acclient.c:443780)

  const clampedPower = Math.max(0.0, Math.min(1.0, Number(power)));
  const loadMod = calcLoadMod(load);
  const s = scaling > 0 ? scaling : 1.0;
  let height = loadMod * (skill / (skill + 1300.0) * 22.200001 + 0.050000001) * clampedPower / s;
  if (height < CONSTANTS.JUMP_MIN_HEIGHT) {
    height = CONSTANTS.JUMP_MIN_HEIGHT;
  }
  return height;
}

/**
 * CACQualities::InqJumpVelocity (acclient.c:443780)
 */
function calcJumpLaunchVelocity(height) {
  const h = Math.max(CONSTANTS.JUMP_MIN_HEIGHT, Number(height));
  return Math.sqrt(h * 19.6);
}

/**
 * CMotionInterp::adjust_motion (acclient.c:343746-343804)
 */
function adjustMotion(command, speed) {
  let motion = command;
  let spd = Number(speed);

  // TurnLeft -> TurnRight with negated speed
  if (motion === CONSTANTS.CMD_TURN_LEFT) {
    motion = CONSTANTS.CMD_TURN_RIGHT;
    spd = spd * -1.0;
  }

  // WalkBackward -> WalkForward with -0.65x speed
  if (motion === CONSTANTS.CMD_WALK_BACKWARD) {
    motion = CONSTANTS.CMD_WALK_FORWARD;
    spd = spd * CONSTANTS.BACKWARDS_FACTOR;
  }

  // Sidestep adjustment
  if (motion === CONSTANTS.CMD_SIDESTEP_RIGHT) {
    spd = spd * CONSTANTS.SIDESTEP_ADJUST_FACTOR;
  } else if (motion === CONSTANTS.CMD_SIDESTEP_LEFT) {
    motion = CONSTANTS.CMD_SIDESTEP_RIGHT;
    spd = -1.0 * spd * CONSTANTS.SIDESTEP_ADJUST_FACTOR;
  }

  return { command: motion, speed: spd };
}

/**
 * CMotionInterp::apply_run_to_command (acclient.c:343439-343485)
 */
function applyRunToCommand(command, speed, runRate) {
  let motion = command;
  let spd = Number(speed);
  const rate = Number(runRate);

  switch (motion) {
    case CONSTANTS.CMD_WALK_FORWARD:
      // WalkForward promotes to RunForward ONLY if forward speed > 0
      if (spd > 0.0) {
        motion = CONSTANTS.CMD_RUN_FORWARD;
        spd = rate * spd;
      }
      // If spd < 0 (backward walk), remains WalkForward with negative speed (no promotion!)
      break;

    case CONSTANTS.CMD_TURN_RIGHT:
      spd = CONSTANTS.RUN_TURN_FACTOR * spd;
      break;

    case CONSTANTS.CMD_SIDESTEP_RIGHT:
      const v = rate * spd;
      spd = Math.max(-CONSTANTS.MAX_SIDESTEP_ANIM_RATE, Math.min(CONSTANTS.MAX_SIDESTEP_ANIM_RATE, v));
      break;

    default:
      break;
  }

  return { command: motion, speed: spd };
}

/**
 * CMotionInterp::get_state_velocity (acclient.c:343539-343594)
 */
function getStateVelocity(forwardCmd, forwardSpeed, sidestepCmd, sidestepSpeed, runRate) {
  let vx = 0.0;
  let vy = 0.0;
  const vz = 0.0;

  // Sidestep component (X)
  if (sidestepCmd === CONSTANTS.CMD_SIDESTEP_RIGHT) {
    vx = CONSTANTS.SIDESTEP_ANIM_SPEED * sidestepSpeed;
  }

  // Forward component (Y)
  if (forwardCmd === CONSTANTS.CMD_WALK_FORWARD) {
    vy = CONSTANTS.WALK_ANIM_SPEED * forwardSpeed;
  } else if (forwardCmd === CONSTANTS.CMD_RUN_FORWARD) {
    vy = CONSTANTS.RUN_ANIM_SPEED * forwardSpeed;
  }

  // Max planar speed clamp: max_speed = run_rate * 4.0
  const maxSpeed = Number(runRate) * CONSTANTS.RUN_ANIM_SPEED;
  const mag = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (mag > maxSpeed && mag > 1e-9) {
    vx = (vx / mag) * maxSpeed;
    vy = (vy / mag) * maxSpeed;
  }

  return { vx, vy, vz, mag: Math.sqrt(vx * vx + vy * vy) };
}

/**
 * CPhysicsObj::calc_friction (acclient.c:316091-316145)
 */
function calcFriction(v, surfaceNormal, quantum, isSledding = false, defaultFriction = CONSTANTS.DEFAULT_FRICTION) {
  let { x, y, z } = v;
  const { x: nx, y: ny, z: nz } = surfaceNormal;

  const vDotN = x * nx + y * ny + z * nz;
  if (vDotN >= 0.25) {
    // Moving away from surface: NO friction applied
    return { x, y, z };
  }

  // Strip normal component
  x -= nx * vDotN;
  y -= ny * vDotN;
  z -= nz * vDotN;

  let velocityMag2 = x * x + y * y + z * z;
  let frict = defaultFriction;

  if (isSledding) {
    frict = CONSTANTS.SLEDDING_FRICTION;
    if (velocityMag2 >= 1.5625) { // 1.25^2
      if (velocityMag2 < 6.25 || nz >= CONSTANTS.SLEDDING_SLOPE_COS) {
        frict = defaultFriction;
      }
    } else {
      frict = 1.0; // Arrest motion completely below 1.25 m/s
    }
  }

  // Exponential decay
  const decay = Math.pow(Math.max(0.0, 1.0 - frict), quantum);
  x *= decay;
  y *= decay;
  z *= decay;

  // Small velocity cutoff (0.25 m/s)
  velocityMag2 = x * x + y * y + z * z;
  if (velocityMag2 - CONSTANTS.VELOCITY_SNAP_THRESHOLD_SQ < 0.0002) {
    x = 0.0;
    y = 0.0;
    z = 0.0;
  }

  return { x, y, z };
}

/**
 * Slope Walkability Check (acclient.c:800530)
 */
function isWalkableSlope(normal) {
  const len = Math.sqrt(normal.x * normal.x + normal.y * normal.y + normal.z * normal.z);
  if (len < 1e-6) return false;
  const nz = normal.z / len;
  return nz >= CONSTANTS.FLOOR_Z;
}

/**
 * Slide acceleration down steep slope (acclient.c:317814, 358899)
 */
function calcSlopeSlideAcceleration(normal, gravity = CONSTANTS.GRAVITY) {
  const len = Math.sqrt(normal.x * normal.x + normal.y * normal.y + normal.z * normal.z);
  const nx = normal.x / len;
  const ny = normal.y / len;
  const nz = normal.z / len;

  // g = (0, 0, gravity)
  const gDotN = gravity * nz;
  const ax = 0.0 - gDotN * nx;
  const ay = 0.0 - gDotN * ny;
  const az = gravity - gDotN * nz;

  return { ax, ay, az };
}

/**
 * Animation playback timeScale scaling (acclient.c:337445)
 */
function calcTimeScale(groundSpeed, isRun = true) {
  const baseSpeed = isRun ? CONSTANTS.CYCLE_BASE_RUN_SPEED : CONSTANTS.CYCLE_BASE_WALK_SPEED;
  const ratio = Math.abs(groundSpeed) / baseSpeed;
  return Math.max(0.25, Math.min(4.0, ratio));
}

/**
 * Stance Transition Link Routing (acclient.c:337750)
 */
function getStanceTransitionRoute(sourceStance, targetStance) {
  if (sourceStance === targetStance) return [];
  if (sourceStance === CONSTANTS.STANCE_NON_COMBAT || targetStance === CONSTANTS.STANCE_NON_COMBAT) {
    return [targetStance];
  }
  // 2-hop route via NonCombat
  return [CONSTANTS.STANCE_NON_COMBAT, targetStance];
}

// ============================================================================
// 3. TEST SUITE & REGISTRY HARNESS
// ============================================================================

class TestSuite {
  constructor(name, tier) {
    this.name = name;
    this.tier = tier;
    this.tests = [];
  }

  addTest(name, fn, meta = {}) {
    this.tests.push({ name, fn, meta });
  }

  async run(runnerContext = {}) {
    const results = {
      suite: this.name,
      tier: this.tier,
      passed: 0,
      failed: 0,
      tests: [],
      durationMs: 0
    };
    const t0 = Date.now();

    for (const test of this.tests) {
      const testResult = {
        name: test.name,
        status: 'passed',
        durationMs: 0,
        error: null,
        meta: test.meta
      };
      const start = Date.now();
      try {
        await test.fn();
        testResult.status = 'passed';
        results.passed++;
        if (runnerContext.verbose) {
          console.log(`    ✓ [PASS] ${test.name}`);
        }
      } catch (err) {
        testResult.status = 'failed';
        testResult.error = err.message;
        testResult.stack = err.stack;
        results.failed++;
        console.error(`    ✗ [FAIL] ${test.name}: ${err.message}`);
        if (runnerContext.verbose && err.stack) {
          console.error(`      ${err.stack.split('\n').slice(1, 4).join('\n      ')}`);
        }
      }
      testResult.durationMs = Date.now() - start;
      results.tests.push(testResult);
    }
    results.durationMs = Date.now() - t0;
    return results;
  }
}

function createSuite(name, tier) {
  return new TestSuite(name, tier);
}

// Assertions
function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'Assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNear(actual, expected, tolerance = 1e-4, message) {
  const diff = Math.abs(actual - expected);
  if (diff > tolerance) {
    throw new Error(`${message || 'Assertion near failed'}: actual ${actual} vs expected ${expected} (diff: ${diff}, tol: ${tolerance})`);
  }
}

function assertInRange(val, min, max, message) {
  if (val < min || val > max) {
    throw new Error(`${message || 'Assertion in range failed'}: ${val} outside [${min}, ${max}]`);
  }
}

function assertThrows(fn, expectedSubstr, message) {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    if (expectedSubstr && !err.message.includes(expectedSubstr)) {
      throw new Error(`${message || 'Error message mismatch'}: expected substring "${expectedSubstr}", got "${err.message}"`);
    }
  }
  if (!threw) {
    throw new Error(`${message || 'Expected function to throw but succeeded'}`);
  }
}

module.exports = {
  CONSTANTS,
  calcLoadMod,
  calcRunRate,
  calcJumpHeight,
  calcJumpLaunchVelocity,
  adjustMotion,
  applyRunToCommand,
  getStateVelocity,
  calcFriction,
  isWalkableSlope,
  calcSlopeSlideAcceleration,
  calcTimeScale,
  getStanceTransitionRoute,
  TestSuite,
  createSuite,
  assert,
  assertEquals,
  assertNear,
  assertInRange,
  assertThrows
};
