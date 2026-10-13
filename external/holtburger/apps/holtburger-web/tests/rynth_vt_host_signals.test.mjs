// tests/rynth_vt_host_signals.test.mjs — rynth/vt/host_signals.js (W1-8 SEAM,
// PLAN §3.2 "host signals" + §3.10).
//
// The VT layer's ONE host.onEvent subscription, fanning numeric ClientEvent
// kinds out as typed Signals, plus the two synthesized ones (portalOut,
// vendorClose). Pinned here:
//   * exactly one onEvent registration; listener errors isolated
//   * one case per event-kind source: 2, 11, 12, 13, 14, 21, 22, 29, 31, 32,
//     33, 47/48/49, 66
//   * tell + self-tell parsing (control_channel.js regexes), castLine suffixes
//   * death self/other; portalIn + portalOut (sampled falling edge, kind-66
//     fallback); vendorOpen/vendorClose (window event, > 8 m, portal, other
//     container, other vendor, 300 s) and vendorOpen NEVER inferred from a
//     non-null TryGetVendorState
//   * the same module over the REAL RynthWebHost event path
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_host_signals.test.mjs

import assert from "node:assert/strict";

const sig = await import("../rynth/vt/host_signals.js");
const { createHostSignals, parseCastLine, parseTell, SIGNAL_TYPES, VENDOR_CLOSE_RANGE_M, VENDOR_SAFETY_MS, PORTAL_OUT_STUCK_MS } = sig;
const { RynthWebHost } = await import("../rynth/webhost.js");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n       ") : e}`);
  }
}

const SELF = 0x50000001;
const VENDOR = 0x80000100;

// A fake host: records onEvent registrations; `emit` plays a normalized event
// (the shape RynthWebHost._dispatchEvent hands subscribers).
function fakeHost({ portal = undefined, vendorDist = 2, name = "Myself", vendorState = null } = {}) {
  const handlers = [];
  const state = { portal, vendorDist, vendorStateReads: 0 };
  const host = {
    state,
    handlers,
    onEvent: (fn) => handlers.push(fn),
    GetPlayerId: () => SELF,
    TryGetObjectName: (g) => (g === SELF ? name : null),
    TryGetObjectDistance: (g) => (g === VENDOR || g === VENDOR + 1 ? state.vendorDist : null),
    TryGetVendorState: () => { state.vendorStateReads++; return vendorState; },
    emit(kind, { text = null, u32 = 0, u32b = 0, f32 = null } = {}) {
      for (const fn of handlers) fn({ kind, text, u32, u32b, f32 }, host);
    },
  };
  if (portal !== undefined) host.IsPortalSpaceActive = () => state.portal === true;
  return host;
}

// A fake window with addEventListener/removeEventListener/dispatchEvent.
function fakeWin() {
  const l = new Map();
  return {
    listeners: l,
    addEventListener(t, fn) { if (!l.has(t)) l.set(t, new Set()); l.get(t).add(fn); },
    removeEventListener(t, fn) { l.get(t)?.delete(fn); },
    dispatchEvent(ev) { for (const fn of [...(l.get(ev.type) || [])]) fn(ev); return true; },
    count(t) { return l.get(t)?.size ?? 0; },
  };
}

function setup(opts = {}, { win = null } = {}) {
  const host = fakeHost(opts);
  let t = 1_000_000;
  const logs = [];
  const s = createHostSignals(host, { win, now: () => t, log: (m) => logs.push(m) });
  const got = [];
  s.on("*", (x) => got.push(x));
  return { host, s, got, logs, clock: { add: (d) => { t += d; }, get: () => t }, types: () => got.map((x) => x.type) };
}

// ── registration / isolation ───────────────────────────────────────────
await check("exactly one host.onEvent registration, however many listeners", () => {
  const { host, s } = setup();
  for (const type of SIGNAL_TYPES) s.on(type, () => {});
  s.on("*", () => {});
  s.sample();
  assert.equal(host.handlers.length, 1);
});

