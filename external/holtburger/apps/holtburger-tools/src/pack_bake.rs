//! HBP1/HBSI1 pack-world emitter — pipeline re-engineering **T10 (ST1)**.
//!
//! `dat-shard --emit-packs [--legacy-layers]` dual-emits: the legacy dist
//! layers come from the UNCHANGED [`crate::dat_shard`] path; this module
//! adds the pack tree beside them. SPEC.md §1.1 + §3 T10; byte formats in
//! [`crate::pack_format`] (pass 2 S2–S4); policy decisions cited inline.
//!
//! Policy summary (pass 2 D-02.1/D-02.4, pass 5 D-05.2/S2, pass 12
//! D-12.5/D-12.6):
//!  * 2×2-LB tile packs; per-LB interior packs above 32 KiB of EnvCells.
//!  * Record tiering by tile-usage count: ≤ 4 inline, 5–63 META-REGIONAL
//!    (32×32-LB supergrid cell by usage centroid), ≥ 64 META-COMMONS.
//!  * Environments (0x0D) tier by LB-usage: ≤ 4 inline, 5–63 ENV-REGIONAL,
//!    ≥ 64 ENV-COMMONS.
//!  * Previews tier by LB-usage: ≥ 1024 PVW-COMMONS; single-interior-only
//!    previews ride the interior pack; the rest PVW-REGIONAL.
//!  * Raw 0x06 Texture records are NEVER packed (legacy fallback lane);
//!    the TEXREF section declares tiers instead.
//!  * Closure walk is the WIDENED walk (D-12.5): MotionTable /
//!    PhysicsScript / SoundTable / did_degrade edges included, sized by the
//!    same K-tier machinery, per-class/per-tier bytes in the bake report.
//!  * Closure is split by SOURCE: outdoor roots (LandblockInfo statics +
//!    buildings + scenery) feed the tile pack; EnvCell-derived closure
//!    (environments, cell surfaces, interior statics) feeds the interior
//!    pack when the LB is interior-split, else the tile pack — so town
//!    buildings render with no interior fetch (pass 2 D-02.1 intent).
//!  * Terrain t128 boot slice: ONE CAS file per channel (D-12.6), shaped
//!    as an HBP1 pack (kind 6/7) holding a PVW stream of ≤128-capped
//!    HBC7 chains mip-sliced from the t1024 payload dir — no re-encode.
//!  * `manifest.json` stays `version: 2` and gains the ADDITIVE
//!    `world_index` / `pack_url_template` fields (presence-routed; the
//!    version sentinel flips only at ST10).
//!  * GEOM sections are ABSENT in this stage — pass 2 D-02.7's encoding
//!    0x0000 migration state ("decode from RECORDS at runtime"); HBG1
//!    emission is T13.
//!
//! Region bounding: `--pack-region X0Y0:X1Y1` (hex LB corners, inclusive,
//! repeatable) bakes a bounded world for laptop BAKE-CI; the full-world
//! bake is a buildbox job. Tier counts are computed over the baked scope —
//! a bounded bake's commons/regional split differs from the full world's
//! by construction (stated in the report).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::Read as _;
use std::path::{Path, PathBuf};

use holtburger_dat::file_type::{EnvCell, Texture, env_cell::surface_did_for_envcell_index};
use holtburger_dat::hbg1;
use holtburger_dat::landblock::LandblockInfo;
use holtburger_dat::walk::{
    collect_model_dependencies_widened, collect_surface_dependencies,
};
use holtburger_dat::{
    DatDatabase, DatError, EOR_CELL_NAMESPACE, EOR_PORTAL_NAMESPACE, FileMetadata,
    ResourceKey, ResourceSource, Result as DatResult,
};
use holtburger_manifest::v2::{DEFAULT_PACK_URL_TEMPLATE, ManifestV2, WorldIndexRef};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::dat_shard::{
    BOOT_ESSENTIAL_PORTAL_IDS, HBC7_HEADER_LEN, HBC7_MAGIC, parse_hex_u32,
    validate_hbc7,
};
use crate::error::{Result, ToolError};
use crate::pack_format::{
    self as pf, HbpReader, PackTableEntry, RefsSection, SectionOut, SpatialIndex,
    TexRefRow, codec, pack_kind, section_kind, shared_kind, tier_bits,
};

/// Inline threshold K (pass 2 D-02.4).
pub const K_INLINE_TILES: usize = 4;
/// Commons threshold in tiles (pass 2 D-02.4).
pub const COMMONS_TILES: usize = 64;
/// PVW commons threshold in LBs (pass 2 D-02.4).
pub const PVW_COMMONS_LBS: usize = 1024;
/// Env inline / commons thresholds in LBs (pass 2 D-02.4).
pub const ENV_INLINE_LBS: usize = 4;
pub const ENV_COMMONS_LBS: usize = 64;
/// Interior split threshold (pass 2 D-02.1).
pub const INTERIOR_SPLIT_BYTES: usize = 32 * 1024;
/// Preview level-0 cap (pass 5 D-05.2): larger axis ≤ 128.
pub const PVW_CAP: u32 = 128;
/// Supergrid cell edge in LBs (SPEC §1.1: 32×32-LB supergrid).
pub const SUPERGRID_LBS: u32 = 32;

/// Inclusive LB-coordinate rectangle.
#[derive(Debug, Clone, Copy)]
pub struct RegionRect {
    pub x0: u8,
    pub y0: u8,
    pub x1: u8,
    pub y1: u8,
}

impl RegionRect {
    pub fn contains(&self, lbx: u8, lby: u8) -> bool {
        (self.x0..=self.x1).contains(&lbx) && (self.y0..=self.y1).contains(&lby)
    }

    /// Parse `"A4AF:AEB9"` (hex `XXYY` corners, inclusive, `0x` optional).
    pub fn parse(spec: &str) -> std::result::Result<Self, String> {
        let (a, b) = spec
            .split_once(':')
            .ok_or_else(|| format!("region {spec:?}: expected X0Y0:X1Y1"))?;
        let a = parse_hex_u32(a)?;
        let b = parse_hex_u32(b)?;
        if a > 0xFFFF || b > 0xFFFF {
            return Err(format!("region {spec:?}: corners must be 16-bit LB ids"));
        }
        let (x0, y0) = ((a >> 8) as u8, (a & 0xFF) as u8);
        let (x1, y1) = ((b >> 8) as u8, (b & 0xFF) as u8);
        if x0 > x1 || y0 > y1 {
            return Err(format!("region {spec:?}: corners out of order"));
        }
        Ok(Self { x0, y0, x1, y1 })
    }
}

#[derive(Debug, Clone)]
pub struct PackBakeOptions {
    pub eor_portal: PathBuf,
    pub eor_cell: PathBuf,
    pub scenery_dir: Option<PathBuf>,
    pub spawns_dir: Option<PathBuf>,
    pub events_dir: Option<PathBuf>,
    /// Full-tier HBC7 dir (`<rsId>.hbc7`) — preview slice fallback source.
    pub tex_bc7: Option<PathBuf>,
    /// Existing preview HBC7 dir — preferred slice source.
    pub tex_bc7_pre: Option<PathBuf>,
    /// XUBC7 KTX2 dir — full-tier presence for TEXREF bits (opaque here).
    pub tex_xu7: Option<PathBuf>,
    /// Extra preview HBC7 dir (offline xu7-derived previews from
    /// `scripts/derive-pvw-xu7.mjs`) — covers xu7-only rsIds.
    pub tex_pvw_extra: Option<PathBuf>,
    /// t1024 terrain payload dir (`<rsId>_color.hbc7` + `<rsId>_nra.hbc7`)
    /// — source of the t128 boot slice.
    pub terrain_bc7_dir: Option<PathBuf>,
    pub regions: Option<Vec<RegionRect>>,
    pub boot_landblock: u32,
    pub output_dir: PathBuf,
    pub zstd_level: i32,
    pub verify_closure: bool,
    pub verify_deterministic: bool,
    /// RELIEF-IN-BAKE — when `Some(scale)`, ALSO emit relief-variant GEOM
    /// (`GEOMR`) sections for the `set_gfx_relief(true, 0, scale)` profile.
    /// `None` (the default) leaves every emitted byte exactly as it was.
    pub geom_relief_scale: Option<f32>,
    /// PAGE-RESAMPLE (T22 D2) — fail the bake when any TEXREF'd rsId with a
    /// full tier is stored OFF its array page. This is the gate for a bake
    /// over a page-resampled corpus; it is OFF by default because every
    /// pre-resample corpus legitimately fails it (the census counters in the
    /// report tell you where you stand either way).
    pub require_page_dims: bool,
}

/// Per-class, per-tier byte accounting row (report).
#[derive(Debug, Clone, Default, Serialize)]
pub struct TierBytes {
    pub records: usize,
    pub inline_bytes: u64,
    pub regional_bytes: u64,
    pub commons_bytes: u64,
}

/// Per-section-kind zstd accounting row (report).
#[derive(Debug, Clone, Default, Serialize)]
pub struct SectionRatio {
    pub raw_bytes: u64,
    pub stored_bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PackBakeReport {
    pub scope: String,
    pub landblocks: usize,
    pub tiles: usize,
    pub interiors: usize,
    pub packs_emitted: usize,
    pub pack_bytes_total: u64,
    pub index_bytes: u64,
    /// Portal ids skipped by the `0x__FFxxxx` patch-id guard.
    pub patch_ids_rejected: usize,
    /// Per pack kind: (count, stored bytes).
    pub packs_by_kind: BTreeMap<String, (usize, u64)>,
    /// Per section kind: raw vs stored bytes (the zstd-ratio report that
    /// re-scores B1 slack — SPEC §3 T10 / R-01).
    pub section_ratios: BTreeMap<String, SectionRatio>,
    /// Per record class (DAT type prefix), per tier — the D-12.5
    /// walk-widening byte report. Widened classes are suffixed `*`.
    pub class_tiers: BTreeMap<String, TierBytes>,
    /// TEXREF coverage (pass 5 D-05.5.4 operative form: a compressed full
    /// tier with no preview = missing; no compressed tier at all =
    /// legacy-only, counted separately).
    pub texref_rows: usize,
    pub texref_missing_pvw: usize,
    pub texref_legacy_only: usize,
    pub pvw_from_pre: usize,
    pub pvw_from_full: usize,
    pub pvw_from_extra: usize,
    pub pvw_unsliceable: usize,
    pub pvw_bytes_total: u64,
    /// rsIds that still need the offline xu7 deriver (xu7 present, no
    /// HBC7 source to slice) — input list for `derive-pvw-xu7.mjs`.
    pub pvw_wanted_from_xu7: Vec<String>,
    /// PAGE-RESAMPLE census (T22 D2). `texref_on_page` carries the
    /// `FULL_PAGE_DIMS` tier bit; `texref_off_page` is the bake-side reading
    /// of the client's `needsResample()` over EVERY TEXREF row.
    pub texref_on_page: usize,
    pub texref_off_page: usize,
    /// Off-page rows that HAVE a compressed full tier — the subset a
    /// resampled corpus can fix, and the one `require_page_dims` gates on.
    ///
    /// The remainder (`texref_off_page - texref_off_page_full_tier`) is the
    /// LEGACY-LANE population: rsIds with no full tier at all, whose pixels
    /// come from the DAT record, at DAT dims, through the legacy decode.
    /// No corpus re-encode moves them; they need either full-tier coverage
    /// or an explicit exclusion in the pool producer. Counted here rather
    /// than folded away, because a gate that quietly ignores a population is
    /// how a "0" stops meaning anything.
    pub texref_off_page_full_tier: usize,
    pub texref_off_page_legacy_only: usize,
    /// Off-page rsIds, `0xID WxH→PxP`, capped — enough to diagnose a
    /// coverage hole without turning the report into a corpus listing.
    pub texref_off_page_examples: Vec<String>,
    /// TEXREF'd rsIds whose FULL-TIER (KTX2) dims differ from the DAT
    /// record's. Before PAGE-RESAMPLE this read 0 (the encode does not
    /// resample); after it, it is the resampled population.
    pub texref_full_tier_dims_differ: usize,
    /// POST-coverage boot-ring re-score (F-11.16).
    pub ring_tiles: usize,
    pub ring_tile_pack_bytes: u64,
    pub ring_preview_bytes: u64,
    pub meta_commons_bytes: u64,
    pub widened_commons_bytes: u64,
    pub terrain_slice_color_bytes: u64,
    pub terrain_slice_nra_bytes: u64,
    /// T13 (ST3): HBG1 GEOM emission census. Rows are co-located with their
    /// record's pack (pass 2 D-02.7 co-location; pass 4 D-04.2).
    pub geom_rows: usize,
    pub geom_bytes_raw: u64,
    /// Payloads over the pass-4 S1 SHOULD cap (256 KiB) — census, not a
    /// failure (the MUST cap of 4 MiB fails the bake loudly).
    pub geom_soft_cap_hits: usize,
    /// Q2 census input: largest single mesh payload emitted.
    pub geom_max_payload_bytes: usize,
    /// RELIEF-IN-BAKE census. `geom_relief_variant` is empty when the bake
    /// emitted no relief variants (the default).
    pub geom_relief_variant: String,
    /// GEOMR rows written (a model repeated across packs counts once per pack,
    /// same convention as `geom_rows`).
    pub geom_relief_rows: usize,
    pub geom_relief_bytes_raw: u64,
    /// Distinct 0x01 models whose relief encode DIFFERS from the default
    /// (i.e. gained rails) vs. those the profile leaves untouched (gate
    /// rejected or no railable edge) — the latter get no variant row.
    pub geom_relief_models_changed: usize,
    pub geom_relief_models_identical: usize,
    /// Added triangles across the changed models — the "more triangles from
    /// flat walls" number, reported not gated.
    pub geom_relief_added_tris: u64,
    pub geom_relief_max_payload_bytes: usize,
    pub closure_verified: bool,
    pub determinism_verified: bool,
}

// ---------------------------------------------------------------------------
// On-demand DAT source (keeps bake RSS ~flat; no LoadedBundle)
// ---------------------------------------------------------------------------

struct DatPairSource {
    portal: DatDatabase,
    cell: DatDatabase,
}

impl ResourceSource for DatPairSource {
    fn get_file_by_key(&self, key: ResourceKey<'_>) -> DatResult<Vec<u8>> {
        let db = match key.namespace {
            EOR_PORTAL_NAMESPACE => &self.portal,
            EOR_CELL_NAMESPACE => &self.cell,
            other => {
                return Err(DatError::Other(format!(
                    "DatPairSource: unknown namespace {other}"
                )));
            }
        };
        if !db.files.contains_key(&key.file_id) {
            return Err(DatError::Other(format!(
                "DatPairSource: missing {}:{:#010X}",
                key.namespace, key.file_id
            )));
        }
        db.get_file(key.file_id)
    }
    fn get_metadata_by_key(&self, key: ResourceKey<'_>) -> Option<FileMetadata> {
        let db = match key.namespace {
            EOR_PORTAL_NAMESPACE => &self.portal,
            EOR_CELL_NAMESPACE => &self.cell,
            _ => return None,
        };
        db.files.get(&key.file_id).map(|e| FileMetadata {
            id: key.file_id,
            size: e.size,
            is_pruned: false,
        })
    }
    fn has_namespace(&self, namespace: &str) -> bool {
        matches!(namespace, EOR_PORTAL_NAMESPACE | EOR_CELL_NAMESPACE)
    }
}

// ---------------------------------------------------------------------------
// Scenery JSONL
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Deserialize)]
struct SceneryRow {
    obj_id: String,
    x: f32,
    y: f32,
    z: f32,
    qw: f32,
    qx: f32,
    qy: f32,
    qz: f32,
    scale: f32,
    #[serde(default)]
    source_cell_x: u16,
    #[serde(default)]
    source_cell_y: u16,
    #[serde(default)]
    source_obj_idx: u16,
    #[serde(default)]
    default_script_id: Option<String>,
}

