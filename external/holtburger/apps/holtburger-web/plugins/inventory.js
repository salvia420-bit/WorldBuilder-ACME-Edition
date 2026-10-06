// Right-side inventory window — port of retail gmInventoryUI (layout
// 0x21000023, 300x362): gmPaperDollUI (0x21000024 frame + the 24 equip
// slots, positions from the retail render manifest m-24), gmBackpackUI
// (0x21000022: burden meter + main-pack slot + side-pack list) and
// gm3DItemsUI (the item grid of whichever container is open).
//
// HUD overhaul 2026-10-05 — rebuilt around the retail interaction model:
//
//   * Layout FITS the main-panel body (300×337 / 288×325 with the frame):
//     paperdoll 224×214 top-left, gmBackpackUI column 61 px flush right
//     (full height), item grid fills the rest and scrolls internally with
//     the rope scrollbar. Retail's layout coords are relative to a 362-tall
//     panel whose top 23 px are the title — main-panel draws that title,
//     so the raw 0x21000023 y-offsets are no longer applied (they pushed
//     the grid 25 px past the bottom: the "only 2.5 rows, no scrollbar" bug).
//   * Burden meter + percent moved back where retail has them: the top of
//     the backpack column (gmBackpackUI::SetLoadLevel, acclient.c:222634 —
//     meter full at 300 %, text floored). No more BURDEN/SLOTS overlap on
//     the paperdoll; the Slots checkbox sits at retail (42,190).
//   * Side packs are retail ItemSlot_Backpack cells with the open-container
//     arrow (0x06005D9C) and per-pack capacity bar (0x06004D22/23); empty
//     pack slots pad to ContainersCapacity; the list scrolls.
//   * Drag & drop goes through plugins/item_drag.js + the pure retail rules
//     in inventory_helpers.decideItemDrop (UIElement_ItemList::
//     AcceptDragObject, ItemHolder::AttemptToPlaceInContainer/AttemptMerge,
//     gmPaperDollUI::AcceptPaperDollDragObject). Moves are OPTIMISTIC: the
//     icon lands at once, ghosted (ItemSlot_Icon_Ghosted) until the server
//     echoes; a server refusal (InventoryServerSaveFailed) reverts it.
//   * The grid is a keyed diff/patch (cells are reused, only changed
//     attributes touched, reordered with insertBefore) — no innerHTML wipe
//     per inventory packet, so no flicker and a drag source never vanishes
//     mid-drag.
//   * A client-side PlacementPosition model (createPackOrder) keeps items
//     where the player put them — the wasm snapshot is name-sorted and
//     carries no placement yet (see the report's Rust patch).

import { setAcText } from "../ui/ac_font.js";
import { PaperdollViewport } from "../ui/ac_paperdoll_viewport.js";
import { fetchIconDataUrl as fetchIconDataUrlShared, getIconImmediate } from "../ui/ac_icon_cache.js";
import {
  uiEffectIconsEnabled,
  uiEffectIconsFor,
  uiEffectTintCss,
} from "../scene3d/vfx/ui_effects_registry.js";
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
  burdenMeterFraction,
  computeInventoryTitle,
  parseSlotsViewChecked,
  canEquipInSlot,
  buildPlayerEquipState,
  formatAppraisalTooltip,
  takeInventoryRows,
  rowUsesPackSlot,
  pickWieldSlotMask,
  createPackOrder,
  packCapacity,
  mergeAmount,
  DROP_TARGET,
  MAIN_PACK_KEY,
  PACKS_KEY,
  decideItemDrop,
} from "./inventory_helpers.js";
import {
  beginItemDrag,
  registerDropZone,
  resolveDropAction,
  executeItemAction,
  pendingOps,
  showItemTooltip,
  hideItemTooltip,
  localPlayerGuid,
} from "./item_drag.js";

/** Retail LayoutDescs covering the inventory window (documentation; the
 *  region boxes are now CSS — see the header note on the title offset).
 *    gmInventoryUI 0x21000023: PaperDollField 0x100001CD (0,23,224,214),
 *    BackpackField 0x100001CE (239,23,61,339), ThreeDItemsField
 *    0x100001CF (0,237,234,120). gmBackpackUI 0x21000022 children:
 *    Inv_BurdenTextBegin (0,7), Inv_BurdenText (0,18), Inv_BurdenBar
 *    (44,8,11,58), Inv_MainPackSlot (6,32,36,36), Inv_ContainerList
 *    (6,73,36,252) + its scrollbar (41,73,16,252). */
const OVERLAY_ID = "hb-inventory";
const PAPERDOLL_W = 224;
const PAPERDOLL_H = 214;
const BAG_COL_W = 61;
// Generic "Pack" icon (LSD weenie 70016 Icon DID) for the main-pack slot.
const MAIN_PACK_ICON = 0x06001BAF;
// Retail human defaults when the snapshot has not surfaced the property
// yet (ACE human weenie: ItemsCapacity 102, ContainersCapacity 7).
const DEFAULT_MAIN_CAP = 102;
const DEFAULT_PACKS_CAP = 7;
const SP = "./data/ui-sprites";

// Item-type-bit → placeholder tint while the real icon fetches.
const TYPE_COLOR = {
  0x1: "#7da6e0", 0x2: "#7dd9a0", 0x10000: "#c060ff", 0x40: "#f0c060",
};
function typeTint(itemType) {
  const t = (itemType >>> 0) || 0;
  const low = t & (~t + 1);
  return TYPE_COLOR[low] || "#3a3a40";
}

