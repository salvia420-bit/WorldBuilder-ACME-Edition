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

/** gmPaperDollUI — retail LayoutDesc that carries the body-slot Y
 *  coordinates the paperdoll uses. The X coords are NOT in this
 *  layout (retail computes them via parent-flow at runtime); we keep
 *  the hand-tuned X values from PAPERDOLL_SLOTS and override only Y. */
const PAPERDOLL_LAYOUT_ID = 0x21000024;


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

// Drive paperdoll body-slot (x, y) from gmPaperDollUI's LayoutDesc
// (DAT 0x21000024) once the layout is loaded. Each slot's
// `dataset.elemId` is the retail ElementDesc.element_id we look up.
//
// 2026-05-24 finding (paperdoll_layout_dump example): LayoutDesc
// carries BOTH x and y for every element — earlier in-code comment
// claiming "no X data is set" was incorrect. Retail's paperdoll
// places weapons in a top row at y=8 (sword, shield, wand, missile,
// necklace) above the body diagram which starts at the head slot
// (y=28). Both the prior hand-tuned X and Y values diverged from
// retail in non-obvious ways; switching to layout-driven values
// gives the authentic retail anatomy.
//
// Hand-tuned PAPERDOLL_SLOTS values stay in effect until the layout
// resolves (cached after first call — re-mounts are cheap). If the
// layout is unavailable or an element_id isn't in it (Aetheria
// 0x1000050E is missing from gmPaperDollUI — Throne-of-Destiny-era
// slot, post-dates this layout) the hand-tuned value persists.
function applyPaperdollLayoutY(dollSlotEls) {
  const apply = (layout) => {
    if (!layout) return;
    let updated = 0;
    let missed = 0;
    for (const slot of Object.values(dollSlotEls)) {
      const id = parseElementIdHex(slot.slot.elemId);
      const el = findElementById(layout, id);
      if (!el) { missed += 1; continue; }
      if (typeof el.x === "number") slot.el.style.left = `${el.x}px`;
      if (typeof el.y === "number") slot.el.style.top = `${el.y}px`;
      updated += 1;
    }
    try {
      window.__diag?.layout?.onPaperdollApplied?.({ updated, missed });
    } catch (_) {}
  };
  // Synchronous if already cached, else fire-and-forget the load.
  const cached = getCachedLayout(PAPERDOLL_LAYOUT_ID);
  if (cached) { apply(cached); return; }
  loadLayout(PAPERDOLL_LAYOUT_ID).then(apply).catch(() => {});
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
    paperdoll.appendChild(el);
    dollSlotEls[s.equipMask] = { el, icon, tip, slot: s };
  }
  overlay.appendChild(paperdoll);

  // Override Y coords from gmPaperDollUI LayoutDesc (DAT 0x21000024)
  // once it's loaded. Falls through silently if the layout isn't
  // available — the hand-tuned defaults render correctly either way.
  applyPaperdollLayoutY(dollSlotEls);

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
      e.icon.style.display = "none";
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
    matched.icon.style.display = "block";
    matched.icon.style.background = TYPE_COLOR[tb] || "#777";
    setAcText(matched.tip, `${item.name || matched.slot.name} — ${matched.slot.name}`, { color: "#f0d8a0" });
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
    // Burden meter: sum equipped item weights / capacity. The source
    // panel doesn't expose burden directly; once we have an event for
    // it we wire here. Static 0% for now.
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

  return () => {
    window.removeEventListener("keydown", onKey);
    delete window.__isInventoryItem;
    if (pollTimer) clearInterval(pollTimer);
    for (const o of observers) o.disconnect();
    overlay.remove();
  };
}
