// tests/anim_scenery_unbake.test.mjs — ?animSceneryUnbake (2026-10-23, default ON).
//
// THE BUG (owner on the 1070, landblock 0x8093 at 16.0N 0.8E): the windmill's
// four sail boards floated detached at odd angles round the stone tower. The
// part meshes from fetchBuildingPlacement / the HBG1 bundle carry the part's
// static frame B BAKED into their vertices, and a DAT Animation part frame A(t)
// is ABSOLUTE in setup space (retail CPartArray::UpdateParts, acclient.c:326601:
// part = Frame::combine(objectFrame, animFrame[i]) over part-LOCAL vertices).
// animated_scenery.js drew N * A(t) * (B * v) — the frame applied twice. The fix
// draws N * A(t) * U * (B * v) with U = inverse(B).
//
// Fixture = the REAL DAT records (client_portal.dat / client_cell_1.dat, read
// 2026-10-23 with WorldBuilder.Terminal chorizite-parse-dat-record):
//   LandBlockInfo 0x8093FFFE objects: Setup 0x020003E5 (windmill sails) at
//     (136.138, 59.6816, 135.75) q(w,x,y,z)=(-0.73373,0,0,-0.679441) and
//     (118.138, 175.339, 215.75) q=(-0.247422,0,0,-0.968908).
//   Setup 0x020003E5: parts [0x010010CB sail, 0x010010C7 hub, 3x 0x010010CB],
//     Default placement only, no MotionTable, defaultAnimation 0x0300061B.
//   Animation 0x0300061B: 5 parts x 60 frames, 1.5 deg about the hub (+Y) axis
//     per frame; frames 0-3 below.
// The probe triangle per sail is a board spanning the part's local X (the real
// GfxObj vertices are not needed: the transforms are what is under test).
// THE BAKE FRAME is what walk_setup_parts really bakes (verifier 2026-10-24):
// its idle frame (lib.rs try_resolve_idle_anim_frame_with_override) falls back
// — path 2, no MotionTable — to setup.default_animation's FRAME 0, which wins
// over the placement chain. So the windmill's parts are baked at anim 0x0300061B
// frame 0 (Default rotated 1.5 deg), not at Default. The butterfly 0x02000493
// (anim 0x030006CB) is where the difference is large: frame 0 sits 8.6 m /
// 180 deg from its Default placement, so undoing the placement tore its wings
// apart (test 8).
//
// Locks:
//   1. every path (GPU-posed instanced, CPU instanced, legacy per-mesh) draws
//      each part at N * A(t) * v_local, frame by frame;
//   2. the rest pose before the first tick is the static frozen pose (N * B * v);
//   3. `=off` reproduces the owner's still: the four sails parallel, one parked
//      on the hub, the others 7.6 / 7.6 / 10.7 m out (and with the fix: a cross
//      at 5.35 m);
//   4. identity-bake setups are untouched (same rows, same matrices);
//   5. the live shape (no fetchSetupPartPose) undoes the default animation's
//      frame 0, never the placement; fetchSetupPartPose wins when present;
//      below the anim frame: 0x65 placement, skipped under placementId=off;
//   6. two setups on one animation DID with different bake frames get their
//      own GPU rows and both draw right;
//   7. partUnbakeMatrix: inverse, null for identity / flag off;
//   8. the real butterfly 0x02000493 (frame 0 8.6 m / 180 deg from Default)
//      stays in one piece on every path.
//
// Run from apps/holtburger-web/:  node tests/anim_scenery_unbake.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.requestAnimationFrame ??= () => 1;
globalThis.window.cancelAnimationFrame ??= () => {};

const THREE = await import("three");
const AS = await import("../scene3d/animated_scenery.js");
const GPU = await import("../scene3d/anim_scenery_gpu.js");

const SETUP = 0x020003e5;
const ANIM = 0x0300061b;
const LB = 0x80930000;

