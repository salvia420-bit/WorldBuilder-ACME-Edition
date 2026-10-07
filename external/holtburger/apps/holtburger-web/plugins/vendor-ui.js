/**
 * vendor-ui — the Vendor window (retail gmVendorUI, layout 0x21000012).
 *
 * HUD overhaul 2026-10-05 — rebuilt on the shared HUD kit.
 *
 * Retail draws gmVendorUI as an 800×110 strip at the bottom of the
 * 800×600 canvas: a 20-px tab strip (Items / Buying / Selling, sprite
 * 0x06005F10) with the 22×20 close (0x060012AA) at the right, and each
 * page = item-name/cost text at the top, a 32-px item list with a
 * horizontal rope scrollbar (0x06004C7F), red 64×22 Buy / Add to List /
 * Buy All / Sell All buttons (0x06004C4C) on the right and small
 * Clear Item / Clear List buttons (0x060012BA / brown 0x06001927).
 *
 * We keep that identity — a wide, short strip docked low on the screen,
 * the same three tabs, red buttons on the right, the item list in the
 * middle — and take the modern liberties the single 32-px row could not
 * carry: a wrapping item grid with a price under every icon (red when
 * you can't afford it), a details column that always shows the selected
 * item's price, your purse, and the buy/sell totals, quantity inputs, and
 * an always-visible purse on the tab strip. The window docks bottom-left
 * above the chat/toolbar and stops short of the right-hand main panel so
 * inventory → vendor drags never have to cross it; it is draggable and
 * remembers where you put it (attachWindowPosition, id 0x100000B7 =
 * RootVendor_Field).
 *
 * PRICES — fixed 2026-10-05 (see plugins/commerce_logic.js): the player
 * pays ShopSystem::SellPrice(unit, type, sell_price, n) and is paid
 * ShopSystem::BuyPrice(unit, type, buy_price, n). The old bar had the
 * two vendor rates swapped, so every price it showed was wrong by the
 * vendor's spread.
 *
 * Wire wiring (DO NOT regress):
 *   - Buy:  handle.buyFromVendor(vendorGuid, [vendorItemGuid…], [amount…])
 *           wire: GameAction::Buy 0x005F, object_guid per profile = vendor's
 *           per-stock-entry WO GUID. NOT wcid — ACE keys
 *           DefaultItemsForSale/UniqueItemsForSale by ObjectGuid in
 *           Vendor.BuyItems_ValidateTransaction (PR-EE 2026-05-22 fix).
 *           Multi-item per call to mirror retail's atomic
 *           gmVendorUI::SendShopEvent flush.
 *   - Sell: handle.sellToVendor(vendorGuid, [itemGuid…], [amount…])
 *           wire: GameAction::Sell 0x0060, object_guid per profile = player's
 *           inventory item GUID.
 *   - Vendor list via `kind=12 VendorOpened` → handle.getVendorState(guid).
 *   - Auto-refresh on `playerInventoryChanged` (re-pull vendor state so
 *     stock / alt-currency stay accurate after a buy or sell).
 *   - Drops: `application/x-hb-inv-guid` / `text/x-hb-item-guid`
 *     (DropItemFlags.VENDOR) anywhere on the window → Selling tab, like
 *     retail VendorSellUI::AddItemToSell (UIElement_Panel::OpenTab
 *     0x100000BB, then gmVendorUI::AddItem), gated by
 *     VendorSellUI::DragItemAcceptable's retail rejection strings.
 */

import { setAcText } from "../ui/ac_font.js";
import { formatAppraisalTooltip } from "./inventory_helpers.js";
import { DropItemFlags } from "./drop_item_flags.js";
import { vendorRangeVerdict, VENDOR_FALLBACK_RANGE_M } from "./vendor_range.js";
import {
  createKitWindow, COMMERCE_WINDOW_ID, KIT_COLOR, kitButton, fillSlotIcon,
  wireDropTarget, inventoryRows, entityWorldPos, localPlayerWorldPos, devHex,
} from "./commerce_window.js";
import {
  vendorPurchasePrice, vendorSaleCredit, vendorAcceptability, vendorRejectText,
  VENDOR_ACCEPT, countCurrency, PYREAL_WCID, fmtNumber, fmtCompact,
} from "./commerce_logic.js";

const OVERLAY_ID = "hb-vendor-bar";
const STYLE_ID = "hb-vendor-bar-styles";

// AC ItemType bit → category dropdown label. Order = retail VendorItemsUI
// AddTypeFilter calls. Categories this vendor doesn't stock are hidden.
const CATEGORY_TABLE = [
  { id: "all",       label: "All Items", mask: 0xFFFFFFFF },
  { id: "melee",     label: "Melee",     mask: 0x000001 },
  { id: "armor",     label: "Armor",     mask: 0x000002 },
  { id: "clothing",  label: "Clothing",  mask: 0x000004 },
  { id: "jewelry",   label: "Jewelry",   mask: 0x000008 },
  { id: "missile",   label: "Missile",   mask: 0x000100 },
  { id: "container", label: "Container", mask: 0x000200 },
  { id: "money",     label: "Money",     mask: 0x000040 },
  { id: "food",      label: "Food",      mask: 0x000020 },
  { id: "misc",      label: "Misc",      mask: 0x000080 },
  { id: "gem",       label: "Gem",       mask: 0x000800 },
  { id: "component", label: "Component", mask: 0x001000 },
  { id: "key",       label: "Key",       mask: 0x002000 },
  { id: "reagent",   label: "Reagent",   mask: 0x004000 },
  { id: "book",      label: "Book",      mask: 0x010000 },
  { id: "writable",  label: "Writable",  mask: 0x020000 },
  { id: "tradenote", label: "Trade Note",mask: 0x040000 },
  { id: "manastone", label: "Mana Stone",mask: 0x080000 },
];

const MAX_QTY = 9999;

