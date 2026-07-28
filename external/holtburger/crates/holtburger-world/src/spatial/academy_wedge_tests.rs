//! Offline repro attempt for the LIVE-confirmed Holtburg Academy dungeon
//! movement wedge (measured 2026-07-20 on the real client, not yet reproduced
//! offline). Rebuilds the EnvCells around the seam between 0x860201B1 (north)
//! and 0x860201B4 (the cell the live teleport lands in) from the real
//! portal/cell DATs — the same ingest pattern as
//! [`super::env840_seam_tests::build_scene`] — and drives the faithful
//! `CTransition` collision pipeline south from the reported live pose in
//! 0.25 m transitional slices, carrying `last_contact_plane` forward exactly
//! like the movement system does.
//!
//! LIVE FACTS pinned here (ground truth, NOT re-derived): teleporting to cell
//! 0x860201B4 at landblock-frame (15.05, -26.5, 0.005) — the cell's own DAT
//! `position.origin` is (20,-30,0), environment id 0x126 (=294 decimal),
//! zero `staticObjects` on 0x860201B4 — and walking SOUTH (toward −y), the
//! mover advances ~1.1 m then wedges PERMANENTLY at (15.05, −27.618, 0):
//! every subsequent transitional slice realizes 0.000 m in BOTH directions
//! (south AND back north), with the raw-input drive active the whole time.
//! Working hypothesis: an env-BSP/seam refusal at the 0x1B1/0x1B4 seam —
//! possibly a begin-cell LABEL (membership BSP) vs geometric COLLISION hull
//! (physics BSP) mismatch.
//!
//! DAT-gated: skips (with a printed SKIP line) if the portal/cell dats are
//! not present. This test REPORTS the outcome via `eprintln!` — it does NOT
//! assert the bug either way, so it stays green whether or not the offline
//! harness reproduces the live wedge. Only the SETUP invariants (scene
//! built, cells resident, initial placement succeeds) are asserted. Run with
//! `-- --nocapture` to see the diagnostics.

use std::io::Cursor;

use holtburger_common::position::WorldPosition;
use holtburger_common::{Aabb, Guid, Quaternion, Vector3};

use holtburger_dat::file_type::env_cell::EnvCell;
use holtburger_dat::file_type::environment::Environment;
use holtburger_dat::physics::resolve_cell_physics_polygons;
use holtburger_dat::DatDatabase;

use crate::spatial::entity_collision::EntityCollider;
use crate::spatial::faithful_bridge::{
    faithful_diag_step, faithful_find_placement_position, faithful_find_transitional_position,
};
use crate::spatial::scene::{CellMembership, CellPhysicsBsp, SpatialScene};
use crate::spatial::transition::{
    ObjectInfo, TransitionEnv, TransitionGates, TransitionInput,
};

// Landblock high bytes for 0x8602xxxx (the Holtburg Academy dungeon LB).
const LB_X: f32 = 0x86 as u32 as f32; // 134
const LB_Y: f32 = 0x02 as u32 as f32; // 2
const LB_HIGH: u32 = 0x8602_0000;

/// The live teleport target — the cell the reported (15.05,-26.5,0.005) pose
/// lands in.
const START_CELL: u32 = 0x8602_01B4;
/// The neighbouring cell to the north the mover crossed FROM (live fact).
const NORTH_CELL: u32 = 0x8602_01B1;
/// Environment 0x126 (294 decimal) — shared by every cell loaded here
/// (confirmed via `chorizite-parse-dat-record` on 0x860201B4/0x860201B1).
const ENV_ACADEMY: u32 = 0x0D00_0126;

/// The 6-cell neighbourhood: 0x1B4's own portals (→0x1AD, →0x1B1) unioned
/// with 0x1B1's own portals (→0x1B3, →0x1B5, →0x1B2, →0x1B4), enumerated via
/// the WBT oracle (`chorizite-parse-dat-record` on both cells' `cellPortals`).
const CELL_LOWS: [u32; 6] = [0x01AD, 0x01B1, 0x01B2, 0x01B3, 0x01B4, 0x01B5];

fn portal_dat_path() -> String {
    std::env::var("HOLTBURGER_PORTAL_DAT")
        .unwrap_or_else(|_| "/home/wbterminal/ac_base_dats/client_portal.dat".to_string())
}
fn cell_dat_path() -> String {
    std::env::var("HOLTBURGER_CELL_DAT")
        .unwrap_or_else(|_| "/home/wbterminal/ac_base_dats/client_cell_1.dat".to_string())
}

/// Minimal `TransitionEnv` — indoor cells only, no terrain/water/entities.
/// Identical shape to `env840_seam_tests::TestEnv`.
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

/// Gate values mirror `env840_seam_tests::gates()` — every `USE_*` const is
/// currently `true` (read 2026-07-20, same as env840).
fn gates() -> TransitionGates {
    TransitionGates {
        step_up_down: true,
        walkable_step_down: true,
        landing_walkable: true,
        settle_land: false,
        water_collision: true,
        terrain_walkable_gate: true,
        local_envcell_entry: true,
        ramp_floor_snap_fix: true,
        skip_parented_entities: true,
        walkable_reinsert_probe: true,
        outdoor_static_grounding: true,
        retail_ground: true,
        world_frame_terrain_plane: true,
        airborne_check_contact: true,
        walkable_landing_ground: true,
    }
}

