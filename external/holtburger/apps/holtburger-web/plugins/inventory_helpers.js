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
 * Retail burden-meter fill fraction. Port of gmBackpackUI::SetLoadLevel
 * (acclient.c:222634): `level * (1/3)` clamped to [0, 1] — the meter is
 * FULL at 300 % burden, not 100 %.
 *
 * @param {number} level  encumbrance / capacity (ACE EncumbranceSystem.GetBurden).
 * @returns {number} 0..1
 */
export function burdenMeterFraction(level) {
  if (!Number.isFinite(level) || level <= 0) return 0;
  return Math.min(1, level / 3);
}

/**
 * Format a burden float (encumbrance / capacity per ACE
 * EncumbranceSystem.GetBurden, 0.0..N) as a percent string.
 *
 * HUD overhaul 2026-10-05 — retail-exact: gmBackpackUI::SetLoadLevel
 * (acclient.c:222634) prints `floor(clamp(level/3, 0, 1) * 300)` with
 * "%d%%", i.e. the percent is FLOORED (0.999 → "99%") and capped at
 * 300 %. The previous Math.round showed "100%" a hair under capacity.
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
  // `+ 1e-7` absorbs binary-float shortfall (0.29 * 100 = 28.999…) so the
  // floor matches the decimal the server meant.
  const pct = Math.floor(Math.min(burden, 3) * 100 + 1e-7);
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

// ════════════════════════════════════════════════════════════════════
// HUD overhaul 2026-10-05 — retail item drag & drop, pure core.
//
// Everything below is DOM-free so it can be pinned by
// tests/inventory_drag_rules.test.mjs. The DOM side (ghost, highlight,
// zones) lives in plugins/item_drag.js; the panels (inventory.js,
// corpse-loot-bar.js) describe WHAT is under the pointer and execute
// whatever `decideItemDrop` returns.
//
// Retail sources (acclient.c, read 2026-10-05):
//   UIElement_ItemList::AcceptDragObject   274286  merge → pack → place
//   ItemHolder::AttemptToPlaceInContainer  432899  fit / overflow / split
//   ItemHolder::IsMergeAttemptLegal        432033  same wcid, room left
//   ItemHolder::AttemptMerge               432468  amount = min(split, room)
//   ItemHolder::AttemptPlaceIn3D           433163  self / give / box / drop
//   gmPaperDollUI::AcceptPaperDollDragObject 220805 figure = AutoWear
//   UIElement_ItemList::ServerSaysAttemptFailed 274762 re-sync on failure
// ════════════════════════════════════════════════════════════════════

/** Order-model key for the player's main pack item list. */
export const MAIN_PACK_KEY = 0;
/** Order-model key for the player's side-pack (container) list. */
export const PACKS_KEY = "packs";
/** ValidLocations bits retail's paperdoll FIGURE accepts (armor + clothing +
 *  cloak): gmPaperDollUI::AcceptPaperDollDragObject tests `& 0x8007FFF`. */
export const WEARABLE_LOCATIONS = 0x08007fff;

/** Drop-target kinds a panel can report to `decideItemDrop`. */
export const DROP_TARGET = Object.freeze({
  ITEM_CELL: "item-cell",            // occupied cell of an item list
  EMPTY_CELL: "empty-cell",          // vacant cell / list background
  MAIN_PACK: "main-pack",            // retail Inv_MainPackSlot
  PACK_SLOT: "pack-slot",            // a side pack in Inv_ContainerList
  EMPTY_PACK_SLOT: "empty-pack-slot",
  DOLL_SLOT: "doll-slot",            // one paperdoll equip slot
  DOLL: "doll",                      // the paperdoll figure (drag mask)
  WORLD: "world",                    // the 3D view
});

/**
 * Plain-data copy of a wasm `InventoryItem` box — the fields the HUD reads.
 * Optional fields a newer wasm may surface (`placement`, `maxStackSize`)
 * are copied when present and left undefined otherwise, so callers can
 * feature-detect them.
 */
export function copyInventoryRow(it) {
  const row = {
    guid: (it?.guid >>> 0) || 0,
    wcid: (it?.wcid >>> 0) || 0,
    name: (typeof it?.name === "string" ? it.name : "") || "",
    iconId: (it?.iconId >>> 0) || 0,
    itemType: (it?.itemType >>> 0) || 0,
    uiEffects: (it?.uiEffects >>> 0) || 0,
    value: Number(it?.value) || 0,
    stackSize: Math.max(1, Number(it?.stackSize) || 1),
    equipMask: (it?.equipMask >>> 0) || 0,
    containerId: (it?.containerId >>> 0) || 0,
    validLocations: (it?.validLocations >>> 0) || 0,
    ammoType: (it?.ammoType >>> 0) || 0,
    defaultCombatStyle: (it?.defaultCombatStyle >>> 0) || 0,
    containersCapacity: (it?.containersCapacity >>> 0) || 0,
    itemsCapacity: (it?.itemsCapacity >>> 0) || 0,
    attuned: (it?.attuned >>> 0) || 0,
    bonded: (it?.bonded >>> 0) || 0,
    requiresBackpackSlot: typeof it?.requiresBackpackSlot === "boolean"
      ? it.requiresBackpackSlot
      : (((it?.itemType >>> 0) & ITEM_TYPE_CONTAINER) !== 0),
  };
  // Only real values: a wasm that reports "unknown" as -1 / 0 must not
  // look like server truth (placement) or a 0-size stack limit.
  if (Number.isFinite(it?.placement) && it.placement >= 0) row.placement = it.placement | 0;
  if (Number.isFinite(it?.maxStackSize) && it.maxStackSize > 0) row.maxStackSize = it.maxStackSize | 0;
  // items-4 (2026-10-08): ClothingPriority (PropertyInt 4, the coverage
  // mask retail AutoWearIsLegal intersects) and CombatUse (PropertyInt 51)
  // — only on a wasm that has the InventoryItem getters; absent = unknown.
  if (typeof it?.clothingPriority === "number") row.clothingPriority = it.clothingPriority >>> 0;
  if (typeof it?.combatUse === "number") row.combatUse = it.combatUse >>> 0;
  return row;
}

/**
 * ONE playerInventory() snapshot copied to plain rows, boxes freed before
 * returning (see takeInventorySnapshot for why the free matters).
 * @returns {Array<object>}
 */
export function takeInventoryRows(handle) {
  const snap = takeInventorySnapshot(handle);
  try {
    return snap.inv.map(copyInventoryRow);
  } finally {
    snap.free();
  }
}

/** Retail UseBackpackSlot: does this row live in the container list? */
export function rowUsesPackSlot(row) {
  if (!row) return false;
  if (typeof row.requiresBackpackSlot === "boolean") return row.requiresBackpackSlot;
  return ((row.itemType >>> 0) & ITEM_TYPE_CONTAINER) !== 0;
}

/**
 * Isolate a single wield-location bit from a multi-bit ValidLocations with
 * retail precedence (weapon-ready before held/two-handed; jewellery falls
 * through to the lowest set bit). Moved here from inventory.js so the
 * paperdoll-figure drop and double-click equip share one tested rule.
 */
export function pickWieldSlotMask(validLocations) {
  const v = (validLocations >>> 0) || 0;
  if (v === 0) return 0;
  if ((v & (v - 1)) === 0) return v;
  const PRECEDENCE = [
    0x00100000, 0x00200000, 0x00400000, 0x00800000, 0x01000000,
    0x02000000, 0x04000000, 0x08000000, 0x10000000, 0x20000000, 0x40000000,
  ];
  for (const bit of PRECEDENCE) if ((v & bit) !== 0) return bit;
  return (v & -v) >>> 0;
}

