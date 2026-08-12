use super::*;
use binrw::BinRead;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use web_time::Instant;

use crate::entity::Entity;
use crate::state::liveness::EntityUpsertKind;
use crate::{
    ContactState, RuntimeBodyResetCause, SolveProjectionBasis, SolvedBodyKinematics,
    SpatialBodyEvent, SpatialBodyId, SpatialSampleMode, WorldBootstrap,
};

use crate::stats::{Skill, SkillType, TrainingLevel};
use holtburger_common::position::WorldPosition;
use holtburger_common::properties::{
    PhysicsState, PropertyBool, PropertyInt, PropertyInt64, WorldObjectExt as _,
    WorldObjectProperties, WorldObjectPropertyAccessors, WorldObjectPropertyAccessorsMut,
};
use holtburger_common::{CharacterOption, CharacterOptions1, CharacterOptions2};
use holtburger_content::SoulEmoteCatalog;
use holtburger_dat::file_type::{
    MotionCommandKinematics, MotionKinematics, MotionKinematicsTable, MotionTable, SkillTable,
    SpellTable, XpTable,
};
use holtburger_dat::{
    DatFileType, EOR_PORTAL_NAMESPACE, HOLTBURGER_CORE_NAMESPACE, HbaReader, HbaWriter,
};
use holtburger_protocol::messages::game_event::{GameEvent, GameEventMessage};
use holtburger_protocol::messages::movement::{
    InterpretedMotionCommand, InterpretedMotionState, MotionStance, MovementStateFlags,
};
use holtburger_protocol::messages::object::events::UpdateHealthEventData;
use holtburger_protocol::messages::{
    BookDataResponseEventData, BookPageData, BookPageDataResponseEventData, FellowUpdateType,
    FellowshipFullUpdateEventData, FellowshipMemberData, FellowshipQuitEventData,
    FellowshipUpdateFellowEventData, GameMessage, PlayerTeleportData,
};
use holtburger_protocol::traits::ProtocolPack;
use tempfile::tempdir;

fn repo_assets_hba_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../dats/assets.hba")
}

fn test_motion_kinematics_bytes() -> Vec<u8> {
    let mut bytes = std::io::Cursor::new(Vec::new());
    MotionKinematics::new()
        .write(&mut bytes)
        .expect("test motion kinematics asset should write");
    bytes.into_inner()
}

fn write_micro_portal_hba(path: &Path) -> bool {
    let source_path = repo_assets_hba_path();
    if !source_path.is_file() {
        eprintln!(
            "skipping assets fixture test; missing repo-local {}",
            source_path.display()
        );
        return false;
    }
    let source = match HbaReader::open(&source_path) {
        Ok(source) => source,
        Err(error) => panic!(
            "repo-local {} must be a valid HBA v2 fixture for this test: {}",
            source_path.display(),
            error
        ),
    };

    let mut writer = HbaWriter::new();
    writer.set_compression(false);

    for id in [SkillTable::FILE_ID, SpellTable::FILE_ID, XpTable::FILE_ID] {
        let data = source
            .get_file_in_namespace(EOR_PORTAL_NAMESPACE, id)
            .unwrap_or_else(|_| panic!("repo assets.hba should contain eor/portal:0x{id:08X}"));
        writer
            .add(
                EOR_PORTAL_NAMESPACE,
                id,
                DatFileType::from_id(id) as u32,
                data,
            )
            .expect("micro table should be added to test HBA");
    }

    writer
        .add(
            HOLTBURGER_CORE_NAMESPACE,
            MotionKinematics::FILE_ID,
            DatFileType::MotionKinematics as u32,
            test_motion_kinematics_bytes(),
        )
        .expect("motion kinematics table should be added to test HBA");

    writer
        .write(path)
        .expect("micro portal.hba should be written");

    true
}

fn motion_kinematics_asset_with_table(
    motion_table_id: u32,
    default_style: u32,
    walk_velocity: Option<Vector3>,
    run_velocity: Option<Vector3>,
    turn_left_omega: Option<Vector3>,
    turn_right_omega: Option<Vector3>,
) -> MotionKinematics {
    let mut asset = MotionKinematics::new();
    let mut table = MotionKinematicsTable::new(motion_table_id, default_style);

    if let Some(velocity) = walk_velocity {
        table.insert_cycle_kinematics(
            default_style,
            MotionTable::WALK_FORWARD_COMMAND,
            MotionCommandKinematics {
                velocity: Some(velocity),
                omega: None,
            },
        );
    }

    if let Some(velocity) = run_velocity {
        table.insert_cycle_kinematics(
            default_style,
            MotionTable::RUN_FORWARD_COMMAND,
            MotionCommandKinematics {
                velocity: Some(velocity),
                omega: None,
            },
        );
    }

    if let Some(omega) = turn_left_omega {
        table.insert_cycle_kinematics(
            default_style,
            MotionTable::TURN_LEFT_COMMAND,
            MotionCommandKinematics {
                velocity: None,
                omega: Some(omega),
            },
        );
    }

    if let Some(omega) = turn_right_omega {
        table.insert_cycle_kinematics(
            default_style,
            MotionTable::TURN_RIGHT_COMMAND,
            MotionCommandKinematics {
                velocity: None,
                omega: Some(omega),
            },
        );
    }

    asset.motion_tables.insert(motion_table_id, table);
    asset
}

fn test_motion_kinematics_asset(motion_table_id: u32) -> MotionKinematics {
    motion_kinematics_asset_with_table(
        motion_table_id,
        MotionStance::NonCombat as u32,
        Some(Vector3::new(1.0, 0.0, 0.0)),
        Some(Vector3::new(2.5, 0.0, 0.0)),
        Some(Vector3::new(0.0, 0.0, -1.5)),
        Some(Vector3::new(0.0, 0.0, 1.5)),
    )
}

fn seed_player_run_skill(world: &mut WorldState, run_skill: u32) {
    world.player.skills.insert(
        SkillType::Run,
        Skill {
            skill_type: SkillType::Run,
            ranks: 0,
            init: run_skill,
            spent_xp: 0,
            next_rank_xp: None,
            base: run_skill,
            current: run_skill,
            training: TrainingLevel::Trained,
            trained_cost: 0,
            specialized_cost: 0,
        },
    );
}

#[test]
fn resolve_player_motion_table_profile_prefers_direct_motion_table_property() {
    let motion_table_id = 0x0900_0020;

    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0001);
    state.set_motion_kinematics(test_motion_kinematics_asset(motion_table_id));
    state.player.guid = player_guid;

    let mut player = Entity::new(player_guid, "Player".to_string(), WorldPosition::default());
    player.properties.set_did_prop(
        holtburger_common::properties::PropertyDataId::MotionTable,
        Guid(motion_table_id),
    );
    player.properties.set_did_prop(
        holtburger_common::properties::PropertyDataId::Setup,
        Guid(0x0200_0010),
    );
    state.entities.insert(player);

    let resolved = state
        .resolve_player_motion_table_profile()
        .expect("direct motion table should resolve");

    assert_eq!(
        resolved.source,
        PlayerMotionTableSource::DirectProperty { motion_table_id }
    );
    assert_eq!(
        resolved
            .movement_profile
            .run_forward
            .and_then(|entry| entry.velocity),
        Some(Vector3::new(2.5, 0.0, 0.0))
    );
}

#[test]
fn resolve_player_motion_table_profile_falls_back_to_setup_model_default() {
    let motion_table_id = 0x0900_0020;
    let setup_model_id = 0x0200_0010;

    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0002);
    let mut motion_kinematics = test_motion_kinematics_asset(motion_table_id);
    motion_kinematics
        .setup_model_defaults
        .insert(setup_model_id, motion_table_id);
    state.set_motion_kinematics(motion_kinematics);
    state.player.guid = player_guid;

    let mut player = Entity::new(player_guid, "Player".to_string(), WorldPosition::default());
    player.properties.set_did_prop(
        holtburger_common::properties::PropertyDataId::Setup,
        Guid(setup_model_id),
    );
    state.entities.insert(player);

    let resolved = state
        .resolve_player_motion_table_profile()
        .expect("setup-model fallback should resolve");

    assert_eq!(
        resolved.source,
        PlayerMotionTableSource::SetupModelDefault {
            setup_model_id,
            motion_table_id,
        }
    );
    assert_eq!(
        resolved
            .movement_profile
            .turn_right
            .and_then(|entry| entry.omega),
        Some(Vector3::new(0.0, 0.0, 1.5))
    );
}

#[test]
fn resolve_player_motion_table_profile_reads_run_speed_from_required_motion_kinematics_asset() {
    let motion_table_id = 0x0900_0023;

    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0004);
    state.set_motion_kinematics(test_motion_kinematics_asset(motion_table_id));
    state.player.guid = player_guid;

    let mut player = Entity::new(player_guid, "Player".to_string(), WorldPosition::default());
    player.properties.set_did_prop(
        holtburger_common::properties::PropertyDataId::MotionTable,
        Guid(motion_table_id),
    );
    state.entities.insert(player);

    let resolved = state
        .resolve_player_motion_table_profile()
        .expect("run speed should derive from animation position frames");

    assert_eq!(resolved.movement_profile.motion_table_id, motion_table_id);
    assert_eq!(
        resolved
            .movement_profile
            .run_forward
            .and_then(|entry| entry.velocity),
        Some(Vector3::new(2.5, 0.0, 0.0))
    );
}

#[test]
fn resolve_player_motion_table_profile_reports_missing_setup_default_motion_table() {
    let setup_model_id = 0x0200_0011;

    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0003);
    state.player.guid = player_guid;

    let mut player = Entity::new(player_guid, "Player".to_string(), WorldPosition::default());
    player.properties.set_did_prop(
        holtburger_common::properties::PropertyDataId::Setup,
        Guid(setup_model_id),
    );
    state.entities.insert(player);

    let error = state
        .resolve_player_motion_table_profile()
        .expect_err("missing setup default motion table should be explicit");

    assert!(matches!(
        error,
        PlayerMotionTableLookupError::SetupModelMissingDefaultMotionTable { setup_model_id: id }
            if id == setup_model_id
    ));
}

#[test]
fn resolve_self_movement_capabilities_combines_run_rate_and_motion_table_kinematics() {
    let motion_table_id = 0x0900_0020;

    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0100);
    state.set_motion_kinematics(test_motion_kinematics_asset(motion_table_id));
    state.player.guid = player_guid;
    seed_player_run_skill(&mut state, 800);

    let mut player = Entity::new(player_guid, "Player".to_string(), WorldPosition::default());
    player.properties.set_did_prop(
        holtburger_common::properties::PropertyDataId::MotionTable,
        Guid(motion_table_id),
    );
    state.entities.insert(player);

    let capabilities = state
        .resolve_self_movement_capabilities()
        .expect("self-movement capabilities should resolve");

    assert_eq!(capabilities.motion_table_id(), motion_table_id);
    assert_eq!(capabilities.run_rate_scalar, 4.5);
    assert_eq!(capabilities.base_walk_forward_speed(), 1.0);
    assert_eq!(capabilities.base_run_forward_speed(), 2.5);
    assert_eq!(capabilities.resolved_manual_run_speed(), 11.25);
    assert_eq!(capabilities.resolved_autonomous_run_speed(1.0), 11.25);
    assert_eq!(capabilities.resolved_autonomous_run_speed(1.5), 16.875);
    assert_eq!(capabilities.base_turn_left_speed_rad_per_sec(), 1.5);
    assert_eq!(capabilities.base_turn_right_speed_rad_per_sec(), 1.5);
    assert_eq!(
        capabilities.resolved_manual_run_velocity(),
        Vector3::new(11.25, 0.0, 0.0)
    );
}

#[test]
fn resolve_self_movement_capabilities_prefers_synthetic_override() {
    let mut state = WorldState::synthetic();
    let override_capabilities = SelfMovementCapabilities {
        kinematics: crate::state::SelfMovementKinematics {
            source: PlayerMotionTableSource::DirectProperty {
                motion_table_id: 0x0900_00AA,
            },
            motion_table_id: 0x0900_00AA,
            stance: MotionStance::NonCombat as u32,
            base_walk_forward_velocity: Vector3::new(0.75, 0.0, 0.0),
            base_run_forward_velocity: Vector3::new(2.0, 0.0, 0.0),
            base_turn_left_omega: Vector3::new(0.0, 0.0, -1.25),
            base_turn_right_omega: Vector3::new(0.0, 0.0, 1.25),
        },
        run_rate_scalar: 3.25,
    };
    state.set_self_movement_capabilities_override(override_capabilities.clone());

    let resolved = state
        .resolve_self_movement_capabilities()
        .expect("synthetic override should bypass resource lookup");

    assert_eq!(resolved, override_capabilities);
}

#[test]
fn resolve_self_movement_capabilities_reports_missing_required_kinematics() {
    let motion_table_id = 0x0900_0021;

    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0101);
    state.set_motion_kinematics(motion_kinematics_asset_with_table(
        motion_table_id,
        MotionStance::NonCombat as u32,
        Some(Vector3::new(1.0, 0.0, 0.0)),
        None,
        Some(Vector3::new(0.0, 0.0, -1.5)),
        Some(Vector3::new(0.0, 0.0, 1.5)),
    ));
    state.player.guid = player_guid;
    seed_player_run_skill(&mut state, 800);

    let mut player = Entity::new(player_guid, "Player".to_string(), WorldPosition::default());
    player.properties.set_did_prop(
        holtburger_common::properties::PropertyDataId::MotionTable,
        Guid(motion_table_id),
    );
    state.entities.insert(player);

    let error = state
        .resolve_self_movement_capabilities()
        .expect_err("missing run velocity should be explicit");

    assert!(matches!(
        error,
        SelfMovementCapabilitiesError::Kinematics(
            crate::state::SelfMovementKinematicsError::MissingRequiredKinematics {
                motion_table_id: id,
                kind: RequiredSelfMovementKinematics::RunForwardVelocity,
                ..
            }
        ) if id == motion_table_id
    ));
}

#[test]
fn resolve_self_movement_capabilities_falls_back_when_walk_velocity_is_missing() {
    let motion_table_id = 0x0900_0022;

    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0102);
    state.set_motion_kinematics(motion_kinematics_asset_with_table(
        motion_table_id,
        MotionStance::NonCombat as u32,
        None,
        Some(Vector3::new(2.5, 0.0, 0.0)),
        Some(Vector3::new(0.0, 0.0, -1.5)),
        Some(Vector3::new(0.0, 0.0, 1.5)),
    ));
    state.player.guid = player_guid;
    seed_player_run_skill(&mut state, 800);

    let mut player = Entity::new(player_guid, "Player".to_string(), WorldPosition::default());
    player.properties.set_did_prop(
        holtburger_common::properties::PropertyDataId::MotionTable,
        Guid(motion_table_id),
    );
    state.entities.insert(player);

    let capabilities = state
        .resolve_self_movement_capabilities()
        .expect("missing walk velocity should fall back to run-forward data");

    assert_eq!(capabilities.base_walk_forward_speed(), 2.5);
    assert_eq!(capabilities.base_run_forward_speed(), 2.5);
}

#[test]
fn resolve_self_movement_capabilities_derives_left_turn_from_right_turn_omega() {
    let motion_table_id: u32 = 0x0900_0024;
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0103);
    state.set_motion_kinematics(motion_kinematics_asset_with_table(
        motion_table_id,
        MotionStance::NonCombat as u32,
        Some(Vector3::new(1.0, 0.0, 0.0)),
        Some(Vector3::new(2.5, 0.0, 0.0)),
        None,
        Some(Vector3::new(0.0, 0.0, -1.5)),
    ));
    state.player.guid = player_guid;
    seed_player_run_skill(&mut state, 800);

    let mut player = Entity::new(player_guid, "Player".to_string(), WorldPosition::default());
    player.properties.set_did_prop(
        holtburger_common::properties::PropertyDataId::MotionTable,
        Guid(motion_table_id),
    );
    state.entities.insert(player);

    let capabilities = state
        .resolve_self_movement_capabilities()
        .expect("single-turn motion tables should still resolve turn capabilities");

    assert_eq!(
        capabilities.kinematics().base_turn_right_omega,
        Vector3::new(0.0, 0.0, -1.5)
    );
    assert_eq!(
        capabilities.kinematics().base_turn_left_omega,
        Vector3::new(0.0, 0.0, 1.5)
    );
}

#[test]
fn resolve_body_projection_input_uses_grounded_motion_snapshot_without_vector_update() {
    let motion_table_id = 0x0900_0040;
    let guid = Guid(0x7000_0100);
    let pose = WorldPosition {
        landblock_id: Guid(0x1234_0000),
        coords: Vector3::new(10.0, 20.0, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    let mut state = WorldState::synthetic();
    state.set_motion_kinematics(test_motion_kinematics_asset(motion_table_id));

    let mut entity = Entity::new(guid, "Remote".to_string(), pose);
    entity.properties.set_did_prop(
        holtburger_common::properties::PropertyDataId::MotionTable,
        Guid(motion_table_id),
    );
    entity.motion_snapshot = Some(crate::entity::EntityMotionSnapshot {
        current_style: Some(MotionStance::NonCombat),
        forward_command: Some(InterpretedMotionCommand::RUN_FORWARD),
        sidestep_command: None,
        turn_command: Some(InterpretedMotionCommand::TURN_RIGHT),
        forward_speed: crate::entity::OrderedMotionSpeed::from_f32(3.5),
        sidestep_speed: None,
        turn_speed: crate::entity::OrderedMotionSpeed::from_f32(0.75),
        directive: None,
        ..Default::default()
    });
    state.entities.insert(entity);

    state.scene.reconcile_authoritative_body(
        SpatialBodyId::Entity(guid),
        pose,
        Vector3::zero(),
        Vector3::zero(),
        crate::AuthoritativeBodySync::Snapshot,
        Instant::now(),
    );
    assert!(
        state
            .scene
            .apply_runtime_body_contact(SpatialBodyId::Entity(guid), ContactState::Grounded)
    );

    let input = state
        .resolve_body_projection_input(SpatialBodyId::Entity(guid))
        .expect("guid-backed remote body should resolve projection input");

    assert_eq!(input.contact, ContactState::Grounded);
    assert!(matches!(
        input.basis,
        Some(SolveProjectionBasis::GroundedMotion {
            desired_local_velocity,
            desired_local_omega,
        }) if desired_local_velocity == Vector3::new(3.5, 0.0, 0.0)
            && desired_local_omega == Vector3::new(0.0, 0.0, 0.75)
    ));
}

#[test]
fn resolve_body_projection_input_falls_back_to_velocity_for_airborne_body() {
    let guid = Guid(0x7000_0101);
    let pose = WorldPosition {
        landblock_id: Guid(0x1234_0000),
        coords: Vector3::new(1.0, 2.0, 3.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    let mut state = WorldState::synthetic();
    let mut entity = Entity::new(guid, "Remote".to_string(), pose);
    entity.velocity = Vector3::new(0.0, 0.0, 4.0);
    entity.omega = Vector3::new(0.0, 0.0, 0.5);
    entity.motion_snapshot = Some(crate::entity::EntityMotionSnapshot {
        current_style: Some(MotionStance::NonCombat),
        forward_command: Some(InterpretedMotionCommand::RUN_FORWARD),
        sidestep_command: None,
        turn_command: Some(InterpretedMotionCommand::TURN_RIGHT),
        forward_speed: None,
        sidestep_speed: None,
        turn_speed: None,
        directive: None,
        ..Default::default()
    });
    state.entities.insert(entity);

    state.scene.reconcile_authoritative_body(
        SpatialBodyId::Entity(guid),
        pose,
        Vector3::new(0.0, 0.0, 4.0),
        Vector3::new(0.0, 0.0, 0.5),
        crate::AuthoritativeBodySync::Snapshot,
        Instant::now(),
    );
    assert!(
        state
            .scene
            .apply_runtime_body_contact(SpatialBodyId::Entity(guid), ContactState::Airborne)
    );

    let input = state
        .resolve_body_projection_input(SpatialBodyId::Entity(guid))
        .expect("airborne guid-backed body should resolve projection input");

    assert!(matches!(
        input.basis,
        Some(SolveProjectionBasis::Velocity { velocity, omega })
            if velocity == Vector3::new(0.0, 0.0, 4.0)
                && omega == Vector3::new(0.0, 0.0, 0.5)
    ));
}

#[test]
fn test_set_player_vector_updates_authoritative_player_entity() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000123);
    state.player.guid = player_guid;

    let initial_pos = WorldPosition::default();
    let player_entity = Entity::new(player_guid, "Player".to_string(), initial_pos);
    state.entities.insert(player_entity);

    let new_vel = Vector3::new(1.0, 2.0, 3.0);
    let new_omega = Vector3::new(0.0, 0.0, 4.0);
    let events = state.set_player_vector(new_vel, new_omega);

    assert_eq!(state.entities.get(player_guid).unwrap().velocity, new_vel);
    assert_eq!(state.entities.get(player_guid).unwrap().omega, new_omega);
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::EntityVectorUpdated { guid, velocity, omega }
            if *guid == player_guid && *velocity == new_vel && *omega == new_omega
    )));
}

/// Item A3 (OQ-1): with `USE_VECTOR_SEQUENCE_GATE` enabled (its shipped
/// default since 2026-06-04, after `~/ace-server` source confirmed ACE
/// bumps `ObjectVector` per broadcast via `GetNextSequence`),
/// `set_player_vector_gated` mirrors retail `SmartBox::DoVectorUpdate`:
/// a stale (older/equal) `vector_sequence` is REJECTED (velocity
/// untouched, no event, stored stamp unchanged) and a strictly-newer
/// stamp is applied and advances the stored stamp.
#[test]
fn vector_sequence_gate_rejects_stale_applies_newer() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0124);
    state.player.guid = player_guid;
    state.player.vector_sequence = 100;

    let player_entity = Entity::new(player_guid, "Player".to_string(), WorldPosition::default());
    state.entities.insert(player_entity);
    let before_vel = state.entities.get(player_guid).unwrap().velocity;

    // Stale: incoming 50 is OLDER than stored 100 -> rejected.
    let stale_vel = Vector3::new(7.0, 8.0, 9.0);
    let events = state.set_player_vector_gated(stale_vel, Vector3::new(0.0, 0.0, 1.0), 50);
    assert_eq!(
        state.entities.get(player_guid).unwrap().velocity,
        before_vel,
        "stale vector_sequence must be rejected (velocity unchanged)"
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, WorldEvent::EntityVectorUpdated { .. })),
        "a rejected stale update emits no EntityVectorUpdated"
    );
    assert_eq!(
        state.player.vector_sequence, 100,
        "stored stamp is unchanged on reject"
    );

    // Newer: incoming 150 is NEWER than stored 100 -> applied + advances.
    let fresh_vel = Vector3::new(1.0, 2.0, 3.0);
    let events = state.set_player_vector_gated(fresh_vel, Vector3::new(0.0, 0.0, 2.0), 150);
    assert_eq!(
        state.entities.get(player_guid).unwrap().velocity,
        fresh_vel,
        "newer vector_sequence is applied"
    );
    assert!(
        events.iter().any(|event| matches!(
            event,
            WorldEvent::EntityVectorUpdated { guid, .. } if *guid == player_guid
        )),
        "an accepted update emits EntityVectorUpdated"
    );
    assert_eq!(
        state.player.vector_sequence, 150,
        "stored stamp advances to the accepted value"
    );
}

/// Item A3 (OQ-1): manually exercise the gate predicate so the gated
/// path is covered regardless of the compile-time flag's default. The
/// gate accepts a strictly-newer stamp and rejects an older/equal one,
/// mirroring retail `SmartBox::DoVectorUpdate`
/// (acclient.c:143459-143480 → `is_newer_u16`).
#[test]
fn vector_sequence_gate_predicate_matches_retail() {
    use holtburger_common::sequence::is_newer_u16;

    // Stored 100: a newer stamp (101) is accepted; equal (100) and
    // older (50) are rejected — the exact accept/reject the gated
    // VectorUpdate path applies when USE_VECTOR_SEQUENCE_GATE is on.
    assert!(
        is_newer_u16(101, 100),
        "strictly-newer vector_sequence accepted"
    );
    assert!(!is_newer_u16(100, 100), "equal vector_sequence rejected");
    assert!(!is_newer_u16(50, 100), "stale vector_sequence rejected");
    // Wrap boundary: 0 is newer than u16::MAX.
    assert!(
        is_newer_u16(0, u16::MAX),
        "wrapped vector_sequence accepted"
    );
}

/// Item B6 (SEQ-5): the position-only newer-gate is layered UNDER teleport
/// and force. With teleport+force unchanged a stale/equal `position_sequence`
/// is rejected and a strictly-newer one accepted (retail acclient.c:145167
/// `newer_event(object, 0, position_ts)`); a newer teleport/force is an
/// authoritative snap that bypasses the position gate; the autonomous frame
/// (no position stamp -> `None`) skips it entirely.
#[test]
fn position_sequence_gate_is_layered_under_teleport_and_force() {
    let mut state = WorldState::synthetic();
    state.player.teleport_sequence = 5;
    state.player.force_position_sequence = 3;
    state.player.position_sequence = 100;

    // Position-only (teleport+force unchanged): stale/equal rejected, newer accepted.
    assert!(
        !state
            .player
            .should_accept_server_position_sequences(5, 3, Some(50)),
        "stale position-only update is rejected"
    );
    assert!(
        !state
            .player
            .should_accept_server_position_sequences(5, 3, Some(100)),
        "equal position-only update is rejected"
    );
    assert!(
        state
            .player
            .should_accept_server_position_sequences(5, 3, Some(150)),
        "newer position-only update is accepted"
    );
    // A newer teleport is an authoritative snap -> bypasses the position gate.
    assert!(
        state
            .player
            .should_accept_server_position_sequences(6, 3, Some(50)),
        "newer teleport bypasses the position gate despite a stale position_sequence"
    );
    // Autonomous frames carry no position stamp -> the gate is skipped.
    assert!(
        state
            .player
            .should_accept_server_position_sequences(5, 3, None),
        "autonomous frame (None) skips the position gate"
    );
}

