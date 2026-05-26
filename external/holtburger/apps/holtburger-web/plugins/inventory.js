// Right-side inventory window — port of retail gmInventoryUI (layout
// 0x21000023, 300x362) + gmPaperDollUI (layout 0x21000024, 224x214).
//
// Strategy mirrors the chat panel (PR-L): index.html already has full
// inventory wiring — `#inventory-panel` + `#inv-equipped` + `#inv-pack`
// (line 691-711), `renderInventoryPanel(handle)` (line 6192) re-reads
// SessionHandle.playerInventory() on every kind=11 InventoryUpdated
// ClientEvent and rebuilds the rows with `data-guid`, `data-type-bit`,
// `draggable`. We mirror those rows into a retail-framed panel via
// MutationObserver — no duplicated wasm/inventory code.
//
// Real DAT sprites in use (extracted 2026-05-22 from layout 0x21000023):
//   - 0x06004D0A : 300x362-ish stone/leather backdrop (the panel interior!)
//   - 0x06004CFA : brass title bar strip (276x25)
//   - 0x06004D0B/0C/0D : corner + chrome pieces
//   - 0x06004CC2 : 48x48 placeholder spacer
//
// Layout: 300 wide x 362 tall.
//   - Top 25px: title bar with character name + close button.
//   - Left 224x214 (below title): paperdoll area for equipped items.
//   - Right 60x ~340: narrow bag column (placeholder tabs for now).
//   - Lower 234x ~120: items grid for pack items (32x32 slots).
//   - Bottom 120x14: burden meter (placeholder until equipMask wiring).

import { setAcText } from "../ui/ac_font.js";
import { loadLayout, findElementById, parseElementIdHex, getCachedLayout } from "../ui/ac_layout.js";

/** Retail LayoutDescs covering the inventory window.
 *
 *  - `gmInventoryUI` (0x21000023, 300×362) — outer-window children
 *    laying out the paperdoll area, bag column, items grid, title,
 *    and close button. Top-level element 0x100001CC.
 *  - `gmPaperDollUI` (0x21000024, 224×214) — body-slot positions
 *    plus the burden bar (0x100005BE at (42, 190) inside the panel).
 *
 *  Per ElementDesc.element_id mapping (cross-checked against
 *  paperdoll_layout_dump output + retail-anatomy validation):
 */
const INVENTORY_LAYOUT_ID = 0x21000023;
const PAPERDOLL_LAYOUT_ID = 0x21000024;
const INV_ELEM_PAPERDOLL_AREA = 0x100001CD;
const INV_ELEM_BAG_COLUMN    = 0x100001CE;
const INV_ELEM_ITEMS_GRID    = 0x100001CF;
const PAPERDOLL_ELEM_BURDEN  = 0x100005BE;


const OVERLAY_ID = "hb-inventory";
// Title bar is now owned by main-panel (see plugins/main-panel.js).
// All vertical offsets in the inventory CSS use TITLE_H = 0 since
// the view mounts inside main-panel's body slot.
const TITLE_H = 0;
const PAPERDOLL_W = 224;
const PAPERDOLL_H = 214;
const BAG_COL_W = 60;
const SLOT_SIZE = 32;
const GRID_COLS = 7;

// Item-type-bit → color (mirrors index.html's #inventory-panel cat
// CSS but adapted for our dark backdrop).
const TYPE_COLOR = {
  "0x4":     "#7da6e0",   // Weapon
  "0x2":     "#7dd9a0",   // Armor
  "0x10000": "#c060ff",   // Magic / scroll
  "0x20":    "#f0c060",   // Money / pyreal
};

// Paperdoll equipment slot table — element IDs + equipMask bits from
// gmPaperDollUI::GetLocationInfoFromElementID at acclient.c:219835.
// Y coords come from the gmPaperDollUI-0x21000024 LayoutDesc JSON;
// X coords are hand-tuned to approximate retail body anatomy in the
// 224x214 paperdoll area (no X data is set in the LayoutDesc — retail
// computes it via parent flow at runtime).
//
// Side values: 0 = both/center, 1 = right-arm, 2 = left-arm.
// Equipped items render in the slot whose equipMask bit matches
// `item.equipMask & slot.equipMask`.
const PAPERDOLL_SLOTS = [
  // Head row
  { elemId: "0x100005AB", equipMask: 0x00000001, x: 96,  y: 8,   name: "Head" },
  { elemId: "0x100001DA", equipMask: 0x00008000, x: 96,  y: 44,  name: "Necklace" },
  { elemId: "0x100001E1", equipMask: 0x00200000, x: 64,  y: 28,  name: "Earring (L)" },
  // Shoulders / upper torso
  { elemId: "0x100005AE", equipMask: 0x00000800, x: 32,  y: 64,  name: "Upper arm (L)" },
  { elemId: "0x100005AC", equipMask: 0x00000200, x: 96,  y: 64,  name: "Chest armor" },
  { elemId: "0x100001E2", equipMask: 0x00000002, x: 64,  y: 64,  name: "Chest under" },
  { elemId: "0x10000596", equipMask: 0x20000000, x: 160, y: 64,  name: "Right hand" },
  { elemId: "0x100005E9", equipMask: 0x08000000, x: 192, y: 64,  name: "Wand/staff" },
  // Mid torso
  { elemId: "0x100005AF", equipMask: 0x00001000, x: 32,  y: 100, name: "Lower arm (L)" },
  { elemId: "0x100005AD", equipMask: 0x00000400, x: 96,  y: 100, name: "Abdomen" },
  { elemId: "0x10000595", equipMask: 0x10000000, x: 160, y: 100, name: "Shield" },
  { elemId: "0x1000050E", equipMask: 0x04000000, x: 192, y: 100, name: "Aetheria" },
  // Hands / waist row
  { elemId: "0x100001DB", equipMask: 0x00010000, x: 32,  y: 116, name: "Ring (R)" },
  { elemId: "0x100005B0", equipMask: 0x00000020, x: 64,  y: 116, name: "Gloves" },
  { elemId: "0x100001DD", equipMask: 0x00020000, x: 160, y: 116, name: "Ring (L)" },
  { elemId: "0x10000597", equipMask: 0x40000000, x: 192, y: 116, name: "Missile" },
  // Legs
  { elemId: "0x100005B1", equipMask: 0x00002000, x: 64,  y: 136, name: "Upper leg" },
  { elemId: "0x100001E3", equipMask: 0x00000040, x: 96,  y: 136, name: "Underpants" },
  { elemId: "0x100005B2", equipMask: 0x00004000, x: 128, y: 136, name: "Lower leg" },
  { elemId: "0x100001DC", equipMask: 0x00040000, x: 32,  y: 152, name: "Bracelet (R)" },
  { elemId: "0x100001DE", equipMask: 0x00080000, x: 160, y: 152, name: "Bracelet (L)" },
  // Feet
  { elemId: "0x100005B3", equipMask: 0x00000100, x: 96,  y: 172, name: "Boots" },
];

