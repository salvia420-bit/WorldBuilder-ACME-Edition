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
//   - item slot                           → kind: "activateItem", itemGuid
//                                           (items-3, 2026-10-08: retail
//                                           ItemHolder::UseObject, not a bare Use)
//   - self-targeted spell                 → kind: "castSelf", spellId
//   - targeted spell + soft target        → kind: "castOnTarget"
//   - targeted spell, no soft target      → kind: "needTarget"
//   - formula-untargeted spell (ring)     → kind: "castSelf" (spellcast-2)
//
// Pattern matches test_status_indicators.mjs (Wave 1.F closing summary)
// for parity with sibling test files.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";

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
    // HUD overhaul 2026-10-05: hotbar.js now imports target-bar.js →
    // ui/ac_font.js, which subscribes to hb-hud-scale-changed / resize at
    // module load.
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
  };
  globalThis.window = globalThis;
  if (typeof globalThis.addEventListener !== "function") globalThis.addEventListener = () => {};
  if (typeof globalThis.removeEventListener !== "function") globalThis.removeEventListener = () => {};
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
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
const { decideFireAction, resolveArmedItemCast, spellNeedsNoSelection, manifest } = await import(url);
const { castSpellViaHandle } = await import(pathToFileURL(resolvePath(__dirname, "ui/ac_cast_spell.js")).href);

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

check("itemGuid binding → activateItem regardless of target", () => {
  assertEq(
    decideFireAction({ itemGuid: 0x12345678 }, { isSelfTargeted: false, softTargetGuid: 0 }),
    { kind: "activateItem", itemGuid: 0x12345678 },
    "item activateItem (no target)",
  );
});

check("itemGuid binding coerces to u32", () => {
  // wasm-bindgen-friendly: u32 right-shift normalises negative-as-int values.
  // Pre-coerce sanity: 0x80000000 should round-trip cleanly through `>>> 0`.
  assertEq(
    decideFireAction({ itemGuid: 0x80000000 }, { isSelfTargeted: true, softTargetGuid: 0 }),
    { kind: "activateItem", itemGuid: 0x80000000 >>> 0 },
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
    { kind: "activateItem", itemGuid: 0xAABBCCDD },
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

console.log("\n[6] spellcast-1 — armed spell on an item shortcut (click-to-cast only)");

check("clickToCast off (retail default): an item press is never a cast", () => {
  assertEq(resolveArmedItemCast({ itemGuid: 0x5000ABCD }, 27, false), null, "flag off");
});

check("clickToCast on: the armed spell AT the item, spell first / target second", () => {
  assertEq(resolveArmedItemCast({ itemGuid: 0x5000ABCD }, 27, true), { spellId: 27, targetGuid: 0x5000ABCD }, "flag on");
});

check("no armed spell, or a spell binding → no bridge cast", () => {
  assertEq(resolveArmedItemCast({ itemGuid: 0x5000ABCD }, 0, true), null, "nothing armed");
  assertEq(resolveArmedItemCast({ spellId: 5 }, 27, true), null, "spell binding");
});

check("the dispatch reaches the wasm as castTargetedSpell(TARGET, SPELL)", () => {
  // The old inline sender called handle.castTargetedSpell(spell, item)
  // against the wasm's (target_guid, spell_id) signature (lib.rs).
  const calls = [];
  const prevClient = globalThis.__pluginClient;
  const prevHandle = globalThis.__sessionHandle;
  delete globalThis.__pluginClient;
  globalThis.__sessionHandle = { castTargetedSpell: (...a) => calls.push(a) };
  try {
    if (castSpellViaHandle(27, 0x5000ABCD) !== true) throw new Error("castSpellViaHandle did not dispatch");
    assertEq(calls[0], [0x5000ABCD, 27], "wire order");
  } finally {
    globalThis.__pluginClient = prevClient;
    globalThis.__sessionHandle = prevHandle;
  }
});

check("hotbar.js no longer sends castTargetedSpell(spell, item) itself", () => {
  const src = readFileSync(resolvePath(__dirname, "plugins/hotbar.js"), "utf8");
  if (src.includes("castTargetedSpell(s, g)")) throw new Error("swapped inline sender is back");
});

console.log("\n[7] spellcast-2 — formula-untargeted spells (rings, walls) need no selection");

// getSpellRecord shapes (serde-wasm-bindgen Maps); formulas are the
// DAT-decrypted ones from data/spell-table-attrs.json.
const ringRec = new Map([["isSelfTargeted", false], ["components", [110, 110, 19, 67, 34, 37, 63, 58]],
  ["flags", new Map([["selfTargeted", false]])]]);           // 1783 Searing Disc
const boltRec = new Map([["isSelfTargeted", false], ["components", [1, 15, 34, 46, 55]]]); // 27 Flame Bolt I
const selfRec = new Map([["isSelfTargeted", true], ["components", [1, 7, 33, 44, 60]]]);   // 2 Strength Self I

check("spellNeedsNoSelection: ring true, bolt false, self true, no record null", () => {
  assertEq(spellNeedsNoSelection(ringRec), true, "ring");
  assertEq(spellNeedsNoSelection(boltRec), false, "bolt");
  assertEq(spellNeedsNoSelection(selfRec), true, "self");
  assertEq(spellNeedsNoSelection(null), null, "no record");
});

check("?formulaUntargeted=off: the ring needs a target again", () => {
  assertEq(spellNeedsNoSelection(ringRec, false), false, "ring, flag off");
  assertEq(spellNeedsNoSelection(selfRec, false), true, "self, flag off");
});

check("untargeted ring with no soft target → castSelf (null target)", () => {
  assertEq(
    decideFireAction({ spellId: 1783 }, { isSelfTargeted: spellNeedsNoSelection(ringRec), softTargetGuid: 0 }),
    { kind: "castSelf", spellId: 1783 },
    "ring, no selection",
  );
  assertEq(
    decideFireAction({ spellId: 1783 }, { isSelfTargeted: spellNeedsNoSelection(ringRec), softTargetGuid: 0x50000123 }),
    { kind: "castSelf", spellId: 1783 },
    "ring ignores the selection",
  );
});

check("castSelf on the ring reaches the wasm as castUntargetedSpell", () => {
  const calls = [];
  const prevClient = globalThis.__pluginClient;
  const prevHandle = globalThis.__sessionHandle;
  delete globalThis.__pluginClient;
  globalThis.__sessionHandle = {
    getSpellRecord: () => ringRec,
    castUntargetedSpell: (...a) => calls.push(["untargeted", ...a]),
    castTargetedSpell: (...a) => calls.push(["targeted", ...a]),
  };
  try {
    if (castSpellViaHandle(1783, null) !== true) throw new Error("castSpellViaHandle did not dispatch");
    assertEq(calls, [["untargeted", 1783]], "wire call");
  } finally {
    globalThis.__pluginClient = prevClient;
    globalThis.__sessionHandle = prevHandle;
  }
});

console.log("\n===========================================================");
console.log(`PASS: ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.log(`FAIL: ${failed}`);
  process.exit(1);
}
