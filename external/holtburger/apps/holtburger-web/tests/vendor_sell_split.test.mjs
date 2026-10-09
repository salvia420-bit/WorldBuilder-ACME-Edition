// tests/vendor_sell_split.test.mjs — items-1 step 2 (2026-10-08): split
// before sell.
//
// Retail VendorSellUI::AcceptDragObject (acclient.c:246860): a drag that
// carries a split size first splits the stack IN PLACE
// (ItemHolder::AttemptToPlaceInContainer(item, player, its container,
// autoMerge 0) → StackableSplitToContainer) with "Splitting the %s before
// selling them" ("Cannot split the stack to sell it" on failure), remembers
// the split's wcid + size, and VendorSellUI::ItemAttributesChanged (:246005)
// stages the NEW object of that wcid and size when it arrives. A sale is
// always a whole stack (step 1, sellStagingPlan), so this is the only way to
// sell part of one. Browser equivalent of retail's splitSize: a SHIFT-drop
// on the vendor asks for the amount (item_drag's stack prompt).
//
//   [1] pure: commerce_logic.planSellSplit / resolveSellSplits;
//   [2] plugins/vendor-ui.js spliced with the REAL commerce_logic: shift-drop
//       → prompt → split sent through item_drag.executeItemAction; the new
//       stack staged on playerInventoryChanged and sold at its own size; a
//       server refusal toasts the retail text; no shift / whole amount /
//       cancel keep step 1's whole-stack staging.
//
// Run from apps/holtburger-web/:  node tests/vendor_sell_split.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spliceModule } from "../harness/lib/splice_module.mjs";
import * as commerceLogic from "../plugins/commerce_logic.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const { planSellSplit, resolveSellSplits, SELL_SPLIT_TTL_MS, SELL_SPLIT_FAILED_TEXT } = commerceLogic;

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
}

const ME = 0x50000001;
const PACK = 0x70000010;
const ARROWS = 0x60000001;
const row = (guid, extra = {}) => ({
  guid, wcid: 300, name: "Arrow", value: 200, stackSize: 100, itemType: 0x100, iconId: 0,
  equipMask: 0, containerId: 0, ...extra,
});

/* ── [1] pure ─────────────────────────────────────────────────────────── */
console.log("\n[1] planSellSplit / resolveSellSplits");
await check("selling 30 of 100 → split in place (main pack → the player) with the retail text", () => {
  const rows = [row(ARROWS), row(0x60000002, { wcid: 1 })];
  const p = planSellSplit(rows[0], 30, rows, { playerGuid: ME });
  assert.deepEqual(p.action, { op: "move", guid: ARROWS, container: ME, placement: 0, listKey: 0, index: 0, amount: 30 });
  assert.equal(p.message, "Splitting the Arrows before selling them");
  assert.deepEqual(p.pending, {
    sourceGuid: ARROWS, wcid: 300, amount: 30, containerId: ME, name: "Arrow", preGuids: [ARROWS, 0x60000002],
  });
});
await check("a side-pack stack splits into that pack", () => {
  const r = row(ARROWS, { containerId: PACK });
  const p = planSellSplit(r, 10, [r], { playerGuid: ME });
  assert.equal(p.action.container, PACK);
  assert.equal(p.action.listKey, PACK);
});
await check("whole stack, out-of-range or single item → no split (null)", () => {
  const r = row(ARROWS);
  assert.equal(planSellSplit(r, 100, [r], { playerGuid: ME }), null);
  assert.equal(planSellSplit(r, 0, [r], { playerGuid: ME }), null);
  assert.equal(planSellSplit(row(ARROWS, { stackSize: 1 }), 1, [r], { playerGuid: ME }), null);
});
await check("no container known → refused with 'Cannot split the stack to sell it'", () => {
  assert.deepEqual(planSellSplit(row(ARROWS), 5, [], { playerGuid: 0 }), { reject: SELL_SPLIT_FAILED_TEXT });
});
await check("resolve: the NEW stack of that wcid and exact size wins — not a pre-existing equal stack", () => {
  const old = row(0x60000003, { stackSize: 30 });       // already had a stack of 30
  const src = row(ARROWS, { stackSize: 70 });           // the source shrank
  const pending = [{ ...planSellSplit(row(ARROWS), 30, [row(ARROWS), old], { playerGuid: ME }).pending, at: 0 }];
  assert.equal(resolveSellSplits(pending, [src, old], { now: 1 }).staged.length, 0, "no echo yet");
  const fresh = row(0x60000009, { stackSize: 30 });
  const r = resolveSellSplits(pending, [src, old, fresh], { now: 1 });
  assert.equal(r.staged.length, 1);
  assert.equal(r.staged[0].row.guid, 0x60000009);
  assert.equal(r.waiting.length, 0);
});
await check("resolve: two splits of the same size claim two different stacks; staged guids are skipped", () => {
  const base = { wcid: 300, amount: 5, sourceGuid: ARROWS, preGuids: [ARROWS], at: 0 };
  const a = row(0x60000011, { stackSize: 5 });
  const b = row(0x60000012, { stackSize: 5 });
  const r = resolveSellSplits([base, { ...base }], [a, b], { now: 1 });
  assert.deepEqual(r.staged.map((s) => s.row.guid), [a.guid, b.guid]);
  const r2 = resolveSellSplits([base], [a, b], { now: 1, claimed: new Set([a.guid]) });
  assert.equal(r2.staged[0].row.guid, b.guid);
});
await check("resolve: no echo within the TTL → expired, not staged", () => {
  const p = { wcid: 300, amount: 5, sourceGuid: ARROWS, preGuids: [], at: 0 };
  assert.equal(resolveSellSplits([p], [], { now: SELL_SPLIT_TTL_MS - 1 }).waiting.length, 1);
  assert.equal(resolveSellSplits([p], [], { now: SELL_SPLIT_TTL_MS + 1 }).expired.length, 1);
});

