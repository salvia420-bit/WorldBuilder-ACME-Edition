use super::PlayerState;
use crate::stats;
use holtburger_common::properties::EnchantmentTypeFlags;

impl PlayerState {
    pub fn get_attribute_multiplier(&self, attr: stats::AttributeType) -> f32 {
        crate::magic::get_enchantment_multiplier(
            &self.enchantments,
            EnchantmentTypeFlags::ATTRIBUTE.bits(),
            attr as u32,
        )
    }

    pub fn get_attribute_additive(&self, attr: stats::AttributeType) -> f32 {
        crate::magic::get_enchantment_additive(
            &self.enchantments,
            EnchantmentTypeFlags::ATTRIBUTE.bits(),
            attr as u32,
        )
    }

    pub fn get_attribute_base(&self, attr: stats::AttributeType) -> u32 {
        self.attributes.get(&attr).map(|a| a.base).unwrap_or(0)
    }

    pub fn get_attribute_current(&self, attr: stats::AttributeType) -> u32 {
        let base = self.get_attribute_base(attr) as f32;
        let mult = self.get_attribute_multiplier(attr);
        let add = self.get_attribute_additive(attr);

        let total = (base * mult) + add;

        // ACE: attributes cannot be debuffed below 10 normally,
        // or 1 for creatures with very low starting attributes
        let min_attr = if base >= 10.0 { 10.0 } else { 1.0 };

        total.round().max(min_attr) as u32
    }

    pub fn calculate_vital_attribute_contribution(
        &self,
        vital_type: stats::VitalType,
        use_current: bool,
    ) -> u32 {
        let get_val = |attr: stats::AttributeType| {
            if use_current {
                self.get_attribute_current(attr)
            } else {
                self.get_attribute_base(attr)
            }
        };

        match vital_type {
            stats::VitalType::Health => {
                (get_val(stats::AttributeType::EnduranceAttr) as f32 / 2.0).round() as u32
            }
            stats::VitalType::Stamina => get_val(stats::AttributeType::EnduranceAttr),
            stats::VitalType::Mana => get_val(stats::AttributeType::SelfAttr),
        }
    }

    pub fn get_vital_multiplier(&self, vital: stats::VitalType) -> f32 {
        crate::magic::get_enchantment_multiplier(
            &self.enchantments,
            EnchantmentTypeFlags::SECOND_ATT.bits(),
            vital as u32,
        )
    }

    pub fn get_vital_additive(&self, vital: stats::VitalType) -> f32 {
        crate::magic::get_enchantment_additive(
            &self.enchantments,
            EnchantmentTypeFlags::SECOND_ATT.bits(),
            vital as u32,
        )
    }

    pub fn calculate_vital_base(&self, vital_type: stats::VitalType) -> u32 {
        let base_data = self
            .vital_bases
            .get(&vital_type)
            .cloned()
            .unwrap_or_default();
        let base_no_bonus = base_data.ranks + base_data.start;
        let bonus = self.calculate_vital_attribute_contribution(vital_type, false);
        base_no_bonus + bonus
    }

    pub fn calculate_vital_current(&self, vital_type: stats::VitalType) -> u32 {
        let base_data = self
            .vital_bases
            .get(&vital_type)
            .cloned()
            .unwrap_or_default();
        let base_no_bonus = base_data.ranks + base_data.start;
        let attr_bonus = self.calculate_vital_attribute_contribution(vital_type, true);

        let total_base = (base_no_bonus + attr_bonus) as f32;
        let mult = self.get_vital_multiplier(vital_type);
        let add = self.get_vital_additive(vital_type);

        let total = (total_base * mult) + add;

        // ACE: a creature cannot fall below 5 MaxVital from enchantments / vitae normally,
        // or 1 MaxVital for creatures with very low starting vitals
        let min_vital = if total_base >= 5.0 { 5.0 } else { 1.0 };

        total.round().max(min_vital) as u32
    }

    pub fn get_skill_multiplier(&self, skill: stats::SkillType) -> f32 {
        crate::magic::get_enchantment_multiplier(
            &self.enchantments,
            EnchantmentTypeFlags::SKILL.bits(),
            skill as u32,
        )
    }

