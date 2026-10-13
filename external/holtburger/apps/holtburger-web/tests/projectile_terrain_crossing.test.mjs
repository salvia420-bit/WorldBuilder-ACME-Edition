// tests/projectile_terrain_crossing.test.mjs — physics-collision-3
// (2026-10-13, `?projectileTerrainCrossing=off` escape, default ON).
//
// Retail tests a missile against the terrain inside every quantum's
// transition (`CLandCell::find_env_collisions`, acclient.c:354992). The
// PROJ-VIS client terrain stop tested only the frame's END point, after the
// substep loop: a fast bolt tunnelled a ridge thinner than a frame, and the
// stop snapped to the ground at the overshot xy. And it armed only for an
// outdoor launch, so a bolt fired out of a doorway flew through hills —
// retail's mover gains the land cells once its sphere crosses an outside
// portal (`CEnvCell::find_transit_cells` → `add_all_outside_cells`,
// acclient.c:348250). Pins:
//   1. pure `projectileTerrainCrossing`: the first crossing of a ridge
//      thinner than one substep, z on the surface; a bolt within the 0.25 m
//      tolerance is not stopped; a bracket already under the surface stops
//      at its start; unknown terrain never stops; one terrain sample for a
//      60 fps step;
//   2. the REAL EntityManager tick: a fast bolt stops at the ridge's near
//      flank (cause `client-terrain`), a skimming bolt flies on;
//   3. an indoor-launched bolt arms the stop once the cell walk (wasm
//      `resolveViewerCell`) carries it out of the door, and stops on the
//      hill outside; a stale pkg (no walk) keeps the legacy no-stop;
//   4. `?projectileTerrainCrossing=off` (the tick + helpers lifted with the
//      flag off) is the legacy per-frame end-point test, which misses the
//      ridge.
//
// Run: node tests/projectile_terrain_crossing.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { EntityManager } from "../scene3d/entities.js";
import {
  PROJECTILE_SWEEP_RADIUS,
  PROJECTILE_TERRAIN_PROBE_M,
  projectileTerrainCrossing,
} from "../scene3d/projectile_sweep.js";
import { installFakeMotionSequence } from "../harness/lib/fake_motion_sequence.mjs";

installFakeMotionSequence();

const EPS = 0.25; // entities.js PROJECTILE_TERRAIN_STOP_EPS
const LB_X0 = 0xa9 * 192; // boltMeta's landblock 0xA9B4 → world x origin

/** A tent ridge along y: `peak` m high at x = `cx`, `half` m half-width. */
const ridge = (cx, peak, half) => (x) => Math.max(0, peak * (1 - Math.abs(x - cx) / half));
/** A ramp up from x = `x0` at `slope`, capped at `top`. */
const ramp = (x0, slope, top) => (x) => Math.min(top, Math.max(0, (x - x0) * slope));

// ---- 1. the pure helper ------------------------------------------------------

test("the first crossing of a ridge thinner than one substep, z on the surface", () => {
  // A level bolt at z = 1 over a 1 m-wide, 5 m ridge at x = 3; one 4 m step.
  const g = ridge(3, 5, 0.5);
  const p0 = { x: 0, y: 0, z: 1 }, p1 = { x: 4, y: 0, z: 1 };
  assert.ok(p1.z >= g(p1.x) - EPS, "the step's end point is clear (the per-frame test misses it)");
  const hit = projectileTerrainCrossing(p0, p1, (x) => g(x), EPS);
  assert.ok(hit, "caught");
  // The surface crossing on the near flank: 5·(1 − |x − 3|/0.5) = 1 → x = 2.6.
  assert.ok(Math.abs(hit.x - 2.6) < 0.01, `x ${hit.x}`);
  assert.ok(hit.x < 3, "the near flank, not the far side");
  assert.equal(hit.z, g(hit.x), "z on the terrain surface at the stop xy");
  assert.ok(Math.abs(hit.s - hit.x / 4) < 1e-12, "s is the path fraction");
  assert.equal(hit.y, 0);
});

