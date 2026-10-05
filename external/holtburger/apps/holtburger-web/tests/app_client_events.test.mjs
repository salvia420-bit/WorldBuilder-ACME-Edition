// tests/app_client_events.test.mjs — the ClientEvent dispatcher after its move
// out of index.html's pumpNetFrame() loop into app/client_events.js
// (2026-10-05). The move turned loop control flow into function returns, so
// pin exactly those seams with a REAL import (no source-text extraction):
//
//   1. kind 4 (Disconnected) used to `return` out of pumpNetFrame — it now
//      returns STOP_PUMP (the caller returns), still after the finally freed
//      the event.
//   2. kind 61 with CMD_INTERP off used to `continue` — it now returns
//      undefined (the batch keeps draining), event freed.
//   3. evtGuard: a throwing handler is swallowed + counted when EVT_GUARD_ON,
//      rethrown when off — the event is freed either way.
//   4. the session `let`s index.html still owns are WRITTEN through the deps
//      accessors (kind 1 PlayerSpawned -> spawnedPlayerGuid / spawningCharId).
//   5. every evt.kind arm uses a ClientEventKind name (no bare numbers), and
//      every name it uses exists in the generated table.
//
// Run: node tests/app_client_events.test.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Minimal browser globals: the arms under test only touch these.
globalThis.window = globalThis;
globalThis.location = { search: "", href: "http://test/index.html", reload() {} };
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ style: {} }),
  body: { appendChild() {} },
};

const { dispatchClientEvent, STOP_PUMP } = await import("../app/client_events.js");
const { ClientEventKind } = await import("../scene3d/client_event_kinds.js");

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}

function makeEvt(kind, extra = {}) {
  const evt = { kind, u32Payload: 0, u32Payload2: 0, stringPayload: "", freed: 0, ...extra };
  evt.free = () => { evt.freed += 1; };
  return evt;
}

function makeDeps(over = {}) {
  const state = { spawningCharId: 7, spawnedPlayerGuid: null, enteredWorld: false, lastPredictionTime: 0 };
  const D = {
    loginStatus: { innerHTML: "" },
    resets: 0,
    __resetEntDrainPending() { D.resets += 1; },
    setLocalPlayerGuid() {},
    getLocalPlayerGuid: () => state.spawnedPlayerGuid,
    setBootState() {},
    EVT_GUARD_ON: true,
    CMD_INTERP_ON: false,
    CAST_MOVE_ON: false,
    ...over,
  };
  for (const k of Object.keys(state)) {
    Object.defineProperty(D, k, { get: () => state[k], set: (v) => { state[k] = v; }, enumerable: true });
  }
  return { D, state };
}

console.log("app/client_events.js — dispatchClientEvent control flow");

// 1. kind 4 → STOP_PUMP (was `return` out of pumpNetFrame), freed, side effects intact.
{
  const { D } = makeDeps();
  const evt = makeEvt(ClientEventKind.DISCONNECTED, { stringPayload: "<b>bye</b>" });
  const r = dispatchClientEvent(evt, D);
  check("kind 4 returns STOP_PUMP", r === STOP_PUMP);
  check("kind 4 frees the event exactly once", evt.freed === 1, `freed=${evt.freed}`);
  check("kind 4 writes the escaped reason to loginStatus",
    D.loginStatus.innerHTML.includes("&lt;b&gt;bye&lt;/b&gt;") && !D.loginStatus.innerHTML.includes("<b>bye"));
  check("kind 4 stashes the raw reason on window.__lastDisconnect", window.__lastDisconnect?.reason === "<b>bye</b>");
  check("kind 4 resets the cross-frame entity drain", D.resets === 1);
}

// 2. kind 61 with CMD_INTERP off → plain return (was `continue`), freed.
{
  const { D } = makeDeps({ CMD_INTERP_ON: false });
  const evt = makeEvt(ClientEventKind.CMD_INTERP, { u32Payload: 3 });
  const r = dispatchClientEvent(evt, D);
  check("kind 61 (CMD_INTERP off) returns undefined — the batch keeps draining", r === undefined);
  check("kind 61 (CMD_INTERP off) frees the event", evt.freed === 1);
}

// 3. evtGuard — throwing handler. kind 2 (ChatReceived) calls appendChatLine.
{
  window.__evtGuardStats = { catches: 0, byKind: {}, last: null };
  const boom = () => { throw new Error("handler boom"); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { D } = makeDeps({ EVT_GUARD_ON: true, appendChatLine: boom, chatPanel: { hidden: false } });
    const evt = makeEvt(ClientEventKind.CHAT_RECEIVED, { stringPayload: "hi" });
    let threw = false;
    try { dispatchClientEvent(evt, D); } catch (_) { threw = true; }
    check("evtGuard ON: a throwing handler does not escape", !threw);
    check("evtGuard ON: the catch is counted per kind",
      window.__evtGuardStats.catches === 1 && window.__evtGuardStats.byKind[String(ClientEventKind.CHAT_RECEIVED)] === 1,
      JSON.stringify(window.__evtGuardStats.byKind));
    check("evtGuard ON: the event is still freed", evt.freed === 1);

    const { D: D2 } = makeDeps({ EVT_GUARD_ON: false, appendChatLine: boom, chatPanel: { hidden: false } });
    const evt2 = makeEvt(ClientEventKind.CHAT_RECEIVED, { stringPayload: "hi" });
    let threw2 = false;
    try { dispatchClientEvent(evt2, D2); } catch (_) { threw2 = true; }
    check("evtGuard OFF: the handler error propagates (abort-the-batch)", threw2);
    check("evtGuard OFF: the event is still freed (finally)", evt2.freed === 1);
  } finally {
    console.warn = warn;
  }
}

// 4. live accessors: kind 1 writes the index.html-owned session lets.
{
  const { D, state } = makeDeps();
  const warn = console.warn;
  console.warn = () => {};
  try {
    window.__evtGuardStats = { catches: 0, byKind: {}, last: null };
    dispatchClientEvent(makeEvt(ClientEventKind.PLAYER_SPAWNED, { u32Payload: 0x50000001 }), D);
  } finally {
    console.warn = warn;
  }
  check("kind 1 writes spawnedPlayerGuid through the deps accessor", state.spawnedPlayerGuid === 0x50000001,
    `got ${state.spawnedPlayerGuid}`);
  check("kind 1 clears spawningCharId through the deps accessor", state.spawningCharId === null);
}

// 5. no bare kind numbers; every name used exists.
{
  const src = readFileSync(path.join(APP, "app", "client_events.js"), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"); // comments excluded
  check("no bare `evt.kind === <number>` comparisons remain", !/evt\.kind\s*===\s*\d/.test(code));
  const used = [...code.matchAll(/ClientEventKind\.([A-Z_0-9]+)/g)].map((m) => m[1]);
  const unknown = [...new Set(used)].filter((n) => !(n in ClientEventKind));
  check("every ClientEventKind name used is in the generated table", unknown.length === 0, unknown.join(","));
  check("the dispatcher still covers >= 50 kinds", new Set(used).size >= 50, `${new Set(used).size}`);
}

console.log(`\napp_client_events: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
