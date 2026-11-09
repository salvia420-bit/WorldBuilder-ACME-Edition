// tests/m4_stress_bake_worker.test.mjs — Milestone 4 Challenger Adversarial Stress Test
// Component: BakeWorkerClient (scene3d/bake_worker_client.js)
//
// OBJECTIVES:
//   1. Verify that capping coalesced DIDs at 20 does not break high-volume multi-caller requests.
//   2. Verify that no orphaned promises are left behind under high volume, errors, or oversized batches.
//   3. Verify payload buffer isolation (deep clone for shared DIDs across callers).
//   4. Verify fallback/error settlement for every member when worker fails or replies are malformed.
//
// Run: node --max-old-space-size=256 tests/m4_stress_bake_worker.test.mjs

import assert from "node:assert/strict";

class ManualWorker {
  constructor() {
    ManualWorker.instances.push(this);
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
    this.throwOnPost = null;
  }
  postMessage(msg) {
    if (this.throwOnPost && this.throwOnPost(msg)) {
      throw new Error("Worker postMessage synthetic throw");
    }
    this.posted.push(msg);
  }
  reply(data) {
    if (this.onmessage) this.onmessage({ data });
  }
  terminate() {
    this.terminated = true;
  }
}
ManualWorker.instances = [];
globalThis.Worker = ManualWorker;
globalThis.window = { location: { search: "?bakeSurfaceCoalesce=64&bakeQueueCap=8" } };

const { BakeWorkerClient } = await import("../scene3d/bake_worker_client.js");

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failed += 1;
    console.error(`  [FAIL] ${name} ${detail}`);
  }
}

const flush = () => new Promise((r) => setImmediate(r));

function makeWasm() {
  const calls = [];
  return {
    calls,
    async fetch_surfaces_pixels(ids, urgent) {
      calls.push({ ids: [...ids], urgent });
      return [...ids].map((d) => makeMockPayload(d));
    },
  };
}

async function makeClient({ coalesce = 64, cap = 8, batchMax } = {}) {
  const c = new BakeWorkerClient().configure({
    enabled: true,
    surfaceCoalesce: coalesce,
    ...(batchMax !== undefined ? { batchMax } : {}),
  });
  c._queueEnabled = true;
  c._queueCap = cap;
  const ready = c._ensureWorker();
  const w = ManualWorker.instances[ManualWorker.instances.length - 1];
  assert.equal(w.posted[0].type, "init");
  w.reply({ type: "ready", id: w.posted[0].id });
  await ready;
  w.posted.length = 0;
  return { c, w };
}

function makeMockPayload(did) {
  return {
    width: 2,
    height: 2,
    pixels: new Uint8Array([did & 0xff, (did >> 8) & 0xff, 0, 255]),
    surfaceType: 1,
    category: 0,
    normalPixels: new Uint8Array([128, 128, 255, 255]),
    heightPixels: new Uint8Array([0, 0, 0, 0]),
    luminosity: did >>> 0,
  };
}

console.log("=== M4 STRESS TEST 2: BakeWorkerClient Coalescing & Promise Integrity ===");

