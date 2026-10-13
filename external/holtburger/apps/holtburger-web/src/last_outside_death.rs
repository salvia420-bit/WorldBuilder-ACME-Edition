//! inventory-session-7 (2026-10-13) — the player's LastOutsideDeath position
//! (PositionType 14), read by the retail `@corpse` / `@cor` command.
//!
//! Retail `ClientCommunicationSystem::DoCorpse` (acclient.c:418186) answers
//! on the client from `CBaseQualities::InqPosition(PlayerDesc, 0xE)`; ACE has
//! no `@corpse` command. ACE carries the position in PlayerDescription's
//! Position table (the only entry it writes there,
//! GameEventPlayerDescription.cs) and sends a
//! `PrivateUpdatePosition(LastOutsideDeath)` after an outdoor death
//! (Creature_Death.cs). PrivateUpdatePosition stays un-routed to the world
//! handler on wasm (`should_route_message_to_world`), so the recv loop keeps
//! its own slot, like the Sanctuary one, and JS reads it via
//! `SessionHandle::player_last_outside_death` (app/slash_commands.js formats
//! the cell id as `LandDefs::CellidToCoordinateString` does).
//!
//! A PlayerDescription replaces the whole PlayerDesc in retail, so it also
//! replaces the slot: one without a LastOutsideDeath entry clears it, and a
//! position never carries over to the next character.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

use holtburger_common::position::WorldPosition;
use holtburger_protocol::messages::movement::PositionType;
use holtburger_protocol::messages::{GameEvent, GameMessage};
use std::cell::RefCell;
use std::collections::BTreeMap;

/// The stored LastOutsideDeath position: the objcell id DoCorpse formats,
/// plus the origin within that cell.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))] // fields read by the wasm getters
#[derive(Clone, Debug, PartialEq)]
pub struct LastOutsideDeathJs {
    cell_id: u32,
    x: f32,
    y: f32,
    z: f32,
}

