// tests/static_script_hooktime.test.mjs
//
// PLIFECYCLE-5 (2026-10-08) `?staticScriptHookTime` (DEFAULT ON). Retail plays
// a static's Setup default_script through the same ScriptManager as any object
// (CPhysicsObj::InitDefaults → play_script_internal, acclient.c:320867), which
// fires each hook only once `Timer::cur_time >= script start + start_time`
// (ScriptManager::AddScriptInternal / NextHook / UpdateScripts,
// acclient.c:329069-329246). statics.js `_runStaticParticleChain` created every
// CreateParticle at once and measured a CallPES delay from whenever the walker
// reached the entry (after awaiting earlier hooks' emitter fetches).
//
//   S1  a create authored at start_time 0.08 lands ~80 ms after the t=0 one,
//       with its OWN decoded offset vectors (never the shared scratch);
//       `=off` arm: both land at once (the legacy walker).
//   S2  a CallPES at start_time 0.25 re-runs its sub-script ~250 ms after the
//       chain STARTED, not 250 ms after a slow earlier emitter fetch finished;
//       `=off` arm: the fetch time is added.
//   S3  a pending deferred create is dropped when the anchor detaches (LB
//       evict) or its owner is torn down (destroyAllForOwner epoch), and
//       disposeStaticParticles cancels it.
//
// Drives the SHIPPED walker through the exported `attachSkyParticleChain`
// (`_ensureStaticParticleManager` returns a pre-seeded manager as-is) with a
// recording stub manager and fake wasm exports. Fails on the pre-change code
// (S1/S2 timings, S3 drops).
//
// Run: node tests/static_script_hooktime.test.mjs

import * as THREE from "three";

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// statics.js arms a self-managed rAF at module scope: stub it out.
globalThis.window = globalThis.window || {};
globalThis.location = { search: "" };
window.location = globalThis.location;
window.requestAnimationFrame = () => 0;
window.cancelAnimationFrame = () => {};

globalThis.location.search = "?staticScriptHookTime=off";
const OFF = await import("../scene3d/statics.js?arm=off");
globalThis.location.search = "";
const ON = await import("../scene3d/statics.js");
const { ownerRegistry } = await import("../scene3d/particles/owner_registry.js");

const HOOK_CREATE = 13;
const HOOK_CALL_PES = 19;
const SCRIPT_A = 0x33000a01;
const SCRIPT_B = 0x33000b01;
const SCRIPT_SLOW = 0x33000c01;

function createHook(startTime, emitterDid, x) {
  return {
    startTime, hookType: HOOK_CREATE, createParticleEmitterId: emitterDid,
    createParticlePartIndex: 0xffffffff,
    createParticleOffsetX: x, createParticleOffsetY: 2, createParticleOffsetZ: 3,
    createParticleOffsetQX: 0, createParticleOffsetQY: 0, createParticleOffsetQZ: 0, createParticleOffsetQW: 1,
  };
}
function callPesHook(startTime, did, pause = 0) {
  const hookData = new Uint8Array(8);
  const dv = new DataView(hookData.buffer);
  dv.setUint32(0, did, true);
  dv.setFloat32(4, pause, true);
  return { startTime, hookType: HOOK_CALL_PES, hookData };
}

const SCRIPTS = new Map([
  // S1: two creates, the second authored 80 ms into the script.
  [SCRIPT_A, () => [createHook(0, 0x32000001, 1), createHook(0.08, 0x32000002, 7)]],
  // S2: a slow t=0 create (100 ms emitter fetch), then CallPES(B) at 250 ms.
  [SCRIPT_SLOW, () => [createHook(0, 0x320000ff, 0), callPesHook(0.25, SCRIPT_B)]],
  [SCRIPT_B, () => [createHook(0, 0x320000bb, 0)]],
]);
const FETCH_DELAY_MS = new Map([[0x320000ff, 100]]);
const fakeWasm = {
  fetchPhysicsScript: async (did) => {
    const make = SCRIPTS.get(did >>> 0);
    if (!make) throw new Error(`no script 0x${(did >>> 0).toString(16)}`);
    return { takeEntries: make, free() {} };
  },
  fetchParticleEmitter: async (did) => {
    const d = FETCH_DELAY_MS.get(did >>> 0);
    if (d) await sleep(d);
    return { id: did >>> 0, hwGfxObjId: 0x01000001 };
  },
};

function makeWorld() {
  const calls = [];
  let next = 1;
  const manager = {
    particleTable: new Map(),
    async addEmitter(req) {
      calls.push({ at: performance.now(), did: req.emitterInfo.id >>> 0, req });
      const id = next++;
      this.particleTable.set(id, req);
      return id;
    },
    destroyParticleEmitter(id) { return this.particleTable.delete(id); },
    stopParticleEmitter() { return false; },
  };
  const staticsGroup = new THREE.Group();
  const anchor = new THREE.Group();
  staticsGroup.add(anchor);
  return { scene3d: { staticsGroup, _staticParticleManager: manager }, anchor, calls };
}
const callFor = (calls, did) => calls.find((c) => c.did === did);

