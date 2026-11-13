// tests/world_object_live_updates.test.mjs — Area 11: Chorizite WorldObjectManager
// Live Property Updates, Positions, Containers, and Appraisals.
//
// Verifies:
//   1. Live property updates / deltas (single typed deltas & bulk property bundles).
//   2. Live position updates & position values.
//   3. Container events (containerOpened, containerClosed, item parenting/wielding).
//   4. Container read-through getters (container.items, item.parentContainer).
//   5. Live appraisal folding (hasAppraisalData, lastAppraisalTime, spellBook).
//   6. Event buffering before load() and automatic replay upon load().
//   7. Client attachment (client.worldObjects = wom) and client bus event wiring.
//   8. landblock_stream.js eviction guard check for populateStaticsAabbsForLandblock.
//
// Run from apps/holtburger-web/:  node tests/world_object_live_updates.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WorldObjectManager } from "../plugins/world-objects/world_object_manager.js";
import { Container } from "../plugins/world-objects/container.js";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAXONOMY_PATH = "./data/chorizite/world-object-taxonomy.json";
const ENUMS_PATH = "./data/chorizite/chorizite-common-enums.json";

// Hook fetch to read local JSON files for Node execution
globalThis.fetch = async (url) => {
  const file = typeof url === "string" && url.startsWith("file://")
    ? fileURLToPath(url)
    : path.join(APP, String(url));
  const body = readFileSync(file, "utf8");
  return { ok: true, status: 200, statusText: "OK", json: async () => JSON.parse(body) };
};

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

async function createLoadedWom(client = null) {
  const wom = new WorldObjectManager({ client });
  await wom.load(TAXONOMY_PATH, ENUMS_PATH);
  return wom;
}

// Simple event bus mock for client
function createMockClient() {
  const listeners = new Map();
  return {
    worldObjects: null,
    events: {
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(handler);
      },
      emit(event, payload) {
        const handlers = listeners.get(event) || [];
        for (const h of handlers) h(payload);
      },
    },
  };
}

console.log("\n[1] WorldObjectManager — Live Property Updates");

await check("Single property delta updates typed store & emits events", async () => {
  const wom = await createLoadedWom();
  // Spawn a sword (wcid 0x1000, ItemType 1 = MeleeWeapon)
  const sword = wom.onObjectCreated({
    guid: 0x1001,
    itemType: 0x00000001, // MeleeWeapon
    objDescFlags: 0,
    weenieFlags: 0,
    name: "Iron Broadsword",
  });
  assert.ok(sword, "Object must be created");

  let eventFired = false;
  wom.addEventListener("propertyChanged", (e) => {
    assert.equal(e.detail.guid, 0x1001);
    assert.equal(e.detail.object, sword);
    eventFired = true;
  });

  // Update PropertyInt.Value (19) to 500
  const updated = wom.onPropertyUpdate({
    guid: 0x1001,
    propertyType: "int",
    key: 19,
    value: 500,
  });
  assert.equal(updated, true);
  assert.equal(sword.intValue(19), 500);
  assert.equal(eventFired, true);
});

await check("All 8 typed property stores update through onPropertyUpdate", async () => {
  const wom = await createLoadedWom();
  const obj = wom.onObjectCreated({ guid: 0x2001, itemType: 0, objDescFlags: 0, weenieFlags: 0 });

  // int
  wom.onPropertyUpdate({ guid: 0x2001, propertyType: "int", key: 10, value: 42 });
  assert.equal(obj.intValue(10), 42);

  // int64 (BigInt)
  wom.onPropertyUpdate({ guid: 0x2001, propertyType: "int64", key: 2, value: 9876543210123n });
  assert.equal(obj.int64Value(2), 9876543210123n);

  // bool
  wom.onPropertyUpdate({ guid: 0x2001, propertyType: "bool", key: 5, value: true });
  assert.equal(obj.boolValue(5), true);

  // float
  wom.onPropertyUpdate({ guid: 0x2001, propertyType: "float", key: 12, value: 3.14159 });
  assert.equal(obj.floatValue(12), 3.14159);

  // string
  wom.onPropertyUpdate({ guid: 0x2001, propertyType: "string", key: 1, value: "Enchanted Blade" });
  assert.equal(obj.stringValue(1), "Enchanted Blade");

  // dataId
  wom.onPropertyUpdate({ guid: 0x2001, propertyType: "data", key: 8, value: 0x06001234 });
  assert.equal(obj.dataValue(8), 0x06001234);

  // instanceId
  wom.onPropertyUpdate({ guid: 0x2001, propertyType: "instance", key: 2, value: 0x50000001 });
  assert.equal(obj.instanceValue(2), 0x50000001);

  // position
  const pos = { x: 100, y: 200, z: 300 };
  wom.onPropertyUpdate({ guid: 0x2001, propertyType: "position", key: 1, value: pos });
  assert.deepEqual(obj.positionValue(1), pos);
});

