// tests/use_target_inventory.test.mjs — usetarget-1/-2 (2026-10-18).
//
// Owner: "i tried to join two pyreal motes together in my inventory and
// couldn't" (two Pyreal Motes, wcid 6353: ItemUseable 0x80008 = source
// CONTAINED / target CONTAINED, TargetType 0x80, MaxStackSize 1 — ace_world
// recipe 790 makes a Pyreal Sliver). Use → "Choose a target" → a click on
// the other mote only SELECTED it: the inventory grid never resolved the
// pending use-on-target (window.__useTargeting, app/hud_panels.js).
//
// Retail: every item list resolves a left click in target mode —
// UIElement_ItemList::HandleTargetedUseLeftClick (acclient.c:272399) →
// ClientUISystem::ExecuteTargetModeForItem (:402078) → ItemHolder::
// TargetAcquired (:433578) → CM_Inventory::Event_UseWithTargetEvent. The main
// pack slot's UIItem IS the player (gmInventoryUI::RecvNotice_SetDisplay
// Inventory, :222199), so it targets yourself; dragged onto the toolbar it is
// a shortcut to yourself; UseObject on the player opens the main pack
// (CPlayerSystem::UsingItem :400434 → OpenContainedContainer).
//
// CONTRACT (plugins/inventory.js mounted on tests/helpers/fake_dom_items.mjs,
// the REAL app/hud_panels.js target flow and the REAL plugins/item_drag.js):
//   [1] grid: Use a mote → target mode; a click on the other mote sends
//       UseWithTarget(mote, otherMote) and ends the mode; the second press of
//       that double-click is not also a Use; dragging one mote onto the other
//       (our drag-to-combine contract, canUseWith-gated) sends it too;
//   [2] main pack slot in target mode → UseWithTarget(kit, player); a worn
//       item's paperdoll slot → the worn item (its dblclick does not unwield);
//       a side pack → the pack (refused by canUseWith → nothing sent, the
//       pack is not opened);
//   [3] hover outlines legal / illegal targets (Rust canUseWith), cleared on
//       leave and when the mode ends; without target mode clicks select/open;
//   [4] the main pack drags with the self MIME only (application/x-hb-self-
//       guid = the player); no item drop target acts on it;
//       activateItem(player) opens the main pack and sends no Use;
//   [5] `?useTargetGrid=off&selfShortcut=off` restore the old behaviour.
//
// Run from apps/holtburger-web/:  node tests/use_target_inventory.test.mjs

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
// activateItem spends retail's shared 0.2 s m_timeLastUsed.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const afterThrottle = () => sleep(220);

