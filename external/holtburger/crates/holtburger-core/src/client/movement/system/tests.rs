use super::super::common::{
    AUTONOMOUS_POSITION_HEARTBEAT_INTERVAL, HUGE_QUANTUM, MAX_QUANTUM, MAX_VELOCITY,
    PLAYER_GROUND_FRICTION_PER_SEC, PLAYER_LATERAL_ACCELERATION_CAP_M_PER_SEC_SQ,
    RUN_FORWARD_MOTION_COMMAND, RUN_HELD_TURN_SPEED_RAD_PER_SEC, TURN_RIGHT_MOTION_COMMAND,
    WALK_FORWARD_MOTION_COMMAND, build_autonomous_position, build_motion_state_raw_motion_state,
    player_run_rate_scalar, raw_motion_state_with_motion_style,
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

/// Physics deep-dive 2026-06-01 (gap 4): the heartbeat position-change
/// gate. The first send always passes (no prior pose). After a send,
/// an unchanged pose is skipped; a pose that moved beyond the epsilon,
/// turned beyond the heading epsilon, crossed a landblock, or flipped
/// the contact byte is re-sent. Mirrors retail `ShouldSendPositionEvent`.
#[test]
fn autonomous_pose_change_gate_skips_unchanged_and_sends_changed() {
    let movement = MovementSystem::new();
    let base_pose = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(0.5),
    };
    let pulse = |pose: WorldPosition, contact: u8| AutonomousPositionActionData {
        position: pose,
        instance_sequence: 1,
        server_control_sequence: 2,
        teleport_sequence: 3,
        force_position_sequence: 4,
        last_contact: contact,
    };

    // First send: no prior pose recorded → always changed.
    let first = pulse(base_pose, 1);
    assert!(movement.autonomous_pose_changed(&first));

    let mut movement = movement;
    movement.note_autonomous_position_sent(&first);

    // Identical pose + contact → skip.
    assert!(!movement.autonomous_pose_changed(&pulse(base_pose, 1)));

    // Sub-epsilon jitter (1 cm < 0.05 m) → still skipped.
    let jitter = WorldPosition {
        coords: Vector3::new(12.01, -4.0, 1.5),
        ..base_pose
    };
    assert!(!movement.autonomous_pose_changed(&pulse(jitter, 1)));

    // Meaningful translation (0.5 m > 0.05 m) → send.
    let moved = WorldPosition {
        coords: Vector3::new(12.5, -4.0, 1.5),
        ..base_pose
    };
    assert!(movement.autonomous_pose_changed(&pulse(moved, 1)));

    // Heading turn beyond the heading epsilon → send.
    let turned = WorldPosition {
        rotation: Quaternion::from_heading(1.0),
        ..base_pose
    };
    assert!(movement.autonomous_pose_changed(&pulse(turned, 1)));

    // Landblock crossing → send.
    let crossed = WorldPosition {
        landblock_id: Guid(0x1000_0002),
        ..base_pose
    };
    assert!(movement.autonomous_pose_changed(&pulse(crossed, 1)));

    // Same pose but contact byte flipped (grounded → airborne) → send.
    assert!(movement.autonomous_pose_changed(&pulse(base_pose, 0)));

    // After re-sending the moved pose, the moved pose is the new
    // baseline and is itself skipped on repeat.
    let moved_pulse = pulse(moved, 1);
    movement.note_autonomous_position_sent(&moved_pulse);
    assert!(!movement.autonomous_pose_changed(&pulse(moved, 1)));
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

    // Physics deep-dive 2026-06-01 (gap 1): the integrator now gates
    // on MIN_QUANTUM (1/30 s) — a sub-MIN_QUANTUM frame (e.g. 16 ms)
    // accumulates time but integrates nothing this call. Drive a
    // single MAX_QUANTUM (0.1 s) slice so exactly one friction +
    // accel-cap step runs and the per-tick arithmetic below is exact.
    let dt = Duration::from_secs_f32(MAX_QUANTUM);
    let dt_s = dt.as_secs_f32();
    movement.advance_local_pose_for_manual_drive(&mut world, dt);

    let v_after = world.player.current_planar_velocity;

    // Per-axis accel cap step: `MAX_ACCEL * dt = 8 * 0.1 = 0.8 m/s`.
    // Friction decay over 100ms: scale = `(1 - 0.5)^0.1 ≈ 0.933`,
    // so the residual velocity after friction is
    // `-4.5 * 0.933 ≈ -4.20`. Then the accel cap adds `+0.8`
    // toward the target (the cap saturates because
    // `target - v = 4.5 - (-4.20) = 8.7` is far above the cap).
    // Final velocity: `-4.20 + 0.8 ≈ -3.40`.
    //
    // The key assertion is that velocity has moved TOWARD zero
    // by approximately the accel cap step, and is still pointing
    // in the original (backward) direction — i.e., we haven't
    // teleported through zero to +4.5.
    assert!(
        v_after.y < 0.0,
        "velocity should still be backward (negative Y) after one 100ms slice — got y={:.4}",
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

    // Now run enough slices to cross through zero. The total
    // backward velocity to dissipate is 4.5 m/s; the per-slice
    // toward-target push is ~0.8 m/s (capped) + the friction
    // squeeze. Expect a zero-crossing within ~10 slices (~1 s).
    for _ in 0..10 {
        movement.advance_local_pose_for_manual_drive(&mut world, dt);
    }
    let v_after_10 = world.player.current_planar_velocity;
    assert!(
        v_after_10.y > 0.0,
        "after 10 more 100ms slices (~1.1 s total), velocity should have crossed through zero \
         and be positive (forward) — got y={:.4}",
        v_after_10.y,
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

    // Physics deep-dive 2026-06-01 (gap 1): drive a single
    // MAX_QUANTUM (0.1 s) slice — a 16 ms frame is now below
    // MIN_QUANTUM and integrates nothing this call (accumulated for
    // the next frame). One 0.1 s slice runs exactly one decay step.
    let dt = Duration::from_secs_f32(MAX_QUANTUM);
    movement.advance_local_pose_for_manual_drive(&mut world, dt);
    let v_after_1 = world.player.current_planar_velocity;
    // One 0.1 s slice: friction = (1-0.5)^0.1 ≈ 0.933, accel toward
    // zero capped at -0.8. Predicted: `4.5*0.933 - 0.8 ≈ 3.40`.
    assert!(
        v_after_1.y < 4.5 && v_after_1.y > 3.0,
        "after one 100ms slice of decay, velocity should be in (3.0, 4.5) — got y={:.4}",
        v_after_1.y,
    );

    // Run enough slices for the velocity to fall below the snap
    // threshold (0.25 m/s) and zero out. Worst-case estimate: at
    // `f = 0.5`, velocity halves per second; with accel-cap pushing
    // toward zero we get there faster. Expect zero by 5 seconds
    // (50 slices of 0.1 s).
    for _ in 0..50 {
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

/// 2026-06-02 indoor floor-pop fix (`USE_RAMP_FLOOR_SNAP_FIX`) — on a
/// ramped/multi-level cell where only the AABB is baked (no per-poly
/// floor triangle under the player's XY, the tread-seam / sparse-poly
/// case `highest_floor_z_under` returns `None` for), a player whose
/// RETAINED Z is well above `aabb.min.z` must NOT be yanked down to the
/// cell minimum. The pre-fix `.or_else(|| aabb.min.z)` collapsed the
/// up-snap onto the cell's lowest floor; the fix keeps the retained Z.
///
/// Then, once a real per-poly floor triangle arrives under the player,
/// the normal floor-snap resumes (lifts a below-floor Z up to
/// `floor + 0.005`).
///
/// Finally, a genuine fall-through (retained Z below the entire cell)
/// still gets the AABB lower-bound safety snap so the player can't fall
/// through the world during the bake window.
#[test]
fn indoor_ramp_floor_snap_keeps_retained_z_until_triangles_arrive() {
    assert!(
        USE_RAMP_FLOOR_SNAP_FIX,
        "this test pins the default-on ramp floor-pop fix"
    );

    let mut world = WorldState::synthetic();
    let player_guid = Guid(0x5000_088B);
    world.player.guid = player_guid;
    let _capabilities =
        seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);

    let cell_landblock = Guid(0x8602_0100);
    let cell_id = u32::from(cell_landblock);

    // Player is standing on a RAMP, partway up: retained Z = 5.0 m,
    // well above the cell's lowest floor. The cell AABB bottom is the
    // foot of the ramp at z = 1.0 (so the pre-fix code would pop the
    // player from 5.0 down to 1.005).
    let start_pose = WorldPosition {
        landblock_id: cell_landblock,
        coords: Vector3::new(50.0, 50.0, 5.0),
        rotation: Quaternion::identity(),
    };
    let global = start_pose.global_coords();
    seed_local_player(&mut world, player_guid, start_pose);
    let _ = world.set_player_position(start_pose);

    // AABB only — no per-poly triangles yet (lazy bake not complete, or
    // the XY lands in a gap between sparse ramp polys). Tall cell so the
    // ceiling clamp never engages on the retained Z.
    let cell_aabb = holtburger_common::Aabb {
        min: holtburger_common::Vector3::new(global.x - 5.0, global.y - 5.0, 1.0),
        max: holtburger_common::Vector3::new(global.x + 5.0, global.y + 5.0, 40.0),
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
    // THE FIX: retained Z (5.0) preserved — NOT popped to aabb.min.z +
    // 0.005 (1.005). Grounded with vz = 0, no per-poly floor → keep Z.
    assert!(
        after.coords.z > 4.99,
        "ramp floor-pop fix: AABB-only cell must KEEP retained Z (~5.0), \
         not yank it down to aabb.min.z + 0.005 (1.005); got {:.4}",
        after.coords.z
    );

    // --- Triangles arrive: normal floor-snap resumes ---
    // Bake a real, near-flat floor triangle under the player at z = 5.2
    // (a tread). Drop the player's retained Z just below it so the
    // per-poly up-snap fires.
    let floor_z = 5.2_f32;
    // Big enough to cover the player's XY (and the ~0.45 m of forward
    // travel in one 100 ms run tick).
    let tri = holtburger_common::Triangle::new(
        holtburger_common::Vector3::new(global.x - 5.0, global.y - 5.0, floor_z),
        holtburger_common::Vector3::new(global.x + 5.0, global.y - 5.0, floor_z),
        holtburger_common::Vector3::new(global.x, global.y + 5.0, floor_z),
    );
    world.scene.insert_cell_triangle(cell_id, tri);

    // Seed the retained Z just below the new floor so the snap-up has
    // work to do.
    let below_floor = WorldPosition {
        landblock_id: cell_landblock,
        coords: Vector3::new(50.0, 50.0, floor_z - 0.3),
        rotation: Quaternion::identity(),
    };
    let _ = world.set_player_position(below_floor);

    movement.advance_local_pose_for_manual_drive(&mut world, Duration::from_millis(100));
    let after_tri = world
        .local_player_runtime_pose()
        .expect("runtime pose seeded above");
    assert!(
        (after_tri.coords.z - (floor_z + 0.005)).abs() < 1e-3,
        "with a per-poly floor present, the snap must resume: Z should be \
         floor + 5 mm ({:.4}), got {:.4}",
        floor_z + 0.005,
        after_tri.coords.z
    );
}

/// 2026-06-02 indoor floor-pop fix — the AABB lower-bound safety snap
/// still catches a GENUINE fall-through: an AABB-only cell where the
/// retained Z has dropped BELOW the whole cell floor must be lifted to
/// `aabb.min.z + 0.005` (the bake-window protection the legacy fallback
/// provided). The fix demotes `aabb.min.z` from an up-snap target to a
/// lower bound, but the lower bound still fires when the player is below
/// it.
#[test]
fn indoor_aabb_only_below_cell_floor_still_gets_safety_snap() {
    let mut world = WorldState::synthetic();
    let player_guid = Guid(0x5000_088C);
    world.player.guid = player_guid;
    let _capabilities =
        seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);

    let cell_landblock = Guid(0x8602_0100);
    let cell_id = u32::from(cell_landblock);
    // Retained Z is BELOW the cell floor (post-relocate z≈0 vs floor at
    // 1.0) — a real fall-through the lower-bound guard must catch.
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
    assert!(
        (after.coords.z - 1.005).abs() < 1e-3,
        "fall-through safety snap: a below-cell-floor Z must lift to \
         aabb.min.z + 5 mm (1.005), got {:.4}",
        after.coords.z
    );
}

// ---------------------------------------------------------------------------
// Physics deep-dive 2026-06-01 — quantum-subdivided integration loop
// (handoff gaps 1 + 7). The raw per-frame `dt` is bounded + subdivided
// before the gravity/friction/collision step, gravity carries as
// acceleration with a 2nd-order position term, and the total velocity
// magnitude is terminal-clamped to MAX_VELOCITY. These tests pin the
// loop's contract against ACE's `update_object`
// (`external/ACE/Source/ACE.Server/Physics/PhysicsObj.cs:4140-4190`).
// ---------------------------------------------------------------------------

/// Seed an outdoor airborne player on a `synthetic()` world (no
/// terrain heightmap → `terrain_height_at` returns `None`, so the
/// floor-Z landing snap never fires and the gravity arc integrates
/// uninterrupted). Returns the movement system primed with a held-run
/// manual drive and the start pose.
fn seed_airborne_player(
    world: &mut WorldState,
    guid: Guid,
    start_z: f32,
) -> (MovementSystem, WorldPosition) {
    world.player.guid = guid;
    let _capabilities = seed_self_movement_capabilities_override(world, 1.0, 1.0, 4.5, 1.5);
    let start_pose = WorldPosition {
        landblock_id: Guid(0xA9B40001),
        coords: Vector3::new(100.0, 100.0, start_z),
        rotation: Quaternion::identity(),
    };
    seed_local_player(world, guid, start_pose);
    let _ = world.set_player_position(start_pose);
    // No terrain seeded → no floor under the player → pure free-fall.
    world.player.begin_fall();
    assert!(world.player.is_airborne, "begin_fall should set airborne");

    let mut movement = MovementSystem::new();
    movement.active_drive = Some(ActiveDriveState::manual(
        MotionState::builder().run().forward().build(),
        None,
    ));
    (movement, start_pose)
}

/// Gap 1 — `quantum_slices` is the single source of truth for the
/// subdivision schedule. A 0.25 s frame splits into two `MAX_QUANTUM`
/// (0.1 s) slices plus the 0.05 s remainder (> `MIN_QUANTUM` 0.0333 s)
/// = THREE slices, mirroring ACE's
/// `while (dt > MaxQuantum) … ; if (dt > MinQuantum) …`
/// (`PhysicsObj.cs:4175-4186`).
#[test]
fn quantum_slices_subdivides_quarter_second_into_three_slices() {
    let slices = quantum_slices(0.25).expect("0.25 s is under HugeQuantum, not dropped");
    assert_eq!(
        slices.len(),
        3,
        "0.25 s ⇒ 0.1 + 0.1 + 0.05 = 3 slices, got {slices:?}"
    );
    assert!(
        (slices[0] - MAX_QUANTUM).abs() < 1e-6 && (slices[1] - MAX_QUANTUM).abs() < 1e-6,
        "first two slices should be MAX_QUANTUM, got {slices:?}"
    );
    assert!(
        (slices[2] - 0.05).abs() < 1e-6,
        "remainder slice should be 0.05 s, got {:.6}",
        slices[2]
    );
    // The schedule sums to the input frame (no time lost when the
    // remainder clears MinQuantum).
    let total: f32 = slices.iter().sum();
    assert!((total - 0.25).abs() < 1e-6, "slices should sum to 0.25, got {total:.6}");
}

/// Gap 1 — a sub-`MIN_QUANTUM` frame (a normal 16 ms rAF tick) yields
/// an EMPTY schedule: nothing is integrated until enough time
/// accumulates, matching retail's 30 Hz physics gate
/// (`deltaTime < TickRate` early-return at `PhysicsObj.cs:4163`).
#[test]
fn quantum_slices_drops_sub_min_quantum_frame() {
    let slices = quantum_slices(0.016).expect("16 ms is under HugeQuantum");
    assert!(
        slices.is_empty(),
        "16 ms (< MinQuantum 0.0333 s) should integrate nothing, got {slices:?}"
    );
}

/// Gap 1 — a `HUGE_QUANTUM`-or-larger hitch is DROPPED entirely
/// (`quantum_slices` returns `None`) so a falling player can't be
/// teleported by a multi-second stall. Mirrors ACE's
/// `if (deltaTime > HugeQuantum) { … return false; }`
/// (`PhysicsObj.cs:4169-4173`). A 2.0 s frame (== HugeQuantum, not
/// strictly greater) is the boundary case that is still integrated.
#[test]
fn quantum_slices_drops_huge_quantum_hitch() {
    assert!(
        quantum_slices(HUGE_QUANTUM + 0.001).is_none(),
        "a frame just over HugeQuantum (2.0 s) must be dropped"
    );
    assert!(
        quantum_slices(2.5).is_none(),
        "a 2.5 s hitch must be dropped"
    );
    // The boundary itself is NOT dropped — 2.0 s subdivides into 20
    // MAX_QUANTUM slices.
    let boundary = quantum_slices(HUGE_QUANTUM)
        .expect("exactly HugeQuantum is the boundary, still integrated");
    assert_eq!(
        boundary.len(),
        20,
        "2.0 s ⇒ twenty 0.1 s slices, got {} slices",
        boundary.len()
    );
}

/// Gaps 1 + 7 — a 2.0 s simulated hitch produces a BOUNDED fall, not a
/// teleport. The subdivided + terminal-clamped loop must drop the
/// player far LESS than the unclamped 1st-order single step the
/// legacy path would produce (`z += (-9.8·dt)·dt` ≈ -39 m for a 2 s
/// step from rest). Distance is bounded by the terminal velocity:
/// even at the 50 m/s cap, 2 s of fall is at most ~100 m, and the
/// real subdivided fall is well under that.
#[test]
fn two_second_hitch_produces_bounded_fall_not_teleport() {
    let mut world = WorldState::synthetic();
    let (movement, start_pose) = seed_airborne_player(&mut world, Guid(0x5000_0AA0), 500.0);

    // 2.0 s == HugeQuantum: NOT dropped, subdivided into 20 slices.
    movement.advance_local_pose_for_manual_drive(&mut world, Duration::from_secs_f32(2.0));

    let after = world
        .local_player_runtime_pose()
        .expect("runtime pose seeded above");
    let drop = start_pose.coords.z - after.coords.z;

    // The fall must be DOWNWARD and bounded. Closed-form free fall over
    // 2 s with no clamp would be 0.5·9.8·4 ≈ 19.6 m; the terminal-
    // velocity clamp keeps per-slice speed within 50 m/s so the drop
    // can never exceed ~100 m. Assert it's a sane, bounded value.
    assert!(drop > 0.0, "player should fall downward, got drop={drop:.3} m");
    assert!(
        drop < 100.0,
        "a 2 s hitch must NOT teleport the player; drop should be bounded \
         (< 100 m), got {drop:.3} m"
    );
    // Velocity must be clamped to terminal (50 m/s) — never the
    // unbounded -19.6 m/s a single unclamped step would also produce,
    // but for a long fall the clamp is what matters.
    assert!(
        world.player.vertical_velocity.abs() <= MAX_VELOCITY + 1e-3,
        "vertical velocity must be terminal-clamped to <= {MAX_VELOCITY} m/s, got {:.3}",
        world.player.vertical_velocity
    );
}

/// Gaps 1 + 7 — terminal-velocity clamp. A very long subdivided fall
/// must clamp the total velocity magnitude to MAX_VELOCITY (50 m/s),
/// mirroring ACE's per-quantum `Velocity = Normalize(Velocity)·MaxVelocity`
/// (`PhysicsObj.cs:1843-1846`). Without the clamp, ~10 s of free fall
/// reaches ~98 m/s.
#[test]
fn terminal_velocity_clamps_vertical_speed_at_fifty() {
    let mut world = WorldState::synthetic();
    // Start very high so the (terrain-less) free fall never lands.
    let (movement, _start_pose) =
        seed_airborne_player(&mut world, Guid(0x5000_0AB0), 100_000.0);

    // Drive ~10 s of fall in 0.1 s frames (each a single MAX_QUANTUM
    // slice). Unclamped this would reach 9.8·10 = 98 m/s.
    for _ in 0..100 {
        movement.advance_local_pose_for_manual_drive(&mut world, Duration::from_secs_f32(0.1));
    }

    let vz = world.player.vertical_velocity;
    assert!(vz < 0.0, "player should be falling (negative vz), got {vz:.3}");
    assert!(
        vz.abs() <= MAX_VELOCITY + 1e-3,
        "fall speed must be clamped to terminal velocity {MAX_VELOCITY} m/s, got {:.4}",
        vz.abs()
    );
    // And it should have actually REACHED terminal (the planar run
    // component is small, so |vz| ≈ MAX_VELOCITY after the clamp
    // engages).
    assert!(
        vz.abs() > MAX_VELOCITY - 1.0,
        "after ~10 s the fall should be at (near) terminal velocity, got {:.4}",
        vz.abs()
    );
}

/// Gap 7 — 2nd-order airborne integration. With gravity carried as an
/// acceleration and the `0.5·a·t²` position term restored, a free
/// fall integrated as `n` slices of equal quantum must match the
/// closed form `z(t) = z0 - 0.5·9.8·t²` exactly (no clamp engaged at
/// these speeds), confirming the position uses the OLD velocity plus
/// the half-step before the velocity update. Mirrors ACE's
/// `movement = Acceleration*0.5*q*q + Velocity*q; Velocity += Acceleration*q`
/// (`PhysicsObj.cs:1854-1858`).
#[test]
fn second_order_airborne_matches_closed_form_half_a_t_squared() {
    let mut world = WorldState::synthetic();
    let start_z = 500.0_f32;
    let (movement, _start_pose) = seed_airborne_player(&mut world, Guid(0x5000_0AC0), start_z);

    // Integrate 1.0 s as ten MAX_QUANTUM (0.1 s) slices. At these
    // speeds (peak ~9.8 m/s) the terminal clamp never engages, so the
    // result is the pure 2nd-order free-fall arc.
    let n = 10;
    let q = 0.1_f32;
    for _ in 0..n {
        movement.advance_local_pose_for_manual_drive(&mut world, Duration::from_secs_f32(q));
    }

    let after = world
        .local_player_runtime_pose()
        .expect("runtime pose seeded above");
    let t = n as f32 * q; // 1.0 s
    let g = 9.8_f32;
    // Closed form for a 2nd-order (exact for constant acceleration,
    // independent of slice count) free fall from rest:
    //   z(t) = z0 - 0.5·g·t²
    let expected_z = start_z - 0.5 * g * t * t;
    assert!(
        (after.coords.z - expected_z).abs() < 1e-2,
        "2nd-order fall over {t:.2}s should land at z = z0 - 0.5·g·t² = {expected_z:.4}, \
         got {:.4} (Δ={:.5})",
        after.coords.z,
        (after.coords.z - expected_z).abs()
    );
    // Velocity should be exactly -g·t (1st-order in velocity).
    let expected_vz = -g * t;
    assert!(
        (world.player.vertical_velocity - expected_vz).abs() < 1e-3,
        "vertical velocity after {t:.2}s should be -g·t = {expected_vz:.4}, got {:.4}",
        world.player.vertical_velocity
    );
}

/// Gap 7 regression guard — the 2nd-order position term is what
/// distinguishes the new integrator from the old 1st-order symplectic
/// Euler. A single 0.1 s slice from rest must drop by the 2nd-order
/// amount `0.5·g·q²` (≈ 0.049 m), NOT the old symplectic-Euler amount
/// `(g·q)·q` = `g·q²` (≈ 0.098 m, since the old code updated velocity
/// first then used the NEW velocity for position).
#[test]
fn second_order_single_slice_uses_half_step_not_full_step() {
    let mut world = WorldState::synthetic();
    let start_z = 500.0_f32;
    let (movement, _start_pose) = seed_airborne_player(&mut world, Guid(0x5000_0AD0), start_z);

    let q = 0.1_f32;
    movement.advance_local_pose_for_manual_drive(&mut world, Duration::from_secs_f32(q));

    let after = world
        .local_player_runtime_pose()
        .expect("runtime pose seeded above");
    let g = 9.8_f32;
    let drop = start_z - after.coords.z;
    let second_order = 0.5 * g * q * q; // ~0.049 m
    let first_order = g * q * q; // ~0.098 m (old behaviour)
    assert!(
        (drop - second_order).abs() < 1e-4,
        "single-slice drop should be the 2nd-order 0.5·g·q² = {second_order:.5} m, \
         got {drop:.5} m (1st-order symplectic Euler would be {first_order:.5} m)"
    );
}

// ---------------------------------------------------------------------------
// Physics deep-dive 2026-06-01 — step-up / step-down (handoff gap 3).
// The grounded floor-snap path now follows small drops down within the
// per-object step-down height (1.5 m for the player body) and only falls
// off genuine ledges beyond it, replacing the legacy 0.5 m
// `LEDGE_FALL_THRESHOLD_M` heuristic when `USE_STEP_UP_DOWN` is set.
// These tests exercise the WIRED outdoor terrain path through
// `advance_local_pose_for_manual_drive`; the pure threshold decisions
// are unit-tested in `holtburger-world` `spatial::physics::tests`.
// ---------------------------------------------------------------------------

/// Seed a grounded outdoor player whose retained Z sits `drop` metres
/// above a uniform terrain plane, then run one grounded run-forward
/// tick. Returns the post-tick pose plus the airborne flag so the
/// caller can assert snap-down vs. fall. The heightmap is uniform so
/// the move direction is irrelevant — only the retained-Z-vs-terrain
/// delta drives the step-down decision.
fn run_grounded_step_down_tick(guid: Guid, retained_z: f32, terrain_z: f32) -> (WorldPosition, bool) {
    let mut world = WorldState::synthetic();
    world.player.guid = guid;
    let _capabilities = seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);
    // Landblock 0xA9B4 is outdoor (low 16 bits 0x0001 < 0x0100); place
    // the player mid-LB so the move doesn't rebucket. Retained Z is set
    // ABOVE the terrain so the floor snap sees a descent this tick.
    let start_pose = WorldPosition {
        landblock_id: Guid(0xA9B40001),
        coords: Vector3::new(100.0, 100.0, retained_z),
        rotation: Quaternion::identity(),
    };
    seed_local_player(&mut world, guid, start_pose);
    let _ = world.set_player_position(start_pose);
    // Uniform terrain plane under the whole landblock (0xA9B4_0000 is
    // the LB key used by `terrain_height_at`, derived from the high
    // word of the landblock id).
    world.populate_terrain_heights(0xA9B4_0000, [terrain_z; 81]);
    // Grounded forward run (a freshly seeded player is not airborne).
    assert!(
        !world.player.is_airborne,
        "freshly seeded player should be grounded for the step-down path"
    );

    let mut movement = MovementSystem::new();
    movement.active_drive = Some(ActiveDriveState::manual(
        MotionState::builder().run().forward().build(),
        None,
    ));
    movement.advance_local_pose_for_manual_drive(&mut world, Duration::from_millis(100));

    let after = world
        .local_player_runtime_pose()
        .expect("runtime pose seeded above");
    (after, world.player.is_airborne)
}

/// Gap 3 — a drop within `PLAYER_STEP_DOWN_HEIGHT` (1.5 m) snaps the
/// feet down to follow the surface and keeps the player grounded,
/// rather than going ballistic at the legacy 0.5 m threshold. A 1.2 m
/// drop is beyond the old 0.5 m fall threshold but within the player's
/// 1.5 m step-down, so it must SNAP (not fall).
#[test]
fn step_down_within_step_height_snaps_and_stays_grounded() {
    let retained_z = 10.0_f32;
    let terrain_z = 8.8_f32; // 1.2 m drop: > 0.5 (old) but <= 1.5 (step-down)
    let (after, airborne) = run_grounded_step_down_tick(Guid(0x5000_03D0), retained_z, terrain_z);
    assert!(
        !airborne,
        "a {:.1} m drop is within the 1.5 m step-down and must NOT trigger a fall",
        retained_z - terrain_z
    );
    assert!(
        (after.coords.z - terrain_z).abs() < 1e-3,
        "step-down must snap Z to the terrain ({terrain_z:.3}), got {:.3}",
        after.coords.z
    );
}

/// Gap 3 — a drop beyond `PLAYER_STEP_DOWN_HEIGHT` (1.5 m) is a real
/// ledge: the player begins a fall and Z is left for the gravity
/// integrator (not snapped to the distant terrain). A 2.5 m drop must
/// FALL.
#[test]
fn step_down_beyond_step_height_falls_off_ledge() {
    let retained_z = 10.0_f32;
    let terrain_z = 7.5_f32; // 2.5 m drop: > 1.5 step-down → ledge
    let (after, airborne) = run_grounded_step_down_tick(Guid(0x5000_03D1), retained_z, terrain_z);
    assert!(
        airborne,
        "a {:.1} m drop exceeds the 1.5 m step-down and must trigger a fall",
        retained_z - terrain_z
    );
    // Z must NOT have been snapped down to the far terrain — the
    // gravity integrator owns the drop from here. The first airborne
    // slice applies a tiny 2nd-order drop (~sub-cm at 100 ms), so the
    // pose stays near the retained Z, far above the 7.5 m terrain.
    assert!(
        after.coords.z > terrain_z + 1.0,
        "ledge fall must leave Z near the retained height ({retained_z:.1}), not snap to \
         the {terrain_z:.1} m terrain; got {:.3}",
        after.coords.z
    );
}

// ---- edge_slide (gap 3 follow-up, 2026-06-01) ----

/// Gap 3 follow-up — `edge_slide_refused_step_up` slides the blocked
/// residual along the wall tangent when the player allows edge-slide and
/// a wall normal is available. The full requested move was +X (into an
/// +X-facing wall, normal `-X`) plus +Y (along the wall); the clamp
/// stopped the +X portion. edge_slide must recover the +Y travel the
/// step-up refusal would otherwise have dropped, while keeping the X at
/// the clamped value.
#[test]
fn edge_slide_recovers_tangent_travel_on_refused_step_up() {
    assert!(USE_EDGE_SLIDE, "this test assumes the default-on flag");
    // Player wants to move (0.4 into wall, 0.3 along wall).
    let lateral = Vector3::new(0.4, 0.3, 0.0);
    // The wall clamp stopped all +X and (since the wall is X-facing,
    // the single-iteration slide already kept Y) — model the worst case
    // where the step-up path only has the stopped-dead clamp to work
    // with: clamped to (0.05, 0.0) say, as if blocked early.
    let lateral_clamped = Vector3::new(0.05, 0.0, 0.0);
    let normal = Vector3::new(-1.0, 0.0, 0.0); // points back toward player
    // `None` N_last ⇒ the cliff_slide path can't engage; this exercises
    // the Stage-1 single-plane tangent slide (also default since
    // `USE_CLIFF_SLIDE` is off).
    let slid = edge_slide_refused_step_up(lateral, lateral_clamped, Some(normal), None, true);
    // Residual = lateral - clamped = (0.35, 0.3, 0); slid along tangent
    // drops the X (into-wall) component, keeping +Y. So slid = clamped +
    // (0, 0.3, 0) = (0.05, 0.3, 0).
    assert!((slid.x - 0.05).abs() < 1e-6, "X must stay clamped, got {}", slid.x);
    assert!((slid.y - 0.3).abs() < 1e-6, "tangent +Y must be recovered, got {}", slid.y);
}

/// Gap 3 follow-up — when the player does NOT allow edge-slide
/// (`allow_edge_slide == false`, retail's missing `EdgeSlide` flag), the
/// refused step-up just stops dead at the clamped delta (no tangent
/// recovery).
#[test]
fn edge_slide_disabled_when_flag_clear_stops_dead() {
    let lateral = Vector3::new(0.4, 0.3, 0.0);
    let lateral_clamped = Vector3::new(0.05, 0.0, 0.0);
    let normal = Vector3::new(-1.0, 0.0, 0.0);
    let slid = edge_slide_refused_step_up(lateral, lateral_clamped, Some(normal), None, false);
    assert_eq!(
        slid, lateral_clamped,
        "with AllowEdgeSlide clear the refused step-up must stop dead"
    );
}

/// Gap 3 follow-up — with no wall normal available (the move was blocked
/// by entity collision or the AABB safety net, neither of which exposes
/// a normal yet) edge_slide has no tangent to slide along, so it falls
/// back to the clamped delta even when the flag is set.
#[test]
fn edge_slide_no_normal_stops_dead() {
    let lateral = Vector3::new(0.4, 0.3, 0.0);
    let lateral_clamped = Vector3::new(0.05, 0.0, 0.0);
    let slid = edge_slide_refused_step_up(lateral, lateral_clamped, None, None, true);
    assert_eq!(
        slid, lateral_clamped,
        "without a wall normal there is no tangent to slide along"
    );
}

// ---- cliff_slide Stage-2 (seam-skid, USE_CLIFF_SLIDE, 2026-06-01) ----
//
// `edge_slide_refused_step_up` is the integration point: with
// `USE_CLIFF_SLIDE` ON and BOTH a current wall normal (N_new) and a
// previously-tracked one (N_last) present, a refused step-up rides the
// SEAM between the two non-coplanar walls instead of the single wall.
// These tests gate on `USE_CLIFF_SLIDE` so they assert the right thing
// whether the flag is default-off (the shipped state) or flipped on for
// validation.

/// Stage-2 — with the flag ON, two PERPENDICULAR tilted walls meeting in
/// a concave corner make the refused step-up ride the 45-degree seam.
/// `N_new` is the +X-facing tilted wall, `N_last` (from the prior slice)
/// the +Y-facing tilted wall. The blocked residual is redistributed
/// along the corner seam (a 45-degree XY direction). When the flag is
/// OFF (the default) the SAME call falls through to the Stage-1
/// single-plane slide — so we assert the flag-appropriate outcome.
#[test]
fn cliff_slide_rides_seam_when_flag_on() {
    let lateral = Vector3::new(0.4, 0.4, 0.0);
    // Clamp stopped most of the move at the first (X) wall.
    let lateral_clamped = Vector3::new(0.05, 0.05, 0.0);
    // N_new: this slice's +X-facing wall, tilted back (carries +Z).
    let n_new = Vector3::new(-1.0, 0.0, 0.5).normalize();
    // N_last: prior slice's +Y-facing wall, tilted back.
    let n_last = Vector3::new(0.0, -1.0, 0.5).normalize();

    let slid =
        edge_slide_refused_step_up(lateral, lateral_clamped, Some(n_new), Some(n_last), true);
    let residual = lateral - lateral_clamped;

    if USE_CLIFF_SLIDE {
        // The seam-skid result must equal clamped + the seam projection.
        let seam_skid =
            holtburger_world::spatial::cliff_slide_residual_along_seam(residual, n_new, n_last)
                .expect("non-degenerate corner seam");
        let expected = lateral_clamped + seam_skid;
        assert!(
            (slid.x - expected.x).abs() < 1e-6 && (slid.y - expected.y).abs() < 1e-6,
            "flag-on must ride the seam: got {slid:?} expected {expected:?}"
        );
    } else {
        // Flag off ⇒ Stage-1 single-plane tangent slide on N_new.
        let stage1 = lateral_clamped
            + holtburger_world::spatial::slide_residual_along_wall_tangent(residual, n_new);
        assert!(
            (slid.x - stage1.x).abs() < 1e-6 && (slid.y - stage1.y).abs() < 1e-6,
            "flag-off must use Stage-1 slide: got {slid:?} expected {stage1:?}"
        );
    }
}

/// Stage-2 — NEAR-PARALLEL walls (degenerate seam): even with the flag
/// ON, `cliff_slide_residual_along_seam` returns `None`, so
/// `edge_slide_refused_step_up` falls back to the Stage-1 single-plane
/// slide on `N_new`. The two normals are identical (same plane), so the
/// cross product is zero ⇒ no seam.
#[test]
fn cliff_slide_falls_back_to_stage1_on_parallel_walls() {
    let lateral = Vector3::new(0.4, 0.3, 0.0);
    let lateral_clamped = Vector3::new(0.05, 0.0, 0.0);
    let normal = Vector3::new(-1.0, 0.0, 0.0);
    // N_last identical to N_new ⇒ degenerate seam.
    let slid = edge_slide_refused_step_up(
        lateral,
        lateral_clamped,
        Some(normal),
        Some(normal),
        true,
    );
    // Regardless of the flag, the outcome is the Stage-1 tangent slide:
    // flag-off skips cliff_slide entirely; flag-on tries it, gets None,
    // and falls back to the same Stage-1 path.
    let residual = lateral - lateral_clamped;
    let stage1 = lateral_clamped
        + holtburger_world::spatial::slide_residual_along_wall_tangent(residual, normal);
    assert!(
        (slid.x - stage1.x).abs() < 1e-6 && (slid.y - stage1.y).abs() < 1e-6,
        "near-parallel walls must fall back to Stage-1: got {slid:?} expected {stage1:?}"
    );
}

/// Stage-2 — N_last ABSENT (first wall this run): with no previously-
/// tracked plane the cliff_slide path can't engage even with the flag
/// ON, so `edge_slide_refused_step_up` uses the Stage-1 single-plane
/// slide. Mirrors retail before `InitLastKnownContactPlane` has stamped
/// a first plane.
#[test]
fn cliff_slide_no_last_normal_uses_stage1() {
    let lateral = Vector3::new(0.4, 0.3, 0.0);
    let lateral_clamped = Vector3::new(0.05, 0.0, 0.0);
    let n_new = Vector3::new(-1.0, 0.0, 0.5).normalize();
    // N_last absent.
    let slid = edge_slide_refused_step_up(lateral, lateral_clamped, Some(n_new), None, true);
    let residual = lateral - lateral_clamped;
    let stage1 = lateral_clamped
        + holtburger_world::spatial::slide_residual_along_wall_tangent(residual, n_new);
    assert!(
        (slid.x - stage1.x).abs() < 1e-6 && (slid.y - stage1.y).abs() < 1e-6,
        "absent N_last must use Stage-1: got {slid:?} expected {stage1:?}"
    );
}

// ---- CalcNumSteps substepping (cell-wall sweep, 2026-06-01) ----
//
// These exercise `clamp_delta_against_cell_walls_substepped` DIRECTLY
// (independent of the `USE_SUBSTEP_TRANSITION` dispatch flag, which only
// chooses whether the public wrappers + the integrator route through it).
// They validate (a) straight-wall parity, (b) concave-corner two-wall
// slide, (c) the `CalcNumSteps` math.

/// A floor-to-ceiling wall in the plane `x = wall_x`, +X-facing, tall Z
/// range + wide Y footprint. `normal.z == 0` ⇒ classifies as a wall.
fn substep_x_wall(wall_x: f32) -> holtburger_common::Triangle {
    holtburger_common::Triangle::new(
        Vector3::new(wall_x, -10.0, -1.0),
        Vector3::new(wall_x, 10.0, -1.0),
        Vector3::new(wall_x, -10.0, 3.0),
    )
}

/// A floor-to-ceiling wall in the plane `y = wall_y`, +Y-facing.
fn substep_y_wall(wall_y: f32) -> holtburger_common::Triangle {
    holtburger_common::Triangle::new(
        Vector3::new(-10.0, wall_y, -1.0),
        Vector3::new(10.0, wall_y, -1.0),
        Vector3::new(-10.0, wall_y, 3.0),
    )
}

/// Landblock `0x0000` so `global_coords() == local coords` — the wall
/// triangles above are authored in the same near-origin frame.
fn substep_pose(x: f32, y: f32) -> WorldPosition {
    WorldPosition {
        landblock_id: Guid(0x0000_0000),
        coords: Vector3::new(x, y, 0.0),
        rotation: Quaternion::from_heading(0.0),
    }
}

/// (a) Straight-wall parity — sub-segmenting a move that runs PARALLEL to
/// a single flat wall (so each sub-segment slides along the same tangent)
/// lands at the SAME place as one single-pass clamp. A long +Y move that
/// grazes an +X-facing wall it is already touching: the wall removes the
/// (zero) into-wall component each step, so substepped == single-pass.
#[test]
fn substep_straight_wall_matches_single_pass() {
    let r = holtburger_world::spatial::PLAYER_CAPSULE_RADIUS; // 0.4
    let h = holtburger_world::spatial::PLAYER_CAPSULE_HEIGHT;
    let tris = [substep_x_wall(0.4)]; // wall at x = radius
    // Start with the capsule centre at x=0, exactly `radius` from the
    // wall (just touching its shell), moving a long +Y (1.2 m ⇒ 3 steps)
    // with a tiny +X bias into the wall.
    let pose = substep_pose(0.0, 0.0);
    let delta = Vector3::new(0.05, 1.2, 0.0);
    let (multi, _n_multi) =
        holtburger_world::spatial::clamp_delta_against_cell_walls_substepped(
            &tris, &pose, delta, r, h, &[],
        );
    let (single, _n_single) =
        holtburger_world::spatial::clamp_delta_against_cell_walls_with_normal(
            &tris, &pose, delta, r, h, &[],
        );
    // Sanity: this delta really is subdivided (>1 step), so we are
    // comparing the LOOP against the single pass, not a 1-step delegate.
    let lateral_len = (delta.x * delta.x + delta.y * delta.y).sqrt();
    assert!(
        holtburger_world::spatial::cell_wall_substep_count(lateral_len, r) > 1,
        "straight-wall parity test must actually subdivide"
    );
    assert!(
        (multi.x - single.x).abs() < 1e-3 && (multi.y - single.y).abs() < 1e-3,
        "substepped slide along a single flat wall must match single-pass: \
         multi={multi:?} single={single:?}"
    );
}

/// (b) Concave (L-shaped) corner — a long diagonal into the inside corner
/// of two perpendicular walls.
///
/// A single iteration of the swept-circle clamp only registers a wall hit
/// when the capsule centre STARTS within the radius shell or CROSSES the
/// wall plane during the sweep — a diagonal that merely *approaches* both
/// walls from the same side without crossing either plane registers no
/// hit at all, so the single pass marches STRAIGHT INTO the corner
/// (penetrating both walls). Substepping advances a working pose between
/// equal sub-segments, so by the time a sub-segment STARTS inside wall
/// A's shell it clamps + slides along wall A — recovering the slide the
/// single pass misses entirely. The substepped result therefore ends up
/// clamped on the first wall it reaches (sliding along it) where the
/// single pass tunnels through to the corner.
///
/// NOTE (honest scope): driving the residual cleanly along the SECOND
/// wall of the corner too (so the final centre respects BOTH walls to
/// `2 - radius`) needs the cross-product two-plane `cliff_slide` skid
/// — that is the explicitly DEFERRED follow-up wired off the
/// `last_normal` accumulation hook (see the TODO in
/// `clamp_delta_against_cell_walls_substepped`). This test pins the slice
/// that IS landed: substepping engages a wall the single pass misses.
#[test]
fn substep_concave_corner_slides_along_both_walls() {
    let r = holtburger_world::spatial::PLAYER_CAPSULE_RADIUS; // 0.4
    let h = holtburger_world::spatial::PLAYER_CAPSULE_HEIGHT;
    // Corner at (x=2, y=2): +X-facing wall at x=2 and +Y-facing wall at
    // y=2 enclose the +X/+Y quadrant's inside corner. The capsule lives
    // at small (x,y) and drives a long diagonal toward the corner.
    let tris = [substep_x_wall(2.0), substep_y_wall(2.0)];
    let pose = substep_pose(0.0, 0.0);
    // Long diagonal into the corner (≈2.83 m ⇒ ceil(2.83/0.4)=8 steps).
    let delta = Vector3::new(2.0, 2.0, 0.0);
    let lateral_len = (delta.x * delta.x + delta.y * delta.y).sqrt();
    assert!(
        holtburger_world::spatial::cell_wall_substep_count(lateral_len, r) > 1,
        "concave-corner test must subdivide"
    );

    let (single, _ns) =
        holtburger_world::spatial::clamp_delta_against_cell_walls_with_normal(
            &tris, &pose, delta, r, h, &[],
        );
    let (multi, n_multi) =
        holtburger_world::spatial::clamp_delta_against_cell_walls_substepped(
            &tris, &pose, delta, r, h, &[],
        );

    let single_end_x = pose.coords.x + single.x;
    let single_end_y = pose.coords.y + single.y;
    let multi_end_x = pose.coords.x + multi.x;
    let multi_end_y = pose.coords.y + multi.y;
    let limit = 2.0 - r + 1e-2; // centre must stay this side of each wall

    // The single pass tunnels straight into the corner: it never engages
    // either wall (no plane crossing, no start-inside-shell) and lands at
    // ~(2,2), penetrating BOTH walls. This is the gap the substep loop
    // closes.
    assert!(
        single_end_x > limit && single_end_y > limit,
        "single-pass should tunnel into the concave corner (penetrate both \
         walls): end=({single_end_x:.3},{single_end_y:.3}) limit={limit:.3}"
    );

    // Substepping engages wall A (the X-facing wall): a sub-segment that
    // starts inside its radius shell clamps + slides, so the substepped
    // X ends meaningfully SHORT of the single-pass X (which tunnelled to
    // the corner). I.e. the substep slid along a wall the single pass
    // missed entirely.
    assert!(
        multi_end_x < single_end_x - 0.1,
        "substepping must engage + slide along the first wall (X) the single \
         pass tunnels through: multi=({multi_end_x:.3},{multi_end_y:.3}) \
         single=({single_end_x:.3},{single_end_y:.3})"
    );
    // And it surfaces that wall's normal (the LastKnownContactPlane hook
    // for the deferred cliff_slide skid).
    let n = n_multi.expect("substepping into the corner must surface a wall normal");
    assert!(
        n.z.abs() < 1e-6,
        "wall normal must be flattened to XY, got {n:?}"
    );
}

/// (c) `CalcNumSteps` math (retail non-viewer rule, radius 0.4): a 0.3 m
/// lateral move is `0.3/0.4 = 0.75 <= 1` ⇒ 1 step; a 1.0 m lateral move
/// is `1.0/0.4 = 2.5 > 1` ⇒ `ceil(2.5) = 3` steps. A sub-EPSILON move ⇒
/// 0 steps.
#[test]
fn substep_calc_num_steps_math() {
    let r = holtburger_world::spatial::PLAYER_CAPSULE_RADIUS; // 0.4
    assert_eq!(
        holtburger_world::spatial::cell_wall_substep_count(0.3, r),
        1,
        "0.3 m / 0.4 = 0.75 <= 1 ⇒ a single sub-segment"
    );
    assert_eq!(
        holtburger_world::spatial::cell_wall_substep_count(1.0, r),
        3,
        "1.0 m / 0.4 = 2.5 > 1 ⇒ ceil(2.5) = 3 sub-segments"
    );
    assert_eq!(
        holtburger_world::spatial::cell_wall_substep_count(1e-6, r),
        0,
        "a sub-EPSILON move has no lateral motion to subdivide ⇒ 0 steps"
    );
}

// ---- step-UP (gap 3, WIRED) ----------------------------------------------
//
// The pure `step_up_decision` threshold is unit-tested in `holtburger-world`
// `spatial::physics::tests`, and the WIRED step-DOWN path is covered above
// (`step_down_*`). These two tests close the remaining gap: the WIRED step-UP
// path through `advance_local_pose_for_manual_drive`, where a blocked grounded
// run probes the floor at the intended (un-clamped) destination and either
// climbs onto a short riser (rise <= `PLAYER_STEP_UP_HEIGHT`) or stays blocked
// against a tall one.
//
// Harness note: the capsule radius (0.4) is essentially the per-tick run move
// (~0.43 m at steady state), so a HARD lateral block makes the buggy/fixed
// intended-destination converge — there is no clean differential off the
// blocked clamp alone. Instead we build a ROBUST setup: the lateral block
// comes from the cell-AABB inset (the player starts pinned to the +Y inset
// edge so a forward +Y run is fully clamped), and a SEPARATE near-flat riser
// floor triangle sits ONLY over the +Y intended destination (never under the
// start XY, so the start floor-snap can't pre-lift the player). The riser top
// is the only thing that distinguishes a climb from a stay-blocked, so the
// assertions key off Z rising AND the full lateral being taken vs. the
// zero-lateral blocked clamp.

/// Build an indoor cell where a grounded forward run is laterally blocked by
/// the cell-AABB inset, with a near-flat riser floor triangle whose top sits
/// `rise` metres above the player's feet over the intended (un-clamped)
/// destination. Seeds the local player at steady-state forward velocity, drives
/// ONE grounded 100 ms run tick, and returns `(start_pose, after_pose,
/// airborne)`.
///
/// Geometry. The identity rotation reads as heading 90° (North) via
/// `Quaternion::to_heading`, so the forward run drives world +Y, per
/// `planar_velocity_for_heading(π/2, v) = (-cos 90·v, sin 90·v, 0) = (0, v, 0)`:
///   - Player local `(50, 50, 2.0)` in cell `0x86020100` (indoor: low word
///     `0x0100`). `global = (0x86*192+50, 0x02*192+50, 2.0)`.
///   - Cell AABB `max.y = global.y + radius` so the inset max.y lands exactly
///     on the player's Y: any +Y move clamps to zero (full block ⇒ `blocked`).
///   - Riser triangle: a flat horizontal floor at `z = feet + rise` whose XY
///     footprint covers only `[global.y + 0.2, global.y + 2.0]` (strictly +Y of
///     the start), so it is the floor at the intended destination but NOT under
///     the start — the start keeps its retained Z.
fn run_grounded_step_up_tick(guid: Guid, rise: f32) -> (WorldPosition, WorldPosition, bool) {
    let mut world = WorldState::synthetic();
    world.player.guid = guid;
    let _capabilities = seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);

    // Indoor cell (low word 0x0100 ⇒ `is_indoors()`); `current_cell` falls
    // back to `landblock_id.0` when 3D-AABB containment misses, so keying the
    // AABB + triangles under this same id keeps the floor probe robust even
    // after the climb lifts the player's Z above the cell box.
    let cell_landblock = Guid(0x8602_0100);
    let cell_id = u32::from(cell_landblock);

    let feet_z = 2.0_f32;
    let start_pose = WorldPosition {
        landblock_id: cell_landblock,
        coords: Vector3::new(50.0, 50.0, feet_z),
        rotation: Quaternion::identity(),
    };
    let global = start_pose.global_coords();
    seed_local_player(&mut world, guid, start_pose);
    let _ = world.set_player_position(start_pose);

    let radius = holtburger_world::spatial::PLAYER_CAPSULE_RADIUS; // 0.4
    // AABB whose inset max.y (= max.y - radius) lands on the player's Y, so a
    // forward +Y run is clamped to zero. min.z well below feet (so the
    // lower-bound safety snap never fires); max.z tall (no ceiling clamp).
    let cell_aabb = holtburger_common::Aabb {
        min: holtburger_common::Vector3::new(global.x - 5.0, global.y - 5.0, 0.0),
        max: holtburger_common::Vector3::new(global.x + 5.0, global.y + radius, 10.0),
    };
    world.scene.insert_cell_aabb(cell_id, cell_aabb);

    // Near-flat riser: a horizontal floor (normal ≈ (0,0,1), so the wall clamp
    // skips it and the floor probe accepts it) at z = feet + rise, covering
    // only the +Y destination strip. Two triangles make a rectangle spanning
    // global.y ∈ [global.y + 0.2, global.y + 2.0], global.x ∈ [global.x - 2,
    // global.x + 2] — the intended dest (global.x, ~global.y + 0.43) lands
    // inside, the start (global.x, global.y) does not.
    let riser_z = feet_z + rise;
    let y_near = global.y + 0.2;
    let y_far = global.y + 2.0;
    let x_lo = global.x - 2.0;
    let x_hi = global.x + 2.0;
    let v00 = holtburger_common::Vector3::new(x_lo, y_near, riser_z);
    let v10 = holtburger_common::Vector3::new(x_hi, y_near, riser_z);
    let v11 = holtburger_common::Vector3::new(x_hi, y_far, riser_z);
    let v01 = holtburger_common::Vector3::new(x_lo, y_far, riser_z);
    world
        .scene
        .insert_cell_triangle(cell_id, holtburger_common::Triangle::new(v00, v10, v11));
    world
        .scene
        .insert_cell_triangle(cell_id, holtburger_common::Triangle::new(v00, v11, v01));

    // Steady-state forward velocity so the requested lateral move is a healthy
    // ~0.43 m (not the ~0.08 m of a cold-start ramp tick) — the blocked gap is
    // then unambiguously a wall, not slide jitter. Forward run ⇒ +Y.
    world.player.current_planar_velocity = holtburger_common::Vector3::new(0.0, 4.5, 0.0);
    assert!(
        !world.player.is_airborne,
        "freshly seeded player must be grounded for the step-up path"
    );

    let mut movement = MovementSystem::new();
    movement.active_drive = Some(ActiveDriveState::manual(
        MotionState::builder().run().forward().build(),
        None,
    ));
    movement.advance_local_pose_for_manual_drive(&mut world, Duration::from_millis(100));

    let after = world
        .local_player_runtime_pose()
        .expect("runtime pose seeded above");
    (start_pose, after, world.player.is_airborne)
}

/// Gap 3 (WIRED step-UP) — a grounded run blocked laterally by a riser whose
/// walkable top is within `PLAYER_STEP_UP_HEIGHT` (0.6 m) of the feet CLIMBS:
/// the player's Z rises onto the riser AND the full intended lateral move is
/// taken (more than the zero-lateral blocked clamp alone would allow). Mirrors
/// retail `Transition.StepUp`.
#[test]
fn step_up_within_step_height_climbs_riser_through_integrator() {
    assert!(
        USE_STEP_UP_DOWN,
        "this test pins the default-on step-up/step-down path"
    );
    let rise = 0.5_f32; // <= PLAYER_STEP_UP_HEIGHT (0.6) ⇒ climb
    assert!(
        rise <= holtburger_world::spatial::PLAYER_STEP_UP_HEIGHT,
        "test riser must be within the step-up height"
    );
    let (start, after, airborne) = run_grounded_step_up_tick(Guid(0x5000_03E0), rise);

    // Climbing is a ground action — the player stays grounded.
    assert!(!airborne, "step-up must not go airborne; got airborne={airborne}");

    // Z rose onto the riser top (feet + rise), within the 5 mm floor-snap
    // headroom the indoor snap adds after the climb.
    let expected_z = start.coords.z + rise;
    assert!(
        (after.coords.z - (expected_z + 0.005)).abs() < 5e-3,
        "step-up must raise Z onto the riser top (~{:.3}); got {:.3}",
        expected_z + 0.005,
        after.coords.z
    );

    // Lateral: the player took the FULL intended +Y move, not the zero-lateral
    // blocked clamp. Steady-state run ⇒ ~0.43 m of +Y travel; require a clear,
    // unambiguous slice (well above the slide-jitter floor) so this can't pass
    // on a stopped-dead block.
    let lateral_moved = after.coords.y - start.coords.y; // forward run is +Y
    assert!(
        lateral_moved > 0.2,
        "climb must take the full intended lateral move (~0.43 m +Y), not the \
         zero-lateral blocked clamp; Δy = {lateral_moved:.4}"
    );

    // X is unchanged (pure forward run, no strafe).
    assert!(
        (after.coords.x - start.coords.x).abs() < 1e-3,
        "forward-only run must not drift X; got Δx = {:.4}",
        after.coords.x - start.coords.x
    );
}

/// Gap 3 (WIRED step-UP) — a riser TALLER than `PLAYER_STEP_UP_HEIGHT` (0.6 m)
/// is a real wall: the step-up is refused, and with the lateral block coming
/// from the AABB (which surfaces no wall normal) the refused move stops dead.
/// The player neither climbs (Z stays at the feet) nor advances laterally (the
/// blocked clamp is zero), mirroring retail's `Transition.StepUp` cap at
/// `ObjectInfo.StepUpHeight`.
#[test]
fn step_up_beyond_step_height_stays_blocked_through_integrator() {
    let rise = 0.9_f32; // > PLAYER_STEP_UP_HEIGHT (0.6) ⇒ refused
    assert!(
        rise > holtburger_world::spatial::PLAYER_STEP_UP_HEIGHT,
        "test riser must exceed the step-up height"
    );
    let (start, after, airborne) = run_grounded_step_up_tick(Guid(0x5000_03E1), rise);

    // Refused step-up is a ground interaction, not a fall.
    assert!(!airborne, "refused step-up must not go airborne; got airborne={airborne}");

    // Z did NOT climb onto the tall riser — the riser top (feet + 0.9) is
    // above the step-up ceiling, so the floor probe rejects it and Z stays at
    // the feet (no per-poly floor under the start to snap to either).
    assert!(
        (after.coords.z - start.coords.z).abs() < 1e-3,
        "a riser taller than the step-up height must NOT climb: Z should stay \
         at the feet ({:.3}); got {:.3}",
        start.coords.z,
        after.coords.z
    );

    // Lateral stayed blocked: the AABB clamp zeroed the +Y move and, with no
    // wall normal, the refused step-up stopped dead (no tangent recovery).
    let lateral_moved = (after.coords.y - start.coords.y).abs();
    assert!(
        lateral_moved < 0.05,
        "a refused step-up against the AABB block must stop dead laterally; \
         |Δy| = {lateral_moved:.4}"
    );
}

// ---- precipice_slide re-entry backup-pose (USE_PRECIPICE_SLIDE_REENTRY,
//      2026-06-02) ----
//
// This slice lands the save/clear backup-pose bookkeeping only (the
// restore -> precipice-slide re-attempt consumer is a documented
// follow-on). These tests verify (1) the new flag ships default-OFF so
// the shipped solver is byte-identical, (2) the new PlayerState field
// defaults to None at spawn, and (3) the field round-trips a saved pose.

#[test]
fn test_precipice_slide_reentry_flag_is_default_off() {
    // The shipped solver must be byte-identical: the backup-pose
    // save/clear machinery is fully gated behind this const, which must
    // remain false until the restore consumer lands and is validated.
    assert!(
        !USE_PRECIPICE_SLIDE_REENTRY,
        "USE_PRECIPICE_SLIDE_REENTRY must ship default-OFF (byte-identical \
         solver); flip it on only with the restore consumer wired"
    );
}

#[test]
fn test_backup_pose_for_step_down_defaults_to_none() {
    let player = holtburger_world::player::PlayerState::new();
    assert!(
        player.backup_pose_for_step_down.is_none(),
        "backup_pose_for_step_down must default to None at spawn"
    );
    // Default::default() must match new() for this field.
    let player_default = holtburger_world::player::PlayerState::default();
    assert!(player_default.backup_pose_for_step_down.is_none());
}

#[test]
fn test_backup_pose_for_step_down_set_and_clear_round_trip() {
    let mut player = holtburger_world::player::PlayerState::new();
    let pose = WorldPosition {
        landblock_id: Guid::NULL,
        coords: Vector3::new(12.0, 34.0, 56.0),
        rotation: Quaternion::identity(),
    };

    // Save-before-descend.
    player.backup_pose_for_step_down = Some(pose);
    assert_eq!(
        player.backup_pose_for_step_down,
        Some(pose),
        "the saved backup pose must round-trip unchanged"
    );

    // Clear-on-resolution.
    player.backup_pose_for_step_down = None;
    assert!(
        player.backup_pose_for_step_down.is_none(),
        "clearing the backup pose must restore None"
    );
}
