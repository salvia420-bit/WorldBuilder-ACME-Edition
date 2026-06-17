// HUD rec #139 (2026-06-16) — map-panel roster-pin projection test.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_map_panel.mjs
//
// Covers collectRosterMarkers — the pure cross-reference of roster guids
// against the live entityMap (+ a last-seen cache) that produces the
// fellow/allegiance map pins. A minimal DOM shim lets the real module import.

globalThis.window = globalThis;
globalThis.document = {
  createElement: () => ({ style: {}, dataset: {}, classList: { add() {} }, appendChild() {}, setAttribute() {}, addEventListener() {} }),
  getElementById: () => null, head: { appendChild() {} }, body: { appendChild() {} },
};

const { collectRosterMarkers } = await import("./plugins/map-panel.js");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.message}`); }
}
function assertEq(a, e, label) {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}

const PLAYER = (x, y) => ({ root: { position: { x, y } }, meta: { objDescFlags: 0x08 } });
const NONPLAYER = (x, y) => ({ root: { position: { x, y } }, meta: { objDescFlags: 0x00 } });

console.log("===========================================================");
console.log("HUD rec #139 — fellow/allegiance map-pin projection");
console.log("===========================================================\n");

check("live PVS member → live marker at its AC coords", () => {
  const roster = new Map([[0x5001, { kind: "fellow", name: "Alice" }]]);
  const em = new Map([[0x5001, PLAYER(100, 200)]]);
  const out = collectRosterMarkers(roster, em, new Map(), 1000, 0);
  assertEq(out.length, 1, "count");
  assertEq([out[0].x, out[0].y, out[0].source, out[0].kind], [100, 200, "live", "fellow"], "marker");
});

check("local player guid is skipped (it has its own marker)", () => {
  const roster = new Map([[0x5003, { kind: "fellow", name: "Me" }]]);
  const em = new Map([[0x5003, PLAYER(1, 2)]]);
  assertEq(collectRosterMarkers(roster, em, new Map(), 1000, 0x5003), [], "skip-local");
});

check("member never seen (not in PVS, not cached) → omitted", () => {
  const roster = new Map([[0x5002, { kind: "alleg", name: "Bob" }]]);
  assertEq(collectRosterMarkers(roster, new Map(), new Map(), 1000, 0), [], "omit-unseen");
});

check("non-PLAYER entity at a roster guid is suppressed (collision guard)", () => {
  const roster = new Map([[0x5004, { kind: "fellow", name: "Item?" }]]);
  const em = new Map([[0x5004, NONPLAYER(5, 5)]]);
  assertEq(collectRosterMarkers(roster, em, new Map(), 1000, 0), [], "odf-guard");
});

check("member who left PVS recently → cached marker, faded by age", () => {
  const roster = new Map([[0x5001, { kind: "fellow", name: "Alice" }]]);
  const cache = new Map();
  // Seen live at t=1000 → seeds the cache.
  collectRosterMarkers(roster, new Map([[0x5001, PLAYER(100, 200)]]), cache, 1000, 0);
  // 60s later, gone from PVS → served from cache.
  const out = collectRosterMarkers(roster, new Map(), cache, 1000 + 60_000, 0);
  assertEq([out.length, out[0].source, out[0].ageMs, out[0].x], [1, "cached", 60_000, 100], "cached");
});

check("cached position past staleMs TTL → omitted", () => {
  const roster = new Map([[0x5001, { kind: "fellow", name: "Alice" }]]);
  const cache = new Map([[0x5001, { x: 100, y: 200, ts: 0 }]]);
  // nowMs well past the default 5-min TTL.
  assertEq(collectRosterMarkers(roster, new Map(), cache, 6 * 60_000, 0), [], "ttl");
});

check("allegiance members carry kind=alleg + live entity refreshes cache", () => {
  const roster = new Map([[0x5005, { kind: "alleg", name: "Patron" }]]);
  const cache = new Map();
  const out = collectRosterMarkers(roster, new Map([[0x5005, PLAYER(7, 8)]]), cache, 500, 0);
  assertEq(out[0].kind, "alleg", "kind");
  assertEq(cache.get(0x5005), { x: 7, y: 8, ts: 500 }, "cache-seed");
});

console.log(`\n===========================================================`);
console.log(`PASS: ${passed} / ${passed + failed}`);
console.log(`===========================================================`);
if (failed > 0) process.exitCode = 1;
