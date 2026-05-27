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
//   - Right 61x339: bag-tab column (1 main pack + 7 side packs = 8 tabs,
//     per the Inventory Panel wiki article; 9 with the Shadow of the
//     Seventh Mule augmentation, gated on server-side state).
//   - Lower 234x120: items grid for pack items (32x32 slots).
//
// Burden meter lives in `plugins/status-indicators.js` (the real retail
// indicator 0x100000F7 in gmFloatyIndicatorsUI 0x21000071, anchored at
// the top-left status strip). This panel does NOT render a duplicate
// burden bar — Wave 12 originally mistook PAPERDOLL_ELEM_BURDEN
// (0x100005BE) for the burden indicator, but that element is actually
// a paperdoll button/checkbox (Wave 13 audit finding).
//
// Paperdoll has 22 slots total (per retail GetLocationInfoFromElementID
// at acclient.c:219835): head/chest/abdomen/upper-arm/lower-arm/glove
// (HandWear)/upper-leg/lower-leg/foot armor; head/chest/upper-leg
// undershirts; necklace + 2 bracelets + 2 rings (jewelry); cloak; shield;
// trinket; 3 Aetheria (Sigil1/2/3, hidden until the Aetheria Quest
// AetheriaBits attribute unlocks them).

import { setAcText } from "../ui/ac_font.js";
import { loadLayout, findElementById, parseElementIdHex, getCachedLayout } from "../ui/ac_layout.js";
import { PaperdollViewport } from "../ui/ac_paperdoll_viewport.js";

/** Retail LayoutDescs covering the inventory window.
 *
 *  - `gmInventoryUI` (0x21000023, 300×362) — outer-window children
 *    laying out the paperdoll area, bag column, items grid, title,
 *    and close button. Top-level element 0x100001CC.
 *  - `gmPaperDollUI` (0x21000024, 224×214) — body-slot positions for
 *    the equipment grid only. The real burden indicator lives in
 *    `gmFloatyIndicatorsUI` 0x21000071 (status-indicators.js).
 *
 *  Per ElementDesc.element_id mapping (cross-checked against
 *  paperdoll_layout_dump output + retail-anatomy validation):
 */
const INVENTORY_LAYOUT_ID = 0x21000023;
const PAPERDOLL_LAYOUT_ID = 0x21000024;
const INV_ELEM_PAPERDOLL_AREA = 0x100001CD;
const INV_ELEM_BAG_COLUMN    = 0x100001CE;
const INV_ELEM_ITEMS_GRID    = 0x100001CF;


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

// Wave 13.2 — ItemType bit for the Container subclass (side packs).
// Source: external/ACE/Source/ACE.Entity/Enum/ItemType.cs:18
//     Container = 0x00000200,
// Surfaced on the wire via PropertyInt::ItemType and snapshot-published
// as `InventoryItem.itemType` (src/lib.rs:14263-14266).
const ITEM_TYPE_CONTAINER = 0x00000200;

// Bag tabs: 1 main + 7 side packs (per the Inventory Panel wiki article:
// "The top bag is your main inventory, and below it are slots for 7
// additional containers."). The Shadow of the Seventh Mule augmentation
// can add a 9th — surfaced when its wire event lands. Slots without an
// owned pack stay dim/empty.
const BAG_COUNT = 8;

// Item-type-bit → color (mirrors index.html's #inventory-panel cat
// CSS but adapted for our dark backdrop).
const TYPE_COLOR = {
  "0x4":     "#7da6e0",   // Weapon
  "0x2":     "#7dd9a0",   // Armor
  "0x10000": "#c060ff",   // Magic / scroll
  "0x20":    "#f0c060",   // Money / pyreal
};

