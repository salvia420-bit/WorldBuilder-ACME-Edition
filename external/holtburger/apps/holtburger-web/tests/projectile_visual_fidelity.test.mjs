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
//   8. loop.js missile-launch classifier.
//
// Run: node tests/projectile_visual_fidelity.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { EntityManager } from "../scene3d/entities.js";
import { lightSelectionSortKey } from "../scene3d/lighting.js";
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

window.__sessionHandle = {
  entityIsProjectile: () => true,
  entityProjectileHasGravity: () => false,
  entityProjectileAlignsPath: () => false,
  objectPhysicsState: () => physicsState,
  terrainHeightAt: () => terrainZ,
  entityDefaultScript: () => { defaultScriptReads += 1; return 0x5a; },
  entityDefaultScriptIntensity: () => 1,
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
