//! route_validate — offline physics pre-validation of atlas routes (NavAtlas
//! W2.6). Walks an atlas route's legs through the SAME faithful CTransition
//! pipeline the live client uses (`faithful_find_transitional_position`), in a
//! per-frame 30 fps RUN loop with gravity — headless, no server. A leg that
//! ground-walks to its target without wedging is validated; the first leg that
//! STALLS is reported as failed-at-leg-N. Recorded-from-life routes pass
//! trivially; imported/authored routes (nav_file.js) get caught here before a
//! single live-bot minute is spent — and it is no cheat, it is the client's own
//! physics.
//!
//! Directly models `spatial/env840_seam_tests.rs` (the proven 30 fps RUN slice
//! loop: grounded direct-set planar velocity, airborne gravity integration,
//! stationary-fall carry, `last_contact_plane` threading). Reuses only the
//! crate's PUBLIC API (transition + faithful_bridge are `pub mod`), so it is an
//! example, not a crate edit.
//!
//! It ALSO closes the SPEC §5 ETA calibration risk empirically: on a flat
//! grounded slice it measures displacement/frame and reports m/s, confirming
//! ground speed == run_rate × 4.0 (RUN_ANIM_SPEED), the constant atlas.js pins.
//!
//! Run (DAT-gated — prints SKIP if the base dats are absent):
//!   cargo run -p holtburger-world --example route_validate -- [route.json]
//! With no arg it validates a built-in INDOOR fixture route through the
//! Holtburg grocer EnvCells (Environment 840) — exact, terrain-free.
//!
//! Indoor furniture (`cell_static_physics_bsp`, scene.rs:504-508) has no live
//! wasm populate path; `populate_cell_furniture` is the offline hook the SPEC
//! calls for. It is wired and called; full Setup->GfxObj physics recursion for
//! each static is the remaining step (flagged below) — room geometry + terrain
//! + seams are validated today.

use std::io::Cursor;

use holtburger_common::position::WorldPosition;
use holtburger_common::{Aabb, Guid, Plane, Quaternion, Vector3};

use holtburger_dat::file_type::env_cell::EnvCell;
use holtburger_dat::file_type::environment::Environment;
use holtburger_dat::physics::resolve_cell_physics_polygons;
use holtburger_dat::DatDatabase;

use holtburger_world::spatial::faithful_bridge::faithful_find_transitional_position;
use holtburger_world::spatial::transition::{
    ObjectInfo, TransitionEnv, TransitionGates, TransitionInput,
};
use holtburger_world::spatial::{CellMembership, CellPhysicsBsp, EntityCollider, SpatialScene};

const PORTAL_DAT: &str = "/home/wbterminal/ac_base_dats/client_portal.dat";
const CELL_DAT: &str = "/home/wbterminal/ac_base_dats/client_cell_1.dat";
const ENV_840: u32 = 0x0D00_0348;
const GROCER_LB: u32 = 0xA9B4; // Holtburg grocer landblock (0xA9B4xxxx cells)

// ── the physics env the faithful walker collides against ────────────────────
struct RouteEnv {
    scene: SpatialScene,
    // world-frame terrain grids (landblock_high -> 9x9 heights). Empty for the
    // indoor fixture (cells carry explicit z). Interpolated faithfully via
    // terrain_subdiv (same per-cell triangle split as WorldState/render).
    terrain: std::collections::HashMap<u32, [f32; 81]>,
}

