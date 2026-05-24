/**
 * vendor-ui — Standalone horizontal vendor bar.
 *
 * Wave 2 PR-GG rewrite 2026-05-23: was a registered view inside
 * plugins/main-panel.js (PR-CC, 2026-05-22). Now a standalone
 * overlay div, matching retail's gmVendorUI (layout 0x21000012,
 * 800×110 horizontal bar at design-canvas y=500). The dual-pane
 * revert (PR-FF) re-grounded the project on "main-panel is for
 * Inventory/Skills/Magic/etc."; vendor is its OWN top-level floaty
 * window in acclient.c, never sharing the main-panel slot.
 *
 * Layout decoded from chorizite-dump-layout-tree on 0x21000012:
 *   - Root 800×110, design-canvas y=500.
 *   - Tabs (3): Items / Buying / Selling — 92×20 each, top-left.
 *     Active uses sprite 0x06005F11, inactive 0x06005F12 (book-tab).
 *   - Body: 800×90 tab-content area.
 *   - Items tab content:
 *       * Category dropdown 117×18 (y=4)
 *       * Icon strip 710×32 (y=30) — horizontal scroll, click to preview
 *       * Selected-item name 590×15 (y=0 of body) + price 590×15 (y=15)
 *       * Buy button 64×22 (y=4, right)
 *       * Add to List button 64×22 (y=30, right)
 *   - Top strip background 800×20, sprite 0x06005F10.
 *   - Close X 22×20, sprites 0x060012A9 (pressed) / 0x060012AA (normal).
 *   - Buttons use sprite 0x06004C4C (normal) / 4D (pressed) / 4E (ghosted).
 *
 * Wire wiring (DO NOT regress):
 *   - Buy:  handle.buyFromVendor(vendorGuid, [vendorItemGuid…], [amount…])
 *           wire: GameAction::Buy 0x005F, object_guid per profile = vendor's
 *           per-stock-entry WO GUID. NOT wcid — ACE keys
 *           DefaultItemsForSale/UniqueItemsForSale by ObjectGuid in
 *           Vendor.BuyItems_ValidateTransaction (PR-EE 2026-05-22 fix).
 *           Multi-item per call to mirror retail's atomic
 *           gmVendorUI::SendShopEvent flush (acclient.c:4582).
 *   - Sell: handle.sellToVendor(vendorGuid, [itemGuid…], [amount…])
 *           wire: GameAction::Sell 0x0060, object_guid per profile = player's
 *           inventory item GUID.
 *   - Vendor list via `kind=12 VendorOpened` → handle.getVendorState(guid).
 *   - Auto-refresh on `kind=11 InventoryUpdated` (subscriber re-pulls
 *     vendor state so multipliers / stock / alt-currency stay accurate
 *     after buy or sell — PR-EE 2026-05-22 bus emit).
 *
 * Two flows per retail's button layout:
 *   - Buy / Sell button: instant single-item action (no queue).
 *   - Add to List: append to Buying or Selling tab queue.
 *     Confirm in the queue tab flushes via the multi-item wire op.
 */

import { setAcText } from "../ui/ac_font.js";

const STYLE_ID = "hb-vendor-bar-styles";
const OVERLAY_ID = "hb-vendor-bar";

// AC ItemType bit → emoji fallback for icons that don't resolve.
const ITEM_TYPE_EMOJI = {
  0x01: "⚔", 0x02: "🛡", 0x04: "👕", 0x08: "💍",
  0x10: "🧬", 0x20: "🍞", 0x40: "💰", 0x80: "📦",
  0x100: "🎯", 0x200: "🏹", 0x400: "🔮", 0x800: "🎒",
  0x1000: "📜", 0x2000: "🔑", 0x4000: "🍷", 0x8000: "🍴",
  0x10000: "📖", 0x20000: "🗒", 0x40000: "💵", 0x80000: "🪄",
  0x100000: "⚗", 0x200000: "🎵",
};

// AC ItemType bit → category dropdown label. Order = retail VendorItemsUI
// AddTypeFilter calls (acclient.c:4597). Vendor stock is sparse across
// these — we hide categories with 0 items at render time.
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

function emojiForItemType(itemType) {
  if (!itemType) return "📦";
  const bit = itemType & (~itemType + 1);
  return ITEM_TYPE_EMOJI[bit] || "📦";
}

// Icon cache — module-scoped so revisits hit cache across mounts.
const iconCache = new Map();

