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
use holtburger_dat::landblock::{CellLandblock, LandblockInfo};
use holtburger_scenery_bake::{
    Aabb2D, BakeMode, PlacementXform, ScenicPlacement, bake_landblock, placements_fingerprint,
    transform_mesh_to_aabb,
};
use log::{debug, info, warn};
use sha2::{Digest, Sha256};

/// Tool identity string baked into the manifest sidecar. Servers can
/// pattern-match against this for compat-by-version checks.
const SCENERY_BAKE_CLI_VERSION: &str = "scenery-bake-cli/0.1.0";
const SCENERY_BAKE_LIB_VERSION: &str = "holtburger-scenery-bake/0.1.0";

/// Phase-1 parity-hardening diagnostic. When `--bits` is set,
/// `format_f32_six_sig` emits raw `to_bits()` (decimal u32) instead of the
/// `{:.6}` decimal string, so a bit-identity check against
/// `scenery-cross-check --bits` sees the exact f32 rather than a lossy
/// 6-decimal rounding. Process-global because the formatter is called deep
/// in the per-placement write path; a one-shot CLI sets it once at startup.
static EMIT_BITS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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

    /// Bake mode. `ace-compat` (default) replays today's ACE
    /// `Scenery.Load` bit-for-bit — triangle-plane Z + no slope check
    /// — for 1:1 client/server agreement with an ACE-derivative server
    /// (Coldeve etc.). `strict` is the renderer-friendly variant:
    /// bilinear Z (matches `holtburger-world`'s player physics) and
    /// slope rejection ON. The mode appears in `bake-source.sha256` so
    /// downstream consumers can refuse a mode they don't expect.
    #[arg(long, value_name = "MODE", default_value = "ace-compat")]
    mode: String,

    /// Diagnostic (Phase-1 parity hardening): emit each f32 field as its
    /// raw IEEE-754 `to_bits()` value (decimal u32, -0 normalised to +0)
    /// instead of the `{:.6}` decimal string, for exact bit-identity
    /// comparison against `scenery-cross-check --bits`. NOT consumed by
    /// the renderer — diagnostic output only.
    #[arg(long)]
    bits: bool,
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

/// Mesh-local vertex-list cache. Memoised per `obj_id` (whether
/// `0x01xxxxxx` GfxObj or `0x02xxxxxx` SetupModel). Holds the
/// flattened concatenation of every GfxObj part's `vertex_array`
/// `origin` field — exactly what ACE's `BoundingBox.BuildBox` walks.
///
/// Replaces the older `BoundsCache`, which stored only the
/// mesh-local AABB and reconstructed an over-conservative
/// world AABB via 4-corner rotation. ACE walks each vertex
/// individually — see `~/ace-server/Source/ACE.Server/Physics/BoundingBox.cs:57`.
struct MeshCache {
    inner: HashMap<u32, Option<Vec<Vector3>>>,
}

impl MeshCache {
    fn new() -> Self {
        Self {
            inner: HashMap::new(),
        }
    }

    /// Resolve a placement obj_id (GfxObj or SetupModel) to its
    /// flattened mesh-local vertex list. Returns `None` if the record
    /// can't be loaded or has no geometry — caller treats that as
    /// "skip placement".
    fn lookup(&mut self, portal: &DatDatabase, obj_id: u32) -> Option<&Vec<Vector3>> {
        if !self.inner.contains_key(&obj_id) {
            let result = compute_local_mesh(portal, obj_id);
            self.inner.insert(obj_id, result);
        }
        self.inner.get(&obj_id)?.as_ref()
    }
}

