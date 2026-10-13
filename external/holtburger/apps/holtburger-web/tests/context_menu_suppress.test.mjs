// tests/context_menu_suppress.test.mjs — input-options-8 (2026-10-13).
//
// The browser's context menu only stopped on the 3D canvas, the virtual
// keypad and HUD cells with their own right-click. Windows fires
// `contextmenu` on the mouse-up target, so a right-drag camera turn released
// over chat, radar or vitals opened Chrome's menu; it took the keyboard, and
// the funnel's fallback released every held key (a running player stopped).
// Retail had no OS context menu. ui/input-funnel.js now suppresses it
// page-wide from a document bubble listener, keeping it for text fields
// (paste) and selected text (Copy from the deliberately selectable chat log).
//
// CONTRACT
//   [a] shouldSuppressContextMenu: INPUT/TEXTAREA/SELECT/contentEditable →
//       false; a target in a `user-select: text` region holding the
//       selection → false; HUD chrome → true; a right press that began on
//       the canvas → true wherever it ends. Only `ev.target` counts.
//   [b] `?nativeContextMenu=on` (opt-in escape) reader.
//   [c] installed funnel: suppresses on the document in bubble phase, after
//       element handlers and before the window release-held fallback; the
//       canvas mark is consumed by the next contextmenu and cleared by any
//       mouse press; the escape installs nothing.
//   [d] by source: camera.js marks its right press on the canvas.
//
// Run from apps/holtburger-web/:  node tests/context_menu_suppress.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  InputFunnel,
  shouldSuppressContextMenu,
  readNativeContextMenuFlag,
  isTextEntryElement,
  _resetNativeContextMenuForTest,
} from "../ui/input-funnel.js";

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

// keymap.js reads user rebinds from localStorage; absent = defaults.
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null, setItem() {}, removeItem() {},
};

// ── fake DOM ────────────────────────────────────────────────────────────
function el(tagName, parent = null, extra = {}) {
  return { tagName, parentNode: parent, parentElement: parent, ...extra };
}
function text(parent) {
  return { nodeType: 3, parentNode: parent, parentElement: parent };
}
// body > hud > { chat > log > line > "text", radar, input }
const body = el("BODY");
const hud = el("DIV", body, { className: "hud" });
const chat = el("DIV", hud, { className: "hb-chat" });
const log = el("DIV", chat, { className: "hb-chat-log" });
const line = el("DIV", log, { className: "hb-chat-line" });
const lineText = text(line);
const line2 = el("DIV", log, { className: "hb-chat-line" });
const radar = el("DIV", hud, { className: "hb-radar" });
const input = el("INPUT", chat, { className: "hb-chat-input" });
const canvas = el("CANVAS", body);
// Computed `user-select`: only the chat log is `text` (chat-panel.js:181).
const userSelectOf = (n) => (n === log ? "text" : n === hud ? "none" : "auto");
const selIn = (anchor, focus = anchor) => () => ({ isCollapsed: false, anchorNode: anchor, focusNode: focus });
const collapsed = () => ({ isCollapsed: true, anchorNode: lineText, focusNode: lineText });
const none = () => null;
const ctx = (extra) => ({ userSelectOf, getSelection: none, ...extra });
const cm = (target) => ({ type: "contextmenu", target });

// ── [a] ────────────────────────────────────────────────────────────────
test("[a] text fields keep the browser menu (paste)", () => {
  assert.equal(shouldSuppressContextMenu(cm(input), ctx()), false, "INPUT");
  assert.equal(shouldSuppressContextMenu(cm(el("TEXTAREA", hud)), ctx()), false, "TEXTAREA");
  assert.equal(shouldSuppressContextMenu(cm(el("SELECT", hud)), ctx()), false, "SELECT");
  assert.equal(shouldSuppressContextMenu(cm(el("DIV", hud, { isContentEditable: true })), ctx()), false, "contentEditable");
  assert.equal(isTextEntryElement(el("DIV", hud, { isContentEditable: false })), false, "plain div is not a text field");
});

test("[a] selected text in the chat log keeps the menu (Copy)", () => {
  assert.equal(shouldSuppressContextMenu(cm(line), ctx({ getSelection: selIn(lineText) })), false, "on the selected line");
  assert.equal(shouldSuppressContextMenu(cm(line2), ctx({ getSelection: selIn(lineText) })), false, "elsewhere in the same log");
  assert.equal(shouldSuppressContextMenu(cm(log), ctx({ getSelection: selIn(text(line2), lineText) })), false, "focus end in the log");
});

test("[a] ordinary HUD chrome suppresses", () => {
  assert.equal(shouldSuppressContextMenu(cm(radar), ctx()), true, "radar, no selection");
  assert.equal(shouldSuppressContextMenu(cm(hud), ctx()), true, "HUD root");
  assert.equal(shouldSuppressContextMenu(cm(body), ctx()), true, "page background");
  assert.equal(shouldSuppressContextMenu(cm(radar), ctx({ getSelection: selIn(lineText) })), true,
    "a chat selection does not exempt the radar");
  assert.equal(shouldSuppressContextMenu(cm(line), ctx({ getSelection: collapsed })), true,
    "a collapsed selection (nothing to copy) does not exempt the log");
  assert.equal(shouldSuppressContextMenu(cm(line), ctx()), true, "chat log with no selection");
});

