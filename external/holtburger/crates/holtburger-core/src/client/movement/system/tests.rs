use super::super::common::{
    AUTONOMOUS_POSITION_HEARTBEAT_INTERVAL, PLAYER_GROUND_FRICTION_PER_SEC,
    PLAYER_LATERAL_ACCELERATION_CAP_M_PER_SEC_SQ, RUN_FORWARD_MOTION_COMMAND,
    RUN_HELD_TURN_SPEED_RAD_PER_SEC, TURN_RIGHT_MOTION_COMMAND, WALK_FORWARD_MOTION_COMMAND,
    build_autonomous_position, build_motion_state_raw_motion_state, player_run_rate_scalar,
    raw_motion_state_with_motion_style,
};
use super::*;
use crate::client::movement_types::Gait;
use holtburger_common::position::WorldPosition;
use holtburger_common::{Guid, Quaternion, Vector3};
use holtburger_protocol::messages::game_message::{RawMotionFlags, RawMotionState};
use holtburger_protocol::messages::movement::{HoldKey, MotionStance};
use holtburger_session::Session;
use holtburger_world::entity::Entity;
use holtburger_world::stats::{Attribute, AttributeType, Skill, SkillType, TrainingLevel};
use holtburger_world::{
    PlayerMotionTableSource, SelfMovementCapabilities, SelfMovementKinematics, WorldState,
};

fn seed_player_run_rate_scalar(world: &mut WorldState, run_skill: u32) -> f32 {
    world.player.attributes.insert(
        AttributeType::StrengthAttr,
        Attribute {
            attr_type: AttributeType::StrengthAttr,
            ranks: 0,
            start: 100,
            spent_xp: 0,
            next_rank_xp: None,
            base: 100,
            current: 100,
        },
    );
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

    player_run_rate_scalar(world)
}

fn seed_local_player(world: &mut WorldState, guid: Guid, position: WorldPosition) {
    world.seed_local_player_entity(guid, "Player", position);
}

fn seed_self_movement_capabilities_override(
    world: &mut WorldState,
    run_rate_scalar: f32,
    base_walk_speed: f32,
    base_run_speed: f32,
    turn_speed_rad_per_sec: f32,
) -> SelfMovementCapabilities {
    let capabilities = SelfMovementCapabilities {
        kinematics: SelfMovementKinematics {
            source: PlayerMotionTableSource::DirectProperty {
                motion_table_id: 0x0900_0020,
            },
            motion_table_id: 0x0900_0020,
            stance: MotionStance::NonCombat as u32,
            base_walk_forward_velocity: Vector3::new(base_walk_speed, 0.0, 0.0),
            base_run_forward_velocity: Vector3::new(base_run_speed, 0.0, 0.0),
            base_turn_left_omega: Vector3::new(0.0, 0.0, -turn_speed_rad_per_sec),
            base_turn_right_omega: Vector3::new(0.0, 0.0, turn_speed_rad_per_sec),
        },
        run_rate_scalar,
    };
    world.set_self_movement_capabilities_override(capabilities.clone());
    capabilities
}

#[test]
fn autonomous_wire_motion_state_uses_forward_without_turn_when_moving() {
    let mut world = WorldState::synthetic();
    world.seed_local_player_entity(
        Guid(0x5000_0123),
        "Player",
        WorldPosition {
            landblock_id: Guid(0x1234_0000),
            coords: Vector3::new(10.0, 20.0, 0.0),
            rotation: Quaternion::from_heading(0.0),
        },
    );

    let state = MovementSystem::autonomous_wire_motion_state(
        &world,
        AutonomousDriveIntent {
            desired_world_delta: Vector3::new(1.0, 0.0, 0.0),
            desired_heading: Some(90.0_f32.to_radians()),
            target_hint: None,
            gait: Gait::Run,
            force_grounded: true,
        },
    )
    .expect("moving autonomous drive should emit a wire motion state");

    assert_eq!(state.gait, Gait::Run);
    assert_eq!(state.forward, Some(ForwardLocomotion::Forward));
    assert_eq!(state.sidestep, None);
    assert_eq!(state.turning, None);
}

#[test]
fn autonomous_wire_motion_state_can_turn_in_place() {
    let mut world = WorldState::synthetic();
    world.seed_local_player_entity(
        Guid(0x5000_0123),
        "Player",
        WorldPosition {
            landblock_id: Guid(0x1234_0000),
            coords: Vector3::new(10.0, 20.0, 0.0),
            rotation: Quaternion::from_heading(0.0),
        },
    );

    let state = MovementSystem::autonomous_wire_motion_state(
        &world,
        AutonomousDriveIntent {
            desired_world_delta: Vector3::zero(),
            desired_heading: Some(90.0_f32.to_radians()),
            target_hint: None,
            gait: Gait::Walk,
            force_grounded: false,
        },
    )
    .expect("heading-only autonomous drive should still emit a turn edge");

    assert_eq!(state.gait, Gait::Walk);
    assert_eq!(state.forward, None);
    assert_eq!(state.sidestep, None);
    assert_eq!(state.turning, Some(Turn::Right));
}

#[test]
fn autonomous_wire_motion_state_skips_idle_aligned_requests() {
    let mut world = WorldState::synthetic();
    world.seed_local_player_entity(
        Guid(0x5000_0123),
        "Player",
        WorldPosition {
            landblock_id: Guid(0x1234_0000),
            coords: Vector3::new(10.0, 20.0, 0.0),
            rotation: Quaternion::from_heading(0.0),
        },
    );

    let state = MovementSystem::autonomous_wire_motion_state(
        &world,
        AutonomousDriveIntent {
            desired_world_delta: Vector3::zero(),
            desired_heading: Some(0.0),
            target_hint: None,
            gait: Gait::Walk,
            force_grounded: false,
        },
    );

    assert_eq!(state, None);
}

#[tokio::test]
async fn enqueue_drive_intent_exposes_autonomous_drive_for_current_tick_only() {
    let mut world = WorldState::synthetic();
    world.seed_local_player_entity(
        Guid(0x5000_0123),
        "Player",
        WorldPosition {
            landblock_id: Guid(0x1234_0000),
            ..Default::default()
        },
    );

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let now = Instant::now();
    movement.enqueue_drive_intent(
        PlayerDriveIntent::Autonomous(AutonomousDriveIntent {
            desired_world_delta: Vector3::new(1.0, 2.0, 3.0),
            desired_heading: Some(0.75),
            target_hint: Some(WorldPosition {
                landblock_id: Guid(0x1234_0100),
                coords: Vector3::new(5.0, 6.0, 7.0),
                rotation: Quaternion::identity(),
            }),
            gait: Gait::Run,
            force_grounded: true,
        }),
        now,
    );

    assert_eq!(
        movement.current_local_drive_control(&world, Duration::from_millis(33)),
        None
    );

    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("autonomous drive should activate on movement tick");

    let drive = movement
        .current_local_drive_control(&world, Duration::from_millis(33))
        .expect("autonomous drive should be exposed to simulation");

    assert_eq!(drive.body_id, SpatialBodyId::LocalPlayer(world.player.guid));
    assert_eq!(drive.desired_world_delta, Vector3::new(1.0, 2.0, 3.0));
    assert_eq!(drive.desired_heading, Some(0.75));
    assert_eq!(
        drive.target_hint,
        Some(WorldPosition {
            landblock_id: Guid(0x1234_0100),
            coords: Vector3::new(5.0, 6.0, 7.0),
            rotation: Quaternion::identity(),
        })
    );
    assert_eq!(drive.gait, holtburger_world::spatial::LocalDriveGait::Run);
    assert!(drive.force_grounded);

    movement
        .tick(now + Duration::from_millis(30), &mut world, &mut session)
        .await
        .expect("tick-scoped autonomous drive should expire when not resent");

    assert_eq!(
        movement.current_local_drive_control(&world, Duration::from_millis(33)),
        None
    );
}

#[tokio::test]
async fn later_manual_drive_wins_over_queued_autonomous_drive() {
    let mut world = WorldState::synthetic();
    world.seed_local_player_entity(
        Guid(0x5000_0123),
        "Player",
        WorldPosition {
            landblock_id: Guid(0x1234_0000),
            ..Default::default()
        },
    );

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let now = Instant::now();
    movement.enqueue_drive_intent(
        PlayerDriveIntent::Autonomous(AutonomousDriveIntent {
            desired_world_delta: Vector3::new(1.0, 0.0, 0.0),
            desired_heading: None,
            target_hint: None,
            gait: Gait::Walk,
            force_grounded: false,
        }),
        now,
    );
    movement.enqueue_drive_intent(
        PlayerDriveIntent::ManualHeld(MotionState::builder().run().forward().build()),
        now,
    );

    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("movement tick should arbitrate queued drive intents");

    assert_eq!(
        movement.current_local_drive_control(&world, Duration::from_millis(33)),
        None
    );
    assert!(matches!(
        movement.active_drive,
        Some(ActiveDriveState {
            intent: ActiveDriveIntent::Manual(MotionState {
                gait: Gait::Run,
                forward: Some(ForwardLocomotion::Forward),
                ..
            }),
            ..
        })
    ));
}