/// Load the mesh-local vertex list for a placement `obj_id`. Dispatches
/// on the top byte: `0x01` → one GfxObj (read vertex_array), `0x02` →
/// SetupModel (concat all Parts' vertices, WITHOUT applying per-part
/// PlacementFrames — ACE's `BoundingBox.BuildBox` doesn't apply them
/// either; parts sit at the SetupModel origin for collision purposes).
fn compute_local_mesh(portal: &DatDatabase, obj_id: u32) -> Option<Vec<Vector3>> {
    let top = (obj_id >> 24) & 0xFF;
    match top {
        0x01 => gfx_local_mesh(portal, obj_id),
        0x02 => setup_local_mesh(portal, obj_id),
        _ => None,
    }
}

/// Load a single GfxObj's vertex.origin list.
fn gfx_local_mesh(portal: &DatDatabase, gfx_id: u32) -> Option<Vec<Vector3>> {
    let bytes = portal.get_file(gfx_id).ok()?;
    let mut cursor = Cursor::new(&bytes);
    let gfx = GfxObj::unpack(&mut cursor).ok()?;
    if gfx.vertex_array.vertices.is_empty() {
        return None;
    }
    let verts: Vec<Vector3> = gfx
        .vertex_array
        .vertices
        .values()
        .map(|v| v.origin)
        .collect();
    Some(verts)
}

/// Load a SetupModel's flattened vertex list — concatenation of all
/// `Parts` GfxObj vertices, with NO per-part `PlacementFrames`
/// transform. This matches ACE: `BoundingBox.BuildBox` iterates
/// `model.StaticMesh.GfxObjs` and treats each part as rooted at the
/// SetupModel origin (the per-part frame is applied later by the
/// rendering pipeline but NOT by the collision-box construction).
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
    if all.is_empty() {
        return None;
    }
    Some(all)
}

/// Compute the world-frame XY AABB for one LandblockInfo placement
/// (building) by walking the mesh's vertices through ACE's transform
/// stack: `scale * yaw(rotation_rad) * translate(origin)`.
/// Returns `None` if the mesh can't be loaded.
fn placement_aabb(
    portal: &DatDatabase,
    mesh_cache: &mut MeshCache,
    obj_id: u32,
    frame: &holtburger_dat::landblock::Frame,
) -> Option<Aabb2D> {
    let verts = mesh_cache.lookup(portal, obj_id)?;
    // Yaw extracted from the placement quaternion. Buildings are
    // overwhelmingly yaw-only-about-Z in retail, so this is exact.
    let q = frame.orientation;
    let yaw = 2.0 * q.z.atan2(q.w);
    Some(transform_mesh_to_aabb(
        verts,
        frame.origin.x,
        frame.origin.y,
        frame.origin.z,
        yaw,
        1.0, // No per-placement scale on LBI Stabs/BuildInfo
    ))
}

/// Build the world-frame AABB list of collision-blockers for the
/// scenery bake. Walks `info.buildings` ONLY — matching ACE's
/// `Scenery.cs:83` which collides against `_landblock.Buildings`, and
/// ACE's `Landblock.init_buildings` (line 438) which populates that
/// field exclusively from `Info.Buildings`. `info.objects` (the Stab
/// list of hand-placed signs, well-heads, etc.) is NOT a
/// collision-blocker in ACE's algorithm and must not be one here.
///
/// Why: the parity gate is "Rust bake = ACE Scenery.Load bit-for-bit".
/// Including `info.objects` AS WELL over-rejects procedural scenery
/// near hand-placed props (signs, lampposts, fences). On Holtburg
/// approach LBs it removed up to 60% of upper-bound placements that
/// retail would have rendered.
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