const iconCache = new Map();
async function fetchPaperdollIconDataUrl(iconId) {
  if (!iconId) return null;
  const cached = iconCache.get(iconId);
  if (cached !== undefined) {
    if (cached instanceof Promise) return cached;
    return cached;
  }
  const wasm = window.__hbWasm ?? window.__wasm ?? null;
  if (!wasm?.fetch_surface_pixels) {
    iconCache.set(iconId, null);
    return null;
  }
  const p = (async () => {
    try {
      const r = await wasm.fetch_surface_pixels(iconId >>> 0);
      if (!r || !r.width || !r.height || !r.pixels?.length) return null;
      const canvas = document.createElement("canvas");
      canvas.width = r.width; canvas.height = r.height;
      const cx = canvas.getContext("2d");
      const img = cx.createImageData(r.width, r.height);
      img.data.set(r.pixels);
      cx.putImageData(img, 0, 0);
      return canvas.toDataURL("image/png");
    } catch (e) {
      console.warn(`[inventory] paperdoll icon ${iconId} fetch failed:`, e);
      return null;
    }
  })();
  iconCache.set(iconId, p);
  const url = await p;
  iconCache.set(iconId, url);
  return url;
}

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-inventory-style";
  style.textContent = `
    /* Inventory view — mounts inside main-panel's body slot. The
       main-panel owns position/frame/title; we just lay out our
       content (paperdoll + bag column + items / examine swap +
       burden meter) inside the provided bodyEl. */
    #${OVERLAY_ID} {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      box-sizing: border-box;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      background: url("./data/ui-sprites/0x06004D0A.png") center/cover no-repeat;
      color: var(--hb-text-cream);
    }
    /* Title bar — real DAT 0x06004CFA brass strip. */
    #${OVERLAY_ID} .hb-inv-title {
      position: absolute;
      top: 0; left: 0; right: 0;
      height: ${TITLE_H}px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 8px;
      background: url("./data/ui-sprites/0x06004CFA.png") center/100% 100% no-repeat;
      font-size: 11px;
      color: var(--hb-text-cream-bright);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.9);
      pointer-events: auto;
      user-select: none;
    }
    #${OVERLAY_ID} .hb-inv-title-name { letter-spacing: 0.04em; }
    #${OVERLAY_ID} .hb-inv-close {
      width: 14px;
      height: 14px;
      background: var(--hb-border-brass);
      color: var(--hb-bg-stone-bottom);
      font-size: 9px;
      line-height: 14px;
      text-align: center;
      cursor: pointer;
      user-select: none;
    }
    #${OVERLAY_ID} .hb-inv-close:hover { background: var(--hb-text-gold); }
    /* Paperdoll area — equipped items positioned at body-slot positions. */
    #${OVERLAY_ID} .hb-inv-paperdoll {
      position: absolute;
      top: ${TITLE_H + 4}px;
      left: 6px;
      width: ${PAPERDOLL_W}px;
      height: ${PAPERDOLL_H}px;
      pointer-events: auto;
    }
    #${OVERLAY_ID} .hb-inv-paperdoll-bg {
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      background:
        radial-gradient(ellipse at center, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.8) 100%);
      border: 1px solid var(--hb-border-brass-dim);
    }
    /* Each paperdoll body-slot — 28x28 brass-trim square positioned at
       the (x, y) from the PAPERDOLL_SLOTS table. Smaller than 32 to
       fit more slots in the 224x214 anatomy box. */
    #${OVERLAY_ID} .hb-inv-doll-slot {
      position: absolute;
      width: 28px;
      height: 28px;
      background: url("./sprites/acsprites/icon-slot-bg.png") center/100% 100% no-repeat;
      image-rendering: pixelated;
      cursor: pointer;
      transition: filter 120ms ease;
      opacity: 0.6;
    }
    #${OVERLAY_ID} .hb-inv-doll-slot:hover { opacity: 1; filter: brightness(1.3); }
    #${OVERLAY_ID} .hb-inv-doll-slot.equipped {
      opacity: 1;
      filter: drop-shadow(0 0 3px var(--hb-text-gold));
    }
    #${OVERLAY_ID} .hb-inv-doll-slot.drag-target {
      filter: drop-shadow(0 0 4px rgba(120, 220, 120, 0.9));
    }
    #${OVERLAY_ID} .hb-inv-doll-icon {
      position: absolute;
      top: 4px; left: 4px;
      width: 20px;
      height: 20px;
      border: 1px solid rgba(255, 255, 255, 0.3);
      pointer-events: none;
    }
    #${OVERLAY_ID} .hb-inv-doll-tip {
      position: absolute;
      top: calc(100% + 3px);
      left: 50%;
      transform: translateX(-50%);
      padding: 2px 5px;
      font-size: 9px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      background: rgba(10, 8, 4, 0.96);
      border: 1px solid var(--hb-border-brass);
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transition: opacity 120ms ease;
      z-index: 70;
    }
    #${OVERLAY_ID} .hb-inv-doll-slot:hover .hb-inv-doll-tip { opacity: 1; }
    /* Bag column — narrow vertical strip on the right. */
    #${OVERLAY_ID} .hb-inv-bagcol {
      position: absolute;
      top: ${TITLE_H + 4}px;
      right: 6px;
      width: ${BAG_COL_W}px;
      height: ${PAPERDOLL_H}px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 4px;
      pointer-events: auto;
      border: 1px solid var(--hb-border-brass-dim);
      background: rgba(0, 0, 0, 0.35);
    }
    #${OVERLAY_ID} .hb-inv-bagtab {
      width: ${SLOT_SIZE - 4}px;
      height: ${SLOT_SIZE - 4}px;
      background: url("./sprites/acsprites/icon-slot-bg.png") center/100% 100% no-repeat;
      cursor: pointer;
      image-rendering: pixelated;
      opacity: 0.65;
    }
    #${OVERLAY_ID} .hb-inv-bagtab:hover { opacity: 1; }
    #${OVERLAY_ID} .hb-inv-bagtab.selected { opacity: 1; filter: drop-shadow(0 0 3px var(--hb-text-gold)); }
    /* Burden meter under paperdoll. */
    #${OVERLAY_ID} .hb-inv-burden {
      position: absolute;
      top: ${TITLE_H + PAPERDOLL_H + 6}px;
      left: 6px;
      width: ${PAPERDOLL_W}px;
      height: 14px;
      display: flex;
      align-items: center;
      gap: 4px;
      pointer-events: auto;
    }
    #${OVERLAY_ID} .hb-inv-burden-label {
      font-size: 9px;
      color: var(--hb-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    #${OVERLAY_ID} .hb-inv-burden-bar {
      flex: 1;
      height: 8px;
      background: rgba(0, 0, 0, 0.7);
      border: 1px solid var(--hb-border-brass-dim);
      overflow: hidden;
    }
    #${OVERLAY_ID} .hb-inv-burden-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #6abc6a 0%, #d4b330 60%, #c83838 95%);
      transition: width 200ms linear;
    }
    /* Items grid — pack contents below the paperdoll. */
    #${OVERLAY_ID} .hb-inv-items {
      position: absolute;
      top: ${TITLE_H + PAPERDOLL_H + 28}px;
      left: 6px;
      right: 6px;
      bottom: 6px;
      overflow-y: auto;
      pointer-events: auto;
      padding: 4px;
      display: grid;
      grid-template-columns: repeat(${GRID_COLS}, ${SLOT_SIZE}px);
      gap: 2px;
      align-content: start;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--hb-border-brass-dim);
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.5);
    }
    #${OVERLAY_ID} .hb-inv-slot {
      position: relative;
      width: ${SLOT_SIZE}px;
      height: ${SLOT_SIZE}px;
      background: url("./sprites/acsprites/icon-slot-bg.png") center/100% 100% no-repeat;
      image-rendering: pixelated;
      cursor: pointer;
      transition: filter 120ms ease;
    }
    #${OVERLAY_ID} .hb-inv-slot:hover { filter: brightness(1.25); }
    #${OVERLAY_ID} .hb-inv-slot.selected {
      filter: drop-shadow(0 0 4px var(--hb-text-gold)) brightness(1.2);
    }
    /* Item icon — colored square keyed by type-bit until we wire
       fetch_surface_pixels for the real icon DID. */
    #${OVERLAY_ID} .hb-inv-icon {
      position: absolute;
      top: 6px; left: 6px;
      width: ${SLOT_SIZE - 12}px;
      height: ${SLOT_SIZE - 12}px;
      border: 1px solid rgba(255, 255, 255, 0.25);
    }
    #${OVERLAY_ID} .hb-inv-stack {
      position: absolute;
      bottom: 1px;
      right: 2px;
      font-size: 8px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.95);
      line-height: 1;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hb-inv-tip {
      position: absolute;
      bottom: calc(100% + 4px);
      left: 50%;
      transform: translateX(-50%);
      padding: 2px 6px;
      font-size: 10px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      background: rgba(10, 8, 4, 0.96);
      border: 1px solid var(--hb-border-brass);
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transition: opacity 120ms ease;
      z-index: 60;
    }
    #${OVERLAY_ID} .hb-inv-slot:hover .hb-inv-tip { opacity: 1; }
    /* In-place examine view — overlays the items grid when an inventory
       item is selected (retail's gm3DItemsUI swap behaviour, see
       docs/examine-architecture-2026-05-22.md). Hidden by default;
       toggled via data-view="examine" on the parent #hb-inventory. */
    #${OVERLAY_ID}[data-view="examine"] .hb-inv-items { display: none; }
    #${OVERLAY_ID} .hb-inv-examine {
      position: absolute;
      top: ${TITLE_H + PAPERDOLL_H + 28}px;
      left: 6px;
      right: 6px;
      bottom: 6px;
      pointer-events: auto;
      padding: 6px;
      display: none;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid var(--hb-border-brass-dim);
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.5);
    }
    #${OVERLAY_ID}[data-view="examine"] .hb-inv-examine { display: block; }
    #${OVERLAY_ID} .hb-inv-examine-head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    #${OVERLAY_ID} .hb-inv-examine-icon {
      width: 48px;
      height: 48px;
      background: url("./sprites/acsprites/icon-slot-bg.png") center/100% 100% no-repeat;
      image-rendering: pixelated;
      position: relative;
    }
    #${OVERLAY_ID} .hb-inv-examine-icon-fill {
      position: absolute;
      top: 8px; left: 8px;
      width: 32px; height: 32px;
      border: 1px solid rgba(255, 255, 255, 0.3);
    }
    #${OVERLAY_ID} .hb-inv-examine-namecol {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    #${OVERLAY_ID} .hb-inv-examine-name {
      font-size: 12px;
      color: var(--hb-text-gold);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.9);
      letter-spacing: 0.02em;
    }
    #${OVERLAY_ID} .hb-inv-examine-guid {
      font-size: 9px;
      font-family: var(--hb-font-mono);
      color: var(--hb-text-muted);
    }
    #${OVERLAY_ID} .hb-inv-examine-back {
      padding: 2px 6px;
      font-size: 9px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid var(--hb-border-brass);
      cursor: pointer;
      user-select: none;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    #${OVERLAY_ID} .hb-inv-examine-back:hover {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
    #${OVERLAY_ID} .hb-inv-examine-body {
      margin-top: 4px;
    }
    #${OVERLAY_ID} .hb-inv-examine-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 2px 4px;
      font-size: 10px;
      line-height: 14px;
      border-bottom: 1px solid rgba(138, 117, 68, 0.18);
    }
    #${OVERLAY_ID} .hb-inv-examine-row:last-child { border-bottom: none; }
    #${OVERLAY_ID} .hb-inv-examine-label {
      color: var(--hb-text-cream);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-size: 9px;
    }
    #${OVERLAY_ID} .hb-inv-examine-value {
      color: var(--hb-text-gold);
      text-align: right;
    }
  `;
  document.head.appendChild(style);
}

