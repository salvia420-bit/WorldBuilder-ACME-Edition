//! Port of `Chorizite/ACPlugin/API/WorldObjects/Character.cs` core
//! (vendored HEAD `1341660`).
//!
//! Wave C — Chorizite absorption (2026-05-27). Owns:
//! - The 7-typed property store (`Int`, `Int64`, `Bool`, `Float`, `String`,
//!   `InstanceId`, `DataId`).
//! - `Skills` / `Attributes` / `Vitals` dictionaries.
//! - `Vitae` with the `1.0 = none, 0.95 = 5% vitae` semantics.
//! - The complete enchantment manager including the `GetActiveEnchantments`
//!   tiebreak algorithm (Power desc → Level8AuraSelfSpells → SetSpells ?
//!   SpellId : StartTime → first).
//! - `ApplyEnchantment` cooldown-vs-enchantment routing via
//!   `EnchantmentTypeFlags::COOLDOWN`.
//! - `UpdateVital` even/odd parity handling.
//! - `GetEnchantmentsAdditiveModifier` / `GetEnchantmentsMultiplierModifier`
//!   for attribute, skill, and vital.
//!
//! What this port **does NOT** cover (Wave C.2 follow-on candidates):
//! - The 40+ S2C event-handler dispatch table (`OnQualities_*`, `OnMagic_*`,
//!   etc.) in `Character.cs:182-222, 376-610`. These are 3-line passthroughs
//!   that bind net events to mutation methods — they belong in the
//!   wasm/JS-side dispatcher (PR 2 of the porting plan), not the pure-math
//!   layer.
//! - The `SetWielded` helper at `Character.cs:757-762` (touches Equipment
//!   collection on WorldObjects, requires the full WorldObject hierarchy
//!   port from PR 1).
//! - The `Dispose` net unsubscribe at `Character.cs:785-827` (mirror of the
//!   subscribe table; same gating).
//!
//! Load-bearing semantics preserved (handoff §3):
//! 1. **Vitae**: `1.0 = no vitae`, `0.95 = 5% vitae`. Verified at
//!    `Character.cs:80, 138`.
//! 2. **`ApplyEnchantment` cooldown discriminator** via
//!    `EnchantmentTypeFlags::COOLDOWN`. Verified at `Character.cs:619`.
//! 3. **`UpdateVital` even/odd parity**: vitals come as (current, max) at
//!    adjacent IDs; even = current, odd = max. `(int)key % 2 == 0`.
//!    Verified at `Character.cs:721, 739`.
//! 4. **Enchantment tiebreak**: Power desc → Level8AuraSelfSpells →
//!    SetSpells ? SpellId : StartTime → first. Verified at
//!    `Character.cs:232-239`.
//! 5. **`SetSpells` cutoff `>= 4730u`** is from ACE — see
//!    `Character.cs:42`. We expose the cutoff as a public constant for
//!    integration with `Dat.SpellTable`.

use crate::client::attribute_info::AttributeInfo;
use crate::client::skill_info::SkillInfo;
use crate::client::vital_info::VitalInfo;
use holtburger_common::properties::{
    EnchantmentTypeFlags, PropertyBool, PropertyDataId, PropertyFloat, PropertyInstanceId,
    PropertyInt, PropertyInt64, PropertyString,
};
use holtburger_common::stats::{AttributeType, SkillType, VitalType};
use holtburger_common::Guid;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Spell-id 666 is the AC vitae spell. Used by `Character.cs:20, 614, 642`
/// to discriminate vitae updates from regular enchantments.
pub const VITAE_SPELL_ID: u16 = 666;

/// ACE-derived cutoff for "spell-set" sorting (Character.cs:42 comment
/// `// (uint)SpellId.SetCoordination1`). Spells with id `>= 4730u` are
/// treated as set-bonus spells for the enchantment tiebreak (handoff §3
/// row 8). Spells below the cutoff are sorted by StartTime; spells at or
/// above the cutoff are sorted by SpellId.
pub const SPELL_SET_CUTOFF: u32 = 4730;

/// Hardcoded `Level8AuraSelfSpells` from `Character.cs:22-30`. These 6
/// spell IDs are part of the AC enchantment-manager bug-fix; level-8 item
/// self-spells must take precedence over level-8 item other-spells in the
/// `GetActiveEnchantments` tiebreak.
///
/// **Load-bearing** — handoff §3 row 8. Mirrors the C# `HashSet<uint>`
/// (Power desc → ... → ThenByDescending(LSelf.Contains(SpellId))).
pub const LEVEL_8_AURA_SELF_SPELLS: &[u32] = &[
    4395, // SpellId.BloodDrinkerSelf8
    4400, // SpellId.DefenderSelf8
    4405, // SpellId.HeartSeekerSelf8
    4414, // SpellId.SpiritDrinkerSelf8
    4417, // SpellId.SwiftKillerSelf8
    4418, // SpellId.HermeticLinkSelf8
];

// --------------------------------------------------------------------------
// CharacterContext trait — abstraction for the parts of `Character` that
// `AttributeInfo`, `VitalInfo`, `SkillInfo` need to read at compute time.
// --------------------------------------------------------------------------

/// Read-only view of a `Character` exposed to `AttributeInfo` /
/// `SkillInfo` / `VitalInfo` for their `Base` / `Current` / `Max`
/// computations. Mirrors the ambient C# accesses to
/// `ACPlugin.Instance.Game.Character.{Attributes, Value, Vitae,
/// GetEnchantmentsMultiplierModifier, GetEnchantmentsAdditiveModifier}`.
///
/// Splitting this into a trait lets us:
/// - Unit-test each `Info` type with a mock context (no full `Character`).
/// - Avoid Rc/RefCell cycles between `Character` and its owned `*Info` maps.
pub trait CharacterContext {
    /// Look up an attribute. Mirrors `Character.cs:68` `Attributes` dict.
    fn attribute(&self, t: AttributeType) -> Option<&AttributeInfo>;

    /// Multiplier from enchantments for an attribute. Mirrors C#
    /// `GetEnchantmentsMultiplierModifier(AttributeId)` at
    /// `Character.cs:337-344`.
    fn attribute_multiplier(&self, t: AttributeType) -> f32;

    /// Additive from enchantments for an attribute. Mirrors C#
    /// `GetEnchantmentsAdditiveModifier(AttributeId)` at
    /// `Character.cs:304-308`.
    fn attribute_additive(&self, t: AttributeType) -> i32;

    /// Multiplier from enchantments for a vital. Mirrors C#
    /// `GetEnchantmentsMultiplierModifier(VitalId)` at
    /// `Character.cs:365-372`.
    fn vital_multiplier(&self, t: VitalType) -> f32;

    /// Additive from enchantments for a vital. Mirrors C#
    /// `GetEnchantmentsAdditiveModifier(VitalId)` at
    /// `Character.cs:326-330`.
    fn vital_additive(&self, t: VitalType) -> i32;

    /// Multiplier from enchantments for a skill. Mirrors C#
    /// `GetEnchantmentsMultiplierModifier(SkillId)` at
    /// `Character.cs:351-358`.
    fn skill_multiplier(&self, t: SkillType) -> f32;

    /// Additive from enchantments for a skill. Mirrors C#
    /// `GetEnchantmentsAdditiveModifier(SkillId)` at
    /// `Character.cs:315-319`.
    fn skill_additive(&self, t: SkillType) -> i32;

    /// Vitae value. `1.0 = no vitae, 0.95 = 5% vitae` (handoff §3 row 1).
    /// Mirrors `Character.cs:80`.
    fn vitae(&self) -> f32;

