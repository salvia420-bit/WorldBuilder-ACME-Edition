// tests/dye_preview_dragover_throttle.test.mjs — round-9 review, finding R9-3.
//
// `plugins/dye-preview.js` mount()s a `hb:inventory-drag-over` listener whose
// first act is a debounce gate:
//
//     const now = performance.now();
//     if (now - state.lastShownAt < state.debounceMs) return;   // OLD
//
// `state.lastShownAt` is stamped in exactly one place — the TAIL of
// `showTooltipFor`, i.e. only when a tooltip actually renders
// (dye-preview.js:381). On the overwhelmingly common path (dragging anything
// that is not a dye pot, or over anything that is not dyeable) no tooltip
// renders, `lastShownAt` never moves, and the gate never engages.
//
// inventory.js dispatches that event from its `dragover` handler with the
// explicit note "The event fires continuously during drag; subscribers
// debounce as needed" (inventory.js:2806-2809). So the un-throttled body ran
// on every pointer move, and its body did TWO separate `handle
// .playerInventory()` calls (one per guid) whose wasm-bindgen boxes were
// never freed. A 100-item pack, a two-second drag at ~60 Hz: ~24,000 boxes
// on a path that renders nothing.
//
// CONTRACT
//   [1] N drag-over events inside one debounce window do at most ONE
//       evaluation, even when NO tooltip is shown;
//   [2] one evaluation resolves BOTH guids from ONE playerInventory()
//       snapshot, and frees every box in it;
//   [3] after the window elapses, evaluation resumes (the gate throttles,
//       it does not latch).
//
// NEGATIVE CONTROLS
//   * stamping the eval clock only on the SHOWN path (the original bug) =>
//     [1] fails: every event evaluates.
//   * a gate that latches after the first event (e.g. a plain boolean) =>
//     [3] fails.
//   * freeing only one of the two lookups => [2] fails.
//
// Run from apps/holtburger-web/:
//   node tests/dye_preview_dragover_throttle.test.mjs

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

/* ── fixtures ─────────────────────────────────────────────────────────── */

const DRAGGED_GUID = "2684354561"; // a plain (non-dye-pot) item
const HOVERED_GUID = "2684354562";

const stats = { invCalls: 0, minted: 0, freed: 0 };

function makeBox(i, guid) {
  let freed = false;
  const assertLive = () => {
    if (freed) throw new Error("null pointer passed to rust (use-after-free)");
  };
  stats.minted += 1;
  return {
    get guid() { return assertLive(), guid; },
    get wcid() { return assertLive(), 8000 + i; },
    get name() { return assertLive(), `Item ${i}`; },
    get itemType() { return assertLive(), 0x00000004; },
    get equipMask() { return assertLive(), 0; },
    get clothingBaseId() { return assertLive(), 0; },
    get setupId() { return assertLive(), 0; },
    get modelId() { return assertLive(), 0; },
    free() { if (!freed) { freed = true; stats.freed += 1; } },
  };
}

const handle = {
  playerInventory() {
    stats.invCalls += 1;
    const out = [];
    for (let i = 0; i < 60; i += 1) out.push(makeBox(i, String(0xA0000000 + i)));
    out.push(makeBox(60, DRAGGED_GUID));
    out.push(makeBox(61, HOVERED_GUID));
    return out;
  },
};

/* ── a browser surface just big enough for mount() ────────────────────── */

const listeners = new Map();
let fakeNow = 1000;

globalThis.performance = { now: () => fakeNow };
globalThis.window = {
  __sessionHandle: handle,
  __pluginClient: null,
  addEventListener(name, fn) {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(fn);
  },
  removeEventListener(name, fn) {
    const arr = listeners.get(name) ?? [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  },
};
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, dataset: {}, appendChild() {}, addEventListener() {} }),
  head: { appendChild() {} },
  body: { appendChild() {} },
};
// mount() eagerly warms the dye-recipe catalog; keep it off the network and
// make it resolve to an EMPTY catalog, i.e. "this item is not a dye pot" —
// exactly the path whose debounce was broken.
globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({ dyePots: {} }) });

/* ── load the plugin ──────────────────────────────────────────────────── */

const helpers = await import(
  pathToFileURL(path.join(APP, "plugins", "inventory_helpers.js")).href
);
globalThis.__realTakeInventorySnapshot = helpers.takeInventorySnapshot;

const src = readFileSync(path.join(APP, "plugins", "dye-preview.js"), "utf8");
const body = spliceModule(src, {
  label: "plugins/dye-preview.js",
  provided: [],
  stubs: {
    // Not reachable on the non-dye-pot path this suite drives; explicit
    // throwing stubs so a future change that DOES reach them fails loudly
    // instead of being silently decided by the stub.
    composeDyePreview: "() => { throw new Error('composeDyePreview must not be reached'); }",
    resolveDyeTriples: "() => { throw new Error('resolveDyeTriples must not be reached'); }",
    DyeViewport: "class { constructor() { throw new Error('DyeViewport must not be reached'); } }",
    // The REAL snapshot helper, threaded in (not faked).
    takeInventorySnapshot: "globalThis.__realTakeInventorySnapshot",
  },
});
// eslint-disable-next-line no-new-func
const mod = new Function(body + "\nreturn { mount, getDyePreviewPluginSnapshot };\n")();

const dispose = mod.mount({});
await new Promise((r) => setTimeout(r, 0)); // let the catalog warm resolve
const onDragOver = (listeners.get("hb:inventory-drag-over") ?? [])[0];

async function fireDragOver() {
  await onDragOver({
    detail: {
      draggedGuid: DRAGGED_GUID,
      hoveredGuid: HOVERED_GUID,
      clientX: 10,
      clientY: 10,
      shiftKey: false,
    },
  });
}

/* ── [1] a burst inside one debounce window evaluates once ────────────── */

const DEBOUNCE_MS = mod.getDyePreviewPluginSnapshot().debounceMs;
assert.ok(DEBOUNCE_MS > 0, "debounceMs must be a positive window");

const before = stats.invCalls;
for (let i = 0; i < 20; i += 1) {
  fakeNow += 1; // 20 events across ~20ms, well inside the 60ms window
  await fireDragOver();
}
const burstCalls = stats.invCalls - before;

check("20 drag-over events in one debounce window => <= 1 inventory read", () => {
  assert.ok(
    burstCalls <= 1,
    `playerInventory() called ${burstCalls}x for 20 dragover events that render ` +
    `nothing (debounce clock is only stamped on the SHOWN path)`,
  );
});

check("every box from the drag-over lookup is freed", () => {
  assert.equal(
    stats.freed,
    stats.minted,
    `${stats.minted - stats.freed} of ${stats.minted} InventoryItem boxes leaked ` +
    `on the drag-over path`,
  );
});

/* ── [3] the gate throttles; it does not latch ────────────────────────── */

const midCalls = stats.invCalls;
fakeNow += DEBOUNCE_MS + 5;
await fireDragOver();

check("NEGATIVE CONTROL: after the window elapses, evaluation resumes", () => {
  assert.equal(
    stats.invCalls - midCalls,
    1,
    "the debounce must throttle, not latch — a boolean 'already ran' flag fails here",
  );
});

check("boxes from the second window are freed too", () => {
  assert.equal(stats.freed, stats.minted);
});

/* ── teardown ─────────────────────────────────────────────────────────── */

check("disposer unregisters both drag listeners", () => {
  dispose();
  assert.equal((listeners.get("hb:inventory-drag-over") ?? []).length, 0);
  assert.equal((listeners.get("hb:inventory-drag-end") ?? []).length, 0);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
