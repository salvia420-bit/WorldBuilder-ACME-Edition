use super::*;
use crate::WorldEvent;
use crate::WorldState;
use crate::entity::{Entity, EntityMotionDirective, EntityMotionSnapshot, OrderedMotionSpeed};
use holtburger_common::position::WorldPosition;
use holtburger_common::properties::{
    EnchantmentTypeFlags, PropertyFloat, PropertyInt, WorldObjectPropertyAccessorsMut,
};
use holtburger_common::{CharacterOption, CharacterOptions1, CharacterOptions2};
use holtburger_protocol::messages::movement::VectorUpdateData;
use holtburger_protocol::messages::movement::{InterpretedMotionCommand, MotionStance};
use holtburger_protocol::messages::{
    GameMessage, InterpretedMotionState, MovementEventData, MovementInvalid, MovementStateFlags,
    MovementType, MovementTypeData,
};

fn set_attr(player: &mut PlayerState, attr: stats::AttributeType, val: u32) {
    player.attributes.insert(
        attr,
        stats::Attribute {
            attr_type: attr,
            ranks: 0,
            start: val,
            spent_xp: 0,
            next_rank_xp: None,
            base: val,
            current: val,
        },
    );
}

#[test]
fn test_stat_calculations() {
    let mut player = PlayerState::new();

    // Setup attributes
    set_attr(&mut player, stats::AttributeType::StrengthAttr, 100);
    set_attr(&mut player, stats::AttributeType::EnduranceAttr, 100);
    set_attr(&mut player, stats::AttributeType::QuicknessAttr, 100);
    set_attr(&mut player, stats::AttributeType::CoordinationAttr, 100);
    set_attr(&mut player, stats::AttributeType::FocusAttr, 100);
    set_attr(&mut player, stats::AttributeType::SelfAttr, 100);

    // Test Vital Bonuses
    assert_eq!(
        player.calculate_vital_attribute_contribution(stats::VitalType::Health, false),
        50
    );
    assert_eq!(
        player.calculate_vital_attribute_contribution(stats::VitalType::Stamina, false),
        100
    );
    assert_eq!(
        player.calculate_vital_attribute_contribution(stats::VitalType::Mana, false),
        100
    );

    // Test Vital Base Calculation
    player.vital_bases.insert(
        stats::VitalType::Health,
        VitalBase {
            ranks: 50,
            start: 0,
        },
    );
    assert_eq!(player.calculate_vital_base(stats::VitalType::Health), 100);

    // Test Skill Math
    assert_eq!(
        player.derive_skill_value(stats::SkillType::MeleeDefense, 10, 4, false),
        81
    );
    assert_eq!(
        player.derive_skill_value(stats::SkillType::Run, 5, 0, false),
        105
    );
}

#[test]
fn test_resistance_derivation_matches_ace_player_rules() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000001);
    state.seed_local_player_entity(player_guid, "Player", WorldPosition::default());

    set_attr(&mut state.player, stats::AttributeType::StrengthAttr, 200);
    set_attr(&mut state.player, stats::AttributeType::EnduranceAttr, 200);
    state
        .player_entity_mut()
        .expect("local player entity should exist")
        .properties
        .set_float_prop(PropertyFloat::ResistFire, 1.0);
    state
        .player_entity_mut()
        .expect("local player entity should exist")
        .properties
        .set_int_prop(PropertyInt::AugmentationResistanceFire, 1);

    state.player.enchantments.push(Enchantment {
        spell_category: 10,
        power_level: 100,
        stat_mod_type: (EnchantmentTypeFlags::FLOAT
            | EnchantmentTypeFlags::SINGLE_STAT
            | EnchantmentTypeFlags::MULTIPLICATIVE)
            .bits(),
        stat_mod_key: PropertyFloat::ResistFire as u32,
        stat_mod_value: 0.8,
        ..Default::default()
    });

    state.player.enchantments.push(Enchantment {
        spell_category: 20,
        power_level: 100,
        stat_mod_type: (EnchantmentTypeFlags::FLOAT
            | EnchantmentTypeFlags::SINGLE_STAT
            | EnchantmentTypeFlags::MULTIPLICATIVE)
            .bits(),
        stat_mod_key: PropertyFloat::ResistFire as u32,
        stat_mod_value: 1.2,
        ..Default::default()
    });

    state.player.enchantments.push(Enchantment {
        spell_category: 30,
        power_level: 100,
        stat_mod_type: (EnchantmentTypeFlags::FLOAT
            | EnchantmentTypeFlags::SINGLE_STAT
            | EnchantmentTypeFlags::ADDITIVE)
            .bits(),
        stat_mod_key: PropertyFloat::ResistFire as u32,
        stat_mod_value: 0.67,
        ..Default::default()
    });

    let resistance = state.player_resistance_current(PropertyFloat::ResistFire);

    assert!((resistance - 0.72).abs() < 0.0001);
}

#[test]
fn test_character_option_helpers_read_and_update_both_masks() {
    let mut player = PlayerState::new();

    // Both options are OFF in retail's PlayerModule defaults (charopt-6
    // seeds options1/options2 with CharacterOptions1/2::DEFAULT).
    assert!(!player.character_option_enabled(CharacterOption::UseCraftingChanceOfSuccessDialog,));
    assert!(!player.character_option_enabled(CharacterOption::AllowOthersToSeeYourDateOfBirth));

    player.set_character_option_enabled(CharacterOption::UseCraftingChanceOfSuccessDialog, true);
    player.set_character_option_enabled(CharacterOption::AllowOthersToSeeYourDateOfBirth, true);

    assert!(player.character_option_enabled(CharacterOption::UseCraftingChanceOfSuccessDialog,));
    assert!(player.character_option_enabled(CharacterOption::AllowOthersToSeeYourDateOfBirth));
    assert!(
        player
            .options1
            .contains(CharacterOptions1::USE_CRAFT_SUCCESS_DIALOG)
    );
    assert!(
        player
            .options2
            .contains(CharacterOptions2::DISPLAY_DATE_OF_BIRTH)
    );

    player.set_character_option_enabled(CharacterOption::UseCraftingChanceOfSuccessDialog, false);

    assert!(!player.character_option_enabled(CharacterOption::UseCraftingChanceOfSuccessDialog,));
    assert!(
        !player
            .options1
            .contains(CharacterOptions1::USE_CRAFT_SUCCESS_DIALOG)
    );
    assert!(
        player
            .options2
            .contains(CharacterOptions2::DISPLAY_DATE_OF_BIRTH)
    );
}

#[test]
fn test_character_option_new_player_uses_retail_player_module_defaults() {
    // charopt-6: retail PlayerModule::PlayerModule — options_ = 0x50C4A54A,
    // options2_ = 0x948700, spell_filters_ = 0x3FFF.
    let player = PlayerState::new();
    assert_eq!(player.options1.bits(), 0x50C4_A54A);
    assert_eq!(player.options2.bits(), 0x0094_8700);
    assert_eq!(player.spellbook_filters, 0x3FFF);
    assert!(player.character_option_enabled(CharacterOption::RunAsDefaultMovement));
    assert!(player.character_option_enabled(CharacterOption::ListenToGeneralChat));
    assert!(player.character_option_enabled(CharacterOption::AutoTarget));
    assert!(player.character_option_enabled(CharacterOption::IgnoreFellowshipRequests));
    assert!(player.character_option_enabled(CharacterOption::ShowYourHelmOrHeadGear));
    assert!(!player.character_option_enabled(CharacterOption::AutomaticallyAcceptFellowshipRequests));
}

#[test]
fn test_character_option_apply_fellowship_exclusion() {
    // charopt-1: CPlayerModule::OnChanged — enabling AutoAccept on a default
    // character (Ignore ON) clears Ignore first, then sets AutoAccept.
    let mut p = PlayerState::new();
    p.options1 = CharacterOptions1::DEFAULT;
    let sends = p.apply_character_option(CharacterOption::AutomaticallyAcceptFellowshipRequests, true);
    assert_eq!(
        sends,
        vec![
            (CharacterOption::IgnoreFellowshipRequests, false),
            (CharacterOption::AutomaticallyAcceptFellowshipRequests, true),
        ]
    );
    assert_eq!(p.options1.bits() & 0x0000_0008, 0, "Ignore bit cleared");
    assert_ne!(p.options1.bits() & 0x2000_0000, 0, "AutoAccept bit set");

    // Symmetric: enabling Ignore while AutoAccept is on clears AutoAccept.
    let sends = p.apply_character_option(CharacterOption::IgnoreFellowshipRequests, true);
    assert_eq!(
        sends,
        vec![
            (CharacterOption::AutomaticallyAcceptFellowshipRequests, false),
            (CharacterOption::IgnoreFellowshipRequests, true),
        ]
    );
    assert_ne!(p.options1.bits() & 0x0000_0008, 0);
    assert_eq!(p.options1.bits() & 0x2000_0000, 0);

    // Pair already off → only the primary is sent.
    p.options1 = CharacterOptions1::empty();
    let sends = p.apply_character_option(CharacterOption::AutomaticallyAcceptFellowshipRequests, true);
    assert_eq!(
        sends,
        vec![(CharacterOption::AutomaticallyAcceptFellowshipRequests, true)]
    );

    // Disabling never touches the pair.
    p.options1 = CharacterOptions1::IGNORE_FELLOWSHIP_REQUESTS
        | CharacterOptions1::AUTO_ACCEPT_FELLOW_REQUEST;
    let sends = p.apply_character_option(CharacterOption::IgnoreFellowshipRequests, false);
    assert_eq!(sends, vec![(CharacterOption::IgnoreFellowshipRequests, false)]);
    assert!(p.options1.contains(CharacterOptions1::AUTO_ACCEPT_FELLOW_REQUEST));

    // Unrelated options are a single send.
    let sends = p.apply_character_option(CharacterOption::AutoTarget, false);
    assert_eq!(sends, vec![(CharacterOption::AutoTarget, false)]);
    assert!(!p.character_option_enabled(CharacterOption::AutoTarget));
}

