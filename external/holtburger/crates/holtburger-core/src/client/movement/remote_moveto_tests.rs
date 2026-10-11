//! MoveTo refactor phase A (2026-10-10): the remote MoveTo pump tests that
//! used to live in `movement_manager.rs`. They exercise core's
//! `system::drive_remote_movetos` against a world scene, so they stay in
//! core while the movement stack itself now lives in `holtburger-world`.

use holtburger_common::Guid;
use holtburger_protocol::messages::movement::messages::motion::Origin;
use holtburger_world::motion::movement_manager::MovementManager;
use holtburger_world::motion::params::MovementParameters;

/// OpenAC comparison 2026-10-04 (remote motion D5): the remote MoveTo
/// pump (`system::drive_remote_movetos`) steps a REMOTE manager's
/// directive against its scene body — retail runs
/// `MoveToManager::UseTime` (acclient.c:346018) for every object — and
/// hands the steer to the body: `IsMovingTo()` for keep-heading and a
/// heading toward the destination (BeginTurnToHeading :345456 first,
/// then the walk). Before this nothing stepped remote directives (the
/// registry only pumped completions). Lifecycle cases ported from
/// OpenAC `MoveToManagerLifecycleTests` (arm → steer → idle clears).
#[test]
fn remote_moveto_pump_steers_the_remote_body() {
    use holtburger_common::position::WorldPosition;
    use holtburger_common::{Quaternion, Vector3};
    use holtburger_world::spatial::{AuthoritativeBodySync, RemoteCorrectionCtx, SpatialBodyId};

    let guid = Guid(0x8000_0042);
    let mut world = holtburger_world::WorldState::synthetic();
    world.scene.set_remote_interp_enabled(true);
    let start = WorldPosition {
        landblock_id: Guid(0x0102_0011),
        coords: Vector3::new(50.0, 50.0, 0.0),
        rotation: Quaternion::from_heading(0.0),
    };
    world.scene.reconcile_authoritative_body_with_remote(
        SpatialBodyId::Entity(guid),
        start,
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::Snapshot,
        web_time::Instant::now(),
        Some(RemoteCorrectionCtx {
            contact: Some(true),
            player_pose: Some(start),
        }),
    );

    let mut manager = MovementManager::default();
    let _ = manager.minterp();
    // 20 m due east (AC heading 180°) in the same landblock.
    manager.moveto().move_to_position(
        Origin {
            cell_id: Guid(0x0102_0011),
            position: Vector3::new(70.0, 50.0, 0.0),
        },
        MovementParameters::default(),
    );
    assert!(manager.is_moveto_active());
    let mut managers = std::collections::HashMap::new();
    managers.insert(guid, manager);

    crate::client::movement::system::drive_remote_movetos(
        &mut managers,
        &mut world,
        web_time::Instant::now(),
    );
    let body = world.scene.body(SpatialBodyId::Entity(guid)).unwrap();
    assert!(body.remote_moving_to, "IsMovingTo() feeds keep_heading");
    let drive = body.remote_moveto.expect("the directive steers the body");
    let east = 180.0_f32.to_radians();
    assert!((drive.heading_rad - east).abs() < 0.05, "turns toward the destination: {}", drive.heading_rad);

    // The scene realizes the steer: the body turns toward east.
    let before = body.pose.rotation.to_heading();
    world.scene.step_remote_position_managers(0.1);
    let after = world
        .scene
        .body(SpatialBodyId::Entity(guid))
        .unwrap()
        .pose
        .rotation
        .to_heading();
    assert!((after - east).abs() < (before - east).abs(), "turned toward east: {before} -> {after}");

    // Escape hatch: the pump does nothing with the switch off.
    world.scene.set_remote_moveto(guid, false, None, None);
    world.scene.set_remote_moveto_enabled(false);
    crate::client::movement::system::drive_remote_movetos(
        &mut managers,
        &mut world,
        web_time::Instant::now(),
    );
    assert!(world.scene.body(SpatialBodyId::Entity(guid)).unwrap().remote_moveto.is_none());
}

/// R3 moveto-1/2 test rig: a synthetic world with the remote driver on
/// and a remote body seeded at `start`.
fn remote_moveto_world(
    guid: Guid,
    start: holtburger_common::position::WorldPosition,
) -> holtburger_world::WorldState {
    use holtburger_common::Vector3;
    use holtburger_world::spatial::{AuthoritativeBodySync, RemoteCorrectionCtx, SpatialBodyId};
    let mut world = holtburger_world::WorldState::synthetic();
    world.scene.set_remote_interp_enabled(true);
    world.scene.reconcile_authoritative_body_with_remote(
        SpatialBodyId::Entity(guid),
        start,
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::Snapshot,
        web_time::Instant::now(),
        Some(RemoteCorrectionCtx {
            contact: Some(true),
            player_pose: Some(start),
        }),
    );
    world
}

