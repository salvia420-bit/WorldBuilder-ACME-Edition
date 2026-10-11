//! MoveTo refactor phase B (2026-10-10) — the per-object movement spine on
//! the scene: remote objects own their `MovementManager`
//! ([`SpatialScene::apply_remote_movement`]) and move by their own motion
//! ([`SpatialScene::step_remote_objects`]). Fixtures go through the real wire
//! decoder, as the movement-manager tests do.

use super::scene::RemoteCorrectionCtx;
use super::*;
use crate::motion::root_motion::test_support::{PLAYER_TABLE, player_kinematics};
use holtburger_common::position::WorldPosition;
use holtburger_common::{Guid, Quaternion, Vector3};
use holtburger_dat::file_type::MotionKinematics;
use holtburger_protocol::messages::movement::messages::motion::{
    MoveToObject, MoveToParameters, MoveToPosition, MovementInvalid, Origin, TurnToHeading,
    TurnToParameters,
};
use holtburger_protocol::messages::movement::{InterpretedMotionState, MovementStateFlags};
use holtburger_protocol::messages::{MovementEventData, MovementType, MovementTypeData};
use holtburger_protocol::traits::{ProtocolPack, ProtocolUnpack};
use std::time::Duration;
use web_time::Instant;

const MOVER: Guid = Guid(0x8000_0042);
const TARGET: Guid = Guid(0x8000_0077);
const TERRAIN_Z: f32 = 12.0;
const NONCOMBAT_LOW16: u16 = 0x3D;
const RUN_FORWARD_LOW16: u16 = 0x0007;
const WALK_FORWARD_LOW16: u16 = 0x0005;
const TURN_RIGHT_LOW16: u16 = 0x000D;
/// Retail `MovementParameters` default ctor bits (`0x1EE0F`).
const DEFAULT_BITS: u32 = 0x0001_EE0F;
const STICKY_BIT: u32 = 0x80;
const SLICE: f32 = 1.0 / 30.0;

fn at(x: f32, y: f32, heading_deg: f32) -> WorldPosition {
    WorldPosition {
        landblock_id: Guid(0x0102_0000),
        coords: Vector3::new(x, y, TERRAIN_Z),
        rotation: Quaternion::from_heading(heading_deg.to_radians()),
    }
    .normalize_outdoor_cell()
}

/// A scene with the remote driver and the spine on, flat terrain at
/// `TERRAIN_Z` and the mover's body seeded at `start`.
fn spine_scene(start: WorldPosition) -> SpatialScene {
    let mut scene = SpatialScene::new();
    scene.set_remote_interp_enabled(true);
    scene.set_remote_spine_enabled(true);
    scene.set_remote_sticky_enabled(true);
    scene.populate_terrain_heights(0x0102_0000, [TERRAIN_Z; 81]);
    seed_body(&mut scene, MOVER, start);
    scene
}

fn seed_body(scene: &mut SpatialScene, guid: Guid, pose: WorldPosition) {
    scene.reconcile_authoritative_body_with_remote(
        SpatialBodyId::Entity(guid),
        pose,
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::Snapshot,
        Instant::now(),
        Some(RemoteCorrectionCtx {
            contact: Some(true),
            player_pose: Some(pose),
        }),
    );
}

fn roundtrip(data: MovementEventData) -> MovementEventData {
    let mut buf = Vec::new();
    data.pack(&mut buf);
    let mut offset = 0;
    let decoded = MovementEventData::unpack(&buf, &mut offset).expect("fixture decodes");
    assert_eq!(decoded, data, "fixture round-trips");
    decoded
}

fn envelope(movement_type: MovementType, motion_flags: u8, data: MovementTypeData) -> MovementEventData {
    roundtrip(MovementEventData {
        guid: MOVER,
        object_instance_sequence: 1,
        movement_sequence: 2,
        server_control_sequence: 3,
        is_autonomous: false,
        movement_type,
        motion_flags,
        current_style: NONCOMBAT_LOW16,
        data,
    })
}

