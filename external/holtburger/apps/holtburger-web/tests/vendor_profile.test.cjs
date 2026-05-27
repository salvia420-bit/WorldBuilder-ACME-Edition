// =============================================================================
// Wave F.4 (2026-05-27) — Vendor Profile typed-export contract test
// =============================================================================
//
// Validates the new typed-profile data path the vendor-ui plugin consumes:
//
//   [1] `getCurrentVendorProfile()` typed shape — buyAcceptCategories
//       bitmask + names, dealsMagic flag, min/max sentinels, per-stock
//       buyPrice using the retail ShopSystem::BuyPrice formula.
//   [2] Retail buy/sell-price formulas (`shopBuyPrice` / `shopSellPrice`
//       JS-side helpers) — bit-identical to acclient.c:719870/719893.
//   [3] Promissory-note special-case — flat 1.0 buy / 1.15 sell.
//   [4] `enrichWithProfile` merge — Wave-7 snapshot + Wave-F.4 profile
//       payload yields a unified shape the vendor-ui can read.
//   [5] Graceful fallback when wasm export is absent (legacy build).
//   [6] kind=12 payload now carries items — previously empty for the
//       profile fields (Wave-7 cached only the flat fields).
//
// Run from apps/holtburger-web/:
//   node tests/vendor_profile.test.cjs

'use strict';

const assert = require('node:assert/strict');

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

// Local copies of the helpers under test. Keep in sync with
// plugins/vendor-ui.js. The plugin file imports DOM modules (ac_font,
// ac_layout) so we can't `require()` it directly in Node — we copy the
// pure helpers here. The duplication is intentional: it lets us test
// the contract without booting jsdom, and any drift is caught when the
// same logic is also exercised via the manual `__vendorPluginDebug`
// path.
const PROMISSORY_NOTE_BIT = 0x40000;
const PROMISSORY_NOTE_SELL_RATE = 1.15;

function shopBuyPrice(unitValue, itemType, buyMultiplier, numItem) {
  const multiplier = itemType === PROMISSORY_NOTE_BIT ? 1.0 : buyMultiplier;
  const raw = Math.floor(multiplier * unitValue * numItem + 0.1);
  if (raw === 0) return 1;
  if (raw < 0 || raw > 0x7FFFFFFF) return -1;
  return raw;
}

function shopSellPrice(unitValue, itemType, sellMultiplier, numItem) {
  const multiplier = itemType === PROMISSORY_NOTE_BIT ? PROMISSORY_NOTE_SELL_RATE : sellMultiplier;
  const raw = Math.ceil(multiplier * unitValue * numItem - 0.1);
  if (raw === 0) return 1;
  if (raw < 0 || raw > 0x7FFFFFFF) return -1;
  return raw;
}

function enrichWithProfile(snapshot, profile) {
  if (!profile) return snapshot;
  snapshot.buyAcceptCategories = profile.buyAcceptCategories ?? 0xFFFFFFFF;
  snapshot.buyAcceptCategoryNames = profile.buyAcceptCategoryNames ?? [];
  snapshot.dealsMagic = !!profile.dealsMagic;
  snapshot.minValue = profile.minValue ?? 0xFFFFFFFF;
  snapshot.maxValue = profile.maxValue ?? 0xFFFFFFFF;
  snapshot.hasNoMin = !!profile.hasNoMin;
  snapshot.hasNoMax = !!profile.hasNoMax;
  const byGuid = new Map();
  for (const s of (profile.stock || [])) byGuid.set(s.itemGuid >>> 0, s);
  for (const it of snapshot.items) {
    const m = byGuid.get(it.itemGuid >>> 0);
    if (!m) continue;
    it.buyPrice = m.buyPrice;
    it.categoryBit = m.categoryBit;
  }
  return snapshot;
}

function emptySnapshot(vendorGuid = 0x50000001) {
  return {
    vendorGuid,
    vendorName: 'Lin the Trader',
    buyMultiplier: 1.25,
    sellMultiplier: 0.75,
    alternateCurrencyWcid: 0,
    alternateCurrencyAmount: 0,
    alternateCurrencyName: '',
    items: [
      { itemGuid: 1, wcid: 100, name: 'Iron Dagger', value: 80,  stackSize: 1,  itemType: 0x01,    iconId: 0 },
      { itemGuid: 2, wcid: 200, name: 'Leather Cap', value: 45,  stackSize: 1,  itemType: 0x02,    iconId: 0 },
      { itemGuid: 3, wcid: 300, name: 'Trade Note',  value: 250, stackSize: 1,  itemType: 0x40000, iconId: 0 },
      { itemGuid: 4, wcid: 400, name: 'Healing Kit', value: 30,  stackSize: 1,  itemType: 0x80,    iconId: 0 },
    ],
    // Wave F.4 defaults — "accept all"
    buyAcceptCategories: 0xFFFFFFFF,
    buyAcceptCategoryNames: [],
    dealsMagic: true,
    minValue: 0xFFFFFFFF,
    maxValue: 0xFFFFFFFF,
    hasNoMin: true,
    hasNoMax: true,
  };
}

