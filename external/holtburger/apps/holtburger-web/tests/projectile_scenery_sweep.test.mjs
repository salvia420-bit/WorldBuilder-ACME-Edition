// tests/projectile_scenery_sweep.test.mjs — physics-collision-3 (2026-10-13,
// `?projectileScenerySweep=off` escape, default ON).
//
// Retail moves every missile through a CTransition (acclient.c:322812), and
// procedural scenery is a STATIC shadow object (`CLandBlock::get_land_scenes`
// → `CPhysicsObj::makeObject(id, 0, 0)` → `InitObjectBegin` state |= 1,
// acclient.c:317273); ACE loads the same scenery into its server physics
// (Landblock.get_land_scenes), so its bolt stops on a trunk. The wasm
// `sweepSphereAgainstScenery` (trunk cylspheres, boulder spheres over the
// 3×3 landblock ring — cargo-tested with the camera, scene.rs
// `sweep_sphere_against_scenery`) is mocked here; this pins the JS plumbing:
//   1. sweepProjectileSegment runs the layer only with `scenery: true`, once,
//      for the start landblock (the export scans the 3×3 ring);
//   2. an OUTDOOR bolt whose scenery hit is at t = 0.5 stops short of the
//      trunk, cause `client-sweep:sweepSphereAgainstScenery`;
//   3. an INDOOR bolt never sweeps scenery; once its cell walk (wasm
//      `resolveViewerCell`) carries it out through an outside portal it does;
//   4. an ETHEREAL bolt still stops on scenery (STATIC);
//   5. the whole-AABB `sweepSphereAgainstStatics` is never used;
//   6. `?projectileScenerySweep=off` (lifted methods with the flag off): no
//      scenery layer; with the terrain crossing off too, no cell walk.
//
// Drives the REAL EntityManager spawn → tick path (mocked wasm + session
// handle), like tests/projectile_object_sweep.test.mjs.
//
// Run: node tests/projectile_scenery_sweep.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { EntityManager } from "../scene3d/entities.js";
import {
  PROJECTILE_SWEEP_RADIUS,
  projectileStopPoint,
  projectileSweepCells,
  sweepProjectileSegment,
} from "../scene3d/projectile_sweep.js";
import { installFakeMotionSequence } from "../harness/lib/fake_motion_sequence.mjs";

installFakeMotionSequence();

