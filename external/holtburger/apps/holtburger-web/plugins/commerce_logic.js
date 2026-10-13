// commerce_logic — pure (DOM-free) rules shared by the commerce / crafting /
// reading windows (vendor-ui, trade-panel, salvage-panel, tinker-panel,
// book-panel, house-panel). HUD overhaul 2026-10-05.
//
// Everything here is plain arithmetic / string building so it can be unit
// tested under node (tests/commerce_logic.test.mjs) without a DOM. Each rule
// cites the retail decomp function it mirrors.

import {
  retailPluralName, packCapacity, MAIN_PACK_KEY, PACKS_KEY,
  DEFAULT_PLAYER_ITEMS_CAPACITY, DEFAULT_PLAYER_CONTAINERS_CAPACITY, rowUsesPackSlot,
} from "./inventory_helpers.js";

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

// ─── Vendor BUY side (OpenAC comparison round 5, 2026-10-08) ──────────
//
// vendor-buy-1: gmVendorUI::BuySingleItem (acclient.c:244716) and Buy All
// (HandleButtonClicks case 0x100000CA, :247055-247086) refuse in the client,
// money first, then room in the MAIN pack (GetNumContainedItems /
// GetNumContainedContainers count only the player's own lists), and keep the
// buying list. ACE refuses an unaffordable purchase with no text at all.
// vendor-buy-3: a non-stackable line is bought as `amount` objects, each
// priced alone (AdoptAsContents :244979 + VendorBuyUI::UpdateTransactionValue
// :245251); a finite stock entry is bounded by its supply; a buying-list
// entry may not accumulate past 5000 (VendorItemsUI::AddToBuyList :245946).

export const VENDOR_NO_MONEY_TEXT = "You don't have enough money";
export const VENDOR_NO_ROOM_TEXT = "You must empty some slots in your backpack first";
export const VENDOR_TOO_MUCH_TEXT =
  "I can't possibly sell you that much! Please be a little more reasonable.";
export const VENDOR_MAX_QUEUED = 5000;

/** Does a shop item need a container slot? (BF_REQUIRES_PACKSLOT or a
 *  capacity; the wasm `packSlot`, else the Container item type on a pkg
 *  that predates it.) */
export function vendorNeedsPackSlot(item) {
  if (typeof item?.packSlot === "boolean") return item.packSlot;
  return ((item?.itemType >>> 0) & 0x200) !== 0;
}

/** Is the shop item stackable? Unknown (stale pkg) = treat as stackable. */
function vendorStackable(item) {
  const ms = Number(item?.maxStackSize);
  return !(Number.isFinite(ms) && ms <= 1);
}

/**
 * gmVendorUI::InqListSlotCount (acclient.c:243174): a non-stackable line
 * takes `amount` slots, a stackable line one; container-class items count
 * as containers. `lines` = [{ item, amount }].
 */
export function vendorBuySlotsNeeded(lines) {
  const need = { items: 0, containers: 0 };
  for (const line of lines || []) {
    const n = Math.max(1, line?.amount | 0);
    const slots = vendorStackable(line?.item) ? 1 : n;
    if (vendorNeedsPackSlot(line?.item)) need.containers += slots;
    else need.items += slots;
  }
  return need;
}

/**
 * The player's main-pack room from inventory rows (rows of
 * inventory_helpers' row shape). A capacity of 0 (stats not in yet) uses the
 * usual player capacities, so nothing is refused before they arrive.
 */
export function vendorPlayerRoom(rows, { itemsCap = 0, containersCap = 0 } = {}) {
  const items = packCapacity(rows || [], MAIN_PACK_KEY, { mainCap: itemsCap });
  const packs = packCapacity(rows || [], PACKS_KEY, { packsCap: containersCap });
  return {
    used: { items: items.used, containers: packs.used },
    cap: {
      items: (itemsCap >>> 0) || DEFAULT_PLAYER_ITEMS_CAPACITY,
      containers: (containersCap >>> 0) || DEFAULT_PLAYER_CONTAINERS_CAPACITY,
    },
  };
}

