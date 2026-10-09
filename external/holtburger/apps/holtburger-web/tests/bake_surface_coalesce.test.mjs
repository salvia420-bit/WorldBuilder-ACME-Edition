// tests/bake_surface_coalesce.test.mjs — `?bakeSurfaceCoalesce` (2026-10-09).
//
// `MaterialCache.get(did)` posts ONE surface per worker message; on the 1070
// (Town Network first entry) ~113 such messages queued behind the in-flight
// cap of 4 and drained at ~30/s. ON: when the queue pump dispatches a
// `fetchSurfacesPixels`, the same-lane, same-urgency `fetchSurfacesPixels`
// requests still QUEUED ride in the same message (deduped, FIFO, up to a DID
// cap); the reply is split back to each caller by index.
//
//   S1  N queued single-DID requests -> 1 merged message; per-caller results
//   S2  per-caller audit: provenAbsent partitioned, decodeMisses = merged total
//   S3  duplicate DIDs: deduped in the message, every caller its own buffers
//   S4  worker error -> every merged caller takes its own main-thread fallback
//   S5  malformed reply (length mismatch) -> every caller falls back
//   S6  dispatch throw on a merged post -> every member rejects, pump goes on
//   S7  lanes / urgency / other types: never merged across; FIFO never skips
//   S8  DID cap: stops at the first request that does not fit; bakeBatchMax lowers it
//   S9  zero added latency: a lone request posts synchronously, original body;
//       the client never arms a timer
//   S10 =off (and a bare unconfigured client): one message per request
//   S11 _failAll / terminate with a merged post in flight: all reject, late reply ignored
//   S12 alias split: the worker leg merges, the stitch still lines up
//   S13 diag: __diag.bakeWorkerStats() exposes queue.coalesce + byType.coalesced
//   S14 flag grammar + docs row
//
// Run: node tests/bake_surface_coalesce.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

