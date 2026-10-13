// tests/portal_storm_notices.test.mjs — hud-ui-7 (2026-10-13).
//
// Retail ClientUISystem shows every portal-storm state as text (acclient.c):
// Brewing (:402286), Imminent (:402317) and Subsided (:402264) go out through
// ECM_UI::SendNotice_DisplayStringInfo(0x1A) — the spew box, holtburger's
// transient chat category 9 — and the storm itself (Handle_Misc__PortalStorm
// :402348) adds a text type 0 chat line via ClientSystem::AddTextToScroll.
// holtburger only fired the status-indicators screen pulse (level >= 2) off
// `portalStormChanged`, so no state ever produced text. app/client_events.js
// now hands the kind=45 state to app/portal_storm_notice.js; the bus event is
// unchanged.
//
// Run: node tests/portal_storm_notices.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";

// Browser-ish globals (same minimal set as tests/house_query_login.test.mjs).
globalThis.window = globalThis;
globalThis.location = { search: "", href: "http://test/index.html", reload() {} };
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
globalThis.requestIdleCallback = () => {};
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, setAttribute() {}, textContent: "" }),
  body: { appendChild() {} },
};

const { PORTAL_STORM_TEXT, portalStormNotice, showPortalStormNotice } = await import("../app/portal_storm_notice.js");
const { CHAT_CATEGORY } = await import("../app/chat_log.js");
const { dispatchClientEvent } = await import("../app/client_events.js");
const { ClientEventKind } = await import("../scene3d/client_event_kinds.js");

// Verbatim from acclient.c (Handle_Misc__PortalStorm drops its trailing "\n").
const BREWING = "This area is getting too crowded - a Portal Storm is brewing.";
const IMMINENT = "A Portal Storm is imminent - leave this crowded area!";
const SUBSIDED = "The Portal Storm has subsided";
const STORM = "The Portal Storm has teleported you away from the crowded area!";

/** Stub window.__appendChatLine + plugin bus; returns the recorders. */
function installSinks() {
  const lines = [];
  const bus = [];
  window.__appendChatLine = (text, category) => { lines.push([text, category]); };
  window.__pluginClient = { events: { emit: (name, detail) => { bus.push([name, detail]); } } };
  return { lines, bus };
}
function clearSinks() {
  delete window.__appendChatLine;
  delete window.__pluginClient;
}

function makeDeps() {
  const state = { spawningCharId: null, spawnedPlayerGuid: null, enteredWorld: true, lastPredictionTime: 0 };
  const D = {
    appendChatLine: (text, category) => window.__appendChatLine?.(text, category),
    handle: null,
    // A handler error fails the test instead of being swallowed by evtGuard.
    EVT_GUARD_ON: false, CMD_INTERP_ON: false, CAST_MOVE_ON: false,
  };
  for (const k of Object.keys(state)) {
    Object.defineProperty(D, k, { get: () => state[k], set: (v) => { state[k] = v; }, enumerable: true });
  }
  return D;
}

/** A kind=45 ClientEvent as src/session/messages/game_event.rs builds it. */
function stormEvt(state, level, extent = 0) {
  const e = { kind: ClientEventKind.PORTAL_STORM, stringPayload: state, u32Payload: level, u32Payload2: undefined, f32Payload: extent, freed: 0 };
  e.free = () => { e.freed += 1; };
  return e;
}

// ── pure map ─────────────────────────────────────────────────────────────

test("portalStormNotice: retail strings, transient for brewing / imminent / subsided", () => {
  assert.deepEqual(portalStormNotice("brewing"), { text: BREWING, sink: "transient" });
  assert.deepEqual(portalStormNotice("imminent"), { text: IMMINENT, sink: "transient" });
  assert.deepEqual(portalStormNotice("subsided"), { text: SUBSIDED, sink: "transient" });
  assert.equal(PORTAL_STORM_TEXT.brewing, BREWING);
  assert.equal(PORTAL_STORM_TEXT.imminent, IMMINENT);
  assert.equal(PORTAL_STORM_TEXT.subsided, SUBSIDED);
  assert.ok(Object.isFrozen(PORTAL_STORM_TEXT));
});

test("portalStormNotice: the storm is a category-0 chat line, no trailing newline", () => {
  assert.equal(CHAT_CATEGORY.SYSTEM, 0);
  assert.deepEqual(portalStormNotice("storm"), { text: STORM, sink: "chat", category: 0 });
  assert.equal(PORTAL_STORM_TEXT.storm.endsWith("\n"), false);
});

