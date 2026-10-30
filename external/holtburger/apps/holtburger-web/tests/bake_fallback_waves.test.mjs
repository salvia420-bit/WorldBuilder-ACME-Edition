// tests/bake_fallback_waves.test.mjs — `?bakeFallbackWaves` (2026-10-30,
// round 3 R3-2, lane W2; yield + diag fixes lane W3; DEFAULT OFF).
//
// The R3-2 worker-wait audit found the one whole-job wait left on the frame
// thread: while the bake worker is not serving a request (`?bakeWorker=0`, no
// Worker, the F1 crash backoff, a worker error, an alias in an entity batch)
// the WHOLE id list goes to the main-thread wasm in one call, and
// `fetch_model_meshes` decodes every id in one synchronous continuation after
// its walk. Armed, those main-thread calls run in waves of 16 ids with a
// macrotask between waves (a MessageChannel post; setTimeout(0) only where
// MessageChannel is missing), results in input order, audit merged; off,
// every site makes exactly today's single call.
//
// The wasm stubs below model the resident-record case that makes the long
// task: the walk resolves on a microtask (`await null`), so without a
// macrotask yield every wave would decode in the caller's task.
//
// Macrotasks are modelled as ONE FIFO task queue (the HTML event loop with
// zero-delay timers and posted messages at the same priority): `setTimeout(fn,
// 0)` and the fake `MessageChannel` installed below both enqueue a task, one
// task runs per real `setImmediate` turn so microtasks drain between tasks,
// and `epoch` counts started tasks. Zero-delay timers also carry Chrome's
// timer nesting level (parent + 1; clamped to >= 4 ms from level 5 on), so a
// chained setTimeout(0) yield is charged the clamp it would pay in Chrome.
// W18 re-checks the yield against Node's REAL MessageChannel in a child process.
//
//   W1  flag grammar: parse / resolve / configure; bare client off
//   W2  OFF, worker inactive: ONE call per request with the ORIGINAL argument
//       object, no setTimeout(0), no MessageChannel made or posted; fetcher
//       shortcuts return the EXACT exports; no window diag
//   W3  ON, inactive, 64 model ids: 4 calls of 16 in input order, 3 MessageChannel
//       yields (0 setTimeout(0)), each wave decoded in its own macrotask,
//       results == unsplit
//   W4  ON, 64 surface DIDs: same, call-level audit merged == unsplit
//       (misses summed, provenAbsent sorted + deduped like proven_absent_dids)
//   W5  ON, 64 entity surface DIDs: palette state rides every wave; == unsplit
//   W6  ON, entity batch: group waves (splitEntityBatchGroupWaves), ONE
//       handle-shaped result == unsplit per group, audit merged, waves freed
//   W7  ON, a request that fits one wave: today's single call, original
//       object, synchronous, no yield
//   W8  ON, worker active but in crash backoff: the four catch-path fallbacks
//       run in waves (fallbacks still counted once per request); OFF: 1 call
//   W9  ON, alias in an entity batch: the whole-batch main-wasm divert runs in
//       group waves, nothing posted to the worker; OFF: 1 call
//   W10 ON, inactive fetcher shortcuts: wave wrappers; stale-pkg exports still
//       returned as-is
//   W11 a wave rejects: the call rejects with that error, earlier waves'
//       handles freed, no later wave starts
//   W12 entity batch whose parallel arrays do not line up: not split
//   W13 surfaces with DIDs repeated across waves: positions + provenAbsent
//       == unsplit
//   W14 diag: window.__bakeFallbackWaves.stats() (armed only), yieldVia
//   W15 the yield is a macrotask, not a timer: a setTimeout(0) and another
//       channel's message queued during wave k both run before wave k+1 starts;
//       the yields are MessageChannel posts; the port is ref'd only while waiting
//   W16 a 320-id request (20 waves, 19 yields): the modelled Chrome nested-timer
//       clamp charges 0 ms (a chained setTimeout(0) yield: 15 x 4 = 60 ms)
//   W17 no MessageChannel (fresh module instance): setTimeout(0) fallback,
//       still one macrotask per wave, == unsplit
//   W18 real Node MessageChannel (child process): the request completes, no
//       setTimeout(0), wave 1 not reachable through microtasks alone, and the
//       process exits by itself (the port is unref'd once drained)
//   W19 configure() on then off: window.__bakeFallbackWaves removed (another
//       client's diag, or one this client never installed, left alone)
//   W20 two concurrent armed requests: yields resolve FIFO (the waves
//       alternate), both results == unsplit
//
// Run: node tests/bake_fallback_waves.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// ── macrotask model: one FIFO task queue ────────────────────────────────────
// `epoch` counts tasks that have STARTED: two decodes with the same epoch ran
// in the same task (nothing else in this file schedules a task between a
// wave's call and its decode).
const realSetTimeout = globalThis.setTimeout;
const realSetImmediate = globalThis.setImmediate;
let epoch = 0;
let zeroTimeouts = 0; // setTimeout(fn, <= 0) calls NOT made by this file
let clampMs = 0; // Chrome's nested-timer clamp, as charged by the model
let curTimerLevel = 0; // timer nesting level of the running task (0 = not a timer task)
const taskQ = [];
let pumpArmed = false;
function enqueueTask(run, timerLevel) {
  taskQ.push({ run, timerLevel });
  if (!pumpArmed) {
    pumpArmed = true;
    realSetImmediate(pump);
  }
}
function pump() {
  pumpArmed = false;
  const task = taskQ.shift();
  if (taskQ.length > 0) {
    pumpArmed = true;
    realSetImmediate(pump);
  }
  if (!task) return;
  epoch += 1;
  curTimerLevel = task.timerLevel;
  task.run();
}
globalThis.setTimeout = function patchedSetTimeout(fn, ms, ...args) {
  if (Number(ms) > 0) {
    return realSetTimeout(() => {
      epoch += 1;
      curTimerLevel = 0;
      fn(...args);
    }, ms);
  }
  if (!fn.testOwned) zeroTimeouts += 1;
  // Chrome DOMTimer: nesting level = the running timer task's level + 1; a
  // timeout below 4 ms is raised to 4 ms once the level reaches 5.
  const level = curTimerLevel + 1;
  if (level >= 5) clampMs += 4;
  enqueueTask(() => fn(...args), level);
  return 0;
};