/**
 * Stack-merge amount — ItemHolder::IsMergeAttemptLegal + AttemptMerge.
 *   > 0  merge legal; move this many
 *     0  not a merge (different type, same object, not stackable)
 *    -1  same type but the destination stack is already full
 * `maxStackSize` is not on today's wasm snapshot; without it a merge is
 * only assumed when either side is visibly a stack (>1) — two singles of a
 * stackable type fall through to a plain placement, never a wrong merge.
 */
export function mergeAmount(src, dst, amount) {
  if (!src || !dst) return 0;
  if ((src.guid >>> 0) === (dst.guid >>> 0)) return 0;
  if (!src.wcid || (src.wcid >>> 0) !== (dst.wcid >>> 0)) return 0;
  if ((dst.equipMask >>> 0) !== 0) return 0;
  const srcStack = Math.max(1, src.stackSize | 0 || 1);
  const want = amount > 0 ? Math.min(amount, srcStack) : srcStack;
  const dstStack = Math.max(1, dst.stackSize | 0 || 1);
  const max = Number.isFinite(dst.maxStackSize) ? dst.maxStackSize
    : (Number.isFinite(src.maxStackSize) ? src.maxStackSize : NaN);
  if (Number.isFinite(max)) {
    if (max <= 1) return 0;
    const room = max - dstStack;
    if (room <= 0) return -1;
    return Math.min(want, room);
  }
  if (srcStack > 1 || dstStack > 1) return want;
  return 0;
}

/**
 * Retail list index math (UIElement_ItemList::AcceptDragObject): the drop
 * cell's index `dropIndex` in the target list; when the item already sits
 * earlier in the SAME list and the whole stack moves, the index shifts down
 * one (the removal closes the gap). Dropping on its own cell or the cell
 * right after it is a no-op.
 * @returns {{ noop: boolean, placement: number }}
 */
export function retailPlacement(sourceIndex, dropIndex, sameList, isSplit, listCount) {
  const count = Math.max(0, listCount | 0);
  let idx = Math.max(0, Math.min(dropIndex | 0, count));
  if (sameList && !isSplit && sourceIndex >= 0) {
    if (idx === sourceIndex || idx === sourceIndex + 1) return { noop: true, placement: sourceIndex };
    if (sourceIndex < idx) idx -= 1;
  }
  return { noop: false, placement: idx };
}

const NOOP = Object.freeze({ op: "noop" });
function reject(message) { return { op: "reject", message }; }

/**
 * THE retail drop decision. Pure: the caller describes the dragged item and
 * what is under the pointer; this returns the action to execute.
 *
 * @param {object} drag
 *   guid, item (plain row/meta: name, wcid, stackSize, maxStackSize?,
 *   validLocations, equipMask, isPack), owned (in the player's possession),
 *   sourceList {key, kind:"inventory"|"packs"|"ext"} | null, sourceIndex,
 *   split (amount the player chose; 0 = whole stack)
 * @param {object} target
 *   kind (DROP_TARGET), listKey, listKind ("inventory"|"ext"), index,
 *   count (items in that list), item (occupant row), packGuid, packName,
 *   slotMask, entity {guid, isSelf, isCreature, isPlayer, isOpenContainer, name}
 * @param {object} ctx
 *   playerGuid, canUseWith(src,dst)→bool|null, capacity(key)→{used,cap}|null,
 *   isCorpse(guid)→bool, containerName(key)→string,
 *   canEquip(item, mask)→{ok,reason}, packWithRoom(excludeKey)→guid|0,
 *   autoMergeTarget(item, amount, key)→guid|0, and (items-4, optional)
 *   wearPlan(item)→planWear result, readySlotOccupant(mask)→row|null,
 *   (charopt-4) dragOnPlayerOpensTrade
 * @returns {object} { op: "noop"|"reject"|"merge"|"usewith"|"move"|"wield"|"wear"|"give"|"trade"|"drop", … }
 */
