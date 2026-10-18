// tests/world_object_manager_load_fail.test.mjs — 2026-10-18 systematic
// review, PLUGINSB-5.
//
// WorldObjectManager buffers KIND_SPAWN / KIND_REMOVE events that arrive
// before load() (taxonomy + enums JSON) resolves, and replays them once it
// does. index.html calls load() ONCE, fire-and-forget, and only logs a
// failure; nothing retries it. A single 404 / 5xx / malformed body left
// `loaded` false for the page, and every later spawn and delete was pushed
// onto _pendingCreate / _pendingDelete forever — unbounded growth on a long
// roam.
//
// CONTRACT (the REAL plugins/world-objects/world_object_manager.js; fetch
// serves the real data/chorizite/*.json from disk)
//   [1] a successful load replays the events buffered during the load;
//   [2] a failed load rejects (index.html logs it), drops the buffer, and
//       buffers nothing after that;
//   [3] a later load() that succeeds starts classifying again.
//
// Run from apps/holtburger-web/:  node tests/world_object_manager_load_fail.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAXONOMY = "./data/chorizite/world-object-taxonomy.json";
const ENUMS = "./data/chorizite/chorizite-common-enums.json";

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err?.stack?.split("\n").slice(0, 3).join(" | ") ?? err}`);
  }
}

// Same-origin static fetch, served from the app tree; `failUrl` answers 404.
let failUrl = null;
globalThis.fetch = async (url) => {
  if (url === failUrl) return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
  const body = readFileSync(path.join(APP, url), "utf8");
  return { ok: true, status: 200, statusText: "OK", json: async () => JSON.parse(body) };
};

const { WorldObjectManager } = await import(
  pathToFileURL(path.join(APP, "plugins", "world-objects", "world_object_manager.js")).href
);
const spawn = (guid) => ({ guid, classId: 509, itemType: 0, objDescFlags: 0x00004000, weenieFlags: 0, name: "Life Stone" });

console.log("[1] a successful load");
await check("events during the load are buffered, then replayed", async () => {
  failUrl = null;
  const wom = new WorldObjectManager();
  const loading = wom.load(TAXONOMY, ENUMS);
  wom.onObjectCreated(spawn(0xA0000001));
  wom.onObjectCreated(spawn(0xA0000002));
  wom.onObjectDeleted({ guid: 0xA0000002 });
  assert.equal(wom._pendingCreate.length, 2);
  await loading;
  assert.equal(wom.loaded, true);
  assert.equal(wom.count(), 1, "two created, one deleted");
  assert.equal(wom.get(0xA0000001)?.constructor.name, "Lifestone");
  assert.equal(wom._pendingCreate.length + wom._pendingDelete.length, 0);
});

console.log("[2] a failed load");
const wom = new WorldObjectManager();
await check("the load rejects, the buffer is dropped, and later events are not queued", async () => {
  failUrl = TAXONOMY;
  const loading = wom.load(TAXONOMY, ENUMS);
  wom.onObjectCreated(spawn(0xA0000003));
  await assert.rejects(loading, /taxonomy load failed: 404/);
  assert.equal(wom.loaded, false);
  assert.equal(wom.loadFailed, true);
  assert.equal(wom._pendingCreate.length, 0, "buffer dropped");
  for (let i = 0; i < 500; i += 1) {
    assert.equal(wom.onObjectCreated(spawn(0xB0000000 + i)), null);
    assert.equal(wom.onObjectDeleted({ guid: 0xB0000000 + i }), false);
  }
  assert.equal(wom._pendingCreate.length, 0, "no growth");
  assert.equal(wom._pendingDelete.length, 0, "no growth");
  assert.equal(wom.count(), 0);
});
await check("an enums failure (after the taxonomy loaded) behaves the same", async () => {
  failUrl = ENUMS;
  const other = new WorldObjectManager();
  const loading = other.load(TAXONOMY, ENUMS);
  other.onObjectCreated(spawn(0xA0000004));
  await assert.rejects(loading, /enums load failed: 404/);
  other.onObjectCreated(spawn(0xA0000005));
  assert.equal(other._pendingCreate.length, 0);
});

console.log("[3] a later load that succeeds");
await check("load() again → loaded, new spawns classify", async () => {
  failUrl = null;
  await wom.load(TAXONOMY, ENUMS);
  assert.equal(wom.loaded, true);
  assert.equal(wom.loadFailed, false);
  assert.equal(wom.onObjectCreated(spawn(0xA0000006))?.constructor.name, "Lifestone");
  assert.equal(wom.count(), 1);
});

console.log(`\nworld_object_manager_load_fail: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
