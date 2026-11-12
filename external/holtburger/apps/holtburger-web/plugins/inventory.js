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
import {
  fetchIconDataUrl as fetchIconDataUrlShared,
  getIconImmediate,
  fetchItemIconDataUrl,
  getItemIconImmediate,
  itemIconKey,
} from "../ui/ac_icon_cache.js";
import { PLAYER_PACK_ICON, ITEM_TYPE_CONTAINER } from "../ui/ac_icon_compose.js";
import {
  uiEffectBadgesEnabled,
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
  isOpenableContainer,
  createPackOrder,
  packCapacity,
  DROP_TARGET,
  MAIN_PACK_KEY,
  PACKS_KEY,
  decideItemDrop,
  wieldEventTouchesLocal,
  findAutoMergeTarget,
  primaryUseAction,
  defaultOnUrlFlag,
  planWear,
  planAutoSortJewelry,
  planAmmoWield,
  readySlotOccupant,
  WEARABLE_LOCATIONS,
  DEFAULT_PLAYER_ITEMS_CAPACITY,
  DEFAULT_PLAYER_CONTAINERS_CAPACITY,
  PAPERDOLL_HIT_DID,
  PAPERDOLL_HIT_RECT,
  paperdollItemAt,
  cooldownStep,
  matchCooldownEnchantment,
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
import { consumeUseThrottle } from "../scene3d/target_cycle.js";

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
// Main-pack slot icon (bug 12, 2026-10-07): retail/OpenAC compose the
// player's pack base icon 0x0600127E as ItemType.Container
// (OpenAC InventoryController.PlayerPackBaseIcon) — not the generic LSD
// "Pack" weenie icon used before.
const MAIN_PACK_ICON_META = Object.freeze({ iconId: PLAYER_PACK_ICON, itemType: ITEM_TYPE_CONTAINER });

// Bug 12: the inputs of a retail item composite for one inventory row — the
// row carries icon / item type / UI effects; the custom overlay & underlay
// (PropertyDataId 50 / 52) come from the wasm entity store.
function iconMetaForRow(row) {
  const g = (row?.guid >>> 0) || 0;
  let ovl = (row?.iconOverlay >>> 0) || 0;
  let und = (row?.iconUnderlay >>> 0) || 0;
  const h = (typeof window !== "undefined") ? window.__sessionHandle : null;
  if (g && h) {
    if (!ovl) { try { ovl = (h.objectDataIdProperty?.(g, 50) >>> 0) || 0; } catch (_) { ovl = 0; } }
    if (!und) { try { und = (h.objectDataIdProperty?.(g, 52) >>> 0) || 0; } catch (_) { und = 0; } }
  }
  return {
    iconId: (row?.iconId >>> 0) || 0,
    itemType: (row?.itemType >>> 0) || 0,
    uiEffects: (row?.uiEffects >>> 0) || 0,
    iconOverlay: ovl,
    iconUnderlay: und,
  };
}

// UIElement_UIItem::SetShortcutNum (acclient.c:271599): normal & magic-stance
// shortcut badge DIDs for slots 0..9 (keys 1..9, 0).
const SHORTCUT_NUM_DIDS = Object.freeze([
  0x0600109e, 0x0600109f, 0x060010a0, 0x060010a1, 0x060010a2,
  0x060010a3, 0x060010a4, 0x060010a5, 0x060010a6, 0x060074d3,
]);
const SHORTCUT_NUM_GHOST_DIDS = Object.freeze([
  0x06001acc, 0x06001acd, 0x06001ace, 0x06001acf, 0x06001ad0,
  0x06001ad1, 0x06001ad2, 0x06001ad3, 0x06001ad4, 0x060074d2,
]);

// gmPaperDollUI::CreateClickMap (acclient.c:220420): 100×214 PaperDollHitTest
// silhouette decoded once per session from client_portal.dat (0x06004D8B).
let hitTestMap = null;
let hitTestInflight = null;
function applyHitMapResult(r) {
  if (r && r.width && r.height && r.pixels?.length) {
    hitTestMap = { width: r.width >>> 0, height: r.height >>> 0, data: new Uint8Array(r.pixels) };
  }
  try { r?.free?.(); } catch (_) {}
  return hitTestMap;
}
function loadPaperdollHitMap() {
  if (hitTestMap) return Promise.resolve(hitTestMap);
  if (hitTestInflight) return hitTestInflight;
  const wasm = (typeof window !== "undefined") ? (window.__hbWasm ?? window.__wasm ?? null) : null;
  const fetchIcon = wasm?.fetch_icon_pixels;
  if (typeof fetchIcon !== "function") return Promise.resolve(null);
  let res;
  try { res = fetchIcon.call(wasm, PAPERDOLL_HIT_DID >>> 0); } catch (_) { return Promise.resolve(null); }
  if (res && typeof res.then === "function") {
    hitTestInflight = res
      .then((r) => applyHitMapResult(r))
      .catch(() => null)
      .finally(() => { hitTestInflight = null; });
    return hitTestInflight;
  }
  return Promise.resolve(applyHitMapResult(res));
}
// Retail human defaults when the snapshot has not surfaced the property
// yet (ACE human weenie: ItemsCapacity 102, ContainersCapacity 7).
const DEFAULT_MAIN_CAP = DEFAULT_PLAYER_ITEMS_CAPACITY;
const DEFAULT_PACKS_CAP = DEFAULT_PLAYER_CONTAINERS_CAPACITY;
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
let viewedContainersPlayer = 0;
const viewedContainers = new Set();
const viewedInFlightAt = new Map();
const unconfirmedViewed = new Set();
const VIEW_INFLIGHT_COOLDOWN_MS = 1500;

function clearUnconfirmedContainerView(guid = 0) {
  const g = (guid >>> 0) || 0;
  if (g) {
    viewedInFlightAt.delete(g);
    unconfirmedViewed.delete(g);
  } else {
    viewedInFlightAt.clear();
    unconfirmedViewed.clear();
  }
}

function ensureOwnedContainerViewedRows(containerGuid, rowsList) {
  const c = (containerGuid >>> 0) || 0;
  if (!c) return;
  const me = localPlayerGuid();
  if (me && me !== viewedContainersPlayer) {
    viewedContainersPlayer = me;
    viewedContainers.clear();
    viewedInFlightAt.clear();
    unconfirmedViewed.clear();
  }
  if (viewedContainers.has(c)) return;
  const h = sessionHandleNow();
  const hasViewedFn = typeof h?.hasViewedContainer === "function";
  if (hasViewedFn) {
    let seen = false;
    try { seen = !!h.hasViewedContainer(c); } catch (_) { seen = false; }
    if (seen) {
      viewedInFlightAt.delete(c);
      viewedContainers.add(c);
      return;
    }
  } else {
    if (Array.isArray(rowsList) && rowsList.some((r) => (r.containerId >>> 0) === c)) {
      unconfirmedViewed.delete(c);
      viewedContainers.add(c);
      return;
    }
    if (typeof h?.getContainerContents === "function") {
      let cached = null;
      try {
        cached = h.getContainerContents(c);
        const arr = Array.isArray(cached) ? cached : [];
        let len = 0;
        for (const it of arr) { len++; try { it?.free?.(); } catch (_) {} }
        if (len > 0) {
          unconfirmedViewed.delete(c);
          viewedContainers.add(c);
          return;
        }
      } catch (_) {}
    }
    if (unconfirmedViewed.has(c)) return;
  }
  if (typeof window !== "undefined" && typeof window.__isBusy === "function" && window.__isBusy()) {
    return;
  }
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (hasViewedFn) {
    const prevAt = viewedInFlightAt.get(c) ?? -Infinity;
    if (now - prevAt < VIEW_INFLIGHT_COOLDOWN_MS) return;
    viewedInFlightAt.set(c, now);
  } else {
    unconfirmedViewed.add(c);
  }
  if (typeof h?.useObject === "function") {
    try { h.useObject(c); } catch (_) {}
  }
}

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
      /* Bug 13 (2026-10-07): fully opaque — retail draws the dressed doll
         (gmPaperDollUI::RedressCreature → CreatureMode::AddObject). */
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
    #${OVERLAY_ID} .hb-inv-doll-slot.is-selected::after {
      content: ""; position: absolute; inset: 0; z-index: 4;
      background: url("${SP}/0x06004D09.png") center / 100% 100% no-repeat;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hb-inv-doll-slot.is-drag-source { opacity: 0.4; }
    /* gmPaperDollUI drag/click band 0x100001d6 (51,0 100×214) over the figure. */
    #${OVERLAY_ID} .hb-inv-doll-hit {
      position: absolute;
      left: ${PAPERDOLL_HIT_RECT.x}px; top: ${PAPERDOLL_HIT_RECT.y}px;
      width: ${PAPERDOLL_HIT_RECT.w}px; height: ${PAPERDOLL_HIT_RECT.h}px;
      z-index: 1;
      cursor: default;
    }
    #${OVERLAY_ID}.slots-view .hb-inv-doll-hit { display: none; }
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
    #${OVERLAY_ID} .hb-inv-bag.is-selected { outline: 1px solid #f3d27a; outline-offset: -2px; }

    /* UIElement_UIItem state overlays: Trade (0x0600109D), Sell (0x060012D9),
       Cooldown 10..100 (0x060067CF..0x060067D8), ShortcutNum (0x0600109E..),
       StructureBar 0x10000348 (0x06004D24 rail + 0x06004D25 fill at 26,1 5x30). */
    #${OVERLAY_ID} .hb-uiitem-trade,
    #${OVERLAY_ID} .hb-uiitem-sell,
    #${OVERLAY_ID} .hb-uiitem-cd,
    #${OVERLAY_ID} .hb-uiitem-sc {
      position: absolute; inset: 0; z-index: 3;
      background: transparent center / 100% 100% no-repeat;
      image-rendering: pixelated;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hb-inv-bag > .hb-uiitem-trade,
    #${OVERLAY_ID} .hb-inv-bag > .hb-uiitem-sell,
    #${OVERLAY_ID} .hb-inv-bag > .hb-uiitem-cd,
    #${OVERLAY_ID} .hb-inv-bag > .hb-uiitem-sc {
      inset: auto; left: 2px; top: 2px; width: 32px; height: 32px;
    }
    #${OVERLAY_ID} .hb-uiitem-trade { background-image: url("${SP}/0x0600109D.png"); }
    #${OVERLAY_ID} .hb-uiitem-sell { background-image: url("${SP}/0x060012D9.png"); }
    #${OVERLAY_ID} .hb-uiitem-struct {
      position: absolute; left: 26px; top: 1px; width: 5px; height: 30px; z-index: 3;
      background: url("${SP}/0x06004D24.png") center / 100% 100% no-repeat;
      image-rendering: pixelated;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hb-inv-bag > .hb-uiitem-struct { left: 28px; top: 3px; }
    #${OVERLAY_ID} .hb-uiitem-struct > i {
      position: absolute; left: 0; right: 0; bottom: 0;
      height: var(--struct, 0%);
      background: url("${SP}/0x06004D25.png") center bottom / 5px 30px no-repeat;
    }

    /* ── gm3DItemsUI grid: fills the space under the paperdoll, left of
       the backpack column (retail ThreeDItemsField 234 wide), and scrolls
       with the rope scrollbar. Explicit 6-column track avoids subpixel 5-col
       collapse on fractional DPI zoom (288 - 66 - 16 - 2 = 204 >= 202). ── */
    #${OVERLAY_ID} .hb-inv-items {
      position: absolute;
      left: 0; top: ${PAPERDOLL_H}px; right: ${BAG_COL_W + 5}px; bottom: 0;
      box-sizing: border-box;
      padding: 3px 1px;
      display: grid;
      grid-template-columns: repeat(6, 32px);
      grid-auto-rows: 32px;
      gap: 2px;
      align-content: start;
      background: rgba(0, 0, 0, 0.35);
      border-top: 1px solid var(--hbk-gold-deep, #4e3f1f);
    }
    #${OVERLAY_ID} .hb-inv-items.is-drop-target { outline-offset: -2px; }

    /* usetarget-1: retail's target cursor over the inventory while a
       use-on-target waits; green / red = the Rust canUseWith answer. */
    body.use-targeting #${OVERLAY_ID} .hb-inv-slot:not(.is-empty),
    body.use-targeting #${OVERLAY_ID} .hb-inv-doll-slot.equipped,
    body.use-targeting #${OVERLAY_ID} .hb-inv-bag:not(.is-empty) { cursor: crosshair; }
    #${OVERLAY_ID} .use-target-ok { outline: 2px solid #40e070; outline-offset: -2px; }
    #${OVERLAY_ID} .use-target-bad { outline: 2px solid #ff5555; outline-offset: -2px; }
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
function openPack(guid, rowsOpt = null) {
  const c = (guid >>> 0) || 0;
  if (mountedApi) return mountedApi.selectPack(c);
  if (c !== 0) {
    const list = Array.isArray(rowsOpt) ? rowsOpt : takeInventoryRows(sessionHandleNow());
    const r = list.find((it) => (it.guid >>> 0) === c);
    if (!r || (r.equipMask >>> 0) !== 0 || !isOpenableContainer(r)) return false;
    lastSelectedPack = c;
    ensureOwnedContainerViewedRows(c, list);
    return true;
  }
  lastSelectedPack = 0;
  return true;
}

