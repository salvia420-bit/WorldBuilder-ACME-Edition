/**
 * Creature — extends Container.
 *
 * 1:1 port of `external/chorizite/ACPlugin/API/WorldObjects/Creature.cs`
 * (vendored HEAD 1341660). Adds the typed Creature surface:
 *   - `radarColor`, `radarBehavior`        (Creature.cs:19, 24)
 *   - `equipment: List<Equippable>`        (Creature.cs:29)
 *   - `stance: MotionStance`               (Creature.cs:34-40)
 *   - `combatMode: CombatMode`             (Creature.cs:45-68)
 *   - `level: int`                         (Creature.cs:73)
 *
 * Per handoff §3 hierarchy: Creature extends Container (NOT WorldObject —
 * inherits Item + Container behavior); NPC/Monster/Player/Vendor extend
 * Creature.
 */

import { Container } from './container.js';

// PropertyInt constants used here (mirrored from
// `crates/holtburger-common/src/properties/property_keys/ints.rs`).
const PROP_INT_RADAR_BLIP_COLOR  = 95;   // Creature.cs:19  PropertyInt.RadarBlipColor
const PROP_INT_SHOWABLE_ON_RADAR = 133;  // Creature.cs:24  PropertyInt.ShowableOnRadar
const PROP_INT_LEVEL             = 25;   // Creature.cs:73  PropertyInt.Level

// PropertyInstanceId for the equipped → wielder linkage. The
// read-through `equipment` getter filters all weenies whose
// `PropertyInstanceId.Wielder` == this creature's guid.
const PROP_INSTANCE_WIELDER      = 3;    // PropertyInstanceId.Wielder

// `MotionStance` enum (Chorizite.Common.Enums.MotionStance.cs:6-78).
// All 17 stance values, ported verbatim. Used by the canonical
// stance→CombatMode switch table below.
export const MotionStance = Object.freeze({
  HandCombat:           60,
  NonCombat:            61,
  SwordCombat:          62,
  BowCombat:            63,
  SwordShieldCombat:    64,
  CrossbowCombat:       65,
  UnusedCombat:         66,
  SlingCombat:          67,
  TwoHandedSwordCombat: 68,
  TwoHandedStaffCombat: 69,
  DualWieldCombat:      70,
  ThrownWeaponCombat:   71,
  Magic:                73,
  BowNoAmmo:            232,
  CrossBowNoAmmo:       233,
  AtlatlCombat:         312,
  ThrownShieldCombat:   313,
});

// `CombatMode` enum (Chorizite.Common.Enums.CombatMode.cs:8-18).
// [Flags] enum: NonCombat=0x1, Melee=0x2, Missile=0x4, Magic=0x8.
export const CombatMode = Object.freeze({
  NonCombat: 0x1,
  Melee:     0x2,
  Missile:   0x4,
  Magic:     0x8,
});

// Canonical stance → CombatMode lookup table. Ported byte-for-byte from
// `Creature.cs:47-66`. Marked load-bearing in the handoff ("port the
// exact table; don't reinvent"). Stances absent from this map fall
// through to NonCombat.
const STANCE_TO_COMBAT_MODE = new Map([
  // — Melee block (Creature.cs:48-53) —
  [MotionStance.HandCombat,           CombatMode.Melee],
  [MotionStance.DualWieldCombat,      CombatMode.Melee],
  [MotionStance.SwordCombat,          CombatMode.Melee],
  [MotionStance.SwordShieldCombat,    CombatMode.Melee],
  [MotionStance.TwoHandedStaffCombat, CombatMode.Melee],
  [MotionStance.TwoHandedSwordCombat, CombatMode.Melee],
  // — Missile block (Creature.cs:55-60) —
  [MotionStance.BowCombat,            CombatMode.Missile],
  [MotionStance.AtlatlCombat,         CombatMode.Missile],
  [MotionStance.CrossbowCombat,       CombatMode.Missile],
  [MotionStance.CrossBowNoAmmo,       CombatMode.Missile],
  [MotionStance.ThrownShieldCombat,   CombatMode.Missile],
  [MotionStance.ThrownWeaponCombat,   CombatMode.Missile],
  // — Magic block (Creature.cs:62) —
  [MotionStance.Magic,                CombatMode.Magic],
  // — fall-through (Creature.cs:64): NonCombat for everything else,
  //   including MotionStance.NonCombat itself, UnusedCombat,
  //   SlingCombat, and BowNoAmmo.
]);

