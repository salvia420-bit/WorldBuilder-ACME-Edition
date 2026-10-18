// tests/static_script_radius_race.test.mjs — ?staticScriptRadius vs the
// time-sliced attach / rebuild and pending timers (2026-10-18 review,
// STREAM-STATICS-1 / STREAM-STATICS-2).
//
// The radius tick read "landblock in `deferred`" as "every anchor of it is torn
// down". A crossing during the attach (or an unpark rebuild) broke that: the
// anchors chained before the crossing kept their emitters, the rest were
// deferred and the landblock went into `deferred`. The tick then never tore
// those emitters down, and on return rebuilt every anchor (doubled emitters
// and CallPES loops).
//   R1  split by the attach (d2 → d3 mid-attach): leaving to d4 tears the
//       chained anchors down; returning (from d4, or straight from d3) rebuilds
//       only the deferred one — one emitter per anchor, never two
//   R2  an anchor still awaiting its part frames when the tick rebuilds is left
//       to its attach (the rebuild used to run its chain, then the attach again)
//   R3  overlapping rebuilds (d2 → d4 → d2 while the first is mid-chain): the
//       first run drops the anchors the second claimed
//   R4  a pending start_time > 0 create armed before a teardown is dropped
//       (STREAM-STATICS-2; destroySome leaves the owner epoch alone)
//   R5  a create in flight across a teardown is destroyed when it lands
//   R6  an interior anchor unparked outside the radius still gets its chain
//       (the tick never rebuilds interior anchors)
//   R7  an unpark's rebuild ends the CallPES loop still pending from before
//       the park (it used to run beside the rebuild's new loop)
//   R8  a teardown during a CallPES pass's awaits ends that loop (the pass
//       used to land its emitter and re-arm under the new epoch)
//   R9  a park while an anchor awaits its part frames (park keeps the LB in
//       staticsBakedLbs): an unpark before the attach resumes runs the chain
//       once (the attach used to run it again); an attach resuming while still
//       parked neither chains nor freezes the detached anchor; the interior
//       attach does the same
//
// Drives the shipped attachStaticDefaultScripts / tickStaticScriptRadius /
// rebuildStaticScriptEmittersForAnchors with a recording manager (pre-seeded on
// the host, so `_ensureStaticParticleManager` returns it as-is) and fake wasm.
//
// Run from apps/holtburger-web/:  node tests/static_script_radius_race.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.requestAnimationFrame ??= () => 0;
globalThis.window.cancelAnimationFrame ??= () => {};

const S = await import("../scene3d/statics.js");
const { staticOwnerKeyForLb } = await import("../scene3d/vfx/particle_attach.js");
S.__setStaticScriptRadiusForTest(2);
S.__setStaticPartAnchorForTest(true);

