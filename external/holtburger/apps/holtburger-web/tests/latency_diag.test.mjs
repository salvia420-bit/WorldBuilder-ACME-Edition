// tests/latency_diag.test.mjs — app/latency_diag.js hop stamps + the
// per-batch panel coalescing in app/client_events.js (2026-10-05 latency
// pass). Fake WebSocket / SessionHandle / rAF; real modules.
//
// Run: node tests/latency_diag.test.mjs

globalThis.window = globalThis;
globalThis.location = { search: "", href: "http://test/index.html", reload() {} };
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ style: {} }),
  body: { appendChild() {} },
};
const rafQueue = [];
globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
const flushRaf = () => { while (rafQueue.length) rafQueue.shift()(performance.now()); };

// Fake WebSocket with a real prototype `onmessage` accessor (like the DOM).
class FakeWS {
  constructor() { this.sent = []; this._h = null; }
  send(data) { this.sent.push(data); }
}
Object.defineProperty(FakeWS.prototype, "onmessage", {
  configurable: true,
  enumerable: true,
  get() { return this._h; },
  set(fn) { this._h = fn; },
});

const LOCAL = 0x50000001;
globalThis.getLocalPlayerGuid = () => LOCAL;

const {
  createLatencyDiag, parseOutboundActionType, inboundMatches,
} = await import("../app/latency_diag.js");
const { dispatchClientEvent, flushPanelBatch } = await import("../app/client_events.js");
const { ClientEventKind } = await import("../scene3d/client_event_kinds.js");

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) passed += 1; else failed += 1;
}

function wU32(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff; }

// [port u16 BE][hdr 20: seq, flags, checksum, id/time/size/iter][frag 16][F7B1][seq][type]
function outboundAction(type, flags = 0x6) {
  const b = new Uint8Array(2 + 20 + 16 + 12 + 8);
  b[0] = 0x23; b[1] = 0x29;
  wU32(b, 2, 7); wU32(b, 6, flags);
  wU32(b, 38, 0xf7b1); wU32(b, 42, 1); wU32(b, 46, type);
  return b;
}
function inbound(bytesAt30) {
  const b = new Uint8Array(96);
  b.set(bytesAt30, 30);
  return b.buffer;
}
function gameEvent(evType) {
  const m = new Uint8Array(16);
  wU32(m, 0, 0xf7b0); wU32(m, 4, LOCAL); wU32(m, 8, 3); wU32(m, 12, evType);
  return m;
}
function updateMotion(guid) {
  const m = new Uint8Array(16);
  wU32(m, 0, 0xf74c); wU32(m, 4, guid);
  return m;
}

console.log("app/latency_diag.js — parsers");
check("outbound Use parses as 0x0036", parseOutboundActionType(outboundAction(0x36)) === 0x36);
check("outbound with optional-header flags is ignored", parseOutboundActionType(outboundAction(0x36, 0x4004)) === -1);
check("useDone matches UseDone GameEvent", inboundMatches(inbound(gameEvent(0x01c7)), "useDone", LOCAL));
check("useDone matches WeenieError", inboundMatches(inbound(gameEvent(0x028a)), "useDone", LOCAL));
check("useDone ignores other GameEvents", !inboundMatches(inbound(gameEvent(0x0013)), "useDone", LOCAL));
check("selfMotion matches local UpdateMotion", inboundMatches(inbound(updateMotion(LOCAL)), "selfMotion", LOCAL));
check("selfMotion ignores a remote UpdateMotion", !inboundMatches(inbound(updateMotion(0x80000123)), "selfMotion", LOCAL));

