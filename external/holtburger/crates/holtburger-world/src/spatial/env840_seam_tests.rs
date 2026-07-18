//! Offline repro of the Holtburg grocer EnvCell-seam movement-refusal bug.
//!
//! Rebuilds the five EnvCells 0xA9B4016A..0xA9B4016E (Environment 840) from
//! the real portal/cell DATs, mirroring the production web ingest
//! (`apps/holtburger-web/src/lib.rs` `fetchEnvCellsInLandblock`), and drives
//! the faithful `CTransition` collision pipeline against the reported pose to
//! observe WHICH branch refuses movement. Repro + diagnosis only — asserts
//! only that the CONTROL (mid-vestibule) pose still moves, proving the harness
//! is sound; the repro pose's outcome is PRINTED, not asserted.
//!
//! DAT-gated: skips (with a printed SKIP line) if the portal/cell dats are not
//! present. Run with `-- --nocapture` to see the diagnostics.

use std::io::Cursor;

use holtburger_common::position::WorldPosition;
use holtburger_common::{Aabb, Guid, Quaternion, Sphere, Vector3};

use holtburger_dat::file_type::env_cell::EnvCell;
use holtburger_dat::file_type::environment::Environment;
use holtburger_dat::physics::resolve_cell_physics_polygons;
use holtburger_dat::transition::driver_validate::MovingObjectPhysics;
use holtburger_dat::transition::frame_transform::Frame;
use holtburger_dat::transition::types::{object_info_state, CTransition, Position};
use holtburger_dat::DatDatabase;

use crate::spatial::entity_collision::EntityCollider;
use crate::spatial::faithful_bridge::{
    faithful_find_placement_position, faithful_find_transitional_position, SceneWorld,
};
use crate::spatial::scene::{CellMembership, CellPhysicsBsp, SpatialScene};
use crate::spatial::transition::{
    ObjectInfo, TransitionEnv, TransitionGates, TransitionInput, TransitionOutcome,
};

// Landblock high bytes for 0xA9B4xxxx.
const LB_X: f32 = 0xA9 as u32 as f32; // 169
const LB_Y: f32 = 0xB4 as u32 as f32; // 180
const REPRO_CELL: u32 = 0xA9B4_016E; // =366, the vestibule
const ENV_840: u32 = 0x0D00_0348;

fn portal_dat_path() -> String {
    std::env::var("HOLTBURGER_PORTAL_DAT")
        .unwrap_or_else(|_| "/home/wbterminal/ac_base_dats/client_portal.dat".to_string())
}
fn cell_dat_path() -> String {
    std::env::var("HOLTBURGER_CELL_DAT")
        .unwrap_or_else(|_| "/home/wbterminal/ac_base_dats/client_cell_1.dat".to_string())
}

/// Minimal `TransitionEnv` — indoor cells only, no terrain/water/entities.
struct TestEnv {
    scene: SpatialScene,
}
impl TransitionEnv for TestEnv {
    fn scene(&self) -> &SpatialScene {
        &self.scene
    }
    fn terrain_height_at(&self, _x: f32, _y: f32) -> Option<f32> {
        None
    }
    fn terrain_normal_at(&self, _x: f32, _y: f32) -> Option<Vector3> {
        None
    }
    fn water_depth_at(&self, _x: f32, _y: f32) -> f32 {
        0.0
    }
    fn is_entirely_water_cell_at(&self, _x: f32, _y: f32) -> bool {
        false
    }
    fn entity_colliders_near(
        &self,
        _pose: &WorldPosition,
        _prefilter_dist: f32,
        _exclude: Guid,
        _skip_parented: bool,
    ) -> Vec<EntityCollider> {
        Vec::new()
    }
}

/// The local player is gravity-affected (mirrors `FaithfulMover`).
struct GravityMover;
impl MovingObjectPhysics for GravityMover {
    fn has_gravity(&self) -> bool {
        true
    }
}

/// Gate values mirror `system.rs::transition_profile` — every `USE_*` const is
/// currently `true` (read 2026-07-18):
///   USE_STEP_UP_DOWN=true, USE_WALKABLE_STEP_DOWN=true, USE_LANDING_WALKABLE=true,
///   USE_WATER_COLLISION=true, USE_TERRAIN_WALKABLE_GATE=true,
///   USE_LOCAL_ENVCELL_ENTRY=true, USE_RAMP_FLOOR_SNAP_FIX=true,
///   SKIP_PARENTED_ENTITY_COLLISION=true, USE_WALKABLE_REINSERT_PROBE=true,
///   USE_OUTDOOR_STATIC_GROUNDING=true, USE_RETAIL_GROUND=true.
fn gates() -> TransitionGates {
    TransitionGates {
        step_up_down: true,
        walkable_step_down: true,
        landing_walkable: true,
        water_collision: true,
        terrain_walkable_gate: true,
        local_envcell_entry: true,
        ramp_floor_snap_fix: true,
        skip_parented_entities: true,
        walkable_reinsert_probe: true,
        outdoor_static_grounding: true,
        retail_ground: true,
    }
}