export const manifest = {
  id: "inventory",
  name: "Inventory",
  icon: "🎒",
  iconHidden: true,
  version: "0.1.0",
  description: "Right-side inventory window (gmInventoryUI 0x21000023)",
};

// Apply retail layout to the inventory window — body slot positions
// from gmPaperDollUI + outer-window region positions from
// gmInventoryUI. Refs:
//   - paperdollEl  → top-level paperdoll panel container
//   - bagcolEl     → narrow right-side bag-tab column
//   - burdenEl     → burden meter (encumbrance bar)
//   - itemsEl      → grid of pack-content slots below the paperdoll
//   - dollSlotEls  → map of equipMask → { el, slot } for body slots
//
// Retail anatomy (from inventory_layouts_dump 2026-05-24):
//   - Paperdoll area at (0, 23) inside the 300×362 window
//   - Bag column at (239, 23), 61×339 — extends past paperdoll
//   - Items grid at (0, 237), 234×120 — directly below paperdoll
//   - Burden bar at (42, 190) INSIDE the paperdoll panel (224×214),
//     anchored to the bottom via right_edge=2, bottom_edge=1. Width
//     is 120, height 14.
//
// Both layouts cache after the first call; re-mounts re-apply
// synchronously. Falls through silently if either layout fails to
// load — the hand-tuned defaults in CSS stay in effect.
function applyInventoryLayout(refs) {
  const apply = ([inv, doll]) => {
    let appliedRegions = 0;
    let slotUpdates = { updated: 0, missed: 0 };
    // Paperdoll-panel origin in overlay coords. Used to anchor the
    // burden bar (retail places it inside the paperdoll at (42, 190)
    // but our DOM keeps the burden as a sibling of paperdoll). CSS
    // default (6, 4) is the fallback when gmInventoryUI doesn't load.
    let paperdollOrigin = { x: 6, y: 4 };

    if (inv) {
      const paperdollArea = findElementById(inv, INV_ELEM_PAPERDOLL_AREA);
      const bagcol = findElementById(inv, INV_ELEM_BAG_COLUMN);
      const itemsGrid = findElementById(inv, INV_ELEM_ITEMS_GRID);

      if (paperdollArea && refs.paperdollEl) {
        applyBox(refs.paperdollEl, paperdollArea);
        if (typeof paperdollArea.x === "number") paperdollOrigin.x = paperdollArea.x;
        if (typeof paperdollArea.y === "number") paperdollOrigin.y = paperdollArea.y;
        appliedRegions += 1;
      }
      if (bagcol && refs.bagcolEl) {
        // CSS uses `right: 6px` to anchor; clear so explicit left wins.
        refs.bagcolEl.style.right = "";
        applyBox(refs.bagcolEl, bagcol);
        appliedRegions += 1;
      }
      if (itemsGrid && refs.itemsEl) {
        refs.itemsEl.style.right = "";
        refs.itemsEl.style.bottom = "";
        applyBox(refs.itemsEl, itemsGrid);
        appliedRegions += 1;
      }
    }

    if (doll) {
      // Body slots — uses the same map findElementById walks.
      slotUpdates = applySlotPositions(doll, refs.dollSlotEls);

      // Burden bar at (42, 190) inside the paperdoll panel — translate
      // to overlay coords using the just-applied (or CSS-default)
      // paperdoll origin.
      const burden = findElementById(doll, PAPERDOLL_ELEM_BURDEN);
      if (burden && refs.burdenEl) {
        if (typeof burden.x === "number") refs.burdenEl.style.left = `${paperdollOrigin.x + burden.x}px`;
        if (typeof burden.y === "number") refs.burdenEl.style.top = `${paperdollOrigin.y + burden.y}px`;
        if (typeof burden.width === "number") refs.burdenEl.style.width = `${burden.width}px`;
        if (typeof burden.height === "number") refs.burdenEl.style.height = `${burden.height}px`;
        appliedRegions += 1;
      }
    }

    try {
      window.__diag?.layout?.onInventoryApplied?.({
        appliedRegions, slotUpdates,
        invLoaded: !!inv, dollLoaded: !!doll,
      });
    } catch (_) {}
  };

  const cachedInv = getCachedLayout(INVENTORY_LAYOUT_ID);
  const cachedDoll = getCachedLayout(PAPERDOLL_LAYOUT_ID);
  if (cachedInv && cachedDoll) { apply([cachedInv, cachedDoll]); return; }
  Promise.all([
    loadLayout(INVENTORY_LAYOUT_ID),
    loadLayout(PAPERDOLL_LAYOUT_ID),
  ]).then(apply).catch(() => {});
}

