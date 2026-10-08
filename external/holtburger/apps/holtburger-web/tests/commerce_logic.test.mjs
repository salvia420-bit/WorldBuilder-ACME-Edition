// tests/commerce_logic.test.mjs — HUD overhaul 2026-10-05.
//
// Pure rules behind the commerce / crafting / reading windows
// (plugins/commerce_logic.js). The headline contract is the vendor PRICE
// DIRECTION: the wire VendorProfile carries buy_price (what the vendor pays
// you, ~0.5–0.9 in ace_world) THEN sell_price (what it charges, ~1.35–1.7);
// retail charges VendorProfile::VendorSellPrice = ShopSystem::SellPrice(…,
// sell_price, …) and pays VendorBuyPrice = ShopSystem::BuyPrice(…,
// buy_price, …). The pre-overhaul vendor bar had the two swapped.
//
// Run from apps/holtburger-web/:  node tests/commerce_logic.test.mjs

import assert from "node:assert/strict";
import {
  shopSellPrice, shopBuyPrice, unitValueOf, vendorPurchasePrice, vendorSaleCredit,
  vendorAcceptability, vendorRejectText, VENDOR_ACCEPT, countCurrency, PYREAL_WCID,
  fmtNumber, fmtCompact, isOutOfRange, TRADE_RANGE, CYLINDER_RADII_ALLOWANCE,
  tradeStatus, mapCoordsText, rentDueInfo, MAINTENANCE_PERIOD_SECONDS,
  houseTypeName, clampPage, sellStagingPlan,
} from "../plugins/commerce_logic.js";

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

// A typical Holtburg vendor: BuyPrice 0.9 (wire buy_price → buyMultiplier),
// SellPrice 1.5 (wire sell_price → sellMultiplier).
const VENDOR = { buyMultiplier: 0.9, sellMultiplier: 1.5 };

console.log("[1] retail ShopSystem formulas");
check("SellPrice: ceil(1.5 × 100 − 0.1) = 150", () => {
  assert.equal(shopSellPrice(100, 0x80, 1.5, 1), 150);
});
check("BuyPrice: floor(0.9 × 100 + 0.1) = 90", () => {
  assert.equal(shopBuyPrice(100, 0x80, 0.9, 1), 90);
});
check("promissory notes: sell 1.15, buy 1.0 regardless of the vendor rate", () => {
  assert.equal(shopSellPrice(250000, 0x40000, 1.5, 1), 287500);
  assert.equal(shopBuyPrice(250000, 0x40000, 0.5, 1), 250000);
});
check("nothing is free: a zero result floors to 1", () => {
  assert.equal(shopSellPrice(0, 0x80, 1.5, 1), 1);
  assert.equal(shopBuyPrice(0, 0x80, 0.9, 1), 1);
});
check("overflow returns -1", () => {
  assert.equal(shopSellPrice(0x7FFFFFFF, 0x80, 2, 1), -1);
});

console.log("[2] vendor price DIRECTION (the 2026-10-05 fix)");
check("the player PAYS sellMultiplier (1.5), not buyMultiplier", () => {
  const item = { value: 100, stackSize: 1, itemType: 0x80 };
  assert.equal(vendorPurchasePrice(item, VENDOR, 1), 150,
    "NEGATIVE CONTROL: the old bar charged buyMultiplier → 90");
});
check("the vendor PAYS buyMultiplier (0.9), not sellMultiplier", () => {
  const item = { value: 100, stackSize: 1, itemType: 0x80 };
  assert.equal(vendorSaleCredit(item, VENDOR, 1), 90,
    "NEGATIVE CONTROL: the old bar credited sellMultiplier → 150");
});
check("a purchase always costs more than the same item sells back for", () => {
  const item = { value: 1234, stackSize: 1, itemType: 0x01 };
  assert.ok(vendorPurchasePrice(item, VENDOR, 1) > vendorSaleCredit(item, VENDOR, 1));
});
check("stacks price per unit × quantity (value / stackSize)", () => {
  const arrows = { value: 500, stackSize: 100, itemType: 0x100 }; // 5 p each
  assert.equal(unitValueOf(arrows), 5);
  assert.equal(vendorPurchasePrice(arrows, VENDOR, 20), shopSellPrice(5, 0x100, 1.5, 20));
  assert.equal(vendorSaleCredit(arrows, VENDOR, 100), 450);
});