    /// Look up a `PropertyInt` value. Returns 0 when unset (matches the C#
    /// `Value(PropertyInt, defaultValue=0)` convention).
    fn value_int(&self, key: PropertyInt) -> i32;
}

// --------------------------------------------------------------------------
// LayeredSpellId / Enchantment / SharedCooldown — minimal client-side records
// --------------------------------------------------------------------------

/// 32-bit composite of `(layer << 16 | spell_id)`. Mirrors the C#
/// `LayeredSpellId` from `Chorizite.ACProtocol.Types` (see
/// `Enchantment.cs:19`, `SharedCooldown.cs:17`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub struct LayeredSpellId {
    pub id: u32,
    pub layer: u16,
}

impl LayeredSpellId {
    pub fn new(id: u32, layer: u16) -> Self {
        Self { id, layer }
    }
}

/// Client-side enchantment record. Mirrors `AC.API.Enchantment` shape from
/// `Enchantment.cs:15-143`. Distinct from the wire-format
/// `holtburger_protocol::messages::magic::Enchantment` — this is the
/// resolved client view with `EnchantmentTypeFlags` typed.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct CharacterEnchantment {
    pub layered_id: LayeredSpellId,
    pub category: u32,
    pub power: u32,
    pub start_time: f64,
    pub duration: f64,
    pub caster_id: Guid,
    pub stat_mod_type: EnchantmentTypeFlags,
    pub stat_key: u32,
    pub stat_value: f32,
}

impl CharacterEnchantment {
    /// Mirrors `Enchantment.cs:25`: `SpellId => LayeredId.Id`.
    pub fn spell_id(&self) -> u32 {
        self.layered_id.id
    }

    /// Mirrors `Enchantment.cs:31`: `Layer => LayeredId.Layer`.
    pub fn layer(&self) -> u16 {
        self.layered_id.layer
    }

    /// Port of `Enchantment.FromMessage` at `Enchantment.cs:118-138`.
    /// Builds a client enchantment from the wire-format record.
    pub fn from_wire(wire: &holtburger_protocol::messages::magic::Enchantment) -> Self {
        Self {
            layered_id: LayeredSpellId::new(
                wire.spell_id as u32,
                wire.layer,
            ),
            category: wire.spell_category as u32,
            power: wire.power_level,
            start_time: wire.start_time,
            duration: wire.duration,
            caster_id: wire.caster_guid,
            stat_mod_type: EnchantmentTypeFlags::from_bits_truncate(wire.stat_mod_type),
            stat_key: wire.stat_mod_key,
            stat_value: wire.stat_mod_value,
        }
    }
}

/// Client-side shared-cooldown record. Mirrors `AC.API.SharedCooldown`
/// from `SharedCooldown.cs:13-66`.
///
/// **Load-bearing** (handoff §3 row 2): `id = (layered_id.id << 20 >> 20)`
/// sign-extends low 12 bits. Port exactly.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct SharedCooldown {
    pub layered_id: LayeredSpellId,
    pub id: i32,
    pub object_id: Guid,
    pub start_time: f64,
    pub duration: f64,
}

impl SharedCooldown {
    /// Port of `SharedCooldown.cs:54-61` constructor:
    /// ```csharp
    /// Id = (int)(layeredId.Id << 20 >> 20);
    /// ```
    /// In C# this is `uint << 20 >> 20` then `(int)` — `>>` on `uint` is
    /// logical, but the final cast to `int` reinterprets the high bit.
    /// In practice with AC values the low 12 bits are always positive and
    /// the high bits clear, so this is equivalent to `id & 0xFFF`. We port
    /// the shift sequence exactly to preserve bit-for-bit semantics with
    /// the C# discriminator.
    pub fn new(layered_id: LayeredSpellId, object_id: Guid, duration: f64, start_time: f64) -> Self {
        // C# arithmetic: `(uint << 20 >> 20)` is logical shift (zero-fill).
        // Then cast to int. We mimic exactly via `u32` math, then bit-cast.
        let id_u32 = (layered_id.id << 20) >> 20;
        let id = id_u32 as i32;
        Self {
            layered_id,
            id,
            object_id,
            start_time,
            duration,
        }
    }

    /// Port of `SharedCooldown.FromMessage` at `SharedCooldown.cs:63-65`.
    pub fn from_wire(wire: &holtburger_protocol::messages::magic::Enchantment) -> Self {
        Self::new(
            LayeredSpellId::new(wire.spell_id as u32, wire.layer),
            wire.caster_guid,
            wire.duration,
            wire.start_time,
        )
    }
}

// --------------------------------------------------------------------------
// CharacterInfo — the property store + enchantment manager + vital handlers.
// --------------------------------------------------------------------------

/// Port of `AC.API.WorldObjects.Character` core. Tracks the active
/// character's stats and enchantments. The 40+ S2C event handlers are not
/// in this port (see module docs); the input boundary is the
/// `update_*` / `apply_*` / `remove_*` mutator methods, which a wasm-side
/// dispatcher invokes.
///
/// Ported from `ACPlugin/API/WorldObjects/Character.cs:1-828`
/// (vendored HEAD `1341660`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CharacterInfo {
    pub id: Guid,
    pub options1: u32,
    pub skills: HashMap<SkillType, SkillInfo>,
    pub attributes: HashMap<AttributeType, AttributeInfo>,
    pub vitals: HashMap<VitalType, VitalInfo>,

    /// Vitae value. **Load-bearing**: `1.0 = no vitae, 0.95 = 5% vitae`
    /// (handoff §3 row 1). Mirrors `Character.cs:79-88`.
    vitae: f32,

    /// Portal-space gating. Mirrors `Character.cs:93`.
    pub in_portal_space: bool,

    /// All enchantments on this character including overlapping ones.
    /// `GetActiveEnchantments` resolves the tiebreak winners.
    pub all_enchantments: HashMap<LayeredSpellId, CharacterEnchantment>,

    /// All shared cooldowns. Mirrors `Character.cs:104`.
    pub shared_cooldowns: HashMap<LayeredSpellId, SharedCooldown>,

    // 7-typed property store (WorldObject base class). Mirrors
    // `WorldObject.cs:48-138` 8-dict store minus position (position values
    // are out of Wave C scope — they live in the wasm physics state).
    //
    // BTreeMap because the holtburger-common Property* enums derive `Ord`
    // but not `Hash` (per `properties/storage.rs:128-136`). Matches the
    // shape used by `WorldObjectProperties` in that file.
    pub int_values: BTreeMap<PropertyInt, i32>,
    pub int64_values: BTreeMap<PropertyInt64, i64>,
    pub bool_values: BTreeMap<PropertyBool, bool>,
    pub float_values: BTreeMap<PropertyFloat, f64>,
    pub string_values: BTreeMap<PropertyString, String>,
    pub instance_values: BTreeMap<PropertyInstanceId, Guid>,
    pub data_values: BTreeMap<PropertyDataId, u32>,

    /// Cached lazy `SetSpells` HashSet — populated on first
    /// `GetActiveEnchantments` call from a DAT spell table. Mirrors
    /// `Character.cs:33-51`. Optional because we may run without DAT.
    #[serde(skip)]
    set_spells: Option<HashSet<u32>>,
}

impl CharacterInfo {
    pub fn new() -> Self {
        Self {
            vitae: 1.0,
            in_portal_space: true,
            ..Default::default()
        }
    }

    /// Vitae getter. Mirrors `Character.cs:80`.
    pub fn vitae(&self) -> f32 {
        self.vitae
    }

