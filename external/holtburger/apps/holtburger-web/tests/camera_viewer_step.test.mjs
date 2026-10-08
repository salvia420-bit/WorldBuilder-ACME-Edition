// tests/camera_viewer_step.test.mjs — 2026-10-08 round 2 camera parity,
// driven through the real CameraSwitcher (scene3d/camera.js + three) with a
// mock session handle whose building / scenery sweeps model flat walls.
//
//   S1  camera-2  hard-lock: a wall pulls the eye in but the view direction
//                 stays the ideal one (`?camViewerStep=off`: it tilts).
//   S2  camera-2  stiffness: pull-in is immediate, re-extension damped, and
//                 the published eye is never beyond the wall (the legacy
//                 order lerps from behind it).
//   S3  camera-4  retail 0.3 m sphere from the 1.5 m pivot; `=off` restores
//                 0.5 / 0.2 / 1.6; the terrain floor keeps its 0.7 m margin.
//   S4  camera-3  step 4b sweeps the scenery colliders, frees the hit, and
//                 skips cleanly when flagged off or the export is missing.
//   S5  camera-5  a keyless in-place turn rotates followYaw rigidly; keyed
//                 turns keep the ease; a drag never leaves a stale heading.
//   S6  charopt-2 option 0x07 + melee/missile + attackable target swings
//                 followYaw toward the target and stands autofollow down.
//
// Run: node tests/camera_viewer_step.test.mjs

import * as THREE from "three";
import assert from "node:assert/strict";

// rustPose=off: `_safePlayerPos` reads getPlayerWorldPos (a fixed point).
globalThis.location = { search: "?rustPose=off" };
globalThis.window = globalThis;

const { CameraSwitcher } = await import("../scene3d/camera.js");
const { stiffnessFrac } = await import("../scene3d/camera_math.js");

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

const P = { x: 100, y: 200, z: 80 }; // player, AC world metres
const DT = 1 / 60;
const LB = 0xa9b40024; // outdoor cell

/** Plane y = `y` facing +Y: a sphere of radius r moving -Y stops at y + r. */
function planeHit(y, fy, ty, r) {
  if (y == null) return null;
  const c = y + r;
  if (!(fy > c && ty < c)) return null;
  return { t: (fy - c) / (fy - ty), freed: false, free() { this.freed = true; } };
}

function makeHandle() {
  const h = {
    heading: 0,
    wallY: null,
    sceneryY: null,
    terrainZ: -1e4,
    combat: 1,
    optionOn: false,
    calls: { building: [], scenery: [], hits: [] },
    getLocalPlayerPose() {
      return { x: 4, y: 8, z: P.z, heading: h.heading, landblockId: LB, free() {} };
    },
    terrainHeightAt() { return h.terrainZ; },
    sweepSphereAgainstBuildingMesh(fx, fy, fz, tx, ty, tz, r, lb) {
      h.calls.building.push({ fx, fy, fz, tx, ty, tz, r, lb });
      return planeHit(h.wallY, fy, ty, r);
    },
    sweepSphereAgainstStatics() { return null; },
    sweepSphereAgainstScenery(fx, fy, fz, tx, ty, tz, r, lb) {
      h.calls.scenery.push({ fx, fy, fz, tx, ty, tz, r, lb });
      const hit = planeHit(h.sceneryY, fy, ty, r);
      if (hit) h.calls.hits.push(hit);
      return hit;
    },
    combatMode() { return h.combat; },
    isCharacterOptionEnabled(o) { return o === 0x07 && h.optionOn; },
  };
  return h;
}

function makeSwitcher(h, scene3d = {}) {
  const persp = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
  const cs = new CameraSwitcher({
    scene3d,
    perspectiveCamera: persp,
    orthoCamera: ortho,
    domElement: null,
    sessionHandle: h,
    getPlayerWorldPos: () => P,
  });
  return cs;
}

/** Published eye in AC coords (acToThree inverse: [x, z, -y]). */
function eyeAc(cs) {
  const p = cs.persp.position;
  return { x: p.x, y: -p.z, z: p.y };
}
function viewDir(cs) {
  return cs.persp.getWorldDirection(new THREE.Vector3());
}

await t("S1 camera-2 hard-lock: the wall moves the eye, not the view direction", () => {
  const h = makeHandle();
  const cs = makeSwitcher(h);
  cs.positionCamera(DT);
  const free = eyeAc(cs);
  const dir0 = viewDir(cs);
  h.wallY = 197; // 3 m behind the player; the ideal eye is ~5.7 m back
  cs.positionCamera(DT);
  const clipped = eyeAc(cs);
  assert.ok(clipped.y > 197.3 - 1e-6, `eye beyond the wall: y=${clipped.y}`);
  assert.ok(clipped.y - free.y > 2.5, "the eye pulled in");
  assert.ok(viewDir(cs).angleTo(dir0) < 1e-6, "view direction unchanged by the clip");
  // Legacy order (=off): the view is re-aimed from the clipped eye and tilts.
  window.__setCamViewerStep(false);
  h.wallY = null;
  cs.positionCamera(DT);
  assert.ok(viewDir(cs).angleTo(dir0) < 1e-6, "no wall: both orders agree");
  h.wallY = 197;
  cs.positionCamera(DT);
  assert.ok(viewDir(cs).angleTo(dir0) > 0.05, "legacy tilts the view on pull-in");
});

