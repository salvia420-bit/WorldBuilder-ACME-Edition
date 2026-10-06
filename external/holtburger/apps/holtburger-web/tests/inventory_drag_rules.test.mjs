// tests/inventory_drag_rules.test.mjs — HUD overhaul 2026-10-05.
//
// Pins the pure retail item drag & drop core in plugins/inventory_helpers.js:
//   decideItemDrop   UIElement_ItemList::AcceptDragObject (acclient.c:274286)
//                    ItemHolder::AttemptPlaceIn3D (433163)
//                    gmPaperDollUI::AcceptPaperDollDragObject (220805)
//   retailPlacement  the list index math (same-list forward move = index-1,
//                    own cell / next cell = no-op)
//   mergeAmount      ItemHolder::IsMergeAttemptLegal + AttemptMerge
//   createPackOrder  client PlacementPosition model (ACE list-insert)
//   createPendingLedger  SetWaitingState / ServerSaysAttemptFailed
//   formatBurdenText gmBackpackUI::SetLoadLevel (floor, 300 % cap)
//
// Run from apps/holtburger-web/:  node tests/inventory_drag_rules.test.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const H = await import(pathToFileURL(path.join(HERE, "..", "plugins", "inventory_helpers.js")).href);
const {
  DROP_TARGET: T, MAIN_PACK_KEY: MAIN, PACKS_KEY: PACKS,
  decideItemDrop, retailPlacement, mergeAmount, createPackOrder,
  createPendingLedger, pendingExpect, packCapacity, formatBurdenText,
  burdenMeterFraction, pickWieldSlotMask, copyInventoryRow,
} = H;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
}

const ME = 0x50000001;
const PACK_A = 0x70000001;
const CHEST = 0x80000001;
const sword = { guid: 0x60000001, wcid: 100, name: "Sword", stackSize: 1, validLocations: 0x00100000 };
const pyrealsA = { guid: 0x60000002, wcid: 273, name: "Pyreal", stackSize: 50 };
const pyrealsB = { guid: 0x60000003, wcid: 273, name: "Pyreal", stackSize: 20 };
const pack = { guid: PACK_A, wcid: 136, name: "Pack", stackSize: 1, isPack: true };
const hauberk = { guid: 0x60000004, wcid: 55, name: "Hauberk", validLocations: 0x00001a00 };
const baseCtx = {
  playerGuid: ME,
  capacity: () => ({ used: 3, cap: 102 }),
  containerName: (k) => (k === MAIN ? "Tester" : "Pack"),
};
const inv = (item, key, index) => ({ guid: item.guid, item, owned: true, sourceList: { key, kind: "inventory" }, sourceIndex: index, split: 0 });

console.log("\n[1] retailPlacement — list index math");
check("same list, drop on own cell → noop", () => {
  assert.deepEqual(retailPlacement(2, 2, true, false, 5), { noop: true, placement: 2 });
});
check("same list, drop on the next cell → noop", () => {
  assert.equal(retailPlacement(2, 3, true, false, 5).noop, true);
});
check("same list, forward move shifts index down one", () => {
  assert.deepEqual(retailPlacement(0, 3, true, false, 5), { noop: false, placement: 2 });
});
check("same list, backward move keeps index", () => {
  assert.deepEqual(retailPlacement(4, 1, true, false, 5), { noop: false, placement: 1 });
});
check("other list, index clamps to count", () => {
  assert.deepEqual(retailPlacement(-1, 99, false, false, 4), { noop: false, placement: 4 });
});
check("split never shifts / never no-ops", () => {
  assert.deepEqual(retailPlacement(2, 3, true, true, 5), { noop: false, placement: 3 });
});

console.log("\n[2] mergeAmount — IsMergeAttemptLegal / AttemptMerge");
check("same wcid stacks merge whole stack (max unknown)", () => {
  assert.equal(mergeAmount(pyrealsA, pyrealsB, 0), 50);
});
check("split amount honoured", () => {
  assert.equal(mergeAmount(pyrealsA, pyrealsB, 7), 7);
});
check("room-limited when maxStackSize known", () => {
  assert.equal(mergeAmount({ ...pyrealsA, maxStackSize: 25000 }, { ...pyrealsB, maxStackSize: 25000 }, 0), 50);
  assert.equal(mergeAmount({ ...pyrealsA }, { ...pyrealsB, maxStackSize: 60 }, 0), 40);
});
check("destination full → -1", () => {
  assert.equal(mergeAmount(pyrealsA, { ...pyrealsB, stackSize: 60, maxStackSize: 60 }, 0), -1);
});
check("different wcid / same guid / two singles → 0", () => {
  assert.equal(mergeAmount(sword, pyrealsB, 0), 0);
  assert.equal(mergeAmount(pyrealsA, pyrealsA, 0), 0);
  assert.equal(mergeAmount({ ...sword }, { ...sword, guid: 0x60000009 }, 0), 0);
});