// Fake MessageChannel on the same FIFO queue: each post is one task that
// dispatches to the entangled port's `onmessage`. Channels this file makes are
// marked `testOwned`, so `yieldPosts` counts only the module's yields.
let yieldPosts = 0;
class FifoMessagePort {
  constructor(channel) {
    this.channel = channel;
    this.other = null;
    this.onmessage = null;
    this.closed = false;
    this.refd = true;
    this.refCalls = 0;
    this.unrefCalls = 0;
  }
  postMessage(data) {
    if (!this.channel.testOwned) yieldPosts += 1;
    const target = this.other;
    enqueueTask(() => {
      if (!target.closed && typeof target.onmessage === "function") target.onmessage({ data });
    }, 0);
  }
  ref() {
    this.refCalls += 1;
    this.refd = true;
  }
  unref() {
    this.unrefCalls += 1;
    this.refd = false;
  }
  start() {}
  close() {
    this.closed = true;
  }
}
class FifoMessageChannel {
  constructor() {
    this.port1 = new FifoMessagePort(this);
    this.port2 = new FifoMessagePort(this);
    this.port1.other = this.port2;
    this.port2.other = this.port1;
    this.testOwned = false;
    FifoMessageChannel.instances.push(this);
  }
}
FifoMessageChannel.instances = [];
globalThis.MessageChannel = FifoMessageChannel;
const moduleChannels = () => FifoMessageChannel.instances.filter((ch) => !ch.testOwned);
const snap = () => ({ z: zeroTimeouts, p: yieldPosts, clamp: clampMs });

// Manual fake worker (only W8/W9 define it as the global Worker).
class ManualWorker {
  constructor() {
    ManualWorker.instances.push(this);
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
  }
  postMessage(msg) {
    this.posted.push(msg);
  }
  reply(data) {
    this.onmessage && this.onmessage({ data });
  }
  terminate() {
    this.terminated = true;
  }
}
ManualWorker.instances = [];
delete globalThis.Worker;
globalThis.window = globalThis.window || {};

const mod = await import("../scene3d/bake_worker_client.js");
const {
  BakeWorkerClient,
  configureBakeWorker,
  modelMeshFetcher,
  surfacePixelsFetcher,
  entitySurfacePixelsFetcher,
  entitySurfacesBatchFetcher,
  splitEntityBatchGroupWaves,
} = mod;
// New in this lane: read off the namespace so the pre-change module still loads.
const parseBakeFallbackWaves = mod.parseBakeFallbackWaves;
const resolveBakeFallbackWaves = mod.resolveBakeFallbackWaves;

let passed = 0;
let failed = 0;
async function t(name, fn) {
  // Each check starts outside any timer task (a fresh timer nesting chain).
  curTimerLevel = 0;
  try {
    await fn();
    passed += 1;
    console.log(`  [OK] ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${(e && e.stack) || e}`);
  }
}
const flush = () => new Promise((r) => setImmediate(r));
function quiet(fn) {
  const w = console.warn;
  const i = console.info;
  console.warn = () => {};
  console.info = () => {};
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.warn = w;
      console.info = i;
    });
}

// ── deterministic wasm stubs (resident records: the walk is one microtask) ──
const hex = (d) => "0x" + (d >>> 0).toString(16).toUpperCase().padStart(8, "0");
const isMiss = (d) => (d >>> 0) % 11 === 0;
const isAbsent = (d) => (d >>> 0) % 5 === 0;
/** Mirrors lib.rs `proven_absent_dids`: filter, sort ascending, dedup, format. */
const provenAbsentOf = (ids) => [...new Set([...ids].map((d) => d >>> 0).filter(isAbsent))]
  .sort((a, b) => a - b)
  .map(hex);
const uniqueMisses = (ids) => new Set([...ids].map((d) => d >>> 0).filter(isMiss)).size;

function handle(obj, log) {
  obj.free = function free() {
    this.freedCount = (this.freedCount || 0) + 1;
    if (log) log.push(this);
  };
  return obj;
}
function mesh(id) {
  return handle({
    id: id >>> 0,
    positions: Float32Array.of(id & 0xff, (id >>> 8) & 0xff, 3),
    surfaces: Uint32Array.of(0x08000000 | (id & 0xffff)),
    decodeMisses: 0,
  });
}
function surface(id, pal = 0, subs = "") {
  return handle({
    width: 1,
    height: 1,
    pixels: new Uint8Array([id & 0xff, (id >>> 8) & 0xff, pal & 0xff, 255]),
    luminosity: id >>> 0,
    palette: pal >>> 0,
    subs,
  });
}

function makeWasm({ failOnCall = 0 } = {}) {
  const calls = [];
  const decodes = [];
  const batchHandles = [];
  let n = 0;
  const begin = (fn, args) => {
    n += 1;
    calls.push({ fn, ...args, epoch });
    if (failOnCall && n === failOnCall) throw new Error(`wasm stub: call ${n} failed`);
  };
  const w = {
    calls,
    decodes,
    batchHandles,
    async fetch_model_meshes(ids, urgent) {
      begin("mm", { ids, idsCopy: [...ids], urgent });
      await null; // the prefetch walk, every record resident
      decodes.push({ fn: "mm", n: ids.length, epoch });
      return [...ids].map((d) => mesh(d));
    },
    async fetch_surfaces_pixels(ids, urgent) {
      begin("sp", { ids, idsCopy: [...ids], urgent });
      await null;
      decodes.push({ fn: "sp", n: ids.length, epoch });
      const arr = [...ids].map((d) => surface(d));
      arr.decodeMisses = uniqueMisses(ids);
      arr.provenAbsent = provenAbsentOf(ids);
      return arr;
    },
    async fetchEntitySurfacesPixels(ids, paletteId, subPalettes, urgent) {
      begin("esp", { ids, idsCopy: [...ids], paletteId, subPalettes, urgent });
      await null;
      decodes.push({ fn: "esp", n: ids.length, epoch });
      const subs = [...(subPalettes || [])].join(",");
      const arr = [...ids].map((d) => surface(d, paletteId, subs));
      arr.decodeMisses = uniqueMisses(ids);
      arr.provenAbsent = provenAbsentOf(ids);
      return arr;
    },
    async fetchEntitySurfacesPixelsBatch(flatDids, lens, basePals, flatSubs, tripleCounts, urgent) {
      begin("batch", {
        flatDids,
        lens,
        args: [[...flatDids], [...lens], [...basePals], [...flatSubs], [...tripleCounts]],
        urgent,
      });
      await null;
      // lib.rs validators.
      const g = lens.length;
      if (basePals.length !== g || tripleCounts.length !== g) throw new Error("batch: length mismatch");
      let dSum = 0;
      let sSum = 0;
      for (let i = 0; i < g; i += 1) {
        dSum += lens[i];
        sSum += tripleCounts[i] * 3;
      }
      if (dSum !== flatDids.length) throw new Error("batch: surface_dids_lens sum != flat_surface_dids length");
      if (sSum !== flatSubs.length) throw new Error("batch: triple sum != flat_sub_palettes length");
      decodes.push({ fn: "batch", n: flatDids.length, epoch });
      const payloads = [];
      let dOff = 0;
      let sOff = 0;
      for (let i = 0; i < g; i += 1) {
        const subs = [...flatSubs].slice(sOff, sOff + tripleCounts[i] * 3).join(",");
        payloads.push([...flatDids].slice(dOff, dOff + lens[i]).map((d) => surface(d, basePals[i], subs)));
        dOff += lens[i];
        sOff += tripleCounts[i] * 3;
      }
      const misses = uniqueMisses(flatDids);
      const absent = provenAbsentOf(flatDids);
      let freed = false;
      const h = {
        get len() {
          return payloads.length;
        },
        get decodeMisses() {
          if (freed) throw new Error("null pointer passed to rust");
          return misses;
        },
        get provenAbsent() {
          if (freed) throw new Error("null pointer passed to rust");
          return absent;
        },
        payloadAt(i) {
          if (i < 0 || i >= payloads.length) return null;
          const p = payloads[i];
          payloads[i] = null;
          return p ?? null;
        },
        wasDrained(i) {
          return i < 0 || i >= payloads.length || payloads[i] === null;
        },
        free() {
          freed = true;
          this.freedCount = (this.freedCount || 0) + 1;
        },
      };
      batchHandles.push(h);
      return h;
    },
  };
  return w;
}