console.log("[3] VendorProfile::InqAcceptability + VendorSellUI strings");
const PICKY = {
  buyAcceptCategories: 0x01 | 0x02, // melee + armor
  minValue: 10, maxValue: 5000, hasNoMin: false, hasNoMax: false,
};
check("wrong item type → 'That item cannot be sold here'", () => {
  const code = vendorAcceptability(PICKY, { itemType: 0x80, value: 100, stackSize: 1 });
  assert.equal(code, VENDOR_ACCEPT.WRONG_TYPE);
  assert.equal(vendorRejectText(code), "That item cannot be sold here");
});
check("zero value → no-value message", () => {
  assert.equal(vendorAcceptability(PICKY, { itemType: 0x01, value: 0, stackSize: 1 }), VENDOR_ACCEPT.NO_VALUE);
});
check("below min / above max (per unit)", () => {
  assert.equal(vendorAcceptability(PICKY, { itemType: 0x01, value: 5, stackSize: 1 }), VENDOR_ACCEPT.TOO_CHEAP);
  assert.equal(vendorAcceptability(PICKY, { itemType: 0x01, value: 9000, stackSize: 1 }), VENDOR_ACCEPT.TOO_VALUABLE);
  assert.equal(vendorAcceptability(PICKY, { itemType: 0x01, value: 9000, stackSize: 3 }), VENDOR_ACCEPT.OK);
});
check("promissory notes are exempt from the max cap", () => {
  const v = { ...PICKY, buyAcceptCategories: 0x40000 };
  assert.equal(vendorAcceptability(v, { itemType: 0x40000, value: 250000, stackSize: 1 }), VENDOR_ACCEPT.OK);
});
check("no profile = no client-side restriction", () => {
  assert.equal(vendorAcceptability({}, { itemType: 0x80, value: 1, stackSize: 1 }), VENDOR_ACCEPT.OK);
});

console.log("[3b] sell staging (VendorSellUI::DragItemAcceptable + gmVendorUI::AddItem)");
const SELL_VENDOR = { ...PICKY, buyAcceptCategories: 0x01 | 0x02 | 0x100 | 0x200, minValue: 1, maxValue: 50000 };
const PACK = 0x80000020;
const SELL_ROWS = [
  { guid: PACK, name: "Sack", itemType: 0x200, value: 50, stackSize: 1, equipMask: 0, containerId: 0 },
  { guid: 0x80000021, name: "Arrow", itemType: 0x100, value: 500, stackSize: 100, equipMask: 0, containerId: PACK },
  { guid: 0x80000022, name: "Mace", itemType: 0x01, value: 90, stackSize: 1, equipMask: 0, containerId: PACK },
  { guid: 0x80000023, name: "Apple", itemType: 0x20, value: 5, stackSize: 3, equipMask: 0, containerId: PACK },
  { guid: 0x80000030, name: "Empty Pouch", itemType: 0x200, value: 40, stackSize: 1, equipMask: 0, containerId: 0 },
  { guid: 0x80000031, name: "Iron Sword", itemType: 0x01, value: 300, stackSize: 1, equipMask: 0x100000, containerId: 0 },
  { guid: 0x80000032, name: "Arrowhead", itemType: 0x100, value: 400, stackSize: 40, equipMask: 0, containerId: 0 },
];
check("a pack with contents stages each ACCEPTED child at its whole stack, not the pack", () => {
  const plan = sellStagingPlan(SELL_ROWS, PACK, SELL_VENDOR);
  assert.equal(plan.reject, undefined);
  assert.equal(plan.message, "Selling contents of Sack");
  assert.deepEqual(plan.stage.map((r) => [r.guid, r.amount]), [[0x80000021, 100], [0x80000022, 1]],
    "the Apple (food — wrong type) is skipped quietly; the Sack is not staged");
});
check("an EMPTY pack is an ordinary item (staged itself)", () => {
  const plan = sellStagingPlan(SELL_ROWS, 0x80000030, SELL_VENDOR);
  assert.deepEqual(plan.stage.map((r) => [r.guid, r.amount]), [[0x80000030, 1]]);
});
check("a single stack is always staged whole (amount === stackSize)", () => {
  const plan = sellStagingPlan(SELL_ROWS, 0x80000032, SELL_VENDOR);
  assert.deepEqual(plan.stage.map((r) => [r.guid, r.amount]), [[0x80000032, 40]]);
});
check("wielded / unacceptable / not carried are refused with retail text", () => {
  assert.match(sellStagingPlan(SELL_ROWS, 0x80000031, SELL_VENDOR).reject, /^Unequip Iron Sword/);
  assert.equal(sellStagingPlan(SELL_ROWS, 0x80000023, SELL_VENDOR).reject, "That item cannot be sold here");
  assert.equal(sellStagingPlan(SELL_ROWS, 0x8000FFFF, SELL_VENDOR).reject, "You can only sell items you are carrying");
});