console.log("\n[3] decideItemDrop — inventory item list");
check("drop on a later cell in the same pack → move with retail placement", () => {
  const a = decideItemDrop(inv(sword, MAIN, 0), { kind: T.EMPTY_CELL, listKey: MAIN, listKind: "inventory", index: 4, count: 6 }, baseCtx);
  assert.deepEqual(a, { op: "move", guid: sword.guid, container: ME, placement: 3, listKey: MAIN, index: 4, amount: 1 });
});
check("drop on own cell → noop", () => {
  const a = decideItemDrop(inv(sword, MAIN, 2), { kind: T.ITEM_CELL, listKey: MAIN, listKind: "inventory", index: 2, count: 6, item: sword }, baseCtx);
  assert.equal(a.op, "noop");
});
check("stack onto matching stack → merge", () => {
  const a = decideItemDrop(inv(pyrealsA, MAIN, 0), { kind: T.ITEM_CELL, listKey: MAIN, listKind: "inventory", index: 3, count: 6, item: pyrealsB }, baseCtx);
  assert.deepEqual(a, { op: "merge", guid: pyrealsA.guid, target: pyrealsB.guid, amount: 50 });
});
check("compatible tool onto target → usewith (tradeskill)", () => {
  const ctx = { ...baseCtx, canUseWith: (s, d) => s === sword.guid && d === hauberk.guid };
  const a = decideItemDrop(inv(sword, MAIN, 0), { kind: T.ITEM_CELL, listKey: MAIN, listKind: "inventory", index: 3, count: 6, item: hauberk }, ctx);
  assert.equal(a.op, "usewith");
});
check("incompatible item onto item → re-arrange (no recipe attempt)", () => {
  const ctx = { ...baseCtx, canUseWith: () => false };
  const a = decideItemDrop(inv(sword, MAIN, 5), { kind: T.ITEM_CELL, listKey: MAIN, listKind: "inventory", index: 1, count: 6, item: hauberk }, ctx);
  assert.deepEqual([a.op, a.placement], ["move", 1]);
});
check("item from a side pack onto main grid → container = player", () => {
  const a = decideItemDrop(inv(sword, PACK_A, 0), { kind: T.EMPTY_CELL, listKey: MAIN, listKind: "inventory", index: 2, count: 2 }, baseCtx);
  assert.deepEqual([a.op, a.container, a.placement], ["move", ME, 2]);
});
check("full main pack overflows into a side pack with room", () => {
  const ctx = { ...baseCtx, capacity: (k) => (k === MAIN ? { used: 102, cap: 102 } : { used: 1, cap: 24 }), packWithRoom: () => PACK_A };
  const a = decideItemDrop(inv(sword, PACK_A, 0), { kind: T.EMPTY_CELL, listKey: MAIN, listKind: "inventory", index: 0, count: 102 }, ctx);
  assert.deepEqual([a.op, a.container], ["move", PACK_A]);
});
check("full side pack → retail 'completely full' rejection", () => {
  const ctx = { ...baseCtx, capacity: (k) => (k === PACK_A ? { used: 24, cap: 24 } : { used: 1, cap: 102 }), containerName: () => "Pack" };
  const a = decideItemDrop(inv(sword, MAIN, 0), { kind: T.EMPTY_CELL, listKey: PACK_A, listKind: "inventory", index: 0, count: 24 }, ctx);
  assert.deepEqual(a, { op: "reject", message: "The Pack is completely full!" });
});
check("own top-level pack onto item grid → 'Cannot place container in item list'", () => {
  const d = { guid: pack.guid, item: pack, owned: true, sourceList: { key: PACKS, kind: "packs" }, sourceIndex: 0, split: 0 };
  const a = decideItemDrop(d, { kind: T.EMPTY_CELL, listKey: MAIN, listKind: "inventory", index: 0, count: 3 }, baseCtx);
  assert.equal(a.message, "Cannot place container in item list");
});
check("shift-split to a cell → move carrying the split amount", () => {
  const d = { ...inv(pyrealsA, MAIN, 0), split: 10 };
  const a = decideItemDrop(d, { kind: T.EMPTY_CELL, listKey: MAIN, listKind: "inventory", index: 1, count: 4 }, baseCtx);
  assert.deepEqual([a.op, a.placement, a.amount], ["move", 1, 10]);
});