/**
 * Retail's purchase refusal, or null: money first ("You don't have enough
 * money"), then room ("You must empty some slots in your backpack first").
 */
export function vendorBuyRefusal({ cost = 0, balance = 0, need, used, cap } = {}) {
  if (cost > balance) return VENDOR_NO_MONEY_TEXT;
  if (need && used && cap) {
    if (need.containers > cap.containers - used.containers) return VENDOR_NO_ROOM_TEXT;
    if (need.items > cap.items - used.items) return VENDOR_NO_ROOM_TEXT;
  }
  return null;
}

/**
 * The cost of a buying-list line. A non-stackable line is `amount` objects
 * priced one at a time; a stackable line is one lump
 * (VendorSellPrice(pwd, amount)) — today's price. Unknown stackability
 * (stale pkg) keeps the lump.
 */
export function vendorLineCost(item, vendor, amount = 1) {
  const n = Math.max(1, amount | 0);
  if (!vendorStackable(item)) {
    return n * shopSellPrice(unitValueOf(item), item?.itemType >>> 0, vendor?.sellMultiplier ?? 1, 1);
  }
  return vendorPurchasePrice(item, vendor, n);
}

/** How many more of a stock entry may be queued: supply minus what is
 *  queued, or Infinity for an unlimited entry (supply -1; ACE's 0 is
 *  unlimited too). */
export function vendorRemaining(item, queued = 0) {
  const supply = Number(item?.supply);
  return Number.isFinite(supply) && supply > 0 ? supply - (queued | 0) : Infinity;
}

/**
 * vendor-buy-5 — VendorItemsUI::OpenVendor's AddTypeFilter list (acclient.c:
 * 243983-244136), in retail order; a filter shows only when the vendor stocks
 * an item of that type (ListContainsType: `type & mask`).
 */
export const VENDOR_TYPE_FILTERS = Object.freeze([
  { id: "armor", label: "Armor", mask: 0x2 },
  { id: "books", label: "Books, Paper", mask: 0x2000 },
  { id: "clothing", label: "Clothing", mask: 0x4 },
  { id: "containers", label: "Containers", mask: 0x200 },
  { id: "food", label: "Food", mask: 0x20 },
  { id: "gems", label: "Gems", mask: 0x800 },
  { id: "jewelry", label: "Jewelry", mask: 0x8 },
  { id: "keys", label: "Keys, Tools", mask: 0x20004000 },
  { id: "misc", label: "Miscellaneous", mask: 0x490 },
  { id: "services", label: "Services", mask: 0x100000 },
  { id: "components", label: "Spell Components", mask: 0x1000 },
  { id: "tradenotes", label: "Trade Notes", mask: 0x40000 },
  { id: "weapons", label: "Weapons", mask: 0x101 },
  { id: "manastones", label: "Mana Stones", mask: 0x80000 },
  { id: "magic", label: "Magic Items", mask: 0x8000 },
  { id: "alchemy", label: "Alchemical Items", mask: 0x4800000 },
  { id: "cooking", label: "Cooking Items", mask: 0x400000 },
  { id: "fletching", label: "Fletching Items", mask: 0x9000000 },
]);

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

/**
 * What dropping an inventory item on the vendor stages for sale —
 * VendorSellUI::DragItemAcceptable (acclient.c:244306) then
 * gmVendorUI::AddItem (acclient.c:243845, _addContents = 1):
 *   - not carried → "You can only sell items you are carrying";
 *   - a pack WITH contents is accepted without its own acceptability test
 *     and is not staged itself: "Selling contents of <pack>", then every
 *     child the vendor accepts (_excludeIfUnacceptable — the rest are
 *     skipped quietly). An EMPTY pack is an ordinary item;
 *   - wielded → refused (ACE Player_Commerce will not sell a wielded item);
 *   - else InqAcceptability's rejection text, or the item itself.
 * Every staged row is a WHOLE stack (`amount = stackSize`):
 * VendorProfile::VendorBuyPrice (acclient.c:509885) prices the full
 * _stackSize, and ACE removes and pays for the whole stack whatever amount
 * the Sell message carries (Player_Commerce
 * TryRemoveFromInventoryWithNetworking) — a trimmed amount only made the
 * window show less than was sold.
 *
 * @param {Array<object>} rows  inventory rows (guid, containerId, equipMask,
 *   stackSize, value, itemType, name)
 * @returns {{stage: Array<object>, message?: string, reject?: string}}
 */
