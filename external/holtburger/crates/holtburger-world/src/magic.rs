use super::stats::{AttributeType, SkillType};
use holtburger_common::properties::{EnchantmentTypeFlags, PropertyFloat, PropertyInt};
use holtburger_protocol::messages::magic::Enchantment;
use std::collections::HashMap;

/// ACE `PropertiesEnchantmentRegistryExtensions.Level8AuraSelfSpells`
/// (ACE.Entity/Models/PropertiesEnchantmentRegistryExtensions.cs:131-139), whose
/// own comment reads: *"this ensures level 8 item self spells always take
/// precedence over level 8 item other spells."* It is the SECOND sort key in
/// all three `GetEnchantmentsTopLayer*` chains (`:153-155`, `:180-182`,
/// `:223-227`), between `PowerLevel` and the set-spell/start-time key.
///
/// Ids computed from `ACE.Entity/Enum/SpellId.cs`.
///
/// DRIFT NOTE (2026-08-03): this repo already carries a correct copy of the
/// same contract at `holtburger-core/src/client/character_info.rs:75-82`
/// (`LEVEL_8_AURA_SELF_SPELLS`, with its own regression test at :1171-1188).
/// `holtburger-core` depends on `holtburger-world`, not the other way round, so
/// the two cannot share a definition without moving it down into
/// `holtburger-common` — flagged for the reviewer rather than done here.
const LEVEL_8_AURA_SELF_SPELLS: [u16; 6] = [
    4395, // SpellId.BloodDrinkerSelf8
    4400, // SpellId.DefenderSelf8
    4405, // SpellId.HeartSeekerSelf8
    4414, // SpellId.SpiritDrinkerSelf8
    4417, // SpellId.SwiftKillerSelf8
    4418, // SpellId.HermeticLinkSelf8
];

fn is_level_8_aura_self(spell_id: u16) -> bool {
    LEVEL_8_AURA_SELF_SPELLS.contains(&spell_id)
}

fn is_higher_priority_enchantment(current: &Enchantment, challenger: &Enchantment) -> bool {
    if challenger.power_level != current.power_level {
        return challenger.power_level > current.power_level;
    }

    // Rust review 2026-08-03 — the missing middle sort key. Without it a
    // same-category, same-power level-8 "other" aura could beat the level-8
    // SELF aura purely on start_time, which is exactly what ACE's second
    // `ThenByDescending` exists to prevent.
    let current_is_l8_self = is_level_8_aura_self(current.spell_id);
    let challenger_is_l8_self = is_level_8_aura_self(challenger.spell_id);
    if current_is_l8_self != challenger_is_l8_self {
        return challenger_is_l8_self;
    }

    let current_is_set = current.spell_set_id.is_some();
    let challenger_is_set = challenger.spell_set_id.is_some();
    if current_is_set != challenger_is_set {
        return challenger_is_set;
    }

    if challenger_is_set {
        challenger.spell_id > current.spell_id
    } else {
        challenger.start_time > current.start_time
    }
}

fn get_top_enchantments(
    enchantments: &[Enchantment],
    required_flags: u32,
    stat_mod_key: u32,
    is_keyless: bool,
) -> Vec<&Enchantment> {
    let mut top_by_category: HashMap<u16, &Enchantment> = HashMap::new();

    for enchantment in enchantments {
        if (enchantment.stat_mod_type & required_flags) != required_flags {
            continue;
        }
        if !is_keyless && enchantment.stat_mod_key != stat_mod_key {
            continue;
        }

        top_by_category
            .entry(enchantment.spell_category)
            .and_modify(|current| {
                if is_higher_priority_enchantment(current, enchantment) {
                    *current = enchantment;
                }
            })
            .or_insert(enchantment);
    }

    top_by_category.into_values().collect()
}

