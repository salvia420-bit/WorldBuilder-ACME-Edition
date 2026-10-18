//! TERRAIN-HOP round 2 (2026-10-18) — the owner, a week after
//! `?bounceAlongSlope`: "there is still a bug in holtburger web where we will
//! be running along, usually down a little hill or something, and we do a
//! little jump."
//!
//! `terrain_hop_tests.rs` drove synthetic courses inside ONE landblock and
//! never crossed a landblock seam. These drive the same live manual-slice
//! integrator (the faithful outdoor `CTransition` driver, the browser's
//! movement defaults) over the REAL terrain around Holtburg — the 5×5
//! landblocks 0xA7B2..0xABB6, heights and terrain types dumped from the
//! retail `client_cell_1.dat` through the Dereth `LandHeightTable` (portal
//! Region 0x13000000), water types included, fed to both stores the way the
//! wasm `PopulateTerrain` arm feeds them — across landblock seams and cell
//! edges, straight down and around every hillside, at 8 to 144 fps, with
//! frame-time hitches, through the canonical tick spine with the server's
//! own-position echoes, past half-buried rocks and tree trunks, and
//! (DAT-gated) through Holtburg's real buildings and props.
//!
//! Every run reports its lift-offs (the JS rig plays the Falling take-off and
//! landing links on each airborne edge — the visible "little jump") and its
//! FLOATS (grounded frames whose feet sit more than 2 cm above their rest).
//! The rest is the terrain under the feet less the shoreline wading depth;
//! on a 24 m cell edge the point belongs to both cells and the shallower
//! side's rest counts ([`rest_depth`]). A run with an event is replayed with
//! the transition trace on for the first event's frame
//! (`holtburger_dat::transition::trace`), printed under `-- --nocapture`.
//! Each run also counts what the always-on hop detector (`crate::hop_diag`,
//! `__diag.hop`) recorded, so the live diagnostic is pinned to the same
//! events.
//!
//! Round-1 finding (fixed by `?waterQuadrantRetail`): a step that ends
//! EXACTLY on a shoreline cell's far edge (world x/y are f32 on a 2–4 mm grid
//! at Holtburg, so steps land on 24 m edges often) read the cell's NEAR-corner
//! wading depth — ACE's `% 24 >= 12` wraps the far edge to 0 — and lifted the
//! runner 0.35 m for that frame (0xAAB5, local y = 48: 0.45 → 0.1, then 0.9
//! in the next cell). Retail compares with the cell centre
//! (`CLandBlockStruct::calc_water_depth`, acclient.c:353646).
//!
//! Round 3: the round-2 detector measured a pop against the wading REST, and
//! within 1 cm of a depth boundary its shallowest-depth probe took the other
//! side's depth while the physics rested on this side's — a "rise" with no
//! movement. Every frame replays that rule as `REST-POP` next to the
//! detector's own incidents (now measured against the drawn terrain, with a
//! cause), so each one is shown to be a visible rise or an artefact.
#![cfg(test)]

use super::system::MovementSystem;
use crate::client::movement_types::MotionState;
use crate::hop_diag::{self, HopCause, HopKind};
use holtburger_common::position::WorldPosition;
use holtburger_common::{Guid, Quaternion, Vector3};
use holtburger_protocol::messages::movement::MotionStance;
use holtburger_world::{
    AuthoritativeBodySync, PlayerMotionTableSource, SelfMovementCapabilities,
    SelfMovementKinematics, SpatialBodyId, WorldState,
};
use std::collections::BTreeMap;
use std::f32::consts::PI;
use std::time::Duration;

/// The authored player MotionTable run-cycle base (m/s).
const RUN_BASE: f32 = 4.0;
/// Feet above the terrain at rest (the Setup's low sphere sits 5 mm below its
/// radius).
const REST_GAP: f32 = 0.005;
const LB_M: f32 = 192.0;
/// A grounded frame whose feet sit this far above their rest reads as a lift.
const FLOAT_M: f32 = 0.02;
/// Landblock 0xA9B4 (Holtburg) world origin.
const A9B4_X: f32 = 169.0 * 192.0;
const A9B4_Y: f32 = 180.0 * 192.0;
/// Heading that runs +X (`planar_velocity_for_heading` = (−cos h, sin h)).
const EAST: f32 = PI;
const WEST: f32 = 0.0;
const NORTH: f32 = PI / 2.0;
const SOUTH: f32 = -PI / 2.0;
const PORTAL_DAT: &str = "/home/wbterminal/ac_base_dats/client_portal.dat";
const CELL_DAT: &str = "/home/wbterminal/ac_base_dats/client_cell_1.dat";

/// One retail landblock: high word, heights `h[vx*9+vy]` (metres), terrain
/// types `(TerrainInfo >> 2) & 0x1F` in the same order.
struct RealLb {
    id: u32,
    h: [f32; 81],
    t: [u8; 81],
}

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

/// The real terrain, scene-resident (the faithful outdoor driver, the live
/// path), water types in both stores, `?retailLeash` on.
fn real_world(guid: Guid, run_rate: f32) -> WorldState {
    real_world_where(guid, run_rate, |_| true)
}

/// [`real_world`] with only the landblocks `resident` keeps streamed in.
fn real_world_where(guid: Guid, run_rate: f32, resident: impl Fn(u32) -> bool) -> WorldState {
    let mut world = WorldState::synthetic();
    world.player.guid = guid;
    world.set_self_movement_capabilities_override(capabilities(run_rate));
    for lb in HOLTBURG_REAL_LBS.iter().filter(|lb| resident(lb.id)) {
        world.populate_terrain_heights_scene_resident(lb.id, lb.h);
        world.populate_terrain_water(lb.id, &lb.t);
        world.scene.populate_terrain_water_codes(lb.id, lb.t);
    }
    world.set_local_retail_leash(true);
    world
}

/// The shallowest wading depth touching world `(gx, gy)`: on a 24 m cell edge
/// the point belongs to both cells and either cell's rest is legitimate (the
/// same rule as `hop_diag`).
fn rest_depth(world: &WorldState, gx: f32, gy: f32) -> f32 {
    const E: f32 = 0.01;
    [(0.0, 0.0), (E, 0.0), (-E, 0.0), (0.0, E), (0.0, -E)]
        .iter()
        .map(|&(dx, dy)| world.water_depth_at(gx + dx, gy + dy))
        .fold(f32::INFINITY, f32::min)
}

/// A grounded pose at the world point `(gx, gy)`, feet at rest on the terrain
/// (less the wading depth in a shoreline cell).
fn pose_at(world: &WorldState, gx: f32, gy: f32, heading: f32) -> WorldPosition {
    let lbx = (gx / LB_M).floor() as u32;
    let lby = (gy / LB_M).floor() as u32;
    let ground = world
        .terrain_height_at(gx, gy)
        .expect("the start is on the real terrain");
    let rest = ground - rest_depth(world, gx, gy) + REST_GAP;
    WorldPosition {
        landblock_id: Guid((lbx << 24) | (lby << 16) | 0x0001),
        coords: Vector3::new(gx - lbx as f32 * LB_M, gy - lby as f32 * LB_M, rest),
        rotation: Quaternion::from_heading(heading),
    }
    .normalize_outdoor_cell()
}

/// Seed the local player at `pose` holding a forward run (turning left for
/// `turn < 0`, right for `turn > 0`), with the browser's movement defaults
/// (`?retailQuantum`, `?landingBounce`, `?bounceAlongSlope`).
fn runner(world: &mut WorldState, guid: Guid, pose: WorldPosition, turn: i8) -> MovementSystem {
    world.seed_local_player_entity(guid, "Player", pose);
    let _ = world.set_player_position(pose);
    let mut movement = MovementSystem::new();
    let drive = MotionState::builder().run().forward();
    let drive = if turn < 0 {
        drive.turn_left()
    } else if turn > 0 {
        drive.turn_right()
    } else {
        drive
    };
    movement.set_active_manual_drive_for_test(drive.build());
    movement.set_retail_quantum(true);
    movement.set_landing_bounce(true);
    movement.set_bounce_along_slope(true);
    movement
}

/// Feet above their rest at `pose`: the terrain under the pose's XY, less the
/// shoreline wading depth (retail rests the sphere `water_depth` under the
/// plane, `OBJECTINFO::validate_walkable` acclient.c:314223-314227).
fn excess(world: &WorldState, pose: &WorldPosition) -> f32 {
    let g = pose.global_coords();
    match world.terrain_height_at(g.x, g.y) {
        Some(ground) => g.z - (ground - rest_depth(world, g.x, g.y)) - REST_GAP,
        None => f32::NAN,
    }
}

/// Feet above the drawn terrain under the pose (what the eye sees; wading
/// reads about `−depth`).
fn mesh(world: &WorldState, pose: &WorldPosition) -> f32 {
    let g = pose.global_coords();
    world
        .terrain_height_at(g.x, g.y)
        .map_or(f32::NAN, |ground| g.z - ground)
}

/// The wading depth the pose's OWN landcell gives at its point, by retail's
/// rule (`CLandBlockStruct::calc_water_depth`: the cell's four corner types;
/// in a shoreline cell the corner of the quadrant against the cell centre) —
/// what the physics rests on inside that cell. `NaN` indoors.
fn cell_depth(world: &WorldState, pose: &WorldPosition) -> f32 {
    let cell = pose.landblock_id.0;
    let n = cell & 0xFFFF;
    if !(1..=64).contains(&n) {
        return f32::NAN;
    }
    let Some(codes) = world.scene.terrain_cell_water_codes(cell) else {
        return 0.0;
    };
    let cx = ((n - 1) >> 3) as usize;
    let cy = ((n - 1) & 7) as usize;
    let wet = |vx: usize, vy: usize| matches!(codes[vx * 9 + vy] & 0x1F, 16..=20);
    // [SW, SE, NW, NE]
    let corners = [
        wet(cx, cy),
        wet(cx + 1, cy),
        wet(cx, cy + 1),
        wet(cx + 1, cy + 1),
    ];
    match corners.iter().filter(|&&w| w).count() {
        0 => 0.0,
        4 => 0.9,
        _ => {
            let east = pose.coords.x > (2 * cx + 1) as f32 * 12.0;
            let north = pose.coords.y > (2 * cy + 1) as f32 * 12.0;
            if corners[usize::from(east) + 2 * usize::from(north)] {
                0.45
            } else {
                0.1
            }
        }
    }
}

/// The pose against the 12 m lines — the 24 m cell edges and the shoreline
/// quadrant lines through the cell centres — when within 1.5 cm of one (the
/// wading-depth probe reaches 1 cm).
fn line_tag(pose: &WorldPosition) -> String {
    let near = |axis: &str, v: f32| {
        let k = (v / 12.0).round();
        let d = v - k * 12.0;
        if d.abs() < 0.015 {
            let what = if (k as i64) % 2 == 0 { "edge" } else { "mid" };
            format!(" {axis}-{what}{:+.2}cm", d * 100.0)
        } else {
            String::new()
        }
    };
    format!("{}{}", near("x", pose.coords.x), near("y", pose.coords.y))
}

