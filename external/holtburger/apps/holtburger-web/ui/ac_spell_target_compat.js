// =============================================================================
// spellcast-3 (2026-10-08) — retail target-compatibility pre-check (pure rules
// + a thin wasm-getter reader; no DOM)
// =============================================================================
//
// Retail refuses an incompatible selected target in the CLIENT and never sends
// the cast (acclient.c):
//   ClientMagicSystem::CastSpell (:404755-404776) — a spell with a non-zero
//     target type casts at ACCWeenieObject::selectedID only after
//     ObjectCompatibleWithSpell(selectedID, spell, quiet=0, displayCastMessage=1);
//     no selection prints "You must select a suitable target before casting
//     this spell". SelfTargeted (`_bitfield & 8`) and type-0 spells skip all of
//     this (they never read the selection).
//   ClientMagicSystem::ObjectCompatibleWithSpell (:404473-404509) —
//     InqTargetType -> ObjectCompatibleWithSpellTargetType; on success it prints
//     "Casting %hs" (the spell name).
//   ClientMagicSystem::ObjectCompatibleWithSpellTargetType (:403992-404107):
//     1. type 0 with a target          -> "This spell would require no target"
//     2. no target                     -> "This spell would require a target"
//     3. !(type & 0x8107) && target is the player
//                                      -> "You cannot cast this spell upon yourself"
//     4. object unknown (GetWeenieObject null) -> refused SILENTLY
//     5. pwd._stackSize > 1            -> "Cannot cast spell on a stack of items."
//     6. (!(InqType() & type) && !(type & 0x8107))
//        || (!IsPlayer() && !(pwd._bitfield & 0x10 ATTACKABLE))
//                                      -> "This spell cannot be cast on %s"
//     7. pwd._pet_owner != 0           -> "This spell cannot be cast on %s"
//   Field offsets verified against the PDB dump (vfptr[4] = IsPlayer =
//   `_bitfield >> 3 & 1` :437199, vfptr[6] = InqType; pwd @152: _stackSize @96,
//   _bitfield @104, _pet_owner @168). Strings have no trailing period except
//   the stack message.
//
// ACE's own check (Player_Magic.cs VerifySpellTarget) differs: it replies with
// "<spell> cannot be cast on <target>." plus UseDone(None) AFTER the rotate, so
// before this pre-check the client animated a full windup for a cast that
// never happened.
//
// Every fact comes from existing wasm getters: objectName (PropertyString
// Name), objectIntProperty 1 (ItemType, set on every CreateObject) and 12
// (StackSize), objectDescFlags (ObjectDescriptionFlag: 0x08 PLAYER,
// 0x10 ATTACKABLE), objectInstanceIdProperty 44 (PetOwner). Note ACE defaults
// Attackable to TRUE (WorldObject_Properties.cs), so items, portals and
// lifestones carry the ATTACKABLE bit and pass rule 6; vendors / NPCs
// (Attackable=false) are refused, as in retail.
//
// FAIL-OPEN: no spell record, no formula, a pkg without the getters, or a
// target the wasm does not know -> the cast is sent unchecked (the server stays
// authoritative). Retail's silent refusal of an unknown object (rule 4) is
// deliberately not copied: our object table can lag the 3D selection.
//
// `?spellTargetPrecheck=off` (also `0` / `false`; default ON) disables it.

import { inqTargetType } from "./ac_spell_target_type.js";

/** `_targetType & 0x8107` — MeleeWeapon|Armor|Clothing|MissileWeapon|Caster.
 *  A type with any of these bits may target the caster and skips the
 *  InqType mask test. */
export const SPECIAL_TARGET_MASK = 0x8107;
export const ODF_PLAYER = 0x08;
export const ODF_ATTACKABLE = 0x10;
export const PROP_INT_ITEM_TYPE = 1;
export const PROP_INT_STACK_SIZE = 12;
export const PROP_IID_PET_OWNER = 44;

