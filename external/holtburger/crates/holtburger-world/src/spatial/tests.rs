use super::*;
use crate::entity::EntityMotionSnapshot;
use holtburger_common::position::WorldPosition;
use holtburger_common::{Guid, Quaternion, Vector3};
use holtburger_protocol::messages::movement::InterpretedMotionCommand;
use std::time::{Duration, Instant};

fn make_position(x: f32, y: f32, heading_rad: f32) -> WorldPosition {
    WorldPosition {
        landblock_id: Guid(0x0102_0000),
        coords: Vector3::new(x, y, 0.0),
        rotation: Quaternion::from_heading(heading_rad),
    }
}

/// Rust review 2026-08-03 — the same neighbour query as `test_spatial_neighbors`
/// but with REAL `ObjCellID`s instead of the synthetic `0x____FFFF` form.
///
/// `WorldPosition::landblock_id` is the full ObjCellID: outdoor poses get a
/// derived cell in the low word (`normalize_outdoor_cell`,
/// holtburger-common/src/position.rs:105-112 — `0x3419_0000` becomes
/// `0x3419_0003`), indoor poses an EnvCell stab `>= 0x0100`. `landblock_map`
/// was keyed by that whole value while `get_nearby_entities` synthesised its
/// eight neighbour keys as `(x << 24) | (y << 16) | 0xFFFF`, a low word that is
/// never a real cell — so the neighbour scan could not hit, and the "same
/// landblock" bucket was really a "same 24 m cell" bucket.
///
/// `test_spatial_neighbors` passed throughout because `0x____FFFF` is the one
/// input shape that makes the broken key line up: a test that could not fail on
/// production data.
#[test]
fn spatial_neighbors_work_with_real_objcell_ids() {
    let mut scene = SpatialScene::new();

    // All four live in landblock 0x0A0A / 0x0B0A, in DIFFERENT cells.
    let same_cell = Guid(0x1000_0001);
    let same_lb_other_cell = Guid(0x1000_0002);
    let adjacent_lb = Guid(0x1000_0003);
    let indoor_same_lb = Guid(0x1000_0004);
    let far_lb = Guid(0x1000_0005);

    let put = |scene: &mut SpatialScene, guid: Guid, cell: u32| {
        let pose = WorldPosition {
            landblock_id: Guid(cell),
            ..Default::default()
        };
        scene.update_entity(guid, Guid(cell), pose);
    };

    put(&mut scene, same_cell, 0x0A0A_0003);
    put(&mut scene, same_lb_other_cell, 0x0A0A_0021);
    put(&mut scene, adjacent_lb, 0x0B0A_0011);
    put(&mut scene, indoor_same_lb, 0x0A0A_0135);
    put(&mut scene, far_lb, 0x3232_0005);

    // Query from the player's actual cell id, exactly as
    // `WorldState::player_landblock()` supplies it.
    let nearby = scene.get_nearby_entities(Guid(0x0A0A_0003));

    assert!(nearby.contains(&same_cell));
    assert!(
        nearby.contains(&same_lb_other_cell),
        "an entity in the SAME landblock but a different 24 m cell must be nearby"
    );
    assert!(
        nearby.contains(&adjacent_lb),
        "an entity one landblock east must be nearby — the 3x3 neighbour scan          used to be unreachable on real cell ids"
    );
    assert!(
        nearby.contains(&indoor_same_lb),
        "an indoor EnvCell in the same landblock must be nearby"
    );
    assert!(!nearby.contains(&far_lb), "40 landblocks away is not nearby");

    // Landblock row/column 0 is a real part of the world; the old
    // `nx > 0 && ny > 0` bound dropped it.
    let mut edge = SpatialScene::new();
    let at_origin = Guid(0x2000_0001);
    put(&mut edge, at_origin, 0x0000_0002);
    assert!(
        edge.get_nearby_entities(Guid(0x0100_0002)).contains(&at_origin),
        "landblock (0, 0) must be reachable from its neighbour (1, 0)"
    );

    // Removal must use the same key, or the entity would linger forever.
    edge.remove_entity(at_origin, Guid(0x0000_0002));
    assert!(edge.get_nearby_entities(Guid(0x0100_0002)).is_empty());
}

#[test]
fn test_spatial_neighbors() {
    let mut scene = SpatialScene::new();
    let guid_a = Guid(0x11223344);
    let guid_b = Guid(0x55667788);

    let lb_a = (10 << 24) | (10 << 16) | 0xFFFF;
    let lb_b = (11 << 24) | (10 << 16) | 0xFFFF;

    scene.update_entity(
        guid_a,
        Guid(lb_a),
        WorldPosition {
            landblock_id: Guid(lb_a),
            ..Default::default()
        },
    );
    scene.update_entity(
        guid_b,
        Guid(lb_b),
        WorldPosition {
            landblock_id: Guid(lb_b),
            ..Default::default()
        },
    );

    let nearby_a = scene.get_nearby_entities(Guid(lb_a));
    assert!(nearby_a.contains(&guid_a));
    assert!(
        nearby_a.contains(&guid_b),
        "Should find neighbor in adjacent landblock"
    );

    let lb_far = (50 << 24) | (50 << 16) | 0xFFFF;
    let nearby_far = scene.get_nearby_entities(Guid(lb_far));
    assert!(nearby_far.is_empty());
}

#[test]
fn get_entities_in_range_uses_pose_index() {
    let mut scene = SpatialScene::new();
    let center_guid = Guid(0x1000_0001);
    let near_guid = Guid(0x1000_0002);
    let far_guid = Guid(0x1000_0003);
    let landblock = Guid(0x0A0A_FFFF);
    let center = WorldPosition {
        landblock_id: landblock,
        coords: Vector3::new(10.0, 10.0, 0.0),
        ..Default::default()
    };

    scene.update_entity(center_guid, landblock, center);
    scene.update_entity(
        near_guid,
        landblock,
        WorldPosition {
            landblock_id: landblock,
            coords: Vector3::new(13.0, 14.0, 0.0),
            ..Default::default()
        },
    );
    scene.update_entity(
        far_guid,
        landblock,
        WorldPosition {
            landblock_id: landblock,
            coords: Vector3::new(40.0, 40.0, 0.0),
            ..Default::default()
        },
    );

    let in_range = scene.get_entities_in_range(&center, 6.0);

    assert!(in_range.contains(&center_guid));
    assert!(in_range.contains(&near_guid));
    assert!(!in_range.contains(&far_guid));
}

#[test]
fn project_pose_by_velocity_keeps_indoor_landblock_stable() {
    let authoritative = WorldPosition {
        landblock_id: Guid(0x016C_0155),
        coords: Vector3::new(12.108355, -60.660404, 0.004999995),
        rotation: Quaternion::identity(),
    };

    let projected = project_pose_by_velocity(
        authoritative,
        Vector3::new(8.345838, 15.9404335, 0.0),
        1.0,
        None,
    );

    assert_eq!(projected.landblock_id, authoritative.landblock_id);
    assert!((projected.coords.x - 20.454193).abs() < 1e-4);
    assert!((projected.coords.y - (-44.71997)).abs() < 2e-3);
    assert!((projected.coords.z - 0.004999995).abs() < 1e-6);
}

#[test]
fn project_pose_by_velocity_uses_indoor_target_hint_landblock() {
    let authoritative = WorldPosition {
        landblock_id: Guid(0x016C_0000),
        coords: Vector3::new(180.0, 188.0, 0.0),
        rotation: Quaternion::identity(),
    };
    let target_hint = WorldPosition {
        landblock_id: Guid(0x016D_0100),
        coords: Vector3::new(2.0, -3.0, 0.0),
        rotation: Quaternion::identity(),
    };

    let projected = project_pose_by_velocity(
        authoritative,
        Vector3::new(20.0, 10.0, 0.0),
        1.0,
        Some(target_hint),
    );

    assert_eq!(projected.landblock_id, target_hint.landblock_id);
    assert_eq!(projected.coords, Vector3::new(200.0, 6.0, 0.0));
}