console.log("\n[4] decideItemDrop — container list (bag column)");
check("item onto a side pack → into it at place 0", () => {
  const a = decideItemDrop(inv(sword, MAIN, 3), { kind: T.PACK_SLOT, packGuid: PACK_A, packName: "Pack", index: 0, count: 2 }, baseCtx);
  assert.deepEqual([a.op, a.container, a.placement], ["move", PACK_A, 0]);
});
check("item onto main-pack slot from a side pack → player, place 0", () => {
  const a = decideItemDrop(inv(sword, PACK_A, 4), { kind: T.MAIN_PACK }, baseCtx);
  assert.deepEqual([a.op, a.container, a.placement, a.listKey], ["move", ME, 0, MAIN]);
});
check("auto-merge into a matching stack when dropped on a pack", () => {
  const ctx = { ...baseCtx, autoMergeTarget: () => pyrealsB.guid };
  const a = decideItemDrop(inv(pyrealsA, MAIN, 0), { kind: T.PACK_SLOT, packGuid: PACK_A, index: 0, count: 1 }, ctx);
  assert.deepEqual([a.op, a.target], ["merge", pyrealsB.guid]);
});
check("item onto an empty pack slot → 'Cannot place item in container list'", () => {
  const a = decideItemDrop(inv(sword, MAIN, 0), { kind: T.EMPTY_PACK_SLOT, count: 1 }, baseCtx);
  assert.equal(a.message, "Cannot place item in container list");
});
check("pack reordered within the container list", () => {
  const d = { guid: pack.guid, item: pack, owned: true, sourceList: { key: PACKS, kind: "packs" }, sourceIndex: 0, split: 0 };
  const a = decideItemDrop(d, { kind: T.PACK_SLOT, packGuid: 0x70000003, index: 2, count: 3 }, baseCtx);
  assert.deepEqual([a.op, a.container, a.placement, a.listKey], ["move", ME, 1, PACKS]);
});

