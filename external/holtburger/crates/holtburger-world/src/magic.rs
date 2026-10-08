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

/// enchstats-5 (2026-10-08) — the default "absolute start time" key for
/// callers that hold no receive-time stamps (item enchantments, tests): the
/// raw wire `start_time`. The local player passes
/// [`crate::player::PlayerState::abs_start_time`] instead, which rebases the
/// wire value onto the receive clock like retail `Enchantment::UnPack`
/// (acclient.c:502627: `_start_time = Timer::cur_time + _start_time`).
pub fn wire_start_time(enchantment: &Enchantment) -> f64 {
    enchantment.start_time
}

fn is_higher_priority_enchantment(
    current: &Enchantment,
    challenger: &Enchantment,
    abs_start: &dyn Fn(&Enchantment) -> f64,
) -> bool {
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
        // enchstats-5 (2026-10-08) — retail `Enchantment::Duel`
        // (acclient.c:502375): the incumbent survives an equal-power duel
        // only when the challenger is STRICTLY older
        // (`challenger->_start_time < this->_start_time`), so an exact tie
        // goes to the CHALLENGER (`>=`). The times compared are ABSOLUTE
        // (rebased at receipt, `Enchantment::UnPack` :502627) — two layers
        // cast in separate `MagicUpdateEnchantment` events both carry a wire
        // `start_time` of ~0, and only the receive-time rebase tells the
        // newer one apart.
        abs_start(challenger) >= abs_start(current)
    }
}

/// Retail `Enchantment::AffectsAttackSkills` (acclient.c:502467): the skill
/// keys an `ATTACK_SKILLS` (0x10000) enchantment reaches — Life/War Magic,
/// Two Handed, Void, Heavy/Light/Finesse, Missile Weapons, Dual Wield.
const ATTACK_SKILL_KEYS: [u32; 9] = [0x21, 0x22, 0x29, 0x2B, 0x2C, 0x2D, 0x2E, 0x2F, 0x31];

/// Retail `Enchantment::AffectsDefenseSkills` (acclient.c:502499): the skill
/// keys a `DEFENSE_SKILLS` (0x20000) enchantment reaches — Melee/Missile/Magic
/// Defense and Shield.
const DEFENSE_SKILL_KEYS: [u32; 4] = [0x06, 0x07, 0x0F, 0x30];

/// enchstats-1 (2026-10-08) — retail `CEnchantmentRegistry::CullEnchantmentsFromList`
/// (acclient.c:445810) key predicate for the attribute / vital / skill
/// families (`EnchantAttribute` :445870 type 1, `EnchantAttribute2nd`
/// :445921 type 2, `EnchantSkill` :445984 type 0x10):
///
/// ```text
/// v8 & type && (BYTE1(v8) & 0x20 /*MultipleStat*/ || key == key
///              || AffectsAttackSkills(key) || AffectsDefenseSkills(key))
/// ```
///
/// So a key-0 `MULTIPLE_STAT` enchantment ("Cloaked in Skill" +20 all skills,
/// the Society blessings, Mucor Blight …) reaches EVERY key of its family,
/// and the Dirty Fighting assaults reach the whole attack / defense family
/// rather than only the key in the record.
///
/// Vitae and cooldowns never match: retail keeps them out of the mult/add
/// lists entirely (`CEnchantmentRegistry::_vitae` / `_cooldown_list`, see
/// `RemoveEnchantment`). Vitae carries `SECOND_ATT|SKILL|MULTIPLE_STAT|MULT`
/// (spell 666 = 0xA06012), so without this exclusion the wildcard would
/// apply it a second time on top of the explicit vitae step in
/// `stats_calc.rs`.
fn stat_family_matches(enchantment: &Enchantment, family: u32, key: u32) -> bool {
    let t = enchantment.stat_mod_type;
    if t & (EnchantmentTypeFlags::VITAE.bits() | EnchantmentTypeFlags::COOLDOWN.bits()) != 0 {
        return false;
    }
    if t & EnchantmentTypeFlags::MULTIPLE_STAT.bits() != 0 || enchantment.stat_mod_key == key {
        return true;
    }
    if family & EnchantmentTypeFlags::SKILL.bits() != 0 {
        if t & EnchantmentTypeFlags::ATTACK_SKILLS.bits() != 0 && ATTACK_SKILL_KEYS.contains(&key) {
            return true;
        }
        if t & EnchantmentTypeFlags::DEFENSE_SKILLS.bits() != 0 && DEFENSE_SKILL_KEYS.contains(&key)
        {
            return true;
        }
    }
    false
}

