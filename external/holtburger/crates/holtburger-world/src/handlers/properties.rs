use crate::WorldEvent;
use crate::state::WorldState;
use holtburger_common::Guid;
use holtburger_common::properties::{
    ObjectDescriptionFlag, PropertyInstanceId, PropertyInt, PropertyUpdate,
};
use holtburger_protocol::messages::GameMessage;

/// `PublicWeenieDesc::SetPlayerKillerStatus` (acclient.c:470685-470702), which
/// retail's int-property update applies for `PlayerKillerStatus` (0x86,
/// acclient.c:438785-438786): the object-description bitfield's PK bits
/// follow the status — PK (4) sets PLAYER_KILLER, PKLite (0x40) sets
/// PK_LITE_STATUS, Free (0x20) sets FREE_PK_STATUS, each clearing the other
/// two; anything else clears all three. ACE announces a mid-session PK
/// change ONLY as `PublicUpdatePropertyInt(PlayerKillerStatus)` (no
/// UpdateObject), so without this `Entity::flags` kept the login-time bits
/// and the in-transition player-vs-player pass-through
/// (`obj_collision.rs`, acclient.c:316214-316225) used stale PK status.
pub(crate) fn apply_player_killer_status(flags: &mut ObjectDescriptionFlag, status: u32) {
    use ObjectDescriptionFlag as F;
    flags.remove(F::PLAYER_KILLER | F::FREE_PK_STATUS | F::PK_LITE_STATUS);
    match status {
        0x4 => flags.insert(F::PLAYER_KILLER),
        0x40 => flags.insert(F::PK_LITE_STATUS),
        0x20 => flags.insert(F::FREE_PK_STATUS),
        _ => {}
    }
}

fn refresh_pk_bits(state: &mut WorldState, target: Guid, property: u32, value: i32) {
    if property != PropertyInt::PlayerKillerStatus as u32 {
        return;
    }
    if let Some(entity) = state.entities.get_mut(target) {
        apply_player_killer_status(&mut entity.flags, value as u32);
    }
}

