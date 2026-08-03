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

/* ── load the plugin ──────────────────────────────────────────────────── */

const INERT = "() => undefined";
const src = readFileSync(path.join(APP, "plugins", "vendor-ui.js"), "utf8");
const body = spliceModule(src, {
  label: "plugins/vendor-ui.js",
  provided: [],
  stubs: {
    setAcText: "(el, text) => { if (el) el.textContent = String(text ?? ''); }",
    HEADING_FONT_ID: "0",
    resolveLocalBinding: "() => null",
    matchesBinding: "() => false",
    LOCAL_ACTION_IDS: "Object.freeze({})",
    loadLayout: "() => Promise.resolve(null)",
    findElementById: "() => null",
    getCachedLayout: "() => null",
    fetchIconDataUrlShared: "() => Promise.resolve(null)",
    clearPlaceholderGlyph: INERT,
    DropItemFlags: "Object.freeze({ None: 0 })",
    isDropAccepted: "() => true",
    formatAppraisalTooltip: "() => null",
  },
});
// eslint-disable-next-line no-new-func
const mod = new Function(
  body + "\nreturn { mount, state, handleConfirmBuy };\n",
)();

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

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
