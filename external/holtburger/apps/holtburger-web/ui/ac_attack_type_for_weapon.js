/**
 * AttackType inference from an equipped weapon — Wave 1 / Phase 3 of
 * the CombatManeuverTable fixes plan (docs/cmt-fixes-plan-2026-05-26.md).
 *
 * Replaces the hardcoded `ATTACK_TYPE_SLASH` in `scene3d/picking.js:441`
 * so the CMT lookup actually keys on the player's wielded weapon
 * instead of always assuming Slash.
 *
 * ## Sources cross-referenced
 *
 * - **ACE enum (canonical):**
 *   `~/ace-server/Source/ACE.Entity/Enum/AttackType.cs`
 *   defines `Undef=0x0000, Punch=0x0001, Thrust=0x0002, Slash=0x0004,
 *   Kick=0x0008, OffhandPunch=0x0010, DoubleSlash=0x0020, …`.
 *   `Unarmed = Punch | Kick | OffhandPunch` — but the CMT runtime
 *   looks up the *primary* AttackType bit, not the composite, so we
 *   emit `Punch` alone for unarmed (matching the dominant retail
 *   row in `CombatManeuverTable.cs::GetMotion`).
 *
 * - **ACE weapon dispatch (the function we'd port if W_AttackType were
 *   on the wire):**
 *   `~/ace-server/Source/ACE.Server/WorldObjects/WorldObject_Weapon.cs:1050`
 *   `GetAttackType(MotionStance, powerLevel, offhand)` reads
 *   `W_AttackType` (= `PropertyInt::AttackType = 45`) off the weapon
 *   entity, then mutates by stance + powerLevel + ThrustThreshold
 *   (DualWieldCombat / SwordShieldCombat / SwordCombat branches +
 *   the universal `Thrust | Slash → Thrust below threshold, Slash above`
 *   collapse on lines 1154-1160).
 *
 *   We CANNOT directly port that today — `PropertyInt::AttackType` is
 *   NOT surfaced on the entity-update wire (see TODO in
 *   `scene3d/entities.js#getEquippedWeapon`). The fallback used here
 *   keys off the equip-slot bitmask + ItemType, which is what we DO
 *   have. Stance + power-threshold awareness lands in Wave 2 Phase 4
 *   alongside the candidate-selection algorithm fix.
 *
 * - **Retail WeaponType enum (for cross-check):**
 *   `~/ac-headers/acclient.h:7095 enum WeaponType` —
 *   `Undef=0x0, Unarmed=0x1, Sword=0x2, Axe=0x3, Mace=0x4, Spear=0x5,
 *   Dagger=0x6, Staff=0x7, Bow=0x8, Crossbow=0x9, Thrown=0xA,
 *   TwoHanded=0xB, Magic=0xC`. ACE mirrors this in
 *   `~/ace-server/Source/ACE.Entity/Enum/WeaponType.cs`.
 *   `PropertyInt::WeaponType = 89` carries it on the wire. Not
 *   surfaced today either; same TODO.
 *
 * - **EquipMask we DO have (from `holtburger_common::properties::EquipMask`):**
 *   `MELEE_WEAPON=0x00100000, SHIELD=0x00200000, MISSILE_WEAPON=0x00400000,
 *   MISSILE_AMMO=0x00800000, CASTER=0x01000000, TWO_HANDED=0x02000000`.
 *
 * ## Mapping table (Wave 1, equip-slot-based heuristic)
 *
 *   | Input                                  | AttackType returned          |
 *   |----------------------------------------|------------------------------|
 *   | `weapon === null`  (unarmed)           | `Punch  = 0x01`              |
 *   | `equipMask & TWO_HANDED`               | `Slash  = 0x04`              |
 *   | `equipMask & MELEE_WEAPON`             | `Slash  = 0x04`              |
 *   | `equipMask & MISSILE_WEAPON`           | `Undef  = 0x00`  (Phase 6)   |
 *   | `equipMask & MISSILE_AMMO`             | `Undef  = 0x00`  (Phase 6)   |
 *   | `equipMask & CASTER`                   | `Undef  = 0x00`  (magic path) |
 *   | anything else (e.g. SHIELD-only)       | `Undef  = 0x00`              |
 *
 * Why `Slash` for all melee weapons in this iteration:
 *   - Dominant retail AttackType for sword / axe / mace / two-handed
 *     families in the live CMT 0x30000000 is `Slash` (the maneuver
 *     table has `SlashHigh`, `SlashMed`, `SlashLow` rows for
 *     SwordCombat, TwoHandedCombat, etc).
 *   - Dagger families carry `Thrust | Slash` in `W_AttackType` at
 *     retail; ACE's `GetAttackType` collapses to `Thrust` below the
 *     ThrustThreshold power-bar position and `Slash` above. Without
 *     stance + power on this code path (Wave 2), the safer single
 *     choice is `Slash` because the CMT actually has `SlashMed` rows
 *     under DaggerCombat stance, while `ThrustMed` is a separate row
 *     that gets handled in Wave 2 Phase 4 when stance-awareness is
 *     wired.
 *   - Unmapped (caster / ranged / shield-only) returns `Undef = 0` so
 *     the caller falls back to the existing `ATTACK_TYPE_SLASH`
 *     constant — keeps combat working while we extend coverage.
 *
 * ## TODO (Wave 2/4/6 follow-ons)
 *
 * - Surface `W_AttackType` (PropertyInt 45) and `W_WeaponType`
 *   (PropertyInt 89) on `InventoryItem` (wasm-side struct at
 *   `apps/holtburger-web/src/lib.rs:13991`). The data lives on the
 *   weapon entity's `holtburger_common::properties::PropertyInt` map
 *   already (server populates these for any wielded weapon). Once
 *   surfaced, port `WorldObject_Weapon.cs:1050 GetAttackType` here
 *   verbatim — it's a pure stance/powerLevel branch tree, no server
 *   state needed client-side.
 * - Phase 6 (ranged): extend the `MISSILE_WEAPON` branch with the
 *   actual ranged AttackType the retail CMT uses for `BowCombat` /
 *   `CrossbowCombat` / `ThrownWeaponCombat` rows (likely `Slash=0x04`
 *   per the cmt-fixes-plan-2026-05-26.md §Phase 6 audit).
 */

