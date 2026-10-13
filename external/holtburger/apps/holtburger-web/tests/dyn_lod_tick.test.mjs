// tests/dyn_lod_tick.test.mjs — render-perf-2 (2026-10-13): the T9 dynamic-LOD tick only band-
// queries entities that can actually substitute.
//
// `_lodOriginalSetup` was the spawn setupId for EVERY entity, so the tick's "no degrade chain" skip
// never fired: each 0.5 s tick sent one async wasm `fetch_entity_degrade_for_distance` per entity,
// including every multi-part creature (resolve_did_degrade's `parts.len() != 1` bail → always 0).
// `_gateLodChain` (called by _spawnImpl right after it stamps the LOD fields) asks the wasm
// `entity_degrade_chain_id` once per setupId (scene3d/lod_chain_memo.js) and zeroes
// `_lodOriginalSetup` for a chainless setup.
//   D1  chain-0 (multi-part / no chain) setups are band-queried ZERO times after spawn; the chain
//       probe runs once per distinct setupId, shared across wave-mates
//   D2  a sub equal to the current _lodSub never calls _respawnForLod; a different one does, once
//   D3  stale pkg/ (no entity_degrade_chain_id): untouched — every entity is queried as before
//   D4  a rejected chain probe memoises nothing; a later spawn's 0 drops the earlier entity too
//   D5  lod_chain_memo: in-flight dedupe, non-number / throw → undefined and not memoised
//   D6  _spawnImpl calls _gateLodChain right after stamping _lodOriginalSetup/_lodSub
// The Rust half ("a band naming the base GfxObj answers 0", the memos) is pinned by
// src/lib.rs `render_perf_2_entity_degrade_tests`.
//
// Run from apps/holtburger-web/:  node tests/dyn_lod_tick.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// DYN_LOD_ON is read at module load: an empty query string = default ON.
globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.__playEffectVfxBound = true;
globalThis.window.__spellShapePreviewBound = true;

const { EntityManager } = await import("../scene3d/entities.js");
const { lodChainGet, lodChainResolve, lodChainStats, lodChainClear } = await import(
  "../scene3d/lod_chain_memo.js"
);

const ME = 0x50000001;
const MULTI = 0x02000001; // multi-part creature setup → chain 0
const SINGLE = 0x020001a0; // single-part prop with a degrade chain
const CHAIN = 0x11000001;

const flush = () => new Promise((r) => setImmediate(r));

/** Counting fake wasm: `chains` answers entity_degrade_chain_id, `subs` the band query. */
function fakeWasm({ chains = new Map(), subs = new Map(), withChainFn = true, chainImpl = null } = {}) {
  const calls = { lod: [], chain: [] };
  const exports = {
    fetch_entity_degrade_for_distance: (setup, _dist) => {
      calls.lod.push(setup >>> 0);
      return Promise.resolve(subs.get(setup >>> 0) ?? 0);
    },
  };
  if (withChainFn) {
    exports.entity_degrade_chain_id = (setup) => {
      calls.chain.push(setup >>> 0);
      if (chainImpl) return chainImpl(setup >>> 0, calls.chain.length);
      return Promise.resolve(chains.get(setup >>> 0) ?? 0);
    };
  }
  return { calls, exports };
}

function world(exports) {
  globalThis.window.liveScene3d = { camera: { position: { x: 100, y: 2, z: -100 } } };
  globalThis.window.getLocalPlayerGuid = () => ME;
  const em = new EntityManager({ entitiesGroup: null, materialCache: null }, exports);
  const respawns = [];
  em._respawnForLod = async (inst, g, sub) => {
    respawns.push({ g, sub });
    inst._lodRespawning = false;
  };
  // What _spawnImpl does once the rig is built (see D6).
  const spawn = (guid, setupId, lodSub = 0) => {
    const inst = {
      guid,
      meta: { guid },
      root: { position: { x: 10, y: 0, z: 0 } },
      _attachedParentGuid: null,
    };
    inst._lodOriginalSetup = setupId;
    inst._lodSub = lodSub;
    em.entityMap.set(guid, inst);
    em._gateLodChain(inst);
    return inst;
  };
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i += 1) {
      em._tickDynamicLod();
      await flush();
    }
  };
  return { em, spawn, tick, respawns };
}

test("D1: chain-0 setups are band-queried zero times after spawn; one chain probe per setupId", async () => {
  lodChainClear();
  const { calls, exports } = fakeWasm({ chains: new Map([[MULTI, 0], [SINGLE, CHAIN]]) });
  const { spawn, tick } = world(exports);
  const m1 = spawn(0x80000001, MULTI);
  const m2 = spawn(0x80000002, MULTI);
  const m3 = spawn(0x80000003, MULTI);
  const s1 = spawn(0x80000004, SINGLE);
  await flush();
  assert.deepEqual(calls.chain, [MULTI, SINGLE], "wave-mates share one probe per setup");
  for (const m of [m1, m2, m3]) assert.equal(m._lodOriginalSetup, 0, "chainless → dropped from the tick");
  assert.equal(s1._lodOriginalSetup, SINGLE, "a chain-carrying setup keeps its original setup");
  assert.equal(lodChainGet(MULTI), 0);
  assert.equal(lodChainGet(SINGLE), CHAIN);

  await tick(3);
  assert.equal(calls.lod.filter((s) => s === MULTI).length, 0, "multi-part setups are never band-queried");
  assert.equal(calls.lod.filter((s) => s === SINGLE).length, 3, "the chain-carrying entity still is, every tick");

  // A later spawn of a known setup is gated synchronously (no second probe).
  const m4 = spawn(0x80000005, MULTI);
  assert.equal(m4._lodOriginalSetup, 0);
  assert.equal(calls.chain.length, 2);
});