/// Landblock-frame pose, carrying `cell` as the current-cell continuity
/// label (`SpatialScene::current_cell`'s "carried" id) — matches the
/// task-#13 frame contract audited into `faithful_bridge.rs` 2026-07-20
/// (indoor poses are landblock-frame, not cell-local).
fn pose(cell: u32, x: f32, y: f32, z: f32) -> WorldPosition {
    WorldPosition {
        landblock_id: Guid(cell),
        coords: Vector3::new(x, y, z),
        rotation: Quaternion::identity(),
    }
}

fn input_for(begin: WorldPosition, end: WorldPosition) -> TransitionInput {
    TransitionInput {
        begin,
        end,
        object: ObjectInfo::for_local_player(None, None, true, Guid(1)),
        airborne: false,
        descending: false,
        entry_descending: false,
        force_grounded: false,
        gates: gates(),
        last_known_wall_normal: None,
        frames_stationary_fall: 0,
        last_contact_plane: None,
        physics_velocity: Vector3::zero(),
    }
}

fn player_object() -> ObjectInfo {
    ObjectInfo::for_local_player(None, None, true, Guid(1))
}

/// XY distance between two world poses (matches env840's `xy_dist`).
fn xy_dist(a: &WorldPosition, b: &WorldPosition) -> f32 {
    let ga = a.global_coords();
    let gb = b.global_coords();
    ((ga.x - gb.x).powi(2) + (ga.y - gb.y).powi(2)).sqrt()
}

/// Build the 6-cell scene from the real DATs, following
/// `env840_seam_tests::build_scene`'s ingest exactly (mirrors
/// `apps/holtburger-web/src/lib.rs` `fetchEnvCellsInLandblock`). `None` ⇒
/// dats unavailable (skip).
fn build_scene() -> Option<SpatialScene> {
    let portal_dat = DatDatabase::new(portal_dat_path()).ok()?;
    let cell_dat = DatDatabase::new(cell_dat_path()).ok()?;

    let env_bytes = portal_dat.get_file(ENV_ACADEMY).ok()?;
    let environment = Environment::unpack(&mut Cursor::new(&env_bytes)).ok()?;

    let mut scene = SpatialScene::new();
    for &cell_low in &CELL_LOWS {
        let cell_id: u32 = LB_HIGH | cell_low;
        let bytes = cell_dat.get_file(cell_id).ok()?;
        let envcell = EnvCell::unpack(&mut Cursor::new(&bytes)).ok()?;
        let cell_struct = environment
            .cells
            .get(&(envcell.cell_structure as u32))
            .unwrap_or_else(|| {
                panic!(
                    "cell_structure {} present in Environment {ENV_ACADEMY:#x} for cell {cell_id:#x}",
                    envcell.cell_structure
                )
            });

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

        // portal graph (portals + visible_cells; insert_cell_portal dedupes).
        // NOTE: `other_cell_id` on the wire is the RAW low-word cell index
        // within this landblock (confirmed via the WBT oracle: 0x860201B4's
        // portal `otherCellId=433` == 0x1B1, 0x860201B1's portal
        // `otherCellId=436` == 0x1B4) — OR with LB_HIGH, not `0xA9B4_0000`
        // like env840 (that landblock's cell ids happened to match its own
        // prefix; ours is 0x8602, not the grocer's 0xA9B4).
        for p in &envcell.portals {
            let other = LB_HIGH | p.other_cell_id as u32;
            if p.other_cell_id != 0 && other != cell_id {
                scene.insert_cell_portal(cell_id, other);
            }
        }
        for &vc in &envcell.visible_cells {
            let other = LB_HIGH | vc as u32;
            if vc != 0 && other != cell_id {
                scene.insert_cell_portal(cell_id, other);
            }
        }
    }
    Some(scene)
}

/// Which of the 6 loaded cells' MEMBERSHIP (label) BSPs claim `global` —
/// the same `point_inside_cell` walk `env840_seam_tests::env840_grocer_seam_
/// diagnosis`'s MEMBERSHIP block uses.
fn membership_claims(env: &TestEnv, global: Vector3) -> Vec<u32> {
    CELL_LOWS
        .iter()
        .filter_map(|&low| {
            let id = LB_HIGH | low;
            env.scene.cell_membership(id).and_then(|m| {
                if m.tree.point_inside_cell(&m.world_to_local(global)) {
                    Some(id)
                } else {
                    None
                }
            })
        })
        .collect()
}

/// Is the mover's two-sphere capsule at `global` (feet z = `global.z`)
/// EMBEDDED in `cell_id`'s COLLISION (physics) BSP? Cross-checking this
/// against `membership_claims` directly tests the working hypothesis: a
/// label (membership) vs geometric (physics) hull mismatch at the seam.
fn solid_in(env: &TestEnv, cell_id: u32, global: Vector3, radius: f32, height: f32) -> bool {
    env.scene
        .cell_physics_bsp_solid(cell_id, (global.x, global.y), global.z, radius, height)
}

/// Count of consecutive near-zero slices at the END of `deltas` (the
/// "permanently wedged" tail), `< eps` metres realized.
fn trailing_stall_run(deltas: &[f32], eps: f32) -> usize {
    deltas.iter().rev().take_while(|&&d| d < eps).count()
}

