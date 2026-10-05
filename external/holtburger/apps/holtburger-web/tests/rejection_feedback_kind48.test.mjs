// tests/rejection_feedback_kind48.test.mjs — plugins/rejection_feedback.js
// consumes the AUTHORITATIVE kind=48 InventoryActionFailed (item GUID +
// WeenieError from GameEvent 0x00A0) and only falls back to the kind:13
// recent-action guess when no GUID is available.
//
// Run: node tests/rejection_feedback_kind48.test.mjs
import assert from "node:assert/strict";

// ── minimal DOM + bus stubs (installed BEFORE the module evaluates) ──────
const toasts = [];
const flashed = [];
const fakeNode = (sel) => ({
  classList: { add: () => flashed.push(sel), remove: () => {} },
});
globalThis.document = {
  getElementById: () => null,
  createElement: () => {
    const el = { remove() {}, classList: { add() {}, remove() {} } };
    return el;
  },
  head: { appendChild() {} },
  body: { appendChild: (el) => { if (el.className === "hb-rejection-toast") toasts.push(el.textContent); } },
  querySelectorAll: (sel) => (sel.includes('"305419896"') ? [fakeNode(sel)] : []),
};
const bus = new EventTarget();
const emitted = [];
const client = {
  events: {
    on: (n, h) => bus.addEventListener(n, h),
    emit: (n, p) => { emitted.push([n, p]); bus.dispatchEvent(new CustomEvent(n, { detail: p })); },
  },
  attachHandle() {},
};
const calls = [];
const rawHandle = { moveItem: (...a) => calls.push(a) };
globalThis.window = { __pluginClient: client, __sessionHandle: rawHandle };

await import("../plugins/rejection_feedback.js");

const reset = () => { toasts.length = 0; flashed.length = 0; emitted.length = 0; };

// 1. Authoritative kind:48 → one toast, slot flash for the wire GUID.
reset();
client.events.emit("kind:48", { kind: 48, u32Payload: 0x12345678, u32Payload2: 0x001d, stringPayload: "YoureTooBusy" });
assert.equal(toasts.length, 1, "kind:48 renders exactly one toast");
assert.ok(flashed.length > 0, "kind:48 flashes the item's slot");

// 2. The paired transient chat line from the same 0x00A0 arm is suppressed once…
client.events.emit("kind:2", { u32Payload2: 9, stringPayload: "[Wield failed] YoureTooBusy" });
assert.equal(toasts.length, 1, "paired transient chat line is not toasted twice");
// …but the next transient line toasts normally.
client.events.emit("kind:2", { u32Payload2: 9, stringPayload: "You are out of ammunition!" });
assert.equal(toasts.length, 2, "suppression is one-shot");

// 3. Fallback: GUID-less kind:13 after a tracked inventory action → guessed + synthetic re-emit.
reset();
window.__sessionHandle.moveItem(0x12345678, 0x50000001, 0);
assert.equal(calls.length, 1, "proxy still delegates to the raw handle");
client.events.emit("kind:13", { u32Payload: 0x001d, stringPayload: "YoureTooBusy" });
assert.equal(toasts.length, 1, "fallback kind:13 renders one toast (synthetic kind:48 not re-rendered)");
const syn = emitted.find(([n]) => n === "kind:48");
assert.ok(syn && syn[1].synthetic === true && syn[1].u32Payload === 0x12345678, "fallback emits a synthetic kind:48");

// 4. Authoritative kind:48 retires the ring entry: a later GUID-less kind:13 is NOT mis-attributed.
reset();
window.__sessionHandle.moveItem(0x12345678, 0x50000001, 0);
client.events.emit("kind:48", { u32Payload: 0x12345678, u32Payload2: 0x001d });
client.events.emit("kind:13", { u32Payload: 0x001d });
assert.equal(toasts.length, 1, "kind:13 after kind:48 for the same item does not toast again");

// 5. Pre-kind-48 wasm: kind:13 with the GUID in u32Payload2 is treated as authoritative.
reset();
client.events.emit("kind:13", { u32Payload: 0x001d, u32Payload2: 0x12345678 });
assert.equal(toasts.length, 1);
assert.ok(flashed.length > 0);

console.log("rejection_feedback_kind48: 5/5 PASS");