function partMesh() {
  return {
    triCount: 1,
    positions: new Float32Array([0, 0, 0, 0.5, 0, 0, 0.25, 0.5, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    surfaceIndices: new Uint8Array([0]),
    surfaces: new Uint32Array([0x08001234]),
  };
}

const wasmExports = {
  async fetchEntityAnimationKeyframes() {
    const meshes = [partMesh()];
    return {
      partCount: 1, numFrames: 0, framerate: 0, resolvedStance: 0x3d,
      partFrames: new Float32Array(0),
      takePartMeshes() { return meshes.splice(0); },
    };
  },
  async fetch_surfaces_pixels(dids) {
    return dids.map(() => ({ pixels: new Uint8Array(16).fill(255), width: 2, height: 2 }));
  },
  async fetchEntitySurfacesPixels(dids) {
    return dids.map(() => ({ pixels: new Uint8Array(16).fill(255), width: 2, height: 2 }));
  },
  async fetchPhysicsScript() { return null; },
  async fetchParticleEmitter() { return null; },
  async fetchBuildingPlacement() { return { partCount: 0, free() {} }; },
  async fetchSetupDefaultScript() { return 0; },
};

// Sweep mocks: `sweep.<layer>` is (from, to, radius, ...extra) → hit|null;
// every call is logged with its trailing arguments.
const sweep = { building: null, scenery: null };
const calls = [];
let freedHits = 0;
let aabbStaticsCalls = 0;
function sweepExport(layer) {
  return (fx, fy, fz, tx, ty, tz, r, ...extra) => {
    const a = { x: fx, y: fy, z: fz }, b = { x: tx, y: ty, z: tz };
    calls.push({ layer, from: a, to: b, r, extra });
    const hit = sweep[layer]?.(a, b, r, ...extra);
    return hit ? { normalX: 0, normalY: 0, normalZ: 0, ...hit, free() { freedHits += 1; } } : undefined;
  };
}

const LB_X0 = 0xa9 * 192; // boltMeta's landblock 0xA9B4 → world x origin
const R = PROJECTILE_SWEEP_RADIUS;
let physicsState = 0x28b48; // Flame Bolt: MISSILE|LIGHTING_ON|ALIGN_PATH|... (not ETHEREAL)
// The cell walk: (from, to, radius, cell) → cell. null = the stale-pkg shape.
let resolveCell = null;
const resolveCalls = [];
const sh = {
  entityIsProjectile: () => true,
  entityProjectileHasGravity: () => false,
  entityProjectileAlignsPath: () => false,
  objectPhysicsState: () => physicsState,
  terrainHeightAt: () => 0,
  entityDefaultScript: () => 0,
  entityDefaultScriptIntensity: () => 1,
  getRenderSet: () => new Uint32Array(0),
  sweepSphereAgainstBuildingMesh: sweepExport("building"),
  sweepSphereAgainstScenery: sweepExport("scenery"),
  // Whole-AABB statics sweep — must never be used for missiles.
  sweepSphereAgainstStatics: () => { aabbStaticsCalls += 1; return undefined; },
};
window.__sessionHandle = sh;
function setResolveCell(fn) {
  resolveCell = fn;
  if (fn) {
    sh.resolveViewerCell = (fx, fy, fz, tx, ty, tz, r, cell) => {
      resolveCalls.push({ to: { x: tx, y: ty, z: tz }, r, cell });
      return resolveCell({ x: fx, y: fy, z: fz }, { x: tx, y: ty, z: tz }, r, cell);
    };
  } else {
    delete sh.resolveViewerCell;
  }
}

let nextGuid = 0x80000201;
function makeManager() {
  const scene3d = {
    entitiesGroup: new THREE.Group(),
    materialCache: null,
    lighting: { lightPool: { enabled: true } },
    activeLights: [],
    quality: { preset: "high" },
  };
  return new EntityManager(scene3d, wasmExports);
}
function boltMeta(extra = {}) {
  return {
    guid: nextGuid++, modelId: 0x0200050d, mtableId: 0,
    landblockId: 0xa9b40001, x: 10, y: 10, z: 50, qw: 1, qx: 0, qy: 0, qz: 0,
    paletteId: 0, motionCommand: 0, motionStance: 0, objScale: 1, name: "Flame Bolt",
    wcid: 1499, itemType: 0, iconId: 0, physicsScriptDid: 0,
    modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0),
    subPalettes: new Uint32Array(0),
    vx: 20, vy: 0, vz: 0,
    ...extra,
  };
}
function reset() {
  sweep.building = null;
  sweep.scenery = null;
  calls.length = 0;
  resolveCalls.length = 0;
  physicsState = 0x28b48;
  setResolveCell(null);
}
/** A trunk surface at world x = `wx`, hit from -x: the sphere touches at wx - R. */
function trunkAt(wx) {
  return (a, b, r) => {
    const c = wx - r;
    if (a.x >= c || b.x < c) return null;
    return { t: (c - a.x) / (b.x - a.x), normalX: -1 };
  };
}
const tickAfter = (em, ms) => new Promise((r) => setTimeout(() => { em.tick(0.016); r(); }, ms));
const sceneryCalls = () => calls.filter((c) => c.layer === "scenery");

// The flight clock anchors at a positive receipt stamp (the seed ignores a
// non-positive one), so make "200 ms ago" positive.
while (performance.now() < 600) await new Promise((r) => setTimeout(r, 50));

test("sweepProjectileSegment: scenery layer only on request, once, start landblock", () => {
  reset();
  const a = { x: LB_X0 + 191, y: 1, z: 1 }, b = { x: LB_X0 + 193, y: 1, z: 1 };
  sweep.scenery = () => ({ t: 0.5, normalX: -1 });
  sweep.building = () => ({ t: 0.8, normalX: -1 });
  assert.equal(sweepProjectileSegment(sh, a, b, { objects: false }), 0.8, "default: no scenery layer");
  assert.equal(sceneryCalls().length, 0);
  calls.length = 0;
  const out = {};
  const freed0 = freedHits;
  assert.equal(sweepProjectileSegment(sh, a, b, { scenery: true, objects: false, out }), 0.5);
  assert.equal(out.layer, "sweepSphereAgainstScenery", "the earlier scenery hit wins");
  const sc = sceneryCalls();
  assert.equal(sc.length, 1, "one call covers the landblock crossing (3×3 ring)");
  assert.equal(sc[0].r, R);
  assert.deepEqual(sc[0].extra, [0xa9000000], "(…, radius, start landblock)");
  assert.equal(calls.filter((c) => c.layer === "building").length, 2, "building mesh still per LB");
  assert.equal(freedHits - freed0, 3, "every hit box freed");
  // Stale pkg: no scenery export — the other layers' result, no throw.
  const stale = { sweepSphereAgainstBuildingMesh: sh.sweepSphereAgainstBuildingMesh };
  assert.equal(sweepProjectileSegment(stale, a, b, { scenery: true }), 0.8);
  reset();
});

test("an outdoor bolt stops short of a trunk (scenery hit at t = 0.5)", async () => {
  reset();
  const em = makeManager();
  sweep.scenery = trunkAt(LB_X0 + 11 + R); // first substep 10 → 12: contact at t = 0.5
  const inst = await em.spawn(boltMeta({ landblockId: 0xa9b40012, recvMs: performance.now() - 200 }));
  em.tick(0.016);
  assert.equal(inst._ballistic, false, "stopped at the trunk");
  const want = projectileStopPoint({ x: LB_X0 + 10, y: 0, z: 0 }, { x: LB_X0 + 12, y: 0, z: 0 }, 0.5);
  assert.ok(Math.abs(inst.root.position.x - want.x) < 1e-6, `x ${inst.root.position.x - LB_X0}`);
  assert.equal(em._projectileStops?.at(-1)?.cause, "client-sweep:sweepSphereAgainstScenery");
  const sc = sceneryCalls();
  assert.ok(sc.length > 0, "scenery swept");
  assert.equal(sc[0].extra[0], 0xa9b40000, "the bolt's landblock");
  const xs = inst.root.position.x;
  await tickAfter(em, 20);
  assert.equal(inst.root.position.x, xs, "stays put");
  em.dispose();
  reset();
});

test("an indoor bolt never sweeps scenery (stale pkg or a walk that stays inside)", async () => {
  reset();
  let em = makeManager();
  sweep.scenery = trunkAt(LB_X0 + 12);
  const inst = await em.spawn(boltMeta({ landblockId: 0xa9b40105, recvMs: performance.now() - 200 }));
  em.tick(0.016);
  assert.equal(inst._ballistic, true, "flies on");
  assert.equal(sceneryCalls().length, 0, "no scenery layer indoors");
  assert.equal(inst._ballisticCellId, 0xa9b40105, "cell unchanged without the walk export");
  em.dispose();
  reset();
  em = makeManager();
  setResolveCell((a, b, r, cell) => cell); // the walk keeps it in its room
  sweep.scenery = trunkAt(LB_X0 + 12);
  const inst2 = await em.spawn(boltMeta({ landblockId: 0xa9b40105, recvMs: performance.now() - 200 }));
  em.tick(0.016);
  assert.equal(inst2._ballistic, true);
  assert.equal(sceneryCalls().length, 0);
  assert.ok(resolveCalls.length > 0, "the cell walk ran");
  assert.equal(resolveCalls[0].cell, 0xa9b40105, "walked from the bolt's own cell");
  assert.equal(resolveCalls[0].r, R);
  em.dispose();
  reset();
});

test("an indoor bolt that leaves through an outside portal gains the scenery layer", async () => {
  reset();
  const em = makeManager();
  // The doorway at local x = 11: past it the walk lands in outdoor cell 0x11.
  setResolveCell((a, b, r, cell) => ((cell & 0xffff) >= 0x100 && b.x > LB_X0 + 11 ? 0xa9b40011 : cell));
  sweep.scenery = trunkAt(LB_X0 + 13);
  const inst = await em.spawn(boltMeta({ landblockId: 0xa9b40105, recvMs: performance.now() - 300 }));
  em.tick(0.016);
  assert.equal(inst._ballisticCellId, 0xa9b40011, "carried outdoors");
  assert.ok(sceneryCalls().length > 0, "scenery swept once outside");
  assert.equal(inst._ballistic, false, "stopped at the trunk outside the door");
  assert.equal(em._projectileStops?.at(-1)?.cause, "client-sweep:sweepSphereAgainstScenery");
  assert.ok(Math.abs(inst.root.position.x - (LB_X0 + 13 - R - 0.05)) < 1e-6, `x ${inst.root.position.x - LB_X0}`);
  // The walk ran once (the exit substep) and stops once the bolt is outdoors.
  assert.equal(resolveCalls.length, 1, "walked only while indoors");
  assert.equal(resolveCalls[0].cell, 0xa9b40105);
  em.dispose();
  reset();
});

test("an ETHEREAL bolt still stops on scenery (scenery is STATIC)", async () => {
  reset();
  const em = makeManager();
  physicsState = 0x28b48 | 0x4;
  sweep.scenery = trunkAt(LB_X0 + 12);
  const inst = await em.spawn(boltMeta({ recvMs: performance.now() - 200 }));
  em.tick(0.016);
  assert.equal(inst._ballistic, false, "stopped");
  assert.equal(em._projectileStops?.at(-1)?.cause, "client-sweep:sweepSphereAgainstScenery");
  em.dispose();
  reset();
});

test("the whole-AABB statics sweep is never used", () => {
  assert.equal(aabbStaticsCalls, 0);
});

// ---- `?projectileScenerySweep=off`: the step + cell walk, lifted ------------
const SRC = readFileSync(new URL("../scene3d/entities.js", import.meta.url), "utf8");
function methodSource(name) {
  const start = SRC.indexOf(`\n  ${name}(`);
  assert.ok(start >= 0, `method ${name} not found`);
  const i = SRC.indexOf("{", SRC.indexOf(")", start));
  let depth = 0;
  for (let j = i; j < SRC.length; j += 1) {
    if (SRC[j] === "{") depth += 1;
    else if (SRC[j] === "}" && --depth === 0) return SRC.slice(start + 1, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
}
const makeHarness = (sceneryOn, crossingOn) => new Function(
  "sweepProjectileSegment",
  "projectileSweepCells",
  "projectileStopPoint",
  "PROJECTILE_SWEEP_RADIUS",
  `
  const PROJECTILE_SCENERY_SWEEP_ON = ${sceneryOn};
  const PROJECTILE_TERRAIN_CROSSING_ON = ${crossingOn};
  const PROJECTILE_TERRAIN_STOP_ON = true;
  const PROJECTILE_TERRAIN_STOP_EPS = 0.25;
  const _terrainZAt = () => 0;
  return class {
    ${methodSource("_sweepBallisticStep")}
    ${methodSource("_projectileTrackCell")}
    _buildProjectileSweepCtx() {
      return { sh: window.__sessionHandle, renderSet: null, entities: false, objects: false };
    }
    _projectileObjectSweepOpts() { return { ethereal: false, exemptLocalPlayer: true }; }
  };
`,
)(sweepProjectileSegment, projectileSweepCells, projectileStopPoint, PROJECTILE_SWEEP_RADIUS);

function liftedBolt(cellId) {
  return {
    guid: 0x80000001,
    _ballisticCellId: cellId,
    root: { position: { x: LB_X0 + 12, y: 10, z: 1 } },
  };
}

test("?projectileScenerySweep=off: no scenery layer (legacy)", () => {
  for (const [on, expect] of [[false, 0], [true, 1]]) {
    reset();
    const H = makeHarness(on, true);
    const h = new H();
    h._sweepBallisticStep(liftedBolt(0xa9b40001), LB_X0 + 10, 10, 1);
    assert.equal(sceneryCalls().length, expect, `scenery calls (flag ${on})`);
  }
  reset();
});

test("both flags off: an indoor bolt's cell is never walked (legacy)", () => {
  reset();
  setResolveCell(() => 0xa9b40011);
  const off = new (makeHarness(false, false))();
  const inst = liftedBolt(0xa9b40105);
  off._projectileTrackCell(inst, LB_X0 + 10, 10, 1);
  assert.equal(resolveCalls.length, 0, "no walk");
  assert.equal(inst._ballisticCellId, 0xa9b40105);
  // Either flag on: walked, carried outdoors.
  const on = new (makeHarness(true, false))();
  on._projectileTrackCell(inst, LB_X0 + 10, 10, 1);
  assert.equal(resolveCalls.length, 1);
  assert.equal(inst._ballisticCellId, 0xa9b40011);
  assert.equal(inst._ballisticTerrainOk, undefined, "terrain arming belongs to the crossing flag");
  // An outdoor bolt is never walked.
  on._projectileTrackCell(inst, LB_X0 + 10, 10, 1);
  assert.equal(resolveCalls.length, 1);
  reset();
});