fn pose(x: f32, y: f32, z: f32) -> WorldPosition {
    WorldPosition {
        landblock_id: Guid(REPRO_CELL),
        coords: Vector3::new(x, y, z),
        rotation: Quaternion::identity(),
    }
}

fn input_for(begin: WorldPosition, end: WorldPosition) -> TransitionInput {
    TransitionInput {
        begin,
        end,
        // for_local_player: state = CONTACT | EDGE_SLIDE, radius 0.4, height 1.8,
        // step_up 0.6, step_down 1.5 — exactly what transition_profile yields
        // (USE_EDGE_SLIDE=true, USE_SETUP_STEP_HEIGHTS with player Setup = 0.6/1.5).
        object: ObjectInfo::for_local_player(None, None, true, Guid(1)),
        airborne: false,
        descending: false,
        force_grounded: false,
        gates: gates(),
        last_known_wall_normal: None,
        frames_stationary_fall: 0,
        last_contact_plane: None,
    }
}

/// Build the 5-cell scene from the real DATs. `None` ⇒ dats unavailable (skip).
fn build_scene() -> Option<SpatialScene> {
    let portal_dat = DatDatabase::new(portal_dat_path()).ok()?;
    let cell_dat = DatDatabase::new(cell_dat_path()).ok()?;

    let env_bytes = portal_dat.get_file(ENV_840).ok()?;
    let environment = Environment::unpack(&mut Cursor::new(&env_bytes)).ok()?;

    let mut scene = SpatialScene::new();
    for cell_low in 0x016A..=0x016E {
        let cell_id: u32 = 0xA9B4_0000 | cell_low;
        let bytes = cell_dat.get_file(cell_id).ok()?;
        let envcell = EnvCell::unpack(&mut Cursor::new(&bytes)).ok()?;
        let cell_struct = environment
            .cells
            .get(&(envcell.cell_structure as u32))
            .expect("cell_structure present in Environment 840");

        let cell_origin = Vector3::new(
            envcell.position.origin.x + LB_X * 192.0,
            envcell.position.origin.y + LB_Y * 192.0,
            envcell.position.origin.z,
        );
        let cell_orientation = envcell.position.orientation;

        // physics BSP
        let resolved = resolve_cell_physics_polygons(&cell_struct.physics_polygons, |vid| {
            cell_struct
                .vertex_array
                .vertices
                .get(&vid)
                .map(|sw| Vector3::new(sw.origin.x, sw.origin.y, sw.origin.z))
        });
        if let Some(tree) = cell_struct.physics_bsp.clone() {
            scene.insert_cell_physics_bsp(
                cell_id,
                CellPhysicsBsp {
                    tree,
                    polys: resolved,
                    origin: cell_origin,
                    orientation: cell_orientation,
                    scale: 1.0,
                },
            );
        }

        // membership BSP
        if let Some(tree) = cell_struct.cell_bsp.clone() {
            scene.insert_cell_membership(
                cell_id,
                CellMembership {
                    tree,
                    origin: cell_origin,
                    orientation: cell_orientation,
                },
            );
        }

        // world-space AABB over the cell's vertices, padded 0.1
        let mut min = Vector3::new(f32::MAX, f32::MAX, f32::MAX);
        let mut max = Vector3::new(f32::MIN, f32::MIN, f32::MIN);
        for sw in cell_struct.vertex_array.vertices.values() {
            let v = Vector3::new(sw.origin.x, sw.origin.y, sw.origin.z);
            let w = cell_orientation.rotate_vector(v) + cell_origin;
            min.x = min.x.min(w.x);
            min.y = min.y.min(w.y);
            min.z = min.z.min(w.z);
            max.x = max.x.max(w.x);
            max.y = max.y.max(w.y);
            max.z = max.z.max(w.z);
        }
        let pad = 0.1;
        scene.insert_cell_aabb(
            cell_id,
            Aabb::new(
                Vector3::new(min.x - pad, min.y - pad, min.z - pad),
                Vector3::new(max.x + pad, max.y + pad, max.z + pad),
            ),
        );

        // portal graph (portals + visible_cells; insert_cell_portal dedupes)
        for p in &envcell.portals {
            let other = 0xA9B4_0000 | p.other_cell_id as u32;
            if p.other_cell_id != 0 && other != cell_id {
                scene.insert_cell_portal(cell_id, other);
            }
        }
        for &vc in &envcell.visible_cells {
            let other = 0xA9B4_0000 | vc as u32;
            if vc != 0 && other != cell_id {
                scene.insert_cell_portal(cell_id, other);
            }
        }
    }
    Some(scene)
}

/// Realized displacement (world-space XY magnitude) for the faithful bridge.
fn faithful_delta(env: &TestEnv, input: &TransitionInput) -> (f32, TransitionOutcome) {
    let out = faithful_find_transitional_position(env, input, true, true);
    let b = input.begin.global_coords();
    let g = out.pose.global_coords();
    let d = ((g.x - b.x).powi(2) + (g.y - b.y).powi(2) + (g.z - b.z).powi(2)).sqrt();
    (d, out)
}

