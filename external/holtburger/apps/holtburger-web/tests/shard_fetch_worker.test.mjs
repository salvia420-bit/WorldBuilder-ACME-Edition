// tests/shard_fetch_worker.test.mjs — `?shardFetchWorker` (Workstream B, 2026-10-09).
//
// The main wasm instance's shard bodies are fetched, read and sha256-verified in
// scene3d/shard_fetch_worker.js and handed back in batches of transferred
// ArrayBuffers; scene3d/shard_fetch_client.js coalesces the wasm's per-shard
// calls into one message per microtask and is registered on the MAIN instance
// via `register_shard_fetcher` (Rust: holtburger-resource-http http.rs
// `fetch_shard_bytes`, manifest_source.rs Step D/E).
//
//   W1  pure-JS sha256: FIPS vectors (empty, abc, 448/896-bit, 1M x 'a')
//   W2  pure-JS sha256 == node:crypto == pack_fetch_controller.js sha256Hex (block boundaries, random)
//   W3  digest engine: subtle in a secure context, JS otherwise (same hex)
//   W4  worker handler flushes at 64 entries, buffers in the transfer list
//   W5  worker handler flushes at 4 MB
//   W6  worker handler flushes 8 ms after the first entry (one timer, not one per entry)
//   W7  priority: "low" -> {priority:"low"}; "high" -> {priority:"high"}; "auto" -> fetch(url) with no init
//   W8  verify: match -> verified; mismatch -> ok + verified:false + mismatch; no/short sha -> no hash
//   W9  errors: 404 -> status 404; network throw -> status 0 + msg; body throw -> status 0
//   W10 heartbeat 'alive' while requests are in flight, none when idle
//   W11 failed results post: bodies answer status 0 (network), HTTP errors keep their status
//   W12 diag: event-loop lag probe only while requests are in flight; results carry `lag` and
//       per-entry `tResp`
//   W13 `?shardHashSlice` incremental sha256 (init/update/final): FIPS vectors, any chunking
//   W14 incremental == one-shot sha256Hex == node:crypto: 1 MB random, sizes crossing the
//       64 KB slice boundary (64 KB exactly, 64 KB+1, ...), random chunking, offset views
//   W15 handler: <= 64 KB one pass; > 64 KB one slice per event-loop turn; verification
//       byte-identical; slicedBodies / slices / maxSliceMs; results carry `hash`
//   W16 urgent first: small bodies hash between slices; an urgent big body's slices run
//       before the low body's remaining ones ('auto' is urgent too); fewest bytes left next
//   W17 off (dep / batch `hashSlice:false`) = the one-shot engine call; a batch's boolean
//       overrides, absent keeps the mode; the 'subtle' engine is never sliced
//   W18 worker-side `shardHashSliceEnabled` reader: absent/garbage on; off|0|false|no off
//   W19 makeTurnYielder: MessageChannel (FIFO, nested, channel closed once drained: a
//       process that only yields exits), setTimeout fallback; the default handler path; a
//       throwing yielder finishes the body in one pass
//   W20 worker bootstrap under a simulated WorkerGlobalScope (child process): the script-URL
//       reader, the batch's `hashSlice` wins both ways, `self.__shardFetchWorkerStats()`
//   C1  flag reader: absent/garbage on; off|0|false|no off
//   C2  N fetchShard calls in one turn -> ONE batch message (order, absolute URLs, prio, sha)
//   C3  results resolve the right promises (out of order); verified -> {verified,bytes}; else Uint8Array
//   C4  404 rejects {status:404} (Rust: HttpError::Http -> tolerate_404); network -> Error (Rust: Network)
//   C5  sha mismatch end-to-end -> resolves UNVERIFIED (Rust Step E re-hashes and fails the key)
//   C6  worker error / messageerror -> every pending rejects, unregister once, terminate, later calls reject
//   C7  =off (off/0/false/no) never constructs the worker and never registers
//   C8  stale pkg (no export) / no Worker -> null, never constructs
//   C9  install: registers a function that routes through the worker; diag on both arms
//   C10 register refused -> disposed, null
//   C11 __fetchMap: page-clock {c, h (worker netEnd via the timeOrigins), b}, "/shards/" key
//   C12 watchdog: silent worker -> fail + direct; heartbeats keep a slow fetch alive
//   C13 end to end with the real handler and real transfer (structuredClone): 150 calls, 1 batch
//   C14 two turns -> two batch messages
//   C15 deliverMs percentiles in __diag.shardFetch() / __shardFetchStats()
//   C16 `?shardFetchHigh` reader: absent/garbage on; off|0|false|no off
//   C17 urgent lane: wasm "auto" goes out as "high" (default) / "auto" (shardFetchHigh=off,
//       install + client option); the normal lane stays "low"; end to end the worker
//       fetches {priority:"high"} / no init / {priority:"low"}
//   C18 diag: the worker's lag reaches __diag.shardFetch().workerLag; tResp -> __fetchMap `r`
//   C19 `?shardHashSlice` page side (needs the client patch): the page reader matches the
//       worker's; install forwards `hashSlice` on the batch; =off -> the real handler hashes
//       one-shot; the worker's slice stats reach __diag.shardFetch().workerHash
//   K1  wiring contract (needs the wiring patch + docs row): build-shell WORKER_ENTRIES + literal
//       worker site, import-free worker, index.html install after init_resource_source and before
//       prefetch_world_bootstrap, modulepreload link, url-flags.md row, the Rust hook sites
//   K2  `?shardHashSlice` wiring (needs the client patch + docs row): page reader + batch
//       forward + install, worker bootstrap reader + batch override, url-flags.md row
//
// Run: node tests/shard_fetch_worker.test.mjs
//      (HB_HOLT_ROOT=<a patched copy of external/holtburger> points K1 at that copy;
//       HB_URL_FLAGS_MD=<file> overrides the docs file)

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  sha256Hex,
  sha256Init,
  sha256Update,
  sha256Final,
  makeTurnYielder,
  shardHashSliceEnabled,
  pickDigest,
  createShardFetchHandler,
  FLUSH_MAX_ENTRIES,
  FLUSH_MAX_BYTES,
  FLUSH_DELAY_MS,
  HASH_SLICE_BYTES,
} from "../scene3d/shard_fetch_worker.js";
// Namespace import: C19 / K2 probe for the `?shardHashSlice` client export
// without breaking the module link when the client patch is missing.
import * as ShardClientNs from "../scene3d/shard_fetch_client.js";
import {
  ShardFetchClient,
  shardFetchWorkerEnabled,
  shardFetchHighEnabled,
  installShardFetchWorker,
  shardFetchDiag,
  _resetShardFetchForTests,
} from "../scene3d/shard_fetch_client.js";
import { sha256Hex as packSha256Hex } from "../scene3d/pack_fetch_controller.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const HOLT = process.env.HB_HOLT_ROOT || path.join(APP, "..", "..");

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
const nodeSha = (u8) => crypto.createHash("sha256").update(u8).digest("hex");
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 6) {
  for (let i = 0; i < n; i++) await tick();
}

/** Manual timers (setTimer/clearTimer/advance). */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn, ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    delays: () => Array.from(timers.values()).map((x) => x.ms),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}

/** A Response-like body. */
function resp(bytes, { status = 200, statusText = "OK", bodyThrows = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    arrayBuffer: async () => {
      if (bodyThrows) throw new Error("stream reset");
      const u = bytes instanceof Uint8Array ? bytes : enc(String(bytes));
      return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
    },
  };
}

/** Fake Worker for client-only tests: records posts, delivers messages on demand. */
class FakeWorker {
  constructor() {
    this.posted = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
  }
  postMessage(msg) {
    this.posted.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  emit(data) {
    this.onmessage && this.onmessage({ data });
  }
}

/** In-process worker: the REAL handler on the other side, with structuredClone transfer. */
function inProcWorkerFactory(handlerDeps, { workerOrigin = 2000 } = {}) {
  const made = [];
  const factory = () => {
    const w = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      terminated: false,
      posts: 0,
      lastTransfer: null,
      postMessage(msg) {
        w.posts += 1;
        const copy = structuredClone(msg);
        setImmediate(() => w.handler.onMessage(copy));
      },
      terminate() {
        w.terminated = true;
      },
    };
    w.handler = createShardFetchHandler({
      timeOrigin: workerOrigin,
      ...handlerDeps,
      post: (m, transfer) => {
        w.lastTransfer = transfer;
        const copy = structuredClone(m, { transfer });
        setImmediate(() => !w.terminated && w.onmessage && w.onmessage({ data: copy }));
      },
    });
    setImmediate(() => w.onmessage && w.onmessage({ data: { type: "ready", to: workerOrigin, engine: w.handler.engine, secure: false } }));
    made.push(w);
    return w;
  };
  factory.made = made;
  return factory;
}

/** JS mirror of the Rust side (http.rs fetch_shard_bytes + manifest_source.rs Step E). */
async function rustView(p, shaSent) {
  try {
    const v = await p;
    if (v instanceof Uint8Array) return { kind: "body", verified: false, bytes: v };
    if (v instanceof ArrayBuffer) return { kind: "body", verified: false, bytes: new Uint8Array(v) };
    if (v && typeof v === "object" && (v.bytes instanceof Uint8Array || v.bytes instanceof ArrayBuffer)) {
      return { kind: "body", verified: !!shaSent && v.verified === true, bytes: new Uint8Array(v.bytes.buffer || v.bytes) };
    }
    return { kind: "Body-error" };
  } catch (e) {
    if (e && typeof e === "object" && Number.isInteger(e.status) && e.status >= 100 && e.status <= 999) {
      return { kind: "Http", status: e.status, statusText: e.statusText };
    }
    return { kind: "Network", msg: String((e && e.message) || e) };
  }
}

const quietLog = { warn() {}, log() {}, error() {} };

// ---------------------------------------------------------------------------
console.log("shard_fetch_worker — worker handler");
// ---------------------------------------------------------------------------