/// A parsed placement, ready for the 44-byte PLACEMENTS row.
struct Placement {
    obj_id: u32,
    pos: [f32; 3],
    quat: [f32; 4],
    scale: f32,
    cell_xy: u16,
    obj_idx: u16,
    script_id: u32,
}

fn read_scenery_lb(dir: &Path, lb: u16) -> Result<Vec<Placement>> {
    let path = dir.join(format!("0x{lb:04X}.scenery.jsonl"));
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(Vec::new()); // absent = 0 placements (legit for empty LBs)
    };
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let row: SceneryRow = serde_json::from_str(line)
            .map_err(|e| ToolError::Validation(format!("{path:?}:{}: {e}", i + 1)))?;
        let obj_id = parse_hex_u32(&row.obj_id)
            .map_err(|e| ToolError::Validation(format!("{path:?}:{}: {e}", i + 1)))?;
        let script_id = row
            .default_script_id
            .as_deref()
            .map(parse_hex_u32)
            .transpose()
            .map_err(|e| ToolError::Validation(format!("{path:?}:{}: {e}", i + 1)))?
            .unwrap_or(0);
        out.push(Placement {
            obj_id,
            pos: [row.x, row.y, row.z],
            quat: [row.qw, row.qx, row.qy, row.qz],
            scale: row.scale,
            cell_xy: ((row.source_cell_x & 0xFF) << 8) | (row.source_cell_y & 0xFF),
            obj_idx: row.source_obj_idx,
            script_id,
        });
    }
    Ok(out)
}

fn read_side_jsonl(dir: Option<&Path>, lb: u16, suffix: &str) -> Vec<u8> {
    let Some(dir) = dir else { return Vec::new() };
    std::fs::read(dir.join(format!("0x{lb:04X}.{suffix}.jsonl"))).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// HBC7 preview slicing (pass 5 D-05.2: mip-slice, no re-encode;
// non-square caps the LARGER axis at 128)
// ---------------------------------------------------------------------------

/// Slice an HBC7 full-chain blob down to the preview cap. Returns the
/// re-headered sub-chain, or `None` when the chain never reaches the cap
/// (unsliceable without re-encode — counted, falls to the next source).
pub fn slice_hbc7_to_cap(bytes: &[u8], cap: u32) -> Option<Vec<u8>> {
    let (width, height) = validate_hbc7(bytes).ok()?;
    let level_bytes = |w: u32, h: u32| -> usize {
        (w.div_ceil(4) as usize) * (h.div_ceil(4) as usize) * 16
    };
    let (mut lw, mut lh) = (width, height);
    let mut offset = HBC7_HEADER_LEN;
    loop {
        if lw.max(lh) <= cap {
            let mut out = Vec::with_capacity(HBC7_HEADER_LEN + bytes.len() - offset);
            out.extend_from_slice(HBC7_MAGIC);
            for v in [lw, lh, lw.div_ceil(4), lh.div_ceil(4)] {
                out.extend_from_slice(&v.to_le_bytes());
            }
            out.extend_from_slice(&bytes[offset..]);
            // Tail must be a whole chain from (lw, lh) — holds by
            // construction, but re-validate for safety.
            validate_hbc7(&out).ok()?;
            return Some(out);
        }
        let need = level_bytes(lw, lh);
        if offset + need > bytes.len() {
            return None; // chain ended above the cap
        }
        offset += need;
        if (lw == 1 && lh == 1) || offset == bytes.len() {
            return None;
        }
        lw = (lw >> 1).max(1);
        lh = (lh >> 1).max(1);
    }
}

/// TEXREF `dims` byte: `(ceil_log2(w) << 4) | ceil_log2(h)`. Exact for
/// pow2 dims (the corpus); non-pow2 rounds up (bucket keying only).
///
/// Delegates to `page_resample::dims_byte_of` so the byte the pack writes
/// and the arithmetic the pool class key reads cannot drift apart.
pub fn dims_byte(w: u32, h: u32) -> u8 {
    crate::page_resample::dims_byte_of(w, h)
}

/// KTX2 file identifier (spec §3.1). The bake treats XUBC7 payloads as
/// opaque, but the HEADER's declared dims are not opaque — they are what the
/// client's TEXREF row must publish, because the full tier (not the DAT
/// record) is what actually lands in the texture array.
const KTX2_IDENTIFIER: [u8; 12] =
    [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A];

/// Declared `(width, height)` of an XUBC7 KTX2 payload, or `None` when the
/// file is absent / not a KTX2. Reads 32 bytes, never the payload.
fn ktx2_dims(path: &Path) -> Option<(u32, u32)> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut head = [0u8; 32];
    f.read_exact(&mut head).ok()?;
    if head[..12] != KTX2_IDENTIFIER {
        return None;
    }
    let w = u32::from_le_bytes(head[20..24].try_into().unwrap());
    let h = u32::from_le_bytes(head[24..28].try_into().unwrap());
    (w > 0 && h > 0).then_some((w, h))
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn sha256_trunc16(bytes: &[u8]) -> [u8; 16] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let full: [u8; 32] = hasher.finalize().into();
    let mut t = [0u8; 16];
    t.copy_from_slice(&full[..16]);
    t
}

fn hex16(bytes: &[u8; 16]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(32);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn sha256_file_hex(path: &Path) -> Result<String> {
    let mut f = std::fs::File::open(path)
        .map_err(|e| ToolError::Validation(format!("open {path:?}: {e}")))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| ToolError::Validation(format!("read {path:?}: {e}")))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn class_name(id: u32) -> String {
    let prefix = (id >> 24) as u8;
    let (name, widened) = match prefix {
        0x01 => ("gfxobj", false),
        0x02 => ("setup", false),
        0x03 => ("animation", true),
        0x04 => ("palette", false),
        0x05 => ("surface_texture", false),
        0x08 => ("surface", false),
        0x09 => ("motion_table", true),
        0x0A => ("wave", true),
        0x0D => ("environment", false),
        0x0F => ("palette_set", false),
        0x11 => ("degrade_info", true),
        0x20 => ("sound_table", true),
        0x32 => ("particle_emitter", true),
        0x33 => ("physics_script", true),
        0x34 => ("physics_script_table", true),
        _ => ("other", false),
    };
    if widened {
        format!("0x{prefix:02X}_{name}*")
    } else {
        format!("0x{prefix:02X}_{name}")
    }
}

fn is_widened_class(id: u32) -> bool {
    matches!(
        (id >> 24) as u8,
        0x03 | 0x09 | 0x0A | 0x11 | 0x20 | 0x32 | 0x33 | 0x34
    )
}

fn read_hbc7_dir_entry(dir: Option<&Path>, rs_id: u32) -> Option<Vec<u8>> {
    let dir = dir?;
    for name in [format!("0x{rs_id:08X}.hbc7"), format!("{rs_id:08X}.hbc7")] {
        if let Ok(bytes) = std::fs::read(dir.join(&name)) {
            return Some(bytes);
        }
    }
    None
}

/// Full-tier presence AND declared dims. `Some((0, 0))` means "the KTX2 is
/// there but its header did not parse" — presence is still true (the client
/// can fetch it), the dims just fall back to the DAT record's.
fn xu7_entry(dir: Option<&Path>, rs_id: u32) -> Option<(u32, u32)> {
    let dir = dir?;
    for name in [format!("0x{rs_id:08X}.ktx2"), format!("{rs_id:08X}.ktx2")] {
        let path = dir.join(&name);
        if path.is_file() {
            return Some(ktx2_dims(&path).unwrap_or((0, 0)));
        }
    }
    None
}

/// Record tier assignment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tier {
    Inline,
    Regional(u8), // supergrid ordinal (row-major, 8×8 grid of 32×32-LB cells)
    Commons,
}

/// Where a preview payload lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PvwHome {
    Commons,
    Regional(u8),
    Interior(u16),
}

fn supergrid_of_centroid(users_lb: &BTreeSet<(u8, u8)>) -> u8 {
    let (mut sx, mut sy) = (0u32, 0u32);
    for &(x, y) in users_lb {
        sx += x as u32;
        sy += y as u32;
    }
    let n = users_lb.len().max(1) as u32;
    let cx = (sx / n) / SUPERGRID_LBS;
    let cy = (sy / n) / SUPERGRID_LBS;
    (cx * (256 / SUPERGRID_LBS) + cy) as u8
}

/// Deduplicating REFS pack list builder. `pvw_pack_ord` and REFS record
/// edges index into the list this builds.
struct RefsBuilder<'t> {
    table: &'t [PackTableEntry],
    packs: Vec<([u8; 16], u8)>,
    by_ord: HashMap<u16, u8>,
}

impl<'t> RefsBuilder<'t> {
    fn new(table: &'t [PackTableEntry]) -> Self {
        Self { table, packs: Vec::new(), by_ord: HashMap::new() }
    }
    fn local(&mut self, global_ord: u16) -> u8 {
        if let Some(&l) = self.by_ord.get(&global_ord) {
            return l;
        }
        let e = &self.table[global_ord as usize];
        self.packs.push((e.hash16, e.kind));
        let l = (self.packs.len() - 1) as u8;
        self.by_ord.insert(global_ord, l);
        l
    }
}

// ---------------------------------------------------------------------------
// The bake
// ---------------------------------------------------------------------------

struct PerLb {
    /// Outdoor closure (LBInfo statics + buildings + scenery + scripts).
    closure_outdoor: BTreeSet<u32>,
    /// EnvCell-derived closure (environments, cell surfaces, cell statics).
    closure_interior: BTreeSet<u32>,
    /// EnvCell file ids (full 32-bit), sorted, + total record bytes.
    envcells: Vec<u32>,
    envcell_bytes: usize,
    placements: Vec<Placement>,
    has_lbi: bool,
}

impl PerLb {
    fn closure_union(&self) -> impl Iterator<Item = u32> + '_ {
        self.closure_outdoor
            .iter()
            .chain(self.closure_interior.iter())
            .copied()
    }
}

