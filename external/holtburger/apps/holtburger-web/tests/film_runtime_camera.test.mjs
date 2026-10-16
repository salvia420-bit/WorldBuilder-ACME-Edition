// tests/film_runtime_camera.test.mjs
//
// WHY: AC Film Mode's page runtime part 1 owns the render camera, the frame
// clock, the clean (HUD-free, input-locked) frame and the hard safety reflex.
// A bug here is visible in every frame of every take: a camera that flips at
// straight-down pitch, a follow camera that fights the film pose, a viewer
// cell that roots the dungeon portal walk in the wrong room, a stepped take
// whose timestamps go backwards (negative dt) or whose particles run on the
// wall clock, a HUD bracket or speech bubble in the footage, a stray click
// that Uses a portal mid-take, a lens inside a wall. This suite EXECUTES the
// real modules against a real three r184 PerspectiveCamera inside a fake
// liveScene3d / CameraSwitcher and fake engine seams:
//   F1  flags.js — exact `=== "on"` opt-ins, memo + test pins;
//   C1  camera_owner own(): forced follow mode, per-instance positionCamera wrap
//       (the follow derivation is skipped while owned, the pose re-asserted);
//   C2  write(): three forward/up == AC forward/up through the §1 conversion at
//       p = −90° (heading kept: no north snap), roll applied, quaternion path ==
//       hpr path, fov → projection matrix, csmFitFov cap, matrixWorld, DoF focus;
//   C3  the carried film viewer cell: player-head seed, 8 m sub-stepped walk,
//       setCutCell seeding, long-jump re-seed, liveScene3d.filmViewer published;
//       parkCell() (world.teleport, review seams-11) unpublishes it until the next write;
//   C4  release(): every saved value restored (camDebug wrapper put back);
//   C6  the light-pool reference (lighting.js getPlayerWorldPosition) answers the film eye
//       while owned (an FPV run far from the parked player keeps its torches), restored on release;
//   C5  film hooks: preFrame/postRender fan-out, throwing listeners isolated;
//   K1  film_clock: strictly increasing ts = base + k·1000/fps, sources installed
//       and read the frame ts, seeded RNG, sky time + time-lapse, end() waits for
//       wall time, restores sources (sim clock too), clears holdLoop, re-arms;
//   K2  stale postRenders ignored, re-base, frame timeout, busy/idle errors;
//   K3  the REAL time_rng.js under the clock;
//   K4  (review seams-0) against a fake display running a copy of the index.js
//       scheduler: one requestAnimationFrame yield per step BEFORE the render, a
//       private rAF driver (scenery wind stand-in) runs exactly once per film frame
//       on the film clock, the pre-hold re-arm that fires in the first yield is
//       re-based past (dt stays 1/fps), 50 ms fallback for a throttled rAF, one
//       task on a hidden page;
//   K5  (seams-1) ?particleClock=sim: the particle clock continues from
//       _particleSimNowS (no jump to wall time), end() leaves the sim clock ≥ the
//       take's last particle time and never moves it back, hand-back waits for
//       wall time to pass the film particle time;
//   K6  (seams-6) begin → end with no step leaves exactly one rAF chain; a chain
//       parked during the hold, or cancelled by a step, is re-armed exactly once;
//   H1  clean_frame: CSS/class, funnel release→poison, capture blockers (wheel
//       passive:false) that stop + preventDefault, bubbles suppressed + purged,
//       selection/brackets/keys/drag/nameplates/hello cube, full idempotent restore;
//   S1  safety: radiusFor (near-plane corner + skin), sweep + slide along the wall
//       normal, terrain floor outdoors only, indoor clipCameraToCellSpace + render
//       set cells, near-lens particle hide with hysteresis + release, invalid input,
//       cut, a throwing los; S2 the REAL los.js segmentBlocked (hits freed).
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — these modules load only under it.
// Run from apps/holtburger-web/: node tests/film_runtime_camera.test.mjs

import assert from "node:assert/strict";

const THREE = await import("three");
const FLAGS = await import("../scene3d/film/flags.js");
const CO = await import("../scene3d/film/runtime/camera_owner.js");
const CK = await import("../scene3d/film/runtime/film_clock.js");
const CF = await import("../scene3d/film/runtime/clean_frame.js");
const SF = await import("../scene3d/film/runtime/safety.js");
const LOS = await import("../scene3d/film/scene/los.js");
const GB = await import("../scene3d/film/core/gimbal.js");
const { mulberry32 } = await import("../scene3d/film/core/rng.js");
const { FilmError } = await import("../scene3d/film/core/errors.js");
const UNITS = await import("../scene3d/film/core/units.js");

let passed = 0;
let failed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  [PASS] ${name}`);
    } catch (e) {
      failed += 1;
      console.log(`  [FAIL] ${name} — ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
    }
  });
}