#[test]
fn test_stat_floors() {
    let mut player = PlayerState::new();

    // 1. Attribute floor check
    // Base 100, debuff by 200 -> should floor at 10 (since base >= 10)
    set_attr(&mut player, stats::AttributeType::StrengthAttr, 100);
    player.enchantments.push(Enchantment {
        spell_id: 1,
        layer: 1,
        spell_category: 1,
        has_spell_set_id: 0,
        power_level: 1,
        start_time: 0.0,
        duration: 1000.0,
        caster_guid: Guid(50000001),
        degrade_modifier: 0.0,
        degrade_limit: -666.0,
        last_time_degraded: 0.0,
        stat_mod_type: (EnchantmentTypeFlags::ATTRIBUTE | EnchantmentTypeFlags::ADDITIVE).bits(),
        stat_mod_key: stats::AttributeType::StrengthAttr as u32,
        stat_mod_value: -200.0,
        spell_set_id: None,
    });
    assert_eq!(
        player.get_attribute_current(stats::AttributeType::StrengthAttr),
        10
    );

    // Attribute base 5, debuff by 10 -> should floor at 1
    set_attr(&mut player, stats::AttributeType::EnduranceAttr, 5);
    player.enchantments.push(Enchantment {
        spell_id: 2,
        layer: 1,
        spell_category: 2,
        has_spell_set_id: 0,
        power_level: 1,
        start_time: 0.0,
        duration: 1000.0,
        caster_guid: Guid(50000001),
        degrade_modifier: 0.0,
        degrade_limit: -666.0,
        last_time_degraded: 0.0,
        stat_mod_type: (EnchantmentTypeFlags::ATTRIBUTE | EnchantmentTypeFlags::ADDITIVE).bits(),
        stat_mod_key: stats::AttributeType::EnduranceAttr as u32,
        stat_mod_value: -100.0,
        spell_set_id: None,
    });
    assert_eq!(
        player.get_attribute_current(stats::AttributeType::EnduranceAttr),
        1
    );

    // 2. Vital floor check
    // Base 100, debuff by 200 -> should floor at 5
    player.vital_bases.insert(
        stats::VitalType::Health,
        VitalBase {
            ranks: 0,
            start: 100,
        },
    );
    // Attribute contribution for health is Str/2. Str is 10 (buffed)
    // Total base = 100 (base) + 5 (attr bonus) = 105.
    // Debuff by 200.
    player.enchantments.push(Enchantment {
        spell_id: 3,
        layer: 1,
        spell_category: 3,
        has_spell_set_id: 0,
        power_level: 1,
        start_time: 0.0,
        duration: 1000.0,
        caster_guid: Guid(50000001),
        degrade_modifier: 0.0,
        degrade_limit: -666.0,
        last_time_degraded: 0.0,
        stat_mod_type: (EnchantmentTypeFlags::SECOND_ATT | EnchantmentTypeFlags::ADDITIVE).bits(),
        stat_mod_key: stats::VitalType::Health as u32,
        stat_mod_value: -200.0,
        spell_set_id: None,
    });
    assert_eq!(player.calculate_vital_current(stats::VitalType::Health), 5);

    // 3. Skill floor check (0)
    player.skill_bases.insert(
        stats::SkillType::MeleeDefense,
        SkillBase {
            ranks: 100,
            init: 0,
            ..Default::default()
        },
    );
    // Skill formula for MeleeDefense is (Quick + Coord) / 3.
    // Str is 10, End is 1. (These are unrelated but Quick/Coord are default 0 if not set)
    set_attr(&mut player, stats::AttributeType::QuicknessAttr, 10);
    set_attr(&mut player, stats::AttributeType::CoordinationAttr, 10);
    // (10+10)/3 = 7. Total base = 7 + 100 = 107.
    player.enchantments.push(Enchantment {
        spell_id: 4,
        layer: 1,
        spell_category: 4,
        has_spell_set_id: 0,
        power_level: 1,
        start_time: 0.0,
        duration: 1000.0,
        caster_guid: Guid(50000001),
        degrade_modifier: 0.0,
        degrade_limit: -666.0,
        last_time_degraded: 0.0,
        stat_mod_type: (EnchantmentTypeFlags::SKILL | EnchantmentTypeFlags::ADDITIVE).bits(),
        stat_mod_key: stats::SkillType::MeleeDefense as u32,
        stat_mod_value: -200.0,
        spell_set_id: None,
    });
    assert_eq!(
        player.derive_skill_value(stats::SkillType::MeleeDefense, 100, 0, true),
        0
    );

    // 4. Armor level check (can stay negative for Armor Self / Imperil logic)
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000001);
    state.seed_local_player_entity(player_guid, "Player", WorldPosition::default());
    state
        .player_entity_mut()
        .expect("local player entity should exist")
        .properties
        .set_int_prop(PropertyInt::ArmorLevel, 10);
    state.player.enchantments.push(Enchantment {
        spell_id: 5,
        layer: 1,
        spell_category: 5,
        has_spell_set_id: 0,
        power_level: 1,
        start_time: 0.0,
        duration: 1000.0,
        caster_guid: Guid(50000001),
        degrade_modifier: 0.0,
        degrade_limit: -666.0,
        last_time_degraded: 0.0,
        stat_mod_type: (EnchantmentTypeFlags::BODY_ARMOR_VALUE | EnchantmentTypeFlags::ADDITIVE)
            .bits(),
        stat_mod_key: 0,
        stat_mod_value: -20.0,
        spell_set_id: None,
    });
    state.emit_player_derived_stats(&mut Vec::new());
    // 10 - 20 = -10.
    assert_eq!(state.player_armor(), -10);
}

#[test]
fn test_buff_calculations() {
    use holtburger_common::properties::EnchantmentTypeFlags;

    let mut player = PlayerState::new();
    set_attr(&mut player, stats::AttributeType::StrengthAttr, 100);
    set_attr(&mut player, stats::AttributeType::CoordinationAttr, 100);

    // Add a Strength Buff (+20 additive)
    player.enchantments.push(Enchantment {
        spell_category: 1, // strength group
        power_level: 100,
        stat_mod_type: (EnchantmentTypeFlags::ATTRIBUTE | EnchantmentTypeFlags::ADDITIVE).bits(),
        stat_mod_key: stats::AttributeType::StrengthAttr as u32,
        stat_mod_value: 20.0,
        ..Default::default()
    });

    // Add a Skill Multiplier (1.10x)
    player.enchantments.push(Enchantment {
        spell_category: 2, // axe group
        power_level: 100,
        stat_mod_type: (EnchantmentTypeFlags::SKILL | EnchantmentTypeFlags::MULTIPLICATIVE).bits(),
        stat_mod_key: stats::SkillType::Axe as u32,
        stat_mod_value: 1.10,
        ..Default::default()
    });

    // Strength should be 120
    assert_eq!(
        player.get_attribute_current(stats::AttributeType::StrengthAttr),
        120
    );

    // Heavy Weapons skill: (Str + Coord) / 3 + Ranks + Init
    // (120 + 100) / 3 = 73.33 -> 73
    // Base was (100 + 100) / 3 = 66.66 -> 67
    player.skill_bases.insert(
        stats::SkillType::HeavyWeapons,
        SkillBase {
            ranks: 10,
            init: 0,
            ..Default::default()
        },
    );

    let val = player.derive_skill_value(stats::SkillType::HeavyWeapons, 10, 0, true);
    assert_eq!(val, 73 + 10); // 83

    // Test Stacking: Add a weaker Strength buff
    player.enchantments.push(Enchantment {
        spell_category: 1, // same strength group
        power_level: 50,   // Lower power
        stat_mod_type: (EnchantmentTypeFlags::ATTRIBUTE | EnchantmentTypeFlags::ADDITIVE).bits(),
        stat_mod_key: stats::AttributeType::StrengthAttr as u32,
        stat_mod_value: 10.0,
        ..Default::default()
    });

    // Should still be 120
    assert_eq!(
        player.get_attribute_current(stats::AttributeType::StrengthAttr),
        120
    );

    // Add a STRONGER Strength buff
    player.enchantments.push(Enchantment {
        spell_category: 1, // same group
        power_level: 200,  // Higher power
        stat_mod_type: (EnchantmentTypeFlags::ATTRIBUTE | EnchantmentTypeFlags::ADDITIVE).bits(),
        stat_mod_key: stats::AttributeType::StrengthAttr as u32,
        stat_mod_value: 30.0,
        ..Default::default()
    });

    // Should now be 130
    assert_eq!(
        player.get_attribute_current(stats::AttributeType::StrengthAttr),
        130
    );
}

#[test]
fn test_health_rounding() {
    use holtburger_common::properties::EnchantmentTypeFlags;

    let mut player = PlayerState::new();
    // Endurance 101 / 2 = 50.5 -> should be 51
    set_attr(&mut player, stats::AttributeType::EnduranceAttr, 101);
    player.vital_bases.insert(
        stats::VitalType::Health,
        VitalBase {
            ranks: 0,
            start: 100,
        },
    );

    let health_base = player.calculate_vital_base(stats::VitalType::Health);
    assert_eq!(
        health_base, 151,
        "Base Health contribution from 101 Endurance should be 51 (rounded)"
    );

    // Add an Endurance buff of +10 (Total 111)
    player.enchantments.push(Enchantment {
        spell_category: 3, // endurance group
        stat_mod_type: (EnchantmentTypeFlags::ATTRIBUTE | EnchantmentTypeFlags::ADDITIVE).bits(),
        stat_mod_key: stats::AttributeType::EnduranceAttr as u32,
        stat_mod_value: 10.0,
        power_level: 100,
        ..Default::default()
    });

    // Current Endurance should be 111. 111 / 2 = 55.5 -> 56.
    // Total health should be 100 (start) + 56 (bonus) = 156.
    let health_current = player.calculate_vital_current(stats::VitalType::Health);
    assert_eq!(
        health_current, 156,
        "Current Health with 111 Endurance should be 156 (111/2=55.5 rounded to 56)"
    );
}