await check("Bulk property bundles update via array pairs and dictionary objects", async () => {
  const wom = await createLoadedWom();
  const obj = wom.onObjectCreated({ guid: 0x3001, itemType: 0, objDescFlags: 0, weenieFlags: 0 });

  wom.onPropertyUpdate({
    guid: 0x3001,
    intProperties: [[19, 1500], [5, 200]],
    stringProperties: [[1, "Helm of Insight"], [20, "Helms of Insight"]],
    boolProperties: [[100, true]],
    floatProperties: [[54, 2.5]],
  });

  assert.equal(obj.intValue(19), 1500);
  assert.equal(obj.intValue(5), 200);
  assert.equal(obj.stringValue(1), "Helm of Insight");
  assert.equal(obj.stringValue(20), "Helms of Insight");
  assert.equal(obj.boolValue(100), true);
  assert.equal(obj.floatValue(54), 2.5);
});

console.log("\n[2] WorldObjectManager — Live Position Updates");

await check("onPositionUpdate sets position and positionValue(1) and emits events", async () => {
  const wom = await createLoadedWom();
  const obj = wom.onObjectCreated({ guid: 0x4001, itemType: 0, objDescFlags: 0, weenieFlags: 0 });

  let posEvent = null;
  wom.addEventListener("positionChanged", (e) => { posEvent = e.detail; });

  const updated = wom.onPositionUpdate({
    guid: 0x4001,
    position: { x: 1234.5, y: 5678.9, z: 42.0, heading: 1.57, cellId: 0x12340001 },
  });

  assert.equal(updated, true);
  assert.ok(obj.position);
  assert.equal(obj.position.x, 1234.5);
  assert.equal(obj.position.y, 5678.9);
  assert.equal(obj.position.z, 42.0);
  assert.deepEqual(obj.positionValue(1), obj.position);
  assert.ok(posEvent);
  assert.equal(posEvent.guid, 0x4001);
  assert.equal(posEvent.position.x, 1234.5);
});

console.log("\n[3] WorldObjectManager — Containers & Child Item Parenting");

await check("onContainerOpened updates openContainer and links child items", async () => {
  const wom = await createLoadedWom();

  // Create backpack (Container)
  // itemType 0x00000200 = IT_CONTAINER in canonical classifier
  const pack = wom.onObjectCreated({
    guid: 0x5001,
    itemType: 0x00000200, // Container
    objDescFlags: 0,
    weenieFlags: 0,
    name: "Leather Backpack",
  });
  assert.ok(pack instanceof Container, "Pack must be Container instance");

  // Create two items
  const gem = wom.onObjectCreated({
    guid: 0x5002,
    itemType: 0x00000001, // Item
    objDescFlags: 0,
    weenieFlags: 0,
    name: "Diamond",
  });
  const potion = wom.onObjectCreated({
    guid: 0x5003,
    itemType: 0x00000001, // Item
    objDescFlags: 0,
    weenieFlags: 0,
    name: "Healing Draught",
  });

  let openFired = false;
  wom.addEventListener("containerOpened", (e) => {
    assert.equal(e.detail.containerGuid, 0x5001);
    openFired = true;
  });

  // Open container containing the two items
  wom.onContainerOpened({
    guid: 0x5001,
    items: [0x5002, 0x5003],
    name: "Leather Backpack",
  });

  assert.equal(openFired, true);
  assert.equal(wom.openContainer, pack);

  // Verify child items have PROP_INSTANCE_CONTAINER set to backpack guid
  assert.equal(gem.instanceValue(2), 0x5001);
  assert.equal(potion.instanceValue(2), 0x5001);

  // Read-through getters verification
  assert.equal(gem.parentContainer, pack);
  assert.equal(potion.parentContainer, pack);
  const items = pack.items;
  assert.equal(items.length, 2);
  assert.ok(items.includes(gem));
  assert.ok(items.includes(potion));
});