await check("a throwing listener is isolated (others still run, the error is logged, nothing escapes)", () => {
  const { host, s, logs } = setup();
  const seen = [];
  s.on("useDone", () => { throw new Error("boom"); });
  s.on("useDone", () => seen.push("second"));
  assert.doesNotThrow(() => host.emit(14));
  assert.deepEqual(seen, ["second"]);
  assert.ok(logs.some((m) => /listener for useDone threw: boom/.test(m)), JSON.stringify(logs));
});

await check("unsubscribe, '*' fan-out, latest()/latestAt(), frozen signals with a non-enumerable `at`", () => {
  const { host, s, got, clock } = setup();
  const only = [];
  const off = s.on("inventory", (x) => only.push(x));
  host.emit(11);
  off();
  host.emit(11);
  assert.equal(only.length, 1);
  assert.equal(got.filter((x) => x.type === "inventory").length, 2);
  clock.add(500);
  host.emit(12, { u32: VENDOR, text: "Vendor Bob" });
  const v = s.latest("vendorOpen");
  assert.deepEqual(v, { type: "vendorOpen", guid: VENDOR, name: "Vendor Bob" }, "exact §3.2 shape (at is non-enumerable)");
  assert.equal(v.at, 1_000_500);
  assert.equal(s.latestAt("vendorOpen"), 1_000_500);
  assert.equal(JSON.stringify(v), JSON.stringify({ type: "vendorOpen", guid: VENDOR, name: "Vendor Bob" }));
  assert.ok(Object.isFrozen(v));
  assert.equal(s.latest("death"), null);
  assert.equal(s.latestAt("death"), null);
  assert.deepEqual(typeof s.on("nonsense", () => {}), "function", "unknown type -> no-op unsubscribe");
});

