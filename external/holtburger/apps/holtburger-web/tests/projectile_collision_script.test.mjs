// tests/projectile_collision_script.test.mjs — physics-collision-4
// (2026-10-13, `?missileImpactScript=on` opt-in, default OFF).
//
// Retail `report_environment_collision` / `report_object_collision`
// (acclient.c:320194-320290) hand a REPORT_COLLISIONS missile's contact to
// `ACCWeenieObject::DoCollision` (Env + Atk overloads share one body,
// :436857), which plays `play_default_script` when SCRIPTED_COLLISION
// (0x8000) is set. ACE gives bolt-type spells DefaultScriptId =
// PlayScript.ProjectileCollision (0x5A, SpellProjectile.cs:86-91) and never
// broadcasts it. Flame Bolt (LSD wcid 1499) is 0x28B48; an arrow (wcid 300)
// is 0x20414 (no SCRIPTED_COLLISION).
//
// Drives the REAL EntityManager spawn → tick → stop path with mocked wasm +
// session handle (like tests/projectile_visual_fidelity.test.mjs), and the
// genuine `_playDefaultScriptResolved` resolve through a mocked
// PhysicsScriptTable; `_attachParticleChainForEntity` is the spy sink.
//   1. pure predicate `projectileCollisionScriptPlays`
//   2. opt-in: a client env-sweep stop with 0x28B48 reads the default script
//      once and plays the resolved 0x33 on the bolt's root; a later server
//      impact does not read it again
//   3. opt-in: client-terrain and the object layer play it too
//   4. opt-in: arrow 0x20414, ReportCollisions cleared (0x28B40), and a
//      server-impact stop → no read
//   5. opt-in: nothing at spawn (the spawn skip stays)
//   6. default (absent), `=1` and opt-in + `?defaultScriptSpawn=off` → silent
//
// `window.location` is stubbed BEFORE entities.js loads; each flag state
// loads its own module instance (tests/default_script_part_child precedent).
//
// Run: node tests/projectile_collision_script.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PHYSICS_STATE_MISSILE,
  PHYSICS_STATE_REPORT_COLLISIONS,
  PHYSICS_STATE_SCRIPTED_COLLISION,
  PROJECTILE_SWEEP_RADIUS,
  projectileCollisionScriptPlays,
} from "../scene3d/projectile_sweep.js";
import { installFakeMotionSequence } from "../harness/lib/fake_motion_sequence.mjs";

const FLAME_BOLT = 0x28b48; // REPORT_COLLISIONS|MISSILE|ALIGN_PATH|PATH_CLIPPED|LIGHTING_ON|SCRIPTED_COLLISION|INELASTIC
const ARROW = 0x20414; // no SCRIPTED_COLLISION
const PROJECTILE_COLLISION = 0x5a; // PlayScript.ProjectileCollision
const BOLT_TABLE = 0x34000005; // Flame Bolt didStat 22
const COLLISION_SCRIPT = 0x33000a5a; // what the table resolves 0x5A @ 1.0 to

let physicsState = FLAME_BOLT;
let terrainZ = 0;
let defaultScriptReads = 0;
// Sweep mocks: `sweep.<layer>` is (from, to, radius) → hit|null.
const sweep = { building: null, objects: null };
function sweepExport(layer) {
  return (fx, fy, fz, tx, ty, tz, r) => {
    const hit = sweep[layer]?.({ x: fx, y: fy, z: fz }, { x: tx, y: ty, z: tz }, r);
    return hit ? { normalX: 0, normalY: 0, normalZ: 0, ...hit, free() {} } : undefined;
  };
}

globalThis.window = {
  location: { search: "?missileImpactScript=on" },
  // The resolver's lazy play_effect_vfx.js import self-binds to the plugin
  // bus on load; marking it bound skips its 30 s poll for __pluginClient.
  __playEffectVfxBound: true,
  __sessionHandle: {
    entityIsProjectile: () => true,
    entityProjectileHasGravity: () => false,
    entityProjectileAlignsPath: () => false,
    objectPhysicsState: () => physicsState,
    terrainHeightAt: () => terrainZ,
    entityDefaultScript: () => { defaultScriptReads += 1; return PROJECTILE_COLLISION; },
    entityDefaultScriptIntensity: () => 1,
    entityPhysicsScriptTableDid: () => BOLT_TABLE,
    getRenderSet: () => new Uint32Array(0),
    sweepSphereAgainstBuildingMesh: sweepExport("building"),
    sweepSphereAgainstObjects: sweepExport("objects"),
  },
  __hbWasm: {
    async fetchPhysicsScriptTable(did) {
      return JSON.stringify({
        id: did >>> 0,
        scripts: { [String(PROJECTILE_COLLISION)]: [{ mod: 1.0, scriptDid: COLLISION_SCRIPT }] },
      });
    },
  },
};
installFakeMotionSequence();

