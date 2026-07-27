//! `scenery-bake-determinism` — Phase B.4 determinism stress harness.
//!
//! Bakes the 13×13 Holtburg ring (`0xA3AE..0xAFBA`) TWICE in a row
//! against the canonical retail base DATs and asserts byte-identical
//! JSONL output across all 169 landblocks. The purpose is to confirm
//! that the Rust port's "determinism contract" (`hypotheticalmethod.md`,
//! the load-bearing property of the whole world-completeness method)
//! holds run-to-run on a non-trivial workload.
//!
//! Intended invocation: `cargo run --release -p holtburger-tools
//! --bin scenery-bake-determinism`.
//!
//! No CLI flags by default — the binary picks up the standard DAT
//! locations and writes its scratch output under
//! `/mnt/wbterminal1/tmp/claude-scratch/scenery-bake/b4/determinism/`.
//! Override with the `HOLTBURGER_*` env vars (same convention as the
//! integration test).
//!
//! Exit code 0 = determinism holds; non-zero = drift found, with a
//! per-LB diff summary printed to stderr.

use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use holtburger_common::Vector3;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::{GfxObj, Region, Scene, SetupModel};
use holtburger_dat::landblock::{CellLandblock, LandblockInfo};
use holtburger_scenery_bake::{
    Aabb2D, Aabb3D, BakeMode, PlacementXform, ScenicPlacement, bake_landblock,
    transform_mesh_to_aabb, transform_mesh_to_aabb3,
};

fn locate_dats() -> Result<(PathBuf, PathBuf)> {
    let portal_env = std::env::var_os("HOLTBURGER_PORTAL_DAT").map(PathBuf::from);
    let cell_env = std::env::var_os("HOLTBURGER_CELL_DAT").map(PathBuf::from);
    let portal_candidates = [
        portal_env,
        Some(PathBuf::from(
            "/home/wbterminal/projects/RetailSmoke/dats/base/client_portal.dat",
        )),
        Some(PathBuf::from(
            "/home/wbterminal/ac_base_dats/client_portal.dat",
        )),
    ];
    let cell_candidates = [
        cell_env,
        Some(PathBuf::from(
            "/home/wbterminal/projects/RetailSmoke/dats/base/client_cell_1.dat",
        )),
        Some(PathBuf::from(
            "/home/wbterminal/ac_base_dats/client_cell_1.dat",
        )),
    ];
    let portal = portal_candidates
        .into_iter()
        .flatten()
        .find(|p| p.exists())
        .context("client_portal.dat not found in any candidate location")?;
    let cell = cell_candidates
        .into_iter()
        .flatten()
        .find(|p| p.exists())
        .context("client_cell_1.dat not found in any candidate location")?;
    Ok((portal, cell))
}

/// 13×13 ring around Holtburg LB 0xA9B4. xlo=0xA3, ylo=0xAE,
/// xhi=0xAF, yhi=0xBA. 169 LBs row-major.
fn holtburg_ring() -> Vec<u16> {
    let mut out = Vec::with_capacity(169);
    for x in 0xA3u32..=0xAF {
        for y in 0xAEu32..=0xBA {
            out.push(((x as u16) << 8) | (y as u16));
        }
    }
    out
}

/// Mesh-local vertex-list cache. Mirrors scenery-bake.rs::MeshCache —
/// each obj_id resolves to its flattened mesh vertex list (no per-part
/// PlacementFrames, matching ACE BoundingBox.BuildBox).
struct MeshCache {
    inner: HashMap<u32, Option<Vec<Vector3>>>,
}

impl MeshCache {
    fn new() -> Self {
        Self { inner: HashMap::new() }
    }
    fn lookup(&mut self, portal: &DatDatabase, obj_id: u32) -> Option<&Vec<Vector3>> {
        if !self.inner.contains_key(&obj_id) {
            let r = compute_local_mesh(portal, obj_id);
            self.inner.insert(obj_id, r);
        }
        self.inner.get(&obj_id)?.as_ref()
    }
}

fn compute_local_mesh(portal: &DatDatabase, obj_id: u32) -> Option<Vec<Vector3>> {
    let top = (obj_id >> 24) & 0xFF;
    match top {
        0x01 => gfx_local_mesh(portal, obj_id),
        0x02 => setup_local_mesh(portal, obj_id),
        _ => None,
    }
}

fn gfx_local_mesh(portal: &DatDatabase, gfx_id: u32) -> Option<Vec<Vector3>> {
    let bytes = portal.get_file(gfx_id).ok()?;
    let mut cursor = Cursor::new(&bytes);
    let gfx = GfxObj::unpack(&mut cursor).ok()?;
    if gfx.vertex_array.vertices.is_empty() {
        return None;
    }
    Some(gfx.vertex_array.vertices.values().map(|v| v.origin).collect())
}