await check("onContainerClosed clears openContainer and emits event", async () => {
  const wom = await createLoadedWom();
  wom.onObjectCreated({ guid: 0x5100, itemType: 0x00000200, objDescFlags: 0, weenieFlags: 0 });
  wom.onContainerOpened({ guid: 0x5100, items: [] });
  assert.ok(wom.openContainer);

  let closedFired = false;
  wom.addEventListener("containerClosed", (e) => {
    assert.equal(e.detail.containerGuid, 0x5100);
    closedFired = true;
  });

  wom.onContainerClosed({ guid: 0x5100 });
  assert.equal(wom.openContainer, null);
  assert.equal(closedFired, true);
});

await check("onItemParent and onItemContainerChanged update wielder/container", async () => {
  const wom = await createLoadedWom();
  const sword = wom.onObjectCreated({ guid: 0x6001, itemType: 1, objDescFlags: 0, weenieFlags: 0 });

  // Equip sword to character (wielder)
  wom.onItemParent({ itemGuid: 0x6001, parentGuid: 0x7001, isWielder: true });
  assert.equal(sword.instanceValue(3), 0x7001, "PROP_INSTANCE_WIELDER must be set to 0x7001");

  // Move sword to chest (container)
  wom.onItemContainerChanged({ itemGuid: 0x6001, parentGuid: 0x8001 });
  assert.equal(sword.instanceValue(2), 0x8001, "PROP_INSTANCE_CONTAINER must be set to 0x8001");
});

console.log("\n[4] WorldObjectManager — Live Appraisal Data Folding");

await check("onObjectAppraised folds property maps and sets appraisal metadata", async () => {
  const wom = await createLoadedWom();
  const staff = wom.onObjectCreated({ guid: 0x7001, itemType: 1, objDescFlags: 0, weenieFlags: 0 });
  assert.equal(staff.hasAppraisalData, false);
  assert.equal(staff.lastAppraisalTime, null);

  let appraisedFired = false;
  wom.addEventListener("objectAppraised", (e) => {
    assert.equal(e.detail.guid, 0x7001);
    appraisedFired = true;
  });

  const appraisalPayload = {
    intProperties: [[19, 10000], [91, 500], [92, 450]],
    stringProperties: [[1, "Staff of the Archmage"], [14, "A powerful relic."]],
    floatProperties: [[200, 1.25]],
    boolProperties: [[1, true]],
    spellBook: [{ id: 45, layer: 0 }, { id: 72, layer: 1 }],
  };

  wom.onObjectAppraised({
    guid: 0x7001,
    properties: appraisalPayload,
  });

  assert.equal(appraisedFired, true);
  assert.equal(staff.hasAppraisalData, true);
  assert.ok(staff.lastAppraisalTime instanceof Date);
  assert.equal(staff.intValue(19), 10000);
  assert.equal(staff.intValue(91), 500);
  assert.equal(staff.intValue(92), 450);
  assert.equal(staff.stringValue(1), "Staff of the Archmage");
  assert.equal(staff.stringValue(14), "A powerful relic.");
  assert.equal(staff.floatValue(200), 1.25);
  assert.equal(staff.boolValue(1), true);
  assert.ok(staff._spellBook);
  assert.equal(staff._spellBook.length, 2);
});

console.log("\n[5] Client Attachment & Client Events Bridge Wiring");