#[test]
fn test_vector_update_routing() {
    use crate::WorldEvent;
    use crate::entity::Entity;
    use crate::state::WorldState;
    use holtburger_common::Vector3;
    use holtburger_protocol::messages::GameMessage;
    use holtburger_protocol::messages::VectorUpdateData;

    let mut state = WorldState::synthetic();
    state.player.guid = Guid(0x50000001);
    state.entities.insert(Entity::new(
        state.player.guid,
        "Player".to_string(),
        WorldPosition::default(),
    ));

    let data = VectorUpdateData {
        guid: Guid(0x50000001),
        velocity: Vector3::new(1.0, 2.0, 3.0),
        omega: Vector3::new(0.1, 0.2, 0.3),
        instance_sequence: 123,
        vector_sequence: 456,
    };

    let msg = GameMessage::VectorUpdate(Box::new(data));
    let events = state.handle_message(&msg);

    assert_eq!(events.len(), 2);
    assert_eq!(state.player.instance_sequence, 123);
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::RuntimeBodyChanged { body_id }
            if *body_id == crate::SpatialBodyId::LocalPlayer(Guid(0x50000001))
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::EntityVectorUpdated { guid, velocity, omega }
            if *guid == Guid(0x50000001) && velocity.x == 1.0 && omega.x == 0.1
    )));
}

#[test]
fn test_magic_purge_bad_enchantments_preserves_vitae() {
    use crate::WorldEvent;
    use crate::state::WorldState;
    use holtburger_protocol::messages::{
        GameEvent, GameEventMessage, GameMessage, MagicPurgeBadEnchantmentsEventData,
    };

    let mut state = WorldState::synthetic();
    state.player.guid = Guid(0x50000001);

    // Beneficial buff: should remain after bad-enchantment purge.
    state.player.enchantments.push(Enchantment {
        spell_id: 100,
        layer: 1,
        spell_category: 100,
        stat_mod_type: (EnchantmentTypeFlags::ATTRIBUTE
            | EnchantmentTypeFlags::ADDITIVE
            | EnchantmentTypeFlags::BENEFICIAL)
            .bits(),
        stat_mod_key: stats::AttributeType::StrengthAttr as u32,
        stat_mod_value: 10.0,
        ..Default::default()
    });

    // Harmful debuff: should be removed by bad-enchantment purge.
    state.player.enchantments.push(Enchantment {
        spell_id: 200,
        layer: 1,
        spell_category: 200,
        stat_mod_type: (EnchantmentTypeFlags::ATTRIBUTE | EnchantmentTypeFlags::ADDITIVE).bits(),
        stat_mod_key: stats::AttributeType::StrengthAttr as u32,
        stat_mod_value: -10.0,
        ..Default::default()
    });

    // Vitae penalty: must be preserved even though it's not BENEFICIAL.
    state.player.enchantments.push(Enchantment {
        spell_id: 300,
        layer: 1,
        spell_category: 300,
        stat_mod_type: (EnchantmentTypeFlags::VITAE | EnchantmentTypeFlags::MULTIPLICATIVE).bits(),
        stat_mod_key: 0,
        stat_mod_value: 0.95,
        ..Default::default()
    });

    let msg = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: state.player.guid,
        sequence: 1,
        event: GameEvent::MagicPurgeBadEnchantments(Box::new(MagicPurgeBadEnchantmentsEventData {
            target: state.player.guid,
            sequence: 1,
        })),
    }));

    let events = state.handle_message(&msg);

    assert!(state.player.enchantments.iter().any(|e| e.spell_id == 100));
    assert!(!state.player.enchantments.iter().any(|e| e.spell_id == 200));
    assert!(state.player.enchantments.iter().any(|e| e.spell_id == 300));
    assert_eq!(state.player_vitae(), 0.95);

    assert!(
        events
            .iter()
            .any(|e| matches!(e, WorldEvent::PlayerEnchantmentsUpdated { .. }))
    );
    let derived_vitae = events.iter().find_map(|e| match e {
        WorldEvent::DerivedStatsUpdated(data) => Some(data.vitae),
        _ => None,
    });
    assert_eq!(derived_vitae, Some(0.95));
}

#[test]
fn test_update_motion_caches_last_non_zero_server_style() {
    let mut state = WorldState::synthetic();
    state.player.guid = Guid(0x50000001);

    let first = GameMessage::UpdateMotion(Box::new(MovementEventData {
        guid: state.player.guid,
        object_instance_sequence: 7,
        movement_sequence: 8,
        server_control_sequence: 9,
        is_autonomous: false,
        movement_type: MovementType::Invalid,
        motion_flags: 0,
        current_style: 62,
        data: MovementTypeData::Invalid(MovementInvalid::default()),
    }));

    let events = state.handle_message(&first);

    assert_eq!(state.player.instance_sequence, 7);
    assert_eq!(state.player.movement_sequence, 8);
    assert_eq!(state.player.server_control_sequence, 9);
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::SelfServerControlledMotion { data, .. }
            if data.server_control_sequence == 9 && data.movement_sequence == 8
    )));
    assert_eq!(
        state.player.last_server_motion_style,
        Some(MotionStance::SwordCombat)
    );

    let second = GameMessage::UpdateMotion(Box::new(MovementEventData {
        guid: state.player.guid,
        object_instance_sequence: 10,
        movement_sequence: 11,
        server_control_sequence: 12,
        is_autonomous: false,
        movement_type: MovementType::Invalid,
        motion_flags: 0,
        current_style: 0,
        data: MovementTypeData::Invalid(MovementInvalid::default()),
    }));

    let events = state.handle_message(&second);

    assert_eq!(state.player.instance_sequence, 10);
    assert_eq!(state.player.movement_sequence, 11);
    assert_eq!(state.player.server_control_sequence, 12);
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::SelfServerControlledMotion { data, .. }
            if data.server_control_sequence == 12 && data.movement_sequence == 11
    )));
    assert_eq!(
        state.player.last_server_motion_style,
        Some(MotionStance::SwordCombat)
    );
}

#[test]
fn test_stale_non_autonomous_update_motion_is_ignored_for_self() {
    let mut state = WorldState::synthetic();
    state.player.guid = Guid(0x50000001);
    state.player.instance_sequence = 10;
    state.player.movement_sequence = 20;
    state.player.server_control_sequence = 30;
    state.player.last_server_motion_style = Some(MotionStance::SwordCombat);

    let msg = GameMessage::UpdateMotion(Box::new(MovementEventData {
        guid: state.player.guid,
        object_instance_sequence: 11,
        movement_sequence: 21,
        server_control_sequence: 29,
        is_autonomous: false,
        movement_type: MovementType::Invalid,
        motion_flags: 0,
        current_style: MotionStance::Magic.interpreted(),
        data: MovementTypeData::Invalid(MovementInvalid::default()),
    }));

    let events = state.handle_message(&msg);

    assert!(events.is_empty());
    // Retail stamps update_times[1] the moment gate 1 passes
    // (acclient.c:311176) — the gate-2 drop still advances the
    // movement sequence; everything else stays untouched.
    assert_eq!(state.player.movement_sequence, 21);
    assert_eq!(state.player.instance_sequence, 10);
    assert_eq!(state.player.server_control_sequence, 30);
    assert_eq!(
        state.player.last_server_motion_style,
        Some(MotionStance::SwordCombat)
    );
}

/// Row 56 fixtures — a self `UpdateMotion` with a style + forward
/// command payload, for exercising the retail SetObjectMovement
/// three-part gate (acclient.c:311149-311196) at the PlayerState level.
fn self_motion(
    movement_sequence: u16,
    server_control_sequence: u16,
    autonomous: bool,
) -> MovementEventData {
    MovementEventData {
        guid: Guid(0x50000001),
        object_instance_sequence: 5,
        movement_sequence,
        server_control_sequence,
        is_autonomous: autonomous,
        movement_type: MovementType::Invalid,
        motion_flags: 0,
        current_style: MotionStance::Magic.interpreted(),
        data: MovementTypeData::Invalid(MovementInvalid {
            state: InterpretedMotionState {
                flags: MovementStateFlags::FORWARD_COMMAND,
                num_commands: 0,
                forward_command: Some(InterpretedMotionCommand::RUN_FORWARD),
                ..Default::default()
            },
            sticky_object: None,
        }),
    }
}

/// Gate 1 (acclient.c:311169-311176): `movement_sequence` is the
/// PRIMARY dedupe — equal/older drop untouched, newer accepts, with the
/// u16 wrap and the directional half-range edge of `is_newer_u16`.
#[test]
fn test_self_update_motion_gate1_movement_sequence_dedupe_and_wrap() {
    let mut player = PlayerState::new();
    player.movement_sequence = 20;
    player.server_control_sequence = 30;

    // Equal → drop (a re-sent packet changes nothing at all).
    assert!(!player.apply_self_update_motion(&self_motion(20, 31, false)));
    assert_eq!(player.movement_sequence, 20);
    assert_eq!(
        player.server_control_sequence, 30,
        "a gate-1 drop never touches the control epoch"
    );

    // Older → drop.
    assert!(!player.apply_self_update_motion(&self_motion(19, 31, false)));
    assert_eq!(player.movement_sequence, 20);

    // Newer → accept (control 31 is newer too — both stamped).
    assert!(player.apply_self_update_motion(&self_motion(21, 31, false)));
    assert_eq!(player.movement_sequence, 21);
    assert_eq!(player.server_control_sequence, 31);

    // u16 wrap: 0 follows 0xFFFF.
    let mut player = PlayerState::new();
    player.movement_sequence = 0xFFFF;
    player.server_control_sequence = 30;
    assert!(player.apply_self_update_motion(&self_motion(0, 30, false)));
    assert_eq!(player.movement_sequence, 0);

    // Directional half-range edge (retail newer_event, acclient.c:143015):
    // +0x8000 ahead is NOT newer; the numerically smaller base is.
    let mut player = PlayerState::new();
    player.movement_sequence = 0;
    player.server_control_sequence = 30;
    assert!(!player.apply_self_update_motion(&self_motion(0x8000, 30, false)));
    assert_eq!(player.movement_sequence, 0);
    let mut player = PlayerState::new();
    player.movement_sequence = 0x8000;
    player.server_control_sequence = 30;
    assert!(player.apply_self_update_motion(&self_motion(0, 30, false)));
    assert_eq!(player.movement_sequence, 0);
}