/// How a query's `stat_mod_key` selects enchantments.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyMatch {
    /// Body armor / damage / variance and vitae: the key is ignored.
    Keyless,
    /// INT / FLOAT properties (resistances): the key must match exactly.
    Exact,
    /// Attribute / vital / skill families: retail's cull predicate,
    /// [`stat_family_matches`]. The payload is the family bits.
    StatFamily(u32),
}

fn key_match_for(stat_mod_type: u32) -> KeyMatch {
    let keyless = EnchantmentTypeFlags::BODY_ARMOR_VALUE.bits()
        | EnchantmentTypeFlags::BODY_DAMAGE_VALUE.bits()
        | EnchantmentTypeFlags::BODY_DAMAGE_VARIANCE.bits()
        | EnchantmentTypeFlags::VITAE.bits();
    let family_bits = EnchantmentTypeFlags::ATTRIBUTE.bits()
        | EnchantmentTypeFlags::SECOND_ATT.bits()
        | EnchantmentTypeFlags::SKILL.bits();
    let property_bits = EnchantmentTypeFlags::INT.bits() | EnchantmentTypeFlags::FLOAT.bits();
    if stat_mod_type & keyless != 0 {
        KeyMatch::Keyless
    } else if stat_mod_type & family_bits != 0 && stat_mod_type & property_bits == 0 {
        KeyMatch::StatFamily(stat_mod_type & family_bits)
    } else {
        KeyMatch::Exact
    }
}