// ── fake session: Tester's two motes in a side pack, a kit, a worn sword ──
const ME = 0x50000001;
const PACK = 0x70000001, PACK2 = 0x70000002;
const MOTE_A = 0x60000101, MOTE_B = 0x60000102, GEM = 0x60000103;
const KIT = 0x60000104, TOOL = 0x60000105, SWORD = 0x60000106;
const row = (guid, name, extra = {}) => ({
  guid, name, wcid: guid & 0xff, iconId: 0, itemType: 0x80, stackSize: 1, equipMask: 0,
  containerId: 0, validLocations: 0, requiresBackpackSlot: false, itemsCapacity: 0, ...extra,
});
const inv = [
  row(PACK, "Sack", { requiresBackpackSlot: true, itemsCapacity: 24, itemType: 0x200 }),
  row(PACK2, "Pack", { requiresBackpackSlot: true, itemsCapacity: 24, itemType: 0x200 }),
  row(MOTE_A, "Pyreal Mote", { wcid: 6353, containerId: PACK, maxStackSize: 1 }),
  row(MOTE_B, "Pyreal Mote", { wcid: 6353, containerId: PACK, maxStackSize: 1 }),
  row(GEM, "Ruby", { itemType: 0x800, containerId: PACK }),
  row(KIT, "Handy Healing Kit"),
  row(TOOL, "Armor Tinkering Kit"),
  row(SWORD, "Long Sword", { itemType: 0x1, validLocations: 0x00100000, equipMask: 0x00100000 }),
];
// The Rust canUseWith answers for this inventory (ItemUseable / TargetType
// from the live ace_world rows: mote 0x80008 / 0x80, kit 0x220008 / 0x10).
const legal = new Set([
  `${MOTE_A}:${MOTE_B}`, `${MOTE_B}:${MOTE_A}`, `${MOTE_A}:${MOTE_A}`, `${MOTE_B}:${MOTE_B}`,
  `${KIT}:${ME}`, `${TOOL}:${SWORD}`,
]);
const calls = [];
const rec = (n) => (...a) => { calls.push([n, ...a]); };
const lastCall = (n) => [...calls].reverse().find((c) => c[0] === n) || null;
const countOf = (n) => calls.filter((c) => c[0] === n).length;
globalThis.__sessionHandle = {
  playerInventory: () => inv.map((r) => ({ ...r, free() {} })),
  playerItemsCapacity: 102,
  playerContainersCapacity: 7,
  playerBurden: 0.5,
  playerAetheriaBits: 0,
  canUseWith: (a, b) => legal.has(`${a >>> 0}:${b >>> 0}`),
  classifyUse: (g) => ({ needsTarget: [MOTE_A, MOTE_B, KIT, TOOL].includes(g >>> 0), free() {} }),
  useWithTarget: rec("useWithTarget"),
  useObject: rec("useObject"),
  moveItem: rec("moveItem"),
  mergeStacks: rec("mergeStacks"),
  setWielded: rec("setWielded"),
  unwieldToPack: rec("unwieldToPack"),
  dropItem: rec("dropItem"),
  giveObject: rec("giveObject"),
  getObjectIconId: () => 0,
};
const busL = new Map();
const toasts = [];
const bus = {
  on(n, f) { if (!busL.has(n)) busL.set(n, new Set()); busL.get(n).add(f); },
  off(n, f) { busL.get(n)?.delete(f); },
  emit(n, detail) {
    if (n === "clientActionRejected") toasts.push(detail?.message);
    for (const f of [...(busL.get(n) || [])]) f(detail);
  },
};
globalThis.__pluginClient = { events: bus, player: { stats: { name: "Tester" } } };
globalThis.getLocalPlayerGuid = () => ME;
globalThis.__pickEntityAt = () => 0;
globalThis.liveScene3d = { entityManager: { entityMap: new Map() } };
let panelTitle = "";
let panelOpen = true;
const shown = [];
globalThis.__mainPanel = {
  setTitle: (t) => { panelTitle = t; return true; },
  currentViewId: () => "inventory",
  isOpen: () => panelOpen,
  showView: (id) => { shown.push(id); panelOpen = true; },
};
const canvas = document.createElement("canvas");
canvas.id = "canvas";
document.body.appendChild(canvas);

// ── the REAL use-on-target flow: app/hud_panels.js on the legacy panel DOM ──
for (const id of [
  "vitals-panel", "vitals-name", "vitals-level", "vitals-bars", "inventory-panel", "inventory-empty",
  "inv-equipped-h", "inv-pack-h", "selected-item-box", "selected-item-name",
  "selected-item-use", "selected-item-examine", "selected-item-clear",
]) {
  const el = document.createElement("div");
  el.id = id;
  document.body.appendChild(el);
}
for (const id of ["attribute-table", "skill-table"]) {
  const t = document.createElement("table");
  t.id = id;
  t.appendChild(document.createElement("tbody"));
  document.body.appendChild(t);
}
for (const id of ["inv-equipped", "inv-pack"]) {
  const ul = document.createElement("ul");
  ul.id = id;
  document.body.appendChild(ul);
}
const { initHudPanels } = await import(pathToFileURL(path.join(APP, "app", "hud_panels.js")).href);
initHudPanels({ skillName: () => "", attributeName: () => "", vitalName: () => "" });
const T = globalThis.__useTargeting;
const tradeskill = await import(pathToFileURL(path.join(APP, "plugins", "tradeskill.js")).href);

