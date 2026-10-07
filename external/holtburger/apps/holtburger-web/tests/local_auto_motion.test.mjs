// tests/local_auto_motion.test.mjs — the local rig steps through a turn /
// MoveTo the client runs on the server's orders (app/local_auto_motion.js,
// 2026-10-07). Retail plays those on the player's own CMotionInterp
// (`MoveToManager::_DoMotion`, acclient.c:344753).
//
// Run from apps/holtburger-web/:  node tests/local_auto_motion.test.mjs

import assert from "node:assert/strict";
import {
  decodeLocalAutoMotion,
  localAutoMotionCommand,
  createLocalAutoMotion,
  LOCAL_AUTO_MOTION_ACTIVE,
} from "../app/local_auto_motion.js";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

const READY = 0x41000003;
const RUN = 0x44000007;
const WALK = 0x45000005;
const TURN_RIGHT = 0x6500000d;
const TURN_LEFT = 0x6500000e;
const GESTURE = 0x40000033;
const pack = (fwd, turn, run) =>
  (LOCAL_AUTO_MOTION_ACTIVE | (fwd + 1) | ((turn + 1) << 16) | ((run ? 1 : 0) << 24)) >>> 0;

// A fake rig that behaves like EntityManager.setMotion for the two fields the
// controller reads: the base command and the base-issue counter.
function fakeRig(base = READY) {
  const rig = {
    base,
    seq: 0,
    plays: [],
    baseLow: () => rig.base & 0xffff,
    issueSeq: () => rig.seq,
    play: (cmd, speed) => {
      rig.plays.push([cmd, speed]);
      rig.base = cmd;
      rig.seq += 1;
    },
    // Someone else (the server's motion echo, a key press) sets the rig.
    other: (cmd) => {
      rig.base = cmd;
      rig.seq += 1;
    },
  };
  return rig;
}

check("decode: inactive is null; axes and run unpack", () => {
  assert.equal(decodeLocalAutoMotion(0), null);
  assert.deepEqual(decodeLocalAutoMotion(pack(0, 1, true)), { forward: 0, turn: 1, run: true });
  assert.deepEqual(decodeLocalAutoMotion(pack(0, -1, false)), { forward: 0, turn: -1, run: false });
  assert.deepEqual(decodeLocalAutoMotion(pack(1, 0, true)), { forward: 1, turn: 0, run: true });
});

check("commands: turns at the hold-run speed, forward picks the gait", () => {
  assert.deepEqual(localAutoMotionCommand({ forward: 0, turn: 1, run: true }), { cmd: TURN_RIGHT, speed: 1.5, turn: true });
  assert.deepEqual(localAutoMotionCommand({ forward: 0, turn: -1, run: false }), { cmd: TURN_LEFT, speed: 1.0, turn: true });
  assert.deepEqual(localAutoMotionCommand({ forward: 1, turn: 0, run: true }), { cmd: RUN, speed: 1.0, turn: false });
  assert.deepEqual(localAutoMotionCommand({ forward: 1, turn: 0, run: false }), { cmd: WALK, speed: 1.0, turn: false });
  assert.equal(localAutoMotionCommand({ forward: 0, turn: 0, run: true }), null);
});

check("server turn: the turn cycle plays, then Ready when it lands", () => {
  const rig = fakeRig();
  const c = createLocalAutoMotion(rig);
  c.update(pack(0, 1, true));
  assert.deepEqual(rig.plays, [[TURN_RIGHT, 1.5]]);
  c.update(pack(0, 1, true)); // unchanged → nothing re-issued
  assert.equal(rig.plays.length, 1);
  c.update(0);
  assert.deepEqual(rig.plays.at(-1), [READY, 1.0]);
  assert.equal(c.active, false);
});

check("a cast gesture that ends the turn is not stomped by Ready", () => {
  const rig = fakeRig();
  const c = createLocalAutoMotion(rig);
  c.update(pack(0, -1, true));
  rig.other(GESTURE); // the server's gesture lands; its unpack cancels the turn
  c.update(0);
  assert.deepEqual(rig.plays, [[TURN_LEFT, 1.5]], "no Ready over the gesture");
  assert.equal(rig.base, GESTURE);
});

check("a turn does not replace a held gesture", () => {
  const rig = fakeRig(GESTURE);
  const c = createLocalAutoMotion(rig);
  c.update(pack(0, 1, true));
  assert.deepEqual(rig.plays, []);
  c.update(0);
  assert.deepEqual(rig.plays, [], "and nothing to restore");
});

check("MoveTo: turn first, then the run, then Ready on arrival", () => {
  const rig = fakeRig();
  const c = createLocalAutoMotion(rig);
  c.update(pack(0, 1, true));
  c.update(pack(1, 0, true));
  c.update(0);
  assert.deepEqual(rig.plays, [[TURN_RIGHT, 1.5], [RUN, 1.0], [READY, 1.0]]);
});

check("a key press during the drive owns the rig afterwards", () => {
  const rig = fakeRig();
  const c = createLocalAutoMotion(rig);
  c.update(pack(0, 1, true));
  rig.other(RUN); // player pressed W: the manual drive took over
  c.update(0);
  assert.deepEqual(rig.plays, [[TURN_RIGHT, 1.5]]);
  assert.equal(rig.base, RUN);
});

console.log(`\nlocal_auto_motion: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
