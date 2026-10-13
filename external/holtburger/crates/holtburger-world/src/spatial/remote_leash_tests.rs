//! motion-remote-3 (2026-10-13) — `?remoteLeash`: the remote
//! `ConstraintManager` leash on the object's own motion.
//!
//! Retail `PositionManager::adjust_offset` runs interpolation, sticky, then
//! `ConstraintManager::adjust_offset` on every frame's offset, the part
//! array's root motion included (acclient.c:388287-388304, called from
//! `UpdatePositionInternal` :320027-320030), and `HandleReceivedPosition`
//! re-arms `ConstrainTo(object->m_position)` after every `MoveOrTeleport`
//! that returns 1 (:145223-145227; teleport, far snap and interpolate arms,
//! :323451-323498). So a remote whose positions stop runs 10 m (5 m indoors)
//! at full speed, then slows to a halt by 50 m (20 m). Before, the leash only
//! ever scaled interpolation and a remote holding a run with no further
//! positions ran on until its DeleteObject. (WebAC's
//! `tests/verify-remote-movement-audit.ts` pins the same behaviour.)

use super::scene::RemoteCorrectionCtx;
use super::*;
use crate::motion::root_motion::test_support::{PLAYER_TABLE, player_kinematics};
use holtburger_common::position::WorldPosition;
use holtburger_common::{Guid, Quaternion, Vector3};
use holtburger_dat::file_type::MotionKinematics;
use holtburger_protocol::messages::movement::messages::motion::MovementInvalid;
use holtburger_protocol::messages::movement::{InterpretedMotionState, MovementStateFlags};
use holtburger_protocol::messages::{MovementEventData, MovementType, MovementTypeData};
use std::time::Duration;
use web_time::Instant;

const MOVER: Guid = Guid(0x8000_0043);
const TERRAIN_Z: f32 = 12.0;
const NONCOMBAT_LOW16: u16 = 0x3D;
const RUN_FORWARD_LOW16: u16 = 0x0007;
const SLICE: f32 = 1.0 / 60.0;
/// RunForward × 2.0 on the player table's 4.0 m/s run.
const RUN_SPEED: f32 = 8.0;

/// Sets this thread's switch and restores the default (ON) on drop, even
/// when an assertion fails.
struct LeashSwitch;

impl LeashSwitch {
    fn set(on: bool) -> Self {
        set_remote_leash(on);
        Self
    }
}

impl Drop for LeashSwitch {
    fn drop(&mut self) {
        set_remote_leash(true);
    }
}

fn at(x: f32, y: f32, heading_deg: f32) -> WorldPosition {
    WorldPosition {
        landblock_id: Guid(0x0102_0000),
        coords: Vector3::new(x, y, TERRAIN_Z),
        rotation: Quaternion::from_heading(heading_deg.to_radians()),
    }
    .normalize_outdoor_cell()
}

/// An indoor cell of the same landblock (low word ≥ 0x100).
fn indoor(x: f32, y: f32) -> WorldPosition {
    WorldPosition {
        landblock_id: Guid(0x0102_0105),
        coords: Vector3::new(x, y, TERRAIN_Z),
        rotation: Quaternion::from_heading(90f32.to_radians()),
    }
}

/// A local player two landblocks east — beyond the 96 m interp radius.
fn far_player() -> WorldPosition {
    WorldPosition {
        landblock_id: Guid(0x0302_0000),
        coords: Vector3::new(50.0, 50.0, TERRAIN_Z),
        rotation: Quaternion::identity(),
    }
}

fn reconcile_with(
    scene: &mut SpatialScene,
    target: WorldPosition,
    sync: AuthoritativeBodySync,
    contact: Option<bool>,
    player: Option<WorldPosition>,
) {
    scene.reconcile_authoritative_body_with_remote(
        SpatialBodyId::Entity(MOVER),
        target,
        Vector3::zero(),
        Vector3::zero(),
        sync,
        Instant::now(),
        Some(RemoteCorrectionCtx {
            contact,
            player_pose: player,
        }),
    );
}