async function fetchIconDataUrl(iconId) {
  if (!iconId) return null;
  const cached = iconCache.get(iconId);
  if (cached !== undefined) {
    if (cached instanceof Promise) return cached;
    return cached;
  }
  const wasm = window.__hbWasm ?? window.__wasm ?? null;
  if (!wasm?.fetch_surface_pixels) {
    iconCache.set(iconId, false);
    return false;
  }
  const promise = (async () => {
    try {
      const result = await wasm.fetch_surface_pixels(iconId >>> 0);
      if (!result || !result.width || !result.height || !result.pixels?.length) {
        return false;
      }
      const canvas = document.createElement("canvas");
      canvas.width = result.width;
      canvas.height = result.height;
      const ctx = canvas.getContext("2d");
      const img = ctx.createImageData(result.width, result.height);
      img.data.set(result.pixels);
      ctx.putImageData(img, 0, 0);
      return canvas.toDataURL("image/png");
    } catch (err) {
      console.warn(`[vendor-ui] icon ${iconId} fetch failed:`, err);
      return false;
    }
  })();
  iconCache.set(iconId, promise);
  const url = await promise;
  iconCache.set(iconId, url);
  return url;
}

function fmtPrice(n) {
  if (!Number.isFinite(n)) return "?";
  return Math.round(n).toLocaleString();
}