test("a diving bolt stops where it meets flat ground", () => {
  const hit = projectileTerrainCrossing({ x: 0, y: 0, z: 1 }, { x: 2, y: 0, z: -1 }, () => 0, EPS);
  assert.ok(hit && Math.abs(hit.x - 1) < 0.01, `x ${hit?.x}`);
  assert.equal(hit.z, 0);
});

test("a bolt above the sample or within 0.25 m under it is not stopped", () => {
  const level = (z, gz) => projectileTerrainCrossing({ x: 0, y: 0, z }, { x: 6, y: 0, z }, () => gz, EPS);
  assert.equal(level(1, 0), null, "well above");
  assert.equal(level(1, 1), null, "on the surface");
  assert.equal(level(1, 1.2), null, "0.2 m under: within the tolerance");
  assert.equal(level(1, 1.24), null, "0.24 m under");
  assert.ok(level(1, 1.3), "0.3 m under: stopped");
});

test("a bracket that starts under the surface (within the tolerance) stops at its start", () => {
  // Skimming 0.1 m under the sample, then the ground rises.
  const g = (x) => 0.1 + Math.max(0, x - 1);
  const hit = projectileTerrainCrossing({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, (x) => g(x), EPS);
  assert.ok(hit);
  assert.equal(hit.x, 1, "the last probe still within the tolerance");
  assert.ok(Math.abs(hit.z - 0.1) < 1e-12, "lifted onto the surface");
});

test("unknown terrain never stops; a zero-length step is a no-op", () => {
  assert.equal(projectileTerrainCrossing({ x: 0, y: 0, z: -50 }, { x: 4, y: 0, z: -50 }, () => null, EPS), null);
  assert.equal(projectileTerrainCrossing({ x: 0, y: 0, z: -50 }, { x: 4, y: 0, z: -50 }, () => NaN, EPS), null);
  assert.equal(projectileTerrainCrossing({ x: 1, y: 1, z: -5 }, { x: 1, y: 1, z: -5 }, () => 0, EPS), null);
});

test("cost: one terrain sample for a 60 fps step, one per probe spacing otherwise", () => {
  let n = 0;
  const count = () => { n += 1; return 0; };
  projectileTerrainCrossing({ x: 0, y: 0, z: 1 }, { x: 20 / 60, y: 0, z: 1 }, count, EPS);
  assert.equal(n, 1, "20 m/s at 60 fps");
  n = 0;
  projectileTerrainCrossing({ x: 0, y: 0, z: 1 }, { x: 4, y: 0, z: 1 }, count, EPS);
  assert.equal(n, Math.ceil(4 / PROJECTILE_TERRAIN_PROBE_M));
});

// ---- 2/3. the REAL EntityManager tick ----------------------------------------

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

/** Terrain height by LANDBLOCK-LOCAL x (the tests fly along +x at y = 10). */
let terrainLocal = () => 0;
const resolveCalls = [];
const sh = {
  entityIsProjectile: () => true,
  entityProjectileHasGravity: () => false,
  entityProjectileAlignsPath: () => false,
  objectPhysicsState: () => 0x28b48,
  terrainHeightAt: (x) => terrainLocal(x - LB_X0),
  entityDefaultScript: () => 0,
  entityDefaultScriptIntensity: () => 1,
  getRenderSet: () => new Uint32Array(0),
};
window.__sessionHandle = sh;
/** The doorway at local x = `doorX`: past it the walk lands in outdoor cell 0x11. */
function walkOutAt(doorX) {
  sh.resolveViewerCell = (fx, fy, fz, tx, ty, tz, r, cell) => {
    resolveCalls.push({ cell, r });
    return (cell & 0xffff) >= 0x100 && tx - LB_X0 > doorX ? 0xa9b40011 : cell;
  };
}

let nextGuid = 0x80000301;
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
    landblockId: 0xa9b40001, x: 10, y: 10, z: 1, qw: 1, qx: 0, qy: 0, qz: 0,
    paletteId: 0, motionCommand: 0, motionStance: 0, objScale: 1, name: "Flame Bolt",
    wcid: 1499, itemType: 0, iconId: 0, physicsScriptDid: 0,
    modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0),
    subPalettes: new Uint32Array(0),
    vx: 40, vy: 0, vz: 0,
    ...extra,
  };
}
function reset() {
  terrainLocal = () => 0;
  resolveCalls.length = 0;
  delete sh.resolveViewerCell;
}