await check("attachClient sets client.worldObjects and wires event stream", async () => {
  const client = createMockClient();
  const wom = new WorldObjectManager();
  wom.attachClient(client);

  assert.equal(client.worldObjects, wom, "client.worldObjects must point to WorldObjectManager");

  await wom.load(TAXONOMY_PATH, ENUMS_PATH);

  const obj = wom.onObjectCreated({ guid: 0x8001, itemType: 1, objDescFlags: 0, weenieFlags: 0 });

  // Test event routing via client.events
  client.events.emit("propertyUpdate", { guid: 0x8001, propertyType: "int", key: 19, value: 777 });
  assert.equal(obj.intValue(19), 777);

  client.events.emit("positionUpdate", { guid: 0x8001, position: { x: 50, y: 60, z: 70 } });
  assert.equal(obj.position.x, 50);

  client.events.emit("objectAppraised", {
    u32Payload: 0x8001,
    properties: { intProperties: [[105, 9]] },
  });
  assert.equal(obj.intValue(105), 9);
  assert.equal(obj.hasAppraisalData, true);

  // Test kind:49 (attach / wield) and kind:47 (detach / unequip)
  client.events.emit("kind:49", { u32Payload: 0x8001, u32Payload2: 0x9999 });
  assert.equal(obj.instanceValue(3), 0x9999);

  client.events.emit("kind:47", { u32Payload: 0x8001 });
  assert.equal(obj.instanceValue(3), 0);
});

await check("attachClient succeeds on real frozen createClient() facade", async () => {
  const { createClient } = await import("../plugins/api.js");
  const frozenClient = createClient({});
  assert.equal(Object.isFrozen(frozenClient), true, "createClient facade must remain frozen");
  const wom = new WorldObjectManager();
  wom.attachClient(frozenClient);
  assert.equal(frozenClient.worldObjects, wom, "frozen createClient facade must expose worldObjects");
});

console.log("\n[6] Event Buffering Before load() & Replay");

await check("Updates arriving during load() are buffered and replayed", async () => {
  const wom = new WorldObjectManager();
  assert.equal(wom.loaded, false);

  // Queue an object creation and property/position updates while !loaded
  wom.onObjectCreated({ guid: 0x9001, itemType: 1, objDescFlags: 0, weenieFlags: 0, name: "Pending Blade" });
  wom.onPropertyUpdate({ guid: 0x9001, propertyType: "int", key: 19, value: 333 });
  wom.onPositionUpdate({ guid: 0x9001, position: { x: 10, y: 20, z: 30 } });
  wom.onObjectAppraised({ guid: 0x9001, properties: { boolProperties: [[5, true]] } });

  // Object is not yet in map before load resolves
  assert.equal(wom.has(0x9001), false);

  // Resolve load
  await wom.load(TAXONOMY_PATH, ENUMS_PATH);

  // Now object must be present and all buffered updates replayed
  assert.equal(wom.has(0x9001), true);
  const obj = wom.get(0x9001);
  assert.equal(obj.intValue(19), 333);
  assert.equal(obj.position.x, 10);
  assert.equal(obj.hasAppraisalData, true);
  assert.equal(obj.boolValue(5), true);
});

console.log("\n[7] Landblock Stream Eviction Guard");

await check("landblock_stream.js guards populateStaticsAabbsForLandblock with eviction checks", () => {
  const src = readFileSync(path.join(APP, "app/landblock_stream.js"), "utf8");
  const callIdx = src.indexOf("await populateStaticsAabbsForLandblock");
  assert.ok(callIdx > 0, "await populateStaticsAabbsForLandblock call must exist");

  const region = src.slice(callIdx - 100, callIdx + 200);
  assert.match(region, /if\s*\(!notEvicted\(\)\)\s*return;[\s\S]*await\s+populateStaticsAabbsForLandblock/,
    "Must guard before populateStaticsAabbsForLandblock with eviction check");
  assert.match(region, /await\s+populateStaticsAabbsForLandblock[\s\S]*if\s*\(!notEvicted\(\)\)\s*return;/,
    "Must guard after populateStaticsAabbsForLandblock await with eviction check");
});

console.log(`\n========================================`);
console.log(`world_object_live_updates: ${passed} passed, ${failed} failed`);
console.log(`========================================\n`);

if (failed > 0) process.exit(1);