#[derive(Clone, Copy, Debug)]
enum DtPlan {
    /// Every frame `dt` seconds.
    Fixed(f32),
    /// `base`-second frames with one `hitch`-second frame every `every` frames.
    Hitch { base: f32, every: usize, hitch: f32 },
    /// Browser-like frames of 4–45 ms, ~3 % of them an 80–600 ms stall.
    Jitter(u32),
}

#[derive(Clone, Copy, Debug)]
struct Case {
    gx: f32,
    gy: f32,
    heading: f32,
    run_rate: f32,
    seconds: f32,
    plan: DtPlan,
    /// −1 turn left, +1 turn right while running, 0 straight.
    turn: i8,
    /// `?clampReplant` (the browser default: on).
    clamp_replant: bool,
}

impl Case {
    fn straight(gx: f32, gy: f32, heading: f32, (run_rate, dt): (f32, f32), seconds: f32) -> Self {
        Case {
            gx,
            gy,
            heading,
            run_rate,
            seconds,
            plan: DtPlan::Fixed(dt),
            turn: 0,
            clamp_replant: true,
        }
    }
}

fn lcg(state: &mut u32) -> f32 {
    *state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
    (*state >> 8) as f32 / (1u32 << 24) as f32
}

fn frame_dts(plan: DtPlan, seconds: f32) -> Vec<f32> {
    let mut out = Vec::new();
    let mut t = 0.0f32;
    let mut rng: u32 = match plan {
        DtPlan::Jitter(seed) => seed.wrapping_mul(2_654_435_761).wrapping_add(1),
        _ => 1,
    };
    while t < seconds {
        let i = out.len();
        let dt = match plan {
            DtPlan::Fixed(dt) => dt,
            DtPlan::Hitch { base, every, hitch } => {
                if i > 0 && i % every == 0 {
                    hitch
                } else {
                    base
                }
            }
            DtPlan::Jitter(_) => {
                let u = lcg(&mut rng);
                if lcg(&mut rng) < 0.03 {
                    0.08 + 0.52 * u
                } else {
                    0.004 + 0.041 * u
                }
            }
        };
        out.push(dt);
        t += dt;
    }
    out
}

#[derive(Default)]
struct RunReport {
    frames: usize,
    lift_offs: usize,
    airborne_frames: usize,
    landings: usize,
    /// Grounded frames (both sides of the frame) whose feet sat more than
    /// [`FLOAT_M`] above their rest.
    floats: usize,
    max_excess: f32,
    /// First lift-off (else first float) frame — the one the replay traces.
    first_event: Option<usize>,
    events: Vec<String>,
    travelled: f32,
    /// What the hop detector recorded over the run, per kind.
    diag_lift_offs: usize,
    diag_bounces: usize,
    diag_pops: usize,
    /// ... per cause.
    diag_causes: BTreeMap<&'static str, usize>,
    /// Pops with no explanation in the slice: `resurface` + `unexplained`.
    diag_suspicious: usize,
    /// Frames the ROUND-2 detector rule (the feet's rise against the wading
    /// rest, the shallowest depth touching the point) calls a pop.
    rest_pops: usize,
    /// The last two frames' (index, before, after), for incident context.
    prev_frame: Option<(usize, WorldPosition, WorldPosition)>,
    this_frame: Option<(usize, WorldPosition, WorldPosition)>,
}

/// Room for this many event lines per run.
const EVENTS_KEPT: usize = 8;

impl RunReport {
    fn new(frames: usize) -> Self {
        RunReport {
            frames,
            max_excess: f32::MIN,
            ..RunReport::default()
        }
    }

    /// Fold in the hop-detector incidents recorded since `count_before` (call
    /// after [`record_frame`] for the frame): count them per kind and cause,
    /// and keep each one's record with the frame before it.
    fn note_diag(&mut self, world: &WorldState, count_before: u32) {
        let new = hop_diag::count().saturating_sub(count_before) as usize;
        if new == 0 {
            return;
        }
        let kept = hop_diag::incidents();
        let fresh = &kept[kept.len().saturating_sub(new)..];
        for i in fresh {
            match i.kind {
                HopKind::LiftOff => self.diag_lift_offs += 1,
                HopKind::BounceLiftOff => self.diag_bounces += 1,
                HopKind::Pop => self.diag_pops += 1,
            }
            *self.diag_causes.entry(i.cause.as_str()).or_insert(0) += 1;
            if matches!(i.cause, HopCause::Resurface | HopCause::Unexplained) {
                self.diag_suspicious += 1;
            }
            if self.events.len() < EVENTS_KEPT {
                let at = self.this_frame.map_or(0, |f| f.0);
                let s = &i.slice;
                let mut line = format!(
                    "f{at} DIAG {}\n          begin ({:.3},{:.3},{:.4}) end ({:.3},{:.3},{:.4}) deep {:.2}",
                    hop_diag::summary_line(i),
                    s.begin[0],
                    s.begin[1],
                    s.begin[2],
                    s.end[0],
                    s.end[1],
                    s.end[2],
                    s.depth_begin_deep,
                );
                if let Some((k, before, after)) = self.prev_frame {
                    line.push_str(&format!(
                        "\n          frame before it, f{k}:\n            before {}\n            after  {}",
                        describe(world, &before),
                        describe(world, &after),
                    ));
                }
                self.events.push(line);
            }
        }
    }
}

fn describe(world: &WorldState, pose: &WorldPosition) -> String {
    let g = pose.global_coords();
    let n = world
        .terrain_normal_at(g.x, g.y)
        .unwrap_or_else(Vector3::zero);
    let cell = world.scene.current_cell(pose);
    format!(
        "cell={:08X} local=({:.3},{:.3},{:.4}) mesh={:+.4} excess={:+.4} depth={:.2} cell-depth={:.2} n=({:.3},{:.3},{:.3}) statics={}{}",
        pose.landblock_id.0,
        pose.coords.x,
        pose.coords.y,
        pose.coords.z,
        mesh(world, pose),
        excess(world, pose),
        rest_depth(world, g.x, g.y),
        cell_depth(world, pose),
        n.x,
        n.y,
        n.z,
        world.scene.cell_static_physics_bsp(cell).len(),
        line_tag(pose),
    )
}

/// One frame's edge classification + event line, shared by both drivers.
#[allow(clippy::too_many_arguments)]
fn record_frame(
    world: &WorldState,
    i: usize,
    dt: f32,
    was_airborne: bool,
    before: &WorldPosition,
    after: &WorldPosition,
    r: &mut RunReport,
) {
    let airborne = world.player.is_airborne;
    if airborne {
        r.airborne_frames += 1;
    }
    r.prev_frame = r.this_frame;
    r.this_frame = Some((i, *before, *after));
    let ex_before = excess(world, before);
    let ex_after = excess(world, after);
    r.max_excess = r.max_excess.max(ex_after);
    let edge = match (was_airborne, airborne) {
        (false, true) => {
            r.lift_offs += 1;
            Some("LIFT-OFF")
        }
        (true, false) => {
            r.landings += 1;
            Some("landing")
        }
        _ => None,
    };
    // Frames 0..3 settle a shoreline start; never count them as floats.
    let float = !was_airborne && !airborne && i > 3 && ex_after > FLOAT_M;
    if float {
        r.floats += 1;
    }
    // The round-2 detector's pop rule, replayed: the feet's rise against the
    // wading rest (NaN compares false).
    let rest_pop = !was_airborne && !airborne && ex_after - ex_before > hop_diag::HOP_POP_M;
    if rest_pop {
        r.rest_pops += 1;
    }
    let kind = match (edge, float, rest_pop) {
        (Some(e), _, _) => Some(e),
        (None, true, _) => Some("FLOAT"),
        (None, false, true) => Some("REST-POP"),
        _ => None,
    };
    if let Some(kind) = kind {
        if r.first_event.is_none() && (kind == "LIFT-OFF" || kind == "FLOAT") {
            r.first_event = Some(i);
        }
        if r.events.len() < EVENTS_KEPT {
            let v = world.player.current_planar_velocity;
            let cp = world
                .player
                .last_contact_plane
                .map(|(p, c)| {
                    format!(
                        "({:.3},{:.3},{:.3})@{c:08X}",
                        p.normal.x, p.normal.y, p.normal.z
                    )
                })
                .unwrap_or_else(|| "none".to_string());
            r.events.push(format!(
                "f{i} dt={:.1}ms {kind}: ex {ex_before:+.4}->{ex_after:+.4} mesh rise {:+.4}\n          before {}\n          after  {}\n          v=({:.2},{:.2},{:.2}) cp={cp} fsf={} bounce={:?}",
                dt * 1000.0,
                mesh(world, after) - mesh(world, before),
                describe(world, before),
                describe(world, after),
                v.x,
                v.y,
                world.player.vertical_velocity,
                world.player.frames_stationary_fall,
                world.player.landing_bounce.map(|b| b.normal_speed()),
            ));
        }
    }
}

/// Drive `case` through `advance_local_pose_for_manual_drive` (the T1 manual
/// driver the spine shares) in `world`. With `trace_at`, the transition trace
/// is captured for that frame and returned.
fn run_case_in(
    mut world: WorldState,
    case: Case,
    guid: Guid,
    trace_at: Option<usize>,
) -> (RunReport, Vec<String>) {
    let start = pose_at(&world, case.gx, case.gy, case.heading);
    let mut movement = runner(&mut world, guid, start, case.turn);
    movement.set_clamp_replant(case.clamp_replant);
    let dts = frame_dts(case.plan, case.seconds);
    let mut r = RunReport::new(dts.len());
    let mut trace = Vec::new();
    hop_diag::clear();
    for (i, dt) in dts.iter().copied().enumerate() {
        let was_airborne = world.player.is_airborne;
        let before = world.local_player_runtime_pose().expect("runtime pose");
        let diag_before = hop_diag::count();
        if trace_at == Some(i) {
            holtburger_dat::transition::trace::set_transition_trace(true);
        }
        movement.advance_local_pose_for_manual_drive(&mut world, Duration::from_secs_f32(dt));
        if trace_at == Some(i) {
            holtburger_dat::transition::trace::set_transition_trace(false);
            trace = holtburger_dat::transition::trace::transition_trace_log();
        }
        let after = world.local_player_runtime_pose().expect("runtime pose");
        record_frame(&world, i, dt, was_airborne, &before, &after, &mut r);
        r.note_diag(&world, diag_before);
    }
    let end = world
        .local_player_runtime_pose()
        .expect("runtime pose")
        .global_coords();
    let g0 = start.global_coords();
    r.travelled = ((end.x - g0.x).powi(2) + (end.y - g0.y).powi(2)).sqrt();
    (r, trace)
}

