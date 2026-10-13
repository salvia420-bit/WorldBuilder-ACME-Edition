// tests/ui_lock_global.test.mjs — input-options-4 (2026-10-13): retail's ONE
// global LockUI (ui/ui_lock.js) and the windows that obey it.
//
//   * PlayerModule::LockUI = BYTE3(options2_) & 1 (acclient.c:511690): a
//     PlayerDescription options2 word with 0x01000000 seeds global = true.
//   * PlayerModule::SetLockUI (:511696) fires OnChanged(51) only on a change:
//     setGlobalLock → SetSingleCharacterOption(0x33, v) exactly once.
//   * gmFloaty*UI::UpdateLockedStatus / gmRadarUI::UpdateLockedStatus: a
//     window with `obeysGlobalLock: true` is locked by it (no drag, resizers
//     hidden); the RynthSuite windows (no obeysGlobalLock) follow their own
//     per-window lock only — byte-identical to before.
//   * ClientCommunicationSystem::DoLockUI (:412522): `/lockui` and `@lockui`
//     toggle it locally; an argument prints the usage line.
//   * `?globalLockUI=off` restores the per-window-only behaviour.
//
// Run from apps/holtburger-web/:  node tests/ui_lock_global.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel) => readFileSync(path.join(APP, rel), "utf8");

// ── Minimal browser globals (window === globalThis, as in the page) ──────
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
globalThis.location = { search: "", href: "http://localhost/apps/holtburger-web/index.html" };
globalThis.CustomEvent ??= class { constructor(t, o) { this.type = t; this.detail = o?.detail; } };

function makeNode(tag = "div") {
  const listeners = new Map();
  const classes = new Set();
  return {
    tagName: tag.toUpperCase(),
    style: { cssText: "" },
    dataset: {},
    isConnected: true,
    classList: {
      add: (c) => { classes.add(c); },
      remove: (c) => { classes.delete(c); },
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    },
    children: [],
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const a = listeners.get(type);
      if (a) listeners.set(type, a.filter((f) => f !== fn));
    },
    fire(type, ev = {}) { for (const fn of [...(listeners.get(type) ?? [])]) fn(ev); },
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 120, height: 140, right: 220, bottom: 240 }),
    setPointerCapture() {},
    releasePointerCapture() {},
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
  };
}