// Setup 0x020003E5 Default placement: [ox, oy, oz, qw, qx, qy, qz] per part.
const DEFAULT_FRAMES = [
  [2.04, 0.41, -4.95, 0.707107, 0, -0.707107, 0],
  [0, 0, 0, 1, 0, 0, 0],
  [-4.95, 0.41, -2.04, 1, 0, 0, 0],
  [-2.04, 0.41, 4.95, 0.707107, 0, 0.707107, 0],
  [4.95, 0.41, 2.04, -4.37114e-08, 0, -1, 0],
];
// Animation 0x0300061B frames 0-3 (5 parts each), same layout.
const ANIM_FRAMES = [
  [[1.90973, 0.41, -5.0017, 0.716302, 0, -0.69779, 0], [0, 0, 0, 0.999914, 0, 0.0130896, 0], [-5.00171, 0.41, -1.90972, 0.999914, 0, 0.0130896, 0], [-1.90973, 0.41, 5.0017, 0.69779, 0, 0.716302, 0], [5.0017, 0.41, 1.90973, 0.0130896, 0, -0.999914, 0]],
  [[1.77814, 0.41, -5.04998, 0.725374, 0, -0.688355, 0], [0, 0, 0, 0.999657, 0, 0.0261769, 0], [-5.04998, 0.41, -1.77814, 0.999657, 0, 0.0261769, 0], [-1.77814, 0.41, 5.04998, 0.688355, 0, 0.725374, 0], [5.04998, 0.41, 1.77814, 0.0261769, 0, -0.999657, 0]],
  [[1.64534, 0.41, -5.09479, 0.734322, 0, -0.678801, 0], [0, 0, 0, 0.999229, 0, 0.0392598, 0], [-5.0948, 0.41, -1.64534, 0.999229, 0, 0.0392598, 0], [-1.64534, 0.41, 5.0948, 0.678801, 0, 0.734322, 0], [5.0948, 0.41, 1.64534, 0.0392598, 0, -0.999229, 0]],
  [[1.51141, 0.41, -5.13612, 0.743145, 0, -0.669131, 0], [0, 0, 0, 0.99863, 0, 0.052336, 0], [-5.13612, 0.41, -1.51141, 0.99863, 0, 0.052336, 0], [-1.51141, 0.41, 5.13612, 0.669131, 0, 0.743145, 0], [5.13612, 0.41, 1.51141, 0.0523359, 0, -0.99863, 0]],
];
// What the wasm bakes into the windmill's part vertices: the default
// animation's frame 0 (see the header).
const BAKE = ANIM_FRAMES[0];
// Butterfly Setup 0x02000493 (client_portal.dat, 2026-10-24): 2 parts, Default
// placement only, no MotionTable, defaultAnimation 0x030006CB (90 frames,
// SetOmega hook); Default vs anim frames 0-3.
const BFLY = 0x02000493;
const BFLY_ANIM = 0x030006cb;
const BFLY_DEFAULT = [
  [-4.9084e-07, -5.61455, 1.345, -0.679715, -0.194905, 0.194905, -0.679715],
  [-4.9084e-07, -5.61455, 1.345, -0.196092, -0.679373, 0.679373, -0.196092],
];
const BFLY_FRAMES = [
  [[0, 2.99995, 1.72397, 0.704194, -0.0641143, -0.0641143, -0.704194], [0, 2.99995, 1.72397, 0.101246, -0.699821, -0.699821, -0.101246]],
  [[0, 2.99995, 1.72095, 0.704132, -0.0647921, -0.0647921, -0.704132], [0, 2.99995, 1.72095, 0.0971436, -0.700402, -0.700402, -0.0971436]],
  [[0, 2.99995, 1.716, 0.704067, -0.065498, -0.065498, -0.704067], [0, 2.99995, 1.716, 0.0928675, -0.700982, -0.700982, -0.0928675]],
  [[0, 2.99995, 1.70921, 0.703999, -0.0662243, -0.0662243, -0.703999], [0, 2.99995, 1.70921, 0.0884637, -0.701551, -0.701551, -0.0884637]],
];
const ANIMS = new Map([[ANIM, ANIM_FRAMES], [BFLY_ANIM, BFLY_FRAMES]]);
const PLACEMENTS = [
  { x: 136.138, y: 59.6816, z: 135.75, qw: -0.73373, qx: 0, qy: 0, qz: -0.679441 },
  { x: 118.138, y: 175.339, z: 215.75, qw: -0.247422, qx: 0, qy: 0, qz: -0.968908 },
];
// Probe board in part-LOCAL space (long axis = local X).
const LOCAL_TRI = [new THREE.Vector3(-4, 0, -1.2), new THREE.Vector3(4, 0, -1.2), new THREE.Vector3(4, 0, 1.2)];