// Manual fake worker: records posts; the test decides when (and what) it replies.
class ManualWorker {
  constructor() {
    ManualWorker.instances.push(this);
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
    this.throwOnPost = null; // (msg) => bool
  }
  postMessage(msg) {
    if (this.throwOnPost && this.throwOnPost(msg)) throw new Error("DataCloneError (test)");
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
globalThis.Worker = ManualWorker;
// The diag surface (`__diag.bakeWorkerStats`) installs only when `window` exists.
globalThis.window = globalThis.window || {};

const mod = await import("../scene3d/bake_worker_client.js");
const {
  BakeWorkerClient,
  getBakeWorkerClient,
  parseBakeSurfaceCoalesce,
  resolveBakeSurfaceCoalesce,
  splitSurfaceAuditForCaller,
} = mod;

let passed = 0;
let failed = 0;
async function t(name, fn) {
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

const WORKER = 7;
const MAIN = 9;
/** A worker-side `SurfacePixelsPayload` (the transferred shape). */
function payload(did) {
  return {
    width: 1,
    height: 1,
    pixels: new Uint8Array([did & 0xff, (did >>> 8) & 0xff, 1, 255]),
    surfaceType: 0,
    category: 0,
    normalPixels: new Uint8Array([1, 2, 3]),
    heightPixels: new Uint8Array([4]),
    roughnessOverride: NaN,
    normalScaleOverride: NaN,
    translucency: 0,
    luminosity: did >>> 0, // marker: which DID this is
    diffuse: WORKER, // marker: decoded in the worker
  };
}
const hex = (d) => "0x" + (d >>> 0).toString(16).toUpperCase().padStart(8, "0");

/** A main-thread wasm stub (fallback path): wasm-bindgen-like handles with free(). */
function makeWasm() {
  const calls = [];
  return {
    calls,
    async fetch_surfaces_pixels(ids, urgent) {
      const arr = [...ids].map((d) => ({
        width: 1,
        height: 1,
        pixels: new Uint8Array(4),
        luminosity: d >>> 0,
        diffuse: MAIN,
        freed: 0,
        free() { this.freed += 1; },
      }));
      calls.push({ ids: [...ids], urgent });
      arr.decodeMisses = 0;
      arr.provenAbsent = [];
      return arr;
    },
  };
}

/** A configured, worker-active client whose init has completed. */
async function readyClient({ cap = 1, coalesce = true, batchMax } = {}) {
  ManualWorker.instances.length = 0;
  const c = new BakeWorkerClient().configure({
    enabled: true,
    surfaceCoalesce: coalesce,
    ...(batchMax !== undefined ? { batchMax } : {}),
  });
  c._queueEnabled = true;
  c._queueCap = cap;
  const ready = c._ensureWorker();
  const w = ManualWorker.instances[0];
  assert.equal(w.posted[0].type, "init");
  w.reply({ type: "ready", id: w.posted[0].id });
  await ready;
  w.posted.length = 0;
  return { c, w };
}
const fetches = (w) => w.posted.filter((m) => m.type !== "init");
/** Reply to a posted surface message with one payload per posted DID. */
function answer(w, m, audit) {
  w.reply({ type: "result", id: m.id, kind: "surfaces", payload: m.dids.map(payload), audit });
}

console.log("bake surface coalescing (?bakeSurfaceCoalesce)");

await t("S1 N queued single-DID requests -> ONE merged message, per-caller results", async () => {
  const { c, w } = await readyClient({ cap: 1 });
  const wasm = makeWasm();
  const dids = [0x08000010, 0x08000011, 0x08000012, 0x08000013, 0x08000014, 0x08000015];
  const ps = dids.map((d) => c.fetchSurfacesPixels(wasm, new Uint32Array([d])));
  await flush();
  // cap 1: the first request is in flight, the other five are queued.
  assert.equal(fetches(w).length, 1, "only the head is posted while the slot is busy");
  assert.deepEqual(fetches(w)[0].dids, [dids[0]]);
  answer(w, fetches(w)[0]);
  // The freed slot takes the next request AND the four behind it.
  assert.equal(fetches(w).length, 2, "the five queued requests went out as ONE message");
  const merged = fetches(w)[1];
  assert.deepEqual(merged.dids, dids.slice(1), "merged DIDs in FIFO order");
  assert.equal(merged.urgent, false);
  answer(w, merged);
  const results = await Promise.all(ps);
  for (let i = 0; i < dids.length; i += 1) {
    assert.equal(results[i].length, 1, `caller ${i} gets exactly its own slot`);
    assert.equal(results[i][0].luminosity, dids[i], `caller ${i} gets its own DID`);
    assert.equal(results[i][0].diffuse, WORKER, `caller ${i} decoded in the worker`);
  }
  assert.equal(wasm.calls.length, 0, "no main-thread fallback");
  const q = c._stats.queue;
  assert.equal(q.posted, 3, "queue.posted counts MESSAGES (init + head + one merged)");
  assert.equal(q.coalesced, 4, "four requests rode in another's message");
  assert.equal(q.coalescedPosts, 1);
  assert.equal(q.coalescedMaxDids, 5);
  assert.equal(q.byLane[1].count, 6, "byLane counts every REQUEST");
  const b = c._stats.byType.fetchSurfacesPixels;
  assert.equal(b.count, 6, "byType.count stays per request");
  assert.equal(b.failed, 0);
  assert.equal(b.coalesced, 5, "head + 4 riders answered from a merged message");
  assert.equal(c._coalesced.size, 0, "group record dropped on reply");
  assert.equal(c._pending.size, 0);
  assert.equal(c._inFlightPosted, 0);
});

await t("S2 per-caller audit: provenAbsent partitioned, decodeMisses = merged total", async () => {
  const { c, w } = await readyClient({ cap: 1 });
  const wasm = makeWasm();
  const head = c.fetchSurfacesPixels(wasm, new Uint32Array([0x08000001]));
  await flush();
  const pa = c.fetchSurfacesPixels(wasm, new Uint32Array([0x08000020, 0x08000021]));
  const pb = c.fetchSurfacesPixels(wasm, new Uint32Array([0x08000030]));
  const pc = c.fetchSurfacesPixels(wasm, new Uint32Array([0x08000040]));
  await flush();
  answer(w, fetches(w)[0], { decodeMisses: 0, provenAbsent: [] });
  const merged = fetches(w)[1];
  assert.deepEqual(merged.dids, [0x08000020, 0x08000021, 0x08000030, 0x08000040]);
  // Mixed spellings on purpose: the wasm writes "0x%08X", other paths may not pad.
  answer(w, merged, { decodeMisses: 3, provenAbsent: [hex(0x08000021), "0x8000040"] });
  const [ra, rb, rc] = await Promise.all([pa, pb, pc]);
  await head;
  assert.deepEqual(ra.provenAbsent, [hex(0x08000021)], "A sees only its own absent DID");
  assert.deepEqual(rb.provenAbsent, [], "B: audit-shaped, nothing absent (never legacy)");
  assert.deepEqual(rc.provenAbsent, ["0x8000040"], "C keeps the wasm's spelling");
  for (const r of [ra, rb, rc]) assert.equal(r.decodeMisses, 3, "call-level misses: merged total");
  // A legacy (audit-less) merged reply stays legacy for every caller.
  assert.equal(splitSurfaceAuditForCaller(null, [1]), null);
  assert.equal(splitSurfaceAuditForCaller(undefined, [1]), null);
  assert.deepEqual(splitSurfaceAuditForCaller({ decodeMisses: 2 }, [1]), { decodeMisses: 2 });
  assert.deepEqual(
    splitSurfaceAuditForCaller({ provenAbsent: ["0x00000005", "0x00000006"] }, [6]),
    { provenAbsent: ["0x00000006"] },
  );
});

await t("S2b a legacy (audit-less) merged reply leaves every caller legacy-shaped", async () => {
  const { c, w } = await readyClient({ cap: 1 });
  const wasm = makeWasm();
  const head = c.fetchSurfacesPixels(wasm, new Uint32Array([1]));
  await flush();
  const pa = c.fetchSurfacesPixels(wasm, new Uint32Array([2]));
  const pb = c.fetchSurfacesPixels(wasm, new Uint32Array([3]));
  await flush();
  answer(w, fetches(w)[0]);
  answer(w, fetches(w)[1]); // no audit at all
  const [ra, rb] = await Promise.all([pa, pb]);
  await head;
  for (const r of [ra, rb]) {
    assert.equal(r.decodeMisses, undefined);
    assert.equal(r.provenAbsent, undefined);
  }
});

await t("S3 duplicate DIDs: deduped in the message, every caller its own objects + buffers", async () => {
  const { c, w } = await readyClient({ cap: 1 });
  const wasm = makeWasm();
  const A = 0x0800000a, B = 0x0800000b, C = 0x0800000c;
  const head = c.fetchSurfacesPixels(wasm, new Uint32Array([0x08000001]));
  await flush();
  const p1 = c.fetchSurfacesPixels(wasm, new Uint32Array([A, B]));
  const p2 = c.fetchSurfacesPixels(wasm, new Uint32Array([B, C]));
  const p3 = c.fetchSurfacesPixels(wasm, new Uint32Array([A, A]));
  await flush();
  answer(w, fetches(w)[0]);
  const merged = fetches(w)[1];
  assert.deepEqual(merged.dids, [A, B, C], "each DID decoded once");
  answer(w, merged);
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  await head;
  assert.deepEqual(r1.map((s) => s.luminosity), [A, B]);
  assert.deepEqual(r2.map((s) => s.luminosity), [B, C]);
  assert.deepEqual(r3.map((s) => s.luminosity), [A, A]);
  const all = [...r1, ...r2, ...r3];
  assert.equal(new Set(all).size, all.length, "no result object is shared");
  for (const key of ["pixels", "normalPixels", "heightPixels"]) {
    const bufs = all.map((s) => s[key].buffer);
    assert.equal(new Set(bufs).size, bufs.length, `no ${key} buffer is shared`);
  }
  assert.deepEqual([...r2[0].pixels], [...r1[1].pixels], "a copy carries the same bytes");
  // Mutating one caller's pixels never shows through another's.
  r1[0].pixels[0] = 0xee;
  assert.notEqual(r3[0].pixels[0], 0xee);
  assert.notEqual(r3[1].pixels[0], 0xee);
  assert.equal(c._stats.queue.coalescedDupDids, 3, "B, A, A dropped from the posted list");
  for (const s of all) assert.equal(typeof s.free, "undefined", "plain objects, nothing to free");
});

await t("S4 worker error on a merged post -> every caller falls back on the main thread", async () => {
  const { c, w } = await readyClient({ cap: 1 });
  const wasm = makeWasm();
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    const head = c.fetchSurfacesPixels(wasm, new Uint32Array([0x08000001]));
    await flush();
    const pa = c.fetchSurfacesPixels(wasm, new Uint32Array([0x08000002, 0x08000003]));
    const pb = c.fetchSurfacesPixels(wasm, new Uint32Array([0x08000004]));
    await flush();
    answer(w, fetches(w)[0]);
    const merged = fetches(w)[1];
    w.reply({ type: "error", id: merged.id, message: "decode exploded" });
    const [ra, rb] = await Promise.all([pa, pb]);
    await head;
    assert.deepEqual(wasm.calls.map((x) => x.ids), [[0x08000002, 0x08000003], [0x08000004]],
      "each caller re-decodes exactly its OWN DIDs on the main thread");
    assert.deepEqual(ra.map((s) => [s.luminosity, s.diffuse]), [[0x08000002, MAIN], [0x08000003, MAIN]]);
    assert.deepEqual(rb.map((s) => [s.luminosity, s.diffuse]), [[0x08000004, MAIN]]);
    const f = c._stats.fallbacks;
    assert.equal(f.byType.fetchSurfacesPixels, 2, "one fallback counted per caller");
    assert.match(f.lastError, /decode exploded/);
    assert.equal(c._stats.byType.fetchSurfacesPixels.failed, 2, "byType.failed per request");
    assert.equal(warned.filter((s) => s.includes("main-thread fallback")).length, 2);
  } finally {
    console.warn = warn;
  }
});

await t("S5 malformed merged reply (length mismatch) -> every caller falls back", async () => {
  const { c, w } = await readyClient({ cap: 1 });
  const wasm = makeWasm();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const head = c.fetchSurfacesPixels(wasm, new Uint32Array([1]));
    await flush();
    const pa = c.fetchSurfacesPixels(wasm, new Uint32Array([2]));
    const pb = c.fetchSurfacesPixels(wasm, new Uint32Array([3]));
    await flush();
    answer(w, fetches(w)[0]);
    const merged = fetches(w)[1];
    w.reply({ type: "result", id: merged.id, kind: "surfaces", payload: [payload(2)] });
    const [ra, rb] = await Promise.all([pa, pb]);
    await head;
    assert.equal(ra[0].diffuse, MAIN);
    assert.equal(rb[0].diffuse, MAIN);
    assert.equal(c._stats.fallbacks.byType.fetchSurfacesPixels, 2);
    assert.match(c._stats.fallbacks.lastError, /1 entries for 2 DIDs/);
  } finally {
    console.warn = warn;
  }
});

await t("S6 a throwing post of a merged message rejects every member and keeps pumping", async () => {
  const { c, w } = await readyClient({ cap: 1 });
  const out = [];
  const head = c._request("fetchSurfacesPixels", { dids: [1], urgent: false });
  const a = c._request("fetchSurfacesPixels", { dids: [2], urgent: false }).catch((e) => out.push("a:" + e.message));
  const b = c._request("fetchSurfacesPixels", { dids: [3], urgent: false }).catch((e) => out.push("b:" + e.message));
  const mesh = c._request("fetchModelMeshes", { ids: [9], urgent: false });
  w.throwOnPost = (m) => m.type === "fetchSurfacesPixels" && m.dids.length === 2;
  w.reply({ type: "result", id: fetches(w)[0].id, kind: "surfaces", payload: [payload(1)] });
  await head;
  await Promise.all([a, b]);
  assert.deepEqual(out.sort(), ["a:DataCloneError (test)", "b:DataCloneError (test)"]);
  assert.equal(c._coalesced.size, 0, "the failed group is forgotten");
  const last = fetches(w).at(-1);
  assert.equal(last.type, "fetchModelMeshes", "the pump moved on to the next lane entry");
  w.reply({ type: "result", id: last.id, kind: "modelMeshes", payload: [] });
  await mesh;
  assert.equal(c._inFlightPosted, 0);
  assert.equal(c._pending.size, 0);
});

await t("S7 lanes, urgency and other types are never merged across; FIFO preserved", async () => {
  const { c, w } = await readyClient({ cap: 1 });
  const swallow = (p) => p.catch(() => {});
  swallow(c._request("fetchEntitySurfacesPixels", { dids: [100], paletteId: 0, subPalettes: [], urgent: false }));
  swallow(c._request("fetchSurfacesPixels", { dids: [1], urgent: false })); // lane 1
  swallow(c._request("fetchModelMeshes", { ids: [50], urgent: false })); // lane 1
  swallow(c._request("fetchSurfacesPixels", { dids: [2], urgent: false })); // lane 1
  swallow(c._request("fetchSurfacesPixels", { dids: [3], urgent: true })); // lane 0
  swallow(c._request("fetchSurfacesPixels", { dids: [4], urgent: true })); // lane 0
  swallow(c._request("fetchEntitySurfacesPixels", { dids: [101], paletteId: 0, subPalettes: [], urgent: false }));
  const step = () => {
    const m = fetches(w).at(-1);
    w.reply({ type: "result", id: m.id, kind: "x", payload: (m.dids || m.ids || []).map(payload) });
  };
  for (let i = 0; i < 8 && c._inFlightPosted > 0; i += 1) step();
  const shape = fetches(w).map((m) => `${m.type}${m.urgent ? "!" : ""}:${(m.dids || m.ids).join("+")}`);
  assert.deepEqual(shape, [
    "fetchEntitySurfacesPixels:100",
    "fetchSurfacesPixels!:3+4", // urgent lane first, the two urgent requests merged
    "fetchSurfacesPixels:1+2", // normal surfaces merged past the mesh request…
    "fetchModelMeshes:50", // …which keeps its place ahead of everything after it
    "fetchEntitySurfacesPixels:101", // entity singles never merge
  ]);
});

await t("S8 DID cap: stop at the first request that does not fit; bakeBatchMax lowers the cap", async () => {
  {
    const { c, w } = await readyClient({ cap: 1, coalesce: 4 });
    const swallow = (p) => p.catch(() => {});
    swallow(c._request("fetchSurfacesPixels", { dids: [9], urgent: false }));
    swallow(c._request("fetchSurfacesPixels", { dids: [1, 2], urgent: false }));
    swallow(c._request("fetchSurfacesPixels", { dids: [3, 2], urgent: false })); // 1 new DID -> 3
    swallow(c._request("fetchSurfacesPixels", { dids: [4, 5], urgent: false })); // would be 5 > 4
    swallow(c._request("fetchSurfacesPixels", { dids: [6], urgent: false })); // fits, but FIFO never skips
    const step = () => {
      const m = fetches(w).at(-1);
      w.reply({ type: "result", id: m.id, kind: "surfaces", payload: m.dids.map(payload) });
    };
    for (let i = 0; i < 6 && c._inFlightPosted > 0; i += 1) step();
    assert.deepEqual(fetches(w).map((m) => m.dids.join("+")), ["9", "1+2+3", "4+5+6"]);
    assert.equal(c._surfaceCoalesceCap(), 4);
  }
  {
    const { c } = await readyClient({ cap: 1, batchMax: 3 });
    assert.equal(c._surfaceCoalesceCap(), 3, "bakeBatchMax=3 bounds the merged submission too");
  }
  {
    // A head already at the cap posts alone, untouched.
    const { c, w } = await readyClient({ cap: 1, coalesce: 2 });
    const swallow = (p) => p.catch(() => {});
    swallow(c._request("fetchSurfacesPixels", { dids: [9], urgent: false }));
    swallow(c._request("fetchSurfacesPixels", { dids: [1, 2], urgent: false }));
    swallow(c._request("fetchSurfacesPixels", { dids: [3], urgent: false }));
    const m0 = fetches(w)[0];
    w.reply({ type: "result", id: m0.id, kind: "surfaces", payload: [payload(9)] });
    assert.deepEqual(fetches(w)[1].dids, [1, 2]);
  }
});

await t("S9 zero added latency: a lone request posts synchronously with its original body; no timers", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  let timers = 0;
  globalThis.setTimeout = (...a) => { timers += 1; return realSetTimeout(...a); };
  globalThis.setInterval = (...a) => { timers += 1; return realSetInterval(...a); };
  try {
    const { c, w } = await readyClient({ cap: 4 });
    const p = c._request("fetchSurfacesPixels", { dids: [5], urgent: false });
    assert.equal(fetches(w).length, 1, "posted inside the same call — nothing waits");
    const m = fetches(w)[0];
    assert.deepEqual(Object.keys(m).sort(), ["dids", "id", "type", "urgent"]);
    assert.deepEqual(m.dids, [5]);
    assert.equal(c._coalesced.size, 0, "a lone post is not a group");
    w.reply({ type: "result", id: m.id, kind: "surfaces", payload: [payload(5)] });
    const res = await p;
    assert.equal(res.coalesced, undefined, "the worker's reply object is handed through as before");
    // Four slots free: four requests go out singly at once, nothing merges.
    const ps = [6, 7, 8, 9].map((d) => c._request("fetchSurfacesPixels", { dids: [d], urgent: false }));
    assert.deepEqual(fetches(w).slice(1).map((x) => x.dids.join()), ["6", "7", "8", "9"]);
    for (const x of fetches(w).slice(1)) w.reply({ type: "result", id: x.id, kind: "surfaces", payload: x.dids.map(payload) });
    await Promise.all(ps);
    // A merged round trip arms no timer either: four go out singly, the two
    // that queue merge when the first slot frees.
    const head = c._request("fetchSurfacesPixels", { dids: [1], urgent: false });
    const more = [2, 3, 4, 10, 11].map((d) => c._request("fetchSurfacesPixels", { dids: [d], urgent: false }));
    const inFlight = fetches(w).slice(-4);
    assert.deepEqual(inFlight.map((x) => x.dids.join()), ["1", "2", "3", "4"]);
    w.reply({ type: "result", id: inFlight[0].id, kind: "surfaces", payload: [payload(1)] });
    const merged = fetches(w).at(-1);
    assert.deepEqual(merged.dids, [10, 11]);
    for (const x of [...inFlight.slice(1), merged]) {
      w.reply({ type: "result", id: x.id, kind: "surfaces", payload: x.dids.map(payload) });
    }
    await Promise.all([head, ...more]);
    assert.equal(timers, 0, "the client armed no timer");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
  }
});

