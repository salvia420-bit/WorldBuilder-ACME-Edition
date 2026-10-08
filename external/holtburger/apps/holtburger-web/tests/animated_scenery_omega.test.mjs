// tests/animated_scenery_omega.test.mjs — the retail SetOmega ORBIT of the
// DAT-static ambient critters (?animSceneryOmega, default ON).
//
// The owner's "seagulls and butterflies are at too fast cadence" (2026-10-08).
// The flying ambients are region scenery Setups whose DefaultAnimation flaps
// two wing parts that sit OFF the object origin (seagull 0x020005AC: 12 m out,
// 15 m up) and whose frame-0 SetOmega hook makes retail rotate the WHOLE
// object once per static update (animate_static_object -> Frame::grotate(
// &frame, &m_omegaVector), no quantum multiply, acclient.c:321150; updates
// gated to >= MIN_QUANTUM 1/30 s). animated_scenery.js played the flap at the
// right 30 fps but never read the hook, so every critter hovered in place
// beating its wings. This locks: the orbit sweeps 30 x |omega| rad/s about the
// placement point at the authored ring radius; the flag escape and a stale
// pkg (no `setOmega` getter) keep today's hover.
//
// Run from apps/holtburger-web/:  node tests/animated_scenery_omega.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
// statics.js (imported lazily by attachAnimatedScenery for its material cache)
// arms module-level rAF loops when `window` exists. A stub that never calls
// back keeps every self-managed loop parked; the test drives frames itself
// through the tickAnimatedScenery() seam.
globalThis.window.requestAnimationFrame ??= () => 1;
globalThis.window.cancelAnimationFrame ??= () => {};

const THREE = await import("three");
const AS = await import("../scene3d/animated_scenery.js");

// Real client_portal.dat: Animation 0x03000751 = Setup 0x020005AC's
// default_animation. 2 parts x 7 frames, fetchAnimation layout
// [ox, oy, oz, qw, qx, qy, qz] per (frame, part).
const SEAGULL_FRAMES = new Float32Array([
  -1.04907e-06, -12, 15, -0.706138, -0.0370071, 0.0370071, -0.706138, -1.04907e-06, -12, 15, -0.037624, -0.706105, 0.706105, -0.037624,
  -1.04907e-06, -12, 15, -0.703956, 0.0666767, -0.0666767, -0.703956, -1.04907e-06, -12, 15, 0.066432, -0.703979, 0.703979, 0.066432,
  -1.04907e-06, -12, 15, -0.694115, 0.134922, -0.134922, -0.694115, -1.04907e-06, -12, 15, 0.134922, -0.694115, 0.694115, 0.134922,
  -1.04907e-06, -12, 15, -0.701729, 0.0870441, -0.0870442, -0.701729, -1.04907e-06, -12, 15, 0.0869059, -0.701746, 0.701746, 0.0869059,
  -1.04907e-06, -12, 15, -0.706714, -0.0235722, 0.0235722, -0.706714, -1.04907e-06, -12, 15, -0.0241324, -0.706695, 0.706695, -0.0241324,
  -1.04907e-06, -12, 15, -0.692866, -0.1412, 0.1412, -0.692865, -1.04907e-06, -12, 15, -0.142198, -0.692661, 0.692661, -0.142198,
  -1.04907e-06, -12, 15, -0.679715, -0.194905, 0.194905, -0.679715, -1.04907e-06, -12, 15, -0.196092, -0.679373, 0.679373, -0.196092,
]);
// Its frame-0 SetOmega hook payload (Vector3), the only hook in the clip.
const SEAGULL_OMEGA = new Float32Array([0, 1.314281683484353e-9, -0.03839724138379097]);
// 2026-10-08 — the integration rate is ?animSceneryOmegaHz (default 15, owner:
// the 30 Hz MIN_QUANTUM ceiling read "orbit too fast"); retail's per-tick angle.
const RETAIL_RAD_PER_S = AS.ANIM_SCENERY_OMEGA_HZ_DEFAULT * 0.03839724138379097;

function wasm({ omega }) {
  const tri = () => ({
    triCount: 1,
    positions: new Float32Array([0, 0, 0, 0.4, 0, 0, 0, 0.2, 0]),
    uvs: new Float32Array(6),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    surfaceIndices: new Uint8Array([0]),
    surfaces: new Uint32Array([0x08000010]),
  });
  return {
    async fetchAnimation() {
      const a = { numParts: 2, numFrames: 7, flags: 2, frames: SEAGULL_FRAMES, free() {} };
      if (omega) a.setOmega = omega; // absent = a pkg built before the getter
      return a;
    },
    async fetchBuildingPlacement() {
      return { partCount: 2, takePartMeshes: () => [tri(), tri()], takePartHingeFrames: () => [], free() {} };
    },
    fetch_surfaces_pixels: async () => [],
  };
}

// LB 0xA9B3 (Holtburg); outdoor scenery x/y are LB-local.
const LB = 0xa9b30000;
const ANCHOR = new THREE.Vector3(0xa9 * 192 + 100, 0xb3 * 192 + 100, 50);