const UNIT = new THREE.Vector3(1, 1, 1);
function frameMat(f) {
  const q = new THREE.Quaternion(f[4], f[5], f[6], f[3]).normalize();
  return new THREE.Matrix4().compose(new THREE.Vector3(f[0], f[1], f[2]), q, UNIT);
}
function nodeMat(p) {
  const pos = new THREE.Vector3(((LB >>> 24) & 0xff) * 192 + p.x, ((LB >>> 16) & 0xff) * 192 + p.y, p.z);
  return new THREE.Matrix4().compose(pos, new THREE.Quaternion(p.qx, p.qy, p.qz, p.qw), UNIT);
}

/** The wasm side: part meshes BAKED with `bakeFrames` (like walk_setup_parts). */
function bakedTri(bakeFrame) {
  const m = frameMat(bakeFrame);
  const pos = [];
  for (const v of LOCAL_TRI) { const w = v.clone().applyMatrix4(m); pos.push(w.x, w.y, w.z); }
  return {
    triCount: 1,
    positions: new Float32Array(pos),
    uvs: new Float32Array(6),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    surfaceIndices: new Uint8Array([0]),
    surfaces: new Uint32Array([0x08000010]),
  };
}
function wasmFor(setups, { withPose = true, withPlacement = false } = {}) {
  // setups: Map setupId -> { bake: frames[], hinge: frames[], placements?: {key: frames[]} }
  const w = {
    async fetchAnimation(did) {
      const frames = ANIMS.get(did >>> 0) || ANIM_FRAMES;
      const flat = [];
      for (const fr of frames) for (const p of fr) flat.push(...p);
      return { numParts: frames[0].length, numFrames: frames.length, flags: 0, frames: new Float32Array(flat), free() {} };
    },
    async fetchBuildingPlacement(id) {
      const s = setups.get(id >>> 0);
      return {
        partCount: s.bake.length,
        takePartMeshes: () => s.bake.map((f) => bakedTri(f)),
        takePartHingeFrames: () => s.hinge.map((f) => ({ x: f[0], y: f[1], z: f[2], qw: f[3], qx: f[4], qy: f[5], qz: f[6] })),
        free() {},
      };
    },
    fetch_surfaces_pixels: async () => [],
  };
  if (withPose) w.fetchSetupPartPose = async (id) => new Float32Array(setups.get(id >>> 0).bake.flat());
  // The export index.html DOES plumb live: requested key -> 0 -> first (lib.rs
  // collect_setup_placement_frames), wasm-bindgen objects with free().
  if (withPlacement) {
    w.fetchSetupPlacementFrames = async (id, key) => {
      const s = setups.get(id >>> 0);
      const table = s.placements || { 0: s.hinge };
      const frames = table[key] || table[0] || Object.values(table)[0] || [];
      return {
        takeFrames: () => frames.map((f, i) => ({ partIndex: i, ox: f[0], oy: f[1], oz: f[2], qw: f[3], qx: f[4], qy: f[5], qz: f[6], free() {} })),
        free() {},
      };
    };
  }
  return w;
}

function placementsFor(setupId, list = PLACEMENTS, anim = ANIM) {
  return list.map((p, i) => ({ objId: setupId, defaultAnimationId: anim, landblockId: LB, sourceObjIdx: i + 1 + (setupId & 0xff) * 10, ...p }));
}

/**
 * Build + return a function `drawn(setupId, placementIdx, part) -> Matrix4`
 * giving the matrix the part's BAKED vertices are drawn with.
 */
