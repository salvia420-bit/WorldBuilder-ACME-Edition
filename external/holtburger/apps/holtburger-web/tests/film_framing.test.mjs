// tests/film_framing.test.mjs
//
// WHY: AC Film Mode sizes and composes every subject shot with ONE framing
// model (frame height = k·H; distance = k·H / (2·tan(fov/2))) and measures
// composition by projecting through the camera WITHOUT a renderer (scouting,
// solver scoring and the JEV pilot's "subject size / offset" words run in
// Node and in the page off the render path). If projectToNdc disagrees with
// three.js, every in-frame / size / thirds number the director and pilot act
// on is wrong. This suite EXECUTES scene3d/film/shots/framing.js and proves:
//   F1  FRAMINGS values, name/number resolution, errors;
//   F2  distanceForFraming (FS of a 1.8 m human at fov 50 → 2.2196 m) and its
//       inverse fovForFraming; monotone across the shot sizes;
//   F3  aim points (eye line 0.9H for MS..ECU, centre for FS/WS/EWS) and
//       subject normalisation (base vs centred spheres);
//   F4  projectToNdc equals REAL three 0.184 `Vector3.project` within 1e-6 over
//       random poses (incl. exact ±90° pitch, roll, pitched-past-the-pole
//       quaternions) and random points INCLUDING points behind the camera
//       (three's mirrored values, inFront = false);
//   F5  subjectScreenRect: exact sphere bounds vs analytic + brute-force
//       three projection; behind / inside cases; capsule subjects;
//   F6  compositionMetrics: sizeRatio = 1 at the framing distance, thirds,
//       headroom, horizon tilt = roll, behind-camera handling, top-down size;
//   F7  thirdsAimOffset lands the subject on the thirds lines; leadRoomSide.
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — these are its pure shot modules.
// Run from apps/holtburger-web/: node tests/film_framing.test.mjs

import assert from "node:assert/strict";

