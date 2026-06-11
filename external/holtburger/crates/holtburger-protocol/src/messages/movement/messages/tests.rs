use crate::messages::game_message::GameMessage;
use crate::messages::movement::messages::*;
use crate::messages::movement::types::PositionType;
use crate::test_fixtures;
use crate::test_helpers::assert_pack_unpack_parity;
use crate::traits::{ProtocolPack, ProtocolUnpack};
use holtburger_common::Guid;
use holtburger_common::position::WorldPosition;

#[test]
fn test_player_movement_pack_unpack() {
    let expected = GameMessage::PublicUpdatePosition(Box::new(PublicUpdatePositionData {
        sequence: 12,
        guid: Guid(0x50000001),
        position_type: PositionType::Location,
        pos: WorldPosition {
            landblock_id: Guid(0x12345678),
            coords: holtburger_common::math::Vector3 {
                x: 10.0,
                y: 20.0,
                z: 30.0,
            },
            rotation: holtburger_common::math::Quaternion {
                w: 1.0,
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
        },
    }));
    assert_pack_unpack_parity(test_fixtures::PUBLIC_UPDATE_POSITION, &expected);
}

#[test]
fn test_private_update_position_fixture() {
    let expected = GameMessage::PrivateUpdatePosition(Box::new(PrivateUpdatePositionData {
        sequence: 12,
        position_type: PositionType::Location,
        pos: WorldPosition {
            landblock_id: Guid(0x12345678),
            coords: holtburger_common::math::Vector3 {
                x: 10.0,
                y: 20.0,
                z: 30.0,
            },
            rotation: holtburger_common::math::Quaternion {
                w: 1.0,
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
        },
    }));
    assert_pack_unpack_parity(test_fixtures::PRIVATE_UPDATE_POSITION, &expected);
}

#[test]
fn test_vector_update_fixture() {
    let hex = "4EF70000010000500000803F0000004000004040CDCCCC3DCDCC4C3E9A99993E7B00C801";
    let expected = GameMessage::VectorUpdate(Box::new(VectorUpdateData {
        guid: Guid(0x50000001),
        velocity: holtburger_common::math::Vector3 {
            x: 1.0,
            y: 2.0,
            z: 3.0,
        },
        omega: holtburger_common::math::Vector3 {
            x: 0.1,
            y: 0.2,
            z: 0.3,
        },
        instance_sequence: 123,
        vector_sequence: 456,
    }));
    assert_pack_unpack_parity(&hex::decode(hex).unwrap(), &expected);
}

// AutonomyLevel fixture moved to messages/movement/actions.rs — 0xF752 is a
// GameActionType (C2S only), not a top-level GameMessage. See
// acclient.c CM_Movement::Event_AutonomyLevel @ 712866 and ACE-Server
// GameActionType.AutonomyLevel.

#[test]
fn test_autonomous_position_fixture() {
    // ACE writes the pose with writeLandblock:false — NO cell id after the
    // guid (Position.Serialize(writer, true, false) in
    // GameMessageAutonomousPosition.cs).
    let hex = "53F7000001000000000020410000A0410000F0410000803F000000000000000000000000010002000300040001000000";
    let expected = GameMessage::AutonomousPosition(Box::new(ServerAutonomousPositionData {
        guid: Guid(1),
        coords: holtburger_common::math::Vector3 {
            x: 10.0,
            y: 20.0,
            z: 30.0,
        },
        rotation: holtburger_common::math::Quaternion {
            w: 1.0,
            x: 0.0,
            y: 0.0,
            z: 0.0,
        },
        instance_sequence: 1,
        server_control_sequence: 2,
        teleport_sequence: 3,
        force_position_sequence: 4,
        contact_flags: 1,
    }));
    assert_pack_unpack_parity(&hex::decode(hex).unwrap(), &expected);
}

#[test]
fn test_autonomous_position_round_trip_and_landblock_carry_forward() {
    let original = ServerAutonomousPositionData {
        guid: Guid(0x5000_0001),
        coords: holtburger_common::math::Vector3 {
            x: 91.5,
            y: 12.25,
            z: 0.005,
        },
        rotation: holtburger_common::math::Quaternion {
            w: 0.7071,
            x: 0.0,
            y: 0.0,
            z: 0.7071,
        },
        instance_sequence: 7,
        server_control_sequence: 8,
        teleport_sequence: 9,
        force_position_sequence: 10,
        contact_flags: 1,
    };

    let mut buf = Vec::new();
    original.pack(&mut buf);
    // guid(4) + xyz(12) + quat(16) + 4 seqs(8) + contact(4) — no cell id.
    assert_eq!(buf.len(), 44);

    let mut offset = 0;
    let decoded = ServerAutonomousPositionData::unpack(&buf, &mut offset).unwrap();
    assert_eq!(offset, buf.len());
    assert_eq!(decoded, original);

    // The receiver carries its current landblock forward.
    let pos = decoded.position_in(Guid(0xA9B4_0021));
    assert_eq!(pos.landblock_id, Guid(0xA9B4_0021));
    assert_eq!(pos.coords, original.coords);
    assert_eq!(pos.rotation, original.rotation);
}

#[test]
fn test_player_teleport_parity() {
    let expected = PlayerTeleportData {
        teleport_sequence: 0x1234,
    };
    // Skip opcode (4 bytes)
    assert_pack_unpack_parity(&test_fixtures::PLAYER_TELEPORT[4..], &expected);

    // Also verify dispatcher integration
    let msg = GameMessage::unpack(test_fixtures::PLAYER_TELEPORT, &mut 0).unwrap();
    assert!(matches!(msg, GameMessage::PlayerTeleport(_)));
}

#[test]
fn test_player_teleport_fixture() {
    let expected = GameMessage::PlayerTeleport(Box::new(PlayerTeleportData {
        teleport_sequence: 0,
    }));
    let hex = "51F7000000000000";
    let data = hex::decode(hex).unwrap();
    assert_pack_unpack_parity(&data, &expected);
}

#[test]
fn test_movement_event_turn_to_obj_fixture() {
    let fixture = test_fixtures::MOVEMENT_TURN_TO_OBJ;
    let mut offset = 0;
    let unpacked = GameMessage::unpack(fixture, &mut offset).expect("Should unpack TurnToObj");
    let mut packed = Vec::new();
    unpacked.pack(&mut packed);
    assert_eq!(packed, fixture);
}

#[test]
fn test_movement_event_move_to_pos_fixture() {
    let fixture = test_fixtures::MOVEMENT_MOVE_TO_POS;
    let mut offset = 0;
    let unpacked = GameMessage::unpack(fixture, &mut offset).expect("Should unpack MoveToPos");
    let mut packed = Vec::new();
    unpacked.pack(&mut packed);
    assert_eq!(packed, fixture);
}

#[test]
fn test_movement_event_stop_completely_has_no_body() {
    // A5 / MOVEDATA-1: retail `MovementManager::unpack_movement` (acclient.c:339491)
    // reads the InterpretedMotionState body ONLY for movement_type 0; types 1-5
    // (here StopCompletely=5) hit the `default:` arm and read NO body bytes.
    // The 16-byte frame ends exactly at `current_style`; unpack must consume all
    // 16 bytes and produce an empty MovementInvalid, and pack must reproduce them.
    use crate::messages::movement::types::MovementType;

    // guid=0x50000001 | inst=1 | mvmt_seq=2 | ctrl_seq=3 | autonomous=0 | pad |
    // type=5 (StopCompletely) | motion_flags=0 | current_style=0 | <no body>
    let hex = "01000050010002000300000005000000";
    let bytes = hex::decode(hex).unwrap();

    let expected = MovementEventData {
        guid: Guid(0x50000001),
        object_instance_sequence: 1,
        movement_sequence: 2,
        server_control_sequence: 3,
        is_autonomous: false,
        movement_type: MovementType::StopCompletely,
        motion_flags: 0,
        current_style: 0,
        data: MovementTypeData::Invalid(MovementInvalid::default()),
    };

    // unpack consumes exactly 16 bytes (no over-read), matches, and re-packs 1:1.
    let mut offset = 0;
    let unpacked = MovementEventData::unpack(&bytes, &mut offset).expect("unpack StopCompletely");
    assert_eq!(
        offset,
        bytes.len(),
        "must consume exactly the header, no body over-read"
    );
    assert_eq!(unpacked, expected);

    let mut packed = Vec::new();
    unpacked.pack(&mut packed);
    assert_eq!(packed, bytes, "StopCompletely must pack with no body bytes");
}

#[test]
fn test_gamemessage_routing_update_position() {
    let pos_hex = "48F7000015000000000000005C8F1E120000000000000000000000000000803F0000000000000000000000000100020003000400";
    let pos_data = hex::decode(pos_hex).unwrap();
    let mut offset = 0;
    let pos_msg = GameMessage::unpack(&pos_data, &mut offset).unwrap();
    assert!(matches!(pos_msg, GameMessage::UpdatePosition(_)));
}

#[test]
fn test_move_to_parameters_default_size() {
    let params = MoveToParameters::default();
    let mut buf = Vec::new();
    params.pack(&mut buf);
    assert_eq!(buf.len(), 28);
}

#[test]
fn test_turn_to_parameters_default_size() {
    let params = TurnToParameters {
        movement_parameters: 0,
        speed: 0.0,
        desired_heading: 0.0,
    };
    let mut buf = Vec::new();
    params.pack(&mut buf);
    assert_eq!(buf.len(), 12);
}