fn setup_local_mesh(portal: &DatDatabase, setup_id: u32) -> Option<Vec<Vector3>> {
    let bytes = portal.get_file(setup_id).ok()?;
    let mut cursor = Cursor::new(&bytes);
    let setup = SetupModel::read(&mut cursor).ok()?;
    if setup.parts.is_empty() {
        return None;
    }
    let mut all = Vec::new();
    for part_id in &setup.parts {
        if let Some(part_verts) = gfx_local_mesh(portal, *part_id) {
            all.extend(part_verts);
        }
    }
    if all.is_empty() { return None; }
    Some(all)
}

fn placement_aabb(
    portal: &DatDatabase,
    mesh_cache: &mut MeshCache,
    obj_id: u32,
    frame: &holtburger_dat::landblock::Frame,
) -> Option<Aabb2D> {
    let verts = mesh_cache.lookup(portal, obj_id)?;
    let q = frame.orientation;
    let yaw = 2.0 * q.z.atan2(q.w);
    Some(transform_mesh_to_aabb(verts, frame.origin.x, frame.origin.y, frame.origin.z, yaw, 1.0))
}

// Matches ACE Scenery.cs:83 / Landblock.cs:438 — collide against
// Info.Buildings only, never Info.Objects. See scenery-bake.rs for the
// full reasoning.
fn collect_building_aabbs(
    portal: &DatDatabase,
    mesh_cache: &mut MeshCache,
    info: &LandblockInfo,
) -> Vec<Aabb2D> {
    let mut out: Vec<Aabb2D> = Vec::new();
    for b in &info.buildings {
        if let Some(a) = placement_aabb(portal, mesh_cache, b.model_id, &b.frame) {
            out.push(a);
        }
    }
    out
}

struct SceneCache {
    inner: HashMap<u32, Option<Scene>>,
}

impl SceneCache {
    fn new() -> Self { Self { inner: HashMap::new() } }
    fn lookup(&mut self, portal: &DatDatabase, scene_id: u32) -> Option<Scene> {
        if let Some(c) = self.inner.get(&scene_id) { return c.clone(); }
        let r = load_scene(portal, scene_id);
        self.inner.insert(scene_id, r.clone());
        r
    }
}

fn load_scene(portal: &DatDatabase, scene_id: u32) -> Option<Scene> {
    let bytes = portal.get_file(scene_id).ok()?;
    let mut cursor = Cursor::new(&bytes);
    Scene::unpack(&mut cursor).ok()
}

/// Format one placement to a stable line. Mirrors only the
/// position/format-stable PREFIX of the CLI's `write_placement_line`
/// (`obj_id`..`source_obj_idx`); it deliberately does NOT emit the CLI's
/// appended sidecar fields (`default_script_id` V1, `stable_id` V2)
/// because this tool does not resolve the SetupModel `default_script` DID.
/// It is therefore NOT a full byte-for-byte mirror of a CLI bake line — a
/// raw cross-binary diff against the real CLI output will differ on those
/// trailing fields. The determinism self-check is unaffected: it diffs
/// run-1 vs run-2, both produced by THIS formatter, so the prefix is
/// byte-stable run-to-run. (Inline format string — small enough not to
/// extract.)
fn placement_line(p: &ScenicPlacement) -> String {
    fn f(v: f32) -> String {
        let v = if v == 0.0 { 0.0 } else { v };
        format!("{:.6}", v)
    }
    format!(
        "{{\"obj_id\":\"0x{:08X}\",\"x\":{},\"y\":{},\"z\":{},\"qw\":{},\"qx\":{},\"qy\":{},\"qz\":{},\"scale\":{},\"source_cell_x\":{},\"source_cell_y\":{},\"source_obj_idx\":{}}}",
        p.obj_id, f(p.x), f(p.y), f(p.z), f(p.qw), f(p.qx), f(p.qy), f(p.qz), f(p.scale),
        p.source_cell_x, p.source_cell_y, p.source_obj_idx,
    )
}

fn bake_one(
    region: &Region,
    portal: &DatDatabase,
    cell_db: &DatDatabase,
    mesh_cache: &mut MeshCache,
    scene_cache: &mut SceneCache,
    lb_key: u16,
) -> Option<Vec<ScenicPlacement>> {
    let lb_word = (lb_key as u32) << 16;
    let cell_id = lb_word | 0xFFFF;
    let info_id = lb_word | 0xFFFE;
    let bytes = cell_db.get_file(cell_id).ok()?;
    let landblock = CellLandblock::unpack(&bytes).ok()?;
    let building_aabbs: Vec<Aabb2D> = match cell_db.get_file(info_id) {
        Ok(b) => match LandblockInfo::unpack(&b) {
            Ok(info) => collect_building_aabbs(portal, mesh_cache, &info),
            Err(_) => Vec::new(),
        },
        Err(_) => Vec::new(),
    };
    let (sc_ref, mc_ref) = (scene_cache, mesh_cache);
    let fetch_scene = |id: u32| sc_ref.lookup(portal, id);
    let compute_world_aabb = |px: PlacementXform| -> Option<Aabb3D> {
        let verts = mc_ref.lookup(portal, px.obj_id)?;
        Some(transform_mesh_to_aabb3(
            verts, px.lx, px.ly, px.lz, px.rotation_rad, px.scale,
        ))
    };
    Some(bake_landblock(
        region,
        &landblock,
        lb_word,
        fetch_scene,
        compute_world_aabb,
        &building_aabbs,
        BakeMode::AceCompat,
    ))
}

