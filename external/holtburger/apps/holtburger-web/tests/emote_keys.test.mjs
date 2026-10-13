// tests/emote_keys.test.mjs — input-options-5 (2026-10-13): retail's emote
// and posture keys (ACCmdInterp::OnAction's emote-hash arm,
// acclient.c:436010-436018; InitializeEmoteInputActionHash :436034).
//
//   [1] the table (ui/emote_keys.js): 91 rows, row for row with the wasm
//       hash (command_interpreter.rs EMOTE_INPUT_ACTION_IDS / _PAIRS); every
//       id is the ClientAction of that name; the 9 gmDefaultMap defaults.
//   [2] the Rust motion ids are end-of-retail: keys of the DAT player
//       MotionTable (tests/fixtures/ws01_player_mt_fromReady.json, NonCombat).
//   [3] the defaults collide with no live LOCAL_ACTIONS / hard-coded key, no
//       selection key and no index.html CMD_INTERP_ACTIONS key.
//   [4] `?emoteKeys` parsing (DEFAULT-OFF).
//   [5] installEmoteKeys on a real InputFunnel: off by default, needs the
//       cmdInterp lane, binds under retail ids, forwards presses only,
//       rebindable, stale-pkg safe, unbinds.
//   [6] static wiring: index.html installs it with the handle + CMD_INTERP_ON.
//
// Run from apps/holtburger-web/:  node tests/emote_keys.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const APP = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolvePath(APP, "..", "..");

class MemStorage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.localStorage ??= new MemStorage();

const { InputFunnel } = await import("../ui/input-funnel.js");
const K = await import("../ui/keymap.js");
const SK = await import("../ui/selection_keys.js");
const EK = await import("../ui/emote_keys.js");

const RUST = readFileSync(
  resolvePath(REPO, "crates/holtburger-core/src/client/movement/command_interpreter.rs"), "utf8");

function rustTable(name) {
  const at = RUST.indexOf(`pub(crate) const ${name}`);
  assert.ok(at > 0, `${name} present`);
  return RUST.slice(at, RUST.indexOf("];", at));
}
const RUST_IDS = [...rustTable("EMOTE_INPUT_ACTION_IDS")
  .matchAll(/\(0x([0-9A-F_]+), 0x([0-9A-F_]+)\), \/\/ (\w+)/g)]
  .map((m) => ({
    input: Number.parseInt(m[1].replace(/_/g, ""), 16),
    motion: Number.parseInt(m[2].replace(/_/g, ""), 16),
    name: m[3],
  }));
const RUST_PAIRS = [...rustTable("EMOTE_INPUT_ACTION_PAIRS").matchAll(/\("(\w+)", "(Motion_\w+)"\)/g)]
  .map((m) => m[1]);

const hex = (n) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;

// ── [1] the table ────────────────────────────────────────────────────────
test("91 rows, row for row with the wasm emote hash", () => {
  const rows = EK.EMOTE_KEY_ACTIONS;
  assert.equal(rows.length, 91);
  assert.equal(RUST_IDS.length, 91, "Rust EMOTE_INPUT_ACTION_IDS");
  assert.equal(RUST_PAIRS.length, 91, "Rust EMOTE_INPUT_ACTION_PAIRS");
  assert.equal(new Set(rows.map((r) => r.action)).size, 91, "unique ids");
  rows.forEach((r, i) => {
    assert.equal(r.action, RUST_IDS[i].input, `row ${i} id`);
    assert.equal(r.name, RUST_IDS[i].name, `row ${i} name (ids table comment)`);
    assert.equal(r.name, RUST_PAIRS[i], `row ${i} name (pairs table)`);
  });
});