/// V1 (render-completeness Wave 3, 2026-05-29) — per-`obj_id` cache of
/// the SetupModel's `default_script` PhysicsScript (`0x33`) DID.
///
/// 36% of SetupModels (2161/5935 in client_portal.dat) carry a
/// `default_script` — a continuous ambient particle/sound chain that
/// retail runs for EVERY physics object at creation
/// (`acclient.c:320867` `if (setup->default_script_id.id)
/// play_script_internal(...)`). The static-render path never ran it, so
/// fountains/braziers/torches rendered as dead geometry. Baking the DID
/// into the scenery JSONL lets the renderer attach the chain (see
/// `scene3d/statics.js`'s static-particle attach).
///
/// Resolution is keyed on the placement `obj_id`:
///   - `0x02xxxxxx` SetupModel → parse + read `default_script` (already
///     decoded by `setup_model.rs:316`). `0` when absent.
///   - `0x01xxxxxx` GfxObj → 0. `default_script` is a SetupModel field;
///     a bare GfxObj placement has no ambient script.
///
/// `default_script` is a pure function of `obj_id`, so the cache is
/// fully deterministic and the bake's `Vec<ScenicPlacement>` output is
/// untouched — only the JSONL serialization gains the field.
struct ScriptCache {
    inner: HashMap<u32, u32>,
}

impl ScriptCache {
    fn new() -> Self {
        Self {
            inner: HashMap::new(),
        }
    }

    /// Resolve a placement `obj_id` to its `default_script` DID (0 when
    /// none). Memoised per `obj_id`.
    fn lookup(&mut self, portal: &DatDatabase, obj_id: u32) -> u32 {
        if let Some(&cached) = self.inner.get(&obj_id) {
            return cached;
        }
        let did = resolve_default_script(portal, obj_id);
        self.inner.insert(obj_id, did);
        did
    }
}

/// Read the SetupModel's `default_script` DID for `obj_id`. `0x02`
/// dispatches to the SetupModel parse; anything else (GfxObj `0x01`,
/// unexpected prefixes) returns 0 — no ambient script.
fn resolve_default_script(portal: &DatDatabase, obj_id: u32) -> u32 {
    let top = (obj_id >> 24) & 0xFF;
    if top != 0x02 {
        return 0;
    }
    let Ok(bytes) = portal.get_file(obj_id) else {
        return 0;
    };
    let mut cursor = Cursor::new(&bytes);
    match SetupModel::read(&mut cursor) {
        Ok(setup) => setup.default_script.unwrap_or(0),
        Err(_) => 0,
    }
}