/// Raw `CTransition` drive — mirrors `faithful_bridge::drift::raw_drive`.
/// Returns (realized |Δ|, found, curr-pos delta, dumped internals string).
fn raw_drive(env: &TestEnv, input: &TransitionInput) -> (f32, i32, String) {
    let scene = env.scene();
    let begin_cell = scene.current_cell(&input.begin);
    let end_cell = scene.current_cell(&input.end);
    let mut bf = Frame::identity();
    bf.origin = input.begin.global_coords();
    let begin_pos = Position {
        objcell_id: begin_cell,
        frame: bf,
    };
    let mut ef = Frame::identity();
    ef.origin = input.end.global_coords();
    let end_pos = Position {
        objcell_id: end_cell,
        frame: ef,
    };
    let r = input.object.radius;
    let h = input.object.height;
    let spheres = [
        Sphere {
            center: Vector3::new(0.0, 0.0, r),
            radius: r,
        },
        Sphere {
            center: Vector3::new(0.0, 0.0, (h - r).max(r)),
            radius: r,
        },
    ];
    let mut t = CTransition::new();
    t.object_info.scale = 1.0;
    t.object_info.state = input.object.state;
    t.object_info.step_up_height = input.object.step_up_height;
    t.object_info.step_down_height = input.object.step_down_height;
    t.object_info.ethereal = input.object.ethereal;
    // Mirror faithful_find_transitional_position's retail_ground pre-setup
    // (faithful_bridge.rs:1027-1189) EXACTLY so the raw internals reflect the
    // real (refusing) path — this is what my earlier naive raw_drive omitted.
    t.faithful_stepup = true; // faithful_stepup arg is true
    t.retail_ground = input.gates.retail_ground; // true
    // begin_on_walkable: faithful_terrain_normal is None indoors → false.
    let grounded_entry = !input.airborne || input.force_grounded; // true
    if t.faithful_stepup && grounded_entry && input.begin.is_indoors() {
        t.object_info.state |= object_info_state::ON_WALKABLE;
    }
    if input.gates.retail_ground {
        t.object_info.step_down = true;
        // last_contact_plane is None in this harness → the live_contact block is
        // skipped; grounded_entry stamps CONTACT|ON_WALKABLE (the retail latch).
        if grounded_entry {
            t.object_info.state |= object_info_state::CONTACT | object_info_state::ON_WALKABLE;
        }
    }
    t.init_sphere(2, &spheres, 1.0);
    t.init_path(Some(begin_cell), Some(&begin_pos), &end_pos);
    let world = SceneWorld::new(scene);
    let mover = GravityMover;
    let found = t.find_valid_position(&world, &mover);

    let b = input.begin.global_coords();
    let cur = t.sphere_path.curr_pos.frame.origin;
    let d = ((cur.x - b.x).powi(2) + (cur.y - b.y).powi(2) + (cur.z - b.z).powi(2)).sqrt();
    let st = t.object_info.state;
    let dump = format!(
        "found={found} |Δ|={d:.4} begin_cell={begin_cell:#x} end_cell={end_cell:#x} \
         check_cell={:?} CONTACT={} ON_WALKABLE={} walkable={} contact_plane={:?} \
         last_known={:?} coll_normal={:?}",
        t.sphere_path.check_cell.map(|c| format!("{c:#x}")),
        st & object_info_state::CONTACT != 0,
        st & object_info_state::ON_WALKABLE != 0,
        t.sphere_path.walkable.is_some(),
        t.collision_info.contact_plane.map(|p| (p.normal, p.d)),
        t.collision_info.last_known_contact_plane.map(|p| (p.normal, p.d)),
        t.collision_info.collision_normal,
    );
    (d, found, dump)
}

const DIRS: [(&str, f32, f32); 4] = [
    ("+y", 0.0, 1.0),
    ("+x", 1.0, 0.0),
    ("-y", 0.0, -1.0),
    ("-x", -1.0, 0.0),
];

fn run_pose(env: &TestEnv, label: &str, begin: WorldPosition) {
    eprintln!("\n==== {label} pose local=({:.3},{:.3},{:.3}) ====", begin.coords.x, begin.coords.y, begin.coords.z);
    let bc = env.scene.current_cell(&begin);
    eprintln!("  current_cell(begin) = {bc:#x}  (expect 0xa9b4016e)");
    for mag in [0.1_f32, 0.5_f32] {
        for (name, dx, dy) in DIRS {
            let mut end = begin;
            end.coords.x += dx * mag;
            end.coords.y += dy * mag;
            let input = input_for(begin, end);
            let (fd, out) = faithful_delta(env, &input);
            let (rd, _found, dump) = raw_drive(env, &input);
            let verdict = if fd > 0.05 { "moved" } else { "REFUSED" };
            eprintln!(
                "  dir={name} mag={mag:.1} | FAITHFUL |Δ|={fd:.4} grounded={} state={:?} cp={:?}  [{verdict}]",
                out.grounded, out.state, out.contact_plane.map(|(p, _)| p.normal),
            );
            eprintln!("      RAW  |Δ|={rd:.4}  {dump}");
        }
    }
}

