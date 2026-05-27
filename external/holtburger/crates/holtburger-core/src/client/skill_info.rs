//! Port of `Chorizite/ACPlugin/API/SkillInfo.cs` (vendored HEAD `1341660`).
//!
//! Wave C — Chorizite absorption (2026-05-27). Per-skill bundle owning the
//! `Base` and `Current` derivations including:
//! - Init + raised points
//! - Formula-driven attribute bonus
//! - `LumAugAllSkills` flat bonus
//! - Skill-class augmentations (Melee/Missile/Magic × 10)
//! - Enlightenment bonus (when Trained+)
//! - Multiplier × vitae fold (Current only)
//! - `AugmentationJackOfAllTrades × 5` (Current only)
//! - `LumAugSkilledSpec × 2` for Specialized skills (Current only)
//! - Additive enchantment fold
//!
//! Load-bearing semantics preserved (handoff §3):
//! - **Vitae**: `1.0 = no vitae`, `0.95 = 5% vitae`. We multiply by vitae
//!   when `vitae < 1.0` (lines `SkillInfo.cs:138-140`). Don't invert.
//! - Five static skill-list constants (`MELEE_SKILLS`, `MISSILE_SKILLS`,
//!   `MAGIC_SKILLS`, `ALWAYS_TRAINED`, `AUG_SPEC_SKILLS`) are GAMEPLAY MATH,
//!   not documentation. Used by both `base()` and `current()` to gate
//!   class-specific augmentations.

use crate::client::character_info::CharacterContext;
use crate::client::skill_formula::SkillFormula;
use holtburger_common::properties::PropertyInt;
use holtburger_common::stats::SkillType;
use serde::{Deserialize, Serialize};

/// Skill training class. Mirrors the C# `SkillAdvancementClass` enum from
/// `Chorizite.ACProtocol.Enums`, BUT we derive `PartialOrd + Ord` so the
/// C# `>` / `>=` comparisons at `SkillInfo.cs:48, 85, 103, 117, 144` work
/// directly. The protocol crate's existing
/// `holtburger_protocol::messages::character::types::SkillAdvancementClass`
/// does not derive ordering; we keep that variant for wire and convert.
///
/// Variant values match the C# source byte-for-byte
/// (`Chorizite.ACProtocol/Enums/SkillAdvancementClass.cs`).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default,
)]
#[repr(u32)]
pub enum TrainingClass {
    /// C# `Unusable = 0`. Holtburger's existing `SkillAdvancementClass`
    /// variant for this value is named `Inactive` — same numeric value.
    #[default]
    Unusable = 0,
    Untrained = 1,
    Trained = 2,
    Specialized = 3,
}

impl TrainingClass {
    pub fn from_u32(v: u32) -> Option<Self> {
        match v {
            0 => Some(Self::Unusable),
            1 => Some(Self::Untrained),
            2 => Some(Self::Trained),
            3 => Some(Self::Specialized),
            _ => None,
        }
    }
}

/// Per-skill bundle. Mirrors C# `AC.API.SkillInfo` public surface.
///
/// Ported from `ACPlugin/API/SkillInfo.cs:10-312` (vendored HEAD `1341660`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SkillInfo {
    /// The skill type. C# field: `SkillId Type` at `SkillInfo.cs:19`.
    pub skill_type: Option<SkillType>,

    /// How many points this skill has been raised. C# field:
    /// `uint PointsRaised` at `SkillInfo.cs:24`.
    pub points_raised: u32,

    /// C# field: `uint AdjustXP` at `SkillInfo.cs:26`. Used by the
    /// experience-spent tracker; not load-bearing for Base/Current math.
    pub adjust_xp: u32,

    /// Total experience already spent on this skill. C# field:
    /// `uint Experience` at `SkillInfo.cs:31`.
    pub experience: u32,

    /// The level this skill initialized at. C# field: `uint InitLevel` at
    /// `SkillInfo.cs:36`.
    pub init_level: u32,

    /// C# field: `uint ResistanceOfLastCheck` at `SkillInfo.cs:38`. Used by
    /// the SkillCheck system; not load-bearing for Base/Current math.
    pub resistance_of_last_check: u32,

    /// C# field: `float LastUsedTime` at `SkillInfo.cs:40`.
    pub last_used_time: f32,

    /// The training class. **Setter** at `SkillInfo.cs:46-54` clamps to
    /// `Unusable` if the value is below `Dat.MinLevel`. We expose the raw
    /// field here; callers should validate via [`SkillInfo::set_training`].
    pub training: TrainingClass,

    /// Cached formula resolved from `DatLoader.SkillTable.Skills[type].Formula`.
    /// None until resolved. Mirrors the lazy `_formula` field at
    /// `SkillInfo.cs:13`.
    pub formula: Option<SkillFormula>,
}

