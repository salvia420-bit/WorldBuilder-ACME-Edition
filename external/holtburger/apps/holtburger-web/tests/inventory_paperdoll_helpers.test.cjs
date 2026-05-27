// Wave D.1 follow-on (2026-05-27) — unit tests for the four pure
// helpers extracted from `plugins/inventory.js`:
//
//   - aetheriaSlotIsLocked   port of `gmPaperDollUI::UpdateAetheria`
//                            (ACBindings `gmPaperDollUI.cs:217-222`)
//   - formatBurdenText       port of `gmBackpackUI::SetLoadLevel`
//                            (ACBindings `gmBackpackUI.cs:151-156`)
//                            numeric-label leg
//   - computeInventoryTitle  port of `gmInventoryUI::RecvNotice_NewParentContainer`
//                            (ACBindings `gmInventoryUI.cs:218-223`)
//   - parseSlotsViewChecked  port of `gmPaperDollUI::m_SlotCheckbox`
//                            persistence default (ACBindings
//                            `gmPaperDollUI.cs:134` +
//                            `acclient.c:221667` retail default-zero)
//
// The host DOM-side wrappers (refreshAetheriaGating / refreshBurdenText /
// refreshPanelTitle / slots-toggle handler) delegate to these helpers,
// so the test surface is the pure logic; the DOM side just translates
// the result to CSS classes / element text.
//
// Run from apps/holtburger-web/:
//   node tests/inventory_paperdoll_helpers.test.cjs
// Exits 0 on full pass, 1 on any assertion failure.

const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const INV_URL = pathToFileURL(
  path.join(__dirname, '..', 'plugins', 'inventory_helpers.js')
).href;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

