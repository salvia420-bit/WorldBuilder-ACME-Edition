// tests/popup_string_dialog.test.mjs — chat-errors-7 (2026-10-13).
//
// Retail ClientCommunicationSystem::Handle_Communication__PopUpString
// (acclient.c:425219) opens an OK message dialog and adds no chat line.
// holtburger's wasm still emits the kind=2 "[Popup] <text>" line at
// CHAT_CATEGORY_POPUP (plugins and rynth keep seeing it); app/client_events.js
// now hands that line to app/popup_string.js, which opens plugins/
// modal-dialog.js OK-only instead of appending it — except in agent / bot
// sessions and with `?popupDialog=off`.
//
// Also pins area MISSED-1: the kind=56 JUMP_REFUSED lines use the retail
// cant_jump_* strings (acclient.c:796298-796320) at the Transient category,
// so category 10 belongs to PopupString alone (`?retailFailureText=off`
// keeps the old lines).
//
// Run: node tests/popup_string_dialog.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installDialogFakeDom, tick } from "./helpers/dialog_fake_dom.mjs";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { document, press } = installDialogFakeDom();
globalThis.location = { search: "", href: "http://test/index.html", reload() {} };
globalThis.sessionStorage = { getItem: () => null, setItem() {} };

const {
  POPUP_CHAT_PREFIX, popupStringFromChat, popupDialogEnabled, popupDialogAgentSession,
  popupDialogActive, routePopupString,
} = await import("../app/popup_string.js");
const { jumpRefusalLine, RETAIL_JUMP_REFUSAL_TEXT } = await import("../app/jump_refusal_text.js");
const { CHAT_CATEGORY } = await import("../app/chat_log.js");
const { dispatchClientEvent } = await import("../app/client_events.js");
const { ClientEventKind } = await import("../scene3d/client_event_kinds.js");

const WELCOME = "Welcome to Asheron's Call!\nTo begin your training, speak to the Society Greeter.";
const POPUP_LINE = `[Popup] ${WELCOME}`;

function dialogOpen() {
  const d = document.getElementById("hb-modal-dialog");
  return !!d && d.getAttribute("data-open") === "1";
}
function dialogMessage() {
  const d = document.getElementById("hb-modal-dialog");
  return d.children.find((c) => c.className.split(/\s+/).includes("hb-dlg-msg")).textContent;
}

function makeEvt(kind, extra = {}) {
  const evt = { kind, u32Payload: 0, u32Payload2: 0, stringPayload: "", freed: 0, ...extra };
  evt.free = () => { evt.freed += 1; };
  return evt;
}
function makeDeps() {
  const lines = [];
  const state = { spawningCharId: null, spawnedPlayerGuid: null, enteredWorld: true, lastPredictionTime: 0 };
  const D = {
    lines,
    appendChatLine: (text, category) => { lines.push([text, category]); },
    handle: null,
    EVT_GUARD_ON: false, // a handler error fails the test instead of being counted
    CMD_INTERP_ON: false,
    CAST_MOVE_ON: false,
  };
  for (const k of Object.keys(state)) {
    Object.defineProperty(D, k, { get: () => state[k], set: (v) => { state[k] = v; }, enumerable: true });
  }
  return D;
}
function withSearch(search, fn) {
  const prev = location.search;
  location.search = search;
  try { return fn(); } finally { location.search = prev; }
}

// ── pure helpers ─────────────────────────────────────────────────────────

test("popupStringFromChat: only a category-10 line with the wasm prefix", () => {
  assert.equal(POPUP_CHAT_PREFIX, "[Popup] ");
  assert.equal(CHAT_CATEGORY.POPUP, 10);
  assert.equal(popupStringFromChat(POPUP_LINE, 10), WELCOME, "prefix stripped, line breaks kept");
  assert.equal(popupStringFromChat("[Popup] ", 10), "", "empty popup text");
  assert.equal(popupStringFromChat(POPUP_LINE, 9), null, "wrong category");
  assert.equal(popupStringFromChat(POPUP_LINE, 0), null);
  assert.equal(popupStringFromChat("You can't jump from this position", 10), null, "no prefix");
  assert.equal(popupStringFromChat(undefined, 10), null);
});

test("?popupDialog: default on, off / 0 / false keep the chat line", () => {
  assert.equal(popupDialogEnabled(""), true);
  assert.equal(popupDialogEnabled("?popupDialog=on"), true);
  for (const v of ["off", "0", "false", "OFF"]) assert.equal(popupDialogEnabled(`?popupDialog=${v}`), false, v);
});