function applyBox(el, layoutEl) {
  if (typeof layoutEl.x === "number") el.style.left = `${layoutEl.x}px`;
  if (typeof layoutEl.y === "number") el.style.top = `${layoutEl.y}px`;
  if (typeof layoutEl.width === "number") el.style.width = `${layoutEl.width}px`;
  if (typeof layoutEl.height === "number") el.style.height = `${layoutEl.height}px`;
}

function applySlotPositions(layout, dollSlotEls) {
  let updated = 0, missed = 0;
  for (const slot of Object.values(dollSlotEls)) {
    const id = parseElementIdHex(slot.slot.elemId);
    const el = findElementById(layout, id);
    if (!el) { missed += 1; continue; }
    if (typeof el.x === "number") slot.el.style.left = `${el.x}px`;
    if (typeof el.y === "number") slot.el.style.top = `${el.y}px`;
    updated += 1;
  }
  return { updated, missed };
}

// Inventory view — mounted inside main-panel's body slot. Returns
// a cleanup fn the container calls on view swap.
export const view = {
  name: "Inventory",
  nameFor: (_ctx) => {
    const sn = document.getElementById("char-name")?.textContent
      || window.__pluginClient?.player?.stats?.name
      || null;
    return sn ? `Inventory of ${sn}` : "Inventory";
  },
  mount: (parentEl, ctx) => doMount(parentEl, ctx),
};