#[test]
fn test_raw_motion_state_preserves_cached_server_style_by_default() {
    let mut world = WorldState::synthetic();
    world.player.last_server_motion_style = Some(MotionStance::SwordCombat);

    let raw_motion_state = raw_motion_state_with_motion_style(
        &world,
        RawMotionState {
            flags: RawMotionFlags::CURRENT_HOLD_KEY
                | RawMotionFlags::FORWARD_COMMAND
                | RawMotionFlags::FORWARD_SPEED,
            current_hold_key: Some(HoldKey::Run as u32),
            forward_command: Some(WALK_FORWARD_MOTION_COMMAND),
            forward_speed: Some(7.0),
            ..Default::default()
        },
        MotionStyle::PreserveServer,
    );

    assert!(
        raw_motion_state
            .flags
            .contains(RawMotionFlags::CURRENT_STYLE)
    );
    assert!(
        raw_motion_state
            .flags
            .contains(RawMotionFlags::FORWARD_COMMAND)
    );
    assert_eq!(
        raw_motion_state.current_stance(),
        Some(MotionStance::SwordCombat)
    );
    assert_eq!(raw_motion_state.current_hold_key, Some(HoldKey::Run as u32));
    assert_eq!(
        raw_motion_state.forward_command,
        Some(WALK_FORWARD_MOTION_COMMAND)
    );
    assert_eq!(raw_motion_state.forward_speed, Some(7.0));
}

#[test]
fn test_raw_motion_state_can_override_cached_server_style() {
    let mut world = WorldState::synthetic();
    world.player.last_server_motion_style = Some(MotionStance::SwordCombat);

    let raw_motion_state = raw_motion_state_with_motion_style(
        &world,
        RawMotionState::default(),
        MotionStyle::Explicit(MotionStance::Magic),
    );

    assert!(
        raw_motion_state
            .flags
            .contains(RawMotionFlags::CURRENT_STYLE)
    );
    assert_eq!(raw_motion_state.current_stance(), Some(MotionStance::Magic));
}

#[test]
fn test_raw_motion_state_can_omit_cached_server_style() {
    let mut world = WorldState::synthetic();
    world.player.last_server_motion_style = Some(MotionStance::SwordCombat);

    let raw_motion_state = raw_motion_state_with_motion_style(
        &world,
        RawMotionState {
            flags: RawMotionFlags::CURRENT_STYLE,
            current_style: Some(MotionStance::Magic as u32),
            ..Default::default()
        },
        MotionStyle::Omit,
    );

    assert!(
        !raw_motion_state
            .flags
            .contains(RawMotionFlags::CURRENT_STYLE)
    );
    assert_eq!(raw_motion_state.current_style, None);
}

#[test]
fn motion_state_raw_motion_state_adds_right_turn_when_requested() {
    let world = WorldState::synthetic();

    // Wave 2 Phase 2.4 (2026-05-26) — Turn motion commands only
    // populate the wire when the player is stationary (no forward /
    // sidestep). Retail emits ONLY the locomotion clip when moving +
    // turning, and lets the yaw integrator handle heading change. So
    // this test now uses a turn-only state. The "forward + turn"
    // wire-suppression case is covered by
    // `motion_state_raw_motion_state_suppresses_turn_when_moving`.
    let raw_motion_state = build_motion_state_raw_motion_state(
        &world,
        MotionState::builder().run().turn_right().build(),
        MotionStyle::PreserveServer,
    );

    assert!(
        !raw_motion_state
            .flags
            .contains(RawMotionFlags::FORWARD_COMMAND)
    );
    assert!(
        raw_motion_state
            .flags
            .contains(RawMotionFlags::TURN_COMMAND)
    );
    assert!(raw_motion_state.flags.contains(RawMotionFlags::TURN_SPEED));
    assert_eq!(
        raw_motion_state.turn_command,
        Some(TURN_RIGHT_MOTION_COMMAND)
    );
    assert_eq!(
        raw_motion_state.turn_speed,
        Some(RUN_HELD_TURN_SPEED_RAD_PER_SEC)
    );
}

#[test]
fn motion_state_raw_motion_state_uses_player_run_rate_scalar_for_forward_speed() {
    let mut world = WorldState::synthetic();
    let expected_run_rate_scalar = seed_player_run_rate_scalar(&mut world, 300);

    let raw_motion_state = build_motion_state_raw_motion_state(
        &world,
        MotionState::builder().run().forward().build(),
        MotionStyle::PreserveServer,
    );

    // Wave 2 Phase 2.3 (2026-05-26): forward + Run now emits
    // `RunForward (0x44000007)` on the wire, not `WalkForward` with
    // a scaled speed. Matches retail `apply_run_to_command`
    // (`acclient.c:343463-343467`) which swaps the motion code itself
    // when Walk → Run kicks in.
    assert_eq!(
        raw_motion_state.forward_command,
        Some(RUN_FORWARD_MOTION_COMMAND)
    );
    assert_eq!(raw_motion_state.forward_hold_key, Some(HoldKey::Run as u32));
    assert_eq!(
        raw_motion_state.forward_speed,
        Some(expected_run_rate_scalar)
    );
    assert!(
        raw_motion_state
            .flags
            .contains(RawMotionFlags::FORWARD_HOLD_KEY)
    );
}

#[test]
fn motion_state_raw_motion_state_adds_left_turn_when_requested() {
    let world = WorldState::synthetic();

    // Wave 2 Phase 2.4 (2026-05-26) — Turn motion commands only
    // populate the wire when the player is stationary. See sibling
    // `motion_state_raw_motion_state_adds_right_turn_when_requested`
    // for the symmetric reasoning.
    //
    // Wave 2 Phase 2.5 (2026-05-26) — `Turn::Left` now emits the
    // `TurnRight (0x6500000D)` motion code with a NEGATED speed.
    // Retail's `InterpretedMotionState::ApplyMotion` only carries
    // `TurnRight` (`~/ac-headers/acclient.c:332761-332765`); ACE's
    // `MotionInterp.adjust_motion` (`MotionInterp.cs:409-412`) does
    // the same Left → Right rewrite with `speed *= -1`. Player MT
    // 0x09000001 has no `cycles[(stance, TurnLeft)]` entry, so the
    // renderer cache lookup needs the Right code to land a clip.
    let raw_motion_state = build_motion_state_raw_motion_state(
        &world,
        MotionState::builder().run().turn_left().build(),
        MotionStyle::PreserveServer,
    );

    assert!(
        raw_motion_state
            .flags
            .contains(RawMotionFlags::TURN_COMMAND)
    );
    assert_eq!(
        raw_motion_state.turn_command,
        Some(TURN_RIGHT_MOTION_COMMAND),
        "Phase 2.5 collapse: Turn::Left emits TurnRight code with signed speed",
    );
    assert_eq!(
        raw_motion_state.turn_speed,
        Some(-RUN_HELD_TURN_SPEED_RAD_PER_SEC),
        "Phase 2.5 collapse: negated speed signals left direction to ACE / observers",
    );
    assert_eq!(raw_motion_state.turn_hold_key, Some(HoldKey::Run as u32));
    assert!(
        raw_motion_state
            .flags
            .contains(RawMotionFlags::TURN_HOLD_KEY)
    );
}

#[test]
fn motion_state_raw_motion_state_suppresses_turn_when_moving() {
    // Wave 2 Phase 2.4 (2026-05-26) — verify the new Phase 2.4
    // contract: when the player is moving (forward or sidestep
    // populated) AND turning, the wire-side `turn_command` is
    // suppressed. Retail has no `TurnLeftWhileWalking` clip; the
    // walk clip plays alone and the yaw integrator handles heading.
    // The `state.turning` field stays populated on the MotionState
    // so `local_omega_for_state` can still drive the predicted
    // rotation locally (`movement/system.rs:953-955`).
    let world = WorldState::synthetic();

    let raw_motion_state = build_motion_state_raw_motion_state(
        &world,
        MotionState::builder().run().forward().turn_right().build(),
        MotionStyle::PreserveServer,
    );

    assert!(
        raw_motion_state
            .flags
            .contains(RawMotionFlags::FORWARD_COMMAND),
        "forward command must still be emitted when moving + turning",
    );
    assert!(
        !raw_motion_state
            .flags
            .contains(RawMotionFlags::TURN_COMMAND),
        "turn command suppressed when locomotion is active",
    );
    assert!(
        !raw_motion_state
            .flags
            .contains(RawMotionFlags::TURN_SPEED),
        "turn speed flag also suppressed",
    );
    assert_eq!(raw_motion_state.turn_command, None);
    assert_eq!(raw_motion_state.turn_speed, None);
    assert_eq!(raw_motion_state.turn_hold_key, None);
}