test("D2: a sub equal to the current _lodSub never respawns; a different one respawns once", async () => {
  lodChainClear();
  const subs = new Map([[SINGLE, 0]]);
  const { exports } = fakeWasm({ chains: new Map([[SINGLE, CHAIN]]), subs });
  const { spawn, tick, respawns } = world(exports);
  const a = spawn(0x80000011, SINGLE, 0);
  await flush();
  await tick(4);
  assert.equal(respawns.length, 0, "0 vs _lodSub 0: same geometry, no remove()+spawn()");
  assert.equal(a._lodRespawning, false, "the in-flight latch is released");

  a._lodSub = 0x01000aaa;
  subs.set(SINGLE, 0x01000aaa);
  await tick(3);
  assert.equal(respawns.length, 0, "an unchanged substitute never respawns");

  subs.set(SINGLE, 0);
  await tick(1);
  assert.deepEqual(respawns, [{ g: 0x80000011, sub: 0 }], "a real band change respawns with the tick's band");
});

test("D3: stale pkg/ without entity_degrade_chain_id leaves every entity on the per-tick path", async () => {
  lodChainClear();
  const { calls, exports } = fakeWasm({ withChainFn: false });
  const { spawn, tick } = world(exports);
  const m = spawn(0x80000021, MULTI);
  const s = spawn(0x80000022, SINGLE);
  await flush();
  assert.equal(m._lodOriginalSetup, MULTI);
  assert.equal(s._lodOriginalSetup, SINGLE);
  await tick(2);
  assert.deepEqual(calls.lod.sort(), [MULTI, MULTI, SINGLE, SINGLE].sort(), "today's behaviour");
  assert.equal(lodChainGet(MULTI), undefined);
});

test("D4: a rejected probe memoises nothing; a later 0 drops the earlier entity at the next tick", async () => {
  lodChainClear();
  const { calls, exports } = fakeWasm({
    chainImpl: (_setup, n) =>
      n === 1 ? Promise.reject(new Error("entity_degrade_chain_id: a degrade record is not resident")) : Promise.resolve(0),
  });
  const { spawn, tick } = world(exports);
  const a = spawn(0x80000031, MULTI);
  await flush();
  assert.equal(lodChainGet(MULTI), undefined, "a rejected probe is not 'no chain'");
  assert.equal(a._lodOriginalSetup, MULTI);
  await tick(1);
  assert.equal(calls.lod.length, 1, "still on the per-tick path");

  const b = spawn(0x80000032, MULTI);
  await flush();
  assert.equal(calls.chain.length, 2, "the next spawn asks again");
  assert.equal(b._lodOriginalSetup, 0);
  await tick(2);
  assert.equal(a._lodOriginalSetup, 0, "the tick consults the memo for older entities");
  assert.equal(calls.lod.length, 1, "no further band queries for the setup");
});

test("D5: lod_chain_memo dedupes in-flight probes and never memoises a non-answer", async () => {
  lodChainClear();
  let n = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = (sid) => { n += 1; return gate.then(() => (sid === MULTI ? 0 : CHAIN)); };
  const p1 = lodChainResolve(MULTI, slow);
  const p2 = lodChainResolve(MULTI, slow);
  assert.equal(lodChainStats().inflight, 1);
  release();
  assert.deepEqual(await Promise.all([p1, p2]), [0, 0]);
  assert.equal(n, 1, "one probe for concurrent callers");
  assert.equal(await lodChainResolve(MULTI, slow), 0);
  assert.equal(n, 1, "memo hit");
  assert.equal(lodChainStats().inflight, 0);

  assert.equal(await lodChainResolve(0x02000077, () => undefined), undefined);
  assert.equal(lodChainGet(0x02000077), undefined, "non-number not memoised");
  assert.equal(await lodChainResolve(0x02000078, () => { throw new Error("boom"); }), undefined);
  assert.equal(lodChainGet(0x02000078), undefined, "a throw is not memoised");
  assert.equal(await lodChainResolve(0x02000079, null), undefined, "no export → unknown");
  assert.equal(await lodChainResolve(0x0200007a, () => 0x11000002), 0x11000002, "sync answers work");
  assert.equal(lodChainGet(0x0200007a), 0x11000002);
});

test("D6: _spawnImpl gates the chain right after stamping the T9 LOD fields", () => {
  const src = readFileSync(new URL("../scene3d/entities.js", import.meta.url), "utf8");
  const i = src.indexOf("inst._lodOriginalSetup = lodOriginalSetup;");
  assert.ok(i > 0);
  const near = src.slice(i, i + 400);
  assert.ok(near.indexOf("inst._lodSub = lodSubstitute;") > 0);
  assert.ok(near.indexOf("this._gateLodChain(inst);") > near.indexOf("inst._lodSub = lodSubstitute;"));
  const tickBody = src.slice(src.indexOf("  _tickDynamicLod() {"));
  assert.ok(
    tickBody.indexOf("lodChainGet(inst._lodOriginalSetup) === 0") > 0 &&
      tickBody.indexOf("lodChainGet(inst._lodOriginalSetup) === 0") < tickBody.indexOf("lodFetch(inst._lodOriginalSetup, distance)"),
    "the tick consults the memo before its band query"
  );
});