/* ── [2] vendor-ui flow ───────────────────────────────────────────────── */
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
const VENDOR = 0x70000001;
const rawVendor = () => ({
  vendorGuid: VENDOR, vendorName: "Fletcher", buyMultiplier: 0.9, sellMultiplier: 1.5,
  alternateCurrencyWcid: 0, alternateCurrencyAmount: 0, alternateCurrencyName: "",
  items: [{ itemGuid: 0x80000011, wcid: 7, name: "Bow", value: 100, stackSize: 1, itemType: 0x100, iconId: 0 }],
});
const sold = [];
const toasts = [];
const sent = [];
let promptAnswer = 30;
let execResult = true;
let rows = [row(ARROWS)];
globalThis.__rows = () => rows.map((r) => ({ ...r }));
globalThis.window = {
  addEventListener() {}, removeEventListener() {},
  location: { search: "" },
  __pluginClient: null,
  __pluginClientReady: null,
  __sessionHandle: {
    getVendorState: () => rawVendor(),
    sellToVendor: (v, guids, amounts) => sold.push({ v: v >>> 0, guids: Array.from(guids), amounts: Array.from(amounts) }),
    playerInventory: () => [],
  },
  __itemDrag: {
    session: () => null,
    promptStackAmount: async (o) => { sent.push(["prompt", o.max]); return promptAnswer; },
    executeItemAction: (action, s) => { sent.push(["exec", action, s.guid]); return execResult; },
  },
  getLocalPlayerGuid: () => ME,
};
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
  // Round 5 (2026-10-08): buy-side refusals, line cost, supply, filters.
  "vendorLineCost", "vendorRemaining", "vendorBuySlotsNeeded", "vendorPlayerRoom", "vendorBuyRefusal",
  "VENDOR_TYPE_FILTERS", "VENDOR_MAX_QUEUED", "VENDOR_TOO_MUCH_TEXT",
];
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
const mod = new Function(...LOGIC_NAMES, body + "\nreturn { mount, state, handleConfirmSell };\n")(
  ...LOGIC_NAMES.map((n) => commerceLogic[n]),
);
const info = console.info;
console.info = () => {};
mod.mount({ client: { events: bus } });
window.__vendorPluginDebugMount.openWith(rawVendor());
console.info = info;
const stage = (guid, opts) => window.__vendorPluginDebug.stageSell(guid, opts);
const reset = () => {
  mod.state.sellQueue = []; mod.state.sellSplits = [];
  sent.length = 0; toasts.length = 0; sold.length = 0;
  rows = [row(ARROWS)]; promptAnswer = 30; execResult = true;
};