await t("S10 =off and a bare unconfigured client: one message per request (today's queue)", async () => {
  for (const make of [
    async () => readyClient({ cap: 1, coalesce: false }),
    async () => {
      // `new BakeWorkerClient()` without configure() — what the older suites build.
      const c = new BakeWorkerClient();
      c._queueEnabled = true;
      c._queueCap = 1;
      c._worker = new ManualWorker();
      c._worker.onmessage = (ev) => c._onMessage(ev.data);
      return { c, w: c._worker };
    },
  ]) {
    const { c, w } = await make();
    assert.equal(c._surfaceCoalesceCap(), 0);
    const swallow = (p) => p.catch(() => {});
    for (const d of [1, 2, 3, 4]) swallow(c._request("fetchSurfacesPixels", { dids: [d], urgent: false }));
    for (let i = 0; i < 5 && c._inFlightPosted > 0; i += 1) {
      const m = fetches(w).at(-1);
      w.reply({ type: "result", id: m.id, kind: "surfaces", payload: m.dids.map(payload) });
    }
    assert.deepEqual(fetches(w).map((m) => m.dids.join("+")), ["1", "2", "3", "4"]);
    assert.equal(c._stats.queue.coalesced, 0);
  }
});

await t("S11 _failAll / terminate with a merged post in flight: all reject, a late reply is a no-op", async () => {
  const { c, w } = await readyClient({ cap: 1 });
  const out = [];
  const head = c._request("fetchSurfacesPixels", { dids: [1], urgent: false }).catch((e) => out.push("h:" + e.message));
  const a = c._request("fetchSurfacesPixels", { dids: [2], urgent: false }).catch((e) => out.push("a:" + e.message));
  const b = c._request("fetchSurfacesPixels", { dids: [3], urgent: false }).catch((e) => out.push("b:" + e.message));
  w.reply({ type: "result", id: fetches(w)[0].id, kind: "surfaces", payload: [payload(1)] });
  await head;
  const merged = fetches(w)[1];
  assert.equal(c._coalesced.size, 1);
  c.terminate();
  await Promise.all([a, b]);
  assert.deepEqual(out.sort(), ["a:bake worker terminated", "b:bake worker terminated"]);
  assert.equal(c._coalesced.size, 0);
  assert.equal(w.terminated, true);
  // The dead worker's reply arrives after all: nothing to settle, nothing throws.
  w.reply({ type: "result", id: merged.id, kind: "surfaces", payload: merged.dids.map(payload) });
  assert.equal(c._pending.size, 0);
});