const near = (a, b, eps = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
const nearV = (a, b, eps = 1e-6, msg = "") => {
  for (let i = 0; i < b.length; i += 1) near(a[i], b[i], eps, `${msg}[${i}]`);
};

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

const LB = 0xa9b40000;
const LBX = 0xa9 * 192;
const LBY = 0xb4 * 192;

/** A CameraSwitcher stand-in with the members camera_owner touches. */
class FakeSwitcher {
  constructor() {
    this.persp = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
    this.mode = "orbit";
    this.activeCamera = this.persp;
    this.followYaw = 1.25;
    this.followPitch = 0.3;
    this._prevEyeAc = { x: 1, y: 2, z: 3 };
    this._camFadeLastOpacity = 1;
    this.keys = { w: true, a: false, s: true, d: false, q: false, e: false, shift: true };
    this.calls = { position: 0, switchMode: [], fade: [], endDrag: 0 };
    this._endFollowDrag = () => {
      this.calls.endDrag += 1;
    };
  }
  positionCamera() {
    // The follow derivation: would move the camera every frame.
    this.calls.position += 1;
    this.persp.position.set(999, 999, 999);
  }
  switchMode(next) {
    this.calls.switchMode.push(next);
    this.mode = next;
    this.activeCamera = next === "topDown" ? this.ortho : this.persp;
    this._prevEyeAc = null;
  }
  tick(dt) {
    this.positionCamera(dt);
  }
  _applyCameraPlayerFade(o) {
    const q = Math.round(o * 128) / 128;
    if (q === this._camFadeLastOpacity) return;
    this.calls.fade.push(q);
    this._camFadeLastOpacity = q;
  }
}

/** Fake session handle: an outdoor strip of cells along local x. */
function makeSessionHandle() {
  const sh = {
    resolveCalls: [],
    freed: 0,
    // cells along local x: <100 → 0x0100, <110 → 0x0101, else 0x0102 (adjacent only).
    cellOf(wx) {
      const lx = wx - LBX;
      return (LB | (lx < 100 ? 0x100 : lx < 110 ? 0x101 : 0x102)) >>> 0;
    },
    resolveViewerCell(fx, fy, fz, tx, ty, tz, r, seed) {
      this.resolveCalls.push({ from: [fx, fy, fz], to: [tx, ty, tz], r, seed });
      const target = this.cellOf(tx);
      // A walk can only step to an ADJACENT cell (a jump over a cell is a "void exit").
      return Math.abs((target & 0xffff) - (seed & 0xffff)) <= 1 ? target : seed;
    },
    getLocalPlayerPose() {
      const self = this;
      return { landblockId: (LB | 0x100) >>> 0, x: 95, y: 50, z: 10, heading: 0, free() { self.freed += 1; } };
    },
  };
  return sh;
}

function makeOwner(extra = {}) {
  const cs = new FakeSwitcher();
  const sh = makeSessionHandle();
  const live = { cameraSwitcher: cs, sessionHandle: sh, camera: cs.persp };
  const win = extra.window ?? {};
  const owner = CO.createCameraOwner({ liveScene3d: live, THREE, sessionHandle: sh, window: win });
  return { cs, sh, live, owner, win };
}

/** three-frame forward / up of a camera, as AC vectors. */
function camAxesAc(cam) {
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  const u = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
  return { forward: GB.threeToAcPos(f), up: GB.threeToAcPos(u) };
}

// ---------------------------------------------------------------------------
// F1 flags
// ---------------------------------------------------------------------------

check("F1 filmModeEnabled / filmDofEnabled: exact '=== \"on\"' only", () => {
  for (const s of ["", "?filmMode", "?filmMode=1", "?filmMode=true", "?filmMode=ON", "?filmMode=off", "?filmMode=on1", "?x=on"]) {
    assert.equal(FLAGS.filmModeEnabled(s), false, s);
  }
  assert.equal(FLAGS.filmModeEnabled("?filmMode=on"), true);
  assert.equal(FLAGS.filmModeEnabled("?a=1&filmMode=on&b=2"), true);
  assert.equal(FLAGS.filmModeEnabled(new URLSearchParams("filmMode=on")), true);
  for (const s of ["", "?filmDof", "?filmDof=1", "?filmDof=true", "?filmDof=ON", "?filmDof=off"]) {
    assert.equal(FLAGS.filmDofEnabled(s), false, s);
  }
  assert.equal(FLAGS.filmDofEnabled("?filmDof=on"), true);
  // filmMode does not imply filmDof and vice versa.
  assert.equal(FLAGS.filmDofEnabled("?filmMode=on"), false);
  assert.equal(FLAGS.filmModeEnabled("?filmDof=on"), false);
});

check("F1 page reads are memoised, pinned by the test hooks, and fail closed", () => {
  const prevWindow = globalThis.window;
  try {
    globalThis.window = { location: { search: "?filmMode=on&filmDof=on" } };
    FLAGS._setFilmModeEnabledForTest(null);
    FLAGS._setFilmDofEnabledForTest(null);
    assert.equal(FLAGS.filmModeEnabled(), true);
    assert.equal(FLAGS.filmDofEnabled(), true);
    globalThis.window = { location: { search: "" } };
    assert.equal(FLAGS.filmModeEnabled(), true, "memoised");
    assert.equal(FLAGS.filmDofEnabled(), true, "memoised");
    FLAGS._setFilmModeEnabledForTest(false);
    FLAGS._setFilmDofEnabledForTest(false);
    assert.equal(FLAGS.filmModeEnabled(), false);
    assert.equal(FLAGS.filmDofEnabled(), false);
    FLAGS._setFilmModeEnabledForTest(null);
    globalThis.window = { get location() { throw new Error("boom"); } };
    assert.equal(FLAGS.filmModeEnabled(), false, "a throwing location reads OFF");
    delete globalThis.window;
    FLAGS._setFilmModeEnabledForTest(null);
    assert.equal(FLAGS.filmModeEnabled(), false, "no window reads OFF");
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    FLAGS._setFilmModeEnabledForTest(null);
    FLAGS._setFilmDofEnabledForTest(null);
  }
});

// ---------------------------------------------------------------------------
// C1–C5 camera owner
// ---------------------------------------------------------------------------

check("C1 own(): forces follow mode, wraps positionCamera per instance, skips the follow derivation", () => {
  const { cs, owner } = makeOwner();
  assert.equal(owner.owned, false);
  const r = owner.own();
  assert.equal(r.ok, true);
  assert.equal(owner.owned, true);
  assert.deepEqual(cs.calls.switchMode, ["follow"]);
  assert.equal(cs.mode, "follow");
  assert.equal(cs.activeCamera, cs.persp);
  assert.ok(Object.prototype.hasOwnProperty.call(cs, "positionCamera"), "per-instance wrapper");
  assert.equal(owner.write({ pos: [LBX + 95, LBY + 50, 20], h: 0.4, p: -0.2, r: 0, fov: 50 }), true);
  const before = cs.persp.position.toArray();
  cs.tick(1 / 30);
  assert.equal(cs.calls.position, 0, "follow derivation skipped while owned");
  assert.deepEqual(cs.persp.position.toArray(), before, "pose re-asserted, not moved");
  // Idempotent.
  assert.equal(owner.own().already, true);
  assert.deepEqual(cs.calls.switchMode, ["follow"]);
});

check("C2 write(): straight-down pitch keeps the heading (no north snap) and roll is applied", () => {
  const { cs, owner } = makeOwner();
  owner.own();
  const P = -Math.PI / 2;
  const ups = [];
  for (const [h, r] of [[0.7, 0.0], [0.7, 0.3], [2.1, 0.0], [-1.2, -0.4]]) {
    assert.equal(owner.write({ pos: [LBX + 95, LBY + 50, 40], h, p: P, r, fov: 60 }), true);
    const ax = camAxesAc(cs.persp);
    const b = GB.basisFromHPR(h, P, r);
    nearV(ax.forward, GB.forwardFromHP(h, P), 1e-9, `forward h=${h}`);
    nearV(ax.forward, [0, 0, -1], 1e-9, "straight down");
    nearV(ax.up, b.up, 1e-9, `up h=${h} r=${r}`);
    ups.push(ax.up);
  }
  // Heading 0.7 vs 2.1 at nadir: different image-up (a smooth image rotation, not a snap to north).
  assert.ok(Math.hypot(ups[0][0] - ups[2][0], ups[0][1] - ups[2][1]) > 0.5);
  // Roll 0.3 rotates the image about forward.
  near(Math.acos(Math.max(-1, Math.min(1, ups[0][0] * ups[1][0] + ups[0][1] * ups[1][1] + ups[0][2] * ups[1][2]))), 0.3, 1e-9);
  // A generic pose too.
  owner.write({ pos: [LBX + 95, LBY + 50, 40], h: 1.0, p: 0.35, r: -0.2, fov: 60 });
  const ax = camAxesAc(cs.persp);
  nearV(ax.forward, GB.forwardFromHP(1.0, 0.35), 1e-9);
  nearV(ax.up, GB.basisFromHPR(1.0, 0.35, -0.2).up, 1e-9);
  nearV(cs.persp.position.toArray(), GB.acToThreePos(LBX + 95, LBY + 50, 40), 1e-9);
  // matrixWorld updated (updateMatrixWorld(true)).
  const e = cs.persp.matrixWorld.elements;
  nearV([e[12], e[13], e[14]], GB.acToThreePos(LBX + 95, LBY + 50, 40), 1e-6);
});

check("C2 write(): quaternion path == hpr path; fov → projection; csmFitFov cap; near/far untouched", () => {
  const { cs, owner } = makeOwner();
  owner.own();
  const q = GB.quatFromHPR(-2.0, -1.1, 0.25);
  owner.write({ pos: [LBX + 90, LBY + 40, 30], q, fov: 40 });
  const a = camAxesAc(cs.persp);
  nearV(a.forward, GB.forwardFromHP(-2.0, -1.1), 1e-9);
  nearV(a.up, GB.basisFromHPR(-2.0, -1.1, 0.25).up, 1e-9);
  near(cs.persp.projectionMatrix.elements[5], 1 / Math.tan((40 * Math.PI) / 360), 1e-9, "fov 40 in the projection");
  assert.equal(cs.persp.userData.csmFitFov, undefined);
  owner.write({ pos: [LBX + 90, LBY + 40, 30], q, fov: 100 });
  near(cs.persp.projectionMatrix.elements[5], 1 / Math.tan((100 * Math.PI) / 360), 1e-9);
  assert.equal(cs.persp.userData.csmFitFov, CO.CSM_FIT_FOV_MAX_DEG, "CSM fits 75° during a wide shot");
  owner.write({ pos: [LBX + 90, LBY + 40, 30], q, fov: 55 });
  assert.equal("csmFitFov" in cs.persp.userData, false);
  // Out-of-range fov keeps the current one.
  owner.write({ pos: [LBX + 90, LBY + 40, 30], q, fov: 400 });
  assert.equal(cs.persp.fov, 55);
  assert.equal(cs.persp.near, 0.1);
  assert.equal(cs.persp.far, 5000);
  // currentPose round-trips.
  const cp = owner.currentPose();
  nearV(cp.pos, [LBX + 90, LBY + 40, 30], 1e-9);
  nearV(cp.q, q, 1e-9);
  assert.equal(cp.fov, 55);
});

check("C2 write(): rejects non-finite poses and writes before own(); DoF focus channel drives __dof", () => {
  const win = { __dof: { focusDistance: 10 } };
  const { cs, owner } = makeOwner({ window: win });
  assert.equal(owner.write({ pos: [1, 2, 3], h: 0, p: 0 }), false, "not owned");
  owner.own();
  assert.equal(owner.write({ pos: [LBX + 95, LBY + 50, 20], h: 0, p: 0, fov: 60, focus: 4.5 }), true);
  assert.equal(win.__dof.focusDistance, 4.5);
  const snap = cs.persp.position.toArray();
  assert.equal(owner.write({ pos: [NaN, 0, 0], h: 0, p: 0 }), false);
  assert.equal(owner.write({ pos: [1, 2, 3], q: [0, 0, 0, 0] }), false);
  assert.equal(owner.write({ pos: [1, 2, 3], h: NaN, p: 0 }), false);
  assert.equal(owner.write(null), false);
  assert.deepEqual(cs.persp.position.toArray(), snap, "camera untouched by rejected writes");
  assert.ok(owner.stats().rejected >= 5);
});

check("C3 viewer cell: player-head seed, 8 m sub-stepped walk, cut cell, long-jump re-seed, published", () => {
  const { sh, live, owner } = makeOwner();
  owner.own();
  owner.write({ pos: [LBX + 95, LBY + 50, 12], h: 0, p: 0, fov: 60 });
  assert.equal(owner.viewerCell(), (LB | 0x100) >>> 0, "seeded by the player-head walk");
  assert.equal(sh.resolveCalls[0].seed, (LB | 0x100) >>> 0);
  nearV(sh.resolveCalls[0].from, [LBX + 95, LBY + 50, 11.5], 1e-9, "from the player's head (z + 1.5)");
  assert.equal(sh.freed, 1, "LocalPlayerPose box freed");
  assert.deepEqual(live.filmViewer, { cell: (LB | 0x100) >>> 0 });
  // 20 m move across two cells: one straight walk would be a void exit; sub-steps chain.
  const n0 = sh.resolveCalls.length;
  owner.write({ pos: [LBX + 115, LBY + 50, 12], h: 0, p: 0, fov: 60 });
  const walks = sh.resolveCalls.slice(n0);
  assert.equal(walks.length, 3, "ceil(20 / 8) sub-steps");
  for (const w of walks) {
    assert.ok(Math.hypot(w.to[0] - w.from[0], w.to[1] - w.from[1], w.to[2] - w.from[2]) <= CO.VIEWER_CELL_STEP_M + 1e-9);
    assert.equal(w.r, CO.VIEWER_CELL_RADIUS_M);
  }
  assert.deepEqual(walks.map((w) => w.seed), [(LB | 0x100) >>> 0, (LB | 0x101) >>> 0, (LB | 0x101) >>> 0], "each sub-step seeded by the previous result");
  assert.equal(owner.viewerCell(), (LB | 0x102) >>> 0);
  assert.equal(live.filmViewer.cell, (LB | 0x102) >>> 0);
  // A cut seeds the plan's cell without walking.
  assert.equal(owner.setCutCell("0xA9B40155"), (LB | 0x155) >>> 0);
  const n1 = sh.resolveCalls.length;
  owner.write({ pos: [LBX + 20, LBY + 20, 5], h: 0, p: 0, fov: 60 });
  assert.equal(sh.resolveCalls.length, n1, "no walk on a cut");
  assert.equal(owner.viewerCell(), (LB | 0x155) >>> 0);
  assert.equal(owner.viewerIndoor(), true);
  // A jump longer than a landblock without a cut cell re-seeds from the player head.
  owner.write({ pos: [LBX + 95, LBY + 50 + 400, 12], h: 0, p: 0, fov: 60 });
  const last = sh.resolveCalls[sh.resolveCalls.length - 1];
  assert.ok(sh.resolveCalls.slice(n1).some((c) => c.seed === ((LB | 0x100) >>> 0)), "re-seeded from the player cell");
  assert.ok(Number.isFinite(last.to[0]));
  // A cut with no plan cell (setCutCell(0)): the next write re-seeds from the player head,
  // even for a short hop (never walks from the previous eye through a wall).
  owner.write({ pos: [LBX + 115, LBY + 50, 12], h: 0, p: 0, fov: 60 });
  assert.equal(owner.viewerCell(), (LB | 0x102) >>> 0);
  assert.equal(owner.setCutCell(0), 0);
  const n2 = sh.resolveCalls.length;
  const f0 = sh.freed;
  owner.write({ pos: [LBX + 113, LBY + 50, 12], h: 0, p: 0, fov: 60 });
  assert.equal(sh.freed, f0 + 1, "player pose read for the re-seed");
  nearV(sh.resolveCalls[n2].from, [LBX + 95, LBY + 50, 11.5], 1e-9, "walk starts at the player head");
  assert.equal(sh.resolveCalls[n2].seed, (LB | 0x100) >>> 0);
  // The next ordinary write walks from the previous eye again.
  const n3 = sh.resolveCalls.length;
  owner.write({ pos: [LBX + 114, LBY + 50, 12], h: 0, p: 0, fov: 60 });
  assert.equal(sh.resolveCalls.length, n3 + 1);
  nearV(sh.resolveCalls[n3].from, [LBX + 113, LBY + 50, 12], 1e-9);
});

check("C3 parkCell() (review seams-11): the viewer cell is dropped and unpublished, the camera stays owned, the next write re-seeds", () => {
  const { cs, sh, live, owner } = makeOwner();
  assert.deepEqual(owner.parkCell(), { ok: true, parked: false, cell: 0 }, "not owned: nothing to park, no throw");
  owner.own();
  owner.write({ pos: [LBX + 115, LBY + 50, 12], h: 0, p: 0, fov: 60 });
  const cell = owner.viewerCell();
  assert.equal(cell, (LB | 0x102) >>> 0);
  assert.deepEqual(live.filmViewer, { cell });
  owner.setCutCell("0xA9B40155"); // a stale cut left over from the previous site
  const pose = owner.currentPose();
  const r = owner.parkCell();
  assert.deepEqual(r, { ok: true, parked: true, cell });
  assert.equal("filmViewer" in live, false, "cells.js falls back to the player-head walk");
  assert.equal(owner.viewerCell(), 0);
  assert.equal(owner.viewerIndoor(), false);
  assert.equal(owner.owned, true, "still owned");
  assert.equal(owner.currentPose().cell, 0);
  nearV(owner.currentPose().pos, pose.pos, 1e-12, "the pose is kept");
  cs.tick(1 / 30);
  assert.equal(cs.calls.position, 0, "the follow derivation stays skipped");
  assert.equal("filmViewer" in live, false, "a re-asserted (unwritten) frame publishes nothing");
  assert.equal(owner.stats().parks, 2, "both calls counted (the unowned one too)");
  // The next write re-seeds from the player head (not the dropped cut, not the old eye) and publishes.
  const n0 = sh.resolveCalls.length;
  owner.write({ pos: [LBX + 101, LBY + 50, 12], h: 0, p: 0, fov: 60 });
  nearV(sh.resolveCalls[n0].from, [LBX + 95, LBY + 50, 11.5], 1e-9, "walk starts at the player head");
  assert.equal(sh.resolveCalls[n0].seed, (LB | 0x100) >>> 0);
  assert.equal(owner.viewerCell(), (LB | 0x101) >>> 0);
  assert.deepEqual(live.filmViewer, { cell: (LB | 0x101) >>> 0 });
  assert.equal(owner.parkCell().parked, true);
  assert.equal(owner.parkCell().parked, false, "parking twice: nothing left to drop");
});

/**
 * Bandit Castle (2026-10-16): a building whose room 0x0130 spans local x 100..120, y 40..60,
 * z 0..10, with the hidden player outside it at local (95, 50). The fake resolver has the wasm
 * walk's two shapes: seeded indoors, every exit is a wall ("void") exit that keeps the seed;
 * seeded outdoors, it answers by containment — the room when the point is inside it, else the
 * landcell under the point.
 */
function makeBuildingWorld({ container = "mesh" } = {}) {
  const ROOM = (LB | 0x130) >>> 0;
  const inRoom = (x, y, z) => x >= LBX + 100 && x <= LBX + 120 && y >= LBY + 40 && y <= LBY + 60 && z >= 0 && z <= 10;
  const sh = {
    resolveCalls: [],
    resolveViewerCell(fx, fy, fz, tx, ty, tz, _r, seed) {
      this.resolveCalls.push({ from: [fx, fy, fz], to: [tx, ty, tz], seed });
      if ((seed & 0xffff) >= 0x100) return seed >>> 0;
      return inRoom(tx, ty, tz) ? ROOM : UNITS.localFromWorld(tx, ty, tz).cellId;
    },
    getLocalPlayerPose() {
      return { landblockId: UNITS.localFromWorld(LBX + 95, LBY + 50, 0).cellId, x: 95, y: 50, z: 4, heading: 0, free() {} };
    },
  };
  // cells.js shape: identity container → "mesh-<cell>" group at the cell origin → surface meshes.
  const cellContainers3d = new Map();
  if (container !== "none") {
    const c = new THREE.Group();
    c.name = `envcell-${ROOM.toString(16)}`;
    const g = new THREE.Group();
    g.name = `mesh-${ROOM.toString(16)}`;
    g.position.set(LBX + 100, LBY + 40, 0);
    if (container === "mesh") {
      const geo = new THREE.BoxGeometry(20, 20, 10);
      geo.translate(10, 10, 5);
      g.add(new THREE.Mesh(geo));
    }
    c.add(g);
    // A static object far outside the room must not widen the room's box.
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    lamp.position.set(LBX + 180, LBY + 50, 5);
    c.add(lamp);
    cellContainers3d.set(ROOM, c);
  }
  const cs = new FakeSwitcher();
  const live = { cameraSwitcher: cs, sessionHandle: sh, camera: cs.persp, cellContainers3d };
  const owner = CO.createCameraOwner({ liveScene3d: live, THREE, sessionHandle: sh, window: {} });
  return { ROOM, sh, live, owner };
}

check("C3 wall exit: an eye outside the carried room's box is re-resolved from the landscape (Bandit Castle drone)", () => {
  const { ROOM, live, owner } = makeBuildingWorld();
  owner.own();
  // Drone 105 m east of the player, at room height: the head→eye seed line runs through the room.
  const eye = [LBX + 200, LBY + 50, 6];
  owner.write({ pos: eye, h: 0, p: 0, fov: 45 });
  const outdoor = UNITS.localFromWorld(eye[0], eye[1], eye[2]).cellId;
  assert.equal(owner.viewerCell(), outdoor, "the drone is outdoors, not in the room the seed line crossed");
  assert.equal(owner.viewerIndoor(), false);
  assert.deepEqual(live.filmViewer, { cell: outdoor });
  assert.ok(owner.stats().cellEscapes >= 1, "the wall exit was counted");
  // Flying into the room re-enters it; moving about inside keeps it.
  owner.write({ pos: [LBX + 115, LBY + 50, 5], h: 0, p: 0, fov: 45 });
  assert.equal(owner.viewerCell(), ROOM, "inside the room (by containment from the landscape)");
  owner.write({ pos: [LBX + 104, LBY + 45, 5], h: 0, p: 0, fov: 45 });
  assert.equal(owner.viewerCell(), ROOM, "still inside: the room is kept");
  // Within the margin past the wall the room is still kept (a doorway straddle).
  owner.write({ pos: [LBX + 120 + CO.VIEWER_CELL_BOX_MARGIN_M * 0.5, LBY + 50, 5], h: 0, p: 0, fov: 45 });
  assert.equal(owner.viewerCell(), ROOM, "inside the margin");
});

check("C3 wall exit fails safe: with no resident room mesh the walk's cell stands (today's behaviour)", () => {
  for (const container of ["none", "empty"]) {
    const { ROOM, owner } = makeBuildingWorld({ container });
    owner.own();
    owner.write({ pos: [LBX + 200, LBY + 50, 6], h: 0, p: 0, fov: 45 });
    assert.equal(owner.viewerCell(), ROOM, `${container}: no box, no override`);
    assert.equal(owner.stats().cellEscapes, 0);
  }
});

check("C4 release(): unwraps positionCamera and restores mode / yaw / pitch / fov / csmFitFov / fade / viewer cell", () => {
  const { cs, live, owner } = makeOwner();
  cs.persp.userData.csmFitFov = 33; // e.g. portal fade parked a value
  owner.own();
  cs.followYaw = 9; // autofollow keeps mutating while parked
  cs.followPitch = 1.3;
  owner.write({ pos: [LBX + 95, LBY + 50, 20], h: 0, p: 0, fov: 100 });
  cs._applyCameraPlayerFade(0); // the world avatar fallback faded the operator
  const r = owner.release();
  assert.deepEqual(r, { ok: true, wasOwned: true });
  assert.equal(owner.owned, false);
  assert.equal(Object.prototype.hasOwnProperty.call(cs, "positionCamera"), false, "own property removed");
  cs.tick(1 / 30);
  assert.equal(cs.calls.position, 1, "follow derivation runs again");
  assert.equal(cs._prevEyeAc, null);
  assert.equal(cs.followYaw, 1.25);
  assert.equal(cs.followPitch, 0.3);
  assert.equal(cs.mode, "orbit", "mode restored");
  assert.deepEqual(cs.calls.switchMode, ["follow", "orbit"]);
  assert.equal(cs.persp.fov, 60);
  near(cs.persp.projectionMatrix.elements[5], 1 / Math.tan(Math.PI / 6), 1e-9);
  assert.equal(cs.persp.userData.csmFitFov, 33, "a pre-existing csmFitFov is put back");
  assert.equal(cs.calls.fade[cs.calls.fade.length - 1], 1, "avatar opacity pushed back to the saved value");
  assert.equal("filmViewer" in live, false);
  assert.equal(owner.viewerCell(), 0);
  assert.equal(owner.write({ pos: [1, 2, 3], h: 0, p: 0 }), false, "writes refused after release");
  assert.deepEqual(owner.release(), { ok: true, wasOwned: false });
});

check("C4 a camDebug own-property wrapper is put back on release; no camera → FilmError", () => {
  const { cs, owner } = makeOwner();
  const proto = cs.positionCamera;
  let debugCalls = 0;
  const camDebug = function (dt) {
    debugCalls += 1;
    return proto.call(this, dt);
  };
  cs.positionCamera = camDebug;
  owner.own();
  cs.tick(0.016);
  assert.equal(debugCalls, 0);
  owner.release();
  assert.equal(cs.positionCamera, camDebug);
  cs.tick(0.016);
  assert.equal(debugCalls, 1);
  const bad = CO.createCameraOwner({ liveScene3d: {} });
  assert.throws(() => bad.own(), (e) => e instanceof FilmError && e.code === "FILM_CAMERA_UNAVAILABLE");
  assert.throws(() => CO.createCameraOwner({}), FilmError);
  // liveScene3d.camera fallback (no switcher yet).
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
  const o2 = CO.createCameraOwner({ liveScene3d: { camera: cam } });
  assert.equal(o2.own().camera, "camera");
  assert.equal(o2.write({ pos: [10, 20, 30], h: 0, p: 0, fov: 45 }), true);
  nearV(cam.position.toArray(), [10, 30, -20], 1e-12);
});

check("C6 light-pool reference: while owned cameraSwitcher.getPlayerWorldPosition answers the FILM EYE (lighting.js ranks torches there); restored on release", () => {
  class LitSwitcher extends FakeSwitcher {
    getPlayerWorldPosition(out) {
      out.set(-7, 8, -9); // the parked player, far from the take
      return out;
    }
  }
  const cs = new LitSwitcher();
  const sh = makeSessionHandle();
  const live = { cameraSwitcher: cs, sessionHandle: sh, camera: cs.persp };
  const owner = CO.createCameraOwner({ liveScene3d: live, THREE, sessionHandle: sh, window: {} });
  const ref = new THREE.Vector3();
  assert.equal(cs.getPlayerWorldPosition(ref), ref);
  assert.deepEqual(ref.toArray(), [-7, 8, -9], "not owned: the player");
  owner.own();
  assert.ok(Object.prototype.hasOwnProperty.call(cs, "getPlayerWorldPosition"), "per-instance wrapper");
  assert.equal(owner.stats().eyeLightRef, true);
  const eye = [LBX + 95, LBY + 50, 20];
  assert.equal(owner.write({ pos: eye, h: 0.3, p: -0.1, r: 0, fov: 70 }), true);
  assert.equal(cs.getPlayerWorldPosition(ref), ref, "returns out (lighting.js tests != null)");
  nearV(ref.toArray(), GB.acToThreePos(eye), 1e-9, "the film eye in three space");
  nearV(ref.toArray(), cs.persp.position.toArray(), 1e-9, "= the owned camera's position");
  const eye2 = [LBX + 160, LBY + 20, -40];
  owner.write({ pos: eye2, h: 0, p: 0, r: 0, fov: 70 });
  cs.getPlayerWorldPosition(ref);
  nearV(ref.toArray(), GB.acToThreePos(eye2), 1e-9, "follows every write");
  assert.ok(owner.stats().eyeLightRefs >= 2);
  owner.release();
  assert.equal(Object.prototype.hasOwnProperty.call(cs, "getPlayerWorldPosition"), false, "own property removed");
  cs.getPlayerWorldPosition(ref);
  assert.deepEqual(ref.toArray(), [-7, 8, -9], "released: the player again");
  assert.equal(owner.stats().eyeLightRef, false);
  // A pre-existing own-property wrapper (another tool's) is put back on release.
  let foreign = 0;
  const mine = function (out) {
    foreign += 1;
    return LitSwitcher.prototype.getPlayerWorldPosition.call(this, out);
  };
  cs.getPlayerWorldPosition = mine;
  owner.own();
  owner.write({ pos: eye, h: 0, p: 0, r: 0, fov: 70 });
  cs.getPlayerWorldPosition(ref);
  assert.equal(foreign, 0, "the film eye answers while owned");
  owner.release();
  assert.equal(cs.getPlayerWorldPosition, mine);
  cs.getPlayerWorldPosition(ref);
  assert.equal(foreign, 1);
  // A switcher without the method (headless harness) is left alone.
  const { cs: plain, owner: o2 } = makeOwner();
  o2.own();
  assert.equal("getPlayerWorldPosition" in plain, false);
  assert.equal(o2.stats().eyeLightRef, false);
  o2.release();
});

check("C5 film hooks: one shared liveScene3d.film object, fan-out, isolation, unsubscribe", () => {
  const { live, owner } = makeOwner();
  const hooks = live.film;
  assert.equal(owner.hooks, hooks);
  assert.equal(CO.ensureFilmHooks(live), hooks, "idempotent");
  assert.equal(hooks.holdLoop, false);
  const seen = [];
  const warnings = [];
  const h2 = CO.ensureFilmHooks(live, { log: (e) => warnings.push(e) });
  assert.equal(h2, hooks);
  const unA = owner.onPreFrame(() => {
    throw new Error("listener A broke");
  });
  const unB = owner.onPreFrame((ts, dt) => seen.push(["pre", ts, dt]));
  owner.onPostRender(() => seen.push(["post"]));
  const prevWarn = console.warn;
  console.warn = () => {};
  try {
    hooks.preFrame(1000, 1 / 30);
    hooks.preFrame(1033, 1 / 30);
  } finally {
    console.warn = prevWarn;
  }
  hooks.postRender();
  assert.deepEqual(seen, [["pre", 1000, 1 / 30], ["pre", 1033, 1 / 30], ["post"]]);
  assert.equal(hooks.stats().errors, 2);
  unA();
  unB();
  unA();
  hooks.preFrame(1066, 1 / 30);
  assert.equal(seen.length, 3);
  assert.equal(hooks.stats().preListeners, 0);
  // A foreign object is replaced (holdLoop carried over).
  const live2 = { film: { holdLoop: true } };
  const h3 = CO.ensureFilmHooks(live2);
  assert.equal(h3.holdLoop, true);
  assert.equal(typeof h3.preFrame, "function");
});

// ---------------------------------------------------------------------------
// K1–K3 film clock
// ---------------------------------------------------------------------------

/** A fake index.js tick: __renderOnce(ts) stamps frameTime, runs preFrame, then postRender after a microtask hop. */
function makeLoop({ startTs = 1000, post = "auto" } = {}) {
  let wall = startTs;
  const live = { frameTime: { tsMs: startTs, tsSec: startTs / 1000, dt: 0.016 } };
  const renders = [];
  const reads = [];
  const win = {
    performance: { now: () => wall },
  };
  const sources = {
    timeRng: {
      time: null, rng: null, timeCalls: [], rngCalls: [],
      setCurrentTime(fn) { this.timeCalls.push(fn); this.time = fn; },
      setRng(fn) { this.rngCalls.push(fn); this.rng = fn; },
      particleClockMode: () => "off",
    },
    fxTime: { fn: null, calls: [], setFxTimeSource(fn) { this.calls.push(fn); this.fn = fn; } },
    sceneryTime: { fn: null, calls: [], setSceneryTimeSource(fn) { this.calls.push(fn); this.fn = fn; } },
  };
  win.__renderOnce = (ts) => {
    renders.push(ts);
    const t = Number.isFinite(ts) ? ts : wall;
    if (post === "never") return true;
    Promise.resolve().then(() => {
      const prev = live.frameTime ? live.frameTime.tsMs : null;
      if (post === "stale-first") live.film?.postRender?.(); // a realtime frame finishing first
      live.frameTime = { tsMs: t, tsSec: t / 1000, dt: prev === null ? 0.016 : (t - prev) / 1000 };
      live.film?.preFrame?.(t, live.frameTime.dt);
      reads.push({
        ts: t,
        time: sources.timeRng.time ? sources.timeRng.time() : null,
        fx: sources.fxTime.fn ? sources.fxTime.fn() : null,
        scenery: sources.sceneryTime.fn ? sources.sceneryTime.fn() : null,
      });
      live.film?.postRender?.();
    });
    return true;
  };
  const clockDeps = {
    liveScene3d: live,
    window: win,
    ...sources,
    now: () => wall,
    sleep: async (ms) => {
      wall += ms;
    },
  };
  return { live, win, renders, reads, sources, clockDeps, setWall: (v) => { wall = v; }, getWall: () => wall };
}

function makeSky(t = 0.25) {
  return {
    sky: [],
    freed: 0,
    setSkyTimeOverride(v) {
      this.sky.push(v);
      return true;
    },
    getSkyState() {
      const self = this;
      return { timeOfDayNormalized: t, free() { self.freed += 1; } };
    },
  };
}

check("K1 stepped frames: strictly increasing ts = base + (k+1)·1000/fps, holdLoop, sources read the frame ts", async () => {
  const L = makeLoop();
  const clock = CK.createFilmClock({ fps: 30, ...L.clockDeps });
  const b = clock.begin({ seed: 42 });
  assert.equal(b.ok, true);
  assert.equal(b.baseTsMs, 1000, "base from liveScene3d.frameTime.tsMs");
  assert.equal(L.live.film.holdLoop, true);
  assert.equal(typeof L.sources.timeRng.time, "function");
  assert.equal(typeof L.sources.fxTime.fn, "function");
  assert.equal(typeof L.sources.sceneryTime.fn, "function");
  const out = [];
  for (let k = 0; k < 6; k += 1) out.push(await clock.step());
  for (let k = 0; k < 6; k += 1) {
    assert.equal(out[k].frame, k);
    near(out[k].filmMs, (k * 1000) / 30, 1e-9);
    near(out[k].tsMs, 1000 + ((k + 1) * 1000) / 30, 1e-9);
    near(out[k].dt, 1 / 30, 1e-9);
    if (k > 0) assert.ok(out[k].tsMs > out[k - 1].tsMs, "strictly increasing");
  }
  assert.deepEqual(L.renders, out.map((o) => o.tsMs), "__renderOnce got the explicit timestamps");
  for (const r of L.reads) {
    near(r.time, r.ts / 1000, 1e-12, "particle clock (s)");
    near(r.fx, r.ts, 1e-12, "fx time (ms)");
    near(r.scenery, r.ts, 1e-12, "scenery time (ms)");
  }
  near(clock.now(), 5 / 30, 1e-12);
  assert.equal(clock.frame, 5);
  // Seeded particle RNG.
  const ref = mulberry32(42);
  const clockRng = L.sources.timeRng.rng;
  for (let i = 0; i < 4; i += 1) assert.equal(clockRng(), ref());
  await clock.end();
});

check("K1 end(): waits until wall time passes the last ts, restores sources, clears holdLoop, re-arms with a bare __renderOnce", async () => {
  const L = makeLoop({ startTs: 1000 });
  const clock = CK.createFilmClock({ fps: 30, ...L.clockDeps });
  clock.begin({ seed: 1 });
  for (let k = 0; k < 9; k += 1) await clock.step();
  const lastTs = 1000 + (9 * 1000) / 30;
  let restoreWall = null;
  const orig = L.sources.timeRng.setCurrentTime;
  L.sources.timeRng.setCurrentTime = function (fn) {
    if (fn === null) restoreWall = L.getWall();
    return orig.call(this, fn);
  };
  const r = await clock.end();
  assert.equal(r.ok, true);
  assert.equal(r.frames, 9);
  near(r.lastTsMs, lastTs, 1e-9);
  assert.ok(r.waitedMs > 0, "waited for the wall clock");
  assert.ok(restoreWall > lastTs, `sources restored only after now > lastTs (${restoreWall} > ${lastTs})`);
  assert.equal(L.sources.timeRng.time, null);
  assert.equal(L.sources.timeRng.rng, null);
  assert.equal(L.sources.fxTime.fn, null);
  assert.equal(L.sources.sceneryTime.fn, null);
  assert.equal(L.live.film.holdLoop, false);
  assert.equal(L.renders[L.renders.length - 1], undefined, "bare __renderOnce() re-arms the loop");
  assert.equal(clock.active, false);
  assert.deepEqual(await clock.end(), { ok: true, frames: 0, lastTsMs: null, waitedMs: 0, wasActive: false });
  assert.equal(L.live.film.stats().postListeners, 0, "postRender listener removed");
});

check("K1 sky: timeOfDay every step, time-lapse in game-days per film second, restore NaN / look / keepSky", async () => {
  const L = makeLoop();
  const sh = makeSky(0.25);
  const clock = CK.createFilmClock({ fps: 10, ...L.clockDeps, sessionHandle: sh });
  clock.begin({ timeOfDay: "noon" });
  for (let k = 0; k < 3; k += 1) await clock.step();
  assert.deepEqual(sh.sky, [0.5, 0.5, 0.5]);
  await clock.end();
  assert.ok(Number.isNaN(sh.sky[sh.sky.length - 1]), "cleared with NaN");
  // Time-lapse 0.5 game-days per film second from 0.25 at 10 fps: frame 10 = 1 s → 0.75.
  sh.sky.length = 0;
  clock.begin({ timeOfDay: 0.25, timeLapse: { rate: 0.5 } });
  for (let k = 0; k <= 10; k += 1) await clock.step();
  near(sh.sky[0], 0.25, 1e-12);
  near(sh.sky[10], 0.75, 1e-12);
  near(clock.skyTime(), 0.75, 1e-12);
  // wraps past midnight
  for (let k = 0; k < 10; k += 1) await clock.step();
  near(sh.sky[20], 0.25, 1e-9, "1.25 wraps to 0.25");
  await clock.end({ keepSky: true });
  near(sh.sky[sh.sky.length - 1], 0.25, 1e-9, "keepSky: no restore call");
  // Time-lapse without timeOfDay starts from the current sky (box freed); the look's time wins on end.
  sh.sky.length = 0;
  const look = { activeTimeOfDay: () => 0.82 };
  const clock2 = CK.createFilmClock({ fps: 10, ...L.clockDeps, sessionHandle: sh, look });
  clock2.begin({ timeLapse: 0.1 });
  await clock2.step();
  near(sh.sky[0], 0.25, 1e-12);
  assert.ok(sh.freed >= 1, "SkyState freed");
  await clock2.end();
  near(sh.sky[sh.sky.length - 1], 0.82, 1e-12, "restored to the look's time of day");
  // No sky args → the sky is never touched.
  sh.sky.length = 0;
  clock2.begin({});
  await clock2.step();
  await clock2.end();
  assert.deepEqual(sh.sky, []);
  assert.throws(() => clock2.begin({ timeOfDay: "teatime" }), FilmError);
  assert.equal(CK.parseTimeOfDay("Golden"), 0.82);
  assert.equal(CK.parseTimeOfDay(1), 0);
  assert.equal(CK.parseTimeOfDay(-0.25), 0.75);
  assert.equal(CK.parseTimeOfDay(NaN), null);
});

check("K1 ?particleClock=sim: end() re-installs the loop sim clock at the film particle time, never back, never toward wall", async () => {
  const L = makeLoop();
  L.sources.timeRng.particleClockMode = () => "sim";
  L.live._particleSimNowS = 0.9;
  const clock = CK.createFilmClock({ fps: 30, ...L.clockDeps });
  clock.begin({});
  for (let k = 0; k < 3; k += 1) await clock.step();
  await clock.end();
  const fn = L.sources.timeRng.time;
  assert.equal(typeof fn, "function", "sim clock re-installed (not the wall default)");
  near(fn(), 0.9 + 3 / 30, 1e-12, "sim clock moved up to sim base + film time (the take's last particle time)");
  assert.ok(fn() < (1000 + 100) / 1000 - 1e-3, `not pushed to the wall-based frame time: ${fn()}`);
  L.live._particleSimNowS = 7.5;
  assert.equal(fn(), 7.5, "reads the live sim clock");
});

check("K2 stale postRenders are ignored; an intruding realtime frame re-bases; busy / idle / timeout errors", async () => {
  const L = makeLoop({ post: "stale-first" });
  const clock = CK.createFilmClock({ fps: 30, ...L.clockDeps });
  await assert.rejects(clock.step(), (e) => e instanceof FilmError && e.code === "FILM_CLOCK_IDLE");
  clock.begin({});
  assert.throws(() => clock.begin({}), (e) => e.code === "FILM_CLOCK_ACTIVE");
  const s0 = await clock.step();
  assert.equal(clock.stats().staleRenders, 1, "the realtime frame's postRender did not resolve the step");
  near(s0.tsMs, 1000 + 1000 / 30, 1e-9);
  // A realtime frame slipped in at 5000 → re-base past it.
  L.live.frameTime = { tsMs: 5000, tsSec: 5, dt: 0.016 };
  const p = clock.step();
  await assert.rejects(clock.step(), (e) => e.code === "FILM_CLOCK_BUSY");
  const s1 = await p;
  near(s1.tsMs, 5000 + 1000 / 30, 1e-9);
  near(s1.dt, 1 / 30, 1e-9, "dt measured from the intruding frame, as tick() sees it");
  assert.equal(clock.stats().rebases, 1);
  near(s1.filmMs, 1000 / 30, 1e-9, "film time is frame-indexed, unaffected by the re-base");
  await clock.end();
  // A frame that never renders times out; the clock stays usable.
  const N = makeLoop({ post: "never" });
  const c2 = CK.createFilmClock({ fps: 30, ...N.clockDeps, stepTimeoutMs: 25 });
  c2.begin({});
  await assert.rejects(c2.step(), (e) => e instanceof FilmError && e.code === "FILM_FRAME_TIMEOUT");
  assert.equal(c2.stats().timeouts, 1);
  await assert.rejects(c2.step(), (e) => e.code === "FILM_FRAME_TIMEOUT", "next step allowed (not busy)");
  await c2.end();
  // No __renderOnce at all.
  const c3 = CK.createFilmClock({ liveScene3d: { frameTime: { tsMs: 1 } }, window: {}, now: () => 2, sleep: async () => {} });
  c3.begin({});
  await assert.rejects(c3.step(), (e) => e.code === "FILM_RENDER_UNAVAILABLE");
  await c3.end();
  assert.throws(() => CK.createFilmClock({ liveScene3d: {}, fps: 0 }), FilmError);
  assert.throws(() => CK.createFilmClock({ liveScene3d: {}, fps: 5 }), FilmError, "below 10 fps tick() would clamp dt");
  assert.throws(() => CK.createFilmClock({}), FilmError);
  // A per-take fps override.
  const M = makeLoop({ startTs: 200 });
  const c4 = CK.createFilmClock({ fps: 30, ...M.clockDeps });
  assert.equal(c4.begin({ fps: 60 }).fps, 60);
  near((await c4.step()).tsMs, 200 + 1000 / 60, 1e-9);
  await c4.end();
  assert.throws(() => c4.begin({ fps: 1000 }), FilmError);
  assert.equal(c4.active, false);
});

check("K3 the REAL time_rng.js follows the film clock and returns to the wall clock", async () => {
  const TR = await import("../scene3d/particles/time_rng.js");
  const L = makeLoop({ startTs: 50 });
  const clock = CK.createFilmClock({ fps: 25, ...L.clockDeps, timeRng: TR });
  clock.begin({ seed: "take-7" });
  const seen = [];
  const un = L.live.film.addPreFrame(() => seen.push([TR.currentTime(), TR.rng()]));
  await clock.step();
  await clock.step();
  un();
  near(seen[0][0], (50 + 40) / 1000, 1e-12);
  near(seen[1][0], (50 + 80) / 1000, 1e-12);
  const ref = mulberry32("take-7");
  assert.equal(seen[0][1], ref());
  assert.equal(seen[1][1], ref());
  await clock.end();
  const t = TR.currentTime();
  near(t, performance.now() / 1000, 5, "default wall clock restored");
  assert.ok(TR.rng() >= 0 && TR.rng() < 1);
});

// ---------------------------------------------------------------------------
// K4–K6 the clock against the real loop shape (review seams-0 / seams-1 / seams-6)
// ---------------------------------------------------------------------------

/**
 * A fake display driving a copy of the scene3d/index.js scheduler: a
 * requestAnimationFrame queue flushed by `frame()` (callbacks queued before the
 * frame run in order, each followed by a full microtask drain; one cancelled
 * meanwhile never runs, as in HTML), `scheduleNext` that parks on
 * `film.holdLoop`, `_cancelSchedule`, `__renderOnce(tsMs)` that cancels the
 * pending re-arm only for an explicit ts under holdLoop, and an async tick with
 * the syncPhysicsTick microtask hop that stamps frameTime, runs preFrame +
 * postRender, then re-arms. `running` queues the realtime loop's pending re-arm
 * (as after any realtime frame). `driver` stands in for the client's private rAF
 * loops (animated_scenery wind, statics billboards): it re-queues itself and
 * reads the scenery time source on every callback. Clock timers are fake (fired
 * by hand), so the 50 ms yield fallback and the step timeout are deterministic.
 */
function makeDisplay({ startTs = 1000, running = true, driver = true } = {}) {
  let wall = startTs;
  const live = { frameTime: { tsMs: startTs, tsSec: startTs / 1000, dt: 0.016 } };
  const raf = new Map();
  let nextRaf = 1;
  const timers = new Map();
  let nextTimer = 1;
  const ticks = [];
  const driverReads = [];
  const clockRafs = [];
  let schedRafId = null;
  let lastFrameTs = startTs;
  const sources = {
    timeRng: {
      time: null, rng: null,
      setCurrentTime(fn) { this.time = fn; },
      setRng(fn) { this.rng = fn; },
      particleClockMode: () => "off",
    },
    fxTime: { fn: null, setFxTimeSource(fn) { this.fn = fn; } },
    sceneryTime: { fn: null, setSceneryTimeSource(fn) { this.fn = fn; } },
  };
  const win = {
    performance: { now: () => wall },
    requestAnimationFrame(cb) {
      const id = nextRaf++;
      raf.set(id, cb);
      if (cb !== tick && cb !== driverLoop) clockRafs.push(id);
      return id;
    },
    cancelAnimationFrame(id) {
      raf.delete(id);
    },
  };
  function cancelSchedule() {
    if (schedRafId !== null) {
      win.cancelAnimationFrame(schedRafId);
      schedRafId = null;
    }
  }
  function scheduleNext() {
    if (live.film?.holdLoop) return;
    schedRafId = win.requestAnimationFrame(tick);
  }
  async function tick(ts) {
    const dt = (ts - lastFrameTs) / 1000;
    lastFrameTs = ts;
    await Promise.resolve(); // the ?syncPhysicsTick hop
    live.frameTime = { tsMs: ts, tsSec: ts / 1000, dt };
    live.film?.preFrame?.(ts, dt);
    ticks.push({
      ts,
      dt,
      time: sources.timeRng.time ? sources.timeRng.time() : null,
      scenery: sources.sceneryTime.fn ? sources.sceneryTime.fn() : null,
    });
    live.film?.postRender?.();
    scheduleNext();
  }
  win.__renderOnce = (tsMs) => {
    const explicitTs = Number.isFinite(tsMs);
    if (explicitTs && live.film?.holdLoop) cancelSchedule();
    tick(explicitTs ? tsMs : wall);
    return true;
  };
  function driverLoop() {
    driverReads.push({ scenery: sources.sceneryTime.fn ? sources.sceneryTime.fn() : null, ticks: ticks.length });
    win.requestAnimationFrame(driverLoop);
  }
  if (running) schedRafId = win.requestAnimationFrame(tick);
  if (driver) win.requestAnimationFrame(driverLoop);
  const drain = () => new Promise((r) => setImmediate(r));
  async function frame() {
    wall += 1000 / 60;
    for (const id of [...raf.keys()]) {
      const cb = raf.get(id);
      if (!cb) continue; // cancelled during this frame
      raf.delete(id);
      cb(wall);
      await drain();
    }
  }
  const clockDeps = {
    liveScene3d: live,
    window: win,
    ...sources,
    now: () => wall,
    sleep: async (ms) => {
      wall += ms;
    },
    setTimeout: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
  };
  return {
    live, win, raf, timers, ticks, driverReads, clockRafs, sources, clockDeps, frame, drain,
    chains: () => [...raf.values()].filter((cb) => cb === tick).length,
    fireTimers(ms) {
      for (const [id, t] of [...timers]) {
        if (t.ms === ms) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    getWall: () => wall,
  };
}

check("K4 seams-0: one animation frame per film frame — the private rAF driver runs once per step, on the film clock, before the render", async () => {
  const D = makeDisplay();
  const clock = CK.createFilmClock({ fps: 30, ...D.clockDeps });
  clock.begin({ seed: 3 });
  const outs = [];
  for (let k = 0; k < 6; k += 1) {
    const ticks0 = D.ticks.length;
    const reads0 = D.driverReads.length;
    let settled = false;
    const p = clock.step().then((o) => {
      settled = true;
      return o;
    });
    near(clock.stats().lastTsMs, clock.clockMs(), 0, "the upcoming frame is published synchronously");
    await D.drain();
    assert.equal(settled, false, `step ${k}: must not render before an animation frame`);
    assert.equal(D.ticks.length, ticks0, `step ${k}: no tick before the yield (an unbroken microtask chain would render here)`);
    await D.frame();
    assert.equal(settled, true, `step ${k}: resolved after exactly one animation frame`);
    const o = await p;
    outs.push(o);
    assert.equal(D.driverReads.length - reads0, 1, `step ${k}: the private rAF driver ran exactly once`);
    assert.equal(D.ticks[D.ticks.length - 1].ts, o.tsMs, `step ${k}: the frame rendered with its own timestamp`);
    if (k > 0) near(D.driverReads[D.driverReads.length - 1].scenery, o.tsMs, 1e-9, `step ${k}: the driver saw this frame's film time before the render`);
  }
  assert.equal(D.clockRafs.length, 6, "one requestAnimationFrame per step");
  assert.equal(clock.stats().yields, 6);
  assert.equal(clock.stats().yieldFallbacks, 0);
  // Step 0: the loop's re-arm pending from before the hold ran during the yield
  // (queued first), parked on holdLoop, and the clock re-based past it.
  assert.equal(D.ticks.length, 7, "6 film ticks + the one pre-hold realtime tick");
  assert.equal(clock.stats().rebases, 1);
  const film = D.ticks.slice(1);
  near(film[0].ts, D.ticks[0].ts + 1000 / 30, 1e-9, "re-based past the realtime frame");
  for (let k = 0; k < film.length; k += 1) {
    near(film[k].dt, 1 / 30, 1e-9, `tick ${k}: dt = 1/fps exactly`);
    near(outs[k].dt, 1 / 30, 1e-9);
    if (k > 0) assert.ok(film[k].ts > film[k - 1].ts, "strictly increasing");
    near(film[k].scenery, film[k].ts, 1e-12, "scenery source = frame ts at render");
  }
  for (let k = 2; k < D.driverReads.length; k += 1) {
    near(D.driverReads[k].scenery - D.driverReads[k - 1].scenery, 1000 / 30, 1e-9, "the wind advances exactly one film frame per film frame");
  }
  assert.equal(D.chains(), 0, "no realtime chain while held");
  assert.equal(D.timers.size, 0, "the 50 ms fallbacks and the step timeouts were all cleared");
  const r = await clock.end();
  assert.equal(r.rearmed, true);
  assert.equal(D.chains(), 1, "exactly one realtime chain after the hand-back");
});

check("K4 yield fallbacks: a throttled rAF gives way after 50 ms (rAF cancelled); a hidden page yields one task, no rAF", async () => {
  const D = makeDisplay({ running: false, driver: false });
  const clock = CK.createFilmClock({ fps: 30, ...D.clockDeps });
  clock.begin({});
  let settled = false;
  const p = clock.step().then((o) => {
    settled = true;
    return o;
  });
  await D.drain();
  assert.equal(settled, false);
  assert.equal(D.raf.size, 1, "the clock's rAF is queued");
  assert.deepEqual([...D.timers.values()].map((t) => t.ms), [CK.FILM_CLOCK_YIELD_FALLBACK_MS]);
  D.fireTimers(CK.FILM_CLOCK_YIELD_FALLBACK_MS);
  await D.drain();
  assert.equal(settled, true, "rendered after the fallback");
  assert.equal(D.raf.size, 0, "the throttled rAF was cancelled");
  assert.equal(clock.stats().yieldFallbacks, 1);
  near((await p).tsMs, 1000 + 1000 / 30, 1e-9);
  await clock.end();
  const H = makeDisplay({ running: false, driver: false });
  H.win.document = { visibilityState: "hidden" };
  const ch = CK.createFilmClock({ fps: 30, ...H.clockDeps });
  ch.begin({});
  const o = await ch.step(); // no frame() needed: one MessageChannel task
  near(o.tsMs, 1000 + 1000 / 30, 1e-9);
  assert.equal(H.clockRafs.length, 0, "no rAF on a hidden page");
  assert.equal(H.timers.size, 0, "no fallback timer; the step timeout cleared");
  assert.equal(ch.stats().yields, 1);
  await ch.end();
});

check("K5 seams-1: ?particleClock=sim — the particle clock continues from _particleSimNowS (no jump to wall); end() leaves it ≥ the take's, never back", async () => {
  const L = makeLoop({ startTs: 160000 });
  L.sources.timeRng.particleClockMode = () => "sim";
  L.live._particleSimNowS = 100; // the sim clock lags wall time by 60 s of clamped hitches
  const clock = CK.createFilmClock({ fps: 30, ...L.clockDeps });
  clock.begin({});
  assert.equal(clock.stats().simBaseS, 100);
  near(L.sources.timeRng.time(), 100, 1e-12, "no jump at begin");
  for (let k = 0; k < 30; k += 1) await clock.step();
  L.reads.forEach((r, k) => near(r.time, 100 + (k + 1) / 30, 1e-9, `film frame ${k}: sim base + film time`));
  near(L.reads[0].fx, 160000 + 1000 / 30, 1e-9, "the FX source stays on the frame timestamp (ms)");
  near(L.reads[0].scenery, 160000 + 1000 / 30, 1e-9, "the scenery source stays on the frame timestamp (ms)");
  near(clock.particleTimeS(), 101, 1e-9);
  L.live._particleSimNowS = 100.5; // the loop advanced it by clamped dt, capped at wall
  await clock.end();
  near(L.live._particleSimNowS, 101, 1e-9, "moved up to sim base + film duration");
  near(L.sources.timeRng.time(), 101, 1e-9, "the loop sim clock is re-installed");
  // A second take after wall time ran on: still no jump, and never moved back.
  L.setWall(400000);
  L.live.frameTime = { tsMs: 400000, tsSec: 400, dt: 0.016 };
  L.live._particleSimNowS = 101.2;
  const n0 = L.reads.length;
  clock.begin({});
  near(L.sources.timeRng.time(), 101.2, 1e-12, "second take: no jump at begin");
  await clock.step();
  near(L.reads[n0].time, 101.2 + 1 / 30, 1e-9, "second take frame 0");
  L.live._particleSimNowS = 105; // the loop ran ahead of the film particle time
  await clock.end();
  assert.equal(L.live._particleSimNowS, 105, "never moved back");
  // Hand-back: a sim clock stamped ahead of the frame's rAF timestamp → wait for
  // wall time to pass the film particle time (loop.js caps the sim clock at wall).
  const M = makeLoop({ startTs: 1000 });
  M.sources.timeRng.particleClockMode = () => "sim";
  M.live._particleSimNowS = 1.02;
  const c2 = CK.createFilmClock({ fps: 30, ...M.clockDeps });
  c2.begin({});
  for (let k = 0; k < 3; k += 1) await c2.step();
  let restoreWall = null;
  const orig = M.sources.timeRng.setCurrentTime;
  M.sources.timeRng.setCurrentTime = function (fn) {
    restoreWall = M.getWall();
    return orig.call(this, fn);
  };
  await c2.end();
  near(M.live._particleSimNowS, 1.12, 1e-9);
  assert.ok(restoreWall > 1120, `handed back only once wall time passed the film particle time (${restoreWall})`);
  // Sim mode reported but the sim clock unseeded: the frame-timestamp base, as before.
  const U = makeLoop({ startTs: 2000 });
  U.sources.timeRng.particleClockMode = () => "sim";
  const c3 = CK.createFilmClock({ fps: 30, ...U.clockDeps });
  c3.begin({});
  assert.equal(c3.stats().simBaseS, null);
  await c3.step();
  near(U.reads[0].time, (2000 + 1000 / 30) / 1000, 1e-12);
  await c3.end();
  near(U.live._particleSimNowS, (2000 + 1000 / 30) / 1000, 1e-12, "seeded at the film time");
});

check("K5 seams-1 + seams-0: sim particle time stays continuous across the first-step re-base (no jump, monotonic)", async () => {
  const D = makeDisplay({ startTs: 50000 });
  D.sources.timeRng.particleClockMode = () => "sim";
  D.live._particleSimNowS = 30;
  const clock = CK.createFilmClock({ fps: 30, ...D.clockDeps });
  clock.begin({});
  for (let k = 0; k < 4; k += 1) {
    const p = clock.step();
    await D.frame();
    await p;
  }
  const film = D.ticks.slice(1);
  near(D.ticks[0].time, 30 + 1 / 30, 1e-9, "the pre-hold realtime tick read the published frame-0 particle time");
  for (let k = 0; k < film.length; k += 1) {
    near(film[k].time, 30 + (film[k].ts - 50000) / 1000, 1e-9, `frame ${k}: sim base + film clock`);
    if (k > 0) near(film[k].time - film[k - 1].time, 1 / 30, 1e-9, "one film frame of particle time per frame");
  }
  assert.ok(film[0].time >= D.ticks[0].time, "monotonic through the re-base");
  assert.ok(film[0].time - 30 < 0.1, `no jump (${film[0].time - 30} s)`);
  await clock.end();
  assert.ok(D.live._particleSimNowS >= film[film.length - 1].time - 1e-12, "end() leaves the sim clock ≥ the take's last particle time");
});

check("K6 seams-6: begin → end without a step leaves exactly ONE rAF chain; a parked chain is re-armed once", async () => {
  // (a) Nothing ran during the hold: the pre-hold re-arm is still queued, so end() must not add one.
  const D = makeDisplay({ driver: false });
  const clock = CK.createFilmClock({ fps: 30, ...D.clockDeps });
  assert.equal(D.chains(), 1);
  clock.begin({});
  const r = await clock.end();
  assert.equal(r.rearmed, false, "no bare re-arm while the realtime chain is alive");
  assert.equal(D.live.film.holdLoop, false);
  assert.equal(D.chains(), 1, "exactly one chain");
  assert.equal(clock.stats().rearmsSkipped, 1);
  for (let i = 0; i < 3; i += 1) {
    const n0 = D.ticks.length;
    await D.frame();
    assert.equal(D.ticks.length - n0, 1, `display frame ${i}: one tick per vsync`);
    assert.equal(D.chains(), 1);
  }
  // (b) A realtime tick ran during the hold and parked on holdLoop: end() re-arms exactly once.
  clock.begin({});
  await D.frame();
  assert.equal(D.chains(), 0, "parked");
  const r2 = await clock.end();
  assert.equal(r2.rearmed, true);
  assert.equal(D.chains(), 1);
  for (let i = 0; i < 2; i += 1) {
    const n0 = D.ticks.length;
    await D.frame();
    assert.equal(D.ticks.length - n0, 1, `after (b) frame ${i}: one tick per vsync`);
  }
  // (c) A stepped take (the explicit-ts render cancelled the re-arm): exactly one chain after.
  clock.begin({});
  const p = clock.step();
  await D.frame();
  await p;
  assert.equal(D.chains(), 0);
  const r3 = await clock.end();
  assert.equal(r3.rearmed, true);
  assert.equal(D.chains(), 1);
  const n0 = D.ticks.length;
  await D.frame();
  assert.equal(D.ticks.length - n0, 1, "one tick per vsync after a take");
  // (d) A step that never got a render function (no index.js seam) is not a render: no re-arm.
  const E = makeDisplay({ driver: false });
  const onceFn = E.win.__renderOnce;
  const c2 = CK.createFilmClock({ fps: 30, ...E.clockDeps });
  c2.begin({});
  delete E.win.__renderOnce;
  await assert.rejects(c2.step(), (e) => e.code === "FILM_RENDER_UNAVAILABLE");
  E.win.__renderOnce = onceFn;
  assert.equal((await c2.end()).rearmed, false);
  assert.equal(E.chains(), 1);
});

// ---------------------------------------------------------------------------
// H1 clean frame
// ---------------------------------------------------------------------------

function makeDom() {
  const listeners = [];
  const win = {
    addEventListener(type, fn, opts) {
      listeners.push({ type, fn, opts });
    },
    removeEventListener(type, fn, opts) {
      const cap = typeof opts === "boolean" ? opts : !!(opts && opts.capture);
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn && !!(l.opts && l.opts.capture) === cap);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  const head = {
    children: [],
    appendChild(el) {
      this.children.push(el);
      el.parentNode = this;
      return el;
    },
    removeChild(el) {
      const i = this.children.indexOf(el);
      if (i >= 0) this.children.splice(i, 1);
      el.parentNode = null;
      return el;
    },
  };
  const classes = new Set();
  const doc = {
    head,
    documentElement: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } },
    createElement: (tag) => ({ tagName: String(tag).toUpperCase(), id: "", textContent: "", parentNode: null }),
    getElementById: (id) => head.children.find((e) => e.id === id) ?? null,
  };
  return { win, doc, listeners, classes, head };
}

class FakeEM {
  constructor() {
    this.shown = [];
    this.sel = 0x5001;
    this.selCalls = [];
    this.disposed = 0;
    const self = this;
    const bubble = (name) => {
      const sprite = {
        name,
        material: { map: { dispose() { self.disposed += 1; } }, dispose() { self.disposed += 1; } },
        parent: null,
      };
      sprite.parent = { removed: 0, remove(s) { if (s === sprite) this.removed += 1; } };
      return sprite;
    };
    this.entityMap = new Map([
      [0x5001, { _speechBubble: bubble("a"), _nameplateSprite: { visible: true }, _buffBadgeSprite: { visible: true } }],
      [0x5002, { _speechBubble: null, _nameplateSprite: { visible: false } }],
      [0x5003, { _speechBubble: bubble("c") }],
    ]);
  }
  showSpeechBubble(guid, text) {
    this.shown.push([guid, text]);
  }
  getSelectedTarget() {
    return this.sel;
  }
  setSelectedTarget(g) {
    this.sel = g >>> 0;
    this.selCalls.push(g);
  }
}

check("H1 clean_frame apply(): CSS, funnel release→poison, capture blockers, bubbles, selection, brackets, input state", () => {
  const { win, doc, listeners, classes, head } = makeDom();
  const order = [];
  win.__inputFunnel = {
    _fault: null,
    releaseHeld(r) { order.push(["releaseHeld", r]); return ["w", "d"]; },
    poison(m) { order.push(["poison", m]); this._fault = m; return m; },
    unpoison() { order.push(["unpoison"]); this._fault = null; return true; },
    snapshot() { return { fault: this._fault }; },
  };
  const em = new FakeEM();
  const cs = new FakeSwitcher();
  const brackets = { _displayOn: true, calls: [], setDisplayOn(on) { this._displayOn = !!on; this.calls.push(on); } };
  const live = { entityManager: em, cameraSwitcher: cs, selectionBracketLayer: brackets, helloCube: { visible: true } };
  const cf = CF.createCleanFrame({ document: doc, window: win, liveScene3d: live });
  const r = cf.apply();
  assert.equal(r.ok, true);
  assert.equal(cf.active, true);
  // CSS.
  const style = doc.getElementById(CF.FILM_CLEAN_STYLE_ID);
  assert.ok(style && style.tagName === "STYLE");
  assert.ok(/cursor:\s*none\s*!important/.test(style.textContent));
  assert.ok(/border:\s*0\s*!important/.test(style.textContent));
  assert.ok(/image-rendering:\s*auto\s*!important/.test(style.textContent));
  assert.ok(classes.has(CF.FILM_CLEAN_CLASS));
  // Funnel: releaseHeld first, then poison('gate').
  assert.deepEqual(order, [["releaseHeld", "film"], ["poison", "gate"]]);
  // Blockers: every listed event, capture phase; wheel/touch passive:false.
  assert.equal(listeners.length, CF.FILM_BLOCKED_EVENTS.length);
  for (const t of ["keydown", "keyup", "pointerdown", "mousemove", "click", "dblclick", "auxclick", "contextmenu", "wheel", "touchstart", "dragstart", "drop"]) {
    const l = listeners.find((x) => x.type === t);
    assert.ok(l, t);
    assert.equal(l.opts.capture, true, `${t} capture`);
  }
  assert.equal(listeners.find((x) => x.type === "wheel").opts.passive, false);
  const ev = { cancelable: true, stopped: 0, prevented: 0, stopImmediatePropagation() { this.stopped += 1; }, preventDefault() { this.prevented += 1; } };
  listeners.find((x) => x.type === "dblclick").fn(ev);
  listeners.find((x) => x.type === "wheel").fn(ev);
  assert.equal(ev.stopped, 2);
  assert.equal(ev.prevented, 2);
  assert.equal(cf.state().blockedEvents, 2);
  // Camera input state.
  assert.equal(cs.calls.endDrag, 1);
  assert.ok(Object.values(cs.keys).every((v) => v === false));
  // Selection + brackets.
  assert.deepEqual(em.selCalls, [0]);
  assert.deepEqual(brackets.calls, [false]);
  // Bubbles: new ones suppressed, live ones disposed.
  assert.ok(Object.prototype.hasOwnProperty.call(em, "showSpeechBubble"));
  em.showSpeechBubble(0x5001, "Hail!");
  assert.deepEqual(em.shown, []);
  assert.equal(cf.state().suppressedBubbles, 1);
  assert.equal(em.entityMap.get(0x5001)._speechBubble, null);
  assert.equal(em.entityMap.get(0x5003)._speechBubble, null);
  assert.equal(em.disposed, 4, "map + material of two bubbles");
  // Nameplates + hello cube.
  assert.equal(em.entityMap.get(0x5001)._nameplateSprite.visible, false);
  assert.equal(em.entityMap.get(0x5001)._buffBadgeSprite.visible, false);
  assert.equal(live.helloCube.visible, false);
  // Idempotent.
  assert.equal(cf.apply().already, true);
  assert.equal(listeners.length, CF.FILM_BLOCKED_EVENTS.length);
  assert.equal(head.children.length, 1);
});

check("H1 clean_frame restore(): everything back, idempotent; a pre-existing poison is re-applied", () => {
  const { win, doc, listeners, classes, head } = makeDom();
  const calls = [];
  win.__inputFunnel = {
    _fault: "throw",
    releaseHeld() { return []; },
    poison(m) { calls.push(["poison", m]); this._fault = m; return m; },
    unpoison() { calls.push(["unpoison"]); this._fault = null; return true; },
    snapshot() { return { fault: this._fault }; },
  };
  const em = new FakeEM();
  const cs = new FakeSwitcher();
  const brackets = { _displayOn: false, calls: [], setDisplayOn(on) { this._displayOn = !!on; this.calls.push(on); } };
  const live = { entityManager: em, cameraSwitcher: cs, selectionBracketLayer: brackets, helloCube: { visible: true } };
  const cf = CF.createCleanFrame({ document: doc, window: win, liveScene3d: live });
  cf.apply();
  const r = cf.restore();
  assert.equal(r.ok, true);
  assert.equal(r.wasActive, true);
  assert.equal(cf.active, false);
  assert.equal(listeners.length, 0, "every blocker removed");
  assert.equal(head.children.length, 0, "stylesheet removed");
  assert.equal(classes.has(CF.FILM_CLEAN_CLASS), false);
  assert.deepEqual(calls, [["poison", "gate"], ["poison", "throw"]], "the previous 'throw' poison is restored, not unpoisoned");
  assert.equal(Object.prototype.hasOwnProperty.call(em, "showSpeechBubble"), false, "prototype method back");
  em.showSpeechBubble(0x5002, "hi");
  assert.deepEqual(em.shown, [[0x5002, "hi"]]);
  assert.deepEqual(brackets.calls, [false, false], "bracket display restored to its previous (off) state");
  assert.deepEqual(em.selCalls, [0, 0x5001], "selection restored");
  assert.equal(em.entityMap.get(0x5001)._nameplateSprite.visible, true);
  assert.equal(em.entityMap.get(0x5001)._buffBadgeSprite.visible, true);
  assert.equal(em.entityMap.get(0x5002)._nameplateSprite.visible, false, "a hidden one stays hidden");
  assert.equal(live.helloCube.visible, true);
  assert.deepEqual(cf.restore(), { ok: true, wasActive: false });
  // An open funnel is unpoisoned on restore; bubbles may be kept for dialogue.
  const D2 = makeDom();
  const f2 = { _fault: null, n: [], releaseHeld() { return []; }, poison(m) { this._fault = m; this.n.push(m); }, unpoison() { this._fault = null; this.n.push("un"); }, snapshot() { return { fault: this._fault }; } };
  D2.win.__inputFunnel = f2;
  const em2 = new FakeEM();
  const cf2 = CF.createCleanFrame({ document: D2.doc, window: D2.win, liveScene3d: { entityManager: em2 } });
  cf2.apply({ bubbles: true });
  assert.equal(Object.prototype.hasOwnProperty.call(em2, "showSpeechBubble"), false, "bubbles kept");
  assert.notEqual(em2.entityMap.get(0x5001)._speechBubble, null);
  cf2.restore();
  assert.deepEqual(f2.n, ["gate", "un"]);
  // No DOM / window at all: apply and restore still succeed (steps report skips).
  const cf3 = CF.createCleanFrame({ document: null, window: null, liveScene3d: null });
  const a3 = cf3.apply();
  assert.equal(a3.ok, true);
  assert.equal(a3.steps.css.ok, false);
  assert.equal(cf3.restore().ok, true);
});

// ---------------------------------------------------------------------------
// S1–S2 safety
// ---------------------------------------------------------------------------

/** A fake los with a wall plane y = 10 (normal −y): blocks a sphere of the sweep radius. */
function wallLos(wallY = 10) {
  return {
    calls: [],
    segmentBlocked(sh, from, to, opts) {
      this.calls.push({ from: from.slice(), to: to.slice(), opts });
      const yw = wallY - opts.radius;
      if (from[1] <= yw + 1e-12 && to[1] > yw + 1e-12) {
        const t = (yw - from[1]) / (to[1] - from[1]);
        const point = [from[0] + (to[0] - from[0]) * t, wallY, from[2] + (to[2] - from[2]) * t];
        return { blocked: true, t, layer: "buildingMesh", kind: "building", point, normal: [0, -1, 0] };
      }
      return { blocked: false, t: 1, layer: null };
    },
  };
}

check("S1 radiusFor = max(minRadius, near·√(1 + tan²(fov/2)·(1 + aspect²)) + skin)", () => {
  const s = SF.createSafety({ los: wallLos() });
  near(s.radiusFor(60, 16 / 9), SF.SAFETY_MIN_RADIUS_M, 1e-12, "60° 16:9 sits under the floor");
  const t = Math.tan(Math.PI / 3);
  near(s.radiusFor(120, 16 / 9), 0.1 * Math.sqrt(1 + t * t * (1 + (16 / 9) ** 2)) + 0.05, 1e-12);
  assert.ok(s.radiusFor(120, 16 / 9) > 0.36 && s.radiusFor(120, 16 / 9) < 0.42, "≈0.37 m corner + skin at 120°");
  near(s.radiusFor(NaN, 0), s.radiusFor(60, 16 / 9), 1e-12, "defaults");
  near(SF.safetyRadius(90, 1, { minRadius: 0 }), 0.1 * Math.sqrt(1 + 2) + 0.05, 1e-12);
  assert.throws(() => SF.createSafety({}), FilmError);
});

check("S1 sweep + slide: the eye stops a skin short of the wall and slides along its normal", () => {
  const los = wallLos();
  const s = SF.createSafety({ los, worldQuery: { groundZ: () => 0 } });
  const prev = { pos: [0, 0, 2], h: 0, p: 0, r: 0, fov: 60 };
  const want = { pos: [3, 15, 2], h: 0.1, p: 0, r: 0, fov: 60, q: [1, 0, 0, 0] };
  const r = s.clamp(prev, want, {});
  assert.equal(r.adjusted, true);
  const R = r.radius;
  const L = Math.hypot(3, 15);
  const tHit = (10 - R) / 15;
  const sStop = tHit - 0.05 / L;
  nearV(r.pose.pos, [3, 15 * sStop, 2], 1e-9, "slid to x = 3 along the wall");
  assert.ok(r.pose.pos[1] < 10 - R, "inside the clearance");
  assert.equal(r.pose.h, 0.1, "orientation untouched");
  assert.deepEqual(r.pose.q, [1, 0, 0, 0]);
  assert.equal(r.hits[0].layer, "buildingMesh");
  assert.deepEqual(r.hits[0].normal, [0, -1, 0]);
  assert.equal(los.calls.length, 2, "first sweep + one slide sweep");
  const o = los.calls[0].opts;
  assert.equal(o.radius, R);
  assert.equal(o.subjectGuid, 0, "the subject is an obstacle for safety");
  assert.ok(o.layers.includes("terrain") && typeof o.terrainZAt === "function", "terrain swept outdoors");
  assert.equal(o.exemptLocalPlayer, true);
  // Free path: unchanged.
  const r2 = s.clamp(prev, { pos: [1, 5, 2], fov: 60 }, {});
  assert.equal(r2.adjusted, false);
  nearV(r2.pose.pos, [1, 5, 2], 0);
});

check("S1 terrain floor outdoors only; indoors clipCameraToCellSpace from the carried cell + render-set cells", () => {
  const los = { calls: [], segmentBlocked(sh, a, b, o) { this.calls.push(o); return { blocked: false, t: 1 }; } };
  const clip = [];
  const sh = {
    clipCameraToCellSpace(fx, fy, fz, tx, ty, tz, r, cell) {
      clip.push({ from: [fx, fy, fz], to: [tx, ty, tz], r, cell });
      return 0.5;
    },
    getRenderSet(depth) {
      return depth === 1 ? new Uint32Array([0xa9b40105, 0xa9b40106]) : new Uint32Array(0);
    },
  };
  const s = SF.createSafety({ los, sh, worldQuery: { groundZ: () => 5 } });
  // Outdoors: below ground → lifted to ground + 0.7.
  const r = s.clamp({ pos: [0, 0, 6] }, { pos: [2, 0, 3], fov: 60 }, {});
  near(r.pose.pos[2], 5.7, 1e-12);
  assert.ok(r.hits.some((h) => h.layer === "terrain-floor"));
  assert.equal(clip.length, 0, "no cell clip outdoors");
  // Indoors (cell inferred from the EnvCell id): no floor, no terrain layer, clip from the carried cell.
  los.calls.length = 0;
  const cell = 0xa9b40105;
  const ri = s.clamp({ pos: [0, 0, 3] }, { pos: [4, 0, 3], fov: 60 }, { cell });
  assert.equal(los.calls[0].layers.includes("terrain"), false);
  assert.equal(los.calls[0].terrainZAt, undefined);
  assert.deepEqual(Array.from(los.calls[0].cellIds), [0xa9b40105, 0xa9b40106]);
  assert.equal(clip.length, 1);
  assert.equal(clip[0].cell, cell);
  near(clip[0].r, ri.radius, 0);
  nearV(ri.pose.pos, [4 * (0.5 - 0.05 / 4), 0, 3], 1e-12, "clamped at t − skin");
  assert.ok(ri.hits.some((h) => h.layer === "cell-space"));
  assert.ok(!ri.hits.some((h) => h.layer === "terrain-floor"), "never a terrain floor indoors");
  // ctx.indoor overrides the inference; explicit cellIds are passed through.
  los.calls.length = 0;
  s.clamp({ pos: [0, 0, 3] }, { pos: [1, 0, 3] }, { indoor: true, cell, cellIds: [7] });
  assert.deepEqual(los.calls[0].cellIds, [7]);
});

check("S1 near-lens particles: hidden render-only, shown again past the hysteresis, all restored on release()", () => {
  const emA = { id: "A" }; // never had the flag
  const emB = { id: "B", filmHidden: false };
  const clouds = [
    { emitter: emA, key: "smoke#1", center: [0, 1.2, 2], radius: 0.6 },
    { emitter: emB, key: "fire#2", center: [0, 30, 2], radius: 1.0 },
  ];
  const particles = {
    near(center, r) {
      const out = [];
      for (const c of clouds) {
        if (c.emitter.filmHidden === true) continue; // particles_query skips hidden emitters
        const range = Math.max(0, Math.hypot(center[0] - c.center[0], center[1] - c.center[1], center[2] - c.center[2]) - c.radius);
        if (range <= r) out.push({ ...c, range });
      }
      return out;
    },
  };
  const s = SF.createSafety({ los: { segmentBlocked: () => ({ blocked: false, t: 1 }) }, particles, worldQuery: { groundZ: () => null } });
  const r1 = s.clamp({ pos: [0, 0, 2] }, { pos: [0, 0.1, 2] }, {});
  assert.deepEqual(r1.particles.hidden, ["smoke#1"]);
  assert.equal(emA.filmHidden, true);
  assert.equal(emB.filmHidden, false);
  // Still within lens + hysteresis: stays hidden.
  const r2 = s.clamp({ pos: [0, 0.1, 2] }, { pos: [0, -1.0, 2] }, {});
  assert.deepEqual(r2.particles.shown, []);
  assert.equal(emA.filmHidden, true);
  // Far away: shown again (the property was never set → deleted).
  const r3 = s.clamp({ pos: [0, -1, 2] }, { pos: [0, -5, 2] }, {});
  assert.deepEqual(r3.particles.shown, ["smoke#1"]);
  assert.equal("filmHidden" in emA, false);
  // Into the fire, then release() restores the previous false.
  s.clamp({ pos: [0, 28, 2] }, { pos: [0, 29.5, 2] }, { cut: true });
  assert.equal(emB.filmHidden, true);
  assert.equal(s.hiddenEmitters(), 1);
  assert.equal(s.release(), 1);
  assert.equal(emB.filmHidden, false);
  assert.equal(s.hiddenEmitters(), 0);
  // particleLens:false disables the hide.
  const s2 = SF.createSafety({ los: { segmentBlocked: () => ({ blocked: false }) }, particles, particleLens: false });
  s2.clamp({ pos: [0, 0, 2] }, { pos: [0, 0.1, 2] }, {});
  assert.equal(emA.filmHidden, undefined);
});

check("S1 robustness: invalid desired → previous pose; cut skips the sweep; a throwing los never throws", () => {
  const los = wallLos();
  const s = SF.createSafety({ los, worldQuery: { groundZ: () => 0 } });
  const prev = { pos: [1, 2, 3], h: 0.5, fov: 60 };
  const r = s.clamp(prev, { pos: [NaN, 0, 0] }, {});
  assert.equal(r.adjusted, true);
  nearV(r.pose.pos, [1, 2, 3], 0);
  assert.equal(r.pose.h, 0.5);
  assert.equal(r.hits[0].layer, "invalid");
  assert.equal(s.clamp(null, { pos: "bad" }, {}).pose, null);
  // No previous eye / a cut: no sweep (a hard cut may cross a wall), floor still applies.
  los.calls.length = 0;
  const rc = s.clamp(prev, { pos: [0, 50, -2] }, { cut: true });
  assert.equal(los.calls.length, 0);
  near(rc.pose.pos[2], 0.7, 1e-12);
  const rn = s.clamp(null, { pos: [0, 50, 4] }, {});
  assert.equal(rn.adjusted, false);
  // A throwing los: treated as clear, counted.
  const s2 = SF.createSafety({ los: { segmentBlocked() { throw new Error("borrow conflict"); } } });
  const r2 = s2.clamp({ pos: [0, 0, 0] }, { pos: [0, 20, 0] }, {});
  nearV(r2.pose.pos, [0, 20, 0], 0);
  assert.equal(s2.stats().losErrors, 1);
  // Non-object ctx and missing world query.
  assert.equal(s2.clamp({ pos: [0, 0, 0] }, { pos: [0, 1, 0] }, null).adjusted, false);
});

check("S2 the REAL los.js segmentBlocked under safety: chunked wasm sweep, hit copied and freed", () => {
  let freed = 0;
  let boxes = 0;
  const calls = [];
  // A building wall at local y = 10 in landblock 0xA9B4; hits come back as CollisionHit-like boxes.
  const sh = {
    sweepSphereAgainstBuildingMesh(fx, fy, fz, tx, ty, tz, r, lb) {
      calls.push(lb >>> 0);
      const yw = LBY + 10 - r;
      if (fy <= yw && ty > yw) {
        const t = (yw - fy) / (ty - fy);
        boxes += 1;
        return { t, x: fx + (tx - fx) * t, y: LBY + 10, z: fz + (tz - fz) * t, normalX: 0, normalY: -1, normalZ: 0, free() { freed += 1; } };
      }
      return undefined;
    },
  };
  const s = SF.createSafety({ los: LOS, sh, worldQuery: { groundZ: () => 0 } });
  const r = s.clamp({ pos: [LBX + 50, LBY + 2, 3] }, { pos: [LBX + 52, LBY + 14, 3] }, { layers: ["buildingMesh"] });
  assert.equal(r.adjusted, true);
  assert.ok(r.pose.pos[1] < LBY + 10 - r.radius + 1e-9, `stopped before the wall (${r.pose.pos[1] - LBY})`);
  near(r.pose.pos[0], LBX + 52, 1e-9, "slid along the wall");
  assert.equal(r.hits[0].layer, "buildingMesh");
  assert.ok(boxes >= 1);
  assert.equal(freed, boxes, "every returned CollisionHit freed");
  assert.ok(calls.every((lb) => lb === LB), "chunk landblock key passed");
});

// ---------------------------------------------------------------------------

for (const run of pending) await run();
console.log(`film_runtime_camera: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
