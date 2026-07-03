use super::super::common::{
    AUTONOMOUS_POSITION_HEARTBEAT_INTERVAL, HUGE_QUANTUM, MAX_QUANTUM, MAX_VELOCITY,
    PLAYER_GROUND_FRICTION_PER_SEC, PLAYER_LATERAL_ACCELERATION_CAP_M_PER_SEC_SQ,
    TURN_RIGHT_MOTION_COMMAND, WALK_FORWARD_MOTION_COMMAND, WIRE_TURN_SPEED_BASE,
    build_autonomous_position, build_motion_state_raw_motion_state,
    raw_motion_state_with_motion_style,
};
use super::*;
use crate::client::movement_types::{Gait, SidestepLocomotion};
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

fn seed_player_run_skill(world: &mut WorldState, run_skill: u32) {
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
    // F1-3 (movement bughunt 2026-06-09): the wire turn speed is the BASE
    // scalar (1.0) for BOTH gaits — ACE applies RunTurnFactor itself from
    // turn_hold_key=Run (`MotionInterp.cs:546-548`). The old pre-multiplied
    // 1.5 made ACE apply the factor twice (2.25× for observers).
    assert_eq!(raw_motion_state.turn_speed, Some(WIRE_TURN_SPEED_BASE));
    assert_eq!(
        raw_motion_state.turn_hold_key,
        Some(HoldKey::Run as u32),
        "run factor rides the hold key, not the speed",
    );
}

#[test]
fn motion_state_raw_motion_state_run_forward_is_walk_forward_plus_hold_key() {
    let mut world = WorldState::synthetic();
    seed_player_run_skill(&mut world, 300);

    let raw_motion_state = build_motion_state_raw_motion_state(
        &world,
        MotionState::builder().run().forward().build(),
        MotionStyle::PreserveServer,
    );

    // F5-2/F2-1 (movement bughunt 2026-06-09): forward + Run emits
    // `WalkForward` + `HoldKey=Run` + speed 1.0 — retail's raw encoding,
    // and the ONLY one ACE's broadcast converter attaches `GetRunRate` to
    // (`MovementData.cs:99-117`). The old raw `RunForward (0x44000007)`
    // fell through the converter's `else` branch: observers received the
    // runner at implicit ForwardSpeed 1.0 (base 4 m/s) and rubber-banded
    // on every heartbeat. The run rate itself never goes on the wire.
    assert_eq!(
        raw_motion_state.forward_command,
        Some(WALK_FORWARD_MOTION_COMMAND)
    );
    assert_ne!(
        raw_motion_state.forward_command,
        Some(0x4400_0007),
        "raw RunForward must never be emitted (F5-2)",
    );
    assert_eq!(raw_motion_state.forward_hold_key, Some(HoldKey::Run as u32));
    assert_eq!(raw_motion_state.forward_speed, Some(1.0));
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
    // F1-3 (movement bughunt 2026-06-09): base scalar 1.0 negated — the
    // run factor rides turn_hold_key=Run; ACE applies it server-side.
    assert_eq!(
        raw_motion_state.turn_speed,
        Some(-WIRE_TURN_SPEED_BASE),
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
fn motion_state_raw_motion_state_emits_turn_while_moving() {
    // F2-4 (movement bughunt 2026-06-09) — the turn fields are RAW INPUT
    // state, emitted independent of forward/sidestep. Retail's
    // `RawMotionState::ApplyMotion` (`acclient.c:332852-332889`) writes
    // the turn slot regardless of locomotion, and ACE's broadcast
    // converter passes TurnCommand through ungated
    // (`MovementData.cs:134-148`). The old Phase-2.4 suppression starved
    // observers of all heading info while a player curved (W+Q/E) — they
    // saw a dead-straight run with ~1 s heading snaps.
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
        raw_motion_state
            .flags
            .contains(RawMotionFlags::TURN_COMMAND),
        "F2-4: turn command rides the wire alongside locomotion",
    );
    assert!(raw_motion_state.flags.contains(RawMotionFlags::TURN_SPEED),);
    assert_eq!(
        raw_motion_state.turn_command,
        Some(TURN_RIGHT_MOTION_COMMAND)
    );
    assert_eq!(raw_motion_state.turn_speed, Some(WIRE_TURN_SPEED_BASE));
    assert_eq!(raw_motion_state.turn_hold_key, Some(HoldKey::Run as u32));
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
    // Direct drive install = post-first-edge state: the latch is up
    // (retail DoMotion acclient.c:317325; live ingest raises it).
    movement.last_move_was_autonomous = true;
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
    // Direct drive install = post-first-edge state: the latch is up
    // (retail DoMotion acclient.c:317325; live ingest raises it).
    movement.last_move_was_autonomous = true;
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

/// F2-2 (movement bughunt 2026-06-09) — the wire contact byte reflects the
/// LOCAL airborne state, not the stale server echo. Pre-fix, the fallback
/// chain (`last_server_grounded.unwrap_or(true)`) made the byte a constant
/// `1` even mid-jump/fall (ACE rarely sends self UpdatePosition), so ACE
/// updated `LastGroundPos` mid-air and force-grounded airborne players on
/// cell changes (`PhysicsObj.cs:3474`).
#[test]
fn autonomous_position_contact_reflects_local_airborne_state() {
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
    // Even with a stale grounded echo on file, the LOCAL airborne state
    // wins: a mid-jump heartbeat must report contact = 0.
    world.player.last_server_grounded = Some(true);
    world.player.begin_jump(5.0);
    seed_local_player(&mut world, guid, position);
    world.entities.insert(entity);

    let position_action = build_autonomous_position(&world, MovementPacketMetadata::default())
        .expect("moving player should emit autonomous position action");
    assert_eq!(position_action.last_contact, 0, "airborne → contact byte 0");

    // Touchdown flips it back the same tick.
    world.player.land();
    let position_action = build_autonomous_position(&world, MovementPacketMetadata::default())
        .expect("moving player should emit autonomous position action");
    assert_eq!(position_action.last_contact, 1, "grounded → contact byte 1");
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
    assert!(movement.autonomous_pose_changed(&first, true));

    let mut movement = movement;
    movement.note_autonomous_position_sent(&first);

    // Identical pose + contact → skip.
    assert!(!movement.autonomous_pose_changed(&pulse(base_pose, 1), true));

    // Sub-epsilon jitter (1 cm < 0.05 m) → still skipped.
    let jitter = WorldPosition {
        coords: Vector3::new(12.01, -4.0, 1.5),
        ..base_pose
    };
    assert!(!movement.autonomous_pose_changed(&pulse(jitter, 1), true));

    // Meaningful translation (0.5 m > 0.05 m) → send.
    let moved = WorldPosition {
        coords: Vector3::new(12.5, -4.0, 1.5),
        ..base_pose
    };
    assert!(movement.autonomous_pose_changed(&pulse(moved, 1), true));

    // Heading turn beyond the heading epsilon → send.
    let turned = WorldPosition {
        rotation: Quaternion::from_heading(1.0),
        ..base_pose
    };
    assert!(movement.autonomous_pose_changed(&pulse(turned, 1), true));

    // Landblock crossing → send.
    let crossed = WorldPosition {
        landblock_id: Guid(0x1000_0002),
        ..base_pose
    };
    assert!(movement.autonomous_pose_changed(&pulse(crossed, 1), true));

    // Within the 1s window, same pose but contact byte flipped (grounded →
    // airborne) → send via the in-window contact-plane branch.
    assert!(movement.autonomous_pose_changed(&pulse(base_pose, 0), false));

    // After re-sending the moved pose, the moved pose is the new
    // baseline and is itself skipped on repeat.
    let moved_pulse = pulse(moved, 1);
    movement.note_autonomous_position_sent(&moved_pulse);
    assert!(!movement.autonomous_pose_changed(&pulse(moved, 1), true));
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
    let _capabilities = seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);
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
    // Direct drive install = post-first-edge state: the latch is up
    // (retail DoMotion acclient.c:317325; live ingest raises it).
    movement.last_move_was_autonomous = true;
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
    if USE_INTERPRETED_VELOCITY {
        // STAGE 1 (2026-06-11): the interpreted-velocity pipeline
        // DIRECT-SETS the grounded planar velocity (retail
        // apply_raw_movement — no accel-cap ramp through zero); this
        // test pins the LEGACY friction+cap behaviour only. The ON-path
        // contract is pinned by
        // `high_run_target_speed_reaches_retail_max_only_with_direct_velocity`.
        return;
    }
    let mut world = WorldState::synthetic();
    let player_guid = Guid(0x5000_0AAA);
    world.player.guid = player_guid;
    let _capabilities = seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);
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
    // Direct drive install = post-first-edge state: the latch is up
    // (retail DoMotion acclient.c:317325; live ingest raises it).
    movement.last_move_was_autonomous = true;
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
    if USE_INTERPRETED_VELOCITY {
        // STAGE 1 (2026-06-11): direct-set stops THIS tick via the
        // small-velocity snap (retail: no release skid for self-powered
        // locomotion) — the multi-frame decay here is the LEGACY path.
        return;
    }
    let mut world = WorldState::synthetic();
    let player_guid = Guid(0x5000_0BBB);
    world.player.guid = player_guid;
    let _capabilities = seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);
    let start_pose = WorldPosition {
        landblock_id: Guid(0xA9B40001),
        coords: Vector3::new(100.0, 100.0, 1.5),
        rotation: Quaternion::identity(),
    };
    seed_local_player(&mut world, player_guid, start_pose);
    let _ = world.set_player_position(start_pose);

    let mut movement = MovementSystem::new();
    // No forward/sidestep/turn → target velocity is zero.
    // Direct drive install = post-first-edge state: the latch is up
    // (retail DoMotion acclient.c:317325; live ingest raises it).
    movement.last_move_was_autonomous = true;
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
    let _capabilities = seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);

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
    // Direct drive install = post-first-edge state: the latch is up
    // (retail DoMotion acclient.c:317325; live ingest raises it).
    movement.last_move_was_autonomous = true;
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
        after.coords.x,
        start_pose.coords.x
    );
    assert!(
        (after.coords.y - start_pose.coords.y).abs() < 1e-3,
        "pre-bake gate: Y should be unchanged (got {:.4}, expected {:.4})",
        after.coords.y,
        start_pose.coords.y
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
    let _capabilities = seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);

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
    // Direct drive install = post-first-edge state: the latch is up
    // (retail DoMotion acclient.c:317325; live ingest raises it).
    movement.last_move_was_autonomous = true;
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
    let _capabilities = seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);

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
    // Direct drive install = post-first-edge state: the latch is up
    // (retail DoMotion acclient.c:317325; live ingest raises it).
    movement.last_move_was_autonomous = true;
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
    let _capabilities = seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);

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
    // Direct drive install = post-first-edge state: the latch is up
    // (retail DoMotion acclient.c:317325; live ingest raises it).
    movement.last_move_was_autonomous = true;
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
    let _capabilities = seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);

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
    // Direct drive install = post-first-edge state: the latch is up
    // (retail DoMotion acclient.c:317325; live ingest raises it).
    movement.last_move_was_autonomous = true;
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
    // Direct drive install = post-first-edge state: the latch is up
    // (retail DoMotion acclient.c:317325; live ingest raises it).
    movement.last_move_was_autonomous = true;
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
    assert!(
        (total - 0.25).abs() < 1e-6,
        "slices should sum to 0.25, got {total:.6}"
    );
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

/// F1/F2 (physics parity 2026-07-03) — slice shapes of the DEFAULT
/// (ACE-shaped, `USE_RETAIL_QUANTUM` off) machinery across the probe
/// dts. Pins the byte-identical default while the retail loop exists
/// beside it: sub-`MIN_QUANTUM` frames floor to empty (the 30 Hz gate),
/// slices are 0.1, HugeQuantum drops.
#[test]
fn quantum_slice_shapes_default_mode() {
    let s = quantum_slices(0.0001).expect("under HugeQuantum");
    assert!(
        s.is_empty(),
        "0.0001 s: default floors at MIN_QUANTUM (empty, accumulated), got {s:?}"
    );
    let s = quantum_slices(0.016667).expect("under HugeQuantum");
    assert!(
        s.is_empty(),
        "16.667 ms: default floors at MIN_QUANTUM (empty, accumulated), got {s:?}"
    );
    let s = quantum_slices(0.15).expect("under HugeQuantum");
    assert_eq!(s.len(), 2, "0.15 s: [0.1, 0.05], got {s:?}");
    assert!((s[0] - MAX_QUANTUM).abs() < 1e-6, "{s:?}");
    assert!((s[1] - 0.05).abs() < 1e-6, "{s:?}");
    let s = quantum_slices(0.45).expect("under HugeQuantum");
    assert_eq!(s.len(), 5, "0.45 s: [0.1×4, ~0.05], got {s:?}");
    assert!((s[4] - 0.05).abs() < 1e-4, "{s:?}");
    assert!(quantum_slices(2.5).is_none(), "2.5 s: HugeQuantum drop");
}

/// F1/F2 — slice shapes of the RETAIL loop
/// ([`retail_quantum_schedule`], acclient.c:323123-323161) across the
/// same probe dts plus the carried-remainder arm. The key divergences
/// from the default shape: a 60 fps frame integrates DIRECTLY as one
/// quantum (no 1/30 floor on the direct path, :323127 `goto LABEL_21`),
/// slices are 0.2 (`MAX_QUANTUM_97` :784235), a sub-0.0002 frame is
/// CONSUMED (not accumulated, :323123), and only the post-slicing
/// remainder banks (:323146-:323148).
#[test]
fn quantum_slice_shapes_retail_mode() {
    // dt = 0.0001 <= 0.0002: consumed (skip) — empty slices, ZERO carry.
    let (s, carry) = retail_quantum_schedule(0.0001);
    assert!(s.is_empty(), "sub-epsilon frame integrates nothing, got {s:?}");
    assert_eq!(carry, 0.0, "sub-epsilon frame is CONSUMED, not carried");
    // Boundary: exactly 0.0002 still consumes (retail gate is strict `>`).
    let (s, carry) = retail_quantum_schedule(0.0002);
    assert!(s.is_empty() && carry == 0.0, "0.0002 boundary consumes");
    // dt = 0.016667 (60 fps): DIRECT single quantum — no 30 Hz floor.
    let (s, carry) = retail_quantum_schedule(0.016667);
    assert_eq!(s, vec![0.016667_f32], "60 fps frame integrates directly");
    assert_eq!(carry, 0.0);
    // dt = 0.15 <= 0.2: still one direct quantum (0.1 < dt <= 0.2 is
    // where the retail 0.2 slice size first diverges from the 0.1 shape).
    let (s, carry) = retail_quantum_schedule(0.15);
    assert_eq!(s, vec![0.15_f32], "sub-MAX frame is ONE quantum of dt");
    assert_eq!(carry, 0.0);
    // dt = 0.45: [0.2, 0.2] + ~0.05 remainder > 1/30 → integrated.
    let (s, carry) = retail_quantum_schedule(0.45);
    assert_eq!(s.len(), 3, "0.45 s: [0.2, 0.2, ~0.05], got {s:?}");
    assert_eq!(s[0], RETAIL_MAX_QUANTUM);
    assert_eq!(s[1], RETAIL_MAX_QUANTUM);
    assert!((s[2] - 0.05).abs() < 1e-4, "{s:?}");
    assert_eq!(carry, 0.0);
    // dt = 0.42: [0.2, 0.2] + ~0.02 remainder <= 1/30 → CARRIED, not
    // consumed (retail advances update_time only by the slices).
    let (s, carry) = retail_quantum_schedule(0.42);
    assert_eq!(s.len(), 2, "0.42 s: [0.2, 0.2] + carried tail, got {s:?}");
    assert!(
        (carry - 0.02).abs() < 1e-4 && carry > 0.0,
        "sub-MIN remainder must be carried, got {carry}"
    );
    // dt = 2.5 > HugeQuantum: consumed whole — nothing integrated,
    // nothing carried.
    let (s, carry) = retail_quantum_schedule(2.5);
    assert!(s.is_empty() && carry == 0.0, "2.5 s consumed whole");
    // dt = 2.0 boundary: retail `v6 <= 2.0` still integrates. Exact
    // slice count is f32-subtraction dependent; pin the invariants.
    let (s, carry) = retail_quantum_schedule(2.0);
    assert!(!s.is_empty(), "2.0 s boundary integrates");
    assert!(
        s.iter().all(|q| *q <= RETAIL_MAX_QUANTUM + 1e-6),
        "every slice <= 0.2, got {s:?}"
    );
    let total: f32 = s.iter().sum::<f32>() + carry;
    assert!((total - 2.0).abs() < 1e-4, "slices+carry ≈ dt, got {total}");
    assert!(carry <= MIN_QUANTUM, "carry can only be the sub-1/30 tail");
}