/// The local player's per-transition object description (matches `input_for`).
fn player_object() -> ObjectInfo {
    ObjectInfo::for_local_player(None, None, true, Guid(1))
}

/// XY distance between two world poses.
fn xy_dist(a: &WorldPosition, b: &WorldPosition) -> f32 {
    let ga = a.global_coords();
    let gb = b.global_coords();
    ((ga.x - gb.x).powi(2) + (ga.y - gb.y).powi(2)).sqrt()
}

/// The retail arrival-placement path (`faithful_find_placement_position`, the
/// port of `CPhysicsObj::SetPosition`'s `find_placement_position`,
/// acclient.c:313341) must DE-EMBED the reported grocer-vestibule pose: the
/// 0.4 m capsule teleported to lb-local (81,33,94.35) sits ~0.37 m inside the
/// y=−2.15 wall. Assert the search returns a pose that is no longer embedded,
/// that it settles grounded, and that a transitional slice then MOVES from the
/// adjusted pose (movement restored — the whole point of the fix).
#[test]
fn env840_arrival_placement_deembeds() {
    let Some(scene) = build_scene() else {
        eprintln!("SKIP env840_arrival_placement_deembeds: portal/cell dats unavailable");
        return;
    };
    let env = TestEnv { scene };

    let repro = pose(81.0, 33.0, 94.35);
    let object = player_object();
    let g = gates();

    let outcome = faithful_find_placement_position(&env, &repro, &object, &g)
        .expect("placement search must find a valid de-embedded pose");

    let moved = xy_dist(&outcome.pose, &repro);
    eprintln!(
        "  placement adjusted lb-local ({:.3},{:.3},{:.3}) → ({:.3},{:.3},{:.3})  |Δxy|={moved:.3}m grounded={} cell={:#x}",
        repro.coords.x, repro.coords.y, repro.coords.z,
        outcome.pose.coords.x, outcome.pose.coords.y, outcome.pose.coords.z,
        outcome.grounded, outcome.pose.landblock_id.0,
    );

    // Cell-local de-embed check. The vestibule (env 840 struct 4) box has walls
    // at cell-local y=−2.15 and y=−0.25; a 0.4 m sphere is free when its centre
    // sits in the band [−1.75,−0.65] OR clears BOTH walls by ≥ radius−0.02.
    let bsp = env
        .scene
        .cell_physics_bsp(REPRO_CELL)
        .expect("vestibule physics BSP resident");
    let local = bsp.world_to_local(outcome.pose.global_coords());
    let radius = object.radius;
    let clear_of_walls = (local.y - (-2.15)).abs() >= radius - 0.02
        && (local.y - (-0.25)).abs() >= radius - 0.02;
    let in_free_band = (-1.75..=-0.65).contains(&local.y);
    eprintln!(
        "  cell-local=({:.3},{:.3},{:.3}) in_free_band={in_free_band} clear_of_walls={clear_of_walls}",
        local.x, local.y, local.z,
    );
    assert!(
        in_free_band || clear_of_walls,
        "adjusted pose still embedded: cell-local y={:.3} (walls at -2.15 / -0.25, radius {radius})",
        local.y,
    );

    assert!(
        outcome.grounded,
        "placement must settle grounded (floor z=0 contact plane)"
    );

    // Movement restored: drive a 0.5 m transitional slice from the adjusted pose
    // in each global cardinal; at least two must realize > 0.05 m.
    let adjusted = outcome.pose;
    let mut moved_dirs = 0;
    for (name, dx, dy) in DIRS {
        let mut end = adjusted;
        end.coords.x += dx * 0.5;
        end.coords.y += dy * 0.5;
        let (fd, out) = faithful_delta(&env, &input_for(adjusted, end));
        let did = fd > 0.05;
        moved_dirs += did as i32;
        eprintln!(
            "  from-adjusted dir={name} |Δ|={fd:.4} grounded={} [{}]",
            out.grounded,
            if did { "moved" } else { "refused" },
        );
    }
    assert!(
        moved_dirs >= 2,
        "movement not restored from the de-embedded pose ({moved_dirs}/4 dirs moved)"
    );
}

