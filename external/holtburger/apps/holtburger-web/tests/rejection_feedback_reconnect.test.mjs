// tests/rejection_feedback_reconnect.test.mjs — 2026-10-18 review §7 follow-up
// (plugins-b). plugins/rejection_feedback.js wraps window.__sessionHandle in a
// Proxy that records the item guid of every tracked action (so a later
// WeenieError / InventoryActionFailed can flash the right slot) and hands the
// proxy to the plugin facade. Its install poll stopped after the first success,
// so a RECONNECT (autoLogin retry, kick) left the new session's handle — the
// global and the facade, which index.html rebinds raw — untracked for the rest
// of the page (a documented "KNOWN GAP"). The module now re-wraps on the boot
// states the new login fires.
//
//   R1 first session: wrapped, the facade gets the proxy
//   R2 a reconnect's raw handle is wrapped at the next boot state, and the
//      facade is re-pointed at the proxy
//   R3 an already-wrapped handle is left alone (no proxy of a proxy)
//   R4 wasm methods still run against the raw handle (private-field binding)
//
// Run: node tests/rejection_feedback_reconnect.test.mjs
import assert from "node:assert/strict";

globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ remove() {}, classList: { add() {}, remove() {} } }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  querySelectorAll: () => [],
};
const bus = new EventTarget();
const attached = [];
const client = {
  events: { on: (n, h) => bus.addEventListener(n, h) },
  attachHandle: (h) => attached.push(h),
};
/** A wasm-bindgen-like handle: methods read a private field off `this`. */
class FakeHandle {
  #ptr;
  constructor(ptr) { this.#ptr = ptr; this.moved = []; }
  moveItem(guid) { this.moved.push([this.#ptr, guid >>> 0]); }
  setCombatMode() { return this.#ptr; }
}
const win = new EventTarget();
win.__pluginClient = client;
win.__sessionHandle = new FakeHandle(1);
globalThis.window = win;

await import("../plugins/rejection_feedback.js");
const state = (s) => win.dispatchEvent(new CustomEvent("holtburger:state", { detail: { state: s } }));

let passed = 0;
const step = (name, fn) => { fn(); passed++; console.log(`  ok ${passed} - ${name}`); };

const first = win.__sessionHandle;
step("R1 the first session's handle is wrapped and handed to the facade", () => {
  assert.equal(first.__hbWrappedForRejection, true);
  assert.equal(attached.at(-1), first);
});

step("R2 a reconnect's raw handle is wrapped at the next boot state", () => {
  const raw = new FakeHandle(2);
  // index.html: set the global, rebind the facade raw, then the login's states.
  win.__sessionHandle = raw;
  client.attachHandle(raw);
  state("char-list-ready");
  const h = win.__sessionHandle;
  assert.notEqual(h, raw, "the global is a proxy again");
  assert.equal(h.__hbWrappedForRejection, true);
  assert.equal(attached.at(-1), h, "the facade points at the proxy, not the raw handle");
});

step("R3 an already-wrapped handle is left alone", () => {
  const h = win.__sessionHandle;
  const n = attached.length;
  state("spawning");
  state("in-world");
  assert.equal(win.__sessionHandle, h);
  assert.equal(attached.length, n);
});

step("R4 wasm methods still reach the raw handle through the proxy", () => {
  const h = win.__sessionHandle;
  h.moveItem(0x12345678);
  assert.equal(h.setCombatMode(), 2, "untracked methods are bound to the raw handle");
  assert.deepEqual(h.moved.at(-1), [2, 0x12345678]);
});

console.log(`\n${passed} passed`);