await t("W1 pure-JS sha256 matches the FIPS 180-2 vectors", async () => {
  assert.equal(sha256Hex(new Uint8Array(0)), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex(enc("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    sha256Hex(enc("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
  assert.equal(
    sha256Hex(enc("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu")),
    "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
  );
  assert.equal(sha256Hex(new Uint8Array(1000000).fill(0x61)), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

await t("W2 pure-JS sha256 == node:crypto == pack_fetch_controller.sha256Hex", async () => {
  const lens = [];
  for (let n = 0; n <= 130; n++) lens.push(n);
  lens.push(183, 184, 191, 192, 1000, 4095, 4096, 4097, 65537, 300001);
  let seed = 12345;
  for (const n of lens) {
    const u = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      u[i] = seed >>> 24;
    }
    const want = nodeSha(u);
    assert.equal(sha256Hex(u), want, `len ${n}`);
    if (n <= 4097) assert.equal(packSha256Hex(u), want, `pack_fetch_controller len ${n}`);
  }
});

await t("W3 digest engine: subtle in a secure context, JS otherwise; same hex", async () => {
  const u = enc("holtburger shard body");
  const buf = u.buffer.slice(0);
  const sec = pickDigest({ isSecureContext: true, crypto: globalThis.crypto });
  assert.equal(sec.engine, "subtle");
  assert.equal(await sec.digestHex(buf), nodeSha(u));
  const insec = pickDigest({ isSecureContext: false, crypto: globalThis.crypto });
  assert.equal(insec.engine, "js");
  assert.equal(await insec.digestHex(buf), nodeSha(u));
  assert.equal(pickDigest({ isSecureContext: true }).engine, "js", "no subtle -> js");
});

function handlerRig(over = {}) {
  const tm = fakeTimers();
  const posts = [];
  const calls = [];
  const bodies = over.bodies || ((url) => resp(enc(url)));
  const h = createShardFetchHandler({
    fetchImpl: async (url, init) => {
      calls.push({ url, init, nargs: init === undefined ? 1 : 2 });
      return bodies(url, init);
    },
    post: (m, transfer) => posts.push({ m, transfer }),
    now: tm.now,
    timeOrigin: 5000,
    setTimer: tm.setTimer,
    clearTimer: tm.clearTimer,
    digest: over.digest || { engine: "js", digestHex: async (b) => sha256Hex(new Uint8Array(b)) },
    heartbeatMs: over.heartbeatMs != null ? over.heartbeatMs : 0,
    lagProbeMs: over.lagProbeMs != null ? over.lagProbeMs : 0,
    ...(over.deps || {}),
  });
  return { h, tm, posts, calls };
}

await t("W4 handler flushes at 64 entries with every buffer in the transfer list", async () => {
  assert.equal(FLUSH_MAX_ENTRIES, 64);
  const { h, tm, posts } = handlerRig();
  const reqs = Array.from({ length: 70 }, (_, i) => ({ id: i + 1, url: `http://x/shards/aa/${i}.bin`, prio: "auto", sha: null }));
  h.onMessage({ type: "batch", reqs });
  await settle();
  assert.equal(posts.length, 1, "one flush at 64 entries before the timer");
  assert.equal(posts[0].m.type, "results");
  assert.equal(posts[0].m.res.length, 64);
  assert.equal(posts[0].m.to, 5000);
  assert.equal(posts[0].transfer.length, 64);
  assert.equal(new Set(posts[0].transfer).size, 64, "distinct buffers");
  for (const r of posts[0].m.res) assert.ok(posts[0].transfer.includes(r.buf));
  assert.equal(h.stats.flushBy.count, 1);
  tm.advance(FLUSH_DELAY_MS);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].m.res.length, 6);
  assert.equal(h.stats.flushBy.time, 1);
});

await t("W5 handler flushes at 4 MB", async () => {
  assert.equal(FLUSH_MAX_BYTES, 4 * 1024 * 1024);
  const big = new Uint8Array(3 * 1024 * 1024);
  const { h, posts } = handlerRig({ bodies: () => resp(big) });
  h.onMessage({ type: "batch", reqs: [1, 2].map((id) => ({ id, url: `http://x/shards/bb/${id}.bin`, prio: "low", sha: null })) });
  await settle();
  assert.equal(posts.length, 1, "the second 3 MB body crosses 4 MB -> immediate flush");
  assert.equal(posts[0].m.res.length, 2);
  assert.equal(posts[0].transfer.length, 2);
  assert.equal(h.stats.flushBy.bytes, 1);
});

await t("W6 handler flushes 8 ms after the first entry (one timer)", async () => {
  const { h, tm, posts } = handlerRig();
  h.onMessage({ type: "batch", reqs: [{ id: 1, url: "http://x/shards/cc/1.bin", prio: "auto", sha: null }] });
  await settle();
  assert.equal(posts.length, 0, "not before the timer");
  assert.deepEqual(tm.delays(), [FLUSH_DELAY_MS]);
  h.onMessage({ type: "batch", reqs: [{ id: 2, url: "http://x/shards/cc/2.bin", prio: "auto", sha: null }] });
  await settle();
  assert.equal(tm.pending(), 1, "second entry joins the armed timer");
  tm.advance(FLUSH_DELAY_MS - 1);
  assert.equal(posts.length, 0);
  tm.advance(1);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].m.res.map((r) => r.id), [1, 2]);
  assert.equal(new TextDecoder().decode(new Uint8Array(posts[0].m.res[0].buf)), "http://x/shards/cc/1.bin");
});

await t("W7 priority hint: low -> {priority:'low'}; high -> {priority:'high'}; auto -> fetch(url) with no init", async () => {
  const { h, calls } = handlerRig();
  h.onMessage({
    type: "batch",
    reqs: [
      { id: 1, url: "http://x/shards/dd/1.bin", prio: "low", sha: null },
      { id: 2, url: "http://x/shards/dd/2.bin", prio: "auto", sha: null },
      { id: 3, url: "http://x/shards/dd/3.bin", prio: "high", sha: null },
      { id: 4, url: "http://x/shards/dd/4.bin", prio: "bogus", sha: null },
    ],
  });
  await settle();
  assert.deepEqual(calls[0].init, { priority: "low" });
  assert.equal(calls[1].nargs, 1);
  assert.equal(calls[1].init, undefined);
  assert.deepEqual(calls[2].init, { priority: "high" }, "the urgent lane is explicit");
  assert.equal(calls[3].nargs, 1, "an unknown hint is treated as auto (no init)");
  assert.deepEqual(h.stats.prio, { low: 1, high: 1, auto: 2 });
});

await t("W8 verify: match -> verified; mismatch -> ok, unverified, mismatch; no/short sha -> no hashing", async () => {
  let hashed = 0;
  const digest = { engine: "js", digestHex: async (b) => { hashed += 1; return sha256Hex(new Uint8Array(b)); } };
  const body = enc("record-0x01000001");
  const good = nodeSha(body).slice(0, 32);
  const bad = "0".repeat(32);
  const { h, tm, posts } = handlerRig({ digest, bodies: () => resp(body) });
  h.onMessage({
    type: "batch",
    reqs: [
      { id: 1, url: "http://x/shards/ee/1.bin", prio: "auto", sha: good },
      { id: 2, url: "http://x/shards/ee/2.bin", prio: "auto", sha: bad },
      { id: 3, url: "http://x/shards/ee/3.bin", prio: "auto", sha: null },
      { id: 4, url: "http://x/shards/ee/4.bin", prio: "auto", sha: "abc" },
      { id: 5, url: "http://x/shards/ee/5.bin", prio: "auto", sha: good.toUpperCase() },
    ],
  });
  await settle();
  tm.advance(FLUSH_DELAY_MS);
  const by = Object.fromEntries(posts[0].m.res.map((r) => [r.id, r]));
  assert.equal(by[1].ok, true);
  assert.equal(by[1].verified, true);
  assert.equal(by[1].mismatch, false);
  assert.equal(by[2].ok, true, "a mismatch is NOT a worker error");
  assert.equal(by[2].verified, false);
  assert.equal(by[2].mismatch, true);
  assert.equal(by[3].verified, false);
  assert.equal(by[4].verified, false, "short sha is not checkable");
  assert.equal(by[5].verified, true, "case-insensitive");
  assert.equal(hashed, 3, "only the three checkable requests are hashed");
  assert.equal(h.stats.verified, 2);
  assert.equal(h.stats.mismatch, 1);
  assert.ok(typeof by[1].tNetEnd === "number" && typeof by[1].tReady === "number");
});

await t("W9 errors: 404 -> status 404; network throw -> status 0; body throw -> status 0", async () => {
  const { h, tm, posts } = handlerRig({
    bodies: (url) => {
      if (url.endsWith("/404.bin")) return resp(enc(""), { status: 404, statusText: "Not Found" });
      if (url.endsWith("/net.bin")) throw new TypeError("Failed to fetch");
      if (url.endsWith("/body.bin")) return resp(enc("x"), { bodyThrows: true });
      return resp(enc(url));
    },
  });
  h.onMessage({
    type: "batch",
    reqs: ["404", "net", "body"].map((n, i) => ({ id: i + 1, url: `http://x/shards/ff/${n}.bin`, prio: "auto", sha: null })),
  });
  await settle();
  tm.advance(FLUSH_DELAY_MS);
  const by = Object.fromEntries(posts[0].m.res.map((r) => [r.id, r]));
  assert.deepEqual([by[1].ok, by[1].status, by[1].statusText], [false, 404, "Not Found"]);
  assert.equal(by[1].buf, undefined);
  assert.deepEqual([by[2].ok, by[2].status], [false, 0]);
  assert.match(by[2].msg, /Failed to fetch/);
  assert.deepEqual([by[3].ok, by[3].status], [false, 0]);
  assert.match(by[3].msg, /body read: stream reset/);
  assert.equal(posts[0].transfer.length, 0);
});

await t("W10 heartbeat 'alive' while requests are in flight, none when idle", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { h, tm, posts } = handlerRig({ heartbeatMs: 2000, bodies: async () => { await gate; return resp(enc("slow")); } });
  h.onMessage({ type: "batch", reqs: [{ id: 1, url: "http://x/shards/gg/1.bin", prio: "low", sha: null }] });
  await settle();
  tm.advance(2000);
  tm.advance(2000);
  assert.equal(posts.filter((p) => p.m.type === "alive").length, 2);
  release();
  await settle();
  tm.advance(FLUSH_DELAY_MS);
  tm.advance(10000);
  assert.equal(posts.filter((p) => p.m.type === "alive").length, 2, "no beats once idle");
  assert.equal(posts.filter((p) => p.m.type === "results").length, 1);
});

