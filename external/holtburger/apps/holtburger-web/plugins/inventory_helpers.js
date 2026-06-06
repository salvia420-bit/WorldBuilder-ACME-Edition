// Pure helpers for the inventory window — split out of inventory.js so
// they can be unit-tested in Node without pulling the three.js /
// DOM-bound transitive imports. The DOM-side refresh wrappers in
// inventory.js (refreshAetheriaGating / refreshBurdenText /
// refreshPanelTitle / refreshSlotsView) delegate here for the actual
// decision logic.
//
// All four helpers are direct ports of retail behaviours catalogued
// in the Wave D.1 gmInventoryUI completeness audit
// (docs/wave-d1-inventory-audit-2026-05-27.md):
//
//   - aetheriaSlotIsLocked   gmPaperDollUI::UpdateAetheria
//                            (ACBindings gmPaperDollUI.cs:217-222)
//   - formatBurdenText       gmBackpackUI::SetLoadLevel
//                            (ACBindings gmBackpackUI.cs:151-156)
//                            numeric-label leg
//   - computeInventoryTitle  gmInventoryUI::RecvNotice_NewParentContainer
//                            (ACBindings gmInventoryUI.cs:218-223)
//   - parseSlotsViewChecked  gmPaperDollUI::m_SlotCheckbox state
//                            (ACBindings gmPaperDollUI.cs:134, retail
//                            wiring at acclient.c:221636,221667,221698)

/**
 * Compute the AetheriaBitfield-based gating decision for a single
 * sigil slot. Bit set in PropertyInt::AetheriaBitfield (322) →
 * unlocked → visible. ACE AetheriaBitfield: Blue=0x1, Yellow=0x2,
 * Red=0x4. Per ACE Player_Properties.cs:1273 the property is REMOVED
 * when value is zero, so an absent property cleanly maps to 0 — no
 * sigils unlocked.
 *
 * @param {number} aetheriaBits  PropertyInt 322 value (u32). Pass 0
 *                               pre-quest / pre-spawn.
 * @param {number} slotBit       One of Blue=0x1, Yellow=0x2, Red=0x4.
 * @returns {boolean} true = locked (hide slot); false = unlocked.
 */
export function aetheriaSlotIsLocked(aetheriaBits, slotBit) {
  const b = (aetheriaBits | 0) >>> 0;
  const m = (slotBit | 0) >>> 0;
  if (m === 0) return false;   // not an aetheria slot; never locked
  return (b & m) === 0;
}

/**
 * Format a burden float (encumbrance / capacity per ACE
 * EncumbranceSystem.GetBurden, 0.0..N) as a percent string.
 *
 * @param {number} burden  0.0..N float. NaN / negative / 0 / Infinity → "—".
 * @returns {{ text: string, over: boolean }} where `over` is true at
 *          or above capacity (>=1.0) so the caller can apply a red
 *          color cue.
 */
export function formatBurdenText(burden) {
  if (!Number.isFinite(burden) || burden <= 0) {
    return { text: "—", over: false };
  }
  // burden is `encumbrance / capacity` so multiply by 100 for a
  // human-readable percentage. Math.round uses half-away-from-zero in
  // JS (unlike C# Math.Round's banker's rounding) — matches retail's
  // text representation (e.g. "85%" not "85.3%").
  const pct = Math.round(burden * 100);
  const over = burden >= 1.0;
  return { text: `${pct}%`, over };
}

/**
 * Compute the inventory panel title for the current container
 * selection. Main pack → "Inventory of <player>"; side pack →
 * "Contents of <pack name>".
 *
 * @param {number} selectedContainerId  Currently selected pack guid (0
 *                                      = main pack).
 * @param {Array<{containerId:number,name:string}|null>} bagSlots  Bag
 *                                      tab slot table; entries are null
 *                                      for empty pack slots.
 * @param {string|null} playerName       Player display name (used in
 *                                      the main-pack title); empty
 *                                      falls back to "Inventory".
 * @returns {string}
 */