function snapshotFromWasm(state) {
  return {
    vendorGuid: state.vendorGuid,
    vendorName: state.vendorName,
    // Wire VendorProfile order: buy_price (what the vendor PAYS you),
    // sell_price (what it CHARGES you) — see commerce_logic.js.
    buyMultiplier: state.buyMultiplier,
    sellMultiplier: state.sellMultiplier,
    alternateCurrencyWcid: state.alternateCurrencyWcid,
    alternateCurrencyAmount: state.alternateCurrencyAmount,
    alternateCurrencyName: state.alternateCurrencyName,
    // Vendor range inputs (bug 3, 2026-10-07): the vendor's wire use
    // radius (0 when absent, as retail) and both bodies' CPartArray
    // radius/height. Absent on a stale pkg/ → null, and the watchdog falls
    // back to the old fixed range.
    useRadius: Number.isFinite(state.useRadius) ? state.useRadius : null,
    vendorRadius: Number.isFinite(state.vendorRadius) ? state.vendorRadius : 0,
    vendorHeight: Number.isFinite(state.vendorHeight) ? state.vendorHeight : 0,
    playerRadius: Number.isFinite(state.playerRadius) ? state.playerRadius : 0,
    playerHeight: Number.isFinite(state.playerHeight) ? state.playerHeight : 0,
    items: Array.from(state.items || []).map((i) => ({
      itemGuid: i.itemGuid,
      wcid: i.wcid,
      name: i.name,
      value: i.value,
      stackSize: i.stackSize,
      itemType: i.itemType,
      iconId: i.iconId,
    })),
    // Wave F.4 (2026-05-27) typed-profile fields, filled by
    // enrichWithProfile(). Defaults = retail "no restriction" sentinels.
    buyAcceptCategories: 0xFFFFFFFF,
    buyAcceptCategoryNames: [],
    dealsMagic: true,
    minValue: 0xFFFFFFFF,
    maxValue: 0xFFFFFFFF,
    hasNoMin: true,
    hasNoMax: true,
  };
}

/**
 * Wave F.4 (2026-05-27) — merge a `getCurrentVendorProfile` payload
 * (accept categories / magic flag / min-max caps) onto a snapshot.
 * NOTE: the profile's per-stock `buyPrice` is ShopSystem::BuyPrice at
 * the vendor's buy_price — the BUY-BACK price — so it is deliberately
 * not used as the purchase price any more (commerce_logic.js).
 */
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
    it.buyBackPrice = m.buyPrice;
    it.categoryBit = m.categoryBit;
  }
  return snapshot;
}

function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // Layout in HUD px (the root is zoomed by ui/hud_scale.js). Width
  // leaves room for the 300-px main panel on the right (inventory drags
  // must not cross the vendor), floor 520, and never exceeds the HUD
  // viewport (hb-cw max-width). No raw vw/vh — --hb-hud-vw only.
  style.textContent = `
#${OVERLAY_ID} {
  width: max(520px, min(800px, calc(100 * var(--hb-hud-vw, 1vw) - 332px)));
  height: 192px;
}
#${OVERLAY_ID} .hvb-tabs { flex: 0 0 auto; }
#${OVERLAY_ID} .hvb-tabs .hbk-tab { flex: 0 0 92px; }
#${OVERLAY_ID} .hvb-purse {
  margin-left: auto; align-self: center;
  display: flex; align-items: center; gap: 4px;
  padding: 0 6px; white-space: nowrap;
}
#${OVERLAY_ID} .hvb-main {
  flex: 1 1 auto; min-height: 0;
  display: grid;
  grid-template-columns: 178px minmax(0, 1fr) 78px;
  gap: 6px; padding: 6px;
}
#${OVERLAY_ID} .hvb-info {
  display: flex; flex-direction: column; gap: 3px;
  min-width: 0; overflow: hidden;
}
#${OVERLAY_ID} .hvb-info select.hbk-select { width: 100%; height: 20px; padding: 0 4px; font-size: 11px; }
#${OVERLAY_ID} .hvb-line { min-height: 14px; line-height: 14px; overflow: hidden; white-space: nowrap; }
#${OVERLAY_ID} .hvb-line.hvb-name { min-height: 16px; }
#${OVERLAY_ID} .hvb-hint { color: var(--hbk-text-faint); font-style: italic; font-size: 11px; white-space: normal; line-height: 13px; }
#${OVERLAY_ID} .hvb-kv { display: flex; justify-content: space-between; gap: 6px; min-height: 14px; align-items: center; }
#${OVERLAY_ID} .hvb-rates { margin-top: auto; color: var(--hbk-text-dim); font-size: 10px; line-height: 12px; white-space: normal; }
#${OVERLAY_ID} .hvb-list { min-width: 0; min-height: 0; overflow-y: auto; }
#${OVERLAY_ID} .hvb-actions {
  display: flex; flex-direction: column; align-items: stretch; gap: 5px;
}
#${OVERLAY_ID} .hvb-actions .hbk-btn { min-width: 0; padding: 0 4px; }
#${OVERLAY_ID} .hvb-actions .hbk-btn-small { min-width: 0; }
#${OVERLAY_ID} .hvb-qty { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
#${OVERLAY_ID} .hvb-qty input { width: 46px; min-height: 18px; padding: 0 4px; text-align: right; font-size: 11px; }
#${OVERLAY_ID} .hvb-cell.is-selected > .hbk-slot::after {
  content: ""; position: absolute; inset: 0;
  background: url("./data/ui-sprites/0x06004D09.png") center / 100% 100% no-repeat;
  pointer-events: none;
}
#${OVERLAY_ID} .hvb-row { gap: 5px; min-height: 26px; }
#${OVERLAY_ID} .hvb-row .hbk-slot { width: 24px; height: 24px; flex: 0 0 24px; }
#${OVERLAY_ID} .hvb-row input.hbk-input { width: 50px; min-height: 18px; padding: 0 4px; text-align: right; font-size: 11px; }
#${OVERLAY_ID} .hvb-row .hvb-row-price { flex: 0 0 68px; text-align: right; overflow: hidden; }
#${OVERLAY_ID} .hvb-row .hbk-icon-btn { width: 18px; height: 18px; font-size: 12px; line-height: 1; }
#${OVERLAY_ID} .hvb-empty { padding: 14px 10px; }
`;
  document.head.appendChild(style);
}

