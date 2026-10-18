// tests/cell_freeze_subtree.test.mjs — ?freezeStaticMatrix freezes the whole
// cell subtree (2026-10-18 review, STREAM-STATICS-4).
//
// The attach froze only each cell container (`matrixWorldAutoUpdate = false`).
// three r184's updateMatrixWorld still composes every `matrixAutoUpdate` node
// and walks into the children of a frozen one, so every wall, floor and prop of
// a cell kept recomposing and multiplying each frame.
//   Z1  default (walls-first): every node under a built cell container is
//       frozen, world matrices are right under a rotated worldRoot, and a
//       scene walk composes none of them and moves none of them
//   Z2  `?interiorWallsFirst=off` (single-stage attach): the same
//   Z3  a node parented to a frozen container after the attach (an animated
//       prop, a Setup light) still follows its own transform every walk
//   Z4  `?freezeStaticMatrix=off`: nothing frozen, the walk composes as before
//
// Drives the shipped buildEnvCellsForLandblock with fake wasm (the
// tests/interior_walls_first.test.mjs rig, statics resolved at once).
//
// Run from apps/holtburger-web/:  node tests/cell_freeze_subtree.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

globalThis.location = { search: "?noEnvcellTimeSlice=1" };
const on = await import("../scene3d/cells.js");
globalThis.location = { search: "?noEnvcellTimeSlice=1&interiorWallsFirst=off" };
const single = await import("../scene3d/cells.js?interiorWallsFirst=off");
globalThis.location = { search: "?noEnvcellTimeSlice=1&freezeStaticMatrix=off" };
const unfrozen = await import("../scene3d/cells.js?freezeStaticMatrix=off");
globalThis.location = { search: "?noEnvcellTimeSlice=1" };

const LB = 0x86020000;
const CELL_A = (LB | 0x0100) >>> 0;
const CELL_B = (LB | 0x0101) >>> 0;
const CELL_SURF = 0x08000001;
const STATIC_SURF = 0x08000002;
const STABS = [0x02000001, 0x01000007];

function triMesh(surface) {
  return {
    triCount: 1,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    uvs: new Float32Array(6),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    surfaceIndices: new Uint8Array([0]),
    surfaces: new Uint32Array([surface]),
    free() {},
  };
}
function placement(cellId, stabs, origin) {
  return {
    cellId,
    environmentId: 0x0d000001,
    cellOriginX: origin, cellOriginY: 5, cellOriginZ: 0,
    cellOrientationQw: 1, cellOrientationQx: 0, cellOrientationQy: 0, cellOrientationQz: 0,
    takePortalCellIds: () => [],
    takeMesh: () => triMesh(CELL_SURF),
    takeStaticObjects: () =>
      stabs.map((did, i) => ({ did, x: 1 + i, y: 2, z: 3, qw: 1, qx: 0, qy: 0, qz: 0, free() {} })),
    free() {},
  };
}

const MAT = new THREE.MeshBasicMaterial();
async function build(mod) {
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2; // AC Z-up → three Y-up, never walked yet
  const cellsGroup = new THREE.Group();
  worldRoot.add(cellsGroup);
  scene.add(worldRoot);
  const scene3d = {
    cellsGroup,
    scene,
    camera: new THREE.PerspectiveCamera(),
    cellContainers3d: new Map(),
    envCellLoadedLbs: new Set(),
    materialCache: {
      getCached: () => MAT,
      getCachedStaticBias: () => MAT,
      fallbackMaterial: MAT,
      async preload() {},
    },
    renderer: { compile: () => new Set() },
    landblockLru: { isParked: () => false, parkPool: new Map() },
  };
  const wasm = {
    fetchEnvCellsInLandblock: async () => [placement(CELL_A, STABS, 10), placement(CELL_B, [], 30)],
    fetch_surfaces_pixels: async () => [],
    fetch_model_meshes: async (ids) => Array.from(ids, () => triMesh(STATIC_SURF)),
  };
  const log = console.log, info = console.info, warn = console.warn;
  console.log = () => {}; console.info = () => {}; console.warn = () => {};
  try {
    const sum = await mod.buildEnvCellsForLandblock(scene3d, LB, wasm);
    assert.equal(sum.cellCount, 2);
    assert.equal(sum.staticObjectCount, 2);
  } finally {
    console.log = log; console.info = info; console.warn = warn;
  }
  for (const c of cellsGroup.children) c.visible = true; // in the render set
  return { scene, worldRoot, scene3d };
}