await t("S2 camera-2 stiffness: immediate pull-in, damped re-extension, never past the wall", () => {
  const h = makeHandle();
  const cs = makeSwitcher(h);
  window.__setCamStiffness(0.45);
  const frac = stiffnessFrac(0.45, DT);
  cs.positionCamera(DT); // unseeded → snaps to the ideal
  const ideal = eyeAc(cs);
  h.wallY = 197;
  cs.positionCamera(DT);
  const pressed = eyeAc(cs);
  assert.ok(pressed.y > 197.3 - 1e-6, `pull-in is immediate: y=${pressed.y}`);
  // (c) pressed against the wall: the eye holds still.
  let prev = pressed;
  for (let i = 0; i < 30; i++) {
    cs.positionCamera(DT);
    const e = eyeAc(cs);
    const d = Math.hypot(e.x - prev.x, e.y - prev.y, e.z - prev.z);
    assert.ok(d < 1e-3, `frame ${i}: eye jitters ${d}`);
    assert.ok(e.y > 197.3 - 1e-6);
    prev = e;
  }
  // (b) wall gone: the eye moves only `frac` of the way back out.
  h.wallY = null;
  cs.positionCamera(DT);
  const out = eyeAc(cs);
  const want = prev.y + (ideal.y - prev.y) * frac;
  assert.ok(Math.abs(out.y - want) < 1e-4, `re-extension y=${out.y} want ${want}`);
  // Legacy order lerps from the old eye toward the CLIPPED one: a wall that
  // appears behind a free eye leaves the camera on the far side of it.
  window.__setCamViewerStep(false);
  window.__setCamStiffness(0.45);
  cs.positionCamera(DT); // re-seed at the ideal
  h.wallY = 197;
  cs.positionCamera(DT);
  assert.ok(eyeAc(cs).y < 197, "legacy: still behind the wall after the frame");
});

await t("S3 camera-4 retail viewer sphere + pivot; =off restores 0.5 / 0.2 / 1.6", () => {
  const h = makeHandle();
  const cs = makeSwitcher(h);
  h.wallY = 197;
  cs.positionCamera(DT);
  const on = h.calls.building.at(-1);
  assert.equal(on.r, 0.3);
  assert.ok(Math.abs(on.fz - (P.z + 1.5)) < 1e-9, `pivot z ${on.fz}`);
  // Contact minus the 0.02 m skin along the boom.
  const len = Math.hypot(on.tx - on.fx, on.ty - on.fy, on.tz - on.fz);
  const tc = (on.fy - 197.3) / (on.fy - on.ty);
  const want = on.fy + (on.ty - on.fy) * (tc - 0.02 / len);
  assert.ok(Math.abs(eyeAc(cs).y - want) < 1e-6);
  window.__setCamRetailSphere(false);
  cs.positionCamera(DT);
  const off = h.calls.building.at(-1);
  assert.equal(off.r, 0.5);
  assert.ok(Math.abs(off.fz - (P.z + 1.6)) < 1e-9);
  const len2 = Math.hypot(off.tx - off.fx, off.ty - off.fy, off.tz - off.fz);
  const tc2 = (off.fy - 197.5) / (off.fy - off.ty);
  assert.ok(Math.abs(eyeAc(cs).y - (off.fy + (off.ty - off.fy) * (tc2 - 0.2 / len2))) < 1e-6);
  // The terrain floor keeps the 0.5 + 0.2 margin under both flags.
  h.wallY = null;
  h.terrainZ = 90;
  for (const flag of [true, false]) {
    window.__setCamRetailSphere(flag);
    cs.positionCamera(DT);
    assert.ok(Math.abs(eyeAc(cs).z - 90.7) < 1e-6, `floor z ${eyeAc(cs).z} (sphere ${flag})`);
  }
});