test("[a] a right press that began on the canvas suppresses wherever it ends", () => {
  assert.equal(shouldSuppressContextMenu(cm(line), ctx({ rightPressOnCanvas: true })), true,
    "over the chat log, no selection");
  assert.equal(shouldSuppressContextMenu(cm(line), ctx({ rightPressOnCanvas: true, getSelection: selIn(lineText) })), true,
    "over a lingering chat selection");
  assert.equal(shouldSuppressContextMenu(cm(input), ctx({ rightPressOnCanvas: true })), true,
    "over the chat input");
  assert.equal(shouldSuppressContextMenu(cm(canvas), ctx({ rightPressOnCanvas: true })), true, "on the canvas");
});

test("[a] selection overlapping a target outside any user-select:text region", () => {
  const panel = el("DIV", body);
  const para = el("P", panel);
  const sel = () => ({
    isCollapsed: false, anchorNode: text(panel), focusNode: text(panel),
    containsNode: (n, partial) => partial === true && n === para,
  });
  assert.equal(shouldSuppressContextMenu(cm(para), ctx({ getSelection: sel })), false, "selection covers the target");
  assert.equal(shouldSuppressContextMenu(cm(radar), ctx({ getSelection: sel })), true, "selection elsewhere");
});

test("[a] only ev.target counts — a focused chat input does not exempt HUD chrome", () => {
  const saved = globalThis.document;
  globalThis.document = { activeElement: { ...input, isConnected: true } };
  try {
    assert.equal(shouldSuppressContextMenu(cm(radar), ctx()), true);
  } finally {
    if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
  }
});

test("[a] defensive: odd inputs never throw", () => {
  assert.equal(shouldSuppressContextMenu(null), true);
  assert.equal(shouldSuppressContextMenu(undefined, null), true);
  assert.equal(shouldSuppressContextMenu(cm(radar)), true, "default seams with no window");
  assert.equal(shouldSuppressContextMenu(cm(line), ctx({ getSelection: () => { throw new Error("x"); } })), true,
    "a throwing getSelection is no selection");
  assert.equal(shouldSuppressContextMenu(cm(line), { getSelection: selIn(lineText), userSelectOf: () => { throw new Error("x"); } }), true,
    "a throwing style probe finds no region");
});

// ── [b] ────────────────────────────────────────────────────────────────
test("[b] ?nativeContextMenu is an opt-in escape", () => {
  assert.equal(readNativeContextMenuFlag(""), false, "absent → suppression installed");
  assert.equal(readNativeContextMenuFlag("?nativeContextMenu=on"), true);
  assert.equal(readNativeContextMenuFlag("?nativeContextMenu=ON"), true);
  assert.equal(readNativeContextMenuFlag("?nativeContextMenu=1"), true);
  assert.equal(readNativeContextMenuFlag("?nativeContextMenu=true"), true);
  assert.equal(readNativeContextMenuFlag("?nativeContextMenu=off"), false);
  assert.equal(readNativeContextMenuFlag("?nativeContextMenu="), false);
});

// ── [c] ────────────────────────────────────────────────────────────────
function listenerHost(extra = {}) {
  return {
    listeners: [],
    addEventListener(type, fn, opt) {
      this.listeners.push({ type, fn, capture: opt === true || !!(opt && opt.capture) });
    },
    removeEventListener() {},
    ...extra,
  };
}

/**
 * Install a funnel on a fake document + window and return a dispatcher that
 * walks the real phase order: window capture → document capture → element
 * handlers (target/bubble) → document bubble → window bubble.
 */
function rig(search = "") {
  const savedWindow = globalThis.window;
  const win = listenerHost({ location: { search } });
  globalThis.window = win;
  _resetNativeContextMenuForTest();
  const doc = listenerHost({ visibilityState: "visible" });
  const f = new InputFunnel().install(doc);
  const keys = {};
  f.bindRaw("test.keystate", (ev) => { keys[ev.code] = true; });
  f.bindRawUp("test.keystate", (ev) => { keys[ev.code] = false; });
  const run = (host, ev, capture) => {
    for (const l of [...host.listeners]) {
      if (l.type !== ev.type || l.capture !== capture) continue;
      l.fn(ev);
    }
  };
  const dispatch = (type, target, { button = 0, handlers = [] } = {}) => {
    const ev = {
      type, target, button, defaultPrevented: false, _stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this._stopped = true; },
    };
    run(win, ev, true);
    run(doc, ev, true);
    for (const h of handlers) { h(ev); if (ev._stopped) return ev; }
    run(doc, ev, false);
    if (!ev._stopped) run(win, ev, false);
    return ev;
  };
  const holdW = () => f.handleKeyDown({ key: "w", code: "KeyW", repeat: false, target: null, preventDefault() {} });
  const restore = () => {
    if (savedWindow === undefined) delete globalThis.window; else globalThis.window = savedWindow;
    _resetNativeContextMenuForTest();
  };
  return { f, doc, win, keys, dispatch, holdW, restore };
}