function snapshotFromWasm(state) {
  return {
    vendorGuid: state.vendorGuid,
    vendorName: state.vendorName,
    buyMultiplier: state.buyMultiplier,    // vendor sells at this × value
    sellMultiplier: state.sellMultiplier,  // vendor pays this × value
    alternateCurrencyWcid: state.alternateCurrencyWcid,
    alternateCurrencyAmount: state.alternateCurrencyAmount,
    alternateCurrencyName: state.alternateCurrencyName,
    items: state.items.map((i) => ({
      itemGuid: i.itemGuid,
      wcid: i.wcid,
      name: i.name,
      value: i.value,
      stackSize: i.stackSize,
      itemType: i.itemType,
      iconId: i.iconId,
    })),
  };
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // Sprite paths — DAT-extracted retail chrome.
  // 0x06005F10 — top strip background (64×20, tiled horizontally)
  // 0x06005F11 — active tab (92×20, alpha)
  // 0x06005F12 — inactive tab (92×20, alpha)
  // 0x06004C4C/D/E — button normal/pressed/ghosted (64×22, alpha)
  // 0x060012A9/AA — close X pressed/normal (22×20)
  // 0x06004CC2 — body strip placeholder (48×48, tiled)
  const SP = "./data/ui-sprites";
  style.textContent = `
#${OVERLAY_ID} {
  position: fixed;
  left: 50%; bottom: 220px;
  transform: translateX(-50%);
  width: 720px; height: 110px;
  z-index: 60;
  pointer-events: auto;
  font-family: var(--hb-font-serif);
  color: var(--hb-text-cream);
  display: none;
  user-select: none;
}
#${OVERLAY_ID}[data-open="1"] { display: block; }
#${OVERLAY_ID} .hvb-top-strip {
  position: relative;
  height: 22px;
  display: flex;
  align-items: flex-end;
  padding: 0 28px 0 8px;
  background: url("${SP}/0x06005F10.png") repeat-x;
  background-size: auto 22px;
}
#${OVERLAY_ID} .hvb-tabs { display: flex; gap: 0; align-items: flex-end; }
#${OVERLAY_ID} .hvb-tab {
  width: 92px; height: 20px;
  background: url("${SP}/0x06005F12.png") no-repeat center / 100% 100%;
  color: var(--hb-text-cream);
  font-family: inherit; font-size: 11px; font-weight: 600;
  border: 0; cursor: pointer; padding: 0 6px;
  text-shadow: 0 1px 0 rgba(0,0,0,.85);
  line-height: 20px;
}
#${OVERLAY_ID} .hvb-tab.active {
  background-image: url("${SP}/0x06005F11.png");
  color: var(--hb-text-gold);
}
#${OVERLAY_ID} .hvb-tab:hover:not(.active) { color: var(--hb-text-cream-bright); }
#${OVERLAY_ID} .hvb-close {
  position: absolute;
  top: 1px; right: 2px;
  width: 22px; height: 20px;
  background: url("${SP}/0x060012AA.png") no-repeat center / contain;
  border: 0; cursor: pointer; padding: 0;
  font-size: 0; color: transparent;
}
#${OVERLAY_ID} .hvb-close:active {
  background-image: url("${SP}/0x060012A9.png");
}
#${OVERLAY_ID} .hvb-body {
  position: relative;
  height: 88px;
  background: url("${SP}/0x06004CC2.png") repeat;
  background-color: #2a1d12;
  background-blend-mode: multiply;
  border-top: 1px solid var(--hb-border-brass);
  border-bottom: 1px solid var(--hb-border-brass-deep);
  border-left: 1px solid var(--hb-border-brass-deep);
  border-right: 1px solid var(--hb-border-brass-deep);
  overflow: hidden;
}
#${OVERLAY_ID} .hvb-pane {
  position: absolute; inset: 0;
  display: none;
  padding: 4px 80px 4px 8px;
  box-sizing: border-box;
}
#${OVERLAY_ID} .hvb-pane.active { display: block; }

/* Items pane */
#${OVERLAY_ID} .hvb-cat-row {
  display: flex; align-items: center;
  gap: 6px; height: 28px;
}
#${OVERLAY_ID} .hvb-category {
  width: 117px; height: 18px;
  background: var(--hb-overlay-dark-deep);
  color: var(--hb-text-cream);
  border: 1px solid var(--hb-border-brass-dim);
  font-family: inherit; font-size: 10px;
  padding: 0 2px;
}
#${OVERLAY_ID} .hvb-selected-name {
  flex: 1 1 auto; min-width: 0;
  color: var(--hb-text-gold);
  font-size: 13px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  text-align: center;
  text-shadow: 0 1px 0 rgba(0,0,0,.85);
}
#${OVERLAY_ID} .hvb-selected-price {
  flex: 0 0 auto;
  color: var(--hb-text-cream-bright);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  margin-right: 6px;
}
#${OVERLAY_ID} .hvb-icon-strip {
  height: 36px;
  margin-top: 4px;
  display: flex; gap: 2px;
  overflow-x: auto; overflow-y: hidden;
  scrollbar-width: thin;
  scrollbar-color: var(--hb-border-brass) rgba(0,0,0,.5);
  padding-bottom: 4px;
}
#${OVERLAY_ID} .hvb-icon-cell {
  flex: 0 0 32px;
  width: 32px; height: 32px;
  background: rgba(0,0,0,.45);
  border: 1px solid var(--hb-border-brass-dim);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  font-size: 18px; line-height: 1;
  position: relative;
  transition: border-color 80ms, background 80ms;
}
#${OVERLAY_ID} .hvb-icon-cell:hover {
  border-color: var(--hb-text-gold);
  background: rgba(60,40,20,.7);
}
#${OVERLAY_ID} .hvb-icon-cell.selected {
  border-color: var(--hb-text-gold);
  box-shadow: inset 0 0 0 1px rgba(240,200,124,.6);
  background: rgba(80,55,25,.7);
}
#${OVERLAY_ID} .hvb-icon-cell img {
  width: 100%; height: 100%;
  image-rendering: pixelated;
  object-fit: contain;
}
#${OVERLAY_ID} .hvb-icon-cell .hvb-stack-badge {
  position: absolute;
  bottom: 0; right: 0;
  background: rgba(0,0,0,.75);
  color: var(--hb-text-cream-bright);
  font-size: 8px; line-height: 1;
  padding: 1px 2px;
  font-variant-numeric: tabular-nums;
}

/* Action buttons (right edge) */
#${OVERLAY_ID} .hvb-actions {
  position: absolute;
  top: 4px; right: 4px;
  display: flex; flex-direction: column;
  gap: 4px;
  width: 68px;
}
#${OVERLAY_ID} .hvb-btn {
  width: 64px; height: 22px;
  background: url("${SP}/0x06004C4C.png") no-repeat center / contain;
  border: 0;
  font-family: inherit; font-size: 11px; font-weight: 700;
  color: #d44; text-shadow: 0 1px 0 rgba(0,0,0,.85);
  cursor: pointer; padding: 0;
  letter-spacing: .02em;
}
#${OVERLAY_ID} .hvb-btn:active:not(:disabled) {
  background-image: url("${SP}/0x06004C4D.png");
  color: #b22;
}
#${OVERLAY_ID} .hvb-btn:disabled {
  background-image: url("${SP}/0x06004C4E.png");
  color: #888; cursor: not-allowed;
}

/* Queue (Buying / Selling) panes */
#${OVERLAY_ID} .hvb-queue-list {
  height: 60px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--hb-border-brass) rgba(0,0,0,.5);
  border: 1px solid var(--hb-border-brass-dim);
  background: rgba(0,0,0,.35);
  margin-top: 2px;
}
#${OVERLAY_ID} .hvb-queue-row {
  display: grid;
  grid-template-columns: 24px 1fr auto auto 18px;
  gap: 6px; align-items: center;
  padding: 1px 4px;
  border-bottom: 1px solid rgba(138,117,68,.12);
  font-size: 11px;
}
#${OVERLAY_ID} .hvb-queue-row:hover { background: rgba(80,55,25,.4); }
#${OVERLAY_ID} .hvb-queue-icon {
  width: 22px; height: 22px;
  background: rgba(0,0,0,.4);
  border: 1px solid var(--hb-border-brass-deep);
  display: flex; align-items: center; justify-content: center;
  font-size: 13px;
}
#${OVERLAY_ID} .hvb-queue-icon img {
  width: 100%; height: 100%;
  image-rendering: pixelated; object-fit: contain;
}
#${OVERLAY_ID} .hvb-queue-name {
  color: var(--hb-text-cream-bright);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#${OVERLAY_ID} .hvb-queue-qty {
  width: 38px; padding: 0 3px;
  background: var(--hb-overlay-dark-deep);
  color: var(--hb-text-cream);
  border: 1px solid var(--hb-border-brass-dim);
  font-family: inherit; font-size: 10px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
#${OVERLAY_ID} .hvb-queue-price {
  color: var(--hb-text-gold);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
#${OVERLAY_ID} .hvb-queue-remove {
  background: transparent;
  border: 0; color: #c66;
  font-size: 14px; cursor: pointer;
  padding: 0; line-height: 1;
}
#${OVERLAY_ID} .hvb-queue-remove:hover { color: #f44; }
#${OVERLAY_ID} .hvb-queue-empty {
  padding: 10px; text-align: center;
  color: var(--hb-text-muted-3); font-style: italic;
  font-size: 10px;
}
#${OVERLAY_ID} .hvb-queue-footer {
  position: absolute;
  bottom: 4px; left: 8px; right: 80px;
  display: flex; align-items: center; gap: 6px;
  font-size: 11px;
  height: 22px;
}
#${OVERLAY_ID} .hvb-queue-total {
  color: var(--hb-text-gold);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  margin-right: auto;
}

/* Sell drop zone */
#${OVERLAY_ID} .hvb-sell-drop {
  height: 16px; margin-bottom: 2px;
  border: 1px dashed var(--hb-border-brass-dim);
  background: rgba(0,0,0,.2);
  text-align: center; line-height: 16px;
  color: var(--hb-text-muted-3); font-size: 9px;
  font-style: italic;
  transition: all 120ms;
}
#${OVERLAY_ID}.hvb-drag-over .hvb-sell-drop {
  background: rgba(120,200,120,.2);
  border-color: var(--hb-text-gold);
  color: var(--hb-text-cream); font-style: normal; font-weight: 600;
}

/* Rates strip — bottom-most */
#${OVERLAY_ID} .hvb-rates {
  position: absolute;
  bottom: 4px; right: 80px;
  font-size: 9px;
  color: var(--hb-text-muted-2);
  letter-spacing: .02em;
}
#${OVERLAY_ID} .hvb-rates b { color: var(--hb-text-gold-dim); font-weight: 600; }

/* Toast */
#${OVERLAY_ID} .hvb-toast {
  position: absolute;
  top: -22px; left: 50%; transform: translateX(-50%);
  padding: 3px 10px;
  background: rgba(40,90,40,.95);
  color: var(--hb-text-cream);
  border: 1px solid #6a9a4a;
  border-radius: 3px;
  font-size: 10px;
  pointer-events: none;
  animation: hvb-toast 1700ms ease-out forwards;
}
#${OVERLAY_ID} .hvb-toast.err {
  background: rgba(120,40,40,.95);
  border-color: #c06060;
}
@keyframes hvb-toast {
  0%   { opacity: 0; transform: translate(-50%, 4px); }
  15%  { opacity: 1; transform: translate(-50%, 0); }
  85%  { opacity: 1; transform: translate(-50%, 0); }
  100% { opacity: 0; transform: translate(-50%, -8px); }
}
  `;
  document.head.appendChild(style);
}

