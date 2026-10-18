// tests/same_guid_respawn.test.mjs — a same-guid respawn (re-sent CreateObject, the
// applyAppearance despawn+respawn fallback, a T9 LOD swap) is the same object to
// the player, and async work started on the OLD rig must not land on it or on the
// new one (2026-10-18 systematic review).
//
//   R1  ENTITIES-1  the selection release of a re-sent CreateObject and of the
//                   appearance fallback is flagged lodRespawn (picking.js then skips
//                   cancelClientMove + CancelAttack); a real delete is not
//   R2  ENTITIES-2  re-selecting the respawned target keeps prevSelectedID
//                   (Select Previous Selection still goes back)
//   R3  ENTITIES-3  a setMotion whose cycle bake resolves after the respawn does not
//                   commit onto the disposed rig
//   R4  (extra)     the same for the death collapse and the cycle one-shot
//   R5  ENTITIES-4  a CallPES sub-script fetched across the respawn is not queued
//   R6  (extra)     a CreateParticle hook's emitter is not parented to the old root,
//                   and a ReplaceObject swap is dropped
//
// The real EntityManager against a wasm mock (the same shape as
// tests/missile_substate_motion.test.mjs), with bakes the test holds open.
//
// Run from apps/holtburger-web/:  node tests/same_guid_respawn.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.__playEffectVfxBound = true;
globalThis.window.__spellShapePreviewBound = true;

const THREE = await import("three");
const { EntityManager } = await import("../scene3d/entities.js");
const { installFakeMotionSequence } = await import("../harness/lib/fake_motion_sequence.mjs");
installFakeMotionSequence();

const ME = 0x50000001;
const NONCOMBAT = 0x8000003d;
const READY = 0x41000003;
const WALK = 0x45000005;
const DEAD = 0x40000011;
const ONESHOT = 0x10000052;
const PART_COUNT = 2;

// Bakes for a held command (low 16 bits) wait until the test releases them.
const held = new Map();
function hold(cmd) {
  let release;
  held.set((cmd >>> 0) & 0xffff, new Promise((r) => { release = r; }));
  return () => { held.delete((cmd >>> 0) & 0xffff); release(); };
}
function partMesh(p) {
  return {
    triCount: 1,
    positions: new Float32Array([p, 0, 0, p + 0.5, 0, 0, p + 0.25, 0.5, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    surfaceIndices: new Uint8Array([0]),
    surfaces: new Uint32Array([0x08001234]),
  };
}
function bake(cmd, stance, fromMotion) {
  const n = 4;
  const partFrames = new Float32Array(n * PART_COUNT * 7);
  for (let i = 0; i < n * PART_COUNT; i += 1) partFrames[i * 7 + 3] = 1;
  const meshes = Array.from({ length: PART_COUNT }, (_, p) => partMesh(p));
  return {
    partCount: PART_COUNT, numFrames: n, framerate: 30,
    resolvedStance: stance || NONCOMBAT, isLink: !!fromMotion, partFrames,
    takePartMeshes() { return meshes.splice(0); },
  };
}
const wasmExports = {
  async fetchEntityAnimationKeyframes(_s, _mc, _tc, _pal, _subs, _mt, cmd, stance, fromMotion) {
    const gate = held.get((cmd >>> 0) & 0xffff);
    if (gate) await gate;
    return bake(cmd >>> 0, stance >>> 0, fromMotion >>> 0);
  },
  // No MotionTable links: every transition is cycle-only.
  async fetchMotionLinkKeyframes() { return undefined; },
  async fetch_surfaces_pixels(dids) {
    return dids.map(() => ({ pixels: new Uint8Array(16).fill(255), width: 2, height: 2 }));
  },
  async fetchEntitySurfacesPixels(dids) {
    return dids.map(() => ({ pixels: new Uint8Array(16).fill(255), width: 2, height: 2 }));
  },
};

let nextGuid = 0x80005a01;
function world() {
  const emitted = [];
  globalThis.window.__pluginClient = { events: { emit: (name, ev) => emitted.push({ name, ev }), on() {} } };
  globalThis.window.__sessionHandle = {
    getLocalPlayerPose() { return { x: 0, y: 0, z: 0, heading: 0, landblockId: 0xa9b40001 }; },
    combatMode() { return 2; },
  };
  globalThis.window.getLocalPlayerGuid = () => ME;
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, wasmExports);
  const clears = () => emitted.filter((e) => e.name === "selectionChanged" && e.ev.guid === 0).map((e) => e.ev);
  return { em, emitted, clears };
}
function meta(guid, extra = {}) {
  return {
    guid, modelId: 0x02000001, mtableId: 0x09000001,
    landblockId: 0xa9b40001, x: 10, y: 10, z: 0, qw: 1, qx: 0, qy: 0, qz: 0,
    paletteId: 0, motionCommand: READY, motionStance: NONCOMBAT, objScale: 1, name: "drudge",
    wcid: 1, itemType: 0x10, iconId: 0,
    modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0),
    subPalettes: new Uint32Array(0),
    ...extra,
  };
}
async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 1));
}