// Module-level so the player's arrangement and open pack survive closing
// and reopening the panel (retail keeps both on the client).
const packOrder = createPackOrder();
let lastSelectedPack = 0;

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
//
// validLocations contract (HUD rec #39 — D01 documentation):
//   (a) Each inventory item arrives with PropertyInt::ValidLocations
//       populated server-side. The field reaches the JS plugin via two
//       wires: SessionHandle.playerInventory() (initial snapshot at
//       login) and kind=11 playerInventoryChanged (per-item deltas).
//   (b) Server-side ACE MUST populate PropertyInt::ValidLocations for
//       every wieldable. A wieldable with vl=0 is treated as
//       "attributes pending" by canEquipInSlot — equip is rejected
//       for weapons (multi-bit collision risk, see rec #1/#2 fixes)
//       and speculative-ok'd for armor (single-bit slots).
//   (c) The `validLocations & slotMask` check is defensive: it rejects
//       multi-bit masks that would otherwise let a weapon equip into
//       any of MeleeWeapon | MissileWeapon | Held | TwoHanded without
//       a stable single-bit derivation. ACE Creature.TrySetChild
//       performs the same check server-side.
//   (d) Retail precedent: acclient decomp `GetLocationInfoFromElementID`
//       at acclient.c:173620 — the same single-bit assert applies.
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
  //   WeaponReady   — main-hand slot. Accepts ANY main-hand weapon type, not
  //     just melee: MeleeWeapon 0x00100000 | MissileWeapon 0x00400000 | Held
  //     0x01000000 (casters/wands) | TwoHanded 0x02000000 = 0x03500000. The
  //     old MeleeWeapon-only mask rejected bows/crossbows/atlatls and casters
  //     (canEquipInSlot: validLocations & slotMask == 0 → "cannot be worn in
  //     that slot"). Ammo still has its own slot below; Shield its own.
  //   AmmoReady     (MissileAmmo bit 0x00800000) — quiver/quarrel slot.
  //   HUD overhaul 2026-10-05: x positions corrected to the retail render
  //   manifest (m-24.json: Inv_ShieldReadySlot 8,172 / Inv_FootSlot
  //   120,172 / Inv_WeaponReadySlot 156,172 / Inv_AmmoReadySlot 190,172).
  //   The old table had Weapon at 48 and Ammo at 156; the freed (42,190)
  //   band is where retail's Paperdoll_Slots_Checkbox sits.
  { elemId: "0x1000044D", equipMask: 0x00200000, hintIconDid: 0x06000F6C, x: 8,   y: 172, name: "Shield" },
  { elemId: "0x1000044B", equipMask: 0x03500000, hintIconDid: 0x06000F66, x: 156, y: 172, name: "Weapon" },
  { elemId: "0x100005BD", equipMask: 0x00000100, hintIconDid: 0x06006D85, x: 120, y: 172, name: "Boots" },
  { elemId: "0x1000044C", equipMask: 0x00800000, hintIconDid: 0x06000F5E, x: 190, y: 172, name: "Ammo" },
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
    /* Inventory view — mounts inside main-panel's body slot (title +
       close are main-panel's). Every region is anchored to the body's
       edges so the view fits 300×337 and the framed 288×325 alike. */
    #${OVERLAY_ID} {
      position: absolute;
      inset: 0;
      box-sizing: border-box;
      overflow: hidden;
      pointer-events: auto;
      font-family: var(--hbk-font, var(--hb-font-serif));
      color: var(--hbk-text, var(--hb-text-cream));
      background: url("${SP}/0x06004D0A.png") center/cover no-repeat;
    }

    /* ── gmPaperDollUI (224×214, retail slot coords from m-24) ── */
    #${OVERLAY_ID} .hb-inv-paperdoll {
      position: absolute;
      left: 0; top: 0;
      width: ${PAPERDOLL_W}px; height: ${PAPERDOLL_H}px;
    }
    #${OVERLAY_ID} .hb-inv-paperdoll-viewport {
      position: absolute; inset: 0;
      z-index: 1;
      pointer-events: none;
      opacity: 0.25;
    }
    #${OVERLAY_ID} .hb-inv-paperdoll-viewport canvas { display: block; width: 100%; height: 100%; }
    #${OVERLAY_ID} .hb-inv-doll-slot {
      position: absolute;
      width: 32px; height: 32px;
      box-sizing: border-box;
      background-color: rgba(0, 0, 0, 0.4);
      background-size: 100% 100%;
      background-repeat: no-repeat;
      border: 1px solid rgba(78, 63, 31, 0.9);
      image-rendering: pixelated;
      cursor: pointer;
      z-index: 2;
    }
    #${OVERLAY_ID} .hb-inv-doll-slot:hover { filter: brightness(1.25); }
    #${OVERLAY_ID} .hb-inv-doll-slot.equipped { background-image: none !important; border-color: var(--hbk-gold-dim, #8a7544); }
    #${OVERLAY_ID} .hb-inv-doll-icon {
      position: absolute; inset: 0;
      background: transparent center / 100% 100% no-repeat;
      image-rendering: pixelated;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hb-inv-doll-slot.is-pending::before {
      content: ""; position: absolute; inset: 0; z-index: 3;
      background: url("${SP}/0x0600109A.png") center / 100% 100% no-repeat;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hb-inv-doll-slot.is-drag-source { opacity: 0.4; }
    /* Aetheria sigil slots are hidden until PropertyInt::AetheriaBitfield
       unlocks them (gmPaperDollUI::UpdateAetheria). */
    #${OVERLAY_ID} .hb-inv-doll-slot.aetheria-locked { display: none; }
    /* m_SlotCheckbox swaps the 3D figure for the nine armour slot icons
       (acclient.c:221698-221728); unchecked (default) = figure. */
    #${OVERLAY_ID} .hb-inv-doll-slot.armor { display: none; }
    #${OVERLAY_ID}.slots-view .hb-inv-doll-slot.armor { display: block; }
    #${OVERLAY_ID}.slots-view .hb-inv-paperdoll-viewport { display: none; }
    /* Retail Paperdoll_Slots_Checkbox at (42,190) — kit orb checkbox. */
    #${OVERLAY_ID} .hb-inv-slots-toggle {
      position: absolute;
      left: 44px; top: 190px;
      height: 14px;
      display: inline-flex; align-items: center; gap: 2px;
      z-index: 5;
      cursor: pointer;
      user-select: none;
    }
    #${OVERLAY_ID} .hb-inv-paperdoll-toast {
      position: absolute;
      left: 6px; right: 6px; bottom: 2px;
      padding: 3px 6px;
      font-size: 11px;
      background: rgba(20, 14, 8, 0.92);
      border: 1px solid var(--hbk-gold-deep, #4e3f1f);
      text-align: center;
      pointer-events: none;
      opacity: 0;
      transition: opacity 120ms ease;
      z-index: 10;
    }
    #${OVERLAY_ID} .hb-inv-paperdoll-toast[data-show="1"] { opacity: 1; }
    body.hb-armed-item, body.hb-armed-item * { cursor: crosshair !important; }
    #${OVERLAY_ID} .hb-inv-slot.armed { box-shadow: inset 0 0 0 2px rgba(120, 200, 120, 0.85); }

    /* ── gmBackpackUI column (61 px, retail 0x21000022 coords) ── */
    #${OVERLAY_ID} .hb-inv-bagcol {
      position: absolute;
      top: 0; right: 0; bottom: 0;
      width: ${BAG_COL_W}px;
      box-sizing: border-box;
      background: rgba(0, 0, 0, 0.28);
      border-left: 1px solid rgba(78, 63, 31, 0.8);
    }
    #${OVERLAY_ID} .hb-inv-burden-label,
    #${OVERLAY_ID} .hb-inv-burden-pct {
      position: absolute; left: 3px; width: 40px; height: 13px;
      overflow: hidden; white-space: nowrap;
    }
    #${OVERLAY_ID} .hb-inv-burden-label { top: 5px; }
    #${OVERLAY_ID} .hb-inv-burden-pct { top: 18px; }
    /* Inv_BurdenBar: 0x0600121D frame, 0x0600121C red→yellow→green fill
       revealed from the bottom (full = 300 %). */
    #${OVERLAY_ID} .hb-inv-burden-meter {
      position: absolute; left: 44px; top: 8px;
      width: 11px; height: 58px;
      background: url("${SP}/0x0600121D.png") center / 100% 100% no-repeat;
      image-rendering: pixelated;
    }
    #${OVERLAY_ID} .hb-inv-burden-meter > i {
      position: absolute; left: 0; right: 0; bottom: 0;
      height: var(--fill, 0%);
      background: url("${SP}/0x0600121C.png") center bottom / 11px 58px no-repeat;
      image-rendering: pixelated;
      transition: height 180ms ease-out;
    }
    #${OVERLAY_ID} .hb-inv-mainpack { position: absolute; left: 6px; top: 32px; }
    #${OVERLAY_ID} .hb-inv-packlist {
      position: absolute;
      left: 6px; top: 73px; bottom: 0;
      width: 54px;
      display: flex; flex-direction: column; align-items: flex-start;
    }
    /* ItemSlot_Backpack 36×36: icon in the 32×32 active region at (2,2),
       capacity bar ItemSlot_Icon_CapacityBar at icon (26,1) 5×30. */
    #${OVERLAY_ID} .hb-inv-bag {
      position: relative;
      flex: 0 0 36px;
      width: 36px; height: 36px;
      box-sizing: border-box;
      background: url("./sprites/acsprites/icon-slot-bg.png") 2px 2px / 32px 32px no-repeat;
      image-rendering: pixelated;
      cursor: pointer;
    }
    #${OVERLAY_ID} .hb-inv-bag.is-empty { opacity: 0.5; cursor: default; }
    #${OVERLAY_ID} .hb-inv-bag:not(.is-empty):hover { filter: brightness(1.2); }
    #${OVERLAY_ID} .hb-inv-bag > .hb-inv-bag-icon {
      position: absolute; left: 2px; top: 2px; width: 32px; height: 32px;
      background: transparent center / 100% 100% no-repeat;
      image-rendering: pixelated;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hb-inv-bag > .hb-inv-bag-cap {
      position: absolute; left: 28px; top: 3px; width: 5px; height: 30px;
      background: url("${SP}/0x06004D22.png") center / 100% 100% no-repeat;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hb-inv-bag > .hb-inv-bag-cap > i {
      position: absolute; left: 0; right: 0; bottom: 0;
      height: var(--cap, 0%);
      background: url("${SP}/0x06004D23.png") center bottom / 5px 30px no-repeat;
    }
    #${OVERLAY_ID} .hb-inv-bag.is-open::after {
      content: ""; position: absolute; inset: 0; z-index: 3;
      background: url("${SP}/0x06005D9C.png") center / 100% 100% no-repeat;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hb-inv-bag.is-pending::before {
      content: ""; position: absolute; left: 2px; top: 2px; width: 32px; height: 32px; z-index: 2;
      background: url("${SP}/0x0600109A.png") center / 100% 100% no-repeat;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hb-inv-bag.is-drag-source { opacity: 0.4; }

    /* ── gm3DItemsUI grid: fills the space under the paperdoll, left of
       the backpack column (retail ThreeDItemsField 234 wide), and scrolls
       with the rope scrollbar. ── */
    #${OVERLAY_ID} .hb-inv-items {
      position: absolute;
      left: 0; top: ${PAPERDOLL_H}px; right: ${BAG_COL_W + 5}px; bottom: 0;
      box-sizing: border-box;
      padding: 3px 2px;
      display: grid;
      grid-template-columns: repeat(auto-fill, 32px);
      grid-auto-rows: 32px;
      gap: 2px;
      align-content: start;
      background: rgba(0, 0, 0, 0.35);
      border-top: 1px solid var(--hbk-gold-deep, #4e3f1f);
    }
    #${OVERLAY_ID} .hb-inv-items.is-drop-target { outline-offset: -2px; }
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

// Inventory view — mounted inside main-panel's body slot. Returns
// a cleanup fn the container calls on view swap.
export const view = {
  name: "Inventory",
  nameFor: (_ctx) => {
    const sn = playerName();
    return sn ? `Inventory of ${sn}` : "Inventory";
  },
  mount: (parentEl, ctx) => doMount(parentEl, ctx),
};

function playerName() {
  return document.getElementById("char-name")?.textContent
    || window.__pluginClient?.player?.stats?.name
    || "";
}

function sessionHandleNow() {
  return window.__sessionHandle ?? window.__pluginClient?._handle ?? null;
}
function readHandleNumber(name) {
  const h = sessionHandleNow();
  try {
    if (typeof h?.[name] === "number") return h[name];
    if (typeof h?.[name] === "function") return Number(h[name]()) || 0;
  } catch (_) {}
  return 0;
}

// Armed-item namespace (shift-click "Use With" etc.). Module-level so
// hotbar.js's `window.__inventory.setArmedItem(0)` works whether or not
// the inventory view is mounted.
function setArmedItem(guid) {
  const g = (guid >>> 0) || 0;
  window.__inventory.armedGuid = g;
  window.__inventory_armedGuid = g;
  try { document.body.classList.toggle("hb-armed-item", g !== 0); } catch (_) {}
  try {
    document.querySelectorAll(`#${OVERLAY_ID} .hb-inv-slot.armed`).forEach((s) => s.classList.remove("armed"));
    if (g) document.querySelector(`#${OVERLAY_ID} .hb-inv-slot[data-guid="${g}"]`)?.classList.add("armed");
  } catch (_) {}
}

// Retail ItemList_OpenContainer from outside the view (container-panel's
// "Open" on one of the player's own packs, radial "Open").
let mountedApi = null;
function openPack(guid) {
  lastSelectedPack = (guid >>> 0) || 0;
  if (mountedApi) mountedApi.selectPack(lastSelectedPack);
  return true;
}

if (typeof window !== "undefined") {
  if (!window.__inventory) window.__inventory = { armedGuid: 0 };
  window.__inventory.setArmedItem = setArmedItem;
  window.__inventory.openPack = openPack;
  window.__inventory.selectedPack = () => lastSelectedPack;
}

// Inline note anchored to the paperdoll (speculative-equip notice).
function makePaperdollToast(paperdoll) {
  return function paperdollToast(text, opts) {
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
  };
}

function legacyLi(guid, fallback) {
  const g = String(guid >>> 0);
  return document.querySelector(`#inv-pack li[data-guid="${g}"], #inv-equipped li[data-guid="${g}"]`) || fallback;
}

function doMount(parentEl, _ctx) {
  ensureStyles();
  document.getElementById(OVERLAY_ID)?.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  // ── live data ────────────────────────────────────────────────────
  let rows = [];
  let rowsByGuid = new Map();
  let stubs = new Map();
  let orders = new Map();
  let orphanEquipped = [];
  let selectedPackContainerId = lastSelectedPack >>> 0;
  let selectedGuid = 0;

  function displayRow(guid) {
    const g = guid >>> 0;
    return rowsByGuid.get(g) || stubs.get(g) || null;
  }
  function withPack(row) { return row ? { ...row, isPack: rowUsesPackSlot(row) } : null; }
  function gridKey() { return selectedPackContainerId === 0 ? MAIN_PACK_KEY : selectedPackContainerId; }
  function mainCap() { return (readHandleNumber("playerItemsCapacity") >>> 0) || DEFAULT_MAIN_CAP; }
  function packsCap() { return (readHandleNumber("playerContainersCapacity") >>> 0) || DEFAULT_PACKS_CAP; }
  function capacityOf(key) { return packCapacity(rows, key, { mainCap: mainCap(), packsCap: packsCap() }); }

  // ── gmPaperDollUI ───────────────────────────────────────────────
  const paperdoll = document.createElement("div");
  paperdoll.className = "hb-inv-paperdoll";
  const paperdollToast = makePaperdollToast(paperdoll);
  // Wave 14 — 3D character doll viewport (retail gmPaperDollUI::
  // RedressCreature). Renders BEHIND the slot squares.
  const paperdollViewport = new PaperdollViewport({ width: PAPERDOLL_W, height: PAPERDOLL_H });
  const viewportWrap = document.createElement("div");
  viewportWrap.className = "hb-inv-paperdoll-viewport";
  viewportWrap.appendChild(paperdollViewport.dom);
  paperdoll.appendChild(viewportWrap);

  const dollSlotEls = {};
  const aetheriaSlotEls = [];
  for (const s of PAPERDOLL_SLOTS) {
    const el = document.createElement("div");
    el.className = "hb-inv-doll-slot";
    el.dataset.equipMask = String(s.equipMask);
    el.dataset.name = s.name;
    el.dataset.elemId = s.elemId;
    if (ARMOR_SLOT_ELEMIDS.has(s.elemId)) el.classList.add("armor");
    if (s.aetheriaBit) {
      el.dataset.aetheriaBit = String(s.aetheriaBit);
      aetheriaSlotEls.push({ el, bit: s.aetheriaBit >>> 0 });
    }
    el.style.left = `${s.x}px`;
    el.style.top = `${s.y}px`;
    // Per-slot hint silhouette (data/ui-sprites/slot-hints/, the child
    // ImageMedia of each 0x21000037 template), drawn while empty.
    const hintDid = (s.hintIconDid >>> 0) || 0;
    if (hintDid) {
      const hintHex = "0x" + hintDid.toString(16).toUpperCase().padStart(8, "0");
      el.style.backgroundImage = `url("./data/ui-sprites/slot-hints/${hintHex}.png")`;
    }
    const icon = document.createElement("div");
    icon.className = "hb-inv-doll-icon";
    el.appendChild(icon);
    el.addEventListener("mouseenter", () => {
      const nm = el.dataset.itemName;
      showItemTooltip(el, nm ? `${nm}\n${s.name}` : s.name);
    });
    el.addEventListener("mouseleave", hideItemTooltip);
    // Equipped item → drag source (to a pack, the grid, the world, the hotbar…).
    el.addEventListener("dragstart", (ev) => {
      const guid = (parseInt(el.dataset.itemGuid, 10) >>> 0) || 0;
      const row = guid ? rowsByGuid.get(guid) : null;
      if (!row) { ev.preventDefault(); return; }
      hideItemTooltip();
      beginItemDrag(ev, {
        guid, item: withPack(row), owned: true,
        sourceList: null, sourceIndex: -1, sourceEl: el,
      });
    });
    // Double-click → unwield back to the main pack.
    el.addEventListener("dblclick", (ev) => {
      if (ev.button !== 0) return;
      const guid = (parseInt(el.dataset.itemGuid, 10) >>> 0) || 0;
      if (!guid) return;
      ev.preventDefault();
      ev.stopPropagation();
      const h = sessionHandleNow();
      try { window.__audioOptimistic?.playOptimistic?.(0x8D, guid); } catch (_) {}
      if (typeof h?.unwieldToPack === "function") {
        try { h.unwieldToPack(guid); } catch (e) { console.warn("[paperdoll-dblclick] unwieldToPack failed:", e); }
      } else if (typeof h?.moveItem === "function" && localPlayerGuid()) {
        try { h.moveItem(guid, localPlayerGuid(), 0); } catch (_) {}
      }
    });
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const guid = (parseInt(el.dataset.itemGuid, 10) >>> 0) || 0;
      if (!guid || typeof window.__openContextMenuFor !== "function") return;
      try {
        window.__openContextMenuFor({
          source: "inv-paperdoll", guid,
          name: el.dataset.itemName || s.name,
          clientX: ev.clientX, clientY: ev.clientY,
        });
      } catch (e) { console.warn("[paperdoll-rc] context menu failed:", e); }
    });
    paperdoll.appendChild(el);
    dollSlotEls[s.equipMask] = { el, icon, slot: s };
  }

  // m_SlotCheckbox (retail Paperdoll_Slots_Checkbox 0x100005BE at
  // (42,190), default unchecked = 3D figure). Persisted per browser.
  const SLOTS_VIEW_STORAGE_KEY = "hb-inv.slots-view.checked.v1";
  let slotsViewChecked = false;
  try {
    slotsViewChecked = parseSlotsViewChecked(window.localStorage?.getItem?.(SLOTS_VIEW_STORAGE_KEY) ?? null);
  } catch (_) { slotsViewChecked = false; }
  const slotsToggle = document.createElement("label");
  slotsToggle.className = "hb-inv-slots-toggle hbk-label";
  slotsToggle.title = "Show the armour slots instead of the figure";
  const slotsCheck = document.createElement("input");
  slotsCheck.type = "checkbox";
  slotsCheck.className = "hbk-check";
  slotsCheck.checked = slotsViewChecked;
  const slotsLabel = document.createElement("span");
  setAcText(slotsLabel, "Slots", { color: "#e8dfc8" });
  slotsToggle.appendChild(slotsCheck);
  slotsToggle.appendChild(slotsLabel);
  paperdoll.appendChild(slotsToggle);
  function applySlotsViewClass() { overlay.classList.toggle("slots-view", slotsViewChecked); }
  applySlotsViewClass();
  slotsCheck.addEventListener("change", () => {
    slotsViewChecked = slotsCheck.checked;
    applySlotsViewClass();
    try { window.localStorage?.setItem?.(SLOTS_VIEW_STORAGE_KEY, slotsViewChecked ? "1" : "0"); } catch (_) {}
  });
  overlay.appendChild(paperdoll);

  // ── gmBackpackUI ────────────────────────────────────────────────
  const bagCol = document.createElement("div");
  bagCol.className = "hb-inv-bagcol";
  const burdenLabel = document.createElement("div");
  burdenLabel.className = "hb-inv-burden-label";
  setAcText(burdenLabel, "Burden", { color: "#e8dfc8" });
  const burdenPct = document.createElement("div");
  burdenPct.className = "hb-inv-burden-pct";
  setAcText(burdenPct, "—", { color: "#f3d27a" });
  const burdenMeter = document.createElement("div");
  burdenMeter.className = "hb-inv-burden-meter";
  burdenMeter.appendChild(document.createElement("i"));
  bagCol.append(burdenLabel, burdenPct, burdenMeter);

  function makeBagCell() {
    const cell = document.createElement("div");
    cell.className = "hb-inv-bag";
    const icon = document.createElement("div");
    icon.className = "hb-inv-bag-icon";
    const cap = document.createElement("div");
    cap.className = "hb-inv-bag-cap";
    cap.appendChild(document.createElement("i"));
    cell.append(icon, cap);
    cell._icon = icon;
    cell._cap = cap;
    cell._iconId = -1;
    return cell;
  }
  function setBagIcon(cell, iconId) {
    if (cell._iconId === iconId) return;
    cell._iconId = iconId;
    cell._icon.style.backgroundImage = "";
    if (!iconId) return;
    const hit = getIconImmediate(iconId);
    if (hit) { cell._icon.style.backgroundImage = `url("${hit}")`; return; }
    fetchPaperdollIconDataUrl(iconId).then((url) => {
      if (url && cell._iconId === iconId) cell._icon.style.backgroundImage = `url("${url}")`;
    });
  }
  function setBagCapacity(cell, used, cap) {
    const frac = cap > 0 ? Math.max(0, Math.min(1, used / cap)) : 0;
    cell._cap.style.display = cap > 0 ? "" : "none";
    cell._cap.firstChild.style.setProperty("--cap", `${Math.round(frac * 100)}%`);
  }

  // Inv_MainPackSlot.
  const mainSlot = makeBagCell();
  mainSlot.classList.add("hb-inv-mainpack");
  setBagIcon(mainSlot, MAIN_PACK_ICON);
  mainSlot.addEventListener("click", () => selectPack(0));
  mainSlot.addEventListener("mouseenter", () => {
    const c = capacityOf(MAIN_PACK_KEY);
    showItemTooltip(mainSlot, `Main Pack\n${c.used} / ${c.cap} items`);
  });
  mainSlot.addEventListener("mouseleave", hideItemTooltip);
  bagCol.appendChild(mainSlot);

  // Inv_ContainerList (+ rope scrollbar).
  const packList = document.createElement("div");
  packList.className = "hb-inv-packlist hbk-scroll";
  bagCol.appendChild(packList);
  overlay.appendChild(bagCol);
  const bagCache = new Map();

  function onBagEnter(ev) {
    const cell = ev.currentTarget;
    const g = (parseInt(cell.dataset.packGuid, 10) >>> 0) || 0;
    if (!g) { showItemTooltip(cell, "Empty pack slot"); return; }
    const row = displayRow(g);
    const c = capacityOf(g);
    showItemTooltip(cell, `${row?.name || "Pack"}\n${c.used} / ${c.cap || "?"} items`);
  }

  function renderBagColumn() {
    mainSlot.classList.toggle("is-open", selectedPackContainerId === 0);
    const mc = capacityOf(MAIN_PACK_KEY);
    setBagCapacity(mainSlot, mc.used, mc.cap);
    const packGuids = (orders.get(PACKS_KEY) || []).filter((g) => displayRow(g));
    const slots = Math.max(packsCap(), packGuids.length);
    const want = [];
    const used = new Set();
    packGuids.forEach((g, i) => {
      const key = "p" + g;
      let cell = bagCache.get(key);
      if (!cell) {
        cell = makeBagCell();
        cell.draggable = true;
        cell.addEventListener("click", () => {
          const pg = (parseInt(cell.dataset.packGuid, 10) >>> 0) || 0;
          if (pg) selectPack(pg);
        });
        cell.addEventListener("mouseenter", onBagEnter);
        cell.addEventListener("mouseleave", hideItemTooltip);
        cell.addEventListener("dragstart", (ev) => {
          const pg = (parseInt(cell.dataset.packGuid, 10) >>> 0) || 0;
          const row = rowsByGuid.get(pg);
          if (!row) { ev.preventDefault(); return; }
          hideItemTooltip();
          beginItemDrag(ev, {
            guid: pg, item: withPack(row), owned: true,
            sourceList: { key: PACKS_KEY, kind: "packs" },
            sourceIndex: (orders.get(PACKS_KEY) || []).indexOf(pg),
            sourceEl: cell,
          });
        });
        cell.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          const pg = (parseInt(cell.dataset.packGuid, 10) >>> 0) || 0;
          if (!pg || typeof window.__openContextMenuFor !== "function") return;
          try {
            window.__openContextMenuFor({
              source: "inv-grid", guid: pg, srcLi: legacyLi(pg, cell),
              name: displayRow(pg)?.name || "Pack", clientX: ev.clientX, clientY: ev.clientY,
            });
          } catch (_) {}
        });
        bagCache.set(key, cell);
      }
      const row = displayRow(g);
      cell.classList.remove("is-empty");
      cell.dataset.packGuid = String(g);
      cell.dataset.guid = String(g);
      cell.dataset.index = String(i);
      setBagIcon(cell, (row?.iconId >>> 0) || 0);
      const c = capacityOf(g);
      setBagCapacity(cell, c.used, c.cap);
      cell.classList.toggle("is-open", selectedPackContainerId === g);
      cell.classList.toggle("is-pending", pendingOps.has(g));
      want.push(cell);
      used.add(key);
    });
    for (let i = packGuids.length; i < slots; i++) {
      const key = "pe" + (i - packGuids.length);
      let cell = bagCache.get(key);
      if (!cell) {
        cell = makeBagCell();
        cell.classList.add("is-empty");
        cell.addEventListener("mouseenter", onBagEnter);
        cell.addEventListener("mouseleave", hideItemTooltip);
        bagCache.set(key, cell);
      }
      cell.dataset.index = String(i);
      setBagCapacity(cell, 0, 0);
      want.push(cell);
      used.add(key);
    }
    patchChildren(packList, want, bagCache, used);
  }

  // ── gm3DItemsUI grid ────────────────────────────────────────────
  const itemsGrid = document.createElement("div");
  itemsGrid.className = "hb-inv-items hbk-scroll";
  overlay.appendChild(itemsGrid);
  const cellCache = new Map();

  function setCellIcon(cell, row) {
    const iconId = (row.iconId >>> 0) || 0;
    if (cell._iconId === iconId) return;
    cell._iconId = iconId;
    const icon = cell._icon;
    icon.style.backgroundColor = "";
    icon.style.backgroundImage = "";
    if (!iconId) { icon.style.backgroundColor = typeTint(row.itemType); return; }
    const hit = getIconImmediate(iconId);
    if (hit) { icon.style.backgroundImage = `url("${hit}")`; return; }
    icon.style.backgroundColor = typeTint(row.itemType);
    fetchPaperdollIconDataUrl(iconId).then((url) => {
      if (!url || cell._iconId !== iconId) return;
      icon.style.backgroundColor = "";
      icon.style.backgroundImage = `url("${url}")`;
    });
  }
  function setCellStack(cell, n) {
    if (cell._stackN === n) return;
    cell._stackN = n;
    if (n > 1) {
      if (!cell._stack) {
        cell._stack = document.createElement("span");
        cell._stack.className = "hb-islot-stack hb-inv-stack";
        cell.appendChild(cell._stack);
      }
      setAcText(cell._stack, String(n), { color: "#ffffff" });
    } else if (cell._stack) {
      cell._stack.remove();
      cell._stack = null;
    }
  }
  function setCellEffects(cell, bits) {
    if (cell._fxBits === bits) return;
    cell._fxBits = bits;
    cell._fx?.remove();
    cell._fx = null;
    if (!bits || !uiEffectIconsEnabled()) return;
    // Track A A1: UiEffects (PropertyInt 18) magic badge(s); `?uiEffectIcons=off` escape.
    const fx = uiEffectIconsFor(bits);
    if (!fx.length) return;
    const wrap = document.createElement("span");
    wrap.className = "hb-islot-fx";
    for (const f of fx) {
      const dot = document.createElement("span");
      dot.title = f.name;
      dot.style.backgroundColor = uiEffectTintCss(f.tint) || "";
      wrap.appendChild(dot);
      if (f.iconDid) {
        fetchIconDataUrlShared(f.iconDid >>> 0).then((url) => {
          if (url && dot.isConnected) { dot.style.backgroundColor = ""; dot.style.backgroundImage = `url("${url}")`; }
        }).catch(() => {});
      }
    }
    cell._fx = wrap;
    cell.appendChild(wrap);
  }

  function makeItemCell() {
    const cell = document.createElement("div");
    cell.className = "hb-inv-slot hb-islot";
    const icon = document.createElement("div");
    icon.className = "hb-islot-icon";
    cell.appendChild(icon);
    cell._icon = icon;
    cell._iconId = -1;
    cell._stackN = 0;
    cell._fxBits = -1;
    cell.draggable = true;
    cell.addEventListener("dragstart", onCellDragStart);
    cell.addEventListener("click", onCellClick);
    cell.addEventListener("contextmenu", onCellContext);
    cell.addEventListener("mouseenter", onCellEnter);
    cell.addEventListener("mouseleave", onCellLeave);
    return cell;
  }
  function makeEmptyCell() {
    const cell = document.createElement("div");
    cell.className = "hb-inv-slot hb-islot is-empty";
    cell.dataset.empty = "1";
    return cell;
  }
  function updateItemCell(cell, e) {
    const g = String(e.guid);
    if (cell.dataset.guid !== g) {
      cell.dataset.guid = g;
      cell._iconId = -1;
    }
    cell.dataset.index = String(e.index);
    const tb = ((e.row.itemType >>> 0) & (~(e.row.itemType >>> 0) + 1)) >>> 0;
    cell.dataset.typeBit = "0x" + tb.toString(16);
    cell._name = e.row.name || "(unnamed)";
    setCellIcon(cell, e.row);
    let n = Math.max(1, e.row.stackSize | 0 || 1);
    if (e.pendingOp && (e.pendingOp.op === "split" || e.pendingOp.op === "merge" || e.pendingOp.op === "give"
        || e.pendingOp.op === "drop" || e.pendingOp.op === "wield") && e.pendingOp.amount < n) {
      n -= e.pendingOp.amount;
    }
    setCellStack(cell, n);
    setCellEffects(cell, (e.row.uiEffects >>> 0) || 0);
    cell.classList.toggle("is-selected", e.guid === selectedGuid);
    cell.classList.toggle("armed", e.guid === ((window.__inventory?.armedGuid >>> 0) || 0));
    cell.classList.toggle("is-pending", !!e.pending);
    cell.draggable = !e.row.stub;
  }

  function buildGridEntries() {
    const key = gridKey();
    const list = orders.get(key) || [];
    const entries = [];
    list.forEach((g, i) => {
      const row = displayRow(g);
      if (!row) return;
      const p = pendingOps.get(g);
      // A whole-stack wield in flight is drawn on the paperdoll, not here.
      if (p && p.op === "wield" && p.amount >= (row.stackSize || 1)) return;
      entries.push({ key: "g" + g, guid: g, row, index: i, pending: !!p || !!row.stub, pendingOp: p });
    });
    if (key === MAIN_PACK_KEY) {
      // Equipped items no paperdoll slot claims (unknown EquipMask) stay
      // visible in the main pack, after the ordered items.
      for (const r of orphanEquipped) {
        entries.push({ key: "g" + r.guid, guid: r.guid, row: r, index: list.length, pending: pendingOps.has(r.guid) });
      }
    }
    // ItemList_AddEmptySlot / UpdateEmptySlots: pad to the pack capacity
    // so the grid reads as a fixed-size pack (and every vacant cell is a
    // drop target). Unknown capacity → at least one spare row.
    const cap = capacityOf(key).cap;
    const count = entries.length;
    const target = cap > 0 ? Math.max(cap, count) : Math.max(18, Math.ceil((count + 6) / 6) * 6);
    for (let i = count; i < target; i++) entries.push({ key: "e" + (i - count), empty: true, index: list.length });
    return entries;
  }

  function renderGrid() {
    const entries = buildGridEntries();
    const want = [];
    const used = new Set();
    for (const e of entries) {
      let cell = cellCache.get(e.key);
      if (!cell) {
        cell = e.empty ? makeEmptyCell() : makeItemCell();
        cellCache.set(e.key, cell);
      }
      if (e.empty) cell.dataset.index = String(e.index);
      else updateItemCell(cell, e);
      want.push(cell);
      used.add(e.key);
    }
    patchChildren(itemsGrid, want, cellCache, used);
  }

  // Item-cell interaction (retail UIElement_ItemList::ListenToElementMessage:
  // click selects, double-click uses, right-click examines — here the
  // polymorphic context menu).
  function cellGuid(cell) { return (parseInt(cell?.dataset?.guid, 10) >>> 0) || 0; }
  function onCellDragStart(ev) {
    const cell = ev.currentTarget;
    const g = cellGuid(cell);
    const row = g ? rowsByGuid.get(g) : null;
    if (!row) { ev.preventDefault(); return; }
    hideItemTooltip();
    const key = gridKey();
    const list = orders.get(key) || [];
    const inList = list.indexOf(g);
    beginItemDrag(ev, {
      guid: g, item: withPack(row), owned: true,
      sourceList: (row.equipMask >>> 0) === 0 ? { key, kind: "inventory" } : null,
      sourceIndex: inList,
      sourceEl: cell,
    });
  }
  function setSelectedGuid(g) {
    selectedGuid = g >>> 0;
    for (const cell of cellCache.values()) {
      if (cell.dataset.empty) continue;
      cell.classList.toggle("is-selected", cellGuid(cell) === selectedGuid);
    }
  }
  function onCellClick(ev) {
    if (ev.button !== 0) return;
    const cell = ev.currentTarget;
    const g = cellGuid(cell);
    const row = displayRow(g);
    if (!g || !row || row.stub) return;
    setSelectedGuid(g);
    const name = row.name || "Item";
    if (ev.detail >= 2 || ev.ctrlKey) { useOrEquip(row, cell); return; }
    if (ev.shiftKey && (row.stackSize | 0) > 1 && typeof window.__openContextMenuFor === "function") {
      try {
        window.__openContextMenuFor({
          source: "inv-grid", guid: g, srcLi: legacyLi(g, cell), name,
          clientX: ev.clientX, clientY: ev.clientY, focusAction: "split",
        });
      } catch (e) { console.warn("[inv-click] split-via-menu failed:", e); }
      return;
    }
    let legacy = false;
    try { legacy = window.localStorage?.getItem?.("hb-inv.legacy-click-examine") === "1"; } catch (_) {}
    if (legacy) {
      if (typeof window.__showExamineFor === "function") {
        window.__showExamineFor(g, { name, fromInventory: true, srcLi: legacyLi(g, cell) });
      } else {
        window.__mainPanel?.pushView?.("examine", { guid: g, name, fromInventory: true, srcLi: legacyLi(g, cell) });
      }
    }
  }
  function onCellContext(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const cell = ev.currentTarget;
    const g = cellGuid(cell);
    const row = displayRow(g);
    if (!g || !row || row.stub) return;
    setSelectedGuid(g);
    if (typeof window.__openContextMenuFor === "function") {
      try {
        window.__openContextMenuFor({
          source: "inv-grid", guid: g, srcLi: legacyLi(g, cell), name: row.name || "Item",
          clientX: ev.clientX, clientY: ev.clientY,
        });
      } catch (e) { console.warn("[inv-click] context menu failed:", e); }
    }
  }
  function onCellEnter(ev) {
    const cell = ev.currentTarget;
    const g = cellGuid(cell);
    const name = cell._name || "";
    showItemTooltip(cell, name);
    // After the retail 250 ms m_tooltipDelay, upgrade to the cached
    // AppraisalProfile stats when the wasm has one.
    clearTimeout(cell._tipTimer);
    cell._tipTimer = setTimeout(() => {
      if (!cell.matches(":hover")) return;
      try {
        const h = sessionHandleNow();
        if (!g || typeof h?.getObjectAppraisal !== "function") return;
        const json = h.getObjectAppraisal(g);
        if (typeof json !== "string" || !json) return;
        const body = formatAppraisalTooltip(name, JSON.parse(json));
        if (body) showItemTooltip(cell, body);
      } catch (_) {}
    }, 250);
  }
  function onCellLeave(ev) {
    clearTimeout(ev.currentTarget._tipTimer);
    hideItemTooltip();
  }

  // Double-click / Ctrl-click: container → open, wieldable → equip,
  // tinkering tool → salvage panel, else UseObject (+ book follow-up).
  function useOrEquip(row, cell) {
    const g = row.guid >>> 0;
    const h = sessionHandleNow();
    if (rowUsesPackSlot(row)) {
      if ((row.containerId >>> 0) === 0) { selectPack(g); return; }
      try { window.__openContainerFor?.(g, row.name); } catch (_) {}
      return;
    }
    const validLocs = (row.validLocations >>> 0) || 0;
    // validLocations is 0 for weenies whose DB row lacks the property;
    // fall back to a sane slot per ItemType so double-click still equips.
    const it = (row.itemType >>> 0) || 0;
    const fallbackMask = (it & 0x1) ? 0x00100000 : (it & 0x100) ? 0x00400000 : (it & 0x10000) ? 0x01000000 : 0;
    const effectiveVL = validLocs || fallbackMask;
    if (effectiveVL && (h?.setWielded || h?.wieldFromPack) && (row.equipMask >>> 0) === 0) {
      const mask = pickWieldSlotMask(effectiveVL);
      const verdict = canEquipInSlot(row, mask >>> 0, equipState());
      if (verdict && verdict.ok === false) {
        paperdollToast(verdict.reason || "Cannot equip there.");
        try { window.__audioOptimistic?.playUiError?.(); } catch (_) {}
        cell?.classList.add("hb-server-rejected");
        setTimeout(() => cell?.classList.remove("hb-server-rejected"), 420);
        return;
      }
      const action = { op: "wield", guid: g, slotMask: mask >>> 0, amount: row.stackSize };
      executeItemAction(action, { guid: g, item: withPack(row), owned: true, sourceEl: cell });
      scheduleRebuild();
      return;
    }
    // R13: tinkering tool (IT_TINKERING_TOOL 0x20000000) opens salvage.
    if (((it & 0x20000000) !== 0) && typeof window.__openSalvagePanel === "function") {
      try { window.__openSalvagePanel(g); return; } catch (_) {}
    }
    if (typeof h?.useObject === "function") {
      try { h.useObject(g); } catch (e) { console.warn("[inv-click] useObject failed:", e); }
      // HUD rec #180: writable items (ItemType WRITABLE 0x2000) need an
      // explicit bookData follow-up.
      try { if ((it & 0x00002000) !== 0 && h.bookData) h.bookData(g); } catch (_) {}
    }
  }

  // ── packs / title ───────────────────────────────────────────────
  function selectPack(containerId) {
    const c = (containerId >>> 0) || 0;
    if (c !== 0 && !(orders.get(PACKS_KEY) || []).includes(c)) return;
    if (c === selectedPackContainerId) return;
    selectedPackContainerId = c;
    lastSelectedPack = c;
    itemsGrid.scrollTop = 0; // retail ScrollToHome on a new parent container
    renderBagColumn();
    renderGrid();
    refreshPanelTitle();
  }

  // gmInventoryUI::RecvNotice_NewParentContainer: "Inventory of <player>"
  // on the main pack, "Contents of <pack>" on a side pack.
  function refreshPanelTitle() {
    let next;
    if (selectedPackContainerId !== 0) {
      const packs = (orders.get(PACKS_KEY) || []).map((g) => ({ containerId: g, name: displayRow(g)?.name || "" }));
      next = computeInventoryTitle(selectedPackContainerId, packs, null);
    } else {
      next = view.nameFor({});
    }
    try { window.__mainPanel?.setTitle?.(next); } catch (_) {}
  }

  // ── paperdoll state ─────────────────────────────────────────────
  function clearPaperdoll() {
    for (const k of Object.keys(dollSlotEls)) {
      const e = dollSlotEls[k];
      e.el.classList.remove("equipped", "is-pending");
      delete e.el.dataset.itemGuid;
      delete e.el.dataset.itemName;
      delete e.el.dataset.guid;
      e.el.draggable = false;
      e.icon.style.backgroundImage = "";
      e.icon.dataset.iconId = "";
    }
  }
  function dollSlotFor(mask) {
    const m = mask >>> 0;
    if (!m) return null;
    for (const k of Object.keys(dollSlotEls)) {
      if ((m & (Number(k) >>> 0)) !== 0) return dollSlotEls[k];
    }
    return null;
  }
  function showInDoll(slotEntry, row, pending) {
    const el = slotEntry.el;
    const g = String(row.guid >>> 0);
    el.classList.add("equipped");
    el.classList.toggle("is-pending", !!pending);
    el.dataset.itemGuid = g;
    el.dataset.guid = g;
    el.dataset.itemName = row.name || slotEntry.slot.name;
    el.draggable = !pending;
    const iconId = (row.iconId >>> 0) || 0;
    if (slotEntry.icon.dataset.iconId === String(iconId)) return;
    slotEntry.icon.dataset.iconId = String(iconId);
    const hit = iconId ? getIconImmediate(iconId) : null;
    if (hit) { slotEntry.icon.style.backgroundImage = `url("${hit}")`; return; }
    if (!iconId) return;
    fetchPaperdollIconDataUrl(iconId).then((url) => {
      if (url && el.dataset.itemGuid === g) slotEntry.icon.style.backgroundImage = `url("${url}")`;
    });
  }
  function placeEquippedInDoll(row) {
    const slotEntry = dollSlotFor(row.equipMask);
    if (!slotEntry) return false;
    const p = pendingOps.get(row.guid);
    // An equipped item being moved / dropped / given away waits ghosted.
    const leaving = !!p && p.op !== "wield";
    if (leaving && p.op === "move" && p.toKey != null && !p.external) return true; // drawn in the grid
    showInDoll(slotEntry, row, leaving);
    return true;
  }
  function applyPendingWieldsToDoll() {
    for (const e of pendingOps.all()) {
      if (e.op !== "wield" || !e.slotMask) continue;
      const row = displayRow(e.guid);
      if (!row || (row.equipMask >>> 0) !== 0) continue;
      const slotEntry = dollSlotFor(e.slotMask);
      if (slotEntry) showInDoll(slotEntry, row, true);
    }
  }

  function equipState() {
    return buildPlayerEquipState(rows, {
      stance: (typeof window.__getCurrentStanceLow === "function" ? window.__getCurrentStanceLow() : 0) >>> 0,
      inCombatMode: !!window.__combatBarState?.inCombatMode,
    });
  }

  // Wave 14 — load / refresh the 3D doll from the local player's meta
  // (setup, palettes, wielded held items). loadPlayer is idempotent.
  function refreshPaperdollViewport() {
    try {
      const lpg = localPlayerGuid();
      if (!lpg) return;
      const em = window.liveScene3d?.entityManager;
      const meta = em?.entityMap?.get?.(lpg)?.meta;
      if (!meta) return;
      const setupId = (meta.modelId ?? meta.setupId ?? 0) >>> 0;
      if (!setupId) return;
      const h = sessionHandleNow();
      let wieldedItems = [];
      if (typeof h?.entityWieldedItems === "function") {
        try {
          for (const w of (h.entityWieldedItems(lpg) || [])) {
            if (((w.equipMask >>> 0) & 0x3700000) === 0) continue;
            const childInst = em?.entityMap?.get?.(w.guid >>> 0);
            if (!childInst?.meta) continue;
            wieldedItems.push({
              itemGuid: w.guid >>> 0,
              parentLocation: (typeof w.parentLocation === "number") ? (w.parentLocation >>> 0) : 0,
              placement: (typeof w.placement === "number") ? (w.placement >>> 0) : 0,
              meta: childInst.meta,
            });
          }
        } catch (_) { wieldedItems = []; }
      }
      const stanceLow = (typeof window.__getCurrentStanceLow === "function") ? (window.__getCurrentStanceLow() >>> 0) : 0;
      paperdollViewport.loadPlayer(
        setupId,
        (meta.mtableId ?? 0) >>> 0,
        (meta.paletteId ?? 0) >>> 0,
        meta.subPalettes ?? new Uint32Array(0),
        wieldedItems,
        stanceLow,
      ).then((ok) => { if (ok) paperdollViewport.start?.(); }).catch(() => {});
    } catch (_) { /* viewport is best-effort */ }
  }

  // gmPaperDollUI::UpdateAetheria — hide the sigil slots whose
  // AetheriaBitfield (PropertyInt 322) bit is unset.
  function refreshAetheriaGating() {
    const bits = (readHandleNumber("playerAetheriaBits") | 0) >>> 0;
    for (const { el, bit } of aetheriaSlotEls) el.classList.toggle("aetheria-locked", aetheriaSlotIsLocked(bits, bit));
  }

  // gmBackpackUI::SetLoadLevel.
  function refreshBurden() {
    let burden = NaN;
    const h = sessionHandleNow();
    try {
      if (typeof h?.playerBurden === "number") burden = h.playerBurden;
      else if (typeof h?.playerBurden === "function") burden = h.playerBurden();
    } catch (_) { burden = NaN; }
    const { text, over } = formatBurdenText(burden);
    setAcText(burdenPct, text, { color: over ? "#ff8060" : "#f3d27a" });
    burdenMeter.firstChild.style.setProperty("--fill", `${(burdenMeterFraction(burden) * 100).toFixed(1)}%`);
    burdenMeter.title = over ? `Burden ${text} — over capacity` : `Burden ${text}`;
  }

  // ── rebuild ─────────────────────────────────────────────────────
  function buildGroups() {
    const groups = new Map([[MAIN_PACK_KEY, []], [PACKS_KEY, []]]);
    for (const r of rows) {
      if ((r.equipMask >>> 0) === 0 && (r.containerId >>> 0) === 0 && rowUsesPackSlot(r)) groups.set(r.guid, []);
    }
    const push = (key, row) => {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    };
    for (const r of rows) {
      const p = pendingOps.get(r.guid);
      const optimistic = p && p.op === "move" && p.toKey !== null && p.toKey !== undefined && !p.external;
      if ((r.equipMask >>> 0) !== 0) {
        if (optimistic) push(p.toKey, r);
        continue;
      }
      let key = (r.containerId >>> 0) ? (r.containerId >>> 0) : (rowUsesPackSlot(r) ? PACKS_KEY : MAIN_PACK_KEY);
      if (optimistic) key = p.toKey;
      push(key, r);
    }
    for (const [g, s] of stubs) {
      const p = pendingOps.get(g);
      if (p && p.toKey !== null && p.toKey !== undefined) push(p.toKey, s);
    }
    return groups;
  }

  function rebuild() {
    rows = takeInventoryRows(sessionHandleNow());
    rowsByGuid = new Map(rows.map((r) => [r.guid, r]));
    stubs = new Map();
    for (const e of pendingOps.all()) {
      if (e.stub && !rowsByGuid.has(e.guid)) stubs.set(e.guid, { ...e.stub, guid: e.guid, stub: true });
    }
    // An item we asked the server to bring in from outside the panel
    // (a corpse / chest take) lands where it was dropped — or at the
    // front, ACE's placement 0 — not in its alphabetical slot.
    for (const e of pendingOps.all()) {
      if (e.toKey === null || e.toKey === undefined || e.external) continue;
      if (packOrder.locate(e.guid)) continue;
      packOrder.hintArrival(e.guid, e.toKey, e.index | 0);
    }
    orders = packOrder.reconcile(buildGroups());
    if (selectedPackContainerId !== 0 && !(orders.get(PACKS_KEY) || []).includes(selectedPackContainerId)) {
      selectedPackContainerId = 0;
      lastSelectedPack = 0;
    }
    clearPaperdoll();
    orphanEquipped = [];
    for (const r of rows) {
      if ((r.equipMask >>> 0) === 0) continue;
      if (!placeEquippedInDoll(r)) orphanEquipped.push(r);
    }
    applyPendingWieldsToDoll();
    renderBagColumn();
    renderGrid();
    refreshPaperdollViewport();
    refreshAetheriaGating();
    refreshBurden();
    refreshPanelTitle();
  }

  let rebuildQueued = false;
  function scheduleRebuild() {
    if (rebuildQueued) return;
    rebuildQueued = true;
    queueMicrotask(() => {
      rebuildQueued = false;
      if (!overlay.isConnected) return;
      try { rebuild(); } catch (e) { console.warn("[inventory] rebuild failed:", e); }
    });
  }

  // ── drop zones ──────────────────────────────────────────────────
  function dropCtx() {
    return {
      playerGuid: localPlayerGuid(),
      capacity: (key) => capacityOf(key),
      containerName: (key) => ((key === MAIN_PACK_KEY || key === PACKS_KEY)
        ? (playerName() || "You") : (displayRow(key)?.name || "pack")),
      canEquip: (item, mask) => canEquipInSlot(item, mask >>> 0, equipState()),
      packWithRoom: () => {
        for (const g of orders.get(PACKS_KEY) || []) {
          const c = capacityOf(g);
          if (c.cap === 0 || c.used < c.cap) return g;
        }
        return 0;
      },
      // ItemHolder::AttemptAutoMerge — only with an exact stack limit.
      autoMergeTarget: (item, amount, key) => {
        if (!Number.isFinite(item?.maxStackSize)) return 0;
        const keys = key === MAIN_PACK_KEY ? [MAIN_PACK_KEY, ...(orders.get(PACKS_KEY) || [])] : [key];
        for (const k of keys) {
          for (const g of orders.get(k) || []) {
            const r = rowsByGuid.get(g);
            if (r && mergeAmount(item, r, amount) >= amount) return g;
          }
        }
        return 0;
      },
    };
  }
  // Re-derive the source index at drop time (the list may have changed
  // under a long drag).
  function dragFor(s) {
    const key = s?.sourceList?.key;
    if (key === undefined || key === null || s.sourceList.kind === "ext") return s;
    const idx = (orders.get(key) || []).indexOf(s.guid >>> 0);
    return { ...s, sourceIndex: idx };
  }
  function hitFor(el, s, target, scope) {
    if (!s) return { el, ok: true, target, scope };
    const action = decideItemDrop({ ...dragFor(s), split: 0 }, target, { ...dropCtx(), canUseWith: () => null });
    const ok = action.op !== "reject";
    // Passing a weapon over the figure on its way to a ready slot should
    // not flash the whole paperdoll red; the release still explains.
    const hl = (!ok && target.kind === DROP_TARGET.DOLL) ? null : el;
    return { el: hl, ok, reason: action.message, target, scope };
  }
  async function performDrop(ev, s, target) {
    const drag = dragFor(s);
    const action = await resolveDropAction(drag, target, { ctx: dropCtx(), anchor: ev });
    if (!action || action.op === "noop") return;
    runAction(action, drag);
  }
  function runAction(action, s) {
    let undo = null;
    let stub = null;
    if (action.op === "move" && !action.external && action.listKey !== undefined) {
      const stack = Math.max(1, s.item?.stackSize | 0 || 1);
      const split = (action.amount ?? stack) < stack;
      const mv = packOrder.move(s.guid, action.listKey, action.index | 0, { split });
      if (!mv.noop && mv.undo) undo = () => { packOrder.undo(mv.undo); scheduleRebuild(); };
      if (!s.owned) {
        stub = {
          name: s.item?.name || "", iconId: (s.item?.iconId >>> 0) || 0,
          stackSize: action.amount ?? stack, wcid: s.item?.wcid || 0,
          itemType: s.item?.itemType || 0, equipMask: 0,
        };
      }
    }
    if (action.op === "wield" && action.speculative) {
      paperdollToast("Equipping speculatively (item attributes pending).", { speculative: true });
    }
    executeItemAction(action, s, { undo, stub });
    scheduleRebuild();
  }

  const unregisterZones = [
    registerDropZone(itemsGrid, {
      resolve(ev, s) {
        const key = gridKey();
        const list = orders.get(key) || [];
        const cell = ev.target?.closest?.(".hb-inv-slot");
        let target;
        if (cell && !cell.dataset.empty && cell.dataset.guid) {
          const g = cellGuid(cell);
          const at = list.indexOf(g);
          target = {
            kind: DROP_TARGET.ITEM_CELL, listKey: key, listKind: "inventory",
            index: at >= 0 ? at : list.length, count: list.length, item: withPack(displayRow(g)),
          };
        } else {
          target = { kind: DROP_TARGET.EMPTY_CELL, listKey: key, listKind: "inventory", index: list.length, count: list.length };
        }
        return hitFor(cell || itemsGrid, s, target, "items");
      },
      drop: (ev, s, hit) => performDrop(ev, s, hit.target),
    }),
    registerDropZone(bagCol, {
      resolve(ev, s) {
        const packs = orders.get(PACKS_KEY) || [];
        if (ev.target?.closest?.(".hb-inv-mainpack")) {
          return hitFor(mainSlot, s, { kind: DROP_TARGET.MAIN_PACK }, null);
        }
        const bag = ev.target?.closest?.(".hb-inv-bag");
        if (!bag) return null;
        const pg = (parseInt(bag.dataset.packGuid, 10) >>> 0) || 0;
        if (pg && !bag.classList.contains("is-empty")) {
          return hitFor(bag, s, {
            kind: DROP_TARGET.PACK_SLOT, packGuid: pg, packName: displayRow(pg)?.name || "pack",
            index: packs.indexOf(pg), count: packs.length,
          }, null);
        }
        return hitFor(bag, s, { kind: DROP_TARGET.EMPTY_PACK_SLOT, count: packs.length }, null);
      },
      drop: (ev, s, hit) => performDrop(ev, s, hit.target),
    }),
    registerDropZone(paperdoll, {
      resolve(ev, s) {
        const slot = ev.target?.closest?.(".hb-inv-doll-slot");
        if (slot) {
          return hitFor(slot, s, { kind: DROP_TARGET.DOLL_SLOT, slotMask: Number(slot.dataset.equipMask) >>> 0 }, "paperdoll");
        }
        // gmPaperDollUI's PaperDollDragMask — the figure itself.
        return hitFor(paperdoll, s, { kind: DROP_TARGET.DOLL }, "paperdoll");
      },
      drop: (ev, s, hit) => performDrop(ev, s, hit.target),
    }),
  ];

  parentEl.appendChild(overlay);

  // Other plugins: is this guid one of my items?
  window.__isInventoryItem = (guid) => rowsByGuid.has(guid >>> 0);

  mountedApi = { selectPack: (g) => { selectPack(g); } };

  // ── event wiring ────────────────────────────────────────────────
  // Every source funnels into ONE microtask-coalesced rebuild: the
  // kind=11 → renderInventoryPanel → MutationObserver tick and the
  // `playerInventoryChanged` bus event of the same packet used to cost
  // two full rebuilds.
  const observers = [];
  function tryHook() {
    const equipped = document.getElementById("inv-equipped");
    const pack = document.getElementById("inv-pack");
    if (!equipped || !pack) return false;
    for (const list of [equipped, pack]) {
      const o = new MutationObserver(scheduleRebuild);
      o.observe(list, { childList: true, subtree: false });
      observers.push(o);
    }
    return true;
  }
  rebuild();
  let pollTimer = null;
  if (!tryHook()) {
    pollTimer = setInterval(() => {
      if (tryHook()) { clearInterval(pollTimer); pollTimer = null; scheduleRebuild(); }
    }, 500);
  }

  // Wave 14 — retry the doll until the local player's meta exists.
  let viewportLoadTimer = null;
  function tryLoadViewport() {
    const lpg = localPlayerGuid();
    if (!lpg) return false;
    const inst = window.liveScene3d?.entityManager?.entityMap?.get?.(lpg);
    const setupId = (inst?.meta?.modelId ?? inst?.meta?.setupId ?? 0) >>> 0;
    if (!setupId) return false;
    refreshPaperdollViewport();
    return true;
  }
  if (!tryLoadViewport()) {
    viewportLoadTimer = setInterval(() => {
      if (tryLoadViewport()) { clearInterval(viewportLoadTimer); viewportLoadTimer = null; }
    }, 500);
  }

  // ESC clears the armed-item state (skip while typing).
  function onKey(ev) {
    if (ev?.key !== "Escape") return;
    const tag = ev.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if ((window.__inventory?.armedGuid >>> 0) !== 0) setArmedItem(0);
  }
  window.addEventListener("keydown", onKey);

  const unsubs = [];
  unsubs.push(pendingOps.onChange(scheduleRebuild));
  try {
    const client = window.__pluginClient;
    if (client?.events?.on) {
      const onStats = () => { refreshBurden(); refreshAetheriaGating(); };
      const evs = [
        ["playerStatsUpdated", onStats],
        ["playerInventoryChanged", scheduleRebuild],
        ["kind:47", scheduleRebuild],
        ["kind:49", scheduleRebuild],
      ];
      for (const [name, fn] of evs) {
        client.events.on(name, fn);
        unsubs.push(() => { try { client.events.off?.(name, fn); } catch (_) {} });
      }
    }
  } catch (_) { /* bus may not be initialized yet */ }

  return () => {
    window.removeEventListener("keydown", onKey);
    delete window.__isInventoryItem;
    if (pollTimer) clearInterval(pollTimer);
    if (viewportLoadTimer) clearInterval(viewportLoadTimer);
    for (const u of unsubs) { try { u(); } catch (_) {} }
    for (const u of unregisterZones) { try { u(); } catch (_) {} }
    for (const o of observers) o.disconnect();
    if (mountedApi) mountedApi = null;
    hideItemTooltip();
    // Wave 14 — release the WebGL context (Chrome caps live contexts ~16).
    try { paperdollViewport.dispose(); } catch (_) {}
    overlay.remove();
  };
}

/**
 * Keyed child patch: make `parent`'s children exactly `want` (in order),
 * moving only nodes that are out of place and removing cache entries not
 * in `used`. Nodes are reused, so state (icons, timers, a live drag
 * source) survives an inventory refresh.
 */
function patchChildren(parent, want, cache, used) {
  for (const [k, el] of cache) {
    if (!used.has(k)) { el.remove(); cache.delete(k); }
  }
  let cur = parent.firstChild;
  for (const el of want) {
    if (el === cur) { cur = cur.nextSibling; continue; }
    parent.insertBefore(el, cur);
  }
  while (cur) {
    const next = cur.nextSibling;
    if (!want.includes(cur)) cur.remove();
    cur = next;
  }
}
