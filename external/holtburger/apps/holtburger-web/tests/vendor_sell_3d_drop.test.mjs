// tests/vendor_sell_3d_drop.test.mjs — inventory-session-4 (2026-10-13):
// the vendor-ui half of a whole stack dropped on a vendor in the 3D view.
//
// Retail ClientUISystem::AttemptSellToVendor (acclient.c:401304): for an
// item the player owns, when that vendor's window is open the item is added
// to the sell list (CM_Vendor::SendNotice_AddItemToSell); otherwise the
// vendor is Used (ItemHolder::UseObject) and attemptOpenVendorID /
// attemptSaleObjectID are remembered. ClientUISystem::Handle_VendorInfo
// (:402990) opens that vendor in SHOP_MODE_SELL and adds the item; ANY
// vendor info clears the attempt.
//
// plugins/vendor-ui.js spliced with the REAL commerce_logic, driven through
// window.__vendorUi.attemptSellToVendor and the real openWith (kind=12).
//
// Run from apps/holtburger-web/:  node tests/vendor_sell_3d_drop.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spliceModule } from "../harness/lib/splice_module.mjs";
import * as commerceLogic from "../plugins/commerce_logic.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
}

const ME = 0x50000001;
const ARROWS = 0x60000001;
const VENDOR = 0x70000001;
const OTHER = 0x70000002;
const row = (guid, extra = {}) => ({
  guid, wcid: 300, name: "Arrow", value: 200, stackSize: 100, itemType: 0x100, iconId: 0,
  equipMask: 0, containerId: 0, ...extra,
});

function makeEl() {
  const el = {
    children: [], style: {}, dataset: {}, className: "", id: "", textContent: "", innerHTML: "", value: "",
    options: [], classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { if (c) el.children.push(c); return c; },
    replaceChildren(...c) { el.children = c.filter(Boolean); },
    prepend(c) { if (c) el.children.unshift(c); return c; },
    contains: () => false,
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    remove() {}, addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    setAttribute() {}, getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    focus() {},
  };
  return el;
}
globalThis.document = {
  createElement: makeEl, getElementById: () => null, head: makeEl(), body: makeEl(),
  addEventListener() {}, removeEventListener() {},
};
const busL = new Map();
const bus = {
  on(n, f) { if (!busL.has(n)) busL.set(n, new Set()); busL.get(n).add(f); },
  off(n, f) { busL.get(n)?.delete(f); },
  emit(n, d) { for (const f of [...(busL.get(n) || [])]) f(d); },
};
const rawVendor = (guid = VENDOR) => ({
  vendorGuid: guid, vendorName: guid === VENDOR ? "Fletcher" : "Grocer", buyMultiplier: 0.9, sellMultiplier: 1.5,
  alternateCurrencyWcid: 0, alternateCurrencyAmount: 0, alternateCurrencyName: "",
  items: [{ itemGuid: 0x80000011, wcid: 7, name: "Bow", value: 100, stackSize: 1, itemType: 0x100, iconId: 0 }],
});
const used = [];
const toasts = [];
let rows = [row(ARROWS)];
globalThis.__rows = () => rows.map((r) => ({ ...r }));
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  location: { search: "" },
  __pluginClient: null,
  __pluginClientReady: null,
  __sessionHandle: {
    getVendorState: (g) => rawVendor(g >>> 0),
    useObject: (g) => used.push(g >>> 0),
    sellToVendor: () => {},
    playerInventory: () => [],
  },
  __itemDrag: { session: () => null },
  getLocalPlayerGuid: () => ME,
};
globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
globalThis.performance = { now: () => 0 };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
globalThis.fetch = () => Promise.reject(new Error("no network in this suite"));

const LOGIC_NAMES = [
  "vendorPurchasePrice", "vendorSaleCredit", "vendorAcceptability", "vendorRejectText",
  "VENDOR_ACCEPT", "countCurrency", "PYREAL_WCID", "fmtNumber", "fmtCompact",
  "sellStagingPlan", "planSellSplit", "resolveSellSplits", "SELL_SPLIT_FAILED_TEXT",
  "vendorLineCost", "vendorRemaining", "vendorBuySlotsNeeded", "vendorPlayerRoom", "vendorBuyRefusal",
  "VENDOR_TYPE_FILTERS", "VENDOR_MAX_QUEUED", "VENDOR_TOO_MUCH_TEXT",
].filter((n) => n in commerceLogic);
const INERT = "() => undefined";
const body = spliceModule(readFileSync(path.join(APP, "plugins", "vendor-ui.js"), "utf8"), {
  label: "plugins/vendor-ui.js",
  provided: LOGIC_NAMES,
  stubs: {
    setAcText: "(el, text) => { if (el) el.textContent = String(text ?? ''); }",
    formatAppraisalTooltip: "() => null",
    DropItemFlags: "Object.freeze({ VENDOR: 0x02 })",
    createKitWindow: `(o) => {
      const root = document.createElement('div');
      root.dataset.open = '0';
      const body = document.createElement('div');
      return {
        root, body,
        open() { root.dataset.open = '1'; },
        close() { root.dataset.open = '0'; if (o.onHide) o.onHide(); },
        isOpen: () => root.dataset.open === '1',
        setTitle() {}, toast(t, k) { globalThis.__toasts.push([t, k || 'ok']); },
      };
    }`,
    COMMERCE_WINDOW_ID: "Object.freeze({ VENDOR: 0x100000B7 })",
    KIT_COLOR: "Object.freeze({})",
    kitButton: "() => document.createElement('button')",
    fillSlotIcon: INERT,
    wireDropTarget: INERT,
    inventoryRows: "() => globalThis.__rows()",
    chatNotice: "() => {}",
    entityWorldPos: "() => null",
    localPlayerWorldPos: "() => null",
    devHex: "(g) => String(g >>> 0)",
    vendorRangeVerdict: "() => ({ inRange: true, dist: 0, range: 0, mode: 'stub' })",
    VENDOR_FALLBACK_RANGE_M: "3.96",
  },
});
globalThis.__toasts = toasts;
const mod = new Function(...LOGIC_NAMES, body + "\nreturn { mount, state };\n")(
  ...LOGIC_NAMES.map((n) => commerceLogic[n]),
);
const info = console.info;
console.info = () => {};
mod.mount({ client: { events: bus } });
console.info = info;
const ui = window.__vendorUi;
const openVendor = (guid) => {
  const i = console.info;
  console.info = () => {};
  try { bus.emit("kind:12", { detail: { u32Payload: guid } }); } finally { console.info = i; }
};
const reset = () => {
  if (mod.state.win?.isOpen?.()) mod.state.win.close();
  mod.state.sellQueue = [];
  mod.state.attemptOpenVendorID = 0;
  mod.state.attemptSaleObjectID = 0;
  used.length = 0; toasts.length = 0;
  rows = [row(ARROWS)];
};
const queued = () => mod.state.sellQueue.map((q) => [q.itemGuid, q.amount]);