async function build({ path, unbake = true, setups, placements, withPose = true, withPlacement = false }) {
  AS.disposeAnimatedScenery();
  AS.__setAnimSceneryUnbakeForTest(unbake);
  GPU.__setAnimSceneryGpuForTest(path === "gpu");
  const scene = new THREE.Scene();
  const scene3d = {
    staticsGroup: new THREE.Group(),
    materialCache: { get: async () => new THREE.MeshStandardMaterial() },
  };
  scene.add(scene3d.staticsGroup);
  const cell = new THREE.Group();
  scene.add(cell);
  const opts = path === "legacy" ? { resolveParent: () => cell } : {};
  const r = await AS.attachAnimatedScenery(scene3d, placements, wasmFor(setups, { withPose, withPlacement }), opts);
  assert.equal(r.built, placements.length, `${path}: all placements built`);
  const m = new THREE.Matrix4();
  const drawn = (setupId, k, part) => {
    if (path === "legacy") {
      scene.updateMatrixWorld(true);
      const nodes = cell.children.filter((n) => n.name === `anim-scenery-0x${setupId.toString(16)}`);
      const mesh = nodes[k].children[part].children[0];
      return mesh.matrixWorld.clone();
    }
    const b = scene3d.staticsGroup.children.find((o) => o.isInstancedMesh && o.name === `anim-inst-0x${setupId.toString(16)}-p${part}-g0`);
    return AS.animSceneryEffectiveMatrixAt(b, k, m).clone();
  };
  return { drawn, scene3d };
}

function maxErr(drawnMat, expectedMat, bakeFrame) {
  // Compare where the BAKED vertices land vs where the LOCAL vertices should be.
  const bm = frameMat(bakeFrame);
  let e = 0;
  for (const v of LOCAL_TRI) {
    const baked = v.clone().applyMatrix4(bm);
    const got = baked.applyMatrix4(drawnMat);
    const want = v.clone().applyMatrix4(expectedMat);
    e = Math.max(e, got.distanceTo(want));
  }
  return e;
}

const WINDMILL = new Map([[SETUP, { bake: BAKE, hinge: DEFAULT_FRAMES }]]);
const PATHS = ["gpu", "cpu", "legacy"];

test("1. every path draws N * A(t) * v_local, frame by frame (real windmill data)", async () => {
  for (const path of PATHS) {
    const { drawn } = await build({ path, setups: WINDMILL, placements: placementsFor(SETUP) });
    let worst = 0;
    for (let f = 0; f < ANIM_FRAMES.length; f++) {
      AS.tickAnimatedScenery(f === 0 ? 0 : 1 / 30);
      for (let k = 0; k < PLACEMENTS.length; k++) {
        const N = nodeMat(PLACEMENTS[k]);
        for (let j = 0; j < 5; j++) {
          const want = N.clone().multiply(frameMat(ANIM_FRAMES[f][j]));
          worst = Math.max(worst, maxErr(drawn(SETUP, k, j), want, BAKE[j]));
        }
      }
    }
    assert.ok(worst < 5e-3, `${path}: max vertex error ${worst} m (float32 at ~25 km)`);
  }
});

test("2. before the first tick a part shows its static frozen pose", async () => {
  for (const path of PATHS) {
    const { drawn } = await build({ path, setups: WINDMILL, placements: placementsFor(SETUP) });
    let worst = 0;
    for (let k = 0; k < PLACEMENTS.length; k++) {
      const N = nodeMat(PLACEMENTS[k]);
      for (let j = 0; j < 5; j++) {
        const want = N.clone().multiply(frameMat(BAKE[j]));
        worst = Math.max(worst, maxErr(drawn(SETUP, k, j), want, BAKE[j]));
      }
    }
    assert.ok(worst < 5e-3, `${path}: rest pose error ${worst} m`);
  }
});

/** Sail centre radius from the hub + board long axis, in SETUP space (x,z plane). */
function sailLayout(drawn, k) {
  const Ninv = nodeMat(PLACEMENTS[k]).invert();
  const out = [];
  for (const j of [0, 2, 3, 4]) {
    const M = Ninv.clone().multiply(drawn(SETUP, k, j));
    const bm = frameMat(BAKE[j]);
    const pts = LOCAL_TRI.map((v) => v.clone().applyMatrix4(bm).applyMatrix4(M));
    // Board centre = midpoint of the long edge's centre line (x = 0 in local).
    const centre = pts[0].clone().add(pts[2]).multiplyScalar(0.5);
    const axis = pts[1].clone().sub(pts[0]).normalize();
    out.push({ j, r: Math.hypot(centre.x, centre.z), axis });
  }
  return out;
}