export function sellStagingPlan(rows, droppedGuid, vendor) {
  const g = droppedGuid >>> 0;
  const list = Array.isArray(rows) ? rows : [];
  const item = g ? list.find((r) => (r?.guid >>> 0) === g) : null;
  if (!item) return { stage: [], reject: "You can only sell items you are carrying" };
  const whole = (r) => ({ ...r, amount: Math.max(1, Number(r.stackSize) || 1) });
  const children = list.filter((r) => (r?.containerId >>> 0) === g);
  if (children.length > 0) {
    const stage = children
      .filter((c) => (c.equipMask >>> 0) === 0 && vendorAcceptability(vendor, c) === VENDOR_ACCEPT.OK)
      .map(whole);
    return { stage, message: `Selling contents of ${item.name || "the pack"}` };
  }
  if ((item.equipMask >>> 0) !== 0) return { stage: [], reject: `Unequip ${item.name || "it"} before selling it` };
  const code = vendorAcceptability(vendor, item);
  if (code !== VENDOR_ACCEPT.OK) return { stage: [], reject: vendorRejectText(code) };
  return { stage: [whole(item)] };
}

// ─── Split before sell (items-1 step 2, 2026-10-08) ──────────────────
//
// VendorSellUI::AcceptDragObject (acclient.c:246860): when the drag carries
// a split size (GenItemHolder::splitSize != maxSplitSize — the browser
// equivalent is a shift-drop + the stack-amount prompt) the stack is first
// split IN PLACE, ItemHolder::AttemptToPlaceInContainer(item, player,
// item's own container, autoMerge = 0) → a StackableSplitToContainer, with
// "Splitting the %s before selling them" (NAME_APPROPRIATE: plural for a
// stack); a refusal says "Cannot split the stack to sell it". The window
// then remembers the split's class id + size (m_splitItemClassID /
// m_splitItemStackSize) and VendorSellUI::ItemAttributesChanged (:246005)
// stages the NEW object of that wcid and exactly that stack size when it
// arrives — so only the split part is ever sold (a sale is always a whole
// stack, see sellStagingPlan).

/** How long a split waits for the server's new stack before it is dropped. */
export const SELL_SPLIT_TTL_MS = 10000;
export const SELL_SPLIT_FAILED_TEXT = "Cannot split the stack to sell it";

/**
 * Plan the split for selling `amount` of the staged stack `item` (a
 * sellStagingPlan row). Null when no split is needed (a whole stack, an
 * amount out of range or a single item).
 * @param {object} item  guid, wcid, name, stackSize, containerId
 * @param {number} amount  how many to sell (1 .. stackSize - 1)
 * @param {Array<object>} rows  the player's inventory right now
 * @param {object} opts  playerGuid (a main-pack row may carry containerId 0)
 * @returns {null | {reject: string} | {action: object, pending: object, message: string}}
 *   action = an item_drag.executeItemAction "move" with a split amount;
 *   pending = {sourceGuid, wcid, amount, containerId, name, preGuids}
 */