test("agent / autoLogin / bot sessions fall back to the chat line unless ?popupDialog=on", () => {
  for (const q of ["?agent=1", "?autoLogin=1&account=a&password=b", "?bot=1"]) {
    assert.equal(popupDialogAgentSession(q), true, q);
    assert.equal(popupDialogActive(q), false, q);
    assert.equal(popupDialogActive(`${q}&popupDialog=on`), true, `${q} + on`);
    assert.equal(popupDialogActive(`${q}&popupDialog=off`), false, `${q} + off`);
  }
  assert.equal(popupDialogAgentSession("?agent=0"), false);
  assert.equal(popupDialogActive(""), true, "a human session opens the dialog");
});

test("routePopupString opens the OK-only dialog with the raw text", () => {
  const calls = [];
  const open = (o) => calls.push(o);
  assert.equal(routePopupString(POPUP_LINE, 10, { search: "", open }), true);
  assert.deepEqual(calls, [{ message: WELCOME, hideCancel: true, confirmLabel: "OK" }]);
  assert.equal(routePopupString("Hello", 0, { search: "", open }), false, "not a popup");
  assert.equal(routePopupString(POPUP_LINE, 10, { search: "?popupDialog=off", open }), false, "escape");
  assert.equal(routePopupString(POPUP_LINE, 10, { search: "?agent=1", open }), false, "agent");
  assert.equal(calls.length, 1, "declined lines never open a dialog");
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(routePopupString(POPUP_LINE, 10, { search: "", open: () => { throw new Error("no DOM"); } }), false,
      "a failed open keeps the chat line");
  } finally {
    console.warn = warn;
  }
});

// ── client_events.js routing (real dispatcher + real modal-dialog) ───────

test("kind=2 PopupString opens the dialog and appends no chat line; the chat hook still fires", async () => {
  const D = makeDeps();
  const hooked = [];
  const tapped = [];
  window.__chatHooks = { incoming: { emit: (name, ev) => { hooked.push([name, ev]); return { eaten: false }; } } };
  window.__rynthOnEvent = (evt) => tapped.push([evt.kind, evt.stringPayload, evt.u32Payload, evt.u32Payload2]);
  try {
    const evt = makeEvt(ClientEventKind.CHAT_RECEIVED, { stringPayload: POPUP_LINE, u32Payload: 0, u32Payload2: 10 });
    dispatchClientEvent(evt, D);
    assert.deepEqual(D.lines, [], "no chat line");
    assert.equal(dialogOpen(), true, "dialog open");
    assert.equal(dialogMessage(), WELCOME, "raw text, no [Popup] prefix");
    assert.equal(evt.freed, 1);
    assert.deepEqual(hooked, [["chatIncoming", { text: POPUP_LINE, chatType: 0, category: 10 }]],
      "plugins still see the line through the chat hook");
    assert.deepEqual(tapped, [[ClientEventKind.CHAT_RECEIVED, POPUP_LINE, 0, 10]], "rynth tap unchanged");
    press("Enter");
    assert.equal(dialogOpen(), false, "Enter closes it");
    await tick();
  } finally {
    delete window.__chatHooks;
    delete window.__rynthOnEvent;
  }
});

test("successive PopupStrings queue in the dialog", async () => {
  const D = makeDeps();
  dispatchClientEvent(makeEvt(ClientEventKind.CHAT_RECEIVED, { stringPayload: "[Popup] one", u32Payload2: 10 }), D);
  dispatchClientEvent(makeEvt(ClientEventKind.CHAT_RECEIVED, { stringPayload: "[Popup] two", u32Payload2: 10 }), D);
  assert.deepEqual(D.lines, []);
  assert.equal(dialogMessage(), "one");
  press("Escape");
  await tick();
  assert.equal(dialogOpen(), true);
  assert.equal(dialogMessage(), "two");
  press("Enter");
  await tick();
  assert.equal(dialogOpen(), false);
});

test("a PopupString eaten by a chat hook shows nowhere", () => {
  const D = makeDeps();
  window.__chatHooks = { incoming: { emit: () => ({ eaten: true }) } };
  try {
    dispatchClientEvent(makeEvt(ClientEventKind.CHAT_RECEIVED, { stringPayload: POPUP_LINE, u32Payload2: 10 }), D);
  } finally {
    delete window.__chatHooks;
  }
  assert.deepEqual(D.lines, []);
  assert.equal(dialogOpen(), false);
});

