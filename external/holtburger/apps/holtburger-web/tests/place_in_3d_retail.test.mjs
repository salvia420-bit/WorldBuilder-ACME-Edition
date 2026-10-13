// tests/place_in_3d_retail.test.mjs — inventory-session-4 (2026-10-13).
//
// Retail ItemHolder::AttemptPlaceIn3D (acclient.c:433163) runs, after the
// self case and the "not owned" refusal:
//   trade refusal  "You are trading the %s, it cannot be dropped" (:433226)
//   AttemptMerge   onto the found object, quiet 0 (:433237 → :432468):
//                  IsMergeAttemptLegal (:432033) is silent unless both are
//                  stackables; then a same-wcid stack with room merges
//                  min(amount, max − held), a full / different stack prints
//                  and the drop carries on
//   BF_VENDOR      0x200: a whole stack → ClientUISystem::
//                  AttemptSellToVendor (:433250), a split → "You must split
//                  the stack before selling it." (:433256) — ahead of the
//                  trade option and the creature give
//   mid-air        a ground drop off the ground → "You cannot do that in
//                  mid air" (:433320)
// holtburger used to give the item to a vendor (ACE walks over and refuses),
// drop a second pile beside a matching one and drop while jumping.
//
//   [1] pure: inventory_helpers.decideItemDrop WORLD / place3DMerge /
//       retailPlace3DEnabled (`?retailPlace3D=off` = the old results);
//   [2] plugins/item_drag.js (real, on the fake DOM): describeWorldEntity's
//       vendor bit + stack facts, the ctx hooks (pose isOnGround, open
//       trade), a shift-drop on a vendor, executeItemAction "sell3d" and a
//       drop's notice.
//
// Run from apps/holtburger-web/:  node tests/place_in_3d_retail.test.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installFakeDom } from "./helpers/fake_dom_items.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.stack || e.message}`); }
}

const H = await import(pathToFileURL(path.join(APP, "plugins", "inventory_helpers.js")).href);
const { DROP_TARGET: T, MAIN_PACK_KEY: MAIN, decideItemDrop, place3DMerge, PLACE_IN_3D_TEXT, retailPlace3DEnabled } = H;

const ME = 0x50000001;
const VENDOR = 0x7C000010;
const GROUND = 0x7E000001;
const ARROWS = 0x60000001;
const arrows = { guid: ARROWS, wcid: 300, name: "Arrow", stackSize: 50, maxStackSize: 250 };
const sword = { guid: 0x60000002, wcid: 100, name: "Sword", stackSize: 1, maxStackSize: 1 };
const inv = (item, extra = {}) => ({ guid: item.guid, item, owned: true, sourceList: { key: MAIN, kind: "inventory" }, sourceIndex: 0, split: 0, ...extra });
const vendor = { guid: VENDOR, isCreature: true, isVendor: true, name: "Shopkeeper" };
const pile = (extra = {}) => ({ guid: GROUND, wcid: 300, stackSize: 100, maxStackSize: 250, name: "Arrow", ...extra });
const ctx = { playerGuid: ME };