await t("W11 failed results post: bodies answer status 0, HTTP errors keep their status (404 tolerance)", async () => {
  const tm = fakeTimers();
  const posts = [];
  let failNext = true;
  const h = createShardFetchHandler({
    fetchImpl: async (url) => (url.endsWith("/404.bin") ? resp(enc(""), { status: 404, statusText: "Not Found" }) : resp(enc(url))),
    post: (m, transfer) => {
      if (m.type === "results" && failNext) {
        failNext = false;
        throw new Error("DataCloneError");
      }
      posts.push({ m, transfer });
    },
    now: tm.now,
    timeOrigin: 5000,
    setTimer: tm.setTimer,
    clearTimer: tm.clearTimer,
    digest: { engine: "js", digestHex: async (b) => sha256Hex(new Uint8Array(b)) },
    heartbeatMs: 0,
  });
  h.onMessage({
    type: "batch",
    reqs: [
      { id: 1, url: "http://x/shards/hh/ok.bin", prio: "low", sha: null },
      { id: 2, url: "http://x/shards/hh/404.bin", prio: "low", sha: null },
    ],
  });
  await settle();
  tm.advance(FLUSH_DELAY_MS);
  assert.equal(posts.length, 1, "one fallback results message");
  assert.equal(posts[0].transfer.length, 0, "the fallback transfers nothing");
  const by = Object.fromEntries(posts[0].m.res.map((r) => [r.id, r]));
  assert.deepEqual([by[1].ok, by[1].status, by[1].buf], [false, 0, undefined]);
  assert.match(by[1].msg, /results postMessage failed: DataCloneError/);
  assert.deepEqual([by[2].ok, by[2].status, by[2].statusText], [false, 404, "Not Found"], "404 survives the fallback");
  assert.equal(h.stats.postErrors, 1);
});

await t("W12 lag probe: armed only while requests are in flight; results carry lag + tResp", async () => {
  let clock = 0;
  const timers = [];
  const posts = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const h = createShardFetchHandler({
    fetchImpl: async (url) => {
      await gate;
      return resp(enc(url));
    },
    post: (m) => posts.push(m),
    now: () => clock,
    timeOrigin: 5000,
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimer: () => {},
    digest: { engine: "js", digestHex: async (b) => sha256Hex(new Uint8Array(b)) },
    heartbeatMs: 0,
    lagProbeMs: 10,
    delayMs: 8,
  });
  assert.equal(timers.length, 0, "idle: no probe");
  h.onMessage({ type: "batch", reqs: [{ id: 1, url: "http://x/shards/ii/1.bin", prio: "high", sha: null }] });
  assert.deepEqual(timers.map((x) => x.ms), [10], "one probe armed for the in-flight request");
  // The worker thread was blocked: the 10 ms probe fires 130 ms late.
  clock = 140;
  timers.shift().fn();
  assert.equal(h.stats.lag.probes, 1);
  assert.equal(h.stats.lag.max, 130);
  assert.deepEqual([h.stats.lag.over16, h.stats.lag.over50, h.stats.lag.over100], [1, 1, 1]);
  assert.deepEqual(timers.map((x) => x.ms), [10], "re-armed while in flight");
  // On time: no lateness counted.
  clock = 150;
  timers.shift().fn();
  assert.equal(h.stats.lag.probes, 2);
  assert.equal(h.stats.lag.over16, 1);
  // Response lands; flush; the probe stops once nothing is in flight.
  clock = 160;
  release();
  await settle();
  const flushTimer = timers.find((x) => x.ms === 8);
  assert.ok(flushTimer, "flush timer armed");
  timers.splice(timers.indexOf(flushTimer), 1);
  flushTimer.fn();
  const res = posts.find((m) => m.type === "results");
  assert.ok(res, "results posted");
  assert.deepEqual(res.lag, { probes: 2, max: 130, over16: 1, over50: 1, over100: 1 });
  assert.equal(res.res[0].tResp, 160);
  assert.equal(res.res[0].tNetEnd, 160);
  const probeTimer = timers.find((x) => x.ms === 10);
  timers.splice(timers.indexOf(probeTimer), 1);
  probeTimer.fn();
  assert.equal(timers.filter((x) => x.ms === 10).length, 0, "the last probe does not re-arm (idle)");
});

// ---------------------------------------------------------------------------
console.log("shard_fetch_worker — ?shardHashSlice");
// ---------------------------------------------------------------------------

const SHA_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHA_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

/** Deterministic pseudo-random bytes. */
function lcgBytes(n, seed = 777) {
  const u = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    u[i] = s >>> 24;
  }
  return u;
}

/** Incremental digest of `u`, fed in pieces of `chunk` bytes (a number, or i -> size). */
function incHex(u, chunk) {
  const st = sha256Init();
  let p = 0;
  let i = 0;
  while (p < u.length) {
    const n = Math.max(1, typeof chunk === "function" ? chunk(i++) : chunk);
    const e = Math.min(u.length, p + n);
    sha256Update(st, u, p, e);
    p = e;
  }
  return sha256Final(st);
}

/** Manual event-loop turns: the handler's `yieldTurn` queues, the test runs them. */
function manualTurns() {
  const q = [];
  return {
    yieldTurn: (fn) => q.push(fn),
    pending: () => q.length,
    run(n = 1) {
      for (let i = 0; i < n; i++) {
        const fn = q.shift();
        assert.ok(fn, "a turn is armed");
        fn();
      }
    },
  };
}

await t("W13 incremental sha256 (init/update/final): FIPS vectors under any chunking", async () => {
  assert.equal(HASH_SLICE_BYTES, 64 * 1024);
  assert.equal(sha256Final(sha256Init()), SHA_EMPTY, "nothing fed");
  const st = sha256Init();
  sha256Update(st, new Uint8Array(0));
  sha256Update(st, enc("abc"), 1, 1);
  assert.equal(sha256Final(st), SHA_EMPTY, "empty updates");
  const vectors = [
    ["abc", SHA_ABC],
    ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
    [
      "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
      "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
    ],
  ];
  for (const [s, want] of vectors) {
    for (const chunk of [1, 3, 55, 56, 63, 64, 65, 1000]) assert.equal(incHex(enc(s), chunk), want, `${s.slice(0, 8)}… chunk ${chunk}`);
  }
  const million = new Uint8Array(1000000).fill(0x61);
  const wantM = "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0";
  assert.equal(incHex(million, HASH_SLICE_BYTES), wantM, "1M x 'a' in 64 KB slices");
  assert.equal(incHex(million, 4097), wantM, "1M x 'a' in 4097-byte pieces");
});

await t("W14 incremental == one-shot sha256Hex == node:crypto (1 MB random, slice boundaries, views)", async () => {
  const S = HASH_SLICE_BYTES;
  // 1 MB random against the one-shot function, under several chunkings.
  const mb = new Uint8Array(crypto.randomBytes(1 << 20));
  const one = sha256Hex(mb);
  assert.equal(one, nodeSha(mb), "one-shot == node:crypto");
  assert.equal(incHex(mb, S), one, "64 KB slices");
  let seed = 99;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return 1 + (seed % 150000);
  };
  assert.equal(incHex(mb, rnd), one, "random chunk sizes");
  assert.equal(incHex(mb, (i) => (i < 200 ? 1 : S)), one, "200 single bytes, then 64 KB slices");
  // Sizes around the slice boundary (and the padding-block boundary inside it).
  const sizes = [0, 1, 55, 56, 63, 64, 65, S - 1, S, S + 1, 2 * S - 1, 2 * S, 2 * S + 1, 3 * S + 55, 3 * S + 56, 3 * S + 64];
  for (const n of sizes) {
    const u = lcgBytes(n, n + 1);
    const want = nodeSha(u);
    assert.equal(sha256Hex(u), want, `one-shot ${n}`);
    assert.equal(incHex(u, S), want, `64 KB slices, ${n} bytes`);
    assert.equal(incHex(u, S - 1), want, `64 KB-1 slices, ${n} bytes`);
  }
  // A view into a larger buffer (byteOffset 3): the DataView honours the offset.
  const backing = lcgBytes(3 * S + 7, 5);
  const view = backing.subarray(3, 3 + 2 * S + 1);
  assert.equal(incHex(view, S), nodeSha(view), "subarray view");
});