// Retail ItemHolder::UseObject for an OWNED item (acclient.c:433354) — the
// grid double-click, and through window.__inventory.activateItem the
// shortcut keys, the Use button and the radial "Use". DetermineUseResult
// (inventory_helpers.primaryUseAction) wields a weapon / ammo / shield,
// wears armour / clothing / jewellery, opens salvage for a tinkering tool,
// enters target mode for a kit / stone; only the rest is a plain Use
// (ACE has no wield path behind Use). Module-level so the hotbar works
// before the panel was ever opened. Returns false when `guid` is not ours
// (the caller then sends its own Use) — except the player itself, the main
// pack (usetarget-2, useSelf below); a repeat inside retail's 0.2 s
// m_timeLastUsed throttle is swallowed (true). use-4 (2026-10-08 round 2):
// that throttle is the ONE retail static, shared with the world Use paths
// (target_cycle.js consumeUseThrottle).
//
// items-4 (2026-10-08, `?retailAutoWear=off` = the old path): an armour /
// clothing wear first runs retail AutoWearIsLegal (planWear — "You must
// remove your X to wear that", nothing moves) and is sent with the full
// ValidLocations; a weapon / ammo wield onto a ready slot holding the SAME
// wcid merges into it (planAmmoWield — AttemptMerge, or "You cannot wield
// more X") instead of swapping. The drag-to-paperdoll path gets the same
// rules through dropCtx (wearPlan / readySlotOccupant).
const RETAIL_AUTO_WEAR = typeof window !== "undefined" ? defaultOnUrlFlag("retailAutoWear") : true;
// inventory-session-2 (2026-10-13, `?retailWieldLegal=off` = the old
// canEquipInSlot cascade): the wield check is retail CPlayerSystem::
// AutoWieldIsLegal (acclient.c:397227) — a caster may be held in combat, a
// held NON-caster may not; a shield is refused next to a wielded wand / bow
// / two-hander; a paperdoll slot the item cannot go in ignores the drop
// quietly. "In combat" is ClientCombatSystem::combatMode != 1, read from the
// wasm combatMode() (__combatBarState has no inCombatMode field).
const RETAIL_WIELD_LEGAL = typeof window !== "undefined" ? defaultOnUrlFlag("retailWieldLegal") : true;
// usetarget-1 (2026-10-18, `?useTargetGrid=off` = the old select-only
// clicks): while a use-on-target waits for its target (window.__useTargeting,
// app/hud_panels.js — retail target mode 3), a left click on an item cell, a
// worn item's paperdoll slot, a side pack or the main pack slot TARGETS that
// object instead of selecting / opening it: retail UIElement_ItemList::
// HandleTargetedUseLeftClick (acclient.c:272399) → ClientUISystem::
// ExecuteTargetModeForItem (:402078) → ItemHolder::TargetAcquired (:433578).
// The main pack slot's UIItem is the player, so it targets yourself. Before
// this, "use a pyreal mote, then click the other mote" only selected it.
const USE_TARGET_GRID = typeof window !== "undefined" ? defaultOnUrlFlag("useTargetGrid") : true;
// usetarget-2 (`?selfShortcut=off`): the main pack slot drags onto the
// toolbar as a shortcut to yourself (plugins/hotbar.js), and using the player
// — that shortcut outside target mode, the toolbar Use button with yourself
// selected — opens the main pack (useSelf) instead of sending a Use of
// yourself.
const SELF_SHORTCUT = typeof window !== "undefined" ? defaultOnUrlFlag("selfShortcut") : true;
/** Retail ItemHolder::UseObject on the player (acclient.c:433354): it is no
 *  usable object (ItemUseable 1, DetermineUseResult 0), so no Use event goes
 *  out; CPlayerSystem::UsingItem (:400434) finds it owned and a container and
 *  sends CM_UI::SendNotice_OpenContainedContainer(player) — gmInventoryUI
 *  shows itself on the main pack (:222373). Spends the shared 0.2 s throttle. */