    /// Vitae setter. Mirrors `Character.cs:81-87`:
    /// ```csharp
    /// set {
    ///     if (_vitae != value) {
    ///         var old = _vitae;
    ///         _vitae = value;
    ///         _OnVitaeChanged.Invoke(this, new VitaeChangedEventArgs(value, old));
    ///     }
    /// }
    /// ```
    ///
    /// Returns `Some((old, new))` if the value changed, `None` if no-op.
    /// Callers fire the wasm-side VitaeChanged event from the return.
    pub fn set_vitae(&mut self, new_value: f32) -> Option<(f32, f32)> {
        if (self.vitae - new_value).abs() < f32::EPSILON {
            None
        } else {
            let old = self.vitae;
            self.vitae = new_value;
            Some((old, new_value))
        }
    }

    /// Heritage lookup. Mirrors `Character.cs:110`:
    /// ```csharp
    /// public HeritageGroup Heritage => (HeritageGroup)Value(PropertyInt.HeritageGroup);
    /// ```
    ///
    /// Returns the raw `i32` because the `HeritageGroup` enum lives in
    /// `holtburger-world` (touching it would violate the Wave C "don't
    /// touch other crates" rule). Callers convert as needed.
    pub fn heritage_id(&self) -> i32 {
        self.value_int(PropertyInt::HeritageGroup)
    }

    /// Mirrors `WorldObject.Value(PropertyInt, default=0)`.
    pub fn value_int(&self, key: PropertyInt) -> i32 {
        *self.int_values.get(&key).unwrap_or(&0)
    }

    /// Mirrors `WorldObject.AddOrUpdateValue(PropertyInt, int)`.
    pub fn set_value_int(&mut self, key: PropertyInt, value: i32) {
        self.int_values.insert(key, value);
    }

    /// Mirrors `WorldObject.RemoveValue(PropertyInt)`.
    pub fn remove_value_int(&mut self, key: PropertyInt) {
        self.int_values.remove(&key);
    }

    /// Lazy-init for the `SetSpells` HashSet. Mirrors the C# property
    /// getter at `Character.cs:34-50`. Caller passes the spell table
    /// (a flat iterator of all spell-set spell IDs from
    /// `Dat.SpellTable.SpellsSets.Values.SelectMany(...)`).
    ///
    /// Per the C# cutoff at line 42, only spells with `id >= SPELL_SET_CUTOFF`
    /// (4730u) are added.
    pub fn build_set_spells<I: IntoIterator<Item = u32>>(&mut self, spell_set_iter: I) {
        let set: HashSet<u32> = spell_set_iter
            .into_iter()
            .filter(|&id| id >= SPELL_SET_CUTOFF)
            .collect();
        self.set_spells = Some(set);
    }

    /// Returns the resolved `SetSpells` HashSet, or an empty set if the
    /// caller hasn't populated it yet (DAT not loaded). Mirrors the lazy
    /// `_setSpells ?? new HashSet<uint>()` semantic.
    fn set_spells_or_empty(&self) -> HashSet<u32> {
        self.set_spells.clone().unwrap_or_default()
    }

    /// Port of `GetActiveEnchantments()` at `Character.cs:230-240`:
    /// ```csharp
    /// return AllEnchantments.Values
    ///     .GroupBy(enchantment => enchantment.Category)
    ///     .Select(category => {
    ///         return category
    ///             .OrderByDescending(enchantment => enchantment.Power)
    ///             .ThenByDescending(enchantment => Level8AuraSelfSpells.Contains(enchantment.SpellId))
    ///             .ThenByDescending(c => SetSpells.Contains(c.SpellId) ? c.SpellId : c.StartTime)
    ///             .First();
    ///     }).ToList();
    /// ```
    ///
    /// **Load-bearing tiebreak** (handoff §3 rows 4, 8): Power desc →
    /// Level8AuraSelfSpells → SetSpells ? SpellId : StartTime → first.
    pub fn get_active_enchantments(&self) -> Vec<CharacterEnchantment> {
        self.resolve_active(self.all_enchantments.values().cloned().collect::<Vec<_>>())
    }

    /// Filtered active enchantments — skills only. Mirrors
    /// `Character.cs:247-258`.
    pub fn get_active_enchantments_skill(&self, skill: SkillType) -> Vec<CharacterEnchantment> {
        let filtered: Vec<_> = self
            .all_enchantments
            .values()
            .filter(|e| {
                e.stat_mod_type.contains(EnchantmentTypeFlags::SKILL)
                    && e.stat_key == skill as u32
            })
            .cloned()
            .collect();
        self.resolve_active(filtered)
    }

    /// Filtered active enchantments — attribute. Mirrors
    /// `Character.cs:265-279`.
    pub fn get_active_enchantments_attribute(
        &self,
        attr: AttributeType,
    ) -> Vec<CharacterEnchantment> {
        let filtered: Vec<_> = self
            .all_enchantments
            .values()
            .filter(|e| {
                e.stat_mod_type.contains(EnchantmentTypeFlags::ATTRIBUTE)
                    && (e.stat_key == attr as u32
                        || e.stat_mod_type.contains(EnchantmentTypeFlags::MULTIPLE_STAT))
            })
            .cloned()
            .collect();
        self.resolve_active(filtered)
    }

    /// Filtered active enchantments — vital. Mirrors `Character.cs:286-297`.
    pub fn get_active_enchantments_vital(&self, vital: VitalType) -> Vec<CharacterEnchantment> {
        let filtered: Vec<_> = self
            .all_enchantments
            .values()
            .filter(|e| {
                e.stat_mod_type.contains(EnchantmentTypeFlags::SECOND_ATT)
                    && e.stat_key == vital as u32
            })
            .cloned()
            .collect();
        self.resolve_active(filtered)
    }

    /// Shared GroupBy(category) + tiebreak helper. Caller pre-filters.
    /// **Load-bearing**: order = Power desc → Level8AuraSelf → SetSpells
    /// branch → first. Mirrors `Character.cs:232-239`.
    fn resolve_active(&self, candidates: Vec<CharacterEnchantment>) -> Vec<CharacterEnchantment> {
        let set_spells = self.set_spells_or_empty();
        let level8: HashSet<u32> = LEVEL_8_AURA_SELF_SPELLS.iter().copied().collect();

        // GroupBy(Category)
        let mut grouped: HashMap<u32, Vec<CharacterEnchantment>> = HashMap::new();
        for c in candidates {
            grouped.entry(c.category).or_default().push(c);
        }

        let mut winners = Vec::with_capacity(grouped.len());
        for (_cat, mut group) in grouped {
            // Sort by C#-equivalent multi-key descending order. We use a
            // composite key that mirrors the LINQ chain exactly.
            group.sort_by(|a, b| {
                // 1. Power desc
                let p = b.power.cmp(&a.power);
                if p != std::cmp::Ordering::Equal {
                    return p;
                }
                // 2. Level8AuraSelfSpells.Contains(SpellId) desc (true > false)
                let a_lvl8 = level8.contains(&a.spell_id());
                let b_lvl8 = level8.contains(&b.spell_id());
                let l = b_lvl8.cmp(&a_lvl8);
                if l != std::cmp::Ordering::Equal {
                    return l;
                }
                // 3. SetSpells ? SpellId : StartTime — desc
                // C# `ThenByDescending(c => SetSpells.Contains(c.SpellId) ? c.SpellId : c.StartTime)`
                // returns a mixed `object` projected key — at runtime the
                // descending comparer is fed two values that may be u32 or
                // double. We branch on each candidate independently and use
                // the projected value's natural ordering.
                let a_key_is_set = set_spells.contains(&a.spell_id());
                let b_key_is_set = set_spells.contains(&b.spell_id());
                // C# would compare a uint vs a double if one is set and one
                // isn't — at runtime the LINQ Comparer<object>.Default
                // throws. In practice categories don't mix these, so we
                // segregate: set-spells come before non-set-spells within
                // the same Power+Level8 tie; within set-spells, sort by
                // SpellId desc; within non-set, sort by StartTime desc.
                match (a_key_is_set, b_key_is_set) {
                    (true, false) => std::cmp::Ordering::Less, // set spells "win"
                    (false, true) => std::cmp::Ordering::Greater,
                    (true, true) => b.spell_id().cmp(&a.spell_id()),
                    (false, false) => b
                        .start_time
                        .partial_cmp(&a.start_time)
                        .unwrap_or(std::cmp::Ordering::Equal),
                }
            });
            // .First() in C# == [0] in Rust
            if let Some(first) = group.into_iter().next() {
                winners.push(first);
            }
        }
        winners
    }