console.log("\n[1] window.__vendorUi — AttemptSellToVendor / Handle_VendorInfo");
await check("exposes currentVendor / stageSell / attemptSellToVendor", () => {
  assert.equal(typeof ui?.currentVendor, "function");
  assert.equal(typeof ui?.stageSell, "function");
  assert.equal(typeof ui?.attemptSellToVendor, "function");
  assert.equal(typeof window.__vendorPluginDebug?.stageSell, "function", "the existing debug hook is kept");
});
await check("that vendor's window is open → the item is added to the sell list at once, no Use", () => {
  reset();
  openVendor(VENDOR);
  assert.equal(ui.currentVendor(), VENDOR);
  const r = ui.attemptSellToVendor(VENDOR, ARROWS);
  assert.deepEqual(r, { sent: true, staged: true });
  assert.deepEqual(queued(), [[ARROWS, 100]]);
  assert.equal(mod.state.currentTab, "selling");
  assert.deepEqual(used, []);
});
await check("no vendor open → Use the vendor; its VendorInfo opens on Selling with the item added", () => {
  reset();
  assert.equal(ui.currentVendor(), 0);
  assert.deepEqual(ui.attemptSellToVendor(VENDOR, ARROWS), { sent: true, staged: false });
  assert.deepEqual(used, [VENDOR]);
  assert.equal(mod.state.sellQueue.length, 0, "nothing staged before the shop opens");
  openVendor(VENDOR);
  assert.equal(mod.state.currentTab, "selling", "SHOP_MODE_SELL");
  assert.deepEqual(queued(), [[ARROWS, 100]]);
  assert.equal(mod.state.attemptOpenVendorID, 0, "the attempt is spent");
  assert.equal(mod.state.attemptSaleObjectID, 0);
});
await check("another vendor open → that window is not used; the dropped-on vendor is Used", () => {
  reset();
  openVendor(OTHER);
  assert.deepEqual(ui.attemptSellToVendor(VENDOR, ARROWS), { sent: true, staged: false });
  assert.deepEqual(used, [VENDOR]);
  assert.equal(mod.state.sellQueue.length, 0, "not staged on the other vendor");
  openVendor(VENDOR);
  assert.deepEqual(queued(), [[ARROWS, 100]]);
  assert.equal(mod.state.currentTab, "selling");
});
await check("a different vendor's info clears the attempt (Handle_VendorInfo) — later open = Items, nothing staged", () => {
  reset();
  ui.attemptSellToVendor(VENDOR, ARROWS);
  openVendor(OTHER);
  assert.equal(mod.state.currentTab, "items");
  assert.equal(mod.state.sellQueue.length, 0);
  mod.state.win.close();
  openVendor(VENDOR);
  assert.equal(mod.state.currentTab, "items");
  assert.equal(mod.state.sellQueue.length, 0);
});
await check("the item left the inventory before the shop opened → Selling tab, nothing staged, no error", () => {
  reset();
  ui.attemptSellToVendor(VENDOR, ARROWS);
  rows = [];
  openVendor(VENDOR);
  assert.equal(mod.state.currentTab, "selling");
  assert.equal(mod.state.sellQueue.length, 0);
  assert.equal(toasts.some((t) => t[1] === "err"), false);
});
await check("an item the player does not carry → nothing sent", () => {
  reset();
  rows = [];
  assert.deepEqual(ui.attemptSellToVendor(VENDOR, ARROWS), { sent: false, staged: false });
  assert.deepEqual(used, []);
  assert.equal(mod.state.attemptOpenVendorID, 0);
});
await check("an item the vendor will not buy → retail's refusal toast, nothing staged", () => {
  reset();
  rows = [row(ARROWS, { equipMask: 0x00800000 })];
  openVendor(VENDOR);
  ui.attemptSellToVendor(VENDOR, ARROWS);
  assert.equal(mod.state.sellQueue.length, 0);
  assert.equal(toasts.at(-1)?.[1], "err");
});
await check("a plain double-click open (no attempt) still starts on Items", () => {
  reset();
  openVendor(VENDOR);
  assert.equal(mod.state.currentTab, "items");
  assert.equal(mod.state.sellQueue.length, 0);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
