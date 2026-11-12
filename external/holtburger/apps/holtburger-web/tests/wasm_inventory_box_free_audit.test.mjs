// tests/wasm_inventory_box_free_audit.test.mjs — Area 12: WASM InventoryItem Box Free Sweep
//
// Verifies that every site reading handle.playerInventory() explicitly frees all
// WASM InventoryItem boxes via item.free() after use to eliminate memory leaks:
//   1. plugins/api.js: getComponentTracker
//   2. plugins/combat-bar.js: dockStrip reflow guard & inventory free in suggestedCombatMode / casterWielded
//   3. plugins/examine-target.js: getItemByGuid snapshots and frees items
//   4. plugins/lore-panel.js: fetchInventory snapshots and frees items
//   5. plugins/spellbook.js: componentCounts frees items
//   6. ui/ac_cast_precheck.js: carriedComponentCounts frees items
//   7. ui/ac_damage_rating.js: getEquippedDamageMod frees items even on early return

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name} — ${e.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name} — ${e.message}`);
  }
}

// Helper to create mock WASM inventory items
function createMockWasmItem(props) {
  let freed = false;
  return {
    ...props,
    get isFreed() { return freed; },
    free() {
      if (freed) throw new Error("Double free on WASM item " + props.guid);
      freed = true;
    },
  };
}

console.log("[1] plugins/api.js getComponentTracker free audit");
await checkAsync("getComponentTracker frees all items returned by playerInventory", async () => {
  const { getComponentTracker, _setComponentCatalogForTest } = await import(pathToFileURL(path.join(APP, "plugins", "api.js")).href);
  _setComponentCatalogForTest({
    "1": { name: "Lead Scarab" },
    "188": { name: "Prismatic Taper" },
  });
  const items = [
    createMockWasmItem({ guid: 101, name: "Lead Scarab", stackSize: 5 }),
    createMockWasmItem({ guid: 102, name: "Prismatic Taper", stackSize: 10 }),
    createMockWasmItem({ guid: 103, name: "Unknown Rock", stackSize: 1 }),
  ];
  globalThis.window = {
    __sessionHandle: {
      playerInventory() { return items; },
    },
  };

  const counts = getComponentTracker();
  assert.ok(counts, "getComponentTracker should return counts object");
  assert.equal(counts["1"], 5);
  assert.equal(counts["188"], 10);
  for (const it of items) {
    assert.equal(it.isFreed, true, `Item ${it.guid} was not freed!`);
  }
});

console.log("\n[2] ui/ac_damage_rating.js computeDamageRatingRollup free audit");
await checkAsync("computeDamageRatingRollup frees all inventory items on weapon scan", async () => {
  const { computeDamageRatingRollup } = await import(pathToFileURL(path.join(APP, "ui", "ac_damage_rating.js")).href);
  const items = [
    createMockWasmItem({ guid: 201, equipMask: 0x00000001, damageMod: 1.25 }), // Primary weapon bit
    createMockWasmItem({ guid: 202, equipMask: 0x00000002, damageMod: 1.0 }),
    createMockWasmItem({ guid: 203, equipMask: 0x00000004, damageMod: 1.0 }),
  ];
  const mockHandle = {
    playerInventory() { return items; },
  };

  const rollup = computeDamageRatingRollup({ sessionHandle: mockHandle });
  assert.ok(rollup);
  for (const it of items) {
    assert.equal(it.isFreed, true, `Item ${it.guid} was not freed in computeDamageRatingRollup!`);
  }
});

console.log("\n[3] ui/ac_cast_precheck.js preCheckSpell free audit");
await checkAsync("preCheckSpell frees all items returned by playerInventory", async () => {
  const { preCheckSpell, _setComponentTableForTest } = await import(pathToFileURL(path.join(APP, "ui", "ac_cast_precheck.js")).href);
  _setComponentTableForTest({
    "1": { name: "Lead Scarab", wcid: 691 },
  });
  const items = [
    createMockWasmItem({ guid: 301, wcid: 691, name: "Lead Scarab", stackSize: 20 }),
    createMockWasmItem({ guid: 302, wcid: 20631, name: "Prismatic Taper", stackSize: 50 }),
  ];
  globalThis.window = {
    location: { search: "?castPrecheck=components" },
    __sessionHandle: {
      getSpellRecord(id) {
        return { components: [1] };
      },
      playerInventory() { return items; },
      playerPropertyBool(guid, prop) { return true; },
      playerKnownSpells() { return []; },
    },
  };

  const res = preCheckSpell(1);
  // Pre-check passes (returns null) because player carries Lead Scarab
  assert.equal(res, null);
  for (const it of items) {
    assert.equal(it.isFreed, true, `Item ${it.guid} was not freed in preCheckSpell!`);
  }
});

console.log("\n[4] Static source audits for examine-target.js, lore-panel.js, spellbook.js, combat-bar.js");

check("examine-target.js getItemByGuid frees all WASM items in finally block and returns snapshot", () => {
  const src = fs.readFileSync(path.join(APP, "plugins", "examine-target.js"), "utf8");
  assert.match(src, /function snapshotInventoryItem/, "Expected snapshotInventoryItem function");
  assert.match(src, /finally\s*\{[\s\S]*?it\?\.free\?\.[\s\S]*?\}/, "Expected finally block freeing items in examine-target.js");
});

check("lore-panel.js fetchInventory frees all items in finally block and returns mapped plain objects", () => {
  const src = fs.readFileSync(path.join(APP, "plugins", "lore-panel.js"), "utf8");
  assert.match(src, /function fetchInventory\(\)\s*\{[\s\S]*?finally\s*\{[\s\S]*?it\?\.free\?\.[\s\S]*?\}/, "Expected fetchInventory to free all raw items in finally");
});

check("spellbook.js componentCounts frees all items in items", () => {
  const src = fs.readFileSync(path.join(APP, "plugins", "spellbook.js"), "utf8");
  assert.match(src, /finally\s*\{\s*for\s*\(\s*const\s+it\s+of\s+items\s*\)\s*\{\s*try\s*\{\s*it\?\.free\?\.\(\);/, "Expected componentCounts to free all items in items");
});

check("combat-bar.js frees inventory items in suggestedCombatMode and casterWielded", () => {
  const src = fs.readFileSync(path.join(APP, "plugins", "combat-bar.js"), "utf8");
  const count = (src.match(/for\s*\(\s*const\s+it\s+of\s+inv\s*\)\s*\{\s*try\s*\{\s*it\?\.free\?\.\(\);/g) || []).length;
  assert.ok(count >= 2, `Expected at least 2 inventory item free loops in combat-bar.js, found ${count}`);
});

check("combat-bar.js dockStrip guards against 1 Hz getBoundingClientRect reflow when userPlaced()", () => {
  const src = fs.readFileSync(path.join(APP, "plugins", "combat-bar.js"), "utf8");
  assert.match(src, /function dockStrip\(forceBoundaryCheck = false\)/, "Expected dockStrip to take forceBoundaryCheck param");
  assert.match(src, /if\s*\(userPlaced\(\)\)\s*\{\s*if\s*\(!forceBoundaryCheck\)\s*return;/, "Expected dockStrip to early return without getBoundingClientRect when not forcing check");
  assert.match(src, /if\s*\(!userPlaced\(\)\)\s*\{\s*dockStrip\(false\);/, "Expected 1 Hz interval to only dock when not userPlaced");
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