const FR = await import("../scene3d/film/shots/framing.js");
const G = await import("../scene3d/film/core/gimbal.js");
const Q = await import("../scene3d/film/core/quat.js");
const { FilmShotError } = await import("../scene3d/film/core/errors.js");
const { mulberry32 } = await import("../scene3d/film/core/rng.js");
const THREE = await import("three");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err && err.message ? err.message : err}`);
  }
}

const PI = Math.PI;
const HALF_PI = PI / 2;
const DEG = PI / 180;

function near(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= eps, `${msg ?? "value"}: ${a} vs ${b} (eps ${eps})`);
}
function nearV(a, b, eps, msg) {
  for (let i = 0; i < a.length; i++) near(a[i], b[i], eps, `${msg ?? "vec"}[${i}]`);
}
function shotErr(code) {
  return (e) => e instanceof FilmShotError && (code === undefined || e.code === code);
}

/** A three PerspectiveCamera matching an AC pose (SPEC §1 frame conversion). */
function threeCamera(pose, fov, aspect) {
  const cam = new THREE.PerspectiveCamera(fov, aspect, 0.1, 5000);
  cam.position.set(...G.acToThreePos(pose.pos));
  cam.quaternion.set(...G.acQuatToThree(pose.q));
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

/** Pose from h/p/r at a position. */
function poseAt(pos, h, p, r = 0, fov = 60) {
  return { t: 0, pos, h, p, r, q: G.quatFromHPR(h, p, r), fov };
}

// ---------------------------------------------------------------------------

check("F1 FRAMINGS values and name/number resolution", () => {
  assert.deepEqual({ ...FR.FRAMINGS }, { EWS: 8.0, WS: 2.5, FS: 1.15, MWS: 0.75, MS: 0.5, MCU: 0.33, CU: 0.2, ECU: 0.1 });
  assert.deepEqual(FR.FRAMING_NAMES, ["EWS", "WS", "FS", "MWS", "MS", "MCU", "CU", "ECU"]);
  assert.ok(Object.isFrozen(FR.FRAMINGS));
  assert.equal(FR.framingFactor("fs"), 1.15);
  assert.equal(FR.framingFactor(" CU "), 0.2);
  assert.equal(FR.framingFactor(0.42), 0.42);
  assert.equal(FR.canonicalFraming("mcu"), "MCU");
  assert.equal(FR.canonicalFraming(3), 3);
  for (const bad of ["XL", "", 0, -1, NaN, null, undefined, {}]) {
    assert.throws(() => FR.framingFactor(bad), shotErr("BAD_FRAMING"), `framing ${String(bad)}`);
  }
  assert.throws(() => FR.framingFactor("XL"), /valid: EWS, WS, FS, MWS, MS, MCU, CU, ECU/);
});

check("F2 distanceForFraming: FS of a 1.8 m human at fov 50 → 2.2196 m; formula; inverse; monotone", () => {
  const d = FR.distanceForFraming("FS", 1.8, 50);
  near(d, 2.2196, 1e-4, "FS 1.8 m fov 50");
  near(d, (1.15 * 1.8) / (2 * Math.tan(25 * DEG)), 1e-12, "k·H/(2·tan(fov/2))");
  // at that distance the visible frame height is exactly 1.15·H
  near(2 * d * Math.tan(25 * DEG), 1.15 * 1.8, 1e-12, "frame height");
  let prev = Infinity;
  for (const name of FR.FRAMING_NAMES) {
    const dist = FR.distanceForFraming(name, 1.8, 45);
    assert.ok(dist < prev, `${name} closer than the wider framing`);
    prev = dist;
    near(FR.fovForFraming(name, 1.8, dist), 45, 1e-9, `fovForFraming inverts ${name}`);
  }
  near(FR.fovForFraming("MS", 2, 10), (2 * Math.atan((0.5 * 2) / 20)) / DEG, 1e-12);
  assert.throws(() => FR.distanceForFraming("FS", 0, 50), shotErr("BAD_ARGUMENT"));
  assert.throws(() => FR.distanceForFraming("FS", 1.8, 180), shotErr("BAD_ARGUMENT"));
  assert.throws(() => FR.distanceForFraming("FS", 1.8, NaN), shotErr("BAD_ARGUMENT"));
  assert.throws(() => FR.fovForFraming("FS", 1.8, 0), shotErr("BAD_ARGUMENT"));
  assert.throws(() => FR.distanceForFraming("huge", 1.8, 50), shotErr("BAD_FRAMING"));
});

check("F3 aim points: eye line for MS..ECU, centre for FS/WS/EWS, MWS between", () => {
  const s = { pos: [1, 2, 10], height: 2, radius: 0.5 };
  for (const n of ["MS", "MCU", "CU", "ECU"]) nearV(FR.aimPointForFraming(n, s), [1, 2, 11.8], 1e-12, n);
  for (const n of ["FS", "WS", "EWS"]) nearV(FR.aimPointForFraming(n, s), [1, 2, 11], 1e-12, n);
  const mws = FR.aimPointForFraming("MWS", s)[2] - 10;
  assert.ok(mws > 1.0 && mws < 1.8, `MWS aim ${mws}`);
  near(FR.aimHeightFraction("MWS"), 0.5 + (0.4 * (1.15 - 0.75)) / (1.15 - 0.5), 1e-12);
  assert.equal(FR.aimHeightFraction(20), 0.5);
  assert.equal(FR.aimHeightFraction(0.05), 0.9);
});

check("F3 normalizeSubject: base vs centred sphere, defaults, extras kept, errors", () => {
  const a = FR.normalizeSubject([1, 2, 3]);
  assert.deepEqual(a, { pos: [1, 2, 3], height: 1.8, radius: 0.45 });
  const b = FR.normalizeSubject({ pos: [0, 0, 5], radius: 2, heading: 1, guid: 7 });
  assert.equal(b.height, 4);
  assert.equal(b.heading, 1);
  assert.equal(b.guid, 7);
  const c = FR.normalizeSubject({ center: [0, 0, 5], radius: 2 });
  assert.deepEqual(c.pos, [0, 0, 3]);
  assert.equal(c.height, 4);
  assert.equal("center" in c, false);
  const d = FR.normalizeSubject({ position: [4, 4, 4], height: 3 });
  assert.equal(d.radius, 0.75);
  assert.deepEqual(d.pos, [4, 4, 4]);
  assert.throws(() => FR.normalizeSubject({ pos: [NaN, 0, 0] }), shotErr("BAD_SUBJECT"));
  assert.throws(() => FR.normalizeSubject({ pos: [0, 0, 0], height: -1 }), shotErr("BAD_SUBJECT"));
  assert.throws(() => FR.normalizeSubject(null), shotErr("BAD_SUBJECT"));
});

check("F4 projectToNdc == three.js Vector3.project (1e-6) incl. ±90° pitch, roll and BEHIND-camera points", () => {
  const rng = mulberry32(1234);
  const rr = (a, b) => a + (b - a) * rng();
  let compared = 0, behind = 0, front = 0;
  for (let i = 0; i < 300; i++) {
    let h = rr(-PI, PI), p = rr(-HALF_PI, HALF_PI);
    if (i % 10 === 0) p = -HALF_PI;
    if (i % 10 === 1) p = HALF_PI;
    const r = i % 3 === 0 ? 0 : rr(-0.8, 0.8);
    let q = G.quatFromHPR(h, p, r);
    if (i % 10 === 2) q = G.quatFromHPR(h, -HALF_PI - rr(0.01, 0.6), r); // pitched past nadir (FPV)
    const pose = { t: 0, pos: [rr(-500, 500), rr(-500, 500), rr(0, 120)], h, p, r, q, fov: rr(20, 100) };
    const aspect = [16 / 9, 4 / 3, 2.4, 1][i % 4];
    const cam = threeCamera(pose, pose.fov, aspect);
    for (let j = 0; j < 8; j++) {
      const pt = [pose.pos[0] + rr(-60, 60), pose.pos[1] + rr(-60, 60), pose.pos[2] + rr(-60, 60)];
      const v = new THREE.Vector3(...G.acToThreePos(pt));
      const viewZ = v.clone().applyMatrix4(cam.matrixWorldInverse).z;
      if (Math.abs(viewZ) < 0.05) continue;
      const ours = FR.projectToNdc(pose, pt, pose.fov, aspect);
      v.project(cam);
      near(ours.x, v.x, 1e-6 * Math.max(1, Math.abs(v.x)), `x #${i}.${j}`);
      near(ours.y, v.y, 1e-6 * Math.max(1, Math.abs(v.y)), `y #${i}.${j}`);
      near(ours.depth, -viewZ, 1e-6, "depth = −viewZ");
      assert.equal(ours.inFront, viewZ < 0, "inFront ⇔ three view z < 0");
      assert.equal(ours.onScreen, viewZ < 0 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1);
      compared += 1;
      if (viewZ < 0) front += 1;
      else behind += 1;
    }
  }
  assert.ok(compared > 2000 && behind > 500 && front > 500, `coverage ${compared}/${front}/${behind}`);
});

