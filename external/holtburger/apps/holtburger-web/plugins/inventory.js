// Right-side inventory window — port of retail gmInventoryUI (layout
// 0x21000023, 300x362) + gmPaperDollUI (layout 0x21000037, 800x600).
//
// Wave 16 audit: Wave 12 mistakenly read body-slot positions from
// LayoutDesc 0x21000024 (the 224×214 paperdoll-root that only carries
// frame chrome). The retail inventory paperdoll element forest actually
// lives in LayoutDesc 0x21000037 (800×600 "gmInventoryUI" — the
// inventory window's element template tree), which exposes all 24
// equipment slots PLUS their hint-icon image DIDs as direct top-level
// elements (each 32×32, IncorporationFlags 0x1E — Width/Height/ZLevel
// authoritative; X positions come from this plugin's hand-tuned table).
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
// Paperdoll has 24 slots total (per retail GetLocationInfoFromElementID
// at acclient.c:219835 + the Wave 16 survey of LayoutDesc 0x21000037):
// head/chest/abdomen/upper-arm/lower-arm/glove (HandWear)/upper-leg/
// lower-leg/foot armor; head/chest/upper-leg undershirts; necklace + 2
// bracelets + 2 rings (jewelry); cloak; weapon-ready + ammo-ready +
// shield-ready (the three "ReadySlot" hand slots); trinket; 3 Aetheria
// (SigilOne/Two/Three, hidden until the Aetheria Quest AetheriaBits
// attribute unlocks them). Wave 12 surveyed the wrong layout
// (0x21000024) and so missed WeaponReady (0x1000044B) / AmmoReady
// (0x1000044C) and conflated ShieldReady (0x1000044D, retail element
// in 0x21000037) with the layout-0x21000024 element 0x100001E1 — Wave
// 16 dedupes onto the canonical 0x21000037 elementIds.

import { setAcText } from "../ui/ac_font.js";
import { loadLayout, findElementById, getCachedLayout } from "../ui/ac_layout.js";
import { PaperdollViewport } from "../ui/ac_paperdoll_viewport.js";
import { fetchIconDataUrl as fetchIconDataUrlShared } from "../ui/ac_icon_cache.js";
// Side-effect import: installs window.__audioOptimistic for the
// optimistic inventory-action sound cues + server-echo dedupe ring.
import "./audio_optimistic.js";
// Wave D / PR13 (2026-06-06): side-effect import installs the
// recent-action Proxy on window.__sessionHandle + the kind:13 WeenieError
// subscription that synthesizes kind:48 inventoryActionFailed events.
// Also exposes window.__isBusy() for radial-menu.js Drop/Give/Split.
import "./rejection_feedback.js";
import {
  aetheriaSlotIsLocked,
  formatBurdenText,
  computeInventoryTitle,
  parseSlotsViewChecked,
  canEquipInSlot,
  buildPlayerEquipState,
} from "./inventory_helpers.js";

/** Retail LayoutDescs covering the inventory window.
 *
 *  - `gmInventoryUI` (0x21000023, 300×362) — outer-window children
 *    laying out the paperdoll area, bag column, items grid, title,
 *    and close button. Top-level element 0x100001CC.
 *  - `gmInventoryPaperdollElements` (0x21000037, 800×600) — body-slot
 *    element templates (24 entries) referenced by the inventory layout
 *    via element IDs 0x10000446-0x100005EA. Each top-level element
 *    here is a 32×32 template carrying a single child whose ImageDids
 *    list contains the per-slot hint icon DID (helmet/sword/ring/etc.
 *    silhouette). Per the Wave 16 layout-0x21000037 survey + the
 *    Wave-1 UI-port extraction of the 24 hint PNGs into
 *    data/ui-sprites/slot-hints/. The real burden indicator lives in
 *    `gmFloatyIndicatorsUI` 0x21000071 (status-indicators.js).
 *
 *  Per ElementDesc.element_id mapping (cross-checked against the Wave
 *  16 layout-0x21000037 dump + retail-anatomy validation):
 */
const INVENTORY_LAYOUT_ID = 0x21000023;
// LayoutDesc 0x21000037 holds the 24 paperdoll-slot ElementId templates
// (see PAPERDOLL_SLOTS' elemId column + hintIconDid extraction in
// data/ui-sprites/slot-hints/). Not loaded at runtime — its elements
// carry no positioning info (Wave 16 survey: IncorporationFlags 0x1E
// excludes the X bit on every entry), so applyInventoryLayout reads
// only the outer 0x21000023 region positions; PAPERDOLL_SLOTS' (x, y)
// columns are authoritative for body-slot positions.
// (PAPERDOLL_LAYOUT_ID = 0x21000037 — doc-only constant retired Wave 16)
const INV_ELEM_PAPERDOLL_AREA = 0x100001CD;
const INV_ELEM_BAG_COLUMN    = 0x100001CE;
const INV_ELEM_ITEMS_GRID    = 0x100001CF;


const OVERLAY_ID = "hb-inventory";
// Title bar is now owned by main-panel (see plugins/main-panel.js).
// TITLE_H = 0 hides the inline title-bar element since main-panel
// provides chrome; the other vertical offsets in the inventory CSS
// are inlined to retail values from LayoutDesc 0x21000023 (see
// data/retail-layouts/0x21000023.json — PaperDollField y=23,
// ThreeDItemsField y=237, BackpackField y=23 / h=339) so the cold
// open renders at retail proportions without a snap when
// loadLayout resolves and applyBox re-applies the same values.
const TITLE_H = 0;
const PAPERDOLL_W = 224;
const PAPERDOLL_H = 214;
const BAG_COL_W = 61;
const SLOT_SIZE = 32;
// P2-21 (cross-find inv-items-grid-cols): retail gmInventoryUI uses 6
// columns. Was 7. Hand-tuned to fit our 300px content frame minus
// 8px padding minus 16px bag column = 276/6 = 46px-wide cells with
// the 32×32 slot icon centered. The visible item grid feels tighter
// than retail at 7 cols.
const GRID_COLS = 6;

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
// the Wave 16 LayoutDesc 0x21000037 dump (24 top-level 32×32 element
// templates) + gmPaperDollUI::GetLocationInfoFromElementID at
// acclient.c:219835-219952 (retail equipMask mapping). Each entry's
// `hintIconDid` is the 0x06xxxxxx RenderSurface DID carried by the
// element's child ImageMedia in 0x21000037 — the per-slot "ghost"
// silhouette (helmet / sword / ring / etc.) that retail draws under
// the slot frame when the slot is empty. The 24 hint PNGs are
// extracted to data/ui-sprites/slot-hints/ via WB.Terminal's
// chorizite-extract-ui-textures command (see Phase 16.1).
//
// X+Y coords are the hand-tuned positions Wave 12 derived from the
// 224×214 paperdoll body anatomy (kept verbatim where the original
// 22 slots stayed); the 3 new ready-slot entries (WeaponReady /
// AmmoReady / ShieldReady) land in a bottom hand-row alongside Boots.
// retail layout 0x21000037 carries NO useful XY for these elements
// (IncorporationFlags 0x1E = X|Y|Width|Height, all values are
// 0,0,32,32 — template-only — and the canonical per-slot screen
// positions are computed at runtime in C++ by
// gmPaperDollUI::PaperDollLocation_GetPosFromLocationCode at
// acclient.c:219835-219952, not stored in the DAT). The hand-tuned
// coords below remain authoritative. (Earlier wave wording read the
// flags as "Y|W|H|ZLevel" — that was the pre-2026-05-30 buggy
// off-by-one bit gate in chorizite-dump-layout-tree; with the fix,
// 0x1E correctly resolves to X|Y|W|H but the practical conclusion
// — DAT has no positions — is unchanged.)
//
// Cross-validation 2026-05-30 vs retail-layouts/0x21000037.json:
// 24/24 PASS — every entry's elemId resolves to the expected
// ItemSlot_Equip_<role>, and every hintIconDid is reachable in the
// element's subtree. To re-verify, dump 0x21000037 with resolveSymbols
// and walk the elements/children for each (elemId, hintIconDid).
//
// The Aetheria slots (SigilOne/Two/Three) and TrinketOne are hidden
// by retail until the player completes the Aetheria Quest (per
// acclient.c:220154 gmPaperDollUI::UpdateAetheria — gates on
// PSetIntStat 0x142 AetheriaBits 0x1 / 0x2 / 0x4). We render them as
// dimmed slots for now; the visibility gating will be wired when the
// AetheriaBits arrives over the wire.
//
// EquipMask values cite ACE.Entity/Enum/EquipMask.cs (which matches
// the chorizite Chorizite.Common/Enums/EquipMask.cs verbatim) and the
// retail element_id table at acclient.c:219839-219951.
//
// Side values: 0 = both/center, 1 = LEFT, 2 = RIGHT
// (per acclient.h:4546-4552 UI_SLOT_SIDE_NULL=0, _LEFT=1, _RIGHT=2).
// Equipped items render in the slot whose equipMask bit matches
// `item.equipMask & slot.equipMask`.
const PAPERDOLL_SLOTS = [
  // Top-row chrome (left of head): Necklace + Trinket
  { elemId: "0x10000446", equipMask: 0x00008000, hintIconDid: 0x06000F68, x: 8,   y: 8,   name: "Necklace" },
  { elemId: "0x1000058F", equipMask: 0x04000000, hintIconDid: 0x06006A6C, x: 8,   y: 44,  name: "Trinket" },
  // Top-row chrome (right of head): 3 Aetheria slots (Blue/Yellow/Red).
  // Per acclient.c:220154 UpdateAetheria — these are SigilOne/Two/Three,
  // hidden until the player unlocks them via the Aetheria Quest at
  // levels 75/150/225 (wiki: "Inventory Panel" -> Equipment Slots -> Other).
  // `aetheriaBit` is the matching AetheriaBitfield mask (PropertyInt 322):
  // Blue=0x1, Yellow=0x2, Red=0x4. Wave D.1 follow-on (2026-05-27) reads
  // `handle.playerAetheriaBits` and applies the `.aetheria-locked` CSS
  // class to slots whose bit is unset, per ACBindings
  // `gmPaperDollUI.cs:217-222` (UpdateAetheria).
  { elemId: "0x10000592", equipMask: 0x10000000, hintIconDid: 0x06006BEF, x: 126, y: 8,   name: "Aetheria Blue",   aetheriaBit: 0x1 },
  { elemId: "0x10000593", equipMask: 0x20000000, hintIconDid: 0x06006BF0, x: 158, y: 8,   name: "Aetheria Yellow", aetheriaBit: 0x2 },
  { elemId: "0x10000594", equipMask: 0x40000000, hintIconDid: 0x06006BF1, x: 190, y: 8,   name: "Aetheria Red",    aetheriaBit: 0x4 },
  // Head + cloak row (mid-top)
  { elemId: "0x100005B4", equipMask: 0x00000001, hintIconDid: 0x06006D7F, x: 84,  y: 28,  name: "Head" },
  { elemId: "0x100005EA", equipMask: 0x08000000, hintIconDid: 0x0600708F, x: 192, y: 44,  name: "Cloak" },
  // Upper torso (chest armor + arm armor + chest under-shirt)
  { elemId: "0x100005B7", equipMask: 0x00000800, hintIconDid: 0x06006D87, x: 48,  y: 64,  name: "Upper arm" },
  { elemId: "0x100005B5", equipMask: 0x00000200, hintIconDid: 0x06006D7B, x: 84,  y: 64,  name: "Chest armor" },
  { elemId: "0x1000044E", equipMask: 0x00000002, hintIconDid: 0x060032C5, x: 192, y: 80,  name: "Shirt" },
  // Mid torso (lower arm + abdomen + wrist L/R)
  { elemId: "0x100005B8", equipMask: 0x00001000, hintIconDid: 0x06006D81, x: 48,  y: 100, name: "Lower arm" },
  { elemId: "0x100005B6", equipMask: 0x00000400, hintIconDid: 0x06006D79, x: 84,  y: 100, name: "Abdomen" },
  { elemId: "0x10000449", equipMask: 0x00020000, hintIconDid: 0x06000F6A, x: 8,   y: 80,  name: "Bracelet (R)" },
  { elemId: "0x10000447", equipMask: 0x00010000, hintIconDid: 0x06000F5D, x: 156, y: 80,  name: "Bracelet (L)" },
  // Upper legs + ring L/R + pants
  { elemId: "0x100005BA", equipMask: 0x00002000, hintIconDid: 0x06006D89, x: 120, y: 100, name: "Upper leg" },
  { elemId: "0x1000044F", equipMask: 0x00000040, hintIconDid: 0x060032C4, x: 192, y: 116, name: "Pants" },
  { elemId: "0x1000044A", equipMask: 0x00080000, hintIconDid: 0x06000F6B, x: 8,   y: 116, name: "Ring (R)" },
  { elemId: "0x10000448", equipMask: 0x00040000, hintIconDid: 0x06000F5A, x: 156, y: 116, name: "Ring (L)" },
  // Lower legs + gloves
  { elemId: "0x100005B9", equipMask: 0x00000020, hintIconDid: 0x06006D7D, x: 48,  y: 136, name: "Gloves" },
  { elemId: "0x100005BB", equipMask: 0x00004000, hintIconDid: 0x06006D83, x: 120, y: 136, name: "Lower leg" },
  // Bottom hand-ready row + Boots
  //   ShieldReady   (Shield bit 0x00200000) — Wave 12 had Shield at the
  //   same anchor with the old layout-0x21000024 elementId 0x100001E1;
  //   Wave 16 dedupes onto the canonical 0x21000037 element 0x1000044D.
  //   WeaponReady   (MeleeWeapon bit 0x00100000) — main-hand slot.
  //   AmmoReady     (MissileAmmo bit 0x00800000) — quiver/quarrel slot.
  { elemId: "0x1000044D", equipMask: 0x00200000, hintIconDid: 0x06000F6C, x: 8,   y: 172, name: "Shield" },
  { elemId: "0x1000044B", equipMask: 0x00100000, hintIconDid: 0x06000F66, x: 48,  y: 172, name: "Weapon" },
  { elemId: "0x100005BD", equipMask: 0x00000100, hintIconDid: 0x06006D85, x: 120, y: 172, name: "Boots" },
  { elemId: "0x1000044C", equipMask: 0x00800000, hintIconDid: 0x06000F5E, x: 156, y: 172, name: "Ammo" },
];