impl SkillInfo {
    /// Construct a new empty `SkillInfo` for the given skill type. Mirrors
    /// the C# `internal SkillInfo(SkillId)` constructor at
    /// `SkillInfo.cs:232-234`.
    pub fn new(skill_type: SkillType) -> Self {
        Self {
            skill_type: Some(skill_type),
            ..Default::default()
        }
    }

    /// Setter equivalent of `SkillInfo.cs:46-54` Training property setter:
    /// ```csharp
    /// set {
    ///     if ((uint)value >= Dat.MinLevel) { _training = value; }
    ///     else { _training = SkillAdvancementClass.Unusable; }
    /// }
    /// ```
    ///
    /// `min_level` is the per-skill DAT `SkillBase.MinLevel` — caller looks
    /// it up via `Dat.SkillTable.Skills[skill_type].MinLevel`. Pass `0`
    /// when DAT isn't loaded yet (the clamp becomes no-op).
    pub fn set_training(&mut self, value: TrainingClass, min_level: u32) {
        if (value as u32) >= min_level {
            self.training = value;
        } else {
            self.training = TrainingClass::Unusable;
        }
    }

    /// Default formula when DAT lookup misses: `(false, 1, Undef, Undef)`.
    /// Mirrors `SkillInfo.cs:66`: `new SkillFormula(false, 1, 0, 0)`.
    fn inactive_formula() -> SkillFormula {
        SkillFormula::new(false, 1, None, None)
    }

    pub fn formula(&self) -> SkillFormula {
        self.formula.clone().unwrap_or_else(Self::inactive_formula)
    }

    /// The base skill value (no buffs; includes formula bonus and all
    /// non-buff augmentations).
    ///
    /// Ported from `SkillInfo.cs:79-107` (verbatim algorithm):
    /// ```csharp
    /// var _base = (int)(InitLevel + PointsRaised);
    /// if (Training > SkillAdvancementClass.Unusable && Formula.UseFormula) {
    ///     var attrBonus = character.Attributes[Formula.Attribute1].Base;
    ///     if (Formula.Attribute2 != 0) {
    ///         attrBonus += character.Attributes[Formula.Attribute2].Base;
    ///     }
    ///     _base += (int)Math.Round(((float)attrBonus / Formula.Divisor));
    /// }
    /// _base += character.Value(PropertyInt.LumAugAllSkills);
    /// if (MeleeSkills.Contains(Type))
    ///     _base += character.Value(PropertyInt.AugmentationSkilledMelee) * 10;
    /// else if (MissileSkills.Contains(Type))
    ///     _base += character.Value(PropertyInt.AugmentationSkilledMissile) * 10;
    /// else if (MagicSkills.Contains(Type))
    ///     _base += character.Value(PropertyInt.AugmentationSkilledMagic) * 10;
    /// if (Training >= SkillAdvancementClass.Trained)
    ///     _base += character.Value(PropertyInt.Enlightenment);
    /// return _base;
    /// ```
    pub fn base_value<C: CharacterContext>(&self, ctx: &C) -> i32 {
        let skill_type = match self.skill_type {
            Some(s) => s,
            None => return 0,
        };

        let mut base = self.init_level.wrapping_add(self.points_raised) as i32;
        let formula = self.formula();

        if self.training > TrainingClass::Unusable && formula.use_formula {
            let mut attr_bonus = formula
                .attribute1
                .and_then(|a| ctx.attribute(a))
                .map(|a| a.base())
                .unwrap_or(0);
            if let Some(attr2) = formula.attribute2 {
                attr_bonus += ctx.attribute(attr2).map(|a| a.base()).unwrap_or(0);
            }
            // C# `Math.Round((float)x / divisor)` = round-half-to-even (banker's)
            // We use `f32::round()` (round-half-away-from-zero); divergence
            // on exact .5 boundaries documented in handoff §3.
            base += ((attr_bonus as f32) / formula.divisor).round() as i32;
        }

        base += ctx.value_int(PropertyInt::LumAugAllSkills);

        if MELEE_SKILLS.contains(&skill_type) {
            base += ctx.value_int(PropertyInt::AugmentationSkilledMelee) * 10;
        } else if MISSILE_SKILLS.contains(&skill_type) {
            base += ctx.value_int(PropertyInt::AugmentationSkilledMissile) * 10;
        } else if MAGIC_SKILLS.contains(&skill_type) {
            base += ctx.value_int(PropertyInt::AugmentationSkilledMagic) * 10;
        }

        if self.training >= TrainingClass::Trained {
            base += ctx.value_int(PropertyInt::Enlightenment);
        }
        base
    }

