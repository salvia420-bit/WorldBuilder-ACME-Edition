// tests/projectile_visual_fidelity.test.mjs — PROJ-VIS (2026-10-05).
//
// Drives the REAL EntityManager spawn → tick path for a spell projectile
// (PhysicsState::MISSILE, non-zero launch velocity) with mocked wasm exports +
// session handle, plus the REAL ParticleManager RP6 cull and the light-pool
// sort key. Pins:
//   1. flight clock starts at ObjectCreate RECEIPT (meta.recvMs), not at the
//      end of the async rig build;
//   2. an impact VectorUpdate that lands while the rig is still building is
//      parked and stops the bolt at the impact time;
//   3. client terrain stop;
//   4. the missile's wire default_script (collision script) is NOT played at
//      spawn;
//   5. Setup lights attach through the pool, lit on LIGHTING_ON, priority-
//      tagged, and go dark on impact / NoDraw;
//   6. particle managers tick during the dt=0 recovery window;
//   7. RP6 never culls an emitter riding a ballistic parent;
//   8. loop.js missile-launch classifier;
//   9. physupd-1 environment sweep (`?projectileEnvSweep`): building / EnvCell
//      / door layers stop the bolt short of contact, launch-window and
//      embedded-start rules, the missile-BSP door guard, never the AABB statics.
//
// Run: node tests/projectile_visual_fidelity.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { EntityManager } from "../scene3d/entities.js";
import { lightSelectionSortKey } from "../scene3d/lighting.js";
import {
  PROJECTILE_SWEEP_RADIUS,
  landblockOfWorld,
  projectileHitStops,
  projectileSweepCells,
  projectileStopPoint,
  sweepProjectileSegment,
} from "../scene3d/projectile_sweep.js";
import { installFakeMotionSequence } from "../harness/lib/fake_motion_sequence.mjs";

installFakeMotionSequence();

const PART_COUNT = 1;
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

let terrainZ = 0;
let defaultScriptReads = 0;
let physicsState = 0x28b48; // Flame Bolt wcid 1499: MISSILE|LIGHTING_ON|ALIGN_PATH|...
let buildGate = null; // when set, the keyframe fetch awaits it (slow rig build)

