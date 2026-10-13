// tests/rejection_toast_stack.test.mjs — chat-errors-6 (2026-10-13).
//
// plugins/rejection_feedback.js's single replace-in-place toast is now
// retail's spew box (gmSpewBoxUI::Update, acclient.c:261533): newest row on
// top, an identical top row replaced, at most 4 rows (ListBox 0x10000049
// property 0x10000028), each row removed 5 s after it went in (item template
// 0x1000004A: Pause 5 s → message 0x10000003 → DeleteItem). Both values were
// read from our client_local_English.dat. Rows keep the old toast's class and
// an `hb-` id. `?spewBox=off` restores the single 2.4 s toast. Also covers the
// app/chat_log.js → `window.__hbSpewBox` hop end to end.
//
// Run: node tests/rejection_toast_stack.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";

// ── fake timers (installed BEFORE the module evaluates) ───────────────────
const timers = new Map();
let nextTimer = 0;
let clock = 0;
globalThis.setTimeout = (fn, ms = 0) => {
  const id = ++nextTimer;
  timers.set(id, { fn, at: clock + Number(ms) });
  return id;
};
globalThis.clearTimeout = (id) => { timers.delete(id); };
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
function advance(ms) {
  const end = clock + ms;
  for (;;) {
    let next = null;
    for (const [id, t] of timers) {
      if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
    }
    if (!next) break;
    timers.delete(next[0]);
    clock = next[1].at;
    next[1].fn();
  }
  clock = end;
}

// ── minimal DOM ───────────────────────────────────────────────────────────
const ROW_H = 26;
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.id = "";
    this.className = "";
    this.textContent = "";
    this.style = {};
    this.parent = null;
    this.children = [];
    this.dataset = {};
    this.offsetHeight = ROW_H;
    this.classList = { add() {}, remove() {} };
    this.scrollTop = 0;
    this.clientHeight = 100;
  }
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0] ?? null; }
  get scrollHeight() { return this.children.length * 15; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  addEventListener() {}
}
const body = new El("body");
const head = new El("head");
globalThis.document = {
  body,
  head,
  createElement: (t) => new El(t),
  getElementById: (id) => [...body.children, ...head.children].find((c) => c.id === id) ?? null,
  querySelectorAll: () => [],
};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
globalThis.location = { search: "" };

const bus = new EventTarget();
const client = {
  events: {
    on: (n, h) => bus.addEventListener(n, h),
    emit: (n, p) => bus.dispatchEvent(new CustomEvent(n, { detail: p })),
  },
  attachHandle() {},
};
globalThis.window = globalThis;
window.__pluginClient = client;
window.__sessionHandle = { moveItem() {} };

const spew = await import("../ui/spew_box.js");
await import("../plugins/rejection_feedback.js");
const { initChatLog } = await import("../app/chat_log.js");
const chatLog = new El("ul");
const { appendChatLine } = initChatLog({ chatLog, chatTabs: new El("div") });

const toastRows = () => body.children
  .filter((c) => c.className === "hb-rejection-toast")
  .sort((a, b) => parseInt(a.style.top, 10) - parseInt(b.style.top, 10));
const texts = () => toastRows().map((r) => r.textContent);
const reject = (message) => client.events.emit("clientActionRejected", { message });
function clear() {
  advance(60_000);
  assert.equal(toastRows().length, 0, "every row expired");
  globalThis.location = { search: "" };
  chatLog.children.length = 0;
}

test("the DAT-verified cap and lifetime", () => {
  assert.equal(spew.SPEW_MAX_ITEMS, 4);
  assert.equal(spew.SPEW_ITEM_LIFETIME_MS, 5000);
});

test("two different lines give two rows, newest on top", () => {
  clear();
  reject("You can't do that while in the air!");
  reject("You're too busy!");
  assert.deepEqual(texts(), ["You're too busy!", "You can't do that while in the air!"]);
  const [top, below] = toastRows();
  assert.equal(top.style.top, "64px", "the top row sits where the single toast did");
  assert.equal(below.style.top, `${64 + ROW_H + 4}px`);
  for (const r of toastRows()) assert.match(r.id, /^hb-rejection-toast-\d+$/, "an hb- id (agent mode)");
  assert.notEqual(top.id, below.id);
});

test("an identical top line replaces the top row instead of stacking", () => {
  clear();
  reject("You can't do that while in the air!");
  reject("You're too busy!");
  const oldTop = toastRows()[0];
  reject("You're too busy!");
  assert.deepEqual(texts(), ["You're too busy!", "You can't do that while in the air!"]);
  assert.equal(oldTop.parent, null, "the old top row left the page");
  assert.notEqual(toastRows()[0], oldTop, "a fresh row took its place");
  // Only the TOP row is compared (retail): a repeat of a lower row stacks.
  reject("You can't do that while in the air!");
  assert.deepEqual(texts(), [
    "You can't do that while in the air!", "You're too busy!", "You can't do that while in the air!",
  ]);
});

