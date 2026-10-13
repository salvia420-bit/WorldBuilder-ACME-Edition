// tests/chat_log_errors_filter.test.mjs — chat-errors-6 (2026-10-13).
//
// Retail text type 0x1A (holtburger CHAT_CATEGORY_TRANSIENT, 9) goes to the
// spew box over the 3D view (gmSpewBoxUI::RecvNotice_DisplayFinalStringInfo,
// acclient.c:261680 — only type 26), and every chat window starts with that
// filter bit cleared (ChatInterface ctor, acclient.c:288232
// `m_llTextTypeFilter &= 0xFBFFFFFF`). app/chat_log.js appendChatLine now
// hands those lines to `window.__hbSpewBox` and adds them to the log only
// when the per-viewer "Errors" option is on. Other categories, the chat-only
// fizzle line, a missing spew box and `?spewBox=off` keep the log copy.
//
// Run: node tests/chat_log_errors_filter.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";

// ── minimal DOM: just what initChatLog / appendChatLine touch ─────────────
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.className = "";
    this.dataset = {};
    this.textContent = "";
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
  querySelector(sel) {
    return sel === "li.empty" ? (this.children.find((c) => c.className === "empty") ?? null) : null;
  }
  querySelectorAll() { return []; }
  addEventListener() {}
}

const store = new Map();
const goodStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
globalThis.localStorage = goodStorage;
globalThis.document = { createElement: (t) => new FakeEl(t) };
globalThis.window = globalThis;
globalThis.location = { search: "" };

const pushed = [];
const sink = Object.freeze({ push: (t) => pushed.push(t) });
window.__hbSpewBox = sink;

const { initChatLog, CHAT_CATEGORY } = await import("../app/chat_log.js");
const spew = await import("../ui/spew_box.js");

const chatLog = new FakeEl("ul");
const empty = chatLog.appendChild(new FakeEl("li"));
empty.className = "empty";
const chatTabs = new FakeEl("div");
const { appendChatLine } = initChatLog({ chatLog, chatTabs });

const T = CHAT_CATEGORY.TRANSIENT;
const logTexts = () => chatLog.children.map((li) => li.textContent);
function fresh({ search = "", errors = false, withSink = true } = {}) {
  chatLog.children.length = 0;
  pushed.length = 0;
  globalThis.location = { search };
  if (errors) store.set(spew.CHAT_ERRORS_KEY, "1");
  else store.delete(spew.CHAT_ERRORS_KEY);
  if (withSink) window.__hbSpewBox = sink;
  else delete window.__hbSpewBox;
}

test("TRANSIENT is the retail 0x1A category the spew box takes", () => {
  assert.equal(T, 9);
  assert.equal(spew.CHAT_CATEGORY_TRANSIENT, T);
});

test("a transient line with Errors off goes to the spew box, not the log", () => {
  fresh();
  appendChatLine("You're too busy!", T);
  assert.deepEqual(logTexts(), []);
  assert.deepEqual(pushed, ["You're too busy!"]);
});

test("the empty-state placeholder stays until a line really lands in the log", () => {
  fresh();
  const ph = chatLog.appendChild(new FakeEl("li"));
  ph.className = "empty";
  appendChatLine("You're too busy!", T);
  assert.equal(chatLog.children.length, 1, "spew-only line leaves the placeholder");
  appendChatLine("You have entered the General channel.", 0);
  assert.deepEqual(logTexts(), ["You have entered the General channel."]);
});

test("with Errors on, the transient line is in both the spew box and the log", () => {
  fresh({ errors: true });
  appendChatLine("You're too busy!", T);
  assert.deepEqual(logTexts(), ["You're too busy!"]);
  assert.equal(chatLog.children[0].className, "cat-9");
  assert.equal(chatLog.children[0].dataset.cat, "9");
  assert.deepEqual(pushed, ["You're too busy!"]);
});

test("category 0 (and every other category) always appends and never reaches the spew box", () => {
  for (const errors of [false, true]) {
    fresh({ errors });
    appendChatLine("Welcome to Asheron's Call!", 0);
    appendChatLine("Bob says, \"hi\"", CHAT_CATEGORY.LOCAL);
    appendChatLine("You cast Strength Self I on yourself", CHAT_CATEGORY.MAGIC);
    appendChatLine("[Popup] hi", CHAT_CATEGORY.POPUP);
    assert.equal(chatLog.children.length, 4, `errors=${errors}`);
    assert.deepEqual(pushed, []);
  }
});

