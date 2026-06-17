// HUD rec #153 (2026-06-16) — main-panel floaty-frame UI-id + resolver test.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_ac_floaty_frame.mjs
//
// Locks the MAIN_PANEL_FRAME_UI_IDS chrome-element map (gmFloatyPanelUI
// 0x2100006E) and confirms resolveFrameSpritesFromLayout pulls the per-state
// Image.file sprite DID for each of the 16 elements. A minimal DOM shim lets
// the module import (its DOM work lives in attachFloatyFrame, not driven here).

globalThis.window = globalThis;
globalThis.document = {
  createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, contains() { return false; } }, appendChild() {}, setAttribute() {}, addEventListener() {} }),
  getElementById: () => null, head: { appendChild() {} }, body: { appendChild() {} },
};

const { MAIN_PANEL_FRAME_UI_IDS, resolveFrameSpritesFromLayout } =
  await import("./ui/ac_floaty_frame.js");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.message}`); }
}
function assertEq(a, e, label) {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}

console.log("===========================================================");
console.log("HUD rec #153 — main-panel floaty-frame chrome");
console.log("===========================================================\n");

check("MAIN_PANEL_FRAME_UI_IDS = 8 unlocked + 8 locked, canonical values", () => {
  assertEq(MAIN_PANEL_FRAME_UI_IDS.unlocked,
    [0x10000653, 0x10000654, 0x10000655, 0x10000656, 0x10000657, 0x10000658, 0x10000659, 0x1000065A],
    "unlocked");
  assertEq(MAIN_PANEL_FRAME_UI_IDS.locked,
    [0x1000065B, 0x1000065C, 0x1000065D, 0x1000065E, 0x1000065F, 0x10000660, 0x10000661, 0x10000662],
    "locked");
});

check("frame ids are frozen (no accidental mutation)", () => {
  if (!Object.isFrozen(MAIN_PANEL_FRAME_UI_IDS) || !Object.isFrozen(MAIN_PANEL_FRAME_UI_IDS.unlocked)) {
    throw new Error("expected frozen ui-id map");
  }
});

const mkEl = (eid, file) => ({ element_id: eid, state_desc: { media: [{ Image: { file } }] } });

check("resolveFrameSpritesFromLayout maps every chrome element to its sprite", () => {
  const all = [...MAIN_PANEL_FRAME_UI_IDS.unlocked, ...MAIN_PANEL_FRAME_UI_IDS.locked]
    .map((eid, i) => mkEl(eid, 0x06001000 + i));
  const out = resolveFrameSpritesFromLayout({ elements: all }, MAIN_PANEL_FRAME_UI_IDS);
  if (!out) throw new Error("expected a resolved sprite set");
  assertEq(out.unlocked[0], 0x06001000, "TL unlocked");
  assertEq(out.locked[7], 0x06001000 + 15, "R locked");
});

check("returns null when any chrome element is missing (CSS fallback)", () => {
  const partial = MAIN_PANEL_FRAME_UI_IDS.unlocked.slice(0, 7) // drop one
    .map((eid, i) => mkEl(eid, 0x06001000 + i));
  const out = resolveFrameSpritesFromLayout({ elements: partial }, MAIN_PANEL_FRAME_UI_IDS);
  assertEq(out, null, "missing-piece");
});

console.log(`\n===========================================================`);
console.log(`PASS: ${passed} / ${passed + failed}`);
console.log(`===========================================================`);
if (failed > 0) process.exitCode = 1;