// ─────────────────────────────────────────────────────────────────
// Singleton state (one vendor bar overlay per page)
// ─────────────────────────────────────────────────────────────────

let state = {
  overlayEl: null,
  vendorState: null,         // snapshot from getVendorState
  currentTab: "items",
  selectedItemGuid: null,
  categoryFilter: "all",
  buyQueue: [],              // [{ itemGuid, name, value, amount, iconId, itemType, stackSize, wcid }]
  sellQueue: [],             // [{ itemGuid, name, value, amount, iconId, itemType, stackSize, wcid }]
};

function setItemIcon(iconEl, item) {
  iconEl.textContent = emojiForItemType(item.itemType);
  if (!item.iconId) return;
  fetchIconDataUrl(item.iconId).then((url) => {
    if (!url || !iconEl.isConnected) return;
    iconEl.textContent = "";
    const img = document.createElement("img");
    img.src = url;
    img.alt = item.name || "";
    iconEl.appendChild(img);
  });
}

function toast(text, kind = "ok") {
  if (!state.overlayEl) return;
  const t = document.createElement("div");
  t.className = "hvb-toast" + (kind === "err" ? " err" : "");
  t.textContent = text;
  state.overlayEl.appendChild(t);
  setTimeout(() => t.remove(), 1750);
}

// ─────────────────────────────────────────────────────────────────
// Build the overlay DOM once
// ─────────────────────────────────────────────────────────────────

