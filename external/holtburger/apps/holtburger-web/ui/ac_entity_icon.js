// Shared per-entity icon resolver (cross-find Pattern H).
//
// Pre-2026-06-05 each HUD panel (hotbar, buffs-hud, examine, indicators)
// invented its own placeholder icon — compass disk, blue orb, emoji —
// because the icon-resolution paths through wasm/SpellTable/inventory
// were duplicated per-panel. This helper consolidates the three
// resolution sources behind a single `resolveBindingIcon(binding)` API:
//
//   { spellId: <u32> }                   → SpellTable.spells[spellId].iconId
//   { itemGuid: <u32> }                  → SessionHandle.playerInventory iconId
//                                          → __wom entity.meta.iconId fallback
//   { iconId: <u32> }                    → direct DAT icon fetch
//
// Returns a `data:image/png;base64,...` URL ready to drop into a CSS
// `background-image`, or null if the binding can't be resolved (wasm
// not loaded, spell record absent, item not in player's inventory).
// Uses the shared `ac_icon_cache.js` so the same icon fetched by one
// panel is instant for the next.

import { fetchIconDataUrl } from "./ac_icon_cache.js";

/**
 * Resolve any of the supported binding shapes to a CSS-ready data URL.
 * @param {object|null} binding
 * @returns {Promise<string|null>}
 */
export async function resolveBindingIcon(binding) {
  if (!binding) return null;
  if (binding.iconId) return fetchIconDataUrl(binding.iconId >>> 0, "entity-icon:direct");
  if (binding.spellId) return resolveSpellIcon(binding.spellId >>> 0);
  if (binding.itemGuid) return resolveItemIcon(binding.itemGuid >>> 0);
  return null;
}

/**
 * Synchronous variant of `resolveBindingIcon` for the
 * `getIconImmediate` fast-path (when the icon is already cached after
 * a previous resolve / bulk preload). Returns null if not yet in the
 * cache or the spell/item lookup misses.
 */
export function resolveBindingIconImmediate(binding) {
  if (!binding) return null;
  // Falls through to async paths on cache-miss; callers should treat
  // null as "not yet — try the async path".
  if (binding.iconId) return null; // direct path is one wasm call away anyway
  if (binding.spellId) {
    const iconId = lookupSpellIconId(binding.spellId >>> 0);
    if (!iconId) return null;
    return null; // ac_icon_cache.getIconImmediate would be the right hook
  }
  return null;
}

/** Resolve `spellId → SpellTable.spells[spellId].iconId → DAT fetch`. */
export async function resolveSpellIcon(spellId) {
  const iconId = lookupSpellIconId(spellId);
  if (!iconId) return null;
  return fetchIconDataUrl(iconId, "entity-icon:spell");
}

function lookupSpellIconId(spellId) {
  try {
    const handle = window.__sessionHandle ?? null;
    if (handle?.getSpellRecord) {
      const rec = handle.getSpellRecord(spellId >>> 0);
      // getSpellRecord crosses the wasm boundary via serde-wasm-bindgen,
      // which emits a Map — `rec.iconId` was undefined on it, so EVERY
      // spell icon (hotbar spell bindings, spell strip) silently fell
      // back to the placeholder (2026-07-01, same root cause as
      // spellbook.js spellRecordFromWasm).
      const iconId = (rec instanceof Map) ? rec.get("iconId") : rec?.iconId;
      if (typeof iconId === "number") return iconId >>> 0;
    }
  } catch (_) {
    // getSpellRecord throws pre-SpellTable-load; treat as cache-miss
    // and let the caller retry on the next render tick.
  }
  return null;
}

/** Resolve `itemGuid → inventory entry iconId → WOM entity meta fallback`. */
export async function resolveItemIcon(itemGuid) {
  const iconId = lookupItemIconId(itemGuid);
  if (!iconId) return null;
  return fetchIconDataUrl(iconId, "entity-icon:item");
}

function lookupItemIconId(itemGuid) {
  const g = (itemGuid >>> 0);
  // Primary source: SessionHandle.playerInventory() flat snapshot the
  // inventory plugin refreshes on every InventoryUpdated event. The
  // snapshot is the WorldState's source of truth for owned items.
  try {
    const handle = window.__sessionHandle ?? null;
    const inv = handle?.playerInventory?.();
    if (Array.isArray(inv) || (inv && typeof inv.length === "number")) {
      for (const it of inv) {
        if (((it?.guid >>> 0) === g) && it?.iconId) return it.iconId >>> 0;
      }
    }
  } catch (_) {}
  // Fallback: WorldObjectManager taxonomy mirror (populated by
  // ObjectCreate events; carries `meta.iconId` for non-inventory
  // entities the player may have bound — e.g. a hotbar slot that
  // references a dropped item still in pickup range).
  try {
    const wom = window.__wom;
    const ent = wom?.get?.(g);
    const iconId = (ent?.meta?.iconId ?? ent?.iconId) >>> 0;
    if (iconId) return iconId;
  } catch (_) {}
  return null;
}