// ── load inventory.js (spliced, as tests/inventory_dnd_dom.test.mjs) ──────
const helpers = await import(pathToFileURL(path.join(APP, "plugins", "inventory_helpers.js")).href);
const drag = await import(pathToFileURL(path.join(APP, "plugins", "item_drag.js")).href);
const tcycle = await import(pathToFileURL(path.join(APP, "scene3d", "target_cycle.js")).href);
globalThis.__T = { ...helpers, ...drag, consumeUseThrottle: tcycle.consumeUseThrottle };
const real = (names) => Object.fromEntries(names.map((n) => [n, `globalThis.__T.${n}`]));
const STUBS = {
  setAcText: "(el, t) => { if (el) el.textContent = String(t ?? ''); }",
  fetchIconDataUrlShared: "() => Promise.resolve(null)",
  getIconImmediate: "() => null",
  fetchItemIconDataUrl: "() => Promise.resolve(null)",
  getItemIconImmediate: "() => null",
  itemIconKey: "(m) => 'item:' + ((m && m.iconId) >>> 0)",
  PLAYER_PACK_ICON: "0x0600127E",
  ITEM_TYPE_CONTAINER: "0x200",
  uiEffectBadgesEnabled: "() => false",
  uiEffectIconsFor: "() => []",
  uiEffectTintCss: "() => null",
  PaperdollViewport: "class { constructor() { this.dom = document.createElement('canvas'); } loadPlayer() { return Promise.resolve(false); } start() {} dispose() {} }",
  ...real([
    "aetheriaSlotIsLocked", "formatBurdenText", "burdenMeterFraction", "computeInventoryTitle",
    "parseSlotsViewChecked", "canEquipInSlot", "buildPlayerEquipState", "formatAppraisalTooltip",
    "takeInventoryRows", "rowUsesPackSlot", "createPackOrder", "packCapacity",
    "DROP_TARGET", "MAIN_PACK_KEY", "PACKS_KEY", "decideItemDrop", "wieldEventTouchesLocal",
    "findAutoMergeTarget", "primaryUseAction", "defaultOnUrlFlag",
    "planWear", "planAmmoWield", "readySlotOccupant", "WEARABLE_LOCATIONS",
    "DEFAULT_PLAYER_ITEMS_CAPACITY", "DEFAULT_PLAYER_CONTAINERS_CAPACITY",
    "beginItemDrag", "registerDropZone", "resolveDropAction", "executeItemAction", "pendingOps",
    "showItemTooltip", "hideItemTooltip", "localPlayerGuid", "consumeUseThrottle",
  ]),
};
function loadInventory() {
  const src = readFileSync(path.join(APP, "plugins", "inventory.js"), "utf8");
  const body = spliceModule(src, { label: "plugins/inventory.js", provided: [], stubs: STUBS });
  return new Function(body + "\nreturn { view };")();
}

// ── DOM helpers ───────────────────────────────────────────────────────────
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
const $ = (sel) => document.querySelector(`#hb-inventory ${sel}`);
const grid = () => $(".hb-inv-items");
const cellOf = (g) => grid().children.find((c) => Number(c.dataset.guid) === g);
const packCell = (g) => $(`.hb-inv-bag[data-pack-guid="${g}"]`);
const mainSlot = () => $(".hb-inv-mainpack");
const weaponSlot = () => $('.hb-inv-doll-slot[data-name="Weapon"]');
const click = (el, init = {}) => el.dispatchEvent(new FakeEvent("click", { button: 0, detail: 1, ...init }));
const dblClick = async (el) => { click(el, { detail: 1 }); click(el, { detail: 2 }); await settle(); };

let view = loadInventory().view;
const body = document.createElement("div");
body.className = "hb-mp-body";
document.body.appendChild(body);
let unmount = view.mount(body, {});
await settle();
window.__inventory.openPack(PACK);
await settle();

console.log("\n[1] the inventory grid resolves an awaited use-on-target");
await check("setup: the side pack with both motes is open", () => {
  assert.equal(panelTitle, "Contents of Sack");
  assert.ok(cellOf(MOTE_A) && cellOf(MOTE_B) && cellOf(GEM));
});
await check("double-click a mote → retail target mode: 'Choose a target for Pyreal Mote'", async () => {
  await afterThrottle();
  await dblClick(cellOf(MOTE_A));
  assert.equal(T.pending?.itemGuid, MOTE_A);
  assert.match(toasts.at(-1), /^Choose a target for Pyreal Mote/);
  assert.ok(document.body.classList.contains("use-targeting"));
  assert.equal(countOf("useObject"), 0, "no bare Use");
});
await check("click the OTHER mote → UseWithTarget(mote, otherMote); the target mode ends", () => {
  const sel = cellOf(MOTE_B).classList.contains("is-selected");
  click(cellOf(MOTE_B));
  assert.deepEqual(lastCall("useWithTarget"), ["useWithTarget", MOTE_A, MOTE_B]);
  assert.equal(T.pending, null);
  assert.equal(document.body.classList.contains("use-targeting"), false);
  assert.equal(cellOf(MOTE_B).classList.contains("is-selected"), sel, "a target click is not a selection");
});
await check("the second press of that double-click is swallowed (no new target mode, no Use)", async () => {
  const n = calls.length;
  click(cellOf(MOTE_B), { detail: 2 });
  await settle();
  assert.equal(T.pending, null);
  assert.equal(calls.length, n);
});
await check("clicking the source mote itself is retail TargetAcquired too (the server says 'itself')", async () => {
  await afterThrottle();
  assert.equal(window.__inventory.activateItem(MOTE_A), true);
  click(cellOf(MOTE_A));
  assert.deepEqual(lastCall("useWithTarget"), ["useWithTarget", MOTE_A, MOTE_A]);
  assert.equal(T.pending, null);
});

