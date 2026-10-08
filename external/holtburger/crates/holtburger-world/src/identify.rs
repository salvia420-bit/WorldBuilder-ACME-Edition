use holtburger_common::properties::WorldObjectProperties;
use holtburger_protocol::messages::object::events::{
    IdentifyObjectResponseEventData, IdentifyResponseFlags,
};
use holtburger_protocol::messages::object::types::{
    ArmorLevels, ArmorProfile, CreatureProfile, HookProfile, WeaponProfile,
};

pub(crate) struct IdentifyTarget<'a> {
    pub properties: &'a mut WorldObjectProperties,
    pub armor_profile: &'a mut Option<ArmorProfile>,
    pub creature_profile: &'a mut Option<CreatureProfile>,
    pub weapon_profile: &'a mut Option<WeaponProfile>,
    pub hook_profile: &'a mut Option<HookProfile>,
    pub armor_levels: &'a mut Option<ArmorLevels>,
    pub spell_book: &'a mut Vec<u32>,
    pub armor_highlight: &'a mut Option<u16>,
    pub armor_color: &'a mut Option<u16>,
    pub weapon_highlight: &'a mut Option<u16>,
    pub weapon_color: &'a mut Option<u16>,
    pub resist_highlight: &'a mut Option<u16>,
    pub resist_color: &'a mut Option<u16>,
}

pub(crate) fn apply_identify_response(
    target: IdentifyTarget<'_>,
    data: &IdentifyObjectResponseEventData,
) -> bool {
    let IdentifyTarget {
        properties,
        armor_profile,
        creature_profile,
        weapon_profile,
        hook_profile,
        armor_levels,
        spell_book,
        armor_highlight,
        armor_color,
        weapon_highlight,
        weapon_color,
        resist_highlight,
        resist_color,
    } = target;

    if !data.success {
        return false;
    }

    let flags = data.flags;

    properties.merge(data.properties.clone());

    if flags.contains(IdentifyResponseFlags::ARMOR_PROFILE) {
        *armor_profile = data.armor_profile.clone();
    }
    if flags.contains(IdentifyResponseFlags::CREATURE_PROFILE) {
        *creature_profile = data.creature_profile.clone();
    }
    if flags.contains(IdentifyResponseFlags::WEAPON_PROFILE) {
        *weapon_profile = data.weapon_profile.clone();
    }
    if flags.contains(IdentifyResponseFlags::HOOK_PROFILE) {
        *hook_profile = data.hook_profile.clone();
    }
    if flags.contains(IdentifyResponseFlags::ARMOR_LEVELS) {
        *armor_levels = data.armor_levels.clone();
    }
    if flags.contains(IdentifyResponseFlags::SPELL_BOOK) {
        *spell_book = data.spell_book.clone();
    }

    if flags.contains(IdentifyResponseFlags::ARMOR_ENCHANTMENT_BITFIELD) {
        *armor_highlight = data.armor_highlight;
        *armor_color = data.armor_color;
    }
    if flags.contains(IdentifyResponseFlags::WEAPON_ENCHANTMENT_BITFIELD) {
        *weapon_highlight = data.weapon_highlight;
        *weapon_color = data.weapon_color;
    }
    if flags.contains(IdentifyResponseFlags::RESIST_ENCHANTMENT_BITFIELD) {
        *resist_highlight = data.resist_highlight;
        *resist_color = data.resist_color;
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::Guid;
    use holtburger_protocol::messages::object::types::{CreatureAttributes, CreatureProfileFlags};

    fn creature_profile(health: u32, health_max: u32, strength: Option<u32>) -> CreatureProfile {
        CreatureProfile {
            flags: if strength.is_some() {
                CreatureProfileFlags::SHOW_ATTRIBUTES
            } else {
                CreatureProfileFlags::empty()
            },
            health,
            health_max,
            attributes: strength.map(|strength| CreatureAttributes {
                strength,
                endurance: 0,
                quickness: 0,
                coordination: 0,
                focus: 0,
                self_attr: 0,
                stamina: 0,
                mana: 0,
                stamina_max: 0,
                mana_max: 0,
            }),
            buffs: None,
        }
    }

    fn response(success: bool, profile: CreatureProfile) -> IdentifyObjectResponseEventData {
        IdentifyObjectResponseEventData {
            object_guid: Guid(0x8000_0042),
            flags: IdentifyResponseFlags::CREATURE_PROFILE,
            success,
            properties: WorldObjectProperties::default(),
            spell_book: Vec::new(),
            armor_profile: None,
            creature_profile: Some(profile),
            weapon_profile: None,
            hook_profile: None,
            armor_highlight: None,
            armor_color: None,
            weapon_highlight: None,
            weapon_color: None,
            resist_highlight: None,
            resist_color: None,
            armor_levels: None,
        }
    }

    /// enchstats-4 (2026-10-08): a FAILED assess carries an attribute-less
    /// creature profile (ACE `CreatureProfile(creature, success = false)`).
    /// It must not wipe the profile a successful assess merged earlier — the
    /// wasm layer ships it separately as `failedCreatureProfile` for retail's
    /// degraded view instead.
    #[test]
    fn failed_identify_keeps_merged_creature_profile() {
        let mut properties = WorldObjectProperties::default();
        let mut armor_profile = None;
        let mut creature = None;
        let mut weapon_profile = None;
        let mut hook_profile = None;
        let mut armor_levels = None;
        let mut spell_book = Vec::new();
        let (mut ah, mut ac, mut wh, mut wc, mut rh, mut rc) = (None, None, None, None, None, None);
        macro_rules! target {
            () => {
                IdentifyTarget {
                    properties: &mut properties,
                    armor_profile: &mut armor_profile,
                    creature_profile: &mut creature,
                    weapon_profile: &mut weapon_profile,
                    hook_profile: &mut hook_profile,
                    armor_levels: &mut armor_levels,
                    spell_book: &mut spell_book,
                    armor_highlight: &mut ah,
                    armor_color: &mut ac,
                    weapon_highlight: &mut wh,
                    weapon_color: &mut wc,
                    resist_highlight: &mut rh,
                    resist_color: &mut rc,
                }
            };
        }

        assert!(apply_identify_response(
            target!(),
            &response(true, creature_profile(70, 70, Some(55)))
        ));
        assert_eq!(creature.as_ref().map(|p| p.health), Some(70));

        assert!(!apply_identify_response(
            target!(),
            &response(false, creature_profile(4, 7, None))
        ));
        let kept = creature.as_ref().expect("merged profile survives");
        assert_eq!((kept.health, kept.health_max), (70, 70));
        assert_eq!(kept.attributes.as_ref().map(|a| a.strength), Some(55));
    }
}