const THREE = await import("three");
const { EntityManager: OnEM } = await import("../scene3d/entities.js?missileImpactScript=on");
window.location.search = "";
const { EntityManager: DefaultEM } = await import("../scene3d/entities.js?missileImpactScript=default");
window.location.search = "?missileImpactScript=1";
const { EntityManager: OneEM } = await import("../scene3d/entities.js?missileImpactScript=1");
window.location.search = "?missileImpactScript=on&defaultScriptSpawn=off";
const { EntityManager: OnNoSpawnEM } = await import(
  "../scene3d/entities.js?missileImpactScript=on&defaultScriptSpawn=off"
);
window.location.search = "?missileImpactScript=on";

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 30));
};
async function waitFor(pred, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

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

let nextGuid = 0x80007001;
function makeManager(Manager = OnEM) {
  const em = new Manager({
    entitiesGroup: new THREE.Group(),
    materialCache: null,
    lighting: { lightPool: { enabled: true } },
    activeLights: [],
    quality: { preset: "high" },
  }, wasmExports);
  const attached = [];
  em._attachParticleChainForEntity = (...a) => { attached.push(a); return Promise.resolve(); };
  em._prewarmPhysicsScriptTable = async () => {};
  return { em, attached };
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
    recvMs: performance.now() - 200,
    ...extra,
  };
}
const LB_X0 = 0xa9 * 192; // boltMeta's landblock 0xA9B4 → world x origin
/** A wall plane at world x = `wx`, hit from -x: the sphere touches at wx - R. */
function wallAt(wx) {
  return (a, b, r) => {
    const c = wx - r;
    if (a.x >= c || b.x < c) return null;
    return { t: (c - a.x) / (b.x - a.x), x: wx, y: a.y, z: a.z, normalX: -1 };
  };
}
function reset() {
  physicsState = FLAME_BOLT;
  terrainZ = 0;
  defaultScriptReads = 0;
  sweep.building = null;
  sweep.objects = null;
}
/** Spawn a bolt 200 ms into its flight with a wall at x = 12, tick once. */
async function wallStop(Manager, state = FLAME_BOLT) {
  reset();
  physicsState = state;
  const { em, attached } = makeManager(Manager);
  sweep.building = wallAt(LB_X0 + 12);
  const inst = await em.spawn(boltMeta());
  await settle();
  const readsAtSpawn = defaultScriptReads;
  em.tick(0.016);
  assert.equal(inst._ballistic, false, "stopped at the wall");
  return { em, attached, inst, readsAtSpawn };
}

// performance.now() starts near 0 in a fresh process; the launch seed
// ignores a non-positive stamp, so make sure "200 ms ago" is positive.
while (performance.now() < 600) await new Promise((r) => setTimeout(r, 50));

test("pure predicate: client causes + REPORT_COLLISIONS + MISSILE + SCRIPTED_COLLISION", () => {
  assert.equal(PHYSICS_STATE_REPORT_COLLISIONS, 0x8);
  assert.equal(PHYSICS_STATE_MISSILE, 0x40);
  assert.equal(PHYSICS_STATE_SCRIPTED_COLLISION, 0x8000);
  assert.equal(projectileCollisionScriptPlays("client-sweep:sweepSphereAgainstBuildingMesh", FLAME_BOLT), true);
  assert.equal(projectileCollisionScriptPlays("client-sweep:sweepSphereAgainstObjects", FLAME_BOLT), true);
  assert.equal(projectileCollisionScriptPlays("client-sweep:?", FLAME_BOLT), true);
  assert.equal(projectileCollisionScriptPlays("client-terrain", FLAME_BOLT), true);
  assert.equal(projectileCollisionScriptPlays("server-impact", FLAME_BOLT), false);
  assert.equal(projectileCollisionScriptPlays("server-impact-after-client-stop", FLAME_BOLT), false);
  assert.equal(projectileCollisionScriptPlays(null, FLAME_BOLT), false);
  assert.equal(projectileCollisionScriptPlays(undefined, FLAME_BOLT), false);
  assert.equal(projectileCollisionScriptPlays("unknown", FLAME_BOLT), false);
  assert.equal(projectileCollisionScriptPlays("client-terrain", ARROW), false, "arrow: no SCRIPTED_COLLISION");
  assert.equal(projectileCollisionScriptPlays("client-terrain", FLAME_BOLT & ~0x8), false, "impact SetState landed");
  assert.equal(projectileCollisionScriptPlays("client-terrain", FLAME_BOLT & ~0x40), false, "no longer MISSILE");
  assert.equal(projectileCollisionScriptPlays("client-terrain", 0), false, "unknown state");
});

