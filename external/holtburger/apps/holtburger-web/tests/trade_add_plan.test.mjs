// tests/trade_add_plan.test.mjs — hud-ui-5 (WebAC comparison, 2026-10-13).
//
// What one drop onto your side of the Secure Trade window adds
// (plugins/commerce_logic.js planTradeAdd), after retail
// gmSecureTradeUI::AcceptDragObject → AddItem(id, 0, 1, _addContents = 1, 0)
// (acclient.c 004CA780):
//   • an object goes in only when it holds no items and no containers; one
//     already listed is skipped SILENTLY (no "already in the trade" text);
//   • a pack holding items is never offered itself — the 0x1A notice
//     "Trading contents of <name>" and each contained item instead, with a
//     non-empty child skipped (the recursion runs with _addContents = 0);
//   • an empty pack goes in whole;
//   • a wielded item is offered (DragItemAcceptable only tests
//     IsOwnedByPlayer; ACE HandleActionAddToTrade falls back to
//     GetEquippedItem) — the old "Unequip X before trading it" was invented.
// [2] drives plugins/trade-panel.js offerItem against a stub session (no DOM)
// to pin the wire calls and the transient line.
//
// Run from apps/holtburger-web/:  node tests/trade_add_plan.test.mjs

import assert from "node:assert/strict";
import { planTradeAdd } from "../plugins/commerce_logic.js";

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

const PLAYER = 0x50000001;
const PACK = 0x80000100;
const POUCH = 0x80000200;
const row = (guid, name, extra = {}) => ({
  guid, name, itemType: 0x01, equipMask: 0, containerId: PLAYER, ...extra,
});
const ROWS = [
  row(0x80000001, "Iron Dagger"),
  row(0x80000002, "Worn Robe", { itemType: 0x04, equipMask: 0x200 }),
  row(PACK, "Pack", { itemType: 0x200 }),
  row(0x80000101, "Gold Ring", { containerId: PACK }),
  row(0x80000102, "Healing Kit", { containerId: PACK }),
  row(0x80000103, "Mana Stone", { containerId: PACK }),
  row(POUCH, "Pouch", { itemType: 0x200 }),
];

