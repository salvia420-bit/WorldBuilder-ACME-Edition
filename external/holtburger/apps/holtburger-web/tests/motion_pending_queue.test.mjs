// motion_pending_queue.test.mjs — J5 (PARITY-D, 2026-08-13).
// Cases transcribed from acclient.c MotionTableManager (see scene3d/motion_queue.js
// header for the exact line ranges, all re-read from $DECOMP on 2026-08-13).
// Run: node tests/motion_pending_queue.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";
import test from "node:test";
import {
  createMotionQueue, addToQueue, animationDone, animationsDone, headMotion,
} from "../scene3d/motion_queue.js";

// Real command ids (ACE MotionCommand / ledger J3).
// NOTE (verified against acclient.c:330093-330099): `Motion_SideStepRight`
// 0x6500000F carries BOTH 0x40000000 and 0x20000000, so it fails the first
// branch's `&& !(m & 0x20000000)` guard, and it is not negative — a strafe is
// therefore ineligible for the collapse ENTIRELY. Ledger J3's "same-motion
// backward walk" is the walk inside `MotionInterp`, not this one. The bit
// classes below are the ones `remove_redundant_links` actually selects.
const MOD_CLASS      = 0x40000010; // 0x40000000 set, 0x20000000 clear
const BLOCKER_B      = 0x80000020; // has anims + matches 0xB0000000 -> aborts
const SIDESTEP_RIGHT = 0x6500000f;
const ATTACK_HIGH    = 0x80000000 | 0x00000010; // ACTION-class, signed < 0
const READY          = 0x00000003;

test("append order is preserved and the head is the playhead", () => {
  const q = createMotionQueue();
  addToQueue(q, ATTACK_HIGH, 2, "a");
  addToQueue(q, READY, 1, "b");
  assert.equal(q.list.length, 2);
  assert.equal(headMotion(q).payload, "a");
});

test("a zero-anim node retires immediately on the next AnimationDone", () => {
  // Retail: `num_anims <= animation_counter` with counter just ++'d to 1
  // pops a 0-anim node without it ever having played.
  const q = createMotionQueue();
  addToQueue(q, READY, 0, "noop");
  addToQueue(q, ATTACK_HIGH, 1, "swing");
  const done = animationDone(q);
  assert.deepEqual(done.map((n) => n.payload), ["noop", "swing"]);
  assert.equal(q.list.length, 0);
  assert.equal(q.counter, 0);
});

test("counter spans a multi-anim link: 2 anims retire one 2-anim node", () => {
  const q = createMotionQueue();
  addToQueue(q, ATTACK_HIGH, 2, "windup");
  assert.deepEqual(animationDone(q).map((n) => n.payload), []); // counter 1 < 2
  assert.deepEqual(animationDone(q).map((n) => n.payload), ["windup"]);
  assert.deepEqual(animationsDone(createMotionQueue(), 3), []);
});

test("ACTION-class re-issue collapses back onto the earlier occurrence", () => {
  // m & 0x80000000 branch: earlier node with the SAME motion, no intervening
  // node with anims matching 0x70000000 -> truncate everything after it.
  const q = createMotionQueue();
  addToQueue(q, ATTACK_HIGH, 1, "first");
  const retracted = addToQueue(q, ATTACK_HIGH, 1, "second");
  assert.deepEqual(retracted, ["second"]);
  // Retail keeps the node and zeroes its num_anims (it still fires MotionDone).
  assert.equal(q.list.length, 2);
  assert.equal(q.list[1].numAnims, 0);
  assert.equal(headMotion(q).payload, "first");
});

test("an intervening 0xB0000000 node WITH anims aborts the MODIFIER collapse", () => {
  const q = createMotionQueue();
  addToQueue(q, MOD_CLASS, 1, "mod1");
  addToQueue(q, BLOCKER_B, 1, "blocker");
  const retracted = addToQueue(q, MOD_CLASS, 1, "mod2");
  assert.deepEqual(retracted, []);
  assert.equal(q.list.length, 3);
});

test("a strafe (0x6500000F) is ineligible for the collapse in BOTH branches", () => {
  const q = createMotionQueue();
  addToQueue(q, SIDESTEP_RIGHT, 1, "strafe1");
  const retracted = addToQueue(q, SIDESTEP_RIGHT, 1, "strafe2");
  assert.deepEqual(retracted, []);
  assert.equal(q.list.length, 2);
});

test("an intervening 0-anim node does NOT abort the walk (held re-issue is invisible)", () => {
  const q = createMotionQueue();
  addToQueue(q, MOD_CLASS, 1, "mod1");
  addToQueue(q, BLOCKER_B, 0, "blocker-noop"); // no anims -> transparent
  const retracted = addToQueue(q, MOD_CLASS, 1, "mod2");
  assert.deepEqual(retracted, ["mod2"]);
  assert.equal(headMotion(q).payload, "mod1");
});

test("no collapse target -> the newcomer simply queues", () => {
  const q = createMotionQueue();
  addToQueue(q, ATTACK_HIGH, 1, "a");
  const retracted = addToQueue(q, MOD_CLASS, 1, "b");
  assert.deepEqual(retracted, []);
  assert.equal(q.list.length, 2);
});

test("the in-flight head is never spliced out (documented deviation)", () => {
  const q = createMotionQueue();
  addToQueue(q, ATTACK_HIGH, 1, "inflight");
  q.started = true;
  const retracted = addToQueue(q, ATTACK_HIGH, 1, "dup");
  assert.deepEqual(retracted, ["dup"]);
  assert.equal(q.list[1].numAnims, 0);
  assert.equal(headMotion(q).payload, "inflight");
});