/// Item A4: the 0xF619 `PositionAndMovementEvent` handler arm applies
/// BOTH halves of the combined materialize frame — the `PositionPack`
/// (UpdatePosition path) AND the motion snapshot (UpdateMotion path) —
/// for a remote entity, and is `handled` (does not fall through to the
/// `_ => false` catch-all). Mirrors the existing UpdatePosition/
/// UpdateMotion remote-entity handler tests.
#[test]
fn position_and_movement_event_applies_position_and_motion() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x6000_0A19);
    let initial_pos = WorldPosition {
        landblock_id: Guid(0x00A9_0001),
        coords: Vector3::new(1.0, 2.0, 3.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    state
        .entities
        .insert(Entity::new(guid, "Target".to_string(), initial_pos));

    let pos = PositionPack {
        flags: UpdatePositionFlag::IS_GROUNDED,
        pos: WorldPosition {
            landblock_id: Guid(0x00A9_0001),
            coords: Vector3::new(61.0, 71.0, 12.5),
            rotation: holtburger_common::math::Quaternion::identity(),
        },
        velocity: None,
        placement_id: None,
        instance_sequence: 1,
        position_sequence: 2,
        teleport_sequence: 3,
        force_position_sequence: 4,
    };
    let movement = MovementEventData {
        guid,
        object_instance_sequence: 0,
        movement_sequence: 1,
        server_control_sequence: 1,
        is_autonomous: false,
        movement_type: MovementType::Invalid,
        motion_flags: 0,
        current_style: 0,
        data: MovementTypeData::Invalid(MovementInvalid::default()),
    };
    let msg = GameMessage::PositionAndMovementEvent(Box::new(PositionAndMovementEventData {
        guid,
        pos,
        movement,
    }));

    let events = state.handle_message(&msg);

    // Position half applied:
    assert_eq!(state.entities.get(guid).unwrap().position.coords.x, 61.0);
    // Motion half applied (a snapshot was materialized + an event emitted):
    assert!(
        state.entities.get(guid).unwrap().motion_snapshot.is_some(),
        "motion snapshot must be set from the 0xF619 movement body"
    );
    assert!(
        events.iter().any(
            |event| matches!(event, WorldEvent::EntityMotionUpdated { guid: g, .. } if *g == guid)
        ),
        "0xF619 must emit EntityMotionUpdated (not fall through to _ => false)"
    );
}

#[test]
fn set_local_player_runtime_pose_only_emits_runtime_body_change() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0123);
    let start_pos = WorldPosition {
        landblock_id: Guid(0x1234_0000),
        coords: Vector3::new(1.0, 2.0, 3.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    state.seed_local_player_entity(player_guid, "Player", start_pos);

    let events = state.set_local_player_runtime_pose(WorldPosition {
        coords: Vector3::new(4.0, 5.0, 6.0),
        ..start_pos
    });

    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::RuntimeBodyChanged {
            body_id: SpatialBodyId::LocalPlayer(guid)
        } if *guid == player_guid
    )));
    assert!(!events.iter().any(
        |event| matches!(event, WorldEvent::EntityMoved { guid, .. } if *guid == player_guid)
    ));
}

/// REGRESSION GUARD for the interior walk-in render bug fixed at
/// `apps/holtburger-web/src/lib.rs` `publish_cell_scene_snapshot`.
///
/// On a WALKED-IN EnvCell entry the client-local transition
/// (`USE_LOCAL_ENVCELL_ENTRY`) flips ONLY the runtime body's pose to the
/// interior cell via `set_local_player_runtime_pose`; there is no server
/// `UpdatePosition`, so the server-mirrored `entity.position` keeps the
/// OUTDOOR landblock. The cell-visibility snapshot MUST therefore read
/// `local_player_runtime_pose()` (indoor) — reading `player_position()`
/// (outdoor) leaves `is_indoor=false`, takes the outdoor render-set branch,
/// and hides the entire interior (floors + walls + stab-list furniture) while
/// server-weenie NPCs (a separate scene subtree) keep rendering. Teleport
/// masked the bug because it writes `entity.position` to the interior cell
/// directly. This asserts the exact `is_indoors()` divergence the fix keys
/// off of.
#[test]
fn walked_in_envcell_entry_flips_runtime_pose_indoors_while_entity_pose_stays_outdoors() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0158);

    // Player stands OUTDOORS in Holtburg (landblock 0xA9B4, outdoor cell 0x21).
    let outdoor_pos = WorldPosition {
        landblock_id: Guid(0xA9B4_0021),
        coords: Vector3::new(84.0, 131.5, 66.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    state.seed_local_player_entity(player_guid, "Player", outdoor_pos);

    // Arm the integrator like normal outdoor movement (runtime body live).
    let _ = state.set_local_player_runtime_pose(outdoor_pos);
    assert!(
        !state.player_position().expect("entity pose").is_indoors(),
        "precondition: entity pose starts outdoors"
    );
    assert!(
        !state
            .local_player_runtime_pose()
            .expect("runtime pose")
            .is_indoors(),
        "precondition: runtime pose starts outdoors"
    );

    // WALK-IN: local EnvCell entry flips ONLY the runtime body to the interior
    // EnvCell (low16 >= 0x0100). No server UpdatePosition → entity.position is
    // left untouched.
    let interior_pos = WorldPosition {
        landblock_id: Guid(0xA9B4_0158),
        ..outdoor_pos
    };
    let _ = state.set_local_player_runtime_pose(interior_pos);

    // The runtime pose (what the cell-visibility snapshot + camera must read)
    // is now INDOORS at the interior EnvCell.
    let runtime = state.local_player_runtime_pose().expect("runtime pose");
    assert_eq!(runtime.landblock_id, Guid(0xA9B4_0158));
    assert!(
        runtime.is_indoors(),
        "walk-in must flip the runtime pose indoors"
    );

    // ...while the server-mirrored entity pose is STILL outdoors. Reading THIS
    // in publish_cell_scene_snapshot is the bug: is_indoor stays false and the
    // interior is culled.
    let entity = state.player_position().expect("entity pose");
    assert_eq!(entity.landblock_id, Guid(0xA9B4_0021));
    assert!(
        !entity.is_indoors(),
        "walk-in must NOT move the server entity pose"
    );

    // The two sources diverge on `is_indoors()` — the discriminator that
    // selects getRenderSetWithFrustum's indoor vs outdoor branch. The fix
    // reads the runtime pose so the interior renders on a walked-in entry.
    assert_ne!(
        runtime.is_indoors(),
        entity.is_indoors(),
        "runtime pose (indoor) must diverge from entity pose (outdoor) on walk-in"
    );
}

#[test]
fn solved_remote_runtime_body_only_emits_runtime_body_change() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x5000_0222);
    let pose = WorldPosition {
        landblock_id: Guid(0x1234_0000),
        coords: Vector3::new(2.0, 3.0, 4.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    state.add_entity(Entity::new(guid, "Remote".to_string(), pose));

    let events = state.apply_solved_body_kinematics(&SolvedBodyKinematics {
        body_id: SpatialBodyId::Entity(guid),
        pose: WorldPosition {
            coords: Vector3::new(5.0, 6.0, 4.0),
            ..pose
        },
        velocity: Vector3::new(1.0, 0.0, 0.0),
        omega: Vector3::zero(),
        contact: ContactState::Grounded,
        projection_state: None,
    });

    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::RuntimeBodyChanged {
            body_id: SpatialBodyId::Entity(event_guid)
        } if *event_guid == guid
    )));
    assert!(!events.iter().any(|event| matches!(
        event,
        WorldEvent::EntityMoved { guid: event_guid, .. } if *event_guid == guid
    )));
    assert!(!events.iter().any(|event| matches!(
        event,
        WorldEvent::EntityVectorUpdated { guid: event_guid, .. } if *event_guid == guid
    )));
}

#[test]
fn authoritative_player_snapshots_do_not_clobber_active_local_runtime_motion() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0125);
    let authoritative_pose = WorldPosition {
        landblock_id: Guid(0x1234_0000),
        coords: Vector3::new(1.0, 2.0, 3.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let runtime_pose = WorldPosition {
        coords: Vector3::new(10.0, 20.0, 3.0),
        ..authoritative_pose
    };

    state.seed_local_player_entity(player_guid, "Player", authoritative_pose);

    let runtime_events = state.apply_solved_body_kinematics(&SolvedBodyKinematics {
        body_id: SpatialBodyId::LocalPlayer(player_guid),
        pose: runtime_pose,
        velocity: Vector3::new(1.0, 0.0, 0.0),
        omega: Vector3::new(0.0, 0.0, 0.5),
        contact: ContactState::Grounded,
        projection_state: Some(crate::SelfPlayerDriveProjectionState::LocalGroundedDirectDrive),
    });
    assert!(!runtime_events.is_empty());

    let authoritative_update = WorldPosition {
        coords: Vector3::new(2.0, 3.0, 3.0),
        ..authoritative_pose
    };
    state.set_player_position(authoritative_update);

    let start_gap = runtime_pose.distance_to(&authoritative_update);
    {
        let body = state
            .scene
            .body(SpatialBodyId::LocalPlayer(player_guid))
            .expect("local player runtime body should exist");
        // Physics deep-dive 2026-06-01 (gap 4): with `USE_RETAIL_INTERPOLATE`
        // now the shipped path, an authoritative snapshot no longer
        // pulls/clobbers the working pose at all this tick — it installs the
        // retail interpolator and lets the per-frame stepper ease the working
        // pose over the next frames. So immediately after the snapshot the
        // working pose still sits on the drifted runtime pose (the strongest
        // no-clobber guarantee), the integrator keeps driving (mode
        // unchanged), and the authoritative pose is recorded.
        assert_eq!(
            body.pose, runtime_pose,
            "snapshot must not clobber/pull the active runtime pose this tick"
        );
        assert_eq!(body.authoritative_pose, Some(authoritative_update));
        assert_eq!(body.sampling.mode, SpatialSampleMode::SimulatingMotionState);
    }

    // Drive the per-frame interpolator: it gently eases the working pose
    // toward the authoritative pose (no snap-back), monotonically.
    let mut prev = start_gap;
    let mut moved = false;
    for _ in 0..240 {
        state.scene.step_force_position_interpolation(
            SpatialBodyId::LocalPlayer(player_guid),
            0.016,
            36.0,
            true,
        );
        let gap = state
            .scene
            .body(SpatialBodyId::LocalPlayer(player_guid))
            .unwrap()
            .pose
            .distance_to(&authoritative_update);
        assert!(gap <= prev + 1e-4, "monotonic ease toward target ({gap} <= {prev})");
        if gap < start_gap - 1e-3 {
            moved = true;
        }
        prev = gap;
    }
    assert!(
        moved,
        "the interpolator should ease the working pose toward the authoritative pose"
    );
}

#[test]
fn local_forced_reposition_uses_single_reset_reconcile_path() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0999);
    let start_pos = WorldPosition {
        landblock_id: Guid(0x1234_0000),
        coords: Vector3::new(1.0, 2.0, 3.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let forced_pos = WorldPosition {
        coords: Vector3::new(9.0, 8.0, 3.0),
        ..start_pos
    };

    state.seed_local_player_entity(player_guid, "Player", start_pos);

    let events = state.apply_spatial_body_event(&crate::SpatialBodyEvent::ForcedReposition {
        body_id: SpatialBodyId::LocalPlayer(player_guid),
        pose: forced_pos,
    });

    assert_eq!(state.player_position(), Some(start_pos));
    assert_eq!(state.entities.get(player_guid).unwrap().position, start_pos);
    assert_eq!(
        state
            .scene
            .body(SpatialBodyId::LocalPlayer(player_guid))
            .expect("local player runtime body should exist after forced reposition")
            .pose,
        forced_pos
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                event,
                WorldEvent::RuntimeBodyChanged {
                    body_id: SpatialBodyId::LocalPlayer(guid)
                } if *guid == player_guid
            ))
            .count(),
        1
    );
    assert!(!events.iter().any(|event| matches!(
        event,
        WorldEvent::EntityMoved { guid, .. } if *guid == player_guid
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::ForcedReposition {
            guid,
            pos,
            sequence: 0,
        } if *guid == player_guid && *pos == forced_pos
    )));
}

#[test]
fn test_set_player_position_sanitizes_nan_rotation() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000123);
    state.player.guid = player_guid;

    let initial_pos = WorldPosition {
        landblock_id: Guid(0x12340000),
        coords: Vector3::new(0.0, 0.0, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    state.seed_local_player_entity(player_guid, "Player", initial_pos);

    let nan_pos = WorldPosition {
        landblock_id: Guid(0x12340000),
        coords: Vector3::new(10.0, 20.0, 30.0),
        rotation: holtburger_common::math::Quaternion {
            w: f32::NAN,
            x: 0.0,
            y: 0.0,
            z: 0.0,
        },
    };

    state.set_player_position(nan_pos);

    assert_eq!(
        state
            .player_position()
            .expect("player entity should exist")
            .rotation,
        holtburger_common::math::Quaternion::identity()
    );
    assert_eq!(
        state.entities.get(player_guid).unwrap().position.rotation,
        holtburger_common::math::Quaternion::identity()
    );
}

#[test]
fn apply_solved_body_kinematics_updates_local_runtime_body_and_grounded_state() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000123);
    let start_pos = WorldPosition {
        landblock_id: Guid(0x12340000),
        coords: Vector3::new(0.0, 0.0, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    state.seed_local_player_entity(player_guid, "Player", start_pos);

    let solved = SolvedBodyKinematics {
        body_id: SpatialBodyId::LocalPlayer(player_guid),
        pose: WorldPosition {
            landblock_id: Guid(0x12340000),
            coords: Vector3::new(10.0, 20.0, 30.0),
            rotation: holtburger_common::math::Quaternion::identity(),
        },
        velocity: Vector3::new(1.0, 2.0, 3.0),
        omega: Vector3::new(0.0, 0.0, 4.0),
        contact: ContactState::Grounded,
        projection_state: None,
    };

    let events = state.apply_solved_body_kinematics(&solved);

    assert_eq!(state.player_position(), Some(start_pos));
    let entity = state
        .entities
        .get(player_guid)
        .expect("authoritative player entity should still exist");
    assert_eq!(entity.position, start_pos);
    assert_eq!(entity.velocity, Vector3::zero());
    assert_eq!(entity.omega, Vector3::zero());
    let runtime_body = state
        .scene
        .body(SpatialBodyId::LocalPlayer(player_guid))
        .expect("local player runtime body should exist");
    assert_eq!(runtime_body.pose, solved.pose);
    assert_eq!(runtime_body.velocity, solved.velocity);
    assert_eq!(runtime_body.omega, solved.omega);
    assert_eq!(state.player.last_server_grounded, Some(true));
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::RuntimeBodyChanged {
            body_id: SpatialBodyId::LocalPlayer(guid)
        } if *guid == player_guid
    )));
    assert!(
        events
            .iter()
            .any(|event| matches!(event, WorldEvent::PlayerGroundedUpdated { grounded: true }))
    );
}

#[test]
fn apply_solved_body_kinematics_preserves_player_grounded_cache_when_contact_unknown() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000123);
    let start_pos = WorldPosition::default();

    state.player.guid = player_guid;
    state.seed_local_player_entity(player_guid, "Player", start_pos);
    state.player.last_server_grounded = Some(true);

    let solved = SolvedBodyKinematics {
        body_id: SpatialBodyId::LocalPlayer(player_guid),
        pose: WorldPosition {
            coords: Vector3::new(1.0, 2.0, 3.0),
            ..start_pos
        },
        velocity: Vector3::zero(),
        omega: Vector3::zero(),
        contact: ContactState::Unknown,
        projection_state: None,
    };

    let events = state.apply_solved_body_kinematics(&solved);

    assert_eq!(state.player.last_server_grounded, Some(true));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, WorldEvent::PlayerGroundedUpdated { .. }))
    );
}

#[test]
fn apply_spatial_body_event_emits_runtime_body_changed_for_remote_contact() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x5000_0200);
    let position = WorldPosition {
        landblock_id: Guid(0x1234_0000),
        coords: Vector3::new(1.0, 2.0, 3.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    state.add_entity(Entity::new(guid, "Drudge".to_string(), position));

    let events = state.apply_spatial_body_event(&SpatialBodyEvent::ContactChanged {
        body_id: SpatialBodyId::Entity(guid),
        contact: ContactState::Grounded,
    });

    assert_eq!(
        state
            .scene
            .body(SpatialBodyId::Entity(guid))
            .expect("runtime body should exist")
            .contact,
        ContactState::Grounded
    );
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::RuntimeBodyChanged { body_id }
            if *body_id == SpatialBodyId::Entity(guid)
    )));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, WorldEvent::PlayerGroundedUpdated { .. }))
    );
}

#[test]
fn player_teleport_suspends_runtime_bodies_and_emits_reset_signal() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0201);
    let position = WorldPosition {
        landblock_id: Guid(0x1234_0000),
        coords: Vector3::new(10.0, 20.0, 30.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    state.player.guid = player_guid;
    state.seed_local_player_entity(player_guid, "Player", position);

    let events = state.handle_message(&GameMessage::PlayerTeleport(Box::new(PlayerTeleportData {
        teleport_sequence: 7,
    })));

    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::RuntimeBodiesReset {
            cause: RuntimeBodyResetCause::TeleportOrWorldReset
        }
    )));
    assert!(
        events
            .iter()
            .any(|event| matches!(event, WorldEvent::TeleportStarted { sequence: 7 }))
    );
    assert_eq!(
        state
            .scene
            .body(SpatialBodyId::LocalPlayer(player_guid))
            .expect("local player runtime body should exist")
            .sampling
            .mode,
        SpatialSampleMode::Suspended
    );
}