#[test]
fn motion_state_raw_motion_state_omits_turn_when_not_requested() {
    let world = WorldState::synthetic();

    let raw_motion_state = build_motion_state_raw_motion_state(
        &world,
        MotionState::builder().run().forward().build(),
        MotionStyle::PreserveServer,
    );

    assert!(
        !raw_motion_state
            .flags
            .contains(RawMotionFlags::TURN_COMMAND)
    );
    assert!(!raw_motion_state.flags.contains(RawMotionFlags::TURN_SPEED));
    assert_eq!(raw_motion_state.turn_command, None);
    assert_eq!(raw_motion_state.turn_speed, None);
}

#[test]
fn current_local_solve_body_input_uses_shared_resolved_manual_run_speed() {
    let mut world = WorldState::synthetic();
    let player_guid = Guid(0x50000123);
    world.player.guid = player_guid;
    let capabilities = seed_self_movement_capabilities_override(&mut world, 3.25, 1.0, 2.0, 1.25);
    let expected_local_run_speed = capabilities.resolved_manual_run_speed();
    let mut position = WorldPosition {
        landblock_id: Guid(0x12340000),
        coords: Vector3::new(10.0, 20.0, 0.0),
        rotation: Quaternion::identity(),
    };
    seed_local_player(&mut world, player_guid, position);

    position.rotation = Quaternion::from_heading(90.0_f32.to_radians());
    let _ = world.set_player_position(position);

    let mut movement = MovementSystem::new();
    movement.active_drive = Some(ActiveDriveState::manual(
        MotionState::builder().run().forward().build(),
        None,
    ));

    let body = movement
        .current_local_solve_body_input(&world)
        .expect("active manual drive should produce local solve input");
    assert_eq!(body.body_id, SpatialBodyId::LocalPlayer(player_guid));
    assert!(matches!(
        body.basis,
        Some(holtburger_world::SolveProjectionBasis::Velocity { velocity, omega })
            if velocity.x.abs() < 1e-5
                && (velocity.y - expected_local_run_speed).abs() < 1e-5
                && omega == Vector3::zero()
    ));
}

#[test]
fn current_local_solve_body_input_uses_shared_turn_omega_for_turn_in_place() {
    let mut world = WorldState::synthetic();
    let player_guid = Guid(0x50000123);
    world.player.guid = player_guid;
    let capabilities = seed_self_movement_capabilities_override(&mut world, 3.25, 1.0, 2.0, 1.25);
    let position = WorldPosition {
        landblock_id: Guid(0x12340000),
        coords: Vector3::new(10.0, 20.0, 0.0),
        rotation: Quaternion::identity(),
    };
    seed_local_player(&mut world, player_guid, position);

    let mut movement = MovementSystem::new();
    movement.active_drive = Some(ActiveDriveState::manual(
        MotionState::builder().walk().turn_left().build(),
        None,
    ));

    let body = movement
        .current_local_solve_body_input(&world)
        .expect("turn-in-place manual drive should produce local solve input");
    assert!(matches!(
        body.basis,
        Some(holtburger_world::SolveProjectionBasis::Velocity { velocity, omega })
            if velocity.length_squared() <= 1e-6
                && omega == capabilities.kinematics().base_turn_left_omega
    ));
}

#[test]
fn current_local_solve_body_input_requires_authoritative_spawn_pose() {
    let mut world = WorldState::synthetic();
    world.player.guid = Guid(0x50000123);

    let movement = MovementSystem::new();

    assert!(movement.current_local_solve_body_input(&world).is_none());
}

#[test]
fn stop_pulse_is_still_required_when_server_motion_is_active() {
    let mut movement = MovementSystem::new();
    movement.note_server_motion_sent(server_motion_intent(
        MotionState::builder().run().forward().turn_right().build(),
        MotionStyle::PreserveServer,
    ));

    assert!(movement.should_send_stop_pulse());
}

#[test]
fn note_server_motion_cleared_resets_drive_tracking() {
    let mut movement = MovementSystem::new();
    movement.note_server_motion_sent(server_motion_intent(
        MotionState::builder().run().forward().turn_right().build(),
        MotionStyle::PreserveServer,
    ));

    movement.note_server_motion_cleared();

    assert!(!movement.server_motion_active);
    assert!(movement.last_server_motion_intent.is_none());
}

#[test]
fn unchanged_motion_intent_does_not_require_server_refresh() {
    let mut movement = MovementSystem::new();
    movement.note_server_motion_sent(server_motion_intent(
        MotionState::builder().run().forward().turn_right().build(),
        MotionStyle::PreserveServer,
    ));

    assert!(!movement.should_send_motion_state_pulse(
        MotionState::builder().run().forward().turn_right().build(),
        MotionStyle::PreserveServer,
    ));
}

#[test]
fn autonomous_position_heartbeat_defaults_to_grounded_when_contact_unknown() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_0304);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };
    let mut entity = Entity::new(guid, "Player".to_string(), position);
    entity.velocity = Vector3::new(2.0, 0.0, 0.0);

    world.player.guid = guid;
    world.player.instance_sequence = 11;
    world.player.server_control_sequence = 22;
    world.player.teleport_sequence = 33;
    world.player.force_position_sequence = 44;
    seed_local_player(&mut world, guid, position);
    world.entities.insert(entity);

    let position_action = build_autonomous_position(&world, MovementPacketMetadata::default())
        .expect("moving player should emit autonomous position action");

    assert_eq!(position_action.position, position);
    assert_eq!(position_action.instance_sequence, 11);
    assert_eq!(position_action.server_control_sequence, 22);
    assert_eq!(position_action.teleport_sequence, 33);
    assert_eq!(position_action.force_position_sequence, 44);
    assert_eq!(position_action.last_contact, 1);
}

#[test]
fn autonomous_position_uses_server_grounded_when_contact_unspecified() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_0304);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };
    let mut entity = Entity::new(guid, "Player".to_string(), position);
    entity.velocity = Vector3::new(2.0, 0.0, 0.0);

    world.player.guid = guid;
    world.player.last_server_grounded = Some(true);
    seed_local_player(&mut world, guid, position);
    world.entities.insert(entity);

    let position_action = build_autonomous_position(&world, MovementPacketMetadata::default())
        .expect("moving player should emit autonomous position action");

    assert_eq!(position_action.last_contact, 1);
}

#[test]
fn autonomous_position_can_be_built_for_turn_only_motion() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_0304);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };
    let mut entity = Entity::new(guid, "Player".to_string(), position);
    entity.omega = Vector3::new(0.0, 0.0, 1.0);

    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);
    world.entities.insert(entity);

    let position_action = build_autonomous_position(&world, MovementPacketMetadata::default())
        .expect("turning player should emit autonomous position action");

    assert_eq!(position_action.position, position);
}

#[test]
fn autonomous_position_can_be_built_for_stationary_player() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_0304);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };

    world.player.guid = guid;
    world.player.instance_sequence = 11;
    world.player.server_control_sequence = 22;
    world.player.teleport_sequence = 33;
    world.player.force_position_sequence = 44;
    seed_local_player(&mut world, guid, position);

    let position_action = build_autonomous_position(&world, MovementPacketMetadata::default())
        .expect("autonomous position action should emit even when stationary");

    assert_eq!(position_action.position, position);
    assert_eq!(position_action.instance_sequence, 11);
    assert_eq!(position_action.server_control_sequence, 22);
    assert_eq!(position_action.teleport_sequence, 33);
    assert_eq!(position_action.force_position_sequence, 44);
}

#[tokio::test]
async fn stop_after_active_drive_sends_stop_pulse_then_final_position_sync() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_0304);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };
    let mut entity = Entity::new(guid, "Player".to_string(), position);

    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);
    world.entities.insert(entity.clone());

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();

    movement
        .execute_motion_state_at(
            MotionState::builder().run().forward().build(),
            &mut world,
            &mut session,
            Instant::now(),
        )
        .await
        .expect("drive request should succeed");

    entity.velocity = Vector3::new(0.0, 4.0, 0.0);
    world.entities.insert(entity);

    movement
        .execute_stop_at(
            Instant::now(),
            &mut world,
            &mut session,
            MovementPacketMetadata::default(),
            true,
        )
        .await
        .expect("stop request should succeed");

    assert_eq!(session.packet_sequence, 4);
}

