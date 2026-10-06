// commerce_logic — pure (DOM-free) rules shared by the commerce / crafting /
// reading windows (vendor-ui, trade-panel, salvage-panel, tinker-panel,
// book-panel, house-panel). HUD overhaul 2026-10-05.
//
// Everything here is plain arithmetic / string building so it can be unit
// tested under node (tests/commerce_logic.test.mjs) without a DOM. Each rule
// cites the retail decomp function it mirrors.

// ─── Vendor prices ─────────────────────────────────────────────────────
//
// THE DIRECTION TRAP (fixed 2026-10-05). The VendorProfile wire block is
// `item_types, min_value, max_value, magic, buy_price, sell_price, …`
// (acclient.h `struct VendorProfile`; VendorProfile::UnPack reads
// buy_price then sell_price). `buy_price` is what the VENDOR PAYS when it
// buys from the player, `sell_price` what it CHARGES when it sells to the
// player:
//
//   VendorProfile::VendorSellPrice (acclient.c:509857) →
//       ShopSystem::SellPrice(unit, type, this->sell_price, subAmount)
//   VendorProfile::VendorBuyPrice  (acclient.c:509885) →
//       ShopSystem::BuyPrice(unit, type, this->buy_price, stackSize)
//
// ACE agrees (GameEventApproachVendor writes vendor.BuyPrice then
// vendor.SellPrice; Vendor.GetSellCost charges SellPrice, GetBuyCost pays
// BuyPrice), and the live ace_world data shows BuyPrice ≈ 0.5–0.9 and
// SellPrice ≈ 1.35–1.7. The wasm snapshot surfaces them as `buyMultiplier`
// (= buy_price, ~0.9) and `sellMultiplier` (= sell_price, ~1.5).
//
// The pre-overhaul vendor bar had both directions inverted: it charged the
// player `buyMultiplier` (so a 100 p item read ~90 p while ACE took 150 p)
// and credited sales at `sellMultiplier`. The wasm profile's per-stock
// `buyPrice` field is ShopSystem::BuyPrice(buy_price) — the vendor's
// BUY-BACK price — so it must not be shown as the purchase price either.

export const PROMISSORY_NOTE_TYPE = 0x40000; // ITEM_TYPE TYPE_PROMISSORY_NOTE

/** ShopSystem::SellPrice (acclient.c:719893) — what the player pays. */
export function shopSellPrice(unitValue, itemType, sellRate, numItem) {
  const rate = (itemType >>> 0) === PROMISSORY_NOTE_TYPE ? 1.15 : Number(sellRate) || 0;
  const raw = Math.ceil(rate * (Number(unitValue) || 0) * (Number(numItem) || 0) - 0.1);
  if (raw === 0) return 1;
  if (raw < 0 || raw > 0x7FFFFFFF) return -1;
  return raw;
}

/** ShopSystem::BuyPrice (acclient.c:719870) — what the vendor pays. */
export function shopBuyPrice(unitValue, itemType, buyRate, numItem) {
  const rate = (itemType >>> 0) === PROMISSORY_NOTE_TYPE ? 1.0 : Number(buyRate) || 0;
  const raw = Math.floor(rate * (Number(unitValue) || 0) * (Number(numItem) || 0) + 0.1);
  if (raw === 0) return 1;
  if (raw < 0 || raw > 0x7FFFFFFF) return -1;
  return raw;
}

/** Per-unit value of a (possibly stacked) item — `_value / _stackSize`
 *  as both VendorSellPrice and VendorBuyPrice compute it (unsigned
 *  integer division). */
export function unitValueOf(item) {
  const value = Math.max(0, Number(item?.value) || 0);
  const stack = Math.max(0, Number(item?.stackSize) || 0) | 0;
  return stack > 0 ? Math.floor(value / stack) : value;
}

/** Price the player pays for `qty` of a vendor stock entry. */
export function vendorPurchasePrice(item, vendor, qty = 1) {
  return shopSellPrice(unitValueOf(item), item?.itemType >>> 0, vendor?.sellMultiplier ?? 1, Math.max(1, qty | 0));
}

/** Pyreals the vendor pays for `qty` units of an inventory item. */
export function vendorSaleCredit(item, vendor, qty = 1) {
  return shopBuyPrice(unitValueOf(item), item?.itemType >>> 0, vendor?.buyMultiplier ?? 1, Math.max(1, qty | 0));
}