/// Case 0: an interpreted state with `forward` at `forward_speed` and an
/// optional TurnRight at `turn_speed`.
fn interpreted(forward: Option<(u16, f32)>, turn_speed: Option<f32>) -> MovementEventData {
    let mut flags = MovementStateFlags::empty();
    if forward.is_some() {
        flags |= MovementStateFlags::FORWARD_COMMAND | MovementStateFlags::FORWARD_SPEED;
    }
    if turn_speed.is_some() {
        flags |= MovementStateFlags::TURN_COMMAND | MovementStateFlags::TURN_SPEED;
    }
    let state = InterpretedMotionState {
        flags,
        num_commands: 0,
        current_style: None,
        forward_command: forward.map(|(command, _)| command.into()),
        sidestep_command: None,
        turn_command: turn_speed.map(|_| TURN_RIGHT_LOW16.into()),
        forward_speed: forward.map(|(_, speed)| speed),
        sidestep_speed: None,
        turn_speed,
        commands: Vec::new(),
    };
    envelope(
        MovementType::Invalid,
        0,
        MovementTypeData::Invalid(MovementInvalid {
            state,
            sticky_object: None,
        }),
    )
}

fn moveto_params(bits: u32) -> MoveToParameters {
    MoveToParameters {
        movement_parameters: bits,
        distance_to_object: 0.6,
        min_distance: 0.0,
        fail_distance: f32::MAX,
        speed: 1.0,
        walk_run_threshold: 15.0,
        desired_heading: 0.0,
    }
}

fn moveto_position(dest: WorldPosition, run_rate: f32) -> MovementEventData {
    moveto_position_at_speed(dest, run_rate, 1.0)
}

fn moveto_position_at_speed(dest: WorldPosition, run_rate: f32, speed: f32) -> MovementEventData {
    let mut params = moveto_params(DEFAULT_BITS);
    params.speed = speed;
    envelope(
        MovementType::MoveToPosition,
        0,
        MovementTypeData::MoveToPosition(MoveToPosition {
            origin: Origin {
                cell_id: dest.landblock_id,
                position: dest.coords,
            },
            params,
            run_rate,
        }),
    )
}

fn moveto_object(target: Guid, at: WorldPosition, bits: u32, run_rate: f32) -> MovementEventData {
    envelope(
        MovementType::MoveToObject,
        0,
        MovementTypeData::MoveToObject(MoveToObject {
            target,
            origin: Origin {
                cell_id: at.landblock_id,
                position: at.coords,
            },
            params: moveto_params(bits),
            run_rate,
        }),
    )
}

fn turn_to_heading(heading_deg: f32) -> MovementEventData {
    envelope(
        MovementType::TurnToHeading,
        0,
        MovementTypeData::TurnToHeading(TurnToHeading {
            params: TurnToParameters {
                movement_parameters: DEFAULT_BITS,
                speed: 1.0,
                desired_heading: heading_deg,
            },
        }),
    )
}

fn apply(scene: &mut SpatialScene, data: &MovementEventData, target_exists: bool) {
    let _ = scene.apply_remote_movement(
        MOVER,
        data,
        target_exists,
        0.5,
        1.8,
        Some(PLAYER_TABLE),
        (0.5, 1.8),
    );
}

fn pose(scene: &SpatialScene, guid: Guid) -> WorldPosition {
    scene.body(SpatialBodyId::Entity(guid)).expect("body").pose
}

fn planar_distance(a: &WorldPosition, b: &WorldPosition) -> f32 {
    let d = a.global_coords() - b.global_coords();
    (d.x * d.x + d.y * d.y).sqrt()
}

fn heading_deg(pose: &WorldPosition) -> f32 {
    pose.rotation.to_heading().to_degrees().rem_euclid(360.0)
}

fn heading_error(a: f32, b: f32) -> f32 {
    let mut err = (a - b).rem_euclid(360.0);
    if err > 180.0 {
        err -= 360.0;
    }
    err.abs()
}

/// Steps `slices` slices of `SLICE` with the clock advancing.
fn run(scene: &mut SpatialScene, kinematics: &MotionKinematics, t0: Instant, from: usize, slices: usize) {
    for i in from..from + slices {
        let now = t0 + Duration::from_secs_f32(i as f32 * SLICE);
        scene.step_remote_objects(SLICE, Some(kinematics), now);
    }
}

/// The interpreted state moves the body by the object's OWN motion table:
/// a walk travels at the table's 2.6017 m/s (the retail capture's
/// ~2.55 m/s, not the 3.12 `WalkAnimSpeed`), a run at 4.0 × its speed,
/// along the body's facing and on the terrain; the row is exported.
#[test]
fn spine_moves_a_remote_by_its_motion_table() {
    let kinematics = player_kinematics();
    for (command, speed, expected) in [
        (WALK_FORWARD_LOW16, 1.0f32, 2.6017f32),
        (RUN_FORWARD_LOW16, 1.5, 6.0),
    ] {
        let start = at(50.0, 50.0, 90.0);
        let mut scene = spine_scene(start);
        apply(&mut scene, &interpreted(Some((command, speed)), None), false);
        let _ = scene.take_remote_stepped_poses();
        run(&mut scene, &kinematics, Instant::now(), 0, 30);
        let after = pose(&scene, MOVER);
        let moved = planar_distance(&after, &start);
        assert!((moved - expected).abs() < 0.02, "command 0x{command:04X}: moved {moved} m in 1 s, want {expected}");
        let delta = after.global_coords() - start.global_coords();
        assert!(delta.y > 0.99 * moved, "along the facing (north): {delta:?}");
        assert!((after.coords.z - TERRAIN_Z).abs() < 1e-3, "on the terrain");
        assert!(
            scene.take_remote_stepped_poses().iter().any(|(guid, _)| *guid == MOVER),
            "the moved body is exported"
        );
    }
}