console.log("\n[5] decideItemDrop — paperdoll + world + external containers");
check("doll slot → wield the item's own bit", () => {
  const bow = { guid: 0x60000010, name: "Bow", validLocations: 0x00400000 };
  const a = decideItemDrop(inv(bow, MAIN, 0), { kind: T.DOLL_SLOT, slotMask: 0x03500000 }, baseCtx);
  assert.deepEqual([a.op, a.slotMask], ["wield", 0x00400000]);
});
check("multi-bit weapon slot without ValidLocations refuses (never wields a multi-bit location)", () => {
  const unknown = { guid: 0x60000011, name: "Thing", validLocations: 0 };
  const d = { guid: unknown.guid, item: unknown, owned: false, sourceList: { key: CHEST, kind: "ext" }, sourceIndex: 0 };
  assert.equal(decideItemDrop(d, { kind: T.DOLL_SLOT, slotMask: 0x03500000 }, baseCtx).op, "reject");
  assert.equal(decideItemDrop(d, { kind: T.DOLL_SLOT, slotMask: 0x00000001 }, baseCtx).slotMask, 0x00000001);
});
check("doll slot vetoed by canEquip → reject with its reason", () => {
  const ctx = { ...baseCtx, canEquip: () => ({ ok: false, reason: "This item cannot be worn in that slot." }) };
  const a = decideItemDrop(inv(sword, MAIN, 0), { kind: T.DOLL_SLOT, slotMask: 0x1 }, ctx);
  assert.equal(a.message, "This item cannot be worn in that slot.");
});
check("doll figure takes armour (AutoWear) but not weapons", () => {
  assert.equal(decideItemDrop(inv(hauberk, MAIN, 0), { kind: T.DOLL }, baseCtx).op, "wear");
  assert.equal(decideItemDrop(inv(sword, MAIN, 0), { kind: T.DOLL }, baseCtx).message, "You can't put that item there");
});
check("world: no entity → drop; creature → give whole stack; self → backpack", () => {
  assert.equal(decideItemDrop(inv(sword, MAIN, 0), { kind: T.WORLD }, baseCtx).op, "drop");
  const g = decideItemDrop(inv(pyrealsA, MAIN, 0), { kind: T.WORLD, entity: { guid: 0x1, isCreature: true } }, baseCtx);
  assert.deepEqual([g.op, g.target, g.amount], ["give", 1, 50]);
  const equipped = { ...sword, equipMask: 0x00100000 };
  const s = decideItemDrop({ ...inv(equipped, null, -1), sourceList: null }, { kind: T.WORLD, entity: { guid: ME, isSelf: true } }, baseCtx);
  assert.deepEqual([s.op, s.container], ["move", ME]);
});
check("world: un-owned (chest) item → 'You must first pick up'", () => {
  const d = { guid: sword.guid, item: sword, owned: false, sourceList: { key: CHEST, kind: "ext" }, sourceIndex: 0 };
  assert.equal(decideItemDrop(d, { kind: T.WORLD }, baseCtx).message, "You must first pick up the Sword");
});
check("chest item into inventory grid → move into player at that index", () => {
  const d = { guid: sword.guid, item: sword, owned: false, sourceList: { key: CHEST, kind: "ext" }, sourceIndex: 0 };
  const a = decideItemDrop(d, { kind: T.EMPTY_CELL, listKey: MAIN, listKind: "inventory", index: 2, count: 5 }, baseCtx);
  assert.deepEqual([a.op, a.container, a.placement], ["move", ME, 2]);
});
check("inventory item into a corpse → refused", () => {
  const ctx = { ...baseCtx, isCorpse: () => true, containerName: () => "Corpse of Drudge" };
  const a = decideItemDrop(inv(sword, MAIN, 0), { kind: T.EMPTY_CELL, listKey: CHEST, listKind: "ext", index: 0, count: 0 }, ctx);
  assert.equal(a.message, "The Corpse of Drudge cannot accept items");
});
check("inventory item into an open chest → move with chest placement", () => {
  const a = decideItemDrop(inv(sword, MAIN, 0), { kind: T.EMPTY_CELL, listKey: CHEST, listKind: "ext", index: 3, count: 3 }, baseCtx);
  assert.deepEqual([a.op, a.container, a.placement], ["move", CHEST, 3]);
});

console.log("\n[6] createPackOrder — client PlacementPosition");
const rows = (...gs) => gs.map((g) => ({ guid: g }));
check("first sight seeds snapshot order", () => {
  const o = createPackOrder({ now: () => 0 });
  const m = o.reconcile(new Map([[MAIN, rows(1, 2, 3)]]));
  assert.deepEqual(m.get(MAIN), [1, 2, 3]);
});
check("a moved item keeps its slot across a name-sorted refresh", () => {
  let t = 0;
  const o = createPackOrder({ now: () => t });
  o.reconcile(new Map([[MAIN, rows(1, 2, 3, 4)]]));
  t = 10000;
  const mv = o.move(1, MAIN, 3);
  assert.deepEqual([mv.noop, mv.placement], [false, 2]);
  const m = o.reconcile(new Map([[MAIN, rows(1, 2, 3, 4)]]));
  assert.deepEqual(m.get(MAIN), [2, 3, 1, 4]);
});
check("undo restores the original slot (server said no)", () => {
  const o = createPackOrder({ now: () => 0 });
  o.reconcile(new Map([[MAIN, rows(1, 2, 3)]]));
  const mv = o.move(3, MAIN, 0);
  assert.deepEqual(o.order(MAIN), [3, 1, 2]);
  o.undo(mv.undo);
  assert.deepEqual(o.order(MAIN), [1, 2, 3]);
});
check("cross-container move + vanished item pruned", () => {
  const o = createPackOrder({ now: () => 0 });
  o.reconcile(new Map([[MAIN, rows(1, 2)], [PACK_A, rows(9)]]));
  o.move(2, PACK_A, 0);
  const m = o.reconcile(new Map([[MAIN, rows(1)], [PACK_A, rows(9, 2)]]));
  assert.deepEqual([m.get(MAIN), m.get(PACK_A)], [[1], [2, 9]]);
});
check("settled container: unhinted loot lands at the FRONT (ACE placement 0)", () => {
  let t = 0;
  const o = createPackOrder({ now: () => t, settleMs: 3000 });
  o.reconcile(new Map([[MAIN, rows(1, 2)]]));
  t = 5000;
  const m = o.reconcile(new Map([[MAIN, rows(1, 2, 3)]]));
  assert.deepEqual(m.get(MAIN), [3, 1, 2]);
});
check("hinted arrival lands where it was dropped", () => {
  let t = 0;
  const o = createPackOrder({ now: () => t });
  o.reconcile(new Map([[MAIN, rows(1, 2, 3)]]));
  t = 5000;
  o.hintArrival(7, MAIN, 2);
  const m = o.reconcile(new Map([[MAIN, rows(1, 2, 3, 7)]]));
  assert.deepEqual(m.get(MAIN), [1, 2, 7, 3]);
});
check("server placement (newer wasm) wins over the local model", () => {
  const o = createPackOrder({ now: () => 0 });
  o.reconcile(new Map([[MAIN, rows(1, 2, 3)]]));
  o.move(1, MAIN, 3);
  const m = o.reconcile(new Map([[MAIN, [{ guid: 1, placement: 0 }, { guid: 2, placement: 1 }, { guid: 3, placement: 2 }]]]));
  assert.deepEqual(m.get(MAIN), [1, 2, 3]);
});