const realSetTimeout = globalThis.setTimeout;
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => realSetTimeout(r, 0)); };
const lb = (x, y) => (((x & 0xff) << 24) | ((y & 0xff) << 16)) >>> 0;
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const HOOK_CREATE = 13;
const HOOK_CALL_PES = 19;
function createHook(startTime, emitterDid) {
  return {
    startTime, hookType: HOOK_CREATE, createParticleEmitterId: emitterDid,
    createParticlePartIndex: 0xffffffff,
    createParticleOffsetX: 0, createParticleOffsetY: 0, createParticleOffsetZ: 0,
    createParticleOffsetQX: 0, createParticleOffsetQY: 0, createParticleOffsetQZ: 0, createParticleOffsetQW: 1,
  };
}
function callPesHook(startTime, did) {
  const hookData = new Uint8Array(8);
  new DataView(hookData.buffer).setUint32(0, did, true);
  return { startTime, hookType: HOOK_CALL_PES, hookData };
}
const S0 = 0x33000a00, S1 = 0x33000a01, S2 = 0x33000a02, S5 = 0x33000a05, S7 = 0x33000a07;
const E0 = 0x32000a00, E1 = 0x32000a01, E2 = 0x32000a02, E5 = 0x32000a05, E7 = 0x32000a07;
const SCRIPTS = new Map([
  [S0, () => [createHook(0, E0)]],
  [S1, () => [createHook(0, E1)]],
  [S2, () => [createHook(0, E2)]],
  [S5, () => [createHook(5, E5)]], // a create authored 5 s into the script
  [S7, () => [createHook(0, E7), callPesHook(5, S7)]], // ambient self-loop, 5 s period
]);
const emitterGates = new Map(); // emitter did → promise the fetch waits on
const poseGates = new Map(); // setup id → promise fetchSetupPartPose waits on
const addGates = new Map(); // emitter did → promise manager.addEmitter waits on
const scriptFetches = [];
const wasm = {
  fetchPhysicsScript: async (did) => {
    scriptFetches.push(did >>> 0);
    return { takeEntries: SCRIPTS.get(did >>> 0), free() {} };
  },
  fetchParticleEmitter: async (did) => {
    const g = emitterGates.get(did >>> 0);
    if (g) await g;
    return { id: did >>> 0, hwGfxObjId: 0x01000001 };
  },
  fetchSetupPartPose: async (sid) => {
    const g = poseGates.get(sid >>> 0);
    if (g) await g;
    return null; // no part frames: hooks root at the anchor
  },
};
// The tick's rebuild runs the shipped warm-park rebuild on the host.
S.__setStaticScriptRebuildForTest((h, anchors) => S.rebuildStaticScriptEmittersForAnchors(h, anchors, wasm));

function makeWorld(L) {
  let next = 1;
  const mgr = {
    particleTable: new Map(),
    async addEmitter(req) {
      const g = addGates.get(req.emitterInfo.id >>> 0);
      if (g) await g;
      const id = next++;
      this.particleTable.set(id, { parent: req.parent, did: req.emitterInfo.id >>> 0 });
      return id;
    },
    destroyParticleEmitter(id) { return this.particleTable.delete(id); },
    stopParticleEmitter() { return false; },
  };
  const staticsGroup = new THREE.Group();
  const host = { staticsGroup, staticsBakedLbs: new Set([L]), _staticParticleManager: mgr };
  staticsGroup.userData.__staticsHost = host;
  // What cells.js ticks with: the liveScene3d facade (same group + baked set).
  const facade = { staticsGroup, staticsBakedLbs: host.staticsBakedLbs };
  const at = (x) => S.tickStaticScriptRadius(facade, new Set([lb(x, (L >>> 16) & 0xff)]));
  const anchors = () => staticsGroup.children.filter((c) => c.userData?.isStaticScriptAnchor);
  const counts = () => anchors().map((a) => [...mgr.particleTable.values()].filter((e) => e.parent === a).length);
  return { host, facade, mgr, staticsGroup, at, anchors, counts };
}
const place = (L, did, i, modelId = 0x01000001) =>
  ({ landblockId: L, x: 10 + i, y: 20, z: 1, defaultScriptId: did, modelId, scale: 1 });

/** Hold every timer of >= 1 s (the 5 s hook / CallPES delays) for manual firing. */
function holdLongTimers() {
  const held = [];
  globalThis.setTimeout = (fn, ms, ...a) => {
    if (ms >= 1000) { held.push(fn); return held.length + 1e6; }
    return realSetTimeout(fn, ms, ...a);
  };
  return { held, restore() { globalThis.setTimeout = realSetTimeout; } };
}

async function splitByAttach(L, x0) {
  // Player at d2: the attach starts; anchor 0 chains, anchor 1 waits on its
  // emitter fetch; the player crosses to d3; anchor 1 lands, anchor 2 is
  // deferred at attach (the landblock goes into `deferred`).
  const w = makeWorld(L);
  w.at(x0 - 2);
  const g = deferred();
  emitterGates.set(E1, g.promise);
  const attach = S.attachStaticDefaultScripts(w.host, [place(L, S0, 0), place(L, S1, 1), place(L, S2, 2)], wasm);
  await settle();
  w.at(x0 - 3);
  g.resolve();
  await attach;
  emitterGates.delete(E1);
  assert.deepEqual(w.counts(), [1, 1, 0], "split: two chained, one deferred");
  assert.equal(w.host._staticScriptRadius.deferred.has(L), true);
  return w;
}