pub(crate) fn handle_message(
    state: &mut WorldState,
    message: &GameMessage,
    events: &mut Vec<WorldEvent>,
) -> bool {
    match message {
        GameMessage::SetStackSize(data) => {
            let guid = data.object_guid;
            if let Some(entity) = state.entities.get_mut(guid) {
                entity.set_property(PropertyUpdate::Int(
                    PropertyInt::StackSize,
                    data.stack_size as i32,
                ));
                entity.set_property(PropertyUpdate::Int(PropertyInt::Value, data.value as i32));
                events.push(WorldEvent::PropertiesUpdated {
                    guid,
                    updates: vec![
                        PropertyUpdate::Int(PropertyInt::StackSize, data.stack_size as i32),
                        PropertyUpdate::Int(PropertyInt::Value, data.value as i32),
                    ],
                });
                true
            } else {
                false
            }
        }
        GameMessage::PrivateUpdatePropertyInt(data) => {
            let update = PropertyUpdate::try_from_raw_int(data.property, data.value);
            let target_guid = state.apply_property_update_to_target(data.guid, &update);
            refresh_pk_bits(state, target_guid, data.property, data.value);
            if target_guid == state.player.guid {
                match data.property {
                    p if p == PropertyInt::Level as u32
                        || p == PropertyInt::AvailableSkillCredits as u32 =>
                    {
                        state.emit_level_info(events);
                    }
                    p if p == PropertyInt::CombatMode as u32 => {
                        events.push(WorldEvent::CombatModeUpdated(state.player_combat_mode()));
                    }
                    _ => {}
                }
                state.emit_player_derived_stats(events);
            }
            events.push(WorldEvent::PropertiesUpdated {
                guid: target_guid,
                updates: vec![update],
            });
            true
        }
        GameMessage::PublicUpdatePropertyInt(data) => {
            let update = PropertyUpdate::try_from_raw_int(data.property, data.value);
            let target_guid = state.apply_property_update_to_target(data.guid, &update);
            refresh_pk_bits(state, target_guid, data.property, data.value);
            if target_guid == state.player.guid {
                if data.property == PropertyInt::CombatMode as u32 {
                    events.push(WorldEvent::CombatModeUpdated(state.player_combat_mode()));
                }
                state.emit_player_derived_stats(events);
            }
            events.push(WorldEvent::PropertiesUpdated {
                guid: target_guid,
                updates: vec![update],
            });
            true
        }
        GameMessage::PrivateUpdatePropertyInt64(data) => {
            let update = PropertyUpdate::try_from_raw_int64(data.property, data.value);
            let target_guid = state.apply_property_update_to_target(data.guid, &update);
            if target_guid == state.player.guid {
                match data.property {
                    p if p
                        == holtburger_common::properties::PropertyInt64::TotalExperience as u32
                        || p == holtburger_common::properties::PropertyInt64::AvailableExperience
                            as u32
                        || p == holtburger_common::properties::PropertyInt64::AvailableLuminance
                            as u32 =>
                    {
                        state.emit_level_info(events);
                    }
                    _ => {}
                }
            }
            events.push(WorldEvent::PropertiesUpdated {
                guid: target_guid,
                updates: vec![update],
            });
            true
        }
        GameMessage::PublicUpdatePropertyInt64(data) => {
            let update = PropertyUpdate::try_from_raw_int64(data.property, data.value);
            let target_guid = state.apply_property_update_to_target(data.guid, &update);
            events.push(WorldEvent::PropertiesUpdated {
                guid: target_guid,
                updates: vec![update],
            });
            true
        }
        GameMessage::PrivateUpdatePropertyBool(data) => {
            let update = PropertyUpdate::try_from_raw_bool(data.property, data.value);
            let target_guid = state.apply_property_update_to_target(data.guid, &update);
            events.push(WorldEvent::PropertiesUpdated {
                guid: target_guid,
                updates: vec![update],
            });
            true
        }
        GameMessage::PublicUpdatePropertyBool(data) => {
            let update = PropertyUpdate::try_from_raw_bool(data.property, data.value);
            let target_guid = state.apply_property_update_to_target(data.guid, &update);
            events.push(WorldEvent::PropertiesUpdated {
                guid: target_guid,
                updates: vec![update],
            });
            true
        }
        GameMessage::PrivateUpdatePropertyFloat(data) => {
            let update = PropertyUpdate::try_from_raw_float(data.property, data.value);
            let target_guid = state.apply_property_update_to_target(data.guid, &update);
            if target_guid == state.player.guid {
                state.emit_player_derived_stats(events);
            }
            events.push(WorldEvent::PropertiesUpdated {
                guid: target_guid,
                updates: vec![update],
            });
            true
        }
        GameMessage::PublicUpdatePropertyFloat(data) => {
            let update = PropertyUpdate::try_from_raw_float(data.property, data.value);
            let target_guid = state.apply_property_update_to_target(data.guid, &update);
            if target_guid == state.player.guid {
                state.emit_player_derived_stats(events);
            }
            events.push(WorldEvent::PropertiesUpdated {
                guid: target_guid,
                updates: vec![update],
            });
            true
        }
        GameMessage::PrivateUpdatePropertyString(data) => {
            let update = PropertyUpdate::try_from_raw_string(data.property, data.value.clone());
            let target_guid = state.apply_property_update_to_target(data.guid, &update);
            events.push(WorldEvent::PropertiesUpdated {
                guid: target_guid,
                updates: vec![update],
            });
            true
        }
        GameMessage::PublicUpdatePropertyString(data) => {
            let update = PropertyUpdate::try_from_raw_string(data.property, data.value.clone());
            let target_guid = state.apply_property_update_to_target(data.guid, &update);
            events.push(WorldEvent::PropertiesUpdated {
                guid: target_guid,
                updates: vec![update],
            });
            true
        }
        GameMessage::PrivateUpdatePropertyDataId(data) => {
            let update = PropertyUpdate::try_from_raw_did(data.property, data.value);
            let target_guid = state.apply_property_update_to_target(data.guid, &update);
            events.push(WorldEvent::PropertiesUpdated {
                guid: target_guid,
                updates: vec![update],
            });
            true
        }
        GameMessage::PublicUpdatePropertyDataId(data) => {
            let update = PropertyUpdate::try_from_raw_did(data.property, data.value);
            let target_guid = state.apply_property_update_to_target(data.guid, &update);
            events.push(WorldEvent::PropertiesUpdated {
                guid: target_guid,
                updates: vec![update],
            });
            true
        }
        GameMessage::PrivateUpdatePropertyInstanceId(data) => {
            let prop = PropertyInstanceId::from_repr(data.property);
            let update = PropertyUpdate::try_from_raw_iid(data.property, data.value);
            let target_guid = state.apply_property_update_to_target(data.guid, &update);
            if let Some(prop) = prop {
                state.apply_instance_id_side_effect(target_guid, prop, data.value, events);
            }
            events.push(WorldEvent::PropertiesUpdated {
                guid: target_guid,
                updates: vec![update],
            });
            true
        }
        GameMessage::PublicUpdatePropertyInstanceId(data) => {
            let prop = PropertyInstanceId::from_repr(data.property);
            let update = PropertyUpdate::try_from_raw_iid(data.property, data.value);
            let target_guid = state.apply_property_update_to_target(data.guid, &update);
            if let Some(prop) = prop {
                state.apply_instance_id_side_effect(target_guid, prop, data.value, events);
            }
            events.push(WorldEvent::PropertiesUpdated {
                guid: target_guid,
                updates: vec![update],
            });
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod pk_status_tests {
    use super::*;
    use holtburger_common::position::WorldPosition;
    use ObjectDescriptionFlag as F;

    /// `PublicWeenieDesc::SetPlayerKillerStatus` (acclient.c:470685): each
    /// status sets its bit and clears the other two; unknown clears all.
    #[test]
    fn player_killer_status_maps_to_the_description_bits() {
        let mut f = F::PLAYER | F::FREE_PK_STATUS;
        apply_player_killer_status(&mut f, 0x4);
        assert_eq!(f, F::PLAYER | F::PLAYER_KILLER);
        apply_player_killer_status(&mut f, 0x40);
        assert_eq!(f, F::PLAYER | F::PK_LITE_STATUS);
        apply_player_killer_status(&mut f, 0x20);
        assert_eq!(f, F::PLAYER | F::FREE_PK_STATUS);
        apply_player_killer_status(&mut f, 0x2); // NPK
        assert_eq!(f, F::PLAYER);
    }

    /// A mid-session PK switch (ACE sends only
    /// `PublicUpdatePropertyInt(PlayerKillerStatus)`) refreshes the
    /// entity's flags. Old code left the login-time bits.
    #[test]
    fn a_player_killer_status_update_refreshes_the_entity_flags() {
        let mut state = WorldState::synthetic();
        let guid = Guid(0x5000_0099);
        let mut e = crate::entity::Entity::new(guid, "Other".to_string(), WorldPosition::default());
        e.flags = F::PLAYER;
        state.entities.insert(e);
        refresh_pk_bits(&mut state, guid, PropertyInt::PlayerKillerStatus as u32, 4);
        assert!(state.entities.get(guid).unwrap().flags.contains(F::PLAYER_KILLER));
        // Another int property leaves the bits alone.
        refresh_pk_bits(&mut state, guid, PropertyInt::Level as u32, 4);
        assert!(state.entities.get(guid).unwrap().flags.contains(F::PLAYER_KILLER));
    }
}