#[tokio::test]
async fn stop_without_active_drive_does_not_send_final_position_sync() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_0304);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };

    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    movement.note_server_motion_sent(server_motion_intent(
        MotionState::builder().run().forward().turn_right().build(),
        MotionStyle::PreserveServer,
    ));

    movement
        .execute_stop_at(
            Instant::now(),
            &mut world,
            &mut session,
            MovementPacketMetadata::default(),
            false,
        )
        .await
        .expect("stop request should succeed");

    assert_eq!(session.packet_sequence, 2);
}

#[tokio::test]
async fn unchanged_motion_state_requests_do_not_resend_motion_pulses() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_0304);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };

    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let start = Instant::now();
    let state = MotionState::builder().run().forward().turn_right().build();

    movement
        .execute_motion_state_with_metadata_at(
            state,
            MovementPacketMetadata::default(),
            &mut world,
            &mut session,
            start,
        )
        .await
        .expect("initial motion request should send a motion pulse");
    assert_eq!(session.packet_sequence, 2);

    movement
        .execute_motion_state_with_metadata_at(
            state,
            MovementPacketMetadata::default(),
            &mut world,
            &mut session,
            start + Duration::from_millis(100),
        )
        .await
        .expect("unchanged motion request should be deduplicated");
    assert_eq!(session.packet_sequence, 2);
}

#[tokio::test]
async fn held_run_input_ticks_once_for_wire_and_keeps_local_vectors_consistent() {
    let mut world = WorldState::synthetic();
    seed_self_movement_capabilities_override(&mut world, 2.25, 1.0, 2.0, 1.5);
    let guid = Guid(0x0102_0304);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };

    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let start = Instant::now();

    movement.enqueue_drive_intent(
        PlayerDriveIntent::ManualHeld(MotionState::builder().run().forward().build()),
        start,
    );

    movement
        .tick(start, &mut world, &mut session)
        .await
        .expect("held run input should start moving");

    let player = movement
        .current_local_solve_body_input(&world)
        .expect("held run input should produce local solve input");
    assert!(matches!(
        player.basis,
        Some(holtburger_world::SolveProjectionBasis::Velocity { velocity, .. })
            if velocity.x.abs() < 1e-5 && (velocity.y - 4.5).abs() < 1e-5
    ));
    assert_eq!(session.packet_sequence, 2);

    movement
        .tick(start + Duration::from_millis(30), &mut world, &mut session)
        .await
        .expect("steady held run should not resend unchanged motion intent");

    let player = movement
        .current_local_solve_body_input(&world)
        .expect("steady held run should keep solve input active");
    assert!(matches!(
        player.basis,
        Some(holtburger_world::SolveProjectionBasis::Velocity { velocity, .. })
            if velocity.x.abs() < 1e-5 && (velocity.y - 4.5).abs() < 1e-5
    ));
    assert_eq!(session.packet_sequence, 2);
}

#[tokio::test]
async fn pulsed_run_input_expires_on_tick_and_sends_stop_transition() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_0304);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };

    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let start = Instant::now();

    movement.enqueue_drive_intent(
        PlayerDriveIntent::ManualPulse {
            state: MotionState::builder().run().forward().build(),
            duration: Duration::from_millis(50),
        },
        start,
    );

    movement
        .tick(start, &mut world, &mut session)
        .await
        .expect("pulse should start movement");
    assert_eq!(session.packet_sequence, 2);

    movement
        .tick(start + Duration::from_millis(60), &mut world, &mut session)
        .await
        .expect("expired pulse should stop movement on the next tick");

    let player = world
        .entities
        .get(guid)
        .expect("synthetic player entity should exist");
    assert!(player.velocity.length_squared() <= 1e-6);
    assert!(player.omega.length_squared() <= 1e-6);
    assert_eq!(session.packet_sequence, 4);
}

#[tokio::test]
async fn server_controlled_movement_suppresses_next_frontend_autonomous_wire_pulse() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_0304);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };

    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let now = Instant::now();

    movement.note_server_controlled_movement_started();
    movement.enqueue_drive_intent(
        PlayerDriveIntent::Autonomous(AutonomousDriveIntent {
            desired_world_delta: Vector3::new(1.0, 0.0, 0.0),
            desired_heading: Some(0.0),
            target_hint: None,
            gait: Gait::Run,
            force_grounded: true,
        }),
        now,
    );

    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("server-controlled suppression tick should succeed");

    assert!(movement.active_drive.is_none());
    assert!(!movement.server_motion_active);
}

#[test]
fn server_controlled_projection_uses_landblock_aware_global_delta() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_0304);
    let current_pose = WorldPosition {
        landblock_id: Guid(0x1234_0001),
        coords: Vector3::new(191.0, 64.0, 0.0),
        rotation: Quaternion::from_heading(0.0),
    };
    let target_pose = WorldPosition {
        landblock_id: Guid(0x1334_0001),
        coords: Vector3::new(1.0, 64.0, 0.0),
        rotation: Quaternion::from_heading(0.0),
    };

    world.player.guid = guid;
    seed_local_player(&mut world, guid, current_pose);

    let mut movement = MovementSystem::new();
    movement.set_server_controlled_projection(ServerControlledProjection {
        target_pose,
        speed_mps: 2.0,
    });

    let drive = movement
        .current_local_drive_control(&world, Duration::from_secs(1))
        .expect("server-controlled projection should expose a local drive");

    assert_eq!(drive.desired_world_delta, Vector3::new(2.0, 0.0, 0.0));
    assert_eq!(
        drive.desired_heading,
        Some(current_pose.heading_to(&target_pose))
    );
    assert_eq!(drive.target_hint, Some(target_pose));
}

#[tokio::test]
async fn stop_input_clears_held_run_and_sends_stop_transition() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_0304);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };

    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let start = Instant::now();

    movement.enqueue_drive_intent(
        PlayerDriveIntent::ManualHeld(MotionState::builder().run().forward().build()),
        start,
    );
    movement
        .tick(start, &mut world, &mut session)
        .await
        .expect("held run should start");

    movement.enqueue_drive_intent(PlayerDriveIntent::Stop, start + Duration::from_millis(30));
    movement
        .tick(start + Duration::from_millis(30), &mut world, &mut session)
        .await
        .expect("stop input should end held movement");

    let player = world
        .entities
        .get(guid)
        .expect("synthetic player entity should exist");
    assert!(player.velocity.length_squared() <= 1e-6);
    assert!(player.omega.length_squared() <= 1e-6);
    assert_eq!(session.packet_sequence, 4);
}

#[tokio::test]
async fn autonomous_drive_gap_does_not_send_stop_pulse_without_explicit_stop() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_0304);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };

    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let start = Instant::now();

    movement.enqueue_drive_intent(
        PlayerDriveIntent::Autonomous(AutonomousDriveIntent {
            desired_world_delta: Vector3::new(1.0, 0.0, 0.0),
            desired_heading: None,
            target_hint: None,
            gait: Gait::Run,
            force_grounded: true,
        }),
        start,
    );
    movement
        .tick(start, &mut world, &mut session)
        .await
        .expect("autonomous drive should emit a motion pulse");

    assert_eq!(session.packet_sequence, 2);

    movement
        .tick(start + Duration::from_millis(30), &mut world, &mut session)
        .await
        .expect("autonomous drive gap should not synthesize a stop pulse");

    assert_eq!(session.packet_sequence, 2);
}

#[tokio::test]
async fn explicit_stop_after_autonomous_drive_sends_stop_pulse() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_0304);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };

    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let start = Instant::now();

    movement.enqueue_drive_intent(
        PlayerDriveIntent::Autonomous(AutonomousDriveIntent {
            desired_world_delta: Vector3::new(1.0, 0.0, 0.0),
            desired_heading: None,
            target_hint: None,
            gait: Gait::Run,
            force_grounded: true,
        }),
        start,
    );
    movement
        .tick(start, &mut world, &mut session)
        .await
        .expect("autonomous drive should emit a motion pulse");

    movement.enqueue_drive_intent(PlayerDriveIntent::Stop, start + Duration::from_millis(30));
    movement
        .tick(start + Duration::from_millis(30), &mut world, &mut session)
        .await
        .expect("explicit stop should still emit a stop pulse");

    assert_eq!(session.packet_sequence, 4);
}