/// An accepted, on-contact UpdatePosition with the local player standing on
/// the target (well inside 96 m).
fn update_position(scene: &mut SpatialScene, target: WorldPosition) {
    reconcile_with(scene, target, AuthoritativeBodySync::Snapshot, Some(true), Some(target));
}

/// The remote driver and the spine on, flat terrain at `TERRAIN_Z`, the
/// mover's body seeded at `start` (the first reconcile creates it).
fn spine_scene(start: WorldPosition) -> SpatialScene {
    let mut scene = SpatialScene::new();
    scene.set_remote_interp_enabled(true);
    scene.set_remote_spine_enabled(true);
    scene.populate_terrain_heights(0x0102_0000, [TERRAIN_Z; 81]);
    update_position(&mut scene, start);
    scene
}

/// Case 0: an interpreted state running forward at `speed`.
fn run_forward(speed: f32) -> MovementEventData {
    let state = InterpretedMotionState {
        flags: MovementStateFlags::FORWARD_COMMAND | MovementStateFlags::FORWARD_SPEED,
        num_commands: 0,
        current_style: None,
        forward_command: Some(RUN_FORWARD_LOW16.into()),
        sidestep_command: None,
        turn_command: None,
        forward_speed: Some(speed),
        sidestep_speed: None,
        turn_speed: None,
        commands: Vec::new(),
    };
    MovementEventData {
        guid: MOVER,
        object_instance_sequence: 1,
        movement_sequence: 2,
        server_control_sequence: 3,
        is_autonomous: false,
        movement_type: MovementType::Invalid,
        motion_flags: 0,
        current_style: NONCOMBAT_LOW16,
        data: MovementTypeData::Invalid(MovementInvalid {
            state,
            sticky_object: None,
        }),
    }
}

fn apply(scene: &mut SpatialScene, data: &MovementEventData) {
    let _ = scene.apply_remote_movement(
        MOVER,
        data,
        false,
        0.5,
        1.8,
        Some(PLAYER_TABLE),
        (0.5, 1.8),
    );
}

/// A seeded runner (RunForward × 2.0 = 8 m/s, facing north).
fn runner_scene(start: WorldPosition) -> SpatialScene {
    let mut scene = spine_scene(start);
    apply(&mut scene, &run_forward(2.0));
    scene
}

fn body(scene: &SpatialScene) -> &SpatialBody {
    scene.body(SpatialBodyId::Entity(MOVER)).expect("mover body")
}

fn pose(scene: &SpatialScene) -> WorldPosition {
    body(scene).pose
}

fn leash(scene: &SpatialScene) -> ConstraintManager {
    body(scene).position_manager.constraint
}

fn planar_distance(a: &WorldPosition, b: &WorldPosition) -> f32 {
    let d = a.global_coords() - b.global_coords();
    (d.x * d.x + d.y * d.y).sqrt()
}

/// Steps `slices` slices of `SLICE`, the clock continuing from slice `from`.
fn run(scene: &mut SpatialScene, kinematics: &MotionKinematics, t0: Instant, from: usize, slices: usize) {
    for i in from..from + slices {
        let now = t0 + Duration::from_secs_f32(i as f32 * SLICE);
        scene.step_remote_objects(SLICE, Some(kinematics), now);
    }
}

#[test]
fn remote_leash_defaults_on() {
    assert!(remote_leash_enabled(), "DEFAULT ON; `=off` is the escape");
}