const domEvents = [];
globalThis.document = {
  createElement: (tag) => makeNode(tag),
  dispatchEvent(ev) { domEvents.push({ type: ev.type, detail: ev.detail }); return true; },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.getComputedStyle = () => ({ position: "absolute" });
globalThis.window = globalThis;

// Recording SessionHandle: setCharacterOption applies the bit like the wasm
// SetCharacterOption arm's optimistic update.
const LOCK_UI_BIT = 0x01000000;
let options2 = 0x00948700; // retail PlayerModule::PlayerModule default (LockUI off)
const sent = [];
globalThis.__sessionHandle = {
  setCharacterOption(i, v) {
    sent.push([i >>> 0, !!v]);
    if ((i >>> 0) === 0x33) options2 = (v ? (options2 | LOCK_UI_BIT) : (options2 & ~LOCK_UI_BIT)) >>> 0;
  },
  isCharacterOptionEnabled(i) {
    return (i >>> 0) === 0x33 ? ((options2 >>> 24) & 1) === 1 : false;
  },
};

const L = await import("../ui/ui_lock.js");
const WP = await import("../ui/ac_window_position.js");
const { attachCornerResizers } = await import("../ui/ac_resize_corners.js");
const SC = await import("../app/slash_commands.js");

const RYNTH_HUD_WINDOW_ID = 0xFFFF0140; // plugins/rynth-hud.js
const VT_PANEL_WINDOW_ID = 0xFFFF0141;  // plugins/rynth-vt/panel.js
const keyOf = (id) => `hb.window.${(id >>> 0).toString(16)}`;

function reset() {
  L.__resetGlobalLockForTest();
  options2 = 0x00948700;
  sent.length = 0;
  domEvents.length = 0;
  store.clear();
  globalThis.location.search = "";
}

function pointerDown(target) {
  return { button: 0, clientX: 110, clientY: 110, pointerId: 1, target, preventDefault() {} };
}

test("PlayerDescription options2 with 0x01000000 seeds the global lock", () => {
  reset();
  const seen = [];
  const off = L.onGlobalLockChange((locked, source) => seen.push([locked, source]));
  assert.equal(L.lockUiFromOptions2(0x00948700), false, "retail default: unlocked");
  assert.equal(L.lockUiFromOptions2(0x01000000), true);
  assert.equal(L.lockUiFromOptions2(0xFEFFFFFF), false, "only BYTE3 bit 0");
  assert.equal(L.OPTIONS2_LOCK_UI, LOCK_UI_BIT);
  assert.equal(L.CHARACTER_OPTION_LOCK_UI, 0x33);

  assert.equal(L.seedGlobalLockFromOptions2(0x00948700 | LOCK_UI_BIT), true);
  assert.equal(L.isGlobalLocked(), true);
  assert.deepEqual(seen, [[true, "server"]]);
  assert.ok(domEvents.some((e) => e.type === L.GLOBAL_LOCK_EVENT && e.detail?.locked === true),
    "hb-ui-global-lock-changed dispatched");
  assert.ok(!domEvents.some((e) => e.type === "hb-ui-lock-changed"),
    "the per-window bus (windowId-filtered) is not used for the broadcast");
  assert.deepEqual(sent, [], "a server seed is not sent back");
  off();
});

test("isWindowLocked: an obeying retail floaty vs a RynthSuite window", () => {
  reset();
  L.seedGlobalLockFromOptions2(LOCK_UI_BIT);
  assert.equal(L.isWindowLocked(WP.WINDOW_ID.RADAR, { obeysGlobalLock: true }), true);

  store.set(keyOf(RYNTH_HUD_WINDOW_ID), JSON.stringify({ x: 1, y: 2, locked: false }));
  assert.equal(L.isWindowLocked(RYNTH_HUD_WINDOW_ID, { obeysGlobalLock: false }), false,
    "rynth HUD ignores the global lock");
  assert.equal(L.isWindowLocked(VT_PANEL_WINDOW_ID), false, "no saved state, no global → unlocked");
  store.set(keyOf(RYNTH_HUD_WINDOW_ID), JSON.stringify({ x: 1, y: 2, locked: true }));
  assert.equal(L.isWindowLocked(RYNTH_HUD_WINDOW_ID, { obeysGlobalLock: false }), true,
    "rynth HUD follows its own per-window lock");

  L.applyServerLockState(false);
  assert.equal(L.isWindowLocked(WP.WINDOW_ID.RADAR, { obeysGlobalLock: true }), false);
  assert.equal(L.isWindowLocked(WP.WINDOW_ID.RADAR, { obeysGlobalLock: true, perWindowLocked: true }), true,
    "per-window lock still applies as an extra");
  assert.equal(L.isWindowLocked(RYNTH_HUD_WINDOW_ID, {}), true);
});

test("setGlobalLock sends SetSingleCharacterOption(0x33) once per change (PlayerModule::SetLockUI)", () => {
  reset();
  assert.equal(L.setGlobalLock(true), true);
  assert.equal(L.setGlobalLock(true), true);
  assert.deepEqual(sent, [[0x33, true]], "no change, no OnChanged(51)");
  assert.equal(L.toggleGlobalLock(), false);
  assert.deepEqual(sent, [[0x33, true], [0x33, false]]);
  assert.equal(L.setGlobalLock(true, { send: false }), true);
  assert.equal(sent.length, 2, "send:false (the Options row already sent it) adds none");
  assert.equal(typeof globalThis.__uiLock?.toggle, "function", "window.__uiLock seam for /lockui");
});

test("a stale stats read does not undo a local toggle; the server wins after 2 s", () => {
  reset();
  L.setGlobalLock(true, { nowMs: 1000 });
  assert.equal(L.applyServerLockState(false, 1500), true, "pre-optimistic snapshot ignored");
  assert.equal(L.applyServerLockState(false, 3001), false, "server authoritative after the window");
  L.setGlobalLock(true, { nowMs: 5000 });
  assert.equal(L.applyServerLockState(true, 5001), true, "an agreeing read clears the pending toggle");
  assert.equal(L.applyServerLockState(false, 5002), false, "then the server is authoritative again");
});

test("an obeying window follows the global lock; a RynthSuite-style window does not", () => {
  reset();
  const radarEl = makeNode();
  const radarCalls = [];
  const radar = WP.attachWindowPosition(radarEl, {
    windowId: WP.WINDOW_ID.RADAR, dragHandle: radarEl, obeysGlobalLock: true,
    onLockChange: (l) => radarCalls.push(l),
  });
  const rynthEl = makeNode();
  const rynthBtn = makeNode();
  const rynthCalls = [];
  const rynth = WP.attachWindowPosition(rynthEl, {
    windowId: RYNTH_HUD_WINDOW_ID, dragHandle: rynthEl, lockButton: rynthBtn,
    onLockChange: (l) => rynthCalls.push(l),
  });
  assert.equal(radar.isLocked(), false);

  L.setGlobalLock(true);
  assert.deepEqual(radarCalls, [true], "BroadcastGlobalMessage(0xD) → UpdateLockedStatus");
  assert.equal(radar.isLocked(), true);
  assert.equal(radar.getState().locked, false, "per-window flag untouched");
  assert.deepEqual(rynthCalls, [], "rynth window not notified");
  assert.equal(rynth.isLocked(), false);

  radarEl.fire("pointerdown", pointerDown(radarEl));
  assert.equal(radarEl.classList.contains("hb-window-dragging"), false, "locked floaty does not drag");
  rynthEl.fire("pointerdown", pointerDown(rynthEl));
  assert.equal(rynthEl.classList.contains("hb-window-dragging"), true, "rynth window still drags");
  rynthEl.fire("pointercancel", {});

  rynthBtn.fire("click", {});
  assert.deepEqual(rynthCalls, [true], "rynth lock button toggles its own lock");
  assert.equal(L.isGlobalLocked(), true, "…and never the global one");
  assert.equal(JSON.parse(store.get(keyOf(RYNTH_HUD_WINDOW_ID))).locked, true);
  rynthBtn.fire("click", {});
  assert.deepEqual(rynthCalls, [true, false]);

  L.setGlobalLock(false);
  assert.deepEqual(radarCalls, [true, false]);
  assert.equal(radar.isLocked(), false);
  assert.deepEqual(rynthCalls, [true, false], "rynth window still untouched");
});

test("a window attached while the global lock is set mounts locked", () => {
  reset();
  // The session is the truth: attaching an obeying window re-reads it.
  options2 = (options2 | LOCK_UI_BIT) >>> 0;
  assert.equal(L.syncGlobalLockFromSession(), true);
  const el = makeNode();
  const calls = [];
  const ctl = WP.attachWindowPosition(el, {
    windowId: WP.WINDOW_ID.HOTBAR, dragHandle: el, obeysGlobalLock: true, onLockChange: (l) => calls.push(l),
  });
  assert.deepEqual(calls, [true]);
  assert.equal(ctl.isLocked(), true);
  // A per-window toggle while globally locked keeps the window locked.
  ctl.setLocked(true);
  ctl.setLocked(false);
  assert.equal(ctl.isLocked(), true, "global lock still holds it");
  const plain = makeNode();
  const plainCalls = [];
  WP.attachWindowPosition(plain, { windowId: VT_PANEL_WINDOW_ID, dragHandle: plain, onLockChange: (l) => plainCalls.push(l) });
  assert.deepEqual(plainCalls, [], "non-obeying window mounts unlocked");
});

test("chat-style resizers hide while the global lock is set (obeysGlobalLock only)", () => {
  reset();
  const host = makeNode();
  const corners = attachCornerResizers(host, { windowId: WP.WINDOW_ID.CHAT, obeysGlobalLock: true });
  const edgesHost = makeNode();
  const edges = WP.attachEdgeResizers(edgesHost, { edges: ["top"], windowId: WP.WINDOW_ID.CHAT, obeysGlobalLock: true });
  const plain = attachCornerResizers(makeNode(), { windowId: RYNTH_HUD_WINDOW_ID });

  L.setGlobalLock(true);
  assert.equal(corners.isLocked(), true);
  assert.equal(corners.getCorners().tl.style.visibility, "hidden");
  assert.equal(edges.isLocked(), true);
  assert.equal(edges.getHandles().top.style.pointerEvents, "none");
  assert.equal(plain.isLocked(), false, "non-obeying resizer unaffected");

  corners.setLocked(false);
  assert.equal(corners.isLocked(), true, "per-window unlock cannot override the global lock");
  L.setGlobalLock(false);
  assert.equal(corners.isLocked(), false);
  assert.equal(corners.getCorners().tl.style.visibility, "");
  assert.equal(edges.isLocked(), false);

  corners.dispose();
  edges.dispose();
  plain.dispose();
  L.setGlobalLock(true);
  assert.equal(corners.isLocked(), false, "disposed resizer no longer listens");
});

test("an obeying window never subscribes on a plugin's own client handle", () => {
  reset();
  let subs = 0;
  globalThis.__pluginClient = { events: { on: () => { subs += 1; }, off() {} } };
  try {
    const el = makeNode();
    WP.attachWindowPosition(el, { windowId: WP.WINDOW_ID.HOTBAR, dragHandle: el, obeysGlobalLock: true });
    assert.equal(subs, 0, "plugin teardown bookkeeping (test_toolbar_mount_smoke) sees no extra handler");
  } finally {
    delete globalThis.__pluginClient;
  }
});

test("playerStatsUpdated re-reads 0x33 via __pluginClientReady (login seed)", async () => {
  reset();
  const handlers = new Map();
  const client = { events: { on: (n, fn) => handlers.set(n, fn), off() {} } };
  globalThis.__pluginClientReady = Promise.resolve(client);
  try {
    assert.equal(L.ensureGlobalLockSync(), true);
    await globalThis.__pluginClientReady;
    await null;
    assert.equal(typeof handlers.get("playerStatsUpdated"), "function");
    options2 = (options2 | LOCK_UI_BIT) >>> 0;
    handlers.get("playerStatsUpdated")();
    assert.equal(L.isGlobalLocked(), true, "a character saved locked logs in locked");
    options2 = (options2 & ~LOCK_UI_BIT) >>> 0;
    handlers.get("playerStatsUpdated")();
    assert.equal(L.isGlobalLocked(), false);
    assert.deepEqual(sent, [], "reads never send");
    assert.equal(L.ensureGlobalLockSync(), true, "idempotent");
  } finally {
    delete globalThis.__pluginClientReady;
  }
});

test("/lockui and @lockui toggle the global lock locally (DoLockUI); an argument prints the usage", () => {
  reset();
  const { routeSlashCommand } = SC.initSlashCommands();
  const calls = [];
  const h = { sendChat: (line) => calls.push(["sendChat", line]) };
  const appended = [];
  globalThis.__appendChatLine = (t, c) => appended.push([t, c]);
  try {
    let r = routeSlashCommand(h, "/lockui");
    assert.equal(r.dispatched, true);
    assert.equal(r.echo, null, "retail prints nothing on success");
    assert.equal(L.isGlobalLocked(), true);
    assert.deepEqual(sent, [[0x33, true]]);

    assert.deepEqual(SC.normalizeChatLine("@lockui"), { kind: "command", line: "/lockui" });
    assert.ok(SC.RETAIL_CLIENT_VERBS.has("lockui"));
    r = routeSlashCommand(h, "@LockUI");
    assert.equal(r.dispatched, true);
    assert.equal(L.isGlobalLocked(), false);

    r = routeSlashCommand(h, "/lockui now");
    assert.deepEqual(r.lines, [SC.LOCKUI_USAGE_TEXT]);
    assert.equal(SC.LOCKUI_USAGE_TEXT, "Please use @help lockui for proper usage.");
    assert.equal(L.isGlobalLocked(), false, "an argument does not toggle");
    assert.equal(appended.length, 1);
    assert.deepEqual(calls, [], "never sent to ACE");
  } finally {
    delete globalThis.__appendChatLine;
  }
});

test("?globalLockUI=off: nothing obeys, nothing is sent, /lockui keeps the server forward", () => {
  reset();
  L.setGlobalLock(true);
  sent.length = 0;
  globalThis.location.search = "?globalLockUI=off";
  try {
    assert.equal(L.globalLockUIEnabled(), false);
    assert.equal(L.globalLockUIEnabled("?globalLockUI=0"), false);
    assert.equal(L.globalLockUIEnabled("?globalLockUI=on"), true);
    assert.equal(L.isWindowLocked(WP.WINDOW_ID.RADAR, { obeysGlobalLock: true, perWindowLocked: false }), false);
    const el = makeNode();
    const calls = [];
    const ctl = WP.attachWindowPosition(el, {
      windowId: WP.WINDOW_ID.STATUS_INDICATORS, dragHandle: el, obeysGlobalLock: true, onLockChange: (l) => calls.push(l),
    });
    assert.equal(ctl.isLocked(), false, "obeysGlobalLock is inert with the flag off");
    assert.deepEqual(calls, []);
    assert.equal(L.toggleGlobalLock(), true, "setGlobalLock is a no-op");
    assert.deepEqual(sent, []);

    const { routeSlashCommand } = SC.initSlashCommands();
    const h = { calls: [], sendChat(line) { this.calls.push(line); } };
    assert.equal(SC.normalizeChatLine("@lockui").kind, "server");
    routeSlashCommand(h, "/lockui");
    assert.deepEqual(h.calls, ["@lockui"], "old forward to the server");
  } finally {
    globalThis.location.search = "";
  }
});

test("RynthSuite windows never pass obeysGlobalLock; the retail floaties do", () => {
  for (const rel of ["plugins/rynth-hud.js", "plugins/rynth-vt/panel.js"]) {
    assert.doesNotMatch(src(rel), /obeysGlobalLock/, `${rel} keeps its per-window lock only`);
  }
  assert.match(src("plugins/rynth-hud.js"), /RYNTH_HUD_WINDOW_ID = 0xFFFF0140/);
  assert.match(src("plugins/rynth-vt/panel.js"), /VT_PANEL_WINDOW_ID = 0xFFFF0141/);
  for (const rel of [
    "plugins/radar.js", "plugins/hotbar.js", "plugins/status-indicators.js", "plugins/chat-panel.js",
    "plugins/examine-floaty.js", "plugins/combat-hud.js", "plugins/combat-bar.js",
  ]) {
    assert.match(src(rel), /obeysGlobalLock: true/, `${rel} obeys the global LockUI`);
  }
  assert.match(src("plugins/vitals-hud.js"),
    /attachDefaultTopDragHandle\(overlay, WINDOW_ID\.VITALS, \{ obeysGlobalLock: true \}\)/);
  assert.match(src("plugins/main-panel.js"), /obeysGlobalLock: windowId === WINDOW_ID\.MAIN_PANEL/);
  // gmRadarUI::ListenToElementMessage: the radar lock button IS the global lock.
  const radar = src("plugins/radar.js");
  assert.match(radar, /lockButton: globalLock \? undefined : lockBtn/);
  assert.match(radar, /lockBtn\.addEventListener\("click", onGlobalLockClick\)/);
  assert.match(radar, /lockBtn\.removeEventListener\("click", onGlobalLockClick\)/);
  // ac_window_position defaults obeysGlobalLock to false.
  assert.match(src("ui/ac_window_position.js"), /obeysGlobalLock = false,/);
});