await t("W15 handler: <= 64 KB one pass; > 64 KB one slice per turn; byte-identical verify; stats; results `hash`", async () => {
  const S = HASH_SLICE_BYTES;
  const B = {
    "http://x/shards/sa/exact.bin": lcgBytes(S, 1),
    "http://x/shards/sa/plus1.bin": lcgBytes(S + 1, 2),
    "http://x/shards/sa/mb.bin": lcgBytes((1 << 20) + 1, 3),
    "http://x/shards/sa/bad.bin": lcgBytes(3 * S, 4),
  };
  const turns = manualTurns();
  const { h, posts } = handlerRig({ bodies: (url) => resp(B[url]), deps: { yieldTurn: turns.yieldTurn, maxEntries: 1 } });
  assert.equal(h.stats.hashSlice, true, "default on");
  assert.equal(h.stats.hashYield, "injected");
  const done = () => posts.filter((p) => p.m.type === "results").flatMap((p) => p.m.res);
  const full = (u) => nodeSha(u); // all 64 hex chars: verified == the whole digest matches
  h.onMessage({
    type: "batch",
    reqs: [
      { id: 1, url: "http://x/shards/sa/exact.bin", prio: "low", sha: full(B["http://x/shards/sa/exact.bin"]) },
      { id: 2, url: "http://x/shards/sa/plus1.bin", prio: "low", sha: full(B["http://x/shards/sa/plus1.bin"]) },
      { id: 3, url: "http://x/shards/sa/mb.bin", prio: "low", sha: full(B["http://x/shards/sa/mb.bin"]) },
      { id: 4, url: "http://x/shards/sa/bad.bin", prio: "low", sha: "0".repeat(64) },
    ],
  });
  await settle();
  assert.deepEqual(done().map((r) => r.id), [1], "64 KB exactly: one pass, delivered without a turn");
  assert.equal(done()[0].verified, true);
  assert.equal(h.stats.slicedBodies, 3, "64 KB+1, 1 MB+1 and 192 KB are sliced");
  assert.equal(h.stats.slices, 0, "no slice before a turn");
  assert.equal(turns.pending(), 1, "ONE turn armed for all queued bodies");
  // Exactly one slice per turn. Fewest bytes left first: 64 KB+1 (2 slices),
  // then 192 KB (3, the mismatch), then 1 MB+1 (17).
  const want = [[1], [1, 2], [1, 2], [1, 2], [1, 2, 4]];
  let n = 0;
  for (const ids of want) {
    turns.run();
    await settle();
    n += 1;
    assert.equal(h.stats.slices, n, `one slice per turn (turn ${n})`);
    assert.deepEqual(done().map((r) => r.id), ids, `delivered after turn ${n}`);
  }
  for (let k = 0; k < 16; k++) {
    turns.run();
    await settle();
    assert.equal(done().length, 3, `1 MB+1 still hashing (slice ${k + 1}/17)`);
  }
  turns.run();
  await settle();
  assert.deepEqual(done().map((r) => r.id), [1, 2, 4, 3]);
  assert.equal(turns.pending(), 0, "idle: no turn armed");
  const by = Object.fromEntries(done().map((r) => [r.id, r]));
  for (const id of [1, 2, 3]) assert.deepEqual([by[id].ok, by[id].verified, by[id].mismatch], [true, true, false], `#${id} verified`);
  assert.deepEqual([by[4].ok, by[4].verified, by[4].mismatch], [true, false, true], "a sliced mismatch is still ok + unverified");
  assert.equal(new Uint8Array(by[3].buf).length, (1 << 20) + 1, "the body itself goes back whole");
  assert.equal(h.stats.slices, 2 + 3 + 17);
  assert.equal(h.stats.verified, 3);
  assert.equal(h.stats.mismatch, 1);
  assert.ok(typeof h.stats.maxSliceMs === "number" && h.stats.maxSliceMs >= 0);
  assert.ok(h.stats.hashMs >= 0);
  const last = posts[posts.length - 1].m;
  assert.deepEqual(last.hash, { slice: true, yield: "injected", slicedBodies: 3, slices: 22, maxSliceMs: h.stats.maxSliceMs });
  const snap = h.snapshot();
  assert.equal(snap.slicesQueued, 0);
  assert.equal(snap.slicedBodies, 3);
});

await t("W16 urgent first: small bodies between slices; an urgent big body's slices before the low body's rest", async () => {
  const S = HASH_SLICE_BYTES;
  const B = {
    "http://x/shards/sb/L.bin": lcgBytes(16 * S, 10), // low, 16 slices
    "http://x/shards/sb/U.bin": lcgBytes(4 * S, 11), // high, 4 slices
    "http://x/shards/sb/s1.bin": lcgBytes(1000, 12), // high, small
    "http://x/shards/sb/s2.bin": lcgBytes(1000, 13), // low, small
    "http://x/shards/sb/M.bin": lcgBytes(2 * S + 1, 14), // low, 3 slices
  };
  const turns = manualTurns();
  const { h, posts } = handlerRig({ bodies: (url) => resp(B[url]), deps: { yieldTurn: turns.yieldTurn, maxEntries: 1 } });
  const done = () => posts.filter((p) => p.m.type === "results").flatMap((p) => p.m.res).map((r) => r.id);
  const req = (id, name, prio) => ({ id, url: `http://x/shards/sb/${name}.bin`, prio, sha: nodeSha(B[`http://x/shards/sb/${name}.bin`]) });
  h.onMessage({ type: "batch", reqs: [req(1, "L", "low")] });
  await settle();
  for (let k = 0; k < 3; k++) {
    turns.run();
    await settle();
  }
  assert.equal(h.stats.slices, 3, "the low 1 MB body is 3 slices in");
  h.onMessage({ type: "batch", reqs: [req(2, "U", "high"), req(3, "s1", "high"), req(4, "s2", "low"), req(5, "M", "low")] });
  await settle();
  assert.deepEqual(done(), [3, 4], "small bodies hash in one pass between slices, no turn needed");
  assert.equal(h.stats.slices, 3, "...and cost no slice");
  assert.equal(turns.pending(), 1, "still one armed turn");
  for (let k = 0; k < 3; k++) {
    turns.run();
    await settle();
    assert.deepEqual(done(), [3, 4], `urgent slice ${k + 1}/4`);
  }
  turns.run();
  await settle();
  assert.deepEqual(done(), [3, 4, 2], "the urgent body finished in its own 4 slices, before the low body's 13 left");
  assert.equal(h.stats.slices, 7);
  // Low bodies: fewest bytes left first (M: 3 slices) before L's 13.
  for (let k = 0; k < 3; k++) {
    turns.run();
    await settle();
  }
  assert.deepEqual(done(), [3, 4, 2, 5]);
  for (let k = 0; k < 13; k++) {
    turns.run();
    await settle();
  }
  assert.deepEqual(done(), [3, 4, 2, 5, 1]);
  assert.equal(h.stats.slices, 3 + 4 + 3 + 13);
  assert.equal(h.stats.verified, 5);
  assert.equal(turns.pending(), 0);

  // 'auto' (the urgent lane under ?shardFetchHigh=off) is urgent too: it goes
  // first although the low body has fewer bytes left.
  const C = { "http://x/shards/sc/lo.bin": lcgBytes(S + 1, 20), "http://x/shards/sc/au.bin": lcgBytes(3 * S, 21) };
  const t2 = manualTurns();
  const r2 = handlerRig({ bodies: (url) => resp(C[url]), deps: { yieldTurn: t2.yieldTurn, maxEntries: 1 } });
  const done2 = () => r2.posts.filter((p) => p.m.type === "results").flatMap((p) => p.m.res).map((r) => r.id);
  r2.h.onMessage({
    type: "batch",
    reqs: [
      { id: 1, url: "http://x/shards/sc/lo.bin", prio: "low", sha: nodeSha(C["http://x/shards/sc/lo.bin"]) },
      { id: 2, url: "http://x/shards/sc/au.bin", prio: "auto", sha: nodeSha(C["http://x/shards/sc/au.bin"]) },
    ],
  });
  await settle();
  for (let k = 0; k < 3; k++) {
    t2.run();
    await settle();
  }
  assert.deepEqual(done2(), [2], "'auto' finished first (3 slices), the low body waits");
  for (let k = 0; k < 2; k++) {
    t2.run();
    await settle();
  }
  assert.deepEqual(done2(), [2, 1]);
});

await t("W17 off = the one-shot engine call; a batch's boolean hashSlice overrides; 'subtle' never sliced", async () => {
  const big = lcgBytes(300000, 30); // 5 slices when on
  const sha = nodeSha(big);
  let hashed = 0;
  const digest = { engine: "js", digestHex: async (b) => { hashed += 1; return sha256Hex(new Uint8Array(b)); } };
  const turns = manualTurns();
  const { h, posts } = handlerRig({ digest, bodies: () => resp(big), deps: { hashSlice: false, yieldTurn: turns.yieldTurn, maxEntries: 1 } });
  const res = () => posts.filter((p) => p.m.type === "results");
  const req = (id) => ({ id, url: `http://x/shards/sd/${id}.bin`, prio: "high", sha });
  assert.equal(h.stats.hashSlice, false);
  h.onMessage({ type: "batch", reqs: [req(1)] });
  await settle();
  assert.equal(hashed, 1, "off: today's one-shot digestHex call");
  assert.equal(turns.pending(), 0, "off: no turn");
  assert.equal(h.stats.slicedBodies, 0);
  assert.equal(res()[0].m.res[0].verified, true);
  assert.equal(res()[0].m.hash.slice, false);
  // The page's flag on the batch wins from then on.
  h.onMessage({ type: "batch", hashSlice: true, reqs: [req(2)] });
  await settle();
  assert.equal(h.stats.hashSlice, true);
  assert.equal(hashed, 1, "on: the engine's one-shot call is not used for a big body");
  assert.equal(turns.pending(), 1);
  turns.run(5);
  await settle();
  assert.equal(res()[1].m.res[0].verified, true);
  assert.equal(h.stats.slices, 5);
  // Absent keeps the mode.
  h.onMessage({ type: "batch", reqs: [req(3)] });
  await settle();
  assert.equal(turns.pending(), 1, "absent: still sliced");
  turns.run(5);
  await settle();
  assert.equal(res()[2].m.res[0].verified, true);
  // Off again.
  h.onMessage({ type: "batch", hashSlice: false, reqs: [req(4)] });
  await settle();
  assert.equal(hashed, 2);
  assert.equal(turns.pending(), 0);
  assert.equal(res()[3].m.res[0].verified, true);
  assert.deepEqual(res()[3].m.hash, { slice: false, yield: "injected", slicedBodies: 2, slices: 10, maxSliceMs: h.stats.maxSliceMs });
  // Non-boolean values are ignored.
  h.onMessage({ type: "batch", hashSlice: "on", reqs: [] });
  assert.equal(h.stats.hashSlice, false);
  // The 'subtle' engine (secure context) is never sliced.
  let subtleN = 0;
  const t2 = manualTurns();
  const sub = { engine: "subtle", digestHex: async (b) => { subtleN += 1; return nodeSha(new Uint8Array(b)); } };
  const r2 = handlerRig({ digest: sub, bodies: () => resp(big), deps: { yieldTurn: t2.yieldTurn, maxEntries: 1 } });
  r2.h.onMessage({ type: "batch", reqs: [req(5)] });
  await settle();
  assert.equal(subtleN, 1);
  assert.equal(t2.pending(), 0);
  assert.equal(r2.h.stats.slicedBodies, 0);
  assert.equal(r2.posts[0].m.res[0].verified, true);
});

