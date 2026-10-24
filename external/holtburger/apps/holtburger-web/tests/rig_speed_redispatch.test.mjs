// tests/rig_speed_redispatch.test.mjs — ?retailRigSpeed (2026-10-24): a
// run-rate change re-dispatches the local rig ONLY while a key whose speed
// scales with R is held (run, running backpedal, running strafe). Standing
// still (or turning in place) it must not re-send Ready: that would end a held
// emote (sit / kneel), cut a cast gesture short, or release the death hold
// (review finding, 2026-10-24). Drives the real CameraSwitcher.prototype
// _dispatchMovement against a recording stub.
//
// Run: node tests/rig_speed_redispatch.test.mjs

import assert from "node:assert/strict";

globalThis.location = { search: "?rustPose=off" };
globalThis.window = globalThis;
{
  const winET = new EventTarget();
  globalThis.addEventListener = winET.addEventListener.bind(winET);
  globalThis.removeEventListener = winET.removeEventListener.bind(winET);
  globalThis.dispatchEvent = winET.dispatchEvent.bind(winET);
}
const doc = new EventTarget();
doc.activeElement = null;
globalThis.document = doc;

const { CameraSwitcher } = await import("../scene3d/camera.js");
let failures = 0, passes = 0;
function t(name, fn) {
  try { fn(); passes++; console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name, "\n   ", e.message); }
}

function rig() {
  const s = Object.create(CameraSwitcher.prototype);
  s.R = 4.5;
  s.keys = { forward: 0, strafe: 0, turn: 0, run: true };
  s.dispatched = [];
  Object.assign(s, {
    lastInputSig: null, lastRigMotionSig: null, _inputFunnelOn: false, setMovementInputCount: 0,
    scene3d: { entityManager: { wasmExports: { playerRunRate: () => s.R } } },
    _getSessionHandle: () => ({ setMovementInput() {} }),
    computeMovementFromKeys: () => ({ ...s.keys }),
    _dispatchLocalRigMotion: (m) => s.dispatched.push({ ...m }),
  });
  return s;
}

t("standing still, an R change sends nothing (no unrequested Ready)", () => {
  const s = rig();
  s._dispatchMovement();
  assert.equal(s.dispatched.length, 1, "the first idle dispatch");
  s.R = 2.0; // food / burden / a run buff expiring while /sit is held
  s._dispatchMovement();
  s.R = 3.1;
  s._dispatchMovement();
  assert.equal(s.dispatched.length, 1, "no re-dispatch while idle");
});

t("turning in place, an R change sends nothing (the turn speed is not R)", () => {
  const s = rig();
  s.keys = { forward: 0, strafe: 0, turn: 1, run: true };
  s._dispatchMovement();
  s.R = 2.0;
  s._dispatchMovement();
  assert.equal(s.dispatched.length, 1);
});

t("running, running backpedal and running strafe re-dispatch on an R change", () => {
  for (const keys of [{ forward: 1, strafe: 0, turn: 0, run: true }, { forward: -1, strafe: 0, turn: 0, run: true },
    { forward: 0, strafe: 1, turn: 0, run: true }]) {
    const s = rig();
    s.keys = keys;
    s._dispatchMovement();
    s.R = 2.0;
    s._dispatchMovement();
    assert.equal(s.dispatched.length, 2, JSON.stringify(keys));
    s._dispatchMovement(); // unchanged R and keys: nothing new
    assert.equal(s.dispatched.length, 2);
  }
});

t("walking (run off) does not depend on R", () => {
  const s = rig();
  s.keys = { forward: 1, strafe: 0, turn: 0, run: false };
  s._dispatchMovement();
  s.R = 2.0;
  s._dispatchMovement();
  assert.equal(s.dispatched.length, 1);
});

console.log(`\nrig_speed_redispatch: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