test("R1: a landblock split by its attach is torn down at d4 and rebuilt without doubles", async () => {
  const L = lb(0xa4, 0x1e);
  const w = await splitByAttach(L, 0xa4);
  w.at(0xa0); // d4
  assert.deepEqual(w.counts(), [0, 0, 0], "every chained anchor torn down");
  assert.ok(w.anchors().every((a) => a.userData.__scriptDeferred === true));
  w.at(0xa2); // d2
  await settle();
  assert.deepEqual(w.counts(), [1, 1, 1], "one emitter per anchor after the return");
});

test("R1b: returning straight from the hysteresis band rebuilds only the deferred anchor", async () => {
  const L = lb(0xa4, 0x2e);
  const w = await splitByAttach(L, 0xa4);
  w.at(0xa2); // d2
  await settle();
  assert.deepEqual(w.counts(), [1, 1, 1]);
  assert.ok(w.anchors().every((a) => a.userData.__scriptDeferred === false));
});

test("R2: an anchor awaiting its part frames is left to its attach", async () => {
  const L = lb(0xb4, 0x1e);
  const SETUP = 0x02000b02;
  const w = makeWorld(L);
  w.at(0xb2); // d2
  const gE = deferred();
  const gPose = deferred();
  emitterGates.set(E0, gE.promise);
  poseGates.set(SETUP, gPose.promise);
  const attach = S.attachStaticDefaultScripts(
    w.host, [place(L, S0, 0), place(L, S1, 1), place(L, S2, 2, SETUP)], wasm);
  await settle(); // anchor 0 mid-chain
  w.at(0xb1); // d3
  gE.resolve();
  await settle(); // anchor 0 chained, anchor 1 deferred, anchor 2 awaits its pose
  assert.equal(w.anchors().length, 3);
  assert.deepEqual(w.counts(), [1, 0, 0]);
  w.at(0xb2); // d2 again: the tick rebuilds while anchor 2 is mid-attach
  await settle();
  gPose.resolve();
  await attach;
  await settle();
  emitterGates.delete(E0);
  poseGates.delete(SETUP);
  assert.deepEqual(w.counts(), [1, 1, 1], "one emitter per anchor");
});

test("R3: overlapping tick rebuilds never both run an anchor's chain", async () => {
  const L = lb(0xc4, 0x1e);
  const w = makeWorld(L);
  w.at(0xc0); // d4: every anchor deferred at attach
  await S.attachStaticDefaultScripts(w.host, [place(L, S0, 0), place(L, S1, 1), place(L, S2, 2)], wasm);
  assert.deepEqual(w.counts(), [0, 0, 0]);
  const g = deferred();
  emitterGates.set(E1, g.promise);
  w.at(0xc2); // d2 → rebuild #1: anchor 0 chained, anchor 1 mid-chain
  await settle();
  assert.deepEqual(w.counts(), [1, 0, 0]);
  w.at(0xc0); // d4 → teardown
  assert.deepEqual(w.counts(), [0, 0, 0]);
  w.at(0xc2); // d2 → rebuild #2
  g.resolve();
  await settle();
  emitterGates.delete(E1);
  assert.deepEqual(w.counts(), [1, 1, 1], "one emitter per anchor");
});

