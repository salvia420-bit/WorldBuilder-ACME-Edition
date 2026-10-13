// tests/shard_budget_soft_cap.test.mjs — streaming-residency-2 host plumbing.
//
// The shard-record cache (`crates/holtburger-resource-http/src/shard_cache.rs`)
// gained a soft cap: a record read or landed less than `min_age_ms` ago is
// never evicted, and an over-budget pass trims to 85% of the budget in one
// batch. The eviction policy itself is pinned by the native Rust tests next to
// `ShardCache`; this pins the HOST half:
//
//   S1  `?shardMinAgeS` grammar (seconds; `0`/`off` = no floor; garbage → default)
//   S2  applyShardBudget: the neutrality contract — an unauthored page leaves
//       BOTH globals unset (budget unbounded, floor = Rust default), i.e. the
//       default stays unbounded and byte-identical
//   S3  applyShardBudget: `?shardBudgetMB` + `?shardMinAgeS` set the globals
//   S4  worker init forward: the init message carries `shardMinAgeMs` beside
//       `shardBudgetBytes`; `bake_worker.js` handleInit applies it (0 included)
//   S5  the JS default mirrors Rust's DEFAULT_MIN_AGE_MS, and Rust reads the
//       same global name the host writes
//
// Run: node tests/shard_budget_soft_cap.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const CRATE = path.join(APP, "..", "..", "crates", "holtburger-resource-http", "src");

class ManualWorker {
  constructor() {
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
  }
  postMessage(msg) {
    this.posted.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
}
globalThis.Worker = ManualWorker;
globalThis.location = globalThis.location || { search: "", href: "http://127.0.0.1:8765/apps/holtburger-web/index.html" };

const {
  applyShardBudget,
  parseShardMinAgeS,
  DEFAULT_SHARD_MIN_AGE_S,
  BakeWorkerClient,
} = await import("../scene3d/bake_worker_client.js");

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("  ok  ", name);
  } catch (e) {
    failed += 1;
    console.log("  FAIL", name);
    console.log(e);
  }
}

const MB = 1024 * 1024;
const GLOBALS = ["__hbShardBudgetBytes", "__hbShardMinAgeMs"];
/** A page-global stand-in with stale values, so every assertion sees a write or a delete. */
const fakeGlobal = (search) => ({ location: { search }, __hbShardBudgetBytes: 99, __hbShardMinAgeMs: 99 });

// ---- S1 grammar ----
await t("S1 absent / empty / garbage / negative → null (Rust default)", () => {
  for (const bad of [null, undefined, "", "  ", "abc", "-1", "NaN", "Infinity", "12s"]) {
    assert.equal(parseShardMinAgeS(bad), null, JSON.stringify(bad));
  }
});
await t("S1 0 and off (any case) → 0 (no floor)", () => {
  assert.equal(parseShardMinAgeS("0"), 0);
  assert.equal(parseShardMinAgeS("off"), 0);
  assert.equal(parseShardMinAgeS(" OFF "), 0);
});
await t("S1 seconds, fractional allowed", () => {
  assert.equal(parseShardMinAgeS("60"), 60);
  assert.equal(parseShardMinAgeS("0.5"), 0.5);
  assert.equal(parseShardMinAgeS(" 120 "), 120);
});

// ---- S2 neutrality ----
await t("S2 unauthored page: both globals deleted, budget unbounded", () => {
  const g = fakeGlobal("");
  const r = applyShardBudget(g);
  assert.ok(GLOBALS.every((k) => !(k in g)), JSON.stringify(GLOBALS.map((k) => [k, g[k]])));
  assert.deepEqual(r, { mb: 0, bytes: 0, minAgeS: DEFAULT_SHARD_MIN_AGE_S });
});
await t("S2 unrelated params: same as unauthored", () => {
  const g = fakeGlobal("?nosw=1&agent=1&surfaceBudgetMB=24:64");
  applyShardBudget(g);
  assert.ok(GLOBALS.every((k) => !(k in g)));
});
await t("S2 garbage floor: global deleted (Rust default), budget untouched by it", () => {
  const g = fakeGlobal("?shardBudgetMB=192&shardMinAgeS=soon");
  const r = applyShardBudget(g);
  assert.ok(!("__hbShardMinAgeMs" in g));
  assert.equal(g.__hbShardBudgetBytes, 192 * MB);
  assert.equal(r.minAgeS, DEFAULT_SHARD_MIN_AGE_S);
});
await t("S2 shardMinAgeS alone does not arm a budget", () => {
  const g = fakeGlobal("?shardMinAgeS=60");
  const r = applyShardBudget(g);
  assert.ok(!("__hbShardBudgetBytes" in g), "budget stays unbounded");
  assert.equal(g.__hbShardMinAgeMs, 60_000, "authored floor is still published (inert without a budget)");
  assert.equal(r.mb, 0);
});