await t("S4 camera-3 step 4b: scenery sweep clips + frees, escape + stale pkg skip it", () => {
  const h = makeHandle();
  const cs = makeSwitcher(h);
  h.sceneryY = 196;
  cs.positionCamera(DT);
  const c = h.calls.scenery.at(-1);
  assert.ok(c, "sweepSphereAgainstScenery was called");
  assert.equal(c.r, 0.3);
  assert.equal(c.lb, LB);
  assert.ok(eyeAc(cs).y > 196.3 - 1e-6, "eye stops at the trunk");
  assert.ok(h.calls.hits.length > 0 && h.calls.hits.every((x) => x.freed), "hit freed");
  const n = h.calls.scenery.length;
  window.__setCamScenery(false);
  cs.positionCamera(DT);
  assert.equal(h.calls.scenery.length, n, "flag off: no scenery sweep");
  assert.ok(eyeAc(cs).y < 196, "flag off: the trunk no longer clips");
  window.__setCamScenery(true);
  delete h.sweepSphereAgainstScenery; // a pkg/ built before the export
  cs.positionCamera(DT);
  assert.ok(eyeAc(cs).y < 196);
});

await t("S5 camera-5 keyless in-place turn: rigid follow; keyed = ease; drag leaves no stale ref", () => {
  const h = makeHandle();
  const cs = makeSwitcher(h);
  cs.followYaw = 0.5; // the user orbited off the back
  cs._updateAutoFollow(DT); // seeds the heading reference + _lastFollowPos
  // pose.heading θ → followYaw convention −θ: a −0.3 rad pose turn = +0.3.
  h.heading = -0.3;
  cs._updateAutoFollow(DT);
  assert.ok(Math.abs(cs.followYaw - 0.8) < 1e-9, `rigid: ${cs.followYaw}`);
  // Keyed (Q held): the existing ease to behind governs, not the rigid add.
  cs.keys.q = true;
  h.heading = -0.6;
  const before = cs.followYaw;
  cs._updateAutoFollow(DT);
  const ease = 1 - Math.exp(-4.0 * DT);
  assert.ok(Math.abs(cs.followYaw - (before + (0.6 - before) * ease)) < 1e-9);
  cs.keys.q = false;
  // A turn during a drag is consumed by the reference: nothing fires after.
  cs._followDragging = true;
  h.heading = -1.6;
  const held = cs.followYaw;
  cs._updateAutoFollow(DT);
  assert.equal(cs.followYaw, held, "dragging holds");
  cs._followDragging = false;
  cs._lastUserYawMs = null;
  cs._updateAutoFollow(DT);
  assert.equal(cs.followYaw, held, "no stale delta after the drag");
  // Escape.
  window.__setAutoFollowTurns(false);
  h.heading = -2.0;
  cs._updateAutoFollow(DT);
  cs._updateAutoFollow(DT);
  assert.equal(cs.followYaw, held, "=off: idle turns hold the camera");
});

await t("S6 charopt-2 ViewCombatTarget swings toward the attack target", () => {
  const h = makeHandle();
  const TARGET = 0x80000a01;
  const em = {
    attackable: true,
    entityMap: new Map([[TARGET, { root: { position: { x: P.x + 10, y: P.y, z: P.z } } }]]),
    getSelectedTarget: () => TARGET,
    attackTargetFor: (g) => g,
    _isAttackableTarget: (g) => g === TARGET && em.attackable,
  };
  const cs = makeSwitcher(h, { entityManager: em });
  const reset = () => { cs._viewCombatTargetOpt = null; };
  // Option off (retail default) → no tracking.
  assert.equal(cs._updateCombatTargetTracking(DT), false);
  h.optionOn = true;
  reset();
  assert.equal(cs._updateCombatTargetTracking(DT), false, "peace mode");
  h.combat = 8;
  reset();
  assert.equal(cs._updateCombatTargetTracking(DT), false, "magic mode does not track");
  h.combat = 2;
  reset();
  cs.followYaw = 0;
  assert.equal(cs._updateCombatTargetTracking(DT), true, "melee + option + target");
  const ease = 1 - Math.exp(-4.0 * DT);
  assert.ok(Math.abs(cs.followYaw - (Math.PI / 2) * ease) < 1e-9, `${cs.followYaw}`);
  for (let i = 0; i < 20; i++) cs._updateCombatTargetTracking(1.0);
  assert.ok(Math.abs(cs.followYaw - Math.PI / 2) < 1e-6, "converges on the target bearing");
  h.combat = 4;
  assert.equal(cs._updateCombatTargetTracking(DT), true, "missile tracks too");
  // While tracking, autofollow's own ease stands down (keys held).
  cs.keys.w = true;
  const y = cs.followYaw;
  cs._updateAutoFollow(DT, true);
  assert.equal(cs.followYaw, y);
  cs.keys.w = false;
  em.attackable = false;
  assert.equal(cs._updateCombatTargetTracking(DT), false, "non-attackable");
  em.attackable = true;
  window.__setCombatTargetView(false);
  assert.equal(cs._updateCombatTargetTracking(DT), false, "=off escape");
});

console.log(`camera viewer step: ${groups} groups ok, ${failures} failed`);
if (failures) process.exit(1);