function buildOverlay() {
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  // Top strip — tabs + close
  const top = document.createElement("div");
  top.className = "hvb-top-strip";

  const tabs = document.createElement("div");
  tabs.className = "hvb-tabs";
  for (const t of [
    { id: "items",   label: "Items"   },
    { id: "buying",  label: "Buying"  },
    { id: "selling", label: "Selling" },
  ]) {
    const b = document.createElement("button");
    b.className = "hvb-tab" + (t.id === "items" ? " active" : "");
    b.dataset.tab = t.id;
    setAcText(b, t.label);
    b.addEventListener("click", () => switchTab(t.id));
    tabs.appendChild(b);
  }
  top.appendChild(tabs);

  const close = document.createElement("button");
  close.className = "hvb-close";
  close.title = "Close (Esc)";
  close.textContent = "x";
  close.addEventListener("click", hideOverlay);
  top.appendChild(close);
  overlay.appendChild(top);

  // Body — 3 panes
  const body = document.createElement("div");
  body.className = "hvb-body";

  // Items pane
  const itemsPane = document.createElement("div");
  itemsPane.className = "hvb-pane hvb-pane-items active";
  itemsPane.dataset.pane = "items";
  itemsPane.innerHTML = `
    <div class="hvb-cat-row">
      <select class="hvb-category"></select>
      <div class="hvb-selected-name">— select an item —</div>
      <div class="hvb-selected-price"></div>
    </div>
    <div class="hvb-icon-strip"></div>
    <div class="hvb-rates"></div>
  `;
  body.appendChild(itemsPane);

  // Buying pane
  const buyingPane = document.createElement("div");
  buyingPane.className = "hvb-pane hvb-pane-buying";
  buyingPane.dataset.pane = "buying";
  buyingPane.innerHTML = `
    <div class="hvb-queue-list"></div>
    <div class="hvb-queue-footer">
      <span class="hvb-queue-total">Cost: 0 p</span>
    </div>
  `;
  body.appendChild(buyingPane);

  // Selling pane
  const sellingPane = document.createElement("div");
  sellingPane.className = "hvb-pane hvb-pane-selling";
  sellingPane.dataset.pane = "selling";
  sellingPane.innerHTML = `
    <div class="hvb-sell-drop">Drag inventory items here to sell</div>
    <div class="hvb-queue-list"></div>
    <div class="hvb-queue-footer">
      <span class="hvb-queue-total">Credit: 0 p</span>
    </div>
  `;
  body.appendChild(sellingPane);

  overlay.appendChild(body);

  // Action buttons (right edge, span whole body)
  const actions = document.createElement("div");
  actions.className = "hvb-actions";
  // Items tab: Buy (instant) + Add to List (queue)
  // Buying / Selling tabs: Clear + Confirm
  // We render all 4 buttons; show/hide on tab switch.
  for (const btn of [
    { id: "buy",        label: "Buy",         tabs: ["items"]   },
    { id: "add",        label: "Add to List", tabs: ["items"]   },
    { id: "clear-buy",  label: "Clear",       tabs: ["buying"]  },
    { id: "confirm-buy",label: "Confirm",     tabs: ["buying"]  },
    { id: "clear-sell", label: "Clear",       tabs: ["selling"] },
    { id: "confirm-sell",label:"Confirm",     tabs: ["selling"] },
  ]) {
    const b = document.createElement("button");
    b.className = `hvb-btn hvb-btn-${btn.id}`;
    b.dataset.action = btn.id;
    b.dataset.tabs = btn.tabs.join(",");
    setAcText(b, btn.label);
    b.disabled = true;
    actions.appendChild(b);
  }
  overlay.appendChild(actions);

  document.body.appendChild(overlay);

  // Wire action buttons
  actions.querySelector(".hvb-btn-buy").addEventListener("click", handleBuyInstant);
  actions.querySelector(".hvb-btn-add").addEventListener("click", handleAddToBuying);
  actions.querySelector(".hvb-btn-clear-buy").addEventListener("click", () => {
    state.buyQueue = []; render();
  });
  actions.querySelector(".hvb-btn-confirm-buy").addEventListener("click", handleConfirmBuy);
  actions.querySelector(".hvb-btn-clear-sell").addEventListener("click", () => {
    state.sellQueue = []; render();
  });
  actions.querySelector(".hvb-btn-confirm-sell").addEventListener("click", handleConfirmSell);

  // Category dropdown
  const cat = itemsPane.querySelector(".hvb-category");
  for (const c of CATEGORY_TABLE) {
    const opt = document.createElement("option");
    opt.value = c.id; opt.textContent = c.label;
    cat.appendChild(opt);
  }
  cat.addEventListener("change", (e) => {
    state.categoryFilter = e.target.value;
    state.selectedItemGuid = null;
    render();
  });

  // Drag-drop for Sell — accepts inventory drags from inventory.js.
  overlay.addEventListener("dragenter", onDragEnter);
  overlay.addEventListener("dragover", onDragOver);
  overlay.addEventListener("dragleave", onDragLeave);
  overlay.addEventListener("drop", onDrop);

  // Esc to close.
  document.addEventListener("keydown", onKeyDown);

  return overlay;
}