export function planSellSplit(item, amount, rows, { playerGuid } = {}) {
  const guid = (item?.guid >>> 0) || 0;
  const stack = Math.max(1, Number(item?.stackSize) || 1);
  const n = Math.floor(Number(amount));
  if (!guid || !(n >= 1) || n >= stack) return null;
  const me = (playerGuid >>> 0) || 0;
  const container = (item.containerId >>> 0) || me;
  if (!container || !(item.wcid >>> 0)) return { reject: SELL_SPLIT_FAILED_TEXT };
  const name = item.name || "item";
  return {
    action: {
      op: "move", guid, container, placement: 0,
      listKey: container === me ? 0 : container, index: 0, amount: n,
    },
    pending: {
      sourceGuid: guid,
      wcid: item.wcid >>> 0,
      amount: n,
      containerId: container,
      name,
      preGuids: (Array.isArray(rows) ? rows : []).map((r) => (r?.guid >>> 0) || 0).filter(Boolean),
    },
    message: `Splitting the ${retailPluralName(name, item.pluralName)} before selling them`,
  };
}

/**
 * VendorSellUI::ItemAttributesChanged for every split in flight: the first
 * inventory row of the split's wcid with exactly the split's stack size
 * that was NOT in the inventory when the split was sent (and is not the
 * source, nor already staged / claimed) is the new stack. Splits older than
 * `ttlMs` (no echo — the server merged or dropped it) expire.
 * @param {Array<object>} pending  planSellSplit().pending + `at` (ms)
 * @param {Array<object>} rows  the player's inventory now
 * @param {object} opts  claimed (Set of guids already staged), now, ttlMs
 * @returns {{staged: Array<{pending, row}>, waiting: Array<object>, expired: Array<object>}}
 */
export function resolveSellSplits(pending, rows, { claimed = null, now = Date.now(), ttlMs = SELL_SPLIT_TTL_MS } = {}) {
  const taken = new Set(claimed ? Array.from(claimed, (g) => g >>> 0) : []);
  const list = Array.isArray(rows) ? rows : [];
  const out = { staged: [], waiting: [], expired: [] };
  for (const p of Array.isArray(pending) ? pending : []) {
    const pre = new Set((p?.preGuids || []).map((g) => g >>> 0));
    const row = list.find((r) => {
      const g = (r?.guid >>> 0) || 0;
      return g !== 0 && g !== (p.sourceGuid >>> 0) && !pre.has(g) && !taken.has(g)
        && (r.wcid >>> 0) === (p.wcid >>> 0)
        && Math.max(1, Number(r.stackSize) || 1) === p.amount
        && (r.equipMask >>> 0) === 0;
    });
    if (row) {
      taken.add(row.guid >>> 0);
      out.staged.push({ pending: p, row });
    } else if (Number.isFinite(p?.at) && now - p.at > ttlMs) {
      out.expired.push(p);
    } else {
      out.waiting.push(p);
    }
  }
  return out;
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

// trade-2 (2026-10-08 round 2): the trade handler is registered with
// xy_only = 0, so ACCWeenieObject::ObjectsInRange (acclient.c:436730)
// measures in 3D (CPhysicsObj::get_distance_to_object → cylinder distance);
// a centre-to-centre 3D distance against range + both radii is the same test
// on the level and slightly more lenient straight up or down. The old XY-only
// distance kept a trade open between floors. Positions are AC frame (Z up);
// a missing z counts as 0.
export function distance3D(a, b) {
  if (!a || !b) return NaN;
  return Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0), (a.z ?? 0) - (b.z ?? 0));
}

export function isOutOfRange(a, b, range) {
  const d = distance3D(a, b);
  return Number.isFinite(d) && d > range + CYLINDER_RADII_ALLOWANCE;
}

// Consecutive polls the partner may be missing from the world before the
// trade closes: 2 × the 500 ms poll ≈ retail's 1.0 s handler interval, and
// a one-poll respawn gap rides through.
export const TRADE_PARTNER_MISS_LIMIT = 2;

/**
 * trade-2 — one poll of the secure-trade range handler. Retail
 * ObjectsInRange returns 0 when EITHER object is gone (GetObjectA fails), so
 * a partner who portalled, recalled or logged out closes the trade
 * (OnObjectRangeExit → CloseTradeNegotiations, acclient.c:251819); ACE
 * itself never closes a trade on teleport, and both players stayed
 * IsTrading. Our own position unknown (scene not ready) decides nothing.
 * @param {{me:object|null, them:object|null, misses?:number, range?:number}} p
 *   `misses` = consecutive polls the partner has been missing, this one
 *   included.
 * @returns {"close"|"ok"|"unknown"}
 */