test("R4: a pending start_time > 0 create is dropped by the radius teardown", async () => {
  const t = holdLongTimers();
  try {
    const L = lb(0xd4, 0x1e);
    const w = makeWorld(L);
    w.at(0xd2);
    await S.attachStaticDefaultScripts(w.host, [place(L, S5, 0)], wasm);
    assert.equal(t.held.length, 1, "the 5 s create is armed");
    w.at(0xd0); // d4 → teardown
    t.held.shift()();
    await settle();
    assert.deepEqual(w.counts(), [0], "nothing lands on the torn-down anchor");
    // Control: without a teardown the armed create lands.
    const L2 = lb(0xd4, 0x2e);
    const w2 = makeWorld(L2);
    w2.at(0xd2);
    await S.attachStaticDefaultScripts(w2.host, [place(L2, S5, 0)], wasm);
    t.held.shift()();
    await settle();
    assert.deepEqual(w2.counts(), [1]);
  } finally {
    t.restore();
  }
});

test("R5: a create in flight across the teardown is destroyed when it lands", async () => {
  const t = holdLongTimers();
  try {
    const L = lb(0xd4, 0x3e);
    const w = makeWorld(L);
    w.at(0xd2);
    await S.attachStaticDefaultScripts(w.host, [place(L, S5, 0)], wasm);
    const g = deferred();
    addGates.set(E5, g.promise);
    t.held.shift()(); // fires before the teardown; the create awaits the manager
    await settle();
    w.at(0xd0); // d4 → teardown (the emitter is not in the table yet)
    g.resolve();
    await settle();
    addGates.delete(E5);
    assert.deepEqual(w.counts(), [0]);
  } finally {
    t.restore();
  }
});

test("R6: an interior anchor unparked outside the radius still emits", async () => {
  const L = lb(0xe4, 0x1e);
  const w = makeWorld(L);
  w.host.envCellLoadedLbs = new Set([L]);
  w.at(0xe0); // d4
  const a = new THREE.Group();
  a.userData = {
    isStaticScriptAnchor: true, isCellStaticScriptAnchor: true, defaultScriptId: S0,
    landblockId: L, particleOwnerKey: staticOwnerKeyForLb(L),
  };
  w.staticsGroup.add(a);
  await S.rebuildStaticScriptEmittersForAnchors(w.host, [a], wasm);
  assert.deepEqual(w.counts(), [1]);
  w.at(0xe2); // d2: the tick leaves interior anchors alone
  await settle();
  assert.deepEqual(w.counts(), [1]);
});

test("R7: an unpark's rebuild ends the CallPES loop pending from before the park", async () => {
  const t = holdLongTimers();
  try {
    const L = lb(0xf4, 0x1e);
    const w = makeWorld(L);
    w.at(0xf2);
    await S.attachStaticDefaultScripts(w.host, [place(L, S7, 0)], wasm);
    const [a] = w.anchors();
    assert.equal(t.held.length, 1, "loop pass 2 armed");
    // park: the landblock's emitters go, the anchor is detached …
    S._evictStaticParticlesForLb(L);
    w.staticsGroup.remove(a);
    // … unpark: re-attached and rebuilt (pass 1 again, its own loop armed).
    w.staticsGroup.add(a);
    await S.rebuildStaticScriptEmittersForAnchors(w.host, [a], wasm);
    assert.equal(t.held.length, 2);
    const before = scriptFetches.filter((d) => d === S7).length;
    t.held.shift()(); // the pre-park loop's timer
    await settle();
    assert.equal(scriptFetches.filter((d) => d === S7).length, before, "the pre-park loop is dead");
    assert.deepEqual(w.counts(), [1]);
    t.held.shift()(); // the rebuild's own loop still runs
    await settle();
    assert.equal(scriptFetches.filter((d) => d === S7).length, before + 1);
  } finally {
    t.restore();
  }
});