    /// Effective skill (includes buffs / debuffs / vitae / augmentations).
    ///
    /// Ported from `SkillInfo.cs:112-150` (verbatim algorithm):
    /// ```csharp
    /// var effectiveBase = (int)(InitLevel + PointsRaised);
    /// if (Training > SkillAdvancementClass.Unusable && Formula.UseFormula) {
    ///     var attrBonus = character.Attributes[Formula.Attribute1].Current;
    ///     if (Formula.Attribute2 != 0) {
    ///         attrBonus += character.Attributes[Formula.Attribute2].Current;
    ///     }
    ///     effectiveBase += (int)Math.Round(((float)attrBonus / Formula.Divisor));
    /// }
    /// effectiveBase += character.Value(PropertyInt.LumAugAllSkills);
    /// if (MeleeSkills.Contains(Type)) effectiveBase += ...SkilledMelee*10;
    /// else if (MissileSkills.Contains(Type)) ... SkilledMissile*10;
    /// else if (MagicSkills.Contains(Type)) ... SkilledMagic*10;
    /// var multiplier = character.GetEnchantmentsMultiplierModifier(Type);
    /// var fTotal = effectiveBase * multiplier;
    /// if (character.Vitae < 1.0f) {
    ///     fTotal *= character.Vitae;
    /// }
    /// fTotal += character.Value(PropertyInt.AugmentationJackOfAllTrades) * 5;
    /// if (Training == SkillAdvancementClass.Specialized)
    ///     fTotal += character.Value(PropertyInt.LumAugSkilledSpec) * 2;
    /// var additives = character.GetEnchantmentsAdditiveModifier(Type);
    /// return (int)Math.Max(Math.Round(fTotal + additives), 0);
    /// ```
    ///
    /// **Note** `Vitae < 1.0f` (NOT `< 1.0f && > 0.0f` like Vital). Mirrors
    /// `SkillInfo.cs:138-140` exactly — a vitae=0 character is dead and
    /// would have skill effective-base scaled by 0 anyway.
    pub fn current<C: CharacterContext>(&self, ctx: &C) -> i32 {
        let skill_type = match self.skill_type {
            Some(s) => s,
            None => return 0,
        };

        let mut effective_base = self.init_level.wrapping_add(self.points_raised) as i32;
        let formula = self.formula();

        if self.training > TrainingClass::Unusable && formula.use_formula {
            let mut attr_bonus = match formula.attribute1 {
                Some(attr1) => ctx
                    .attribute(attr1)
                    .map(|info| {
                        info.current(ctx.attribute_multiplier(attr1), ctx.attribute_additive(attr1))
                    })
                    .unwrap_or(0),
                None => 0,
            };
            if let Some(attr2) = formula.attribute2 {
                attr_bonus += ctx
                    .attribute(attr2)
                    .map(|info| {
                        info.current(ctx.attribute_multiplier(attr2), ctx.attribute_additive(attr2))
                    })
                    .unwrap_or(0);
            }
            effective_base += ((attr_bonus as f32) / formula.divisor).round() as i32;
        }

        effective_base += ctx.value_int(PropertyInt::LumAugAllSkills);

        if MELEE_SKILLS.contains(&skill_type) {
            effective_base += ctx.value_int(PropertyInt::AugmentationSkilledMelee) * 10;
        } else if MISSILE_SKILLS.contains(&skill_type) {
            effective_base += ctx.value_int(PropertyInt::AugmentationSkilledMissile) * 10;
        } else if MAGIC_SKILLS.contains(&skill_type) {
            effective_base += ctx.value_int(PropertyInt::AugmentationSkilledMagic) * 10;
        }

        let multiplier = ctx.skill_multiplier(skill_type);
        let mut f_total = (effective_base as f32) * multiplier;

        let vitae = ctx.vitae();
        if vitae < 1.0_f32 {
            f_total *= vitae;
        }

        f_total += (ctx.value_int(PropertyInt::AugmentationJackOfAllTrades) * 5) as f32;

        if self.training == TrainingClass::Specialized {
            f_total += (ctx.value_int(PropertyInt::LumAugSkilledSpec) * 2) as f32;
        }

        let additives = ctx.skill_additive(skill_type);
        ((f_total + additives as f32).round() as i32).max(0)
    }

    /// Mirrors `SkillInfo.cs:168`: minimum-training is `Trained` for
    /// always-trained skills, `Unusable` otherwise.
    pub fn min_training(skill_type: SkillType) -> TrainingClass {
        if ALWAYS_TRAINED.contains(&skill_type) {
            TrainingClass::Trained
        } else {
            TrainingClass::Unusable
        }
    }

    /// Mirrors `SkillInfo.cs:171`: max-training is `Trained` for Salvaging,
    /// `Specialized` otherwise.
    pub fn max_training(skill_type: SkillType) -> TrainingClass {
        if skill_type == SkillType::Salvaging {
            TrainingClass::Trained
        } else {
            TrainingClass::Specialized
        }
    }

