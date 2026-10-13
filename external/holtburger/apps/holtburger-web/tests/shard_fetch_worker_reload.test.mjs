// tests/shard_fetch_worker_reload.test.mjs — the shard fetch worker's RELOAD
// RETRY (WebAC comparison streaming-residency-4, 2026-10-13).
//
// A shard body that fails its sha check fails its key (wasm Step E). Before
// this, the retry of that key fetched the same URL with only a priority hint,
// so the service worker's Cache Storage (or, under ?nosw=1, the immutable HTTP
// cache) handed back the very same bad bytes on every retry. Now the worker
// remembers the URL and the NEXT request for it carries `cache: "reload"`.
//
//   R1  a retry request (same URL after a mismatch) carries cache:"reload", the priority kept
//   R2  once per failure: a verified reload clears it; a mismatching reload sets it again
//   R3  the urgent 'auto' lane (no init normally) gets {cache:"reload"} alone; stats.prio unchanged
//   R4  only mismatches mark: a verified body, an unverifiable one (no sha), an HTTP error do not
//   R5  bounded: RELOAD_URLS_MAX remembered at most; the snapshot reports reloads / reloadPending
//
// Run: node tests/shard_fetch_worker_reload.test.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createShardFetchHandler, sha256Hex, RELOAD_URLS_MAX, FLUSH_DELAY_MS } from "../scene3d/shard_fetch_worker.js";

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [OK] ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  [FAIL] ${name}\n        ${String((e && e.stack) || e).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

const enc = (s) => new TextEncoder().encode(s);
const sha32 = (s) => crypto.createHash("sha256").update(enc(s)).digest("hex").slice(0, 32);
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 6) {
  for (let i = 0; i < n; i++) await tick();
}

function resp(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "ERR",
    arrayBuffer: async () => {
      const u = enc(text);
      return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
    },
  };
}

/** The real handler with a scripted origin: `served(url)` -> [text, status?]. */
function rig(served) {
  const calls = [];
  const posts = [];
  let timers = [];
  const h = createShardFetchHandler({
    fetchImpl: async (url, init) => {
      calls.push({ url, init, nargs: init === undefined ? 1 : 2 });
      const [text, status] = served(url, init);
      return resp(text, status);
    },
    post: (m) => posts.push(m),
    now: () => 0,
    timeOrigin: 0,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
    digest: { engine: "js", digestHex: async (b) => sha256Hex(new Uint8Array(b)) },
    heartbeatMs: 0,
    lagProbeMs: 0,
    delayMs: FLUSH_DELAY_MS,
  });
  let nextId = 1;
  const send = async (reqs) => {
    h.onMessage({ type: "batch", reqs: reqs.map((r) => ({ id: nextId++, ...r })) });
    await settle();
    const fns = timers;
    timers = [];
    for (const fn of fns) fn();
  };
  const results = () => posts.filter((m) => m.type === "results").flatMap((m) => m.res);
  return { h, calls, send, results };
}

const URL_A = "http://x/shards/ab/a.bin";

await t("R1 a retry after a mismatch carries cache:'reload' (priority kept); the first fetch does not", async () => {
  const good = "REAL-RECORD";
  let body = "CORRUPT-CACHED-COPY";
  const r = rig(() => [body]);
  await r.send([{ url: URL_A, prio: "low", sha: sha32(good) }]);
  assert.deepEqual(r.calls[0].init, { priority: "low" }, "first request: today's init exactly");
  assert.equal(r.results()[0].mismatch, true);
  body = good; // the network has the right bytes; only a cache bypass reaches them
  await r.send([{ url: URL_A, prio: "low", sha: sha32(good) }]);
  assert.deepEqual(r.calls[1].init, { priority: "low", cache: "reload" }, "the retry bypasses the caches");
  assert.equal(r.results()[1].verified, true, "healed");
  assert.equal(r.h.stats.reloads, 1);
});