export function tradeRangeVerdict({ me, them, misses = 0, range = TRADE_RANGE }) {
  if (!me) return "unknown";
  if (!them) return misses >= TRADE_PARTNER_MISS_LIMIT ? "close" : "ok";
  return isOutOfRange(me, them, range) ? "close" : "ok";
}

/**
 * charopt-4 — retail ClientTradeSystem::AttemptToTradeItem (acclient.c:
 * 410566) for an owned item dragged onto `target`: trading with that player
 * already → add it ("add"); trading with someone else → "You are already
 * trading with someone else." ("elsewhere"); no trade → open one
 * (ItemHolder::UseObject → AttemptToOpenTradeNegotiations :410538, which
 * refuses outside peace mode, combatMode 1: "You need to be in peace mode to
 * trade." — "peace") and add the item once it registers ("open").
 * @returns {"add"|"elsewhere"|"peace"|"open"}
 */
export function tradeItemAttempt({ partnerGuid = 0, target = 0, combatMode = 1 } = {}) {
  const partner = (partnerGuid >>> 0) || 0;
  if (partner !== 0) return partner === ((target >>> 0) || 0) ? "add" : "elsewhere";
  return ((combatMode >>> 0) || 1) === 1 ? "open" : "peace";
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

/**
 * hud-ui-5 — what one drop onto your side of the trade adds: retail
 * gmSecureTradeUI::AcceptDragObject / TradeAnItemForDummies →
 * AddItem(id, 0, 1, _addContents = 1, 0) (acclient.c 004CA780).
 *   • An object goes into the list only when it holds no items AND no
 *     containers; one already listed is skipped silently (ItemList_IsInList
 *     in DragItemAcceptable and AddItem — no message).
 *   • A pack holding items is never offered itself: retail shows the 0x1A
 *     notice "Trading contents of <name>" and runs AddItem on each contained
 *     ITEM (the containers list is not walked) with _addContents = 0, so a
 *     child that holds anything is skipped rather than opened.
 *   • An empty pack is offered as itself.
 *   • Wielded items are fine: DragItemAcceptable only tests IsOwnedByPlayer
 *     (true for `_wielderID == player`), and ACE HandleActionAddToTrade falls
 *     back to GetEquippedItem. The caller keeps the not-carried refusal.
 * ACE adds whatever guid it is sent with no container check, so offering a
 * non-empty pack would give the bag away with everything in it.
 * @param {object} item  the dropped inventory row (guid, name, itemType,
 *   requiresBackpackSlot?)
 * @param {Array<object>} rows  inventory rows (containerId = holder)
 * @param {Iterable<number>} listedGuids  guids already on your side
 * @returns {{guids:number[], notice:string|null}}  addToTrade order
 */
export function planTradeAdd(item, rows, listedGuids) {
  const plan = { guids: [], notice: null };
  const g = (item?.guid >>> 0) || 0;
  if (!g) return plan;
  const listed = new Set();
  for (const x of listedGuids || []) listed.add(x >>> 0);
  // DragItemAcceptable: the dropped object itself already listed → silent.
  if (listed.has(g)) return plan;
  const all = Array.isArray(rows) ? rows : [];
  const contents = (holder) => all.filter((r) => r && (r.containerId >>> 0) === holder && (r.guid >>> 0) !== holder);
  const held = contents(g);
  if (held.length === 0) {
    plan.guids.push(g);
    return plan;
  }
  // GetContainedItemsList = the ITEMS list; packs sit in the containers list.
  const items = held.filter((r) => !rowUsesPackSlot(r));
  if (items.length === 0) return plan;
  plan.notice = `Trading contents of ${String(item?.name || "").trim() || "the pack"}`;
  for (const c of items) {
    const cg = c.guid >>> 0;
    if (!cg || listed.has(cg) || plan.guids.includes(cg)) continue;
    if (contents(cg).length > 0) continue;
    plan.guids.push(cg);
  }
  return plan;
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

// hud-ui-1 (2026-10-13): retail's maintenance rules. The panel used to
// assume a 7-day period and print "Overdue — pay maintenance now" from day 7
// of every period, paid or not. ACE sends HouseData.RentTime as the START of
// the current period (House.GetRentTimestamp: RentInterval 30 days, ×3 for an
// apartment), and retail's gmHouseUI never counts down: DisplayHouseData
// (acclient.c:219515) prints the purchase price, "Rent: paid/num …", Bought,
// the period end, the next due date, the location, a paid / unpaid line keyed
// on HousePaymentList::IsPaidInFull(rent) and the 30-day re-buy wait.

/** ACE HouseType.Apartment — retail tests `m_type == 4`. */
export const HOUSE_TYPE_APARTMENT = 4;
/** HouseSystem::GetRentPeriod (acclient.c:486149): 2,592,000 s (30 days);
 *  7,776,000 s (90 days) for an apartment. */
export const HOUSE_RENT_PERIOD_SECONDS = 2_592_000;
export const APARTMENT_RENT_PERIOD_SECONDS = 7_776_000;
/** The landscape-house period under its pre-hud-ui-1 name (it was 7 days). */
export const MAINTENANCE_PERIOD_SECONDS = HOUSE_RENT_PERIOD_SECONDS;
/** HouseSystem::HasPurchaseWaitPeriodExpired (acclient.c:486143): `now −
 *  purchase_time > 2592000` (30 days after PropertyInt 199 HousePurchaseTimestamp). */
export const HOUSE_PURCHASE_WAIT_SECONDS = 2_592_000;

export function houseRentPeriodSeconds(houseType) {
  return (houseType >>> 0) === HOUSE_TYPE_APARTMENT ? APARTMENT_RENT_PERIOD_SECONDS : HOUSE_RENT_PERIOD_SECONDS;
}

/**
 * HousePayment::GetName (acclient.c:485769): `num` 1 → the name; otherwise
 * the plural name the server sent, or — when it is empty — the name + "es"
 * after a trailing 's' / 'x' (the decomp's 0x73 / 0x78 test), else + "s".
 * `p` = `{num, name, pluralName}` (a wasm HousePay row).
 */
export function housePaymentName(p) {
  const name = String(p?.name ?? "");
  if ((p?.num | 0) === 1) return name;
  const plural = String(p?.pluralName ?? "");
  if (plural) return plural;
  const last = name.slice(-1);
  return name + (last === "s" || last === "x" ? "es" : "s");
}

/** HousePaymentList::ComposeText (acclient.c:486081): "num name, …" — the
 *  slumlord Buy page and gmHouseUI's purchase price. */
export function composeHousePaymentText(list) {
  return (Array.isArray(list) ? list : []).map((p) => `${p.num | 0} ${housePaymentName(p)}`).join(", ");
}

/** HousePaymentList::ComposeText2 (acclient.c:486112): "paid/num name, …" —
 *  the slumlord Maintenance page and gmHouseUI's "Rent:" line. */
export function composeHousePaymentText2(list) {
  return (Array.isArray(list) ? list : []).map((p) => `${p.paid | 0}/${p.num | 0} ${housePaymentName(p)}`).join(", ");
}

/** HousePaymentList::IsPaidInFull (acclient.c:485423): every row has
 *  paid ≥ num (an empty list is paid). */
export function isHousePaidInFull(list) {
  return (Array.isArray(list) ? list : []).every((p) => (p.paid | 0) >= (p.num | 0));
}

/** gmHouseUI::DisplayWarningText (acclient.c:219354), RentPaid colour. */
export const HOUSE_RENT_PAID_TEXT =
  "The maintenance has already been paid for this period. You may not prepay next period's maintenance.";

/** HouseSystem::ConstructRentWarningMessage (acclient.c:486209) — the
 *  RentNotPaid line; `days` = GetRentPeriod / 86400. */
export function houseRentWarningText(houseType) {
  const days = Math.floor(houseRentPeriodSeconds(houseType) / 86400);
  return `Warning!  You have not paid your maintenance costs for the last ${days} day maintenance period.  `
    + "Please pay these costs by this deadline or you will lose your house, and all your items within it.";
}

/**
 * Maintenance dates for a HouseData snapshot — gmHouseUI::DisplayRentTimes
 * (acclient.c:219228). `periodEnds` = rentTime + period ("This maintenance
 * period ends"); `nextDue` = rentTime + 2 periods when the rent is paid in
 * full or the house is maintenance-free, + 1 period when it is not
 * ("Maintenance is next due"). `paid` is null when the snapshot has no rent
 * list (a pre-hud-ui-1 wasm) — then `nextDue` is null too: no verdict
 * without the list. Times are unix seconds (0 = unknown).
 */
export function houseRentSchedule(data) {
  const rentTime = (data?.rentTime >>> 0) || 0;
  const period = houseRentPeriodSeconds(data?.houseType);
  const free = !!data?.maintenanceFree;
  const rent = Array.isArray(data?.rent) ? data.rent : null;
  const paid = free ? true : (rent ? isHousePaidInFull(rent) : null);
  const periodEnds = rentTime ? rentTime + period : 0;
  const nextDue = !rentTime || paid === null ? null : rentTime + (paid ? 2 : 1) * period;
  return { period, periodEnds, nextDue, paid, free };
}

/**
 * The paid / unpaid line — gmHouseUI::DisplayWarningText (acclient.c:219354):
 * maintenance-free or IsPaidInFull(rent) → the RentPaid text (level "paid"),
 * otherwise ConstructRentWarningMessage (level "unpaid"). null when the
 * rent list is unknown.
 */
export function houseRentWarning(data) {
  const { paid } = houseRentSchedule(data);
  if (paid === null) return null;
  return paid
    ? { text: HOUSE_RENT_PAID_TEXT, level: "paid" }
    : { text: houseRentWarningText(data?.houseType), level: "unpaid" };
}

/**
 * gmHouseUI::DisplayPurchaseTimeText (acclient.c:219403) — the last line,
 * from PlayerDesc PropertyInt 199 (`purchaseTime`, 0 when unset).
 * `fmtTime(sec)` renders the date (retail strftime "%c").
 */
export function housePurchaseWaitText(purchaseTime, ownsHouse, nowSec = Math.floor(Date.now() / 1000),
  fmtTime = houseTimeText) {
  const t = Number(purchaseTime) || 0;
  if (nowSec - t > HOUSE_PURCHASE_WAIT_SECONDS) {
    return ownsHouse
      ? "You may buy another house immediately after you abandon this one."
      : "You may buy another house immediately.";
  }
  return `You may buy another landscape house at ${fmtTime(t + HOUSE_PURCHASE_WAIT_SECONDS)}`
    + ". This restriction does not apply to apartments.";
}

/** HouseSystem::ConvertTime (acclient.c:486178, strftime "%c"): the local
 *  date + time, "N/A" for 0. */
export function houseTimeText(sec) {
  const t = Number(sec) || 0;
  if (!t) return "N/A";
  try { return new Date(t * 1000).toLocaleString(); } catch (_) { return "N/A"; }
}

/**
 * Countdown summary for a HouseData snapshot (not a retail line — kept for
 * callers that want one). Uses the retail period (30 / 90 days from
 * `rentTime`, the start of the current period) and never claims "Overdue":
 * without the rent list there is no paid / unpaid verdict, and a period
 * that has already ended means the snapshot is stale (ACE rolls the period
 * or evicts), so it says to query again. `opts` = `{houseType, rent}`.
 * Returns { text, level } — level "ok" | "soon" (< 2 days) | "paid" |
 * "unpaid" | "free".
 */
export function rentDueInfo(rentTime, maintenanceFree, nowSec = Math.floor(Date.now() / 1000), opts = {}) {
  if (maintenanceFree) return { text: "Maintenance free this period", level: "free" };
  const start = rentTime >>> 0;
  if (!start) return { text: "Unknown", level: "ok" };
  const { periodEnds, paid } = houseRentSchedule({ rentTime: start, houseType: opts?.houseType, rent: opts?.rent });
  const left = periodEnds - nowSec;
  if (left <= 0) return { text: "Period ended — press Query House", level: "ok" };
  const days = Math.floor(left / 86400);
  const hours = Math.floor((left % 86400) / 3600);
  const span = days > 0 ? `${days}d ${hours}h` : (hours > 0 ? `${hours}h` : "under an hour");
  if (paid === true) return { text: `Paid — period ends in ${span}`, level: "paid" };
  if (paid === false) return { text: `Unpaid — due in ${span}`, level: "unpaid" };
  return { text: `Period ends in ${span}`, level: left < 2 * 86400 ? "soon" : "ok" };
}

// ─── Slumlord payment staging ────────────────────────────────────────
//
// gmSlumlordUI (acclient.c) stages payment items against the profile's
// list: AddItem (:249666) builds HousePayment{wcid, ACCWeenieObject::
// GetHousePayment = stack size, 0 → 1} and HouseProfile::Pay →
// HousePaymentList::AttemptToPay (:485562) adds it to the FIRST row with that
// wcid (capped at num) — or, for a trade note against the coinstack row,
// HousePayment::PayWithTradeNote (the note's pyreal value). RefreshHouse /
// CleanItemLists clear every row's `paid` first, so only staged items count.
// UpdateButtons (:249621) enables Buy only for an unowned house whose buy
// list IsPaidInFull. ACE (Player_House.GetTotalPyreals / GetTotalTradeNotes)
// sums the coin stacks' and the trade notes' Value.

/** What one staged inventory row pays: `{wcid, amount}`. A trade note
 *  (ITEM_TYPE TYPE_PROMISSORY_NOTE) pays pyreals worth its stack Value. */
export function housePaymentContribution(item) {
  const stack = Math.floor(Number(item?.stackSize) || 0);
  if (((item?.itemType >>> 0) & PROMISSORY_NOTE_TYPE) !== 0) {
    return { wcid: PYREAL_WCID, amount: Math.max(0, Math.floor(Number(item?.value) || 0)), tradeNote: true };
  }
  return { wcid: item?.wcid >>> 0, amount: stack > 0 ? stack : 1, tradeNote: false };
}

/** Per-row amount still owed after the staged items (`staged` = inventory
 *  rows; the server's `paid` is ignored, as CleanItemLists cleared it). */
export function houseStagedRemaining(required, staged) {
  const rows = Array.isArray(required) ? required : [];
  const paid = rows.map(() => 0);
  for (const item of Array.isArray(staged) ? staged : []) {
    const c = housePaymentContribution(item);
    if (c.amount <= 0) continue;
    const i = rows.findIndex((r) => (r.weenieId >>> 0) === c.wcid);
    if (i < 0) continue;
    paid[i] = Math.min(rows[i].num | 0, paid[i] + c.amount);
  }
  return rows.map((r, i) => Math.max(0, (r.num | 0) - paid[i]));
}

/** HouseProfile::IsPaidInFull(Buy_House) over the staged items. */
export function houseStagedPaidInFull(required, staged) {
  return houseStagedRemaining(required, staged).every((n) => n <= 0);
}

// ─── Books ───────────────────────────────────────────────────────────

/** Clamp a page index into [0, total-1] (0 when the book is empty). */
export function clampPage(idx, total) {
  const n = Math.max(0, total | 0);
  if (n === 0) return 0;
  return Math.max(0, Math.min(n - 1, idx | 0));
}