    pub fn get_skill_additive(&self, skill: stats::SkillType) -> f32 {
        crate::magic::get_enchantment_additive(
            &self.enchantments,
            EnchantmentTypeFlags::SKILL.bits(),
            skill as u32,
        )
    }

    /// The `SkillFormula` a skill's attribute bonus is derived from, as it
    /// appears in `portal.dat`'s SkillTable (`0x0E000004`).
    ///
    /// `None` means "no attribute bonus at all" — this is the DAT's
    /// `attribute1Multiplier` (`SkillFormula.X`) being 0, or the skill being
    /// absent from the SkillTable entirely. Both cases return 0 in ACE
    /// (`ACE.Server/Entity/AttributeFormula.cs:24` early-return for a missing
    /// skill, `:57` `if (formula.X == 0) return 0;`).
    ///
    /// Rust review 2026-08-03: this table was previously grouped by
    /// hand-guessed "families" and disagreed with the DAT on 17 skills — see
    /// `skill_attribute_formula_matches_portal_dat` in `player/tests.rs` for
    /// the full DAT-sourced expectation table and the drift it pins down.
    fn skill_attribute_formula(
        skill_type: stats::SkillType,
    ) -> Option<(
        stats::AttributeType,
        Option<stats::AttributeType>,
        u32,
    )> {
        use stats::AttributeType::*;
        use stats::SkillType::*;

        // Values below are the live `client_portal.dat` SkillTable rows
        // (`attribute1`, `attribute2`, `divisor`), with the ten retired
        // weapon skills backfilled exactly as ACE's
        // `ACE.DatLoader/FileTypes/SkillTable.cs:25-37 AddRetiredSkills()`
        // does (they are not in the modern portal.dat).
        Some(match skill_type {
            // --- portal.dat rows ---
            Alchemy => (CoordinationAttr, Some(FocusAttr), 3),
            ArcaneLore => (FocusAttr, None, 3),
            ArmorTinkering => (FocusAttr, Some(EnduranceAttr), 2),
            Cooking => (CoordinationAttr, Some(FocusAttr), 3),
            CreatureEnchantment => (FocusAttr, Some(SelfAttr), 4),
            DirtyFighting => (StrengthAttr, Some(CoordinationAttr), 3),
            DualWield => (CoordinationAttr, Some(CoordinationAttr), 3),
            FinesseWeapons => (QuicknessAttr, Some(CoordinationAttr), 3),
            Fletching => (CoordinationAttr, Some(FocusAttr), 3),
            Healing => (FocusAttr, Some(CoordinationAttr), 3),
            HeavyWeapons => (StrengthAttr, Some(CoordinationAttr), 3),
            ItemEnchantment => (FocusAttr, Some(SelfAttr), 4),
            ItemTinkering => (FocusAttr, Some(CoordinationAttr), 2),
            Jump => (StrengthAttr, Some(CoordinationAttr), 2),
            LifeMagic => (FocusAttr, Some(SelfAttr), 4),
            LightWeapons => (StrengthAttr, Some(CoordinationAttr), 3),
            Lockpick => (CoordinationAttr, Some(FocusAttr), 3),
            MagicDefense => (SelfAttr, Some(FocusAttr), 7),
            MagicItemTinkering => (FocusAttr, None, 1),
            ManaConversion => (FocusAttr, Some(SelfAttr), 6),
            MeleeDefense => (QuicknessAttr, Some(CoordinationAttr), 3),
            MissileDefense => (QuicknessAttr, Some(CoordinationAttr), 5),
            MissileWeapons => (CoordinationAttr, None, 2),
            Recklessness => (StrengthAttr, Some(QuicknessAttr), 3),
            Run => (QuicknessAttr, None, 1),
            Shield => (StrengthAttr, Some(CoordinationAttr), 2),
            SneakAttack => (CoordinationAttr, Some(QuicknessAttr), 3),
            Summoning => (EnduranceAttr, Some(SelfAttr), 3),
            TwoHandedCombat => (StrengthAttr, Some(CoordinationAttr), 3),
            VoidMagic => (FocusAttr, Some(SelfAttr), 4),
            WarMagic => (FocusAttr, Some(SelfAttr), 4),
            WeaponTinkering => (FocusAttr, Some(StrengthAttr), 2),

            // --- ACE AddRetiredSkills() backfill ---
            Axe | Mace | Spear | Staff | Sword | UnarmedCombat => {
                (StrengthAttr, Some(CoordinationAttr), 3)
            }
            Bow | Crossbow | ThrownWeapon => (CoordinationAttr, None, 2),
            Dagger => (QuicknessAttr, Some(CoordinationAttr), 3),

            // --- `SkillFormula.X == 0` in portal.dat: no attribute bonus ---
            AssessCreature | AssessPerson | Deception | Leadership | Loyalty | Salvaging => {
                return None;
            }

            // --- absent from both portal.dat and AddRetiredSkills(): ACE's
            // `TryGetValue` miss returns 0 (AttributeFormula.cs:24). These are
            // the retired/unimplemented skills ACE never sends a live client. ---
            Sling | Spellcraft | Awareness | ArmsAndArmorRepair | Gearcraft | Challenge => {
                return None;
            }
        })
    }

