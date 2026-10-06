// tests/inventory_dnd_dom.test.mjs — HUD overhaul 2026-10-05.
//
// End-to-end (minus a browser) check of the retail drag & drop rebuild:
// plugins/inventory.js + plugins/corpse-loot-bar.js mounted on the fake DOM
// in tests/helpers/fake_dom_items.mjs, driven through the REAL
// plugins/item_drag.js window-capture listeners with synthetic
// dragstart / dragover / drop / dragend events, against a recording fake
// SessionHandle. Asserts the wire calls (retail placement math), the
// optimistic DOM (icon lands at once, ghosted, keyed cells reused) and the
// server-failure revert. Layout/visuals are the orchestrator's screenshots.
//
// Run from apps/holtburger-web/:  node tests/inventory_dnd_dom.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installFakeDom, FakeEvent } from "./helpers/fake_dom_items.mjs";
import { spliceModule } from "../harness/lib/splice_module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.stack || e.message}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 4; i++) await tick(); }

// ── fake session ────────────────────────────────────────────────────────
const ME = 0x50000001;
const P1 = 0x70000001;
const P2 = 0x70000002;
const A = 0x60000001, B = 0x60000002, C = 0x60000003, D = 0x60000004;
const S1 = 0x60000005, S2 = 0x60000006, SW = 0x60000007;
const CHEST = 0x7A000001, LOOT1 = 0x7B000001, LOOT2 = 0x7B000002;
const row = (guid, name, extra = {}) => ({
  guid, name, wcid: guid & 0xff, iconId: 0, itemType: 0x80, stackSize: 1, equipMask: 0,
  containerId: 0, validLocations: 0, requiresBackpackSlot: false, itemsCapacity: 0, ...extra,
});
let inv = [
  row(A, "Axe"), row(B, "Bread"), row(C, "Club"), row(D, "Dagger"),
  row(P1, "Pack", { requiresBackpackSlot: true, itemsCapacity: 24, itemType: 0x200 }),
  row(P2, "Pouch", { requiresBackpackSlot: true, itemsCapacity: 24, itemType: 0x200 }),
  row(S1, "Pyreal", { wcid: 273, stackSize: 50 }),
  row(S2, "Pyreal", { wcid: 273, stackSize: 20 }),
  row(SW, "Sword", { itemType: 0x1, validLocations: 0x00100000 }),
];
const calls = [];
const rec = (n) => (...a) => { calls.push([n, ...a]); };
const lastCall = (n) => [...calls].reverse().find((c) => c[0] === n) || null;
const chestContents = [LOOT1, LOOT2];
globalThis.__sessionHandle = {
  playerInventory: () => inv.map((r) => ({ ...r, free() {} })),
  playerItemsCapacity: 102,
  playerContainersCapacity: 7,
  playerBurden: 0.5,
  playerAetheriaBits: 0,
  canUseWith: () => false,
  getContainerContents: (g) => Uint32Array.from(g === CHEST ? chestContents : []),
  getObjectIconId: () => 0,
  groundContainerId: () => CHEST,
  moveItem: rec("moveItem"),
  mergeStacks: rec("mergeStacks"),
  setWielded: rec("setWielded"),
  splitStackToContainer: rec("splitStackToContainer"),
  dropItem: rec("dropItem"),
  giveObject: rec("giveObject"),
};
const busL = new Map();
const bus = {
  on(n, f) { if (!busL.has(n)) busL.set(n, new Set()); busL.get(n).add(f); },
  off(n, f) { busL.get(n)?.delete(f); },
  emit(n, detail) { for (const f of [...(busL.get(n) || [])]) f(detail); },
};
globalThis.__pluginClient = { events: bus, player: { stats: { name: "Tester" } } };
globalThis.getLocalPlayerGuid = () => ME;
globalThis.__pickEntityAt = () => 0;
globalThis.liveScene3d = { entityManager: { entityMap: new Map([[CHEST, { meta: { name: "Chest" } }]]) } };
let panelTitle = "";
globalThis.__mainPanel = { setTitle: (t) => { panelTitle = t; return true; }, currentViewId: () => "inventory", isOpen: () => true };
for (const id of ["inv-equipped", "inv-pack"]) {
  const ul = document.createElement("ul");
  ul.id = id;
  document.body.appendChild(ul);
}
const canvas = document.createElement("canvas");
canvas.id = "canvas";
document.body.appendChild(canvas);

