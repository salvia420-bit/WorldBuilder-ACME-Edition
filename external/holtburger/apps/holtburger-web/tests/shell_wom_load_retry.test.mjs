// tests/shell_wom_load_retry.test.mjs — 2026-10-18 review follow-up,
// PLUGINSB-5 (§10.5 "index.html never retries worldObjectManager.load").
//
// The PLUGINSB-5 fix made a failed WorldObjectManager.load() drop its buffer
// and queue nothing more, and a later good load() classify again. But
// index.html called load() once and only logged a failure, so one transient
// 404 / 5xx on data/chorizite/*.json left typed classification and the plugin
// world mirror empty for the page.
//
// Runs index.html's REAL `if (!worldObjectManager) { … }` block (lifted from
// the shipped page) against the REAL plugins/world-objects/
// world_object_manager.js; fetch serves the real JSON from disk, failing on
// demand. setTimeout is a manual clock.
//
// CONTRACT
//   [1] a first load that succeeds schedules nothing;
//   [2] a failed load is retried after 2 s, 5 s, 15 s; a retry that succeeds
//       classifies again;
//   [3] bounded: after three failed retries it gives up (one console.error),
//       no timer left;
//   [4] pagehide cancels a pending retry and stops further ones.
//
// Run from apps/holtburger-web/:  node tests/shell_wom_load_retry.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAXONOMY = "./data/chorizite/world-object-taxonomy.json";

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.stack || e.message}`); }
}

// Same-origin static fetch from the app tree; the next `failures` taxonomy
// fetches answer 503.
let failures = 0;
let fetches = 0;
globalThis.fetch = async (url) => {
  if (url === TAXONOMY) {
    fetches += 1;
    if (failures > 0) {
      failures -= 1;
      return { ok: false, status: 503, statusText: "Service Unavailable", json: async () => ({}) };
    }
  }
  const body = readFileSync(path.join(APP, url), "utf8");
  return { ok: true, status: 200, statusText: "OK", json: async () => JSON.parse(body) };
};
const { WorldObjectManager } = await import(
  pathToFileURL(path.join(APP, "plugins", "world-objects", "world_object_manager.js")).href
);

/** The balanced `{…}` block whose head starts at `anchor` (strings/comments skipped). */
function liftBlock(src, anchor, from = 0) {
  const start = src.indexOf(anchor, from);
  if (start < 0) throw new Error(`anchor drifted: ${anchor}`);
  let i = src.indexOf("{", start + anchor.length - 1);
  let depth = 0;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") {
      for (i += 1; i < src.length && src[i] !== c; i += 1) if (src[i] === "\\") i += 1;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced block at: ${anchor}`);
}
const HTML = readFileSync(path.join(APP, "index.html"), "utf8");
const WOM_BLOCK = liftBlock(HTML, "if (!worldObjectManager) {");

const settle = () => new Promise((r) => setImmediate(r));
const spawn = (guid) => ({ guid, classId: 509, itemType: 0, objDescFlags: 0x00004000, weenieFlags: 0, name: "Life Stone" });

/** Run the block once, as the first login does. */
function boot() {
  const timers = new Map();
  let nextId = 1;
  const pagehide = [];
  const logs = { info: [], warn: [], error: [] };
  const scope = {
    worldObjectManager: null,
    WorldObjectManager,
    pluginClient: { tag: "client" },
    window: {
      addEventListener: (type, fn, opts) => { if (type === "pagehide") pagehide.push({ fn, opts }); },
    },
    console: {
      info: (...a) => logs.info.push(a),
      warn: (...a) => logs.warn.push(a),
      error: (...a) => logs.error.push(a),
    },
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  // eslint-disable-next-line no-new-func
  new Function("__scope", `with (__scope) {\n${WOM_BLOCK}\n}`)(scope);
  /** Fire the one pending timer; returns its delay. */
  const fire = () => {
    assert.equal(timers.size, 1, "exactly one retry pending");
    const [[id, t]] = timers;
    timers.delete(id);
    t.fn();
    return t.ms;
  };
  return { scope, timers, fire, pagehide, logs, wom: () => scope.worldObjectManager };
}

console.log("\n[1] a good first load");
await check("loads once, schedules nothing", async () => {
  failures = 0; fetches = 0;
  const b = boot();
  await settle();
  assert.equal(b.wom().loaded, true);
  assert.equal(b.timers.size, 0);
  assert.equal(fetches, 1);
  assert.equal(b.logs.info.length, 1, "[wom] loaded line");
  assert.equal(b.wom().client, b.scope.pluginClient);
});

console.log("\n[2] a transient failure");
await check("retried after 2 s and 5 s; the third attempt classifies", async () => {
  failures = 2; fetches = 0;
  const b = boot();
  await settle();
  assert.equal(b.wom().loaded, false);
  assert.equal(b.wom().loadFailed, true);
  assert.equal(b.wom().onObjectCreated(spawn(0xA0000001)), null, "not classified while failed");
  assert.equal(b.fire(), 2000);
  await settle();
  assert.equal(b.wom().loaded, false);
  assert.equal(b.fire(), 5000);
  await settle();
  assert.equal(b.wom().loaded, true);
  assert.equal(b.wom().loadFailed, false);
  assert.equal(b.timers.size, 0, "nothing left pending");
  assert.equal(fetches, 3);
  assert.equal(b.wom().onObjectCreated(spawn(0xA0000002))?.constructor.name, "Lifestone");
  assert.equal(b.logs.warn.length, 2);
  assert.equal(b.logs.error.length, 0);
});

console.log("\n[3] a lasting failure");
await check("three retries (2 s, 5 s, 15 s), then one error and no timer", async () => {
  failures = 1000; fetches = 0;
  const b = boot();
  await settle();
  const delays = [];
  while (b.timers.size > 0) {
    delays.push(b.fire());
    await settle();
    assert.ok(delays.length <= 3, "bounded");
  }
  assert.deepEqual(delays, [2000, 5000, 15000]);
  assert.equal(fetches, 4, "first try + three retries");
  assert.equal(b.wom().loaded, false);
  assert.equal(b.logs.error.length, 1, "one final [wom] load failed");
  assert.equal(b.wom()._pendingCreate.length, 0);
  failures = 0;
});

console.log("\n[4] pagehide");
await check("cancels the pending retry; a load in flight at pagehide schedules none", async () => {
  failures = 1000; fetches = 0;
  const b = boot();
  await settle();
  assert.equal(b.timers.size, 1);
  assert.equal(b.pagehide.length, 1);
  b.pagehide[0].fn({ persisted: false });
  assert.equal(b.timers.size, 0, "pending retry cleared");
  assert.equal(fetches, 1);

  const c = boot();
  await settle();
  c.fire(); // retry 1 starts loading …
  c.pagehide[0].fn({ persisted: false }); // … and the page goes before it fails
  await settle();
  assert.equal(c.timers.size, 0, "no retry after pagehide");
  assert.equal(c.logs.error.length, 1);
  failures = 0;
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