console.log("[1] planTradeAdd — gmSecureTradeUI::AddItem with _addContents = 1");
await check("a plain item → [guid], no notice", () => {
  assert.deepEqual(planTradeAdd(ROWS[0], ROWS, []), { guids: [0x80000001], notice: null });
});
await check("an item already listed → [] and no message (retail returns silently)", () => {
  assert.deepEqual(planTradeAdd(ROWS[0], ROWS, [0x80000001]), { guids: [], notice: null });
});
await check("a pack holding 3 items, one listed → notice + the other 2, never the pack", () => {
  const plan = planTradeAdd(ROWS[2], ROWS, [0x80000102]);
  assert.equal(plan.notice, "Trading contents of Pack");
  assert.deepEqual(plan.guids, [0x80000101, 0x80000103]);
  assert.ok(!plan.guids.includes(PACK), "the bag itself is not offered");
});
await check("an empty pack → [packGuid], no notice", () => {
  assert.deepEqual(planTradeAdd(ROWS[6], ROWS, []), { guids: [POUCH], notice: null });
});
await check("an equipped item (equipMask ≠ 0) → [guid] (IsOwnedByPlayer covers wielded)", () => {
  assert.deepEqual(planTradeAdd(ROWS[1], ROWS, []), { guids: [0x80000002], notice: null });
});
await check("a pack whose items are all listed → the notice still shows, nothing sent", () => {
  const plan = planTradeAdd(ROWS[2], ROWS, [0x80000101, 0x80000102, 0x80000103]);
  assert.equal(plan.notice, "Trading contents of Pack");
  assert.deepEqual(plan.guids, []);
});
await check("the pack itself already listed (offered while empty) → silent no-op", () => {
  assert.deepEqual(planTradeAdd(ROWS[2], ROWS, [PACK]), { guids: [], notice: null });
});
await check("a child that holds anything is skipped, not opened (_addContents = 0)", () => {
  const rows = [
    row(PACK, "Pack", { itemType: 0x200 }),
    row(0x80000101, "Gold Ring", { containerId: PACK }),
    row(0x80000104, "Odd Box", { containerId: PACK }),
    row(0x80000105, "Box Content", { containerId: 0x80000104 }),
  ];
  const plan = planTradeAdd(rows[0], rows, []);
  assert.equal(plan.notice, "Trading contents of Pack");
  assert.deepEqual(plan.guids, [0x80000101]);
});
await check("contained containers are not walked; a holder of only packs adds nothing", () => {
  const rows = [
    row(PACK, "Pack", { itemType: 0x200 }),
    row(0x80000101, "Gold Ring", { containerId: PACK }),
    row(POUCH, "Pouch", { itemType: 0x200, containerId: PACK }),
  ];
  assert.deepEqual(planTradeAdd(rows[0], rows, []).guids, [0x80000101], "the inner pack is in the containers list");
  const onlyPacks = [rows[0], rows[2]];
  assert.deepEqual(planTradeAdd(rows[0], onlyPacks, []), { guids: [], notice: null },
    "no items → not offered (it holds a container) and no notice");
});
await check("requiresBackpackSlot wins over the item type for the containers list", () => {
  const rows = [
    row(PACK, "Pack", { itemType: 0x200 }),
    row(0x80000101, "Foci", { containerId: PACK, itemType: 0x200, requiresBackpackSlot: false }),
  ];
  assert.deepEqual(planTradeAdd(rows[0], rows, []).guids, [0x80000101]);
});
await check("unnamed pack and a missing item read safely", () => {
  const rows = [row(PACK, "", { itemType: 0x200 }), row(0x80000101, "Gold Ring", { containerId: PACK })];
  assert.equal(planTradeAdd(rows[0], rows, []).notice, "Trading contents of the pack");
  assert.deepEqual(planTradeAdd(null, rows, []), { guids: [], notice: null });
  assert.deepEqual(planTradeAdd(rows[1], null, undefined), { guids: [0x80000101], notice: null });
});

console.log("[2] trade-panel offerItem — wire calls + transient line (stub session, no DOM)");
const calls = [];
const lines = [];
globalThis.window = {
  __sessionHandle: {
    playerInventory: () => ROWS.map((r) => ({ ...r })),
    addToTrade: (g, s) => calls.push(["addToTrade", g >>> 0, s]),
  },
  __pluginClient: { events: { on() {} } },
  __appendChatLine: (text, category) => lines.push([text, category]),
};
await import("../plugins/trade-panel.js");
const { offerItem } = globalThis.window.__tradePanel;

await check("a dropped pack sends each item, not the pack, and the 0x1A line (category 9)", () => {
  calls.length = 0; lines.length = 0;
  assert.equal(offerItem(PACK), true);
  assert.deepEqual(calls, [["addToTrade", 0x80000101, 0], ["addToTrade", 0x80000102, 0], ["addToTrade", 0x80000103, 0]]);
  assert.deepEqual(lines, [["Trading contents of Pack", 9]]);
});
await check("an equipped item is offered (no 'Unequip' refusal)", () => {
  calls.length = 0; lines.length = 0;
  assert.equal(offerItem(0x80000002), true);
  assert.deepEqual(calls, [["addToTrade", 0x80000002, 0]]);
  assert.deepEqual(lines, []);
});
await check("an empty pack goes in whole", () => {
  calls.length = 0;
  assert.equal(offerItem(POUCH), true);
  assert.deepEqual(calls, [["addToTrade", POUCH, 0]]);
});
await check("an item you are not carrying sends nothing", () => {
  calls.length = 0; lines.length = 0;
  assert.equal(offerItem(0x80009999), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(lines, []);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