await t("W18 worker-side shardHashSliceEnabled: absent/garbage on; off|0|false|no off", async () => {
  for (const s of [undefined, null, "", "?a=1", "?shardHashSlice", "?shardHashSlice=on", "?shardHashSlice=1", "?shardHashSlice=bogus", "?shardFetchWorker=off"]) {
    assert.equal(shardHashSliceEnabled(s), true, String(s));
  }
  for (const s of ["?shardHashSlice=off", "?shardHashSlice=0", "?shardHashSlice=false", "?shardHashSlice=no", "?x=1&shardHashSlice=OFF", "?shardHashSlice=%20No%20"]) {
    assert.equal(shardHashSliceEnabled(s), false, s);
  }
});

await t("W19 makeTurnYielder: MessageChannel FIFO + closes when drained; setTimeout fallback; default handler path", async () => {
  const y = makeTurnYielder();
  assert.equal(y.kind, "MessageChannel", "Node and workers have MessageChannel");
  const order = [];
  await new Promise((resolve) => {
    y.yieldTurn(() => {
      order.push(1);
      y.yieldTurn(() => {
        order.push(3);
        resolve();
      });
    });
    y.yieldTurn(() => order.push(2));
  });
  assert.deepEqual(order, [1, 2, 3]);
  // After draining, posting again makes a new channel.
  await new Promise((r) => y.yieldTurn(r));
  const f = makeTurnYielder({});
  assert.equal(f.kind, "setTimeout", "no MessageChannel -> setTimeout(0)");
  await new Promise((r) => f.yieldTurn(r));
  // A process whose only work is yielded turns exits by itself (the port is
  // closed once drained; an open port with a handler would keep it alive).
  const workerUrl = pathToFileURL(path.join(APP, "scene3d", "shard_fetch_worker.js")).href;
  const code =
    `import { makeTurnYielder } from ${JSON.stringify(workerUrl)};\n` +
    `const y = makeTurnYielder(); let n = 0;\n` +
    `const step = () => { if (++n < 50) y.yieldTurn(step); else console.log("turns " + n); };\n` +
    `y.yieldTurn(step);\n`;
  const out = execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { timeout: 20000, encoding: "utf8" });
  assert.equal(out.trim(), "turns 50");
  // The default handler (no yieldTurn dep): real MessageChannel turns, real result.
  const big = new Uint8Array(crypto.randomBytes((1 << 20) + 7));
  const posts = [];
  const h = createShardFetchHandler({
    fetchImpl: async () => resp(big),
    post: (m) => posts.push(m),
    digest: { engine: "js", digestHex: async (b) => sha256Hex(new Uint8Array(b)) },
    heartbeatMs: 0,
    lagProbeMs: 0,
    maxEntries: 1,
  });
  assert.equal(h.stats.hashYield, "MessageChannel");
  h.onMessage({ type: "batch", reqs: [{ id: 1, url: "http://x/shards/se/1.bin", prio: "low", sha: nodeSha(big) }] });
  for (let i = 0; i < 5000 && posts.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(posts.length, 1, "delivered");
  assert.equal(posts[0].type, "results");
  assert.equal(posts[0].res[0].verified, true);
  assert.equal(posts[0].hash.yield, "MessageChannel");
  assert.equal(h.stats.slicedBodies, 1);
  assert.equal(h.stats.slices, 17);
  // A yielder that throws: the queued body finishes in one pass (today's cost), still verified.
  const r2 = handlerRig({ bodies: () => resp(big), deps: { yieldTurn: () => { throw new Error("no turns"); }, maxEntries: 1 } });
  r2.h.onMessage({ type: "batch", reqs: [{ id: 2, url: "http://x/shards/se/2.bin", prio: "low", sha: nodeSha(big) }] });
  await settle();
  assert.equal(r2.posts.length, 1);
  assert.deepEqual([r2.posts[0].m.res[0].verified, r2.posts[0].m.res[0].mismatch], [true, false]);
  assert.equal(r2.h.stats.slicedBodies, 1);
  assert.equal(r2.h.snapshot().slicesQueued, 0);
});

await t("W20 worker bootstrap (simulated WorkerGlobalScope): script-URL reader, batch override, __shardFetchWorkerStats", async () => {
  // A child process, so the fake `self` / `fetch` globals never touch this one.
  const workerUrl = pathToFileURL(path.join(APP, "scene3d", "shard_fetch_worker.js")).href;
  const code = `
    import { createHash } from "node:crypto";
    const [search, batchFlag] = JSON.parse(process.argv[1]);
    globalThis.WorkerGlobalScope = class WorkerGlobalScope {};
    const posted = [];
    const me = Object.create(WorkerGlobalScope.prototype);
    me.location = { search };
    me.isSecureContext = false;
    me.postMessage = (m) => posted.push(m);
    globalThis.self = me;
    const body = new Uint8Array(200000).map((_, i) => (i * 7 + (i >> 9)) & 255);
    const inits = [];
    globalThis.fetch = async (u, init) => (inits.push(init), { ok: true, status: 200, statusText: "OK", arrayBuffer: async () => body.buffer.slice(0) });
    await import(${JSON.stringify(workerUrl)});
    const ready = posted.find((m) => m.type === "ready");
    const s0 = me.__shardFetchWorkerStats();
    const sha = createHash("sha256").update(body).digest("hex");
    const batch = { type: "batch", reqs: [{ id: 1, url: "http://x/shards/bt/1.bin", prio: "high", sha }] };
    if (batchFlag !== null) batch.hashSlice = batchFlag;
    me.onmessage({ data: batch });
    let res = null;
    for (let i = 0; i < 4000 && !res; i++) {
      await new Promise((r) => setTimeout(r, 1));
      res = posted.find((m) => m.type === "results");
    }
    const s1 = me.__shardFetchWorkerStats();
    console.log(JSON.stringify({ engine: ready && ready.engine, boot: s0.hashSlice, yield: s0.hashYield, now: s1.hashSlice,
      verified: res && res.res[0].verified, sliced: s1.slicedBodies, slices: s1.slices, hash: res && res.hash, prio: inits[0] }));
    process.exit(0);
  `;
  const run = (search, batchFlag) =>
    JSON.parse(execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code, JSON.stringify([search, batchFlag])], { timeout: 30000, encoding: "utf8" }).trim());
  const on = run("", null);
  assert.deepEqual(
    [on.engine, on.boot, on.yield, on.now, on.verified, on.sliced, on.slices],
    ["js", true, "MessageChannel", true, true, 1, 4],
    "default: on, MessageChannel turns, 200 KB = 4 slices",
  );
  assert.deepEqual(on.prio, { priority: "high" });
  assert.equal(on.hash.slicedBodies, 1);
  const urlOff = run("?shardHashSlice=off", null);
  assert.deepEqual([urlOff.boot, urlOff.now, urlOff.verified, urlOff.sliced], [false, false, true, 0], "worker-URL =off: one pass");
  const pageOff = run("", false);
  assert.deepEqual([pageOff.boot, pageOff.now, pageOff.verified, pageOff.sliced], [true, false, true, 0], "the page's hashSlice:false wins");
  const pageOn = run("?shardHashSlice=off", true);
  assert.deepEqual([pageOn.boot, pageOn.now, pageOn.verified, pageOn.sliced], [false, true, true, 1], "the page's hashSlice:true wins");
});

// ---------------------------------------------------------------------------
console.log("shard_fetch_client — page side");
// ---------------------------------------------------------------------------

function clientRig(over = {}) {
  const tm = fakeTimers();
  const w = new FakeWorker();
  const disabled = [];
  const micro = [];
  const fm = new Map();
  const c = new ShardFetchClient({
    createWorker: () => w,
    onDisable: (why) => disabled.push(why),
    now: tm.now,
    pageOrigin: 1000,
    baseHref: "http://host:7093/apps/holtburger-web/index.html",
    fetchMap: fm,
    setTimer: tm.setTimer,
    clearTimer: tm.clearTimer,
    log: quietLog,
    ...over,
  });
  return { c, w, tm, disabled, micro, fm };
}

await t("C1 flag reader: absent/garbage on; off|0|false|no off", async () => {
  for (const s of ["", "?a=1", "?shardFetchWorker", "?shardFetchWorker=on", "?shardFetchWorker=1", "?shardFetchWorker=yes", "?shardFetchWorker=bogus"]) {
    assert.equal(shardFetchWorkerEnabled(s), true, s);
  }
  for (const s of ["?shardFetchWorker=off", "?shardFetchWorker=0", "?shardFetchWorker=false", "?shardFetchWorker=no", "?x=1&shardFetchWorker=OFF"]) {
    assert.equal(shardFetchWorkerEnabled(s), false, s);
  }
});

