// tests/remote_substate.test.mjs — ?remoteSubstate (2026-10-24, REMOTE-2,
// default ON): a remote's pure sidestep / turn in place arrives on KIND_MOTION
// as the substate at its signed wire speed (src/session/messages/position.rs)
// and loop.js `_armMotion` plays it, instead of Ready at 1.0 (the remote slid
// in the idle pose). Drives the real dispatchEntityUpdate; the `=off` arm
// re-runs this file in a child process (the flag is read at module load).
//
// Run from apps/holtburger-web/:  node tests/remote_substate.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const OFF = process.env.HB_REMOTE_SUBSTATE_ARM === "off";
globalThis.location = { search: OFF ? "?remoteSubstate=off" : "" };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.window = globalThis;
globalThis.getLocalPlayerGuid = () => 0x50000001;

const { dispatchEntityUpdate } = await import("../scene3d/loop.js");
const { KIND } = await import("../scene3d/entity_dispatch.js");

let failures = 0, passes = 0;
function t(name, fn) {
  try { fn(); passes++; console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name, "\n   ", e.message); }
}

const REMOTE = 0x50000007, STANCE = 0x8000003d;
function rig() {
  const remote = {};
  const calls = [];
  const em = {
    entityMap: new Map([[REMOTE, remote]]),
    setMotion(guid, cmd, st, speed) { calls.push({ guid, cmd: cmd >>> 0, speed }); },
    setLocalStance() {},
  };
  return { em, calls, remote, scene3d: { entityManager: em } };
}
const motion = (cmd, speed) => ({ kind: KIND.MOTION, guid: REMOTE, motionStance: STANCE, motionCommand: cmd, motionSpeed: speed, isAutonomous: true });

if (!OFF) {
  t("a pure left strafe plays SideStepRight at its signed wire speed", () => {
    const { em, calls, remote, scene3d } = rig();
    dispatchEntityUpdate(scene3d, em, motion(0x6500000f, -1.248));
    assert.deepEqual(calls, [{ guid: REMOTE, cmd: 0x6500000f, speed: -1.248 }]);
    assert.equal(remote._kindMotionLow, 0x000f);
  });
  t("a turn in place plays TurnRight at its signed wire speed", () => {
    const { em, calls, remote, scene3d } = rig();
    dispatchEntityUpdate(scene3d, em, motion(0x6500000d, -1.5));
    assert.deepEqual(calls, [{ guid: REMOTE, cmd: 0x6500000d, speed: -1.5 }]);
    assert.equal(remote._kindMotionLow, 0x000d);
  });
  t("the wasm's low-16 substate (0x000f / 0x000d) arms the same way", () => {
    for (const [cmd, speed] of [[0x000f, -3.0], [0x000d, 1.5]]) {
      const { em, calls, remote, scene3d } = rig();
      dispatchEntityUpdate(scene3d, em, motion(cmd, speed));
      assert.deepEqual(calls, [{ guid: REMOTE, cmd, speed }]);
      assert.equal(remote._kindMotionLow, cmd);
    }
  });
  t("a run is untouched", () => {
    const { em, calls, remote, scene3d } = rig();
    dispatchEntityUpdate(scene3d, em, motion(0x44000007, 2.65));
    assert.deepEqual(calls, [{ guid: REMOTE, cmd: 0x44000007, speed: 2.65 }]);
    assert.equal(remote._kindMotionLow, 0x0007);
  });
  t("=off: the substate maps back to Ready at 1.0", () => {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, HB_REMOTE_SUBSTATE_ARM: "off" }, encoding: "utf8", timeout: 60000,
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
} else {
  t("(=off) a pure strafe / turn arms Ready at 1.0", () => {
    for (const [cmd, speed] of [[0x6500000f, -1.248], [0x6500000d, 1.5], [0x000f, -3.0], [0x000e, 1.0]]) {
      const { em, calls, remote, scene3d } = rig();
      dispatchEntityUpdate(scene3d, em, motion(cmd, speed));
      assert.deepEqual(calls, [{ guid: REMOTE, cmd: 0x0003, speed: 1.0 }]);
      assert.equal(remote._kindMotionLow, 0x0003);
    }
  });
  t("(=off) a run is untouched", () => {
    const { em, calls, scene3d } = rig();
    dispatchEntityUpdate(scene3d, em, motion(0x44000007, 2.65));
    assert.deepEqual(calls, [{ guid: REMOTE, cmd: 0x44000007, speed: 2.65 }]);
  });
}

console.log(`\nremote_substate${OFF ? " (=off)" : ""}: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