// The flight clock anchors at a positive receipt stamp (the seed ignores a
// non-positive one), so make "200 ms ago" positive.
while (performance.now() < 600) await new Promise((r) => setTimeout(r, 50));

test("a fast bolt stops at a thin ridge inside the frame, not past it", async () => {
  reset();
  const em = makeManager();
  // 40 m/s over 200 ms: substeps 10 → 14 → 18; the ridge (x 12.5–13.5) sits
  // inside the first one and the frame's end point is on flat ground again.
  const g = ridge(13, 5, 0.5);
  terrainLocal = g;
  const inst = await em.spawn(boltMeta({ recvMs: performance.now() - 200 }));
  assert.equal(inst._ballisticTerrainOk, true, "armed: launched above the sample");
  em.tick(0.016);
  assert.equal(inst._ballistic, false, "stopped");
  assert.equal(em._projectileStops?.at(-1)?.cause, "client-terrain");
  const x = inst.root.position.x - LB_X0;
  assert.ok(Math.abs(x - 12.6) < 0.01, `stopped on the near flank (x ${x})`);
  assert.equal(inst.root.position.z, g(x), "resting on the surface at the stop xy");
  em.dispose();
  reset();
});

test("a bolt skimming within the tolerance flies on", async () => {
  reset();
  const em = makeManager();
  terrainLocal = () => 1.2; // 0.2 m above the bolt
  const inst = await em.spawn(boltMeta({ recvMs: performance.now() - 200 }));
  assert.equal(inst._ballisticTerrainOk, true);
  em.tick(0.016);
  assert.equal(inst._ballistic, true, "not stopped");
  assert.ok(inst.root.position.x - LB_X0 > 17.9, "full flight");
  em.dispose();
  reset();
});

test("an indoor launch arms the terrain stop once it leaves the door", async () => {
  reset();
  const em = makeManager();
  walkOutAt(11);
  // Out of the door at x 11, a hill rises from x = 13 (4:1, the bolt's z = 1
  // at x = 13.25). 20 m/s over 300 ms: substeps 10 → 12 → 14 → 16.
  terrainLocal = ramp(13, 4, 5);
  const inst = await em.spawn(boltMeta({ landblockId: 0xa9b40105, vx: 20, recvMs: performance.now() - 300 }));
  assert.equal(inst._ballisticTerrainOk, false, "indoor launch: not armed at spawn");
  em.tick(0.016);
  assert.equal(inst._ballisticCellId, 0xa9b40011, "carried out of the door");
  assert.equal(resolveCalls[0]?.cell, 0xa9b40105, "walked from the launch cell");
  assert.equal(resolveCalls[0]?.r, PROJECTILE_SWEEP_RADIUS);
  assert.equal(inst._ballistic, false, "stopped on the hill");
  assert.equal(em._projectileStops?.at(-1)?.cause, "client-terrain");
  const x = inst.root.position.x - LB_X0;
  assert.ok(Math.abs(x - 13.25) < 0.01, `at the crossing (x ${x})`);
  em.dispose();
  reset();
});

test("an indoor launch that exits below our sample stays unarmed (spawn rule)", async () => {
  reset();
  const em = makeManager();
  walkOutAt(11);
  terrainLocal = () => 3; // the ground outside sits 2 m above the bolt
  const inst = await em.spawn(boltMeta({ landblockId: 0xa9b40105, vx: 20, recvMs: performance.now() - 300 }));
  em.tick(0.016);
  assert.equal(inst._ballisticCellId, 0xa9b40011);
  assert.equal(inst._ballisticTerrainOk, false, "not trusted");
  assert.equal(inst._ballistic, true, "the server decides");
  em.dispose();
  reset();
});