// Paperdoll equipment slot table — element IDs + equipMask bits from
// gmPaperDollUI::GetLocationInfoFromElementID at acclient.c:219835-219952.
// X+Y coords come straight from gmPaperDollUI-0x21000024 LayoutDesc dump
// (apps/holtburger-tools/examples/paperdoll_layout_dump.rs). retail
// layout uses 32×32 slots in a 224×214 anatomy box. The Aetheria slots
// (SigilOne/Two/Three) and TrinketOne are hidden by retail until the
// player completes the Aetheria Quest (per acclient.c:220154
// gmPaperDollUI::UpdateAetheria — gates on PSetIntStat 0x142 AetheriaBits
// 0x1 / 0x2 / 0x4). We render them as dimmed slots for now; the visibility
// gating will be wired when the AetheriaBits arrives over the wire.
//
// EquipMask values cite ACE.Entity/Enum/EquipMask.cs (which matches the
// chorizite Chorizite.Common/Enums/EquipMask.cs verbatim) and the retail
// element_id table at acclient.c:219839-219951.
//
// Side values: 0 = both/center, 1 = LEFT, 2 = RIGHT
// (per acclient.h:4546-4552 UI_SLOT_SIDE_NULL=0, _LEFT=1, _RIGHT=2).
// Equipped items render in the slot whose equipMask bit matches
// `item.equipMask & slot.equipMask`.
const PAPERDOLL_SLOTS = [
  // Top-row chrome (left of head): Necklace + Trinket
  { elemId: "0x100001DA", equipMask: 0x00008000, x: 8,   y: 8,   name: "Necklace" },
  { elemId: "0x1000058E", equipMask: 0x04000000, x: 8,   y: 44,  name: "Trinket" },
  // Top-row chrome (right of head): 3 Aetheria slots (Blue/Yellow/Red).
  // Per acclient.c:220154 UpdateAetheria — these are SigilOne/Two/Three,
  // hidden until the player unlocks them via the Aetheria Quest at
  // levels 75/150/225 (wiki: "Inventory Panel" -> Equipment Slots -> Other).
  { elemId: "0x10000595", equipMask: 0x10000000, x: 126, y: 8,   name: "Aetheria Blue" },
  { elemId: "0x10000596", equipMask: 0x20000000, x: 158, y: 8,   name: "Aetheria Yellow" },
  { elemId: "0x10000597", equipMask: 0x40000000, x: 190, y: 8,   name: "Aetheria Red" },
  // Head + cloak row (mid-top)
  { elemId: "0x100005AB", equipMask: 0x00000001, x: 84,  y: 28,  name: "Head" },
  { elemId: "0x100005E9", equipMask: 0x08000000, x: 192, y: 44,  name: "Cloak" },
  // Upper torso (chest armor + arm armor + chest under-shirt)
  { elemId: "0x100005AE", equipMask: 0x00000800, x: 48,  y: 64,  name: "Upper arm" },
  { elemId: "0x100005AC", equipMask: 0x00000200, x: 84,  y: 64,  name: "Chest armor" },
  { elemId: "0x100001E2", equipMask: 0x00000002, x: 192, y: 80,  name: "Shirt" },
  // Mid torso (lower arm + abdomen + wrist L/R)
  { elemId: "0x100005AF", equipMask: 0x00001000, x: 48,  y: 100, name: "Lower arm" },
  { elemId: "0x100005AD", equipMask: 0x00000400, x: 84,  y: 100, name: "Abdomen" },
  { elemId: "0x100001DD", equipMask: 0x00020000, x: 8,   y: 80,  name: "Bracelet (R)" },
  { elemId: "0x100001DB", equipMask: 0x00010000, x: 156, y: 80,  name: "Bracelet (L)" },
  // Upper legs + ring L/R + pants
  { elemId: "0x100005B1", equipMask: 0x00002000, x: 120, y: 100, name: "Upper leg" },
  { elemId: "0x100001E3", equipMask: 0x00000040, x: 192, y: 116, name: "Pants" },
  { elemId: "0x100001DE", equipMask: 0x00080000, x: 8,   y: 116, name: "Ring (R)" },
  { elemId: "0x100001DC", equipMask: 0x00040000, x: 156, y: 116, name: "Ring (L)" },
  // Lower legs + gloves
  { elemId: "0x100005B0", equipMask: 0x00000020, x: 48,  y: 136, name: "Gloves" },
  { elemId: "0x100005B2", equipMask: 0x00004000, x: 120, y: 136, name: "Lower leg" },
  // Feet + shield (shield lives at the lower-left chrome corner)
  { elemId: "0x100001E1", equipMask: 0x00200000, x: 8,   y: 172, name: "Shield" },
  { elemId: "0x100005B3", equipMask: 0x00000100, x: 120, y: 172, name: "Boots" },
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
       content (paperdoll + bag column + items / examine swap)
       inside the provided bodyEl. Burden indicator lives in
       plugins/status-indicators.js (top-left status strip). */
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
      z-index: 0;
    }
    /* Wave 14 — PaperdollViewport canvas. Renders the local player's
       3D rig behind the slot frames so equipped armor/dyes show on
       the body AND the slot icon stays visible at the panel edge.
       pointer-events:none lets slot clicks pass through to the slots. */
    #${OVERLAY_ID} .hb-inv-paperdoll-viewport {
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      z-index: 1;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hb-inv-paperdoll-viewport canvas {
      display: block;
      width: 100%;
      height: 100%;
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
      z-index: 2;
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
      z-index: 3;
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
    /* Bag column — narrow vertical strip on the right. Tall enough
       to fit 8 tabs (main + 7 side packs) plus future Mule-aug 9th.
       Retail's LayoutDesc 0x21000023 sets this to 61×339; the CSS
       fallback uses a similar height in case the layout doesn't load. */
    #${OVERLAY_ID} .hb-inv-bagcol {
      position: absolute;
      top: ${TITLE_H + 4}px;
      right: 6px;
      width: ${BAG_COL_W}px;
      height: 308px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 4px;
      pointer-events: auto;
      border: 1px solid var(--hb-border-brass-dim);
      background: rgba(0, 0, 0, 0.35);
    }
    #${OVERLAY_ID} .hb-inv-bagtab {
      position: relative;
      width: ${SLOT_SIZE - 4}px;
      height: ${SLOT_SIZE - 4}px;
      background: url("./sprites/acsprites/icon-slot-bg.png") center/100% 100% no-repeat;
      cursor: pointer;
      image-rendering: pixelated;
      opacity: 1;
    }
    /* Empty tab (no pack equipped) — dimmed, non-interactive. */
    #${OVERLAY_ID} .hb-inv-bagtab.empty {
      opacity: 0.35;
      cursor: default;
    }
    #${OVERLAY_ID} .hb-inv-bagtab:not(.empty):hover {
      filter: brightness(1.25);
    }
    #${OVERLAY_ID} .hb-inv-bagtab.selected {
      opacity: 1;
      filter: drop-shadow(0 0 3px var(--hb-text-gold));
    }
    /* Pack icon overlay inside the tab (~24×24 centered in 28×28). */
    #${OVERLAY_ID} .hb-inv-bagtab-icon {
      position: absolute;
      top: 2px; left: 2px;
      width: 24px;
      height: 24px;
      background-position: center;
      background-size: contain;
      background-repeat: no-repeat;
      pointer-events: none;
      image-rendering: pixelated;
    }
    /* Burden meter moved to plugins/status-indicators.js (real retail
       indicator 0x100000F7 in gmFloatyIndicatorsUI 0x21000071). The
       inventory panel no longer renders its own burden bar. */
    /* Items grid — pack contents below the paperdoll. Retail LayoutDesc
       0x100001CF is 120px tall (gmInventoryUI 0x21000023). Wave 12 used
       top/bottom anchors which computed to 114px; Wave 13 switches to a
       fixed 120px height to match retail. */
    #${OVERLAY_ID} .hb-inv-items {
      position: absolute;
      top: ${TITLE_H + PAPERDOLL_H + 28}px;
      left: 6px;
      right: 6px;
      height: 120px;
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
//   - itemsEl      → grid of pack-content slots below the paperdoll
//   - dollSlotEls  → map of equipMask → { el, slot } for body slots
//
// Retail anatomy (from inventory_layouts_dump 2026-05-24):
//   - Paperdoll area at (0, 23) inside the 300×362 window
//   - Bag column at (239, 23), 61×339 — extends past paperdoll
//   - Items grid at (0, 237), 234×120 — directly below paperdoll
//
// Burden indicator is owned by plugins/status-indicators.js (real
// retail indicator 0x100000F7 in gmFloatyIndicatorsUI 0x21000071);
// the Wave 12 attempt to anchor 0x100005BE here was an audit-flagged
// mislabel (that element is actually a paperdoll button/checkbox).
//
// Both layouts cache after the first call; re-mounts re-apply
// synchronously. Falls through silently if either layout fails to
// load — the hand-tuned defaults in CSS stay in effect.
function applyInventoryLayout(refs) {
  const apply = ([inv, doll]) => {
    let appliedRegions = 0;
    let slotUpdates = { updated: 0, missed: 0 };

    if (inv) {
      const paperdollArea = findElementById(inv, INV_ELEM_PAPERDOLL_AREA);
      const bagcol = findElementById(inv, INV_ELEM_BAG_COLUMN);
      const itemsGrid = findElementById(inv, INV_ELEM_ITEMS_GRID);

      if (paperdollArea && refs.paperdollEl) {
        applyBox(refs.paperdollEl, paperdollArea);
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
        // Bottom is no longer in CSS (Wave 13: fixed height 120px),
        // but defensively clear anyway in case the rule comes back.
        refs.itemsEl.style.bottom = "";
        applyBox(refs.itemsEl, itemsGrid);
        appliedRegions += 1;
      }
    }

    if (doll) {
      // Body slots — uses the same map findElementById walks.
      slotUpdates = applySlotPositions(doll, refs.dollSlotEls);
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
  // Wave 14 — 3D character doll viewport (mirrors retail
  // gmPaperDollUI::RedressCreature at acclient.c:4146). Renders the
  // local player rig BEHIND the slot squares so equipped armor shows on
  // the body AND the slot frame still shows its icon. Loaded once the
  // local player guid + meta are known; reloaded whenever the inventory
  // snapshot changes (equip / dye / applyAppearance).
  const paperdollViewport = new PaperdollViewport({
    width: PAPERDOLL_W, height: PAPERDOLL_H,
  });
  const viewportWrap = document.createElement("div");
  viewportWrap.className = "hb-inv-paperdoll-viewport";
  viewportWrap.appendChild(paperdollViewport.dom);
  paperdoll.appendChild(viewportWrap);
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

  // Bag column — see BAG_COUNT (8). The first tab is the main pack
  // (containerId 0 — items the player owns directly). The remaining 7
  // slots are reserved for side packs (Container items in the player's
  // inventory, identified by ItemType bit 0x200). Slots without an
  // owned pack stay dim/empty until the player drags a pack in.
  //
  // Wave 13.2 — the items grid is now filtered by the currently
  // selected pack's container_id. `selectedPackContainerId` defaults
  // to 0 (main pack). `bagSlots` is rebuilt on each `rebuild()` pass
  // from the wasm snapshot: index 0 always = main pack; indices 1..7
  // populated dynamically with whichever Container items are in the
  // player's main inventory.
  let selectedPackContainerId = 0;
  let bagSlots = new Array(BAG_COUNT).fill(null);
  bagSlots[0] = { containerId: 0, name: "Main Pack", iconId: 0 };

  const bagCol = document.createElement("div");
  bagCol.className = "hb-inv-bagcol";
  const bagTabEls = [];
  for (let i = 0; i < BAG_COUNT; i++) {
    const tab = document.createElement("div");
    // Initial state: tab 0 (main pack) is selected, tabs 1..7 are empty.
    // renderBagTabs() rebuilds these classes whenever the snapshot
    // changes; this is just the pre-snapshot initial render.
    const classes = ["hb-inv-bagtab"];
    if (i === 0) classes.push("selected");
    else classes.push("empty");
    tab.className = classes.join(" ");
    tab.dataset.bag = String(i);
    tab.title = i === 0 ? "Main Pack" : "Empty pack slot";
    // Icon overlay slot — populated when a side pack is equipped.
    const tabIcon = document.createElement("div");
    tabIcon.className = "hb-inv-bagtab-icon";
    tabIcon.style.display = "none";
    tab.appendChild(tabIcon);
    tab.addEventListener("click", () => {
      const slot = bagSlots[i];
      if (!slot) return; // empty slot — nothing to switch to
      if (selectedPackContainerId === slot.containerId) return; // no-op
      selectedPackContainerId = slot.containerId >>> 0;
      bagCol.querySelectorAll(".hb-inv-bagtab").forEach((t) => t.classList.remove("selected"));
      tab.classList.add("selected");
      rebuildItemsGrid();
    });
    bagCol.appendChild(tab);
    bagTabEls.push({ tabEl: tab, iconEl: tabIcon });
  }
  overlay.appendChild(bagCol);

  // Burden meter removed in Wave 13 — the real retail indicator lives
  // in plugins/status-indicators.js (gmFloatyIndicatorsUI 0x21000071,
  // top-left status strip). Wave 12 had mistaken paperdoll element
  // 0x100005BE for the burden indicator; audit caught the mislabel.

  // Items grid (pack contents)
  const itemsGrid = document.createElement("div");
  itemsGrid.className = "hb-inv-items";
  overlay.appendChild(itemsGrid);

  // PR-T's in-place examine swap is replaced by main-panel.pushView
  // ("examine", ctx) — the WHOLE pane transitions, not just our lower
  // region. The user's eyes don't have to move because main-panel sits
  // in the same screen position regardless of which view is mounted.

  // Apply retail layout: body slots + paperdoll/bagcol/items region
  // boxes. Falls through to CSS defaults if the layouts can't load.
  applyInventoryLayout({
    paperdollEl: paperdoll,
    bagcolEl: bagCol,
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

  // Cached snapshot of the most recent SessionHandle.playerInventory()
  // call (refreshed at the top of rebuild()). Wave 13.2 — keeping the
  // snapshot lets the bag-tab click path filter the items grid without
  // re-querying wasm. The snapshot already carries each item's
  // containerId / itemType / iconId / name (see src/lib.rs:21208-21221).
  let inventorySnapshot = [];
  function refreshInventorySnapshot() {
    try {
      const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
      if (!handle?.playerInventory) { inventorySnapshot = []; return; }
      inventorySnapshot = handle.playerInventory();
    } catch (_) { inventorySnapshot = []; }
  }

  // Find the inventory item record for a given source <li> via wasm.
  // The source <li>'s data-guid lets us look up the item's equipMask
  // from the SessionHandle.playerInventory() snapshot.
  function getItemByGuid(guid) {
    if (!inventorySnapshot || inventorySnapshot.length === 0) return null;
    return inventorySnapshot.find((it) => String(it.guid) === String(guid)) || null;
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

  // Wave 13.2 — recompute bagSlots from the wasm snapshot. Index 0 is
  // always the main pack; indices 1..7 are populated dynamically with
  // Container items (ItemType bit 0x200) in the player's main inventory
  // (containerId === 0). Equipped items are excluded — side packs in
  // retail show up under the main pack regardless of equip state.
  // Selection survives a rebuild if the previously-selected container
  // is still present; otherwise we fall back to the main pack.
  function rebuildBagSlots() {
    const next = new Array(BAG_COUNT).fill(null);
    next[0] = { containerId: 0, name: "Main Pack", iconId: 0 };
    let nextIdx = 1;
    for (const it of inventorySnapshot) {
      // Containers are tagged by ItemType bit 0x200 (Container subclass).
      // We only list packs that the PLAYER directly owns (containerId 0).
      // Nested packs (a pack inside a pack — rare but legal in retail)
      // are unsupported by this UI; they'll surface as items under their
      // parent pack just like any other inventoried item.
      if ((it.itemType >>> 0) & ITEM_TYPE_CONTAINER) {
        if ((it.containerId >>> 0) !== 0) continue;
        if (nextIdx >= BAG_COUNT) break;
        next[nextIdx++] = {
          containerId: it.guid >>> 0,
          name: it.name || `Side pack ${nextIdx - 1}`,
          iconId: (it.iconId >>> 0) || 0,
        };
      }
    }
    bagSlots = next;
    // If the previously-selected container vanished (pack dropped/sold),
    // fall back to the main pack.
    if (selectedPackContainerId !== 0
        && !bagSlots.some((s) => s && s.containerId === selectedPackContainerId)) {
      selectedPackContainerId = 0;
    }
    renderBagTabs();
  }

  function renderBagTabs() {
    for (let i = 0; i < BAG_COUNT; i++) {
      const { tabEl, iconEl } = bagTabEls[i];
      const slot = bagSlots[i];
      if (!slot) {
        // Empty slot — dim, no icon, no tooltip beyond "Empty pack slot".
        tabEl.classList.add("empty");
        tabEl.classList.remove("selected");
        tabEl.title = "Empty pack slot";
        iconEl.style.display = "none";
        iconEl.style.backgroundImage = "";
        continue;
      }
      tabEl.classList.remove("empty");
      tabEl.title = slot.name;
      tabEl.classList.toggle("selected", slot.containerId === selectedPackContainerId);
      // Phase 13.4 — pack icon overlay. Side packs (containerId !== 0)
      // have an iconId from PublicWeenieDescription. Main pack uses the
      // built-in slot art (no overlay).
      if (slot.containerId !== 0 && slot.iconId) {
        iconEl.style.display = "block";
        fetchPaperdollIconDataUrl(slot.iconId).then((url) => {
          // Skip if the slot's containerId changed mid-fetch.
          if (bagSlots[i]?.containerId !== slot.containerId) return;
          if (url) iconEl.style.backgroundImage = `url("${url}")`;
        });
      } else {
        iconEl.style.display = "none";
        iconEl.style.backgroundImage = "";
      }
    }
  }

  // Wave 13.2 — render only the items whose containerId matches the
  // currently selected pack. Pack <li>s come from index.html's #inv-pack
  // list, but containerId is on the wasm snapshot — we cross-reference
  // via the cached `inventorySnapshot` (see refreshInventorySnapshot).
  function rebuildItemsGrid() {
    itemsGrid.innerHTML = "";
    const pack = document.getElementById("inv-pack");
    if (!pack) return;
    for (const li of pack.children) {
      const guidStr = li.dataset?.guid;
      if (!guidStr) continue;
      const item = getItemByGuid(guidStr);
      // Snapshot may not have caught up yet — fall back to main-pack
      // visibility so we never silently hide everything.
      const itemContainerId = item ? (item.containerId >>> 0) : 0;
      if (itemContainerId !== selectedPackContainerId) continue;
      itemsGrid.appendChild(makeSlot(li));
    }
  }

  // Wave 14 — pull the local player's setup + substitution set from
  // the live entity manager and (re)load the paperdoll viewport. The
  // local-player meta path matches what dye-preview.js does for its
  // half-scale player rig (see plugins/dye-preview.js:325-340): look up
  // `window.getLocalPlayerGuid()` then resolve `entityMap.get(lpg).meta`
  // which carries {modelId/setupId, mtableId, paletteId, subPalettes}
  // populated by the spawn path + kept up to date by applyAppearance
  // (entities.js:3846). PaperdollViewport.loadPlayer is idempotent on
  // (setupId, mtableId, paletteId, subPalettes) so repeated rebuild()
  // calls with no equip change are cheap.
  function refreshPaperdollViewport() {
    try {
      const lpg = (typeof window.getLocalPlayerGuid === "function")
        ? (window.getLocalPlayerGuid() >>> 0) : 0;
      if (lpg === 0) return;
      const em = window.liveScene3d?.entityManager;
      const inst = em?.entityMap?.get?.(lpg);
      const meta = inst?.meta;
      if (!meta) return;
      const setupId = (meta.modelId ?? meta.setupId ?? 0) >>> 0;
      if (setupId === 0) return;
      paperdollViewport.loadPlayer(
        setupId,
        (meta.mtableId ?? 0) >>> 0,
        (meta.paletteId ?? 0) >>> 0,
        meta.subPalettes ?? new Uint32Array(0),
      ).catch(() => {});
    } catch (_) { /* viewport is best-effort */ }
  }

  function rebuild() {
    refreshInventorySnapshot();
    const equipped = document.getElementById("inv-equipped");
    clearPaperdoll();
    rebuildBagSlots();
    // Equipped → paperdoll body slots. Items that don't match any
    // paperdoll slot (unknown equipMask) fall through to the items grid,
    // but only when the main pack is selected (mirrors retail —
    // unknown-slot items live in the player's main inventory).
    const orphanedEquipped = [];
    if (equipped) {
      for (const li of equipped.children) {
        const item = getItemByGuid(li.dataset.guid);
        const placed = placeEquippedInDoll(li, item);
        if (!placed) orphanedEquipped.push(li);
      }
    }
    rebuildItemsGrid();
    if (selectedPackContainerId === 0) {
      for (const li of orphanedEquipped) {
        itemsGrid.appendChild(makeSlot(li));
      }
    }
    // Wave 14 — refresh the 3D doll from the current local-player meta.
    // Idempotent on unchanged (setupId, mtableId, paletteId, subPalettes);
    // hot-swaps the rig when applyAppearance (entities.js:3846) has
    // updated the player's substitution set.
    refreshPaperdollViewport();
    // Burden rendering removed in Wave 13 — see status-indicators.js.
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

  // Wave 14 — if the local player isn't spawned yet at mount time (or
  // the inventory snapshot arrives before the entity instance), the
  // initial rebuild()'s refreshPaperdollViewport call is a no-op. Poll
  // until the player meta surfaces in the entity manager so the doll
  // appears as soon as the spawn completes. Stops after first successful
  // load (PaperdollViewport.loadPlayer remembers the load key).
  let viewportLoadTimer = null;
  function tryLoadViewport() {
    const lpg = (typeof window.getLocalPlayerGuid === "function")
      ? (window.getLocalPlayerGuid() >>> 0) : 0;
    if (lpg === 0) return false;
    const em = window.liveScene3d?.entityManager;
    const inst = em?.entityMap?.get?.(lpg);
    const setupId = (inst?.meta?.modelId ?? inst?.meta?.setupId ?? 0) >>> 0;
    if (setupId === 0) return false;
    refreshPaperdollViewport();
    return true;
  }
  if (!tryLoadViewport()) {
    viewportLoadTimer = setInterval(() => {
      if (tryLoadViewport()) {
        clearInterval(viewportLoadTimer);
        viewportLoadTimer = null;
      }
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

  // Wave 13: burden stats hooks removed (status-indicators.js owns the
  // burden indicator now). The MutationObserver on #inv-equipped /
  // #inv-pack already triggers rebuild() on every inventory delta.

  return () => {
    window.removeEventListener("keydown", onKey);
    delete window.__isInventoryItem;
    if (pollTimer) clearInterval(pollTimer);
    if (viewportLoadTimer) clearInterval(viewportLoadTimer);
    if (canvasEl) {
      canvasEl.removeEventListener("dragover", onCanvasDragOver);
      canvasEl.removeEventListener("drop", onCanvasDrop);
    }
    for (const o of observers) o.disconnect();
    // Wave 14 — release the WebGL context. Chrome caps live contexts
    // around 16; without this the inventory view can leak a context
    // per open/close cycle and eventually black-screen the doll.
    try { paperdollViewport.dispose(); } catch (_) {}
    overlay.remove();
  };
}
