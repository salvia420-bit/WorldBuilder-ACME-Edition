//! `scenery-bake` — Phase B.3 integration shell for the scenery bake.
//!
//! Loads retail base DATs, hardens the input path against modder-allocated
//! records, computes per-LB building AABBs, drives
//! [`holtburger_scenery_bake::bake_landblock`] for each requested
//! landblock, and emits one JSONL per LB plus a `bake-source.sha256`
//! sidecar so any consuming server (Coldeve, etc.) can verify hash-match
//! before honouring the bake.
//!
//! See `docs/hypotheticalmethod.md` ("Base DATs only — never custom")
//! for the determinism contract this CLI enforces.
//!
//! Usage:
//!
//! ```text
//! scenery-bake \
//!     --dat-dir /home/wbterminal/projects/RetailSmoke/dats/base \
//!     --landblocks 0xA9B4 \
//!     --out /mnt/wbterminal1/tmp/claude-scratch/scenery-bake/b3/holtburg-only
//! ```
//!
//! `--landblocks` accepts:
//! - a single hex LB id (`0xA9B4`)
//! - an inclusive `<lo>..<hi>` range over the packed 16-bit LB key
//!   walking the full 256-cell-per-axis grid in row-major order
//! - `@<path>` to load one LB id per non-empty line from a list file

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use binrw::io::Cursor;
use clap::Parser;
use holtburger_common::Vector3;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::{GfxObj, Region, Scene, SetupModel};
use holtburger_dat::graphics::Frame;
use holtburger_dat::landblock::{CellLandblock, LandblockInfo};
use holtburger_scenery_bake::{
    Aabb2D, LocalBounds, ScenicPlacement, bake_landblock, transform_local_aabb,
};
use log::{debug, info, warn};
use sha2::{Digest, Sha256};

/// Tool identity string baked into the manifest sidecar. Servers can
/// pattern-match against this for compat-by-version checks.
const SCENERY_BAKE_CLI_VERSION: &str = "scenery-bake-cli/0.1.0";
const SCENERY_BAKE_LIB_VERSION: &str = "holtburger-scenery-bake/0.1.0";

/// CLI surface. Per the determinism contract: NO defaults for
/// `--dat-dir` or `--out`. Callers must spell them out so there's no
/// "oh, that ran against my workspace iter-* by accident" failure mode.
#[derive(Parser, Debug)]
#[command(
    author,
    version,
    about = "Bake AC procedural scenery to explicit per-LB JSONL placement lists (Phase B.3)"
)]
struct Cli {
    /// Directory containing the three retail base DATs:
    /// `client_portal.dat`, `client_cell_1.dat`,
    /// `client_local_English.dat`. MUST be retail-clean — the
    /// pre-flight rejects sibling `custom_textures/` / `iter-*/` /
    /// `*.wbproj` and any modder-allocated record IDs.
    #[arg(long, value_name = "PATH")]
    dat_dir: PathBuf,

    /// Landblock spec. One of:
    /// - hex LB id: `0xA9B4`
    /// - inclusive range: `0xA3AE..0xAFBA` (row-major over 256-cell grid)
    /// - file list: `@<path>` reads one hex id per line
    #[arg(long, value_name = "LB_SPEC")]
    landblocks: String,

    /// Region DID. Defaults to `0x13000000` (Dereth). String-default
    /// because `clap`'s `default_value_t` would round-trip the value
    /// through `Display` (decimal) and re-parse, which would scramble
    /// a hex-style default like `0x13000000`. See `dat-shard`'s
    /// `boot_landblock` arg for the same pattern.
    #[arg(long, value_name = "DID", default_value = "0x13000000")]
    region_did: String,

    /// Output directory. Created if missing. Will contain one
    /// `<lbHex>.scenery.jsonl` per landblock plus a
    /// `bake-source.sha256` sidecar.
    #[arg(long, value_name = "DIR")]
    out: PathBuf,

    /// Per-LB sleep in milliseconds. Default 0 (no throttling).
    /// Useful for sharing CPU on long bakes.
    #[arg(long, default_value_t = 0u64)]
    throttle_ms: u64,

    /// Emit progress logs (INFO level) to stderr. Without this flag
    /// only WARN + ERROR surface.
    #[arg(long)]
    verbose: bool,
}

fn parse_hex_u32(s: &str) -> Result<u32> {
    let s = s.trim();
    let stripped = s.trim_start_matches("0x").trim_start_matches("0X");
    u32::from_str_radix(stripped, 16).with_context(|| format!("parse hex u32 `{s}`"))
}