await t("S12 alias split: the worker leg merges and the stitch still lines up", async () => {
  const { c, w } = await readyClient({ cap: 1 });
  c.aliasSplit = true;
  const wasm = makeWasm();
  const info = console.info;
  console.info = () => {};
  try {
    const ALIAS = 0x08f00003;
    const head = c.fetchSurfacesPixels(wasm, new Uint32Array([0x08000001]));
    await flush();
    const pMixed = c.fetchSurfacesPixels(wasm, new Uint32Array([0x08000002, ALIAS, 0x08000003]));
    const pPlain = c.fetchSurfacesPixels(wasm, new Uint32Array([0x08000004]));
    await flush();
    answer(w, fetches(w)[0], { decodeMisses: 0, provenAbsent: [] });
    const merged = fetches(w)[1];
    assert.deepEqual(merged.dids, [0x08000002, 0x08000003, 0x08000004], "alias DIDs never reach the worker");
    answer(w, merged, { decodeMisses: 1, provenAbsent: [hex(0x08000004)] });
    const [mixed, plain] = await Promise.all([pMixed, pPlain]);
    await head;
    assert.deepEqual(mixed.map((s) => [s.luminosity, s.diffuse]), [
      [0x08000002, WORKER], [ALIAS, MAIN], [0x08000003, WORKER],
    ]);
    assert.deepEqual(mixed.provenAbsent, [], "the stitched result unions its OWN legs only");
    assert.equal(mixed.decodeMisses, 1);
    assert.deepEqual(plain.provenAbsent, [hex(0x08000004)]);
  } finally {
    console.info = info;
  }
});