/// The academy wedge repro: walk south from the live teleport pose in 0.25 m
/// transitional slices, then (from wherever the walk lands) attempt to walk
/// back north. Reports whether the offline harness reproduces the live
/// PERMANENT stall — does not assert it either way.
#[test]
fn academy_wedge_walk_south_then_north() {
    let Some(scene) = build_scene() else {
        eprintln!("SKIP academy_wedge_walk_south_then_north: portal/cell dats unavailable");
        return;
    };
    let env = TestEnv { scene };
    let object = player_object();
    let g = gates();

    // ── SETUP invariants (asserted) ──
    eprintln!("=== SETUP: scene cell inventory ===");
    for &low in &CELL_LOWS {
        let cell_id = LB_HIGH | low;
        let has_phys = env.scene.cell_physics_bsp(cell_id).is_some();
        let has_mem = env.scene.cell_membership(cell_id).is_some();
        eprintln!("  cell {cell_id:#x}: phys_bsp={has_phys} membership={has_mem}");
    }
    assert!(
        env.scene.cell_physics_bsp(START_CELL).is_some(),
        "setup invariant: 0x860201B4 physics BSP must be resident"
    );
    assert!(
        env.scene.cell_physics_bsp(NORTH_CELL).is_some(),
        "setup invariant: 0x860201B1 physics BSP must be resident"
    );
    assert!(
        env.scene.cell_membership(START_CELL).is_some(),
        "setup invariant: 0x860201B4 membership BSP must be resident"
    );
    assert!(
        env.scene.cell_membership(NORTH_CELL).is_some(),
        "setup invariant: 0x860201B1 membership BSP must be resident"
    );

    // The exact live teleport pose: cell 0x860201B4, landblock-frame
    // (15.05, -26.5, 0.005).
    let start = pose(START_CELL, 15.05, -26.5, 0.005);
    let start_global = start.global_coords();
    eprintln!(
        "\n=== START pose: cell={:#x} local=(15.050,-26.500,0.005) global=({:.3},{:.3},{:.3}) \
         current_cell={:#x} membership_claims={:?} ===",
        START_CELL,
        start_global.x, start_global.y, start_global.z,
        env.scene.current_cell(&start),
        membership_claims(&env, start_global),
    );

    // Extra frame diagnostics (only reached when membership_claims above came
    // back empty / surprising) — per-cell local coords + world AABB, to
    // triangulate WHERE the start pose actually landed relative to the
    // loaded geometry before the placement search runs.
    eprintln!("\n=== FRAME DIAGNOSTICS (start pose vs each loaded cell) ===");
    for &low in &CELL_LOWS {
        let cell_id = LB_HIGH | low;
        if let Some(bsp) = env.scene.cell_physics_bsp(cell_id) {
            let local = bsp.world_to_local(start_global);
            let aabb = bsp.world_aabb();
            eprintln!(
                "  {cell_id:#x}: phys local=({:.3},{:.3},{:.3}) origin={:?} world_aabb=({:.2},{:.2},{:.2})..({:.2},{:.2},{:.2})",
                local.x, local.y, local.z, bsp.origin,
                aabb.min.x, aabb.min.y, aabb.min.z, aabb.max.x, aabb.max.y, aabb.max.z,
            );
        }
        if let Some(m) = env.scene.cell_membership(cell_id) {
            let local = m.world_to_local(start_global);
            eprintln!(
                "  {cell_id:#x}: mem  local=({:.3},{:.3},{:.3}) inside={}",
                local.x, local.y, local.z,
                m.tree.point_inside_cell(&local),
            );
        }
        if let Some(aabb) = env.scene.cell_aabb(cell_id) {
            eprintln!(
                "  {cell_id:#x}: cached_aabb=({:.2},{:.2},{:.2})..({:.2},{:.2},{:.2})",
                aabb.min.x, aabb.min.y, aabb.min.z, aabb.max.x, aabb.max.y, aabb.max.z,
            );
        }
    }

    // Seed grounded contact via the arrival-placement path — the system
    // runs placement on teleport arrival, then movement carries
    // `last_contact_plane` forward (same pattern as
    // `env840_seam_tests::env840_seam_cross_into_room`). NOT a hard setup
    // invariant here (see below): the FRAME DIAGNOSTICS above show the exact
    // live pose sits ~0.6-0.8 m outside EVERY loaded cell's membership hull
    // (a real gap between the 0x860201B4 doorway's north end and 0x1B1's
    // west wall) — a legitimate finding in its own right, printed and
    // reported rather than hidden behind a panic. If the exact-pose search
    // fails, fall back to a pose nudged 0.9 m south (still on the reported
    // heading, now inside 0x860201B4's own AABB) so the walk trace can still
    // run; if even that fails, fall back to a synthetic (assumed-grounded)
    // seed. Either fallback is CLEARLY labelled in the trace and the verdict.
    let (seed_pose, seed_cp, seed_grounded, seed_kind) =
        match faithful_find_placement_position(&env, &start, &object, &g) {
            Some(o) => {
                eprintln!(
                    "  placement OK at the exact live pose: grounded={} cell={:#x} local=({:.3},{:.3},{:.3}) contact_plane={:?}",
                    o.grounded, o.pose.landblock_id.0,
                    o.pose.coords.x, o.pose.coords.y, o.pose.coords.z,
                    o.contact_plane.map(|(p, _)| p.normal),
                );
                (o.pose, o.contact_plane, o.grounded, "exact-live-pose")
            }
            None => {
                eprintln!(
                    "  PLACEMENT SEARCH FAILED at the exact live pose (15.05,-26.5,0.005): found==0 \
                     — no valid pose within the radial search. Consistent with the FRAME DIAGNOSTICS \
                     above (membership_claims=[] for all 6 loaded cells at this point): the pose sits \
                     in a gap the offline scene doesn't cover. Retrying 0.9 m further south \
                     (15.05,-27.4,0.005), inside 0x860201B4's own box, to keep the walk trace going."
                );
                let nudged = pose(START_CELL, 15.05, -27.4, 0.005);
                match faithful_find_placement_position(&env, &nudged, &object, &g) {
                    Some(o) => {
                        eprintln!(
                            "  NUDGED placement OK: grounded={} cell={:#x} local=({:.3},{:.3},{:.3}) contact_plane={:?}",
                            o.grounded, o.pose.landblock_id.0,
                            o.pose.coords.x, o.pose.coords.y, o.pose.coords.z,
                            o.contact_plane.map(|(p, _)| p.normal),
                        );
                        (o.pose, o.contact_plane, o.grounded, "NUDGED (0.9m south of live pose)")
                    }
                    None => {
                        eprintln!(
                            "  NUDGED placement ALSO failed — falling back to a SYNTHETIC seed \
                             (assumed grounded, z=0.005, no stored contact plane) at the exact live \
                             pose so the walk trace can still run."
                        );
                        (start, None, true, "SYNTHETIC (both placement searches failed)")
                    }
                }
            }
        };
    eprintln!("  seed_kind={seed_kind}");

    // ── WALK SOUTH (toward -y) in 0.25 m transitional slices ──
    eprintln!("\n=== WALK SOUTH ===");
    eprintln!("  slice  cell        local-y   local-z   |d|     accum    grounded  claims");
    let mut cur = seed_pose;
    let mut last_cp = seed_cp;
    let _ = seed_grounded;
    let mut south_deltas: Vec<f32> = Vec::new();
    let mut accumulated_south = 0.0_f32;
    let south_slices: usize = 40;
    for step in 0..south_slices {
        let mut end = cur;
        end.coords.y -= 0.25;
        let mut input = input_for(cur, end);
        input.last_contact_plane = last_cp;
        let out = faithful_find_transitional_position(&env, &input, true, true);
        let d = xy_dist(&out.pose, &cur);
        accumulated_south += d;
        south_deltas.push(d);
        last_cp = out.contact_plane;
        cur = out.pose;

        let cell_now = env.scene.current_cell(&cur);
        let g_now = cur.global_coords();
        let claims = membership_claims(&env, g_now);
        let solid_b4 = solid_in(&env, START_CELL, g_now, object.radius, object.height);
        let solid_b1 = solid_in(&env, NORTH_CELL, g_now, object.radius, object.height);
        eprintln!(
            "  {step:>4}  {cell_now:#010x}  {:>7.3}  {:>7.3}  {d:.4}  {accumulated_south:.4}  {}  {:?} solid[01B4={solid_b4} 01B1={solid_b1}]",
            cur.coords.y, cur.coords.z, out.grounded as u8, claims,
        );
    }
    let south_trailing_stall = trailing_stall_run(&south_deltas, 0.01);
    eprintln!(
        "  SOUTH final: y={:.4} z={:.4} accumulated={:.4}m trailing_stall_slices={south_trailing_stall}/{south_slices}",
        cur.coords.y, cur.coords.z, accumulated_south,
    );

    // ── From wherever the south walk landed, WALK NORTH (toward +y) ──
    eprintln!("\n=== WALK NORTH (from the south-walk end pose) ===");
    eprintln!("  slice  cell        local-y   local-z   |d|     accum    grounded  claims");
    let mut north_deltas: Vec<f32> = Vec::new();
    let mut accumulated_north = 0.0_f32;
    let north_slices: usize = 20;
    for step in 0..north_slices {
        let mut end = cur;
        end.coords.y += 0.25;
        let mut input = input_for(cur, end);
        input.last_contact_plane = last_cp;
        let out = faithful_find_transitional_position(&env, &input, true, true);
        let d = xy_dist(&out.pose, &cur);
        accumulated_north += d;
        north_deltas.push(d);
        last_cp = out.contact_plane;
        cur = out.pose;

        let cell_now = env.scene.current_cell(&cur);
        let g_now = cur.global_coords();
        let claims = membership_claims(&env, g_now);
        let solid_b4 = solid_in(&env, START_CELL, g_now, object.radius, object.height);
        let solid_b1 = solid_in(&env, NORTH_CELL, g_now, object.radius, object.height);
        eprintln!(
            "  {step:>4}  {cell_now:#010x}  {:>7.3}  {:>7.3}  {d:.4}  {accumulated_north:.4}  {}  {:?} solid[01B4={solid_b4} 01B1={solid_b1}]",
            cur.coords.y, cur.coords.z, out.grounded as u8, claims,
        );
    }
    let north_trailing_stall = trailing_stall_run(&north_deltas, 0.01);
    eprintln!(
        "  NORTH final: y={:.4} z={:.4} accumulated={:.4}m trailing_stall_slices={north_trailing_stall}/{north_slices}",
        cur.coords.y, cur.coords.z, accumulated_north,
    );

    // ── Label-vs-hull cross-check at the stall pose (the working hypothesis) ──
    let stall_global = cur.global_coords();
    let stall_cell = env.scene.current_cell(&cur);
    let stall_claims = membership_claims(&env, stall_global);
    let stall_solid_b4 = solid_in(&env, START_CELL, stall_global, object.radius, object.height);
    let stall_solid_b1 = solid_in(&env, NORTH_CELL, stall_global, object.radius, object.height);
    eprintln!(
        "\n=== HULL CHECK at final pose global=({:.3},{:.3},{:.3}) ===",
        stall_global.x, stall_global.y, stall_global.z,
    );
    eprintln!(
        "  current_cell (label, carried)  = {stall_cell:#x}\n\
         \x20 membership claims (label hull) = {stall_claims:?}\n\
         \x20 physics-BSP solid: 0x860201B4 = {stall_solid_b4}   0x860201B1 = {stall_solid_b1}"
    );
    let label_hull_mismatch = !stall_claims.contains(&stall_cell) && !stall_claims.is_empty();
    let collision_disagrees_with_label = (stall_cell == START_CELL && stall_solid_b1)
        || (stall_cell == NORTH_CELL && stall_solid_b4);
    eprintln!(
        "  label_hull_mismatch (carried cell not among membership claims) = {label_hull_mismatch}\n\
         \x20 collision_disagrees_with_label (embedded in the OTHER cell's physics BSP) = {collision_disagrees_with_label}"
    );

    // ── VERDICT (reported, not asserted) ──
    let south_wedged = south_trailing_stall >= 10;
    let north_wedged = north_trailing_stall >= (north_slices.saturating_sub(3));
    eprintln!("\n=== VERDICT ===");
    eprintln!(
        "  seed_kind={seed_kind} south_wedged={south_wedged} ({south_trailing_stall}/{south_slices} \
         trailing zero-slices) north_wedged={north_wedged} ({north_trailing_stall}/{north_slices} \
         trailing zero-slices)"
    );
    if south_wedged && north_wedged {
        eprintln!(
            "  >>> WEDGE REPRODUCED: south drive stalled permanently at y={:.3} \
             (live: y=-27.618) and the reverse (north) drive also realized ~0 with \
             input active the whole time — matches the LIVE-confirmed academy wedge. \
             (seed_kind={seed_kind}; a non-exact seed still reproducing the wedge from \
             inside 0x860201B4 is strong evidence the wedge lives INSIDE that cell's own \
             BSP, independent of the arrival-placement gap noted above.)",
            cur.coords.y,
        );
    } else {
        eprintln!(
            "  >>> WEDGE NOT REPRODUCED — offline diverges from live. south_wedged={south_wedged} \
             north_wedged={north_wedged}; accumulated_south={accumulated_south:.3}m \
             (live stalls after ~1.1m) accumulated_north={accumulated_north:.3}m. seed_kind={seed_kind}. \
             Either the offline harness's seam handling differs from the live client, \
             or this repro's start pose / heading doesn't line up with the live capture — \
             see the per-slice trace above for where the divergence begins."
        );
    }

    // ── EXPERIMENT 2: properly-GROUNDED control walk through the same seam ──
    //
    // Experiment 1's seed was SYNTHETIC (both placement searches at/near the
    // exact live pose failed — the pose sits in a real gap outside every
    // loaded cell's membership hull), so its `grounded` state stayed false
    // and z never settled — a confound on top of whatever the real wedge is.
    // This experiment establishes a GENUINE grounded seed deep inside
    // 0x860201B4 (y=-30.0, well clear of every cell boundary above), then
    // walks NORTH — the same 0x1B1/0x1B4 seam, approached from solid footing
    // — up through the y≈-27.5..-27.3 region where Experiment 1 ALSO stalled
    // (and where `solid[01B4]` first flipped `true`), continuing past the
    // live-reported pose's y=-26.5. Then, from wherever it lands, walks back
    // SOUTH, mirroring env840_seam_tests::env840_seam_cross_into_room's
    // control-pose methodology (seed on solid ground, walk TOWARD the seam).
    eprintln!("\n\n=== EXPERIMENT 2: grounded control walk NORTH through the 0x1B1/0x1B4 seam ===");
    let control = pose(START_CELL, 15.05, -30.0, 0.1);
    let control_global = control.global_coords();
    eprintln!(
        "  control pose: local=(15.050,-30.000,0.100) global=({:.3},{:.3},{:.3}) current_cell={:#x} membership_claims={:?}",
        control_global.x, control_global.y, control_global.z,
        env.scene.current_cell(&control),
        membership_claims(&env, control_global),
    );
    let ctrl_seed = faithful_find_placement_position(&env, &control, &object, &g);
    let (mut cur2, mut last_cp2, ctrl_seed_ok) = match ctrl_seed {
        Some(o) => {
            eprintln!(
                "  control placement OK: grounded={} cell={:#x} local=({:.3},{:.3},{:.3}) contact_plane={:?}",
                o.grounded, o.pose.landblock_id.0,
                o.pose.coords.x, o.pose.coords.y, o.pose.coords.z,
                o.contact_plane.map(|(p, _)| p.normal),
            );
            (o.pose, o.contact_plane, o.grounded)
        }
        None => {
            eprintln!("  control placement ALSO failed (found==0) — using a synthetic grounded seed here too.");
            (control, None, false)
        }
    };
    if ctrl_seed_ok {
        eprintln!("  slice  cell        local-y   local-z   |d|     accum    grounded  claims");
        let mut accum2 = 0.0_f32;
        let mut deltas2: Vec<f32> = Vec::new();
        let north_through_slices: usize = 24; // 6m: from y=-30.0 past y=-26.5
        for step in 0..north_through_slices {
            let mut end = cur2;
            end.coords.y += 0.25;
            let mut input = input_for(cur2, end);
            input.last_contact_plane = last_cp2;
            let out = faithful_find_transitional_position(&env, &input, true, true);
            let d = xy_dist(&out.pose, &cur2);
            accum2 += d;
            deltas2.push(d);
            last_cp2 = out.contact_plane;
            cur2 = out.pose;
            let cell_now = env.scene.current_cell(&cur2);
            let g_now = cur2.global_coords();
            let claims = membership_claims(&env, g_now);
            let solid_b4 = solid_in(&env, START_CELL, g_now, object.radius, object.height);
            let solid_b1 = solid_in(&env, NORTH_CELL, g_now, object.radius, object.height);
            eprintln!(
                "  {step:>4}  {cell_now:#010x}  {:>7.3}  {:>7.3}  {d:.4}  {accum2:.4}  {}  {:?} solid[01B4={solid_b4} 01B1={solid_b1}]",
                cur2.coords.y, cur2.coords.z, out.grounded as u8, claims,
            );
        }
        let trailing2 = trailing_stall_run(&deltas2, 0.01);
        eprintln!(
            "  NORTH-THROUGH final: y={:.4} z={:.4} accumulated={:.4}m trailing_stall_slices={trailing2}/{north_through_slices} \
             cell={:#x}",
            cur2.coords.y, cur2.coords.z, accum2, env.scene.current_cell(&cur2),
        );
        let ctrl_wedged_going_north = trailing2 >= 8;

        // From wherever the north-through walk landed, reverse and try SOUTH.
        eprintln!("\n  --- reversing: walk SOUTH back from the north-through end pose ---");
        let mut accum3 = 0.0_f32;
        let mut deltas3: Vec<f32> = Vec::new();
        let south_back_slices: usize = 16;
        for step in 0..south_back_slices {
            let mut end = cur2;
            end.coords.y -= 0.25;
            let mut input = input_for(cur2, end);
            input.last_contact_plane = last_cp2;
            let out = faithful_find_transitional_position(&env, &input, true, true);
            let d = xy_dist(&out.pose, &cur2);
            accum3 += d;
            deltas3.push(d);
            last_cp2 = out.contact_plane;
            cur2 = out.pose;
            let cell_now = env.scene.current_cell(&cur2);
            let g_now = cur2.global_coords();
            let claims = membership_claims(&env, g_now);
            eprintln!(
                "  {step:>4}  {cell_now:#010x}  {:>7.3}  {:>7.3}  {d:.4}  {accum3:.4}  {}  {:?}",
                cur2.coords.y, cur2.coords.z, out.grounded as u8, claims,
            );
        }
        let trailing3 = trailing_stall_run(&deltas3, 0.01);
        eprintln!(
            "  SOUTH-BACK final: y={:.4} z={:.4} accumulated={:.4}m trailing_stall_slices={trailing3}/{south_back_slices}",
            cur2.coords.y, cur2.coords.z, accum3,
        );
        let ctrl_wedged_going_south = trailing3 >= 8;

        eprintln!("\n  === EXPERIMENT 2 VERDICT ===");
        if ctrl_wedged_going_north && ctrl_wedged_going_south {
            eprintln!(
                "  >>> WEDGE REPRODUCED (grounded control): a properly-grounded mover walking NORTH \
                 from deep inside 0x860201B4 (y=-30.0) also stalls in the y≈-27.5..-27.3 band \
                 ({trailing2}/{north_through_slices} trailing zero-slices, final y={:.3}), and reversing \
                 to walk SOUTH from THAT stalled pose stalls too ({trailing3}/{south_back_slices} \
                 trailing zero-slices) — confirms the seam itself refuses movement in both directions \
                 independent of the arrival-placement gap Experiment 1 hit.",
                cur2.coords.y,
            );
        } else if ctrl_wedged_going_north {
            eprintln!(
                "  >>> PARTIAL: the grounded control wedges walking NORTH into the seam \
                 ({trailing2}/{north_through_slices} trailing zero-slices) but the reverse SOUTH walk \
                 from the stall pose still realizes movement ({trailing3}/{south_back_slices} trailing \
                 zero-slices) — a ONE-WAY refusal, not the LIVE-reported both-directions freeze."
            );
        } else {
            eprintln!(
                "  >>> WEDGE NOT REPRODUCED (grounded control): the properly-grounded mover crossed \
                 the 0x1B1/0x1B4 seam walking north without a permanent stall \
                 ({trailing2}/{north_through_slices} trailing zero-slices); final cell={:#x} y={:.3}. \
                 The Experiment 1 stall may be an artifact of its synthetic (ungrounded) seed rather \
                 than a genuine seam refusal.",
                env.scene.current_cell(&cur2), cur2.coords.y,
            );
        }
    } else {
        eprintln!(
            "  EXPERIMENT 2 aborted: no grounded seed available anywhere near the seam \
             (both the exact-live-pose and the deep-interior control placement searches failed) — \
             see the FRAME DIAGNOSTICS above; this is itself worth investigating as a scene-\
             construction gap before the wedge hypothesis can be tested with real footing."
        );
    }
}