/// Gate 2 (acclient.c:311177-311186): an EQUAL server-control epoch is
/// retail-legal and unpacks; only a STRICTLY newer stored epoch drops —
/// and that drop happens AFTER gate 1 stamped the movement sequence.
#[test]
fn test_self_update_motion_gate2_equal_control_accepted_older_drops_after_stamp() {
    let mut player = PlayerState::new();
    player.instance_sequence = 3;
    player.movement_sequence = 20;
    player.server_control_sequence = 30;
    let substate_before = player.current_substate;

    // EQUAL control epoch: two UpdateMotion under one epoch both unpack.
    assert!(player.apply_self_update_motion(&self_motion(21, 30, false)));
    assert_eq!(player.movement_sequence, 21);
    assert_eq!(player.server_control_sequence, 30);
    assert_eq!(player.instance_sequence, 5);
    assert_eq!(player.last_server_motion_style, Some(MotionStance::Magic));
    assert_ne!(
        player.current_substate, substate_before,
        "a non-autonomous unpack writes the substate"
    );

    // Stored-newer control → drop, but gate 1 already stamped the
    // movement sequence (retail :311176).
    assert!(!player.apply_self_update_motion(&self_motion(22, 29, false)));
    assert_eq!(player.movement_sequence, 22);
    assert_eq!(player.server_control_sequence, 30);

    // Control-epoch directional half-range edge: a stored epoch exactly
    // 0x8000 behind the incoming accepts; the mirrored base drops.
    let mut player = PlayerState::new();
    player.movement_sequence = 20;
    player.server_control_sequence = 0x8000;
    assert!(player.apply_self_update_motion(&self_motion(21, 0, false)));
    assert_eq!(player.server_control_sequence, 0);
    let mut player = PlayerState::new();
    player.movement_sequence = 20;
    player.server_control_sequence = 0;
    assert!(!player.apply_self_update_motion(&self_motion(21, 0x8000, false)));
    assert_eq!(player.server_control_sequence, 0);
    assert_eq!(
        player.movement_sequence, 21,
        "the gate-1 stamp survives the gate-2 drop"
    );
}

/// Gate 3 (acclient.c:311187-311190): an accepted autonomous echo of
/// the player-controlled object advances the sequences but never
/// unpacks — style and substate stay untouched.
#[test]
fn test_self_update_motion_autonomous_echo_updates_sequences_only() {
    let mut player = PlayerState::new();
    player.instance_sequence = 3;
    player.movement_sequence = 20;
    player.server_control_sequence = 30;
    player.last_server_motion_style = Some(MotionStance::SwordCombat);
    let substate_before = player.current_substate;

    assert!(player.apply_self_update_motion(&self_motion(21, 31, true)));
    assert_eq!(player.movement_sequence, 21);
    assert_eq!(player.server_control_sequence, 31);
    assert_eq!(player.instance_sequence, 5);
    assert_eq!(
        player.last_server_motion_style,
        Some(MotionStance::SwordCombat),
        "an autonomous echo must not write the style"
    );
    assert_eq!(
        player.current_substate, substate_before,
        "an autonomous echo must not write the substate"
    );

    // A replayed echo (equal movement sequence) drops entirely.
    assert!(!player.apply_self_update_motion(&self_motion(21, 32, true)));
    assert_eq!(player.server_control_sequence, 31);
}

/// death-1 fixture — [`self_motion`] with an explicit interpreted
/// forward command (`None` = the flag absent on the wire).
fn self_motion_forward(
    movement_sequence: u16,
    server_control_sequence: u16,
    autonomous: bool,
    forward: Option<InterpretedMotionCommand>,
) -> MovementEventData {
    let mut data = self_motion(movement_sequence, server_control_sequence, autonomous);
    if let MovementTypeData::Invalid(invalid) = &mut data.data {
        invalid.state.flags = if forward.is_some() {
            MovementStateFlags::FORWARD_COMMAND
        } else {
            MovementStateFlags::empty()
        };
        invalid.state.forward_command = forward;
    }
    data
}

/// death-1 (R2 2026-10-08) — retail `PlayerIsDead` input
/// (acclient.c:717695-717705): a non-autonomous `Invalid` envelope with
/// forward Dead (0x0011) marks the player dead; a later non-autonomous
/// envelope with NO forward command (retail `UnPack` defaults it to
/// Ready, :333493 — ACE's NonCombat revive) clears it; an AUTONOMOUS echo
/// never touches it (retail never unpacks it, :311186-311190).
#[test]
fn apply_self_update_motion_tracks_dead_then_ready() {
    let mut player = PlayerState::new();
    player.movement_sequence = 20;
    player.server_control_sequence = 30;
    assert!(!player.server_forward_dead, "a fresh player is alive");

    // Server Dead → dead.
    assert!(player.apply_self_update_motion(&self_motion_forward(
        21,
        30,
        false,
        Some(InterpretedMotionCommand::DEAD),
    )));
    assert!(player.server_forward_dead);

    // An autonomous echo (forward absent) while dead → still dead.
    assert!(player.apply_self_update_motion(&self_motion_forward(22, 30, true, None)));
    assert!(
        player.server_forward_dead,
        "an autonomous echo is never unpacked, so it cannot revive"
    );

    // A dropped (stale) non-autonomous envelope → still dead.
    assert!(!player.apply_self_update_motion(&self_motion_forward(22, 30, false, None)));
    assert!(player.server_forward_dead, "a gate-1 drop changes nothing");

    // Server NonCombat Ready (forward flag absent) → alive.
    assert!(player.apply_self_update_motion(&self_motion_forward(23, 30, false, None)));
    assert!(!player.server_forward_dead, "absent forward == Ready revives");

    // Dead again, then any other explicit forward (RunForward) → alive.
    assert!(player.apply_self_update_motion(&self_motion_forward(
        24,
        30,
        false,
        Some(InterpretedMotionCommand::DEAD),
    )));
    assert!(player.server_forward_dead);
    assert!(player.apply_self_update_motion(&self_motion(25, 30, false)));
    assert!(!player.server_forward_dead);
}

#[test]
fn test_update_motion_caches_remote_entity_motion_snapshot_and_emits_event() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x60000001);

    let mut entity = Entity::new(guid, "Drudge".to_string(), WorldPosition::default());
    entity.health_fraction = Some(0.42);
    state.add_entity(entity);

    let msg = GameMessage::UpdateMotion(Box::new(MovementEventData {
        guid,
        object_instance_sequence: 7,
        movement_sequence: 8,
        server_control_sequence: 9,
        is_autonomous: false,
        movement_type: MovementType::Invalid,
        motion_flags: 0,
        current_style: MotionStance::NonCombat.interpreted(),
        data: MovementTypeData::Invalid(MovementInvalid {
            state: InterpretedMotionState {
                flags: MovementStateFlags::CURRENT_STYLE | MovementStateFlags::FORWARD_COMMAND,
                num_commands: 0,
                current_style: Some(MotionStance::NonCombat.interpreted()),
                forward_command: Some(InterpretedMotionCommand::DEAD),
                ..Default::default()
            },
            sticky_object: None,
        }),
    }));

    let events = state.handle_message(&msg);

    let snapshot = state
        .entities
        .get(guid)
        .and_then(|entity| entity.motion_snapshot)
        .expect("expected motion snapshot to be cached");

    assert_eq!(snapshot.current_style, Some(MotionStance::NonCombat));
    assert_eq!(
        snapshot.forward_command,
        Some(InterpretedMotionCommand::DEAD)
    );
    assert_eq!(snapshot.forward_speed, None);
    assert_eq!(
        state
            .entities
            .get(guid)
            .and_then(|entity| entity.health_fraction),
        Some(0.0)
    );
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::EntityMotionUpdated { guid: target, snapshot }
            if *target == guid
            && snapshot.as_ref().is_some_and(|snapshot| snapshot.current_style == Some(MotionStance::NonCombat))
            && snapshot.as_ref().is_some_and(|snapshot| snapshot.motion_command() == Some(InterpretedMotionCommand::DEAD))
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::EntityHealthUpdated {
            guid: event_guid,
            health_fraction,
        } if *event_guid == guid && *health_fraction == 0.0
    )));
}

#[test]
fn test_update_motion_clears_remote_entity_motion_snapshot_and_emits_event() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x60000001);

    let mut entity = Entity::new(guid, "Drudge".to_string(), WorldPosition::default());
    entity.motion_snapshot = Some(EntityMotionSnapshot {
        current_style: Some(MotionStance::NonCombat),
        forward_command: Some(InterpretedMotionCommand::WALK_FORWARD),
        sidestep_command: None,
        turn_command: None,
        ..Default::default()
    });
    state.add_entity(entity);

    let msg = GameMessage::UpdateMotion(Box::new(MovementEventData {
        guid,
        object_instance_sequence: 1,
        movement_sequence: 2,
        server_control_sequence: 3,
        is_autonomous: true,
        movement_type: MovementType::Invalid,
        motion_flags: 0,
        current_style: 1,
        data: MovementTypeData::Invalid(MovementInvalid::default()),
    }));

    let events = state.handle_message(&msg);

    assert_eq!(
        state
            .entities
            .get(guid)
            .and_then(|entity| entity.motion_snapshot),
        None
    );
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::EntityMotionUpdated { guid: target, snapshot }
            if *target == guid && snapshot.is_none()
    )));
}

