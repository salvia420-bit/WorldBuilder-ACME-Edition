// tests/rynth_vt_page_seams.test.mjs — the two page seams of the VTank layer
// (W1-8, PLAN §3.10 + §5 rows plugins/inventory.js, plugins/vendor-ui.js).
//
//   I1  plugins/inventory.js publishes the inventory panel's selection —
//       `window.__inventory.selectedGuid` + one `hb-inventory-selection`
//       window event per change — which RynthWebHost.GetSelectedItemId reads
//       for the VT Items/Consumables "Add selected" buttons (it was private to
//       the view closure, inventory.js `let selectedGuid`).
//   V1  plugins/vendor-ui.js `onHidden` dispatches `hb-vendor-closed`
//       {detail:{guid}} BEFORE it clears the vendor state; host_signals turns
//       it into a `vendorClose` signal (ACE has no vendor-close packet).
//
// Source-level assertions plus BEHAVIOUR: the real function bodies are cut out
// of the plugin sources and run against a fake window (the full plugins need a
// DOM, three.js and icon decoding — tests/inventory_dnd_dom.test.mjs mounts
// them; it is on this package's must-stay-green list).
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_page_seams.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const INV_SRC = readFileSync(path.join(APP, "plugins", "inventory.js"), "utf8");
const VENDOR_SRC = readFileSync(path.join(APP, "plugins", "vendor-ui.js"), "utf8");
const { createHostSignals } = await import("../rynth/vt/host_signals.js");
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

/** Cut `function <name>(…) { … }` out of a source file: brace matching that
 *  skips string literals and comments (enough for these plain functions). */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let i = src.indexOf(")", start);
  i = src.indexOf("{", i);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (j++; j < src.length && src[j] !== ch; j++) if (src[j] === "\\") j++;
      continue;
    }
    if (ch === "/" && src[j + 1] === "/") {
      j = src.indexOf("\n", j);
      if (j < 0) return null;
      continue;
    }
    if (ch === "/" && src[j + 1] === "*") {
      j = src.indexOf("*/", j + 2) + 1;
      if (j <= 0) return null;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return src.slice(start, j + 1);
  }
  return null;
}

class FakeCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail ?? null;
  }
}
function fakeWindow() {
  const listeners = new Map();
  const events = [];
  return {
    events,
    addEventListener(t, fn) { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(fn); },
    removeEventListener(t, fn) { listeners.get(t)?.delete(fn); },
    dispatchEvent(ev) {
      events.push(ev);
      for (const fn of [...(listeners.get(ev.type) || [])]) fn(ev);
      return true;
    },
  };
}

// ── I1 inventory selection ─────────────────────────────────────────────
const SET_SRC = extractFunction(INV_SRC, "setSelectedGuid");
const PUB_SRC = extractFunction(INV_SRC, "publishSelection");

function loadSelection(win) {
  const cells = new Map([
    [1, { guid: 0x7100, dataset: {}, cls: new Set(), classList: null }],
    [2, { guid: 0x7200, dataset: {}, cls: new Set(), classList: null }],
    [3, { guid: 0, dataset: { empty: "1" }, cls: new Set(), classList: null }],
  ]);
  for (const c of cells.values()) {
    c.classList = { toggle: (k, on) => (on ? c.cls.add(k) : c.cls.delete(k)) };
  }
  const make = new Function(
    "window",
    "CustomEvent",
    "cellCache",
    "cellGuid",
    `let selectedGuid = 0;\n${SET_SRC}\n${PUB_SRC}\nreturn { setSelectedGuid, publishSelection, get selectedGuid() { return selectedGuid; } };`
  );
  return { api: make(win, FakeCustomEvent, cells, (c) => c.guid), cells };
}