/// F1/F2 — the handle-path accumulator under `USE_RETAIL_QUANTUM`:
/// [`MovementSystem::advance_local_pose_for_manual_drive`] banks the
/// retail carry in `world.player.physics_time_accumulator`. Exercised
/// through the schedule function (the loop wiring is a straight
/// `for`-over-slices; the DEFAULT path's accumulator behavior is pinned
/// by the pre-existing gap-1 tests). Also pins that the retail carry
/// can never bank more than `MIN_QUANTUM` (so the accumulator cannot
/// grow unbounded while the flag is on).
#[test]
fn retail_quantum_carry_stays_sub_min_quantum() {
    let mut bank = 0.0_f32;
    // A pathological stream of 0.21 s frames: every frame slices one
    // 0.2 quantum and banks ~0.01, which the NEXT frame absorbs into
    // its dt (0.22 → [0.2] + 0.02 bank …). The bank must stay < 1/30.
    for _ in 0..50 {
        let (slices, carry) = retail_quantum_schedule(bank + 0.21);
        assert!(!slices.is_empty(), "0.21 s frames always integrate");
        bank = carry;
        assert!(
            bank <= MIN_QUANTUM,
            "carry must stay <= MIN_QUANTUM, got {bank}"
        );
    }
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
    assert!(
        drop > 0.0,
        "player should fall downward, got drop={drop:.3} m"
    );
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
    let (movement, _start_pose) = seed_airborne_player(&mut world, Guid(0x5000_0AB0), 100_000.0);

    // Drive ~10 s of fall in 0.1 s frames (each a single MAX_QUANTUM
    // slice). Unclamped this would reach 9.8·10 = 98 m/s.
    for _ in 0..100 {
        movement.advance_local_pose_for_manual_drive(&mut world, Duration::from_secs_f32(0.1));
    }

    let vz = world.player.vertical_velocity;
    assert!(
        vz < 0.0,
        "player should be falling (negative vz), got {vz:.3}"
    );
    // Retail clamps at quantum ENTRY then adds a·q at quantum end
    // (acclient.c:317740-317748 then :317778-317783), so the STORED
    // inter-quantum value legitimately overshoots by up to |a|·q; the
    // position-driving speed inside every quantum is <= MAX_VELOCITY.
    assert!(
        vz.abs() <= MAX_VELOCITY + 9.8 * MAX_QUANTUM + 1e-3,
        "stored fall speed may exceed terminal only by the one-quantum \
         gravity step (retail entry-clamp), got {:.4}",
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
    // Closed form for the RETAIL 2nd-order fall from EXACT rest: the
    // first quantum's entry mag² is 0, which skips the position add
    // entirely (acclient.c:317726-317735 — no lone half-step term)
    // while `v += a·q` still runs; every later quantum adds
    // `v·q + 0.5·a·q²`. Summing: drop(n) = 0.5·g·q²·(n²−1), i.e. the
    // pure closed form 0.5·g·t² minus the skipped first half-step
    // 0.5·g·q².
    let expected_z = start_z - 0.5 * g * (t * t - q * q);
    assert!(
        (after.coords.z - expected_z).abs() < 1e-2,
        "retail 2nd-order fall from rest over {t:.2}s should land at \
         z = z0 - 0.5·g·(t²−q²) = {expected_z:.4}, got {:.4} (Δ={:.5})",
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

/// Gap 7 regression guard, retail-ordered (acclient.c:317726-317783) —
/// from EXACT rest the first quantum's entry mag² is 0, which skips the
/// position add entirely (not even the lone half-step) while `v += a·q`
/// still runs; the SECOND quantum then adds `v·q + 0.5·a·q²` from the
/// OLD velocity = `1.5·g·q²`. A symplectic-Euler integrator using the
/// NEW velocity would drop `2·g·q²` on that quantum instead.
#[test]
fn second_order_single_slice_uses_half_step_not_full_step() {
    let mut world = WorldState::synthetic();
    let start_z = 500.0_f32;
    let (movement, _start_pose) = seed_airborne_player(&mut world, Guid(0x5000_0AD0), start_z);

    let q = 0.1_f32;
    let g = 9.8_f32;
    movement.advance_local_pose_for_manual_drive(&mut world, Duration::from_secs_f32(q));

    let after = world
        .local_player_runtime_pose()
        .expect("runtime pose seeded above");
    let drop_1 = start_z - after.coords.z;
    assert!(
        drop_1.abs() < 1e-6,
        "first from-rest quantum must add NO position (retail mag²≤0 skip, \
         acclient.c:317726), got drop {drop_1:.5} m"
    );
    assert!(
        (world.player.vertical_velocity - (-g * q)).abs() < 1e-5,
        "gravity still rebuilds v on the skipped quantum (v += a·q is \
         unconditional, acclient.c:317778), got {:.5}",
        world.player.vertical_velocity
    );

    movement.advance_local_pose_for_manual_drive(&mut world, Duration::from_secs_f32(q));
    let after_2 = world
        .local_player_runtime_pose()
        .expect("runtime pose seeded above");
    let drop_2 = start_z - after_2.coords.z;
    let second_order = 1.5 * g * q * q; // v_old·q + 0.5·g·q² = g·q² + 0.5·g·q²
    let new_velocity_euler = 2.0 * g * q * q; // (v_old + g·q)·q + … (wrong order)
    assert!(
        (drop_2 - second_order).abs() < 1e-4,
        "second quantum should drop the 2nd-order OLD-velocity amount \
         1.5·g·q² = {second_order:.5} m, got {drop_2:.5} m (NEW-velocity \
         symplectic Euler would be {new_velocity_euler:.5} m)"
    );
}

/// F4 (physics parity 2026-07-03) — the retail stop check zeroes the
/// FULL 3D velocity when the quantum-entry `mag² − 0.25² < 0.0002`,
/// after the friction slot and BEFORE the position add
/// (acclient.c:317750-317756). At a vertical-jump apex the rising vz
/// passes under 0.2504 m/s: that quantum adds only the half-step
/// `0.5·a·q²` (v was zeroed pre-add) and gravity rebuilds v from
/// exactly zero (`v += a·q`).
#[test]
fn apex_stop_check_zeroes_full_velocity_before_position_add() {
    let q = 0.1_f32;
    let g = 9.8_f32;

    // Rising at 0.2 m/s (mag² = 0.04 < 0.0625 + 0.0002): stop fires.
    let mut world = WorldState::synthetic();
    let (movement, start) = seed_airborne_player(&mut world, Guid(0x5000_0AE0), 500.0);
    world.player.vertical_velocity = 0.2;
    movement.advance_local_pose_for_manual_drive(&mut world, Duration::from_secs_f32(q));
    let after = world
        .local_player_runtime_pose()
        .expect("runtime pose seeded above");
    let dz = after.coords.z - start.coords.z;
    let stopped_dz = -0.5 * g * q * q; // −0.049: half-step only
    let unstopped_dz = 0.2 * q - 0.5 * g * q * q; // −0.029 if the stop missed
    // Tolerance: pose Z sits near 500 where the f32 ULP is ~3e-5.
    assert!(
        (dz - stopped_dz).abs() < 1e-4,
        "apex quantum must add only 0.5·a·q² = {stopped_dz:.4} (v zeroed \
         pre-add), got {dz:.4} (no-stop would be {unstopped_dz:.4})"
    );
    assert!(
        (world.player.vertical_velocity - (-g * q)).abs() < 1e-5,
        "gravity rebuilds v from the zeroed apex: expected {:.4}, got {:.4}",
        -g * q,
        world.player.vertical_velocity
    );

    // Rising at 0.3 m/s (mag² = 0.09 ≥ 0.0625 + 0.0002): NO stop.
    let mut world = WorldState::synthetic();
    let (movement, start) = seed_airborne_player(&mut world, Guid(0x5000_0AE1), 500.0);
    world.player.vertical_velocity = 0.3;
    movement.advance_local_pose_for_manual_drive(&mut world, Duration::from_secs_f32(q));
    let after = world
        .local_player_runtime_pose()
        .expect("runtime pose seeded above");
    let dz = after.coords.z - start.coords.z;
    let expected = 0.3 * q - 0.5 * g * q * q;
    assert!(
        (dz - expected).abs() < 1e-4,
        "above the stop threshold the arc integrates normally: expected \
         {expected:.4}, got {dz:.4}"
    );
    assert!(
        (world.player.vertical_velocity - (0.3 - g * q)).abs() < 1e-5,
        "v += a·q from the surviving velocity, got {:.4}",
        world.player.vertical_velocity
    );

    // A RUNNING jump near its apex: the planar component keeps mag²
    // high, so the stop must NOT fire (the planar store survives).
    let mut world = WorldState::synthetic();
    let (movement, _start) = seed_airborne_player(&mut world, Guid(0x5000_0AE2), 500.0);
    world.player.current_planar_velocity = Vector3::new(0.0, 4.0, 0.0);
    world.player.vertical_velocity = 0.2;
    movement.advance_local_pose_for_manual_drive(&mut world, Duration::from_secs_f32(q));
    assert_eq!(
        world.player.current_planar_velocity.y, 4.0,
        "a running jump's planar velocity keeps mag² above the stop \
         threshold — nothing may zero it mid-air"
    );
}

/// F6 (physics parity 2026-07-03) — retail grounded-frame friction on
/// the RESIDUAL physics velocity: on the landing transition
/// (`was_airborne && outcome.grounded`, retail's first ON_WALKABLE
/// quantum, acclient.c:316108) the stored velocity decays by
/// `pow(1 − 0.95, q)` with `sledding = false` before `land()`.
/// Normal grounded walking is untouched — the direct-set overwrites
/// the planar store from interpreted state on the next slice.
#[test]
fn landing_applies_residual_friction_before_land() {
    let guid = Guid(0x5000_0AF0);
    let mut world = WorldState::synthetic();
    world.player.guid = guid;
    let _capabilities = seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);
    let terrain_z = 10.0_f32;
    let start_pose = WorldPosition {
        landblock_id: Guid(0xA9B40001),
        coords: Vector3::new(100.0, 100.0, terrain_z + 0.05),
        rotation: Quaternion::identity(),
    };
    seed_local_player(&mut world, guid, start_pose);
    let _ = world.set_player_position(start_pose);
    world.populate_terrain_heights(0xA9B4_0000, [terrain_z; 81]);

    // Descending airborne just above the floor with a planar carry —
    // the post-jump landing shape.
    world.player.begin_fall();
    world.player.vertical_velocity = -1.0;
    world.player.current_planar_velocity = Vector3::new(0.0, 4.0, 0.0);

    let mut movement = MovementSystem::new();
    // Direct drive install = post-first-edge state: the latch is up
    // (retail DoMotion acclient.c:317325; live ingest raises it).
    movement.last_move_was_autonomous = true;
    movement.active_drive = Some(ActiveDriveState::manual(
        MotionState::builder().run().forward().build(),
        None,
    ));
    let q = 0.1_f32;
    movement.advance_local_pose_for_manual_drive(&mut world, Duration::from_secs_f32(q));

    assert!(
        !world.player.is_airborne,
        "a 0.05 m descent at −1 m/s must land within one 0.1 s slice"
    );
    // Landing tail: entry v = (0, 4, −1.98) (post-arm store: vz picked
    // up a·q). Flat normal: angle = vz < 0.25 → no early return; the
    // projection strips the into-ground component, then the along-face
    // speed scales by pow(0.05, q). land() re-zeroes vz.
    let friction = if USE_RETAIL_GROUND_FRICTION { 0.95_f32 } else { 0.5_f32 };
    let expected_y = 4.0 * (1.0 - friction).powf(q);
    assert!(
        (world.player.current_planar_velocity.y - expected_y).abs() < 1e-4,
        "landing residual should decay by pow({:.2}, q): expected \
         {expected_y:.4}, got {:.4}",
        1.0 - friction,
        world.player.current_planar_velocity.y
    );
    assert_eq!(
        world.player.vertical_velocity, 0.0,
        "land() zeroes vz after the residual friction"
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
fn run_grounded_step_down_tick(
    guid: Guid,
    retained_z: f32,
    terrain_z: f32,
) -> (WorldPosition, bool) {
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
    // Direct drive install = post-first-edge state: the latch is up
    // (retail DoMotion acclient.c:317325; live ingest raises it).
    movement.last_move_was_autonomous = true;
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

// ---------------------------------------------------------------------------
// F4-1 (bughunt 2026-06-09) — INDOOR step-down. The outdoor step-down
// path (above) followed small drops down and fell off real ledges, but
// the indoor floor-snap branch was snap-UP-only: a grounded player
// walking down a dungeon stair/ramp or off an indoor ledge kept the
// highest Z it ever reached and hovered. These pin the symmetric indoor
// descent: a real per-poly floor below the feet snaps the feet down
// within step-down height (stairs/ramps) and begins a fall beyond it
// (indoor ledges). Cell-agnostic, mirroring ACE `Transition.StepDown`.
// ---------------------------------------------------------------------------

/// Seed a grounded INDOOR player hovering `drop` metres above a flat
/// per-poly floor triangle, then run one grounded run-forward tick.
/// Returns the post-tick pose plus the airborne flag. The floor triangle
/// spans the whole cell so the forward travel never falls off it and no
/// wall blocks the lateral move (step-up stays inert) — only the
/// retained-Z-vs-floor delta drives the indoor step-down decision.
fn run_indoor_grounded_step_down_tick(
    guid: Guid,
    floor_z: f32,
    retained_z: f32,
) -> (WorldPosition, bool) {
    let mut world = WorldState::synthetic();
    world.player.guid = guid;
    let _capabilities = seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);

    // Indoor cell (low word 0x0100 ⇒ `is_indoors()`).
    let cell_landblock = Guid(0x8602_0100);
    let cell_id = u32::from(cell_landblock);
    let start_pose = WorldPosition {
        landblock_id: cell_landblock,
        coords: Vector3::new(50.0, 50.0, retained_z),
        rotation: Quaternion::identity(),
    };
    let global = start_pose.global_coords();
    seed_local_player(&mut world, guid, start_pose);
    let _ = world.set_player_position(start_pose);

    // Tall cell so the ceiling clamp never engages on the retained Z, and
    // an AABB floor well below the per-poly floor so the fall-through
    // safety guard stays inert (it only fires below `aabb.min.z`).
    let cell_aabb = holtburger_common::Aabb {
        min: holtburger_common::Vector3::new(global.x - 6.0, global.y - 6.0, floor_z - 5.0),
        max: holtburger_common::Vector3::new(global.x + 6.0, global.y + 6.0, floor_z + 40.0),
    };
    world.scene.insert_cell_aabb(cell_id, cell_aabb);
    // One big, flat (upward-normal) floor triangle under the player,
    // covering the ~0.45 m of forward travel in a 100 ms run tick.
    let tri = holtburger_common::Triangle::new(
        holtburger_common::Vector3::new(global.x - 6.0, global.y - 6.0, floor_z),
        holtburger_common::Vector3::new(global.x + 6.0, global.y - 6.0, floor_z),
        holtburger_common::Vector3::new(global.x, global.y + 6.0, floor_z),
    );
    world.scene.insert_cell_triangle(cell_id, tri);

    assert!(
        !world.player.is_airborne,
        "freshly seeded player should be grounded for the indoor step-down path"
    );

    let mut movement = MovementSystem::new();
    // Direct drive install = post-first-edge state: the latch is up
    // (retail DoMotion acclient.c:317325; live ingest raises it).
    movement.last_move_was_autonomous = true;
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

/// F4-1 — an INDOOR drop within `PLAYER_STEP_DOWN_HEIGHT` (1.5 m) snaps
/// the feet down onto the per-poly floor and keeps the player grounded
/// (walking down a dungeon stair/ramp), instead of hovering at the old
/// altitude. Before the fix this was impossible: the indoor branch only
/// snapped UP, so the retained Z never came down.
#[test]
fn indoor_step_down_within_step_height_snaps_and_stays_grounded() {
    assert!(
        USE_STEP_UP_DOWN && USE_RAMP_FLOOR_SNAP_FIX,
        "this test pins the default-on indoor step-down (F4-1)"
    );
    let floor_z = 5.0_f32;
    let retained_z = floor_z + 1.2; // 1.2 m drop: within the 1.5 m step-down
    let (after, airborne) =
        run_indoor_grounded_step_down_tick(Guid(0x5000_0F41), floor_z, retained_z);
    assert!(
        !airborne,
        "an indoor 1.2 m drop is within the 1.5 m step-down and must NOT fall"
    );
    assert!(
        (after.coords.z - (floor_z + 0.005)).abs() < 1e-3,
        "indoor step-down must snap Z to floor + 5 mm ({:.3}), got {:.3} \
         (pre-fix the snap-UP-only branch left Z hovering at {retained_z:.3})",
        floor_z + 0.005,
        after.coords.z
    );
}

/// F4-1 — an INDOOR drop beyond `PLAYER_STEP_DOWN_HEIGHT` (1.5 m) is a
/// real indoor ledge: the player begins a fall and Z is left for the
/// gravity integrator, not snapped to the distant floor.
#[test]
fn indoor_step_down_beyond_step_height_falls_off_ledge() {
    let floor_z = 5.0_f32;
    let retained_z = floor_z + 2.5; // 2.5 m drop: beyond the 1.5 m step-down
    let (after, airborne) =
        run_indoor_grounded_step_down_tick(Guid(0x5000_0F42), floor_z, retained_z);
    assert!(
        airborne,
        "an indoor 2.5 m drop exceeds the 1.5 m step-down and must trigger a fall"
    );
    // Z must NOT have snapped down to the far floor — the gravity
    // integrator owns the drop. The first airborne slice applies only a
    // sub-cm 2nd-order drop at 100 ms, so Z stays near the retained
    // height, far above the floor.
    assert!(
        after.coords.z > floor_z + 1.0,
        "indoor ledge fall must leave Z near the retained height ({retained_z:.1}), not \
         snap to the {floor_z:.1} m floor; got {:.3}",
        after.coords.z
    );
}

// ---------------------------------------------------------------------------
// F1-1 (bughunt 2026-06-09) — grounded run-speed ceiling. The legacy
// friction(0.5)+accel-cap(8) tug has a closed-form steady-state ceiling
// `v* = 8·q/(1−0.5^q) ≈ 11.7–12 m/s`, so a high-Run character's 18 m/s run
// target is unreachable. `USE_INTERPRETED_VELOCITY` (STAGE 1 2026-06-11,
// absorbing the retired `USE_DIRECT_GROUND_VELOCITY`: interpreted-state
// derivation + retail apply_raw_movement direct-set) reaches the target
// instantly. This test pins BOTH configurations so it protects whichever way
// the flag is set and auto-validates the retail path the moment the flag is
// flipped on (after the 1070 gait eye-test).
// ---------------------------------------------------------------------------

/// Run a grounded forward-run for `ticks` 100 ms slices and return the final
/// stored planar speed (m/s). No terrain is populated, so the floor query
/// misses and the player stays grounded throughout — the velocity store
/// evolves purely from the target (= base_run × run_rate) and the grounded
/// velocity model, independent of position. `base_run × run_rate = 18` is
/// retail's max run.
fn run_grounded_run_speed(guid: Guid, run_rate: f32, base_run: f32, ticks: u32) -> f32 {
    let mut world = WorldState::synthetic();
    world.player.guid = guid;
    let _capabilities =
        seed_self_movement_capabilities_override(&mut world, run_rate, 1.0, base_run, 1.5);
    let start_pose = WorldPosition {
        landblock_id: Guid(0xA9B40001),
        coords: Vector3::new(96.0, 96.0, 10.0),
        rotation: Quaternion::from_heading(0.0),
    };
    seed_local_player(&mut world, guid, start_pose);
    let _ = world.set_player_position(start_pose);
    assert!(
        !world.player.is_airborne,
        "freshly seeded player should be grounded for the run-speed path"
    );
    let mut movement = MovementSystem::new();
    // Direct drive install = post-first-edge state: the latch is up
    // (retail DoMotion acclient.c:317325; live ingest raises it).
    movement.last_move_was_autonomous = true;
    movement.active_drive = Some(ActiveDriveState::manual(
        MotionState::builder().run().forward().build(),
        None,
    ));
    for _ in 0..ticks {
        movement.advance_local_pose_for_manual_drive(&mut world, Duration::from_millis(100));
    }
    let v = world.player.current_planar_velocity;
    (v.x * v.x + v.y * v.y).sqrt()
}

/// F1-1 — an 18 m/s run target (base_run 4.0 × run_rate 4.5, retail max) is
/// reachable ONLY with the retail direct-set model; the legacy friction+cap
/// tug hard-ceilings ~20–35 % short.
#[test]
fn high_run_target_speed_reaches_retail_max_only_with_direct_velocity() {
    let steady = run_grounded_run_speed(Guid(0x5000_0F11), 4.5, 4.0, 120);
    if USE_INTERPRETED_VELOCITY {
        assert!(
            (steady - 18.0).abs() < 0.2,
            "direct-set must reach the 18 m/s run target, got {steady:.3}"
        );
        // …and reach it INSTANTLY (one tick), not over a multi-second ramp.
        let one_tick = run_grounded_run_speed(Guid(0x5000_0F12), 4.5, 4.0, 1);
        assert!(
            (one_tick - 18.0).abs() < 0.2,
            "direct-set must reach target in ONE tick (no ice-skating ramp), got {one_tick:.3}"
        );
    } else {
        // Legacy friction(0.5)+accel-cap(8) steady state ≈ 8·0.1/(1−0.5^0.1)
        // ≈ 11.95 m/s — the 18 m/s target is structurally unreachable (F1-1).
        assert!(
            steady > 11.0 && steady < 13.0,
            "legacy integrator ceilings ~11.7–12 m/s and CANNOT reach the 18 m/s \
             target (F1-1); got {steady:.3}"
        );
    }
}

// ---------------------------------------------------------------------------
// F4-2 (bughunt 2026-06-09) — outdoor walkable-slope gate. The grounded
// outdoor path snapped Z onto ANY rise with no slope test, so a player could
// run straight up an arbitrarily steep cliff at full speed.
// `USE_TERRAIN_WALKABLE_GATE` refuses the climb onto a face steeper than
// retail's FloorZ (~48.4°). This pins BOTH configurations so it protects
// whichever way the flag is set.
// ---------------------------------------------------------------------------

/// Run `ticks` 100 ms forward-run slices into a ~60° uphill face (non-walkable)
/// and return `(start_x, start_z, after_x, after_z)` in landblock-local coords.
/// A run-forward at heading 0 drives the rig toward −X, so the slope is built
/// to RISE toward −X (`grid[vx*9+vy] = (8−vx)·42 m`, ~60° everywhere): running
/// forward heads straight up the face.
fn run_uphill_cliff(guid: Guid, ticks: u32) -> (f32, f32, f32, f32) {
    let mut world = WorldState::synthetic();
    world.player.guid = guid;
    let _capabilities = seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);
    // Steep face across LB (0,0) rising toward −X (the run-forward direction).
    let mut steep = [0.0f32; 81];
    for vx in 0..9 {
        for vy in 0..9 {
            steep[vx * 9 + vy] = (8 - vx) as f32 * 42.0;
        }
    }
    world.populate_terrain_heights(0, steep);
    let start_x = 96.0_f32; // mid-LB so the −X run has room before the edge
    let start_y = 96.0_f32;
    let start_z = world
        .terrain_height_at(start_x, start_y)
        .expect("steep terrain populated");
    let start_pose = WorldPosition {
        landblock_id: Guid(0x0000_0001), // lb (0,0), outdoor (low16 < 0x100)
        coords: Vector3::new(start_x, start_y, start_z),
        rotation: Quaternion::from_heading(0.0),
    };
    seed_local_player(&mut world, guid, start_pose);
    let _ = world.set_player_position(start_pose);
    assert!(
        !world.player.is_airborne,
        "freshly seeded player should be grounded on the slope"
    );
    let mut movement = MovementSystem::new();
    // Direct drive install = post-first-edge state: the latch is up
    // (retail DoMotion acclient.c:317325; live ingest raises it).
    movement.last_move_was_autonomous = true;
    movement.active_drive = Some(ActiveDriveState::manual(
        MotionState::builder().run().forward().build(),
        None,
    ));
    for _ in 0..ticks {
        movement.advance_local_pose_for_manual_drive(&mut world, Duration::from_millis(100));
    }
    let after = world
        .local_player_runtime_pose()
        .expect("runtime pose seeded above");
    (start_x, start_z, after.coords.x, after.coords.z)
}

/// F4-2 — running into a ~60° cliff face advances + climbs it ONLY with the
/// legacy (gate-off) snap; the walkable gate blocks the climb at the base.
#[test]
fn outdoor_steep_cliff_blocks_climb_only_with_walkable_gate() {
    let (start_x, start_z, after_x, after_z) = run_uphill_cliff(Guid(0x5000_0F42), 10);
    if USE_TERRAIN_WALKABLE_GATE {
        // Gate ON: the advance onto the non-walkable face is reverted every
        // tick, so the player stays at the base and gains no height.
        assert!(
            (after_x - start_x).abs() < 0.5 && (after_z - start_z).abs() < 1.0,
            "walkable gate must stop the climb at the cliff base \
             (x≈{start_x:.1}, z≈{start_z:.1}), got x={after_x:.3} z={after_z:.3}"
        );
    } else {
        // Gate OFF (legacy): the player runs straight up the cliff — XY
        // advances toward −X and Z snaps onto the rising terrain (the
        // F4-2 exploit).
        assert!(
            after_x < start_x - 1.0 && after_z > start_z + 1.0,
            "legacy snap climbs the cliff (x<{:.1}, z>{:.1}), got x={after_x:.3} z={after_z:.3}",
            start_x - 1.0,
            start_z + 1.0
        );
    }
}

// ---------------------------------------------------------------------------
// F4-4 (bughunt 2026-06-09) — deep-water walk-block. The outdoor solver snapped
// Z to the lakebed and never read terrain type, so players ran across water
// floors. `USE_WATER_COLLISION` refuses a grounded step into a fully-water
// cell. Flag-aware: pins BOTH configurations.
// ---------------------------------------------------------------------------

/// Run `ticks` forward-run slices on flat terrain whose whole LB is water, and
/// return `(start_x, after_x)`. A run-forward at heading 0 drives −X.
fn run_into_water(guid: Guid, ticks: u32) -> (f32, f32) {
    let mut world = WorldState::synthetic();
    world.player.guid = guid;
    let _capabilities = seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);
    // Flat terrain at z=10 across LB (0,0); the whole LB is water (code 19).
    world.populate_terrain_heights(0, [10.0; 81]);
    world.populate_terrain_water(0, &[19u8; 81]);
    let start_x = 96.0_f32;
    let start_pose = WorldPosition {
        landblock_id: Guid(0x0000_0001), // lb (0,0), outdoor
        coords: Vector3::new(start_x, 96.0, 10.0),
        rotation: Quaternion::from_heading(0.0),
    };
    seed_local_player(&mut world, guid, start_pose);
    let _ = world.set_player_position(start_pose);
    assert!(!world.player.is_airborne);
    let mut movement = MovementSystem::new();
    // Direct drive install = post-first-edge state: the latch is up
    // (retail DoMotion acclient.c:317325; live ingest raises it).
    movement.last_move_was_autonomous = true;
    movement.active_drive = Some(ActiveDriveState::manual(
        MotionState::builder().run().forward().build(),
        None,
    ));
    for _ in 0..ticks {
        movement.advance_local_pose_for_manual_drive(&mut world, Duration::from_millis(100));
    }
    let after = world
        .local_player_runtime_pose()
        .expect("runtime pose seeded above");
    (start_x, after.coords.x)
}

/// F4-4 — a grounded step into a fully-water cell is refused ONLY with the
/// water-collision gate; the legacy path runs straight across the water floor.
#[test]
fn deep_water_blocks_movement_only_with_water_collision() {
    let (start_x, after_x) = run_into_water(Guid(0x5000_0F44), 10);
    if USE_WATER_COLLISION {
        assert!(
            (after_x - start_x).abs() < 0.5,
            "water collision must stop the player at the shoreline (x≈{start_x}), got x={after_x:.3}"
        );
    } else {
        assert!(
            start_x - after_x > 1.0,
            "legacy lets the player run across the water floor (−X), got x={after_x:.3}"
        );
    }
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
    assert!(
        (slid.x - 0.05).abs() < 1e-6,
        "X must stay clamped, got {}",
        slid.x
    );
    assert!(
        (slid.y - 0.3).abs() < 1e-6,
        "tangent +Y must be recovered, got {}",
        slid.y
    );
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
    let slid =
        edge_slide_refused_step_up(lateral, lateral_clamped, Some(normal), Some(normal), true);
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
    let (multi, _n_multi) = holtburger_world::spatial::clamp_delta_against_cell_walls_substepped(
        &tris,
        &pose,
        delta,
        r,
        h,
        &[],
    );
    let (single, _n_single) = holtburger_world::spatial::clamp_delta_against_cell_walls_with_normal(
        &tris,
        &pose,
        delta,
        r,
        h,
        &[],
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

    let (single, _ns) = holtburger_world::spatial::clamp_delta_against_cell_walls_with_normal(
        &tris,
        &pose,
        delta,
        r,
        h,
        &[],
    );
    let (multi, n_multi) = holtburger_world::spatial::clamp_delta_against_cell_walls_substepped(
        &tris,
        &pose,
        delta,
        r,
        h,
        &[],
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
    // Direct drive install = post-first-edge state: the latch is up
    // (retail DoMotion acclient.c:317325; live ingest raises it).
    movement.last_move_was_autonomous = true;
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
    assert!(
        !airborne,
        "step-up must not go airborne; got airborne={airborne}"
    );

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
    assert!(
        !airborne,
        "refused step-up must not go airborne; got airborne={airborne}"
    );

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

// === G-6 / F4-2 follow-on (2026-06-11): slide-along-contour tangent math ===

/// Oblique approach at a too-steep face: the into-slope component is shed
/// and the along-contour component survives untouched.
#[test]
fn test_terrain_contour_slide_oblique_keeps_tangent_component() {
    // Face leaning toward -Y (uphill is +Y): normal XY points at -Y.
    // Steeper than FloorZ (z component 0.5 < 0.664174).
    let normal = Vector3::new(0.0, -0.866, 0.5);
    // 45° approach: half uphill (+Y), half along the contour (+X).
    let lateral = Vector3::new(0.3, 0.3, 0.0);
    let slide = terrain_contour_slide(lateral, normal).expect("oblique approach must slide");
    // Into-slope (Y) component gone, contour (X) component preserved.
    assert!(
        slide.y.abs() < 1e-6,
        "into-slope component must be shed, got {slide:?}"
    );
    assert!(
        (slide.x - 0.3).abs() < 1e-6,
        "contour component must survive, got {slide:?}"
    );
    // And the slide is perpendicular to the contour wall normal.
    let wall = Vector3::new(0.0, -1.0, 0.0);
    assert!(slide.dot(&wall).abs() < 1e-6);
}

/// Head-on approach (straight uphill): the tangent component is negligible
/// → `None`, the caller keeps the retail hard stop at the cliff base.
#[test]
fn test_terrain_contour_slide_head_on_returns_none() {
    let normal = Vector3::new(0.0, -0.866, 0.5);
    let lateral = Vector3::new(0.0, 0.5, 0.0); // straight uphill
    assert!(terrain_contour_slide(lateral, normal).is_none());
}

/// Degenerate face with no XY lean (flat ground) → `None`. Can't happen
/// for a refused face (n.z < FloorZ implies XY lean) but the guard holds.
#[test]
fn test_terrain_contour_slide_flat_normal_returns_none() {
    let normal = Vector3::new(0.0, 0.0, 1.0);
    let lateral = Vector3::new(0.4, 0.2, 0.0);
    assert!(terrain_contour_slide(lateral, normal).is_none());
}

/// The slide never gains an into-slope component regardless of approach
/// angle — sweep a few headings and assert dot(slide, wall_xy) ≈ 0.
#[test]
fn test_terrain_contour_slide_never_into_slope() {
    let normal = Vector3::new(0.6, -0.6, 0.52);
    let n_xy_len = (normal.x * normal.x + normal.y * normal.y).sqrt();
    let wall = Vector3::new(normal.x / n_xy_len, normal.y / n_xy_len, 0.0);
    for i in 0..16 {
        let ang = (i as f32) * std::f32::consts::TAU / 16.0;
        let lateral = Vector3::new(ang.cos() * 0.4, ang.sin() * 0.4, 0.0);
        if let Some(slide) = terrain_contour_slide(lateral, normal) {
            assert!(
                slide.dot(&wall).abs() < 1e-5,
                "slide {slide:?} has an into-slope component for heading {ang}"
            );
        }
    }
}

/// A13-W1 (2026-06-11, unification survey): the SHARED self-movement
/// WorldEvent consumption helper records all three sequence families —
/// this is the single site both the native runtime
/// (`client/messages.rs::handle_world_events`) and the wasm recv loop
/// (`?wireStatePacks=stage1`) call, so a drift here would regress both
/// targets at once (which is the point — survey A13 §3 rows 3-4).
#[test]
fn test_apply_self_movement_world_events_records_all_sequence_families() {
    use holtburger_protocol::messages::{
        MovementEventData, MovementInvalid, MovementType, MovementTypeData,
    };
    use holtburger_world::WorldEvent;

    let mut movement = MovementSystem::new();
    assert_eq!(movement.last_diagnostic_sequences(), (None, None, None));

    let motion = MovementEventData {
        guid: Guid(0x5000_0001),
        object_instance_sequence: 7,
        movement_sequence: 20,
        server_control_sequence: 11,
        is_autonomous: false,
        movement_type: MovementType::Invalid,
        motion_flags: 0,
        current_style: MotionStance::SwordCombat.interpreted(),
        data: MovementTypeData::Invalid(MovementInvalid::default()),
    };

    movement.apply_self_movement_world_events(&[
        WorldEvent::SelfServerControlledMotion {
            data: Box::new(motion),
            target_exists: false,
            object_radius: 0.0,
            object_height: 0.0,
        },
        WorldEvent::SelfUpdatePosition {
            teleport_sequence: 3,
            force_position_sequence: 5,
        },
    ]);
    assert_eq!(
        movement.last_diagnostic_sequences(),
        (Some(11), Some(5), None)
    );

    movement.apply_self_movement_world_events(&[WorldEvent::SelfAutonomousPosition {
        teleport_sequence: 4,
        force_position_sequence: 6,
        server_control_sequence: 12,
    }]);
    assert_eq!(
        movement.last_diagnostic_sequences(),
        (Some(12), Some(6), Some(4))
    );

    // Unrelated events are ignored.
    movement.apply_self_movement_world_events(&[WorldEvent::TeleportStarted { sequence: 99 }]);
    assert_eq!(
        movement.last_diagnostic_sequences(),
        (Some(12), Some(6), Some(4))
    );
}

/// A13-W2 (2026-06-11, unification survey): `server_control_sequence`
/// echo parity — the full canonical chain. Retail constructs every C2S
/// position pack from the SAME `CPhysicsObj::update_times[]` slots, and
/// the echoed server-control slot is `update_times[5]`
/// (`CommandInterpreter::SendMovementEvent` acclient.c:718176 ->
/// MoveToStatePack ctor :718187; `SendPositionEvent` :718227 -> :718239).
/// Ours: a non-autonomous self `UpdateMotion` routed through the ONE
/// world-handler path (`handlers::routing::handle_message`, used by both
/// the native runtime and the `?wireStatePacks=stage1` wasm route) must
/// advance `world.player.server_control_sequence`
/// (`apply_self_update_motion`, mutations.rs — ACE cross-ref:
/// ACE.Server `Sequence.SequenceType.ObjectServerControl` bumped per
/// server-issued motion broadcast), and the NEXT built MoveToState /
/// AutonomousPosition packs echo the live value — never the wasm
/// pre-W1 constant 0 ("let it ride").
#[test]
fn test_a13_w2_non_autonomous_update_motion_echoes_into_next_packs() {
    use super::super::common::build_move_to_state;
    use holtburger_protocol::messages::game_message::GameMessage;
    use holtburger_protocol::messages::{
        MovementEventData, MovementInvalid, MovementType, MovementTypeData,
    };
    use holtburger_protocol::traits::ProtocolPack;
    use holtburger_world::WorldEvent;
    use holtburger_world::handlers::routing::handle_message;

    let mut world = WorldState::synthetic();
    let guid = Guid(0x5000_0001);
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };
    world.player.guid = guid;
    world.player.instance_sequence = 9;
    world.player.server_control_sequence = 7;
    world.player.teleport_sequence = 33;
    world.player.force_position_sequence = 44;
    seed_local_player(&mut world, guid, position);

    let update_motion = |server_control_sequence: u16| {
        GameMessage::UpdateMotion(Box::new(MovementEventData {
            guid,
            object_instance_sequence: 9,
            movement_sequence: 21,
            server_control_sequence,
            is_autonomous: false,
            movement_type: MovementType::Invalid,
            motion_flags: 0,
            current_style: MotionStance::NonCombat.interpreted(),
            data: MovementTypeData::Invalid(MovementInvalid::default()),
        }))
    };

    // Non-autonomous UpdateMotion with sequence 41 routed through the
    // canonical handler advances the one quartet owner and emits the
    // Self* event the shared movement helper consumes.
    let mut events = Vec::new();
    handle_message(&mut world, &update_motion(41), &mut events);
    assert_eq!(world.player.server_control_sequence, 41);
    assert!(
        events
            .iter()
            .any(|e| matches!(e, WorldEvent::SelfServerControlledMotion { .. })),
        "accepted non-autonomous UpdateMotion must emit SelfServerControlledMotion"
    );

    // The NEXT built MoveToState echoes 41 (single builder, A13-W3).
    let raw_motion_state = build_motion_state_raw_motion_state(
        &world,
        MotionState::builder().run().forward().build(),
        MotionStyle::PreserveServer,
    );
    let action = build_move_to_state(&world, raw_motion_state, MovementPacketMetadata::default());
    assert_eq!(action.instance_sequence, 9);
    assert_eq!(action.server_control_sequence, 41);
    assert_eq!(action.teleport_sequence, 33);
    assert_eq!(action.force_position_sequence, 44);

    // Golden bytes: the quartet sits immediately after
    // RawMotionState + Position as 4 consecutive LE u16 then the
    // contact|longjump<<1 byte, padded to 4 (retail
    // MoveToStatePack::Pack acclient.c:323814-323851).
    let mut prefix = Vec::new();
    action.raw_motion_state.pack(&mut prefix);
    action.position.pack(&mut prefix);
    let mut packed = Vec::new();
    action.pack(&mut packed);
    assert_eq!(
        &packed[prefix.len()..prefix.len() + 9],
        &[9, 0, 41, 0, 33, 0, 44, 0, 1],
        "quartet + grounded contact byte, LE, in retail order"
    );
    assert_eq!(packed.len() % 4, 0, "ALIGN_PTR(4) tail pad");

    // The AutonomousPosition heartbeat echoes the same live value
    // (retail SendPositionEvent reads the same update_times slots).
    let position_action = build_autonomous_position(&world, MovementPacketMetadata::default())
        .expect("seeded player should emit autonomous position action");
    assert_eq!(position_action.server_control_sequence, 41);

    // Stale replay (40 < 41 in u16 wrap order) is rejected: no sequence
    // regression, no Self* event (should_accept_server_controlled_motion).
    let mut stale_events = Vec::new();
    handle_message(&mut world, &update_motion(40), &mut stale_events);
    assert_eq!(world.player.server_control_sequence, 41);
    assert!(
        !stale_events
            .iter()
            .any(|e| matches!(e, WorldEvent::SelfServerControlledMotion { .. })),
        "stale UpdateMotion must not re-emit SelfServerControlledMotion"
    );
}

/// A3-D3 (2026-06-12): the per-entity `MovementManager` registry —
/// lazy-create runs `enter_default_state` exactly once, the local
/// player is keyed by its guid through the `SelfServerControlledMotion`
/// lane, and `EntityDespawned` prunes. Exercised through the gate-free
/// helper so the suite stays green while `USE_UNPACK_MOVEMENT_SEMANTICS`
/// ships default-off (Lane-A rule); the gated public wrapper is a
/// no-op until the const flips.
#[test]
fn test_movement_manager_registry_create_apply_prune() {
    use holtburger_protocol::messages::{
        MovementEventData, MovementInvalid, MovementType, MovementTypeData,
    };
    use holtburger_world::WorldEvent;

    let remote_guid = Guid(0x8000_0077);
    let player_guid = Guid(0x5000_0001);
    let event_for = |guid: Guid| MovementEventData {
        guid,
        object_instance_sequence: 1,
        movement_sequence: 2,
        server_control_sequence: 3,
        is_autonomous: false,
        movement_type: MovementType::Invalid,
        // standing_longjump bit — observable registry write.
        motion_flags: 0x02,
        current_style: MotionStance::NonCombat.interpreted(),
        data: MovementTypeData::Invalid(MovementInvalid::default()),
    };

    let mut movement = MovementSystem::new();
    assert!(movement.movement_manager_for(remote_guid).is_none());

    // Default-off gate: the public wrapper must be a NO-OP.
    movement.apply_movement_world_events(&[WorldEvent::EntityMovementEvent {
        guid: remote_guid,
        data: Box::new(event_for(remote_guid)),
        target_exists: false,
        object_radius: 0.0,
        object_height: 0.0,
    }]);
    assert!(
        movement.movement_manager_for(remote_guid).is_none(),
        "USE_UNPACK_MOVEMENT_SEMANTICS is default-off — registry must not allocate"
    );

    // Gate-free: remote lane creates + applies.
    movement.apply_movement_world_events_ungated(&[WorldEvent::EntityMovementEvent {
        guid: remote_guid,
        data: Box::new(event_for(remote_guid)),
        target_exists: false,
        object_radius: 0.0,
        object_height: 0.0,
    }]);
    let manager = movement
        .movement_manager_for(remote_guid)
        .expect("registry entry created");
    let interp = manager.motion_interp_ref().expect("lazy minterp created");
    assert!(interp.initted, "enter_default_state ran on lazy create");
    // A4/SA4F: the zero-anim Ready seed completes inside the same
    // `apply_unpacked_movement` call (the tail `use_time` pump,
    // acclient.c:344684-344704) — the post-call queue is empty.
    assert!(
        interp.pending_motions.is_empty(),
        "the Ready seed completed via the same-call tail pump"
    );
    assert!(manager.standing_longjump(), "the 0x02 bit was consumed");

    // Second event: no re-seed (enter_default_state exactly once).
    movement.apply_movement_world_events_ungated(&[WorldEvent::EntityMovementEvent {
        guid: remote_guid,
        data: Box::new(event_for(remote_guid)),
        target_exists: false,
        object_radius: 0.0,
        object_height: 0.0,
    }]);
    assert_eq!(
        movement
            .movement_manager_for(remote_guid)
            .unwrap()
            .motion_interp_ref()
            .unwrap()
            .pending_motions
            .len(),
        0,
        "no re-seed on the second unpack (and the tail pump keeps the queue drained)"
    );

    // Local player keyed by its guid via SelfServerControlledMotion.
    movement.apply_movement_world_events_ungated(&[WorldEvent::SelfServerControlledMotion {
        data: Box::new(event_for(player_guid)),
        target_exists: false,
        object_radius: 0.0,
        object_height: 0.0,
    }]);
    assert!(movement.movement_manager_for(player_guid).is_some());

    // Despawn prunes only the despawned guid.
    movement.apply_movement_world_events_ungated(&[WorldEvent::EntityDespawned(remote_guid)]);
    assert!(movement.movement_manager_for(remote_guid).is_none());
    assert!(movement.movement_manager_for(player_guid).is_some());
}

// =====================================================================
// A6-T1/T2 (2026-06-12, W3+ S7) — unified transition pipeline.
// =====================================================================

fn unified_transition_fixture(flag_on: bool) -> (WorldState, MovementSystem, Guid, WorldPosition) {
    let mut world = WorldState::synthetic();
    let player_guid = Guid(0x5000_0001);
    world.player.guid = player_guid;
    seed_self_movement_capabilities_override(&mut world, 1.0, 2.0, 4.0, 1.5);
    let start = WorldPosition {
        landblock_id: Guid(0x1234_0000),
        coords: Vector3::new(50.0, 50.0, 0.0),
        rotation: Quaternion::identity(),
    };
    seed_local_player(&mut world, player_guid, start);
    let mut movement = MovementSystem::new();
    movement.set_unified_transition(flag_on);
    movement.set_active_manual_drive_for_test(MotionState::builder().run().forward().build());
    (world, movement, player_guid, start)
}

/// Lane-A test 2 (spec S7 §4): flag-on vs flag-off manual advance on
/// OPEN ground (no geometry, no terrain cache) must agree — the
/// pipeline is a pure superset that only differs at contacts.
#[test]
fn unified_transition_manual_slice_matches_legacy_on_open_ground() {
    let dt = Duration::from_millis(100);
    let (mut world_off, movement_off, _, _) = unified_transition_fixture(false);
    movement_off.advance_local_pose_for_manual_drive(&mut world_off, dt);
    let legacy_pose = world_off
        .local_player_runtime_pose()
        .expect("legacy pose advanced");

    let (mut world_on, movement_on, _, start) = unified_transition_fixture(true);
    movement_on.advance_local_pose_for_manual_drive(&mut world_on, dt);
    let pipeline_pose = world_on
        .local_player_runtime_pose()
        .expect("pipeline pose advanced");

    assert!(
        (legacy_pose.coords.x - pipeline_pose.coords.x).abs() < 1e-5
            && (legacy_pose.coords.y - pipeline_pose.coords.y).abs() < 1e-5
            && (legacy_pose.coords.z - pipeline_pose.coords.z).abs() < 1e-5,
        "open-ground equivalence: legacy {:?} vs pipeline {:?}",
        legacy_pose.coords,
        pipeline_pose.coords
    );
    // And the drive actually moved (forward at identity heading = +y).
    assert!(
        pipeline_pose.coords.y > start.coords.y + 1e-4,
        "manual drive must advance: {:?}",
        pipeline_pose.coords
    );
}

/// Lane-A test 9 (spec S7 §4) — the P2b hole, pinned and fixed. The
/// canonical spine's simulation solve advances a Manual body through
/// `advance_grounded_body_kinematics` → `project_pose_by_velocity`
/// with ZERO collision (physics.rs:1786); under
/// `?unifiedTransition=on` the same input routes through the retail
/// pipeline and stops at the wall.
#[test]
fn unified_transition_spine_manual_collision_matrix() {
    use crate::client::simulation::ClientSimulationSystem;
    use holtburger_world::spatial::BuildingId;

    let run = |flag_on: bool| -> f32 {
        let (mut world, mut movement, player_guid, start) = unified_transition_fixture(flag_on);
        // Wall directly ahead on +y, spanning the whole approach.
        let global = start.global_coords();
        world.scene.insert_building_aabb(
            start.landblock_id.0,
            holtburger_world::spatial::BuildingAabbEntry {
                building_id: BuildingId::new(start.landblock_id.0, 1, 0),
                part_index: 0,
                aabb: holtburger_common::Aabb {
                    min: Vector3::new(global.x - 5.0, global.y + 1.0, global.z - 1.0),
                    max: Vector3::new(global.x + 5.0, global.y + 2.0, global.z + 10.0),
                },
                active: true,
            },
        );
        let mut simulation = ClientSimulationSystem::new();
        simulation.track_body(SpatialBodyId::LocalPlayer(player_guid));
        // Enough slices to cross the 1.0 m gap at ~4 m/s.
        for _ in 0..10 {
            let _ = simulation.tick(
                Instant::now(),
                Duration::from_millis(100),
                &mut world,
                &mut movement,
            );
        }
        world
            .local_player_runtime_pose()
            .expect("pose resolved")
            .coords
            .y
    };

    // Pin the P2b hole: flag-off, the spine walks straight through the
    // wall (y well past the 51.0 face).
    let off_y = run(false);
    assert!(
        off_y > 51.0 + 0.5,
        "P2b pin: flag-off spine should pass through the wall, y = {off_y}"
    );
    // Fixed: flag-on stops at (or just before) the wall face minus the
    // capsule radius (51.0 - 0.4 = 50.6).
    let on_y = run(true);
    assert!(
        on_y <= 50.6 + 1e-3,
        "unifiedTransition must stop the spine at the wall, y = {on_y}"
    );
    assert!(on_y > 50.0, "some travel before the wall, y = {on_y}");
}

// === A4-Q2 (2026-06-12, W3+ S5) — notify_animation_done system path ======
//
// The module-level queue semantics (FIFO, num_anims accounting, counter
// reset, truncation) are pinned in motion_table_manager.rs's own tests;
// these cover the NEW system-level entry the wasm `notifyAnimationDone`
// export lands on: the `USE_MOTION_TABLE_QUEUE` gate + the ungated body.

/// Flag gate: with `USE_MOTION_TABLE_QUEUE` off (the shipped default) the
/// gated entry must not touch the queue — a seeded node stays pending (a
/// later direct `animation_done` still pops it, proving it was untouched).
/// Written gate-aware so it stays green when the const flips default-on.
#[test]
fn notify_animation_done_respects_queue_flag() {
    let mut system = MovementSystem::new();
    // Seed ONE 1-anim node (0x4400_0001-style one-shot; exact id is
    // irrelevant to the accounting).
    system
        .motion_table_manager_mut()
        .queue_object_motion(0x4400_0001, 1);
    // Drop any enqueue-time events so the assertions below see only
    // completion traffic.
    let _ = system.motion_table_manager_mut().drain_events();

    system.notify_animation_done(true);
    let events = system.motion_table_manager_mut().drain_events();
    if USE_MOTION_TABLE_QUEUE {
        assert_eq!(
            events.len(),
            1,
            "flag-on: gated notify must pop the seeded node"
        );
    } else {
        assert!(
            events.is_empty(),
            "flag-off: gated notify must be a compile-time no-op"
        );
        // The node must still be pending: a direct (ungated) completion
        // now pops it.
        system.notify_animation_done_ungated(true);
        let events = system.motion_table_manager_mut().drain_events();
        assert_eq!(events.len(), 1, "node untouched by the gated no-op");
        assert!(matches!(
            events[0],
            MotionTableEvent::MotionDone {
                motion: 0x4400_0001,
                success: true
            }
        ));
    }
}

/// Ungated path: one notify pops exactly ONE 1-anim head node and fires
/// `MotionDone` with the caller's success value (positional counting —
/// `acclient.c:329885-329894`); the second node waits for its own notify.
#[test]
fn notify_animation_done_ungated_pops_one_node_per_signal() {
    let mut system = MovementSystem::new();
    system
        .motion_table_manager_mut()
        .queue_object_motion(0x4400_0001, 1);
    system
        .motion_table_manager_mut()
        .queue_object_motion(0x4400_0002, 1);
    let _ = system.motion_table_manager_mut().drain_events();

    system.notify_animation_done_ungated(true);
    let events = system.motion_table_manager_mut().drain_events();
    assert_eq!(events.len(), 1, "exactly one node per AnimationDone");
    assert!(matches!(
        events[0],
        MotionTableEvent::MotionDone {
            motion: 0x4400_0001,
            success: true
        }
    ));

    // Cancellation shape (the Stage-D eviction call): success=false rides
    // through to the event (exit-world drain analogy, acclient.c:329940).
    system.notify_animation_done_ungated(false);
    let events = system.motion_table_manager_mut().drain_events();
    assert_eq!(events.len(), 1);
    assert!(matches!(
        events[0],
        MotionTableEvent::MotionDone {
            motion: 0x4400_0002,
            success: false
        }
    ));
}

/// Empty-queue no-op: a notify on a fresh system emits nothing and leaves
/// the counter at 0 — the `acclient.c:329884` head-null guard end-to-end.
/// (Counter-at-0 is observed behaviorally: a node seeded AFTER the stray
/// notify still needs its own notify to complete.)
#[test]
fn notify_animation_done_empty_queue_is_a_no_op() {
    let mut system = MovementSystem::new();
    system.notify_animation_done_ungated(true);
    assert!(
        system.motion_table_manager_mut().drain_events().is_empty(),
        "empty-queue notify must emit nothing"
    );
    // Counter must NOT have been bumped by the stray notify: a fresh
    // 1-anim node does not auto-complete.
    system
        .motion_table_manager_mut()
        .queue_object_motion(0x4400_0003, 1);
    let _ = system.motion_table_manager_mut().drain_events();
    system.motion_table_manager_mut().use_time();
    assert!(
        system.motion_table_manager_mut().drain_events().is_empty(),
        "stray pre-seed notify must not pre-pay the new node's completion"
    );
    system.notify_animation_done_ungated(true);
    assert_eq!(system.motion_table_manager_mut().drain_events().len(), 1);
}

// === A2-P2 (2026-06-12, W3+ S8) — remote manager step in the spine =======

/// S8 §4 test 2 — the per-slice remote PositionManager slot. A 0.25 s
/// frame slices as [0.1, 0.1, 0.05] (MAX_QUANTUM = 0.1), so a remote
/// body with a queued correction advances by max_speed_floor × dt =
/// 7.5 × 0.25 = 1.875 m in ONE `ClientSimulationSystem::tick`; flag
/// off, the manager is never stepped (zero work, byte-identical).
#[test]
fn simulation_tick_steps_remote_managers_once_per_slice() {
    use crate::client::simulation::ClientSimulationSystem;
    use holtburger_world::spatial::AuthoritativeBodySync;
    use web_time::Instant as WtInstant;

    let run = |flag_on: bool| -> (f32, usize) {
        let mut world = WorldState::synthetic();
        world.set_remote_interp_enabled(flag_on);
        let guid = Guid(0x7000_0099);
        let body_id = SpatialBodyId::Entity(guid);
        let start = WorldPosition {
            landblock_id: Guid(0x1234_0000),
            coords: Vector3::new(50.0, 50.0, 0.0),
            rotation: Quaternion::identity(),
        };
        let target = WorldPosition {
            coords: Vector3::new(50.0, 60.0, 0.0),
            ..start
        };
        world.scene.reconcile_authoritative_body(
            body_id,
            start,
            Vector3::zero(),
            Vector3::zero(),
            AuthoritativeBodySync::Snapshot,
            WtInstant::now(),
        );
        // Queue the correction directly on the manager (the ingest
        // lattice is pinned in holtburger-world's spatial tests; this
        // lane pins the STEP SITE only) — the queue surface is shared
        // with the flag-on path, so flag-off must still not step it.
        {
            let body = world.scene.body_mut(body_id).expect("body");
            assert!(
                body.position_manager
                    .remote_interpolate_to(start, target, false, 100.0)
            );
        }
        let mut simulation = ClientSimulationSystem::new();
        let mut movement = MovementSystem::new();
        let _ = simulation.tick(
            WtInstant::now(),
            Duration::from_millis(250),
            &mut world,
            &mut movement,
        );
        let pose = world.scene.body(body_id).expect("body").pose;
        let rows = world.scene.take_remote_stepped_poses();
        (pose.coords.y - 50.0, rows.len())
    };

    let (advanced_on, rows_on) = run(true);
    assert!(
        (advanced_on - 1.875).abs() < 1e-3,
        "3 slices × 7.5 m/s floor must advance 1.875 m, got {advanced_on}"
    );
    assert_eq!(rows_on, 1, "stepped body lands in the export ledger once");

    let (advanced_off, rows_off) = run(false);
    assert_eq!(advanced_off, 0.0, "flag off: manager never stepped");
    assert_eq!(rows_off, 0, "flag off: ledger stays empty");
}

// =============================================================================
// A14-I4 (W3+ S11, 2026-06-12) — charge clock + single send boundary.
// Clock-curve / divisor / floor / double-press / standstill-root tests live
// in jump_charge.rs; this block pins the release pipeline (gates + the
// build_jump pack) per the spec's tests 8-11.
// =============================================================================

use super::super::common::build_jump;
use super::super::jump_charge::{JumpOutcome, JumpRefusal};
use holtburger_protocol::messages::movement::actions::JumpActionData;

fn seed_jump_world() -> WorldState {
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
    world
}

// Spec test 9 — golden extraction: `build_jump` output for a fixed
// WorldState snapshot equals the legacy inline `JumpActionData`
// construction it replaces (the lib.rs `SessionCommand::Jump` recv-arm
// ctor, moved here verbatim). Pattern = A13-W2 golden test (b5a31b99).
#[test]
fn build_jump_matches_legacy_inline_construction() {
    let mut world = seed_jump_world();
    world.player.instance_sequence = 0x1111;
    world.player.server_control_sequence = 0x2222;
    world.player.teleport_sequence = 0x3333;
    world.player.force_position_sequence = 0x4444;
    let extent = 0.75_f32;
    let velocity = Vector3::new(1.5, -2.5, 5.25);

    // Legacy construction, verbatim shape (lib.rs Jump arm).
    let legacy = JumpActionData {
        extent,
        velocity,
        instance_sequence: world.player.instance_sequence,
        server_control_sequence: world.player.server_control_sequence,
        teleport_sequence: world.player.teleport_sequence,
        force_position_sequence: world.player.force_position_sequence,
        object_guid: world.player.guid,
        spell_id: 0,
    };

    assert_eq!(build_jump(&world, extent, velocity), legacy);
}

// Spec test 10 — quartet echo: a sequence stamped on world.player is
// echoed by the builder (mirror of the A13-W2 echo-chain test).
#[test]
fn build_jump_echoes_server_control_sequence() {
    let mut world = seed_jump_world();
    world.player.server_control_sequence = 0x00AB;
    let data = build_jump(&world, 1.0, Vector3::zero());
    assert_eq!(data.server_control_sequence, 0x00AB);
}

// Release with no pending charge → NotCharging (acclient.c:408164).
#[tokio::test]
async fn execute_jump_release_without_charge_is_not_charging() {
    let mut world = seed_jump_world();
    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let outcome = movement
        .execute_jump_release(Instant::now(), &mut world, &mut session)
        .await
        .expect("release must not error");
    assert_eq!(outcome, JumpOutcome::NotCharging);
}

// Spec test 8 (gate half) — FinishJump-before-validate ordering
// (acclient.c:408168-408179): a release whose substate gate refuses
// still clears jump_pending + the standstill root.
#[tokio::test]
async fn refused_release_still_clears_charge() {
    let mut world = seed_jump_world();
    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let t0 = Instant::now();
    movement
        .jump_charge_commence(t0, &mut world)
        .expect("grounded standstill press commences");
    assert!(world.player.standing_long_jump_charge, "root set at press");

    // Substate flips to Crouch between press and release.
    world.player.current_substate = 0x4100_0012;
    let outcome = movement
        .execute_jump_release(t0 + Duration::from_millis(500), &mut world, &mut session)
        .await
        .expect("release must not error");
    assert_eq!(outcome, JumpOutcome::Refused(JumpRefusal::Position));
    assert!(
        !world.player.standing_long_jump_charge,
        "FinishJump ran before validation — root cleared"
    );
    assert!(!world.player.is_airborne, "refused release must not launch");

    // The charge was consumed: a second release is NotCharging.
    let outcome = movement
        .execute_jump_release(t0 + Duration::from_secs(1), &mut world, &mut session)
        .await
        .expect("release must not error");
    assert_eq!(outcome, JumpOutcome::NotCharging);
}

// In-air release refuses with retail 36 (acclient.c:343944) — gate
// order puts it before the substate gate.
#[tokio::test]
async fn airborne_release_refuses_in_air() {
    let mut world = seed_jump_world();
    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let t0 = Instant::now();
    movement
        .jump_charge_commence(t0, &mut world)
        .expect("grounded press commences");
    world.player.is_airborne = true;
    let outcome = movement
        .execute_jump_release(t0 + Duration::from_millis(200), &mut world, &mut session)
        .await
        .expect("release must not error");
    assert_eq!(outcome, JumpOutcome::Refused(JumpRefusal::InAir));
}

// Spec test 11 — queue-head `jump_error_code` refusal propagates
// through execute_jump_release (acclient.c:343946-343948; the A4-Q1
// pending_motions lane, DESIGN.md:447-454).
#[tokio::test]
async fn queue_head_jump_error_refuses_release() {
    let mut world = seed_jump_world();
    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let t0 = Instant::now();
    movement
        .jump_charge_commence(t0, &mut world)
        .expect("press commences");
    // A pending node carrying the charge-time 72 code blocks the jump.
    movement
        .local_motion_interp
        .add_to_queue(1, 0x4500_0005, 72);
    let outcome = movement
        .execute_jump_release(t0 + Duration::from_millis(300), &mut world, &mut session)
        .await
        .expect("release must not error");
    assert_eq!(outcome, JumpOutcome::Refused(JumpRefusal::Position));
}

// Happy path: charged release launches (begin_jump stamps the airborne
// ballistic state) and reports the clock-derived extent.
#[tokio::test]
async fn successful_release_launches_with_clock_extent() {
    let mut world = seed_jump_world();
    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let t0 = Instant::now();
    movement
        .jump_charge_commence(t0, &mut world)
        .expect("press commences");
    let outcome = movement
        .execute_jump_release(t0 + Duration::from_millis(500), &mut world, &mut session)
        .await
        .expect("release must not error");
    match outcome {
        JumpOutcome::Jumped { extent, vz, .. } => {
            assert!(
                (extent - 0.5).abs() < 1e-2,
                "extent tracks the clock, got {extent}"
            );
            assert!(vz > 0.0, "launch needs a positive vertical velocity");
        }
        other => panic!("expected Jumped, got {other:?}"),
    }
    assert!(world.player.is_airborne, "begin_jump must stamp airborne");
    assert!(
        !world.player.standing_long_jump_charge,
        "charge root consumed by the release"
    );
}

// =====================================================================
// A3-D3 (2026-06-12, SD3D) — MoveToManager DRIVER shim
// (USE_MOVETO_DRIVER). The shim body (`drive_local_moveto`) is
// exercised directly — the `_ungated` house pattern — while the const
// ships default-off (test 11's default-off identity is the rest of
// this suite passing unmodified).
// =====================================================================

/// Build a wire-shaped case-6 MoveToObject event for `guid` chasing
/// `target` (the registry consumer's input).
fn moveto_object_event_for(
    guid: Guid,
    target: Guid,
    target_pos: WorldPosition,
) -> holtburger_protocol::messages::MovementEventData {
    use holtburger_protocol::messages::movement::messages::motion::{
        MoveToObject, MoveToParameters, Origin,
    };
    use holtburger_protocol::messages::{MovementEventData, MovementType, MovementTypeData};

    MovementEventData {
        guid,
        object_instance_sequence: 1,
        movement_sequence: 2,
        server_control_sequence: 3,
        is_autonomous: false,
        movement_type: MovementType::MoveToObject,
        motion_flags: 0,
        current_style: MotionStance::NonCombat.interpreted(),
        data: MovementTypeData::MoveToObject(MoveToObject {
            target,
            origin: Origin {
                cell_id: target_pos.landblock_id,
                position: target_pos.coords,
            },
            // ACE-realistic parameter block (the retail ctor values —
            // a zeroed wire default would mean fail_distance 0).
            params: MoveToParameters {
                movement_parameters: 0x0001_EE0F,
                distance_to_object: 0.6,
                min_distance: 0.0,
                fail_distance: f32::MAX,
                speed: 1.0,
                walk_run_threshold: 15.0,
                desired_heading: 0.0,
            },
            run_rate: 1.0,
        }),
    }
}

/// Spec test 9 — the shim translates an active walk command into an
/// `Autonomous` drive intent on the EXISTING lane
/// (`current_local_drive_control` exposes it to the solver), and the
/// arrival edge requests the stop EXACTLY once with the `Some(0)`
/// completion latched (S10 contract).
#[tokio::test]
async fn moveto_driver_walks_then_arrives_with_single_stop_edge() {
    use holtburger_world::WorldEvent;

    let mut world = WorldState::synthetic();
    let guid = Guid(0x5000_0123);
    let target_guid = Guid(0x8000_0042);
    // Facing EAST (AC heading 180) directly at the target 10 m away —
    // the entry turn node pops immediately and the walk begins on the
    // first driven frame.
    let position = WorldPosition {
        landblock_id: Guid(0x1234_0019),
        coords: Vector3::new(50.0, 50.0, 0.0),
        rotation: Quaternion::from_heading(180.0_f32.to_radians()),
    };
    let target_pos = WorldPosition {
        landblock_id: Guid(0x1234_0019),
        coords: Vector3::new(60.0, 50.0, 0.0),
        rotation: Quaternion::identity(),
    };
    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);
    world
        .entities
        .insert(Entity::new(target_guid, "Drudge".to_string(), target_pos));

    let mut movement = MovementSystem::new();
    // Install through the real registry consumer (the M4.3 local lane
    // shape: real target_exists + caller-resolved dims).
    movement.apply_movement_world_events_ungated(&[WorldEvent::SelfServerControlledMotion {
        data: Box::new(moveto_object_event_for(guid, target_guid, target_pos)),
        target_exists: true,
        object_radius: 0.5,
        object_height: 1.8,
    }]);
    assert!(movement.moveto_is_active(guid));
    assert_eq!(movement.take_moveto_completion(guid), None);

    let now = Instant::now();
    // Frame 1: build + begin → walk steering on the autonomous lane.
    let stop = movement.drive_local_moveto(now, &mut world);
    assert!(!stop, "walking — no stop edge");
    let drive = movement
        .current_local_drive_control(&world, Duration::from_millis(16))
        .expect("walk steering must ride the autonomous drive lane");
    assert_eq!(drive.body_id, SpatialBodyId::LocalPlayer(guid));
    assert!(
        (drive.desired_world_delta.x - 1.0).abs() < 1e-3
            && drive.desired_world_delta.y.abs() < 1e-3,
        "unit-forward toward the target: {:?}",
        drive.desired_world_delta
    );
    assert!(!drive.force_grounded);
    assert!(drive.target_hint.is_some());

    // Arrival: place the player at the target's standoff and pump —
    // ONE stop edge, completion Some(0), directive cleared.
    let _ = world.set_local_player_runtime_pose(WorldPosition {
        landblock_id: Guid(0x1234_0019),
        coords: Vector3::new(59.5, 50.0, 0.0),
        rotation: Quaternion::from_heading(180.0_f32.to_radians()),
    });
    let stop = movement.drive_local_moveto(now, &mut world);
    assert!(stop, "arrival owes the stop edge");
    assert!(!movement.moveto_is_active(guid));
    assert_eq!(movement.take_moveto_completion(guid), Some(0));
    assert_eq!(movement.take_moveto_completion(guid), None, "read-clear");
    assert!(
        !movement.drive_local_moveto(now, &mut world),
        "inactive driver never re-requests the stop edge"
    );
}

/// Spec test 9 (M4.5) — a held non-idle MANUAL drive cancels the
/// active MoveTo with 0x36 (retail apply_raw_movement →
/// cancel_moveto(0x36)); the manual lane keeps the wire (no stop
/// edge from the driver).
#[tokio::test]
async fn manual_nonidle_input_cancels_active_moveto_with_0x36() {
    use holtburger_world::WorldEvent;

    let mut world = WorldState::synthetic();
    let guid = Guid(0x5000_0123);
    let target_guid = Guid(0x8000_0042);
    let position = WorldPosition {
        landblock_id: Guid(0x1234_0019),
        coords: Vector3::new(50.0, 50.0, 0.0),
        rotation: Quaternion::from_heading(180.0_f32.to_radians()),
    };
    let target_pos = WorldPosition {
        landblock_id: Guid(0x1234_0019),
        coords: Vector3::new(60.0, 50.0, 0.0),
        rotation: Quaternion::identity(),
    };
    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);
    world
        .entities
        .insert(Entity::new(target_guid, "Drudge".to_string(), target_pos));

    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    movement.apply_movement_world_events_ungated(&[WorldEvent::SelfServerControlledMotion {
        data: Box::new(moveto_object_event_for(guid, target_guid, target_pos)),
        target_exists: true,
        object_radius: 0.5,
        object_height: 1.8,
    }]);
    assert!(movement.moveto_is_active(guid));

    // Held W (non-idle ManualSet) through the REAL ingest path.
    let now = Instant::now();
    movement.enqueue_drive_intent(
        PlayerDriveIntent::ManualHeld(MotionState::builder().run().forward().build()),
        now,
    );
    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("manual tick");

    let stop = movement.drive_local_moveto(now, &mut world);
    assert!(!stop, "manual lane owns the wire — no driver stop edge");
    assert!(!movement.moveto_is_active(guid), "0x36 cancel ran");
    assert_eq!(movement.take_moveto_completion(guid), Some(0x36));
}

/// Spec test 9/10 — a despawned target cancels 0x37 and owes the stop
/// edge; the registry consumer carries the resolved dims end-to-end
/// (the cylinder arrival uses them).
#[tokio::test]
async fn moveto_driver_target_loss_cancels_0x37() {
    use holtburger_world::WorldEvent;

    let mut world = WorldState::synthetic();
    let guid = Guid(0x5000_0123);
    let target_guid = Guid(0x8000_0042);
    let position = WorldPosition {
        landblock_id: Guid(0x1234_0019),
        coords: Vector3::new(50.0, 50.0, 0.0),
        rotation: Quaternion::from_heading(180.0_f32.to_radians()),
    };
    let target_pos = WorldPosition {
        landblock_id: Guid(0x1234_0019),
        coords: Vector3::new(60.0, 50.0, 0.0),
        rotation: Quaternion::identity(),
    };
    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);
    world
        .entities
        .insert(Entity::new(target_guid, "Drudge".to_string(), target_pos));

    let mut movement = MovementSystem::new();
    movement.apply_movement_world_events_ungated(&[WorldEvent::SelfServerControlledMotion {
        data: Box::new(moveto_object_event_for(guid, target_guid, target_pos)),
        target_exists: true,
        object_radius: 0.5,
        object_height: 1.8,
    }]);

    let now = Instant::now();
    assert!(!movement.drive_local_moveto(now, &mut world), "walking");

    // Target despawns → 0x37 + stop edge (acclient.c:346086).
    world.entities.remove(target_guid);
    let stop = movement.drive_local_moveto(now, &mut world);
    assert!(stop, "target loss owes the stop edge");
    assert_eq!(movement.take_moveto_completion(guid), Some(0x37));
    assert!(!movement.moveto_is_active(guid));
}

// =====================================================================
// A14-I2 (2026-06-12, W3+ S10) — wasm pursuit / turn-to intents
// (`PlayerDriveIntent::PursueObject/TurnToObject/TurnToHeading/
// CancelPursuit`, `?wasmPursuit=on`). The input-lane entry shape over
// the landed A3-D3 driver: ingest routing + the `last_manual_drive`
// restore arbitration (the charge-end WASD-stomp fix, retail
// acclient.c:346123/:339240 channel separation). Exercised through the
// `_ungated` seams while both consts ship default-off.
// =====================================================================

/// Drain-and-ingest helper: route an intent through the REAL
/// `enqueue_drive_intent` mapping + `ingest_drive_command` arms without
/// running a full tick (tick applies pursuits gated, the `_ungated`
/// house pattern applies them here).
fn ingest_intent(movement: &mut MovementSystem, intent: PlayerDriveIntent, now: Instant) {
    movement.enqueue_drive_intent(intent, now);
    for command in std::mem::take(&mut movement.queued_drive_commands) {
        movement.ingest_drive_command(command, now, Guid(0x5000_0123));
    }
}

/// Shared fixture: player at (50,50) facing EAST (AC heading 180)
/// directly at a target 10 m east — the entry turn node pops
/// immediately so the walk begins on the first driven frame (the
/// landed driver-test geometry).
fn pursuit_fixture() -> (WorldState, Guid, Guid) {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x5000_0123);
    let target_guid = Guid(0x8000_0042);
    let position = WorldPosition {
        landblock_id: Guid(0x1234_0019),
        coords: Vector3::new(50.0, 50.0, 0.0),
        rotation: Quaternion::from_heading(180.0_f32.to_radians()),
    };
    let target_pos = WorldPosition {
        landblock_id: Guid(0x1234_0019),
        coords: Vector3::new(60.0, 50.0, 0.0),
        rotation: Quaternion::identity(),
    };
    world.player.guid = guid;
    seed_local_player(&mut world, guid, position);
    world
        .entities
        .insert(Entity::new(target_guid, "Drudge".to_string(), target_pos));
    (world, guid, target_guid)
}

fn place_player_at_arrival(world: &mut WorldState) {
    let _ = world.set_local_player_runtime_pose(WorldPosition {
        landblock_id: Guid(0x1234_0019),
        coords: Vector3::new(59.5, 50.0, 0.0),
        rotation: Quaternion::from_heading(180.0_f32.to_radians()),
    });
}

fn pursue_intent(target: Guid) -> PlayerDriveIntent {
    PlayerDriveIntent::PursueObject {
        target,
        object_radius: 0.5,
        object_height: 1.8,
        run: true,
    }
}

/// S10 test 1 — THE stomp regression: a held W (non-idle ManualSet)
/// survives the pursuit's end. ManualSet(forward) → PursueObject
/// (manual stashed off the active slot) → arrival → active_drive is
/// Manual(forward) again, NO stop edge (retail channel separation,
/// acclient.c:346123/:339240; the legacy JS fake-WASD path zeroed it).
#[test]
fn held_manual_drive_survives_pursuit_end() {
    let (mut world, guid, target_guid) = pursuit_fixture();
    let mut movement = MovementSystem::new();
    let now = Instant::now();

    let held = MotionState::builder().run().forward().build();
    ingest_intent(&mut movement, PlayerDriveIntent::ManualHeld(held), now);
    ingest_intent(&mut movement, pursue_intent(target_guid), now);

    let stop = movement.apply_pending_pursuit_commands_ungated(&mut world);
    assert!(!stop, "install owes no stop edge");
    assert!(movement.moveto_is_active(guid));
    assert!(
        movement.active_drive.is_none(),
        "held manual drive is stashed off the active slot during pursuit"
    );

    // Frame 1: walk steering on the autonomous lane.
    assert!(!movement.drive_local_moveto(now, &mut world));
    assert!(matches!(
        movement.active_drive.map(|active| active.intent),
        Some(ActiveDriveIntent::Autonomous(_))
    ));

    // Arrival: restore the held manual drive instead of the stop edge.
    place_player_at_arrival(&mut world);
    let stop = movement.drive_local_moveto(now, &mut world);
    assert!(!stop, "restore replaces the stop edge");
    assert!(!movement.moveto_is_active(guid));
    assert!(
        matches!(
            movement.active_drive.map(|active| active.intent),
            Some(ActiveDriveIntent::Manual(state))
                if state == held
        ),
        "held W restored: {:?}",
        movement.active_drive
    );
    // The completion latch is left for the JS poll (status 2, read-clear).
    assert_eq!(movement.pursuit_status(guid), 2);
    assert_eq!(movement.pursuit_status(guid), 0, "read-clear");
}

/// S10 test 2 — all-keys-idle at pursuit end → the stop edge is owed
/// exactly once (no forward leak, ACE must see the stop).
#[test]
fn idle_hands_at_pursuit_end_owe_single_stop_edge() {
    let (mut world, guid, target_guid) = pursuit_fixture();
    let mut movement = MovementSystem::new();
    let now = Instant::now();

    // Record an IDLE manual state (all keys released before the click).
    ingest_intent(
        &mut movement,
        PlayerDriveIntent::ManualHeld(MotionState::default()),
        now,
    );
    ingest_intent(&mut movement, pursue_intent(target_guid), now);
    assert!(!movement.apply_pending_pursuit_commands_ungated(&mut world));
    assert!(!movement.drive_local_moveto(now, &mut world), "walking");

    place_player_at_arrival(&mut world);
    let stop = movement.drive_local_moveto(now, &mut world);
    assert!(stop, "idle hands → arrival owes the stop edge");
    assert!(movement.active_drive.is_none());
    assert!(
        !movement.drive_local_moveto(now, &mut world),
        "stop edge exactly once"
    );
    assert_eq!(movement.pursuit_status(guid), 2);
}

/// S10 test 3 — a non-idle ManualSet during pursuit cancels it (0x36,
/// status reads failed) and manual takes over the same tick (retail
/// apply_raw_movement → cancel_moveto(0x36), acclient.c:317421/:339240).
#[test]
fn nonidle_manual_set_cancels_pursuit_and_takes_over() {
    let (mut world, guid, target_guid) = pursuit_fixture();
    let mut movement = MovementSystem::new();
    let now = Instant::now();

    ingest_intent(&mut movement, pursue_intent(target_guid), now);
    assert!(!movement.apply_pending_pursuit_commands_ungated(&mut world));
    assert!(!movement.drive_local_moveto(now, &mut world), "walking");

    let held = MotionState::builder().run().forward().build();
    ingest_intent(&mut movement, PlayerDriveIntent::ManualHeld(held), now);
    let stop = movement.drive_local_moveto(now, &mut world);
    assert!(!stop, "manual lane owns the wire — no driver stop edge");
    assert!(!movement.moveto_is_active(guid), "0x36 cancel ran");
    assert_eq!(movement.pursuit_status(guid), 3 | (0x36 << 16));
    assert!(
        matches!(
            movement.active_drive.map(|active| active.intent),
            Some(ActiveDriveIntent::Manual(state)) if state == held
        ),
        "manual took over same tick"
    );
}

/// S10 test 4 — an explicit `Stop` cancels the pursuit (retail
/// StopCompletely runs through cancel_moveto, acclient.c:343611) with
/// NO manual restore and the stop edge owed.
#[test]
fn stop_command_cancels_pursuit_without_restore() {
    let (mut world, guid, target_guid) = pursuit_fixture();
    let mut movement = MovementSystem::new();
    let now = Instant::now();

    ingest_intent(
        &mut movement,
        PlayerDriveIntent::ManualHeld(MotionState::builder().run().forward().build()),
        now,
    );
    ingest_intent(&mut movement, pursue_intent(target_guid), now);
    assert!(!movement.apply_pending_pursuit_commands_ungated(&mut world));
    assert!(!movement.drive_local_moveto(now, &mut world), "walking");

    ingest_intent(&mut movement, PlayerDriveIntent::Stop, now);
    let stop = movement.apply_pending_pursuit_commands_ungated(&mut world);
    assert!(stop, "explicit Stop owes the stop edge");
    assert!(!movement.moveto_is_active(guid));
    assert_eq!(movement.pursuit_status(guid), 3 | (0x36 << 16));
    assert!(
        movement.active_drive.is_none(),
        "no manual restore on explicit Stop"
    );
}

/// S10 test 5 — status lifecycle 0 → 1 → 2 with read-clear, through
/// the REAL intent mapping; `CancelPursuit` (the JS charge-abort)
/// restores a held manual drive like any other pursuit end.
#[test]
fn pursuit_status_lifecycle_and_cancel_restore() {
    let (mut world, guid, target_guid) = pursuit_fixture();
    let mut movement = MovementSystem::new();
    let now = Instant::now();

    assert_eq!(movement.pursuit_status(guid), 0, "idle before any intent");

    ingest_intent(&mut movement, pursue_intent(target_guid), now);
    assert!(!movement.apply_pending_pursuit_commands_ungated(&mut world));
    assert_eq!(movement.pursuit_status(guid), 1, "active while pursuing");

    assert!(!movement.drive_local_moveto(now, &mut world));
    place_player_at_arrival(&mut world);
    assert!(movement.drive_local_moveto(now, &mut world));
    assert_eq!(movement.pursuit_status(guid), 2, "arrived");
    assert_eq!(movement.pursuit_status(guid), 0, "read-clear");
}

/// S10 test 5b — `CancelPursuit` (the JS charge-abort) restores a held
/// manual drive like any other pursuit end, with the 0x36 failure
/// latched for the poll. (The former "a SECOND pursuit defers behind
/// `motions_pending`" staging limitation is FIXED by A4/SA4F — see
/// `second_pursuit_entry_turn_begins_on_first_driver_frame` below.)
#[test]
fn cancel_pursuit_restores_held_manual_drive() {
    let (mut world, guid, target_guid) = pursuit_fixture();
    let mut movement = MovementSystem::new();
    let now = Instant::now();

    let held = MotionState::builder().run().forward().build();
    ingest_intent(&mut movement, PlayerDriveIntent::ManualHeld(held), now);
    ingest_intent(&mut movement, pursue_intent(target_guid), now);
    assert!(!movement.apply_pending_pursuit_commands_ungated(&mut world));
    assert!(!movement.drive_local_moveto(now, &mut world), "walking");
    assert!(movement.moveto_is_active(guid));

    ingest_intent(&mut movement, PlayerDriveIntent::CancelPursuit, now);
    let stop = movement.apply_pending_pursuit_commands_ungated(&mut world);
    assert!(!stop, "abort restores the held manual drive, no stop edge");
    assert!(!movement.moveto_is_active(guid));
    assert!(matches!(
        movement.active_drive.map(|active| active.intent),
        Some(ActiveDriveIntent::Manual(state)) if state == held
    ));
    assert_eq!(movement.pursuit_status(guid), 3 | (0x36 << 16));
}

/// S10 test 6 — no double-drive: while the pursuit steers, the active
/// drive is the autonomous steering intent, never a manual one (the
/// Track-B1 suppress pattern); an IDLE ManualSet mid-pursuit (key
/// release) is recorded but does NOT stomp the steering drive, and the
/// recorded idle governs the end (stop edge, not a stale-W restore).
#[test]
fn pursuit_active_suppresses_manual_double_drive_and_idle_does_not_stomp() {
    let (mut world, guid, target_guid) = pursuit_fixture();
    let mut movement = MovementSystem::new();
    let now = Instant::now();

    ingest_intent(
        &mut movement,
        PlayerDriveIntent::ManualHeld(MotionState::builder().run().forward().build()),
        now,
    );
    ingest_intent(&mut movement, pursue_intent(target_guid), now);
    assert!(!movement.apply_pending_pursuit_commands_ungated(&mut world));
    assert!(!movement.drive_local_moveto(now, &mut world));
    assert!(
        matches!(
            movement.active_drive.map(|active| active.intent),
            Some(ActiveDriveIntent::Autonomous(_))
        ),
        "pursuit steering rides the autonomous lane, no manual double-drive"
    );

    // Keys released mid-pursuit: recorded, NOT stomped.
    ingest_intent(
        &mut movement,
        PlayerDriveIntent::ManualHeld(MotionState::default()),
        now,
    );
    assert!(
        matches!(
            movement.active_drive.map(|active| active.intent),
            Some(ActiveDriveIntent::Autonomous(_))
        ),
        "idle ManualSet must not stomp the steering drive"
    );
    assert!(!movement.drive_local_moveto(now, &mut world), "still walking");
    assert!(movement.moveto_is_active(guid));

    // End: the recorded idle governs — stop edge, no stale-W restore.
    place_player_at_arrival(&mut world);
    assert!(movement.drive_local_moveto(now, &mut world));
    assert!(movement.active_drive.is_none());
    assert_eq!(movement.pursuit_status(guid), 2);
}

// =====================================================================
// A4/SA4F (2026-06-12) — per-entity AnimationDone feed: the
// `renderer_num_anims` classification (motion_interp.rs), the
// per-guid `notify_animation_done_for` route, and THE f6065782
// repeat-pursuit stall regression (url-flags.md `?wasmPursuit`
// "KNOWN STAGING LIMIT", now retired).
// =====================================================================

/// A4 regression — THE repeat-pursuit stall (spec SA4F §2/§5 item 1):
/// at pre-A4 HEAD every driver-lattice node enqueued `num_anims = 1`
/// and NOTHING ever fed the registry manager's `animation_done`, so
/// pursuit 1's walk/stop nodes wedged `motions_pending` true forever
/// and pursuit 2's `begin_turn_to_heading` deferred until the JS
/// monitor timeout (move_to.rs:773-775 ↔ acclient.c:345480-345481).
/// Post-A4: locomotion/turn/stop nodes are zero-anim
/// (`renderer_num_anims`), the `use_time_moveto` pump pops them, and a
/// SECOND pursuit's entry turn emits its do_motion + Turn steer on the
/// FIRST driver frame.
#[test]
fn second_pursuit_entry_turn_begins_on_first_driver_frame() {
    let (mut world, guid, target_guid) = pursuit_fixture();
    // Second target placed north-west of the arrival point so pursuit 2
    // NEEDS an entry turn (pursuit 1's fixture geometry pops its turn
    // node immediately — facing the target dead-on).
    let target2 = Guid(0x8000_0043);
    let target2_pos = WorldPosition {
        landblock_id: Guid(0x1234_0019),
        coords: Vector3::new(50.0, 60.0, 0.0),
        rotation: Quaternion::identity(),
    };
    world
        .entities
        .insert(Entity::new(target2, "Mosswart".to_string(), target2_pos));

    let mut movement = MovementSystem::new();
    let now = Instant::now();

    // Pursuit 1: walk east, arrive (the landed S10 flow).
    ingest_intent(&mut movement, pursue_intent(target_guid), now);
    assert!(!movement.apply_pending_pursuit_commands_ungated(&mut world));
    assert!(!movement.drive_local_moveto(now, &mut world), "walking");
    place_player_at_arrival(&mut world);
    assert!(movement.drive_local_moveto(now, &mut world), "arrival stop edge");
    assert_eq!(movement.pursuit_status(guid), 2, "pursuit 1 arrived");
    assert_eq!(movement.pursuit_status(guid), 0, "read-clear");

    // Pursuit 2 on the SAME manager.
    ingest_intent(&mut movement, pursue_intent(target2), now);
    assert!(!movement.apply_pending_pursuit_commands_ungated(&mut world));
    assert_eq!(movement.pursuit_status(guid), 1, "pursuit 2 active");

    // FIRST driver frame: the pre-frame pump clears pursuit 1's
    // zero-anim residue, `begin_turn_to_heading` passes the re-read
    // `motions_pending` gate and emits the entry-turn do_motion → the
    // Turn steer lands on the autonomous lane THIS frame. At pre-A4
    // HEAD this assertion fails: active_drive stays None (the turn
    // defers behind the wedged num_anims=1 nodes).
    assert!(!movement.drive_local_moveto(now, &mut world));
    match movement.active_drive.map(|active| active.intent) {
        Some(ActiveDriveIntent::Autonomous(intent)) => {
            assert!(
                intent.desired_world_delta.length_squared() < 1e-12,
                "entry turn steers in place (zero world delta)"
            );
            assert!(
                intent.desired_heading.is_some(),
                "entry turn carries the node heading"
            );
        }
        other => panic!(
            "second pursuit's entry turn must begin on the first driver frame, got {other:?}"
        ),
    }
    assert_eq!(movement.pursuit_status(guid), 1, "still steering — no failure latch");

    // SECOND driver frame: the pump completes the zero-anim turn node
    // itself — the lattice is clear (at pre-A4 HEAD this read true
    // forever: the wedge).
    assert!(!movement.drive_local_moveto(now, &mut world));
    assert!(
        !movement
            .movement_manager_for(guid)
            .expect("registry manager")
            .moveto_motions_pending(),
        "motions_pending wedge cleared between pursuits"
    );
    assert_eq!(movement.pursuit_status(guid), 1, "turn still in progress, no timeout path");
}

/// A4/SA4F — `notify_animation_done_for` routing: the local half stays
/// gate-shielded (`USE_MOTION_TABLE_QUEUE` off → the system-level
/// queue is untouched by the gated route), the registry half pops the
/// per-entity manager's spines, unknown guids and post-despawn
/// notifies no-op (map-miss, `system.rs` prune).
#[test]
fn notify_animation_done_for_routes_local_gated_and_registry() {
    let (mut world, guid, target_guid) = pursuit_fixture();
    let mut movement = MovementSystem::new();
    let now = Instant::now();
    const ACTION_X: u32 = 0x1000_0062;

    // Unknown guid, no managers anywhere → no-op (must not panic).
    movement.notify_animation_done_for(Guid(0xDEAD_BEEF), false, true);

    // System-level queue: a num_anims=1 node that the GATED local
    // route must NOT pop while USE_MOTION_TABLE_QUEUE is off.
    movement.motion_table_manager_mut().add_to_queue(ACTION_X, 1);

    // Registry manager via the ?wasmPursuit input lane; enqueue an
    // action node on BOTH of its spines through the facade.
    ingest_intent(&mut movement, pursue_intent(target_guid), now);
    assert!(!movement.apply_pending_pursuit_commands_ungated(&mut world));
    {
        let manager = movement.movement_manager_for_mut(guid).expect("registry manager");
        let mut effects = MotionSideEffects::default();
        let mvs = MovementStruct::Motion(
            crate::client::movement::motion_interp::MotionMovementStruct::InterpretedCommand {
                motion: ACTION_X,
                params: MovementParameters::default(),
            },
        );
        manager
            .perform_movement(&mvs, true, None, &mut effects)
            .expect("action dispatch");
        assert!(manager.moveto_motions_pending(), "action node pending on the registry interp");
    }

    // One renderer notify for the local guid: registry pops (Ready
    // seed + the action node), system queue survives the gate.
    movement.notify_animation_done_for(guid, true, true);
    assert!(
        !movement
            .movement_manager_for(guid)
            .expect("registry manager")
            .moveto_motions_pending(),
        "registry spines drained by the per-entity feed"
    );
    let _ = movement.motion_table_manager_mut().drain_events();
    movement.notify_animation_done_ungated(true);
    assert!(
        movement
            .motion_table_manager_mut()
            .drain_events()
            .iter()
            .any(|event| matches!(
                event,
                MotionTableEvent::MotionDone { motion: ACTION_X, success: true }
            )),
        "system-level node survived the GATED local route (popped only by the ungated seam)"
    );

    // Post-despawn: the manager is pruned; a late notify is a map-miss
    // no-op (spec §7 OQ-4 fallback: eviction-after-despawn is safe by
    // construction).
    movement.apply_movement_world_events_ungated(&[holtburger_world::WorldEvent::EntityDespawned(
        guid,
    )]);
    assert!(movement.movement_manager_for(guid).is_none());
    movement.notify_animation_done_for(guid, false, true);
}

/// A4-Q3 — `handle_exit_world_for` routing (the `PlayerTeleport`
/// exit-world drain, retail `CPhysicsObj::exit_world` →
/// `MotionTableManager::HandleExitWorld` success=0 +
/// `MovementManager::HandleExitWorld`, acclient.c:322215-322220 →
/// :329940-329947, :339411-339417): unknown guids no-op; the local
/// half stays gate-shielded (`USE_MOTION_TABLE_QUEUE` off → the
/// system-level queue is untouched by the gated route; only the
/// `_ungated` seam drains it, with `success=false`); the registry half
/// drains BOTH manager spines so a teleport mid-action cannot wedge
/// `motions_pending`.
#[test]
fn handle_exit_world_for_drains_registry_and_respects_gate() {
    let (mut world, guid, target_guid) = pursuit_fixture();
    let mut movement = MovementSystem::new();
    let now = Instant::now();
    const ACTION_X: u32 = 0x1000_0062;

    // Unknown guid, no managers anywhere → no-op (must not panic).
    movement.handle_exit_world_for(Guid(0xDEAD_BEEF), false);

    // System-level queue: a num_anims=1 node the GATED local route
    // must NOT drain while USE_MOTION_TABLE_QUEUE is off.
    movement.motion_table_manager_mut().add_to_queue(ACTION_X, 1);

    // Registry manager via the ?wasmPursuit input lane; enqueue an
    // action node on BOTH of its spines through the facade.
    ingest_intent(&mut movement, pursue_intent(target_guid), now);
    assert!(!movement.apply_pending_pursuit_commands_ungated(&mut world));
    {
        let manager = movement.movement_manager_for_mut(guid).expect("registry manager");
        let mut effects = MotionSideEffects::default();
        let mvs = MovementStruct::Motion(
            crate::client::movement::motion_interp::MotionMovementStruct::InterpretedCommand {
                motion: ACTION_X,
                params: MovementParameters::default(),
            },
        );
        manager
            .perform_movement(&mvs, true, None, &mut effects)
            .expect("action dispatch");
        assert!(manager.moveto_motions_pending(), "action node pending on the registry interp");
    }

    // One exit-world for the local guid: the registry manager drains
    // (queue success=0 → MotionDone fan-out, then the minterp drain),
    // the system-level queue survives the compile-time gate.
    movement.handle_exit_world_for(guid, true);
    assert!(
        !movement
            .movement_manager_for(guid)
            .expect("registry manager")
            .moveto_motions_pending(),
        "registry spines drained by the exit-world drain"
    );
    let _ = movement.motion_table_manager_mut().drain_events();
    movement.handle_exit_world_local_ungated();
    assert!(
        movement
            .motion_table_manager_mut()
            .drain_events()
            .iter()
            .any(|event| matches!(
                event,
                MotionTableEvent::MotionDone { motion: ACTION_X, success: false }
            )),
        "system-level node survived the GATED local route and drains success=0 \
         only through the ungated seam (retail success=0, acclient.c:329940-329947)"
    );

    // A second drain on the now-empty queues is a no-op (the
    // acclient.c:329884 head-null guard) — the duplicate-trigger /
    // JS-notify-after-drain safety A4-Q3 relies on.
    movement.handle_exit_world_for(guid, true);
    assert!(movement.motion_table_manager_mut().drain_events().is_empty());
}

// =====================================================================
// A14-I3 (2026-06-12, `?retailRunKeys=on`) — retail autorun
// (`CommandInterpreter::auto_run`): SetAutoRun edge semantics
// (acclient.c:718254-718292) + the ApplyCurrentMovement re-issue branch
// (forward at autorun_speed with hold_run=1, SubstateList ignored,
// acclient.c:717027-717064; NukeCommand substate suppression :717472).
// Pure MovementSystem state tests — no world needed (the drive only
// emits once ticks run; these pin the effective active_drive shape).
// =====================================================================

/// Engaging autorun from idle installs the forward+Run drive (retail
/// ApplyCurrentMovement auto_run branch) and queues a pursuit cancel
/// WITHOUT manual restore (retail SetAutoRun(1) runs StopMoveTo first,
/// acclient.c:718268).
#[test]
fn auto_run_engage_installs_forward_run_and_cancels_pursuit() {
    let mut movement = MovementSystem::new();
    movement.set_auto_run(true);

    match movement.active_drive.map(|a| a.intent) {
        Some(ActiveDriveIntent::Manual(state)) => {
            assert_eq!(state.forward, Some(ForwardLocomotion::Forward));
            assert_eq!(state.gait, Gait::Run);
            assert!(state.sidestep.is_none() && state.turning.is_none());
        }
        other => panic!("expected Manual(forward+Run), got {other:?}"),
    }
    assert_eq!(
        movement.pending_pursuit_commands,
        vec![PendingPursuitCommand::Cancel {
            restore_manual: false
        }],
        "engage queues exactly one no-restore cancel"
    );
}

/// While autorun, held forward/backstep keys are overridden (the
/// SubstateList suppression) but sidestep + turn pass through
/// (acclient.c:717066+ Turn/Sidestep lists still apply).
#[test]
fn auto_run_overrides_forward_keys_but_keeps_sidestep_turn() {
    let mut movement = MovementSystem::new();
    movement.set_auto_run(true);

    let held = MotionState::builder()
        .walk()
        .backstep()
        .strafe_left()
        .turn_right()
        .build();
    ingest_intent(
        &mut movement,
        PlayerDriveIntent::ManualHeld(held),
        Instant::now(),
    );

    match movement.active_drive.map(|a| a.intent) {
        Some(ActiveDriveIntent::Manual(state)) => {
            assert_eq!(
                state.forward,
                Some(ForwardLocomotion::Forward),
                "backstep overridden to forward while auto_run"
            );
            assert_eq!(state.gait, Gait::Run, "hold_run=1 while auto_run");
            assert_eq!(state.sidestep, Some(SidestepLocomotion::StrafeLeft));
            assert_eq!(state.turning, Some(Turn::Right));
        }
        other => panic!("expected overlaid Manual drive, got {other:?}"),
    }
    assert_eq!(
        movement.last_manual_drive,
        Some(held),
        "raw keys recorded un-overlaid for the toggle-off restore"
    );
}

/// Toggling autorun OFF restores the held manual state (retail:
/// ApplyCurrentMovement falls back to the SubstateList head), and an
/// all-released keyboard restores idle.
#[test]
fn auto_run_off_restores_held_manual_state() {
    let mut movement = MovementSystem::new();
    let held = MotionState::builder().walk().backstep().build();
    ingest_intent(
        &mut movement,
        PlayerDriveIntent::ManualHeld(held),
        Instant::now(),
    );
    movement.set_auto_run(true);
    movement.set_auto_run(false);

    assert_eq!(
        movement.active_drive.map(|a| a.intent),
        Some(ActiveDriveIntent::Manual(held)),
        "held backstep restored on toggle-off"
    );

    // No held keys at all → toggle-off restores idle (Ready analog).
    let mut movement2 = MovementSystem::new();
    movement2.set_auto_run(true);
    movement2.set_auto_run(false);
    match movement2.active_drive.map(|a| a.intent) {
        Some(ActiveDriveIntent::Manual(state)) => {
            assert!(state.is_locomotion_idle() && state.turning.is_none());
        }
        other => panic!("expected idle Manual drive, got {other:?}"),
    }
}

/// Same-value SetAutoRun calls no-op (the `(val == 0) != (auto_run ==
/// 0)` edge guard, acclient.c:718263) — no duplicate cancel, no drive
/// churn.
#[test]
fn auto_run_same_value_is_a_noop() {
    let mut movement = MovementSystem::new();
    movement.set_auto_run(true);
    let drive_after_first = movement.active_drive;
    movement.set_auto_run(true);
    assert_eq!(movement.active_drive, drive_after_first);
    assert_eq!(
        movement.pending_pursuit_commands.len(),
        1,
        "second engage queues no duplicate cancel"
    );
    movement.set_auto_run(false);
    movement.set_auto_run(false);
    assert_eq!(
        movement.pending_pursuit_commands.len(),
        1,
        "disengage queues nothing"
    );
}

/// Default state is inert: a fresh system never overlays (flag-off /
/// never-toggled byte-identical guarantee).
#[test]
fn auto_run_default_off_keeps_manual_drive_verbatim() {
    let mut movement = MovementSystem::new();
    let held = MotionState::builder().walk().backstep().turn_left().build();
    ingest_intent(
        &mut movement,
        PlayerDriveIntent::ManualHeld(held),
        Instant::now(),
    );
    assert_eq!(
        movement.active_drive.map(|a| a.intent),
        Some(ActiveDriveIntent::Manual(held)),
        "no overlay without set_auto_run(true)"
    );
}

// ─── USE_CAST_MOVE (2026-07-02) — retail cast-movement arbitration ───────────

/// The retail autonomy latch (mage-PvP mechanism hunt 2026-07-03): a
/// non-autonomous server motion LOWERS it (`SetObjectMovement` stamps
/// the wire flag, acclient.c:311185-311193) and the interpreted state
/// drives; re-ingesting the IDENTICAL held state is NOT an edge (held
/// keys never re-fire, :717102/:717429); a CHANGED manual state is a
/// fresh `DoMotion`/`StopMotion` (:317325/:317364) and RAISES it —
/// press AND release both count.
#[test]
fn autonomy_latch_lowered_by_wire_raised_by_input_edge() {
    let mut movement = MovementSystem::new();
    let held = MotionState::builder().run().forward().build();
    // First input edge raises the boot-default-low latch (retail ctor
    // inits 0, :319552).
    ingest_intent(
        &mut movement,
        PlayerDriveIntent::ManualHeld(held),
        Instant::now(),
    );
    assert!(
        !movement.interpreted_movement_active(),
        "input edge raises the latch — raw drives"
    );
    // A server-played cast gesture arrives (non-autonomous unpack).
    movement.note_server_authored_motion(false);
    assert!(
        movement.interpreted_movement_active(),
        "wire lowers the latch — interpreted drives"
    );
    // A re-send of the identical held axes is NOT an input edge.
    ingest_intent(
        &mut movement,
        PlayerDriveIntent::ManualHeld(held),
        Instant::now(),
    );
    assert!(
        movement.interpreted_movement_active(),
        "identical re-send does not defeat the gesture"
    );
    // A CHANGED state is a fresh DoMotion — autonomy regained.
    let changed = MotionState::builder().run().forward().strafe_left().build();
    ingest_intent(
        &mut movement,
        PlayerDriveIntent::ManualHeld(changed),
        Instant::now(),
    );
    assert!(
        !movement.interpreted_movement_active(),
        "input edge regains autonomy"
    );
    // The next server motion (e.g. the following windup) re-lowers it.
    movement.note_server_authored_motion(false);
    assert!(movement.interpreted_movement_active());
    // A key RELEASE (all axes idle) is ALSO an edge — retail StopMotion
    // sets the latch too (:317364).
    let idle = MotionState::builder().build();
    ingest_intent(
        &mut movement,
        PlayerDriveIntent::ManualHeld(idle),
        Instant::now(),
    );
    assert!(
        !movement.interpreted_movement_active(),
        "release edge regains autonomy"
    );
}

/// While the latch is low the drive comes from the INTERPRETED slots —
/// retail `apply_interpreted_movement` (acclient.c:344147): the gesture
/// occupies the forward slot (mapped to `None` = zero forward velocity)
/// while the INDEPENDENT sidestep/turn slots keep flowing (slidecast).
#[test]
fn interpreted_drive_state_preserves_echoed_sidestep_and_kills_forward() {
    use crate::client::movement::interp_state::InterpretedState;
    let manual = MotionState::builder().run().forward().build();

    // Gesture in the forward slot (non-locomotion substate → None) +
    // echoed left strafe: forward dies, strafe flows.
    let mut interp = InterpretedState::default();
    interp.apply_motion(0x4000_0070, 1.0); // MagicPowerUp02 windup
    interp.apply_motion(0x6500_000F, -1.0); // SideStepRight, negative = left
    let driven = MovementSystem::interpreted_drive_state(Some(&interp), manual);
    assert_eq!(driven.forward, None, "gesture owns the forward slot");
    assert_eq!(
        driven.sidestep,
        Some(SidestepLocomotion::StrafeLeft),
        "echoed strafe keeps flowing — slidecast"
    );

    // Interpreted locomotion (server-controlled walk) maps with the
    // signed speed: negative forward = backstep.
    let mut interp = InterpretedState::default();
    interp.apply_motion(0x4500_0005, -1.0); // WalkForward, negative speed
    let driven = MovementSystem::interpreted_drive_state(Some(&interp), manual);
    assert_eq!(driven.forward, Some(ForwardLocomotion::Backstep));

    // No registry entry yet → locomotion-idle.
    let driven = MovementSystem::interpreted_drive_state(None, manual);
    assert!(driven.forward.is_none() && driven.sidestep.is_none() && driven.turning.is_none());
}

/// USE_CAST_MOVE per-axis edges (2026-07-03, mage-PvP strafecast) — a
/// strafe/turn tap mid-gesture writes ONLY its own axis (retail
/// per-axis CommandLists: AddCommand acclient.c:717429 / NukeCommand
/// :717458 dispatch single-axis DoMotions): a held W does NOT resurrect
/// on the tap — the gesture keeps the forward slot until a FORWARD
/// edge.
#[test]
fn cast_move_edge_merges_per_axis_held_forward_stays_dead() {
    let mut movement = MovementSystem::new();
    let now = Instant::now();

    // Hold W (raw edge — raw drives).
    let held_w = MotionState::builder().run().forward().build();
    ingest_intent(&mut movement, PlayerDriveIntent::ManualHeld(held_w), now);

    // A cast windup echo lands (non-autonomous) — interpreted drives,
    // forward dies (no registry entry in this fixture → all axes idle).
    movement.note_server_authored_motion(false);
    assert!(movement.interpreted_movement_active());

    // Strafe tap while STILL holding W: the sidestep axis changed, the
    // forward axis did not — forward must NOT resurrect.
    let held_w_and_a = MotionState::builder()
        .run()
        .forward()
        .strafe_left()
        .build();
    ingest_intent(
        &mut movement,
        PlayerDriveIntent::ManualHeld(held_w_and_a),
        now,
    );
    assert!(
        !movement.interpreted_movement_active(),
        "the tap regains autonomy"
    );
    let effective = match movement.active_drive.map(|a| a.intent) {
        Some(ActiveDriveIntent::Manual(state)) => state,
        other => panic!("expected a manual drive, got {other:?}"),
    };
    assert_eq!(
        effective.forward, None,
        "held W does not resurrect on a strafe tap — the gesture keeps the forward slot"
    );
    assert_eq!(
        effective.sidestep,
        Some(SidestepLocomotion::StrafeLeft),
        "the edged axis drives"
    );

    // W release then re-press: the FORWARD edge takes the slot back
    // (fastcast's tap-to-break); the held strafe carries over.
    let strafe_only = MotionState::builder().run().strafe_left().build();
    ingest_intent(
        &mut movement,
        PlayerDriveIntent::ManualHeld(strafe_only),
        now,
    );
    ingest_intent(
        &mut movement,
        PlayerDriveIntent::ManualHeld(held_w_and_a),
        now,
    );
    let effective = match movement.active_drive.map(|a| a.intent) {
        Some(ActiveDriveIntent::Manual(state)) => state,
        other => panic!("expected a manual drive, got {other:?}"),
    };
    assert_eq!(
        effective.forward,
        Some(ForwardLocomotion::Forward),
        "a fresh forward edge drives forward"
    );
    assert_eq!(
        effective.sidestep,
        Some(SidestepLocomotion::StrafeLeft),
        "the un-edged strafe carries across the forward edge"
    );
}

/// USE_SLIDE_CAST (2026-07-03, mage-PvP strafecast) — the HELD manual
/// sidestep/turn survive a General (case-0) stomp for the local player
/// (ACE echoes every cast gesture with EMPTY axes; retail never
/// re-stomped the caster). Forward is NEVER persisted. `=off` restores
/// the bare stomp.
#[test]
fn slide_cast_persists_held_strafe_and_turn_through_general_stomp() {
    use holtburger_protocol::messages::{
        MovementEventData, MovementInvalid, MovementType, MovementTypeData,
    };
    use holtburger_world::WorldEvent;

    let guid = Guid(0x5000_0777);
    let stomp = |movement: &mut MovementSystem| {
        let motion = MovementEventData {
            guid,
            object_instance_sequence: 1,
            movement_sequence: 1,
            server_control_sequence: 1,
            is_autonomous: false,
            movement_type: MovementType::Invalid,
            motion_flags: 0,
            current_style: MotionStance::Magic.interpreted(),
            data: MovementTypeData::Invalid(MovementInvalid::default()),
        };
        movement.apply_movement_world_events_ungated(&[WorldEvent::SelfServerControlledMotion {
            data: Box::new(motion),
            target_exists: false,
            object_radius: 0.0,
            object_height: 0.0,
        }]);
    };
    let interp_axes = |movement: &MovementSystem| {
        let interp = movement
            .movement_managers
            .get(&guid)
            .and_then(|manager| manager.motion_interp_ref())
            .expect("stomp created the manager");
        (
            interp.interpreted_state.forward_command,
            interp.interpreted_state.sidestep,
            interp.interpreted_state.sidestep_speed,
            interp.interpreted_state.turn,
            interp.interpreted_state.turn_speed,
        )
    };

    // Held left strafe + right turn (the dance keys) at stomp time.
    let mut movement = MovementSystem::new();
    let held = MotionState::builder()
        .run()
        .strafe_left()
        .turn_right()
        .build();
    ingest_intent(
        &mut movement,
        PlayerDriveIntent::ManualHeld(held),
        Instant::now(),
    );
    stomp(&mut movement);
    let (forward, sidestep, sidestep_speed, turn, turn_speed) = interp_axes(&movement);
    assert_eq!(forward, None, "forward is NEVER persisted");
    assert!(sidestep, "held strafe rides through the stomp");
    assert_eq!(sidestep_speed, -1.0, "left = negative normal form");
    assert!(turn, "held turn rides through the stomp");
    assert_eq!(turn_speed, 1.0, "right = positive normal form");

    // Nothing held → the stomp's empty axes stand.
    let mut movement = MovementSystem::new();
    let idle = MotionState::builder().build();
    ingest_intent(
        &mut movement,
        PlayerDriveIntent::ManualHeld(idle),
        Instant::now(),
    );
    stomp(&mut movement);
    let (_, sidestep, _, turn, _) = interp_axes(&movement);
    assert!(!sidestep && !turn, "idle keys persist nothing");

    // `?slideCast=off` — the bare stomp (strafe dies per echo).
    let mut movement = MovementSystem::new();
    movement.set_slide_cast(false);
    ingest_intent(
        &mut movement,
        PlayerDriveIntent::ManualHeld(held),
        Instant::now(),
    );
    stomp(&mut movement);
    let (_, sidestep, _, turn, _) = interp_axes(&movement);
    assert!(!sidestep && !turn, "flag off restores the bare stomp");
}
// ---------------------------------------------------------------------------
// Golden-trace fixed-dt harness (physics parity 2026-07-03; dossier §4
// determinism plan). Scripted fixed-dt timelines drive the SAME seam the
// tests above use (`advance_local_pose_for_manual_drive`) and every frame's
// pose/velocity is pinned via `f32::to_bits` against checked-in vectors —
// bit-determinism across holtburger runs, and a freeze on the retail
// integrator order (entry clamp → stop check → position → velocity,
// acclient.c:317701-317786) so any reorder shows up as a bit diff.
//
// Goldens are toolchain-hostage only through libm `powf` (the landing
// friction); IEEE add/mul/div/sqrt are single-rounded everywhere else.
// REGENERATE after an intentional physics change with:
//   cargo test -p holtburger-core --lib golden::regen -- --ignored --nocapture
// then paste the printed consts over the ones below.
// ---------------------------------------------------------------------------
mod golden {
    use super::*;

    /// 60 fps frame dt. Under the DEFAULT quantum shape the handle path
    /// accumulates two of these to one ~1/30 s slice (frames alternate
    /// integrate/skip); the goldens pin that cadence too.
    const FIXED_DT: f32 = 0.016667;

    /// One recorded frame: pose x/y/z, planar vx/vy, vz — as bits.
    type Frame = [u32; 6];

    fn snapshot(world: &WorldState) -> Frame {
        let pose = world.local_player_runtime_pose().expect("pose seeded");
        [
            pose.coords.x.to_bits(),
            pose.coords.y.to_bits(),
            pose.coords.z.to_bits(),
            world.player.current_planar_velocity.x.to_bits(),
            world.player.current_planar_velocity.y.to_bits(),
            world.player.vertical_velocity.to_bits(),
        ]
    }

    /// Grounded player on a flat outdoor terrain plane at z = 10.
    fn seed_flat_world(guid: Guid, state: MotionState) -> (WorldState, MovementSystem) {
        let mut world = WorldState::synthetic();
        world.player.guid = guid;
        let _ = seed_self_movement_capabilities_override(&mut world, 1.0, 1.0, 4.5, 1.5);
        let start_pose = WorldPosition {
            landblock_id: Guid(0xA9B40001),
            coords: Vector3::new(100.0, 100.0, 10.0),
            rotation: Quaternion::identity(),
        };
        seed_local_player(&mut world, guid, start_pose);
        let _ = world.set_player_position(start_pose);
        world.populate_terrain_heights(0xA9B4_0000, [10.0_f32; 81]);
        let mut movement = MovementSystem::new();
        // Direct drive install = post-first-edge state: the latch is up
        // (retail DoMotion acclient.c:317325; live ingest raises it).
        movement.last_move_was_autonomous = true;
        movement.active_drive = Some(ActiveDriveState::manual(state, None));
        (world, movement)
    }

    fn drive(world: &mut WorldState, movement: &MovementSystem, frames: usize) -> Vec<Frame> {
        let mut out = Vec::with_capacity(frames);
        for _ in 0..frames {
            movement.advance_local_pose_for_manual_drive(
                world,
                Duration::from_secs_f32(FIXED_DT),
            );
            out.push(snapshot(world));
        }
        out
    }

    /// Scenario: flat direct-set walk — run-forward on flat ground,
    /// 24 frames. Pins the grounded direct-set target + snap and the
    /// 30 Hz accumulate cadence.
    fn trace_flat_walk() -> Vec<Frame> {
        let (mut world, movement) =
            seed_flat_world(Guid(0x5000_0F01), MotionState::builder().run().forward().build());
        drive(&mut world, &movement, 24)
    }

    /// Scenario: full standing vertical jump arc — begin_jump(3.0) from
    /// the flat floor, 48 frames (~0.8 s sim): ascent, the retail apex
    /// stop-check quantum (entry |v| < 0.2504 → v zeroed, half-step-only
    /// offset, acclient.c:317750-317756), descent, terrain landing (+ the
    /// landing residual tail, a no-op at planar 0), grounded tail.
    fn trace_jump_arc() -> Vec<Frame> {
        let (mut world, movement) =
            seed_flat_world(Guid(0x5000_0F02), MotionState::builder().run().build());
        world.player.begin_jump(3.0);
        drive(&mut world, &movement, 48)
    }

    /// Scenario: knockback-shaped landing — descending at −1 m/s with a
    /// 4 m/s planar carry, no input held. Pins the landing residual
    /// friction (`pow(0.05, q)` at the retail 0.95 coefficient) + the
    /// next grounded slice's direct-set-to-zero snap.
    fn trace_knockback_landing() -> Vec<Frame> {
        let (mut world, movement) =
            seed_flat_world(Guid(0x5000_0F03), MotionState::builder().run().build());
        world.player.begin_fall();
        world.player.current_planar_velocity = Vector3::new(0.0, 4.0, 0.0);
        world.player.vertical_velocity = -1.0;
        // Lift the pose so the fall takes a few slices to land
        // (~0.23 s at −1 m/s under gravity → lands inside 16 frames).
        let mut pose = world.local_player_runtime_pose().expect("pose");
        pose.coords.z = 10.4;
        let _ = world.set_player_position(pose);
        drive(&mut world, &movement, 16)
    }

    /// Scenario: huge-frame drop — mid-fall, one dt = 2.5 s frame is
    /// consumed WITHOUT integrating (quantum_slices → None, accumulator
    /// reset; retail :323127/:323145), then normal frames resume.
    fn trace_huge_frame() -> Vec<Frame> {
        let (mut world, movement) =
            seed_flat_world(Guid(0x5000_0F04), MotionState::builder().run().build());
        world.player.begin_fall();
        let mut pose = world.local_player_runtime_pose().expect("pose");
        pose.coords.z = 60.0;
        let _ = world.set_player_position(pose);
        let mut out = drive(&mut world, &movement, 4);
        movement.advance_local_pose_for_manual_drive(&mut world, Duration::from_secs_f32(2.5));
        out.push(snapshot(&world));
        out.extend(drive(&mut world, &movement, 4));
        out
    }

    /// Schedule-trace word stream: per scripted frame push
    /// `slice_count`, each slice's bits, then the post-frame bank bits.
    /// The dt script covers the dossier probe set (sub-epsilon, 60 fps,
    /// sub-MAX, multi-slice, carry-producing, huge) with the bank
    /// threaded exactly as the two production paths thread it.
    const SCHEDULE_SCRIPT: [f32; 8] =
        [0.0001, 0.016667, 0.016667, 0.15, 0.45, 0.42, 2.5, 0.016667];

    /// DEFAULT (ACE-shaped) machinery: `quantum_slices` + the
    /// accumulate-to-1/30 bank (`advance_local_pose_for_manual_drive`).
    fn trace_schedule_default() -> Vec<u32> {
        let mut out = Vec::new();
        let mut bank = 0.0_f32;
        for dt in SCHEDULE_SCRIPT {
            let total = bank + dt;
            match quantum_slices(total) {
                None => {
                    bank = 0.0;
                    out.push(0);
                }
                Some(slices) => {
                    let consumed: f32 = slices.iter().sum();
                    bank = (total - consumed).max(0.0);
                    out.push(slices.len() as u32);
                    out.extend(slices.iter().map(|s| s.to_bits()));
                }
            }
            out.push(bank.to_bits());
        }
        out
    }

    /// RETAIL machinery (`USE_RETAIL_QUANTUM` shape): the sub-epsilon
    /// frame is CONSUMED (bank stays 0 — retail-quantum consume-skip),
    /// 60 fps frames integrate DIRECTLY, slices are 0.2, the 0.42-frame
    /// tail banks. Schedule-level because the const default is OFF; the
    /// path wiring above it is a shared for-over-slices.
    fn trace_schedule_retail() -> Vec<u32> {
        let mut out = Vec::new();
        let mut bank = 0.0_f32;
        for dt in SCHEDULE_SCRIPT {
            let (slices, carry) = retail_quantum_schedule(bank + dt);
            bank = carry;
            out.push(slices.len() as u32);
            out.extend(slices.iter().map(|s| s.to_bits()));
            out.push(bank.to_bits());
        }
        out
    }

    fn print_frames(name: &str, frames: &[Frame]) {
        println!("    const {name}: [[u32; 6]; {}] = [", frames.len());
        for f in frames {
            println!(
                "        [0x{:08X}, 0x{:08X}, 0x{:08X}, 0x{:08X}, 0x{:08X}, 0x{:08X}],",
                f[0], f[1], f[2], f[3], f[4], f[5]
            );
        }
        println!("    ];");
    }

    fn print_words(name: &str, words: &[u32]) {
        println!("    const {name}: [u32; {}] = [", words.len());
        for chunk in words.chunks(6) {
            let row: Vec<String> = chunk.iter().map(|w| format!("0x{w:08X}")).collect();
            println!("        {},", row.join(", "));
        }
        println!("    ];");
    }

    /// Regeneration one-liner (see module doc): prints every golden as
    /// paste-ready Rust.
    #[test]
    #[ignore]
    fn regen() {
        print_frames("GOLDEN_FLAT_WALK", &trace_flat_walk());
        print_frames("GOLDEN_JUMP_ARC", &trace_jump_arc());
        print_frames("GOLDEN_KNOCKBACK_LANDING", &trace_knockback_landing());
        print_frames("GOLDEN_HUGE_FRAME", &trace_huge_frame());
        print_words("GOLDEN_SCHEDULE_DEFAULT", &trace_schedule_default());
        print_words("GOLDEN_SCHEDULE_RETAIL", &trace_schedule_retail());
    }

    fn assert_frames(name: &str, actual: &[Frame], golden: &[[u32; 6]]) {
        assert_eq!(
            actual.len(),
            golden.len(),
            "{name}: frame count changed — regenerate the goldens (module doc)"
        );
        for (i, (a, g)) in actual.iter().zip(golden.iter()).enumerate() {
            for (j, (ab, gb)) in a.iter().zip(g.iter()).enumerate() {
                assert_eq!(
                    ab, gb,
                    "{name}: frame {i} field {j} drifted: golden {:?} (0x{gb:08X}) \
                     vs got {:?} (0x{ab:08X}) — an intentional physics change \
                     must regenerate the goldens (module doc)",
                    f32::from_bits(*gb),
                    f32::from_bits(*ab),
                );
            }
        }
    }

    fn assert_words(name: &str, actual: &[u32], golden: &[u32]) {
        assert_eq!(
            actual, golden,
            "{name}: schedule trace drifted — regenerate (module doc)"
        );
    }

    // Checked-in golden vectors (regenerate per the module doc).
    const GOLDEN_FLAT_WALK: [[u32; 6]; 24] = [
        [0x42C80000, 0x42C80000, 0x41200000, 0x00000000, 0x00000000, 0x00000000],
        [0x42C80000, 0x42C84CCD, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42C84CCD, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42C8999A, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42C8999A, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42C8E667, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42C8E667, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42C93334, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42C93334, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42C98001, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42C98001, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42C9CCCE, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42C9CCCE, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42CA199B, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42CA199B, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42CA6668, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42CA6668, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42CAB335, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42CAB335, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42CB0002, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42CB0002, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42CB4CCF, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42CB4CCF, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
        [0x42C80000, 0x42CB999C, 0x41200000, 0x345334D4, 0x40900000, 0x00000000],
    ];
    const GOLDEN_JUMP_ARC: [[u32; 6]; 48] = [
        [0x42C80000, 0x42C80000, 0x41200000, 0x00000000, 0x00000000, 0x40400000],
        [0x42C80000, 0x42C80000, 0x4121834F, 0x00000000, 0x00000000, 0x402B17C9],
        [0x42C80000, 0x42C80000, 0x4121834F, 0x00000000, 0x00000000, 0x402B17C9],
        [0x42C80000, 0x42C80000, 0x4122DA03, 0x00000000, 0x00000000, 0x40162F92],
        [0x42C80000, 0x42C80000, 0x4122DA03, 0x00000000, 0x00000000, 0x40162F92],
        [0x42C80000, 0x42C80000, 0x4124041D, 0x00000000, 0x00000000, 0x4001475B],
        [0x42C80000, 0x42C80000, 0x4124041D, 0x00000000, 0x00000000, 0x4001475B],
        [0x42C80000, 0x42C80000, 0x4125019D, 0x00000000, 0x00000000, 0x3FD8BE49],
        [0x42C80000, 0x42C80000, 0x4125019D, 0x00000000, 0x00000000, 0x3FD8BE49],
        [0x42C80000, 0x42C80000, 0x4125D282, 0x00000000, 0x00000000, 0x3FAEEDDC],
        [0x42C80000, 0x42C80000, 0x4125D282, 0x00000000, 0x00000000, 0x3FAEEDDC],
        [0x42C80000, 0x42C80000, 0x412676CD, 0x00000000, 0x00000000, 0x3F851D6F],
        [0x42C80000, 0x42C80000, 0x412676CD, 0x00000000, 0x00000000, 0x3F851D6F],
        [0x42C80000, 0x42C80000, 0x4126EE7E, 0x00000000, 0x00000000, 0x3F369A04],
        [0x42C80000, 0x42C80000, 0x4126EE7E, 0x00000000, 0x00000000, 0x3F369A04],
        [0x42C80000, 0x42C80000, 0x41273995, 0x00000000, 0x00000000, 0x3EC5F253],
        [0x42C80000, 0x42C80000, 0x41273995, 0x00000000, 0x00000000, 0x3EC5F253],
        [0x42C80000, 0x42C80000, 0x41275811, 0x00000000, 0x00000000, 0x3D7584F0],
        [0x42C80000, 0x42C80000, 0x41275811, 0x00000000, 0x00000000, 0x3D7584F0],
        [0x42C80000, 0x42C80000, 0x412741C4, 0x00000000, 0x00000000, 0xBEA741B5],
        [0x42C80000, 0x42C80000, 0x412741C4, 0x00000000, 0x00000000, 0xBEA741B5],
        [0x42C80000, 0x42C80000, 0x4126FEDD, 0x00000000, 0x00000000, 0xBF2741B5],
        [0x42C80000, 0x42C80000, 0x4126FEDD, 0x00000000, 0x00000000, 0xBF2741B5],
        [0x42C80000, 0x42C80000, 0x41268F5B, 0x00000000, 0x00000000, 0xBF7AE290],
        [0x42C80000, 0x42C80000, 0x41268F5B, 0x00000000, 0x00000000, 0xBF7AE290],
        [0x42C80000, 0x42C80000, 0x4125F33F, 0x00000000, 0x00000000, 0xBFA741B5],
        [0x42C80000, 0x42C80000, 0x4125F33F, 0x00000000, 0x00000000, 0xBFA741B5],
        [0x42C80000, 0x42C80000, 0x41252A89, 0x00000000, 0x00000000, 0xBFD11222],
        [0x42C80000, 0x42C80000, 0x41252A89, 0x00000000, 0x00000000, 0xBFD11222],
        [0x42C80000, 0x42C80000, 0x41243538, 0x00000000, 0x00000000, 0xBFFAE28F],
        [0x42C80000, 0x42C80000, 0x41243538, 0x00000000, 0x00000000, 0xBFFAE28F],
        [0x42C80000, 0x42C80000, 0x4123134D, 0x00000000, 0x00000000, 0xC012597E],
        [0x42C80000, 0x42C80000, 0x4123134D, 0x00000000, 0x00000000, 0xC012597E],
        [0x42C80000, 0x42C80000, 0x4121C4C8, 0x00000000, 0x00000000, 0xC02741B5],
        [0x42C80000, 0x42C80000, 0x4121C4C8, 0x00000000, 0x00000000, 0xC02741B5],
        [0x42C80000, 0x42C80000, 0x412049A9, 0x00000000, 0x00000000, 0xC03C29EC],
        [0x42C80000, 0x42C80000, 0x412049A9, 0x00000000, 0x00000000, 0xC03C29EC],
        [0x42C80000, 0x42C80000, 0x41200000, 0x00000000, 0x00000000, 0x00000000],
        [0x42C80000, 0x42C80000, 0x41200000, 0x00000000, 0x00000000, 0x00000000],
        [0x42C80000, 0x42C80000, 0x41200000, 0x00000000, 0x00000000, 0x00000000],
        [0x42C80000, 0x42C80000, 0x41200000, 0x00000000, 0x00000000, 0x00000000],
        [0x42C80000, 0x42C80000, 0x41200000, 0x00000000, 0x00000000, 0x00000000],
        [0x42C80000, 0x42C80000, 0x41200000, 0x00000000, 0x00000000, 0x00000000],
        [0x42C80000, 0x42C80000, 0x41200000, 0x00000000, 0x00000000, 0x00000000],
        [0x42C80000, 0x42C80000, 0x41200000, 0x00000000, 0x00000000, 0x00000000],
        [0x42C80000, 0x42C80000, 0x41200000, 0x00000000, 0x00000000, 0x00000000],
        [0x42C80000, 0x42C80000, 0x41200000, 0x00000000, 0x00000000, 0x00000000],
        [0x42C80000, 0x42C80000, 0x41200000, 0x00000000, 0x00000000, 0x00000000],
    ];
    const GOLDEN_KNOCKBACK_LANDING: [[u32; 6]; 16] = [
        [0x42C80000, 0x42C80000, 0x41266666, 0x00000000, 0x40800000, 0xBF800000],
        [0x42C80000, 0x42C84445, 0x4125C790, 0x00000000, 0x40800000, 0xBFA9D06D],
        [0x42C80000, 0x42C84445, 0x4125C790, 0x00000000, 0x40800000, 0xBFA9D06D],
        [0x42C80000, 0x42C8888A, 0x4124FC1F, 0x00000000, 0x40800000, 0xBFD3A0DA],
        [0x42C80000, 0x42C8888A, 0x4124FC1F, 0x00000000, 0x40800000, 0xBFD3A0DA],
        [0x42C80000, 0x42C8CCCF, 0x41240414, 0x00000000, 0x40800000, 0xBFFD7147],
        [0x42C80000, 0x42C8CCCF, 0x41240414, 0x00000000, 0x40800000, 0xBFFD7147],
        [0x42C80000, 0x42C91114, 0x4122DF6F, 0x00000000, 0x40800000, 0xC013A0DA],
        [0x42C80000, 0x42C91114, 0x4122DF6F, 0x00000000, 0x40800000, 0xC013A0DA],
        [0x42C80000, 0x42C95559, 0x41218E30, 0x00000000, 0x40800000, 0xC0288911],
        [0x42C80000, 0x42C95559, 0x41218E30, 0x00000000, 0x40800000, 0xC0288911],
        [0x42C80000, 0x42C9999E, 0x41201056, 0x00000000, 0x40800000, 0xC03D7148],
        [0x42C80000, 0x42C9999E, 0x41201056, 0x00000000, 0x40800000, 0xC03D7148],
        [0x42C80000, 0x42C9DDE3, 0x41200000, 0x00000000, 0x4067ABBE, 0x00000000],
        [0x42C80000, 0x42C9DDE3, 0x41200000, 0x00000000, 0x4067ABBE, 0x00000000],
        [0x42C80000, 0x42C9DDE3, 0x41200000, 0x00000000, 0x00000000, 0x00000000],
    ];
    const GOLDEN_HUGE_FRAME: [[u32; 6]; 9] = [
        [0x42C80000, 0x42C80000, 0x42700000, 0x00000000, 0x00000000, 0x00000000],
        [0x42C80000, 0x42C80000, 0x42700000, 0x00000000, 0x00000000, 0xBEA741B5],
        [0x42C80000, 0x42C80000, 0x42700000, 0x00000000, 0x00000000, 0xBEA741B5],
        [0x42C80000, 0x42C80000, 0x426FEF46, 0x00000000, 0x00000000, 0xBF2741B5],
        [0x42C80000, 0x42C80000, 0x426FEF46, 0x00000000, 0x00000000, 0xBF2741B5],
        [0x42C80000, 0x42C80000, 0x426FEF46, 0x00000000, 0x00000000, 0xBF2741B5],
        [0x42C80000, 0x42C80000, 0x426FD366, 0x00000000, 0x00000000, 0xBF7AE290],
        [0x42C80000, 0x42C80000, 0x426FD366, 0x00000000, 0x00000000, 0xBF7AE290],
        [0x42C80000, 0x42C80000, 0x426FAC5F, 0x00000000, 0x00000000, 0xBFA741B5],
    ];
    const GOLDEN_SCHEDULE_DEFAULT: [u32; 28] = [
        0x00000000, 0x38D1B717, 0x00000000, 0x3C895AF2, 0x00000001, 0x3D08F216,
        0x00000000, 0x00000002, 0x3DCCCCCD, 0x3D4CCCCE, 0x00000000, 0x00000005,
        0x3DCCCCCD, 0x3DCCCCCD, 0x3DCCCCCD, 0x3DCCCCCD, 0x3D4CCCCE, 0x00000000,
        0x00000004, 0x3DCCCCCD, 0x3DCCCCCD, 0x3DCCCCCD, 0x3DCCCCCD, 0x3CA3D700,
        0x00000000, 0x00000000, 0x00000000, 0x3C88893B,
    ];
    const GOLDEN_SCHEDULE_RETAIL: [u32; 25] = [
        0x00000000, 0x00000000, 0x00000001, 0x3C88893B, 0x00000000, 0x00000001,
        0x3C88893B, 0x00000000, 0x00000001, 0x3E19999A, 0x00000000, 0x00000003,
        0x3E4CCCCD, 0x3E4CCCCD, 0x3D4CCCC8, 0x00000000, 0x00000002, 0x3E4CCCCD,
        0x3E4CCCCD, 0x3CA3D700, 0x00000000, 0x00000000, 0x00000001, 0x3C88893B,
        0x00000000,
    ];

    /// Frozen: grounded direct-set run on flat ground at 60 fps input
    /// cadence (30 Hz integration cadence under the default quantum
    /// shape — frames alternate integrate/hold).
    #[test]
    fn golden_flat_walk() {
        assert_frames("flat_walk", &trace_flat_walk(), &GOLDEN_FLAT_WALK);
    }

    /// Frozen: the full vertical jump arc — ascent, the retail apex
    /// stop-check quantum (F4: entry vz 0.06 → v zeroed → half-step-only
    /// offset → gravity rebuild at −9.8/30), descent, exact-floor
    /// landing, grounded tail.
    #[test]
    fn golden_jump_arc() {
        assert_frames("jump_arc", &trace_jump_arc(), &GOLDEN_JUMP_ARC);
    }

    /// Frozen: knockback-shaped landing — airborne planar carry frozen
    /// at 4.0, the landing slice's residual friction (F6:
    /// 4.0 × pow(0.05, q_land) = 3.61986…), then the grounded
    /// direct-set-to-zero snap.
    #[test]
    fn golden_knockback_landing() {
        assert_frames(
            "knockback_landing",
            &trace_knockback_landing(),
            &GOLDEN_KNOCKBACK_LANDING,
        );
    }

    /// Frozen: a 2.5 s hitch mid-fall is consumed without integrating —
    /// pose AND velocity bit-identical across the huge frame.
    #[test]
    fn golden_huge_frame() {
        assert_frames("huge_frame", &trace_huge_frame(), &GOLDEN_HUGE_FRAME);
    }

    /// Frozen: the DEFAULT (ACE-shaped) slice schedule over the probe
    /// script — sub-epsilon frames ACCUMULATE (bank 1e-4), 0.1 slices,
    /// sub-1/30 floor, HugeQuantum consume.
    #[test]
    fn golden_schedule_default() {
        assert_words(
            "schedule_default",
            &trace_schedule_default(),
            &GOLDEN_SCHEDULE_DEFAULT,
        );
    }

    /// Frozen: the RETAIL slice schedule (F1/F2) over the same script —
    /// sub-epsilon frames CONSUME (bank 0), 60 fps frames integrate
    /// directly, 0.2 slices, the 0.42-frame tail carries.
    #[test]
    fn golden_schedule_retail() {
        assert_words(
            "schedule_retail",
            &trace_schedule_retail(),
            &GOLDEN_SCHEDULE_RETAIL,
        );
    }
}

/// FU5 (row 64) — retail `TakeControlFromServer`
/// (acclient.c:716934-716953): an input edge while the server holds
/// control clears `controlled_by_server` and stops the interpolation,
/// while the LEASH CONSTRAINT survives (disarm is UnConstrain only).
/// Without server control the pending flag drains as a no-op.
#[test]
fn take_control_on_input_edge_clears_server_control_and_stops_interp() {
    use holtburger_world::spatial::{AuthoritativeBodySync, SpatialBodyId};

    let mut world = WorldState::synthetic();
    let player_guid = Guid(0x5000_0F05);
    world.player.guid = player_guid;
    let start = holtburger_common::position::WorldPosition {
        landblock_id: Guid(0x00A9_0000),
        coords: Vector3::new(50.0, 50.0, 0.0),
        rotation: Quaternion::identity(),
    };
    seed_local_player(&mut world, player_guid, start);

    // Server takes control (LoseControlToServer analog) + the leash
    // reconcile installs constraint + interp (server-controlled + the
    // leash flag + contact default).
    world.scene.set_local_retail_leash(true);
    world.scene.set_local_server_controlled(true);
    let body_id = SpatialBodyId::LocalPlayer(player_guid);
    let mut body = world.scene.body(body_id).expect("seeded body").clone();
    body.sampling.mode = holtburger_world::spatial::SpatialSampleMode::SimulatingVelocity;
    world.scene.update_body(body);
    let target = holtburger_common::position::WorldPosition {
        coords: Vector3::new(53.0, 50.0, 0.0),
        ..start
    };
    world.scene.reconcile_authoritative_body(
        body_id,
        target,
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::Snapshot,
        Instant::now(),
    );
    {
        let body = world.scene.body(body_id).unwrap();
        assert!(body.position_manager.is_interpolating(), "directive interp installed");
        assert!(body.position_manager.constraint.is_constrained(), "leash armed");
    }

    // Input edge → pending take-control → consumption clears control,
    // stops interp, keeps the leash.
    let mut movement = MovementSystem::new();
    ingest_intent(
        &mut movement,
        PlayerDriveIntent::ManualHeld(MotionState::builder().run().forward().build()),
        Instant::now(),
    );
    movement.consume_pending_take_control(&mut world);
    assert!(!world.scene.local_server_controlled(), "control returned to player");
    let body = world.scene.body(body_id).unwrap();
    assert!(!body.position_manager.is_interpolating(), "interp stopped");
    assert!(
        body.position_manager.constraint.is_constrained(),
        "leash constraint SURVIVES take-control"
    );
}

/// Wave-1 step 4 (`?cmdInterp=on`) — the interpreter lane end-to-end
/// through the tick: input-action edges compose the per-axis drive, raise
/// the latch, mirror the held-keys truth from the CommandLists, and the
/// pop-through/silent-release semantics arrive intact. Flag OFF, none of
/// this machinery is reachable (nothing queues a KeyEdge — pinned by the
/// legacy suite staying green).
#[tokio::test]
async fn cmd_interp_key_edges_drive_the_interpreter_lane() {
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
    movement.set_cmd_interp(true);

    // W press (ADJ-4: action 0x29 = WalkForward) + D press (0x2C =
    // SideStepRight).
    movement.enqueue_key_action(0x29, true);
    movement.enqueue_key_action(0x2C, true);
    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("interp lane tick");

    let drive = match movement.active_drive {
        Some(ActiveDriveState {
            intent: ActiveDriveIntent::Manual(state),
            ..
        }) => state,
        other => panic!("expected manual drive from the interpreter lane, got {other:?}"),
    };
    assert_eq!(drive.forward, Some(ForwardLocomotion::Forward));
    assert_eq!(drive.sidestep, Some(SidestepLocomotion::StrafeRight));
    assert_eq!(drive.gait, Gait::Run, "M7 run-by-default");
    assert!(
        movement.last_move_was_autonomous,
        "row 1: the edge raised the latch through the seam"
    );
    // Row 3: the mirror carries the held-keys truth from the lists.
    let raw = movement.last_manual_drive.expect("mirror populated");
    assert_eq!(raw.forward, Some(ForwardLocomotion::Forward));
    assert_eq!(raw.sidestep, Some(SidestepLocomotion::StrafeRight));
    assert!(
        !movement.pending_take_control,
        "row 2: the interp lane never uses the FU5 deferred bit"
    );

    // Head-wins pop-through: S press buries W; W release pops through to
    // S as a fresh press (forward = Backstep, not idle).
    movement.enqueue_key_action(0x2A, true); // S (WalkBackward)
    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("tick");
    movement.enqueue_key_action(0x29, false); // release W (buried? no — W is under S)
    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("tick");
    let drive = match movement.active_drive {
        Some(ActiveDriveState {
            intent: ActiveDriveIntent::Manual(state),
            ..
        }) => state,
        other => panic!("expected manual drive, got {other:?}"),
    };
    assert_eq!(
        drive.forward,
        Some(ForwardLocomotion::Backstep),
        "the newest head (S) owns the forward axis after W releases"
    );

    // FU-C: a release while the scene says server-controlled is SILENT —
    // the drive keeps its last-applied state, but the list pops (mirror
    // empties). Step 5: every REAL grab arrives with a server-authored
    // motion whose wire stamp lowers the autonomy latch
    // (`note_server_authored_motion`, row 1) — stamp it here too, or
    // the use_time pump would (retail-correctly) treat a bare
    // control-flag flip as a pure grab and reclaim the held keys next
    // tick (`cmd_interp_use_time_reclaims_pure_control_grab` pins that
    // arm).
    world.scene.set_local_server_controlled(true);
    movement.note_server_authored_motion(false);
    movement.enqueue_key_action(0x2C, false); // release D under control
    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("tick");
    let drive = match movement.active_drive {
        Some(ActiveDriveState {
            intent: ActiveDriveIntent::Manual(state),
            ..
        }) => state,
        other => panic!("expected manual drive, got {other:?}"),
    };
    assert_eq!(
        drive.sidestep,
        Some(SidestepLocomotion::StrafeRight),
        "silent release: the last-applied sidestep keeps driving (§2.7)"
    );
    let raw = movement.last_manual_drive.expect("mirror");
    assert_eq!(raw.sidestep, None, "yet the list was bookkept (popped)");
    assert!(
        world.scene.local_server_controlled(),
        "a silent release does not reclaim control"
    );

    // FU-A: a fresh press under control reclaims — the leash drops (scene
    // flag clears) and the full held pattern (the S under the stack)
    // revives in the composed drive.
    movement.enqueue_key_action(0x2E, true); // E (TurnRight) press
    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("tick");
    assert!(
        !world.scene.local_server_controlled(),
        "FU-A: the press reclaimed control through the seam leash drop"
    );
    let drive = match movement.active_drive {
        Some(ActiveDriveState {
            intent: ActiveDriveIntent::Manual(state),
            ..
        }) => state,
        other => panic!("expected manual drive, got {other:?}"),
    };
    assert_eq!(
        drive.forward,
        Some(ForwardLocomotion::Backstep),
        "FU-A: the held S revived out of the SubstateList head"
    );
    assert_eq!(drive.turning, Some(Turn::Right), "the tap's own axis drives");
}

/// Step 5 (verdict §3.3) — the `?castMove`/`?slideCast` URL flags are
/// ALIASES for the interpreter configs: construction seeds
/// `honor_autonomy_latch`/`slidecast_persist` from the runtime carriers.
#[tokio::test]
async fn cmd_interp_configs_seed_from_flag_carriers() {
    let mut world = WorldState::synthetic();
    world.seed_local_player_entity(
        Guid(0x5000_0124),
        "Player",
        WorldPosition {
            landblock_id: Guid(0x1234_0000),
            ..Default::default()
        },
    );
    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    movement.set_cmd_interp(true);
    movement.set_cast_move(false);
    movement.set_slide_cast(false);

    movement.enqueue_key_action(0x29, true); // W constructs the interpreter
    movement
        .tick(Instant::now(), &mut world, &mut session)
        .await
        .expect("tick");

    let interp = movement
        .command_interpreter
        .as_ref()
        .expect("interpreter constructed at first edge");
    assert!(
        !interp.honor_autonomy_latch,
        "?castMove=off seeds honor_autonomy_latch=false"
    );
    assert!(
        !interp.slidecast_persist,
        "?slideCast=off seeds slidecast_persist=false"
    );
}

/// Step 5 (verdict §3.3) — `?castMove=off` on the interpreter lane:
/// the mirror never raises `controlled_by_server`, so a release under a
/// server grab STILL dispatches (no FU-C suppression; raw input always
/// drives) and the leash returns without the retail stomp.
#[tokio::test]
async fn cmd_interp_cast_move_off_releases_always_drive() {
    let mut world = WorldState::synthetic();
    world.seed_local_player_entity(
        Guid(0x5000_0125),
        "Player",
        WorldPosition {
            landblock_id: Guid(0x1234_0000),
            ..Default::default()
        },
    );
    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let now = Instant::now();
    movement.set_cmd_interp(true);
    movement.set_cast_move(false);

    movement.enqueue_key_action(0x2C, true); // D press (uncontrolled)
    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("tick");

    world.scene.set_local_server_controlled(true);
    movement.enqueue_key_action(0x2C, false); // D release under "control"
    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("tick");

    let drive = match movement.active_drive {
        Some(ActiveDriveState {
            intent: ActiveDriveIntent::Manual(state),
            ..
        }) => state,
        other => panic!("expected manual drive, got {other:?}"),
    };
    assert_eq!(
        drive.sidestep, None,
        "castMove=off: the release DISPATCHED (no FU-C silent suppression)"
    );
    assert!(
        !world.scene.local_server_controlled(),
        "castMove=off: the edge still returns the leash (no stomp)"
    );
}

/// Step 5 (verdict §3.3) — flag-on, the stomp-persist predicate is the
/// INTERPRETER's `slidecast_persist` config, not the legacy carrier:
/// config=false kills the held axes even with the carrier ON, and
/// config=true persists them even with the carrier OFF.
#[tokio::test]
async fn cmd_interp_slidecast_config_owns_the_stomp_when_flag_on() {
    use holtburger_protocol::messages::{
        MovementEventData, MovementInvalid, MovementType, MovementTypeData,
    };
    use holtburger_world::WorldEvent;

    async fn arm(carrier_on: bool, config_on: bool) -> (bool, bool) {
        let guid = Guid(0x5000_0778);
        let mut world = WorldState::synthetic();
        world.seed_local_player_entity(
            guid,
            "Player",
            WorldPosition {
                landblock_id: Guid(0x1234_0000),
                ..Default::default()
            },
        );
        let mut movement = MovementSystem::new();
        let mut session = Session::new_test();
        movement.set_cmd_interp(true);
        movement.set_slide_cast(carrier_on);
        // A (StrafeLeft) + E (TurnRight) — the dance keys, via the lane.
        movement.enqueue_key_action(0x2D, true);
        movement.enqueue_key_action(0x2E, true);
        movement
            .tick(Instant::now(), &mut world, &mut session)
            .await
            .expect("tick");
        // Force the interpreter config apart from the carrier — the
        // ownership probe (aliasing seeds them equal in production).
        movement
            .command_interpreter
            .as_mut()
            .expect("interpreter constructed")
            .slidecast_persist = config_on;

        let motion = MovementEventData {
            guid,
            object_instance_sequence: 1,
            movement_sequence: 1,
            server_control_sequence: 1,
            is_autonomous: false,
            movement_type: MovementType::Invalid,
            motion_flags: 0,
            current_style: MotionStance::Magic.interpreted(),
            data: MovementTypeData::Invalid(MovementInvalid::default()),
        };
        movement.apply_movement_world_events_ungated(&[WorldEvent::SelfServerControlledMotion {
            data: Box::new(motion),
            target_exists: false,
            object_radius: 0.0,
            object_height: 0.0,
        }]);
        let interp = movement
            .movement_managers
            .get(&guid)
            .and_then(|manager| manager.motion_interp_ref())
            .expect("stomp created the manager");
        (interp.interpreted_state.sidestep, interp.interpreted_state.turn)
    }

    // Interpreter config OFF wins over carrier ON: bare stomp.
    let (sidestep, turn) = arm(true, false).await;
    assert!(
        !sidestep && !turn,
        "interp slidecast_persist=false → the bare retail stomp (carrier ignored)"
    );
    // Interpreter config ON wins over carrier OFF: modern persist.
    let (sidestep, turn) = arm(false, true).await;
    assert!(
        sidestep && turn,
        "interp slidecast_persist=true → held axes ride the stomp (carrier ignored)"
    );
}

/// Step 5 (row 9) — send ownership: a key edge's MoveToState comes from
/// the INTERPRETER flush (M1 converter), and the tick's edge-detector
/// stays silent for it (one sender per edge, pinned on the pulse
/// counter). A no-edge tick adds nothing; a release edge sends the new
/// (idle) state exactly once.
#[tokio::test]
async fn cmd_interp_send_ownership_one_sender_per_edge() {
    let mut world = WorldState::synthetic();
    world.seed_local_player_entity(
        Guid(0x5000_0126),
        "Player",
        WorldPosition {
            landblock_id: Guid(0x1234_0000),
            ..Default::default()
        },
    );
    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let now = Instant::now();
    movement.set_cmd_interp(true);

    movement.enqueue_key_action(0x29, true); // W press
    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("tick");
    assert_eq!(
        movement.motion_state_pulses_sent, 1,
        "press edge: exactly ONE MoveToState (interp flush; detector deduped)"
    );
    assert!(
        movement.server_motion_active,
        "the interp flush stamped the send bookkeeping"
    );

    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("tick");
    assert_eq!(
        movement.motion_state_pulses_sent, 1,
        "edge-less tick: the detector sees an unchanged intent — no re-send"
    );

    movement.enqueue_key_action(0x29, false); // W release
    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("tick");
    assert_eq!(
        movement.motion_state_pulses_sent, 2,
        "release edge: ONE idle-state MoveToState (retail sends the release too)"
    );
}

/// Step 5 — the retail `UseTime` FU-A trigger (acclient.c:717595): held
/// keys survive a PURE control grab (no server-authored motion — the
/// autonomy latch stays high) and the pump reclaims them next tick
/// WITHOUT a fresh edge. Retail sends nothing on a use_time reclaim —
/// pinned via the pulse counter (the revived intent matches the last
/// sent one, so the edge-detector stays silent).
#[tokio::test]
async fn cmd_interp_use_time_reclaims_pure_control_grab() {
    let mut world = WorldState::synthetic();
    world.seed_local_player_entity(
        Guid(0x5000_0127),
        "Player",
        WorldPosition {
            landblock_id: Guid(0x1234_0000),
            ..Default::default()
        },
    );
    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let now = Instant::now();
    movement.set_cmd_interp(true);

    movement.enqueue_key_action(0x29, true); // W press, latch raised
    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("tick");
    let pulses_after_press = movement.motion_state_pulses_sent;

    // A pure grab: the scene flag flips with NO server-authored motion
    // (latch stays high, no projection, no interpolation).
    world.scene.set_local_server_controlled(true);
    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("tick");

    assert!(
        !world.scene.local_server_controlled(),
        "use_time reclaimed the pure grab without a fresh edge (FU-A)"
    );
    let drive = match movement.active_drive {
        Some(ActiveDriveState {
            intent: ActiveDriveIntent::Manual(state),
            ..
        }) => state,
        other => panic!("expected manual drive, got {other:?}"),
    };
    assert_eq!(
        drive.forward,
        Some(ForwardLocomotion::Forward),
        "the held W revived out of the substate head"
    );
    assert_eq!(
        movement.motion_state_pulses_sent, pulses_after_press,
        "retail cadence: a use_time reclaim sends NO MoveToState"
    );
}

/// Step 5 — the conservative `player_motions_pending` composite: a
/// server-AUTHORED motion in flight (wire stamp lowered the latch —
/// every gesture/directive does) keeps the use_time reclaim gated, so
/// held-W still dies at the cast gesture (the strafecast floor). A
/// fresh EDGE still reclaims (HKC TakeControl is edge-driven, not
/// latch-gated).
#[tokio::test]
async fn cmd_interp_use_time_gated_while_server_motion_in_flight() {
    let mut world = WorldState::synthetic();
    world.seed_local_player_entity(
        Guid(0x5000_0128),
        "Player",
        WorldPosition {
            landblock_id: Guid(0x1234_0000),
            ..Default::default()
        },
    );
    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let now = Instant::now();
    movement.set_cmd_interp(true);

    movement.enqueue_key_action(0x29, true); // W press
    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("tick");

    // The grab RIDES a server-authored motion (retail: every gesture /
    // directive stamps the latch low through the wire).
    world.scene.set_local_server_controlled(true);
    movement.note_server_authored_motion(false);
    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("tick");
    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("tick");
    assert!(
        world.scene.local_server_controlled(),
        "no auto-reclaim while a server-authored motion is in flight"
    );

    // A fresh edge reclaims regardless (FU-A via HKC TakeControl).
    movement.enqueue_key_action(0x2E, true); // E press
    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("tick");
    assert!(
        !world.scene.local_server_controlled(),
        "the edge-driven TakeControl is not latch-gated"
    );
}

/// Step 5 (row 8/M6) — the jump lane through the interpreter: space
/// arrives as action 0x31; the press routes CommenceJump onto the ONE
/// charge clock (via the seam), the release queues DoJump and the tick
/// flushes it through `execute_jump_release` (gates → vz → begin_jump →
/// pack → send). Zero new clocks; no MoveToState rides a jump edge
/// (HKC's terminal is Jump-gated, ADJ-3).
#[tokio::test]
async fn cmd_interp_jump_lane_charges_and_releases() {
    let mut world = seed_jump_world();
    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let t0 = Instant::now();
    movement.set_cmd_interp(true);

    movement.enqueue_key_action(0x31, true); // space press
    movement
        .tick(t0, &mut world, &mut session)
        .await
        .expect("tick");
    assert!(
        movement.jump_charge_power(t0 + Duration::from_millis(500), &world) > 0.0,
        "0x31 press armed the ONE charge clock through the seam"
    );
    assert_eq!(
        movement.motion_state_pulses_sent, 0,
        "a jump edge emits no MoveToState (ADJ-3 terminal gate)"
    );

    movement.enqueue_key_action(0x31, false); // space release
    movement
        .tick(t0 + Duration::from_millis(500), &mut world, &mut session)
        .await
        .expect("tick");
    assert!(
        world.player.is_airborne,
        "the queued release flushed through execute_jump_release and launched"
    );
    assert_eq!(
        movement.jump_charge_power(t0 + Duration::from_secs(1), &world),
        0.0,
        "the charge was consumed by the release"
    );
}

/// Step 5 (rows 12-13) — the JS-facing event stream: a fresh W press
/// emits ForwardSlotEvicted (the HNFM cast-cut moment) then the
/// installed drive; a strafe edge emits only the drive; an FU-A reclaim
/// emits ControlReclaimed (the ADJ-15 Q3 instrumentation).
#[tokio::test]
async fn cmd_interp_event_stream_feeds_js_consumers() {
    use super::super::system::CmdInterpEvent;

    let mut world = WorldState::synthetic();
    world.seed_local_player_entity(
        Guid(0x5000_0129),
        "Player",
        WorldPosition {
            landblock_id: Guid(0x1234_0000),
            ..Default::default()
        },
    );
    let mut movement = MovementSystem::new();
    let mut session = Session::new_test();
    let now = Instant::now();
    movement.set_cmd_interp(true);

    movement.enqueue_key_action(0x29, true); // W press
    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("tick");
    let events = movement.take_cmd_interp_events();
    assert!(
        matches!(
            events.as_slice(),
            [
                CmdInterpEvent::ForwardSlotEvicted,
                CmdInterpEvent::DriveApplied {
                    forward: 1,
                    side: 0,
                    turn: 0,
                    run: true
                }
            ]
        ),
        "W press: eviction (HNFM) then the installed drive, got {events:?}"
    );

    movement.enqueue_key_action(0x2C, true); // D press (sidestep list)
    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("tick");
    let events = movement.take_cmd_interp_events();
    assert!(
        matches!(
            events.as_slice(),
            [CmdInterpEvent::DriveApplied {
                forward: 1,
                side: 1,
                turn: 0,
                run: true
            }]
        ),
        "strafe edge: no eviction, just the drive, got {events:?}"
    );

    // Pure grab → the use_time pump reclaims → ControlReclaimed rides
    // the stream (plus the revived drive).
    world.scene.set_local_server_controlled(true);
    movement
        .tick(now, &mut world, &mut session)
        .await
        .expect("tick");
    let events = movement.take_cmd_interp_events();
    assert!(
        events.contains(&CmdInterpEvent::ControlReclaimed),
        "FU-A reclaim instrumented for the Q3 observation, got {events:?}"
    );
}