/// Workstream G (3D camera/game-feel fix, 2026-05-11) regression test.
///
/// Reproduces the F-capture failure: after a teleport, the runtime
/// pose sticks at the source landblock (Academy `0x8602`) while the
/// authoritative pose advances to the destination (Holtburg `0xA9B4`).
/// The integrator then runs against the stuck-at-source pose, hits the
/// academy-rubberband pre-bake gate (indoor cell with no cell physics
/// triangles), and zeros lateral delta — player can't move.
///
/// **Pre-fix behavior** (`mode` left at `SimulatingMotionState` after
/// the integrator's `set_local_player_runtime_pose` lands):
///   `reconcile_authoritative_body(... Snapshot)` preserves `body.pose`
///   even on teleport, because `preserve_local_runtime_pose` is true
///   when `mode ∈ {SimulatingMotionState, SimulatingVelocity}`. So
///   `set_player_position(destination_pos)` only updates
///   `body.authoritative_pose`, leaving `body.pose` (runtime) stuck.
///
/// **Post-fix behavior** (`PlayerTeleport` wasm handler calls
/// `suspend_runtime_bodies(TeleportOrWorldReset)` which flips
/// `mode` to `Suspended` BEFORE `set_player_position` runs):
///   `preserve_local_runtime_pose` is false (Suspended ∉ {Simulating-
///   MotionState, SimulatingVelocity}), so `body.pose` snaps to the
///   destination as intended.
///
/// This test isolates the `WorldState`-level behavior — the wasm
/// recv-loop's specific dispatch (which calls
/// `w.player.set_teleport_sequence(...)` + `w.suspend_runtime_bodies(...)`
/// from its `GameMessage::PlayerTeleport` arm before any subsequent
/// `set_player_position` lands) is verified separately by the live
/// `capture_3d_movement_e2e.cjs` Workstream F capture (bullet 7 flips
/// from FAIL → PASS post-fix).
#[test]
fn workstream_g_post_teleport_set_player_position_updates_runtime_pose_when_body_suspended() {
    use crate::AuthoritativeBodySync;
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0095);
    // Academy spawn (indoor cell 0x860201AD — matches the F capture).
    let source_pos = WorldPosition {
        landblock_id: Guid(0x8602_01AD),
        coords: Vector3::new(12.32, -28.48, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    state.seed_local_player_entity(player_guid, "Player", source_pos);

    // Simulate the integrator running once: this calls
    // `apply_runtime_body_pose(body_id, pose, SimulatingMotionState)`
    // which flips `body.sampling.mode` to SimulatingMotionState (the
    // mode the academy-rubberband-fix `preserve_local_runtime_pose`
    // gate keys off of). Without this step, `mode` would be
    // `AuthoritativeOnly` (default from `add_entity` →
    // `reconcile_authoritative_body(Snapshot)`) and the post-fix
    // path's defenses against routine-broadcast pose overwrite
    // would never engage.
    let _ = state.set_local_player_runtime_pose(source_pos);
    assert_eq!(
        state
            .scene
            .body(SpatialBodyId::LocalPlayer(player_guid))
            .expect("body should be registered post entity seed")
            .sampling
            .mode,
        SpatialSampleMode::SimulatingMotionState,
        "integrator's first set_local_player_runtime_pose call should arm SimulatingMotionState"
    );

    // Pre-fix path: routine `set_player_position(dest)` with
    // mode=SimulatingMotionState preserves body.pose (academy-rubberband
    // fix's defense against ACE's routine UpdatePosition broadcasts).
    // This is intentional and correct for the routine case.
    let destination_pos = WorldPosition {
        landblock_id: Guid(0xA9B4_FFFE),
        coords: Vector3::new(84.0, 7.1, 94.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let _ = state.set_player_position(destination_pos);
    let body_after_routine = state
        .scene
        .body(SpatialBodyId::LocalPlayer(player_guid))
        .expect("body still registered after set_player_position");
    assert_eq!(
        body_after_routine.pose, source_pos,
        "preserve_local_runtime_pose should keep body.pose at source under SimulatingMotionState (academy fix)"
    );
    assert_eq!(
        body_after_routine.authoritative_pose,
        Some(destination_pos),
        "authoritative_pose should update to destination on routine set_player_position"
    );

    // Now exercise the post-fix path: suspend_runtime_bodies flips
    // mode → Suspended. A subsequent `set_player_position` then
    // reconciles the body via `reconcile_authoritative_body(Snapshot)`;
    // with mode=Suspended (∉ Simulating*), `preserve_local_runtime_pose`
    // is false, and body.pose snaps to the new destination. THIS is
    // the gate Workstream G's wasm-side PlayerTeleport handler arm
    // needs to engage before the subsequent UpdatePosition handler
    // calls `set_player_position` again.
    let _ = state.suspend_runtime_bodies(RuntimeBodyResetCause::TeleportOrWorldReset);
    assert_eq!(
        state
            .scene
            .body(SpatialBodyId::LocalPlayer(player_guid))
            .expect("body suspended")
            .sampling
            .mode,
        SpatialSampleMode::Suspended,
        "suspend_runtime_bodies should flip mode to Suspended"
    );

    // Re-do the set_player_position to simulate the post-teleport
    // UpdatePosition arriving with the destination pose. Now body.pose
    // should snap.
    let _ = state.set_player_position(destination_pos);
    let body_after_teleport_snap = state
        .scene
        .body(SpatialBodyId::LocalPlayer(player_guid))
        .expect("body still registered post teleport snap");
    assert_eq!(
        body_after_teleport_snap.pose, destination_pos,
        "post-fix path: body.pose snaps to destination after suspend → set_player_position"
    );
    assert_eq!(
        body_after_teleport_snap.authoritative_pose,
        Some(destination_pos),
        "authoritative_pose stays at destination"
    );
    // After the snap, reconcile_authoritative_body(Snapshot) with mode
    // != Simulating* sets sampling.mode = AuthoritativeOnly (its
    // default-snapshot mode). This is the correct steady-state until
    // the integrator's next set_local_player_runtime_pose arms
    // SimulatingMotionState again on the next W press.
    assert_eq!(
        body_after_teleport_snap.sampling.mode,
        SpatialSampleMode::AuthoritativeOnly,
        "snapshot reconcile from Suspended should land in AuthoritativeOnly (default-snapshot mode)"
    );
    let _ = AuthoritativeBodySync::Snapshot; // silence unused-import lint without changing public API
}

/// Soak-11 Layer-1 (2026-07-20): `latch_arrival_placement` sets the placement
/// latch and clears the transient stationary-fall carry — the shared "hard
/// positional discontinuity landed" latch used by both the Reset|ForceBlip
/// sequence-advance arrivals (inline in `set_player_position_with_sync`) and
/// the teleport-arrival path.
#[test]
fn soak11_latch_arrival_placement_sets_flag_and_clears_fall_carry() {
    let mut player = crate::player::types::PlayerState::new();
    player.pending_arrival_placement = false;
    player.frames_stationary_fall = 2;
    player.latch_arrival_placement();
    assert!(
        player.pending_arrival_placement,
        "latch_arrival_placement schedules the placement pass"
    );
    assert_eq!(
        player.frames_stationary_fall, 0,
        "a hard arrival clears the old location's stationary-fall carry"
    );
}

/// Soak-11 Layer-1: the teleport-arrival latch is consume-once — armed by the
/// PlayerTeleport handler, cleared by the FIRST `take_teleport_arrival` (the
/// next self `UpdatePosition` decision), and stays clear afterward.
#[test]
fn soak11_arm_take_teleport_arrival_is_consume_once() {
    let mut player = crate::player::types::PlayerState::new();
    assert!(!player.teleport_arrival_pending, "unarmed at construction");
    assert!(!player.take_teleport_arrival(), "take on unarmed returns false");

    player.arm_teleport_arrival();
    assert!(player.teleport_arrival_pending, "armed flag set");
    assert!(player.take_teleport_arrival(), "first take consumes the latch");
    assert!(
        !player.teleport_arrival_pending,
        "flag cleared after consume (armed window is one UpdatePosition)"
    );
    assert!(
        !player.take_teleport_arrival(),
        "second take returns false (consume-once)"
    );
}

/// Soak-11 Layer-1 END-TO-END: drive the live @teleloc wire pair through the
/// CANONICAL `handlers/player.rs` path (the one `wireStatePacks` default-ON
/// runs) and assert the arrival-placement latch actually sets — which it did
/// NOT pre-fix (the pre-mirrored `teleport_sequence` lands via the
/// `body_suspended` Snapshot de-suspend, which never self-latches). Also
/// asserts (a) a ROUTINE self UpdatePosition (no teleport) does NOT latch, and
/// (b) the destination body-snap / mode trajectory is UNCHANGED (the fix is
/// additive — `post_teleport_..._snaps_suspended_body` contract preserved).
#[test]
fn soak11_canonical_teleport_arrival_latches_placement_routine_does_not() {
    // Mirrors the live verify: the Holtburg grocer vestibule (Environment 840).
    let player_guid = Guid(0x5000_00A9);
    let source_pos = WorldPosition {
        landblock_id: Guid(0x8602_01AD),
        coords: Vector3::new(12.32, -28.48, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let dest_pos = WorldPosition {
        landblock_id: Guid(0xA9B4_016E),
        coords: Vector3::new(4.243, -2.121, 0.35),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let update_position = |guid: Guid, pose: WorldPosition, teleport_sequence: u16| {
        GameMessage::UpdatePosition(Box::new(UpdatePositionData {
            guid,
            pos: PositionPack {
                pos: pose,
                instance_sequence: 1,
                position_sequence: 1,
                teleport_sequence,
                force_position_sequence: 0,
                ..PositionPack::default()
            },
        }))
    };

    // ---- Teleport arrival (PlayerTeleport → destination UpdatePosition) ----
    let mut state = WorldState::synthetic();
    state.seed_local_player_entity(player_guid, "Player", source_pos);
    // Integrator ran once pre-teleport (arms SimulatingMotionState).
    let _ = state.set_local_player_runtime_pose(source_pos);
    state.player.pending_arrival_placement = false;

    // PlayerTeleport pre-mirrors teleport_sequence, suspends the body, AND arms
    // the arrival latch (soak-11).
    let _ = state.handle_message(&GameMessage::PlayerTeleport(Box::new(PlayerTeleportData {
        teleport_sequence: 7,
    })));
    assert!(state.player.teleport_arrival_pending, "PlayerTeleport arms the latch");
    assert_eq!(
        state
            .scene
            .body(SpatialBodyId::LocalPlayer(player_guid))
            .expect("body registered")
            .sampling
            .mode,
        SpatialSampleMode::Suspended,
    );

    // Destination UpdatePosition carries the SAME (pre-mirrored) teleport_sequence.
    let _ = state.handle_message(&update_position(player_guid, dest_pos, 7));
    assert!(
        state.player.pending_arrival_placement,
        "canonical teleport arrival must latch pending_arrival_placement (FAILS pre-fix)"
    );
    assert!(
        !state.player.teleport_arrival_pending,
        "arrival latch consumed (consume-once) by the destination UpdatePosition"
    );
    // Additive-fix invariant: the body still snaps to the destination and lands
    // in AuthoritativeOnly (Snapshot de-suspend), exactly as pre-fix.
    let body = state
        .scene
        .body(SpatialBodyId::LocalPlayer(player_guid))
        .expect("body registered");
    assert_eq!(
        body.pose, dest_pos,
        "destination UpdatePosition still snaps the Suspended body (mode/pose trajectory unchanged)"
    );
    assert_eq!(
        body.sampling.mode,
        SpatialSampleMode::AuthoritativeOnly,
        "Snapshot de-suspend still lands in AuthoritativeOnly (fix is additive)"
    );

    // ---- Routine self UpdatePosition (NO PlayerTeleport) ----
    let mut state = WorldState::synthetic();
    state.seed_local_player_entity(player_guid, "Player", source_pos);
    let _ = state.set_local_player_runtime_pose(source_pos);
    state.player.pending_arrival_placement = false;
    // Same teleport_sequence as the stored one, no arm → routine echo, no latch.
    let _ = state.handle_message(&update_position(player_guid, dest_pos, 0));
    assert!(
        !state.player.pending_arrival_placement,
        "a routine (non-teleport) UpdatePosition must NOT latch placement"
    );

    // ---- Login InitialHydration suspend must NOT latch (only PlayerTeleport arms) ----
    let mut state = WorldState::synthetic();
    state.seed_local_player_entity(player_guid, "Player", source_pos);
    let _ = state.set_local_player_runtime_pose(source_pos);
    state.player.pending_arrival_placement = false;
    let _ = state.suspend_runtime_bodies(RuntimeBodyResetCause::InitialHydration);
    // Body is Suspended but the teleport latch was never armed.
    let _ = state.handle_message(&update_position(player_guid, dest_pos, 0));
    assert!(
        !state.player.pending_arrival_placement,
        "a login InitialHydration suspend (no PlayerTeleport) must NOT latch placement"
    );
}

/// NavAtlas outdoor-login `objCellId == 0` regression (2026-07-19,
/// live-repro on ACE: a character whose SAVED position is OUTDOORS logs
/// in and `getLocalPlayerPose().landblockId` — the value the rynth
/// webhost exposes as `objCellId` — is stuck at 0 forever while x/y/z
/// sync from the server; movement, teleports and the rynth pose all
/// break because a never-placed object cannot be re-placed).
///
/// Mechanism: the login seed can leave the local player's runtime
/// (working) body pose with a NULL landblock (a pos-less seed —
/// `data.pos.unwrap_or_default()` / the ObjectCreate `None` branch on
/// the wasm side). `set_local_player_runtime_pose` arms
/// `SimulatingMotionState`, so every routine `Snapshot` echo hits the
/// `preserve_local_runtime_pose` gate and never overwrites `body.pose`.
/// For an INDOOR/teleport arrival the `Reset`/`ForceBlip` snap escapes
/// the gate and stamps the cell; for a saved-OUTDOOR position the
/// routine `Snapshot` echoes stay preserved AND outdoor local
/// re-derivation (`rebucket_outdoor_landblock` / `normalize_outdoor_cell`)
/// is a no-op on a NULL landblock — so the cell can never recover.
///
/// **Fix** (`scene.rs` `reconcile_authoritative_body_with_remote`): a
/// NULL working landblock is never a legitimate pose to preserve, so the
/// preserve gate now also requires `body.pose.landblock_id != Guid::NULL`.
/// A NULL working cell falls through to the authoritative snap
/// (`body.pose = pose`) which adopts the server's outdoor cell. Sibling
/// `workstream_g_*` above proves a VALID working cell is still preserved
/// (the academy-rubberband path is untouched).
#[test]
fn navatlas_null_working_landblock_heals_to_outdoor_cell_on_snapshot_echo() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_00C1);

    // Simulate a pos-less login seed: the runtime body's working pose is
    // stamped with a NULL landblock (Guid(0)) while carrying the real
    // landblock-local coords (0..192) the server will echo.
    let null_seed = WorldPosition {
        landblock_id: Guid::NULL,
        coords: Vector3::new(46.805, 4.219, 42.005),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    state.seed_local_player_entity(player_guid, "Player", null_seed);
    // Arms SimulatingMotionState (the mode the preserve gate keys off of)
    // with a NULL-landblock working pose — the exact bug state.
    let _ = state.set_local_player_runtime_pose(null_seed);
    {
        let body = state
            .scene
            .body(SpatialBodyId::LocalPlayer(player_guid))
            .expect("body registered post seed");
        assert_eq!(
            body.pose.landblock_id,
            Guid::NULL,
            "precondition: working pose seeded with a NULL landblock"
        );
        assert_eq!(
            body.sampling.mode,
            SpatialSampleMode::SimulatingMotionState,
            "precondition: SimulatingMotionState armed (preserve gate active)"
        );
    }

    // The server's authoritative OUTDOOR position arrives as a routine
    // `Snapshot` echo (low word 0x0009 < 0x100 ⇒ outdoor cell).
    let outdoor_pos = WorldPosition {
        landblock_id: Guid(0xC6A9_0009),
        coords: Vector3::new(46.805, 4.219, 42.005),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let _ = state.set_player_position(outdoor_pos);

    // FIX: the NULL working cell must NOT be preserved — it snaps to the
    // server's outdoor cell so `objCellId` (getLocalPlayerPose().landblockId)
    // reads non-zero.
    let body = state
        .scene
        .body(SpatialBodyId::LocalPlayer(player_guid))
        .expect("body still registered after snapshot echo");
    assert_ne!(
        body.pose.landblock_id,
        Guid::NULL,
        "regression: NULL working cell must heal (objCellId != 0)"
    );
    assert_eq!(
        body.pose.landblock_id,
        Guid(0xC6A9_0009),
        "working cell should adopt the server's outdoor landblock"
    );
    // The read path getLocalPlayerPose() maps to must reflect the healed cell.
    assert_eq!(
        state
            .local_player_runtime_pose()
            .expect("runtime pose available")
            .landblock_id,
        Guid(0xC6A9_0009),
        "local_player_runtime_pose (→ objCellId) reads the healed outdoor cell"
    );
}

/// Companion to the NavAtlas fix: a VALID (non-NULL) working landblock
/// under `SimulatingMotionState` is STILL preserved on a routine
/// `Snapshot` echo (the academy-rubberband defense the fix must not
/// weaken). This pins the fix to the NULL-only condition so a normal
/// outdoor player's predicted pose is never snapped backward by a laggy
/// echo.
#[test]
fn navatlas_fix_leaves_valid_working_landblock_preserved() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_00C2);
    // Valid outdoor working pose (cell 0xC6A90009).
    let working = WorldPosition {
        landblock_id: Guid(0xC6A9_0009),
        coords: Vector3::new(46.805, 4.219, 42.005),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    state.seed_local_player_entity(player_guid, "Player", working);
    let _ = state.set_local_player_runtime_pose(working);

    // A laggy routine Snapshot echo a few metres behind — must be
    // preserved (prediction wins), not snapped.
    let laggy_echo = WorldPosition {
        landblock_id: Guid(0xC6A9_0009),
        coords: Vector3::new(44.0, 2.0, 42.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let _ = state.set_player_position(laggy_echo);
    let body = state
        .scene
        .body(SpatialBodyId::LocalPlayer(player_guid))
        .expect("body registered");
    assert_eq!(
        body.pose, working,
        "valid working pose must stay preserved under SimulatingMotionState (academy-rubberband intact)"
    );
    assert_eq!(
        body.authoritative_pose,
        Some(laggy_echo),
        "authoritative_pose still tracks the echo"
    );
}

/// NavAtlas fix — authoritative-ONLY path coverage (the `routinePosGuard`
/// gap). Live-confirmed `[movement] routinePosGuard ON`: routine self
/// UpdatePosition echoes route through `set_player_position_authoritative_only`
/// (`sync = None`) which updates `entity.position` but does NOT reconcile the
/// runtime body — so the `scene.rs` `preserve_local_runtime_pose` NULL guard
/// never runs for those. The `update_player_position_core` heal must recover
/// the working cell on this path too, otherwise a session whose only post-seed
/// traffic is routine echoes stays at `objCellId == 0` forever.
#[test]
fn navatlas_null_working_landblock_heals_on_authoritative_only_echo() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_00C3);

    let null_seed = WorldPosition {
        landblock_id: Guid::NULL,
        coords: Vector3::new(12.8, -26.7, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    state.seed_local_player_entity(player_guid, "Player", null_seed);
    let _ = state.set_local_player_runtime_pose(null_seed);
    assert_eq!(
        state
            .scene
            .body(SpatialBodyId::LocalPlayer(player_guid))
            .expect("body registered")
            .pose
            .landblock_id,
        Guid::NULL,
        "precondition: NULL working landblock"
    );

    // Routine self-echo via the authoritative-ONLY path (no reconcile) —
    // the indoor academy cell the ENTITY already holds.
    let authoritative_echo = WorldPosition {
        landblock_id: Guid(0x8602_01AD),
        coords: Vector3::new(12.8, -26.7, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let _ = state.set_player_position_authoritative_only(authoritative_echo);

    assert_eq!(
        state
            .scene
            .body(SpatialBodyId::LocalPlayer(player_guid))
            .expect("body still registered")
            .pose
            .landblock_id,
        Guid(0x8602_01AD),
        "authoritative-only echo must heal the NULL working cell (routinePosGuard path)"
    );
    assert_eq!(
        state
            .local_player_runtime_pose()
            .expect("runtime pose")
            .landblock_id,
        Guid(0x8602_01AD),
        "objCellId reads the healed cell after an authoritative-only echo"
    );
}

/// NavAtlas RIG root-cause fix — the READ chokepoint heals a per-frame
/// NULL working landblock without any inbound message. Live evidence:
/// an idle solo outdoor player's `body.pose` is nulled every frame by the
/// `project_pose_by_offset` feedback loop (global collapses to local once
/// landblock==0), and NO inbound echo arrives to trigger the reconcile /
/// update_player_position_core heals — so `getLocalPlayerPose().objCellId`
/// stays 0 permanently. `runtime_pose_for_guid` (which BOTH getLocalPlayerPose
/// and the movement solve input go through) now surfaces the correct cell
/// from the server-authoritative pose whenever the working landblock is NULL.
#[test]
fn navatlas_read_path_heals_null_working_cell_from_authoritative_pose() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_00C4);
    // Outdoor Arwic spawn — the seed sets entity + body + authoritative pose
    // to the correct cell 0xC6A90019.
    let correct = WorldPosition {
        landblock_id: Guid(0xC6A9_0019),
        coords: Vector3::new(72.8, 18.6, 43.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    state.seed_local_player_entity(player_guid, "Player", correct);
    let _ = state.set_local_player_runtime_pose(correct);

    // Simulate the per-frame feedback nuller: body.pose's landblock is zeroed
    // while the valid landblock-local coords are kept (authoritative_pose is
    // NOT touched — it still holds the correct server cell).
    let nulled = WorldPosition {
        landblock_id: Guid::NULL,
        coords: Vector3::new(72.8, 18.6, 43.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    assert!(state.scene.apply_runtime_body_pose(
        SpatialBodyId::LocalPlayer(player_guid),
        nulled,
        SpatialSampleMode::SimulatingMotionState,
    ));
    // Precondition: the raw body pose is NULL...
    assert_eq!(
        state
            .scene
            .body(SpatialBodyId::LocalPlayer(player_guid))
            .expect("body")
            .pose
            .landblock_id,
        Guid::NULL,
    );

    // ...but the READ chokepoint surfaces the authoritative cell — no inbound
    // message needed. This is what getLocalPlayerPose() and the movement solve
    // input both read.
    let read = state
        .local_player_runtime_pose()
        .expect("runtime pose available");
    assert_ne!(
        read.landblock_id,
        Guid::NULL,
        "read-path must never surface a NULL working cell (objCellId != 0)"
    );
    assert_eq!(
        read.landblock_id,
        Guid(0xC6A9_0019),
        "read-path surfaces the server-authoritative outdoor cell"
    );
    // Local coords are preserved (valid for the authoritative cell).
    assert_eq!(read.coords, Vector3::new(72.8, 18.6, 43.0));
}

/// Teleport-destination landing regression (2026-07-02, live-repro on ACE
/// `@telepoi`): the canonical `handlers/player.rs` message pair must land
/// the runtime body at the destination even though `PlayerTeleport`
/// pre-advances `teleport_sequence` — the destination `UpdatePosition`
/// arrives with an EQUAL teleport_sequence (only `position_sequence`
/// advances), so the B1/D3-SNAP `is_newer_u16` gate alone mis-classifies
/// it as a routine echo and the authoritative-only arm leaves the body
/// Suspended at the source forever (rig + camera stranded at the source
/// landblock while the world streams the destination). The sibling
/// `workstream_g_*` test above exercises `set_player_position` directly;
/// this one drives the actual wire pair through `handle_message`.
#[test]
fn post_teleport_update_position_with_equal_teleport_sequence_snaps_suspended_body() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0008);
    let source_pos = WorldPosition {
        landblock_id: Guid(0xC3A8_003A),
        coords: Vector3::new(186.15, 44.49, 62.19),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    state.seed_local_player_entity(player_guid, "Player", source_pos);
    // Integrator ran at least once (player walked before entering the
    // portal) — arms SimulatingMotionState, the real pre-teleport mode.
    let _ = state.set_local_player_runtime_pose(source_pos);

    // 1. PlayerTeleport: pre-advances teleport_sequence + suspends the
    //    body at its (source) authoritative pose.
    let _ = state.handle_message(&GameMessage::PlayerTeleport(Box::new(PlayerTeleportData {
        teleport_sequence: 7,
    })));
    let body = state
        .scene
        .body(SpatialBodyId::LocalPlayer(player_guid))
        .expect("body registered");
    assert_eq!(body.sampling.mode, SpatialSampleMode::Suspended);
    assert_eq!(body.pose, source_pos, "suspend parks the body at the source");

    // 2. Destination UpdatePosition: SAME teleport_sequence (ACE's fake
    //    SendUpdatePosition from Player_Location.Teleport), only the
    //    position_sequence advances.
    let destination_pos = WorldPosition {
        landblock_id: Guid(0xC98D_0021),
        coords: Vector3::new(84.0, 7.1, 94.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let _ = state.handle_message(&GameMessage::UpdatePosition(Box::new(UpdatePositionData {
        guid: player_guid,
        pos: PositionPack {
            pos: destination_pos,
            instance_sequence: 1,
            position_sequence: 1,
            teleport_sequence: 7,
            force_position_sequence: 0,
            ..PositionPack::default()
        },
    })));
    let body = state
        .scene
        .body(SpatialBodyId::LocalPlayer(player_guid))
        .expect("body registered");
    assert_eq!(
        body.pose, destination_pos,
        "destination UpdatePosition must snap the Suspended body out of the source landblock"
    );
    assert_eq!(
        body.sampling.mode,
        SpatialSampleMode::AuthoritativeOnly,
        "Snapshot reconcile from Suspended lands in AuthoritativeOnly until the next input"
    );
    assert_eq!(
        state.local_player_runtime_pose(),
        Some(destination_pos),
        "getLocalPlayerPose's source must report the destination"
    );

    // 3. Routine ~20 Hz echo AFTER landing (integrator running again)
    //    must NOT reconcile the body — the anti-rubberband guard the
    //    2026-06-29 fix installed stays intact.
    let integrator_pos = WorldPosition {
        landblock_id: destination_pos.landblock_id,
        coords: Vector3::new(90.0, 12.0, 94.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let _ = state.set_local_player_runtime_pose(integrator_pos);
    let laggy_echo = WorldPosition {
        landblock_id: destination_pos.landblock_id,
        coords: Vector3::new(85.0, 8.0, 94.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let _ = state.handle_message(&GameMessage::UpdatePosition(Box::new(UpdatePositionData {
        guid: player_guid,
        pos: PositionPack {
            pos: laggy_echo,
            instance_sequence: 1,
            position_sequence: 2,
            teleport_sequence: 7,
            force_position_sequence: 0,
            ..PositionPack::default()
        },
    })));
    let body = state
        .scene
        .body(SpatialBodyId::LocalPlayer(player_guid))
        .expect("body registered");
    assert_eq!(
        body.pose, integrator_pos,
        "routine echo after landing keeps following the integrator (no rubberband)"
    );
}

/// Death-respawn cell-0 movement paralysis regression (2026-07-21, live on
/// the stream bot). ACE's teleport (death included) sends TWO UpdatePosition
/// packets sharing one teleport-sequence epoch: posA (pre-settle, can carry
/// an unresolvable/NULL cell) then posB (the real destination). posA lands
/// via the `body_suspended` Snapshot branch; `reconcile_authoritative_body_
/// with_remote` (state/mutations.rs:90-93) RETIRES (removes) the runtime
/// body outright whenever the reconciled pose carries a NULL landblock —
/// this is the actual mechanism (a deviation from the initial "hard-snaps to
/// a null cell" hypothesis, confirmed by reading the reconcile path). Either
/// way the body's `sampling.mode` bookkeeping no longer reads `Suspended`
/// afterward (see
/// `post_teleport_update_position_with_equal_teleport_sequence_snaps_suspended_body`
/// for the non-null sibling), so posB — same epoch, valid destination, later
/// `position_sequence` — no longer observes `body_suspended` (the view falls
/// back to the entity) and falls into the routine authoritative-only
/// bookkeeping arm, which never calls `reconcile_authoritative_body` and so
/// never recreates the body. The runtime body then stays MISSING forever
/// (`objCellId == 0`, movement dead). Fix: the `body_cell_null` backstop in
/// `handlers/player.rs` routes ANY accepted same-epoch self update through
/// the hard-reconcile Snapshot path whenever the body is missing OR carries
/// a NULL working cell, so posB recreates/heals it.
#[test]
fn post_teleport_posa_null_cell_then_posb_valid_cell_heals_via_body_cell_null_backstop() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0009);
    let source_pos = WorldPosition {
        landblock_id: Guid(0xC3A8_003A),
        coords: Vector3::new(186.15, 44.49, 62.19),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    state.seed_local_player_entity(player_guid, "Player", source_pos);
    // Integrator ran at least once pre-death — arms SimulatingMotionState,
    // the real pre-teleport mode.
    let _ = state.set_local_player_runtime_pose(source_pos);

    // 1. PlayerTeleport (death respawn): pre-advances teleport_sequence +
    //    suspends the body at its (source) authoritative pose.
    let _ = state.handle_message(&GameMessage::PlayerTeleport(Box::new(PlayerTeleportData {
        teleport_sequence: 9,
    })));
    let body = state
        .scene
        .body(SpatialBodyId::LocalPlayer(player_guid))
        .expect("body registered");
    assert_eq!(body.sampling.mode, SpatialSampleMode::Suspended);

    // 2. posA: SAME teleport_sequence, a NULL/unresolvable working cell
    //    (the pre-settle packet). Lands via `body_suspended` -> Snapshot;
    //    the reconcile retires the body outright because the pose carries a
    //    NULL landblock (state/mutations.rs:90-93).
    let pos_a = WorldPosition {
        landblock_id: Guid::NULL,
        coords: Vector3::new(0.0, 0.0, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let _ = state.handle_message(&GameMessage::UpdatePosition(Box::new(UpdatePositionData {
        guid: player_guid,
        pos: PositionPack {
            pos: pos_a,
            instance_sequence: 1,
            position_sequence: 1,
            teleport_sequence: 9,
            force_position_sequence: 0,
            ..PositionPack::default()
        },
    })));
    assert!(
        state
            .scene
            .body(SpatialBodyId::LocalPlayer(player_guid))
            .is_none(),
        "precondition: posA's NULL-landblock reconcile retires the runtime body outright"
    );

    // 3. posB: SAME teleport_sequence, a later position_sequence, and the
    //    REAL destination cell. Pre-fix this falls into the routine
    //    authoritative-only bookkeeping arm (body_suspended reads false via
    //    the entity fallback view, and snap is false) and never calls
    //    `reconcile_authoritative_body` -> the body would stay missing
    //    forever. The `body_cell_null` backstop must route it through
    //    Snapshot instead, recreating the body at posB.
    let pos_b = WorldPosition {
        landblock_id: Guid(0xC98D_0021),
        coords: Vector3::new(84.0, 7.1, 94.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let _ = state.handle_message(&GameMessage::UpdatePosition(Box::new(UpdatePositionData {
        guid: player_guid,
        pos: PositionPack {
            pos: pos_b,
            instance_sequence: 1,
            position_sequence: 2,
            teleport_sequence: 9,
            force_position_sequence: 0,
            ..PositionPack::default()
        },
    })));
    let body = state
        .scene
        .body(SpatialBodyId::LocalPlayer(player_guid))
        .expect("body registered");
    assert_eq!(
        body.pose, pos_b,
        "posB must heal the body to the real destination (regression: body_cell_null backstop)"
    );
    assert_ne!(
        body.pose.landblock_id,
        Guid::NULL,
        "raw working cell must no longer be NULL after posB (objCellId != 0)"
    );
    assert_eq!(
        state.local_player_runtime_pose(),
        Some(pos_b),
        "local_player_runtime_pose (getLocalPlayerPose source) must report posB"
    );
}

#[test]
fn test_spell_name_resolution() {
    use crate::spell::{SpellCatalog, SpellInfo};

    let mut state = WorldState::synthetic();
    let mut spells = std::collections::HashMap::new();
    spells.insert(
        1337,
        SpellInfo {
            name: "L33t Spell".to_string(),
            description: String::new(),
            school: crate::spell::MagicSchool::None,
            icon_id: 0,
            category: 0,
            bitfield: 0,
            base_mana: 0,
            base_range_constant: 0.0,
            base_range_mod: 0.0,
            power: 0,
            spell_economy_mod: 0.0,
            formula_version: 0,
            component_loss: 0.0,
            meta_spell_type: 0,
            meta_spell_id: 0,
            extras: crate::spell::SpellExtrasInfo::None,
            components: [0; 8],
            decrypted_components: Vec::new(),
            caster_effect: 0,
            target_effect: 0,
            fizzle_effect: 0,
            recovery_interval: 0.0,
            recovery_amount: 0.0,
            display_order: 0,
            non_component_target_type: 0,
            mana_mod: 0,
        },
    );

    state.spell_catalog = Arc::new(SpellCatalog {
        spells,
        ..Default::default()
    });

    assert_eq!(state.resolve_spell_name(1337).unwrap(), "L33t Spell");
    assert!(state.resolve_spell_name(999).is_none());
}

#[test]
fn test_empty_world_uses_synthetic_reference_data() {
    let state = WorldState::synthetic();
    assert_eq!(state.xp_table.character_level_xp_list, vec![0]);
    assert!(state.skill_table.skill_base_hash.is_empty());
    assert!(state.spell_catalog.spells.is_empty());
    assert!(state.soul_emote_catalog.tokens.is_empty());
}

#[test]
fn test_micro_portal_bundle_supports_runtime_table_lookups() {
    let dir = tempdir().expect("tempdir should be created");
    let portal_path = dir.path().join("bundle.hba");
    if !write_micro_portal_hba(&portal_path) {
        return;
    }

    let archive = HbaReader::open(&portal_path).expect("micro portal.hba should open");
    let skill_table = SkillTable::read(&mut std::io::Cursor::new(
        archive
            .get_file_in_namespace(EOR_PORTAL_NAMESPACE, SkillTable::FILE_ID)
            .expect("micro bundle should contain skill table"),
    ))
    .expect("skill table should parse");
    let spell_table = SpellTable::read(&mut std::io::Cursor::new(
        archive
            .get_file_in_namespace(EOR_PORTAL_NAMESPACE, SpellTable::FILE_ID)
            .expect("micro bundle should contain spell table"),
    ))
    .expect("spell table should parse");
    let xp_table = XpTable::read(&mut std::io::Cursor::new(
        archive
            .get_file_in_namespace(EOR_PORTAL_NAMESPACE, XpTable::FILE_ID)
            .expect("micro bundle should contain XP table"),
    ))
    .expect("XP table should parse");
    let motion_kinematics = MotionKinematics::read(&mut std::io::Cursor::new(
        archive
            .get_file_in_namespace(HOLTBURGER_CORE_NAMESPACE, MotionKinematics::FILE_ID)
            .expect("micro bundle should contain motion kinematics"),
    ))
    .expect("motion kinematics should parse");

    let mut state = WorldState::new(Arc::new(WorldBootstrap::new(
        skill_table,
        spell_table,
        xp_table,
        motion_kinematics,
        SoulEmoteCatalog::default(),
    )));

    assert!(!state.skill_table.skill_base_hash.is_empty());
    assert!(!state.xp_table.character_level_xp_list.is_empty());
    assert!(!state.spell_catalog.spells.is_empty());

    let player_guid = Guid(0x5000_0101);
    state.seed_local_player_entity(player_guid, "Player", WorldPosition::default());
    let player_entity = state
        .player_entity_mut()
        .expect("local player entity should exist");
    player_entity.properties.set_int_prop(PropertyInt::Level, 1);
    player_entity
        .properties
        .set_int64_prop(PropertyInt64::TotalExperience, 0);
    player_entity
        .properties
        .set_int64_prop(PropertyInt64::AvailableExperience, 1234);
    player_entity
        .properties
        .set_int_prop(PropertyInt::AvailableSkillCredits, 5);
    player_entity
        .properties
        .set_int64_prop(PropertyInt64::AvailableLuminance, 42);

    let level_info = state.get_level_info();
    assert_eq!(level_info.level, 1);
    assert_eq!(level_info.current_xp, 0);
    assert_eq!(level_info.unspent_xp, 1234);
    assert_eq!(level_info.unspent_skill_points, 5);
    assert_eq!(level_info.available_luminance, 42);
    assert!(level_info.xp_for_next_level > 0);

    let (spell_id, expected_name) = state
        .spell_catalog
        .spells
        .iter()
        .find(|(_, info)| {
            !info.name.is_empty()
                && (!info.description.is_empty() || info.base_mana > 0 || info.power > 0)
        })
        .map(|(id, info)| (*id, info.name.clone()))
        .expect("micro spell catalog should expose at least one detailed spell");

    let resolved_name = state
        .resolve_spell_name(spell_id)
        .expect("spell name should resolve from the micro bundle");
    let resolved_info = state
        .resolve_spell_info(spell_id)
        .expect("spell details should resolve from the micro bundle");

    assert_eq!(resolved_name, expected_name);
    assert_eq!(resolved_info.name, expected_name);
    assert!(
        !resolved_info.description.is_empty()
            || resolved_info.base_mana > 0
            || resolved_info.power > 0
    );

    let (skill_id, expected_costs) = state
        .skill_table
        .skill_base_hash
        .iter()
        .find_map(|(id, base)| {
            crate::stats::SkillType::from_repr(*id)
                .filter(|_| base.trained_cost > 0 || base.specialized_cost > 0)
                .map(|skill| {
                    (
                        skill as u32,
                        (base.trained_cost as u32, base.specialized_cost as u32),
                    )
                })
        })
        .expect("micro skill table should expose a trainable skill");

    let mut events = Vec::new();
    state.player.update_skill(
        crate::player::mutations::SkillUpdateParams {
            skill_id,
            ranks: 0,
            status: 2,
            init: 10,
            xp: 0,
            xp_table: &state.xp_table,
            skill_table: &state.skill_table,
        },
        &mut events,
    );

    let updated_skill = events
        .into_iter()
        .find_map(|event| match event {
            WorldEvent::SkillUpdated(skill) if skill.skill_type as u32 == skill_id => Some(skill),
            _ => None,
        })
        .expect("skill update should emit a SkillUpdated event");

    assert_eq!(
        (updated_skill.trained_cost, updated_skill.specialized_cost),
        expected_costs
    );
    assert!(updated_skill.trained_cost > 0 || updated_skill.specialized_cost > 0);
}

#[test]
fn repo_portal_bundle_supports_default_player_motion_table_profile() {
    let portal_path = repo_assets_hba_path();
    if !portal_path.is_file() {
        eprintln!(
            "skipping motion-table integration probe; missing repo-local {}",
            portal_path.display()
        );
        return;
    }

    let provider = match HbaReader::open(&portal_path) {
        Ok(provider) => Arc::new(provider),
        Err(error) => {
            eprintln!(
                "skipping motion-table integration probe; repo-local {} is not an HBA v2 fixture yet: {}",
                portal_path.display(),
                error
            );
            return;
        }
    };
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0200);
    let motion_kinematics_bytes = match provider
        .get_file_in_namespace(HOLTBURGER_CORE_NAMESPACE, MotionKinematics::FILE_ID)
    {
        Ok(bytes) => bytes,
        Err(_) => {
            eprintln!(
                "skipping motion-table integration probe; repo-local {} does not yet contain holtburger/core motion kinematics",
                portal_path.display()
            );
            return;
        }
    };
    state.set_motion_kinematics(
        MotionKinematics::read(&mut std::io::Cursor::new(motion_kinematics_bytes))
            .expect("repo motion kinematics asset should parse"),
    );
    state.player.guid = player_guid;

    let mut player = Entity::new(player_guid, "Player".to_string(), WorldPosition::default());
    player.properties.set_did_prop(
        holtburger_common::properties::PropertyDataId::MotionTable,
        Guid(0x0900_0001),
    );
    state.entities.insert(player);

    let resolved = state.resolve_player_motion_table_profile();
    match resolved {
        Ok(profile) => {
            eprintln!(
                "resolved repo motion-table profile: run={:?} walk={:?} turn_right={:?}",
                profile.movement_profile.run_forward,
                profile.movement_profile.walk_forward,
                profile.movement_profile.turn_right,
            );
        }
        Err(error) => {
            panic!(
                "repo assets bundle failed to resolve eor/portal motion table 0x09000001: {error}"
            )
        }
    }
}

#[test]
fn test_tick_does_not_integrate_player_velocity() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000124);
    let player_pos = WorldPosition {
        landblock_id: Guid(0x12340000),
        coords: Vector3::new(10.0, 20.0, 30.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    state.player.guid = player_guid;
    let mut player_entity = Entity::new(player_guid, "Player".to_string(), player_pos);
    player_entity.velocity = Vector3::new(3.0, 4.0, 0.0);
    state.add_entity(player_entity);

    let events = state.tick();

    assert!(events.is_empty());
    assert_eq!(state.player_position(), Some(player_pos));
    assert_eq!(
        state.entities.get(player_guid).unwrap().position,
        player_pos
    );
    assert_eq!(
        state.entities.get(player_guid).unwrap().velocity,
        Vector3::new(3.0, 4.0, 0.0)
    );
}

#[test]
fn test_tick_does_not_require_runtime_resource_access() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000125);
    let player_pos = WorldPosition {
        landblock_id: Guid(0x12340000),
        coords: Vector3::new(1.0, 2.0, 3.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    state.player.guid = player_guid;
    let mut player_entity = Entity::new(player_guid, "Player".to_string(), player_pos);
    player_entity.velocity = Vector3::new(1.0, 0.0, 0.0);
    state.add_entity(player_entity);

    let events = state.tick();

    assert!(events.is_empty());
    assert_eq!(state.player_position(), Some(player_pos));
}

#[test]
fn test_player_autonomous_sync_updates_authoritative_player_entity() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000123);
    state.player.guid = player_guid;

    let initial_pos = WorldPosition::default();
    let player_entity = Entity::new(player_guid, "Player".to_string(), initial_pos);
    state.entities.insert(player_entity);

    let sync_data = ServerAutonomousPositionData {
        guid: player_guid,
        coords: Vector3::new(1.0, 1.0, 1.0),
        rotation: holtburger_common::math::Quaternion::identity(),
        instance_sequence: 10,
        server_control_sequence: 20,
        teleport_sequence: 30,
        force_position_sequence: 40,
        contact_flags: 0,
    };

    let events = state.apply_player_autonomous_position(&sync_data);

    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::SelfAutonomousPosition {
            teleport_sequence: 30,
            force_position_sequence: 40,
            server_control_sequence: 20,
        }
    )));

    // The frame carries no cell id — the player's current landblock is
    // carried forward.
    let expected_pos = sync_data.position_in(initial_pos.landblock_id);
    assert_eq!(state.player_position(), Some(expected_pos));
    assert_eq!(
        state.entities.get(player_guid).unwrap().position,
        expected_pos
    );
    assert_eq!(state.player.instance_sequence, 10);
    assert_eq!(state.player.server_control_sequence, 20);
}

#[test]
fn test_stale_player_autonomous_sync_is_ignored() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000123);
    state.player.guid = player_guid;
    state.player.teleport_sequence = 30;
    state.player.force_position_sequence = 40;

    let initial_pos = WorldPosition {
        landblock_id: Guid(0x12340000),
        coords: Vector3::new(5.0, 5.0, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    state.seed_local_player_entity(player_guid, "Player", initial_pos);

    let sync_data = ServerAutonomousPositionData {
        guid: player_guid,
        coords: Vector3::new(1.0, 1.0, 1.0),
        rotation: holtburger_common::math::Quaternion::identity(),
        instance_sequence: 10,
        server_control_sequence: 20,
        teleport_sequence: 30,
        force_position_sequence: 39,
        contact_flags: 0,
    };

    let events = state.apply_player_autonomous_position(&sync_data);

    assert!(events.is_empty());
    assert_eq!(state.player_position(), Some(initial_pos));
    assert_eq!(
        state.entities.get(player_guid).unwrap().position,
        initial_pos
    );
    assert_eq!(state.player.teleport_sequence, 30);
    assert_eq!(state.player.force_position_sequence, 40);
}

#[test]
fn test_remote_update_position_emits_forced_reposition_when_force_sequence_advances() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x6000_0001);
    let initial_pos = WorldPosition {
        landblock_id: Guid(0x01000000),
        coords: Vector3::new(1.0, 2.0, 3.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let mut entity = Entity::new(guid, "Target".to_string(), initial_pos);
    entity.sequences[4] = 30;
    entity.sequences[6] = 40;
    state.entities.insert(entity);

    let msg = GameMessage::UpdatePosition(Box::new(UpdatePositionData {
        guid,
        pos: PositionPack {
            pos: WorldPosition {
                landblock_id: Guid(0x01000000),
                coords: Vector3::new(10.0, 20.0, 0.5),
                rotation: holtburger_common::math::Quaternion::identity(),
            },
            instance_sequence: 8,
            position_sequence: 9,
            teleport_sequence: 30,
            force_position_sequence: 41,
            ..PositionPack::default()
        },
    }));

    let events = state.handle_message(&msg);

    assert_eq!(state.entities.get(guid).unwrap().position.coords.x, 10.0);
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::ForcedReposition {
            guid: event_guid,
            pos,
            sequence: 41,
        } if *event_guid == guid && (pos.coords.x - 10.0).abs() < 1e-5
    )));
}

#[test]
fn test_stale_remote_update_position_is_ignored_when_force_sequence_regresses() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0002);
    let guid = Guid(0x6000_0002);
    let initial_pos = WorldPosition {
        landblock_id: Guid(0x0A0AFFFF),
        coords: Vector3::new(4.0, 5.0, 6.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    state.player.guid = player_guid;
    state.seed_local_player_entity(player_guid, "Player", initial_pos);

    let mut entity = Entity::new(guid, "Target".to_string(), initial_pos);
    entity.sequences[4] = 30;
    entity.sequences[6] = 40;
    state.add_entity(entity);

    let msg = GameMessage::UpdatePosition(Box::new(UpdatePositionData {
        guid,
        pos: PositionPack {
            pos: WorldPosition {
                landblock_id: Guid(0x2020FFFF),
                coords: Vector3::new(40.0, 50.0, 60.0),
                rotation: holtburger_common::math::Quaternion::identity(),
            },
            instance_sequence: 8,
            position_sequence: 9,
            teleport_sequence: 30,
            force_position_sequence: 39,
            ..PositionPack::default()
        },
    }));

    let events = state.handle_message(&msg);

    assert!(events.is_empty());
    assert_eq!(state.entities.get(guid).unwrap().position, initial_pos);

    let nearby: std::collections::HashSet<_> = state
        .get_nearby_world_entities()
        .into_iter()
        .map(|entity| entity.guid)
        .collect();
    assert!(nearby.contains(&guid));
}

#[test]
fn test_remote_autonomous_position_emits_forced_reposition_even_without_sequence_change() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x6000_0003);
    let initial_pos = WorldPosition {
        landblock_id: Guid(0x01000000),
        coords: Vector3::new(0.0, 0.0, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let mut entity = Entity::new(guid, "Target".to_string(), initial_pos);
    entity.sequences[4] = 30;
    entity.sequences[6] = 40;
    state.entities.insert(entity);

    let msg = GameMessage::AutonomousPosition(Box::new(ServerAutonomousPositionData {
        guid,
        coords: Vector3::new(7.0, 8.0, 9.0),
        rotation: holtburger_common::math::Quaternion::identity(),
        instance_sequence: 12,
        server_control_sequence: 13,
        teleport_sequence: 30,
        force_position_sequence: 40,
        contact_flags: 0,
    }));

    let events = state.handle_message(&msg);

    assert_eq!(state.entities.get(guid).unwrap().position.coords.x, 7.0);
    assert_eq!(state.entities.get(guid).unwrap().sequences[5], 13);
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::ForcedReposition {
            guid: event_guid,
            pos,
            sequence: 40,
        } if *event_guid == guid && (pos.coords.x - 7.0).abs() < 1e-5
    )));
}

#[test]
fn test_update_health_updates_target_entity_fraction_and_emits_replace() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x60000001);
    state.add_entity(Entity::new(
        guid,
        "Drudge".to_string(),
        WorldPosition::default(),
    ));

    let msg = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: guid,
        sequence: 1,
        event: GameEvent::UpdateHealth(Box::new(UpdateHealthEventData {
            target: guid,
            health: 0.5,
        })),
    }));

    let events = state.handle_message(&msg);

    assert_eq!(
        state
            .entities
            .get(guid)
            .and_then(|entity| entity.health_fraction),
        Some(0.5)
    );
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::EntityHealthUpdated {
            guid: event_guid,
            health_fraction,
        } if *event_guid == guid && *health_fraction == 0.5
    )));
}