test("3. =off reproduces the owner's still; on = a cross on the hub", async () => {
  for (const path of PATHS) {
    // OFF: the doubled frame.
    let b = await build({ path, unbake: false, setups: WINDMILL, placements: placementsFor(SETUP) });
    AS.tickAnimatedScenery(0);
    const off = sailLayout(b.drawn, 0);
    const radiiOff = off.map((s) => s.r).sort((x, y) => x - y);
    // Real bake (anim frame 0) under frame 0, doubled: 0.14 / 7.47 / 7.67 / 10.71 m.
    assert.ok(radiiOff[0] < 0.2, `${path} off: one sail parked on the hub (${radiiOff[0].toFixed(2)} m)`);
    assert.ok(Math.abs(radiiOff[1] - 7.47) < 0.05 && Math.abs(radiiOff[2] - 7.67) < 0.05 && Math.abs(radiiOff[3] - 10.71) < 0.05,
      `${path} off: 7.5 / 7.7 / 10.7 m (${radiiOff.map((r) => r.toFixed(2))})`);
    for (const s of off) {
      assert.ok(Math.abs(Math.abs(s.axis.dot(off[0].axis)) - 1) < 1e-3, `${path} off: all four boards parallel`);
    }
    // ON: the cross.
    b = await build({ path, unbake: true, setups: WINDMILL, placements: placementsFor(SETUP) });
    AS.tickAnimatedScenery(0);
    const on = sailLayout(b.drawn, 0);
    for (const s of on) assert.ok(Math.abs(s.r - 5.35) < 0.02, `${path} on: sail ${s.j} at 5.35 m (${s.r.toFixed(3)})`);
    // Adjacent sails (0 -> 4 -> 3 -> 2 round the hub) are perpendicular.
    const ax = Object.fromEntries(on.map((s) => [s.j, s.axis]));
    assert.ok(Math.abs(ax[0].dot(ax[4])) < 1e-3 && Math.abs(ax[4].dot(ax[3])) < 1e-3 && Math.abs(ax[3].dot(ax[2])) < 1e-3,
      `${path} on: boards form a cross`);
  }
});

test("4. identity-bake setups are untouched (rows + matrices identical to =off)", async () => {
  const ID = [0, 0, 0, 1, 0, 0, 0];
  const plain = new Map([[0x02000777, { bake: [ID, ID, ID, ID, ID], hinge: [ID, ID, ID, ID, ID] }]]);
  const snap = async (unbake, path) => {
    const { drawn } = await build({ path, unbake, setups: plain, placements: placementsFor(0x02000777) });
    AS.tickAnimatedScenery(0);
    AS.tickAnimatedScenery(1 / 30);
    const out = [];
    for (let k = 0; k < PLACEMENTS.length; k++) for (let j = 0; j < 5; j++) out.push(...drawn(0x02000777, k, j).elements);
    return { out, rows: GPU.animSceneryGpuDiag().rows, unbakeParts: AS.animatedScenerySetupDiag(0x02000777).unbakeParts };
  };
  for (const path of PATHS) {
    const a = await snap(true, path);
    const b = await snap(false, path);
    assert.deepEqual(a.out, b.out, `${path}: identical drawn matrices`);
    assert.equal(a.rows, b.rows, `${path}: same GPU row count`);
    assert.deepEqual(a.unbakeParts, [false, false, false, false, false]);
  }
});