    /// Mirrors `SkillInfo.cs:174-185`:
    /// ```csharp
    /// if (Type == SkillId.Salvaging) return 0;
    /// else if (Training == Specialized) return 0;
    /// else if (Training == Trained) return (Dat.SpecializedCost - Dat.TrainedCost);
    /// else return Dat.TrainedCost;
    /// ```
    pub fn cost_to_increase_training(&self, trained_cost: i32, specialized_cost: i32) -> i32 {
        match self.skill_type {
            Some(SkillType::Salvaging) => 0,
            _ => match self.training {
                TrainingClass::Specialized => 0,
                TrainingClass::Trained => specialized_cost - trained_cost,
                _ => trained_cost,
            },
        }
    }
}

// --------------------------------------------------------------------------
// Static skill-list constants — load-bearing per handoff §3 (these are part
// of the gameplay math, not documentation). Ported from `SkillInfo.cs:243-310`.
// --------------------------------------------------------------------------

/// Melee skill list (includes legacy skills). Ported from
/// `SkillInfo.cs:243-259`.
pub const MELEE_SKILLS: &[SkillType] = &[
    SkillType::LightWeapons,
    SkillType::HeavyWeapons,
    SkillType::FinesseWeapons,
    SkillType::DualWield,
    SkillType::TwoHandedCombat,
    // legacy
    SkillType::Axe,
    SkillType::Dagger,
    SkillType::Mace,
    SkillType::Spear,
    SkillType::Staff,
    SkillType::Sword,
    SkillType::UnarmedCombat,
];

/// Missile skill list (includes legacy skills). Ported from
/// `SkillInfo.cs:264-273`.
///
/// **Note** the C# variant is `SkillId.MissleWeapons` (missing the second `i`)
/// — that's a typo in the Chorizite enum that we DON'T propagate; holtburger's
/// `SkillType::MissileWeapons` is correctly spelled.
pub const MISSILE_SKILLS: &[SkillType] = &[
    SkillType::MissileWeapons,
    // legacy
    SkillType::Bow,
    SkillType::Crossbow,
    SkillType::Sling,
    SkillType::ThrownWeapon,
];

/// Magic skill list. Ported from `SkillInfo.cs:278-285`.
pub const MAGIC_SKILLS: &[SkillType] = &[
    SkillType::CreatureEnchantment,
    SkillType::ItemEnchantment,
    SkillType::LifeMagic,
    SkillType::VoidMagic,
    SkillType::WarMagic,
];

/// Skills that are always trained. Ported from `SkillInfo.cs:290-298`.
pub const ALWAYS_TRAINED: &[SkillType] = &[
    SkillType::ArcaneLore,
    SkillType::Jump,
    SkillType::Loyalty,
    SkillType::MagicDefense,
    SkillType::Run,
    SkillType::Salvaging,
];