// ─────────────────────────────────────────────────────────────────
// Singleton state (one vendor window per page)
// ─────────────────────────────────────────────────────────────────

let state = {
  overlayEl: null,
  win: null,
  refs: null,
  vendorState: null,         // snapshot from getVendorState
  currentTab: "items",
  selectedItemGuid: null,
  categoryFilter: "all",
  qty: 1,
  gridKey: "",
  buyQueue: [],              // [{ itemGuid, name, value, amount, iconId, itemType, stackSize, wcid }]
  sellQueue: [],             // same shape, inventory items
  rangeCheckTimer: null,     // HUD rec #18 — 2Hz approach-distance watchdog
};

function toast(text, kind = "ok") {
  state.win?.toast?.(text, kind);
}

function currencyInfo() {
  const vs = state.vendorState;
  const alt = (vs?.alternateCurrencyWcid >>> 0) || 0;
  const inv = inventoryRows();
  if (alt) {
    return {
      balance: countCurrency(inv, alt),
      unit: vs.alternateCurrencyName || "tokens",
      short: vs.alternateCurrencyName || "tokens",
      alt: true,
    };
  }
  // Retail gmVendorUI::UpdateTotalValue reads PlayerDesc InqInt 0x14
  // (CoinValue); summing the pyreal stacks gives the same number.
  return { balance: countCurrency(inv, PYREAL_WCID), unit: "pyreals", short: "p", alt: false };
}

// ─────────────────────────────────────────────────────────────────
// Build the window DOM once
// ─────────────────────────────────────────────────────────────────

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

function buildOverlay() {
  ensureStyles();
  const win = createKitWindow({
    id: OVERLAY_ID,
    title: "Vendor",
    windowId: COMMERCE_WINDOW_ID.VENDOR,
    // Docked bottom-left above the chat (410×100 @ bottom 8) and the
    // toolbar (310×132 @ bottom 8): clear of both, and clear of the
    // 300-px main panel on the right.
    defaultPos: {
      left: "8px", top: "auto", right: "auto",
      // 148 px clears the toolbar; shrinks toward the bottom edge when the
      // HUD viewport is too short to fit the 192-px strip above it.
      bottom: `max(4px, min(148px, calc(100 * var(--hb-hud-vh, 1vh) - 200px)))`,
    },
    className: "hb-vendor",
    onHide: () => onHidden(),
  });
  state.win = win;
  const overlay = win.root;
  const body = win.body;

  // Tab strip — retail TabBackground 0x06005F10 is the kit tab-strip
  // background; tabs are Items / Buying / Selling like retail.
  const tabs = el("div", "hbk-tabs hvb-tabs", body);
  tabs.setAttribute("role", "tablist");
  const tabEls = {};
  for (const t of [{ id: "items", label: "Items" }, { id: "buying", label: "Buying" }, { id: "selling", label: "Selling" }]) {
    const b = el("button", "hbk-tab", tabs);
    b.type = "button";
    b.dataset.tab = t.id;
    b.setAttribute("role", "tab");
    setAcText(b, t.label, { color: KIT_COLOR.text });
    b.addEventListener("click", () => switchTab(t.id));
    tabEls[t.id] = b;
  }
  const purse = el("div", "hvb-purse", tabs);
  purse.title = "Your money";

  const main = el("div", "hvb-main", body);
  const info = el("div", "hvb-info", main);
  const list = el("div", "hvb-list hbk-scroll hb-cw-drop", main);
  const actions = el("div", "hvb-actions", main);

  // Category filter — kit-styled native <select> (popup renders at OS
  // scale, no zoom maths). Hidden on the Buying / Selling pages.
  const cat = el("select", "hbk-select hvb-category");
  for (const c of CATEGORY_TABLE) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.label;
    cat.appendChild(opt);
  }
  cat.addEventListener("change", (e) => {
    state.categoryFilter = e.target.value;
    state.selectedItemGuid = null;
    render();
  });
  cat.addEventListener("keydown", (ev) => {
    // Esc while the dropdown has focus just blurs it; the window-stack
    // handler sees the Esc next time.
    if (ev.key === "Escape") { ev.stopPropagation(); cat.blur(); }
  });

  // Quantity for the Items page (retail stack slider).
  const qtyWrap = el("label", "hvb-qty");
  const qtyLbl = el("span", "hbk-muted", qtyWrap);
  setAcText(qtyLbl, "Qty", { color: KIT_COLOR.dim });
  const qtyInput = el("input", "hbk-input", qtyWrap);
  qtyInput.type = "number";
  qtyInput.min = "1";
  qtyInput.max = String(MAX_QTY);
  qtyInput.value = "1";
  qtyInput.addEventListener("input", () => {
    state.qty = clampQty(qtyInput.value);
    renderInfo();
  });
  qtyInput.addEventListener("change", () => { qtyInput.value = String(state.qty); });

  const btn = {
    buy: kitButton("Buy", "hbk-btn", handleBuyInstant),
    add: kitButton("Add to List", "hbk-btn", handleAddToBuying),
    buyAll: kitButton("Buy All", "hbk-btn", handleConfirmBuy),
    sellAll: kitButton("Sell All", "hbk-btn", handleConfirmSell),
    clearBuy: kitButton("Clear List", "hbk-btn-small", () => { state.buyQueue = []; render(); }),
    clearSell: kitButton("Clear List", "hbk-btn-small hbk-brown", () => { state.sellQueue = []; render(); }),
  };
  btn.buy.title = "Buy now (double-click an item does the same)";
  btn.add.title = "Add to your buying list";

  // Drag-to-sell anywhere on the window (retail VendorSellUI drop).
  wireDropTarget(overlay, DropItemFlags.VENDOR, (guid) => stageSell(guid));
  // Sub-highlight the list well too so the target reads clearly.
  wireDropTarget(list, DropItemFlags.VENDOR, (guid) => stageSell(guid));

  state.refs = { tabs: tabEls, purse, info, list, actions, cat, qtyWrap, qtyInput, btn };
  return overlay;
}