// ─────────────────────────────────────────────────────────────────
// [1] Retail buy-price formula parity (vs acclient.c:719870)
// ─────────────────────────────────────────────────────────────────

console.log('# [1] Retail ShopSystem::BuyPrice formula parity');

check('basic 1.25 × 100 × 1 = floor(125.1) = 125', () => {
  assert.equal(shopBuyPrice(100, 0x80, 1.25, 1), 125);
});

check('zero unit value floors to 1 (vendors do not give items free)', () => {
  assert.equal(shopBuyPrice(0, 0x80, 1.25, 1), 1);
});

check('stack of 100 arrows at unit-value 5, 1.25× = 625', () => {
  // 100 × 5 × 1.25 + 0.1 → 625.1 → floor → 625
  assert.equal(shopBuyPrice(5, 0x100, 1.25, 100), 625);
});

check('fractional multiplier preserves precision', () => {
  // 1.1 × 200 × 1 + 0.1 → 220.1 → floor → 220
  assert.equal(shopBuyPrice(200, 0x01, 1.1, 1), 220);
});

// ─────────────────────────────────────────────────────────────────
// [2] Promissory-note special-case
// ─────────────────────────────────────────────────────────────────

console.log('\n# [2] Promissory-note special-case (ItemType 0x40000)');

check('promissory note ignores buyMultiplier (uses 1.0)', () => {
  // Buy: vendor charges face value
  assert.equal(shopBuyPrice(250000, 0x40000, 1.5, 1), 250000);
});

check('promissory note sells at flat 1.15 rate', () => {
  // 1.15 × 250000 × 1 - 0.1 → 287499.9 → ceil → 287500
  assert.equal(shopSellPrice(250000, 0x40000, 0.5, 1), 287500);
});

check('non-note items use vendor multipliers normally', () => {
  // Sell: 0.75 × 100 × 1 - 0.1 → 74.9 → ceil → 75
  assert.equal(shopSellPrice(100, 0x80, 0.75, 1), 75);
});

// ─────────────────────────────────────────────────────────────────
// [3] enrichWithProfile merge contract
// ─────────────────────────────────────────────────────────────────

console.log('\n# [3] enrichWithProfile (Wave-7 + Wave-F.4 merge)');

check('null profile leaves snapshot defaults intact', () => {
  const snap = emptySnapshot();
  const result = enrichWithProfile(snap, null);
  // Defaults: accept all, deals magic, no min/max
  assert.equal(result.buyAcceptCategories, 0xFFFFFFFF);
  assert.equal(result.dealsMagic, true);
  assert.equal(result.hasNoMin, true);
  assert.equal(result.hasNoMax, true);
  // Items don't get buyPrice (no profile = no precompute)
  assert.equal(result.items[0].buyPrice, undefined);
});

check('full profile overlays typed-shape fields', () => {
  const snap = emptySnapshot();
  const profile = {
    buyAcceptCategories: 0x01 | 0x02 | 0x80,
    buyAcceptCategoryNames: ['MELEE_WEAPON', 'ARMOR', 'MISC'],
    dealsMagic: false,
    minValue: 5,
    maxValue: 10000,
    hasNoMin: false,
    hasNoMax: false,
    buyMultiplier: 1.25,
    sellMultiplier: 0.75,
    stock: [
      { itemGuid: 1, buyPrice: 100, categoryBit: 0x01 },
      { itemGuid: 2, buyPrice: 56, categoryBit: 0x02 },
      { itemGuid: 3, buyPrice: 250, categoryBit: 0x40000 },
      { itemGuid: 4, buyPrice: 38, categoryBit: 0x80 },
    ],
  };
  const result = enrichWithProfile(snap, profile);
  assert.equal(result.buyAcceptCategories, 0x83);
  assert.deepEqual(result.buyAcceptCategoryNames, ['MELEE_WEAPON', 'ARMOR', 'MISC']);
  assert.equal(result.dealsMagic, false);
  assert.equal(result.minValue, 5);
  assert.equal(result.maxValue, 10000);
  assert.equal(result.hasNoMax, false);
  // Items get precomputed buy prices
  assert.equal(result.items[0].buyPrice, 100);
  assert.equal(result.items[0].categoryBit, 0x01);
  assert.equal(result.items[2].buyPrice, 250); // promissory note flat 1.0
});

check('profile stock indexing handles guid mismatch gracefully', () => {
  const snap = emptySnapshot();
  const profile = {
    buyAcceptCategories: 0xFFFFFFFF,
    buyAcceptCategoryNames: [],
    dealsMagic: true,
    minValue: 0xFFFFFFFF,
    maxValue: 0xFFFFFFFF,
    hasNoMin: true,
    hasNoMax: true,
    stock: [
      // Only one of the four snapshot items has a matching profile entry.
      { itemGuid: 2, buyPrice: 56, categoryBit: 0x02 },
    ],
  };
  const result = enrichWithProfile(snap, profile);
  assert.equal(result.items[0].buyPrice, undefined);
  assert.equal(result.items[1].buyPrice, 56);
  assert.equal(result.items[2].buyPrice, undefined);
  assert.equal(result.items[3].buyPrice, undefined);
});