/* ── [1] pure ─────────────────────────────────────────────────────────── */
console.log("\n[1] decideItemDrop WORLD — retail AttemptPlaceIn3D");
await check("a vendor with a whole stack → sell3d (not a give)", () => {
  assert.deepEqual(decideItemDrop(inv(arrows), { kind: T.WORLD, entity: vendor }, ctx),
    { op: "sell3d", guid: ARROWS, vendor: VENDOR });
  assert.deepEqual(decideItemDrop(inv(sword), { kind: T.WORLD, entity: vendor }, ctx).op, "sell3d");
});
await check("a vendor with a split → 'You must split the stack before selling it.'", () => {
  const r = decideItemDrop(inv(arrows, { split: 10 }), { kind: T.WORLD, entity: vendor }, ctx);
  assert.deepEqual(r, { op: "reject", message: "You must split the stack before selling it." });
  assert.equal(r.message, PLACE_IN_3D_TEXT.splitToSell);
});
await check("the vendor sale comes before the drag-onto-player trade option", () => {
  const v = { ...vendor, isPlayer: true };
  assert.equal(decideItemDrop(inv(arrows), { kind: T.WORLD, entity: v }, { ...ctx, dragOnPlayerOpensTrade: true }).op, "sell3d");
});
await check("a same-wcid ground stack with room → merge, amount clamped to the room", () => {
  assert.deepEqual(decideItemDrop(inv(arrows), { kind: T.WORLD, entity: pile() }, ctx),
    { op: "merge", guid: ARROWS, target: GROUND, amount: 50, targetStack: 100 });
  const near = decideItemDrop(inv(arrows), { kind: T.WORLD, entity: pile({ stackSize: 230 }) }, ctx);
  assert.deepEqual([near.op, near.amount, near.targetStack], ["merge", 20, 230]);
  const part = decideItemDrop(inv(arrows, { split: 7 }), { kind: T.WORLD, entity: pile() }, ctx);
  assert.deepEqual([part.op, part.amount], ["merge", 7], "a split merges only the split");
});
await check("a full same-wcid stack → the notice, then the drop", () => {
  assert.deepEqual(decideItemDrop(inv(arrows), { kind: T.WORLD, entity: pile({ stackSize: 250 }) }, ctx),
    { op: "drop", guid: ARROWS, amount: 50, notice: "The destination stack is already full." });
});
await check("a different-wcid stackable → the notice, then the drop", () => {
  assert.deepEqual(decideItemDrop(inv(arrows), { kind: T.WORLD, entity: pile({ wcid: 273, name: "Pyreal" }) }, ctx),
    { op: "drop", guid: ARROWS, amount: 50, notice: "You cannot merge different types of items." });
});
await check("not both known stackables → quiet: plain drop, no notice", () => {
  // the dragged item is not stackable
  assert.deepEqual(decideItemDrop(inv(sword), { kind: T.WORLD, entity: pile() }, ctx), { op: "drop", guid: sword.guid, amount: 1 });
  // the world object's MaxStackSize / wcid unknown
  assert.deepEqual(decideItemDrop(inv(arrows), { kind: T.WORLD, entity: pile({ maxStackSize: undefined }) }, ctx),
    { op: "drop", guid: ARROWS, amount: 50 });
  assert.deepEqual(decideItemDrop(inv(arrows), { kind: T.WORLD, entity: pile({ wcid: undefined }) }, ctx),
    { op: "drop", guid: ARROWS, amount: 50 });
  // the dragged item's MaxStackSize unknown (an old pkg/)
  const old = { ...arrows };
  delete old.maxStackSize;
  assert.deepEqual(decideItemDrop(inv(old), { kind: T.WORLD, entity: pile() }, ctx), { op: "drop", guid: ARROWS, amount: 50 });
});
await check("playerOnGround false with no target → 'You cannot do that in mid air'", () => {
  const r = decideItemDrop(inv(arrows), { kind: T.WORLD }, { ...ctx, playerOnGround: false });
  assert.deepEqual(r, { op: "reject", message: "You cannot do that in mid air" });
  const fn = decideItemDrop(inv(arrows), { kind: T.WORLD }, { ...ctx, playerOnGround: () => false });
  assert.equal(fn.message, PLACE_IN_3D_TEXT.midAir, "the hook may be a function");
  const split = decideItemDrop(inv(arrows, { split: 5 }), { kind: T.WORLD }, { ...ctx, playerOnGround: false });
  assert.equal(split.message, PLACE_IN_3D_TEXT.midAir, "a split to the ground too");
});
await check("on the ground, or unknown → the drop", () => {
  for (const g of [true, null, undefined, () => true, () => null, () => { throw new Error("x"); }]) {
    assert.equal(decideItemDrop(inv(arrows), { kind: T.WORLD }, { ...ctx, playerOnGround: g }).op, "drop", String(g));
  }
});
await check("airborne: give / sell / merge are not ground drops — still allowed", () => {
  const air = { ...ctx, playerOnGround: false };
  assert.equal(decideItemDrop(inv(sword), { kind: T.WORLD, entity: { guid: 0x7C000001, isCreature: true } }, air).op, "give");
  assert.equal(decideItemDrop(inv(arrows), { kind: T.WORLD, entity: vendor }, air).op, "sell3d");
  assert.equal(decideItemDrop(inv(arrows), { kind: T.WORLD, entity: pile() }, air).op, "merge");
});
await check("a creature that is not a vendor is still given to", () => {
  const g = decideItemDrop(inv(arrows), { kind: T.WORLD, entity: { guid: 0x7C000001, isCreature: true } }, ctx);
  assert.deepEqual([g.op, g.target, g.amount], ["give", 0x7C000001, 50]);
});
await check("an item in the trade window is refused wherever it is dropped (not on yourself)", () => {
  const tctx = { ...ctx, isBeingTraded: (g) => g === ARROWS };
  const msg = "You are trading the Arrow, it cannot be dropped";
  assert.deepEqual(decideItemDrop(inv(arrows), { kind: T.WORLD }, tctx), { op: "reject", message: msg });
  assert.equal(decideItemDrop(inv(arrows), { kind: T.WORLD, entity: vendor }, tctx).message, msg);
  assert.equal(decideItemDrop(inv(arrows), { kind: T.WORLD, entity: { guid: 0x7C000001, isCreature: true } }, tctx).message, msg);
  const self = decideItemDrop({ ...inv(arrows), sourceList: null }, { kind: T.WORLD, entity: { guid: ME, isSelf: true } }, tctx);
  assert.deepEqual([self.op, self.container], ["move", ME], "the self case comes first in retail");
  assert.equal(decideItemDrop(inv(sword), { kind: T.WORLD }, tctx).op, "drop", "other items are not affected");
  assert.equal(decideItemDrop(inv(arrows), { kind: T.WORLD }, { ...ctx, isBeingTraded: () => { throw new Error("x"); } }).op, "drop");
});
await check("an un-owned item is still 'You must first pick up' (before everything else)", () => {
  const d = { ...inv(arrows), owned: false };
  assert.equal(decideItemDrop(d, { kind: T.WORLD, entity: vendor }, { ...ctx, playerOnGround: false }).message,
    "You must first pick up the Arrow");
});
await check("ctx.retailPlace3D=false reproduces the old results", () => {
  const off = { ...ctx, retailPlace3D: false, playerOnGround: false, isBeingTraded: () => true };
  const g = decideItemDrop(inv(arrows), { kind: T.WORLD, entity: vendor }, off);
  assert.deepEqual([g.op, g.target, g.amount], ["give", VENDOR, 50]);
  const s = decideItemDrop(inv(arrows, { split: 10 }), { kind: T.WORLD, entity: vendor }, off);
  assert.deepEqual([s.op, s.amount], ["give", 10]);
  assert.deepEqual(decideItemDrop(inv(arrows), { kind: T.WORLD, entity: pile() }, off), { op: "drop", guid: ARROWS, amount: 50 });
  assert.deepEqual(decideItemDrop(inv(arrows), { kind: T.WORLD, entity: pile({ stackSize: 250 }) }, off), { op: "drop", guid: ARROWS, amount: 50 });
  assert.deepEqual(decideItemDrop(inv(arrows), { kind: T.WORLD }, off), { op: "drop", guid: ARROWS, amount: 50 });
  // a vendor that is not a creature (a vendor-flagged object) dropped on, old path
  assert.equal(decideItemDrop(inv(arrows), { kind: T.WORLD, entity: { guid: VENDOR, isVendor: true } }, off).op, "drop");
});