/// Walk from the mid-vestibule control pose toward the 0xA9B4016A portal
/// (global ≈ (−0.7071,+0.7071,0), i.e. cell-local −x) in 0.25 m transitional
/// slices, carrying `last_contact_plane` forward exactly as the movement system
/// does. Assert the accumulated travel crosses the seam into 0xA9B4016A and the
/// mover stays grounded. A FAILURE here is a genuine second bug layer (the
/// transitional seam-crossing itself), NOT the arrival-placement fix.
#[test]
fn env840_seam_cross_into_room() {
    let Some(scene) = build_scene() else {
        eprintln!("SKIP env840_seam_cross_into_room: portal/cell dats unavailable");
        return;
    };
    let env = TestEnv { scene };
    let object = player_object();
    let g = gates();

    // Seed grounded contact via the arrival-placement path (the system runs
    // placement on arrival, then movement carries `last_contact_plane` forward).
    let control = pose(81.44, 33.86, 94.1);
    let seed = faithful_find_placement_position(&env, &control, &object, &g)
        .expect("control pose placement must succeed");
    eprintln!(
        "  seed grounded={} cell={:#x} contact_plane={:?}",
        seed.grounded,
        seed.pose.landblock_id.0,
        seed.contact_plane.map(|(p, _)| p.normal),
    );

    // Unit global heading toward the 0x016A portal.
    let (hx, hy) = {
        let (x, y) = (-0.7071_f32, 0.7071_f32);
        let l = (x * x + y * y).sqrt();
        (x / l, y / l)
    };

    let mut cur = seed.pose;
    let mut last_cp = seed.contact_plane;
    let mut accumulated = 0.0_f32;
    let mut grounded_throughout = seed.grounded;
    let mut reached_cell = env.scene.current_cell(&cur);

    for step in 0..12 {
        let mut end = cur;
        end.coords.x += hx * 0.25;
        end.coords.y += hy * 0.25;
        let mut input = input_for(cur, end);
        input.last_contact_plane = last_cp;
        let out = faithful_find_transitional_position(&env, &input, true, true);
        let d = xy_dist(&out.pose, &cur);
        accumulated += d;
        grounded_throughout &= out.grounded;
        last_cp = out.contact_plane;
        cur = out.pose;
        reached_cell = env.scene.current_cell(&cur);
        eprintln!(
            "  step {step}: |Δ|={d:.4} accum={accumulated:.3} cell={reached_cell:#x} grounded={} state={:?}",
            out.grounded, out.state,
        );
    }

    eprintln!(
        "  FINAL accum={accumulated:.3}m cell={reached_cell:#x} grounded_throughout={grounded_throughout}"
    );
    assert!(
        accumulated >= 1.5,
        "insufficient travel toward the portal: {accumulated:.3}m (< 1.5m)"
    );
    assert_eq!(
        reached_cell, 0xA9B4_016A,
        "did not cross the seam into 0xA9B4016A (ended in {reached_cell:#x})"
    );
    assert!(
        grounded_throughout,
        "mover lost grounding while crossing the seam"
    );
}

