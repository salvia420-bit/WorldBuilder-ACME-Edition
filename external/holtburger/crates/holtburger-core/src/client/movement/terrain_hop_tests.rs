//! TERRAIN-HOP (2026-10-11) — owner: "when running around outside on
//! somewhat hilly terrain, downhill or maybe if it hits a little bump, the
//! character can kind of go in the air just a little tiny bit … it can
//! happen often".
//!
//! Retail never lifts a RUNNING body off walkable terrain. A grounded mover
//! enters every transition with CONTACT | ON_WALKABLE and its stored contact
//! plane (`CPhysicsObj::get_object_info`, acclient.c:319074-319099);
//! `CTransition::adjust_offset` lays each step along that plane
//! (:311864-311954); and a step that ends above the ground is stepped back
//! down by the Setup's `step_down_height` (`transitional_insert`
//! :312961-313009 → `CTransition::step_down` :312629) — 1.5 m for the human
//! Setup, far more than a ≤ 0.48 m step can drop on any walkable
//! (`N.z >= floor_z`) face. A body only leaves walkable ground by jumping or
//! by a fall the edge machine lets go of, so a runner never LANDS — and
//! `CPhysicsObj::handle_all_collisions` (:321808) bounces only a landing
//! (`apply_bounce` needs `!prev_on_walkable`, :321830-321833).
//!
//! These drive the REAL manual-slice integrator over scene-resident terrain
//! (the faithful outdoor driver, the live path) with the browser's movement
//! defaults — `?retailQuantum` (one quantum per frame), `?landingBounce`,
//! `?bounceAlongSlope`, `?retailLeash` — at run speed, frame by frame, over
//! (i) a steep descent
//! onto flatter ground, (ii) a convex crest, (iii) a concave dip, (iv) a small
//! bump and (v) rolling 2-D hills, at retail world coordinates (Holtburg's
//! landblock, x ≈ 32 500 m) and near the origin. Each run prints a summary
//! line (`-- --nocapture`); a failing run lists its first lift-offs/landings.
//!
//! The landing side (`terrain_hop_landing_bounce_follows_the_slope`): the
//! retail-literal lift-off relaunched a moving lander horizontally, so a jump
//! onto a descent flew off the hill and chained hops all the way down;
//! `?bounceAlongSlope` (system.rs `USE_BOUNCE_ALONG_SLOPE`) keeps that bounce
//! on the ground it landed on and spends it after one hop.
#![cfg(test)]

use super::system::MovementSystem;
use crate::client::movement_types::MotionState;
use holtburger_common::position::WorldPosition;
use holtburger_common::{Guid, Quaternion, Vector3};
use holtburger_protocol::messages::movement::MotionStance;
use holtburger_world::{
    PlayerMotionTableSource, SelfMovementCapabilities, SelfMovementKinematics, WorldState,
};
use std::f32::consts::PI;
use std::time::Duration;

/// The authored player MotionTable run-cycle base (m/s): the ground speed is
/// `RUN_BASE × run_rate` (18 m/s at retail's top run rate 4.5).
const RUN_BASE: f32 = 4.0;
/// Holtburg's landblock — retail world coordinates, where the faithful
/// driver's world-frame planes carry their real magnitudes.
const HOLTBURG_LB: u32 = 0xA9B4_0000;
/// A landblock next to the world origin (x ≈ 200 m).
const ORIGIN_LB: u32 = 0x0101_0000;
/// Feet above the terrain plane under them at rest: the Setup's low sphere
/// sits 5 mm below its radius (`PLAYER_SETUP_SPHERE_LOW_Z` 0.475, r 0.48).
const REST_GAP: f32 = 0.005;
/// Heading that runs +X (`planar_velocity_for_heading` = (−cos h, sin h)).
const EAST: f32 = PI;

fn capabilities(run_rate: f32) -> SelfMovementCapabilities {
    SelfMovementCapabilities {
        kinematics: SelfMovementKinematics {
            source: PlayerMotionTableSource::DirectProperty {
                motion_table_id: 0x0900_0001,
            },
            motion_table_id: 0x0900_0001,
            stance: MotionStance::NonCombat as u32,
            base_walk_forward_velocity: Vector3::new(0.0, 2.602, 0.0),
            base_run_forward_velocity: Vector3::new(0.0, RUN_BASE, 0.0),
            base_turn_left_omega: Vector3::new(0.0, 0.0, -1.5),
            base_turn_right_omega: Vector3::new(0.0, 0.0, 1.5),
        },
        run_rate_scalar: run_rate,
    }
}

/// A landblock whose height varies only along +X (`profile[vx]` on every
/// vertex row): each cell is one plane, so a run east crosses clean creases.
fn x_profile(profile: [f32; 9]) -> [f32; 81] {
    let mut h = [0.0f32; 81];
    for vx in 0..9 {
        for vy in 0..9 {
            h[vx * 9 + vy] = profile[vx];
        }
    }
    h
}

