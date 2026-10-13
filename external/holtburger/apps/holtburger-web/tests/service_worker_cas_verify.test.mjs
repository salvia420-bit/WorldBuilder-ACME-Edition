// tests/service_worker_cas_verify.test.mjs — service-worker.js CAS
// verify-before-persist + cache-bypass (WebAC comparison streaming-residency-4,
// 2026-10-13).
//
// The bug: the SW `cache.put` every 200 for a content-addressed path
// (`shards/{sha256_prefix2}/{sha256}.bin`, and under SW_V3 `packs/…` +
// `index/…`) WITHOUT checking it, then answered every later request from
// Cache Storage whatever `request.cache` said. The consumers sha-verify every
// body and fail a mismatched key, so one bad body cached under a sha-named
// path failed that key on every retry, in this session and all later ones —
// and the pack lane's designed `cache: "reload"` mismatch retry (D-03.5) would
// be answered from Cache Storage once SW_V3 flips.
//
// Loads the REAL service-worker.js into a vm sandbox with a fake Cache Storage,
// a fake origin and Node's WebCrypto, and asserts:
//   P1  casHashFromPath: shard / pack / index names parse (lowercased); other names -> null
//   P2  cacheBypassRequested: reload / no-store only
//   V1  a /shards/ 200 whose sha256 prefix does NOT match its name reaches the page but is NOT put
//   V2  a matching one is put (after the page already has its response) and served cache-first after
//   V3  cache:'reload' bypasses an existing (bad, legacy) entry, goes to the network WITH reload
//       (past the HTTP cache), and a verified 200 replaces the entry; no-store bypasses too
//   V4  a reload whose network body still mismatches leaves the old entry alone (never a bad put)
//   V5  SW_V3=true: the same for /packs/ and /index/; SW_V3=false: /packs/ not intercepted
//   V6  a non-parseable CAS name keeps the old unverified put
//   V7  no digest engine (sandbox without crypto) keeps the old put
//   V8  a body that cannot be read in full is never put
//   V9  non-CAS classes unchanged: SWR assets ignore reload (cache-first), catalogs put unverified
//
// Run: node tests/service_worker_cas_verify.test.mjs

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SW_PATH = path.join(HERE, "..", "service-worker.js");
const ORIGIN = "https://holt.test";
const SW_URL = `${ORIGIN}/apps/holtburger-web/service-worker.js`;
const BASE = `${ORIGIN}/dist/`;

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
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || "expected equal"}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

const enc = (s) => new TextEncoder().encode(s);
const sha32 = (s) => createHash("sha256").update(enc(s)).digest("hex").slice(0, 32);
const shardPath = (hash) => `shards/${hash.slice(0, 2)}/${hash}.bin`;

// ── fake origin ────────────────────────────────────────────────────────────
function makeOrigin() {
  const files = new Map();
  const hits = new Map();
  const modes = [];
  return {
    modes,
    set(p, body) { files.set(new URL(p, BASE).href, body); },
    hitCount(p) { return hits.get(new URL(p, BASE).href) ?? 0; },
    resetHits() { hits.clear(); modes.length = 0; },
    async fetch(input, init) {
      const url = typeof input === "string" ? new URL(input, SW_URL).href : input.url;
      hits.set(url, (hits.get(url) ?? 0) + 1);
      modes.push({ url, cache: (init && init.cache) || (typeof input === "string" ? "default" : input.cache) });
      const body = files.get(url);
      if (body === undefined) return mkRes("not found", 404);
      return mkRes(typeof body === "function" ? body() : body, 200);
    },
  };
}

function mkRes(body, status = 200) {
  const r = new Response(body, { status });
  // Cache Storage only stores same-origin ("basic") responses; undici
  // defaults to "default", so force the field the SW gates on.
  Object.defineProperty(r, "type", { value: "basic", configurable: true });
  return r;
}

// ── fake Cache Storage ─────────────────────────────────────────────────────
const keyOf = (req) => (typeof req === "string" ? new URL(req, SW_URL).href : req.url);

class FakeCache {
  constructor() { this.m = new Map(); this.puts = 0; }
  async match(req) { const v = this.m.get(keyOf(req)); return v ? v.clone() : undefined; }
  async put(req, res) {
    // Store the bytes (a real Cache reads the body to completion on put).
    const buf = await res.arrayBuffer();
    this.puts += 1;
    this.m.set(keyOf(req), new Response(buf, { status: res.status }));
  }
  async delete(req) { return this.m.delete(keyOf(req)); }
  async keys() { return [...this.m.keys()].map((u) => new Request(u)); }
  async text(p) { const v = this.m.get(new URL(p, BASE).href); return v ? await v.clone().text() : null; }
}

