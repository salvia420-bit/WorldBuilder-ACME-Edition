// tests/vendor_queue_vendor_switch.test.mjs — round-9 review, finding R9-8.
//
// `plugins/vendor-ui.js` `openWith()` (the kind=12 VendorOpened entry point)
// carried this comment:
//
//     // Preserve buy/sell queues across re-fires of the SAME vendor —
//     // ACE refreshes kind=12 after every buy. Drop the queues only
//     // when switching vendors.
//
// The first sentence was implemented (by doing nothing). The second had NO
// code behind it: there was no `vendorGuid` comparison and no queue reset
// anywhere in `openWith`. The queues were dropped only by `hideOverlay()`
// (vendor-ui.js:1444-1445).
//
// So `state.vendorState` was swapped to the NEW vendor while `state.buyQueue`
// still held the PREVIOUS vendor's item guids, and `handleConfirmBuy`
// (:1912-1918) sends them against the new vendor:
//
//     handle.buyFromVendor(vs.vendorGuid >>> 0, guids, amounts)
//
// ACE rejects a guid that isn't in that vendor's stock, so the user gets a
// "Buying N items…" toast and nothing bought — with the queue silently
// emptied afterwards (:1918). Trigger: two vendors inside the 24 m range
// watchdog (a shop with two NPCs, a bazaar row) — queue at A, use B without
// closing the bar.
//
// CONTRACT
//   [1] a kind=12 re-fire for the SAME vendor PRESERVES the queues (ACE
//       re-sends kind=12 after every buy — dropping here would erase a
//       half-built order);
//   [2] a kind=12 for a DIFFERENT vendor DROPS both queues;
//   [3] confirm-buy after a switch never sends the old vendor's guids.
//
// NEGATIVE CONTROL
//   "always clear the queues in openWith" fixes [2] but breaks [1], which is
//   the behaviour the original comment was protecting. Both directions are
//   asserted.
//
// Run from apps/holtburger-web/:
//   node tests/vendor_queue_vendor_switch.test.mjs

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
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

/* ── DOM / window surface ─────────────────────────────────────────────── */

function makeEl() {
  const el = {
    children: [], style: {}, dataset: {}, className: "", id: "",
    textContent: "", innerHTML: "", value: "",
    options: [],   // <select> stub — renderItemsPane walks refs.cat.options
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { if (c) el.children.push(c); return c; },
    // HUD overhaul 2026-10-05 — the kit-window rebuild uses these.
    replaceChildren(...c) { el.children = c.filter(Boolean); },
    prepend(c) { if (c) el.children.unshift(c); return c; },
    contains: () => false,
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    remove() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    setAttribute() {}, getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    focus() {},
  };
  return el;
}
globalThis.document = {
  createElement: makeEl,
  getElementById: () => null,
  head: makeEl(),
  body: makeEl(),
  addEventListener() {}, removeEventListener() {},
};

const buyCalls = [];
globalThis.window = {
  addEventListener() {}, removeEventListener() {},
  location: { search: "" },
  __pluginClient: null,
  __pluginClientReady: null,
  __sessionHandle: {
    buyFromVendor(vendorGuid, guids, amounts) {
      buyCalls.push({
        vendorGuid: vendorGuid >>> 0,
        guids: Array.from(guids).map((g) => g >>> 0),
        amounts: Array.from(amounts),
      });
    },
    playerInventory: () => [],
  },
  getLocalPlayerGuid: () => 0x50000001,
};
globalThis.performance = { now: () => 0 };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
globalThis.fetch = () => Promise.reject(new Error("no network in this suite"));

// Round 5: the player's purse / pack (a 10,000 p stack) and the notices.
const PYREAL_ROW = { guid: 0x7f000001, wcid: 273, name: "Pyreal", value: 10000, stackSize: 10000,
  itemType: 0x40, equipMask: 0, containerId: 0 };
let ROWS = [PYREAL_ROW];
globalThis.__rows = () => ROWS;
globalThis.__notices = [];