// ── one case per event-kind source (PLAN §3.2) ─────────────────────────
await check("kind 2 -> chat {text, chatType, cat}", () => {
  const { host, got } = setup();
  host.emit(2, { text: "Bob says, \"hi\"", u32: 0x2, u32b: 1 });
  assert.deepEqual(got, [{ type: "chat", text: "Bob says, \"hi\"", chatType: 2, cat: 1 }]);
});
await check("kind 11 -> inventory", () => {
  const { host, got } = setup();
  host.emit(11);
  assert.deepEqual(got, [{ type: "inventory" }]);
});
await check("kind 12 -> vendorOpen {guid, name}", () => {
  const { host, got } = setup();
  host.emit(12, { u32: VENDOR, u32b: 30, text: "Vendor Bob" });
  assert.deepEqual(got, [{ type: "vendorOpen", guid: VENDOR, name: "Vendor Bob" }]);
});
await check("kind 13 -> useFailed {code, text}", () => {
  const { host, got } = setup();
  host.emit(13, { u32: 0x402, text: "Your spell fizzled." });
  assert.deepEqual(got, [{ type: "useFailed", code: 0x402, text: "Your spell fizzled." }]);
});
await check("kind 14 -> useDone", () => {
  const { host, got } = setup();
  host.emit(14);
  assert.deepEqual(got, [{ type: "useDone" }]);
});
await check("kind 21 / 31 -> containerOpened / containerClosed {guid}", () => {
  const { host, got } = setup();
  host.emit(21, { u32: 0x80000200 });
  host.emit(31, { u32: 0x80000200 });
  assert.deepEqual(got, [{ type: "containerOpened", guid: 0x80000200 }, { type: "containerClosed", guid: 0x80000200 }]);
});
await check("kind 22 -> fellowship", () => {
  const { host, got } = setup();
  host.emit(22);
  assert.deepEqual(got, [{ type: "fellowship" }]);
});
await check("kind 29 -> death {victim, killer, self, text}: self when victim === GetPlayerId()", () => {
  const { host, got } = setup();
  host.emit(29, { u32: SELF, u32b: 0x80000300, text: "You were killed by a Drudge!" });
  host.emit(29, { u32: 0x80000300, u32b: SELF, text: "You killed the Drudge!" });
  assert.deepEqual(got, [
    { type: "death", victim: SELF, killer: 0x80000300, self: true, text: "You were killed by a Drudge!" },
    { type: "death", victim: 0x80000300, killer: SELF, self: false, text: "You killed the Drudge!" },
  ]);
});
await check("kind 32 -> appraised {guid}", () => {
  const { host, got } = setup();
  host.emit(32, { u32: 0x80000400 });
  assert.deepEqual(got, [{ type: "appraised", guid: 0x80000400 }]);
});
await check("kind 33 -> portalIn {seq}", () => {
  const { host, got } = setup();
  host.emit(33, { u32: 7 });
  assert.deepEqual(got, [{ type: "portalIn", seq: 7 }]);
});
await check("kind 47 / 49 -> equip {item, wielder, failed:false}; kind 48 -> equip {failed:true, code}", () => {
  const { host, got } = setup();
  host.emit(47, { u32: 0x7000, u32b: SELF });
  host.emit(49, { u32: 0x7001, u32b: SELF });
  host.emit(48, { u32: 0x7002, u32b: 0x29 });
  assert.deepEqual(got, [
    { type: "equip", item: 0x7000, wielder: SELF, failed: false },
    { type: "equip", item: 0x7001, wielder: SELF, failed: false },
    { type: "equip", item: 0x7002, wielder: 0, failed: true, code: 0x29 },
  ]);
});
await check("kind 66 -> teleportArrived {cell}", () => {
  const { host, got } = setup();
  host.emit(66, { u32: 0xa9b40021, u32b: 3 });
  assert.deepEqual(got, [{ type: "teleportArrived", cell: 0xa9b40021 }]);
});
await check("unhandled kinds and garbage events produce nothing and never throw", () => {
  const { host, s, got } = setup();
  host.emit(42, { u32: 5 });
  host.emit(54, { u32: 5, f32: 0.5 });
  for (const fn of host.handlers) {
    assert.doesNotThrow(() => fn(null));
    assert.doesNotThrow(() => fn({}));
    assert.doesNotThrow(() => fn({ kind: 2, text: 42 }));
  }
  assert.doesNotThrow(() => s.sample());
  assert.deepEqual(got, []);
});

// ── tell / self-tell ───────────────────────────────────────────────────
await check("tell: TELL category (u32b 2) + control_channel regex -> {name, text, isSelf:false}", () => {
  const { host, got } = setup();
  host.emit(2, { text: "Torval tells you, \"xp\"", u32: 3, u32b: 2 });
  assert.deepEqual(got[1], { type: "tell", name: "Torval", text: "xp", isSelf: false });
  assert.equal(got[0].type, "chat", "chat first, then the tell");
});

await check("tell: the same text in another category is NOT a tell (no spoofing via say/channel/emote)", () => {
  const { host, got } = setup();
  for (const cat of [0, 1, 3, 4, 16]) host.emit(2, { text: "Torval tells you, \"xp\"", u32b: cat });
  assert.deepEqual(got.map((x) => x.type), ["chat", "chat", "chat", "chat", "chat"]);
});

await check("self-tell (\"You think, …\") -> isSelf:true, name = our character", () => {
  const { host, got } = setup();
  host.emit(2, { text: "You think, \"rs help\"", u32b: 2 });
  assert.deepEqual(got[1], { type: "tell", name: "Myself", text: "rs help", isSelf: true });
  const fresh = setup({ name: null });
  fresh.host.emit(2, { text: "You think, \"x\"", u32b: 2 });
  assert.equal(fresh.got[1].name, "You", "unknown name -> \"You\" (as control_channel)");
});

await check("parseTell keeps quotes and commas in the body; tells to NPC names with spaces", () => {
  assert.deepEqual(parseTell("Sir Torval the Bold tells you, \"go, now, \"quick\"\"", 2), { name: "Sir Torval the Bold", text: "go, now, \"quick\"", isSelf: false });
  assert.equal(parseTell("You tell Bob, \"x\"", 24), null);
  assert.equal(parseTell(null, 2), null);
});