fn case_line(name: &str, case: &Case, r: &RunReport) -> String {
    format!(
        "[terrain-hop real] {name} start=({:.1},{:.1}) h={:.3} turn={} v={:.0}m/s plan={:?} frames={} \
         lift_offs={} airborne_frames={} landings={} floats={} max_excess={:+.4} travelled={:.1} \
         diag(lift={} bounce={} pop={} causes={:?}) rest_pops={}",
        case.gx,
        case.gy,
        case.heading,
        case.turn,
        RUN_BASE * case.run_rate,
        case.plan,
        r.frames,
        r.lift_offs,
        r.airborne_frames,
        r.landings,
        r.floats,
        r.max_excess,
        r.travelled,
        r.diag_lift_offs,
        r.diag_bounces,
        r.diag_pops,
        r.diag_causes,
        r.rest_pops,
    )
}

/// The outcome of a sweep: runs that lifted off / floated, and the report.
struct Sweep {
    lifted: usize,
    floated: usize,
    /// Hop-detector incidents over the sweep.
    diag_lifts: usize,
    diag_pops: usize,
    /// ... per cause, and the pops with no explanation (`resurface` +
    /// `unexplained`).
    diag_causes: BTreeMap<&'static str, usize>,
    diag_suspicious: usize,
    report: String,
}

/// Run every case in a world `make_world(case, guid)` builds; print a
/// per-sweep summary, the runs that lifted off, floated or popped
/// unexplained (up to 12), the other runs with a detector pop or a round-2
/// `REST-POP` (up to 12), and the transition trace of the first event of the
/// first run that lifted off or floated.
fn sweep_in(
    name: &str,
    cases: &[Case],
    guid_base: u32,
    make_world: &dyn Fn(&Case, Guid) -> WorldState,
) -> Sweep {
    let mut lifted = 0usize;
    let mut floated = 0usize;
    let mut frames = 0usize;
    let mut diag_lifts = 0usize;
    let mut diag_pops = 0usize;
    let mut diag_suspicious = 0usize;
    let mut rest_pops = 0usize;
    let mut diag_causes: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut lines = Vec::new();
    let mut other_lines = Vec::new();
    let mut traced = false;
    for (n, case) in cases.iter().enumerate() {
        let guid = Guid(guid_base + n as u32);
        let (r, _) = run_case_in(make_world(case, guid), *case, guid, None);
        frames += r.frames;
        diag_lifts += r.diag_lift_offs;
        diag_pops += r.diag_pops;
        diag_suspicious += r.diag_suspicious;
        rest_pops += r.rest_pops;
        for (&cause, &k) in &r.diag_causes {
            *diag_causes.entry(cause).or_insert(0) += k;
        }
        if r.lift_offs > 0 {
            lifted += 1;
        }
        if r.floats > 0 {
            floated += 1;
        }
        let block = || {
            format!(
                "{}\n      {}",
                case_line(name, case, &r),
                r.events.join("\n      ")
            )
        };
        if r.lift_offs > 0 || r.floats > 0 || r.diag_suspicious > 0 {
            if lines.len() < 12 {
                lines.push(block());
                if !traced && let Some(f) = r.first_event {
                    traced = true;
                    let (_, trace) = run_case_in(make_world(case, guid), *case, guid, Some(f));
                    let shown = trace.len().min(160);
                    lines.push(format!(
                        "    transition trace of frame {f} ({} lines, first {shown}):\n      {}",
                        trace.len(),
                        trace[..shown].join("\n      ")
                    ));
                }
            }
        } else if (r.diag_pops > 0 || r.rest_pops > 0) && other_lines.len() < 12 {
            other_lines.push(block());
        }
    }
    let summary = format!(
        "[terrain-hop real] {name}: {} runs, {frames} frames — {lifted} runs lifted off, \
         {floated} floated; hop detector: {diag_lifts} lift-offs, {diag_pops} pops {diag_causes:?} \
         ({diag_suspicious} unexplained/resurface); round-2 rule: {rest_pops} REST-POPs",
        cases.len()
    );
    eprintln!("{summary}");
    for l in lines.iter().chain(&other_lines) {
        eprintln!("{l}");
    }
    Sweep {
        lifted,
        floated,
        diag_lifts,
        diag_pops,
        diag_causes,
        diag_suspicious,
        report: format!("{summary}\n{}", lines.join("\n")),
    }
}

/// [`sweep_in`] over the full real terrain.
fn sweep(name: &str, cases: &[Case], guid_base: u32) -> Sweep {
    sweep_in(name, cases, guid_base, &|case, guid| {
        real_world(guid, case.run_rate)
    })
}

/// (12 m/s at 30 fps), (18 m/s at 60 fps), (18 m/s at 144 fps).
const PACE_12_30: (f32, f32) = (3.0, 1.0 / 30.0);
const PACE_18_60: (f32, f32) = (4.5, 1.0 / 60.0);
const PACE_18_144: (f32, f32) = (4.5, 1.0 / 144.0);

/// Straight-downhill starts over the central 3×3 (0xA8B3..0xAAB5): a 16×16
/// grid, kept where the terrain under it is steeper than 6°. Heading =
/// straight down the slope (the normal's horizontal part). `(gx, gy, h, °)`.
fn downhill_starts(world: &WorldState) -> Vec<(f32, f32, f32, f32)> {
    let x0 = 0xA8 as f32 * LB_M;
    let y0 = 0xB3 as f32 * LB_M;
    let mut out = Vec::new();
    for i in 0..16 {
        for j in 0..16 {
            let gx = x0 + 11.3 + i as f32 * 36.7;
            let gy = y0 + 7.9 + j as f32 * 36.1;
            let Some(n) = world.terrain_normal_at(gx, gy) else {
                continue;
            };
            let slope = n.z.clamp(-1.0, 1.0).acos().to_degrees();
            if slope > 6.0 {
                // (−cos h, sin h) ∥ (n.x, n.y): straight downhill.
                let heading = n.y.atan2(-n.x);
                out.push((gx, gy, heading, slope));
            }
        }
    }
    out
}

/// The `n` steepest [`downhill_starts`].
fn steepest_starts(n: usize) -> Vec<(f32, f32, f32, f32)> {
    let probe = real_world(Guid(0x5000_0FFF), 4.5);
    let mut starts = downhill_starts(&probe);
    starts.sort_by(|a, b| b.3.partial_cmp(&a.3).unwrap_or(std::cmp::Ordering::Equal));
    starts.truncate(n);
    starts
}

/// (A) Landblock seams. Runs 30 m into and 30 m out of Holtburg's landblock
/// 0xA9B4 across each of its four edges, at four points along each edge,
/// square to the seam and ±26° off it. Retail crosses a seam like any cell
/// edge: the outdoor ring holds the next landblock's cells
/// (`CLandCell::add_all_outside_cells`, acclient.c:355346 →
/// `LandDefs::adjust_to_outside` :467434) and the step-down finds its
/// terrain (`transitional_insert` :312961-313009).
#[test]
fn terrain_hop_real_landblock_seams_stay_grounded() {
    let mut cases = Vec::new();
    let along = [17.3f32, 61.1, 113.7, 158.9];
    let offsets = [0.0f32, 0.45, -0.45];
    for &a in &along {
        // (start x, start y, heading) pairs: 30 m before each edge, both ways.
        let pairs = [
            // West edge x = A9B4_X: east-bound from 0xA8B4, west-bound from 0xA9B4.
            (A9B4_X - 30.0, A9B4_Y + a, EAST),
            (A9B4_X + 30.0, A9B4_Y + a, WEST),
            // East edge x = A9B4_X + 192.
            (A9B4_X + LB_M - 30.0, A9B4_Y + a, EAST),
            (A9B4_X + LB_M + 30.0, A9B4_Y + a, WEST),
            // South edge y = A9B4_Y.
            (A9B4_X + a, A9B4_Y - 30.0, NORTH),
            (A9B4_X + a, A9B4_Y + 30.0, SOUTH),
            // North edge y = A9B4_Y + 192.
            (A9B4_X + a, A9B4_Y + LB_M - 30.0, NORTH),
            (A9B4_X + a, A9B4_Y + LB_M + 30.0, SOUTH),
        ];
        for &(gx, gy, h) in &pairs {
            for &off in &offsets {
                for &pace in &[PACE_18_60, PACE_12_30] {
                    cases.push(Case::straight(
                        gx,
                        gy,
                        h + off,
                        pace,
                        60.0 / (RUN_BASE * pace.0),
                    ));
                }
            }
            cases.push(Case::straight(
                gx,
                gy,
                h,
                PACE_18_144,
                60.0 / (RUN_BASE * PACE_18_144.0),
            ));
        }
    }
    let s = sweep("seams", &cases, 0x5000_1000);
    assert_eq!(
        (s.lifted, s.floated, s.diag_suspicious),
        (0, 0, 0),
        "a runner left (floated off, or popped unexplained off) the ground crossing a landblock seam:\n{}",
        s.report
    );
}

/// (B) Every real hillside of the central 3×3, run straight down it (and
/// ±35° across it at 18 m/s), 4 s per run; a slow runner too.
#[test]
fn terrain_hop_real_hillsides_stay_grounded() {
    let probe = real_world(Guid(0x5000_2FFF), 4.5);
    let starts = downhill_starts(&probe);
    assert!(
        starts.len() > 60,
        "the grid finds the Holtburg hillsides ({})",
        starts.len()
    );
    let mut cases = Vec::new();
    for (k, &(gx, gy, h, _slope)) in starts.iter().enumerate() {
        cases.push(Case::straight(gx, gy, h, PACE_18_60, 4.0));
        cases.push(Case::straight(gx, gy, h, PACE_12_30, 4.0));
        if k % 2 == 0 {
            cases.push(Case::straight(gx, gy, h + 0.61, PACE_18_60, 4.0));
            cases.push(Case::straight(gx, gy, h - 0.61, PACE_18_60, 4.0));
        } else {
            cases.push(Case::straight(gx, gy, h, PACE_18_144, 2.0));
            // A slow runner (6 m/s, run rate 1.5) at 60 fps.
            cases.push(Case::straight(gx, gy, h, (1.5, 1.0 / 60.0), 4.0));
        }
    }
    let s = sweep("hillsides", &cases, 0x5000_2000);
    assert_eq!(
        (s.lifted, s.floated, s.diag_suspicious),
        (0, 0, 0),
        "a runner left (floated off, or popped unexplained off) a real Holtburg hillside:\n{}",
        s.report
    );
}