/** Canonical form: own data fields, typed arrays as plain lists, no methods/bookkeeping. */
function canon(v) {
  if (v === null || v === undefined) return v;
  if (ArrayBuffer.isView(v)) return { [v.constructor.name]: [...v] };
  if (Array.isArray(v)) {
    const out = { items: v.map(canon) };
    if ("decodeMisses" in v) out.decodeMisses = v.decodeMisses;
    if ("provenAbsent" in v) out.provenAbsent = [...v.provenAbsent];
    return out;
  }
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (typeof v[k] === "function" || k === "freedCount") continue;
      out[k] = canon(v[k]);
    }
    return out;
  }
  return v;
}
/** Drain a batch handle into a canonical form (single-shot payloads). */
function canonBatch(h) {
  const groups = [];
  for (let i = 0; i < h.len; i += 1) groups.push(canon(h.payloadAt(i)));
  return { len: h.len, groups, decodeMisses: h.decodeMisses, provenAbsent: [...h.provenAbsent] };
}

// 64 distinct ids in a NON-monotonic order (a permutation), so a provenAbsent
// union taken in wave order is not already sorted.
const IDS64 = Array.from({ length: 64 }, (_, i) => 0x01000000 + ((i * 37) % 64) * 3 + 1);
const DIDS64 = Array.from({ length: 64 }, (_, i) => 0x08000000 + ((i * 37) % 64) * 3 + 1);
const PAL = 0x04000abc;
const SUBS = [0x04000111, 0, 8, 0x04000222, 8, 4];
// Entity batch: 8 groups, 64 DIDs; one group (20) is longer than the cap.
const LENS = [5, 7, 3, 20, 4, 9, 6, 10];
const BASE_PALS = LENS.map((_, g) => 0x04000100 + g);
const TRIPLES = LENS.map((_, g) => g % 3);
const FLAT_SUBS = TRIPLES.flatMap((c, g) => Array.from({ length: c * 3 }, (_, k) => 0x04000500 + g * 16 + k));

function inactiveClient(fallbackWaves) {
  return new BakeWorkerClient().configure({
    enabled: false,
    surfaceCoalesce: false,
    batchMax: 0,
    ...(fallbackWaves !== undefined ? { fallbackWaves } : {}),
  });
}
/** Per-task decode load: the largest id count decoded inside one macrotask. */
function maxIdsPerTask(decodes) {
  const by = new Map();
  for (const d of decodes) by.set(d.epoch, (by.get(d.epoch) || 0) + d.n);
  return Math.max(0, ...by.values());
}
function assertWaveShape(wasm, fn, ids, cap, s0) {
  const calls = wasm.calls.filter((c) => c.fn === fn);
  const expected = Math.ceil(ids.length / cap);
  assert.equal(calls.length, expected, `${fn}: ceil(${ids.length}/${cap}) = ${expected} wasm calls`);
  for (let k = 0; k < calls.length; k += 1) {
    assert.deepEqual(calls[k].idsCopy, ids.slice(k * cap, (k + 1) * cap).map((d) => d >>> 0), `${fn}: wave ${k} ids in input order`);
  }
  // The property itself first (each wave's decode in its own task), then the mechanism.
  const decodes = wasm.decodes.filter((d) => d.fn === fn);
  for (let k = 1; k < decodes.length; k += 1) {
    assert.ok(decodes[k].epoch > decodes[k - 1].epoch, `${fn}: wave ${k} decoded in a later macrotask than wave ${k - 1}`);
  }
  assert.equal(maxIdsPerTask(decodes), cap, `${fn}: at most ${cap} ids decoded per task`);
  assert.equal(yieldPosts - s0.p, expected - 1, `${fn}: ${expected - 1} MessageChannel yields between waves`);
  assert.equal(zeroTimeouts - s0.z, 0, `${fn}: no setTimeout(0) yield while MessageChannel exists`);
}

console.log("bake fallback waves (?bakeFallbackWaves)");

await t("W1 flag grammar: default OFF, on/1/true/yes = 16, integer N >= 2 = N", async () => {
  assert.equal(typeof parseBakeFallbackWaves, "function", "parseBakeFallbackWaves exported");
  for (const raw of [null, undefined, "", "off", "0", "false", "no", "OFF", "garbage", "1.5", "-4"]) {
    assert.equal(parseBakeFallbackWaves(raw), 0, `parse(${JSON.stringify(raw)}) = 0 (off)`);
  }
  for (const raw of ["on", "1", "true", "yes", " ON "]) {
    assert.equal(parseBakeFallbackWaves(raw), 16, `parse(${JSON.stringify(raw)}) = 16`);
  }
  assert.equal(parseBakeFallbackWaves("8"), 8);
  assert.equal(parseBakeFallbackWaves("2"), 2);
  assert.equal(parseBakeFallbackWaves(32), 32);
  assert.equal(resolveBakeFallbackWaves(""), 0);
  assert.equal(resolveBakeFallbackWaves("?bakeWorker=0"), 0);
  assert.equal(resolveBakeFallbackWaves("?bakeFallbackWaves=on"), 16);
  assert.equal(resolveBakeFallbackWaves("?bakeFallbackWaves=24"), 24);
  assert.equal(resolveBakeFallbackWaves("?bakeFallbackWaves=off"), 0);
  assert.equal(mod.DEFAULT_BAKE_FALLBACK_WAVE_CAP, 16);
  assert.equal(new BakeWorkerClient().fallbackWaves, 0, "bare client: off");
  assert.equal(new BakeWorkerClient().configure({}).fallbackWaves, 0, "configure, no URL: off");
  assert.equal(new BakeWorkerClient().configure({ fallbackWaves: true }).fallbackWaves, 16);
  assert.equal(new BakeWorkerClient().configure({ fallbackWaves: false }).fallbackWaves, 0);
  assert.equal(new BakeWorkerClient().configure({ fallbackWaves: 8 }).fallbackWaves, 8);
  globalThis.location = { search: "?bakeWorker=0&bakeFallbackWaves=on", href: "http://x/" };
  try {
    const c = new BakeWorkerClient().configure({});
    assert.equal(c.fallbackWaves, 16, "URL ?bakeFallbackWaves=on");
    assert.equal(c.active, false, "with ?bakeWorker=0");
  } finally {
    delete globalThis.location;
    delete globalThis.window.__bakeFallbackWaves;
  }
});

