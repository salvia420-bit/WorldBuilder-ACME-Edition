// tests/corpse_loot_all_pacing.test.mjs — corpse "Loot all" sends ONE take at
// a time (2026-10-07).
//
// ACE's pickup is busy-guarded (Player_Inventory.cs
// HandleActionPutItemInContainer_Verify): a PutItemInContainer that lands while
// the previous pickup is still in its Start phase is refused with YoureTooBusy
// + InventoryServerSaveFailed. The old loop sent the next take every 700 ms
// regardless, so a slow pickup collided and the whole loot-all stopped.
//
// CONTRACT
//   [1] no second take while the first is unanswered (not even after 5 s);
//   [2] the next take goes out right after the echo (item left the corpse);
//   [3] a YoureTooBusy refusal retries the SAME item instead of stopping;
//   [4] any other refusal stops the loop with the old toast;
//   [5] an item that never answers is retried, then skipped, and the loop
//       still finishes the rest.
//
// Run from apps/holtburger-web/:  node tests/corpse_loot_all_pacing.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spliceModule } from "../harness/lib/splice_module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

/* ── fake clock ─────────────────────────────────────────────────────────── */
let nowMs = 1000;
let timerSeq = 0;
const timers = new Map();
globalThis.setTimeout = (fn, ms = 0) => {
  const id = ++timerSeq;
  timers.set(id, { at: nowMs + Math.max(0, ms), fn });
  return id;
};
globalThis.clearTimeout = (id) => { timers.delete(id); };
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
globalThis.requestAnimationFrame = () => 0;
Object.defineProperty(globalThis, "performance", {
  value: { now: () => nowMs }, configurable: true, writable: true,
});
function advance(ms) {
  const end = nowMs + ms;
  for (;;) {
    let next = null;
    for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
    if (!next) break;
    timers.delete(next[0]);
    nowMs = next[1].at;
    next[1].fn();
  }
  nowMs = end;
}

/* ── fake DOM (just enough for render()) ───────────────────────────────── */
function fakeEl() {
  return {
    style: {}, dataset: {}, children: [], parentNode: null, disabled: false, _text: "",
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { c.remove?.(); this.children.push(c); c.parentNode = this; return c; },
    insertBefore(c, ref) {
      c.remove?.();
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      c.parentNode = this;
      return c;
    },
    remove() {
      const p = this.parentNode;
      if (!p) return;
      const i = p.children.indexOf(this);
      if (i >= 0) p.children.splice(i, 1);
      this.parentNode = null;
    },
    get firstChild() { return this.children[0] || null; },
    get nextSibling() {
      const p = this.parentNode;
      if (!p) return null;
      return p.children[p.children.indexOf(this) + 1] || null;
    },
    querySelector() { return null; },
    addEventListener() {},
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
  };
}

/* ── wasm-ish session handle + world ───────────────────────────────────── */
const CORPSE = 0xC0FFEE01;
const ME = 0x50000001;
const A = 0xB0000001, B = 0xB0000002, C = 0xB0000003;
const NAMES = new Map([[A, "Pyreal"], [B, "Leather Cap"], [C, "Mana Stone"]]);
const contents = [A, B, C];
const owned = new Set();
const handle = {
  getContainerContents: (g) => (g >>> 0) === CORPSE ? Uint32Array.from(contents) : new Uint32Array(0),
  playerInventory: () => Array.from(owned, (g) => ({ guid: g, name: NAMES.get(g), iconId: 1, stackSize: 1, free() {} })),
  objectName: (g) => NAMES.get(g >>> 0),
  objectIntProperty: () => 0,
  objectDataIdProperty: () => 0,
  objectWcid: () => 1,
  getObjectIconId: () => 0x06001000,
};
const busHandlers = new Map();
const bus = {
  on: (n, f) => { if (!busHandlers.has(n)) busHandlers.set(n, []); busHandlers.get(n).push(f); },
  emit: (n, p) => { for (const f of busHandlers.get(n) || []) f(p); },
};
globalThis.window = {
  __sessionHandle: handle,
  __pluginClient: { events: bus },
  liveScene3d: null,
  addEventListener() {},
  removeEventListener() {},
  getLocalPlayerGuid: () => ME,
};
globalThis.document = {
  getElementById: () => null,
  createElement: () => fakeEl(),
  head: { appendChild() {} },
  body: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
};

/* ── the REAL pending ledger, the REAL snapshot + contained-meta helpers ── */
const helpers = await import(pathToFileURL(path.join(APP, "plugins", "inventory_helpers.js")).href);
const containedMeta = await import(pathToFileURL(path.join(APP, "plugins", "contained_item_meta.js")).href);
const ledger = helpers.createPendingLedger({ now: () => nowMs });
const sends = [];
const toasts = [];
globalThis.__ledger = ledger;
globalThis.__realTakeInventorySnapshot = helpers.takeInventorySnapshot;
globalThis.__realResolveContainedItemMeta = containedMeta.resolveContainedItemMeta;
// executeItemAction stand-in: what the real one does for a take — send the
// PutItemInContainer and file a pending "owned" expectation.
globalThis.__exec = (action, _s, opts) => {
  sends.push(action.guid >>> 0);
  ledger.add(action.guid, { op: "move", stub: opts?.stub || null, expect: (row) => !!row });
  return true;
};
globalThis.__toasts = toasts;