console.log("\n[2] vendor-ui: shift-drop → split → stage the new stack");
await check("shift-drop asks how many, sends the split, toasts retail's text and stages NOTHING yet", async () => {
  reset();
  await stage(ARROWS, { split: true });
  assert.deepEqual(sent[0], ["prompt", 100]);
  assert.deepEqual(sent[1], ["exec", { op: "move", guid: ARROWS, container: ME, placement: 0, listKey: 0, index: 0, amount: 30 }, ARROWS]);
  assert.deepEqual(toasts.at(-1), ["Splitting the Arrows before selling them", "ok"]);
  assert.equal(mod.state.sellQueue.length, 0, "the source stack is never staged (it would sell all 100)");
  assert.equal(mod.state.sellSplits.length, 1);
});
await check("the server's new stack (inventory echo) is staged at its own size and sold as such", async () => {
  rows = [row(ARROWS, { stackSize: 70 }), row(0x60000077, { stackSize: 30, value: 60 })];
  bus.emit("playerInventoryChanged", {});
  assert.equal(mod.state.sellSplits.length, 0);
  assert.deepEqual(mod.state.sellQueue.map((q) => [q.itemGuid, q.amount, q.stackSize, q.value]), [[0x60000077, 30, 30, 60]]);
  assert.equal(mod.state.currentTab, "selling");
  mod.handleConfirmSell();
  assert.deepEqual(sold, [{ v: VENDOR, guids: [0x60000077], amounts: [30] }]);
});
await check("a server refusal of the split → 'Cannot split the stack to sell it', nothing staged", async () => {
  reset();
  await stage(ARROWS, { split: true });
  bus.emit("inventoryActionFailed", { u32Payload: ARROWS, u32Payload2: 0 });
  assert.deepEqual(toasts.at(-1), [SELL_SPLIT_FAILED_TEXT, "err"]);
  assert.equal(mod.state.sellSplits.length, 0);
  rows = [row(ARROWS, { stackSize: 70 }), row(0x60000078, { stackSize: 30 })];
  bus.emit("playerInventoryChanged", {});
  assert.equal(mod.state.sellQueue.length, 0, "a late echo is not staged after the refusal");
});
await check("the split could not be sent → the retail failure text, no pending split", async () => {
  reset();
  execResult = false;
  await stage(ARROWS, { split: true });
  assert.deepEqual(toasts.at(-1), [SELL_SPLIT_FAILED_TEXT, "err"]);
  assert.equal(mod.state.sellSplits.length, 0);
});
await check("the whole amount chosen → the stack is staged whole, no split", async () => {
  reset();
  promptAnswer = 100;
  await stage(ARROWS, { split: true });
  assert.equal(sent.some((c) => c[0] === "exec"), false);
  assert.deepEqual(mod.state.sellQueue.map((q) => [q.itemGuid, q.amount]), [[ARROWS, 100]]);
});
await check("prompt cancelled → nothing staged, nothing sent", async () => {
  reset();
  promptAnswer = null;
  await stage(ARROWS, { split: true });
  assert.equal(mod.state.sellQueue.length, 0);
  assert.equal(sent.some((c) => c[0] === "exec"), false);
});
await check("a plain drop (no shift) keeps step 1: the whole stack, staged synchronously", () => {
  reset();
  stage(ARROWS);
  assert.deepEqual(mod.state.sellQueue.map((q) => [q.itemGuid, q.amount]), [[ARROWS, 100]]);
  assert.equal(sent.length, 0, "no prompt");
});
await check("a shift-drop of a pack sells its contents — no prompt", async () => {
  reset();
  rows = [
    row(PACK, { name: "Pack", itemType: 0x200, stackSize: 1, value: 10 }),
    row(0x60000031, { containerId: PACK, stackSize: 40 }),
  ];
  await stage(PACK, { split: true });
  assert.equal(sent.length, 0);
  assert.deepEqual(mod.state.sellQueue.map((q) => [q.itemGuid, q.amount]), [[0x60000031, 40]]);
});
await check("an inventory update while the prompt is up (vendor state re-pulled, stack shrank) does not lose the drop", async () => {
  reset();
  const prompt = window.__itemDrag.promptStackAmount;
  window.__itemDrag.promptStackAmount = async () => {
    rows = [row(ARROWS, { stackSize: 40 })];
    bus.emit("playerInventoryChanged", {});
    return 30;
  };
  try {
    await stage(ARROWS, { split: true });
    const exec = sent.find((c) => c[0] === "exec");
    assert.ok(exec, "split still sent");
    assert.equal(exec[1].amount, 30);
    // 40 left now, so asking for 50 stages the (current) whole stack.
    reset();
    window.__itemDrag.promptStackAmount = async () => { rows = [row(ARROWS, { stackSize: 40 })]; return 50; };
    await stage(ARROWS, { split: true });
    assert.equal(sent.some((c) => c[0] === "exec"), false);
    assert.deepEqual(mod.state.sellQueue.map((q) => [q.itemGuid, q.amount]), [[ARROWS, 40]]);
  } finally { window.__itemDrag.promptStackAmount = prompt; }
});
await check("switching vendors drops a split in flight", async () => {
  reset();
  await stage(ARROWS, { split: true });
  assert.equal(mod.state.sellSplits.length, 1);
  window.__vendorPluginDebugMount.openWith({ ...rawVendor(), vendorGuid: 0x70000002 });
  assert.equal(mod.state.sellSplits.length, 0);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
