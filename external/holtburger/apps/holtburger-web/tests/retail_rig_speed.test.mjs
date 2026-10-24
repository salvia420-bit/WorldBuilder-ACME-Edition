// tests/retail_rig_speed.test.mjs — scene3d/motion/retail_rig_speed.js: the
// speed a locally driven rig command plays at = retail CMotionInterp
// adjust_motion (acclient.c:343746) + apply_run_to_command (:343439), handed to
// setMotion (which applies adjust_motion's WalkBackwards x -0.65 and the
// Left -> Right negation itself).
//
// Run from apps/holtburger-web/:  node tests/retail_rig_speed.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  localRigSpeedMagnitude, localRigSpeed, localRunRate, readRetailRigSpeedFlag,
  SIDESTEP_FACTOR, MAX_SIDESTEP_ANIM_RATE, _resetRetailRigSpeedForTest,
} = await import("../scene3d/motion/retail_rig_speed.js");

const READY = 0x41000003, WALK = 0x45000005, BACK = 0x45000006, RUN = 0x44000007;
const TURN_R = 0x6500000d, TURN_L = 0x6500000e, SIDE_R = 0x6500000f, SIDE_L = 0x65000010;
const close = (a, b) => Math.abs(a - b) < 1e-6;

test("run plays at the run rate (apply_run_to_command)", () => {
  assert.ok(close(localRigSpeedMagnitude(RUN, true, 4.5), 4.5));
  assert.ok(close(localRigSpeedMagnitude(RUN, true, 2.65), 2.65));
});

test("walk forward stays 1.0 without the run hold key", () => {
  assert.ok(close(localRigSpeedMagnitude(WALK, false, 4.5), 1.0));
});

test("backpedal carries the run rate under hold-run (setMotion applies -0.65)", () => {
  assert.ok(close(localRigSpeedMagnitude(BACK, true, 4.5), 4.5));
  assert.ok(close(localRigSpeedMagnitude(BACK, false, 4.5), 1.0));
});

test("sidestep: x1.248, then x R clamped to 3.0 under hold-run", () => {
  assert.ok(close(SIDESTEP_FACTOR, 1.248));
  assert.ok(close(localRigSpeedMagnitude(SIDE_R, false, 4.5), 1.248));
  assert.ok(close(localRigSpeedMagnitude(SIDE_L, true, 4.5), MAX_SIDESTEP_ANIM_RATE));
  assert.ok(close(localRigSpeedMagnitude(SIDE_R, true, 1.9), 1.248 * 1.9));
});

test("turns: 1.5 under hold-run, else 1.0", () => {
  assert.ok(close(localRigSpeedMagnitude(TURN_R, true, 4.5), 1.5));
  assert.ok(close(localRigSpeedMagnitude(TURN_L, false, 4.5), 1.0));
});

test("Ready and unknown commands play at 1.0; a bad run rate falls back to 1.0", () => {
  assert.ok(close(localRigSpeedMagnitude(READY, true, 4.5), 1.0));
  assert.ok(close(localRigSpeedMagnitude(0x10000051, true, 4.5), 1.0));
  assert.ok(close(localRigSpeedMagnitude(RUN, true, NaN), 1.0));
  assert.ok(close(localRigSpeedMagnitude(RUN, true, 0), 1.0));
});

test("localRigSpeed keeps the caller's sign (a left strafe passes -1)", () => {
  _resetRetailRigSpeedForTest();
  assert.ok(close(localRigSpeed(SIDE_R, -1.0, true, 4.5), -3.0));
  assert.ok(close(localRigSpeed(RUN, 1.0, true, 4.5), 4.5));
});

test("localRunRate reads the wasm export and falls back to 1.0", () => {
  assert.ok(close(localRunRate({ playerRunRate: () => 4.5 }), 4.5));
  assert.ok(close(localRunRate({ playerRunRate: () => 0 }), 1.0));
  assert.ok(close(localRunRate({}), 1.0));
  assert.ok(close(localRunRate(null), 1.0));
  assert.ok(close(localRunRate({ playerRunRate: () => { throw new Error("x"); } }), 1.0));
});

test("?retailRigSpeed is default ON; off/0/false disable", () => {
  assert.equal(readRetailRigSpeedFlag(""), true);
  assert.equal(readRetailRigSpeedFlag("?retailRigSpeed=on"), true);
  assert.equal(readRetailRigSpeedFlag("?retailRigSpeed=off"), false);
  assert.equal(readRetailRigSpeedFlag("?nosw=1&retailRigSpeed=0"), false);
  assert.equal(readRetailRigSpeedFlag("?retailRigSpeed=FALSE"), false);
});