/// Rolling 2-D hills: every cell tilts on both axes and the per-cell split
/// diagonals become real creases. Steepest triangle ≈ 26° (all walkable).
fn rolling_hills() -> [f32; 81] {
    let mut h = [0.0f32; 81];
    for vx in 0..9 {
        for vy in 0..9 {
            let (x, y) = (vx as f32, vy as f32);
            h[vx * 9 + vy] = 60.0
                + 7.0 * (1.1 * x + 0.3).sin()
                + 5.0 * (0.9 * y).cos()
                + 3.0 * (0.7 * (x + y)).sin();
        }
    }
    h
}

/// Retail terrain: landblock 0xADB1 (Holtburg), dumped from the retail
/// `client_cell_1.dat` + the region LandHeightTable — the grid the faithful
/// bridge's T4 lip tests run on (holtburger-world `faithful_bridge.rs`
/// `ADB1_HEIGHTS`). `h[vx*9+vy]`.
#[rustfmt::skip]
const ADB1_HEIGHTS: [f32; 81] = [
    58.0,60.0,62.0,52.0,46.0,42.0,38.0,36.0,34.0,
    60.0,62.0,62.0,66.0,50.0,44.0,40.0,36.0,34.0,
    62.0,62.0,66.0,66.0,66.0,46.0,40.0,36.0,34.0,
    72.0,70.0,70.0,70.0,70.0,70.0,42.0,38.0,34.0,
    80.0,74.0,74.0,74.0,74.0,74.0,44.0,38.0,34.0,
    84.0,78.0,78.0,78.0,78.0,78.0,46.0,40.0,34.0,
    88.0,80.0,80.0,80.0,80.0,80.0,46.0,40.0,34.0,
    90.0,78.0,78.0,78.0,78.0,78.0,44.0,38.0,34.0,
    92.0,74.0,74.0,74.0,74.0,74.0,44.0,38.0,32.0,
];
const ADB1_LB: u32 = 0xADB1_0000;

struct Course {
    name: &'static str,
    heights: [f32; 81],
    /// The landblocks (high words) the course is laid on.
    landblocks: &'static [u32],
    /// Landblock-local start (x, y).
    start: (f32, f32),
    heading: f32,
    /// Metres of travel to run (frames = distance / (speed · dt)).
    distance: f32,
    /// Fraction of `distance` the run must cover horizontally (a climb is
    /// slower: `adjust_offset` projects the step onto the plane).
    min_cover: f32,
}

/// Synthetic courses run near the origin AND at retail world coordinates.
const BOTH_LBS: &[u32] = &[ORIGIN_LB, HOLTBURG_LB];

#[derive(Clone, Copy)]
struct Pace {
    run_rate: f32,
    frame_dt: f32,
}

/// 12 and 18 m/s at 30, 60 and 144 frames per second (`?retailQuantum`
/// integrates each frame as one quantum).
const PACES: [Pace; 4] = [
    Pace { run_rate: 3.0, frame_dt: 1.0 / 60.0 },
    Pace { run_rate: 4.5, frame_dt: 1.0 / 60.0 },
    Pace { run_rate: 3.0, frame_dt: 1.0 / 30.0 },
    Pace { run_rate: 4.5, frame_dt: 1.0 / 144.0 },
];

#[derive(Default)]
struct Report {
    frames: usize,
    lift_offs: usize,
    airborne_frames: usize,
    landings: usize,
    bounces: usize,
    max_gap: f32,
    min_gap: f32,
    travelled: f32,
    events: Vec<String>,
    /// Set once the first landing edge has been recorded.
    landed_once: bool,
    /// Airborne frames AFTER the first landing (the bounce's own hop).
    post_airborne_frames: usize,
    /// Highest feet-above-ground AFTER the first landing.
    post_max_gap: f32,
}

/// Seed a grounded runner on `heights` (scene-resident, `lb_high`) at the
/// landblock-local `start`, facing `heading`, with the browser's movement
/// defaults installed.
fn grounded_runner(
    heights: [f32; 81],
    lb_high: u32,
    start: (f32, f32),
    heading: f32,
    run_rate: f32,
    guid: Guid,
) -> (WorldState, MovementSystem) {
    grounded_runner_on(heights, lb_high, start, heading, run_rate, guid, true)
}

