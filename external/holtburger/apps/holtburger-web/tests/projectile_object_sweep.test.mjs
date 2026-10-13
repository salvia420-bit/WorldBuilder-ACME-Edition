// tests/projectile_object_sweep.test.mjs — physics-collision-1 (2026-10-13,
// `?missileObjSweep=off` escape, default ON).
//
// Retail `OBJECTINFO::missile_ignore` (acclient.c:314070) exempts a creature
// from a missile only when `targetID != 0`, and the client only ever writes
// `targetID = 0` (:311603, :312155): every solid body in a missile's path —
// the target, bystanders, the local player — stops it locally. The wasm
// object layer `sweepSphereAgainstObjects` (cargo-tested in
// crates/holtburger-world/src/spatial/missile_sweep.rs) is mocked here; this
// pins the JS plumbing:
//   1. an object hit stops the bolt short of contact, cause
//      `client-sweep:sweepSphereAgainstObjects`, missile guid passed;
//   2. an embedded start moving outward never stops; moving inward past the
//      launch window does;
//   3. an ETHEREAL missile skips the door layer (retail obstruction_ethereal,
//      :316201-316212); the object layer still runs (STATIC objects stop it —
//      the wasm filters);
//   4. the local player is exempt for a missile born within 4 m of it (our
//      own launch), not for a far-spawned one; the decision is sticky;
//   5. stale pkg (no export) = legacy; `objects: false` skips the layer;
//   6. `?missileObjSweep=off` (ctx builder lifted with the flag off): no
//      object layer, no ETHEREAL rule.
//
// Drives the REAL EntityManager spawn → tick path (mocked wasm + session
// handle), like tests/projectile_visual_fidelity.test.mjs.
//
// Run: node tests/projectile_object_sweep.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { EntityManager } from "../scene3d/entities.js";
import {
  PROJECTILE_OWN_LAUNCH_M,
  PROJECTILE_SWEEP_RADIUS,
  projectileExemptsLocalPlayer,
  projectileIsEthereal,
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
const sweep = { entities: null, objects: null };
const calls = [];
let freedHits = 0;
function sweepExport(layer) {
  return (fx, fy, fz, tx, ty, tz, r, ...extra) => {
    const a = { x: fx, y: fy, z: fz }, b = { x: tx, y: ty, z: tz };
    calls.push({ layer, from: a, to: b, r, extra });
    const hit = sweep[layer]?.(a, b, r, ...extra);
    return hit ? { normalX: 0, normalY: 0, normalZ: 0, ...hit, free() { freedHits += 1; } } : undefined;
  };
}

let physicsState = 0x28b48; // Flame Bolt: MISSILE|LIGHTING_ON|ALIGN_PATH|... (not ETHEREAL)
let playerPose = null; // wasm LocalPlayerPose: landblock-local x/y + landblockId
window.__sessionHandle = {
  entityIsProjectile: () => true,
  entityProjectileHasGravity: () => false,
  entityProjectileAlignsPath: () => false,
  objectPhysicsState: () => physicsState,
  terrainHeightAt: () => 0,
  entityDefaultScript: () => 0,
  entityDefaultScriptIntensity: () => 1,
  getRenderSet: () => new Uint32Array(0),
  getLocalPlayerPose: () => (playerPose ? { ...playerPose, free() {} } : undefined),
  sweepSphereAgainstEntities: sweepExport("entities"),
  sweepSphereAgainstObjects: sweepExport("objects"),
};

let nextGuid = 0x80000101;
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
const LB_X0 = 0xa9 * 192; // boltMeta's landblock 0xA9B4 → world x origin
const R = PROJECTILE_SWEEP_RADIUS;
function reset() {
  sweep.entities = null;
  sweep.objects = null;
  calls.length = 0;
  physicsState = 0x28b48;
  playerPose = null;
}
/** A body surface at world x = `wx`, hit from -x: the sphere touches at wx - R. */
function surfaceAt(wx) {
  return (a, b, r) => {
    const c = wx - r;
    if (a.x >= c || b.x < c) return null;
    return { t: (c - a.x) / (b.x - a.x), normalX: -1 };
  };
}
/** An embedded-start hit (t = 0) when the step starts at world x = `wx`. */
function embeddedAt(wx, normalX) {
  return (a) => (Math.abs(a.x - wx) < 1e-9 ? { t: 0, normalX } : null);
}
const tickAfter = (em, ms) => new Promise((r) => setTimeout(() => { em.tick(0.016); r(); }, ms));
const objectCallsFor = (guid) => calls.filter((c) => c.layer === "objects" && c.extra[0] === guid >>> 0);

// The flight clock anchors at a positive receipt stamp (the seed ignores a
// non-positive one), so make "200 ms ago" positive.
while (performance.now() < 600) await new Promise((r) => setTimeout(r, 50));

test("pure helpers: own-launch exemption, ETHEREAL bit", () => {
  const L = { x: 0, y: 0, z: 0 };
  assert.equal(PROJECTILE_OWN_LAUNCH_M, 4);
  assert.equal(projectileExemptsLocalPlayer(L, null), true, "no player pose → exempt");
  assert.equal(projectileExemptsLocalPlayer(null, L), true, "no launch point → exempt");
  assert.equal(projectileExemptsLocalPlayer(L, { x: 3.9, y: 0, z: 0 }), true, "our own launch");
  assert.equal(projectileExemptsLocalPlayer(L, { x: 0, y: 3, z: 2.9 }), false, "3D distance ≥ 4 m");
  assert.equal(projectileExemptsLocalPlayer(L, { x: 40, y: 0, z: 0 }), false, "a monster's bolt");
  assert.equal(projectileExemptsLocalPlayer(L, { x: NaN, y: 0, z: 0 }), true, "unknown → exempt");
  assert.equal(projectileIsEthereal(0x28b48), false);
  assert.equal(projectileIsEthereal(0x28b48 | 0x4), true);
  assert.equal(projectileIsEthereal(0), false, "unknown state → solid");
  assert.equal(projectileIsEthereal(0xffffffff), true);
});

test("sweepProjectileSegment: object layer args, earliest t, ETHEREAL skips doors, stale pkg", () => {
  reset();
  const sh = window.__sessionHandle;
  const a = { x: 0, y: 0, z: 1 }, b = { x: 2, y: 0, z: 1 };
  sweep.entities = () => ({ t: 0.8, normalX: -1 });
  sweep.objects = () => ({ t: 0.5, normalX: -1 });
  const out = {};
  const freed0 = freedHits;
  assert.equal(sweepProjectileSegment(sh, a, b, { missileGuid: 0x80001234, exemptLocalPlayer: true, out }), 0.5);
  assert.equal(out.layer, "sweepSphereAgainstObjects", "the earlier object hit wins");
  assert.equal(freedHits - freed0, 2, "every hit box freed");
  const oc = calls.find((c) => c.layer === "objects");
  assert.equal(oc.r, R);
  assert.deepEqual(oc.extra, [0x80001234, true], "(…, radius, missileGuid, exemptLocalPlayer)");
  calls.length = 0;
  assert.equal(sweepProjectileSegment(sh, a, b, { ethereal: true, missileGuid: 7 }), 0.5);
  assert.equal(calls.filter((c) => c.layer === "entities").length, 0, "ETHEREAL missile: no door layer");
  assert.deepEqual(calls.find((c) => c.layer === "objects").extra, [7, false]);
  calls.length = 0;
  assert.equal(sweepProjectileSegment(sh, a, b, { objects: false }), 0.8, "object layer skippable");
  assert.equal(calls.filter((c) => c.layer === "objects").length, 0);
  // Stale pkg: only the door export exists — legacy result, no throw.
  const stale = { sweepSphereAgainstEntities: sh.sweepSphereAgainstEntities };
  assert.equal(sweepProjectileSegment(stale, a, b, { missileGuid: 7 }), 0.8);
  reset();
});

test("a creature on the path stops the bolt short of contact", async () => {
  reset();
  const em = makeManager();
  sweep.objects = surfaceAt(LB_X0 + 12);
  const inst = await em.spawn(boltMeta({ recvMs: performance.now() - 200 }));
  em.tick(0.016);
  assert.equal(inst._ballistic, false, "stopped at the body");
  // First 0.1 s substep: 10 → 12, contact at t = 0.95, backed off 0.05 m.
  assert.ok(Math.abs(inst.root.position.x - (LB_X0 + 11.85)) < 1e-6, `x ${inst.root.position.x - LB_X0}`);
  const row = em._projectileStops?.at(-1);
  assert.equal(row?.cause, "client-sweep:sweepSphereAgainstObjects");
  const oc = objectCallsFor(inst.guid);
  assert.ok(oc.length > 0, "object layer swept with the missile's guid");
  assert.equal(oc[0].extra[1], true, "no player pose → the local player is exempt");
  const xs = inst.root.position.x;
  await tickAfter(em, 20);
  assert.equal(inst.root.position.x, xs, "stays put");
  em.dispose();
  reset();
});

test("an embedded start moving outward never stops; inward past the launch window does", async () => {
  reset();
  const em = makeManager();
  // Born inside a body, heading out of it (normal along the motion).
  sweep.objects = embeddedAt(LB_X0 + 10, +1);
  const inst = await em.spawn(boltMeta({ recvMs: performance.now() - 120 }));
  em.tick(0.016);
  assert.equal(inst._ballistic, true, "leaving the body: flies on");
  const x1 = inst.root.position.x;
  assert.ok(x1 > LB_X0 + 12, "flew on");
  sweep.objects = embeddedAt(x1, +1);
  await tickAfter(em, 20);
  assert.equal(inst._ballistic, true, "separating embedded hit ignored after launch too");
  // Embedded and moving INTO a body past the launch window: stop where it is.
  const x2 = inst.root.position.x;
  sweep.objects = embeddedAt(x2, -1);
  await tickAfter(em, 20);
  assert.equal(inst._ballistic, false, "stopped");
  assert.equal(inst.root.position.x, x2, "at the contact, not past it");
  em.dispose();
  reset();
});

test("an ETHEREAL missile passes the door layer; the object layer still runs", async () => {
  reset();
  let em = makeManager();
  physicsState = 0x28b48 | 0x4; // Rolling Death / spell_projectile_ethereal
  sweep.entities = surfaceAt(LB_X0 + 12);
  const inst = await em.spawn(boltMeta({ recvMs: performance.now() - 200 }));
  em.tick(0.016);
  assert.equal(inst._ballistic, true, "flies through the closed door");
  assert.equal(calls.filter((c) => c.layer === "entities").length, 0, "door layer not swept");
  assert.ok(objectCallsFor(inst.guid).length > 0, "object layer swept (STATIC objects still stop it)");
  em.dispose();
  // Control: the same bolt, solid, stops at the door.
  reset();
  em = makeManager();
  sweep.entities = surfaceAt(LB_X0 + 12);
  const solid = await em.spawn(boltMeta({ recvMs: performance.now() - 200 }));
  em.tick(0.016);
  assert.equal(solid._ballistic, false, "solid bolt: door stop");
  assert.equal(em._projectileStops?.at(-1)?.cause, "client-sweep:sweepSphereAgainstEntities");
  em.dispose();
  reset();
});

test("local player: exempt for our own launch, not for a far-spawned bolt; sticky", async () => {
  reset();
  const em = makeManager();
  // 2 m from the launch point (world LB_X0 + 10): our own bolt.
  playerPose = { x: 12, y: 10, z: 50, landblockId: 0xa9b40001 };
  const own = await em.spawn(boltMeta({ recvMs: performance.now() - 50 }));
  em.tick(0.016);
  assert.equal(objectCallsFor(own.guid)[0]?.extra[1], true, "own launch exempt");
  // 50 m away: a monster's bolt — our body stops it.
  playerPose = { x: 60, y: 10, z: 50, landblockId: 0xa9b40001 };
  const far = await em.spawn(boltMeta({ recvMs: performance.now() - 50 }));
  await tickAfter(em, 20);
  assert.equal(objectCallsFor(far.guid)[0]?.extra[1], false, "far-spawned bolt: player collides");
  // Decided once per flight: the player stepping next to it changes nothing.
  playerPose = { x: 11, y: 10, z: 50, landblockId: 0xa9b40001 };
  calls.length = 0;
  await tickAfter(em, 20);
  assert.equal(objectCallsFor(far.guid).at(-1)?.extra[1], false, "sticky");
  assert.equal(objectCallsFor(own.guid).at(-1)?.extra[1], true, "sticky");
  em.dispose();
  reset();
});

// ---- `?missileObjSweep=off`: the ctx builder + per-missile opts, lifted ----
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
const makeCtxHarness = (flagOn) => new Function(
  "projectileIsEthereal",
  "projectileExemptsLocalPlayer",
  `
  const PROJECTILE_OBJ_SWEEP_ON = ${flagOn};
  const PHYSICS_STATE_HAS_PHYSICS_BSP = 0x10000;
  return class {
    ${methodSource("_buildProjectileSweepCtx")}
    ${methodSource("_projectileObjectSweepOpts")}
    _localPlayerWorldPose() { return null; }
  };
`,
)(projectileIsEthereal, projectileExemptsLocalPlayer);

test("?missileObjSweep=off: no object layer and no ETHEREAL rule (legacy)", () => {
  reset();
  physicsState = 0x28b48 | 0x4;
  for (const [flagOn, expectOn] of [[false, false], [true, true]]) {
    const H = makeCtxHarness(flagOn);
    const h = new H();
    h.entityMap = new Map();
    const ctx = h._buildProjectileSweepCtx();
    assert.equal(ctx.objects, expectOn, `objects (flag ${flagOn})`);
    assert.equal(ctx.etherealRule, expectOn, `etherealRule (flag ${flagOn})`);
    const inst = { guid: 0x80000001, _ballisticLaunch: { x: 0, y: 0, z: 0 } };
    const o = h._projectileObjectSweepOpts(inst, ctx);
    assert.equal(o.ethereal, expectOn, `ETHEREAL missile read (flag ${flagOn})`);
    assert.equal(o.exemptLocalPlayer, true, "unknown player pose → exempt");
  }
  // Stale pkg (no `sweepSphereAgainstObjects`): no object layer, the
  // ETHEREAL rule still applies (it only needs `objectPhysicsState`).
  const saved = window.__sessionHandle.sweepSphereAgainstObjects;
  delete window.__sessionHandle.sweepSphereAgainstObjects;
  try {
    const H = makeCtxHarness(true);
    const h = new H();
    h.entityMap = new Map();
    const ctx = h._buildProjectileSweepCtx();
    assert.equal(ctx.objects, false);
    assert.equal(ctx.etherealRule, true);
  } finally {
    window.__sessionHandle.sweepSphereAgainstObjects = saved;
  }
  reset();
});
