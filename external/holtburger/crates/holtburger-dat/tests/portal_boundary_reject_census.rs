//! cells-portals-7 (2026-10-13) — census of retail's ±12 boundary-portal
//! reject against the world-frame "multiple of 24" stand-in the web client
//! runs (`apps/holtburger-web/scene3d/portal_clip.js#isLandCellBoundaryPoly`,
//! applied to every punch AND seal aperture by `clipAperturesForPunch`).
//!
//! Retail: `D3DPolyRender::DrawPortalPolyInternal` (`acclient.c:453882`)
//! skips a portal polygon when every vertex has `x == 12.0`, or every
//! `x == -12.0`, or every `y == 12.0`, or every `y == -12.0` — EXACT float
//! compares on `p->vertices[i]`, i.e. in the frame pushed for that draw:
//!
//!  - the indoor SEAL: `PView::DrawCells` pushes the EnvCell's `pos`
//!    (`acclient.c:461509`) before `DrawPortalPolyInternal(cell->portals[i]
//!    .portal, 0)` (`acclient.c:461538`) → CellStruct-local vertices;
//!  - the outdoor PUNCH: `PView::DrawPortal` → `ConstructView(CBldPortal*,
//!    CPolygon*, …)` (`acclient.c:462507-462582`) passes `portal->portal`, the
//!    building GfxObj's drawing-BSP `CPortalPoly` → GfxObj-local vertices,
//!    `portal_index` naming the building's `CBldPortal`.
//!
//! The web client only has the LANDBLOCK-frame aperture (the wasm applies the
//! cell frame in `fetchEnvCellsInLandblock`, f32), so it tests "on a 24 m
//! LandCell line, ±1e-3" instead. That equals retail only for a cell centred
//! on its landcell with a right-angle yaw, and its tolerance is looser than an
//! exact compare. This sweep sizes the difference. Three predicates per
//! outdoor-facing EnvCell portal (`CellPortal::leads_outdoors`):
//!
//!  1. retail, CellStruct-local (the seal, exactly);
//!  2. the JS world mod-24 test on the vertices the wasm emits;
//!  3. retail, building-GfxObj-local (the punch, exactly), linked to the
//!     EnvCell portal through `BuildInfo.portals[portal_index]` →
//!     (`other_cell_id`, `other_portal_id`).
//!
//! **Measured 2026-10-13 on the retail baseline** (`~/ac_base_dats`; first
//! run through the read-only `tools/dat-patch` Python reader with these exact
//! predicates — this test reproduces it):
//!
//!  - 16,997 outdoor-facing portals, all resolved. Retail (1) skips 2,163;
//!    the JS test (2) skips 2,545. They DISAGREE on 412:
//!    - 374 retail draws, JS skips — tolerance: a local wall at ±12 with
//!      some vertices at ±12.0001 (f32 12.000100…), which retail's exact
//!      compare keeps; 366 of them in Environments 0x0D0005B4-0x0D0005C0
//!      (e.g. `0D4A0100#1`);
//!    - 23 retail draws, JS skips — not near one local wall: 19 off-centre
//!      cells whose portal lands on a world 24 m line (e.g. `20BF010C#0`,
//!      local x = -4), and 4 polygons spanning BOTH walls (`EC0E0111#1`,
//!      y in {-12, +12}) — the JS test only asks each vertex to sit on SOME
//!      24 m line, retail asks for one shared ±12;
//!    - 15 retail skips, JS draws — frame: an off-centre cell whose local ±12
//!      wall is off the world grid (e.g. `0D4A0107#2`, origin x = 84.0262).
//!
//!    None of the 412 involves a non-right-angle yaw.
//!  - 6,979 buildings, all GfxObj models; 16,937 building portal polys, all
//!    linked to an outdoor-facing EnvCell portal. Retail (3) skips 2,163 of
//!    them and agrees with (1) on **every** linked portal — so the
//!    CellStruct-local exact test is a faithful stand-in for the punch too.
//!
//! Run with
//!
//! ```text
//! cargo test -p holtburger-dat --test portal_boundary_reject_census -- --ignored --nocapture
//! ```
//!
//! The pure predicate tests at the bottom are not ignored.