await check("drag one mote onto the other → UseWithTarget(mote, otherMote) via the tradeskill dispatcher", async () => {
  // MaxStackSize 1, so no merge; Rust canUseWith gates the drag-to-combine
  // contract (inventory_helpers.decideItemDrop ITEM_CELL → op "usewith" →
  // item_drag "hb:inventory-item-on-item-drop" → plugins/tradeskill.js).
  const sends = [];
  const off = tradeskill.mount({ client: { useWithTarget: (a, b) => sends.push([a >>> 0, b >>> 0]) } });
  try {
    const n = countOf("moveItem") + countOf("mergeStacks");
    const dt = makeDT();
    cellOf(MOTE_B).dispatchEvent(new FakeEvent("dragstart", { dataTransfer: dt, clientX: 10, clientY: 10 }));
    cellOf(MOTE_A).dispatchEvent(new FakeEvent("dragover", { dataTransfer: dt, clientX: 20, clientY: 20 }));
    cellOf(MOTE_A).dispatchEvent(new FakeEvent("drop", { dataTransfer: dt, clientX: 20, clientY: 20 }));
    cellOf(MOTE_B).dispatchEvent(new FakeEvent("dragend", { dataTransfer: dt }));
    await settle();
    assert.deepEqual(sends, [[MOTE_B, MOTE_A]]);
    assert.equal(countOf("moveItem") + countOf("mergeStacks"), n, "no re-arrange, no merge");
  } finally { off(); }
});

console.log("\n[2] the main pack, the paperdoll and the pack list");
await check("kit pending + click the main pack slot (the player's UIItem) → UseWithTarget(kit, player)", async () => {
  await afterThrottle();
  assert.equal(window.__inventory.activateItem(KIT), true);
  assert.equal(T.pending?.itemGuid, KIT);
  click(mainSlot());
  await settle();
  assert.deepEqual(lastCall("useWithTarget"), ["useWithTarget", KIT, ME]);
  assert.equal(T.pending, null);
  assert.equal(panelTitle, "Contents of Sack", "the click targeted — it did not open the main pack");
});
await check("tool pending + click the worn sword's slot → UseWithTarget(tool, sword); its dblclick does not unwield", async () => {
  await afterThrottle();
  window.__inventory.activateItem(TOOL);
  assert.equal(T.pending?.itemGuid, TOOL);
  const slot = weaponSlot();
  assert.equal(Number(slot.dataset.itemGuid), SWORD);
  click(slot);
  assert.deepEqual(lastCall("useWithTarget"), ["useWithTarget", TOOL, SWORD]);
  slot.dispatchEvent(new FakeEvent("dblclick", { button: 0 }));
  await settle();
  assert.equal(countOf("unwieldToPack"), 0);
});
await check("a later dblclick on the slot (no target mode) still unwields", async () => {
  await sleep(520);
  weaponSlot().dispatchEvent(new FakeEvent("dblclick", { button: 0 }));
  assert.deepEqual(lastCall("unwieldToPack"), ["unwieldToPack", SWORD]);
});
await check("kit pending + click another side pack → the pack is the target: refused, nothing sent, not opened", async () => {
  await afterThrottle();
  window.__inventory.activateItem(KIT);
  const n = countOf("useWithTarget");
  click(packCell(PACK2));
  await settle();
  assert.equal(countOf("useWithTarget"), n);
  assert.equal(toasts.at(-1), "You cannot use the Handy Healing Kit on that.");
  assert.equal(T.pending, null);
  assert.equal(panelTitle, "Contents of Sack");
});