/// [`grounded_runner`] with the outdoor solver chosen: `scene_resident`
/// routes the slices through the faithful `CTransition` driver (the live
/// path); `false` leaves the terrain only in the `WorldState` sampler, so
/// they take the heightfield fallback (`resolve_floor_for_step`) — live
/// while a landblock's terrain is still streaming.
fn grounded_runner_on(
    heights: [f32; 81],
    lb_high: u32,
    start: (f32, f32),
    heading: f32,
    run_rate: f32,
    guid: Guid,
    scene_resident: bool,
) -> (WorldState, MovementSystem) {
    let mut world = WorldState::synthetic();
    world.player.guid = guid;
    world.set_self_movement_capabilities_override(capabilities(run_rate));
    if scene_resident {
        world.populate_terrain_heights_scene_resident(lb_high, heights);
    } else {
        world.populate_terrain_heights(lb_high, heights);
    }
    // `?retailLeash` (browser DEFAULT ON) — the composed offset chain.
    world.set_local_retail_leash(true);
    let origin_x = ((lb_high >> 24) & 0xFF) as f32 * 192.0;
    let origin_y = ((lb_high >> 16) & 0xFF) as f32 * 192.0;
    let ground = world
        .terrain_height_at(origin_x + start.0, origin_y + start.1)
        .expect("the course terrain is populated");
    let pose = WorldPosition {
        landblock_id: Guid(lb_high | 0x0001),
        coords: Vector3::new(start.0, start.1, ground + REST_GAP),
        rotation: Quaternion::from_heading(heading),
    }
    .normalize_outdoor_cell();
    world.seed_local_player_entity(guid, "Player", pose);
    let _ = world.set_player_position(pose);
    assert_eq!(
        world.scene.terrain_landblock_resident(pose.landblock_id.0),
        scene_resident,
        "the course must ride the intended outdoor solver"
    );
    let mut movement = MovementSystem::new();
    movement.set_active_manual_drive_for_test(MotionState::builder().run().forward().build());
    // `?retailQuantum` and `?landingBounce` (browser DEFAULT ON; the native
    // consts stay off — carrier split).
    movement.set_retail_quantum(true);
    movement.set_landing_bounce(true);
    // `?bounceAlongSlope` (browser DEFAULT ON; native const off).
    movement.set_bounce_along_slope(true);
    (world, movement)
}

/// One frame of the course: advance, then classify the edge.
fn step_and_record(
    world: &mut WorldState,
    movement: &MovementSystem,
    dt: Duration,
    frame: usize,
    report: &mut Report,
) {
    let was_airborne = world.player.is_airborne;
    movement.advance_local_pose_for_manual_drive(world, dt);
    let pose = world.local_player_runtime_pose().expect("runtime pose");
    let g = pose.global_coords();
    let ground = world.terrain_height_at(g.x, g.y).unwrap_or(f32::NAN);
    let gap = g.z - ground;
    report.max_gap = report.max_gap.max(gap);
    report.min_gap = report.min_gap.min(gap);
    if world.player.is_airborne {
        report.airborne_frames += 1;
    }
    if world.player.landing_bounce.is_some() {
        report.bounces += 1;
    }
    let edge = match (was_airborne, world.player.is_airborne) {
        (false, true) => {
            report.lift_offs += 1;
            Some("LIFT-OFF")
        }
        (true, false) => {
            report.landings += 1;
            Some("landing")
        }
        _ => None,
    };
    if report.landed_once {
        if world.player.is_airborne {
            report.post_airborne_frames += 1;
        }
        report.post_max_gap = report.post_max_gap.max(gap);
    }
    if edge == Some("landing") {
        report.landed_once = true;
    }
    if let Some(edge) = edge
        && report.events.len() < 6
    {
        let n = world.terrain_normal_at(g.x, g.y).unwrap_or_else(Vector3::zero);
        let v = world.player.current_planar_velocity;
        report.events.push(format!(
            "f{frame} {edge}: local=({:.3},{:.3},{:.4}) gap={gap:+.4} \
             n=({:.3},{:.3},{:.3}) v=({:.2},{:.2},{:.2}) bounce={:?}",
            pose.coords.x,
            pose.coords.y,
            pose.coords.z,
            n.x,
            n.y,
            n.z,
            v.x,
            v.y,
            world.player.vertical_velocity,
            world.player.landing_bounce.map(|b| b.normal_speed()),
        ));
    }
}

fn run_course(
    course: &Course,
    lb_high: u32,
    pace: Pace,
    guid: Guid,
    scene_resident: bool,
) -> Report {
    let (mut world, movement) = grounded_runner_on(
        course.heights,
        lb_high,
        course.start,
        course.heading,
        pace.run_rate,
        guid,
        scene_resident,
    );
    let start = world
        .local_player_runtime_pose()
        .expect("seeded pose")
        .global_coords();
    let speed = RUN_BASE * pace.run_rate;
    let frames = (course.distance / (speed * pace.frame_dt)).ceil() as usize;
    let dt = Duration::from_secs_f32(pace.frame_dt);
    let mut report = Report {
        frames,
        max_gap: f32::MIN,
        min_gap: f32::MAX,
        ..Report::default()
    };
    for frame in 0..frames {
        step_and_record(&mut world, &movement, dt, frame, &mut report);
    }
    let end = world
        .local_player_runtime_pose()
        .expect("runtime pose")
        .global_coords();
    report.travelled = ((end.x - start.x).powi(2) + (end.y - start.y).powi(2)).sqrt();
    report
}