function clampQty(v) {
  const n = parseInt(v, 10);
  return Math.max(1, Math.min(MAX_QTY, Number.isFinite(n) ? n : 1));
}

function switchTab(tabId) {
  state.currentTab = tabId;
  render();
}

function showOverlay() {
  if (!state.overlayEl) state.overlayEl = buildOverlay();
  state.win.open();
}

function hideOverlay() {
  if (!state.overlayEl) return;
  state.win.close();
}

function onHidden() {
  // Drop queues on close so reopening a different vendor is clean.
  state.buyQueue = [];
  state.sellQueue = [];
  state.selectedItemGuid = null;
  stopVendorRangeWatchdog();
}

// ─────────────────────────────────────────────────────────────────
// Drag-to-sell staging
// ─────────────────────────────────────────────────────────────────

function stageSell(guid) {
  const vs = state.vendorState;
  if (!vs) return;
  const item = inventoryRows().find((i) => i.guid === (guid >>> 0));
  if (!item) {
    // VendorSellUI::DragItemAcceptable — not owned.
    toast("You can only sell items you are carrying", "err");
    return;
  }
  // ACE rejects sells of wielded items (Player_Commerce); retail never
  // lets them into the list either.
  if ((item.equipMask >>> 0) !== 0) {
    toast(`Unequip ${item.name} before selling it`, "err");
    try { window.__audioOptimistic?.playUiError?.(); } catch (_) {}
    return;
  }
  const code = vendorAcceptability(vs, item);
  if (code !== VENDOR_ACCEPT.OK) {
    toast(vendorRejectText(code), "err");
    try { window.__audioOptimistic?.playUiError?.(); } catch (_) {}
    return;
  }
  state.currentTab = "selling";
  const stack = Math.max(1, item.stackSize || 1);
  const existing = state.sellQueue.find((q) => q.itemGuid === item.guid);
  if (existing) {
    existing.amount = stack; // re-dropping a stack re-stages the whole stack
  } else {
    // Retail VendorSellUI::AddItemToSell stages the whole stack; the
    // quantity box on the row trims it.
    state.sellQueue.push({
      itemGuid: item.guid,
      wcid: item.wcid,
      name: item.name,
      value: item.value,
      stackSize: stack,
      itemType: item.itemType,
      iconId: item.iconId,
      amount: stack,
    });
  }
  render();
}

// HUD rec #18 — vendor approach-distance enforcement.
//
// RETAIL (client owns the close; there is no close packet in either
// direction): `gmVendorUI::OpenVendor` (acclient.c:246660) registers an
// object-range handler with the VENDOR'S OWN wire use-radius
// (`_range = PublicWeenieDesc::_useRadius`, useRadii=1, xy_only=0, 1.0 s
// poll); `CPlayerSystem::CalculateObjectRangeChecks` (:397612) →
// `ACCWeenieObject::ObjectsInRange` (:436730) →
// `CPhysicsObj::get_distance_to_object(use_cyls=1)` →
// `Position::cylinder_distance` (:467221) with each body's
// `CPartArray::GetRadius`/`GetHeight`; past the radius it fires
// `gmVendorUI::OnObjectRangeExit` (:242550) → `CloseVendor` (:245102).
// OpenAC (Runtime/Gameplay/RuntimeVendorRangeQuery.cs) does exactly this
// every frame, treats an absent use radius as 0 m (the retail ctor zeroes
// `_useRadius`, :470951), and closes when the vendor is gone.
// ACE (independent, emote-only): Vendor.CheckClose() every 1.5 s plays the
// goodbye emote past UseRadius; it never tells the client to close.
//
// Bug 3 (2026-10-07): this used a fixed 3.0 m + 0.96 m PLANAR centre
// distance. Now: the vendor's own radius, retail's 3-D cylinder distance.
// The fixed range survives only as the stale-pkg/ fallback.
// OpenAC checks every frame, retail once a second; 4 Hz is close to the
// former without a per-frame hook. The range math lives in vendor_range.js.
const VENDOR_RANGE_POLL_MS = 250;