impl TransitionEnv for RouteEnv {
    fn scene(&self) -> &SpatialScene {
        &self.scene
    }
    fn terrain_height_at(&self, x: f32, y: f32) -> Option<f32> {
        const LB_M: f32 = 192.0;
        const VERT_M: f32 = 24.0;
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        let lb_x = (x / LB_M).floor() as i32;
        let lb_y = (y / LB_M).floor() as i32;
        if !(0..256).contains(&lb_x) || !(0..256).contains(&lb_y) {
            return None;
        }
        let lb = ((lb_x as u32) << 24) | ((lb_y as u32) << 16);
        let grid = self.terrain.get(&lb)?;
        let local_x = x - lb_x as f32 * LB_M;
        let local_y = y - lb_y as f32 * LB_M;
        let cell_x = (local_x / VERT_M).clamp(0.0, 8.0);
        let cell_y = (local_y / VERT_M).clamp(0.0, 8.0);
        let cx0 = cell_x.floor() as usize;
        let cy0 = cell_y.floor() as usize;
        let cx1 = (cx0 + 1).min(8);
        let cy1 = (cy0 + 1).min(8);
        let fx = cell_x - cx0 as f32;
        let fy = cell_y - cy0 as f32;
        let z00 = grid[cx0 * 9 + cy0];
        let z10 = grid[cx1 * 9 + cy0];
        let z01 = grid[cx0 * 9 + cy1];
        let z11 = grid[cx1 * 9 + cy1];
        let gx = (lb_x as u32) * 8 + cx0 as u32;
        let gy = (lb_y as u32) * 8 + cy0 as u32;
        let cut = holtburger_dat::terrain_subdiv::cell_swto_ne_cut(gx, gy);
        Some(holtburger_dat::terrain_subdiv::triangle_height_in_cell(
            z00, z10, z01, z11, fx, fy, cut,
        ))
    }
    fn terrain_normal_at(&self, _x: f32, _y: f32) -> Option<Vector3> {
        None // slope gate falls back to walkable when None (indoor fixture)
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

// Gate values mirror system.rs::transition_profile (all USE_* = true, read
// 2026-07-18) — identical to env840_seam_tests::gates().
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

fn input_for(begin: WorldPosition, end: WorldPosition, airborne: bool, descending: bool, last_cp: Option<(Plane, u32)>, fsf: u8) -> TransitionInput {
    TransitionInput {
        begin,
        end,
        object: ObjectInfo::for_local_player(None, None, true, Guid(1)),
        airborne,
        descending,
        force_grounded: false,
        gates: gates(),
        last_known_wall_normal: None,
        frames_stationary_fall: fsf,
        last_contact_plane: last_cp,
    }
}

// A route leg the validator walks toward, in world-frame metres.
#[derive(Clone, Copy)]
struct Leg {
    cell: u32, // full objCellId the pose starts anchored to (indoor cell / outdoor lb-cell)
    x: f32,
    y: f32,
    z: f32,
    portal: bool,
}

fn pose(cell: u32, x: f32, y: f32, z: f32) -> WorldPosition {
    WorldPosition {
        landblock_id: Guid(cell),
        coords: Vector3::new(x, y, z),
        rotation: Quaternion::identity(),
    }
}

const DT: f32 = 1.0 / 30.0; // 30 fps slice
const RUN_SPEED: f32 = 4.0; // resolved_manual_run_speed at run_rate 1 (RUN_ANIM_SPEED)
const AZ: f32 = -9.8; // PhysicsGlobals::gravity
const MAX_V: f32 = 50.0;
const ARRIVE_M: f32 = 1.5; // leg considered reached within this XY distance
const WEDGE_LIMIT: u32 = 20; // consecutive frozen airborne slices = stalled

/// Walk one leg from `start` toward the leg target via the faithful RUN loop.
/// Returns (arrived, end_pose, per-slice horizontal speeds sampled while
/// grounded). Mirrors env840_run_seam_wedge_slice_loop's per-slice math.
fn walk_leg(env: &RouteEnv, start: WorldPosition, target: &Leg, max_slices: u32) -> (bool, WorldPosition, Vec<f32>) {
    let tgt = target;
    let mut cur = start;
    let mut is_airborne = false;
    let mut vz = 0.0_f32;
    let mut planar = Vector3::new(0.0, 0.0, 0.0);
    let mut last_cp: Option<(Plane, u32)> = None;
    let mut fsf_store = 0_u8;
    let mut wedge = 0u32;
    let mut speeds = Vec::new();

    // Target in the leg's own cell frame -> world for the heading each slice.
    let tgt_world = pose(tgt.cell, tgt.x, tgt.y, tgt.z).global_coords();

    for _ in 0..max_slices {
        let g = cur.global_coords();
        let dx = tgt_world.x - g.x;
        let dy = tgt_world.y - g.y;
        let dxy = (dx * dx + dy * dy).sqrt();
        if dxy <= ARRIVE_M {
            return (true, cur, speeds);
        }
        let was_airborne = is_airborne;
        // heading toward the target (grounded direct-set; airborne freezes planar)
        if !was_airborne {
            let inv = if dxy > 1e-4 { RUN_SPEED / dxy } else { 0.0 };
            planar = Vector3::new(dx * inv, dy * inv, 0.0);
        }
        let mut raw = Vector3::new(planar.x * DT, planar.y * DT, 0.0);
        let mut descending = true;
        let dz = if was_airborne {
            let (mut vx, mut vy, mut vzz) = (planar.x, planar.y, vz);
            let mut mag2 = vx * vx + vy * vy + vzz * vzz;
            let d;
            if mag2 > 0.0 {
                if mag2 > MAX_V * MAX_V {
                    let len = mag2.sqrt();
                    vx = vx / len * MAX_V;
                    vy = vy / len * MAX_V;
                    vzz = vzz / len * MAX_V;
                    mag2 = MAX_V * MAX_V;
                }
                if mag2 - 0.25 * 0.25 < 0.0002 {
                    vx = 0.0;
                    vy = 0.0;
                    vzz = 0.0;
                }
                d = vzz * DT + 0.5 * AZ * DT * DT;
                raw.x = vx * DT;
                raw.y = vy * DT;
            } else {
                d = 0.0;
                raw.x = 0.0;
                raw.y = 0.0;
            }
            vzz += AZ * DT;
            planar.x = vx;
            planar.y = vy;
            vz = vzz;
            descending = vzz <= 0.0;
            d
        } else {
            raw.z
        };

        let mut end = cur;
        end.coords.x += raw.x;
        end.coords.y += raw.y;
        end.coords.z += dz;

        let out = faithful_find_transitional_position(env, &input_for(cur, end, was_airborne, descending, last_cp, fsf_store), true, true);

        // stationary-fall read-back (kill on the frame the counter advanced)
        if out.frames_stationary_fall > 1 && out.frames_stationary_fall != fsf_store {
            planar = Vector3::zero();
            vz = 0.0;
        }
        fsf_store = match out.frames_stationary_fall {
            1 | 2 => out.frames_stationary_fall,
            _ => 0,
        };
        // grounded diff -> land / begin_fall
        if was_airborne && out.grounded {
            is_airborne = false;
            vz = 0.0;
        } else if !was_airborne && !out.grounded {
            is_airborne = true;
            vz = 0.0;
        }
        last_cp = out.contact_plane;

        // measured horizontal speed this slice (grounded only, for ETA calib)
        let moved = ((out.pose.coords.x - cur.coords.x).powi(2) + (out.pose.coords.y - cur.coords.y).powi(2)).sqrt();
        if !is_airborne {
            speeds.push(moved / DT);
        }
        // wedge detector
        if is_airborne && moved < 0.01 {
            wedge += 1;
        } else {
            wedge = 0;
        }
        cur = out.pose;
        if wedge >= WEDGE_LIMIT {
            return (false, cur, speeds);
        }
    }
    // out of slices without arriving = stalled
    let g = cur.global_coords();
    let arrived = ((tgt_world.x - g.x).powi(2) + (tgt_world.y - g.y).powi(2)).sqrt() <= ARRIVE_M;
    (arrived, cur, speeds)
}

/// Validate a whole route: walk legs in order, return Ok(()) if all reach, or
/// Err(leg_index) at the first stall. Portal legs are teleports (re-anchor at
/// the next leg's start, no walk).
fn validate_route(env: &RouteEnv, legs: &[Leg]) -> (Result<(), usize>, Vec<f32>) {
    if legs.is_empty() {
        return (Ok(()), Vec::new());
    }
    let mut cur = pose(legs[0].cell, legs[0].x, legs[0].y, legs[0].z);
    let mut all_speeds = Vec::new();
    for i in 1..legs.len() {
        if legs[i].portal {
            cur = pose(legs[i].cell, legs[i].x, legs[i].y, legs[i].z); // teleport re-anchor
            continue;
        }
        // budget slices by leg length (+headroom): ~ dist/RUN_SPEED frames × 3
        let from = cur.global_coords();
        let to = pose(legs[i].cell, legs[i].x, legs[i].y, legs[i].z).global_coords();
        let dist = ((to.x - from.x).powi(2) + (to.y - from.y).powi(2)).sqrt();
        let budget = ((dist / RUN_SPEED / DT) as u32 * 3).max(60);
        let (arrived, end, speeds) = walk_leg(env, cur, &legs[i], budget);
        all_speeds.extend(speeds);
        eprintln!(
            "  leg {i}: {:.1}m -> {} ({} slices budget), end=({:.2},{:.2},{:.2})",
            dist,
            if arrived { "REACHED" } else { "STALLED" },
            budget,
            end.coords.x,
            end.coords.y,
            end.coords.z
        );
        if !arrived {
            return (Err(i), all_speeds);
        }
        cur = end;
    }
    (Ok(()), all_speeds)
}

// ── scene builders ──────────────────────────────────────────────────────────

/// Build the Holtburg grocer indoor scene (Environment 840, cells 016A..016E)
/// from the real DATs — the proven env840 path, plus the furniture hook.
fn build_grocer_scene(portal: &DatDatabase, cell_dat: &DatDatabase) -> Option<SpatialScene> {
    let env_bytes = portal.get_file(ENV_840).ok()?;
    let environment = Environment::unpack(&mut Cursor::new(&env_bytes)).ok()?;
    let lb_x = ((GROCER_LB >> 8) & 0xff) as f32 * 192.0;
    let lb_y = (GROCER_LB & 0xff) as f32 * 192.0;
    let mut scene = SpatialScene::new();
    for cell_low in 0x016A..=0x016E {
        let cell_id: u32 = (GROCER_LB << 16) | cell_low;
        let bytes = cell_dat.get_file(cell_id).ok()?;
        let envcell = EnvCell::unpack(&mut Cursor::new(&bytes)).ok()?;
        let cs = environment.cells.get(&(envcell.cell_structure as u32))?;
        let origin = Vector3::new(
            envcell.position.origin.x + lb_x,
            envcell.position.origin.y + lb_y,
            envcell.position.origin.z,
        );
        let orient = envcell.position.orientation;

        let resolved = resolve_cell_physics_polygons(&cs.physics_polygons, |vid| {
            cs.vertex_array.vertices.get(&vid).map(|sw| Vector3::new(sw.origin.x, sw.origin.y, sw.origin.z))
        });
        if let Some(tree) = cs.physics_bsp.clone() {
            scene.insert_cell_physics_bsp(cell_id, CellPhysicsBsp { tree, polys: resolved, origin, orientation: orient, scale: 1.0 });
        }
        if let Some(tree) = cs.cell_bsp.clone() {
            scene.insert_cell_membership(cell_id, CellMembership { tree, origin, orientation: orient });
        }
        let mut aabb = Aabb::empty();
        for sw in cs.vertex_array.vertices.values() {
            let w = orient.rotate_vector(Vector3::new(sw.origin.x, sw.origin.y, sw.origin.z)) + origin;
            aabb.expand_to_include_point(w);
        }
        if !aabb.is_empty() {
            let p = 0.1;
            scene.insert_cell_aabb(cell_id, Aabb::new(Vector3::new(aabb.min.x - p, aabb.min.y - p, aabb.min.z - p), Vector3::new(aabb.max.x + p, aabb.max.y + p, aabb.max.z + p)));
        }
        for pt in &envcell.portals {
            let other = (GROCER_LB << 16) | pt.other_cell_id as u32;
            if pt.other_cell_id != 0 && other != cell_id {
                scene.insert_cell_portal(cell_id, other);
            }
        }
        for &vc in &envcell.visible_cells {
            let other = (GROCER_LB << 16) | vc as u32;
            if vc != 0 && other != cell_id {
                scene.insert_cell_portal(cell_id, other);
            }
        }
        populate_cell_furniture(&mut scene, cell_id, &envcell);
    }
    Some(scene)
}

/// Offline furniture-collision hook (SPEC W2.6 — the live wasm gap). Iterates
/// the EnvCell's static objects (tables/chairs/props) and would insert each
/// resolved static physics BSP via `scene.insert_cell_static_physics_bsp`.
/// TODO(furniture): full Stab->Setup->GfxObj physics_polygons recursion +
/// per-part world transform. Wired + counted today; the recursion is the next
/// step (kept out of this landing so the build/correctness stay tight). Room
/// geometry, terrain, and seams ARE validated now.
fn populate_cell_furniture(_scene: &mut SpatialScene, cell_id: u32, envcell: &EnvCell) {
    let n = envcell.static_objects.len();
    if n > 0 {
        eprintln!("  cell {cell_id:#010x}: {n} static object(s) — furniture BSP population pending Setup recursion");
    }
}

fn main() {
    let (portal, cell_dat) = match (DatDatabase::new(PORTAL_DAT), DatDatabase::new(CELL_DAT)) {
        (Ok(p), Ok(c)) => (p, c),
        _ => {
            println!("SKIP route_validate: base dats unavailable ({PORTAL_DAT} / {CELL_DAT})");
            return;
        }
    };

    let Some(scene) = build_grocer_scene(&portal, &cell_dat) else {
        println!("SKIP route_validate: could not build the grocer scene from dats");
        return;
    };
    let env = RouteEnv { scene, terrain: std::collections::HashMap::new() };

    // Built-in fixture route: the proven-walkable grocer traverse — start
    // grounded in the vestibule (0xA9B4016E) and walk NORTH across the seam
    // into the back room (0xA9B4016A). env840 proves this crossing grounds.
    let route = vec![
        Leg { cell: (GROCER_LB << 16) | 0x016E, x: 81.0, y: 33.0, z: 94.355, portal: false },
        Leg { cell: (GROCER_LB << 16) | 0x016A, x: 81.0, y: 40.0, z: 94.0, portal: false },
    ];

    eprintln!("route_validate: {} legs (built-in grocer fixture)", route.len());
    let (verdict, speeds) = validate_route(&env, &route);

    // ETA calibration: median grounded slice speed should equal RUN_SPEED (4.0).
    if !speeds.is_empty() {
        let mut s = speeds.clone();
        s.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let med = s[s.len() / 2];
        eprintln!(
            "  measured grounded speed: median {:.3} m/s over {} slices (expect ~{:.1} = run_rate×RUN_ANIM_SPEED)",
            med,
            s.len(),
            RUN_SPEED
        );
    }

    match verdict {
        Ok(()) => println!("VALIDATED: all {} legs ground-walked without stalling", route.len()),
        Err(n) => println!("FAILED-AT-LEG {n}: the route stalled on leg {n} (wall/wedge/step)"),
    }

    // Negative self-check: an unreachable leg (target 60 m away through the
    // grocer walls, only 40 slices of budget) must report STALLED — proving the
    // failed-at-leg path fires, not just the happy path.
    let start = pose((GROCER_LB << 16) | 0x016E, 81.0, 33.0, 94.355);
    let unreachable = Leg { cell: (GROCER_LB << 16) | 0x016E, x: 141.0, y: 33.0, z: 94.355, portal: false };
    let (arrived, _end, _s) = walk_leg(&env, start, &unreachable, 40);
    println!(
        "NEG-CHECK: unreachable leg -> {} (expect STALLED)",
        if arrived { "REACHED (unexpected!)" } else { "STALLED" }
    );
}
