// Wave 3.A (2026-05-28) — hotbar fire-wiring smoke test.
//
// Run with:
//   cd /home/wbterminal/WorldBuilder-ACME-Edition && \
//     node external/holtburger/apps/holtburger-web/test_hotbar_fire.mjs
//
// Validates the pure decideFireAction() decision helper that
// fireSlot() consumes:
//
//   - empty slot                          → kind: "none"
//   - item slot                           → kind: "useItem", itemGuid
//   - self-targeted spell                 → kind: "castSelf", spellId
//   - targeted spell + soft target        → kind: "castOnTarget"
//   - targeted spell, no soft target      → kind: "needTarget"
//
// Pattern matches test_status_indicators.mjs (Wave 1.F closing summary)
// for parity with sibling test files.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── jsdom-lite shim ──────────────────────────────────────────────
// hotbar.js touches document.head/createElement (for ensureStyles) on
// import — installing the shim before dynamic-import keeps that side
// effect harmless. We don't drive mount() in this test; we only
// exercise the exported pure helper decideFireAction().
function installDomShim() {
  if (typeof globalThis.document !== "undefined") return;
  const elementProto = {
    appendChild() { return null; },
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    style: undefined,
  };
  function mkEl() {
    return Object.assign(Object.create(elementProto), {
      style: {},
      dataset: {},
      attrs: {},
      classList: {
        add() {}, remove() {}, contains() { return false; }, toggle() { return false; },
      },
    });
  }
  globalThis.document = {
    head: mkEl(),
    body: mkEl(),
    createElement: () => mkEl(),
    getElementById: () => null,
  };
  globalThis.window = globalThis;
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};
  globalThis.setTimeout = () => 0;
  globalThis.clearTimeout = () => {};
  globalThis.localStorage = {
    _store: new Map(),
    getItem(k) { return this._store.has(k) ? this._store.get(k) : null; },
    setItem(k, v) { this._store.set(k, String(v)); },
    removeItem(k) { this._store.delete(k); },
  };
  globalThis.fetch = () => Promise.resolve({
    ok: false, json: () => Promise.resolve({}), text: () => Promise.resolve(""),
  });
}
installDomShim();

