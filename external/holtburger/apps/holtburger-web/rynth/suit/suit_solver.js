// rynth/suit/suit_solver.js — RynthSuite Tier-0 armor-coverage gaps (free).
//
// Answers ONE cheap question with ZERO appraisal: which of the nine
// body-armor slots is the player currently wearing nothing in? Everything
// it needs (each item's `equipMask` = CurrentWieldedLocation and
// `validLocations`) already rides the inventory snapshot from
// `RynthWebHost.TryGetPlayerInventory()` — no RequestId / item-profile /
// value stream is touched, so the director can call this on every tick for
// a fixed ~0-token cost.
//
// Ported bit-ops (Chorizite.Common.Enums, mirrored in Rust at
// holtburger-common/src/properties/inventory.rs):
//   * EquipMask               (inventory.rs:158-191)
//   * IsBodyArmor mask 0x7F21 (the 9 armor slots; verified below)
//   * GetTotalBitsSet(mask)   (popcount)
//
// The heavier `bestSuit` / `upgrades` DFS is DEFERRED (report A2-1): it is
// appraisal-fed (armor level, protections) and out of Tier-0 scope. This
// module deliberately calls no host appraisal surface.

"use strict";

/**
 * EquipMask — the wield-location bitmask carried by every wieldable item
 * as both its `validLocations` (where it MAY go) and, once worn, its
 * `equipMask` / CurrentWieldedLocation (where it currently sits).
 * Faithful mirror of Chorizite.Common.Enums.EquipMask.
 */
export const EQUIP_MASK = Object.freeze({
  NONE: 0x00000000,
  HEAD_WEAR: 0x00000001,
  CHEST_WEAR: 0x00000002,
  ABDOMEN_WEAR: 0x00000004,
  UPPER_ARM_WEAR: 0x00000008,
  LOWER_ARM_WEAR: 0x00000010,
  HAND_WEAR: 0x00000020,
  UPPER_LEG_WEAR: 0x00000040,
  LOWER_LEG_WEAR: 0x00000080,
  FOOT_WEAR: 0x00000100,
  CHEST_ARMOR: 0x00000200,
  ABDOMEN_ARMOR: 0x00000400,
  UPPER_ARM_ARMOR: 0x00000800,
  LOWER_ARM_ARMOR: 0x00001000,
  UPPER_LEG_ARMOR: 0x00002000,
  LOWER_LEG_ARMOR: 0x00004000,
  NECK_WEAR: 0x00008000,
  WRIST_WEAR_LEFT: 0x00010000,
  WRIST_WEAR_RIGHT: 0x00020000,
  FINGER_WEAR_LEFT: 0x00040000,
  FINGER_WEAR_RIGHT: 0x00080000,
  MELEE_WEAPON: 0x00100000,
  SHIELD: 0x00200000,
  MISSILE_WEAPON: 0x00400000,
  MISSILE_AMMO: 0x00800000,
  CASTER: 0x01000000,
  TWO_HANDED: 0x02000000,
  TRINKET_ONE: 0x04000000,
  CLOAK: 0x08000000,
  SIGIL_ONE: 0x10000000,
  SIGIL_TWO: 0x20000000,
  SIGIL_THREE: 0x40000000,
});

/**
 * The nine body-armor slots, in canonical head→feet order. Head/hands/feet
 * armour reuses the *_WEAR bit (there is no dedicated *_ARMOR bit for them
 * in the retail layout) — a worn cloth hood therefore also fills `head`,
 * which is correct for "is this slot empty?" (the slot is occupied).
 * `mask` is the single EquipMask bit; `key` is a stable set-comparison id.
 */
export const ARMOR_SLOTS = Object.freeze(
  [
    { key: "head", label: "Head", mask: EQUIP_MASK.HEAD_WEAR },
    { key: "chest", label: "Chest", mask: EQUIP_MASK.CHEST_ARMOR },
    { key: "abdomen", label: "Abdomen", mask: EQUIP_MASK.ABDOMEN_ARMOR },
    { key: "upper_arms", label: "Upper Arms", mask: EQUIP_MASK.UPPER_ARM_ARMOR },
    { key: "lower_arms", label: "Lower Arms", mask: EQUIP_MASK.LOWER_ARM_ARMOR },
    { key: "hands", label: "Hands", mask: EQUIP_MASK.HAND_WEAR },
    { key: "upper_legs", label: "Upper Legs", mask: EQUIP_MASK.UPPER_LEG_ARMOR },
    { key: "lower_legs", label: "Lower Legs", mask: EQUIP_MASK.LOWER_LEG_ARMOR },
    { key: "feet", label: "Feet", mask: EQUIP_MASK.FOOT_WEAR },
  ].map(Object.freeze)
);

