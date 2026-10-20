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
// 2026-10-20 (improvement hunt boot-cache-1): the SWR background refresh is
// conditional. Before, every hit on /scene3d/assets/ ran `fetch(event.request)`
// + `cache.put`, which re-transferred the ~79 MB terrain BC7 tier set
// (serve.py sent it no-store) on every warm boot and rewrote it into Cache
// Storage:
//   S1  an entry with Last-Modified: refresh carries If-Modified-Since and cache:'no-store';
//       the origin's 304 is NOT put (entry, bytes and put count unchanged); .hbc7 + .png alike
//   S2  a changed asset: the 200 is put, and the next refresh sends the NEW validator
//   S3  validator choice: Last-Modified wins (never both: serve.py ignores IMS when
//       If-None-Match is present); ETag-only -> If-None-Match, and its 304 is not put
//   S4  an entry with no validator keeps the old unconditional fetch(event.request)
//   S5  a failed refresh (404) never touches the entry
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
  const meta = new Map(); // url -> { lastModified?, etag? } (the S* validator cases)
  const hits = new Map();
  const modes = [];
  return {
    modes,
    /** `validators` = { lastModified, etag }: sent on 200s, honoured as a 304. */
    set(p, body, validators) {
      const u = new URL(p, BASE).href;
      files.set(u, body);
      if (validators) meta.set(u, validators); else meta.delete(u);
    },
    unset(p) { const u = new URL(p, BASE).href; files.delete(u); meta.delete(u); },
    hitCount(p) { return hits.get(new URL(p, BASE).href) ?? 0; },
    resetHits() { hits.clear(); modes.length = 0; },
    async fetch(input, init) {
      const viaRequest = typeof input !== "string";
      const url = viaRequest ? input.url : new URL(input, SW_URL).href;
      hits.set(url, (hits.get(url) ?? 0) + 1);
      const hdrs = new Headers((init && init.headers) || (viaRequest ? input.headers : undefined));
      const rec = {
        url,
        cache: (init && init.cache) || (viaRequest ? input.cache : "default"),
        viaRequest,
        ims: hdrs.get("if-modified-since"),
        inm: hdrs.get("if-none-match"),
        status: 0,
      };
      modes.push(rec);
      const body = files.get(url);
      if (body === undefined) { rec.status = 404; return mkRes("not found", 404); }
      // Validators, the way serve.py answers: If-None-Match (when present)
      // decides alone; else If-Modified-Since against Last-Modified.
      const v = meta.get(url);
      const headers = {};
      if (v && v.lastModified) headers["last-modified"] = v.lastModified;
      if (v && v.etag) headers.etag = v.etag;
      const notModified = v && (rec.inm != null
        ? (v.etag != null && rec.inm === v.etag)
        : (rec.ims != null && v.lastModified != null && Date.parse(v.lastModified) <= Date.parse(rec.ims)));
      if (notModified) { rec.status = 304; return mkRes(null, 304, headers); }
      rec.status = 200;
      return mkRes(typeof body === "function" ? body() : body, 200, headers);
    },
  };
}