function startVendorRangeWatchdog() {
  stopVendorRangeWatchdog();
  const vs0 = state.vendorState;
  if (vs0) {
    console.info(
      `[vendor-range] open ${devHex(vs0.vendorGuid >>> 0)}: useRadius=` +
      `${Number.isFinite(vs0.useRadius) ? vs0.useRadius.toFixed(2) + "m" : "n/a (stale pkg, fixed " + VENDOR_FALLBACK_RANGE_M.toFixed(2) + "m)"}` +
      ` vendor r/h=${(vs0.vendorRadius || 0).toFixed(3)}/${(vs0.vendorHeight || 0).toFixed(3)}` +
      ` player r/h=${(vs0.playerRadius || 0).toFixed(3)}/${(vs0.playerHeight || 0).toFixed(3)}`,
    );
  }
  let seenVendor = false;
  state.rangeCheckTimer = setInterval(() => {
    if (!state.win?.isOpen()) {
      stopVendorRangeWatchdog();
      return;
    }
    const vendorGuid = (state.vendorState?.vendorGuid >>> 0) || 0;
    if (!vendorGuid) return;
    const pp = localPlayerWorldPos();
    if (!pp) return;
    const vendorPos = entityWorldPos(vendorGuid);
    if (!vendorPos) {
      // OpenAC closes when the vendor is no longer an active object. Only
      // once we have seen it in the scene: a rig that never loaded (debug
      // mount, nullRender) is not a vendor that left.
      if (seenVendor) {
        console.info(`[vendor-range] vendor ${devHex(vendorGuid)} left the world — closing`);
        hideOverlay();
      }
      return;
    }
    seenVendor = true;
    const v = vendorRangeVerdict(state.vendorState, vendorPos, pp);
    if (!v.inRange) {
      console.info(
        `[vendor-range] vendor ${devHex(vendorGuid)} out of range ` +
        `(${v.mode} distance ${v.dist.toFixed(2)}m > ${v.range.toFixed(2)}m) — closing`,
      );
      hideOverlay();
    }
  }, VENDOR_RANGE_POLL_MS);
}
function stopVendorRangeWatchdog() {
  if (state.rangeCheckTimer) {
    clearInterval(state.rangeCheckTimer);
    state.rangeCheckTimer = null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────

function render() {
  if (!state.overlayEl || !state.refs) return;
  const vs = state.vendorState;
  if (!vs) return;
  const r = state.refs;
  state.win.setTitle(vs.vendorName || "Vendor");

  const labels = {
    items: "Items",
    buying: state.buyQueue.length ? `Buying (${state.buyQueue.length})` : "Buying",
    selling: state.sellQueue.length ? `Selling (${state.sellQueue.length})` : "Selling",
  };
  for (const id of ["items", "buying", "selling"]) {
    const b = r.tabs[id];
    const active = id === state.currentTab;
    b.setAttribute("aria-selected", active ? "true" : "false");
    setAcText(b, labels[id], { color: active ? KIT_COLOR.gold : KIT_COLOR.text });
  }

  const cur = currencyInfo();
  setAcText(r.purse, `${fmtNumber(cur.balance)} ${cur.short}`, { color: KIT_COLOR.value });
  r.purse.title = `You have ${fmtNumber(cur.balance)} ${cur.unit}`;

  if (state.currentTab === "items") renderItemsPane(cur);
  else renderQueuePane(state.currentTab, cur);
}

function filteredStock() {
  const vs = state.vendorState;
  const cat = CATEGORY_TABLE.find((c) => c.id === state.categoryFilter) ?? CATEGORY_TABLE[0];
  return vs.items.filter((it) => state.categoryFilter === "all" || (it.itemType & cat.mask));
}

/**
 * Retail's `VendorItemsUI` only calls `AddTypeFilter` for the item
 * types the vendor actually stocks — hide the dead categories so every
 * entry leads to real offerings. "All Items" always stays.
 */
function syncCategoryOptions() {
  const vs = state.vendorState;
  const present = new Set();
  for (const it of vs.items || []) {
    const t = it.itemType | 0;
    for (const c of CATEGORY_TABLE) {
      if (c.id !== "all" && (t & c.mask)) present.add(c.id);
    }
  }
  const keep = (id) => id === "all" || present.has(id);
  if (!keep(state.categoryFilter)) state.categoryFilter = "all";
  const cat = state.refs.cat;
  for (const opt of cat.options || []) {
    opt.hidden = !keep(opt.value);
    opt.disabled = !keep(opt.value);
  }
  cat.value = state.categoryFilter;
}

function kv(parent, label, value, color = KIT_COLOR.value) {
  const row = el("div", "hvb-kv", parent);
  const a = el("span", "", row);
  setAcText(a, label, { color: KIT_COLOR.dim });
  const b = el("span", "", row);
  setAcText(b, value, { color });
  return row;
}

function renderItemsPane(cur) {
  const r = state.refs;
  const vs = state.vendorState;
  syncCategoryOptions();
  const items = filteredStock();

  // Grid — rebuilt only when the stock/filter/affordability changes, so
  // clicking around never resets the scroll position.
  const key = `${vs.vendorGuid}|${state.categoryFilter}|${cur.balance}|` +
    items.map((i) => `${i.itemGuid}:${i.value}:${i.stackSize}`).join(",");
  if (key !== state.gridKey || !r.list.querySelector(".hb-cw-grid")) {
    state.gridKey = key;
    r.list.replaceChildren();
    if (items.length === 0) {
      const empty = el("div", "hbk-empty hvb-empty", r.list);
      empty.textContent = vs.items.length
        ? "This vendor has nothing in that category."
        : "This vendor has nothing for sale.";
    } else {
      const grid = el("div", "hb-cw-grid", r.list);
      for (const it of items) grid.appendChild(buildStockCell(it, cur));
    }
  }
  for (const cell of r.list.querySelectorAll(".hvb-cell")) {
    cell.classList.toggle("is-selected", Number(cell.dataset.itemGuid) === state.selectedItemGuid);
  }

  renderInfo(cur);

  r.actions.replaceChildren(r.qtyWrap, r.btn.buy, r.btn.add);
  const sel = findSelectedItem();
  r.btn.buy.disabled = !sel;
  r.btn.add.disabled = !sel;
}

function buildStockCell(it, cur) {
  const vs = state.vendorState;
  const price = vendorPurchasePrice(it, vs, 1);
  const cell = el("div", "hb-cw-cell hvb-cell");
  cell.dataset.itemGuid = String(it.itemGuid);
  if (price > cur.balance) cell.classList.add("is-unaffordable");
  const slot = el("div", "hbk-slot", cell);
  fillSlotIcon(slot, it.iconId, it.name);
  if ((it.stackSize || 1) > 1) {
    const st = el("span", "hbk-stack", slot);
    st.textContent = String(it.stackSize);
  }
  const cap = el("div", "hb-cw-caption", cell);
  cap.textContent = fmtCompact(price);
  const basic = `${it.name} — ${fmtNumber(price)} ${cur.unit}`;
  cell.title = basic;
  // Rec #69 — upgrade the tooltip with the appraisal body on first hover.
  let upgraded = false;
  cell.addEventListener("mouseenter", () => {
    if (upgraded) return;
    try {
      const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
      const json = handle?.getObjectAppraisal?.((it.itemGuid >>> 0) || 0);
      if (typeof json !== "string" || !json) return;
      const bodyText = formatAppraisalTooltip(it.name, JSON.parse(json));
      cell.title = bodyText ? `${bodyText}\nPrice: ${fmtNumber(price)} ${cur.unit}` : basic;
      upgraded = true;
    } catch (_) {}
  });
  cell.addEventListener("click", () => {
    state.selectedItemGuid = it.itemGuid;
    render();
  });
  cell.addEventListener("dblclick", () => {
    state.selectedItemGuid = it.itemGuid;
    handleBuyInstant();
  });
  return cell;
}

function renderInfo(cur = currencyInfo()) {
  if (state.currentTab !== "items") return;
  const r = state.refs;
  const vs = state.vendorState;
  const sel = findSelectedItem();
  // Keep the <select> node in place (re-inserting it would slam shut an
  // open dropdown whenever an inventory refresh re-renders the pane).
  if (r.info.firstChild !== r.cat) r.info.replaceChildren(r.cat);
  while (r.info.lastChild && r.info.lastChild !== r.cat) r.info.lastChild.remove();
  const name = el("div", "hvb-line hvb-name", r.info);
  if (sel) {
    setAcText(name, sel.name || "Unnamed item", { color: KIT_COLOR.gold, fit: true });
    const price = vendorPurchasePrice(sel, vs, state.qty);
    kv(r.info, state.qty > 1 ? `Price (${state.qty})` : "Price",
      `${fmtNumber(price)} ${cur.short}`, price > cur.balance ? KIT_COLOR.warn : KIT_COLOR.gold);
    kv(r.info, "You have", `${fmtNumber(cur.balance)} ${cur.short}`, KIT_COLOR.value);
  } else {
    name.className = "hvb-hint";
    name.textContent = "Click an item to see its price. Double-click buys one.";
  }
  const rates = el("div", "hvb-rates", r.info);
  const parts = [
    `Sells at ${Math.round((vs.sellMultiplier || 1) * 100)}%`,
    `buys at ${Math.round((vs.buyMultiplier || 1) * 100)}%`,
  ];
  if (vs.dealsMagic === false) parts.push("no magic items");
  if (cur.alt) parts.push(`trades in ${cur.unit}`);
  rates.textContent = parts.join(" · ");
  if (Array.isArray(vs.buyAcceptCategoryNames) && vs.buyAcceptCategoryNames.length) {
    // Wire enum names ("MeleeWeapon") → "Melee Weapon" for the tooltip.
    rates.title = `Buys: ${vs.buyAcceptCategoryNames
      .map((n) => String(n).replace(/([a-z])([A-Z])/g, "$1 $2")).join(", ")}`;
  }
}

function renderQueuePane(which, cur) {
  const r = state.refs;
  const vs = state.vendorState;
  const buying = which === "buying";
  const queue = buying ? state.buyQueue : state.sellQueue;
  const linePrice = (q) => (buying
    ? vendorPurchasePrice(q, vs, q.amount)
    : vendorSaleCredit(q, vs, q.amount));

  state.gridKey = "";
  r.list.replaceChildren();
  const priceCells = [];
  if (queue.length === 0) {
    const empty = el("div", "hbk-empty hvb-empty", r.list);
    empty.textContent = buying
      ? "Your buying list is empty. Pick items on the Items tab and press Add to List."
      : "Drag items from your pack onto this window to sell them.";
  } else {
    const listEl = el("div", "hbk-list", r.list);
    for (const q of queue) {
      const row = el("div", "hbk-row hvb-row", listEl);
      const slot = el("div", "hbk-slot", row);
      fillSlotIcon(slot, q.iconId, q.name);
      const nm = el("div", "hbk-grow", row);
      setAcText(nm, q.name || "Unnamed item", { color: KIT_COLOR.text, fit: true });
      nm.title = q.name || "";
      const qty = el("input", "hbk-input", row);
      qty.type = "number";
      qty.min = "1";
      qty.max = String(buying ? MAX_QTY : Math.max(1, q.stackSize || 1));
      qty.value = String(q.amount);
      qty.title = "Quantity";
      // Reprice in place while typing — a full render() would destroy
      // the focused <input> and eat the next keystroke.
      qty.addEventListener("input", () => {
        const max = buying ? MAX_QTY : Math.max(1, q.stackSize || 1);
        const n = parseInt(qty.value, 10);
        q.amount = Math.max(1, Math.min(max, Number.isFinite(n) ? n : 1));
        repaintTotals();
      });
      qty.addEventListener("change", () => render());
      const pr = el("div", "hvb-row-price", row);
      priceCells.push({ q, el: pr });
      const rm = el("button", "hbk-icon-btn", row);
      rm.type = "button";
      rm.textContent = "×";
      rm.title = "Remove from list";
      rm.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const i = queue.indexOf(q);
        if (i >= 0) queue.splice(i, 1);
        render();
      });
    }
  }

  // Details column: totals against the purse.
  const totalsHost = el("div", "");
  totalsHost.style.display = "contents";
  r.info.replaceChildren(totalsHost);
  const btnPrimary = buying ? r.btn.buyAll : r.btn.sellAll;
  function repaintTotals() {
    let sum = 0;
    for (const c of priceCells) {
      const n = linePrice(c.q);
      sum += n;
      setAcText(c.el, `${fmtNumber(n)} ${cur.short}`, { color: buying ? KIT_COLOR.gold : KIT_COLOR.value });
    }
    totalsHost.replaceChildren();
    const head = el("div", "hvb-line hvb-name", totalsHost);
    const count = queue.reduce((a, q) => a + (q.amount | 0), 0);
    setAcText(head, queue.length
      ? `${buying ? "Buying" : "Selling"} ${count} item${count === 1 ? "" : "s"}`
      : (buying ? "Buying list" : "Selling list"), { color: KIT_COLOR.gold, fit: true });
    kv(totalsHost, buying ? "Total cost" : "Total value", `${fmtNumber(sum)} ${cur.short}`, KIT_COLOR.gold);
    kv(totalsHost, "You have", `${fmtNumber(cur.balance)} ${cur.short}`, KIT_COLOR.value);
    const after = buying ? cur.balance - sum : cur.balance + sum;
    kv(totalsHost, buying ? "Remaining" : "After sale", `${fmtNumber(after)} ${cur.short}`,
      after < 0 ? KIT_COLOR.warn : KIT_COLOR.value);
    if (buying && after < 0) {
      const warn = el("div", "hvb-hint", totalsHost);
      warn.style.color = "var(--hbk-warn)";
      warn.textContent = `You need ${fmtNumber(-after)} more ${cur.unit}.`;
    }
    btnPrimary.disabled = queue.length === 0;
  }
  repaintTotals();

  r.actions.replaceChildren(btnPrimary, buying ? r.btn.clearBuy : r.btn.clearSell);
  (buying ? r.btn.clearBuy : r.btn.clearSell).disabled = queue.length === 0;
}