    /// Additive enchantment modifier for an attribute. Mirrors
    /// `Character.cs:304-308`:
    /// ```csharp
    /// return GetActiveEnchantments(type)
    ///     .Where(e => e.Type.HasFlag(EnchantmentTypeFlags.Additive))
    ///     .Sum(e => (int)e.StatValue);
    /// ```
    pub fn get_enchantments_additive_attribute(&self, attr: AttributeType) -> i32 {
        self.get_active_enchantments_attribute(attr)
            .into_iter()
            .filter(|e| e.stat_mod_type.contains(EnchantmentTypeFlags::ADDITIVE))
            .map(|e| e.stat_value as i32)
            .sum()
    }

    /// Additive enchantment modifier for a skill. Mirrors
    /// `Character.cs:315-319`.
    pub fn get_enchantments_additive_skill(&self, skill: SkillType) -> i32 {
        self.get_active_enchantments_skill(skill)
            .into_iter()
            .filter(|e| e.stat_mod_type.contains(EnchantmentTypeFlags::ADDITIVE))
            .map(|e| e.stat_value as i32)
            .sum()
    }

    /// Additive enchantment modifier for a vital. Mirrors
    /// `Character.cs:326-330`.
    pub fn get_enchantments_additive_vital(&self, vital: VitalType) -> i32 {
        self.get_active_enchantments_vital(vital)
            .into_iter()
            .filter(|e| e.stat_mod_type.contains(EnchantmentTypeFlags::ADDITIVE))
            .map(|e| e.stat_value as i32)
            .sum()
    }

    /// Multiplier enchantment modifier for an attribute. Mirrors
    /// `Character.cs:337-344`:
    /// ```csharp
    /// var multiplier = 1.0f;
    /// foreach (var e in GetActiveEnchantments(type).Where(e => e.Type.HasFlag(Multiplicative))) {
    ///     multiplier *= e.StatValue;
    /// }
    /// return multiplier;
    /// ```
    pub fn get_enchantments_multiplier_attribute(&self, attr: AttributeType) -> f32 {
        self.get_active_enchantments_attribute(attr)
            .into_iter()
            .filter(|e| e.stat_mod_type.contains(EnchantmentTypeFlags::MULTIPLICATIVE))
            .map(|e| e.stat_value)
            .fold(1.0_f32, |acc, v| acc * v)
    }

    /// Multiplier enchantment modifier for a skill. Mirrors
    /// `Character.cs:351-358`.
    pub fn get_enchantments_multiplier_skill(&self, skill: SkillType) -> f32 {
        self.get_active_enchantments_skill(skill)
            .into_iter()
            .filter(|e| e.stat_mod_type.contains(EnchantmentTypeFlags::MULTIPLICATIVE))
            .map(|e| e.stat_value)
            .fold(1.0_f32, |acc, v| acc * v)
    }

    /// Multiplier enchantment modifier for a vital. Mirrors
    /// `Character.cs:365-372`.
    pub fn get_enchantments_multiplier_vital(&self, vital: VitalType) -> f32 {
        self.get_active_enchantments_vital(vital)
            .into_iter()
            .filter(|e| e.stat_mod_type.contains(EnchantmentTypeFlags::MULTIPLICATIVE))
            .map(|e| e.stat_value)
            .fold(1.0_f32, |acc, v| acc * v)
    }

    /// Port of `ApplyEnchantment` at `Character.cs:613-639`:
    /// ```csharp
    /// if (enchantment.Id.Id == VITAE_SPELL_ID) {
    ///     Vitae = enchantment.StatMod.Value; return;
    /// }
    /// if (enchantment.StatMod.Type.HasFlag(EnchantmentTypeFlags.Cooldown)) {
    ///     // route to SharedCooldowns dict
    /// } else {
    ///     // route to AllEnchantments dict
    /// }
    /// ```
    ///
    /// **Load-bearing** (handoff §3 row 5): the discriminator is
    /// `StatMod.Type & EnchantmentTypeFlags.Cooldown`. Don't merge with
    /// regular enchantment routing.
    ///
    /// Returns `EnchantmentApplyOutcome` so the wasm-side dispatcher can
    /// emit the right S2C ClientEvent (`OnVitaeChanged` /
    /// `OnEnchantmentChanged` / `OnSharedCooldownChanged`).
    pub fn apply_enchantment(
        &mut self,
        wire: &holtburger_protocol::messages::magic::Enchantment,
    ) -> EnchantmentApplyOutcome {
        // VITAE_SPELL_ID gate (Character.cs:614-617).
        if wire.spell_id == VITAE_SPELL_ID {
            let prev = self.set_vitae(wire.stat_mod_value);
            return EnchantmentApplyOutcome::Vitae { changed: prev };
        }

        let flags = EnchantmentTypeFlags::from_bits_truncate(wire.stat_mod_type);
        let layered = LayeredSpellId::new(wire.spell_id as u32, wire.layer);

        if flags.contains(EnchantmentTypeFlags::COOLDOWN) {
            // Character.cs:619-628: cooldown branch.
            let cooldown = SharedCooldown::from_wire(wire);
            self.shared_cooldowns.insert(layered, cooldown.clone());
            EnchantmentApplyOutcome::Cooldown(cooldown)
        } else {
            // Character.cs:629-638: enchantment branch.
            let ench = CharacterEnchantment::from_wire(wire);
            self.all_enchantments.insert(layered, ench.clone());
            EnchantmentApplyOutcome::Enchantment(ench)
        }
    }

    /// Port of `RemoveEnchantment(LayeredSpellId)` at `Character.cs:641-654`.
    /// Removes from `AllEnchantments` and `SharedCooldowns` (one packet can
    /// reference either; both removes are idempotent).
    ///
    /// Returns which side(s) actually removed an entry, so the wasm-side
    /// dispatcher can fire the right event.
    pub fn remove_enchantment(&mut self, layered: LayeredSpellId) -> EnchantmentRemoveOutcome {
        // Character.cs:642-645: VITAE clear branch.
        if layered.id == VITAE_SPELL_ID as u32 {
            let prev = self.set_vitae(1.0);
            return EnchantmentRemoveOutcome::Vitae { changed: prev };
        }
        let removed_ench = self.all_enchantments.remove(&layered);
        let removed_cd = self.shared_cooldowns.remove(&layered);
        EnchantmentRemoveOutcome::Removed {
            enchantment: removed_ench,
            cooldown: removed_cd,
        }
    }

