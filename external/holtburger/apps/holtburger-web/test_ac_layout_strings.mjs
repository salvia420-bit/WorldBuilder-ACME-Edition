// HUD rec #154 (2026-06-16) — layout StringInfo resolution test.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_ac_layout_strings.mjs
//
// Covers resolveStringInfo + resolveElementLabel (ui/ac_layout.js): the
// StringInfo BaseProperty -> StringTable text resolution that wires retail
// localized labels into DAT-driven layouts. A stubbed window.__hbWasm seeds
// known StringTables so the resolved (happy) path is exercised end-to-end.

globalThis.window = globalThis;
globalThis.document = {
  createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {}, addEventListener() {} }),
  getElementById: () => null, head: { appendChild() {} }, body: { appendChild() {} },
};

const TABLE_DEFAULT = 0x23000004; // UI_Options
const TABLE_KEYMAP = 0x23000007;  // a distinct table for the table_id-override case
globalThis.window.__hbWasm = {
  fetch_string_table: async (id) => {
    if ((id >>> 0) === TABLE_DEFAULT) return JSON.stringify([[100, "Apply"], [101, "OK"]]);
    if ((id >>> 0) === TABLE_KEYMAP) return JSON.stringify([[200, "Bind Key"]]);
    return JSON.stringify([]);
  },
};

const { resolveStringInfo, resolveElementLabel } = await import("./ui/ac_layout.js");
const { loadStringTable } = await import("./ui/ac_strings.js");

// Seed the StringTables so acString() can resolve synchronously.
await loadStringTable(TABLE_DEFAULT);
await loadStringTable(TABLE_KEYMAP);

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.message}`); }
}
function assertEq(a, e, label) {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}

console.log("===========================================================");
console.log("HUD rec #154 — layout StringInfo resolution");
console.log("===========================================================\n");

check("non-StringInfo variant → null (caller keeps placeholder)", () => {
  assertEq(resolveStringInfo({ Integer: 5 }, TABLE_DEFAULT), null, "integer");
  assertEq(resolveStringInfo(null, TABLE_DEFAULT), null, "null");
  assertEq(resolveStringInfo({ DataId: 0x06001234 }, TABLE_DEFAULT), null, "dataid");
});

check("StringInfo with no string_id → null", () => {
  assertEq(resolveStringInfo({ StringInfo: { string_id: 0, table_id: 0 } }, TABLE_DEFAULT), null, "no-stringid");
});

check("table_id=0 falls back to default table and resolves text", () => {
  const r = resolveStringInfo({ StringInfo: { string_id: 100, table_id: 0 } }, TABLE_DEFAULT);
  assertEq(r.tableId, TABLE_DEFAULT, "tableId");
  assertEq(r.stringId, 100, "stringId");
  assertEq(r.text, "Apply", "text");
  assertEq(r.resolved, true, "resolved");
});

check("non-zero table_id is used over the default", () => {
  const r = resolveStringInfo({ StringInfo: { string_id: 200, table_id: TABLE_KEYMAP } }, TABLE_DEFAULT);
  assertEq(r.tableId, TABLE_KEYMAP, "tableId");
  assertEq(r.text, "Bind Key", "text");
  assertEq(r.resolved, true, "resolved");
});

check("empty-object table_id (DAT 'not set') falls back to default", () => {
  const r = resolveStringInfo({ StringInfo: { string_id: 101, table_id: {} } }, TABLE_DEFAULT);
  assertEq(r.tableId, TABLE_DEFAULT, "tableId");
  assertEq(r.text, "OK", "text");
});

check("unloaded table → resolved:false but ids preserved", () => {
  const r = resolveStringInfo({ StringInfo: { string_id: 999, table_id: 0x23009999 } }, TABLE_DEFAULT);
  assertEq(r.tableId, 0x23009999, "tableId");
  assertEq(r.stringId, 999, "stringId");
  assertEq(r.text, null, "text");
  assertEq(r.resolved, false, "resolved");
});

check("resolveElementLabel reads property[23] (MasterProperty 0x17)", () => {
  const element = { state_desc: { properties: { "23": { StringInfo: { string_id: 100, table_id: 0 } } } } };
  const r = resolveElementLabel(element);
  assertEq(r.text, "Apply", "text");
  assertEq(r.resolved, true, "resolved");
});

check("resolveElementLabel → null when no state_desc / no property[23]", () => {
  assertEq(resolveElementLabel({}), null, "no-state_desc");
  assertEq(resolveElementLabel({ state_desc: { properties: {} } }), null, "no-prop23");
  assertEq(resolveElementLabel(null), null, "null-element");
});

console.log(`\n===========================================================`);
console.log(`PASS: ${passed} / ${passed + failed}`);
console.log(`===========================================================`);
if (failed > 0) process.exitCode = 1;