// ── castLine ───────────────────────────────────────────────────────────
await check("castLine outcomes: landed / surpassing / refreshing / surpassed / resisted / failed (ACE WorldObject_Magic.cs)", () => {
  const { host, got } = setup();
  const lines = [
    "You cast Imperil Other VI on Drudge Skulker",
    "You cast Imperil Other VI on Drudge Skulker, surpassing Imperil Other V",
    "You cast Vulnerability Other VI on Drudge Skulker, refreshing Vulnerability Other VI",
    "You cast Imperil Other V on Drudge Skulker, but it is surpassed by Imperil Other VI",
    "Drudge Skulker resists your spell",
    "You fail to affect Drudge Skulker with Imperil Other VI",
  ];
  for (const text of lines) host.emit(2, { text, u32: 0x7, u32b: 7 });
  const casts = got.filter((x) => x.type === "castLine");
  assert.deepEqual(casts, [
    { type: "castLine", spellName: "Imperil Other VI", targetName: "Drudge Skulker", outcome: "landed", raw: lines[0] },
    { type: "castLine", spellName: "Imperil Other VI", targetName: "Drudge Skulker", outcome: "surpassing", raw: lines[1] },
    { type: "castLine", spellName: "Vulnerability Other VI", targetName: "Drudge Skulker", outcome: "refreshing", raw: lines[2] },
    { type: "castLine", spellName: "Imperil Other V", targetName: "Drudge Skulker", outcome: "surpassed", raw: lines[3] },
    { type: "castLine", spellName: "", targetName: "Drudge Skulker", outcome: "resisted", raw: lines[4] },
    { type: "castLine", spellName: "Imperil Other VI", targetName: "Drudge Skulker", outcome: "failed", raw: lines[5] },
  ]);
  assert.equal(got.filter((x) => x.type === "chat").length, 6, "every line is also a chat signal");
});

await check("castLine splitting: spell names with \" on \" / \" with \", suffix spells with \" on \", self target", () => {
  assert.deepEqual(parseCastLine("You cast Laying on of Hands on Torval"), { spellName: "Laying on of Hands", targetName: "Torval", outcome: "landed" });
  assert.deepEqual(parseCastLine("You cast Hearts on Sleeves on yourself, refreshing Hearts on Sleeves"), { spellName: "Hearts on Sleeves", targetName: "yourself", outcome: "refreshing" });
  assert.deepEqual(parseCastLine("You fail to affect Mosswart with Incantation of Acid Stream with 300 Spellpower"), { spellName: "Incantation of Acid Stream with 300 Spellpower", targetName: "Mosswart", outcome: "failed" });
  assert.equal(parseCastLine("You cast Strength Self I and feel stronger"), null, "no target");
  assert.equal(parseCastLine("Your Sword cast Fire Bolt on Drudge"), null, "an item proc is not OUR cast");
  assert.equal(parseCastLine(""), null);
  assert.equal(parseCastLine(undefined), null);
});

await check("castLine is never produced from player speech categories (emote/say/tell/channel)", () => {
  const { host, got } = setup();
  for (const cat of [1, 2, 3, 4, 16, 17, 24]) host.emit(2, { text: "Torval resists your spell", u32b: cat });
  assert.equal(got.filter((x) => x.type === "castLine").length, 0);
  host.emit(2, { text: "Torval resists your spell", u32b: 0 });
  assert.equal(got.filter((x) => x.type === "castLine").length, 1, "system/magic category accepted");
});