await t("W2 OFF, worker inactive: ONE call per request, original object, no yield; exact export refs; no diag", async () => {
  const c = inactiveClient(false);
  const wasm = makeWasm();
  const s0 = snap();
  const ids = Uint32Array.from(IDS64);
  const dids = Uint32Array.from(DIDS64);
  const flat = Uint32Array.from(DIDS64);
  const mm = await c.fetchModelMeshes(wasm, ids, true);
  const sp = await c.fetchSurfacesPixels(wasm, dids, false);
  const esp = await c.fetchEntitySurfacesPixels(wasm, dids, PAL, SUBS, true);
  const lens = Uint32Array.from(LENS);
  const batch = await c.fetchEntitySurfacesPixelsBatch(wasm, flat, lens, BASE_PALS, FLAT_SUBS, TRIPLES, false);
  assert.equal(wasm.calls.length, 4, "one wasm call per request");
  assert.equal(wasm.calls[0].ids, ids, "model meshes: the caller's ORIGINAL ids object");
  assert.equal(wasm.calls[0].urgent, true);
  assert.equal(wasm.calls[1].ids, dids, "surfaces: original object");
  assert.equal(wasm.calls[2].ids, dids, "entity surfaces: original object");
  assert.equal(wasm.calls[2].subPalettes, SUBS);
  assert.equal(wasm.calls[3].flatDids, flat, "entity batch: original object");
  assert.equal(wasm.calls[3].lens, lens);
  assert.equal(zeroTimeouts - s0.z, 0, "no setTimeout(0)");
  assert.equal(yieldPosts - s0.p, 0, "no MessageChannel post");
  assert.equal(FifoMessageChannel.instances.length, 0, "OFF: no MessageChannel is ever made");
  assert.equal(maxIdsPerTask(wasm.decodes.filter((d) => d.fn === "mm")), 64, "OFF: all 64 decoded in one task (the long task)");
  assert.equal(mm.length, 64);
  assert.equal(sp.length, 64);
  assert.equal(esp.length, 64);
  assert.equal(batch.len, LENS.length);
  assert.equal(c.fallbackWaveStats?.() ?? null, null, "no stats when off");
  // Fetcher shortcuts on the (inactive) singleton: the EXACT export references.
  configureBakeWorker({ enabled: false, fallbackWaves: false });
  assert.equal(modelMeshFetcher(wasm), wasm.fetch_model_meshes);
  assert.equal(surfacePixelsFetcher(wasm), wasm.fetch_surfaces_pixels);
  assert.equal(entitySurfacePixelsFetcher(wasm), wasm.fetchEntitySurfacesPixels);
  assert.equal(entitySurfacesBatchFetcher(wasm), wasm.fetchEntitySurfacesPixelsBatch);
  assert.ok(!Object.prototype.hasOwnProperty.call(globalThis.window, "__bakeFallbackWaves"), "off: no window diag");
});

await t("W3 ON, inactive: 64 model ids -> 4 calls x 16 in input order, 3 macrotask yields, == unsplit", async () => {
  const off = makeWasm();
  const ref = await inactiveClient(false).fetchModelMeshes(off, Uint32Array.from(IDS64), true);
  const c = inactiveClient(true);
  const wasm = makeWasm();
  const s0 = snap();
  const got = await c.fetchModelMeshes(wasm, Uint32Array.from(IDS64), true);
  assertWaveShape(wasm, "mm", IDS64, 16, s0);
  for (const call of wasm.calls) assert.equal(call.urgent, true, "urgent rides every wave");
  assert.deepEqual(canon(got), canon(ref), "results byte-identical to the unsplit call, input order");
  assert.deepEqual(got.map((m) => m.id), IDS64.map((d) => d >>> 0));
});

await t("W4 ON, inactive: 64 surface DIDs -> 4 waves; audit merged == unsplit (sorted provenAbsent)", async () => {
  const ref = await inactiveClient(false).fetchSurfacesPixels(makeWasm(), Uint32Array.from(DIDS64), false);
  const c = inactiveClient(true);
  const wasm = makeWasm();
  const s0 = snap();
  const got = await c.fetchSurfacesPixels(wasm, Uint32Array.from(DIDS64), false);
  assertWaveShape(wasm, "sp", DIDS64, 16, s0);
  assert.ok(ref.provenAbsent.length > 4 && ref.decodeMisses > 0, "fixture exercises both audit fields");
  // A wave-order union is NOT sorted for this permutation — the merge must sort.
  const naive = [...new Set(wasm.calls.flatMap((cl) => provenAbsentOf(cl.idsCopy)))];
  assert.notDeepEqual(naive, ref.provenAbsent, "fixture: wave-order union differs from the sorted list");
  assert.equal(got.decodeMisses, ref.decodeMisses, "decodeMisses = sum over waves = unsplit");
  assert.deepEqual(got.provenAbsent, ref.provenAbsent, "provenAbsent == unsplit (sorted, deduped)");
  assert.deepEqual(canon(got), canon(ref), "results + audit byte-identical to the unsplit call");
});

await t("W5 ON, inactive: 64 entity surface DIDs -> 4 waves, palette state on every wave, == unsplit", async () => {
  const ref = await inactiveClient(false).fetchEntitySurfacesPixels(makeWasm(), Uint32Array.from(DIDS64), PAL, SUBS, true);
  const c = inactiveClient(true);
  const wasm = makeWasm();
  const s0 = snap();
  const got = await c.fetchEntitySurfacesPixels(wasm, Uint32Array.from(DIDS64), PAL, SUBS, true);
  assertWaveShape(wasm, "esp", DIDS64, 16, s0);
  for (const call of wasm.calls) {
    assert.equal(call.paletteId, PAL);
    assert.equal(call.subPalettes, SUBS);
    assert.equal(call.urgent, true);
  }
  assert.deepEqual(canon(got), canon(ref), "results + audit byte-identical to the unsplit call");
});