await t("S13 diag: __diag.bakeWorkerStats() exposes queue.coalesce and byType.coalesced", async () => {
  const s = getBakeWorkerClient();
  assert.equal(typeof globalThis.window.__diag?.bakeWorkerStats, "function");
  s._stats = {
    byType: { fetchSurfacesPixels: { count: 6, failed: 0, totalMs: 60, maxMs: 20, totalDepth: 6, maxDepth: 3, coalesced: 5 } },
    maxPending: 3,
    queue: {
      posted: 2, maxQueuedLen: 5, byLane: [0, 1, 2].map(() => ({ count: 0, totalQueueMs: 0, maxQueueMs: 0 })),
      coalesced: 4, coalescedPosts: 1, coalescedDupDids: 0, coalescedMaxDids: 5,
    },
  };
  const st = globalThis.window.__diag.bakeWorkerStats();
  assert.deepEqual(st.queue.coalesce, { maxDids: s._surfaceCoalesceCap(), coalesced: 4, posts: 1, dupDids: 0, maxMergedDids: 5 });
  assert.equal(st.byType.fetchSurfacesPixels.coalesced, 5);
  assert.equal(s._surfaceCoalesceCap(), 64, "the configured singleton is ON by default (no location in node)");
  s._stats = undefined;
});

await t("S14 flag grammar + docs row", async () => {
  assert.equal(parseBakeSurfaceCoalesce(null), 64, "absent -> on, default cap");
  assert.equal(parseBakeSurfaceCoalesce(undefined), 64);
  for (const off of ["off", "0", "false", "no", "OFF", " No "]) {
    assert.equal(parseBakeSurfaceCoalesce(off), 0, `"${off}" -> off`);
  }
  for (const on of ["on", "1", "true", "yes", "", "garbage", "-5", "1.5"]) {
    assert.equal(parseBakeSurfaceCoalesce(on), 64, `"${on}" -> on, default cap`);
  }
  assert.equal(parseBakeSurfaceCoalesce("128"), 128, "integer >= 2 -> that DID cap");
  assert.equal(parseBakeSurfaceCoalesce("16.9"), 16);
  assert.equal(parseBakeSurfaceCoalesce(2), 2);
  assert.equal(resolveBakeSurfaceCoalesce("?bakeSurfaceCoalesce=off"), 0);
  assert.equal(resolveBakeSurfaceCoalesce("?bakeSurfaceCoalesce=0"), 0);
  assert.equal(resolveBakeSurfaceCoalesce("?x=1"), 64);
  assert.equal(resolveBakeSurfaceCoalesce(""), 64);
  assert.equal(new BakeWorkerClient().configure({ surfaceCoalesce: 32 }).surfaceCoalesceMax, 32);
  assert.equal(new BakeWorkerClient().configure({ surfaceCoalesce: false }).surfaceCoalesceMax, 0);
  assert.equal(new BakeWorkerClient().configure({}).surfaceCoalesceMax, 64);
  assert.equal(new BakeWorkerClient().surfaceCoalesceMax, 0, "unconfigured client: off");
  const docsPath = process.env.HB_URL_FLAGS_MD || path.join(APP, "docs", "url-flags.md");
  const docs = readFileSync(docsPath, "utf8");
  const row = docs.split("\n").find((l) => l.startsWith("| `bakeSurfaceCoalesce` |"));
  assert.ok(row, "url-flags.md row `| \\`bakeSurfaceCoalesce\\` |` missing");
  assert.match(row, /`off`\/`0`\/`false`\/`no`/);
  assert.match(row, /bake_worker_client\.js/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