/// Per-slice run-speed crossing of the grocer seam, mirroring the LIVE movement
/// system's frame-to-frame threading (`MovementSystem::finish_manual_slice_via_
/// transition`, system.rs:6010-6425): grounded direct-set planar velocity, the
/// airborne gravity integration (`UpdatePhysicsInternal`, acclient.c:317701-
/// 317786), the `descending = vz <= 0` seed, `begin_fall`/`land` on the grounded
/// diff, the `last_contact_plane` carry, and the retail stationary-fall carry
/// (seed acclient.c:320104-320115, read-back acclient.c:321862-321918).
///
/// This is the HEALTHY arm of the live RUN A/B: with forward free, the run
/// carries the mover past the doorway step and it re-grounds — asserts the
/// crossing completes (reaches 0xA9B4016A, re-latches grounded, no frozen
/// airborne run). The wedge state itself — forward BLOCKED at the step, pinned
/// airborne over the riser — is reproduced by
/// [`env840_riser_wedge_stationary_fall_regrounds`] below.
#[test]
fn env840_run_seam_wedge_slice_loop() {
    let Some(scene) = build_scene() else {
        eprintln!("SKIP env840_run_seam_wedge_slice_loop: portal/cell dats unavailable");
        return;
    };
    let env = TestEnv { scene };

    // The RUN A/B start (live): grounded in vestibule 0xA9B4016E at lb-local
    // (81,33,94.355), facing north (+y), holding forward. The vestibule floor
    // sits ~0.355 m ABOVE the 0xA9B4016A room floor (z=94.0), so the run crosses
    // the seam and STEPS DOWN — the descent the live wedge freezes mid-way. We
    // seed grounded with NO stored plane and let the first slice's transition
    // plant the vestibule floor contact (mirrors the live grounded-walk entry;
    // NOT the placement path, which would over-relocate straight into the room
    // and skip the step-down that triggers the bug).
    let start = pose(81.0, 33.0, 94.355);
    let seed_grounded = true;
    let seed_cp: Option<(holtburger_common::Plane, u32)> = None;
    eprintln!(
        "  start lb-local=({:.3},{:.3},{:.3}) cell={:#x} (vestibule; room floor z=94.0)",
        start.coords.x, start.coords.y, start.coords.z,
        env.scene.current_cell(&start),
    );
    // ── Live per-slice constants ──
    const DT: f32 = 1.0 / 30.0; // 33 ms slice (30 fps)
    const RUN_SPEED: f32 = 4.0; // resolved_manual_run_speed (~4 m/s N)
    const AZ: f32 = -9.8; // PhysicsGlobals::gravity
    const MAX_VELOCITY: f32 = 50.0;

    // ── Local player state carried frame-to-frame (mirrors PlayerState) ──
    let mut cur = start;
    let mut is_airborne = !seed_grounded;
    let mut vertical_velocity = 0.0_f32;
    let mut planar = Vector3::new(0.0, RUN_SPEED, 0.0); // held forward, north
    let mut last_cp = seed_cp;
    let mut fsf_store = 0_u8; // retail transient_state 0x10/0x20 carry

    let mut min_z_after_cross = f32::MAX;
    let mut reached_016a = false;
    let mut grounded_after_cross_slices = 0;
    let mut wedge_slices = 0; // consecutive airborne+near-frozen slices

    eprintln!("\n  slice  cell        y        z       g  air  vz      |Δ|");
    for step in 0..80 {
        let was_airborne = is_airborne;

        // advance_manual_slice_via_transition (system.rs:5905-5997): grounded
        // direct-sets planar from interpreted run velocity; airborne freezes it.
        if !was_airborne {
            planar = Vector3::new(0.0, RUN_SPEED, 0.0);
        }
        let mut raw = Vector3::new(planar.x * DT, planar.y * DT, 0.0);

        // finish_manual_slice_via_transition airborne integration
        // (system.rs:6046-6114): recompute v, terminal clamp, stop check,
        // position from clamped old velocity + gravity half-step, v += a·q.
        let mut descending = true;
        let dz = if was_airborne {
            let (mut vx, mut vy, mut vz) = (planar.x, planar.y, vertical_velocity);
            let mut mag2 = vx * vx + vy * vy + vz * vz;
            let d;
            if mag2 > 0.0 {
                if mag2 > MAX_VELOCITY * MAX_VELOCITY {
                    let len = mag2.sqrt();
                    vx = vx / len * MAX_VELOCITY;
                    vy = vy / len * MAX_VELOCITY;
                    vz = vz / len * MAX_VELOCITY;
                    mag2 = MAX_VELOCITY * MAX_VELOCITY;
                }
                if mag2 - 0.25 * 0.25 < 0.0002 {
                    vx = 0.0;
                    vy = 0.0;
                    vz = 0.0;
                }
                d = vz * DT + 0.5 * AZ * DT * DT;
                raw.x = vx * DT;
                raw.y = vy * DT;
            } else {
                d = 0.0;
                raw.x = 0.0;
                raw.y = 0.0;
            }
            vz += AZ * DT;
            planar.x = vx;
            planar.y = vy;
            vertical_velocity = vz;
            descending = vz <= 0.0;
            d
        } else {
            raw.z
        };

        let mut end = cur;
        end.coords.x += raw.x;
        end.coords.y += raw.y;
        end.coords.z += dz;

        let mut input = input_for(cur, end);
        input.airborne = was_airborne;
        input.descending = descending;
        input.last_contact_plane = last_cp;
        input.frames_stationary_fall = fsf_store;

        let out = faithful_find_transitional_position(&env, &input, true, true);
        let d = xy_dist(&out.pose, &cur);

        // Retail stationary-fall read-back (acclient.c:321862-321918); the
        // kill fires only on the frame the counter ADVANCED — see the system
        // read-back's leapfrog note (movement/system.rs).
        if out.frames_stationary_fall > 1 && out.frames_stationary_fall != fsf_store {
            planar = Vector3::zero();
            vertical_velocity = 0.0;
        }
        fsf_store = match out.frames_stationary_fall {
            1 | 2 => out.frames_stationary_fall,
            _ => 0,
        };

        // Grounded diff → land / begin_fall (system.rs:6207-6256).
        if was_airborne && out.grounded {
            is_airborne = false;
            vertical_velocity = 0.0;
        } else if !was_airborne && !out.grounded {
            is_airborne = true;
            vertical_velocity = 0.0;
        }
        // retail_ground: last_contact_plane ← the transition's settled plane.
        last_cp = out.contact_plane;
        cur = out.pose;

        let cell = env.scene.current_cell(&cur);
        if cell == 0xA9B4_016A {
            reached_016a = true;
        }
        if reached_016a {
            min_z_after_cross = min_z_after_cross.min(cur.coords.z);
            if out.grounded {
                grounded_after_cross_slices += 1;
            }
            // A wedge slice: airborne, essentially no XY progress.
            if is_airborne && d < 0.01 {
                wedge_slices += 1;
            } else {
                wedge_slices = 0;
            }
        }

        eprintln!(
            "  {step:>4}  {cell:#010x}  {:.3}  {:.3}  {}  {}   {:+.3}  {:.4}",
            cur.coords.y, cur.coords.z,
            out.grounded as u8, is_airborne as u8, vertical_velocity, d,
        );

        // Detect the wedge early (many consecutive frozen airborne slices).
        if wedge_slices >= 20 {
            eprintln!("  >>> WEDGE detected: {wedge_slices} consecutive frozen airborne slices");
            break;
        }
    }

    eprintln!(
        "\n  FINAL cell={:#x} grounded_slices_after_cross={grounded_after_cross_slices} \
         reached_016a={reached_016a} min_z_after_cross={min_z_after_cross:.3}",
        cur.landblock_id.0,
    );

    // Post-fix assertions: the run crossing completes and re-grounds.
    assert!(reached_016a, "run never crossed the seam into 0xA9B4016A");
    assert!(
        grounded_after_cross_slices >= 3,
        "mover did not re-latch grounded after the seam step-down \
         (grounded slices after cross = {grounded_after_cross_slices}) — the RUN wedge"
    );
    assert!(
        wedge_slices < 20,
        "mover WEDGED: {wedge_slices} consecutive frozen airborne slices after crossing"
    );
}