export function decideItemDrop(drag, target, ctx = {}) {
  const guid = (drag?.guid >>> 0) || 0;
  if (!guid || !target) return NOOP;
  const it = drag.item || {};
  const me = (ctx.playerGuid >>> 0) || 0;
  const stack = Math.max(1, it.stackSize | 0 || 1);
  const amount = drag.split > 0 && drag.split < stack ? (drag.split | 0) : stack;
  const isSplit = amount < stack;
  const name = it.name || "item";
  const isPack = !!it.isPack;
  const src = drag.sourceList || null;
  const cap = (key) => { try { return ctx.capacity?.(key) ?? null; } catch (_) { return null; } };
  const full = (key) => {
    const c = cap(key);
    return !!(c && c.cap > 0 && c.used >= c.cap);
  };
  const cname = (key) => { try { return ctx.containerName?.(key) || "container"; } catch (_) { return "container"; } };
  const merged = (key) => {
    // ItemHolder::AttemptAutoMerge — only when the exact room is known.
    if (isPack) return 0;
    try { return (ctx.autoMergeTarget?.(it, amount, key) >>> 0) || 0; } catch (_) { return 0; }
  };

  switch (target.kind) {
    case DROP_TARGET.WORLD: {
      // ItemHolder::AttemptPlaceIn3D
      if (!drag.owned) return reject(`You must first pick up the ${name}`);
      const ent = target.entity || null;
      if (ent && ent.guid) {
        if (ent.isSelf) {
          if (src && src.key === MAIN_PACK_KEY && (it.equipMask >>> 0) === 0) return NOOP;
          return { op: "move", guid, container: me, placement: 0, listKey: isPack ? PACKS_KEY : MAIN_PACK_KEY, index: 0, amount };
        }
        if (ent.isOpenContainer) {
          if (ctx.isCorpse?.(ent.guid)) return reject(`The ${ent.name || "corpse"} cannot accept items`);
          return { op: "move", guid, container: ent.guid >>> 0, placement: 0, listKey: ent.guid >>> 0, index: 0, amount, external: true };
        }
        // charopt-4 — with "Drag item onto player opens trade" on, another
        // player gets a secure-trade offer of the whole item, not a gift
        // (PlayerModule::DragItemOnPlayerOpensSecureTrade → ClientTradeSystem::
        // AttemptToTradeItem, acclient.c:433262, ahead of the creature give).
        if (ctx.dragOnPlayerOpensTrade && ent.isPlayer) return { op: "trade", guid, target: ent.guid >>> 0 };
        if (ent.isCreature) return { op: "give", guid, target: ent.guid >>> 0, amount };
        // extcontainer-3: AttemptPlaceIn3D on a container that is not the
        // open ground object (acclient.c:433277-433288) prints and stops —
        // only non-containers reach the ground drop.
        if (ctx.containerDropRule !== false && ent.isContainer) {
          const cn = ent.name || "container";
          return reject(ent.openable === false ? `The ${cn} is locked` : `You must open the ${cn} first`);
        }
      }
      return { op: "drop", guid, amount };
    }

    case DROP_TARGET.DOLL_SLOT: {
      const mask = (target.slotMask >>> 0) || 0;
      if (!mask) return NOOP;
      if ((it.equipMask >>> 0) !== 0 && ((it.equipMask >>> 0) & mask) !== 0) return NOOP;
      const verdict = ctx.canEquip ? ctx.canEquip(it, mask) : { ok: true };
      if (verdict && verdict.ok === false) return reject(verdict.reason || "You can't put that item there");
      // Wield to the item's own bit inside a multi-bit slot (bow into the
      // main-hand slot → MissileWeapon), never the multi-bit mask itself —
      // ACE stores the location verbatim and a multi-bit one breaks combat
      // stance derivation. Without ValidLocations (an un-appraised chest
      // item) the bit is unknowable, so the multi-bit slot refuses.
      const vl = (it.validLocations >>> 0) || 0;
      if (!vl && ((mask & (mask - 1)) >>> 0) !== 0) return reject("Item attributes pending — try again.");
      const loc = ((vl & mask) >>> 0) ? pickWieldSlotMask(vl & mask) : mask;
      // items-4 (`?retailAutoWear`, ctx hooks absent = old path): an
      // overlapping wear is refused before anything moves (planWear), and a
      // second stack of the wielded ammo / thrown weapon merges into it
      // (planAmmoWield) instead of swapping.
      if ((loc & WEARABLE_LOCATIONS) !== 0 && typeof ctx.wearPlan === "function") {
        const p = ctx.wearPlan({ ...it, guid });
        if (p?.op === "reject") return reject(p.message);
      }
      if (typeof ctx.readySlotOccupant === "function") {
        const p = planAmmoWield({ ...it, guid }, ctx.readySlotOccupant(loc >>> 0), { amount });
        if (p.op === "merge" || p.op === "reject") return p;
      }
      return { op: "wield", guid, slotMask: loc >>> 0, amount, speculative: !!verdict?.speculative };
    }

    case DROP_TARGET.DOLL: {
      // gmPaperDollUI::AcceptPaperDollDragObject — the figure only takes
      // armour / clothing (AutoWear); weapons go on a ready slot.
      const vl = (it.validLocations >>> 0) || 0;
      if ((vl & WEARABLE_LOCATIONS) === 0) return reject("You can't put that item there");
      if ((it.equipMask >>> 0) !== 0) return NOOP;
      // items-4: retail AutoWearIsLegal → AutoWear (full ValidLocations).
      if (typeof ctx.wearPlan === "function") {
        const p = ctx.wearPlan({ ...it, guid });
        if (p?.op === "reject") return reject(p.message);
        if (p?.op === "wear") return { op: "wear", guid, slotMask: p.slotMask >>> 0 };
      }
      return { op: "wear", guid, slotMask: pickWieldSlotMask(vl & WEARABLE_LOCATIONS) };
    }

    case DROP_TARGET.MAIN_PACK: {
      // Inv_MainPackSlot: destination = player, place 0, auto-merge on.
      if (isPack) {
        if (src && src.key === PACKS_KEY && drag.sourceIndex === 0) return NOOP;
        return { op: "move", guid, container: me, placement: 0, listKey: PACKS_KEY, index: 0, amount };
      }
      if (src && src.key === MAIN_PACK_KEY && drag.sourceIndex === 0 && !isSplit) return NOOP;
      const into = merged(MAIN_PACK_KEY);
      if (into) return { op: "merge", guid, target: into, amount };
      const inMain = !!(src && src.key === MAIN_PACK_KEY);
      if (!inMain && full(MAIN_PACK_KEY)) {
        const alt = (ctx.packWithRoom?.(MAIN_PACK_KEY) >>> 0) || 0;
        if (alt) return { op: "move", guid, container: alt, placement: 0, listKey: alt, index: 0, amount };
        return reject(`${cname(MAIN_PACK_KEY)} is completely full!`);
      }
      return { op: "move", guid, container: me, placement: 0, listKey: MAIN_PACK_KEY, index: 0, amount };
    }

    case DROP_TARGET.PACK_SLOT: {
      const pack = (target.packGuid >>> 0) || 0;
      if (!pack || pack === guid) return NOOP;
      if (isPack) {
        // Reorder within Inv_ContainerList.
        const same = !!(src && src.key === PACKS_KEY);
        const r = retailPlacement(same ? drag.sourceIndex : -1, target.index, same, false, target.count);
        if (r.noop) return NOOP;
        return { op: "move", guid, container: me, placement: r.placement, listKey: PACKS_KEY, index: target.index | 0, amount };
      }
      if (src && src.key === pack && drag.sourceIndex === 0 && !isSplit) return NOOP;
      const into = merged(pack);
      if (into) return { op: "merge", guid, target: into, amount };
      if (!(src && src.key === pack) && full(pack)) {
        return reject(`The ${target.packName || cname(pack)} is completely full!`);
      }
      return { op: "move", guid, container: pack, placement: 0, listKey: pack, index: 0, amount };
    }

    case DROP_TARGET.EMPTY_PACK_SLOT: {
      if (!isPack) return reject("Cannot place item in container list");
      const same = !!(src && src.key === PACKS_KEY);
      const r = retailPlacement(same ? drag.sourceIndex : -1, target.count, same, false, target.count);
      if (r.noop) return NOOP;
      if (!same && full(PACKS_KEY)) return reject(`${cname(MAIN_PACK_KEY)} can carry no more containers!`);
      return { op: "move", guid, container: me, placement: r.placement, listKey: PACKS_KEY, index: target.count | 0, amount };
    }

    case DROP_TARGET.ITEM_CELL:
    case DROP_TARGET.EMPTY_CELL: {
      const key = target.listKey;
      const isExt = target.listKind === "ext";
      const occ = target.kind === DROP_TARGET.ITEM_CELL ? (target.item || null) : null;
      if (occ && (occ.guid >>> 0) === guid) return NOOP;
      if (occ) {
        // 1. merge onto a matching stack (AttemptMerge, quiet)
        const m = mergeAmount(it, occ, amount);
        if (m > 0) return { op: "merge", guid, target: occ.guid >>> 0, amount: m };
        // 2. tool onto a compatible target → tradeskill use-with. Retail
        //    combined via the targeting cursor; drag-to-combine is the
        //    plugins/tradeskill.js contract, now gated on the Rust
        //    TargetCompatibleWithObject port so a plain re-arrange never
        //    fires a recipe attempt.
        if (drag.owned && !isPack && (occ.equipMask >>> 0) === 0) {
          let ok = null;
          try { ok = ctx.canUseWith ? ctx.canUseWith(guid, occ.guid >>> 0) : null; } catch (_) { ok = null; }
          if (ok === true) return { op: "usewith", guid, target: occ.guid >>> 0 };
        }
        // 3. a (nested) pack under the pointer takes the item
        if (occ.isPack && !isPack && !isExt) {
          const p = occ.guid >>> 0;
          if (full(p)) return reject(`The ${occ.name || "pack"} is completely full!`);
          return { op: "move", guid, container: p, placement: 0, listKey: p, index: 0, amount };
        }
      }
      if (isExt) {
        if (drag.owned && ctx.isCorpse?.(key)) return reject(`The ${cname(key)} cannot accept items`);
      } else if (isPack) {
        // Retail: "Cannot place container in item list". A pack that is NOT
        // yet one of the player's top-level packs (chest/corpse/nested) is
        // accepted into the container list instead — modern liberty.
        if (key !== MAIN_PACK_KEY || (src && src.key === PACKS_KEY)) {
          return reject("Cannot place container in item list");
        }
        if (full(PACKS_KEY)) return reject(`${cname(MAIN_PACK_KEY)} can carry no more containers!`);
        return { op: "move", guid, container: me, placement: 0, listKey: PACKS_KEY, index: 0, amount };
      }
      const same = !!(src && src.key === key);
      if (!isExt && !same && full(key)) {
        if (key === MAIN_PACK_KEY) {
          // AttemptToPlaceInContainer: a full main pack overflows into the
          // first side pack with room.
          const alt = (ctx.packWithRoom?.(MAIN_PACK_KEY) >>> 0) || 0;
          if (alt) return { op: "move", guid, container: alt, placement: 0, listKey: alt, index: 0, amount };
          return reject(`${cname(MAIN_PACK_KEY)} is completely full!`);
        }
        return reject(`The ${cname(key)} is completely full!`);
      }
      const r = retailPlacement(same ? drag.sourceIndex : -1, target.index, same, isSplit, target.count);
      if (r.noop) return NOOP;
      const container = key === MAIN_PACK_KEY ? me : (key >>> 0);
      if (!container) return NOOP;
      const out = { op: "move", guid, container, placement: r.placement, listKey: key, index: target.index | 0, amount };
      if (isExt) out.external = true;
      return out;
    }
    default:
      return NOOP;
  }
}