console.log("\n[1b] place3DMerge / retailPlace3DEnabled");
await check("place3DMerge: IsMergeAttemptLegal + AttemptMerge amounts", () => {
  assert.deepEqual(place3DMerge(arrows, pile(), 50), { amount: 50, held: 100 });
  assert.deepEqual(place3DMerge(arrows, pile({ stackSize: 249 }), 50), { amount: 1, held: 249 });
  assert.deepEqual(place3DMerge(arrows, pile({ stackSize: undefined }), 50), { amount: 50, held: 1 }, "unset StackSize = 1");
  assert.deepEqual(place3DMerge(arrows, pile({ stackSize: 300 }), 50), { notice: PLACE_IN_3D_TEXT.stackFull });
  assert.equal(place3DMerge(arrows, { ...pile(), guid: ARROWS }, 50), null, "the same object");
  assert.equal(place3DMerge(arrows, pile({ maxStackSize: 1 }), 50), null, "a non-stackable target");
  assert.equal(place3DMerge(null, pile(), 1), null);
});
await check("retailPlace3DEnabled: default ON; off / 0 / false disable", () => {
  assert.equal(retailPlace3DEnabled(""), true);
  assert.equal(retailPlace3DEnabled("?retailPlace3D=on"), true);
  for (const v of ["off", "0", "false"]) assert.equal(retailPlace3DEnabled(`?retailPlace3D=${v}`), false, v);
});