// ── Test 2.1: High-Volume Multi-Caller Storm (500 requests, varied DID sizes) ───
{
  const { c: client, w: worker } = await makeClient({ coalesce: 64, cap: 8 });
  const wasm = makeWasm();

  const totalRequests = 500;
  const promises = [];
  const callerDids = [];
  const results = [];

  // Generate 500 requests with varying DID sizes:
  // 1-DID (single), 5-DID, 15-DID, 20-DID, 30-DID (oversized), with duplicate DIDs
  for (let i = 0; i < totalRequests; i++) {
    const size = (i % 5 === 0) ? 1 : (i % 5 === 1) ? 5 : (i % 5 === 2) ? 15 : (i % 5 === 3) ? 20 : 30;
    const dids = [];
    for (let d = 0; d < size; d++) {
      // Intentionally share DIDs among some callers (modulo 50)
      dids.push(1000 + ((i * 3 + d) % 50));
    }
    callerDids.push(dids);
    const p = client.fetchSurfacesPixels(wasm, new Uint32Array(dids))
      .then((res) => { results[i] = { ok: true, res }; })
      .catch((err) => { results[i] = { ok: false, err }; });
    promises.push(p);
  }
  await flush();

  // Drain pipeline until all 500 settled
  let repliesCount = 0;
  while (results.filter(Boolean).length < totalRequests && worker.posted.length > 0) {
    const msg = worker.posted.shift();
    repliesCount++;

    if (msg.type === "fetchSurfacesPixels") {
      // Check effective coalesce cap invariant:
      // If coalesced from multiple callers, DID list must be <= 20
      const coalescedEntry = client._coalesced.get(msg.id);
      if (coalescedEntry && coalescedEntry.members.length > 1) {
        assert(msg.dids.length <= 20,
          `Coalesced message exceeded 20 DIDs! Got ${msg.dids.length}`);
      }

      // Generate worker reply
      const payload = msg.dids.map((d) => makeMockPayload(d));
      worker.reply({
        type: "result",
        id: msg.id,
        kind: "surfaces",
        payload,
        audit: { decodeCount: msg.dids.length, decodeMisses: 0 },
      });
      await flush();
    }
  }

  await Promise.all(promises);

  check("All 500 multi-caller requests settled without hanging",
    results.length === totalRequests && results.every((r) => r && r.ok));

  // Verify that every caller got back their exact requested DIDs in order
  let payloadsValid = true;
  for (let i = 0; i < totalRequests; i++) {
    const expected = callerDids[i];
    const actualPayload = results[i].res;
    if (!actualPayload || actualPayload.length !== expected.length) {
      payloadsValid = false;
      break;
    }
    for (let j = 0; j < expected.length; j++) {
      if (actualPayload[j].luminosity !== expected[j]) {
        payloadsValid = false;
        break;
      }
    }
  }
  check("Every caller received exact matching DID payloads in order", payloadsValid);

  // Verify buffer isolation: callers with shared DIDs must have unique pixel buffer copies
  let buffersIsolated = true;
  const didSeenMap = new Map();
  for (let i = 0; i < totalRequests; i++) {
    const payload = results[i].res;
    for (const item of payload) {
      const did = item.luminosity;
      if (didSeenMap.has(did)) {
        const prevBuf = didSeenMap.get(did);
        if (prevBuf === item.pixels) {
          buffersIsolated = false;
          break;
        }
      } else {
        didSeenMap.set(did, item.pixels);
      }
    }
    if (!buffersIsolated) break;
  }
  check("Shared DIDs across callers are deep-copied (buffer isolation holds)", buffersIsolated);

  check("Zero pending or coalesced references retained in client state",
    client._pending.size === 0 && client._coalesced.size === 0,
    `pending=${client._pending.size}, coalesced=${client._coalesced.size}`);

  client.terminate();
}

// ── Test 2.2: Oversized Requests (Single Caller with >20 DIDs) ─────────────────
{
  const { c: client, w: worker } = await makeClient({ coalesce: 64, cap: 8 });
  const wasm = makeWasm();

  // Request 35 unique DIDs (exceeds effective cap 20 alone)
  const dids35 = Array.from({ length: 35 }, (_, i) => 2000 + i);
  // Queued rider request with 2 DIDs
  const dids2 = [3001, 3002];

  let res35 = null;
  let res2 = null;

  client.fetchSurfacesPixels(wasm, new Uint32Array(dids35)).then((r) => { res35 = r; });
  client.fetchSurfacesPixels(wasm, new Uint32Array(dids2)).then((r) => { res2 = r; });
  await flush();

  // Because dids35 has size 35 >= 20, _takeCoalescible must NOT merge dids2 into it!
  assert(worker.posted.length >= 1, "Head request must post");
  const firstMsg = worker.posted.shift();

  check("Oversized request (35 DIDs) posts alone without merging riders",
    firstMsg.dids.length === 35 && client._coalesced.get(firstMsg.id) === undefined);

  // Reply to first
  worker.reply({
    type: "result",
    id: firstMsg.id,
    kind: "surfaces",
    payload: firstMsg.dids.map(makeMockPayload),
    audit: {},
  });
  await flush();

  // Rider must now post in its own message
  assert(worker.posted.length === 1, "Rider request posts after head settles");
  const secondMsg = worker.posted.shift();
  check("Rider request posts with its own 2 DIDs", secondMsg.dids.length === 2);

  worker.reply({
    type: "result",
    id: secondMsg.id,
    kind: "surfaces",
    payload: secondMsg.dids.map(makeMockPayload),
    audit: {},
  });
  await flush();

  check("Both oversized and rider requests resolved successfully",
    res35?.length === 35 && res2?.length === 2);

  client.terminate();
}