async function attach(setupId, animId, omega, sourceObjIdx) {
  const scene3d = {
    staticsGroup: new THREE.Group(),
    materialCache: { get: async () => new THREE.MeshBasicMaterial() },
  };
  const p = {
    objId: setupId, defaultAnimationId: animId, landblockId: LB, sourceObjIdx,
    x: 100, y: 100, z: 50, qw: 1, qx: 0, qy: 0, qz: 0,
  };
  const r = await AS.attachAnimatedScenery(scene3d, [p], wasm({ omega }), {});
  assert.equal(r.built, 1, "the critter builds on the instanced path");
  const bucket = scene3d.staticsGroup.children.find((o) => o.isInstancedMesh && /-p0-/.test(o.name));
  assert.ok(bucket, "part-0 bucket exists");
  return bucket;
}

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
function wing(bucket) {
  bucket.getMatrixAt(0, _m);
  _m.decompose(_p, _q, _s);
  return { angle: Math.atan2(_p.y - ANCHOR.y, _p.x - ANCHOR.x), r: Math.hypot(_p.x - ANCHOR.x, _p.y - ANCHOR.y), z: _p.z };
}
function sweep(bucket, seconds, hz) {
  AS.tickAnimatedScenery(1 / hz);
  let prev = wing(bucket).angle, total = 0, w = null;
  for (let i = 0; i < seconds * hz; i++) {
    AS.tickAnimatedScenery(1 / hz);
    w = wing(bucket);
    let d = w.angle - prev;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    total += d;
    prev = w.angle;
  }
  return { total, last: w };
}

test("seagull 0x020005AC circles its placement at the retail SetOmega rate", async () => {
  try {
    const bucket = await attach(0x020005ac, 0x03000751, SEAGULL_OMEGA, 1);
    const { total, last } = sweep(bucket, 2, 60);
    assert.ok(Math.abs(total + 2 * RETAIL_RAD_PER_S) < 1e-3,
      `swept ${total.toFixed(4)} rad in 2 s, retail ${(-2 * RETAIL_RAD_PER_S).toFixed(4)} (clockwise, axis -Z)`);
    assert.ok(Math.abs(last.r - 12) < 1e-3, `ring radius ${last.r} = the clip's 12 m part offset`);
    assert.ok(Math.abs(last.z - 65) < 1e-3, `altitude ${last.z} = anchor z + the clip's 15 m`);
    // Rate is wall-clock, not frame-count: 144 Hz sweeps the same angle.
    const fast = sweep(bucket, 2, 144);
    assert.ok(Math.abs(fast.total + 2 * RETAIL_RAD_PER_S) < 1e-3, `144 Hz swept ${fast.total.toFixed(4)}`);
  } finally {
    AS.disposeAnimatedScenery();
  }
});

test("stale pkg (no setOmega getter) keeps today's hover", async () => {
  try {
    const bucket = await attach(0x02000494, 0x030006ca, null, 2);
    const { total } = sweep(bucket, 2, 60);
    assert.ok(Math.abs(total) < 1e-9, `no orbit without the getter (swept ${total})`);
  } finally {
    AS.disposeAnimatedScenery();
  }
});

test("?animSceneryOmega=off escape keeps today's hover", async () => {
  AS.__setAnimSceneryOmegaForTest?.(false);
  try {
    const bucket = await attach(0x02000493, 0x030006cb, SEAGULL_OMEGA, 3);
    const { total } = sweep(bucket, 2, 60);
    assert.ok(Math.abs(total) < 1e-9, `flag off: no orbit (swept ${total})`);
  } finally {
    AS.__setAnimSceneryOmegaForTest?.(undefined);
    AS.disposeAnimatedScenery();
  }
});

test("?animSceneryOmegaHz: default 15, a live override, clamped to [1, 60]", () => {
  try {
    assert.equal(AS.ANIM_SCENERY_OMEGA_HZ_DEFAULT, 15);
    AS.__setAnimSceneryOmegaHzForTest(30);
    assert.equal(AS.animSceneryOmegaHz(), 30);
    AS.__setAnimSceneryOmegaHzForTest(500);
    assert.equal(AS.animSceneryOmegaHz(), 60);
  } finally {
    AS.__setAnimSceneryOmegaHzForTest(undefined);
  }
  assert.equal(AS.animSceneryOmegaHz(), 15);
});

test("parseSetOmega / staticOmegaAngleStep (pure)", () => {
  if (typeof AS.parseSetOmega !== "function") assert.fail("parseSetOmega not exported (pre-fix module)");
  assert.equal(AS.parseSetOmega(undefined), null);
  assert.equal(AS.parseSetOmega(new Float32Array(0)), null, "empty getter = no hook");
  assert.equal(AS.parseSetOmega([0, 0, 0.0001]), null, "below grotate's 2e-4 threshold");
  const o = AS.parseSetOmega(SEAGULL_OMEGA);
  assert.ok(Math.abs(o.rad - 0.0383972) < 1e-6 && Math.abs(o.axis.z + 1) < 1e-6);
  assert.ok(Math.abs(AS.staticOmegaAngleStep(o, 1) - RETAIL_RAD_PER_S) < 1e-6, "the default static-update rate (15 Hz) x the retail per-tick angle");
  assert.equal(AS.staticOmegaAngleStep(o, 0), 0);
});
