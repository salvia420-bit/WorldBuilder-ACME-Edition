// tests/map_house_marker.test.mjs — maps-chargen-barber-6 (2026-10-13).
//
// Retail gmMapUI::RecvNotice_UpdateHouseData (acclient.c:218123):
//   if (i_houseData->m_type == 4) m_HousePosition = 0;          // Apartment
//   else { m_HousePosition = m_pos.objcell_id; frame = m_pos.frame; }
// ACE.Entity.Enum.HouseType: Undef 0, Cottage 1, Villa 2, Mansion 3,
// Apartment 4. holtburger's map readHouse plotted every HouseData, so an
// apartment owner got a "Your house" marker (compact F3 map + expanded world
// map) wherever the apartment cell's landblock bytes happened to land.
//
// CONTRACT
//   [1] houseMarkerCoords: houseType 4 → null, even with a real landblock.
//   [2] houseType 0/1/2/3 → exactly lbToCoords(landblockId, posX, posY).
//   [3] no snapshot / landblockId 0 → null.
//   [4] a wasm-box-shaped snapshot (getters on the prototype) reads the same.
//   [5] stale pkg/ without the houseType getter → plotted as before (no
//       regression for non-apartment owners).
//   [6] source: readHouse goes through houseMarkerCoords and still frees the
//       wasm box.
//
// Fails on the pre-change code: houseMarkerCoords / HOUSE_TYPE_APARTMENT are
// not exported and readHouse never read houseType.
//
// Run:
//   cd apps/holtburger-web/
//   node tests/map_house_marker.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Minimal DOM shim so the real plugin module imports (same as test_map_panel.mjs).
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = {
  createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, setAttribute() {}, addEventListener() {} }),
  getElementById: () => null, head: { appendChild() {}, prepend() {} }, body: { appendChild() {} },
  addEventListener() {}, removeEventListener() {},
  documentElement: { style: { setProperty() {} } },
};

const M = await import("../plugins/map-panel.js");
const { houseMarkerCoords, HOUSE_TYPE_APARTMENT, lbToCoords } = M;

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.message}`); }
}
function assertEq(a, e, label) {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assert(cond, label) { if (!cond) throw new Error(label); }

const LB = 0xA9B4001F; // Holtburg outdoor cell
const snap = (houseType, extra = {}) => ({ houseType, landblockId: LB, posX: 84.5, posY: 120.25, posZ: 42, ...extra });

console.log("===========================================================");
console.log("maps-chargen-barber-6 — no house marker for an Apartment");
console.log("===========================================================\n");

check("[0] exports exist", () => {
  assertEq(typeof houseMarkerCoords, "function", "houseMarkerCoords");
  assertEq(HOUSE_TYPE_APARTMENT, 4, "HOUSE_TYPE_APARTMENT (ACE HouseType.Apartment)");
});

check("[1] houseType 4 (Apartment) → null", () => {
  assertEq(houseMarkerCoords(snap(4)), null, "apartment");
  assertEq(houseMarkerCoords(snap(HOUSE_TYPE_APARTMENT)), null, "apartment const");
});

check("[2] houseType 0/1/2/3 → lbToCoords(landblockId, posX, posY)", () => {
  const want = lbToCoords(LB, 84.5, 120.25);
  assert(Number.isFinite(want.ew) && Number.isFinite(want.ns), "lbToCoords finite");
  for (const t of [0, 1, 2, 3]) assertEq(houseMarkerCoords(snap(t)), want, `type ${t}`);
});

check("[3] no snapshot / landblockId 0 → null", () => {
  assertEq(houseMarkerCoords(null), null, "null");
  assertEq(houseMarkerCoords(undefined), null, "undefined");
  assertEq(houseMarkerCoords(snap(1, { landblockId: 0 })), null, "lb 0 cottage");
  assertEq(houseMarkerCoords(snap(4, { landblockId: 0 })), null, "lb 0 apartment");
});

check("[4] wasm-box-shaped snapshot (prototype getters) reads the same", () => {
  class HouseDataBox {
    constructor(t) { this._t = t; }
    get houseType() { return this._t; }
    get landblockId() { return LB; }
    get posX() { return 84.5; }
    get posY() { return 120.25; }
    free() {}
  }
  assertEq(houseMarkerCoords(new HouseDataBox(4)), null, "box apartment");
  assertEq(houseMarkerCoords(new HouseDataBox(3)), lbToCoords(LB, 84.5, 120.25), "box mansion");
});

check("[5] stale pkg/ without houseType → still plotted", () => {
  const { houseType: _omit, ...noType } = snap(1);
  assertEq(houseMarkerCoords(noType), lbToCoords(LB, 84.5, 120.25), "no houseType getter");
});

check("[6] source: readHouse routes through houseMarkerCoords and frees the box", () => {
  const src = readFileSync(path.join(APP, "plugins/map-panel.js"), "utf8");
  const m = src.match(/function readHouse\(handle\) \{([\s\S]*?)\n\}/);
  assert(m, "readHouse found");
  const body = m[1];
  assert(/return houseMarkerCoords\(d\);/.test(body), "readHouse returns houseMarkerCoords(d)");
  assert(/finally\s*\{[^}]*d\?\.free\?\.\(\)/.test(body), "readHouse frees the snapshot in finally");
  assert(!/lbToCoords\(/.test(body), "readHouse no longer plots raw landblock bytes itself");
});

console.log(`\n===========================================================`);
console.log(`PASS: ${passed} / ${passed + failed}`);
console.log(`===========================================================`);
if (failed > 0) process.exitCode = 1;