/* ── load the plugin ──────────────────────────────────────────────────── */

const INERT = "() => undefined";
const src = readFileSync(path.join(APP, "plugins", "vendor-ui.js"), "utf8");
// HUD overhaul 2026-10-05 — vendor-ui now builds on plugins/commerce_window.js
// (kit window + drop/icon helpers, stubbed here: no DOM) and prices through
// plugins/commerce_logic.js (pure — the REAL module is passed in, so the
// assertions below run against the shipped price rules).
const LOGIC_NAMES = [
  "vendorPurchasePrice", "vendorSaleCredit", "vendorAcceptability", "vendorRejectText",
  "VENDOR_ACCEPT", "countCurrency", "PYREAL_WCID", "fmtNumber", "fmtCompact",
  "sellStagingPlan",
  // items-1 step 2 (2026-10-08): split before sell.
  "planSellSplit", "resolveSellSplits", "SELL_SPLIT_FAILED_TEXT",
  // Round 5 (2026-10-08): buy-side refusals, line cost, supply, filters.
  "vendorLineCost", "vendorRemaining", "vendorBuySlotsNeeded", "vendorPlayerRoom", "vendorBuyRefusal",
  "VENDOR_TYPE_FILTERS", "VENDOR_MAX_QUEUED", "VENDOR_TOO_MUCH_TEXT",
];
const body = spliceModule(src, {
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
        setTitle() {}, toast() {},
      };
    }`,
    COMMERCE_WINDOW_ID: "Object.freeze({ VENDOR: 0x100000B7 })",
    KIT_COLOR: "Object.freeze({})",
    kitButton: "() => document.createElement('button')",
    fillSlotIcon: INERT,
    wireDropTarget: INERT,
    // Round 5: Buy checks the purse and the main pack (vendor-buy-1).
    inventoryRows: "() => globalThis.__rows()",
    chatNotice: "(t) => globalThis.__notices.push(String(t))",
    entityWorldPos: "() => null",
    localPlayerWorldPos: "() => null",
    devHex: "(g) => String(g >>> 0)",
    // Bug 3 (2026-10-07): the range math moved to plugins/vendor_range.js
    // (covered by tests/vendor_range_cylinder.test.mjs); inert here.
    vendorRangeVerdict: "() => ({ inRange: true, dist: 0, range: 0, mode: 'stub' })",
    VENDOR_FALLBACK_RANGE_M: "3.96",
  },
});
// eslint-disable-next-line no-new-func
const mod = new Function(
  ...LOGIC_NAMES,
  body + "\nreturn { mount, state, handleConfirmBuy, handleAddToBuying };\n",
)(...LOGIC_NAMES.map((n) => commerceLogic[n]));

mod.mount({ client: null });
const dbg = window.__vendorPluginDebugMount;
assert.ok(dbg?.openWith, "mount() must expose openWith on __vendorPluginDebugMount");

/* ── fixtures: two vendors, distinct stock ────────────────────────────── */

const VENDOR_A = 0x70000001;
const VENDOR_B = 0x70000002;
const A_ITEM = 0x80000011;
const B_ITEM = 0x80000022;

function rawVendor(vendorGuid, itemGuid, name) {
  return {
    vendorGuid,
    vendorName: name,
    buyMultiplier: 1.0,
    sellMultiplier: 0.6,
    alternateCurrencyWcid: 0,
    alternateCurrencyAmount: 0,
    alternateCurrencyName: "",
    items: [{
      itemGuid, wcid: 123, name: `${name} stock`,
      value: 100, stackSize: 1, itemType: 0x80, iconId: 0x06000001,
    }],
  };
}

/* ── [1] same-vendor re-fire preserves the queue ──────────────────────── */

dbg.openWith(rawVendor(VENDOR_A, A_ITEM, "Vendor A"));
mod.state.buyQueue = [{ itemGuid: A_ITEM, name: "A stock", value: 100, amount: 3 }];
mod.state.sellQueue = [{ itemGuid: 0x80000099, name: "junk", value: 5, amount: 1 }];

// ACE re-sends kind=12 after every buy; the bar must not lose the order.
dbg.openWith(rawVendor(VENDOR_A, A_ITEM, "Vendor A"));

check("a kind=12 re-fire for the SAME vendor preserves both queues", () => {
  assert.equal(mod.state.buyQueue.length, 1,
    "NEGATIVE CONTROL: clearing unconditionally erases a half-built order on ACE's own refresh");
  assert.equal(mod.state.sellQueue.length, 1);
});

/* ── [2] switching vendors drops the queues ───────────────────────────── */

dbg.openWith(rawVendor(VENDOR_B, B_ITEM, "Vendor B"));

check("switching to a DIFFERENT vendor drops the buy queue", () => {
  assert.equal(
    mod.state.buyQueue.length,
    0,
    `buyQueue still holds vendor A's guids after opening vendor B ` +
    `(${JSON.stringify(mod.state.buyQueue.map((q) => q.itemGuid))})`,
  );
});
check("switching to a DIFFERENT vendor drops the sell queue", () => {
  assert.equal(mod.state.sellQueue.length, 0);
});
check("the new vendor's own state is in place", () => {
  assert.equal(mod.state.vendorState.vendorGuid >>> 0, VENDOR_B);
});