/// Parse the `--landblocks` argument into a Vec of 16-bit LB keys
/// (packed `(lbX << 8) | lbY`).
fn parse_landblock_spec(spec: &str) -> Result<Vec<u16>> {
    let spec = spec.trim();
    // File list mode.
    if let Some(path) = spec.strip_prefix('@') {
        let body = fs::read_to_string(Path::new(path))
            .with_context(|| format!("read landblock list `{path}`"))?;
        let mut out = Vec::new();
        for (lineno, line) in body.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let v = parse_hex_u32(line)
                .with_context(|| format!("landblock list `{path}` line {}", lineno + 1))?;
            out.push(u16::try_from(v).with_context(|| {
                format!("landblock id `{line}` is wider than 16 bits — expected packed key")
            })?);
        }
        return Ok(out);
    }
    // Range mode.
    if let Some((lo_s, hi_s)) = spec.split_once("..") {
        let lo = parse_hex_u32(lo_s)?;
        let hi = parse_hex_u32(hi_s)?;
        if hi < lo {
            bail!("--landblocks range high `{hi:#X}` is below low `{lo:#X}`");
        }
        let lo_u16 = u16::try_from(lo)
            .with_context(|| format!("range bound `{lo:#X}` is wider than 16 bits"))?;
        let hi_u16 = u16::try_from(hi)
            .with_context(|| format!("range bound `{hi:#X}` is wider than 16 bits"))?;
        // Walk the grid in row-major order, restricting to LBs whose
        // (lbX, lbY) both fall inside the corner rectangle defined by
        // `lo` and `hi`. This matches how WB.Terminal speaks about
        // rectangular LB regions ("0xA3AE..0xAFBA = 13×13 around
        // Holtburg"): the diagonal anchors are unpacked into XY bounds
        // and every cell inside the rectangle is included. A naive
        // numeric `lo..=hi` walk would include 169 LBs for the Holtburg
        // 13×13 anchor pair, but would also drag in spurious LBs
        // outside the rectangle.
        let (xlo, ylo) = ((lo_u16 >> 8) as u32, (lo_u16 & 0xFF) as u32);
        let (xhi, yhi) = ((hi_u16 >> 8) as u32, (hi_u16 & 0xFF) as u32);
        if xhi < xlo || yhi < ylo {
            bail!(
                "--landblocks rectangle: hi=({xhi:#X},{yhi:#X}) must dominate lo=({xlo:#X},{ylo:#X})"
            );
        }
        let mut out = Vec::with_capacity(((xhi - xlo + 1) * (yhi - ylo + 1)) as usize);
        for x in xlo..=xhi {
            for y in ylo..=yhi {
                out.push(((x as u16) << 8) | (y as u16));
            }
        }
        return Ok(out);
    }
    // Single value.
    let v = parse_hex_u32(spec)?;
    let v_u16 = u16::try_from(v)
        .with_context(|| format!("landblock id `{spec}` is wider than 16 bits"))?;
    Ok(vec![v_u16])
}

/// Pre-flight integrity check. Verifies the three base DAT files exist
/// as regular files, that there are no sibling modder-iteration
/// markers (`custom_textures/`, `iter-*/`, `*.wbproj`), and computes
/// SHA-256 hashes over the file CONTENTS (not paths) for the
/// `bake-source.sha256` sidecar.
///
/// Returns `(portal_path, cell_path, local_path, hashes)` where
/// `hashes` is a 3-tuple of hex SHA-256 strings in
/// `(portal, cell, local)` order.
fn preflight_dat_dir(dat_dir: &Path) -> Result<DatDirCheck> {
    if !dat_dir.is_dir() {
        bail!(
            "--dat-dir `{}` is not a directory",
            dat_dir.display()
        );
    }

    let portal = dat_dir.join("client_portal.dat");
    let cell = dat_dir.join("client_cell_1.dat");
    let local = dat_dir.join("client_local_English.dat");

    for (label, p) in [
        ("client_portal.dat", &portal),
        ("client_cell_1.dat", &cell),
        ("client_local_English.dat", &local),
    ] {
        let md = fs::metadata(p)
            .with_context(|| format!("stat {label} at `{}`", p.display()))?;
        if !md.is_file() {
            bail!(
                "--dat-dir: `{}` is not a regular file (got file_type={:?})",
                p.display(),
                md.file_type()
            );
        }
    }

    // Sibling iteration markers — base-DATs-only check.
    let entries = fs::read_dir(dat_dir)
        .with_context(|| format!("read --dat-dir `{}`", dat_dir.display()))?;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name_s = name.to_string_lossy();
        if name_s == "custom_textures" {
            // Only refuse if the dir is non-empty — an empty marker dir
            // shouldn't poison a base-DAT install.
            let mut iter = fs::read_dir(entry.path())?;
            if iter.next().is_some() {
                bail!(
                    "--dat-dir contains non-empty `custom_textures/` — bake refuses to run against custom DATs"
                );
            }
        }
        if name_s.starts_with("iter-") {
            bail!(
                "--dat-dir contains modder-iteration marker `{name_s}` — bake refuses to run against custom DATs"
            );
        }
        if name_s.ends_with(".wbproj") {
            bail!(
                "--dat-dir contains WorldBuilder project file `{name_s}` — bake refuses to run against custom DATs"
            );
        }
    }

    // Open the DATs + scan master directory for modder-allocated IDs.
    let portal_db = DatDatabase::new(&portal)
        .with_context(|| format!("open {}", portal.display()))?;
    let cell_db = DatDatabase::new(&cell)
        .with_context(|| format!("open {}", cell.display()))?;
    let local_db = DatDatabase::new(&local)
        .with_context(|| format!("open {}", local.display()))?;

    for (label, db) in [
        ("portal.dat", &portal_db),
        ("cell.dat", &cell_db),
        ("local.dat", &local_db),
    ] {
        if let Some(bad) = first_modder_allocated_id(db) {
            bail!(
                "--dat-dir contains modder-allocated record 0x{bad:08X} in {label} — bake refuses to run against custom DATs"
            );
        }
    }

    // Hash file CONTENTS so re-locating the dat-dir doesn't invalidate.
    let portal_hash = sha256_file(&portal)?;
    let cell_hash = sha256_file(&cell)?;
    let local_hash = sha256_file(&local)?;

    Ok(DatDirCheck {
        portal_db,
        cell_db,
        portal_hash,
        cell_hash,
        local_hash,
    })
}