check("F4 projectToNdc edge cases: camera-plane points, NaN inputs, fov/aspect fallbacks", () => {
  const pose = poseAt([0, 0, 0], 0, 0, 0, 60);
  const onPlane = FR.projectToNdc(pose, [5, 0, 0]);
  assert.ok(Number.isFinite(onPlane.x) && Math.abs(onPlane.x) === 1e6, `clamped ${onPlane.x}`);
  assert.equal(onPlane.inFront, false);
  assert.deepEqual(FR.projectToNdc(pose, [NaN, 1, 1]), { x: 0, y: 0, depth: 0, inFront: false, onScreen: false });
  assert.deepEqual(FR.projectToNdc(null, [1, 1, 1]), { x: 0, y: 0, depth: 0, inFront: false, onScreen: false });
  const a = FR.projectToNdc({ pos: [0, 0, 0], h: 0, p: 0, fov: 40 }, [1, 10, 0]);
  near(a.x, 0.1 / (Math.tan(20 * DEG) * 16 / 9), 1e-12, "pose.fov and default aspect, q from h/p");
  const b = FR.projectToNdc(pose, [0, 10, 1], NaN, -1);
  near(b.y, 0.1 / Math.tan(30 * DEG), 1e-12, "invalid fov/aspect fall back");
});