fn bake_ring_to_lines(
    region: &Region,
    portal: &DatDatabase,
    cell_db: &DatDatabase,
    lbs: &[u16],
) -> Vec<(u16, Vec<String>)> {
    let mut mesh_cache = MeshCache::new();
    let mut scene_cache = SceneCache::new();
    let mut out = Vec::with_capacity(lbs.len());
    for &lb in lbs {
        let lines = match bake_one(region, portal, cell_db, &mut mesh_cache, &mut scene_cache, lb) {
            Some(v) => v.iter().map(placement_line).collect(),
            None => Vec::new(),
        };
        out.push((lb, lines));
    }
    out
}

fn write_lines(out_dir: &Path, lb: u16, lines: &[String]) -> Result<()> {
    let path = out_dir.join(format!("0x{:04X}.scenery.jsonl", lb));
    let mut body = String::new();
    for l in lines {
        body.push_str(l);
        body.push('\n');
    }
    fs::write(&path, body).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

fn main() -> Result<()> {
    let (portal_path, cell_path) = locate_dats()?;
    eprintln!("scenery-bake-determinism: portal={} cell={}", portal_path.display(), cell_path.display());

    let portal = DatDatabase::new(&portal_path).context("open portal")?;
    let cell_db = DatDatabase::new(&cell_path).context("open cell")?;

    let region_bytes = portal
        .get_file(0x1300_0000)
        .context("fetch Region 0x13000000")?;
    let region = Region::unpack(&mut Cursor::new(&region_bytes)).context("parse Region")?;

    let lbs = holtburg_ring();
    eprintln!("scenery-bake-determinism: baking 13×13 = {} LBs (run 1)", lbs.len());
    let run1 = bake_ring_to_lines(&region, &portal, &cell_db, &lbs);
    eprintln!("scenery-bake-determinism: baking 13×13 = {} LBs (run 2)", lbs.len());
    let run2 = bake_ring_to_lines(&region, &portal, &cell_db, &lbs);

    let scratch = PathBuf::from(
        std::env::var_os("HOLTBURGER_DETERMINISM_OUT").unwrap_or_else(|| {
            "/mnt/wbterminal1/tmp/claude-scratch/scenery-bake/b4/determinism".into()
        }),
    );
    fs::create_dir_all(scratch.join("run1"))?;
    fs::create_dir_all(scratch.join("run2"))?;
    for (lb, lines) in &run1 {
        write_lines(&scratch.join("run1"), *lb, lines)?;
    }
    for (lb, lines) in &run2 {
        write_lines(&scratch.join("run2"), *lb, lines)?;
    }

    // Compare. The two runs are vectors of (lb_key, Vec<line>) over
    // the same lbs list — match by index for stability.
    let mut diff_lbs: Vec<u16> = Vec::new();
    let mut total_placements = 0usize;
    for ((lb1, l1), (lb2, l2)) in run1.iter().zip(run2.iter()) {
        assert_eq!(lb1, lb2, "lb sequence drift");
        total_placements += l1.len();
        if l1 != l2 {
            diff_lbs.push(*lb1);
        }
    }
    eprintln!(
        "scenery-bake-determinism: total placements = {} across {} LBs",
        total_placements,
        run1.len()
    );
    if diff_lbs.is_empty() {
        eprintln!("scenery-bake-determinism: PASS — all 169 LBs byte-identical across 2 runs");
        Ok(())
    } else {
        for lb in &diff_lbs {
            // Find the line-level delta for the first divergent LB
            // for the failure message.
            let (_lb1, a) = run1.iter().find(|(k, _)| k == lb).unwrap();
            let (_lb2, b) = run2.iter().find(|(k, _)| k == lb).unwrap();
            eprintln!("  LB 0x{:04X}: {} vs {} lines", lb, a.len(), b.len());
            for (i, (la, lb_line)) in a.iter().zip(b.iter()).enumerate() {
                if la != lb_line {
                    eprintln!("    line {}: {}", i, la);
                    eprintln!("           : {}", lb_line);
                    break;
                }
            }
        }
        bail!(
            "scenery-bake-determinism: FAIL — {} LBs drifted between runs",
            diff_lbs.len()
        );
    }
}