/**
 * Per-container display order — the client half of ACE's PlacementPosition
 * (Container.TryAddToInventory inserts at `placement` and shifts the rest,
 * exactly like a list insert). Today's wasm snapshot is NAME-sorted and has
 * no placement, so without this a dragged item would snap back to its
 * alphabetical slot on the next refresh. When a newer wasm surfaces
 * `row.placement`, that server truth wins.
 *
 *   reconcile(groups)  groups: Map<key, rows[]> in snapshot order
 *   move(guid, key, dropIndex, {split}) → { placement, undo }
 *   hintArrival(key, index)  next unknown guid arriving in `key` lands there
 *   undo(token)
 *
 * New arrivals with no hint go to the FRONT (ACE's default placement 0 for
 * pickups/loot) once a container has settled; during the first
 * `settleMs` after a container is first seen (login trickle) they keep the
 * snapshot's relative order instead.
 */
export function createPackOrder({ now = () => Date.now(), settleMs = 3000 } = {}) {
  const orders = new Map();      // key -> guid[]
  const seededAt = new Map();    // key -> ts
  const guidHints = new Map();   // guid -> {key, index}
  const slotHints = new Map();   // key -> index[] (unknown future guids)

  function locate(guid) {
    const g = guid >>> 0;
    for (const [key, list] of orders) {
      const i = list.indexOf(g);
      if (i >= 0) return { key, index: i };
    }
    return null;
  }

  function insertRelative(list, g, snapshotOrder) {
    // Insert after the nearest snapshot-predecessor already placed.
    const pos = snapshotOrder.indexOf(g);
    for (let p = pos - 1; p >= 0; p--) {
      const at = list.indexOf(snapshotOrder[p]);
      if (at >= 0) { list.splice(at + 1, 0, g); return; }
    }
    list.unshift(g);
  }

  return {
    locate,
    order(key) { return (orders.get(key) || []).slice(); },
    keys() { return Array.from(orders.keys()); },
    reconcile(groups) {
      const t = now();
      const next = new Map();
      for (const [key, rows] of groups) {
        const snap = rows.map((r) => (r.guid >>> 0));
        const present = new Set(snap);
        let list;
        if (rows.length > 0 && rows.every((r) => Number.isInteger(r.placement))) {
          list = rows.slice().sort((a, b) => a.placement - b.placement).map((r) => r.guid >>> 0);
        } else if (!orders.has(key)) {
          list = snap.slice();
          seededAt.set(key, t);
        } else {
          list = orders.get(key).filter((g) => present.has(g));
          const known = new Set(list);
          const arrivals = snap.filter((g) => !known.has(g));
          const settling = t - (seededAt.get(key) ?? 0) < settleMs;
          // Hinted / unhinted-front arrivals are placed back-to-front so a
          // batch keeps its relative snapshot order.
          const front = [];
          for (const g of arrivals) {
            const h = guidHints.get(g);
            if (h && h.key === key) {
              list.splice(Math.max(0, Math.min(h.index, list.length)), 0, g);
              guidHints.delete(g);
              continue;
            }
            const sh = slotHints.get(key);
            if (sh && sh.length) {
              const idx = sh.shift();
              if (!sh.length) slotHints.delete(key);
              list.splice(Math.max(0, Math.min(idx, list.length)), 0, g);
              continue;
            }
            if (settling) insertRelative(list, g, snap);
            else front.push(g);
          }
          if (front.length) list.splice(0, 0, ...front);
        }
        next.set(key, list);
      }
      orders.clear();
      for (const [k, v] of next) orders.set(k, v);
      return next;
    },
    /**
     * Optimistically move `guid` into `key` at the retail drop index.
     * `split` keeps the source in place (a new stack appears instead) and
     * records a slot hint for the not-yet-known new guid.
     */
    move(guid, key, dropIndex, { split = false } = {}) {
      const g = guid >>> 0;
      const from = locate(g);
      const list = orders.get(key) || [];
      if (!orders.has(key)) { orders.set(key, list); seededAt.set(key, now() - settleMs); }
      if (split) {
        const idx = Math.max(0, Math.min(dropIndex | 0, list.length));
        const arr = slotHints.get(key) || [];
        arr.push(idx);
        slotHints.set(key, arr);
        return { noop: false, placement: idx, undo: { kind: "split", key, index: idx } };
      }
      const same = !!(from && from.key === key);
      const r = retailPlacement(same ? from.index : -1, dropIndex, same, false, list.length);
      if (r.noop) return { noop: true, placement: r.placement, undo: null };
      if (from) orders.get(from.key).splice(from.index, 1);
      const tgt = orders.get(key);
      const at = Math.max(0, Math.min(r.placement, tgt.length));
      tgt.splice(at, 0, g);
      return {
        noop: false,
        placement: at,
        undo: { kind: "move", guid: g, fromKey: from ? from.key : null, fromIndex: from ? from.index : -1, toKey: key },
      };
    },
    /** Remember where an item we asked the server to bring in should land. */
    hintArrival(guid, key, index) {
      guidHints.set(guid >>> 0, { key, index: Math.max(0, index | 0) });
    },
    undo(token) {
      if (!token) return;
      if (token.kind === "split") {
        const arr = slotHints.get(token.key);
        if (arr) {
          const i = arr.indexOf(token.index);
          if (i >= 0) arr.splice(i, 1);
          if (!arr.length) slotHints.delete(token.key);
        }
        return;
      }
      const g = token.guid >>> 0;
      const cur = locate(g);
      if (cur) orders.get(cur.key).splice(cur.index, 1);
      guidHints.delete(g);
      if (token.fromKey !== null && token.fromKey !== undefined) {
        const list = orders.get(token.fromKey) || [];
        if (!orders.has(token.fromKey)) orders.set(token.fromKey, list);
        list.splice(Math.max(0, Math.min(token.fromIndex, list.length)), 0, g);
      }
    },
  };
}

/** Expectation factories for the pending ledger (row = the item's current
 *  plain inventory row, or undefined when the player no longer owns it;
 *  the second argument is the whole Map<guid, row> of the sweep). */