// The 9 body-armor slots that retail's "Slots" checkbox SWAPS with
// the 3D ragdoll figure (acclient.c:221700-221728). The two are
// mutually exclusive: when the checkbox is UNchecked (the default)
// retail shows the 3D paperdoll figure and hides these slot icons —
// the equipped armor renders directly on the figure ("ragdoll" view),
// so the player sees their character wearing the gear. When the
// checkbox is checked, the figure disappears and these icons take
// over so the player can interact with each armor slot directly
// (drag, swap, inspect) unimpeded by the figure. The 15 always-
// visible slots (jewelry, ready slots, shirt, pants, cloak, trinket,
// aetheria) stay shown in both modes — those don't render on the
// figure even in retail.
//
// CSS uses these via `.hb-inv-doll-slot.armor` (added in the slot
// creation loop): default `display: none`, overridden to visible
// when overlay has `.slots-view`. Same `.slots-view` selector also
// hides `.hb-inv-paperdoll-viewport` so the figure goes away.
const ARMOR_SLOT_ELEMIDS = new Set([
  "0x100005B4", // Head
  "0x100005B5", // Chest
  "0x100005B6", // Abdomen
  "0x100005B7", // Upper arm
  "0x100005B8", // Lower arm
  "0x100005B9", // Hand (Gloves)
  "0x100005BA", // Upper leg
  "0x100005BB", // Lower leg
  "0x100005BD", // Foot (Boots)
]);

// Wave D.1 follow-on (2026-05-27) — pure helpers (aetheriaSlotIsLocked,
// formatBurdenText, computeInventoryTitle) live in inventory_helpers.js
// so they can be unit-tested in Node without pulling three.js. The
// in-doMount() refresh functions below delegate to them; the unit tests
// at tests/inventory_paperdoll_helpers.test.cjs exercise them directly.