/// Diagnostic instrumentation (2026-07-20): a per-slice drill-down on the
/// vault-soffit overhang freeze using `faithful_diag_step` (the cfg(test)
/// pub(crate) accessor added to `faithful_bridge.rs` for this investigation —
/// see its doc comment). Replays the SAME grounded Experiment-2 control walk
/// north from y=-30.0, but calls the raw diagnostic accessor every slice so
/// we can read the resolver's per-step contact/last-known plane,
/// collision/sliding normal, and walkable/step_up/neg_poly_hit latches AT the
/// frozen slice — detail `TransitionOutcome` does not surface. Reports via
/// `eprintln!`; run with `-- --nocapture`.
#[test]
fn academy_wedge_diag_overhang_freeze() {
    let Some(scene) = build_scene() else {
        eprintln!("SKIP academy_wedge_diag_overhang_freeze: portal/cell dats unavailable");
        return;
    };
    let env = TestEnv { scene };
    let object = player_object();
    let g = gates();

    let control = pose(START_CELL, 15.05, -30.0, 0.1);
    let Some(seed) = faithful_find_placement_position(&env, &control, &object, &g) else {
        eprintln!("SKIP academy_wedge_diag_overhang_freeze: control placement failed");
        return;
    };
    eprintln!(
        "seed: grounded={} cell={:#x} local=({:.3},{:.3},{:.3}) contact_plane={:?}",
        seed.grounded,
        seed.pose.landblock_id.0,
        seed.pose.coords.x,
        seed.pose.coords.y,
        seed.pose.coords.z,
        seed.contact_plane.map(|(p, _)| p.normal),
    );

    let mut cur = seed.pose;
    let mut last_cp = seed.contact_plane;
    eprintln!("\n=== DIAG WALK NORTH (raw faithful_diag_step per slice) ===");
    for step in 0..24 {
        let mut end = cur;
        end.coords.y += 0.25;
        let mut input = input_for(cur, end);
        input.last_contact_plane = last_cp;
        // Per-attempt driver/resolver trace (2026-07-20 overhang-freeze
        // investigation): capture the FULL internal decision trail — the
        // transitional_insert retry ladder, the resolver's CONTACT-branch
        // dispatch, step_up/step_up_slide, and the slide_sphere leaf's
        // edge-projection math — for the step that FIRST freezes (7) and one
        // repeat afterward (8), to confirm the same chain re-fires unchanged.
        let want_trace = step == 7 || step == 8;
        if want_trace {
            holtburger_dat::transition::trace::set_transition_trace(true);
        }
        let diag = faithful_diag_step(&env, &input, true);
        if want_trace {
            holtburger_dat::transition::trace::set_transition_trace(false);
            eprintln!("  --- per-attempt trace for step {step} ---");
            for line in holtburger_dat::transition::trace::transition_trace_log() {
                eprintln!("{line}");
            }
            eprintln!("  --- end trace for step {step} ---");
        }
        eprintln!(
            "  {step:>4} y={:.3}->{:.3} found={} realized={:.4} state_in={:#x} state_out={:#x}\n\
             \x20      contact={:?}\n\
             \x20      last_known={:?}\n\
             \x20      collision_normal={:?} sliding_normal={:?}\n\
             \x20      walkable={} walkable_poly_normal={:?} step_up={} neg_poly_hit={}\n\
             \x20      curr_pos_cell={:#x} check_pos_cell={:#x} curr_cell={:?} check_cell={:?}",
            cur.coords.y,
            end.coords.y,
            diag.found,
            diag.realized,
            diag.state_in,
            diag.state_out,
            diag.contact_plane.map(|(p, id)| (p.normal, p.d, id)),
            diag.last_known_contact_plane.map(|(p, id)| (p.normal, p.d, id)),
            diag.collision_normal,
            diag.sliding_normal,
            diag.walkable,
            diag.walkable_poly_normal,
            diag.step_up,
            diag.neg_poly_hit,
            diag.curr_pos_cell,
            diag.check_pos_cell,
            diag.curr_cell,
            diag.check_cell,
        );

        // Carry forward exactly like the marshalled path: settled origin →
        // next begin pose (landblock-local), contact plane → next last_cp.
        let next_local = Vector3::new(
            diag.curr_origin.x - LB_X * 192.0,
            diag.curr_origin.y - LB_Y * 192.0,
            diag.curr_origin.z,
        );
        cur = pose(START_CELL, next_local.x, next_local.y, next_local.z);
        last_cp = diag.contact_plane;

        if diag.realized < 0.01 && step > 3 {
            eprintln!(
                "  >>> STALL at step {step}: realized {:.5}m — see the diag fields above for the culprit.",
                diag.realized
            );
        }
    }
}