/// A TurnRight in the interpreted state turns the body at the table's
/// TurnRight omega × the turn speed (clockwise: heading increasing).
#[test]
fn spine_turns_a_remote_at_its_table_turn_rate() {
    let kinematics = player_kinematics();
    let start = at(50.0, 50.0, 90.0);
    let mut scene = spine_scene(start);
    apply(&mut scene, &interpreted(None, Some(1.0)), false);
    run(&mut scene, &kinematics, Instant::now(), 0, 15);
    let turned = heading_deg(&pose(&scene, MOVER)) - 90.0;
    let expected = (1.5f32 * 0.5).to_degrees();
    assert!((turned - expected).abs() < 0.2, "turned {turned}° in 0.5 s, want {expected}°");
    assert!(planar_distance(&pose(&scene, MOVER), &start) < 1e-4, "a turn in place does not travel");
}

/// A MoveToPosition runs entirely on the mover's own manager: the TurnRight
/// node turns the body until `HandleTurnToHeading` sees the overshoot and
/// snaps it, the RunForward node runs it along its facing, and the arrival
/// stops it at the destination. The node motions reach the phase-edge
/// channel in order, ending with `0` (Ready).
#[test]
fn spine_moveto_position_turns_runs_and_arrives() {
    let kinematics = player_kinematics();
    let start = at(50.0, 50.0, 90.0);
    let dest = at(70.0, 50.0, 0.0);
    let mut scene = spine_scene(start);
    apply(&mut scene, &moveto_position(dest, 1.0), false);
    let mover = scene.remote_mover(MOVER).expect("the message created the mover");
    assert!(mover.movement.is_moveto_active());
    assert!(scene.body(SpatialBodyId::Entity(MOVER)).unwrap().remote_moving_to, "IsMovingTo() → keep_heading");

    let t0 = Instant::now();
    let mut phases = Vec::new();
    let mut arrived_at = None;
    for i in 0..360 {
        run(&mut scene, &kinematics, t0, i, 1);
        phases.extend(scene.take_remote_moveto_phase_changes());
        if !scene.remote_mover(MOVER).unwrap().movement.is_moveto_active() {
            arrived_at = Some(i);
            break;
        }
    }
    let arrived_at = arrived_at.expect("the MoveTo completed within 12 s");
    let end = pose(&scene, MOVER);
    // UseSpheres: arrival is measured from the mover's EDGE
    // (`GetCurrentDistance` cylinder metric, acclient.c:344856-344893), so
    // distance_to_object 0.6 + its own 0.5 radius stops it ~1.1 m short.
    let gap = planar_distance(&end, &dest);
    assert!((0.9..1.2).contains(&gap), "arrived at the edge distance: {gap} m ({:?})", end.coords);
    assert!(heading_error(heading_deg(&end), 180.0) < 10.0, "facing east: {}", heading_deg(&end));
    // ~0.7 s of turn + 19.4 m at 4 m/s.
    let seconds = arrived_at as f32 * SLICE;
    assert!((4.0..8.0).contains(&seconds), "run at the table's 4 m/s: arrived after {seconds} s");
    assert!(!scene.body(SpatialBodyId::Entity(MOVER)).unwrap().remote_moving_to);
    let motions: Vec<u32> = phases.iter().filter(|(guid, _)| *guid == MOVER).map(|(_, m)| *m).collect();
    assert_eq!(motions.first(), Some(&0x6500_000D), "TurnRight first: {motions:X?}");
    assert!(motions.contains(&0x4400_0007), "then RunForward: {motions:X?}");
    assert_eq!(motions.last(), Some(&0), "Ready on arrival: {motions:X?}");
}