check("F5 subjectScreenRect: exact sphere bounds (analytic + brute-force three), behind / inside cases", () => {
  const pose = poseAt([0, 0, 0], 0, 0, 0, 60);
  const r = FR.subjectScreenRect(pose, { center: [0, 10, 0], radius: 1 }, 60, 16 / 9);
  const tY = Math.tan(Math.asin(0.1)) / Math.tan(30 * DEG);
  near(r.y1, tY, 1e-12, "top");
  near(r.y0, -tY, 1e-12, "bottom");
  near(r.heightFrac, tY, 1e-12, "heightFrac = (y1 − y0)/2");
  near(r.x1, tY / (16 / 9), 1e-12, "right");
  assert.equal(r.visible, true);
  // brute force against three for an off-axis sphere on a rolled, pitched camera
  const pose2 = poseAt([3, -2, 5], 0.4, -0.3, 0.2, 50);
  const sphere = { center: [9, 12, 0.5], radius: 2.5 };
  const rect = FR.subjectScreenRect(pose2, sphere, 50, 1.5);
  const cam = threeCamera(pose2, 50, 1.5);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < 200; i++) {
    for (let j = 0; j <= 100; j++) {
      const th = (2 * PI * i) / 200, ph = (PI * j) / 100;
      const pt = [sphere.center[0] + 2.5 * Math.sin(ph) * Math.cos(th), sphere.center[1] + 2.5 * Math.sin(ph) * Math.sin(th), sphere.center[2] + 2.5 * Math.cos(ph)];
      const v = new THREE.Vector3(...G.acToThreePos(pt)).project(cam);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
  }
  assert.ok(rect.x0 <= x0 + 1e-9 && rect.x1 >= x1 - 1e-9 && rect.y0 <= y0 + 1e-9 && rect.y1 >= y1 - 1e-9, "rect contains every projected surface point");
  for (const [a, b] of [[rect.x0, x0], [rect.x1, x1], [rect.y0, y0], [rect.y1, y1]]) near(a, b, 2e-3, "tight");
  const behind = FR.subjectScreenRect(pose, { center: [0, -10, 0], radius: 1 });
  assert.equal(behind.visible, false);
  assert.equal(behind.heightFrac, 0);
  const inside = FR.subjectScreenRect(pose, { center: [0, 0.5, 0], radius: 1 });
  assert.equal(inside.heightFrac, 1e6);
  assert.equal(inside.visible, true);
  const cap = FR.subjectScreenRect(poseAt([0, -5, 0.9], 0, 0, 0, 60), { pos: [0, 0, 0], height: 1.8, radius: 0.3 }, 60, 16 / 9);
  const top = FR.projectToNdc(poseAt([0, -5, 0.9], 0, 0, 0, 60), [0, 0, 1.8], 60, 16 / 9);
  assert.ok(cap.y1 >= top.y - 1e-9 && cap.y0 <= -top.y + 1e-9, "capsule covers base and top");
  near(cap.heightFrac, top.y, 0.02, "capsule height ≈ projected axis");
});

check("F6 compositionMetrics: sizeRatio 1 at the framing distance; ndc; thirds; headroom; tilt; inFrame", () => {
  const subject = { pos: [100, 200, 10], height: 1.8, radius: 0.45 };
  const fov = 50, aspect = 16 / 9;
  for (const framing of ["MS", "CU", "FS", "WS"]) {
    const d = FR.distanceForFraming(framing, 1.8, fov);
    const aim = FR.aimPointForFraming(framing, subject);
    const pose = poseAt([aim[0], aim[1] - d, aim[2]], 0, 0, 0, fov);
    const m = FR.compositionMetrics(pose, subject, fov, aspect, { framing });
    near(m.sizeRatio, 1, 1e-9, `${framing} sizeRatio`);
    nearV(m.ndc, [0, 0], 1e-12, `${framing} centred`);
    assert.equal(m.inFrame, true);
    near(m.thirdsError, Math.SQRT2 / 3, 1e-12, "nearest power point");
    near(m.depth, d, 1e-9, "depth");
    near(m.distance, d, 1e-9, "distance");
    near(m.horizonTiltDeg, 0, 1e-12, "level");
  }
  // MS headroom: top of head at (H − 0.9H) above the aim, frame half-height 0.25H → y_top = 0.4
  const d = FR.distanceForFraming("MS", 1.8, fov);
  const aim = FR.aimPointForFraming("MS", subject);
  const pose = poseAt([aim[0], aim[1] - d, aim[2]], 0, 0, 0, fov);
  const m = FR.compositionMetrics(pose, subject, fov, aspect, { framing: "MS", thirds: "center" });
  near(m.headroom, (1 - 0.4) / 2, 1e-9, "headroom");
  near(m.thirdsError, 0, 1e-12, "centre target");
  const left = FR.compositionMetrics(pose, subject, fov, aspect, { thirds: { side: "left", vertical: "upper" } });
  near(left.thirdsError, Math.SQRT2 / 3, 1e-12);
  const rolled = FR.compositionMetrics(poseAt(pose.pos, 0, 0, 10 * DEG, fov), subject, fov, aspect);
  near(rolled.horizonTiltDeg, 10, 1e-9, "horizon tilt = roll");
  const pitchedRolled = FR.compositionMetrics(poseAt(pose.pos, 0, -0.6, -5 * DEG, fov), subject, fov, aspect);
  near(pitchedRolled.horizonTiltDeg, -5, 1e-9, "tilt = roll regardless of pitch");
  // too close → sizeRatio 2
  const close = FR.compositionMetrics(poseAt([aim[0], aim[1] - d / 2, aim[2]], 0, 0, 0, fov), subject, fov, aspect);
  near(close.sizeRatio, 2, 1e-9, "half distance = twice the size");
});

