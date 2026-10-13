// tests/house_panel_text.test.mjs — hud-ui-1 (2026-10-13).
//
// The house panel's maintenance + payment-list rules
// (plugins/commerce_logic.js), each re-derived from acclient.c:
//   - HouseSystem::GetRentPeriod (:486149): 30 days, 90 for an apartment —
//     the old panel used 7 days and printed "Overdue" from day 7 of every
//     paid-up 30-day period (ACE sends RentTime = the START of the period);
//   - HousePayment::GetName (:485769) plural rule, HousePaymentList::
//     ComposeText / ComposeText2 (:486081 / :486112), IsPaidInFull (:485423);
//   - gmHouseUI::DisplayRentTimes (:219228): next due = +2 periods when paid
//     or maintenance-free, +1 when unpaid; DisplayWarningText (:219354): the
//     RentPaid / RentNotPaid line (ConstructRentWarningMessage, :486209);
//   - DisplayPurchaseTimeText (:219403) + HasPurchaseWaitPeriodExpired;
//   - gmSlumlordUI::UpdateButtons (:249621): Buy only when the STAGED items
//     pay the buy list in full (AttemptToPay :485562, trade notes against
//     the coinstack row).
//
// Run from apps/holtburger-web/:  node tests/house_panel_text.test.mjs