// ─────────────────────────────────────────────────────────────────
// Action handlers — wire the buy / sell paths
// ─────────────────────────────────────────────────────────────────

function findSelectedItem() {
  const vs = state.vendorState;
  if (!vs) return null;
  return vs.items.find((i) => i.itemGuid === state.selectedItemGuid) || null;
}

function handleBuyInstant() {
  const handle = window.__sessionHandle;
  if (!handle?.buyFromVendor) return toast("Not connected", "err");
  const vs = state.vendorState;
  if (!vs?.vendorGuid) return;
  const sel = findSelectedItem();
  if (!sel) return toast("Select an item first", "err");
  const qty = clampQty(state.qty);
  try {
    handle.buyFromVendor(
      vs.vendorGuid >>> 0,
      new Uint32Array([sel.itemGuid >>> 0]),
      new Int32Array([qty]),
    );
    toast(`Buying ${qty > 1 ? `${qty} × ` : ""}${sel.name}…`);
  } catch (err) {
    console.warn("[vendor-ui] buy failed", err);
    toast("The purchase could not be sent", "err");
  }
}

function handleAddToBuying() {
  const sel = findSelectedItem();
  if (!sel) return;
  const qty = clampQty(state.qty);
  const existing = state.buyQueue.find((q) => q.itemGuid === sel.itemGuid);
  if (existing) {
    existing.amount = Math.min(existing.amount + qty, MAX_QTY);
  } else {
    state.buyQueue.push({
      itemGuid: sel.itemGuid,
      wcid: sel.wcid,
      name: sel.name,
      value: sel.value,
      stackSize: sel.stackSize || 1,
      itemType: sel.itemType,
      iconId: sel.iconId,
      amount: qty,
    });
  }
  toast(`Added ${sel.name} to your buying list`);
  render();
}