test("every id is the ClientAction of that name (holtburger-common ui.rs)", () => {
  const ui = readFileSync(resolvePath(REPO, "crates/holtburger-common/src/properties/ui.rs"), "utf8");
  const start = ui.indexOf("pub enum ClientAction");
  const body = ui.slice(start, ui.indexOf("\n}", start));
  const byId = new Map([...body.matchAll(/^\s*(\w+)\s*=\s*0x([0-9A-Fa-f]{8}),/gm)]
    .map((m) => [Number.parseInt(m[2], 16), m[1]]));
  for (const r of EK.EMOTE_KEY_ACTIONS) {
    assert.equal(byId.get(r.action), r.name, `${hex(r.action)} is ClientAction::${r.name}`);
  }
  // acclient.c `const unsigned int Ready = 268435604u;` … (decimal there).
  const id = (n) => EK.EMOTE_KEY_ACTIONS.find((r) => r.name === n)?.action;
  assert.deepEqual([id("Ready"), id("Crouch"), id("Sitting"), id("Sleeping")],
    [268435604, 268435605, 268435606, 268435607]);
  assert.equal(id("Cheer"), 268435618);
  assert.equal(id("Wave"), 268435685);
});

test("the defaults are gmDefaultMap's nine; the rest start unbound", () => {
  const bound = EK.EMOTE_KEY_ACTIONS.filter((r) => r.defaultBinding);
  assert.deepEqual(
    Object.fromEntries(bound.map((r) => [r.name, r.defaultBinding])),
    {
      Ready: "KeyY", Crouch: "KeyH", Sitting: "KeyG", Sleeping: "KeyB",
      PointState: "KeyK", Cheer: "KeyO", Cry: "KeyU", Laugh: "KeyI", Wave: "KeyJ",
    },
  );
  // K is PointState (0x100000BE) in the DAT KeyMap, not Point (0x100000BD).
  assert.equal(EK.EMOTE_KEY_ACTIONS.find((r) => r.defaultBinding === "KeyK").action, 0x100000BE);
  assert.equal(EK.EMOTE_KEY_ACTIONS.find((r) => r.name === "Point").defaultBinding, null);
  assert.equal(new Set(bound.map((r) => r.defaultBinding)).size, bound.length, "distinct keys");
});

// ── [2] motion ids vs the DAT ────────────────────────────────────────────
test("the hash's motion ids are keys of the DAT player MotionTable (end-of-retail numbering)", () => {
  const fx = JSON.parse(readFileSync(resolvePath(APP, "tests/fixtures/ws01_player_mt_fromReady.json"), "utf8"));
  const nonCombat = new Set(fx.nonCombatStance_0x3d.map((s) => Number.parseInt(s, 16) >>> 0));
  for (const r of RUST_IDS) {
    if (r.name === "Ready") continue; // the link source itself, not an inner key
    assert.ok(nonCombat.has(r.motion >>> 0), `${r.name} ${hex(r.motion)} is a NonCombat MotionTable key`);
  }
  // The PDB build's (acclient.c) values for the shifted rows are not keys.
  for (const v of [0x43000115 /* SnowAngelState */, 0x4300013A /* SitState */,
    0x13000116 /* WarmHands */, 0x13000132 /* Helper */]) {
    assert.ok(!nonCombat.has(v), `${hex(v)} (acclient.c numbering) is not a DAT key`);
  }
  const motion = (n) => RUST_IDS.find((r) => r.name === n).motion;
  assert.equal(motion("Sitting"), 0x41000013);
  assert.equal(motion("Ready"), 0x41000003);
  assert.equal(motion("Wave"), 0x13000087);
  assert.equal(motion("SitState"), 0x4300013D);
});

// ── [3] collisions ───────────────────────────────────────────────────────
test("the defaults collide with no live LOCAL_ACTIONS default or hard-coded key", () => {
  for (const r of EK.EMOTE_KEY_ACTIONS) {
    if (!r.defaultBinding) continue;
    const hits = K.findConflictingBindings(r.defaultBinding, false, false, false, false);
    assert.deepEqual(hits, [], `${r.name} (${r.defaultBinding}) conflicts: ${JSON.stringify(hits)}`);
  }
});