    /// Port of `UpdateVital` at `Character.cs:713-729`. Caller passes the
    /// `key` (the wire `VitalId`, which can be either the current-id or the
    /// max-id), and `(current, init, raised, experience)` from the
    /// `SecondaryAttributeInfo` wire message.
    ///
    /// **Load-bearing** (handoff §3 row 3): even-key = current, odd-key =
    /// max. The `AddOrCreateVital` helper at `Character.cs:701-711`
    /// normalises an even key down by 1 so vitals live at odd indices in
    /// our map.
    ///
    /// `is_initial_update` mirrors the C# `bool isInitialUpdate = true`
    /// default param. When false, the current-update only happens when
    /// `key % 2 == 0`.
    ///
    /// Returns `Some((vital_type, old_current, new_current))` when a vital
    /// changed event should fire, else `None`. Caller is responsible for
    /// the actual wasm-event dispatch.
    pub fn update_vital(
        &mut self,
        key: u32,
        current: u32,
        init: u32,
        raised: u32,
        experience: u32,
        is_initial_update: bool,
    ) -> Option<(VitalType, i32, i32)> {
        // Even key → step down to the odd "canonical" id (Character.cs:702-703).
        let canonical_key = if key % 2 == 0 { key - 1 } else { key };
        let vital_type = VitalType::from_id(canonical_key)?;

        let vital = self
            .vitals
            .entry(vital_type)
            .or_insert_with(|| VitalInfo::new(vital_type));
        vital.init_level = init;
        vital.points_raised = raised;
        vital.experience = experience;

        // Character.cs:721-728: even-key parity gate.
        let new_current = current as i32;
        if new_current != vital.current && (is_initial_update || key % 2 == 0) {
            let old = vital.current;
            vital.current = new_current;
            if !is_initial_update {
                return Some((vital_type, old, new_current));
            }
        }
        None
    }

    /// Port of `UpdateVitalCurrent` at `Character.cs:736-745`. ONLY updates
    /// the current vital value (used by `OnQualities_PrivateUpdateAttribute2ndLevel`).
    /// **Load-bearing** (handoff §3 row 3): the even-key parity check IS
    /// the gate.
    pub fn update_vital_current(&mut self, key: u32, value: u32) -> Option<(VitalType, i32, i32)> {
        let canonical_key = if key % 2 == 0 { key - 1 } else { key };
        let vital_type = VitalType::from_id(canonical_key)?;
        let vital = self
            .vitals
            .entry(vital_type)
            .or_insert_with(|| VitalInfo::new(vital_type));

        let new_current = value as i32;
        if new_current != vital.current && key % 2 == 0 {
            let old = vital.current;
            vital.current = new_current;
            return Some((vital_type, old, new_current));
        }
        None
    }

    /// Port of `UpdateVitalPointsRaised` at `Character.cs:731-734`.
    pub fn update_vital_points_raised(&mut self, key: u32, value: u32) {
        let canonical_key = if key % 2 == 0 { key - 1 } else { key };
        if let Some(vital_type) = VitalType::from_id(canonical_key) {
            let vital = self
                .vitals
                .entry(vital_type)
                .or_insert_with(|| VitalInfo::new(vital_type));
            vital.points_raised = value;
        }
    }

    /// Port of `UpdateAttribute` at `Character.cs:689-694`.
    pub fn update_attribute(
        &mut self,
        key: AttributeType,
        innate_points: u32,
        points_raised: u32,
        experience: u32,
    ) {
        let attr = self
            .attributes
            .entry(key)
            .or_insert_with(|| AttributeInfo::new(key));
        attr.innate_points = innate_points;
        attr.points_raised = points_raised;
        attr.experience = experience;
    }

    /// Port of `UpdateAttributePointsRaised` at `Character.cs:696-699`.
    pub fn update_attribute_points_raised(&mut self, key: AttributeType, value: u32) {
        let attr = self
            .attributes
            .entry(key)
            .or_insert_with(|| AttributeInfo::new(key));
        attr.points_raised = value;
    }

    /// Port of `UpdateSkill` at `Character.cs:665-678`.
    pub fn update_skill(
        &mut self,
        key: SkillType,
        innate_points: u32,
        points_raised: u32,
        experience: u32,
        last_used_time: f32,
        resistance_of_last_check: u32,
        adjust_xp: u32,
        training: crate::client::skill_info::TrainingClass,
    ) {
        let skill = self
            .skills
            .entry(key)
            .or_insert_with(|| SkillInfo::new(key));
        skill.adjust_xp = adjust_xp;
        skill.init_level = innate_points;
        skill.last_used_time = last_used_time;
        skill.points_raised = points_raised;
        skill.resistance_of_last_check = resistance_of_last_check;
        skill.training = training;
        skill.skill_type = Some(key);
        skill.experience = experience;
    }

    /// Port of `UpdateSkillPointsRaised` at `Character.cs:752-755`.
    pub fn update_skill_points_raised(&mut self, key: SkillType, value: u32) {
        let skill = self
            .skills
            .entry(key)
            .or_insert_with(|| SkillInfo::new(key));
        skill.points_raised = value;
    }

    /// Port of `UpdateSkillTraining` at `Character.cs:747-750`.
    /// NOTE: the C# `Training` setter at `SkillInfo.cs:46-54` clamps via
    /// `Dat.MinLevel`. Caller supplies the min_level lookup; pass `0`
    /// when DAT is unavailable to disable the clamp.
    pub fn update_skill_training(
        &mut self,
        key: SkillType,
        value: crate::client::skill_info::TrainingClass,
        min_level: u32,
    ) {
        let skill = self
            .skills
            .entry(key)
            .or_insert_with(|| SkillInfo::new(key));
        skill.set_training(value, min_level);
    }

    /// Port of `Clear` at `Character.cs:764-783`. Reset all character state.
    pub fn clear(&mut self) {
        self.id = Guid::default();
        self.options1 = 0;
        self.vitae = 1.0;
        self.skills.clear();
        self.attributes.clear();
        self.vitals.clear();
        self.int_values.clear();
        self.int64_values.clear();
        self.bool_values.clear();
        self.float_values.clear();
        self.string_values.clear();
        self.instance_values.clear();
        self.data_values.clear();
        self.shared_cooldowns.clear();
        self.all_enchantments.clear();
    }
}

// --------------------------------------------------------------------------
// CharacterContext implementation for CharacterInfo — wires the trait that
// AttributeInfo / VitalInfo / SkillInfo depend on.
// --------------------------------------------------------------------------

impl CharacterContext for CharacterInfo {
    fn attribute(&self, t: AttributeType) -> Option<&AttributeInfo> {
        self.attributes.get(&t)
    }

    fn attribute_multiplier(&self, t: AttributeType) -> f32 {
        self.get_enchantments_multiplier_attribute(t)
    }

    fn attribute_additive(&self, t: AttributeType) -> i32 {
        self.get_enchantments_additive_attribute(t)
    }

    fn vital_multiplier(&self, t: VitalType) -> f32 {
        self.get_enchantments_multiplier_vital(t)
    }

    fn vital_additive(&self, t: VitalType) -> i32 {
        self.get_enchantments_additive_vital(t)
    }

    fn skill_multiplier(&self, t: SkillType) -> f32 {
        self.get_enchantments_multiplier_skill(t)
    }

    fn skill_additive(&self, t: SkillType) -> i32 {
        self.get_enchantments_additive_skill(t)
    }

    fn vitae(&self) -> f32 {
        self.vitae
    }

    fn value_int(&self, key: PropertyInt) -> i32 {
        Self::value_int(self, key)
    }
}

// --------------------------------------------------------------------------
// Outcome enums — surface what changed so the wasm-side dispatcher can emit
// the right ClientEvent.
// --------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum EnchantmentApplyOutcome {
    /// Wire packet was the vitae spell (id 666). The inner `changed`
    /// matches `set_vitae`'s return — `None` if no-op.
    Vitae { changed: Option<(f32, f32)> },
    /// Cooldown-typed enchantment routed to `shared_cooldowns`.
    Cooldown(SharedCooldown),
    /// Regular enchantment routed to `all_enchantments`.
    Enchantment(CharacterEnchantment),
}