#[test]
fn test_fellowship_full_update_populates_world_state_and_emits_projection() {
    let mut state = WorldState::synthetic();
    state.player.guid = Guid(0x5000_0001);

    let msg = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: state.player.guid,
        sequence: 1,
        event: GameEvent::FellowshipFullUpdate(Box::new(FellowshipFullUpdateEventData {
            fellows: vec![
                FellowshipMemberData {
                    guid: Guid(0x5000_0001),
                    cached_cp: 0,
                    cached_luminance: 0,
                    level: 12,
                    max_health: 180,
                    max_stamina: 150,
                    max_mana: 120,
                    current_health: 170,
                    current_stamina: 140,
                    current_mana: 110,
                    share_loot: 1,
                    name: "Player".to_string(),
                },
                FellowshipMemberData {
                    guid: Guid(0x5000_0032),
                    cached_cp: 0,
                    cached_luminance: 0,
                    level: 18,
                    max_health: 220,
                    max_stamina: 160,
                    max_mana: 140,
                    current_health: 215,
                    current_stamina: 150,
                    current_mana: 130,
                    share_loot: 1,
                    name: "Bravo".to_string(),
                },
            ],
            fellowship_name: "Raid Bus".to_string(),
            leader_guid: Guid(0x5000_0001),
            share_xp: true,
            even_share: false,
            open: true,
            is_locked: true,
            departed_members: Vec::new(),
            fellowship_locks: Vec::new(),
        })),
    }));

    let events = state.handle_message(&msg);

    assert!(matches!(
        state.fellowship.as_ref(),
        Some(fellowship)
            if fellowship.name == "Raid Bus"
                && fellowship.members.len() == 2
                && fellowship.leader_guid == Guid(0x5000_0001)
    ));
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::FellowshipStateUpdated(Some(fellowship))
            if fellowship.name == "Raid Bus" && fellowship.members.len() == 2
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::FellowshipActivity(crate::FellowshipActivity::YouJoined { fellowship_name })
            if fellowship_name == "Raid Bus"
    )));
}

#[test]
fn test_fellowship_update_fellow_creates_placeholder_state_when_snapshot_missing() {
    let mut state = WorldState::synthetic();
    state.player.guid = Guid(0x5000_0001);

    let msg = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: Guid::NULL,
        sequence: 1,
        event: GameEvent::FellowshipUpdateFellow(Box::new(FellowshipUpdateFellowEventData {
            fellow: FellowshipMemberData {
                guid: Guid(0x5000_0001),
                cached_cp: 0,
                cached_luminance: 0,
                level: 12,
                max_health: 180,
                max_stamina: 150,
                max_mana: 120,
                current_health: 170,
                current_stamina: 140,
                current_mana: 110,
                share_loot: 1,
                name: "Player".to_string(),
            },
            update_type: FellowUpdateType::Vitals,
        })),
    }));

    let events = state.handle_message(&msg);

    assert!(matches!(
        state.fellowship.as_ref(),
        Some(fellowship)
            if fellowship.name.is_empty()
                && fellowship.members.len() == 1
                && fellowship.members[0].name == "Player"
    ));
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::FellowshipStateUpdated(Some(fellowship))
            if fellowship.members.len() == 1 && fellowship.members[0].name == "Player"
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::FellowshipActivity(crate::FellowshipActivity::YouJoined { .. })
    )));
}

#[test]
fn test_fellowship_quit_for_local_player_clears_state() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0001);
    state.player.guid = player_guid;
    state.fellowship = Some(FellowshipState {
        name: "Raid Bus".to_string(),
        leader_guid: player_guid,
        share_xp: true,
        even_share: false,
        open: true,
        is_locked: false,
        members: vec![FellowshipMemberState {
            guid: player_guid,
            name: "Player".to_string(),
            level: 12,
            cached_cp: 0,
            cached_luminance: 0,
            max_health: 180,
            max_stamina: 150,
            max_mana: 120,
            current_health: 170,
            current_stamina: 140,
            current_mana: 110,
            share_loot: true,
        }],
        departed_members: Vec::new(),
        locks: Vec::new(),
    });

    let msg = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: Guid::NULL,
        sequence: 1,
        event: GameEvent::FellowshipQuit(Box::new(FellowshipQuitEventData { player_guid })),
    }));

    let events = state.handle_message(&msg);

    assert!(state.fellowship.is_none());
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::FellowshipActivity(crate::FellowshipActivity::YouLeft)
    )));
    assert!(
        events
            .iter()
            .any(|event| matches!(event, WorldEvent::FellowshipStateUpdated(None)))
    );
}

#[test]
fn test_fellowship_quit_for_leader_reassigns_remaining_leader() {
    let mut state = WorldState::synthetic();
    let leader_guid = Guid(0x5000_0001);
    let member_guid = Guid(0x5000_0002);

    state.player.guid = Guid(0x5000_00FF);
    state.fellowship = Some(FellowshipState {
        name: "Raid Bus".to_string(),
        leader_guid,
        share_xp: true,
        even_share: false,
        open: true,
        is_locked: false,
        members: vec![
            FellowshipMemberState {
                guid: leader_guid,
                name: "Leader".to_string(),
                level: 12,
                cached_cp: 0,
                cached_luminance: 0,
                max_health: 180,
                max_stamina: 150,
                max_mana: 120,
                current_health: 170,
                current_stamina: 140,
                current_mana: 110,
                share_loot: true,
            },
            FellowshipMemberState {
                guid: member_guid,
                name: "Bravo".to_string(),
                level: 18,
                cached_cp: 0,
                cached_luminance: 0,
                max_health: 220,
                max_stamina: 160,
                max_mana: 140,
                current_health: 215,
                current_stamina: 150,
                current_mana: 130,
                share_loot: true,
            },
        ],
        departed_members: Vec::new(),
        locks: Vec::new(),
    });

    let msg = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: Guid::NULL,
        sequence: 1,
        event: GameEvent::FellowshipQuit(Box::new(FellowshipQuitEventData {
            player_guid: leader_guid,
        })),
    }));

    let events = state.handle_message(&msg);

    let fellowship = state.fellowship.as_ref().expect("fellowship should remain");
    assert_eq!(fellowship.members.len(), 1);
    assert_eq!(fellowship.members[0].guid, member_guid);
    assert_eq!(fellowship.leader_guid, member_guid);
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::FellowshipStateUpdated(Some(fellowship))
            if fellowship.leader_guid == member_guid && fellowship.members.len() == 1
    )));
}

#[test]
fn test_fellowship_update_fellow_for_new_remote_member_emits_join_activity() {
    let mut state = WorldState::synthetic();
    state.player.guid = Guid(0x5000_0001);
    state.fellowship = Some(FellowshipState {
        name: "Raid Bus".to_string(),
        leader_guid: Guid(0x5000_0001),
        share_xp: true,
        even_share: false,
        open: true,
        is_locked: false,
        members: vec![FellowshipMemberState {
            guid: Guid(0x5000_0001),
            name: "Player".to_string(),
            level: 12,
            cached_cp: 0,
            cached_luminance: 0,
            max_health: 180,
            max_stamina: 150,
            max_mana: 120,
            current_health: 170,
            current_stamina: 140,
            current_mana: 110,
            share_loot: true,
        }],
        departed_members: Vec::new(),
        locks: Vec::new(),
    });

    let msg = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: Guid::NULL,
        sequence: 1,
        event: GameEvent::FellowshipUpdateFellow(Box::new(FellowshipUpdateFellowEventData {
            fellow: FellowshipMemberData {
                guid: Guid(0x5000_0032),
                cached_cp: 0,
                cached_luminance: 0,
                level: 18,
                max_health: 220,
                max_stamina: 160,
                max_mana: 140,
                current_health: 215,
                current_stamina: 150,
                current_mana: 130,
                share_loot: 1,
                name: "Bravo".to_string(),
            },
            update_type: FellowUpdateType::Full,
        })),
    }));

    let events = state.handle_message(&msg);

    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::FellowshipActivity(crate::FellowshipActivity::MemberJoined { member_name })
            if member_name == "Bravo"
    )));
}

#[test]
fn test_private_update_position_non_location_is_stored_without_moving_player() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000123);
    state.player.guid = player_guid;

    let live_position = WorldPosition {
        landblock_id: Guid(0x12340000),
        coords: Vector3::new(5.0, 5.0, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    state.seed_local_player_entity(player_guid, "Player", live_position);

    let saved_position = WorldPosition {
        landblock_id: Guid(0x56780000),
        coords: Vector3::new(42.0, 24.0, 9.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    let events = state.handle_message(&GameMessage::PrivateUpdatePosition(Box::new(
        PrivateUpdatePositionData {
            sequence: 1,
            position_type: PositionType::LastOutsideDeath,
            pos: saved_position,
        },
    )));

    assert!(events.is_empty());
    assert_eq!(state.player_position(), Some(live_position));
    assert_eq!(
        state.entities.get(player_guid).unwrap().position,
        live_position
    );
    assert_eq!(
        state
            .player
            .local_position_overlay(PositionType::LastOutsideDeath),
        Some(saved_position)
    );
}

#[test]
fn test_public_update_position_non_location_for_player_is_stored_without_moving_player() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000123);
    state.player.guid = player_guid;

    let live_position = WorldPosition {
        landblock_id: Guid(0x12340000),
        coords: Vector3::new(1.0, 2.0, 3.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    state.seed_local_player_entity(player_guid, "Player", live_position);

    let sanctuary_position = WorldPosition {
        landblock_id: Guid(0x9ABC0000),
        coords: Vector3::new(11.0, 12.0, 13.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    let events = state.handle_message(&GameMessage::PublicUpdatePosition(Box::new(
        PublicUpdatePositionData {
            sequence: 2,
            guid: player_guid,
            position_type: PositionType::Sanctuary,
            pos: sanctuary_position,
        },
    )));

    assert!(events.is_empty());
    assert_eq!(state.player_position(), Some(live_position));
    assert_eq!(
        state.entities.get(player_guid).unwrap().position,
        live_position
    );
    assert_eq!(
        state.player.local_position_overlay(PositionType::Sanctuary),
        Some(sanctuary_position)
    );
}

#[test]
fn test_public_update_position_non_location_for_other_entity_does_not_move_it() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000123);
    let other_guid = Guid(0x50000999);
    state.player.guid = player_guid;

    state.entities.insert(Entity::new(
        player_guid,
        "Player".to_string(),
        WorldPosition::default(),
    ));

    let live_position = WorldPosition {
        landblock_id: Guid(0x12340000),
        coords: Vector3::new(3.0, 4.0, 5.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    state
        .entities
        .insert(Entity::new(other_guid, "Other".to_string(), live_position));

    let non_live_position = WorldPosition {
        landblock_id: Guid(0x56780000),
        coords: Vector3::new(30.0, 40.0, 50.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    let events = state.handle_message(&GameMessage::PublicUpdatePosition(Box::new(
        PublicUpdatePositionData {
            sequence: 3,
            guid: other_guid,
            position_type: PositionType::LinkedPortalOne,
            pos: non_live_position,
        },
    )));

    assert!(events.is_empty());
    assert_eq!(
        state.entities.get(other_guid).unwrap().position,
        live_position
    );
    assert_eq!(
        state
            .player
            .local_position_overlay(PositionType::LinkedPortalOne),
        None
    );
}

#[test]
fn test_inventory_put_obj_in_container() {
    let mut state = WorldState::synthetic();
    let item_guid = Guid(0x1);
    let container_guid = Guid(0x2);

    // Add the item to entities
    state.entities.insert(Entity::new(
        item_guid,
        "Item".to_string(),
        WorldPosition::default(),
    ));

    let data = InventoryPutObjInContainerEventData {
        item_guid,
        container_guid,
        slot: 0,
        container_type: 0,
    };
    let event = GameEvent::InventoryPutObjInContainer(Box::new(data));
    let msg = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: Guid::NULL,
        sequence: 0,
        event,
    }));

    let events = state.handle_message(&msg);

    let entity = state.entities.get(item_guid).unwrap();
    assert_eq!(entity.container_id(), Some(container_guid));
    assert_eq!(entity.position.landblock_id, Guid::NULL);

    // Check for WorldEvent::PropertiesUpdated
    assert!(events.iter().any(|e| {
        if let WorldEvent::PropertiesUpdated { guid, updates } = e {
            *guid == item_guid
                && updates.iter().any(|u| {
                    matches!(u, PropertyUpdate::InstanceId(PropertyInstanceId::Container, val) if *val == container_guid)
                })
        } else {
            false
        }
    }));
}

#[test]
fn test_inventory_put_object_in_3d() {
    let mut state = WorldState::synthetic();
    let obj_guid = Guid(0x1);

    let mut item = Entity::new(obj_guid, "Item".to_string(), WorldPosition::default());
    item.set_container_id(Some(Guid(0x2)));
    item.set_wielder_id(Some(Guid(0x3)));
    state.entities.insert(item);

    let data = InventoryPutObjectIn3DEventData {
        object_guid: obj_guid,
    };
    let event = GameEvent::InventoryPutObjectIn3D(Box::new(data));
    let msg = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: Guid::NULL,
        sequence: 0,
        event,
    }));

    let events = state.handle_message(&msg);

    let entity = state.entities.get(obj_guid).unwrap();
    assert_eq!(entity.container_id(), None);
    assert_eq!(entity.wielder_id(), None);

    assert!(events.iter().any(|e| {
        if let WorldEvent::PropertiesUpdated { guid, updates } = e {
            *guid == obj_guid
                && updates.iter().any(|u| {
                    matches!(
                        u,
                        PropertyUpdate::InstanceId(PropertyInstanceId::Container, Guid::NULL)
                    )
                })
        } else {
            false
        }
    }));
}

#[test]
fn test_inventory_put_obj_in_container_emits_entity_moved_when_item_leaves_world() {
    let mut state = WorldState::synthetic();
    let container_guid = Guid(0x2);
    let item_guid = Guid(0x3);

    let mut item = Entity::new(
        item_guid,
        "Item".to_string(),
        WorldPosition {
            landblock_id: Guid(0x1234),
            ..WorldPosition::default()
        },
    );
    item.set_wielder_id(Some(Guid(0x9)));
    state.entities.insert(item);

    let data = InventoryPutObjInContainerEventData {
        item_guid,
        container_guid,
        slot: 0,
        container_type: 0,
    };
    let event = GameEvent::InventoryPutObjInContainer(Box::new(data));
    let msg = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: Guid::NULL,
        sequence: 0,
        event,
    }));

    let events = state.handle_message(&msg);

    let entity = state.entities.get(item_guid).unwrap();
    assert_eq!(entity.position.landblock_id, Guid::NULL);
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::EntityMoved {
            guid,
            pos,
        } if *guid == item_guid && pos.landblock_id == Guid::NULL
    )));
}

#[test]
fn test_wield_object() {
    let mut state = WorldState::synthetic();
    let obj_guid = Guid(0x1);
    let wielder_guid = Guid(0x50000001);

    state.entities.insert(Entity::new(
        obj_guid,
        "Weapon".to_string(),
        WorldPosition {
            landblock_id: Guid(0x1234),
            ..WorldPosition::default()
        },
    ));

    let data = WieldObjectEventData {
        object_guid: obj_guid,
        equip_mask: EquipMask::from_bits_truncate(0),
    };
    let event = GameEvent::WieldObject(Box::new(data));
    let msg = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: wielder_guid,
        sequence: 0,
        event,
    }));

    let events = state.handle_message(&msg);

    let entity = state.entities.get(obj_guid).unwrap();
    assert_eq!(entity.wielder_id(), Some(wielder_guid));
    assert_eq!(entity.container_id(), None);

    assert!(events.iter().any(|e| {
        if let WorldEvent::PropertiesUpdated { guid, updates } = e {
            *guid == obj_guid
                && updates.iter().any(|u| {
                    matches!(u, PropertyUpdate::InstanceId(PropertyInstanceId::Wielder, val) if *val == wielder_guid)
                })
        } else {
            false
        }
    }));
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::EntityMoved {
            guid,
            pos,
        } if *guid == obj_guid && pos.landblock_id == Guid::NULL
    )));
}