#[tokio::test]
async fn transient_motion_reasserts_autonomous_locomotion_on_next_tick() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_0304);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };

    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let start = Instant::now();

    let autonomous_intent = AutonomousDriveIntent {
        desired_world_delta: Vector3::new(1.0, 0.0, 0.0),
        desired_heading: None,
        target_hint: None,
        gait: Gait::Run,
        force_grounded: true,
    };

    movement.enqueue_drive_intent(PlayerDriveIntent::Autonomous(autonomous_intent), start);
    movement
        .tick(start, &mut world, &mut session)
        .await
        .expect("autonomous drive should emit a locomotion pulse");

    assert_eq!(session.game_action_sequence, 1);

    movement.enqueue_drive_intent(
        PlayerDriveIntent::Autonomous(autonomous_intent),
        start + Duration::from_millis(30),
    );
    movement.enqueue_transient_motion(
        holtburger_protocol::messages::movement::InterpretedMotionCommand(0x0087),
        MotionStyle::Explicit(MotionStance::NonCombat),
    );
    movement
        .tick(start + Duration::from_millis(30), &mut world, &mut session)
        .await
        .expect("transient motion should replace the locomotion pulse for this tick");

    assert_eq!(
        movement.current_local_drive_control(&world, Duration::from_millis(33)),
        Some(LocalDriveControl {
            body_id: SpatialBodyId::LocalPlayer(guid),
            desired_world_delta: autonomous_intent.desired_world_delta,
            desired_heading: autonomous_intent.desired_heading,
            target_hint: autonomous_intent.target_hint,
            gait: holtburger_world::spatial::LocalDriveGait::Run,
            force_grounded: true,
        })
    );
    assert!(movement.server_motion_active);
    assert!(movement.last_server_motion_intent.is_none());

    assert_eq!(session.game_action_sequence, 2);

    movement.enqueue_drive_intent(
        PlayerDriveIntent::Autonomous(autonomous_intent),
        start + Duration::from_millis(60),
    );
    movement
        .tick(start + Duration::from_millis(60), &mut world, &mut session)
        .await
        .expect("locomotion should be reasserted after the transient motion clears");

    assert_eq!(
        movement.last_server_motion_intent,
        MovementSystem::autonomous_wire_motion_state(&world, autonomous_intent)
            .map(|state| server_motion_intent(state, MotionStyle::PreserveServer))
    );

    assert_eq!(session.game_action_sequence, 3);
}

#[tokio::test]
async fn manual_motion_updates_server_motion_tracking_state() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_1304);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };

    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let start = Instant::now();
    let state = MotionState::builder().run().forward().build();

    movement.enqueue_drive_intent(PlayerDriveIntent::ManualHeld(state), start);
    movement
        .tick(start, &mut world, &mut session)
        .await
        .expect("manual locomotion should update server motion tracking");

    assert!(movement.server_motion_active);
    assert_eq!(
        movement.last_server_motion_intent,
        Some(server_motion_intent(state, MotionStyle::PreserveServer))
    );
}

#[tokio::test]
async fn server_controlled_projection_becomes_current_local_drive_control() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_2304);
    let current_pose = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(0.0),
    };
    let target_pose = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(16.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(0.0),
    };

    world.player.guid = guid;
    seed_local_player(&mut world, guid, current_pose);

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let start = Instant::now();

    movement.set_server_controlled_projection(ServerControlledProjection {
        target_pose,
        speed_mps: 2.0,
    });
    movement.note_server_controlled_movement_started();
    movement.enqueue_drive_intent(
        PlayerDriveIntent::Autonomous(AutonomousDriveIntent {
            desired_world_delta: Vector3::new(1.0, 0.0, 0.0),
            desired_heading: Some(0.0),
            target_hint: None,
            gait: Gait::Run,
            force_grounded: true,
        }),
        start,
    );

    movement
        .tick(start, &mut world, &mut session)
        .await
        .expect("server-controlled tick should expose a projected local drive");

    assert_eq!(
        movement.current_local_drive_control(&world, Duration::from_secs(1)),
        Some(LocalDriveControl {
            body_id: SpatialBodyId::LocalPlayer(guid),
            desired_world_delta: Vector3::new(2.0, 0.0, 0.0),
            desired_heading: Some(current_pose.heading_to(&target_pose)),
            target_hint: Some(target_pose),
            gait: holtburger_world::spatial::LocalDriveGait::Run,
            force_grounded: true,
        })
    );
    assert!(!movement.server_motion_active);
}

#[tokio::test]
async fn clearing_server_controlled_projection_reasserts_autonomous_motion_intent() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_3304);
    let current_pose = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(0.0),
    };
    let target_pose = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(16.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(0.0),
    };

    world.player.guid = guid;
    seed_local_player(&mut world, guid, current_pose);

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let start = Instant::now();
    let autonomous_intent = AutonomousDriveIntent {
        desired_world_delta: Vector3::new(1.0, 0.0, 0.0),
        desired_heading: Some(0.0),
        target_hint: None,
        gait: Gait::Run,
        force_grounded: true,
    };

    movement.set_server_controlled_projection(ServerControlledProjection {
        target_pose,
        speed_mps: 2.0,
    });
    movement.note_server_controlled_movement_started();
    movement.enqueue_drive_intent(PlayerDriveIntent::Autonomous(autonomous_intent), start);
    movement
        .tick(start, &mut world, &mut session)
        .await
        .expect("server-controlled takeover should succeed");

    movement.clear_server_controlled_projection();
    movement.enqueue_drive_intent(
        PlayerDriveIntent::Autonomous(autonomous_intent),
        start + Duration::from_millis(30),
    );
    movement
        .tick(start + Duration::from_millis(30), &mut world, &mut session)
        .await
        .expect("autonomous handoff should restore locomotion emission");

    assert_eq!(
        movement.last_server_motion_intent,
        MovementSystem::autonomous_wire_motion_state(&world, autonomous_intent)
            .map(|state| server_motion_intent(state, MotionStyle::PreserveServer))
    );
}

#[tokio::test]
async fn snap_facing_sends_autonomous_position_sync_with_updated_rotation() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_0304);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(0.0),
    };

    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();

    let events = movement
        .execute_snap_facing(
            Instant::now(),
            90.0_f32.to_radians(),
            &mut world,
            &mut session,
            MovementPacketMetadata::default(),
        )
        .await
        .expect("snap facing should succeed");

    let _ = events;
    let body = world
        .scene
        .body(SpatialBodyId::LocalPlayer(guid))
        .expect("local player runtime body should exist");
    assert!((body.pose.rotation.to_heading() - 90.0_f32.to_radians()).abs() < 1e-5);
    assert_eq!(session.packet_sequence, 2);
}

#[tokio::test]
async fn arrival_pose_sync_updates_runtime_pose_and_clears_server_motion() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_0304);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(0.0),
    };
    let arrival_pose = WorldPosition {
        landblock_id: Guid(0x1000_0100),
        coords: Vector3::new(12.0, -4.0, 7.25),
        rotation: Quaternion::from_heading(0.0),
    };

    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let start = Instant::now();

    movement.enqueue_drive_intent(
        PlayerDriveIntent::Autonomous(AutonomousDriveIntent {
            desired_world_delta: Vector3::new(1.0, 0.0, 0.0),
            desired_heading: None,
            target_hint: None,
            gait: Gait::Run,
            force_grounded: true,
        }),
        start,
    );
    movement
        .tick(start, &mut world, &mut session)
        .await
        .expect("autonomous drive should emit a motion pulse");

    movement.enqueue_drive_intent(
        PlayerDriveIntent::ArriveAtPose { pose: arrival_pose },
        start + Duration::from_millis(30),
    );
    movement
        .tick(start + Duration::from_millis(30), &mut world, &mut session)
        .await
        .expect("arrival pose should sync and stop motion");

    let body = world
        .scene
        .body(SpatialBodyId::LocalPlayer(guid))
        .expect("local player runtime body should exist");
    assert_eq!(body.pose, arrival_pose);
    assert_eq!(session.packet_sequence, 4);
    assert!(!movement.should_send_stop_pulse());
}

#[tokio::test]
async fn movement_heartbeat_arms_then_sends_for_stationary_player_with_valid_pose() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_0304);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };

    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let now = Instant::now();

    let sent = movement
        .maybe_send_autonomous_position_heartbeat(
            now,
            &world,
            &mut session,
            MovementPacketMetadata::default(),
        )
        .await
        .expect("movement heartbeat should arm successfully");

    assert!(!sent);
    assert_eq!(session.game_action_sequence, 0);

    let sent = movement
        .maybe_send_autonomous_position_heartbeat(
            now + AUTONOMOUS_POSITION_HEARTBEAT_INTERVAL + Duration::from_millis(1),
            &world,
            &mut session,
            MovementPacketMetadata::default(),
        )
        .await
        .expect("movement heartbeat should send once armed");

    assert!(sent);
    assert_eq!(session.game_action_sequence, 1);
    assert!(session.bytes_out > 0);
}