/// THE grocer-seam RUN-wedge reproduction (ticket uhf1nw), driver-level.
///
/// The wedge state, proven live and by the killed-probe forensics: the run
/// crosses the doorway step, goes briefly airborne off the step edge, and —
/// with forward blocked (door) — ends pinned OVER THE STEP RISER ~1.3 cm above
/// the room floor (z=94.0), grounded=false, planar velocity dead. Every
/// subsequent descending slice then fails the same way inside
/// `transitional_insert` (acclient.c:312834):
///   1. the descending sweep front-face hits the doorway floor poly →
///      `set_collide` (resolver_find.rs:266-271, acclient.c:361449-361460);
///   2. the collide latch's `find_walkable` ADJUSTS the sphere onto the
///      z=94.0 plane and sets the contact plane (resolver_find.rs:165-207,
///      acclient.c:361378-361409);
///   3. the collide block's Placement re-insert (driver_spine.rs:193-198,
///      acclient.c:312904-312912) finds the adjusted rest position INTERSECTS
///      the step-riser solid → COLLIDED → `restore_check_pos` + contact AND
///      last_known cleared (driver_spine.rs:206-221, acclient.c:312919-312935);
///   4. `validate_transition` BRANCH-A has nothing to re-seat → the frame ends
///      contact-less; `grounded` stays false, the airborne lane keeps input
///      frozen, and the cycle repeats forever.
///
/// Retail cannot stay in this cycle: `CPhysicsObj::transition` seeds each
/// frame's counter from the persistent `transient_state` STATIONARY_FALL bits
/// (acclient.c:320104-320115), `validate_transition` advances it on every
/// falling frame that failed to move (redoa==false, acclient.c:312279-312312),
/// and at 2 the next failed frame SYNTHESIZES a flat resting floor under the
/// sphere (acclient.c:312283-312311) — the mover grounds in place ~3 wedged
/// frames in. The post-transition read-back (acclient.c:321862-321918) zeroes
/// the velocity at >1 and persists 1/2. This test drives that exact carry the
/// way `MovementSystem::finish_manual_slice_via_transition` does.
///
/// PRE-FIX (no cross-frame carry: seed always 0) the mover here hovers
/// airborne forever — the reproduction. POST-FIX it re-grounds within a few
/// slices, in place (no invented nudge: the synthesized floor is at the
/// sphere's own bottom).
#[test]
fn env840_riser_wedge_stationary_fall_regrounds() {
    let Some(scene) = build_scene() else {
        eprintln!("SKIP env840_riser_wedge_stationary_fall_regrounds: dats unavailable");
        return;
    };
    let env = TestEnv { scene };

    const DT: f32 = 1.0 / 30.0;
    const AZ: f32 = -9.8;

    // The pinned wedge state: over the riser (vestibule side of the step,
    // membership still 0xA9B4016E), 1.35 cm above the room floor, airborne,
    // planar velocity dead (forward blocked ⇒ the airborne lane froze it at
    // zero), no stored contact plane (the collide block cleared it).
    let start_z = 94.0135_f32;
    let mut cur = WorldPosition {
        landblock_id: Guid(0xA9B4_016E),
        coords: Vector3::new(81.0, 33.45, start_z),
        rotation: Quaternion::identity(),
    };
    assert_eq!(
        env.scene.current_cell(&cur),
        0xA9B4_016E,
        "wedge pose must sit on the vestibule side of the step"
    );

    let mut vz = 0.0_f32;
    let mut last_cp: Option<(holtburger_common::Plane, u32)> = None;
    let mut fsf_store = 0_u8;
    let mut grounded_slices = 0;
    let mut first_grounded_slice: Option<usize> = None;

    eprintln!("\n  slice  z        g  fsf  vz");
    for step in 0..20 {
        // Airborne gravity integration (system.rs finish_manual_slice airborne
        // lane; UpdatePhysicsInternal, acclient.c:317701-317786) — planar dead.
        let dz = vz * DT + 0.5 * AZ * DT * DT;
        vz += AZ * DT;
        let mut end = cur;
        end.coords.z += dz;
        let mut input = input_for(cur, end);
        input.airborne = true;
        input.descending = true;
        input.last_contact_plane = last_cp;
        input.frames_stationary_fall = fsf_store;

        let out = faithful_find_transitional_position(&env, &input, true, true);

        // Retail read-back (acclient.c:321862-321918); advance-guarded kill
        // (see the system read-back's leapfrog note, movement/system.rs).
        if out.frames_stationary_fall > 1 && out.frames_stationary_fall != fsf_store {
            vz = 0.0;
        }
        fsf_store = match out.frames_stationary_fall {
            1 | 2 => out.frames_stationary_fall,
            _ => 0,
        };
        last_cp = out.contact_plane;
        cur = out.pose;
        if out.grounded {
            grounded_slices += 1;
            first_grounded_slice.get_or_insert(step);
            vz = 0.0;
        }
        eprintln!(
            "  {step:>4}  {:.4}  {}  {}    {:+.3}",
            cur.coords.z, out.grounded as u8, out.frames_stationary_fall, vz,
        );
    }

    eprintln!(
        "  first_grounded_slice={first_grounded_slice:?} grounded_slices={grounded_slices} final_z={:.4}",
        cur.coords.z,
    );
    assert!(
        grounded_slices >= 3,
        "RUN WEDGE reproduced: the pinned airborne mover never re-grounded \
         (retail's stationary-fall resting-floor synthesis did not fire)"
    );
    // Retail grounds IN PLACE (the synthesized floor sits at the sphere's own
    // bottom) — the settle must stay within the hover band, not warp.
    assert!(
        (cur.coords.z - 94.0).abs() < 0.05,
        "re-ground settled far from the hover band: z={:.4}",
        cur.coords.z,
    );
}

