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
use holtburger_dat::graphics::Frame;
use holtburger_dat::landblock::{CellLandblock, LandblockInfo};
use holtburger_scenery_bake::{
    Aabb2D, BakeMode, LocalBounds, ScenicPlacement, bake_landblock, transform_local_aabb,
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

/// Hand-coded mesh-local AABB lookup for the bake's `fetch_obj_bounds`
/// closure. Mirrors `scenery-bake.rs::BoundsCache`.
struct BoundsCache {
    inner: HashMap<u32, Option<LocalBounds>>,
}

impl BoundsCache {
    fn new() -> Self {
        Self { inner: HashMap::new() }
    }
    fn lookup(&mut self, portal: &DatDatabase, obj_id: u32) -> Option<LocalBounds> {
        if let Some(c) = self.inner.get(&obj_id) {
            return *c;
        }
        let r = compute_local_bounds(portal, obj_id);
        self.inner.insert(obj_id, r);
        r
    }
}

fn compute_local_bounds(portal: &DatDatabase, obj_id: u32) -> Option<LocalBounds> {
    let top = (obj_id >> 24) & 0xFF;
    match top {
        0x01 => gfx_local_bounds(portal, obj_id),
        0x02 => setup_local_bounds(portal, obj_id),
        _ => None,
    }
}

fn gfx_local_bounds(portal: &DatDatabase, gfx_id: u32) -> Option<LocalBounds> {
    let bytes = portal.get_file(gfx_id).ok()?;
    let mut cursor = Cursor::new(&bytes);
    let gfx = GfxObj::unpack(&mut cursor).ok()?;
    if gfx.vertex_array.vertices.is_empty() {
        return None;
    }
    let mut min = Vector3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY);
    let mut max = Vector3::new(f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
    for v in gfx.vertex_array.vertices.values() {
        let p = v.origin;
        if p.x < min.x { min.x = p.x; }
        if p.y < min.y { min.y = p.y; }
        if p.z < min.z { min.z = p.z; }
        if p.x > max.x { max.x = p.x; }
        if p.y > max.y { max.y = p.y; }
        if p.z > max.z { max.z = p.z; }
    }
    if !min.x.is_finite() || !max.x.is_finite() {
        return None;
    }
    Some(LocalBounds::new(min, max))
}

fn setup_local_bounds(portal: &DatDatabase, setup_id: u32) -> Option<LocalBounds> {
    let bytes = portal.get_file(setup_id).ok()?;
    let mut cursor = Cursor::new(&bytes);
    let setup = SetupModel::read(&mut cursor).ok()?;
    if setup.parts.is_empty() {
        return None;
    }
    let placement = setup
        .placement_frames
        .get(&0)
        .or_else(|| setup.placement_frames.iter().min_by_key(|(k, _)| **k).map(|(_, v)| v));

    let mut min = Vector3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY);
    let mut max = Vector3::new(f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
    let mut any = false;

    for (idx, part_id) in setup.parts.iter().enumerate() {
        let Some(part_bounds) = gfx_local_bounds(portal, *part_id) else { continue; };
        let part_frame: Frame = placement
            .and_then(|p| p.anim_frame.frames.get(idx).cloned())
            .unwrap_or_default();
        for &(px, py, pz) in &[
            (part_bounds.min.x, part_bounds.min.y, part_bounds.min.z),
            (part_bounds.max.x, part_bounds.min.y, part_bounds.min.z),
            (part_bounds.min.x, part_bounds.max.y, part_bounds.min.z),
            (part_bounds.max.x, part_bounds.max.y, part_bounds.min.z),
            (part_bounds.min.x, part_bounds.min.y, part_bounds.max.z),
            (part_bounds.max.x, part_bounds.min.y, part_bounds.max.z),
            (part_bounds.min.x, part_bounds.max.y, part_bounds.max.z),
            (part_bounds.max.x, part_bounds.max.y, part_bounds.max.z),
        ] {
            let local = Vector3::new(px, py, pz);
            let rotated = part_frame.orientation.rotate_vector(local);
            let w = Vector3::new(
                rotated.x + part_frame.origin.x,
                rotated.y + part_frame.origin.y,
                rotated.z + part_frame.origin.z,
            );
            if w.x < min.x { min.x = w.x; }
            if w.y < min.y { min.y = w.y; }
            if w.z < min.z { min.z = w.z; }
            if w.x > max.x { max.x = w.x; }
            if w.y > max.y { max.y = w.y; }
            if w.z > max.z { max.z = w.z; }
            any = true;
        }
    }
    if !any {
        return None;
    }
    Some(LocalBounds::new(min, max))
}

fn placement_aabb(
    portal: &DatDatabase,
    bounds_cache: &mut BoundsCache,
    obj_id: u32,
    frame: &holtburger_dat::landblock::Frame,
) -> Option<Aabb2D> {
    let local = bounds_cache.lookup(portal, obj_id)?;
    let q = frame.orientation;
    let yaw = 2.0 * q.z.atan2(q.w);
    Some(transform_local_aabb(local, frame.origin.x, frame.origin.y, yaw, 1.0))
}

fn collect_building_aabbs(
    portal: &DatDatabase,
    bounds_cache: &mut BoundsCache,
    info: &LandblockInfo,
) -> Vec<Aabb2D> {
    let mut out: Vec<Aabb2D> = Vec::new();
    for stab in &info.objects {
        if let Some(a) = placement_aabb(portal, bounds_cache, stab.id, &stab.frame) {
            out.push(a);
        }
    }
    for b in &info.buildings {
        if let Some(a) = placement_aabb(portal, bounds_cache, b.model_id, &b.frame) {
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

/// Format one placement to a stable line. Matches the CLI's
/// `write_placement_line` byte-for-byte so cross-binary diffs are
/// possible. (Inline format string — small enough not to extract.)
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
    bounds_cache: &mut BoundsCache,
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
            Ok(info) => collect_building_aabbs(portal, bounds_cache, &info),
            Err(_) => Vec::new(),
        },
        Err(_) => Vec::new(),
    };
    let (sc_ref, bc_ref) = (scene_cache, bounds_cache);
    let fetch_scene = |id: u32| sc_ref.lookup(portal, id);
    let fetch_obj_bounds = |id: u32| bc_ref.lookup(portal, id);
    Some(bake_landblock(
        region,
        &landblock,
        lb_word,
        fetch_scene,
        fetch_obj_bounds,
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
    let mut bounds_cache = BoundsCache::new();
    let mut scene_cache = SceneCache::new();
    let mut out = Vec::with_capacity(lbs.len());
    for &lb in lbs {
        let lines = match bake_one(region, portal, cell_db, &mut bounds_cache, &mut scene_cache, lb) {
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