function onKeyDown(ev) {
  if (ev.key === "Escape" && state.overlayEl?.dataset.open === "1") {
    hideOverlay();
  }
}

function onDragEnter(ev) {
  if (ev.dataTransfer?.types?.includes("text/x-hb-item-guid")) {
    ev.preventDefault();
    state.overlayEl.classList.add("hvb-drag-over");
  }
}
function onDragOver(ev) {
  if (ev.dataTransfer?.types?.includes("text/x-hb-item-guid")) {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
  }
}
function onDragLeave(ev) {
  if (ev.target === state.overlayEl) state.overlayEl.classList.remove("hvb-drag-over");
}
function onDrop(ev) {
  state.overlayEl.classList.remove("hvb-drag-over");
  const guidStr = ev.dataTransfer?.getData("text/x-hb-item-guid");
  if (!guidStr) return;
  ev.preventDefault();
  const guid = parseInt(guidStr, 10) >>> 0;
  if (!guid) return;
  // Pull item details from the live wasm inventory snapshot.
  const handle = window.__sessionHandle;
  const inv = handle?.playerInventory?.() || [];
  const item = inv.find((i) => (i.guid >>> 0) === guid);
  if (!item) {
    toast(`drop: item 0x${guid.toString(16)} not in inventory`, "err");
    return;
  }
  // Switch to Selling tab and stage the item.
  state.currentTab = "selling";
  const existing = state.sellQueue.find((q) => q.itemGuid === guid);
  if (existing) {
    existing.amount = Math.min(existing.amount + 1, item.stackSize || 1);
  } else {
    state.sellQueue.push({
      itemGuid: guid,
      wcid: item.wcid,
      name: item.name,
      value: item.value,
      stackSize: item.stackSize || 1,
      itemType: 0,
      iconId: 0,
      amount: 1,
    });
  }
  render();
  toast(`Staged "${item.name}" for sale`);
}

function switchTab(tabId) {
  state.currentTab = tabId;
  render();
}

function showOverlay() {
  if (!state.overlayEl) state.overlayEl = buildOverlay();
  state.overlayEl.dataset.open = "1";
}

function hideOverlay() {
  if (!state.overlayEl) return;
  state.overlayEl.dataset.open = "0";
  // Drop queues on close so reopening a different vendor is clean.
  state.buyQueue = [];
  state.sellQueue = [];
  state.selectedItemGuid = null;
}

// ─────────────────────────────────────────────────────────────────
// Render — diff-free full re-render. Cheap (max 53 items per vendor).
// ─────────────────────────────────────────────────────────────────

function render() {
  const ov = state.overlayEl;
  if (!ov) return;
  const vs = state.vendorState;
  if (!vs) return;

  // Update tab labels with counts + active class.
  ov.querySelectorAll(".hvb-tab").forEach((b) => {
    const id = b.dataset.tab;
    let label = id[0].toUpperCase() + id.slice(1);
    if (id === "buying" && state.buyQueue.length)
      label += ` (${state.buyQueue.length})`;
    if (id === "selling" && state.sellQueue.length)
      label += ` (${state.sellQueue.length})`;
    setAcText(b, label);
    b.classList.toggle("active", id === state.currentTab);
  });

  // Show only the active pane.
  ov.querySelectorAll(".hvb-pane").forEach((p) => {
    p.classList.toggle("active", p.dataset.pane === state.currentTab);
  });

  // Show only the action buttons that belong to the active tab.
  ov.querySelectorAll(".hvb-btn").forEach((b) => {
    const tabs = (b.dataset.tabs || "").split(",");
    b.style.display = tabs.includes(state.currentTab) ? "block" : "none";
  });

  if (state.currentTab === "items") renderItemsPane();
  else if (state.currentTab === "buying") renderQueuePane("buying");
  else if (state.currentTab === "selling") renderQueuePane("selling");
}