#[tokio::test]
async fn movement_heartbeat_skips_players_without_valid_runtime_pose() {
    let world = WorldState::synthetic();
    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();

    let sent = movement
        .maybe_send_autonomous_position_heartbeat(
            Instant::now(),
            &world,
            &mut session,
            MovementPacketMetadata::default(),
        )
        .await
        .expect("stationary heartbeat check should succeed");

    assert!(!sent);
    assert_eq!(session.game_action_sequence, 0);
    assert!(movement.next_autonomous_position_heartbeat_at.is_none());
}

#[tokio::test]
async fn armed_movement_heartbeat_stays_armed_when_player_stops_moving() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_0304);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };
    let mut entity = Entity::new(guid, "Player".to_string(), position);
    entity.velocity = Vector3::new(1.0, 0.0, 0.0);

    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);
    world.entities.insert(entity);

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let now = Instant::now();

    let sent = movement
        .maybe_send_autonomous_position_heartbeat(
            now,
            &world,
            &mut session,
            MovementPacketMetadata::default(),
        )
        .await
        .expect("moving heartbeat check should arm successfully");

    assert!(!sent);
    assert!(movement.next_autonomous_position_heartbeat_at.is_some());

    let stationary_entity = world
        .entities
        .get_mut(guid)
        .expect("synthetic player entity should exist");
    stationary_entity.velocity = Vector3::zero();
    stationary_entity.omega = Vector3::zero();

    let sent = movement
        .maybe_send_autonomous_position_heartbeat(
            now + AUTONOMOUS_POSITION_HEARTBEAT_INTERVAL + Duration::from_millis(1),
            &world,
            &mut session,
            MovementPacketMetadata::default(),
        )
        .await
        .expect("armed heartbeat should send one final stationary sync");

    assert!(sent);
    assert_eq!(session.game_action_sequence, 1);
    assert!(movement.next_autonomous_position_heartbeat_at.is_some());
}

#[tokio::test]
async fn movement_tick_emits_autonomous_position_heartbeat_when_due() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_0304);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };
    let mut entity = Entity::new(guid, "Player".to_string(), position);
    entity.velocity = Vector3::new(2.0, 0.0, 0.0);

    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);
    world.entities.insert(entity);

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let start = Instant::now();

    movement
        .tick(start, &mut world, &mut session)
        .await
        .expect("first movement tick should arm the heartbeat");

    assert_eq!(session.game_action_sequence, 0);

    movement
        .tick(
            start + AUTONOMOUS_POSITION_HEARTBEAT_INTERVAL + Duration::from_millis(1),
            &mut world,
            &mut session,
        )
        .await
        .expect("second movement tick should emit the heartbeat");

    assert_eq!(session.game_action_sequence, 1);
}

#[tokio::test]
async fn stop_without_active_drive_keeps_autonomous_position_heartbeat_armed() {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_0304);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };

    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let now = Instant::now();
    movement.note_server_motion_sent(server_motion_intent(
        MotionState::builder().run().forward().turn_right().build(),
        MotionStyle::PreserveServer,
    ));
    movement.refresh_autonomous_position_heartbeat_schedule(now, &world);

    movement
        .execute_stop_at(
            now,
            &mut world,
            &mut session,
            MovementPacketMetadata::default(),
            false,
        )
        .await
        .expect("stop request should succeed");

    assert!(movement.next_autonomous_position_heartbeat_at.is_some());
}

/// 2026-05-09 follow-up: lock in the contract that
/// `advance_local_pose_for_manual_drive` integrates `velocity * dt`
/// once per call (no double-application). Defends against a regression
/// of the type that triggered the integrator-overshoot investigation —
/// the live observation was effective walk speed ~25 m/s when the
/// MotionTable said 4.5 m/s. The leading hypothesis (Playwright
/// headless rAF batching coalescing multiple frames into a single tick
/// with a 5x-larger dt) is environmental and not reproducible in
/// native tests; this test covers the orthogonal failure mode where
/// the integrator itself applies dt twice. Live validation against
/// real-chrome vs Playwright remains a manual step (PK).
///
/// Wave 10 Phase 10.3 (2026-05-26): updated to pre-seed
/// `current_planar_velocity` to the expected steady-state run speed
/// before tick #1. Prior to Wave 10.3, the integrator applied
/// `target_velocity * dt` directly each tick; the test asserted
/// `|displacement|^2 == (speed*dt)^2`. After Wave 10.3 the integrator
/// smooths a stored velocity toward the target with friction-decay +
/// accel cap, so a from-rest tick produces only the accel-cap step
/// (`MAX_ACCEL * dt^2`). Pre-seeding the smoothed velocity to its
/// converged value restores the original "velocity * dt once" invariant
/// the test was built to catch — the dt-double-application failure mode
/// is orthogonal to the smoothing layer.
#[test]
fn advance_local_pose_for_manual_drive_applies_velocity_times_dt_once() {
    let mut world = WorldState::synthetic();
    let player_guid = Guid(0x50000777);
    world.player.guid = player_guid;
    let _capabilities =
        seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);
    // Place the player well inside the landblock (192 m per side) so
    // the integrator's `rebucket_outdoor_landblock` step at the end of
    // `advance_local_pose_for_manual_drive` doesn't shift coords into a
    // neighbour LB and skew the displacement accounting. Heading 0 +
    // run forward = velocity along world -X (per
    // `planar_velocity_for_heading`: vel.x = -cos(0)*speed = -speed).
    let start_pose = WorldPosition {
        landblock_id: Guid(0xA9B40001),
        coords: Vector3::new(100.0, 100.0, 1.5),
        rotation: Quaternion::identity(),
    };
    seed_local_player(&mut world, player_guid, start_pose);
    let _ = world.set_player_position(start_pose);

    let mut movement = MovementSystem::new();
    movement.active_drive = Some(ActiveDriveState::manual(
        MotionState::builder().run().forward().build(),
        None,
    ));

    // Pick dt = 100ms — large enough that any `velocity * dt`
    // miscount lands far outside f32 noise.
    let dt = Duration::from_millis(100);
    let dt_s = dt.as_secs_f32();
    let expected_speed = 4.5_f32; // base_run_forward_velocity (run_rate_scalar = 1.0)
    let expected_delta = expected_speed * dt_s;

    // Wave 10 Phase 10.3 — pre-seed smoothed velocity to the steady
    // state so this tick exercises the v*dt integration in isolation
    // (no accel-ramp from zero). `Quaternion::identity()` resolves to
    // heading π/2 (North) per `to_heading()` at `holtburger-common/
    // src/math.rs:139-158` (the 450° offset places identity at the
    // North heading), so the velocity vector from
    // `planar_velocity_for_heading(π/2, 4.5)` is
    // `(-cos(π/2)*4.5, sin(π/2)*4.5, 0) = (0, 4.5, 0)`. Pre-seeding
    // the smoothed velocity to match keeps the friction/accel layer
    // a no-op on this tick (target == current).
    world.player.current_planar_velocity = Vector3::new(0.0, expected_speed, 0.0);

    movement.advance_local_pose_for_manual_drive(&mut world, dt);

    let after = world
        .local_player_runtime_pose()
        .expect("runtime pose seeded above");
    let dx = after.coords.x - start_pose.coords.x;
    let dy = after.coords.y - start_pose.coords.y;
    let actual_speed_squared = dx * dx + dy * dy;
    // Accept any horizontal direction (the heading→velocity rotation
    // is the system's; we just want the magnitude of the lateral
    // displacement to match).
    let expected_squared = expected_delta * expected_delta;
    let tol = 1e-3_f32; // 1 mm tolerance on dt=100ms at 4.5 m/s
    assert!(
        (actual_speed_squared - expected_squared).abs() < tol,
        "single-tick lateral displacement should be |velocity * dt| = {expected_delta:.4} m, \
         got dx={dx:.4} dy={dy:.4} |delta|^2={actual_speed_squared:.6} expected^2={expected_squared:.6}"
    );

    // Sanity: a SECOND tick with the same dt should advance by ~the
    // same amount again — total displacement ≈ 2 * velocity * dt.
    // Catches a different bug: state accumulation that scales by
    // tick count instead of dt. Friction-decay over 100ms at f=0.95
    // is `pow(0.05, 0.1) ≈ 0.741`, then accel-cap toward target
    // restores most of the lost speed each tick. Tolerance is wider
    // (1 cm at 4.5 m/s, ~2.2% of expected delta) to accommodate the
    // small per-tick drift from this smoothing — the test still
    // catches dt-double-application (which would land at 4x expected).
    movement.advance_local_pose_for_manual_drive(&mut world, dt);
    let after_two = world
        .local_player_runtime_pose()
        .expect("runtime pose still seeded");
    let total_dx = after_two.coords.x - start_pose.coords.x;
    let total_dy = after_two.coords.y - start_pose.coords.y;
    let total_squared = total_dx * total_dx + total_dy * total_dy;
    let expected_two = (2.0 * expected_delta).powi(2);
    let tol_two = 0.02_f32; // 1.4 cm tolerance on the squared magnitude
    assert!(
        (total_squared - expected_two).abs() < tol_two,
        "two-tick lateral displacement should be ~|2 * velocity * dt|^2 = {expected_two:.6}, \
         got total_dx={total_dx:.4} total_dy={total_dy:.4} |delta|^2={total_squared:.6}"
    );
}