#[test]
fn test_update_motion_retains_interpreted_motion_speeds() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x60000001);

    state.add_entity(Entity::new(
        guid,
        "Drudge".to_string(),
        WorldPosition::default(),
    ));

    let msg = GameMessage::UpdateMotion(Box::new(MovementEventData {
        guid,
        object_instance_sequence: 7,
        movement_sequence: 8,
        server_control_sequence: 9,
        is_autonomous: false,
        movement_type: MovementType::Invalid,
        motion_flags: 0,
        current_style: MotionStance::NonCombat.interpreted(),
        data: MovementTypeData::Invalid(MovementInvalid {
            state: InterpretedMotionState {
                flags: MovementStateFlags::FORWARD_COMMAND
                    | MovementStateFlags::FORWARD_SPEED
                    | MovementStateFlags::TURN_COMMAND
                    | MovementStateFlags::TURN_SPEED,
                num_commands: 0,
                forward_command: Some(InterpretedMotionCommand::RUN_FORWARD),
                forward_speed: Some(3.5),
                turn_command: Some(InterpretedMotionCommand::TURN_RIGHT),
                turn_speed: Some(1.25),
                ..Default::default()
            },
            sticky_object: None,
        }),
    }));

    let events = state.handle_message(&msg);

    let snapshot = state
        .entities
        .get(guid)
        .and_then(|entity| entity.motion_snapshot)
        .expect("expected motion snapshot to be cached");

    assert_eq!(
        snapshot.forward_command,
        Some(InterpretedMotionCommand::RUN_FORWARD)
    );
    assert_eq!(snapshot.forward_speed, OrderedMotionSpeed::from_f32(3.5));
    assert_eq!(
        snapshot.turn_command,
        Some(InterpretedMotionCommand::TURN_RIGHT)
    );
    assert_eq!(snapshot.turn_speed, OrderedMotionSpeed::from_f32(1.25));
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::EntityMotionUpdated { guid: target, snapshot }
            if *target == guid
            && snapshot.as_ref().is_some_and(|snapshot| snapshot.forward_speed == OrderedMotionSpeed::from_f32(3.5))
            && snapshot.as_ref().is_some_and(|snapshot| snapshot.turn_speed == OrderedMotionSpeed::from_f32(1.25))
    )));
}

#[test]
fn test_update_motion_retains_turn_to_heading_directive() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x60000001);

    state.add_entity(Entity::new(
        guid,
        "Drudge".to_string(),
        WorldPosition::default(),
    ));

    let msg = GameMessage::UpdateMotion(Box::new(MovementEventData {
        guid,
        object_instance_sequence: 7,
        movement_sequence: 8,
        server_control_sequence: 9,
        is_autonomous: false,
        movement_type: MovementType::TurnToHeading,
        motion_flags: 0,
        current_style: MotionStance::NonCombat.interpreted(),
        data: MovementTypeData::TurnToHeading(
            holtburger_protocol::messages::movement::messages::motion::TurnToHeading {
                params:
                    holtburger_protocol::messages::movement::messages::motion::TurnToParameters {
                        movement_parameters: 0,
                        speed: 1.5,
                        desired_heading: 0.75,
                    },
            },
        ),
    }));

    let _events = state.handle_message(&msg);

    let snapshot = state
        .entities
        .get(guid)
        .and_then(|entity| entity.motion_snapshot)
        .expect("expected motion snapshot to be cached");

    assert_eq!(
        snapshot.directive,
        Some(EntityMotionDirective::TurnToHeading {
            desired_heading: OrderedMotionSpeed::from_f32(0.75).expect("finite desired heading"),
            speed: OrderedMotionSpeed::from_f32(1.5).expect("finite speed"),
        })
    );
}

#[test]
fn test_vector_update_applies_self_velocity_and_omega() {
    let mut state = WorldState::synthetic();
    state.player.guid = Guid(0x50000001);

    let start = WorldPosition::default();
    state.seed_local_player_entity(state.player.guid, "Player", start);

    let msg = GameMessage::VectorUpdate(Box::new(VectorUpdateData {
        guid: state.player.guid,
        velocity: holtburger_common::Vector3::new(0.0, 0.0, 0.0),
        omega: holtburger_common::Vector3::new(0.0, 0.0, 1.25),
        instance_sequence: 11,
        vector_sequence: 12,
    }));

    let events = state.handle_message(&msg);

    assert_eq!(state.player.instance_sequence, 11);
    assert_eq!(
        state
            .entities
            .get(state.player.guid)
            .expect("player entity should exist")
            .velocity,
        holtburger_common::Vector3::new(0.0, 0.0, 0.0)
    );
    assert_eq!(
        state
            .entities
            .get(state.player.guid)
            .expect("player entity should exist")
            .omega,
        holtburger_common::Vector3::new(0.0, 0.0, 1.25)
    );
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::EntityVectorUpdated { guid, velocity, omega }
            if *guid == state.player.guid
            && *velocity == holtburger_common::Vector3::new(0.0, 0.0, 0.0)
            && *omega == holtburger_common::Vector3::new(0.0, 0.0, 1.25)
    )));
}

#[test]
fn test_magic_purge_enchantments_preserves_vitae_only() {
    use crate::state::WorldState;
    use holtburger_protocol::messages::{
        GameEvent, GameEventMessage, GameMessage, MagicPurgeEnchantmentsEventData,
        MagicUpdateEnchantmentEventData,
    };

    let mut state = WorldState::synthetic();
    state.player.guid = Guid(0x50000001);

    // Existing buff should be removed by full purge.
    state.player.enchantments.push(Enchantment {
        spell_id: 100,
        layer: 1,
        spell_category: 100,
        stat_mod_type: (EnchantmentTypeFlags::ATTRIBUTE
            | EnchantmentTypeFlags::ADDITIVE
            | EnchantmentTypeFlags::BENEFICIAL)
            .bits(),
        stat_mod_key: stats::AttributeType::StrengthAttr as u32,
        stat_mod_value: 10.0,
        ..Default::default()
    });

    // Death-like sequence from server: apply vitae, then purge enchantments.
    let vitae_enchant = Enchantment {
        spell_id: 666,
        layer: 0,
        spell_category: 204,
        stat_mod_type: (EnchantmentTypeFlags::VITAE | EnchantmentTypeFlags::MULTIPLICATIVE).bits(),
        stat_mod_key: 0,
        stat_mod_value: 0.88,
        ..Default::default()
    };

    let update_msg = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: state.player.guid,
        sequence: 16,
        event: GameEvent::MagicUpdateEnchantment(Box::new(MagicUpdateEnchantmentEventData {
            target: state.player.guid,
            sequence: 16,
            enchantment: vitae_enchant,
        })),
    }));

    let purge_msg = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: state.player.guid,
        sequence: 17,
        event: GameEvent::MagicPurgeEnchantments(Box::new(MagicPurgeEnchantmentsEventData {
            target: state.player.guid,
            sequence: 17,
        })),
    }));

    let mut events = state.handle_message(&update_msg);
    events.extend(state.handle_message(&purge_msg));

    assert!(!state.player.enchantments.iter().any(|e| e.spell_id == 100));
    assert!(state.player.enchantments.iter().any(|e| e.spell_id == 666));
    assert_eq!(state.player_vitae(), 0.88);

    let latest_derived_vitae = events.iter().rev().find_map(|e| match e {
        WorldEvent::DerivedStatsUpdated(data) => Some(data.vitae),
        _ => None,
    });
    assert_eq!(latest_derived_vitae, Some(0.88));
}

#[test]
fn test_update_position_from_server_caches_grounded_state() {
    let mut player = PlayerState::new();
    player.guid = Guid(0x50000001);

    let mut events = Vec::<WorldEvent>::new();
    let pos = WorldPosition::default();

    use holtburger_protocol::messages::movement::messages::position::{
        PositionPack, UpdatePositionFlag,
    };

    player.update_position_from_server(
        &PositionPack {
            pos,
            instance_sequence: 1,
            position_sequence: 2,
            teleport_sequence: 3,
            force_position_sequence: 4,
            flags: UpdatePositionFlag::NONE,
            ..Default::default()
        },
        &mut events,
    );
    assert_eq!(player.last_server_grounded, Some(false));

    player.update_position_from_server(
        &PositionPack {
            pos,
            instance_sequence: 5,
            position_sequence: 6,
            teleport_sequence: 7,
            force_position_sequence: 4,
            flags: UpdatePositionFlag::IS_GROUNDED,
            ..Default::default()
        },
        &mut events,
    );
    assert_eq!(player.last_server_grounded, Some(true));
}

#[test]
fn test_stale_update_position_is_ignored_when_teleport_sequence_regresses() {
    use holtburger_common::Vector3;
    use holtburger_protocol::messages::movement::messages::position::{
        PositionPack, UpdatePositionFlag,
    };

    let mut player = PlayerState::new();
    player.guid = Guid(0x50000001);
    player.teleport_sequence = 10;
    player.force_position_sequence = 4;

    let mut events = Vec::<WorldEvent>::new();
    let applied = player.apply_position_from_server(
        &PositionPack {
            pos: WorldPosition {
                landblock_id: Guid(0x02000000),
                coords: Vector3::new(9.0, 9.0, 9.0),
                ..Default::default()
            },
            instance_sequence: 1,
            position_sequence: 2,
            teleport_sequence: 9,
            force_position_sequence: 99,
            flags: UpdatePositionFlag::NONE,
            ..Default::default()
        },
        &mut events,
    );

    assert!(!applied);
    assert_eq!(player.teleport_sequence, 10);
    assert_eq!(player.force_position_sequence, 4);
    assert!(events.is_empty());
}

#[test]
fn test_stale_update_position_is_ignored_when_force_sequence_regresses() {
    use holtburger_common::Vector3;
    use holtburger_protocol::messages::movement::messages::position::{
        PositionPack, UpdatePositionFlag,
    };

    let mut player = PlayerState::new();
    player.guid = Guid(0x50000001);
    player.teleport_sequence = 10;
    player.force_position_sequence = 7;

    let mut events = Vec::<WorldEvent>::new();
    let applied = player.apply_position_from_server(
        &PositionPack {
            pos: WorldPosition {
                landblock_id: Guid(0x02000000),
                coords: Vector3::new(9.0, 9.0, 9.0),
                ..Default::default()
            },
            instance_sequence: 1,
            position_sequence: 2,
            teleport_sequence: 10,
            force_position_sequence: 6,
            flags: UpdatePositionFlag::NONE,
            ..Default::default()
        },
        &mut events,
    );

    assert!(!applied);
    assert_eq!(player.teleport_sequence, 10);
    assert_eq!(player.force_position_sequence, 7);
    assert!(events.is_empty());
}

