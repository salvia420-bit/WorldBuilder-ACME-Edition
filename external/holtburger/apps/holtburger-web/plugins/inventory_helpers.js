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
// An Aetheria sigil is NOT an ItemType — there is no "Sigil" member in ACE's
// ItemType enum at all. Aetheria weenies are `ItemType.Gem` (0x800; LSD
// weenie 42635 "Coalesced Aetheria", intStats key 1 = 2048), so the only
// thing that makes an item a sigil is its EQUIP SLOT:
//   ACE.Entity/Enum/EquipMask.cs:40-42,50 —
//     SigilOne=0x10000000, SigilTwo=0x20000000, SigilThree=0x40000000,
//     Sigil = SigilOne|SigilTwo|SigilThree = 0x70000000
// which is exactly what inventory.js:261-263 PAPERDOLL_SLOTS (Aetheria
// Blue/Yellow/Red) and EQUIP.Sigil* above already use.
//
// The previous value here was 0x00020000 = **ItemType.Lockable** (see
// ACE ItemType.cs:26 and the repo's own note in
// world-objects/canonical_classify.js:46). That is the SAME mis-bit the
// salvage-panel path already had to fix once — inventory.js:1959-1961:
//   "IT_TINKERING_TOOL = 0x20000000 ... NOT 0x00020000 (= IT_LOCKABLE)".
// Consequence of the old value: no sigil was ever rejected (they bound to
// the hotbar despite the spec), while Lockable-typed items were.
export const EQUIP_SIGIL_MASK = EQUIP.SigilBlue | EQUIP.SigilYellow | EQUIP.SigilRed; // 0x70000000

// CombatStyle bits — DefaultCombatStyle PropertyInt 46.
export const COMBAT_STYLE_CASTER = 0x00000040; // Magic Caster
export const COMBAT_STYLE_AMMO_LAUNCHER = 0x00008000; // ranged that consumes ammo

/**
 * Take ONE `playerInventory()` snapshot and hand back an explicit release.
 *
 * Every call to `SessionHandle.playerInventory()` returns a FRESH array of
 * wasm-bindgen boxes, so resolving N guids one-at-a-time allocates
 * N x (inventory size) of them. They are FinalizationRegistry-registered so
 * this is not a permanent leak, but the JS wrapper is tiny while the Rust
 * allocation is not: the GC gets no pressure signal and the wasm linear
 * memory high-water mark ratchets up (wasm memory never shrinks).
 *
 * Callers must copy the primitives they need out of each box and MUST NOT
 * retain a box past `free()`.
 *
 * @param {object|null} handle  `window.__sessionHandle` (or a stub in tests).
 * @returns {{ inv: any[], free: () => void }}
 */
export function takeInventorySnapshot(handle) {
  let inv = null;
  if (handle && typeof handle.playerInventory === "function") {
    try { inv = handle.playerInventory(); } catch (_) { inv = null; }
  }
  const list = Array.isArray(inv) ? inv : [];
  return {
    inv: list,
    free() {
      for (const it of list) { try { it?.free?.(); } catch (_) { /* already freed */ } }
    },
  };
}

/**
 * Suggested ACE CombatMode for the local player when leaving Peace,
 * derived from the equipped weapon. Mirrors ACE's weapon-class branch
 * in `GetCombatMode()` — a hardcoded Melee makes bow/wand wielders'
 * Combat toggle silently revert server-side (F11-1).
 *
 * Returns an ACE CombatMode FLAG value suitable for
 * `handle.setCombatMode()`: NonCombat=1, Melee=2, Missile=4, Magic=8.
 * Defaults to Melee (unarmed → retail HandCombat) when no weapon /
 * empty inventory.
 *
 * @param {Array<object>} snapshot  `handle.playerInventory()` result.
 * @returns {number} ACE CombatMode flag (2 | 4 | 8).
 */