/// Wave 10 Phase 10.3 (movement-animation overhaul, 2026-05-26):
/// the user smell-tested "jump backwards, hold W on touchdown" and
/// observed the velocity vector flipping instantly from -backward to
/// +forward (no ramp through zero). The friction-decay + accel-cap
/// pipeline in `advance_local_pose_for_manual_drive` should now
/// produce a smooth transition: velocity decays through zero over
/// multiple ticks rather than snapping to the new target in one tick.
///
/// This test verifies that explicit behavior:
///   - Pre-seed `current_planar_velocity` to a backward-equivalent
///     value (positive X, since heading=identity ⇒ -X is "forward").
///   - Target velocity from the input is forward (negative X).
///   - After one 16ms tick the velocity should be CLOSER to zero
///     but NOT yet through it — the accel cap limits per-tick change
///     to ~`PLAYER_LATERAL_ACCELERATION_CAP_M_PER_SEC_SQ * dt`.
#[test]
fn advance_local_pose_for_manual_drive_ramps_velocity_through_zero_on_direction_change() {
    let mut world = WorldState::synthetic();
    let player_guid = Guid(0x5000_0AAA);
    world.player.guid = player_guid;
    let _capabilities =
        seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);
    let start_pose = WorldPosition {
        landblock_id: Guid(0xA9B40001),
        coords: Vector3::new(100.0, 100.0, 1.5),
        rotation: Quaternion::identity(),
    };
    seed_local_player(&mut world, player_guid, start_pose);
    let _ = world.set_player_position(start_pose);

    let mut movement = MovementSystem::new();
    // Drive input: run forward at heading π/2 (identity quat) ⇒
    // target velocity = (0, +4.5, 0) in world space.
    movement.active_drive = Some(ActiveDriveState::manual(
        MotionState::builder().run().forward().build(),
        None,
    ));

    // Pre-seed the smoothed velocity to (0, -4.5, 0) — the velocity
    // a player would have at the instant they finish a jump-backwards
    // arc, before the touchdown re-engages friction. Magnitude
    // matches run speed; direction is OPPOSITE the input target.
    world.player.current_planar_velocity = Vector3::new(0.0, -4.5, 0.0);

    // One typical 60Hz tick.
    let dt = Duration::from_millis(16);
    let dt_s = dt.as_secs_f32();
    movement.advance_local_pose_for_manual_drive(&mut world, dt);

    let v_after = world.player.current_planar_velocity;

    // Per-axis accel cap step: `MAX_ACCEL * dt = 8 * 0.016 = 0.128 m/s`.
    // Friction decay over 16ms: scale = `(1 - 0.5)^0.016 ≈ 0.989`,
    // so the residual velocity after friction is
    // `-4.5 * 0.989 ≈ -4.45`. Then the accel cap adds `+0.128`
    // toward the target (the cap saturates because
    // `target - v = 4.5 - (-4.45) = 8.95` is far above the cap).
    // Final velocity: `-4.45 + 0.128 ≈ -4.32`.
    //
    // The key assertion is that velocity has moved TOWARD zero
    // by approximately the accel cap step, and is still pointing
    // in the original (backward) direction — i.e., we haven't
    // teleported through zero to +4.5.
    assert!(
        v_after.y < 0.0,
        "velocity should still be backward (negative Y) after one 16ms tick — got y={:.4}",
        v_after.y,
    );
    assert!(
        v_after.y > -4.5,
        "velocity magnitude should have decreased toward zero — got y={:.4}",
        v_after.y,
    );
    let accel_step = PLAYER_LATERAL_ACCELERATION_CAP_M_PER_SEC_SQ * dt_s;
    let expected_delta_y = (1.0 - PLAYER_GROUND_FRICTION_PER_SEC).powf(dt_s);
    let predicted_v_y = -4.5 * expected_delta_y + accel_step;
    assert!(
        (v_after.y - predicted_v_y).abs() < 0.05,
        "velocity should match friction-decay + accel-cap model: predicted {predicted_v_y:.4}, \
         got {:.4}",
        v_after.y,
    );

    // Now run enough ticks to cross through zero. The total
    // backward velocity to dissipate is 4.5 m/s; the per-tick
    // toward-target push is ~0.128 m/s (capped) + the friction
    // squeeze. Expect zero-crossing within ~35 ticks (~0.6 s).
    for _ in 0..40 {
        movement.advance_local_pose_for_manual_drive(&mut world, dt);
    }
    let v_after_40 = world.player.current_planar_velocity;
    assert!(
        v_after_40.y > 0.0,
        "after 40 more ticks (~0.65 s total), velocity should have crossed through zero \
         and be positive (forward) — got y={:.4}",
        v_after_40.y,
    );
}

/// Wave 10 Phase 10.3 (2026-05-26): grounded player releasing W
/// should NOT stop instantly — retail decays the velocity over
/// several frames. With `target_velocity = 0` and the friction
/// coefficient at 0.5, the smoothed velocity halves every second
/// (approximately) until it falls under the small-velocity snap
/// threshold (0.25 m/s) and is zeroed.
#[test]
fn advance_local_pose_for_manual_drive_decays_velocity_when_input_released() {
    let mut world = WorldState::synthetic();
    let player_guid = Guid(0x5000_0BBB);
    world.player.guid = player_guid;
    let _capabilities =
        seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);
    let start_pose = WorldPosition {
        landblock_id: Guid(0xA9B40001),
        coords: Vector3::new(100.0, 100.0, 1.5),
        rotation: Quaternion::identity(),
    };
    seed_local_player(&mut world, player_guid, start_pose);
    let _ = world.set_player_position(start_pose);

    let mut movement = MovementSystem::new();
    // No forward/sidestep/turn → target velocity is zero.
    movement.active_drive = Some(ActiveDriveState::manual(
        MotionState::builder().run().build(),
        None,
    ));

    // Pre-seed the smoothed velocity to (0, +4.5, 0) — the velocity
    // a player would have at the instant they release W after
    // running North.
    world.player.current_planar_velocity = Vector3::new(0.0, 4.5, 0.0);

    let dt = Duration::from_millis(16);
    movement.advance_local_pose_for_manual_drive(&mut world, dt);
    let v_after_1 = world.player.current_planar_velocity;
    // One tick: friction = 0.989, accel toward zero capped at -0.128.
    // Predicted: `4.5*0.989 - 0.128 ≈ 4.32`.
    assert!(
        v_after_1.y < 4.5 && v_after_1.y > 4.0,
        "after one 16ms tick of decay, velocity should be in (4.0, 4.5) — got y={:.4}",
        v_after_1.y,
    );

    // Run enough ticks for the velocity to fall below the snap
    // threshold (0.25 m/s) and zero out. Worst-case estimate: at
    // `f = 0.5`, velocity halves per second; with accel-cap pushing
    // toward zero we get there faster. Expect zero by 5 seconds.
    for _ in 0..(5 * 60) {
        movement.advance_local_pose_for_manual_drive(&mut world, dt);
    }
    let v_final = world.player.current_planar_velocity;
    assert_eq!(
        v_final,
        Vector3::zero(),
        "after 5 seconds of zero input, velocity should be snapped to zero \
         (small-velocity threshold engaged) — got {:?}",
        v_final,
    );
}

