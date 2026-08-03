// tests/corpse_loot_snapshot.test.mjs — round-9 review, finding R9-2.
//
// `plugins/corpse-loot-bar.js` resolves the corpse's contents by calling
// `handle.playerInventory()` ONCE PER ITEM inside `resolveItemMeta`
// (corpse-loot-bar.js:63), plus once more for the owned-items filter in
// `refreshContents` (corpse-loot-bar.js:338) — and frees none of them.
//
// Every `playerInventory()` call mints a fresh array of wasm-bindgen boxes.
// They are FinalizationRegistry-backed, so this is not a permanent leak, but
// the JS wrapper is tiny while the Rust allocation is not: the GC gets no
// pressure signal and the wasm linear-memory high-water mark ratchets up
// (wasm memory never shrinks). Concretely: a 12-item corpse against a
// 100-item pack mints 13 x 100 = 1,300 boxes, and `refreshContents` re-runs
// on EVERY `playerInventoryChanged` — which is exactly what each Take emits,
// so looting the corpse item by item repeats the whole thing 12 more times.
//
// container-panel.js already fixed precisely this (its `takeInventorySnapshot`
// docstring spells the failure mode out); corpse-loot-bar is the copy that
// never got the fix. This suite pins BOTH panels to the same contract.
//
// CONTRACT
//   [1] one refresh/open => at most ONE playerInventory() call;
//   [2] every box that call handed out is freed before the call returns;
//   [3] the resolved item metas are PLAIN DATA — reading them after the
//       free must still work (a "fix" that frees the boxes but hands one
//       back as the meta would be use-after-free).
//
// NEGATIVE CONTROLS
//   * freeing only the `refreshContents` snapshot and leaving
//     `resolveItemMeta`'s per-item calls alive => [1] and [2] both fail.
//   * returning the wasm box itself as the meta => [3] fails.
//
// Run from apps/holtburger-web/:  node tests/corpse_loot_snapshot.test.mjs

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

/* ── a wasm-bindgen-shaped SessionHandle ──────────────────────────────── */

function makeHandle({ invSize, contents }) {
  const stats = { invCalls: 0, boxesMinted: 0, boxesFreed: 0, boxes: [] };
  const handle = {
    playerInventory() {
      stats.invCalls += 1;
      const out = [];
      for (let i = 0; i < invSize; i += 1) {
        // A box: primitive getters + free(). After free() the getters throw,
        // exactly like a wasm-bindgen wrapper whose ptr has been nulled.
        const box = {
          _freed: false,
          get guid() { return this._assert(), 0xA0000000 + i; },
          get name() { return this._assert(), `Owned ${i}`; },
          get iconId() { return this._assert(), 0x06000000 + i; },
          get stackSize() { return this._assert(), 1; },
          _assert() {
            if (this._freed) throw new Error("null pointer passed to rust (use-after-free)");
          },
          free() {
            if (this._freed) return;
            this._freed = true;
            stats.boxesFreed += 1;
          },
        };
        stats.boxesMinted += 1;
        stats.boxes.push(box);
        out.push(box);
      }
      return out;
    },
    getContainerContents() {
      return Uint32Array.from(contents);
    },
    getObjectIconId(g) {
      return 0x06005000 + (g & 0xFF);
    },
  };
  return { handle, stats };
}

function installWindow(handle) {
  globalThis.window = {
    __sessionHandle: handle,
    __pluginClient: { events: { on() {} } },
    liveScene3d: null,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({
      style: {}, dataset: {}, classList: { add() {}, remove() {} },
      appendChild() {}, addEventListener() {}, set textContent(_v) {}, get textContent() { return ""; },
    }),
    head: { appendChild() {} },
    body: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  };
}

/** Load an app plugin module into a Function scope, returning chosen locals. */
function loadPlugin(relPath, exposeNames, stubs) {
  const src = readFileSync(path.join(APP, relPath), "utf8");
  const body = spliceModule(src, { label: relPath, provided: [], stubs });
  const epilogue = `\nreturn { ${exposeNames.join(", ")} };\n`;
  // eslint-disable-next-line no-new-func
  return new Function(body + epilogue)();
}

// `takeInventorySnapshot` is NOT stubbed — the REAL implementation from
// plugins/inventory_helpers.js is threaded in through globalThis, so the
// free-every-box contract is exercised end to end rather than faked.
const helpers = await import(
  pathToFileURL(path.join(APP, "plugins", "inventory_helpers.js")).href
);
globalThis.__realTakeInventorySnapshot = helpers.takeInventorySnapshot;