await t("W6 ON, inactive: entity batch -> group waves, ONE handle-shaped result == unsplit, waves freed", async () => {
  const refH = await inactiveClient(false).fetchEntitySurfacesPixelsBatch(
    makeWasm(), Uint32Array.from(DIDS64), Uint32Array.from(LENS), BASE_PALS, FLAT_SUBS, TRIPLES, true,
  );
  const ref = canonBatch(refH);
  const c = inactiveClient(true);
  const wasm = makeWasm();
  const s0 = snap();
  const h = await c.fetchEntitySurfacesPixelsBatch(
    wasm, Uint32Array.from(DIDS64), Uint32Array.from(LENS), BASE_PALS, FLAT_SUBS, TRIPLES, true,
  );
  const gw = splitEntityBatchGroupWaves(LENS, 16);
  assert.equal(gw.length, 4, "fixture: 4 group waves (one 20-DID group ships alone)");
  const calls = wasm.calls.filter((cl) => cl.fn === "batch");
  assert.equal(calls.length, gw.length, "one wasm call per group wave");
  for (let k = 0; k < gw.length; k += 1) {
    const [gLo, gHi] = gw[k];
    assert.deepEqual(calls[k].args[1], LENS.slice(gLo, gHi), `wave ${k} groups`);
    assert.deepEqual(calls[k].args[2], BASE_PALS.slice(gLo, gHi), `wave ${k} base palettes`);
    assert.equal(calls[k].urgent, true);
  }
  const decodes = wasm.decodes.filter((d) => d.fn === "batch");
  for (let k = 1; k < decodes.length; k += 1) assert.ok(decodes[k].epoch > decodes[k - 1].epoch, `group wave ${k} in its own task`);
  assert.equal(maxIdsPerTask(decodes), 20, "largest task = the lone 20-DID group (max(cap, longest group))");
  assert.equal(yieldPosts - s0.p, gw.length - 1, "a MessageChannel yield between group waves");
  assert.equal(zeroTimeouts - s0.z, 0, "no setTimeout(0) yield while MessageChannel exists");
  assert.equal(h.len, LENS.length);
  const got = canonBatch(h);
  assert.deepEqual(got, ref, "per-group payloads + audit == unsplit");
  assert.equal(h.payloadAt(0), null, "single-shot payloadAt");
  assert.equal(h.wasDrained(0), true);
  assert.equal(wasm.batchHandles.length, gw.length);
  assert.ok(wasm.batchHandles.every((wh) => wh.freedCount === 1), "every wave's wasm handle freed once after the merge");
});

await t("W7 ON, a request that fits one wave: today's single call, original object, synchronous, no yield", async () => {
  const c = inactiveClient(true);
  const wasm = makeWasm();
  const s0 = snap();
  const ids = Uint32Array.from(IDS64.slice(0, 16));
  const p = c.fetchModelMeshes(wasm, ids, false);
  assert.equal(wasm.calls.length, 1, "wasm called synchronously inside the call");
  assert.equal(wasm.calls[0].ids, ids, "the caller's ORIGINAL object");
  await p;
  const dids = DIDS64.slice(0, 5);
  await c.fetchSurfacesPixels(wasm, dids, false);
  assert.equal(wasm.calls[1].ids, dids);
  const empty = new Uint32Array(0);
  await c.fetchModelMeshes(wasm, empty, false);
  assert.equal(wasm.calls[2].ids, empty, "an empty request is passed through as today");
  const lens = [3, 4];
  await c.fetchEntitySurfacesPixelsBatch(wasm, DIDS64.slice(0, 7), lens, [1, 2], [], [0, 0], false);
  assert.equal(wasm.calls[3].lens, lens, "a one-wave entity batch is the single call");
  assert.equal(wasm.calls.length, 4);
  assert.equal(zeroTimeouts - s0.z, 0, "no setTimeout(0)");
  assert.equal(yieldPosts - s0.p, 0, "no MessageChannel yield");
});

async function backoffClient(fallbackWaves) {
  globalThis.Worker = ManualWorker;
  const c = new BakeWorkerClient().configure({ enabled: true, surfaceCoalesce: false, batchMax: 0, fallbackWaves });
  c._workerRetryAtMs = performance.now() + 1e9; // F1 crash backoff: _ensureWorker refuses
  return c;
}

await t("W8 ON, worker active but in crash backoff: the four catch-path fallbacks run in waves", async () => {
  try {
    await quiet(async () => {
      const refC = await backoffClient(false);
      const refW = makeWasm();
      const rMm = await refC.fetchModelMeshes(refW, Uint32Array.from(IDS64), false);
      const rSp = await refC.fetchSurfacesPixels(refW, Uint32Array.from(DIDS64), false);
      const rEsp = await refC.fetchEntitySurfacesPixels(refW, Uint32Array.from(DIDS64), PAL, SUBS, false);
      const rB = canonBatch(await refC.fetchEntitySurfacesPixelsBatch(refW, Uint32Array.from(DIDS64), LENS, BASE_PALS, FLAT_SUBS, TRIPLES, false));
      assert.equal(refC.active, true, "worker path is active");
      assert.equal(refW.calls.length, 4, "OFF: one main-thread call per failed request");

      const c = await backoffClient(true);
      const wasm = makeWasm();
      let s0 = snap();
      const mm = await c.fetchModelMeshes(wasm, Uint32Array.from(IDS64), false);
      assertWaveShape(wasm, "mm", IDS64, 16, s0);
      s0 = snap();
      const sp = await c.fetchSurfacesPixels(wasm, Uint32Array.from(DIDS64), false);
      assertWaveShape(wasm, "sp", DIDS64, 16, s0);
      s0 = snap();
      const esp = await c.fetchEntitySurfacesPixels(wasm, Uint32Array.from(DIDS64), PAL, SUBS, false);
      assertWaveShape(wasm, "esp", DIDS64, 16, s0);
      const b = canonBatch(await c.fetchEntitySurfacesPixelsBatch(wasm, Uint32Array.from(DIDS64), LENS, BASE_PALS, FLAT_SUBS, TRIPLES, false));
      assert.equal(wasm.calls.filter((cl) => cl.fn === "batch").length, 4, "entity batch: 4 group waves");
      assert.deepEqual(canon(mm), canon(rMm), "model meshes == unsplit");
      assert.deepEqual(canon(sp), canon(rSp), "surfaces == unsplit");
      assert.deepEqual(canon(esp), canon(rEsp), "entity surfaces == unsplit");
      assert.deepEqual(b, rB, "entity batch == unsplit");
      assert.equal(c._stats.fallbacks.total, 4, "fallbacks still counted once per request");
      assert.equal(ManualWorker.instances.length, 0, "no worker spawned in backoff");
    });
  } finally {
    delete globalThis.Worker;
  }
});