export function suggestedCombatModeFromInventory(snapshot) {
  const inv = Array.isArray(snapshot) ? snapshot : [];
  // Missile launcher equipped → Missile mode.
  if (inv.some((it) => ((it?.equipMask >>> 0) & EQUIP.MissileWeapon) !== 0)) return 4;
  // Caster (wand / orb / sceptre) → Magic mode. Prefer the
  // DefaultCombatStyle caster bit; fall back to the Held slot when the
  // combat-style int isn't hydrated yet.
  if (inv.some((it) =>
      (((it?.defaultCombatStyle >>> 0) & COMBAT_STYLE_CASTER) !== 0) ||
      ((it?.equipMask >>> 0) & EQUIP.Held) !== 0)) {
    return 8;
  }
  // Melee weapon, or unarmed.
  return 2;
}

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
  const equipMask = (item.equipMask >>> 0) || 0;
  if (vl === 0) {
    // Weapon-type items must NOT speculatively pass when validLocations
    // hasn't hydrated — ACE Creature.TrySetChild rejects multi-bit / wrong
    // wield masks server-side, causing combat-toggle revert (F11-1). Non-
    // weapon items keep speculative-ok so armor/clothing isn't gated.
    const WEAPON_BITS = EQUIP.MeleeWeapon | EQUIP.MissileWeapon | EQUIP.Held | EQUIP.TwoHanded;
    if ((equipMask & WEAPON_BITS) !== 0) {
      return { ok: false, reason: "Item attributes pending — try again." };
    }
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
 * Format an AppraisalProfile snapshot (`handle.getObjectAppraisal(guid)`
 * result, JSON-parsed) into a short multi-line tooltip body. Returns
 * `null` when the snapshot has nothing useful to show — the caller
 * should fall back to its plain name-only tooltip in that case.
 *
 * Mirrors the ItemExamineUI.Appraisal_Show* line ordering: name,
 * a quick stats row (workmanship + value + burden), then per-profile
 * lines (armor / weapon / wield requirement) when present.
 *
 * @param {string} name — caller's primary label (item.name)
 * @param {object} snapshot — parsed AppraisalProfile snapshot
 * @returns {string|null}
 */
export function formatAppraisalTooltip(name, snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const props = snapshot.properties || {};
  const ints = props.ints || {};
  const ap = snapshot.armorProfile || null;
  const wp = snapshot.weaponProfile || null;
  const lines = [];
  if (typeof name === "string" && name.length > 0) lines.push(name);
  const headerBits = [];
  if (ints.ItemWorkmanship != null) headerBits.push(`Wkm ${ints.ItemWorkmanship}`);
  if (ints.Value != null) headerBits.push(`${ints.Value}p`);
  if (ints.EncumbranceVal != null) headerBits.push(`Bur ${ints.EncumbranceVal}`);
  if (headerBits.length > 0) lines.push(headerBits.join(" · "));
  if (ap?.armor_level != null) {
    const mods = [];
    if (ap.physical_mod != null) mods.push(`P${Number(ap.physical_mod).toFixed(1)}`);
    if (ap.fire_mod != null) mods.push(`F${Number(ap.fire_mod).toFixed(1)}`);
    if (ap.cold_mod != null) mods.push(`C${Number(ap.cold_mod).toFixed(1)}`);
    lines.push(`AL ${ap.armor_level}${mods.length ? "  " + mods.join(" ") : ""}`);
  }
  if (wp) {
    const bits = [];
    if (wp.damage != null) bits.push(`Dmg ${wp.damage}`);
    if (wp.damage_variance != null) bits.push(`Var ${Number(wp.damage_variance).toFixed(2)}`);
    if (wp.damage_mod != null && wp.damage_mod !== 1) {
      bits.push(`×${Number(wp.damage_mod).toFixed(2)}`);
    }
    if (bits.length > 0) lines.push(bits.join("  "));
  }
  if (ints.WieldDifficulty != null && ints.WieldSkillType != null) {
    lines.push(`Wield req ${ints.WieldSkillType} ${ints.WieldDifficulty}`);
  }
  if (lines.length <= 1) return null;
  return lines.join("\n");
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
  // Sigil = equip-slot test, not an item-type test (see EQUIP_SIGIL_MASK).
  // `validLocations` is the wield-slot mask for a packed item; `equipMask`
  // is the CURRENT wielded slot once it is worn — check both so an already
  // socketed sigil is rejected too.
  const slotBits = (((item.validLocations >>> 0) || 0) | ((item.equipMask >>> 0) || 0)) >>> 0;
  if ((slotBits & EQUIP_SIGIL_MASK) !== 0) {
    return { ok: false, reason: "Sigils cannot be bound to the hotbar." };
  }
  return { ok: true, reason: "" };
}