test("R1 ENTITIES-1: a re-sent CreateObject and the appearance fallback are not deselects", async () => {
  const { em, emitted, clears } = world();
  const g = nextGuid++;
  const r1 = await em.spawn(meta(g));
  em._commitSelection(g);
  emitted.length = 0;
  const r2 = await em.spawn(meta(g)); // same guid, still mapped: remove() + rebuild
  assert.notEqual(r2, r1, "rebuilt");
  assert.equal(r1._disposed, true);
  assert.deepEqual(clears().map((d) => [d.prevGuid >>> 0, d.lodRespawn]), [[g, true]], "the release is flagged");
  assert.equal((em._lodRespawnGuid >>> 0) || 0, 0, "the marker is cleared after remove()");
  em._tickSelectionRules(null);
  assert.equal(em.getSelectedTarget(), g, "and the guid is re-selected");

  emitted.length = 0;
  em._hotSwapAppearance = false; // force the remove()+spawn() fallback
  assert.equal(await em.applyAppearance(g, { paletteId: 0x04000002 }), true);
  assert.notEqual(em.entityMap.get(g), r2, "rebuilt");
  assert.deepEqual(clears().map((d) => [d.prevGuid >>> 0, d.lodRespawn]), [[g, true]], "the fallback's release is flagged");
  em._tickSelectionRules(null);
  assert.equal(em.getSelectedTarget(), g);

  emitted.length = 0;
  em.remove(g);
  assert.deepEqual(clears().map((d) => [d.prevGuid >>> 0, d.lodRespawn]), [[g, false]], "a server delete is a real deselect");
  em.dispose();
});

test("R2 ENTITIES-2: the re-select after a same-guid respawn keeps prevSelectedID", async () => {
  const { em } = world();
  globalThis.window.__sessionHandle.combatMode = () => 1; // no auto-target in this one
  const b = nextGuid++;
  const a = nextGuid++;
  await em.spawn(meta(b));
  await em.spawn(meta(a, { x: 12 }));
  em._commitSelection(b);
  em._commitSelection(a);
  assert.equal(em._prevSelectedGuid >>> 0, b);
  await em.spawn(meta(a, { x: 12 })); // same-guid rebuild of the selected A
  em._tickSelectionRules(null);
  assert.equal(em.getSelectedTarget(), a, "A is re-selected");
  assert.equal(em._prevSelectedGuid >>> 0, b, "prevSelectedID is still B");
  assert.equal(em.selectPrevious(), b, "Select Previous Selection goes back to B");

  // A selection change while the rebuild is in flight moves prev on; the
  // re-select keeps that one, not the stale pre-release value.
  const c = nextGuid++;
  await em.spawn(meta(c, { x: 14 }));
  em._commitSelection(a);
  assert.equal(em._prevSelectedGuid >>> 0, b);
  const pending = em.spawn(meta(a, { x: 12 }));
  em._commitSelection(c);
  em._commitSelection(0);
  await pending;
  em._tickSelectionRules(null);
  assert.equal(em.getSelectedTarget(), a, "A is re-selected");
  assert.equal(em._prevSelectedGuid >>> 0, c, "prev is the newer selection C");
  em.dispose();
});

test("R3 ENTITIES-3: a setMotion bake that resolves after a same-guid respawn leaves both rigs alone", async () => {
  const { em } = world();
  const g = nextGuid++;
  const r1 = await em.spawn(meta(g));
  const release = hold(WALK);
  const motion = em.setMotion(g, WALK, NONCOMBAT);
  await settle();
  em.remove(g);
  const r2 = await em.spawn(meta(g));
  const r2Loco = r2._unifiedLoco;
  release();
  await motion;
  await settle();
  assert.equal(r1._unifiedLoco, null, "no MotionSequence is hung on the disposed rig");
  assert.notEqual(r1._committedMotion >>> 0, WALK, "the stale walk did not commit on R1");
  assert.equal(r2._unifiedLoco, r2Loco, "the new rig keeps its own cycle");
  em.dispose();
});