/// (C) Frame-time hitches. Retail integrates a frame of up to 0.2 s as ONE
/// quantum and slices longer ones at 0.2 s (`CPhysicsObj::update_object`,
/// acclient.c:323123-323161; `MAX_QUANTUM_97 = 0.2` :784235) — every slice a
/// full transition. The 24 steepest downhill runs at 60 fps with one long
/// frame every 37 frames, then with browser-like jittered frames.
#[test]
fn terrain_hop_real_frame_hitches_stay_grounded() {
    let mut cases = Vec::new();
    for &(gx, gy, h, _) in &steepest_starts(24) {
        for &hitch in &[0.1f32, 0.2, 0.25, 0.4, 0.7, 1.5] {
            cases.push(Case {
                plan: DtPlan::Hitch {
                    base: 1.0 / 60.0,
                    every: 37,
                    hitch,
                },
                ..Case::straight(gx, gy, h, PACE_18_60, 5.0)
            });
        }
        for seed in 0..4u32 {
            cases.push(Case {
                plan: DtPlan::Jitter(seed + (gx as u32)),
                ..Case::straight(gx, gy, h, PACE_18_60, 5.0)
            });
        }
    }
    let s = sweep("hitches", &cases, 0x5000_3000);
    assert_eq!(
        (s.lifted, s.floated, s.diag_suspicious),
        (0, 0, 0),
        "a frame hitch lifted (floated, or popped unexplained) a runner off a real hillside:\n{}",
        s.report
    );
}

/// (F) Low frame rates: the 24 steepest hillsides straight down at 8, 12 and
/// 20 fps (a loaded laptop's iGPU), 18 m/s and 12 m/s. One frame of 1/8 s is
/// one 0.125 s quantum, ~5 transition steps at 18 m/s.
#[test]
fn terrain_hop_real_low_frame_rates_stay_grounded() {
    let mut cases = Vec::new();
    for &(gx, gy, h, _) in &steepest_starts(24) {
        for &fps in &[8.0f32, 12.0, 20.0] {
            cases.push(Case::straight(gx, gy, h, (4.5, 1.0 / fps), 4.0));
            cases.push(Case::straight(gx, gy, h, (3.0, 1.0 / fps), 4.0));
        }
    }
    let s = sweep("low-fps", &cases, 0x5000_6000);
    assert_eq!(
        (s.lifted, s.floated, s.diag_suspicious),
        (0, 0, 0),
        "a low frame rate lifted (floated, or popped unexplained) a runner off a real hillside:\n{}",
        s.report
    );
}

/// (G) Turning while running: circles (run + TurnLeft / TurnRight) on the 24
/// steepest hillsides, so every heading crosses the slope, its creases and
/// its cell edges at 60 and 20 fps.
#[test]
fn terrain_hop_real_turning_runs_stay_grounded() {
    let mut cases = Vec::new();
    for &(gx, gy, h, _) in &steepest_starts(24) {
        for &turn in &[-1i8, 1] {
            for &pace in &[PACE_18_60, (4.5, 1.0 / 20.0), PACE_12_30] {
                cases.push(Case {
                    turn,
                    ..Case::straight(gx, gy, h, pace, 5.0)
                });
            }
        }
    }
    let s = sweep("turning", &cases, 0x5000_7000);
    assert_eq!(
        (s.lifted, s.floated, s.diag_suspicious),
        (0, 0, 0),
        "a turning runner left (floated off, or popped unexplained off) a real hillside:\n{}",
        s.report
    );
}

/// (D) The canonical tick spine (`ClientSimulationSystem::tick`, the live
/// `?unifiedTick` path) with the server's own-position echoes: every 0.5 s an
/// UpdatePosition carrying where the runner was 150 ms earlier, applied the
/// way the self UpdatePosition handler applies a routine echo under
/// `?retailLeash` (`AuthoritativeBodySync::Snapshot`, the
/// `HandleReceivedPosition` routine arm, acclient.c:145209-145218).
#[test]
fn terrain_hop_real_spine_with_echoes_stays_grounded() {
    use crate::client::simulation::ClientSimulationSystem;
    use web_time::Instant;

    let mut failures = Vec::new();
    let mut total_frames = 0usize;
    let mut n = 0u32;
    for &(gx, gy, h, _) in &steepest_starts(24) {
        for &(rate, dt) in &[PACE_18_60, PACE_12_30] {
            n += 1;
            let guid = Guid(0x5000_4000 + n);
            let mut world = real_world(guid, rate);
            let start = pose_at(&world, gx, gy, h);
            let mut movement = runner(&mut world, guid, start, 0);
            let mut simulation = ClientSimulationSystem::new();
            simulation.track_body(SpatialBodyId::LocalPlayer(guid));
            let frames = (4.0 / dt).ceil() as usize;
            let echo_every = (0.5 / dt).round() as usize;
            let lag = (0.15 / dt).round() as usize;
            let mut history: Vec<WorldPosition> = Vec::new();
            let case = Case::straight(gx, gy, h, (rate, dt), 4.0);
            let mut r = RunReport::new(frames);
            let mut echo_moves = 0usize;
            hop_diag::clear();
            for i in 0..frames {
                if i > lag && i % echo_every == 0 {
                    let pre = world.local_player_runtime_pose().expect("runtime pose");
                    let echo = history[i - lag];
                    let _ =
                        world.set_player_position_with_sync(echo, AuthoritativeBodySync::Snapshot);
                    let post = world.local_player_runtime_pose().expect("runtime pose");
                    let moved = (post.global_coords() - pre.global_coords()).length();
                    if moved > 0.01 {
                        echo_moves += 1;
                        if r.events.len() < 6 {
                            r.events
                                .push(format!("f{i} ECHO moved the runtime pose {moved:.3} m"));
                        }
                    }
                }
                let was_airborne = world.player.is_airborne;
                let before = world.local_player_runtime_pose().expect("runtime pose");
                history.push(before);
                let diag_before = hop_diag::count();
                let _ = simulation.tick(
                    Instant::now(),
                    Duration::from_secs_f32(dt),
                    &mut world,
                    &mut movement,
                );
                let after = world.local_player_runtime_pose().expect("runtime pose");
                record_frame(&world, i, dt, was_airborne, &before, &after, &mut r);
                r.note_diag(&world, diag_before);
            }
            total_frames += frames;
            let end = world
                .local_player_runtime_pose()
                .expect("runtime pose")
                .global_coords();
            let g0 = start.global_coords();
            r.travelled = (end.x - g0.x).hypot(end.y - g0.y);
            let line = format!(
                "{} echo_moves={echo_moves}",
                case_line("spine+echoes", &case, &r)
            );
            if r.lift_offs > 0
                || r.floats > 0
                || echo_moves > 0
                || r.diag_pops > 0
                || r.rest_pops > 0
            {
                eprintln!("{line}\n      {}", r.events.join("\n      "));
            }
            if r.lift_offs > 0 || r.floats > 0 || r.diag_suspicious > 0 {
                failures.push(line);
            }
        }
    }
    eprintln!(
        "[terrain-hop real] spine+echoes: {n} runs, {total_frames} frames — {} runs lifted off, floated or popped unexplained",
        failures.len()
    );
    assert!(
        failures.is_empty(),
        "the spine with echoes lifted (or floated) a runner off:\n{}",
        failures.join("\n")
    );
}

/// (E) Scenery rocks on a real hillside: a collision SPHERE (rung 3 of
/// `CObjCell::find_obj_collisions`' cylsphere/sphere ladder) half-buried in
/// the slope 20 m down the run, head-on and grazed, a low and a high dome.
/// The post-transition scenery clamp is XY-only; `?clampReplant` re-runs the
/// clamped slice through the transition (round 3, before it: a head-on run
/// pressed on the 0.7 m dome sat 5 cm in the ground for frames and was lifted
/// 5.7 cm in one slice when it slid free), so the runner must stay on the
/// ground: no lift-off, float or unexplained pop.
#[test]
fn terrain_hop_real_rock_on_a_hillside_stays_grounded() {
    use holtburger_common::Aabb;
    use holtburger_world::spatial::scenery::SceneryColliderBatch;

    let mut failures = Vec::new();
    let mut n = 0u32;
    for &(gx, gy, h, _) in &steepest_starts(8) {
        let dir = (-h.cos(), h.sin());
        for &(radius, dome) in &[(1.5f32, 0.25f32), (1.5, 0.7), (3.0, 0.5)] {
            for &side in &[0.0f32, 0.8] {
                for &(rate, dt) in &[PACE_18_60, PACE_12_30] {
                    n += 1;
                    let guid = Guid(0x5000_5000 + n);
                    let mut world = real_world(guid, rate);
                    // 20 m down the run, `side` × radius to its left.
                    let cx = gx + dir.0 * 20.0 - dir.1 * side * radius;
                    let cy = gy + dir.1 * 20.0 + dir.0 * side * radius;
                    let Some(ground) = world.terrain_height_at(cx, cy) else {
                        continue;
                    };
                    let centre = Vector3::new(cx, cy, ground + dome - radius);
                    let mut batch = SceneryColliderBatch::new();
                    batch.push_sphere(
                        0x0200_0B4A,
                        Aabb::new(
                            Vector3::new(cx - radius, cy - radius, centre.z - radius),
                            Vector3::new(cx + radius, cy + radius, centre.z + radius),
                        ),
                        centre,
                        radius,
                        1.0,
                    );
                    let lb_high =
                        (((cx / LB_M).floor() as u32) << 24) | (((cy / LB_M).floor() as u32) << 16);
                    world.scene.insert_scenery_colliders(lb_high, batch);
                    let start = pose_at(&world, gx, gy, h);
                    let movement = runner(&mut world, guid, start, 0);
                    let frames = (3.0 / dt).ceil() as usize;
                    let case = Case::straight(gx, gy, h, (rate, dt), 3.0);
                    let mut r = RunReport::new(frames);
                    hop_diag::clear();
                    for i in 0..frames {
                        let was_airborne = world.player.is_airborne;
                        let before = world.local_player_runtime_pose().expect("runtime pose");
                        let diag_before = hop_diag::count();
                        movement.advance_local_pose_for_manual_drive(
                            &mut world,
                            Duration::from_secs_f32(dt),
                        );
                        let after = world.local_player_runtime_pose().expect("runtime pose");
                        record_frame(&world, i, dt, was_airborne, &before, &after, &mut r);
                        r.note_diag(&world, diag_before);
                    }
                    let end = world
                        .local_player_runtime_pose()
                        .expect("runtime pose")
                        .global_coords();
                    let g0 = start.global_coords();
                    r.travelled = (end.x - g0.x).hypot(end.y - g0.y);
                    let line = format!(
                        "{} rock r={radius} dome={dome} side={side} hits={}",
                        case_line("rock", &case, &r),
                        world.scene.scenery_narrow_phase_hits()
                    );
                    if r.lift_offs > 0 || r.floats > 0 || r.diag_pops > 0 || r.rest_pops > 0 {
                        eprintln!("{line}\n      {}", r.events.join("\n      "));
                    }
                    if r.lift_offs > 0 || r.floats > 0 || r.diag_suspicious > 0 {
                        failures.push(line);
                    }
                }
            }
        }
    }
    eprintln!(
        "[terrain-hop real] rocks: {n} runs — {} runs lifted off, floated or popped unexplained",
        failures.len()
    );
    assert!(
        failures.is_empty(),
        "a rock on a hillside lifted, floated or popped a runner:\n{}",
        failures.join("\n")
    );
}

