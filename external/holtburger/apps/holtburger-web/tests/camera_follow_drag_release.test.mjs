// tests/camera_follow_drag_release.test.mjs — app-loop-3: the follow-mode
// right-drag (free-look) must end when its mouseup can never arrive, driven
// through the real CameraSwitcher (scene3d/camera.js + three) with minimal
// EventTarget-backed `window`, `document` and canvas stand-ins.
//
//   D1  window blur ends a held drag; a later button-up move does not turn.
//   D2  a move with the right button up (ev.buttons & 2 === 0) self-heals.
//   D3  a move with the right button held (buttons = 2) still turns.
//   D4  a click (< 5 px travel) still opens the context menu exactly once;
//       a blur- or buttons-ended drag opens it zero times.
//   D5  switchMode away mid-drag ends the drag (autofollow not left
//       suspended) and the hook is re-armed on the next follow entry.
//
// Run: node tests/camera_follow_drag_release.test.mjs

import * as THREE from "three";
import assert from "node:assert/strict";

globalThis.location = { search: "?rustPose=off" };
globalThis.window = globalThis;
// Node's globalThis is not an EventTarget; give it one for the blur listener.
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

let groups = 0;
let failures = 0;
async function t(name, fn) {
  try {
    await fn();
    groups++;
    console.log("  ok ", name);
  } catch (e) {
    failures++;
    console.log("  FAIL", name);
    console.log(e);
  }
}

const P = { x: 100, y: 200, z: 80 };
const PICK_GUID = 0x50000001;

/** A plain Event carrying the MouseEvent fields camera.js reads. */
function mouse(type, fields) {
  const ev = new Event(type, { cancelable: true });
  return Object.assign(ev, fields);
}

function makeSwitcher() {
  const canvas = new EventTarget();
  const cs = new CameraSwitcher({
    scene3d: {},
    perspectiveCamera: new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000),
    orthoCamera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000),
    domElement: canvas,
    sessionHandle: null,
    getPlayerWorldPos: () => P,
  });
  return { cs, canvas };
}

const menuCalls = [];
window.__pickEntityAt = () => PICK_GUID;
window.__openContextMenuFor = (arg) => menuCalls.push(arg);

function press(canvas, x = 100, y = 100) {
  canvas.dispatchEvent(mouse("mousedown", { button: 2, buttons: 2, clientX: x, clientY: y }));
}
function move(x, y, buttons) {
  doc.dispatchEvent(mouse("mousemove", { button: 0, buttons, clientX: x, clientY: y }));
}
function release(x = 100, y = 100) {
  doc.dispatchEvent(mouse("mouseup", { button: 2, buttons: 0, clientX: x, clientY: y }));
}

await t("D1 window blur ends a held right-drag; later plain moves do not turn", () => {
  const { cs, canvas } = makeSwitcher();
  assert.equal(typeof cs._endFollowDrag, "function", "follow mode arms the end hook");
  press(canvas);
  assert.equal(cs._followDragging, true);
  cs._lastUserYawMs = null;
  window.dispatchEvent(new Event("blur"));
  assert.equal(cs._followDragging, false, "blur cleared free-look");
  assert.ok(cs._lastUserYawMs != null, "blur starts the post-drag grace");
  const yaw0 = cs.followYaw;
  const pitch0 = cs.followPitch;
  move(150, 130, 0);
  move(200, 160, 0);
  assert.equal(cs.followYaw, yaw0, "no yaw from a released mouse");
  assert.equal(cs.followPitch, pitch0, "no pitch from a released mouse");
  cs.dispose();
});

await t("D2 a move with the right button up self-heals a lost mouseup", () => {
  const { cs, canvas } = makeSwitcher();
  press(canvas);
  const yaw0 = cs.followYaw;
  move(150, 100, 0);
  assert.equal(cs._followDragging, false, "buttons=0 ended the drag");
  assert.equal(cs.followYaw, yaw0, "the healing move itself does not turn");
  // Even a later held-looking move does not resume without a new press.
  move(200, 100, 2);
  assert.equal(cs.followYaw, yaw0, "no turn without a fresh right press");
  // Buttons with other bits but not the secondary one also heal.
  press(canvas, 200, 100);
  move(260, 100, 1);
  assert.equal(cs._followDragging, false, "buttons=1 (left only) ended the drag");
  assert.equal(cs.followYaw, yaw0);
  cs.dispose();
});

await t("D3 a move with the right button held still turns", () => {
  const { cs, canvas } = makeSwitcher();
  press(canvas);
  const yaw0 = cs.followYaw;
  move(150, 100, 2);
  assert.equal(cs._followDragging, true, "still dragging");
  assert.notEqual(cs.followYaw, yaw0, "yaw turned");
  const yaw1 = cs.followYaw;
  move(200, 100, 3); // left + right both held
  assert.notEqual(cs.followYaw, yaw1, "right bit set ⇒ still a drag");
  release(200, 100);
  assert.equal(cs._followDragging, false);
  // A missing `buttons` field (non-MouseEvent dispatch) keeps legacy behaviour.
  press(canvas, 200, 100);
  const yaw2 = cs.followYaw;
  doc.dispatchEvent(mouse("mousemove", { clientX: 260, clientY: 100 }));
  assert.notEqual(cs.followYaw, yaw2, "no buttons field ⇒ legacy turn");
  release(260, 100);
  cs.dispose();
});

await t("D4 click opens the context menu once; blur/buttons-ended drags never", () => {
  const { cs, canvas } = makeSwitcher();
  menuCalls.length = 0;
  press(canvas, 100, 100);
  release(101, 101);
  assert.equal(menuCalls.length, 1, "a right click opens the menu once");
  assert.equal(menuCalls[0].guid, PICK_GUID);
  assert.equal(menuCalls[0].source, "scene3d");

  menuCalls.length = 0;
  press(canvas, 100, 100);
  window.dispatchEvent(new Event("blur"));
  release(100, 100); // a stray late mouseup must not open it either
  assert.equal(menuCalls.length, 0, "blur-ended drag opens no menu");

  press(canvas, 100, 100);
  move(101, 100, 0);
  release(101, 100);
  assert.equal(menuCalls.length, 0, "buttons-ended drag opens no menu");
  cs.dispose();
});

await t("D5 switching mode mid-drag ends it; follow re-entry re-arms the hook", () => {
  const { cs, canvas } = makeSwitcher();
  press(canvas);
  assert.equal(cs._followDragging, true);
  cs.switchMode("topDown");
  assert.equal(cs._followDragging, false, "mode teardown ended the drag");
  assert.equal(cs._endFollowDrag, null, "hook dropped with its listeners");
  window.dispatchEvent(new Event("blur")); // must not throw with no hook
  cs.switchMode("follow");
  assert.equal(typeof cs._endFollowDrag, "function", "re-armed");
  press(canvas);
  window.dispatchEvent(new Event("blur"));
  assert.equal(cs._followDragging, false, "the re-armed hook works");
  cs.dispose();
});

console.log(`\ncamera_follow_drag_release: ${groups} ok, ${failures} failed`);
if (failures > 0) process.exit(1);