    pub fn derive_skill_value(
        &self,
        skill_type: stats::SkillType,
        ranks: u32,
        init: u32,
        use_current: bool,
    ) -> u32 {
        let get_val = |attr: stats::AttributeType| {
            if use_current {
                self.get_attribute_current(attr)
            } else {
                self.get_attribute_base(attr)
            }
        };

        // ACE `AttributeFormula.GetFormula` (AttributeFormula.cs:55-73):
        // total = attr1 (+ attr2 when it is not Undef); then, ONLY when the
        // divisor differs from 1, `total = Round(total / divisor)` with
        // `MidpointRounding.AwayFromZero` (ACE.Common FloatExtensions.cs:9) —
        // which is exactly Rust's `f32::round`.
        let bonus = match Self::skill_attribute_formula(skill_type) {
            None => 0.0,
            Some((a1, a2, div)) => {
                let total = get_val(a1) + a2.map(get_val).unwrap_or(0);
                if div == 1 {
                    total as f32
                } else {
                    (total as f32 / div as f32).round()
                }
            }
        };

        let total_base = (bonus as u32 + ranks + init) as f32;

        if use_current {
            let mult = self.get_skill_multiplier(skill_type);
            let add = self.get_skill_additive(skill_type);
            ((total_base * mult) + add).round().max(0.0) as u32
        } else {
            total_base as u32
        }
    }

    pub(crate) fn refresh_cached_derived_stat_inputs(&mut self) {
        // Recalculate Attributes
        let attr_types: Vec<_> = self.attributes.keys().cloned().collect();
        for attr_type in attr_types {
            let current = self.get_attribute_current(attr_type);
            if let Some(attr) = self.attributes.get_mut(&attr_type) {
                attr.current = current;
            }
        }

        // Recalculate Vitals
        for vital_type in [
            stats::VitalType::Health,
            stats::VitalType::Stamina,
            stats::VitalType::Mana,
        ] {
            let base = self.calculate_vital_base(vital_type);
            let buffed_max = self.calculate_vital_current(vital_type);
            if let Some(vital) = self.vitals.get_mut(&vital_type) {
                vital.base = base;
                vital.buffed_max = buffed_max;
                // Clamp current to buffed_max if it's higher
                if vital.current > buffed_max {
                    vital.current = buffed_max;
                }
            }
        }

        // Recalculate Skills
        let skill_types: Vec<_> = self.skill_bases.keys().cloned().collect();
        for skill_type in skill_types {
            let base_data = self.skill_bases[&skill_type];
            let base_val =
                self.derive_skill_value(skill_type, base_data.ranks, base_data.init, false);
            let current_val =
                self.derive_skill_value(skill_type, base_data.ranks, base_data.init, true);
            if let Some(skill) = self.skills.get_mut(&skill_type) {
                skill.base = base_val;
                skill.current = current_val;
            }
        }
    }
}
