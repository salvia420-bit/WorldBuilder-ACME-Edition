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
    TurnToObject, TurnToParameters,
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

/// The local player in the NPC-facing tests.
const PLAYER: Guid = Guid(0x5000_0001);

/// ACE's `Creature.Rotate` broadcast (`Creature_Navigation.cs` `TurnToObject`
/// → `Motion(wo, target, TurnToObject)`): case 8 at `target`; `packed` is the
/// TurnToObject's own heading (ACE: always 0) and the TurnToParameters come
/// from ACE's `MoveToParameters` defaults (speed 1, offset 0).
fn turn_to_object(target: Guid, packed: f32) -> MovementEventData {
    envelope(
        MovementType::TurnToObject,
        0,
        MovementTypeData::TurnToObject(TurnToObject {
            target,
            desired_heading: packed,
            params: TurnToParameters {
                movement_parameters: DEFAULT_BITS,
                speed: 1.0,
                desired_heading: 0.0,
            },
        }),
    )
}

/// The local player's body — where the spine resolves a target that is the
/// local player (`resolve_remote_sticky_target_pose`).
fn seed_local_player(scene: &mut SpatialScene, pose: WorldPosition) {
    let _ = scene.register_body(SpatialBody::new(
        SpatialBodyId::LocalPlayer(PLAYER),
        pose,
        Instant::now(),
    ));
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
/// exactly on the heading through the arrival snap. The wire heading is
/// retail's compass (NPC-facing fix 2026-10-11): wire 90 is EAST, pose 180
/// (`at`'s headings are pose degrees: 90 = north). This used to send wire 180
/// and expect pose 180, i.e. it read the wire as pose and the body ended
/// facing east for an ACE "face south" — the 90° NPC error.
#[test]
fn spine_turn_to_heading_turns_then_lands_on_the_heading() {
    let kinematics = player_kinematics();
    let start = at(50.0, 50.0, 90.0);
    let mut scene = spine_scene(start);
    apply(&mut scene, &turn_to_heading(90.0), false);
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

/// NPC-facing fix (2026-10-11): ACE's `Creature.Rotate` — a TurnToObject at
/// the LOCAL player, packed heading 0 — turns an NPC facing north toward the
/// player wherever the player stands, by its own TurnRight / TurnLeft
/// (the short way, `BeginTurnToHeading` acclient.c:345456), and the arrival
/// snap lands it on the bearing; a player across the landblock edge included
/// (the bearing is taken in global coordinates).
#[test]
fn spine_npc_turns_to_face_the_local_player() {
    const TURN_RIGHT: u32 = 0x6500_000D;
    const TURN_LEFT: u32 = 0x6500_000E;
    let kinematics = player_kinematics();
    let npc = at(180.0, 96.0, 90.0);
    // 18 m east and 14 m north of the NPC, in landblock 0x0202.
    let across_edge = WorldPosition {
        landblock_id: Guid(0x0202_0000),
        coords: Vector3::new(6.0, 110.0, TERRAIN_Z),
        rotation: Quaternion::identity(),
    }
    .normalize_outdoor_cell();
    // Pose degrees (90 = north); the edge case's compass bearing is
    // atan2(18, 14) = 52.1°. Due south is 180° either way: either turn.
    let across_bearing = 90.0 + 18.0f32.atan2(14.0).to_degrees();
    for (label, player, bearing, first_motion) in [
        ("east", at(186.0, 96.0, 0.0), 180.0f32, Some(TURN_RIGHT)),
        ("south", at(180.0, 90.0, 0.0), 270.0, None),
        ("west", at(174.0, 96.0, 0.0), 0.0, Some(TURN_LEFT)),
        ("north-east", at(186.0, 102.0, 0.0), 135.0, Some(TURN_RIGHT)),
        ("across the landblock edge", across_edge, across_bearing, Some(TURN_RIGHT)),
    ] {
        let mut scene = spine_scene(npc);
        seed_local_player(&mut scene, player);
        apply(&mut scene, &turn_to_object(PLAYER, 0.0), true);
        assert_eq!(
            scene.remote_mover(MOVER).unwrap().movement.moveto_directive_target(),
            Some(PLAYER),
            "{label}: a TurnToObject at the player"
        );
        let t0 = Instant::now();
        let mut motions = Vec::new();
        let mut done = false;
        for i in 0..90 {
            motions.extend(scene.take_remote_moveto_phase_changes());
            run(&mut scene, &kinematics, t0, i, 1);
            if !scene.remote_mover(MOVER).unwrap().movement.is_moveto_active() {
                done = true;
                break;
            }
        }
        assert!(done, "{label}: the turn completed within 3 s");
        let end = heading_deg(&pose(&scene, MOVER));
        assert!(
            heading_error(end, bearing) < 0.01,
            "{label}: faces the player at {bearing}°, got {end}°"
        );
        let first = motions.iter().find(|(guid, _)| *guid == MOVER).map(|(_, m)| *m);
        match first_motion {
            Some(expected) => {
                assert_eq!(first, Some(expected), "{label}: turns the short way: {motions:X?}")
            }
            None => assert!(
                matches!(first, Some(TURN_RIGHT | TURN_LEFT)),
                "{label}: turns: {motions:X?}"
            ),
        }
        assert!(planar_distance(&pose(&scene, MOVER), &npc) < 1e-4, "{label}: turns in place");
    }
}

/// NPC-facing fix (2026-10-11): ACE waits `Creature.GetRotateDelay(angle)` —
/// the angle over the motion table's TurnRight |omega| (`GetTurnSpeed`,
/// Creature_Navigation.cs) — after a `Rotate`, then sends the emote's next
/// motion, whose unpack cancels any MoveTo (`cancel_moveto`,
/// acclient.c:339518). The turn has to be done by then. Messages land between
/// slices, so that motion is handled before the first slice at or past the
/// delay. With `?remoteMoveToBegin` the turn begins in its own unpack (retail)
/// and is done in time; the pre-fix next-slice begin (`=off`) is cut short.
#[test]
fn spine_npc_turn_finishes_inside_ace_rotate_delay() {
    let kinematics = player_kinematics();
    // ACE `MotionTable.GetTurnSpeed`: the table's TurnRight |omega.z|.
    let turn_speed = 1.5f32;
    let npc = at(180.0, 96.0, 90.0);
    for (player, begin_at_unpack) in [
        (at(186.0, 96.0, 0.0), true),
        (at(180.0, 90.0, 0.0), true),
        (at(174.0, 102.0, 0.0), true),
        (at(186.0, 96.0, 0.0), false),
        (at(180.0, 90.0, 0.0), false),
    ] {
        let mut scene = spine_scene(npc);
        scene.set_remote_moveto_begin_enabled(begin_at_unpack);
        seed_local_player(&mut scene, player);
        let bearing = npc.heading_to(&player).to_degrees().rem_euclid(360.0);
        let delay = heading_error(bearing, 90.0).to_radians() / turn_speed;
        let slices = (delay / SLICE).ceil() as usize;
        apply(&mut scene, &turn_to_object(PLAYER, 0.0), true);
        run(&mut scene, &kinematics, Instant::now(), 0, slices);
        let unfinished = scene.remote_mover(MOVER).unwrap().movement.is_moveto_active();
        // The emote's next motion arrives; its unpack cancels the MoveTo.
        apply(&mut scene, &interpreted(None, None), false);
        let end = heading_deg(&pose(&scene, MOVER));
        let error = heading_error(end, bearing);
        if begin_at_unpack {
            assert!(
                !unfinished && error < 0.01,
                "bearing {bearing}°: done inside {delay} s ({slices} slices), got {end}°"
            );
        } else {
            assert!(
                unfinished && error > 0.5,
                "bearing {bearing}°: the next-slice begin is cut short, got {end}°"
            );
        }
    }
}

/// NPC-facing fix (2026-10-11): a TurnToObject whose target the client does
/// not know turns to the heading the message packs (`unpack_movement` case 8,
/// acclient.c:339604-339605) — the compass: wire 90 is east, pose 180.
#[test]
fn spine_turn_to_unknown_object_faces_the_packed_heading() {
    let kinematics = player_kinematics();
    let npc = at(180.0, 96.0, 90.0);
    let mut scene = spine_scene(npc);
    apply(&mut scene, &turn_to_object(Guid(0x8000_9999), 90.0), false);
    assert_eq!(
        scene.remote_mover(MOVER).unwrap().movement.moveto_directive_target(),
        None,
        "the TurnToHeading fallback"
    );
    let t0 = Instant::now();
    for i in 0..60 {
        run(&mut scene, &kinematics, t0, i, 1);
        if !scene.remote_mover(MOVER).unwrap().movement.is_moveto_active() {
            break;
        }
    }
    assert!(!scene.remote_mover(MOVER).unwrap().movement.is_moveto_active(), "the turn completed");
    let end = heading_deg(&pose(&scene, MOVER));
    assert!(heading_error(end, 180.0) < 0.01, "faces east: {end}°");
}

/// NPC-facing fix (2026-10-11): ACE's `MoveTo(Position)` — an NPC or monster
/// going home, a vendor's reset (`Creature.GetMoveToPosition`) — sets
/// UseFinalHeading with the home frame's `get_heading()`, the compass. The
/// mover walks there and then turns to that heading: wire 180 = south, pose
/// 270 (`MoveToPosition`'s absolute final node, acclient.c:345835-345836). It
/// used to end facing east, 90° off its spawn facing.
#[test]
fn spine_moveto_position_ends_on_the_wire_final_heading() {
    let kinematics = player_kinematics();
    let start = at(50.0, 50.0, 90.0);
    let home = at(60.0, 50.0, 0.0);
    let mut scene = spine_scene(start);
    let mut params = moveto_params(DEFAULT_BITS | 0x40);
    params.desired_heading = 180.0;
    let go_home = envelope(
        MovementType::MoveToPosition,
        0,
        MovementTypeData::MoveToPosition(MoveToPosition {
            origin: Origin {
                cell_id: home.landblock_id,
                position: home.coords,
            },
            params,
            run_rate: 1.0,
        }),
    );
    apply(&mut scene, &go_home, false);
    let t0 = Instant::now();
    for i in 0..300 {
        run(&mut scene, &kinematics, t0, i, 1);
        if !scene.remote_mover(MOVER).unwrap().movement.is_moveto_active() {
            break;
        }
    }
    assert!(!scene.remote_mover(MOVER).unwrap().movement.is_moveto_active(), "arrived");
    let end_pose = pose(&scene, MOVER);
    assert!(planar_distance(&end_pose, &home) < 1.5, "walked home: {:?}", end_pose.coords);
    let end = heading_deg(&end_pose);
    assert!(heading_error(end, 270.0) < 0.01, "faces the home heading (south): {end}°");
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

// === motion-remote-1 (2026-10-13): root motion × the object's scale. =====
// Retail `CPhysicsObj::UpdatePositionInternal` multiplies the part array's
// offset ORIGIN by `m_scale` on walkable ground (acclient.c:320014-320020;
// ACE `PhysicsObj.UpdatePositionInternal` `offsetFrame.Origin *= Scale`);
// the rotation is not scaled, and the leave-ground velocity
// (`get_leave_ground_velocity` :343806 → `get_state_velocity`) has no scale.

/// Steps `slices` slices of `quantum` with every mover at `scale` (what
/// `WorldState::step_remote_objects` reads from the entity's ObjScale).
fn run_at_scale(scene: &mut SpatialScene, kinematics: &MotionKinematics, scale: f32, slices: usize, quantum: f32) {
    use std::collections::HashMap;
    let t0 = Instant::now();
    for i in 0..slices {
        let now = t0 + Duration::from_secs_f32(i as f32 * quantum);
        let roots = scene.remote_root_motions_scaled(Some(kinematics), |_| scale);
        scene.step_remote_spine(quantum, &roots, &HashMap::new(), now);
    }
}

/// A scale-2 runner travels twice as far as a scale-1 one in the same ten
/// 0.05 s slices (no interpolation node), and turns by the same angle.
#[test]
fn spine_root_motion_scales_origin_by_obj_scale() {
    let kinematics = player_kinematics();
    let start = at(50.0, 50.0, 90.0);
    let mut moved = Vec::new();
    let mut turned = Vec::new();
    for scale in [2.0f32, 1.0] {
        let mut scene = spine_scene(start);
        apply(&mut scene, &interpreted(Some((RUN_FORWARD_LOW16, 1.0)), Some(1.0)), false);
        assert!(
            !scene.body(SpatialBodyId::Entity(MOVER)).unwrap().position_manager.queue_active(),
            "no interpolation node owns the slices"
        );
        run_at_scale(&mut scene, &kinematics, scale, 10, 0.05);
        let after = pose(&scene, MOVER);
        assert!((after.coords.z - TERRAIN_Z).abs() < 1e-3, "scale {scale}: on the terrain");
        // Landblock-local coords (finer f32 steps than global ones).
        assert_eq!(after.landblock_id.0 & 0xFFFF_0000, start.landblock_id.0 & 0xFFFF_0000);
        let d = after.coords - start.coords;
        moved.push((d.x * d.x + d.y * d.y).sqrt());
        turned.push(heading_deg(&after) - 90.0);
    }
    assert!(moved[1] > 1.5, "the unscaled run travels: {moved:?}");
    let ratio = moved[0] / moved[1];
    assert!((ratio - 2.0).abs() < 1e-4, "displacement ratio {ratio} ({moved:?})");
    assert!(turned[1].abs() > 10.0, "the turn ran: {turned:?}");
    assert!((turned[0] - turned[1]).abs() < 1e-4, "omega is not scaled: {turned:?}");
}

/// Scale 1.0 through the scaled path is byte-identical to the unscaled step,
/// and `?remoteRootScale=off` moves a scale-2 object as if unscaled.
#[test]
fn spine_root_scale_one_and_off_are_byte_identical() {
    let kinematics = player_kinematics();
    let start = at(50.0, 50.0, 90.0);
    let motion = interpreted(Some((RUN_FORWARD_LOW16, 1.5)), Some(0.5));

    let mut today = spine_scene(start);
    apply(&mut today, &motion, false);
    run(&mut today, &kinematics, Instant::now(), 0, 30);
    let expected = pose(&today, MOVER);
    assert!(planar_distance(&expected, &start) > 1.0, "the fixture moves");

    let mut one = spine_scene(start);
    apply(&mut one, &motion, false);
    run_at_scale(&mut one, &kinematics, 1.0, 30, SLICE);
    assert_eq!(pose(&one, MOVER), expected, "scale 1.0");

    let mut off = spine_scene(start);
    off.set_remote_root_scale_enabled(false);
    apply(&mut off, &motion, false);
    run_at_scale(&mut off, &kinematics, 2.0, 30, SLICE);
    assert_eq!(pose(&off, MOVER), expected, "?remoteRootScale=off");
}

/// A scale-2 runner walking off a 3 m roof leaves the ground with the
/// UNSCALED run velocity (4 m/s), though it crossed the roof at 8 m/s.
#[test]
fn spine_scaled_mover_leaves_a_ledge_at_the_unscaled_walk() {
    use holtburger_common::Triangle;
    let kinematics = player_kinematics();
    let deck = TERRAIN_Z + 3.0;
    let mut start = at(50.0, 50.0, 90.0);
    start.coords.z = deck;
    let mut scene = spine_scene(start);
    // A 2 m roof at `deck` centred on the start (global 242, 434).
    let (x0, x1, y0, y1) = (241.0, 243.0, 433.0, 435.0);
    scene.insert_building_triangle(
        0x0102_0000,
        Triangle::new(Vector3::new(x0, y0, deck), Vector3::new(x1, y0, deck), Vector3::new(x1, y1, deck)),
    );
    scene.insert_building_triangle(
        0x0102_0000,
        Triangle::new(Vector3::new(x0, y0, deck), Vector3::new(x1, y1, deck), Vector3::new(x0, y1, deck)),
    );
    apply(&mut scene, &interpreted(Some((RUN_FORWARD_LOW16, 1.0)), None), false);
    let mut slices = 0;
    while scene.remote_arc(MOVER).is_none() && slices < 10 {
        run_at_scale(&mut scene, &kinematics, 2.0, 1, 0.05);
        slices += 1;
    }
    assert!(scene.remote_arc(MOVER).is_some(), "ran off the roof");
    assert!(slices <= 3, "crossed the 1 m to the edge at 8 m/s (0.4 m a slice): {slices} slices");
    let v = scene.body(SpatialBodyId::Entity(MOVER)).unwrap().remote_velocity;
    let horiz = (v.x * v.x + v.y * v.y).sqrt();
    assert!((horiz - 4.0).abs() < 1e-3, "leaves at the unscaled run (4 m/s), not 8: {horiz}");
}

/// The transition planner carries both: the scaled walk moves the plan's
/// end, the unscaled walk is its leave-ground velocity.
#[test]
fn spine_plan_carries_the_unscaled_leave_velocity() {
    use super::remote_transition::REMOTE_TRANSITION_RADIUS_M;
    let kinematics = player_kinematics();
    let start = at(50.0, 50.0, 90.0);
    let mut scene = spine_scene(start);
    seed_local_player(&mut scene, at(55.0, 50.0, 0.0));
    apply(&mut scene, &interpreted(Some((RUN_FORWARD_LOW16, 1.0)), None), false);
    let roots = scene.remote_root_motions_scaled(Some(&kinematics), |_| 2.0);
    let plans = scene.plan_remote_moves(0.05, &roots, REMOTE_TRANSITION_RADIUS_M);
    let plan = plans.iter().find(|p| p.guid == MOVER).expect("the mover plans a move");
    let speed = |v: Vector3| (v.x * v.x + v.y * v.y).sqrt();
    assert!((speed(plan.walk_v) - 8.0).abs() < 1e-4, "walk {:?}", plan.walk_v);
    assert!((speed(plan.leave_walk_v) - 4.0).abs() < 1e-4, "leave {:?}", plan.leave_walk_v);
    assert!((planar_distance(&plan.end, &plan.begin) - 0.4).abs() < 1e-4, "8 m/s × 0.05 s");
}