function mkRes(body, status = 200, headers = undefined) {
  const r = new Response(body, { status, headers });
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
    // Store the bytes (a real Cache reads the body to completion on put) and
    // the headers (a real Cache keeps them; the S* cases read Last-Modified).
    const buf = await res.arrayBuffer();
    this.puts += 1;
    this.m.set(keyOf(req), new Response(buf, { status: res.status, headers: res.headers }));
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

// ── SWR conditional refresh (2026-10-20, boot-cache-1) ─────────────────────
const APP = `${ORIGIN}/apps/holtburger-web/`;
const HBC7 = `${APP}scene3d/assets/terrain_bc7/t1024/0x06006D06_color.hbc7`;
const MACRO_PNG = `${APP}scene3d/assets/terrain_macro/m.png`;
const LM1 = "Tue, 20 Oct 2026 10:00:00 GMT";
const LM2 = "Tue, 20 Oct 2026 11:30:00 GMT";
const last = (sw) => sw.origin.modes[sw.origin.modes.length - 1];

await t("S1 Last-Modified entry: refresh is If-Modified-Since + no-store, and its 304 is NOT put", async () => {
  for (const [asset, bytes] of [[HBC7, "HBC7-T1024-BYTES"], [MACRO_PNG, "MACRO-PNG-BYTES"]]) {
    const sw = loadSw();
    const cache = await sw.cache();
    sw.origin.set(asset, bytes, { lastModified: LM1 });
    // Cold boot: a miss goes to the network and is put WITH its headers.
    eq(await bodyOf(await sw.get(asset)), bytes, "cold: network bytes");
    await sw.settle();
    eq(cache.puts, 1, "cold: put once");
    sw.origin.resetHits();
    // Warm boot: cached bytes now, one conditional background refresh.
    const res = await sw.get(asset);
    eq(await bodyOf(res), bytes, "warm: served from Cache Storage");
    eq(res.headers.get("last-modified"), LM1, "the cached entry kept its validator");
    await sw.settle();
    eq(sw.origin.hitCount(asset), 1, "exactly one background refresh");
    const m = last(sw);
    eq(m.viaRequest, false, "a fresh request, not event.request");
    eq(m.ims, LM1, "If-Modified-Since = the cached Last-Modified");
    eq(m.inm, null, "no If-None-Match");
    eq(m.cache, "no-store", "past the HTTP cache, so the 304 reaches the SW");
    eq(m.status, 304, "the origin answered 304");
    eq(cache.puts, 1, "304 -> no put (no Cache Storage rewrite)");
    eq(await cache.text(asset), bytes, "entry unchanged");
    // And again: every warm boot costs one 304, never a body.
    await bodyOf(await sw.get(asset));
    await sw.settle();
    eq(cache.puts, 1, "a second warm boot still puts nothing");
  }
});

await t("S2 a changed asset: the 200 is put, and the next refresh sends the NEW validator", async () => {
  const sw = loadSw();
  const cache = await sw.cache();
  sw.origin.set(HBC7, "TIER-V1", { lastModified: LM1 });
  await bodyOf(await sw.get(HBC7));
  await sw.settle();
  sw.origin.set(HBC7, "TIER-V2-REDERIVED", { lastModified: LM2 });
  eq(await bodyOf(await sw.get(HBC7)), "TIER-V1", "stale served now");
  await sw.settle();
  eq(last(sw).ims, LM1, "asked with the old validator");
  eq(last(sw).status, 200, "the origin sent the new body");
  eq(cache.puts, 2, "the changed body was put");
  eq(await cache.text(HBC7), "TIER-V2-REDERIVED", "for the next load");
  const res = await sw.get(HBC7);
  eq(await bodyOf(res), "TIER-V2-REDERIVED", "next load serves the new bytes");
  eq(res.headers.get("last-modified"), LM2, "with the new validator");
  await sw.settle();
  eq(last(sw).ims, LM2, "the following refresh sends the NEW validator");
  eq(last(sw).status, 304);
  eq(cache.puts, 2, "and its 304 puts nothing");
});

await t("S3 validator choice: Last-Modified wins, never both; ETag-only -> If-None-Match", async () => {
  const { hooks } = loadSw();
  const pick = (headers) => JSON.stringify(hooks.swrConditionalHeaders(new Response("x", { headers })));
  eq(pick({ "last-modified": LM1 }), JSON.stringify({ "If-Modified-Since": LM1 }), "Last-Modified only");
  eq(pick({ "last-modified": LM1, etag: '"abc"' }), JSON.stringify({ "If-Modified-Since": LM1 }),
    "both: IMS alone (serve.py ignores IMS whenever If-None-Match is present)");
  eq(pick({ etag: '"abc"' }), JSON.stringify({ "If-None-Match": '"abc"' }), "ETag only");
  eq(hooks.swrConditionalHeaders(new Response("x")), null, "no validator");
  eq(hooks.swrConditionalHeaders(null), null, "no entry");

  const sw = loadSw();
  const cache = await sw.cache();
  await cache.put(new Request(HBC7), new Response("ETAG-ENTRY", { headers: { etag: 'W/"t1"' } }));
  const putsBefore = cache.puts;
  sw.origin.set(HBC7, "ETAG-ENTRY", { etag: 'W/"t1"' });
  eq(await bodyOf(await sw.get(HBC7)), "ETAG-ENTRY");
  await sw.settle();
  eq(last(sw).inm, 'W/"t1"', "If-None-Match = the cached ETag");
  eq(last(sw).ims, null, "no If-Modified-Since");
  eq(last(sw).status, 304);
  eq(cache.puts, putsBefore, "ETag 304 -> no put");
});

await t("S4 an entry with no validator keeps the old unconditional fetch(event.request)", async () => {
  const sw = loadSw();
  const cache = await sw.cache();
  await cache.put(new Request(HBC7), new Response("LEGACY-NO-HEADERS"));
  const putsBefore = cache.puts;
  sw.origin.set(HBC7, "FRESH", { lastModified: LM1 });
  eq(await bodyOf(await sw.get(HBC7)), "LEGACY-NO-HEADERS", "stale served now");
  await sw.settle();
  const m = last(sw);
  eq(m.viaRequest, true, "the page's own request object, as before");
  eq(m.ims, null, "no If-Modified-Since");
  eq(m.inm, null, "no If-None-Match");
  eq(m.cache, "default", "the request's own cache mode, as before");
  eq(cache.puts, putsBefore + 1, "the 200 is put");
  eq(await cache.text(HBC7), "FRESH");
});

await t("S5 a failed refresh (404) never touches the entry", async () => {
  const sw = loadSw();
  const cache = await sw.cache();
  sw.origin.set(HBC7, "KEEP-ME", { lastModified: LM1 });
  await bodyOf(await sw.get(HBC7));
  await sw.settle();
  sw.origin.unset(HBC7);
  eq(await bodyOf(await sw.get(HBC7)), "KEEP-ME");
  await sw.settle();
  eq(last(sw).status, 404);
  eq(cache.puts, 1, "no put");
  eq(await cache.text(HBC7), "KEEP-ME", "entry intact");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
