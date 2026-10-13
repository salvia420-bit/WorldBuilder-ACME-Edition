// =============================================================================
// hud-ui-8 (2026-10-13) — the spell bar's ENDOWMENT icon (retail BuiltInSpell)
// =============================================================================
//
// Retail gmSpellcastingUI keeps one extra cell at the left of the spell bar,
// m_endowmentIcon (element 0x100000B1): the built-in spell of the caster in
// the player's hand.
//
//   UpdateEndowmentIcon (acclient.c:247815)
//     item = GetObjectAtLocation(player, 0x1000000 /* Held */, 0); the cell
//     shows only when that item's ItemType has the Caster bit (0x8000) and its
//     PublicWeenieDesc carries a _spellID (holtburger: PropertyDataId::Spell,
//     28 — crates/holtburger-world/src/hydration.rs). Underlay = the spell's
//     icon (ClientMagicSystem::GetSpellIcon), overlay = the item's drag icon
//     (ACCWeenieObject::GetDragIcon), both Blit_3Alpha; tooltip
//     "%s (%hs)\nDouble-click to cast this spell". With no spell selected on
//     the open tab it becomes the selection (m_endowmentSelected).
//   RecvNotice_Next/Prev/First/LastSpellSelection (:248837-249140)
//     the walk order is [endowment, item 0 … item N-1] and wraps.
//   Cast (:247774)
//     endowment selected → ItemHolder::UseObject(item, 1, 1) (:433354):
//     a targeted item (ItemUses::IsUseable_Targeted, ItemUseable & 0xFFFF0000)
//     sends UseWithTargetEvent on the selection, or with nothing selected the
//     0x1A line "Select your target before using the %s"; an untargeted one
//     sends UseEvent; a USEABLE_NO one says "The %s cannot be used". ACE
//     (Player_Use.cs HandleActionUseWithTarget) casts the item's SpellDID.
//   The cell's messages (ListenToElementMessage :249263): click (7) selects,
//     double-click (10) casts, right-click (8) examines the item.
//
// The rules below are pure (no DOM, no wasm) and pinned by
// tests/spellbar_endowment.test.mjs. The small readers at the bottom
// (readEndowment / readSpellName / endowmentIconUrls / castEndowment) are the
// glue plugins/combat-bar.js calls; they take the session handle as an
// argument.
//
// `?spellbarEndowment=off` (or 0/false) hides the cell and leaves the spell
// bar's selection and Cast exactly as before.

import { fetchItemIconDataUrl } from "./ac_icon_cache.js";
import { resolveSpellIcon } from "./ac_entity_icon.js";
import { showTransientLine } from "./ac_spell_target_compat.js";
import { consumeUseThrottle } from "../scene3d/target_cycle.js";
import { takeInventoryRows, wieldEventTouchesLocal } from "../plugins/inventory_helpers.js";

/** UpdateEndowmentIcon's GetObjectAtLocation mask — the Held (caster) slot. */
export const ENDOWMENT_LOCATION = 0x01000000;
/** ItemType Caster (`SBYTE1(InqType()) < 0` = bit 0x8000). */
export const ITEM_TYPE_CASTER = 0x00008000;
/** PropertyDataId::Spell (ACE PropertyDataId.cs) — the PWD _spellID. */
export const PROP_DID_SPELL = 28;
/** PropertyInt::ItemUseable (ACE PropertyInt.cs) — the PWD _useability. */
export const PROP_INT_ITEM_USEABLE = 16;
/** PropertyDataId IconOverlay / IconUnderlay (ACE PropertyDataId.cs). */
export const PROP_DID_ICON_OVERLAY = 50;
export const PROP_DID_ICON_UNDERLAY = 52;
/** The walk / selection token for the endowment cell. */
export const ENDOWMENT = "endowment";

const isOff = (v) => v === "off" || v === "0" || v === "false";

/** `?spellbarEndowment` — DEFAULT-ON; `off` / `0` / `false` = no endowment cell. */
export function spellbarEndowmentEnabled(search) {
  try {
    const s = search ?? (typeof window !== "undefined" ? window.location?.search : "") ?? "";
    return !isOff(new URLSearchParams(s).get("spellbarEndowment")?.toLowerCase());
  } catch (_) {
    return true;
  }
}

/**
 * UpdateEndowmentIcon's item test. `rows` are copyInventoryRow rows (guid,
 * name, itemType, equipMask, iconId, uiEffects); `didOf(guid, stype)` reads a
 * PropertyDataId. Retail takes THE object at the Held location and then
 * rejects it — a held non-caster is no endowment even if a caster with a
 * spell sits in the pack.
 * @returns {null|{guid:number, spellId:number, name:string, iconId:number,
 *   itemType:number, uiEffects:number}}
 */