check("F6 compositionMetrics: behind the camera, top-down size, NaN-safe", () => {
  const subject = { pos: [0, 0, 0], height: 1.8, radius: 0.45 };
  const away = FR.compositionMetrics(poseAt([0, -5, 1.6], PI, 0, 0, 50), subject, 50, 16 / 9);
  assert.equal(away.inFront, false);
  assert.equal(away.inFrame, false);
  assert.equal(away.ndc, null);
  assert.equal(away.thirdsError, null);
  assert.equal(away.heightFrac, 0);
  const top = FR.compositionMetrics(poseAt([0, 0, 30], 0, -HALF_PI, 0, 50), subject, 50, 16 / 9);
  assert.equal(top.inFrame, true);
  assert.equal(top.horizonTiltDeg, 0, "no horizon straight down");
  const diam = 0.45 / ((30 - 0.9) * Math.tan(25 * DEG));
  near(top.heightFrac, diam, 1e-9, "top-down size = projected diameter (axis projects to a point)");
  for (const v of [top.heightFrac, top.sizeRatio, top.thirdsError, top.headroom, top.depth, top.distance]) assert.ok(Number.isFinite(v));
  assert.throws(() => FR.compositionMetrics({ pos: [NaN, 0, 0] }, subject, 50, 1), shotErr("BAD_ARGUMENT"));
  assert.throws(() => FR.compositionMetrics(poseAt([0, 0, 0], 0, 0), subject, 50, 1, { thirds: "diagonal" }), shotErr("BAD_ARGUMENT"));
});

check("F7 thirdsAimOffset lands the subject exactly on the thirds lines (per axis, level camera)", () => {
  const fov = 50, aspect = 16 / 9;
  const subjectPt = [0, 20, 0];
  for (const [side, want] of [["left", -1 / 3], ["right", 1 / 3], ["center", 0], [0.5, 0.5]]) {
    const { dh, dp } = FR.thirdsAimOffset({ side }, fov, aspect);
    assert.equal(dp, -0, "no vertical offset");
    const ndc = FR.projectToNdc(poseAt([0, 0, 0], 0 + dh, 0, 0, fov), subjectPt, fov, aspect);
    near(ndc.x, want, 1e-12, `side ${side}`);
    near(ndc.y, 0, 1e-12);
  }
  for (const [vertical, want] of [["upper", 1 / 3], ["lower", -1 / 3]]) {
    const { dh, dp } = FR.thirdsAimOffset({ vertical }, fov, aspect);
    assert.equal(dh, -0);
    const ndc = FR.projectToNdc(poseAt([0, 0, 0], 0, dp, 0, fov), subjectPt, fov, aspect);
    near(ndc.y, want, 1e-12, `vertical ${vertical}`);
  }
  assert.throws(() => FR.thirdsAimOffset({ side: "middle-ish" }, fov, aspect), shotErr("BAD_ARGUMENT"));
});

check("F7 leadRoomSide: room ahead of the motion; centre when slow or looking straight down", () => {
  const north = [0, 1, 0];
  assert.equal(FR.leadRoomSide([3, 0, 0], north), "left", "moving screen-right → frame on the left");
  assert.equal(FR.leadRoomSide([-3, 0, 0], north), "right");
  assert.equal(FR.leadRoomSide([0, 5, 0], north), "center", "moving straight away");
  assert.equal(FR.leadRoomSide([0.1, 0, 0], north), "center", "below minSpeed");
  assert.equal(FR.leadRoomSide([3, 0, 0], [0, 0, -1]), "center", "nadir: no horizontal right");
  assert.equal(FR.leadRoomSide([3, 0, 0], [0, 0, -1], { right: [1, 0, 0] }), "left", "explicit right vector");
  assert.equal(FR.leadRoomSide([NaN, 0, 0], north), "center");
  // agrees with the projected direction of motion
  const pose = poseAt([0, -10, 1], 0.3, 0, 0, 50);
  const f = Q.qToBasis(pose.q).forward;
  const side = FR.leadRoomSide([2, -1, 0], f);
  const a = FR.projectToNdc(pose, [0, 0, 1], 50, 1.5), b = FR.projectToNdc(pose, [2, -1, 1], 50, 1.5);
  assert.equal(side, b.x > a.x ? "left" : "right");
});

console.log(`film_framing: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