// ── load modules: real helpers + real item_drag; inventory.js and
//    corpse-loot-bar.js spliced with explicit stubs for the browser-only
//    imports (three.js paperdoll, icon decoding, bitmap font). ──────────
const helpers = await import(pathToFileURL(path.join(APP, "plugins", "inventory_helpers.js")).href);
const drag = await import(pathToFileURL(path.join(APP, "plugins", "item_drag.js")).href);
const wpos = await import(pathToFileURL(path.join(APP, "ui", "ac_window_position.js")).href);
const kit = await import(pathToFileURL(path.join(APP, "ui", "hud_kit.js")).href);
globalThis.__T = { ...helpers, ...drag, ...wpos, ...kit };
const real = (names) => Object.fromEntries(names.map((n) => [n, `globalThis.__T.${n}`]));
const COMMON = {
  setAcText: "(el, t) => { if (el) el.textContent = String(t ?? ''); }",
  fetchIconDataUrlShared: "() => Promise.resolve(null)",
  getIconImmediate: "() => null",
  uiEffectIconsEnabled: "() => false",
  uiEffectIconsFor: "() => []",
  uiEffectTintCss: "() => null",
};
function load(rel, expose, stubs) {
  const src = readFileSync(path.join(APP, rel), "utf8");
  const body = spliceModule(src, { label: rel, provided: [], stubs });
  return new Function(body + `\nreturn { ${expose.join(", ")} };`)();
}
const inventoryMod = load("plugins/inventory.js", ["view"], {
  ...COMMON,
  PaperdollViewport: "class { constructor() { this.dom = document.createElement('canvas'); } loadPlayer() { return Promise.resolve(false); } start() {} dispose() {} }",
  ...real([
    "aetheriaSlotIsLocked", "formatBurdenText", "burdenMeterFraction", "computeInventoryTitle",
    "parseSlotsViewChecked", "canEquipInSlot", "buildPlayerEquipState", "formatAppraisalTooltip",
    "takeInventoryRows", "rowUsesPackSlot", "pickWieldSlotMask", "createPackOrder", "packCapacity",
    "mergeAmount", "DROP_TARGET", "MAIN_PACK_KEY", "PACKS_KEY", "decideItemDrop",
    "beginItemDrag", "registerDropZone", "resolveDropAction", "executeItemAction", "pendingOps",
    "showItemTooltip", "hideItemTooltip", "localPlayerGuid",
  ]),
});
const lootMod = load("plugins/corpse-loot-bar.js", ["openFor", "closeBar", "state"], {
  ...COMMON,
  fetchIconDataUrl: "() => Promise.resolve(null)",
  ...real([
    "attachWindowPosition", "makeTitlebar", "takeInventorySnapshot", "decideItemDrop", "DROP_TARGET",
    "MAIN_PACK_KEY", "PACKS_KEY", "beginItemDrag", "registerDropZone", "resolveDropAction", "executeItemAction",
    "pendingOps", "showItemTooltip", "hideItemTooltip", "showItemToast", "localPlayerGuid",
  ]),
});

// ── drag helpers ────────────────────────────────────────────────────────
function makeDT() {
  const data = new Map();
  return {
    types: [],
    effectAllowed: "", dropEffect: "",
    setData(t, v) { if (!data.has(t)) this.types.push(t); data.set(t, String(v)); },
    getData(t) { return data.get(t) ?? ""; },
    setDragImage() {},
  };
}
async function dragDrop(src, dst, { shiftKey = false } = {}) {
  const dt = makeDT();
  src.dispatchEvent(new FakeEvent("dragstart", { dataTransfer: dt, clientX: 10, clientY: 10, shiftKey }));
  const over = new FakeEvent("dragover", { dataTransfer: dt, clientX: 20, clientY: 20, shiftKey });
  dst.dispatchEvent(over);
  const drop = new FakeEvent("drop", { dataTransfer: dt, clientX: 20, clientY: 20, shiftKey });
  dst.dispatchEvent(drop);
  src.dispatchEvent(new FakeEvent("dragend", { dataTransfer: dt }));
  await settle();
  return { over, drop };
}
const grid = () => document.querySelector("#hb-inventory .hb-inv-items");
const gridGuids = () => grid().children.filter((c) => !c.dataset.empty).map((c) => Number(c.dataset.guid));
const cellOf = (g) => grid().children.find((c) => Number(c.dataset.guid) === g);
const packCell = (g) => document.querySelector(`#hb-inventory .hb-inv-bag[data-pack-guid="${g}"]`);