fn get_top_enchantments<'a>(
    enchantments: &'a [Enchantment],
    required_flags: u32,
    stat_mod_key: u32,
    key_match: KeyMatch,
    abs_start: &dyn Fn(&Enchantment) -> f64,
) -> Vec<&'a Enchantment> {
    let mut top_by_category: HashMap<u16, &'a Enchantment> = HashMap::new();

    for enchantment in enchantments {
        if (enchantment.stat_mod_type & required_flags) != required_flags {
            continue;
        }
        let key_ok = match key_match {
            KeyMatch::Keyless => true,
            KeyMatch::Exact => enchantment.stat_mod_key == stat_mod_key,
            KeyMatch::StatFamily(family) => stat_family_matches(enchantment, family, stat_mod_key),
        };
        if !key_ok {
            continue;
        }

        top_by_category
            .entry(enchantment.spell_category)
            .and_modify(|current| {
                if is_higher_priority_enchantment(current, enchantment, abs_start) {
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
    get_enchantment_multiplier_with_start(
        enchantments,
        stat_mod_type,
        stat_mod_key,
        &wire_start_time,
    )
}

/// [`get_enchantment_multiplier`] with an explicit absolute-start-time key
/// for the same-power duel (enchstats-5; see [`wire_start_time`]).
pub fn get_enchantment_multiplier_with_start(
    enchantments: &[Enchantment],
    stat_mod_type: u32,
    stat_mod_key: u32,
    abs_start: &dyn Fn(&Enchantment) -> f64,
) -> f32 {
    let required_flags = stat_mod_type | EnchantmentTypeFlags::MULTIPLICATIVE.bits();

    get_top_enchantments(
        enchantments,
        required_flags,
        stat_mod_key,
        key_match_for(stat_mod_type),
        abs_start,
    )
    .into_iter()
    .fold(1.0f32, |acc, enchantment| acc * enchantment.stat_mod_value)
}

pub fn get_enchantment_additive(
    enchantments: &[Enchantment],
    stat_mod_type: u32,
    stat_mod_key: u32,
) -> f32 {
    get_enchantment_additive_with_start(enchantments, stat_mod_type, stat_mod_key, &wire_start_time)
}

/// [`get_enchantment_additive`] with an explicit absolute-start-time key for
/// the same-power duel (enchstats-5; see [`wire_start_time`]).
pub fn get_enchantment_additive_with_start(
    enchantments: &[Enchantment],
    stat_mod_type: u32,
    stat_mod_key: u32,
    abs_start: &dyn Fn(&Enchantment) -> f64,
) -> f32 {
    let required_flags = stat_mod_type | EnchantmentTypeFlags::ADDITIVE.bits();

    get_top_enchantments(
        enchantments,
        required_flags,
        stat_mod_key,
        key_match_for(stat_mod_type),
        abs_start,
    )
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
    let top_enchantments = get_top_enchantments(
        enchantments,
        required_flags,
        resistance_key,
        KeyMatch::Exact,
        &wire_start_time,
    );

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

    // ---------------------------------------------------------------------
    // enchstats-1 (2026-10-08) — retail `CullEnchantmentsFromList`
    // (acclient.c:445810). Spell type/key/value from the LSD spell dump.
    // ---------------------------------------------------------------------

    fn stat_enchant(category: u16, stat_mod_type: u32, key: u32, value: f32) -> Enchantment {
        Enchantment {
            spell_id: category,
            spell_category: category,
            power_level: 100,
            stat_mod_type,
            stat_mod_key: key,
            stat_mod_value: value,
            ..Default::default()
        }
    }

    const SKILL_FAMILY: u32 = EnchantmentTypeFlags::SKILL.bits();
    const ATTRIBUTE_FAMILY: u32 = EnchantmentTypeFlags::ATTRIBUTE.bits();
    const VITAL_FAMILY: u32 = EnchantmentTypeFlags::SECOND_ATT.bits();

    /// Spell 5753 "Cloaked in Skill": 0x0200A010 (Beneficial | Additive |
    /// MultipleStat | Skill), key 0, +20 — "Increases all of the target's
    /// skills by 20".
    #[test]
    fn multiple_stat_skill_buff_applies_to_every_skill() {
        let e = [stat_enchant(1, 0x0200_A010, 0, 20.0)];
        assert_eq!(
            get_enchantment_additive(&e, SKILL_FAMILY, SkillType::Run as u32),
            20.0
        );
        assert_eq!(
            get_enchantment_additive(&e, SKILL_FAMILY, SkillType::WarMagic as u32),
            20.0
        );
        assert_eq!(
            get_enchantment_additive(&e, SKILL_FAMILY, SkillType::MeleeDefense as u32),
            20.0
        );
        // The wildcard never leaks across families.
        assert_eq!(get_enchantment_additive(&e, ATTRIBUTE_FAMILY, 1), 0.0);
        assert_eq!(get_enchantment_additive(&e, VITAL_FAMILY, 1), 0.0);
    }

    /// Spell 4904 "Society Master's Blessing": 0xA001 (Additive |
    /// MultipleStat | Attribute), key 0, +15 — "Increases all attributes by 15".
    #[test]
    fn society_blessing_all_attributes() {
        let e = [stat_enchant(2, 0xA001, 0, 15.0)];
        for key in 1..=6 {
            assert_eq!(
                get_enchantment_additive(&e, ATTRIBUTE_FAMILY, key),
                15.0,
                "attr {key}"
            );
        }
        assert_eq!(get_enchantment_additive(&e, VITAL_FAMILY, 1), 0.0);
        assert_eq!(get_enchantment_additive(&e, SKILL_FAMILY, 24), 0.0);
    }

    /// "Blight of the Swamp"-shaped vital debuff: 0x6002 (Multiplicative |
    /// MultipleStat | SecondAtt), key 0, x0.6 — every max vital.
    #[test]
    fn multiple_stat_vital_debuff() {
        let e = [stat_enchant(3, 0x6002, 0, 0.6)];
        for key in [1, 3, 5] {
            let m = get_enchantment_multiplier(&e, VITAL_FAMILY, key);
            assert!((m - 0.6).abs() < 1e-6, "vital {key}: {m}");
        }
        assert_eq!(get_enchantment_multiplier(&e, SKILL_FAMILY, 24), 1.0);
    }

    /// Spell 666 Vitae: 0xA06012 (Vitae | AdditiveDegrade | Multiplicative |
    /// MultipleStat | Skill | SecondAtt), key 0. Retail keeps it in
    /// `CEnchantmentRegistry::_vitae`, never in the culled lists, so the
    /// MultipleStat wildcard must NOT pick it up (stats_calc applies it once,
    /// explicitly).
    #[test]
    fn vitae_not_matched_by_wildcard() {
        let e = [stat_enchant(204, 0x00A0_6012, 0, 0.95)];
        assert_eq!(get_enchantment_multiplier(&e, SKILL_FAMILY, 24), 1.0);
        assert_eq!(get_enchantment_multiplier(&e, VITAL_FAMILY, 1), 1.0);
        assert!((get_total_vitae(&e) - 0.95).abs() < 1e-6);
    }

    /// Spell 5938 "Blinding Assault": 0x18010 (AttackSkills | Additive |
    /// Skill), key 45, -20 — "all of the target's attack skills"
    /// (`Enchantment::AffectsAttackSkills`, acclient.c:502467).
    #[test]
    fn blinding_assault_attack_family() {
        let e = [stat_enchant(4, 0x1_8010, 45, -20.0)];
        for key in [33, 34, 41, 43, 44, 45, 46, 47, 49] {
            assert_eq!(
                get_enchantment_additive(&e, SKILL_FAMILY, key),
                -20.0,
                "skill {key}"
            );
        }
        assert_eq!(
            get_enchantment_additive(&e, SKILL_FAMILY, 24),
            0.0,
            "Run untouched"
        );
        assert_eq!(
            get_enchantment_additive(&e, SKILL_FAMILY, 6),
            0.0,
            "defense untouched"
        );
    }

    /// Spell 5940 "Unbalancing Assault": 0x28010 (DefenseSkills | Additive |
    /// Skill), key 15, -20 (`Enchantment::AffectsDefenseSkills`, :502499).
    #[test]
    fn unbalancing_assault_defense_family() {
        let e = [stat_enchant(5, 0x2_8010, 15, -20.0)];
        for key in [6, 7, 15, 48] {
            assert_eq!(
                get_enchantment_additive(&e, SKILL_FAMILY, key),
                -20.0,
                "skill {key}"
            );
        }
        assert_eq!(get_enchantment_additive(&e, SKILL_FAMILY, 45), 0.0);
    }

    // ---------------------------------------------------------------------
    // enchstats-5 (2026-10-08) — retail `Enchantment::Duel` (acclient.c:502375)
    // on receive-time-rebased start times (`Enchantment::UnPack` :502627).
    // ---------------------------------------------------------------------

    fn same_power_pair() -> (Enchantment, Enchantment, u32, u32) {
        let flags = (EnchantmentTypeFlags::SKILL | EnchantmentTypeFlags::ADDITIVE).bits();
        let key = SkillType::Run as u32;
        let a = Enchantment {
            spell_id: 100,
            layer: 1,
            spell_category: 9,
            power_level: 100,
            start_time: 0.0,
            stat_mod_type: flags,
            stat_mod_key: key,
            stat_mod_value: 1.0,
            ..Default::default()
        };
        let b = Enchantment {
            spell_id: 101,
            stat_mod_value: 2.0,
            ..a
        };
        (a, b, flags, key)
    }

    /// Two same-category, same-power layers delivered in SEPARATE
    /// `MagicUpdateEnchantment` events both carry wire start_time 0; only the
    /// receive-time rebase says which is newer, and retail keeps the newer.
    #[test]
    fn duel_newer_same_power_wins_across_separate_updates() {
        let (a, b, flags, key) = same_power_pair();
        let a_then_b = |e: &Enchantment| if e.spell_id == 100 { 10.0 } else { 20.0 };
        assert_eq!(
            get_enchantment_additive_with_start(&[a, b], flags, key, &a_then_b),
            2.0
        );
        assert_eq!(
            get_enchantment_additive_with_start(&[b, a], flags, key, &a_then_b),
            2.0,
            "Vec order must not matter once the times differ"
        );
        let b_then_a = |e: &Enchantment| if e.spell_id == 100 { 20.0 } else { 10.0 };
        assert_eq!(
            get_enchantment_additive_with_start(&[a, b], flags, key, &b_then_a),
            1.0
        );

        // An exact tie goes to the CHALLENGER (the later list entry).
        let tie = |_: &Enchantment| 5.0;
        assert_eq!(
            get_enchantment_additive_with_start(&[a, b], flags, key, &tie),
            2.0
        );
        assert_eq!(
            get_enchantment_additive_with_start(&[b, a], flags, key, &tie),
            1.0
        );
    }

    /// `upsert_enchantment` refreshes an existing (spell, layer) IN PLACE, so
    /// a re-cast layer keeps its early Vec slot. Its rebased time (100) must
    /// still beat a layer that arrived at 50 — a bare `>=` on the wire value
    /// (both 0) would wrongly pick the later Vec entry.
    #[test]
    fn refreshed_in_place_layer_wins() {
        let (a, b, flags, key) = same_power_pair();
        let abs = |e: &Enchantment| if e.spell_id == 100 { 100.0 } else { 50.0 };
        assert_eq!(
            get_enchantment_additive_with_start(&[a, b], flags, key, &abs),
            1.0
        );
    }
}