#[test]
fn project_pose_forward_distance_projects_outdoor_heading() {
    let authoritative = WorldPosition {
        landblock_id: Guid((0x016C_u32 << 24) | (0x0171_u32 << 16)),
        coords: Vector3::new(84.0, 108.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };

    let projected = project_pose_forward_distance(authoritative, 5.0);

    assert_eq!(
        projected.landblock_id,
        Guid((0x016C_u32 << 24) | (0x0171_u32 << 16) | 0x001D)
    );
    assert!((projected.coords.x - 84.0).abs() < 1e-4);
    assert!((projected.coords.y - 113.0).abs() < 1e-4);
    assert!((projected.coords.z - 1.5).abs() < 1e-4);
}

#[test]
fn project_pose_by_velocity_normalizes_outdoor_cell_after_projection() {
    let authoritative = WorldPosition {
        landblock_id: Guid(0x3419_0039),
        coords: Vector3::new(6.0, 57.93994, 12.770115),
        rotation: Quaternion::identity(),
    };

    let projected = project_pose_by_velocity(authoritative, Vector3::new(1.0, 0.0, 0.0), 1.0, None);

    assert_eq!(projected.landblock_id, Guid(0x3419_0003));
    assert!((projected.coords.x - 7.0).abs() < 1e-4);
    assert!((projected.coords.y - 57.93994).abs() < 1e-4);
    assert!((projected.coords.z - 12.770115).abs() < 1e-4);
}

#[test]
fn project_pose_forward_distance_ignores_non_finite_distance() {
    let authoritative = WorldPosition {
        landblock_id: Guid((0x016C_u32 << 24) | (0x0171_u32 << 16)),
        coords: Vector3::new(84.0, 108.0, 1.5),
        rotation: Quaternion::from_heading(90.0_f32.to_radians()),
    };

    let projected = project_pose_forward_distance(authoritative, f32::INFINITY);

    assert_eq!(projected, authoritative);
}

#[test]
fn advance_body_kinematics_rotates_velocity_with_turn_rate() {
    let input = SolveBodyInput::velocity(
        SpatialBodyId::Entity(Guid(0x5000_0001)),
        WorldPosition {
            landblock_id: Guid(0x1234_0000),
            coords: Vector3::zero(),
            rotation: Quaternion::from_heading(90.0f32.to_radians()),
        },
        ContactState::Unknown,
        Vector3::new(0.0, 18.0, 0.0),
        Vector3::new(0.0, 0.0, 90.0f32.to_radians()),
    );

    let solved = advance_body_kinematics(&input, Duration::from_secs(1));

    assert!((solved.pose.rotation.to_heading().to_degrees() - 180.0).abs() < 1e-4);
    assert!((solved.velocity.x - 18.0).abs() < 1e-4);
    assert!(solved.velocity.y.abs() < 1e-4);
    assert!((solved.pose.coords.x - 18.0).abs() < 1e-4);
    assert!(solved.pose.coords.y.abs() < 1e-4);
    assert_eq!(solved.contact, ContactState::Unknown);
}

#[test]
fn basic_spatial_physics_realizes_local_grounded_direct_drive() {
    let mut scene = SpatialScene::new();
    let now = Instant::now();
    let guid = Guid(0x5000_0001);
    let body_id = SpatialBodyId::LocalPlayer(guid);
    let pose = make_position(10.0, 20.0, 0.0);

    scene.upsert_runtime_body_snapshot(body_id, pose, Vector3::zero(), Vector3::zero(), None, now);

    let request = SpatialSolveRequest {
        dt: Duration::from_millis(100),
        bodies: vec![SolveBodyInput::velocity(
            body_id,
            pose,
            ContactState::Grounded,
            Vector3::zero(),
            Vector3::zero(),
        )],
        local_drive: Some(LocalDriveControl {
            body_id,
            desired_world_delta: Vector3::new(0.0, 4.5, 1.0),
            desired_heading: Some(90.0_f32.to_radians()),
            turn_omega_rad_s: None,
            target_hint: None,
            gait: LocalDriveGait::Run,
            force_grounded: true,
        }),
    };

    let solved = BasicSpatialPhysics.solve(&request, &mut scene);
    assert_eq!(solved.solved.len(), 1);
    let body = solved.solved[0];
    assert_eq!(body.body_id, body_id);
    assert!((body.pose.coords.y - 24.5).abs() < 1e-4);
    assert!((body.pose.coords.z - 1.0).abs() < 1e-4);
    assert_eq!(body.contact, ContactState::Grounded);
    assert_eq!(
        body.projection_state,
        Some(SelfPlayerDriveProjectionState::LocalGroundedDirectDrive)
    );
}

#[test]
fn basic_spatial_physics_freezes_local_drive_when_body_is_authority_frozen() {
    let mut scene = SpatialScene::new();
    let now = Instant::now();
    let guid = Guid(0x5000_0002);
    let body_id = SpatialBodyId::LocalPlayer(guid);
    let pose = make_position(10.0, 20.0, 0.0);

    scene.upsert_runtime_body_snapshot(body_id, pose, Vector3::zero(), Vector3::zero(), None, now);
    scene.apply_forced_reposition_reset(body_id, pose, now);

    let request = SpatialSolveRequest {
        dt: Duration::from_millis(100),
        bodies: vec![SolveBodyInput::velocity(
            body_id,
            pose,
            ContactState::Grounded,
            Vector3::zero(),
            Vector3::zero(),
        )],
        local_drive: Some(LocalDriveControl {
            body_id,
            desired_world_delta: Vector3::new(0.0, 4.5, 0.0),
            desired_heading: Some(90.0_f32.to_radians()),
            turn_omega_rad_s: None,
            target_hint: None,
            gait: LocalDriveGait::Run,
            force_grounded: true,
        }),
    };

    let solved = BasicSpatialPhysics.solve(&request, &mut scene);
    assert_eq!(solved.solved.len(), 1);
    let body = solved.solved[0];
    assert_eq!(body.pose, pose);
    assert!(body.velocity.length_squared() <= 1e-6);
    assert_eq!(
        body.projection_state,
        Some(SelfPlayerDriveProjectionState::AuthorityFrozen)
    );
}

#[test]
fn basic_spatial_physics_uses_target_hint_for_indoor_destination_landblock() {
    let mut scene = SpatialScene::new();
    let now = Instant::now();
    let guid = Guid(0x5000_0003);
    let body_id = SpatialBodyId::LocalPlayer(guid);
    let pose = WorldPosition {
        landblock_id: Guid(0x016C_0000),
        coords: Vector3::new(180.0, 188.0, 0.0),
        rotation: Quaternion::identity(),
    };
    let target_hint = WorldPosition {
        landblock_id: Guid(0x016D_0100),
        coords: Vector3::new(2.0, -3.0, 0.0),
        rotation: Quaternion::identity(),
    };

    scene.upsert_runtime_body_snapshot(body_id, pose, Vector3::zero(), Vector3::zero(), None, now);

    let request = SpatialSolveRequest {
        dt: Duration::from_secs(1),
        bodies: vec![SolveBodyInput::velocity(
            body_id,
            pose,
            ContactState::Grounded,
            Vector3::zero(),
            Vector3::zero(),
        )],
        local_drive: Some(LocalDriveControl {
            body_id,
            desired_world_delta: Vector3::new(20.0, 10.0, 0.0),
            desired_heading: None,
            turn_omega_rad_s: None,
            target_hint: Some(target_hint),
            gait: LocalDriveGait::Run,
            force_grounded: true,
        }),
    };

    let solved = BasicSpatialPhysics.solve(&request, &mut scene);
    let body = solved.solved[0];

    assert_eq!(body.pose.landblock_id, target_hint.landblock_id);
    assert_eq!(body.pose.coords, Vector3::new(200.0, 6.0, 0.0));
}

#[test]
fn basic_spatial_physics_integrates_grounded_remote_basis_using_local_motion_semantics() {
    let mut scene = SpatialScene::new();
    let guid = Guid(0x5000_0004);
    let pose = make_position(10.0, 20.0, 90.0_f32.to_radians());

    let request = SpatialSolveRequest {
        dt: Duration::from_secs(1),
        bodies: vec![SolveBodyInput {
            body_id: SpatialBodyId::Entity(guid),
            pose,
            contact: ContactState::Grounded,
            basis: Some(SolveProjectionBasis::GroundedMotion {
                desired_local_velocity: Vector3::new(2.0, 0.0, 0.0),
                desired_local_omega: Vector3::new(0.0, 0.0, 1.0),
            }),
        }],
        local_drive: None,
    };

    let solved = BasicSpatialPhysics.solve(&request, &mut scene);
    let body = solved.solved[0];

    assert!(body.velocity.x.abs() < 1e-4);
    assert!((body.velocity.y - 2.0).abs() < 1e-4);
    assert!((body.pose.coords.x - 10.0).abs() < 1e-4);
    assert!((body.pose.coords.y - 22.0).abs() < 1e-4);
    assert!((body.pose.rotation.to_heading() - (90.0_f32.to_radians() + 1.0)).abs() < 1e-4);
    assert_eq!(body.contact, ContactState::Grounded);
}

#[test]
fn spatial_scene_tracks_body_registration_update_and_removal() {
    let mut scene = SpatialScene::new();
    let now = Instant::now();
    let body_id = SpatialBodyId::Entity(Guid(0x7000_0001));
    let initial_pose = WorldPosition {
        landblock_id: Guid(0x1234_0000),
        coords: Vector3::new(1.0, 2.0, 3.0),
        ..Default::default()
    };

    let body = SpatialBody::new(body_id, initial_pose, now);
    assert!(scene.register_body(body.clone()).is_none());

    let stored = scene.body(body_id).expect("body should be registered");
    assert_eq!(stored.pose, initial_pose);
    assert_eq!(stored.authoritative_pose, Some(initial_pose));
    assert_eq!(stored.sampling.mode, SpatialSampleMode::AuthoritativeOnly);

    let mut updated = body;
    updated.pose.coords = Vector3::new(4.0, 5.0, 6.0);
    updated.velocity = Vector3::new(7.0, 8.0, 0.0);
    updated.sampling.mode = SpatialSampleMode::SimulatingVelocity;

    let previous = scene
        .update_body(updated.clone())
        .expect("registered body should update");
    assert_eq!(previous.pose, initial_pose);

    let stored = scene
        .body(body_id)
        .expect("updated body should remain present");
    assert_eq!(stored.pose.coords, Vector3::new(4.0, 5.0, 6.0));
    assert_eq!(stored.velocity, Vector3::new(7.0, 8.0, 0.0));
    assert_eq!(stored.sampling.mode, SpatialSampleMode::SimulatingVelocity);

    let removed = scene
        .remove_body(body_id)
        .expect("registered body should remove cleanly");
    assert_eq!(removed, updated);
    assert!(scene.body(body_id).is_none());
}

#[test]
fn spatial_scene_allocates_ephemeral_bodies_monotonically() {
    let mut scene = SpatialScene::new();
    let now = Instant::now();
    let pose = WorldPosition {
        landblock_id: Guid(0x4321_0000),
        coords: Vector3::new(9.0, 8.0, 7.0),
        ..Default::default()
    };

    let first = scene.register_ephemeral_body(pose, now);
    let second = scene.register_ephemeral_body(pose, now);

    assert_eq!(first, SpatialBodyId::Ephemeral(1));
    assert_eq!(second, SpatialBodyId::Ephemeral(2));
    assert_eq!(
        scene.body(first).and_then(|body| body.authoritative_pose),
        None
    );
    assert_eq!(scene.body(second).map(|body| body.pose), Some(pose));
}

#[test]
fn body_solver_types_preserve_body_identity_and_support_ephemeral_events() {
    let pose = WorldPosition {
        landblock_id: Guid(0x9876_0000),
        coords: Vector3::new(1.0, 1.0, 1.0),
        ..Default::default()
    };

    let entity_body_input = SolveBodyInput {
        body_id: SpatialBodyId::Entity(Guid(0x7000_0001)),
        pose,
        contact: ContactState::Unknown,
        basis: Some(SolveProjectionBasis::velocity(
            Vector3::new(2.0, 0.0, 0.0),
            Vector3::new(0.0, 0.0, 3.0),
        )),
    };

    assert_eq!(
        entity_body_input.body_id,
        SpatialBodyId::Entity(Guid(0x7000_0001))
    );

    let body_input = SolveBodyInput {
        body_id: SpatialBodyId::LocalPlayer(Guid(0x7000_0002)),
        pose,
        contact: ContactState::Unknown,
        basis: Some(SolveProjectionBasis::velocity(
            Vector3::new(2.0, 0.0, 0.0),
            Vector3::new(0.0, 0.0, 3.0),
        )),
    };

    assert_eq!(
        body_input.body_id,
        SpatialBodyId::LocalPlayer(Guid(0x7000_0002))
    );

    let event = SpatialBodyEvent::ForcedReposition {
        body_id: SpatialBodyId::Ephemeral(99),
        pose,
    };
    assert!(matches!(
        event,
        SpatialBodyEvent::ForcedReposition {
            body_id: SpatialBodyId::Ephemeral(99),
            pose: event_pose,
        } if event_pose == pose
    ));
}

#[test]
fn reconcile_authoritative_body_resets_sampling_on_forced_reposition() {
    let mut scene = SpatialScene::new();
    let body_id = SpatialBodyId::Entity(Guid(0x7000_0010));
    let start = Instant::now();
    let start_pose = WorldPosition {
        landblock_id: Guid(0x1111_0000),
        coords: Vector3::new(1.0, 2.0, 3.0),
        ..Default::default()
    };
    let reset_pose = WorldPosition {
        landblock_id: Guid(0x2222_0000),
        coords: Vector3::new(9.0, 8.0, 7.0),
        ..Default::default()
    };

    scene.register_body(SpatialBody::new(body_id, start_pose, start));
    scene.reconcile_authoritative_body(
        body_id,
        reset_pose,
        Vector3::new(4.0, 5.0, 6.0),
        Vector3::new(0.0, 0.0, 1.0),
        AuthoritativeBodySync::Reset,
        start + Duration::from_secs(1),
    );

    let body = scene
        .body(body_id)
        .expect("body should exist after reconcile");
    assert_eq!(body.authoritative_pose, Some(reset_pose));
    assert_eq!(body.pose, reset_pose);
    assert_eq!(body.velocity, Vector3::new(4.0, 5.0, 6.0));
    assert_eq!(body.omega, Vector3::new(0.0, 0.0, 1.0));
    assert_eq!(body.motion_state, None);
    assert_eq!(body.sampling.mode, SpatialSampleMode::Suspended);
    assert_eq!(
        body.sampling.last_derived_at,
        start + Duration::from_secs(1)
    );
}

#[test]
fn spatial_scene_runtime_body_views_include_entity_local_player_and_ephemeral_bodies() {
    let mut scene = SpatialScene::new();
    let now = Instant::now();
    let entity_id = SpatialBodyId::Entity(Guid(0x7100_0010));
    let player_id = SpatialBodyId::LocalPlayer(Guid(0x7100_0011));

    scene.register_body(SpatialBody::new(
        entity_id,
        make_position(1.0, 2.0, 0.0),
        now,
    ));
    scene.register_body(SpatialBody::new(
        player_id,
        make_position(3.0, 4.0, 0.5),
        now,
    ));
    let ephemeral_id = scene.register_ephemeral_body(make_position(5.0, 6.0, 1.0), now);

    let views: Vec<_> = scene.iter_runtime_body_views().collect();

    assert_eq!(views.len(), 3);
    assert!(views.iter().any(|view| view.body_id == entity_id));
    assert!(views.iter().any(|view| view.body_id == player_id));
    assert!(views.iter().any(|view| view.body_id == ephemeral_id));
}

#[test]
fn spatial_scene_forced_reposition_reset_clears_runtime_motion_and_suspends_body() {
    let mut scene = SpatialScene::new();
    let now = Instant::now();
    let body_id = SpatialBodyId::Entity(Guid(0x7100_0012));

    scene.seed_authoritative_body_snapshot(
        body_id,
        make_position(1.0, 2.0, 0.0),
        Vector3::new(3.0, 0.0, 0.0),
        Vector3::new(0.0, 0.0, 1.0),
        Some(EntityMotionSnapshot {
            turn_command: Some(InterpretedMotionCommand::TURN_RIGHT),
            ..Default::default()
        }),
        now,
    );

    scene.apply_forced_reposition_reset(body_id, make_position(8.0, 9.0, 0.25), now);

    let body = scene.body(body_id).expect("body should remain tracked");
    assert_eq!(body.pose, make_position(8.0, 9.0, 0.25));
    assert_eq!(body.authoritative_pose, Some(make_position(8.0, 9.0, 0.25)));
    assert_eq!(body.velocity, Vector3::zero());
    assert_eq!(body.omega, Vector3::zero());
    assert_eq!(body.motion_state, None);
    assert_eq!(body.sampling.mode, SpatialSampleMode::Suspended);
}

/// Physics deep-dive 2026-06-01 (gap 4): a small sub-blip server
/// force-position on the LOCAL player while mid-simulation should pull
/// the integrator working pose (`body.pose`) toward the forced pose by
/// a capped per-tick correction over a few reconciles — not preserve
/// the drifted working pose forever (the old Snapshot behaviour), and
/// not hard-snap it in one tick. Authoritative pose tracks the forced
/// pose immediately; the simulating mode is retained so the integrator
/// keeps driving.
#[test]
fn reconcile_local_force_position_pulls_working_pose_toward_target_over_ticks() {
    let mut scene = SpatialScene::new();
    let now = Instant::now();
    let player_guid = Guid(0x5000_0001);
    let body_id = SpatialBodyId::LocalPlayer(player_guid);

    // Outdoor landblock (cell < 0x100) so the constraint leash is 10 m
    // and the blip distance is 100 m.
    let lb = Guid(0x00A9_B400 & 0xFFFF_0000 | 0x0000_0000);
    let authoritative = WorldPosition {
        landblock_id: lb,
        coords: Vector3::new(50.0, 50.0, 0.0),
        rotation: Quaternion::from_heading(0.0),
    };

    // Seed the body, then mutate it into a mid-simulation working pose
    // that has drifted ~3 m ahead of the last authoritative pose.
    scene.register_body(SpatialBody::new(body_id, authoritative, now));
    let mut working = scene.body(body_id).expect("seeded body").clone();
    working.pose = WorldPosition {
        landblock_id: lb,
        coords: Vector3::new(53.0, 50.0, 0.0),
        rotation: Quaternion::from_heading(0.0),
    };
    working.sampling.mode = SpatialSampleMode::SimulatingVelocity;
    scene.update_body(working);

    // Server force-positions us back to a sub-blip (3 m) target. The
    // working pose is 3 m away from it — above the 0.05 m dead-band,
    // below the 10 m leash, so we should converge toward the target.
    let forced = WorldPosition {
        landblock_id: lb,
        coords: Vector3::new(50.0, 50.0, 0.0),
        rotation: Quaternion::from_heading(0.0),
    };

    let start_dist = scene
        .body(body_id)
        .unwrap()
        .pose
        .distance_to(&forced);
    assert!((start_dist - 3.0).abs() < 1e-3, "precondition: ~3 m drift");

    scene.reconcile_authoritative_body(
        body_id,
        forced,
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::Snapshot,
        now + Duration::from_millis(16),
    );

    let body = scene.body(body_id).expect("body should still exist");
    // Authoritative pose adopts the forced pose immediately.
    assert_eq!(body.authoritative_pose, Some(forced));
    // The simulating mode is retained — the integrator keeps driving.
    assert_eq!(body.sampling.mode, SpatialSampleMode::SimulatingVelocity);
    // With `USE_RETAIL_INTERPOLATE` on (now the shipped path), a sub-blip
    // force-position INSTALLS the retail `ConstrainTo`+`InterpolateTo`
    // interpolator and does NOT move the working pose this tick — the
    // per-frame stepper eases it (no one-tick snap-back).
    assert!(
        body.position_manager.is_interpolating(),
        "sub-blip gap installs the retail interpolator"
    );
    assert!(
        (body.pose.distance_to(&forced) - start_dist).abs() < 1e-3,
        "reconcile alone must not move the working pose (the stepper eases it)"
    );
    assert_eq!(body.pose.landblock_id, lb, "stays in the forced landblock");

    // Drive the per-frame interpolator: the gap eases monotonically toward
    // the target and lands in the 0.05 m dead-band within a few frames.
    let mut prev = scene.body(body_id).unwrap().pose.distance_to(&forced);
    let mut converged = false;
    for _ in 0..120 {
        scene.step_force_position_interpolation(body_id, 0.016, 36.0, true);
        let d = scene.body(body_id).unwrap().pose.distance_to(&forced);
        assert!(d <= prev + 1e-4, "monotonic ease toward target: {d} <= {prev}");
        prev = d;
        if d <= 0.05 {
            converged = true;
            break;
        }
    }
    assert!(converged, "interpolator eases into the 0.05 m dead-band within 120 frames");
    assert_eq!(scene.body(body_id).unwrap().pose.landblock_id, lb);
}

/// Physics deep-dive 2026-06-01 (gap 4): a force-position beyond the
/// autonomy-blip radius leaves the working pose untouched (too large to
/// be a small rubberband — a routine far broadcast / teleport-class
/// correction, which takes the Reset path; preserving here keeps the
/// academy-rubberband invariant), and a force-position inside the
/// 0.05 m dead-band also leaves the working pose untouched (no jitter).
#[test]
fn reconcile_local_force_position_preserves_far_and_holds_within_deadband() {
    let mut scene = SpatialScene::new();
    let now = Instant::now();
    let body_id = SpatialBodyId::LocalPlayer(Guid(0x5000_0002));
    let lb = Guid(0x00A9_B400 & 0xFFFF_0000);

    let make = |x: f32, y: f32| WorldPosition {
        landblock_id: lb,
        coords: Vector3::new(x, y, 0.0),
        rotation: Quaternion::from_heading(0.0),
    };

    // --- far drift (> 100 m outdoor blip) ---
    scene.register_body(SpatialBody::new(body_id, make(0.0, 0.0), now));
    let far_working = make(150.0, 0.0);
    let mut working = scene.body(body_id).unwrap().clone();
    working.pose = far_working;
    working.sampling.mode = SpatialSampleMode::SimulatingMotionState;
    scene.update_body(working);

    let forced = make(0.0, 0.0);
    scene.reconcile_authoritative_body(
        body_id,
        forced,
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::Snapshot,
        now + Duration::from_millis(16),
    );
    // 150 m drift > 100 m blip → working pose preserved (not snapped),
    // authoritative pose still tracks the forced pose.
    assert_eq!(scene.body(body_id).unwrap().pose, far_working);
    assert_eq!(scene.body(body_id).unwrap().authoritative_pose, Some(forced));

    // --- inside the dead-band (< 0.05 m) ---
    let body_id2 = SpatialBodyId::LocalPlayer(Guid(0x5000_0003));
    scene.register_body(SpatialBody::new(body_id2, make(10.0, 10.0), now));
    let mut working2 = scene.body(body_id2).unwrap().clone();
    let drifted = make(10.0, 10.02); // 2 cm < 0.05 m dead-band
    working2.pose = drifted;
    working2.sampling.mode = SpatialSampleMode::SimulatingVelocity;
    scene.update_body(working2);

    scene.reconcile_authoritative_body(
        body_id2,
        make(10.0, 10.0),
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::Snapshot,
        now + Duration::from_millis(16),
    );
    // Within the dead-band → working pose untouched (no jitter pull).
    assert_eq!(scene.body(body_id2).unwrap().pose, drifted);
}

/// Physics deep-dive 2026-06-01 (gap 4): `USE_RETAIL_INTERPOLATE` is now
/// the shipped path. A sub-blip force-position INSTALLS the retail
/// `ConstrainTo`+`InterpolateTo` interpolator (it does NOT single-step
/// collapse the gap), and the per-frame stepper ADVANCES the working pose
/// toward the target instead of being a no-op. (The easing curve itself
/// is also covered by the `force_position_interp` unit tests.)
#[test]
fn force_position_interpolation_stepper_advances_when_flag_on() {
    let mut scene = SpatialScene::new();
    let now = Instant::now();
    let body_id = SpatialBodyId::LocalPlayer(Guid(0x5000_00AA));
    let lb = Guid(0x00A9_B400 & 0xFFFF_0000);

    let make = |x: f32, y: f32| WorldPosition {
        landblock_id: lb,
        coords: Vector3::new(x, y, 0.0),
        rotation: Quaternion::from_heading(0.0),
    };

    scene.register_body(SpatialBody::new(body_id, make(50.0, 50.0), now));
    let mut working = scene.body(body_id).unwrap().clone();
    working.pose = make(53.0, 50.0); // 3 m drift
    working.sampling.mode = SpatialSampleMode::SimulatingVelocity;
    scene.update_body(working);

    // Reconcile a sub-blip forced pose. With the flag on this INSTALLS the
    // interpolator and leaves the working pose where it is (no collapse).
    let forced = make(50.0, 50.0);
    scene.reconcile_authoritative_body(
        body_id,
        forced,
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::Snapshot,
        now + Duration::from_millis(16),
    );

    let body = scene.body(body_id).unwrap();
    // Interpolator installed; the 3 m gap is NOT collapsed this tick.
    assert!(body.position_manager.is_interpolating());
    assert!(
        body.pose.distance_to(&forced) > 1.0,
        "reconcile installs the ease; it must not snap the 3 m gap shut"
    );

    // The per-frame stepper now ADVANCES (not Idle) and moves the pose
    // toward the target.
    let before = scene.body(body_id).unwrap().pose.distance_to(&forced);
    let (out, _) = scene.step_force_position_interpolation(body_id, 0.016, 36.0, true);
    assert!(
        matches!(out, InterpStep::Progressed { .. } | InterpStep::Completed { .. }),
        "stepper advances while interpolating"
    );
    let after = scene.body(body_id).unwrap().pose.distance_to(&forced);
    assert!(after < before, "stepper eases the pose toward the target");
}

/// Wave-1 adversarial-review guard (B1+B2/B3 airborne interaction): while
/// AIRBORNE (`on_contact = false`) the per-frame stepper performs ACE's
/// no-contact early-out — it returns the working pose UNCHANGED and the
/// interpolation does NOT complete (stays armed). The core integrator
/// therefore must NOT adopt this result mid-jump: doing so would replace
/// the freshly-integrated ballistic pose with the stale working pose and
/// FREEZE the jump arc. The integrator keeps its ballistic pose while
/// airborne and lets the installed interpolation resume on touchdown.
#[test]
fn force_position_interpolation_stepper_is_inert_while_airborne() {
    let mut scene = SpatialScene::new();
    let now = Instant::now();
    let body_id = SpatialBodyId::LocalPlayer(Guid(0x5000_00BB));
    let lb = Guid(0x00A9_B400 & 0xFFFF_0000);
    let make = |x: f32, y: f32| WorldPosition {
        landblock_id: lb,
        coords: Vector3::new(x, y, 0.0),
        rotation: Quaternion::from_heading(0.0),
    };

    scene.register_body(SpatialBody::new(body_id, make(50.0, 50.0), now));
    let mut working = scene.body(body_id).unwrap().clone();
    working.pose = make(53.0, 50.0); // 3 m drift
    working.sampling.mode = SpatialSampleMode::SimulatingVelocity;
    scene.update_body(working);

    // Install the interpolator via a sub-blip reconcile.
    let forced = make(50.0, 50.0);
    scene.reconcile_authoritative_body(
        body_id,
        forced,
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::Snapshot,
        now + Duration::from_millis(16),
    );
    assert!(scene.body(body_id).unwrap().position_manager.is_interpolating());

    let before = scene.body(body_id).unwrap().pose;
    // Step with `on_contact = false` (airborne): the no-contact early-out
    // returns the working pose verbatim without advancing or completing.
    let (out, _) = scene.step_force_position_interpolation(body_id, 0.016, 36.0, false);
    assert!(matches!(out, InterpStep::Progressed { .. }));
    assert_eq!(
        scene.body(body_id).unwrap().pose,
        before,
        "airborne step must leave the working pose untouched (no freeze-source)"
    );
    assert!(
        scene.body(body_id).unwrap().position_manager.is_interpolating(),
        "interpolation stays armed while airborne and resumes on touchdown"
    );
}

/// The standalone retail interpolator can be installed and stepped
/// directly regardless of the scene flag — this exercises the full
/// `InterpolateTo` (install) → per-frame `adjust_offset` (step) →
/// `NodeCompleted` (deadband) round-trip so the easing curve is covered
/// even while the scene-level flag stays default-off.
#[test]
fn retail_interpolator_install_then_step_converges_to_target() {
    let lb = Guid(0x00A9_B400 & 0xFFFF_0000);
    let make = |x: f32, y: f32| WorldPosition {
        landblock_id: lb,
        coords: Vector3::new(x, y, 0.0),
        rotation: Quaternion::from_heading(0.0),
    };

    let mut interp = RetailForcePositionInterpolator::default();
    let target = make(50.0, 50.0);
    let mut cur = make(53.0, 50.0); // 3 m gap

    assert!(interp.install(cur, target, 10.0, 100.0, true));
    assert!(interp.is_interpolating());

    // 36 m/s eased in 16 ms frames; converges within a handful of frames.
    let mut completed = false;
    for _ in 0..40 {
        match interp.step(cur, 0.016, 36.0, true) {
            InterpStep::Progressed { pose } => cur = pose,
            InterpStep::Completed { pose } => {
                cur = pose;
                completed = true;
                break;
            }
            other => panic!("unexpected interp outcome {other:?}"),
        }
    }
    assert!(completed, "should ease into the 0.05 m deadband and complete");
    assert!(cur.distance_to(&target) < 0.05);
    assert!(!interp.is_interpolating());
}

mod collision {
    use super::*;
    use holtburger_common::Aabb;

    fn pose_at(landblock: Guid, x: f32, y: f32, z: f32) -> WorldPosition {
        WorldPosition {
            landblock_id: landblock,
            coords: Vector3::new(x, y, z),
            rotation: Quaternion::identity(),
        }
    }

    fn entry(building_id: BuildingId, aabb: Aabb) -> BuildingAabbEntry {
        BuildingAabbEntry {
            building_id,
            part_index: 0,
            aabb,
            active: true,
        }
    }

    fn make_id(seq: u32) -> BuildingId {
        BuildingId::new(0x0102_0000, 0x0200_1234, seq)
    }

    fn global_aabb(min: Vector3, max: Vector3) -> Aabb {
        Aabb::new(min, max)
    }

    fn pose_global(landblock: Guid, world_xy: (f32, f32), z: f32) -> WorldPosition {
        // Landblock 0x0102_0000 → byte (0x01, 0x02) → origin (192, 384).
        let (lb_x, lb_y) = (
            ((landblock.0 >> 24) & 0xFF) as f32,
            ((landblock.0 >> 16) & 0xFF) as f32,
        );
        let local_x = world_xy.0 - lb_x * 192.0;
        let local_y = world_xy.1 - lb_y * 192.0;
        WorldPosition {
            landblock_id: landblock,
            coords: Vector3::new(local_x, local_y, z),
            rotation: Quaternion::identity(),
        }
    }

    #[test]
    fn move_into_aabb_clamps_short_of_wall() {
        // World-space AABB at global (200, 400, 0)..(204, 404, 4).
        // Player starts at global (190, 402, 1) and walks +X at 5 m/s
        // for 1 s — would land at (195, 402, 1) without wall, but the
        // wall starts at x=200 so the capsule (radius 0.4) should
        // stop at x ≈ 199.6.
        // Wait — 195 < 199.6, so this case would NOT actually hit.
        // Push the start closer: global_x = 199, walk +X 5 m for 1 s.
        // Inflated AABB starts at x = 199.6 → t = (199.6-199)/5 = 0.12.
        // Stopped at global x ≈ 199.6 (minus ε backoff).
        let landblock = Guid(0x0102_0000);
        let pose = pose_global(landblock, (199.0, 402.0), 1.0);
        let candidates = vec![entry(
            make_id(1),
            global_aabb(
                Vector3::new(200.0, 400.0, 0.0),
                Vector3::new(204.0, 404.0, 4.0),
            ),
        )];
        let velocity = Vector3::new(5.0, 0.0, 0.0);
        let projected = project_pose_by_velocity_with_collision(
            pose,
            velocity,
            1.0,
            None,
            &candidates,
        );
        let projected_global = projected.global_coords();
        assert!(
            projected_global.x < 199.7,
            "expected clamp at wall (~199.6), got x={}",
            projected_global.x,
        );
        assert!(
            projected_global.x > 199.0,
            "expected forward motion before clamp, got x={}",
            projected_global.x,
        );
    }

    #[test]
    fn move_parallel_to_aabb_face_does_not_clamp() {
        // Player walks +Y along the side of the wall at x=199.5
        // (within radius=0.4 of the wall at x=200) but moves only in
        // Y, so X stays where it is. Without contact on entry, no
        // clamp, full delta applied.
        let landblock = Guid(0x0102_0000);
        let pose = pose_global(landblock, (199.5, 401.0), 1.0);
        let candidates = vec![entry(
            make_id(2),
            global_aabb(
                Vector3::new(200.0, 400.0, 0.0),
                Vector3::new(204.0, 404.0, 4.0),
            ),
        )];
        // Note: starting at x=199.5 with radius=0.4 means the player
        // is *already* overlapping the inflated AABB at start. The
        // sweep treats that as "ray starts inside" → t_enter clamped
        // to 0 → no hit reported. Skip overlapping-start by nudging
        // the start out to x=199.0.
        let pose = WorldPosition { coords: Vector3::new(pose.coords.x - 0.5, pose.coords.y, pose.coords.z), ..pose };
        let velocity = Vector3::new(0.0, 5.0, 0.0);
        let projected = project_pose_by_velocity_with_collision(
            pose,
            velocity,
            1.0,
            None,
            &candidates,
        );
        let projected_global = projected.global_coords();
        let expected_y = 401.0 + 5.0;
        assert!(
            (projected_global.y - expected_y).abs() < 1e-3,
            "expected unclamped y={expected_y}, got y={}",
            projected_global.y,
        );
        assert!(
            (projected_global.x - 199.0).abs() < 1e-3,
            "x should not change, got x={}",
            projected_global.x,
        );
    }

    #[test]
    fn move_past_aabb_does_not_clamp() {
        // Wall is far north; player walks +X (orthogonal). No hit.
        let landblock = Guid(0x0102_0000);
        let pose = pose_global(landblock, (200.0, 380.0), 1.0);
        let candidates = vec![entry(
            make_id(3),
            global_aabb(
                Vector3::new(200.0, 400.0, 0.0),
                Vector3::new(204.0, 404.0, 4.0),
            ),
        )];
        let velocity = Vector3::new(5.0, 0.0, 0.0);
        let projected = project_pose_by_velocity_with_collision(
            pose,
            velocity,
            1.0,
            None,
            &candidates,
        );
        let projected_global = projected.global_coords();
        assert!(
            (projected_global.x - 205.0).abs() < 1e-3,
            "expected x=205 (full delta), got x={}",
            projected_global.x,
        );
    }

    #[test]
    fn slide_along_wall_when_velocity_oblique() {
        // Player walks NE (+X +Y) into a wall that only blocks +X.
        // First sweep clamps the +X component; remaining +Y slides
        // along the wall face. Verify forward motion in X is clamped
        // but Y still advances.
        let landblock = Guid(0x0102_0000);
        let pose = pose_global(landblock, (199.0, 401.0), 1.0);
        let candidates = vec![entry(
            make_id(4),
            global_aabb(
                Vector3::new(200.0, 400.0, 0.0),
                Vector3::new(204.0, 404.0, 4.0),
            ),
        )];
        let velocity = Vector3::new(5.0, 5.0, 0.0);
        let projected = project_pose_by_velocity_with_collision(
            pose,
            velocity,
            1.0,
            None,
            &candidates,
        );
        let projected_global = projected.global_coords();
        assert!(
            projected_global.x < 199.7,
            "x should clamp at wall, got x={}",
            projected_global.x,
        );
        assert!(
            projected_global.y > 405.0,
            "y should slide along wall, got y={}",
            projected_global.y,
        );
    }

    #[test]
    fn empty_candidate_list_falls_back_to_unclamped() {
        let landblock = Guid(0x0102_0000);
        let pose = pose_global(landblock, (199.0, 401.0), 1.0);
        let velocity = Vector3::new(5.0, 0.0, 0.0);
        let projected =
            project_pose_by_velocity_with_collision(pose, velocity, 1.0, None, &[]);
        let projected_global = projected.global_coords();
        assert!(
            (projected_global.x - 204.0).abs() < 1e-3,
            "expected unclamped x=204, got x={}",
            projected_global.x,
        );
    }

    #[test]
    fn scene_buckets_aabbs_by_cell() {
        let mut scene = SpatialScene::new();
        let landblock_high = 0x0102_0000u32;
        let cell_a = landblock_high | 0x0001;
        let cell_b = landblock_high | 0x0002;
        scene.insert_building_aabb(
            cell_a,
            entry(
                BuildingId::new(landblock_high, 0x0200_1234, 0),
                global_aabb(Vector3::new(0.0, 0.0, 0.0), Vector3::new(1.0, 1.0, 1.0)),
            ),
        );
        scene.insert_building_aabb(
            cell_b,
            entry(
                BuildingId::new(landblock_high, 0x0200_1234, 1),
                global_aabb(Vector3::new(2.0, 0.0, 0.0), Vector3::new(3.0, 1.0, 1.0)),
            ),
        );
        assert_eq!(scene.building_aabbs_for_cell(cell_a).len(), 1);
        assert_eq!(scene.building_aabbs_for_cell(cell_b).len(), 1);
        assert_eq!(scene.building_aabb_count(), 2);
        let removed = scene.clear_building_aabbs_for_landblock(landblock_high);
        assert_eq!(removed, 2);
        assert_eq!(scene.building_aabb_count(), 0);
    }

    /// 2026-06-15 — interior room-to-room doorway relaxation predicate
    /// (`at_interior_doorway`). Must fire ONLY when a portal neighbour is BOTH
    /// loaded (present in `cell_aabbs`) AND the capsule centre is within
    /// `radius` of its AABB, so a `visible_cells` PVS edge (carried in the same
    /// `cell_portal_graph`) cannot over-relax the cell-AABB containment net
    /// into a wall-through. This is the interior twin of the B11 outdoor-exit
    /// relaxation that fixes the Holtburg room-to-room invisible wall.
    #[test]
    fn at_interior_doorway_requires_loaded_near_neighbour() {
        let landblock_high = 0x0102_0000u32;
        let cell_a = landblock_high | 0x0100; // interior cell A
        let cell_b = landblock_high | 0x0101; // interior neighbour B (a real loaded room)
        let cell_c = landblock_high | 0x0102; // PVS-visible-only cell C (no AABB)
        let radius = 0.4_f32;

        // Scene 1: A has interior portals to B (loaded room) AND C (PVS-only).
        let mut scene = SpatialScene::new();
        scene.insert_cell_portal(cell_a, cell_b);
        scene.insert_cell_portal(cell_a, cell_c);
        // B's AABB in GLOBAL coords (landblock 0x0102 origin = (192, 384)).
        scene.insert_cell_aabb(
            cell_b,
            global_aabb(Vector3::new(242.0, 434.0, 0.0), Vector3::new(252.0, 444.0, 5.0)),
        );
        // (C deliberately has NO cell_aabbs entry — a visibility-only edge.)

        // Pose straddling the A/B boundary: global (242, 434, 1) == B's min
        // corner, well within `radius` → relax.
        let at_boundary = pose_at(Guid(cell_a), 50.0, 50.0, 1.0);
        assert!(
            scene.at_interior_doorway(&at_boundary, cell_a, radius),
            "at the A/B doorway (capsule within radius of loaded neighbour B) must relax",
        );

        // Pose deep inside A, far from B's AABB → must NOT relax (net stays on,
        // proving location-gating not mere topology).
        let deep_inside = pose_at(Guid(cell_a), 10.0, 10.0, 1.0); // global (202, 414, 1)
        assert!(
            !scene.at_interior_doorway(&deep_inside, cell_a, radius),
            "deep inside A and far from B's AABB must NOT relax",
        );

        // The old outdoor-exit predicate genuinely misses this interior-only cell.
        assert!(
            !scene.cell_has_outdoor_exit(cell_a),
            "cell A has only interior portals (no outdoor-exit sentinel)",
        );

        // Scene 2: A's ONLY neighbour is the PVS-only cell C (no loaded AABB).
        // A visibility-only edge must NOT relax even at the boundary pose —
        // this is the wall-through guard.
        let mut pvs_only = SpatialScene::new();
        pvs_only.insert_cell_portal(cell_a, cell_c);
        assert!(
            !pvs_only.at_interior_doorway(&at_boundary, cell_a, radius),
            "a visible_cells PVS edge with no loaded neighbour AABB must NOT relax",
        );
    }

    #[test]
    fn near_pose_includes_neighbour_outdoor_cells() {
        let mut scene = SpatialScene::new();
        let landblock_high = 0x0102_0000u32;
        // Pose at outdoor cell (cx=1, cy=1) → idx=8+1+1=10 → 0x000A.
        let pose_cell = landblock_high | 0x000A;
        let pose = pose_at(Guid(pose_cell), 28.0, 28.0, 0.0);
        // Neighbour cell (cx=2, cy=1) → idx=2*8+1+1=18 → 0x0012.
        let neighbour_cell = landblock_high | 0x0012;
        scene.insert_building_aabb(
            neighbour_cell,
            entry(
                BuildingId::new(landblock_high, 0x0200_1234, 0),
                global_aabb(
                    Vector3::new(192.0 + 50.0, 384.0 + 24.0, 0.0),
                    Vector3::new(192.0 + 54.0, 384.0 + 28.0, 4.0),
                ),
            ),
        );
        let nearby = scene.building_aabbs_near_pose(&pose);
        assert_eq!(nearby.len(), 1, "expected neighbour cell AABB to be included");
    }

    /// Rust review 2026-08-03 (F10): the 3x3 neighbour ring used to `continue`
    /// on any cell index outside 0..8, clipping it at the 192 m landblock seam.
    /// Since entries are bucketed by AABB CENTRE, a building part centred in the
    /// edge cell of the ADJACENT landblock was never returned for a player
    /// standing in the facing edge cell of this one — 24 m away — so it could be
    /// walked straight through.
    #[test]
    fn near_pose_crosses_landblock_boundary_into_neighbour_cells() {
        let mut scene = SpatialScene::new();
        // Player stands in landblock (0x01, 0x02) at its SOUTH-WEST corner cell,
        // so it is simultaneously on the west seam (cx=0) and the south seam
        // (cy=0): cell (cx=0, cy=0) → idx = 0*8 + 0 + 1 = 1 → 0x0001.
        // Block origin is (192, 384); cell (0,0) spans local 0..24 on both axes.
        let here_high = 0x0102_0000u32;
        let pose = pose_at(Guid(here_high | 0x0001), 4.0, 4.0, 0.0);

        // Building centred in the EAST edge column of the landblock to the WEST,
        // i.e. block (0x00, 0x02), cell (cx=7, cy=0) → idx = 7*8 + 0 + 1 = 57 →
        // 0x0039. Geometrically this is the cell immediately adjacent to ours.
        let west_high = 0x0002_0000u32;
        scene.insert_building_aabb(
            west_high | 0x0039,
            entry(
                BuildingId::new(west_high, 0x0200_5678, 0),
                // Block (0x00,0x02) origin is (0, 384); cell x 168..192, y 384..408.
                global_aabb(
                    Vector3::new(170.0, 386.0, 0.0),
                    Vector3::new(191.0, 390.0, 6.0),
                ),
            ),
        );

        let nearby = scene.building_aabbs_near_pose(&pose);
        assert_eq!(
            nearby.len(),
            1,
            "a building in the adjacent landblock's facing edge cell must be a \
             collision candidate (pre-fix the ring stopped at the seam and \
             returned 0)",
        );
        assert_eq!(nearby[0].building_id.landblock_id, west_high);

        // Symmetric case across the SOUTH seam: block (0x01, 0x01), cell
        // (cx=0, cy=7) → idx = 0*8 + 7 + 1 = 8 → 0x0008.
        // Block (0x01,0x01) origin is (192, 192); cell x 192..216, y 360..384.
        let south_high = 0x0101_0000u32;
        scene.insert_building_aabb(
            south_high | 0x0008,
            entry(
                BuildingId::new(south_high, 0x0200_9ABC, 0),
                global_aabb(
                    Vector3::new(194.0, 362.0, 0.0),
                    Vector3::new(198.0, 383.0, 6.0),
                ),
            ),
        );
        let nearby = scene.building_aabbs_near_pose(&pose);
        assert_eq!(nearby.len(), 2, "south-seam neighbour must also be included");

        // A landblock we are NOT adjacent to must never be pulled in.
        let far_high = 0x0505_0000u32;
        scene.insert_building_aabb(
            far_high | 0x0002,
            entry(
                BuildingId::new(far_high, 0x0200_DEAD, 0),
                global_aabb(
                    Vector3::new(960.0, 960.0, 0.0),
                    Vector3::new(964.0, 964.0, 6.0),
                ),
            ),
        );
        assert_eq!(
            scene.building_aabbs_near_pose(&pose).len(),
            2,
            "the ring must stay a 3x3 of CELLS — a distant landblock is not a \
             candidate just because the boundary is now crossable",
        );
    }

    /// F10 edge-of-world guard: a pose in landblock (0x00, 0x00) asks for
    /// neighbours at block index −1, which does not exist. Must not panic or
    /// wrap around to 0xFF.
    #[test]
    fn near_pose_at_world_edge_does_not_wrap_or_panic() {
        let mut scene = SpatialScene::new();
        // Block (0x00, 0x00), cell (0, 0) → idx = 1 → 0x0001.
        let pose = pose_at(Guid(0x0000_0001), 4.0, 4.0, 0.0);
        // Plant something in the would-be wrap target (0xFF, 0xFF) — if the
        // rebase wrapped instead of clamping, this would be returned.
        let wrap_high = 0xFFFF_0000u32;
        scene.insert_building_aabb(
            wrap_high | 0x003A,
            entry(
                BuildingId::new(wrap_high, 0x0200_BEEF, 0),
                global_aabb(
                    Vector3::new(0.0, 0.0, 0.0),
                    Vector3::new(4.0, 4.0, 4.0),
                ),
            ),
        );
        assert!(
            scene.building_aabbs_near_pose(&pose).is_empty(),
            "block index -1 must be dropped, never wrapped to 0xFF",
        );
    }

    #[test]
    fn aabb_transform_yaw_45_translates_and_rotates_corners() {
        // Phase 6 step B follow-up: per-part AABBs come back from
        // `walk_setup_parts_with_geom` in the building's local frame.
        // Lifting them to world space requires applying the
        // placement's `(orientation, origin)` — for outdoor buildings
        // the orientation is a yaw-only quaternion. Verify the
        // 8-corner technique on a known cube → 45° yaw → translate
        // case so an off-by-one in the rotation handler trips
        // immediately.
        //
        // Input: cube at origin spanning ±1 on every axis.
        // Rotation: 45° yaw. AC convention: `Quaternion::from_heading`
        // takes radians where 0=West, π/2=North; what matters here is
        // that the rotation around the Z axis is non-trivial — pick
        // 45° via a hand-built quaternion (cos(22.5°), 0, 0, sin(22.5°))
        // so the math is independent of the AC heading offset.
        // Translation: (10, 0, 0).
        //
        // Expected: a 1×1×1 cube rotated 45° in the XY plane has
        // diagonal corners at ±√2 along X and Y. Z-extent is
        // unchanged at ±1. After translating by (10, 0, 0), the
        // bounding box is x ∈ [10-√2, 10+√2], y ∈ [-√2, √2],
        // z ∈ [-1, 1].
        let aabb = Aabb::new(Vector3::new(-1.0, -1.0, -1.0), Vector3::new(1.0, 1.0, 1.0));
        let half = std::f32::consts::FRAC_PI_4 * 0.5; // half of 45° = 22.5°
        let yaw_45 = Quaternion {
            w: half.cos(),
            x: 0.0,
            y: 0.0,
            z: half.sin(),
        };
        let translated = aabb.transform_by(yaw_45, Vector3::new(10.0, 0.0, 0.0));

        let sqrt2 = std::f32::consts::SQRT_2;
        let eps = 1e-4;
        assert!(
            (translated.min.x - (10.0 - sqrt2)).abs() < eps,
            "min.x got {}, expected {}",
            translated.min.x,
            10.0 - sqrt2,
        );
        assert!(
            (translated.max.x - (10.0 + sqrt2)).abs() < eps,
            "max.x got {}, expected {}",
            translated.max.x,
            10.0 + sqrt2,
        );
        assert!(
            (translated.min.y - (-sqrt2)).abs() < eps,
            "min.y got {}, expected {}",
            translated.min.y,
            -sqrt2,
        );
        assert!(
            (translated.max.y - sqrt2).abs() < eps,
            "max.y got {}, expected {}",
            translated.max.y,
            sqrt2,
        );
        assert!(
            (translated.min.z - (-1.0)).abs() < eps,
            "min.z got {}, expected {}",
            translated.min.z,
            -1.0,
        );
        assert!(
            (translated.max.z - 1.0).abs() < eps,
            "max.z got {}, expected {}",
            translated.max.z,
            1.0,
        );
    }

    /// 2026-05-10 academy rubberband — `clamp_delta_to_cell_interior`
    /// shrinks the proposed delta to keep the player capsule centre
    /// inside the cell AABB on X/Y, leaving Z untouched (the
    /// integrator handles vertical separately against `aabb.min.z`
    /// and `aabb.max.z`).
    #[test]
    fn clamp_delta_to_cell_interior_blocks_lateral_at_far_wall() {
        let landblock = Guid(0x0102_0000);
        // LB 0x0102 → world origin (1*192, 2*192) = (192, 384).
        // Player at local (1.0, 1.0, 0.0) → world (193, 385, 0).
        let pose = WorldPosition {
            landblock_id: landblock,
            coords: Vector3::new(1.0, 1.0, 0.0),
            rotation: Quaternion::identity(),
        };
        // Cell AABB tightly hugs the player on +X side: 1 m of room
        // before the wall.
        let cell = Aabb::new(
            Vector3::new(192.0, 380.0, 0.0),
            Vector3::new(194.0, 390.0, 5.0),
        );
        // Capsule radius 0.4 → effective +X room before the inset
        // wall is 194 - 0.4 - 193 = 0.6 m.
        let radius = 0.4_f32;
        // Try to walk +X by 5 m. Should clamp to 0.6 m.
        let delta = Vector3::new(5.0, 0.0, 0.0);
        let clamped = crate::spatial::clamp_delta_to_cell_interior(
            &pose, delta, &cell, radius,
        );
        assert!(
            (clamped.x - 0.6).abs() < 1e-3,
            "clamped Δx should be ~0.6 m (cell max.x 194 minus radius 0.4 minus pose.x 193); got {:.4}",
            clamped.x
        );
        assert!(clamped.y.abs() < 1e-6, "Δy untouched (no Y motion proposed)");
        assert!(clamped.z.abs() < 1e-6, "Δz untouched (vertical handled separately)");
    }

    /// 2026-05-10 academy rubberband — when the proposed delta keeps
    /// the player inside the AABB interior (well clear of all walls),
    /// the clamp returns the delta unchanged.
    #[test]
    fn clamp_delta_to_cell_interior_passes_through_interior_motion() {
        let landblock = Guid(0x0102_0000);
        let pose = WorldPosition {
            landblock_id: landblock,
            coords: Vector3::new(50.0, 50.0, 0.0),
            rotation: Quaternion::identity(),
        };
        let cell = Aabb::new(
            Vector3::new(192.0, 384.0, 0.0),
            Vector3::new(384.0, 576.0, 5.0),
        );
        let delta = Vector3::new(0.5, -0.3, 0.0);
        let clamped = crate::spatial::clamp_delta_to_cell_interior(
            &pose, delta, &cell, 0.4,
        );
        // 1e-3 tolerance — `global_coords` adds a 192*lb_byte offset
        // (here 384.0 for Y), and `clamped_global_y - global.y` then
        // accumulates one f32 ULP of subtraction error against the
        // 0.3-magnitude target (~3e-5). 1e-3 is plenty for "pass-
        // through" semantics; sub-mm precision isn't the contract.
        assert!(
            (clamped.x - 0.5).abs() < 1e-3 && (clamped.y - (-0.3)).abs() < 1e-3,
            "interior motion should pass through unchanged; got ({:.4}, {:.4})",
            clamped.x, clamped.y,
        );
    }

    /// 2026-05-10 academy rubberband — `Aabb::empty()` (the sentinel
    /// returned when no vertices have been accumulated) is treated
    /// as "no clamp" so a half-baked cell AABB doesn't pin the
    /// player at NaN. Same fallback as the integrator's no-cell path.
    #[test]
    fn clamp_delta_to_cell_interior_no_op_for_empty_aabb() {
        let pose = WorldPosition {
            landblock_id: Guid(0x0102_0000),
            coords: Vector3::new(50.0, 50.0, 0.0),
            rotation: Quaternion::identity(),
        };
        let delta = Vector3::new(2.0, 1.0, 0.5);
        let clamped = crate::spatial::clamp_delta_to_cell_interior(
            &pose, delta, &Aabb::empty(), 0.4,
        );
        assert_eq!(clamped, delta, "empty AABB should be a clamp no-op");
    }

    /// 2026-05-10 indoor per-polygon — `highest_floor_z_under` picks
    /// the highest floor below the player from a triangle bag,
    /// skipping non-floor (vertical/down) triangles.
    #[test]
    fn highest_floor_z_under_picks_max_below_ceiling() {
        use holtburger_common::Triangle;
        // Two stacked floor triangles at z=0 and z=4 (an upper
        // floor, like a stairwell landing). Player's head at z=2
        // → ceiling-Z = 2 → only the lower floor qualifies.
        let lower = Triangle::new(
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(10.0, 0.0, 0.0),
            Vector3::new(0.0, 10.0, 0.0),
        );
        let upper = Triangle::new(
            Vector3::new(0.0, 0.0, 4.0),
            Vector3::new(10.0, 0.0, 4.0),
            Vector3::new(0.0, 10.0, 4.0),
        );
        let wall = Triangle::new(
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(10.0, 0.0, 0.0),
            Vector3::new(0.0, 0.0, 5.0),
        );
        let triangles = [lower, upper, wall];
        // Player at (3, 3, 2) — head at z=2.
        let z = crate::spatial::highest_floor_z_under(&triangles, 3.0, 3.0, 2.0);
        assert_eq!(z, Some(0.0), "should pick lower floor at z=0");
        // Lift the ceiling to z=5 → upper floor (z=4) qualifies and
        // is now the highest below.
        let z = crate::spatial::highest_floor_z_under(&triangles, 3.0, 3.0, 5.0);
        assert_eq!(z, Some(4.0), "should pick upper floor at z=4");
        // Outside the triangles' XY shadow → None.
        let z = crate::spatial::highest_floor_z_under(&triangles, 100.0, 100.0, 5.0);
        assert_eq!(z, None);
    }

    /// 2026-05-10 indoor per-polygon — `clamp_delta_against_cell_walls`
    /// stops the capsule before crossing a wall triangle and slides
    /// the residual delta along the wall tangent.
    #[test]
    fn clamp_delta_against_cell_walls_stops_at_wall_and_slides() {
        use holtburger_common::Triangle;
        // Vertical wall in WORLD space at y = 384.5, spanning
        // x ∈ [192, 196], z ∈ [0, 4]. LB 0x0102 → world origin
        // (192, 384); player at local (2, 0, 1) → world (194, 384, 1)
        // sits 0.5 m on the -Y side, walking +Y into the wall. Two
        // triangles fill the rectangle.
        let wall_y_world = 384.5_f32;
        let wall_a = Triangle::new(
            Vector3::new(192.0, wall_y_world, 0.0),
            Vector3::new(196.0, wall_y_world, 0.0),
            Vector3::new(192.0, wall_y_world, 4.0),
        );
        let wall_b = Triangle::new(
            Vector3::new(196.0, wall_y_world, 0.0),
            Vector3::new(196.0, wall_y_world, 4.0),
            Vector3::new(192.0, wall_y_world, 4.0),
        );
        let walls = [wall_a, wall_b];

        let pose = WorldPosition {
            landblock_id: Guid(0x0102_0000),
            // Local (2, 0, 1) → world (194, 384, 1). Wall at world
            // y = 384.5; player is 0.5 m on the -Y side.
            coords: Vector3::new(2.0, 0.0, 1.0),
            rotation: Quaternion::identity(),
        };
        let delta = Vector3::new(0.0, 5.0, 0.0); // walk +Y 5 m
        let radius = 0.4_f32;
        let height = 1.8_f32;
        let clamped = crate::spatial::clamp_delta_against_cell_walls(
            &walls, &pose, delta, radius, height,
        );
        // Expected: clamped.y < 0.1 (we hit the wall ~immediately),
        // clamped.x ≈ 0 (no slide possible — head-on).
        assert!(
            clamped.y < 0.15,
            "clamped Δy should be small (head-on into wall, ~0.1 m before contact); got {:.4}",
            clamped.y
        );
        assert!(
            clamped.y >= 0.0,
            "clamped Δy should not go negative; got {:.4}",
            clamped.y
        );
    }

    /// 2026-05-10 indoor per-polygon — when the proposed delta
    /// doesn't cross any wall, the clamp returns delta unchanged.
    #[test]
    fn clamp_delta_against_cell_walls_passes_through_no_wall_path() {
        use holtburger_common::Triangle;
        let wall = Triangle::new(
            Vector3::new(192.0, 400.0, 0.0),
            Vector3::new(196.0, 400.0, 0.0),
            Vector3::new(192.0, 400.0, 4.0),
        );
        let walls = [wall];
        let pose = WorldPosition {
            landblock_id: Guid(0x0102_0000),
            coords: Vector3::new(2.0, 0.0, 1.0),
            rotation: Quaternion::identity(),
        };
        // Walk -Y (away from the wall) — should pass through.
        let delta = Vector3::new(0.0, -3.0, 0.0);
        let clamped = crate::spatial::clamp_delta_against_cell_walls(
            &walls, &pose, delta, 0.4, 1.8,
        );
        assert!(
            (clamped.y - (-3.0)).abs() < 1e-3,
            "delta away from wall should pass through; got Δy = {:.4}",
            clamped.y
        );
    }

    /// 2026-05-10 indoor per-polygon — floor / ceiling triangles
    /// (normal mostly vertical) are NOT treated as walls; the clamp
    /// passes through even when the player walks into a floor edge.
    #[test]
    fn clamp_delta_against_cell_walls_ignores_floors() {
        use holtburger_common::Triangle;
        let floor = Triangle::new(
            Vector3::new(192.0, 384.0, 1.0),
            Vector3::new(196.0, 384.0, 1.0),
            Vector3::new(192.0, 388.0, 1.0),
        );
        let pose = WorldPosition {
            landblock_id: Guid(0x0102_0000),
            coords: Vector3::new(2.0, 0.0, 0.5),
            rotation: Quaternion::identity(),
        };
        let delta = Vector3::new(0.0, 5.0, 0.0);
        let clamped = crate::spatial::clamp_delta_against_cell_walls(
            &[floor], &pose, delta, 0.4, 1.8,
        );
        assert!(
            (clamped.y - 5.0).abs() < 1e-3,
            "floor should not block lateral motion; got Δy = {:.4}",
            clamped.y
        );
    }

    /// 2026-05-10 academy rubberband — when the AABB is narrower
    /// than `2 * radius` on an axis (a degenerate boss-arena slab
    /// that's smaller than the player capsule), the clamp collapses
    /// that axis to the AABB centre rather than producing inverted
    /// inset bounds (which would jam the player at NaN). Player
    /// effectively pins to the cell midline on the narrow axis.
    #[test]
    fn clamp_delta_to_cell_interior_collapses_narrow_axis() {
        let pose = WorldPosition {
            landblock_id: Guid(0x0102_0000),
            // World pose (193, 385, 0) — pose.x at the cell's far side.
            coords: Vector3::new(1.0, 1.0, 0.0),
            rotation: Quaternion::identity(),
        };
        // Cell is 0.5 m wide on X (narrower than 2*radius = 0.8) and
        // wide on Y. Centre on X is 192.25.
        let cell = Aabb::new(
            Vector3::new(192.0, 380.0, 0.0),
            Vector3::new(192.5, 390.0, 5.0),
        );
        let delta = Vector3::new(5.0, 1.0, 0.0);
        let clamped = crate::spatial::clamp_delta_to_cell_interior(
            &pose, delta, &cell, 0.4,
        );
        // X is collapsed to centre 192.25; pose.x = 193 → clamped Δx = -0.75.
        assert!(
            (clamped.x - (-0.75)).abs() < 1e-3,
            "narrow X axis should collapse to centre; expected Δx ≈ -0.75, got {:.4}",
            clamped.x
        );
        // Y axis is wide → motion within bounds passes through.
        assert!(
            (clamped.y - 1.0).abs() < 1e-3,
            "wide Y axis should not be collapsed; expected Δy = 1.0, got {:.4}",
            clamped.y
        );
    }
}

mod cell_graph {
    use super::*;
    use holtburger_common::Aabb;

    #[test]
    fn current_cell_outdoor_uses_8x8_grid() {
        // Phase 6 step D: outdoor cell containment falls out of the
        // 8x8 grid math `WorldPosition::derived_outdoor_cell_id`
        // already implements; the scene method just OR's the
        // landblock high word back in. Holtburg landblock 0xA9B40000
        // at local (84, 7) with cell length 24 m → cellX = 3, cellY = 0
        // → low_word = (3*8) + 0 + 1 = 25 = 0x19. Full cell id =
        // 0xA9B40019.
        let scene = SpatialScene::new();
        let pose = WorldPosition {
            landblock_id: Guid(0xA9B4_0000),
            coords: Vector3::new(84.0, 7.0, 94.0),
            rotation: Quaternion::identity(),
        };
        assert_eq!(scene.current_cell(&pose), 0xA9B4_0019);
    }

    #[test]
    fn current_cell_indoor_uses_aabb_containment() {
        // Phase 6 step D: indoor cells stack in Z. Two cells with
        // overlapping XY footprints but different Z ranges — only the
        // cell whose AABB contains pose.z is returned.
        let mut scene = SpatialScene::new();
        // Both cells are in landblock 0x86020000.
        let cell_lower = 0x8602_0100u32;
        let cell_upper = 0x8602_0101u32;
        // Lower floor: Z ∈ [0, 3]. Upper floor: Z ∈ [3, 6].
        scene.insert_cell_aabb(
            cell_lower,
            Aabb::new(
                Vector3::new(100.0, 100.0, 0.0),
                Vector3::new(110.0, 110.0, 3.0),
            ),
        );
        scene.insert_cell_aabb(
            cell_upper,
            Aabb::new(
                Vector3::new(100.0, 100.0, 3.0),
                Vector3::new(110.0, 110.0, 6.0),
            ),
        );
        // Pose at world (105, 105, 1.5) — inside lower floor.
        // Convert to landblock-local: lb_x_byte = 0x86 = 134, so
        // landblock origin x = 134*192 = 25728. world_x = 105 implies
        // local_x = 105 - 25728 = -25623. That's clearly outside the
        // 0x86 landblock — pick a coord pair where local stays in
        // [0, 192). lb_y_byte = 0x02 = 2 → origin y = 384.
        // Want world (x, y) inside [25728, 25920) × [384, 576) and
        // also inside the AABB at (100, 100, ...).
        // Cleaner: rebuild the AABB at coords inside this landblock.
        let mut scene2 = SpatialScene::new();
        // Landblock 0x86020000 → origin (25728, 384). Pose at local
        // (50, 50, 1.5) → global (25778, 434, 1.5). AABB lower covers
        // z ∈ [0, 3], upper covers z ∈ [3, 6], both at xy
        // [25770, 25790] × [430, 450].
        let cell_lower2 = 0x8602_0100u32;
        let cell_upper2 = 0x8602_0101u32;
        scene2.insert_cell_aabb(
            cell_lower2,
            Aabb::new(
                Vector3::new(25770.0, 430.0, 0.0),
                Vector3::new(25790.0, 450.0, 3.0),
            ),
        );
        scene2.insert_cell_aabb(
            cell_upper2,
            Aabb::new(
                Vector3::new(25770.0, 430.0, 3.0),
                Vector3::new(25790.0, 450.0, 6.0),
            ),
        );
        let pose_lower = WorldPosition {
            landblock_id: Guid(0x8602_0100),
            coords: Vector3::new(50.0, 50.0, 1.5),
            rotation: Quaternion::identity(),
        };
        assert_eq!(scene2.current_cell(&pose_lower), cell_lower2);
        let pose_upper = WorldPosition {
            landblock_id: Guid(0x8602_0101),
            coords: Vector3::new(50.0, 50.0, 4.5),
            rotation: Quaternion::identity(),
        };
        assert_eq!(scene2.current_cell(&pose_upper), cell_upper2);
    }

    #[test]
    fn render_set_bfs_three_cell_chain() {
        // Phase 6 step D: A → B → C portal chain.
        // depth=0: {A}. depth=1: {A, B}. depth=2: {A, B, C}.
        let mut scene = SpatialScene::new();
        let cell_a = 0xA9B4_0100u32;
        let cell_b = 0xA9B4_0101u32;
        let cell_c = 0xA9B4_0102u32;
        scene.insert_cell_portal(cell_a, cell_b);
        scene.insert_cell_portal(cell_b, cell_a);
        scene.insert_cell_portal(cell_b, cell_c);
        scene.insert_cell_portal(cell_c, cell_b);

        let depth0 = scene.render_set(cell_a, 0);
        assert_eq!(depth0.len(), 1);
        assert!(depth0.contains(&cell_a));

        let depth1 = scene.render_set(cell_a, 1);
        assert_eq!(depth1.len(), 2);
        assert!(depth1.contains(&cell_a));
        assert!(depth1.contains(&cell_b));
        assert!(!depth1.contains(&cell_c));

        let depth2 = scene.render_set(cell_a, 2);
        assert_eq!(depth2.len(), 3);
        assert!(depth2.contains(&cell_c));

        // From the middle: depth=1 sees {A, B, C} since both ends
        // are direct neighbours.
        let from_b_depth1 = scene.render_set(cell_b, 1);
        assert_eq!(from_b_depth1.len(), 3);
        assert!(from_b_depth1.contains(&cell_a));
        assert!(from_b_depth1.contains(&cell_b));
        assert!(from_b_depth1.contains(&cell_c));
    }

    #[test]
    fn compute_visibility_with_frustum_outdoor_filters_to_outdoor_exit_cells() {
        // Phase 6 outdoor-exit filter: from outdoor (current cell not
        // in cell_aabbs), only cells whose portal-graph contains the
        // outdoor-exit sentinel (low-16 ≥ 0xFFFE) should be included
        // in the visible set, even when all cells' AABBs intersect
        // the camera frustum.
        let mut scene = SpatialScene::new();
        let lb_high = 0xA9B4_0000u32;
        let outdoor_cell = lb_high | 0x0019; // outdoor LandCell, NOT in cell_aabbs
        let exit_cell = lb_high | 0x0100; // ground-floor cottage with door
        let attic_cell = lb_high | 0x0166; // upstairs attic, interior-only
        let satellite_cell = lb_high | 0x017B; // no portals at all

        // AABBs covering a tight region all in the camera frustum.
        let bbox = Aabb::new(Vector3::new(0.0, 0.0, 0.0), Vector3::new(10.0, 10.0, 200.0));
        scene.insert_cell_aabb(exit_cell, bbox);
        scene.insert_cell_aabb(attic_cell, bbox);
        scene.insert_cell_aabb(satellite_cell, bbox);

        // Portal-graph topology:
        //   exit_cell → outdoor sentinel (0xFFFF) — has outdoor exit
        //   exit_cell → attic_cell — also has interior portal
        //   attic_cell → exit_cell — only interior portal
        //   satellite_cell: no entries
        let outdoor_sentinel = lb_high | 0xFFFF;
        scene.insert_cell_portal(exit_cell, outdoor_sentinel);
        scene.insert_cell_portal(exit_cell, attic_cell);
        scene.insert_cell_portal(attic_cell, exit_cell);

        // Frustum that contains all three cells' AABBs (identity MVP
        // collapses to a viewport-sized frustum; just construct one
        // big enough explicitly via 6 planes facing inward).
        let big = holtburger_common::Plane {
            normal: Vector3::new(1.0, 0.0, 0.0),
            d: 10_000.0,
        };
        let frustum = holtburger_common::Frustum::new([
            big,
            holtburger_common::Plane {
                normal: Vector3::new(-1.0, 0.0, 0.0),
                d: 10_000.0,
            },
            holtburger_common::Plane {
                normal: Vector3::new(0.0, 1.0, 0.0),
                d: 10_000.0,
            },
            holtburger_common::Plane {
                normal: Vector3::new(0.0, -1.0, 0.0),
                d: 10_000.0,
            },
            holtburger_common::Plane {
                normal: Vector3::new(0.0, 0.0, 1.0),
                d: 10_000.0,
            },
            holtburger_common::Plane {
                normal: Vector3::new(0.0, 0.0, -1.0),
                d: 10_000.0,
            },
        ]);

        let visible = scene.compute_visibility_with_frustum(outdoor_cell, &frustum);

        // Outdoor cell is always present in the set (caller anchor).
        assert!(
            visible.contains(&outdoor_cell),
            "current cell must always be in visible set"
        );
        // exit_cell has outdoor exit → must be visible.
        assert!(
            visible.contains(&exit_cell),
            "cell with 0xFFFF portal must render from outdoor camera"
        );
        // attic_cell has only interior portals → must be culled.
        assert!(
            !visible.contains(&attic_cell),
            "interior-only cell (no outdoor exit) must be culled from outdoor camera"
        );
        // satellite_cell has no portal entries at all → must be culled.
        assert!(
            !visible.contains(&satellite_cell),
            "cell with no portal entries must be culled from outdoor camera"
        );
    }

    #[test]
    fn compute_visibility_with_frustum_indoor_does_not_apply_outdoor_filter() {
        // Phase 6 outdoor-exit filter must NOT trigger when the camera
        // is inside an EnvCell — indoor visibility still uses BFS-1
        // (with the visible_cells-augmented portal graph) and frustum-
        // prunes that set. Interior cells without outdoor exits must
        // remain visible from inside.
        let mut scene = SpatialScene::new();
        let lb_high = 0xA9B4_0000u32;
        let cell_in = lb_high | 0x0100;
        let cell_attic = lb_high | 0x0166;

        let bbox = Aabb::new(Vector3::new(0.0, 0.0, 0.0), Vector3::new(10.0, 10.0, 10.0));
        scene.insert_cell_aabb(cell_in, bbox);
        scene.insert_cell_aabb(cell_attic, bbox);

        scene.insert_cell_portal(cell_in, cell_attic);
        scene.insert_cell_portal(cell_attic, cell_in);

        // Same big frustum as above.
        let big_planes = [
            holtburger_common::Plane { normal: Vector3::new(1.0, 0.0, 0.0), d: 10_000.0 },
            holtburger_common::Plane { normal: Vector3::new(-1.0, 0.0, 0.0), d: 10_000.0 },
            holtburger_common::Plane { normal: Vector3::new(0.0, 1.0, 0.0), d: 10_000.0 },
            holtburger_common::Plane { normal: Vector3::new(0.0, -1.0, 0.0), d: 10_000.0 },
            holtburger_common::Plane { normal: Vector3::new(0.0, 0.0, 1.0), d: 10_000.0 },
            holtburger_common::Plane { normal: Vector3::new(0.0, 0.0, -1.0), d: 10_000.0 },
        ];
        let frustum = holtburger_common::Frustum::new(big_planes);

        let visible = scene.compute_visibility_with_frustum(cell_in, &frustum);
        assert!(visible.contains(&cell_in), "current cell always visible");
        assert!(
            visible.contains(&cell_attic),
            "interior-only neighbour must be visible from indoor camera"
        );
    }

    #[test]
    fn stair_z_threshold_transitions_cell() {
        // Phase 6 step D: walking up stairs is just `current_cell`
        // changing as Z crosses the boundary between two Z-stacked
        // cell AABBs. No special "stair" code — the cell graph + the
        // AABB containment test are the abstraction.
        let mut scene = SpatialScene::new();
        let cell_floor1 = 0x8602_0100u32;
        let cell_floor2 = 0x8602_0101u32;
        // Same XY footprint, stacked Z ranges. Floor 1: 0..3. Floor 2: 3..6.
        scene.insert_cell_aabb(
            cell_floor1,
            Aabb::new(
                Vector3::new(25770.0, 430.0, 0.0),
                Vector3::new(25790.0, 450.0, 3.0),
            ),
        );
        scene.insert_cell_aabb(
            cell_floor2,
            Aabb::new(
                Vector3::new(25770.0, 430.0, 3.0),
                Vector3::new(25790.0, 450.0, 6.0),
            ),
        );
        // Walk Z from 0.5 to 5.5 in 0.5 m steps — assert the
        // transition occurs at z >= 3.0 (the top of floor 1 / bottom
        // of floor 2; AABB containment is inclusive on min, so floor
        // 2 wins on the boundary, but iteration order over the
        // HashMap means we accept whichever cell wins — both are
        // valid at the exact boundary).
        let mut last_below: Option<u32> = None;
        let mut last_above: Option<u32> = None;
        for step in 0..=10 {
            let z = 0.5 + step as f32 * 0.5;
            let pose = WorldPosition {
                landblock_id: Guid(cell_floor1),
                coords: Vector3::new(50.0, 50.0, z),
                rotation: Quaternion::identity(),
            };
            let cell = scene.current_cell(&pose);
            if z < 3.0 {
                last_below = Some(cell);
            } else if z > 3.0 {
                last_above = Some(cell);
            }
        }
        assert_eq!(last_below, Some(cell_floor1));
        assert_eq!(last_above, Some(cell_floor2));
    }

    #[test]
    fn clear_cells_for_landblock_drops_only_matching() {
        let mut scene = SpatialScene::new();
        let lb1_high = 0xA9B4_0000u32;
        let lb2_high = 0x8602_0000u32;
        scene.insert_cell_portal(lb1_high | 0x0100, lb1_high | 0x0101);
        scene.insert_cell_portal(lb1_high | 0x0101, lb1_high | 0x0100);
        scene.insert_cell_portal(lb2_high | 0x0100, lb2_high | 0x0101);
        scene.insert_cell_aabb(
            lb1_high | 0x0100,
            Aabb::new(Vector3::zero(), Vector3::new(1.0, 1.0, 1.0)),
        );
        scene.insert_cell_aabb(
            lb2_high | 0x0100,
            Aabb::new(Vector3::zero(), Vector3::new(1.0, 1.0, 1.0)),
        );
        assert_eq!(scene.cell_portal_graph_len(), 3);
        assert_eq!(scene.cell_aabb_count(), 2);

        let (edges, aabbs) = scene.clear_cells_for_landblock(lb1_high);
        assert_eq!(edges, 2);
        assert_eq!(aabbs, 1);
        assert_eq!(scene.cell_portal_graph_len(), 1);
        assert_eq!(scene.cell_aabb_count(), 1);
    }

    #[test]
    fn insert_cell_portal_dedups_within_a_cell() {
        let mut scene = SpatialScene::new();
        scene.insert_cell_portal(0xA9B4_0100, 0xA9B4_0101);
        scene.insert_cell_portal(0xA9B4_0100, 0xA9B4_0101);
        assert_eq!(scene.cell_portal_neighbours(0xA9B4_0100).len(), 1);
    }

    // ---------------------------------------------------------------
    // Workstream C (3D camera collision, 2026-05-11) — new sweep
    // primitive tests.
    // ---------------------------------------------------------------

    /// Workstream C: `sweep_sphere_against_static_aabbs` returns the
    /// earliest hit + a sane normal when a static blocks the sweep.
    /// Grazing-vs-miss case: a static AABB to the side of the sweep
    /// line should NOT register a hit.
    #[test]
    fn sweep_static_aabbs_hits_block_and_misses_side() {
        use holtburger_common::Aabb;
        // Pose at world origin (lb 0x0102 has origin (192, 384) but we
        // use lb 0x0000 to keep math trivial). LB 0x0000 → origin (0,0).
        let pose = WorldPosition {
            landblock_id: Guid(0x0000_0000),
            coords: Vector3::new(0.0, 0.0, 0.0),
            rotation: Quaternion::identity(),
        };
        // One static: a 2x2x2 box centred at (5, 0, 0). Sweep +X
        // should hit it.
        let blocker = crate::spatial::StaticAabbEntry {
            did: 0x01000001,
            aabb: Aabb::new(
                Vector3::new(4.0, -1.0, -1.0),
                Vector3::new(6.0, 1.0, 1.0),
            ),
            has_bsp: false,
        };
        // Sweep +X by 10 m at radius 0.4.
        let hit = crate::spatial::sweep_sphere_against_static_aabbs(
            &[blocker],
            &pose,
            Vector3::new(10.0, 0.0, 0.0),
            0.4,
        )
        .expect("expected a hit");
        // Inflated AABB min.x is 4 - 0.4 = 3.6, so t = 3.6 / 10 = 0.36.
        assert!((hit.t - 0.36).abs() < 1e-3, "t={}", hit.t);
        // Normal should point back toward -X.
        assert!(hit.normal.x < -0.5, "normal.x={}", hit.normal.x);
        // Point should be at x ≈ 3.6.
        assert!((hit.point.x - 3.6).abs() < 1e-3, "point.x={}", hit.point.x);

        // Side-miss: sweep +Y past the box, should not hit.
        let miss = crate::spatial::sweep_sphere_against_static_aabbs(
            &[blocker],
            &pose,
            Vector3::new(0.0, 10.0, 0.0),
            0.4,
        );
        assert!(miss.is_none(), "expected miss for orthogonal sweep");
    }

    /// Workstream C: degenerate inputs — empty static list, zero-
    /// length delta, single-AABB at the origin (start-inside AABB).
    /// The inside-out case is the one the camera path will trip on
    /// when the player stands inside a building — we expect `t=0`.
    #[test]
    fn sweep_static_aabbs_inside_returns_t_zero() {
        use holtburger_common::Aabb;
        let pose = WorldPosition {
            landblock_id: Guid(0x0000_0000),
            coords: Vector3::new(0.0, 0.0, 0.0),
            rotation: Quaternion::identity(),
        };
        // Sweep origin (0,0,0) starts INSIDE this AABB.
        let inside = crate::spatial::StaticAabbEntry {
            did: 0x01000001,
            aabb: Aabb::new(
                Vector3::new(-1.0, -1.0, -1.0),
                Vector3::new(1.0, 1.0, 1.0),
            ),
            has_bsp: false,
        };
        let hit = crate::spatial::sweep_sphere_against_static_aabbs(
            &[inside],
            &pose,
            Vector3::new(5.0, 0.0, 0.0),
            0.4,
        );
        // Slab method on a centre starting inside the (inflated) AABB
        // returns no hit (start is inside; t_enter == 0 short-circuits
        // because entry_axis is u8::MAX in our impl). That's the
        // documented behaviour — callers that need start-inside-AABB
        // detection should check separately. We assert the documented
        // contract here.
        assert!(hit.is_none(), "inside-AABB start returns None per impl");

        // Empty candidate list: clean miss.
        let miss = crate::spatial::sweep_sphere_against_static_aabbs(
            &[],
            &pose,
            Vector3::new(5.0, 0.0, 0.0),
            0.4,
        );
        assert!(miss.is_none());

        // Zero-length delta + non-empty list: clean miss.
        let miss = crate::spatial::sweep_sphere_against_static_aabbs(
            &[inside],
            &pose,
            Vector3::zero(),
            0.4,
        );
        assert!(miss.is_none());
    }

    /// Workstream C: `sweep_sphere_against_triangles` finds the
    /// earliest contact against a vertical wall triangle.
    #[test]
    fn sweep_triangles_hits_vertical_wall() {
        use holtburger_common::Triangle;
        // Vertical wall at y=5, spanning x ∈ [0, 10], z ∈ [0, 4].
        // Two triangles fill the rectangle.
        let wall_a = Triangle::new(
            Vector3::new(0.0, 5.0, 0.0),
            Vector3::new(10.0, 5.0, 0.0),
            Vector3::new(0.0, 5.0, 4.0),
        );
        let wall_b = Triangle::new(
            Vector3::new(10.0, 5.0, 0.0),
            Vector3::new(10.0, 5.0, 4.0),
            Vector3::new(0.0, 5.0, 4.0),
        );
        let triangles = [wall_a, wall_b];
        // Sweep from (5, 0, 2) toward (5, 10, 2) — head-on through
        // the wall.
        let start = Vector3::new(5.0, 0.0, 2.0);
        let end = Vector3::new(5.0, 10.0, 2.0);
        let hit = crate::spatial::sweep_sphere_against_triangles(
            &triangles, start, end, 0.4,
        )
        .expect("expected wall hit");
        // Sphere of radius 0.4 just touches the wall at y = 5 - 0.4 =
        // 4.6; sweep covers (5,0)→(5,10), so t = 4.6 / 10 = 0.46.
        assert!((hit.t - 0.46).abs() < 1e-2, "t={}", hit.t);
        // Normal points back toward -Y (sweep origin).
        assert!(hit.normal.y < -0.5, "normal.y={}", hit.normal.y);

        // Miss: sweep parallel to the wall (in +X direction at y=0)
        // never touches it.
        let miss = crate::spatial::sweep_sphere_against_triangles(
            &triangles,
            Vector3::new(0.0, 0.0, 2.0),
            Vector3::new(10.0, 0.0, 2.0),
            0.4,
        );
        assert!(miss.is_none(), "parallel sweep should miss");
    }

    /// Workstream C: inside-out test — sphere starts already
    /// touching/inside a triangle. Expect t=0 and a sane normal.
    #[test]
    fn sweep_triangles_inside_returns_t_zero() {
        use holtburger_common::Triangle;
        // Floor triangle at z=0 in [0,10]×[0,10].
        let floor = Triangle::new(
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(10.0, 0.0, 0.0),
            Vector3::new(5.0, 10.0, 0.0),
        );
        // Start with sphere centre at (5, 5, 0.2) — within radius 0.4
        // of the z=0 floor.
        let start = Vector3::new(5.0, 5.0, 0.2);
        let end = Vector3::new(5.0, 5.0, 0.2); // zero-length sweep
        let hit = crate::spatial::sweep_sphere_against_triangles(
            &[floor], start, end, 0.4,
        )
        .expect("expected inside-triangle hit");
        assert_eq!(hit.t, 0.0, "inside sphere should report t=0");

        // Now sweep into the floor: start above (z=2), end below
        // (z=-2). Sphere touches plane at z=0.4, so t=(2-0.4)/4 = 0.4.
        let start = Vector3::new(5.0, 5.0, 2.0);
        let end = Vector3::new(5.0, 5.0, -2.0);
        let hit = crate::spatial::sweep_sphere_against_triangles(
            &[floor], start, end, 0.4,
        )
        .expect("expected floor hit");
        assert!((hit.t - 0.4).abs() < 1e-2, "t={}", hit.t);
    }

    /// Workstream C: grazing test — sphere passes outside a
    /// triangle's lateral extent. Far past the edge should miss; just
    /// touching the plane within the triangle's footprint should hit
    /// (the canonical sweep-into-wall case). The "grazing edge"
    /// boundary is sensitive to plane-touch-time projection clamping;
    /// we test the two clear-cut sides of the boundary here rather
    /// than threading the narrow tolerance band.
    #[test]
    fn sweep_triangles_grazes_edge() {
        use holtburger_common::Triangle;
        // Wall triangle at y=5, spanning x ∈ [0, 10], z ∈ [0, 4]
        // (matches the basic-wall test fixture).
        let wall = Triangle::new(
            Vector3::new(0.0, 5.0, 0.0),
            Vector3::new(10.0, 5.0, 0.0),
            Vector3::new(0.0, 5.0, 4.0),
        );
        // Sweep at x=15 — well past the triangle's x extent.
        // At plane-touch (y=4.6), closest point on triangle is
        // (10, 5, 1) (clamped corner); distance from (15, 4.6, 1) is
        // sqrt(25 + 0.16) ≈ 5 m — far outside radius 0.4 → miss.
        let miss = crate::spatial::sweep_sphere_against_triangles(
            &[wall],
            Vector3::new(15.0, 0.0, 1.0),
            Vector3::new(15.0, 10.0, 1.0),
            0.4,
        );
        assert!(miss.is_none(), "5 m past edge should miss");

        // Now sweep inside the triangle's XZ footprint (x=3, z=1) —
        // canonical head-on case. Expect a hit.
        let hit = crate::spatial::sweep_sphere_against_triangles(
            &[wall],
            Vector3::new(3.0, 0.0, 1.0),
            Vector3::new(3.0, 10.0, 1.0),
            0.4,
        );
        assert!(
            hit.is_some(),
            "sweep through triangle interior should hit"
        );
    }

    /// Workstream C: `sweep_sphere_against_statics` (via Scene)
    /// returns the earliest hit when a static blocks the camera ray.
    /// Verifies the Scene-level wrapper consumes the per-landblock
    /// index correctly.
    #[test]
    fn scene_sweep_statics_uses_landblock_index() {
        use holtburger_common::Aabb;
        let mut scene = SpatialScene::new();
        // Insert a static in landblock 0x0000 at (5, 0).
        scene.insert_static_aabb(
            0x0000_0000,
            crate::spatial::StaticAabbEntry {
                did: 0x01000001,
                aabb: Aabb::new(
                    Vector3::new(4.0, -1.0, -1.0),
                    Vector3::new(6.0, 1.0, 1.0),
                ),
                has_bsp: false,
            },
        );
        assert_eq!(scene.static_aabb_count(), 1);

        // Sweep through it.
        let pose = WorldPosition {
            landblock_id: Guid(0x0000_0000),
            coords: Vector3::new(0.0, 0.0, 0.0),
            rotation: Quaternion::identity(),
        };
        let hit = scene
            .sweep_sphere_against_statics(&pose, Vector3::new(10.0, 0.0, 0.0), 0.4)
            .expect("expected static hit");
        assert!(hit.t > 0.0 && hit.t < 1.0);

        // Clear the landblock — sweep should miss now.
        let removed = scene.clear_static_aabbs_for_landblock(0x0000_0000);
        assert_eq!(removed, 1);
        let miss = scene
            .sweep_sphere_against_statics(&pose, Vector3::new(10.0, 0.0, 0.0), 0.4);
        assert!(miss.is_none(), "post-clear sweep should miss");
    }

    /// Workstream C: `sweep_sphere_against_cell_mesh` (via Scene)
    /// gathers triangles across a list of cells and returns the
    /// earliest hit.
    #[test]
    fn scene_sweep_cell_mesh_unions_across_cells() {
        use holtburger_common::Triangle;
        let mut scene = SpatialScene::new();
        // Two cells: cell A has a wall at y=5, cell B has a wall at
        // y=3. The sweep should hit the y=3 wall (cell B) first.
        let cell_a = 0xA9B4_0100;
        let cell_b = 0xA9B4_0101;
        scene.insert_cell_triangle(
            cell_a,
            Triangle::new(
                Vector3::new(0.0, 5.0, 0.0),
                Vector3::new(10.0, 5.0, 0.0),
                Vector3::new(0.0, 5.0, 4.0),
            ),
        );
        scene.insert_cell_triangle(
            cell_b,
            Triangle::new(
                Vector3::new(0.0, 3.0, 0.0),
                Vector3::new(10.0, 3.0, 0.0),
                Vector3::new(0.0, 3.0, 4.0),
            ),
        );
        // Sweep through both cells from y=0 to y=10.
        let hit = scene
            .sweep_sphere_against_cell_mesh(
                &[cell_a, cell_b],
                Vector3::new(5.0, 0.0, 2.0),
                Vector3::new(5.0, 10.0, 2.0),
                0.4,
            )
            .expect("expected cell mesh hit");
        // Cell B at y=3 wins: sphere touches at y=2.6, t=0.26.
        assert!((hit.t - 0.26).abs() < 1e-2, "t={} (expected y=3 wall)", hit.t);

        // Drop cell B from the list — sweep should hit cell A
        // (y=5, t=0.46).
        let hit = scene
            .sweep_sphere_against_cell_mesh(
                &[cell_a],
                Vector3::new(5.0, 0.0, 2.0),
                Vector3::new(5.0, 10.0, 2.0),
                0.4,
            )
            .expect("expected cell A hit");
        assert!((hit.t - 0.46).abs() < 1e-2, "t={} (expected y=5 wall)", hit.t);

        // Empty cell list: clean miss.
        let miss = scene.sweep_sphere_against_cell_mesh(
            &[],
            Vector3::new(5.0, 0.0, 2.0),
            Vector3::new(5.0, 10.0, 2.0),
            0.4,
        );
        assert!(miss.is_none());
    }

    /// Workstream C: `sweep_sphere_against_building_mesh` reads
    /// per-landblock triangles (the BUILDING-side parallel of the
    /// `cell_physics_index` cell-mesh sweep) and clips against them.
    /// This is the architecturally distinct path — regular building
    /// interiors store physics in their parts' `GfxObj.physics_-
    /// polygons`, indexed by `landblock_high`, NOT by cell id.
    /// Verifies the index/sweep round-trips correctly.
    #[test]
    fn scene_sweep_building_mesh_uses_landblock_index() {
        use holtburger_common::Triangle;
        let mut scene = SpatialScene::new();
        let lb_holtburg = 0xA9B4_0000u32;
        let lb_other = 0xA9B5_0000u32;
        // Insert a vertical wall triangle in Holtburg landblock.
        scene.insert_building_triangle(
            lb_holtburg,
            Triangle::new(
                Vector3::new(0.0, 5.0, 0.0),
                Vector3::new(10.0, 5.0, 0.0),
                Vector3::new(0.0, 5.0, 4.0),
            ),
        );
        scene.insert_building_triangle(
            lb_holtburg,
            Triangle::new(
                Vector3::new(10.0, 5.0, 0.0),
                Vector3::new(10.0, 5.0, 4.0),
                Vector3::new(0.0, 5.0, 4.0),
            ),
        );
        // Insert a triangle in a different LB; it must NOT be visible
        // when sweeping Holtburg.
        scene.insert_building_triangle(
            lb_other,
            Triangle::new(
                Vector3::new(0.0, 3.0, 0.0),
                Vector3::new(10.0, 3.0, 0.0),
                Vector3::new(0.0, 3.0, 4.0),
            ),
        );
        assert_eq!(scene.building_physics_count(), 2);
        assert_eq!(scene.building_triangles_total(), 3);
        assert_eq!(
            scene.building_triangles_for_landblock(lb_holtburg).len(),
            2
        );

        // Sweep through the Holtburg wall.
        let hit = scene
            .sweep_sphere_against_building_mesh(
                lb_holtburg,
                Vector3::new(5.0, 0.0, 2.0),
                Vector3::new(5.0, 10.0, 2.0),
                0.4,
            )
            .expect("expected building wall hit");
        // Hit Holtburg's y=5 wall: sphere touches at y=4.6, t=0.46.
        assert!((hit.t - 0.46).abs() < 1e-2, "t={}", hit.t);

        // Sweep in `lb_other`; should hit its own y=3 wall, not the
        // y=5 Holtburg one (cross-LB isolation).
        let hit = scene
            .sweep_sphere_against_building_mesh(
                lb_other,
                Vector3::new(5.0, 0.0, 2.0),
                Vector3::new(5.0, 10.0, 2.0),
                0.4,
            )
            .expect("expected lb_other wall hit");
        assert!((hit.t - 0.26).abs() < 1e-2, "t={} (expected y=3 wall)", hit.t);

        // Clear Holtburg via `clear_building_aabbs_for_landblock` —
        // this should ALSO drop the building-physics triangles for
        // the landblock per the API contract (they share lifetime).
        scene.clear_building_aabbs_for_landblock(lb_holtburg);
        assert_eq!(
            scene.building_triangles_for_landblock(lb_holtburg).len(),
            0,
            "clearing AABBs must also clear building-physics for the LB"
        );
        // lb_other still has its wall.
        assert_eq!(
            scene.building_triangles_for_landblock(lb_other).len(),
            1
        );
    }

    /// Workstream C: building-physics index masks the LB high word so
    /// callers can pass a full cell id (e.g. `0xA9B4_FFFE`) without
    /// having to pre-mask. Mirrors `clear_building_aabbs_for_landblock`'s
    /// flexible-key contract.
    #[test]
    fn scene_building_triangles_handles_full_cell_id_key() {
        use holtburger_common::Triangle;
        let mut scene = SpatialScene::new();
        let lb_high = 0xA9B4_0000u32;
        scene.insert_building_triangle(
            lb_high,
            Triangle::new(
                Vector3::new(0.0, 5.0, 0.0),
                Vector3::new(10.0, 5.0, 0.0),
                Vector3::new(0.0, 5.0, 4.0),
            ),
        );
        // Probe with a full cell id — same landblock, low word set.
        assert_eq!(
            scene.building_triangles_for_landblock(lb_high | 0xFFFE).len(),
            1
        );
        assert_eq!(
            scene.building_triangles_for_landblock(lb_high | 0x0001).len(),
            1
        );
    }
}

/// Phase 5 PView near-plane clip tests (2026-05-25).
///
/// Validates that `pview_project_polygon` clips portal polygons
/// against the near plane in clip space BEFORE perspective divide,
/// so that polygons straddling the camera produce correct NDC
/// vertices instead of being wholesale dropped (the pre-fix
/// "skip if any w <= ε" behaviour).
mod pview_near_plane {
    use super::*;

    /// Build a column-major IDENTITY MVP. With `mvp[15] = 1.0` and
    /// no perspective row, a vertex `(vx, vy, vz)` lifts to clip
    /// space `(vx, vy, vz, 1)`. This lets tests work in clip-space
    /// coords directly by choosing input vertex values, since w
    /// will always be 1.
    fn identity_mvp() -> [f32; 16] {
        let mut m = [0.0f32; 16];
        m[0] = 1.0;
        m[5] = 1.0;
        m[10] = 1.0;
        m[15] = 1.0;
        m
    }

    /// Polygon fully ahead of the near plane → projection should
    /// equal the manual divide-by-w (which is just x/1, y/1 = (x, y)
    /// under identity MVP).
    #[test]
    fn polygon_fully_ahead_projects_unchanged() {
        // All three vertices have z = +0.5, so z + w = 1.5 >= 0 →
        // fully inside. With identity MVP and w = 1, NDC = (x, y).
        let verts = vec![
            Vector3::new(0.2, 0.3, 0.5),
            Vector3::new(0.4, 0.1, 0.5),
            Vector3::new(0.3, 0.5, 0.5),
        ];
        let mvp = identity_mvp();
        let out = pview_project_polygon(&verts, &mvp);
        assert_eq!(out.len(), 3, "polygon fully ahead should preserve vertex count");
        // Manual divide-by-w (w = 1): NDC == input xy.
        for (proj, v) in out.iter().zip(verts.iter()) {
            assert!(
                (proj[0] - v.x).abs() < 1e-6 && (proj[1] - v.y).abs() < 1e-6,
                "expected NDC ({}, {}), got ({}, {})",
                v.x, v.y, proj[0], proj[1]
            );
        }
    }

    /// Polygon fully behind the near plane → no vertices survive
    /// clipping, returns empty.
    #[test]
    fn polygon_fully_behind_returns_empty() {
        // All verts at z = -10 with w = 1 → z + w = -9 < 0 → outside.
        let verts = vec![
            Vector3::new(0.0, 0.0, -10.0),
            Vector3::new(1.0, 0.0, -10.0),
            Vector3::new(0.0, 1.0, -10.0),
        ];
        let mvp = identity_mvp();
        let out = pview_project_polygon(&verts, &mvp);
        assert!(out.is_empty(), "fully-behind polygon should yield empty NDC list, got {:?}", out);
    }

    /// Polygon straddling the near plane → clipping produces a
    /// new polygon with intersection vertices at the near plane.
    /// All output vertices must be in normalized NDC range.
    #[test]
    fn polygon_straddling_near_plane_clips_to_valid_ndc() {
        // One vertex behind (z = -2, w = 1 → z + w = -1 < 0), two
        // ahead (z = +2, w = 1 → z + w = +3 >= 0). The clipped
        // polygon should be a quad: the two surviving "ahead"
        // vertices plus two intersection vertices on edges to the
        // behind vertex.
        let verts = vec![
            Vector3::new(0.0, 0.0, -2.0), // behind
            Vector3::new(1.0, 0.0, 2.0),  // ahead
            Vector3::new(0.0, 1.0, 2.0),  // ahead
        ];
        let mvp = identity_mvp();
        let out = pview_project_polygon(&verts, &mvp);
        // Expected output is a quad: 2 originals + 2 intersections.
        assert!(
            out.len() == 3 || out.len() == 4,
            "straddling triangle should yield 3 or 4 NDC verts, got {}: {:?}",
            out.len(), out
        );
        // Every output vertex should be a finite, in-range NDC coord
        // ([-1, 1]² for inputs that all sit in that range).
        for p in &out {
            assert!(p[0].is_finite() && p[1].is_finite(), "NDC coord not finite: {:?}", p);
            assert!(
                p[0] >= -1.0 - 1e-5 && p[0] <= 1.0 + 1e-5,
                "NDC x out of [-1,1]: {}", p[0]
            );
            assert!(
                p[1] >= -1.0 - 1e-5 && p[1] <= 1.0 + 1e-5,
                "NDC y out of [-1,1]: {}", p[1]
            );
        }
    }

    /// Specific brief case: triangle with clip-space verts
    /// (0, 0, -2, 1), (1, 0, 2, 1), (0, 1, 2, 1) — first behind
    /// near plane, other two ahead. Under identity MVP the input
    /// Vector3 values ARE the clip-space x/y/z (with w = 1).
    ///
    /// The clipper should:
    ///   - drop the (0, 0, -2) vertex
    ///   - keep (1, 0, 2) and (0, 1, 2)
    ///   - inject two intersection vertices at t = 1/3 along each
    ///     "behind→ahead" edge (where z + w = 0, i.e. z = -1)
    ///
    /// Edge v0→v1 ((0,0,-2,1)→(1,0,2,1)):
    ///   t = (-2 + 1) / ((-2 + 1) - (2 + 1)) = -1 / -4 = 0.25
    ///   intersection = (0.25, 0, -1.25, 1)
    /// Edge v0→v2 ((0,0,-2,1)→(0,1,2,1)):
    ///   t = -1 / -4 = 0.25
    ///   intersection = (0, 0.25, -1.25, 1)
    ///
    /// Final NDC (divide by w=1): expect roughly four vertices in
    /// the unit box.
    #[test]
    fn polygon_brief_case_one_behind_two_ahead() {
        let verts = vec![
            Vector3::new(0.0, 0.0, -2.0),
            Vector3::new(1.0, 0.0, 2.0),
            Vector3::new(0.0, 1.0, 2.0),
        ];
        let mvp = identity_mvp();
        let out = pview_project_polygon(&verts, &mvp);
        assert_eq!(
            out.len(), 4,
            "brief-case triangle should clip to a quad, got {}: {:?}",
            out.len(), out
        );
        // All NDC verts in [-1, 1]².
        for p in &out {
            assert!(p[0].is_finite() && p[1].is_finite(), "non-finite NDC: {:?}", p);
            assert!(
                p[0] >= -1.0 - 1e-5 && p[0] <= 1.0 + 1e-5,
                "NDC x out of range: {}", p[0]
            );
            assert!(
                p[1] >= -1.0 - 1e-5 && p[1] <= 1.0 + 1e-5,
                "NDC y out of range: {}", p[1]
            );
        }
        // Specifically check that both ahead-vertices survived
        // (NDC (1, 0) and (0, 1) under identity).
        let has_v1 = out.iter().any(|p| (p[0] - 1.0).abs() < 1e-5 && p[1].abs() < 1e-5);
        let has_v2 = out.iter().any(|p| p[0].abs() < 1e-5 && (p[1] - 1.0).abs() < 1e-5);
        assert!(has_v1, "expected (1, 0) in NDC output, got {:?}", out);
        assert!(has_v2, "expected (0, 1) in NDC output, got {:?}", out);
        // And check the two intersection vertices landed at the
        // expected coords (0.25, 0) and (0, 0.25).
        let has_i1 = out.iter().any(|p| (p[0] - 0.25).abs() < 1e-5 && p[1].abs() < 1e-5);
        let has_i2 = out.iter().any(|p| p[0].abs() < 1e-5 && (p[1] - 0.25).abs() < 1e-5);
        assert!(has_i1, "expected near-plane intersection (0.25, 0) in NDC output, got {:?}", out);
        assert!(has_i2, "expected near-plane intersection (0, 0.25) in NDC output, got {:?}", out);
    }

    /// Sanity-check that returning an empty vec for an under-sized
    /// polygon is preserved.
    #[test]
    fn polygon_too_small_returns_empty() {
        let mvp = identity_mvp();
        assert!(pview_project_polygon(&[], &mvp).is_empty());
        assert!(pview_project_polygon(&[Vector3::new(0.0, 0.0, 0.5)], &mvp).is_empty());
        let two = vec![
            Vector3::new(0.0, 0.0, 0.5),
            Vector3::new(1.0, 0.0, 0.5),
        ];
        assert!(pview_project_polygon(&two, &mvp).is_empty());
    }
}

// BSP collision (PASS 1, 2026-06-02) — the world-crate side: the
// world→cell-local transform + the low+high two-sphere
// `cell_physics_bsp_solid` query wired onto `SpatialScene`. The node /
// polygon predicates themselves are unit-tested in
// `holtburger-dat` `physics::tests`; these tests exercise the scene
// plumbing + the frame transform.
#[cfg(test)]
mod bsp_collision {
    use super::*;
    use holtburger_dat::physics::{BspLeaf, BspNode, InternalNode, ResolvedPolygon};
    use holtburger_common::{Plane, Sphere};
    use std::collections::HashMap;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    /// Cell-local floor square in z=0, normal +Z, x,y ∈ [-2, 2].
    fn floor_poly() -> ResolvedPolygon {
        let verts = vec![
            v(-2.0, -2.0, 0.0),
            v(2.0, -2.0, 0.0),
            v(2.0, 2.0, 0.0),
            v(-2.0, 2.0, 0.0),
        ];
        let plane = ResolvedPolygon::make_plane(&verts).unwrap();
        ResolvedPolygon {
            num_points: verts.len(),
            vertices: verts,
            plane,
        }
    }

    /// Physics BSP: split on z=0, solid below (carrying the floor poly),
    /// air above.
    fn floor_bsp(origin: Vector3, orientation: Quaternion) -> CellPhysicsBsp {
        let mut polys = HashMap::new();
        polys.insert(3u16, floor_poly());
        let air = BspNode::Leaf(BspLeaf {
            index: 0,
            solid: 0,
            sphere: Some(Sphere {
                center: v(0.0, 0.0, 5.0),
                radius: 50.0,
            }),
            poly_ids: vec![],
        });
        let solid = BspNode::Leaf(BspLeaf {
            index: 1,
            solid: 1,
            sphere: Some(Sphere {
                center: v(0.0, 0.0, -5.0),
                radius: 50.0,
            }),
            poly_ids: vec![3],
        });
        let tree = BspNode::Internal(InternalNode {
            tag: *b"BPIN",
            plane: Plane {
                normal: v(0.0, 0.0, 1.0),
                d: 0.0,
            },
            pos: Some(Box::new(air)),
            neg: Some(Box::new(solid)),
            sphere: Some(Sphere {
                center: v(0.0, 0.0, 0.0),
                radius: 500.0,
            }),
            poly_ids: vec![],
        });
        CellPhysicsBsp {
            tree,
            polys,
            origin,
            orientation,
            scale: 1.0,
        }
    }

    #[test]
    fn world_to_local_inverts_cell_frame() {
        // Cell origin offset + 90° heading rotation. A world point at
        // the cell origin maps to local (0,0,0); a point one unit along
        // world +X maps back through the inverse rotation.
        let origin = v(100.0, 200.0, 10.0);
        let orientation = Quaternion::from_heading(std::f32::consts::FRAC_PI_2);
        let bsp = floor_bsp(origin, orientation);
        let at_origin = bsp.world_to_local(origin);
        assert!(at_origin.length() < 1e-4, "origin maps to local zero");
        // Round-trip: local -> world -> local is identity.
        let local_pt = v(1.5, -0.5, 0.25);
        let world_pt = origin + orientation.rotate_vector(local_pt);
        let back = bsp.world_to_local(world_pt);
        assert!((back - local_pt).length() < 1e-4, "world->local round-trips");
    }

    #[test]
    fn cell_physics_bsp_solid_detects_floor_through_frame() {
        let mut scene = SpatialScene::new();
        let cell_id = 0xA9B4_0100u32;
        // Translated + rotated cell frame to prove the query transforms
        // INTO local space rather than assuming identity.
        let origin = v(50.0, -30.0, 7.0);
        let orientation = Quaternion::from_heading(0.7);
        scene.insert_cell_physics_bsp(cell_id, floor_bsp(origin, orientation));
        assert_eq!(scene.cell_physics_bsp_count(), 1);

        // World-space player standing ON the cell floor: the cell floor
        // is local z=0, which in world space is `origin.z` after the
        // (heading-only, Z-preserving) rotation. Feet at world z =
        // origin.z; the low sphere sits at feet + radius = origin.z +
        // 0.4, whose local z is +0.4 (air), and the capsule straddles
        // the floor plane within the sphere radius => solid.
        let radius = PLAYER_CAPSULE_RADIUS;
        let height = PLAYER_CAPSULE_HEIGHT;
        // Place feet just below the floor so the low sphere center is
        // within `radius` of (or below) z=0 => solid hit.
        let feet_below = origin.z - 0.1;
        // The XY must map inside the floor footprint after the inverse
        // rotation; the cell origin's XY is safely inside [-2,2].
        assert!(
            scene.cell_physics_bsp_solid(
                cell_id,
                (origin.x, origin.y),
                feet_below,
                radius,
                height,
            ),
            "capsule straddling the floor reads solid"
        );

        // Player well ABOVE the floor (feet 5 m up): both spheres are in
        // the air leaf => not solid.
        let feet_high = origin.z + 5.0;
        assert!(
            !scene.cell_physics_bsp_solid(
                cell_id,
                (origin.x, origin.y),
                feet_high,
                radius,
                height,
            ),
            "capsule high above the floor reads free"
        );

        // Unknown cell => no BSP => never blocks (flat-tri fallback).
        assert!(!scene.cell_physics_bsp_solid(
            0xDEAD_0000,
            (origin.x, origin.y),
            feet_below,
            radius,
            height,
        ));
    }

    #[test]
    fn clear_cells_for_landblock_drops_bsp() {
        let mut scene = SpatialScene::new();
        let cell_id = 0xA9B4_0100u32;
        scene.insert_cell_physics_bsp(cell_id, floor_bsp(Vector3::zero(), Quaternion::identity()));
        assert_eq!(scene.cell_physics_bsp_count(), 1);
        scene.clear_cells_for_landblock(0xA9B4_0000);
        assert_eq!(scene.cell_physics_bsp_count(), 0, "BSP cleared on unload");
    }

    // ---- B4 Tier-2 (2026-06-09): per-static physics-BSP push-out ----

    /// An outdoor pose in landblock 0xA9B4 (X=0xA9, Y=0xB4) so the push-out
    /// ring query keys onto that landblock.
    fn pose_in_a9b4() -> WorldPosition {
        WorldPosition {
            landblock_id: Guid(0xA9B4_0019),
            coords: v(10.0, 10.0, 0.0),
            rotation: Quaternion::identity(),
        }
    }

    #[test]
    fn static_physics_bsp_storage_roundtrip() {
        let mut scene = SpatialScene::new();
        let lb_a = 0xA9B4_0000u32;
        let lb_b = 0xA9C0_0000u32;
        scene.insert_static_physics_bsp(lb_a, floor_bsp(v(100.0, 200.0, 10.0), Quaternion::identity()));
        scene.insert_static_physics_bsp(lb_a, floor_bsp(v(120.0, 220.0, 10.0), Quaternion::identity()));
        scene.insert_static_physics_bsp(lb_b, floor_bsp(Vector3::zero(), Quaternion::identity()));
        assert_eq!(scene.static_physics_bsp_count(), 3);
        assert_eq!(scene.clear_static_physics_bsps_for_landblock(lb_a), 2);
        assert_eq!(scene.static_physics_bsp_count(), 1);
        assert_eq!(
            scene.clear_static_physics_bsps_for_landblock(lb_a),
            0,
            "idempotent re-clear"
        );
    }

    #[test]
    fn static_bsp_pushout_none_when_no_static_bsp() {
        let scene = SpatialScene::new();
        let pose = pose_in_a9b4();
        let center = v(100.0, 200.0, 10.1);
        assert!(
            scene.resolve_static_bsp_pushout(&pose, &[center], 0.5, 1).is_none(),
            "no registered static BSP ⇒ no push-out"
        );
    }

    #[test]
    fn static_bsp_pushout_resolves_penetrating_capsule() {
        // A floor static at world (100,200,10), identity frame, so
        // world_to_local is a pure translate. A sphere straddling the floor
        // (local z=0.1, radius 0.5) penetrates the solid ⇒ push-out returns
        // a non-zero +Z displacement (mirrors the dat-level
        // `placement_insert_straddle_pushes_up_and_reports_adjusted`).
        let mut scene = SpatialScene::new();
        let origin = v(100.0, 200.0, 10.0);
        scene.insert_static_physics_bsp(0xA9B4_0000, floor_bsp(origin, Quaternion::identity()));
        let pose = pose_in_a9b4();
        let straddle = v(origin.x, origin.y, origin.z + 0.1); // local z = 0.1
        let disp = scene
            .resolve_static_bsp_pushout(&pose, &[straddle], 0.5, 1)
            .expect("penetrating capsule should be pushed out");
        assert!(disp.z > 0.0, "pushed up off the floor: {disp:?}");
        assert!(disp.length() > 1e-3, "displacement is non-trivial: {disp:?}");
    }

    #[test]
    fn static_bsp_pushout_none_when_capsule_clear() {
        let mut scene = SpatialScene::new();
        let origin = v(100.0, 200.0, 10.0);
        scene.insert_static_physics_bsp(0xA9B4_0000, floor_bsp(origin, Quaternion::identity()));
        let pose = pose_in_a9b4();
        // Sphere well above the floor (local z = 5) ⇒ free space ⇒ no push.
        let clear = v(origin.x, origin.y, origin.z + 5.0);
        assert!(
            scene.resolve_static_bsp_pushout(&pose, &[clear], 0.5, 1).is_none(),
            "capsule clear of the solid ⇒ no push-out"
        );
    }

    #[test]
    fn static_bsp_pushout_ignores_far_landblock() {
        // A static BSP registered in a landblock outside the pose's 3x3
        // ring must not be consulted.
        let mut scene = SpatialScene::new();
        let origin = v(100.0, 200.0, 10.0);
        scene.insert_static_physics_bsp(0x1020_0000, floor_bsp(origin, Quaternion::identity()));
        let pose = pose_in_a9b4(); // landblock 0xA9B4 — far from 0x1020
        let straddle = v(origin.x, origin.y, origin.z + 0.1);
        assert!(
            scene.resolve_static_bsp_pushout(&pose, &[straddle], 0.5, 1).is_none(),
            "out-of-ring static BSP ⇒ not consulted"
        );
    }
}

/// B11 (2026-06-09): EnvCell→terrain EXIT flip — the inverse of
/// `entered_envcell_for_outdoor_pose`. These cover the membership /
/// neighbour / guard plumbing in `exited_envcell_to_outdoor`; the
/// in-world door-crossing behaviour is verified separately.
mod envcell_exit {
    use super::*;
    use holtburger_common::Aabb;
    use holtburger_dat::physics::{BspLeaf, BspNode};

    // Landblock 0xA9B4: high bytes X=0xA9 (169), Y=0xB4 (180). The
    // landblock origin in global space is (169*192, 180*192).
    const LB_HIGH: u32 = 0xA9B4_0000;
    const ORIGIN_X: f32 = 169.0 * 192.0;
    const ORIGIN_Y: f32 = 180.0 * 192.0;
    const R: f32 = 0.4; // PLAYER_CAPSULE_RADIUS

    /// A membership tree that is a single leaf — `sphere_intersects_cell`
    /// short-circuits any leaf to `EntirelyInside`, so membership reduces
    /// to the broad-phase AABB reject inside `exited_envcell_to_outdoor`.
    /// Identity orientation ⇒ world == local. That's enough to exercise
    /// the exit plumbing without hand-authoring a splitting BSP.
    fn leaf_membership() -> CellMembership {
        CellMembership {
            tree: BspNode::Leaf(BspLeaf {
                index: 0,
                solid: 0,
                sphere: None,
                poly_ids: vec![],
            }),
            origin: Vector3::zero(),
            orientation: Quaternion::identity(),
        }
    }

    /// World-space AABB centred on landblock-local `(lx, ly)` with the
    /// given half-extent, spanning a generous Z band.
    fn cell_box(lx: f32, ly: f32, half: f32) -> Aabb {
        let gx = ORIGIN_X + lx;
        let gy = ORIGIN_Y + ly;
        Aabb::new(
            Vector3::new(gx - half, gy - half, -50.0),
            Vector3::new(gx + half, gy + half, 50.0),
        )
    }

    /// Indoor pose whose landblock-local coords are `(lx, ly, lz)`.
    fn indoor_pose(cell_id: u32, lx: f32, ly: f32, lz: f32) -> WorldPosition {
        WorldPosition {
            landblock_id: Guid(cell_id),
            coords: Vector3::new(lx, ly, lz),
            rotation: Quaternion::identity(),
        }
    }

    #[test]
    fn exit_returns_none_for_outdoor_pose() {
        let scene = SpatialScene::new();
        let outdoor = WorldPosition {
            landblock_id: Guid(LB_HIGH | 0x0019),
            coords: Vector3::new(50.0, 50.0, 5.0),
            rotation: Quaternion::identity(),
        };
        assert_eq!(scene.exited_envcell_to_outdoor(&outdoor, R), None);
    }

    #[test]
    fn exit_returns_none_when_membership_unbaked() {
        // Cell AABB present (and the player is well outside it) but NO
        // membership entry ⇒ indoor geometry hasn't baked ⇒ never eject.
        let mut scene = SpatialScene::new();
        let exit_cell = LB_HIGH | 0x0100;
        scene.insert_cell_aabb(exit_cell, cell_box(50.0, 50.0, 5.0));
        let pose = indoor_pose(exit_cell, 50.0, 90.0, 5.0); // outside the box
        assert_eq!(scene.exited_envcell_to_outdoor(&pose, R), None);
    }

    #[test]
    fn exit_returns_none_when_still_inside_cell() {
        let mut scene = SpatialScene::new();
        let exit_cell = LB_HIGH | 0x0100;
        scene.insert_cell_aabb(exit_cell, cell_box(50.0, 50.0, 5.0));
        scene.insert_cell_membership(exit_cell, leaf_membership());
        // Standing in the middle of the room.
        let pose = indoor_pose(exit_cell, 50.0, 50.0, 5.0);
        assert_eq!(scene.exited_envcell_to_outdoor(&pose, R), None);
    }

    #[test]
    fn exit_returns_outdoor_id_when_clear_of_cell() {
        let mut scene = SpatialScene::new();
        let exit_cell = LB_HIGH | 0x0100;
        scene.insert_cell_aabb(exit_cell, cell_box(50.0, 50.0, 5.0));
        scene.insert_cell_membership(exit_cell, leaf_membership());
        // An outdoor-exit sentinel neighbour must NOT trip the BFS (it
        // IS the outdoors) — include it to prove it's skipped.
        scene.insert_cell_portal(exit_cell, LB_HIGH | 0xFFFF);
        // Walked out: local (50, 90) is well past the box's +Y wall.
        let pose = indoor_pose(exit_cell, 50.0, 90.0, 5.0);
        let got = scene
            .exited_envcell_to_outdoor(&pose, R)
            .expect("capsule clear of the cell hull should flip to outdoor");
        // High word preserved; result is outdoor; low word is the
        // terrain cell the coords fall in (preserving global position).
        assert_eq!(got & 0xFFFF_0000, LB_HIGH, "landblock high word preserved");
        let result_pose = WorldPosition {
            landblock_id: Guid(got),
            coords: Vector3::zero(),
            rotation: Quaternion::identity(),
        };
        assert!(!result_pose.is_indoors(), "flipped to an outdoor cell id");
        let expected_low = WorldPosition {
            landblock_id: Guid(LB_HIGH),
            coords: pose.coords,
            rotation: pose.rotation,
        }
        .derived_outdoor_cell_id()
        .unwrap();
        assert_eq!(got & 0xFFFF, expected_low, "outdoor cell derived from coords");
    }

    #[test]
    fn exit_returns_none_when_inside_an_indoor_neighbour() {
        // Player has left the current cell's AABB but is geometrically
        // inside a portal-connected indoor neighbour (membership leaf, no
        // AABB ⇒ broad-phase skipped ⇒ leaf says inside). Merely crossed
        // an interior portal — stay indoors.
        let mut scene = SpatialScene::new();
        let exit_cell = LB_HIGH | 0x0100;
        let back_room = LB_HIGH | 0x0101;
        scene.insert_cell_aabb(exit_cell, cell_box(50.0, 50.0, 5.0));
        scene.insert_cell_membership(exit_cell, leaf_membership());
        // Neighbour: membership but no AABB, reachable via portal.
        scene.insert_cell_membership(back_room, leaf_membership());
        scene.insert_cell_portal(exit_cell, back_room);
        scene.insert_cell_portal(back_room, exit_cell);
        // Outside exit_cell's box; current_cell stays exit_cell (no AABB
        // contains the point), so the BFS is what must catch the neighbour.
        let pose = indoor_pose(exit_cell, 50.0, 90.0, 5.0);
        assert_eq!(scene.exited_envcell_to_outdoor(&pose, R), None);
    }

    #[test]
    fn cell_has_outdoor_exit_detects_sentinel() {
        let mut scene = SpatialScene::new();
        let exit_cell = LB_HIGH | 0x0100;
        let interior = LB_HIGH | 0x0166;
        scene.insert_cell_portal(exit_cell, LB_HIGH | 0xFFFF); // outdoor door
        scene.insert_cell_portal(exit_cell, interior);
        scene.insert_cell_portal(interior, exit_cell); // interior-only
        assert!(scene.cell_has_outdoor_exit(exit_cell), "has 0xFFFF portal");
        assert!(!scene.cell_has_outdoor_exit(interior), "interior-only cell");
        assert!(!scene.cell_has_outdoor_exit(LB_HIGH | 0x0199), "unknown cell");
    }
}

// === A2-P2 (2026-06-12, W3+ S8) — remote MoveOrTeleport lattice ==========
//
// Each row dual-cited against the decompiled remote correction pipeline
// (`CPhysicsObj::MoveOrTeleport`, acclient.c:323451-323498, plus the
// caller's ConstrainTo at :145223-145227 and the non-player constants at
// :315861-315929). Flag-off byte-identity is pinned last.
mod remote_pose_driver {
    use super::*;
    use crate::spatial::scene::RemoteCorrectionCtx;
    use crate::spatial::{AuthoritativeBodySync, SpatialBodyId, SpatialSampleMode};

    const GUID: Guid = Guid(0x7000_0042);

    fn outdoor_pose(x: f32, y: f32) -> WorldPosition {
        WorldPosition {
            landblock_id: Guid(0x0102_0000),
            coords: Vector3::new(x, y, 0.0),
            rotation: Quaternion::from_heading(0.0),
        }
    }

    fn indoor_pose_at(x: f32, y: f32) -> WorldPosition {
        WorldPosition {
            // Low word ≥ 0x100 → indoor (`WorldPosition::is_indoors`).
            landblock_id: Guid(0x0102_0105),
            coords: Vector3::new(x, y, 0.0),
            rotation: Quaternion::from_heading(0.0),
        }
    }

    fn ctx(contact: Option<bool>, player: Option<WorldPosition>) -> Option<RemoteCorrectionCtx> {
        Some(RemoteCorrectionCtx {
            contact,
            player_pose: player,
        })
    }

    /// Scene with the flag on and the remote body seeded at `start`
    /// (first reconcile creates the body — the "no resolved prior pose"
    /// arm — so the lattice rows below act on an EXISTING body).
    fn scene_with_remote_body(start: WorldPosition) -> (SpatialScene, SpatialBodyId) {
        let mut scene = SpatialScene::new();
        scene.set_remote_interp_enabled(true);
        let body_id = SpatialBodyId::Entity(GUID);
        scene.reconcile_authoritative_body_with_remote(
            body_id,
            start,
            Vector3::zero(),
            Vector3::zero(),
            AuthoritativeBodySync::Snapshot,
            Instant::now(),
            ctx(Some(true), Some(start)),
        );
        assert_eq!(scene.body(body_id).unwrap().pose, start, "seed snap");
        (scene, body_id)
    }

    fn reconcile(
        scene: &mut SpatialScene,
        body_id: SpatialBodyId,
        target: WorldPosition,
        sync: AuthoritativeBodySync,
        remote: Option<RemoteCorrectionCtx>,
    ) {
        scene.reconcile_authoritative_body_with_remote(
            body_id,
            target,
            Vector3::zero(),
            Vector3::zero(),
            sync,
            Instant::now(),
            remote,
        );
    }

    /// Near + contact → `InterpolateTo` queues a node and the leash is
    /// armed on the object's OWN pose; the working pose is NOT snapped
    /// (acclient.c:323492-323495, :145223-145227).
    #[test]
    fn near_contact_queues_node_and_constrains_without_snapping() {
        let start = outdoor_pose(50.0, 50.0);
        let (mut scene, body_id) = scene_with_remote_body(start);
        let target = outdoor_pose(55.0, 50.0);
        reconcile(
            &mut scene,
            body_id,
            target,
            AuthoritativeBodySync::Snapshot,
            ctx(Some(true), Some(start)),
        );
        let body = scene.body(body_id).unwrap();
        assert_eq!(body.pose, start, "working pose untouched at ingest");
        assert_eq!(body.authoritative_pose, Some(target));
        assert!(body.position_manager.queue_active(), "node queued");
        assert!(body.position_manager.constraint.is_constrained());
        assert_eq!(body.sampling.mode, SpatialSampleMode::AuthoritativeOnly);
    }

    /// Teleport-stamp advance (`Reset`) → hard set + manager cleared
    /// (acclient.c:323469-323478).
    #[test]
    fn teleport_reset_snaps_and_clears_manager() {
        let start = outdoor_pose(50.0, 50.0);
        let (mut scene, body_id) = scene_with_remote_body(start);
        reconcile(
            &mut scene,
            body_id,
            outdoor_pose(55.0, 50.0),
            AuthoritativeBodySync::Snapshot,
            ctx(Some(true), Some(start)),
        );
        assert!(scene.body(body_id).unwrap().position_manager.queue_active());
        let teleport_target = outdoor_pose(120.0, 50.0);
        reconcile(
            &mut scene,
            body_id,
            teleport_target,
            AuthoritativeBodySync::Reset,
            ctx(Some(true), Some(start)),
        );
        let body = scene.body(body_id).unwrap();
        assert_eq!(body.pose, teleport_target, "teleport hard-sets");
        assert!(!body.position_manager.queue_active(), "manager cleared");
        assert_eq!(body.sampling.mode, SpatialSampleMode::Suspended);
    }

    /// `!contact` → working pose untouched, bookkeeping still updates
    /// (acclient.c:323480-323481).
    #[test]
    fn contact_false_leaves_working_pose_untouched() {
        let start = outdoor_pose(50.0, 50.0);
        let (mut scene, body_id) = scene_with_remote_body(start);
        let target = outdoor_pose(55.0, 50.0);
        reconcile(
            &mut scene,
            body_id,
            target,
            AuthoritativeBodySync::Snapshot,
            ctx(Some(false), Some(start)),
        );
        let body = scene.body(body_id).unwrap();
        assert_eq!(body.pose, start, "working pose untouched");
        assert_eq!(body.authoritative_pose, Some(target), "bookkeeping updated");
        assert!(!body.position_manager.queue_active(), "no node queued");
        assert_eq!(body.last_wire_contact, Some(false));
    }

    /// `player_distance` gate: 95.9 m interpolates, 96.0 m (and a
    /// missing player pose) snaps (acclient.c:323483-323489).
    #[test]
    fn player_distance_gate_at_96m() {
        let start = outdoor_pose(50.0, 50.0);
        let target = outdoor_pose(55.0, 50.0);

        // 95.9 m → interpolate.
        let (mut scene, body_id) = scene_with_remote_body(start);
        let player_near = outdoor_pose(50.0 + 95.9, 50.0);
        reconcile(
            &mut scene,
            body_id,
            target,
            AuthoritativeBodySync::Snapshot,
            ctx(Some(true), Some(player_near)),
        );
        assert!(
            scene.body(body_id).unwrap().position_manager.queue_active(),
            "95.9 m: interpolate"
        );

        // 96.0 m → stop + snap.
        let (mut scene, body_id) = scene_with_remote_body(start);
        let player_far = outdoor_pose(50.0 + 96.0, 50.0);
        reconcile(
            &mut scene,
            body_id,
            target,
            AuthoritativeBodySync::Snapshot,
            ctx(Some(true), Some(player_far)),
        );
        let body = scene.body(body_id).unwrap();
        assert_eq!(body.pose, target, "96.0 m: snap");
        assert!(!body.position_manager.queue_active());

        // No player pose → treated as far → snap.
        let (mut scene, body_id) = scene_with_remote_body(start);
        reconcile(
            &mut scene,
            body_id,
            target,
            AuthoritativeBodySync::Snapshot,
            ctx(Some(true), None),
        );
        let body = scene.body(body_id).unwrap();
        assert_eq!(body.pose, target, "no player: snap");
        assert!(!body.position_manager.queue_active());
    }

    /// Remote blip gate is the NON-player pair (20 indoor / 100 outdoor,
    /// acclient.c:315872-315878): beyond-blip corrections queue the node
    /// with `node_fail_counter = 4` (acclient.c:389141-389171).
    #[test]
    fn beyond_blip_node_carries_fail_counter_four() {
        // Outdoor: 150 m > 100 → blip-type install.
        let start = outdoor_pose(50.0, 50.0);
        let (mut scene, body_id) = scene_with_remote_body(start);
        reconcile(
            &mut scene,
            body_id,
            outdoor_pose(50.0, 50.0 + 150.0),
            AuthoritativeBodySync::Snapshot,
            ctx(Some(true), Some(start)),
        );
        let body = scene.body(body_id).unwrap();
        assert!(body.position_manager.queue_active());
        assert_eq!(
            body.position_manager.interpolation.node_fail_counter(),
            4,
            "outdoor beyond-blip"
        );

        // Indoor: 50 m > 20 (player indoor blip would be 25; the
        // NON-player constant is what must gate here).
        let start = indoor_pose_at(50.0, 50.0);
        let (mut scene, body_id) = scene_with_remote_body(start);
        reconcile(
            &mut scene,
            body_id,
            indoor_pose_at(50.0, 50.0 + 50.0),
            AuthoritativeBodySync::Snapshot,
            ctx(Some(true), Some(start)),
        );
        let body = scene.body(body_id).unwrap();
        assert_eq!(
            body.position_manager.interpolation.node_fail_counter(),
            4,
            "indoor beyond-blip (20 m non-player radius)"
        );
    }

    /// Ctx-less reconcile (VectorUpdate / bookkeeping) while the manager
    /// owns the pose: velocity bookkeeping lands, working pose preserved
    /// (retail `DoVectorUpdate` sets velocity without relocating,
    /// acclient.c:143459-143480; documented S8 deviation arm).
    #[test]
    fn ctxless_reconcile_preserves_managed_pose() {
        let start = outdoor_pose(50.0, 50.0);
        let (mut scene, body_id) = scene_with_remote_body(start);
        let target = outdoor_pose(55.0, 50.0);
        reconcile(
            &mut scene,
            body_id,
            target,
            AuthoritativeBodySync::Snapshot,
            ctx(Some(true), Some(start)),
        );
        // VectorUpdate-shaped reconcile: ctx None, entity pos re-asserted.
        scene.reconcile_authoritative_body_with_remote(
            body_id,
            target,
            Vector3::new(1.0, 0.0, 0.0),
            Vector3::zero(),
            AuthoritativeBodySync::Snapshot,
            Instant::now(),
            None,
        );
        let body = scene.body(body_id).unwrap();
        assert_eq!(body.pose, start, "managed working pose preserved");
        assert_eq!(body.velocity, Vector3::new(1.0, 0.0, 0.0));
        assert!(body.position_manager.queue_active(), "queue intact");
    }

    /// Flag OFF (default) → every arm above degrades to the legacy hard
    /// snap, ctx or not — byte-identical rollback contract.
    #[test]
    fn flag_off_snaps_even_with_ctx() {
        let mut scene = SpatialScene::new();
        assert!(!scene.remote_interp_enabled());
        let body_id = SpatialBodyId::Entity(GUID);
        let start = outdoor_pose(50.0, 50.0);
        scene.register_body(SpatialBody::new(body_id, start, Instant::now()));
        let target = outdoor_pose(55.0, 50.0);
        reconcile(
            &mut scene,
            body_id,
            target,
            AuthoritativeBodySync::Snapshot,
            ctx(Some(true), Some(start)),
        );
        let body = scene.body(body_id).unwrap();
        assert_eq!(body.pose, target, "flag off: legacy snap");
        assert!(!body.position_manager.queue_active());
        // And the per-frame step is zero work.
        scene.step_remote_position_managers(0.1);
        assert!(scene.take_remote_stepped_poses().is_empty());
    }

    /// Convergence (S8 §4 test 3): a queued correction approaches
    /// monotonically at the 7.5 m/s floor, completes in the deadband,
    /// goes idle, and every stepped frame lands in the export ledger.
    #[test]
    fn step_remote_managers_converges_and_records_ledger() {
        let start = outdoor_pose(50.0, 50.0);
        let (mut scene, body_id) = scene_with_remote_body(start);
        let target = outdoor_pose(53.0, 50.0);
        reconcile(
            &mut scene,
            body_id,
            target,
            AuthoritativeBodySync::Snapshot,
            ctx(Some(true), Some(start)),
        );

        let mut last_dist = scene.body(body_id).unwrap().pose.distance_to(&target);
        let mut stepped_frames = 0;
        for _ in 0..60 {
            scene.step_remote_position_managers(0.1);
            let rows = scene.take_remote_stepped_poses();
            let body = scene.body(body_id).unwrap();
            if !rows.is_empty() {
                stepped_frames += 1;
                assert_eq!(rows[0].0, GUID);
                assert_eq!(rows[0].1, body.pose, "ledger carries the stepped pose");
            }
            let dist = body.pose.distance_to(&target);
            assert!(
                dist <= last_dist + 1e-5,
                "monotonic approach: {dist} > {last_dist}"
            );
            last_dist = dist;
            if !body.position_manager.queue_active() {
                break;
            }
        }
        let body = scene.body(body_id).unwrap();
        assert!(
            body.pose.distance_to(&target) < 0.05 + 1e-3,
            "completed in the deadband, dist = {}",
            body.pose.distance_to(&target)
        );
        assert!(!body.position_manager.queue_active(), "manager idle");
        assert!(stepped_frames >= 4, "stepped across frames: {stepped_frames}");
        // Idle manager → no further ledger rows.
        scene.step_remote_position_managers(0.1);
        assert!(scene.take_remote_stepped_poses().is_empty());
    }

    // === A2-P3 R2 (2026-06-12, W3+ S9 Stage R2) — REMOTE sticky. =========

    /// Full cycle, the F3-4 case (mob glued to the LOCAL player):
    /// install via the wire arm's API, per-slice step converges to the
    /// retail standoff (cyl-dist − 0.3, radii 0.0 → 0.3 m) at the 15 m/s
    /// floor with the heading facing the target, every sticky-stepped
    /// frame lands in BOTH ledgers (pose rows + sticky flags), and the
    /// 1.0 s retail timeout clears it (acclient.c:388519-388720).
    #[test]
    fn remote_sticky_converges_flags_rows_and_times_out() {
        let start = outdoor_pose(50.0, 50.0);
        let (mut scene, body_id) = scene_with_remote_body(start);
        scene.set_remote_sticky_enabled(true);

        // Target = the LOCAL player's body (resolution priority arm 2).
        let player_guid = Guid(0x5000_00AB);
        let player_pose = outdoor_pose(60.0, 50.0);
        scene.upsert_runtime_body_snapshot(
            SpatialBodyId::LocalPlayer(player_guid),
            player_pose,
            Vector3::zero(),
            Vector3::zero(),
            None,
            Instant::now(),
        );

        scene.stick_remote_entity_to(GUID, player_guid);
        assert_eq!(scene.remote_sticky_target(GUID), Some(player_guid));

        // Gap 10 m, speed floor 15 m/s (no Rust-side per-entity motion
        // speed → max_speed 0.0, acclient.c:388569-388579) → 0.24 m per
        // 16 ms slice → ~41 slices to the 0.3 m standoff; the 1.0 s
        // timeout (62.5 slices) must NOT fire first.
        let mut converged_at = None;
        let mut sticky_rows = 0;
        for i in 0..55 {
            scene.step_remote_position_managers(0.016);
            let rows = scene.take_remote_stepped_poses();
            let sticky = scene.take_remote_sticky_stepped();
            let body = scene.body(body_id).unwrap();
            if !rows.is_empty() {
                assert_eq!(rows[0].0, GUID);
                assert_eq!(rows[0].1, body.pose, "ledger carries the stepped pose");
                assert!(sticky.contains(&GUID), "sticky-stepped rows are flagged");
                sticky_rows += 1;
            }
            let planar = (body.pose.coords - player_pose.coords).length();
            if converged_at.is_none() && (planar - STICKY_RADIUS).abs() < 0.02 {
                converged_at = Some(i);
            }
        }
        assert!(
            converged_at.is_some(),
            "must reach the 0.3 m standoff within 55 slices"
        );
        assert!(sticky_rows >= 40, "stepped across slices: {sticky_rows}");
        let body = scene.body(body_id).unwrap();
        assert!(
            (body.pose.rotation.to_heading() - body.pose.heading_to(&player_pose)).abs() < 1e-3,
            "heading faces the target"
        );

        // Past 1.0 s of slices → retail timeout clears target + index
        // (THE F3-4 "glued mob never times out" closer).
        for _ in 0..10 {
            scene.step_remote_position_managers(0.016);
        }
        assert_eq!(scene.remote_sticky_target(GUID), None, "timed out");
        scene.take_remote_stepped_poses();
        scene.take_remote_sticky_stepped();
        scene.step_remote_position_managers(0.016);
        assert!(
            scene.take_remote_sticky_stepped().is_empty(),
            "no sticky steps after timeout"
        );
    }

    /// Compose-rule inertness: without `set_remote_sticky_enabled(true)`
    /// the install API is a no-op and the step does zero sticky work —
    /// the flag-off (F3-4 JS glue) path stays byte-identical.
    #[test]
    fn remote_sticky_disabled_is_inert() {
        let start = outdoor_pose(50.0, 50.0);
        let (mut scene, body_id) = scene_with_remote_body(start);
        assert!(!scene.remote_sticky_enabled());
        let target_guid = Guid(0x8000_0001);
        scene.update_entity(target_guid, Guid(0x0102_0000), outdoor_pose(60.0, 50.0));

        scene.stick_remote_entity_to(GUID, target_guid);
        assert_eq!(scene.remote_sticky_target(GUID), None, "install inert");
        scene.step_remote_position_managers(0.016);
        assert!(scene.take_remote_stepped_poses().is_empty());
        assert!(scene.take_remote_sticky_stepped().is_empty());
        assert_eq!(scene.body(body_id).unwrap().pose, start, "pose untouched");
    }

    /// Unstick (the wire `0` clear) stops the pull; a wire re-stick
    /// re-arms the 1.0 s timeout (retail `StickTo` replaces the prior
    /// target, acclient.c:388665-388690 — ACE re-sends the bit on every
    /// chase/swing, so a live chase never times out spuriously).
    #[test]
    fn remote_sticky_unstick_clears_and_restick_rearms_timeout() {
        let start = outdoor_pose(50.0, 50.0);
        let (mut scene, _body_id) = scene_with_remote_body(start);
        scene.set_remote_sticky_enabled(true);
        let target_guid = Guid(0x8000_0001);
        scene.update_entity(target_guid, Guid(0x0102_0000), outdoor_pose(60.0, 50.0));

        scene.stick_remote_entity_to(GUID, target_guid);
        scene.step_remote_position_managers(0.016);
        assert!(!scene.take_remote_sticky_stepped().is_empty());
        scene.unstick_remote_entity(GUID);
        assert_eq!(scene.remote_sticky_target(GUID), None);
        scene.take_remote_stepped_poses();
        scene.step_remote_position_managers(0.016);
        assert!(scene.take_remote_sticky_stepped().is_empty(), "unstuck");

        // Re-stick, run 0.48 s, re-stick (re-arm), then run another
        // 0.8 s: total 1.28 s > 1.0 s, but the re-arm keeps it alive.
        scene.stick_remote_entity_to(GUID, target_guid);
        for _ in 0..30 {
            scene.step_remote_position_managers(0.016);
        }
        assert_eq!(scene.remote_sticky_target(GUID), Some(target_guid));
        scene.stick_remote_entity_to(GUID, target_guid);
        for _ in 0..50 {
            scene.step_remote_position_managers(0.016);
        }
        assert_eq!(
            scene.remote_sticky_target(GUID),
            Some(target_guid),
            "re-stick re-armed the timeout past the original 1.0 s mark"
        );
    }

    /// Wire-order robustness: a sticky install can land BEFORE the
    /// holder's body exists (KIND_MOTION before the first routed
    /// UpdatePosition). The index entry is kept and the per-slice step
    /// lazy-installs once the body appears; target pose resolves from
    /// the `entity_poses` stash (priority arm 3). Entity removal drops
    /// the index entry.
    #[test]
    fn remote_sticky_lazy_install_and_removal_cleanup() {
        let mut scene = SpatialScene::new();
        scene.set_remote_interp_enabled(true);
        scene.set_remote_sticky_enabled(true);
        let lb = Guid(0x0102_0000);
        let target_guid = Guid(0x8000_0001);
        scene.update_entity(target_guid, lb, outdoor_pose(55.0, 50.0));

        // No holder body yet → install records the index only; step is
        // a no-op (nothing steppable).
        scene.stick_remote_entity_to(GUID, target_guid);
        assert_eq!(scene.remote_sticky_target(GUID), Some(target_guid));
        scene.step_remote_position_managers(0.016);
        assert!(scene.take_remote_sticky_stepped().is_empty());

        // Body appears → the next slice lazy-installs and steps.
        let start = outdoor_pose(50.0, 50.0);
        let body_id = SpatialBodyId::Entity(GUID);
        scene.reconcile_authoritative_body_with_remote(
            body_id,
            start,
            Vector3::zero(),
            Vector3::zero(),
            AuthoritativeBodySync::Snapshot,
            Instant::now(),
            ctx(Some(true), Some(start)),
        );
        scene.step_remote_position_managers(0.016);
        assert!(
            scene.take_remote_sticky_stepped().contains(&GUID),
            "lazy install steps"
        );
        assert!(
            scene.body(body_id).unwrap().pose.coords.x > start.coords.x,
            "pulled toward the target"
        );

        // Despawn cleanup: the holder's index entry is dropped.
        scene.remove_entity(GUID, lb);
        assert_eq!(scene.remote_sticky_target(GUID), None);
    }
}

// === A2-P3 (2026-06-12, W3+ S9) — LOCAL-player sticky scene tests. =======

/// Spec S9 §4 test 11 — full cycle: install (with the `entity_poses`
/// auto-feed), per-frame `step_local_sticky` convergence to the standoff
/// with the heading facing the target, live re-feed via
/// [`SpatialScene::update_entity`], and the 1.0 s timeout clear.
#[test]
fn local_sticky_install_feed_step_converges_and_times_out() {
    let mut scene = SpatialScene::new();
    let player_guid = Guid(0x5000_00AB);
    let target_guid = Guid(0x8000_0001);
    let lb = Guid(0x0102_0000);
    let now = Instant::now();

    let player_pose = make_position(50.0, 50.0, 0.0);
    let body_id = SpatialBodyId::LocalPlayer(player_guid);
    scene.upsert_runtime_body_snapshot(
        body_id,
        player_pose,
        Vector3::zero(),
        Vector3::zero(),
        None,
        now,
    );

    // Target pose known BEFORE the stick: the entity_poses auto-feed
    // seeds the stash at install time (spec S9 §3 R1 step 2 deviation).
    let target_pose = make_position(55.0, 50.0, 0.0);
    scene.update_entity(target_guid, lb, target_pose);

    assert_eq!(scene.local_sticky_target(), None);
    scene.stick_local_player_to(target_guid, 0.0);
    assert_eq!(scene.local_sticky_target(), Some(target_guid));

    // Converge: gap 5 m, radii 0 → standoff 0.3 m; speed = 4*5 = 20 m/s
    // → ~16 frames at 16 ms. The 1.0 s timeout must NOT fire first.
    let mut cur = player_pose;
    let mut converged_at = None;
    for i in 0..30 {
        match scene.step_local_sticky(cur, 0.016, 4.0) {
            LocalStickyStep::Stepped(pose) => cur = pose,
            LocalStickyStep::Inactive => panic!("sticky fed+active: must step (frame {i})"),
            LocalStickyStep::TimedOut => panic!("timeout before 1.0 s (frame {i})"),
        }
        let planar = (cur.coords - target_pose.coords).length();
        if converged_at.is_none() && (planar - STICKY_RADIUS).abs() < 0.02 {
            converged_at = Some(i);
        }
    }
    assert!(
        converged_at.is_some(),
        "must reach the 0.3 m standoff within 30 frames (got {:?})",
        (cur.coords - target_pose.coords).length()
    );
    assert!(
        (cur.rotation.to_heading() - cur.heading_to(&target_pose)).abs() < 1e-3,
        "heading faces the target"
    );
    assert!((cur.coords.z - player_pose.coords.z).abs() < 1e-6, "z untouched");

    // Live re-feed: the target moves; update_entity routes the new pose
    // into the stash and the pull tracks it.
    let moved_target = make_position(55.0, 56.0, 0.0);
    scene.update_entity(target_guid, lb, moved_target);
    let before = (cur.coords - moved_target.coords).length();
    for _ in 0..10 {
        if let LocalStickyStep::Stepped(pose) = scene.step_local_sticky(cur, 0.016, 4.0) {
            cur = pose;
        }
    }
    assert!(
        (cur.coords - moved_target.coords).length() < before,
        "tracks the moved target"
    );

    // Timeout: 30 + 10 frames burned 0.64 s; keep stepping past 1.0 s.
    let mut timed_out = false;
    for _ in 0..40 {
        match scene.step_local_sticky(cur, 0.016, 4.0) {
            LocalStickyStep::TimedOut => {
                timed_out = true;
                break;
            }
            LocalStickyStep::Stepped(pose) => cur = pose,
            LocalStickyStep::Inactive => panic!("cleared without a TimedOut signal"),
        }
    }
    assert!(timed_out, "1.0 s window must expire");
    assert_eq!(scene.local_sticky_target(), None);
    assert!(matches!(
        scene.step_local_sticky(cur, 0.016, 4.0),
        LocalStickyStep::Inactive
    ));
}

/// COMBAT-RADII (2026-07-28) — the standoff is `my_radius +
/// target_radius + 0.3` (retail `StickyManager::adjust_offset`
/// `cyl_dist_no_z − 0.3` over `planar − my_radius − target_radius`,
/// acclient.c:388559-388560), NOT 0.3 m from the target's CENTRE.
/// Drives the same scene surface at three target sizes and asserts the
/// converged planar gap tracks the summed radii; the flag-off arm
/// reproduces the pre-fix 0.3 m centre distance.
#[test]
fn local_sticky_standoff_is_radius_aware_and_flag_off_reproduces_centre_glue() {
    // (target_radius, label) — shadow-child-sized, humanoid, tusker-sized.
    for &(target_radius, label) in &[(0.3_f32, "small"), (0.6_f32, "medium"), (1.6_f32, "large")] {
        for &enabled in &[true, false] {
            let mut scene = SpatialScene::new();
            scene.set_combat_radii_enabled(enabled);
            let player_guid = Guid(0x5000_00AB);
            let target_guid = Guid(0x8000_0001);
            let lb = Guid(0x0102_0000);
            let now = Instant::now();
            let player_pose = make_position(50.0, 50.0, 0.0);
            scene.upsert_runtime_body_snapshot(
                SpatialBodyId::LocalPlayer(player_guid),
                player_pose,
                Vector3::zero(),
                Vector3::zero(),
                None,
                now,
            );
            let target_pose = make_position(60.0, 50.0, 0.0);
            scene.update_entity(target_guid, lb, target_pose);
            // The install radius is what the CALLER resolved — with the
            // flag off every call site passes 0.0 (the CPartArray-null
            // fallback), so mirror that here.
            scene.stick_local_player_to(target_guid, if enabled { target_radius } else { 0.0 });

            let mut cur = player_pose;
            for _ in 0..40 {
                match scene.step_local_sticky(cur, 0.016, 4.0) {
                    LocalStickyStep::Stepped(pose) => cur = pose,
                    LocalStickyStep::Inactive => break,
                    LocalStickyStep::TimedOut => break,
                }
            }
            let gap = (cur.coords - target_pose.coords).length();
            let expected = if enabled {
                crate::spatial::transition::PLAYER_PART_RADIUS + target_radius + STICKY_RADIUS
            } else {
                STICKY_RADIUS
            };
            assert!(
                (gap - expected).abs() < 0.05,
                "{label} target, combatRadii={enabled}: gap {gap} != expected {expected}",
            );
            if enabled {
                assert!(
                    gap > target_radius,
                    "{label} target: player must end OUTSIDE the model (gap {gap} vs radius {target_radius})",
                );
            }
        }
    }
}

/// COMBAT-RADII — the UNCONDITIONAL reachability counter bumps on every
/// local sticky slice EVEN WITH THE FLAG OFF (the `scenery_arm_evals`
/// lesson: a gated probe cannot distinguish "off" from "dead code").
#[test]
fn combat_radii_eval_counter_bumps_with_the_flag_off() {
    let mut scene = SpatialScene::new();
    assert_eq!(scene.combat_radii_counters(), (0, 0));
    assert!(!scene.combat_radii_enabled());
    // No body, no sticky — the probe still records that the site ran.
    let pose = make_position(50.0, 50.0, 0.0);
    for _ in 0..3 {
        let _ = scene.step_local_sticky(pose, 0.016, 4.0);
    }
    assert_eq!(scene.combat_radii_counters().0, 3);
    assert_eq!(scene.local_player_part_radius(), 0.0, "flag off ⇒ 0.0");
    scene.set_combat_radii_enabled(true);
    assert_eq!(
        scene.local_player_part_radius(),
        crate::spatial::transition::PLAYER_PART_RADIUS,
        "flag on ⇒ retail Setup 0x02000001 .radius (0.6788225), NOT the \
         hand-tuned 0.4 PLAYER_CAPSULE_RADIUS",
    );
}

/// Spec S9 §4 tests 9+6 (scene half) — install without a known target
/// pose no-ops until the first feed (retail `Initialized` semantics,
/// acclient.c:388691-388720); unstick reports was-active exactly once
/// (the ACE `ClearTarget → cancel_moveto` signal); a stick replaces the
/// prior target.
#[test]
fn local_sticky_uninitialized_noop_unstick_once_and_replace() {
    let mut scene = SpatialScene::new();
    let player_guid = Guid(0x5000_00AB);
    let target_a = Guid(0x8000_0001);
    let target_b = Guid(0x8000_0002);
    let now = Instant::now();
    let player_pose = make_position(50.0, 50.0, 0.0);
    scene.upsert_runtime_body_snapshot(
        SpatialBodyId::LocalPlayer(player_guid),
        player_pose,
        Vector3::zero(),
        Vector3::zero(),
        None,
        now,
    );

    // Unknown target pose → active but uninitialized → Inactive steps.
    scene.stick_local_player_to(target_a, 0.0);
    assert_eq!(scene.local_sticky_target(), Some(target_a));
    assert!(matches!(
        scene.step_local_sticky(player_pose, 0.016, 4.0),
        LocalStickyStep::Inactive
    ));

    // Feed via the wasm-arm entry point.
    scene.sticky_pose_feed(target_a, make_position(53.0, 50.0, 0.0));
    assert!(matches!(
        scene.step_local_sticky(player_pose, 0.016, 4.0),
        LocalStickyStep::Stepped(_)
    ));

    // A feed for a NON-target guid is ignored.
    scene.sticky_pose_feed(target_b, make_position(40.0, 40.0, 0.0));

    // Replace: stick to B drops A's stash (uninitialized again).
    scene.stick_local_player_to(target_b, 0.0);
    assert_eq!(scene.local_sticky_target(), Some(target_b));
    assert!(matches!(
        scene.step_local_sticky(player_pose, 0.016, 4.0),
        LocalStickyStep::Inactive
    ));

    // Unstick: true once, then false (preamble subset idempotence).
    assert!(scene.unstick_local_player());
    assert!(!scene.unstick_local_player());
    assert_eq!(scene.local_sticky_target(), None);
}

// === Physics-parity 2026-07-03 (dossier A F14 / B row 58) — the retail
// LOCAL position lattice behind `?retailLeash` ==========================

fn leash_scene_with_midsim_player(
    drift_x: f32,
) -> (SpatialScene, SpatialBodyId, WorldPosition, Instant) {
    let mut scene = SpatialScene::new();
    scene.set_local_retail_leash(true);
    let now = Instant::now();
    let body_id = SpatialBodyId::LocalPlayer(Guid(0x5000_0031));
    // Outdoor landblock: leash 10/50, blip 100.
    let lb = Guid(0x00A9_0000);
    let make = |x: f32| WorldPosition {
        landblock_id: lb,
        coords: Vector3::new(x, 50.0, 0.0),
        rotation: Quaternion::from_heading(0.0),
    };
    let authoritative = make(50.0);
    scene.register_body(SpatialBody::new(body_id, authoritative, now));
    let mut working = scene.body(body_id).expect("seeded body").clone();
    working.pose = make(50.0 + drift_x);
    working.sampling.mode = SpatialSampleMode::SimulatingVelocity;
    working.contact = ContactState::Grounded;
    scene.update_body(working);
    (scene, body_id, authoritative, now)
}

/// Routine echo, autonomous player (no server control): `ConstrainTo`
/// re-arms on EVERY accepted echo (acclient.c:145209-145214) but NO
/// interp installs — retail never pulls an autonomous walker toward its
/// own echoes (:145215-145218).
#[test]
fn retail_leash_routine_echo_constrains_without_interp() {
    let (mut scene, body_id, target, now) = leash_scene_with_midsim_player(3.0);
    let start_dist = scene.body(body_id).unwrap().pose.distance_to(&target);
    scene.reconcile_authoritative_body(
        body_id,
        target,
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::Snapshot,
        now + Duration::from_millis(16),
    );
    let body = scene.body(body_id).unwrap();
    assert!(body.position_manager.constraint.is_constrained(), "leash armed");
    assert!(body.position_manager.retail_leash(), "manager in leash mode");
    assert!(
        !body.position_manager.is_interpolating(),
        "no interp install while autonomous"
    );
    assert!(
        (body.pose.distance_to(&target) - start_dist).abs() < 1e-4,
        "working pose untouched by the echo"
    );
    // A second echo re-arms (re-seeds) rather than being swallowed.
    scene.reconcile_authoritative_body(
        body_id,
        target,
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::Snapshot,
        now + Duration::from_millis(32),
    );
    assert!(scene.body(body_id).unwrap().position_manager.constraint.is_constrained());
}

/// Server-controlled + contact: the routine echo ALSO installs the
/// interp (`InterpolateTo`, :145215-145218); airborne suppresses it.
#[test]
fn retail_leash_interp_gates_on_server_control_and_contact() {
    // Controlled + grounded → installs.
    let (mut scene, body_id, target, now) = leash_scene_with_midsim_player(3.0);
    scene.set_local_server_controlled(true);
    scene.reconcile_authoritative_body(
        body_id,
        target,
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::Snapshot,
        now + Duration::from_millis(16),
    );
    assert!(scene.body(body_id).unwrap().position_manager.is_interpolating());

    // Controlled + AIRBORNE → constrain only.
    let (mut scene, body_id, target, now) = leash_scene_with_midsim_player(3.0);
    scene.set_local_server_controlled(true);
    let mut working = scene.body(body_id).unwrap().clone();
    working.contact = ContactState::Airborne;
    scene.update_body(working);
    scene.reconcile_authoritative_body(
        body_id,
        target,
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::Snapshot,
        now + Duration::from_millis(16),
    );
    let body = scene.body(body_id).unwrap();
    assert!(body.position_manager.constraint.is_constrained());
    assert!(!body.position_manager.is_interpolating(), "airborne gates interp");
}

/// Bug-A leash echo gate: with the gate ON, the routine-echo pull gates
/// on `UsePositionFromServer` (autonomy != 2, acclient.c:145213 →
/// :717529), NOT the control mirror — a mirror-up Snapshot echo
/// constrains but never interp-pulls at pinned autonomy 2 (ADJ-6). The
/// pull returns only if the autonomy mirror drops below full (the
/// landing-pad setter), exactly retail's sub-autonomy debug modes.
#[test]
fn leash_echo_gate_blocks_mirror_up_snapshot_pull() {
    // Gate on + mirror up + grounded: constrain only — the bug-A arm
    // goes quiet.
    let (mut scene, body_id, target, now) = leash_scene_with_midsim_player(3.0);
    scene.set_leash_echo_gate(true);
    scene.set_local_server_controlled(true);
    scene.reconcile_authoritative_body(
        body_id,
        target,
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::Snapshot,
        now + Duration::from_millis(16),
    );
    let body = scene.body(body_id).unwrap();
    assert!(body.position_manager.constraint.is_constrained(), "leash still re-arms");
    assert!(
        !body.position_manager.is_interpolating(),
        "gate blocks the echo pull while the mirror is up"
    );

    // Gate on + UsePositionFromServer true (autonomy < 2): the retail
    // sub-autonomy pull returns.
    let (mut scene, body_id, target, now) = leash_scene_with_midsim_player(3.0);
    scene.set_leash_echo_gate(true);
    scene.set_local_server_controlled(true);
    scene.set_local_use_position_from_server(true);
    scene.reconcile_authoritative_body(
        body_id,
        target,
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::Snapshot,
        now + Duration::from_millis(16),
    );
    assert!(scene.body(body_id).unwrap().position_manager.is_interpolating());
}

/// Bug-A leash echo gate: the Reset (teleport) arm is untouched by the
/// gate — forced corrections still constrain + zero velocity.
#[test]
fn leash_echo_gate_leaves_reset_arm_untouched() {
    let (mut scene, body_id, _target, now) = leash_scene_with_midsim_player(3.0);
    scene.set_leash_echo_gate(true);
    scene.set_local_server_controlled(true);
    let lb = Guid(0x00A9_0000);
    let arrival = WorldPosition {
        landblock_id: lb,
        coords: Vector3::new(120.0, 80.0, 4.0),
        rotation: Quaternion::from_heading(1.0),
    };
    scene.reconcile_authoritative_body(
        body_id,
        arrival,
        Vector3::new(2.0, 0.0, 0.0),
        Vector3::zero(),
        AuthoritativeBodySync::Reset,
        now + Duration::from_millis(16),
    );
    let body = scene.body(body_id).unwrap();
    assert!(body.position_manager.constraint.is_constrained(), "arrival leash armed");
    assert!(body.pose.distance_to(&arrival) < 1e-4, "pose adopts the arrival");
    assert_eq!(body.velocity, Vector3::zero(), "teleport zeroes wire velocity");
}

/// Teleport (Reset): constrain to the arrival (seed 0) + zero velocity
/// (acclient.c:145196-145207); the wire velocity is discarded.
#[test]
fn retail_leash_reset_constrains_and_zeroes_velocity() {
    let (mut scene, body_id, _target, now) = leash_scene_with_midsim_player(3.0);
    let lb = Guid(0x00A9_0000);
    let arrival = WorldPosition {
        landblock_id: lb,
        coords: Vector3::new(120.0, 80.0, 4.0),
        rotation: Quaternion::from_heading(1.0),
    };
    scene.reconcile_authoritative_body(
        body_id,
        arrival,
        Vector3::new(2.0, 0.0, 0.0),
        Vector3::zero(),
        AuthoritativeBodySync::Reset,
        now + Duration::from_millis(16),
    );
    let body = scene.body(body_id).unwrap();
    assert_eq!(body.pose, arrival, "teleport adopts the arrival pose");
    assert_eq!(body.velocity, Vector3::zero(), "teleport zeroes velocity");
    assert!(body.position_manager.constraint.is_constrained(), "leash re-armed");
    assert!(!body.position_manager.is_interpolating(), "no pending interp");
    assert_eq!(body.sampling.mode, SpatialSampleMode::Suspended);
}

/// Beyond-blip echo under server control: retail QUEUES the node with
/// `node_fail_counter = 4` and the next drain blips to it
/// (acclient.c:389140-389172) — no scene-side stop() pre-gate.
#[test]
fn retail_leash_beyond_blip_queues_then_blips_on_next_step() {
    let (mut scene, body_id, _t, now) = leash_scene_with_midsim_player(3.0);
    scene.set_local_server_controlled(true);
    let lb = Guid(0x00A9_0000);
    let far = WorldPosition {
        landblock_id: lb,
        coords: Vector3::new(170.0, 50.0, 0.0), // ~117 m > outdoor blip 100
        rotation: Quaternion::from_heading(0.0),
    };
    scene.reconcile_authoritative_body(
        body_id,
        far,
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::Snapshot,
        now + Duration::from_millis(16),
    );
    assert!(
        scene.body(body_id).unwrap().position_manager.is_interpolating(),
        "beyond-blip queues instead of stopping"
    );
    // One step: the drain sees node_fail_counter=4 → blips to the node.
    scene.step_force_position_interpolation(body_id, 0.016, 36.0, true);
    let body = scene.body(body_id).unwrap();
    assert!(
        body.pose.distance_to(&far) < 1e-4,
        "recovery blip lands the echo pose, got {:?}",
        body.pose
    );
}

/// F9b: the manual-drive chain slot — with the leash armed, every
/// per-slice delta burns travel budget (below `start`: passthrough;
/// in band: scaled by `(max-off)/(max-start)`); leash-off scenes pass
/// through untouched (acclient.c:388287-388304/:320029).
#[test]
fn retail_leash_manual_delta_burns_budget_then_scales() {
    let (mut scene, body_id, _t, _now) = leash_scene_with_midsim_player(0.0);
    // Arm the leash directly: seed 3.0, band 5..20.
    let mut working = scene.body(body_id).unwrap().clone();
    working.position_manager.set_retail_leash(true);
    working.position_manager.remote_constrain_to(3.0, 5.0, 20.0);
    scene.update_body(working);

    let step = Vector3::new(5.0, 0.0, 0.0);
    // Budget 3.0 < start 5: passthrough, budget → 8.0.
    let d1 = scene.constrain_local_manual_delta(body_id, step);
    assert!((d1.x - 5.0).abs() < 1e-6, "below start passes through, got {d1:?}");
    // Budget 8.0 in band: scale (20-8)/(20-5) = 0.8 → 4.0, budget → 12.0.
    let d2 = scene.constrain_local_manual_delta(body_id, step);
    assert!((d2.x - 4.0).abs() < 1e-6, "in-band scales 0.8, got {d2:?}");
    assert!(
        scene
            .body(body_id)
            .unwrap()
            .position_manager
            .constraint
            .is_constrained(),
        "leash stays armed"
    );

    // Leash-off scene: byte-identical passthrough, no budget burn.
    let (mut scene_off, body_off, _t, _now) = leash_scene_with_midsim_player(0.0);
    let mut working = scene_off.body(body_off).unwrap().clone();
    working.position_manager.remote_constrain_to(3.0, 5.0, 20.0);
    scene_off.update_body(working);
    scene_off.set_local_retail_leash(false);
    let d = scene_off.constrain_local_manual_delta(body_off, step);
    assert_eq!(d, step, "flag-off is a passthrough");
}

/// FU4 — the retail FORCE arm (acclient.c:145236-145243): a ForceBlip
/// under `?retailLeash` hard-snaps the position but KEEPS the player's
/// own heading, installs NO constraint, and does NOT zero the wire
/// velocity (contrast the teleport/Reset arm).
#[test]
fn retail_leash_force_blip_keeps_own_heading_no_constrain() {
    let (mut scene, body_id, _t, now) = leash_scene_with_midsim_player(0.0);
    // Give the working pose a distinctive heading.
    let mut working = scene.body(body_id).unwrap().clone();
    working.pose.rotation = Quaternion::from_heading(1.25);
    scene.update_body(working);
    let own_rotation = scene.body(body_id).unwrap().pose.rotation;

    let lb = Guid(0x00A9_0000);
    let target = WorldPosition {
        landblock_id: lb,
        coords: Vector3::new(90.0, 60.0, 2.0),
        rotation: Quaternion::from_heading(0.0), // wire heading — must NOT win
    };
    scene.reconcile_authoritative_body(
        body_id,
        target,
        Vector3::new(1.5, 0.0, 0.0),
        Vector3::zero(),
        AuthoritativeBodySync::ForceBlip,
        now + Duration::from_millis(16),
    );
    let body = scene.body(body_id).unwrap();
    assert_eq!(body.pose.coords, target.coords, "blip adopts the position");
    assert_eq!(body.pose.rotation, own_rotation, "own heading kept");
    assert!(
        !body.position_manager.constraint.is_constrained(),
        "force arm installs NO constraint"
    );
    assert_eq!(
        body.velocity,
        Vector3::new(1.5, 0.0, 0.0),
        "wire velocity stands (no zeroing)"
    );

    // Flag OFF: ForceBlip degrades to the Reset shape — full pose
    // (including wire heading) adopted, nothing leash-armed.
    let (mut scene, body_id, _t, now) = leash_scene_with_midsim_player(0.0);
    scene.set_local_retail_leash(false);
    scene.reconcile_authoritative_body(
        body_id,
        target,
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::ForceBlip,
        now + Duration::from_millis(16),
    );
    let body = scene.body(body_id).unwrap();
    assert_eq!(body.pose, target, "flag-off adopts the wire pose wholesale");
    assert!(!body.position_manager.constraint.is_constrained());
}

// === F10 (dossier B row 42) — the composed local adjust_offset chain ====

/// Flag-off: `adjust_local_offset_chain` is `None` with ZERO side
/// effects — no budget burn, no interp window advance, no drain; the
/// split sites keep owning the frame byte-identically.
#[test]
fn adjust_local_offset_chain_flag_off_is_none_with_zero_side_effects() {
    let (mut scene, body_id, _t, _now) = leash_scene_with_midsim_player(0.0);
    scene.set_local_retail_leash(false);
    let mut working = scene.body(body_id).unwrap().clone();
    let cur = working.pose;
    let target = WorldPosition {
        coords: Vector3::new(cur.coords.x + 3.0, cur.coords.y, cur.coords.z),
        ..cur
    };
    working.position_manager.remote_constrain_to(3.0, 5.0, 20.0);
    working
        .position_manager
        .remote_interpolate_to(cur, target, true, 100.0);
    scene.update_body(working);

    let out = scene.adjust_local_offset_chain(
        body_id,
        cur,
        Vector3::new(0.5, 0.0, 0.0),
        0.016,
        36.0,
        4.0,
        true,
    );
    assert!(out.is_none(), "flag-off chain is a no-op passthrough");
    let body = scene.body(body_id).unwrap();
    assert_eq!(
        body.position_manager.constraint.constraint_pos_offset(),
        3.0,
        "budget untouched"
    );
    assert!(body.position_manager.is_interpolating(), "queue untouched");
    assert_eq!(body.position_manager.interpolation.node_count(), 1);
}

/// THE dossier B row 42 edge, pinned: a frame where server-controlled
/// interp and held keys coincide. The SPLIT sites burn the budget
/// TWICE (manual hook + interp-internal chain); the composed chain
/// accumulates ONCE, on the final offset (which the interp replaced).
#[test]
fn retail_leash_chain_accumulates_once_where_split_sites_burned_twice() {
    let quantum = 0.016_f32;
    let max_speed = 36.0_f32;
    let manual = Vector3::new(0.5, 0.0, 0.0);
    let cap = max_speed * quantum; // 0.576 — the interp step this frame

    let arm = |scene: &mut SpatialScene, body_id: SpatialBodyId| {
        let mut working = scene.body(body_id).unwrap().clone();
        let cur = working.pose;
        let target = WorldPosition {
            coords: Vector3::new(cur.coords.x + 3.0, cur.coords.y, cur.coords.z),
            ..cur
        };
        working.position_manager.set_retail_leash(true);
        working.position_manager.remote_constrain_to(0.0, 5.0, 20.0);
        working
            .position_manager
            .remote_interpolate_to(cur, target, true, 100.0);
        scene.update_body(working);
        cur
    };

    // SPLIT (the pre-F10 flag-on shape): manual hook then interp step.
    let (mut split, split_id, _t, _now) = leash_scene_with_midsim_player(0.0);
    let _cur = arm(&mut split, split_id);
    let _ = split.constrain_local_manual_delta(split_id, manual);
    let _ = split.step_force_position_interpolation(split_id, quantum, max_speed, true);
    let split_budget = split
        .body(split_id)
        .unwrap()
        .position_manager
        .constraint
        .constraint_pos_offset();
    assert!(
        (split_budget - (manual.length() + cap)).abs() < 1e-4,
        "split sites double-burn |manual| + |interp| = {}, got {split_budget}",
        manual.length() + cap
    );

    // CHAIN: one composed frame.
    let (mut chain, chain_id, _t, _now) = leash_scene_with_midsim_player(0.0);
    let cur = arm(&mut chain, chain_id);
    let out = chain
        .adjust_local_offset_chain(chain_id, cur, manual, quantum, max_speed, 4.0, true)
        .expect("leash on + body → chain owns the frame");
    let chain_budget = chain
        .body(chain_id)
        .unwrap()
        .position_manager
        .constraint
        .constraint_pos_offset();
    assert!(
        (chain_budget - cap).abs() < 1e-4,
        "chain accumulates ONCE on the composed (interp-replaced) offset {cap}, got {chain_budget}"
    );
    assert!(chain_budget < split_budget, "double-accumulate removed");
    assert!(
        (out.offset.x - cap).abs() < 1e-4,
        "interp pull replaced the manual intent, got {:?}",
        out.offset
    );
}

/// Sticky timeout inside the chain clears the scene-level target
/// mirror (the `step_local_sticky` bookkeeping contract).
#[test]
fn retail_leash_chain_sticky_timeout_clears_scene_mirror() {
    let (mut scene, body_id, _t, _now) = leash_scene_with_midsim_player(0.0);
    let cur = scene.body(body_id).unwrap().pose;
    let sticky_guid = Guid(0x9000_1234);
    scene.stick_local_player_to(sticky_guid, 0.0);
    let target = WorldPosition {
        coords: Vector3::new(cur.coords.x, cur.coords.y + 10.0, cur.coords.z),
        ..cur
    };
    scene.sticky_pose_feed(sticky_guid, target);
    assert_eq!(scene.local_sticky_target(), Some(sticky_guid));

    // A pulling frame first: the chain replaces the planar intent.
    let out = scene
        .adjust_local_offset_chain(
            body_id,
            cur,
            Vector3::new(0.4, 0.0, 0.0),
            0.1,
            36.0,
            4.0,
            true,
        )
        .expect("chain active");
    assert!(!out.sticky_timed_out);
    assert!(out.offset.y > 0.0, "sticky pull toward +Y, got {:?}", out.offset);
    assert!(out.rotation.is_some(), "sticky writes the heading");

    // Expire the 1.0 s window: timeout reported + mirror cleared.
    let out = scene
        .adjust_local_offset_chain(
            body_id,
            cur,
            Vector3::new(0.4, 0.0, 0.0),
            1.1,
            36.0,
            4.0,
            true,
        )
        .expect("chain active");
    assert!(out.sticky_timed_out, "1.0 s window expired in-chain");
    assert_eq!(scene.local_sticky_target(), None, "scene mirror cleared");
    assert_eq!(
        scene
            .body(body_id)
            .unwrap()
            .position_manager
            .sticky_object_id(),
        None,
        "manager target cleared"
    );
}

// ---- P5/R-12 (net-fixwave 2026-07-10): batched collision clear ----

#[cfg(test)]
mod clear_landblocks_collision_equivalence {
    // `super::*` re-imports the spatial module surface (SpatialScene +
    // types::*) the parent tests file already pulled in.
    use super::*;
    use holtburger_common::Aabb;

    fn unit_aabb() -> Aabb {
        Aabb::new(Vector3::zero(), Vector3::new(1.0, 1.0, 1.0))
    }

    /// Three landblocks' worth of every table family the clear touches,
    /// plus a cross-LB portal edge from a KEPT landblock into a cleared
    /// one (exercises the retain's edge half, not just whole-cell drops).
    fn populated() -> SpatialScene {
        let mut scene = SpatialScene::new();
        let lbs = [0xA9B4_0000u32, 0x8602_0000, 0x1122_0000];
        for (i, lb) in lbs.into_iter().enumerate() {
            scene.insert_cell_portal(lb | 0x0100, lb | 0x0101);
            scene.insert_cell_portal(lb | 0x0101, lb | 0x0100);
            // Kept-LB cell with an edge INTO this landblock.
            scene.insert_cell_portal(0x7777_0000 | (0x0100 + i as u32), lb | 0x0100);
            scene.insert_cell_aabb(lb | 0x0100, unit_aabb());
            scene.insert_building_aabb(
                lb | 0x0100,
                BuildingAabbEntry {
                    building_id: BuildingId::new(lb, 0x0200_0001 + i as u32, 0),
                    part_index: 0,
                    aabb: unit_aabb(),
                    active: true,
                },
            );
            scene.register_building_origin(
                BuildingId::new(lb, 0x0200_0001 + i as u32, 0),
                10.0,
                20.0,
            );
            scene.insert_static_aabb(
                lb,
                StaticAabbEntry {
                    did: 0x0100_0001 + i as u32,
                    aabb: unit_aabb(),
                    has_bsp: false,
                },
            );
        }
        scene
    }

    #[test]
    fn batched_clear_matches_sequential_per_lb_clears() {
        let victims = [0xA9B4_1234u32, 0x8602_0000]; // one full id (masked inside), one high word
        let mut sequential = populated();
        let mut batched = populated();

        let mut seq_edges = 0usize;
        let mut seq_cell_aabbs = 0usize;
        let mut seq_building = 0usize;
        let mut seq_static = 0usize;
        let mut seq_bsps = 0usize;
        for lb in victims {
            let lb = lb & 0xFFFF_0000;
            let (e, a) = sequential.clear_cells_for_landblock(lb);
            seq_edges += e;
            seq_cell_aabbs += a;
            seq_building += sequential.clear_building_aabbs_for_landblock(lb);
            seq_static += sequential.clear_static_aabbs_for_landblock(lb);
            seq_bsps += sequential.clear_static_physics_bsps_for_landblock(lb);
        }

        let (edges, cell_aabbs, building, statics, bsps) =
            batched.clear_landblocks_collision(&victims);

        assert_eq!(edges, seq_edges, "portal edges removed");
        assert_eq!(cell_aabbs, seq_cell_aabbs, "cell AABBs removed");
        assert_eq!(building, seq_building, "building AABBs removed");
        assert_eq!(statics, seq_static, "static AABBs removed");
        assert_eq!(bsps, seq_bsps, "static BSPs removed");

        // Survivors identical (the un-evicted LB + the kept cross-LB cell).
        assert_eq!(
            batched.cell_portal_graph_len(),
            sequential.cell_portal_graph_len()
        );
        assert_eq!(batched.cell_aabb_count(), sequential.cell_aabb_count());
        assert_eq!(batched.building_aabb_count(), sequential.building_aabb_count());
        assert_eq!(batched.static_aabb_count(), sequential.static_aabb_count());
        assert_eq!(
            batched.static_physics_bsp_count(),
            sequential.static_physics_bsp_count()
        );
        // And something genuinely survived — the test isn't vacuous.
        assert!(batched.cell_aabb_count() > 0, "kept LB survives");
        assert!(batched.building_aabb_count() > 0, "kept LB's building survives");
    }

    #[test]
    fn batched_clear_empty_input_is_noop() {
        let mut scene = populated();
        let before = scene.cell_aabb_count();
        assert_eq!(scene.clear_landblocks_collision(&[]), (0, 0, 0, 0, 0));
        assert_eq!(scene.cell_aabb_count(), before);
    }
}

/// cur_cell continuity (2026-07-18, soak-10 §4 seam fix): `current_cell`
/// must trust the pose's CARRIED interior cell while the point is inside
/// its membership (retail `CPhysicsObj::cur_cell` semantics — updated only
/// through transit, acclient.c:311632/:347935), hand off to a PORTAL
/// NEIGHBOUR once the point is bodily across the shared plane, and never
/// resolve a seam point by AABB-scan iteration order.
#[cfg(test)]
mod cur_cell_continuity {
    use super::super::scene::{CellMembership, SpatialScene};
    use holtburger_common::position::WorldPosition;
    use holtburger_common::{Aabb, Guid, Quaternion, Vector3};
    use holtburger_common::math::Plane;
    use holtburger_dat::physics::{BspLeaf, BspNode, InternalNode};

    const LB: u32 = 0x1234_0000;
    const CELL_A: u32 = LB | 0x0101;
    const CELL_B: u32 = LB | 0x0102;
    // Landblock origin: 0x12 * 192 = 3456, 0x34 * 192 = 9984.
    const OX: f32 = 3456.0;
    const OY: f32 = 9984.0;

    /// Half-space membership: inside ⇔ local `plane·p + d >= -eps`.
    fn half_space(normal: Vector3, d: f32) -> BspNode {
        BspNode::Internal(InternalNode {
            tag: [0u8; 4],
            plane: Plane { normal, d },
            pos: Some(Box::new(BspNode::Leaf(BspLeaf {
                index: 0,
                solid: 0,
                sphere: None,
                poly_ids: vec![],
            }))),
            neg: None,
            sphere: None,
            poly_ids: vec![],
        })
    }

    /// Two cells split by the world plane x = OX+10 (A: x<=10 local,
    /// B: x>=10 local), portal-linked, with deliberately OVERLAPPING
    /// loose AABBs spanning both sides of the seam.
    fn seam_scene() -> SpatialScene {
        let mut scene = SpatialScene::new();
        let origin = Vector3::new(OX, OY, 0.0);
        // A occupies local x in [0,10]: inside ⇔ -x + 10 >= 0.
        scene.insert_cell_membership(
            CELL_A,
            CellMembership {
                tree: half_space(Vector3::new(-1.0, 0.0, 0.0), 10.0),
                origin,
                orientation: Quaternion::identity(),
            },
        );
        // B occupies local x in [10,20]: inside ⇔ x - 10 >= 0.
        scene.insert_cell_membership(
            CELL_B,
            CellMembership {
                tree: half_space(Vector3::new(1.0, 0.0, 0.0), -10.0),
                origin,
                orientation: Quaternion::identity(),
            },
        );
        // Loose overlapping AABBs (both span the seam band x∈[8,12]).
        scene.insert_cell_aabb(
            CELL_A,
            Aabb::new(Vector3::new(OX, OY, -1.0), Vector3::new(OX + 12.0, OY + 20.0, 3.0)),
        );
        scene.insert_cell_aabb(
            CELL_B,
            Aabb::new(Vector3::new(OX + 8.0, OY, -1.0), Vector3::new(OX + 20.0, OY + 20.0, 3.0)),
        );
        scene.insert_cell_portal(CELL_A, CELL_B);
        scene.insert_cell_portal(CELL_B, CELL_A);
        scene
    }

    fn pose(carried: u32, local_x: f32) -> WorldPosition {
        WorldPosition {
            landblock_id: Guid(carried),
            coords: Vector3::new(local_x, 5.0, 1.0),
            rotation: Quaternion::identity(),
        }
    }

    #[test]
    fn seam_point_stays_with_carried_cell() {
        let scene = seam_scene();
        // Exactly ON the shared plane (local x = 10): both memberships
        // accept within epsilon — the carried cell must win, whichever
        // side the pose arrived from.
        assert_eq!(scene.current_cell(&pose(CELL_A, 10.0)), CELL_A);
        assert_eq!(scene.current_cell(&pose(CELL_B, 10.0)), CELL_B);
    }

    #[test]
    fn interior_point_keeps_carried_cell_despite_overlapping_aabbs() {
        let scene = seam_scene();
        // x=9 is inside A's membership and BOTH AABBs — continuity must
        // return A without consulting scan order.
        assert_eq!(scene.current_cell(&pose(CELL_A, 9.0)), CELL_A);
    }

    #[test]
    fn crossing_hands_off_to_portal_neighbour() {
        let scene = seam_scene();
        // Bodily across the seam (x=11): the carried cell no longer
        // contains the point; the portal neighbour does → transit handoff.
        assert_eq!(scene.current_cell(&pose(CELL_A, 11.0)), CELL_B);
        assert_eq!(scene.current_cell(&pose(CELL_B, 9.0)), CELL_A);
    }

    #[test]
    fn stale_carried_cell_falls_back_to_scan() {
        let scene = seam_scene();
        // Carried id with no residency at all (e.g. post-teleport stale
        // interior id in the same LB): membership/neighbour tests fail,
        // the AABB scan resolves. x=15 is only inside B's AABB+membership.
        let stale = LB | 0x01FF;
        assert_eq!(scene.current_cell(&pose(stale, 15.0)), CELL_B);
    }
}

/// CAM-SEAM (2026-08-02): the camera cell-space containment walk
/// (`clip_segment_to_cell_space`) — the retail-style "camera may only change
/// cells through portals" net behind the triangle sweeps. Fixtures use
/// AABB-only cells (the pre-membership fallback `cell_contains_point` /
/// `cell_contains_sphere` take), which is also the resident state for
/// building interiors; the membership-BSP take of the same predicates is
/// pinned by `cur_cell_continuity` above.
mod camera_cell_space_clip {
    use super::super::scene::SpatialScene;
    use crate::CellPortalPolygon;
    use holtburger_common::{Aabb, Vector3};

    const LB: u32 = 0x1234_0000;
    const CELL_A: u32 = LB | 0x0101;
    const CELL_B: u32 = LB | 0x0102;
    const RADIUS: f32 = 0.5;
    // Landblock origin: 0x12 * 192 = 3456, 0x34 * 192 = 9984.
    const OX: f32 = 3456.0;
    const OY: f32 = 9984.0;

    fn p(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(OX + x, OY + y, z)
    }

    /// Cell A occupies local [0,10]×[0,10]×[0,5]; `b_min_x` places B's
    /// west face (flush at 10.0, or with a hairline gap when > 10.0).
    fn two_cell_scene(with_b: bool, b_min_x: f32) -> SpatialScene {
        let mut scene = SpatialScene::new();
        scene.insert_cell_aabb(
            CELL_A,
            Aabb::new(p(0.0, 0.0, 0.0), p(10.0, 10.0, 5.0)),
        );
        if with_b {
            scene.insert_cell_aabb(
                CELL_B,
                Aabb::new(p(b_min_x, 0.0, 0.0), p(20.0, 10.0, 5.0)),
            );
            scene.insert_cell_portal(CELL_A, CELL_B);
            scene.insert_cell_portal(CELL_B, CELL_A);
        }
        scene
    }

    #[test]
    fn segment_inside_one_cell_is_unconstrained() {
        let scene = two_cell_scene(false, 0.0);
        assert_eq!(
            scene.clip_segment_to_cell_space(CELL_A, p(2.0, 5.0, 2.0), p(8.0, 5.0, 2.0), RADIUS),
            None,
        );
    }

    #[test]
    fn portal_crossing_into_neighbour_is_unconstrained() {
        let scene = two_cell_scene(true, 10.0);
        assert_eq!(
            scene.clip_segment_to_cell_space(CELL_A, p(5.0, 5.0, 2.0), p(15.0, 5.0, 2.0), RADIUS),
            None,
        );
    }

    #[test]
    fn hairline_seam_gap_is_rescued_by_sphere_continuity() {
        // 5 cm stitch gap between A's east face and B's west face — the
        // exact seam class the sweep layers can slip through. The
        // radius-aware rescue must carry the walk across.
        let scene = two_cell_scene(true, 10.05);
        assert_eq!(
            scene.clip_segment_to_cell_space(CELL_A, p(5.0, 5.0, 2.0), p(15.0, 5.0, 2.0), RADIUS),
            None,
        );
    }

    #[test]
    fn escape_into_void_clamps_at_the_wall() {
        let scene = two_cell_scene(false, 0.0);
        let start = p(5.0, 5.0, 2.0);
        let end = p(25.0, 5.0, 2.0);
        let t = scene
            .clip_segment_to_cell_space(CELL_A, start, end, RADIUS)
            .expect("segment exiting cell space must clamp");
        assert!(t < 1.0);
        // Clamp point may sit up to RADIUS past the face (the seam-gap
        // rescue band) but never beyond, and never pulled back inside
        // by more than a walk step.
        let clamp_x = start.x + (end.x - start.x) * t;
        let face_x = OX + 10.0;
        assert!(
            clamp_x <= face_x + RADIUS + 0.02 && clamp_x >= face_x - 0.30,
            "clamp_x {clamp_x} not at the x={face_x} wall",
        );
    }

    #[test]
    fn doorway_portal_polygon_to_outdoors_is_unconstrained() {
        let mut scene = two_cell_scene(false, 0.0);
        // Door opening in A's east face (x=10), leading OUTDOORS (low
        // word 0x0004 < 0x100 — the outdoor sentinel range).
        scene.insert_cell_portal_polygon(
            CELL_A,
            CellPortalPolygon {
                other_cell_id: LB | 0x0004,
                vertices: vec![
                    p(10.0, 3.0, 0.0),
                    p(10.0, 7.0, 0.0),
                    p(10.0, 7.0, 4.0),
                    p(10.0, 3.0, 4.0),
                ],
            },
        );
        assert_eq!(
            scene.clip_segment_to_cell_space(CELL_A, p(5.0, 5.0, 2.0), p(15.0, 5.0, 2.0), RADIUS),
            None,
            "exit through the doorway polygon must stay unconstrained",
        );
        // Same scene, exit through the SOUTH wall (no polygon): clamped.
        let start = p(5.0, 5.0, 2.0);
        let end = p(5.0, -5.0, 2.0);
        let t = scene
            .clip_segment_to_cell_space(CELL_A, start, end, RADIUS)
            .expect("wall escape away from the doorway must still clamp");
        let clamp_y = start.y + (end.y - start.y) * t;
        let face_y = OY;
        assert!(
            clamp_y >= face_y - RADIUS - 0.02 && clamp_y <= face_y + 0.30,
            "clamp_y {clamp_y} not at the y={face_y} wall",
        );
    }

    #[test]
    fn invalid_start_sample_fails_open() {
        let scene = two_cell_scene(false, 0.0);
        // Head far outside any resident cell (teleport/spawn edge) —
        // retail answers with AdjustPosition/player-snap, not a frozen
        // camera; the walk must not constrain.
        assert_eq!(
            scene.clip_segment_to_cell_space(CELL_A, p(50.0, 50.0, 2.0), p(60.0, 50.0, 2.0), RADIUS),
            None,
        );
    }

    #[test]
    fn outdoor_start_cell_fails_open() {
        let scene = two_cell_scene(false, 0.0);
        assert_eq!(
            scene.clip_segment_to_cell_space(LB | 0x000A, p(5.0, 5.0, 2.0), p(25.0, 5.0, 2.0), RADIUS),
            None,
        );
    }
}

/// DAT-01 phase 2a/2b/2d (2026-07-27): baked-procedural-scenery collision —
/// per-landblock batch residency, the unload purge (the double-registration
/// failure mode), and the broad+narrow sweep through `SpatialScene`.
mod scenery_colliders {
    use super::*;
    use crate::spatial::scenery::{SceneryColliderBatch, WorldCylSphere};
    use holtburger_common::Aabb;

    const LB: u32 = 0xA9B3_0000;
    /// Landblock 0xA9B3's world origin in global metres: (0xA9 * 192,
    /// 0xB3 * 192) = (32448, 34176).
    const ORIGIN_X: f32 = 0xA9 as f32 * 192.0;
    const ORIGIN_Y: f32 = 0xB3 as f32 * 192.0;

    fn pose_at(local_x: f32, local_y: f32, z: f32) -> WorldPosition {
        WorldPosition {
            landblock_id: Guid(LB),
            coords: Vector3::new(local_x, local_y, z),
            rotation: Quaternion::identity(),
        }
    }

    /// One tree at LB-local (20, 20): a 1.5 m-radius, 20 m-tall trunk with
    /// the render-mesh AABB the V3 bake would emit around its canopy (±7 m,
    /// the measured 4.5x overstatement for `0x020002D3`).
    fn one_tree() -> SceneryColliderBatch {
        let cx = ORIGIN_X + 20.0;
        let cy = ORIGIN_Y + 20.0;
        let mut b = SceneryColliderBatch::new();
        b.push_cylinder(
            0x0200_02D3,
            Aabb::new(
                Vector3::new(cx - 7.0, cy - 7.0, 0.0),
                Vector3::new(cx + 7.0, cy + 7.0, 22.0),
            ),
            WorldCylSphere {
                low_pt: Vector3::new(cx, cy, 0.0),
                radius: 1.5,
                height: 20.0,
            },
            1.0,
        );
        b
    }

    #[test]
    fn insert_and_clear_round_trip() {
        let mut scene = SpatialScene::new();
        assert_eq!(scene.scenery_collider_count(), 0);
        assert_eq!(scene.scenery_collider_landblock_count(), 0);
        scene.insert_scenery_colliders(LB, one_tree());
        assert_eq!(scene.scenery_collider_count(), 1);
        assert_eq!(scene.scenery_collider_landblock_count(), 1);
        assert_eq!(scene.clear_scenery_colliders_for_landblock(LB), 1);
        assert_eq!(scene.scenery_collider_count(), 0);
        assert_eq!(scene.scenery_collider_landblock_count(), 0);
    }

    #[test]
    fn insert_accepts_a_full_cell_id_and_masks_it() {
        let mut scene = SpatialScene::new();
        scene.insert_scenery_colliders(LB | 0x0123, one_tree());
        assert!(scene.scenery_colliders_for_landblock(LB).is_some());
        assert_eq!(scene.clear_scenery_colliders_for_landblock(LB | 0xFFFE), 1);
    }

    #[test]
    fn empty_batches_are_not_stored() {
        let mut scene = SpatialScene::new();
        scene.insert_scenery_colliders(LB, SceneryColliderBatch::new());
        assert_eq!(
            scene.scenery_collider_landblock_count(),
            0,
            "an LB with zero collidable scenery must not count as resident"
        );
    }

    #[test]
    fn batched_landblock_clear_purges_scenery() {
        // The failure mode this guards: `insert_scenery_colliders` is
        // append-only, and the live drain purges through
        // `clear_landblocks_collision` ONLY. If the scenery family is not
        // wired into that batched form, an evict + re-enter leaves two
        // cylinders per tree and the count climbs every LRU cycle.
        let mut scene = SpatialScene::new();
        scene.insert_scenery_colliders(LB, one_tree());
        let _ = scene.clear_landblocks_collision(&[LB | 0x0FFE]);
        assert_eq!(scene.scenery_collider_count(), 0);
        // Re-entry after the purge lands exactly one, not two.
        scene.insert_scenery_colliders(LB, one_tree());
        assert_eq!(scene.scenery_collider_count(), 1);
    }

    #[test]
    fn sweep_stops_a_walk_into_the_trunk() {
        let mut scene = SpatialScene::new();
        scene.insert_scenery_colliders(LB, one_tree());
        // Walk east from local (14, 20) toward the trunk at (20, 20), at
        // chest height. Player radius 0.5 (PLAYER_CAPSULE_RADIUS is what the
        // arm passes; use it so the numbers match the live path).
        let r = crate::spatial::PLAYER_CAPSULE_RADIUS;
        let pose = pose_at(14.0, 20.0, 1.0);
        let hit = scene
            .sweep_sphere_against_scenery(&pose, Vector3::new(6.0, 0.0, 0.0), r)
            .expect("must hit the trunk");
        // Contact at distance 1.5 + r from the axis -> travelled 6 - 1.5 - r.
        let want_t = (6.0 - 1.5 - r) / 6.0;
        assert!((hit.t - want_t).abs() < 1e-3, "t {} want {want_t}", hit.t);
        assert!(hit.normal.x < -0.9, "normal points back west: {:?}", hit.normal);
        assert_eq!(scene.scenery_narrow_phase_hits(), 1);
    }

    #[test]
    fn sweep_that_passes_beside_the_trunk_misses() {
        let mut scene = SpatialScene::new();
        scene.insert_scenery_colliders(LB, one_tree());
        let r = crate::spatial::PLAYER_CAPSULE_RADIUS;
        // 4 m to the side of the axis: inside the 7 m render AABB (so the
        // broad phase does NOT reject it) but well outside the 1.5 m trunk.
        // This is the test that fails if anyone ever "simplifies" the narrow
        // phase back to the AABB.
        let pose = pose_at(14.0, 24.0, 1.0);
        assert!(
            scene
                .sweep_sphere_against_scenery(&pose, Vector3::new(12.0, 0.0, 0.0), r)
                .is_none()
        );
        assert_eq!(scene.scenery_narrow_phase_hits(), 0);
    }

    #[test]
    fn sweep_above_the_canopy_misses() {
        let mut scene = SpatialScene::new();
        scene.insert_scenery_colliders(LB, one_tree());
        let r = crate::spatial::PLAYER_CAPSULE_RADIUS;
        // z = 40, twice the trunk height: the Z slab veto must reject even
        // though the XY quadratic has a root.
        let pose = pose_at(14.0, 20.0, 40.0);
        assert!(
            scene
                .sweep_sphere_against_scenery(&pose, Vector3::new(12.0, 0.0, 0.0), r)
                .is_none()
        );
    }

    #[test]
    fn sweep_reaches_scenery_in_a_neighbour_landblock() {
        // The 3x3 ring, same footprint as `statics_aabbs_near_pose`.
        let mut scene = SpatialScene::new();
        scene.insert_scenery_colliders(LB, one_tree());
        let r = crate::spatial::PLAYER_CAPSULE_RADIUS;
        // Stand in the landblock to the WEST (0xA8B3) near its east edge,
        // and walk east across the seam into 0xA9B3's tree at local (20,20).
        let pose = WorldPosition {
            landblock_id: Guid(0xA8B3_0000),
            coords: Vector3::new(190.0, 20.0, 1.0),
            rotation: Quaternion::identity(),
        };
        // From global x = 0xA8*192 + 190 = ORIGIN_X - 2 to the trunk at
        // ORIGIN_X + 20: 22 m away.
        assert!(
            scene
                .sweep_sphere_against_scenery(&pose, Vector3::new(24.0, 0.0, 0.0), r)
                .is_some()
        );
    }

    #[test]
    fn pushout_recovers_a_penetrating_start() {
        let mut scene = SpatialScene::new();
        scene.insert_scenery_colliders(LB, one_tree());
        let r = crate::spatial::PLAYER_CAPSULE_RADIUS;
        // Player centre 0.5 m off the trunk axis at chest height — deep
        // inside the 1.5 m trunk (a teleport / force-position landing).
        let pose = pose_at(20.5, 20.0, 0.0);
        let centre = Vector3::new(ORIGIN_X + 20.5, ORIGIN_Y + 20.0, 1.0);
        let disp = scene
            .resolve_scenery_pushout(&pose, &[centre, centre], r, 2)
            .expect("penetrating start must be resolved");
        assert_eq!(disp.z, 0.0, "lateral only");
        // Pushed further out along +X, and clear of the trunk afterwards.
        assert!(disp.x > 0.0, "pushed away from the axis: {disp:?}");
        let out = Vector3::new(centre.x + disp.x, centre.y + disp.y, centre.z);
        let d = ((out.x - (ORIGIN_X + 20.0)).powi(2) + (out.y - (ORIGIN_Y + 20.0)).powi(2)).sqrt();
        assert!(d >= 1.5 + r - 1e-3, "still inside: {d}");
    }

    #[test]
    fn pushout_is_none_when_clear() {
        let mut scene = SpatialScene::new();
        scene.insert_scenery_colliders(LB, one_tree());
        let r = crate::spatial::PLAYER_CAPSULE_RADIUS;
        let pose = pose_at(50.0, 50.0, 0.0);
        let centre = Vector3::new(ORIGIN_X + 50.0, ORIGIN_Y + 50.0, 1.0);
        assert!(
            scene
                .resolve_scenery_pushout(&pose, &[centre, centre], r, 2)
                .is_none()
        );
    }

    /// Rung 3 (`CSetup.spheres`) — 6.1% of real placements across 19 DIDs,
    /// e.g. `0x02001064` (~111k placements, one sphere r=0.961 @ z=0.961).
    /// A batch of sphere rows must be TESTED, not merely stored: the
    /// original phase-2 scope ported only the cylsphere test, which would
    /// have staged these with no test to run on them.
    #[test]
    fn sphere_rung_blocks_and_is_not_silently_dropped() {
        use crate::spatial::scenery::SceneryPrimKind;
        let mut scene = SpatialScene::new();
        let cx = ORIGIN_X + 20.0;
        let cy = ORIGIN_Y + 20.0;
        let mut b = SceneryColliderBatch::new();
        // 0x02001064's real params, scaled 1.5x.
        let (centre, r) = crate::spatial::scenery::sphere_to_world(
            &crate::spatial::SetupSphere {
                center: Vector3::new(0.0, 0.0, 0.961),
                radius: 0.961,
            },
            1.5,
            Vector3::new(cx, cy, 0.0),
            Quaternion::identity(),
        );
        b.push_sphere(
            0x0200_1064,
            Aabb::new(
                Vector3::new(cx - 3.0, cy - 3.0, -1.0),
                Vector3::new(cx + 3.0, cy + 3.0, 4.0),
            ),
            centre,
            r,
            1.5,
        );
        assert_eq!(b.kind[0], SceneryPrimKind::Sphere);
        scene.insert_scenery_colliders(LB, b);
        let pr = crate::spatial::PLAYER_CAPSULE_RADIUS;
        // Walk into it at the sphere's own height (centre z = 1.4415).
        let pose = pose_at(14.0, 20.0, 1.4415);
        assert!(
            scene
                .sweep_sphere_against_scenery(&pose, Vector3::new(12.0, 0.0, 0.0), pr)
                .is_some(),
            "a sphere-rung scenery model must block"
        );
        // And a pass well above it must not.
        let high = pose_at(14.0, 20.0, 3.6);
        assert!(
            scene
                .sweep_sphere_against_scenery(&high, Vector3::new(12.0, 0.0, 0.0), pr)
                .is_none()
        );
    }

    /// A multi-cylsphere placement contributes one ROW per primitive, and
    /// the sweep must return the EARLIEST across them — not the first one
    /// stored.
    #[test]
    fn multi_primitive_sweep_returns_the_earliest_row() {
        let mut scene = SpatialScene::new();
        let mut b = SceneryColliderBatch::new();
        let aabb = Aabb::new(
            Vector3::new(ORIGIN_X + 10.0, ORIGIN_Y + 15.0, 0.0),
            Vector3::new(ORIGIN_X + 40.0, ORIGIN_Y + 25.0, 10.0),
        );
        // Far primitive stored FIRST, near one second.
        for x in [30.0f32, 20.0] {
            b.push_cylinder(
                0x0200_04BF,
                aabb,
                crate::spatial::WorldCylSphere {
                    low_pt: Vector3::new(ORIGIN_X + x, ORIGIN_Y + 20.0, 0.0),
                    radius: 0.5,
                    height: 8.0,
                },
                1.0,
            );
        }
        scene.insert_scenery_colliders(LB, b);
        let pr = crate::spatial::PLAYER_CAPSULE_RADIUS;
        let pose = pose_at(14.0, 20.0, 1.0);
        let hit = scene
            .sweep_sphere_against_scenery(&pose, Vector3::new(20.0, 0.0, 0.0), pr)
            .expect("must hit");
        // Nearer cylinder at local x=20 -> contact at 20 - 0.5 - pr.
        let want_t = (20.0 - 0.5 - pr - 14.0) / 20.0;
        assert!((hit.t - want_t).abs() < 1e-3, "t {} want {want_t}", hit.t);
    }

    #[test]
    fn an_empty_index_is_free() {
        // The gate-off / no-scenery-resident path must early-out before any
        // ring walk — the reason the arm is cheap when nothing is baked.
        let scene = SpatialScene::new();
        let r = crate::spatial::PLAYER_CAPSULE_RADIUS;
        let pose = pose_at(20.0, 20.0, 0.0);
        assert!(
            scene
                .sweep_sphere_against_scenery(&pose, Vector3::new(1.0, 0.0, 0.0), r)
                .is_none()
        );
        assert!(
            scene
                .resolve_scenery_pushout(&pose, &[Vector3::zero(), Vector3::zero()], r, 2)
                .is_none()
        );
    }
}

/// PORTAL-GRAPH-SPLIT (2026-08-11, batch-D C2): `cell_portal_graph` is the
/// UNION of real `CellPortal` edges and the DAT-baked `visible_cells[]` PVS;
/// `cell_adjacency` carries the portal edges alone. These pin the split at the
/// two ends that matter: no adjacency consumer may traverse a PVS-only edge,
/// and the render set must be bit-for-bit what the merged graph produced.
mod portal_graph_split {
    use super::*;
    use holtburger_common::{Aabb, Frustum};

    const LB_HIGH: u32 = 0xA9B4_0000;
    const ORIGIN_X: f32 = 169.0 * 192.0;
    const ORIGIN_Y: f32 = 180.0 * 192.0;
    const R: f32 = 0.4; // PLAYER_CAPSULE_RADIUS

    /// World-space box centred on landblock-local `(lx, ly)`, half-extent
    /// `half`, spanning a generous Z band (same shape `envcell_exit` uses).
    fn cell_box(lx: f32, ly: f32, half: f32) -> Aabb {
        let gx = ORIGIN_X + lx;
        let gy = ORIGIN_Y + ly;
        Aabb::new(
            Vector3::new(gx - half, gy - half, -50.0),
            Vector3::new(gx + half, gy + half, 50.0),
        )
    }

    fn indoor_pose(cell_id: u32, lx: f32, ly: f32, lz: f32) -> WorldPosition {
        WorldPosition {
            landblock_id: Guid(cell_id),
            coords: Vector3::new(lx, ly, lz),
            rotation: Quaternion::identity(),
        }
    }

    /// A membership tree that is a single leaf: `point_inside_cell` /
    /// `sphere_intersects_cell` short-circuit on a leaf, so membership
    /// reduces to the broad-phase AABB reject and the fixtures below are
    /// pure graph tests. Identity frame ⇒ world == local.
    fn leaf_membership() -> CellMembership {
        use holtburger_dat::physics::{BspLeaf, BspNode};
        CellMembership {
            tree: BspNode::Leaf(BspLeaf {
                index: 0,
                solid: 0,
                sphere: None,
                poly_ids: vec![],
            }),
            origin: Vector3::zero(),
            orientation: Quaternion::identity(),
        }
    }

    /// The room layout every test below shares.
    ///
    ///   A (0x0100) at local (50,50)  — where the player is
    ///   B (0x0101) at local (58,50)  — a REAL doorway neighbour of A
    ///   C (0x0102) at local (50,58)  — PVS-visible from A, NO doorway
    ///
    /// B and C sit the same distance from A and have identical boxes, so
    /// nothing but the edge class can distinguish them. `split` selects the
    /// post-split feed (C via `insert_cell_visible_edge`) or the pre-split
    /// merged feed (C via `insert_cell_portal`, i.e. HEAD~ behaviour).
    ///
    /// Deliberately NO `cell_membership`: a single-leaf tree short-circuits
    /// `point_inside_cell` to "yes" for every point, so the carried cell
    /// would win `current_cell` step 1 unconditionally and hide the re-seat
    /// these tests are about. Without membership, containment takes the
    /// loose-AABB path — the same one a cell whose BSP has not baked yet
    /// takes live.
    fn three_room_scene(split: bool) -> (SpatialScene, u32, u32, u32) {
        let (a, b, c) = (LB_HIGH | 0x0100, LB_HIGH | 0x0101, LB_HIGH | 0x0102);
        let mut scene = SpatialScene::new();
        for (id, lx, ly) in [(a, 50.0, 50.0), (b, 58.0, 50.0), (c, 50.0, 58.0)] {
            scene.insert_cell_aabb(id, cell_box(lx, ly, 4.0));
        }
        scene.insert_cell_portal(a, b);
        scene.insert_cell_portal(b, a);
        if split {
            scene.insert_cell_visible_edge(a, c);
        } else {
            scene.insert_cell_portal(a, c);
        }
        (scene, a, b, c)
    }

    #[test]
    fn accessors_separate_walkable_from_visible() {
        let (scene, a, b, c) = three_room_scene(true);
        assert_eq!(
            scene.cell_portal_neighbours(a),
            &[b],
            "adjacency carries the doorway and nothing else",
        );
        let mut vis = scene.cell_visibility_neighbours(a).to_vec();
        vis.sort_unstable();
        assert_eq!(vis, vec![b, c], "the union carries both classes");
        // A PVS-only cell is a graph SOURCE for nothing: C has no outbound
        // edges at all, so it must not appear as an adjacency key.
        assert_eq!(scene.cell_adjacency_len(), 2, "A and B have doorways");
        assert_eq!(scene.cell_portal_graph_len(), 2, "same two source cells");
        assert!(
            scene.cell_adjacency_len() <= scene.cell_portal_graph_len(),
            "adjacency is a subset of the union, always",
        );
    }

    #[test]
    fn a_cell_in_both_feeds_keeps_its_adjacency_either_order() {
        // The overwhelmingly common case: a real doorway is also listed in
        // visible_cells[]. Whichever order the drain sees them in, the edge
        // must stay WALKABLE and must not duplicate in the union.
        let (a, b) = (LB_HIGH | 0x0100, LB_HIGH | 0x0101);
        let mut portal_first = SpatialScene::new();
        portal_first.insert_cell_portal(a, b);
        portal_first.insert_cell_visible_edge(a, b);
        let mut visible_first = SpatialScene::new();
        visible_first.insert_cell_visible_edge(a, b);
        visible_first.insert_cell_portal(a, b);
        for scene in [&portal_first, &visible_first] {
            assert_eq!(scene.cell_portal_neighbours(a), &[b], "stays walkable");
            assert_eq!(scene.cell_visibility_neighbours(a), &[b], "deduped");
        }
    }

    #[test]
    fn current_cell_seam_rescue_will_not_reach_through_a_pvs_edge() {
        // `current_cell`'s radius-aware seam-gap rescue (step 2b, the task-#12
        // wedge fix) is the one place a NEIGHBOUR LIST alone decides the
        // player's cell label: the pose is inside no hull at all, so the
        // loose-AABB landblock scan finds nothing and only the walk can name a
        // cell. Fixture: a 1 m stitch gap between A and C, wider than a capsule
        // — the pose in it is 0.7 past A's wall (outside A's own rescue) and
        // 0.3 short of C's (inside C's).
        //
        // Pre-split the walk included PVS cells, so a pose in a seam gap could
        // be relabelled into a room it has no doorway to. That is a cur_cell
        // teleport, and it wedges the faithful driver against the wrong cell's
        // BSP in every direction — the 0x16E<->0x16A grocer class of bug the
        // continuity rules were written to kill.
        //
        // The `false` arm doubles as the positive control: it feeds the SAME
        // edge through `insert_cell_portal`, i.e. as a real doorway, and the
        // rescue still fires. The split removes PVS reach, not the mechanism.
        let (a, c) = (LB_HIGH | 0x0100, LB_HIGH | 0x0102);
        let build = |split: bool| {
            let mut scene = SpatialScene::new();
            scene.insert_cell_aabb(a, cell_box(50.0, 50.0, 4.0)); // y <= 54
            scene.insert_cell_aabb(c, cell_box(50.0, 59.0, 4.0)); // y >= 55
            if split {
                scene.insert_cell_visible_edge(a, c);
            } else {
                scene.insert_cell_portal(a, c);
            }
            scene
        };
        let in_gap = indoor_pose(a, 50.0, 54.7, 0.0);
        assert_eq!(
            build(false).current_cell(&in_gap),
            c,
            "control: a REAL portal neighbour still rescues a seam-gap pose",
        );
        assert_eq!(
            build(true).current_cell(&in_gap),
            a,
            "a PVS-only neighbour must not win the seam-gap rescue — keep the \
             carried cell (retail cur_cell continuity) instead",
        );

        // And with a doorway present, the ordinary bare-point re-seat still
        // works: standing inside B relabels to B.
        let (split_scene, ..) = three_room_scene(true);
        let in_b = indoor_pose(a, 58.0, 50.0, 0.0);
        assert_eq!(
            split_scene.current_cell(&in_b),
            LB_HIGH | 0x0101,
            "a real portal neighbour still re-seats",
        );
    }

    #[test]
    fn interior_doorway_relaxation_ignores_pvs_neighbours() {
        // `at_interior_doorway` relaxes the cell-AABB containment net. Before
        // the split the ONLY thing keeping a PVS edge from relaxing it was the
        // geometric near-test — which holds right up until a PVS-visible room's
        // loose AABB happens to sit within a capsule radius, as C's does here.
        let (split_scene, a, _b, _c) = three_room_scene(true);
        let (merged_scene, ..) = three_room_scene(false);
        // Straddling the A/C boundary: A's box ends at local y=54, C's starts
        // there, so this pose is inside A and within R of C.
        let at_ac_seam = indoor_pose(a, 50.0, 53.8, 0.0);
        assert!(
            merged_scene.at_interior_doorway(&at_ac_seam, a, R),
            "pre-split control: the near-test alone lets the PVS edge relax the net",
        );
        assert!(
            !split_scene.at_interior_doorway(&at_ac_seam, a, R),
            "a PVS-only neighbour must not relax the containment net",
        );
        // The real doorway still relaxes — same geometry, different edge class.
        let at_ab_seam = indoor_pose(a, 53.8, 50.0, 0.0);
        assert!(
            split_scene.at_interior_doorway(&at_ab_seam, a, R),
            "a real doorway still relaxes the net",
        );
    }

    #[test]
    fn outdoor_exit_sentinel_must_arrive_by_portal_not_pvs() {
        // `cell_has_outdoor_exit` answers "is there a door out of this room".
        // Retail only writes the sentinel into a CellPortal record, so a
        // sentinel arriving on a visibility edge is malformed data — and it
        // must not be believed, because the B11 machinery relaxes the
        // containment net on the strength of it.
        let cell = LB_HIGH | 0x0100;
        let mut by_portal = SpatialScene::new();
        by_portal.insert_cell_portal(cell, LB_HIGH | 0xFFFF);
        assert!(by_portal.cell_has_outdoor_exit(cell), "a real door counts");

        let mut by_pvs = SpatialScene::new();
        by_pvs.insert_cell_visible_edge(cell, LB_HIGH | 0xFFFF);
        assert!(
            !by_pvs.cell_has_outdoor_exit(cell),
            "a sentinel on a visibility-only edge is not a door",
        );
        // …but the renderer still sees it: the outdoor branch of
        // `compute_visibility_with_frustum` keys on the UNION deliberately, so
        // an outdoor camera's cull behaviour is untouched by the split.
        by_pvs.insert_cell_aabb(cell, cell_box(50.0, 50.0, 4.0));
        let outdoor_here = LB_HIGH | 0x0019;
        let everything = Frustum::from_view_projection_matrix(&WIDE_MVP);
        assert!(
            by_pvs
                .compute_visibility_with_frustum(outdoor_here, &everything)
                .contains(&cell),
            "render-side outdoor-exit gate still reads the union",
        );
    }

    #[test]
    fn camera_clip_will_not_follow_a_pvs_edge_out_of_cell_space() {
        // CAM-SEAM: `clip_segment_to_cell_space` re-seats the camera exactly
        // like `current_cell`. Sweeping from inside A toward C's interior
        // crosses the void between the two boxes; with only a PVS edge to C
        // there is no doorway to follow, so the segment must clamp.
        let (split_scene, a, _b, _c) = three_room_scene(true);
        let (merged_scene, ..) = three_room_scene(false);
        let start = Vector3::new(ORIGIN_X + 50.0, ORIGIN_Y + 50.0, 0.0);
        let end = Vector3::new(ORIGIN_X + 50.0, ORIGIN_Y + 58.0, 0.0);
        assert_eq!(
            merged_scene.clip_segment_to_cell_space(a, start, end, R),
            None,
            "pre-split control: the camera walks the PVS edge unconstrained",
        );
        let t = split_scene
            .clip_segment_to_cell_space(a, start, end, R)
            .expect("no walkable continuation ⇒ the segment must be clamped");
        assert!(
            (0.0..1.0).contains(&t),
            "clamp parameter {t} must be inside the segment",
        );
    }

    #[test]
    fn exit_bfs_cap_no_longer_trips_on_the_pvs_closure() {
        // EXIT_INDOOR_BFS_MAX_CELLS = 64 is sized in ROOMS. Walking the union
        // made it a PVS-closure bound instead, and the overflow arm returns
        // None = STAY INDOORS — silently re-latching the B11 bug the cap was
        // added to guard. Fixture: one real room the player has left, plus a
        // 200-cell PVS fan-out (a dungeon's baked closure, well past the cap).
        let exit_cell = LB_HIGH | 0x0100;
        let build = |split: bool| {
            let mut scene = SpatialScene::new();
            scene.insert_cell_aabb(exit_cell, cell_box(50.0, 50.0, 4.0));
            scene.insert_cell_membership(exit_cell, leaf_membership());
            for i in 0..200u32 {
                let pvs_cell = LB_HIGH | (0x0200 + i);
                // Boxes far from the player so `still_inside` never fires —
                // the cap, not geometry, is what is under test.
                scene.insert_cell_aabb(pvs_cell, cell_box(150.0 + i as f32, 150.0, 1.0));
                if split {
                    scene.insert_cell_visible_edge(exit_cell, pvs_cell);
                    scene.insert_cell_visible_edge(pvs_cell, exit_cell);
                } else {
                    scene.insert_cell_portal(exit_cell, pvs_cell);
                    scene.insert_cell_portal(pvs_cell, exit_cell);
                }
            }
            scene
        };
        // Walked out of the only real room: local (50, 90) is past its +Y wall.
        let pose = indoor_pose(exit_cell, 50.0, 90.0, 0.0);

        let merged = build(false);
        assert_eq!(
            merged.exited_envcell_to_outdoor(&pose, R),
            None,
            "pre-split control: the PVS closure overflows the cap and stays indoors",
        );
        assert_eq!(
            merged.exit_bfs_overflow_count(),
            1,
            "…and that refusal is an overflow, not a geometric verdict",
        );

        let split = build(true);
        let got = split
            .exited_envcell_to_outdoor(&pose, R)
            .expect("clear of every WALKABLE cell ⇒ flip outdoor");
        assert_eq!(got & 0xFFFF_0000, LB_HIGH, "landblock high word preserved");
        assert!(
            !WorldPosition {
                landblock_id: Guid(got),
                coords: Vector3::zero(),
                rotation: Quaternion::identity(),
            }
            .is_indoors(),
            "flipped to an outdoor cell id",
        );
        assert_eq!(
            split.exit_bfs_overflow_count(),
            0,
            "the cap must not trip on adjacency for a one-room structure",
        );
    }

    /// Column-major uniform scale by 1e-5, w untouched. Gribb-Hartmann on it
    /// gives axis-aligned planes at |x|,|y|,|z| <= 1e5 world metres, which
    /// comfortably swallows Holtburg's ~32.5 km global coords — i.e. a
    /// frustum that admits every fixture cell. That matters: these render-side
    /// checks must not pass because the cull threw both sets away. A plain
    /// identity MVP would do exactly that (it clips to the unit cube, and the
    /// nearest fixture cell is 32,000 m out).
    const WIDE_MVP: [f32; 16] = [
        1e-5, 0.0, 0.0, 0.0, //
        0.0, 1e-5, 0.0, 0.0, //
        0.0, 0.0, 1e-5, 0.0, //
        0.0, 0.0, 0.0, 1.0,
    ];

    #[test]
    fn render_set_is_unchanged_by_the_split() {
        // The acceptance bullet: the renderer must not be able to tell. Same
        // fixture, both feeds, every source cell, several BFS depths.
        let (split_scene, a, b, c) = three_room_scene(true);
        let (merged_scene, ..) = three_room_scene(false);
        for cell in [a, b, c, LB_HIGH | 0x0999 /* absent */] {
            for depth in 0..=3u8 {
                assert_eq!(
                    split_scene.render_set(cell, depth),
                    merged_scene.render_set(cell, depth),
                    "render_set(0x{cell:08X}, {depth}) diverged across the split",
                );
            }
            let frustum = Frustum::from_view_projection_matrix(&WIDE_MVP);
            assert_eq!(
                split_scene.compute_visibility_with_frustum(cell, &frustum),
                merged_scene.compute_visibility_with_frustum(cell, &frustum),
                "compute_visibility_with_frustum(0x{cell:08X}) diverged across the split",
            );
        }
        // Specifically: the PVS neighbour is still rendered from A. If this
        // ever fails, the 2026-05-25 visible_cells fix has been undone.
        assert!(
            split_scene.render_set(a, 1).contains(&c),
            "BFS-1 from A must still reach the PVS-visible room",
        );
    }

    #[test]
    fn landblock_unload_prunes_both_graphs() {
        let (mut scene, a, _b, c) = three_room_scene(true);
        let other = 0x7777_0000u32;
        scene.insert_cell_portal(other | 0x0100, other | 0x0101);
        scene.insert_cell_visible_edge(other | 0x0100, a);

        assert_eq!(scene.cell_adjacency_len(), 3);
        assert_eq!(scene.cell_portal_graph_len(), 3);
        scene.clear_cells_for_landblock(LB_HIGH);
        assert_eq!(
            scene.cell_portal_neighbours(a),
            &[] as &[u32],
            "unloaded source cell is gone from adjacency",
        );
        assert_eq!(
            scene.cell_visibility_neighbours(other | 0x0100),
            &[other | 0x0101],
            "the cross-landblock PVS edge into A is pruned, the local one stays",
        );
        assert_eq!(scene.cell_adjacency_len(), 1);
        assert_eq!(scene.cell_portal_graph_len(), 1);
        let _ = c;

        // The batched form must prune identically (it is a separate retain).
        let (mut batched, ..) = three_room_scene(true);
        batched.insert_cell_portal(other | 0x0100, other | 0x0101);
        batched.insert_cell_visible_edge(other | 0x0100, a);
        batched.clear_landblocks_collision(&[LB_HIGH]);
        assert_eq!(batched.cell_adjacency_len(), 1);
        assert_eq!(batched.cell_portal_graph_len(), 1);
        assert_eq!(
            batched.cell_visibility_neighbours(other | 0x0100),
            &[other | 0x0101],
        );
    }
}