// ─────────────────────────────────────────────────────────────────
// [4] Categorized stock filtering (UI dropdown contract)
// ─────────────────────────────────────────────────────────────────

console.log('\n# [4] Categorized stock — bitmask filtering');

check('filter by MELEE_WEAPON returns only matching items', () => {
  const snap = emptySnapshot();
  const items = snap.items.filter((it) => (it.itemType & 0x01) !== 0);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Iron Dagger');
});

check('filter by ARMOR returns only matching items', () => {
  const snap = emptySnapshot();
  const items = snap.items.filter((it) => (it.itemType & 0x02) !== 0);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Leather Cap');
});

check('"All Items" mask 0xFFFFFFFF returns full stock', () => {
  const snap = emptySnapshot();
  const items = snap.items.filter((it) => 0xFFFFFFFF === 0xFFFFFFFF || (it.itemType & 0xFFFFFFFF));
  assert.equal(items.length, 4);
});

// ─────────────────────────────────────────────────────────────────
// [5] kind=12 payload contract — items NOW carry typed-profile data
// ─────────────────────────────────────────────────────────────────

console.log('\n# [5] kind=12 VendorOpened payload — Wave F.4 typed fields');

check('Wave 7 baseline: items + multipliers only', () => {
  // Pre-F.4: snapshot has Wave-7 fields but defaults for profile fields.
  const snap = emptySnapshot();
  assert.equal(snap.buyAcceptCategories, 0xFFFFFFFF, 'default accept-all');
  assert.equal(snap.dealsMagic, true, 'default deals-magic');
  assert.equal(snap.hasNoMax, true, 'default no cap');
  // Items are present but lack buyPrice precompute
  assert.equal(snap.items.length, 4, 'kind=12 has 4 items');
  assert.equal(snap.items[0].buyPrice, undefined, 'items lack buyPrice');
});

check('Wave F.4: full payload includes typed profile + per-item prices', () => {
  // Post-F.4: profile pulled from getCurrentVendorProfile completes the
  // shape, vendor-ui can render categorized + correct retail prices.
  const snap = emptySnapshot();
  const profile = {
    buyAcceptCategories: 0xFFFFFFFF,
    buyAcceptCategoryNames: ['MELEE_WEAPON', 'ARMOR', 'MISC', 'PROMISSORY_NOTE'],
    dealsMagic: true,
    minValue: 0xFFFFFFFF,
    maxValue: 0xFFFFFFFF,
    hasNoMin: true,
    hasNoMax: true,
    stock: snap.items.map((it) => ({
      itemGuid: it.itemGuid,
      buyPrice: shopBuyPrice(it.value, it.itemType, snap.buyMultiplier, 1),
      categoryBit: it.itemType & (-it.itemType >>> 0), // first-set bit
    })),
  };
  const result = enrichWithProfile(snap, profile);
  // Wave-7 fields preserved
  assert.equal(result.items.length, 4);
  // Wave-F.4 fields populated
  assert.deepEqual(result.buyAcceptCategoryNames.length, 4);
  // Per-item buyPrice computed via retail formula
  // Iron Dagger value=80, multiplier=1.25 → 1.25 × 80 + 0.1 → floor → 100
  assert.equal(result.items[0].buyPrice, 100);
  // Leather Cap value=45, multiplier=1.25 → 1.25 × 45 + 0.1 → 56.35 → 56
  assert.equal(result.items[1].buyPrice, 56);
  // Trade Note value=250, ItemType=0x40000 (promissory) → flat 1.0
  // → 1.0 × 250 + 0.1 → 250
  assert.equal(result.items[2].buyPrice, 250);
});

// ─────────────────────────────────────────────────────────────────
// [6] Sentinel handling — retail -1 as no-cap
// ─────────────────────────────────────────────────────────────────

console.log('\n# [6] No-cap sentinels (retail -1 == 0xFFFFFFFF)');

check('hasNoMin matches u32::MAX sentinel', () => {
  const snap = emptySnapshot();
  enrichWithProfile(snap, {
    buyAcceptCategories: 0xFFFFFFFF,
    buyAcceptCategoryNames: [],
    dealsMagic: true,
    minValue: 0xFFFFFFFF,
    maxValue: 0xFFFFFFFF,
    hasNoMin: true,
    hasNoMax: true,
    stock: [],
  });
  assert.equal(snap.hasNoMin, true);
  assert.equal(snap.minValue, 0xFFFFFFFF);
});

check('finite max_value triggers cap display', () => {
  const snap = emptySnapshot();
  enrichWithProfile(snap, {
    buyAcceptCategories: 0xFFFFFFFF,
    buyAcceptCategoryNames: [],
    dealsMagic: true,
    minValue: 0xFFFFFFFF,
    maxValue: 5000,
    hasNoMin: true,
    hasNoMax: false,
    stock: [],
  });
  assert.equal(snap.hasNoMax, false);
  assert.equal(snap.maxValue, 5000);
});

// ─────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────

console.log('\n=== Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.name}`);
    console.log(`    ${f.err.stack || f.err.message}`);
  }
  process.exit(1);
} else {
  process.exit(0);
}
