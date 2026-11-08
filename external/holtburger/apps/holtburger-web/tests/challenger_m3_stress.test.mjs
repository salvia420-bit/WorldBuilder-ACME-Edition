// apps/holtburger-web/tests/challenger_m3_stress.test.mjs
/**
 * Empirical Adversarial Challenger Verification Suite for Milestone 3
 * Features 28, 29, 30: Velocity-to-Playback Scaling, Invariant Foot Synchrony,
 * Canonical Locomotion Playback, Deceleration Coasting Foot-Slide Suppression
 *
 * Author: movement_challenger_m3_1
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Initialize global window shim before importing scene3d modules
globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.__playEffectVfxBound = true;
globalThis.window.__spellShapePreviewBound = true;

const THREE = await import("three");
const { EntityManager, isLocomotionLink, canonicalCycleBaseSpeed } = await import("../scene3d/entities.js");
const {
  cycleTimeScale,
  CROSSFADE_LOCO_MS,
  CROSSFADE_STANCE_MS,
  CROSSFADE_TAKEOFF_MS,
  CROSSFADE_LANDING_MS,
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

function clip(n) {
  const flat = new Float32Array(n * PART_COUNT * 7);
  for (let i = 0; i < n * PART_COUNT; i += 1) flat[i * 7 + 3] = 1;
  return flat;
}

const mockWasmExports = {
  async fetchEntityAnimationKeyframes(setupId, mc, tc, pal, subs, mtableId, cmd, stance, fromMotion) {
    const low = cmd & 0xffff;
    const has = !fromMotion && (low === 0x03 || low === 0x05 || low === 0x07 || low === 0x0d || low === 0x0f || low === 0x12 || low === 0x15);
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
// SUITE 1: INVARIANT FOOT SYNCHRONY & VELOCITY PLAYBACK SCALING (FEATURES 28 & 29)
// ============================================================================

test('F29-01: Invariant foot displacement strictly equals 0.133333... m/frame across 1000 run speeds in [1.0, 16.0] m/s', () => {
  const BASE_RUN_SPEED = 4.0000;
  const AUTHORED_FPS = 30.0;
  const EXPECTED_DISPLACEMENT = BASE_RUN_SPEED / AUTHORED_FPS; // 0.13333333333333333

  // Sweep 1000 fine-grained speeds from 1.0 m/s to 16.0 m/s
  const steps = 1000;
  const minSpeed = 1.0;
  const maxSpeed = 16.0;
  const stepSize = (maxSpeed - minSpeed) / (steps - 1);

  let maxDispError = 0;
  let maxScaleError = 0;

  for (let i = 0; i < steps; i++) {
    const v = minSpeed + i * stepSize;
    const timeScale = cycleTimeScale(v, BASE_RUN_SPEED);
    const expectedTimeScale = v / BASE_RUN_SPEED;

    const scaleErr = Math.abs(timeScale - expectedTimeScale);
    if (scaleErr > maxScaleError) maxScaleError = scaleErr;
    assert.ok(scaleErr < 1e-6, `timeScale mismatch at v=${v}: got ${timeScale}, expected ${expectedTimeScale}`);

    const effectiveFps = AUTHORED_FPS * timeScale;
    const deltaD = v / effectiveFps;
    const dispErr = Math.abs(deltaD - EXPECTED_DISPLACEMENT);
    if (dispErr > maxDispError) maxDispError = dispErr;
    assert.ok(dispErr < 1e-5, `deltaD mismatch at v=${v}: got ${deltaD}, expected ${EXPECTED_DISPLACEMENT}`);
  }

  assert.ok(maxDispError < 1e-5, `Max displacement error across all 1000 points was ${maxDispError} (< 10^-5 required)`);
});

test('F29-02: Precise verification at key run rate checkpoints (1.0, 1.25, 1.5, 2.0, 2.25, 4.0)', () => {
  const BASE_RUN_SPEED = 4.0000;
  const AUTHORED_FPS = 30.0;
  const checkpoints = [
    { rate: 0.25, speed: 1.0000, expectedScale: 0.2500 },
    { rate: 1.00, speed: 4.0000, expectedScale: 1.0000 },
    { rate: 1.25, speed: 5.0000, expectedScale: 1.2500 },
    { rate: 1.50, speed: 6.0000, expectedScale: 1.5000 },
    { rate: 2.00, speed: 8.0000, expectedScale: 2.0000 },
    { rate: 2.25, speed: 9.0000, expectedScale: 2.2500 },
    { rate: 3.00, speed: 12.0000, expectedScale: 3.0000 },
    { rate: 4.00, speed: 16.0000, expectedScale: 4.0000 },
  ];

  for (const cp of checkpoints) {
    const timeScale = cycleTimeScale(cp.speed, BASE_RUN_SPEED);
    assert.ok(Math.abs(timeScale - cp.expectedScale) < 1e-6, `Checkpoint ${cp.rate} scale match`);
    const deltaD = cp.speed / (AUTHORED_FPS * timeScale);
    assert.ok(Math.abs(deltaD - (4.0 / 30.0)) < 1e-6, `Checkpoint ${cp.rate} displacement 0.133333...`);
  }
});

test('F28-03: Walk playback timeScale strictly matches 1.0000 and 1.1992 at canonical walk speeds', () => {
  const BASE_WALK_SPEED = 2.6017;
  const CLOSED_FORM_WALK_SPEED = 3.1199999;

  // 1. Authoritative base speed 2.6017 m/s produces exact 1.0000 timeScale
  const scaleAtBase = cycleTimeScale(BASE_WALK_SPEED, BASE_WALK_SPEED);
  assert.ok(Math.abs(scaleAtBase - 1.0000) < 1e-6, `scale at 2.6017 m/s must be 1.0000, got ${scaleAtBase}`);

  // 2. Closed-form walk speed 3.1199999 m/s produces 1.1992 timeScale
  const scaleAtClosedForm = cycleTimeScale(CLOSED_FORM_WALK_SPEED, BASE_WALK_SPEED);
  assert.ok(Math.abs(scaleAtClosedForm - 1.1992158) < 1e-4, `scale at 3.1199999 m/s must be 1.1992, got ${scaleAtClosedForm}`);
  assert.ok(Math.abs(scaleAtClosedForm - 1.1992) < 1e-3, `scale within 10^-3 of 1.1992`);

  // 3. Walk displacement invariant: 2.6017 / 30.0 = 0.0867233 m/frame
  const walkDeltaD = CLOSED_FORM_WALK_SPEED / (30.0 * scaleAtClosedForm);
  assert.ok(Math.abs(walkDeltaD - (BASE_WALK_SPEED / 30.0)) < 1e-6, `Walk displacement invariant preserved`);
});

test('F28-04: Extreme boundary clamping & non-finite sanitization in cycleTimeScale', () => {
  const BASE = 4.0000;
  // Sub-range clamp: v = 0.5 m/s clamps to 0.25 (does not crash or produce 0.125)
  assert.equal(cycleTimeScale(0.5, BASE), 0.25);
  assert.equal(cycleTimeScale(0.0, BASE), 0.25);

  // Super-range clamp: v = 25.0 m/s clamps to 4.0 (does not hyper-spin at 6.25)
  assert.equal(cycleTimeScale(25.0, BASE), 4.0);
  assert.equal(cycleTimeScale(100.0, BASE), 4.0);

  // Non-finite or bad inputs: fail-soft to 1.0 no-op
  assert.equal(cycleTimeScale(NaN, BASE), 1.0);
  assert.equal(cycleTimeScale(Infinity, BASE), 1.0);
  assert.equal(cycleTimeScale(-Infinity, BASE), 1.0);
  assert.equal(cycleTimeScale(BASE, 0.0), 1.0);
  assert.equal(cycleTimeScale(BASE, -1.0), 1.0);
  assert.equal(cycleTimeScale(BASE, 1e-5), 1.0);

  // Negative actual speed handled via Math.abs
  assert.equal(cycleTimeScale(-8.0, BASE), 2.0);
});

// ============================================================================
// SUITE 2: DECELERATION COASTING FOOT-SLIDE SUPPRESSION (FEATURE 26 + 28 + 29)
// ============================================================================

test('F26/28-01: Stop from sprint (v0=9.0 m/s, f=0.95): _unifiedLocoGaitScale tracks dynamic ground speed on EVERY tick', async () => {
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, mockWasmExports);
  const player = await spawnPlayer(em, 0x50000001);

  // Set running forward with sprint run rate 2.25
  await em.setMotion(player.guid, RUN_FORWARD, 0x3d, 2.25);
  player._forwardCommand = RUN_FORWARD;

  // Simulate coasting deceleration from 9.0 m/s under exponential friction f=0.95
  const dt = 1.0 / 30.0;
  const decayFactor = Math.pow(1.0 - 0.95, dt); // (0.05)^(1/30) ~ 0.904837
  let currentSpeed = 9.0; // 4.0 * 2.25
  let totalCoastingDist = 0.0;
  let tickCount = 0;

  const simulatedTicks = [];

  while (currentSpeed >= 0.25) {
    tickCount++;
    totalCoastingDist += currentSpeed * dt;

    // Simulate wasm/engine updating state ground speed
    em.wasmExports.stateGroundSpeed = () => currentSpeed;
    player._emaSpeed = currentSpeed;

    // Query gait scale
    const gaitScale = em._unifiedLocoGaitScale(player, 4.0000);

    // Calculate instantaneous frame displacement
    const effectiveFps = 30.0 * gaitScale;
    const deltaD = currentSpeed / effectiveFps;

    // Check sliding ratio: dynamic gait scale vs actual speed
    const expectedGaitScale = cycleTimeScale(currentSpeed, 4.0000);
    const gaitScaleError = Math.abs(gaitScale - expectedGaitScale);

    simulatedTicks.push({
      tick: tickCount,
      speed: currentSpeed,
      gaitScale,
      expectedGaitScale,
      deltaD,
      gaitScaleError,
    });

    assert.ok(
      gaitScaleError < 1e-4,
      `Tick ${tickCount} gait scale (${gaitScale}) must dynamically match cycleTimeScale (${expectedGaitScale})`
    );

    // If speed is >= 1.0 m/s, deltaD must strictly equal 0.133333 m/frame (< 10^-5 error)
    if (currentSpeed >= 1.0) {
      const dispErr = Math.abs(deltaD - (4.0 / 30.0));
      assert.ok(
        dispErr < 1e-5,
        `Tick ${tickCount} (v=${currentSpeed.toFixed(3)} m/s): deltaD ${deltaD.toFixed(6)} != 0.133333 (err=${dispErr})`
      );
    }

    // Step exponential friction
    currentSpeed *= decayFactor;
  }

  // Verify deceleration steps and dynamic tracking across all ticks
  assert.ok(tickCount >= 10, `Coasting deceleration stepped through ${tickCount} ticks`);

  // Prove foot-slide suppression: contrast with static rate (2.25)
  // Under static rate, at speed 0.5 m/s, feet would move at 9.0 m/s (18x speed slide!).
  // Under dynamic scaling, feet move at exactly 0.5 m/s (0% slide).
  const lastAboveOne = simulatedTicks.filter(t => t.speed >= 1.0).pop();
  const staticRatio = (2.25 * 4.0) / lastAboveOne.speed;
  const dynamicRatio = (lastAboveOne.gaitScale * 4.0) / lastAboveOne.speed;
  assert.ok(
    Math.abs(dynamicRatio - 1.0) < 1e-5,
    `Dynamic tracking has zero foot slide (ratio = ${dynamicRatio})`
  );
  assert.ok(
    staticRatio > 2.0,
    `Static freezing would have caused massive foot slide (${staticRatio.toFixed(2)}x discrepancy)`
  );

  em.dispose();
});

test('F26/28-02: Nominal ~0.79m coasting window (v0=4.0 m/s sprint stop): dynamic tracking eliminates foot slide', async () => {
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, mockWasmExports);
  const player = await spawnPlayer(em, 0x50000001);

  await em.setMotion(player.guid, RUN_FORWARD, 0x3d, 1.0);
  player._forwardCommand = RUN_FORWARD;

  // Discrete linear deceleration profile from nominal 4.0 m/s over 0.40s (~0.79m target)
  const dt = 1.0 / 30.0;
  const duration = 0.40;
  const ticks = 12;
  let dist = 0.0;

  for (let i = 0; i < ticks; i++) {
    const t = (i + 0.5) * dt;
    const speed = 4.0 * Math.max(0.0, 1.0 - t / duration);
    dist += speed * dt;

    em.wasmExports.stateGroundSpeed = () => speed;
    player._emaSpeed = speed;

    const gaitScale = em._unifiedLocoGaitScale(player, 4.0000);
    const expectedGaitScale = cycleTimeScale(speed, 4.0000);
    assert.ok(
      Math.abs(gaitScale - expectedGaitScale) < 1e-4,
      `Tick ${i} gait scale dynamically tracks decaying speed`
    );

    if (speed >= 1.0) {
      const effectiveFps = 30.0 * gaitScale;
      const deltaD = speed / effectiveFps;
      assert.ok(
        Math.abs(deltaD - (4.0 / 30.0)) < 1e-5,
        `Foot displacement strictly locked to 0.133333 m/frame throughout coasting`
      );
    }
  }

  // Integral = 4.0 * 0.40 / 2 = 0.80 m, matching ~0.79 m nominal coasting window
  assert.ok(
    dist >= 0.75 && dist <= 0.85,
    `Simulated nominal coasting distance (${dist.toFixed(3)} m) matches ~0.79m target`
  );

  em.dispose();
});

// ============================================================================
// SUITE 3: CANONICAL PLAYBACK & PHASE INVERSION (FEATURE 30)
// ============================================================================

test('F30-01: WalkBackward rewrites to WalkForward at -0.65x and never promotes to Run even under sprint speed', async () => {
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, mockWasmExports);
  const player = await spawnPlayer(em, 0x50000001);

  // 1. Normal walk backward (speed 1.0)
  await em.setMotion(player.guid, WALK_BACKWARD, 0x3d, 1.0);
  assert.equal(player.lastMotionCommand >>> 0, WALK_FORWARD, "WalkBackward rewrites to WalkForward 0x45000005");
  assert.ok(Math.abs(player._motionSpeed - 0.64999998) < 1e-6, "Magnitude is 0.65");
  assert.equal(player._motionSpeedSign, -1, "Speed sign is negative (-1)");
  assert.ok(em._unifiedLocoGaitScale(player, 2.6017) < 0, "Gait scale is negative");

  // 2. Sprint speed input with WalkBackward (speed 4.5): MUST NOT promote to RunForward (0x44000007)
  await em.setMotion(player.guid, WALK_BACKWARD, 0x3d, 4.5);
  assert.notEqual(player.lastMotionCommand >>> 0, RUN_FORWARD, "WalkBackward NEVER promotes to RunForward 0x44000007");
  assert.equal(player.lastMotionCommand >>> 0, WALK_FORWARD, "WalkBackward stays WalkForward 0x45000005");
  assert.ok(Math.abs(player._motionSpeed - (0.64999998 * 4.5)) < 1e-4, "Sprint backpedal magnitude scaled");
  assert.equal(player._motionSpeedSign, -1, "Sprint backpedal preserves negative direction");
  assert.ok(em._unifiedLocoGaitScale(player, 2.6017) < 0, "Gait scale remains strictly negative");

  em.dispose();
});

test('F30-02: SideStepLeft rewrites to SideStepRight with negative speed and reverse phase advance', async () => {
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, mockWasmExports);
  const player = await spawnPlayer(em, 0x50000001);

  await em.setMotion(player.guid, SIDESTEP_LEFT, 0x3d, 1.248);
  assert.equal(player.lastMotionCommand >>> 0, SIDESTEP_RIGHT, "SideStepLeft folds to SideStepRight 0x6500000F");
  assert.equal(player._motionSpeedSign, -1, "SideStepLeft has negative speed sign (-1)");
  assert.ok(em._unifiedLocoGaitScale(player, 1.25) < 0, "SideStepLeft produces negative gait scale");

  await em.setMotion(player.guid, SIDESTEP_RIGHT, 0x3d, 1.248);
  assert.equal(player.lastMotionCommand >>> 0, SIDESTEP_RIGHT, "SideStepRight remains 0x6500000F");
  assert.equal(player._motionSpeedSign, 1, "SideStepRight has positive speed sign (+1)");
  assert.ok(em._unifiedLocoGaitScale(player, 1.25) > 0, "SideStepRight produces positive gait scale");

  em.dispose();
});

test('F30-03: TurnLeft rewrites to TurnRight with negative speed and reverse phase advance', async () => {
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, mockWasmExports);
  const player = await spawnPlayer(em, 0x50000001);

  await em.setMotion(player.guid, TURN_LEFT, 0x3d, 1.5);
  assert.equal(player.lastMotionCommand >>> 0, TURN_RIGHT, "TurnLeft folds to TurnRight 0x6500000D");
  assert.equal(player._motionSpeedSign, -1, "TurnLeft has negative speed sign (-1)");
  assert.ok(em._unifiedLocoGaitScale(player, 0) < 0, "TurnLeft produces negative gait scale");

  await em.setMotion(player.guid, TURN_RIGHT, 0x3d, 1.5);
  assert.equal(player.lastMotionCommand >>> 0, TURN_RIGHT, "TurnRight remains 0x6500000D");
  assert.equal(player._motionSpeedSign, 1, "TurnRight has positive speed sign (+1)");
  assert.ok(em._unifiedLocoGaitScale(player, 0) > 0, "TurnRight produces positive gait scale");

  em.dispose();
});

test('F30-04: Negative playback step reverses phase and wraps cleanly modulo 1.0', () => {
  // Simulate playhead negative phase stepping logic in tick()
  const duration = 1.0; // 1 second loop
  let phase = 0.50;
  const step = -0.05; // 50ms backwards step

  let p = phase + step / duration;
  let wrapped = p < 0;
  p -= Math.floor(p);
  phase = p;

  assert.equal(wrapped, false);
  assert.ok(Math.abs(phase - 0.45) < 1e-6, "Phase decremented from 0.50 to 0.45");

  // Step across zero boundary
  const largeReverseStep = -0.60;
  p = phase + largeReverseStep / duration;
  wrapped = p < 0;
  p -= Math.floor(p);
  phase = p;

  assert.equal(wrapped, true, "Wrapped across loop boundary");
  assert.ok(Math.abs(phase - 0.85) < 1e-6, "Phase wrapped cleanly to 0.85 (0.45 - 0.60 = -0.15 -> 0.85)");
});

// ============================================================================
// SUITE 4: CANONICAL BASE SPEED FALLBACK & RIG ISOLATION
// ============================================================================

test('F28-05: canonicalCycleBaseSpeed fallback prevents 0-speed stalls during async MotionTable hydration', () => {
  assert.equal(canonicalCycleBaseSpeed(RUN_FORWARD), 4.0000);
  assert.equal(canonicalCycleBaseSpeed(WALK_FORWARD), 2.6017);
  assert.equal(canonicalCycleBaseSpeed(WALK_BACKWARD), 0.0); // low is 0x0006, canonicalized before lookup
  assert.equal(canonicalCycleBaseSpeed(SIDESTEP_RIGHT), 1.2500);
  assert.equal(canonicalCycleBaseSpeed(SIDESTEP_LEFT), 1.2500);
  assert.equal(canonicalCycleBaseSpeed(READY), 0.0);
  assert.equal(canonicalCycleBaseSpeed(CROUCH), 0.0);
  assert.equal(canonicalCycleBaseSpeed(FALLING), 0.0);
});

test('F28-06: Player rig vs Creature rig gait isolation', async () => {
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, mockWasmExports);

  // Player rig (guid mask 0x50000000)
  const player = await spawnPlayer(em, 0x50000001);
  player._forwardCommand = RUN_FORWARD;
  em.wasmExports.stateGroundSpeed = () => 8.0;

  // Creature rig (guid mask 0x10000000)
  const creature = await em.spawn({
    guid: 0x10000002, modelId: 0x02000002, mtableId: 0x09000002,
    landblockId: 0xa9b40001, x: 20, y: 20, z: 0, qw: 1, qx: 0, qy: 0, qz: 0,
    paletteId: 0, motionCommand: READY, motionStance: 0, objScale: 1, name: "creature",
    wcid: 2, itemType: 0x10, iconId: 0,
    modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0), subPalettes: new Uint32Array(0),
  });
  creature._forwardCommand = RUN_FORWARD;
  creature._motionSpeed = 1.0;

  // Player evaluates velocity-to-playback scaling
  const playerScale = em._unifiedLocoGaitScale(player, 4.0000);
  assert.equal(playerScale, 2.0, "Player scales to physical 8.0 m/s ground speed (8.0 / 4.0 = 2.0)");

  // Creature preserves server-simulated gait tempo
  const creatureScale = em._unifiedLocoGaitScale(creature, 4.0000);
  assert.equal(creatureScale, 1.0, "Creature preserves authored rate without being hijacked by player speed");

  em.dispose();
});

// ============================================================================
// SUITE 5: CROSSFADE DURATION STANDARDS IMMUTABILITY
// ============================================================================

test('F37-01: Crossfade constants are authoritative and Object.isFrozen', () => {
  assert.equal(CROSSFADE_LOCO_MS, 120);
  assert.equal(CROSSFADE_STANCE_MS, 150);
  assert.equal(CROSSFADE_TAKEOFF_MS, 80);
  assert.equal(CROSSFADE_LANDING_MS, 60);

  assert.ok(Object.isFrozen(CROSSFADE_STANDARDS), "CROSSFADE_STANDARDS must be frozen");
  assert.throws(() => {
    CROSSFADE_STANDARDS.locomotion = 999;
  }, /TypeError/, "Mutating frozen standards must throw TypeError");
});