console.log("\n[3] hover feedback; no target mode = the old clicks");
await check("hover: a legal target is outlined green, an illegal one red; cleared on leave / cancel", async () => {
  await afterThrottle();
  window.__inventory.activateItem(MOTE_A);
  const b = cellOf(MOTE_B);
  const g = cellOf(GEM);
  b.dispatchEvent(new FakeEvent("mouseenter", { bubbles: false }));
  g.dispatchEvent(new FakeEvent("mouseenter", { bubbles: false }));
  assert.ok(b.classList.contains("use-target-ok"));
  assert.ok(g.classList.contains("use-target-bad"));
  b.dispatchEvent(new FakeEvent("mouseleave", { bubbles: false }));
  assert.equal(b.classList.contains("use-target-ok"), false);
  T.cancel();
  assert.equal(g.classList.contains("use-target-bad"), false, "cancel clears every outline");
  mainSlot().dispatchEvent(new FakeEvent("mouseenter", { bubbles: false }));
  assert.equal(mainSlot().classList.contains("use-target-bad"), false, "no outline without target mode");
  mainSlot().dispatchEvent(new FakeEvent("mouseleave", { bubbles: false }));
});
await check("without target mode a click selects the item and the main pack slot opens the main pack", async () => {
  const n = countOf("useWithTarget");
  click(cellOf(MOTE_B));
  assert.ok(cellOf(MOTE_B).classList.contains("is-selected"));
  click(mainSlot());
  await settle();
  assert.equal(panelTitle, "Inventory of Tester");
  assert.equal(countOf("useWithTarget"), n);
});

console.log("\n[4] the main pack as a shortcut to yourself");
await check("the main pack drags with the self MIME only (the player's guid), no item MIME", async () => {
  assert.equal(mainSlot().draggable, true);
  const dt = makeDT();
  mainSlot().dispatchEvent(new FakeEvent("dragstart", { dataTransfer: dt, clientX: 5, clientY: 5 }));
  assert.equal(dt.getData("application/x-hb-self-guid"), String(ME));
  assert.equal(dt.types.includes("application/x-hb-inv-guid"), false);
  assert.equal(dt.types.includes("text/x-hb-item-guid"), false);
  assert.equal(drag.SELF_MIME, "application/x-hb-self-guid");
  // Dropped on the grid or the 3D view it does nothing.
  const n = calls.length;
  const cell = cellOf(0) || grid().children[0];
  const over = new FakeEvent("dragover", { dataTransfer: dt });
  cell.dispatchEvent(over);
  assert.equal(over.defaultPrevented, false, "the grid does not accept it");
  cell.dispatchEvent(new FakeEvent("drop", { dataTransfer: dt }));
  canvas.dispatchEvent(new FakeEvent("drop", { dataTransfer: dt }));
  mainSlot().dispatchEvent(new FakeEvent("dragend", { dataTransfer: dt }));
  await settle();
  assert.equal(calls.length, n, "no wire call");
});
await check("activateItem(player) = retail UseObject on yourself: the main pack opens, no Use is sent", async () => {
  window.__inventory.openPack(PACK);
  await settle();
  panelOpen = false;
  shown.length = 0;
  await afterThrottle();
  assert.equal(window.__inventory.activateItem(ME), true);
  await settle();
  assert.deepEqual(shown, ["inventory"]);
  assert.equal(panelTitle, "Inventory of Tester");
  assert.equal(countOf("useObject"), 0);
  shown.length = 0;
  await afterThrottle();
  window.__inventory.activateItem(ME);
  assert.deepEqual(shown, [], "already showing the inventory → not re-shown");
});

console.log("\n[5] ?useTargetGrid=off&selfShortcut=off");
unmount();
location.search = "?useTargetGrid=off&selfShortcut=off";
view = loadInventory().view;
unmount = view.mount(body, {});
await settle();
window.__inventory.openPack(PACK);
await settle();
await check("useTargetGrid=off: a click on the other mote only selects it; the target mode stays", async () => {
  await afterThrottle();
  window.__inventory.activateItem(MOTE_A);
  assert.equal(T.pending?.itemGuid, MOTE_A);
  const n = countOf("useWithTarget");
  click(cellOf(MOTE_B));
  assert.equal(countOf("useWithTarget"), n);
  assert.ok(cellOf(MOTE_B).classList.contains("is-selected"));
  assert.equal(T.pending?.itemGuid, MOTE_A);
  T.cancel();
});
await check("selfShortcut=off: the main pack is not draggable and activateItem(player) is the caller's", async () => {
  assert.equal(mainSlot().draggable, false);
  await afterThrottle();
  assert.equal(window.__inventory.activateItem(ME), false);
});
unmount();
location.search = "";

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