/// (K) Trees on every hillside: a scenery trunk (a rung-2 cylinder, the
/// commonest collidable scenery around Holtburg) 10 m down each real
/// downhill run, dead ahead and 0.6 m to either side (the runner's 0.48 m
/// sphere grazes a 0.4 m trunk), at 60 and 30 fps, and head-on through 0.2 s
/// quanta (a browser frame hitch).
///
/// The scenery clamp is a post-transition XY correction. `?clampReplant=off`:
/// `?clampAlongGround` carries z along the TRANSITION's contact plane for it,
/// exact on one plane but off the ground by (correction × slope change) when
/// a terrain crease lies between the transition's result and the clamped pose
/// — round 3: the head-on 0.2 s quanta left the feet up to 0.36 m in the
/// ground (lifted back out the next slice: `resurface` pops, 6 per run) and
/// grazing ones up to 0.17 m above it (FLOAT, dropped the next slice); 9
/// floated runs and 63 such pops in 1001. `?clampReplant` (default) re-runs
/// the clamped slice through the transition, as retail's in-transition
/// scenery collision validates the body where it stops: no float, no
/// unexplained or resurface pop, no lift-off.
#[test]
fn terrain_hop_real_trees_on_hillsides() {
    use holtburger_common::Aabb;
    use holtburger_world::spatial::scenery::{SceneryColliderBatch, WorldCylSphere};

    const TRUNK_R: f32 = 0.4;
    const TRUNK_H: f32 = 6.0;
    const BASE: u32 = 0x5000_B000;
    const BASE_OFF: u32 = 0x5000_C000;
    let probe = real_world(Guid(0x5000_BFFF), 4.5);
    let quanta = DtPlan::Hitch {
        base: 1.0 / 60.0,
        every: 7,
        hitch: 0.2,
    };
    let mut cases = Vec::new();
    let mut trees: Vec<(f32, f32)> = Vec::new();
    let mut off_cases = Vec::new();
    let mut off_trees: Vec<(f32, f32)> = Vec::new();
    for &(gx, gy, h, _) in &downhill_starts(&probe) {
        let dir = (-h.cos(), h.sin());
        for &(side, head_on) in &[(-0.6f32, false), (0.0, true), (0.6, false)] {
            let tree = (
                gx + dir.0 * 10.0 - dir.1 * side,
                gy + dir.1 * 10.0 + dir.0 * side,
            );
            for &pace in &[PACE_18_60, PACE_12_30] {
                trees.push(tree);
                cases.push(Case::straight(gx, gy, h, pace, 2.5));
            }
            if head_on {
                let case = Case {
                    plan: quanta,
                    ..Case::straight(gx, gy, h, PACE_18_60, 2.5)
                };
                trees.push(tree);
                cases.push(case);
                off_trees.push(tree);
                off_cases.push(Case {
                    clamp_replant: false,
                    ..case
                });
            }
        }
    }
    let world_with_tree = |case: &Case, guid: Guid, (tx, ty): (f32, f32)| {
        let mut world = real_world(guid, case.run_rate);
        if let Some(ground) = world.terrain_height_at(tx, ty) {
            let low = Vector3::new(tx, ty, ground - 0.5);
            let mut batch = SceneryColliderBatch::new();
            batch.push_cylinder(
                0x0200_0B4B,
                Aabb::new(
                    Vector3::new(tx - TRUNK_R, ty - TRUNK_R, low.z),
                    Vector3::new(tx + TRUNK_R, ty + TRUNK_R, low.z + TRUNK_H),
                ),
                WorldCylSphere {
                    low_pt: low,
                    radius: TRUNK_R,
                    height: TRUNK_H,
                },
                1.0,
            );
            let lb_high =
                (((tx / LB_M).floor() as u32) << 24) | (((ty / LB_M).floor() as u32) << 16);
            world.scene.insert_scenery_colliders(lb_high, batch);
        }
        world
    };
    let off = sweep_in(
        "trees =off",
        &off_cases,
        BASE_OFF,
        &|case: &Case, guid: Guid| {
            world_with_tree(case, guid, off_trees[(guid.0 - BASE_OFF) as usize])
        },
    );
    let on = sweep_in("trees", &cases, BASE, &|case: &Case, guid: Guid| {
        world_with_tree(case, guid, trees[(guid.0 - BASE) as usize])
    });
    assert!(
        off.floated + off.diag_suspicious >= 1,
        "`?clampReplant=off` reproduces the plane carry's float / sink at a crease:\n{}",
        off.report
    );
    assert_eq!(
        (on.lifted, on.diag_lifts, on.floated, on.diag_suspicious),
        (0, 0, 0, 0),
        "a tree on a hillside lifted, floated or popped a runner (`?clampReplant`):\n{}",
        on.report
    );
}

/// (H) The neighbour landblock not streamed in yet: only Holtburg's 0xA9B4 is
/// resident and the runner crosses its east edge. The outdoor ring adds a
/// NULL cell for the unstreamed landblock (`add_outside_cell`), no landcell
/// claims the sphere, `check_other_cells` leaves `check_cell` NULL and the
/// step-down gate never opens (`transitional_insert`, acclient.c:312963): an
/// OK, moving, contact-less transition — a lift-off. Retail loads the ring
/// synchronously and never meets this; live, the 3×3 terrain prefetch around
/// the player's landblock (landblock_stream.js `ensureTerrainAroundLandblock`)
/// normally keeps it from happening. Pins that the hop detector names it:
/// one `liftOff`, the transition OK and moving, no contact plane.
#[test]
fn terrain_hop_real_unstreamed_neighbour_lifts_off_and_the_detector_names_it() {
    let guid = Guid(0x5000_8001);
    let world = real_world_where(guid, 4.5, |id| id == 0xA9B4_0000);
    // 20 m west of the east edge, mid-landblock, running east.
    let case = Case::straight(A9B4_X + LB_M - 20.0, A9B4_Y + 61.1, EAST, PACE_18_60, 2.0);
    let (r, _) = run_case_in(world, case, guid, None);
    let incidents = hop_diag::incidents();
    let line = case_line("unstreamed", &case, &r);
    eprintln!("{line}\n      {}", r.events.join("\n      "));
    for i in &incidents {
        eprintln!("      {}", hop_diag::summary_line(i));
    }
    assert!(
        r.lift_offs >= 1,
        "the runner leaves the ground at the edge:\n{line}"
    );
    let first = incidents
        .iter()
        .find(|i| i.kind == HopKind::LiftOff)
        .expect("the hop detector recorded the lift-off");
    assert!(
        first.slice.transition_ok && first.slice.moved && !first.slice.grounded,
        "an OK, moving, ungrounded transition: {first:?}"
    );
    assert!(
        first.slice.contact_nz.is_nan(),
        "no contact plane at the unstreamed edge: {first:?}"
    );
    assert_eq!(
        first.slice.begin_cell >> 16,
        0xA9B4,
        "it began on the resident landblock: {first:?}"
    );
    assert_eq!(
        first.cause,
        HopCause::NoTerrain,
        "the detector says why: no terrain under the end pose: {first:?}"
    );
}

/// (J) The round-1 shoreline lift, pinned. Four runs north into the river
/// cells of 0xAAB5 whose steps land exactly on a 24 m cell edge (local
/// y = 48) leaving a shoreline cell from its wet half. `?waterQuadrantRetail`
/// (default): the wading depth on the edge is the wet corner's, as retail's
/// centre compare gives (`CLandBlockStruct::calc_water_depth`,
/// acclient.c:353646) — no float, no pop. `=off` (ACE's `% 24 >= 12`): the
/// edge reads the dry corner and the runner is lifted 0.35 m for that frame,
/// and the hop detector names it a pop with no explanation (the wading depth
/// around the point did not change).
#[test]
fn terrain_hop_real_shoreline_edge_does_not_lift_the_runner() {
    use holtburger_world::spatial::faithful_bridge::set_retail_water_quadrant;

    let north = |gx: f32, gy: f32, pace: (f32, f32), seconds: f32| {
        Case::straight(gx, gy, NORTH, pace, seconds)
    };
    let cases = [
        north(32671.0, 34773.0, PACE_18_144, 2.0),
        north(32707.7, 34773.0, PACE_18_144, 2.0),
        Case {
            plan: DtPlan::Hitch {
                base: 1.0 / 60.0,
                every: 37,
                hitch: 0.2,
            },
            ..north(32671.0, 34736.9, PACE_18_60, 5.0)
        },
        Case {
            plan: DtPlan::Jitter(32671),
            ..north(32671.0, 34736.9, PACE_18_60, 5.0)
        },
    ];
    set_retail_water_quadrant(false);
    let off = sweep("shoreline =off", &cases, 0x5000_A000);
    set_retail_water_quadrant(true);
    let on = sweep("shoreline", &cases, 0x5000_A100);
    let unexplained = off.diag_causes.get("unexplained").copied().unwrap_or(0);
    assert!(
        off.floated >= 1 && off.diag_pops >= 1 && unexplained >= 1,
        "=off reproduces the round-1 lift and the detector names it an unexplained pop:\n{}",
        off.report
    );
    assert_eq!(
        (on.lifted, on.floated, on.diag_pops),
        (0, 0, 0),
        "the retail wading corner keeps the runner down:\n{}",
        on.report
    );
}

// ─── Holtburg's real buildings and props (DAT-gated) ────────────────────────