/// A TurnToHeading turns the body by its motion (no wire snap) and lands
/// exactly on the heading through the arrival snap.
#[test]
fn spine_turn_to_heading_turns_then_lands_on_the_heading() {
    let kinematics = player_kinematics();
    let start = at(50.0, 50.0, 90.0);
    let mut scene = spine_scene(start);
    apply(&mut scene, &turn_to_heading(180.0), false);
    let t0 = Instant::now();
    run(&mut scene, &kinematics, t0, 0, 3);
    let early = heading_deg(&pose(&scene, MOVER));
    assert!(early > 90.5 && early < 120.0, "turning, not snapped: {early}°");
    for i in 3..120 {
        run(&mut scene, &kinematics, t0, i, 1);
        if !scene.remote_mover(MOVER).unwrap().movement.is_moveto_active() {
            break;
        }
    }
    assert!(!scene.remote_mover(MOVER).unwrap().movement.is_moveto_active(), "the turn completed");
    let end = heading_deg(&pose(&scene, MOVER));
    assert!(heading_error(end, 180.0) < 0.01, "snapped onto the heading: {end}°");
    assert!(planar_distance(&pose(&scene, MOVER), &start) < 1e-4);
}

/// A sticky-bit MoveToObject chases the target's live body and sticks to it
/// on arrival (`BeginNextNode` → `PositionManager::StickTo`), not at arm time.
#[test]
fn spine_sticky_chase_sticks_on_arrival() {
    let kinematics = player_kinematics();
    let start = at(50.0, 50.0, 90.0);
    let target_pose = at(50.0, 56.0, 270.0);
    let mut scene = spine_scene(start);
    seed_body(&mut scene, TARGET, target_pose);
    apply(&mut scene, &moveto_object(TARGET, target_pose, DEFAULT_BITS | STICKY_BIT, 1.0), true);
    assert_eq!(scene.remote_sticky_target(MOVER), None, "no stick at arm time");
    let t0 = Instant::now();
    for i in 0..240 {
        run(&mut scene, &kinematics, t0, i, 1);
        if scene.remote_sticky_target(MOVER).is_some() {
            break;
        }
    }
    assert_eq!(scene.remote_sticky_target(MOVER), Some(TARGET), "stuck on arrival");
    let gap = planar_distance(&pose(&scene, MOVER), &target_pose);
    assert!(gap < 2.0, "closed on the target: {gap} m");
    assert!(!scene.remote_mover(MOVER).unwrap().movement.is_moveto_active());
}

/// A MoveToObject whose target left the world cancels (retail 0x37,
/// acclient.c:346086) instead of steering at a stale pose.
#[test]
fn spine_moveto_cancels_when_the_target_leaves() {
    let kinematics = player_kinematics();
    let start = at(50.0, 50.0, 90.0);
    let target_pose = at(50.0, 70.0, 270.0);
    let mut scene = spine_scene(start);
    seed_body(&mut scene, TARGET, target_pose);
    apply(&mut scene, &moveto_object(TARGET, target_pose, DEFAULT_BITS, 1.0), true);
    let t0 = Instant::now();
    run(&mut scene, &kinematics, t0, 0, 5);
    assert!(scene.remote_mover(MOVER).unwrap().movement.is_moveto_active(), "chasing");
    let _ = scene.retire_authoritative_body(SpatialBodyId::Entity(TARGET));
    run(&mut scene, &kinematics, t0, 5, 1);
    assert!(!scene.remote_mover(MOVER).unwrap().movement.is_moveto_active(), "cancelled");
    assert!(!scene.body(SpatialBodyId::Entity(MOVER)).unwrap().remote_moving_to);
}

/// The MoveTo envelope's run rate is the mover's `my_run_rate` (retail
/// acclient.c:339571) — the body's catch-up speed reads it.
#[test]
fn spine_moveto_latches_the_run_rate_on_the_body() {
    let start = at(50.0, 50.0, 90.0);
    let mut scene = spine_scene(start);
    apply(&mut scene, &moveto_position(at(70.0, 50.0, 0.0), 2.0), false);
    let body = scene.body(SpatialBodyId::Entity(MOVER)).unwrap();
    assert_eq!(body.my_run_rate, 2.0);
    assert!(body.remote_moving_to);
}

/// `?remoteSpine=off`: the step is the legacy one (the body's own wire
/// motion state at the `get_state_velocity` constants) and the movers are
/// dropped.
#[test]
fn spine_off_is_the_legacy_step() {
    let kinematics = player_kinematics();
    let start = at(50.0, 50.0, 90.0);
    let mut scene = spine_scene(start);
    apply(&mut scene, &interpreted(Some((WALK_FORWARD_LOW16, 1.0)), None), false);
    scene.set_remote_spine_enabled(false);
    assert!(scene.remote_mover(MOVER).is_none(), "movers dropped with the switch");
    run(&mut scene, &kinematics, Instant::now(), 0, 30);
    assert_eq!(pose(&scene, MOVER), start, "no wire motion state on the body: the legacy lane holds");
}