async function readyClient(fallbackWaves) {
  ManualWorker.instances.length = 0;
  globalThis.Worker = ManualWorker;
  const c = new BakeWorkerClient().configure({ enabled: true, surfaceCoalesce: false, batchMax: 0, fallbackWaves });
  const ready = c._ensureWorker();
  const w = ManualWorker.instances[0];
  w.reply({ type: "ready", id: w.posted[0].id });
  await ready;
  w.posted.length = 0;
  return { c, w };
}

await t("W9 ON, alias in an entity batch: the whole-batch main-wasm divert runs in group waves", async () => {
  try {
    await quiet(async () => {
      const flat = Uint32Array.from(DIDS64);
      flat[30] = 0x08f00001; // a tex-swap alias: main-thread wasm only
      const { c: refC, w: refWk } = await readyClient(false);
      const refW = makeWasm();
      const rB = canonBatch(await refC.fetchEntitySurfacesPixelsBatch(refW, flat, LENS, BASE_PALS, FLAT_SUBS, TRIPLES, true));
      assert.equal(refW.calls.length, 1, "OFF: the whole batch in one main-thread call");
      assert.equal(refWk.posted.length, 0);

      const { c, w } = await readyClient(true);
      const wasm = makeWasm();
      const s0 = snap();
      const b = canonBatch(await c.fetchEntitySurfacesPixelsBatch(wasm, flat, LENS, BASE_PALS, FLAT_SUBS, TRIPLES, true));
      await flush();
      assert.equal(w.posted.length, 0, "nothing posted to the worker");
      assert.equal(wasm.calls.length, 4, "ON: 4 group waves on the main wasm");
      for (let k = 1; k < wasm.decodes.length; k += 1) {
        assert.ok(wasm.decodes[k].epoch > wasm.decodes[k - 1].epoch, `group wave ${k} decoded in its own task`);
      }
      assert.equal(yieldPosts - s0.p, 3, "3 MessageChannel yields");
      assert.equal(zeroTimeouts - s0.z, 0, "no setTimeout(0) yield while MessageChannel exists");
      assert.deepEqual(b, rB, "== the unsplit divert");
    });
  } finally {
    delete globalThis.Worker;
  }
});

await t("W10 ON, inactive fetcher shortcuts: wave wrappers; stale-pkg exports returned as-is", async () => {
  configureBakeWorker({ enabled: false, fallbackWaves: true });
  try {
    const wasm = makeWasm();
    const mmF = modelMeshFetcher(wasm);
    const spF = surfacePixelsFetcher(wasm);
    const espF = entitySurfacePixelsFetcher(wasm);
    const bF = entitySurfacesBatchFetcher(wasm);
    assert.notEqual(mmF, wasm.fetch_model_meshes, "armed: a wrapper, not the raw export");
    let s0 = snap();
    const mm = await mmF(Uint32Array.from(IDS64), true);
    assertWaveShape(wasm, "mm", IDS64, 16, s0);
    assert.deepEqual(canon(mm), canon(await inactiveClient(false).fetchModelMeshes(makeWasm(), Uint32Array.from(IDS64), true)));
    s0 = snap();
    const sp = await spF(Uint32Array.from(DIDS64), false);
    assertWaveShape(wasm, "sp", DIDS64, 16, s0);
    assert.deepEqual(canon(sp), canon(await inactiveClient(false).fetchSurfacesPixels(makeWasm(), Uint32Array.from(DIDS64), false)));
    s0 = snap();
    const esp = await espF(Uint32Array.from(DIDS64), PAL, SUBS, false);
    assertWaveShape(wasm, "esp", DIDS64, 16, s0);
    const b = await bF(Uint32Array.from(DIDS64), LENS, BASE_PALS, FLAT_SUBS, TRIPLES, false);
    assert.equal(wasm.calls.filter((cl) => cl.fn === "batch").length, 4);
    assert.equal(b.len, LENS.length);
    assert.equal(esp.length, 64);
    // A pkg that predates an export: still handed back as-is (callers gate on typeof).
    assert.equal(modelMeshFetcher({}), undefined);
    assert.equal(surfacePixelsFetcher({}), undefined);
    assert.equal(entitySurfacePixelsFetcher({}), undefined);
    assert.equal(entitySurfacesBatchFetcher({}), undefined);
  } finally {
    configureBakeWorker({ enabled: false, fallbackWaves: false });
  }
});

await t("W11 a wave rejects: the call rejects, earlier waves' handles freed, no later wave starts", async () => {
  const c = inactiveClient(true);
  const wasm = makeWasm({ failOnCall: 3 });
  const freedBefore = [];
  const origMm = wasm.fetch_model_meshes;
  wasm.fetch_model_meshes = async (ids, urgent) => {
    const out = await origMm(ids, urgent);
    freedBefore.push(...out);
    return out;
  };
  await assert.rejects(c.fetchModelMeshes(wasm, Uint32Array.from(IDS64), false), /call 3 failed/);
  assert.equal(wasm.calls.length, 3, "wave 4 never starts");
  assert.equal(freedBefore.length, 32, "two waves had landed");
  assert.ok(freedBefore.every((m) => m.freedCount === 1), "every landed handle freed exactly once");
  const wb = makeWasm({ failOnCall: 2 });
  await assert.rejects(
    c.fetchEntitySurfacesPixelsBatch(wb, Uint32Array.from(DIDS64), LENS, BASE_PALS, FLAT_SUBS, TRIPLES, false),
    /call 2 failed/,
  );
  assert.equal(wb.calls.length, 2, "batch: no wave after the failure");
  assert.equal(wb.batchHandles.length, 1);
  assert.equal(wb.batchHandles[0].freedCount, 1, "batch: the landed wave's handle freed");
});

await t("W12 entity batch whose parallel arrays do not line up: not split (the single call rejects)", async () => {
  const c = inactiveClient(true);
  const wasm = makeWasm();
  const lens = [...LENS];
  lens[0] += 1; // sum(lens) = 65 != 64 DIDs
  await assert.rejects(
    c.fetchEntitySurfacesPixelsBatch(wasm, Uint32Array.from(DIDS64), lens, BASE_PALS, FLAT_SUBS, TRIPLES, false),
    /surface_dids_lens sum/,
  );
  assert.equal(wasm.calls.length, 1, "one call with the original arrays");
  assert.equal(wasm.calls[0].lens, lens);
});