export const MSG_NO_SELECTION = "You must select a suitable target before casting this spell";
export const MSG_REQUIRES_NO_TARGET = "This spell would require no target";
export const MSG_REQUIRES_TARGET = "This spell would require a target";
export const MSG_SELF = "You cannot cast this spell upon yourself";
export const MSG_STACK = "Cannot cast spell on a stack of items.";
export const msgCannotBeCastOn = (name) => `This spell cannot be cast on ${name}`;
export const castingNotice = (spellName) => `Casting ${spellName}`;

/** `?spellTargetPrecheck` (default ON; `off` / `0` / `false` disable). */
export function spellTargetPrecheckEnabled(search) {
  try {
    const s = search ?? (typeof window !== "undefined" ? window.location?.search : "") ?? "";
    const v = new URLSearchParams(s).get("spellTargetPrecheck")?.toLowerCase();
    return !(v === "off" || v === "0" || v === "false");
  } catch (_) { return true; }
}

/**
 * ClientMagicSystem::ObjectCompatibleWithSpellTargetType (acclient.c:403992).
 * `target` = { known, itemType, stackSize, descFlags, petOwner, name } for
 * `targetGuid` (ignored when the guid is 0). A missing itemType skips the
 * mask arm (fail-open); every other missing number reads as 0, as retail's
 * zero-initialised PublicWeenieDesc would.
 * @returns {null | { reason: string, message: string }} null = compatible;
 *   reason "unknownTarget" carries message "" (retail refuses silently).
 */
export function spellTargetRefusal({ targetType, targetGuid, playerGuid, target } = {}) {
  const tt = (targetType >>> 0) || 0;
  const tg = (targetGuid >>> 0) || 0;
  if (!tt) return tg ? { reason: "requiresNoTarget", message: MSG_REQUIRES_NO_TARGET } : null;
  if (!tg) return { reason: "requiresTarget", message: MSG_REQUIRES_TARGET };
  const special = (tt & SPECIAL_TARGET_MASK) !== 0;
  if (!special && tg === ((playerGuid >>> 0) || 0)) return { reason: "self", message: MSG_SELF };
  if (!target || !target.known) return { reason: "unknownTarget", message: "" };
  const stack = Number(target.stackSize) || 0;
  if (stack > 1) return { reason: "stack", message: MSG_STACK };
  const name = typeof target.name === "string" ? target.name : "";
  const itemType = Number.isFinite(target.itemType) ? (target.itemType >>> 0) : null;
  if (itemType != null && (itemType & tt) === 0 && !special) {
    return { reason: "type", message: msgCannotBeCastOn(name) };
  }
  const flags = (Number(target.descFlags) >>> 0) || 0;
  if (!(flags & ODF_PLAYER) && !(flags & ODF_ATTACKABLE)) {
    return { reason: "notAttackable", message: msgCannotBeCastOn(name) };
  }
  if ((Number(target.petOwner) >>> 0) !== 0) {
    return { reason: "pet", message: msgCannotBeCastOn(name) };
  }
  return null;
}

/**
 * The target facts from the wasm SessionHandle getters, or null when the pkg
 * lacks them (older build) or a getter throws — the caller fails open.
 * `known` = the wasm has a Name for the guid (every CreateObject carries one).
 */
export function readSpellTargetFacts(handle, guid) {
  try {
    if (!handle) return null;
    if (typeof handle.objectName !== "function" ||
        typeof handle.objectDescFlags !== "function" ||
        typeof handle.objectIntProperty !== "function") return null;
    const g = guid >>> 0;
    const name = handle.objectName(g);
    const known = typeof name === "string";
    const itemType = handle.objectIntProperty(g, PROP_INT_ITEM_TYPE);
    const stackSize = handle.objectIntProperty(g, PROP_INT_STACK_SIZE);
    const petOwner = typeof handle.objectInstanceIdProperty === "function"
      ? handle.objectInstanceIdProperty(g, PROP_IID_PET_OWNER)
      : undefined;
    return {
      known,
      name: known ? name : "",
      itemType: Number.isFinite(itemType) ? itemType : undefined,
      stackSize: Number.isFinite(stackSize) ? stackSize : 0,
      descFlags: (handle.objectDescFlags(g) >>> 0) || 0,
      petOwner: Number.isFinite(petOwner) ? petOwner : 0,
    };
  } catch (_) {
    return null;
  }
}