const wasmExports = {
  async fetchEntityAnimationKeyframes() {
    if (buildGate) await buildGate;
    const meshes = [partMesh()];
    return {
      partCount: PART_COUNT, numFrames: 0, framerate: 0, resolvedStance: 0x3d,
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
  // Present so the default-script arms are eligible (the skip is what's tested).
  async fetchPhysicsScript() { return null; },
  async fetchParticleEmitter() { return null; },
  async fetchBuildingPlacement() { return { partCount: 0, free() {} }; },
  async fetchSetupDefaultScript() { return 0; },
  async fetchSetupModelLights() {
    return {
      partCount: 1,
      takeLights() {
        return [{
          partIndex: 0, x: 0, y: 0, z: 0, qw: 1, qx: 0, qy: 0, qz: 0,
          colorR: 255, colorG: 100, colorB: 100, intensity: 100, falloff: 8, coneAngle: 0,
        }];
      },
      free() {},
    };
  },
};

// physupd-1 sweep mocks. `sweep.<layer>` is a (from, to, radius, last) →
// hit|null function per wasm export (null = clean miss, the default); every
// call is logged so a test can assert which layers ran with which arguments.
const sweep = { building: null, cellMesh: null, cellStatics: null, entities: null };
const sweepCalls = [];
let freedHits = 0;
let aabbStaticsCalls = 0;
let renderSet = new Uint32Array(0);
function sweepExport(layer) {
  return (fx, fy, fz, tx, ty, tz, r, last) => {
    sweepCalls.push({ layer, from: { x: fx, y: fy, z: fz }, to: { x: tx, y: ty, z: tz }, r, last });
    const hit = sweep[layer]?.({ x: fx, y: fy, z: fz }, { x: tx, y: ty, z: tz }, r, last);
    return hit ? { normalX: 0, normalY: 0, normalZ: 0, ...hit, free() { freedHits += 1; } } : undefined;
  };
}

window.__sessionHandle = {
  entityIsProjectile: () => true,
  entityProjectileHasGravity: () => false,
  entityProjectileAlignsPath: () => false,
  objectPhysicsState: () => physicsState,
  terrainHeightAt: () => terrainZ,
  entityDefaultScript: () => { defaultScriptReads += 1; return 0x5a; },
  entityDefaultScriptIntensity: () => 1,
  getRenderSet: () => renderSet,
  sweepSphereAgainstBuildingMesh: sweepExport("building"),
  sweepSphereAgainstCellMesh: sweepExport("cellMesh"),
  sweepSphereAgainstCellStatics: sweepExport("cellStatics"),
  sweepSphereAgainstEntities: sweepExport("entities"),
  // Whole-AABB statics sweep — must never be used for missiles.
  sweepSphereAgainstStatics: () => { aabbStaticsCalls += 1; return undefined; },
};

let nextGuid = 0x80000001;
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
const flush = () => new Promise((r) => setTimeout(r, 0));

test("flight clock starts at ObjectCreate receipt, not after the rig build", async () => {
  // performance.now() starts near 0 in a fresh process; the seed (rightly)
  // ignores a non-positive stamp, so make sure "250 ms ago" is positive.
  while (performance.now() < 600) await new Promise((r) => setTimeout(r, 50));
  const em = makeManager();
  const recvMs = performance.now() - 250; // 250 ms of rig-build latency
  const inst = await em.spawn(boltMeta({ recvMs }));
  assert.ok(inst && inst._ballistic, "missile seeded ballistic");
  assert.equal(inst.lastVelMs, recvMs, "clock anchored at receipt");
  const x0 = inst.root.position.x;
  em.tick(0); // dt=0 (recovery window) still integrates on the wall clock
  const moved = inst.root.position.x - x0;
  assert.ok(moved >= 20 * 0.25 - 0.05, `caught up the 250 ms latency (moved ${moved.toFixed(2)} m)`);
  assert.equal(inst.root.userData.__ballistic, true, "RP6 exemption stamp on the root");
  em.dispose();
});

test("missile wire default_script (collision script) is not played at spawn", async () => {
  const em = makeManager();
  defaultScriptReads = 0;
  await em.spawn(boltMeta({ recvMs: performance.now() }));
  await flush();
  assert.equal(defaultScriptReads, 0, "A11-S5 resolver never consulted for a missile");
  em.dispose();
});

test("projectile Setup lights: pooled, lit on LIGHTING_ON, priority, out on impact", async () => {
  const em = makeManager();
  physicsState = 0x28b48;
  const inst = await em.spawn(boltMeta({ recvMs: performance.now() }));
  await flush();
  assert.equal(inst._setupLights?.length, 1, "Setup light attached without ?entityLights");
  const light = inst._setupLights[0];
  assert.equal(light.visible, false, "pool carrier stays invisible (light count constant)");
  assert.ok(light.intensity > 0, "lit from spawn (LIGHTING_ON)");
  assert.equal(light.userData.__dynamicPriority, true);
  assert.ok(em.scene3d.activeLights.includes(light), "fed to the pool");
  em.setVisibility(inst.guid, false); // NoDraw
  assert.equal(light.intensity, 0, "NoDraw puts the light out");
  em.setVisibility(inst.guid, true);
  assert.ok(light.intensity > 0, "redraw while in flight relights");
  em.setVelocity({ guid: inst.guid, vx: 0, vy: 0, vz: 0, omegaZ: 0 });
  assert.equal(inst._ballistic, false, "impact stop");
  assert.equal(light.intensity, 0, "impact puts the light out");
  em.remove(inst.guid);
  assert.ok(!em.scene3d.activeLights.includes(light), "released on remove");
  em.dispose();
});

test("no LIGHTING_ON → light attached dark", async () => {
  const em = makeManager();
  physicsState = 0x28b48 & ~0x800;
  const inst = await em.spawn(boltMeta({ recvMs: performance.now() }));
  await flush();
  assert.equal(inst._setupLights?.[0]?.intensity, 0);
  physicsState = 0x28b48;
  em.dispose();
});

test("impact VectorUpdate that beats the rig build stops the bolt at impact time", async () => {
  const em = makeManager();
  let release;
  buildGate = new Promise((r) => { release = r; });
  const meta = boltMeta({ recvMs: performance.now() - 100 });
  const p = em.spawn(meta);
  await flush();
  assert.ok(em.spawnInFlight.has(meta.guid), "rig still building");
  em.setVelocity({ guid: meta.guid, vx: 0, vy: 0, vz: 0, omegaZ: 0 });
  const impactMs = performance.now();
  await new Promise((r) => setTimeout(r, 60)); // the build takes longer
  buildGate = null;
  release();
  const inst = await p;
  assert.ok(inst._ballisticStopMs != null, "parked impact consumed by the seed");
  const x0 = inst.root.position.x;
  em.tick(0.016);
  assert.equal(inst._ballistic, false, "stopped on the first integration pass");
  const flown = inst.root.position.x - x0;
  const expect = 20 * (impactMs - meta.recvMs) / 1000;
  assert.ok(Math.abs(flown - expect) < 20 * 0.02, `stopped at the impact point (${flown.toFixed(2)} vs ${expect.toFixed(2)} m)`);
  const xs = inst.root.position.x;
  em.tick(0.016);
  assert.equal(inst.root.position.x, xs, "stays put after the stop");
  em.dispose();
});

test("client terrain stop: a bolt diving under the terrain stops on it", async () => {
  const em = makeManager();
  terrainZ = 0;
  const inst = await em.spawn(boltMeta({ z: 2, vx: 0, vz: -20, recvMs: performance.now() - 200 }));
  em.tick(0.016);
  assert.equal(inst._ballistic, false, "stopped");
  assert.ok(Math.abs(inst.root.position.z - 0) < 1e-6, "resting on the terrain surface");
  // A launch already below our terrain sample (fired across a rise) is not trusted.
  terrainZ = 100;
  const inst2 = await em.spawn(boltMeta({ z: 50, recvMs: performance.now() - 50 }));
  em.tick(0.016);
  assert.equal(inst2._ballistic, true, "below-terrain launch keeps flying (server decides)");
  terrainZ = 0;
  em.dispose();
});

// ---- physupd-1: environment sweep (building / EnvCell / door) ----------------
const LB_X0 = 0xa9 * 192; // boltMeta's landblock 0xA9B4 → world x origin
const R = PROJECTILE_SWEEP_RADIUS;
function resetSweep() {
  for (const k of Object.keys(sweep)) sweep[k] = null;
  sweepCalls.length = 0;
  renderSet = new Uint32Array(0);
}
/** A wall plane at world x = `wx`, hit from -x: the sphere touches at wx - R. */
function wallAt(wx) {
  return (a, b, r) => {
    const c = wx - r;
    if (a.x >= c || b.x < c) return null;
    return { t: (c - a.x) / (b.x - a.x), x: wx, y: a.y, z: a.z, normalX: -1 };
  };
}
/** An embedded-start hit (t = 0) when the step starts at world x = `wx`. */
function embeddedAt(wx, normalX) {
  return (a) => (Math.abs(a.x - wx) < 1e-9 ? { t: 0, normalX } : null);
}
const tickAfter = (em, ms) => new Promise((r) => setTimeout(() => { em.tick(0.016); r(); }, ms));

test("pure helpers: landblock, hit acceptance, cell set, stop point", () => {
  assert.equal(landblockOfWorld(LB_X0 + 10, 0xb4 * 192 + 5), 0xa9b40000);
  assert.equal(landblockOfWorld(LB_X0 - 0.01, 0), 0xa8000000);
  assert.equal(projectileHitStops(0.5, -1, true), true, "real contact ahead stops, even at launch");
  assert.equal(projectileHitStops(0, -1, true), false, "embedded launch point ignored");
  assert.equal(projectileHitStops(0, -1, false), true, "embedded + moving in after launch stops");
  assert.equal(projectileHitStops(0, 1, false), false, "embedded + moving away never stops");
  assert.equal(projectileHitStops(0, 0, false), false, "embedded + grazing never stops");
  assert.equal(projectileHitStops(NaN, -1, false), false);
  const rs = Uint32Array.of(0xa9b40100, 0xa9b40101);
  assert.equal(projectileSweepCells(rs, 0xa9b40001), rs, "outdoor bolt: the render set as-is");
  assert.equal(projectileSweepCells(new Uint32Array(0), 0xa9b40001), null);
  assert.equal(projectileSweepCells(rs, 0xa9b40101), rs, "own cell already present");
  assert.deepEqual([...projectileSweepCells(rs, 0xa9b40105)], [0xa9b40100, 0xa9b40101, 0xa9b40105]);
  assert.deepEqual([...projectileSweepCells(null, 0xa9b40105)], [0xa9b40105]);
  const p = projectileStopPoint({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, 0.5);
  assert.ok(Math.abs(p.x - (1 - 0.05)) < 1e-12, "backed off along the path");
  assert.equal(projectileStopPoint({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, 0).x, 0, "never behind p0");
});

test("sweepProjectileSegment: both LBs on a crossing, earliest t, hits freed, stale pkg", () => {
  resetSweep();
  const freed0 = freedHits;
  const sh = window.__sessionHandle;
  sweep.building = (a, b, r, lb) => (lb === 0xaa000000 ? { t: 0.8, normalX: -1 } : null);
  sweep.entities = () => ({ t: 0.6, normalX: -1 });
  const a = { x: LB_X0 + 191, y: 1, z: 1 }, b = { x: LB_X0 + 193, y: 1, z: 1 };
  assert.equal(sweepProjectileSegment(sh, a, b, { cells: null }), 0.6);
  const lbs = sweepCalls.filter((c) => c.layer === "building").map((c) => c.last);
  assert.deepEqual(lbs, [0xa9000000, 0xaa000000], "building mesh swept in both landblocks");
  assert.ok(Math.abs(sweepCalls.find((c) => c.layer === "entities").last - 7) < 1e-9, "door scan = |d| + 5 m");
  assert.equal(freedHits - freed0, 2, "every hit box freed");
  assert.equal(sweepProjectileSegment(sh, a, b, { entities: false }), 0.8, "door layer skippable");
  assert.equal(sweepProjectileSegment({}, a, b), null, "no exports → no hit");
  assert.equal(sweepProjectileSegment(null, a, b), null);
  resetSweep();
});

test("env sweep: a bolt stops short of a building wall", async () => {
  resetSweep();
  const em = makeManager();
  sweep.building = wallAt(LB_X0 + 12);
  const freed0 = freedHits;
  const inst = await em.spawn(boltMeta({ recvMs: performance.now() - 200 }));
  em.tick(0.016);
  assert.equal(inst._ballistic, false, "stopped at the wall");
  assert.equal(inst._projectileImpacted, true);
  // First 0.1 s substep: 10 → 12, contact at t = 0.95, backed off 0.05 m.
  assert.ok(Math.abs(inst.root.position.x - (LB_X0 + 11.85)) < 1e-6, `x ${inst.root.position.x - LB_X0}`);
  assert.equal(sweepCalls.find((c) => c.layer === "building").last, 0xa9b40000, "the bolt's landblock");
  assert.ok(freedHits > freed0, "hit box freed");
  const xs = inst.root.position.x;
  await tickAfter(em, 20);
  assert.equal(inst.root.position.x, xs, "stays put");
  em.dispose();
});

test("env sweep: no hit leaves the flight unchanged", async () => {
  resetSweep();
  const em = makeManager();
  const inst = await em.spawn(boltMeta({ recvMs: performance.now() - 150 }));
  const x0 = inst.root.position.x;
  em.tick(0.016);
  const rdt = (inst._ballisticLastMs - inst.lastVelMs) / 1000;
  assert.equal(inst._ballistic, true);
  assert.ok(Math.abs(inst.root.position.x - x0 - 20 * rdt) < 1e-6, "x = x0 + v·t");
  assert.ok(sweepCalls.length > 0, "layers were swept");
  em.dispose();
});

test("env sweep: an embedded launch point is ignored, a later embedded contact stops", async () => {
  resetSweep();
  const em = makeManager();
  sweep.building = embeddedAt(LB_X0 + 10, -1); // launch point touching a door frame
  const inst = await em.spawn(boltMeta({ recvMs: performance.now() - 120 }));
  em.tick(0.016);
  assert.equal(inst._ballistic, true, "launch-window embedded hit ignored");
  const x1 = inst.root.position.x;
  assert.ok(x1 > LB_X0 + 12, "flew on");
  // Embedded but moving AWAY from the surface: never a stop.
  sweep.building = embeddedAt(x1, +1);
  await tickAfter(em, 20);
  assert.equal(inst._ballistic, true, "separating embedded hit ignored");
  // Embedded and moving INTO it, past the launch window: stop where it is.
  const x2 = inst.root.position.x;
  sweep.building = embeddedAt(x2, -1);
  await tickAfter(em, 20);
  assert.equal(inst._ballistic, false, "stopped");
  assert.equal(inst.root.position.x, x2, "at the contact, not past it");
  em.dispose();
});

test("env sweep: indoors, EnvCell layers get the render set + the bolt's own cell", async () => {
  resetSweep();
  const em = makeManager();
  renderSet = Uint32Array.of(0xa9b40100, 0xa9b40101);
  sweep.cellStatics = wallAt(LB_X0 + 12);
  const inst = await em.spawn(boltMeta({ landblockId: 0xa9b40105, recvMs: performance.now() - 200 }));
  em.tick(0.016);
  assert.equal(inst._ballistic, false, "stopped by a cell static");
  const cells = sweepCalls.find((c) => c.layer === "cellMesh")?.last;
  assert.ok(cells instanceof Uint32Array, "cell ids passed as Uint32Array");
  assert.deepEqual([...cells], [0xa9b40100, 0xa9b40101, 0xa9b40105]);
  em.dispose();
});

test("env sweep: a closed door stops the bolt; skipped while a missile has a physics BSP", async () => {
  resetSweep();
  let em = makeManager();
  sweep.entities = wallAt(LB_X0 + 12);
  const inst = await em.spawn(boltMeta({ recvMs: performance.now() - 200 }));
  em.tick(0.016);
  assert.equal(inst._ballistic, false, "door stop");
  em.dispose();
  // A BSP-bearing missile's stale wasm entity would stop its own bolt
  // (retail missile_ignore): the door layer stands down.
  resetSweep();
  physicsState = 0x28b48 | 0x10000;
  em = makeManager();
  sweep.entities = wallAt(LB_X0 + 12);
  const inst2 = await em.spawn(boltMeta({ recvMs: performance.now() - 200 }));
  em.tick(0.016);
  assert.equal(inst2._ballistic, true, "flies on");
  assert.equal(sweepCalls.filter((c) => c.layer === "entities").length, 0, "door layer not swept");
  physicsState = 0x28b48;
  em.dispose();
  resetSweep();
});

test("env sweep never uses the whole-AABB statics sweep", () => {
  assert.equal(aabbStaticsCalls, 0);
});

test("particle managers tick during the dt=0 recovery window", () => {
  const em = makeManager();
  let ticks = 0;
  em._worldParticleManager = { tick() { ticks += 1; } };
  em.tick(0);
  assert.equal(ticks, 1);
  em._worldParticleManager = null;
  em.dispose();
});

test("RP6 never culls an emitter riding a ballistic parent", async () => {
  globalThis.window.location = { search: "" };
  const { setCurrentTime } = await import("../scene3d/particles/time_rng.js");
  let t = 1000;
  setCurrentTime(() => t);
  const { ParticleManager } = await import("../scene3d/particles/particle_manager.js");
  const group = new THREE.Group();
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 10000);
  cam.updateMatrixWorld(true);
  const prevLive = window.liveScene3d;
  window.liveScene3d = { cameraSwitcher: { activeCamera: cam }, camera: cam };
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  const mgr = new ParticleManager({
    scene: group,
    geometryFactory: () => g,
    materialFactory: () => new THREE.MeshBasicMaterial({ transparent: true }),
  });
  const info = {
    id: 0, emitterType: 1, particleType: 1, gfxObjId: 0, hwGfxObjId: 0x01000001,
    birthrate: 0.0, maxParticles: 8, initialParticles: 1, totalParticles: 0, totalSeconds: 0,
    lifespan: 1000, lifespanRand: 0, offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,
    minOffset: 0, maxOffset: 0, aX: 0, aY: 0, aZ: 0, minA: 0, maxA: 0,
    bX: 0, bY: 0, bZ: 0, cX: 0, cY: 0, cZ: 0, scaleRand: 0, startScale: 1, finalScale: 1,
    transRand: 0, startTrans: 0, finalTrans: 0, isParentLocal: false, billboard: false,
  };
  // Both anchors far beyond the 220 m RP6 distance cap.
  const plain = new THREE.Object3D(); plain.position.set(0, 0, -5000);
  const bolt = new THREE.Object3D(); bolt.position.set(0, 0, -5000);
  bolt.userData.__ballistic = true;
  group.add(plain, bolt);
  const idPlain = await mgr.addEmitter({ emitterInfo: { ...info }, parent: plain, emitterId: 1 });
  const idBolt = await mgr.addEmitter({ emitterInfo: { ...info }, parent: bolt, emitterId: 2 });
  for (let i = 0; i < 12; i += 1) { t += 0.016; mgr.tick(); }
  assert.equal(mgr.particleTable.get(idPlain)?._rp6Culled, true, "control: far emitter culled");
  assert.notEqual(mgr.particleTable.get(idBolt)?._rp6Culled, true, "ballistic emitter never culled");
  assert.ok(mgr.particleTable.get(idBolt).totalEmitted > 1, "ballistic emitter kept emitting");
  setCurrentTime(null);
  window.liveScene3d = prevLive;
});

test("light pool sort key: projectile lights after the viewer, before statics, within 48 m", () => {
  const pri = { __dynamicPriority: true };
  assert.equal(lightSelectionSortKey(25, null), 25);
  const k = lightSelectionSortKey(400, pri);
  assert.ok(k > -1 && k < 0, "between viewer (-1) and any static (>=0)");
  assert.ok(lightSelectionSortKey(100, pri) < k, "nearest-first among projectile lights");
  assert.equal(lightSelectionSortKey(60 * 60, pri), 3600, "far projectile light competes on distance");
});

test("loop.js missile-launch classifier", async () => {
  window.requestAnimationFrame = window.requestAnimationFrame || (() => 0);
  window.cancelAnimationFrame = window.cancelAnimationFrame || (() => {});
  const { isMissileLaunchMeta } = await import("../scene3d/loop.js");
  assert.equal(isMissileLaunchMeta({ vx: 20, vy: 0, vz: 0 }), true);
  assert.equal(isMissileLaunchMeta({ vx: 0, vy: 0, vz: 0 }), false);
  assert.equal(isMissileLaunchMeta({}), false);
  assert.equal(isMissileLaunchMeta(null), false);
});