/* ── [3] confirm-buy after a switch cannot send the old guids ─────────── */

buyCalls.length = 0;
mod.handleConfirmBuy();
check("confirm-buy right after a switch sends nothing (empty queue)", () => {
  assert.equal(buyCalls.length, 0, "an empty queue must short-circuit before the wire call");
});

// Now queue B's item properly and confirm the wire call is coherent.
mod.state.buyQueue = [{ itemGuid: B_ITEM, name: "B stock", value: 100, amount: 1 }];
buyCalls.length = 0;
mod.handleConfirmBuy();
check("a queue built at the CURRENT vendor sends that vendor's guids", () => {
  assert.equal(buyCalls.length, 1);
  assert.equal(buyCalls[0].vendorGuid, VENDOR_B);
  assert.deepEqual(buyCalls[0].guids, [B_ITEM]);
});

/* ── [4] vendor-buy-4: a same-vendor refresh drops unlisted entries ──── */

const A2_ITEM = 0x80000012;
function twoItemVendor(listed) {
  const v = rawVendor(VENDOR_A, A_ITEM, "Vendor A");
  if (listed.includes(A2_ITEM)) {
    v.items.push({ itemGuid: A2_ITEM, wcid: 124, name: "A unique", value: 50, stackSize: 1,
      itemType: 0x80, iconId: 0x06000002 });
  }
  if (!listed.includes(A_ITEM)) v.items = v.items.filter((i) => i.itemGuid !== A_ITEM);
  return v;
}
dbg.openWith(twoItemVendor([A_ITEM, A2_ITEM]));
mod.state.buyQueue = [
  { itemGuid: A_ITEM, name: "A stock", value: 100, amount: 1 },
  { itemGuid: A2_ITEM, name: "A unique", value: 50, amount: 1 },
];
dbg.openWith(twoItemVendor([A_ITEM, A2_ITEM]));
check("[4] a refresh that still lists both keeps both", () => {
  assert.deepEqual(mod.state.buyQueue.map((q) => q.itemGuid), [A_ITEM, A2_ITEM]);
});
dbg.openWith(twoItemVendor([A_ITEM]));
check("[4] a refresh without the unique drops it (gmVendorUI::OpenVendor updating)", () => {
  assert.deepEqual(mod.state.buyQueue.map((q) => q.itemGuid), [A_ITEM]);
});
buyCalls.length = 0;
mod.handleConfirmBuy();
check("[4] Buy All then sends only what is still for sale", () => {
  assert.equal(buyCalls.length, 1);
  assert.deepEqual(buyCalls[0].guids, [A_ITEM]);
});

/* ── [5] vendor-buy-1: retail refuses before sending, keeps the list ──── */