// ── portal ─────────────────────────────────────────────────────────────
await check("portalOut = the falling edge of a SAMPLED IsPortalSpaceActive (presentation running)", () => {
  const { host, s, types } = setup({ portal: false });
  host.emit(33, { u32: 1 });
  host.state.portal = true;
  s.sample();
  host.emit(66, { u32: 0x01250105 });
  s.sample();
  assert.deepEqual(types(), ["portalIn", "teleportArrived"], "the hold is still up after kind 66");
  host.state.portal = false;
  s.sample();
  assert.deepEqual(types(), ["portalIn", "teleportArrived", "portalOut"]);
  s.sample();
  s.sample();
  assert.equal(types().filter((x) => x === "portalOut").length, 1, "one portalOut per transit");
});

await check("portalOut from kind 66 when no presentation runs (capability absent, or seam present but inactive)", () => {
  const a = setup(); // no IsPortalSpaceActive at all
  a.host.emit(33, { u32: 1 });
  a.host.emit(66, { u32: 0x01250105 });
  assert.deepEqual(a.types(), ["portalIn", "teleportArrived", "portalOut"]);
  const b = setup({ portal: false }); // ?portalSpace=off: the seam exists, never goes active
  b.host.emit(33, { u32: 1 });
  b.s.sample();
  b.host.emit(66, { u32: 0x01250105 });
  b.s.sample();
  assert.deepEqual(b.types(), ["portalIn", "teleportArrived", "portalOut"]);
});

await check("portal: no portalOut without a transit; a missed falling edge recovers after the arrival; rising edge alone arms it", () => {
  const a = setup();
  a.host.emit(66, { u32: 0x01250105 });
  assert.deepEqual(a.types(), ["teleportArrived"], "kind 66 with no portalIn (login) -> no portalOut");
  const b = setup({ portal: false });
  b.host.emit(33, { u32: 2 });
  b.host.state.portal = true;
  b.host.emit(66, { u32: 0x01250105 }); // arrival while the hold is up, never sampled active
  b.host.state.portal = false;
  b.s.sample();
  assert.deepEqual(b.types(), ["portalIn", "teleportArrived", "portalOut"]);
  const c = setup({ portal: false });
  c.host.state.portal = true; // kind 33 missed
  c.s.sample();
  c.host.state.portal = false;
  c.s.sample();
  assert.deepEqual(c.types(), ["portalOut"]);
});

await check("a presentation flag stuck up after the arrival (hidden tab) ends the transit for the metas after PORTAL_OUT_STUCK_MS — exactly one portalOut; never without kind 66 (review runtime-4)", () => {
  assert.equal(PORTAL_OUT_STUCK_MS, 90_000, "the router's PORTAL_SPACE_MAX_HOLD_MS");
  const a = setup({ portal: false });
  a.host.emit(33, { u32: 1 });
  a.host.state.portal = true;
  a.s.sample();
  a.host.emit(66, { u32: 0x01250105 });
  for (let i = 0; i < 89; i++) {
    a.clock.add(1000);
    a.s.sample();
  }
  assert.deepEqual(a.types(), ["portalIn", "teleportArrived"], "89 s: still in transit");
  for (let i = 0; i < 2; i++) {
    a.clock.add(1000);
    a.s.sample();
  }
  assert.deepEqual(a.types(), ["portalIn", "teleportArrived", "portalOut"], "91 s: one synthesized portalOut");
  assert.ok(a.logs.some((m) => /portalOut synthesized/.test(m)));
  for (let i = 0; i < 30; i++) {
    a.clock.add(1000);
    a.s.sample();
  }
  a.host.state.portal = false; // the flag finally drops
  a.s.sample();
  assert.equal(a.types().filter((x) => x === "portalOut").length, 1, "exactly one per transit");
  // Without the arrival: the transit is not over.
  const b = setup({ portal: false });
  b.host.emit(33, { u32: 2 });
  b.host.state.portal = true;
  for (let i = 0; i < 200; i++) {
    b.clock.add(1000);
    b.s.sample();
  }
  assert.deepEqual(b.types(), ["portalIn"], "no kind 66: no portalOut");
  // A new transit while the flag is still stuck arms again.
  a.host.state.portal = true;
  a.s.sample();
  a.host.emit(33, { u32: 3 });
  a.host.emit(66, { u32: 0x01250106 });
  a.clock.add(91_000);
  a.s.sample();
  assert.equal(a.types().filter((x) => x === "portalOut").length, 2);
});