/**
 * IsBodyArmor — union of the nine armor-slot bits (0x00007F21). Kept as a
 * named const AND derived from ARMOR_SLOTS so the two can't silently drift
 * (asserted equal in the test).
 */
export const IS_BODY_ARMOR = ARMOR_SLOTS.reduce((m, s) => m | s.mask, 0) >>> 0;

/** GetTotalBitsSet — 32-bit popcount (Chorizite EquipMask helper). */
export function getTotalBitsSet(mask) {
  let n = mask >>> 0;
  let c = 0;
  while (n) {
    n &= n - 1;
    c++;
  }
  return c;
}

/**
 * Normalise the many shapes a "snapshot" can arrive in into a plain rows
 * array. Accepts: the rows array itself; an object carrying the rows under
 * a common key; or a live host exposing `TryGetPlayerInventory()`. Any
 * error (throwing host, wrong types) degrades to `[]` — never throws, so a
 * director loop can call this unguarded.
 */
function extractRows(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  if (!snapshot || typeof snapshot !== "object") return [];
  if (typeof snapshot.TryGetPlayerInventory === "function") {
    try {
      const r = snapshot.TryGetPlayerInventory();
      return Array.isArray(r) ? r : [];
    } catch (_) {
      return [];
    }
  }
  const r = snapshot.inventory ?? snapshot.rows ?? snapshot.items ?? snapshot.inv;
  return Array.isArray(r) ? r : [];
}

/** Armor bits a single row contributes to coverage (0 unless it's worn). */
function wornArmorBits(row) {
  if (!row || typeof row !== "object") return 0;
  const eq = (row.equipMask ?? row.equippedSlot ?? 0) >>> 0;
  if (eq === 0) return 0; // in a pack, not on the body — covers nothing
  // A worn armor's CurrentWieldedLocation == its ValidLocations, but a
  // thin wasm snapshot may report only a single equipMask bit while the
  // full multi-slot coverage sits in validLocations. Union both (masked to
  // armor bits, so a weapon's/ring's non-armor validLocations can't leak
  // in). validLocations of a worn item are exactly the slots it may hold,
  // so this can never over-cover.
  const vl = (row.validLocations ?? 0) >>> 0;
  return (eq | vl) & IS_BODY_ARMOR;
}

/**
 * coverageGaps(snapshot) — which of the nine body-armor slots are empty.
 *
 * Observation cost: ONE `TryGetPlayerInventory` read (already frozen for
 * the tick); zero appraisal, zero wire traffic. Degrades to a no-op
 * (all-slots-unknown, streamed:false) on any error.
 *
 * @param {Array|Object} snapshot rows array, {inventory:[...]}, or host.
 * @returns {{
 *   gaps: string[], gapMask: number, gapCount: number,
 *   covered: string[], coveredMask: number, coveredCount: number,
 *   slots: Array<{key,label,mask,filled:boolean}>,
 *   wornArmorCount: number, streamed: boolean,
 * }}
 */
export function coverageGaps(snapshot) {
  const rows = extractRows(snapshot);
  let coveredMask = 0;
  let wornArmorCount = 0;
  for (const row of rows) {
    const bits = wornArmorBits(row);
    if (bits) {
      coveredMask |= bits;
      wornArmorCount++;
    }
  }
  coveredMask = (coveredMask & IS_BODY_ARMOR) >>> 0;
  const gapMask = (IS_BODY_ARMOR & ~coveredMask) >>> 0;

  const slots = ARMOR_SLOTS.map((s) => ({
    key: s.key,
    label: s.label,
    mask: s.mask,
    filled: (coveredMask & s.mask) !== 0,
  }));

  return {
    gaps: slots.filter((s) => !s.filled).map((s) => s.key),
    gapMask,
    gapCount: getTotalBitsSet(gapMask),
    covered: slots.filter((s) => s.filled).map((s) => s.key),
    coveredMask,
    coveredCount: getTotalBitsSet(coveredMask),
    slots,
    wornArmorCount,
    // false ⇒ the inventory hasn't streamed yet; a director must NOT read
    // the all-nine "gaps" as "the bot is naked" — it's "unknown".
    streamed: rows.length > 0,
  };
}