// ---- S3 armed ----
await t("S3 budget + floor: both globals, seconds → ms", () => {
  const g = fakeGlobal("?shardBudgetMB=192&shardMinAgeS=90");
  const r = applyShardBudget(g);
  assert.equal(g.__hbShardBudgetBytes, 192 * MB);
  assert.equal(g.__hbShardMinAgeMs, 90_000);
  assert.deepEqual(r, { mb: 192, bytes: 192 * MB, minAgeS: 90 });
});
await t("S3 budget alone: floor global unset → Rust's 120 s; return reports it", () => {
  const g = fakeGlobal("?shardBudgetMB=96");
  const r = applyShardBudget(g);
  assert.equal(g.__hbShardBudgetBytes, 96 * MB);
  assert.ok(!("__hbShardMinAgeMs" in g));
  assert.equal(r.minAgeS, 120);
});
await t("S3 floor off: 0 is written (not deleted), so Rust disables the floor", () => {
  for (const tok of ["0", "off"]) {
    const g = fakeGlobal(`?shardBudgetMB=24&shardMinAgeS=${tok}`);
    const r = applyShardBudget(g);
    assert.equal(g.__hbShardMinAgeMs, 0, tok);
    assert.equal(r.minAgeS, 0, tok);
  }
});
await t("S3 fractional seconds become whole ms", () => {
  let g = fakeGlobal("?shardBudgetMB=24&shardMinAgeS=0.25");
  applyShardBudget(g);
  assert.equal(g.__hbShardMinAgeMs, 250);
  g = fakeGlobal("?shardBudgetMB=24&shardMinAgeS=1.0004");
  applyShardBudget(g);
  assert.equal(g.__hbShardMinAgeMs, 1000);
});

// ---- S4 worker forward ----
function initMessageWith(globals) {
  const saved = {};
  for (const k of GLOBALS) {
    saved[k] = globalThis[k];
    if (k in globals) globalThis[k] = globals[k];
    else delete globalThis[k];
  }
  try {
    const c = new BakeWorkerClient();
    c._ensureWorker().catch(() => {});
    const init = c._worker.posted.find((m) => m.type === "init");
    assert.ok(init, "init message posted");
    return init;
  } finally {
    for (const k of GLOBALS) {
      if (saved[k] === undefined) delete globalThis[k];
      else globalThis[k] = saved[k];
    }
  }
}
await t("S4 init forwards shardMinAgeMs beside shardBudgetBytes", () => {
  const init = initMessageWith({ __hbShardBudgetBytes: 192 * MB, __hbShardMinAgeMs: 90_000 });
  assert.equal(init.shardBudgetBytes, 192 * MB);
  assert.equal(init.shardMinAgeMs, 90_000);
});
await t("S4 init forwards 0 (floor off) verbatim", () => {
  const init = initMessageWith({ __hbShardBudgetBytes: 24 * MB, __hbShardMinAgeMs: 0 });
  assert.equal(init.shardMinAgeMs, 0);
});
await t("S4 unauthored: both undefined in the init message (worker keeps Rust defaults)", () => {
  const init = initMessageWith({});
  assert.equal(init.shardBudgetBytes, undefined);
  assert.equal(init.shardMinAgeMs, undefined);
});
await t("S4 bake_worker.js handleInit applies shardMinAgeMs (0 included) before init_resource_source", () => {
  const src = readFileSync(path.join(APP, "scene3d", "bake_worker.js"), "utf8");
  const m = src.match(/if \(typeof msg\.shardMinAgeMs === "number"[^{]*\{[^}]*\}/);
  assert.ok(m, "handleInit shardMinAgeMs block present");
  // Run the block itself against a fake worker scope.
  const run = new Function("self", "msg", m[0]);
  for (const [msg, want] of [
    [{ shardMinAgeMs: 90_000 }, 90_000],
    [{ shardMinAgeMs: 0 }, 0],
    [{}, undefined],
    [{ shardMinAgeMs: -1 }, undefined],
    [{ shardMinAgeMs: "60" }, undefined],
  ]) {
    const self = {};
    run(self, msg);
    assert.equal(self.__hbShardMinAgeMs, want, JSON.stringify(msg));
  }
  const handleInit = src.slice(src.indexOf("async function handleInit"));
  assert.ok(
    handleInit.indexOf("__hbShardMinAgeMs") < handleInit.indexOf("await init_resource_source("),
    "assigned before the worker's resource source sizes its cache",
  );
});

// ---- S5 cross-language names ----
await t("S5 JS default mirrors shard_cache.rs DEFAULT_MIN_AGE_MS", () => {
  const rs = readFileSync(path.join(CRATE, "shard_cache.rs"), "utf8");
  const m = rs.match(/pub\(crate\) const DEFAULT_MIN_AGE_MS: f64 = ([0-9_.]+);/);
  assert.ok(m, "DEFAULT_MIN_AGE_MS present");
  assert.equal(Number(m[1].replace(/_/g, "")), DEFAULT_SHARD_MIN_AGE_S * 1000);
});
await t("S5 Rust reads the global the host writes", () => {
  const rs = readFileSync(path.join(CRATE, "manifest_source.rs"), "utf8");
  assert.match(rs, /JsValue::from_str\("__hbShardMinAgeMs"\)/);
  assert.match(rs, /with_soft_cap\(configured_shard_min_age_ms\(\), LOW_WATER_FRACTION\)/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