// Wave 15 — both paperdoll-slot AND items-grid cells route their icon
// fetches through the shared `ui/ac_icon_cache.js` cache so a fetch
// triggered in one plugin (vendor-ui, container-panel, etc.) is reused
// elsewhere on the next request. Also enables the opt-in
// `?preloadIcons=1` bulk-preload (4,224 icons via icon-manifest.json)
// to back this same cache. Local thin wrapper preserves the historical
// label so failure warnings still cite the inventory plugin.
async function fetchPaperdollIconDataUrl(iconId) {
  return fetchIconDataUrlShared(iconId, "inventory");
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
    /* Paperdoll area — equipped items positioned at body-slot positions.
       Retail PaperDollField (LayoutDesc 0x21000023): x=0, y=23, w=224, h=214. */
    #${OVERLAY_ID} .hb-inv-paperdoll {
      position: absolute;
      top: 23px;
      left: 0;
      width: ${PAPERDOLL_W}px;
      height: ${PAPERDOLL_H}px;
      pointer-events: auto;
    }
    /* P2-21 (cross-find inv-paperdoll-backdrop): retail's paperdoll
       background is flat (no gradient, no border) — the slot frame
       sprites already carry the brass anatomy. Dropped the radial-
       gradient + brass-dim border. */
    #${OVERLAY_ID} .hb-inv-paperdoll-bg {
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      background: transparent;
      z-index: 0;
    }
    /* P2-21 (cross-find inv-paperdoll-3d-doll): dim the 3D rig so the
       slot icons read first. Retail has no 3D ragdoll figure here —
       this is a Holtburger addition. opacity:0.25 keeps it visible
       enough to indicate equipped armor without distracting from
       slot interaction. */
    #${OVERLAY_ID} .hb-inv-paperdoll-viewport {
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      z-index: 1;
      pointer-events: none;
      opacity: 0.25;
    }
    #${OVERLAY_ID} .hb-inv-paperdoll-viewport canvas {
      display: block;
      width: 100%;
      height: 100%;
    }
    /* Each paperdoll body-slot — 28x28 brass-trim square positioned at
       the (x, y) from the PAPERDOLL_SLOTS table. Smaller than 32 to
       fit more slots in the 224x214 anatomy box. The per-slot hint
       icon (helmet/sword/ring silhouette from
       data/ui-sprites/slot-hints/0x06xxxxxx.png) is set via inline
       background-image during slot creation — see PAPERDOLL_SLOTS
       entries' hintIconDid field. Each PNG is the retail 32×32
       child-ImageMedia from LayoutDesc 0x21000037 and already
       includes the dark stone frame, so we DON'T layer a separate
       slot-bg image underneath. */
    /* P2-21 (cross-find inv-doll-slot-size + inv-doll-slot-opacity):
       slot size 28→32 (retail PAPERDOLL_SLOTS slot ImageMedia is 32×32);
       drop opacity:0.6 default — slots are fully opaque at rest. */
    body.hb-armed-item, body.hb-armed-item * { cursor: crosshair !important; }
    #${OVERLAY_ID} .hb-inv-slot.armed {
      box-shadow: 0 0 0 2px var(--hb-text-gold, #f0c060) inset;
    }
    #${OVERLAY_ID} .hb-inv-slot.armed::after {
      content: "i";
      position: absolute;
      top: 1px; right: 2px;
      font-family: var(--hb-font-serif, serif);
      font-size: 10px;
      color: var(--hb-text-gold, #f0c060);
      pointer-events: none;
    }
    #${OVERLAY_ID} .hb-inv-doll-slot {
      position: absolute;
      width: 32px;
      height: 32px;
      background-color: rgba(0, 0, 0, 0.4);
      background-size: 100% 100%;
      background-repeat: no-repeat;
      background-position: center;
      border: 1px solid var(--hb-border-brass-dim);
      image-rendering: pixelated;
      cursor: pointer;
      transition: filter 120ms ease;
      z-index: 2;
    }
    #${OVERLAY_ID} .hb-inv-doll-slot:hover { filter: brightness(1.3); }
    #${OVERLAY_ID} .hb-inv-doll-slot.equipped {
      opacity: 1;
      filter: drop-shadow(0 0 3px var(--hb-text-gold));
    }
    #${OVERLAY_ID} .hb-inv-doll-slot.drag-target {
      filter: drop-shadow(0 0 4px rgba(120, 220, 120, 0.9));
    }
    #${OVERLAY_ID} .hb-inv-doll-slot.drag-reject {
      filter: drop-shadow(0 0 4px rgba(220, 80, 80, 0.95));
      animation: hb-inv-drag-reject-flash 200ms ease-out;
    }
    @keyframes hb-inv-drag-reject-flash {
      0%   { background-color: rgba(180, 40, 40, 0.6); }
      100% { background-color: rgba(0, 0, 0, 0.4); }
    }
    #${OVERLAY_ID} .hb-inv-slot.reject {
      animation: hb-inv-source-reject 250ms ease-out;
    }
    @keyframes hb-inv-source-reject {
      0%   { box-shadow: 0 0 0 2px rgba(220, 80, 80, 0.95) inset; }
      100% { box-shadow: none; }
    }
    #${OVERLAY_ID} .hb-inv-doll-slot.speculative {
      border-color: var(--hb-text-gold, #f0c060);
    }
    #${OVERLAY_ID} .hb-inv-paperdoll-toast {
      position: absolute;
      left: 8px; right: 8px;
      bottom: 4px;
      padding: 3px 6px;
      font-family: var(--hb-font-serif, serif);
      font-size: 11px;
      background: rgba(20, 14, 8, 0.92);
      border: 1px solid var(--hb-border-brass-dim, #6a4f1c);
      text-align: center;
      pointer-events: none;
      opacity: 0;
      transition: opacity 120ms ease;
      z-index: 10;
    }
    #${OVERLAY_ID} .hb-inv-paperdoll-toast[data-show="1"] {
      opacity: 1;
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
    /* Retail BackpackField (LayoutDesc 0x21000023): x=239 (flush-right
       in 300-wide frame), y=23, w=61, h=339. */
    #${OVERLAY_ID} .hb-inv-bagcol {
      position: absolute;
      top: 23px;
      right: 0;
      width: ${BAG_COL_W}px;
      height: 339px;
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
    #${OVERLAY_ID} .hb-inv-bagtab.hb-inv-bagtab-drop-over {
      outline: 2px solid var(--hb-text-gold, #f0c060);
      outline-offset: -2px;
    }
    #${OVERLAY_ID} .hb-inv-bagtab.reject {
      animation: hb-inv-source-reject 400ms ease-out;
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
    /* Burden meter + label — retail gmBackpackUI's m_burdenMeter
       (UIElement_Meter, ACBindings gmBackpackUI.cs:102) and m_burdenText
       (UIElement_Text, gmBackpackUI.cs:101), updated in unison by
       SetLoadLevel(fNewLoad) (cs:151-156). Retail positions these at
       RUNTIME in C++ (not in LayoutDesc 0x21000023), so we follow the
       user's eye-witness retail anatomy: the meter sits at the right
       of the first pack tab — a thin vertical fill strip, ~6px wide
       (matching the dark inter-pack margin), aligned with the first
       pack's 28px height. The fill color ramps green→red as the
       playerBurden ratio rises from 0.0 to 3.0 (300% = full red);
       refreshBurdenText() writes the --burden-fill (0-100%) and
       --burden-color (hsl) custom properties. The numeric percent
       label sits below the bag tabs in the empty lower band of the
       bag column. Both are children of .hb-inv-bagcol so their
       absolute positions resolve inside that 61×339 box. */
    /* P1-30 (cross-find inv-burden-*): horizontal 3-cell row under the
       paperdoll — label | pct | bar. Was a 6x28 vertical strip on the
       bag column (overlapped the bag-tab meter) + a numeric label
       perched above. The new row sits in the previously-empty band at
       y=222 between the paperdoll body (ends y=204) and the items
       grid (starts y=237). */
    #${OVERLAY_ID} .hb-inv-burden-row {
      position: absolute;
      top: 222px;
      left: 6px;
      right: 73px;             /* clear the 61px bag column on the right */
      height: 14px;
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      font-size: 10px;
      z-index: 3;
      pointer-events: auto;
      user-select: none;
    }
    #${OVERLAY_ID} .hb-inv-burden-row .label {
      flex: 0 0 auto;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--hb-text-cream);
    }
    #${OVERLAY_ID} .hb-inv-burden-row .pct {
      flex: 0 0 38px;
      text-align: right;
      font-variant-numeric: tabular-nums;
      color: var(--hb-text-gold);
    }
    #${OVERLAY_ID} .hb-inv-burden-meter {
      flex: 1 1 auto;
      position: relative;
      height: 8px;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid var(--hb-border-brass-dim);
      overflow: hidden;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hb-inv-burden-meter::after {
      content: "";
      position: absolute;
      top: 0; bottom: 0; left: 0;
      width: var(--burden-fill, 0%);
      background: var(--burden-color, hsl(120, 70%, 45%));
      transition: width 0.18s ease-out, background 0.18s ease-out;
    }
    /* The .hb-inv-burden-text class is kept for the over-encumbered red
       tint cue (.over) on the wrapping row. Was a free-floating label
       above the bag column; now a no-op positional container — the row
       above does the layout work. */
    #${OVERLAY_ID} .hb-inv-burden-text {
      display: contents;
    }
    /* Over-encumbered cue — .over toggled on the row by
       refreshBurdenText(). Mirrored on .hb-inv-burden-text for any
       legacy consumers that still look up that class. */
    #${OVERLAY_ID} .hb-inv-burden-row.over,
    #${OVERLAY_ID} .hb-inv-burden-text.over { color: #ff8060; }
    #${OVERLAY_ID} .hb-inv-burden-row.over .pct,
    #${OVERLAY_ID} .hb-inv-burden-text.over .pct { color: #ff8060; }
    /* Aetheria-gated sigil slots — hidden when their AetheriaBitfield
       (PropertyInt 322) bit is unset. Port of retail
       gmPaperDollUI::UpdateAetheria (ACBindings gmPaperDollUI.cs:217-222).
       display:none keeps the slot fully invisible AND ineligible for
       drag-targeting (vs visibility:hidden which would still intercept
       events). */
    /* Locked aetheria slots — keep visible as gray placeholders (user
       feedback 2026-05-29: "there should be three"). Retail hid them
       until quest unlock, but we render them as faded slot frames so the
       player understands they exist and where they'll appear once
       unlocked. Lock icon overlay via :after. */
    /* P2-21 (cross-find inv-slots-toggle-presence): retail HIDES the
       aetheria slot frame entirely when the quest isn't unlocked
       (PropertyInt::AetheriaBitfield bit is 0). Prior impl showed a
       grayed-out lock icon — non-retail. */
    #${OVERLAY_ID} .hb-inv-doll-slot.aetheria-locked {
      display: none;
    }
    /* "Slots" toggle button — port of retail gmPaperDollUI::m_SlotCheckbox
       (ACBindings gmPaperDollUI.cs:134 + acclient.c:221636,221667,
       221698-221728 — retail element 0x100005BE, default unchecked).
       SWAPS between the 3D ragdoll figure and the 9 body-armor slot
       icons (see ARMOR_SLOT_ELEMIDS). Default (unchecked): viewport
       visible + armor icons hidden, ragdoll figure shows equipped
       armor visually. Checked: viewport hidden + armor icons visible,
       so each armor slot is clean and interactive. The 15
       always-visible slots (jewelry / ready / shirt / pants / cloak
       / trinket / aetheria) stay anchored in their anatomical
       positions in both modes.

       Anchored to the inventory overlay (NOT the paperdoll) so it sits
       on the burden-text row at y=222 (which retail-prop fix made
       overlap the empty bottom of paperdoll body — no slot conflict
       because the bottom Boots row ends at paperdoll-y=204), left of
       the bag column. Earlier wording mentioned a "28px gap between
       paperdoll bottom and items grid top" — retail has no such gap
       (both flush at y=237); the y=222 spot still works because the
       paperdoll has 15px of empty body area below the lowest slot row.
       Horizontal anchor is unchanged: clear of the bag column on the
       right, and the slots-toggle's 50px width starts at x=177 (=300 -
       BAG_COL_W - 12 - 50), well clear of the Aetheria Red top-row
       slot which ends at x=222. */
    #${OVERLAY_ID} .hb-inv-slots-toggle {
      position: absolute;
      top: 222px;
      right: ${BAG_COL_W + 12}px;
      width: 50px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 3px;
      padding: 0 4px;
      font-size: 9px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      background: rgba(10, 8, 4, 0.85);
      border: 1px solid var(--hb-border-brass);
      cursor: pointer;
      user-select: none;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      z-index: 5;
      pointer-events: auto;
    }
    #${OVERLAY_ID} .hb-inv-slots-toggle:hover {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
    #${OVERLAY_ID} .hb-inv-slots-toggle .check {
      width: 8px;
      height: 8px;
      border: 1px solid var(--hb-border-brass);
      background: rgba(0, 0, 0, 0.6);
      box-sizing: border-box;
    }
    #${OVERLAY_ID} .hb-inv-slots-toggle.checked .check {
      background: var(--hb-text-gold);
    }
    /* Slots view — retail's m_SlotCheckbox at acclient.c:221700-221728
       SWAPS between the 3D ragdoll figure and the 9 body-armor slot
       icons (Head, Chest, Abdomen, Upper/Lower arm, Hand, Upper/Lower
       leg, Foot). They're mutually exclusive: the figure carries the
       armor visual when it's there, and the armor icons take over
       (unimpeded by the figure) when the player wants to interact
       with each slot directly.

       Default (unchecked, "ragdoll" mode): viewport visible + armor
       icons hidden — equipped armor renders on the figure.
       Checked: viewport hidden + armor icons visible — the figure
       disappears so the slot icons are clean.

       In both modes the 15 always-visible slots (jewelry, ready,
       shirt, pants, cloak, trinket, aetheria) stay anchored at their
       anatomical positions around the paperdoll area, and the
       paperdoll-bg dark gradient frame stays as the container so the
       slot icons have a defined backdrop in slots-view. */
    #${OVERLAY_ID} .hb-inv-doll-slot.armor {
      display: none;
    }
    #${OVERLAY_ID}.slots-view .hb-inv-doll-slot.armor {
      display: block;
    }
    #${OVERLAY_ID}.slots-view .hb-inv-paperdoll-viewport {
      display: none;
    }
    /* Items grid — pack contents below the paperdoll. Retail LayoutDesc
       0x100001CF is 120px tall (gmInventoryUI 0x21000023). Wave 12 used
       top/bottom anchors which computed to 114px; Wave 13 switches to a
       fixed 120px height to match retail. */
    /* Retail ThreeDItemsField (LayoutDesc 0x21000023): x=0, y=237,
       w=234, h=120. Flush against paperdoll bottom (paperdoll ends at
       y=23+214=237). The 5px gap to the right of the items grid
       (234→239) is intentional retail breathing room before bagcol. */
    #${OVERLAY_ID} .hb-inv-items {
      position: absolute;
      top: 237px;
      left: 0;
      width: 234px;
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
    /* Examine pane occupies the same slot as the items grid (retail
       ThreeDItemsField x=0, y=237, w=234, h=120) — when toggled on
       via data-view="examine", items hides and examine takes over. */
    #${OVERLAY_ID} .hb-inv-examine {
      position: absolute;
      top: 237px;
      left: 0;
      width: 234px;
      height: 120px;
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

    /* Wave C / PR9 (2026-06-06): paperdoll slot equipped-state fade +
       magic halo + multi-state precedence + stack-count font consistency. */

    .hb-inv-doll-slot.equipped { background-image: none !important; transition: background-image 200ms ease-out; }

    .hb-inv-doll-slot.magic-glow::after {
      content: ""; position: absolute; inset: -3px; border-radius: 6px;
      pointer-events: none; box-shadow: 0 0 8px 2px rgba(80, 140, 255, 0.55);
      animation: hb-magic-pulse 1800ms ease-in-out infinite;
    }
    @keyframes hb-magic-pulse {
      0%, 100% { box-shadow: 0 0 6px 1px rgba(80, 140, 255, 0.45); }
      50%      { box-shadow: 0 0 12px 3px rgba(120, 170, 255, 0.75); }
    }

    /* Multi-state precedence: selected beats armed beats reject beats target
       beats hover. */
    .hb-inv-slot.hover       { outline: 1px solid rgba(240, 216, 160, 0.35); }
    .hb-inv-slot.drag-target { outline: 1px solid rgba(255, 200, 80, 0.7); z-index: 2; }
    .hb-inv-slot.drag-reject { outline: 1px solid rgba(255, 128, 128, 0.85); z-index: 3; }
    .hb-inv-slot.armed       { outline: 2px solid rgba(120, 200, 120, 0.85); z-index: 4; }
    .hb-inv-slot.selected    { outline: 2px solid rgba(240, 216, 160, 0.95); z-index: 5; }

    /* Stack-count font consistency between legacy <ul> grid + polymorphic grid */
    .hb-inv-slot .hb-inv-stack,
    #inv-pack li .stack {
      font-family: "AC", "Trebuchet MS", sans-serif;
      font-size: 11px; line-height: 12px;
      text-shadow: 0 1px 1px rgba(0,0,0,0.85);
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