/// Run `course` at every pace on both landblocks; the body must stay
/// grounded (no lift-off, no airborne frame), keep its feet on the ground
/// (within 2 cm of the resting 5 mm) and cover the course.
fn assert_course_stays_grounded(course: Course, guid_base: u32) {
    let mut failures = Vec::new();
    let mut n = 0u32;
    for &lb_high in course.landblocks {
        for pace in PACES {
            n += 1;
            let r = run_course(&course, lb_high, pace, Guid(guid_base + n), true);
            let line = format!(
                "[terrain-hop] {} lb={:04X} v={:.0}m/s dt={:.1}ms frames={} lift_offs={} \
                 airborne_frames={} landings={} bounce_frames={} gap=[{:+.4},{:+.4}] \
                 travelled={:.1}/{:.0}",
                course.name,
                lb_high >> 16,
                RUN_BASE * pace.run_rate,
                pace.frame_dt * 1000.0,
                r.frames,
                r.lift_offs,
                r.airborne_frames,
                r.landings,
                r.bounces,
                r.min_gap,
                r.max_gap,
                r.travelled,
                course.distance,
            );
            eprintln!("{line}");
            let grounded = r.lift_offs == 0 && r.airborne_frames == 0;
            let planted =
                r.max_gap <= REST_GAP + 0.02 && r.min_gap >= REST_GAP - 0.02;
            let covered = r.travelled >= course.distance * course.min_cover;
            if !(grounded && planted && covered) {
                failures.push(format!("{line}\n      {}", r.events.join("\n      ")));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{}: a runner left (or floated off) walkable terrain where retail stays \
         grounded:\n{}",
        course.name,
        failures.join("\n")
    );
}

/// (i) A 26.6° descent (12 m per 24 m cell) onto a 4.8° one.
#[test]
fn terrain_hop_steep_descent_onto_flatter_ground_stays_grounded() {
    assert_course_stays_grounded(
        Course {
            name: "descent-onto-flatter",
            heights: x_profile([100.0, 100.0, 88.0, 76.0, 64.0, 62.0, 60.0, 58.0, 56.0]),
            landblocks: BOTH_LBS,
            start: (12.0, 96.0),
            heading: EAST,
            distance: 160.0,
            min_cover: 0.75,
        },
        0x5000_0D00,
    );
}

/// (ii) A 20.6° climb over a convex crest into a 24.6° descent.
#[test]
fn terrain_hop_convex_crest_stays_grounded() {
    assert_course_stays_grounded(
        Course {
            name: "convex-crest",
            heights: x_profile([50.0, 50.0, 59.0, 68.0, 77.0, 66.0, 55.0, 44.0, 40.0]),
            landblocks: BOTH_LBS,
            start: (12.0, 96.0),
            heading: EAST,
            distance: 160.0,
            min_cover: 0.75,
        },
        0x5000_0D20,
    );
}

/// (iii) A 20.6° descent into a concave dip and back up 20.6°.
#[test]
fn terrain_hop_concave_dip_stays_grounded() {
    assert_course_stays_grounded(
        Course {
            name: "concave-dip",
            heights: x_profile([70.0, 70.0, 61.0, 52.0, 43.0, 52.0, 61.0, 70.0, 70.0]),
            landblocks: BOTH_LBS,
            start: (12.0, 96.0),
            heading: EAST,
            distance: 160.0,
            min_cover: 0.75,
        },
        0x5000_0D40,
    );
}

/// (iv) A small bump: one vertex row raised 2 m (4.8° up, 4.8° down).
#[test]
fn terrain_hop_small_bump_stays_grounded() {
    assert_course_stays_grounded(
        Course {
            name: "small-bump",
            heights: x_profile([50.0, 50.0, 50.0, 50.0, 52.0, 50.0, 50.0, 50.0, 50.0]),
            landblocks: BOTH_LBS,
            start: (12.0, 96.0),
            heading: EAST,
            distance: 160.0,
            min_cover: 0.75,
        },
        0x5000_0D60,
    );
}

/// (v) Rolling 2-D hills, run on a diagonal across the split creases.
#[test]
fn terrain_hop_rolling_hills_stay_grounded() {
    assert_course_stays_grounded(
        Course {
            name: "rolling-hills",
            heights: rolling_hills(),
            landblocks: BOTH_LBS,
            start: (20.0, 20.0),
            // (−cos h, sin h) = (0.878, 0.479): north-east across the cells.
            heading: PI - 0.5,
            distance: 150.0,
            min_cover: 0.75,
        },
        0x5000_0D80,
    );
}

/// (vi) The real Holtburg grid (0xADB1), run east along y = 40 — 0° to 18°
/// climbs, a crest at x ≈ 144 and a descent, every cell non-planar.
#[test]
fn terrain_hop_holtburg_grid_stays_grounded() {
    assert_course_stays_grounded(
        Course {
            name: "holtburg-adb1",
            heights: ADB1_HEIGHTS,
            landblocks: &[ADB1_LB],
            start: (6.0, 40.0),
            heading: EAST,
            distance: 170.0,
            min_cover: 0.75,
        },
        0x5000_0DC0,
    );
}

/// (vii) Steep but walkable: a 40° climb (N.z 0.766 ≥ floor_z 0.664) over a
/// crest into a 40° descent. On a slope this steep `adjust_offset`'s contact
/// push-out lifts every step ~15 cm before the step-down re-plants it.
#[test]
fn terrain_hop_steep_walkable_crest_stays_grounded() {
    assert_course_stays_grounded(
        Course {
            name: "steep40-crest",
            heights: x_profile([30.0, 30.0, 50.1, 70.2, 90.3, 70.2, 50.1, 30.0, 30.0]),
            landblocks: BOTH_LBS,
            start: (12.0, 96.0),
            heading: EAST,
            distance: 150.0,
            min_cover: 0.4,
        },
        0x5000_0DD0,
    );
}

/// What one airborne episode does to a runner: run `warmup` grounded frames,
/// then start the episode with `launch` (a jump or a bare step-off), and
/// report every edge until `frames` have run.
#[allow(clippy::too_many_arguments)]
fn airborne_episode(
    heights: [f32; 81],
    lb_high: u32,
    pace: Pace,
    warmup: usize,
    frames: usize,
    launch: impl FnOnce(&mut WorldState),
    guid: Guid,
    along_slope: bool,
) -> Report {
    let (mut world, mut movement) =
        grounded_runner(heights, lb_high, (12.0, 96.0), EAST, pace.run_rate, guid);
    movement.set_bounce_along_slope(along_slope);
    let dt = Duration::from_secs_f32(pace.frame_dt);
    let mut warm = Report {
        max_gap: f32::MIN,
        min_gap: f32::MAX,
        ..Report::default()
    };
    for frame in 0..warmup {
        step_and_record(&mut world, &movement, dt, frame, &mut warm);
    }
    launch(&mut world);
    let mut report = Report {
        frames,
        max_gap: f32::MIN,
        min_gap: f32::MAX,
        ..Report::default()
    };
    for frame in 0..frames {
        step_and_record(&mut world, &movement, dt, warmup + frame, &mut report);
    }
    report
}

/// CHARACTERIZATION — prints how a landing plays out on flat, descending and
/// rising ground for a running jump, and for a one-quantum step-off on a
/// descent (the shape a terrain-following miss would take). Pins only that a
/// running jump onto flat ground still bounces (the owner's "when i fall
/// after a jump i should be bouncing a bit").
#[test]
fn terrain_hop_landing_profiles() {
    // Flat for x < 48, then a 15° descent (6.43 m per cell).
    let descent = x_profile([80.0, 80.0, 73.57, 67.14, 60.71, 54.28, 47.85, 41.42, 34.99]);
    // Flat for x < 48, then a 15° rise.
    let rise = x_profile([40.0, 40.0, 46.43, 52.86, 59.29, 65.72, 72.15, 78.58, 85.01]);
    let flat = [60.0f32; 81];
    // Flat for x < 48, then a 25° rise / a 30° descent.
    let rise25 = x_profile([40.0, 40.0, 51.19, 62.38, 73.57, 84.76, 95.95, 107.14, 118.33]);
    let descent30 =
        x_profile([120.0, 120.0, 106.14, 92.29, 78.43, 64.57, 50.72, 36.86, 23.0]);
    let pace = Pace { run_rate: 3.0, frame_dt: 1.0 / 60.0 };
    let mut n = 0u32;
    let mut flat_jump_bounced = false;
    for (name, heights) in [
        ("flat", flat),
        ("descent15", descent),
        ("rise15", rise),
        ("rise25", rise25),
        ("descent30", descent30),
    ] {
        for lb_high in [ORIGIN_LB, HOLTBURG_LB] {
            n += 1;
            // A 7 m/s running jump from x ≈ 40 (140 frames × 0.2 m from
            // x = 12) lands ~1.4 s later, past the crease at x = 48, at ~7 m/s
            // — a 0.35 m/s bounce, above the 0.25 lift-off cutoff.
            let r = airborne_episode(
                heights,
                lb_high,
                pace,
                140,
                200,
                |w| w.player.begin_jump(7.0),
                Guid(0x5000_0DA0 + n),
                true,
            );
            eprintln!(
                "[terrain-hop profile] jump-onto-{name} lb={:04X}: lift_offs={} landings={} \
                 airborne_frames={} bounce_frames={} max_gap={:+.3}\n      {}",
                lb_high >> 16,
                r.lift_offs,
                r.landings,
                r.airborne_frames,
                r.bounces,
                r.max_gap,
                r.events.join("\n      ")
            );
            if name == "flat" && r.bounces > 0 {
                flat_jump_bounced = true;
            }
        }
    }
    // A bare one-quantum step-off mid-descent (begin_fall keeps the run
    // velocity — `get_leave_ground_velocity` for a moving body).
    for (deg, run_rate) in [(15.0f32, 3.0f32), (25.0, 3.0), (25.0, 4.5)] {
        let drop = 24.0 * deg.to_radians().tan();
        let mut profile = [0.0f32; 9];
        for (vx, h) in profile.iter_mut().enumerate() {
            *h = 120.0 - drop * vx as f32;
        }
        n += 1;
        let r = airborne_episode(
            x_profile(profile),
            HOLTBURG_LB,
            Pace { run_rate, frame_dt: 1.0 / 60.0 },
            60,
            240,
            |w| w.player.begin_fall(),
            Guid(0x5000_0DA0 + n),
            true,
        );
        eprintln!(
            "[terrain-hop profile] step-off descent{deg:.0} v={:.0}m/s: lift_offs={} landings={} \
             airborne_frames={} bounce_frames={} max_gap={:+.3}\n      {}",
            RUN_BASE * run_rate,
            r.lift_offs,
            r.landings,
            r.airborne_frames,
            r.bounces,
            r.max_gap,
            r.events.join("\n      ")
        );
    }
    assert!(
        flat_jump_bounced,
        "a running jump onto flat ground must still store the landing bounce"
    );
}

/// CHARACTERIZATION — the same courses on the heightfield FALLBACK solver
/// (terrain not yet scene-resident). Prints only: the fallback is a
/// streaming-window stand-in, not the retail port, so its numbers inform but
/// do not gate.
#[test]
fn terrain_hop_fallback_solver_profile() {
    let courses = [
        ("descent-onto-flatter", x_profile([100.0, 100.0, 88.0, 76.0, 64.0, 62.0, 60.0, 58.0, 56.0])),
        ("convex-crest", x_profile([50.0, 50.0, 59.0, 68.0, 77.0, 66.0, 55.0, 44.0, 40.0])),
        ("concave-dip", x_profile([70.0, 70.0, 61.0, 52.0, 43.0, 52.0, 61.0, 70.0, 70.0])),
        ("small-bump", x_profile([50.0, 50.0, 50.0, 50.0, 52.0, 50.0, 50.0, 50.0, 50.0])),
    ];
    let mut n = 0u32;
    for (name, heights) in courses {
        let course = Course {
            name,
            heights,
            landblocks: BOTH_LBS,
            start: (12.0, 96.0),
            heading: EAST,
            distance: 160.0,
            min_cover: 0.75,
        };
        for pace in [PACES[0], PACES[1]] {
            n += 1;
            let r = run_course(&course, HOLTBURG_LB, pace, Guid(0x5000_0DE0 + n), false);
            eprintln!(
                "[terrain-hop fallback] {name} v={:.0}m/s: lift_offs={} airborne_frames={} \
                 landings={} bounce_frames={} gap=[{:+.4},{:+.4}] travelled={:.1}\n      {}",
                RUN_BASE * pace.run_rate,
                r.lift_offs,
                r.airborne_frames,
                r.landings,
                r.bounces,
                r.min_gap,
                r.max_gap,
                r.travelled,
                r.events.join("\n      ")
            );
        }
    }
}

/// BOUNCE-ALONG-SLOPE (`?bounceAlongSlope`, DEFAULT ON) — a landing bounce
/// follows the ground it landed on and never chains. A 7 m/s running jump
/// onto a 15° or a 30° descent, and a 12 / 18 m/s step-off flight onto a 25°
/// descent (the shapes that hopped all the way down in
/// `terrain_hop_landing_profiles`), end in AT MOST ONE small hop after the
/// first landing: ≤ 6 airborne frames, ≤ 5 cm clear of the ground. A running
/// jump onto flat ground still stores its bounce and hops once; a jump onto a
/// rise never lifts off. `=off` restores the retail-literal horizontal
/// relaunch, whose descent landing lifts off again (the chain).
#[test]
fn terrain_hop_landing_bounce_follows_the_slope() {
    let pace12 = Pace { run_rate: 3.0, frame_dt: 1.0 / 60.0 };
    let pace18 = Pace { run_rate: 4.5, frame_dt: 1.0 / 60.0 };
    let descent15 = x_profile([80.0, 80.0, 73.57, 67.14, 60.71, 54.28, 47.85, 41.42, 34.99]);
    let descent30 = x_profile([120.0, 120.0, 106.14, 92.29, 78.43, 64.57, 50.72, 36.86, 23.0]);
    let rise15 = x_profile([40.0, 40.0, 46.43, 52.86, 59.29, 65.72, 72.15, 78.58, 85.01]);
    let flat = [60.0f32; 81];
    let drop25 = 24.0 * 25.0f32.to_radians().tan();
    let mut profile25 = [0.0f32; 9];
    for (vx, h) in profile25.iter_mut().enumerate() {
        *h = 120.0 - drop25 * vx as f32;
    }
    let descent25 = x_profile(profile25);

    let jump = |w: &mut WorldState| w.player.begin_jump(7.0);
    let step_off = |w: &mut WorldState| w.player.begin_fall();
    let mut failures = Vec::new();
    let mut n = 0u32;
    let check = |name: &str, r: &Report, ok: bool, failures: &mut Vec<String>| {
        let line = format!(
            "[terrain-hop slope-bounce] {name}: landings={} lift_offs={} bounce_frames={} \
             post_airborne_frames={} post_max_gap={:+.3}\n      {}",
            r.landings,
            r.lift_offs,
            r.bounces,
            r.post_airborne_frames,
            r.post_max_gap,
            r.events.join("\n      ")
        );
        eprintln!("{line}");
        if !ok {
            failures.push(line);
        }
    };
    let one_small_hop = |r: &Report| {
        r.landings >= 1
            && r.lift_offs <= 1
            && r.post_airborne_frames <= 6
            && r.post_max_gap <= 0.05
    };

    for lb_high in [ORIGIN_LB, HOLTBURG_LB] {
        for (name, heights) in [("jump-onto-descent15", descent15), ("jump-onto-descent30", descent30)] {
            n += 1;
            let r = airborne_episode(heights, lb_high, pace12, 140, 200, jump, Guid(0x5000_0E00 + n), true);
            check(&format!("{name} lb={:04X}", lb_high >> 16), &r, one_small_hop(&r), &mut failures);
        }
        n += 1;
        let r = airborne_episode(flat, lb_high, pace12, 140, 200, jump, Guid(0x5000_0E00 + n), true);
        let flat_ok = r.bounces >= 1 && r.lift_offs == 1 && one_small_hop(&r);
        check(&format!("jump-onto-flat lb={:04X}", lb_high >> 16), &r, flat_ok, &mut failures);
        n += 1;
        let r = airborne_episode(rise15, lb_high, pace12, 140, 200, jump, Guid(0x5000_0E00 + n), true);
        check(&format!("jump-onto-rise15 lb={:04X}", lb_high >> 16), &r, r.lift_offs == 0, &mut failures);
    }
    for (label, pace) in [("12m/s", pace12), ("18m/s", pace18)] {
        n += 1;
        let r = airborne_episode(descent25, HOLTBURG_LB, pace, 60, 240, step_off, Guid(0x5000_0E00 + n), true);
        check(&format!("step-off-descent25 {label}"), &r, one_small_hop(&r), &mut failures);
    }
    // `?bounceAlongSlope=off`: the retail-literal relaunch still chains.
    n += 1;
    let r = airborne_episode(descent15, HOLTBURG_LB, pace12, 140, 200, jump, Guid(0x5000_0E00 + n), false);
    check("jump-onto-descent15 =off", &r, r.lift_offs >= 2, &mut failures);

    assert!(
        failures.is_empty(),
        "landing bounce on slopes:\n{}",
        failures.join("\n")
    );
}

// ─── A runner meeting a tree trunk on a slope ───────────────────────────────
//
// The handoff lead (owner-bugs 2026-10-11 §6 "Open"): the post-transition
// scenery clamp (system.rs, `USE_SCENERY_COLLISION`, live) corrects the
// realized step in XY only and leaves z where the transition put it, so on a
// slope a runner pulled back by a trunk is left floating (uphill) or sunk
// (downhill) by step × tanθ for a frame — a candidate for the non-jumping hop.

/// Plant one cylinder trunk (radius `r`, the `one_tree` shape of the world
/// crate's scenery tests) at the landblock-local `local`, its foot below the
/// terrain there.
fn plant_trunk(world: &mut WorldState, lb_high: u32, local: (f32, f32), r: f32) {
    use holtburger_common::Aabb;
    use holtburger_world::spatial::scenery::{SceneryColliderBatch, WorldCylSphere};
    let ox = ((lb_high >> 24) & 0xFF) as f32 * 192.0;
    let oy = ((lb_high >> 16) & 0xFF) as f32 * 192.0;
    let (cx, cy) = (ox + local.0, oy + local.1);
    let ground = world.terrain_height_at(cx, cy).expect("trunk on the course");
    let mut b = SceneryColliderBatch::new();
    b.push_cylinder(
        0x0200_02D3,
        Aabb::new(
            Vector3::new(cx - 7.0, cy - 7.0, ground - 3.0),
            Vector3::new(cx + 7.0, cy + 7.0, ground + 24.0),
        ),
        WorldCylSphere { low_pt: Vector3::new(cx, cy, ground - 3.0), radius: r, height: 27.0 },
        1.0,
    );
    world.scene.insert_scenery_colliders(lb_high, b);
}

/// Run `seconds` of held forward run into/past a trunk at `trunk`.
#[allow(clippy::too_many_arguments)]
fn run_into_trunk(
    heights: [f32; 81],
    lb_high: u32,
    start: (f32, f32),
    trunk: (f32, f32),
    pace: Pace,
    seconds: f32,
    guid: Guid,
    along_ground: bool,
    replant: bool,
) -> Report {
    let (mut world, mut movement) = grounded_runner(heights, lb_high, start, EAST, pace.run_rate, guid);
    // `?clampAlongGround` and `?clampReplant` (browser DEFAULT ON; native
    // consts ON).
    movement.set_clamp_along_ground(along_ground);
    movement.set_clamp_replant(replant);
    plant_trunk(&mut world, lb_high, trunk, 1.5);
    let frames = (seconds / pace.frame_dt).ceil() as usize;
    let dt = Duration::from_secs_f32(pace.frame_dt);
    let mut report = Report { frames, max_gap: f32::MIN, min_gap: f32::MAX, ..Report::default() };
    let hits0 = world.scene.scenery_narrow_phase_hits();
    for frame in 0..frames {
        step_and_record(&mut world, &movement, dt, frame, &mut report);
    }
    report.bounces = (world.scene.scenery_narrow_phase_hits() - hits0) as usize; // reused: trunk contacts
    report
}

#[test]
fn terrain_hop_runner_meeting_a_trunk_on_a_slope_stays_grounded() {
    // 22° and 30° climbs / descents along +X (per 24 m cell: 9.7 m, 13.9 m).
    let up22 = x_profile([40.0, 40.0, 49.7, 59.4, 69.1, 78.8, 88.5, 98.2, 98.2]);
    let dn22 = x_profile([98.2, 98.2, 88.5, 78.8, 69.1, 59.4, 49.7, 40.0, 40.0]);
    let up30 = x_profile([30.0, 30.0, 43.9, 57.8, 71.7, 85.6, 99.5, 113.4, 113.4]);
    let dn30 = x_profile([113.4, 113.4, 99.5, 85.6, 71.7, 57.8, 43.9, 30.0, 30.0]);
    // The runner starts on the flat first cell at y = 96 and runs east; the
    // trunk stands mid-slope at x = 84, head-on (y = 96) or off the line by
    // less than trunk + body radius (1.5 + 0.48), so the body slides round it.
    let trunks = [("head-on", (84.0, 96.0)), ("brush", (84.0, 96.0 + 1.5)), ("brush-far", (84.0, 96.0 + 1.85))];
    let mut failures = Vec::new();
    let mut n = 0u32;
    // The browser defaults (`?clampReplant` re-runs the clamped slice), and
    // `?clampReplant=off` (the `?clampAlongGround` plane carry alone, exact on
    // one plane — these slopes have no crease at the trunk).
    for (mode, replant) in [("replant", true), ("plane-carry", false)] {
        for (slope, heights) in [("up22", up22), ("down22", dn22), ("up30", up30), ("down30", dn30)] {
            for (tname, trunk) in trunks {
                for lb_high in BOTH_LBS {
                    for pace in PACES {
                        n += 1;
                        let r = run_into_trunk(heights, *lb_high, (12.0, 96.0), trunk, pace, 9.0, Guid(0x5000_0F00 + n), true, replant);
                        let line = format!(
                            "[terrain-hop trunk] {mode} {slope} {tname} lb={:04X} v={:.0}m/s dt={:.1}ms \
                             trunk_hits={} lift_offs={} airborne_frames={} gap=[{:+.4},{:+.4}]",
                            lb_high >> 16,
                            RUN_BASE * pace.run_rate,
                            pace.frame_dt * 1000.0,
                            r.bounces,
                            r.lift_offs,
                            r.airborne_frames,
                            r.min_gap,
                            r.max_gap,
                        );
                        eprintln!("{line}");
                        let grounded = r.lift_offs == 0 && r.airborne_frames == 0;
                        let planted = r.max_gap <= REST_GAP + 0.02 && r.min_gap >= REST_GAP - 0.02;
                        if !(grounded && planted) {
                            failures.push(format!("{line}\n      {}", r.events.join("\n      ")));
                        }
                    }
                }
            }
        }
    }
    // `?clampAlongGround=off` and `?clampReplant=off`: the XY-only clamp
    // leaves the feet off the plane.
    let pace = PACES[0];
    let up = run_into_trunk(up22, HOLTBURG_LB, (12.0, 96.0), (84.0, 96.0), pace, 9.0, Guid(0x5000_0FF0), false, false);
    let dn = run_into_trunk(dn22, HOLTBURG_LB, (12.0, 96.0), (84.0, 96.0), pace, 9.0, Guid(0x5000_0FF1), false, false);
    eprintln!(
        "[terrain-hop trunk] =off up22 head-on gap=[{:+.4},{:+.4}]  down22 head-on gap=[{:+.4},{:+.4}]",
        up.min_gap, up.max_gap, dn.min_gap, dn.max_gap
    );
    assert!(
        up.max_gap > REST_GAP + 0.05 && dn.min_gap < REST_GAP - 0.05,
        "=off must still show the XY-only clamp's float / sink (up max {:+.4}, down min {:+.4})",
        up.max_gap,
        dn.min_gap
    );
    assert!(
        failures.is_empty(),
        "a runner meeting a trunk on a slope left (or floated off / sank into) the ground in {} of {n} runs:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