await t("C2 N fetchShard calls in one turn -> ONE batch message", async () => {
  const { c, w } = clientRig();
  const ps = [];
  for (let i = 0; i < 50; i++) {
    const sha = i % 2 ? "ab".repeat(16) : null;
    ps.push(c.fetchShard(`../../dist/shards/${(i % 256).toString(16).padStart(2, "0")}/${i}.bin`, i % 3 ? "low" : "auto", sha));
  }
  assert.equal(w.posted.length, 0, "nothing posted synchronously");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(w.posted.length, 1);
  const m = w.posted[0];
  assert.equal(m.type, "batch");
  assert.equal(m.reqs.length, 50);
  assert.deepEqual(m.reqs.map((r) => r.id), Array.from({ length: 50 }, (_, i) => i + 1));
  assert.equal(m.reqs[0].url, "http://host:7093/dist/shards/00/0.bin", "absolutised against the PAGE");
  assert.equal(m.reqs[0].prio, "high", "the wasm urgent lane ('auto') goes out as 'high' by default");
  assert.equal(m.reqs[1].prio, "low");
  assert.equal(m.reqs[1].sha, "ab".repeat(16));
  assert.equal(m.reqs[0].sha, null);
  assert.equal(c.diag().batches, 1);
  assert.equal(c.diag().maxBatch, 50);
  for (const p of ps) p.catch(() => {});
  c.dispose("test end");
});

await t("C3 results resolve the right promises; verified -> {verified,bytes}, else Uint8Array", async () => {
  const { c, w } = clientRig();
  const p1 = c.fetchShard("http://h/shards/01/a.bin", "auto", "aa".repeat(16));
  const p2 = c.fetchShard("http://h/shards/01/b.bin", "low", null);
  const p3 = c.fetchShard("http://h/shards/01/c.bin", "low", "cc".repeat(16));
  await Promise.resolve();
  const buf = (s) => enc(s).buffer;
  w.emit({ type: "ready", to: 1002, engine: "js", secure: false });
  w.emit({
    type: "results",
    to: 1002,
    res: [
      { id: 3, ok: true, buf: buf("C"), verified: false, mismatch: false, tNetEnd: 1 },
      { id: 1, ok: true, buf: buf("A"), verified: true, mismatch: false, tNetEnd: 1 },
    ],
  });
  w.emit({ type: "results", to: 1002, res: [{ id: 2, ok: true, buf: buf("B"), verified: false, tNetEnd: 2 }] });
  const v1 = await p1;
  const v2 = await p2;
  const v3 = await p3;
  assert.equal(v1.verified, true);
  assert.ok(v1.bytes instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(v1.bytes), "A");
  assert.ok(v2 instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(v2), "B");
  assert.ok(v3 instanceof Uint8Array, "unverified (sha sent, worker said no) -> plain bytes");
  assert.equal(new TextDecoder().decode(v3), "C");
  const d = c.diag();
  assert.equal(d.results, 3);
  assert.equal(d.verified, 1);
  assert.equal(d.unverified, 2);
  assert.equal(d.workerReady, true);
  assert.equal(d.engine, "js");
  assert.equal(d.pending, 0);
  // Rust's reading of the same values:
  assert.deepEqual((await rustView(Promise.resolve(v1), true)).verified, true);
  assert.deepEqual((await rustView(Promise.resolve(v1), false)).verified, false, "a claim without a sent hash is ignored");
  c.dispose("test end");
});

await t("C4 404 rejects {status:404} (Rust Http -> tolerate_404); network -> Error (Rust Network)", async () => {
  const { c, w } = clientRig();
  const p404 = c.fetchShard("http://h/shards/02/x.bin", "auto", null);
  const pNet = c.fetchShard("http://h/shards/02/y.bin", "auto", null);
  await Promise.resolve();
  w.emit({
    type: "results",
    to: 1000,
    res: [
      { id: 1, ok: false, status: 404, statusText: "Not Found", msg: "HTTP 404", tNetEnd: 3 },
      { id: 2, ok: false, status: 0, msg: "Failed to fetch", tNetEnd: 3 },
    ],
  });
  const e404 = await p404.then(() => null, (e) => e);
  const eNet = await pNet.then(() => null, (e) => e);
  assert.ok(e404 && e404.status === 404 && e404.statusText === "Not Found", "404 rejection carries the status");
  assert.ok(eNet instanceof Error && /Failed to fetch/.test(eNet.message) && eNet.status === undefined);
  // Rust's reading (http.rs shard_fetcher_rejection):
  const r404 = await rustView(Promise.reject(e404));
  assert.deepEqual([r404.kind, r404.status], ["Http", 404], "-> HttpError::Http{404} -> tolerate_404 still applies");
  assert.equal((await rustView(Promise.reject(eNet))).kind, "Network");
  assert.equal(c.diag().errors.http, 1);
  assert.equal(c.diag().errors.network, 1);
  c.dispose("test end");
});

await t("C5 sha mismatch end-to-end -> resolves UNVERIFIED; Rust Step E re-hashes", async () => {
  const body = enc("tampered");
  const factory = inProcWorkerFactory({ fetchImpl: async () => resp(body), heartbeatMs: 0 });
  const c = new ShardFetchClient({ createWorker: factory, baseHref: "http://h/", pageOrigin: 1000, fetchMap: null, log: quietLog });
  const want = nodeSha(enc("original")).slice(0, 32);
  const p = c.fetchShard("http://h/shards/03/z.bin", "auto", want);
  const v = await rustView(p, true);
  assert.equal(v.kind, "body");
  assert.equal(v.verified, false, "mismatch -> Step E verifies (and fails the key with today's message)");
  assert.equal(new TextDecoder().decode(v.bytes), "tampered");
  assert.equal(c.diag().shaMismatch, 1);
  const good = c.fetchShard("http://h/shards/03/y.bin", "auto", nodeSha(body).slice(0, 32));
  const g = await rustView(good, true);
  assert.equal(g.verified, true, "match -> Step E skips the re-hash");
  c.dispose("test end");
});

await t("C6 worker error / messageerror -> all pending reject, unregister once, terminate, later calls reject", async () => {
  for (const how of ["error", "messageerror"]) {
    const { c, w, disabled } = clientRig();
    const ps = [1, 2, 3].map((i) => c.fetchShard(`http://h/shards/04/${i}.bin`, "low", null));
    await Promise.resolve();
    if (how === "error") w.onerror({ message: "boom" });
    else w.onmessageerror({});
    for (const p of ps) await assert.rejects(p, /shard fetch worker failed/);
    assert.equal(disabled.length, 1, "unregistered exactly once");
    assert.equal(w.terminated, true);
    assert.equal(c.disabled, true);
    await assert.rejects(c.fetchShard("http://h/shards/04/9.bin", "low", null), /disabled/);
    assert.equal(c.diag().errors.failedPending, 3);
    assert.match(c.diag().disabledReason, how === "error" ? /worker error: boom/ : /messageerror/);
    w.onerror({ message: "again" });
    assert.equal(disabled.length, 1, "a second error does not unregister again");
    w.emit({ type: "results", to: 1000, res: [{ id: 1, ok: true, buf: enc("late").buffer }] });
  }
});

function fakeNs() {
  const calls = [];
  return {
    calls,
    register_shard_fetcher(f) {
      calls.push(f);
      return typeof f === "function";
    },
  };
}

await t("C7 =off never constructs the worker and never registers", async () => {
  for (const v of ["off", "0", "false", "no"]) {
    _resetShardFetchForTests();
    let constructed = 0;
    const ns = fakeNs();
    const r = installShardFetchWorker({
      wasmNs: ns,
      search: `?shardFetchWorker=${v}`,
      createWorker: () => {
        constructed += 1;
        return new FakeWorker();
      },
      log: quietLog,
    });
    assert.equal(r, null, v);
    assert.equal(constructed, 0, v);
    assert.equal(ns.calls.length, 0, v);
    const d = shardFetchDiag();
    assert.equal(d.enabled, false);
    assert.match(d.disabledReason, /flag off/);
  }
});

await t("C8 stale pkg (no export) / no Worker -> null, never constructs", async () => {
  _resetShardFetchForTests();
  let constructed = 0;
  const r = installShardFetchWorker({ wasmNs: {}, search: "", createWorker: () => (constructed++, new FakeWorker()), log: quietLog });
  assert.equal(r, null);
  assert.equal(constructed, 0);
  assert.match(shardFetchDiag().disabledReason, /stale pkg/);
  _resetShardFetchForTests();
  const hadWorker = Object.prototype.hasOwnProperty.call(globalThis, "Worker");
  const saved = globalThis.Worker;
  try {
    delete globalThis.Worker;
    assert.equal(installShardFetchWorker({ wasmNs: fakeNs(), search: "", log: quietLog }), null);
    assert.match(shardFetchDiag().disabledReason, /no Worker/);
  } finally {
    if (hadWorker) globalThis.Worker = saved;
  }
});

await t("C9 install registers a function that routes through the worker; diag on both arms", async () => {
  _resetShardFetchForTests();
  const ns = fakeNs();
  const factory = inProcWorkerFactory({ fetchImpl: async (u) => resp(enc(u)), heartbeatMs: 0 });
  const client = installShardFetchWorker({ wasmNs: ns, search: "", createWorker: factory, baseHref: "http://h/a/index.html", fetchMap: null, log: quietLog });
  assert.ok(client, "armed");
  assert.equal(ns.calls.length, 1);
  assert.equal(typeof ns.calls[0], "function");
  const fetcher = ns.calls[0];
  const v = await fetcher("../dist/shards/05/a.bin", "auto", null);
  assert.equal(new TextDecoder().decode(v), "http://h/dist/shards/05/a.bin");
  assert.equal(typeof globalThis.__diag.shardFetch, "function");
  assert.equal(typeof globalThis.__shardFetchStats, "function");
  assert.equal(globalThis.__shardFetchStats().enabled, true);
  assert.equal(globalThis.__diag.shardFetch().results, 1);
  assert.equal(installShardFetchWorker({ wasmNs: ns, search: "", createWorker: factory, log: quietLog }), client, "idempotent");
  assert.equal(factory.made.length, 1);
  // A worker failure unregisters through the namespace.
  factory.made[0].onerror({ message: "crash" });
  assert.equal(ns.calls.length, 2);
  assert.equal(ns.calls[1], null);
  assert.equal(globalThis.__shardFetchStats().enabled, false);
});