// ── Test 2.3: Hostile Worker Failures & Orphaned Promise Audit ──────────────────
{
  const { c: client, w: worker } = await makeClient({ coalesce: 64, cap: 1 });
  const wasm = makeWasm();

  // 1. Worker error reply on merged message -> falls back to wasm on main thread
  let res1 = null;
  let res2 = null;

  // Post head to occupy the single in-flight slot
  const head = client.fetchSurfacesPixels(wasm, new Uint32Array([1]));
  await flush();
  assert.equal(worker.posted.length, 1, "Head occupied slot");
  const headMsg = worker.posted.shift();

  // Now enqueue p1 and p2 while slot is busy -> both queue in lane 1
  const p1 = client.fetchSurfacesPixels(wasm, new Uint32Array([4001, 4002])).then((r) => { res1 = r; });
  const p2 = client.fetchSurfacesPixels(wasm, new Uint32Array([4003, 4004])).then((r) => { res2 = r; });
  await flush();

  // Settle head: frees slot, pumping queued p1 and p2 as ONE merged message
  worker.reply({
    type: "result",
    id: headMsg.id,
    kind: "surfaces",
    payload: [makeMockPayload(1)],
    audit: {},
  });
  await flush();
  await head;

  assert.equal(worker.posted.length, 1, "Merged post dispatched");
  const msg1 = worker.posted.shift();
  assert.deepEqual(msg1.dids, [4001, 4002, 4003, 4004], "Merged message contains all 4 DIDs");

  // Worker replies with error to the merged message
  worker.reply({
    type: "error",
    id: msg1.id,
    message: "Synthetic GPU driver crash",
  });
  await flush();
  await Promise.all([p1, p2]);

  check("Worker error triggers wasm fallback for all coalesced members (zero orphaned promises)",
    res1 !== null && res2 !== null && client._pending.size === 0 && client._coalesced.size === 0);

  // 2. Malformed payload reply (length mismatch) -> falls back to wasm
  let res3 = null;
  let res4 = null;

  const head2 = client.fetchSurfacesPixels(wasm, new Uint32Array([2]));
  await flush();
  const headMsg2 = worker.posted.shift();

  const p3 = client.fetchSurfacesPixels(wasm, new Uint32Array([5001])).then((r) => { res3 = r; });
  const p4 = client.fetchSurfacesPixels(wasm, new Uint32Array([5002])).then((r) => { res4 = r; });
  await flush();

  worker.reply({
    type: "result",
    id: headMsg2.id,
    kind: "surfaces",
    payload: [makeMockPayload(2)],
    audit: {},
  });
  await flush();
  await head2;

  const msg2 = worker.posted.shift();
  assert.deepEqual(msg2.dids, [5001, 5002]);

  // Reply with only 1 item when 2 were expected
  worker.reply({
    type: "result",
    id: msg2.id,
    kind: "surfaces",
    payload: [makeMockPayload(5001)], // missing 5002!
  });
  await flush();
  await Promise.all([p3, p4]);

  check("Malformed reply (length mismatch) safely triggers fallback for all coalesced callers",
    res3 !== null && res4 !== null && client._pending.size === 0);

  // 3. Worker throw on dispatch
  worker.throwOnPost = (m) => m.dids?.includes(6666);
  let resThrow = null;
  const pThrow = client.fetchSurfacesPixels(wasm, new Uint32Array([6666])).then((r) => { resThrow = r; });

  await flush();
  await pThrow;
  check("Dispatch throw falls back cleanly and preserves pump sanity",
    resThrow !== null && client._pending.size === 0);

  client.terminate();
}

console.log(`\nBakeWorkerClient Stress Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
