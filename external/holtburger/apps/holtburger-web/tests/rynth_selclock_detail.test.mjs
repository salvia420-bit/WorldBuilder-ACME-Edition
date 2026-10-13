// tests/rynth_selclock_detail.test.mjs — rynth/webhost.js's page selection
// clock (GetSelectedItemId) on the REAL plugin bus (rynth-webhost-selection,
// 2026-10-13; found by scripts/lint-event-consumers.mjs DETAIL-UNREAD).
//
// The plugin bus delivers `new CustomEvent(name, { detail: payload })`
// (plugins/api.js events.emit). selectionClock()'s `selectionChanged` handler
// read `e.guid` / `e.lodRespawn` / `e.prevGuid` off the Event itself, so guid
// was always 0 and the LOD-respawn filter never matched: the release + same-
// guid re-select of a dynamic-LOD swap (scene3d/entities.js _respawnForLod)
// stamped the world clock twice, and GetSelectedItemId then preferred the
// world selection over an inventory item the player had clicked after it.
// tests/rynth_vt_layer.test.mjs drives the clock with a raw-payload fake bus,
// which hid it.
//   S1  createClient(handle).events (the real bus): a LOD swap is not a newer
//       world selection; a real world pick, a real deselect + re-pick of the
//       same guid, and RynthWebHost.SelectObject still are
//   S2  end to end with the real emitters: EntityManager
//       releaseSelectionOnServerDelete (lodRespawn) + _tickSelectionRules'
//       re-select, through the CustomEvent bus
//   S3  a raw-payload bus (no `.detail`) is still accepted
//   S4  the handler reads `.detail` (the lint's DETAIL-UNREAD pin)
//
// Run from apps/holtburger-web/:  node tests/rynth_selclock_detail.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

// Browser globals webhost.js, the plugin facade and entities.js read at import
// time. The page EventTarget carries the inventory panel's
// `hb-inventory-selection` window event (plugins/inventory.js).
const page = new EventTarget();
globalThis.window = globalThis;
globalThis.location = { search: "" };
globalThis.__playEffectVfxBound = true;
globalThis.__spellShapePreviewBound = true;
globalThis.addEventListener = page.addEventListener.bind(page);
globalThis.removeEventListener = page.removeEventListener.bind(page);
globalThis.dispatchEvent = page.dispatchEvent.bind(page);