/// Result of [`preflight_dat_dir`]. Holds the opened DAT handles ready
/// for the bake to consume + the three content-hashes for the manifest.
struct DatDirCheck {
    portal_db: DatDatabase,
    cell_db: DatDatabase,
    portal_hash: String,
    cell_hash: String,
    local_hash: String,
}

/// Scan a DAT's master directory for any file_id in the modder-allocated
/// range: `0xTTFFxxxx` where `TT` is a valid retail content prefix
/// (`0x01`..=`0x78`). Returns the first such id, if any.
///
/// AC file IDs are packed as `0xTTSSnnnn`: TT = content-type prefix
/// (`0x01` GfxObj, `0x02` SetupModel, ...), SS = subtype/category byte,
/// nnnn = serial. Retail allocates assets with SS in `0x00..=0xFE`;
/// SS = `0xFF` is reserved for modder-allocated records (WorldBuilder
/// iterations, Decal overlays, etc.). The two top-byte ranges that
/// legitimately use SS = `0xFF` in retail are:
///
/// - `0xFFFFxxxx` — DAT system records (iteration counter, master
///   map ids). Top byte `0xFF` itself is the "system" prefix, not a
///   content type; modder asset prefixes never start with `0xFF`.
/// - Cell DAT region records `0xXXYYFFFE`/`0xXXYYFFFF` — these have
///   TT in the landblock-key space, not in the content-prefix space.
///   They live in cell.dat, where this check is also applied; we'd
///   only flag them if the top byte happened to be `0x01`..=`0x78`,
///   but landblock keys are unconstrained 16-bit values, so the
///   prefix-validity guard handles them.
///
/// So the filter is: top byte `0x01..=0x78` AND second byte `0xFF`.
fn first_modder_allocated_id(db: &DatDatabase) -> Option<u32> {
    let mut hits: Vec<u32> = db
        .files
        .keys()
        .copied()
        .filter(|&id| {
            let top = (id >> 24) & 0xFF;
            let second = (id >> 16) & 0xFF;
            (0x01..=0x78).contains(&(top as u8)) && second == 0xFF
        })
        .collect();
    if hits.is_empty() {
        return None;
    }
    // Sort to get a deterministic "first" — the HashMap iteration
    // order is unstable, but error messages must be stable for tests.
    hits.sort();
    Some(hits[0])
}

