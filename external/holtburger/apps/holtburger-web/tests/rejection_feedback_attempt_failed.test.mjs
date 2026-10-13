// tests/rejection_feedback_attempt_failed.test.mjs — messages-objects-1
// (2026-10-13). The wasm's kind=48 InventoryActionFailed now carries retail's
// composed ServerSaysAttemptFailed line (acclient.c:439317) in stringPayload
// ("The Pyreal can't be picked up"; "" when retail prints none).
// plugins/rejection_feedback.js toasts that line instead of
// weenieErrorMessage(code) — no "WeenieError 0x0000" for ACE's default code 0 —
// while an older pkg's Debug-label payload keeps the code's own toast.
//
// Run: node tests/rejection_feedback_attempt_failed.test.mjs
import assert from "node:assert/strict";

// ── minimal DOM + bus stubs (installed BEFORE the module evaluates) ──────
const toasts = [];
const flashed = [];
const fakeNode = (sel) => ({
  classList: { add: () => flashed.push(sel), remove: () => {} },
});
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ remove() {}, classList: { add() {}, remove() {} } }),
  head: { appendChild() {} },
  body: { appendChild: (el) => { if (el.className === "hb-rejection-toast") toasts.push(el.textContent); } },
  querySelectorAll: (sel) => (sel.includes('"305419896"') ? [fakeNode(sel)] : []),
};
const bus = new EventTarget();
const client = {
  events: {
    on: (n, h) => bus.addEventListener(n, h),
    emit: (n, p) => bus.dispatchEvent(new CustomEvent(n, { detail: p })),
  },
  attachHandle() {},
};
globalThis.window = { __pluginClient: client, __sessionHandle: { moveItem() {} } };

await import("../plugins/rejection_feedback.js");

const ITEM = 0x12345678;
const reset = () => { toasts.length = 0; flashed.length = 0; };
let passed = 0;
const step = (name, fn) => { reset(); fn(); passed++; console.log(`  ok ${passed} - ${name}`); };

step("code 0 with the retail line toasts the line, not 'WeenieError 0x0000'", () => {
  client.events.emit("kind:48", {
    kind: 48, u32Payload: ITEM, u32Payload2: 0, stringPayload: "The Pyreal can't be picked up",
  });
  assert.deepEqual(toasts, ["The Pyreal can't be picked up"]);
  assert.ok(flashed.length > 0, "the item's slot still flashes");
  // The paired transient chat line (same text) is not toasted twice.
  client.events.emit("kind:2", { u32Payload2: 9, stringPayload: "The Pyreal can't be picked up" });
  assert.equal(toasts.length, 1);
});

step("a suffixed line wins over the code's own text", () => {
  client.events.emit("kind:48", {
    u32Payload: ITEM, u32Payload2: 0x36,
    stringPayload: "The Pyreal can't be picked up - action cancelled",
  });
  assert.deepEqual(toasts, ["The Pyreal can't be picked up - action cancelled"]);
});

step("a bare retail suffix (no request pending) is still a line", () => {
  client.events.emit("kind:48", { u32Payload: ITEM, u32Payload2: 0x3ee, stringPayload: " - the container is closed" });
  assert.deepEqual(toasts, [" - the container is closed"]);
});

step("code 0 with an empty line (retail prints nothing) toasts nothing", () => {
  client.events.emit("kind:48", { u32Payload: ITEM, u32Payload2: 0, stringPayload: "" });
  assert.equal(toasts.length, 0);
});

step("a non-zero code with no line keeps the code's toast", () => {
  client.events.emit("kind:48", { u32Payload: ITEM, u32Payload2: 0x1d, stringPayload: "" });
  assert.deepEqual(toasts, ["You're too busy!"]);
});

step("an older pkg's Debug label is not toasted as text", () => {
  client.events.emit("kind:48", { u32Payload: ITEM, u32Payload2: 0x1d, stringPayload: "YoureTooBusy" });
  assert.deepEqual(toasts, ["You're too busy!"]);
  reset();
  client.events.emit("kind:48", { u32Payload: ITEM, u32Payload2: 0, stringPayload: "None" });
  assert.equal(toasts.length, 0, "code 0 never toasts 'WeenieError 0x0000'");
});

console.log(`rejection_feedback_attempt_failed: ${passed}/6 PASS`);
