use super::PlayerState;
use crate::stats;
use holtburger_common::properties::EnchantmentTypeFlags;
use holtburger_protocol::messages::magic::Enchantment;

impl PlayerState {
    /// enchstats-1/5 (2026-10-08): the local player's top-layer product /
    /// sum for one stat family + key — retail's cull predicate
    /// (`crate::magic`, `CullEnchantmentsFromList`) with the same-power duel
    /// keyed on receive-time-rebased start times ([`Self::abs_start_time`]).
    fn player_enchantment_multiplier(&self, family: u32, key: u32) -> f32 {
        crate::magic::get_enchantment_multiplier_with_start(
            &self.enchantments,
            family,
            key,
            &|e: &Enchantment| self.abs_start_time(e),
        )
    }

    fn player_enchantment_additive(&self, family: u32, key: u32) -> f32 {
        crate::magic::get_enchantment_additive_with_start(
            &self.enchantments,
            family,
            key,
            &|e: &Enchantment| self.abs_start_time(e),
        )
    }

    pub fn get_attribute_multiplier(&self, attr: stats::AttributeType) -> f32 {
        self.player_enchantment_multiplier(EnchantmentTypeFlags::ATTRIBUTE.bits(), attr as u32)
    }

    pub fn get_attribute_additive(&self, attr: stats::AttributeType) -> f32 {
        self.player_enchantment_additive(EnchantmentTypeFlags::ATTRIBUTE.bits(), attr as u32)
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
        self.player_enchantment_multiplier(EnchantmentTypeFlags::SECOND_ATT.bits(), vital as u32)
    }

    pub fn get_vital_additive(&self, vital: stats::VitalType) -> f32 {
        self.player_enchantment_additive(EnchantmentTypeFlags::SECOND_ATT.bits(), vital as u32)
    }

    /// enchstats-3 (2026-10-08): retail `CACQualities::InqAttribute2nd`
    /// (acclient.c:443223) adds `InqInt(0x17B GearMaxHealth)` to Max Health
    /// BEFORE the raw/enchanted split, so it is part of the unbuffed base
    /// and is scaled by vitae and the enchantment multiplier.
    fn gear_max_health_term(&self, vital_type: stats::VitalType) -> u32 {
        if matches!(vital_type, stats::VitalType::Health) {
            self.stat_aug.gear_max_health.max(0) as u32
        } else {
            0
        }
    }

    /// Retail `InqAttribute2nd(stype, &v, raw = 1)`: formula over UNBUFFED
    /// attributes + start + ranks (+ GearMaxHealth for Health).
    pub fn calculate_vital_base(&self, vital_type: stats::VitalType) -> u32 {
        let base_data = self
            .vital_bases
            .get(&vital_type)
            .cloned()
            .unwrap_or_default();
        let base_no_bonus = base_data.ranks + base_data.start;
        let bonus = self.calculate_vital_attribute_contribution(vital_type, false);
        base_no_bonus + bonus + self.gear_max_health_term(vital_type)
    }

    /// Retail `InqAttribute2nd(stype, &v, raw = 0)` → `EnchantAttribute2nd`
    /// (acclient.c:445921): `pre` = formula over ENCHANTED attributes +
    /// start + ranks (+ GearMaxHealth); then `tmp = pre * vitae` (the
    /// `_vitae` enchantment goes FIRST, outside the culled lists), then the
    /// culled multipliers and additives; floor 5 (or 1 when `pre < 5`);
    /// `(u64)(tmp + 0.5)`.
    pub fn calculate_vital_current(&self, vital_type: stats::VitalType) -> u32 {
        let base_data = self
            .vital_bases
            .get(&vital_type)
            .cloned()
            .unwrap_or_default();
        let base_no_bonus = base_data.ranks + base_data.start;
        let attr_bonus = self.calculate_vital_attribute_contribution(vital_type, true);

        let pre = base_no_bonus + attr_bonus + self.gear_max_health_term(vital_type);
        let mult = self.get_vital_multiplier(vital_type);
        let add = self.get_vital_additive(vital_type);

        let mut tmp = pre as f32 * self.vitae();
        tmp = (tmp * mult) + add;

        // Retail: `if (*val < 5) { if (tmp < 1.0) tmp = 1.0; } else if (tmp < 5.0) tmp = 5.0;`
        // where `*val` is the pre-enchantment value.
        let min_vital = if pre >= 5 { 5.0 } else { 1.0 };
        if tmp < min_vital {
            tmp = min_vital;
        }

        (tmp + 0.5) as u32
    }