function handleConfirmBuy() {
  const handle = window.__sessionHandle;
  if (!handle?.buyFromVendor) return toast("Not connected", "err");
  const vs = state.vendorState;
  if (!vs?.vendorGuid || state.buyQueue.length === 0) return;
  const guids = new Uint32Array(state.buyQueue.map((q) => q.itemGuid >>> 0));
  const amounts = new Int32Array(state.buyQueue.map((q) => q.amount | 0));
  try {
    handle.buyFromVendor(vs.vendorGuid >>> 0, guids, amounts);
    toast(`Buying ${state.buyQueue.length} item${state.buyQueue.length === 1 ? "" : "s"}…`);
    state.buyQueue = [];
    state.currentTab = "items";
    render();
  } catch (err) {
    console.warn("[vendor-ui] confirm-buy failed", err);
    toast("The purchase could not be sent", "err");
  }
}

function handleConfirmSell() {
  const handle = window.__sessionHandle;
  if (!handle?.sellToVendor) return toast("Not connected", "err");
  const vs = state.vendorState;
  if (!vs?.vendorGuid || state.sellQueue.length === 0) return;
  const guids = new Uint32Array(state.sellQueue.map((q) => q.itemGuid >>> 0));
  const amounts = new Int32Array(state.sellQueue.map((q) => q.amount | 0));
  try {
    handle.sellToVendor(vs.vendorGuid >>> 0, guids, amounts);
    toast(`Selling ${state.sellQueue.length} item${state.sellQueue.length === 1 ? "" : "s"}…`);
    state.sellQueue = [];
    state.currentTab = "items";
    render();
  } catch (err) {
    console.warn("[vendor-ui] confirm-sell failed", err);
    toast("The sale could not be sent", "err");
  }
}

// ─────────────────────────────────────────────────────────────────
// Plugin lifecycle — bar.js calls mount() once per session.
// ─────────────────────────────────────────────────────────────────

export const manifest = {
  id: "vendor-ui",
  name: "Vendor Bar",
  icon: "💰",
  iconHidden: true,
  version: "0.6.0",
  description: "Retail-style vendor window (gmVendorUI) — auto-opens on kind=12 VendorOpened; retail buy/sell price direction",
};