console.log("app/latency_diag.js — useObject hop chain");
{
  const L = createLatencyDiag();
  check("hookWebSocket installs", L.hookWebSocket(FakeWS) === true);
  class Handle { useObject(g) { this.last = g; } tickMovement() {} sessionLastPingRttMs() { return 88; } }
  const h = new Handle();
  check("attachHandle wraps", L.attachHandle(h) === true);
  check("non-action methods are not wrapped", Handle.prototype.tickMovement.name === "tickMovement");
  const ws = new FakeWS();
  let delivered = 0;
  ws.onmessage = () => { delivered += 1; };
  check("onmessage getter returns the original handler", typeof ws.onmessage === "function" && ws.onmessage.name !== "latencyOnMessage");

  h.useObject(0x7000beef);
  check("wrapped method still runs", h.last === 0x7000beef);
  check("record begun + enqueued", L.records.length === 1 && Number.isFinite(L.records[0].tEnq));
  ws.send(outboundAction(0xf753)); // AutonomousPosition heartbeat: must not claim
  check("background heartbeat does not claim the wire hop", !Number.isFinite(L.records[0].tWire));
  ws.send(outboundAction(0x36));
  check("Use packet stamps tWire + act", Number.isFinite(L.records[0].tWire) && L.records[0].actHex === "0x0036");
  ws._h({ data: inbound(updateMotion(0x80000123)) });
  check("unrelated inbound sets tIn1 only", Number.isFinite(L.records[0].tIn1) && !Number.isFinite(L.records[0].tInRel));
  ws._h({ data: inbound(gameEvent(0x01c7)) });
  check("UseDone inbound stamps tInRel", Number.isFinite(L.records[0].tInRel));
  check("inbound handler still delivered both frames", delivered === 2);
  L.onPumpStart();
  check("pump after the reply stamps tDrain", Number.isFinite(L.records[0].tDrain));
  L.onEvent(ClientEventKind.USE_DONE);
  check("UseDone event stamps tUi", L.records[0].uiVia === `event:${ClientEventKind.USE_DONE}`);
  flushRaf();
  check("next rAF stamps tPaint", Number.isFinite(L.records[0].tPaint));
  check("record left the pending set", L._pending.length === 0);
  const s = L.summary();
  check("summary has one row with every hop", s.rows.length === 1 && s.rows[0].total !== null && s.rows[0].clientOwned !== null, JSON.stringify(s.rows[0]));
  check("summary reports ping RTT", s.pingRttMs === 88);
}

console.log("app/latency_diag.js — stance hop via local KIND_MOTION");
{
  const L = createLatencyDiag();
  L.hookWebSocket(FakeWS);
  class Handle { toggleCombatMode() {} }
  const h = new Handle();
  L.attachHandle(h);
  const ws = new FakeWS();
  ws.onmessage = () => {};
  h.toggleCombatMode();
  L.onEntityUpdate(5, LOCAL);
  check("self motion before the reply does not count", !Number.isFinite(L.records[0].tUi));
  ws.send(outboundAction(0x53));
  ws._h({ data: inbound(updateMotion(LOCAL)) });
  L.onPumpStart();
  L.onEntityUpdate(5, 0x80000123);
  check("remote motion does not count", !Number.isFinite(L.records[0].tUi));
  L.onEntityUpdate(5, LOCAL);
  check("local motion after the reply = rig updated", L.records[0].uiVia === "selfMotion");
  flushRaf();
  check("stance record painted", Number.isFinite(L.records[0].tPaint));
}

console.log("app/client_events.js — panel batch coalescing");
{
  let vitals = 0;
  let inv = 0;
  const emits = [];
  window.__pluginClient = { events: { emit: (n) => emits.push(n) } };
  const batch = { stats: false, inventory: false };
  const D = {
    handle: {},
    renderVitalsPanel() { vitals += 1; },
    renderInventoryPanel() { inv += 1; },
    EVT_GUARD_ON: true,
    panelBatch: batch,
  };
  const evt = (kind) => ({ kind, u32Payload: 0, u32Payload2: 0, stringPayload: "", free() {} });
  for (const k of [8, 11, 8, 11, 8]) dispatchClientEvent(evt(k), D);
  check("no render during the batch", vitals === 0 && inv === 0);
  flushPanelBatch(batch, D);
  check("one vitals render per batch", vitals === 1);
  check("one inventory render per batch", inv === 1);
  check("one emit each, render-then-emit order kept", JSON.stringify(emits) === JSON.stringify(["playerStatsUpdated", "playerInventoryChanged"]), JSON.stringify(emits));
  flushPanelBatch(batch, D);
  check("flags reset after flush", vitals === 1 && inv === 1);
  D.panelBatch = null;
  dispatchClientEvent(evt(11), D);
  check("no batch object = render per event (old path)", inv === 2);
}

console.log(`\nlatency_diag: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