function renderItemsPane() {
  const ov = state.overlayEl;
  const vs = state.vendorState;
  const cat = CATEGORY_TABLE.find((c) => c.id === state.categoryFilter) ?? CATEGORY_TABLE[0];
  const items = vs.items.filter((it) => state.categoryFilter === "all" || (it.itemType & cat.mask));

  // Selected item header
  const nameEl = ov.querySelector(".hvb-selected-name");
  const priceEl = ov.querySelector(".hvb-selected-price");
  const sel = items.find((i) => i.itemGuid === state.selectedItemGuid);
  const myPyreals = countPyreals();
  if (sel) {
    const price = Math.round((sel.value || 0) * (vs.buyMultiplier || 1));
    setAcText(nameEl, sel.name || `wcid ${sel.wcid}`);
    setAcText(priceEl, `costs ${fmtPrice(price)} p (you have ${fmtPrice(myPyreals)} p)`);
  } else {
    setAcText(nameEl, items.length ? "— select an item —" : "(no items in this category)");
    setAcText(priceEl, `(you have ${fmtPrice(myPyreals)} p)`);
  }

  // Icon strip
  const strip = ov.querySelector(".hvb-icon-strip");
  strip.innerHTML = "";
  for (const it of items) {
    const cell = document.createElement("div");
    cell.className = "hvb-icon-cell";
    cell.dataset.itemGuid = String(it.itemGuid);
    if (it.itemGuid === state.selectedItemGuid) cell.classList.add("selected");
    setItemIcon(cell, it);
    if ((it.stackSize || 1) > 1) {
      const badge = document.createElement("div");
      badge.className = "hvb-stack-badge";
      setAcText(badge, String(it.stackSize));
      cell.appendChild(badge);
    }
    cell.title = `${it.name} — ${fmtPrice((it.value || 0) * (vs.buyMultiplier || 1))}p`;
    cell.addEventListener("click", () => {
      state.selectedItemGuid = it.itemGuid;
      render();
    });
    cell.addEventListener("dblclick", () => {
      state.selectedItemGuid = it.itemGuid;
      handleBuyInstant();
    });
    strip.appendChild(cell);
  }

  // Rates strip
  const rates = ov.querySelector(".hvb-rates");
  rates.innerHTML =
    `Sells <b>${Math.round((vs.buyMultiplier || 1) * 100)}%</b> · ` +
    `Buys <b>${Math.round((vs.sellMultiplier || 1) * 100)}%</b>`;

  // Enable Buy / Add buttons only when something is selected.
  const buyBtn = ov.querySelector(".hvb-btn-buy");
  const addBtn = ov.querySelector(".hvb-btn-add");
  buyBtn.disabled = !sel;
  addBtn.disabled = !sel;
}

function renderQueuePane(which) {
  const ov = state.overlayEl;
  const pane = ov.querySelector(`.hvb-pane-${which}`);
  const list = pane.querySelector(".hvb-queue-list");
  const totalEl = pane.querySelector(".hvb-queue-total");
  const vs = state.vendorState;
  const queue = which === "buying" ? state.buyQueue : state.sellQueue;
  const mult = which === "buying" ? (vs.buyMultiplier || 1) : (vs.sellMultiplier || 1);

  list.innerHTML = "";
  if (queue.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hvb-queue-empty";
    setAcText(empty, which === "buying"
      ? "Empty. Click an item in the Items tab + \"Add to List\"."
      : "Empty. Drag inventory items onto this panel.");
    list.appendChild(empty);
  }

  let total = 0;
  for (const q of queue) {
    const lineTotal = Math.round((q.value || 0) * mult * q.amount);
    total += lineTotal;
    const row = document.createElement("div");
    row.className = "hvb-queue-row";
    const iconEl = document.createElement("div");
    iconEl.className = "hvb-queue-icon";
    setItemIcon(iconEl, q);
    const nameEl = document.createElement("div");
    nameEl.className = "hvb-queue-name";
    setAcText(nameEl, q.name);
    const qtyEl = document.createElement("input");
    qtyEl.className = "hvb-queue-qty";
    qtyEl.type = "number";
    qtyEl.min = 1;
    qtyEl.max = q.stackSize || 9999;
    qtyEl.value = q.amount;
    qtyEl.addEventListener("input", (e) => {
      const v = parseInt(e.target.value, 10);
      q.amount = Math.max(1, Math.min(v || 1, q.stackSize || 9999));
      render();
    });
    const priceEl = document.createElement("div");
    priceEl.className = "hvb-queue-price";
    setAcText(priceEl, `${fmtPrice(lineTotal)} p`);
    const rmEl = document.createElement("button");
    rmEl.className = "hvb-queue-remove";
    rmEl.textContent = "×";
    rmEl.title = "Remove from list";
    rmEl.addEventListener("click", () => {
      const idx = queue.indexOf(q);
      if (idx >= 0) queue.splice(idx, 1);
      render();
    });
    row.appendChild(iconEl);
    row.appendChild(nameEl);
    row.appendChild(qtyEl);
    row.appendChild(priceEl);
    row.appendChild(rmEl);
    list.appendChild(row);
  }

  const label = which === "buying" ? "Cost" : "Credit";
  setAcText(totalEl, `${label}: ${fmtPrice(total)} p`);

  // Enable Confirm only when queue is non-empty.
  const confirmBtn = ov.querySelector(`.hvb-btn-confirm-${which.slice(0, -3)}`);
  const clearBtn = ov.querySelector(`.hvb-btn-clear-${which.slice(0, -3)}`);
  if (confirmBtn) confirmBtn.disabled = queue.length === 0;
  if (clearBtn) clearBtn.disabled = queue.length === 0;
}