// ── mount ───────────────────────────────────────────────────────────────
const body = document.createElement("div");
body.className = "hb-mp-body";
document.body.appendChild(body);
const unmount = inventoryMod.view.mount(body, {});
await settle();

console.log("\n[1] layout + data");
await check("grid shows main-pack items (packs in the column, not the grid), padded to capacity", () => {
  assert.deepEqual(gridGuids(), [A, B, C, D, S1, S2, SW]);
  assert.equal(grid().children.length, 102, "ItemsCapacity 102 → 102 cells");
  assert.ok(grid().classList.contains("hbk-scroll"), "grid scrolls with the rope scrollbar");
});
await check("backpack column: main pack + 2 packs + empty slots to ContainersCapacity 7", () => {
  const bags = document.querySelectorAll("#hb-inventory .hb-inv-packlist .hb-inv-bag");
  assert.equal(bags.length, 7);
  assert.deepEqual(bags.slice(0, 2).map((b) => Number(b.dataset.packGuid)), [P1, P2]);
  assert.ok(document.querySelector("#hb-inventory .hb-inv-mainpack").classList.contains("is-open"));
});
await check("burden: retail percent text + meter fill (full at 300 %)", () => {
  assert.equal(document.querySelector("#hb-inventory .hb-inv-burden-pct").textContent, "50%");
  const fill = document.querySelector("#hb-inventory .hb-inv-burden-meter").firstChild.style.getPropertyValue("--fill");
  assert.equal(fill, "16.7%");
});
await check("title is the retail 'Inventory of <name>'", () => {
  assert.equal(panelTitle, "Inventory of Tester");
});