pub fn get_enchantment_multiplier(
    enchantments: &[Enchantment],
    stat_mod_type: u32,
    stat_mod_key: u32,
) -> f32 {
    let required_flags = stat_mod_type | EnchantmentTypeFlags::MULTIPLICATIVE.bits();

    // Stats that don't use the stat_mod_key for filtering
    let is_keyless = (stat_mod_type
        & (EnchantmentTypeFlags::BODY_ARMOR_VALUE.bits()
            | EnchantmentTypeFlags::BODY_DAMAGE_VALUE.bits()
            | EnchantmentTypeFlags::BODY_DAMAGE_VARIANCE.bits()
            | EnchantmentTypeFlags::VITAE.bits()))
        != 0;

    get_top_enchantments(enchantments, required_flags, stat_mod_key, is_keyless)
        .into_iter()
        .fold(1.0f32, |acc, enchantment| acc * enchantment.stat_mod_value)
}

pub fn get_enchantment_additive(
    enchantments: &[Enchantment],
    stat_mod_type: u32,
    stat_mod_key: u32,
) -> f32 {
    let required_flags = stat_mod_type | EnchantmentTypeFlags::ADDITIVE.bits();

    // Stats that don't use the stat_mod_key for filtering
    let is_keyless = (stat_mod_type
        & (EnchantmentTypeFlags::BODY_ARMOR_VALUE.bits()
            | EnchantmentTypeFlags::BODY_DAMAGE_VALUE.bits()
            | EnchantmentTypeFlags::BODY_DAMAGE_VARIANCE.bits()
            | EnchantmentTypeFlags::VITAE.bits()))
        != 0;

    get_top_enchantments(enchantments, required_flags, stat_mod_key, is_keyless)
        .into_iter()
        .fold(0.0f32, |acc, enchantment| acc + enchantment.stat_mod_value)
}

fn get_player_natural_resistance(
    resistance_key: u32,
    strength_base: u32,
    endurance_base: u32,
) -> f32 {
    if resistance_key == PropertyFloat::ResistNether as u32 {
        return 0.5;
    }

    let str_and_end = strength_base + endurance_base;
    if str_and_end <= 200 {
        return 1.0;
    }

    let natural_resistance = 1.0 - (((str_and_end - 200) as f32 / 300.0) * 0.5);
    natural_resistance.max(0.5)
}

pub fn get_player_enchanted_resistance(
    base_resistance: f32,
    enchantments: &[Enchantment],
    resistance_key: u32,
    strength_base: u32,
    endurance_base: u32,
    augmentation_resistance: i32,
) -> f32 {
    let required_flags = EnchantmentTypeFlags::FLOAT.bits()
        | EnchantmentTypeFlags::SINGLE_STAT.bits()
        | EnchantmentTypeFlags::MULTIPLICATIVE.bits();
    let top_enchantments =
        get_top_enchantments(enchantments, required_flags, resistance_key, false);

    let mut protection_mod = 1.0f32;
    let mut vulnerability_mod = 1.0f32;

    for enchantment in top_enchantments {
        if enchantment.stat_mod_value < 1.0 {
            protection_mod *= enchantment.stat_mod_value;
        } else if enchantment.stat_mod_value > 1.0 {
            vulnerability_mod *= enchantment.stat_mod_value;
        }
    }

    let natural_resistance =
        get_player_natural_resistance(resistance_key, strength_base, endurance_base);
    if protection_mod > natural_resistance {
        protection_mod = natural_resistance;
    }

    if augmentation_resistance > 0 {
        let augmentation_factor = ((augmentation_resistance as f32) * 0.1).min(1.0);
        protection_mod *= 1.0 - augmentation_factor;
    }

    base_resistance * protection_mod * vulnerability_mod
}

pub fn get_enchanted_resistance(
    base_resistance: f32,
    enchantments: &[Enchantment],
    resistance_key: u32,
) -> f32 {
    let mult = get_enchantment_multiplier(
        enchantments,
        EnchantmentTypeFlags::FLOAT.bits() | EnchantmentTypeFlags::SINGLE_STAT.bits(),
        resistance_key,
    );
    let add = get_enchantment_additive(
        enchantments,
        EnchantmentTypeFlags::FLOAT.bits() | EnchantmentTypeFlags::SINGLE_STAT.bits(),
        resistance_key,
    );

    ((base_resistance * mult) + add).clamp(-2.0, 2.0)
}