function doMount(parentEl, _ctx) {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  // Title + close are owned by main-panel (the shared container).

  // Paperdoll backdrop + body-slot squares per PAPERDOLL_SLOTS table.
  const paperdoll = document.createElement("div");
  paperdoll.className = "hb-inv-paperdoll";
  const paperdollBg = document.createElement("div");
  paperdollBg.className = "hb-inv-paperdoll-bg";
  paperdoll.appendChild(paperdollBg);
  const dollSlotEls = {};
  for (const s of PAPERDOLL_SLOTS) {
    const el = document.createElement("div");
    el.className = "hb-inv-doll-slot";
    el.dataset.equipMask = String(s.equipMask);
    el.dataset.name = s.name;
    el.dataset.elemId = s.elemId;
    el.style.left = `${s.x}px`;
    el.style.top = `${s.y}px`;
    const icon = document.createElement("div");
    icon.className = "hb-inv-doll-icon";
    icon.style.display = "none";
    el.appendChild(icon);
    const tip = document.createElement("span");
    tip.className = "hb-inv-doll-tip";
    setAcText(tip, s.name, { color: "#f0d8a0" });
    el.appendChild(tip);
    // Wave-D4: drag-source for equipped items (set when occupied via
    // placeEquippedInDoll). The dragstart hands off the inventory mime
    // shared with pack rows + trade-panel + vendor-ui so any drop
    // target that accepts inventory items works uniformly.
    el.addEventListener("dragstart", (ev) => {
      const guid = el.dataset.itemGuid;
      if (!guid) { ev.preventDefault(); return; }
      ev.dataTransfer.setData("application/x-hb-inv-guid", guid);
      ev.dataTransfer.setData("text/x-hb-item-guid", guid);
      ev.dataTransfer.effectAllowed = "move";
      // Stash on overlay so the dragover dispatcher can publish it
      // (HTML5 forbids reading dataTransfer.getData outside drop).
      overlay.dataset.draggingGuid = guid;
    });
    // Wave-D4: drop-target for pack→paperdoll wield. Allow drop only
    // when the mime is present. On enter/over highlight in brass; on
    // leave/drop clear. Wire WieldFromPack with this slot's equip_mask.
    el.addEventListener("dragenter", (ev) => {
      if (ev.dataTransfer?.types?.includes("application/x-hb-inv-guid")) {
        ev.preventDefault();
        el.classList.add("drag-target");
      }
    });
    el.addEventListener("dragover", (ev) => {
      if (ev.dataTransfer?.types?.includes("application/x-hb-inv-guid")) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
      }
    });
    el.addEventListener("dragleave", () => {
      el.classList.remove("drag-target");
    });
    el.addEventListener("drop", (ev) => {
      el.classList.remove("drag-target");
      const guidStr = ev.dataTransfer?.getData("application/x-hb-inv-guid");
      if (!guidStr) return;
      ev.preventDefault();
      ev.stopPropagation();
      const guid = (parseInt(guidStr, 10) >>> 0);
      if (!guid) return;
      // Don't fire if the source slot already has this item (no-op
      // self-drop on a re-arrange).
      if (el.dataset.itemGuid && String(el.dataset.itemGuid) === String(guid)) return;
      const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
      if (handle?.wieldFromPack) {
        try { handle.wieldFromPack(guid, s.equipMask >>> 0); }
        catch (e) { console.warn("[paperdoll] wieldFromPack failed:", e); }
      }
    });
    paperdoll.appendChild(el);
    dollSlotEls[s.equipMask] = { el, icon, tip, slot: s };
  }
  overlay.appendChild(paperdoll);

  // Bag column — 4 placeholder tabs for now (Main, Bag 1, 2, 3).
  const bagCol = document.createElement("div");
  bagCol.className = "hb-inv-bagcol";
  for (let i = 0; i < 4; i++) {
    const tab = document.createElement("div");
    tab.className = "hb-inv-bagtab" + (i === 0 ? " selected" : "");
    tab.dataset.bag = String(i);
    tab.title = i === 0 ? "Main pack" : `Bag ${i}`;
    tab.addEventListener("click", () => {
      bagCol.querySelectorAll(".hb-inv-bagtab").forEach((t) => t.classList.remove("selected"));
      tab.classList.add("selected");
    });
    bagCol.appendChild(tab);
  }
  overlay.appendChild(bagCol);

  // Burden meter
  const burdenRow = document.createElement("div");
  burdenRow.className = "hb-inv-burden";
  const burdenLbl = document.createElement("span");
  burdenLbl.className = "hb-inv-burden-label";
  setAcText(burdenLbl, "Burden", { color: "#a8a090" });
  burdenRow.appendChild(burdenLbl);
  const burdenBar = document.createElement("div");
  burdenBar.className = "hb-inv-burden-bar";
  const burdenFill = document.createElement("div");
  burdenFill.className = "hb-inv-burden-fill";
  burdenBar.appendChild(burdenFill);
  burdenRow.appendChild(burdenBar);
  const burdenPct = document.createElement("span");
  burdenPct.className = "hb-inv-burden-label";
  setAcText(burdenPct, "0%", { color: "#a8a090" });
  burdenRow.appendChild(burdenPct);
  overlay.appendChild(burdenRow);

  // Items grid (pack contents)
  const itemsGrid = document.createElement("div");
  itemsGrid.className = "hb-inv-items";
  overlay.appendChild(itemsGrid);

  // PR-T's in-place examine swap is replaced by main-panel.pushView
  // ("examine", ctx) — the WHOLE pane transitions, not just our lower
  // region. The user's eyes don't have to move because main-panel sits
  // in the same screen position regardless of which view is mounted.

  // Apply retail layout: body slots + paperdoll/bagcol/items region
  // boxes + burden bar position. Falls through to CSS defaults if the
  // layouts can't load. All four refs must be present in the DOM at
  // this point — applyInventoryLayout reads style.left/top off the
  // paperdoll to anchor the burden bar.
  applyInventoryLayout({
    paperdollEl: paperdoll,
    bagcolEl: bagCol,
    burdenEl: burdenRow,
    itemsEl: itemsGrid,
    dollSlotEls,
  });

  parentEl.appendChild(overlay);

  // Track the currently selected inventory <li> (for E-key fire).
  let selectedSrcLi = null;
  function setSelected(srcLi) {
    if (selectedSrcLi) {
      const prevSlot = itemsGrid.querySelector(`[data-guid="${selectedSrcLi.dataset.guid}"]`);
      prevSlot?.classList.remove("selected");
    }
    selectedSrcLi = srcLi;
    if (srcLi) {
      const slot = itemsGrid.querySelector(`[data-guid="${srcLi.dataset.guid}"]`);
      slot?.classList.add("selected");
    }
  }

  // Expose to other plugins so the floating examine popup can skip
  // when the selection is an inventory item.
  window.__isInventoryItem = (guid) => {
    const g = String(guid >>> 0);
    const eq = document.getElementById("inv-equipped");
    const pk = document.getElementById("inv-pack");
    for (const list of [eq, pk]) {
      if (!list) continue;
      for (const li of list.children) {
        if (String(li.dataset.guid >>> 0) === g) return true;
      }
    }
    return false;
  };

  // ── Mirror from index.html's #inv-equipped + #inv-pack ────────────
  function makeSlot(srcLi) {
    const slot = document.createElement("div");
    slot.className = "hb-inv-slot";
    slot.dataset.guid = srcLi.dataset?.guid ?? "";
    const tb = srcLi.dataset?.typeBit ?? "0x0";
    slot.dataset.typeBit = tb;
    const icon = document.createElement("div");
    icon.className = "hb-inv-icon";
    icon.style.background = TYPE_COLOR[tb] || "#444";
    slot.appendChild(icon);
    // Stack count (if the source row has a ×N badge)
    const stack = srcLi.querySelector(".stack");
    if (stack) {
      const s = document.createElement("span");
      s.className = "hb-inv-stack";
      setAcText(s, stack.textContent, { color: "#f0d8a0" });
      slot.appendChild(s);
    }
    // Tooltip
    const tip = document.createElement("span");
    tip.className = "hb-inv-tip";
    const name = srcLi.querySelector(".name");
    setAcText(tip, name?.textContent ?? "(unnamed)", { color: "#f0d8a0" });
    slot.appendChild(tip);
    // Forward draggable (vendor sells use the same pattern as the
    // source <li> with draggable=true).
    if (srcLi.getAttribute("draggable") === "true") {
      slot.draggable = true;
      slot.addEventListener("dragstart", (ev) => {
        ev.dataTransfer.setData("application/x-hb-inv-guid", slot.dataset.guid);
        ev.dataTransfer.effectAllowed = "move";
      });
    }
    // Single click → select + push examine view onto main-panel stack.
    // The shared container swaps the whole pane to examine; "Back"
    // returns to inventory. Matches retail's full-pane transition.
    slot.addEventListener("click", () => {
      setSelected(srcLi);
      const guid = srcLi.dataset?.guid;
      const name = srcLi.querySelector(".name")?.textContent || "Item";
      window.__mainPanel?.pushView?.("examine", { guid, name, fromInventory: true, srcLi });
    });
    return slot;
  }

  // Find the inventory item record for a given source <li> via wasm.
  // The source <li>'s data-guid lets us look up the item's equipMask
  // from the SessionHandle.playerInventory() snapshot.
  function getItemByGuid(guid) {
    try {
      const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
      if (!handle?.playerInventory) return null;
      const items = handle.playerInventory();
      return items.find((it) => String(it.guid) === String(guid)) || null;
    } catch (_) { return null; }
  }

  // Clear any equipped icon from every paperdoll slot.
  function clearPaperdoll() {
    for (const k of Object.keys(dollSlotEls)) {
      const e = dollSlotEls[k];
      e.el.classList.remove("equipped");
      e.el.classList.remove("drag-target");
      delete e.el.dataset.itemGuid;
      delete e.el.dataset.itemName;
      e.el.draggable = false;
      e.icon.style.display = "none";
      e.icon.style.background = "";
      setAcText(e.tip, e.slot.name, { color: "#f0d8a0" });
    }
  }

  // Place an equipped item into the matching paperdoll slot. equipMask
  // may have multiple bits set — find the first slot whose mask AND'd
  // with the item's equipMask is non-zero.
  function placeEquippedInDoll(srcLi, item) {
    const em = (item?.equipMask >>> 0) || 0;
    if (em === 0) return false;
    let matched = null;
    for (const k of Object.keys(dollSlotEls)) {
      const slotMask = Number(k) >>> 0;
      if ((em & slotMask) !== 0) {
        matched = dollSlotEls[k];
        break;
      }
    }
    if (!matched) return false;
    matched.el.classList.add("equipped");
    const tb = srcLi.dataset?.typeBit ?? "0x0";
    const guid = String(item?.guid ?? srcLi.dataset?.guid ?? "");
    matched.el.dataset.itemGuid = guid;
    matched.el.dataset.itemName = item?.name || matched.slot.name;
    // Wave-D4: equipped items are drag-sources so the user can drag
    // them off the paperdoll onto the 3D canvas to drop them.
    matched.el.draggable = true;
    matched.icon.style.display = "block";
    matched.icon.style.background = TYPE_COLOR[tb] || "#777";
    setAcText(matched.tip, `${item.name || matched.slot.name} — ${matched.slot.name}`, { color: "#f0d8a0" });
    const iconId = (item?.iconId >>> 0) || 0;
    if (iconId) {
      fetchPaperdollIconDataUrl(iconId).then((url) => {
        // Skip if the user has swapped items mid-fetch.
        if (matched.el.dataset.itemGuid !== guid) return;
        if (url) matched.icon.style.background = `url("${url}") center/contain no-repeat`;
      });
    }
    return true;
  }

  function rebuild() {
    const equipped = document.getElementById("inv-equipped");
    const pack = document.getElementById("inv-pack");
    clearPaperdoll();
    itemsGrid.innerHTML = "";
    // Equipped → paperdoll body slots
    if (equipped) {
      for (const li of equipped.children) {
        const item = getItemByGuid(li.dataset.guid);
        const placed = placeEquippedInDoll(li, item);
        if (!placed) {
          // Couldn't match any slot (unknown equipMask) — fall back to grid.
          itemsGrid.appendChild(makeSlot(li));
        }
      }
    }
    // Pack → items grid
    if (pack) {
      for (const li of pack.children) {
        itemsGrid.appendChild(makeSlot(li));
      }
    }
    // Wave-D4: burden meter — playerBurden is a getter (no parens) per
    // the wasm-bindgen #[wasm_bindgen(getter)] attribute. Value is
    // encumbrance/capacity (0..1+ where >1.0 = over-encumbered, which
    // retail allowed with movement penalties).
    updateBurden();
  }

  function updateBurden() {
    try {
      const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
      if (!handle) return;
      const burden = Number(handle.playerBurden ?? 0);
      const pctRaw = Math.max(0, Math.round(burden * 100));
      const pctClamped = Math.min(100, pctRaw);
      burdenFill.style.width = `${pctClamped}%`;
      // Over-encumbered (>90%) tints red regardless of gradient;
      // 50-90% gold; <=50% cream (matches retail's encumbrance bar
      // colour ramp). The CSS-defined gradient handles the smooth
      // transition; the inline override only applies above thresholds
      // so the gradient still shows in normal range.
      if (pctRaw > 100) {
        burdenFill.style.background = "var(--hb-text-red, #c83838)";
      } else {
        burdenFill.style.background = ""; // restore CSS gradient
      }
      let labelColor = "var(--hb-text-cream)";
      if (pctRaw > 90) labelColor = "#c83838";
      else if (pctRaw > 50) labelColor = "var(--hb-text-gold)";
      setAcText(burdenPct, `${pctRaw}%`, { color: labelColor });
    } catch (e) {
      // Pre-spawn / playerBurden missing — leave the bar at 0%.
    }
  }

  let observers = [];
  function tryHook() {
    const equipped = document.getElementById("inv-equipped");
    const pack = document.getElementById("inv-pack");
    if (!equipped || !pack) return false;
    rebuild();
    for (const list of [equipped, pack]) {
      const o = new MutationObserver(() => rebuild());
      o.observe(list, { childList: true, subtree: false });
      observers.push(o);
    }
    return true;
  }
  let pollTimer = null;
  if (!tryHook()) {
    pollTimer = setInterval(() => {
      if (tryHook()) { clearInterval(pollTimer); pollTimer = null; }
    }, 500);
  }

  // E key removed 2026-05-22 (movement-key collision with turn-right).
  // Inventory item examine now requires explicit click on the item
  // slot — the slot click handler pushes the examine view directly.
  function onKey(_ev) { /* no-op placeholder for cleanup symmetry */ }
  window.addEventListener("keydown", onKey);

  // Wave 7.9 — dragover event dispatch for plugins that want to react
  // to drag interactions (currently: dye-preview plugin shows a
  // tooltip when a dye-pot is dragged over a dyeable armor). The
  // event fires continuously during drag; subscribers debounce as
  // needed. Drop is still a no-op in inventory.js (recipe-use wire
  // is a separate piece of work); this dispatch is for visual
  // feedback only.
  function dispatchInventoryDragOver(ev, scope) {
    // dataTransfer.getData returns "" during dragover (only readable
    // on drop per the HTML5 spec). Subscribers identify the dragged
    // item via the dragstart-time stash on overlay.dataset
    // .draggingGuid below. We still preventDefault on every
    // dragover that hits the panel so the drop indicator is correct.
    ev.preventDefault();
    const hoveredSlot = ev.target.closest?.(".hb-inv-doll-slot, .hb-inv-slot, [data-guid]") ?? null;
    try {
      window.dispatchEvent(new CustomEvent("hb:inventory-drag-over", {
        detail: {
          scope,
          hoveredElement: ev.target,
          hoveredSlot,
          hoveredGuid: hoveredSlot?.dataset?.guid ?? null,
          // The currently-being-dragged GUID is captured at dragstart
          // time + stashed on the overlay for retrieval here (W7.9
          // workaround for the dataTransfer.getData drag-over
          // restriction in HTML5).
          draggedGuid: overlay.dataset.draggingGuid ?? null,
          clientX: ev.clientX,
          clientY: ev.clientY,
          // Wave 7.9.B — shiftKey carries through so the dye-preview
          // plugin can route Shift+drag-over into the whole-mesh
          // applyAppearance local preview path.
          shiftKey: !!ev.shiftKey,
          altKey: !!ev.altKey,
          ctrlKey: !!ev.ctrlKey,
        },
      }));
    } catch (_) {}
  }
  // Capture dragstart on the overlay so we know what's being dragged
  // during subsequent dragover events (dataTransfer.getData isn't
  // available outside drop per the HTML5 spec).
  overlay.addEventListener("dragstart", (ev) => {
    const guid = ev.target?.dataset?.guid ?? ev.target?.closest?.("[data-guid]")?.dataset?.guid;
    if (guid) overlay.dataset.draggingGuid = guid;
  }, true);
  overlay.addEventListener("dragend", () => {
    delete overlay.dataset.draggingGuid;
    try {
      window.dispatchEvent(new CustomEvent("hb:inventory-drag-end"));
    } catch (_) {}
  }, true);
  paperdoll.addEventListener("dragover", (ev) => dispatchInventoryDragOver(ev, "paperdoll"));
  itemsGrid.addEventListener("dragover", (ev) => dispatchInventoryDragOver(ev, "items"));

  // Wave-D4: 3D canvas drop target — drag any inventory item onto the
  // viewport (NOT onto another inventory/paperdoll slot) to drop it on
  // the ground at the player's feet. ACE handles drop-position +
  // unequip-if-needed sequencing.
  const canvasEl = document.getElementById("canvas");
  function onCanvasDragOver(ev) {
    if (ev.dataTransfer?.types?.includes("application/x-hb-inv-guid")) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
    }
  }
  function onCanvasDrop(ev) {
    const guidStr = ev.dataTransfer?.getData("application/x-hb-inv-guid");
    if (!guidStr) return;
    ev.preventDefault();
    const guid = (parseInt(guidStr, 10) >>> 0);
    if (!guid) return;
    const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
    if (handle?.dropItem) {
      try { handle.dropItem(guid); }
      catch (e) { console.warn("[paperdoll] dropItem failed:", e); }
    }
  }
  if (canvasEl) {
    canvasEl.addEventListener("dragover", onCanvasDragOver);
    canvasEl.addEventListener("drop", onCanvasDrop);
  }

  // Wave-D4: burden refreshes on every stats bump (UpdateAttribute,
  // equip/unequip, inventory delta — all bucketed into kind=8 by the
  // recv loop's dispatcher). Best-effort: the plugin client may not be
  // ready yet when the view mounts on first login, so a poll-loop
  // fallback fires updateBurden() until it lands.
  let unsubStats = null;
  function tryHookStats() {
    const pc = window.__pluginClient;
    if (!pc?.events?.on) return false;
    const onStats = () => updateBurden();
    pc.events.on("playerStatsUpdated", onStats);
    pc.events.on("playerInventoryChanged", onStats);
    unsubStats = () => {
      try { pc.events.off("playerStatsUpdated", onStats); } catch (_) {}
      try { pc.events.off("playerInventoryChanged", onStats); } catch (_) {}
    };
    return true;
  }
  let statsPollTimer = null;
  if (!tryHookStats()) {
    statsPollTimer = setInterval(() => {
      if (tryHookStats()) { clearInterval(statsPollTimer); statsPollTimer = null; }
    }, 500);
  }
  // Initial pass — playerBurden is 0.0 pre-spawn, the kind=8 event
  // refreshes once the biota lands.
  updateBurden();

  return () => {
    window.removeEventListener("keydown", onKey);
    delete window.__isInventoryItem;
    if (pollTimer) clearInterval(pollTimer);
    if (statsPollTimer) clearInterval(statsPollTimer);
    if (unsubStats) unsubStats();
    if (canvasEl) {
      canvasEl.removeEventListener("dragover", onCanvasDragOver);
      canvasEl.removeEventListener("drop", onCanvasDrop);
    }
    for (const o of observers) o.disconnect();
    overlay.remove();
  };
}