/// R3 moveto-2 (2026-10-08): the remote pump + scene complete a
/// TurnToHeading node in BOTH directions. The scene turns the motion
/// past the node; the pump sees the strict `heading_greater` overshoot
/// (HandleTurnToHeading acclient.c:345712), snaps the heading to the
/// node (`set_heading`) and begins the walk in the same tick. Before,
/// the scene clamped exactly onto the node and the f32 heading round
/// trip could leave it a hair short forever — no walk, frozen facing.
#[test]
fn remote_turn_node_completes_then_walks() {
    use holtburger_common::position::WorldPosition;
    use holtburger_common::{Quaternion, Vector3};
    use holtburger_world::spatial::SpatialBodyId;

    // Facing north (AC 90°): a destination due east is a TurnRight node
    // (180°), due west a TurnLeft node (0°).
    for (dest_x, node_deg) in [(70.0f32, 180.0f32), (30.0, 0.0)] {
        let guid = Guid(0x8000_0042);
        let start = WorldPosition {
            landblock_id: Guid(0x0102_0011),
            coords: Vector3::new(50.0, 50.0, 0.0),
            rotation: Quaternion::from_heading(90f32.to_radians()),
        };
        let mut world = remote_moveto_world(guid, start);
        let mut manager = MovementManager::default();
        let _ = manager.minterp();
        manager.moveto().move_to_position(
            Origin {
                cell_id: Guid(0x0102_0011),
                position: Vector3::new(dest_x, 50.0, 0.0),
            },
            MovementParameters::default(),
        );
        let mut managers = std::collections::HashMap::new();
        managers.insert(guid, manager);

        let t0 = web_time::Instant::now();
        let mut walked = false;
        let mut saw_turn = false;
        for i in 0..90 {
            let now = t0 + std::time::Duration::from_secs_f32(i as f32 / 30.0);
            crate::client::movement::system::drive_remote_movetos(&mut managers, &mut world, now);
            let body = world.scene.body(SpatialBodyId::Entity(guid)).unwrap();
            let drive = body.remote_moveto.expect("the directive steers the body");
            if drive.forward.is_some() {
                let heading = body.pose.rotation.to_heading().to_degrees();
                let mut err = (heading - node_deg).rem_euclid(360.0);
                if err > 180.0 {
                    err -= 360.0;
                }
                assert!(err.abs() < 0.01, "snapped onto the node: {heading}° vs {node_deg}°");
                walked = true;
                break;
            }
            let expected_sign = if node_deg == 180.0 { 1.0 } else { -1.0 };
            assert_eq!(drive.turn, Some(expected_sign), "the node's turn command rides the drive");
            saw_turn = true;
            world.scene.step_remote_position_managers(1.0 / 30.0);
        }
        assert!(saw_turn, "dest {dest_x}: a turn node ran first");
        assert!(walked, "dest {dest_x}: the turn node completed and the walk began");
    }
}