pub fn get_enchanted_armor(base_armor: i32, enchantments: &[Enchantment]) -> i32 {
    let key = 0; // ignored for BODY_ARMOR_VALUE
    let flags = EnchantmentTypeFlags::BODY_ARMOR_VALUE.bits();

    let mult = get_enchantment_multiplier(enchantments, flags, key);
    let add = get_enchantment_additive(enchantments, flags, key);

    ((base_armor as f32 * mult) + add).round() as i32
}

pub fn get_total_vitae(enchantments: &[Enchantment]) -> f32 {
    let key = 0;
    let flags = EnchantmentTypeFlags::VITAE.bits();
    get_enchantment_multiplier(enchantments, flags, key)
}

/// Calculates the time remaining until an item's mana is depleted.
/// Returns None if the item does not have mana or is not depleting (rate >= 0).
pub fn calculate_mana_time_left(cur_mana: i32, mana_rate: f64) -> Option<f64> {
    if mana_rate >= 0.0 {
        return None;
    }

    let burn_rate = -mana_rate;
    Some(cur_mana as f64 / burn_rate)
}

pub fn get_enchantment_name(enchant: &Enchantment, spell_names: &HashMap<u32, String>) -> String {
    if let Some(name) = spell_names.get(&(enchant.spell_id as u32)) {
        return name.clone();
    }

    if (enchant.stat_mod_type & EnchantmentTypeFlags::ATTRIBUTE.bits()) != 0 {
        AttributeType::from_repr(enchant.stat_mod_key)
            .map(|a| a.to_string())
            .unwrap_or_else(|| format!("Attr #{}", enchant.stat_mod_key))
    } else if (enchant.stat_mod_type & EnchantmentTypeFlags::SKILL.bits()) != 0 {
        SkillType::from_repr(enchant.stat_mod_key)
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("Skill #{}", enchant.stat_mod_key))
    } else if (enchant.stat_mod_type & EnchantmentTypeFlags::SECOND_ATT.bits()) != 0 {
        match enchant.stat_mod_key {
            1 | 2 => "Max Health".to_string(),
            3 | 4 => "Max Stamina".to_string(),
            5 | 6 => "Max Mana".to_string(),
            _ => format!("Vital #{}", enchant.stat_mod_key),
        }
    } else if (enchant.stat_mod_type & EnchantmentTypeFlags::INT.bits()) != 0 {
        PropertyInt::from_repr(enchant.stat_mod_key)
            .map(|p| p.to_string())
            .unwrap_or_else(|| format!("Int #{}", enchant.stat_mod_key))
    } else if (enchant.stat_mod_type & EnchantmentTypeFlags::FLOAT.bits()) != 0 {
        PropertyFloat::from_repr(enchant.stat_mod_key)
            .map(|p| p.to_string())
            .unwrap_or_else(|| format!("Float #{}", enchant.stat_mod_key))
    } else if (enchant.stat_mod_type & EnchantmentTypeFlags::BODY_ARMOR_VALUE.bits()) != 0 {
        "Armor".to_string()
    } else if (enchant.stat_mod_type & EnchantmentTypeFlags::BODY_DAMAGE_VALUE.bits()) != 0 {
        "Damage".to_string()
    } else if (enchant.stat_mod_type & EnchantmentTypeFlags::BODY_DAMAGE_VARIANCE.bits()) != 0 {
        "Variance".to_string()
    } else if (enchant.stat_mod_type & EnchantmentTypeFlags::VITAE.bits()) != 0 {
        "Vitae".to_string()
    } else {
        format!("Mod #{}", enchant.stat_mod_key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_resist_enchant(
        category: u16,
        power: u32,
        value: f32,
        key: u32,
        start_time: f64,
    ) -> Enchantment {
        Enchantment {
            spell_category: category,
            power_level: power,
            stat_mod_type: EnchantmentTypeFlags::FLOAT.bits()
                | EnchantmentTypeFlags::SINGLE_STAT.bits()
                | EnchantmentTypeFlags::MULTIPLICATIVE.bits(),
            stat_mod_key: key,
            stat_mod_value: value,
            start_time,
            ..Default::default()
        }
    }

    #[test]
    fn test_get_enchantment_name() {
        let mut names = HashMap::new();
        names.insert(1234, "Fire Bolt".to_string());

        let mut enc = Enchantment {
            spell_id: 1234,
            ..Default::default()
        };

        // Test resolved name
        assert_eq!(get_enchantment_name(&enc, &names), "Fire Bolt");

        // Test fallback for known stat (Strength = Attribute 1)
        enc.spell_id = 9999;
        enc.stat_mod_type = EnchantmentTypeFlags::ATTRIBUTE.bits();
        enc.stat_mod_key = 1;
        assert_eq!(get_enchantment_name(&enc, &names), "Strength");

        // Test unknown fallback
        enc.stat_mod_type = 0;
        enc.stat_mod_key = 666;
        assert_eq!(get_enchantment_name(&enc, &names), "Mod #666");
    }

    #[test]
    fn test_calculate_mana_time_left() {
        // 100 mana, burn rate of 1 per second -> 100 seconds
        assert_eq!(calculate_mana_time_left(100, -1.0), Some(100.0));
        // 100 mana, burn rate of 2 per second -> 50 seconds
        assert_eq!(calculate_mana_time_left(100, -2.0), Some(50.0));
        // Positive rate (charging) should return None
        assert_eq!(calculate_mana_time_left(100, 1.0), None);
        // Zero rate should return None
        assert_eq!(calculate_mana_time_left(100, 0.0), None);
        // Zero mana should return 0 seconds
        assert_eq!(calculate_mana_time_left(0, -1.0), Some(0.0));
    }

    #[test]
    fn test_get_enchantment_multiplier_uses_top_layer_per_category() {
        let key = PropertyFloat::ResistSlash as u32;
        let enchantments = vec![
            make_resist_enchant(10, 100, 0.8, key, 5.0), // Winner category 10 (higher power)
            make_resist_enchant(10, 50, 0.7, key, 1.0),  // Loser category 10
            make_resist_enchant(20, 90, 0.9, key, 2.0),  // Winner category 20
        ];

        let multiplier = get_enchantment_multiplier(
            &enchantments,
            EnchantmentTypeFlags::FLOAT.bits() | EnchantmentTypeFlags::SINGLE_STAT.bits(),
            key,
        );
        // 0.8 * 0.9 = 0.72
        assert!((multiplier - 0.72).abs() < 0.0001);
    }

    #[test]
    fn test_get_enchanted_resistance_multiplies_base() {
        let key = PropertyFloat::ResistFire as u32;
        let enchantments = vec![make_resist_enchant(10, 100, 0.6, key, 0.0)];

        let result = get_enchanted_resistance(1.2, &enchantments, key);
        assert!((result - 0.72).abs() < 0.0001);
    }

    #[test]
    fn test_get_player_enchanted_resistance_uses_best_protection_only() {
        let key = PropertyFloat::ResistFire as u32;
        let enchantments = vec![make_resist_enchant(10, 100, 0.6, key, 0.0)];

        let result = get_player_enchanted_resistance(1.0, &enchantments, key, 150, 100, 0);

        assert!((result - 0.6).abs() < 0.0001);
    }

    #[test]
    fn test_get_player_enchanted_resistance_prefers_natural_resistance_and_ignores_additive() {
        let key = PropertyFloat::ResistFire as u32;
        let enchantments = vec![
            make_resist_enchant(10, 100, 0.8, key, 0.0),
            make_resist_enchant(20, 100, 1.2, key, 0.0),
            Enchantment {
                spell_category: 30,
                power_level: 100,
                stat_mod_type: EnchantmentTypeFlags::FLOAT.bits()
                    | EnchantmentTypeFlags::SINGLE_STAT.bits()
                    | EnchantmentTypeFlags::ADDITIVE.bits(),
                stat_mod_key: key,
                stat_mod_value: 0.67,
                ..Default::default()
            },
        ];

        let result = get_player_enchanted_resistance(1.0, &enchantments, key, 200, 200, 1);

        assert!((result - 0.72).abs() < 0.0001);
    }

    #[test]
    fn test_get_player_enchanted_resistance_nether_uses_innate_half_resistance() {
        let key = PropertyFloat::ResistNether as u32;

        let result = get_player_enchanted_resistance(1.0, &[], key, 10, 10, 0);

        assert!((result - 0.5).abs() < 0.0001);
    }

    #[test]
    fn test_get_enchanted_armor_ignores_key_for_body_armor_value() {
        let enchantments = vec![Enchantment {
            spell_category: 115,
            power_level: 400,
            stat_mod_type: (EnchantmentTypeFlags::BODY_ARMOR_VALUE
                | EnchantmentTypeFlags::MULTIPLE_STAT
                | EnchantmentTypeFlags::ADDITIVE
                | EnchantmentTypeFlags::BENEFICIAL)
                .bits(),
            stat_mod_key: 0, // Key is ignored
            stat_mod_value: 250.0,
            ..Default::default()
        }];

        // Base 0 + 250 add = 250
        assert_eq!(get_enchanted_armor(0, &enchantments), 250);

        // Base 100 + 250 add = 350
        assert_eq!(get_enchanted_armor(100, &enchantments), 350);
    }

    /// Rust review 2026-08-03 — ACE's top-layer tiebreak has THREE keys, and
    /// the middle one was missing here.
    ///
    /// AUTHORITY: `ACE.Entity/Models/PropertiesEnchantmentRegistryExtensions.cs`
    /// — all three `GetEnchantmentsTopLayer*` overloads (`:153-155`, `:180-182`,
    /// `:223-227`) sort
    ///     `OrderByDescending(PowerLevel)`
    ///     `.ThenByDescending(Level8AuraSelfSpells.Contains(SpellId))`
    ///     `.ThenByDescending(setSpells.Contains(SpellId) ? SpellId : StartTime)`
    /// with `Level8AuraSelfSpells` defined at `:131-139` and commented "this
    /// ensures level 8 item self spells always take precedence over level 8
    /// item other spells".
    ///
    /// Concrete break: two same-category, same-power level-8 auras on a wielded
    /// item — BloodDrinkerSelf8 (4395) and a BloodDrinker "other" aura. Without
    /// the middle key, whichever was cast LAST wins, so the derived stat
    /// flip-flops with cast order instead of pinning to the self spell.
    #[test]
    fn level_8_aura_self_wins_the_power_tie() {
        let key = crate::stats::SkillType::MeleeDefense as u32;
        let flags = (EnchantmentTypeFlags::SKILL | EnchantmentTypeFlags::ADDITIVE).bits();

        let self8 = Enchantment {
            spell_id: 4395, // BloodDrinkerSelf8
            spell_category: 77,
            power_level: 400,
            start_time: 0.0, // cast FIRST
            stat_mod_type: flags,
            stat_mod_key: key,
            stat_mod_value: 10.0,
            ..Default::default()
        };
        let other8 = Enchantment {
            spell_id: 4394, // a same-category level-8 "other" aura
            spell_category: 77,
            power_level: 400,
            start_time: 100.0, // cast LATER — wins on start_time alone
            stat_mod_type: flags,
            stat_mod_key: key,
            stat_mod_value: 99.0,
            ..Default::default()
        };

        // Both orderings must resolve to the SELF spell.
        assert_eq!(
            get_enchantment_additive(&[self8.clone(), other8.clone()], flags, key),
            10.0
        );
        assert_eq!(
            get_enchantment_additive(&[other8.clone(), self8.clone()], flags, key),
            10.0
        );

        // NEGATIVE CONTROL 1: power still outranks the level-8-self key, so a
        // "always prefer the self spell" fix would be wrong.
        let stronger_other = Enchantment {
            power_level: 500,
            ..other8.clone()
        };
        assert_eq!(
            get_enchantment_additive(&[self8.clone(), stronger_other], flags, key),
            99.0,
            "PowerLevel is still the FIRST key"
        );

        // NEGATIVE CONTROL 2: between two NON-level-8-self spells the old
        // start_time rule must still decide.
        let early = Enchantment {
            spell_id: 4390,
            start_time: 0.0,
            stat_mod_value: 1.0,
            ..other8.clone()
        };
        let late = Enchantment {
            spell_id: 4391,
            start_time: 50.0,
            stat_mod_value: 2.0,
            ..other8.clone()
        };
        assert_eq!(get_enchantment_additive(&[early, late], flags, key), 2.0);
    }
}