/// `preview_scale` is exactly the factor `adjust_offset` applies, and
/// `accumulate` of the scaled offset leaves the same budget — across the
/// below-start, in-band, at/over-max, airborne and disarmed rows
/// (acclient.c:389478-389510).
#[test]
fn preview_scale_and_accumulate_match_adjust_offset() {
    let step = Vector3::new(0.3, -0.4, 0.0);
    for seed in [0.0f32, 5.0, 10.0, 10.5, 30.0, 49.9, 50.0, 60.0] {
        for on_contact in [true, false] {
            let mut retail = ConstraintManager::default();
            retail.constrain_to(seed, 10.0, 50.0);
            let mut split = retail;
            let k = split.preview_scale(on_contact);
            let expected = retail.adjust_offset(step, on_contact);
            let scaled = step * k;
            assert!(
                (scaled - expected).length() < 1e-6,
                "seed {seed} contact {on_contact}: preview {k} → {scaled:?} vs {expected:?}"
            );
            split.accumulate(scaled);
            assert!(
                (split.constraint_pos_offset() - retail.constraint_pos_offset()).abs() < 1e-5,
                "seed {seed} contact {on_contact}: budget"
            );
        }
    }
    let mut disarmed = ConstraintManager::default();
    assert_eq!(disarmed.preview_scale(true), 1.0);
    disarmed.accumulate(step);
    assert_eq!(disarmed.constraint_pos_offset(), 0.0, "no budget while disarmed");
    assert!(!disarmed.is_constrained());
}

/// (a) A RunForward × 2.0 remote with one accepted UpdatePosition and then
/// 30 s with none: the first 10 m at full speed, then it slows and stands by
/// 50 m. Retail's leash, and WebAC's "runs 10 m, then slows to a halt short
/// of 50 m".
#[test]
fn remote_leash_halts_runner_whose_updates_stop() {
    let _switch = LeashSwitch::set(true);
    let kinematics = player_kinematics();
    let start = at(50.0, 50.0, 90.0);
    let mut scene = runner_scene(start);
    update_position(&mut scene, start);
    assert!(leash(&scene).is_constrained(), "the accepted position armed the leash");
    assert_eq!(leash(&scene).distances(), (10.0, 50.0), "outdoor: 10 / 50");
    assert_eq!(leash(&scene).constraint_pos_offset(), 0.0);

    let t0 = Instant::now();
    run(&mut scene, &kinematics, t0, 0, 60);
    let one_second = planar_distance(&pose(&scene), &start);
    assert!(
        (one_second - RUN_SPEED).abs() < 0.01,
        "under `start` the leash is inert: {one_second} m in 1 s"
    );

    run(&mut scene, &kinematics, t0, 60, 29 * 60 - 60);
    let at_29 = pose(&scene);
    run(&mut scene, &kinematics, t0, 29 * 60, 60);
    let end = pose(&scene);
    let travelled = planar_distance(&end, &start);
    assert!(
        travelled > 10.0 && travelled < 50.0,
        "ran past the 10 m start and stopped short of 50 m: {travelled} m"
    );
    assert!(travelled > 45.0, "it did run on into the band: {travelled} m");
    let last_second = planar_distance(&end, &at_29);
    assert!(last_second < 0.05, "halted: {last_second} m in the last second");
    assert!((end.coords.z - TERRAIN_Z).abs() < 1e-3, "on the terrain");
    let budget = leash(&scene).constraint_pos_offset();
    assert!(
        (budget - travelled).abs() < 0.05,
        "the leash accumulated the walk: {budget} vs {travelled}"
    );
}

/// (b) A new UpdatePosition on the halted runner's own spot (the ≤0.05 m
/// stop arm of `InterpolateTo`, which `MoveOrTeleport` still returns 1 for)
/// re-arms the leash at zero: the next slice runs at full speed.
#[test]
fn remote_leash_rearms_on_a_new_position() {
    let _switch = LeashSwitch::set(true);
    let kinematics = player_kinematics();
    let start = at(50.0, 50.0, 90.0);
    let mut scene = runner_scene(start);
    let t0 = Instant::now();
    run(&mut scene, &kinematics, t0, 0, 30 * 60);
    let halted = pose(&scene);
    run(&mut scene, &kinematics, t0, 30 * 60, 1);
    assert!(planar_distance(&pose(&scene), &halted) < 1e-3, "halted");

    let here = pose(&scene);
    update_position(&mut scene, here);
    assert!(!body(&scene).position_manager.queue_active(), "the ≤0.05 m arm queues nothing");
    assert_eq!(leash(&scene).constraint_pos_offset(), 0.0, "re-armed at zero");
    run(&mut scene, &kinematics, t0, 30 * 60 + 1, 1);
    let step = planar_distance(&pose(&scene), &here);
    assert!(
        (step - RUN_SPEED * SLICE).abs() < 1e-3,
        "full speed again: {step} m in one slice, want {}",
        RUN_SPEED * SLICE
    );
}