/// One model's physics BSP parts in the MODEL frame (a plain GfxObj `0x01`, or
/// a Setup `0x02`'s GfxObj parts at its static placement frame) — the walk the
/// wasm statics/buildings bakes and `examples/route_validate.rs`
/// (`resolve_placement_physics_bsps`) do.
fn model_physics_parts(
    portal: &holtburger_dat::DatDatabase,
    model_id: u32,
) -> Vec<holtburger_world::spatial::CellPhysicsBsp> {
    use holtburger_dat::file_type::{GfxObj, SetupModel};
    use holtburger_dat::physics::resolve_cell_physics_polygons;
    use holtburger_world::spatial::CellPhysicsBsp;
    use std::io::Cursor;

    let mut out = Vec::new();
    let part = |gfx_id: u32,
                scale: Option<Vector3>|
     -> Option<(
        holtburger_dat::physics::BspNode,
        std::collections::HashMap<u16, holtburger_dat::physics::ResolvedPolygon>,
    )> {
        let bytes = portal.get_file(gfx_id).ok()?;
        let gfx = GfxObj::unpack(&mut Cursor::new(&bytes)).ok()?;
        let tree = gfx.physics_bsp.clone()?;
        if gfx.physics_polygons.is_empty() {
            return None;
        }
        let polys = resolve_cell_physics_polygons(&gfx.physics_polygons, |vid| {
            gfx.vertex_array.vertices.get(&vid).map(|sw| {
                let mut v = Vector3::new(sw.origin.x, sw.origin.y, sw.origin.z);
                if let Some(s) = scale {
                    v.x *= s.x;
                    v.y *= s.y;
                    v.z *= s.z;
                }
                v
            })
        });
        if polys.is_empty() {
            return None;
        }
        Some((tree, polys))
    };
    match (model_id >> 24) as u8 {
        0x01 => {
            if let Some((tree, polys)) = part(model_id, None) {
                out.push(CellPhysicsBsp {
                    tree,
                    polys,
                    origin: Vector3::zero(),
                    orientation: Quaternion::identity(),
                    scale: 1.0,
                });
            }
        }
        0x02 => {
            let Ok(bytes) = portal.get_file(model_id) else {
                return out;
            };
            let Ok(setup) = SetupModel::unpack(&mut Cursor::new(&bytes)) else {
                return out;
            };
            // Retail static placement order: Resting (0x65), Default (0), first.
            let placement = setup
                .placement_frames
                .get(&0x65)
                .or_else(|| setup.placement_frames.get(&0))
                .or_else(|| setup.placement_frames.values().next());
            for (pi, &part_id) in setup.parts.iter().enumerate() {
                if (part_id >> 24) as u8 != 0x01 {
                    continue;
                }
                let scale = setup.default_scale.get(pi).copied();
                let Some((tree, polys)) = part(part_id, scale) else {
                    continue;
                };
                let (offset, rot) = placement
                    .filter(|p| pi < p.anim_frame.frames.len())
                    .map(|p| {
                        (
                            p.anim_frame.frames[pi].origin,
                            p.anim_frame.frames[pi].orientation,
                        )
                    })
                    .unwrap_or((Vector3::zero(), Quaternion::identity()));
                out.push(CellPhysicsBsp {
                    tree,
                    polys,
                    origin: offset,
                    orientation: rot,
                    scale: 1.0,
                });
            }
        }
        _ => {}
    }
    out
}

/// A landblock's statics (`true` = a building) as world-placed physics BSPs.
type PlacedStatics = Vec<(u32, bool, holtburger_world::spatial::CellPhysicsBsp)>;

/// The retail `LandBlockInfo` objects and buildings of `lbs`, world-placed.
/// `None` when the retail DATs are not on this machine.
fn load_real_statics(lbs: &[u32]) -> Option<PlacedStatics> {
    use holtburger_dat::DatDatabase;
    use holtburger_dat::landblock::LandblockInfo;
    use holtburger_world::spatial::CellPhysicsBsp;
    use std::collections::HashMap;

    if !std::path::Path::new(PORTAL_DAT).exists() || !std::path::Path::new(CELL_DAT).exists() {
        return None;
    }
    let portal = DatDatabase::new(PORTAL_DAT).ok()?;
    let cell = DatDatabase::new(CELL_DAT).ok()?;
    let mut cache: HashMap<u32, Vec<CellPhysicsBsp>> = HashMap::new();
    let mut out = PlacedStatics::new();
    for &lb in lbs {
        let Ok(bytes) = cell.get_file(lb | 0xFFFE) else {
            continue;
        };
        let Ok(info) = LandblockInfo::unpack(&bytes) else {
            continue;
        };
        let ox = ((lb >> 24) & 0xFF) as f32 * LB_M;
        let oy = ((lb >> 16) & 0xFF) as f32 * LB_M;
        let placements = info
            .objects
            .iter()
            .map(|s| (false, s.id, s.frame.origin, s.frame.orientation))
            .chain(
                info.buildings
                    .iter()
                    .map(|b| (true, b.model_id, b.frame.origin, b.frame.orientation)),
            );
        for (building, model_id, local, orientation) in placements {
            let parts = cache
                .entry(model_id)
                .or_insert_with(|| model_physics_parts(&portal, model_id));
            let origin = Vector3::new(local.x + ox, local.y + oy, local.z);
            for p in parts.iter() {
                let pr = orientation.rotate_vector(p.origin);
                out.push((
                    lb,
                    building,
                    CellPhysicsBsp {
                        tree: p.tree.clone(),
                        polys: p.polys.clone(),
                        origin: Vector3::new(origin.x + pr.x, origin.y + pr.y, origin.z + pr.z),
                        orientation: orientation.multiply(p.orientation),
                        scale: 1.0,
                    },
                ));
            }
        }
    }
    Some(out)
}

/// Register `statics` the way the wasm drains do (`insert_static_physics_bsp`
/// / `insert_building_physics_bsp`), then bake each landblock's outdoor
/// overlap index the faithful outdoor narrow-phase reads.
fn install_statics(world: &mut WorldState, statics: &PlacedStatics) {
    let mut lbs: Vec<u32> = Vec::new();
    for (lb, building, bsp) in statics {
        if *building {
            world.scene.insert_building_physics_bsp(*lb, bsp.clone());
        } else {
            world.scene.insert_static_physics_bsp(*lb, bsp.clone());
        }
        if !lbs.contains(lb) {
            lbs.push(*lb);
        }
    }
    for lb in lbs {
        world
            .scene
            .bake_outdoor_static_overlap_for_landblock(lb, true);
    }
}

/// (I) Holtburg's real buildings and props (DAT-gated): the 3×3 around
/// 0xA9B4 with every `LandBlockInfo` object and building collided inside the
/// faithful transition, run down the town's hillsides and across it on a 3×3
/// grid of starts in four directions. A step-up onto a porch or a low prop is
/// an `object` POP — retail's step-up is `step_down(step_up_height = 0.6)`
/// (`CTransition::step_up`, acclient.c:312794) and `adjust_sphere_to_plane`
/// accepts a walk interp down to −0.5 (acclient.c:359534), so a body climbs up
/// to 1.5 × 0.6 = 0.9 m: round 2 ran north over the 0.875 m rail of the fenced
/// yard at 0xA9B4 (106–117, 154–161) in one frame and down again two frames
/// later. A lift-off is a ground loss and fails the test; so does a pop with
/// no explanation.
#[test]
fn terrain_hop_real_holtburg_statics() {
    let lbs: Vec<u32> = [0xA8u32, 0xA9, 0xAA]
        .iter()
        .flat_map(|&x| [0xB3u32, 0xB4, 0xB5].map(move |y| (x << 24) | (y << 16)))
        .collect();
    let Some(statics) = load_real_statics(&lbs) else {
        eprintln!("[terrain-hop real] statics: SKIP — retail DATs not found at {PORTAL_DAT}");
        return;
    };
    let buildings = statics.iter().filter(|s| s.1).count();
    eprintln!(
        "[terrain-hop real] statics: {} BSP parts ({buildings} building parts) over {} landblocks",
        statics.len(),
        lbs.len()
    );
    let make_world = |case: &Case, guid: Guid| {
        let mut world = real_world(guid, case.run_rate);
        install_statics(&mut world, &statics);
        world
    };
    // Starts on landcells without a registered static (not inside a house).
    let probe = make_world(
        &Case::straight(A9B4_X, A9B4_Y, 0.0, PACE_18_60, 1.0),
        Guid(0x5000_9FFF),
    );
    let free = |gx: f32, gy: f32| {
        let pose = pose_at(&probe, gx, gy, 0.0);
        probe
            .scene
            .cell_static_physics_bsp(probe.scene.current_cell(&pose))
            .is_empty()
    };
    let mut cases = Vec::new();
    for &(gx, gy, h, _) in &downhill_starts(&probe) {
        let in_town = ((gx / LB_M).floor() as u32, (gy / LB_M).floor() as u32) == (0xA9, 0xB4);
        if in_town && free(gx, gy) {
            cases.push(Case::straight(gx, gy, h, PACE_18_60, 4.0));
            cases.push(Case::straight(gx, gy, h, PACE_12_30, 4.0));
        }
    }
    for i in 0..3 {
        for j in 0..3 {
            let gx = A9B4_X + 31.7 + i as f32 * 61.3;
            let gy = A9B4_Y + 29.3 + j as f32 * 63.1;
            if !free(gx, gy) {
                continue;
            }
            for &h in &[EAST, WEST, NORTH, SOUTH] {
                cases.push(Case::straight(gx, gy, h, PACE_18_60, 4.0));
            }
        }
    }
    assert!(!cases.is_empty(), "free starts in Holtburg");
    let s = sweep_in("statics", &cases, 0x5000_9000, &make_world);
    assert_eq!(
        (s.lifted, s.diag_lifts, s.diag_suspicious),
        (0, 0, 0),
        "a runner lost the ground (or popped unexplained) among Holtburg's buildings and props:\n{}",
        s.report
    );
}