/** { name, selfTargeted, components } from getSpellRecord (a serde Map, or a
 *  plain object from older bundles); null when there is no record. */
export function spellRecordTargetInfo(rec) {
  if (!rec) return null;
  const get = (o, k) => (o instanceof Map ? o.get(k) : o?.[k]);
  const flags = get(rec, "flags");
  const self = get(rec, "isSelfTargeted");
  const selfTargeted = typeof self === "boolean" ? self : get(flags, "selfTargeted") === true;
  const name = get(rec, "name");
  const components = get(rec, "components");
  return {
    name: typeof name === "string" ? name : "",
    selfTargeted,
    components: Array.isArray(components) ? components : null,
  };
}

/**
 * The CastSpell-side decision for one cast at `targetGuid` (non-null):
 *   { verdict: "skip", reason }            — not checked; send as before
 *   { verdict: "refuse", reason, message } — do not send; show `message`
 *   { verdict: "pass", spellName }         — send; show castingNotice(spellName)
 * Only a targeted, non-SelfTargeted spell with a known formula is checked
 * (type-0 and SelfTargeted spells never read the selection in retail).
 */
export function checkSpellTarget(handle, spellId, targetGuid, playerGuid) {
  let rec = null;
  try { rec = handle?.getSpellRecord?.(spellId >>> 0) ?? null; } catch (_) { rec = null; }
  const info = spellRecordTargetInfo(rec);
  if (!info) return { verdict: "skip", reason: "noRecord" };
  if (info.selfTargeted) return { verdict: "skip", reason: "selfTargeted" };
  if (!info.components || info.components.length === 0) return { verdict: "skip", reason: "noFormula" };
  const targetType = inqTargetType(info.components);
  if (!targetType) return { verdict: "skip", reason: "untargeted" };
  const tg = (targetGuid >>> 0) || 0;
  // CastSpell's own no-selection branch (:404766), not rule 2's text.
  if (!tg) return { verdict: "refuse", reason: "noSelection", message: MSG_NO_SELECTION };
  const pg = (playerGuid >>> 0) || 0;
  // Rule 3 (self) needs no object facts; the rest do.
  const selfRefused = tg === pg && !(targetType & SPECIAL_TARGET_MASK);
  const target = selfRefused ? null : readSpellTargetFacts(handle, tg);
  if (!selfRefused && target == null) return { verdict: "skip", reason: "noGetters" };
  const refusal = spellTargetRefusal({ targetType, targetGuid: tg, playerGuid: pg, target });
  if (!refusal) return { verdict: "pass", spellName: info.name };
  if (refusal.reason === "unknownTarget") return { verdict: "skip", reason: "unknownTarget" };
  return { verdict: "refuse", reason: refusal.reason, message: refusal.message };
}

/** Retail shows these through the transient text type (0x1A — the same path
 *  as a server CommunicationTransientString, ClientSystem::AddTextToScroll):
 *  holtburger's transient chat category 9. A refusal also goes to the shared
 *  toast surface (`clientActionRejected`), as a server transient does. */
export const CHAT_CATEGORY_TRANSIENT = 9;

export function showTransientLine(text) {
  if (!text) return;
  try { if (typeof window !== "undefined") window.__appendChatLine?.(String(text), CHAT_CATEGORY_TRANSIENT); } catch (_) {}
}

/** Toast + transient line + `spellCastRejected` for a client-side refusal. */
export function announceCastRefusal(message, spellId) {
  if (!message) return;
  const w = (typeof window !== "undefined") ? window : null;
  const bus = w?.__pluginClient?.events;
  try { bus?.emit?.("clientActionRejected", { message }); } catch (_) {}
  if (spellId) {
    try {
      bus?.emit?.("spellCastRejected", {
        spellId: spellId >>> 0,
        casterGuid: (w?.getLocalPlayerGuid?.() ?? 0) >>> 0,
        reason: message,
      });
    } catch (_) {}
  }
  showTransientLine(message);
}