/// 2026-05-10 academy rubberband — pre-bake gate: when an indoor
/// cell has neither AABB nor physics triangles loaded yet (the
/// usual state for the first few seconds after entity seed, while
/// `fetchEnvCellsInLandblock` is still running its async bake),
/// the integrator REFUSES to predict any motion. The pose stays at
/// the server-seeded position; rotation flow is unaffected (it
/// flows through `UpdateMotion`, not this integrator). Without
/// this gate the integrator runs unclamped during the bake window,
/// the heartbeat ships uncorrected positions, and ACE force-
/// repositions back to spawn — surfacing as the user-visible
/// "moves a little, snaps back" symptom.
#[test]
fn advance_local_pose_for_manual_drive_indoor_pre_bake_gates_motion() {
    let mut world = WorldState::synthetic();
    let player_guid = Guid(0x5000_0888);
    world.player.guid = player_guid;
    let _capabilities =
        seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);

    let indoor_landblock = Guid(0x8602_0100);
    let start_z = 5.0_f32;
    let start_pose = WorldPosition {
        landblock_id: indoor_landblock,
        coords: Vector3::new(50.0, 50.0, start_z),
        rotation: Quaternion::identity(),
    };
    seed_local_player(&mut world, player_guid, start_pose);
    let _ = world.set_player_position(start_pose);

    // No `insert_cell_aabb` and no `insert_cell_triangle` — the
    // pre-bake state. Populate the outdoor heightmap so we can
    // also prove the indoor branch doesn't accidentally read it.
    world.populate_terrain_heights(0x8602_0000, [99.0_f32; 81]);

    let mut movement = MovementSystem::new();
    movement.active_drive = Some(ActiveDriveState::manual(
        MotionState::builder().run().forward().build(),
        None,
    ));

    let dt = Duration::from_millis(100);
    for _ in 0..10 {
        movement.advance_local_pose_for_manual_drive(&mut world, dt);
    }

    let after = world
        .local_player_runtime_pose()
        .expect("runtime pose seeded above");

    // Pre-bake gate: pose unchanged on all axes.
    assert!(
        (after.coords.x - start_pose.coords.x).abs() < 1e-3,
        "pre-bake gate: X should be unchanged (got {:.4}, expected {:.4})",
        after.coords.x, start_pose.coords.x
    );
    assert!(
        (after.coords.y - start_pose.coords.y).abs() < 1e-3,
        "pre-bake gate: Y should be unchanged (got {:.4}, expected {:.4})",
        after.coords.y, start_pose.coords.y
    );
    assert!(
        (after.coords.z - start_z).abs() < 1e-3,
        "pre-bake gate: Z should be unchanged (got {:.4}, expected {start_z})",
        after.coords.z
    );

    // Rebucket is no-op for indoor regardless of cell-AABB presence.
    assert_eq!(
        after.landblock_id, indoor_landblock,
        "indoor: landblock_id should be unchanged"
    );
}

/// 2026-05-10 academy rubberband — when a cell AABB is registered
/// for the player's current cell, the integrator clamps lateral
/// motion to the AABB interior (inset by `PLAYER_CAPSULE_RADIUS`)
/// and floor-snaps Z to `aabb.min.z + 0.005`. This test exercises
/// the user-visible academy fix end-to-end at the integrator layer.
///
/// Replaces the pre-fix contract pin
/// (`advance_local_pose_for_manual_drive_indoor_skips_all_three_-
/// outdoor_branches`) — that test asserted the buggy "no clamp"
/// behaviour was preserved and is now obsolete.
#[test]
fn advance_local_pose_for_manual_drive_indoor_clamps_to_cell_aabb() {
    let mut world = WorldState::synthetic();
    let player_guid = Guid(0x5000_0889);
    world.player.guid = player_guid;
    let _capabilities =
        seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);

    // Holtburg Outpost academy area landblock — cell `0x86020100`
    // sits at the indoor end of the LB (`is_indoors()` → true). The
    // landblock high word for the cell AABB is `0x86020000`; its low
    // word `0x0100` goes into the cell-id key.
    let cell_landblock = Guid(0x8602_0100);
    let cell_id = u32::from(cell_landblock);

    // Player local coords inside the LB are `(50, 50, 1.5)`. Per
    // `WorldPosition::global_coords()` the world-space pose is
    // `(landblock_x_byte * 192 + 50, landblock_y_byte * 192 + 50,
    // 1.5)` → with high word `0x8602`, lb_x_byte = 0x86 = 134,
    // lb_y_byte = 0x02 = 2 → world `(134*192+50, 2*192+50, 1.5) =
    // (25778, 434, 1.5)`. Build the cell AABB around that so the
    // player starts well inside.
    let start_pose = WorldPosition {
        landblock_id: cell_landblock,
        coords: Vector3::new(50.0, 50.0, 1.5),
        rotation: Quaternion::identity(),
    };
    let global = start_pose.global_coords();
    seed_local_player(&mut world, player_guid, start_pose);
    let _ = world.set_player_position(start_pose);

    // Cell AABB: 4 m wide on each lateral axis, centred on the
    // player; 3 m tall, floor at z=1.0 (so floor_z = 1.005). The
    // player will run forward for 1 s at 4.5 m/s — without the
    // clamp they'd cover ~4.5 m laterally, far outside the 4 m AABB.
    let cell_aabb = holtburger_common::Aabb {
        min: holtburger_common::Vector3::new(global.x - 2.0, global.y - 2.0, 1.0),
        max: holtburger_common::Vector3::new(global.x + 2.0, global.y + 2.0, 4.0),
    };
    world.scene.insert_cell_aabb(cell_id, cell_aabb);

    let mut movement = MovementSystem::new();
    movement.active_drive = Some(ActiveDriveState::manual(
        MotionState::builder().run().forward().build(),
        None,
    ));

    let dt = Duration::from_millis(100);
    for _ in 0..10 {
        movement.advance_local_pose_for_manual_drive(&mut world, dt);
    }

    let after = world
        .local_player_runtime_pose()
        .expect("runtime pose seeded above");

    // Cell AABB clamp: the player's global X/Y must stay inside
    // the AABB inset by PLAYER_CAPSULE_RADIUS (0.4). Inset bounds:
    // x ∈ [global.x - 1.6, global.x + 1.6], same for y.
    let after_global = after.global_coords();
    let inset = 2.0 - 0.4;
    let abs_dx = (after_global.x - global.x).abs();
    let abs_dy = (after_global.y - global.y).abs();
    assert!(
        abs_dx <= inset + 1e-3,
        "indoor clamp: |Δx| = {abs_dx:.4} should be ≤ inset {inset:.4} (cell AABB half-width 2.0 - capsule radius 0.4)"
    );
    assert!(
        abs_dy <= inset + 1e-3,
        "indoor clamp: |Δy| = {abs_dy:.4} should be ≤ inset {inset:.4}"
    );

    // Floor snap: Z must be ≥ floor_z = 1.005 m, and (since spawn
    // Z 1.5 was already above floor_z) it should equal exactly the
    // spawn Z (no upward kick) given vz=0 throughout.
    assert!(
        after.coords.z >= 1.005 - 1e-4,
        "indoor floor snap: Z = {:.4} must be ≥ floor_z 1.005",
        after.coords.z
    );
    assert!(
        after.coords.z <= 1.5 + 1e-3,
        "indoor floor snap: Z = {:.4} should not have spuriously risen above spawn Z 1.5",
        after.coords.z
    );

    // Landblock unchanged (rebucket early-returns indoor).
    assert_eq!(
        after.landblock_id, cell_landblock,
        "landblock id should be preserved"
    );
}

/// 2026-05-10 academy rubberband — floor-Z snap kicks the player up
/// to `aabb.min.z + 0.005` when the integrator's Z would otherwise
/// fall below the cell floor (e.g. because the persisted spawn pose
/// arrived at z=0.0 from ACE's relocate-to-cell-origin path, but the
/// cell mesh's actual floor is at z=1.0).
#[test]
fn advance_local_pose_for_manual_drive_indoor_floor_snap_lifts_from_below() {
    let mut world = WorldState::synthetic();
    let player_guid = Guid(0x5000_088A);
    world.player.guid = player_guid;
    let _capabilities =
        seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);

    let cell_landblock = Guid(0x8602_0100);
    let cell_id = u32::from(cell_landblock);
    // Spawn Z is BELOW the cell's floor — represents the post-relocate
    // case where ACE plops the player at z≈0 but the actual cell
    // floor is higher up.
    let start_pose = WorldPosition {
        landblock_id: cell_landblock,
        coords: Vector3::new(50.0, 50.0, 0.0),
        rotation: Quaternion::identity(),
    };
    let global = start_pose.global_coords();
    seed_local_player(&mut world, player_guid, start_pose);
    let _ = world.set_player_position(start_pose);

    let cell_aabb = holtburger_common::Aabb {
        min: holtburger_common::Vector3::new(global.x - 5.0, global.y - 5.0, 1.0),
        max: holtburger_common::Vector3::new(global.x + 5.0, global.y + 5.0, 4.0),
    };
    world.scene.insert_cell_aabb(cell_id, cell_aabb);

    let mut movement = MovementSystem::new();
    movement.active_drive = Some(ActiveDriveState::manual(
        MotionState::builder().run().forward().build(),
        None,
    ));

    movement.advance_local_pose_for_manual_drive(&mut world, Duration::from_millis(100));

    let after = world
        .local_player_runtime_pose()
        .expect("runtime pose seeded above");
    // First tick should already lift to floor_z = 1.005.
    assert!(
        (after.coords.z - 1.005).abs() < 1e-3,
        "first-tick floor snap: Z should be 1.005 (cell floor + 5 mm), got {:.4}",
        after.coords.z
    );
}