function useSelf() {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (consumeUseThrottle(now)) {
    openPack(0);
    try {
      const mp = window.__mainPanel;
      if (!(mp?.isOpen?.() && mp?.currentViewId?.() === "inventory")) mp?.showView?.("inventory");
    } catch (_) {}
  }
  return true;
}
function wieldEquipState(rows) {
  let inCombatMode = !!window.__combatBarState?.inCombatMode;
  const h = RETAIL_WIELD_LEGAL ? sessionHandleNow() : null;
  if (typeof h?.combatMode === "function") {
    try { inCombatMode = ((h.combatMode() >>> 0) || 1) !== 1; } catch (_) { /* keep the fallback */ }
  }
  return buildPlayerEquipState(rows, {
    stance: (typeof window.__getCurrentStanceLow === "function" ? window.__getCurrentStanceLow() : 0) >>> 0,
    inCombatMode,
    retailWieldLegal: RETAIL_WIELD_LEGAL,
  });
}
function tradedGuidsSet(h) {
  const set = new Set();
  if (typeof h?.playerTrade !== "function") return set;
  let snap = null;
  try {
    snap = h.playerTrade();
    const my = snap && snap.isOpen !== false ? snap.myItems : null;
    if (my) {
      for (const it of Array.from(my)) {
        try { if (it?.guid) set.add(it.guid >>> 0); } catch (_) {}
        try { it?.free?.(); } catch (_) {}
      }
    }
  } catch (_) {}
  finally { try { snap?.free?.(); } catch (_) {} }
  return set;
}
function activateItem(guid, { cell = null } = {}) {
  const g = (guid >>> 0) || 0;
  if (!g) return false;
  const h = sessionHandleNow();
  const rows = takeInventoryRows(h);
  const row = rows.find((r) => r.guid === g);
  if (!row && SELF_SHORTCUT && g === localPlayerGuid()) return useSelf();
  if (!row) return false;
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (!consumeUseThrottle(now)) return true;
  let needsTarget = false;
  if (typeof h?.classifyUse === "function") {
    let intent = null;
    try { intent = h.classifyUse(g); needsTarget = !!intent?.needsTarget; } catch (_) { needsTarget = false; }
    finally { try { intent?.free?.(); } catch (_) {} }
  }
  let equippedMask = 0;
  for (const r of rows) equippedMask |= (r.equipMask >>> 0);
  const act = primaryUseAction(row, { needsTarget, equippedMask: equippedMask >>> 0 });
  const src = { guid: g, item: { ...row, isPack: rowUsesPackSlot(row), canHoldItems: isOpenableContainer(row) }, owned: true, sourceEl: cell };
  if (act.kind !== "open" && tradedGuidsSet(h).has(g)) {
    const verb = (act.kind === "wield" || act.kind === "wear") ? "wielded" : "used";
    executeItemAction({ op: "reject", message: `You are trading the ${row.name || "item"}, it cannot be ${verb}` }, src);
    return true;
  }
  switch (act.kind) {
    case "open":
      openPack(g, rows);
      try {
        const mp = window.__mainPanel;
        if (mp && (mp.currentViewId?.() !== "inventory" || !mp.isOpen?.())) mp.showView?.("inventory");
      } catch (_) {}
      return true;
    case "wield":
    case "wear": {
      if (typeof h?.setWielded !== "function" && typeof h?.wieldFromPack !== "function") break;
      let slotMask = act.slotMask >>> 0;
      if (RETAIL_AUTO_WEAR) {
        if (act.kind === "wear" && (slotMask & WEARABLE_LOCATIONS) !== 0) {
          const plan = planWear(row, rows);
          if (plan.op === "reject") { executeItemAction(plan, src); return true; }
          if (plan.op === "wear") slotMask = plan.slotMask >>> 0;
        } else if (act.kind === "wear") {
          let aetheriaBits;
          if (typeof h?.playerAetheriaBits === "number") aetheriaBits = h.playerAetheriaBits | 0;
          else if (typeof h?.playerAetheriaBits === "function") {
            try { aetheriaBits = h.playerAetheriaBits() | 0; } catch (_) {}
          }
          const plan = planAutoSortJewelry(row, rows, aetheriaBits !== undefined ? { aetheriaBits } : {});
          if (plan.op === "reject") { executeItemAction(plan, src); return true; }
          if (plan.op === "wear") slotMask = plan.slotMask >>> 0;
        } else if (act.kind === "wield") {
          const plan = planAmmoWield(row, readySlotOccupant(rows, slotMask));
          if (plan.op === "merge" || plan.op === "reject") { executeItemAction(plan, src); return true; }
        }
      }
      const verdict = canEquipInSlot(row, slotMask, wieldEquipState(rows));
      if (verdict && verdict.ok === false) {
        if (!verdict.silent) executeItemAction({ op: "reject", message: verdict.reason || "Cannot equip there." }, src);
        return true;
      }
      executeItemAction({ op: act.kind, guid: g, slotMask, amount: row.stackSize }, src);
      return true;
    }
    case "salvage":
      if (typeof window.__openSalvagePanel === "function") {
        try { window.__openSalvagePanel(g); return true; } catch (_) {}
      }
      break;
    case "target":
      if (typeof window.__useTargeting?.begin === "function") {
        window.__useTargeting.begin(g, row.name);
        return true;
      }
      break;
    default:
      break;
  }
  if (typeof h?.useObject === "function") {
    try { h.useObject(g); } catch (e) { console.warn("[inv-use] useObject failed:", e); }
    // HUD rec #180: writable items (ItemType WRITABLE 0x2000) need an
    // explicit bookData follow-up.
    try { if (((row.itemType >>> 0) & 0x00002000) !== 0 && h.bookData) h.bookData(g); } catch (_) {}
  }
  return true;
}
// `?hotbarActivate=off` gives the shortcut bar, Use button and radial
// menu their old bare useObject back (the grid double-click always runs
// activateItem — it wielded / opened / salvaged before this, too).
const HOTBAR_ACTIVATE = typeof window !== "undefined" ? defaultOnUrlFlag("hotbarActivate") : true;