console.log("\n[2] drag & drop through item_drag.js");
await check("drop Axe on Club's cell → moveItem(Axe, me, 1); lands at once, ghosted, same node", async () => {
  const axeCell = cellOf(A);
  const { over } = await dragDrop(axeCell, cellOf(C));
  assert.equal(over.defaultPrevented, true, "dragover accepted");
  assert.deepEqual(lastCall("moveItem"), ["moveItem", A, ME, 1]);
  assert.deepEqual(gridGuids().slice(0, 4), [B, A, C, D]);
  assert.equal(cellOf(A), axeCell, "keyed cell reused, not rebuilt");
  assert.ok(cellOf(A).classList.contains("is-pending"), "waiting state until the server echoes");
});
await check("server echo resolves the wait; the arrangement survives the name-sorted snapshot", async () => {
  bus.emit("playerInventoryChanged", {});
  await settle();
  assert.equal(cellOf(A).classList.contains("is-pending"), false);
  assert.deepEqual(gridGuids().slice(0, 4), [B, A, C, D]);
});
await check("drop Bread on a side pack → moveItem(Bread, pack, 0); refused by server → reverts in place", async () => {
  await dragDrop(cellOf(B), packCell(P1));
  assert.deepEqual(lastCall("moveItem"), ["moveItem", B, P1, 0]);
  assert.equal(gridGuids().includes(B), false, "optimistically left the main pack");
  bus.emit("inventoryActionFailed", { u32Payload: B, u32Payload2: 0x0029 });
  await settle();
  assert.deepEqual(gridGuids().slice(0, 4), [B, A, C, D], "back where it was");
});
await check("stack onto a matching stack → mergeStacks(src, dst, whole stack)", async () => {
  await dragDrop(cellOf(S1), cellOf(S2));
  assert.deepEqual(lastCall("mergeStacks"), ["mergeStacks", S1, S2, 50]);
  assert.ok(cellOf(S1).classList.contains("is-pending"));
});
await check("pack dragged onto the first pack slot → re-ordered in the container list", async () => {
  await dragDrop(packCell(P2), packCell(P1));
  assert.deepEqual(lastCall("moveItem"), ["moveItem", P2, ME, 0]);
  const bags = document.querySelectorAll("#hb-inventory .hb-inv-packlist .hb-inv-bag");
  assert.deepEqual(bags.slice(0, 2).map((b) => Number(b.dataset.packGuid)), [P2, P1]);
});
await check("sword onto the Weapon slot → setWielded(sword, MeleeWeapon); shown ghosted on the doll", async () => {
  const slot = document.querySelector('#hb-inventory .hb-inv-doll-slot[data-name="Weapon"]');
  await dragDrop(cellOf(SW), slot);
  assert.deepEqual(lastCall("setWielded"), ["setWielded", SW, 0x00100000]);
  assert.equal(gridGuids().includes(SW), false);
  assert.equal(Number(slot.dataset.itemGuid), SW);
  assert.ok(slot.classList.contains("is-pending"));
});
await check("pack onto the item grid → refused ('Cannot place container in item list'), no wire", async () => {
  const before = calls.length;
  const target = cellOf(C);
  const dt = makeDT();
  packCell(P1).dispatchEvent(new FakeEvent("dragstart", { dataTransfer: dt }));
  target.dispatchEvent(new FakeEvent("dragover", { dataTransfer: dt }));
  assert.ok(target.classList.contains("is-drop-reject"), "red highlight while hovering");
  target.dispatchEvent(new FakeEvent("drop", { dataTransfer: dt }));
  packCell(P1).dispatchEvent(new FakeEvent("dragend", { dataTransfer: dt }));
  await settle();
  assert.equal(target.classList.contains("is-drop-reject"), false, "highlight cleared");
  assert.equal(calls.length, before);
  assert.equal(document.getElementById("hb-item-toast")?.textContent, "Cannot place container in item list");
});
await check("shift-drop asks for an amount, then StackableSplitToContainer", async () => {
  const empty = grid().children.find((c) => c.dataset.empty);
  const dt = makeDT();
  cellOf(S2).dispatchEvent(new FakeEvent("dragstart", { dataTransfer: dt, clientX: 5, clientY: 5 }));
  empty.dispatchEvent(new FakeEvent("dragover", { dataTransfer: dt, shiftKey: true }));
  empty.dispatchEvent(new FakeEvent("drop", { dataTransfer: dt, shiftKey: true, clientX: 50, clientY: 50 }));
  cellOf(S2).dispatchEvent(new FakeEvent("dragend", { dataTransfer: dt }));
  await settle();
  const prompt = document.getElementById("hb-stack-split");
  assert.equal(prompt?.dataset.open, "1", "split prompt open");
  const num = prompt.querySelector("input.hbk-input");
  num.value = "7";
  prompt.querySelector('[data-act="ok"]').click();
  await settle();
  const c = lastCall("splitStackToContainer");
  assert.equal(c[1], S2);
  assert.equal(c[2], ME);
  assert.equal(c[4], 7);
});
await check("drop on the 3D view (no entity) → DropItem", async () => {
  await dragDrop(cellOf(D), canvas);
  assert.deepEqual(lastCall("dropItem"), ["dropItem", D]);
});
await check("drop on an NPC → give the whole stack (not also a ground drop)", async () => {
  globalThis.__pickEntityAt = () => 0x7C000001;
  globalThis.liveScene3d.entityManager.entityMap.set(0x7C000001, { meta: { name: "Guard", itemType: 0x10 } });
  const drops = calls.filter((c) => c[0] === "dropItem").length;
  await dragDrop(cellOf(C), canvas);
  assert.deepEqual(lastCall("giveObject"), ["giveObject", 0x7C000001, C, 1]);
  assert.equal(calls.filter((c) => c[0] === "dropItem").length, drops, "no double action");
  globalThis.__pickEntityAt = () => 0;
});