/* ── [2] item_drag (real module on the fake DOM) ──────────────────────── */
globalThis.window = globalThis;
installFakeDom(globalThis);
const calls = [];
const rec = (n) => (...a) => { calls.push([n, ...a]); };
const lastCall = (n) => [...calls].reverse().find((c) => c[0] === n) || null;
let onGround = true;
let tradeItems = [];
const freed = [];
const worldInts = new Map([
  [GROUND, { 11: 250, 12: 100 }],
]);
globalThis.__sessionHandle = {
  playerInventory: () => [],
  objectDescFlags: (g) => (g === VENDOR ? 0x200 : 0),
  objectIntProperty: (g, k) => {
    const o = worldInts.get(g >>> 0);
    return o && k in o ? o[k] : undefined;
  },
  objectWcid: (g) => (g === GROUND ? 300 : 0),
  objectBoolProperty: () => undefined,
  groundContainerId: () => 0,
  getLocalPlayerPose: () => ({ isOnGround: onGround, free() { freed.push("pose"); } }),
  playerTrade: () => ({
    isOpen: true,
    myItems: tradeItems.map((g) => ({ guid: g, free() {} })),
    free() { freed.push("trade"); },
  }),
  mergeStacks: rec("mergeStacks"),
  dropItem: rec("dropItem"),
  splitStackTo3D: rec("splitStackTo3D"),
  giveObject: rec("giveObject"),
  useObject: rec("useObject"),
};
globalThis.getLocalPlayerGuid = () => ME;
globalThis.liveScene3d = {
  entityManager: {
    entityMap: new Map([
      [VENDOR, { meta: { name: "Shopkeeper", itemType: 0x10, objDescFlags: 0x200 } }],
      [GROUND, { meta: { name: "Arrow", itemType: 0x100 } }],
    ]),
  },
};
const D = await import(pathToFileURL(path.join(APP, "plugins", "item_drag.js")).href);
const toastText = () => document.getElementById("hb-item-toast")?.textContent || "";
const sess = (item, extra = {}) => ({ guid: item.guid, item, owned: true, sourceList: { key: MAIN, kind: "inventory" }, sourceIndex: 0, shift: false, ...extra });