/// A correction that queues an interpolation node keeps the leash armed
/// after the node completes (retail never auto-releases it, :389417), so the
/// run that follows is still leashed. `=off` keeps the shipped auto-release.
#[test]
fn remote_leash_is_held_across_interp_completion() {
    let kinematics = player_kinematics();
    let start = at(50.0, 50.0, 90.0);
    for on in [true, false] {
        let _switch = LeashSwitch::set(on);
        let mut scene = runner_scene(start);
        update_position(&mut scene, at(50.0, 51.0, 90.0));
        assert!(body(&scene).position_manager.queue_active(), "on={on}: 1 m queues a node");
        let t0 = Instant::now();
        let mut done = false;
        for i in 0..120 {
            run(&mut scene, &kinematics, t0, i, 1);
            if !body(&scene).position_manager.queue_active() {
                done = true;
                break;
            }
        }
        assert!(done, "on={on}: the node completed");
        assert_eq!(leash(&scene).is_constrained(), on, "on={on}: leash held only when on");
    }
}

/// (c) Every arm `MoveOrTeleport` returns 1 for re-arms at zero — the far
/// snap (player ≥ 96 m) and the teleport hard set — with start/max from the
/// body's OWN cell after the arm (10/50 outdoor, 5/20 indoor). The `!contact`
/// arm returns 0 and leaves the leash as it was.
#[test]
fn remote_leash_rearms_on_far_snap_and_hard_set_not_on_no_contact() {
    let _switch = LeashSwitch::set(true);
    let kinematics = player_kinematics();
    let start = at(50.0, 50.0, 90.0);
    let t0 = Instant::now();

    // Far snap.
    let mut scene = runner_scene(start);
    run(&mut scene, &kinematics, t0, 0, 30);
    assert!(leash(&scene).constraint_pos_offset() > 3.9, "the run spent budget");
    let snap = at(60.0, 40.0, 90.0);
    reconcile_with(&mut scene, snap, AuthoritativeBodySync::Snapshot, Some(true), Some(far_player()));
    assert_eq!(pose(&scene), snap, "far object: snapped");
    assert!(leash(&scene).is_constrained());
    assert_eq!(leash(&scene).constraint_pos_offset(), 0.0, "far snap re-arms at zero");
    assert_eq!(leash(&scene).distances(), (10.0, 50.0));
    // Far snap into an indoor cell: the body's own (new) cell picks 5/20.
    reconcile_with(&mut scene, indoor(60.0, 40.0), AuthoritativeBodySync::Snapshot, Some(true), Some(far_player()));
    assert_eq!(leash(&scene).distances(), (5.0, 20.0), "indoor after the snap");

    // Teleport hard set.
    let mut scene = runner_scene(start);
    run(&mut scene, &kinematics, t0, 0, 30);
    let teleport = at(70.0, 70.0, 90.0);
    reconcile_with(&mut scene, teleport, AuthoritativeBodySync::Reset, Some(true), Some(teleport));
    assert_eq!(pose(&scene), teleport);
    assert_eq!(leash(&scene).constraint_pos_offset(), 0.0, "hard set re-arms at zero");
    assert!(leash(&scene).is_constrained());

    // `!contact`: no re-arm, the spent budget stands.
    let mut scene = runner_scene(start);
    run(&mut scene, &kinematics, t0, 0, 30);
    let spent = leash(&scene).constraint_pos_offset();
    reconcile_with(&mut scene, at(50.0, 60.0, 90.0), AuthoritativeBodySync::Snapshot, Some(false), Some(start));
    assert!(leash(&scene).is_constrained());
    assert_eq!(leash(&scene).constraint_pos_offset(), spent, "!contact returns 0: untouched");
}