use holtburger_common::{Quaternion, Vector3};
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::{EnvCell, Environment, GfxObj};
use holtburger_dat::graphics::{CVertexArray, Polygon};
use holtburger_dat::landblock::LandblockInfo;
use holtburger_dat::physics::{BspNode, PortalPoly};
use std::collections::HashMap;
use std::io::Cursor;
use std::path::PathBuf;

const ENVCELL_LOW_MIN: u32 = 0x0100;
const ENVCELL_LOW_MAX: u32 = 0xFFFD;
const LANDBLOCK_INFO_LOW: u32 = 0xFFFE;
/// `fetchEnvCellsInLandblock`'s `LB_M`.
const LB_M: f32 = 192.0;
/// `isLandCellBoundaryPoly`'s `EPS`.
const JS_EPS: f64 = 1e-3;
/// "Near a single local ±12 plane" for splitting the tolerance class off the
/// frame class. Every tolerance case measured sits within 1.0005e-3.
const NEAR_PLANE_M: f32 = 2e-3;
const MAX_EXAMPLES: usize = 8;

fn base_dat(env_var: &str, names: &[&str]) -> Option<PathBuf> {
    if let Ok(p) = std::env::var(env_var) {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    names
        .iter()
        .map(|n| PathBuf::from("/home/wbterminal/ac_base_dats").join(n))
        .find(|p| p.exists())
}

/// Retail's edge guard, `D3DPolyRender::DrawPortalPolyInternal`
/// (`acclient.c:453918-453931`), on the polygon's OWN vertices: `true` when
/// it fires (the portal is not drawn). Exact compares, as retail does them.
#[allow(clippy::float_cmp)]
fn retail_boundary_skip(local: &[[f32; 3]]) -> bool {
    if local.is_empty() {
        return false;
    }
    local.iter().all(|v| v[0] == 12.0)
        || local.iter().all(|v| v[0] == -12.0)
        || local.iter().all(|v| v[1] == 12.0)
        || local.iter().all(|v| v[1] == -12.0)
}

/// `scene3d/portal_clip.js#isLandCellBoundaryPoly`, ported: run in f64 on
/// the f32 the wasm emits, every x on SOME 24 m line or every y on one,
/// within 1e-3.
fn js_world_mod24_skip(world: &[[f32; 3]]) -> bool {
    if world.len() < 3 {
        return false;
    }
    let on_line = |v: f32| -> bool {
        let v = v as f64;
        if !v.is_finite() {
            return false;
        }
        let m = v - (v / 24.0).floor() * 24.0;
        m.abs() < JS_EPS || (m - 24.0).abs() < JS_EPS
    };
    world.iter().all(|v| on_line(v[0])) || world.iter().all(|v| on_line(v[1]))
}

/// The aperture vertices exactly as `fetchEnvCellsInLandblock` builds them:
/// `cell_origin = position.origin + LB corner` (f32), then
/// `cell_origin + orientation.rotate_vector(local)` (f32).
fn wasm_world_verts(
    origin: Vector3,
    orientation: Quaternion,
    cell_id: u32,
    local: &[[f32; 3]],
) -> Vec<[f32; 3]> {
    let lb_x = ((cell_id >> 24) & 0xFF) as f32 * LB_M;
    let lb_y = ((cell_id >> 16) & 0xFF) as f32 * LB_M;
    let (cx, cy, cz) = (origin.x + lb_x, origin.y + lb_y, origin.z);
    local
        .iter()
        .map(|v| {
            let r = orientation.rotate_vector(Vector3::new(v[0], v[1], v[2]));
            [cx + r.x, cy + r.y, cz + r.z]
        })
        .collect()
}

fn poly_verts(poly: &Polygon, va: &CVertexArray) -> Option<Vec<[f32; 3]>> {
    if poly.vertex_ids.len() < 3 {
        return None;
    }
    poly.vertex_ids
        .iter()
        .map(|&vid| {
            va.vertices
                .get(&(vid as u16))
                .map(|v| [v.origin.x, v.origin.y, v.origin.z])
        })
        .collect()
}

/// Every vertex within `NEAR_PLANE_M` of ONE of the four local ±12 planes.
fn near_local_wall(local: &[[f32; 3]]) -> bool {
    [(0usize, 12.0f32), (0, -12.0), (1, 12.0), (1, -12.0)]
        .iter()
        .any(|&(axis, wall)| local.iter().all(|v| (v[axis] - wall).abs() < NEAR_PLANE_M))
}

/// Yaw-only quaternion whose yaw is a multiple of 90°.
fn right_angle_yaw(q: Quaternion) -> bool {
    const S: f32 = std::f32::consts::FRAC_1_SQRT_2;
    let yaw_only = q.x.abs() < 1e-6 && q.y.abs() < 1e-6;
    yaw_only
        && [(1.0f32, 0.0f32), (0.0, 1.0), (S, S)]
            .iter()
            .any(|&(w, z)| (q.w.abs() - w).abs() < 1e-4 && (q.z.abs() - z).abs() < 1e-4)
}

/// Origin x and y at a landcell centre (12 mod 24).
fn centred_on_landcell(origin: Vector3) -> bool {
    [origin.x, origin.y]
        .iter()
        .all(|&c| ((c as f64).rem_euclid(24.0) - 12.0).abs() < 1e-3)
}

fn collect_portal_polys(node: &BspNode, out: &mut Vec<PortalPoly>) {
    match node {
        BspNode::Port(p) => {
            collect_portal_polys(&p.pos, out);
            collect_portal_polys(&p.neg, out);
            out.extend_from_slice(&p.portal_polys);
        }
        BspNode::Internal(n) => {
            if let Some(c) = &n.pos {
                collect_portal_polys(c, out);
            }
            if let Some(c) = &n.neg {
                collect_portal_polys(c, out);
            }
        }
        BspNode::Leaf(_) => {}
    }
}

fn push_example(v: &mut Vec<String>, s: String) {
    if v.len() < MAX_EXAMPLES {
        v.push(s);
    }
}

#[derive(Default, Debug)]
struct Census {
    envcell_parse_failures: u64,
    outdoor_portals: u64,
    unresolved: u64,
    measured: u64,
    frame_off_centre: u64,
    frame_not_right_angle: u64,
    retail_skip: u64,
    js_skip: u64,
    /// retail draws, JS skips, local polygon within `NEAR_PLANE_M` of ±12.
    js_skips_tolerance: u64,
    /// retail draws, JS skips, not near ONE local wall (the frame put it on
    /// a world 24 m line, or it spans both ±12 walls).
    js_skips_frame: u64,
    /// retail skips, JS draws.
    retail_skips_js_draws: u64,
    /// disagreements whose cell frame is not a right-angle yaw.
    disagree_not_right_angle: u64,
    ex_tolerance: Vec<String>,
    ex_frame: Vec<String>,
    ex_retail_only: Vec<String>,

    lbi_parse_failures: u64,
    buildings: u64,
    building_not_gfxobj: u64,
    building_gfx_failures: u64,
    bld_portal_polys: u64,
    bld_unresolved: u64,
    bld_unlinked: u64,
    bld_linked: u64,
    bld_retail_skip: u64,
    /// building-GfxObj-local retail test != CellStruct-local retail test.
    bld_vs_cell_local: u64,
    /// building-GfxObj-local retail test != the JS world test.
    bld_vs_js: u64,
    ex_bld_vs_cell_local: Vec<String>,
}

#[test]
#[ignore = "retail census over ~/ac_base_dats; run with --ignored --nocapture"]
fn portal_boundary_reject_census() {
    let Some(cell_path) =
        base_dat("HOLTBURGER_CELL_DAT", &["client_cell_1.dat", "client_cell.dat"])
    else {
        eprintln!("SKIP portal_boundary_reject_census: no client_cell dat (set HOLTBURGER_CELL_DAT)");
        return;
    };
    let Some(portal_path) = base_dat("HOLTBURGER_PORTAL_DAT", &["client_portal.dat"]) else {
        eprintln!("SKIP portal_boundary_reject_census: no client_portal.dat (set HOLTBURGER_PORTAL_DAT)");
        return;
    };
    let cell_dat = DatDatabase::new(&cell_path).expect("open client_cell dat");
    let portal_dat = DatDatabase::new(&portal_path).expect("open client_portal.dat");

    let mut c = Census::default();
    let mut envs: HashMap<u32, Option<Environment>> = HashMap::new();
    // (EnvCell id, portal index) → (JS world skip, retail CellStruct-local skip).
    let mut outdoor: HashMap<(u32, usize), (bool, bool)> = HashMap::new();

    // ── Pass 1: every outdoor-facing EnvCell portal ────────────────────
    let mut cell_ids: Vec<u32> = cell_dat
        .files
        .keys()
        .copied()
        .filter(|id| (ENVCELL_LOW_MIN..=ENVCELL_LOW_MAX).contains(&(id & 0xFFFF)))
        .collect();
    cell_ids.sort_unstable();
    for cid in cell_ids {
        let Ok(bytes) = cell_dat.get_file(cid) else { continue };
        let Ok(envcell) = EnvCell::unpack(&mut Cursor::new(&bytes)) else {
            c.envcell_parse_failures += 1;
            continue;
        };
        if !envcell.portals.iter().any(|p| p.leads_outdoors()) {
            continue;
        }
        let env_id = 0x0D00_0000 | envcell.environment_id as u32;
        let env = envs
            .entry(env_id)
            .or_insert_with(|| {
                portal_dat
                    .get_file(env_id)
                    .ok()
                    .and_then(|b| Environment::unpack(&mut Cursor::new(&b)).ok())
            })
            .as_ref();
        let cs = env.and_then(|e| e.cells.get(&(envcell.cell_structure as u32)));
        let origin = envcell.position.origin;
        let orientation = envcell.position.orientation;
        let centred = centred_on_landcell(origin);
        let right = right_angle_yaw(orientation);
        for (pidx, p) in envcell.portals.iter().enumerate() {
            if !p.leads_outdoors() {
                continue;
            }
            c.outdoor_portals += 1;
            let Some(local) = cs
                .and_then(|cs| cs.polygons.get(&p.polygon_id).map(|poly| (poly, cs)))
                .and_then(|(poly, cs)| poly_verts(poly, &cs.vertex_array))
            else {
                c.unresolved += 1;
                continue;
            };
            c.measured += 1;
            if !centred {
                c.frame_off_centre += 1;
            }
            if !right {
                c.frame_not_right_angle += 1;
            }
            let world = wasm_world_verts(origin, orientation, cid, &local);
            let retail = retail_boundary_skip(&local);
            let js = js_world_mod24_skip(&world);
            outdoor.insert((cid, pidx), (js, retail));
            if retail {
                c.retail_skip += 1;
            }
            if js {
                c.js_skip += 1;
            }
            if retail != js && !right {
                c.disagree_not_right_angle += 1;
            }
            let tag = format!("{cid:08X}#{pidx}");
            match (retail, js) {
                (false, true) if near_local_wall(&local) => {
                    c.js_skips_tolerance += 1;
                    push_example(&mut c.ex_tolerance, tag);
                }
                (false, true) => {
                    c.js_skips_frame += 1;
                    push_example(&mut c.ex_frame, tag);
                }
                (true, false) => {
                    c.retail_skips_js_draws += 1;
                    push_example(&mut c.ex_retail_only, tag);
                }
                _ => {}
            }
        }
    }

    // ── Pass 2: the punch's own polygon — building GfxObj portal polys ──
    let mut lbi_ids: Vec<u32> = cell_dat
        .files
        .keys()
        .copied()
        .filter(|id| (id & 0xFFFF) == LANDBLOCK_INFO_LOW)
        .collect();
    lbi_ids.sort_unstable();
    let mut gfx_cache: HashMap<u32, Option<GfxObj>> = HashMap::new();
    for lid in lbi_ids {
        let Ok(bytes) = cell_dat.get_file(lid) else { continue };
        let Ok(info) = LandblockInfo::unpack(&bytes) else {
            c.lbi_parse_failures += 1;
            continue;
        };
        for b in &info.buildings {
            c.buildings += 1;
            if (b.model_id >> 24) != 0x01 {
                c.building_not_gfxobj += 1;
                continue;
            }
            let model_id = b.model_id;
            let Some(gfx) = gfx_cache
                .entry(model_id)
                .or_insert_with(|| {
                    portal_dat
                        .get_file(model_id)
                        .ok()
                        .and_then(|g| GfxObj::unpack(&mut Cursor::new(&g)).ok())
                })
                .as_ref()
            else {
                c.building_gfx_failures += 1;
                continue;
            };
            let mut pps: Vec<PortalPoly> = Vec::new();
            if let Some(bsp) = &gfx.drawing_bsp {
                collect_portal_polys(bsp, &mut pps);
            }
            for pp in pps {
                c.bld_portal_polys += 1;
                let bld_portal = usize::try_from(pp.portal_index)
                    .ok()
                    .and_then(|i| b.portals.get(i));
                let local = gfx
                    .polygons
                    .get(&(pp.poly_id as u16))
                    .and_then(|poly| poly_verts(poly, &gfx.vertex_array));
                let (Some(bp), Some(local)) = (bld_portal, local) else {
                    c.bld_unresolved += 1;
                    continue;
                };
                let retail = retail_boundary_skip(&local);
                if retail {
                    c.bld_retail_skip += 1;
                }
                let key = (
                    (lid & 0xFFFF_0000) | bp.other_cell_id as u32,
                    bp.other_portal_id as usize,
                );
                let Some(&(js, cell_local)) = outdoor.get(&key) else {
                    c.bld_unlinked += 1;
                    continue;
                };
                c.bld_linked += 1;
                if retail != cell_local {
                    c.bld_vs_cell_local += 1;
                    push_example(
                        &mut c.ex_bld_vs_cell_local,
                        format!("{:08X}#{} (bld {model_id:08X})", key.0, key.1),
                    );
                }
                if retail != js {
                    c.bld_vs_js += 1;
                }
            }
        }
    }

    println!("── ±12 boundary-portal reject census ──");
    println!("  cell dat   {}", cell_path.display());
    println!("  portal dat {}", portal_path.display());
    println!("  EnvCell parse failures                    {}", c.envcell_parse_failures);
    println!("  outdoor-facing portals                    {}", c.outdoor_portals);
    println!("    unresolved (no CellStruct/poly/verts)   {}", c.unresolved);
    println!("    measured                                {}", c.measured);
    println!("    cell frame off a landcell centre        {}", c.frame_off_centre);
    println!("    cell frame yaw not a multiple of 90°    {}", c.frame_not_right_angle);
    println!("  retail skip (CellStruct-local, exact)     {}", c.retail_skip);
    println!("  JS skip (world mod-24, ±1e-3)             {}", c.js_skip);
    println!("  DISAGREE retail draws, JS skips — tolerance {}", c.js_skips_tolerance);
    println!("  DISAGREE retail draws, JS skips — frame/span {}", c.js_skips_frame);
    println!("  DISAGREE retail skips, JS draws             {}", c.retail_skips_js_draws);
    println!("    of which non-right-angle yaw            {}", c.disagree_not_right_angle);
    println!("  examples tolerance: {:?}", c.ex_tolerance);
    println!("  examples frame:     {:?}", c.ex_frame);
    println!("  examples retail-only skip: {:?}", c.ex_retail_only);
    println!("  LandblockInfo parse failures              {}", c.lbi_parse_failures);
    println!("  buildings                                 {}", c.buildings);
    println!("    model not a GfxObj                      {}", c.building_not_gfxobj);
    println!("    GfxObj parse failures                   {}", c.building_gfx_failures);
    println!("  building portal polys                     {}", c.bld_portal_polys);
    println!("    unresolved                              {}", c.bld_unresolved);
    println!("    no matching outdoor EnvCell portal      {}", c.bld_unlinked);
    println!("    linked                                  {}", c.bld_linked);
    println!("    retail skip (building-GfxObj-local)     {}", c.bld_retail_skip);
    println!("    != CellStruct-local retail test         {}", c.bld_vs_cell_local);
    println!("    != JS world test                        {}", c.bld_vs_js);
    println!("  examples building vs cell-local: {:?}", c.ex_bld_vs_cell_local);

    assert!(c.measured > 0, "no outdoor-facing portals measured — wrong dat?");
    assert!(c.bld_linked > 0, "no building portal linked to an EnvCell portal — wrong dat?");
    // The finding that licenses a CellStruct-local replacement for BOTH the
    // seal and the punch: on the retail baseline the building's own portal
    // polygon and the EnvCell exit portal it leads to always get the same
    // retail verdict (16,937 / 16,937 measured 2026-10-13).
    assert_eq!(
        c.bld_vs_cell_local, 0,
        "the building-GfxObj-local and CellStruct-local retail tests disagree \
         — a CellStruct-local boundary_skip would not be exact for the punch"
    );
}

// ── Pure predicate tests (not ignored) ─────────────────────────────────

/// A yaw-only quaternion (w, x, y, z) for `deg` degrees about +Z.
fn yaw(deg: f32) -> Quaternion {
    let h = deg.to_radians() * 0.5;
    Quaternion {
        w: h.cos(),
        x: 0.0,
        y: 0.0,
        z: h.sin(),
    }
}

#[test]
fn retail_rule_skips_polygons_flat_on_one_local_wall() {
    let x_pos = [[12.0, -2.0, 0.0], [12.0, 2.0, 0.0], [12.0, 2.0, 3.0], [12.0, -2.0, 3.0]];
    let x_neg = [[-12.0, -2.0, 0.0], [-12.0, 2.0, 0.0], [-12.0, 2.0, 3.0]];
    let y_pos = [[-2.0, 12.0, 0.0], [2.0, 12.0, 0.0], [2.0, 12.0, 3.0]];
    let y_neg = [[-2.0, -12.0, 0.0], [2.0, -12.0, 0.0], [2.0, -12.0, 3.0], [-2.0, -12.0, 3.0]];
    for poly in [&x_pos[..], &x_neg[..], &y_pos[..], &y_neg[..]] {
        assert!(retail_boundary_skip(poly), "{poly:?}");
    }
}

#[test]
fn retail_rule_keeps_mixed_spanning_and_near_miss_polygons() {
    // One vertex off the wall.
    let mixed = [[12.0, -2.0, 0.0], [12.0, 2.0, 0.0], [11.5, 2.0, 3.0]];
    // Every |x| == 12 but on opposite walls (a floor spanning the cell).
    let spanning = [[-12.0, -2.0, 0.0], [12.0, -2.0, 0.0], [12.0, 2.0, 0.0], [-12.0, 2.0, 0.0]];
    // The census's dominant class: half the vertices at f32 12.0001.
    let near_miss = [
        [9.6, 12.0, 11.0],
        [9.6, 12.0, 0.2],
        [-7.7651, 12.0001, 0.2],
        [-7.7651, 12.0001, 11.0],
    ];
    assert!(!retail_boundary_skip(&mixed));
    assert!(!retail_boundary_skip(&spanning));
    assert!(!retail_boundary_skip(&near_miss));
}

#[test]
fn rotated_45_cell_local_wall_is_skipped_although_off_the_world_grid() {
    let cell_id = 0xA9B4_0100;
    let origin = Vector3::new(12.0, 12.0, 0.0);
    let local = [[12.0, -2.0, 0.0], [12.0, 2.0, 0.0], [12.0, 2.0, 3.0], [12.0, -2.0, 3.0]];
    let world = wasm_world_verts(origin, yaw(45.0), cell_id, &local);
    assert!(retail_boundary_skip(&local));
    assert!(!js_world_mod24_skip(&world), "{world:?}");
}

#[test]
fn off_centre_cell_world_grid_line_is_kept_by_retail() {
    // Origin x = 28: local x = -4 lands on world x = 24 (+ LB corner).
    let cell_id = 0xA9B4_0105;
    let origin = Vector3::new(28.0, 12.0, 0.0);
    let local = [[-4.0, -2.0, 0.0], [-4.0, 2.0, 0.0], [-4.0, 2.0, 3.0], [-4.0, -2.0, 3.0]];
    let world = wasm_world_verts(origin, yaw(0.0), cell_id, &local);
    assert!(!retail_boundary_skip(&local));
    assert!(js_world_mod24_skip(&world), "{world:?}");
}

#[test]
fn off_centre_cell_local_wall_is_skipped_by_retail_only() {
    // `0D4A0107#2`-shaped: origin x off the landcell centre by 0.0262.
    let cell_id = 0x0D4A_0107;
    let origin = Vector3::new(84.0262, 36.0055, 18.0);
    let local = [[7.7645, 12.0, 0.2], [-7.7644, 12.0, 0.2], [-7.7644, 12.0, 11.0], [7.7645, 12.0, 11.0]];
    let world = wasm_world_verts(origin, yaw(0.0), cell_id, &local);
    assert!(retail_boundary_skip(&local));
    assert!(!js_world_mod24_skip(&world), "{world:?}");
}

#[test]
fn centred_cell_tolerance_near_miss_is_skipped_by_js_only() {
    // `0D4A0100#1`: a centred, unrotated cell; the world test's 1e-3
    // tolerance (and f32 at 14,256 m) cannot see 12.0001 != 12.
    let cell_id = 0x0D4A_0100;
    let origin = Vector3::new(156.0, 36.0, 18.0);
    let local = [
        [9.6, 12.0, 11.0],
        [9.6, 12.0, 0.2],
        [-7.7651, 12.0001, 0.2],
        [-7.7651, 12.0001, 11.0],
    ];
    let world = wasm_world_verts(origin, yaw(0.0), cell_id, &local);
    assert!(!retail_boundary_skip(&local));
    assert!(js_world_mod24_skip(&world), "{world:?}");
}

#[test]
fn polygon_spanning_both_walls_is_skipped_by_js_only() {
    // `EC0E0111#1`: a centred cell's gable portal with y = -12 AND y = +12.
    // Every y is on SOME 24 m line, so the JS test fires; retail wants every
    // y equal to one of ±12.
    let cell_id = 0xEC0E_0111;
    let origin = Vector3::new(156.0, 36.0, 0.0);
    let local = [[-4.685, -12.0, 27.2], [-4.685, 12.0, 27.2], [-4.685, 12.0, 21.895]];
    let world = wasm_world_verts(origin, yaw(0.0), cell_id, &local);
    assert!(!retail_boundary_skip(&local));
    assert!(js_world_mod24_skip(&world), "{world:?}");
}

#[test]
fn centred_right_angle_cell_exact_wall_agrees() {
    // `0D4A0100#0`, and the same wall under a 90° yaw.
    let cell_id = 0x0D4A_0100;
    let origin = Vector3::new(156.0, 36.0, 18.0);
    let local = [[-12.0, 7.7644, 0.2], [-12.0, -9.6, 0.2], [-12.0, -9.6, 11.0], [-12.0, 7.7644, 11.0]];
    for deg in [0.0, 90.0, 180.0, 270.0] {
        let world = wasm_world_verts(origin, yaw(deg), cell_id, &local);
        assert!(retail_boundary_skip(&local));
        assert!(js_world_mod24_skip(&world), "yaw {deg}: {world:?}");
    }
}

#[test]
fn frame_classifiers() {
    assert!(centred_on_landcell(Vector3::new(156.0, 36.0, 18.0)));
    assert!(!centred_on_landcell(Vector3::new(84.0262, 36.0055, 18.0)));
    for deg in [0.0, 90.0, 180.0, 270.0, -90.0] {
        assert!(right_angle_yaw(yaw(deg)), "yaw {deg}");
    }
    assert!(!right_angle_yaw(yaw(45.0)));
    assert!(near_local_wall(&[[1.0, 12.0001, 0.0], [2.0, 12.0, 0.0], [2.0, 12.0, 3.0]]));
    assert!(!near_local_wall(&[[-4.0, -2.0, 0.0], [-4.0, 2.0, 0.0], [-4.0, 2.0, 3.0]]));
}