export const pendingExpect = Object.freeze({
  /** item now sits in `key` (MAIN_PACK_KEY or a pack guid), unequipped */
  inContainer: (key) => (row) => !!row && (row.equipMask >>> 0) === 0
    && ((row.containerId >>> 0) || 0) === (key === MAIN_PACK_KEY ? 0 : (key >>> 0)),
  /** item now equipped */
  wielded: () => (row) => !!row && (row.equipMask >>> 0) !== 0,
  /** item left the player's possession (drop / give / put in a chest) */
  gone: () => (row) => !row,
  /** item now owned (taken from a chest / corpse) */
  owned: () => (row) => !!row,
  /** source stack shrank or vanished (split / partial merge / give part) */
  reduced: (orig) => (row) => !row || (row.stackSize | 0) < (orig | 0),
  /** an owned stack reached `want` (a merge whose source we never owned —
   *  a corpse / ground take — so the source row cannot show it) */
  grew: (target, want) => (_row, rows) => ((rows?.get?.(target >>> 0)?.stackSize | 0) >= (want | 0)),
});

/**
 * Optimistic-action ledger — retail UIElement_UIItem::SetWaitingState.
 * An entry per in-flight item: shown "waiting" (ghosted) until `sweep`
 * sees the snapshot satisfy its expectation, the server reports a
 * failure (`fail` → its `undo` runs; ServerSaysAttemptFailed re-sync), or
 * `ttlMs` passes (the snapshot is then simply trusted).
 *
 * `bump()` marks "a server inventory update arrived". An entry can only
 * resolve on a sweep AFTER at least one bump since it was added — a
 * same-pack re-order already "matches" the stale snapshot, and must still
 * wait for the server's echo before it stops looking pending.
 */