await t("C10 register refused -> disposed, null", async () => {
  _resetShardFetchForTests();
  const w = new FakeWorker();
  const ns = { register_shard_fetcher: () => false };
  const r = installShardFetchWorker({ wasmNs: ns, search: "", createWorker: () => w, log: quietLog });
  assert.equal(r, null);
  assert.equal(w.terminated, true);
  assert.match(shardFetchDiag().disabledReason, /refused/);
});

await t("C11 __fetchMap: page-clock c / h (worker netEnd via timeOrigins) / b, keyed from /shards/", async () => {
  const { c, w, tm, fm } = clientRig();
  tm.advance(100);
  const p = c.fetchShard("../../dist/shards/ab/abcdef.bin", "auto", null);
  const pErr = c.fetchShard("../../dist/shards/ab/missing.bin", "auto", null);
  await Promise.resolve();
  tm.advance(50); // page t = 150
  // worker timeOrigin 1003 = page origin 1000 + 3 ms; worker netEnd 140 (worker clock) = page 143
  w.emit({
    type: "results",
    to: 1003,
    res: [
      { id: 1, ok: true, buf: enc("x").buffer, verified: false, tNetEnd: 140 },
      { id: 2, ok: false, status: 404, statusText: "Not Found", tNetEnd: 141 },
    ],
  });
  await p;
  await pErr.catch(() => {});
  const rec = fm.get("/shards/ab/abcdef.bin");
  assert.deepEqual(rec, { c: 100, h: 143, b: 150 });
  const rec2 = fm.get("/shards/ab/missing.bin");
  assert.equal(rec2.h, 144);
  assert.equal(rec2.b, undefined, "no body for an error");
  assert.equal(c.diag().deliverMs.p50, 7);
  // Without a fetchMap nothing is recorded and nothing throws.
  const r2 = clientRig({ fetchMap: null });
  r2.c.fetchShard("http://h/shards/ab/q.bin", "auto", null).catch(() => {});
  r2.c.dispose("test end");
  c.dispose("test end");
});

await t("C12 watchdog: silent worker -> fail + direct; heartbeats keep a slow fetch alive", async () => {
  {
    const { c, w, tm, disabled } = clientRig({ bootStallMs: 15000, stallMs: 30000, watchdogMs: 5000 });
    const p = c.fetchShard("http://h/shards/06/a.bin", "auto", null);
    await Promise.resolve();
    tm.advance(14999);
    assert.equal(c.disabled, false);
    tm.advance(6000);
    assert.equal(c.disabled, true, "never reported ready + pending -> failed");
    await assert.rejects(p, /never reported ready/);
    assert.equal(disabled.length, 1);
    assert.equal(w.terminated, true);
  }
  {
    const { c, w, tm } = clientRig({ bootStallMs: 15000, stallMs: 30000, watchdogMs: 5000 });
    w.emit({ type: "ready", to: 1000, engine: "js" });
    const p = c.fetchShard("http://h/shards/06/b.bin", "low", null);
    await Promise.resolve();
    for (let s = 0; s < 60; s += 2) {
      tm.advance(2000);
      w.emit({ type: "alive", inflight: 1 });
    }
    assert.equal(c.disabled, false, "60 s with heartbeats is alive");
    w.emit({ type: "results", to: 1000, res: [{ id: 1, ok: true, buf: enc("slow").buffer, tNetEnd: 1 }] });
    assert.equal(new TextDecoder().decode(await p), "slow");
    tm.advance(120000);
    assert.equal(c.disabled, false, "idle (nothing pending) never trips the watchdog");
    c.dispose("test end");
  }
  {
    const { c, w, tm } = clientRig({ stallMs: 30000, watchdogMs: 5000 });
    w.emit({ type: "ready", to: 1000, engine: "js" });
    const p = c.fetchShard("http://h/shards/06/c.bin", "low", null);
    await Promise.resolve();
    tm.advance(36000);
    assert.equal(c.disabled, true, "30 s of silence with a request pending");
    await assert.rejects(p, /silent/);
  }
});

await t("C13 end to end with the real handler + real transfer: 150 calls, 1 batch, correct bytes", async () => {
  const bodies = new Map();
  for (let i = 0; i < 150; i++) bodies.set(`http://h/dist/shards/${i % 7}/${i}.bin`, enc(`body-${i}-`.repeat(1 + (i % 13))));
  let transferred = 0;
  const factory = inProcWorkerFactory({
    fetchImpl: async (u) => {
      await tick();
      return resp(bodies.get(u));
    },
    heartbeatMs: 0,
  });
  const c = new ShardFetchClient({ createWorker: factory, baseHref: "http://h/a/index.html", pageOrigin: 1000, fetchMap: null, log: quietLog });
  const urls = Array.from(bodies.keys());
  const ps = urls.map((u, i) => c.fetchShard(u.replace("http://h/dist", "../dist"), i % 2 ? "low" : "auto", nodeSha(bodies.get(u)).slice(0, 32)));
  const vals = await Promise.all(ps);
  const w = factory.made[0];
  assert.equal(w.posts, 1, "150 calls in one turn = one batch message");
  for (let i = 0; i < urls.length; i++) {
    assert.equal(vals[i].verified, true, `#${i} verified in the worker`);
    assert.deepEqual(Array.from(vals[i].bytes), Array.from(bodies.get(urls[i])), `#${i} bytes`);
  }
  const d = c.diag();
  assert.equal(d.results, 150);
  assert.equal(d.verified, 150);
  assert.ok(d.resultMsgs >= 3, `>= 3 result messages (64-entry cap), got ${d.resultMsgs}`);
  assert.ok(d.maxResultBatch <= 64);
  // Transfer really detached the worker-side buffers.
  for (const b of w.lastTransfer) transferred += b.byteLength === 0 ? 1 : 0;
  assert.equal(transferred, w.lastTransfer.length, "transferred buffers are detached on the worker side");
  assert.equal(w.handler.stats.engine, "js");
  c.dispose("test end");
});

await t("C14 calls in two turns -> two batch messages", async () => {
  const { c, w } = clientRig();
  const a = c.fetchShard("http://h/shards/07/a.bin", "auto", null);
  await Promise.resolve();
  await Promise.resolve();
  const b = c.fetchShard("http://h/shards/07/b.bin", "auto", null);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(w.posted.length, 2);
  assert.deepEqual(w.posted.map((m) => m.reqs.length), [1, 1]);
  a.catch(() => {});
  b.catch(() => {});
  c.dispose("test end");
});

await t("C15 deliverMs / totalMs percentiles", async () => {
  const { c, w, tm } = clientRig();
  const ps = [];
  for (let i = 0; i < 10; i++) ps.push(c.fetchShard(`http://h/shards/08/${i}.bin`, "auto", null));
  await Promise.resolve();
  tm.advance(100);
  // netEnd at page 100 - (i+1)*10 → deliver = (i+1)*10 ms
  w.emit({ type: "results", to: 1000, res: ps.map((_, i) => ({ id: i + 1, ok: true, buf: enc("x").buffer, tNetEnd: 100 - (i + 1) * 10 })) });
  await Promise.all(ps);
  const d = c.diag();
  assert.equal(d.deliverMs.n, 10);
  assert.equal(d.deliverMs.p50, 60);
  assert.equal(d.deliverMs.p90, 100);
  assert.equal(d.deliverMs.max, 100);
  assert.equal(d.totalMs.p50, 100);
  c.dispose("test end");
});

await t("C16 ?shardFetchHigh reader: absent/garbage on; off|0|false|no off", async () => {
  for (const s of ["", "?a=1", "?shardFetchHigh", "?shardFetchHigh=on", "?shardFetchHigh=1", "?shardFetchHigh=bogus", "?shardFetchWorker=off"]) {
    assert.equal(shardFetchHighEnabled(s), true, s);
  }
  for (const s of ["?shardFetchHigh=off", "?shardFetchHigh=0", "?shardFetchHigh=false", "?shardFetchHigh=no", "?x=1&shardFetchHigh=OFF"]) {
    assert.equal(shardFetchHighEnabled(s), false, s);
  }
});

await t("C17 urgent lane: 'high' by default, 'auto' under shardFetchHigh=off; normal lane 'low'; end to end", async () => {
  // Client option.
  {
    const { c, w } = clientRig({ urgentPriority: "auto" });
    const a = c.fetchShard("http://h/shards/09/a.bin", "auto", null);
    const b = c.fetchShard("http://h/shards/09/b.bin", "low", null);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(w.posted[0].reqs.map((r) => r.prio), ["auto", "low"], "off: the pre-follow-up hints");
    assert.equal(c.diag().urgentPriority, "auto");
    a.catch(() => {});
    b.catch(() => {});
    c.dispose("test end");
  }
  // install() reads the flag from the query string; the REAL handler fetches with it.
  for (const [search, want] of [["", { priority: "high" }], ["?shardFetchHigh=off", undefined]]) {
    _resetShardFetchForTests();
    const inits = [];
    const factory = inProcWorkerFactory({
      fetchImpl: async (u, init) => {
        inits.push({ u, init });
        return resp(enc(u));
      },
      heartbeatMs: 0,
    });
    const ns = fakeNs();
    const client = installShardFetchWorker({ wasmNs: ns, search, createWorker: factory, baseHref: "http://h/a/index.html", fetchMap: null, log: quietLog });
    assert.ok(client, `armed (${search || "default"})`);
    assert.equal(client.diag().urgentPriority, want ? "high" : "auto");
    await ns.calls[0]("../dist/shards/0a/u.bin", "auto", null);
    await ns.calls[0]("../dist/shards/0a/n.bin", "low", null);
    assert.deepEqual(inits.find((x) => x.u.endsWith("/u.bin")).init, want, `urgent lane (${search || "default"})`);
    assert.deepEqual(inits.find((x) => x.u.endsWith("/n.bin")).init, { priority: "low" }, "normal lane unchanged");
    client.dispose("test end");
  }
  _resetShardFetchForTests();
});