#[test]
fn env840_grocer_seam_diagnosis() {
    let Some(scene) = build_scene() else {
        eprintln!("SKIP env840_grocer_seam_diagnosis: portal/cell dats unavailable");
        return;
    };
    let env = TestEnv { scene };

    // ── Sanity: cell resolution + membership containment ──
    eprintln!("=== SANITY: scene cell inventory ===");
    for cell_low in 0x016A..=0x016E {
        let cell_id = 0xA9B4_0000 | cell_low;
        let aabb = env.scene.cell_aabb(cell_id);
        let has_phys = env.scene.cell_physics_bsp(cell_id).is_some();
        let has_mem = env.scene.cell_membership(cell_id).is_some();
        eprintln!(
            "  cell {cell_id:#x}: phys_bsp={has_phys} membership={has_mem} aabb={:?}",
            aabb.map(|a| (a.min, a.max)),
        );
    }

    // repro pose: landblock-local (81,33,94.35) ≈ cell-local (4.243,-2.121,0.35)
    let repro = pose(81.0, 33.0, 94.35);
    // control pose: mid-vestibule, landblock-local (81.44,33.86,94.1)
    let control = pose(81.44, 33.86, 94.1);

    // membership test of both points against each cell
    eprintln!("\n=== MEMBERSHIP: which cells claim each point ===");
    for (nm, p) in [("repro", &repro), ("control", &control)] {
        let g = p.global_coords();
        let mut claims = Vec::new();
        for cell_low in 0x016A..=0x016E {
            let cell_id = 0xA9B4_0000 | cell_low;
            if let Some(m) = env.scene.cell_membership(cell_id) {
                if m.tree.point_inside_cell(&m.world_to_local(g)) {
                    claims.push(format!("{cell_id:#x}"));
                }
            }
        }
        eprintln!("  {nm} global=({:.2},{:.2},{:.2}) current_cell={:#x} membership_claims={:?}",
            g.x, g.y, g.z, env.scene.current_cell(p), claims);
    }

    // ── CONTROL first (proves the harness) ──
    run_pose(&env, "CONTROL", control);

    // ── REPRO ──
    run_pose(&env, "REPRO", repro);

    // ── turn-in-place (end == begin) at repro pose ──
    eprintln!("\n==== TURN-IN-PLACE at REPRO (end==begin) ====");
    let input = input_for(repro, repro);
    let (fd, out) = faithful_delta(&env, &input);
    let (rd, found, dump) = raw_drive(&env, &input);
    eprintln!(
        "  FAITHFUL |Δ|={fd:.4} grounded={} state={:?} contact_plane={:?}",
        out.grounded, out.state, out.contact_plane.map(|(p, _)| p.normal)
    );
    eprintln!("  RAW  |Δ|={rd:.4} found={found}  {dump}");

    // ── REPRO verdict summary (the deliverable) ──
    eprintln!("\n=== REPRO VERDICT (faithful bridge, mag 0.5) ===");
    let mut any_repro_moved = false;
    for (name, dx, dy) in DIRS {
        let mut end = repro;
        end.coords.x += dx * 0.5;
        end.coords.y += dy * 0.5;
        let (fd, _) = faithful_delta(&env, &input_for(repro, end));
        let m = fd > 0.05;
        any_repro_moved |= m;
        eprintln!("  REPRO dir={name}: {}", if m { "moved" } else { "refused" });
    }
    eprintln!("  REPRO any-direction-moved = {any_repro_moved}");

    // ── CONTROL assertion: harness must let the control pose move somewhere ──
    let mut any_control_moved = false;
    for (_name, dx, dy) in DIRS {
        let mut end = control;
        end.coords.x += dx * 0.5;
        end.coords.y += dy * 0.5;
        let (fd, _) = faithful_delta(&env, &input_for(control, end));
        any_control_moved |= fd > 0.05;
    }
    eprintln!("\n=== CONTROL any-direction-moved = {any_control_moved} (harness sanity) ===");
    assert!(
        any_control_moved,
        "CONTROL pose refused ALL directions — harness construction is wrong \
         (check AABB/frame/portal-graph wiring), not a real bug"
    );
    // Repro outcome is the deliverable, not an assertion.
}