/// Stream-hash a file's contents via SHA-256. Returns hex.
fn sha256_file(path: &Path) -> Result<String> {
    let mut hasher = Sha256::new();
    let mut f = File::open(path).with_context(|| format!("open for hash {}", path.display()))?;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Mesh-local AABB cache. Memoised per `obj_id` (whether
/// `0x01xxxxxx` GfxObj or `0x02xxxxxx` SetupModel). The bake's
/// `fetch_obj_bounds` closure also asks for these — by going through
/// this cache we de-duplicate the work between scenery (the closure)
/// and buildings (this binary's AABB precompute).
struct BoundsCache {
    inner: HashMap<u32, Option<LocalBounds>>,
}

impl BoundsCache {
    fn new() -> Self {
        Self {
            inner: HashMap::new(),
        }
    }

    /// Resolve a placement obj_id (GfxObj or SetupModel) to its
    /// mesh-local AABB. Returns `None` if the record can't be loaded
    /// or has no geometry — caller treats that as "skip placement".
    fn lookup(&mut self, portal: &DatDatabase, obj_id: u32) -> Option<LocalBounds> {
        if let Some(cached) = self.inner.get(&obj_id) {
            return *cached;
        }
        let result = compute_local_bounds(portal, obj_id);
        self.inner.insert(obj_id, result);
        result
    }
}

/// Compute the mesh-local AABB for a placement `obj_id`. Dispatches
/// on the top byte: `0x01` → GfxObj (read vertex_array), `0x02` →
/// SetupModel (walk each part's GfxObj and transform by the per-part
/// `Frame` from `placement_frames[0]`, if present; else identity).
fn compute_local_bounds(portal: &DatDatabase, obj_id: u32) -> Option<LocalBounds> {
    let top = (obj_id >> 24) & 0xFF;
    match top {
        0x01 => gfx_local_bounds(portal, obj_id),
        0x02 => setup_local_bounds(portal, obj_id),
        _ => None,
    }
}

/// Compute the mesh-local AABB for a raw GfxObj by min/max of its
/// vertex.origin values.
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

/// Compute the mesh-local AABB for a SetupModel: union of each
/// part's GfxObj AABB, transformed by the part's placement frame.
/// SetupModels publish per-part frames via `placement_frames[key]`
/// where each `PlacementType` carries one `Frame` per part. Retail
/// SetupModels include `key=0` as the canonical "default" placement
/// (mirrors the ACE-Server `SetupModel.Setup_VTABLE_BASE`); we use
/// that and fall back to the lowest available key if absent — both
/// are deterministic given the DAT, which is what we need.
fn setup_local_bounds(portal: &DatDatabase, setup_id: u32) -> Option<LocalBounds> {
    let bytes = portal.get_file(setup_id).ok()?;
    let mut cursor = Cursor::new(&bytes);
    let setup = SetupModel::read(&mut cursor).ok()?;
    if setup.parts.is_empty() {
        return None;
    }
    // Pick the default placement (key=0), falling back to the
    // lowest-keyed placement if the model doesn't expose 0. Both
    // paths are deterministic.
    let placement = setup
        .placement_frames
        .get(&0)
        .or_else(|| {
            setup
                .placement_frames
                .iter()
                .min_by_key(|(k, _)| **k)
                .map(|(_, v)| v)
        });

    let mut min = Vector3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY);
    let mut max = Vector3::new(f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
    let mut any = false;

    for (idx, part_id) in setup.parts.iter().enumerate() {
        let Some(part_bounds) = gfx_local_bounds(portal, *part_id) else {
            continue;
        };
        // Per-part frame, if available. Default to identity if the
        // placement table is missing entries for this part index (rare
        // but mirrors ACE — if no placement record exists, parts sit
        // at the SetupModel origin).
        let part_frame: Frame = placement
            .and_then(|p| p.anim_frame.frames.get(idx).cloned())
            .unwrap_or_default();
        for (px, py, pz) in corners_of(&part_bounds) {
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

/// Enumerate the 8 corners of a mesh-local AABB. Used when reducing
/// SetupModel parts under a transform.
fn corners_of(b: &LocalBounds) -> [(f32, f32, f32); 8] {
    [
        (b.min.x, b.min.y, b.min.z),
        (b.max.x, b.min.y, b.min.z),
        (b.min.x, b.max.y, b.min.z),
        (b.max.x, b.max.y, b.min.z),
        (b.min.x, b.min.y, b.max.z),
        (b.max.x, b.min.y, b.max.z),
        (b.min.x, b.max.y, b.max.z),
        (b.max.x, b.max.y, b.max.z),
    ]
}

/// Compute the world-frame XY AABB for one LandblockInfo placement
/// (building or static object). Looks up the placement's mesh-local
/// AABB via `bounds_cache`, transforms by the placement frame +
/// rotation about Z via `transform_local_aabb`. Returns `None` if the
/// mesh's bounds can't be resolved.
fn placement_aabb(
    portal: &DatDatabase,
    bounds_cache: &mut BoundsCache,
    obj_id: u32,
    frame: &holtburger_dat::landblock::Frame,
) -> Option<Aabb2D> {
    let local = bounds_cache.lookup(portal, obj_id)?;
    // Extract yaw about Z from the placement quaternion. `to_heading`
    // returns AC heading convention (0=W, 90=N). We need the
    // mathematical rotation angle the corners get rotated by — i.e.
    // `2 * atan2(qz, qw)` for a yaw-only quat. Most retail
    // LandblockInfo frames ARE yaw-only-about-Z, so this is exact.
    // For non-yaw-only frames the result is conservative-but-not-tight,
    // matching ACE's `BoundingBox` 4-corner reduction in
    // `Scenery.Collision`.
    let q = frame.orientation;
    let yaw = 2.0 * q.z.atan2(q.w);
    // No per-placement scale exposed on LandblockInfo stabs;
    // buildings/objects ship at native scale. Scale=1 here.
    Some(transform_local_aabb(
        local,
        frame.origin.x,
        frame.origin.y,
        yaw,
        1.0,
    ))
}

/// Build the world-frame AABB list for all buildings + static
/// objects on a landblock. Walks `info.objects` (Stab entries — these
/// are static props like signs, well-heads, sometimes mature trees
/// that retail decided to hand-place) plus `info.buildings`
/// (BuildInfo entries — town houses, shops, the meeting hall).
///
/// The `is_building` flag the brief mentions doesn't actually exist on
/// `Stab` — `LandblockInfo` already separates the two: `objects` is a
/// `Vec<Stab>` of hand-placed statics and `buildings` is a
/// `Vec<BuildInfo>` of building entries. Both are treated as
/// collision-blockers for scenery placement.
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

/// Resolved-Region cache for `fetch_scene` closure. Pre-parses each
/// Scene the bake asks for, then memoises so repeat asks for the same
/// scene-id reuse one parse. Mirrors the `BoundsCache` pattern.
struct SceneCache {
    inner: HashMap<u32, Option<Scene>>,
}

impl SceneCache {
    fn new() -> Self {
        Self {
            inner: HashMap::new(),
        }
    }

    fn lookup(&mut self, portal: &DatDatabase, scene_id: u32) -> Option<Scene> {
        if let Some(cached) = self.inner.get(&scene_id) {
            return cached.clone();
        }
        let result = load_scene(portal, scene_id);
        self.inner.insert(scene_id, result.clone());
        result
    }
}

fn load_scene(portal: &DatDatabase, scene_id: u32) -> Option<Scene> {
    let bytes = portal.get_file(scene_id).ok()?;
    let mut cursor = Cursor::new(&bytes);
    Scene::unpack(&mut cursor).ok()
}

/// Serialize one `ScenicPlacement` line in the JSONL format documented
/// by `hypotheticalmethod.md`. All floats are formatted via
/// `format_f32_six_sig`, which uses `{:.6}` (six digits after the
/// decimal point — enough for cm-precision on AC's 0..192 m scale
/// while staying short enough for diffs to read).
fn write_placement_line<W: Write>(mut w: W, p: &ScenicPlacement) -> Result<()> {
    writeln!(
        w,
        "{{\"obj_id\":\"0x{:08X}\",\"x\":{},\"y\":{},\"z\":{},\"qw\":{},\"qx\":{},\"qy\":{},\"qz\":{},\"scale\":{},\"source_cell_x\":{},\"source_cell_y\":{},\"source_obj_idx\":{}}}",
        p.obj_id,
        format_f32_six_sig(p.x),
        format_f32_six_sig(p.y),
        format_f32_six_sig(p.z),
        format_f32_six_sig(p.qw),
        format_f32_six_sig(p.qx),
        format_f32_six_sig(p.qy),
        format_f32_six_sig(p.qz),
        format_f32_six_sig(p.scale),
        p.source_cell_x,
        p.source_cell_y,
        p.source_obj_idx,
    )?;
    Ok(())
}

/// Format an f32 with six digits after the decimal point. Determinism
/// matters: same value in, same string out. `{:.6}` is locale-free in
/// Rust (always uses `.` and decimal) so this is byte-stable across
/// machines.
fn format_f32_six_sig(v: f32) -> String {
    // Normalise -0.0 → 0.0 so determinism across builds doesn't flip
    // on a signed-zero (e.g. NEG_INFINITY corner cases collapsing
    // through floor()). f32 IEEE-754 has two zero encodings; output
    // them identically.
    let v = if v == 0.0 { 0.0 } else { v };
    format!("{:.6}", v)
}

/// Bake one landblock and serialize the placements. Returns the
/// placement count (for distribution reporting). Returns `None` if the
/// LB's CellLandblock record isn't present in cell.dat (skipped, with
/// a warn log).
fn bake_one(
    region: &Region,
    portal: &DatDatabase,
    cell_db: &DatDatabase,
    bounds_cache: &mut BoundsCache,
    scene_cache: &mut SceneCache,
    lb_key: u16,
    out_dir: &Path,
) -> Result<Option<usize>> {
    let lb_word = (lb_key as u32) << 16;
    let cell_id = lb_word | 0xFFFF;
    let info_id = lb_word | 0xFFFE;

    let Ok(cell_bytes) = cell_db.get_file(cell_id) else {
        warn!("LB 0x{lb_key:04X}: CellLandblock {cell_id:#010X} not in cell.dat — skipping");
        return Ok(None);
    };
    let cell_landblock = CellLandblock::unpack(&cell_bytes)
        .with_context(|| format!("parse CellLandblock 0x{cell_id:08X}"))?;

    // LandblockInfo is optional — many LBs (open countryside) have no
    // buildings. Absent record = zero building AABBs.
    let building_aabbs: Vec<Aabb2D> = match cell_db.get_file(info_id) {
        Ok(info_bytes) => match LandblockInfo::unpack(&info_bytes) {
            Ok(info) => collect_building_aabbs(portal, bounds_cache, &info),
            Err(e) => {
                warn!("LB 0x{lb_key:04X}: LandblockInfo {info_id:#010X} parse failed: {e}");
                Vec::new()
            }
        },
        Err(_) => Vec::new(),
    };

    let landblock_id = lb_word;
    // Bake calls back through our closures + caches. Splitting the
    // two caches lets us hold portal + cell DBs read-only inside both.
    let placements = {
        // We need to wrap portal in the closures separately — Rust
        // can't share `&DatDatabase` to two `FnMut` closures via the
        // same outer `&mut`. So both closures hold their own `&DatDatabase`
        // and own a `&mut` to their respective cache.
        let (scene_cache_ref, bounds_cache_ref) = (scene_cache, bounds_cache);
        let fetch_scene = |scene_id: u32| scene_cache_ref.lookup(portal, scene_id);
        let fetch_obj_bounds = |obj_id: u32| bounds_cache_ref.lookup(portal, obj_id);

        bake_landblock(
            region,
            &cell_landblock,
            landblock_id,
            fetch_scene,
            fetch_obj_bounds,
            &building_aabbs,
        )
    };

    // Emit JSONL — one line per placement. Empty file (0 placements)
    // is still emitted so consumers can pattern-match on file presence.
    let out_path = out_dir.join(format!("0x{lb_key:04X}.scenery.jsonl"));
    let f = File::create(&out_path)
        .with_context(|| format!("create {}", out_path.display()))?;
    let mut w = BufWriter::new(f);
    for p in &placements {
        write_placement_line(&mut w, p)?;
    }
    w.flush()?;

    debug!(
        "LB 0x{lb_key:04X}: {} placements ({} buildings collide-blocking) → {}",
        placements.len(),
        building_aabbs.len(),
        out_path.display()
    );

    Ok(Some(placements.len()))
}

/// Compute distribution summary {min, p50 (median), max, total,
/// nonzero_count}. Lets the caller log a single human-readable line
/// for the full run.
fn distribution_summary(counts: &[usize]) -> Option<(usize, usize, usize, usize, usize)> {
    if counts.is_empty() {
        return None;
    }
    let mut s = counts.to_vec();
    s.sort_unstable();
    let min = *s.first().unwrap();
    let max = *s.last().unwrap();
    let median = s[s.len() / 2];
    let total: usize = s.iter().sum();
    let nonzero = s.iter().filter(|&&c| c > 0).count();
    Some((min, median, max, total, nonzero))
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    let mut log_builder = env_logger::Builder::from_default_env();
    if cli.verbose {
        log_builder.filter_level(log::LevelFilter::Info);
    } else {
        log_builder.filter_level(log::LevelFilter::Warn);
    }
    log_builder.init();

    let region_did = parse_hex_u32(&cli.region_did)?;
    let landblocks = parse_landblock_spec(&cli.landblocks)?;

    info!(
        "scenery-bake: --dat-dir={} --landblocks={} ({} LBs) --region-did=0x{:08X} --out={}",
        cli.dat_dir.display(),
        cli.landblocks,
        landblocks.len(),
        region_did,
        cli.out.display()
    );

    fs::create_dir_all(&cli.out)
        .with_context(|| format!("create --out `{}`", cli.out.display()))?;

    let check = preflight_dat_dir(&cli.dat_dir)?;
    info!(
        "pre-flight ok: portal_hash={} cell_hash={} local_hash={}",
        &check.portal_hash[..16],
        &check.cell_hash[..16],
        &check.local_hash[..16],
    );

    // Parse the Region once. Default region is Dereth 0x13000000.
    let region_bytes = check
        .portal_db
        .get_file(region_did)
        .with_context(|| format!("fetch Region {region_did:#010X} from portal.dat"))?;
    let region = {
        let mut cursor = Cursor::new(&region_bytes);
        Region::unpack(&mut cursor)
            .with_context(|| format!("parse Region {region_did:#010X}"))?
    };

    let mut bounds_cache = BoundsCache::new();
    let mut scene_cache = SceneCache::new();
    let mut counts: Vec<usize> = Vec::with_capacity(landblocks.len());
    let mut skipped: usize = 0;

    for (i, &lb_key) in landblocks.iter().enumerate() {
        match bake_one(
            &region,
            &check.portal_db,
            &check.cell_db,
            &mut bounds_cache,
            &mut scene_cache,
            lb_key,
            &cli.out,
        )? {
            Some(n) => counts.push(n),
            None => skipped += 1,
        }
        if cli.throttle_ms > 0 {
            std::thread::sleep(Duration::from_millis(cli.throttle_ms));
        }
        // Progress every 25 LBs on the wider rings.
        if cli.verbose && (i + 1) % 25 == 0 {
            info!(
                "progress: {}/{} LBs baked ({} skipped so far)",
                i + 1,
                landblocks.len(),
                skipped
            );
        }
    }

    // Manifest sidecar.
    let manifest_path = cli.out.join("bake-source.sha256");
    let manifest = format_manifest(
        &check.portal_hash,
        &check.cell_hash,
        &check.local_hash,
        region_did,
        counts.len(),
        skipped,
    );
    fs::write(&manifest_path, manifest)
        .with_context(|| format!("write {}", manifest_path.display()))?;

    if let Some((min, p50, max, total, nonzero)) = distribution_summary(&counts) {
        eprintln!(
            "scenery-bake done: {} LBs baked, {} skipped, placements min/p50/max={}/{}/{} total={} nonzero_lbs={}",
            counts.len(),
            skipped,
            min,
            p50,
            max,
            total,
            nonzero
        );
    } else {
        eprintln!("scenery-bake done: 0 LBs baked, {skipped} skipped");
    }

    Ok(())
}

/// Render the `bake-source.sha256` body. Fixed-field layout so any
/// consuming server (Coldeve, retail emu, etc.) can parse it
/// line-by-line with a single split-on-whitespace pass.
fn format_manifest(
    portal_hash: &str,
    cell_hash: &str,
    local_hash: &str,
    region_did: u32,
    baked: usize,
    skipped: usize,
) -> String {
    format!(
        "client_portal.dat\t{}\nclient_cell_1.dat\t{}\nclient_local_English.dat\t{}\nbake-tool-version\t{} + {}\nregion-did\t0x{:08X}\nlandblocks\t{} baked, {} skipped\n",
        portal_hash,
        cell_hash,
        local_hash,
        SCENERY_BAKE_LIB_VERSION,
        SCENERY_BAKE_CLI_VERSION,
        region_did,
        baked,
        skipped,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_hex_u32_accepts_prefixed_and_bare() {
        assert_eq!(parse_hex_u32("0xA9B4").unwrap(), 0xA9B4);
        assert_eq!(parse_hex_u32("a9b4").unwrap(), 0xA9B4);
        assert_eq!(parse_hex_u32("0X13000000").unwrap(), 0x13000000);
    }

    #[test]
    fn parse_hex_u32_rejects_decimal() {
        assert!(parse_hex_u32("12345").is_ok()); // hex-12345
        assert!(parse_hex_u32("0xGG").is_err());
    }

    #[test]
    fn parse_landblock_spec_single() {
        let v = parse_landblock_spec("0xA9B4").unwrap();
        assert_eq!(v, vec![0xA9B4]);
    }

    #[test]
    fn parse_landblock_spec_holtburg_13x13() {
        // 0xA3AE..0xAFBA — the smoke 13×13 ring around Holtburg.
        // (xlo=0xA3, ylo=0xAE) ... (xhi=0xAF, yhi=0xBA)
        // width = 0xAF - 0xA3 + 1 = 13, height = 0xBA - 0xAE + 1 = 13.
        let v = parse_landblock_spec("0xA3AE..0xAFBA").unwrap();
        assert_eq!(v.len(), 13 * 13);
        // First entry: top-left corner (xlo, ylo).
        assert_eq!(v[0], 0xA3AE);
        // Last entry: bottom-right corner (xhi, yhi).
        assert_eq!(*v.last().unwrap(), 0xAFBA);
        // Holtburg LB 0xA9B4 is inside the rectangle.
        assert!(v.contains(&0xA9B4));
    }

    #[test]
    fn parse_landblock_spec_range_rejects_inverted() {
        // Y of hi < y of lo → empty rectangle, should error.
        assert!(parse_landblock_spec("0xA3BA..0xAFAE").is_err());
    }

    #[test]
    fn format_f32_six_sig_normalises_negative_zero() {
        assert_eq!(format_f32_six_sig(-0.0), "0.000000");
        assert_eq!(format_f32_six_sig(0.0), "0.000000");
        assert_eq!(format_f32_six_sig(1.234567), "1.234567");
    }

    #[test]
    fn format_manifest_contains_all_fields() {
        let m = format_manifest(
            &"a".repeat(64),
            &"b".repeat(64),
            &"c".repeat(64),
            0x13000000,
            169,
            0,
        );
        assert!(m.contains("client_portal.dat\t"));
        assert!(m.contains("client_cell_1.dat\t"));
        assert!(m.contains("client_local_English.dat\t"));
        assert!(m.contains("region-did\t0x13000000"));
        assert!(m.contains("169 baked, 0 skipped"));
        assert!(m.contains(SCENERY_BAKE_LIB_VERSION));
        assert!(m.contains(SCENERY_BAKE_CLI_VERSION));
        // Six-line format.
        assert_eq!(m.lines().count(), 6);
    }

    #[test]
    fn modder_allocated_filter_rejects_modder_range() {
        // Top byte in content-prefix range AND second byte == 0xFF.
        let bad_ids = [0x01FF_0001, 0x02FF_1234, 0x12FF_ABCD, 0x78FF_FFFE];
        for id in bad_ids {
            let top = (id >> 24) & 0xFF;
            let second = (id >> 16) & 0xFF;
            assert!(
                (0x01u8..=0x78).contains(&(top as u8)) && second == 0xFF,
                "0x{id:08X} should be flagged as modder-allocated"
            );
        }
    }

    #[test]
    fn modder_allocated_filter_passes_retail_system_records() {
        // Retail DAT system records use top byte 0xFF — NOT in the
        // content-prefix range, so they must pass.
        let ok_ids = [
            0xFFFF_0001u32, // DAT iteration record
            0xFFFF_0002,
            0xA9B4_FFFF, // CellLandblock id (top byte 0xA9 is not in 0x01..=0x78... actually 0xA9 > 0x78)
            0xA9B4_FFFE, // LandblockInfo id
        ];
        for id in ok_ids {
            let top = (id >> 24) & 0xFF;
            let second = (id >> 16) & 0xFF;
            let modder = (0x01u8..=0x78).contains(&(top as u8)) && second == 0xFF;
            assert!(!modder, "0x{id:08X} should NOT be flagged as modder");
        }
    }

    #[test]
    fn modder_allocated_filter_passes_retail_content() {
        // Top byte in content-prefix range but second byte != 0xFF — retail content.
        let ok_ids = [
            0x0100_07ABu32, // a GfxObj
            0x0200_0123,    // a SetupModel
            0x1200_ABCD,    // a Scene
            0x1300_0000,    // Dereth region
        ];
        for id in ok_ids {
            let top = (id >> 24) & 0xFF;
            let second = (id >> 16) & 0xFF;
            let modder = (0x01u8..=0x78).contains(&(top as u8)) && second == 0xFF;
            assert!(!modder, "0x{id:08X} should NOT be flagged as modder");
        }
    }

    #[test]
    fn distribution_summary_empty_is_none() {
        assert_eq!(distribution_summary(&[]), None);
    }

    #[test]
    fn distribution_summary_single_value() {
        assert_eq!(distribution_summary(&[5]), Some((5, 5, 5, 5, 1)));
    }

    #[test]
    fn distribution_summary_basic() {
        let counts = vec![0, 0, 3, 5, 7, 10, 20];
        let (min, p50, max, total, nonzero) = distribution_summary(&counts).unwrap();
        assert_eq!(min, 0);
        // counts.len()/2 = 3 → s[3] = 5 (after sort).
        assert_eq!(p50, 5);
        assert_eq!(max, 20);
        assert_eq!(total, 45);
        assert_eq!(nonzero, 5);
    }

    #[test]
    fn write_placement_line_format_is_jsonl_one_line() {
        let p = ScenicPlacement {
            obj_id: 0x02000123,
            x: 12.34,
            y: 56.78,
            z: 9.01,
            qw: 1.0,
            qx: 0.0,
            qy: 0.0,
            qz: 0.0,
            scale: 1.0,
            source_cell_x: 3,
            source_cell_y: 5,
            source_obj_idx: 2,
        };
        let mut buf = Vec::new();
        write_placement_line(&mut buf, &p).unwrap();
        let s = String::from_utf8(buf).unwrap();
        // One line.
        assert_eq!(s.matches('\n').count(), 1);
        // Hex obj_id.
        assert!(s.starts_with("{\"obj_id\":\"0x02000123\""));
        // Six digits after decimal.
        assert!(s.contains("\"x\":12.340000"));
    }
}
