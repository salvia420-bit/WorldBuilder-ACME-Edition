//! LANDING-BOUNCE (2026-10-11, `?landingBounce`) — owner: "when i fall after
//! a jump i should be bouncing a bit".
//!
//! Retail lands in two quanta. The landing quantum's
//! `CPhysicsObj::handle_all_collisions` (acclient.c:321808) reflects the
//! velocity off the contact normal, `v -= (1 + elasticity)(v·n)n`
//! (:321872-321886; elasticity `DEFAULT_ELASTICITY` 0.05, :40378). On the next
//! quantum `calc_friction` leaves a normal velocity of at least 0.25 m/s alone
//! (:316140), `check_contact` drops CONTACT for a body moving away from its
//! plane (:316536), and `LeaveGround` (:344457) re-launches it with
//! `get_leave_ground_velocity` (:343806): the motion state's velocity with
//! z = 0, or — standing still — the physics velocity, bounce included.
//!
//! These drive the REAL manual-slice integrator over scene-resident terrain
//! (the faithful outdoor driver, the live path). The native const
//! `USE_LANDING_BOUNCE` stays off (carrier split); each case installs the
//! browser default with `set_landing_bounce(true)`.
#![cfg(test)]

use super::system::{MovementSystem, retail_elasticity, retail_landing_bounce};
use crate::client::movement_types::MotionState;
use holtburger_common::position::WorldPosition;
use holtburger_common::{Guid, Quaternion, Vector3};
use holtburger_protocol::messages::movement::MotionStance;
use holtburger_world::{
    PlayerMotionTableSource, SelfMovementCapabilities, SelfMovementKinematics, WorldState,
};
use std::time::Duration;

const TERRAIN_Z: f32 = 10.0;
/// One full `MAX_QUANTUM` slice per call (a sub-`MIN_QUANTUM` dt is banked
/// and integrates nothing — see the system tests' `quantum_slices` notes).
const SLICE: Duration = Duration::from_millis(100);

fn capabilities() -> SelfMovementCapabilities {
    SelfMovementCapabilities {
        kinematics: SelfMovementKinematics {
            source: PlayerMotionTableSource::DirectProperty {
                motion_table_id: 0x0900_0020,
            },
            motion_table_id: 0x0900_0020,
            stance: MotionStance::NonCombat as u32,
            base_walk_forward_velocity: Vector3::new(1.0, 0.0, 0.0),
            base_run_forward_velocity: Vector3::new(4.5, 0.0, 0.0),
            base_turn_left_omega: Vector3::new(0.0, 0.0, -1.5),
            base_turn_right_omega: Vector3::new(0.0, 0.0, 1.5),
        },
        run_rate_scalar: 1.0,
    }
}

/// A player falling onto flat scene-resident terrain at `TERRAIN_Z`, `hover`
/// metres above it, moving down at `vz` with `state` held.
fn falling_player(
    guid: Guid,
    vz: f32,
    state: MotionState,
    bounce: bool,
) -> (WorldState, MovementSystem) {
    let mut world = WorldState::synthetic();
    world.player.guid = guid;
    world.set_self_movement_capabilities_override(capabilities());
    let pose = WorldPosition {
        landblock_id: Guid(0xA9B4_0001),
        coords: Vector3::new(100.0, 100.0, TERRAIN_Z + 0.05),
        rotation: Quaternion::identity(),
    };
    world.seed_local_player_entity(guid, "Player", pose);
    let _ = world.set_player_position(pose);
    world.populate_terrain_heights_scene_resident(0xA9B4_0000, [TERRAIN_Z; 81]);
    assert!(
        world.scene.terrain_landblock_resident(0xA9B4_0001),
        "the fixture must ride the faithful outdoor driver (the live path)"
    );
    world.player.begin_fall();
    world.player.vertical_velocity = vz;
    let mut movement = MovementSystem::new();
    movement.set_active_manual_drive_for_test(state);
    movement.set_landing_bounce(bounce);
    (world, movement)
}

fn z(world: &WorldState) -> f32 {
    world
        .local_player_runtime_pose()
        .expect("runtime pose")
        .coords
        .z
}