#[test]
fn test_inventory_remove_object() {
    let mut state = WorldState::synthetic();
    let obj_guid = Guid(0x1);

    state.entities.insert(Entity::new(
        obj_guid,
        "Item".to_string(),
        WorldPosition::default(),
    ));

    let data = InventoryRemoveObjectData {
        object_guid: obj_guid,
    };
    let msg = GameMessage::InventoryRemoveObject(Box::new(data));

    let events = state.handle_message(&msg);

    assert!(state.entities.get(obj_guid).is_some());
    assert!(
        state
            .entity_lifecycle_state(obj_guid)
            .is_some_and(|state| state.explicit_delete_requested)
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, WorldEvent::EntityDespawned(guid) if *guid == obj_guid))
    );
}

#[test]
fn test_player_description_initialization() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000001);
    let player_name = "TestingPlayer".to_string();
    let bootstrap_pos = WorldPosition {
        landblock_id: Guid(0x12340000),
        coords: Vector3::new(12.0, 34.0, 56.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let options1 =
        CharacterOptions1::USE_CRAFT_SUCCESS_DIALOG | CharacterOptions1::HEAR_ALLEGIANCE_CHAT;
    let options2 = CharacterOptions2::SHOW_HELM | CharacterOptions2::HEAR_GENERAL_CHAT;
    let hotbar_spells = vec![vec![111, 222], vec![333]];
    let desired_comps = vec![(42, 7), (99, 12)];
    let spellbook_filters = 0xA5A5_5A5A;
    let gameplay_options = vec![0x10, 0x20, 0x30];
    let mut properties = WorldObjectProperties::default();
    properties.set_int_prop(PropertyInt::Level, 17);
    properties.set_int64_prop(PropertyInt64::AvailableExperience, 12345);

    let data = PlayerDescriptionEventData {
        guid: player_guid,
        sequence: 1,
        name: player_name.clone(),
        wee_type: 1,
        pos: Some(bootstrap_pos),
        properties,
        positions: std::collections::BTreeMap::new(),
        attributes: std::collections::BTreeMap::new(),
        skills: std::collections::BTreeMap::new(),
        enchantments: Vec::new(),
        spells: std::collections::BTreeMap::new(),
        has_health: true,
        options1,
        options2,
        shortcuts: Vec::new(),
        hotbar_spells: hotbar_spells.clone(),
        desired_comps: desired_comps.clone(),
        spellbook_filters,
        gameplay_options: gameplay_options.clone(),
        inventory: Vec::new(),
        equipped_objects: Vec::new(),
    };

    let event = GameEvent::PlayerDescription(Box::new(data));
    let msg = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: player_guid,
        sequence: 1,
        event,
    }));

    let events = state.handle_message(&msg);

    assert_eq!(state.player.guid, player_guid);
    assert_eq!(state.player_name(), player_name);
    assert_eq!(state.player_position(), Some(bootstrap_pos));
    assert_eq!(state.player.options1, options1);
    assert_eq!(state.player.options2, options2);
    assert_eq!(state.player.hotbar_spells, hotbar_spells);
    assert_eq!(state.player.desired_comps, desired_comps);
    assert_eq!(state.player.spellbook_filters, spellbook_filters);
    assert_eq!(state.player.gameplay_options, gameplay_options);
    let player_entity = state
        .entities
        .get(player_guid)
        .expect("player description should eagerly materialize the player entity");
    assert_eq!(player_entity.name(), player_name);
    assert_eq!(player_entity.position, bootstrap_pos);
    assert_eq!(player_entity.get_int_prop(PropertyInt::Level), Some(17));
    assert_eq!(
        player_entity.get_int64_prop(PropertyInt64::AvailableExperience),
        Some(12345)
    );
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::PlayerInfo(data)
            if data.entity.guid == player_guid
                && data.entity.name() == player_name
                && data.entity.position == bootstrap_pos
                && data.level_info.level == 17
    )));
    assert!(events.iter().any(
        |event| matches!(event, WorldEvent::LevelInfoUpdated(level_info) if level_info.level == 17)
    ));
    assert!(
        state
            .player
            .character_option_enabled(CharacterOption::UseCraftingChanceOfSuccessDialog,)
    );
    assert!(
        state
            .player
            .character_option_enabled(CharacterOption::ShowYourHelmOrHeadGear)
    );
    assert!(
        !state
            .player
            .character_option_enabled(CharacterOption::ListenToTradeChat)
    );
}

#[test]
fn test_parent_event_does_not_null_player_landblock() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000001);
    let initial_pos = WorldPosition {
        landblock_id: Guid(0xDA55001C),
        coords: Vector3::new(1.0, 2.0, 3.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    state.player.guid = player_guid;
    state.seed_local_player_entity(player_guid, "Player", initial_pos);

    let msg = GameMessage::ParentEvent(Box::new(ParentEventData {
        parent_guid: Guid(0x8000031B),
        child_guid: player_guid,
        location: 1,
        placement: 1,
        parent_instance_sequence: 0,
        child_position_sequence: 0,
    }));

    state.handle_message(&msg);

    assert_eq!(
        state
            .player_position()
            .expect("player entity should exist")
            .landblock_id,
        initial_pos.landblock_id
    );
    assert_eq!(
        state
            .entities
            .get(player_guid)
            .unwrap()
            .position
            .landblock_id,
        initial_pos.landblock_id
    );
}

#[test]
fn test_player_wielder_iid_update_keeps_position() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000001);
    let initial_pos = WorldPosition {
        landblock_id: Guid(0xDA55001C),
        coords: Vector3::new(1.0, 2.0, 3.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    state.player.guid = player_guid;
    state.seed_local_player_entity(player_guid, "Player", initial_pos);

    let msg = GameMessage::PublicUpdatePropertyInstanceId(Box::new(UpdatePropertyInstanceId {
        sequence: 0,
        guid: player_guid,
        property: PropertyInstanceId::Wielder as u32,
        value: Guid(0x8000031B),
    }));

    state.handle_message(&msg);

    assert_eq!(
        state
            .player_position()
            .expect("player entity should exist")
            .landblock_id,
        initial_pos.landblock_id
    );
    assert_eq!(
        state
            .entities
            .get(player_guid)
            .unwrap()
            .position
            .landblock_id,
        initial_pos.landblock_id
    );
    assert_eq!(
        state.entities.get(player_guid).unwrap().wielder_id(),
        Some(Guid(0x8000031B))
    );
}

#[test]
fn test_object_create_reuses_upsert_path_and_clears_explicit_delete() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x90000001);

    state.entities.insert(Entity::new(
        guid,
        "Original".to_string(),
        WorldPosition::default(),
    ));
    state.mark_entity_explicit_delete(guid);

    let mut data = ObjectDescriptionData::with_guid(guid);
    data.public_weenie_desc.name = Some("Replacement".to_string());
    let msg = GameMessage::ObjectCreate(Box::new(data));

    let events = state.handle_message(&msg);

    assert!(
        matches!(events.first(), Some(WorldEvent::EntityReplaced(entity)) if entity.name() == "Replacement")
    );
    assert_eq!(state.entities.get(guid).unwrap().name(), "Replacement");
    assert!(state.entity_lifecycle_state(guid).is_none());
}

#[test]
fn test_self_object_create_bootstraps_player_position() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000042);

    let initial_pos = WorldPosition {
        landblock_id: Guid(0x12340000),
        coords: Vector3::new(1.0, 2.0, 3.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let player_description = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: player_guid,
        sequence: 1,
        event: GameEvent::PlayerDescription(Box::new(PlayerDescriptionEventData {
            guid: player_guid,
            sequence: 1,
            name: "Player".to_string(),
            wee_type: 1,
            pos: Some(initial_pos),
            properties: WorldObjectProperties::default(),
            positions: std::collections::BTreeMap::new(),
            attributes: std::collections::BTreeMap::new(),
            skills: std::collections::BTreeMap::new(),
            enchantments: Vec::new(),
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
    let _ = state.handle_message(&player_description);

    let bootstrap_pos = WorldPosition {
        landblock_id: Guid(0x12340010),
        coords: Vector3::new(11.0, 22.0, 33.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    let mut data = ObjectDescriptionData::with_guid(player_guid);
    data.public_weenie_desc.name = Some("Player".to_string());
    data.pos = Some(bootstrap_pos);
    data.movement_data = Some(spawn_invalid_motion_data(
        MotionStance::NonCombat,
        InterpretedMotionCommand::RUN_FORWARD,
        4.5,
    ));
    data.autonomous_movement = Some(true);

    let msg = GameMessage::ObjectCreate(Box::new(data));
    let events = state.handle_message(&msg);

    assert_eq!(state.player_position(), Some(bootstrap_pos));
    assert_eq!(
        state.entities.get(player_guid).unwrap().position,
        bootstrap_pos
    );
    assert_eq!(
        state.player.last_server_motion_style,
        Some(MotionStance::NonCombat)
    );
    let motion_snapshot = state
        .entities
        .get(player_guid)
        .unwrap()
        .motion_snapshot
        .expect("self object create should hydrate motion snapshot from spawn movement data");
    assert_eq!(motion_snapshot.current_style, Some(MotionStance::NonCombat));
    assert_eq!(
        motion_snapshot.forward_command,
        Some(InterpretedMotionCommand::RUN_FORWARD)
    );
    assert_eq!(
        motion_snapshot.forward_speed.map(|speed| speed.to_f32()),
        Some(4.5)
    );
    assert!(state.entity_lifecycle_state(player_guid).is_none());
    assert!(!events.is_empty());
}

#[test]
fn test_self_object_create_preserves_player_description_properties() {
    // PlayerDescription-only properties (Level, TotalExperience, …) must
    // survive a re-sent self ObjectCreate: ACE re-creates the player on
    // portal/visibility transitions and the create carries no private dump.
    // Live soak v6.4 (2026-07-18): level_info.level read 0 from the first
    // in-dungeon re-create until relog while unspent XP kept updating.
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000043);

    let mut properties = WorldObjectProperties::default();
    properties.ints.insert(PropertyInt::Level, 1);
    properties
        .int64s
        .insert(PropertyInt64::TotalExperience, 13);
    let player_description = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: player_guid,
        sequence: 1,
        event: GameEvent::PlayerDescription(Box::new(PlayerDescriptionEventData {
            guid: player_guid,
            sequence: 1,
            name: "Player".to_string(),
            wee_type: 1,
            pos: Some(WorldPosition::default()),
            properties,
            positions: std::collections::BTreeMap::new(),
            attributes: std::collections::BTreeMap::new(),
            skills: std::collections::BTreeMap::new(),
            enchantments: Vec::new(),
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
    let _ = state.handle_message(&player_description);
    assert_eq!(state.get_level_info().level, 1);

    let mut data = ObjectDescriptionData::with_guid(player_guid);
    data.public_weenie_desc.name = Some("Player".to_string());
    let msg = GameMessage::ObjectCreate(Box::new(data));
    let _ = state.handle_message(&msg);

    assert_eq!(
        state.player_int_property(PropertyInt::Level),
        Some(1),
        "self ObjectCreate must not wipe PlayerDescription-only properties"
    );
    assert_eq!(state.get_level_info().level, 1);
    assert_eq!(state.get_level_info().current_xp, 13);

    // Second wipe path (live soak v6.5, 2026-07-18): the player ENTITY can be
    // gone entirely (explicit-delete sweep) when the re-create arrives — the
    // existing-entity merge has nothing to merge from. The stashed
    // PlayerDescription dump must re-seed the private properties.
    state.entities.remove(player_guid);
    let mut data2 = ObjectDescriptionData::with_guid(player_guid);
    data2.public_weenie_desc.name = Some("Player".to_string());
    let _ = state.handle_message(&GameMessage::ObjectCreate(Box::new(data2)));
    assert_eq!(
        state.player_int_property(PropertyInt::Level),
        Some(1),
        "re-create after entity removal must re-seed from the stashed PlayerDescription"
    );
    assert_eq!(state.get_level_info().current_xp, 13);
}

#[test]
fn test_self_object_create_does_not_wipe_player_inventory() {
    // Hardening (2026-07-20): a self ObjectCreate (guid == player guid) routes
    // through inventory::handle_message's ObjectCreate arm, which calls
    // sync_player_ownership_for_entity unconditionally. The player entity has
    // no container_id/wielder_id, so held/wielded both compute false and the
    // recursive removal would strip the player guid + its whole contained
    // subtree (carried items + coins) from player.inventory. ACE self-heals on
    // relog (item re-stream) but a mid-session self-recreate WITHOUT item
    // resend (cloak/decloak) would leave inventory empty forever. The guid ==
    // player.guid guard prevents that.
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000045);
    let item_guid = Guid(0x60000045);

    state.player.guid = player_guid;
    state.entities.insert(Entity::new(
        player_guid,
        "Player".to_string(),
        WorldPosition::default(),
    ));

    // A pyreal-like item held by the player: container_id == player guid and
    // present in the client-side inventory set.
    let mut item = Entity::new(item_guid, "Pyreal".to_string(), WorldPosition::default());
    item.set_container_id(Some(player_guid));
    item.position.landblock_id = Guid::NULL;
    state.entities.insert(item);
    state.player.add_to_inventory(item_guid);
    assert!(
        state.player.inventory.contains(&item_guid),
        "precondition: item starts in player inventory"
    );

    // Act: feed a self ObjectCreate through the real routing fall-through
    // (player self-create arm returns false → inventory arm runs).
    let mut data = ObjectDescriptionData::with_guid(player_guid);
    data.public_weenie_desc.name = Some("Player".to_string());
    let _ = state.handle_message(&GameMessage::ObjectCreate(Box::new(data)));

    assert!(
        state.player.inventory.contains(&item_guid),
        "self ObjectCreate must not wipe the player's own inventory"
    );
}

#[test]
fn test_self_object_create_reconciles_items_created_before_player_guid() {
    // Varek coins=0 root-cause reproduction (2026-07-20), through the real
    // routing/inventory handler path.
    //
    // `sync_player_ownership_for_entity` files an item into `player.inventory`
    // ONLY at the instant its ObjectCreate is processed, computing ownership
    // from `container_id == player.guid`. If that create is handled while the
    // player guid is still unset (NULL), held computes false, the item is
    // silently dropped, and nothing re-reconciles it — the item exists in the
    // world model forever but `player.inventory` (and coins) never sees it.
    // This mirrors the observed Varek pyreal miss: the coin was received and
    // parsed (container == player) yet absent from `playerInventory()`.
    //
    // Fix: the player's OWN ObjectCreate (identity now known) runs a bounded
    // one-shot reconcile over every entity already pointing at the player.
    //
    // Pre-fix: the self-create is a no-op for other entities → the coin stays
    // unfiled → this test fails. Post-fix: the reconcile re-files it.
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000013F);
    let coin_guid = Guid(0x8000069A); // Varek's pyreal guid (early in the stream)
    let sword_guid = Guid(0x80000696); // a wielded item, also created early

    // --- Identity NOT yet established: player guid is still NULL. ---
    state.player.guid = Guid::NULL;

    // The coin's ObjectCreate arrives with container == the (future) player
    // guid, routed through the real inventory handler.
    let mut coin = ObjectDescriptionData::with_guid(coin_guid);
    coin.public_weenie_desc.name = Some("Pyreal".to_string());
    coin.public_weenie_desc.container_id = Some(player_guid);
    let _ = state.handle_message(&GameMessage::ObjectCreate(Box::new(coin)));

    // A wielded item created in the same pre-identity window.
    let mut sword = ObjectDescriptionData::with_guid(sword_guid);
    sword.public_weenie_desc.name = Some("Sword".to_string());
    sword.public_weenie_desc.wielder_id = Some(player_guid);
    let _ = state.handle_message(&GameMessage::ObjectCreate(Box::new(sword)));

    // The miss: neither was filed, because the player guid was unset when the
    // creates were processed.
    assert!(
        !state.player.inventory.contains(&coin_guid),
        "precondition: coin created before player guid is unfiled"
    );
    assert!(
        !state.player.inventory.contains(&sword_guid),
        "precondition: wielded item created before player guid is unfiled"
    );

    // --- The player's identity becomes known and its own ObjectCreate lands
    //     (ACE's SendSelf: PlayerCreate sets the guid, then CreateObject(self)). ---
    state.player.guid = player_guid;
    let mut player = ObjectDescriptionData::with_guid(player_guid);
    player.public_weenie_desc.name = Some("Varek".to_string());
    let _ = state.handle_message(&GameMessage::ObjectCreate(Box::new(player)));

    // The reconcile re-files everything the player already owns.
    assert!(
        state.player.inventory.contains(&coin_guid),
        "self ObjectCreate must reconcile an item created before the player guid was known"
    );
    assert!(
        state.player.inventory.contains(&sword_guid),
        "self ObjectCreate must reconcile a wielded item created before the player guid was known"
    );
}

#[test]
fn test_get_level_info_derives_level_from_xp_when_property_absent() {
    // Belt-and-braces for any wipe path the upsert re-seed misses: a level-0
    // read with a real XP table derives the level from TotalExperience
    // (index = level, value = cumulative XP; level 1 costs 0).
    let mut state = WorldState::synthetic();
    state.xp_table = Arc::new(holtburger_dat::file_type::XpTable {
        character_level_xp_list: vec![0, 0, 1000, 3000],
        ..Default::default()
    });
    let player_guid = Guid(0x50000044);
    state.seed_local_player_entity(player_guid, "Player", WorldPosition::default());
    state
        .entities
        .get_mut(player_guid)
        .unwrap()
        .properties
        .int64s
        .insert(PropertyInt64::TotalExperience, 1500);
    // No PropertyInt::Level anywhere.
    assert_eq!(state.get_level_info().level, 2, "1500 xp meets level 2 (1000), not 3 (3000)");
    state
        .entities
        .get_mut(player_guid)
        .unwrap()
        .properties
        .int64s
        .insert(PropertyInt64::TotalExperience, 13);
    assert_eq!(state.get_level_info().level, 1, "sub-level-2 xp still reads level 1, never 0");
}

fn spawn_invalid_motion_data(
    style: MotionStance,
    forward_command: InterpretedMotionCommand,
    forward_speed: f32,
) -> Vec<u8> {
    let mut data = Vec::new();
    (MovementType::Invalid as u8).pack(&mut data);
    0u8.pack(&mut data);
    style.interpreted().pack(&mut data);
    InterpretedMotionState {
        flags: MovementStateFlags::CURRENT_STYLE
            | MovementStateFlags::FORWARD_COMMAND
            | MovementStateFlags::FORWARD_SPEED,
        num_commands: 0,
        current_style: Some(style.interpreted()),
        forward_command: Some(forward_command),
        sidestep_command: None,
        turn_command: None,
        forward_speed: Some(forward_speed),
        sidestep_speed: None,
        turn_speed: None,
        commands: Vec::new(),
    }
    .pack(&mut data);
    data
}

#[test]
fn test_object_delete_marks_explicit_delete_without_inline_despawn() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x90000002);

    state.entities.insert(Entity::new(
        guid,
        "DeleteMe".to_string(),
        WorldPosition::default(),
    ));

    let msg = GameMessage::ObjectDelete(Box::new(ObjectDeleteData { guid }));

    let events = state.handle_message(&msg);

    assert!(state.entities.get(guid).is_some());
    assert!(
        state
            .entity_lifecycle_state(guid)
            .is_some_and(|state| state.explicit_delete_requested)
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, WorldEvent::EntityDespawned(target) if *target == guid))
    );
}

#[test]
fn test_container_iid_update_tracks_player_inventory_and_clears_deadline() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000001);
    let guid = Guid(0x90000003);

    state.player.guid = player_guid;
    state.entities.insert(Entity::new(
        player_guid,
        "Player".to_string(),
        WorldPosition::default(),
    ));

    let mut item = Entity::new(guid, "Item".to_string(), WorldPosition::default());
    item.position.landblock_id = Guid::NULL;
    state.entities.insert(item);
    state.set_entity_prune_deadline(guid, state.current_server_time() - 1.0);

    let msg = GameMessage::PublicUpdatePropertyInstanceId(Box::new(UpdatePropertyInstanceId {
        sequence: 0,
        guid,
        property: PropertyInstanceId::Container as u32,
        value: player_guid,
    }));

    let _ = state.handle_message(&msg);

    assert!(state.player.inventory.contains(&guid));
    assert!(state.entity_lifecycle_state(guid).is_none());
    assert_eq!(
        state.entities.get(guid).unwrap().position.landblock_id,
        Guid::NULL
    );
}

#[test]
fn test_pickup_event_marks_unretained_entity_for_sweep() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x90000004);

    state.entities.insert(Entity::new(
        guid,
        "GroundLoot".to_string(),
        WorldPosition {
            landblock_id: Guid(0x1234),
            ..WorldPosition::default()
        },
    ));

    let msg = GameMessage::PickupEvent(Box::new(PickupEventData {
        guid,
        instance_sequence: 0,
        position_sequence: 0,
    }));

    let events = state.handle_message(&msg);

    assert!(state.entities.get(guid).is_some());
    assert_eq!(
        state.entities.get(guid).unwrap().position.landblock_id,
        Guid::NULL
    );
    assert!(
        state
            .entity_lifecycle_state(guid)
            .is_some_and(|state| state.explicit_delete_requested)
    );
    assert!(events.iter().any(|event| matches!(
        event,
        WorldEvent::EntityMoved {
            guid: event_guid,
            pos,
        } if *event_guid == guid && pos.landblock_id == Guid::NULL
    )));
}

#[test]
fn test_explicit_delete_hides_entity_from_filtered_access() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0xABC);

    state.entities.insert(Entity::new(
        guid,
        "HiddenSoon".to_string(),
        WorldPosition::default(),
    ));

    state.mark_entity_explicit_delete(guid);

    assert!(state.entities.get(guid).is_some());
    assert!(state.get_visible_entity(guid).is_none());
    assert_eq!(state.iter_visible_entities().count(), 0);
}

#[test]
fn test_retention_snapshot_reflects_lifecycle_metadata() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0xDEF);
    let mut entity = Entity::new(guid, "Preview".to_string(), WorldPosition::default());
    entity.position.landblock_id = Guid::NULL;
    state.entities.insert(entity);

    state.mark_trade_preview(guid);
    state.mark_container_preview(guid);
    state.mark_entity_explicit_delete(guid);
    state.set_entity_prune_deadline(guid, 5.0);

    let snapshot = state.retention_snapshot(guid, 10.0).unwrap();
    assert!(!snapshot.in_world);
    assert!(snapshot.trade_preview);
    assert!(snapshot.container_preview);
    assert!(snapshot.explicit_delete_requested);
    assert!(snapshot.prune_deadline_expired);
}

#[test]
fn test_remove_entity_clears_lifecycle_metadata() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x1234);

    state.entities.insert(Entity::new(
        guid,
        "Disposable".to_string(),
        WorldPosition::default(),
    ));
    state.mark_entity_explicit_delete(guid);

    state.remove_entity(guid);

    assert!(state.entity_lifecycle_state(guid).is_none());
}

#[test]
fn test_upsert_entity_from_create_replaces_in_place() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x4321);
    let mut events = Vec::new();

    let original = Entity::new(guid, "Original".to_string(), WorldPosition::default());
    state.upsert_entity_from_create(original, &mut events);
    assert!(matches!(events.first(), Some(WorldEvent::EntitySpawned(_))));

    state.mark_entity_explicit_delete(guid);
    events.clear();

    let replacement = Entity::new(guid, "Replacement".to_string(), WorldPosition::default());
    let outcome = state.upsert_entity_from_create(replacement, &mut events);

    assert!(matches!(outcome, EntityUpsertKind::Replaced));
    assert!(matches!(
        events.first(),
        Some(WorldEvent::EntityReplaced(_))
    ));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, WorldEvent::EntitySpawned(entity) if entity.guid == guid))
    );
    assert!(state.entity_lifecycle_state(guid).is_none());
    assert_eq!(state.entities.get(guid).unwrap().name(), "Replacement");
}

