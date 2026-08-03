// test_service_worker_bake_gate.mjs — the cache-key invariant for
// service-worker.js (2026-08-03 review finding F1, task #145).
//
// The bug: `boot.hba` and `manifest/<ns>.bin` keep the SAME URL across
// bakes and change their BYTES, but were served cache-first. After a
// re-bake a returning client got the PREVIOUS bake's boot pack, which the
// wasm then hard-rejects against the fresh manifest
// (`crates/holtburger-resource-http/src/manifest_source.rs:497-503`,
// "boot.hba hash mismatch") — an unbootable client until `?nosw=1`.
//
// This suite loads the real service-worker.js into a sandbox with a fake
// Cache Storage + a fake origin, then re-bakes the origin underneath it.
//
// Run: node test_service_worker_bake_gate.mjs
//      node test_service_worker_bake_gate.mjs --sw <path>   (A/B a baseline)

import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";

const ORIGIN = "https://holt.test";
const SW_URL = `${ORIGIN}/apps/holtburger-web/service-worker.js`;
const BASE = `${ORIGIN}/dist/`;

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass += 1; console.log(`  [OK] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ""}`); }
};

// ── fake origin ────────────────────────────────────────────────────────────
function makeOrigin() {
  const files = new Map();
  const hits = new Map();
  return {
    files, hits,
    set(p, body) { files.set(new URL(p, BASE).href, body); },
    hitCount(p) { return hits.get(new URL(p, BASE).href) ?? 0; },
    resetHits() { hits.clear(); },
    async fetch(input) {
      const url = typeof input === "string" ? new URL(input, SW_URL).href : input.url;
      hits.set(url, (hits.get(url) ?? 0) + 1);
      const body = files.get(url);
      if (body === undefined) return mkRes("not found", 404);
      return mkRes(body, 200);
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
  constructor() { this.m = new Map(); }
  async match(req) { const v = this.m.get(keyOf(req)); return v ? v.clone() : undefined; }
  async put(req, res) { this.m.set(keyOf(req), res); }
  async delete(req) { return this.m.delete(keyOf(req)); }
  async keys() { return [...this.m.keys()].map((u) => new Request(u)); }
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
function loadSw(swPath, origin) {
  const listeners = new Map();
  const self = {
    location: { href: SW_URL },
    addEventListener: (t, fn) => listeners.set(t, fn),
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  const cachesObj = makeCaches();
  // In a real SW a relative Request resolves against the worker's scope;
  // undici requires an absolute URL, so resolve it the way the browser does.
  class ScopedRequest extends Request {
    constructor(input, init) {
      super(typeof input === "string" ? new URL(input, SW_URL).href : input, init);
    }
  }
  const sandbox = {
    self, caches: cachesObj,
    fetch: (input, init) => origin.fetch(input, init),
    Request: ScopedRequest, Response, URL, Date, Promise, console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(swPath, "utf8"), sandbox, { filename: swPath });

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
    caches: cachesObj,
    install: async () => { await fire("install", {}); await Promise.all(waits.splice(0)); },
    get: async (p) => {
      const url = new URL(p, BASE).href;
      return await fire("fetch", { request: new Request(url), method: "GET" });
    },
    settle: async () => { await Promise.all(waits.splice(0)); await new Promise((r) => setTimeout(r, 0)); },
  };
}

const bodyOf = async (res) => (res ? await res.text() : "(no response — SW did not intercept)");

// ── the scenario ───────────────────────────────────────────────────────────
async function scenario(swPath, label) {
  console.log(`\n=== ${label} (${path.basename(swPath)}) ===`);
  const origin = makeOrigin();
  // Bake A
  origin.set("manifest.json", JSON.stringify({
    version: 2, generated_at: "2026-08-01T00:00:00Z", catalog_version: 1,
    boot_pack: { url: "boot.hba", size: 10, sha256: "AAA" },
    shard_url_template: "shards/{sha256_prefix2}/{sha256}.bin",
    catalog_url_template: "manifest/{namespace_slug}.bin",
  }));
  origin.set("boot.hba", "BOOT-BAKE-A");
  origin.set("manifest/eor-portal.bin", "CATALOG-A");
  origin.set("shards/ab/abcdef.bin", "SHARD-1");

  const sw = loadSw(swPath, origin);
  await sw.install();

  const r1 = await bodyOf(await sw.get("boot.hba"));
  check("bake A: first boot.hba fetch serves bake A", r1 === "BOOT-BAKE-A", `got ${r1}`);
  const c1 = await bodyOf(await sw.get("manifest/eor-portal.bin"));
  check("bake A: catalog serves bake A", c1 === "CATALOG-A", `got ${c1}`);

  // Caching still works: a repeat read must NOT re-hit the network.
  origin.resetHits();
  const r2 = await bodyOf(await sw.get("boot.hba"));
  await sw.settle();
  check("bake A: repeat read still served from cache (perf preserved)",
    r2 === "BOOT-BAKE-A" && origin.hitCount("boot.hba") === 0,
    `body=${r2} bootHits=${origin.hitCount("boot.hba")}`);

  // Shards stay cache-first (content-addressed).
  await sw.get("shards/ab/abcdef.bin");
  origin.resetHits();
  const s2 = await bodyOf(await sw.get("shards/ab/abcdef.bin"));
  check("shards stay cache-first with zero manifest reads",
    s2 === "SHARD-1" && origin.hitCount("shards/ab/abcdef.bin") === 0 &&
    origin.hitCount("manifest.json") === 0,
    `body=${s2} manifestHits=${origin.hitCount("manifest.json")}`);

  // ── THE RE-BAKE ──────────────────────────────────────────────────────────
  origin.set("manifest.json", JSON.stringify({
    version: 2, generated_at: "2026-08-03T12:00:00Z", catalog_version: 2,
    boot_pack: { url: "boot.hba", size: 10, sha256: "BBB" },
    shard_url_template: "shards/{sha256_prefix2}/{sha256}.bin",
    catalog_url_template: "manifest/{namespace_slug}.bin",
  }));
  origin.set("boot.hba", "BOOT-BAKE-B");
  origin.set("manifest/eor-portal.bin", "CATALOG-B");

  const r3 = await bodyOf(await sw.get("boot.hba"));
  check("RE-BAKE: boot.hba serves the NEW bake (not the cached old one)",
    r3 === "BOOT-BAKE-B", `got ${r3} — a stale boot pack is the "boot.hba hash mismatch" brick`);
  const c3 = await bodyOf(await sw.get("manifest/eor-portal.bin"));
  check("RE-BAKE: catalog serves the NEW bake",
    c3 === "CATALOG-B", `got ${c3} — a stale catalog indexes shards that 404 ("0 placements")`);

  // And the new bake is itself cached (the gate must not disable caching).
  origin.resetHits();
  const r4 = await bodyOf(await sw.get("boot.hba"));
  await sw.settle();
  check("post-re-bake: new bytes are cached again",
    r4 === "BOOT-BAKE-B" && origin.hitCount("boot.hba") === 0,
    `body=${r4} bootHits=${origin.hitCount("boot.hba")}`);

  // Fail-safe: manifest unreachable ⇒ never serve an unverified cached copy
  // while the network is healthy.
  origin.files.delete(new URL("manifest.json", BASE).href);
  origin.set("boot.hba", "BOOT-BAKE-C");
  const r5 = await bodyOf(await sw.get("boot.hba"));
  check("fail-safe: unknown bake id ⇒ network-first, not stale cache",
    r5 === "BOOT-BAKE-C", `got ${r5}`);

  return { pass, fail };
}

const argIdx = process.argv.indexOf("--sw");
const swPath = argIdx >= 0
  ? path.resolve(process.argv[argIdx + 1])
  : path.resolve(new URL(".", import.meta.url).pathname, "service-worker.js");

await scenario(swPath, argIdx >= 0 ? "A/B target" : "shipped service-worker.js");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 1 - 1 : 1);