test("[c] HUD chrome: menu suppressed, held keys kept (the fallback never fires)", () => {
  const r = rig();
  try {
    r.holdW();
    const ev = r.dispatch("contextmenu", radar);
    assert.equal(ev.defaultPrevented, true, "browser menu suppressed");
    assert.equal(r.f.stats.contextMenusSuppressed, 1);
    assert.equal(r.keys.KeyW, true, "W still held — the player keeps running");
    assert.equal(r.f.stats.heldReleased, 0);
  } finally { r.restore(); }
});

test("[c] an element handler that already prevented it is left alone", () => {
  const r = rig();
  try {
    const hotbarCell = (ev) => ev.preventDefault();
    const ev = r.dispatch("contextmenu", radar, { handlers: [hotbarCell] });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(r.f.stats.contextMenusSuppressed, 0, "not counted twice");
  } finally { r.restore(); }
});

test("[c] a text field keeps the native menu; the release-held fallback still runs", () => {
  const r = rig();
  try {
    r.holdW();
    const ev = r.dispatch("contextmenu", input);
    assert.equal(ev.defaultPrevented, false, "paste menu opens");
    assert.equal(r.keys.KeyW, false, "the menu takes the keyboard → W released (existing safety net)");
    assert.equal(r.f.lastRelease?.reason, "contextmenu");
  } finally { r.restore(); }
});

test("[c] camera turn: right press on the canvas, released over the chat input (Windows)", () => {
  const r = rig();
  try {
    r.holdW();
    const cameraMouseDown = (ev) => { if (ev.button === 2) r.f.noteCanvasRightPress(); };
    r.dispatch("mousedown", canvas, { button: 2, handlers: [cameraMouseDown] });
    const ev = r.dispatch("contextmenu", input);
    assert.equal(ev.defaultPrevented, true, "no menu after a camera turn, even over a text field");
    assert.equal(r.keys.KeyW, true, "W still held");
    const next = r.dispatch("contextmenu", input);
    assert.equal(next.defaultPrevented, false, "the mark is consumed by that one contextmenu");
  } finally { r.restore(); }
});

test("[c] any later mouse press clears a stale canvas mark (mouse-up outside the window)", () => {
  const r = rig();
  try {
    const cameraMouseDown = (ev) => { if (ev.button === 2) r.f.noteCanvasRightPress(); };
    r.dispatch("mousedown", canvas, { button: 2, handlers: [cameraMouseDown] });
    // No contextmenu (released outside the window); then a left click on chat.
    r.dispatch("mousedown", line, { button: 0 });
    const ev = r.dispatch("contextmenu", input);
    assert.equal(ev.defaultPrevented, false, "paste menu is back");
  } finally { r.restore(); }
});

test("[c] a right press on the HUD does not mark the canvas", () => {
  const r = rig();
  try {
    r.dispatch("mousedown", radar, { button: 2 });
    const ev = r.dispatch("contextmenu", input);
    assert.equal(ev.defaultPrevented, false);
  } finally { r.restore(); }
});

test("[c] ?nativeContextMenu=on installs nothing — the browser menu opens as before", () => {
  const r = rig("?nativeContextMenu=on");
  try {
    assert.equal(r.doc.listeners.some((l) => l.type === "contextmenu"), false, "no document contextmenu listener");
    r.holdW();
    const ev = r.dispatch("contextmenu", radar);
    assert.equal(ev.defaultPrevented, false, "native menu");
    assert.equal(r.f.stats.contextMenusSuppressed, 0);
    assert.equal(r.keys.KeyW, false, "release-held fallback unchanged");
  } finally { r.restore(); }
});

test("[c] the document listener is bubble phase; the press reset is capture phase", () => {
  const r = rig();
  try {
    const ctxL = r.doc.listeners.filter((l) => l.type === "contextmenu");
    assert.equal(ctxL.length, 1);
    assert.equal(ctxL[0].capture, false, "bubble: element handlers (rynth-hud, hotbar…) run first");
    const down = r.doc.listeners.filter((l) => l.type === "mousedown");
    assert.equal(down.length, 1);
    assert.equal(down[0].capture, true, "capture: runs before camera.js marks the canvas press");
  } finally { r.restore(); }
});

// ── [d] ────────────────────────────────────────────────────────────────
test("[d] camera.js marks its right press on the canvas", () => {
  const cam = src("scene3d/camera.js");
  const i = cam.indexOf("const onMouseDown = (ev) => {");
  assert.ok(i >= 0, "follow-mode onMouseDown present");
  const body = cam.slice(i, i + 900);
  const guard = body.indexOf("if (ev.button !== 2) return;");
  const mark = body.indexOf("getInputFunnel().noteCanvasRightPress()");
  assert.ok(guard >= 0 && mark > guard, "marked after the right-button guard");
  assert.match(cam, /import \{[^}]*getInputFunnel[^}]*\} from "\.\.\/ui\/input-funnel\.js"/);
  assert.match(src("index.html"), /__inputFunnel\.install\(\)/, "index.html still installs the funnel");
});