// ── vendor session ─────────────────────────────────────────────────────
await check("vendorClose via the window event plugins/vendor-ui.js dispatches (hb-vendor-closed)", () => {
  const win = fakeWin();
  const { host, got } = setup({}, { win });
  assert.equal(win.count("hb-vendor-closed"), 1);
  win.dispatchEvent({ type: "hb-vendor-closed", detail: { guid: VENDOR } });
  assert.equal(got.length, 0, "no open vendor -> no close");
  host.emit(12, { u32: VENDOR, text: "Vendor Bob" });
  win.dispatchEvent({ type: "hb-vendor-closed", detail: { guid: 0x80009999 } });
  assert.equal(got.length, 1, "another vendor's close is ignored");
  win.dispatchEvent({ type: "hb-vendor-closed", detail: { guid: VENDOR } });
  assert.deepEqual(got[1], { type: "vendorClose", guid: VENDOR, reason: "window" });
  host.emit(12, { u32: VENDOR, text: "Vendor Bob" });
  win.dispatchEvent({ type: "hb-vendor-closed", detail: { guid: 0 } });
  assert.deepEqual(got[3], { type: "vendorClose", guid: VENDOR, reason: "window" }, "guid 0 (unknown) closes the open one");
});

await check(`vendorClose when the player is > ${VENDOR_CLOSE_RANGE_M} m from the open vendor (sampled)`, () => {
  const { host, s, got } = setup({ vendorDist: 2 });
  host.emit(12, { u32: VENDOR, text: "Vendor Bob" });
  s.sample();
  host.state.vendorDist = 8;
  s.sample();
  assert.equal(got.length, 1, "exactly 8 m is still open");
  host.state.vendorDist = null;
  s.sample();
  assert.equal(got.length, 1, "unknown distance never closes it");
  host.state.vendorDist = 8.5;
  s.sample();
  assert.deepEqual(got[1], { type: "vendorClose", guid: VENDOR, reason: "range" });
  s.sample();
  assert.equal(got.length, 2, "closed once");
});

await check("vendor range on a host WITHOUT TryGetObjectDistance: the inline rule (same LB / both outdoor global frame; cell 0 never closes)", () => {
  const handlers = [];
  const st = { me: { objCellId: 0xa9b40021, x: 100, y: 1, z: 10 }, v: { objCellId: 0xa9b30039, x: 100, y: 190, z: 10 } };
  const host = {
    onEvent: (fn) => handlers.push(fn),
    GetPlayerId: () => SELF,
    TryGetPlayerPose: () => st.me,
    TryGetObjectPosition: (g) => (g === VENDOR ? st.v : null),
  };
  const got = [];
  const s = createHostSignals(host, { log: () => {} });
  s.on("*", (x) => got.push(x));
  for (const fn of handlers) fn({ kind: 12, u32: VENDOR, u32b: 0, text: "Vendor Bob" });
  s.sample();
  assert.equal(got.length, 1, "3 m across the A9B3/A9B4 seam (global frame) stays open");
  st.me = { objCellId: 0, x: 100, y: 1, z: 10 };
  s.sample();
  assert.equal(got.length, 1, "own cell unknown (0) -> no distance -> no close");
  st.me = { objCellId: 0xa9b40021, x: 100, y: 1, z: 10 };
  st.v = { objCellId: 0xa9b40105, x: 100, y: 1, z: 10 }; // an EnvCell of the SAME landblock: same-LB rule
  s.sample();
  assert.equal(got.length, 1);
  st.v = { objCellId: 0xa9b40021, x: 109, y: 1, z: 10 };
  s.sample();
  assert.deepEqual(got[1], { type: "vendorClose", guid: VENDOR, reason: "range" });
});

