// tests/house_panel_dom.test.mjs — hud-ui-1 (2026-10-13).
//
// plugins/house-panel.js on a fake DOM (tests/helpers/fake_dom_items.mjs):
//   - the House tab prints gmHouseUI::DisplayHouseData's lines from the
//     HouseData snapshot's buy / rent lists (purchase price, "Rent" as
//     paid/num, Bought, period end, next due, the green paid line or the
//     red ConstructRentWarningMessage, the PropertyInt 199 re-buy wait) and
//     NEVER "Overdue" for a paid-up house 8 days into its 30-day period;
//   - a stale pkg/ (no lists) still renders, with no verdict;
//   - the slumlord pages show HouseProfile::ComposeText(Buy) /
//     ComposeText2(Rent) and Buy stays disabled until the staged items
//     cover the price (gmSlumlordUI::UpdateButtons).
//
// Run from apps/holtburger-web/:  node tests/house_panel_dom.test.mjs

import assert from "node:assert/strict";
import { installFakeDom, visibleText, FakeEvent } from "./helpers/fake_dom_items.mjs";

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.stack?.split("\n").slice(0, 3).join(" | ") ?? err}`);
  }
}

const DAY = 86400;
const PLAYER = 0x50000001;
const CRYSTAL = 0x7A9B4001;
const nowSec = () => Math.floor(Date.now() / 1000);
const pyreals = (num, paid) => ({ num, paid, weenieId: 273, name: "Pyreal", pluralName: "Pyreals" });
const writ = (num, paid) => ({ num, paid, weenieId: 6631, name: "Writ of Ownership", pluralName: "" });

let houseData = null;
let houseProfile = null;
let purchaseTs = 0;
const inv = [
  { guid: 0x80000001, wcid: 273, name: "Pyreal", value: 6000, stackSize: 6000, itemType: 0x40, iconId: 0, equipMask: 0, containerId: PLAYER },
  { guid: 0x80000002, wcid: 20630, name: "Trade Note (5,000)", value: 5000, stackSize: 1, itemType: 0x40000, iconId: 0, equipMask: 0, containerId: PLAYER },
  { guid: 0x80000003, wcid: 6631, name: "Writ of Ownership", value: 0, stackSize: 1, itemType: 0x80, iconId: 0, equipMask: 0, containerId: PLAYER },
];
const handle = {
  playerHouseStatus: () => undefined,
  playerHouseData: () => (houseData ? { ...houseData, free() {} } : undefined),
  playerHouseProfile: () => (houseProfile ? { ...houseProfile, free() {} } : undefined),
  playerHouseRestrictions: () => undefined,
  playerInventory: () => inv.map((i) => ({ ...i })),
  objectName: (g) => ((g >>> 0) === CRYSTAL ? "Covenant Crystal" : undefined),
  objectIntProperty: (g, stype) => ((g >>> 0) === PLAYER && stype === 199 ? purchaseTs : undefined),
  houseQuery() {},
};
Object.assign(globalThis, {
  __sessionHandle: handle,
  getLocalPlayerGuid: () => PLAYER,
});

await import("../plugins/house-panel.js");

const panel = () => document.getElementById("hb-house-panel");
const page = (id) => panel().querySelectorAll(".hhp-page").find((p) => p.dataset.page === id);
const pageText = (id) => visibleText(page(id));
const buttonOn = (root, label) => root.querySelectorAll("button").find((b) => b.textContent.includes(label));
function reopen(tab) {
  window.__closeHousePanel();
  window.__openHousePanel(tab);
}

console.log("[house tab]");
await check("paid-up cottage 8 days in: price, Rent paid/num, dates, green paid line — never Overdue", () => {
  houseData = {
    houseType: 1, landblockId: 0xA9B40019, posX: 100, posY: 50, posZ: 0, maintenanceFree: false,
    buyTime: nowSec() - 40 * DAY, rentTime: nowSec() - 8 * DAY,
    buy: [pyreals(10000, 10000), writ(1, 1)], rent: [pyreals(5000, 5000)],
  };
  purchaseTs = nowSec() - 40 * DAY;
  reopen("house");
  const t = pageText("house");
  assert.match(t, /Purchase price: 10000 Pyreals, 1 Writ of Ownership/);
  assert.match(t, /Rent: 5000\/5000 Pyreals/);
  assert.match(t, /Bought/);
  assert.match(t, /Period ends/);
  assert.match(t, /Next due/);
  assert.match(t, /42\.2N, 33\.6E/);
  assert.match(t, /The maintenance has already been paid for this period/);
  assert.doesNotMatch(t, /Overdue/);
  assert.doesNotMatch(t, /Warning!/);
  const paidNote = page("house").querySelector(".hhp-note.is-paid");
  assert.ok(paidNote, "the paid line carries the RentPaid colour class");
  assert.match(t, /You may buy another house immediately after you abandon this one\./);
});

await check("unpaid rent: the red ConstructRentWarningMessage (30-day period)", () => {
  houseData = { ...houseData, rent: [pyreals(5000, 1000)] };
  reopen("house");
  const t = pageText("house");
  assert.match(t, /Rent: 1000\/5000 Pyreals/);
  assert.match(t, /Warning! +You have not paid your maintenance costs for the last 30 day maintenance period/);
  assert.ok(page("house").querySelector(".hhp-note.is-unpaid"), "RentNotPaid colour class");
  assert.equal(page("house").querySelector(".hhp-note.is-paid"), null);
});

await check("re-buy wait inside 30 days names the date + the apartment exception", () => {
  purchaseTs = nowSec() - 3 * DAY;
  reopen("house");
  assert.match(pageText("house"), /You may buy another landscape house at .+\. This restriction does not apply to apartments\./);
});

await check("stale pkg/ (no lists): renders, no price / rent rows, no verdict, no Overdue", () => {
  houseData = {
    houseType: 1, landblockId: 0xA9B40019, posX: 100, posY: 50, posZ: 0, maintenanceFree: false,
    buyTime: nowSec() - 40 * DAY, rentTime: nowSec() - 25 * DAY,
  };
  reopen("house");
  const t = pageText("house");
  assert.match(t, /You own a house/);
  assert.match(t, /Period ends/);
  assert.doesNotMatch(t, /Purchase price|Next due|Warning!|already been paid|Overdue/);
});

console.log("[slumlord]");
function drop(which, guid) {
  const well = page(which).querySelector(".hhp-well");
  well.dispatchEvent(new FakeEvent("drop", {
    dataTransfer: { types: ["application/x-hb-inv-guid"], getData: () => String(guid) },
  }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await check("Buy page: ComposeText requirements; Buy enables only once the staged items cover them", async () => {
  houseData = null;
  houseProfile = {
    crystalGuid: CRYSTAL, dwellingId: 77, ownerId: 0, ownerName: "", houseType: 1, maintenanceFree: false,
    bitmask: 0, buy: [pyreals(10000, 0), writ(1, 0)], rent: [pyreals(5000, 0)],
  };
  // The 1 Hz profile watcher adopts the crystal (its first look only
  // records a baseline, so change the profile after it).
  await sleep(1100);
  houseProfile = { ...houseProfile, dwellingId: 78 };
  await sleep(1100);
  const t = pageText("buy");
  assert.match(t, /Covenant Crystal/);
  assert.match(t, /Price: 10000 Pyreals, 1 Writ of Ownership/);
  const buy = buttonOn(page("buy"), "Buy");
  drop("buy", 0x80000001); // 6000 pyreals
  assert.equal(buy.disabled, true, "4000 pyreals and the writ still owed");
  drop("buy", 0x80000003); // the writ
  assert.equal(buy.disabled, true, "still 4000 pyreals short");
  drop("buy", 0x80000002); // a 5000-pyreal trade note
  assert.equal(buy.disabled, false, "paid in full → Buy enabled");
  // The Maintenance page (hidden tab) shows ComposeText2.
  assert.match(page("maintenance").textContent, /Rent: 0\/5000 Pyreals/);
});

await check("an owned house's profile never enables Buy, whatever is staged", () => {
  houseProfile = { ...houseProfile, ownerId: 0x50000099, ownerName: "Someone" };
  window.__openHousePanel("buy");
  assert.equal(buttonOn(page("buy"), "Buy").disabled, true);
});

await check("stale pkg/ profile (no lists): Buy falls back to 'any item staged'", () => {
  const { buy: _b, rent: _r, ...noLists } = houseProfile;
  houseProfile = { ...noLists, ownerId: 0 };
  window.__openHousePanel("buy");
  assert.doesNotMatch(pageText("buy"), /Price:/);
  assert.equal(buttonOn(page("buy"), "Buy").disabled, false, "items are staged");
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
for (const k of ["__hbHouseProfileWatch"]) { try { clearInterval(globalThis[k]); } catch (_) {} }
window.__closeHousePanel?.();
process.exit(failed === 0 ? 0 : 1);