test("R4 (extra): the death collapse and the cycle one-shot do not land on a respawned rig", async () => {
  const { em } = world();
  const g = nextGuid++;
  const r1 = await em.spawn(meta(g));
  let release = hold(DEAD);
  const death = em.setMotion(g, DEAD, NONCOMBAT);
  await settle();
  em.remove(g);
  const r2 = await em.spawn(meta(g));
  release();
  await death;
  await settle();
  assert.equal(r1._unifiedSeq ?? null, null, "no death hold on the disposed rig");
  assert.equal(r2._unifiedSeq ?? null, null, "nor on the new one");

  release = hold(ONESHOT);
  const shot = em._tryUnifiedCycleOneShot(g, 0x02000001, 0x09000001, ONESHOT, NONCOMBAT);
  await settle();
  em.remove(g);
  const r3 = await em.spawn(meta(g));
  release();
  assert.equal(await shot, false, "the one-shot reports nothing played");
  assert.equal(r2._unifiedSeq ?? null, null, "no one-shot on the disposed rig");
  assert.equal(r3._unifiedSeq ?? null, null);
  em.dispose();
});

test("R5 ENTITIES-4: a CallPES sub-script fetched across a same-guid respawn is dropped", async () => {
  const { em } = world();
  const g = nextGuid++;
  const r1 = { guid: g, root: new THREE.Group(), parts: [], meta: { guid: g } };
  em.entityMap.set(g, r1);
  let resolveFetch;
  em.wasmExports = { fetchPhysicsScript: () => new Promise((r) => { resolveFetch = r; }) };
  const queued = [];
  em._queuePhysicsScript = (...args) => { queued.push(args); };
  const hook = { hookType: 19, callPesDid: 0x33000002, callPesPause: 0 };

  em._executeScriptHook(g, r1.root, 0x33000001, hook, 0, -1);
  resolveFetch({ takeEntries: () => [] });
  await settle();
  assert.equal(queued.length, 1, "control: the live owner's sub-script is queued");

  queued.length = 0;
  em._executeScriptHook(g, r1.root, 0x33000001, hook, 0, -1);
  r1._disposed = true; // remove(g) …
  em.entityMap.set(g, { guid: g, root: new THREE.Group(), parts: [], meta: { guid: g } }); // … spawn(g)
  resolveFetch({ takeEntries: () => [] });
  await settle();
  assert.equal(queued.length, 0, "the old rig's loop does not continue on the new rig");
  em.dispose();
});

test("R6 (extra): CreateParticle and ReplaceObject hooks across a same-guid respawn", async () => {
  const { em } = world();
  const g = nextGuid++;
  const mk = () => ({ guid: g, root: new THREE.Group(), parts: [new THREE.Group()], meta: { guid: g }, geometries: [] });
  const added = [];
  const mgr = { addEmitter: async (req) => { added.push(req); return 7; } };
  em._worldParticleManager = mgr;
  em._ensureWorldParticleManager = async () => mgr;
  let resolveEmitter;
  let resolvePlacement;
  em.wasmExports = {
    fetchParticleEmitter: () => new Promise((r) => { resolveEmitter = r; }),
    fetchBuildingPlacement: () => new Promise((r) => { resolvePlacement = r; }),
  };
  const hook = { emitterInfoId: 0x32000001, createPartIndex: 0xffffffff, particleEmitterId: 0 };

  const r1 = mk();
  em.entityMap.set(g, r1);
  let p = em._fireCreateParticleHook(r1, hook);
  await settle();
  resolveEmitter({});
  await p;
  assert.equal(added.length, 1, "control: the live rig gets its emitter");
  assert.equal(added[0].parent, r1.root);

  added.length = 0;
  p = em._fireCreateParticleHook(r1, hook);
  await settle();
  r1._disposed = true;
  const r2 = mk();
  em.entityMap.set(g, r2);
  resolveEmitter({});
  await p;
  assert.equal(added.length, 0, "no emitter under the disposed root");

  let took = 0;
  let freed = 0;
  p = em._fireReplaceObjectHook(r2, 0, 0x01000abc);
  await settle();
  r2._disposed = true;
  em.entityMap.set(g, mk());
  resolvePlacement({ partCount: 1, takePartMeshes() { took += 1; return []; }, free() { freed += 1; } });
  await p;
  assert.equal(took, 0, "the swap on the disposed rig is dropped");
  assert.equal(freed, 1, "and the placement bundle is still freed");
  em.dispose();
});