test("5. bake-frame sources: live = anim frame 0 (not the placement); fetchSetupPartPose wins; chain order", async () => {
  // (a) the LIVE shape — index.html plumbs fetchSetupPlacementFrames but not
  // fetchSetupPartPose. The windmill has only a Default placement, yet the wasm
  // baked anim frame 0 (Default + 1.5 deg): that frame must be undone.
  const live = new Map([[SETUP, { bake: BAKE, hinge: DEFAULT_FRAMES, placements: { 0: DEFAULT_FRAMES } }]]);
  const src0 = { ...AS.animatedSceneryDiag().unbake.poseSource };
  for (const path of PATHS) {
    const { drawn } = await build({ path, setups: live, placements: placementsFor(SETUP), withPose: false, withPlacement: true });
    AS.tickAnimatedScenery(0);
    AS.tickAnimatedScenery(1 / 30);
    let worst = 0;
    const N = nodeMat(PLACEMENTS[0]);
    for (let j = 0; j < 5; j++) {
      worst = Math.max(worst, maxErr(drawn(SETUP, 0, j), N.clone().multiply(frameMat(ANIM_FRAMES[1][j])), BAKE[j]));
    }
    assert.ok(worst < 5e-3, `${path} live shape, anim frame 0 undone: ${worst} m`);
  }
  const src = AS.animatedSceneryDiag().unbake.poseSource;
  assert.ok(src.anim0 > src0.anim0 && src.placement65 === src0.placement65,
    `live source is the anim frame, never the placement (${JSON.stringify(src)})`);
  // (b) fetchSetupPartPose (the exact walk_setup_parts frame) wins over every
  // other source — here a frame that is neither the anim frame nor the hinge.
  const resting = DEFAULT_FRAMES.map((f) => [f[0] + 0.3, f[1] - 0.2, f[2] + 0.5, ...(() => {
    const q = new THREE.Quaternion(f[4], f[5], f[6], f[3]).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.4));
    return [q.w, q.x, q.y, q.z];
  })()]);
  const differ = new Map([[SETUP, { bake: resting, hinge: DEFAULT_FRAMES, placements: { 0x65: DEFAULT_FRAMES, 0: DEFAULT_FRAMES } }]]);
  for (const path of PATHS) {
    const { drawn } = await build({ path, setups: differ, placements: placementsFor(SETUP), withPlacement: true });
    AS.tickAnimatedScenery(0);
    AS.tickAnimatedScenery(1 / 30);
    let worst = 0;
    const N = nodeMat(PLACEMENTS[1]);
    for (let j = 0; j < 5; j++) {
      worst = Math.max(worst, maxErr(drawn(SETUP, 1, j), N.clone().multiply(frameMat(ANIM_FRAMES[1][j])), resting[j]));
    }
    assert.ok(worst < 5e-3, `${path} fetchSetupPartPose wins: ${worst} m`);
  }
  // (c) the chain below the anim frame (no fetchAnimation for this DID): the
  // 0x65 placement under the default-on placementId, skipped under
  // placementId=off (null -> the hinge in partUnbakeMatrix).
  AS.disposeAnimatedScenery();
  AS.__setAnimSceneryUnbakeForTest(true);
  const placementOnly = {
    fetchSetupPlacementFrames: async () => ({
      takeFrames: () => resting.map((f, i) => ({ partIndex: i, ox: f[0], oy: f[1], oz: f[2], qw: f[3], qx: f[4], qy: f[5], qz: f[6], free() {} })),
      free() {},
    }),
  };
  const p65 = await AS.__fetchBakePoseForTest(SETUP, placementOnly, ANIM);
  assert.ok(p65 && p65.length === 35 && Math.abs(p65[0] - resting[0][0]) < 1e-6, "0x65 placement frames when no anim frame is available");
  AS.disposeAnimatedScenery();
  const prevSearch = globalThis.window.location.search;
  globalThis.window.location.search = "?placementId=off";
  try {
    assert.equal(await AS.__fetchBakePoseForTest(SETUP, placementOnly, ANIM), null, "placementId=off skips the 0x65 lookup");
  } finally {
    globalThis.window.location.search = prevSearch;
    AS.disposeAnimatedScenery();
  }
});

test("6. two setups on one DID with different bake frames: own GPU rows, both right", async () => {
  const OTHER = 0x020003e6;
  const shifted = DEFAULT_FRAMES.map((f) => [f[0] * 0.5, f[1], f[2] * 0.5, f[3], f[4], f[5], f[6]]);
  const both = new Map([[SETUP, { bake: DEFAULT_FRAMES, hinge: DEFAULT_FRAMES }], [OTHER, { bake: shifted, hinge: shifted }]]);
  const placements = [...placementsFor(SETUP, [PLACEMENTS[0]]), ...placementsFor(OTHER, [PLACEMENTS[1]])];
  const { drawn, scene3d } = await build({ path: "gpu", setups: both, placements });
  AS.tickAnimatedScenery(0);
  AS.tickAnimatedScenery(2 / 30);
  const rowsOf = (sid) => scene3d.staticsGroup.children
    .filter((o) => o.isInstancedMesh && o.name.startsWith(`anim-inst-0x${sid.toString(16)}-`))
    .map((o) => o.userData.animGpuRow);
  const a = rowsOf(SETUP), b = rowsOf(OTHER);
  // Part 1 (identity bake in both) may share its row; every unbaked part must not.
  const shared = a.filter((r) => b.includes(r));
  assert.ok(shared.length <= 1, `only the identity hub row may be shared (shared ${shared})`);
  let worst = 0;
  for (const [sid, frames, k] of [[SETUP, DEFAULT_FRAMES, 0], [OTHER, shifted, 0]]) {
    const N = nodeMat(sid === SETUP ? PLACEMENTS[0] : PLACEMENTS[1]);
    for (let j = 0; j < 5; j++) {
      worst = Math.max(worst, maxErr(drawn(sid, k, j), N.clone().multiply(frameMat(ANIM_FRAMES[2][j])), frames[j]));
    }
  }
  assert.ok(worst < 5e-3, `both setups right: ${worst} m`);
});