// Apply retail layout to the inventory window — outer-window region
// positions from gmInventoryUI. Refs:
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
// Body-slot positions are hand-tuned per PAPERDOLL_SLOTS' (x, y).
// The retail layout that holds the slot ElementIds — LayoutDesc
// 0x21000037 — has IncorporationFlags 0x1E on every slot element
// (Y/Width/Height/ZLevel meaningful, X explicitly omitted) per the
// Wave 16 dump, so it carries 32×32 templates with no useful XY for
// positioning. Wave 16 therefore skips the paperdoll-layout load
// entirely; the slot ElemIds on PAPERDOLL_SLOTS still cite layout
// 0x21000037 for the hint-icon DID correspondence, but
// applySlotPositions is no longer invoked.
//
// Both layouts cache after the first call; re-mounts re-apply
// synchronously. Falls through silently if either layout fails to
// load — the hand-tuned defaults in CSS stay in effect.
function applyInventoryLayout(refs) {
  const apply = (inv) => {
    let appliedRegions = 0;

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

    try {
      window.__diag?.layout?.onInventoryApplied?.({
        appliedRegions,
        // Slot positions are hand-tuned (see PAPERDOLL_SLOTS docstring);
        // layout 0x21000037 carries no useful XY for the slot elements.
        slotUpdates: { updated: 0, missed: 0, source: "hand-tuned" },
        invLoaded: !!inv,
        dollLoaded: false,
      });
    } catch (_) {}
  };

  const cachedInv = getCachedLayout(INVENTORY_LAYOUT_ID);
  if (cachedInv) { apply(cachedInv); return; }
  loadLayout(INVENTORY_LAYOUT_ID).then(apply).catch(() => {});
}