test("R8: a teardown mid-way through a CallPES pass ends the loop; the return runs one", async () => {
  const t = holdLongTimers();
  try {
    const L = lb(0xf4, 0x2e);
    const w = makeWorld(L);
    w.at(0xf2);
    await S.attachStaticDefaultScripts(w.host, [place(L, S7, 0)], wasm);
    assert.deepEqual(w.counts(), [1]);
    const g = deferred();
    emitterGates.set(E7, g.promise);
    t.held.shift()(); // loop pass 2 starts and awaits its emitter fetch
    await settle();
    w.at(0xf0); // d4 → teardown
    g.resolve();
    await settle();
    emitterGates.delete(E7);
    assert.deepEqual(w.counts(), [0], "the pass lands nothing on the torn-down anchor");
    assert.equal(t.held.length, 0, "and arms no further pass");
    w.at(0xf2); // d2 → rebuild
    await settle();
    assert.deepEqual(w.counts(), [1]);
    assert.equal(t.held.length, 1, "one loop");
  } finally {
    t.restore();
  }
});

// R9 helpers: the LRU's warm park / unpark, as landblock_lru.js drives them.
const parkLb = (w, L, list) => { S._evictStaticParticlesForLb(L); for (const a of list) w.staticsGroup.remove(a); };
const unparkLb = (w, list) => { for (const a of list) w.staticsGroup.add(a); return S.rebuildStaticScriptEmittersForAnchors(w.host, list, wasm); };

test("R9: unparked before the attach resumes — the chain runs once", async () => {
  const L = lb(0x64, 0x1e);
  const SETUP = 0x02000c02;
  const w = makeWorld(L);
  w.at(0x62); // d2
  const gPose = deferred();
  poseGates.set(SETUP, gPose.promise);
  const attach = S.attachStaticDefaultScripts(w.host, [place(L, S0, 0), place(L, S1, 1, SETUP)], wasm);
  await settle(); // anchor 0 chained, anchor 1 awaits its part frames
  const list = w.anchors();
  assert.equal(list.length, 2);
  parkLb(w, L, list);
  await unparkLb(w, list);
  gPose.resolve();
  await attach;
  await settle();
  poseGates.delete(SETUP);
  assert.deepEqual(w.counts(), [1, 1], "one emitter per anchor");
});

test("R9b: the attach resumes while parked — no chain, no frozen detached anchor; unpark chains once", async () => {
  const L = lb(0x64, 0x2e);
  const SETUP = 0x02000c03;
  const w = makeWorld(L);
  w.at(0x62);
  const gPose = deferred();
  poseGates.set(SETUP, gPose.promise);
  const attach = S.attachStaticDefaultScripts(w.host, [place(L, S1, 0, SETUP)], wasm);
  await settle();
  const list = w.anchors();
  parkLb(w, L, list);
  gPose.resolve();
  await attach;
  await settle();
  poseGates.delete(SETUP);
  const [a] = list;
  const onAnchor = () => [...w.mgr.particleTable.values()].filter((e) => e.parent === a).length;
  assert.equal(onAnchor(), 0, "nothing chained on the parked anchor");
  assert.notEqual(a.userData.__anchorFrozen, true, "a detached anchor is not frozen");
  await unparkLb(w, list);
  await settle();
  assert.deepEqual(w.counts(), [1]);
});

test("R9c: interior attach — unparked before it resumes, the chain runs once", async () => {
  const L = lb(0x64, 0x3e);
  const SETUP = 0x02000c04;
  const w = makeWorld(L);
  w.host.envCellLoadedLbs = new Set([L]);
  w.at(0x62);
  const gPose = deferred();
  poseGates.set(SETUP, gPose.promise);
  const item = { landblockId: L, cellId: (L | 0x0100) >>> 0, x: 10, y: 20, z: 1, defaultScriptId: S1, modelId: SETUP, scale: 1 };
  const attach = S.attachStaticDefaultScriptsWorld(w.host, [item], wasm);
  await settle();
  const list = w.anchors();
  assert.equal(list.length, 1);
  parkLb(w, L, list);
  await unparkLb(w, list);
  gPose.resolve();
  await attach;
  await settle();
  poseGates.delete(SETUP);
  assert.deepEqual(w.counts(), [1], "one emitter on the interior anchor");
});