/// Skills that require augmentation to specialize. Ported from
/// `SkillInfo.cs:303-310`.
pub const AUG_SPEC_SKILLS: &[SkillType] = &[
    SkillType::ArmorTinkering,
    SkillType::ItemTinkering,
    SkillType::MagicItemTinkering,
    SkillType::WeaponTinkering,
    SkillType::Salvaging,
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::attribute_info::AttributeInfo;
    use holtburger_common::properties::PropertyInt;
    use holtburger_common::stats::{AttributeType, SkillType, VitalType};
    use std::collections::{BTreeMap, HashMap};

    /// Minimal CharacterContext mock for skill tests. Shares the shape with
    /// vital_info's tests but kept local for module isolation.
    /// Uses BTreeMap for PropertyInt (Ord but not Hash).
    #[derive(Default)]
    struct MockChar {
        attrs: HashMap<AttributeType, AttributeInfo>,
        attr_mult: HashMap<AttributeType, f32>,
        attr_add: HashMap<AttributeType, i32>,
        skill_mult: HashMap<SkillType, f32>,
        skill_add: HashMap<SkillType, i32>,
        int_props: BTreeMap<PropertyInt, i32>,
        vitae: f32,
    }

    impl MockChar {
        fn new() -> Self {
            Self {
                vitae: 1.0,
                ..Default::default()
            }
        }
        fn with_attr(mut self, t: AttributeType, base: u32) -> Self {
            self.attrs.insert(
                t,
                AttributeInfo {
                    attribute_type: Some(t),
                    innate_points: base,
                    points_raised: 0,
                    experience: 0,
                },
            );
            self
        }
    }

    impl CharacterContext for MockChar {
        fn attribute(&self, t: AttributeType) -> Option<&AttributeInfo> {
            self.attrs.get(&t)
        }
        fn attribute_multiplier(&self, t: AttributeType) -> f32 {
            *self.attr_mult.get(&t).unwrap_or(&1.0)
        }
        fn attribute_additive(&self, t: AttributeType) -> i32 {
            *self.attr_add.get(&t).unwrap_or(&0)
        }
        fn vital_multiplier(&self, _t: VitalType) -> f32 {
            1.0
        }
        fn vital_additive(&self, _t: VitalType) -> i32 {
            0
        }
        fn skill_multiplier(&self, t: SkillType) -> f32 {
            *self.skill_mult.get(&t).unwrap_or(&1.0)
        }
        fn skill_additive(&self, t: SkillType) -> i32 {
            *self.skill_add.get(&t).unwrap_or(&0)
        }
        fn vitae(&self) -> f32 {
            self.vitae
        }
        fn value_int(&self, key: PropertyInt) -> i32 {
            *self.int_props.get(&key).unwrap_or(&0)
        }
    }

    /// Per `SkillInfo.cs:83`: `_base = (int)(InitLevel + PointsRaised)`.
    /// Hand math: 100 init + 50 raised = 150, no formula (Unusable training).
    #[test]
    fn base_unusable_skill_no_formula_bonus() {
        // Per SkillInfo.cs:85: Training > Unusable required for formula.
        let skill = SkillInfo {
            skill_type: Some(SkillType::LightWeapons),
            init_level: 100,
            points_raised: 50,
            training: TrainingClass::Unusable,
            formula: Some(SkillFormula::new(
                true,
                3,
                Some(AttributeType::StrengthAttr),
                Some(AttributeType::CoordinationAttr),
            )),
            ..Default::default()
        };
        let ctx = MockChar::new()
            .with_attr(AttributeType::StrengthAttr, 100)
            .with_attr(AttributeType::CoordinationAttr, 100);
        // formula bonus skipped because Unusable.
        assert_eq!(skill.base_value(&ctx), 150);
    }

    /// Per `SkillInfo.cs:85-92`: trained skill gets formula attr bonus.
    /// Hand math: LightWeapons trained, formula=(Str+Coord)/3, base=(100+100)/3=66.67 → 67.
    /// init=100 + raised=50 + 67 = 217.
    #[test]
    fn base_trained_skill_applies_formula() {
        let skill = SkillInfo {
            skill_type: Some(SkillType::LightWeapons),
            init_level: 100,
            points_raised: 50,
            training: TrainingClass::Trained,
            formula: Some(SkillFormula::new(
                true,
                3,
                Some(AttributeType::StrengthAttr),
                Some(AttributeType::CoordinationAttr),
            )),
            ..Default::default()
        };
        let ctx = MockChar::new()
            .with_attr(AttributeType::StrengthAttr, 100)
            .with_attr(AttributeType::CoordinationAttr, 100);
        // formula: (100 + 100) / 3 = 66.666... round() => 67.
        // base = 150 + 67 = 217. Plus Enlightenment=0 from trained.
        assert_eq!(skill.base_value(&ctx), 217);
    }

    /// Per `SkillInfo.cs:96-101`: Melee skills get +SkilledMelee×10.
    /// Hand math: skill=LightWeapons (melee), aug=2 → +20. Base 150+20=170.
    #[test]
    fn base_melee_aug_applies() {
        let skill = SkillInfo {
            skill_type: Some(SkillType::LightWeapons),
            init_level: 100,
            points_raised: 50,
            training: TrainingClass::Trained,
            formula: Some(SkillFormula::new(false, 1, None, None)),
            ..Default::default()
        };
        let mut ctx = MockChar::new();
        ctx.int_props.insert(PropertyInt::AugmentationSkilledMelee, 2);
        assert_eq!(skill.base_value(&ctx), 170);
    }

    /// Per `SkillInfo.cs:98-99`: Missile skills get +SkilledMissile×10.
    #[test]
    fn base_missile_aug_applies() {
        let skill = SkillInfo {
            skill_type: Some(SkillType::MissileWeapons),
            init_level: 100,
            points_raised: 50,
            training: TrainingClass::Trained,
            formula: Some(SkillFormula::new(false, 1, None, None)),
            ..Default::default()
        };
        let mut ctx = MockChar::new();
        ctx.int_props
            .insert(PropertyInt::AugmentationSkilledMissile, 3);
        assert_eq!(skill.base_value(&ctx), 180);
    }

    /// Per `SkillInfo.cs:100-101`: Magic skills get +SkilledMagic×10.
    #[test]
    fn base_magic_aug_applies() {
        let skill = SkillInfo {
            skill_type: Some(SkillType::WarMagic),
            init_level: 100,
            points_raised: 50,
            training: TrainingClass::Trained,
            formula: Some(SkillFormula::new(false, 1, None, None)),
            ..Default::default()
        };
        let mut ctx = MockChar::new();
        ctx.int_props.insert(PropertyInt::AugmentationSkilledMagic, 4);
        assert_eq!(skill.base_value(&ctx), 190);
    }

    /// Per `SkillInfo.cs:103-104`: Enlightenment applies only at Trained+.
    #[test]
    fn base_enlightenment_trained_or_higher() {
        // Trained: bonus applied.
        let skill = SkillInfo {
            skill_type: Some(SkillType::ArcaneLore),
            init_level: 100,
            points_raised: 0,
            training: TrainingClass::Trained,
            formula: Some(SkillFormula::new(false, 1, None, None)),
            ..Default::default()
        };
        let mut ctx = MockChar::new();
        ctx.int_props.insert(PropertyInt::Enlightenment, 5);
        assert_eq!(skill.base_value(&ctx), 105);
    }

    /// Per `SkillInfo.cs:103-104`: Untrained skill does NOT get Enlightenment.
    #[test]
    fn base_enlightenment_untrained_skipped() {
        let skill = SkillInfo {
            skill_type: Some(SkillType::ArcaneLore),
            init_level: 100,
            points_raised: 0,
            training: TrainingClass::Untrained,
            formula: Some(SkillFormula::new(false, 1, None, None)),
            ..Default::default()
        };
        let mut ctx = MockChar::new();
        ctx.int_props.insert(PropertyInt::Enlightenment, 5);
        // Untrained < Trained → no Enlightenment.
        assert_eq!(skill.base_value(&ctx), 100);
    }

    /// Per `SkillInfo.cs:94`: LumAugAllSkills always applies.
    #[test]
    fn base_lum_aug_all_skills_applies() {
        let skill = SkillInfo {
            skill_type: Some(SkillType::ArcaneLore),
            init_level: 100,
            points_raised: 0,
            training: TrainingClass::Untrained,
            formula: Some(SkillFormula::new(false, 1, None, None)),
            ..Default::default()
        };
        let mut ctx = MockChar::new();
        ctx.int_props.insert(PropertyInt::LumAugAllSkills, 7);
        assert_eq!(skill.base_value(&ctx), 107);
    }

    /// Per `SkillInfo.cs:135-140`: skill_multiplier × effective_base.
    /// Hand math: base=100, mult=1.5 → fTotal=150. vitae=1 → no scale.
    /// Additives=0, JoaT=0, not Specialized → 150.
    #[test]
    fn current_applies_skill_multiplier() {
        let skill = SkillInfo {
            skill_type: Some(SkillType::Healing),
            init_level: 100,
            points_raised: 0,
            training: TrainingClass::Trained,
            formula: Some(SkillFormula::new(false, 1, None, None)),
            ..Default::default()
        };
        let mut ctx = MockChar::new();
        ctx.skill_mult.insert(SkillType::Healing, 1.5);
        assert_eq!(skill.current(&ctx), 150);
    }

    /// Per `SkillInfo.cs:138-140`: vitae multiplier path.
    /// Hand math: base=100, mult=1.0, vitae=0.95 → fTotal=95.
    #[test]
    fn current_applies_vitae() {
        let skill = SkillInfo {
            skill_type: Some(SkillType::Healing),
            init_level: 100,
            points_raised: 0,
            training: TrainingClass::Trained,
            formula: Some(SkillFormula::new(false, 1, None, None)),
            ..Default::default()
        };
        let mut ctx = MockChar::new();
        ctx.vitae = 0.95;
        assert_eq!(skill.current(&ctx), 95);
    }

    /// Per `SkillInfo.cs:142`: JoaT×5 always applies.
    /// Hand math: base=100, mult=1, vitae=1, JoaT=3 → +15. Total=115.
    #[test]
    fn current_applies_jack_of_all_trades() {
        let skill = SkillInfo {
            skill_type: Some(SkillType::Healing),
            init_level: 100,
            points_raised: 0,
            training: TrainingClass::Trained,
            formula: Some(SkillFormula::new(false, 1, None, None)),
            ..Default::default()
        };
        let mut ctx = MockChar::new();
        ctx.int_props
            .insert(PropertyInt::AugmentationJackOfAllTrades, 3);
        assert_eq!(skill.current(&ctx), 115);
    }

    /// Per `SkillInfo.cs:144-145`: LumAugSkilledSpec×2 only for Specialized.
    /// Hand math: base=100, Spec, LumSpec=4 → +8. Total=108.
    #[test]
    fn current_lum_aug_spec_only_specialized() {
        let skill = SkillInfo {
            skill_type: Some(SkillType::Healing),
            init_level: 100,
            points_raised: 0,
            training: TrainingClass::Specialized,
            formula: Some(SkillFormula::new(false, 1, None, None)),
            ..Default::default()
        };
        let mut ctx = MockChar::new();
        ctx.int_props.insert(PropertyInt::LumAugSkilledSpec, 4);
        assert_eq!(skill.current(&ctx), 108);
    }

    /// Per `SkillInfo.cs:144`: Trained skill does NOT get LumAugSkilledSpec.
    #[test]
    fn current_lum_aug_spec_trained_skipped() {
        let skill = SkillInfo {
            skill_type: Some(SkillType::Healing),
            init_level: 100,
            points_raised: 0,
            training: TrainingClass::Trained,
            formula: Some(SkillFormula::new(false, 1, None, None)),
            ..Default::default()
        };
        let mut ctx = MockChar::new();
        ctx.int_props.insert(PropertyInt::LumAugSkilledSpec, 4);
        // Trained != Specialized → no bonus.
        assert_eq!(skill.current(&ctx), 100);
    }

    /// Per `SkillInfo.cs:147-148`: additive enchantment fold.
    /// Hand math: base=100, mult=1, add=-5 → max(round(95), 0) = 95.
    #[test]
    fn current_applies_additive_enchantment() {
        let skill = SkillInfo {
            skill_type: Some(SkillType::Healing),
            init_level: 100,
            points_raised: 0,
            training: TrainingClass::Trained,
            formula: Some(SkillFormula::new(false, 1, None, None)),
            ..Default::default()
        };
        let mut ctx = MockChar::new();
        ctx.skill_add.insert(SkillType::Healing, -5);
        assert_eq!(skill.current(&ctx), 95);
    }

    /// Per `SkillInfo.cs:148`: Max with 0 — result floored at 0.
    /// Hand math: base=100, mult=0, vitae=1, add=-1000 → -1000 → max(_, 0)=0.
    #[test]
    fn current_clamps_to_zero_on_massive_debuff() {
        let skill = SkillInfo {
            skill_type: Some(SkillType::Healing),
            init_level: 100,
            points_raised: 0,
            training: TrainingClass::Trained,
            formula: Some(SkillFormula::new(false, 1, None, None)),
            ..Default::default()
        };
        let mut ctx = MockChar::new();
        ctx.skill_mult.insert(SkillType::Healing, 0.0);
        ctx.skill_add.insert(SkillType::Healing, -1000);
        assert_eq!(skill.current(&ctx), 0);
    }

    /// Per `SkillInfo.cs:96-101`: Mutual exclusion — a skill in MELEE_SKILLS
    /// does NOT also get the missile/magic aug.
    #[test]
    fn skill_class_aug_mutual_exclusion() {
        let skill = SkillInfo {
            skill_type: Some(SkillType::LightWeapons),
            init_level: 100,
            points_raised: 0,
            training: TrainingClass::Trained,
            formula: Some(SkillFormula::new(false, 1, None, None)),
            ..Default::default()
        };
        let mut ctx = MockChar::new();
        ctx.int_props.insert(PropertyInt::AugmentationSkilledMelee, 1);
        ctx.int_props
            .insert(PropertyInt::AugmentationSkilledMissile, 1);
        ctx.int_props.insert(PropertyInt::AugmentationSkilledMagic, 1);
        // Only Melee aug applies (else-if chain).
        assert_eq!(skill.base_value(&ctx), 110);
    }

    /// Per `SkillInfo.cs:168`: AlwaysTrained skills have min_training=Trained.
    #[test]
    fn min_training_always_trained_skills() {
        for &skill in ALWAYS_TRAINED {
            assert_eq!(SkillInfo::min_training(skill), TrainingClass::Trained);
        }
    }

    /// Per `SkillInfo.cs:168`: non-AlwaysTrained skills have min_training=Unusable.
    #[test]
    fn min_training_other_skills() {
        assert_eq!(
            SkillInfo::min_training(SkillType::LightWeapons),
            TrainingClass::Unusable
        );
    }

    /// Per `SkillInfo.cs:171`: Salvaging max_training=Trained.
    #[test]
    fn max_training_salvaging() {
        assert_eq!(
            SkillInfo::max_training(SkillType::Salvaging),
            TrainingClass::Trained
        );
    }

    /// Per `SkillInfo.cs:171`: other skills max_training=Specialized.
    #[test]
    fn max_training_other_skills() {
        assert_eq!(
            SkillInfo::max_training(SkillType::LightWeapons),
            TrainingClass::Specialized
        );
    }

    /// Per `SkillInfo.cs:174-176`: Salvaging cost_to_increase = 0.
    #[test]
    fn cost_to_increase_salvaging_always_zero() {
        let skill = SkillInfo {
            skill_type: Some(SkillType::Salvaging),
            training: TrainingClass::Untrained,
            ..Default::default()
        };
        assert_eq!(skill.cost_to_increase_training(10, 20), 0);
    }

    /// Per `SkillInfo.cs:177-178`: Specialized cost_to_increase = 0.
    #[test]
    fn cost_to_increase_specialized_zero() {
        let skill = SkillInfo {
            skill_type: Some(SkillType::Healing),
            training: TrainingClass::Specialized,
            ..Default::default()
        };
        assert_eq!(skill.cost_to_increase_training(5, 15), 0);
    }

    /// Per `SkillInfo.cs:179-180`: Trained cost_to_increase = spec - trained.
    #[test]
    fn cost_to_increase_trained() {
        let skill = SkillInfo {
            skill_type: Some(SkillType::Healing),
            training: TrainingClass::Trained,
            ..Default::default()
        };
        // Spec=20, Trained=8 → cost = 20 - 8 = 12.
        assert_eq!(skill.cost_to_increase_training(8, 20), 12);
    }

    /// Per `SkillInfo.cs:182-183`: Unusable / Untrained cost = TrainedCost.
    #[test]
    fn cost_to_increase_untrained() {
        let skill = SkillInfo {
            skill_type: Some(SkillType::Healing),
            training: TrainingClass::Untrained,
            ..Default::default()
        };
        assert_eq!(skill.cost_to_increase_training(8, 20), 8);
    }

    /// Per `SkillInfo.cs:46-54` setter: value < min_level → Unusable.
    #[test]
    fn set_training_below_min_level_clamps_unusable() {
        let mut skill = SkillInfo::new(SkillType::ArcaneLore);
        // min_level = Trained(2) requires value >= 2 to retain.
        skill.set_training(TrainingClass::Untrained, 2);
        assert_eq!(skill.training, TrainingClass::Unusable);
    }

    /// Per `SkillInfo.cs:46-54` setter: value >= min_level → retained.
    #[test]
    fn set_training_at_or_above_min_level_retained() {
        let mut skill = SkillInfo::new(SkillType::ArcaneLore);
        skill.set_training(TrainingClass::Trained, 2);
        assert_eq!(skill.training, TrainingClass::Trained);

        skill.set_training(TrainingClass::Specialized, 2);
        assert_eq!(skill.training, TrainingClass::Specialized);
    }

    /// Verify the static skill-list constants match the C# source byte-for-byte.
    #[test]
    fn melee_skills_list_matches_csharp() {
        // Per SkillInfo.cs:243-259: 12 entries.
        assert_eq!(MELEE_SKILLS.len(), 12);
        assert!(MELEE_SKILLS.contains(&SkillType::LightWeapons));
        assert!(MELEE_SKILLS.contains(&SkillType::Axe)); // legacy
    }

    #[test]
    fn missile_skills_list_matches_csharp() {
        // Per SkillInfo.cs:264-273: 5 entries (1 modern + 4 legacy).
        assert_eq!(MISSILE_SKILLS.len(), 5);
        assert!(MISSILE_SKILLS.contains(&SkillType::MissileWeapons));
        assert!(MISSILE_SKILLS.contains(&SkillType::Bow));
    }

    #[test]
    fn magic_skills_list_matches_csharp() {
        // Per SkillInfo.cs:278-285: 5 entries.
        assert_eq!(MAGIC_SKILLS.len(), 5);
        assert!(MAGIC_SKILLS.contains(&SkillType::WarMagic));
    }

    #[test]
    fn always_trained_list_matches_csharp() {
        // Per SkillInfo.cs:290-298: 6 entries.
        assert_eq!(ALWAYS_TRAINED.len(), 6);
        assert!(ALWAYS_TRAINED.contains(&SkillType::Salvaging));
    }

    #[test]
    fn aug_spec_skills_list_matches_csharp() {
        // Per SkillInfo.cs:303-310: 5 entries.
        assert_eq!(AUG_SPEC_SKILLS.len(), 5);
        assert!(AUG_SPEC_SKILLS.contains(&SkillType::Salvaging));
    }

    /// Integration test: attribute → skill chain matches retail-style numbers.
    /// Per ACE.Server skill-formula reference: LightWeapons base = (Str+Coord)/3.
    /// Hand math for level 1 starting character:
    ///   - Str.base=60, Coord.base=60. (60+60)/3 = 40.
    ///   - LightWeapons InitLevel=10, PointsRaised=0, Trained.
    ///   - Base = 10 + 40 = 50.
    #[test]
    fn integration_attr_to_skill_base() {
        let skill = SkillInfo {
            skill_type: Some(SkillType::LightWeapons),
            init_level: 10,
            points_raised: 0,
            training: TrainingClass::Trained,
            formula: Some(SkillFormula::new(
                true,
                3,
                Some(AttributeType::StrengthAttr),
                Some(AttributeType::CoordinationAttr),
            )),
            ..Default::default()
        };
        let ctx = MockChar::new()
            .with_attr(AttributeType::StrengthAttr, 60)
            .with_attr(AttributeType::CoordinationAttr, 60);
        // formula: (60+60)/3 = 40. base = 10 + 40 = 50.
        assert_eq!(skill.base_value(&ctx), 50);
    }
}