const STUBS = {
  setAcText: "(el, text) => { if (el) el.__text = text; }",
  fetchIconDataUrlShared: "() => Promise.resolve(null)",
  fetchItemIconDataUrl: "() => Promise.resolve(null)",
  getItemIconImmediate: "() => null",
  itemIconKey: "() => 'k'",
  attachWindowPosition: "() => null",
  makeTitlebar: "() => null",
  uiEffectBadgesEnabled: "() => false",
  uiEffectIconsFor: "() => []",
  uiEffectTintCss: "() => null",
  takeInventorySnapshot: "globalThis.__realTakeInventorySnapshot",
  decideItemDrop: "() => ({ op: 'reject' })",
  DROP_TARGET: "Object.freeze({})",
  MAIN_PACK_KEY: "0",
  PACKS_KEY: "'packs'",
  resolveContainedItemMeta: "globalThis.__realResolveContainedItemMeta",
  beginItemDrag: "() => {}",
  registerDropZone: "() => {}",
  resolveDropAction: "() => null",
  executeItemAction: "globalThis.__exec",
  pendingOps: "globalThis.__ledger",
  showItemTooltip: "() => {}",
  hideItemTooltip: "() => {}",
  showItemToast: "(m) => globalThis.__toasts.push(m)",
  localPlayerGuid: "() => 0x50000001",
};
const src = readFileSync(path.join(APP, "plugins", "corpse-loot-bar.js"), "utf8");
const body = spliceModule(src, { label: "corpse-loot-bar.js", provided: [], stubs: STUBS });
// eslint-disable-next-line no-new-func
const mod = new Function(body + `
return {
  state, refreshContents, startLootAll, onLootAllLedger,
  setOverlay: (o) => { overlayEl = o; },
  lootAllState: () => lootAll,
};`)();

// The window is built by buildOverlay() in the app; here a fake with the
// fields render() touches, and the ledger hook buildOverlay() installs.
const overlay = fakeEl();
overlay.dataset.open = "1";
Object.assign(overlay, {
  _titleEl: fakeEl(), _stripEl: fakeEl(), _cells: new Map(),
  _countEl: fakeEl(), _takeBtn: fakeEl(), _allBtn: fakeEl(),
});
mod.setOverlay(overlay);
ledger.onChange((evt) => mod.onLootAllLedger(evt));
mod.state.corpseGuid = CORPSE;
mod.refreshContents();

/** The server moved `g` into our pack: ACE's echo + the ledger sweep. */
function serverTakes(g) {
  owned.add(g);
  ledger.bump();
  ledger.sweep(new Map(Array.from(owned, (x) => [x, { guid: x }])));
  bus.emit("playerInventoryChanged", {});
}
/** ACE refused `g`: optional WeenieError first, then InventoryServerSaveFailed. */
function serverRefuses(g, { busy }) {
  if (busy) bus.emit("kind:13", { u32Payload: 0x001d });
  ledger.fail(g);
}

check("strip lists the three corpse items", () => {
  assert.deepEqual(mod.state.items.map((i) => i.guid >>> 0), [A, B, C]);
});

mod.startLootAll();
check("[1] loot all sends exactly one take", () => {
  assert.deepEqual(sends, [A]);
});
advance(5000);
check("[1] no second take while the first is unanswered (5 s, no echo)", () => {
  assert.deepEqual(sends, [A], `sent ${sends.map((g) => g.toString(16))}`);
});

serverTakes(A);
advance(149);
check("[2] the next take waits for the echo…", () => {
  assert.deepEqual(sends, [A]);
});
advance(1);
check("[2] …and goes out right after it", () => {
  assert.deepEqual(sends, [A, B]);
});

advance(300);
serverRefuses(B, { busy: true });
check("[3] a YoureTooBusy refusal does not stop loot all", () => {
  assert.ok(mod.lootAllState(), "loot all still running");
  assert.equal(toasts.length, 0, `toasted: ${toasts.join(" | ")}`);
});
advance(900);
check("[3] …the same item is retried after the player is free", () => {
  assert.deepEqual(sends, [A, B, B]);
});

advance(2000);
serverRefuses(B, { busy: false });
check("[4] any other refusal stops loot all with the old toast", () => {
  assert.equal(mod.lootAllState(), null);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /Loot all stopped — the Leather Cap could not be taken/);
});

// [5] restart: B never answers at all (lost packet / stuck server) — it is
// retried until LOOT_ALL_MAX_TRIES, skipped, and C is still taken.
toasts.length = 0;
sends.length = 0;
mod.startLootAll();
for (let i = 0; i < 3; i += 1) {
  advance(6500);
  ledger.sweep(new Map()); // item_drag.js sweeps on a 1.5 s timer; TTL is 6 s
  advance(200);
}
check("[5] an unanswered item is retried up to the cap, then skipped", () => {
  assert.deepEqual(sends.slice(0, 3), [B, B, B]);
  assert.equal(sends[3], C, `sends: ${sends.map((g) => g.toString(16))}`);
});
serverTakes(C);
advance(200);
check("[5] loot all finishes with a skipped-item note once only B is left", () => {
  assert.equal(mod.lootAllState(), null);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /1 item could not be taken/);
});

console.log(`\ncorpse_loot_all_pacing: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