import assert from "node:assert/strict";
import {
  houseRentPeriodSeconds, HOUSE_RENT_PERIOD_SECONDS, APARTMENT_RENT_PERIOD_SECONDS, MAINTENANCE_PERIOD_SECONDS,
  rentDueInfo, housePaymentName, composeHousePaymentText, composeHousePaymentText2, isHousePaidInFull,
  houseRentSchedule, houseRentWarning, houseRentWarningText, HOUSE_RENT_PAID_TEXT,
  housePurchaseWaitText, houseTimeText, HOUSE_PURCHASE_WAIT_SECONDS,
  housePaymentContribution, houseStagedRemaining, houseStagedPaidInFull,
  PYREAL_WCID, PROMISSORY_NOTE_TYPE,
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

const DAY = 86400;
const now = 1_800_000_000;
const pyreals = (num, paid = 0) => ({ num, paid, weenieId: PYREAL_WCID, name: "Pyreal", pluralName: "Pyreals" });
const writ = (num = 1, paid = 0) => ({ num, paid, weenieId: 6631, name: "Writ", pluralName: "" });

console.log("[1] rent period");
check("GetRentPeriod: 30 days, 90 for an apartment (houseType 4)", () => {
  assert.equal(HOUSE_RENT_PERIOD_SECONDS, 2_592_000);
  assert.equal(APARTMENT_RENT_PERIOD_SECONDS, 7_776_000);
  assert.equal(houseRentPeriodSeconds(1), 2_592_000, "cottage");
  assert.equal(houseRentPeriodSeconds(2), 2_592_000, "villa");
  assert.equal(houseRentPeriodSeconds(3), 2_592_000, "mansion");
  assert.equal(houseRentPeriodSeconds(4), 7_776_000, "apartment");
  assert.equal(houseRentPeriodSeconds(undefined), 2_592_000);
  assert.equal(MAINTENANCE_PERIOD_SECONDS, 30 * DAY, "the old name is the landscape period, not 7 days");
});

check("a cottage 8 days into its period is NOT overdue — the period ends in 22 days", () => {
  const due = rentDueInfo(now - 8 * DAY, false, now, { houseType: 1 });
  assert.notEqual(due.level, "overdue");
  assert.doesNotMatch(due.text, /Overdue/);
  assert.match(due.text, /22d 0h/);
  assert.equal(due.level, "ok");
  const s = houseRentSchedule({ rentTime: now - 8 * DAY, houseType: 1 });
  assert.equal(s.periodEnds - now, 22 * DAY);
});

check("an apartment uses 90 days (60 days in → 30 left)", () => {
  const due = rentDueInfo(now - 60 * DAY, false, now, { houseType: 4 });
  assert.match(due.text, /30d 0h/);
  assert.equal(houseRentSchedule({ rentTime: now - 60 * DAY, houseType: 4 }).periodEnds - now, 30 * DAY);
});

check("never 'Overdue': without a rent list a past period end only asks for a re-query", () => {
  for (const back of [7 * DAY + 1, 29 * DAY, 30 * DAY + 1, 400 * DAY]) {
    const due = rentDueInfo(now - back, false, now);
    assert.notEqual(due.level, "overdue", `rentTime = now - ${back}`);
    assert.doesNotMatch(due.text, /Overdue/);
  }
  assert.match(rentDueInfo(now - 30 * DAY - 1, false, now).text, /Period ended/);
  assert.equal(rentDueInfo(now - 30 * DAY + 3600, false, now).level, "soon", "< 2 days left, no verdict");
  assert.equal(rentDueInfo(now, true, now).level, "free");
  assert.equal(rentDueInfo(0, false, now).text, "Unknown");
});

check("with the rent list the summary says paid / unpaid", () => {
  assert.equal(rentDueInfo(now - DAY, false, now, { rent: [pyreals(10, 10)] }).level, "paid");
  assert.equal(rentDueInfo(now - DAY, false, now, { rent: [pyreals(10, 5)] }).level, "unpaid");
});

console.log("[2] HousePayment::GetName + ComposeText");
check("GetName: num 1 → name; else the plural name, or name + s / es", () => {
  assert.equal(housePaymentName({ num: 1, name: "Pyreal", pluralName: "Pyreals" }), "Pyreal");
  assert.equal(housePaymentName({ num: 10, name: "Pyreal", pluralName: "" }), "Pyreals");
  assert.equal(housePaymentName({ num: 2, name: "Box", pluralName: "" }), "Boxes");
  assert.equal(housePaymentName({ num: 2, name: "Glass", pluralName: "" }), "Glasses");
  assert.equal(housePaymentName({ num: 0, name: "Writ", pluralName: "" }), "Writs", "num 0 is plural too");
  assert.equal(housePaymentName({ num: 3, name: "Box", pluralName: "Crates of Boxes" }), "Crates of Boxes",
    "an explicit plural wins");
  assert.equal(housePaymentName({ num: 3, name: "BOX", pluralName: "" }), "BOXs", "the s / x test is lowercase only");
});

check("ComposeText 'num name, …' and ComposeText2 'paid/num name, …'", () => {
  const list = [pyreals(10, 5), writ(1, 0)];
  assert.equal(composeHousePaymentText(list), "10 Pyreals, 1 Writ");
  assert.equal(composeHousePaymentText2(list), "5/10 Pyreals, 0/1 Writ");
  assert.equal(composeHousePaymentText2([{ num: 10, paid: 5, name: "Pyreal", pluralName: "" }, writ()]),
    "5/10 Pyreals, 0/1 Writ");
  assert.equal(composeHousePaymentText([]), "");
  assert.equal(composeHousePaymentText(undefined), "");
});

check("IsPaidInFull: every row paid ≥ num; empty = paid", () => {
  assert.equal(isHousePaidInFull([pyreals(10, 10), writ(1, 1)]), true);
  assert.equal(isHousePaidInFull([pyreals(10, 10), writ(1, 0)]), false);
  assert.equal(isHousePaidInFull([pyreals(10, 12)]), true);
  assert.equal(isHousePaidInFull([]), true);
});

console.log("[3] DisplayRentTimes / DisplayWarningText");
check("next due = +2 periods when paid, +1 when unpaid, +2 when maintenance-free", () => {
  const start = now - 5 * DAY;
  const P = 30 * DAY;
  const paid = houseRentSchedule({ rentTime: start, houseType: 1, rent: [pyreals(10, 10)] });
  assert.equal(paid.periodEnds, start + P);
  assert.equal(paid.nextDue, start + 2 * P);
  assert.equal(paid.paid, true);
  const unpaid = houseRentSchedule({ rentTime: start, houseType: 1, rent: [pyreals(10, 3)] });
  assert.equal(unpaid.nextDue, start + P);
  assert.equal(unpaid.paid, false);
  const free = houseRentSchedule({ rentTime: start, houseType: 1, maintenanceFree: true });
  assert.equal(free.nextDue, start + 2 * P);
  const apt = houseRentSchedule({ rentTime: start, houseType: 4, rent: [pyreals(10, 10)] });
  assert.equal(apt.nextDue, start + 2 * 90 * DAY);
});

check("no rent list (stale pkg/) → period end only, no next-due, no verdict", () => {
  const s = houseRentSchedule({ rentTime: now, houseType: 1 });
  assert.equal(s.periodEnds, now + 30 * DAY);
  assert.equal(s.nextDue, null);
  assert.equal(s.paid, null);
  assert.equal(houseRentWarning({ rentTime: now, houseType: 1 }), null);
});

check("the warning line: unpaid → RentNotPaid (red) ConstructRentWarningMessage; paid → green", () => {
  const unpaid = houseRentWarning({ rentTime: now, houseType: 1, rent: [pyreals(10, 0)] });
  assert.equal(unpaid.level, "unpaid");
  assert.equal(unpaid.text,
    "Warning!  You have not paid your maintenance costs for the last 30 day maintenance period.  "
    + "Please pay these costs by this deadline or you will lose your house, and all your items within it.");
  assert.match(houseRentWarningText(4), /for the last 90 day maintenance period/);
  const paid = houseRentWarning({ rentTime: now, houseType: 1, rent: [pyreals(10, 10)] });
  assert.equal(paid.level, "paid");
  assert.equal(paid.text, HOUSE_RENT_PAID_TEXT);
  assert.equal(HOUSE_RENT_PAID_TEXT,
    "The maintenance has already been paid for this period. You may not prepay next period's maintenance.");
  assert.equal(houseRentWarning({ rentTime: now, houseType: 1, maintenanceFree: true, rent: [pyreals(10, 0)] }).level,
    "paid", "maintenance-free counts as paid");
});

console.log("[4] DisplayPurchaseTimeText");
check("the 30-day re-buy wait (PropertyInt 199)", () => {
  assert.equal(HOUSE_PURCHASE_WAIT_SECONDS, 30 * DAY);
  assert.equal(housePurchaseWaitText(0, false, now), "You may buy another house immediately.");
  assert.equal(housePurchaseWaitText(now - 31 * DAY, true, now),
    "You may buy another house immediately after you abandon this one.");
  const fmt = (t) => `<${t}>`;
  assert.equal(housePurchaseWaitText(now - 10 * DAY, true, now, fmt),
    `You may buy another landscape house at <${now + 20 * DAY}>. This restriction does not apply to apartments.`);
  assert.equal(houseTimeText(0), "N/A", "ConvertTime(0)");
  assert.notEqual(houseTimeText(now), "N/A");
});

console.log("[5] slumlord Buy gate");
check("staged items: stack size per wcid, trade notes pay pyreals by value", () => {
  assert.deepEqual(housePaymentContribution({ wcid: 273, stackSize: 5000, itemType: 0x40, value: 5000 }),
    { wcid: 273, amount: 5000, tradeNote: false });
  assert.deepEqual(housePaymentContribution({ wcid: 6631, stackSize: 0, itemType: 0x80, value: 0 }),
    { wcid: 6631, amount: 1, tradeNote: false }, "GetHousePayment: stack 0 → 1");
  assert.deepEqual(housePaymentContribution({ wcid: 20630, stackSize: 2, itemType: PROMISSORY_NOTE_TYPE, value: 500000 }),
    { wcid: PYREAL_WCID, amount: 500000, tradeNote: true });
});

check("Buy enables only when the staged items cover every row (server paid ignored)", () => {
  const price = [pyreals(10000, 10000), writ(1, 1)]; // server-side paid must not count
  assert.deepEqual(houseStagedRemaining(price, []), [10000, 1]);
  assert.equal(houseStagedPaidInFull(price, []), false);
  const coins = { wcid: 273, stackSize: 6000, itemType: 0x40, value: 6000 };
  const note = { wcid: 20630, stackSize: 1, itemType: PROMISSORY_NOTE_TYPE, value: 5000 };
  const theWrit = { wcid: 6631, stackSize: 1, itemType: 0x80, value: 0 };
  assert.deepEqual(houseStagedRemaining(price, [coins]), [4000, 1]);
  assert.equal(houseStagedPaidInFull(price, [coins, theWrit]), false, "4000 pyreals short");
  assert.equal(houseStagedPaidInFull(price, [coins, note]), false, "the writ is missing");
  assert.equal(houseStagedPaidInFull(price, [coins, note, theWrit]), true);
  assert.deepEqual(houseStagedRemaining(price, [coins, coins, theWrit]), [0, 0], "capped at num");
  assert.equal(houseStagedPaidInFull([], []), true, "an empty list is paid");
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
