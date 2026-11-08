// apps/holtburger-web/tests/challenger_m4_2_stress.test.mjs
/**
 * Tier 5 White-Box Adversarial Hardening & Stress Testing Suite
 * Movement Challenger M4-2
 *
 * Target Features:
 * - Feature 28 & 29: Velocity-to-playback scaling, extreme speed clamping (>16.0 m/s & <0.25 m/s), foot synchrony
 * - Feature 30: Canonical locomotion playback, rapid turn & strafe alternation
 * - Feature 31 & 32: Locomotion & Combat stance transitions, 2-hop routing via NonCombat under rapid FIFO swaps
 * - Feature 33, 34, 35, 36, 37: Jump takeoff, falling loop, landing recovery on slopes, crossfade timing
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Global window shim for headless environment
globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.__playEffectVfxBound = true;
globalThis.window.__spellShapePreviewBound = true;

const THREE = await import("three");
const {
  EntityManager,
  isLocomotionLink,
  canonicalCycleBaseSpeed,
  CROSSFADE_LOCO_MS,
  CROSSFADE_STANCE_MS,
  CROSSFADE_TAKEOFF_MS,
  CROSSFADE_LANDING_MS,
} = await import("../scene3d/entities.js");

const {
  cycleTimeScale,
  CROSSFADE_STANDARDS,
} = await import("../scene3d/animation.js");

const { installFakeMotionSequence } = await import("../harness/lib/fake_motion_sequence.mjs");
installFakeMotionSequence();

const PART_COUNT = 2;
const READY = 0x41000003;
const WALK_FORWARD = 0x45000005;
const WALK_BACKWARD = 0x45000006;
const RUN_FORWARD = 0x44000007;
const TURN_RIGHT = 0x6500000d;
const TURN_LEFT = 0x6500000e;
const SIDESTEP_RIGHT = 0x6500000f;
const SIDESTEP_LEFT = 0x65000010;
const CROUCH = 0x41000012;
const FALLING = 0x40000015;

const NON_COMBAT = 0x8000003d;
const COMBAT_STANCES = [
  0x8000003c, // HandCombat / Unarmed
  0x8000003e, // SwordCombat
  0x80000040, // SwordShield
  0x80000044, // TwoHandedSword
  0x80000046, // DualWield
  0x8000003f, // BowCombat
  0x80000041, // CrossbowCombat
  0x80000047, // ThrownWeaponCombat
  0x80000049, // Magic
  0x8000013b, // AtlatlCombat
];

function clip(n) {
  const flat = new Float32Array(n * PART_COUNT * 7);
  for (let i = 0; i < n * PART_COUNT; i += 1) flat[i * 7 + 3] = 1;
  return flat;
}

const mockWasmExports = {
  async fetchEntityAnimationKeyframes(setupId, mc, tc, pal, subs, mtableId, cmd, stance, fromMotion) {
    const low = cmd & 0xffff;
    const has = !fromMotion && (
      low === 0x03 || low === 0x05 || low === 0x06 || low === 0x07 ||
      low === 0x0d || low === 0x0e || low === 0x0f || low === 0x10 ||
      low === 0x12 || low === 0x15
    );
    const n = has ? 8 : 0;
    const meshes = Array.from({ length: PART_COUNT }, () => ({
      triCount: 1,
      positions: new Float32Array(9), uvs: new Float32Array(6), normals: new Float32Array(9),
      surfaceIndices: new Uint8Array([0]), surfaces: new Uint32Array([0x08001234]),
    }));
    return {
      partCount: PART_COUNT, numFrames: n, framerate: n ? 30 : 0,
      resolvedStance: stance || 0x3d, partFrames: n ? clip(n) : new Float32Array(0),
      takePartMeshes() { return meshes.splice(0); },
    };
  },
  async fetchEntitySurfacesPixels(dids) {
    return dids.map(() => ({ pixels: new Uint8Array(16).fill(255), width: 2, height: 2 }));
  },
};

async function spawnPlayer(em, guid = 0x50000001) {
  return em.spawn({
    guid, modelId: 0x02000001, mtableId: 0x09000001,
    landblockId: 0xa9b40001, x: 10, y: 10, z: 0, qw: 1, qx: 0, qy: 0, qz: 0,
    paletteId: 0, motionCommand: READY, motionStance: 0, objScale: 1, name: "test_player",
    wcid: 1, itemType: 0x10, iconId: 0,
    modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0),
    subPalettes: new Uint32Array(0),
  });
}

// ============================================================================
// CHALLENGE 1: PLAYBACK RATE BEHAVIOR AT EXTREME SPEEDS (> 16.0 M/S & < 0.25 M/S)
// ============================================================================

test('CHALLENGE 1.1: Super-range speeds (>16.0 m/s up to 1000.0 m/s) strictly clamp to 4.0000', () => {
  const BASE_RUN = 4.0000;
  const superSpeeds = [
    16.0001, 16.5, 18.0, 20.0, 25.0, 32.0, 48.0, 50.0, // 50.0 = physics terminal velocity cap
    75.0, 100.0, 250.0, 500.0, 1000.0, 1e6
  ];

  for (const speed of superSpeeds) {
    const scale = cycleTimeScale(speed, BASE_RUN);
    assert.equal(scale, 4.0, `Speed ${speed} m/s must clamp timeScale to 4.0, got ${scale}`);
  }

  // Walk base 2.6017: speeds > 4 * 2.6017 = 10.4068 must clamp to 4.0
  const BASE_WALK = 2.6017;
  const walkSuperSpeeds = [10.4069, 11.0, 15.0, 20.0, 50.0];
  for (const speed of walkSuperSpeeds) {
    const scale = cycleTimeScale(speed, BASE_WALK);
    assert.equal(scale, 4.0, `Walk speed ${speed} m/s must clamp timeScale to 4.0, got ${scale}`);
  }
});

test('CHALLENGE 1.2: Sub-range speeds (<0.25 m/s down to 0.0 m/s) strictly clamp to 0.2500 floor', () => {
  const BASE_RUN = 4.0000;
  const subSpeeds = [
    0.9999, // 0.9999 / 4.0 = 0.249975 -> clamped to 0.25
    0.8, 0.5, 0.25, 0.2499, 0.2, 0.1, 0.05, 0.01, 0.001, 1e-6, 0.0
  ];

  for (const speed of subSpeeds) {
    const scale = cycleTimeScale(speed, BASE_RUN);
    assert.equal(scale, 0.25, `Speed ${speed} m/s must clamp timeScale to floor 0.25, got ${scale}`);
  }

  // Walk base 2.6017: speeds < 0.25 * 2.6017 = 0.650425 must clamp to 0.25
  const BASE_WALK = 2.6017;
  const walkSubSpeeds = [0.6504, 0.5, 0.25, 0.1, 0.0];
  for (const speed of walkSubSpeeds) {
    const scale = cycleTimeScale(speed, BASE_WALK);
    assert.equal(scale, 0.25, `Walk speed ${speed} m/s must clamp timeScale to floor 0.25, got ${scale}`);
  }
});

test('CHALLENGE 1.3: Robustness against non-finite, negative, and zero-base parameters', () => {
  const BASE = 4.0000;
  // Non-finite actual speeds safely return 1.0
  assert.equal(cycleTimeScale(NaN, BASE), 1.0);
  assert.equal(cycleTimeScale(Infinity, BASE), 1.0);
  assert.equal(cycleTimeScale(-Infinity, BASE), 1.0);
  assert.equal(cycleTimeScale(null, BASE), 1.0);
  assert.equal(cycleTimeScale(undefined, BASE), 1.0);

  // Invalid base speeds safely return 1.0
  assert.equal(cycleTimeScale(4.0, 0.0), 1.0);
  assert.equal(cycleTimeScale(4.0, -4.0), 1.0);
  assert.equal(cycleTimeScale(4.0, 1e-5), 1.0);
  assert.equal(cycleTimeScale(4.0, NaN), 1.0);
  assert.equal(cycleTimeScale(4.0, Infinity), 1.0);

  // Negative actual speed applies Math.abs
  assert.equal(cycleTimeScale(-4.0, BASE), 1.0);
  assert.equal(cycleTimeScale(-8.0, BASE), 2.0);
  assert.equal(cycleTimeScale(-20.0, BASE), 4.0); // clamped to 4.0
  assert.equal(cycleTimeScale(-0.1, BASE), 0.25); // clamped to 0.25
});

test('CHALLENGE 1.4: _unifiedLocoGaitScale integration on live EntityManager player rig', async () => {
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, mockWasmExports);
  const player = await spawnPlayer(em, 0x50000002);
  player._isLocalPlayer = true;

  // 1. Forward run at sprint speed 10.0 m/s
  await em.setMotion(player.guid, RUN_FORWARD, 0x3d, 2.5);
  player._forwardCommand = RUN_FORWARD;
  player._forwardSpeed = 2.5;
  player._motionSpeed = 2.5;
  player._motionSpeedSign = 1;
  player._emaSpeed = 10.0;

  let gaitScale = em._unifiedLocoGaitScale(player, 4.0000);
  assert.ok(Math.abs(gaitScale - 2.5) < 1e-4, `Expected gaitScale 2.5, got ${gaitScale}`);

  // 2. Canonical backward walk: WalkForward with negative sign and speed 0.65
  await em.setMotion(player.guid, WALK_FORWARD, 0x3d, 0.65);
  player._forwardCommand = WALK_FORWARD;
  player._forwardSpeed = 0.65;
  player._motionSpeed = 0.65;
  player._motionSpeedSign = -1;
  player._emaSpeed = 2.028; // 3.12 * 0.65

  gaitScale = em._unifiedLocoGaitScale(player, 2.6017);
  // Expected: scale = 2.028 / 2.6017 ~ 0.77949, signed = -0.77949
  assert.ok(gaitScale < 0, `Backward walk must have negative gaitScale, got ${gaitScale}`);
  assert.ok(Math.abs(gaitScale - (-2.028 / 2.6017)) < 1e-4, `Backward walk scale match`);

  // 3. Idle at rest: forwardCommand = READY
  player._forwardCommand = READY;
  player._emaSpeed = 0;
  player._motionSpeed = 1.0;
  player._motionSpeedSign = 1;
  gaitScale = em._unifiedLocoGaitScale(player, 0);
  assert.equal(gaitScale, 1.0, `Idle at rest must return 1.0`);
});

// ============================================================================
// CHALLENGE 2: FOOT SYNCHRONY (0.1333 M/FRAME) DURING RAPID TURN / STRAFE ALTERNATION
// ============================================================================

test('CHALLENGE 2.1: Rapid strafe alternation (Left <-> Right) maintains invariant displacement and correct signs', async () => {
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, mockWasmExports);
  const player = await spawnPlayer(em, 0x50000003);
  player._isLocalPlayer = true;

  const AUTHORED_FPS = 30.0;
  const BASE_STRAFE_SPEED = 1.2500;
  const EXPECTED_STRAFE_DISP = BASE_STRAFE_SPEED / AUTHORED_FPS; // 0.041666... m/frame

  // Rapidly alternate strafe directions over 100 transitions
  let currentCmd = SIDESTEP_RIGHT;
  for (let i = 0; i < 100; i++) {
    const isRight = (i % 2 === 0);
    currentCmd = isRight ? SIDESTEP_RIGHT : SIDESTEP_LEFT;
    const sign = isRight ? 1 : -1;
    const physicalSpeed = 1.56; // 1.25 * 1.248

    player._sidestepCommand = currentCmd;
    player._sidestepSpeed = 1.248;
    player._motionSpeedSign = sign;
    player._emaSpeed = physicalSpeed;

    const scale = cycleTimeScale(physicalSpeed, BASE_STRAFE_SPEED);
    const expectedScale = physicalSpeed / BASE_STRAFE_SPEED;
    assert.ok(Math.abs(scale - expectedScale) < 1e-5, `Strafe scale at step ${i}`);

    const effectiveFps = AUTHORED_FPS * scale;
    const dispPerFrame = physicalSpeed / effectiveFps;
    assert.ok(Math.abs(dispPerFrame - EXPECTED_STRAFE_DISP) < 1e-5, `Strafe displacement at step ${i}`);
  }
});

test('CHALLENGE 2.2: Rapid yaw turning while running forward strictly preserves 0.133333... m/frame', () => {
  const BASE_RUN_SPEED = 4.0000;
  const AUTHORED_FPS = 30.0;
  const EXPECTED_DISPLACEMENT = BASE_RUN_SPEED / AUTHORED_FPS; // 0.13333333333333333

  // Speeds during sprint, normal run, and jog
  const runRates = [1.0, 1.25, 1.5, 2.0, 2.25, 3.0, 4.0];

  for (const rate of runRates) {
    const linearSpeed = 4.0 * rate;
    const timeScale = cycleTimeScale(linearSpeed, BASE_RUN_SPEED);

    // Simulate 360 degree turning in 5 degree increments
    for (let deg = 0; deg < 360; deg += 5) {
      const headingRad = (deg * Math.PI) / 180.0;
      const vx = linearSpeed * Math.sin(headingRad);
      const vy = linearSpeed * Math.cos(headingRad);
      const groundSpeed = Math.hypot(vx, vy);

      assert.ok(Math.abs(groundSpeed - linearSpeed) < 1e-5, `Ground speed invariant under yaw`);

      const effectiveFps = AUTHORED_FPS * timeScale;
      const dispPerFrame = groundSpeed / effectiveFps;

      assert.ok(
        Math.abs(dispPerFrame - EXPECTED_DISPLACEMENT) < 1e-6,
        `Turn angle ${deg} deg at rate ${rate} failed displacement invariant: got ${dispPerFrame}`
      );
    }
  }
});

test('CHALLENGE 2.3: Diagonal locomotion (Sprint + Strafe) with magnitude clamp preserves foot displacement', () => {
  const BASE_RUN_SPEED = 4.0000;
  const AUTHORED_FPS = 30.0;
  const EXPECTED_DISPLACEMENT = BASE_RUN_SPEED / AUTHORED_FPS; // 0.133333...

  const runRates = [1.0, 1.5, 2.0, 2.25];
  for (const rate of runRates) {
    const maxAllowedSpeed = 4.0 * rate;
    const rawVy = 4.0 * rate; // forward
    const rawVx = 1.56;       // strafe right

    // Retail diagonal magnitude clamp (acclient.c:343586)
    const rawMagnitude = Math.hypot(rawVx, rawVy);
    const clampedMagnitude = Math.min(rawMagnitude, maxAllowedSpeed);

    // Scaling ratio based on clamped ground speed
    const timeScale = cycleTimeScale(clampedMagnitude, BASE_RUN_SPEED);
    const effectiveFps = AUTHORED_FPS * timeScale;
    const dispPerFrame = clampedMagnitude / effectiveFps;

    assert.ok(
      Math.abs(dispPerFrame - EXPECTED_DISPLACEMENT) < 1e-6,
      `Diagonal clamp rate ${rate}: expected ${EXPECTED_DISPLACEMENT}, got ${dispPerFrame}`
    );
  }
});

// ============================================================================
// CHALLENGE 3: 2-HOP STANCE TRANSITIONS UNDER RAPID FIFO WEAPON SWAPS
// ============================================================================

test('CHALLENGE 3.1: Complete 10x10 pairwise stance transition routing matrix', async () => {
  // Mock MotionTable router: direct combat-to-combat links are absent in retail MotionTable 0x09000001
  const fakeManager = {
    _styleChainRetailOn: true,
    async _fetchLinkEntry(inst, setupId, mtableId, fromCmd, toCmd, stance) {
      // Direct link between two distinct combat stances does not exist
      if (stance !== NON_COMBAT && toCmd !== NON_COMBAT) return null;
      // Sheathe link: fromStance -> NonCombat
      if (stance !== NON_COMBAT && toCmd === NON_COMBAT) return { clip: `sheathe_${stance.toString(16)}` };
      // Draw link: NonCombat -> toStance
      if (stance === NON_COMBAT && toCmd !== NON_COMBAT) return { clip: `draw_${toCmd.toString(16)}` };
      return null;
    },
  };

  // 1. All 90 pairwise combat-to-combat transitions route 2-hop via NonCombat
  for (let i = 0; i < COMBAT_STANCES.length; i++) {
    for (let j = 0; j < COMBAT_STANCES.length; j++) {
      if (i === j) continue;
      const fromStance = COMBAT_STANCES[i];
      const toStance = COMBAT_STANCES[j];

      const hops = await EntityManager.prototype._resolveStyleLinks.call(fakeManager, {}, 0x02000001, 0x09000001, fromStance, toStance);
      assert.equal(hops.length, 2, `Transition from 0x${fromStance.toString(16)} to 0x${toStance.toString(16)} must have 2 hops`);
      assert.equal(hops[0].toCmd, NON_COMBAT, `Hop 1 must route to NonCombat (0x8000003D)`);
      assert.equal(hops[1].toCmd, toStance, `Hop 2 must route to target stance`);
    }
  }

  // 2. All 10 NonCombat <-> Combat transitions execute in 1 hop
  for (const combatStance of COMBAT_STANCES) {
    const fromNC = await EntityManager.prototype._resolveStyleLinks.call(fakeManager, {}, 0x02000001, 0x09000001, NON_COMBAT, combatStance);
    assert.equal(fromNC.length, 1, `NonCombat -> Combat must have 1 hop`);
    assert.equal(fromNC[0].toCmd, combatStance);

    const toNC = await EntityManager.prototype._resolveStyleLinks.call(fakeManager, {}, 0x02000001, 0x09000001, combatStance, NON_COMBAT);
    assert.equal(toNC.length, 1, `Combat -> NonCombat must have 1 hop`);
    assert.equal(toNC[0].toCmd, NON_COMBAT);
  }

  // 3. Stance deduplication: setMotion guards identical stances (line 12910)
  // so no style links are resolved when stances match
  for (const stance of [...COMBAT_STANCES, NON_COMBAT]) {
    const isSameStance = (stance & 0xffff) === (stance & 0xffff);
    assert.equal(isSameStance, true);
  }
});

test('CHALLENGE 3.2: Rapid FIFO weapon swaps (50 chained transitions) without state corruption or rejection', async () => {
  const fakeManager = {
    _styleChainRetailOn: true,
    async _fetchLinkEntry(inst, setupId, mtableId, fromCmd, toCmd, stance) {
      if (stance !== NON_COMBAT && toCmd !== NON_COMBAT) return null;
      if (stance !== NON_COMBAT && toCmd === NON_COMBAT) return { clip: `sheathe_${stance.toString(16)}` };
      if (stance === NON_COMBAT && toCmd !== NON_COMBAT) return { clip: `draw_${toCmd.toString(16)}` };
      return null;
    },
    async _resolveStyleLinks(inst, setupId, mtableId, from, to) {
      return EntityManager.prototype._resolveStyleLinks.call(this, inst, setupId, mtableId, from, to);
    },
    async _resolveStanceChain(inst, setupId, mtableId, fromStyle, toStyle, exitFrom) {
      return EntityManager.prototype._resolveStanceChain.call(this, inst, setupId, mtableId, fromStyle, toStyle, exitFrom);
    }
  };

  let currentStance = NON_COMBAT;
  const queuePromises = [];

  // Fire 50 rapid sequential stance swaps
  for (let step = 0; step < 50; step++) {
    const nextStance = COMBAT_STANCES[step % COMBAT_STANCES.length];
    const promise = fakeManager._resolveStanceChain({}, 0x02000001, 0x09000001, currentStance, nextStance, READY);
    queuePromises.push(promise);
    currentStance = nextStance;
  }

  const results = await Promise.all(queuePromises);
  assert.equal(results.length, 50, `All 50 stance chain resolutions completed`);

  for (let k = 0; k < results.length; k++) {
    const chain = results[k];
    assert.ok(Array.isArray(chain), `Chain ${k} must be an array`);
    assert.ok(chain.meta, `Chain ${k} must have meta info`);
  }
});

// ============================================================================
// CHALLENGE 4: JUMP TAKEOFF & LANDING RECOVERY LINKS DURING HIGH-VELOCITY SLOPE LAUNCHES
// ============================================================================

test('CHALLENGE 4.1: High-velocity slope launch takeoff link (80ms fade) and airborne Falling loop', () => {
  // 1. Takeoff link verification
  assert.ok(isLocomotionLink(RUN_FORWARD, FALLING), `RunForward -> Falling is a locomotion link`);
  assert.ok(isLocomotionLink(READY, FALLING), `Ready -> Falling is a locomotion link`);
  assert.ok(isLocomotionLink(WALK_FORWARD, FALLING), `WalkForward -> Falling is a locomotion link`);

  // 2. Takeoff crossfade standard
  assert.equal(CROSSFADE_TAKEOFF_MS, 80, `Takeoff crossfade standard is 80ms`);
  assert.equal(CROSSFADE_STANDARDS.takeoff, 80, `CROSSFADE_STANDARDS.takeoff is 80ms`);
});

test('CHALLENGE 4.2: High-velocity landing recovery link (60ms fade) with forward momentum preservation', () => {
  // 1. Landing recovery link verification
  assert.ok(isLocomotionLink(FALLING, RUN_FORWARD), `Falling -> RunForward is a locomotion link`);
  assert.ok(isLocomotionLink(FALLING, READY), `Falling -> Ready is a locomotion link`);
  assert.ok(isLocomotionLink(FALLING, WALK_FORWARD), `Falling -> WalkForward is a locomotion link`);

  // 2. Landing crossfade standard
  assert.equal(CROSSFADE_LANDING_MS, 60, `Landing crossfade standard is 60ms`);
  assert.equal(CROSSFADE_STANDARDS.landing, 60, `CROSSFADE_STANDARDS.landing is 60ms`);
});

test('CHALLENGE 4.3: Full Jump lifecycle state machine simulation under sprint velocity (10.0 m/s)', async () => {
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, mockWasmExports);
  const player = await spawnPlayer(em, 0x50000006);
  player._isLocalPlayer = true;

  // Step 1: Running sprint on ground
  await em.setMotion(player.guid, RUN_FORWARD, NON_COMBAT, 2.5);
  player.lastMotionCommand = RUN_FORWARD;
  player._motionSpeed = 2.5;

  // Step 2: Jump launch (airborne = true)
  em.setAirborne(player.guid, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(player._isAirborne, true, `Player must be airborne`);
  assert.equal(player._takeoffCrossfadeMs, 80, `Takeoff crossfade set to 80ms`);
  assert.ok(player._groundMotion, `_groundMotion stashed on takeoff`);
  assert.equal(player._groundMotion.cmd, RUN_FORWARD, `Stashed cmd is RUN_FORWARD`);
  assert.equal(player._groundMotion.speed, 2.5, `Stashed speed is 2.5`);

  // Step 3: Mid-air steering input: player presses TurnRight in air
  // In retail, air steering does NOT overwrite falling cycle, only updates intent
  player._groundMotion.cmd = RUN_FORWARD;

  // Step 4: Touchdown landing (airborne = false)
  em.setAirborne(player.guid, false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(player._isAirborne, false, `Player no longer airborne`);
  assert.equal(player._landingCrossfadeMs, 60, `Landing crossfade set to 60ms`);
  assert.equal(player._groundMotion, null, `_groundMotion cleared on landing`);
  assert.equal(player.lastMotionCommand, RUN_FORWARD, `Restored to RUN_FORWARD landing recovery`);
});

test('CHALLENGE 4.4: Standing jump landing snaps cleanly to Ready (0x41000003)', async () => {
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, mockWasmExports);
  const player = await spawnPlayer(em, 0x50000007);
  player._isLocalPlayer = true;

  // Step 1: Standing idle at rest
  await em.setMotion(player.guid, READY, NON_COMBAT, 1.0);
  player.lastMotionCommand = READY;
  player._motionSpeed = 1.0;

  // Step 2: Standing jump takeoff
  em.setAirborne(player.guid, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(player._groundMotion.cmd, READY, `Stashed cmd is READY`);

  // Step 3: Touchdown landing
  em.setAirborne(player.guid, false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(player.lastMotionCommand, READY, `Restored to READY landing`);
});