#[test]
fn test_heal_command_updates() {
    use crate::state::WorldState;
    use holtburger_protocol::messages::{
        GameMessage, PrivateUpdateVitalCurrentData, PrivateUpdateVitalData,
    };

    let mut state = WorldState::synthetic();
    state.player.guid = Guid(0x50000001);

    // 1. Initial login: PrivateUpdateVital for Health (ID 1), Stamina (ID 3), Mana (ID 5)
    let vitals_to_init = [(1, "Health"), (3, "Stamina"), (5, "Mana")];
    for (id, _name) in vitals_to_init {
        let msg = GameMessage::PrivateUpdateVital(Box::new(PrivateUpdateVitalData {
            sequence: 1,
            object_guid: None,
            vital: id,
            ranks: 0,
            start: 100,
            xp: 0,
            current: 50,
        }));
        let _ = state.handle_message(&msg);
    }

    // Verify they are in the map
    assert!(state.player.vitals.contains_key(&stats::VitalType::Health));
    assert!(state.player.vitals.contains_key(&stats::VitalType::Stamina));
    assert!(state.player.vitals.contains_key(&stats::VitalType::Mana));

    // 2. Simulate @heal: PrivateUpdateVitalCurrent for Health (ID 2), Stamina (ID 4), Mana (ID 6)
    let heal_updates = [(2, 100), (4, 100), (6, 100)];
    for (id, val) in heal_updates {
        let msg = GameMessage::PrivateUpdateVitalCurrent(Box::new(PrivateUpdateVitalCurrentData {
            sequence: 2,
            object_guid: None,
            vital: id,
            current: val,
        }));
        let events = state.handle_message(&msg);
        assert_eq!(events.len(), 1);
    }

    // 3. Verify final state
    assert_eq!(
        state
            .player
            .vitals
            .get(&stats::VitalType::Health)
            .unwrap()
            .current,
        100
    );
    assert_eq!(
        state
            .player
            .vitals
            .get(&stats::VitalType::Stamina)
            .unwrap()
            .current,
        100
    );
    assert_eq!(
        state
            .player
            .vitals
            .get(&stats::VitalType::Mana)
            .unwrap()
            .current,
        100
    );
}

/// Rust review 2026-08-03 — the skill→attribute formula table used by
/// [`PlayerState::derive_skill_value`] is a hand-written SECOND COPY of the
/// `SkillFormula` rows that live in `portal.dat`'s SkillTable (`0x0E000004`),
/// and the two had drifted on 17 of the 54 skills.
///
/// AUTHORITIES (both agree):
///   * `client_portal.dat` `0x0E000004`, dumped with
///     `WorldBuilder.Terminal chorizite-parse-dat-record --typeName SkillTable`
///     (fields `attribute1` / `attribute2` / `divisor`, i.e. the DAT
///     `SkillFormula.Attr1` / `.Attr2` / `.Z`).
///   * ACE `ACE.Server/Entity/AttributeFormula.cs:55-73` for how that row is
///     applied — `if (formula.X == 0) return 0;`, attr2 skipped when `Undef`,
///     divide-and-round only when `divisor != 1`, `MidpointRounding.AwayFromZero`
///     (`ACE.Common/Extensions/FloatExtensions.cs:9`).
///   * ACE `ACE.DatLoader/FileTypes/SkillTable.cs:25-37 AddRetiredSkills()` for
///     the ten retired weapon skills that are NOT in the modern portal.dat.
///
/// A skill absent from BOTH sources (Sling, Spellcraft, Awareness,
/// ArmsAndArmorRepair, Gearcraft, Challenge) is a `TryGetValue` miss in ACE
/// (`AttributeFormula.cs:24`) and contributes 0.
///
/// Attribute values are deliberately all-distinct so a wrong attribute pick is
/// never masked by a coincidentally equal sum.
#[test]
fn skill_attribute_formula_matches_portal_dat() {
    use holtburger_common::stats::SkillType;

    let mut player = PlayerState::new();
    set_attr(&mut player, stats::AttributeType::StrengthAttr, 100);
    set_attr(&mut player, stats::AttributeType::EnduranceAttr, 110);
    set_attr(&mut player, stats::AttributeType::QuicknessAttr, 120);
    set_attr(&mut player, stats::AttributeType::CoordinationAttr, 130);
    set_attr(&mut player, stats::AttributeType::FocusAttr, 140);
    set_attr(&mut player, stats::AttributeType::SelfAttr, 150);

    // (skill, expected attribute bonus) — hand-computed from the DAT row above
    // with Str=100 End=110 Quick=120 Coord=130 Focus=140 Self=150.
    let expected: &[(SkillType, u32)] = &[
        // portal.dat rows
        (SkillType::Alchemy, 90),               // Coord+Focus /3 = 270/3
        (SkillType::ArcaneLore, 47),            // Focus /3 = 140/3 -> 46.67
        (SkillType::ArmorTinkering, 125),       // Focus+End /2 = 250/2
        (SkillType::Cooking, 90),               // Coord+Focus /3
        (SkillType::CreatureEnchantment, 73),   // Focus+Self /4 = 290/4 -> 72.5
        (SkillType::DirtyFighting, 77),         // Str+Coord /3 = 230/3
        (SkillType::DualWield, 87),             // Coord+Coord /3 = 260/3
        (SkillType::FinesseWeapons, 83),        // Quick+Coord /3 = 250/3
        (SkillType::Fletching, 90),             // Coord+Focus /3
        (SkillType::Healing, 90),               // Focus+Coord /3
        (SkillType::HeavyWeapons, 77),          // Str+Coord /3
        (SkillType::ItemEnchantment, 73),       // Focus+Self /4
        (SkillType::ItemTinkering, 135),        // Focus+Coord /2 = 270/2
        (SkillType::Jump, 115),                 // Str+Coord /2 = 230/2
        (SkillType::LifeMagic, 73),             // Focus+Self /4
        (SkillType::LightWeapons, 77),          // Str+Coord /3
        (SkillType::Lockpick, 90),              // Coord+Focus /3
        (SkillType::MagicDefense, 41),          // Self+Focus /7 = 290/7 -> 41.43
        (SkillType::MagicItemTinkering, 140),   // Focus /1
        (SkillType::ManaConversion, 48),        // Focus+Self /6 = 290/6 -> 48.33
        (SkillType::MeleeDefense, 83),          // Quick+Coord /3
        (SkillType::MissileDefense, 50),        // Quick+Coord /5 = 250/5
        (SkillType::MissileWeapons, 65),        // Coord /2
        (SkillType::Recklessness, 73),          // Str+Quick /3 = 220/3
        (SkillType::Run, 120),                  // Quick /1
        (SkillType::Shield, 115),               // Str+Coord /2
        (SkillType::SneakAttack, 83),           // Coord+Quick /3
        (SkillType::Summoning, 87),             // End+Self /3 = 260/3
        (SkillType::TwoHandedCombat, 77),       // Str+Coord /3
        (SkillType::VoidMagic, 73),             // Focus+Self /4
        (SkillType::WarMagic, 73),              // Focus+Self /4
        (SkillType::WeaponTinkering, 120),      // Focus+Str /2 = 240/2
        // ACE AddRetiredSkills()
        (SkillType::Axe, 77),
        (SkillType::Mace, 77),
        (SkillType::Spear, 77),
        (SkillType::Staff, 77),
        (SkillType::Sword, 77),
        (SkillType::UnarmedCombat, 77),
        (SkillType::Bow, 65),
        (SkillType::Crossbow, 65),
        (SkillType::ThrownWeapon, 65),
        (SkillType::Dagger, 83),                // Quick+Coord /3 (NOT Str)
        // portal.dat rows with attribute1Multiplier (SkillFormula.X) == 0
        (SkillType::AssessCreature, 0),
        (SkillType::AssessPerson, 0),
        (SkillType::Deception, 0),
        (SkillType::Leadership, 0),
        (SkillType::Loyalty, 0),
        (SkillType::Salvaging, 0),
        // absent from portal.dat AND from AddRetiredSkills()
        (SkillType::Sling, 0),
        (SkillType::Spellcraft, 0),
        (SkillType::Awareness, 0),
        (SkillType::ArmsAndArmorRepair, 0),
        (SkillType::Gearcraft, 0),
        (SkillType::Challenge, 0),
    ];

    // The table must cover EVERY SkillType — otherwise a future skill could be
    // added and silently escape this check (the "test that cannot fail" trap).
    let covered: std::collections::HashSet<SkillType> =
        expected.iter().map(|(skill, _)| *skill).collect();
    // SkillType has no EnumIter derive; `from_repr` over the full repr range
    // (Axe = 1 … Summoning = 54) enumerates every real variant.
    let all_skills: Vec<SkillType> = (0u32..=64).filter_map(SkillType::from_repr).collect();
    assert_eq!(
        all_skills.len(),
        54,
        "SkillType variant count changed — update this test's expectation table"
    );
    let missing: Vec<SkillType> = all_skills
        .into_iter()
        .filter(|s| !covered.contains(s))
        .collect();
    assert!(
        missing.is_empty(),
        "expectation table does not cover every SkillType: {:?}",
        missing
    );

    // ranks/init are pass-through addends, so with ranks=0/init=0 the returned
    // value IS the attribute bonus.
    let mut wrong = Vec::new();
    for (skill, want) in expected {
        let got = player.derive_skill_value(*skill, 0, 0, false);
        if got != *want {
            wrong.push(format!("{:?}: got {} want {}", skill, got, want));
        }
    }
    assert!(
        wrong.is_empty(),
        "skill attribute bonus disagrees with portal.dat SkillTable / ACE AttributeFormula:\n  {}",
        wrong.join("\n  ")
    );

    // ranks + init really are pure addends on top of the bonus.
    assert_eq!(
        player.derive_skill_value(SkillType::MissileDefense, 40, 5, false),
        50 + 40 + 5
    );
}

// ---------------------------------------------------------------------------
// enchstats-2 (2026-10-08) — retail `CACQualities::InqSkill`
// (acclient.c:443603) / `InqSkillBaseLevel` (:443298) / `EnchantSkill`
// (:445984), folded into `PlayerState::derive_skill_value`.
// ---------------------------------------------------------------------------

/// Spell 666 Vitae: 0xA06012 (Vitae | AdditiveDegrade | Multiplicative |
/// MultipleStat | Skill | SecondAtt), key 0.
fn vitae_enchantment(value: f32) -> Enchantment {
    Enchantment {
        spell_id: 666,
        layer: 1,
        spell_category: 204,
        power_level: 1,
        stat_mod_type: 0x00A0_6012,
        stat_mod_key: 0,
        stat_mod_value: value,
        ..Default::default()
    }
}