#[test]
fn test_add_entity_seeds_remote_body_sidecar() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x6200_0001);
    let position = WorldPosition {
        landblock_id: Guid(0x0101_FFFF),
        coords: Vector3::new(3.0, 4.0, 5.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let mut entity = Entity::new(guid, "Remote".to_string(), position);
    entity.velocity = Vector3::new(1.0, 2.0, 0.0);
    entity.omega = Vector3::new(0.0, 0.0, 0.5);

    state.add_entity(entity);

    let body = state
        .scene
        .body(SpatialBodyId::Entity(guid))
        .expect("remote entity body should be seeded");
    assert_eq!(body.authoritative_pose, Some(position));
    assert_eq!(body.pose, position);
    assert_eq!(body.velocity, Vector3::new(1.0, 2.0, 0.0));
    assert_eq!(body.omega, Vector3::new(0.0, 0.0, 0.5));
    assert_eq!(body.sampling.mode, SpatialSampleMode::AuthoritativeOnly);
}

#[test]
fn test_player_authoritative_updates_seed_local_player_body() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0100);
    let initial_pos = WorldPosition {
        landblock_id: Guid(0x1111_FFFF),
        coords: Vector3::new(1.0, 1.0, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    state.player.guid = player_guid;
    state.seed_local_player_entity(player_guid, "Player", initial_pos);

    let moved = WorldPosition {
        landblock_id: Guid(0x2222_FFFF),
        coords: Vector3::new(9.0, 8.0, 7.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    state.set_player_position(moved);
    state.set_player_vector(Vector3::new(4.0, 5.0, 0.0), Vector3::new(0.0, 0.0, 2.0));

    let body = state
        .scene
        .body(SpatialBodyId::LocalPlayer(player_guid))
        .expect("local player body should be reconciled from authoritative entity state");
    assert_eq!(body.authoritative_pose, Some(moved));
    assert_eq!(body.pose, moved);
    assert_eq!(body.velocity, Vector3::new(4.0, 5.0, 0.0));
    assert_eq!(body.omega, Vector3::new(0.0, 0.0, 2.0));
    assert_eq!(body.sampling.mode, SpatialSampleMode::AuthoritativeOnly);
}

#[test]
fn test_remote_position_reset_suspends_body_sampling() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x6200_0002);
    let initial_pos = WorldPosition {
        landblock_id: Guid(0x0100_0000),
        coords: Vector3::new(1.0, 2.0, 3.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let mut entity = Entity::new(guid, "Target".to_string(), initial_pos);
    entity.sequences[4] = 30;
    entity.sequences[6] = 40;
    state.add_entity(entity);

    let accepted = state.apply_entity_position_pack(
        guid,
        &PositionPack {
            pos: WorldPosition {
                landblock_id: Guid(0x0200_0000),
                coords: Vector3::new(10.0, 20.0, 30.0),
                rotation: holtburger_common::math::Quaternion::identity(),
            },
            instance_sequence: 2,
            position_sequence: 3,
            teleport_sequence: 30,
            force_position_sequence: 41,
            ..PositionPack::default()
        },
        &mut Vec::new(),
    );

    assert!(accepted);
    let body = state
        .scene
        .body(SpatialBodyId::Entity(guid))
        .expect("remote body should remain present after correction");
    assert_eq!(body.pose.coords, Vector3::new(10.0, 20.0, 30.0));
    assert_eq!(
        body.authoritative_pose.map(|pose| pose.coords),
        Some(Vector3::new(10.0, 20.0, 30.0))
    );
    assert_eq!(body.sampling.mode, SpatialSampleMode::Suspended);
}

#[test]
fn test_remote_position_pack_updates_and_clears_linear_velocity() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x6200_0005);
    let initial_pos = WorldPosition {
        landblock_id: Guid(0x0100_0000),
        coords: Vector3::new(1.0, 2.0, 3.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let mut entity = Entity::new(guid, "Target".to_string(), initial_pos);
    entity.velocity = Vector3::new(0.0, 0.0, 20.046_688);
    state.add_entity(entity);

    let mut falling_events = Vec::new();
    let applied = state.apply_entity_position_pack(
        guid,
        &PositionPack {
            pos: WorldPosition {
                landblock_id: Guid(0x0100_0000),
                coords: Vector3::new(9.745_981, -58.954_994, 0.004_999_995),
                rotation: holtburger_common::math::Quaternion::identity(),
            },
            velocity: Some(Vector3::new(-1.327_315_8, 5.460_433_5, -18.468_733)),
            instance_sequence: 88,
            position_sequence: 285,
            teleport_sequence: 0,
            force_position_sequence: 0,
            flags: UpdatePositionFlag::HAS_VELOCITY,
            ..PositionPack::default()
        },
        &mut falling_events,
    );

    assert!(applied);
    assert_eq!(
        state
            .entities
            .get(guid)
            .expect("entity should exist")
            .velocity,
        Vector3::new(-1.327_315_8, 5.460_433_5, -18.468_733)
    );
    assert!(falling_events.iter().any(|event| matches!(
        event,
        WorldEvent::EntityVectorUpdated {
            guid: event_guid,
            velocity,
            ..
        } if *event_guid == guid
            && *velocity == Vector3::new(-1.327_315_8, 5.460_433_5, -18.468_733)
    )));

    let mut grounded_events = Vec::new();
    let applied = state.apply_entity_position_pack(
        guid,
        &PositionPack {
            pos: WorldPosition {
                landblock_id: Guid(0x0100_0000),
                coords: Vector3::new(9.745_981, -58.954_994, 0.004_999_995),
                rotation: holtburger_common::math::Quaternion::identity(),
            },
            instance_sequence: 88,
            position_sequence: 286,
            teleport_sequence: 0,
            force_position_sequence: 0,
            flags: UpdatePositionFlag::IS_GROUNDED,
            ..PositionPack::default()
        },
        &mut grounded_events,
    );

    assert!(applied);
    assert_eq!(
        state
            .entities
            .get(guid)
            .expect("entity should exist")
            .velocity,
        Vector3::zero()
    );
    let body = state
        .scene
        .body(SpatialBodyId::Entity(guid))
        .expect("remote body should remain present after grounded snap");
    assert_eq!(body.velocity, Vector3::zero());
    assert!(grounded_events.iter().any(|event| matches!(
        event,
        WorldEvent::EntityVectorUpdated {
            guid: event_guid,
            velocity,
            ..
        } if *event_guid == guid && *velocity == Vector3::zero()
    )));
}

#[test]
fn test_remove_entity_retires_body_sidecar() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x6200_0003);
    state.add_entity(Entity::new(
        guid,
        "Disposable".to_string(),
        WorldPosition {
            landblock_id: Guid(0x0303_FFFF),
            ..Default::default()
        },
    ));

    let removed = state.remove_entity(guid);

    assert!(removed.is_some());
    assert!(state.scene.body(SpatialBodyId::Entity(guid)).is_none());
}

#[test]
fn test_clear_world_presence_retires_body_sidecar() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x6200_0004);
    state.add_entity(Entity::new(
        guid,
        "Contained".to_string(),
        WorldPosition {
            landblock_id: Guid(0x0404_FFFF),
            ..Default::default()
        },
    ));

    let cleared = state.clear_entity_world_presence(guid);

    assert!(cleared.is_some());
    assert!(state.scene.body(SpatialBodyId::Entity(guid)).is_none());
}

#[test]
fn test_tick_sweeps_explicit_delete_without_movement() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000123);
    let target_guid = Guid(0x60000123);

    state.player.guid = player_guid;
    state.entities.insert(Entity::new(
        player_guid,
        "Player".to_string(),
        WorldPosition::default(),
    ));
    state.entities.insert(Entity::new(
        target_guid,
        "Target".to_string(),
        WorldPosition::default(),
    ));
    state.mark_entity_explicit_delete(target_guid);

    let events = state.tick();

    assert!(state.entities.get(target_guid).is_none());
    assert!(
        events.iter().any(
            |event| matches!(event, WorldEvent::EntityDespawned(guid) if *guid == target_guid)
        )
    );
}

#[test]
fn test_tick_sweeps_expired_deadline_without_movement() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000123);
    let target_guid = Guid(0x60000124);

    state.player.guid = player_guid;
    state.entities.insert(Entity::new(
        player_guid,
        "Player".to_string(),
        WorldPosition::default(),
    ));

    let mut target = Entity::new(target_guid, "Target".to_string(), WorldPosition::default());
    target.position.landblock_id = Guid::NULL;
    state.entities.insert(target);
    state.set_entity_prune_deadline(target_guid, state.current_server_time() - 1.0);

    let events = state.tick();

    assert!(state.entities.get(target_guid).is_none());
    assert!(
        events.iter().any(
            |event| matches!(event, WorldEvent::EntityDespawned(guid) if *guid == target_guid)
        )
    );
}

#[test]
fn apply_set_state_updates_local_player_instance_sequence_and_entity_physics_state() {
    let mut state = WorldState::synthetic();
    state.player.guid = Guid(0x5000_0001);
    state.player.instance_sequence = 0;
    state.seed_local_player_entity(state.player.guid, "Player", WorldPosition::default());
    let mut events = Vec::new();

    let handled = state.apply_set_state_update(
        &SetStateData {
            guid: state.player.guid,
            physics_state: PhysicsState::REPORT_COLLISIONS | PhysicsState::IGNORE_COLLISIONS,
            instance_sequence: 1649,
            state_sequence: 1,
        },
        &mut events,
    );

    assert!(handled);
    assert_eq!(state.player.instance_sequence, 1649);
    let player_entity = state
        .player_entity()
        .expect("local player entity should exist");
    assert_eq!(
        player_entity.physics_state,
        PhysicsState::REPORT_COLLISIONS | PhysicsState::IGNORE_COLLISIONS
    );
    assert_eq!(
        player_entity
            .properties
            .get_int_prop(PropertyInt::PhysicsState),
        Some((PhysicsState::REPORT_COLLISIONS | PhysicsState::IGNORE_COLLISIONS).bits() as i32)
    );
    assert!(
        player_entity
            .properties
            .get_bool_prop(PropertyBool::IgnoreCollisions)
    );
    assert!(matches!(
        events.as_slice(),
        [WorldEvent::EntityStateUpdated {
            guid,
            physics_state,
        }] if *guid == state.player.guid
            && *physics_state
                == (PhysicsState::REPORT_COLLISIONS | PhysicsState::IGNORE_COLLISIONS)
    ));
}

/// Phase 6 step E: a SetState update targeting a door-flagged entity
/// emits both `EntityStateUpdated` and `DoorStateChanged`. ACE's
/// `Door.cs::Open()` sets `Ethereal = true` and broadcasts via
/// `GameMessageSetState`; the client maps that to
/// `DoorState::Open`. The non-door equivalent test above proves
/// non-door entities only emit `EntityStateUpdated`.
#[test]
fn apply_set_state_emits_door_state_changed_open_for_ethereal_door() {
    use crate::events::DoorState;
    use holtburger_common::properties::ObjectDescriptionFlag;
    use holtburger_protocol::messages::object::messages::properties::SetStateData;

    let mut state = WorldState::synthetic();
    let door_guid = Guid(0x5000_DEAD);
    let mut door = Entity::new(door_guid, "Door".into(), WorldPosition::default());
    door.flags = ObjectDescriptionFlag::DOOR;
    state.entities.insert(door);

    let mut events = Vec::new();
    state.apply_set_state_update(
        &SetStateData {
            guid: door_guid,
            physics_state: PhysicsState::ETHEREAL,
            instance_sequence: 0,
            state_sequence: 1,
        },
        &mut events,
    );

    let door_events: Vec<&WorldEvent> = events
        .iter()
        .filter(|e| matches!(e, WorldEvent::DoorStateChanged { .. }))
        .collect();
    assert_eq!(door_events.len(), 1);
    assert!(matches!(
        door_events[0],
        WorldEvent::DoorStateChanged { guid, state: DoorState::Open } if *guid == door_guid
    ));
}

/// Phase 6 step E: closing a door (clearing ETHEREAL) emits
/// `DoorStateChanged { state: Closed }`.
#[test]
fn apply_set_state_emits_door_state_changed_closed_for_clear_ethereal() {
    use crate::events::DoorState;
    use holtburger_common::properties::ObjectDescriptionFlag;
    use holtburger_protocol::messages::object::messages::properties::SetStateData;

    let mut state = WorldState::synthetic();
    let door_guid = Guid(0x5000_DEAF);
    let mut door = Entity::new(door_guid, "Door".into(), WorldPosition::default());
    door.flags = ObjectDescriptionFlag::DOOR;
    door.physics_state = PhysicsState::ETHEREAL;
    state.entities.insert(door);

    let mut events = Vec::new();
    state.apply_set_state_update(
        &SetStateData {
            guid: door_guid,
            physics_state: PhysicsState::NONE,
            instance_sequence: 0,
            state_sequence: 2,
        },
        &mut events,
    );

    assert!(events.iter().any(|e| matches!(
        e,
        WorldEvent::DoorStateChanged { guid, state: DoorState::Closed } if *guid == door_guid
    )));
}

/// Phase 6 step E: a SetState update on a non-door entity must NOT
/// emit `DoorStateChanged`. Guards against a future refactor that
/// loses the `ObjectDescriptionFlag::DOOR` gate and starts emitting
/// the event for every state change.
#[test]
fn apply_set_state_skips_door_state_changed_for_non_door() {
    use holtburger_protocol::messages::object::messages::properties::SetStateData;

    let mut state = WorldState::synthetic();
    let entity_guid = Guid(0x6000_BABE);
    let entity = Entity::new(entity_guid, "Lamp".into(), WorldPosition::default());
    state.entities.insert(entity);

    let mut events = Vec::new();
    state.apply_set_state_update(
        &SetStateData {
            guid: entity_guid,
            physics_state: PhysicsState::ETHEREAL,
            instance_sequence: 0,
            state_sequence: 1,
        },
        &mut events,
    );

    assert!(
        !events
            .iter()
            .any(|e| matches!(e, WorldEvent::DoorStateChanged { .. }))
    );
}

#[test]
fn test_tick_does_not_sweep_unexpired_deadline() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000123);
    let target_guid = Guid(0x60000125);

    state.player.guid = player_guid;
    state.entities.insert(Entity::new(
        player_guid,
        "Player".to_string(),
        WorldPosition::default(),
    ));

    let mut target = Entity::new(target_guid, "Target".to_string(), WorldPosition::default());
    target.position.landblock_id = Guid::NULL;
    state.entities.insert(target);
    state.set_entity_prune_deadline(target_guid, state.current_server_time() + 60.0);

    let events = state.tick();

    assert!(state.entities.get(target_guid).is_some());
    assert!(events.is_empty());
}

#[test]
fn test_tick_runs_sweep_without_player_guid() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x70000123);

    state.entities.insert(Entity::new(
        guid,
        "Orphan".to_string(),
        WorldPosition::default(),
    ));
    state.mark_entity_explicit_delete(guid);

    let events = state.tick();

    assert!(state.entities.get(guid).is_none());
    assert!(
        events
            .iter()
            .any(|event| matches!(event, WorldEvent::EntityDespawned(target) if *target == guid))
    );
}

#[test]
fn test_stationary_tick_starts_visibility_prune_deadline() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000130);
    let player_pos = WorldPosition {
        landblock_id: Guid(0x0A0AFFFF),
        coords: Vector3::new(0.0, 0.0, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let far_pos = WorldPosition {
        landblock_id: Guid(0x2020FFFF),
        coords: Vector3::new(0.0, 0.0, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    state.server_time = Some(ServerTimeSync {
        server_time: 100.0,
        local_time: Instant::now(),
    });
    state.player.guid = player_guid;
    state.seed_local_player_entity(player_guid, "Player", player_pos);

    let target_guid = Guid(0x60000130);
    state.add_entity(Entity::new(target_guid, "Distant".to_string(), far_pos));

    let events = state.tick();
    let deadline = state
        .entity_lifecycle_state(target_guid)
        .and_then(|lifecycle| lifecycle.prune_deadline)
        .expect("expected a destruction deadline to be assigned");

    assert!(events.is_empty());
    assert!(deadline >= 125.0);
    assert!(state.entities.get(target_guid).is_some());
}

#[test]
fn test_visibility_timeout_sweeps_world_entity_after_25_seconds() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000131);
    let player_pos = WorldPosition {
        landblock_id: Guid(0x0A0AFFFF),
        coords: Vector3::new(0.0, 0.0, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let far_pos = WorldPosition {
        landblock_id: Guid(0x2020FFFF),
        coords: Vector3::new(0.0, 0.0, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    state.server_time = Some(ServerTimeSync {
        server_time: 100.0,
        local_time: Instant::now(),
    });
    state.player.guid = player_guid;
    state.seed_local_player_entity(player_guid, "Player", player_pos);

    let target_guid = Guid(0x60000131);
    state.add_entity(Entity::new(target_guid, "Distant".to_string(), far_pos));

    let _ = state.tick();
    let deadline = state
        .entity_lifecycle_state(target_guid)
        .and_then(|lifecycle| lifecycle.prune_deadline)
        .expect("expected a destruction deadline to be assigned");

    state.server_time = Some(ServerTimeSync {
        server_time: deadline + 1.0,
        local_time: Instant::now(),
    });

    let events = state.tick();

    assert!(state.entities.get(target_guid).is_none());
    assert!(
        events.iter().any(
            |event| matches!(event, WorldEvent::EntityDespawned(guid) if *guid == target_guid)
        )
    );
}

#[test]
fn test_reentry_before_timeout_clears_visibility_prune_deadline() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000132);
    let player_pos = WorldPosition {
        landblock_id: Guid(0x0A0AFFFF),
        coords: Vector3::new(0.0, 0.0, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let far_pos = WorldPosition {
        landblock_id: Guid(0x2020FFFF),
        coords: Vector3::new(0.0, 0.0, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    state.server_time = Some(ServerTimeSync {
        server_time: 100.0,
        local_time: Instant::now(),
    });
    state.player.guid = player_guid;
    state.seed_local_player_entity(player_guid, "Player", player_pos);

    let target_guid = Guid(0x60000132);
    state.add_entity(Entity::new(target_guid, "Traveler".to_string(), far_pos));

    let _ = state.tick();
    assert!(
        state
            .entity_lifecycle_state(target_guid)
            .and_then(|lifecycle| lifecycle.prune_deadline)
            .is_some()
    );

    state.server_time = Some(ServerTimeSync {
        server_time: 110.0,
        local_time: Instant::now(),
    });

    let mut events = Vec::new();
    let _ = state.apply_public_position_update(
        target_guid,
        PositionType::Location,
        player_pos,
        &mut events,
    );
    let tick_events = state.tick();

    assert!(state.entities.get(target_guid).is_some());
    assert!(state.entity_lifecycle_state(target_guid).is_none());
    assert!(
        !tick_events.iter().any(
            |event| matches!(event, WorldEvent::EntityDespawned(guid) if *guid == target_guid)
        )
    );
}

#[test]
fn test_indoor_player_keeps_nearby_outdoor_entity_visible_under_conservative_heuristic() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000132);
    let player_pos = WorldPosition {
        landblock_id: Guid(0x0A0A0100),
        coords: Vector3::new(96.0, 96.0, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let nearby_outdoor_pos = WorldPosition {
        landblock_id: Guid(0x0A0AFFFF),
        coords: Vector3::new(100.0, 100.0, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    state.server_time = Some(ServerTimeSync {
        server_time: 100.0,
        local_time: Instant::now(),
    });
    state.player.guid = player_guid;
    state.seed_local_player_entity(player_guid, "Player", player_pos);

    let target_guid = Guid(0x60000136);
    state.add_entity(Entity::new(
        target_guid,
        "SeenOutside-ish".to_string(),
        nearby_outdoor_pos,
    ));

    let events = state.tick();

    assert!(events.is_empty());
    assert!(state.entities.get(target_guid).is_some());
    assert!(
        state
            .entity_lifecycle_state(target_guid)
            .is_none_or(|lifecycle| lifecycle.prune_deadline.is_none())
    );
}

#[test]
fn test_nearby_entities_omit_explicit_delete_and_null_landblock() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000133);
    let player_pos = WorldPosition {
        landblock_id: Guid(0x0A0AFFFF),
        coords: Vector3::new(0.0, 0.0, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    state.player.guid = player_guid;
    state.seed_local_player_entity(player_guid, "Player", player_pos);

    let visible_guid = Guid(0x60000133);
    state.add_entity(Entity::new(visible_guid, "Visible".to_string(), player_pos));

    let deleted_guid = Guid(0x60000134);
    state.add_entity(Entity::new(deleted_guid, "Deleted".to_string(), player_pos));
    state.mark_entity_explicit_delete(deleted_guid);

    let null_guid = Guid(0x60000135);
    let mut null_entity = Entity::new(null_guid, "NullLandblock".to_string(), player_pos);
    null_entity.position.landblock_id = Guid::NULL;
    state.add_entity(null_entity);

    let nearby: std::collections::HashSet<_> = state
        .get_nearby_world_entities()
        .into_iter()
        .map(|entity| entity.guid)
        .collect();

    assert!(nearby.contains(&visible_guid));
    assert!(!nearby.contains(&deleted_guid));
    assert!(!nearby.contains(&null_guid));
}

#[test]
fn test_add_to_trade_marks_preview_only_for_non_authoritative_entities() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000140);
    let preview_guid = Guid(0x60000140);
    let owned_guid = Guid(0x60000141);

    state.player.guid = player_guid;
    state.register_trade(player_guid, Guid(0x5000BEEF), &mut Vec::new());

    let mut preview_entity = Entity::new(
        preview_guid,
        "Preview".to_string(),
        WorldPosition::default(),
    );
    preview_entity.position.landblock_id = Guid::NULL;
    state.entities.insert(preview_entity);

    state.entities.insert(Entity::new(
        owned_guid,
        "Owned".to_string(),
        WorldPosition::default(),
    ));
    state.player.add_to_inventory(owned_guid);

    state.add_trade_item(0x02, preview_guid, &mut Vec::new());
    state.add_trade_item(0x01, owned_guid, &mut Vec::new());

    assert!(
        state
            .entity_lifecycle_state(preview_guid)
            .is_some_and(|state| state.trade_preview)
    );
    assert!(
        !state
            .entity_lifecycle_state(owned_guid)
            .is_some_and(|state| state.trade_preview)
    );
}

#[test]
fn test_reset_trade_sweeps_preview_only_entities() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000141);
    let preview_guid = Guid(0x60000142);

    state.server_time = Some(ServerTimeSync {
        server_time: 100.0,
        local_time: Instant::now(),
    });

    state.player.guid = player_guid;
    state.register_trade(player_guid, Guid(0x5000BEEF), &mut Vec::new());

    let mut preview_entity = Entity::new(
        preview_guid,
        "Preview".to_string(),
        WorldPosition::default(),
    );
    preview_entity.position.landblock_id = Guid::NULL;
    state.entities.insert(preview_entity);
    state.mark_trade_preview(preview_guid);

    if let Some(trade) = state.trade.as_mut() {
        trade.partner_side.items.push(preview_guid);
    }

    let mut events = Vec::new();
    state.reset_trade(&mut events);

    let deadline = state
        .entity_lifecycle_state(preview_guid)
        .and_then(|state| state.prune_deadline)
        .expect("expected immediate prune eligibility after trade reset");

    assert!(state.entities.get(preview_guid).is_some());
    assert!(
        !events.iter().any(
            |event| matches!(event, WorldEvent::EntityDespawned(guid) if *guid == preview_guid)
        )
    );
    assert!(
        state
            .trade
            .as_ref()
            .is_some_and(|trade| trade.partner_side.items.is_empty())
    );

    state.server_time = Some(ServerTimeSync {
        server_time: deadline + 1.0,
        local_time: Instant::now(),
    });

    let tick_events = state.tick();
    assert!(state.entities.get(preview_guid).is_none());
    assert!(
        tick_events.iter().any(
            |event| matches!(event, WorldEvent::EntityDespawned(guid) if *guid == preview_guid)
        )
    );
}

#[test]
fn test_clear_trade_acceptance_does_not_sweep_preview_entities() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000142);
    let preview_guid = Guid(0x60000143);

    state.player.guid = player_guid;
    state.register_trade(player_guid, Guid(0x5000BEEF), &mut Vec::new());

    let mut preview_entity = Entity::new(
        preview_guid,
        "Preview".to_string(),
        WorldPosition::default(),
    );
    preview_entity.position.landblock_id = Guid::NULL;
    state.entities.insert(preview_entity);
    state.mark_trade_preview(preview_guid);

    if let Some(trade) = state.trade.as_mut() {
        trade.self_side.items.push(preview_guid);
        trade.self_side.accepted = true;
        trade.partner_side.accepted = true;
    }

    let mut events = Vec::new();
    state.clear_trade_acceptance(&mut events);

    assert!(state.entities.get(preview_guid).is_some());
    assert!(
        state
            .entity_lifecycle_state(preview_guid)
            .is_some_and(|state| state.trade_preview)
    );
    assert!(
        state
            .trade
            .as_ref()
            .is_some_and(|trade| trade.self_side.items == vec![preview_guid])
    );
    assert!(
        events
            .iter()
            .any(|event| matches!(event, WorldEvent::TradeStateUpdated(Some(_))))
    );
}

#[test]
fn test_close_trade_sweeps_preview_only_entities() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000152);
    let preview_guid = Guid(0x60000152);

    state.server_time = Some(ServerTimeSync {
        server_time: 100.0,
        local_time: Instant::now(),
    });

    state.player.guid = player_guid;
    state.register_trade(player_guid, Guid(0x5000BEEF), &mut Vec::new());

    let mut preview_entity = Entity::new(
        preview_guid,
        "Preview".to_string(),
        WorldPosition::default(),
    );
    preview_entity.position.landblock_id = Guid::NULL;
    state.entities.insert(preview_entity);
    state.mark_trade_preview(preview_guid);

    if let Some(trade) = state.trade.as_mut() {
        trade.partner_side.items.push(preview_guid);
    }

    let mut events = Vec::new();
    state.close_trade(&mut events);

    let deadline = state
        .entity_lifecycle_state(preview_guid)
        .and_then(|state| state.prune_deadline)
        .expect("expected preview-only trade entity to become sweep-eligible");

    assert!(state.trade.is_none());
    assert!(state.entities.get(preview_guid).is_some());
    assert!(
        events
            .iter()
            .any(|event| matches!(event, WorldEvent::TradeStateUpdated(None)))
    );
    assert!(
        !events.iter().any(
            |event| matches!(event, WorldEvent::EntityDespawned(guid) if *guid == preview_guid)
        )
    );

    state.server_time = Some(ServerTimeSync {
        server_time: deadline + 1.0,
        local_time: Instant::now(),
    });

    let tick_events = state.tick();
    assert!(state.entities.get(preview_guid).is_none());
    assert!(
        tick_events.iter().any(
            |event| matches!(event, WorldEvent::EntityDespawned(guid) if *guid == preview_guid)
        )
    );
}

#[test]
fn test_trade_complete_preserves_real_owned_entity_while_pruning_preview_only_entity() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000143);
    let preview_guid = Guid(0x60000144);
    let owned_guid = Guid(0x60000145);

    state.server_time = Some(ServerTimeSync {
        server_time: 100.0,
        local_time: Instant::now(),
    });

    state.player.guid = player_guid;
    state.register_trade(player_guid, Guid(0x5000BEEF), &mut Vec::new());

    let mut preview_entity = Entity::new(
        preview_guid,
        "Preview".to_string(),
        WorldPosition::default(),
    );
    preview_entity.position.landblock_id = Guid::NULL;
    state.entities.insert(preview_entity);
    state.mark_trade_preview(preview_guid);

    let mut owned_entity = Entity::new(owned_guid, "Owned".to_string(), WorldPosition::default());
    owned_entity.position.landblock_id = Guid::NULL;
    state.entities.insert(owned_entity);
    state.mark_trade_preview(owned_guid);
    state.player.add_to_inventory(owned_guid);

    if let Some(trade) = state.trade.as_mut() {
        trade.self_side.items.push(owned_guid);
        trade.partner_side.items.push(preview_guid);
        trade.self_side.accepted = true;
        trade.partner_side.accepted = true;
    }

    let mut events = Vec::new();
    state.handle_trade_complete(&mut events);

    let deadline = state
        .entity_lifecycle_state(preview_guid)
        .and_then(|state| state.prune_deadline)
        .expect("expected preview-only trade entity to become sweep-eligible");

    assert!(state.entities.get(preview_guid).is_some());
    assert!(state.entities.get(owned_guid).is_some());
    assert!(
        !state
            .entity_lifecycle_state(owned_guid)
            .is_some_and(|state| state.trade_preview)
    );
    assert!(
        !events.iter().any(
            |event| matches!(event, WorldEvent::EntityDespawned(guid) if *guid == preview_guid)
        )
    );

    state.server_time = Some(ServerTimeSync {
        server_time: deadline + 1.0,
        local_time: Instant::now(),
    });

    let tick_events = state.tick();
    assert!(state.entities.get(preview_guid).is_none());
    assert!(
        tick_events.iter().any(
            |event| matches!(event, WorldEvent::EntityDespawned(guid) if *guid == preview_guid)
        )
    );
}

#[test]
fn test_view_contents_ignores_unknown_guid_without_synthesizing_entity() {
    let mut state = WorldState::synthetic();
    let container_guid = Guid(0x70000150);
    let item_guid = Guid(0x60000150);

    let msg = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: Guid::NULL,
        sequence: 0,
        event: GameEvent::ViewContents(Box::new(ViewContentsEventData {
            container: container_guid,
            items: vec![ViewContentsEventItem {
                guid: item_guid,
                container_type: 0,
            }],
        })),
    }));

    let events = state.handle_message(&msg);

    assert!(state.open_containers.contains(&container_guid));
    assert!(state.entities.get(item_guid).is_none());
    assert!(state.entity_lifecycle_state(item_guid).is_none());
    assert!(events.iter().any(
        |event| matches!(event, WorldEvent::ContainerOpened(guid) if *guid == container_guid)
    ));
    assert!(!events.iter().any(
        |event| matches!(event, WorldEvent::EntitySpawned(entity) if entity.guid == item_guid)
    ));
}