(async () => {
  // inventory_helpers.js is pure (no DOM / three.js imports) so it
  // loads cleanly in Node without any shims.
  const {
    aetheriaSlotIsLocked,
    formatBurdenText,
    computeInventoryTitle,
    parseSlotsViewChecked,
  } = await import(INV_URL);

  // ============================================================
  // 1. aetheriaSlotIsLocked
  // ============================================================
  console.log('\n[1] aetheriaSlotIsLocked  (PropertyInt 322 bitmask gating)');
  // Per ACE.Entity::AetheriaBitfield: Blue=0x1, Yellow=0x2, Red=0x4.
  // Property is REMOVED when zero per `Player_Properties.cs:1273`, so
  // `0` → all three locked.
  check('bits=0 → Blue locked', () => {
    assert.strictEqual(aetheriaSlotIsLocked(0, 0x1), true);
  });
  check('bits=0 → Yellow locked', () => {
    assert.strictEqual(aetheriaSlotIsLocked(0, 0x2), true);
  });
  check('bits=0 → Red locked', () => {
    assert.strictEqual(aetheriaSlotIsLocked(0, 0x4), true);
  });
  check('bits=0x1 → Blue UNLOCKED', () => {
    assert.strictEqual(aetheriaSlotIsLocked(0x1, 0x1), false);
  });
  check('bits=0x1 → Yellow locked', () => {
    assert.strictEqual(aetheriaSlotIsLocked(0x1, 0x2), true);
  });
  check('bits=0x1 → Red locked', () => {
    assert.strictEqual(aetheriaSlotIsLocked(0x1, 0x4), true);
  });
  check('bits=0x3 (Blue+Yellow) → both unlocked, Red locked', () => {
    assert.strictEqual(aetheriaSlotIsLocked(0x3, 0x1), false);
    assert.strictEqual(aetheriaSlotIsLocked(0x3, 0x2), false);
    assert.strictEqual(aetheriaSlotIsLocked(0x3, 0x4), true);
  });
  check('bits=0x7 (all three) → all unlocked', () => {
    assert.strictEqual(aetheriaSlotIsLocked(0x7, 0x1), false);
    assert.strictEqual(aetheriaSlotIsLocked(0x7, 0x2), false);
    assert.strictEqual(aetheriaSlotIsLocked(0x7, 0x4), false);
  });
  check('slotBit=0 (non-aetheria slot) → never locked', () => {
    assert.strictEqual(aetheriaSlotIsLocked(0, 0), false);
    assert.strictEqual(aetheriaSlotIsLocked(0xFFFFFFFF, 0), false);
  });
  check('bits=u32::MAX → all aetheria slots unlocked', () => {
    assert.strictEqual(aetheriaSlotIsLocked(0xFFFFFFFF, 0x1), false);
    assert.strictEqual(aetheriaSlotIsLocked(0xFFFFFFFF, 0x2), false);
    assert.strictEqual(aetheriaSlotIsLocked(0xFFFFFFFF, 0x4), false);
  });

  // ============================================================
  // 2. formatBurdenText
  // ============================================================
  console.log('\n[2] formatBurdenText  (burden float → "<pct>%" + over-cap flag)');
  // burden is `encumbrance / capacity` per ACE EncumbranceSystem.GetBurden.
  // 0 / NaN / negative → "—" (pre-spawn).
  check('NaN → "—" not over', () => {
    const r = formatBurdenText(NaN);
    assert.deepStrictEqual(r, { text: '—', over: false });
  });
  check('0 → "—" not over (pre-spawn)', () => {
    const r = formatBurdenText(0);
    assert.deepStrictEqual(r, { text: '—', over: false });
  });
  check('negative → "—" not over (defensive)', () => {
    const r = formatBurdenText(-0.5);
    assert.deepStrictEqual(r, { text: '—', over: false });
  });
  check('Infinity → "—" not over (defensive)', () => {
    const r = formatBurdenText(Infinity);
    // Infinity is not Number.isFinite() so the helper returns the empty
    // placeholder. Don't surface a percent for malformed input.
    assert.deepStrictEqual(r, { text: '—', over: false });
  });
  check('0.0001 → 0% (rounds toward zero)', () => {
    const r = formatBurdenText(0.0001);
    assert.deepStrictEqual(r, { text: '0%', over: false });
  });
  check('0.45 → 45% (under)', () => {
    const r = formatBurdenText(0.45);
    assert.deepStrictEqual(r, { text: '45%', over: false });
  });
  check('0.853 → 85% (rounds half-away-from-zero)', () => {
    // Math.round half-to-even is false; JS uses half-away-from-zero
    // and 0.853 * 100 = 85.3 which rounds to 85.
    const r = formatBurdenText(0.853);
    assert.deepStrictEqual(r, { text: '85%', over: false });
  });
  check('0.999 → 100% (just below cap, NOT over)', () => {
    const r = formatBurdenText(0.999);
    assert.deepStrictEqual(r, { text: '100%', over: false });
  });
  check('1.0 → 100% AND over (at-cap is over)', () => {
    const r = formatBurdenText(1.0);
    assert.deepStrictEqual(r, { text: '100%', over: true });
  });
  check('1.5 → 150% over', () => {
    const r = formatBurdenText(1.5);
    assert.deepStrictEqual(r, { text: '150%', over: true });
  });
  check('3.0 → 300% over (extreme over-encumbered)', () => {
    const r = formatBurdenText(3.0);
    assert.deepStrictEqual(r, { text: '300%', over: true });
  });

  // ============================================================
  // 3. computeInventoryTitle
  // ============================================================
  console.log('\n[3] computeInventoryTitle  (main pack vs side pack title)');
  const bagSlots = [
    { containerId: 0,           name: 'Main Pack',  iconId: 0 },
    { containerId: 0x50000001,  name: 'Belt Pouch', iconId: 0 },
    { containerId: 0x50000002,  name: 'Trade Pack', iconId: 0 },
    null, null, null, null, null,
  ];
  check('main pack with name → "Inventory of <name>"', () => {
    assert.strictEqual(
      computeInventoryTitle(0, bagSlots, 'Frostbinder'),
      'Inventory of Frostbinder'
    );
  });
  check('main pack without name → "Inventory"', () => {
    assert.strictEqual(computeInventoryTitle(0, bagSlots, ''), 'Inventory');
    assert.strictEqual(computeInventoryTitle(0, bagSlots, null), 'Inventory');
    assert.strictEqual(computeInventoryTitle(0, bagSlots, '   '), 'Inventory');
  });
  check('side pack 1 → "Contents of Belt Pouch"', () => {
    assert.strictEqual(
      computeInventoryTitle(0x50000001, bagSlots, 'Frostbinder'),
      'Contents of Belt Pouch'
    );
  });
  check('side pack 2 → "Contents of Trade Pack"', () => {
    assert.strictEqual(
      computeInventoryTitle(0x50000002, bagSlots, 'Frostbinder'),
      'Contents of Trade Pack'
    );
  });
  check('unknown containerId → "Contents of Pack" (fallback)', () => {
    // Selection survives a rebuild only when the previously selected
    // container is still present, so this case is rare — but the
    // helper must not throw.
    assert.strictEqual(
      computeInventoryTitle(0xDEADBEEF, bagSlots, 'Frostbinder'),
      'Contents of Pack'
    );
  });
  check('side pack with empty name → "Contents of Pack" (fallback)', () => {
    const weirdSlots = [
      { containerId: 0, name: 'Main Pack', iconId: 0 },
      { containerId: 0x50000001, name: '', iconId: 0 },
    ];
    assert.strictEqual(
      computeInventoryTitle(0x50000001, weirdSlots, 'Frostbinder'),
      'Contents of Pack'
    );
  });
  check('player name doesn\'t affect side-pack title', () => {
    // The side-pack title ignores the player name (matches retail: the
    // window is showing the pack's contents, not the player's overall
    // inventory).
    assert.strictEqual(
      computeInventoryTitle(0x50000001, bagSlots, null),
      'Contents of Belt Pouch'
    );
    assert.strictEqual(
      computeInventoryTitle(0x50000001, bagSlots, ''),
      'Contents of Belt Pouch'
    );
  });

  // ============================================================
  // 4. parseSlotsViewChecked
  // ============================================================
  console.log('\n[4] parseSlotsViewChecked  (m_SlotCheckbox persisted state)');
  // Retail default per acclient.c:221667 is SetAttribute_Bool(..., 0) at
  // PostInit — so a fresh character / cleared storage shows the
  // paperdoll, not the flat slot grid. Only "1" maps to checked.
  check('null → false (default unchecked / paperdoll view)', () => {
    assert.strictEqual(parseSlotsViewChecked(null), false);
  });
  check('undefined → false (no storage entry yet)', () => {
    assert.strictEqual(parseSlotsViewChecked(undefined), false);
  });
  check('"" → false (empty string is not "1")', () => {
    assert.strictEqual(parseSlotsViewChecked(""), false);
  });
  check('"0" → false (explicit unchecked)', () => {
    assert.strictEqual(parseSlotsViewChecked("0"), false);
  });
  check('"1" → true (checked / Slots view)', () => {
    assert.strictEqual(parseSlotsViewChecked("1"), true);
  });
  check('"true" → false (we only accept the canonical "1")', () => {
    // Don't allow tampered/non-canonical values to flip the toggle on.
    assert.strictEqual(parseSlotsViewChecked("true"), false);
  });
  check('"garbage" → false (defensive)', () => {
    assert.strictEqual(parseSlotsViewChecked("garbage"), false);
  });
  check('" 1 " → false (no whitespace tolerance — exact match)', () => {
    // We write exactly "1" / "0", so any whitespace means storage was
    // tampered with → safe fall-back is unchecked.
    assert.strictEqual(parseSlotsViewChecked(" 1 "), false);
  });

  // ============================================================
  // Summary
  // ============================================================
  console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const { name, err } of failures) {
      console.log(`  - ${name}: ${err.message}`);
    }
    process.exit(1);
  }
})().catch((e) => {
  console.error('Test harness error:', e);
  process.exit(1);
});
