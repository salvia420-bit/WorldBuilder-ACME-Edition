// HUD rec #181 (2026-06-16) — Personal Library accumulation test.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_lore_panel.mjs
//
// Covers mergeInventoryWritables — the pure accumulation of WRITABLE items
// (itemType & 0x2000) from a playerInventory() snapshot into the persisted
// library map. A minimal DOM shim lets the real module import.

globalThis.window = globalThis;
globalThis.document = {
  createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {}, addEventListener() {} }),
  getElementById: () => null, head: { appendChild() {} }, body: { appendChild() {} },
};

const { mergeInventoryWritables } = await import("./plugins/lore-panel.js");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.message}`); }
}
function assert(cond, label) { if (!cond) throw new Error(label); }
function assertEq(a, e, label) { if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }

const WRITABLE = 0x2000;
const ISO = "2026-06-16T00:00:00.000Z";

console.log("===========================================================");
console.log("HUD rec #181 — Personal Library accumulation");
console.log("===========================================================\n");

check("only WRITABLE (0x2000) items are catalogued", () => {
  const lib = new Map();
  const { changed } = mergeInventoryWritables(lib, [
    { wcid: 1, name: "Steel Sword", itemType: 0x1 },       // weapon — ignored
    { wcid: 2, name: "Parchment", itemType: WRITABLE },    // writable
    { wcid: 3, name: "Healing Kit", itemType: 0x80 },      // not writable
  ], ISO);
  assert(changed, "changed");
  assertEq([...lib.keys()], [2], "only-writable");
  assertEq(lib.get(2).name, "Parchment", "name");
  assertEq(lib.get(2).firstSeenIso, ISO, "stamp");
});

check("writable bit combined with other type bits still catalogues", () => {
  const lib = new Map();
  mergeInventoryWritables(lib, [{ wcid: 5, name: "Magic Tome", itemType: WRITABLE | 0x40 }], ISO);
  assert(lib.has(5), "combined-bits");
});

check("item with no wcid is skipped", () => {
  const lib = new Map();
  const { changed } = mergeInventoryWritables(lib, [{ wcid: 0, name: "??", itemType: WRITABLE }], ISO);
  assert(!changed, "no-change");
  assertEq(lib.size, 0, "empty");
});

check("re-merging the same item does not change firstSeen (idempotent)", () => {
  const lib = new Map();
  mergeInventoryWritables(lib, [{ wcid: 7, name: "Diary", itemType: WRITABLE, iconId: 0x06001111 }], ISO);
  const r = mergeInventoryWritables(lib, [{ wcid: 7, name: "Diary", itemType: WRITABLE, iconId: 0x06001111 }], "2099-01-01T00:00:00.000Z");
  assert(!r.changed, "idempotent");
  assertEq(lib.get(7).firstSeenIso, ISO, "first-seen-preserved");
});

check("a later snapshot backfills a previously-unknown name + icon", () => {
  const lib = new Map();
  // First seen with no name/icon (placeholder).
  mergeInventoryWritables(lib, [{ wcid: 9, name: "", itemType: WRITABLE }], ISO);
  assertEq(lib.get(9).name, "Item 9", "placeholder-name");
  // Later the entity carries the real name + icon.
  const r = mergeInventoryWritables(lib, [{ wcid: 9, name: "Ancient Scroll", itemType: WRITABLE, iconId: 0x06002222 }], ISO);
  assert(r.changed, "backfill-changed");
  assertEq(lib.get(9).name, "Ancient Scroll", "backfilled-name");
  assertEq(lib.get(9).iconId, 0x06002222, "backfilled-icon");
});

check("empty / null inventory is a no-op", () => {
  const lib = new Map();
  assertEq(mergeInventoryWritables(lib, [], ISO).changed, false, "empty");
  assertEq(mergeInventoryWritables(lib, null, ISO).changed, false, "null");
  assertEq(lib.size, 0, "size");
});

console.log(`\n===========================================================`);
console.log(`PASS: ${passed} / ${passed + failed}`);
console.log(`===========================================================`);
if (failed > 0) process.exitCode = 1;