export function findEndowment(rows, didOf) {
  if (!Array.isArray(rows)) return null;
  const held = rows.find((r) => (((r?.equipMask >>> 0) || 0) & ENDOWMENT_LOCATION) !== 0);
  if (!held) return null;
  const guid = (held.guid >>> 0) || 0;
  const itemType = (held.itemType >>> 0) || 0;
  if (!guid || (itemType & ITEM_TYPE_CASTER) === 0) return null;
  let spellId = 0;
  try { spellId = (typeof didOf === "function" ? (didOf(guid, PROP_DID_SPELL) >>> 0) : 0) || 0; } catch (_) { spellId = 0; }
  if (!spellId) return null;
  return {
    guid,
    spellId,
    name: (typeof held.name === "string" ? held.name : "") || "",
    iconId: (held.iconId >>> 0) || 0,
    itemType,
    uiEffects: (held.uiEffects >>> 0) || 0,
  };
}

/** The Spellcast_SpellName text with the endowment selected:
 *  UpdateCastButtonTooltip's "%s (%hs)" (item name, spell name). */
export function endowmentLabel(itemName, spellName) {
  return `${itemName || ""} (${spellName || ""})`;
}

/** UpdateEndowmentIcon's tooltip: "%s (%hs)\nDouble-click to cast this spell". */
export function endowmentTooltip(itemName, spellName) {
  return `${endowmentLabel(itemName, spellName)}\nDouble-click to cast this spell`;
}

/** ItemUses::IsUseable_Targeted (acclient.c:296838): any target-half bit. */
export function isUseableTargeted(useable) {
  return (((useable >>> 0) || 0) & 0xffff0000) !== 0;
}

/**
 * gmSpellcastingUI::Cast with the endowment selected = ItemHolder::UseObject
 * (item, _targetIsSelected 1, _forceUse 1). `targeted` defaults to
 * isUseableTargeted(useable). A refusal carries `reason` ("noSelection" /
 * "notUseable") next to its 0x1A line.
 * @returns {{useWithTarget:[number,number]}|{use:number}|{transient:string, reason:string}|{none:true}}
 */
export function endowmentCastAction(endow, { targeted, useable = 0, selectedGuid = 0 } = {}) {
  const item = (endow?.guid >>> 0) || 0;
  if (!item) return { none: true };
  const name = endow.name || "item";
  const isTargeted = typeof targeted === "boolean" ? targeted : isUseableTargeted(useable);
  if (isTargeted) {
    const target = (selectedGuid >>> 0) || 0;
    if (!target) return { transient: `Select your target before using the ${name}`, reason: "noSelection" };
    return { useWithTarget: [item, target] };
  }
  // ItemUses::IsUseable (:296802) is `!(bitfield & 1)`.
  if ((((useable >>> 0) || 0) & 1) !== 0) return { transient: `The ${name} cannot be used`, reason: "notUseable" };
  return { use: item };
}

/**
 * The spell-bar selection walk. `bound` = the open tab's bound slot indexes
 * (ascending); `cur` = ENDOWMENT, a slot index, or -1 (nothing selected);
 * `op` = "next" | "prev" | "first" | "last". Returns ENDOWMENT, a slot index,
 * or null (nothing to select).
 *
 * With the endowment present this is retail's walk (order [endowment,
 * 0..N-1], wrapping through the endowment; nothing selected → the first
 * item). Without it, the strip's own wrap over the bound cells, unchanged.
 */
export function endowmentWalk(bound, cur, op, present) {
  const list = Array.isArray(bound) ? bound : [];
  const n = list.length;
  if (present) {
    if (!n) return ENDOWMENT;
    if (op === "first") return ENDOWMENT;
    if (op === "last") return list[n - 1];
    const forward = op !== "prev";
    if (cur === ENDOWMENT) return forward ? list[0] : list[n - 1];
    const pos = list.indexOf(cur);
    if (pos === -1) return list[0];
    if (forward) return pos + 1 < n ? list[pos + 1] : ENDOWMENT;
    return pos > 0 ? list[pos - 1] : ENDOWMENT;
  }
  if (!n) return null;
  if (op === "first") return list[0];
  if (op === "last") return list[n - 1];
  const dir = op === "prev" ? -1 : 1;
  let pos = list.indexOf(cur);
  if (pos === -1) pos = dir > 0 ? -1 : 0;
  return list[(pos + dir + n) % n];
}

/** CSS background for the cell: the drag icon over the spell icon (the
 *  first listed layer paints on top). "" when neither resolved. */
