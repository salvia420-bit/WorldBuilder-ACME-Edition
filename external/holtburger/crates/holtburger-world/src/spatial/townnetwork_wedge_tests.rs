//! Offline repro of the LIVE-confirmed Town Network arrival wedge
//! (2026-07-24, `fix/indoor-nav-no-pose` residual): after the JS env-cell
//! residency + pose-resolution fix, a teleport arrival into EnvCell
//! 0x00070178 (landblock 0x0007, the Town Network hub ring) at
//! landblock-frame (121, -70, 0) logs
//! `[arrival-placement] adjusted pose by 0.44m cell 0x00070178 grounded=true`
//! — but the body then refuses every walk step: the client emits tiny
//! oscillating micro-steps (y −70 → −69.x) that vanilla ACE rejects with
//! `UpdateObjectInternalServer(...) - failed transition from 0x00070178
//! [121.3,-70,0] to 0x00070178 [121.3,-69.x,0]`, and the local pose never
//! translates (z pinned at 0).
//!
//! Scene ingest follows `academy_wedge_tests::build_scene` generalized to a
//! WHOLE landblock (per-cell Environment records via `environment_id`, like
//! `examples/route_validate.rs::build_scene_for_landblocks`) PLUS the
//! EnvCell furniture recursion (`static_objects` Stab → Setup/GfxObj
//! physics-BSP walk) ported from `route_validate::populate_cell_furniture`
//! — cell 0x178 carries `HasStaticObjs` with a stab 0.19 m from the live
//! arrival point, so furniture collision is load-bearing for this repro.
//!
//! DAT-gated: skips (with a printed SKIP line) when the base dats are
//! absent. Diagnostics report via `eprintln!` (run with `-- --nocapture`);
//! the REGRESSION test at the bottom asserts the fixed behaviour.

use std::collections::HashMap;
use std::io::Cursor;
use std::rc::Rc;

use holtburger_common::position::WorldPosition;
use holtburger_common::{Aabb, Guid, Quaternion, Vector3};

use holtburger_dat::file_type::env_cell::EnvCell;
use holtburger_dat::file_type::environment::Environment;
use holtburger_dat::file_type::{GfxObj, SetupModel};
use holtburger_dat::landblock::LandblockInfo;
use holtburger_dat::physics::resolve_cell_physics_polygons;
use holtburger_dat::DatDatabase;

use crate::spatial::entity_collision::EntityCollider;
use crate::spatial::faithful_bridge::{
    faithful_diag_step, faithful_find_placement_position, faithful_find_transitional_position,
};
use crate::spatial::scene::{CellMembership, CellPhysicsBsp, SpatialScene};
use crate::spatial::transition::{ObjectInfo, TransitionEnv, TransitionGates, TransitionInput};

/// Town Network dungeon landblock (0x0007xxxx cells): lb_x = 0x00, lb_y = 0x07.
const LB_HIGH: u32 = 0x0007_0000;
const LB_X: f32 = 0.0;
const LB_Y: f32 = 7.0;
/// The live arrival cell.
const ARRIVAL_CELL: u32 = 0x0007_0178;

fn portal_dat_path() -> String {
    std::env::var("HOLTBURGER_PORTAL_DAT")
        .unwrap_or_else(|_| "/home/wbterminal/ac_base_dats/client_portal.dat".to_string())
}
fn cell_dat_path() -> String {
    std::env::var("HOLTBURGER_CELL_DAT")
        .unwrap_or_else(|_| "/home/wbterminal/ac_base_dats/client_cell_1.dat".to_string())
}

/// Minimal indoor-only `TransitionEnv` (same shape as
/// `academy_wedge_tests::TestEnv`).
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