test("rows beyond the cap of 4 are removed, oldest first", () => {
  clear();
  for (const t of ["one", "two", "three", "four", "five", "six"]) reject(t);
  assert.deepEqual(texts(), ["six", "five", "four", "three"]);
  assert.equal(body.children.filter((c) => c.className === "hb-rejection-toast").length, 4,
    "dropped rows are detached, not hidden");
});

test("each row clears 5 s after it went in", () => {
  clear();
  reject("first");
  advance(3000);
  reject("second");
  assert.deepEqual(texts(), ["second", "first"]);
  advance(1999);
  assert.deepEqual(texts(), ["second", "first"]);
  advance(1);
  assert.deepEqual(texts(), ["second"], "first expired at 5 s");
  assert.equal(toastRows()[0].style.top, "64px", "the survivor moves up");
  advance(3000);
  assert.deepEqual(texts(), []);
});

test("a replaced top row gets a fresh 5 s", () => {
  clear();
  reject("You're too busy!");
  advance(4000);
  reject("You're too busy!");
  advance(1500);
  assert.deepEqual(texts(), ["You're too busy!"]);
  advance(3500);
  assert.deepEqual(texts(), []);
});

test("window.__hbSpewBox takes a right-trimmed line", () => {
  clear();
  assert.equal(typeof window.__hbSpewBox?.push, "function");
  window.__hbSpewBox.push("You charged too far!\n");
  window.__hbSpewBox.push("   ");
  assert.deepEqual(texts(), ["You charged too far!"], "blank lines add no row");
});

test("chat_log: a transient line lands in the spew box, not the log", () => {
  clear();
  appendChatLine("You can't jump while in the air", 9);
  appendChatLine("Hello there", 0);
  assert.deepEqual(texts(), ["You can't jump while in the air"]);
  assert.deepEqual(chatLog.children.map((li) => li.textContent), ["Hello there"]);
});

test("kind=48 then its paired transient chat line collapse into one row", () => {
  clear();
  const line = "The Pyreal can't be picked up - action cancelled";
  client.events.emit("kind:48", { u32Payload: 0x12345678, u32Payload2: 0x36, stringPayload: line });
  appendChatLine(line, 9); // the wasm's paired 0x00A0 line, through the live chat route
  appendChatLine("Action cancelled!", 9); // the code's own HandleFailureEvent line
  assert.deepEqual(texts(), ["Action cancelled!", line]);
});

test("the fizzle line (retail type 7) is never stacked", () => {
  clear();
  client.events.emit("kind:2", { u32Payload2: 9, stringPayload: "Your spell fizzled." });
  appendChatLine("Your spell fizzled.", 9);
  assert.deepEqual(texts(), []);
  assert.deepEqual(chatLog.children.map((li) => li.textContent), ["Your spell fizzled."]);
  client.events.emit("kind:2", { u32Payload2: 9, stringPayload: "You are out of ammunition!" });
  assert.deepEqual(texts(), ["You are out of ammunition!"]);
});

test("?spewBox=off restores the single replace-in-place 2.4 s toast", () => {
  clear();
  globalThis.location = { search: "?spewBox=off" };
  reject("one");
  reject("two");
  const rows = body.children.filter((c) => c.className === "hb-rejection-toast");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "hb-rejection-toast");
  assert.equal(rows[0].textContent, "two");
  assert.equal(rows[0].style.top, undefined, "no stack layout");
  advance(2399);
  assert.equal(body.children.filter((c) => c.className === "hb-rejection-toast").length, 1);
  advance(1);
  assert.equal(body.children.filter((c) => c.className === "hb-rejection-toast").length, 0);
  // …and the chat copy is back.
  appendChatLine("You're too busy!", 9);
  assert.deepEqual(chatLog.children.map((li) => li.textContent), ["You're too busy!"]);
  globalThis.location = { search: "" };
});

test("createSpewStack model", () => {
  const s = spew.createSpewStack({ max: 2, lifetimeMs: 100 });
  assert.equal(s.push("", 0), null);
  const a = s.push("a\r\n", 0);
  assert.equal(a.item.text, "a");
  assert.equal(a.item.expiresAt, 100);
  assert.deepEqual(a.removed, []);
  const b = s.push("b", 10);
  assert.deepEqual(s.items.map((i) => i.text), ["b", "a"]);
  const b2 = s.push("b", 20);
  assert.deepEqual(b2.removed.map((i) => i.id), [b.item.id], "identical top replaced");
  assert.deepEqual(s.items.map((i) => i.text), ["b", "a"]);
  const c = s.push("c", 30);
  assert.deepEqual(c.removed.map((i) => i.text), ["a"], "overflow tail dropped");
  assert.deepEqual(s.items.map((i) => i.text), ["c", "b"]);
  assert.equal(s.remove(b2.item.id)?.text, "b");
  assert.equal(s.remove(b2.item.id), null);
  assert.equal(s.size, 1);
});