export function computeInventoryTitle(selectedContainerId, bagSlots, playerName) {
  if (selectedContainerId !== 0) {
    const slot = bagSlots.find((s) => s && s.containerId === selectedContainerId);
    const packName = slot?.name || "Pack";
    return `Contents of ${packName}`;
  }
  const name = (playerName || "").trim();
  return name ? `Inventory of ${name}` : "Inventory";
}

/**
 * Parse a persisted m_SlotCheckbox state value to a boolean. The
 * retail default (per `acclient.c:221667` —
 * `SetAttribute_Bool(m_SlotCheckbox, 0xE, 0)` at PostInit) is
 * **unchecked** (paperdoll view); we mirror that by treating
 * missing/malformed values as `false`. Only the literal string `"1"`
 * (what we write on toggle-on) flips us into Slots view, so a
 * tampered/garbage localStorage entry can't accidentally hide the
 * paperdoll on next mount.
 *
 * Reading-guide compliance: doc-comments are triage (anti-pattern #2),
 * but the SetAttribute_Bool default-zero call at the constructor's
 * tail is verbatim from acclient.c, not the C# doc-comment — so the
 * unchecked default is spec-grade.
 *
 * @param {string|null|undefined} raw  Value from localStorage.
 * @returns {boolean} true = Slots view (flat list); false = Paperdoll view.
 */
export function parseSlotsViewChecked(raw) {
  return raw === "1";
}

// EquipMask bits used by canEquipInSlot (mirrors ACE EquipMask.cs values
// already referenced by inventory.js PAPERDOLL_SLOTS).
export const EQUIP = Object.freeze({
  MeleeWeapon:  0x00100000,
  Shield:       0x00200000,
  MissileWeapon:0x00400000,
  MissileAmmo:  0x00800000,
  Held:         0x01000000,
  TwoHanded:    0x02000000,
  TrinketOne:   0x04000000,
  Cloak:        0x08000000,
  SigilBlue:    0x10000000,
  SigilYellow:  0x20000000,
  SigilRed:     0x40000000,
});
// Per ACE.Entity/Enum/ItemType.cs: Container = 0x00000200. (0x40000000 is
// TinkeringMaterial; mis-bit caused the right-click Open and double-click
// open paths to silently never match real sacks/pouches.)
export const ITEM_TYPE_CONTAINER = 0x00000200;
export const ITEM_TYPE_SIGIL = 0x00020000; // Aetheria sigil

// CombatStyle bits — DefaultCombatStyle PropertyInt 46.
export const COMBAT_STYLE_CASTER = 0x00000040; // Magic Caster
export const COMBAT_STYLE_AMMO_LAUNCHER = 0x00008000; // ranged that consumes ammo

/**
 * Build a derived equip-state snapshot from the wasm playerInventory()
 * array. Mirrors ACE Player_Inventory.cs:1746-1902 inputs.
 *
 * @param {Array<object>} snapshot  Result of handle.playerInventory().
 * @param {object}        opts      {stance?: number, inCombatMode?: boolean}
 * @returns {{equippedByMask:Object, mainWeapon:object|null, offhand:object|null, stance:number, inCombatMode:boolean}}
 */
export function buildPlayerEquipState(snapshot, opts) {
  const inv = Array.isArray(snapshot) ? snapshot : [];
  const o = opts || {};
  const out = {
    equippedByMask: Object.create(null),
    mainWeapon: null,
    offhand: null,
    stance: (o.stance >>> 0) || 0,
    inCombatMode: !!o.inCombatMode,
  };
  for (const it of inv) {
    const m = (it?.equipMask >>> 0) || 0;
    if (m === 0) continue;
    out.equippedByMask[m] = it;
    if ((m & (EQUIP.MeleeWeapon | EQUIP.MissileWeapon | EQUIP.TwoHanded)) !== 0) {
      out.mainWeapon = it;
    }
    if ((m & (EQUIP.Shield | EQUIP.Held)) !== 0) {
      out.offhand = it;
    }
  }
  return out;
}