console.log("[4] purse + formatting");
check("countCurrency sums pyreal stacks only", () => {
  const inv = [
    { wcid: PYREAL_WCID, stackSize: 25000 }, { wcid: PYREAL_WCID, stackSize: 120 },
    { wcid: 20630, stackSize: 3 },
  ];
  assert.equal(countCurrency(inv), 25120);
  assert.equal(countCurrency(inv, 20630), 3);
  assert.equal(countCurrency([]), 0);
});
check("fmtNumber groups thousands; fmtCompact fits a 38-px cell", () => {
  assert.equal(fmtNumber(1234567), "1,234,567");
  assert.equal(fmtCompact(950), "950");
  assert.equal(fmtCompact(9950), "9,950");
  assert.equal(fmtCompact(12500), "12.5k");
  assert.equal(fmtCompact(250000), "250k");
  assert.equal(fmtCompact(1200000), "1.2M");
  assert.equal(fmtCompact(25000000), "25M");
});

console.log("[5] range (retail ObjectRangeHandler with use-cylinders)");
check("trade closes past 5.0 + the two collision radii, not at 24 m", () => {
  const me = { x: 0, y: 0 };
  assert.equal(isOutOfRange(me, { x: TRADE_RANGE + CYLINDER_RADII_ALLOWANCE - 0.01, y: 0 }, TRADE_RANGE), false);
  assert.equal(isOutOfRange(me, { x: 6.5, y: 0 }, TRADE_RANGE), true);
  assert.equal(isOutOfRange(me, null, TRADE_RANGE), false, "unknown position never closes");
});

console.log("[6] secure-trade status / Trade-button state");
check("ghosted while nothing is offered (UpdateTradeButtonState → 13)", () => {
  const s = tradeStatus({ myCount: 0, partnerCount: 0 });
  assert.equal(s.buttonDisabled, true);
  assert.equal(s.buttonPressed, false);
});
check("pressed = you accepted; text says who we are waiting on", () => {
  const s = tradeStatus({ myCount: 1, partnerCount: 0, myAccepted: true, partnerName: "Bob" });
  assert.equal(s.buttonPressed, true);
  assert.equal(s.buttonDisabled, false);
  assert.match(s.text, /Waiting for Bob/);
});
check("partner accepted first → prompt to press Trade", () => {
  const s = tradeStatus({ myCount: 0, partnerCount: 2, partnerAccepted: true, partnerName: "Bob" });
  assert.match(s.text, /Bob has accepted/);
});

console.log("[7] housing");
check("map coords from cell id + local position (ACE GetMapCoordStr)", () => {
  // Holtburg-ish: landblock 0xA9B4, local (100, 50).
  // ew = (0xA9*192+100)/240 − 102 = 33.6833 → 33.6E ; ns = (0xB4*192+50)/240 − 102 = 42.2083 → 42.2N
  assert.equal(mapCoordsText(0xA9B40019, 100, 50), "42.2N, 33.6E");
  assert.equal(mapCoordsText(0x00000019, 12, 12), "101.9S, 101.9W");
  assert.equal(mapCoordsText(0x7F7F0001, 96, 96), "0.0N, 0.0E", "map centre");
  assert.equal(mapCoordsText(0xA9B40105, 10, 10), null, "indoor cells have no map coords");
  assert.equal(mapCoordsText(0, 1, 1), null);
});
check("rent due: free / ok / soon / overdue", () => {
  const now = 1_800_000_000;
  assert.equal(rentDueInfo(now, true, now).level, "free");
  assert.equal(rentDueInfo(now - 86400, false, now).level, "ok");
  assert.match(rentDueInfo(now - 86400, false, now).text, /^Due in 6d/);
  assert.equal(rentDueInfo(now - MAINTENANCE_PERIOD_SECONDS + 3600, false, now).level, "soon");
  assert.equal(rentDueInfo(now - MAINTENANCE_PERIOD_SECONDS - 1, false, now).level, "overdue");
});
check("house type names (never 'Undef' or a number)", () => {
  assert.equal(houseTypeName(1), "Cottage");
  assert.equal(houseTypeName(4), "Apartment");
  assert.equal(houseTypeName(0), "Dwelling");
  assert.equal(houseTypeName(99), "Dwelling");
});

console.log("[8] book paging");
check("clampPage keeps the index inside the book", () => {
  assert.equal(clampPage(5, 3), 2);
  assert.equal(clampPage(-1, 3), 0);
  assert.equal(clampPage(2, 0), 0);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