test("portalStormNotice: unknown / missing states have no notice", () => {
  for (const s of [undefined, null, "", "Brewing", "STORM", "level", "toString", "__proto__", 2]) {
    assert.equal(portalStormNotice(s), null, String(s));
  }
});

// ── sinks ────────────────────────────────────────────────────────────────

test("showPortalStormNotice: transient states → category 9 line + clientActionRejected toast", () => {
  const { lines, bus } = installSinks();
  try {
    for (const [state, text] of [["brewing", BREWING], ["imminent", IMMINENT], ["subsided", SUBSIDED]]) {
      lines.length = 0;
      bus.length = 0;
      const n = showPortalStormNotice(state);
      assert.deepEqual(n, { text, sink: "transient" });
      assert.deepEqual(lines, [[text, CHAT_CATEGORY.TRANSIENT]], state);
      assert.equal(CHAT_CATEGORY.TRANSIENT, 9);
      assert.deepEqual(bus, [["clientActionRejected", { message: text }]], state);
    }
  } finally {
    clearSinks();
  }
});

test("showPortalStormNotice: storm → one category 0 chat line, no toast", () => {
  const { lines, bus } = installSinks();
  try {
    assert.deepEqual(showPortalStormNotice("storm"), { text: STORM, sink: "chat", category: 0 });
    assert.deepEqual(lines, [[STORM, 0]]);
    assert.deepEqual(bus, []);
  } finally {
    clearSinks();
  }
});

test("showPortalStormNotice: unknown state prints nothing; missing sinks never throw", () => {
  const { lines, bus } = installSinks();
  try {
    assert.equal(showPortalStormNotice("bogus"), null);
    assert.equal(showPortalStormNotice(undefined), null);
    assert.deepEqual(lines, []);
    assert.deepEqual(bus, []);
  } finally {
    clearSinks();
  }
  // No chat appender and no plugin bus (early boot / headless).
  assert.deepEqual(showPortalStormNotice("brewing"), { text: BREWING, sink: "transient" });
  assert.deepEqual(showPortalStormNotice("storm"), { text: STORM, sink: "chat", category: 0 });
  // Throwing sinks are swallowed.
  window.__appendChatLine = () => { throw new Error("no DOM"); };
  window.__pluginClient = { events: { emit: () => { throw new Error("bus down"); } } };
  try {
    assert.doesNotThrow(() => showPortalStormNotice("imminent"));
    assert.doesNotThrow(() => showPortalStormNotice("storm"));
  } finally {
    clearSinks();
  }
});

// ── client_events.js routing (real dispatcher) ───────────────────────────

test("kind=45 PORTAL_STORM: text per state, portalStormChanged payload unchanged", () => {
  const { lines, bus } = installSinks();
  try {
    const D = makeDeps();
    const cases = [
      ["brewing", 1, 0.4, [[BREWING, 9]], true],
      ["imminent", 2, 0.6, [[IMMINENT, 9]], true],
      ["storm", 3, 0, [[STORM, 0]], false],
      ["subsided", 0, 0, [[SUBSIDED, 9]], true],
    ];
    for (const [state, level, extent, wantLines, toast] of cases) {
      lines.length = 0;
      bus.length = 0;
      const evt = stormEvt(state, level, extent);
      dispatchClientEvent(evt, D);
      assert.deepEqual(lines, wantLines, state);
      const changed = bus.filter(([n]) => n === "portalStormChanged");
      assert.equal(changed.length, 1, `${state}: one portalStormChanged`);
      assert.equal(changed[0][1].state, state);
      assert.equal(changed[0][1].level, level);
      assert.ok(Math.abs(changed[0][1].extent - extent) < 1e-6, `${state}: extent`);
      assert.equal(bus[0][0], "portalStormChanged", `${state}: bus event first (pulse unchanged)`);
      const rejected = bus.filter(([n]) => n === "clientActionRejected");
      assert.deepEqual(rejected, toast ? [["clientActionRejected", { message: wantLines[0][0] }]] : [], state);
      assert.equal(evt.freed, 1, `${state}: event freed`);
    }
  } finally {
    clearSinks();
  }
});

test("kind=45 with no state: the bus still gets subsided, no text is shown", () => {
  const { lines, bus } = installSinks();
  try {
    const evt = stormEvt(undefined, 0, 0);
    dispatchClientEvent(evt, makeDeps());
    assert.deepEqual(lines, []);
    assert.deepEqual(bus.map(([n, d]) => [n, d.state]), [["portalStormChanged", "subsided"]]);
  } finally {
    clearSinks();
  }
});