#[test]
fn test_view_contents_marks_existing_entity_as_container_preview() {
    let mut state = WorldState::synthetic();
    let container_guid = Guid(0x70000157);
    let item_guid = Guid(0x60000157);

    state.entities.insert(Entity::new(
        item_guid,
        "Known Item".to_string(),
        WorldPosition::default(),
    ));

    let msg = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: Guid::NULL,
        sequence: 0,
        event: GameEvent::ViewContents(Box::new(ViewContentsEventData {
            container: container_guid,
            items: vec![ViewContentsEventItem {
                guid: item_guid,
                container_type: 0,
            }],
        })),
    }));

    let events = state.handle_message(&msg);

    assert!(state.open_containers.contains(&container_guid));
    assert_eq!(
        state
            .entities
            .get(item_guid)
            .and_then(|entity| entity.container_id()),
        Some(container_guid)
    );
    assert!(
        state
            .entity_lifecycle_state(item_guid)
            .is_some_and(|state| state.container_preview)
    );
    assert!(events.iter().any(
        |event| matches!(event, WorldEvent::ContainerOpened(guid) if *guid == container_guid)
    ));
}

#[test]
fn test_close_ground_container_marks_preview_only_entity_for_deferred_prune() {
    let mut state = WorldState::synthetic();
    let container_guid = Guid(0x70000151);
    let item_guid = Guid(0x60000151);

    state.server_time = Some(ServerTimeSync {
        server_time: 100.0,
        local_time: Instant::now(),
    });
    state.open_containers.insert(container_guid);

    let mut entity = Entity::new(
        item_guid,
        "PreviewItem".to_string(),
        WorldPosition::default(),
    );
    entity.set_container_id(Some(container_guid));
    entity.position.landblock_id = Guid::NULL;
    state.entities.insert(entity);
    state.mark_container_preview(item_guid);

    let msg = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: Guid::NULL,
        sequence: 0,
        event: GameEvent::CloseGroundContainer(Box::new(CloseGroundContainerEventData {
            container_guid,
        })),
    }));

    let events = state.handle_message(&msg);
    let deadline = state
        .entity_lifecycle_state(item_guid)
        .and_then(|state| state.prune_deadline)
        .expect("expected preview-only container entity to become sweep-eligible");

    assert!(!state.open_containers.contains(&container_guid));
    assert!(state.entities.get(item_guid).is_some());
    assert_eq!(
        state
            .entities
            .get(item_guid)
            .and_then(|entity| entity.container_id()),
        None
    );
    assert!(
        state
            .entity_lifecycle_state(item_guid)
            .is_some_and(|state| state.prune_deadline.is_some())
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, WorldEvent::EntityDespawned(guid) if *guid == item_guid))
    );

    state.server_time = Some(ServerTimeSync {
        server_time: deadline + 1.0,
        local_time: Instant::now(),
    });

    let tick_events = state.tick();
    assert!(state.entities.get(item_guid).is_none());
    assert!(
        tick_events
            .iter()
            .any(|event| matches!(event, WorldEvent::EntityDespawned(guid) if *guid == item_guid))
    );
}

#[test]
fn test_reopening_container_does_not_reactivate_stale_preview_contents() {
    let mut state = WorldState::synthetic();
    let container_guid = Guid(0x70000158);
    let old_item_guid = Guid(0x60000159);
    let new_item_guid = Guid(0x6000015A);

    state.server_time = Some(ServerTimeSync {
        server_time: 100.0,
        local_time: Instant::now(),
    });
    state.open_containers.insert(container_guid);

    let mut old_item = Entity::new(
        old_item_guid,
        "Old Preview Item".to_string(),
        WorldPosition::default(),
    );
    old_item.position.landblock_id = Guid::NULL;
    old_item.set_container_id(Some(container_guid));
    state.entities.insert(old_item);
    state.mark_container_preview(old_item_guid);

    let close_msg = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: Guid::NULL,
        sequence: 0,
        event: GameEvent::CloseGroundContainer(Box::new(CloseGroundContainerEventData {
            container_guid,
        })),
    }));

    let _ = state.handle_message(&close_msg);

    assert_eq!(
        state
            .entities
            .get(old_item_guid)
            .and_then(|entity| entity.container_id()),
        None
    );

    state.entities.insert(Entity::new(
        new_item_guid,
        "New Preview Item".to_string(),
        WorldPosition::default(),
    ));

    let reopen_msg = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: Guid::NULL,
        sequence: 0,
        event: GameEvent::ViewContents(Box::new(ViewContentsEventData {
            container: container_guid,
            items: vec![ViewContentsEventItem {
                guid: new_item_guid,
                container_type: 0,
            }],
        })),
    }));

    let _ = state.handle_message(&reopen_msg);

    assert_eq!(
        state
            .entities
            .get(old_item_guid)
            .and_then(|entity| entity.container_id()),
        None
    );
    assert!(
        !state
            .entity_lifecycle_state(old_item_guid)
            .is_some_and(|state| state.container_preview)
    );
    assert_eq!(
        state
            .entities
            .get(new_item_guid)
            .and_then(|entity| entity.container_id()),
        Some(container_guid)
    );
    assert!(
        state
            .entity_lifecycle_state(new_item_guid)
            .is_some_and(|state| state.container_preview)
    );
}

#[test]
fn test_late_container_item_arrival_is_marked_preview_and_pruned_on_close() {
    let mut state = WorldState::synthetic();
    let container_guid = Guid(0x7000015B);
    let item_guid = Guid(0x6000015B);

    state.server_time = Some(ServerTimeSync {
        server_time: 100.0,
        local_time: Instant::now(),
    });
    state.open_containers.insert(container_guid);

    state.entities.insert(Entity::new(
        item_guid,
        "Late Chest Item".to_string(),
        WorldPosition::default(),
    ));

    let update_msg =
        GameMessage::PublicUpdatePropertyInstanceId(Box::new(UpdatePropertyInstanceId {
            sequence: 0,
            guid: item_guid,
            property: PropertyInstanceId::Container as u32,
            value: container_guid,
        }));

    let _ = state.handle_message(&update_msg);

    assert!(
        state
            .entity_lifecycle_state(item_guid)
            .is_some_and(|state| state.container_preview)
    );

    let close_msg = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: Guid::NULL,
        sequence: 0,
        event: GameEvent::CloseGroundContainer(Box::new(CloseGroundContainerEventData {
            container_guid,
        })),
    }));

    let _ = state.handle_message(&close_msg);

    assert_eq!(
        state
            .entities
            .get(item_guid)
            .and_then(|entity| entity.container_id()),
        None
    );
    assert!(
        state
            .entity_lifecycle_state(item_guid)
            .and_then(|state| state.prune_deadline)
            .is_some()
    );
}

#[test]
fn test_closed_container_update_preserves_preview_provenance_and_prune_deadline() {
    let mut state = WorldState::synthetic();
    let container_guid = Guid(0x7000015C);
    let item_guid = Guid(0x6000015C);

    state.server_time = Some(ServerTimeSync {
        server_time: 100.0,
        local_time: Instant::now(),
    });

    let mut item = Entity::new(
        item_guid,
        "Late Closed Chest Item".to_string(),
        WorldPosition::default(),
    );
    item.position.landblock_id = Guid::NULL;
    item.set_container_id(Some(container_guid));
    state.entities.insert(item);
    state.mark_container_preview(item_guid);
    state.set_entity_prune_deadline(item_guid, 125.0);

    let update_msg =
        GameMessage::PublicUpdatePropertyInstanceId(Box::new(UpdatePropertyInstanceId {
            sequence: 0,
            guid: item_guid,
            property: PropertyInstanceId::Container as u32,
            value: container_guid,
        }));

    let _ = state.handle_message(&update_msg);

    assert!(
        state
            .entity_lifecycle_state(item_guid)
            .is_some_and(|state| state.container_preview)
    );
    assert!(
        state
            .entity_lifecycle_state(item_guid)
            .and_then(|state| state.prune_deadline)
            .is_some()
    );
}

#[test]
fn test_close_ground_container_preserves_entity_with_other_retention() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000153);
    let container_guid = Guid(0x70000153);
    let item_guid = Guid(0x60000153);

    state.player.guid = player_guid;
    state.open_containers.insert(container_guid);

    let mut entity = Entity::new(
        item_guid,
        "RetainedItem".to_string(),
        WorldPosition::default(),
    );
    entity.set_container_id(Some(container_guid));
    entity.position.landblock_id = Guid::NULL;
    state.entities.insert(entity);
    state.mark_container_preview(item_guid);
    state.player.add_to_inventory(item_guid);

    let msg = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: Guid::NULL,
        sequence: 0,
        event: GameEvent::CloseGroundContainer(Box::new(CloseGroundContainerEventData {
            container_guid,
        })),
    }));

    let events = state.handle_message(&msg);

    assert!(state.entities.get(item_guid).is_some());
    assert!(state.entity_lifecycle_state(item_guid).is_none());
    assert!(state.player.inventory.contains(&item_guid));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, WorldEvent::EntityDespawned(guid) if *guid == item_guid))
    );
}

#[test]
fn test_tick_does_not_prune_off_world_entities_with_inventory_equipment_or_open_container_retention()
 {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000154);
    let player_pos = WorldPosition {
        landblock_id: Guid(0x0A0AFFFF),
        coords: Vector3::new(0.0, 0.0, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let inventory_guid = Guid(0x60000154);
    let equipped_guid = Guid(0x60000155);
    let container_guid = Guid(0x70000154);
    let preview_guid = Guid(0x60000156);

    state.server_time = Some(ServerTimeSync {
        server_time: 100.0,
        local_time: Instant::now(),
    });
    state.player.guid = player_guid;
    state.seed_local_player_entity(player_guid, "Player", player_pos);

    let mut inventory_entity = Entity::new(
        inventory_guid,
        "InventoryItem".to_string(),
        WorldPosition::default(),
    );
    inventory_entity.position.landblock_id = Guid::NULL;
    inventory_entity.set_container_id(Some(player_guid));
    state.add_entity(inventory_entity);
    state.player.add_to_inventory(inventory_guid);

    let mut equipped_entity = Entity::new(
        equipped_guid,
        "EquippedItem".to_string(),
        WorldPosition::default(),
    );
    equipped_entity.position.landblock_id = Guid::NULL;
    equipped_entity.set_wielder_id(Some(player_guid));
    state.add_entity(equipped_entity);
    state
        .player
        .wield_item(equipped_guid, EquipMask::MELEE_WEAPON);

    let mut preview_entity = Entity::new(
        preview_guid,
        "PreviewItem".to_string(),
        WorldPosition::default(),
    );
    preview_entity.position.landblock_id = Guid::NULL;
    preview_entity.set_container_id(Some(container_guid));
    state.add_entity(preview_entity);
    state.open_containers.insert(container_guid);
    state.mark_container_preview(preview_guid);

    let events = state.tick();

    assert!(events.is_empty());
    assert!(state.entities.get(inventory_guid).is_some());
    assert!(state.entities.get(equipped_guid).is_some());
    assert!(state.entities.get(preview_guid).is_some());
    assert!(
        state
            .entity_lifecycle_state(inventory_guid)
            .is_none_or(|state| state.prune_deadline.is_none())
    );
    assert!(
        state
            .entity_lifecycle_state(equipped_guid)
            .is_none_or(|state| state.prune_deadline.is_none())
    );
    assert!(
        state
            .entity_lifecycle_state(preview_guid)
            .is_some_and(|state| state.prune_deadline.is_none() && state.container_preview)
    );
}

#[test]
fn test_book_data_response_updates_entity_book_state() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x11223344);
    state.entities.insert(Entity::new(
        guid,
        "Book".to_string(),
        WorldPosition::default(),
    ));

    let message = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: Guid(0x50000001),
        sequence: 0x21,
        event: GameEvent::BookDataResponse(Box::new(BookDataResponseEventData {
            object_guid: guid,
            max_num_pages: 3,
            num_pages: 3,
            max_num_chars_per_page: 1000,
            pages: vec![BookPageData {
                author_id: 0x01020304,
                author_name: "Scribe One".to_string(),
                author_account: "beer good".to_string(),
                flags: 0xFFFF0002,
                text_included: false,
                ignore_author: true,
                page_text: None,
            }],
            inscription: "Signed and sealed".to_string(),
            author_id: 0xAABBCCDD,
            author_name: "Archivist".to_string(),
        })),
    }));

    let events = state.handle_message(&message);

    assert!(matches!(
        events.first(),
        Some(WorldEvent::EntityBookUpdated {
            guid: event_guid,
            book,
        }) if *event_guid == guid && book.inscription.as_deref() == Some("Signed and sealed")
    ));

    let entity = state.entities.get(guid).expect("entity should still exist");
    let book = entity.book.as_ref().expect("book data should be populated");
    assert_eq!(book.max_num_pages, Some(3));
    assert_eq!(book.pages.len(), 1);
    assert_eq!(book.pages[0].author_name, "Scribe One");
    assert_eq!(book.inscription.as_deref(), Some("Signed and sealed"));
}

#[test]
fn test_book_page_data_response_merges_into_existing_book_state() {
    let mut state = WorldState::synthetic();
    let guid = Guid(0x11223344);
    let mut entity = Entity::new(guid, "Book".to_string(), WorldPosition::default());
    entity.book = Some(crate::book::BookData {
        pages: vec![crate::book::BookPage {
            index: 0,
            author_id: 1,
            author_name: "Page Zero".to_string(),
            author_account: "old".to_string(),
            flags: 0xFFFF0002,
            text_included: false,
            ignore_author: false,
            page_text: None,
        }],
        ..crate::book::BookData::default()
    });
    state.entities.insert(entity);

    let message = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: Guid(0x50000001),
        sequence: 0x22,
        event: GameEvent::BookPageDataResponse(Box::new(BookPageDataResponseEventData {
            object_guid: guid,
            page_index: 1,
            page: BookPageData {
                author_id: 0x05060708,
                author_name: "Scribe Two".to_string(),
                author_account: "Password is cheese".to_string(),
                flags: 0xFFFF0002,
                text_included: true,
                ignore_author: false,
                page_text: Some("The second page has text.".to_string()),
            },
        })),
    }));

    let events = state.handle_message(&message);

    assert!(matches!(
        events.first(),
        Some(WorldEvent::EntityBookUpdated {
            guid: event_guid,
            book,
        }) if *event_guid == guid && book.pages.len() == 2
    ));

    let entity = state.entities.get(guid).expect("entity should still exist");
    let book = entity.book.as_ref().expect("book data should be populated");
    assert_eq!(book.pages.len(), 2);
    assert_eq!(book.pages[1].index, 1);
    assert_eq!(
        book.pages[1].page_text.as_deref(),
        Some("The second page has text.")
    );
}

#[test]
fn test_remove_entity_marks_wielded_dependents_for_prune() {
    let mut state = WorldState::synthetic();
    let wielder_guid = Guid(0x60000157);
    let item_guid = Guid(0x60000158);

    state.server_time = Some(ServerTimeSync {
        server_time: 100.0,
        local_time: Instant::now(),
    });

    state.add_entity(Entity::new(
        wielder_guid,
        "Wielder".to_string(),
        WorldPosition::default(),
    ));

    let mut item = Entity::new(
        item_guid,
        "Wielded Item".to_string(),
        WorldPosition {
            landblock_id: Guid(0x0404_FFFF),
            ..WorldPosition::default()
        },
    );
    item.set_wielder_id(Some(wielder_guid));
    item.set_int_prop(
        PropertyInt::CurrentWieldedLocation,
        EquipMask::MELEE_WEAPON.bits() as i32,
    );
    state.add_entity(item);

    let removed = state.remove_entity(wielder_guid);

    assert!(removed.is_some());
    assert_eq!(state.entities.get(item_guid).unwrap().wielder_id(), None);
    assert_eq!(
        state.entities.get(item_guid).unwrap().position.landblock_id,
        Guid::NULL
    );
    assert!(
        state
            .entity_lifecycle_state(item_guid)
            .and_then(|state| state.prune_deadline)
            .is_some()
    );

    let events = state.tick();

    assert!(state.entities.get(item_guid).is_none());
    assert!(
        events
            .iter()
            .any(|event| matches!(event, WorldEvent::EntityDespawned(guid) if *guid == item_guid))
    );
}

#[test]
fn test_orphaned_wielded_item_is_not_retained() {
    let mut state = WorldState::synthetic();
    let item_guid = Guid(0x6000015B);

    state.server_time = Some(ServerTimeSync {
        server_time: 100.0,
        local_time: Instant::now(),
    });

    let mut item = Entity::new(
        item_guid,
        "Orphaned Wielded Item".to_string(),
        WorldPosition::default(),
    );
    item.position.landblock_id = Guid::NULL;
    item.set_wielder_id(Some(Guid(0xDEAD_BEEF)));
    item.set_int_prop(
        PropertyInt::CurrentWieldedLocation,
        EquipMask::MELEE_WEAPON.bits() as i32,
    );
    state.add_entity(item);

    assert!(state.mark_entity_immediately_eligible_for_pruning_if_unretained(item_guid));
    assert!(
        state
            .entity_lifecycle_state(item_guid)
            .and_then(|state| state.prune_deadline)
            .is_some()
    );
}

#[test]
fn test_remove_entity_marks_contained_dependents_for_prune() {
    let mut state = WorldState::synthetic();
    let container_guid = Guid(0x60000159);
    let item_guid = Guid(0x6000015A);

    state.server_time = Some(ServerTimeSync {
        server_time: 100.0,
        local_time: Instant::now(),
    });

    state.add_entity(Entity::new(
        container_guid,
        "Container".to_string(),
        WorldPosition::default(),
    ));

    let mut item = Entity::new(
        item_guid,
        "Contained Item".to_string(),
        WorldPosition::default(),
    );
    item.position.landblock_id = Guid::NULL;
    item.set_container_id(Some(container_guid));
    state.add_entity(item);

    let removed = state.remove_entity(container_guid);

    assert!(removed.is_some());
    assert_eq!(state.entities.get(item_guid).unwrap().container_id(), None);
    assert!(
        state
            .entity_lifecycle_state(item_guid)
            .and_then(|state| state.prune_deadline)
            .is_some()
    );

    let events = state.tick();

    assert!(state.entities.get(item_guid).is_none());
    assert!(
        events
            .iter()
            .any(|event| matches!(event, WorldEvent::EntityDespawned(guid) if *guid == item_guid))
    );
}

/// F4-2 (bughunt 2026-06-09) — terrain surface normal feeds the outdoor
/// walkable-slope gate. Flat terrain is walkable (normal ≈ +Z); a face
/// steeper than retail's FloorZ (~48.4°) classifies as non-walkable
/// (normal.z < FLOOR_Z); a gentle slope stays walkable. The cutoff is the
/// same constant the gate consults, so this pins the boundary the integrator
/// blocks the climb at.
#[test]
fn terrain_normal_at_classifies_walkable_vs_cliff() {
    let mut state = WorldState::synthetic();
    let lb_id = 0u32; // lb_x=0, lb_y=0 → world coords [0,192) map here.

    // Flat plane at z=5 → upward normal, fully walkable.
    state.populate_terrain_heights(lb_id, [5.0; 81]);
    let flat = state
        .terrain_normal_at(12.0, 12.0)
        .expect("flat terrain normal");
    assert!(
        flat.z > 0.999,
        "flat terrain normal must be ≈ +Z, got z={:.4}",
        flat.z
    );
    assert!(flat.z >= crate::spatial::FLOOR_Z, "flat terrain is walkable");

    // Steep +X face: 42 m rise per 24 m cell ≈ 60° → non-walkable.
    let mut steep = [0.0f32; 81];
    for vx in 0..9 {
        for vy in 0..9 {
            steep[vx * 9 + vy] = vx as f32 * 42.0; // idx = vx*9 + vy
        }
    }
    state.populate_terrain_heights(lb_id, steep);
    let cliff = state
        .terrain_normal_at(12.0, 12.0)
        .expect("steep terrain normal");
    assert!(
        cliff.z < crate::spatial::FLOOR_Z,
        "a ~60° face must be non-walkable (normal.z < FLOOR_Z {:.4}), got z={:.4}",
        crate::spatial::FLOOR_Z,
        cliff.z
    );

    // Gentle +X slope: 8.7 m rise per cell ≈ 20° → still walkable.
    let mut gentle = [0.0f32; 81];
    for vx in 0..9 {
        for vy in 0..9 {
            gentle[vx * 9 + vy] = vx as f32 * 8.7;
        }
    }
    state.populate_terrain_heights(lb_id, gentle);
    let ramp = state
        .terrain_normal_at(12.0, 12.0)
        .expect("gentle terrain normal");
    assert!(
        ramp.z >= crate::spatial::FLOOR_Z,
        "a ~20° ramp must stay walkable (normal.z >= FLOOR_Z), got z={:.4}",
        ramp.z
    );

    // Unknown landblock → None (caller preserves behaviour).
    assert!(
        state.terrain_normal_at(50_000.0, 50_000.0).is_none(),
        "uncached landblock yields None"
    );
}

/// F4-4 (bughunt 2026-06-09) — EntirelyWater cell detection for the deep-water
/// walk-block. A cell is fully-water iff all four corner vertices are water
/// terrain (codes 16-20/22/23); partial-water and land cells don't block, and
/// an uncached landblock never blocks.
#[test]
fn is_entirely_water_cell_at_detects_full_water_cells() {
    let mut state = WorldState::synthetic();
    let lb = 0u32; // lb (0,0) → world coords [0,192)

    // Uncached landblock → never blocks (fail-soft on missing data).
    assert!(!state.is_entirely_water_cell_at(12.0, 12.0));

    // Whole LB water (code 19 = WaterShallowStillSea) → every cell blocks.
    state.populate_terrain_water(lb, &[19u8; 81]);
    assert!(
        state.is_entirely_water_cell_at(12.0, 12.0),
        "all-water cell must block"
    );
    assert!(
        state.is_entirely_water_cell_at(108.0, 108.0),
        "interior all-water cell must block"
    );

    // All land (code 0) → never blocks.
    state.populate_terrain_water(lb, &[0u8; 81]);
    assert!(
        !state.is_entirely_water_cell_at(12.0, 12.0),
        "land cell must not block"
    );

    // Partially-water cell (0,0): three water corners + one land → no block
    // (wading-depth handling is a documented follow-on, not a hard wall).
    let mut codes = [19u8; 81];
    codes[0 * 9 + 0] = 0; // corner vertex (vx0,vy0) of cell (0,0) is land
    state.populate_terrain_water(lb, &codes);
    assert!(
        !state.is_entirely_water_cell_at(12.0, 12.0),
        "partially-water cell must not block"
    );

    // Wrong-length codes are ignored (no-op): the prior grid stands.
    state.populate_terrain_water(lb, &[19u8; 10]);
    assert!(
        !state.is_entirely_water_cell_at(12.0, 12.0),
        "short codes are a no-op — grid unchanged"
    );
}

/// G-8 / F4-4 follow-on (2026-06-11) — wading water depth, mirroring ACE
/// `get_water_depth` + `calc_water_depth`: NotWater 0.0, EntirelyWater 0.9,
/// PartiallyWater keyed off the NEAREST cell vertex (12 m rounding) —
/// water vertex 0.45, land vertex 0.1. Uncached landblock → 0.0.
#[test]
fn water_depth_at_mirrors_ace_depth_classes() {
    let mut state = WorldState::synthetic();
    let lb = 0u32; // lb (0,0) → world coords [0,192)

    // Uncached landblock → 0.0 (fail-soft).
    assert_eq!(state.water_depth_at(12.0, 12.0), 0.0);

    // All land → 0.0 everywhere.
    state.populate_terrain_water(lb, &[0u8; 81]);
    assert_eq!(state.water_depth_at(12.0, 12.0), 0.0);

    // Whole LB water → EntirelyWater 0.9.
    state.populate_terrain_water(lb, &[19u8; 81]);
    assert!((state.water_depth_at(12.0, 12.0) - 0.9).abs() < 1e-6);

    // Synthetic SHORELINE: only the column-0 vertices (x index 0) are
    // water → cell (0,0) has exactly 2 water corners (vertices (0,0) and
    // (0,1)) = PartiallyWater; cell (1,0) is all-land.
    let mut codes = [0u8; 81];
    for vy in 0..9 {
        codes[vy] = 19; // vertex (0, vy) — water along the x=0 edge
    }
    state.populate_terrain_water(lb, &codes);
    assert!(
        !state.is_entirely_water_cell_at(12.0, 12.0),
        "shoreline cell must not hard-block"
    );
    // Near the waterline (x < 12 → nearest vertex column 0 = water): wade
    // at ACE's 0.45.
    assert!(
        (state.water_depth_at(5.0, 5.0) - 0.45).abs() < 1e-6,
        "near-water-vertex shoreline point must wade at 0.45, got {}",
        state.water_depth_at(5.0, 5.0)
    );
    // Same cell, nearer the dry edge (x >= 12 → nearest vertex column 1 =
    // land): ACE's residual 0.1.
    assert!(
        (state.water_depth_at(18.0, 5.0) - 0.1).abs() < 1e-6,
        "near-land-vertex shoreline point must wade at 0.1, got {}",
        state.water_depth_at(18.0, 5.0)
    );
    // Fully-dry neighbour cell (x in [24,48)) → 0.0.
    assert_eq!(state.water_depth_at(30.0, 5.0), 0.0);
}

// ---------------------------------------------------------------------------
// WP-2 (last-known-good cell + no-retire-on-transient-NULL). Combines
// B3-WI1 + B4-item1 (§D3): a transient NULL-landblock pose for the LOCAL
// player — a null `posA` that arrives before the real arrival `posB` and is
// never reconciled — must NOT retire the runtime body (dropping the rig and
// stranding `objCellId` at 0). Instead the body is HELD Suspended at the
// last-known-good cell, `runtime_pose_for_guid` reports that source cell, and
// the liveness watchdog can recreate it via a `Reset` when `posB` finally
// lands. A genuine world-exit (a REMOTE entity leaving the scene) still
// retires.
// ---------------------------------------------------------------------------