// Vendor A sells at 0.6: one 100-value item costs 60 p.
dbg.openWith(rawVendor(VENDOR_A, A_ITEM, "Vendor A"));
mod.state.buyQueue = [{ itemGuid: A_ITEM, name: "A stock", value: 100, amount: 3 }];
ROWS = [{ ...PYREAL_ROW, stackSize: 150 }];
globalThis.__notices.length = 0;
buyCalls.length = 0;
mod.handleConfirmBuy();
check("[5] Buy All the player can't afford sends nothing and keeps the list", () => {
  assert.equal(buyCalls.length, 0);
  assert.equal(mod.state.buyQueue.length, 1, "retail flushes the list only after a send");
  assert.deepEqual(globalThis.__notices, ["You don't have enough money"]);
});
ROWS = [{ ...PYREAL_ROW, stackSize: 180 }];
mod.handleConfirmBuy();
check("[5] with 180 p the same list is bought (3 x 60 = 180)", () => {
  assert.equal(buyCalls.length, 1);
  assert.deepEqual(buyCalls[0].amounts, [3]);
});
// A full main pack (102 items) refuses with the room text.
ROWS = [PYREAL_ROW, ...Array.from({ length: 101 }, (_, i) => ({
  guid: 0x7f100000 + i, wcid: 9, name: "junk", value: 1, stackSize: 1, itemType: 0x80, equipMask: 0, containerId: 0,
}))];
mod.state.buyQueue = [{ itemGuid: A_ITEM, name: "A stock", value: 100, amount: 1 }];
globalThis.__notices.length = 0;
buyCalls.length = 0;
mod.handleConfirmBuy();
check("[5] a full main pack refuses with retail's room text", () => {
  assert.equal(buyCalls.length, 0);
  assert.deepEqual(globalThis.__notices, ["You must empty some slots in your backpack first"]);
});
ROWS = [PYREAL_ROW];

/* ── [6] vendor-buy-3: supply, per-object price, the 5000 cap ─────────── */

const UNIQUE = 0x80000033, ARROWS = 0x80000034;
const stockVendor = rawVendor(VENDOR_A, A_ITEM, "Vendor A");
stockVendor.items.push(
  { itemGuid: UNIQUE, wcid: 125, name: "Unique sword", value: 5, stackSize: 1, itemType: 0x1,
    iconId: 0x06000003, supply: 1, maxStackSize: 1, packSlot: false },
  { itemGuid: ARROWS, wcid: 126, name: "Arrow", value: 1, stackSize: 1, itemType: 0x100,
    iconId: 0x06000004, supply: -1, maxStackSize: 250, packSlot: false },
);
dbg.openWith(stockVendor);
mod.state.buyQueue = [];
mod.state.selectedItemGuid = UNIQUE;
mod.state.qty = 3;
mod.handleAddToBuying();
check("[6] a supply-1 entry is queued once, whatever the quantity", () => {
  assert.deepEqual(mod.state.buyQueue.map((q) => [q.itemGuid, q.amount]), [[UNIQUE, 1]]);
});
mod.handleAddToBuying();
check("[6] nothing more is added once the list holds the whole supply", () => {
  assert.deepEqual(mod.state.buyQueue.map((q) => [q.itemGuid, q.amount]), [[UNIQUE, 1]]);
});
mod.state.buyQueue = [];
mod.state.selectedItemGuid = ARROWS;
mod.state.qty = 4000;
mod.handleAddToBuying();
globalThis.__notices.length = 0;
mod.state.qty = 2000;
mod.handleAddToBuying();
check("[6] an entry may not grow past 5000 (retail text, nothing changes)", () => {
  assert.deepEqual(mod.state.buyQueue.map((q) => [q.itemGuid, q.amount]), [[ARROWS, 4000]]);
  assert.deepEqual(globalThis.__notices,
    ["I can't possibly sell you that much! Please be a little more reasonable."]);
});
mod.state.buyQueue = [];

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