await check("I1 source: the namespace seeds selectedGuid; setSelectedGuid publishes; unmount clears", () => {
  assert.ok(SET_SRC && PUB_SRC, "setSelectedGuid + publishSelection found");
  assert.match(SET_SRC, /publishSelection\(selectedGuid\)/);
  assert.match(PUB_SRC, /window\.__inventory\.selectedGuid = guid/);
  assert.match(PUB_SRC, /window\.dispatchEvent\(new CustomEvent\("hb-inventory-selection", \{ detail: \{ guid \} \}\)\)/);
  assert.match(PUB_SRC, /try \{[\s\S]*\} catch/, "guarded");
  assert.match(INV_SRC, /if \(typeof window\.__inventory\.selectedGuid !== "number"\) window\.__inventory\.selectedGuid = 0;/);
  assert.match(INV_SRC, /return \(\) => \{\s*window\.removeEventListener\("keydown", onKey\);\s*publishSelection\(0\);/, "the view's cleanup clears it");
  // the two click paths still select through setSelectedGuid (onCellClick / onCellContext)
  assert.ok((INV_SRC.match(/setSelectedGuid\(g\);/g) || []).length >= 2);
});

await check("I1 behaviour: selection mirrored to window.__inventory.selectedGuid + one event per change", () => {
  const win = fakeWindow();
  win.__inventory = { armedGuid: 0, selectedGuid: 0 };
  const { api, cells } = loadSelection(win);
  api.setSelectedGuid(0x7100);
  assert.equal(win.__inventory.selectedGuid, 0x7100);
  assert.equal(win.events.length, 1);
  assert.equal(win.events[0].type, "hb-inventory-selection");
  assert.deepEqual(win.events[0].detail, { guid: 0x7100 });
  assert.ok(cells.get(1).cls.has("is-selected") && !cells.get(2).cls.has("is-selected"), "highlight unchanged");
  api.setSelectedGuid(0x7100);
  assert.equal(win.events.length, 1, "same selection: no event");
  api.setSelectedGuid(0x7200);
  api.setSelectedGuid(0);
  assert.deepEqual(win.events.map((e) => e.detail.guid), [0x7100, 0x7200, 0]);
  assert.equal(win.__inventory.selectedGuid, 0);
  assert.equal(win.__inventory.armedGuid, 0, "other namespace members untouched");
});

await check("I1 behaviour: a missing namespace is created; a throwing dispatch never breaks the click path", () => {
  const win = fakeWindow();
  const { api } = loadSelection(win);
  api.setSelectedGuid(0x7100);
  assert.deepEqual(win.__inventory, { armedGuid: 0, selectedGuid: 0x7100 });
  const bad = { dispatchEvent() { throw new Error("no events here"); }, __inventory: { armedGuid: 0, selectedGuid: 0 } };
  const { api: api2, cells } = loadSelection(bad);
  assert.doesNotThrow(() => api2.setSelectedGuid(0x7200));
  assert.equal(api2.selectedGuid, 0x7200);
  assert.ok(cells.get(2).cls.has("is-selected"));
});

await check("I1 end to end: RynthWebHost.GetSelectedItemId reads the published selection, else the world selection", () => {
  const win = fakeWindow();
  win.__inventory = { armedGuid: 0, selectedGuid: 0 };
  const { api } = loadSelection(win);
  const host = new RynthWebHost({}, { entityMap: new Map(), noEventTap: true });
  const hadInv = "__inventory" in globalThis;
  globalThis.__inventory = win.__inventory;
  globalThis.liveScene3d = { entityManager: { getSelectedTarget: () => 0x80001234, setSelectedTarget() {} } };
  try {
    assert.equal(host.GetSelectedItemId(), 0x80001234, "nothing selected in the pack -> world selection");
    api.setSelectedGuid(0x7100);
    assert.equal(host.has("GetSelectedItemId"), true);
    assert.equal(host.GetSelectedItemId(), 0x7100);
    api.setSelectedGuid(0);
    assert.equal(host.GetSelectedItemId(), 0x80001234);
  } finally {
    delete globalThis.liveScene3d;
    if (!hadInv) delete globalThis.__inventory;
  }
});

// ── V1 vendor close ────────────────────────────────────────────────────
const HIDDEN_SRC = extractFunction(VENDOR_SRC, "onHidden");

function loadOnHidden(win, state, CustomEventImpl = FakeCustomEvent) {
  let stopped = 0;
  const make = new Function("window", "CustomEvent", "state", "stopVendorRangeWatchdog", `${HIDDEN_SRC}\nreturn onHidden;`);
  const onHidden = make(win, CustomEventImpl, state, () => { stopped++; });
  return { onHidden, stopped: () => stopped };
}
const vendorState = () => ({
  vendorState: { vendorGuid: 0x80000100, vendorName: "Vendor Bob", items: [] },
  buyQueue: [{ itemGuid: 1, amount: 1 }],
  sellQueue: [{ itemGuid: 2 }],
  sellSplits: [{ itemGuid: 3 }],
  selectedItemGuid: 4,
});

await check("V1 source: onHidden dispatches hb-vendor-closed {guid} first (guarded), and the window's onHide calls onHidden", () => {
  assert.ok(HIDDEN_SRC, "onHidden found");
  const i = HIDDEN_SRC.indexOf("hb-vendor-closed");
  assert.ok(i > 0 && i < HIDDEN_SRC.indexOf("state.buyQueue = []"), "before the state is cleared");
  assert.match(HIDDEN_SRC, /window\.dispatchEvent\(new CustomEvent\("hb-vendor-closed", \{\s*detail: \{ guid: \(state\.vendorState\?\.vendorGuid >>> 0\) \|\| 0 \},\s*\}\)\)/);
  assert.match(HIDDEN_SRC, /try \{[\s\S]*hb-vendor-closed[\s\S]*\} catch/);
  assert.match(VENDOR_SRC, /onHide: \(\) => onHidden\(\)/);
});

await check("V1 behaviour: the event carries the vendor guid while the state is still intact; then queues clear as before", () => {
  const win = fakeWindow();
  const state = vendorState();
  let queueAtDispatch = null;
  win.addEventListener("hb-vendor-closed", () => { queueAtDispatch = state.buyQueue.length; });
  const { onHidden, stopped } = loadOnHidden(win, state);
  onHidden();
  assert.equal(win.events.length, 1);
  assert.equal(win.events[0].type, "hb-vendor-closed");
  assert.deepEqual(win.events[0].detail, { guid: 0x80000100 });
  assert.equal(queueAtDispatch, 1, "dispatched before the queues were dropped");
  assert.deepEqual([state.buyQueue, state.sellQueue, state.sellSplits, state.selectedItemGuid], [[], [], [], null]);
  assert.equal(stopped(), 1, "range watchdog still stopped");
});

await check("V1 behaviour: no vendor state -> guid 0; a throwing dispatch / missing CustomEvent never breaks the close", () => {
  const win = fakeWindow();
  const st = { ...vendorState(), vendorState: null };
  loadOnHidden(win, st).onHidden();
  assert.deepEqual(win.events[0].detail, { guid: 0 });
  const bad = { dispatchEvent() { throw new Error("x"); } };
  const st2 = vendorState();
  const r = loadOnHidden(bad, st2);
  assert.doesNotThrow(() => r.onHidden());
  assert.deepEqual(st2.buyQueue, []);
  assert.equal(r.stopped(), 1);
  const st3 = vendorState();
  const r3 = loadOnHidden(fakeWindow(), st3, null); // `new CustomEvent` throws
  assert.doesNotThrow(() => r3.onHidden());
  assert.deepEqual(st3.sellQueue, []);
});

await check("V1 end to end: the vendor-ui close becomes a host_signals vendorClose {reason:'window'}", () => {
  const win = fakeWindow();
  const handlers = [];
  const host = { onEvent: (fn) => handlers.push(fn), GetPlayerId: () => 0x50000001, TryGetObjectDistance: () => 2 };
  const s = createHostSignals(host, { win, log: () => {} });
  const got = [];
  s.on("*", (x) => got.push(x));
  for (const fn of handlers) fn({ kind: 12, u32: 0x80000100, u32b: 10, text: "Vendor Bob" });
  loadOnHidden(win, vendorState()).onHidden();
  assert.deepEqual(got, [
    { type: "vendorOpen", guid: 0x80000100, name: "Vendor Bob" },
    { type: "vendorClose", guid: 0x80000100, reason: "window" },
  ]);
  s.dispose();
});

console.log(fail === 0 ? `rynth_vt_page_seams: all ${pass} checks passed` : `rynth_vt_page_seams: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