const subtree = (scene3d) => {
  const nodes = [];
  for (const c of scene3d.cellContainers3d.values()) c.traverse((o) => nodes.push(o));
  return nodes;
};
/** updateMatrix() calls on `nodes` during one scene walk (what renderer.render runs). */
function composesInWalk(scene, nodes) {
  const set = new Set(nodes);
  const orig = THREE.Object3D.prototype.updateMatrix;
  let n = 0;
  THREE.Object3D.prototype.updateMatrix = function () {
    if (set.has(this)) n += 1;
    return orig.call(this);
  };
  try { scene.updateMatrixWorld(); } finally { THREE.Object3D.prototype.updateMatrix = orig; }
  return n;
}
function assertWorldMatrices(w) {
  const want = new THREE.Matrix4();
  for (const c of w.scene3d.cellContainers3d.values()) {
    for (const k of c.children) {
      // Every direct child is local to the (identity) container: mesh group or prop.
      want.compose(k.position, k.quaternion, k.scale).premultiply(w.worldRoot.matrixWorld);
      assert.ok(k.matrixWorld.equals(want), `${k.name} world matrix`);
    }
  }
  assert.ok([...w.scene3d.cellContainers3d.values()].some((c) => c.children.some((k) => k.userData?.isCellStatic)),
    "props were attached");
}

async function frozenArm(mod) {
  const w = await build(mod);
  const nodes = subtree(w.scene3d);
  assert.ok(nodes.length >= 2 + 2 + 2, `cells, mesh groups, walls, props (${nodes.length})`);
  for (const o of nodes) {
    assert.equal(o.matrixAutoUpdate, false, `${o.name} matrixAutoUpdate`);
    assert.equal(o.matrixWorldAutoUpdate, false, `${o.name} matrixWorldAutoUpdate`);
  }
  assertWorldMatrices(w);
  const before = nodes.map((o) => o.matrixWorld.clone());
  assert.equal(composesInWalk(w.scene, nodes), 0, "the walk composes no frozen node");
  assert.ok(nodes.every((o, i) => o.matrixWorld.equals(before[i])), "and moves none");
  return w;
}

test("Z1 default (walls-first): the whole cell subtree is frozen with correct world matrices", async () => {
  await frozenArm(on);
});

test("Z2 ?interiorWallsFirst=off: the single-stage attach freezes the same subtree", async () => {
  await frozenArm(single);
});

test("Z3 a node parented to a frozen container later still follows its transform", async () => {
  const w = await build(on);
  const container = w.scene3d.cellContainers3d.get(CELL_A);
  const prop = new THREE.Group(); // an animated prop / a light, attached after the freeze
  const part = new THREE.Object3D();
  prop.add(part);
  container.add(prop);
  const at = new THREE.Vector3();
  for (const x of [4, 9]) {
    prop.position.set(x, 1, 2);
    part.position.set(0, 0, 1);
    w.scene.updateMatrixWorld();
    at.setFromMatrixPosition(part.matrixWorld);
    // worldRoot maps AC (x, y, z) to three (x, z, -y).
    assert.ok(Math.abs(at.x - x) < 1e-9 && Math.abs(at.y - 3) < 1e-9 && Math.abs(at.z + 1) < 1e-9,
      `part at ${at.toArray()} for prop x=${x}`);
  }
});

test("Z4 ?freezeStaticMatrix=off: nothing frozen, the walk composes every node", async () => {
  const w = await build(unfrozen);
  const nodes = subtree(w.scene3d);
  assert.ok(nodes.every((o) => o.matrixAutoUpdate === true && o.matrixWorldAutoUpdate === true));
  assert.equal(composesInWalk(w.scene, nodes), nodes.length);
  assertWorldMatrices(w);
});