pub fn emit_packs(opts: &PackBakeOptions) -> Result<PackBakeReport> {
    std::fs::create_dir_all(&opts.output_dir).map_err(|e| {
        ToolError::Validation(format!("create output dir {:?}: {e}", opts.output_dir))
    })?;

    let portal = DatDatabase::new(&opts.eor_portal)
        .map_err(|e| ToolError::DatOpen(opts.eor_portal.clone(), e.to_string()))?;
    let cell = DatDatabase::new(&opts.eor_cell)
        .map_err(|e| ToolError::DatOpen(opts.eor_cell.clone(), e.to_string()))?;

    // Patch-id guard (bake-base-dats-only rule: reject 0x__FFxxxx ids).
    // The 0xFFFF____ range is DAT bookkeeping (Iteration record
    // 0xFFFF0001 lives in every base DAT) — only ids whose SECOND byte is
    // 0xFF under a normal type prefix are the patch-injection namespace.
    let patch_ids: Vec<u32> = portal
        .files
        .keys()
        .copied()
        .filter(|id| (id >> 16) & 0xFF == 0xFF && id >> 24 != 0xFF)
        .collect();
    if !patch_ids.is_empty() {
        log::warn!(
            "pack-bake: {} portal record(s) match the 0x__FFxxxx patch-id \
             pattern and are EXCLUDED from pack closure (bake-base-dats-only)",
            patch_ids.len()
        );
    }
    let patch_id_set: HashSet<u32> = patch_ids.iter().copied().collect();

    let source = DatPairSource { portal, cell };

    // Content epoch: low 64 bits of the source sha (deterministic).
    let portal_sha = sha256_file_hex(&opts.eor_portal)?;
    let cell_sha = sha256_file_hex(&opts.eor_cell)?;
    let src_digest: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(portal_sha.as_bytes());
        h.update(cell_sha.as_bytes());
        h.finalize().into()
    };
    let content_epoch = u64::from_le_bytes(src_digest[..8].try_into().unwrap());

    let in_scope = |lbx: u8, lby: u8| -> bool {
        match &opts.regions {
            None => true,
            Some(rs) => rs.iter().any(|r| r.contains(lbx, lby)),
        }
    };

    // --- enumerate in-scope LBs (cell DAT metadata only) -----------------
    let mut lb_envcells: BTreeMap<u16, Vec<(u32, u32)>> = BTreeMap::new();
    let mut lb_present: BTreeSet<u16> = BTreeSet::new();
    for (&fid, entry) in &source.cell.files {
        let lb = (fid >> 16) as u16;
        if !in_scope((lb >> 8) as u8, (lb & 0xFF) as u8) {
            continue;
        }
        match (fid & 0xFFFF) as u16 {
            0xFFFF | 0xFFFE => {
                lb_present.insert(lb);
            }
            0x0100..=0xFFFD => {
                lb_present.insert(lb);
                lb_envcells.entry(lb).or_default().push((fid, entry.size));
            }
            _ => {}
        }
    }
    for v in lb_envcells.values_mut() {
        v.sort_unstable();
    }

    // --- per-LB roots + widened closure (parallel) ------------------------
    // DatDatabase reads are positioned (`read_exact_at_compat`, `&self`), so
    // `source` is Sync and the per-LB walks are independent. Root and surface
    // closures memoize in shared maps: check under lock, walk WITHOUT the
    // lock, insert under lock — a racing pair may walk the same root twice,
    // but both produce the identical sorted Vec, so pack output is unchanged.
    // Byte-identity vs the sequential emitter is the acceptance test.
    use rayon::prelude::*;
    use std::sync::{Arc, Mutex};
    let root_memo: Mutex<HashMap<u32, Arc<Vec<u32>>>> = Mutex::new(HashMap::new());
    let closure_of = |root: u32| -> Arc<Vec<u32>> {
        if let Some(hit) = root_memo.lock().unwrap().get(&root) {
            return hit.clone();
        }
        let mut set: HashSet<(String, u32)> = HashSet::new();
        collect_model_dependencies_widened(&source, root, &mut set);
        let mut ids: Vec<u32> = set.into_iter().map(|(_, id)| id).collect();
        ids.sort_unstable();
        let arc = Arc::new(ids);
        root_memo
            .lock()
            .unwrap()
            .entry(root)
            .or_insert_with(|| arc.clone())
            .clone()
    };
    let surf_memo: Mutex<HashMap<u32, Arc<Vec<u32>>>> = Mutex::new(HashMap::new());
    let surface_closure_of = |did: u32| -> Arc<Vec<u32>> {
        if let Some(hit) = surf_memo.lock().unwrap().get(&did) {
            return hit.clone();
        }
        let mut set: HashSet<(String, u32)> = HashSet::new();
        collect_surface_dependencies(&source, did, &mut set);
        let mut ids: Vec<u32> = set.into_iter().map(|(_, id)| id).collect();
        ids.sort_unstable();
        let arc = Arc::new(ids);
        surf_memo
            .lock()
            .unwrap()
            .entry(did)
            .or_insert_with(|| arc.clone())
            .clone()
    };

    let lb_list: Vec<u16> = lb_present.iter().copied().collect();
    let per_lb_rows: Vec<(u16, PerLb)> = lb_list
        .par_iter()
        .map(|&lb| -> Result<(u16, PerLb)> {
            let mut closure_outdoor: BTreeSet<u32> = BTreeSet::new();
            let mut roots: Vec<u32> = Vec::new();
            let lbi_fid = ((lb as u32) << 16) | 0xFFFE;
            let mut has_lbi = false;
            if let Ok(bytes) =
                source.get_file_by_key(ResourceKey::new(EOR_CELL_NAMESPACE, lbi_fid))
                && let Ok(info) = LandblockInfo::unpack(&bytes)
            {
                has_lbi = true;
                roots.extend(info.objects.iter().map(|s| s.id));
                roots.extend(info.buildings.iter().map(|b| b.model_id));
            }
            let placements = match opts.scenery_dir.as_deref() {
                Some(dir) => read_scenery_lb(dir, lb)?,
                None => Vec::new(),
            };
            roots.extend(placements.iter().map(|p| p.obj_id));
            roots.extend(placements.iter().map(|p| p.script_id).filter(|&s| s != 0));
            roots.sort_unstable();
            roots.dedup();
            for root in roots {
                closure_outdoor.extend(closure_of(root).iter().copied());
            }

            // EnvCell-derived closure. Stab walks share the root memo (same
            // walk, same ids); surface walks memoize per surface DID. The
            // per-envcell scratch-set union of the sequential emitter and
            // these per-root/per-DID unions produce the same BTreeSet.
            let envcells = lb_envcells.get(&lb).cloned().unwrap_or_default();
            let envcell_bytes: usize = envcells.iter().map(|&(_, s)| s as usize).sum();
            let mut closure_interior: BTreeSet<u32> = BTreeSet::new();
            for &(fid, _) in &envcells {
                let Ok(bytes) =
                    source.get_file_by_key(ResourceKey::new(EOR_CELL_NAMESPACE, fid))
                else {
                    continue;
                };
                let Ok(ec) = EnvCell::unpack(&mut std::io::Cursor::new(bytes)) else {
                    continue;
                };
                closure_interior.insert(0x0D00_0000 | ec.environment_id as u32);
                for &s in &ec.surfaces {
                    closure_interior.extend(
                        surface_closure_of(surface_did_for_envcell_index(s))
                            .iter()
                            .copied(),
                    );
                }
                for stab in &ec.static_objects {
                    closure_interior.extend(closure_of(stab.stab_id).iter().copied());
                }
            }

            // Drop patch-pattern ids + ids not present in the portal DAT (the
            // walk records entry ids even when the record is absent).
            let keep = |id: &u32| {
                !patch_id_set.contains(id) && source.portal.files.contains_key(id)
            };
            closure_outdoor.retain(keep);
            closure_interior.retain(keep);

            Ok((
                lb,
                PerLb {
                    closure_outdoor,
                    closure_interior,
                    envcells: envcells.iter().map(|&(f, _)| f).collect(),
                    envcell_bytes,
                    placements,
                    has_lbi,
                },
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    let per_lb: BTreeMap<u16, PerLb> = per_lb_rows.into_iter().collect();
    drop(root_memo);
    drop(surf_memo);

    // --- tiles, interiors, usage counts -----------------------------------
    let tile_of = |lb: u16| -> (u8, u8) { (((lb >> 8) as u8) / 2, ((lb & 0xFF) as u8) / 2) };
    let mut tiles: BTreeMap<(u8, u8), Vec<u16>> = BTreeMap::new();
    for &lb in per_lb.keys() {
        tiles.entry(tile_of(lb)).or_default().push(lb);
    }
    let interiors: BTreeSet<u16> = per_lb
        .iter()
        .filter(|(_, l)| l.envcell_bytes > INTERIOR_SPLIT_BYTES)
        .map(|(&lb, _)| lb)
        .collect();

    let mut rec_tile_users: BTreeMap<u32, BTreeSet<(u8, u8)>> = BTreeMap::new();
    let mut rec_lb_users: BTreeMap<u32, BTreeSet<u16>> = BTreeMap::new();
    for (&lb, l) in &per_lb {
        let t = tile_of(lb);
        for id in l.closure_union() {
            rec_tile_users.entry(id).or_default().insert(t);
            rec_lb_users.entry(id).or_default().insert(lb);
        }
    }

    // --- tier assignment ---------------------------------------------------
    let mut rec_tier: BTreeMap<u32, Tier> = BTreeMap::new();
    for (&id, tile_users) in &rec_tile_users {
        if id >> 24 == 0x06 {
            continue; // TEXREF, never packed
        }
        let tier = if id >> 24 == 0x0D {
            let lbs = &rec_lb_users[&id];
            if lbs.len() <= ENV_INLINE_LBS {
                Tier::Inline
            } else if lbs.len() < ENV_COMMONS_LBS {
                let users: BTreeSet<(u8, u8)> = lbs
                    .iter()
                    .map(|&lb| ((lb >> 8) as u8, (lb & 0xFF) as u8))
                    .collect();
                Tier::Regional(supergrid_of_centroid(&users))
            } else {
                Tier::Commons
            }
        } else if tile_users.len() <= K_INLINE_TILES {
            Tier::Inline
        } else if tile_users.len() < COMMONS_TILES {
            let users: BTreeSet<(u8, u8)> = tile_users
                .iter()
                .map(|&(tx, ty)| (tx * 2 + 1, ty * 2 + 1)) // tile center, LB units
                .collect();
            Tier::Regional(supergrid_of_centroid(&users))
        } else {
            Tier::Commons
        };
        rec_tier.insert(id, tier);
    }

    // --- class/tier byte report (D-12.5) -----------------------------------
    let mut class_tiers: BTreeMap<String, TierBytes> = BTreeMap::new();
    let mut widened_commons_bytes = 0u64;
    for (&id, tier) in &rec_tier {
        let size = source.portal.files.get(&id).map(|e| e.size as u64).unwrap_or(0);
        let row = class_tiers.entry(class_name(id)).or_default();
        row.records += 1;
        match tier {
            Tier::Inline => row.inline_bytes += size,
            Tier::Regional(_) => row.regional_bytes += size,
            Tier::Commons => {
                row.commons_bytes += size;
                if is_widened_class(id) {
                    widened_commons_bytes += size;
                }
            }
        }
    }

    let mut report = PackBakeReport {
        scope: match &opts.regions {
            None => "full-world".into(),
            Some(rs) => rs
                .iter()
                .map(|r| format!("0x{:02X}{:02X}:0x{:02X}{:02X}", r.x0, r.y0, r.x1, r.y1))
                .collect::<Vec<_>>()
                .join(","),
        },
        landblocks: per_lb.len(),
        tiles: tiles.len(),
        interiors: interiors.len(),
        patch_ids_rejected: patch_ids.len(),
        class_tiers,
        widened_commons_bytes,
        ..Default::default()
    };

    // --- TEXREF bits + preview derivation ----------------------------------
    let tex_ids: BTreeSet<u32> = rec_tile_users
        .keys()
        .copied()
        .filter(|id| id >> 24 == 0x06)
        .collect();
    let mut pvw_payloads: BTreeMap<u32, Vec<u8>> = BTreeMap::new();
    let mut tex_bits: BTreeMap<u32, u8> = BTreeMap::new();
    // PAGE-RESAMPLE (T22 D2): the dims a TEXREF row DECLARES are the dims of
    // the tier that actually lands in the texture array — the full tier when
    // one exists, the DAT record otherwise. Resolved once here rather than
    // per emitted row (the row builder runs once per pack that references
    // the rsId).
    let mut tex_declared_dims: BTreeMap<u32, (u32, u32)> = BTreeMap::new();
    for &rs in &tex_ids {
        let mut bits = 0u8;
        let xu7 = xu7_entry(opts.tex_xu7.as_deref(), rs);
        let has_xu7 = xu7.is_some();
        if has_xu7 {
            bits |= tier_bits::FULL_XU7_PRESENT;
        }
        let dat_dims = tex_dims(&source, rs);
        let declared = match xu7 {
            Some((w, h)) if w > 0 && h > 0 => {
                if (w, h) != dat_dims {
                    report.texref_full_tier_dims_differ += 1;
                }
                (w, h)
            }
            _ => dat_dims,
        };
        tex_declared_dims.insert(rs, declared);
        if crate::page_resample::needs_resample_dims(declared.0, declared.1) {
            report.texref_off_page += 1;
            if has_xu7 {
                report.texref_off_page_full_tier += 1;
            } else {
                report.texref_off_page_legacy_only += 1;
            }
            if report.texref_off_page_examples.len() < 32
                && let Some(p) = crate::page_resample::plan_page(declared.0, declared.1)
            {
                report.texref_off_page_examples.push(format!(
                    "0x{rs:08X} {}x{}→{}x{}",
                    declared.0, declared.1, p.page_w, p.page_h
                ));
            }
        } else {
            report.texref_on_page += 1;
            bits |= tier_bits::FULL_PAGE_DIMS;
        }
        let mut sliced: Option<Vec<u8>> = None;
        let mut from = "";
        if let Some(pre) = read_hbc7_dir_entry(opts.tex_bc7_pre.as_deref(), rs)
            && let Some(s) = slice_hbc7_to_cap(&pre, PVW_CAP)
        {
            sliced = Some(s);
            from = "pre";
        }
        let full_blob = read_hbc7_dir_entry(opts.tex_bc7.as_deref(), rs);
        if sliced.is_none()
            && let Some(full) = full_blob.as_deref()
        {
            match slice_hbc7_to_cap(full, PVW_CAP) {
                Some(s) => {
                    sliced = Some(s);
                    from = "full";
                }
                None => report.pvw_unsliceable += 1,
            }
        }
        if sliced.is_none()
            && let Some(extra) = read_hbc7_dir_entry(opts.tex_pvw_extra.as_deref(), rs)
            && let Some(s) = slice_hbc7_to_cap(&extra, PVW_CAP)
        {
            sliced = Some(s);
            from = "extra";
        }
        match sliced {
            Some(s) => {
                match from {
                    "pre" => report.pvw_from_pre += 1,
                    "full" => report.pvw_from_full += 1,
                    _ => report.pvw_from_extra += 1,
                }
                bits |= tier_bits::PVW_PRESENT;
                report.pvw_bytes_total += s.len() as u64;
                pvw_payloads.insert(rs, s);
            }
            None => {
                if has_xu7 || full_blob.is_some() {
                    report.texref_missing_pvw += 1;
                    if has_xu7 {
                        report.pvw_wanted_from_xu7.push(format!("0x{rs:08X}"));
                    }
                } else {
                    report.texref_legacy_only += 1;
                }
            }
        }
        tex_bits.insert(rs, bits);
    }
    report.texref_rows = tex_ids.len();

    // --- preview partition --------------------------------------------------
    let mut pvw_commons: BTreeMap<u32, Vec<u8>> = BTreeMap::new();
    let mut pvw_regional: BTreeMap<u8, BTreeMap<u32, Vec<u8>>> = BTreeMap::new();
    let mut pvw_interior: BTreeMap<u16, BTreeMap<u32, Vec<u8>>> = BTreeMap::new();
    let mut pvw_home: BTreeMap<u32, PvwHome> = BTreeMap::new();
    for (&rs, payload) in &pvw_payloads {
        let lb_users = &rec_lb_users[&rs];
        let home = if lb_users.len() >= PVW_COMMONS_LBS {
            PvwHome::Commons
        } else if lb_users.len() == 1
            && interiors.contains(lb_users.iter().next().unwrap())
        {
            PvwHome::Interior(*lb_users.iter().next().unwrap())
        } else {
            let users: BTreeSet<(u8, u8)> = lb_users
                .iter()
                .map(|&lb| ((lb >> 8) as u8, (lb & 0xFF) as u8))
                .collect();
            PvwHome::Regional(supergrid_of_centroid(&users))
        };
        match home {
            PvwHome::Commons => {
                pvw_commons.insert(rs, payload.clone());
            }
            PvwHome::Regional(g) => {
                pvw_regional.entry(g).or_default().insert(rs, payload.clone());
            }
            PvwHome::Interior(lb) => {
                pvw_interior.entry(lb).or_default().insert(rs, payload.clone());
            }
        }
        pvw_home.insert(rs, home);
    }

    // --- emission -----------------------------------------------------------
    let ns_table: Vec<String> =
        vec![EOR_CELL_NAMESPACE.to_string(), EOR_PORTAL_NAMESPACE.to_string()];
    let ns_cell: u8 = 0;
    let ns_portal: u8 = 1;

    let packs_dir = opts.output_dir.join("packs");
    std::fs::create_dir_all(&packs_dir)
        .map_err(|e| ToolError::Validation(format!("create {packs_dir:?}: {e}")))?;

    let mut pack_table: Vec<PackTableEntry> = Vec::new();
    let mut pack_bytes: Vec<Vec<u8>> = Vec::new();
    let mut section_ratios: BTreeMap<String, SectionRatio> = BTreeMap::new();

    macro_rules! emit_pack {
        ($kind:expr, $origin:expr, $meta:expr, $sections:expr) => {{
            let sections: Vec<SectionOut> = $sections;
            for s in &sections {
                section_ratios
                    .entry(format!("0x{:02X}", s.kind))
                    .or_default()
                    .raw_bytes += s.raw.len() as u64;
            }
            let bytes = pf::write_hbp1(
                $kind,
                $origin,
                &ns_table,
                sections.clone(),
                content_epoch,
                opts.zstd_level,
            )
            .map_err(ToolError::Validation)?;
            if opts.verify_deterministic {
                let again = pf::write_hbp1(
                    $kind,
                    $origin,
                    &ns_table,
                    sections,
                    content_epoch,
                    opts.zstd_level,
                )
                .map_err(ToolError::Validation)?;
                if again != bytes {
                    return Err(ToolError::Validation(format!(
                        "determinism violation: pack kind {} origin {:#x} \
                         re-emitted differently",
                        $kind, $origin
                    )));
                }
            }
            if let Ok(r) = HbpReader::parse(&bytes) {
                for &(k, _, _, stored, _) in &r.sections {
                    section_ratios
                        .entry(format!("0x{k:02X}"))
                        .or_default()
                        .stored_bytes += stored as u64;
                }
            }
            let hash = sha256_trunc16(&bytes);
            let hexname = hex16(&hash);
            let prefix_dir = packs_dir.join(&hexname[..2]);
            std::fs::create_dir_all(&prefix_dir).map_err(|e| {
                ToolError::Validation(format!("create {prefix_dir:?}: {e}"))
            })?;
            let path = prefix_dir.join(format!("{hexname}.hbp"));
            std::fs::write(&path, &bytes)
                .map_err(|e| ToolError::Validation(format!("write {path:?}: {e}")))?;
            let ord = pack_table.len() as u16;
            pack_table.push(PackTableEntry {
                hash16: hash,
                size: bytes.len() as u32,
                kind: $kind,
                meta: $meta,
            });
            pack_bytes.push(bytes);
            ord
        }};
    }

    let get_portal = |id: u32| -> Result<Vec<u8>> {
        source
            .get_file_by_key(ResourceKey::new(EOR_PORTAL_NAMESPACE, id))
            .map_err(|e| ToolError::Validation(format!("portal 0x{id:08X}: {e}")))
    };
    let get_cell = |fid: u32| -> Result<Vec<u8>> {
        source
            .get_file_by_key(ResourceKey::new(EOR_CELL_NAMESPACE, fid))
            .map_err(|e| ToolError::Validation(format!("cell 0x{fid:08X}: {e}")))
    };

    // T13 (ST3): HBG1 GEOM emitter — encode-once memo + census, sections
    // co-located with each pack's model-class records.
    let relief_profile = opts.geom_relief_scale.map(hbg1::ReliefBake::from_scale);
    let mut geom = GeomBaker::new(relief_profile.filter(|r| !r.is_noop()));

    // 1. CORE.
    let mut core_records: BTreeMap<(u8, u32), Vec<u8>> = BTreeMap::new();
    for &id in BOOT_ESSENTIAL_PORTAL_IDS {
        if source.portal.files.contains_key(&id) {
            core_records.insert((ns_portal, id), get_portal(id)?);
        }
    }
    let mut core_sections = vec![SectionOut {
        kind: section_kind::RECORDS,
        codec: codec::ZSTD,
        raw: pf::build_record_stream(&core_records),
    }];
    core_sections.extend(geom.sections_for(&source, core_records.keys().map(|(_, id)| id))?);
    let core_ord = emit_pack!(pack_kind::CORE, 0, 0, core_sections);

    // 2. META-COMMONS.
    let mut commons_records: BTreeMap<(u8, u32), Vec<u8>> = BTreeMap::new();
    for (&id, tier) in &rec_tier {
        if *tier == Tier::Commons && id >> 24 != 0x0D {
            commons_records.insert((ns_portal, id), get_portal(id)?);
        }
    }
    let mut commons_sections = vec![SectionOut {
        kind: section_kind::RECORDS,
        codec: codec::ZSTD,
        raw: pf::build_record_stream(&commons_records),
    }];
    commons_sections
        .extend(geom.sections_for(&source, commons_records.keys().map(|(_, id)| id))?);
    let meta_commons_ord = emit_pack!(pack_kind::META_SHARED, 0, 0, commons_sections);
    report.meta_commons_bytes = pack_table[meta_commons_ord as usize].size as u64;

    // 3. META-REGIONAL.
    let mut regional_map: BTreeMap<u8, BTreeMap<(u8, u32), Vec<u8>>> = BTreeMap::new();
    for (&id, tier) in &rec_tier {
        if let Tier::Regional(g) = tier
            && id >> 24 != 0x0D
        {
            regional_map.entry(*g).or_default().insert((ns_portal, id), get_portal(id)?);
        }
    }
    let mut meta_regional_ords: BTreeMap<u8, u16> = BTreeMap::new();
    for (g, records) in &regional_map {
        let mut regional_sections = vec![SectionOut {
            kind: section_kind::RECORDS,
            codec: codec::ZSTD,
            raw: pf::build_record_stream(records),
        }];
        regional_sections.extend(geom.sections_for(&source, records.keys().map(|(_, id)| id))?);
        let ord = emit_pack!(pack_kind::META_SHARED, *g as u32, *g, regional_sections);
        meta_regional_ords.insert(*g, ord);
    }

    // 4. ENV-COMMONS / ENV-REGIONAL.
    let mut env_commons: BTreeMap<(u8, u32), Vec<u8>> = BTreeMap::new();
    let mut env_regional: BTreeMap<u8, BTreeMap<(u8, u32), Vec<u8>>> = BTreeMap::new();
    for (&id, tier) in &rec_tier {
        if id >> 24 != 0x0D {
            continue;
        }
        match tier {
            Tier::Commons => {
                env_commons.insert((ns_portal, id), get_portal(id)?);
            }
            Tier::Regional(g) => {
                env_regional.entry(*g).or_default().insert((ns_portal, id), get_portal(id)?);
            }
            Tier::Inline => {}
        }
    }
    let env_commons_ord = if env_commons.is_empty() {
        None
    } else {
        let mut env_sections = vec![SectionOut {
            kind: section_kind::RECORDS,
            codec: codec::ZSTD,
            raw: pf::build_record_stream(&env_commons),
        }];
        env_sections.extend(geom.sections_for(&source, env_commons.keys().map(|(_, id)| id))?);
        Some(emit_pack!(pack_kind::ENV, 0, 0, env_sections))
    };
    let mut env_regional_ords: BTreeMap<u8, u16> = BTreeMap::new();
    for (g, records) in &env_regional {
        let mut env_sections = vec![SectionOut {
            kind: section_kind::RECORDS,
            codec: codec::ZSTD,
            raw: pf::build_record_stream(records),
        }];
        env_sections.extend(geom.sections_for(&source, records.keys().map(|(_, id)| id))?);
        let ord = emit_pack!(pack_kind::ENV, *g as u32, *g, env_sections);
        env_regional_ords.insert(*g, ord);
    }

    // 5. PVW-COMMONS / PVW-REGIONAL.
    let pvw_commons_ord = if pvw_commons.is_empty() {
        None
    } else {
        Some(emit_pack!(
            pack_kind::PREVIEW,
            0,
            0,
            vec![SectionOut {
                kind: section_kind::PVW,
                codec: codec::RAW, // BC7 ≈ incompressible
                raw: pf::build_pvw_stream(&pvw_commons),
            }]
        ))
    };
    let mut pvw_regional_ords: BTreeMap<u8, u16> = BTreeMap::new();
    for (g, payloads) in &pvw_regional {
        let ord = emit_pack!(
            pack_kind::PREVIEW,
            *g as u32,
            *g,
            vec![SectionOut {
                kind: section_kind::PVW,
                codec: codec::RAW,
                raw: pf::build_pvw_stream(payloads),
            }]
        );
        pvw_regional_ords.insert(*g, ord);
    }

    // 6. Terrain t128 slices (D-12.6).
    let mut terrain_ords: Vec<(u8, u16)> = Vec::new();
    if let Some(tdir) = opts.terrain_bc7_dir.as_deref() {
        for (channel, pkind, skind) in [
            ("color", pack_kind::TERRAIN_SLICE_COLOR, shared_kind::TERRAIN_T128_COLOR),
            ("nra", pack_kind::TERRAIN_SLICE_NRA, shared_kind::TERRAIN_T128_NRA),
        ] {
            let suffix = format!("_{channel}.hbc7");
            let mut names: Vec<PathBuf> = std::fs::read_dir(tdir)
                .map_err(|e| ToolError::Validation(format!("read {tdir:?}: {e}")))?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.ends_with(&suffix))
                        .unwrap_or(false)
                })
                .collect();
            names.sort();
            let mut entries: BTreeMap<u32, Vec<u8>> = BTreeMap::new();
            for path in names {
                let stem = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default()
                    .trim_end_matches(&suffix)
                    .to_string();
                let rs = parse_hex_u32(&stem).map_err(ToolError::Validation)?;
                let bytes = std::fs::read(&path)
                    .map_err(|e| ToolError::Validation(format!("read {path:?}: {e}")))?;
                let Some(sliced) = slice_hbc7_to_cap(&bytes, PVW_CAP) else {
                    return Err(ToolError::Validation(format!(
                        "terrain payload {path:?} has no ≤{PVW_CAP} level — \
                         t128 slicing needs the full t1024 mip chain"
                    )));
                };
                entries.insert(rs, sliced);
            }
            if entries.is_empty() {
                return Err(ToolError::Validation(format!(
                    "terrain dir {tdir:?} has no *{suffix} payloads"
                )));
            }
            let raw = pf::build_pvw_stream(&entries);
            let ord = emit_pack!(
                pkind,
                0,
                0,
                vec![SectionOut { kind: section_kind::PVW, codec: codec::RAW, raw }]
            );
            let size = pack_table[ord as usize].size as u64;
            if channel == "color" {
                report.terrain_slice_color_bytes = size;
            } else {
                report.terrain_slice_nra_bytes = size;
            }
            terrain_ords.push((skind, ord));
        }
    }

    // Shared helpers over the emitted shared packs.
    let shared_ord_for = |id: u32, tier: &Tier| -> Option<u16> {
        match tier {
            Tier::Inline => None,
            Tier::Commons => Some(if id >> 24 == 0x0D {
                env_commons_ord.expect("env commons pack exists")
            } else {
                meta_commons_ord
            }),
            Tier::Regional(g) => Some(if id >> 24 == 0x0D {
                env_regional_ords[g]
            } else {
                meta_regional_ords[g]
            }),
        }
    };

    // TEXREF row builder shared by tile + interior emission.
    // `self_lb`: Some(lb) while building THAT interior pack (its own PVW
    // section resolves as PVW_ORD_SELF).
    let build_texref_rows = |ids: &BTreeSet<u32>,
                             self_lb: Option<u16>,
                             refs: &mut RefsBuilder,
                             interior_ords: &BTreeMap<u16, u16>|
     -> Vec<TexRefRow> {
        let mut rows: Vec<TexRefRow> = Vec::new();
        for &rs in ids {
            if rs >> 24 != 0x06 {
                continue;
            }
            let bits = tex_bits.get(&rs).copied().unwrap_or(0);
            let ord = if bits & tier_bits::PVW_PRESENT == 0 {
                pf::PVW_ORD_NONE
            } else {
                match pvw_home.get(&rs) {
                    Some(PvwHome::Commons) => {
                        refs.local(pvw_commons_ord.expect("pvw commons exists")) as u16
                    }
                    Some(PvwHome::Regional(g)) => refs.local(pvw_regional_ords[g]) as u16,
                    Some(PvwHome::Interior(lb)) => {
                        if self_lb == Some(*lb) {
                            pf::PVW_ORD_SELF
                        } else {
                            // Single-user previews are only referenced by
                            // their own interior LB; a cross-reference can
                            // only appear from that LB's own tile, whose
                            // interior pack is already emitted.
                            match interior_ords.get(lb) {
                                Some(&iord) => refs.local(iord) as u16,
                                None => pf::PVW_ORD_NONE,
                            }
                        }
                    }
                    None => pf::PVW_ORD_NONE,
                }
            };
            let (w, h) = tex_declared_dims.get(&rs).copied().unwrap_or((0, 0));
            rows.push(TexRefRow {
                rs_id: rs,
                tier_bits: bits,
                pvw_pack_ord: ord,
                dims: dims_byte(w, h),
            });
        }
        rows.sort_by_key(|r| r.rs_id);
        rows
    };

    // 7. Interior packs.
    let mut interior_ords: BTreeMap<u16, u16> = BTreeMap::new();
    for &lb in &interiors {
        let l = &per_lb[&lb];
        let mut envcell_records: BTreeMap<(u8, u32), Vec<u8>> = BTreeMap::new();
        for &fid in &l.envcells {
            envcell_records.insert((ns_cell, fid), get_cell(fid)?);
        }
        let mut inline_records: BTreeMap<(u8, u32), Vec<u8>> = BTreeMap::new();
        let mut refs = RefsBuilder::new(&pack_table);
        let mut ref_records: Vec<(u8, u32, u8)> = Vec::new();
        for &id in &l.closure_interior {
            if id >> 24 == 0x06 {
                continue;
            }
            let Some(tier) = rec_tier.get(&id) else { continue };
            match shared_ord_for(id, tier) {
                None => {
                    inline_records.insert((ns_portal, id), get_portal(id)?);
                }
                Some(ord) => {
                    let local = refs.local(ord);
                    ref_records.push((ns_portal, id, local));
                }
            }
        }
        let tex_set: BTreeSet<u32> = l
            .closure_interior
            .iter()
            .copied()
            .filter(|id| id >> 24 == 0x06)
            .collect();
        let texref_rows =
            build_texref_rows(&tex_set, Some(lb), &mut refs, &interior_ords);
        ref_records.sort_unstable();

        let mut sections = vec![
            SectionOut {
                kind: section_kind::ENVCELLS,
                codec: codec::ZSTD,
                raw: pf::build_record_stream(&envcell_records),
            },
            SectionOut {
                kind: section_kind::REFS,
                codec: codec::RAW,
                raw: pf::build_refs(&RefsSection {
                    packs: refs.packs.clone(),
                    records: ref_records,
                })
                .map_err(ToolError::Validation)?,
            },
            SectionOut {
                kind: section_kind::TEXREF,
                codec: codec::RAW,
                raw: pf::build_texref(&texref_rows),
            },
        ];
        if !inline_records.is_empty() {
            sections.push(SectionOut {
                kind: section_kind::RECORDS,
                codec: codec::ZSTD,
                raw: pf::build_record_stream(&inline_records),
            });
        }
        sections.extend(geom.sections_for(&source, inline_records.keys().map(|(_, id)| id))?);
        if let Some(pvw) = pvw_interior.get(&lb) {
            sections.push(SectionOut {
                kind: section_kind::PVW,
                codec: codec::RAW,
                raw: pf::build_pvw_stream(pvw),
            });
        }
        let ord = emit_pack!(pack_kind::INTERIOR, lb as u32, 0, sections);
        interior_ords.insert(lb, ord);
    }

    // 8. Tile packs.
    let boot_ring: BTreeSet<(u8, u8)> = {
        let bx = ((opts.boot_landblock >> 8) & 0xFF) as i32;
        let by = (opts.boot_landblock & 0xFF) as i32;
        let mut s = BTreeSet::new();
        for dx in -5i32..=5 {
            for dy in -5i32..=5 {
                let (x, y) = (bx + dx, by + dy);
                if (0..=255).contains(&x) && (0..=255).contains(&y) {
                    s.insert(((x as u8) / 2, (y as u8) / 2));
                }
            }
        }
        s
    };

    let mut ring_tex: BTreeSet<u32> = BTreeSet::new();
    let mut tile_ords: BTreeMap<(u8, u8), u16> = BTreeMap::new();
    for (tile, _) in &tiles {
        let (tx, ty) = *tile;
        let tile_lbs: [u16; 4] = [
            ((tx as u16 * 2) << 8) | (ty as u16 * 2),
            ((tx as u16 * 2) << 8) | (ty as u16 * 2 + 1),
            (((tx as u16 * 2) + 1) << 8) | (ty as u16 * 2),
            (((tx as u16 * 2) + 1) << 8) | (ty as u16 * 2 + 1),
        ];

        // TERRAIN (4 × 252 B fixed, zero-filled where absent).
        let mut terrain = Vec::with_capacity(4 * 252);
        for &lb in &tile_lbs {
            let fid = ((lb as u32) << 16) | 0xFFFF;
            match source.get_file_by_key(ResourceKey::new(EOR_CELL_NAMESPACE, fid)) {
                Ok(bytes) if bytes.len() == 252 => terrain.extend_from_slice(&bytes),
                Ok(bytes) => {
                    return Err(ToolError::Validation(format!(
                        "terrain 0x{fid:08X} is {} bytes (expected 252)",
                        bytes.len()
                    )));
                }
                Err(_) => terrain.extend(std::iter::repeat_n(0u8, 252)),
            }
        }

        // LBINFO.
        let mut lbinfo: BTreeMap<(u8, u32), Vec<u8>> = BTreeMap::new();
        for &lb in &tile_lbs {
            if per_lb.get(&lb).map(|l| l.has_lbi).unwrap_or(false) {
                let fid = ((lb as u32) << 16) | 0xFFFE;
                lbinfo.insert((ns_cell, fid), get_cell(fid)?);
            }
        }

        // Small EnvCell sets ride the tile pack.
        let mut envcells: BTreeMap<(u8, u32), Vec<u8>> = BTreeMap::new();
        for &lb in &tile_lbs {
            if interiors.contains(&lb) {
                continue;
            }
            if let Some(l) = per_lb.get(&lb) {
                for &fid in &l.envcells {
                    envcells.insert((ns_cell, fid), get_cell(fid)?);
                }
            }
        }

        // PLACEMENTS: 16 B preamble (4 × u32 per-LB counts) + 44 B rows,
        // preceded by the total-count u32.
        let mut placements_raw = Vec::new();
        let total_rows: usize = tile_lbs
            .iter()
            .map(|lb| per_lb.get(lb).map(|l| l.placements.len()).unwrap_or(0))
            .sum();
        placements_raw.extend_from_slice(&(total_rows as u32).to_le_bytes());
        for &lb in &tile_lbs {
            let n = per_lb.get(&lb).map(|l| l.placements.len()).unwrap_or(0);
            placements_raw.extend_from_slice(&(n as u32).to_le_bytes());
        }
        for &lb in &tile_lbs {
            let Some(l) = per_lb.get(&lb) else { continue };
            for p in &l.placements {
                placements_raw.extend_from_slice(&p.obj_id.to_le_bytes());
                for v in p.pos {
                    placements_raw.extend_from_slice(&v.to_le_bytes());
                }
                for v in p.quat {
                    placements_raw.extend_from_slice(&v.to_le_bytes());
                }
                placements_raw.extend_from_slice(&p.scale.to_le_bytes());
                placements_raw.extend_from_slice(&p.cell_xy.to_le_bytes());
                placements_raw.extend_from_slice(&p.obj_idx.to_le_bytes());
                placements_raw.extend_from_slice(&0u32.to_le_bytes()); // reserved
            }
        }

        // SPAWNS/EVENTS: 16 B preamble (4 × u32 byte lengths) + verbatim
        // JSONL per LB in tile order.
        let side_section = |dir: Option<&Path>, suffix: &str| -> Vec<u8> {
            let bodies: Vec<Vec<u8>> =
                tile_lbs.iter().map(|&lb| read_side_jsonl(dir, lb, suffix)).collect();
            let mut raw = Vec::new();
            for b in &bodies {
                raw.extend_from_slice(&(b.len() as u32).to_le_bytes());
            }
            for b in &bodies {
                raw.extend_from_slice(b);
            }
            raw
        };
        let spawns_raw = side_section(opts.spawns_dir.as_deref(), "spawns");
        let events_raw = side_section(opts.events_dir.as_deref(), "events");

        // Tile closure: outdoor closure of all 4 LBs + interior closure of
        // NON-interior LBs (interiors carry their own).
        let mut closure: BTreeSet<u32> = BTreeSet::new();
        for &lb in &tile_lbs {
            if let Some(l) = per_lb.get(&lb) {
                closure.extend(l.closure_outdoor.iter().copied());
                if !interiors.contains(&lb) {
                    closure.extend(l.closure_interior.iter().copied());
                }
            }
        }

        let mut inline_records: BTreeMap<(u8, u32), Vec<u8>> = BTreeMap::new();
        let mut refs = RefsBuilder::new(&pack_table);
        let mut ref_records: Vec<(u8, u32, u8)> = Vec::new();
        for &id in &closure {
            if id >> 24 == 0x06 {
                continue;
            }
            let Some(tier) = rec_tier.get(&id) else { continue };
            match shared_ord_for(id, tier) {
                None => {
                    inline_records.insert((ns_portal, id), get_portal(id)?);
                }
                Some(ord) => {
                    let local = refs.local(ord);
                    ref_records.push((ns_portal, id, local));
                }
            }
        }
        // Interior packs of this tile join REFS (locator convenience).
        for &lb in &tile_lbs {
            if let Some(&iord) = interior_ords.get(&lb) {
                refs.local(iord);
            }
        }

        let tex_set: BTreeSet<u32> =
            closure.iter().copied().filter(|id| id >> 24 == 0x06).collect();
        if boot_ring.contains(tile) {
            ring_tex.extend(tex_set.iter().copied());
        }
        let texref_rows = build_texref_rows(&tex_set, None, &mut refs, &interior_ords);
        ref_records.sort_unstable();

        let mut sections = vec![
            SectionOut { kind: section_kind::TERRAIN, codec: codec::ZSTD, raw: terrain },
            SectionOut {
                kind: section_kind::REFS,
                codec: codec::RAW,
                raw: pf::build_refs(&RefsSection {
                    packs: refs.packs.clone(),
                    records: ref_records,
                })
                .map_err(ToolError::Validation)?,
            },
            SectionOut {
                kind: section_kind::TEXREF,
                codec: codec::RAW,
                raw: pf::build_texref(&texref_rows),
            },
        ];
        if !lbinfo.is_empty() {
            sections.push(SectionOut {
                kind: section_kind::LBINFO,
                codec: codec::ZSTD,
                raw: pf::build_record_stream(&lbinfo),
            });
        }
        if !envcells.is_empty() {
            sections.push(SectionOut {
                kind: section_kind::ENVCELLS,
                codec: codec::ZSTD,
                raw: pf::build_record_stream(&envcells),
            });
        }
        if total_rows > 0 {
            sections.push(SectionOut {
                kind: section_kind::PLACEMENTS,
                codec: codec::ZSTD,
                raw: placements_raw,
            });
        }
        if spawns_raw.len() > 16 {
            sections.push(SectionOut {
                kind: section_kind::SPAWNS,
                codec: codec::ZSTD,
                raw: spawns_raw,
            });
        }
        if events_raw.len() > 16 {
            sections.push(SectionOut {
                kind: section_kind::EVENTS,
                codec: codec::ZSTD,
                raw: events_raw,
            });
        }
        if !inline_records.is_empty() {
            sections.push(SectionOut {
                kind: section_kind::RECORDS,
                codec: codec::ZSTD,
                raw: pf::build_record_stream(&inline_records),
            });
        }
        sections.extend(geom.sections_for(&source, inline_records.keys().map(|(_, id)| id))?);
        let origin = ((tx as u32) << 8) | ty as u32;
        let ord = emit_pack!(pack_kind::TILE, origin, 0, sections);
        tile_ords.insert(*tile, ord);
        if boot_ring.contains(tile) {
            report.ring_tiles += 1;
            report.ring_tile_pack_bytes += pack_table[ord as usize].size as u64;
        }
    }

    // Ring preview re-score (POST-coverage corpus — F-11.16).
    report.ring_preview_bytes = ring_tex
        .iter()
        .filter_map(|rs| pvw_payloads.get(rs))
        .map(|p| p.len() as u64)
        .sum();

    // --- HBSI1 --------------------------------------------------------------
    let mut tile_grid = vec![pf::TILE_EMPTY; 128 * 128];
    for (&(tx, ty), &ord) in &tile_ords {
        tile_grid[tx as usize * 128 + ty as usize] = ord;
    }
    let mut shared: Vec<(u8, u8, u16)> = vec![
        (shared_kind::CORE, 0, core_ord),
        (shared_kind::META_COMMONS, 0, meta_commons_ord),
    ];
    for (g, ord) in &meta_regional_ords {
        shared.push((shared_kind::META_REGIONAL, *g, *ord));
    }
    if let Some(ord) = env_commons_ord {
        shared.push((shared_kind::ENV_COMMONS, 0, ord));
    }
    for (g, ord) in &env_regional_ords {
        shared.push((shared_kind::ENV_REGIONAL, *g, *ord));
    }
    if let Some(ord) = pvw_commons_ord {
        shared.push((shared_kind::PVW_COMMONS, 0, ord));
    }
    for (g, ord) in &pvw_regional_ords {
        shared.push((shared_kind::PVW_REGIONAL, *g, *ord));
    }
    for (skind, ord) in &terrain_ords {
        shared.push((*skind, 0, *ord));
    }
    shared.sort_unstable();

    let index = SpatialIndex {
        epoch: (content_epoch & 0xFFFF_FFFF) as u32,
        packs: pack_table.clone(),
        tile_grid,
        interiors: interior_ords.iter().map(|(&lb, &ord)| (lb, ord)).collect(),
        shared,
    };
    let index_bytes = pf::write_hbsi1(&index).map_err(ToolError::Validation)?;
    let index_hash = sha256_trunc16(&index_bytes);
    let index_hex = hex16(&index_hash);
    let index_dir = opts.output_dir.join("index");
    std::fs::create_dir_all(&index_dir)
        .map_err(|e| ToolError::Validation(format!("create {index_dir:?}: {e}")))?;
    let index_url = format!("index/{index_hex}.bin");
    std::fs::write(opts.output_dir.join(&index_url), &index_bytes)
        .map_err(|e| ToolError::Validation(format!("write index: {e}")))?;

    // --- manifest: additive v2+ fields --------------------------------------
    let manifest_path = opts.output_dir.join("manifest.json");
    let manifest_text = std::fs::read_to_string(&manifest_path).map_err(|e| {
        ToolError::Validation(format!(
            "read {manifest_path:?}: {e} — the pack emitter amends an existing \
             v2 manifest; run with --legacy-layers (or bake the legacy layers \
             first) so manifest.json exists"
        ))
    })?;
    let mut manifest: ManifestV2 = serde_json::from_str(&manifest_text)
        .map_err(|e| ToolError::Validation(format!("parse {manifest_path:?}: {e}")))?;
    manifest.world_index = Some(WorldIndexRef {
        url: index_url,
        size: index_bytes.len() as u64,
        sha256_16: index_hex,
    });
    manifest.pack_url_template = Some(DEFAULT_PACK_URL_TEMPLATE.to_string());
    let json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| ToolError::Validation(format!("serialize manifest: {e}")))?;
    std::fs::write(&manifest_path, &json)
        .map_err(|e| ToolError::Validation(format!("write {manifest_path:?}: {e}")))?;

    // --- bake-source.sha256 provenance --------------------------------------
    let mut prov = String::new();
    prov.push_str("# bake-source provenance (pack bake T10)\n");
    prov.push_str(&format!("{portal_sha}  {}\n", opts.eor_portal.display()));
    prov.push_str(&format!("{cell_sha}  {}\n", opts.eor_cell.display()));
    for (label, dir) in [
        ("scenery-dir", &opts.scenery_dir),
        ("spawns-dir", &opts.spawns_dir),
        ("events-dir", &opts.events_dir),
        ("tex-bc7", &opts.tex_bc7),
        ("tex-bc7-pre", &opts.tex_bc7_pre),
        ("tex-xu7", &opts.tex_xu7),
        ("tex-pvw-extra", &opts.tex_pvw_extra),
        ("terrain-bc7-dir", &opts.terrain_bc7_dir),
    ] {
        if let Some(d) = dir {
            prov.push_str(&format!("{label}\t{}\n", d.display()));
        }
    }
    std::fs::write(opts.output_dir.join("bake-source.sha256"), prov)
        .map_err(|e| ToolError::Validation(format!("write bake-source.sha256: {e}")))?;

    // --- report totals -------------------------------------------------------
    report.packs_emitted = pack_table.len();
    report.pack_bytes_total = pack_table.iter().map(|p| p.size as u64).sum();
    report.index_bytes = index_bytes.len() as u64;
    report.section_ratios = section_ratios;
    for p in &pack_table {
        let name = match p.kind {
            pack_kind::TILE => "tile",
            pack_kind::INTERIOR => "interior",
            pack_kind::META_SHARED => "meta-shared",
            pack_kind::PREVIEW => "preview",
            pack_kind::ENV => "env",
            pack_kind::CORE => "core",
            pack_kind::TERRAIN_SLICE_COLOR => "terrain-t128-color",
            pack_kind::TERRAIN_SLICE_NRA => "terrain-t128-nra",
            _ => "unknown",
        };
        let row = report.packs_by_kind.entry(name.to_string()).or_insert((0, 0));
        row.0 += 1;
        row.1 += p.size as u64;
    }
    report.determinism_verified = opts.verify_deterministic;
    report.geom_rows = geom.rows;
    report.geom_bytes_raw = geom.bytes_raw;
    report.geom_soft_cap_hits = geom.soft_cap_hits;
    report.geom_max_payload_bytes = geom.max_payload;
    report.geom_relief_variant = geom
        .relief
        .as_ref()
        .map(|r| r.variant_key())
        .unwrap_or_default();
    report.geom_relief_rows = geom.relief_rows;
    report.geom_relief_bytes_raw = geom.relief_bytes_raw;
    report.geom_relief_models_changed = geom.relief_changed;
    report.geom_relief_models_identical = geom.relief_identical;
    report.geom_relief_added_tris = geom.relief_added_tris;
    report.geom_relief_max_payload_bytes = geom.relief_max_payload;

    if opts.verify_closure {
        verify_closure(&pack_table, &pack_bytes, &index)?;
        verify_geom(&pack_bytes)?;
        verify_texref_pages(&pack_bytes)?;
        report.closure_verified = true;
    }

    // PAGE-RESAMPLE gate (T22 D2). Off by default: a pre-resample corpus
    // legitimately fails it, and the census counters above report the
    // position either way. On, it is the acceptance test for a bake over a
    // page-resampled corpus.
    if opts.require_page_dims && report.texref_off_page_full_tier > 0 {
        return Err(ToolError::Validation(format!(
            "PAGE-RESAMPLE: {} of {} TEXREF rows WITH A FULL TIER are stored OFF \
             their array page (e.g. {}) — re-encode the corpus through \
             `page-resample` first. ({} further rows are legacy-lane, no full tier \
             to resample; those are reported, not gated.)",
            report.texref_off_page_full_tier,
            report.texref_rows,
            report.texref_off_page_examples.join(", "),
            report.texref_off_page_legacy_only,
        )));
    }

    let report_json = serde_json::to_string_pretty(&report)
        .map_err(|e| ToolError::Validation(format!("serialize report: {e}")))?;
    std::fs::write(opts.output_dir.join("pack-report.json"), report_json)
        .map_err(|e| ToolError::Validation(format!("write pack-report.json: {e}")))?;

    Ok(report)
}