test("the defaults collide with no selection key and no CMD_INTERP_ACTIONS key", () => {
  const ours = new Set(EK.EMOTE_KEY_ACTIONS.map((r) => r.defaultBinding).filter(Boolean));
  for (const r of SK.SELECTION_KEY_ACTIONS) {
    assert.ok(!ours.has(r.defaultBinding), `${r.label} (${r.defaultBinding})`);
  }
  const html = readFileSync(resolvePath(APP, "index.html"), "utf8");
  const at = html.indexOf("const CMD_INTERP_ACTIONS = {");
  assert.ok(at > 0, "CMD_INTERP_ACTIONS present");
  const block = html.slice(at, html.indexOf("};", at));
  const keys = [...block.matchAll(/^\s*(?:"([^"]+)"|(\w+)):\s*0x/gm)].map((m) => m[1] ?? m[2]);
  assert.ok(keys.includes("w") && keys.includes("shift"), `parsed ${keys}`);
  const asCode = (k) => (k === " " ? "Space" : k === "shift" ? "ShiftLeft" : `Key${k.toUpperCase()}`);
  for (const k of keys) assert.ok(!ours.has(asCode(k)), `movement key ${JSON.stringify(k)}`);
  // C (camera toggle), M (world map), R (autorun), T (closest monster) stay free.
  for (const code of ["KeyC", "KeyM", "KeyR", "KeyT"]) assert.ok(!ours.has(code), code);
});

// ── [4] the flag ─────────────────────────────────────────────────────────
test("?emoteKeys is DEFAULT-OFF; on/1/true opt in, off/0/false opt out", () => {
  assert.equal(EK.EMOTE_KEYS_DEFAULT_ON, false);
  assert.equal(EK.emoteKeysOn(""), false);
  assert.equal(EK.emoteKeysOn("?foo=1"), false);
  for (const v of ["on", "ON", "1", "true"]) assert.equal(EK.emoteKeysOn(`?emoteKeys=${v}`), true, v);
  for (const v of ["off", "0", "false"]) assert.equal(EK.emoteKeysOn(`?emoteKeys=${v}`), false, v);
  assert.equal(EK.emoteKeysOn("?emoteKeys=maybe"), EK.EMOTE_KEYS_DEFAULT_ON);
});

// ── [5] installEmoteKeys on a real InputFunnel ───────────────────────────
function keyEv(code, mods = {}) {
  return {
    code, key: code, shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, metaKey: false,
    repeat: !!mods.repeat, target: null, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
}
function fakeHandle() {
  const calls = [];
  return { calls, handleKeyAction(action, down) { calls.push([action, down]); } };
}

test("nothing is bound by default, without the cmdInterp lane, or without a funnel", () => {
  const h = fakeHandle();
  const f1 = new InputFunnel();
  EK.installEmoteKeys(f1, { getHandle: () => h, cmdInterpOn: true, search: "" });
  assert.equal(f1.actions.length, 0, "default off");
  const f2 = new InputFunnel();
  EK.installEmoteKeys(f2, { getHandle: () => h, cmdInterpOn: false, search: "?emoteKeys=on" });
  assert.equal(f2.actions.length, 0, "?cmdInterp=off has no emote hash");
  const f3 = new InputFunnel();
  EK.installEmoteKeys(f3, { getHandle: () => h, search: "?emoteKeys=on" });
  assert.equal(f3.actions.length, 0, "cmdInterpOn must be passed explicitly");
  assert.equal(typeof EK.installEmoteKeys(null, { cmdInterpOn: true, search: "?emoteKeys=on" }), "function");
  f1.handleKeyDown(keyEv("KeyG"));
  assert.deepEqual(h.calls, [], "G does nothing when off");
  assert.equal(K.retailActionStatus(0x10000096, { funnelActions: f1.actions }).status, "unavailable");
});

test("opted in: 91 actions under retail ids; a press forwards handleKeyAction(id, true) once", () => {
  const funnel = new InputFunnel();
  const h = fakeHandle();
  const off = EK.installEmoteKeys(funnel, { getHandle: () => h, cmdInterpOn: true, search: "?emoteKeys=on" });
  const hashes = funnel.actions.map((a) => a.labelHash);
  assert.equal(hashes.length, 91);
  assert.ok(hashes.includes("0x10000096") && hashes.includes("0x100000E5"));
  assert.ok(funnel.actions.every((a) => a.source === "emote"));

  // Press, then release outside the recorded window (the funnel's held-key
  // ledger warns about a re-press with no key-up in between).
  const press = (code, mods) => {
    h.calls.length = 0;
    const ev = keyEv(code, mods);
    funnel.handleKeyDown(ev);
    const calls = h.calls.slice();
    if (!mods?.repeat) funnel.handleKeyUp(keyEv(code));
    h.calls.length = 0;
    h.calls.push(...calls);
    return ev;
  };
  const want = { KeyY: 0x10000094, KeyH: 0x10000095, KeyG: 0x10000096, KeyB: 0x10000097,
    KeyO: 0x100000A2, KeyU: 0x100000A7, KeyI: 0x100000B2, KeyK: 0x100000BE, KeyJ: 0x100000E5 };
  for (const [code, id] of Object.entries(want)) {
    const ev = press(code);
    assert.deepEqual(h.calls, [[id, true]], code);
    assert.equal(ev.defaultPrevented, true, `${code} consumed`);
  }
  h.calls.length = 0;
  funnel.handleKeyDown(keyEv("KeyG"));
  funnel.handleKeyDown(keyEv("KeyG", { repeat: true }));
  assert.deepEqual(h.calls, [[0x10000096, true]], "OS autorepeat does not re-fire");
  h.calls.length = 0;
  funnel.handleKeyUp(keyEv("KeyG"));
  assert.deepEqual(h.calls, [], "releases are not forwarded");
  press("KeyG", { shift: true });
  assert.deepEqual(h.calls, [], "Shift+G is not G");

  // The Controls rows go live (input-options-6 `retailActionStatus`).
  const sit = K.retailActionStatus(0x10000096, { funnelActions: funnel.actions });
  assert.equal(sit.status, "rebindable");
  assert.equal(sit.source, "funnel");
  assert.equal(sit.binding.code, "KeyG");
  const point = K.retailActionStatus(0x100000BD, { funnelActions: funnel.actions });
  assert.equal(point.status, "rebindable", "unbound but bindable");
  assert.equal(point.binding, null);

  off();
  assert.equal(funnel.actions.length, 0, "unbind all");
});

test("an unbound emote fires once the player binds it; a stale pkg/ or a throw is harmless", () => {
  const funnel = new InputFunnel();
  const h = fakeHandle();
  let handle = h;
  EK.installEmoteKeys(funnel, { getHandle: () => handle, cmdInterpOn: true, search: "?emoteKeys=on" });
  const tap = (code) => { funnel.handleKeyDown(keyEv(code)); funnel.handleKeyUp(keyEv(code)); };
  K.setBinding("0x100000BD", { code: "KeyZ" }); // Point
  try {
    tap("KeyZ");
    assert.deepEqual(h.calls, [[0x100000BD, true]]);
  } finally {
    K.clearBinding("0x100000BD");
  }
  handle = {}; // stale pkg/: no handleKeyAction export
  assert.doesNotThrow(() => tap("KeyG"));
  handle = null; // pre-login
  assert.doesNotThrow(() => tap("KeyG"));
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a);
  try {
    handle = { handleKeyAction() { throw new Error("cmd channel closed"); } };
    tap("KeyG");
  } finally {
    console.warn = warn;
  }
  assert.equal(funnel.stats.handlerErrors, 0, "the throw is caught in the handler");
  assert.ok(warned.some((a) => /\[emoteKeys\] Sitting/.test(String(a[0]))), JSON.stringify(warned));
});

// ── [6] static wiring ────────────────────────────────────────────────────
test("index.html installs the emote keys on the funnel with the handle and CMD_INTERP_ON", () => {
  const html = readFileSync(resolvePath(APP, "index.html"), "utf8");
  assert.match(html, /import \{ installEmoteKeys as __installEmoteKeys \} from "\.\/ui\/emote_keys\.js";/);
  const at = html.indexOf('__inputFunnel.bindRaw("index.gameplay", __gameplayKeyDown');
  assert.ok(at > 0);
  const end = html.indexOf("} else {", at);
  const block = html.slice(at, end);
  assert.match(block,
    /__gameplayUnbinds\.push\(__installEmoteKeys\(__inputFunnel, \{\s*getHandle: \(\) => handle,\s*cmdInterpOn: CMD_INTERP_ON,\s*\}\)\);/,
    "installed only under ?inputFunnelV2, retired per login");
  assert.ok(html.indexOf("const CMD_INTERP_ON") < at, "CMD_INTERP_ON is declared before the install");
});