test("agent sessions and ?popupDialog=off keep today's chat line", () => {
  for (const q of ["?agent=1", "?autoLogin=1", "?popupDialog=off"]) {
    const D = makeDeps();
    withSearch(q, () => dispatchClientEvent(
      makeEvt(ClientEventKind.CHAT_RECEIVED, { stringPayload: POPUP_LINE, u32Payload2: 10 }), D));
    assert.deepEqual(D.lines, [[POPUP_LINE, 10]], q);
    assert.equal(dialogOpen(), false, q);
  }
});

test("ordinary chat lines still append", () => {
  const D = makeDeps();
  dispatchClientEvent(makeEvt(ClientEventKind.CHAT_RECEIVED, { stringPayload: "Bob says, \"hi\"", u32Payload: 2, u32Payload2: 1 }), D);
  dispatchClientEvent(makeEvt(ClientEventKind.CHAT_RECEIVED, { stringPayload: "[Popup] text", u32Payload2: 0 }), D);
  assert.deepEqual(D.lines, [["Bob says, \"hi\"", 1], ["[Popup] text", 0]]);
  assert.equal(dialogOpen(), false);
});

// ── kind=56 JUMP_REFUSED (area MISSED-1) ─────────────────────────────────

test("jump refusals print the retail strings at Transient; other codes print nothing", () => {
  assert.deepEqual(RETAIL_JUMP_REFUSAL_TEXT, {
    72: "You can't jump from this position",
    36: "You can't jump while in the air",
    73: "You're too loaded down to jump",
  });
  const D = makeDeps();
  for (const code of [72, 36, 73, 71, 0]) {
    dispatchClientEvent(makeEvt(ClientEventKind.JUMP_REFUSED, { u32Payload: code }), D);
  }
  assert.deepEqual(D.lines, [
    ["You can't jump from this position", CHAT_CATEGORY.TRANSIENT],
    ["You can't jump while in the air", CHAT_CATEGORY.TRANSIENT],
    ["You're too loaded down to jump", CHAT_CATEGORY.TRANSIENT],
  ], "retail DoJump: `default: return` for 71 and the rest");
  assert.equal(dialogOpen(), false, "a jump refusal never opens the popup dialog");
});

test("?retailFailureText=off restores the old jump lines (category 10, still no dialog)", () => {
  assert.deepEqual(jumpRefusalLine(73, "?retailFailureText=off"), { text: "You are too encumbered to jump!", category: 10 });
  assert.deepEqual(jumpRefusalLine(71, "?retailFailureText=off"), { text: "You can't jump right now.", category: 10 });
  assert.equal(jumpRefusalLine(71, ""), null);
  const D = makeDeps();
  withSearch("?retailFailureText=off", () => dispatchClientEvent(makeEvt(ClientEventKind.JUMP_REFUSED, { u32Payload: 72 }), D));
  assert.deepEqual(D.lines, [["You can't jump from this position!", 10]]);
  assert.equal(dialogOpen(), false, "the category-10 jump line goes straight to the log");
});

// ── the wasm side of the contract (source) ───────────────────────────────

function rustFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...rustFiles(p));
    else if (name.endsWith(".rs")) out.push(p);
  }
  return out;
}

test("the wasm PopupString arm is the only CHAT_CATEGORY_POPUP producer and keeps the prefix", () => {
  const uses = [];
  for (const f of rustFiles(path.join(APP, "src"))) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      if (/\bCHAT_CATEGORY_POPUP\b/.test(code) && !/const CHAT_CATEGORY_POPUP\b/.test(code)) {
        uses.push(`${path.relative(APP, f)}:${i + 1}`);
      }
    });
  }
  assert.equal(uses.length, 1, `CHAT_CATEGORY_POPUP uses: ${uses.join(", ")}`);
  const src = readFileSync(path.join(APP, "src/session/messages/game_event.rs"), "utf8");
  const arm = src.slice(src.indexOf("GameEvent::PopupString(data) =>"));
  const body = arm.slice(0, arm.indexOf("GameEvent::", 30));
  assert.match(body, /format!\("\[Popup\] \{\}", data\.message\)/, "the [Popup] prefix popup_string.js strips");
  assert.match(body, /u32_payload_2: Some\(CHAT_CATEGORY_POPUP\)/);
  assert.match(body, /kind: CLIENT_EVENT_KIND_CHAT_RECEIVED/, "the kind=2 event is still emitted");
  assert.match(readFileSync(path.join(APP, "src/lib.rs"), "utf8"), /const CHAT_CATEGORY_POPUP: u32 = 10;/);
});