test("a local echo (null category) always appends", () => {
  fresh();
  appendChatLine("> hello", null);
  assert.deepEqual(logTexts(), ["> hello"]);
  assert.equal(chatLog.children[0].className, "echo");
  assert.deepEqual(pushed, []);
});

test("'Your spell fizzled.' rides TRANSIENT but is a retail type-7 chat line: log only", () => {
  fresh();
  appendChatLine("Your spell fizzled.", T);
  assert.deepEqual(logTexts(), ["Your spell fizzled."]);
  assert.deepEqual(pushed, []);
});

test("?spewBox=off restores the log copy and skips the spew box", () => {
  for (const v of ["off", "0", "false", "OFF"]) {
    fresh({ search: `?spewBox=${v}` });
    appendChatLine("You're too busy!", T);
    assert.deepEqual(logTexts(), ["You're too busy!"], v);
    assert.deepEqual(pushed, [], v);
  }
});

test("without a spew box (rejection_feedback not loaded) the line stays in the log", () => {
  fresh({ withSink: false });
  appendChatLine("You're too busy!", T);
  assert.deepEqual(logTexts(), ["You're too busy!"]);
});

test("a spew box that throws still leaves the log to the Errors option", () => {
  fresh();
  window.__hbSpewBox = { push() { throw new Error("boom"); } };
  appendChatLine("You're too busy!", T);
  assert.deepEqual(logTexts(), []);
  fresh({ errors: true });
  window.__hbSpewBox = { push() { throw new Error("boom"); } };
  appendChatLine("You're too busy!", T);
  assert.deepEqual(logTexts(), ["You're too busy!"]);
  window.__hbSpewBox = sink;
});

test("?chatErrors sets and clears the remembered option at init", () => {
  fresh();
  globalThis.location = { search: "?chatErrors=1" };
  initChatLog({ chatLog, chatTabs });
  assert.equal(store.get(spew.CHAT_ERRORS_KEY), "1");
  assert.equal(spew.chatErrorsEnabled(), true);
  globalThis.location = { search: "" };
  initChatLog({ chatLog, chatTabs });
  assert.equal(spew.chatErrorsEnabled(), true, "no param keeps the stored value");
  globalThis.location = { search: "?chatErrors=off" };
  initChatLog({ chatLog, chatTabs });
  assert.equal(store.has(spew.CHAT_ERRORS_KEY), false);
  assert.equal(spew.chatErrorsEnabled(), false);
  spew.applyChatErrorsParam("?chatErrors=on");
  assert.equal(spew.chatErrorsEnabled(), true);
  spew.applyChatErrorsParam("?chatErrors=maybe");
  assert.equal(spew.chatErrorsEnabled(), true, "an unknown value changes nothing");
  spew.applyChatErrorsParam("?chatErrors=0");
  assert.equal(spew.chatErrorsEnabled(), false);
  globalThis.location = { search: "" };
});

test("blocked storage reads as Errors off and never throws", () => {
  const blocked = {
    getItem() { throw new Error("SecurityError"); },
    setItem() { throw new Error("SecurityError"); },
    removeItem() { throw new Error("SecurityError"); },
  };
  assert.equal(spew.chatErrorsEnabled(blocked), false);
  assert.doesNotThrow(() => spew.setChatErrorsEnabled(true, blocked));
  assert.doesNotThrow(() => spew.applyChatErrorsParam("?chatErrors=1", blocked));
  globalThis.localStorage = blocked;
  try {
    fresh();
    appendChatLine("You're too busy!", T);
    assert.deepEqual(logTexts(), [], "the default (off) applies");
    assert.deepEqual(pushed, ["You're too busy!"]);
  } finally {
    globalThis.localStorage = goodStorage;
  }
});

test("spewBoxEnabled / isSpewLine", () => {
  assert.equal(spew.spewBoxEnabled(""), true, "default on");
  assert.equal(spew.spewBoxEnabled("?spewBox=on"), true);
  assert.equal(spew.spewBoxEnabled("?a=1&spewBox=off"), false);
  assert.equal(spew.spewBoxEnabled("?spewBox=0"), false);
  assert.equal(spew.spewBoxEnabled("?spewBox=false"), false);
  assert.equal(spew.isSpewLine("You're too busy!", 9), true);
  assert.equal(spew.isSpewLine("You're too busy!", "9"), true);
  assert.equal(spew.isSpewLine("You're too busy!", 0), false);
  assert.equal(spew.isSpewLine("Your spell fizzled.", 9), false);
  assert.equal(spew.isSpewLine("Your spell fizzled.\n", 9), false);
  assert.equal(spew.isSpewLine("Your spell's target is missing!", 9), true);
});