// ─── Retail terrain: landblocks 0xA7B2..0xABB6 ──────────────────────────────
//
// Dumped 2026-10-18 from ~/ac_base_dats/client_cell_1.dat (CellLandblock
// 0xXXYYFFFF: Terrain[81] u16, Height[81] u8) through the Dereth
// LandHeightTable (client_portal.dat Region 0x13000000). `h` and `t` are in
// the record's own `vx*9+vy` order; `t` = `(TerrainInfo >> 2) & 0x1F` (16..=20
// water). The 0xADB1 grid dumped the same way equals `ADB1_HEIGHTS` in
// terrain_hop_tests.rs value for value.
#[rustfmt::skip]
static HOLTBURG_REAL_LBS: &[RealLb] = &[
    RealLb { id: 0xA7B2_0000, h: [66.0,62.0,58.0,54.0,50.0,46.0,42.0,40.0,38.0,64.0,62.0,58.0,52.0,48.0,44.0,40.0,38.0,36.0,64.0,60.0,56.0,50.0,46.0,42.0,38.0,36.0,36.0,62.0,58.0,52.0,48.0,44.0,40.0,38.0,36.0,34.0,58.0,54.0,50.0,46.0,42.0,40.0,38.0,36.0,34.0,56.0,52.0,48.0,44.0,40.0,38.0,36.0,34.0,32.0,54.0,50.0,46.0,42.0,40.0,36.0,34.0,32.0,32.0,50.0,46.0,42.0,40.0,38.0,34.0,32.0,32.0,32.0,46.0,42.0,40.0,38.0,36.0,34.0,32.0,32.0,32.0], t: [3,3,3,3,9,9,9,9,9,3,3,3,3,9,9,9,9,9,3,3,3,9,9,9,9,9,9,3,3,3,9,9,9,9,9,9,3,3,9,9,9,9,9,9,9,3,3,9,9,9,9,9,9,9,3,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9] },
    RealLb { id: 0xA7B3_0000, h: [38.0,34.0,34.0,34.0,32.0,32.0,30.0,30.0,30.0,36.0,36.0,34.0,34.0,32.0,32.0,30.0,30.0,30.0,36.0,34.0,34.0,32.0,32.0,30.0,30.0,30.0,32.0,34.0,34.0,32.0,32.0,30.0,30.0,30.0,30.0,32.0,34.0,32.0,32.0,32.0,30.0,30.0,30.0,30.0,30.0,32.0,32.0,32.0,32.0,30.0,30.0,30.0,30.0,28.0,32.0,32.0,32.0,32.0,30.0,30.0,30.0,30.0,28.0,32.0,32.0,32.0,32.0,30.0,30.0,30.0,30.0,30.0,32.0,32.0,32.0,32.0,32.0,32.0,32.0,32.0,32.0], t: [9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,4,9,9,9,9,9,9,9,9,4,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9] },
    RealLb { id: 0xA7B4_0000, h: [30.0,30.0,32.0,30.0,30.0,30.0,30.0,30.0,28.0,30.0,30.0,32.0,32.0,30.0,30.0,30.0,28.0,28.0,32.0,32.0,32.0,30.0,30.0,30.0,30.0,28.0,28.0,32.0,30.0,28.0,30.0,30.0,28.0,28.0,28.0,30.0,30.0,30.0,28.0,28.0,28.0,28.0,28.0,28.0,30.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,30.0,30.0,30.0,30.0,28.0,28.0,28.0,28.0,28.0,32.0,32.0,32.0,30.0,30.0,28.0,28.0,28.0,28.0], t: [9,9,9,9,9,9,9,9,4,9,9,9,9,9,9,9,4,4,9,9,9,9,9,9,9,4,4,9,9,4,9,9,4,4,4,9,9,9,4,4,4,4,4,4,9,4,4,4,4,4,17,4,4,4,4,4,4,4,4,17,17,17,4,9,4,4,4,9,4,4,17,17,9,9,9,9,9,4,4,4,4] },
    RealLb { id: 0xA7B5_0000, h: [28.0,30.0,30.0,30.0,28.0,28.0,28.0,28.0,28.0,28.0,30.0,30.0,30.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,30.0,30.0,28.0,28.0,28.0,28.0,28.0,30.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,30.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,30.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0], t: [4,9,9,9,4,4,17,17,17,4,9,9,9,4,4,17,17,17,4,4,9,9,4,4,17,4,4,9,4,4,9,4,4,17,4,4,9,4,4,9,9,4,17,4,4,4,4,9,9,9,4,17,4,4,4,4,4,9,9,4,17,4,4,17,17,4,9,9,4,17,17,17,4,17,4,9,9,4,4,4,17] },
    RealLb { id: 0xA7B6_0000, h: [28.0,28.0,28.0,30.0,30.0,32.0,32.0,34.0,36.0,28.0,28.0,28.0,30.0,30.0,30.0,32.0,32.0,34.0,28.0,28.0,28.0,28.0,28.0,28.0,30.0,30.0,32.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,30.0,28.0,30.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0], t: [17,17,4,9,9,9,9,9,9,17,4,4,9,9,9,9,9,9,4,4,4,4,4,4,9,9,9,4,4,4,17,17,4,4,4,9,4,9,4,17,17,17,4,4,4,4,4,4,4,4,17,17,4,4,4,4,4,4,4,4,17,17,4,17,4,4,17,4,4,4,17,17,17,4,4,17,17,4,4,4,17] },
    RealLb { id: 0xA8B2_0000, h: [46.0,42.0,40.0,38.0,36.0,34.0,32.0,32.0,32.0,44.0,40.0,38.0,36.0,36.0,34.0,34.0,34.0,34.0,42.0,40.0,38.0,36.0,36.0,36.0,36.0,36.0,38.0,40.0,40.0,38.0,38.0,38.0,38.0,38.0,40.0,42.0,40.0,40.0,38.0,40.0,40.0,42.0,44.0,46.0,48.0,42.0,42.0,42.0,44.0,44.0,48.0,50.0,52.0,56.0,44.0,46.0,46.0,48.0,50.0,54.0,58.0,60.0,64.0,48.0,50.0,52.0,54.0,58.0,62.0,66.0,70.0,72.0,54.0,56.0,60.0,62.0,66.0,70.0,74.0,80.0,86.0], t: [9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,3,3,9,9,9,9,9,3,3,3,3,9,9,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3] },
    RealLb { id: 0xA8B3_0000, h: [32.0,32.0,32.0,32.0,32.0,32.0,32.0,32.0,32.0,34.0,34.0,36.0,36.0,36.0,36.0,36.0,36.0,36.0,38.0,38.0,40.0,40.0,42.0,42.0,42.0,42.0,42.0,42.0,44.0,46.0,46.0,48.0,50.0,50.0,50.0,50.0,48.0,50.0,54.0,56.0,58.0,60.0,60.0,60.0,60.0,56.0,58.0,62.0,64.0,68.0,70.0,70.0,70.0,68.0,64.0,68.0,70.0,72.0,76.0,78.0,78.0,78.0,76.0,72.0,76.0,80.0,82.0,84.0,86.0,86.0,84.0,82.0,86.0,94.0,94.0,94.0,94.0,94.0,94.0,94.0,90.0], t: [9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,1,1,1,3,3,3,1,1,1,1,1,1,1] },
    RealLb { id: 0xA8B4_0000, h: [32.0,32.0,32.0,30.0,30.0,28.0,28.0,28.0,28.0,36.0,36.0,34.0,32.0,32.0,30.0,30.0,28.0,28.0,42.0,42.0,40.0,38.0,34.0,34.0,32.0,30.0,28.0,50.0,48.0,46.0,44.0,40.0,38.0,34.0,32.0,28.0,60.0,58.0,56.0,52.0,48.0,42.0,36.0,32.0,30.0,68.0,66.0,62.0,58.0,52.0,50.0,40.0,34.0,32.0,76.0,72.0,68.0,64.0,58.0,56.0,44.0,36.0,32.0,82.0,78.0,74.0,70.0,64.0,58.0,54.0,42.0,36.0,90.0,84.0,78.0,78.0,70.0,66.0,58.0,50.0,40.0], t: [9,9,9,9,9,4,4,4,4,9,9,9,9,9,9,9,4,4,9,9,9,9,9,9,9,9,4,9,9,9,9,9,9,9,9,4,3,3,3,3,9,9,9,9,9,3,3,3,3,3,3,9,9,9,3,3,3,3,3,3,9,9,9,3,3,3,3,3,3,14,14,9,1,1,3,3,3,3,3,14,14] },
    RealLb { id: 0xA8B5_0000, h: [28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,30.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,32.0,30.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,32.0,30.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,36.0,30.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,40.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0], t: [4,17,4,9,9,4,4,4,17,4,17,4,4,4,4,4,4,17,4,17,17,17,17,17,17,17,17,4,4,4,4,4,4,4,4,17,9,9,9,9,4,4,4,4,17,9,9,4,4,4,17,17,4,17,9,9,9,4,4,4,17,17,17,9,9,9,9,4,4,4,4,17,14,9,9,9,9,9,4,4,17] },
    RealLb { id: 0xA8B6_0000, h: [28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0], t: [17,4,4,17,17,4,4,4,17,17,17,4,4,17,4,9,4,17,17,17,4,4,17,4,9,4,4,17,17,4,4,17,4,4,4,4,17,17,4,4,17,17,17,17,17,17,17,17,4,4,4,4,17,17,17,4,17,17,4,4,4,17,16,17,4,4,17,17,4,16,16,16,17,16,16,16,16,16,16,16,16] },
    RealLb { id: 0xA9B2_0000, h: [54.0,56.0,60.0,62.0,66.0,70.0,74.0,80.0,86.0,62.0,64.0,68.0,70.0,74.0,78.0,82.0,88.0,94.0,70.0,72.0,74.0,78.0,80.0,84.0,90.0,94.0,94.0,78.0,80.0,84.0,94.0,94.0,94.0,94.0,94.0,94.0,80.0,84.0,94.0,94.0,94.0,94.0,94.0,94.0,94.0,84.0,84.0,94.0,94.0,94.0,94.0,94.0,94.0,94.0,84.0,84.0,94.0,94.0,94.0,94.0,94.0,94.0,96.0,100.0,100.0,98.0,96.0,94.0,94.0,94.0,96.0,100.0,106.0,104.0,102.0,100.0,98.0,96.0,96.0,100.0,102.0], t: [3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,1,1,3,3,3,3,3,1,1,1,1,3,3,3,3,1,1,1,1,3,3,1,1,1,1,1,1,3,1,1,3,3,3,3,3,3,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1] },
    RealLb { id: 0xA9B3_0000, h: [86.0,94.0,94.0,94.0,94.0,94.0,94.0,94.0,90.0,94.0,94.0,94.0,94.0,94.0,94.0,94.0,94.0,90.0,94.0,94.0,94.0,94.0,94.0,94.0,94.0,94.0,90.0,94.0,94.0,94.0,98.0,100.0,100.0,98.0,96.0,94.0,94.0,94.0,100.0,104.0,106.0,106.0,104.0,100.0,94.0,94.0,98.0,104.0,110.0,110.0,110.0,106.0,102.0,94.0,96.0,100.0,106.0,112.0,114.0,112.0,108.0,102.0,94.0,100.0,104.0,108.0,116.0,116.0,112.0,108.0,102.0,94.0,102.0,106.0,110.0,116.0,116.0,112.0,108.0,102.0,96.0], t: [3,3,1,1,1,1,1,1,1,1,1,3,3,3,3,3,3,3,1,3,1,1,1,1,1,3,1,3,1,1,1,1,1,1,3,1,1,1,1,1,1,1,1,1,3,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1] },
    RealLb { id: 0xA9B4_0000, h: [90.0,84.0,78.0,78.0,70.0,66.0,58.0,50.0,40.0,90.0,84.0,78.0,78.0,70.0,66.0,66.0,66.0,46.0,90.0,84.0,78.0,78.0,70.0,66.0,66.0,66.0,50.0,94.0,94.0,94.0,82.0,74.0,66.0,66.0,66.0,50.0,94.0,94.0,94.0,80.0,80.0,66.0,66.0,66.0,50.0,94.0,94.0,94.0,80.0,80.0,66.0,66.0,66.0,48.0,94.0,94.0,94.0,80.0,66.0,66.0,66.0,66.0,48.0,94.0,94.0,94.0,78.0,66.0,66.0,66.0,54.0,40.0,96.0,90.0,82.0,72.0,64.0,64.0,64.0,48.0,30.0], t: [1,1,3,3,3,3,3,14,14,3,3,3,3,3,3,3,9,14,1,1,1,3,3,3,3,9,14,1,1,14,14,14,3,3,9,14,3,1,1,14,14,3,3,9,14,1,3,1,14,3,3,3,9,9,1,3,1,14,3,3,3,9,9,1,1,1,14,3,3,3,14,9,1,1,14,14,3,3,9,14,9] },
    RealLb { id: 0xA9B5_0000, h: [40.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,46.0,36.0,30.0,28.0,28.0,28.0,28.0,28.0,28.0,50.0,38.0,32.0,28.0,28.0,28.0,28.0,28.0,28.0,50.0,38.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,50.0,36.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,48.0,36.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,48.0,40.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,40.0,40.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,30.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0], t: [14,9,9,9,9,9,4,4,17,14,9,9,4,4,4,4,4,16,14,9,9,4,5,16,16,16,16,14,9,5,5,16,16,16,16,16,14,9,5,16,16,16,16,16,16,9,5,5,16,16,16,16,16,16,9,9,5,16,16,16,16,16,16,9,5,5,16,16,16,16,16,16,9,5,5,16,16,16,16,16,16] },
    RealLb { id: 0xA9B6_0000, h: [28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,50.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,46.0,50.0,28.0,28.0,28.0,28.0,28.0,28.0,42.0,52.0,60.0], t: [17,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,5,16,16,16,16,16,16,16,5,5,16,16,16,16,16,16,5,5,9,16,16,16,16,16,5,5,9,9,16,16,16,16,5,5,9,9,9] },
    RealLb { id: 0xAAB2_0000, h: [106.0,104.0,102.0,100.0,98.0,96.0,96.0,100.0,102.0,112.0,110.0,108.0,104.0,102.0,100.0,100.0,104.0,106.0,118.0,116.0,114.0,110.0,106.0,104.0,104.0,106.0,108.0,122.0,120.0,118.0,114.0,110.0,108.0,108.0,108.0,108.0,124.0,122.0,120.0,116.0,112.0,110.0,108.0,110.0,110.0,124.0,122.0,120.0,116.0,112.0,110.0,108.0,108.0,108.0,122.0,120.0,118.0,114.0,112.0,108.0,108.0,106.0,106.0,118.0,116.0,114.0,112.0,110.0,108.0,106.0,104.0,102.0,112.0,110.0,110.0,108.0,106.0,106.0,104.0,102.0,100.0], t: [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1] },
    RealLb { id: 0xAAB3_0000, h: [102.0,106.0,110.0,116.0,116.0,112.0,108.0,102.0,96.0,106.0,108.0,112.0,116.0,116.0,112.0,108.0,100.0,94.0,108.0,112.0,114.0,116.0,116.0,112.0,106.0,98.0,88.0,108.0,110.0,114.0,116.0,114.0,110.0,100.0,90.0,80.0,110.0,110.0,112.0,112.0,112.0,102.0,92.0,80.0,68.0,108.0,110.0,112.0,112.0,106.0,92.0,80.0,66.0,50.0,106.0,106.0,106.0,104.0,94.0,82.0,68.0,50.0,50.0,102.0,102.0,100.0,94.0,84.0,72.0,54.0,54.0,54.0,100.0,96.0,92.0,84.0,74.0,58.0,58.0,58.0,56.0], t: [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,3,1,1,1,1,1,1,1,3,3] },
    RealLb { id: 0xAAB4_0000, h: [96.0,90.0,82.0,72.0,64.0,64.0,64.0,48.0,30.0,94.0,78.0,78.0,66.0,60.0,60.0,60.0,44.0,28.0,88.0,78.0,78.0,58.0,58.0,58.0,58.0,44.0,34.0,80.0,68.0,56.0,56.0,56.0,58.0,58.0,42.0,32.0,68.0,54.0,54.0,54.0,54.0,54.0,44.0,38.0,32.0,50.0,50.0,50.0,50.0,50.0,44.0,38.0,30.0,28.0,50.0,50.0,48.0,48.0,42.0,36.0,32.0,30.0,28.0,54.0,52.0,50.0,42.0,36.0,32.0,28.0,28.0,28.0,56.0,54.0,46.0,38.0,32.0,28.0,28.0,28.0,28.0], t: [1,1,14,14,3,3,9,14,9,1,1,1,14,3,3,9,14,5,1,1,3,3,3,3,9,14,9,1,1,3,3,3,9,9,14,9,1,1,3,3,3,9,14,14,9,1,3,3,3,9,14,14,9,5,1,3,3,9,14,9,9,9,5,3,3,3,14,9,9,5,5,5,3,3,14,9,9,5,5,16,16] },
    RealLb { id: 0xAAB5_0000, h: [30.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,34.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,32.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,32.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,30.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,32.0], t: [9,5,5,16,16,16,16,16,16,5,5,16,16,16,16,16,16,16,9,5,16,16,16,16,16,16,16,9,5,16,16,16,16,16,16,16,9,5,16,16,16,16,16,16,16,5,5,16,16,16,16,16,16,5,5,16,16,16,16,16,16,5,5,5,16,16,16,16,16,16,5,9,16,16,16,16,16,16,16,5,9] },
    RealLb { id: 0xAAB6_0000, h: [28.0,28.0,28.0,28.0,28.0,28.0,42.0,52.0,60.0,28.0,28.0,28.0,28.0,28.0,34.0,44.0,52.0,62.0,28.0,28.0,28.0,28.0,30.0,40.0,46.0,58.0,68.0,28.0,28.0,28.0,28.0,34.0,42.0,48.0,60.0,68.0,28.0,28.0,28.0,30.0,36.0,40.0,48.0,58.0,68.0,28.0,28.0,30.0,32.0,38.0,42.0,48.0,56.0,66.0,28.0,30.0,32.0,36.0,40.0,44.0,50.0,56.0,64.0,30.0,32.0,36.0,40.0,44.0,48.0,52.0,58.0,64.0,32.0,36.0,40.0,44.0,48.0,52.0,56.0,60.0,66.0], t: [16,16,16,16,5,5,9,9,9,16,16,16,5,5,9,9,9,3,16,16,16,5,9,9,9,9,3,16,16,5,5,9,9,9,9,3,16,5,5,9,9,9,9,9,3,5,5,9,9,9,9,9,9,3,5,9,9,9,9,9,9,9,3,9,9,9,9,9,9,9,9,3,9,9,9,9,9,9,9,9,3] },
    RealLb { id: 0xABB2_0000, h: [112.0,110.0,110.0,108.0,106.0,106.0,104.0,102.0,100.0,106.0,104.0,104.0,102.0,102.0,102.0,102.0,100.0,96.0,100.0,98.0,98.0,98.0,98.0,98.0,98.0,94.0,90.0,94.0,92.0,92.0,94.0,94.0,94.0,92.0,88.0,82.0,88.0,88.0,88.0,88.0,90.0,88.0,84.0,80.0,74.0,84.0,84.0,84.0,84.0,82.0,80.0,76.0,72.0,66.0,76.0,76.0,76.0,76.0,74.0,66.0,66.0,66.0,66.0,66.0,66.0,66.0,66.0,66.0,66.0,66.0,66.0,66.0,66.0,66.0,66.0,66.0,66.0,66.0,66.0,66.0,66.0], t: [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3] },
    RealLb { id: 0xABB3_0000, h: [100.0,96.0,92.0,84.0,74.0,58.0,58.0,58.0,56.0,96.0,90.0,84.0,74.0,60.0,60.0,60.0,58.0,58.0,90.0,84.0,76.0,64.0,64.0,64.0,62.0,60.0,50.0,82.0,76.0,66.0,66.0,66.0,66.0,66.0,50.0,40.0,74.0,66.0,66.0,66.0,66.0,66.0,52.0,42.0,34.0,66.0,66.0,66.0,66.0,66.0,52.0,42.0,32.0,28.0,66.0,66.0,66.0,66.0,52.0,42.0,36.0,28.0,28.0,66.0,66.0,66.0,54.0,44.0,36.0,28.0,28.0,28.0,66.0,66.0,52.0,42.0,34.0,30.0,28.0,28.0,28.0], t: [1,1,1,1,1,1,1,3,3,1,1,1,1,1,1,3,3,3,1,1,1,1,1,3,3,3,14,1,1,1,1,3,3,3,14,14,1,1,3,3,3,3,14,14,9,3,3,3,3,3,14,14,9,5,3,3,3,3,14,14,9,9,5,3,3,9,14,9,9,9,5,5,3,9,14,9,9,9,5,5,16] },
    RealLb { id: 0xABB4_0000, h: [56.0,54.0,46.0,38.0,32.0,28.0,28.0,28.0,28.0,58.0,50.0,40.0,30.0,28.0,28.0,28.0,28.0,28.0,50.0,42.0,34.0,28.0,28.0,28.0,28.0,28.0,28.0,40.0,34.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,34.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0], t: [3,3,14,9,9,5,5,16,16,3,14,14,9,5,5,16,16,16,14,14,9,5,5,16,16,16,16,14,9,5,5,16,16,16,16,16,9,5,5,16,16,16,16,16,16,5,5,16,16,16,16,16,16,16,5,16,16,16,16,16,16,16,16,5,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16] },
    RealLb { id: 0xABB5_0000, h: [28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,32.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,36.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,34.0,44.0,28.0,28.0,28.0,28.0,28.0,28.0,28.0,40.0,50.0,28.0,28.0,28.0,28.0,28.0,28.0,38.0,48.0,56.0,28.0,28.0,28.0,28.0,28.0,28.0,40.0,54.0,64.0,28.0,28.0,28.0,28.0,32.0,36.0,46.0,58.0,68.0,28.0,28.0,28.0,28.0,28.0,40.0,50.0,62.0,70.0,28.0,28.0,28.0,28.0,32.0,42.0,52.0,62.0,72.0], t: [16,16,16,16,16,16,16,5,9,16,16,16,16,16,16,5,5,9,16,16,16,16,16,16,5,9,9,16,16,16,16,16,5,5,9,9,16,16,16,16,16,5,9,9,9,16,16,16,5,5,5,9,9,3,16,16,16,5,9,9,9,9,3,16,16,16,5,5,9,9,9,3,16,16,16,5,9,9,9,3,3] },
    RealLb { id: 0xABB6_0000, h: [32.0,36.0,40.0,44.0,48.0,52.0,56.0,60.0,66.0,36.0,42.0,46.0,50.0,54.0,58.0,62.0,64.0,68.0,44.0,46.0,54.0,60.0,64.0,66.0,68.0,70.0,72.0,50.0,56.0,64.0,68.0,72.0,74.0,76.0,76.0,78.0,56.0,66.0,72.0,76.0,80.0,82.0,84.0,84.0,84.0,64.0,72.0,78.0,82.0,86.0,88.0,90.0,90.0,90.0,68.0,76.0,82.0,86.0,90.0,92.0,94.0,96.0,96.0,70.0,78.0,84.0,88.0,92.0,96.0,98.0,100.0,100.0,72.0,80.0,86.0,90.0,96.0,100.0,102.0,104.0,104.0], t: [9,9,9,9,9,9,9,9,3,9,9,9,9,9,9,3,3,3,9,9,9,9,3,3,3,3,3,9,9,3,3,3,3,3,3,3,9,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,1,1,1,3,3,3,3,3,1,1,1,1,3,3,3,3,1,1,1,1,1] },
];
