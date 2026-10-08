// tests/hotbar_merge_retarget.test.mjs — items-6 (2026-10-08).
//
// Retail moves a shortcut WITH a stack merge and never re-binds one by
// weenie class:
//   ItemHolder::AttemptMerge (acclient.c:432468) → CM_UI::
//     SendNotice_FullMergingItem(from, to) after every UIAttemptMerge,
//     partial merges included;
//   gmToolbarUI::RecvNotice_FullMergingItem (acclient.c:241250):
//     slot = RemoveShortcut(from, 1); if (slot != -1) CreateShortcutToItem(to, slot);
//   gmToolbarUI::RecvNotice_ServerSaysMoveItem (acclient.c:241723): a bound
//     item that is no longer owned → RemoveShortcutInSlotNum(slot, 1).
// holtburger re-bound a vanished item's shortcut to the FIRST inventory
// stack of the same wcid and told the hotbar nothing on a merge.
//
// CONTRACT
//   [1] retargetBindings(slots, A, B) moves every slot bound to A onto B
//       (same slot, wcid kept) and reports the changed indices;
//   [2] staleBindingAction: a seen-then-vanished item → "clear" even when a
//       same-wcid stack exists; a never-seen guid inside the post-login
//       grace → "keep"; a present item → "keep";
//   [3] item_drag.executeItemAction "merge" dispatches hb:item-merge
//       {from, to} once the StackableMerge is sent (and not when it is not).
//
// Run from apps/holtburger-web/:  node tests/hotbar_merge_retarget.test.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

// ── minimal DOM: hotbar.js styles on import; item_drag.js installs its
//    window-capture listeners. A real window event registry for [3]. ──
const winListeners = new Map();
function mkEl() {
  return {
    style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, contains: () => false, toggle: () => false },
    appendChild(c) { return c; }, setAttribute() {}, addEventListener() {}, removeEventListener() {},
  };
}
globalThis.window = globalThis;
globalThis.document = {
  head: mkEl(), body: mkEl(), createElement: () => mkEl(), getElementById: () => null,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
};
globalThis.addEventListener = (t, fn) => { if (!winListeners.has(t)) winListeners.set(t, []); winListeners.get(t).push(fn); };
globalThis.removeEventListener = () => {};
globalThis.dispatchEvent = (ev) => { for (const fn of winListeners.get(ev.type) || []) fn(ev); return true; };
globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}), text: () => Promise.resolve("") });

const { retargetBindings, staleBindingAction } = await import(pathToFileURL(path.join(APP, "plugins", "hotbar.js")).href);
const drag = await import(pathToFileURL(path.join(APP, "plugins", "item_drag.js")).href);

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
}

const A = 0x60000001, B = 0x60000002, C = 0x60000003;

console.log("\n[1] retargetBindings — RecvNotice_FullMergingItem");
check("merge A→B moves slot 3 from A to B, wcid kept; other slots untouched", () => {
  const slots = [null, { spellId: 27 }, { itemGuid: C, wcid: 273 }, { itemGuid: A, wcid: 273 }, null];
  const r = retargetBindings(slots, A, B);
  assert.deepEqual(r.changed, [3]);
  assert.deepEqual(r.slots[3], { itemGuid: B, wcid: 273 });
  assert.deepEqual(r.slots.slice(0, 3), slots.slice(0, 3));
  assert.deepEqual(slots[3], { itemGuid: A, wcid: 273 }, "input not mutated");
});
check("a merge from an unbound guid changes nothing", () => {
  const slots = [{ itemGuid: C }];
  assert.deepEqual(retargetBindings(slots, A, B), { slots, changed: [] });
  assert.deepEqual(retargetBindings(slots, C, C).changed, [], "self-merge is not a retarget");
});

console.log("\n[2] staleBindingAction — no re-bind by wcid");
check("A used up while a same-wcid stack C exists → clear (retail removes the shortcut)", () => {
  const inv = new Set([C]);
  assert.equal(staleBindingAction({ itemGuid: A, wcid: 273 }, inv, new Set([A, C]), false), "clear");
});
check("a never-seen guid inside the post-login grace → keep; after it → clear", () => {
  assert.equal(staleBindingAction({ itemGuid: A }, new Set([C]), new Set([C]), false), "keep");
  assert.equal(staleBindingAction({ itemGuid: A }, new Set([C]), new Set([C]), true), "clear");
});
check("a present item and a spell binding → keep", () => {
  assert.equal(staleBindingAction({ itemGuid: C }, new Set([C]), new Set([C]), true), "keep");
  assert.equal(staleBindingAction({ spellId: 27 }, new Set(), new Set(), true), "keep");
});

console.log("\n[3] item_drag 'merge' → hb:item-merge");
const sent = [];
const merges = [];
globalThis.__sessionHandle = { mergeStacks: (...a) => sent.push(a) };
globalThis.addEventListener("hb:item-merge", (ev) => merges.push(ev.detail));
check("a sent StackableMerge announces {from, to} (partial merge included)", () => {
  const ok = drag.executeItemAction({ op: "merge", guid: A, target: B, amount: 5 }, { guid: A, item: { stackSize: 10 }, owned: true });
  assert.equal(ok, true);
  assert.deepEqual(sent.at(-1), [A, B, 5]);
  assert.deepEqual(merges.at(-1), { from: A, to: B });
});
check("no handle method → nothing sent, nothing announced", () => {
  const n = merges.length;
  globalThis.__sessionHandle = {};
  assert.equal(drag.executeItemAction({ op: "merge", guid: C, target: B, amount: 1 }, { guid: C, item: { stackSize: 1 }, owned: true }), false);
  assert.equal(merges.length, n);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