const { RynthWebHost } = await import(pathToFileURL(path.join(APP, "rynth", "webhost.js")).href);
const { createClient } = await import(pathToFileURL(path.join(APP, "plugins", "api.js")).href);

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 6).join("\n       ") : e}`);
  }
}

const ME = 0x50000001;
const MOB = 0x80000501;
const MOB2 = 0x80000502;

/** A fresh page clock + the given bus as `__pluginClient`; restores on exit. */
async function withPage(pluginClient, entityManager, fn) {
  const saved = { bus: globalThis.__pluginClient, inv: globalThis.__inventory, live: globalThis.liveScene3d };
  delete globalThis.__rynthSelClock;
  globalThis.__pluginClient = pluginClient;
  globalThis.__inventory = { selectedGuid: 0 };
  globalThis.liveScene3d = { entityManager };
  try {
    const h = new RynthWebHost({ playerGuid: () => ME }, { noEventTap: true });
    const pickInv = (g) => {
      globalThis.__inventory.selectedGuid = g;
      page.dispatchEvent(new Event("hb-inventory-selection"));
    };
    await fn(h, pickInv);
  } finally {
    if (saved.bus === undefined) delete globalThis.__pluginClient;
    else globalThis.__pluginClient = saved.bus;
    if (saved.inv === undefined) delete globalThis.__inventory;
    else globalThis.__inventory = saved.inv;
    if (saved.live === undefined) delete globalThis.liveScene3d;
    else globalThis.liveScene3d = saved.live;
    delete globalThis.__rynthSelClock;
  }
}

/** The minimal entity manager GetSelectedId / SelectObject drive. */
function fakeEm() {
  return {
    sel: 0,
    getSelectedTarget() { return this.sel >>> 0; },
    setSelectedTarget(g) { this.sel = g >>> 0; },
  };
}

console.log("\n[S1] the real plugin bus (plugins/api.js createClient → CustomEvent{detail})");
await check("a LOD swap's release + same-guid re-select is not a newer world selection", async () => {
  const client = createClient({});
  const em = fakeEm();
  await withPage(client, em, (h, pickInv) => {
    const bus = client.events;
    const pickWorld = (g) => {
      const prev = em.sel;
      em.sel = g;
      bus.emit("selectionChanged", { guid: g, prevGuid: prev });
    };
    assert.equal(h.GetSelectedItemId(), 0);
    pickInv(0x7100);
    assert.equal(h.GetSelectedItemId(), 0x7100);
    pickWorld(MOB);
    assert.equal(h.GetSelectedItemId(), MOB, "a world click after the inventory click wins");
    pickInv(0x7200);
    assert.equal(h.GetSelectedItemId(), 0x7200, "an inventory click after the world click wins");
    // scene3d/entities.js: releaseSelectionOnServerDelete under _respawnForLod,
    // then _tickSelectionRules re-selects the same guid via _commitSelection.
    const c = globalThis.__rynthSelClock;
    const worldAt = c.worldAt;
    em.sel = 0;
    bus.emit("selectionChanged", { guid: 0, prevGuid: MOB, lodRespawn: true });
    assert.equal(c.lodGuid, MOB >>> 0, "the release half is read from e.detail (prevGuid)");
    em.sel = MOB;
    bus.emit("selectionChanged", { guid: MOB, prevGuid: 0 });
    assert.equal(c.lodGuid, 0, "the re-select half consumes the LOD mark");
    assert.equal(c.worldAt, worldAt, "neither half stamps the world clock");
    assert.equal(h.GetSelectedItemId(), 0x7200, "the inventory click is still the newer selection");
    pickWorld(MOB2);
    assert.equal(h.GetSelectedItemId(), MOB2, "a real world pick after the LOD swap still wins");
  });
});

await check("a real deselect + re-pick of the same guid IS a newer world selection", async () => {
  const client = createClient({});
  const em = fakeEm();
  await withPage(client, em, (h, pickInv) => {
    const bus = client.events;
    em.sel = MOB;
    bus.emit("selectionChanged", { guid: MOB, prevGuid: 0 });
    pickInv(0x7300);
    assert.equal(h.GetSelectedItemId(), 0x7300);
    // a server delete (lodRespawn false) and a fresh click on the same guid
    em.sel = 0;
    bus.emit("selectionChanged", { guid: 0, prevGuid: MOB, lodRespawn: false });
    assert.equal(h.GetSelectedItemId(), 0x7300, "a cleared world selection falls back to the inventory one");
    em.sel = MOB;
    bus.emit("selectionChanged", { guid: MOB, prevGuid: 0 });
    assert.equal(h.GetSelectedItemId(), MOB, "the re-pick is newer than the inventory click");
  });
});

await check("a LOD release of one guid does not swallow a pick of ANOTHER guid", async () => {
  const client = createClient({});
  const em = fakeEm();
  await withPage(client, em, (h, pickInv) => {
    const bus = client.events;
    em.sel = MOB;
    bus.emit("selectionChanged", { guid: MOB, prevGuid: 0 });
    pickInv(0x7400);
    em.sel = 0;
    bus.emit("selectionChanged", { guid: 0, prevGuid: MOB, lodRespawn: true });
    em.sel = MOB2;
    bus.emit("selectionChanged", { guid: MOB2, prevGuid: 0 });
    assert.equal(globalThis.__rynthSelClock.lodGuid, 0);
    assert.equal(h.GetSelectedItemId(), MOB2, "a different guid is a real selection");
  });
});

await check("RynthWebHost.SelectObject's own emit stamps the world clock through the real bus", async () => {
  const client = createClient({});
  const em = fakeEm();
  await withPage(client, em, (h, pickInv) => {
    pickInv(0x7500);
    assert.equal(h.GetSelectedItemId(), 0x7500);
    assert.equal(h.SelectObject(MOB), true);
    assert.equal(h.GetSelectedItemId(), MOB, "a scripted world selection after the inventory click wins");
  });
});

console.log("\n[S2] end to end: EntityManager's real selectionChanged emits");
await check("releaseSelectionOnServerDelete(lodRespawn) + _tickSelectionRules re-select leave the clock alone", async () => {
  const THREE = await import("three");
  const { EntityManager } = await import(pathToFileURL(path.join(APP, "scene3d", "entities.js")).href);
  const client = createClient({});
  const savedGuid = globalThis.getLocalPlayerGuid;
  globalThis.getLocalPlayerGuid = () => ME;
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, {});
  const root = new THREE.Group();
  em.entityMap.set(MOB, {
    guid: MOB, root, parts: [], meta: { guid: MOB, landblockId: 0, x: 5, y: 0, z: 0 },
    _stateVisible: true, _attachedParentGuid: null, _attachedChildren: null, dispose() {},
  });
  const seen = [];
  client.events.on("selectionChanged", (e) => seen.push(e.detail));
  try {
    await withPage(client, em, (h, pickInv) => {
      em._commitSelection(MOB);
      pickInv(0x7600);
      assert.equal(h.GetSelectedItemId(), 0x7600);
      const worldAt = globalThis.__rynthSelClock.worldAt;
      seen.length = 0;
      em._lodRespawnGuid = MOB; // _respawnForLod marks the guid around remove()
      em.releaseSelectionOnServerDelete(MOB);
      em._lodRespawnGuid = 0;
      assert.equal(em.getSelectedTarget(), 0, "the rig's selection was released");
      em._tickSelectionRules(null); // the respawned rig landed: re-select it
      assert.equal(em.getSelectedTarget(), MOB >>> 0, "and re-selected a tick later");
      assert.deepEqual(
        seen.map((d) => [d.guid >>> 0, d.prevGuid >>> 0, d.lodRespawn === true]),
        [[0, MOB >>> 0, true], [MOB >>> 0, 0, false]],
        "the two real emits, as CustomEvent details",
      );
      assert.equal(globalThis.__rynthSelClock.worldAt, worldAt, "neither stamps the world clock");
      assert.equal(h.GetSelectedItemId(), 0x7600, "the inventory click stays the newer selection");
    });
  } finally {
    em.dispose?.();
    if (savedGuid === undefined) delete globalThis.getLocalPlayerGuid;
    else globalThis.getLocalPlayerGuid = savedGuid;
  }
});

console.log("\n[S3] a raw-payload bus (no .detail) still works");
await check("raw {guid, prevGuid, lodRespawn} payloads are read as before", async () => {
  const fns = [];
  const rawBus = { on: (n, fn) => fns.push([n, fn]) };
  const fire = (p) => { for (const [n, fn] of fns) if (n === "selectionChanged") fn(p); };
  const em = fakeEm();
  await withPage({ events: rawBus }, em, (h, pickInv) => {
    pickInv(0x7700);
    em.sel = MOB;
    fire({ guid: MOB, prevGuid: 0 });
    assert.equal(h.GetSelectedItemId(), MOB);
    pickInv(0x7800);
    em.sel = 0;
    fire({ guid: 0, prevGuid: MOB, lodRespawn: true });
    em.sel = MOB;
    fire({ guid: MOB, prevGuid: 0 });
    assert.equal(h.GetSelectedItemId(), 0x7800, "the LOD pair is filtered on a raw bus too");
    fire(null); // a malformed emit never throws, and counts as a world event
    assert.equal(h.GetSelectedItemId(), MOB);
  });
});

console.log("\n[S4] source pin");
await check("selectionClock's selectionChanged handler reads the CustomEvent's detail", () => {
  const src = readFileSync(path.join(APP, "rynth", "webhost.js"), "utf8");
  const at = src.indexOf('bus.on("selectionChanged", (e) => {');
  assert.ok(at > 0, "the handler is where the lint expects it");
  const body = src.slice(at, src.indexOf("c.worldAt = ++c.seq;", at)).replace(/\/\/[^\n]*/g, "");
  assert.match(body, /const d = \(e && e\.detail\) \?\? e;/);
  assert.doesNotMatch(body, /\be\.(?:guid|prevGuid|lodRespawn)\b/, "no payload field is read off the Event");
  const api = readFileSync(path.join(APP, "plugins", "api.js"), "utf8");
  assert.match(api, /bus\.dispatchEvent\(new CustomEvent\(name, \{ detail: payload \}\)\)/, "the bus still wraps payloads in detail");
});

console.log(fail === 0 ? `rynth_selclock_detail: all ${pass} checks passed` : `rynth_selclock_detail: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
