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
 * Layout 0x21000012 — gmVendorUI. Full port via applyVendorLayout()
 * (2026-05-24); element_id → purpose map confirmed by
 * vendor_ui_layout_dump:
 *
 *   Root 0x100000B7 — 800×110, design-canvas y=500.
 *   Outer panel 0x100000B8 — 800×110 wrapper for tabs + panes.
 *   Tabs (3): 92×20 each, top-left.
 *     0x100000B9 Items   (  0,0)
 *     0x100000BA Buying  ( 92,0)
 *     0x100000BB Selling (184,0)
 *   Top strip background 0x1000008D — 800×20, sprite 0x06005F10.
 *   Close X 0x100000D6 — 22×20 at (776,0), 2 states (0x060012A9/AA).
 *
 *   Items pane 0x100000BC — 800×90 at (0,20).
 *     0x100000BF category dropdown — 117×18 at (4,4)
 *     0x100000C0 selected-item name — 590×15 at (125,0)
 *     0x100000C1 selected-item price — 590×15 at (125,15)
 *     0x100000BD icon strip — 710×32 at (10,30)
 *     0x100000BE rates / status line — 710×16 at (10,63)
 *     0x100000C2 Buy button — 64×22 at (732,4)
 *     0x100000C3 Add to List button — 64×22 at (732,30)
 *
 *   Buying pane 0x100000C4 — 800×90 at (0,20).
 *     0x100000C5 queue list area — 710×32 at (10,30)
 *     0x100000C6 queue footer (total) — 710×16 at (10,63)
 *     0x100000C7 selected-name (590×15 at 125,0)
 *     0x100000C8 selected-price (590×15 at 125,15)
 *     0x100000C9 Confirm — 64×22 at (732,4)
 *     0x100000CA Clear — 64×22 at (732,30)
 *     0x100000CB Total label — 65×14 at (4,1)
 *     0x100000CC Sub-total label — 65×14 at (4,15)
 *
 *   Selling pane 0x100000CD — mirrors Buying (0x100000CE-D5).
 *
 *   Standalone sprites: 0x100000DA-DC (800×90 pane backgrounds);
 *   0x100000DD-E1 (button state-sprite refs); 0x1000048E (orphan,
 *   2 states; likely a sound/animation cue not yet mapped).
 *
 * Buttons use sprite 0x06004C4C (normal) / 4D (pressed) / 4E (ghosted).
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

import { setAcText, HEADING_FONT_ID } from "../ui/ac_font.js";
import { resolveLocalBinding, matchesBinding, LOCAL_ACTION_IDS } from "../ui/keymap.js";
import { loadLayout, findElementById, getCachedLayout } from "../ui/ac_layout.js";
import { fetchIconDataUrl as fetchIconDataUrlShared } from "../ui/ac_icon_cache.js";

// gmVendorUI 0x21000012 — element_id constants from
// vendor_ui_layout_dump 2026-05-24. See head-comment block above for
// the full element-purpose mapping.
const VENDOR_LAYOUT_ID = 0x21000012;
const VENDOR_ELEMS = {
  // Outer panel wrapper inside the root.
  outer:        0x100000B8,
  // Tabs (top-left row).
  tabItems:     0x100000B9,
  tabBuying:    0x100000BA,
  tabSelling:   0x100000BB,
  // Top strip + close (sit outside the panes).
  topStrip:     0x1000008D,
  closeBtn:     0x100000D6,
  // Items pane + its 7 children.
  itemsPane:    0x100000BC,
  itemsCat:     0x100000BF,  // category dropdown
  itemsName:    0x100000C0,  // selected-item name
  itemsPrice:   0x100000C1,  // selected-item price
  itemsStrip:   0x100000BD,  // icon strip
  itemsRates:   0x100000BE,  // rates / status line
  itemsBuyBtn:  0x100000C2,  // Buy
  itemsAddBtn:  0x100000C3,  // Add to List
  // Buying pane + its 8 children.
  buyingPane:    0x100000C4,
  buyingList:    0x100000C5,
  buyingFooter:  0x100000C6,
  buyingName:    0x100000C7,
  buyingPrice:   0x100000C8,
  buyingConfirmBtn: 0x100000C9,
  buyingClearBtn:   0x100000CA,
  buyingTotalLbl:   0x100000CB,
  buyingSubLbl:     0x100000CC,
  // Selling pane + its 8 children.
  sellingPane:    0x100000CD,
  sellingList:    0x100000CE,
  sellingFooter:  0x100000CF,
  sellingName:    0x100000D0,
  sellingPrice:   0x100000D1,
  sellingConfirmBtn: 0x100000D2,
  sellingClearBtn:   0x100000D3,
  sellingTotalLbl:   0x100000D4,
  sellingSubLbl:     0x100000D5,
};

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