await t("R2 once per failure: a verified reload clears it; a mismatching reload sets it again", async () => {
  const good = "REAL";
  let body = "BAD";
  const r = rig(() => [body]);
  const req = { url: URL_A, prio: "high", sha: sha32(good) };
  await r.send([req]);
  await r.send([req]); // reload, still bad
  assert.deepEqual(r.calls[1].init, { priority: "high", cache: "reload" });
  assert.equal(r.results()[1].mismatch, true);
  await r.send([req]); // marked again by the failed reload
  assert.deepEqual(r.calls[2].init, { priority: "high", cache: "reload" }, "a fresh mismatch re-arms the reload");
  body = good;
  await r.send([req]);
  assert.deepEqual(r.calls[3].init, { priority: "high", cache: "reload" });
  assert.equal(r.results()[3].verified, true);
  await r.send([req]);
  assert.deepEqual(r.calls[4].init, { priority: "high" }, "after a verified body: plain requests again");
  assert.equal(r.h.stats.reloads, 3);
});

await t("R3 the urgent 'auto' lane gets {cache:'reload'} alone; stats.prio counts the lane, not the mode", async () => {
  const r = rig(() => ["BAD"]);
  const req = { url: URL_A, prio: "auto", sha: sha32("REAL") };
  await r.send([req]);
  assert.equal(r.calls[0].nargs, 1, "no init on the auto lane normally");
  await r.send([req]);
  assert.equal(r.calls[1].nargs, 2);
  assert.deepEqual(r.calls[1].init, { cache: "reload" });
  assert.deepEqual(r.h.stats.prio, { low: 0, high: 0, auto: 2 });
});

await t("R4 only a mismatch marks: verified, unverifiable (no sha / short sha), HTTP error, other URLs do not", async () => {
  const r = rig((url) => (url.endsWith("/e.bin") ? ["gone", 404] : ["BODY"]));
  const reqs = [
    { url: "http://x/shards/ab/v.bin", prio: "low", sha: sha32("BODY") },
    { url: "http://x/shards/ab/n.bin", prio: "low", sha: null },
    { url: "http://x/shards/ab/s.bin", prio: "low", sha: "abc" },
    { url: "http://x/shards/ab/e.bin", prio: "low", sha: sha32("BODY") },
    { url: "http://x/shards/ab/m.bin", prio: "low", sha: sha32("OTHER") },
  ];
  await r.send(reqs);
  await r.send(reqs);
  const second = r.calls.slice(reqs.length);
  const byUrl = Object.fromEntries(second.map((c) => [c.url.slice(-5), c.init]));
  assert.deepEqual(byUrl["v.bin"], { priority: "low" });
  assert.deepEqual(byUrl["n.bin"], { priority: "low" });
  assert.deepEqual(byUrl["s.bin"], { priority: "low" });
  assert.deepEqual(byUrl["e.bin"], { priority: "low" }, "an HTTP error is the retry ladder's business, not a cache bypass");
  assert.deepEqual(byUrl["m.bin"], { priority: "low", cache: "reload" }, "only the mismatched URL");
  assert.equal(r.h.stats.reloads, 1);
});

await t("R5 bounded at RELOAD_URLS_MAX; snapshot reports reloads + reloadPending", async () => {
  assert.equal(RELOAD_URLS_MAX, 4096);
  const r = rig(() => ["BAD"]);
  const n = RELOAD_URLS_MAX + 10;
  const reqs = Array.from({ length: n }, (_, i) => ({ url: `http://x/shards/cd/${i}.bin`, prio: "low", sha: sha32("REAL") }));
  await r.send(reqs);
  let snap = r.h.snapshot();
  assert.equal(snap.reloadPending, RELOAD_URLS_MAX, "no more than the cap remembered");
  assert.equal(snap.reloads, 0);
  assert.equal(r.h.stats.mismatch, n);
  await r.send(reqs.slice(0, 3));
  snap = r.h.snapshot();
  assert.equal(snap.reloads, 3);
  // The three reloads mismatched again and were re-marked.
  assert.equal(snap.reloadPending, RELOAD_URLS_MAX);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