await t("W13 surfaces with DIDs repeated across waves: positions + provenAbsent == unsplit", async () => {
  const dids = Array.from({ length: 48 }, (_, i) => 0x08000000 + ((i * 7) % 20) * 5);
  const ref = await inactiveClient(false).fetchSurfacesPixels(makeWasm(), dids, false);
  const wasm = makeWasm();
  const got = await inactiveClient(true).fetchSurfacesPixels(wasm, dids, false);
  assert.equal(wasm.calls.length, 3);
  assert.deepEqual(got.map((s) => s.luminosity), dids.map((d) => d >>> 0), "positional, duplicates preserved");
  assert.deepEqual(got.provenAbsent, ref.provenAbsent, "provenAbsent deduped + sorted == unsplit");
  assert.deepEqual(canon(got).items, canon(ref).items);
});

await t("W14 diag: window.__bakeFallbackWaves.stats() installed only when armed", async () => {
  delete globalThis.window.__bakeFallbackWaves;
  inactiveClient(false);
  assert.ok(!Object.prototype.hasOwnProperty.call(globalThis.window, "__bakeFallbackWaves"), "off: not installed");
  const c = inactiveClient(true);
  assert.equal(typeof globalThis.window.__bakeFallbackWaves?.stats, "function", "on: installed");
  await c.fetchModelMeshes(makeWasm(), Uint32Array.from(IDS64), false);
  await c.fetchSurfacesPixels(makeWasm(), DIDS64.slice(0, 8), false);
  const s = globalThis.window.__bakeFallbackWaves.stats();
  assert.equal(s.cap, 16);
  assert.equal(s.calls, 2);
  assert.equal(s.split, 1);
  assert.equal(s.waves, 5);
  assert.equal(s.yields, 3);
  assert.equal(s.maxIds, 64);
  assert.equal(s.byType.fetchModelMeshes.waves, 4);
  assert.equal(s.byType.fetchSurfacesPixels.split, 0);
  assert.equal(s.yieldVia, "MessageChannel", "stats name the yield mechanism");
  delete globalThis.window.__bakeFallbackWaves;
});

await t("W15 the yield is a macrotask, not a timer: tasks queued during wave k run before wave k+1; MessageChannel posts", async () => {
  const c = inactiveClient(true);
  const wasm = makeWasm();
  const log = [];
  // Another party's work, queued while a wave decodes: a zero-delay timer and
  // a message on a channel of its own (a frame is one more such task).
  const other = new FifoMessageChannel();
  other.testOwned = true;
  other.port1.onmessage = (e) => log.push(`M${e.data}`);
  const mc = () => moduleChannels()[0];
  const origMm = wasm.fetch_model_meshes;
  let k = 0;
  wasm.fetch_model_meshes = (ids, urgent) => {
    const wave = k++;
    log.push(`C${wave}`);
    return origMm(ids, urgent).then((out) => {
      const timer = () => log.push(`T${wave}:${mc()?.port1.refd ? "ref" : "unref"}`);
      timer.testOwned = true;
      setTimeout(timer, 0);
      other.port2.postMessage(wave);
      return out;
    });
  };
  const s0 = snap();
  const got = await c.fetchModelMeshes(wasm, Uint32Array.from(IDS64), false);
  await new Promise((resolve) => {
    const drained = () => resolve();
    drained.testOwned = true;
    setTimeout(drained, 0); // FIFO: runs after T3 / M3
  });
  // The property: what was queued during wave k ran before wave k+1 started.
  for (let w = 0; w < 3; w += 1) {
    const next = log.indexOf(`C${w + 1}`);
    assert.ok(next > 0, `wave ${w + 1} started`);
    assert.ok(log.findIndex((e) => e.startsWith(`T${w}:`)) < next, `the setTimeout(0) queued during wave ${w} ran before wave ${w + 1}`);
    assert.ok(log.indexOf(`M${w}`) < next, `the message posted during wave ${w} ran before wave ${w + 1}`);
  }
  // The mechanism: one MessageChannel post per yield, never a timer; one
  // channel kept for the page; its receiving port ref'd only while a yield waits.
  assert.equal(yieldPosts - s0.p, 3, "3 MessageChannel yields");
  assert.equal(zeroTimeouts - s0.z, 0, "no setTimeout(0) from the module");
  assert.equal(moduleChannels().length, 1, "one channel, made on the first armed yield and reused");
  assert.deepEqual(
    log,
    ["C0", "T0:ref", "M0", "C1", "T1:ref", "M1", "C2", "T2:ref", "M2", "C3", "T3:unref", "M3"],
    "task order; port ref'd while a yield waits, unref'd once drained",
  );
  assert.equal(got.length, 64);
});

await t("W16 a 320-id request: 20 waves, 19 yields, and the modelled nested-timer clamp charges 0 ms", async () => {
  const ids = Array.from({ length: 320 }, (_, i) => 0x01000000 + i * 3);
  const c = inactiveClient(true);
  const wasm = makeWasm();
  const s0 = snap();
  const got = await c.fetchModelMeshes(wasm, Uint32Array.from(ids), false);
  const yieldsClamp = clampMs - s0.clamp;
  assert.equal(wasm.calls.length, 20, "20 waves");
  assert.equal(c.fallbackWaveStats().yields, 19, "19 yields");
  assert.equal(maxIdsPerTask(wasm.decodes), 16);
  assert.deepEqual(got.map((m) => m.id), ids.map((d) => d >>> 0), "input order");
  assert.equal(yieldsClamp, 0, `no nested-timer clamp on the yields (a chained setTimeout(0) yield is charged 60 ms; got ${yieldsClamp} ms)`);
  // Control: the model does charge a 19-deep setTimeout(0) chain Chrome's clamp
  // (levels 5..19 = 15 timers x 4 ms), so the 0 above is not vacuous.
  const c0 = clampMs;
  await new Promise((resolve) => {
    let n = 0;
    const step = () => {
      n += 1;
      if (n < 19) setTimeout(step, 0);
      else resolve();
    };
    step.testOwned = true;
    setTimeout(step, 0);
  });
  assert.equal(clampMs - c0, 60, "control: a 19-deep setTimeout(0) chain = 15 x 4 ms");
});