/**
 * ACE AttackType enum (subset). Verbatim bit values from
 * `~/ace-server/Source/ACE.Entity/Enum/AttackType.cs`. Only the
 * primary single-bit types are exported because the CMT runtime
 * indexes on single bits (`MotionStance, AttackHeight, AttackType
 * single-bit`), not composite flags. Composite values like
 * `Unarmed = Punch | Kick | OffhandPunch` are not useful for the
 * lookup key — they'd never match a single-bit table row.
 *
 * @type {Readonly<{
 *   Undef: 0, Punch: 1, Thrust: 2, Slash: 4, Kick: 8,
 *   OffhandPunch: 16, DoubleSlash: 32, TripleSlash: 64,
 *   DoubleThrust: 128, TripleThrust: 256,
 *   OffhandThrust: 512, OffhandSlash: 1024,
 *   OffhandDoubleSlash: 2048, OffhandTripleSlash: 4096,
 *   OffhandDoubleThrust: 8192, OffhandTripleThrust: 16384
 * }>}
 */
export const ATTACK_TYPE = Object.freeze({
  Undef:               0x0000,
  Punch:               0x0001,
  Thrust:              0x0002,
  Slash:               0x0004,
  Kick:                0x0008,
  OffhandPunch:        0x0010,
  DoubleSlash:         0x0020,
  TripleSlash:         0x0040,
  DoubleThrust:        0x0080,
  TripleThrust:        0x0100,
  OffhandThrust:       0x0200,
  OffhandSlash:        0x0400,
  OffhandDoubleSlash:  0x0800,
  OffhandTripleSlash:  0x1000,
  OffhandDoubleThrust: 0x2000,
  OffhandTripleThrust: 0x4000,
});

// EquipMask bit subset we actually inspect. Mirrors
// `holtburger_common::properties::EquipMask` (Rust crate at
// `crates/holtburger-common/src/properties/inventory.rs:158`).
const EQUIP_MASK_MELEE_WEAPON   = 0x00100000;
const EQUIP_MASK_SHIELD         = 0x00200000;  // unused but documented
const EQUIP_MASK_MISSILE_WEAPON = 0x00400000;
const EQUIP_MASK_MISSILE_AMMO   = 0x00800000;
const EQUIP_MASK_CASTER         = 0x01000000;
const EQUIP_MASK_TWO_HANDED     = 0x02000000;