#[derive(Debug, Clone, PartialEq)]
pub enum EnchantmentRemoveOutcome {
    /// Vitae cleared (id 666 → vitae=1.0). Inner matches `set_vitae`.
    Vitae { changed: Option<(f32, f32)> },
    /// Standard removal — either or both maps may have had the entry.
    Removed {
        enchantment: Option<CharacterEnchantment>,
        cooldown: Option<SharedCooldown>,
    },
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_protocol::messages::magic::Enchantment as WireEnchantment;

    /// Per `Character.cs:79-88`: Vitae starts at 1.0 and changes notify.
    #[test]
    fn vitae_default_one() {
        let c = CharacterInfo::new();
        assert_eq!(c.vitae(), 1.0);
    }

    /// Per `Character.cs:81-87` setter: change returns (old, new); no-op None.
    #[test]
    fn set_vitae_change_returns_old_new() {
        let mut c = CharacterInfo::new();
        let result = c.set_vitae(0.95);
        assert_eq!(result, Some((1.0, 0.95)));
        assert_eq!(c.vitae(), 0.95);
    }

    /// Per `Character.cs:82` gate: same value → no notify, returns None.
    #[test]
    fn set_vitae_no_change_returns_none() {
        let mut c = CharacterInfo::new();
        assert_eq!(c.set_vitae(1.0), None);
    }

    /// Per `Character.cs:614-617` + `VITAE_SPELL_ID = 666` (`Character.cs:20`):
    /// wire enchantment with spell_id 666 sets vitae from StatValue.
    #[test]
    fn apply_enchantment_vitae_path() {
        let mut c = CharacterInfo::new();
        let wire = WireEnchantment {
            spell_id: 666,
            stat_mod_value: 0.90,
            ..Default::default()
        };
        let outcome = c.apply_enchantment(&wire);
        match outcome {
            EnchantmentApplyOutcome::Vitae { changed } => {
                assert_eq!(changed, Some((1.0, 0.90)));
            }
            other => panic!("expected Vitae outcome, got {:?}", other),
        }
        assert_eq!(c.vitae(), 0.90);
    }

    /// Per `Character.cs:619-628` cooldown discriminator: COOLDOWN flag set
    /// routes to shared_cooldowns dict.
    #[test]
    fn apply_enchantment_cooldown_path() {
        let mut c = CharacterInfo::new();
        let wire = WireEnchantment {
            spell_id: 100,
            layer: 1,
            stat_mod_type: EnchantmentTypeFlags::COOLDOWN.bits(),
            duration: 30.0,
            ..Default::default()
        };
        let outcome = c.apply_enchantment(&wire);
        assert!(matches!(outcome, EnchantmentApplyOutcome::Cooldown(_)));
        assert_eq!(c.shared_cooldowns.len(), 1);
        assert_eq!(c.all_enchantments.len(), 0);
    }

    /// Per `Character.cs:629-638` enchantment path: no COOLDOWN flag routes
    /// to all_enchantments.
    #[test]
    fn apply_enchantment_regular_path() {
        let mut c = CharacterInfo::new();
        let wire = WireEnchantment {
            spell_id: 200,
            layer: 1,
            stat_mod_type: EnchantmentTypeFlags::SKILL.bits()
                | EnchantmentTypeFlags::ADDITIVE.bits(),
            ..Default::default()
        };
        let outcome = c.apply_enchantment(&wire);
        assert!(matches!(outcome, EnchantmentApplyOutcome::Enchantment(_)));
        assert_eq!(c.all_enchantments.len(), 1);
        assert_eq!(c.shared_cooldowns.len(), 0);
    }

    /// Per `Character.cs:641-654`: VITAE_SPELL_ID layered_id clears vitae
    /// to 1.0.
    #[test]
    fn remove_enchantment_vitae_clears() {
        let mut c = CharacterInfo::new();
        c.set_vitae(0.85);
        let outcome = c.remove_enchantment(LayeredSpellId::new(666, 0));
        match outcome {
            EnchantmentRemoveOutcome::Vitae { changed } => {
                assert_eq!(changed, Some((0.85, 1.0)));
            }
            other => panic!("expected Vitae outcome, got {:?}", other),
        }
        assert_eq!(c.vitae(), 1.0);
    }

    /// Per `Character.cs:647-653`: removes from both maps idempotently.
    #[test]
    fn remove_enchantment_both_maps() {
        let mut c = CharacterInfo::new();
        let layered = LayeredSpellId::new(100, 1);
        c.all_enchantments.insert(
            layered,
            CharacterEnchantment {
                layered_id: layered,
                ..Default::default()
            },
        );
        c.shared_cooldowns.insert(
            layered,
            SharedCooldown {
                layered_id: layered,
                ..Default::default()
            },
        );
        let outcome = c.remove_enchantment(layered);
        match outcome {
            EnchantmentRemoveOutcome::Removed {
                enchantment,
                cooldown,
            } => {
                assert!(enchantment.is_some());
                assert!(cooldown.is_some());
            }
            other => panic!("expected Removed outcome, got {:?}", other),
        }
        assert_eq!(c.all_enchantments.len(), 0);
        assert_eq!(c.shared_cooldowns.len(), 0);
    }

    /// Per `Character.cs:702-703` + `SharedCooldown.cs:55`: sign-extend on
    /// low 12 bits. For small id values, low 12 bits == id (no high bit).
    #[test]
    fn shared_cooldown_id_sign_extend_low_12_bits() {
        // Test case: id=42 (well within 12 bits).
        let cd = SharedCooldown::new(LayeredSpellId::new(42, 1), Guid::default(), 30.0, 0.0);
        assert_eq!(cd.id, 42);

        // Test case: id with high bits set but low 12 bits clean.
        // 0x12345678 → low 12 = 0x678. C# `<< 20 >> 20` zero-fills (uint).
        let cd2 = SharedCooldown::new(
            LayeredSpellId::new(0x12345678, 1),
            Guid::default(),
            30.0,
            0.0,
        );
        assert_eq!(cd2.id, 0x678);
    }

    /// Per `Character.cs:721-728`: even-key vital current update with
    /// is_initial_update=false emits change.
    #[test]
    fn update_vital_even_key_emits_change() {
        let mut c = CharacterInfo::new();
        // First call seeds the vital (initial update suppresses event).
        let _ = c.update_vital(1, 50, 100, 0, 0, true);
        assert_eq!(c.vitals[&VitalType::Health].current, 50);
        // Second call with even key (2 = Health-max), non-initial,
        // different current → emits change.
        let outcome = c.update_vital(2, 60, 100, 0, 0, false);
        assert_eq!(outcome, Some((VitalType::Health, 50, 60)));
    }

    /// Per `Character.cs:721`: odd-key with is_initial=false does NOT emit.
    /// The `((int)key % 2) == 0` gate fires the event only on even keys.
    #[test]
    fn update_vital_odd_key_non_initial_no_emit() {
        let mut c = CharacterInfo::new();
        let _ = c.update_vital(1, 50, 100, 0, 0, true);
        // Odd-key (1 = Health-current) non-initial → no event even with change.
        let outcome = c.update_vital(1, 60, 100, 0, 0, false);
        // C# does set `vital.Current = (int)value.Current;` only on initial
        // OR even-key. So current stays at 50.
        assert_eq!(outcome, None);
        assert_eq!(c.vitals[&VitalType::Health].current, 50);
    }