await check("vendorClose on portal (kind 33 or a rising presentation edge), another container, another vendor", () => {
  const a = setup();
  a.host.emit(12, { u32: VENDOR, text: "Vendor Bob" });
  a.host.emit(33, { u32: 9 });
  assert.deepEqual(a.got.slice(1), [{ type: "portalIn", seq: 9 }, { type: "vendorClose", guid: VENDOR, reason: "portal" }]);
  const b = setup({ portal: false });
  b.host.emit(12, { u32: VENDOR, text: "Vendor Bob" });
  b.host.state.portal = true;
  b.s.sample();
  assert.deepEqual(b.got[1], { type: "vendorClose", guid: VENDOR, reason: "portal" });
  const c = setup();
  c.host.emit(12, { u32: VENDOR, text: "Vendor Bob" });
  c.host.emit(21, { u32: VENDOR }); // the vendor's own container view keeps it open
  c.host.emit(21, { u32: 0x80000200 }); // a corpse/chest opened -> closed
  assert.deepEqual(c.got.slice(1), [
    { type: "containerOpened", guid: VENDOR },
    { type: "containerOpened", guid: 0x80000200 },
    { type: "vendorClose", guid: VENDOR, reason: "container" },
  ]);
  const d = setup();
  d.host.emit(12, { u32: VENDOR, text: "Vendor Bob" });
  d.host.emit(12, { u32: VENDOR, text: "Vendor Bob" }); // ACE re-sends kind 12 after every buy
  d.host.emit(12, { u32: VENDOR + 1, text: "Vendor Ann" });
  assert.deepEqual(d.types(), ["vendorOpen", "vendorOpen", "vendorClose", "vendorOpen"]);
  assert.deepEqual(d.got[2], { type: "vendorClose", guid: VENDOR, reason: "otherVendor" });
});

await check(`vendorClose after ${VENDOR_SAFETY_MS / 1000} s without a kind-12 refresh (safety)`, () => {
  const { host, s, got, clock } = setup();
  host.emit(12, { u32: VENDOR, text: "Vendor Bob" });
  clock.add(VENDOR_SAFETY_MS - 1);
  host.emit(12, { u32: VENDOR, text: "Vendor Bob" }); // refresh restarts the window
  clock.add(VENDOR_SAFETY_MS);
  s.sample();
  assert.equal(got.filter((x) => x.type === "vendorClose").length, 0);
  clock.add(1);
  s.sample();
  assert.deepEqual(got.at(-1), { type: "vendorClose", guid: VENDOR, reason: "timeout" });
});

await check("vendorOpen is NEVER inferred from a non-null TryGetVendorState (cached past the session, critic B2)", () => {
  const { host, s, got } = setup({ vendorState: { vendorGuid: VENDOR, vendorName: "Vendor Bob", items: [] } });
  for (let i = 0; i < 50; i++) s.sample();
  host.emit(11);
  host.emit(14);
  s.sample();
  assert.equal(got.filter((x) => x.type === "vendorOpen").length, 0);
  assert.equal(host.state.vendorStateReads, 0, "the module does not even read it");
});

// ── dispose ────────────────────────────────────────────────────────────
await check("dispose(): JS listeners and the window listener detached; later events ignored; idempotent", () => {
  const win = fakeWin();
  const { host, s, got } = setup({}, { win });
  s.dispose();
  assert.equal(win.count("hb-vendor-closed"), 0);
  host.emit(12, { u32: VENDOR, text: "Vendor Bob" });
  host.emit(14);
  s.sample();
  assert.equal(got.length, 0);
  assert.equal(s.latest("vendorOpen"), null);
  assert.doesNotThrow(() => s.dispose());
  assert.equal(typeof s.on("useDone", () => {}), "function");
  assert.equal(host.handlers.length, 1, "host.onEvent has no removal API: the closure stays, inert");
});