test("stale pkg (no cell walk): an indoor launch keeps the legacy no-stop", async () => {
  reset();
  const em = makeManager();
  terrainLocal = ramp(13, 4, 5);
  const inst = await em.spawn(boltMeta({ landblockId: 0xa9b40105, vx: 20, recvMs: performance.now() - 300 }));
  em.tick(0.016);
  assert.equal(inst._ballisticCellId, 0xa9b40105);
  assert.equal(inst._ballistic, true, "flies on");
  em.dispose();
  reset();
});

// ---- 4. `?projectileTerrainCrossing=off`: the tick + helpers, lifted ---------
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
const METHODS = [
  "_tickBallisticProjectiles",
  "_stopBallisticProjectile",
  "_noteProjectileStop",
  "_setProjectileLightsOn",
  "_spinProjectile",
  "_alignToVelocity",
  "_projectileTerrainStep",
  "_projectileTrackCell",
].map(methodSource).join("\n");
let liftedTerrain = () => 0;
const makeHarness = (crossingOn) => new Function(
  "projectileTerrainCrossing",
  "PROJECTILE_SWEEP_RADIUS",
  "terrainAt",
  `
  const PROJECTILE_GRAVITY_Z = -9.8;
  const PROJECTILE_TERRAIN_STOP_ON = true;
  const PROJECTILE_TERRAIN_STOP_EPS = 0.25;
  const PROJECTILE_EXACT_ARC_ON = true;
  const PROJECTILE_ENV_SWEEP_ON = false;
  const PROJECTILE_SCENERY_SWEEP_ON = true;
  const PROJECTILE_TERRAIN_CROSSING_ON = ${crossingOn};
  const _terrainZAt = (x, y) => terrainAt(x, y);
  return class { ${METHODS} };
`,
)(projectileTerrainCrossing, PROJECTILE_SWEEP_RADIUS, (x, y) => liftedTerrain(x, y));

function liftedFly(H) {
  const h = new H();
  const e = {
    guid: 0x80000001,
    root: { position: new THREE.Vector3(0, 0, 1), quaternion: new THREE.Quaternion(), userData: {} },
    lastVel: { vx: 40, vy: 0, vz: 0 },
    _ballistic: true,
    _ballisticTerrainOk: true,
    _ballisticLastMs: performance.now() - 200,
  };
  h.entityMap = new Map([[1, e]]);
  h._tickBallisticProjectiles();
  return { h, e };
}

test("?projectileTerrainCrossing=off: the legacy per-frame end point misses the ridge", () => {
  liftedTerrain = ridge(3, 5, 0.5); // inside the first 0.1 s substep (0 → 4)
  const on = liftedFly(makeHarness(true));
  assert.equal(on.e._ballistic, false, "on: stopped at the ridge");
  assert.ok(Math.abs(on.e.root.position.x - 2.6) < 0.01, `on: x ${on.e.root.position.x}`);
  assert.equal(on.h._projectileStops?.at(-1)?.cause, "client-terrain");
  const off = liftedFly(makeHarness(false));
  assert.equal(off.e._ballistic, true, "off: tunnelled through (legacy)");
  assert.ok(off.e.root.position.x > 7.9, `off: x ${off.e.root.position.x}`);
  // Legacy still stops at the end point when that is under the ground,
  // snapping z up at the overshot xy.
  liftedTerrain = () => 3;
  const legacy = liftedFly(makeHarness(false));
  assert.equal(legacy.e._ballistic, false);
  assert.ok(legacy.e.root.position.x > 7.9, "stopped at the overshot end point");
  assert.equal(legacy.e.root.position.z, 3);
  liftedTerrain = () => 0;
});