// ===========================================================================
console.log("S1 — a CreateParticle authored after t=0 fires at its start_time");
// ===========================================================================
{
  const w = makeWorld();
  const t0 = performance.now();
  const n = await ON.attachSkyParticleChain(w.scene3d, w.anchor, SCRIPT_A, fakeWasm);
  await sleep(160);
  const first = callFor(w.calls, 0x32000001);
  const second = callFor(w.calls, 0x32000002);
  check("S1 the t=0 create lands immediately (counted as attached)",
    !!first && first.at - t0 < 60 && n === 1, `+${first ? (first.at - t0).toFixed(1) : "-"} ms, attached=${n}`);
  check("S1 the start_time 0.08 create lands ~80 ms after the chain started",
    !!second && second.at - t0 >= 70 && second.at - t0 < 150, `+${second ? (second.at - t0).toFixed(1) : "-"} ms`);
  check("S1 the deferred create keeps its own decoded offset",
    !!second && second.req.parentOffset.position.x === 7 && second.req.parentOffset.position.y === 2
    && second.req.parentOffset.quaternion.w === 1);
  check("S1 ...in vectors it owns, not the walker's shared scratch",
    !!first && !!second && second.req.parentOffset.position !== first.req.parentOffset.position);
  check("S1 parent / part index carried through", !!second && second.req.parent === w.anchor && second.req.partIndex === -1);
}
{
  const w = makeWorld();
  const t0 = performance.now();
  await OFF.attachSkyParticleChain(w.scene3d, w.anchor, SCRIPT_A, fakeWasm);
  const second = callFor(w.calls, 0x32000002);
  check("S1 `=off` arm: both creates land at once (legacy walker)",
    w.calls.length === 2 && !!second && second.at - t0 < 60, `+${second ? (second.at - t0).toFixed(1) : "-"} ms`);
}

// ===========================================================================
console.log("S2 — CallPES delay is measured from the chain start");
// ===========================================================================
async function callPesLanding(arm) {
  const w = makeWorld();
  const t0 = performance.now();
  await arm.attachSkyParticleChain(w.scene3d, w.anchor, SCRIPT_SLOW, fakeWasm);
  await sleep(600);
  const sub = callFor(w.calls, 0x320000bb);
  return sub ? sub.at - t0 : Infinity;
}
{
  const on = await callPesLanding(ON);
  check("S2 CallPES(B)@0.25 re-runs B ~250 ms after the chain started (the 100 ms fetch is not added)",
    on >= 240 && on < 310, `+${on.toFixed(1)} ms`);
  const off = await callPesLanding(OFF);
  check("S2 `=off` arm: the slow earlier fetch is added (≥ 100 + 250 ms)", off >= 340 && off < 600,
    `+${off.toFixed(1)} ms`);
}

// ===========================================================================
console.log("S3 — a pending deferred create is dropped on teardown");
// ===========================================================================
{
  const w = makeWorld();
  await ON.attachSkyParticleChain(w.scene3d, w.anchor, SCRIPT_A, fakeWasm);
  w.scene3d.staticsGroup.remove(w.anchor); // LB evicted — anchor detached
  await sleep(160);
  check("S3 detached anchor: the deferred create is dropped",
    w.calls.length === 1 && !callFor(w.calls, 0x32000002), `calls=${w.calls.length}`);
}
{
  const w = makeWorld();
  const KEY = "static:hooktime-test";
  await ON.attachSkyParticleChain(w.scene3d, w.anchor, SCRIPT_A, fakeWasm, KEY);
  check("S3 owner path: the t=0 create registered under the owner",
    ownerRegistry.emitterCountForOwner(KEY) === 1);
  ownerRegistry.destroyAllForOwner(KEY); // LB evict / park
  await sleep(160);
  check("S3 owner torn down (epoch bumped): the deferred create is dropped",
    !callFor(w.calls, 0x32000002) && ownerRegistry.emitterCountForOwner(KEY) === 0);
}
{
  // LAST: disposeStaticParticles latches this module instance's `_spDisposed`.
  const w = makeWorld();
  await ON.attachSkyParticleChain(w.scene3d, w.anchor, SCRIPT_A, fakeWasm);
  ON.disposeStaticParticles(w.scene3d);
  await sleep(160);
  check("S3 disposeStaticParticles cancels the pending deferred create",
    !callFor(w.calls, 0x32000002), `calls=${w.calls.length}`);
}

console.log(`\nstatic script hook time: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
