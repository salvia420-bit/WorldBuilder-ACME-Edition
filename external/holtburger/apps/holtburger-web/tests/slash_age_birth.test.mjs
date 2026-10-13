// tests/slash_age_birth.test.mjs — chat-errors-8 (2026-10-13): retail's
// client-side /age and /birth (InitializeCommands, acclient.c:429604 /
// :429630). DoAge (:422037) sends CM_Character::Event_QueryAge (0x01C2) and
// DoBirth (:410915) Event_QueryBirth (0x01C4), target 0 for a player. ACE has
// no `@age` / `@birth` text command, so before this fix both verbs reached
// ACE as chat and drew "Unknown command". Pins, through the REAL
// initSlashCommands() router and dispatchClientEvent() with fakes:
//
//   [1] `/age` `@age` `/birth` `@birth` (any case, trailing `,`, arguments
//       ignored like retail) call handle.queryAge / queryBirth and are never
//       sent as a chat line;
//   [2] a pkg without the bindings keeps the old server forward;
//   [3] `?retailStatusCmds=off` restores the server forward (and `@age`
//       goes to the server verbatim again);
//   [4] the UI_EVENT "age|…" no longer prints the old `? 1d 2h` line (the
//       wasm prints retail's "You have played for …." as a kind=2 line); with
//       `?retailStatusCmds=off` the old line comes back. The plugin bus
//       still gets `uiEvent` either way.
//
// The Rust half (pack bytes, the retail age sentence) is pinned by
// holtburger-protocol misc::actions tests and chat_format query_age_tests.
//
// Run from apps/holtburger-web/:  node tests/slash_age_birth.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

// Minimal browser globals (app/client_events.js touches only these here).
globalThis.window = globalThis;
globalThis.location = { search: "", href: "http://test/index.html", reload() {} };
globalThis.sessionStorage ??= { getItem: () => null, setItem() {} };
globalThis.document ??= {
  getElementById: () => null,
  createElement: () => ({ style: {} }),
  body: { appendChild() {} },
};

const {
  initSlashCommands, normalizeChatLine, RETAIL_CLIENT_VERBS, STATUS_CLIENT_VERBS,
  retailStatusCmdsEnabled, statusCommandSend,
} = await import("../app/slash_commands.js");
const { dispatchClientEvent } = await import("../app/client_events.js");
const { ClientEventKind } = await import("../scene3d/client_event_kinds.js");

const { routeSlashCommand } = initSlashCommands();

function fakeHandle({ bindings = true } = {}) {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  const h = {
    calls,
    sendChat: rec("sendChat"),
    sendTell: rec("sendTell"),
    sendEmote: rec("sendEmote"),
    sendSoulEmote: rec("sendSoulEmote"),
    resolveSoulEmote: () => null,
  };
  if (bindings) {
    h.queryAge = rec("queryAge");
    h.queryBirth = rec("queryBirth");
  }
  return h;
}

function withSearch(search, fn) {
  const prev = globalThis.location.search;
  globalThis.location.search = search;
  try { return fn(); } finally { globalThis.location.search = prev; }
}

test("[1] age / birth are retail client verbs", () => {
  assert.deepEqual([...STATUS_CLIENT_VERBS].sort(), ["age", "birth"]);
  assert.ok(RETAIL_CLIENT_VERBS.has("age"));
  assert.ok(RETAIL_CLIENT_VERBS.has("birth"));
  assert.equal(statusCommandSend("age"), "queryAge");
  assert.equal(statusCommandSend("BIRTH"), "queryBirth");
  assert.equal(statusCommandSend("tell"), null);
  assert.equal(statusCommandSend("constructor"), null, "no prototype keys");
  assert.equal(normalizeChatLine("@age").kind, "command");
  assert.equal(normalizeChatLine("@birth").kind, "command");
});

test("[1] /age and @age call queryAge, never a chat line", () => {
  for (const line of ["/age", "@age", "/AGE", "@Age,", "/age someone"]) {
    const h = fakeHandle();
    const r = routeSlashCommand(h, line);
    assert.equal(r.dispatched, true, line);
    assert.equal(r.echo, null, line);
    assert.equal(r.error, undefined, line);
    assert.deepEqual(h.calls, [["queryAge"]], line);
  }
});

test("[1] /birth and @birth call queryBirth, never a chat line", () => {
  for (const line of ["/birth", "@birth", "/Birth,", "@birth now"]) {
    const h = fakeHandle();
    const r = routeSlashCommand(h, line);
    assert.equal(r.dispatched, true, line);
    assert.equal(r.echo, null, line);
    assert.deepEqual(h.calls, [["queryBirth"]], line);
  }
});

test("[1] a throwing binding is reported, not spoken", () => {
  const h = fakeHandle();
  h.queryAge = () => { throw new Error("cmd channel closed"); };
  const r = routeSlashCommand(h, "/age");
  assert.equal(r.dispatched, true);
  assert.match(r.error, /^\/age: cmd channel closed/);
  assert.deepEqual(h.calls, []);
});

test("[2] a pkg without queryAge / queryBirth keeps the server forward", () => {
  const h = fakeHandle({ bindings: false });
  routeSlashCommand(h, "/age");
  routeSlashCommand(h, "/birth");
  assert.deepEqual(h.calls, [["sendChat", "@age"], ["sendChat", "@birth"]]);
});

test("[3] ?retailStatusCmds=off restores the old server forward", () => {
  assert.equal(retailStatusCmdsEnabled(""), true);
  assert.equal(retailStatusCmdsEnabled("?retailStatusCmds=on"), true);
  for (const v of ["off", "0", "false"]) {
    assert.equal(retailStatusCmdsEnabled(`?retailStatusCmds=${v}`), false, v);
  }
  withSearch("?retailStatusCmds=off", () => {
    assert.equal(normalizeChatLine("@age").kind, "server");
    assert.equal(normalizeChatLine("@birth").kind, "server");
    const h = fakeHandle();
    routeSlashCommand(h, "/age");
    routeSlashCommand(h, "/birth");
    assert.deepEqual(h.calls, [["sendChat", "@age"], ["sendChat", "@birth"]]);
  });
});

function dispatchAge(payload) {
  const lines = [];
  const bus = [];
  globalThis.__pluginClient = { events: { emit: (n, d) => bus.push([n, d]), on() {}, off() {} } };
  const evt = { kind: ClientEventKind.UI_EVENT, stringPayload: payload, u32Payload: 0, u32Payload2: 0, free() {} };
  const log = console.log;
  console.log = () => {};
  try {
    dispatchClientEvent(evt, {
      EVT_GUARD_ON: false,
      appendChatLine: (text, category) => lines.push([text, category]),
    });
  } finally {
    console.log = log;
    delete globalThis.__pluginClient;
  }
  return { lines, bus };
}

test("[4] UI_EVENT age: no old `? <age>` line by default; uiEvent still emitted", () => {
  const { lines, bus } = dispatchAge("age||1d 2h");
  assert.deepEqual(lines, [], "the wasm prints the retail line (kind=2)");
  const ui = bus.find((b) => b[0] === "uiEvent");
  assert.ok(ui, "uiEvent emitted");
  assert.equal(ui[1].tag, "age");
  assert.equal(ui[1].rest, "|1d 2h");
});

test("[4] ?retailStatusCmds=off brings the old JS line back", () => {
  withSearch("?retailStatusCmds=off", () => {
    assert.deepEqual(dispatchAge("age||1d 2h").lines, [["? 1d 2h", 0]]);
    assert.deepEqual(dispatchAge("age|Bob|3h").lines, [["Bob 3h", 0]]);
  });
});