await t("W17 no MessageChannel (fresh module instance): setTimeout(0) fallback, one macrotask per wave, == unsplit", async () => {
  const saved = globalThis.MessageChannel;
  delete globalThis.MessageChannel;
  try {
    const fresh = await import("../scene3d/bake_worker_client.js?w17-no-message-channel");
    assert.notEqual(fresh.BakeWorkerClient, BakeWorkerClient, "a separate module instance");
    const ref = await inactiveClient(false).fetchModelMeshes(makeWasm(), Uint32Array.from(IDS64), true);
    const c = new fresh.BakeWorkerClient().configure({ enabled: false, surfaceCoalesce: false, batchMax: 0, fallbackWaves: true });
    const wasm = makeWasm();
    const s0 = snap();
    const got = await c.fetchModelMeshes(wasm, Uint32Array.from(IDS64), true);
    assert.equal(wasm.calls.length, 4, "4 waves");
    for (let k = 1; k < wasm.decodes.length; k += 1) {
      assert.ok(wasm.decodes[k].epoch > wasm.decodes[k - 1].epoch, `wave ${k} decoded in a later macrotask`);
    }
    assert.equal(maxIdsPerTask(wasm.decodes), 16);
    assert.equal(zeroTimeouts - s0.z, 3, "3 setTimeout(0) yields");
    assert.equal(yieldPosts - s0.p, 0, "no MessageChannel");
    assert.equal(c.fallbackWaveStats().yieldVia, "setTimeout");
    assert.deepEqual(canon(got), canon(ref), "== unsplit");
  } finally {
    globalThis.MessageChannel = saved;
    delete globalThis.window.__bakeFallbackWaves;
  }
});

await t("W18 real Node MessageChannel (child process): completes, no setTimeout(0), not microtasks, exits by itself", async () => {
  const modUrl = new URL("../scene3d/bake_worker_client.js", import.meta.url).href;
  const code = [
    "const realSetTimeout = globalThis.setTimeout;",
    "let zero = 0;",
    "globalThis.setTimeout = (fn, ms, ...a) => { if (!(Number(ms) > 0)) zero += 1; return realSetTimeout(fn, ms, ...a); };",
    `const { BakeWorkerClient } = await import(${JSON.stringify(modUrl)});`,
    "const calls = [];",
    "const wasm = { async fetch_model_meshes(ids) { calls.push(ids.length); await null; return Array.from(ids, (id) => ({ id })); } };",
    "const c = new BakeWorkerClient().configure({ enabled: false, surfaceCoalesce: false, batchMax: 0, fallbackWaves: true });",
    "const p = c.fetchModelMeshes(wasm, Uint32Array.from({ length: 64 }, (_, i) => i + 1), false);",
    "for (let i = 0; i < 1000; i += 1) await null;",
    "const afterMicrotasks = calls.length;",
    "const out = await p;",
    "const s = c.fallbackWaveStats();",
    "console.log(JSON.stringify({ afterMicrotasks, calls, n: out.length, ordered: out.every((m, i) => m.id === i + 1), zero, yields: s.yields, via: s.yieldVia }));",
  ].join("\n");
  // Throws if the child hangs (a port left ref'd keeps a Node process alive).
  const stdout = execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], {
    timeout: 15000,
    encoding: "utf8",
  });
  const r = JSON.parse(stdout.trim().split("\n").pop());
  assert.equal(r.afterMicrotasks, 1, "wave 1 needs a macrotask: 1000 microtasks reach only wave 0");
  assert.deepEqual(r.calls, [16, 16, 16, 16]);
  assert.equal(r.n, 64);
  assert.equal(r.ordered, true);
  assert.equal(r.yields, 3);
  assert.equal(r.zero, 0, "no setTimeout(0) while MessageChannel exists");
  assert.equal(r.via, "MessageChannel");
});

await t("W19 configure() on then off: window.__bakeFallbackWaves removed; a diag it did not install is left alone", async () => {
  const w = globalThis.window;
  const has = () => Object.prototype.hasOwnProperty.call(w, "__bakeFallbackWaves");
  delete w.__bakeFallbackWaves;
  const c = new BakeWorkerClient().configure({ enabled: false, fallbackWaves: true });
  assert.equal(w.__bakeFallbackWaves?.stats()?.cap, 16, "armed: installed");
  c.configure({ enabled: false, fallbackWaves: false });
  assert.equal(c.fallbackWaveStats(), null);
  assert.ok(!has(), "off reconfigure: removed, as if never armed");
  c.configure({ enabled: false, fallbackWaves: 8 });
  assert.equal(w.__bakeFallbackWaves?.stats()?.cap, 8, "re-armed: installed again");
  const other = new BakeWorkerClient().configure({ enabled: false, fallbackWaves: true });
  c.configure({ enabled: false, fallbackWaves: false });
  assert.equal(w.__bakeFallbackWaves?.stats()?.cap, 16, "another armed client's diag left alone");
  other.configure({ enabled: false, fallbackWaves: false });
  assert.ok(!has(), "that client's own off reconfigure removes it");
  const foreign = { stats: () => "foreign" };
  w.__bakeFallbackWaves = foreign;
  new BakeWorkerClient().configure({ enabled: false, fallbackWaves: false });
  c.configure({ enabled: false, fallbackWaves: false });
  assert.equal(w.__bakeFallbackWaves, foreign, "an off configure never removes a diag it did not install");
  delete w.__bakeFallbackWaves;
  // The production path: the singleton armed through configureBakeWorker, then off.
  configureBakeWorker({ enabled: false, fallbackWaves: true });
  assert.equal(typeof w.__bakeFallbackWaves?.stats, "function", "singleton armed: installed");
  configureBakeWorker({ enabled: false, fallbackWaves: false });
  assert.ok(!has(), "singleton on then off: no diag left");
});

await t("W20 two concurrent armed requests: yields resolve FIFO (the waves alternate), both == unsplit", async () => {
  const refA = await inactiveClient(false).fetchModelMeshes(makeWasm(), Uint32Array.from(IDS64), false);
  const refB = await inactiveClient(false).fetchSurfacesPixels(makeWasm(), Uint32Array.from(DIDS64), false);
  const c = inactiveClient(true);
  const wasm = makeWasm();
  const s0 = snap();
  const [a, b] = await Promise.all([
    c.fetchModelMeshes(wasm, Uint32Array.from(IDS64), false),
    c.fetchSurfacesPixels(wasm, Uint32Array.from(DIDS64), false),
  ]);
  assert.deepEqual(
    wasm.calls.map((cl) => cl.fn),
    ["mm", "sp", "mm", "sp", "mm", "sp", "mm", "sp"],
    "the two requests' waves alternate (FIFO yields; neither starves the other)",
  );
  assert.equal(yieldPosts - s0.p, 6, "6 MessageChannel yields");
  assert.equal(zeroTimeouts - s0.z, 0);
  assert.deepEqual(canon(a), canon(refA));
  assert.deepEqual(canon(b), canon(refB));
});

globalThis.setTimeout = realSetTimeout;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