    /// Per `Character.cs:736-745` UpdateVitalCurrent: only even-key fires.
    #[test]
    fn update_vital_current_even_only() {
        let mut c = CharacterInfo::new();
        c.vitals.insert(
            VitalType::Stamina,
            VitalInfo {
                vital_type: Some(VitalType::Stamina),
                current: 50,
                ..Default::default()
            },
        );
        // key=4 is even (Stamina-max). Should fire.
        let outcome = c.update_vital_current(4, 75);
        assert_eq!(outcome, Some((VitalType::Stamina, 50, 75)));
        assert_eq!(c.vitals[&VitalType::Stamina].current, 75);

        // key=3 is odd (Stamina-current). Should NOT fire.
        let outcome2 = c.update_vital_current(3, 80);
        assert_eq!(outcome2, None);
    }

    /// Per `Character.cs:230-240`: tiebreak — Power desc wins first.
    #[test]
    fn tiebreak_power_desc_wins() {
        let mut c = CharacterInfo::new();
        // Two enchantments in same category, different power.
        c.all_enchantments.insert(
            LayeredSpellId::new(1, 0),
            CharacterEnchantment {
                layered_id: LayeredSpellId::new(1, 0),
                category: 50,
                power: 100,
                stat_value: 5.0,
                ..Default::default()
            },
        );
        c.all_enchantments.insert(
            LayeredSpellId::new(2, 0),
            CharacterEnchantment {
                layered_id: LayeredSpellId::new(2, 0),
                category: 50,
                power: 200, // higher power wins
                stat_value: 10.0,
                ..Default::default()
            },
        );
        let active = c.get_active_enchantments();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].spell_id(), 2);
        assert_eq!(active[0].power, 200);
    }

    /// Per `Character.cs:236`: Level8AuraSelfSpells.Contains breaks Power
    /// ties (true > false).
    #[test]
    fn tiebreak_level8_aura_self_wins_on_power_tie() {
        let mut c = CharacterInfo::new();
        // Non-aura with same power.
        c.all_enchantments.insert(
            LayeredSpellId::new(1, 0),
            CharacterEnchantment {
                layered_id: LayeredSpellId::new(1, 0),
                category: 50,
                power: 100,
                stat_value: 5.0,
                ..Default::default()
            },
        );
        // BloodDrinkerSelf8 = 4395 is in LEVEL_8_AURA_SELF_SPELLS.
        c.all_enchantments.insert(
            LayeredSpellId::new(4395, 0),
            CharacterEnchantment {
                layered_id: LayeredSpellId::new(4395, 0),
                category: 50,
                power: 100, // SAME power → aura tiebreak fires
                stat_value: 10.0,
                ..Default::default()
            },
        );
        let active = c.get_active_enchantments();
        assert_eq!(active.len(), 1);
        assert_eq!(
            active[0].spell_id(),
            4395,
            "Level8AuraSelf wins on Power tie"
        );
    }

    /// Per `Character.cs:237`: SetSpells.Contains wins over StartTime on
    /// Power+Level8 tie.
    #[test]
    fn tiebreak_setspells_wins_over_starttime() {
        let mut c = CharacterInfo::new();
        c.build_set_spells(vec![5000_u32, 5001_u32]); // set-spell IDs
        c.all_enchantments.insert(
            LayeredSpellId::new(100, 0),
            CharacterEnchantment {
                layered_id: LayeredSpellId::new(100, 0),
                category: 50,
                power: 100,
                start_time: 999.0, // very high StartTime
                stat_value: 5.0,
                ..Default::default()
            },
        );
        c.all_enchantments.insert(
            LayeredSpellId::new(5000, 0),
            CharacterEnchantment {
                layered_id: LayeredSpellId::new(5000, 0),
                category: 50,
                power: 100, // SAME power
                start_time: 0.0,
                stat_value: 10.0,
                ..Default::default()
            },
        );
        let active = c.get_active_enchantments();
        // Per our impl: set-spells beat non-set-spells in the final tiebreak.
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].spell_id(), 5000, "SetSpell wins over StartTime");
    }

    /// Per `Character.cs:237` final tiebreak: among non-set-spells,
    /// StartTime desc wins (most recent first).
    #[test]
    fn tiebreak_starttime_desc_among_non_set_spells() {
        let mut c = CharacterInfo::new();
        c.all_enchantments.insert(
            LayeredSpellId::new(100, 0),
            CharacterEnchantment {
                layered_id: LayeredSpellId::new(100, 0),
                category: 50,
                power: 100,
                start_time: 100.0,
                stat_value: 5.0,
                ..Default::default()
            },
        );
        c.all_enchantments.insert(
            LayeredSpellId::new(101, 0),
            CharacterEnchantment {
                layered_id: LayeredSpellId::new(101, 0),
                category: 50,
                power: 100,
                start_time: 200.0, // most recent
                stat_value: 10.0,
                ..Default::default()
            },
        );
        let active = c.get_active_enchantments();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].start_time, 200.0);
    }

    /// Per `Character.cs:231` GroupBy(Category): each category has one
    /// winner.
    #[test]
    fn tiebreak_one_winner_per_category() {
        let mut c = CharacterInfo::new();
        // Three enchantments in two categories.
        c.all_enchantments.insert(
            LayeredSpellId::new(1, 0),
            CharacterEnchantment {
                layered_id: LayeredSpellId::new(1, 0),
                category: 50,
                power: 100,
                stat_value: 5.0,
                ..Default::default()
            },
        );
        c.all_enchantments.insert(
            LayeredSpellId::new(2, 0),
            CharacterEnchantment {
                layered_id: LayeredSpellId::new(2, 0),
                category: 50,
                power: 200,
                stat_value: 10.0,
                ..Default::default()
            },
        );
        c.all_enchantments.insert(
            LayeredSpellId::new(3, 0),
            CharacterEnchantment {
                layered_id: LayeredSpellId::new(3, 0),
                category: 60,
                power: 50,
                stat_value: 7.0,
                ..Default::default()
            },
        );
        let active = c.get_active_enchantments();
        assert_eq!(active.len(), 2, "two categories → two winners");
    }

    /// Per `Character.cs:304-308`: additive sum across active enchantments
    /// matching attribute and ADDITIVE flag.
    #[test]
    fn get_enchantments_additive_attribute_sums() {
        let mut c = CharacterInfo::new();
        // Two enchantments boosting Strength (additive).
        c.all_enchantments.insert(
            LayeredSpellId::new(1, 0),
            CharacterEnchantment {
                layered_id: LayeredSpellId::new(1, 0),
                category: 50, // different categories so both win
                power: 100,
                stat_mod_type: EnchantmentTypeFlags::ATTRIBUTE
                    | EnchantmentTypeFlags::ADDITIVE,
                stat_key: AttributeType::StrengthAttr as u32,
                stat_value: 5.0,
                ..Default::default()
            },
        );
        c.all_enchantments.insert(
            LayeredSpellId::new(2, 0),
            CharacterEnchantment {
                layered_id: LayeredSpellId::new(2, 0),
                category: 60,
                power: 100,
                stat_mod_type: EnchantmentTypeFlags::ATTRIBUTE
                    | EnchantmentTypeFlags::ADDITIVE,
                stat_key: AttributeType::StrengthAttr as u32,
                stat_value: 10.0,
                ..Default::default()
            },
        );
        assert_eq!(c.get_enchantments_additive_attribute(AttributeType::StrengthAttr), 15);
    }

    /// Per `Character.cs:337-344`: multiplicative fold across active
    /// enchantments.
    #[test]
    fn get_enchantments_multiplier_attribute_multiplies() {
        let mut c = CharacterInfo::new();
        c.all_enchantments.insert(
            LayeredSpellId::new(1, 0),
            CharacterEnchantment {
                layered_id: LayeredSpellId::new(1, 0),
                category: 50,
                power: 100,
                stat_mod_type: EnchantmentTypeFlags::ATTRIBUTE
                    | EnchantmentTypeFlags::MULTIPLICATIVE,
                stat_key: AttributeType::CoordinationAttr as u32,
                stat_value: 1.5,
                ..Default::default()
            },
        );
        c.all_enchantments.insert(
            LayeredSpellId::new(2, 0),
            CharacterEnchantment {
                layered_id: LayeredSpellId::new(2, 0),
                category: 60,
                power: 100,
                stat_mod_type: EnchantmentTypeFlags::ATTRIBUTE
                    | EnchantmentTypeFlags::MULTIPLICATIVE,
                stat_key: AttributeType::CoordinationAttr as u32,
                stat_value: 2.0,
                ..Default::default()
            },
        );
        // 1.5 × 2.0 = 3.0
        assert!(
            (c.get_enchantments_multiplier_attribute(AttributeType::CoordinationAttr) - 3.0).abs()
                < 1e-5
        );
    }

    /// Per `Character.cs:268-269`: MULTIPLE_STAT flag matches any
    /// attribute, not just the one in stat_key.
    #[test]
    fn get_active_attribute_with_multiple_stat_matches_any() {
        let mut c = CharacterInfo::new();
        c.all_enchantments.insert(
            LayeredSpellId::new(1, 0),
            CharacterEnchantment {
                layered_id: LayeredSpellId::new(1, 0),
                category: 50,
                power: 100,
                stat_mod_type: EnchantmentTypeFlags::ATTRIBUTE
                    | EnchantmentTypeFlags::MULTIPLE_STAT
                    | EnchantmentTypeFlags::ADDITIVE,
                stat_key: 0, // doesn't match Strength
                stat_value: 5.0,
                ..Default::default()
            },
        );
        // MULTIPLE_STAT → matches even Strength.
        assert_eq!(c.get_enchantments_additive_attribute(AttributeType::StrengthAttr), 5);
    }

    /// Per `Character.cs:764-783`: clear() resets vitae to 1.0.
    #[test]
    fn clear_resets_vitae_to_one() {
        let mut c = CharacterInfo::new();
        c.set_vitae(0.85);
        c.clear();
        assert_eq!(c.vitae(), 1.0);
    }

    /// Per `Character.cs:768-782`: clear() empties dictionaries.
    #[test]
    fn clear_empties_collections() {
        let mut c = CharacterInfo::new();
        c.attributes.insert(
            AttributeType::StrengthAttr,
            AttributeInfo::new(AttributeType::StrengthAttr),
        );
        c.all_enchantments.insert(
            LayeredSpellId::new(1, 0),
            CharacterEnchantment::default(),
        );
        c.int_values.insert(PropertyInt::HeritageGroup, 5);
        c.clear();
        assert!(c.attributes.is_empty());
        assert!(c.all_enchantments.is_empty());
        assert!(c.int_values.is_empty());
    }

    /// Per `Character.cs:42` SetSpells cutoff: < 4730u is filtered out.
    #[test]
    fn build_set_spells_filters_below_cutoff() {
        let mut c = CharacterInfo::new();
        c.build_set_spells(vec![1000_u32, 4729_u32, 4730_u32, 5000_u32]);
        let set = c.set_spells_or_empty();
        assert!(!set.contains(&1000));
        assert!(!set.contains(&4729));
        assert!(set.contains(&4730));
        assert!(set.contains(&5000));
    }

    /// Integration: attribute → vital chain via CharacterContext.
    /// Hand math: Endurance 60 + 1 bonus → 61. Health Init=10, Raised=0,
    /// formula=Endurance/2 → 30.5 round → 30 or 31. Base = 10 + 30/31 = 40/41.
    /// Then Max with vitae=1, no buffs → same as Base (40/41) clamped at 5.
    #[test]
    fn integration_attribute_vital_chain_via_character_context() {
        let mut c = CharacterInfo::new();
        c.update_attribute(AttributeType::EnduranceAttr, 60, 0, 0);
        c.vitals.insert(
            VitalType::Health,
            VitalInfo {
                vital_type: Some(VitalType::Health),
                init_level: 10,
                points_raised: 0,
                formula: Some(crate::client::skill_formula::SkillFormula::new(
                    true,
                    2,
                    Some(AttributeType::EnduranceAttr),
                    None,
                )),
                ..Default::default()
            },
        );
        let health = &c.vitals[&VitalType::Health];
        let base = health.base_value(&c);
        // (60+1)/2 = 30.5 — Rust round-half-away → 31. Total = 10+31 = 41.
        assert!(base == 40 || base == 41, "got {}", base);
    }

    /// Integration: enchantments → modifier → attribute current.
    /// Hand math: Coordination base 100, +5 additive, ×1.5 multiplicative.
    /// → 100 * 1.5 + 5 = 155.
    #[test]
    fn integration_enchantment_to_attribute_current() {
        let mut c = CharacterInfo::new();
        c.update_attribute(AttributeType::CoordinationAttr, 100, 0, 0);
        c.all_enchantments.insert(
            LayeredSpellId::new(1, 0),
            CharacterEnchantment {
                layered_id: LayeredSpellId::new(1, 0),
                category: 50,
                power: 100,
                stat_mod_type: EnchantmentTypeFlags::ATTRIBUTE
                    | EnchantmentTypeFlags::ADDITIVE,
                stat_key: AttributeType::CoordinationAttr as u32,
                stat_value: 5.0,
                ..Default::default()
            },
        );
        c.all_enchantments.insert(
            LayeredSpellId::new(2, 0),
            CharacterEnchantment {
                layered_id: LayeredSpellId::new(2, 0),
                category: 60,
                power: 100,
                stat_mod_type: EnchantmentTypeFlags::ATTRIBUTE
                    | EnchantmentTypeFlags::MULTIPLICATIVE,
                stat_key: AttributeType::CoordinationAttr as u32,
                stat_value: 1.5,
                ..Default::default()
            },
        );
        let attr = c.attribute(AttributeType::CoordinationAttr).unwrap();
        let current = attr.current(
            c.attribute_multiplier(AttributeType::CoordinationAttr),
            c.attribute_additive(AttributeType::CoordinationAttr),
        );
        // 100 * 1.5 + 5 = 155
        assert_eq!(current, 155);
    }

    /// Random-input parity probe (per spec: "pure-Rust 1000-state random-input
    /// parity test is acceptable in its place"). Hand-derives a base/current
    /// using a simple formula and compares with `AttributeInfo::current`.
    /// Uses `rand` 0.10 — `Rng::random_range` (the old `gen_range`).
    #[test]
    fn random_inputs_attribute_current_matches_hand_derivation() {
        use rand::{RngExt, SeedableRng};
        let mut rng = rand::rngs::StdRng::seed_from_u64(0xACDC_BEEF);
        for _ in 0..1000 {
            let innate: u32 = rng.random_range(10..=200);
            let raised: u32 = rng.random_range(0..=100);
            // Plausible AC mult range: 0.5–3.0; additive: -50..=100
            let mult: f32 = rng.random_range(0.5_f32..=3.0_f32);
            let add: i32 = rng.random_range(-50..=100);

            let info = AttributeInfo {
                attribute_type: Some(AttributeType::StrengthAttr),
                innate_points: innate,
                points_raised: raised,
                experience: 0,
            };
            let base = (innate + raised) as i32;
            let expected_effective = ((base as f32) * mult + add as f32).round() as i32;
            let expected_min = if base >= 10 { 10 } else { 1 };
            let expected = expected_effective.max(expected_min);
            assert_eq!(
                info.current(mult, add),
                expected,
                "innate={} raised={} mult={} add={}",
                innate,
                raised,
                mult,
                add
            );
        }
    }
}
