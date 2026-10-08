// tests/anim_hook_callpes.test.mjs — the CallPES (19) ANIMATION hook belongs
// to the object that played it (anim-hooks-3, 2026-10-08).
//
// Retail CPhysicsObj::CallPES (acclient.c:318973-319005) parks a delayed call
// on the object's own hook list, so it dies with the object; a pause under
// 0.0002 plays at once. Ours armed a wall-clock setTimeout guarded by guid
// only, so a despawn + respawn under the same guid inside the pause attached
// the old object's effect to the new one.
//
//   P1  queue path: the sub-script joins the owner's ScriptManager at
//       now + RollDice(0, pause)
//   P2  queue path: a respawn (or despawn) during the fetch queues nothing
//   P3  `?scriptQueue=off`: the timer is the same-instance-guarded and despawn
//       cancels it
//
// `window.location` is stubbed BEFORE entities.js loads so `?scriptQueue` reads
// its browser default (on); P3 loads a second module instance under
// `?scriptQueue=off`.
//
// Run: node tests/anim_hook_callpes.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { location: { search: "" } };
const THREE = await import("three");
const { EntityManager } = await import("../scene3d/entities.js");
window.location.search = "?scriptQueue=off";
const { EntityManager: LegacyEntityManager } = await import("../scene3d/entities.js?scriptQueue=off");
window.location.search = "";
const { currentTime, setRng } = await import("../scene3d/particles/time_rng.js");

const PES = 0x33000123;
const callPes = (pause) => ({ hookType: 19, callPesDid: PES, callPesPause: pause, direction: 0 });
const settle = async () => { for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0)); };

let nextGuid = 0x80003001;
async function setup(Manager = EntityManager) {
  const fetches = [];
  const wasmExports = {
    // No animation for these rigs: only the hook arm is under test.
    async fetchEntityAnimationKeyframes() {
      return { partCount: 0, numFrames: 0, framerate: 0, resolvedStance: 0x3d, partFrames: new Float32Array(0) };
    },
    fetchPhysicsScript(did) {
      let resolve;
      const p = new Promise((r) => { resolve = r; });
      fetches.push({ did, resolve: () => resolve({ takeEntries: () => ["entry"] }) });
      return p;
    },
  };
  const em = new Manager({ entitiesGroup: new THREE.Group(), materialCache: null }, wasmExports);
  const queued = [];
  em._queuePhysicsScript = (...args) => { queued.push(args); return { ok: true }; };
  const attached = [];
  em._attachParticleChainForEntity = (...args) => { attached.push(args); return Promise.resolve(); };
  const spawn = () => em.spawn({
    guid: nextGuid, modelId: 0x02000001, mtableId: 0, landblockId: 0xa9b40001,
    x: 10, y: 10, z: 0, qw: 1, qx: 0, qy: 0, qz: 0, paletteId: 0, motionCommand: 0,
    motionStance: 0, objScale: 1, name: "t", wcid: 1, itemType: 0x10, iconId: 0,
    modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0),
    subPalettes: new Uint32Array(0),
  });
  const inst = await spawn();
  nextGuid += 1;
  return { em, inst, fetches, queued, attached, spawn };
}

test("P1 queue path: the sub-script starts on the owner's queue at now + RollDice(0, pause)", async () => {
  const { em, inst, fetches, queued } = await setup();
  const t0 = currentTime();
  em._fireHook(inst, callPes(0), null, null);
  assert.equal(fetches.length, 1);
  fetches[0].resolve();
  await settle();
  assert.equal(queued.length, 1);
  const [guid, rig, did, entries, depth, part, startNow] = queued[0];
  assert.equal(guid, inst.guid >>> 0);
  assert.equal(rig, inst.root);
  assert.equal(did, PES);
  assert.deepEqual(entries, ["entry"]);
  assert.equal(depth, 0);
  assert.equal(part, -1);
  assert.ok(startNow >= t0 && startNow - t0 < 0.05, "pause 0 plays at once");

  setRng(() => 0.999);
  try {
    const t1 = currentTime();
    em._fireHook(inst, callPes(0.5), null, null);
    fetches[1].resolve();
    await settle();
    const start = queued[1][6];
    assert.ok(start - t1 > 0.45 && start - t1 < 0.55, `RollDice(0, 0.5) at rng 0.999: ${start - t1}`);
  } finally {
    setRng(null);
  }
  em.dispose();
});

test("P2 queue path: a respawn or despawn during the fetch queues nothing", async () => {
  const { em, inst, fetches, queued, spawn } = await setup();
  em._fireHook(inst, callPes(0), null, null);
  em.remove(inst.guid);
  nextGuid -= 1; // respawn the SAME guid
  const reborn = await spawn();
  nextGuid += 1;
  assert.ok(reborn && reborn !== inst, "a new object under the same guid");
  fetches[0].resolve();
  await settle();
  assert.equal(queued.length, 0, "the old object's effect does not reach the respawn");

  em._fireHook(reborn, callPes(0), null, null);
  em.remove(reborn.guid);
  fetches[1].resolve();
  await settle();
  assert.equal(queued.length, 0, "nor a despawned object");
  em.dispose();
});

test("P3 `?scriptQueue=off`: the timer is instance-guarded and despawn cancels it", async () => {
  setRng(() => 0.999);
  try {
    const { em, inst, attached, spawn } = await setup(LegacyEntityManager);
    const g = inst.guid >>> 0;
    em._fireHook(inst, callPes(0.03), null, null);
    assert.equal(em._soundTimeoutsForGuid.get(g)?.length, 1, "timer registered with the guid");
    em.remove(g);
    assert.equal(em._soundTimeoutsForGuid.has(g), false, "despawn cancelled it");
    nextGuid -= 1;
    const reborn = await spawn();
    nextGuid += 1;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(attached.length, 0, "nothing fired onto the respawn");

    em._fireHook(reborn, callPes(0.03), null, null);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(attached.length, 1, "a live object still gets its effect");
    assert.equal(attached[0][1], reborn.root, "on its own rig");
    assert.equal(em._soundTimeoutsForGuid.get(g)?.length ?? 0, 0, "fired timer removed itself");
    em.dispose();
  } finally {
    setRng(null);
  }
});