fn skill_base(ranks: u32, init: u32, sac: u32, min_level: u32) -> SkillBase {
    SkillBase {
        ranks,
        init,
        sac,
        min_level,
    }
}

fn skill_mult(category: u16, skill: stats::SkillType, value: f32) -> Enchantment {
    Enchantment {
        spell_id: category,
        layer: 1,
        spell_category: category,
        power_level: 100,
        stat_mod_type: (EnchantmentTypeFlags::SKILL | EnchantmentTypeFlags::MULTIPLICATIVE).bits(),
        stat_mod_key: skill as u32,
        stat_mod_value: value,
        ..Default::default()
    }
}

/// The 32afef1a oracle capture: Run raw 105 (Quickness 100 + 5 ranks),
/// AugmentationJackOfAllTrades = 1, Vitae 0.99. ACE published 109 =
/// round(105 × 0.99) + 5 — vitae FIRST, JoAT after the enchantments.
#[test]
fn skill_current_folds_joat_after_vitae() {
    use crate::stats::SkillType::Run;
    let mut player = PlayerState::new();
    set_attr(&mut player, stats::AttributeType::QuicknessAttr, 100);
    player.skill_bases.insert(Run, skill_base(5, 0, 2, 1));
    player.stat_aug.jack_of_all_trades = 1;

    assert_eq!(player.derive_skill_value(Run, 5, 0, false), 105, "raw base");
    assert_eq!(player.derive_skill_value(Run, 5, 0, true), 110, "no vitae");

    player.enchantments.push(vitae_enchantment(0.99));
    assert_eq!(
        player.derive_skill_value(Run, 5, 0, true),
        109,
        "round(103.95) + 5, the value ACE published"
    );
    assert_eq!(
        player.derive_skill_value(Run, 5, 0, false),
        105,
        "vitae never touches the raw base"
    );
}

/// `AugmentationSkilledMagic` (+10) is part of the RAW value, so it is
/// scaled by the skill multiplier.
#[test]
fn skilled_magic_aug_inside_multiplier() {
    use crate::stats::SkillType::WarMagic;
    let mut player = PlayerState::new();
    set_attr(&mut player, stats::AttributeType::FocusAttr, 100);
    set_attr(&mut player, stats::AttributeType::SelfAttr, 100);
    // (Focus + Self) / 4 = 50; + 10 ranks + 10 init = 70.
    player.skill_bases.insert(WarMagic, skill_base(10, 10, 2, 2));
    player.enchantments.push(skill_mult(7, WarMagic, 1.1));

    assert_eq!(player.derive_skill_value(WarMagic, 10, 10, false), 70);
    assert_eq!(player.derive_skill_value(WarMagic, 10, 10, true), 77);

    player.stat_aug.aug_skilled_magic = 1;
    assert_eq!(player.derive_skill_value(WarMagic, 10, 10, false), 80);
    assert_eq!(
        player.derive_skill_value(WarMagic, 10, 10, true),
        88,
        "round((70 + 10) × 1.1)"
    );

    // The melee / missile augmentations do not reach a magic skill.
    player.stat_aug.aug_skilled_magic = 0;
    player.stat_aug.aug_skilled_melee = 1;
    player.stat_aug.aug_skilled_missile = 1;
    assert_eq!(player.derive_skill_value(WarMagic, 10, 10, false), 70);
}

/// `LumAugSkilledSpec` adds 2× AFTER the enchantments and only to a
/// SPECIALIZED skill; `LumAugAllSkills` is raw (inside the multiplier).
#[test]
fn specialized_lum_aug_after_enchant() {
    use crate::stats::SkillType::MeleeDefense;
    let mut player = PlayerState::new();
    set_attr(&mut player, stats::AttributeType::QuicknessAttr, 90);
    set_attr(&mut player, stats::AttributeType::CoordinationAttr, 90);
    // (Quick + Coord) / 3 = 60; + 20 ranks + 10 init = 90.
    player.skill_bases.insert(MeleeDefense, skill_base(20, 10, 3, 1));
    player.enchantments.push(skill_mult(8, MeleeDefense, 1.1));
    player.stat_aug.lum_aug_skilled_spec = 2;

    // 90 × 1.1 = 99, + 2 × 2.
    assert_eq!(player.derive_skill_value(MeleeDefense, 20, 10, true), 103);
    assert_eq!(
        player.derive_skill_value(MeleeDefense, 20, 10, false),
        90,
        "the spec term is not raw"
    );

    // Trained (sac 2): no spec term.
    player.skill_bases.insert(MeleeDefense, skill_base(20, 10, 2, 1));
    assert_eq!(player.derive_skill_value(MeleeDefense, 20, 10, true), 99);

    // LumAugAllSkills 3 is raw: (90 + 3) × 1.1 = 102.3 → 102.
    player.stat_aug.lum_aug_all_skills = 3;
    assert_eq!(player.derive_skill_value(MeleeDefense, 20, 10, false), 93);
    assert_eq!(player.derive_skill_value(MeleeDefense, 20, 10, true), 102);
}

/// Retail `InqSkillBaseLevel`: a train-only skill (SkillTable min_level 2)
/// held Untrained (sac 1) gets NO attribute formula — base is init + ranks.
#[test]
fn untrained_min_level2_skill_has_no_formula_bonus() {
    use crate::stats::SkillType::WarMagic;
    let mut player = PlayerState::new();
    set_attr(&mut player, stats::AttributeType::FocusAttr, 100);
    set_attr(&mut player, stats::AttributeType::SelfAttr, 100);
    player.skill_bases.insert(WarMagic, skill_base(3, 5, 1, 2));

    assert_eq!(player.derive_skill_value(WarMagic, 3, 5, false), 8);
    assert_eq!(player.derive_skill_value(WarMagic, 3, 5, true), 8);

    // Trained: the formula comes back (50 + 8).
    player.skill_bases.insert(WarMagic, skill_base(3, 5, 2, 2));
    assert_eq!(player.derive_skill_value(WarMagic, 3, 5, false), 58);
}

/// A usable-untrained skill (min_level 1) keeps its formula at sac 1.
#[test]
fn usable_untrained_keeps_formula() {
    use crate::stats::SkillType::Run;
    let mut player = PlayerState::new();
    set_attr(&mut player, stats::AttributeType::QuicknessAttr, 100);
    player.skill_bases.insert(Run, skill_base(4, 0, 1, 1));
    assert_eq!(player.derive_skill_value(Run, 4, 0, false), 104);
}

/// `update_skill` stores the wire status and the SkillTable min_level, so a
/// live `PrivateUpdateSkill` for an untrained War Magic drops the formula.
#[test]
fn update_skill_records_sac_and_min_level() {
    use holtburger_dat::file_type::skill_table::{
        SkillBase as DatSkillBase, SkillFormula as DatSkillFormula,
    };
    let mut player = PlayerState::new();
    set_attr(&mut player, stats::AttributeType::FocusAttr, 100);
    set_attr(&mut player, stats::AttributeType::SelfAttr, 100);
    let skill_table = holtburger_dat::file_type::SkillTable {
        id: holtburger_dat::file_type::SkillTable::FILE_ID,
        skill_base_hash: std::collections::HashMap::from([(
            stats::SkillType::WarMagic as u32,
            DatSkillBase {
                description: String::new(),
                name: "War Magic".to_string(),
                icon_id: 0,
                trained_cost: 6,
                specialized_cost: 12,
                category: 0,
                chargen_use: 1,
                min_level: 2,
                formula: DatSkillFormula {
                    w: 0,
                    x: 1,
                    y: 1,
                    z: 4,
                    attr1: stats::AttributeType::FocusAttr as u32,
                    attr2: stats::AttributeType::SelfAttr as u32,
                },
                upper_bound: 0.0,
                lower_bound: 0.0,
                learn_mod: 0.0,
                retired: false,
            },
        )]),
    };
    let xp_table = holtburger_dat::file_type::XpTable::default();
    let mut events = Vec::new();
    player.update_skill(
        mutations::SkillUpdateParams {
            skill_id: stats::SkillType::WarMagic as u32,
            ranks: 0,
            status: 1,
            init: 0,
            xp: 0,
            xp_table: &xp_table,
            skill_table: &skill_table,
        },
        &mut events,
    );
    let base = player.skill_bases[&stats::SkillType::WarMagic];
    assert_eq!((base.sac, base.min_level), (1, 2));
    assert_eq!(player.skills[&stats::SkillType::WarMagic].base, 0);
    assert_eq!(player.skills[&stats::SkillType::WarMagic].current, 0);
}