// Reference the SHIELD constant so the future bidirectional-shield
// branch (Wave 2 Phase 4's SwordShieldCombat stance handling) has a
// named bit to point at, and so linters don't strip the doc-only
// constant from the file. No runtime effect.
void EQUIP_MASK_SHIELD;

/**
 * Shape of the weapon record this helper consumes. Matches the subset
 * of `InventoryItem` fields `entities.js#getEquippedWeapon` returns.
 *
 * @typedef {Object} EquippedWeapon
 * @property {number} guid       — weapon item GUID
 * @property {number} wcid       — weenie class id
 * @property {number} itemType   — `ItemType` bitmask (MeleeWeapon=0x1,
 *                                 MissileWeapon=0x100, Caster=0x8000)
 * @property {number} equipMask  — equip-slot bitmask
 * @property {string} [name]     — display name, debug only
 */

/**
 * Infer the primary AttackType bitmask for the given equipped weapon
 * record. See module docstring for the full mapping table + ACE
 * source citations.
 *
 * Returns a single-bit value from `ATTACK_TYPE` (or `Undef = 0`).
 * Single bits matter because the CombatManeuverTable lookup uses the
 * type as a Map key (`r.tree.get(stance).get(height).get(attackType)`)
 * and rows are stored with single-bit codes per
 * `ACE.DatLoader/FileTypes/CombatManeuverTable.cs::Unpack`.
 *
 * @param {EquippedWeapon | null | undefined} weapon
 * @returns {number} one of `ATTACK_TYPE.{Punch, Slash, Undef}` in
 *   this iteration; Wave 2/4/6 will widen the range as
 *   `W_AttackType`/`W_WeaponType` reach the client.
 */
export function inferAttackTypeForWeapon(weapon) {
  // Unarmed — Punch is the dominant melee row under HandCombat stance
  // in CMT 0x30000000 (verified against the parity dump). ACE's
  // `Unarmed = Punch | Kick | OffhandPunch` composite is for damage
  // calc, not for animation table lookup.
  if (weapon == null) return ATTACK_TYPE.Punch;

  const mask = (weapon.equipMask ?? 0) >>> 0;

  // Casters use the magic combat path (CastTargeted / CastUntargeted),
  // which doesn't go through CombatManeuverTable. Return Undef so the
  // caller's fallback constant kicks in — the picking.js melee branch
  // shouldn't even be reached when the player is in MagicCombat stance,
  // so this is defensive only.
  if (mask & EQUIP_MASK_CASTER) return ATTACK_TYPE.Undef;

  // Ranged (bow / crossbow / thrown) + ammo: defer to Wave 2 Phase 6.
  // CMT rows exist under BowCombat / CrossbowCombat / ThrownCombat
  // stances but their AttackType key isn't audited yet. Returning
  // Undef lets the caller's `ATTACK_TYPE_SLASH` fallback fire — which
  // happens to be what the ranged rows use at retail per the plan
  // doc, so combat still works; Phase 6 will audit + replace.
  if (mask & (EQUIP_MASK_MISSILE_WEAPON | EQUIP_MASK_MISSILE_AMMO)) {
    return ATTACK_TYPE.Undef;
  }

  // Melee or two-handed weapon — primary CMT row is Slash. Dagger
  // families are `Thrust | Slash` in `W_AttackType` but the CMT
  // dispatch is mediated by power level (Wave 2 Phase 4); without
  // that, Slash is the safer single choice because it has rows in
  // all melee stances. See module docstring §Mapping table.
  if (mask & (EQUIP_MASK_MELEE_WEAPON | EQUIP_MASK_TWO_HANDED)) {
    return ATTACK_TYPE.Slash;
  }

  // Shield-only / unrecognized — let the caller fall back. This path
  // is reached when the wielded item carries no weapon bit (very rare
  // — usually means the inventory snapshot caught the entity mid-
  // unequip and the slot mask hasn't refreshed yet).
  return ATTACK_TYPE.Undef;
}