/// The pure collision response: the normal part reflects with
/// `1 + elasticity`, the tangential part is untouched, and a velocity that
/// is not moving INTO the surface is left alone (acclient.c:321872-321886).
#[test]
fn landing_bounce_reflects_the_normal_part_with_elasticity() {
    let up = Vector3::new(0.0, 0.0, 1.0);
    let v = retail_landing_bounce(Vector3::new(0.0, 4.0, -8.0), up, 0.05);
    assert!(
        (v.x - 0.0).abs() < 1e-6 && (v.y - 4.0).abs() < 1e-6,
        "tangential kept: {v:?}"
    );
    assert!((v.z - 0.4).abs() < 1e-5, "normal part = 0.05 x 8: {v:?}");
    let away = Vector3::new(1.0, 0.0, 0.3);
    assert_eq!(
        retail_landing_bounce(away, up, 0.05),
        away,
        "moving away: untouched"
    );
    // A tilted plane: the reflected normal speed is e x the impact's.
    let n = Vector3::new(0.0, 0.6, 0.8);
    let impact = Vector3::new(0.0, -3.0, -6.0);
    let vn = impact.dot(&n);
    let out = retail_landing_bounce(impact, n, 0.1);
    assert!(
        (out.dot(&n) - (-vn * 0.1)).abs() < 1e-5,
        "slope bounce normal speed: {out:?}"
    );
}

/// `CPhysicsObj::set_elasticity` (acclient.c:317061-317083): `< 0` → 0,
/// `> 0.1` → 0.1; no wire value → `DEFAULT_ELASTICITY` 0.05 (:40378).
#[test]
fn elasticity_follows_retail_set_elasticity_clamp() {
    assert_eq!(retail_elasticity(None), 0.05);
    assert_eq!(retail_elasticity(Some(0.07)), 0.07);
    assert_eq!(retail_elasticity(Some(0.5)), 0.1);
    assert_eq!(retail_elasticity(Some(-1.0)), 0.0);
    assert_eq!(retail_elasticity(Some(f64::NAN)), 0.0);
}

/// A hard STANDING landing (8 m/s, a full jump) bounces: the landing slice
/// lands (HitGround) with the bounce pending, the next slice lifts the body
/// off and keeps the bounce velocity (standing: `get_leave_ground_velocity`
/// falls back to the physics velocity), and it comes down again without a
/// second lift-off (0.05 x a sub-5 m/s impact < 0.25).
#[test]
fn hard_standing_landing_hops_once_and_settles() {
    let (mut world, movement) =
        falling_player(Guid(0x5000_0B01), -8.0, MotionState::default(), true);

    movement.advance_local_pose_for_manual_drive(&mut world, SLICE);
    assert!(!world.player.is_airborne, "the 8 m/s fall lands this slice");
    let pending = world
        .player
        .landing_bounce
        .expect("a 0.05 x ~9 m/s bounce survives (>= 0.25)");
    let b = pending.normal_speed();
    assert!(
        b > 0.25 && b < 0.6,
        "bounce normal speed = 0.05 x impact: {b:.3}"
    );
    assert!(
        (z(&world) - TERRAIN_Z).abs() < 0.02,
        "planted on the terrain: z={:.3}",
        z(&world)
    );
    assert_eq!(
        world.player.vertical_velocity, 0.0,
        "land() ran (HitGround)"
    );

    movement.advance_local_pose_for_manual_drive(&mut world, SLICE);
    assert!(
        world.player.is_airborne,
        "the lift-off quantum leaves the ground"
    );
    assert!(
        world.player.landing_bounce.is_none(),
        "the bounce was consumed"
    );
    assert!(
        (world.player.vertical_velocity - pending.velocity.z).abs() < 1e-4,
        "standing: the bounce velocity carries into the hop ({:.3} vs {:.3})",
        world.player.vertical_velocity,
        pending.velocity.z
    );
    let lifted = z(&world);
    assert!(
        lifted > TERRAIN_Z + 0.02,
        "the body rose off the ground: z={lifted:.3}"
    );

    let mut landed = false;
    for _ in 0..6 {
        movement.advance_local_pose_for_manual_drive(&mut world, SLICE);
        if !world.player.is_airborne {
            landed = true;
            break;
        }
    }
    assert!(landed, "the hop comes back down");
    assert!(
        world.player.landing_bounce.is_none(),
        "the second, soft landing does not lift again"
    );
    assert!(
        (z(&world) - TERRAIN_Z).abs() < 0.02,
        "back on the terrain: z={:.3}",
        z(&world)
    );
}