/// Retail reads the object's OWN cell for the leash after `MoveOrTeleport`
/// (and for the blip in `InterpolateTo`): an outdoor body interpolating
/// toward an indoor position keeps the outdoor 10/50. `=off` keeps the old
/// choice from the target's cell.
#[test]
fn remote_leash_distances_come_from_the_body_cell() {
    let start = at(50.0, 50.0, 90.0);
    for (on, expected) in [(true, (10.0, 50.0)), (false, (5.0, 20.0))] {
        let _switch = LeashSwitch::set(on);
        let mut scene = spine_scene(start);
        update_position(&mut scene, indoor(51.0, 50.0));
        assert!(body(&scene).position_manager.queue_active(), "on={on}: 1 m queues");
        assert_eq!(leash(&scene).distances(), expected, "on={on}");
    }
}

/// (d) The leash scales the object's own motion only. A landing slide (the
/// physics velocity, integrated after `adjust_offset`, acclient.c:320033)
/// moves a body whose leash is spent exactly as it moves one with no run at
/// all — the spent leash zeroes the run, never the slide.
#[test]
fn remote_leash_does_not_scale_the_landing_slide() {
    let _switch = LeashSwitch::set(true);
    let kinematics = player_kinematics();
    let start = at(50.0, 50.0, 90.0);
    let slide = Vector3::new(3.0, 0.0, 0.0);
    let spend = |scene: &mut SpatialScene| {
        let body = scene.body_mut(SpatialBodyId::Entity(MOVER)).unwrap();
        body.position_manager.constraint.constrain_to(60.0, 10.0, 50.0);
        body.remote_velocity = slide;
    };
    let mut running = runner_scene(start);
    spend(&mut running);
    let mut still = spine_scene(start);
    spend(&mut still);
    let t0 = Instant::now();
    run(&mut running, &kinematics, t0, 0, 5);
    run(&mut still, &kinematics, t0, 0, 5);
    let moved = planar_distance(&pose(&still), &start);
    assert!(moved > 0.1, "the slide moved the body: {moved} m");
    assert_eq!(pose(&running), pose(&still), "the spent leash zeroed the run, not the slide");
    assert_eq!(body(&running).remote_velocity, body(&still).remote_velocity);
}

/// (e) Inside the 10 m start the leash is inert: flag on and off step the
/// same pose bit for bit. Past it, `=off` keeps running at full speed and
/// never arms the leash on the seed or the stop arm (the pre-fix lattice).
#[test]
fn remote_leash_off_is_the_unleashed_run() {
    let kinematics = player_kinematics();
    let start = at(50.0, 50.0, 90.0);
    let t0 = Instant::now();
    let travel = |on: bool, slices: usize| {
        let _switch = LeashSwitch::set(on);
        let mut scene = runner_scene(start);
        update_position(&mut scene, start);
        if !on {
            assert!(!leash(&scene).is_constrained(), "=off: seed and stop arm never arm it");
        }
        run(&mut scene, &kinematics, t0, 0, slices);
        pose(&scene)
    };
    assert_eq!(travel(true, 60), travel(false, 60), "8 m: byte-identical");
    let off = planar_distance(&travel(false, 180), &start);
    assert!((off - 3.0 * RUN_SPEED).abs() < 0.02, "=off: full speed for 3 s, {off} m");
    let on = planar_distance(&travel(true, 180), &start);
    assert!(on < off - 1.0, "on: slowed past 10 m ({on} vs {off} m)");
}