await t("C18 diag: worker lag -> __diag.shardFetch().workerLag; tResp -> __fetchMap r", async () => {
  const { c, w, tm, fm } = clientRig();
  assert.equal(c.diag().workerLag, null, "nothing until a results message");
  const p = c.fetchShard("../../dist/shards/cd/cdef.bin", "auto", null);
  await Promise.resolve();
  tm.advance(40);
  const lag = { probes: 9, max: 212.5, over16: 3, over50: 2, over100: 1 };
  w.emit({ type: "results", to: 1003, lag, res: [{ id: 1, ok: true, buf: enc("y").buffer, tResp: 20, tNetEnd: 30 }] });
  await p;
  const d = c.diag();
  assert.deepEqual(d.workerLag, lag);
  assert.notEqual(d.workerLag, c.stats.workerLag, "diag hands out a copy");
  assert.deepEqual(fm.get("/shards/cd/cdef.bin"), { c: 0, r: 23, h: 33, b: 40 });
  c.dispose("test end");
});

await t("C19 ?shardHashSlice page side: reader parity, forwarded on the batch, =off one-shot, workerHash diag", async () => {
  const pageReader = ShardClientNs.shardHashSliceEnabled;
  assert.equal(typeof pageReader, "function", "shard_fetch_client.js exports shardHashSliceEnabled (the ?shardHashSlice client patch)");
  for (const s of ["", "?shardHashSlice", "?shardHashSlice=on", "?shardHashSlice=bogus", "?shardHashSlice=off", "?shardHashSlice=0", "?shardHashSlice=false", "?shardHashSlice=no", "?x=1&shardHashSlice=OFF"]) {
    assert.equal(pageReader(s), shardHashSliceEnabled(s), `page reader == worker reader (${s})`);
  }
  // Client option -> every batch message carries it.
  {
    const { c, w } = clientRig({ hashSlice: false });
    const a = c.fetchShard("http://h/shards/0c/a.bin", "low", null);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(w.posted[0].hashSlice, false);
    a.catch(() => {});
    c.dispose("test end");
  }
  // install() reads the page query; the REAL handler hashes accordingly.
  const big = lcgBytes(200000, 40); // 4 slices when on
  for (const [search, on] of [["", true], ["?shardHashSlice=off", false]]) {
    _resetShardFetchForTests();
    const batches = [];
    const factory = inProcWorkerFactory({ fetchImpl: async () => resp(big), heartbeatMs: 0, lagProbeMs: 0 });
    const ns = fakeNs();
    const client = installShardFetchWorker({
      wasmNs: ns,
      search,
      createWorker: () => {
        const w = factory();
        const orig = w.postMessage;
        w.postMessage = (m) => {
          batches.push(m);
          orig(m);
        };
        return w;
      },
      baseHref: "http://h/a/index.html",
      fetchMap: null,
      log: quietLog,
    });
    assert.ok(client, `armed (${search || "default"})`);
    const v = await ns.calls[0]("../dist/shards/0c/big.bin", "low", nodeSha(big).slice(0, 32));
    assert.equal(v.verified, true, `verified in the worker (${search || "default"})`);
    assert.equal(batches[0].hashSlice, on, "forwarded on the batch message");
    const hs = factory.made[0].handler.stats;
    assert.equal(hs.hashSlice, on);
    assert.equal(hs.slicedBodies, on ? 1 : 0);
    assert.equal(hs.slices, on ? 4 : 0);
    const d = client.diag();
    assert.ok(d.workerHash, "the worker's slice stats reach the page diag");
    assert.deepEqual([d.workerHash.slice, d.workerHash.slicedBodies, d.workerHash.slices], [on, on ? 1 : 0, on ? 4 : 0]);
    assert.equal(d.hashSlice, on);
    client.dispose("test end");
  }
  _resetShardFetchForTests();
});

// ---------------------------------------------------------------------------
console.log("wiring contract");
// ---------------------------------------------------------------------------

await t("K1 wiring: build-shell entry, literal worker site, import-free worker, index.html install, docs, Rust hook", async () => {
  const rd = (rel) => readFileSync(path.join(HOLT, rel), "utf8");
  const bs = rd("scripts/build-shell.mjs");
  assert.match(bs, /shard_fetch_worker: "scene3d\/shard_fetch_worker\.js"/, "WORKER_ENTRIES has the shard fetch worker");
  const client = rd("apps/holtburger-web/scene3d/shard_fetch_client.js");
  assert.match(
    client,
    /new Worker\(new URL\("\.\/shard_fetch_worker\.js", import\.meta\.url\), \{ type: "module" \}\)/,
    "literal module-worker site (the build-shell scan + placeholder rewrite match exactly this)",
  );
  const worker = rd("apps/holtburger-web/scene3d/shard_fetch_worker.js");
  assert.doesNotMatch(worker, /^\s*import\s|\bfrom\s*["']|\bimport\s*\(/m, "worker is import-free (no wasm, no stamp site)");
  const html = rd("apps/holtburger-web/index.html");
  assert.match(html, /import \{ installShardFetchWorker \} from "\.\/scene3d\/shard_fetch_client\.js";/);
  assert.match(html, /<link rel="modulepreload" href="\.\/scene3d\/shard_fetch_client\.js">/);
  const iInit = html.indexOf("await init_resource_source(MANIFEST_URL);");
  const iInstall = html.indexOf("installShardFetchWorker({ wasmNs: __hbWasmNs })");
  const iBoot = html.indexOf("prefetch_world_bootstrap()");
  assert.ok(iInit > 0 && iInstall > iInit, "installed after init_resource_source");
  assert.ok(iBoot > iInstall, "before the first eager prefetch (prefetch_world_bootstrap)");
  const between = html.slice(iInit, iInstall);
  assert.doesNotMatch(between, /\bawait\b(?! init_resource_source)/, "no await between init and the install");
  const docsPath = process.env.HB_URL_FLAGS_MD || path.join(HOLT, "apps/holtburger-web/docs/url-flags.md");
  const row = readFileSync(docsPath, "utf8").split("\n").find((l) => l.startsWith("| `shardFetchWorker` |"));
  assert.ok(row, "url-flags.md row `| \\`shardFetchWorker\\` |` missing");
  assert.match(row, /`off`\/`0`\/`false`\/`no`/);
  assert.match(row, /\*\*on\*\*/);
  assert.match(row, /scene3d\/shard_fetch_client\.js/);
  const ms = rd("crates/holtburger-resource-http/src/manifest_source.rs");
  assert.match(ms, /Some\(fetch_sem\.acquire\(\)\.await\)[\s\S]{0,900}fetch_shard_bytes\(&u, prio, expected_hex\.as_deref\(\)\)/, "permit held across the routed call");
  assert.match(ms, /format!\("urgent:\{url\}"\)/, "urgent dedup key kept");
  assert.match(ms, /shard_route::needs_main_thread_verify\(/);
  // 2026-10-09 follow-up: latched waiters see the producer's verification.
  assert.match(ms, /shard_inflight: Arc<InflightMap<HttpError, shard_route::SharedShardBody>>/, "the shard map shares body + verified hash");
  assert.match(ms, /let inflight = self\.shard_inflight\.clone\(\);/, "Step D dedups shard bodies in the shard map");
  assert.match(ms, /verified_against: shard_route::verified_against\(\s*body\.verified,\s*sent_hash,\s*\)/, "producer records the hash ITS request sent");
  assert.match(ms, /let fetcher_verified = shard_route::verified_for_task\(\s*task\.expected_trunc\.as_ref\(\),\s*body\.verified_against\.as_ref\(\),\s*\);/, "every waiter compares with its OWN expected hash");
  assert.match(ms, /async move \{ fetch_bytes\(&u\)\.await \}/, "catalog fetches stay direct");
  const http = rd("crates/holtburger-resource-http/src/http.rs");
  assert.match(http, /static SHARD_FETCHER: RefCell<Option<Function>>/);
  assert.match(http, /pub async fn fetch_shard_bytes\(/);
  const lib = rd("apps/holtburger-web/src/lib.rs");
  assert.match(lib, /#\[wasm_bindgen\]\npub fn register_shard_fetcher\(f: JsValue\) -> bool \{/);
});

await t("K2 ?shardHashSlice wiring: page reader + batch forward + install, worker reader + override, docs row", async () => {
  const rd = (rel) => readFileSync(path.join(HOLT, rel), "utf8");
  const worker = rd("apps/holtburger-web/scene3d/shard_fetch_worker.js");
  assert.match(worker, /new URLSearchParams\(search \|\| ""\)\.get\("shardHashSlice"\)/, "worker reader");
  assert.match(worker, /hashSlice: shardHashSliceEnabled\(\(self\.location && self\.location\.search\) \|\| ""\)/, "worker bootstrap reads its own URL");
  assert.match(worker, /if \(typeof msg\.hashSlice === "boolean"\) stats\.hashSlice = msg\.hashSlice;/, "a batch's flag wins");
  const client = rd("apps/holtburger-web/scene3d/shard_fetch_client.js");
  assert.match(client, /new URLSearchParams\(s\)\.get\("shardHashSlice"\)/, "page reader (client patch)");
  assert.match(client, /this\._worker\.postMessage\(\{ type: "batch", reqs, hashSlice: this\._hashSlice \}\)/, "forwarded on every batch (client patch)");
  assert.match(client, /hashSlice: shardHashSliceEnabled\(opts\.search\)/, "install reads the page query (client patch)");
  const docsPath = process.env.HB_URL_FLAGS_MD || path.join(HOLT, "apps/holtburger-web/docs/url-flags.md");
  const row = readFileSync(docsPath, "utf8").split("\n").find((l) => l.startsWith("| `shardHashSlice` |"));
  assert.ok(row, "url-flags.md row `| \\`shardHashSlice\\` |` missing");
  assert.match(row, /`off`\/`0`\/`false`\/`no`/);
  assert.match(row, /\*\*on\*\*/);
  assert.match(row, /scene3d\/shard_fetch_worker\.js/);
  assert.match(row, /scene3d\/shard_fetch_client\.js/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