/// A hard landing while RUNNING lifts off too, but `get_leave_ground_velocity`
/// takes the motion state's velocity with z = 0 (:343806-343820): no vertical
/// bounce survives the lift-off, the body is down again a slice later.
#[test]
fn hard_running_landing_leaves_the_ground_for_a_quantum_without_vertical_bounce() {
    let run = MotionState::builder().run().forward().build();
    let (mut world, movement) = falling_player(Guid(0x5000_0B02), -8.0, run, true);
    world.player.current_planar_velocity = Vector3::new(4.5, 0.0, 0.0);

    movement.advance_local_pose_for_manual_drive(&mut world, SLICE);
    assert!(!world.player.is_airborne);
    assert!(
        world.player.landing_bounce.is_some(),
        "the bounce survives the landing"
    );

    movement.advance_local_pose_for_manual_drive(&mut world, SLICE);
    assert!(world.player.is_airborne, "lift-off");
    assert_eq!(
        world.player.vertical_velocity, 0.0,
        "moving: the leave-ground velocity has z = 0"
    );
    let planar = world.player.current_planar_velocity;
    assert!(
        planar.x * planar.x + planar.y * planar.y > 1.0,
        "moving: the leave-ground velocity is the run state's: {planar:?}"
    );

    let mut slices = 0;
    while world.player.is_airborne && slices < 4 {
        movement.advance_local_pose_for_manual_drive(&mut world, SLICE);
        slices += 1;
    }
    assert!(!world.player.is_airborne, "down again within a few slices");
    assert!(world.player.landing_bounce.is_none());
}

/// A soft landing (2 m/s: 0.05 x ~3 m/s < 0.25) does not lift off — the
/// next quantum's friction projects the bounce out, as before.
#[test]
fn soft_landing_does_not_lift_off() {
    let (mut world, movement) =
        falling_player(Guid(0x5000_0B03), -2.0, MotionState::default(), true);
    movement.advance_local_pose_for_manual_drive(&mut world, SLICE);
    assert!(!world.player.is_airborne);
    assert!(
        world.player.landing_bounce.is_none(),
        "below the 0.25 m/s friction cutoff"
    );
    movement.advance_local_pose_for_manual_drive(&mut world, SLICE);
    assert!(!world.player.is_airborne, "stays planted");
}

/// `?landingBounce=off`: the hard landing stops dead (pre-2026-10-11).
#[test]
fn landing_bounce_off_stops_dead() {
    let (mut world, movement) =
        falling_player(Guid(0x5000_0B04), -8.0, MotionState::default(), false);
    movement.advance_local_pose_for_manual_drive(&mut world, SLICE);
    assert!(!world.player.is_airborne);
    assert!(world.player.landing_bounce.is_none());
    movement.advance_local_pose_for_manual_drive(&mut world, SLICE);
    assert!(!world.player.is_airborne, "no lift-off with the escape set");
    assert!((z(&world) - TERRAIN_Z).abs() < 0.02);
}

/// A jump pressed on the bounce quantum replaces the pending lift-off
/// (`begin_jump` clears it), and a teleport/landing reset clears it too.
#[test]
fn jump_or_land_clears_a_pending_bounce() {
    let (mut world, movement) =
        falling_player(Guid(0x5000_0B05), -8.0, MotionState::default(), true);
    movement.advance_local_pose_for_manual_drive(&mut world, SLICE);
    assert!(world.player.landing_bounce.is_some());
    world.player.begin_jump(5.0);
    assert!(
        world.player.landing_bounce.is_none(),
        "begin_jump drops the bounce"
    );
    world.player.land();
    world.player.landing_bounce = Some(holtburger_world::player::LandingBounce {
        velocity: Vector3::new(0.0, 0.0, 0.4),
        normal: Vector3::new(0.0, 0.0, 1.0),
    });
    world.player.land();
    assert!(
        world.player.landing_bounce.is_none(),
        "land() (teleports route through it) drops it"
    );
}