await check("never throws: a host whose members throw, no onEvent, no window", () => {
  const throwing = {
    onEvent: () => { throw new Error("no"); },
    GetPlayerId: () => { throw new Error("no"); },
    IsPortalSpaceActive: () => { throw new Error("no"); },
    TryGetObjectDistance: () => { throw new Error("no"); },
  };
  const logs = [];
  let s;
  assert.doesNotThrow(() => { s = createHostSignals(throwing, { log: (m) => logs.push(m) }); });
  assert.doesNotThrow(() => s.sample());
  assert.ok(logs.some((m) => /registration failed/.test(m)));
  assert.doesNotThrow(() => createHostSignals({}, { log: () => {} }).sample());
  assert.doesNotThrow(() => createHostSignals(null, { log: () => {} }).sample());
});

// ── over the REAL RynthWebHost event path ──────────────────────────────
await check("real RynthWebHost: one subscriber added; normalized wasm events become Signals; item token cleared first", () => {
  const host = new RynthWebHost({ playerGuid: () => SELF, objectName: (g) => (g === SELF ? "Myself" : undefined) }, { entityMap: new Map(), noEventTap: true });
  const before = host._onEvent.length;
  const s = createHostSignals(host, { log: () => {} });
  assert.equal(host._onEvent.length, before + 1);
  const got = [];
  let tokenAtUseDone = "unset";
  s.on("*", (x) => got.push(x.type));
  s.on("useDone", () => { tokenAtUseDone = host.itemActionToken; });
  host.tryClaimItemAction("vtinv");
  host._dispatchEvent({ kind: 2, stringPayload: "Torval tells you, \"xp\"", u32Payload: 3, u32Payload2: 2 });
  host._dispatchEvent({ kind: 12, u32Payload: VENDOR, stringPayload: "Vendor Bob", u32Payload2: 12 });
  host._dispatchEvent({ kind: 14 });
  host._dispatchEvent({ kind: 33, u32Payload: 4 });
  host._dispatchEvent({ kind: 66, u32Payload: 0x01250105, u32Payload2: 4 });
  assert.deepEqual(got, ["chat", "tell", "vendorOpen", "useDone", "portalIn", "vendorClose", "teleportArrived", "portalOut"]);
  assert.equal(tokenAtUseDone, null, "the host resolved the item token before subscribers ran");
  assert.equal(s.latest("tell").name, "Torval");
});

await check("real RynthWebHost: vendor range close through the host's TryGetObjectDistance (snapshot pose; cell 0 never closes)", () => {
  const st = { pose: { landblockId: 0xa9b40021, x: 100, y: 100, z: 10, heading: 0 }, vendor: [0xa9b40021, 102, 100, 10] };
  const host = new RynthWebHost({
    playerGuid: () => SELF,
    getLocalPlayerPose: () => ({ ...st.pose }),
    objectPosition: (g) => (g === VENDOR ? st.vendor : undefined),
    nearbyEntityGuids: () => Uint32Array.from([VENDOR]),
  }, { entityMap: new Map(), noEventTap: true });
  host._tick();
  const s = createHostSignals(host, { log: () => {} });
  const got = [];
  s.on("*", (x) => got.push(x));
  host._dispatchEvent({ kind: 12, u32Payload: VENDOR, stringPayload: "Vendor Bob" });
  s.sample();
  assert.equal(got.length, 1, "2 m: open");
  st.pose = { landblockId: 0, x: 100, y: 100, z: 10, heading: 0 }; // login/teleport gap: no cell known
  host._tick();
  s.sample();
  assert.equal(got.length, 1, "own cell unknown -> no distance -> stays open");
  st.pose = { landblockId: 0xa9b40021, x: 115, y: 100, z: 10, heading: 0 };
  host._tick();
  s.sample();
  assert.deepEqual(got[1], { type: "vendorClose", guid: VENDOR, reason: "range" });
});

console.log(fail === 0 ? `rynth_vt_host_signals: all ${pass} checks passed` : `rynth_vt_host_signals: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