export function createPendingLedger({ now = () => Date.now(), ttlMs = 6000 } = {}) {
  const entries = new Map();
  const listeners = new Set();
  let epoch = 0;
  function emit(evt) {
    for (const cb of listeners) { try { cb(evt); } catch (_) { /* listener bug must not wedge */ } }
  }
  return {
    add(guid, entry) {
      const g = guid >>> 0;
      if (!g) return null;
      const e = { ...entry, guid: g, ts: now(), epoch };
      entries.set(g, e);
      emit({ type: "add", guid: g, entry: e });
      return e;
    },
    get(guid) { return entries.get(guid >>> 0) || null; },
    has(guid) { return entries.has(guid >>> 0); },
    size() { return entries.size; },
    bump() { epoch += 1; return epoch; },
    all() { return Array.from(entries.values()); },
    /** rowsByGuid: Map<guid, row> of the player's current inventory. */
    sweep(rowsByGuid) {
      const t = now();
      let changed = 0;
      for (const [g, e] of Array.from(entries)) {
        let done = false;
        if (e.epoch < epoch) {
          try { done = typeof e.expect === "function" ? !!e.expect(rowsByGuid.get(g), rowsByGuid) : false; } catch (_) { done = false; }
        }
        if (done) {
          entries.delete(g); changed++;
          emit({ type: "resolve", guid: g, entry: e });
        } else if (t - e.ts > ttlMs) {
          entries.delete(g); changed++;
          emit({ type: "expire", guid: g, entry: e });
        }
      }
      return changed;
    },
    fail(guid) {
      const g = guid >>> 0;
      const e = entries.get(g);
      if (!e) return null;
      entries.delete(g);
      try { e.undo?.(); } catch (_) { /* undo is best-effort */ }
      emit({ type: "fail", guid: g, entry: e });
      return e;
    },
    resolve(guid) {
      const g = guid >>> 0;
      const e = entries.get(g);
      if (!e) return null;
      entries.delete(g);
      emit({ type: "resolve", guid: g, entry: e });
      return e;
    },
    onChange(cb) {
      if (typeof cb !== "function") return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/**
 * Item-slot capacity of one of the player's lists.
 *   MAIN_PACK_KEY → non-pack items directly in the player / player ItemsCapacity
 *   PACKS_KEY     → top-level packs / player ContainersCapacity
 *   pack guid     → items in that pack / its ItemsCapacity
 * `cap` 0 = unknown (never treated as full).
 */
export function packCapacity(rows, key, { mainCap = 0, packsCap = 0 } = {}) {
  let used = 0;
  let cap = 0;
  if (key === MAIN_PACK_KEY) {
    for (const r of rows) {
      if ((r.equipMask >>> 0) !== 0 || (r.containerId >>> 0) !== 0) continue;
      if (rowUsesPackSlot(r)) continue;
      used++;
    }
    cap = mainCap >>> 0;
  } else if (key === PACKS_KEY) {
    for (const r of rows) {
      if ((r.equipMask >>> 0) !== 0 || (r.containerId >>> 0) !== 0) continue;
      if (rowUsesPackSlot(r)) used++;
    }
    cap = packsCap >>> 0;
  } else {
    const k = key >>> 0;
    for (const r of rows) {
      if ((r.containerId >>> 0) === k) used++;
      if ((r.guid >>> 0) === k) cap = (r.itemsCapacity >>> 0) || 0;
    }
  }
  return { used, cap };
}

/**
 * 2026-10-07 — does a kind:49 EntityAttached / kind:47 EntityDetached event
 * concern the LOCAL inventory? Both fire for every wielder transition in view
 * (each creature that spawns holding, draws or sheathes a weapon), and the
 * inventory panel rebuilt itself + the paperdoll for each one (live: ~360
 * `[paperdoll-slots]` recomputations of the same two items in 15 minutes).
 *
 * Payload (lib.rs CLIENT_EVENT_KIND_ENTITY_ATTACHED / _DETACHED):
 * `u32Payload` = item guid, `u32Payload2` = new (49) / prior (47) wielder.
 * Conservative: an unreadable event or an unknown local guid → true.
 *
 * @param {{u32Payload?: number, u32Payload2?: number}|null} detail
 * @param {number|null} localGuid
 * @param {(guid: number) => boolean} isMine  inventory membership test
 * @returns {boolean}
 */
export function wieldEventTouchesLocal(detail, localGuid, isMine) {
  const item = (detail?.u32Payload ?? 0) >>> 0;
  if (!item) return true;
  const me = (localGuid ?? 0) >>> 0;
  if (!me) return true;
  if (((detail?.u32Payload2 ?? 0) >>> 0) === me) return true;
  try { return !!isMine?.(item); } catch (_) { return true; }
}

// ════════════════════════════════════════════════════════════════════
// 2026-10-08 — retail item placement / activation / cooldown rules.
//
// Pure, like the drag core above: planPlaceInBackpack (corpse / chest
// takes and ground pickups), primaryUseAction (shortcut keys, the Use
// button, double-click) and the per-item cooldown overlay step. Pinned by
// tests/inventory_drag_rules.test.mjs, tests/item_primary_use.test.mjs and
// tests/item_cooldown_step.test.mjs.
// ════════════════════════════════════════════════════════════════════

/** ACE human Player weenie (ItemsCapacity 102, ContainersCapacity 7) — used
 *  while the snapshot has not surfaced the player's own value yet. */
export const DEFAULT_PLAYER_ITEMS_CAPACITY = 102;
export const DEFAULT_PLAYER_CONTAINERS_CAPACITY = 7;

/** Default-ON behaviour flag: false only for `?name=off`, `=0` or `=false`
 *  (docs/url-flags.md). `search` defaults to the page's query string. */
export function defaultOnUrlFlag(name, search) {
  try {
    const s = search ?? (typeof window !== "undefined" ? window.location?.search : "") ?? "";
    const v = new URLSearchParams(s).get(name);
    return !(v === "off" || v === "0" || v === "false");
  } catch (_) { return true; }
}

/**
 * Guids of one of the player's lists (MAIN_PACK_KEY, PACKS_KEY or a pack
 * guid) in server placement order when every row carries one, else in
 * snapshot order. The inventory panel passes its own createPackOrder order
 * instead while it is mounted.
 */
export function containerOrder(rows, key) {
  const list = [];
  for (const r of rows || []) {
    if (!r || (r.equipMask >>> 0) !== 0) continue;
    const c = (r.containerId >>> 0) || 0;
    if (key === MAIN_PACK_KEY) { if (c !== 0 || rowUsesPackSlot(r)) continue; }
    else if (key === PACKS_KEY) { if (c !== 0 || !rowUsesPackSlot(r)) continue; }
    else if (c !== (key >>> 0)) continue;
    list.push(r);
  }
  if (list.length > 0 && list.every((r) => Number.isInteger(r.placement))) {
    list.sort((a, b) => a.placement - b.placement);
  }
  return list.map((r) => r.guid >>> 0);
}

/**
 * ItemHolder::AttemptAutoMerge (acclient.c:432634) for ONE candidate stack:
 * a legal merge that takes the WHOLE amount (`splitSize <= max - stack`).
 * The stack limit is the target's (same wcid ⇒ same limit; corpse and
 * ground rows carry none), else the item's own; unknown or <= 1 (not
 * stackable) never auto-merges.
 */
export function autoMergeFits(item, row, amount) {
  const lim = (v) => (Number.isFinite(v) && v > 0 ? v : NaN);
  const max = Number.isFinite(lim(row?.maxStackSize)) ? lim(row.maxStackSize) : lim(item?.maxStackSize);
  if (!(max > 1)) return false;
  const want = Math.max(1, amount | 0 || item?.stackSize | 0 || 1);
  return mergeAmount(item, { ...row, maxStackSize: max }, want) >= want;
}

/** First row of `candidates` (exhaustive order) that auto-merge takes, or null. */
export function findAutoMergeTarget(item, amount, candidates) {
  for (const r of candidates || []) {
    if (r && autoMergeFits(item, r, amount)) return r;
  }
  return null;
}

/**
 * CPlayerSystem::PlaceInBackpack (acclient.c:395895) →
 * ItemHolder::AttemptToPlaceInContainer(item, player, preferred, autoMerge=1)
 * (acclient.c:432899) — where an item the player picks up or takes out of a
 * corpse / chest goes:
 *   1. AttemptAutoMerge: the first stack in the exhaustive item list (main
 *      pack, then each side pack) that takes the whole amount → merge;
 *   2. the preferred container — the side pack open in the inventory
 *      (mOpenContainerID) — when it has room; with the MainPackPreferred
 *      character option (0x29) on, or for retail's pick-up-to-main-pack
 *      action (PlaceInBackpack(sel, 1), acclient.c:399631), the preferred
 *      container is the player, so this step is the main pack (charopt-3);
 *   3. the main pack (the top container);
 *   4. the first side pack with room (GetContainedContainersList order);
 *   5. else "<player> is completely full!" / "<player> can carry no more
 *      containers!" (the top container is the player).
 * ACE does none of this server-side: PutItemInContainer adds with
 * limitToMainPackOnly (Player_Inventory.cs DoHandleActionPutItemInContainer
 * → Container.TryAddToInventory), so a full main pack just fails, and a
 * take never merges (only an explicit StackableMerge does).
 *
 * @param {Array<object>} rows  the player's inventory (copyInventoryRow rows)
 * @param {object} item  guid, wcid, name, stackSize, maxStackSize?, itemType, isPack?
 * @param {object} opts  playerGuid, amount?, preferredPack? (0 / the player
 *   = main pack), mainPackPreferred? / forceMainPack? (ignore preferredPack),
 *   mainCap?, packsCap?, playerName?, order?(key) → guid[],
 *   capacityOf?(key) → {used, cap}
 * @returns {object} decideItemDrop-shaped action (merge carries targetStack)
 */
export function planPlaceInBackpack(rows, item, opts = {}) {
  const me = (opts.playerGuid >>> 0) || 0;
  const guid = (item?.guid >>> 0) || 0;
  if (!me || !guid) return NOOP;
  const list = Array.isArray(rows) ? rows : [];
  const stack = Math.max(1, item.stackSize | 0 || 1);
  const amount = opts.amount > 0 && opts.amount < stack ? (opts.amount | 0) : stack;
  const isPack = typeof item.isPack === "boolean" ? item.isPack : rowUsesPackSlot(item);
  const capOf = typeof opts.capacityOf === "function"
    ? opts.capacityOf
    : (key) => packCapacity(list, key, { mainCap: opts.mainCap, packsCap: opts.packsCap });
  const hasRoom = (key) => {
    let c = null;
    try { c = capOf(key); } catch (_) { c = null; }
    return !(c && c.cap > 0 && c.used >= c.cap);
  };
  const orderOf = (key) => {
    let o = null;
    try { o = opts.order?.(key); } catch (_) { o = null; }
    return Array.isArray(o) ? o : containerOrder(list, key);
  };
  const packs = orderOf(PACKS_KEY).map((g) => g >>> 0);
  if (!isPack) {
    const byGuid = new Map(list.map((r) => [r.guid >>> 0, r]));
    const candidates = [];
    for (const key of [MAIN_PACK_KEY, ...packs]) {
      for (const g of orderOf(key)) {
        const r = byGuid.get(g >>> 0);
        if (r) candidates.push(r);
      }
    }
    const into = findAutoMergeTarget(item, amount, candidates);
    if (into) {
      return { op: "merge", guid, target: into.guid >>> 0, amount, targetStack: Math.max(1, into.stackSize | 0 || 1) };
    }
  }
  const move = (container, listKey) => ({ op: "move", guid, container, placement: 0, listKey, index: 0, amount });
  const who = opts.playerName || "Your pack";
  if (isPack) {
    // A container only ever goes in the player's container list.
    return hasRoom(PACKS_KEY) ? move(me, PACKS_KEY) : reject(`${who} can carry no more containers!`);
  }
  const pref = (opts.mainPackPreferred || opts.forceMainPack) ? 0 : ((opts.preferredPack >>> 0) || 0);
  if (pref && pref !== me && pref !== guid && packs.includes(pref) && hasRoom(pref)) return move(pref, pref);
  if (hasRoom(MAIN_PACK_KEY)) return move(me, MAIN_PACK_KEY);
  for (const p of packs) {
    if (p !== guid && hasRoom(p)) return move(p, p);
  }
  return reject(`${who} is completely full!`);
}

const ITEM_TYPE_CASTER = 0x00008000;
const ITEM_TYPE_TINKERING_TOOL = 0x20000000;
/** Weapon-family wield locations (MeleeWeapon, Shield, MissileWeapon,
 *  MissileAmmo, Held, TwoHanded). Stands in for retail's combatUse /
 *  WieldOnUse test, which the inventory snapshot does not carry yet. */
export const WIELD_ON_USE_LOCATIONS = 0x03f00000;
/** DetermineUseResult's AutoSort groups: armour (BYTE1 & 0x7E), clothing /
 *  cloak (0x80001FF) and jewellery / trinket / sigils (0x7C0F8000). */
const AUTOSORT_GROUPS = [0x00007e00, 0x080001ff, 0x7c0f8000];
/** CombatUse (PropertyInt 51; ACE CombatUse: Melee 1, Missile 2, Ammo 3,
 *  Shield 4, TwoHanded 5) → the ready slot it wields to. */
const COMBAT_USE_SLOT = Object.freeze({
  1: EQUIP.MeleeWeapon, 2: EQUIP.MissileWeapon, 3: EQUIP.MissileAmmo, 4: EQUIP.Shield, 5: EQUIP.TwoHanded,
});

/**
 * ItemHolder::DetermineUseResult (acclient.c:433086) as ItemHolder::UseObject
 * (acclient.c:433354) applies it to an OWNED inventory row — what a shortcut
 * key, the Use button or a double-click does:
 *   { kind: "open" }               a pack (the inventory opens it)
 *   { kind: "wield", slotMask }    3 / 8 → CPlayerSystem::UsingItem → AutoWield
 *   { kind: "wear", slotMask }     4 → AutoSort (armour / clothing / jewellery)
 *   { kind: "salvage" }            6 → SendNotice_OpenSalvagePanel (TinkeringTool)
 *   { kind: "target" }             IsUseable_Targeted → "Choose a target for the %s"
 *   { kind: "use" }                Event_UseEvent
 * Results 2..7 send no Use event at all — and ACE has no wield path behind
 * one (WorldObject.OnActivate → ActOnUse "undefined" for weapons/clothing).
 *
 * @param {object} row  copyInventoryRow row
 * @param {object} opts needsTarget (Rust classifyUse), equippedMask (OR of the
 *   player's worn locations: AutoWear takes the free ring / bracelet bit)
 */
export function primaryUseAction(row, opts = {}) {
  if (!row) return { kind: "none" };
  if (rowUsesPackSlot(row)) return { kind: "open" };
  const it = (row.itemType >>> 0) || 0;
  const vl = (row.validLocations >>> 0) || 0;
  const loc = (row.equipMask >>> 0) || 0;
  // A row without ValidLocations (the weenie lacks the property) still has
  // its slot inferred — from CombatUse when the wasm surfaces it (items-4),
  // else from ItemType, as the double-click always did.
  const typeSlot = (it & 0x1) ? EQUIP.MeleeWeapon
    : (it & 0x100) ? EQUIP.MissileWeapon
      : (it & ITEM_TYPE_CASTER) ? EQUIP.Held : 0;
  const weapon = vl ? (vl & WIELD_ON_USE_LOCATIONS) : (COMBAT_USE_SLOT[(row.combatUse >>> 0) || 0] || typeSlot);
  if (weapon && loc === 0) return { kind: "wield", slotMask: pickWieldSlotMask(weapon) >>> 0 };
  for (const group of AUTOSORT_GROUPS) {
    if ((vl & group) === 0 || (loc & group) !== 0) continue;
    const want = (vl & group) >>> 0;
    const free = (want & ~((opts.equippedMask >>> 0) || 0)) >>> 0;
    return { kind: "wear", slotMask: pickWieldSlotMask(free || want) >>> 0 };
  }
  if ((it & ITEM_TYPE_TINKERING_TOOL) !== 0) return { kind: "salvage" };
  if (opts.needsTarget) return { kind: "target" };
  return { kind: "use" };
}

/**
 * UIElement_UIItem::UpdateCooldownDisplay (acclient.c:272052): the overlay
 * step `(unsigned)(time_left / duration * 100 * 0.1 + 1)`, one of the ten
 * m_elem_Icon_Cooldown_10..100 elements. 0 = no overlay (no cooldown, or
 * it ran out — OnCooldown drops an entry at time_left <= 0).
 */
export function cooldownStep(duration, remaining) {
  const d = Number(duration);
  const r = Number(remaining);
  if (!(d > 0) || !(r > 0)) return 0;
  return Math.max(1, Math.min(10, Math.trunc((r / d) * 10 + 1)));
}

/**
 * CEnchantmentRegistry::OnCooldown (acclient.c:445755) lookup: an item's
 * shared-cooldown id N is the cooldown enchantment whose 16-bit spell id is
 * N + 0x8000 (ACE EnchantmentManager.GetCooldownSpellID = 0x8000 | N).
 * `enchs` are rows with a `spellId`. Returns the entry or null.
 */
export function matchCooldownEnchantment(enchs, sharedCooldown) {
  const id = (sharedCooldown >>> 0) || 0;
  if (!id) return null;
  const want = (id + 0x8000) & 0xffff;
  for (const e of enchs || []) {
    if ((((e?.spellId ?? 0) >>> 0) & 0xffff) === want) return e;
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════
// 2026-10-08 — items-4: retail auto-wear refusal and ready-slot merge
// (`?retailAutoWear`, default ON). The wasm WieldFromPack no longer strips
// a worn piece for a pure wearable nor swaps a same-wcid ammo stack
// (holtburger-world equip.rs); these planners give the player retail's
// answer BEFORE anything is sent. Pinned by tests/item_wear_plan.test.mjs.
// ════════════════════════════════════════════════════════════════════

/**
 * ACCWeenieObject::GetObjectName(NAME_PLURAL) (acclient.c:439093): the
 * weenie's PluralName when it has one, else the name + "es" when it ends
 * in 's', else + "s".
 */
export function retailPluralName(name, pluralName) {
  if (typeof pluralName === "string" && pluralName.length > 0) return pluralName;
  const n = String(name || "");
  if (!n) return n;
  return n.endsWith("s") ? `${n}es` : `${n}s`;
}

/**
 * CPlayerSystem::AutoWearIsLegal (acclient.c:397338) → AutoWear (:398318)
 * for an armour / clothing / cloak piece (ValidLocations & 0x8007FFF):
 *   - the player's clothingPriorityMask is the OR of the ClothingPriority of
 *     every worn item in that family (gmPaperDollUI keeps it, :222094);
 *   - no overlap with the item's own priority → wear with the FULL mask
 *     (UIAttemptWield(item, valid_locations); ACE also normalises Clothing
 *     to ValidLocations);
 *   - the item itself is worn → "The %s is already being worn";
 *   - else the first worn item (GetObjectAtLocation: priority AND location
 *     overlap, wield order) → "You must remove your %s to wear that".
 * Nothing is moved — retail never strips a piece to make room.
 * A row without ClothingPriority (a wasm without the getter — which also
 * predates the WieldFromPack no-strip guard) keeps the old single-bit wear:
 * no pre-check, and a full mask would make that wasm strip MORE pieces.
 *
 * @param {object} item  copyInventoryRow row: guid, name, validLocations,
 *   equipMask, clothingPriority?
 * @param {Array<object>} rows  the player's inventory (the worn rows count)
 * @returns {{op:"wear", guid:number, slotMask:number}|{op:"reject", message:string}|{op:"none"}}
 */
export function planWear(item, rows) {
  const vl = (item?.validLocations >>> 0) || 0;
  const wear = (vl & WEARABLE_LOCATIONS) >>> 0;
  if (!item || !wear) return { op: "none" };
  const guid = (item.guid >>> 0) || 0;
  if (typeof item.clothingPriority !== "number") return { op: "wear", guid, slotMask: pickWieldSlotMask(wear) >>> 0 };
  const prio = (item.clothingPriority >>> 0) || 0;
  const worn = [];
  let mask = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const loc = (r?.equipMask >>> 0) || 0;
    if (!loc) continue;
    worn.push(r);
    if ((loc & WEARABLE_LOCATIONS) !== 0) mask |= (r.clothingPriority >>> 0) || 0;
  }
  if (((mask & prio) >>> 0) === 0) return { op: "wear", guid, slotMask: wear };
  const name = item.name || "item";
  if ((item.equipMask >>> 0) !== 0 || worn.some((r) => (r.guid >>> 0) === guid)) {
    return reject(`The ${name} is already being worn`);
  }
  const overlaps = (r) => (r.guid >>> 0) !== guid && (((r.clothingPriority >>> 0) & prio) >>> 0) !== 0;
  // Retail stays silent when no worn item also shares a location; name the
  // first priority overlap instead so the refusal is never blank.
  const blocker = worn.find((r) => overlaps(r) && (((r.equipMask >>> 0) & vl) >>> 0) !== 0)
    || worn.find((r) => overlaps(r) && ((r.equipMask >>> 0) & WEARABLE_LOCATIONS) !== 0);
  return reject(`You must remove your ${blocker?.name || "armor"} to wear that`);
}

/** The weapon-ready slot family AutoWield merges into first
 *  (MeleeWeapon | MissileWeapon | Held | TwoHanded = 0x3500000). */
export const WEAPON_READY_LOCATIONS = 0x03500000;

/**
 * The equipped row occupying the ready slot `slotMask` wields to: the ammo
 * slot for MissileAmmo, the weapon-ready slot for a weapon / held bit, else
 * null (a shield, armour or jewellery slot never merges).
 */
export function readySlotOccupant(rows, slotMask) {
  const m = (slotMask >>> 0) || 0;
  const family = (m & EQUIP.MissileAmmo) ? EQUIP.MissileAmmo
    : (m & WEAPON_READY_LOCATIONS) ? WEAPON_READY_LOCATIONS : 0;
  if (!family) return null;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r && (((r.equipMask >>> 0) & family) >>> 0) !== 0) return r;
  }
  return null;
}

/**
 * CPlayerSystem::AutoWield's ready-slot merge (acclient.c:398828, the
 * weapon-ready and ammo branches ~399250-399335): when the slot is already
 * held by a stack of the SAME wcid, ItemHolder::AttemptMerge (:432468)
 * moves min(amount, max - held) into it — no swap. A full (or
 * non-stackable) ammo stack of the same wcid → "You cannot wield more %s"
 * (plural name); a full weapon-ready stack falls through to the unblock
 * swap. A different wcid, or an empty slot, wields as before (the wasm
 * WieldFromPack unblock moves the old item to the pack).
 * Stack limit: the held stack's MaxStackSize, else the item's; unknown →
 * ammo merges the whole amount (ACE refuses an overflow), a weapon merges
 * only when either side is visibly a stack.
 *
 * @param {object} item  the row being wielded (guid, wcid, name, stackSize,
 *   maxStackSize?, pluralName?)
 * @param {object|null} wielded  readySlotOccupant() for its slot
 * @param {object} [opts] amount — the split (default: the whole stack)
 * @returns {{op:"merge", guid, target, amount, targetStack}|{op:"reject", message}|{op:"wield"}}
 */
export function planAmmoWield(item, wielded, opts = {}) {
  const WIELD = { op: "wield" };
  const guid = (item?.guid >>> 0) || 0;
  const target = (wielded?.guid >>> 0) || 0;
  if (!guid || !target || guid === target) return WIELD;
  if (!item.wcid || (item.wcid >>> 0) !== (wielded.wcid >>> 0)) return WIELD;
  const ammo = (((wielded.equipMask >>> 0) & EQUIP.MissileAmmo) >>> 0) !== 0;
  const stack = Math.max(1, item.stackSize | 0 || 1);
  const want = opts.amount > 0 && opts.amount < stack ? (opts.amount | 0) : stack;
  const held = Math.max(1, wielded.stackSize | 0 || 1);
  const lim = (v) => (Number.isFinite(v) && v > 0 ? v : NaN);
  const max = Number.isFinite(lim(wielded.maxStackSize)) ? lim(wielded.maxStackSize) : lim(item.maxStackSize);
  let amount = 0;
  if (Number.isFinite(max)) amount = max > 1 ? Math.max(0, Math.min(want, max - held)) : 0;
  else if (ammo || stack > 1 || held > 1) amount = want;
  if (amount > 0) return { op: "merge", guid, target, amount, targetStack: held };
  if (!ammo) return WIELD;
  return reject(`You cannot wield more ${retailPluralName(item.name || "ammunition", item.pluralName)}`);
}

/**
 * The toolbar Use button (gmToolbarUI 0x1000019D → ItemHolder::UseObject(
 * selectedID)) and any other "use the selected thing" control: an owned
 * item goes through `activate` (inventory.js activateItem — wield / wear /
 * salvage / target mode; it returns false for a world object and under
 * `?hotbarActivate=off`), everything else is a plain `use`.
 * @returns {"activated"|"used"|"none"}
 */
export function activateOrUse(guid, { activate, use } = {}) {
  const g = (guid >>> 0) || 0;
  if (!g) return "none";
  if (typeof activate === "function") {
    let handled;
    try { handled = activate(g); } catch (e) {
      // It may already have sent something — never follow with a Use.
      console.warn("[use] activateItem failed:", e);
      return "none";
    }
    if (handled === true) return "activated";
  }
  if (typeof use !== "function") return "none";
  use(g);
  return "used";
}

/**
 * B2-use-items (2026-10-08 round 2) — the world-object leaf of the toolbar /
 * radial Use (`activateOrUse`'s `use`), run as retail ItemHolder::UseObject
 * (acclient.c:433354) runs it for the 3D double-click: the shared 0.2 s
 * throttle first (use-4, dropped silently), then a loose item is picked up
 * — DetermineUseResult 2 → PlaceInBackpack (use-1) — and an object retail
 * will not use is refused with its line (use-2); only the rest is a Use
 * event. Callers wire scene3d/picking.js's `window.__worldUseIsPickup` /
 * `__worldUseRefusal` and target_cycle.js `consumeWorldUseThrottle`; every
 * dependency is optional.
 *
 * Round 5 (2026-10-08): a PK / NPK altar asks first (pk-2, `confirmText` →
 * `confirm(text, onYes)`; the Use is sent only on Yes, as retail
 * UsageConfirmation_PKAltar / UsageCallback do), and after a Use `notice`
 * may name a line retail prints then (extcontainer-4: "The X is locked").
 * Callers wire `window.__pkAltarConfirmText` / `__pkAltarConfirm` /
 * `__worldUseNotice` from picking.js.
 * @param {number} guid
 * @param {{throttleOk?:() => boolean, isPickup?:(g:number) => boolean,
 *          pickUp?:(g:number) => any, refusal?:(g:number) => string|null,
 *          reject?:(message:string) => void, use?:(g:number) => void,
 *          confirmText?:(g:number) => string|null,
 *          confirm?:(text:string, onYes:() => void) => void,
 *          notice?:(g:number) => string|null}} deps
 * @returns {"throttled"|"pickup"|"refused"|"confirm"|"used"|"none"}
 */
export function worldUseLeaf(guid, {
  throttleOk, isPickup, pickUp, refusal, reject, use, confirmText, confirm, notice,
} = {}) {
  const g = (guid >>> 0) || 0;
  if (!g) return "none";
  if (typeof throttleOk === "function" && throttleOk() === false) return "throttled";
  if (typeof pickUp === "function" && typeof isPickup === "function" && isPickup(g) === true) {
    pickUp(g);
    return "pickup";
  }
  const why = typeof refusal === "function" ? refusal(g) : null;
  if (why != null) {
    if (why && typeof reject === "function") reject(why);
    return "refused";
  }
  if (typeof use !== "function") return "none";
  const sendUse = () => {
    use(g);
    const line = typeof notice === "function" ? notice(g) : null;
    if (line && typeof reject === "function") reject(line);
  };
  const ask = typeof confirmText === "function" && typeof confirm === "function" ? confirmText(g) : null;
  if (ask) {
    confirm(ask, sendUse);
    return "confirm";
  }
  sendUse();
  return "used";
}