// VendorProfile::InqAcceptability (acclient.c:509817) result codes and the
// exact strings VendorSellUI::DragItemAcceptable (acclient.c:244306) shows.
export const VENDOR_ACCEPT = Object.freeze({
  OK: 0, WRONG_TYPE: 1, NO_VALUE: 2, TOO_CHEAP: 3, TOO_VALUABLE: 4,
});
const VENDOR_REJECT_TEXT = Object.freeze({
  1: "That item cannot be sold here",
  2: "That item has no value and cannot be sold",
  3: "That item is too cheap to sell here",
  4: "That item is too valuable to sell here",
});

/**
 * Would this vendor buy `item`? Mirrors InqAcceptability: the item type
 * must be in the vendor's `item_types` mask, the per-unit value non-zero
 * and inside [min_value, max_value] (−1 = no limit). A promissory note
 * over the cap is still accepted (the `~(type >> 16) & 4` term).
 * Fields we can't see client-side (BF_RETAINED) are left to the server.
 */
export function vendorAcceptability(vendor, item) {
  const types = (vendor?.buyAcceptCategories ?? 0xFFFFFFFF) >>> 0;
  const itemType = (item?.itemType ?? 0) >>> 0;
  if (itemType && !(types & itemType)) return VENDOR_ACCEPT.WRONG_TYPE;
  const unit = unitValueOf(item);
  if (!unit) return VENDOR_ACCEPT.NO_VALUE;
  const max = vendor?.maxValue;
  const min = vendor?.minValue;
  const noMax = vendor?.hasNoMax !== false || max == null || (max >>> 0) === 0xFFFFFFFF;
  const noMin = vendor?.hasNoMin !== false || min == null || (min >>> 0) === 0xFFFFFFFF;
  if (!noMax && unit > (max | 0)) {
    return (itemType & PROMISSORY_NOTE_TYPE) ? VENDOR_ACCEPT.OK : VENDOR_ACCEPT.TOO_VALUABLE;
  }
  if (!noMin && unit < (min | 0)) return VENDOR_ACCEPT.TOO_CHEAP;
  return VENDOR_ACCEPT.OK;
}

export function vendorRejectText(code) {
  return VENDOR_REJECT_TEXT[code] ?? "You cannot sell that here";
}

/** Sum of `stackSize` over inventory rows with this wcid (pyreals = 273;
 *  alt-currency vendors use their own wcid — ACE
 *  Vendor.BuyItems_ValidateTransaction counts GetNumInventoryItemsOfWCID). */
export const PYREAL_WCID = 273;
export function countCurrency(inventory, wcid = PYREAL_WCID) {
  let n = 0;
  for (const i of inventory || []) {
    if ((i?.wcid >>> 0) === (wcid >>> 0)) n += Math.max(1, Number(i.stackSize) || 1);
  }
  return n;
}

// ─── Number formatting ───────────────────────────────────────────────

/** "12,345" — full precision for totals and tooltips. */
export function fmtNumber(n) {
  if (!Number.isFinite(Number(n))) return "?";
  return Math.round(Number(n)).toLocaleString("en-US");
}

/** Compact price tag for a 36-px item cell: 950 · 9,950 · 12.5k · 1.2M. */
export function fmtCompact(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return "?";
  const a = Math.abs(v);
  if (a < 10000) return v.toLocaleString("en-US");
  if (a < 1e6) return `${(v / 1000).toFixed(a < 100000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(v / 1e6).toFixed(a < 1e7 ? 1 : 0).replace(/\.0$/, "")}M`;
}

// ─── Range checks (retail ObjectRangeHandler) ────────────────────────
//
// Both windows register a CPlayerSystem object-range handler that polls
// once a second with use-cylinders on. We only have centre positions, so
// add back the two collision-sphere radii (2 × 0.48, Setup 0x02000001).
export const CYLINDER_RADII_ALLOWANCE = 0.96;
// gmSecureTradeUI::RecvNotice_RegisterTrade (acclient.c:251880) registers
// the partner at range 5.0; OnObjectRangeExit → CloseTradeNegotiations.
export const TRADE_RANGE = 5.0;

export function horizontalDistance(a, b) {
  if (!a || !b) return NaN;
  return Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0));
}