/// Movers of objects the world dropped are released.
#[test]
fn prune_drops_movers_of_departed_objects() {
    let start = at(50.0, 50.0, 90.0);
    let mut scene = spine_scene(start);
    apply(&mut scene, &interpreted(Some((RUN_FORWARD_LOW16, 1.0)), None), false);
    assert!(scene.remote_mover(MOVER).is_some());
    scene.prune_remote_movers(|guid| guid != MOVER);
    assert!(scene.remote_mover(MOVER).is_none());
}

/// MoveTo refactor phase E: each node-motion edge carries the speed the rig
/// plays it at — the mover's interpreted speed after `adjust_motion`. A
/// charge (`params.speed` 1.5, run rate 2.0) runs its cycle at 3.0. The turn
/// node's HoldKey_Invalid resolves against the REMOTE interp's own hold key
/// (no run key is held for a remote), so it turns at `params.speed` only.
#[test]
fn spine_phase_edges_carry_the_node_speed() {
    let kinematics = player_kinematics();
    let start = at(50.0, 50.0, 90.0);
    let mut scene = spine_scene(start);
    apply(&mut scene, &moveto_position_at_speed(at(80.0, 50.0, 0.0), 2.0, 1.5), false);
    let t0 = Instant::now();
    let mut edges = Vec::new();
    for i in 0..90 {
        run(&mut scene, &kinematics, t0, i, 1);
        edges.extend(scene.take_remote_moveto_phase_changes_with_speed());
        if edges.iter().any(|&(_, m, _)| m == 0x4400_0007) {
            break;
        }
    }
    let turn = edges.iter().find(|&&(_, m, _)| m == 0x6500_000D).expect("a TurnRight edge");
    assert!((turn.2 - 1.5).abs() < 1e-4, "turn edge speed {}", turn.2);
    let run_edge = edges.iter().find(|&&(_, m, _)| m == 0x4400_0007).expect("a RunForward edge");
    assert!((run_edge.2 - 1.5 * 2.0).abs() < 1e-4, "run edge speed {}", run_edge.2);
}

/// MoveTo refactor phase G: with `?targetVoyeur` the chase steers at what
/// the target REPORTS — its first answer at once, then an update only when it
/// moved past 0.5 m, at most every 0.5 s — and the registration ends with
/// the MoveTo.
#[test]
fn spine_moveto_tracks_the_target_through_the_voyeur() {
    let kinematics = player_kinematics();
    let start = at(50.0, 50.0, 90.0);
    let target_pose = at(50.0, 80.0, 270.0);
    let mut scene = spine_scene(start);
    scene.set_target_voyeur_enabled(true);
    seed_body(&mut scene, TARGET, target_pose);
    apply(&mut scene, &moveto_object(TARGET, target_pose, DEFAULT_BITS, 1.0), true);
    let t0 = Instant::now();
    run(&mut scene, &kinematics, t0, 0, 1);
    let reported = |scene: &SpatialScene| {
        scene
            .remote_mover(MOVER)
            .and_then(|m| m.voyeur.as_ref())
            .and_then(|v| v.reported())
    };
    assert_eq!(reported(&scene).map(|p| p.coords), Some(target_pose.coords), "first answer at once");

    // The target sidesteps 0.3 m: inside the radius, never reported.
    scene.body_mut(SpatialBodyId::Entity(TARGET)).unwrap().pose.coords.x += 0.3;
    run(&mut scene, &kinematics, t0, 1, 30);
    assert_eq!(reported(&scene).map(|p| p.coords), Some(target_pose.coords));

    // Another 0.6 m (0.9 m total): reported at the next 0.5 s pass.
    scene.body_mut(SpatialBodyId::Entity(TARGET)).unwrap().pose.coords.x += 0.6;
    run(&mut scene, &kinematics, t0, 31, 16);
    let moved = reported(&scene).expect("reported").coords;
    assert!((moved.x - (target_pose.coords.x + 0.9)).abs() < 1e-3, "{moved:?}");

    // Off: the registration is dropped and the live pose drives.
    scene.set_target_voyeur_enabled(false);
    run(&mut scene, &kinematics, t0, 47, 1);
    assert!(scene.remote_mover(MOVER).unwrap().voyeur.is_none());
}