test("opt-in: a client wall stop plays the resolved collision script once", async () => {
  const { em, attached, inst, readsAtSpawn } = await wallStop(OnEM);
  assert.equal(readsAtSpawn, 0, "never consulted at spawn (the spawn skip stays)");
  assert.equal(inst._collisionScriptPlayed, true, "latched");
  assert.ok(await waitFor(() => attached.length > 0), "chain attached");
  assert.equal(defaultScriptReads, 1, "default script read once");
  assert.equal(attached.length, 1);
  const [g, rig, did] = attached[0];
  assert.equal(g, inst.guid >>> 0, "owned by the bolt");
  assert.equal(rig, inst.root, "played on the bolt's root (parked at the contact)");
  assert.equal(did, COLLISION_SCRIPT, "0x5A resolved through the bolt's PhysicsScriptTable");
  assert.ok(Math.abs(inst.root.position.x - (LB_X0 + 11.85)) < 1e-6, "at the contact point");
  const row = em._projectileStops?.[em._projectileStops.length - 1];
  assert.equal(row?.cause, "client-sweep:sweepSphereAgainstBuildingMesh");
  assert.equal(row?.impactScript, true, "stop row marked for __projectileStops()");
  // ACE's impact lands a round-trip later: no second play.
  em.setVelocity({ guid: inst.guid, vx: 0, vy: 0, vz: 0, omegaZ: 0 });
  em._stopBallisticProjectile(inst); // even a forced second stop path
  await settle();
  assert.equal(defaultScriptReads, 1, "not re-read after the server impact");
  assert.equal(attached.length, 1);
  em.dispose();
});

test("opt-in: the client terrain stop plays it", async () => {
  reset();
  const { em, attached } = makeManager(OnEM);
  const inst = await em.spawn(boltMeta({ z: 2, vx: 0, vz: -20 }));
  await settle();
  em.tick(0.016);
  assert.equal(inst._ballistic, false, "stopped on the terrain");
  assert.ok(await waitFor(() => attached.length > 0), "chain attached");
  assert.equal(defaultScriptReads, 1);
  assert.equal(attached[0][2], COLLISION_SCRIPT);
  em.dispose();
});

test("opt-in: the object layer (physics-collision-1) plays it", async () => {
  reset();
  const { em, attached } = makeManager(OnEM);
  sweep.objects = wallAt(LB_X0 + 12);
  const inst = await em.spawn(boltMeta());
  await settle();
  em.tick(0.016);
  assert.equal(inst._ballistic, false, "stopped on the body");
  const row = em._projectileStops?.[em._projectileStops.length - 1];
  assert.equal(row?.cause, "client-sweep:sweepSphereAgainstObjects");
  assert.ok(await waitFor(() => attached.length > 0), "chain attached");
  assert.equal(defaultScriptReads, 1);
  em.dispose();
});

test("opt-in: arrow / impact SetState already applied → no read", async () => {
  for (const state of [ARROW, FLAME_BOLT & ~0x8 /* 0x28B40 */]) {
    const { em, attached, inst } = await wallStop(OnEM, state);
    await settle();
    assert.equal(defaultScriptReads, 0, `state 0x${state.toString(16)}: resolver never consulted`);
    assert.equal(attached.length, 0);
    assert.notEqual(inst._collisionScriptPlayed, true);
    em.dispose();
  }
});

test("opt-in: a server-impact stop → no read", async () => {
  reset();
  const { em, attached } = makeManager(OnEM);
  const inst = await em.spawn(boltMeta());
  await settle();
  em.setVelocity({ guid: inst.guid, vx: 0, vy: 0, vz: 0, omegaZ: 0 });
  assert.equal(inst._ballistic, false, "server impact stop");
  em.tick(0.016);
  await settle();
  assert.equal(defaultScriptReads, 0);
  assert.equal(attached.length, 0);
  em.dispose();
});

test("default (absent), `=1`, and opt-in + ?defaultScriptSpawn=off → silent", async () => {
  for (const [name, M] of [["default", DefaultEM], ["=1", OneEM], ["defaultScriptSpawn=off", OnNoSpawnEM]]) {
    const { em, attached, inst } = await wallStop(M);
    await settle();
    assert.equal(defaultScriptReads, 0, `${name}: resolver never consulted`);
    assert.equal(attached.length, 0, `${name}: nothing played`);
    assert.notEqual(inst._collisionScriptPlayed, true);
    const row = em._projectileStops?.[em._projectileStops.length - 1];
    assert.equal(row?.cause, "client-sweep:sweepSphereAgainstBuildingMesh", `${name}: same stop`);
    assert.equal(row?.impactScript, undefined, `${name}: stop row unchanged`);
    em.dispose();
  }
});

test("sweep radius unchanged (stop-point arithmetic above assumes 0.1 m)", () => {
  assert.equal(PROJECTILE_SWEEP_RADIUS, 0.1);
});