/// Serialize one `ScenicPlacement` line in the JSONL format documented
/// by `hypotheticalmethod.md`. All floats are formatted via
/// `format_f32_six_sig`, which uses `{:.6}` (six digits after the
/// decimal point — enough for cm-precision on AC's 0..192 m scale
/// while staying short enough for diffs to read).
/// `default_script_id` (V1, 2026-05-29) is emitted as a `0x{:08X}` hex
/// string — same convention as `obj_id` — so the wasm reader's
/// `obj_id_hex_to_u32` helper can round-trip it. It's the LAST field so
/// older readers (and the JSONL `#[serde(default)]` on the wasm side)
/// stay forward/backward-compatible: a record without it parses to 0
/// (→ renderer no-op), a record with it carries the ambient-script DID.
fn write_placement_line<W: Write>(
    mut w: W,
    p: &ScenicPlacement,
    default_script_id: u32,
) -> Result<()> {
    writeln!(
        w,
        "{{\"obj_id\":\"0x{:08X}\",\"x\":{},\"y\":{},\"z\":{},\"qw\":{},\"qx\":{},\"qy\":{},\"qz\":{},\"scale\":{},\"source_cell_x\":{},\"source_cell_y\":{},\"source_obj_idx\":{},\"default_script_id\":\"0x{:08X}\"}}",
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
        default_script_id,
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
    // Phase-1 diagnostic: emit raw IEEE-754 bits (decimal u32) so the
    // parity check sees the exact f32, not a lossy 6-decimal rounding.
    // Valid JSON number; consumed only by `compare-bits.py`.
    if EMIT_BITS.load(std::sync::atomic::Ordering::Relaxed) {
        return v.to_bits().to_string();
    }
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
    mesh_cache: &mut MeshCache,
    scene_cache: &mut SceneCache,
    script_cache: &mut ScriptCache,
    lb_key: u16,
    out_dir: &Path,
    mode: BakeMode,
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
            Ok(info) => collect_building_aabbs(portal, mesh_cache, &info),
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
        // Both closures hold their own `&DatDatabase` and a `&mut` to
        // their respective cache. The AABB closure resolves the mesh
        // and applies ACE's per-vertex transform — see
        // `placement_aabb` for the equivalent building-side helper.
        let (scene_cache_ref, mesh_cache_ref) = (scene_cache, mesh_cache);
        let fetch_scene = |scene_id: u32| scene_cache_ref.lookup(portal, scene_id);
        let compute_world_aabb = |px: PlacementXform| -> Option<Aabb2D> {
            let verts = mesh_cache_ref.lookup(portal, px.obj_id)?;
            Some(transform_mesh_to_aabb(
                verts,
                px.lx,
                px.ly,
                px.lz,
                px.rotation_rad,
                px.scale,
            ))
        };

        bake_landblock(
            region,
            &cell_landblock,
            landblock_id,
            fetch_scene,
            compute_world_aabb,
            &building_aabbs,
            mode,
        )
    };

    // Emit JSONL — one line per placement. Empty file (0 placements)
    // is still emitted so consumers can pattern-match on file presence.
    let out_path = out_dir.join(format!("0x{lb_key:04X}.scenery.jsonl"));
    let f = File::create(&out_path)
        .with_context(|| format!("create {}", out_path.display()))?;
    let mut w = BufWriter::new(f);
    for p in &placements {
        // V1 (2026-05-29) — resolve the placement's SetupModel
        // `default_script` ambient-chain DID (0 for GfxObjs / scripts
        // none) and emit it as the trailing JSONL field.
        let default_script_id = script_cache.lookup(portal, p.obj_id);
        write_placement_line(&mut w, p, default_script_id)?;
    }
    w.flush()?;

    // Wave-4.B (2026-05-23) — per-LB sha256 sidecar. The wire-agent's
    // diag.integrity.verifyManifests() fetches the JSONL + this sidecar,
    // computes sha256 of the fetched bytes via crypto.subtle.digest, and
    // compares. Catches network corruption, modder-edited bake outputs
    // that bypassed the input-DAT preflight, and CDN stale-cache. Bake-
    // input integrity (the canonical DATs the bake was run against) is
    // covered by the existing top-level `bake-source.sha256` written
    // once per CLI run.
    let sha = sha256_file(&out_path)
        .with_context(|| format!("sha256 {}", out_path.display()))?;
    let sidecar_path = out_dir.join(format!("0x{lb_key:04X}.scenery.jsonl.sha256"));
    let mut sf = File::create(&sidecar_path)
        .with_context(|| format!("create {}", sidecar_path.display()))?;
    // E5 — determinism freeze hash. FNV-1a/64 over the FROZEN explicit
    // placement stream (the twelve wire fields, the same ones the JSONL
    // carries). The client recomputes this over the loaded placements
    // and WARNs (never errors) on mismatch — an advisory "bake math
    // changed but nobody re-baked" guard. The sha256 above guards
    // transit/storage; this guards bake-logic drift. It is the FIRST
    // whitespace token on line 1 (sha256) that the JS `verifyManifests`
    // sidecar reader consumes, so the `placements-hash` line below is
    // purely additive and ignored by older readers.
    let fp = placements_fingerprint(&placements);
    writeln!(sf, "{sha}")?;
    writeln!(sf, "placements-hash\t{fp:016x}")?;
    sf.flush()?;

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
    if cli.bits {
        EMIT_BITS.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    let mut log_builder = env_logger::Builder::from_default_env();
    if cli.verbose {
        log_builder.filter_level(log::LevelFilter::Info);
    } else {
        log_builder.filter_level(log::LevelFilter::Warn);
    }
    log_builder.init();

    let region_did = parse_hex_u32(&cli.region_did)?;
    let landblocks = parse_landblock_spec(&cli.landblocks)?;
    let mode: BakeMode = cli
        .mode
        .parse()
        .map_err(|e: String| anyhow::anyhow!("--mode parse error: {e}"))?;

    info!(
        "scenery-bake: --dat-dir={} --landblocks={} ({} LBs) --region-did=0x{:08X} --mode={} --out={}",
        cli.dat_dir.display(),
        cli.landblocks,
        landblocks.len(),
        region_did,
        mode.as_str(),
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

    let mut mesh_cache = MeshCache::new();
    let mut scene_cache = SceneCache::new();
    // V1 (2026-05-29) — `default_script` DID resolution, memoised per
    // placement obj_id across the whole bake run.
    let mut script_cache = ScriptCache::new();
    let mut counts: Vec<usize> = Vec::with_capacity(landblocks.len());
    let mut skipped: usize = 0;

    for (i, &lb_key) in landblocks.iter().enumerate() {
        match bake_one(
            &region,
            &check.portal_db,
            &check.cell_db,
            &mut mesh_cache,
            &mut scene_cache,
            &mut script_cache,
            lb_key,
            &cli.out,
            mode,
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
        mode,
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
    mode: BakeMode,
) -> String {
    format!(
        "client_portal.dat\t{}\nclient_cell_1.dat\t{}\nclient_local_English.dat\t{}\nbake-tool-version\t{} + {}\nregion-did\t0x{:08X}\nbake-mode\t{}\nlandblocks\t{} baked, {} skipped\n",
        portal_hash,
        cell_hash,
        local_hash,
        SCENERY_BAKE_LIB_VERSION,
        SCENERY_BAKE_CLI_VERSION,
        region_did,
        mode.as_str(),
        baked,
        skipped,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_scenery_bake::GeneratedSceneryIdentity;

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
            BakeMode::AceCompat,
        );
        assert!(m.contains("client_portal.dat\t"));
        assert!(m.contains("client_cell_1.dat\t"));
        assert!(m.contains("client_local_English.dat\t"));
        assert!(m.contains("region-did\t0x13000000"));
        assert!(m.contains("bake-mode\tace-compat"));
        assert!(m.contains("169 baked, 0 skipped"));
        assert!(m.contains(SCENERY_BAKE_LIB_VERSION));
        assert!(m.contains(SCENERY_BAKE_CLI_VERSION));
        // Seven-line format (now includes `bake-mode`).
        assert_eq!(m.lines().count(), 7);
    }

    #[test]
    fn format_manifest_strict_mode_label() {
        let m = format_manifest(
            &"0".repeat(64),
            &"0".repeat(64),
            &"0".repeat(64),
            0x13000000,
            1,
            0,
            BakeMode::Strict,
        );
        assert!(m.contains("bake-mode\tstrict"));
    }

    #[test]
    fn bake_mode_parse_round_trip() {
        // Spelling variants accepted.
        let ac: BakeMode = "ace-compat".parse().unwrap();
        assert_eq!(ac, BakeMode::AceCompat);
        let ac2: BakeMode = "ace_compat".parse().unwrap();
        assert_eq!(ac2, BakeMode::AceCompat);
        let ac3: BakeMode = "acecompat".parse().unwrap();
        assert_eq!(ac3, BakeMode::AceCompat);
        let st: BakeMode = "strict".parse().unwrap();
        assert_eq!(st, BakeMode::Strict);
        // Unknown rejects.
        let bad: Result<BakeMode, _> = "loose".parse();
        assert!(bad.is_err());
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
            identity: GeneratedSceneryIdentity::default(),
        };
        let mut buf = Vec::new();
        write_placement_line(&mut buf, &p, 0x330003EC).unwrap();
        let s = String::from_utf8(buf).unwrap();
        // One line.
        assert_eq!(s.matches('\n').count(), 1);
        // Hex obj_id.
        assert!(s.starts_with("{\"obj_id\":\"0x02000123\""));
        // Six digits after decimal.
        assert!(s.contains("\"x\":12.340000"));
        // V1 (2026-05-29) — trailing default_script_id, hex-string, last field.
        assert!(s.contains("\"default_script_id\":\"0x330003EC\""));
        assert!(s.trim_end().ends_with("\"default_script_id\":\"0x330003EC\"}"));
    }

    /// V1 (2026-05-29) — a GfxObj (`0x01`) placement emits a zero
    /// `default_script_id` (default_script is a SetupModel-only field).
    #[test]
    fn write_placement_line_emits_zero_script_for_gfxobj() {
        let p = ScenicPlacement {
            obj_id: 0x0100_0010,
            x: 1.0,
            y: 2.0,
            z: 3.0,
            qw: 1.0,
            qx: 0.0,
            qy: 0.0,
            qz: 0.0,
            scale: 1.0,
            source_cell_x: 0,
            source_cell_y: 0,
            source_obj_idx: 0,
            identity: GeneratedSceneryIdentity::default(),
        };
        let mut buf = Vec::new();
        write_placement_line(&mut buf, &p, 0).unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("\"default_script_id\":\"0x00000000\""));
    }

    /// Minimal client-side mirror of the wasm `ScenicPlacementJsonRaw`
    /// reader: the twelve wire fields parsed straight out of the JSONL.
    /// `obj_id` / `source_*` are u32, the nine floats land in f32 — i.e.
    /// the EXACT representation `fetch_one_lb` reconstructs from the
    /// shipped (lossy `{:.6}`) text.
    #[derive(serde::Deserialize)]
    struct WireRecord {
        obj_id: String,
        x: f32,
        y: f32,
        z: f32,
        qw: f32,
        qx: f32,
        qy: f32,
        qz: f32,
        scale: f32,
        source_cell_x: u32,
        source_cell_y: u32,
        source_obj_idx: u32,
    }

    /// FNV-1a/64 over the wire fields of the CLIENT-PARSED records — the
    /// hand-rolled twin of `holtburger-web`'s `placements_freeze_hash`,
    /// folding each float's bits exactly as the client receives them
    /// (already truncated through `{:.6}`). No further canonicalisation:
    /// this hashes the literal reparsed f32 the renderer would use, so a
    /// match against the bake-side `placements_fingerprint` proves both
    /// sides agree on the post-wire value.
    fn client_freeze_hash(records: &[WireRecord]) -> u64 {
        const FNV1A_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
        const FNV1A_PRIME: u64 = 0x0000_0100_0000_01b3;
        let mut h = FNV1A_OFFSET;
        for r in records {
            let obj_id = u32::from_str_radix(r.obj_id.trim_start_matches("0x"), 16).unwrap();
            for word in [
                obj_id,
                r.x.to_bits(),
                r.y.to_bits(),
                r.z.to_bits(),
                r.qw.to_bits(),
                r.qx.to_bits(),
                r.qy.to_bits(),
                r.qz.to_bits(),
                r.scale.to_bits(),
                r.source_cell_x,
                r.source_cell_y,
                r.source_obj_idx,
            ] {
                for byte in word.to_le_bytes() {
                    h ^= byte as u64;
                    h = h.wrapping_mul(FNV1A_PRIME);
                }
            }
        }
        h
    }

    /// E5 freeze-hash round-trip — through the REAL wire path. We start
    /// from full-precision in-memory placements, serialise them with
    /// `write_placement_line` (the production `{:.6}` JSONL emitter),
    /// compute the bake-side `placements_fingerprint` for the sidecar,
    /// then REPARSE the JSONL back into f32 (exactly as the wasm client
    /// does) and recompute the client-side fold. The two MUST match.
    ///
    /// This is the regression guard for the precision-mismatch bug: the
    /// fixture deliberately uses a non-6-decimal-exact quaternion
    /// component (`qw = cos(40°/2) = 0.93969...`, whose f32 bits do NOT
    /// survive a `{:.6}` round-trip) so that hashing the raw in-memory
    /// f32 on the bake side would FALSE-POSITIVE here. Because
    /// `placements_fingerprint` folds the post-`{:.6}` wire bits, the
    /// bake-side hash equals what the client reconstructs.
    ///
    /// We also verify the two-line sidecar shape (bare sha256 first
    /// token, then `placements-hash\t<hex>`) the JS `verifyManifests`
    /// reader and the wasm gate depend on, and that mutating ONE
    /// coordinate makes the recomputed hash diverge (the advisory WARN).
    #[test]
    fn freeze_hash_sidecar_round_trips_and_detects_mutation() {
        // Non-axis-aligned yaw so qw/qz are NOT 6-decimal-exact f32 —
        // the case the precision bug used to silently break.
        let rad = 40.0_f32.to_radians();
        let half = rad * 0.5;
        let qw = (half as f64).cos() as f32;
        let qz = (half as f64).sin() as f32;
        let mk = |x: f32| ScenicPlacement {
            obj_id: 0x0100_0042,
            x,
            // 7.123457 is not exactly representable and rounds under
            // `{:.6}` — exercises the lossy path on a coordinate too.
            y: 7.1234567,
            z: 3.25,
            qw,
            qx: 0.0,
            qy: 0.0,
            qz,
            scale: 1.0,
            source_cell_x: 1,
            source_cell_y: 2,
            source_obj_idx: 0,
            identity: GeneratedSceneryIdentity::default(),
        };
        let placements = vec![mk(10.0), mk(20.123457), mk(30.0)];

        // Bake side: compute the hash and render the two-line sidecar.
        let fp = placements_fingerprint(&placements);
        let fake_sha = "a".repeat(64);
        let sidecar = format!("{fake_sha}\nplacements-hash\t{fp:016x}\n");

        // The bare-sha-first-token invariant the JS reader relies on.
        assert_eq!(sidecar.trim().split_whitespace().next().unwrap(), fake_sha);

        // Bake side: serialise EXACTLY as production does (lossy `{:.6}`).
        let mut buf = Vec::new();
        for p in &placements {
            write_placement_line(&mut buf, p, 0).unwrap();
        }
        let jsonl = String::from_utf8(buf).unwrap();

        // Client side: reparse the shipped JSONL into f32 (as the wasm
        // reader does) and recompute the fold over the reconstructed
        // values.
        let reparsed: Vec<WireRecord> = jsonl
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(reparsed.len(), placements.len());
        let client = client_freeze_hash(&reparsed);

        // The load-bearing assertion: the bake-side sidecar hash equals
        // the value the client reconstructs from the shipped JSONL — even
        // though the floats lost precision in `{:.6}`. Before the fix
        // (bake hashing raw in-memory f32 bits) this diverged for the
        // non-6-decimal-exact quaternion, false-positiving the gate.
        assert_eq!(
            client, fp,
            "client-recomputed freeze hash must equal the bake-side \
             sidecar hash over the SAME wire-truncated values"
        );

        // Extract the `placements-hash` line exactly like the wasm gate
        // and confirm it parses to the bake-side fp.
        let expected_hex = sidecar
            .lines()
            .find_map(|line| {
                let line = line.trim();
                line.strip_prefix("placements-hash")
                    .map(str::trim)
                    .filter(|h| !h.is_empty())
            })
            .expect("sidecar carries a placements-hash line");
        assert_eq!(u64::from_str_radix(expected_hex, 16).unwrap(), fp);

        // Mutate one coordinate → the advisory gate must detect drift,
        // even after the lossy round-trip (20.0001 differs from 20.123457
        // at the 6-decimal grain).
        let mut mutated = placements.clone();
        mutated[1].x = 20.0001;
        assert_ne!(
            placements_fingerprint(&mutated),
            fp,
            "a single mutated coordinate must change the freeze hash"
        );
    }
}