impl LastOutsideDeathJs {
    pub(crate) fn from_position(pos: &WorldPosition) -> Self {
        LastOutsideDeathJs {
            cell_id: u32::from(pos.landblock_id),
            x: pos.coords.x,
            y: pos.coords.y,
            z: pos.coords.z,
        }
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl LastOutsideDeathJs {
    /// The objcell id (landblock << 16 | cell) of the corpse position.
    #[wasm_bindgen(getter, js_name = cellId)]
    pub fn cell_id(&self) -> u32 { self.cell_id }
    /// Origin X within the landblock.
    #[wasm_bindgen(getter)]
    pub fn x(&self) -> f32 { self.x }
    /// Origin Y within the landblock.
    #[wasm_bindgen(getter)]
    pub fn y(&self) -> f32 { self.y }
    /// Origin Z.
    #[wasm_bindgen(getter)]
    pub fn z(&self) -> f32 { self.z }
}

/// The LastOutsideDeath entry of a PlayerDescription's Position table.
pub(crate) fn from_player_description(
    positions: &BTreeMap<u32, WorldPosition>,
) -> Option<LastOutsideDeathJs> {
    positions
        .get(&(PositionType::LastOutsideDeath as u32))
        .map(LastOutsideDeathJs::from_position)
}

/// Fold one inbound message into the slot: a PlayerDescription replaces it
/// (with `None` when the description has no LastOutsideDeath entry), a
/// `PrivateUpdatePosition(LastOutsideDeath)` sets it. Every other message,
/// including a PrivateUpdatePosition of another type, leaves it alone.
/// Returns whether the slot was written.
pub(crate) fn observe(slot: &RefCell<Option<LastOutsideDeathJs>>, message: &GameMessage) -> bool {
    match message {
        GameMessage::GameEvent(event_msg) => match &event_msg.event {
            GameEvent::PlayerDescription(data) => {
                *slot.borrow_mut() = from_player_description(&data.positions);
                true
            }
            _ => false,
        },
        GameMessage::PrivateUpdatePosition(data)
            if data.position_type == PositionType::LastOutsideDeath =>
        {
            *slot.borrow_mut() = Some(LastOutsideDeathJs::from_position(&data.pos));
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::Guid;
    use holtburger_common::math::Vector3;
    use holtburger_protocol::messages::movement::PrivateUpdatePositionData;
    use holtburger_protocol::test_fixtures;
    use holtburger_protocol::traits::{ProtocolPack, ProtocolUnpack};

    // An outdoor Holtburg cell (landblock 0xA9B4, cell 0x0021).
    const CORPSE_CELL: u32 = 0xA9B4_0021;

    fn corpse_pos() -> WorldPosition {
        WorldPosition {
            landblock_id: Guid(CORPSE_CELL),
            coords: Vector3::new(108.5, 12.25, 42.0),
            ..Default::default()
        }
    }

    fn location_pos() -> WorldPosition {
        WorldPosition {
            landblock_id: Guid(0x7D64_000D),
            coords: Vector3::new(60.0, 100.0, 5.0),
            ..Default::default()
        }
    }

    /// The captured PlayerDescription fixture, with its Position table
    /// replaced by `positions`.
    fn player_description(positions: BTreeMap<u32, WorldPosition>) -> GameMessage {
        let mut offset = 0;
        let mut msg = GameMessage::unpack(test_fixtures::PLAYER_DESCRIPTION, &mut offset)
            .expect("PlayerDescription fixture unpacks");
        match &mut msg {
            GameMessage::GameEvent(event_msg) => match &mut event_msg.event {
                GameEvent::PlayerDescription(data) => data.positions = positions,
                other => panic!("expected GameEvent::PlayerDescription, got {other:?}"),
            },
            other => panic!("expected GameMessage::GameEvent, got {other:?}"),
        }
        msg
    }

    /// A PrivateUpdatePosition, packed and unpacked through the wire format.
    fn private_update(position_type: PositionType, pos: WorldPosition) -> GameMessage {
        let msg = GameMessage::PrivateUpdatePosition(Box::new(PrivateUpdatePositionData {
            sequence: 3,
            position_type,
            pos,
        }));
        let mut buf = Vec::new();
        msg.pack(&mut buf);
        let mut offset = 0;
        GameMessage::unpack(&buf, &mut offset).expect("PrivateUpdatePosition unpacks")
    }

    fn expected_corpse() -> LastOutsideDeathJs {
        LastOutsideDeathJs { cell_id: CORPSE_CELL, x: 108.5, y: 12.25, z: 42.0 }
    }

    #[test]
    fn last_outside_death_is_position_type_14() {
        // DoCorpse: CBaseQualities::InqPosition(PlayerDesc, 0xE).
        assert_eq!(PositionType::LastOutsideDeath as u32, 0xE);
    }

    #[test]
    fn captured_ace_player_description_seeds_the_slot() {
        // The captured ACE PlayerDescription carries exactly one Position
        // entry, LastOutsideDeath (0xE), at cell 0xDA55001D.
        let mut offset = 0;
        let msg = GameMessage::unpack(test_fixtures::PLAYER_DESCRIPTION, &mut offset)
            .expect("PlayerDescription fixture unpacks");
        let slot = RefCell::new(None);
        assert!(observe(&slot, &msg));
        let seeded = slot.borrow().clone().expect("LastOutsideDeath seeded");
        assert_eq!(seeded.cell_id, 0xDA55_001D);
        assert!((seeded.x - 79.843_79).abs() < 1e-3, "x = {}", seeded.x);
        assert!((seeded.y - 112.006_28).abs() < 1e-3, "y = {}", seeded.y);
        assert!((seeded.z - 20.005).abs() < 1e-3, "z = {}", seeded.z);
    }

    #[test]
    fn player_description_with_position_14_seeds_the_slot() {
        let slot = RefCell::new(None);
        let mut positions = BTreeMap::new();
        positions.insert(PositionType::Location as u32, location_pos());
        positions.insert(PositionType::LastOutsideDeath as u32, corpse_pos());
        assert!(observe(&slot, &player_description(positions)));
        assert_eq!(*slot.borrow(), Some(expected_corpse()));
    }

    #[test]
    fn player_description_without_position_14_clears_the_slot() {
        // A new character's description must not inherit the last one's corpse.
        let slot = RefCell::new(Some(expected_corpse()));
        let mut positions = BTreeMap::new();
        positions.insert(PositionType::Location as u32, location_pos());
        assert!(observe(&slot, &player_description(positions)));
        assert_eq!(*slot.borrow(), None);
        assert!(observe(&slot, &player_description(BTreeMap::new())));
        assert_eq!(*slot.borrow(), None);
    }

    #[test]
    fn private_update_last_outside_death_updates_the_slot() {
        let slot = RefCell::new(None);
        assert!(observe(&slot, &private_update(PositionType::LastOutsideDeath, corpse_pos())));
        assert_eq!(*slot.borrow(), Some(expected_corpse()));

        // A later death replaces it.
        let mut moved = corpse_pos();
        moved.landblock_id = Guid(0xA9B3_0008);
        moved.coords = Vector3::new(180.0, 190.0, 30.0);
        assert!(observe(&slot, &private_update(PositionType::LastOutsideDeath, moved)));
        assert_eq!(
            *slot.borrow(),
            Some(LastOutsideDeathJs { cell_id: 0xA9B3_0008, x: 180.0, y: 190.0, z: 30.0 })
        );
    }

    #[test]
    fn other_private_updates_leave_the_slot_alone() {
        let slot = RefCell::new(Some(expected_corpse()));
        for position_type in [
            PositionType::Location,
            PositionType::Sanctuary,
            PositionType::LinkedPortalOne,
            PositionType::LinkedLifestone,
        ] {
            assert!(!observe(&slot, &private_update(position_type, location_pos())));
        }
        assert_eq!(*slot.borrow(), Some(expected_corpse()));
    }
}