console.log("\n[2] item_drag — world entity, ctx hooks, execution");
await check("describeWorldEntity: the vendor bit (ODF 0x200) and a ground stack's wcid / StackSize / MaxStackSize", () => {
  const v = D.describeWorldEntity(VENDOR);
  assert.equal(v.isVendor, true);
  assert.equal(v.isCreature, true);
  assert.equal(v.wcid, undefined, "unknown wcid stays undefined");
  assert.equal(v.maxStackSize, undefined);
  const p = D.describeWorldEntity(GROUND);
  assert.deepEqual([p.isVendor, p.wcid, p.stackSize, p.maxStackSize], [false, 300, 100, 250]);
});
await check("resolveDropAction: a ground stack under the pointer → merge into it", async () => {
  const a = await D.resolveDropAction(sess(arrows), { kind: T.WORLD, entity: D.describeWorldEntity(GROUND) });
  assert.deepEqual(a, { op: "merge", guid: ARROWS, target: GROUND, amount: 50, targetStack: 100 });
  calls.length = 0;
  assert.equal(D.executeItemAction(a, sess(arrows)), true);
  assert.deepEqual(lastCall("mergeStacks"), ["mergeStacks", ARROWS, GROUND, 50]);
});
await check("resolveDropAction: the pose's isOnGround=false refuses a ground drop (the pose is freed)", async () => {
  onGround = false;
  freed.length = 0;
  try {
    const a = await D.resolveDropAction(sess(sword), { kind: T.WORLD, entity: null });
    assert.deepEqual(a, { op: "reject", message: PLACE_IN_3D_TEXT.midAir });
    assert.ok(freed.includes("pose"));
  } finally { onGround = true; }
  const b = await D.resolveDropAction(sess(sword), { kind: T.WORLD, entity: null });
  assert.equal(b.op, "drop");
});
await check("resolveDropAction: an item offered in the open trade is refused", async () => {
  tradeItems = [sword.guid];
  try {
    const a = await D.resolveDropAction(sess(sword), { kind: T.WORLD, entity: null });
    assert.deepEqual(a, { op: "reject", message: "You are trading the Sword, it cannot be dropped" });
  } finally { tradeItems = []; }
});
await check("resolveDropAction: a shift-drop on a vendor is refused at once (no amount prompt)", async () => {
  const a = await D.resolveDropAction(sess(arrows, { shift: true }), { kind: T.WORLD, entity: D.describeWorldEntity(VENDOR) });
  assert.deepEqual(a, { op: "reject", message: PLACE_IN_3D_TEXT.splitToSell });
  assert.equal(document.getElementById("hb-stack-split"), null, "the split prompt never opened");
});
await check("executeItemAction sell3d → vendor-ui's attemptSellToVendor(vendor, item); no wire call of its own", () => {
  const seen = [];
  globalThis.__vendorUi = { attemptSellToVendor: (v, g) => { seen.push([v, g]); return { sent: true, staged: false }; } };
  calls.length = 0;
  try {
    const a = decideItemDrop(sess(arrows), { kind: T.WORLD, entity: D.describeWorldEntity(VENDOR) }, { playerGuid: ME });
    assert.equal(a.op, "sell3d");
    const pendingBefore = D.pendingOps.size();
    assert.equal(D.executeItemAction(a, sess(arrows)), true);
    assert.deepEqual(seen, [[VENDOR, ARROWS]]);
    assert.equal(calls.length, 0, "no give, no drop");
    assert.equal(D.pendingOps.size(), pendingBefore, "the item does not move: no pending entry");
  } finally { delete globalThis.__vendorUi; }
});
await check("executeItemAction sell3d without vendor-ui → the vendor is Used", () => {
  calls.length = 0;
  assert.equal(D.executeItemAction({ op: "sell3d", guid: ARROWS, vendor: VENDOR }, sess(arrows)), true);
  assert.deepEqual(calls, [["useObject", VENDOR]]);
});
await check("executeItemAction drop with a notice → the notice is shown and the item drops", () => {
  calls.length = 0;
  const a = { op: "drop", guid: sword.guid, amount: 1, notice: PLACE_IN_3D_TEXT.mergeTypes };
  assert.equal(D.executeItemAction(a, sess(sword)), true);
  assert.deepEqual(lastCall("dropItem"), ["dropItem", sword.guid]);
  assert.equal(toastText(), PLACE_IN_3D_TEXT.mergeTypes);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