// hotbar.js imports keymap.js + ac_layout.js; the latter may try to
// fetch — the shim returns a not-ok response so the load completes.
const url = pathToFileURL(
  resolvePath(__dirname, "plugins/hotbar.js")
).href;
const { decideFireAction, manifest } = await import(url);

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
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}: expected ${e}, got ${a}`);
  }
}

console.log("===========================================================");
console.log("Wave 3.A — hotbar fire-wiring smoke test");
console.log("===========================================================");

console.log("\n[1] Module surface");

check("exports manifest with id=hotbar", () => {
  if (manifest.id !== "hotbar") throw new Error(`bad manifest.id: ${manifest.id}`);
});

check("exports decideFireAction()", () => {
  if (typeof decideFireAction !== "function") {
    throw new Error("decideFireAction not exported");
  }
});

console.log("\n[2] decideFireAction — empty / unbound slots");

check("null binding → kind=none", () => {
  assertEq(
    decideFireAction(null, { isSelfTargeted: true, softTargetGuid: 0 }),
    { kind: "none" },
    "null binding",
  );
});

check("undefined binding → kind=none", () => {
  assertEq(
    decideFireAction(undefined, { isSelfTargeted: true, softTargetGuid: 0 }),
    { kind: "none" },
    "undefined binding",
  );
});

check("empty object binding → kind=none", () => {
  assertEq(
    decideFireAction({}, { isSelfTargeted: true, softTargetGuid: 0 }),
    { kind: "none" },
    "empty object",
  );
});

console.log("\n[3] decideFireAction — item slots");

check("itemGuid binding → useItem regardless of target", () => {
  assertEq(
    decideFireAction({ itemGuid: 0x12345678 }, { isSelfTargeted: false, softTargetGuid: 0 }),
    { kind: "useItem", itemGuid: 0x12345678 },
    "item useItem (no target)",
  );
});

check("itemGuid binding coerces to u32", () => {
  // wasm-bindgen-friendly: u32 right-shift normalises negative-as-int values.
  // Pre-coerce sanity: 0x80000000 should round-trip cleanly through `>>> 0`.
  assertEq(
    decideFireAction({ itemGuid: 0x80000000 }, { isSelfTargeted: true, softTargetGuid: 0 }),
    { kind: "useItem", itemGuid: 0x80000000 >>> 0 },
    "item u32 coercion",
  );
});

check("itemGuid wins over spellId when both present (item branch first)", () => {
  // Slots are written as { itemGuid } OR { spellId } in production drag-
  // drop; this asserts the helper's predictable preference order in the
  // unlikely event a hand-edited localStorage row carries both keys.
  assertEq(
    decideFireAction(
      { itemGuid: 0xAABBCCDD, spellId: 0x1234 },
      { isSelfTargeted: true, softTargetGuid: 0 },
    ),
    { kind: "useItem", itemGuid: 0xAABBCCDD },
    "item-wins-over-spell",
  );
});

console.log("\n[4] decideFireAction — spell slots");

check("self-targeted spell → castSelf, ignores soft target", () => {
  assertEq(
    decideFireAction(
      { spellId: 0x1000 },
      { isSelfTargeted: true, softTargetGuid: 0xDEADBEEF },
    ),
    { kind: "castSelf", spellId: 0x1000 },
    "self-targeted ignores soft target",
  );
});

check("targeted spell + soft target → castOnTarget", () => {
  assertEq(
    decideFireAction(
      { spellId: 0x2000 },
      { isSelfTargeted: false, softTargetGuid: 0x50000123 },
    ),
    { kind: "castOnTarget", spellId: 0x2000, targetGuid: 0x50000123 },
    "targeted + selection",
  );
});

check("targeted spell, no soft target → needTarget", () => {
  assertEq(
    decideFireAction(
      { spellId: 0x2000 },
      { isSelfTargeted: false, softTargetGuid: 0 },
    ),
    { kind: "needTarget", spellId: 0x2000 },
    "targeted no selection",
  );
});

check("targeted spell, undefined soft target → needTarget", () => {
  assertEq(
    decideFireAction(
      { spellId: 0x2000 },
      { isSelfTargeted: false, softTargetGuid: undefined },
    ),
    { kind: "needTarget", spellId: 0x2000 },
    "targeted undefined selection",
  );
});

check("targeted spell, null soft target → needTarget", () => {
  assertEq(
    decideFireAction(
      { spellId: 0x2000 },
      { isSelfTargeted: false, softTargetGuid: null },
    ),
    { kind: "needTarget", spellId: 0x2000 },
    "targeted null selection",
  );
});

check("self-target default (table unloaded) → castSelf", () => {
  // Production fall-through: when handle.getSpellRecord throws or
  // returns null, fireSlot keeps isSelfTargeted=true. Verifies that
  // fallback yields a self-cast rather than blocking on a phantom
  // target.
  assertEq(
    decideFireAction(
      { spellId: 0x3000 },
      { isSelfTargeted: true, softTargetGuid: 0 },
    ),
    { kind: "castSelf", spellId: 0x3000 },
    "default-true fallback",
  );
});

console.log("\n[5] decideFireAction — target GUID coercion");

check("soft-target GUID coerced to u32 via >>> 0", () => {
  // Selection in entity-manager is unsigned-int territory; assert the
  // helper passes through as u32 (matches the wire shape ACE expects).
  assertEq(
    decideFireAction(
      { spellId: 0x4000 },
      { isSelfTargeted: false, softTargetGuid: 0x90000001 },
    ),
    { kind: "castOnTarget", spellId: 0x4000, targetGuid: 0x90000001 >>> 0 },
    "high-bit target GUID",
  );
});

console.log("\n===========================================================");
console.log(`PASS: ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.log(`FAIL: ${failed}`);
  process.exit(1);
}
