// plugins/contained_item_meta.js — what a container window shows for an item
// that lives inside a corpse, chest or pack (bug 1, 2026-10-07). Pure; reads
// the wasm entity store through SessionHandle getters.
//
// Contained items never get a 3D rig (model id 0 → the JS spawn gate drops
// them), so they are absent from `entityManager.entityMap`; and for a corpse
// they are not in `playerInventory()` either. Their ObjectCreate still lands
// in the wasm entity store (`world.entities`), which the rynth getters read:
// `objectName`, `objectIntProperty` (PropertyInt: ItemType 1, StackSize 12,
// UiEffects 18 — ACE PropertyInt.cs), `objectDataIdProperty` (PropertyDataId:
// IconOverlay 50, IconUnderlay 52), `objectWcid`, `getObjectIconId`.
//
// ACE sends the container's ViewContents BEFORE the items' CreateObjects
// (Container.SendInventory), so right after the open event an item may not be
// known yet: `resolveContainedItemMeta` returns null and the caller re-polls.

export const PROP_INT_ITEM_TYPE = 1;
export const PROP_INT_STACK_SIZE = 12;
export const PROP_INT_UI_EFFECTS = 18;
export const PROP_DID_ICON_OVERLAY = 50;
export const PROP_DID_ICON_UNDERLAY = 52;

/**
 * @param {object} handle SessionHandle (or a stub with the same getters)
 * @param {number} guid
 * @returns {null | {guid:number, name:string, iconId:number, stackSize:number,
 *   wcid:number, itemType:number, uiEffects:number, iconOverlay:number,
 *   iconUnderlay:number}}
 */
export function resolveContainedItemMeta(handle, guid) {
  const g = guid >>> 0;
  if (!g || !handle) return null;
  let name = null;
  try { name = handle.objectName?.(g) ?? null; } catch (_) { name = null; }
  if (typeof name !== "string" || !name.length) return null;
  const int = (k) => {
    try { const v = handle.objectIntProperty?.(g, k); return Number.isFinite(v) ? v : 0; }
    catch (_) { return 0; }
  };
  const did = (k) => {
    try { const v = handle.objectDataIdProperty?.(g, k); return Number.isFinite(v) ? (v >>> 0) : 0; }
    catch (_) { return 0; }
  };
  let iconId = 0;
  try { iconId = (handle.getObjectIconId?.(g) >>> 0) || 0; } catch (_) { iconId = 0; }
  let wcid = 0;
  try { wcid = (handle.objectWcid?.(g) >>> 0) || 0; } catch (_) { wcid = 0; }
  return {
    guid: g,
    name,
    iconId,
    stackSize: Math.max(1, int(PROP_INT_STACK_SIZE) || 1),
    wcid,
    itemType: int(PROP_INT_ITEM_TYPE) >>> 0,
    uiEffects: int(PROP_INT_UI_EFFECTS) >>> 0,
    iconOverlay: did(PROP_DID_ICON_OVERLAY),
    iconUnderlay: did(PROP_DID_ICON_UNDERLAY),
  };
}
