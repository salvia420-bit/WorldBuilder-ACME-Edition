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
        // Vertical wall at y=2, spanning x ∈ [0, 4], z ∈ [0, 4].
        // Two triangles to fill the rectangle.
        let wall_a = Triangle::new(
            Vector3::new(0.0, 2.0, 0.0),
            Vector3::new(4.0, 2.0, 0.0),
            Vector3::new(0.0, 2.0, 4.0),
        );
        let wall_b = Triangle::new(
            Vector3::new(4.0, 2.0, 0.0),
            Vector3::new(4.0, 2.0, 4.0),
            Vector3::new(0.0, 2.0, 4.0),
        );
        let walls = [wall_a, wall_b];
        // LB 0x0102 → world origin (192, 384). Player at local
        // (1, 0, 1) → world (193, 384, 1). Pushing toward +Y at
        // y=2 wall.
        let pose = WorldPosition {
            landblock_id: Guid(0x0102_0000),
            coords: Vector3::new(193.0 - 192.0, 0.0, 1.0),
            rotation: Quaternion::identity(),
        };
        // Walk +Y by 5 m. Wall is at world.y=2 (NOT the local 2 +
        // 384 — let me redo).
        // Re-pick coords so the wall is in world space:
        // Adjust the walls to world coords compatible with this LB.
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