/// The login `PlayerDescription` seeds the augmentation inputs from its own
/// property dump, and an augmentation that later goes ABSENT from the live
/// bag (ORACLE open defect #1) does not silently drop the +5.
#[test]
fn stat_aug_survives_absent_live_property() {
    use holtburger_common::properties::WorldObjectProperties;
    use holtburger_protocol::messages::player::events::{
        Attribute as WireAttribute, PlayerDescriptionEventData,
    };
    use holtburger_protocol::messages::player::skills::CreatureSkill;
    use holtburger_protocol::messages::{GameEvent, GameEventMessage};

    let player_guid = Guid(0x5000_0099);
    let mut state = WorldState::synthetic();
    state.player.guid = player_guid;

    let mut properties = WorldObjectProperties::default();
    properties
        .ints
        .insert(PropertyInt::AugmentationJackOfAllTrades, 1);
    let mut attributes = std::collections::BTreeMap::new();
    attributes.insert(
        stats::AttributeType::QuicknessAttr as u32,
        WireAttribute {
            ranks: 0,
            start: 100,
            xp: 0,
            current: None,
        },
    );
    let mut skills = std::collections::BTreeMap::new();
    skills.insert(
        stats::SkillType::Run as u32,
        CreatureSkill {
            sk_type: stats::SkillType::Run as u32,
            ranks: 5,
            status: 2,
            xp: 0,
            init: 0,
            resistance: 0,
            last_used: 0.0,
        },
    );
    let description = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: player_guid,
        sequence: 1,
        event: GameEvent::PlayerDescription(Box::new(PlayerDescriptionEventData {
            guid: player_guid,
            sequence: 1,
            name: "Augmented".to_string(),
            wee_type: 1,
            pos: Some(WorldPosition::default()),
            properties,
            positions: std::collections::BTreeMap::new(),
            attributes,
            skills,
            enchantments: vec![vitae_enchantment(0.99)],
            spells: std::collections::BTreeMap::new(),
            has_health: true,
            options1: CharacterOptions1::empty(),
            options2: CharacterOptions2::empty(),
            shortcuts: Vec::new(),
            hotbar_spells: Vec::new(),
            desired_comps: Vec::new(),
            spellbook_filters: 0,
            gameplay_options: Vec::new(),
            inventory: Vec::new(),
            equipped_objects: Vec::new(),
        })),
    }));
    let _ = state.handle_message(&description);

    assert_eq!(state.player.stat_aug.jack_of_all_trades, 1);
    let run = &state.player.skills[&stats::SkillType::Run];
    assert_eq!(run.base, 105);
    assert_eq!(run.current, 109, "105 × 0.99 → 104, + JackOfAllTrades 5");

    // The live bag loses the property; the cached login value holds.
    state
        .player_entity_mut()
        .expect("login bootstraps the player entity")
        .properties
        .ints
        .0
        .remove(&PropertyInt::AugmentationJackOfAllTrades);
    state.emit_player_derived_stats(&mut Vec::new());
    assert_eq!(state.player.stat_aug.jack_of_all_trades, 1);
    assert_eq!(state.player.skills[&stats::SkillType::Run].current, 109);

    // A live value that IS present wins (e.g. a PrivateUpdatePropertyInt).
    state
        .player_entity_mut()
        .expect("player entity")
        .properties
        .set_int_prop(PropertyInt::AugmentationJackOfAllTrades, 0);
    state.emit_player_derived_stats(&mut Vec::new());
    assert_eq!(state.player.stat_aug.jack_of_all_trades, 0);
    assert_eq!(state.player.skills[&stats::SkillType::Run].current, 104);
}

// ---------------------------------------------------------------------------
// enchstats-3 (2026-10-08) — retail `CACQualities::InqAttribute2nd`
// (acclient.c:443223) + `EnchantAttribute2nd` (:445921).
// ---------------------------------------------------------------------------

fn vital_rig(health_start: u32) -> PlayerState {
    let mut player = PlayerState::new();
    set_attr(&mut player, stats::AttributeType::EnduranceAttr, 100);
    set_attr(&mut player, stats::AttributeType::SelfAttr, 100);
    player.vital_bases.insert(
        stats::VitalType::Health,
        VitalBase {
            ranks: 0,
            start: health_start,
        },
    );
    player
        .vital_bases
        .insert(stats::VitalType::Stamina, VitalBase { ranks: 0, start: 0 });
    player
        .vital_bases
        .insert(stats::VitalType::Mana, VitalBase { ranks: 0, start: 0 });
    player
}

/// Vitae scales the max vital (vitae FIRST, then the culled enchantments);
/// the raw base is untouched.
#[test]
fn vital_max_applies_vitae_first() {
    let mut player = vital_rig(50);
    player.enchantments.push(vitae_enchantment(0.95));

    // Health: 50 + End/2 (50) = 100 → 95.
    assert_eq!(player.calculate_vital_base(stats::VitalType::Health), 100);
    assert_eq!(player.calculate_vital_current(stats::VitalType::Health), 95);
    // Stamina: End (100) → 95. Mana: Self (100) → 95.
    assert_eq!(player.calculate_vital_base(stats::VitalType::Stamina), 100);
    assert_eq!(player.calculate_vital_current(stats::VitalType::Stamina), 95);
    assert_eq!(player.calculate_vital_base(stats::VitalType::Mana), 100);
    assert_eq!(player.calculate_vital_current(stats::VitalType::Mana), 95);

    // A +10 Max Health additive lands AFTER vitae (not scaled by it).
    player.enchantments.push(Enchantment {
        spell_id: 50,
        layer: 1,
        spell_category: 50,
        power_level: 100,
        stat_mod_type: (EnchantmentTypeFlags::SECOND_ATT | EnchantmentTypeFlags::ADDITIVE).bits(),
        stat_mod_key: stats::VitalType::Health as u32,
        stat_mod_value: 10.0,
        ..Default::default()
    });
    assert_eq!(player.calculate_vital_current(stats::VitalType::Health), 105);
}

/// GearMaxHealth (int 0x17B) is part of the raw Max Health and is NOT clamped
/// away by the derived-stat refresh.
#[test]
fn gear_max_health_raises_base_and_max() {
    let mut player = vital_rig(50);
    player.stat_aug.gear_max_health = 20;
    player.vitals.insert(
        stats::VitalType::Health,
        stats::Vital {
            vital_type: stats::VitalType::Health,
            ranks: 0,
            start: 50,
            spent_xp: 0,
            next_rank_xp: None,
            base: 100,
            buffed_max: 100,
            current: 120,
        },
    );

    assert_eq!(player.calculate_vital_base(stats::VitalType::Health), 120);
    assert_eq!(player.calculate_vital_current(stats::VitalType::Health), 120);
    // Gear is Health-only.
    assert_eq!(player.calculate_vital_base(stats::VitalType::Stamina), 100);

    player.refresh_cached_derived_stat_inputs();
    let health = &player.vitals[&stats::VitalType::Health];
    assert_eq!((health.base, health.buffed_max), (120, 120));
    assert_eq!(health.current, 120, "the server's current HP is not clamped");

    // Gear is scaled by vitae like the rest of the raw max.
    player.enchantments.push(vitae_enchantment(0.95));
    assert_eq!(player.calculate_vital_current(stats::VitalType::Health), 114);
}

/// The floor is 5, or 1 when the PRE-enchantment value is below 5.
#[test]
fn vitae_floor_uses_pre_enchant_value() {
    let mut player = PlayerState::new();
    // No attributes: Stamina = start only (End reads 1 enchanted → pre 4).
    player
        .vital_bases
        .insert(stats::VitalType::Stamina, VitalBase { ranks: 0, start: 3 });
    player.enchantments.push(Enchantment {
        spell_id: 60,
        layer: 1,
        spell_category: 60,
        power_level: 100,
        stat_mod_type: (EnchantmentTypeFlags::SECOND_ATT | EnchantmentTypeFlags::ADDITIVE).bits(),
        stat_mod_key: stats::VitalType::Stamina as u32,
        stat_mod_value: -100.0,
        ..Default::default()
    });
    assert_eq!(
        player.calculate_vital_current(stats::VitalType::Stamina),
        1,
        "pre 4 < 5 → floor 1"
    );

    player
        .vital_bases
        .insert(stats::VitalType::Stamina, VitalBase { ranks: 0, start: 10 });
    assert_eq!(
        player.calculate_vital_current(stats::VitalType::Stamina),
        5,
        "pre ≥ 5 → floor 5"
    );
}

/// `UpdateHealth` fractions rebuild the absolute HP from the vitae-scaled
/// max, the max the server itself uses.
#[test]
fn update_health_fraction_uses_vitae_max() {
    let player_guid = Guid(0x5000_0098);
    let mut state = WorldState::synthetic();
    state.seed_local_player_entity(player_guid, "Vitae", WorldPosition::default());
    set_attr(&mut state.player, stats::AttributeType::EnduranceAttr, 100);
    state.player.vital_bases.insert(
        stats::VitalType::Health,
        VitalBase {
            ranks: 0,
            start: 50,
        },
    );
    state.player.vitals.insert(
        stats::VitalType::Health,
        stats::Vital {
            vital_type: stats::VitalType::Health,
            ranks: 0,
            start: 50,
            spent_xp: 0,
            next_rank_xp: None,
            base: 100,
            buffed_max: 100,
            current: 95,
        },
    );
    state.player.enchantments.push(vitae_enchantment(0.95));
    state.emit_player_derived_stats(&mut Vec::new());
    assert_eq!(state.player.vitals[&stats::VitalType::Health].buffed_max, 95);

    let mut events = Vec::new();
    assert!(state.update_health_fraction(player_guid, 0.5, &mut events));
    assert_eq!(state.player.vitals[&stats::VitalType::Health].current, 47);
}

// ---------------------------------------------------------------------------
// enchstats-5 (2026-10-08) — receive-time stamping on the live mutators.
// ---------------------------------------------------------------------------

#[test]
fn upsert_stamps_receive_time_for_the_duel() {
    use crate::stats::SkillType::Run;
    let mut player = PlayerState::new();
    player.guid = Guid(0x5000_0097);
    let guid = player.guid;
    let flags = (EnchantmentTypeFlags::SKILL | EnchantmentTypeFlags::ADDITIVE).bits();
    let a = Enchantment {
        spell_id: 100,
        layer: 1,
        spell_category: 9,
        power_level: 100,
        start_time: 0.0,
        stat_mod_type: flags,
        stat_mod_key: Run as u32,
        stat_mod_value: 1.0,
        ..Default::default()
    };
    let b = Enchantment {
        spell_id: 101,
        stat_mod_value: 2.0,
        ..a
    };
    let mut events = Vec::new();

    assert!(player.upsert_enchantment(guid, a, 10.0, &mut events));
    assert!(player.upsert_enchantment(guid, b, 20.0, &mut events));
    assert_eq!(player.get_skill_additive(Run), 2.0, "B arrived later");

    // A re-cast of A refreshes it IN PLACE (Vec slot 0) — it is now newest.
    assert!(player.upsert_enchantment(guid, a, 30.0, &mut events));
    assert_eq!(player.enchantments[0].spell_id, 100);
    assert_eq!(player.get_skill_additive(Run), 1.0, "refreshed A wins");
    assert_eq!(player.abs_start_time(&player.enchantments[0]), 30.0);

    // An aged layer (wire start -25) received at 50 sits at 25: older than A.
    let aged = Enchantment {
        start_time: -25.0,
        ..b
    };
    assert!(player.upsert_multiple_enchantments(guid, &[aged], 50.0, &mut events));
    assert_eq!(player.get_skill_additive(Run), 1.0);

    // Removal prunes the stamp.
    assert!(player.remove_enchantment(guid, 100, 1, &mut events));
    assert!(!player.enchantment_abs_start.contains_key(&(100, 1)));
    assert_eq!(player.get_skill_additive(Run), 2.0);
}