/// Primary WP-2 scenario: null `posA` (retire-suppressed) + `posB` never
/// arrives. The body is never removed between `posA`/`posB`,
/// `local_player_runtime_pose()` returns the SOURCE cell (never `None`/0), and
/// a follow-up watchdog `Reset` re-establishes the pose.
#[test]
fn wp2_null_posa_holds_body_at_source_cell_until_posb() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_02A0);
    let source_cell = Guid(0x8602_01AD);
    let source_pos = WorldPosition {
        landblock_id: source_cell,
        coords: Vector3::new(12.8, -26.7, 0.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    // Establish the local player at a valid source cell: seed the entity,
    // register the runtime body, then apply a non-null authoritative pose
    // (which stamps `last_valid_landblock`).
    state.seed_local_player_entity(player_guid, "Player", source_pos);
    let _ = state.set_local_player_runtime_pose(source_pos);
    let _ = state.set_player_position(source_pos);

    assert_eq!(
        state.player.last_valid_landblock,
        Some(source_cell),
        "precondition: a non-null apply stamps the last-known-good cell"
    );
    assert!(
        state
            .scene
            .body(SpatialBodyId::LocalPlayer(player_guid))
            .is_some(),
        "precondition: runtime body registered at the source cell"
    );

    // posA: a transient NULL-landblock pose (the null the arrival never
    // reconciles). Pre-fix this retires the body; WP-2 holds it Suspended.
    let null_pos = WorldPosition {
        landblock_id: Guid::NULL,
        coords: source_pos.coords,
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    let _ = state.set_player_position(null_pos);

    let body = state
        .scene
        .body(SpatialBodyId::LocalPlayer(player_guid))
        .expect("WP-2: the body must NOT be retired on a transient null posA");
    assert_eq!(
        body.pose.landblock_id, source_cell,
        "the held body keeps the last-known-good source cell"
    );
    assert_eq!(
        body.sampling.mode,
        SpatialSampleMode::Suspended,
        "the held body is Suspended (not driven, not removed)"
    );

    // The read chokepoint reports the source cell — never None, never 0.
    let runtime = state
        .local_player_runtime_pose()
        .expect("WP-2: runtime pose must be Some (body held, not retired)");
    assert_eq!(
        runtime.landblock_id, source_cell,
        "local_player_runtime_pose (→ objCellId) reports the source cell, not 0"
    );
    assert_ne!(runtime.landblock_id, Guid::NULL);
    assert_eq!(
        state.player.last_valid_landblock,
        Some(source_cell),
        "the last-known-good cell is retained across the transient null"
    );

    // Watchdog recovery: a `Reset` (the liveness watchdog's re-placement)
    // re-establishes the pose at the source cell.
    let _ =
        state.set_player_position_with_sync(source_pos, crate::AuthoritativeBodySync::Reset);
    let body = state
        .scene
        .body(SpatialBodyId::LocalPlayer(player_guid))
        .expect("body present after the watchdog Reset");
    assert_eq!(
        body.pose.landblock_id, source_cell,
        "watchdog Reset re-establishes the source cell"
    );
    assert_eq!(
        state
            .local_player_runtime_pose()
            .expect("runtime pose after Reset")
            .landblock_id,
        source_cell,
    );
}

/// WP-2 body-ABSENT arm: if the runtime body was retired and only a
/// NULL-landblock entity pose remains, `runtime_pose_for_guid` heals the LOCAL
/// player to its last-known cell (never reporting 0).
#[test]
fn wp2_body_absent_arm_heals_null_entity_pose_to_last_valid_cell() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_02A1);
    let source_cell = Guid(0x8602_01AD);
    let source_pos = WorldPosition {
        landblock_id: source_cell,
        coords: Vector3::new(3.0, 4.0, 5.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };

    state.seed_local_player_entity(player_guid, "Player", source_pos);
    // Non-null apply stamps `last_valid_landblock`.
    let _ = state.set_player_position(source_pos);
    assert_eq!(state.player.last_valid_landblock, Some(source_cell));

    // Drop the runtime body entirely — the body-absent arm is now the only
    // path — and null the authoritative entity pose.
    let _ = state
        .scene
        .retire_authoritative_body(SpatialBodyId::LocalPlayer(player_guid));
    if let Some(entity) = state.player_entity_mut() {
        entity.position.landblock_id = Guid::NULL;
    }
    assert!(
        state
            .scene
            .body(SpatialBodyId::LocalPlayer(player_guid))
            .is_none(),
        "precondition: body retired (body-absent arm exercised)"
    );

    let runtime = state
        .local_player_runtime_pose()
        .expect("body-absent arm still returns the entity pose");
    assert_eq!(
        runtime.landblock_id, source_cell,
        "body-absent NULL entity pose heals to the last-known-good cell, not 0"
    );
}

/// WP-2 regression guard: the retire-suppression is scoped to the LOCAL
/// player. A REMOTE entity's NULL-landblock pose is a genuine leave-the-scene
/// and MUST still retire its body — even while the local player holds a
/// stamped `last_valid_landblock`.
#[test]
fn wp2_remote_entity_null_landblock_still_retires() {
    let mut state = WorldState::synthetic();
    // A DIFFERENT guid is the local player, so the remote null must not be
    // mistaken for a local transient.
    state.player.guid = Guid(0x5000_02A2);
    state.player.last_valid_landblock = Some(Guid(0x8602_01AD));

    let remote_guid = Guid(0x7000_02A2);
    let pose = WorldPosition {
        landblock_id: Guid(0x1234_0000),
        coords: Vector3::new(1.0, 2.0, 3.0),
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    state
        .entities
        .insert(Entity::new(remote_guid, "Remote".to_string(), pose));
    state.scene.reconcile_authoritative_body(
        SpatialBodyId::Entity(remote_guid),
        pose,
        Vector3::zero(),
        Vector3::zero(),
        crate::AuthoritativeBodySync::Snapshot,
        Instant::now(),
    );
    assert!(
        state
            .scene
            .body(SpatialBodyId::Entity(remote_guid))
            .is_some(),
        "precondition: remote body registered"
    );

    let null_pose = WorldPosition {
        landblock_id: Guid::NULL,
        coords: pose.coords,
        rotation: holtburger_common::math::Quaternion::identity(),
    };
    state.reconcile_authoritative_body(
        remote_guid,
        null_pose,
        Vector3::zero(),
        Vector3::zero(),
        crate::AuthoritativeBodySync::Snapshot,
    );
    assert!(
        state
            .scene
            .body(SpatialBodyId::Entity(remote_guid))
            .is_none(),
        "a remote entity's NULL-landblock pose must still retire (world-exit)"
    );
}

/// T1 (2026-07-27) — the precipice edge test must run against the retail land-cell
/// TRIANGLE, not the 24 m cell quad.
///
/// Venue: landblock 0, cell (0,0) — global cell coords (0,0), which the retail
/// split hash `cell_swto_ne_cut` (acclient.c:354046) puts on the SW↔NE diagonal
/// (`v8 = 0*inner − 0 − 1369149221 = 2925818075`; `2925818075/2^32 = 0.6812 ≥ 0.5`).
/// Corner heights: SW = SE = NE = 0, NW = −30, so the SW↔NE diagonal IS the cliff
/// lip: the lower-right triangle `[SW, SE, NE]` is a flat walkable plateau and the
/// upper-left triangle `[SW, NE, NW]` drops away.
///
/// Standing at (14, 10) (`fx = 0.583 ≥ fy = 0.417` ⇒ lower-right triangle), a step
/// to (13, 15) (`fx = 0.542 < fy = 0.625`) crosses the diagonal. The quad's four
/// edges do not include the diagonal, so the quad reports "still inside" and no
/// edge stop fires; the triangle reports the crossed diagonal.
#[test]
fn precipice_edge_test_uses_the_retail_triangle_not_the_cell_quad() {
    let mut state = WorldState::synthetic();
    let mut grid = [0.0f32; 81];
    grid[1] = -30.0; // idx = vx*9 + vy ⇒ vertex (0,1) = NW corner of cell (0,0)
    state.populate_terrain_heights(0u32, grid);

    // The retail split rule must actually put this cell on SW↔NE, or the venue
    // below is describing the wrong diagonal.
    assert!(
        holtburger_dat::terrain_subdiv::cell_swto_ne_cut(0, 0),
        "venue assumes cell (0,0) is SW↔NE cut"
    );

    let stand = state
        .terrain_cell_triangle_at(14.0, 10.0)
        .expect("standing triangle");
    assert_eq!(
        [
            (stand[0].x, stand[0].y, stand[0].z),
            (stand[1].x, stand[1].y, stand[1].z),
            (stand[2].x, stand[2].y, stand[2].z),
        ],
        [(0.0, 0.0, 0.0), (24.0, 0.0, 0.0), (24.0, 24.0, 0.0)],
        "fx >= fy ⇒ retail lower-right ring [SW, SE, NE]"
    );

    let across = state
        .terrain_cell_triangle_at(13.0, 15.0)
        .expect("across-diagonal triangle");
    assert_eq!(
        [
            (across[0].x, across[0].y, across[0].z),
            (across[1].x, across[1].y, across[1].z),
            (across[2].x, across[2].y, across[2].z),
        ],
        [(0.0, 0.0, 0.0), (24.0, 24.0, 0.0), (0.0, 24.0, -30.0)],
        "fx < fy ⇒ retail upper-left ring [SW, NE, NW]"
    );

    // INVARIANT: the standing ring is coplanar with the normal + height the rest
    // of the outdoor chain samples at the same point.
    let n = state.terrain_normal_at(14.0, 10.0).expect("normal");
    assert!(
        (n.x).abs() < 1e-5 && (n.y).abs() < 1e-5 && (n.z - 1.0).abs() < 1e-5,
        "flat plateau normal must be +Z, got ({}, {}, {})",
        n.x,
        n.y,
        n.z
    );
    // `find_crossed_edge` anchors the plane at `vertices[0]` and projects with the
    // caller's normal (acclient.c:360434), so every ring vertex must satisfy
    // `N·v + d = 0` for `d = −(N · vertices[0])`.
    let plane_d = -(n.x * stand[0].x + n.y * stand[0].y + n.z * stand[0].z);
    for v in stand {
        assert!(
            (n.x * v.x + n.y * v.y + n.z * v.z + plane_d).abs() < 1e-3,
            "ring vertex {v:?} off the terrain_normal_at plane"
        );
    }
    // The quad is NOT coplanar with that normal — the defect this test pins.
    let quad_check = state.terrain_cell_quad_at(14.0, 10.0).expect("quad");
    assert!(
        quad_check
            .iter()
            .any(|v| (n.x * v.x + n.y * v.y + n.z * v.z + plane_d).abs() > 1.0),
        "venue must have a non-coplanar cell quad for the comparison to bite"
    );

    let up = Vector3::new(0.0, 0.0, 1.0);
    let probe = Vector3::new(13.0, 15.0, 0.0);

    // BEFORE (quad): the probe is inside all four cell-boundary edges — every
    // `disp · (N × edge)` is positive (312 / 360 / 264 / 216) — so no edge stop
    // fires and the mover keeps going to `begin_fall`.
    let quad = state.terrain_cell_quad_at(14.0, 10.0).expect("quad");
    assert!(
        crate::spatial::find_crossed_edge(&quad, n, probe, up).is_none(),
        "the 24 m quad has no diagonal edge, so it cannot detect this walk-off"
    );

    // AFTER (triangle): the closing edge NE → SW is the diagonal.
    //   edge = SW − NE = (−24, −24, 0);  N × edge = (24, −24, 0)
    //   disp = proj − NE = (−13, −11, 0);  disp · (N × edge) = −312 + 264 = −48 < 0
    //   normal = (24, −24, 0)/|…| = (+0.70711, −0.70711, 0)   (inward, CCW ring)
    let edge_n = crate::spatial::find_crossed_edge(&stand, n, probe, up)
        .expect("the diagonal edge must be reported as crossed");
    assert!(
        (edge_n.x - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-4
            && (edge_n.y + std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-4
            && edge_n.z.abs() < 1e-4,
        "diagonal lip normal must be (+1,−1,0)/√2, got ({}, {}, {})",
        edge_n.x,
        edge_n.y,
        edge_n.z
    );

    // The slide keeps only the along-lip component, so an oblique walk-off rides
    // the diagonal instead of dropping (`SPHEREPATH::precipice_slide`,
    // acclient.c:314006-314036).
    //   motion = (13, 15) − (14, 10) = (−1, 5, 0);  motion · n = −4.24264 ≤ 0
    //   slid = motion − n(motion · n) = (−1, 5, 0) + (3, −3, 0) = (2, 2, 0)
    let motion = Vector3::new(-1.0, 5.0, 0.0);
    let slid = crate::spatial::precipice_slide_residual(motion, edge_n).expect("slide");
    assert!(
        (slid.x - 2.0).abs() < 1e-4 && (slid.y - 2.0).abs() < 1e-4 && slid.z.abs() < 1e-4,
        "expected the along-diagonal component (2, 2, 0), got ({}, {}, {})",
        slid.x,
        slid.y,
        slid.z
    );
    // …and the slid destination is back on the walkable plateau triangle.
    let landed = state
        .terrain_cell_triangle_at(14.0 + slid.x, 10.0 + slid.y)
        .expect("landing triangle");
    assert_eq!(
        (landed[2].x, landed[2].y),
        (24.0, 24.0),
        "the slide must stay on the lower-right (plateau) triangle"
    );

    // A perpendicular walk-off (straight at the lip) slides to ~zero — retail's
    // sticky lip.
    let head_on = Vector3::new(-3.0, 3.0, 0.0);
    let stuck = crate::spatial::precipice_slide_residual(head_on, edge_n).expect("slide");
    assert!(
        stuck.x.abs() < 1e-4 && stuck.y.abs() < 1e-4,
        "a perpendicular walk-off must stop at the lip, got ({}, {})",
        stuck.x,
        stuck.y
    );
}

/// Rust review 2026-08-03 — `remove_entity` pruned `entities`, the scene, the
/// authoritative body and `entity_lifecycle`, but NOT `open_containers` or
/// `prior_wielders`. Same family as the round-6 `prune_guid` finding: a
/// guid-keyed index that outlives its entity, and ACE recycles object GUIDs.
///
/// Scenario: a ground container is opened (`ViewContents` -> `open_containers`)
/// and then destroyed — a looted corpse decaying, or simply the 25 s visibility
/// sweep evicting it after you walk away. `CloseGroundContainer`, the ONLY
/// thing that removed the entry, never arrives.
#[test]
fn removing_an_open_ground_container_clears_its_open_containers_entry() {
    let mut state = WorldState::synthetic();
    state.server_time = Some(ServerTimeSync {
        server_time: 100.0,
        local_time: Instant::now(),
    });

    let container_guid = Guid(0x8000_0910);
    let mut container = Entity::new(
        container_guid,
        "Corpse".to_string(),
        WorldPosition::default(),
    );
    container.position.landblock_id = Guid(0xA9B4_0000);
    state.entities.insert(container);
    state.open_containers.insert(container_guid);

    assert!(state.remove_entity(container_guid).is_some());

    assert!(
        !state.open_containers.contains(&container_guid),
        "a destroyed container must not stay in open_containers — the entry is \
         unbounded (one per opened-then-despawned container) and ACE recycles \
         object GUIDs"
    );
}

/// The consequence of the leak above, in the terms the eviction sweep actually
/// reads: a NEW object that reuses the recycled container guid makes every item
/// pointing at it look like it is `inside_open_container`, so
/// `has_nonworld_retention()` is true and `should_evict_entity` refuses to ever
/// prune those items (liveness.rs:259 / :90).
///
/// NEGATIVE CONTROL: this asserts on `should_evict_entity`, not on the set
/// itself, so the plausible-but-wrong "clear open_containers wholesale on any
/// remove_entity" would still have to leave a genuinely open container working
/// — which the third assertion below pins down.
#[test]
fn recycled_container_guid_does_not_pin_items_against_eviction() {
    let mut state = WorldState::synthetic();
    state.server_time = Some(ServerTimeSync {
        server_time: 100.0,
        local_time: Instant::now(),
    });

    let container_guid = Guid(0x8000_0911);
    let mut container = Entity::new(
        container_guid,
        "Corpse".to_string(),
        WorldPosition::default(),
    );
    container.position.landblock_id = Guid(0xA9B4_0000);
    state.entities.insert(container);
    state.open_containers.insert(container_guid);

    // The container is destroyed without a CloseGroundContainer.
    assert!(state.remove_entity(container_guid).is_some());

    // Much later, ACE recycles the guid onto an unrelated object, and some
    // loose item legitimately reports it as its container.
    let item_guid = Guid(0x8000_0912);
    let mut item = Entity::new(item_guid, "Debris".to_string(), WorldPosition::default());
    item.set_container_id(Some(container_guid));
    item.position.landblock_id = Guid::NULL;
    state.entities.insert(item);
    state.mark_container_preview(item_guid);
    state.set_entity_prune_deadline(item_guid, 50.0); // already expired at t=100

    let snapshot = state
        .retention_snapshot(item_guid, 100.0)
        .expect("item should have a retention snapshot");
    assert!(
        !snapshot.inside_open_container,
        "the recycled guid must not read as an open container"
    );
    assert!(
        state.should_evict_entity(item_guid, 100.0),
        "an expired preview item must be evictable once its container is gone"
    );

    // Control: a container that is genuinely still open DOES pin its preview
    // items, so the fix has not simply disabled open-container retention.
    let live_container = Guid(0x8000_0913);
    let live_item = Guid(0x8000_0914);
    let mut item2 = Entity::new(live_item, "Loot".to_string(), WorldPosition::default());
    item2.set_container_id(Some(live_container));
    item2.position.landblock_id = Guid::NULL;
    state.entities.insert(item2);
    state.open_containers.insert(live_container);
    state.mark_container_preview(live_item);
    state.set_entity_prune_deadline(live_item, 50.0);
    assert!(
        !state.should_evict_entity(live_item, 100.0),
        "an item inside a still-open container must stay retained"
    );
}

/// `WorldState::prior_wielders`' own doc comment claims it is "pruned … when
/// the entity is deleted", but only the explicit ObjectDelete /
/// InventoryRemoveObject handlers did so (handlers/inventory.rs:70,78) — the
/// visibility-sweep eviction path (`sweep_entity` -> `remove_entity`) did not.
/// A recycled guid then inherited the previous occupant's wielder.
#[test]
fn removing_an_entity_prunes_its_prior_wielder_record() {
    let mut state = WorldState::synthetic();
    let item_guid = Guid(0x8000_0920);
    let wielder_guid = Guid(0x8000_0921);

    let mut item = Entity::new(item_guid, "Sword".to_string(), WorldPosition::default());
    item.position.landblock_id = Guid(0xA9B4_0000);
    state.entities.insert(item);
    state
        .prior_wielders
        .insert(u32::from(item_guid), u32::from(wielder_guid));

    assert!(state.remove_entity(item_guid).is_some());

    assert!(
        !state.prior_wielders.contains_key(&u32::from(item_guid)),
        "prior_wielders must be pruned on ANY entity removal, not just the \
         explicit ObjectDelete handler — otherwise a recycled guid inherits a \
         dead wielder and emits a bogus EntityDetached"
    );
}

/// Rust review 2026-08-03 — of the three wire-vector consumers, only
/// `update_entity_velocity` (the REMOTE-guid VectorUpdate path) was missing
/// the "F9" non-finite guard. `VectorUpdateData::unpack` is six bare
/// `LittleEndian::read_f32` behind a length check, so a NaN payload landed
/// straight in `entity.velocity` and in the authoritative body, where it is
/// unrecoverable (every later value derives from the NaN).
///
/// Control: the two siblings that already guarded (`set_player_vector`,
/// which `set_player_vector_gated` funnels through) are asserted here too, so
/// a "fix" that removed the guard from them instead would not pass.
#[test]
fn remote_vector_update_rejects_non_finite_wire_values() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x5000_0001);
    state.seed_local_player_entity(player_guid, "Player", WorldPosition::default());

    let remote_guid = Guid(0x8000_0930);
    let mut remote = Entity::new(remote_guid, "Drudge".to_string(), WorldPosition::default());
    remote.position.landblock_id = Guid(0xA9B4_0019);
    remote.velocity = Vector3::new(1.0, 2.0, 3.0);
    state.entities.insert(remote);

    let mut events = Vec::new();
    let applied = state.update_entity_velocity(
        remote_guid,
        Vector3::new(f32::NAN, 0.0, 0.0),
        Vector3::new(0.0, f32::INFINITY, 0.0),
        1,
        &mut events,
    );
    assert!(applied, "the update should still be accepted, just sanitised");

    let entity = state
        .entities
        .get(remote_guid)
        .expect("remote entity should still exist");
    assert!(
        entity.velocity.is_finite(),
        "a non-finite wire velocity must never reach entity.velocity, got {:?}",
        entity.velocity
    );
    assert!(
        entity.omega.is_finite(),
        "a non-finite wire omega must never reach entity.omega, got {:?}",
        entity.omega
    );
    assert_eq!(entity.velocity, Vector3::zero());
    assert_eq!(entity.omega, Vector3::zero());

    // The authoritative body is fed from the same values (reconcile_authoritative_body).
    if let Some(pose) = state.runtime_pose_for_guid(remote_guid) {
        assert!(
            pose.coords.is_finite(),
            "the runtime body pose must stay finite, got {:?}",
            pose.coords
        );
    }

    // Control: the local-player path guards too and must keep doing so.
    let _ = state.set_player_vector(
        Vector3::new(0.0, f32::NAN, 0.0),
        Vector3::new(f32::NEG_INFINITY, 0.0, 0.0),
    );
    let player = state
        .entities
        .get(player_guid)
        .expect("player entity should exist");
    assert!(player.velocity.is_finite() && player.omega.is_finite());
}

/// ORACLE open defect #1 (2026-08-12) — the augmentation trace fires, and the
/// self-ObjectCreate path does NOT drop the property.
///
/// Two assertions in one test on purpose: an instrument that never fires is
/// indistinguishable from a defect that never happens, so the same test that
/// exonerates the create path also proves the trace can see a wipe at all.
#[test]
fn test_aug_trace_records_wipe_and_self_create_preserves_augmentation() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000044);

    let mut properties = WorldObjectProperties::default();
    properties
        .ints
        .insert(PropertyInt::AugmentationJackOfAllTrades, 1);
    properties.ints.insert(PropertyInt::Level, 1);
    let player_description = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: player_guid,
        sequence: 1,
        event: GameEvent::PlayerDescription(Box::new(PlayerDescriptionEventData {
            guid: player_guid,
            sequence: 1,
            name: "Player".to_string(),
            wee_type: 1,
            pos: Some(WorldPosition::default()),
            properties,
            positions: std::collections::BTreeMap::new(),
            attributes: std::collections::BTreeMap::new(),
            skills: std::collections::BTreeMap::new(),
            enchantments: Vec::new(),
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
    let _ = state.handle_message(&player_description);

    // The login dump seeded BOTH the live bag and the stash.
    assert_eq!(
        state.player_int_property(PropertyInt::AugmentationJackOfAllTrades),
        Some(1),
        "PlayerDescription must seed the live bag"
    );
    // None -> Some(1) is itself a transition, so the trace has exactly one row.
    assert_eq!(state.aug_trace().len(), 1, "the seed is a recorded transition");
    assert_eq!(state.aug_trace()[0].before, None);
    assert_eq!(state.aug_trace()[0].after, Some(1));
    assert!(state.aug_trace()[0].site.contains("GameEvent"));

    // A re-sent self ObjectCreate carrying only the public weenie baseline.
    // This is the shape §-11 §C ruled out by reading; assert it, don't trust it.
    let mut data = ObjectDescriptionData::with_guid(player_guid);
    data.public_weenie_desc.name = Some("Player".to_string());
    let _ = state.handle_message(&GameMessage::ObjectCreate(Box::new(data)));

    assert_eq!(
        state.player_int_property(PropertyInt::AugmentationJackOfAllTrades),
        Some(1),
        "the self re-create must NOT drop the augmentation"
    );
    assert_eq!(
        state.aug_trace().len(),
        1,
        "no second transition — the create path is clean"
    );

    // Now force a wipe through the REAL removal path. `ObjectDelete` only
    // marks (handlers/inventory.rs) — the entity is not removed until a later
    // `tick()` sweep, which is not a message handler at all. That is exactly
    // why `tick()` carries its own probe; without it this wipe is invisible.
    state.player_description_properties = None;
    let _ = state.handle_message(&GameMessage::ObjectDelete(Box::new(ObjectDeleteData {
        guid: player_guid,
    })));
    let _ = state.tick();

    assert_eq!(
        state.player_int_property(PropertyInt::AugmentationJackOfAllTrades),
        None,
        "control: the swept entity takes its int properties with it"
    );
    let wipe = state
        .aug_trace()
        .iter()
        .find(|e| e.before == Some(1) && e.after.is_none())
        .expect("the trace must catch a Some -> None wipe");
    assert_eq!(
        wipe.site, "tick/sweep",
        "the sweep, not the message, is what actually removed it"
    );
    assert!(
        !wipe.entity_after,
        "this control is the ENTITY-went shape; the live defect is the other one"
    );
}

/// ORACLE open defect #1 (2026-08-12) — the gap that made the trace useless in
/// a browser.
///
/// The test above drives `WorldState::handle_message`, the inherent wrapper.
/// The live wasm client does NOT call it: `apps/holtburger-web/src/lib.rs:43647`
/// calls `holtburger_world::handlers::routing::handle_message` directly. While
/// the probe sat on the wrapper, that made the trace structurally incapable of
/// recording anything in a real session — and it produced an empty trace there,
/// which reads exactly like the meaningful "no transition ever happened, so ACE
/// never sent it" answer the instrument was built to give.
///
/// So this asserts the probe on the path PRODUCTION takes. It must call
/// `routing::handle_message` directly; routing it through the wrapper would
/// re-open the same blind spot without failing.
#[test]
fn test_aug_trace_records_via_direct_routing_call_the_live_client_uses() {
    let mut state = WorldState::synthetic();
    let player_guid = Guid(0x50000044);

    let mut properties = WorldObjectProperties::default();
    properties
        .ints
        .insert(PropertyInt::AugmentationJackOfAllTrades, 1);
    let player_description = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: player_guid,
        sequence: 1,
        event: GameEvent::PlayerDescription(Box::new(PlayerDescriptionEventData {
            guid: player_guid,
            sequence: 1,
            name: "Player".to_string(),
            wee_type: 1,
            pos: Some(WorldPosition::default()),
            properties,
            positions: std::collections::BTreeMap::new(),
            attributes: std::collections::BTreeMap::new(),
            skills: std::collections::BTreeMap::new(),
            enchantments: Vec::new(),
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

    // The production call shape, verbatim: the free function, not the method.
    let mut events = Vec::new();
    crate::handlers::routing::handle_message(&mut state, &player_description, &mut events);

    assert_eq!(
        state.player_int_property(PropertyInt::AugmentationJackOfAllTrades),
        Some(1),
        "the direct routing call must still seed the bag"
    );
    assert_eq!(
        state.aug_trace().len(),
        1,
        "the probe must fire on the DIRECT routing call — this is the assertion \
         that fails if the hook moves back onto WorldState::handle_message"
    );
    assert_eq!(state.aug_trace()[0].before, None);
    assert_eq!(state.aug_trace()[0].after, Some(1));

    // And exactly once: the inherent wrapper delegates into the same function,
    // so a second probe there would double-record every transition.
    let mut state2 = WorldState::synthetic();
    let _ = state2.handle_message(&player_description);
    assert_eq!(
        state2.aug_trace().len(),
        1,
        "the wrapper must not double-record now that routing carries the probe"
    );
}