export function mount(ctx) {
  ensureStyles();
  let pollTimer = null;
  let unsubscribe = null;

  function tryHook() {
    const client = ctx?.client ?? window.__pluginClient ?? null;
    const handle = window.__sessionHandle ?? null;
    if (!client?.events?.on || !handle?.getVendorState) return false;

    const pullProfile = (vendorGuid) => {
      // Wave F.4 (2026-05-27): typed-profile fields (accept categories,
      // magic flag, min/max). Absent on older wasm builds.
      if (typeof handle.getCurrentVendorProfile !== "function") return null;
      try {
        return handle.getCurrentVendorProfile(vendorGuid >>> 0);
      } catch (e) {
        console.warn("[vendor-ui] getCurrentVendorProfile failed", e);
        return null;
      }
    };

    const onVendorOpened = (ev) => {
      const detail = ev.detail || {};
      const vendorGuid = (detail.u32Payload ?? detail.u32_payload ?? 0) >>> 0;
      if (!vendorGuid) {
        console.warn("[vendor-ui] kind=12 event without vendor guid; ignoring", detail);
        return;
      }
      const raw = handle.getVendorState(vendorGuid);
      if (!raw) {
        setTimeout(() => {
          const retry = handle.getVendorState(vendorGuid);
          if (retry) openWith(retry, pullProfile(vendorGuid));
        }, 50);
        return;
      }
      openWith(raw, pullProfile(vendorGuid));
    };

    const onInvChanged = () => {
      if (!state.vendorState?.vendorGuid || !state.win?.isOpen()) return;
      try {
        const vendorGuid = state.vendorState.vendorGuid >>> 0;
        const raw = handle.getVendorState(vendorGuid);
        if (raw) {
          state.vendorState = enrichWithProfile(snapshotFromWasm(raw), pullProfile(vendorGuid));
          render();
        }
      } catch (e) {
        console.warn("[vendor-ui] inv-changed re-pull failed", e);
      }
    };

    // HUD rec #18 follow-up (2026-08-02) — retail tears the vendor
    // window down on ANY portal transit and on death; kind=33
    // PlayerTeleport rides every teleport flavour.
    const closeIfOpen = (why) => {
      if (!state.win?.isOpen()) return;
      console.info(`[vendor-ui] ${why} — closing`);
      hideOverlay();
    };
    const onPortalSpace = () => closeIfOpen("portal space entered (teleport)");
    const onDeath = (ev) => {
      const victim = (ev.detail?.victimGuid ?? 0) >>> 0;
      const local = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
      if (victim && local && victim === local) closeIfOpen("local player died");
    };

    client.events.on("vendorOpened", onVendorOpened);
    client.events.on("kind:12", onVendorOpened);
    client.events.on("VendorOpened", onVendorOpened);
    client.events.on("playerInventoryChanged", onInvChanged);
    client.events.on("portalSpaceEntered", onPortalSpace);
    client.events.on("death", onDeath);

    unsubscribe = () => {
      client.events.off?.("vendorOpened", onVendorOpened);
      client.events.off?.("kind:12", onVendorOpened);
      client.events.off?.("VendorOpened", onVendorOpened);
      client.events.off?.("playerInventoryChanged", onInvChanged);
      client.events.off?.("portalSpaceEntered", onPortalSpace);
      client.events.off?.("death", onDeath);
    };
    return true;
  }

  function openWith(rawState, profilePayload = null) {
    const prevVendorGuid = (state.vendorState?.vendorGuid >>> 0) || 0;
    state.vendorState = enrichWithProfile(snapshotFromWasm(rawState), profilePayload);
    const nextVendorGuid = (state.vendorState?.vendorGuid >>> 0) || 0;
    // ACE re-sends kind=12 after every buy: preserve the queues for the
    // SAME vendor, drop them when switching vendors — otherwise vendor A's
    // item guids would be sent against vendor B's guid and ACE rejects
    // the whole purchase (tests/vendor_queue_vendor_switch.test.mjs).
    const wasOpen = !!state.win?.isOpen();
    if (nextVendorGuid !== prevVendorGuid) {
      state.buyQueue = [];
      state.sellQueue = [];
    }
    // A fresh open (or a different vendor) starts on the Items tab; a
    // same-vendor refresh while open keeps the player's tab, selection
    // and filter (ACE refreshes after every purchase).
    if (!wasOpen || nextVendorGuid !== prevVendorGuid) {
      state.currentTab = "items";
      state.selectedItemGuid = null;
      state.categoryFilter = "all";
      state.qty = 1;
      state.gridKey = "";
      if (state.refs?.qtyInput) state.refs.qtyInput.value = "1";
    }
    showOverlay();
    if (!wasOpen || nextVendorGuid !== prevVendorGuid) startVendorRangeWatchdog();
    render();
  }

  // The REAL kind=12 entry point for the e2e verifier and
  // tests/vendor_queue_vendor_switch.test.mjs.
  if (typeof window !== "undefined") {
    window.__vendorPluginDebugMount = { openWith, close: () => hideOverlay() };
  }

  if (!tryHook()) {
    if (typeof window !== "undefined" && window.__pluginClientReady?.then) {
      window.__pluginClientReady.then(() => { tryHook(); });
    } else {
      pollTimer = setInterval(() => {
        if (tryHook()) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }, 500);
    }
  }

  return () => {
    if (pollTimer) clearInterval(pollTimer);
    if (unsubscribe) unsubscribe();
    stopVendorRangeWatchdog();
    if (state.overlayEl) {
      state.win?.close();
      state.overlayEl.remove();
      state.overlayEl = null;
      state.win = null;
      state.refs = null;
    }
  };
}

// Debug helpers: pop a synthetic vendor from DevTools / e2e verifier.
//   __vendorBarDebug()  — fake "Lin the Trader" with a handful of stock
//   __vendorPluginDebug — open / close / switchTab / refs
if (typeof window !== "undefined") {
  const DEBUG_SNAPSHOT = {
    vendorGuid: 0xDEADBEEF,
    vendorName: "Lin the Trader (debug)",
    buyMultiplier: 0.9,
    sellMultiplier: 1.5,
    alternateCurrencyWcid: 0,
    alternateCurrencyAmount: 0,
    alternateCurrencyName: "",
    items: [
      { itemGuid: 1, wcid: 0x010, name: "Bread",        value: 5,    stackSize: 1, itemType: 0x20,    iconId: 0 },
      { itemGuid: 2, wcid: 0x011, name: "Healing Kit",  value: 30,   stackSize: 1, itemType: 0x80,    iconId: 0 },
      { itemGuid: 3, wcid: 0x012, name: "Lockpick",     value: 50,   stackSize: 5, itemType: 0x80,    iconId: 0 },
      { itemGuid: 4, wcid: 0x013, name: "Mana Charge",  value: 1200, stackSize: 1, itemType: 0x80,    iconId: 0 },
      { itemGuid: 5, wcid: 0x014, name: "Trade Note",   value: 100,  stackSize: 1, itemType: 0x40000, iconId: 0 },
      { itemGuid: 6, wcid: 0x015, name: "Iron Dagger",  value: 80,   stackSize: 1, itemType: 0x01,    iconId: 0 },
      { itemGuid: 7, wcid: 0x016, name: "Leather Cap",  value: 45,   stackSize: 1, itemType: 0x02,    iconId: 0 },
    ],
  };
  const openDebug = (snapshot) => {
    ensureStyles();
    state.vendorState = snapshotFromWasm(snapshot || DEBUG_SNAPSHOT);
    state.currentTab = "items";
    state.selectedItemGuid = null;
    state.buyQueue = [];
    state.sellQueue = [];
    state.categoryFilter = "all";
    state.qty = 1;
    showOverlay();
    if (state.refs?.qtyInput) state.refs.qtyInput.value = "1";
    render();
  };
  window.__vendorBarDebug = () => openDebug();
  window.__vendorPluginDebug = {
    open: openDebug,
    close: () => hideOverlay(),
    switchTab: (id) => { state.currentTab = id; render(); },
    refs: () => state.refs,
    stageSell: (guid) => stageSell(guid),
  };
}