function applyBox(el, layoutEl) {
  if (typeof layoutEl.x === "number") el.style.left = `${layoutEl.x}px`;
  if (typeof layoutEl.y === "number") el.style.top = `${layoutEl.y}px`;
  if (typeof layoutEl.width === "number") el.style.width = `${layoutEl.width}px`;
  if (typeof layoutEl.height === "number") el.style.height = `${layoutEl.height}px`;
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
  // Wave D.1 follow-on (2026-05-27) — track aetheria slots separately
  // so the AetheriaBits gating pass can address them by bit. Mirrors
  // retail's `m_sigilOneSlot`/`m_sigilTwoSlot`/`m_sigilThreeSlot`
  // direct references in `gmPaperDollUI::UpdateAetheria` (ACBindings
  // `gmPaperDollUI.cs:217-222`).
  const aetheriaSlotEls = [];
  for (const s of PAPERDOLL_SLOTS) {
    const el = document.createElement("div");
    el.className = "hb-inv-doll-slot";
    el.dataset.equipMask = String(s.equipMask);
    el.dataset.name = s.name;
    el.dataset.elemId = s.elemId;
    if (ARMOR_SLOT_ELEMIDS.has(s.elemId)) {
      // Hidden by default ("ragdoll" view = unchecked m_SlotCheckbox);
      // CSS reveals (and hides the 3D viewport) when .slots-view is on.
      el.classList.add("armor");
    }
    if (s.aetheriaBit) {
      el.dataset.aetheriaBit = String(s.aetheriaBit);
      aetheriaSlotEls.push({ el, bit: s.aetheriaBit >>> 0 });
    }
    el.style.left = `${s.x}px`;
    el.style.top = `${s.y}px`;
    // Wave 16 — per-slot hint icon (helmet / sword / ring / etc.
    // silhouette) drawn under any equipped item. Sourced from
    // data/ui-sprites/slot-hints/0xXXXXXXXX.png, extracted via
    // WB.Terminal's chorizite-extract-ui-textures from each retail
    // 0x21000037 element's child ImageMedia DID. Stored on the slot
    // dataset so placeEquippedInDoll can restore it on unequip.
    const hintDid = (s.hintIconDid >>> 0) || 0;
    if (hintDid) {
      const hintHex = "0x" + hintDid.toString(16).toUpperCase().padStart(8, "0");
      const hintUrl = `./data/ui-sprites/slot-hints/${hintHex}.png`;
      el.style.backgroundImage = `url("${hintUrl}")`;
      el.dataset.hintUrl = hintUrl;
    }
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
      overlay.dataset.draggingGuid = guid;
      // Wave C / PR9 (2026-06-06): iconId-driven 32x32 Image ghost so
      // the drag cursor reads as the item icon, not a styled slot box.
      // Source: the item's iconId from the inventory snapshot routed
      // through the existing icon cache.
      try {
        const item = getItemByGuid(parseInt(guid, 10) >>> 0);
        const iconDid = (item?.iconId >>> 0) || 0;
        if (iconDid && typeof window.__iconCache?.getUrl === "function") {
          const url = window.__iconCache.getUrl(iconDid);
          if (url) {
            const img = new Image();
            img.src = url;
            img.width = 32; img.height = 32;
            ev.dataTransfer.setDragImage(img, 16, 16);
          }
        }
      } catch (_) {}
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
      if (!ev.dataTransfer?.types?.includes("application/x-hb-inv-guid")) return;
      ev.preventDefault();
      // Reject feedback: validate the dragged item against this slot mask.
      const draggedGuid = (parseInt(overlay.dataset.draggingGuid, 10) >>> 0) || 0;
      const item = draggedGuid ? getItemByGuid(draggedGuid) : null;
      const playerState = buildPlayerEquipState(inventorySnapshot, {
        stance: (typeof window.__getCurrentStanceLow === "function" ? window.__getCurrentStanceLow() : 0) >>> 0,
        inCombatMode: !!window.__combatBarState?.inCombatMode,
      });
      const verdict = canEquipInSlot(item, s.equipMask >>> 0, playerState);
      if (!verdict.ok) {
        ev.dataTransfer.dropEffect = "none";
        el.classList.add("drag-reject");
        el.classList.remove("drag-target");
        setAcText(el.querySelector(".hb-inv-doll-tip"), verdict.reason, { color: "#ff8080" });
        return;
      }
      el.classList.remove("drag-reject");
      el.classList.add("drag-target");
      ev.dataTransfer.dropEffect = "move";
    });
    el.addEventListener("dragleave", () => {
      el.classList.remove("drag-target");
      el.classList.remove("drag-reject");
      setAcText(el.querySelector(".hb-inv-doll-tip"), s.name, { color: "#f0d8a0" });
    });
    // Paperdoll-slot double-click → unwield back to main pack.
    // Uses Wave A export handle.unwieldToPack; falls back to chat hint if
    // the wasm bundle predates Wave A.
    el.addEventListener("dblclick", (ev) => {
      if (ev.button !== 0) return;
      const guidStr = el.dataset.itemGuid;
      if (!guidStr) return;
      const guid = (parseInt(guidStr, 10) >>> 0) || 0;
      if (!guid) return;
      ev.preventDefault();
      ev.stopPropagation();
      const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
      // Wave C / PR10 (2026-06-06): optimistic UnwieldObject sound BEFORE
      // the wire send. The server-broadcast echo is suppressed via the
      // recent-fire ring in plugins/audio_optimistic.js. The Apply agent
      // applies the same pattern at the paperdoll drop site (wield = 0x8C)
      // and the grid double-click equip site in inventory.js.
      try { window.__audioOptimistic?.playOptimistic?.(0x8D, guid); } catch (_) {}
      if (typeof handle?.unwieldToPack === "function") {
        try { handle.unwieldToPack(guid); }
        catch (e) { console.warn("[paperdoll-dblclick] unwieldToPack failed:", e); }
      } else {
        const src = document.getElementById("chat-log");
        if (src) {
          const li = document.createElement("li");
          li.dataset.cat = "0"; li.className = "cat-0";
          li.textContent = "Cannot unwield: server build too old.";
          src.appendChild(li);
        }
      }
    });
    // Paperdoll right-click → polymorphic context menu.
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const guidStr = el.dataset.itemGuid;
      if (!guidStr) return;
      const guid = (parseInt(guidStr, 10) >>> 0) || 0;
      if (!guid) return;
      if (typeof window.__openContextMenuFor === "function") {
        try {
          window.__openContextMenuFor({
            source: "inv-paperdoll",
            guid,
            name: el.dataset.itemName || s.name,
            clientX: ev.clientX,
            clientY: ev.clientY,
          });
        } catch (e) { console.warn("[paperdoll-rc] context menu failed:", e); }
      }
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
      // Wave 1.D (2026-05-27): prefer `setWielded` (C# Character.cs:757-762
      // `SetWielded(weenie, slot)` naming). Falls back to legacy
      // `wieldFromPack` if the wasm pkg is pre-Wave-1.D so a stale build
      // doesn't break paperdoll wield.
      // Drop-time defensive re-validation. Stance can change mid-drag.
      const dropItem = getItemByGuid(guid);
      const dropState = buildPlayerEquipState(inventorySnapshot, {
        stance: (typeof window.__getCurrentStanceLow === "function" ? window.__getCurrentStanceLow() : 0) >>> 0,
        inCombatMode: !!window.__combatBarState?.inCombatMode,
      });
      const dropVerdict = canEquipInSlot(dropItem, s.equipMask >>> 0, dropState);
      if (!dropVerdict.ok) {
        try { paperdollToast(dropVerdict.reason); } catch (_) {}
        try {
          const srcSlot = overlay.querySelector(`.hb-inv-slot[data-guid="${String(guid)}"]`);
          if (srcSlot) {
            srcSlot.classList.add("reject");
            setTimeout(() => srcSlot.classList.remove("reject"), 250);
          }
        } catch (_) {}
        return;
      }
      // Speculative path (Wave A may not have populated validLocations yet).
      if (dropVerdict.speculative) {
        try { paperdollToast("Equipping speculatively (item attributes pending).", { speculative: true }); } catch (_) {}
      }
      if (handle?.setWielded) {
        try { window.__audioOptimistic?.playOptimistic?.(0x8C, guid); } catch (_) {}
        try { handle.setWielded(guid, s.equipMask >>> 0); }
        catch (e) { console.warn("[paperdoll] setWielded failed:", e); }
      } else if (handle?.wieldFromPack) {
        try { handle.wieldFromPack(guid, s.equipMask >>> 0); }
        catch (e) { console.warn("[paperdoll] wieldFromPack failed:", e); }
      }
    });
    paperdoll.appendChild(el);
    dollSlotEls[s.equipMask] = { el, icon, tip, slot: s };
  }

  overlay.appendChild(paperdoll);

  // m_SlotCheckbox port — "Slots" toggle button anchored to the
  // inventory overlay (NOT the paperdoll) in the y=222 band left of
  // the bag column. SWAPS between the 3D ragdoll figure and the 9
  // body-armor slot icons (ARMOR_SLOT_ELEMIDS): default-unchecked =
  // ragdoll visible + armor icons hidden; checked = ragdoll viewport
  // hidden + armor icons visible (unimpeded by the figure). The 15
  // always-visible slots (jewelry, ready, shirt, pants, cloak,
  // trinket, aetheria) stay shown in both modes; the paperdoll-bg
  // frame stays in both modes so slots have a defined backdrop.
  // State persists across mounts via localStorage so the player's
  // preference survives view swaps + page reloads.
  //
  // Mirrors retail gmPaperDollUI::m_SlotCheckbox (ACBindings
  // gmPaperDollUI.cs:134, retail wiring at acclient.c:221636 — child
  // 0x100005BE; default-unchecked via SetAttribute_Bool at :221667;
  // toggle dispatch at :221698-221728 hiding/showing 9 paperdoll
  // child elements — the same 9 armor slots). Our DOM-side equivalent
  // toggles the .slots-view class on the overlay; CSS hides the
  // viewport AND shows .hb-inv-doll-slot.armor accordingly.
  //
  // Reading-guide compliance (ACBindings/READING_GUIDE.md §5
  // anti-pattern #1): no retail element-ID constants are ported —
  // 0x100005BE is mentioned in the citation comment only, not used as
  // a runtime literal. Anti-pattern #5 (no UI framework port): we use
  // a plain <div> click target, not UIElement_Button, since the DOM
  // already provides hit-testing.
  const SLOTS_VIEW_STORAGE_KEY = "hb-inv.slots-view.checked.v1";
  let slotsViewChecked = false;
  try {
    slotsViewChecked = parseSlotsViewChecked(
      window.localStorage?.getItem?.(SLOTS_VIEW_STORAGE_KEY) ?? null
    );
  } catch (_) { slotsViewChecked = false; }

  const slotsToggle = document.createElement("div");
  slotsToggle.className = "hb-inv-slots-toggle";
  slotsToggle.title = "Toggle armor slot icons (default off — ragdoll shows armor visually)";
  const slotsCheckBox = document.createElement("span");
  slotsCheckBox.className = "check";
  const slotsLabel = document.createElement("span");
  slotsLabel.className = "slots-label";
  setAcText(slotsLabel, "Slots", { color: "#f0d8a0" });
  slotsToggle.appendChild(slotsCheckBox);
  slotsToggle.appendChild(slotsLabel);
  overlay.appendChild(slotsToggle);

  function applySlotsViewClass() {
    overlay.classList.toggle("slots-view", slotsViewChecked);
    slotsToggle.classList.toggle("checked", slotsViewChecked);
  }
  // Reflect persisted state immediately so the first frame matches
  // the user's last choice (avoids a flash of paperdoll on reload).
  applySlotsViewClass();

  slotsToggle.addEventListener("click", () => {
    slotsViewChecked = !slotsViewChecked;
    applySlotsViewClass();
    try {
      window.localStorage?.setItem?.(
        SLOTS_VIEW_STORAGE_KEY,
        slotsViewChecked ? "1" : "0",
      );
    } catch (_) { /* localStorage blocked → in-memory toggle only */ }
  });

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
      // Wave D.1 follow-on (2026-05-27) — port of retail
      // `gmInventoryUI::RecvNotice_NewParentContainer` (ACBindings
      // `gmInventoryUI.cs:218-223`): retitle the inventory window when
      // the active container changes. "Inventory of <player>" on main
      // pack; "Contents of <pack name>" on side pack.
      refreshPanelTitle();
    });
    // Wave D / PR11 (2026-06-06): bag-tab as drop target. Three cases:
    //   A) Container dropped on tab i (i>=1) -> moveItem(g, playerGuid, i)
    //      sets PlacementPosition (Container.cs:179 sort order).
    //   B) Non-container on a populated tab -> moveItem(g, containerId, 0)
    //      moves the item INTO the pack at that tab.
    //   C) Non-container on an empty tab -> 400ms .reject flash; no wire.
    tab.addEventListener("dragenter", (ev) => {
      if (ev.dataTransfer?.types?.includes("application/x-hb-inv-guid")
          || ev.dataTransfer?.types?.includes("text/x-hb-item-guid")) {
        ev.preventDefault();
        tab.classList.add("hb-inv-bagtab-drop-over");
      }
    });
    tab.addEventListener("dragover", (ev) => {
      if (ev.dataTransfer?.types?.includes("application/x-hb-inv-guid")
          || ev.dataTransfer?.types?.includes("text/x-hb-item-guid")) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
      }
    });
    tab.addEventListener("dragleave", () => {
      tab.classList.remove("hb-inv-bagtab-drop-over");
    });
    tab.addEventListener("drop", (ev) => {
      tab.classList.remove("hb-inv-bagtab-drop-over");
      const guidStr = ev.dataTransfer?.getData("application/x-hb-inv-guid")
        || ev.dataTransfer?.getData("text/x-hb-item-guid");
      if (!guidStr) return;
      ev.preventDefault();
      ev.stopPropagation();
      const sourceGuid = (parseInt(guidStr, 10) >>> 0);
      if (!sourceGuid) return;
      const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
      if (!handle || typeof handle.moveItem !== "function") return;
      const srcItem = getItemByGuid(sourceGuid);
      const srcIsContainer = !!srcItem && ((srcItem.itemType >>> 0) & ITEM_TYPE_CONTAINER) !== 0;
      const me = (typeof window.getLocalPlayerGuid === "function")
        ? (window.getLocalPlayerGuid() >>> 0) : 0;
      const slotData = bagSlots[i];
      // Case A: drop a container onto a tab — reorder via PlacementPosition.
      if (srcIsContainer && i >= 1 && me) {
        try { handle.moveItem(sourceGuid, me, i); }
        catch (e) { console.warn("[inv-bag-tab] reorder failed:", e); }
        return;
      }
      // Case B: non-container onto a populated tab -> into that pack.
      // For i=0 (main pack), substitute the player guid — slotData.containerId
      // is 0 there and ACE rejects moveItem with container_guid=0.
      if (!srcIsContainer && slotData) {
        const dest = (i === 0) ? me : (slotData.containerId >>> 0);
        if (!dest) return;
        try { handle.moveItem(sourceGuid, dest, 0); }
        catch (e) { console.warn("[inv-bag-tab] move-into failed:", e); }
        return;
      }
      // Case C: non-container onto an empty tab -> reject flash.
      tab.classList.add("reject");
      setTimeout(() => tab.classList.remove("reject"), 400);
    });
    bagCol.appendChild(tab);
    bagTabEls.push({ tabEl: tab, iconEl: tabIcon });
  }
  overlay.appendChild(bagCol);

  // Burden meter (icon) lives in plugins/status-indicators.js — the
  // retail `0x100000F7` indicator in gmFloatyIndicatorsUI 0x21000071.
  // Wave 12 had mistaken paperdoll element 0x100005BE for the burden
  // indicator; audit caught the mislabel.
  //
  // Burden meter + numeric label — retail gmBackpackUI's
  // m_burdenMeter (UIElement_Meter) + m_burdenText (UIElement_Text)
  // pair, updated together by SetLoadLevel(fNewLoad) in
  // ACBindings gmBackpackUI.cs:151-156. The meter is a thin vertical
  // fill strip positioned at the right of the first pack tab (size
  // matches the dark margin between pack tabs); fill color ramps
  // green → red across the 0..3.0 ratio (300% = max burden = full
  // red). The text shows the precise percentage. Both are children
  // of bagCol so absolute positions resolve inside the 61×339 box;
  // refreshBurdenText() below writes both. Reads from
  // `handle.playerBurden` (0.0..N float, encumbrance / capacity per
  // ACE EncumbranceSystem.GetBurden); refreshed on every
  // `playerStatsUpdated` event AND every rebuild() pass.
  // P1-30 (cross-find inv-burden-*): 3-cell horizontal row mounted
  // BELOW the paperdoll (y=222 in CSS), spanning the inventory width
  // up to the bag column. Avoids the bag-tab-meter overlap the prior
  // 6×28 vertical strip caused.
  const burdenRow = document.createElement("div");
  burdenRow.className = "hb-inv-burden-row";
  const burdenLabel = document.createElement("span");
  burdenLabel.className = "label";
  setAcText(burdenLabel, "Burden", { color: "#f0d8a0" });
  const burdenPct = document.createElement("span");
  burdenPct.className = "pct";
  setAcText(burdenPct, "—", { color: "#f0c060" });
  const burdenMeter = document.createElement("div");
  burdenMeter.className = "hb-inv-burden-meter";
  burdenRow.appendChild(burdenLabel);
  burdenRow.appendChild(burdenPct);
  burdenRow.appendChild(burdenMeter);
  overlay.appendChild(burdenRow);
  // Keep the .hb-inv-burden-text element around as the "over" CSS
  // hook; legacy code in refreshBurdenText toggles `.over` on it.
  // Now a `display: contents` shim that holds the same per-row state
  // tag without affecting layout.
  const burdenText = burdenRow; // alias — refreshBurdenText below toggles .over on this

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
    const guidStr = srcLi.dataset?.guid ?? "";
    slot.dataset.guid = guidStr;
    const tb = srcLi.dataset?.typeBit ?? "0x0";
    slot.dataset.typeBit = tb;
    const icon = document.createElement("div");
    icon.className = "hb-inv-icon";
    // TYPE_COLOR is the fallback while the real icon fetches (mirrors
    // vendor-ui.js:623-634's emoji-first/icon-on-resolve pattern). The
    // iconId arrives via the cached wasm snapshot — InventoryItem
    // (src/lib.rs:14185-14227) carries `iconId` per
    // `PublicWeenieDescription.icon_id`, so the items-grid path is
    // symmetric with the paperdoll slot at L974-981.
    icon.style.background = TYPE_COLOR[tb] || "#444";
    const item = guidStr ? getItemByGuid(guidStr) : null;
    // Resolution chain mirrors container-panel resolveItemMeta (commit
    // caf9d445): inventory snapshot → entityManager (PVS) → wasm icon
    // cache populated at ViewContents time. Helps when iconId is missing
    // from playerInventory() but cached separately.
    let iconId = (item?.iconId >>> 0) || 0;
    if (!iconId && guidStr) {
      const g = (parseInt(guidStr, 10) >>> 0);
      const em = window.liveScene3d?.entityManager;
      const ent = em?.entityMap?.get?.(g) || em?.entityMap?.get?.(String(g)) || null;
      iconId = ((ent?.meta?.iconId ?? ent?.iconId) >>> 0) || 0;
      if (!iconId) {
        const handle = window.__sessionHandle;
        iconId = (handle?.getObjectIconId?.(g) >>> 0) || 0;
      }
    }
    if (iconId) {
      fetchPaperdollIconDataUrl(iconId).then((url) => {
        // Skip if the slot has been swapped out or replaced mid-fetch
        // (rebuildItemsGrid wipes innerHTML on every inventory delta).
        if (!icon.isConnected) return;
        if (slot.dataset.guid !== guidStr) return;
        if (url) icon.style.background = `url("${url}") center/contain no-repeat`;
      });
    }
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
        ev.dataTransfer.setData("text/x-hb-item-guid", slot.dataset.guid);
        ev.dataTransfer.effectAllowed = "move";
        // Wave C / PR9 (2026-06-06): iconId-driven Image ghost (matches
        // the paperdoll-slot pattern). Replaces the prior DOM-element
        // ghost at line 1650 which read as a styled slot box.
        try {
          const item = getItemByGuid(parseInt(slot.dataset.guid, 10) >>> 0);
          const iconDid = (item?.iconId >>> 0) || 0;
          if (iconDid && typeof window.__iconCache?.getUrl === "function") {
            const url = window.__iconCache.getUrl(iconDid);
            if (url) {
              const img = new Image();
              img.src = url;
              img.width = 32; img.height = 32;
              ev.dataTransfer.setDragImage(img, 16, 16);
            }
          }
        } catch (_) {}
      });
    }
    // === Wave 5.C — tradeskill drag-end hook (2026-05-28) ===
    // Items-grid slots act as drop targets for any inventory item with
    // the application/x-hb-inv-guid mime. When the source GUID !=
    // the slot's own GUID, we emit `hb:inventory-item-on-item-drop`
    // (source + target are both items, never paperdoll/equip slots —
    // those route via the paperdoll drop handler at L929 instead).
    // Subscriber: plugins/tradeskill.js → useWithTarget(src, tgt).
    slot.addEventListener("dragenter", (ev) => {
      if (ev.dataTransfer?.types?.includes("application/x-hb-inv-guid")) {
        ev.preventDefault();
      }
    });
    slot.addEventListener("dragover", (ev) => {
      if (ev.dataTransfer?.types?.includes("application/x-hb-inv-guid")) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
      }
    });
    slot.addEventListener("drop", (ev) => {
      const guidStr = ev.dataTransfer?.getData("application/x-hb-inv-guid");
      if (!guidStr) return;
      ev.preventDefault();
      ev.stopPropagation();
      const sourceGuid = (parseInt(guidStr, 10) >>> 0);
      const targetGuid = (parseInt(slot.dataset.guid, 10) >>> 0);
      // Self-drop (e.g. re-arrange) is a no-op for tradeskill.
      if (!sourceGuid || !targetGuid || sourceGuid === targetGuid) return;
      try {
        window.dispatchEvent(new CustomEvent("hb:inventory-item-on-item-drop", {
          detail: {
            sourceGuid,
            targetGuid,
            sourceIsEquipSlot: false,
            targetIsEquipSlot: false,
          },
        }));
      } catch (_) {}
    });
    // Click dispatcher. Single LMB selects; ctrl-click or dblclick uses/equips/opens;
    // shift-click opens the context menu pre-armed for Split Stack; right-click hands off
    // to the polymorphic context menu. Legacy examine-on-single-click is gated behind
    // localStorage 'hb-inv.legacy-click-examine' = '1' for regression A/B.
    slot.addEventListener("click", (ev) => {
      if (ev.button !== 0) return;
      setSelected(srcLi);
      const guid = (parseInt(srcLi.dataset?.guid, 10) >>> 0) || 0;
      const name = srcLi.querySelector(".name")?.textContent || "Item";
      const item = getItemByGuid(guid);
      const legacy = (() => {
        try { return window.localStorage?.getItem?.("hb-inv.legacy-click-examine") === "1"; }
        catch (_) { return false; }
      })();
      // Dispatcher: dblclick (ev.detail >= 2) OR Ctrl-click → USE / EQUIP / OPEN.
      if ((ev.detail >= 2 || ev.ctrlKey) && guid) {
        const itemType = (item?.itemType >>> 0) || 0;
        const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
        // Container items open into a side panel rather than equipping.
        // Per ACE.Entity/Enum/ItemType.cs: Container = 0x00000200.
        if ((itemType & 0x00000200) !== 0) {
          try { window.__openContainerFor?.(guid, item?.name || name); }
          catch (_) { /* container plugin may be down */ }
          return;
        }
        const validLocs = (item?.validLocations >>> 0) || 0;
        if (validLocs && handle?.setWielded) {
          const mask = pickWieldSlotMask(validLocs);
          const playerState = buildPlayerEquipState(inventorySnapshot, {
            stance: window.__combatBarState?.stance,
            inCombatMode: !!window.__combatBarState?.inCombatMode,
          });
          const verdict = canEquipInSlot(item, mask >>> 0, playerState);
          if (verdict && verdict.ok === false) {
            try { paperdollToast(verdict.reason || "Cannot equip there."); } catch (_) {}
            try { srcLi.classList.add("reject"); setTimeout(() => srcLi.classList.remove("reject"), 250); } catch (_) {}
            return;
          }
          try { window.__audioOptimistic?.playOptimistic?.(0x8C, guid); } catch (_) {}
          try { handle.setWielded(guid, mask >>> 0); }
          catch (e) { console.warn("[inv-click] setWielded failed:", e); }
          return;
        }
        if (typeof handle?.useObject === "function") {
          try { handle.useObject(guid); }
          catch (e) { console.warn("[inv-click] useObject failed:", e); }
          return;
        }
        return;
      }
      // Shift-click → open context menu pre-focused on Split Stack so the
      // inline numeric prompt is the user's next click.
      if (ev.shiftKey && guid) {
        const count = (item?.stackSize >>> 0) || (item?.stackCount >>> 0) || 1;
        if (count > 1 && typeof window.__openContextMenuFor === "function") {
          try {
            window.__openContextMenuFor({
              source: "inv-grid",
              guid,
              srcLi,
              name,
              clientX: ev.clientX,
              clientY: ev.clientY,
              focusAction: "split",
            });
          } catch (e) { console.warn("[inv-click] split-via-menu failed:", e); }
          return;
        }
      }
      // Single LMB: SELECT only. Legacy users can opt back into examine-on-click.
      if (legacy) {
        if (typeof window.__showExamineFor === "function") {
          window.__showExamineFor(guid, { name, fromInventory: true, srcLi });
        } else {
          window.__mainPanel?.pushView?.("examine", { guid, name, fromInventory: true, srcLi });
        }
      }
    });
    // Right-click → polymorphic context menu. preventDefault so the
    // browser menu never shows; feature-detect __openContextMenuFor so the
    // legacy main-panel examine still works if the menu plugin isn't loaded.
    slot.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const guid = (parseInt(srcLi.dataset?.guid, 10) >>> 0) || 0;
      if (!guid) return;
      setSelected(srcLi);
      const name = srcLi.querySelector(".name")?.textContent || "Item";
      if (typeof window.__openContextMenuFor === "function") {
        try {
          window.__openContextMenuFor({
            source: "inv-grid",
            guid,
            srcLi,
            name,
            clientX: ev.clientX,
            clientY: ev.clientY,
          });
        } catch (e) { console.warn("[inv-click] context menu failed:", e); }
      }
    });
    // Wave C / PR9 (2026-06-06): Image-ghost path moved into the primary
    // dragstart above. Browsers honor the LAST setDragImage in the
    // dragstart event chain, so leaving this as a no-op preserves the
    // primary handler's iconId-driven ghost.
    // (intentionally empty — primary dragstart owns the ghost)
    return slot;
  }

  // Isolate a single-bit equip slot mask from a multi-bit ValidLocations
  // value, with explicit precedence mirroring retail acclient.c:220400
  // (gmPaperDollUI's WhichSlotForItem). A weapon that fits Melee + Held
  // resolves to Melee; a held caster that fits Held + TwoHanded resolves
  // to Held; rings/sigils fall through to lowest-set-bit. Pure function,
  // safe to call with 0 (returns 0).
  function pickWieldSlotMask(validLocations) {
    const v = (validLocations >>> 0) || 0;
    if (v === 0) return 0;
    // Single-bit fast path.
    if ((v & (v - 1)) === 0) return v;
    const PRECEDENCE = [
      0x00100000, // MeleeWeapon
      0x00200000, // Shield
      0x00400000, // MissileWeapon
      0x00800000, // MissileAmmo
      0x01000000, // Held
      0x02000000, // TwoHanded
      0x04000000, // TrinketOne
      0x08000000, // Cloak
      0x10000000, // Sigil Blue
      0x20000000, // Sigil Yellow
      0x40000000, // Sigil Red
    ];
    for (const bit of PRECEDENCE) {
      if ((v & bit) !== 0) return bit;
    }
    return v & -v; // lowest set bit
  }

  // Armed-item namespace. armedGuid is the current grid-armed item (a future addition may add
  // armedSpellId here). Backward-compat alias on window.__inventory_armedGuid
  // keeps old consumers working.
  if (!window.__inventory) window.__inventory = { armedGuid: 0 };
  function setArmedItem(guid) {
    const g = (guid >>> 0) || 0;
    window.__inventory.armedGuid = g;
    window.__inventory_armedGuid = g;
    try { document.body.classList.toggle("hb-armed-item", g !== 0); }
    catch (_) {}
    // Toggle the per-slot 'i' badge in this overlay; other panels read
    // the body class for the cursor change.
    try {
      overlay.querySelectorAll(".hb-inv-slot.armed").forEach((s) => s.classList.remove("armed"));
      if (g) {
        const sel = overlay.querySelector(`.hb-inv-slot[data-guid="${String(g)}"]`);
        if (sel) sel.classList.add("armed");
      }
    } catch (_) {}
  }
  window.__inventory.setArmedItem = setArmedItem;

  // Imports for slot-typing validation. Pure helpers; safe to call
  // before login (return ok with no info).
  // (canEquipInSlot/canBindToHotbar/buildPlayerEquipState live in
  //  inventory_helpers.js.)

  // Inline reject-feedback overlay anchored to the paperdoll, modelled
  // on vendor-ui.js:751. Auto-dismisses after 1500ms. NOT a global toast
  // bus — strictly scoped to the inventory overlay.
  function paperdollToast(text, opts) {
    if (!paperdoll) return;
    const speculative = !!opts?.speculative;
    let el = paperdoll.querySelector(".hb-inv-paperdoll-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "hb-inv-paperdoll-toast";
      paperdoll.appendChild(el);
    }
    setAcText(el, text, { color: speculative ? "#f0c060" : "#ff8080" });
    el.dataset.show = "1";
    clearTimeout(el._dismiss);
    el._dismiss = setTimeout(() => { el.dataset.show = "0"; }, 1500);
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
      // Wave D / PR11 (2026-06-06): enrich tooltip with (n/m) capacity
      // from the Wave A `containers_capacity` getter. Falls back to the
      // retail default of 24 for any container whose capacity field
      // hasn't propagated yet. n is computed from the snapshot by
      // counting items whose containerId matches this pack.
      const containerId = slot.containerId >>> 0;
      let cap = 24;
      let used = 0;
      if (containerId === 0) {
        // Main pack: count items at containerId 0 that aren't themselves
        // containers (those occupy the side-tab strip, not main-pack capacity).
        for (const it of inventorySnapshot) {
          if ((it.containerId >>> 0) !== 0) continue;
          if (((it.itemType >>> 0) & ITEM_TYPE_CONTAINER) !== 0) continue;
          used++;
        }
      } else {
        for (const it of inventorySnapshot) {
          if ((it.containerId >>> 0) === containerId) used++;
          if ((it.guid >>> 0) === containerId) {
            const c = (it.containersCapacity >>> 0) | 0;
            if (c > 0) cap = c;
          }
        }
      }
      tabEl.title = `${slot.name} (${used}/${cap})`;
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
  //
  // Wave D / PR11 (2026-06-06): containers (ItemType bit 0x200) surface
  // ONLY via the bag-tab strip; suppress them from the main-pack grid so
  // a side pack doesn't double-render (once as a slot, once as a tab).
  // The skip is gated on selectedPackContainerId === 0 — inside a side
  // pack a nested container would still render (rare, but legal).
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
      if (selectedPackContainerId === 0
          && item
          && ((item.itemType >>> 0) & ITEM_TYPE_CONTAINER) !== 0) {
        continue;
      }
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
      // Wave C / PR8 (2026-06-06): collect wielded-item descriptors so
      // the paperdoll renders weapons in-hand. Source of truth is the
      // wasm wielder_index (entityWieldedItems(playerGuid)); per-item
      // meta (setupId/mtableId/paletteId/subPalettes) comes from the
      // entity's own spawn meta in entityMap (populated by ObjectCreate).
      const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
      let wieldedItems = [];
      if (handle && typeof handle.entityWieldedItems === "function") {
        try {
          const raw = handle.entityWieldedItems(lpg) || [];
          for (const w of raw) {
            // Held items only (Selectable mask) — armor/ammo ride ObjDesc.
            if (((w.equipMask >>> 0) & 0x3700000) === 0) continue;
            const childInst = em?.entityMap?.get?.(w.guid >>> 0);
            if (!childInst?.meta) continue;
            wieldedItems.push({
              itemGuid: w.guid >>> 0,
              parentLocation: (typeof w.parentLocation === "number")
                ? (w.parentLocation >>> 0) : 0,
              placement: (typeof w.placement === "number")
                ? (w.placement >>> 0) : 0,
              meta: childInst.meta,
            });
          }
        } catch (_) { wieldedItems = []; }
      }
      const stanceLow = (typeof window.__getCurrentStanceLow === "function")
        ? (window.__getCurrentStanceLow() >>> 0) : 0;
      paperdollViewport.loadPlayer(
        setupId,
        (meta.mtableId ?? 0) >>> 0,
        (meta.paletteId ?? 0) >>> 0,
        meta.subPalettes ?? new Uint32Array(0),
        wieldedItems,
        stanceLow,
      ).then((ok) => {
        // 2026-05-29 — loadPlayer's "single render" can hit an empty
        // back-buffer when the panel was display:none at load time
        // (Three.js WebGLRenderer needs the canvas attached + sized).
        // Enable the rAF loop so the rig keeps re-rendering after the
        // panel becomes visible. Cost is negligible (224×214 transparent
        // canvas, 34 part-groups, no animation mixer).
        if (ok) paperdollViewport.start?.();
      }).catch(() => {});
    } catch (_) { /* viewport is best-effort */ }
  }

  // Wave D.1 follow-on (2026-05-27) — gating helper for the three
  // aetheria sigil slots. Ports retail `gmPaperDollUI::UpdateAetheria`
  // (ACBindings `gmPaperDollUI.cs:217-222`): each of the three slots
  // (Blue=0x1, Yellow=0x2, Red=0x4) is hidden when its bit is unset in
  // PropertyInt::AetheriaBitfield (322). The bitfield is exposed by
  // SessionHandle::playerAetheriaBits (lib.rs ~18105) — refreshed on
  // every `kind=8 playerStatsUpdated` drain by the recv loop's
  // `publish_player_stats_snapshot` block. `0` (pre-quest / pre-spawn)
  // hides all three slots, which matches retail behaviour for a fresh
  // character — the slots are revealed at levels 75/150/225 after the
  // Aetheria Quest unlocks each color (wiki: "Inventory Panel").
  function refreshAetheriaGating() {
    const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
    let bits = 0 >>> 0;
    try {
      if (handle && typeof handle.playerAetheriaBits === "number") {
        bits = handle.playerAetheriaBits >>> 0;
      } else if (handle && typeof handle.playerAetheriaBits === "function") {
        bits = (handle.playerAetheriaBits() | 0) >>> 0;
      }
    } catch (_) { bits = 0 >>> 0; }
    for (const { el, bit } of aetheriaSlotEls) {
      // Delegate to the pure helper so the bit-test logic stays
      // tested in lockstep (tests/inventory_paperdoll_helpers.test.cjs).
      el.classList.toggle("aetheria-locked", aetheriaSlotIsLocked(bits, bit));
    }
  }

  // Wave D.1 follow-on (2026-05-27) — port of retail
  // `gmBackpackUI::SetLoadLevel` (ACBindings `gmBackpackUI.cs:151-156`)
  // numeric-label leg: render the player's current burden as a
  // percentage. Reads `handle.playerBurden` (0.0..N float — under capacity
  // when <1.0, over-encumbered when >=1.0; mirrors ACE
  // `EncumbranceSystem.GetBurden`). Shows "—" pre-spawn / before any
  // stats hydration. Adds `.over` modifier when at or over capacity for
  // a red color cue (retail does the same with `m_burdenMeter` state
  // 4-5 swap, see status-indicators.js INDICATORS row "burden").
  function refreshBurdenText() {
    const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
    let burden = NaN;
    try {
      if (handle && typeof handle.playerBurden === "number") {
        burden = handle.playerBurden;
      } else if (handle && typeof handle.playerBurden === "function") {
        burden = handle.playerBurden();
      }
    } catch (_) { burden = NaN; }
    // Delegate to the pure helper so percent/rounding/cap-color logic
    // stays tested in lockstep (tests/inventory_paperdoll_helpers.test.cjs).
    const { text, over } = formatBurdenText(burden);
    setAcText(burdenPct, text, { color: over ? "#ff8060" : "#f0c060" });
    burdenText.classList.toggle("over", over);

    // Burden meter — vertical fill 0..100% across the 0..3.0 ratio
    // (300% burden = full red, per retail anatomy). Hue interpolates
    // from 120 (green) at 0% to 0 (red) at 300%. Clamps to [0, 3.0]
    // so over-300% (theoretically impossible per ACE encumbrance
    // caps, but defensive) stays fully red.
    if (Number.isFinite(burden) && burden > 0) {
      const clamped = Math.min(burden, 3.0);
      const fillPct = (clamped / 3.0) * 100;
      const hue = Math.max(120 - clamped * 40, 0);
      burdenMeter.style.setProperty("--burden-fill", `${fillPct}%`);
      burdenMeter.style.setProperty("--burden-color", `hsl(${hue}, 75%, 45%)`);
    } else {
      burdenMeter.style.setProperty("--burden-fill", `0%`);
      burdenMeter.style.setProperty("--burden-color", `hsl(120, 70%, 45%)`);
    }
  }

  // Wave D.1 follow-on (2026-05-27) — port of retail
  // `gmInventoryUI::RecvNotice_NewParentContainer` (ACBindings
  // `gmInventoryUI.cs:218-223`). When a side pack tab is selected the
  // panel title swaps to "Contents of <pack name>"; when the main pack
  // is selected it reverts to "Inventory of <player>". Driven by the
  // bag-tab click handler. Falls back to "Inventory" if neither the
  // main-panel nor the player name is available yet.
  function refreshPanelTitle() {
    // For the main-pack branch, reuse the view's nameFor() so the
    // title matches the one the main-panel registry sets on initial
    // mount (avoids drift between the two paths).
    let next;
    if (selectedPackContainerId !== 0) {
      next = computeInventoryTitle(selectedPackContainerId, bagSlots, null);
    } else {
      next = view.nameFor({});
    }
    try { window.__mainPanel?.setTitle?.(next); } catch (_) {}
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
    // Wave D.1 follow-on (2026-05-27): aetheria-slot visibility + numeric
    // burden readout + panel title. All three refresh on each rebuild
    // pass; the playerStatsUpdated bus event subscription below adds a
    // separate refresh for cases where stats change without a #inv-equipped
    // / #inv-pack DOM delta (Strength change → burden % shifts, etc.).
    refreshAetheriaGating();
    refreshBurdenText();
    refreshPanelTitle();
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

  // ESC clears any armed-item state (armed via menu "Use With" / shift-click).
  // Skip when focused on a text input so chat editing isn't intercepted.
  function onKey(ev) {
    if (ev?.key !== "Escape") return;
    const tag = ev.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if ((window.__inventory?.armedGuid >>> 0) !== 0) {
      setArmedItem(0);
    }
  }
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
    // Paperdoll slots use dataset.itemGuid; grid uses dataset.guid. Fall
    // back to closest() for elements that put the guid on an ancestor.
    const t = ev.target;
    const guid = t?.dataset?.itemGuid
      ?? t?.dataset?.guid
      ?? t?.closest?.("[data-item-guid]")?.dataset?.itemGuid
      ?? t?.closest?.("[data-guid]")?.dataset?.guid;
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
      try { window.__audioOptimistic?.playOptimistic?.(0x90, guid); } catch (_) {}
      try { handle.dropItem(guid); }
      catch (e) { console.warn("[paperdoll] dropItem failed:", e); }
    }
  }
  if (canvasEl) {
    canvasEl.addEventListener("dragover", onCanvasDragOver);
    canvasEl.addEventListener("drop", onCanvasDrop);
  }

  // Wave D.1 follow-on (2026-05-27): burden + aetheria-gating refresh
  // on the `playerStatsUpdated` bus event. Inventory deltas (kind=11)
  // already drive rebuild() via the MutationObserver on
  // #inv-equipped/#inv-pack, but pure stats deltas (kind=8) like a
  // Strength change can shift burden % without altering the
  // inventory DOM. Subscribing here keeps burden + aetheria visibility
  // live in those cases. Pattern matches buffs-hud.js + spellbook.js.
  let unsubscribeStats = null;
  try {
    const client = window.__pluginClient;
    if (client?.events?.on) {
      const onStats = () => {
        refreshBurdenText();
        refreshAetheriaGating();
      };
      client.events.on("playerStatsUpdated", onStats);
      unsubscribeStats = () => {
        try { client.events.off?.("playerStatsUpdated", onStats); } catch (_) {}
      };
    }
  } catch (_) { /* bus may not be initialized yet */ }

  // Wave C / PR8 (2026-06-06): rebuild the paperdoll when the wielder
  // state changes (kind=47 EntityDetached / kind=49 EntityAttached).
  // Coalesced via rAF so dual-wield swaps + bulk equip cause ONE
  // rebuild() per tick instead of N. The MutationObserver-driven
  // rebuild() already covers kind=11 inventory deltas; this hook adds
  // the wielder-property channel.
  let wieldedRebuildScheduled = false;
  function scheduleWieldedRebuild() {
    if (wieldedRebuildScheduled) return;
    wieldedRebuildScheduled = true;
    requestAnimationFrame(() => {
      wieldedRebuildScheduled = false;
      try { rebuild(); } catch (_) {}
    });
  }
  let unsubscribeAttach = null;
  let unsubscribeDetach = null;
  // Wave D / PR11 (2026-06-06): coalesce playerInventoryChanged-driven
  // rebuilds via microtask debounce so the MutationObserver tick AND the
  // bus event fire ONE rebuild per tick instead of two. Reuses
  // scheduleWieldedRebuild's rAF gate via a sibling scheduler.
  let inventoryRebuildScheduled = false;
  function scheduleInventoryRebuild() {
    if (inventoryRebuildScheduled) return;
    inventoryRebuildScheduled = true;
    queueMicrotask(() => {
      inventoryRebuildScheduled = false;
      try { rebuild(); } catch (_) {}
    });
  }
  let unsubscribeInventory = null;
  try {
    const client = window.__pluginClient;
    if (client?.events?.on) {
      client.events.on("kind:47", scheduleWieldedRebuild);
      client.events.on("kind:49", scheduleWieldedRebuild);
      client.events.on("playerInventoryChanged", scheduleInventoryRebuild);
      unsubscribeAttach = () => {
        try { client.events.off?.("kind:49", scheduleWieldedRebuild); } catch (_) {}
      };
      unsubscribeDetach = () => {
        try { client.events.off?.("kind:47", scheduleWieldedRebuild); } catch (_) {}
      };
      unsubscribeInventory = () => {
        try { client.events.off?.("playerInventoryChanged", scheduleInventoryRebuild); } catch (_) {}
      };
    }
  } catch (_) { /* bus may not be initialized yet */ }

  return () => {
    window.removeEventListener("keydown", onKey);
    delete window.__isInventoryItem;
    if (pollTimer) clearInterval(pollTimer);
    if (viewportLoadTimer) clearInterval(viewportLoadTimer);
    if (canvasEl) {
      canvasEl.removeEventListener("dragover", onCanvasDragOver);
      canvasEl.removeEventListener("drop", onCanvasDrop);
    }
    if (unsubscribeStats) unsubscribeStats();
    if (unsubscribeAttach) unsubscribeAttach();
    if (unsubscribeDetach) unsubscribeDetach();
    if (unsubscribeInventory) unsubscribeInventory();
    for (const o of observers) o.disconnect();
    // Wave 14 — release the WebGL context. Chrome caps live contexts
    // around 16; without this the inventory view can leak a context
    // per open/close cycle and eventually black-screen the doll.
    try { paperdollViewport.dispose(); } catch (_) {}
    overlay.remove();
  };
}