if (typeof window !== "undefined") {
  if (!window.__inventory) window.__inventory = { armedGuid: 0 };
  // VTank layer seam (W1-8): the panel's selected item, mirrored by
  // setSelectedGuid below (0 = none / panel not mounted). Read by the host's
  // GetSelectedItemId (rynth/webhost.js) for the VT "Add selected" buttons.
  if (typeof window.__inventory.selectedGuid !== "number") window.__inventory.selectedGuid = 0;
  window.__inventory.setArmedItem = setArmedItem;
  window.__inventory.openPack = openPack;
  window.__inventory.selectedPack = () => lastSelectedPack;
  window.__inventory.activateItem = (guid, opts) => (HOTBAR_ACTIVATE ? activateItem(guid, opts) : false);
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
  function withPack(row) {
    return row ? { ...row, isPack: rowUsesPackSlot(row), canHoldItems: isOpenableContainer(row) } : null;
  }
  function gridKey() { return selectedPackContainerId === 0 ? MAIN_PACK_KEY : selectedPackContainerId; }
  function mainCap() { return (readHandleNumber("playerItemsCapacity") >>> 0) || DEFAULT_MAIN_CAP; }
  function packsCap() { return (readHandleNumber("playerContainersCapacity") >>> 0) || DEFAULT_PACKS_CAP; }
  function capacityOf(key) { return packCapacity(rows, key, { mainCap: mainCap(), packsCap: packsCap() }); }

  // ── UIElement_UIItem state overlays (Trade / Sell / Cooldown / Shortcut) ──
  const cdReceivedAt = new Map(); // "spell:layer:start" -> wall-clock s first seen
  let cdTimer = 0;
  function setLazyOverlay(el, prop, cls, on) {
    if (on) {
      if (!el[prop]) {
        const sp = document.createElement("span");
        sp.className = cls;
        el.appendChild(sp);
        el[prop] = sp;
      }
      return el[prop];
    }
    if (el[prop]) {
      el[prop].remove();
      el[prop] = null;
    }
    return null;
  }
  function setUiItemTrade(el, traded) {
    if (!!el._traded === !!traded) return;
    el._traded = !!traded;
    if (traded) el.dataset.traded = "1";
    else delete el.dataset.traded;
    setLazyOverlay(el, "_tradeEl", "hb-uiitem-trade", traded);
  }
  function setUiItemSell(el, selling) {
    if (!!el._selling === !!selling) return;
    el._selling = !!selling;
    if (selling) el.dataset.selling = "1";
    else delete el.dataset.selling;
    setLazyOverlay(el, "_sellEl", "hb-uiitem-sell", selling);
  }
  function setUiItemCooldown(el, step) {
    const s = step | 0;
    if ((el._cdStep | 0) === s) return;
    el._cdStep = s;
    if (s > 0) el.dataset.cdStep = String(s);
    else delete el.dataset.cdStep;
    const node = setLazyOverlay(el, "_cdEl", "hb-uiitem-cd", s > 0);
    if (node) {
      const hex = "0x" + (0x060067ce + s).toString(16).toUpperCase().padStart(8, "0");
      node.style.backgroundImage = `url("${SP}/${hex}.png")`;
    }
  }
  function setUiItemShortcut(el, slotIdx, ghosted) {
    const idx = slotIdx >= 0 && slotIdx < 9 ? (slotIdx | 0) : -1;
    const gh = !!ghosted;
    const key = idx >= 0 ? `${idx}:${gh ? 1 : 0}` : "";
    if ((el._scKey || "") === key) return;
    el._scKey = key;
    if (idx >= 0) el.dataset.shortcut = String(idx + 1);
    else delete el.dataset.shortcut;
    const node = setLazyOverlay(el, "_scEl", "hb-uiitem-sc", idx >= 0);
    if (node) {
      const did = (gh ? SHORTCUT_NUM_GHOST_DIDS : SHORTCUT_NUM_DIDS)[idx] >>> 0;
      node.style.backgroundImage = "";
      const hit = getIconImmediate(did);
      if (hit) { node.style.backgroundImage = `url("${hit}")`; return; }
      fetchIconDataUrlShared(did, "inventory").then((url) => {
        if (el._scKey !== key || !el._scEl) return;
        if (typeof url === "string" && url) el._scEl.style.backgroundImage = `url("${url}")`;
      }).catch(() => {});
    }
  }
  function setUiItemStructure(el, row) {
    const max = row ? (Number(row.maxStructure) || 0) : 0;
    const curRaw = row ? Number(row.structure ?? 0) : 0;
    const cur = Number.isFinite(curRaw) ? curRaw : 0;
    const show = max > 0 && cur < max;
    const key = show ? `${cur}/${max}` : "";
    if ((el._structKey || "") === key) return;
    el._structKey = key;
    if (show) el.dataset.structure = key;
    else delete el.dataset.structure;
    const node = setLazyOverlay(el, "_structEl", "hb-uiitem-struct", show);
    if (node) {
      let fill = node.firstChild;
      if (!fill) {
        fill = document.createElement("i");
        node.appendChild(fill);
      }
      const frac = Math.max(0, Math.min(1, cur / max));
      fill.style.setProperty("--struct", `${(frac * 100).toFixed(1)}%`);
    }
  }
  function clearUiItemOverlays(el) {
    setUiItemTrade(el, false);
    setUiItemSell(el, false);
    setUiItemCooldown(el, 0);
    setUiItemShortcut(el, -1, false);
    setUiItemStructure(el, null);
  }

  // ── usetarget-1: target mode in the inventory views ─────────────
  /** The pending use-on-target this view resolves, or null. */
  function pendingUseTarget() {
    if (!USE_TARGET_GRID) return null;
    const T = window.__useTargeting;
    return T?.pending && typeof T.resolve === "function" ? T : null;
  }
  const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  // The object a click just targeted: the second press of a double-click on
  // it must not Use / unwield it too (OpenAC RuntimeItemInteraction keeps the
  // consumed target for the double-click window).
  let lastTargetPick = { guid: 0, at: -Infinity };
  function justTargeted(guid) {
    return lastTargetPick.guid === (guid >>> 0) && nowMs() - lastTargetPick.at < 500;
  }
  /** Click on `guid` with a target awaited → it is the target (true). */
  function resolveUseTarget(guid) {
    const T = pendingUseTarget();
    const g = (guid >>> 0) || 0;
    if (!T || !g) return false;
    lastTargetPick = { guid: g, at: nowMs() };
    hideItemTooltip();
    try { T.resolve(g); } catch (e) { console.warn("[inv-target] resolve failed:", e); }
    return true;
  }
  // Hover feedback: retail's cursor turns green over a compatible target
  // (ItemHolder::IsTargetCompatibleWithTargetingObject, acclient.c:432848);
  // the Rust canUseWith port answers. __useTargeting.cancel() clears it.
  function markUseTarget(el, guid) {
    const T = pendingUseTarget();
    const g = (guid >>> 0) || 0;
    if (!T || !g || !el) return;
    const h = sessionHandleNow();
    let ok = false;
    try { ok = typeof h?.canUseWith === "function" && !!h.canUseWith(T.pending.itemGuid >>> 0, g); } catch (_) { ok = false; }
    el.classList.toggle("use-target-ok", ok);
    el.classList.toggle("use-target-bad", !ok);
  }
  function unmarkUseTarget(el) { el?.classList?.remove("use-target-ok", "use-target-bad"); }

  // ── gmPaperDollUI ───────────────────────────────────────────────
  const paperdoll = document.createElement("div");
  paperdoll.className = "hb-inv-paperdoll";
  const paperdollToast = makePaperdollToast(paperdoll);
  // Wave 14 — 3D character doll viewport (retail gmPaperDollUI::
  // RedressCreature). Renders BEHIND the slot squares.
  // 2026-10-20 (improvement hunt hud-audio-2): the inventory's long-lived
  // viewport, re-parented here on every mount (released, not disposed, in
  // cleanup) — no WebGL2 context create / program re-link / palette
  // re-composite per inventory open; an unchanged doll is a loadPlayer no-op.
  const paperdollViewport = PaperdollViewport.acquire("inventory", { width: PAPERDOLL_W, height: PAPERDOLL_H });
  const viewportWrap = document.createElement("div");
  viewportWrap.className = "hb-inv-paperdoll-viewport";
  viewportWrap.appendChild(paperdollViewport.dom);
  paperdoll.appendChild(viewportWrap);

  function unwieldGuidToPack(guid, sourceEl = null) {
    const g = (guid >>> 0) || 0;
    if (!g) return;
    const row = displayRow(g);
    executeItemAction(
      { op: "unwield", guid: g },
      { guid: g, item: withPack(row) || { guid: g }, owned: true, sourceEl },
    );
  }

  function activateOrUnwieldPaperdollItem(guid, sourceEl = null) {
    const g = (guid >>> 0) || 0;
    if (!g) return;
    const h = sessionHandleNow();
    const row = displayRow(g);
    let u = (row?.itemUseable >>> 0) || 0;
    if (!u && typeof row?.itemUseable !== "number" && typeof h?.objectIntProperty === "function") {
      try { u = (h.objectIntProperty(g, 16) >>> 0) || 0; } catch (_) { u = 0; }
    }
    const srcBits = u & 0xffff;
    const wieldedUsable = (srcBits & 0x0001) === 0 && (srcBits & 0x003c) !== 0;
    if (wieldedUsable) {
      if (typeof window !== "undefined" && typeof window.__isBusy === "function" && window.__isBusy()) return;
      if (!consumeUseThrottle(nowMs())) return;
      const src = { guid: g, item: withPack(row) || { guid: g }, owned: true, sourceEl };
      if (tradedGuidsSet(h).has(g)) {
        executeItemAction({ op: "reject", message: `You are trading the ${row?.name || "item"}, it cannot be used` }, src);
        return;
      }
      let needsTarget = (((u >>> 16) & 0xffff & ~0x0001) !== 0);
      if (typeof h?.classifyUse === "function") {
        let intent = null;
        try { intent = h.classifyUse(g); needsTarget = !!intent?.needsTarget || needsTarget; } catch (_) {}
        finally { try { intent?.free?.(); } catch (_) {} }
      }
      if (needsTarget && typeof window.__useTargeting?.begin === "function") {
        window.__useTargeting.begin(g, row?.name || "item");
        return;
      }
      if (typeof h?.useObject === "function") {
        try { h.useObject(g); } catch (e) { console.warn("[paperdoll-use] useObject failed:", e); }
        try { if (((row?.itemType >>> 0) & 0x00002000) !== 0 && h.bookData) h.bookData(g); } catch (_) {}
      }
      return;
    }
    unwieldGuidToPack(g, sourceEl);
  }

  // gmPaperDollUI::CreateClickMap / GetPaperDollItemUnderMouse (acclient.c:
  // 220420, 220495) — the 100×214 silhouette drag/click band 0x100001d6.
  loadPaperdollHitMap();
  const dollHit = document.createElement("div");
  dollHit.className = "hb-inv-doll-hit";
  dollHit.dataset.elemId = "0x100001D6";
  dollHit.draggable = true;
  let cachedDollHitRect = null;
  let cachedDollHitRectAt = -Infinity;
  let lastDollHoverGuid = 0;
  function hitGuidOnFigure(ev, { freshRect = false } = {}) {
    if (slotsViewChecked) return 0;
    if (!hitTestMap) {
      loadPaperdollHitMap();
      if (!hitTestMap) return 0;
    }
    const now = nowMs();
    if (freshRect || !cachedDollHitRect || (now - cachedDollHitRectAt > 200)) {
      cachedDollHitRect = dollHit.getBoundingClientRect();
      cachedDollHitRectAt = now;
    }
    const rect = cachedDollHitRect;
    const x = rect.width > 0 ? ((ev.clientX - rect.left) * hitTestMap.width / rect.width) : (ev.offsetX ?? ev.clientX ?? -1);
    const y = rect.height > 0 ? ((ev.clientY - rect.top) * hitTestMap.height / rect.height) : (ev.offsetY ?? ev.clientY ?? -1);
    return paperdollItemAt(hitTestMap, x, y, rows, localPlayerGuid());
  }
  dollHit.addEventListener("mouseenter", () => { cachedDollHitRect = null; });
  dollHit.addEventListener("mousemove", (ev) => {
    const hit = hitGuidOnFigure(ev);
    const me = localPlayerGuid();
    dollHit.style.cursor = hit ? "pointer" : "default";
    if (!hit) {
      if (lastDollHoverGuid !== 0) {
        lastDollHoverGuid = 0;
        unmarkUseTarget(dollHit);
      }
      hideItemTooltip();
      return;
    }
    if (pendingUseTarget() && hit !== lastDollHoverGuid) {
      markUseTarget(dollHit, me || hit);
    }
    lastDollHoverGuid = hit;
    const pt = (Number.isFinite(ev.clientX) && Number.isFinite(ev.clientY))
      ? { clientX: ev.clientX, clientY: ev.clientY }
      : null;
    if (hit === me) {
      showItemTooltip(dollHit, playerName() || "You", pt);
    } else {
      const row = displayRow(hit);
      if (row) showItemTooltip(dollHit, row.name || "Equipped item", pt);
    }
  });
  dollHit.addEventListener("mouseleave", () => {
    cachedDollHitRect = null;
    lastDollHoverGuid = 0;
    unmarkUseTarget(dollHit);
    hideItemTooltip();
  });
  dollHit.addEventListener("click", (ev) => {
    if (ev.button !== 0) return;
    const hit = hitGuidOnFigure(ev, { freshRect: true });
    if (!hit) return;
    const me = localPlayerGuid();
    if (pendingUseTarget() && resolveUseTarget(me || hit)) {
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (hit !== me) setSelectedGuid(hit);
  });
  dollHit.addEventListener("dblclick", (ev) => {
    if (ev.button !== 0) return;
    const hit = hitGuidOnFigure(ev, { freshRect: true });
    const me = localPlayerGuid();
    if (!hit || hit === me || justTargeted(hit) || justTargeted(me)) return;
    ev.preventDefault();
    ev.stopPropagation();
    activateOrUnwieldPaperdollItem(hit, dollHit);
  });
  dollHit.addEventListener("contextmenu", (ev) => {
    const hit = hitGuidOnFigure(ev, { freshRect: true });
    if (!hit) return;
    ev.preventDefault();
    ev.stopPropagation();
    const me = localPlayerGuid();
    if (hit !== me) setSelectedGuid(hit);
    const row = hit !== me ? displayRow(hit) : null;
    if (hit !== me && typeof window.__openContextMenuFor === "function") {
      try {
        window.__openContextMenuFor({
          source: "inv-paperdoll", guid: hit,
          name: row?.name || "Item",
          clientX: ev.clientX, clientY: ev.clientY,
        });
      } catch (_) {}
    } else if (typeof window.__showExamineFor === "function") {
      const opts = hit === me
        ? { name: playerName() || "You" }
        : { name: row?.name || "Item", fromInventory: true };
      try { window.__showExamineFor(hit, opts); } catch (_) {}
    }
  });
  dollHit.addEventListener("dragstart", (ev) => {
    const hit = hitGuidOnFigure(ev, { freshRect: true });
    const me = localPlayerGuid();
    if (SELF_SHORTCUT && hit && hit === me) {
      hideItemTooltip();
      beginItemDrag(ev, {
        guid: me, self: true, owned: true, sourceList: null, sourceIndex: -1, sourceEl: dollHit,
        item: { name: playerName() || "Main Pack", ...MAIN_PACK_ICON_META },
      });
      return;
    }
    const row = (hit && hit !== me) ? rowsByGuid.get(hit) : null;
    if (!row) { ev.preventDefault(); return; }
    hideItemTooltip();
    beginItemDrag(ev, {
      guid: hit, item: withPack(row), owned: true,
      sourceList: null, sourceIndex: -1, sourceEl: dollHit,
    });
  });
  paperdoll.appendChild(dollHit);

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
    el._stackN = 0;
    el.addEventListener("mouseenter", () => {
      const nm = el.dataset.itemName;
      showItemTooltip(el, nm ? `${nm}\n${s.name}` : s.name);
      markUseTarget(el, parseInt(el.dataset.itemGuid, 10));
    });
    el.addEventListener("mouseleave", () => { unmarkUseTarget(el); hideItemTooltip(); });
    // usetarget-1: with a target awaited, a worn item's slot targets that
    // item (each slot is an item list — HandleTargetedUseLeftClick); else
    // retail left-click selects the equipped item.
    el.addEventListener("click", (ev) => {
      if (ev.button !== 0) return;
      const guid = (parseInt(el.dataset.itemGuid, 10) >>> 0) || 0;
      if (resolveUseTarget(guid)) { ev.preventDefault(); ev.stopPropagation(); return; }
      if (guid) setSelectedGuid(guid);
    });
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
    // Double-click → SourceWielded Use if usable while worn, else unwield back to pack.
    el.addEventListener("dblclick", (ev) => {
      if (ev.button !== 0) return;
      const guid = (parseInt(el.dataset.itemGuid, 10) >>> 0) || 0;
      if (!guid) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (justTargeted(guid)) return; // its first press was a target click
      activateOrUnwieldPaperdollItem(guid, el);
    });
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const guid = (parseInt(el.dataset.itemGuid, 10) >>> 0) || 0;
      if (!guid) return;
      setSelectedGuid(guid);
      const name = el.dataset.itemName || s.name;
      if (typeof window.__openContextMenuFor === "function") {
        try {
          window.__openContextMenuFor({
            source: "inv-paperdoll", guid,
            name,
            clientX: ev.clientX, clientY: ev.clientY,
          });
        } catch (e) { console.warn("[paperdoll-rc] context menu failed:", e); }
      } else if (typeof window.__showExamineFor === "function") {
        try { window.__showExamineFor(guid, { name, fromInventory: true }); } catch (_) {}
      }
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
  // Bug 12: bag cells show the RETAIL composite (see ui/ac_icon_compose.js);
  // a failed fetch clears the memo so the next render retries.
  function setBagIcon(cell, meta) {
    const key = meta?.iconId ? itemIconKey(meta) : "";
    if (cell._iconKey === key) return;
    cell._iconKey = key;
    cell._iconId = (meta?.iconId >>> 0) || 0;
    cell._icon.style.backgroundImage = "";
    if (!key) return;
    const hit = getItemIconImmediate(meta);
    if (hit) { cell._icon.style.backgroundImage = `url("${hit}")`; return; }
    fetchItemIconDataUrl(meta, "inventory").then((url) => {
      if (cell._iconKey !== key) return;
      if (typeof url !== "string") { cell._iconKey = null; return; }
      cell._icon.style.backgroundImage = `url("${url}")`;
    });
  }
  function setBagCapacity(cell, used, cap) {
    const frac = cap > 0 ? Math.max(0, Math.min(1, used / cap)) : 0;
    cell._cap.style.display = (cap > 0 && used > 0) ? "" : "none";
    cell._cap.firstChild.style.setProperty("--cap", `${Math.round(frac * 100)}%`);
  }

  // Inv_MainPackSlot.
  const mainSlot = makeBagCell();
  mainSlot.classList.add("hb-inv-mainpack");
  setBagIcon(mainSlot, MAIN_PACK_ICON_META);
  // usetarget-1: its UIItem is the player — with a target awaited, a click
  // targets yourself (a healing kit heals you); otherwise it opens the pack.
  mainSlot.addEventListener("click", () => {
    if (resolveUseTarget(localPlayerGuid())) return;
    selectPack(0);
  });
  mainSlot.addEventListener("mouseenter", () => {
    const c = capacityOf(MAIN_PACK_KEY);
    showItemTooltip(mainSlot, `Main Pack\n${c.used} / ${c.cap} items`);
    markUseTarget(mainSlot, localPlayerGuid());
  });
  mainSlot.addEventListener("mouseleave", () => { unmarkUseTarget(mainSlot); hideItemTooltip(); });
  // usetarget-2: dragged onto the toolbar it is a shortcut to yourself (the
  // drag carries item_drag.js SELF_MIME, never the item MIMEs).
  if (SELF_SHORTCUT) {
    mainSlot.draggable = true;
    mainSlot.addEventListener("dragstart", (ev) => {
      const me = localPlayerGuid();
      if (!me) { ev.preventDefault(); return; }
      hideItemTooltip();
      beginItemDrag(ev, {
        guid: me, self: true, owned: true, sourceList: null, sourceIndex: -1, sourceEl: mainSlot,
        item: { name: playerName() || "Main Pack", ...MAIN_PACK_ICON_META },
      });
    });
  }
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
    if (row && !isOpenableContainer(row)) {
      showItemTooltip(cell, row.name || "Item");
      return;
    }
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
        cell.addEventListener("click", (ev) => {
          const pg = (parseInt(cell.dataset.packGuid, 10) >>> 0) || 0;
          if (resolveUseTarget(pg)) return; // usetarget-1: the pack is the target
          if (!pg) return;
          const r = displayRow(pg);
          if (r && !isOpenableContainer(r)) {
            setSelectedGuid(pg);
            if (ev.detail >= 2 && !justTargeted(pg)) useOrEquip(r, cell);
            return;
          }
          selectPack(pg);
        });
        cell.addEventListener("mouseenter", (ev) => {
          onBagEnter(ev);
          markUseTarget(cell, parseInt(cell.dataset.packGuid, 10));
        });
        cell.addEventListener("mouseleave", () => { unmarkUseTarget(cell); hideItemTooltip(); });
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
          if (!pg) return;
          const r = displayRow(pg);
          if (r && !isOpenableContainer(r)) setSelectedGuid(pg);
          if (typeof window.__openContextMenuFor !== "function") return;
          try {
            window.__openContextMenuFor({
              source: "inv-grid", guid: pg, srcLi: legacyLi(pg, cell),
              name: r?.name || "Pack", clientX: ev.clientX, clientY: ev.clientY,
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
      setBagIcon(cell, iconMetaForRow(row));
      if (row && !isOpenableContainer(row)) {
        setBagCapacity(cell, 0, 0);
      } else {
        const c = capacityOf(g);
        setBagCapacity(cell, c.used, c.cap);
      }
      cell.classList.toggle("is-open", selectedPackContainerId === g);
      cell.classList.toggle("is-selected", selectedGuid !== 0 && selectedGuid === g);
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

  // Bug 12 (2026-10-07): the RETAIL composite (type background, underlay,
  // icon + overlay with the white key → UI-effect tile) instead of the raw
  // DAT icon. A failed fetch clears the memo so a later render retries.
  function setCellIcon(cell, row) {
    const meta = iconMetaForRow(row);
    const iconId = meta.iconId;
    const key = iconId ? itemIconKey(meta) : `none:${(row.itemType >>> 0) || 0}`;
    if (cell._iconKey === key) return;
    cell._iconKey = key;
    cell._iconId = iconId;
    const icon = cell._icon;
    icon.style.backgroundColor = "";
    icon.style.backgroundImage = "";
    if (!iconId) { icon.style.backgroundColor = typeTint(row.itemType); return; }
    const hit = getItemIconImmediate(meta);
    if (hit) { icon.style.backgroundImage = `url("${hit}")`; return; }
    icon.style.backgroundColor = typeTint(row.itemType);
    fetchItemIconDataUrl(meta, "inventory").then((url) => {
      if (cell._iconKey !== key) return;
      if (typeof url !== "string") {
        cell._iconKey = null; // retry on the next render (the cache TTL rate-limits)
        return;
      }
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
    if (!bits || !uiEffectBadgesEnabled()) return;
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
      clearTimeout(cell._tipTimer);
      cell.dataset.guid = g;
      cell._iconId = -1;
      cell._iconKey = null;
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
    if (typeof dollSlotEls !== "undefined") {
      for (const k of Object.keys(dollSlotEls)) {
        const el = dollSlotEls[k].el;
        el.classList.toggle("is-selected", selectedGuid !== 0 && ((parseInt(el.dataset.itemGuid, 10) >>> 0) === selectedGuid));
      }
    }
    if (typeof bagCache !== "undefined") {
      for (const cell of bagCache.values()) {
        if (cell.classList.contains("is-empty")) continue;
        const pg = (parseInt(cell.dataset.packGuid, 10) >>> 0) || 0;
        cell.classList.toggle("is-selected", selectedGuid !== 0 && pg === selectedGuid);
      }
    }
    publishSelection(selectedGuid);
  }
  // VTank layer seam (W1-8): export the selection (it used to be private to
  // this closure) + one window event per change. Guarded: a page-seam failure
  // must never break the inventory click path.
  function publishSelection(guid) {
    try {
      if (!window.__inventory) window.__inventory = { armedGuid: 0 };
      if ((window.__inventory.selectedGuid >>> 0) === guid) return;
      window.__inventory.selectedGuid = guid;
      window.dispatchEvent(new CustomEvent("hb-inventory-selection", { detail: { guid } }));
    } catch (_) { /* seam only */ }
  }
  function onCellClick(ev) {
    if (ev.button !== 0) return;
    const cell = ev.currentTarget;
    const g = cellGuid(cell);
    const row = displayRow(g);
    if (!g || !row || row.stub) return;
    // usetarget-1: an awaited use-on-target takes this item as its target
    // (and the second press of that double-click is not also a Use).
    if (resolveUseTarget(g)) return;
    if (ev.detail >= 2 && justTargeted(g)) return;
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
    markUseTarget(cell, g);
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
    unmarkUseTarget(ev.currentTarget);
    hideItemTooltip();
  }

  // Double-click / Ctrl-click = retail ItemHolder::UseObject (module-level
  // activateItem): pack → open, weapon → wield, armour → wear, tinkering
  // tool → salvage, kit / stone → target mode, else Use (+ book follow-up).
  function useOrEquip(row, cell) {
    activateItem(row.guid, { cell });
  }

  // ── packs / title ───────────────────────────────────────────────
  function isOpenableOwnedContainer(c) {
    const g = (c >>> 0) || 0;
    if (!g) return false;
    const r = displayRow(g);
    return !!r && (r.equipMask >>> 0) === 0 && isOpenableContainer(r);
  }
  function selectPack(containerId) {
    const c = (containerId >>> 0) || 0;
    if (c !== 0 && !isOpenableOwnedContainer(c)) return false;
    if (c !== 0) ensureOwnedContainerViewedRows(c, rows);
    if (c === selectedPackContainerId) return true;
    selectedPackContainerId = c;
    lastSelectedPack = c;
    itemsGrid.scrollTop = 0; // retail ScrollToHome on a new parent container
    renderBagColumn();
    renderGrid();
    refreshUiItemStates();
    refreshPanelTitle();
    return true;
  }

  // gmInventoryUI::RecvNotice_NewParentContainer: "Inventory of <player>"
  // on the main pack, "Contents of <pack>" on any owned open container.
  function refreshPanelTitle() {
    let next;
    if (selectedPackContainerId !== 0) {
      const packs = (orders.get(PACKS_KEY) || []).map((g) => ({ containerId: g, name: displayRow(g)?.name || "" }));
      if (!packs.some((p) => (p.containerId >>> 0) === selectedPackContainerId)) {
        packs.push({ containerId: selectedPackContainerId, name: displayRow(selectedPackContainerId)?.name || "" });
      }
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
      e.el.classList.remove("equipped", "is-pending", "is-selected");
      delete e.el.dataset.itemGuid;
      delete e.el.dataset.itemName;
      delete e.el.dataset.guid;
      e.el.draggable = false;
      setCellStack(e.el, 0);
      clearUiItemOverlays(e.el);
      e.icon.style.backgroundImage = "";
      e.icon.dataset.iconId = "";
      e.icon.dataset.iconKey = "";
    }
  }
  // Bug 13 (2026-10-07): an item fills EVERY slot its mask covers. Real
  // armour covers several (Sleeves 0x1800 = upper + lower arm, Leggings
  // 0x6000 = upper + lower leg) and ACE stores the full coverage as the
  // wielded location; retail tests each slot bit independently
  // (`gmPaperDollUI::SetUIItemIntoLocation`, acclient.c:221965 `& 0x10`
  // → lowerArmSlot, :221986 `& 0x40` → lowerLegSlot; OpenAC
  // PaperdollController). The old first-match lookup left Lower arm / Lower
  // leg empty under sleeves / leggings.
  function dollSlotsFor(mask) {
    const m = mask >>> 0;
    const out = [];
    if (!m) return out;
    for (const k of Object.keys(dollSlotEls)) {
      if ((m & (Number(k) >>> 0)) !== 0) out.push(dollSlotEls[k]);
    }
    return out;
  }
  function showInDoll(slotEntry, row, pending) {
    const el = slotEntry.el;
    const guid = row.guid >>> 0;
    const g = String(guid);
    el.classList.add("equipped");
    el.classList.toggle("is-pending", !!pending);
    el.classList.toggle("is-selected", selectedGuid !== 0 && guid === selectedGuid);
    el.dataset.itemGuid = g;
    el.dataset.guid = g;
    el.dataset.itemName = row.name || slotEntry.slot.name;
    el.draggable = !pending;
    setCellStack(el, Math.max(1, row.stackSize | 0 || 1));
    // Bug 12: equipped-slot icons are the retail composite too.
    const meta = iconMetaForRow(row);
    const iconKey = meta.iconId ? itemIconKey(meta) : "";
    if (slotEntry.icon.dataset.iconKey === iconKey) return;
    slotEntry.icon.dataset.iconKey = iconKey;
    slotEntry.icon.dataset.iconId = String(meta.iconId);
    const hit = meta.iconId ? getItemIconImmediate(meta) : null;
    if (hit) { slotEntry.icon.style.backgroundImage = `url("${hit}")`; return; }
    if (!meta.iconId) return;
    fetchItemIconDataUrl(meta, "inventory").then((url) => {
      if (typeof url !== "string") { slotEntry.icon.dataset.iconKey = ""; return; }
      if (el.dataset.itemGuid === g) slotEntry.icon.style.backgroundImage = `url("${url}")`;
    });
  }
  // 2026-10-07 — `[paperdoll-slots]` logs a multi-slot item's mapping once
  // per change (it used to repeat on every rebuild: ~360 lines for the same
  // two items in a 15-minute session); `?diag=1` restores the per-rebuild trace.
  const paperdollSlotsLogged = new Map(); // guid → last logged mapping
  const paperdollSlotsTraceAll = (() => {
    try { return new URLSearchParams(window.location?.search || "").get("diag") === "1"; } catch (_) { return false; }
  })();
  function placeEquippedInDoll(row) {
    const slots = dollSlotsFor(row.equipMask);
    if (!slots.length) return false;
    const p = pendingOps.get(row.guid);
    // An equipped item being moved / dropped / given away waits ghosted.
    const leaving = !!p && p.op !== "wield";
    if (leaving && p.op === "move" && p.toKey != null && !p.external) return true; // drawn in the grid
    for (const slotEntry of slots) showInDoll(slotEntry, row, leaving);
    if (slots.length > 1) {
      const line = `${row.name || row.guid} mask=0x${(row.equipMask >>> 0).toString(16)} → ${slots.map((e) => e.slot.name).join(", ")}`;
      if (paperdollSlotsTraceAll || paperdollSlotsLogged.get(row.guid) !== line) {
        if (paperdollSlotsLogged.size >= 64) paperdollSlotsLogged.clear();
        paperdollSlotsLogged.set(row.guid, line);
        console.debug?.(`[paperdoll-slots] ${line}`);
      }
    }
    return true;
  }
  function applyPendingWieldsToDoll() {
    for (const e of pendingOps.all()) {
      if (e.op !== "wield" || !e.slotMask) continue;
      const row = displayRow(e.guid);
      if (!row || (row.equipMask >>> 0) !== 0) continue;
      // ACE normalises armour / clothing to its full ValidLocations on wield
      // (Player_Inventory.cs `if (item is Clothing) wieldedLocation =
      // item.ValidLocations`), so ghost every slot it will cover.
      const vl = (row.validLocations >>> 0) || 0;
      const isWorn = (vl & 0x0000FFFF) !== 0 && (vl & 0x3F00000) === 0;
      const mask = isWorn ? (vl | (e.slotMask >>> 0)) : (e.slotMask >>> 0);
      for (const slotEntry of dollSlotsFor(mask)) showInDoll(slotEntry, row, true);
    }
  }

  function equipState() {
    return wieldEquipState(rows);
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
      // Bug 13: the worn armour (ObjDesc part / texture swaps, kept current
      // on the rig meta by applyAppearance) + heritage for the retail eye.
      let heritage = 0;
      try { heritage = (h?.objectIntProperty?.(lpg >>> 0, 188) >>> 0) || 0; } catch (_) { heritage = 0; }
      paperdollViewport.loadPlayer(
        setupId,
        (meta.mtableId ?? 0) >>> 0,
        (meta.paletteId ?? 0) >>> 0,
        meta.subPalettes ?? new Uint32Array(0),
        wieldedItems,
        stanceLow,
        {
          modelChanges: meta.modelChanges ?? new Uint32Array(0),
          textureChanges: meta.textureChanges ?? new Uint32Array(0),
          heritage,
        },
      ).catch(() => {}); // the viewport re-renders itself when the panel is shown
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

  // UIElement_UIItem state pass across grid, bag and paperdoll slots.
  function refreshUiItemStates() {
    if (!overlay.isConnected) return;
    const h = sessionHandleNow();
    const traded = tradedGuidsSet(h);
    const selling = new Set();
    try {
      for (const g of window.__vendorUi?.sellListGuids?.() || []) {
        if (g) selling.add(g >>> 0);
      }
    } catch (_) {}
    const shortcuts = new Map();
    let selfSlot = -1;
    try {
      const hb = window.__hotbar;
      if (typeof hb?.getSlot === "function") {
        const me = localPlayerGuid();
        // Only Row 1 slots 0..8 (keys 1..9) have retail ShortcutNum badges;
        // slot 9 is Row 2 Slot 1 (Alt+1), not key "0".
        for (let i = 0; i < 9; i++) {
          const s = hb.getSlot(i);
          if (!s) continue;
          if (s.self || (me && (s.itemGuid >>> 0) === me)) {
            if (selfSlot < 0) selfSlot = i;
          } else if (s.itemGuid) {
            const ig = s.itemGuid >>> 0;
            if (!shortcuts.has(ig)) shortcuts.set(ig, i);
          }
        }
      }
    } catch (_) {}
    let magicStance = false;
    try {
      if (typeof h?.combatMode === "function") magicStance = ((h.combatMode() >>> 0) || 1) === 8;
    } catch (_) { magicStance = false; }

    const cdStepByGuid = new Map();
    let anyActiveCd = false;
    const hasSharedCd = rows.some((r) => (r.sharedCooldown >>> 0) > 0);
    if (hasSharedCd && typeof h?.playerEnchantments === "function") {
      const enchs = [];
      let raw = [];
      try { raw = h.playerEnchantments() || []; } catch (_) { raw = []; }
      for (const e of raw) {
        try {
          enchs.push({
            spellId: e.spellId >>> 0, layer: e.layer | 0,
            startTime: Number(e.startTime) || 0, duration: Number(e.duration) || 0,
          });
        } catch (_) {}
        try { e?.free?.(); } catch (_) {}
      }
      const nowS = Date.now() / 1000;
      const liveKeys = new Set();
      for (const r of rows) {
        const sc = (r.sharedCooldown >>> 0) || 0;
        if (!sc) continue;
        const e = matchCooldownEnchantment(enchs, sc);
        if (!e) continue;
        const key = `${e.spellId}:${e.layer}:${e.startTime}`;
        liveKeys.add(key);
        if (!cdReceivedAt.has(key)) cdReceivedAt.set(key, nowS);
        const dur = Number(r.cooldownDuration) > 0 ? Number(r.cooldownDuration) : e.duration;
        const remaining = e.duration + e.startTime - (nowS - cdReceivedAt.get(key));
        const step = cooldownStep(dur, remaining);
        if (step > 0) {
          cdStepByGuid.set(r.guid >>> 0, step);
          anyActiveCd = true;
        }
      }
      for (const k of Array.from(cdReceivedAt.keys())) {
        if (!liveKeys.has(k)) cdReceivedAt.delete(k);
      }
    } else if (cdReceivedAt.size > 0) {
      cdReceivedAt.clear();
    }
    if (anyActiveCd && !cdTimer) {
      cdTimer = setInterval(refreshUiItemStates, 250);
      cdTimer?.unref?.();
    }
    else if (!anyActiveCd && cdTimer) { clearInterval(cdTimer); cdTimer = 0; }

    setUiItemShortcut(mainSlot, selfSlot, magicStance);
    for (const cell of cellCache.values()) {
      if (cell.dataset.empty) { clearUiItemOverlays(cell); continue; }
      const g = cellGuid(cell);
      setUiItemTrade(cell, traded.has(g));
      setUiItemSell(cell, selling.has(g));
      setUiItemCooldown(cell, cdStepByGuid.get(g) || 0);
      setUiItemShortcut(cell, shortcuts.has(g) ? shortcuts.get(g) : -1, magicStance);
      setUiItemStructure(cell, displayRow(g));
    }
    for (const cell of bagCache.values()) {
      if (cell.classList.contains("is-empty")) { clearUiItemOverlays(cell); continue; }
      const pg = (parseInt(cell.dataset.packGuid, 10) >>> 0) || 0;
      setUiItemTrade(cell, traded.has(pg));
      setUiItemSell(cell, selling.has(pg));
      setUiItemCooldown(cell, cdStepByGuid.get(pg) || 0);
      setUiItemShortcut(cell, shortcuts.has(pg) ? shortcuts.get(pg) : -1, magicStance);
      setUiItemStructure(cell, displayRow(pg));
    }
    for (const k of Object.keys(dollSlotEls)) {
      const el = dollSlotEls[k].el;
      const dg = (parseInt(el.dataset.itemGuid, 10) >>> 0) || 0;
      if (!dg) { clearUiItemOverlays(el); continue; }
      setUiItemTrade(el, traded.has(dg));
      setUiItemSell(el, selling.has(dg));
      setUiItemCooldown(el, cdStepByGuid.get(dg) || 0);
      setUiItemShortcut(el, shortcuts.has(dg) ? shortcuts.get(dg) : -1, magicStance);
      setUiItemStructure(el, displayRow(dg));
    }
  }

  // ── rebuild ─────────────────────────────────────────────────────
  function buildGroups() {
    const groups = new Map([[MAIN_PACK_KEY, []], [PACKS_KEY, []]]);
    for (const r of rows) {
      if ((r.equipMask >>> 0) === 0 && (
        ((r.containerId >>> 0) === 0 && rowUsesPackSlot(r))
        || isOpenableContainer(r)
      )) {
        groups.set(r.guid, []);
      }
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

  // 2026-10-07 — live-check surface for the kind:47/49 filter below.
  const rebuildStats = (window.__inventoryRebuildStats = { rebuilds: 0, wieldEventsSkipped: 0 });
  function rebuild() {
    rebuildStats.rebuilds += 1;
    if (!hitTestMap) loadPaperdollHitMap();
    cachedDollHitRect = null;
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
    if (selectedPackContainerId !== 0) {
      if (!isOpenableOwnedContainer(selectedPackContainerId)) {
        selectedPackContainerId = 0;
        lastSelectedPack = 0;
      } else {
        ensureOwnedContainerViewedRows(selectedPackContainerId, rows);
      }
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
    refreshUiItemStates();
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
    const traded = tradedGuidsSet(sessionHandleNow());
    return {
      playerGuid: localPlayerGuid(),
      capacity: (key) => capacityOf(key),
      containerName: (key) => ((key === MAIN_PACK_KEY || key === PACKS_KEY)
        ? (playerName() || "You") : (displayRow(key)?.name || "pack")),
      canEquip: (item, mask) => canEquipInSlot(item, mask >>> 0, equipState()),
      isBeingTraded: (guid) => traded.has(guid >>> 0),
      isContainedBy: (targetGuid, ancestorGuid) => {
        let cur = (targetGuid >>> 0) || 0;
        const anc = (ancestorGuid >>> 0) || 0;
        if (!cur || !anc || cur === anc) return false;
        const h = sessionHandleNow();
        const seen = new Set([cur]);
        for (let depth = 0; depth < 16 && cur; depth++) {
          let parent = (rowsByGuid.get(cur)?.containerId >>> 0) || 0;
          if (!parent && typeof h?.objectInstanceIdProperty === "function") {
            try { parent = (h.objectInstanceIdProperty(cur, 2) >>> 0) || 0; } catch (_) { parent = 0; }
          }
          if (!parent) return false;
          if (parent === anc) return true;
          if (seen.has(parent)) return false;
          seen.add(parent);
          cur = parent;
        }
        return false;
      },
      packWithRoom: () => {
        for (const g of orders.get(PACKS_KEY) || []) {
          const r = displayRow(g);
          if (r && !isOpenableContainer(r)) continue;
          const c = capacityOf(g);
          if (c.cap === 0 || c.used < c.cap) return g;
        }
        return 0;
      },
      // ItemHolder::AttemptAutoMerge — the same rule a take uses
      // (inventory_helpers.findAutoMergeTarget): the TARGET's stack limit
      // counts, so a corpse / chest row without one still merges.
      autoMergeTarget: (item, amount, key) => {
        const keys = key === MAIN_PACK_KEY ? [MAIN_PACK_KEY, ...(orders.get(PACKS_KEY) || [])] : [key];
        const rowsInOrder = [];
        for (const k of keys) {
          for (const g of orders.get(k) || []) {
            const r = rowsByGuid.get(g);
            if (r) rowsInOrder.push(r);
          }
        }
        return (findAutoMergeTarget(item, amount, rowsInOrder)?.guid >>> 0) || 0;
      },
      // items-4 (`?retailAutoWear`): AutoWearIsLegal refusal on the figure /
      // an armour slot, AttemptMerge onto a held ready-slot stack.
      ...(RETAIL_AUTO_WEAR ? {
        wearPlan: (item) => planWear(rowsByGuid.get(item?.guid >>> 0) || item, rows),
        readySlotOccupant: (mask) => readySlotOccupant(rows, mask),
      } : {}),
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
    // A quiet refusal (`refused` no-op: a ready slot the item cannot go in)
    // still shows the reject highlight, but its release is silent.
    const ok = action.op !== "reject" && !action.refused;
    // Passing a weapon over the figure on its way to a ready slot should
    // not flash the whole paperdoll red; the release still explains.
    const hl = (!ok && target.kind === DROP_TARGET.DOLL) ? null : el;
    return { el: hl, ok, reason: action.message, silent: !!action.refused, target, scope };
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
          uiEffects: (s.item?.uiEffects >>> 0) || 0,
          iconOverlay: (s.item?.iconOverlay >>> 0) || 0,
          iconUnderlay: (s.item?.iconUnderlay >>> 0) || 0,
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
          const row = displayRow(pg);
          return hitFor(bag, s, {
            kind: DROP_TARGET.PACK_SLOT, packGuid: pg, packName: row?.name || "pack",
            canHoldItems: !row || isOpenableContainer(row),
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

  mountedApi = { selectPack: (g) => selectPack(g) };

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
    pollTimer?.unref?.();
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
    viewportLoadTimer?.unref?.();
  }

  // Bug 13 (2026-10-07): loop.js calls this once the LOCAL player's
  // appearance change (equip → ObjDescEvent → applyAppearance) has landed on
  // the rig meta, so the doll redresses even when the inventory refresh ran
  // before the new ObjDesc arrived.
  window.__refreshPaperdoll = refreshPaperdollViewport;

  // ESC clears the armed-item state (skip while typing).
  function onKey(ev) {
    if (ev?.key !== "Escape") return;
    const tag = ev.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if ((window.__inventory?.armedGuid >>> 0) !== 0) setArmedItem(0);
  }
  window.addEventListener("keydown", onKey);

  const onOverlayStateEvent = () => refreshUiItemStates();
  const onResize = () => { cachedDollHitRect = null; };
  window.addEventListener("hb-vendor-sell-list", onOverlayStateEvent);
  window.addEventListener("hb-vendor-closed", onOverlayStateEvent);
  window.addEventListener("hb-hotbar-changed", onOverlayStateEvent);
  window.addEventListener("resize", onResize);

  const unsubs = [];
  unsubs.push(pendingOps.onChange(scheduleRebuild));
  try {
    const client = window.__pluginClient;
    if (client?.events?.on) {
      const onStats = () => { refreshBurden(); refreshAetheriaGating(); refreshUiItemStates(); };
      const onOwnedContainerOpened = (ev) => {
        const d = ev?.detail;
        const g = (d?.u32Payload ?? d?.u32_payload ?? 0) >>> 0;
        if (!g) return;
        clearUnconfirmedContainerView(g);
        viewedContainers.add(g);
        if (g === selectedPackContainerId || rowsByGuid.has(g)) scheduleRebuild();
      };
      const onActionRejected = (ev) => {
        const d = ev?.detail ?? ev;
        const g = (d?.u32Payload ?? d?.u32_payload ?? d?.guid ?? 0) >>> 0;
        clearUnconfirmedContainerView(g);
      };
      // 2026-10-07 — kind:47/49 fire for every wielder transition in view;
      // rebuild (panel + doll) only for ours (inventory_helpers.js
      // wieldEventTouchesLocal). Read synchronously: the detail is the wasm
      // ClientEvent box, freed after the drain iteration.
      const onWieldChange = (ev) => {
        if (wieldEventTouchesLocal(ev?.detail ?? ev, localPlayerGuid(), (g) => rowsByGuid.has(g))) {
          scheduleRebuild();
        } else {
          rebuildStats.wieldEventsSkipped += 1;
        }
      };
      const evs = [
        ["playerStatsUpdated", onStats],
        ["playerInventoryChanged", scheduleRebuild],
        ["containerOpened", onOwnedContainerOpened],
        ["clientActionRejected", onActionRejected],
        ["kind:48", onActionRejected],
        ["sharedCooldownChanged", onOverlayStateEvent],
        ["tradeUpdated", onOverlayStateEvent],
        ["kind:47", onWieldChange],
        ["kind:49", onWieldChange],
      ];
      for (const [name, fn] of evs) {
        client.events.on(name, fn);
        unsubs.push(() => { try { client.events.off?.(name, fn); } catch (_) {} });
      }
    }
  } catch (_) { /* bus may not be initialized yet */ }

  return () => {
    window.removeEventListener("keydown", onKey);
    publishSelection(0); // the view (and its selection) is gone (W1-8 seam)
    window.removeEventListener("hb-vendor-sell-list", onOverlayStateEvent);
    window.removeEventListener("hb-vendor-closed", onOverlayStateEvent);
    window.removeEventListener("hb-hotbar-changed", onOverlayStateEvent);
    window.removeEventListener("resize", onResize);
    if (cdTimer) { clearInterval(cdTimer); cdTimer = 0; }
    delete window.__isInventoryItem;
    if (window.__inventoryRebuildStats === rebuildStats) delete window.__inventoryRebuildStats;
    if (window.__refreshPaperdoll === refreshPaperdollViewport) delete window.__refreshPaperdoll;
    if (pollTimer) clearInterval(pollTimer);
    if (viewportLoadTimer) clearInterval(viewportLoadTimer);
    for (const u of unsubs) { try { u(); } catch (_) {} }
    for (const u of unregisterZones) { try { u(); } catch (_) {} }
    for (const o of observers) o.disconnect();
    for (const cell of cellCache.values()) clearTimeout(cell._tipTimer);
    if (mountedApi) mountedApi = null;
    hideItemTooltip();
    // Wave 14 / hud-audio-2 — hand the doll back: the canvas leaves the
    // overlay, the context parks for the next open (`?paperdollPersist=off`
    // restores the old dispose + forceContextLoss here).
    try { paperdollViewport.release(); } catch (_) {}
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
  const wantSet = new Set(want);
  let cur = parent.firstChild;
  for (const el of want) {
    if (el === cur) { cur = cur.nextSibling; continue; }
    parent.insertBefore(el, cur);
  }
  while (cur) {
    const next = cur.nextSibling;
    if (!wantSet.has(cur)) cur.remove();
    cur = next;
  }
}