export function endowmentBackground({ spell = null, item = null } = {}) {
  const layers = [];
  if (typeof item === "string" && item) layers.push(`url("${item}")`);
  if (typeof spell === "string" && spell) layers.push(`url("${spell}")`);
  return layers.join(", ");
}

/**
 * Does a kind:49 EntityAttached / kind:47 EntityDetached event (fired for
 * every wielder transition in view) concern the endowment? The local
 * player's own wield changes and anything about the current endowment item
 * do; an unreadable event counts (inventory_helpers wieldEventTouchesLocal).
 */
export function wieldEventMarksEndowment(detail, localGuid, endowGuid) {
  const g = (endowGuid >>> 0) || 0;
  return wieldEventTouchesLocal(detail, localGuid, (item) => g !== 0 && (item >>> 0) === g);
}

// ---------------------------------------------------------------------------
// Glue for plugins/combat-bar.js (the handle is passed in; nothing is cached).
// ---------------------------------------------------------------------------

function didReader(handle) {
  return (guid, stype) => {
    try {
      const v = handle?.objectDataIdProperty?.(guid >>> 0, stype);
      return Number.isFinite(v) ? (v >>> 0) : 0;
    } catch (_) {
      return 0;
    }
  };
}

/** UpdateEndowmentIcon over the live inventory snapshot, plus the drag-icon
 *  inputs (custom overlay / underlay) for the cell. null = no endowment. */
export function readEndowment(handle) {
  if (!handle || typeof handle.playerInventory !== "function") return null;
  let rows = [];
  try { rows = takeInventoryRows(handle); } catch (_) { rows = []; }
  const didOf = didReader(handle);
  const e = findEndowment(rows, didOf);
  if (!e) return null;
  return {
    ...e,
    iconMeta: {
      iconId: e.iconId,
      itemType: e.itemType,
      uiEffects: e.uiEffects,
      iconOverlay: didOf(e.guid, PROP_DID_ICON_OVERLAY),
      iconUnderlay: didOf(e.guid, PROP_DID_ICON_UNDERLAY),
    },
  };
}

/** CSpellBase::InqName from the wasm SpellTable record (a Map across the
 *  serde boundary, or a plain object). null when unknown. */
export function readSpellName(handle, spellId) {
  try {
    const rec = handle?.getSpellRecord?.((spellId >>> 0) || 0);
    if (!rec) return null;
    const name = rec instanceof Map ? rec.get("name") : rec.name;
    return typeof name === "string" && name ? name : null;
  } catch (_) {
    return null;
  }
}

/** The two layers: the retail spell composite and the item's drag icon. */
export async function endowmentIconUrls(endow) {
  if (!endow) return { spell: null, item: null };
  const [spell, item] = await Promise.all([
    Promise.resolve(resolveSpellIcon(endow.spellId >>> 0)).catch(() => null),
    endow.iconMeta?.iconId
      ? Promise.resolve(fetchItemIconDataUrl(endow.iconMeta, "endowment", { drag: true })).catch(() => null)
      : null,
  ]);
  return {
    spell: typeof spell === "string" ? spell : null,
    item: typeof item === "string" ? item : null,
  };
}

/**
 * Cast with the endowment selected: ItemHolder::UseObject's 0.2 s
 * m_timeLastUsed gate (the one shared use throttle), then the action above.
 * The wasm sends are typeof-guarded (a stale pkg/ only loses the send).
 * @returns the action taken, or {throttled:true}
 */
export function castEndowment(handle, endow, { targetGuid = 0, now } = {}) {
  if (!endow) return { none: true };
  const t = Number.isFinite(now) ? now
    : (typeof performance !== "undefined" ? performance.now() : Date.now());
  if (!consumeUseThrottle(t)) return { throttled: true };
  let useable = 0;
  try {
    const v = handle?.objectIntProperty?.(endow.guid >>> 0, PROP_INT_ITEM_USEABLE);
    useable = Number.isFinite(v) ? (v >>> 0) : 0;
  } catch (_) {
    useable = 0;
  }
  const action = endowmentCastAction(endow, { useable, selectedGuid: targetGuid });
  try {
    if (action.transient) {
      showTransientLine(action.transient);
    } else if (action.useWithTarget) {
      if (typeof handle?.useWithTarget === "function") handle.useWithTarget(action.useWithTarget[0], action.useWithTarget[1]);
    } else if (action.use) {
      if (typeof handle?.useObject === "function") handle.useObject(action.use);
    }
  } catch (e) {
    console.warn("[spell-endowment] use failed:", e);
  }
  return action;
}