/// The LIVE gate values (`MovementSystem::transition_profile`, every USE_*
/// const read 2026-07-24 — note `settle_land: true`, unlike the academy
/// repro which predates that gate's default-ON).
fn gates() -> TransitionGates {
    TransitionGates {
        step_up_down: true,
        walkable_step_down: true,
        landing_walkable: true,
        settle_land: true,
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

fn pose(cell: u32, x: f32, y: f32, z: f32) -> WorldPosition {
    WorldPosition {
        landblock_id: Guid(cell),
        coords: Vector3::new(x, y, z),
        rotation: Quaternion::identity(),
    }
}

fn player_object() -> ObjectInfo {
    ObjectInfo::for_local_player(None, None, true, Guid(1))
}

fn input_for(
    begin: WorldPosition,
    end: WorldPosition,
    last_cp: Option<(holtburger_common::Plane, u32)>,
) -> TransitionInput {
    TransitionInput {
        begin,
        end,
        object: player_object(),
        airborne: false,
        descending: false,
        entry_descending: false,
        force_grounded: false,
        gates: gates(),
        last_known_wall_normal: None,
        frames_stationary_fall: 0,
        last_contact_plane: last_cp,
    }
}

fn xy_dist(a: &WorldPosition, b: &WorldPosition) -> f32 {
    let ga = a.global_coords();
    let gb = b.global_coords();
    ((ga.x - gb.x).powi(2) + (ga.y - gb.y).powi(2)).sqrt()
}

/// Stab → placed physics-BSP part(s), ported from
/// `route_validate::resolve_placement_physics_bsps` (itself the port of the
/// live wasm client's `walk_setup_parts_with_geom_and_bsp` + indoor stab
/// walk, lib.rs ~18018-18110).
fn resolve_placement_physics_bsps(
    portal: &DatDatabase,
    model_id: u32,
    world_origin: Vector3,
    world_orientation: Quaternion,
) -> Vec<CellPhysicsBsp> {
    let mut out = Vec::new();
    match (model_id >> 24) as u8 {
        0x01 => {
            let Ok(bytes) = portal.get_file(model_id) else {
                return out;
            };
            let Ok(gfx) = GfxObj::unpack(&mut Cursor::new(&bytes)) else {
                return out;
            };
            let Some(tree) = &gfx.physics_bsp else {
                return out;
            };
            if gfx.physics_polygons.is_empty() {
                return out;
            }
            let polys = resolve_cell_physics_polygons(&gfx.physics_polygons, |vid| {
                gfx.vertex_array
                    .vertices
                    .get(&vid)
                    .map(|sw| Vector3::new(sw.origin.x, sw.origin.y, sw.origin.z))
            });
            if polys.is_empty() {
                return out;
            }
            out.push(CellPhysicsBsp {
                tree: tree.clone(),
                polys,
                origin: world_origin,
                orientation: world_orientation,
                scale: 1.0,
            });
        }
        0x02 => {
            let Ok(bytes) = portal.get_file(model_id) else {
                return out;
            };
            let Ok(setup) = SetupModel::unpack(&mut Cursor::new(&bytes)) else {
                return out;
            };
            // Retail static placement-frame order: 0x65 Resting → 0 → first.
            let placement = setup
                .placement_frames
                .get(&0x65)
                .or_else(|| setup.placement_frames.get(&0))
                .or_else(|| setup.placement_frames.values().next());
            for (pi, &part_id) in setup.parts.iter().enumerate() {
                if (part_id >> 24) as u8 != 0x01 {
                    continue;
                }
                let Ok(part_bytes) = portal.get_file(part_id) else {
                    continue;
                };
                let Ok(gfx) = GfxObj::unpack(&mut Cursor::new(&part_bytes)) else {
                    continue;
                };
                let Some(tree) = &gfx.physics_bsp else {
                    continue;
                };
                if gfx.physics_polygons.is_empty() {
                    continue;
                }
                let (offset, rot) = placement
                    .filter(|p| pi < p.anim_frame.frames.len())
                    .map(|p| {
                        (
                            p.anim_frame.frames[pi].origin,
                            p.anim_frame.frames[pi].orientation,
                        )
                    })
                    .unwrap_or((Vector3::zero(), Quaternion::identity()));
                let scale = setup.default_scale.get(pi).copied();
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
                    continue;
                }
                let pr = world_orientation.rotate_vector(offset);
                let wo = Vector3::new(
                    world_origin.x + pr.x,
                    world_origin.y + pr.y,
                    world_origin.z + pr.z,
                );
                let wq = world_orientation.multiply(rot);
                out.push(CellPhysicsBsp {
                    tree: tree.clone(),
                    polys,
                    origin: wo,
                    orientation: wq,
                    scale: 1.0,
                });
            }
        }
        _ => {}
    }
    out
}

/// Build the whole Town Network landblock (every EnvCell + its furniture)
/// from the real DATs. `None` ⇒ dats unavailable (skip).
fn build_scene() -> Option<SpatialScene> {
    build_scene_inner(true)
}

/// Same, but with furniture staging switched off — the env-BSP-only control
/// used to isolate whether a collision comes from the cell environment or a
/// staged static prop.
fn build_scene_no_furniture() -> Option<SpatialScene> {
    build_scene_inner(false)
}

fn build_scene_inner(with_furniture: bool) -> Option<SpatialScene> {
    let portal = DatDatabase::new(portal_dat_path()).ok()?;
    let cell_dat = DatDatabase::new(cell_dat_path()).ok()?;

    let info_bytes = cell_dat.get_file(LB_HIGH | 0xFFFE).ok()?;
    let info = LandblockInfo::unpack(&info_bytes).ok()?;

    let mut env_cache: HashMap<u32, Option<Rc<Environment>>> = HashMap::new();
    let mut model_cache: HashMap<u32, Rc<Vec<CellPhysicsBsp>>> = HashMap::new();

    let mut scene = SpatialScene::new();
    for i in 0..info.num_cells {
        let cell_id = LB_HIGH | (0x0100 + i);
        let Ok(bytes) = cell_dat.get_file(cell_id) else {
            continue;
        };
        let Ok(envcell) = EnvCell::unpack(&mut Cursor::new(&bytes)) else {
            continue;
        };
        let env_did = 0x0D00_0000 | (envcell.environment_id as u32);
        let environment = env_cache
            .entry(env_did)
            .or_insert_with(|| {
                portal
                    .get_file(env_did)
                    .ok()
                    .and_then(|b| Environment::unpack(&mut Cursor::new(&b)).ok())
                    .map(Rc::new)
            })
            .clone();
        let Some(environment) = environment else {
            continue;
        };
        let Some(cs) = environment.cells.get(&(envcell.cell_structure as u32)) else {
            continue;
        };

        let origin = Vector3::new(
            envcell.position.origin.x + LB_X * 192.0,
            envcell.position.origin.y + LB_Y * 192.0,
            envcell.position.origin.z,
        );
        let orient = envcell.position.orientation;

        let resolved = resolve_cell_physics_polygons(&cs.physics_polygons, |vid| {
            cs.vertex_array
                .vertices
                .get(&vid)
                .map(|sw| Vector3::new(sw.origin.x, sw.origin.y, sw.origin.z))
        });
        if let Some(tree) = cs.physics_bsp.clone() {
            scene.insert_cell_physics_bsp(
                cell_id,
                CellPhysicsBsp {
                    tree,
                    polys: resolved,
                    origin,
                    orientation: orient,
                    scale: 1.0,
                },
            );
        }
        if let Some(tree) = cs.cell_bsp.clone() {
            scene.insert_cell_membership(
                cell_id,
                CellMembership {
                    tree,
                    origin,
                    orientation: orient,
                },
            );
        }
        let mut min = Vector3::new(f32::MAX, f32::MAX, f32::MAX);
        let mut max = Vector3::new(f32::MIN, f32::MIN, f32::MIN);
        for sw in cs.vertex_array.vertices.values() {
            let v = Vector3::new(sw.origin.x, sw.origin.y, sw.origin.z);
            let w = orient.rotate_vector(v) + origin;
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
        // Furniture: stab frames are LANDBLOCK-local (2026-07-20 frame audit).
        if !with_furniture {
            continue;
        }
        for stab in &envcell.static_objects {
            let world_origin = Vector3::new(
                stab.position.origin.x + LB_X * 192.0,
                stab.position.origin.y + LB_Y * 192.0,
                stab.position.origin.z,
            );
            let world_orientation = stab.position.orientation;
            let local = model_cache
                .entry(stab.stab_id)
                .or_insert_with(|| {
                    Rc::new(resolve_placement_physics_bsps(
                        &portal,
                        stab.stab_id,
                        Vector3::zero(),
                        Quaternion::identity(),
                    ))
                })
                .clone();
            for part in local.iter() {
                let pr = world_orientation.rotate_vector(part.origin);
                let wo = Vector3::new(
                    world_origin.x + pr.x,
                    world_origin.y + pr.y,
                    world_origin.z + pr.z,
                );
                let wq = world_orientation.multiply(part.orientation);
                scene.insert_cell_static_physics_bsp(
                    cell_id,
                    CellPhysicsBsp {
                        tree: part.tree.clone(),
                        polys: part.polys.clone(),
                        origin: wo,
                        orientation: wq,
                        scale: 1.0,
                    },
                );
            }
        }
    }
    Some(scene)
}

/// Walk `slices` transitional 0.25 m steps along (dx, dy) with contact-plane
/// carry; returns (final pose, per-slice realized distances, final cp).
fn walk(
    env: &TestEnv,
    start: WorldPosition,
    start_cp: Option<(holtburger_common::Plane, u32)>,
    dx: f32,
    dy: f32,
    slices: usize,
    label: &str,
) -> (
    WorldPosition,
    Vec<f32>,
    Option<(holtburger_common::Plane, u32)>,
) {
    let mut cur = start;
    let mut last_cp = start_cp;
    let mut deltas = Vec::new();
    eprintln!("  === WALK {label} from local=({:.3},{:.3},{:.3}) ===", cur.coords.x, cur.coords.y, cur.coords.z);
    for step in 0..slices {
        let mut end = cur;
        end.coords.x += dx;
        end.coords.y += dy;
        let input = input_for(cur, end, last_cp);
        let out = faithful_find_transitional_position(env, &input, true, true);
        let d = xy_dist(&out.pose, &cur);
        deltas.push(d);
        last_cp = out.contact_plane;
        cur = out.pose;
        eprintln!(
            "  {step:>3} cell={:#010x} local=({:.3},{:.3},{:.3}) |d|={d:.4} grounded={}",
            env.scene.current_cell(&cur),
            cur.coords.x,
            cur.coords.y,
            cur.coords.z,
            out.grounded as u8,
        );
    }
    (cur, deltas, last_cp)
}

/// Diagnostic repro (reports, does not assert the bug): the exact live
/// arrival + placement + walk attempts in all four axis directions.
#[test]
fn townnetwork_arrival_walk_repro() {
    let Some(scene) = build_scene() else {
        eprintln!("SKIP townnetwork_arrival_walk_repro: base dats unavailable");
        return;
    };
    let env = TestEnv { scene };
    let object = player_object();
    let g = gates();

    assert!(
        env.scene.cell_physics_bsp(ARRIVAL_CELL).is_some(),
        "setup invariant: 0x00070178 physics BSP must be resident"
    );
    let n_statics = env.scene.cell_static_physics_bsp(ARRIVAL_CELL).len();
    eprintln!(
        "setup: cell {ARRIVAL_CELL:#x} resident, {n_statics} static BSP part(s) staged"
    );

    // The exact live arrival pose (landblock frame, z = 0).
    let start = pose(ARRIVAL_CELL, 121.0, -70.0, 0.0);
    eprintln!(
        "arrival: local=({:.3},{:.3},{:.3}) current_cell={:#010x}",
        start.coords.x,
        start.coords.y,
        start.coords.z,
        env.scene.current_cell(&start),
    );

    let outcome = faithful_find_placement_position(&env, &start, &object, &g);
    let Some(mut o) = outcome else {
        eprintln!(">>> placement search FAILED at the live arrival pose (live logged success — divergence)");
        return;
    };
    eprintln!(
        "placement: grounded={} adjusted_by={:.3}m cell={:#010x} local=({:.3},{:.3},{:.3}) contact={:?}",
        o.grounded,
        o.adjusted_by,
        o.pose.landblock_id.0,
        o.pose.coords.x,
        o.pose.coords.y,
        o.pose.coords.z,
        o.contact_plane.map(|(p, _)| (p.normal, p.d)),
    );

    // The movement system's B1 arrival clamp (system.rs
    // `consume_pending_arrival_placement`): discard a downward-only settle.
    let clamped_z = o.pose.coords.z.max(start.coords.z);
    eprintln!(
        "B1 clamp: settled z={:.4} arrival z={:.4} -> adopted z={:.4}{}",
        o.pose.coords.z,
        start.coords.z,
        clamped_z,
        if clamped_z != o.pose.coords.z { "  <-- CLAMP DISCARDED THE SETTLE" } else { "" }
    );
    o.pose.coords.z = clamped_z;

    // Walk attempts from the adopted pose, contact plane carried like the
    // live movement system does after `land()`.
    let (_end_n, d_n, _) = walk(&env, o.pose, o.contact_plane, 0.0, 0.25, 16, "NORTH (+y, the live micro-step direction)");
    let (_end_s, d_s, _) = walk(&env, o.pose, o.contact_plane, 0.0, -0.25, 16, "SOUTH (-y)");
    let (_end_e, d_e, _) = walk(&env, o.pose, o.contact_plane, 0.25, 0.0, 16, "EAST (+x)");
    let (_end_w, d_w, _) = walk(&env, o.pose, o.contact_plane, -0.25, 0.0, 16, "WEST (-x)");

    let sum = |v: &[f32]| v.iter().sum::<f32>();
    eprintln!(
        "\n=== VERDICT === accumulated: N={:.3} S={:.3} E={:.3} W={:.3} (16 x 0.25m slices each; ~4.0 = free walk)",
        sum(&d_n),
        sum(&d_s),
        sum(&d_e),
        sum(&d_w),
    );

    // ── REGRESSION ASSERTS (retail-spheres fix, 2026-07-24) ──
    //
    // The arrival pose sits inside the TN market stall's U-shaped counter
    // (Setup 0x020019A3 part 0x01004424, slab z 0.835..1.275, faces W x=120.93 /
    // N y=−68.65 / S y=−71.45, open East). Vanilla ACE collides the player
    // with the Setup 0x02000001 spheres (r 0.48 at z 0.475/1.35), whose
    // horizontal reach against the slab is ~0.474 — so ACE can only run
    // transitions from poses with x ≥ ~121.404 and y ∉ (−69.124, −70.976)
    // relative to the counter faces. The pre-fix 0.4-radius capsule settled
    // and slid the client to poses ~9 cm INSIDE that envelope (live: pinned
    // at x=121.31692 / y=−69.03674) and ACE rejected every UpdatePosition.
    //
    // 1) placement grounds with the retail `floor + 0.005` feet z (the low
    //    sphere's bottom is 5 mm below the feet).
    assert!(o.grounded, "arrival placement must ground");
    assert!(
        (o.pose.coords.z - 0.005).abs() < 0.002,
        "feet z must settle at floor+0.005 (retail low-sphere rest), got {}",
        o.pose.coords.z
    );
    // 2) the settled pose is OUTSIDE the ACE/retail-sphere contact envelope
    //    of the stall counter (W face x=120.93 + 0.474 reach).
    assert!(
        o.pose.coords.x >= 121.404,
        "settled pose must clear ACE's W-counter contact envelope (x >= 121.404), got {}",
        o.pose.coords.x
    );
    assert!(
        o.pose.coords.y <= -69.124,
        "settled pose must clear ACE's N-counter contact envelope (y <= -69.124), got {}",
        o.pose.coords.y
    );
    // 3) client movement now agrees with ACE: the counter directions refuse
    //    OUTSIDE ACE's envelope (no poses the server would reject) and the
    //    open East side walks out of the aisle.
    assert!(
        sum(&d_e) >= 3.0,
        "East (the aisle opening) must walk out, realized {:.3}",
        sum(&d_e)
    );
    assert!(
        sum(&d_n) < 0.05 && sum(&d_w) < 0.05,
        "N/W are inside the counter — the client must refuse them like ACE does (N={:.3} W={:.3})",
        sum(&d_n),
        sum(&d_w)
    );
    // 4) every settled walk pose stays outside ACE's contact envelope
    //    (x >= 121.404 while west of the counter mouth; the East escape exits
    //    the stall footprint entirely).
    for (label, end) in [("N", &_end_n), ("S", &_end_s), ("W", &_end_w)] {
        assert!(
            end.coords.x >= 121.404 - 1e-3,
            "{label} walk parked inside ACE's W-counter envelope: x={}",
            end.coords.x
        );
    }
}

/// Env-BSP-only control: identical arrival + walks with NO furniture staged.
/// If the wedge persists here, the phantom wall is the cell's own physics
/// BSP; if it disappears, the staged static prop is the culprit.
#[test]
fn townnetwork_arrival_walk_no_furniture_control() {
    let Some(scene) = build_scene_no_furniture() else {
        eprintln!("SKIP townnetwork_arrival_walk_no_furniture_control: base dats unavailable");
        return;
    };
    let env = TestEnv { scene };
    let object = player_object();
    let g = gates();

    let start = pose(ARRIVAL_CELL, 121.0, -70.0, 0.0);
    let outcome = faithful_find_placement_position(&env, &start, &object, &g);
    let Some(o) = outcome else {
        eprintln!(">>> placement search FAILED (no-furniture control)");
        return;
    };
    eprintln!(
        "placement (no furniture): grounded={} adjusted_by={:.3}m local=({:.3},{:.3},{:.3})",
        o.grounded, o.adjusted_by, o.pose.coords.x, o.pose.coords.y, o.pose.coords.z,
    );
    let (_e1, d_n, _) = walk(&env, o.pose, o.contact_plane, 0.0, 0.25, 16, "NORTH (no furniture)");
    let (_e2, d_s, _) = walk(&env, o.pose, o.contact_plane, 0.0, -0.25, 16, "SOUTH (no furniture)");
    let (_e3, d_e, _) = walk(&env, o.pose, o.contact_plane, 0.25, 0.0, 16, "EAST (no furniture)");
    let (_e4, d_w, _) = walk(&env, o.pose, o.contact_plane, -0.25, 0.0, 16, "WEST (no furniture)");
    let sum = |v: &[f32]| v.iter().sum::<f32>();
    eprintln!(
        "\n=== NO-FURNITURE VERDICT === N={:.3} S={:.3} E={:.3} W={:.3}",
        sum(&d_n), sum(&d_s), sum(&d_e), sum(&d_w),
    );
}

/// Deep per-slice drill-down on the wedged steps using `faithful_diag_step`
/// + the resolver's transition trace — the same instrumentation
/// `academy_wedge_tests::academy_wedge_diag_overhang_freeze` used to pin the
/// vault-soffit overhang.
#[test]
fn townnetwork_wedge_diag() {
    let Some(scene) = build_scene() else {
        eprintln!("SKIP townnetwork_wedge_diag: base dats unavailable");
        return;
    };
    let env = TestEnv { scene };
    let object = player_object();
    let g = gates();

    let start = pose(ARRIVAL_CELL, 121.0, -70.0, 0.0);
    holtburger_dat::transition::trace::set_transition_trace(true);
    let placement = faithful_find_placement_position(&env, &start, &object, &g);
    holtburger_dat::transition::trace::set_transition_trace(false);
    if placement.is_none() {
        eprintln!("--- placement trace (FAILED) ---");
        for line in holtburger_dat::transition::trace::transition_trace_log() {
            eprintln!("{line}");
        }
    }
    let Some(o) = placement else {
        eprintln!("SKIP townnetwork_wedge_diag: placement failed");
        return;
    };
    eprintln!(
        "seed: grounded={} local=({:.3},{:.3},{:.3}) contact={:?}",
        o.grounded,
        o.pose.coords.x,
        o.pose.coords.y,
        o.pose.coords.z,
        o.contact_plane.map(|(p, _)| (p.normal, p.d)),
    );

    // Reproduce the WEST refusal (immediate, slice 0) with full trace.
    let mut end = o.pose;
    end.coords.x -= 0.25;
    let mut input = input_for(o.pose, end, o.contact_plane);
    input.last_contact_plane = o.contact_plane;
    holtburger_dat::transition::trace::set_transition_trace(true);
    let diag = faithful_diag_step(&env, &input, true);
    holtburger_dat::transition::trace::set_transition_trace(false);
    eprintln!("--- WEST slice-0 trace ---");
    for line in holtburger_dat::transition::trace::transition_trace_log() {
        eprintln!("{line}");
    }
    eprintln!(
        "WEST diag: found={} realized={:.4} state_in={:#x} state_out={:#x}\n  contact={:?}\n  last_known={:?}\n  collision_normal={:?} sliding_normal={:?}\n  walkable={} wpn={:?} step_up={} neg_poly_hit={}\n  curr_pos_cell={:#x} check_pos_cell={:#x}",
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
    );
}