console.log("\n[7] createPendingLedger — waiting state");
check("resolves when the snapshot meets the expectation", () => {
  const L = createPendingLedger({ now: () => 0 });
  L.add(5, { expect: pendingExpect.inContainer(PACK_A) });
  // No server update yet → never resolves, even if the stale row matches.
  assert.equal(L.sweep(new Map([[5, { guid: 5, containerId: PACK_A, equipMask: 0 }]])), 0);
  L.bump();
  assert.equal(L.sweep(new Map([[5, { guid: 5, containerId: 0, equipMask: 0 }]])), 0);
  assert.equal(L.sweep(new Map([[5, { guid: 5, containerId: PACK_A, equipMask: 0 }]])), 1);
  assert.equal(L.has(5), false);
});
check("fail() runs undo and reports", () => {
  const L = createPendingLedger();
  let undone = 0;
  const seen = [];
  L.onChange((e) => seen.push(e.type));
  L.add(6, { expect: pendingExpect.gone(), undo: () => { undone++; } });
  L.fail(6);
  assert.deepEqual([undone, seen], [1, ["add", "fail"]]);
});
check("expires after the TTL", () => {
  let t = 0;
  const L = createPendingLedger({ now: () => t, ttlMs: 100 });
  L.add(7, { expect: pendingExpect.wielded() });
  t = 200;
  assert.equal(L.sweep(new Map()), 1);
});

console.log("\n[8] capacity, burden, wield-slot, row copy");
check("packCapacity counts main-pack items (not packs, not equipped)", () => {
  const rs = [
    { guid: 1, containerId: 0, equipMask: 0 },
    { guid: 2, containerId: 0, equipMask: 0x1 },
    { guid: PACK_A, containerId: 0, equipMask: 0, requiresBackpackSlot: true, itemsCapacity: 24 },
    { guid: 4, containerId: PACK_A, equipMask: 0 },
  ];
  assert.deepEqual(packCapacity(rs, MAIN, { mainCap: 102 }), { used: 1, cap: 102 });
  assert.deepEqual(packCapacity(rs, PACKS, { packsCap: 7 }), { used: 1, cap: 7 });
  assert.deepEqual(packCapacity(rs, PACK_A), { used: 1, cap: 24 });
});
check("burden text is floored and capped at 300% (SetLoadLevel)", () => {
  assert.equal(formatBurdenText(0.999).text, "99%");
  assert.equal(formatBurdenText(0.29).text, "29%");
  assert.equal(formatBurdenText(3.6).text, "300%");
  assert.equal(burdenMeterFraction(1.5), 0.5);
  assert.equal(burdenMeterFraction(9), 1);
});
check("pickWieldSlotMask precedence", () => {
  assert.equal(pickWieldSlotMask(0x03100000), 0x00100000);
  assert.equal(pickWieldSlotMask(0x00040000 | 0x00080000), 0x00040000);
});
check("copyInventoryRow is plain data with optional placement", () => {
  const r = copyInventoryRow({ guid: 9, name: "X", stackSize: 0, placement: 4, free() {} });
  assert.equal(r.stackSize, 1);
  assert.equal(r.placement, 4);
  assert.ok(!("free" in r));
  assert.equal("maxStackSize" in r, false);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