function countPyreals() {
  const inv = window.__sessionHandle?.playerInventory?.() || [];
  let n = 0;
  for (const i of inv) if (i.wcid === 273) n += i.stackSize || 0;
  return n;
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
  if (!handle?.buyFromVendor) return toast("buy: no session handle", "err");
  const vs = state.vendorState;
  if (!vs?.vendorGuid) return;
  const sel = findSelectedItem();
  if (!sel) return toast("buy: select an item first", "err");
  try {
    handle.buyFromVendor(
      vs.vendorGuid >>> 0,
      new Uint32Array([sel.itemGuid >>> 0]),
      new Int32Array([1]),
    );
    toast(`Buying 1 × ${sel.name}…`);
  } catch (err) {
    console.warn("[vendor-ui] buy failed", err);
    toast(`buy error: ${err.message || err}`, "err");
  }
}

function handleAddToBuying() {
  const sel = findSelectedItem();
  if (!sel) return;
  const existing = state.buyQueue.find((q) => q.itemGuid === sel.itemGuid);
  if (existing) {
    existing.amount = Math.min(existing.amount + 1, sel.stackSize || 9999);
  } else {
    state.buyQueue.push({
      itemGuid: sel.itemGuid,
      wcid: sel.wcid,
      name: sel.name,
      value: sel.value,
      stackSize: sel.stackSize || 1,
      itemType: sel.itemType,
      iconId: sel.iconId,
      amount: 1,
    });
  }
  toast(`Added "${sel.name}" to buy list`);
  render();
}

function handleConfirmBuy() {
  const handle = window.__sessionHandle;
  if (!handle?.buyFromVendor) return toast("buy: no session handle", "err");
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
    toast(`buy error: ${err.message || err}`, "err");
  }
}

function handleConfirmSell() {
  const handle = window.__sessionHandle;
  if (!handle?.sellToVendor) return toast("sell: no session handle", "err");
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
    toast(`sell error: ${err.message || err}`, "err");
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
  version: "0.4.0",
  description: "Retail-style horizontal vendor bar — auto-opens on kind=12 VendorOpened",
};

export function mount(ctx) {
  ensureStyles();
  let pollTimer = null;
  let unsubscribe = null;

  function tryHook() {
    const client = ctx?.client ?? window.__pluginClient ?? null;
    const handle = window.__sessionHandle ?? null;
    if (!client?.events?.on || !handle?.getVendorState) return false;

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
          if (retry) openWith(retry);
        }, 50);
        return;
      }
      openWith(raw);
    };

    const onInvChanged = () => {
      if (!state.vendorState?.vendorGuid) return;
      try {
        const raw = handle.getVendorState(state.vendorState.vendorGuid >>> 0);
        if (raw) {
          state.vendorState = snapshotFromWasm(raw);
          render();
        }
      } catch (e) {
        console.warn("[vendor-ui] inv-changed re-pull failed", e);
      }
    };

    client.events.on("vendorOpened", onVendorOpened);
    client.events.on("kind:12", onVendorOpened);
    client.events.on("VendorOpened", onVendorOpened);
    client.events.on("playerInventoryChanged", onInvChanged);

    unsubscribe = () => {
      client.events.off?.("vendorOpened", onVendorOpened);
      client.events.off?.("kind:12", onVendorOpened);
      client.events.off?.("VendorOpened", onVendorOpened);
      client.events.off?.("playerInventoryChanged", onInvChanged);
    };
    return true;
  }

  function openWith(rawState) {
    state.vendorState = snapshotFromWasm(rawState);
    // Reset transient UI state on (re)open of a vendor.
    state.currentTab = "items";
    state.selectedItemGuid = null;
    state.categoryFilter = "all";
    // Preserve buy/sell queues across re-fires of the SAME vendor —
    // ACE refreshes kind=12 after every buy. Drop the queues only
    // when switching vendors.
    showOverlay();
    const ov = state.overlayEl;
    if (ov) {
      const cat = ov.querySelector(".hvb-category");
      if (cat) cat.value = "all";
    }
    render();
  }

  if (!tryHook()) {
    pollTimer = setInterval(() => {
      if (tryHook()) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }, 500);
  }

  return () => {
    if (pollTimer) clearInterval(pollTimer);
    if (unsubscribe) unsubscribe();
    document.removeEventListener("keydown", onKeyDown);
    if (state.overlayEl) {
      state.overlayEl.remove();
      state.overlayEl = null;
    }
  };
}

// Debug helper: pop a synthetic vendor from DevTools.
//   __vendorBarDebug() — fake "Lin the Trader" w/ a handful of stock
if (typeof window !== "undefined") {
  window.__vendorBarDebug = function () {
    ensureStyles();
    state.vendorState = {
      vendorGuid: 0xDEADBEEF,
      vendorName: "Lin the Trader (debug)",
      buyMultiplier: 1.1,
      sellMultiplier: 0.4,
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
    state.currentTab = "items";
    state.selectedItemGuid = null;
    state.buyQueue = [];
    state.sellQueue = [];
    showOverlay();
    render();
  };
}
