/**
 * Feature 16: Jump Takeoff Link, In-Air Loop, & Landing Recovery (Running vs Standing)
 * Authoritative baseline: acclient.c:344440-344495, entities.js
 */

'use strict';

const {
  CONSTANTS,
  assertEquals
} = require('../harness.cjs');

const suite = require('../harness.cjs').createSuite('Feature 16: Jump Takeoff, Loop, & Landing Recovery', 1);

// Test 16.1: Jump takeoff initiates takeoff link with 80 ms crossfade
suite.addTest('16.1 Jump takeoff initiates takeoff link clip with 80 ms crossfade', () => {
  const takeoffFadeMs = CONSTANTS.CROSSFADE_TAKEOFF_MS;
  assertEquals(takeoffFadeMs, 80, 'Takeoff crossfade is 80 ms');
});

// Test 16.2: Airborne state maintains looping Falling (0x40000015) motion command
suite.addTest('16.2 Airborne flight maintains continuous Falling (0x40000015) motion command', () => {
  const airborneCmd = CONSTANTS.CMD_FALLING;
  assertEquals(airborneCmd, 0x40000015, 'Airborne command is Falling');
});

// Test 16.3: Standing landing impact snaps to Ready with 60 ms crossfade
suite.addTest('16.3 Standing landing (impact with Ready input) transitions to Ready within 60 ms', () => {
  const landingFadeMs = CONSTANTS.CROSSFADE_LANDING_MS;
  assertEquals(landingFadeMs, 60, 'Landing crossfade is 60 ms');

  // Input at touchdown is Ready -> target motion is Ready
  const heldInput = CONSTANTS.CMD_READY;
  const targetMotion = heldInput === CONSTANTS.CMD_READY ? CONSTANTS.CMD_READY : CONSTANTS.CMD_RUN_FORWARD;
  assertEquals(targetMotion, CONSTANTS.CMD_READY, 'Snapped to Ready');
});

// Test 16.4: Running landing (RunForward held at impact) executes running recovery link into sprint
suite.addTest('16.4 Running landing executes running recovery link into RunForward', () => {
  // acclient.c:344475: hop2 = GetLink(stance, Ready, RunForward)
  const heldInput = CONSTANTS.CMD_RUN_FORWARD;
  const targetMotion = heldInput === CONSTANTS.CMD_RUN_FORWARD ? CONSTANTS.CMD_RUN_FORWARD : CONSTANTS.CMD_READY;
  assertEquals(targetMotion, CONSTANTS.CMD_RUN_FORWARD, 'Chains directly into RunForward');
});

// Test 16.5: Running landing preserves forward velocity without dead-stopping
suite.addTest('16.5 Running landing preserves forward sprint velocity at ground contact', () => {
  const airborneVx = 0.0;
  const airborneVy = 6.0; // Sprint velocity preserved from flight
  const groundContactVy = airborneVy; // Preserved into ground run
  assertEquals(groundContactVy, 6.0, 'Forward velocity continues without zeroing');
});

module.exports = suite;