/// PAGE-RESAMPLE (T22 D2) — re-open every emitted pack and check the TEXREF
/// rows' PAGE contract against the bytes actually written:
///
/// (a) when `FULL_PAGE_DIMS` is set, the row's own `dims` byte decodes to a
///     legal array page (square pow2 in [256², 2048²]) — so a consumer can
///     trust the bit and the byte together. The implication is ONE-WAY on
///     purpose: the byte is 4 bits per axis of `ceil(log2)`, so an off-page
///     NON-POW2 member (1096² in the shipped corpus) rounds to 2^11 x 2^11
///     and is indistinguishable from a real 2048² page. The BIT is the
///     authority; the byte alone cannot be;
/// (b) the same rsId never carries two different `(tier_bits, dims)` across
///     packs — TEXREF rows are replicated into every pack that references the
///     rsId, and a disagreement would make class identity pack-dependent,
///     which is precisely the thing the page tier exists to prevent.
///
/// This is an EMITTER check, not a corpus check: it stays green on a
/// pre-resample bake (where the bit is simply clear on off-page rows). The
/// corpus gate is `require_page_dims`.
fn verify_texref_pages(pack_bytes: &[Vec<u8>]) -> Result<()> {
    use crate::page_resample::{PAGE_TIER_MAX, PAGE_TIER_MIN};
    let mut seen: HashMap<u32, (u8, u8)> = HashMap::new();
    let mut failures: Vec<String> = Vec::new();
    for (i, bytes) in pack_bytes.iter().enumerate() {
        let reader = HbpReader::parse(bytes)
            .map_err(|e| ToolError::Validation(format!("texref re-parse pack {i}: {e}")))?;
        let Some(payload) = reader
            .section(section_kind::TEXREF)
            .map_err(|e| ToolError::Validation(format!("texref section pack {i}: {e}")))?
        else {
            continue;
        };
        let rows = pf::parse_texref(&payload)
            .map_err(|e| ToolError::Validation(format!("texref parse pack {i}: {e}")))?;
        for r in rows {
            let (lw, lh) = ((r.dims >> 4) as u32, (r.dims & 0x0F) as u32);
            let on_page = lw == lh
                && (PAGE_TIER_MIN..=PAGE_TIER_MAX).contains(&lw);
            let bit = r.tier_bits & tier_bits::FULL_PAGE_DIMS != 0;
            if bit && !on_page && failures.len() < 20 {
                failures.push(format!(
                    "0x{:08X}: FULL_PAGE_DIMS set but dims byte 0x{:02X} decodes to \
                     2^{lw} x 2^{lh}, which is not a legal array page",
                    r.rs_id, r.dims
                ));
            }
            match seen.entry(r.rs_id) {
                std::collections::hash_map::Entry::Vacant(e) => {
                    e.insert((r.tier_bits, r.dims));
                }
                std::collections::hash_map::Entry::Occupied(e) => {
                    if *e.get() != (r.tier_bits, r.dims) && failures.len() < 20 {
                        failures.push(format!(
                            "0x{:08X}: TEXREF disagrees across packs — {:?} vs {:?}",
                            r.rs_id,
                            e.get(),
                            (r.tier_bits, r.dims)
                        ));
                    }
                }
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(ToolError::Validation(format!(
            "PAGE-RESAMPLE TEXREF verification failed ({} shown):\n  {}",
            failures.len(),
            failures.join("\n  ")
        )))
    }
}

/// T13 (ST3) — HBG1 GEOM emission (SPEC §1.2, pass 4 D-04.2): one payload
/// per model-class record (0x01 kind-0, 0x02 kind-1, 0x0D kind-2), memoized
/// across packs (an INLINE record repeats in every tile pack that uses it —
/// the payload must be byte-identical, and encode-once keeps the bake cheap).
/// Parse/encode failures fail the bake LOUDLY (base-DAT records must encode;
/// a physics-only GfxObj legitimately encodes to an empty mesh).
struct GeomBaker {
    memo: HashMap<u32, std::sync::Arc<Vec<u8>>>,
    rows: usize,
    bytes_raw: u64,
    soft_cap_hits: usize,
    max_payload: usize,
    /// RELIEF-IN-BAKE — `Some` enables the variant pass.
    relief: Option<hbg1::ReliefBake>,
    /// Model id → relief-variant payload, or `None` when the profile leaves
    /// that model byte-identical (no variant row is written for those, so an
    /// absent GEOMR row reads as "relief is a no-op here").
    relief_memo: HashMap<u32, Option<std::sync::Arc<Vec<u8>>>>,
    relief_rows: usize,
    relief_bytes_raw: u64,
    relief_changed: usize,
    relief_identical: usize,
    relief_added_tris: u64,
    relief_max_payload: usize,
}

impl GeomBaker {
    fn new(relief: Option<hbg1::ReliefBake>) -> Self {
        GeomBaker {
            memo: HashMap::new(),
            rows: 0,
            bytes_raw: 0,
            soft_cap_hits: 0,
            max_payload: 0,
            relief,
            relief_memo: HashMap::new(),
            relief_rows: 0,
            relief_bytes_raw: 0,
            relief_changed: 0,
            relief_identical: 0,
            relief_added_tris: 0,
            relief_max_payload: 0,
        }
    }

    fn payload_for(
        &mut self,
        source: &DatPairSource,
        id: u32,
    ) -> Result<Option<std::sync::Arc<Vec<u8>>>> {
        if !matches!((id >> 24) as u8, 0x01 | 0x02 | 0x0D) {
            return Ok(None);
        }
        if let Some(hit) = self.memo.get(&id) {
            return Ok(Some(hit.clone()));
        }
        let bytes = source
            .get_file_by_key(ResourceKey::new(EOR_PORTAL_NAMESPACE, id))
            .map_err(|e| ToolError::Validation(format!("GEOM 0x{id:08X}: read: {e}")))?;
        let payload = match (id >> 24) as u8 {
            0x01 => {
                let gfx = holtburger_dat::file_type::GfxObj::unpack(
                    &mut std::io::Cursor::new(&bytes),
                )
                .map_err(|e| {
                    ToolError::Validation(format!("GEOM 0x{id:08X}: GfxObj parse: {e}"))
                })?;
                hbg1::encode_gfx_part(&gfx)
            }
            0x02 => {
                let setup = holtburger_dat::file_type::SetupModel::unpack(
                    &mut std::io::Cursor::new(&bytes),
                )
                .map_err(|e| {
                    ToolError::Validation(format!("GEOM 0x{id:08X}: Setup parse: {e}"))
                })?;
                hbg1::encode_setup_directory(source, &setup)
            }
            _ => {
                let env = holtburger_dat::file_type::Environment::unpack(
                    &mut std::io::Cursor::new(&bytes),
                )
                .map_err(|e| {
                    ToolError::Validation(format!("GEOM 0x{id:08X}: Environment parse: {e}"))
                })?;
                hbg1::encode_env_directory(&env)
            }
        }
        .map_err(|e| ToolError::Validation(format!("GEOM 0x{id:08X}: encode: {e}")))?;
        if payload.len() > hbg1::MESH_PAYLOAD_SOFT {
            self.soft_cap_hits += 1;
        }
        if payload.len() > self.max_payload {
            self.max_payload = payload.len();
        }
        let arc = std::sync::Arc::new(payload);
        self.memo.insert(id, arc.clone());
        Ok(Some(arc))
    }

    /// RELIEF-IN-BAKE — the relief VARIANT payload for one 0x01 model id, or
    /// `None` when the profile leaves it byte-identical (so no row is
    /// written). Only kind-0 GfxObj parts have a variant:
    ///
    /// * kind-1 SETUP directories carry no vertex data at all (part DIDs +
    ///   frames), so they are variant-invariant by construction — the fused
    ///   model picks up relief through its PARTS.
    /// * kind-2 ENV directories are per-CELLSTRUCT while the runtime's
    ///   interior rails (OP3) are computed from the per-CELL resolved surface
    ///   palette (`append_environment_tris`, lib.rs "OP3 — material rails on
    ///   interiors": `ModelTopology::build(&cell.polygons, surfaces, ...)`
    ///   where `surfaces` is the EnvCell's own DID list). Two slots can resolve
    ///   to the same DID in one cell and differ in another, so a material
    ///   boundary is not a cellstruct fact. Deferred with a designed shape (the
    ///   T13-D4 pattern: emit rails tagged with their slot PAIR and drop them
    ///   per cell when the pair resolves equal) — recorded in the task report.
    fn relief_payload_for(
        &mut self,
        source: &DatPairSource,
        id: u32,
    ) -> Result<Option<std::sync::Arc<Vec<u8>>>> {
        let Some(relief) = self.relief else { return Ok(None) };
        if (id >> 24) as u8 != 0x01 {
            return Ok(None);
        }
        if let Some(hit) = self.relief_memo.get(&id) {
            return Ok(hit.clone());
        }
        let base = match self.payload_for(source, id)? {
            Some(b) => b,
            None => return Ok(None),
        };
        let bytes = source
            .get_file_by_key(ResourceKey::new(EOR_PORTAL_NAMESPACE, id))
            .map_err(|e| ToolError::Validation(format!("GEOMR 0x{id:08X}: read: {e}")))?;
        let gfx = holtburger_dat::file_type::GfxObj::unpack(&mut std::io::Cursor::new(&bytes))
            .map_err(|e| {
                ToolError::Validation(format!("GEOMR 0x{id:08X}: GfxObj parse: {e}"))
            })?;
        let variant = hbg1::encode_gfx_part_relief(&gfx, &relief)
            .map_err(|e| ToolError::Validation(format!("GEOMR 0x{id:08X}: encode: {e}")))?;
        let entry = if variant == *base.as_ref() {
            self.relief_identical += 1;
            None
        } else {
            self.relief_changed += 1;
            let dm = hbg1::Hbg1Mesh::parse(&variant).map_err(|e| {
                ToolError::Validation(format!("GEOMR 0x{id:08X}: variant re-parse: {e}"))
            })?;
            let bm = hbg1::Hbg1Mesh::parse(base.as_ref()).map_err(|e| {
                ToolError::Validation(format!("GEOM 0x{id:08X}: base re-parse: {e}"))
            })?;
            self.relief_added_tris += (dm.index_count.saturating_sub(bm.index_count) / 3) as u64;
            if variant.len() > self.relief_max_payload {
                self.relief_max_payload = variant.len();
            }
            Some(std::sync::Arc::new(variant))
        };
        self.relief_memo.insert(id, entry.clone());
        Ok(entry)
    }

    /// Build a pack's geometry sections from its portal record ids: the GEOM
    /// section (always, when any model-class record is present) plus — under
    /// `--geom-relief` — the GEOMR variant section carrying only the models
    /// the profile actually changes. Returns them in ascending kind order.
    fn sections_for<'a>(
        &mut self,
        source: &DatPairSource,
        ids: impl Iterator<Item = &'a u32>,
    ) -> Result<Vec<SectionOut>> {
        let mut entries: BTreeMap<u32, Vec<u8>> = BTreeMap::new();
        let mut relief_entries: BTreeMap<u32, Vec<u8>> = BTreeMap::new();
        for &id in ids {
            if let Some(p) = self.payload_for(source, id)? {
                entries.insert(id, p.as_ref().clone());
            }
            if let Some(r) = self.relief_payload_for(source, id)? {
                relief_entries.insert(id, r.as_ref().clone());
            }
        }
        if entries.is_empty() {
            return Ok(Vec::new());
        }
        self.rows += entries.len();
        self.bytes_raw += entries.values().map(|p| p.len() as u64).sum::<u64>();
        let mut out = vec![SectionOut {
            kind: section_kind::GEOM,
            codec: codec::ZSTD,
            raw: hbg1::build_geom_section(&entries),
        }];
        if !relief_entries.is_empty() {
            self.relief_rows += relief_entries.len();
            self.relief_bytes_raw +=
                relief_entries.values().map(|p| p.len() as u64).sum::<u64>();
            out.push(SectionOut {
                kind: section_kind::GEOM_RELIEF,
                codec: codec::ZSTD,
                raw: hbg1::build_geom_section(&relief_entries),
            });
        }
        Ok(out)
    }
}

fn tex_dims(source: &DatPairSource, id: u32) -> (u32, u32) {
    source
        .get_file_by_key(ResourceKey::new(EOR_PORTAL_NAMESPACE, id))
        .ok()
        .and_then(|b| Texture::unpack(&b).ok())
        .map(|t| (t.width.max(0) as u32, t.height.max(0) as u32))
        .unwrap_or((0, 0))
}

// ---------------------------------------------------------------------------
// Closure verification (`--verify-closure`)
// ---------------------------------------------------------------------------

/// T13 (ST3) — GEOM closure verification (`--verify-closure` leg):
/// (a) every model-class portal record (0x01/0x02/0x0D) in a pack's RECORDS
///     stream has an HBG1 GEOM row IN THE SAME PACK (co-location, D-04.2);
/// (b) every GEOM row parses with the kind matching its id prefix;
/// (c) every kind-1 SETUP directory part DID has a kind-0 row SOMEWHERE in
///     the bake (the closure walk carries parts, so this pins emission);
/// (d) every ENVCELLS-stream EnvCell's `(environment, cell_structure)` is
///     covered by a kind-2 directory entry somewhere in the bake;
/// (e) RELIEF-IN-BAKE: every GEOMR (relief variant) row is a kind-0 payload
///     for a 0x01 id with a co-located DEFAULT row, and is structurally
///     ADDITIVE over it (identical subset table, only appended triangles).
fn verify_geom(pack_bytes: &[Vec<u8>]) -> Result<()> {
    use holtburger_dat::file_type::EnvCell as EnvCellRec;
    let mut failures: Vec<String> = Vec::new();
    let mut global_kind0: HashSet<u32> = HashSet::new();
    let mut global_env: HashMap<u32, HashSet<u32>> = HashMap::new(); // env id -> cellstructs
    let mut setup_parts: Vec<(u32, u32)> = Vec::new(); // (setup id, part did)
    let mut envcell_needs: Vec<(u32, u32, u16)> = Vec::new(); // (fid, env, struct)

    for (i, bytes) in pack_bytes.iter().enumerate() {
        let reader = HbpReader::parse(bytes)
            .map_err(|e| ToolError::Validation(format!("geom re-parse pack {i}: {e}")))?;
        let geom_rows: HashMap<u32, (u16, usize, usize)> = match reader
            .section(section_kind::GEOM)
            .map_err(ToolError::Validation)?
        {
            Some(payload) => {
                let rows =
                    hbg1::parse_geom_section(&payload).map_err(ToolError::Validation)?;
                let mut m = HashMap::new();
                for (id, enc, off, size) in rows {
                    if enc != hbg1::ENCODING_HBG1 {
                        failures.push(format!(
                            "pack {i}: GEOM row 0x{id:08X} encoding 0x{enc:04X} != HBG1"
                        ));
                        continue;
                    }
                    let p = &payload[off..off + size];
                    match hbg1::parse_header(p) {
                        Ok(h) => {
                            let want = match (id >> 24) as u8 {
                                0x01 => hbg1::KIND_PART,
                                0x02 => hbg1::KIND_SETUP,
                                _ => hbg1::KIND_ENV,
                            };
                            if h.kind != want {
                                failures.push(format!(
                                    "pack {i}: GEOM 0x{id:08X} kind {} != expected {want}",
                                    h.kind
                                ));
                            } else {
                                match h.kind {
                                    hbg1::KIND_PART => {
                                        global_kind0.insert(id);
                                        if let Err(e) = hbg1::Hbg1Mesh::parse(p) {
                                            failures.push(format!(
                                                "pack {i}: GEOM 0x{id:08X}: {e}"
                                            ));
                                        }
                                    }
                                    hbg1::KIND_SETUP => match hbg1::parse_setup(p) {
                                        Ok(dir) => {
                                            for row in &dir.parts {
                                                if (row.part_did >> 24) as u8 == 0x01 {
                                                    setup_parts.push((id, row.part_did));
                                                }
                                            }
                                        }
                                        Err(e) => failures.push(format!(
                                            "pack {i}: GEOM 0x{id:08X}: {e}"
                                        )),
                                    },
                                    _ => match hbg1::Hbg1EnvDir::parse(p) {
                                        Ok(dir) => {
                                            global_env
                                                .entry(id)
                                                .or_default()
                                                .extend(dir.entries.iter().map(|(c, _)| c));
                                        }
                                        Err(e) => failures.push(format!(
                                            "pack {i}: GEOM 0x{id:08X}: {e}"
                                        )),
                                    },
                                }
                            }
                        }
                        Err(e) => {
                            failures.push(format!("pack {i}: GEOM 0x{id:08X}: {e}"))
                        }
                    }
                    m.insert(id, (enc, off, size));
                }
                m
            }
            None => HashMap::new(),
        };
        // (e) RELIEF-IN-BAKE: every GEOMR row must be a kind-0 payload for a
        // 0x01 id that has a co-located DEFAULT row (the variant is an
        // alternative to a row that exists, never a row of its own), must
        // parse, and must be structurally ADDITIVE over that default — same
        // subset table (material identity + flags, same order) with only
        // appended triangles. That is the "relief never invents a material"
        // invariant, checked at bake so a bad variant can never ship.
        if let Some(payload) = reader
            .section(section_kind::GEOM_RELIEF)
            .map_err(ToolError::Validation)?
        {
            let rows = hbg1::parse_geom_section(&payload).map_err(ToolError::Validation)?;
            for (id, enc, off, size) in rows {
                if enc != hbg1::ENCODING_HBG1 {
                    failures.push(format!(
                        "pack {i}: GEOMR row 0x{id:08X} encoding 0x{enc:04X} != HBG1"
                    ));
                    continue;
                }
                if (id >> 24) as u8 != 0x01 {
                    failures.push(format!(
                        "pack {i}: GEOMR row 0x{id:08X} is not a 0x01 GfxObj id"
                    ));
                    continue;
                }
                let Some(&(_, boff, bsize)) = geom_rows.get(&id) else {
                    failures.push(format!(
                        "pack {i}: GEOMR 0x{id:08X} has no co-located default GEOM row"
                    ));
                    continue;
                };
                let Some(base_payload) = reader
                    .section(section_kind::GEOM)
                    .map_err(ToolError::Validation)?
                else {
                    failures.push(format!("pack {i}: GEOMR 0x{id:08X}: GEOM vanished"));
                    continue;
                };
                let v = &payload[off..off + size];
                let b = &base_payload[boff..boff + bsize];
                match (hbg1::Hbg1Mesh::parse(v), hbg1::Hbg1Mesh::parse(b)) {
                    (Ok(vm), Ok(bm)) => {
                        let (vs, bs) = (vm.subsets(), bm.subsets());
                        match (vs, bs) {
                            (Ok(vs), Ok(bs)) if vs.len() == bs.len() => {
                                for (a, c) in bs.iter().zip(vs.iter()) {
                                    if a.surface_ref != c.surface_ref || a.flags != c.flags {
                                        failures.push(format!(
                                            "pack {i}: GEOMR 0x{id:08X}: subset identity drift"
                                        ));
                                        break;
                                    }
                                    if c.index_count < a.index_count
                                        || (c.index_count - a.index_count) % 3 != 0
                                    {
                                        failures.push(format!(
                                            "pack {i}: GEOMR 0x{id:08X}: subset is not additive"
                                        ));
                                        break;
                                    }
                                }
                                if vm.index_count <= bm.index_count {
                                    failures.push(format!(
                                        "pack {i}: GEOMR 0x{id:08X}: variant row adds no \
                                         geometry (it should not have been emitted)"
                                    ));
                                }
                            }
                            (Ok(_), Ok(_)) => failures.push(format!(
                                "pack {i}: GEOMR 0x{id:08X}: subset count differs from default"
                            )),
                            _ => failures.push(format!(
                                "pack {i}: GEOMR 0x{id:08X}: subset table unreadable"
                            )),
                        }
                    }
                    _ => failures
                        .push(format!("pack {i}: GEOMR 0x{id:08X}: mesh unreadable")),
                }
            }
        }
        // (a) co-location: model-class RECORDS ids need a same-pack GEOM row.
        if let Some(records) = reader
            .record_stream(section_kind::RECORDS)
            .map_err(ToolError::Validation)?
        {
            for &(_, fid) in records.keys() {
                if matches!((fid >> 24) as u8, 0x01 | 0x02 | 0x0D)
                    && !geom_rows.contains_key(&fid)
                {
                    failures.push(format!(
                        "pack {i}: record 0x{fid:08X} has no co-located GEOM row"
                    ));
                }
            }
        }
        // (d) inputs: ENVCELLS-stream cells name (env, cell_structure) pairs.
        if let Some(cells) = reader
            .record_stream(section_kind::ENVCELLS)
            .map_err(ToolError::Validation)?
        {
            for ((_, fid), rec) in &cells {
                if let Ok(ec) = EnvCellRec::unpack(&mut std::io::Cursor::new(rec)) {
                    envcell_needs.push((
                        *fid,
                        0x0D00_0000 | ec.environment_id as u32,
                        ec.cell_structure,
                    ));
                }
            }
        }
    }
    for (setup, part) in &setup_parts {
        if !global_kind0.contains(part) {
            failures.push(format!(
                "setup 0x{setup:08X}: part 0x{part:08X} has no kind-0 GEOM row anywhere"
            ));
        }
    }
    for (fid, env, cs) in &envcell_needs {
        match global_env.get(env) {
            Some(structs) if structs.contains(&(*cs as u32)) => {}
            _ => failures.push(format!(
                "envcell 0x{fid:08X}: env 0x{env:08X} cellstruct {cs} has no kind-2 \
                 GEOM coverage"
            )),
        }
    }
    if !failures.is_empty() {
        let shown = failures.iter().take(20).cloned().collect::<Vec<_>>().join("\n  ");
        return Err(ToolError::Validation(format!(
            "GEOM closure FAILED with {} problem(s):\n  {shown}{}",
            failures.len(),
            if failures.len() > 20 { "\n  …" } else { "" }
        )));
    }
    Ok(())
}

fn verify_closure(
    pack_table: &[PackTableEntry],
    pack_bytes: &[Vec<u8>],
    index: &SpatialIndex,
) -> Result<()> {
    let mut by_hash: HashMap<[u8; 16], usize> = HashMap::new();
    for (i, p) in pack_table.iter().enumerate() {
        by_hash.insert(p.hash16, i);
    }
    let mut failures: Vec<String> = Vec::new();
    // Memoized per-pack key sets. Parsing + decompressing the TARGET pack once
    // per REFS edge is O(edges × pack-parse) and does not terminate in useful
    // time at full-world scale (measured: >5.5 h single-core on 17,682 packs,
    // 2026-08-09); each pack is parsed at most once instead.
    fn record_keys_for<'a>(
        cache: &'a mut [Option<HashSet<(u8, u32)>>],
        pack_bytes: &[Vec<u8>],
        ord: usize,
    ) -> Result<&'a HashSet<(u8, u32)>> {
        if cache[ord].is_none() {
            let reader =
                HbpReader::parse(&pack_bytes[ord]).map_err(ToolError::Validation)?;
            let mut keys: HashSet<(u8, u32)> = HashSet::new();
            for k in [section_kind::RECORDS, section_kind::ENVCELLS] {
                if let Some(m) = reader.record_stream(k).ok().flatten() {
                    keys.extend(m.keys().copied());
                }
            }
            cache[ord] = Some(keys);
        }
        Ok(cache[ord].as_ref().unwrap())
    }
    fn pvw_keys_for<'a>(
        cache: &'a mut [Option<HashSet<u32>>],
        pack_bytes: &[Vec<u8>],
        ord: usize,
    ) -> Result<&'a HashSet<u32>> {
        if cache[ord].is_none() {
            let reader =
                HbpReader::parse(&pack_bytes[ord]).map_err(ToolError::Validation)?;
            let keys: HashSet<u32> = reader
                .section(section_kind::PVW)
                .ok()
                .flatten()
                .and_then(|p| pf::parse_pvw_stream(&p).ok())
                .map(|m| m.keys().copied().collect())
                .unwrap_or_default();
            cache[ord] = Some(keys);
        }
        Ok(cache[ord].as_ref().unwrap())
    }
    let mut record_keys: Vec<Option<HashSet<(u8, u32)>>> =
        vec![None; pack_bytes.len()];
    let mut pvw_keys: Vec<Option<HashSet<u32>>> = vec![None; pack_bytes.len()];
    for (i, bytes) in pack_bytes.iter().enumerate() {
        let reader = HbpReader::parse(bytes)
            .map_err(|e| ToolError::Validation(format!("re-parse pack {i}: {e}")))?;
        let refs = match reader
            .section(section_kind::REFS)
            .map_err(ToolError::Validation)?
        {
            Some(payload) => pf::parse_refs(&payload).map_err(ToolError::Validation)?,
            None => RefsSection::default(),
        };
        let mut targets: Vec<Option<usize>> = Vec::new();
        for (hash, _kind) in &refs.packs {
            match by_hash.get(hash) {
                Some(&ord) => targets.push(Some(ord)),
                None => {
                    failures.push(format!(
                        "pack {i}: REFS names pack {} which was not emitted",
                        hex16(hash)
                    ));
                    targets.push(None);
                }
            }
        }
        for &(ns, fid, local) in &refs.records {
            let Some(Some(target)) = targets.get(local as usize) else {
                failures.push(format!(
                    "pack {i}: record 0x{fid:08X} points at unresolved pack \
                     ordinal {local}"
                ));
                continue;
            };
            let found = record_keys_for(&mut record_keys, pack_bytes, *target)?
                .contains(&(ns, fid));
            if !found {
                failures.push(format!(
                    "pack {i}: dangling REFS edge {ns}/0x{fid:08X} -> pack {target}"
                ));
            }
        }
        if let Some(texref_payload) = reader
            .section(section_kind::TEXREF)
            .map_err(ToolError::Validation)?
        {
            let rows =
                pf::parse_texref(&texref_payload).map_err(ToolError::Validation)?;
            for row in rows {
                if row.tier_bits & tier_bits::PVW_PRESENT == 0 {
                    continue;
                }
                let target_ord: Option<usize> = match row.pvw_pack_ord {
                    pf::PVW_ORD_SELF => Some(i),
                    pf::PVW_ORD_NONE => {
                        failures.push(format!(
                            "pack {i}: rs 0x{:08X} claims a preview but has no \
                             pvw_pack_ord",
                            row.rs_id
                        ));
                        None
                    }
                    local => match targets.get(local as usize) {
                        Some(Some(t)) => Some(*t),
                        _ => {
                            failures.push(format!(
                                "pack {i}: rs 0x{:08X} preview ordinal {local} \
                                 unresolved",
                                row.rs_id
                            ));
                            None
                        }
                    },
                };
                if let Some(t) = target_ord {
                    let ok = pvw_keys_for(&mut pvw_keys, pack_bytes, t)?
                        .contains(&row.rs_id);
                    if !ok {
                        failures.push(format!(
                            "pack {i}: rs 0x{:08X} preview missing from its \
                             declared pack",
                            row.rs_id
                        ));
                    }
                }
            }
        }
    }
    for &ord in index.tile_grid.iter().filter(|&&o| o != pf::TILE_EMPTY) {
        if ord as usize >= pack_table.len() {
            failures.push(format!("index tile grid ordinal {ord} out of range"));
        }
    }
    for &(lb, ord) in &index.interiors {
        if ord as usize >= pack_table.len() {
            failures.push(format!("index interior 0x{lb:04X} ordinal out of range"));
        }
    }
    if !failures.is_empty() {
        let shown =
            failures.iter().take(20).cloned().collect::<Vec<_>>().join("\n  ");
        return Err(ToolError::Validation(format!(
            "--verify-closure FAILED with {} problem(s):\n  {shown}{}",
            failures.len(),
            if failures.len() > 20 { "\n  …" } else { "" }
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an HBC7 blob with a full mip chain from `w`×`h` down to 1×1,
    /// each level's bytes stamped with its level index.
    fn hbc7_chain(w: u32, h: u32) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(HBC7_MAGIC);
        for v in [w, h, w.div_ceil(4), h.div_ceil(4)] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        let (mut lw, mut lh) = (w, h);
        let mut level = 0u8;
        loop {
            let n = (lw.div_ceil(4) as usize) * (lh.div_ceil(4) as usize) * 16;
            out.extend(std::iter::repeat_n(level ^ 0x5A, n));
            if lw == 1 && lh == 1 {
                break;
            }
            lw = (lw >> 1).max(1);
            lh = (lh >> 1).max(1);
            level += 1;
        }
        out
    }

    #[test]
    fn slice_caps_square_chain_at_128() {
        let full = hbc7_chain(1024, 1024);
        let sliced = slice_hbc7_to_cap(&full, 128).expect("sliceable");
        let (w, h) = validate_hbc7(&sliced).expect("valid HBC7");
        assert_eq!((w, h), (128, 128));
        // Level 0 of the slice is level 3 of the source (1024→512→256→128),
        // whose fill stamp is 3 ^ 0x5A.
        assert_eq!(sliced[HBC7_HEADER_LEN], 3 ^ 0x5A);
    }

    #[test]
    fn slice_non_square_caps_larger_axis() {
        // 512×128: cap when max(w,h) ≤ 128 ⇒ level 2 = 128×32.
        let full = hbc7_chain(512, 128);
        let sliced = slice_hbc7_to_cap(&full, 128).expect("sliceable");
        let (w, h) = validate_hbc7(&sliced).expect("valid HBC7");
        assert_eq!((w, h), (128, 32));
    }

    #[test]
    fn slice_small_chain_passes_through() {
        let full = hbc7_chain(64, 64);
        let sliced = slice_hbc7_to_cap(&full, 128).expect("sliceable");
        assert_eq!(sliced, full, "already under the cap: byte-identical");
    }

    #[test]
    fn slice_refuses_chain_that_stops_above_cap() {
        // 512² with ONLY level 0 (no mips) cannot be sliced to ≤128.
        let mut short = Vec::new();
        short.extend_from_slice(HBC7_MAGIC);
        for v in [512u32, 512, 128, 128] {
            short.extend_from_slice(&v.to_le_bytes());
        }
        short.extend(std::iter::repeat_n(0xAAu8, 128 * 128 * 16));
        assert!(validate_hbc7(&short).is_ok());
        assert!(slice_hbc7_to_cap(&short, 128).is_none());
    }

    #[test]
    fn dims_byte_encodes_pow2_and_rounds_up() {
        assert_eq!(dims_byte(512, 512), (9 << 4) | 9);
        assert_eq!(dims_byte(1024, 256), (10 << 4) | 8);
        assert_eq!(dims_byte(1, 1), 0);
        // non-pow2 rounds UP (bucket keying only).
        assert_eq!(dims_byte(300, 6), (9 << 4) | 3);
    }

    // ---- PAGE-RESAMPLE (T22 D2) ---------------------------------------

    #[test]
    fn ktx2_dims_reads_the_header_and_rejects_non_ktx2() {
        let dir = tempfile::tempdir().unwrap();
        let mut head = Vec::new();
        head.extend_from_slice(&KTX2_IDENTIFIER);
        head.extend_from_slice(&0u32.to_le_bytes()); // vkFormat
        head.extend_from_slice(&1u32.to_le_bytes()); // typeSize
        head.extend_from_slice(&1024u32.to_le_bytes()); // pixelWidth
        head.extend_from_slice(&512u32.to_le_bytes()); // pixelHeight
        head.extend_from_slice(&0u32.to_le_bytes()); // pixelDepth
        head.extend_from_slice(&[0u8; 64]); // rest of a real file
        let good = dir.path().join("0x06000001.ktx2");
        std::fs::write(&good, &head).unwrap();
        assert_eq!(ktx2_dims(&good), Some((1024, 512)));

        let bad = dir.path().join("0x06000002.ktx2");
        std::fs::write(&bad, b"not a ktx2 file at all, definitely not").unwrap();
        assert_eq!(ktx2_dims(&bad), None);

        // Presence survives an unparseable header — the client can still
        // fetch it; only the DECLARED dims fall back to the DAT record.
        assert_eq!(xu7_entry(Some(dir.path()), 0x0600_0001), Some((1024, 512)));
        assert_eq!(xu7_entry(Some(dir.path()), 0x0600_0002), Some((0, 0)));
        assert_eq!(xu7_entry(Some(dir.path()), 0x0600_0003), None);
        assert_eq!(xu7_entry(None, 0x0600_0001), None);
    }

    #[test]
    fn the_page_bit_is_the_authority_the_dims_byte_cannot_be() {
        // FOUND BY THIS TEST: the TEXREF `dims` byte is 4 bits per axis of
        // ceil(log2), so it CANNOT express "off page" for a non-pow2 member.
        // 1096x1096 rounds to 2^11 x 2^11 and reads exactly like a real
        // 2048² page. That is why `FULL_PAGE_DIMS` exists and why the client
        // must trust the BIT rather than re-deriving the verdict from the
        // byte. The invariant is therefore ONE-WAY: bit set ⇒ the byte
        // decodes to a legal square page.
        let page_shaped = |w: u32, h: u32| {
            let byte = dims_byte(w, h);
            let (lw, lh) = ((byte >> 4) as u32, (byte & 0x0F) as u32);
            lw == lh
                && (crate::page_resample::PAGE_TIER_MIN
                    ..=crate::page_resample::PAGE_TIER_MAX)
                    .contains(&lw)
        };
        for (w, h) in [(256u32, 256u32), (512, 512), (1024, 1024), (2048, 2048)] {
            assert!(!crate::page_resample::needs_resample_dims(w, h));
            assert!(page_shaped(w, h), "{w}x{h}: on-page member must be page-shaped");
        }
        for (w, h) in [(128u32, 128u32), (512, 1024), (4096, 4096), (300, 6)] {
            assert!(crate::page_resample::needs_resample_dims(w, h));
            assert!(!page_shaped(w, h), "{w}x{h}: off-page member must not look page-shaped");
        }
        // The exception the bit is for.
        assert!(crate::page_resample::needs_resample_dims(1096, 1096));
        assert!(page_shaped(1096, 1096), "1096² is the lossy case — keep it documented");
    }

    #[test]
    fn region_rect_parses_and_bounds() {
        let r = RegionRect::parse("A4AF:AEB9").expect("parse");
        assert!(r.contains(0xA9, 0xB4));
        assert!(!r.contains(0xA3, 0xB4));
        assert!(!r.contains(0xA9, 0xBA));
        assert!(RegionRect::parse("A4AF").is_err());
        assert!(RegionRect::parse("AEB9:A4AF").is_err());
    }

    #[test]
    fn supergrid_ordinal_is_stable() {
        // Holtburg-ish users around (0xA9, 0xB4) ⇒ supergrid (5, 5) = 45.
        let users: BTreeSet<(u8, u8)> =
            [(0xA9, 0xB4), (0xAA, 0xB5), (0xA8, 0xB3)].into_iter().collect();
        assert_eq!(supergrid_of_centroid(&users), 5 * 8 + 5);
    }
}