/// R3 moveto-4 (2026-10-08 follow-ups): the remote pump records the
/// NODE motion as phase edges for the remote rig's animation (retail
/// `_DoMotion` acclient.c:344753 plays the node on the mover's interp):
/// the walk/run node's motion once when it begins, nothing while it
/// holds, and `0` (→ Ready) on arrival (`BeginNextNode`,
/// :345521-345545).
#[test]
fn remote_moveto_phase_edges_follow_the_node() {
    use holtburger_common::position::WorldPosition;
    use holtburger_common::{Quaternion, Vector3};
    use holtburger_world::spatial::{AuthoritativeBodySync, RemoteCorrectionCtx};

    let guid = Guid(0x8000_0042);
    let target = Guid(0x8000_0077);
    let at = |x: f32| WorldPosition {
        landblock_id: Guid(0x0102_0011),
        coords: Vector3::new(x, 50.0, 0.0),
        rotation: Quaternion::from_heading(std::f32::consts::PI), // east
    };
    let mut world = remote_moveto_world(guid, at(50.0));
    world.entities.insert(holtburger_world::entity::Entity::new(
        target,
        "Target".to_string(),
        at(60.0),
    ));
    let mut manager = MovementManager::default();
    let _ = manager.minterp();
    manager.moveto().move_to_object(
        target,
        Origin::default(),
        0.0,
        0.0,
        MovementParameters::default(),
    );
    let mut managers = std::collections::HashMap::new();
    managers.insert(guid, manager);

    let t0 = web_time::Instant::now();
    crate::client::movement::system::drive_remote_movetos(&mut managers, &mut world, t0);
    let edges = world.scene.take_remote_moveto_phase_changes();
    assert_eq!(edges.len(), 1, "the walk node begins at once: {edges:?}");
    assert_eq!(edges[0].0, guid);
    assert!(
        edges[0].1 == holtburger_world::motion::motion_interp::MOTION_WALK_FORWARD
            || edges[0].1 == holtburger_world::motion::motion_interp::MOTION_RUN_FORWARD,
        "a walk/run node: 0x{:08X}",
        edges[0].1
    );
    assert_eq!(world.scene.remote_moveto_motion(guid), edges[0].1);

    crate::client::movement::system::drive_remote_movetos(
        &mut managers,
        &mut world,
        t0 + std::time::Duration::from_millis(50),
    );
    assert!(
        world.scene.take_remote_moveto_phase_changes().is_empty(),
        "an unchanged node records nothing"
    );

    world.scene.reconcile_authoritative_body_with_remote(
        holtburger_world::spatial::SpatialBodyId::Entity(guid),
        at(59.7),
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::Reset,
        web_time::Instant::now(),
        Some(RemoteCorrectionCtx {
            contact: Some(true),
            player_pose: Some(at(59.7)),
        }),
    );
    crate::client::movement::system::drive_remote_movetos(
        &mut managers,
        &mut world,
        t0 + std::time::Duration::from_millis(100),
    );
    assert!(!managers[&guid].is_moveto_active(), "arrived");
    assert_eq!(
        world.scene.take_remote_moveto_phase_changes(),
        vec![(guid, 0)],
        "arrival → no node motion (Ready)"
    );
}

/// R3 moveto-1 (2026-10-08): retail sticks a MoveToObject's mover only
/// on ARRIVAL (`BeginNextNode`'s sticky-bit `PositionManager::StickTo`,
/// acclient.c:345521-345566) — `unpack_movement` case 6 only arms the
/// MoveTo (:339492). The remote pump installs the sticky lane exactly
/// then: nothing while the chase is out of range, the target once it
/// arrives. (The wasm arm no longer sticks at arm time — pinned by
/// `holtburger_world::handlers::movement::remote_motion_sticky_target`.)
#[test]
fn remote_sticky_moveto_sticks_only_on_arrival() {
    use holtburger_common::position::WorldPosition;
    use holtburger_common::{Quaternion, Vector3};
    use holtburger_world::spatial::{AuthoritativeBodySync, RemoteCorrectionCtx, SpatialBodyId};

    let guid = Guid(0x8000_0042);
    let target = Guid(0x8000_0077);
    let at = |x: f32| WorldPosition {
        landblock_id: Guid(0x0102_0011),
        coords: Vector3::new(x, 50.0, 0.0),
        rotation: Quaternion::from_heading(std::f32::consts::PI), // east
    };
    let mut world = remote_moveto_world(guid, at(50.0));
    world.scene.set_remote_sticky_enabled(true);
    world.entities.insert(holtburger_world::entity::Entity::new(
        target,
        "Target".to_string(),
        at(60.0),
    ));
    let mut params = MovementParameters::default();
    params.bitfield |= 0x80; // Sticky — ACE sets it on every chase
    let mut manager = MovementManager::default();
    let _ = manager.minterp();
    manager
        .moveto()
        .move_to_object(target, Origin::default(), 0.0, 0.0, params);
    let mut managers = std::collections::HashMap::new();
    managers.insert(guid, manager);

    let t0 = web_time::Instant::now();
    crate::client::movement::system::drive_remote_movetos(&mut managers, &mut world, t0);
    let drive = world
        .scene
        .body(SpatialBodyId::Entity(guid))
        .unwrap()
        .remote_moveto
        .expect("chasing");
    assert!(drive.forward.is_some(), "facing the target: the walk begins at once");
    assert_eq!(world.scene.remote_sticky_target(guid), None, "no stick while chasing");

    // The mover reaches the target (a hard set 0.3 m short) → arrival.
    world.scene.reconcile_authoritative_body_with_remote(
        SpatialBodyId::Entity(guid),
        at(59.7),
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::Reset,
        web_time::Instant::now(),
        Some(RemoteCorrectionCtx {
            contact: Some(true),
            player_pose: Some(at(59.7)),
        }),
    );
    crate::client::movement::system::drive_remote_movetos(
        &mut managers,
        &mut world,
        t0 + std::time::Duration::from_millis(100),
    );
    assert!(!managers[&guid].is_moveto_active(), "arrived");
    assert_eq!(
        world.scene.remote_sticky_target(guid),
        Some(target),
        "the sticky-bit arrival sticks the mover to its target"
    );
}