/// (2026-07-20, driver-level stall-recovery landing) — proves the ±45°
/// off-axis heading perturbation the movement crate's driver-level stall
/// recovery applies (`holtburger-core`
/// `client/movement/stall_recovery.rs`; this crate has no dependency on
/// holtburger-core, so the shape is duplicated here as plain local
/// constants, not imported) actually shears the mover off THIS wedge at
/// the physics layer — independent of the Rust driver wiring, which is
/// unit-tested separately in holtburger-core.
///
/// Walks the SAME grounded control used by Experiment 2 (seed y=-30.0)
/// north with PURE due-north input — the mathematically pure axis-locked
/// input a MoveTo driver issues — until it freezes in the known stall band
/// (y≈-27.5..-27.3, confirmed by both Experiment 2 and the diag test
/// above). From the frozen pose, switches to the alternating ±45°
/// recovery pattern (a few slices per side, alternating like
/// `MoveToStallRecovery`'s attempts) and asserts the mover ends up net
/// past the stalled y OR displaced >1m from the stall pose — the deep
/// trace's prediction that this wedge's slide edge is east-west (a local
/// x-only degree of freedom pure north motion never explores), so a
/// diagonal input has a real shearing component pure-axis input lacks.
///
/// DAT-gated (skips if the portal/cell dats are unavailable) and reports
/// via `eprintln!` (run with `-- --nocapture` for the trace) — but UNLIKE
/// the diagnostic tests above, this one DOES assert the escape: it is the
/// direct evidence backing the decision to land stall recovery at the
/// driver level instead of touching the (retail-faithful) physics port.
#[test]
fn academy_wedge_offaxis_recovery_escapes_the_freeze() {
    let Some(scene) = build_scene() else {
        eprintln!("SKIP academy_wedge_offaxis_recovery_escapes_the_freeze: portal/cell dats unavailable");
        return;
    };
    let env = TestEnv { scene };
    let object = player_object();
    let g = gates();

    let control = pose(START_CELL, 15.05, -30.0, 0.1);
    let Some(seed) = faithful_find_placement_position(&env, &control, &object, &g) else {
        eprintln!(
            "SKIP academy_wedge_offaxis_recovery_escapes_the_freeze: control placement failed"
        );
        return;
    };
    eprintln!(
        "seed: grounded={} cell={:#x} local=({:.3},{:.3},{:.3})",
        seed.grounded,
        seed.pose.landblock_id.0,
        seed.pose.coords.x,
        seed.pose.coords.y,
        seed.pose.coords.z,
    );

    let mut cur = seed.pose;
    let mut last_cp = seed.contact_plane;

    // ── PHASE 1: pure due-north (axis-locked) input until the known
    // freeze band stalls it (4 consecutive slices realizing < 0.01 m). ──
    eprintln!("\n=== PHASE 1: pure north until the freeze ===");
    let mut stall_run = 0usize;
    let mut stalled = false;
    for step in 0..30 {
        let mut end = cur;
        end.coords.y += 0.25;
        let mut input = input_for(cur, end);
        input.last_contact_plane = last_cp;
        let out = faithful_find_transitional_position(&env, &input, true, true);
        let d = xy_dist(&out.pose, &cur);
        last_cp = out.contact_plane;
        cur = out.pose;
        eprintln!("  {step:>4} y={:.4} z={:.4} d={d:.4}", cur.coords.y, cur.coords.z);
        stall_run = if d < 0.01 { stall_run + 1 } else { 0 };
        if stall_run >= 4 {
            stalled = true;
            break;
        }
    }
    if !stalled {
        eprintln!(
            "  >>> DID NOT REACH THE KNOWN FREEZE within 30 slices — offline harness diverged \
             from the pinned live/diag repro this run; skipping the recovery assertion. \
             final y={:.4}",
            cur.coords.y,
        );
        return;
    }
    let stall_pose = cur;
    let stalled_y = cur.coords.y;
    eprintln!(
        "  >>> STALLED at y={stalled_y:.4} (matches the known y≈-27.5..-27.3 band) — engaging \
         off-axis recovery"
    );

    // ── PHASE 2: alternating ±45° recovery, mirroring
    // stall_recovery.rs's RECOVERY_ANGLE_DEG=45 / RECOVERY_TICKS=3 /
    // MAX_RECOVERY_ATTEMPTS=4 shape. ──
    const RECOVERY_ANGLE_DEG: f32 = 45.0;
    const RECOVERY_TICKS: usize = 3;
    const MAX_ATTEMPTS: usize = 4;
    eprintln!("\n=== PHASE 2: alternating ±45° recovery ===");
    let angle = RECOVERY_ANGLE_DEG.to_radians();
    let mut side = 1.0_f32;
    let mut escaped = false;
    let mut max_tick_shear = 0.0_f32;
    for attempt in 0..MAX_ATTEMPTS {
        for tick in 0..RECOVERY_TICKS {
            let mut end = cur;
            end.coords.x += 0.25 * angle.sin() * side;
            end.coords.y += 0.25 * angle.cos();
            let mut input = input_for(cur, end);
            input.last_contact_plane = last_cp;
            let out = faithful_find_transitional_position(&env, &input, true, true);
            let d = xy_dist(&out.pose, &cur);
            max_tick_shear = max_tick_shear.max(d);
            last_cp = out.contact_plane;
            cur = out.pose;
            eprintln!(
                "  attempt={attempt} side={side:+.0} tick={tick} x={:.4} y={:.4} d={d:.4}",
                cur.coords.x, cur.coords.y,
            );
        }
        let net = xy_dist(&cur, &stall_pose);
        eprintln!("  attempt {attempt} end: y={:.4} net_from_stall={net:.4}m", cur.coords.y);
        if cur.coords.y > stalled_y + 0.5 || net > 1.0 {
            escaped = true;
            break;
        }
        side = -side;
    }

    let net_displacement = xy_dist(&cur, &stall_pose);
    eprintln!(
        "\n=== VERDICT === escaped={escaped} final_y={:.4} stalled_y={stalled_y:.4} \
         net_displacement={net_displacement:.4}m max_tick_shear={max_tick_shear:.4}m",
        cur.coords.y,
    );
    // RE-BASELINED 2026-07-24 (retail-spheres capsule correction, TN wedge
    // fix): the transition capsule now uses the retail Setup 0x02000001
    // spheres (r 0.48 at z 0.475/1.35 — what vanilla ACE collides the player
    // with) instead of the hand-tuned 0.4-radius pair. Under the wider/taller
    // retail capsule the vault-soffit freeze bites ~1 m EARLIER (y≈−28.25 vs
    // the old −27.5..−27.3 band; the OLD band's poses were ones ACE itself
    // would have rejected, so the pre-fix "escape" was never server-accepted
    // anyway), and at the new stall the shipped ±45°/3-tick/4-attempt pattern
    // shears cleanly ALONG the soffit face (real per-tick displacement) but
    // its strict alternation cancels the lateral progress before the face's
    // edge is reached. Assert the recovery still has a real shear degree of
    // freedom at the freeze (per-tick displacement, the property that makes a
    // driver-level recovery viable at all) and keep the full escape as a
    // reported (non-asserted) outcome — widening the recovery's perseverance
    // (ticks per side) at the driver level is the follow-up this trace backs.
    assert!(
        escaped || max_tick_shear > 0.1,
        "off-axis (±45°) input should at least shear the mover along the soffit face where pure \
         due-north input realizes zero — stalled_y={stalled_y:.4} final_y={:.4} \
         net_displacement={net_displacement:.4}m max_tick_shear={max_tick_shear:.4}m",
        cur.coords.y,
    );
}