export function isOutOfRange(a, b, range) {
  const d = horizontalDistance(a, b);
  return Number.isFinite(d) && d > range + CYLINDER_RADII_ALLOWANCE;
}

// ─── Secure trade ─────────────────────────────────────────────────────

/**
 * Player-facing status line + the retail Trade-button state for a trade
 * snapshot. gmSecureTradeUI::UpdateTradeButtonState (acclient.c:250986)
 * ghosts the button (state 13) while neither side has offered anything;
 * the button is a toggle — state 6 (pressed) = you accepted, clicking it
 * again declines (gmSecureTradeUI::ListenToElementMessage).
 */
export function tradeStatus(snap) {
  const mine = Number(snap?.myCount ?? 0);
  const theirs = Number(snap?.partnerCount ?? 0);
  const partner = snap?.partnerName || "your partner";
  const empty = mine + theirs === 0;
  let text;
  if (empty) text = "Drag items from your pack onto your side to offer them.";
  else if (snap?.myAccepted && snap?.partnerAccepted) text = "Both parties accepted — completing the trade…";
  else if (snap?.myAccepted) text = `Waiting for ${partner} to accept.`;
  else if (snap?.partnerAccepted) text = `${partner} has accepted. Press Trade to complete it.`;
  else text = "Both parties must press Trade to complete the exchange.";
  return {
    text,
    buttonDisabled: empty && !snap?.myAccepted,
    buttonPressed: !!snap?.myAccepted,
  };
}

// ─── Housing ─────────────────────────────────────────────────────────

/** ACE HouseType (Source/ACE.Entity/Enum/HouseType.cs). */
export const HOUSE_TYPE_NAMES = Object.freeze(["", "Cottage", "Villa", "Mansion", "Apartment"]);
export function houseTypeName(t) {
  return HOUSE_TYPE_NAMES[t >>> 0] || "Dwelling";
}

/**
 * Map coordinates for an outdoor position — ACE PositionExtensions
 * GetMapCoords/GetMapCoordStr: global = lb*192 + local, map = global/240 −
 * 102, printed as |v| − 0.05 to one decimal. Returns null for a dungeon /
 * indoor cell (low word ≥ 0x100) or missing data.
 */
export function mapCoordsText(cellId, posX, posY) {
  const id = cellId >>> 0;
  if (!id) return null;
  if ((id & 0xFFFF) >= 0x100) return null;
  if (!Number.isFinite(posX) || !Number.isFinite(posY)) return null;
  const gx = (id >>> 24) * 192 + posX;
  const gy = ((id >>> 16) & 0xFF) * 192 + posY;
  const ew = gx / 240 - 102;
  const ns = gy / 240 - 102;
  const f = (v) => Math.max(0, Math.abs(v) - 0.05).toFixed(1);
  return `${f(ns)}${ns >= 0 ? "N" : "S"}, ${f(ew)}${ew >= 0 ? "E" : "W"}`;
}

export const MAINTENANCE_PERIOD_SECONDS = 7 * 24 * 60 * 60;

/**
 * Rent-due summary for a HouseData snapshot. `rentTime` marks the start
 * of the current maintenance period; the next payment is one week later.
 * Returns { text, level } — level "ok" | "soon" (< 2 days) | "overdue" |
 * "free" so the panel can colour it.
 */
export function rentDueInfo(rentTime, maintenanceFree, nowSec = Math.floor(Date.now() / 1000)) {
  if (maintenanceFree) return { text: "Maintenance free this period", level: "free" };
  const start = rentTime >>> 0;
  if (!start) return { text: "Unknown", level: "ok" };
  const left = start + MAINTENANCE_PERIOD_SECONDS - nowSec;
  if (left <= 0) return { text: "Overdue — pay maintenance now", level: "overdue" };
  const days = Math.floor(left / 86400);
  const hours = Math.floor((left % 86400) / 3600);
  const text = days > 0 ? `Due in ${days}d ${hours}h` : (hours > 0 ? `Due in ${hours}h` : "Due within the hour");
  return { text, level: left < 2 * 86400 ? "soon" : "ok" };
}

// ─── Books ───────────────────────────────────────────────────────────

/** Clamp a page index into [0, total-1] (0 when the book is empty). */
export function clampPage(idx, total) {
  const n = Math.max(0, total | 0);
  if (n === 0) return 0;
  return Math.max(0, Math.min(n - 1, idx | 0));
}