export class Creature extends Container {
  constructor(...args) {
    super(...args);

    /**
     * Backing field for the stance getter — defaults to NonCombat. The
     * setter ignores writes of `0` per `Creature.cs:36-39`:
     *   `set { if (value != 0) _stance = value; }`
     * @type {number}
     */
    this._stance = MotionStance.NonCombat;
  }

  /**
   * Radar blip color. Mirrors `Creature.cs:19`:
   *   `(RadarColor)Value(PropertyInt.RadarBlipColor)`
   * Returned as a raw uint; downstream casts to the `RadarColor` enum.
   * @returns {number}
   */
  get radarColor() {
    return this.intValue(PROP_INT_RADAR_BLIP_COLOR, 0);
  }

  /**
   * Radar behavior. Mirrors `Creature.cs:24`:
   *   `(RadarBehavior)Value(PropertyInt.ShowableOnRadar)`
   * Returned as a raw uint; downstream casts to the `RadarBehavior` enum.
   * @returns {number}
   */
  get radarBehavior() {
    return this.intValue(PROP_INT_SHOWABLE_ON_RADAR, 0);
  }

  /**
   * The stance the creature is in. Mirrors `Creature.cs:34-40`:
   *   `get => _stance == 0 ? MotionStance.NonCombat : _stance`
   * (The == 0 guard is defensive — the ctor seeds _stance with NonCombat,
   * but a future code path that explicitly assigns 0 would surface as
   * NonCombat via this getter.)
   * @returns {number}
   */
  get stance() {
    return this._stance === 0 ? MotionStance.NonCombat : this._stance;
  }

  /**
   * Set the stance. Mirrors `Creature.cs:36-39`:
   *   `set { if (value != 0) _stance = value; }`
   * Writes of 0 are silently ignored (defensive — wire packets sometimes
   * carry a 0 stance during transition frames).
   * @param {number} value MotionStance
   */
  set stance(value) {
    if (value !== 0 && value != null) this._stance = value >>> 0;
  }

  /**
   * Derived combat mode from the current stance. Mirrors `Creature.cs:45-68`
   * switch table verbatim — load-bearing per handoff.
   *
   * @returns {number} CombatMode
   */
  get combatMode() {
    return STANCE_TO_COMBAT_MODE.get(this.stance) ?? CombatMode.NonCombat;
  }

  /**
   * The creature's level. Mirrors `Creature.cs:73`:
   *   `Value(PropertyInt.Level)`
   * @returns {number}
   */
  get level() {
    return this.intValue(PROP_INT_LEVEL, 0);
  }

  /**
   * Equipment worn/wielded by this creature. Read-through over the
   * world's weenie map: filters for entries whose
   * `PropertyInstanceId.Wielder` equals this creature's GUID.
   *
   * Mirrors `Creature.cs:29` `Equipment { get; set; } = []`. Upstream
   * maintains this as a runtime-mutated list (via `Character.SetWielded`);
   * we use the same read-through pattern as `Container.items` /
   * `Container.containers` to avoid the consistency-maintenance bugs the
   * upstream version is prone to. The wire path (`World.cs:368-377`
   * → `Character.SetWielded`) drops `PropertyInstanceId.Wielder` onto the
   * equippable's property store, which is the same backing data this
   * getter consults.
   *
   * Returns only weenies that pass the Equippable duck-type test (have
   * `setWielded` method on the prototype). Static/Door/Portal that
   * happen to share PropertyInstanceId.Wielder (rare but legal) are
   * filtered out.
   *
   * @returns {Array<object>}
   */
  get equipment() {
    const out = [];
    for (const wo of this._allWeenies()) {
      if (wo.id === this.id) continue;
      if (wo.instanceValue(PROP_INSTANCE_WIELDER, 0) !== this.id) continue;
      // Duck-type for Equippable: only Equippable subclasses expose the
      // `setWielded` method (added in equippable.js). Skip non-equippables
      // that happen to have the wielder slot set.
      if (typeof wo.setWielded !== 'function') continue;
      out.push(wo);
    }
    return out;
  }
}