test("7. partUnbakeMatrix: inverse of the bake frame, null for identity / off", () => {
  AS.__setAnimSceneryUnbakeForTest(true);
  const pose = new Float32Array(DEFAULT_FRAMES.flat());
  const u0 = AS.partUnbakeMatrix(pose, null, 0);
  const prod = frameMat(DEFAULT_FRAMES[0]).multiply(u0);
  const I = new THREE.Matrix4();
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(prod.elements[i] - I.elements[i]) < 1e-5, "B * U = I");
  assert.equal(AS.partUnbakeMatrix(pose, null, 1), null, "hub at the origin: nothing to undo");
  const h = { x: 2.04, y: 0.41, z: -4.95, qw: 0.707107, qx: 0, qy: -0.707107, qz: 0 };
  const uh = AS.partUnbakeMatrix(null, h, 0);
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(uh.elements[i] - u0.elements[i]) < 1e-5, "hinge fallback = same U");
  assert.equal(AS.partUnbakeMatrix(null, null, 0), null, "no frame at all");
  AS.__setAnimSceneryUnbakeForTest(false);
  assert.equal(AS.partUnbakeMatrix(pose, h, 0), null, "flag off");
  AS.__setAnimSceneryUnbakeForTest(undefined);
  AS.disposeAnimatedScenery();
  GPU.__setAnimSceneryGpuForTest(undefined);
});

test("8. real butterfly 0x02000493: anim frame 0 sits 8.6 m / 180 deg from Default — the live path keeps its wings together", async () => {
  // The wasm bakes anim 0x030006CB frame 0; undoing the Default placement
  // instead (the pre-verifier live source) put each wing ~10 m off its pose and
  // the two wings up to ~17 m apart.
  const bfly = new Map([[BFLY, { bake: BFLY_FRAMES[0], hinge: BFLY_DEFAULT, placements: { 0: BFLY_DEFAULT } }]]);
  for (const path of PATHS) {
    const { drawn } = await build({ path, setups: bfly, placements: placementsFor(BFLY, PLACEMENTS, BFLY_ANIM), withPose: false, withPlacement: true });
    let worst = 0;
    for (let f = 0; f < BFLY_FRAMES.length; f++) {
      AS.tickAnimatedScenery(f === 0 ? 0 : 1 / 30);
      for (let k = 0; k < PLACEMENTS.length; k++) {
        const N = nodeMat(PLACEMENTS[k]);
        for (let j = 0; j < 2; j++) {
          worst = Math.max(worst, maxErr(drawn(BFLY, k, j), N.clone().multiply(frameMat(BFLY_FRAMES[f][j])), BFLY_FRAMES[0][j]));
        }
      }
    }
    assert.ok(worst < 5e-3, `${path}: butterfly drawn at N * A(t) * v (${worst} m)`);
  }
  // The placement-based U this replaces is far off on the same data.
  AS.__setAnimSceneryUnbakeForTest(true);
  const wrongU = AS.partUnbakeMatrix(null, { x: BFLY_DEFAULT[0][0], y: BFLY_DEFAULT[0][1], z: BFLY_DEFAULT[0][2],
    qw: BFLY_DEFAULT[0][3], qx: BFLY_DEFAULT[0][4], qy: BFLY_DEFAULT[0][5], qz: BFLY_DEFAULT[0][6] }, 0);
  const wrong = frameMat(BFLY_FRAMES[1][0]).multiply(wrongU);
  assert.ok(maxErr(wrong, frameMat(BFLY_FRAMES[1][0]), BFLY_FRAMES[0][0]) > 5, "undoing Default would misplace the wing by metres");
  AS.__setAnimSceneryUnbakeForTest(undefined);
  AS.disposeAnimatedScenery();
  GPU.__setAnimSceneryGpuForTest(undefined);
});