    pub fn get_skill_multiplier(&self, skill: stats::SkillType) -> f32 {
        self.player_enchantment_multiplier(EnchantmentTypeFlags::SKILL.bits(), skill as u32)
    }

    pub fn get_skill_additive(&self, skill: stats::SkillType) -> f32 {
        self.player_enchantment_additive(EnchantmentTypeFlags::SKILL.bits(), skill as u32)
    }

    /// enchstats-2 (2026-10-08): retail `CACQualities::InqSkill`'s
    /// skilled-category augmentation (acclient.c:443603): `+10` when the
    /// matching `InqInt` is > 0 — 300 `AugmentationSkilledMelee` for
    /// 0x29/0x2C/0x2D/0x2E/0x31, 301 `AugmentationSkilledMissile` for 0x2F,
    /// 302 `AugmentationSkilledMagic` for 0x1F/0x20/0x21/0x22/0x2B.
    fn skilled_category_aug_bonus(&self, skill_type: stats::SkillType) -> u32 {
        use stats::SkillType::*;
        let aug = match skill_type {
            TwoHandedCombat | HeavyWeapons | LightWeapons | FinesseWeapons | DualWield => {
                self.stat_aug.aug_skilled_melee
            }
            MissileWeapons => self.stat_aug.aug_skilled_missile,
            CreatureEnchantment | ItemEnchantment | LifeMagic | WarMagic | VoidMagic => {
                self.stat_aug.aug_skilled_magic
            }
            _ => 0,
        };
        if aug > 0 { 10 } else { 0 }
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

    /// Retail `CACQualities::InqSkill(stype, &v, raw)` (acclient.c:443603),
    /// enchstats-2 (2026-10-08). `use_current = false` is `raw = 1` (the
    /// sheet's base), `true` is `raw = 0` (the sheet's current):
    ///
    /// 1. `InqSkillBaseLevel` (:443298): the attribute formula ONLY when the
    ///    skill's `sac >= SkillTable min_level` (a train-only skill such as
    ///    War Magic held Untrained gets 0); `sac` defaults to 1 for a skill
    ///    the player does not hold.
    /// 2. `+ init + ranks`, `+ LumAugAllSkills` (if > 0), `+ 10` for the
    ///    skilled-category augmentations — all part of `raw`.
    /// 3. `!raw` only: `EnchantSkill` (:445984) — vitae FIRST
    ///    (`tmp *= vitae`), then the culled multipliers / additives,
    ///    `tmp <= 0.5 → 0`, `(u64)(tmp + 0.5)`; then `+5` for
    ///    JackOfAllTrades and `+2·LumAugSkilledSpec` when specialized.
    ///
    /// Retail `InqRunRate` / `InqJumpVelocity` (:443696 / :443773) inline
    /// exactly this composition, so `current` IS the run / jump skill — the
    /// movement lane must not add the augmentation terms again
    /// (`context.rs` `player_composed_run_skill`).
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

        let (sac, min_level) = self
            .skill_bases
            .get(&skill_type)
            .map(|b| (b.sac, b.min_level))
            .unwrap_or((1, 1));

        // ACE `AttributeFormula.GetFormula` (AttributeFormula.cs:55-73):
        // total = attr1 (+ attr2 when it is not Undef); then, ONLY when the
        // divisor differs from 1, `total = Round(total / divisor)` with
        // `MidpointRounding.AwayFromZero` (ACE.Common FloatExtensions.cs:9) —
        // which is exactly Rust's `f32::round`.
        let bonus = if sac >= min_level {
            match Self::skill_attribute_formula(skill_type) {
                None => 0.0,
                Some((a1, a2, div)) => {
                    let total = get_val(a1) + a2.map(get_val).unwrap_or(0);
                    if div == 1 {
                        total as f32
                    } else {
                        (total as f32 / div as f32).round()
                    }
                }
            }
        } else {
            0.0
        };

        let aug = self.stat_aug;
        let mut raw = bonus as u32 + ranks + init;
        if aug.lum_aug_all_skills > 0 {
            raw += aug.lum_aug_all_skills as u32;
        }
        raw += self.skilled_category_aug_bonus(skill_type);

        if !use_current {
            return raw;
        }

        let mult = self.get_skill_multiplier(skill_type);
        let add = self.get_skill_additive(skill_type);
        let mut tmp = raw as f32 * self.vitae();
        tmp = (tmp * mult) + add;
        let mut current = if tmp <= 0.5 { 0 } else { (tmp + 0.5) as u32 };

        if aug.jack_of_all_trades > 0 {
            current += 5;
        }
        if sac == 3 && aug.lum_aug_skilled_spec > 0 {
            current += 2 * aug.lum_aug_skilled_spec as u32;
        }
        current
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