const UI_STUBS = {
  setAcText: "(el, text) => { if (el) el.__text = text; }",
  fetchIconDataUrlShared: "() => Promise.resolve(null)",
  fetchIconDataUrl: "() => Promise.resolve(null)",
  takeInventorySnapshot: "globalThis.__realTakeInventorySnapshot",
};

// container-panel additionally pulls the drop-flag / ui-effect helpers.
// Explicit, non-permissive stubs (splice_module contract): each returns the
// value that keeps the render path on its ordinary branch, so nothing this
// suite asserts is decided by a stub.
const CONTAINER_STUBS = {
  ...UI_STUBS,
  clearPlaceholderGlyph: "(el) => { if (el) el.__glyph = null; }",
  DropItemFlags: "Object.freeze({ None: 0 })",
  isDropAccepted: "() => true",
  uiEffectIconsEnabled: "() => false",
  uiEffectIconsFor: "() => []",
  uiEffectTintCss: "() => null",
};

/* ── [A] corpse-loot-bar ──────────────────────────────────────────────── */

{
  const CONTENTS = [0xB0000001, 0xB0000002, 0xB0000003, 0xB0000004, 0xB0000005];
  const { handle, stats } = makeHandle({ invSize: 40, contents: CONTENTS });
  installWindow(handle);

  const mod = loadPlugin(
    "plugins/corpse-loot-bar.js",
    ["refreshContents", "state"],
    UI_STUBS,
  );
  mod.state.corpseGuid = 0xC0FFEE01;
  mod.refreshContents();

  check("[corpse-loot-bar] one refresh => at most ONE playerInventory() call", () => {
    assert.ok(
      stats.invCalls <= 1,
      `playerInventory() called ${stats.invCalls}x for a ${CONTENTS.length}-item corpse ` +
      `(1 filter snapshot + 1 per resolveItemMeta); expected <= 1`,
    );
  });

  check("[corpse-loot-bar] every wasm box handed out is freed", () => {
    assert.equal(
      stats.boxesFreed,
      stats.boxesMinted,
      `${stats.boxesMinted - stats.boxesFreed} of ${stats.boxesMinted} boxes leaked ` +
      `(wasm high-water mark ratchets; see container-panel.js takeInventorySnapshot)`,
    );
  });

  check("[corpse-loot-bar] resolved metas are plain data, readable after the free", () => {
    assert.equal(mod.state.items.length, CONTENTS.length);
    for (const it of mod.state.items) {
      assert.equal(typeof it.guid, "number");
      assert.equal(typeof it.name, "string");
      assert.equal(typeof it.iconId, "number");
      assert.ok(!("free" in it), "meta must not be a live wasm box");
    }
  });

  check("[corpse-loot-bar] items the player already owns stay filtered out", () => {
    // The owned-set filter (corpse-loot-bar.js:337-340) is the reason the
    // snapshot exists at all — it must survive the refactor.
    const { handle: h2, stats: s2 } = makeHandle({
      invSize: 3,
      // guids 0xA0000000..2 are what makeHandle's inventory reports as owned.
      contents: [0xA0000000, 0xA0000001, 0xB0000009],
    });
    installWindow(h2);
    const m2 = loadPlugin("plugins/corpse-loot-bar.js", ["refreshContents", "state"], UI_STUBS);
    m2.state.corpseGuid = 0xC0FFEE02;
    m2.refreshContents();
    assert.deepEqual(
      m2.state.items.map((i) => i.guid),
      [0xB0000009],
      "already-owned guids must be pruned from the strip",
    );
    assert.equal(s2.boxesFreed, s2.boxesMinted, "filter path must free too");
  });
}

/* ── [B] container-panel — the panel that already had the fix; pin it ─── */

{
  const CONTENTS = [0xD0000001, 0xD0000002, 0xD0000003];
  const { handle, stats } = makeHandle({ invSize: 25, contents: CONTENTS });
  installWindow(handle);

  const mod = loadPlugin(
    "plugins/container-panel.js",
    ["takeInventorySnapshot", "resolveItemMeta"],
    CONTAINER_STUBS,
  );

  const snap = mod.takeInventorySnapshot(window.__sessionHandle);
  const items = Array.from(CONTENTS).map((g) => mod.resolveItemMeta(g, snap.inv));
  snap.free();

  check("[container-panel] still takes exactly ONE snapshot for a whole render", () => {
    assert.equal(stats.invCalls, 1, `expected 1 playerInventory() call, got ${stats.invCalls}`);
  });
  check("[container-panel] snapshot.free() releases every box", () => {
    assert.equal(stats.boxesFreed, stats.boxesMinted);
  });
  check("[container-panel] resolveItemMeta returns plain data", () => {
    assert.equal(items.length, CONTENTS.length);
    for (const it of items) assert.ok(!("free" in it));
  });
}

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