function makeCaches() {
  const store = new Map();
  return {
    store,
    async open(name) {
      if (!store.has(name)) store.set(name, new FakeCache());
      return store.get(name);
    },
    async keys() { return [...store.keys()]; },
    async delete(name) { return store.delete(name); },
  };
}

// ── load the SW into a sandbox ─────────────────────────────────────────────
function loadSw({ v3 = false, withCrypto = true } = {}) {
  let src = readFileSync(SW_PATH, "utf8");
  if (v3) {
    const flipped = src.replace("const SW_V3 = false;", "const SW_V3 = true;");
    assert(flipped !== src, "SW_V3 flip edit applies");
    src = flipped;
  }
  const origin = makeOrigin();
  const listeners = new Map();
  const warns = [];
  const self = {
    location: { href: SW_URL },
    addEventListener: (type, fn) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  const cachesObj = makeCaches();
  class ScopedRequest extends Request {
    constructor(input, init) {
      super(typeof input === "string" ? new URL(input, SW_URL).href : input, init);
    }
  }
  const quietConsole = {
    log: () => {},
    error: () => {},
    warn: (...a) => warns.push(a.map(String).join(" ")),
  };
  const sandbox = {
    self, caches: cachesObj,
    fetch: (input, init) => origin.fetch(input, init),
    Request: ScopedRequest, Response, URL, Date, Promise, console: quietConsole,
  };
  if (withCrypto) sandbox.crypto = globalThis.crypto;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: SW_PATH });

  const waits = [];
  const fire = async (type, event) => {
    const fn = listeners.get(type);
    if (!fn) return undefined;
    let responded;
    const ev = {
      ...event,
      waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      respondWith: (p) => { responded = p; },
    };
    fn(ev);
    return responded ? await responded : undefined;
  };
  return {
    origin,
    warns,
    hooks: self.__swTestHooks,
    pendingWaits: () => waits.length,
    cache: () => cachesObj.open(self.__swTestHooks.CONTENT_CACHE),
    /** A GET for `p` (relative to /dist/) with an optional request cache mode. */
    get: async (p, cacheMode) => {
      const url = new URL(p, BASE).href;
      const request = cacheMode ? new Request(url, { cache: cacheMode }) : new Request(url);
      return await fire("fetch", { request });
    },
    settle: async () => {
      while (waits.length) await Promise.all(waits.splice(0));
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

const bodyOf = async (res) => (res ? await res.text() : "(no response — SW did not intercept)");

// ── predicates ─────────────────────────────────────────────────────────────
console.log("service-worker.js — CAS verify-before-persist");

await t("P1 casHashFromPath: shard / pack / index names parse; other names -> null", async () => {
  const { hooks } = loadSw();
  const h = "0123456789abcdef0123456789abcdef";
  eq(hooks.casHashFromPath(`/dist/shards/01/${h}.bin`), h, "shard");
  eq(hooks.casHashFromPath(`/dist/shards/01/${h.toUpperCase()}.bin`), h, "uppercase lowercased");
  eq(hooks.casHashFromPath(`/dist/packs/01/${h}.hbp`), h, "pack");
  eq(hooks.casHashFromPath(`/dist/index/${h}.bin`), h, "index");
  const full = h + h;
  eq(hooks.casHashFromPath(`/dist/shards/01/${full}.bin`), full, "a full 64-hex name parses too");
  eq(hooks.casHashFromPath("/dist/shards/ab/abcdef.bin"), null, "short name");
  eq(hooks.casHashFromPath("/dist/shards/eor-portal/0x01000001.bin"), null, "convention-URL mode");
  eq(hooks.casHashFromPath(`/dist/shards/01/${h}.txt`), null, "unknown extension");
  eq(hooks.casHashFromPath(`/dist/manifest/${h}.bin`), null, "not a CAS directory");
  eq(hooks.casHashFromPath("/apps/holtburger-web/index.html"), null, "index.html");
});

await t("P2 cacheBypassRequested: reload / no-store only", async () => {
  const { hooks } = loadSw();
  const u = `${BASE}shards/ab/x.bin`;
  eq(hooks.cacheBypassRequested(new Request(u, { cache: "reload" })), true, "reload");
  eq(hooks.cacheBypassRequested(new Request(u, { cache: "no-store" })), true, "no-store");
  for (const mode of ["default", "no-cache", "force-cache"]) {
    eq(hooks.cacheBypassRequested(new Request(u, { cache: mode })), false, mode);
  }
  eq(hooks.cacheBypassRequested(null), false, "null request");
});

// ── verify before persisting ───────────────────────────────────────────────
await t("V1 a mismatching /shards/ body reaches the page but is NOT cached", async () => {
  const sw = loadSw();
  const p = shardPath(sha32("GOOD"));
  sw.origin.set(p, "TRUNCATED-OR-ERROR-PAGE");
  const r1 = await bodyOf(await sw.get(p));
  eq(r1, "TRUNCATED-OR-ERROR-PAGE", "the page still gets the response (its own verify fails the key)");
  await sw.settle();
  const cache = await sw.cache();
  eq(cache.puts, 0, "never put");
  eq(await cache.text(p), null, "no entry");
  assert(sw.warns.some((w) => w.includes("content hash mismatch")), "mismatch is logged");
  sw.origin.resetHits();
  await bodyOf(await sw.get(p));
  eq(sw.origin.hitCount(p), 1, "the next request goes to the network again");
});

await t("V2 a matching /shards/ body is put after the page has it, then served cache-first", async () => {
  const sw = loadSw();
  const p = shardPath(sha32("SHARD-BYTES"));
  sw.origin.set(p, "SHARD-BYTES");
  const res = await sw.get(p);
  assert(sw.pendingWaits() > 0, "hash + put run under waitUntil");
  eq(await bodyOf(res), "SHARD-BYTES", "the page reads the network response");
  await sw.settle();
  const cache = await sw.cache();
  eq(cache.puts, 1, "put once");
  eq(await cache.text(p), "SHARD-BYTES");
  sw.origin.resetHits();
  eq(await bodyOf(await sw.get(p)), "SHARD-BYTES");
  eq(sw.origin.hitCount(p), 0, "cache-first: no network");
});

// ── cache-bypass requests ──────────────────────────────────────────────────
await t("V3 cache:'reload' bypasses a bad cached entry, fetches WITH reload, and a verified 200 replaces it", async () => {
  const sw = loadSw();
  const p = shardPath(sha32("REAL"));
  const cache = await sw.cache();
  // A bad entry cached before verify-before-persist existed.
  await cache.put(new Request(new URL(p, BASE).href), new Response("CORRUPT"));
  sw.origin.set(p, "REAL");
  eq(await bodyOf(await sw.get(p)), "CORRUPT", "the stuck state: a default request is cache-first");
  eq(sw.origin.hitCount(p), 0);
  const r = await bodyOf(await sw.get(p, "reload"));
  eq(r, "REAL", "reload goes to the network");
  eq(sw.origin.hitCount(p), 1);
  eq(sw.origin.modes[sw.origin.modes.length - 1].cache, "reload", "the network fetch carries reload (past the HTTP cache)");
  await sw.settle();
  eq(await cache.text(p), "REAL", "verified 200 overwrote the entry");
  sw.origin.resetHits();
  eq(await bodyOf(await sw.get(p)), "REAL", "healed: later default requests are served the good bytes");
  eq(sw.origin.hitCount(p), 0, "from cache");

  // no-store bypasses the same way.
  const q = shardPath(sha32("REAL-2"));
  await cache.put(new Request(new URL(q, BASE).href), new Response("CORRUPT-2"));
  sw.origin.set(q, "REAL-2");
  eq(await bodyOf(await sw.get(q, "no-store")), "REAL-2", "no-store goes to the network");
  await sw.settle();
  eq(await cache.text(q), "REAL-2", "and replaces the entry on a verified 200");
});

await t("V4 a reload whose network body still mismatches never overwrites the entry", async () => {
  const sw = loadSw();
  const p = shardPath(sha32("REAL"));
  const cache = await sw.cache();
  await cache.put(new Request(new URL(p, BASE).href), new Response("OLD-ENTRY"));
  const putsBefore = cache.puts;
  sw.origin.set(p, "STILL-BAD");
  eq(await bodyOf(await sw.get(p, "reload")), "STILL-BAD", "the page sees what the network sent");
  await sw.settle();
  eq(cache.puts, putsBefore, "no put");
  eq(await cache.text(p), "OLD-ENTRY", "entry untouched");
});

// ── SW_V3 CAS classes ──────────────────────────────────────────────────────
await t("V5 SW_V3=true: /packs/ and /index/ verify before persisting and honour reload", async () => {
  const sw = loadSw({ v3: true });
  eq(sw.hooks.SW_V3, true);
  const packHash = sha32("PACK-BYTES");
  const pack = `packs/${packHash.slice(0, 2)}/${packHash}.hbp`;
  const index = `index/${sha32("INDEX-BYTES")}.bin`;
  const cache = await sw.cache();

  sw.origin.set(pack, "PACK-TRUNC");
  eq(await bodyOf(await sw.get(pack)), "PACK-TRUNC");
  await sw.settle();
  eq(await cache.text(pack), null, "mismatching pack not cached");

  sw.origin.set(pack, "PACK-BYTES");
  // The pack lane's D-03.5 retry: one cache:"reload" fetch.
  eq(await bodyOf(await sw.get(pack, "reload")), "PACK-BYTES");
  await sw.settle();
  eq(await cache.text(pack), "PACK-BYTES", "matching pack cached");

  await cache.put(new Request(new URL(index, BASE).href), new Response("INDEX-CORRUPT"));
  sw.origin.set(index, "INDEX-BYTES");
  eq(await bodyOf(await sw.get(index)), "INDEX-CORRUPT", "default request: cache-first");
  sw.origin.resetHits();
  eq(await bodyOf(await sw.get(index, "reload")), "INDEX-BYTES", "the reload retry is NOT answered from Cache Storage");
  eq(sw.origin.hitCount(index), 1);
  await sw.settle();
  eq(await cache.text(index), "INDEX-BYTES", "replaced on a verified 200");

  sw.origin.set(index, "INDEX-TRUNC");
  await bodyOf(await sw.get(index, "reload"));
  await sw.settle();
  eq(await cache.text(index), "INDEX-BYTES", "a mismatching reload never overwrites");

  const v2 = loadSw();
  v2.origin.set(pack, "PACK-BYTES");
  eq(await v2.get(pack), undefined, "SW_V3=false: packs are not intercepted at all (dormant)");
});

// ── fall-backs keep the old put ────────────────────────────────────────────
await t("V6 a non-parseable CAS name keeps the old unverified put", async () => {
  const sw = loadSw();
  sw.origin.set("shards/ab/abcdef.bin", "SHARD-1");
  eq(await bodyOf(await sw.get("shards/ab/abcdef.bin")), "SHARD-1");
  await sw.settle();
  const cache = await sw.cache();
  eq(await cache.text("shards/ab/abcdef.bin"), "SHARD-1", "put without a hash check");
  sw.origin.resetHits();
  await bodyOf(await sw.get("shards/ab/abcdef.bin"));
  eq(sw.origin.hitCount("shards/ab/abcdef.bin"), 0, "cache-first as before");
});

await t("V7 no digest engine keeps the old put", async () => {
  const sw = loadSw({ withCrypto: false });
  const p = shardPath(sha32("GOOD"));
  sw.origin.set(p, "UNVERIFIABLE");
  await bodyOf(await sw.get(p));
  await sw.settle();
  const cache = await sw.cache();
  eq(await cache.text(p), "UNVERIFIABLE", "cannot hash -> today's behaviour");
});

await t("V8 a body that cannot be read in full is never put", async () => {
  const sw = loadSw();
  const p = shardPath(sha32("GOOD"));
  sw.origin.set(p, () => new ReadableStream({ pull(c) { c.error(new Error("connection reset")); } }));
  const res = await sw.get(p);
  let threw = false;
  try { await res.arrayBuffer(); } catch (_) { threw = true; }
  assert(threw, "the page sees the broken body");
  await sw.settle();
  const cache = await sw.cache();
  eq(cache.puts, 0, "never put");
  eq(await cache.text(p), null);
});

await t("V9 non-CAS classes unchanged: SWR ignores reload; catalogs put unverified", async () => {
  const sw = loadSw();
  const asset = `${ORIGIN}/apps/holtburger-web/scene3d/assets/terrain_macro/m.png`;
  const cache = await sw.cache();
  await cache.put(new Request(asset), new Response("OLD-ART"));
  sw.origin.set(asset, "NEW-ART");
  eq(await bodyOf(await sw.get(asset, "reload")), "OLD-ART", "SWR: stale served now, whatever the request mode");
  await sw.settle();
  eq(await cache.text(asset), "NEW-ART", "background refresh as before");

  sw.origin.set("manifest.json", JSON.stringify({ boot_pack: { sha256: "AAA" }, catalog_version: 1, generated_at: "x" }));
  sw.origin.set("manifest/eor-portal.bin", "CATALOG-A");
  eq(await bodyOf(await sw.get("manifest/eor-portal.bin")), "CATALOG-A");
  await sw.settle();
  eq(await cache.text("manifest/eor-portal.bin"), "CATALOG-A", "bake-versioned put has no hash check");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