// Wave 15 — icon cache consolidated into `ui/ac_icon_cache.js` so the
// vendor / container / trade / buffs / inventory plugins all share the
// same cache (a fetch for icon X anywhere benefits everywhere on the
// next request). Local thin wrapper preserves the historical
// `[vendor-ui]` warn label.
async function fetchIconDataUrl(iconId) {
  return fetchIconDataUrlShared(iconId, "vendor-ui");
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
    // Wave F.4 (2026-05-27): typed-profile fields. populated by
    // `enrichWithProfile()` after the wasm getCurrentVendorProfile call.
    // Defaults match retail "no restriction" sentinels.
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
 * (typed VendorProfile, includes buyAcceptCategories / dealsMagic /
 * minValue / maxValue / pre-computed per-item buyPrice) onto an
 * existing `snapshotFromWasm` snapshot. The two wasm calls share the
 * same `latest_vendor_state` cache, so the data is consistent.
 *
 * If `profile` is null (no F.4 export available, or the cache is
 * stale), the snapshot keeps its Wave-7 shape with default "no
 * restriction" sentinels in the new fields. Vendor-ui then degrades
 * gracefully to the Wave-7 behavior.
 *
 * Cross-references:
 *   - `apps/holtburger-web/src/lib.rs::SessionHandle::getCurrentVendorProfile`
 *   - `crates/holtburger-protocol/src/messages/trade/profile.rs::VendorProfile`
 *   - `external/chorizite/Chorizite.ACProtocol/.../VendorProfile.generated.cs`
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
  // Profile stock has pre-computed buyPrice + categoryBit per entry.
  // Index by itemGuid so we can copy into the existing items array
  // (which was built first from the flat Wave-7 path).
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

/**
 * Wave F.4 (2026-05-27) — retail-formula buy price for a vendor stock
 * entry. Mirrors `ShopSystem::BuyPrice` from acclient.c:719870.
 *
 * Promissory notes (item type 0x40000) ignore the per-vendor
 * multiplier — retail uses a flat 1.0. Other types: floor(unit_value *
 * num_item * buy_multiplier + 0.1). Result is at least 1 pyreal
 * (vendors don't give items away).
 *
 * Used for fallback display when the wasm typed export isn't available
 * (e.g. pre-bake JS-only smoke tests).
 */
function shopBuyPrice(unitValue, itemType, buyMultiplier, numItem) {
  const PROMISSORY_NOTE_BIT = 0x40000;
  const multiplier = itemType === PROMISSORY_NOTE_BIT ? 1.0 : buyMultiplier;
  const raw = Math.floor(multiplier * unitValue * numItem + 0.1);
  if (raw === 0) return 1;
  if (raw < 0 || raw > 0x7FFFFFFF) return -1;
  return raw;
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
  // Retail port (2026-05-24): every visual element uses the
  // gmVendorUI 0x21000012 element positions as the source of truth.
  // CSS sets sensible defaults so the panel is usable before
  // applyVendorLayout() lands; absolute positioning everywhere so the
  // layout-driven overrides land cleanly. Panel matches retail
  // 800×110 dims (was 720×136 in the hand-tuned version which added a
  // separate 26px title bar — retail folds the vendor identity into
  // the active tab + close button, so the title bar is gone).
  style.textContent = `
#${OVERLAY_ID} {
  position: fixed;
  left: 50%; bottom: 220px;
  transform: translateX(-50%);
  width: 800px; height: 110px;
  z-index: 60;
  pointer-events: auto;
  font-family: var(--hb-font-serif);
  color: var(--hb-text-cream);
  display: none;
  user-select: none;
  box-sizing: border-box;
}
#${OVERLAY_ID}[data-open="1"] { display: block; }
/* Top strip background — element 0x1000008D, 800×20 at (0,0).
   Sprite 0x06005F10 tiles horizontally. */
#${OVERLAY_ID} .hvb-top-strip {
  position: absolute;
  left: 0; top: 0;
  width: 800px; height: 20px;
  background: url("${SP}/0x06005F10.png") repeat-x;
  background-size: auto 20px;
  box-sizing: border-box;
  z-index: 1;
}
/* Tabs — each 92×20, layout-positioned (0x100000B9/BA/BB at
   x = 0/92/184, y=0). The CSS default just sets sizing; applyVendorLayout
   overrides left/top from the LayoutDesc. */
#${OVERLAY_ID} .hvb-tab {
  position: absolute;
  top: 0;
  width: 92px; height: 20px;
  background: url("${SP}/0x06005F12.png") no-repeat center / 100% 100%;
  color: var(--hb-text-cream);
  font-family: inherit; font-size: 11px; font-weight: 600;
  border: 0; cursor: pointer; padding: 0 6px;
  text-shadow: 0 1px 0 rgba(0,0,0,.85);
  line-height: 20px;
  z-index: 3;
  box-sizing: border-box;
}
#${OVERLAY_ID} .hvb-tab[data-tab="items"]   { left: 0; }
#${OVERLAY_ID} .hvb-tab[data-tab="buying"]  { left: 92px; }
#${OVERLAY_ID} .hvb-tab[data-tab="selling"] { left: 184px; }
#${OVERLAY_ID} .hvb-tab.active {
  background-image: url("${SP}/0x06005F11.png");
  color: var(--hb-text-gold);
}
#${OVERLAY_ID} .hvb-tab:hover:not(.active) { color: var(--hb-text-cream-bright); }
/* Close button — element 0x100000D6, 22×20 at (776,0). */
#${OVERLAY_ID} .hvb-close {
  position: absolute;
  left: 776px; top: 0;
  width: 22px; height: 20px;
  background: url("${SP}/0x060012AA.png") no-repeat center / contain;
  border: 0; cursor: pointer; padding: 0;
  font-size: 0; color: transparent;
  z-index: 4;
  box-sizing: border-box;
}
#${OVERLAY_ID} .hvb-close:active {
  background-image: url("${SP}/0x060012A9.png");
}
/* Body — 800×90 at (0,20). Hosts the 3 panes. */
#${OVERLAY_ID} .hvb-body {
  position: absolute;
  left: 0; top: 20px;
  width: 800px; height: 90px;
  background: url("${SP}/0x06004CC2.png") repeat;
  background-color: #2a1d12;
  background-blend-mode: multiply;
  border-top: 1px solid var(--hb-border-brass);
  border-bottom: 1px solid var(--hb-border-brass-deep);
  border-left: 1px solid var(--hb-border-brass-deep);
  border-right: 1px solid var(--hb-border-brass-deep);
  overflow: visible;
  box-sizing: border-box;
}
/* Each pane is sized 800×90 with absolute children pinned to retail
   x/y inside the body. The pane itself stays at (0, 0) inside .hvb-body
   so layout-driven children compute relative to the pane origin. */
#${OVERLAY_ID} .hvb-pane {
  position: absolute;
  left: 0; top: 0;
  width: 800px; height: 90px;
  display: none;
  box-sizing: border-box;
}
#${OVERLAY_ID} .hvb-pane.active { display: block; }

/* Items pane — children are absolute and positioned via layout. */
/* P3-45 — UIElement_Menu port. The category dropdown is a custom
   div+ul rather than a native <select> so the brass-trim aesthetic
   matches the rest of the vendor frame. Keyboard accessible: Enter
   opens, ArrowUp/Down moves, Enter commits, Escape closes. The
   underlying <select> is hidden but kept in place so existing
   applyVendorLayout positioning + change-event semantics still work. */
#${OVERLAY_ID} .hvb-category {
  display: none;
}
#${OVERLAY_ID} .hvb-menu {
  position: absolute;
  left: 4px; top: 4px;
  width: 117px; height: 18px;
  background: var(--hb-overlay-dark-deep);
  color: var(--hb-text-cream);
  border: 1px solid var(--hb-border-brass-dim);
  font-family: inherit;
  font-size: 10px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  padding: 0 4px;
  cursor: pointer;
  user-select: none;
  outline: none;
}
#${OVERLAY_ID} .hvb-menu:hover,
#${OVERLAY_ID} .hvb-menu:focus {
  border-color: var(--hb-border-brass);
  color: var(--hb-text-cream-bright);
}
#${OVERLAY_ID} .hvb-menu-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#${OVERLAY_ID} .hvb-menu-chevron {
  margin-left: 4px;
  color: var(--hb-border-brass);
  font-size: 8px;
  line-height: 1;
}
#${OVERLAY_ID} .hvb-menu-panel {
  position: absolute;
  left: 4px;
  top: 22px;
  width: 117px;
  max-height: 240px;
  overflow-y: auto;
  background: var(--hb-overlay-dark-deep);
  border: 1px solid var(--hb-border-brass);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.55);
  z-index: 80;
  font-family: inherit;
  font-size: 10px;
  padding: 2px;
  display: none;
  box-sizing: border-box;
  scrollbar-width: thin;
  scrollbar-color: var(--hb-border-brass) var(--hb-overlay-dark-deep);
}
#${OVERLAY_ID} .hvb-menu-panel[data-open="1"] {
  display: block;
}
#${OVERLAY_ID} .hvb-menu-item {
  padding: 2px 6px;
  cursor: pointer;
  color: var(--hb-text-cream);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border: 1px solid transparent;
  box-sizing: border-box;
}
#${OVERLAY_ID} .hvb-menu-item:hover,
#${OVERLAY_ID} .hvb-menu-item[data-focused="1"] {
  background: var(--hb-overlay-hover);
  border-color: var(--hb-border-brass-dim);
  color: var(--hb-text-cream-bright);
}
#${OVERLAY_ID} .hvb-menu-item[data-selected="1"] {
  color: var(--hb-text-gold);
  background: var(--hb-overlay-active);
}
#${OVERLAY_ID} .hvb-selected-name {
  position: absolute;
  left: 125px; top: 0;
  width: 590px; height: 15px;
  color: var(--hb-text-gold);
  font-size: 13px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  text-align: center;
  text-shadow: 0 1px 0 rgba(0,0,0,.85);
  line-height: 15px;
  box-sizing: border-box;
}
#${OVERLAY_ID} .hvb-selected-price {
  position: absolute;
  left: 125px; top: 15px;
  width: 590px; height: 15px;
  color: var(--hb-text-cream-bright);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  text-align: center;
  line-height: 15px;
  box-sizing: border-box;
}
#${OVERLAY_ID} .hvb-icon-strip {
  position: absolute;
  left: 10px; top: 30px;
  width: 710px; height: 32px;
  display: flex; gap: 2px;
  overflow-x: auto; overflow-y: hidden;
  scrollbar-width: thin;
  scrollbar-color: var(--hb-border-brass) rgba(0,0,0,.5);
  box-sizing: border-box;
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

/* Action buttons — absolute-positioned per the pane's layout
   children. Items pane: 0x100000C2 Buy at (732,4), 0x100000C3 Add
   at (732,30); both 64×22. Buying/Selling panes mirror at
   0x100000C9/CA + 0x100000D2/D3. CSS defaults pin them at the
   retail offsets; applyVendorLayout re-asserts from the DAT. */
#${OVERLAY_ID} .hvb-btn {
  position: absolute;
  width: 64px; height: 22px;
  background: url("${SP}/0x06004C4C.png") no-repeat center / contain;
  border: 0;
  font-family: inherit; font-size: 11px; font-weight: 700;
  color: var(--hb-text-cream); text-shadow: 0 1px 0 rgba(0,0,0,.85);
  cursor: pointer; padding: 0;
  letter-spacing: .02em;
  box-sizing: border-box;
}
#${OVERLAY_ID} .hvb-btn[data-slot="top"]    { left: 732px; top: 4px; }
#${OVERLAY_ID} .hvb-btn[data-slot="bottom"] { left: 732px; top: 30px; }
#${OVERLAY_ID} .hvb-btn:active:not(:disabled) {
  background-image: url("${SP}/0x06004C4D.png");
  color: #b22;
}
#${OVERLAY_ID} .hvb-btn:disabled {
  background-image: url("${SP}/0x06004C4E.png");
  color: #888; cursor: not-allowed;
}

/* Queue (Buying / Selling) panes — the queue list maps to the
   icon-strip rect 0x100000C5/CE (710×32 at 10,30). The narrow row
   layout means at most 2 rows are visible at a time without scrolling. */
#${OVERLAY_ID} .hvb-queue-list {
  position: absolute;
  left: 10px; top: 30px;
  width: 710px; height: 32px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--hb-border-brass) rgba(0,0,0,.5);
  border: 1px solid var(--hb-border-brass-dim);
  background: rgba(0,0,0,.35);
  box-sizing: border-box;
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
  padding: 4px; text-align: center;
  color: var(--hb-text-muted-3); font-style: italic;
  font-size: 10px;
}
/* Queue footer — element 0x100000C6/CF (710×16 at 10,63). */
#${OVERLAY_ID} .hvb-queue-footer {
  position: absolute;
  left: 10px; top: 63px;
  width: 710px; height: 16px;
  display: flex; align-items: center; gap: 6px;
  font-size: 11px;
  box-sizing: border-box;
}
#${OVERLAY_ID} .hvb-queue-total {
  color: var(--hb-text-gold);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  margin-right: auto;
}

/* Sell drop zone — sits at the top-left of the selling pane, mapping
   into the queue list area. Visual cue when an inventory item is being
   dragged over the panel. */
#${OVERLAY_ID} .hvb-sell-drop {
  position: absolute;
  left: 10px; top: 30px;
  width: 710px; height: 32px;
  border: 1px dashed var(--hb-border-brass-dim);
  background: rgba(0,0,0,.2);
  text-align: center;
  line-height: 30px;
  color: var(--hb-text-muted-3); font-size: 9px;
  font-style: italic;
  transition: all 120ms;
  pointer-events: none;
  z-index: 1;
  box-sizing: border-box;
}
#${OVERLAY_ID}.hvb-drag-over .hvb-sell-drop {
  background: rgba(120,200,120,.2);
  border-color: var(--hb-text-gold);
  color: var(--hb-text-cream); font-style: normal; font-weight: 600;
}

/* Rates strip — element 0x100000BE (710×16 at 10,63). */
#${OVERLAY_ID} .hvb-rates {
  position: absolute;
  left: 10px; top: 63px;
  width: 710px; height: 16px;
  font-size: 10px;
  color: var(--hb-text-muted-2);
  letter-spacing: .02em;
  line-height: 16px;
  box-sizing: border-box;
}
#${OVERLAY_ID} .hvb-rates b { color: var(--hb-text-gold-dim); font-weight: 600; }
/* Total / Sub-total labels on Buying/Selling panes — elements
   0x100000CB/CC + 0x100000D4/D5 (65×14 at 4,1 / 4,15). */
#${OVERLAY_ID} .hvb-total-lbl,
#${OVERLAY_ID} .hvb-sub-lbl {
  position: absolute;
  left: 4px;
  width: 65px; height: 14px;
  font-size: 9px;
  color: var(--hb-text-muted-2);
  letter-spacing: .02em;
  line-height: 14px;
  box-sizing: border-box;
}
#${OVERLAY_ID} .hvb-total-lbl { top: 1px; }
#${OVERLAY_ID} .hvb-sub-lbl   { top: 15px; }

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

  // Top strip background (0x1000008D, 800×20 at 0,0). Behind tabs.
  const topStrip = document.createElement("div");
  topStrip.className = "hvb-top-strip";
  overlay.appendChild(topStrip);

  // Tabs — Items / Buying / Selling. CSS defaults pin them at the
  // retail (0/92/184, 0) offsets; applyVendorLayout re-asserts.
  const tabEls = {};
  for (const t of [
    { id: "items",   label: "Items"   },
    { id: "buying",  label: "Buying"  },
    { id: "selling", label: "Selling" },
  ]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "hvb-tab" + (t.id === "items" ? " active" : "");
    b.dataset.tab = t.id;
    setAcText(b, t.label, { color: t.id === "items" ? "#f0c87c" : "#f0d8a0" });
    b.addEventListener("click", () => switchTab(t.id));
    overlay.appendChild(b);
    tabEls[t.id] = b;
  }

  // Close X — sits at (776, 0). Vendor name is conveyed by the active
  // tab + the selected-name field; no separate title bar (retail
  // doesn't have one).
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "hvb-close";
  closeBtn.title = "Close (Esc)";
  closeBtn.textContent = "x";
  closeBtn.addEventListener("click", hideOverlay);
  overlay.appendChild(closeBtn);

  // Body — hosts the 3 panes. Each pane is absolute-positioned at
  // (0,0) inside the body so layout-driven child positions land
  // relative to the pane origin (which is the retail layout's
  // pane origin).
  const body = document.createElement("div");
  body.className = "hvb-body";

  // ── Items pane ──────────────────────────────────────────────────
  // Build DOM imperatively so we can stash refs for applyVendorLayout.
  const itemsPane = document.createElement("div");
  itemsPane.className = "hvb-pane hvb-pane-items active";
  itemsPane.dataset.pane = "items";

  // P3-45 — UIElement_Menu port. The native <select> is kept (hidden)
  // so applyVendorLayout's positioning still works on the underlying
  // ref. A custom dropdown panel renders on top of it with retail-style
  // brass chrome. Keyboard accessible via Tab + Enter + arrow keys.
  const itemsCat = document.createElement("select");
  itemsCat.className = "hvb-category";
  for (const c of CATEGORY_TABLE) {
    const opt = document.createElement("option");
    opt.value = c.id; opt.textContent = c.label;
    itemsCat.appendChild(opt);
  }
  itemsCat.addEventListener("change", (e) => {
    state.categoryFilter = e.target.value;
    state.selectedItemGuid = null;
    syncMenuFromSelect();
    render();
  });
  itemsPane.appendChild(itemsCat);

  // Custom menu button + dropdown panel.
  const menuBtn = document.createElement("div");
  menuBtn.className = "hvb-menu";
  menuBtn.setAttribute("role", "combobox");
  menuBtn.setAttribute("aria-haspopup", "listbox");
  menuBtn.setAttribute("aria-expanded", "false");
  menuBtn.setAttribute("tabindex", "0");
  const menuLabel = document.createElement("span");
  menuLabel.className = "hvb-menu-label";
  menuBtn.appendChild(menuLabel);
  const menuChevron = document.createElement("span");
  menuChevron.className = "hvb-menu-chevron";
  menuChevron.textContent = "▾";
  menuBtn.appendChild(menuChevron);
  itemsPane.appendChild(menuBtn);

  const menuPanel = document.createElement("div");
  menuPanel.className = "hvb-menu-panel";
  menuPanel.setAttribute("role", "listbox");
  for (const c of CATEGORY_TABLE) {
    const item = document.createElement("div");
    item.className = "hvb-menu-item";
    item.dataset.value = c.id;
    item.setAttribute("role", "option");
    setAcText(item, c.label);
    item.addEventListener("click", () => {
      itemsCat.value = c.id;
      itemsCat.dispatchEvent(new Event("change", { bubbles: true }));
      closeMenu();
      menuBtn.focus();
    });
    menuPanel.appendChild(item);
  }
  itemsPane.appendChild(menuPanel);

  let menuFocusIdx = 0;
  function syncMenuFromSelect() {
    const v = itemsCat.value;
    const found = CATEGORY_TABLE.find((c) => c.id === v) ?? CATEGORY_TABLE[0];
    setAcText(menuLabel, found.label);
    const items = menuPanel.querySelectorAll(".hvb-menu-item");
    items.forEach((el) => {
      const selected = el.dataset.value === v;
      el.dataset.selected = selected ? "1" : "0";
    });
  }
  function openMenu() {
    menuPanel.dataset.open = "1";
    menuBtn.setAttribute("aria-expanded", "true");
    // Move focus to the currently selected option.
    const items = Array.from(menuPanel.querySelectorAll(".hvb-menu-item"));
    menuFocusIdx = Math.max(0, items.findIndex((el) => el.dataset.selected === "1"));
    updateFocusVisible(items);
    items[menuFocusIdx]?.scrollIntoView?.({ block: "nearest" });
    document.addEventListener("mousedown", onDocMouseDown, true);
  }
  function closeMenu() {
    menuPanel.dataset.open = "0";
    menuBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onDocMouseDown, true);
  }
  function updateFocusVisible(items) {
    items.forEach((el, i) => {
      el.dataset.focused = i === menuFocusIdx ? "1" : "0";
    });
  }
  function onDocMouseDown(ev) {
    if (!menuPanel.contains(ev.target) && !menuBtn.contains(ev.target)) {
      closeMenu();
    }
  }
  menuBtn.addEventListener("click", () => {
    if (menuPanel.dataset.open === "1") closeMenu();
    else openMenu();
  });
  menuBtn.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " " || ev.key === "ArrowDown") {
      ev.preventDefault();
      if (menuPanel.dataset.open !== "1") openMenu();
    } else if (ev.key === "Escape" && menuPanel.dataset.open === "1") {
      closeMenu();
    }
  });
  menuPanel.addEventListener("keydown", (ev) => {
    const items = Array.from(menuPanel.querySelectorAll(".hvb-menu-item"));
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      menuFocusIdx = Math.min(items.length - 1, menuFocusIdx + 1);
      updateFocusVisible(items);
      items[menuFocusIdx]?.scrollIntoView?.({ block: "nearest" });
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      menuFocusIdx = Math.max(0, menuFocusIdx - 1);
      updateFocusVisible(items);
      items[menuFocusIdx]?.scrollIntoView?.({ block: "nearest" });
    } else if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      items[menuFocusIdx]?.click();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      closeMenu();
      menuBtn.focus();
    }
  });
  // Keyboard nav while the button is focused: ArrowDown opens; if the
  // panel is open and the user presses ArrowDown again, hand focus to
  // the panel so the keydown handler above takes over.
  menuPanel.setAttribute("tabindex", "-1");
  menuBtn.addEventListener("keydown", (ev) => {
    if (menuPanel.dataset.open === "1" && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) {
      menuPanel.focus();
    }
  });
  syncMenuFromSelect();

  const itemsName = document.createElement("div");
  itemsName.className = "hvb-selected-name";
  setAcText(itemsName, "— select an item —", { color: "#f0c87c" });
  itemsPane.appendChild(itemsName);

  const itemsPrice = document.createElement("div");
  itemsPrice.className = "hvb-selected-price";
  itemsPane.appendChild(itemsPrice);

  const itemsStrip = document.createElement("div");
  itemsStrip.className = "hvb-icon-strip";
  itemsPane.appendChild(itemsStrip);

  const itemsRates = document.createElement("div");
  itemsRates.className = "hvb-rates";
  itemsPane.appendChild(itemsRates);

  // Items-pane action buttons (Buy + Add to List).
  const itemsBuyBtn = document.createElement("button");
  itemsBuyBtn.type = "button";
  itemsBuyBtn.className = "hvb-btn hvb-btn-buy";
  itemsBuyBtn.dataset.slot = "top";
  itemsBuyBtn.disabled = true;
  setAcText(itemsBuyBtn, "Buy", { color: "#f0d8a0" });
  itemsBuyBtn.addEventListener("click", handleBuyInstant);
  itemsPane.appendChild(itemsBuyBtn);

  const itemsAddBtn = document.createElement("button");
  itemsAddBtn.type = "button";
  itemsAddBtn.className = "hvb-btn hvb-btn-add";
  itemsAddBtn.dataset.slot = "bottom";
  itemsAddBtn.disabled = true;
  setAcText(itemsAddBtn, "Add to List", { color: "#f0d8a0" });
  itemsAddBtn.addEventListener("click", handleAddToBuying);
  itemsPane.appendChild(itemsAddBtn);

  body.appendChild(itemsPane);

  // ── Buying pane ─────────────────────────────────────────────────
  const buyingPane = document.createElement("div");
  buyingPane.className = "hvb-pane hvb-pane-buying";
  buyingPane.dataset.pane = "buying";

  const buyingTotalLbl = document.createElement("div");
  buyingTotalLbl.className = "hvb-total-lbl";
  setAcText(buyingTotalLbl, "Total", { color: "#a89870" });
  buyingPane.appendChild(buyingTotalLbl);

  const buyingSubLbl = document.createElement("div");
  buyingSubLbl.className = "hvb-sub-lbl";
  setAcText(buyingSubLbl, "Sub", { color: "#a89870" });
  buyingPane.appendChild(buyingSubLbl);

  const buyingName = document.createElement("div");
  buyingName.className = "hvb-selected-name";
  buyingPane.appendChild(buyingName);

  const buyingPrice = document.createElement("div");
  buyingPrice.className = "hvb-selected-price";
  buyingPane.appendChild(buyingPrice);

  const buyingList = document.createElement("div");
  buyingList.className = "hvb-queue-list";
  buyingPane.appendChild(buyingList);

  const buyingFooter = document.createElement("div");
  buyingFooter.className = "hvb-queue-footer";
  const buyingTotal = document.createElement("span");
  buyingTotal.className = "hvb-queue-total";
  setAcText(buyingTotal, "Cost: 0 p", { color: "#f0c87c" });
  buyingFooter.appendChild(buyingTotal);
  buyingPane.appendChild(buyingFooter);

  const buyingConfirmBtn = document.createElement("button");
  buyingConfirmBtn.type = "button";
  buyingConfirmBtn.className = "hvb-btn hvb-btn-confirm-buy";
  buyingConfirmBtn.dataset.slot = "top";
  buyingConfirmBtn.disabled = true;
  setAcText(buyingConfirmBtn, "Confirm", { color: "#f0d8a0" });
  buyingConfirmBtn.addEventListener("click", handleConfirmBuy);
  buyingPane.appendChild(buyingConfirmBtn);

  const buyingClearBtn = document.createElement("button");
  buyingClearBtn.type = "button";
  buyingClearBtn.className = "hvb-btn hvb-btn-clear-buy";
  buyingClearBtn.dataset.slot = "bottom";
  buyingClearBtn.disabled = true;
  setAcText(buyingClearBtn, "Clear", { color: "#f0d8a0" });
  buyingClearBtn.addEventListener("click", () => {
    state.buyQueue = []; render();
  });
  buyingPane.appendChild(buyingClearBtn);

  body.appendChild(buyingPane);

  // ── Selling pane ────────────────────────────────────────────────
  const sellingPane = document.createElement("div");
  sellingPane.className = "hvb-pane hvb-pane-selling";
  sellingPane.dataset.pane = "selling";

  const sellingTotalLbl = document.createElement("div");
  sellingTotalLbl.className = "hvb-total-lbl";
  setAcText(sellingTotalLbl, "Total", { color: "#a89870" });
  sellingPane.appendChild(sellingTotalLbl);

  const sellingSubLbl = document.createElement("div");
  sellingSubLbl.className = "hvb-sub-lbl";
  setAcText(sellingSubLbl, "Sub", { color: "#a89870" });
  sellingPane.appendChild(sellingSubLbl);

  const sellingName = document.createElement("div");
  sellingName.className = "hvb-selected-name";
  sellingPane.appendChild(sellingName);

  const sellingPrice = document.createElement("div");
  sellingPrice.className = "hvb-selected-price";
  sellingPane.appendChild(sellingPrice);

  // Drop-zone hint (visible only when dragging). Sits OVER the queue
  // list but pointer-events: none so it never blocks pointer activity.
  const sellingDrop = document.createElement("div");
  sellingDrop.className = "hvb-sell-drop";
  setAcText(sellingDrop, "Drag inventory items here to sell", { color: "#807868" });
  sellingPane.appendChild(sellingDrop);

  const sellingList = document.createElement("div");
  sellingList.className = "hvb-queue-list";
  sellingPane.appendChild(sellingList);

  const sellingFooter = document.createElement("div");
  sellingFooter.className = "hvb-queue-footer";
  const sellingTotal = document.createElement("span");
  sellingTotal.className = "hvb-queue-total";
  setAcText(sellingTotal, "Credit: 0 p", { color: "#f0c87c" });
  sellingFooter.appendChild(sellingTotal);
  sellingPane.appendChild(sellingFooter);

  const sellingConfirmBtn = document.createElement("button");
  sellingConfirmBtn.type = "button";
  sellingConfirmBtn.className = "hvb-btn hvb-btn-confirm-sell";
  sellingConfirmBtn.dataset.slot = "top";
  sellingConfirmBtn.disabled = true;
  setAcText(sellingConfirmBtn, "Confirm", { color: "#f0d8a0" });
  sellingConfirmBtn.addEventListener("click", handleConfirmSell);
  sellingPane.appendChild(sellingConfirmBtn);

  const sellingClearBtn = document.createElement("button");
  sellingClearBtn.type = "button";
  sellingClearBtn.className = "hvb-btn hvb-btn-clear-sell";
  sellingClearBtn.dataset.slot = "bottom";
  sellingClearBtn.disabled = true;
  setAcText(sellingClearBtn, "Clear", { color: "#f0d8a0" });
  sellingClearBtn.addEventListener("click", () => {
    state.sellQueue = []; render();
  });
  sellingPane.appendChild(sellingClearBtn);

  body.appendChild(sellingPane);
  overlay.appendChild(body);
  document.body.appendChild(overlay);

  // Stash a complete element-ref bundle on the overlay so
  // applyVendorLayout() can walk them at render time. Lifetime mirrors
  // the singleton state.overlayEl.
  state.refs = {
    tabs: tabEls,
    closeBtn,
    topStrip,
    body,
    panes: { items: itemsPane, buying: buyingPane, selling: sellingPane },
    items: {
      pane:    itemsPane,
      cat:     itemsCat,
      menu:    menuBtn,
      menuPanel,
      syncMenu: syncMenuFromSelect,
      name:    itemsName,
      price:   itemsPrice,
      strip:   itemsStrip,
      rates:   itemsRates,
      buyBtn:  itemsBuyBtn,
      addBtn:  itemsAddBtn,
    },
    buying: {
      pane:       buyingPane,
      list:       buyingList,
      footer:     buyingFooter,
      name:       buyingName,
      price:      buyingPrice,
      confirmBtn: buyingConfirmBtn,
      clearBtn:   buyingClearBtn,
      totalLbl:   buyingTotalLbl,
      subLbl:     buyingSubLbl,
    },
    selling: {
      pane:       sellingPane,
      list:       sellingList,
      footer:     sellingFooter,
      name:       sellingName,
      price:      sellingPrice,
      confirmBtn: sellingConfirmBtn,
      clearBtn:   sellingClearBtn,
      totalLbl:   sellingTotalLbl,
      subLbl:     sellingSubLbl,
    },
  };

  // Drag-drop for Sell — accepts inventory drags from inventory.js.
  overlay.addEventListener("dragenter", onDragEnter);
  overlay.addEventListener("dragover", onDragOver);
  overlay.addEventListener("dragleave", onDragLeave);
  overlay.addEventListener("drop", onDrop);

  // Esc to close.
  document.addEventListener("keydown", onKeyDown);

  // Apply retail layout. vendor-ui opens on a VendorOpened server event
  // — wasm is guaranteed ready by then, so no retry loop (unlike
  // mountBar-loaded plugins). Falls through to CSS defaults if the
  // layout fetch fails.
  applyVendorLayout(state.refs);

  return overlay;
}

/**
 * Apply gmVendorUI 0x21000012 layout to every wirable element in the
 * vendor bar. Mirrors applyRadarLayout / applyInventoryLayout.
 *
 * Layout coordinates are relative to:
 *   - The overlay root for top-strip, close, tabs.
 *   - The pane root for each pane's children (the pane itself is at
 *     (0, 20) of the outer panel = (0, 0) of the body).
 *
 * Because the pane's own (0, 20) translation is baked into CSS via
 * the .hvb-body container's `top: 20px`, layout-driven children of
 * the pane land at the same screen position they would with the
 * retail panel.
 */
function applyVendorLayout(refs) {
  const apply = (layout) => {
    if (!layout) return;
    let applied = 0;
    // Top-level pairs: positioned relative to the overlay root.
    const topPairs = [
      [VENDOR_ELEMS.topStrip,   refs.topStrip],
      [VENDOR_ELEMS.closeBtn,   refs.closeBtn],
      [VENDOR_ELEMS.tabItems,   refs.tabs.items],
      [VENDOR_ELEMS.tabBuying,  refs.tabs.buying],
      [VENDOR_ELEMS.tabSelling, refs.tabs.selling],
    ];
    for (const [id, el] of topPairs) {
      if (!el) continue;
      const desc = findElementById(layout, id);
      if (!desc) continue;
      applyBox(el, desc);
      applied += 1;
    }
    // Items pane + 7 children. Pane itself anchors at (0, 20) of the
    // outer panel — but we host the panes inside .hvb-body which is
    // already at (0, 20). So we DON'T re-apply pane x/y/w/h —
    // applyBox would clobber the CSS that pins the pane at (0,0)
    // inside .hvb-body. Layout x/y on pane children is taken at face
    // value (relative to the pane), which matches our absolute-
    // positioned children.
    const itemsPairs = [
      [VENDOR_ELEMS.itemsCat,    refs.items.cat],
      [VENDOR_ELEMS.itemsName,   refs.items.name],
      [VENDOR_ELEMS.itemsPrice,  refs.items.price],
      [VENDOR_ELEMS.itemsStrip,  refs.items.strip],
      [VENDOR_ELEMS.itemsRates,  refs.items.rates],
      [VENDOR_ELEMS.itemsBuyBtn, refs.items.buyBtn],
      [VENDOR_ELEMS.itemsAddBtn, refs.items.addBtn],
    ];
    for (const [id, el] of itemsPairs) {
      if (!el) continue;
      const desc = findElementById(layout, id);
      if (!desc) continue;
      applyBox(el, desc);
      applied += 1;
      // P3-45 — keep the menu button (UIElement_Menu port) in sync with
      // the hidden <select>'s layout position so the brass dropdown
      // tracks any retail layout overrides.
      if (id === VENDOR_ELEMS.itemsCat && refs.items.menu) {
        applyBox(refs.items.menu, desc);
        if (refs.items.menuPanel) {
          if (typeof desc.x === "number") refs.items.menuPanel.style.left = `${desc.x}px`;
          if (typeof desc.y === "number" && typeof desc.height === "number") {
            refs.items.menuPanel.style.top = `${desc.y + desc.height}px`;
          }
          if (typeof desc.width === "number") refs.items.menuPanel.style.width = `${desc.width}px`;
        }
      }
    }
    // Buying pane children.
    const buyingPairs = [
      [VENDOR_ELEMS.buyingList,        refs.buying.list],
      [VENDOR_ELEMS.buyingFooter,      refs.buying.footer],
      [VENDOR_ELEMS.buyingName,        refs.buying.name],
      [VENDOR_ELEMS.buyingPrice,       refs.buying.price],
      [VENDOR_ELEMS.buyingConfirmBtn,  refs.buying.confirmBtn],
      [VENDOR_ELEMS.buyingClearBtn,    refs.buying.clearBtn],
      [VENDOR_ELEMS.buyingTotalLbl,    refs.buying.totalLbl],
      [VENDOR_ELEMS.buyingSubLbl,      refs.buying.subLbl],
    ];
    for (const [id, el] of buyingPairs) {
      if (!el) continue;
      const desc = findElementById(layout, id);
      if (!desc) continue;
      applyBox(el, desc);
      applied += 1;
    }
    // Selling pane children.
    const sellingPairs = [
      [VENDOR_ELEMS.sellingList,        refs.selling.list],
      [VENDOR_ELEMS.sellingFooter,      refs.selling.footer],
      [VENDOR_ELEMS.sellingName,        refs.selling.name],
      [VENDOR_ELEMS.sellingPrice,       refs.selling.price],
      [VENDOR_ELEMS.sellingConfirmBtn,  refs.selling.confirmBtn],
      [VENDOR_ELEMS.sellingClearBtn,    refs.selling.clearBtn],
      [VENDOR_ELEMS.sellingTotalLbl,    refs.selling.totalLbl],
      [VENDOR_ELEMS.sellingSubLbl,      refs.selling.subLbl],
    ];
    for (const [id, el] of sellingPairs) {
      if (!el) continue;
      const desc = findElementById(layout, id);
      if (!desc) continue;
      applyBox(el, desc);
      applied += 1;
    }
    try {
      window.__diag?.layout?.onVendorApplied?.({ applied });
    } catch (_) {}
  };
  const cached = getCachedLayout(VENDOR_LAYOUT_ID);
  if (cached) { apply(cached); return; }
  loadLayout(VENDOR_LAYOUT_ID).then(apply).catch(() => {});
}

// Apply a LayoutDesc Element's geometry to a DOM element. Clears
// CSS `right`/`bottom` anchors so explicit left/top wins, and uses
// `transform: none` to defeat any centering translates in the
// underlying CSS rule. box-sizing on the target element is set to
// border-box upstream so the layout's width/height land cleanly.
function applyBox(el, layoutEl) {
  el.style.right = "";
  el.style.bottom = "";
  // Defeat any CSS-rule transforms that would offset the element.
  el.style.transform = "none";
  if (typeof layoutEl.x === "number") el.style.left = `${layoutEl.x}px`;
  if (typeof layoutEl.y === "number") el.style.top = `${layoutEl.y}px`;
  if (typeof layoutEl.width === "number") el.style.width = `${layoutEl.width}px`;
  if (typeof layoutEl.height === "number") el.style.height = `${layoutEl.height}px`;
}

function onKeyDown(ev) {
  if (state.overlayEl?.dataset.open !== "1") return;
  const binding = resolveLocalBinding(LOCAL_ACTION_IDS.CLOSE, "Escape");
  if (matchesBinding(ev, binding)) hideOverlay();
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

  // Tabs — Items always shows just "Items"; Buying / Selling show the
  // vendor name on first tab (so the user can identify the vendor) +
  // queue count on the others. The retail panel has no separate title
  // bar — vendor identity sits inside the active tab + selected-name
  // field, which we mirror here.
  for (const id of ["items", "buying", "selling"]) {
    const b = state.refs.tabs[id];
    if (!b) continue;
    let label;
    if (id === "items") {
      label = vs.vendorName ? `Items — ${vs.vendorName}` : "Items";
    } else if (id === "buying") {
      label = state.buyQueue.length ? `Buying (${state.buyQueue.length})` : "Buying";
    } else {
      label = state.sellQueue.length ? `Selling (${state.sellQueue.length})` : "Selling";
    }
    setAcText(b, label, {
      color: id === state.currentTab ? "#f0c87c" : "#f0d8a0",
      fontId: id === "items" && id === state.currentTab ? HEADING_FONT_ID : undefined,
    });
    b.classList.toggle("active", id === state.currentTab);
  }

  // Show only the active pane. Buttons live inside their owning pane,
  // so pane visibility hides/shows their action buttons too.
  for (const id of ["items", "buying", "selling"]) {
    const pane = state.refs.panes[id];
    if (pane) pane.classList.toggle("active", id === state.currentTab);
  }

  if (state.currentTab === "items") renderItemsPane();
  else if (state.currentTab === "buying") renderQueuePane("buying");
  else if (state.currentTab === "selling") renderQueuePane("selling");
}

function renderItemsPane() {
  const refs = state.refs.items;
  const vs = state.vendorState;
  const cat = CATEGORY_TABLE.find((c) => c.id === state.categoryFilter) ?? CATEGORY_TABLE[0];
  const items = vs.items.filter((it) => state.categoryFilter === "all" || (it.itemType & cat.mask));

  // Selected item header (within items pane).
  const sel = items.find((i) => i.itemGuid === state.selectedItemGuid);
  const myPyreals = countPyreals();
  if (sel) {
    // Wave F.4 (2026-05-27): prefer the wasm-precomputed `buyPrice`
    // (retail ShopSystem::BuyPrice — includes promissory-note
    // special-case + +0.1 floor offset). Falls back to the legacy
    // value*multiplier calc when the F.4 export isn't available.
    const price = (typeof sel.buyPrice === "number" && sel.buyPrice >= 0)
      ? sel.buyPrice
      : shopBuyPrice(
          sel.value || 0,
          sel.itemType || 0,
          vs.buyMultiplier || 1,
          1,
        );
    setAcText(refs.name, sel.name || `wcid ${sel.wcid}`, { color: "#f0c87c" });
    setAcText(refs.price, `costs ${fmtPrice(price)} p (you have ${fmtPrice(myPyreals)} p)`, { color: "#f0e8d0" });
  } else {
    setAcText(refs.name, items.length ? "— select an item —" : "(no items in this category)", { color: "#f0c87c" });
    setAcText(refs.price, `(you have ${fmtPrice(myPyreals)} p)`, { color: "#f0e8d0" });
  }

  // Icon strip
  refs.strip.innerHTML = "";
  for (const it of items) {
    const cell = document.createElement("div");
    cell.className = "hvb-icon-cell";
    cell.dataset.itemGuid = String(it.itemGuid);
    if (it.itemGuid === state.selectedItemGuid) cell.classList.add("selected");
    setItemIcon(cell, it);
    if ((it.stackSize || 1) > 1) {
      const badge = document.createElement("div");
      badge.className = "hvb-stack-badge";
      setAcText(badge, String(it.stackSize), { color: "#f0e8d0" });
      cell.appendChild(badge);
    }
    // Wave F.4: prefer pre-computed retail buyPrice over the
    // value*multiplier estimate (which doesn't account for the
    // promissory-note special-case or +0.1 floor adjust).
    const tipPrice = (typeof it.buyPrice === "number" && it.buyPrice >= 0)
      ? it.buyPrice
      : shopBuyPrice(it.value || 0, it.itemType || 0, vs.buyMultiplier || 1, 1);
    cell.title = `${it.name} — ${fmtPrice(tipPrice)}p`;
    cell.addEventListener("click", () => {
      state.selectedItemGuid = it.itemGuid;
      render();
    });
    cell.addEventListener("dblclick", () => {
      state.selectedItemGuid = it.itemGuid;
      handleBuyInstant();
    });
    refs.strip.appendChild(cell);
  }

  // Rates strip — Wave F.4 (2026-05-27): surface the typed-profile
  // acceptance hints when available (deals-magic flag + min/max
  // value caps + categorized accept list). The categories list mirrors
  // what `VendorItemsUI::AddTypeFilter` does in retail
  // (acclient.c:4597) for the dropdown but here in flat text.
  let extras = "";
  if (Array.isArray(vs.buyAcceptCategoryNames) && vs.buyAcceptCategoryNames.length) {
    // Show the typed categories the vendor will BUY back from you.
    // Limited to first 3 so the rates strip doesn't overflow.
    const top = vs.buyAcceptCategoryNames.slice(0, 3).join("/").toLowerCase();
    const more = vs.buyAcceptCategoryNames.length > 3 ? "…" : "";
    extras += ` · Accepts: ${top}${more}`;
  }
  if (vs.dealsMagic === false) extras += " · No magic";
  if (vs.hasNoMax === false && Number.isFinite(vs.maxValue)) {
    extras += ` · Cap ${fmtPrice(vs.maxValue)} p`;
  }
  refs.rates.innerHTML =
    `Sells <b>${Math.round((vs.buyMultiplier || 1) * 100)}%</b> · ` +
    `Buys <b>${Math.round((vs.sellMultiplier || 1) * 100)}%</b>${extras}`;

  // Enable Buy / Add buttons only when something is selected.
  refs.buyBtn.disabled = !sel;
  refs.addBtn.disabled = !sel;
}

function renderQueuePane(which) {
  const refs = state.refs[which];
  const vs = state.vendorState;
  const queue = which === "buying" ? state.buyQueue : state.sellQueue;
  const mult = which === "buying" ? (vs.buyMultiplier || 1) : (vs.sellMultiplier || 1);

  refs.list.innerHTML = "";
  if (queue.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hvb-queue-empty";
    setAcText(empty, which === "buying"
      ? "Empty. Click an item in the Items tab + \"Add to List\"."
      : "Empty. Drag inventory items onto this panel.", { color: "#807868" });
    refs.list.appendChild(empty);
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
    setAcText(nameEl, q.name, { color: "#f0e8d0" });
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
    setAcText(priceEl, `${fmtPrice(lineTotal)} p`, { color: "#f0c87c" });
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
    refs.list.appendChild(row);
  }

  // Update the queue-footer "Cost: …" / "Credit: …" total label.
  const totalEl = refs.footer.querySelector(".hvb-queue-total");
  const label = which === "buying" ? "Cost" : "Credit";
  setAcText(totalEl, `${label}: ${fmtPrice(total)} p`, { color: "#f0c87c" });
  // Mirror the running total into the per-pane selected-price field
  // so it lines up with the layout-driven 590×15 slot at (125,15).
  setAcText(refs.price, `${vs.vendorName || "Vendor"} — ${label.toLowerCase()} ${fmtPrice(total)} p`, { color: "#f0e8d0" });
  setAcText(refs.name, queue.length
    ? `${queue.length} item${queue.length === 1 ? "" : "s"} on the list`
    : (which === "buying" ? "Buying list" : "Selling list"),
    { color: "#f0c87c" });

  refs.confirmBtn.disabled = queue.length === 0;
  refs.clearBtn.disabled = queue.length === 0;
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
  // Wave F.4 (2026-05-27): typed VendorProfile consumption + retail
  // buy/sell-price formula port. Adds categorized accept-list display,
  // deal-magic flag surfacing, and per-stock-entry buyPrice using
  // ShopSystem::BuyPrice (acclient.c:719870).
  version: "0.5.0",
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

    const pullProfile = (vendorGuid) => {
      // Wave F.4 (2026-05-27): pair with getCurrentVendorProfile for the
      // typed-profile fields (buyAcceptCategories, dealsMagic, min/max,
      // pre-computed buyPrice per stock entry). Falls back gracefully
      // when the export isn't present (older wasm build).
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
      if (!state.vendorState?.vendorGuid) return;
      try {
        const vendorGuid = state.vendorState.vendorGuid >>> 0;
        const raw = handle.getVendorState(vendorGuid);
        if (raw) {
          state.vendorState = enrichWithProfile(
            snapshotFromWasm(raw),
            pullProfile(vendorGuid),
          );
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

  function openWith(rawState, profilePayload = null) {
    state.vendorState = enrichWithProfile(
      snapshotFromWasm(rawState),
      profilePayload,
    );
    // Reset transient UI state on (re)open of a vendor.
    state.currentTab = "items";
    state.selectedItemGuid = null;
    state.categoryFilter = "all";
    // Preserve buy/sell queues across re-fires of the SAME vendor —
    // ACE refreshes kind=12 after every buy. Drop the queues only
    // when switching vendors.
    showOverlay();
    if (state.refs?.items?.cat) {
      state.refs.items.cat.value = "all";
      try { state.refs.items.syncMenu?.(); } catch (_) {}
    }
    render();
  }

  // P3-41 — replace 500ms client-discovery poll with one-shot await on
  // the global pluginClient bootstrap promise installed by index.html.
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
    document.removeEventListener("keydown", onKeyDown);
    if (state.overlayEl) {
      state.overlayEl.remove();
      state.overlayEl = null;
    }
  };
}

// Debug helpers: pop a synthetic vendor from DevTools / e2e verifier.
//   __vendorBarDebug()  — legacy, fake "Lin the Trader" w/ a handful of stock
//   __vendorPluginDebug — namespaced API for e2e verifier (open / close /
//     switchTab / refs). Also exposed inside mount() for parity once the
//     poll-hook completes; this module-scope copy lets the verifier
//     drive the plugin even when wasm/__sessionHandle isn't wired.
if (typeof window !== "undefined") {
  const DEBUG_SNAPSHOT = {
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
  const openDebug = (snapshot) => {
    ensureStyles();
    state.vendorState = snapshot || DEBUG_SNAPSHOT;
    state.currentTab = "items";
    state.selectedItemGuid = null;
    state.buyQueue = [];
    state.sellQueue = [];
    state.categoryFilter = "all";
    showOverlay();
    if (state.refs?.items?.cat) {
      state.refs.items.cat.value = "all";
      try { state.refs.items.syncMenu?.(); } catch (_) {}
    }
    render();
  };
  window.__vendorBarDebug = () => openDebug();
  window.__vendorPluginDebug = {
    open: openDebug,
    close: () => hideOverlay(),
    switchTab: (id) => { state.currentTab = id; render(); },
    refs: () => state.refs,
  };
}