console.log("\n[2b] clicks, tooltips, packs");
await check("hover shows the shared item tooltip; click selects (ItemSlot_Icon_Selected)", () => {
  const cell = cellOf(C);
  cell.dispatchEvent(new FakeEvent("mouseenter", { bubbles: false }));
  const tip = document.getElementById("hb-item-tooltip");
  assert.equal(tip?.dataset.show, "1");
  assert.equal(tip.textContent, "Club");
  cell.dispatchEvent(new FakeEvent("mouseleave", { bubbles: false }));
  assert.equal(tip.dataset.show, "0");
  cell.dispatchEvent(new FakeEvent("click", { button: 0, detail: 1 }));
  assert.ok(cell.classList.contains("is-selected"));
});
await check("right-click opens the polymorphic context menu with a srcLi", () => {
  let ctx = null;
  globalThis.__openContextMenuFor = (c) => { ctx = c; };
  cellOf(C).dispatchEvent(new FakeEvent("contextmenu", { clientX: 3, clientY: 4 }));
  assert.equal(ctx?.source, "inv-grid");
  assert.equal(ctx.guid, C);
  assert.equal(Number(ctx.srcLi.dataset.guid), C);
});
await check("double-click equips via the shared action path (setWielded + waiting state)", async () => {
  inv.push(row(0x60000008, "Mace", { itemType: 0x1, validLocations: 0x00100000 }));
  bus.emit("playerInventoryChanged", {});
  await settle();
  cellOf(0x60000008).dispatchEvent(new FakeEvent("click", { button: 0, detail: 2 }));
  await settle();
  assert.deepEqual(lastCall("setWielded"), ["setWielded", 0x60000008, 0x00100000]);
});
await check("clicking a side pack opens it (retitled 'Contents of …', open-container arrow)", async () => {
  inv.push(row(0x60000009, "Gem", { containerId: P1 }));
  bus.emit("playerInventoryChanged", {});
  await settle();
  packCell(P1).dispatchEvent(new FakeEvent("click", { button: 0 }));
  await settle();
  assert.equal(panelTitle, "Contents of Pack");
  assert.ok(packCell(P1).classList.contains("is-open"));
  assert.deepEqual(gridGuids(), [0x60000009]);
  assert.equal(grid().children.length, 24, "side pack ItemsCapacity 24");
  document.querySelector("#hb-inventory .hb-inv-mainpack").dispatchEvent(new FakeEvent("click", { button: 0 }));
  await settle();
  assert.equal(panelTitle, "Inventory of Tester");
});
await check("window.__inventory.openPack selects a pack from outside (container-panel 'Open')", async () => {
  window.__inventory.openPack(P1);
  await settle();
  assert.equal(panelTitle, "Contents of Pack");
  window.__inventory.openPack(0);
  await settle();
  assert.equal(panelTitle, "Inventory of Tester");
});

console.log("\n[3] external container window (chest)");
lootMod.openFor(CHEST, "Chest");
await settle();
const ext = document.getElementById("hb-corpse-loot-bar");
const extCell = (g) => ext.querySelector(`.hb-islot[data-guid="${g}"]`);
await check("opens as a kit window with the contents strip and a placed position", () => {
  assert.equal(ext.dataset.open, "1");
  assert.ok(ext.classList.contains("hbk-window"));
  assert.ok(ext.querySelector(".hbk-titlebar .hbk-close"));
  assert.ok(extCell(LOOT1) && extCell(LOOT2));
  assert.notEqual(ext.style.left, "", "positioned by placeWindow (not a vw transform)");
});
await check("double-click takes into the main pack: moveItem(item, me, 0), ghost in both places", async () => {
  extCell(LOOT1).dispatchEvent(new FakeEvent("dblclick", { button: 0 }));
  await settle();
  assert.deepEqual(lastCall("moveItem"), ["moveItem", LOOT1, ME, 0]);
  assert.ok(extCell(LOOT1).classList.contains("is-pending"));
  assert.equal(gridGuids()[0], LOOT1, "ghost lands at the front of the main pack");
  assert.ok(cellOf(LOOT1).classList.contains("is-pending"));
});
await check("drag a chest item onto a grid cell → moveItem into the player at that index", async () => {
  await dragDrop(extCell(LOOT2), cellOf(C));
  const c = lastCall("moveItem");
  assert.equal(c[1], LOOT2);
  assert.equal(c[2], ME);
  assert.ok(gridGuids().indexOf(LOOT2) >= 0, "stub shown at the drop position");
});
await check("drag an inventory item onto the chest strip → moveItem(item, chest, index)", async () => {
  await dragDrop(cellOf(A), ext.querySelector(".hclb-strip"));
  const c = lastCall("moveItem");
  assert.deepEqual([c[1], c[2]], [A, CHEST]);
});
await check("server CloseGroundContainer closes the window", () => {
  bus.emit("containerClosed", { u32Payload: CHEST });
  assert.equal(ext.dataset.open, "0");
});

unmount();
await check("unmount removes the view and its zones", () => {
  assert.equal(document.getElementById("hb-inventory"), null);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