/**
 * Slot-typing validator. Pure function, returns { ok, reason } where
 * reason is the RETAIL-string rejection text ("A shield may not be worn
 * with the %s", "Cannot hold %s while in combat") with %s pre-filled.
 * Fails OPEN with ok=true when item.validLocations is 0 (Wave A may not
 * have populated it yet) — caller flags a 'speculative' tooltip.
 *
 * Mirrors ACE Player_Inventory.cs:1746-1902 rejection cascade:
 *   - Shield rejected by TwoHanded OR Caster OR AmmoLauncher main-hand
 *   - Caster requires non-combat (cannot hold caster while in combat
 *     with a melee weapon equipped)
 *   - Ammo: ammoType must match the equipped MissileWeapon's expected ammo
 */
export function canEquipInSlot(item, slotMask, playerEquipState) {
  if (!item) return { ok: false, reason: "No item." };
  const slot = (slotMask >>> 0) || 0;
  const vl = (item.validLocations >>> 0) || 0;
  if (vl === 0) {
    return { ok: true, speculative: true, reason: "" };
  }
  if (slot !== 0 && (vl & slot) === 0) {
    return { ok: false, reason: "This item cannot be worn in that slot." };
  }
  const state = playerEquipState || { equippedByMask: {} };
  const main = state.mainWeapon;
  const mainCombatStyle = (main?.defaultCombatStyle >>> 0) || 0;
  const mainMask = (main?.equipMask >>> 0) || 0;
  // Shield rejection cascade.
  if (slot === EQUIP.Shield || (vl & EQUIP.Shield) !== 0) {
    if (main && (mainMask & EQUIP.TwoHanded) !== 0) {
      return { ok: false, reason: `A shield may not be worn with the ${main.name || "two-handed weapon"}` };
    }
    if (main && (mainCombatStyle & COMBAT_STYLE_CASTER) !== 0) {
      return { ok: false, reason: `A shield may not be worn with the ${main.name || "caster"}` };
    }
    if (main && (mainCombatStyle & COMBAT_STYLE_AMMO_LAUNCHER) !== 0) {
      return { ok: false, reason: `A shield may not be worn with the ${main.name || "missile weapon"}` };
    }
  }
  // Caster (Held) — cannot hold a caster while in combat with a melee weapon.
  const itemStyle = (item.defaultCombatStyle >>> 0) || 0;
  if ((slot === EQUIP.Held || (vl & EQUIP.Held) !== 0) && (itemStyle & COMBAT_STYLE_CASTER) !== 0) {
    if (state.inCombatMode && main && (mainMask & EQUIP.MeleeWeapon) !== 0) {
      return { ok: false, reason: `Cannot hold ${item.name || "caster"} while in combat` };
    }
  }
  // Ammo: ammoType must match the equipped MissileWeapon's expected ammoType.
  if (slot === EQUIP.MissileAmmo || (vl & EQUIP.MissileAmmo) !== 0) {
    const mw = state.equippedByMask[EQUIP.MissileWeapon] || null;
    const expected = (mw?.ammoType >>> 0) || 0;
    const have = (item.ammoType >>> 0) || 0;
    if (mw && expected !== 0 && have !== 0 && expected !== have) {
      return { ok: false, reason: `This ammunition does not fit your ${mw.name || "missile weapon"}` };
    }
  }
  return { ok: true, reason: "" };
}

/**
 * Hotbar-binding validator. Rejects Container items and Sigil items per
 * the user-authorized spec; everything else binds. Returns { ok, reason }.
 */
export function canBindToHotbar(item) {
  if (!item) return { ok: false, reason: "No item." };
  const itemType = (item.itemType >>> 0) || 0;
  if ((itemType & ITEM_TYPE_CONTAINER) !== 0) {
    return { ok: false, reason: "Containers cannot be bound to the hotbar." };
  }
  if ((itemType & ITEM_TYPE_SIGIL) !== 0) {
    return { ok: false, reason: "Sigils cannot be bound to the hotbar." };
  }
  return { ok: true, reason: "" };
}
