//! `dat-shard` — Phase 5.0 objective 3 of `docs/thorough.md`.
//!
//! See `bin/dat-shard.rs` for the CLI front-end. This module holds
//! the implementation so integration tests in `tests/sharding.rs`
//! can drive it directly without spawning the binary.
//!
//! The pipeline:
//!
//! 1. [`read_input_bundle`] — open either an existing HBA
//!    (`--input`) or a triple of canonical retail DATs and load
//!    every non-pruned record into an in-memory map.
//! 2. [`write_shards`] — sha256 each record, write
//!    `<output>/shards/{hash}.bin` (one file per unique content),
//!    return a manifest entry map.
//! 3. [`write_boot_pack`] — filter records via [`is_boot_essential`]
//!    and stream them into `<output>/boot.hba` via
//!    `HbaStreamWriter`. Records covered by the boot pack are
//!    listed in the returned [`BootPack::covers`] so the resource
//!    source can short-circuit prefetches without parsing the
//!    pack.
//! 4. [`shard_bundle`] — orchestrates the above, plus
//!    `manifest.json` writeback.
//!
//! Phase 5.0 objective 8 supersedes [`is_boot_essential`] with a
//! canonical implementation in `holtburger-dat::file_type`
//! covering the transitive
//! GfxObj/SetupModel/Surface/SurfaceTexture/Texture/Palette walk
//! through the boot landblock's object placements. Until then,
//! this module ships the minimum-viable boot policy:
//! catalog-essential records (CharGen/SkillTable/SpellTable/
//! XpTable/ChatPoseTable/MotionKinematics) plus the boot
//! landblock's CellLandblock + LandblockInfo for the 9-cell spawn
//! neighborhood.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use holtburger_dat::file_type::{
    CharGen, ChatPoseTable, MotionKinematics, SkillTable, SpellTable, XpTable,
};
use holtburger_dat::landblock::LandblockInfo;
use holtburger_dat::walk::collect_model_dependencies;
use holtburger_dat::{
    DatDatabase, DatError, EOR_CELL_NAMESPACE, EOR_PORTAL_NAMESPACE, FileMetadata, HbaReader,
    HbaStreamWriter, ResourceKey, ResourceSource, Result as DatResult,
};
use holtburger_manifest::{
    BootPack, MANIFEST_VERSION, Manifest, ShardEntry, SourceMeta, format_shard_key, sha256_hex,
    catalog::{CatalogEntry, NamespaceCatalog},
    v2::{
        BootPackV2, DEFAULT_CATALOG_URL_TEMPLATE, DEFAULT_SHARD_URL_TEMPLATE_PREFIXED,
        MANIFEST_V2_VERSION, ManifestV2, namespace_slug,
    },
};
use sha2::{Digest, Sha256};

use crate::error::{Result, ToolError};

/// Default boot landblock (Holtburg 0xA9B4 — the spawn area used
/// by the in-browser teleport from Phase 4 step 2a.6).
pub const DEFAULT_BOOT_LANDBLOCK: u32 = 0xA9B4;

/// Default manifest version emitted by `dat-shard` — Phase 5.2 obj 5.
/// Phase 5.0/5.1 emitted v1 (203 MB JSON); v2 is the new default.
/// v1 stays available via `--manifest-version=1` for one release
/// cycle to drain in-flight CDN deploys.
pub const DEFAULT_MANIFEST_VERSION: u32 = 2;

/// IDs of the records the boot pack always includes regardless of
/// boot-landblock — the catalog tables every login needs.
pub const BOOT_ESSENTIAL_PORTAL_IDS: &[u32] = &[
    CharGen::FILE_ID,
    ChatPoseTable::FILE_ID,
    SkillTable::FILE_ID,
    SpellTable::FILE_ID,
    XpTable::FILE_ID,
    MotionKinematics::FILE_ID,
    // Canonical UI font + its two glyph-atlas Textures. The Font record
    // declares the per-glyph rects; the two A8 (1024x312) Textures hold
    // foreground (glyph mask) and background (drop-shadow / fill) pixel
    // data. Baked into boot.hba so retail-style text rendering is
    // available at session start with no extra HTTP round-trip.
    UI_FONT_ID,
    UI_FONT_ATLAS_FG_ID,
    UI_FONT_ATLAS_BG_ID,
    // gmDefaultMap — retail keystroke defaults (Controls tab in
    // options-panel resolves QualifiedControl bindings from this).
    DEFAULT_KEYMAP_ID,
];

/// Standard 16×16-cell UI Font record (1050 glyphs starting at U+0020).
/// Holtburger's first canonical text font.
pub const UI_FONT_ID: u32 = 0x40000000;
/// Foreground glyph-mask Texture referenced by [`UI_FONT_ID`].
pub const UI_FONT_ATLAS_FG_ID: u32 = 0x06005EE5;
/// Background (drop-shadow / fill) Texture referenced by [`UI_FONT_ID`].
pub const UI_FONT_ATLAS_BG_ID: u32 = 0x06005EE6;
/// "gmDefaultMap" — retail factory-default keystroke bindings,
/// referenced by the Controls tab in the options panel.
pub const DEFAULT_KEYMAP_ID: u32 = 0x14000000;

/// Namespace the BC7 texture-block delivery path lives in. Records
/// are keyed by the RenderSurface id they replace (e.g.
/// `0x06003789`), payload is an `HBC7` container (see
/// [`ingest_tex_bc7_dir`]). 18 bytes — well inside
/// `holtburger_dat::RESOURCE_NAMESPACE_LEN` (32).
pub const TEX_BC7_NAMESPACE: &str = "holtburger/tex-bc7";

/// `HBC7` container magic. Little-endian header follows:
/// `u32 width | u32 height | u32 blocks_x | u32 blocks_y`, then
/// `blocks_x * blocks_y` BC7 blocks of 16 bytes each, row-major.
/// `width`/`height` are TRUE pixel dims and need not be multiples
/// of 4; the block grid covers the padded area.
pub const HBC7_MAGIC: &[u8; 4] = b"HBC7";

/// Byte length of the `HBC7` header (magic + 4 × u32).
pub const HBC7_HEADER_LEN: usize = 20;

/// Bytes per BC7 4×4 block.
pub const BC7_BLOCK_BYTES: usize = 16;

/// Caller-supplied dat-shard options. Mirrors the CLI argv shape.
#[derive(Debug, Clone)]
pub struct DatShardOptions {
    pub input_hba: Option<PathBuf>,
    pub eor_portal: Option<PathBuf>,
    pub eor_cell: Option<PathBuf>,
    pub eor_local: Option<PathBuf>,
    pub boot_landblock: u32,
    pub output_dir: PathBuf,
    /// Manifest schema version to emit. Phase 5.2 obj 5 added this;
    /// defaults to [`DEFAULT_MANIFEST_VERSION`] (= 2). Set to 1 to
    /// produce the legacy v1 wire format.
    pub manifest_version: u32,
    /// Directory of `<rsId>.hbc7` BC7 texture blobs to ingest into
    /// [`TEX_BC7_NAMESPACE`]. v2 only. Streamed record-by-record —
    /// the bytes never join the in-memory [`LoadedBundle`], because a
    /// full BC7 set is ~2 GB and the bundle map is already the bake's
    /// peak-RSS driver. See [`ingest_tex_bc7_dir`].
    pub tex_bc7: Option<PathBuf>,
}

/// Result of [`read_input_bundle`] — every record in the source
/// addressed by `(namespace, file_id)` plus its raw bytes.
pub struct LoadedBundle {
    pub records: BTreeMap<(String, u32), Vec<u8>>,
    pub source_meta: SourceMeta,
}

/// Result of [`shard_bundle_v2`] — Phase 5.2 obj 5. Holds the v2
/// manifest plus aggregate counts for status logging.
#[derive(Debug, Clone)]
pub struct V2BakeResult {
    pub manifest: ManifestV2,
    pub total_records: usize,
    pub unique_shard_count: usize,
    pub catalog_count: usize,
    pub boot_covers_count: usize,
    /// `--tex-bc7` records shardable into [`TEX_BC7_NAMESPACE`].
    /// Zero when the flag wasn't passed.
    pub tex_bc7_records: usize,
    /// Total `HBC7` payload bytes ingested from `--tex-bc7`.
    pub tex_bc7_bytes: u64,
    /// `--tex-bc7` files rejected by the header/size check — a
    /// partially-written blob from a concurrent encode, or a stray
    /// non-HBC7 file. Non-zero is a bake-quality signal, not a
    /// hard failure: the run keeps the valid subset.
    pub tex_bc7_skipped: usize,
}

/// Wrapped output of the unified bake dispatcher
/// [`shard_bundle_dispatch`]. Either variant exposes the same
/// summary counts main() needs for its status print.
#[derive(Debug, Clone)]
pub enum BakeOutput {
    V1(Manifest),
    V2(V2BakeResult),
}

impl BakeOutput {
    pub fn manifest_version(&self) -> u32 {
        match self {
            Self::V1(_) => MANIFEST_VERSION,
            Self::V2(r) => r.manifest.version,
        }
    }

    pub fn unique_shard_count(&self) -> usize {
        match self {
            Self::V1(m) => m.shards.len(),
            Self::V2(r) => r.unique_shard_count,
        }
    }

    pub fn boot_covers_count(&self) -> usize {
        match self {
            Self::V1(m) => m.boot_pack.covers.len(),
            Self::V2(r) => r.boot_covers_count,
        }
    }
}

/// Parse a hex u32 with optional `0x`/`0X` prefix.
pub fn parse_hex_u32(value: &str) -> std::result::Result<u32, String> {
    let stripped = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .unwrap_or(value);
    u32::from_str_radix(stripped, 16).map_err(|e| format!("invalid hex u32 {value:?}: {e}"))
}

pub fn read_input_bundle(opts: &DatShardOptions) -> Result<LoadedBundle> {
    // If both --input AND any --eor-* path are given, MERGE them:
    // start from the HBA, then layer canonical-DAT records on top.
    // The HBA carries non-retail namespaces (e.g. `holtburger/core`'s
    // MotionKinematics) that the raw DATs lack; the raw DATs carry
    // the full retail namespaces (`eor/cell`, `eor/local`, etc.) that
    // a pre-built HBA may have pruned. Either alone leaves a gap;
    // together they cover the union.
    let want_canonical = opts.eor_portal.is_some()
        || opts.eor_cell.is_some()
        || opts.eor_local.is_some();
    match (&opts.input_hba, want_canonical) {
        (Some(input), false) => read_from_hba(input),
        (None, true) => read_from_canonical_dats(opts),
        (Some(input), true) => {
            let mut hba_bundle = read_from_hba(input)?;
            let dat_bundle = read_from_canonical_dats(opts)?;
            for (key, bytes) in dat_bundle.records {
                hba_bundle.records.insert(key, bytes);
            }
            // Use the canonical-DAT iteration numbers when present
            // (more authoritative than the HBA's zeros).
            hba_bundle.source_meta = dat_bundle.source_meta;
            Ok(hba_bundle)
        }
        // `--tex-bc7` alone is a legitimate bake: a side-car bundle
        // that carries ONLY the BC7 namespace (no retail records, so
        // an empty boot pack). Any other no-input combination is a
        // usage error.
        (None, false) if opts.tex_bc7.is_some() => Ok(LoadedBundle {
            records: BTreeMap::new(),
            source_meta: SourceMeta {
                portal_dat_iteration: 0,
                cell_dat_iteration: 0,
                local_dat_iteration: 0,
            },
        }),
        (None, false) => Err(ToolError::Validation(
            "--input or one of --eor-portal/--eor-cell/--eor-local/--tex-bc7 required".into(),
        )),
    }
}

/// Result of [`ingest_tex_bc7_dir`].
pub struct TexBc7Ingest {
    /// One catalog entry per accepted `<rsId>.hbc7` file.
    pub entries: Vec<CatalogEntry>,
    /// Distinct truncated digests written (identical blobs share a
    /// shard file).
    pub unique_shard_count: usize,
    /// Sum of accepted payload sizes.
    pub total_bytes: u64,
    /// `(path, reason)` for every rejected file.
    pub skipped: Vec<(PathBuf, String)>,
}

/// Validate an `HBC7` header against the blob length. Returns
/// `(width, height)` on success, an explanation on failure.
///
/// Checks, in order: length ≥ header, magic, `blocks_x`/`blocks_y`
/// equal `ceil(dim / 4)`, and the exact total length
/// `20 + blocks_x * blocks_y * 16`. The exact-length rule is what
/// catches a blob a concurrent encoder is still writing — a
/// half-flushed file has a valid header and a short body.
pub fn validate_hbc7(bytes: &[u8]) -> std::result::Result<(u32, u32), String> {
    if bytes.len() < HBC7_HEADER_LEN {
        return Err(format!(
            "shorter than the {HBC7_HEADER_LEN}-byte HBC7 header ({} bytes)",
            bytes.len()
        ));
    }
    if &bytes[..4] != HBC7_MAGIC {
        return Err(format!(
            "bad magic {:02X?} (expected {:02X?} = \"HBC7\")",
            &bytes[..4],
            HBC7_MAGIC
        ));
    }
    let u32_at = |off: usize| -> u32 {
        u32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]])
    };
    let width = u32_at(4);
    let height = u32_at(8);
    let blocks_x = u32_at(12);
    let blocks_y = u32_at(16);
    if width == 0 || height == 0 {
        return Err(format!("zero dimension {width}x{height}"));
    }
    let expect_bx = width.div_ceil(4);
    let expect_by = height.div_ceil(4);
    if blocks_x != expect_bx || blocks_y != expect_by {
        return Err(format!(
            "block grid {blocks_x}x{blocks_y} does not cover {width}x{height} (expected {expect_bx}x{expect_by})"
        ));
    }
    let expect_len = HBC7_HEADER_LEN
        + (blocks_x as usize)
            .saturating_mul(blocks_y as usize)
            .saturating_mul(BC7_BLOCK_BYTES);
    if bytes.len() != expect_len {
        return Err(format!(
            "length {} != {expect_len} implied by the {blocks_x}x{blocks_y} block grid (truncated or padded?)",
            bytes.len()
        ));
    }
    Ok((width, height))
}

/// Parse a `<rsId>.hbc7` filename into its RenderSurface id. Accepts
/// `0x06003789.hbc7`, `06003789.hbc7`, and either hex case.
pub fn parse_hbc7_file_name(path: &Path) -> std::result::Result<u32, String> {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "non-UTF-8 filename".to_string())?;
    parse_hex_u32(stem)
}

/// Phase BC7 delivery — stream a directory of `<rsId>.hbc7` blobs
/// straight into content-addressed shards under `output_dir` and
/// return the [`TEX_BC7_NAMESPACE`] catalog entries.
///
/// Deliberately NOT routed through [`LoadedBundle`]: the bundle map
/// holds every record's bytes for the whole bake, and a full BC7 set
/// is ~2 GB on top of the retail DATs' ~1.5 GB. This loop's live set
/// is one blob (≤ a few MB) plus 28-ish bytes of catalog entry per
/// record, so adding the namespace costs ~0.1 MB of RSS instead of
/// ~2 GB.
///
/// Shard layout, dedupe rule, and digest truncation match
/// [`write_shards_v2`] exactly — same `shards/{prefix2}/{trunc}.bin`
/// paths, same 16-byte truncated sha256 — so the client's v2 shard
/// URL template resolves BC7 records with no special-casing.
///
/// Files that fail [`validate_hbc7`] are skipped and reported in
/// [`TexBc7Ingest::skipped`] rather than aborting the bake: the
/// expected cause is a blob a concurrent encoder is mid-write on.
/// Non-`.hbc7` files are ignored silently (README, ledger, …).
pub fn ingest_tex_bc7_dir(dir: &Path, output_dir: &Path) -> Result<TexBc7Ingest> {
    let shards_dir = output_dir.join("shards");
    std::fs::create_dir_all(&shards_dir)
        .map_err(|e| ToolError::Validation(format!("create shards dir {shards_dir:?}: {e}")))?;

    // Sorted for deterministic logs + a deterministic
    // duplicate-id error message.
    let mut paths: Vec<PathBuf> = Vec::new();
    let read_dir = std::fs::read_dir(dir)
        .map_err(|e| ToolError::Validation(format!("read --tex-bc7 dir {dir:?}: {e}")))?;
    for entry in read_dir {
        let entry =
            entry.map_err(|e| ToolError::Validation(format!("scan --tex-bc7 dir {dir:?}: {e}")))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("hbc7") {
            paths.push(path);
        }
    }
    paths.sort();

    let mut entries: Vec<CatalogEntry> = Vec::with_capacity(paths.len());
    let mut seen_ids: HashSet<u32> = HashSet::new();
    let mut written: HashSet<[u8; 16]> = HashSet::new();
    let mut skipped: Vec<(PathBuf, String)> = Vec::new();
    let mut total_bytes: u64 = 0;

    for path in paths {
        let file_id = match parse_hbc7_file_name(&path) {
            Ok(id) => id,
            Err(reason) => {
                skipped.push((path, format!("filename is not a hex record id: {reason}")));
                continue;
            }
        };
        let bytes = std::fs::read(&path)
            .map_err(|e| ToolError::Validation(format!("read {path:?}: {e}")))?;
        if let Err(reason) = validate_hbc7(&bytes) {
            skipped.push((path, reason));
            continue;
        }
        // A duplicate id would silently shadow one blob (two files
        // like `0x06003789.hbc7` and `6003789.hbc7`), so it is a hard
        // error rather than a skip.
        if !seen_ids.insert(file_id) {
            return Err(ToolError::Validation(format!(
                "--tex-bc7 dir {dir:?} has two files for record 0x{file_id:08X} (e.g. {path:?})"
            )));
        }

        let (_full, trunc) = sha256_full_and_trunc(&bytes);
        let trunc_hex = hex_encode_16(&trunc);
        if written.insert(trunc) {
            let prefix_dir = shards_dir.join(&trunc_hex[..2]);
            std::fs::create_dir_all(&prefix_dir).map_err(|e| {
                ToolError::Validation(format!("create shard prefix dir {prefix_dir:?}: {e}"))
            })?;
            let shard_path = prefix_dir.join(format!("{trunc_hex}.bin"));
            std::fs::write(&shard_path, &bytes)
                .map_err(|e| ToolError::Validation(format!("write {shard_path:?}: {e}")))?;
        }

        total_bytes += bytes.len() as u64;
        entries.push(CatalogEntry {
            file_id,
            sha256_truncated: trunc,
            size: bytes.len() as u64,
        });
    }

    Ok(TexBc7Ingest {
        unique_shard_count: written.len(),
        entries,
        total_bytes,
        skipped,
    })
}

fn read_from_hba(path: &Path) -> Result<LoadedBundle> {
    let reader = HbaReader::<std::fs::File>::open(path)
        .map_err(|e| ToolError::DatOpen(path.to_path_buf(), e.to_string()))?;
    let mut records: BTreeMap<(String, u32), Vec<u8>> = BTreeMap::new();
    for entry_result in reader.entries() {
        let entry = entry_result
            .map_err(|e| ToolError::Validation(format!("HBA entry read: {e}")))?;
        if entry.is_pruned() {
            continue;
        }
        let namespace = entry
            .namespace_id()
            .map_err(|e| ToolError::Validation(format!("HBA entry namespace decode: {e}")))?;
        let bytes = reader
            .get_file_in_namespace(namespace.as_str(), entry.file_id)
            .map_err(|e| {
                ToolError::Validation(format!(
                    "read {}/{:#x}: {e}",
                    namespace.as_str(),
                    entry.file_id
                ))
            })?;
        records.insert((namespace.as_str().to_owned(), entry.file_id), bytes);
    }
    Ok(LoadedBundle {
        records,
        // HBA input doesn't carry the original DAT iteration
        // numbers — populate with zeros and let canonical-DAT
        // mode fill them properly.
        source_meta: SourceMeta {
            portal_dat_iteration: 0,
            cell_dat_iteration: 0,
            local_dat_iteration: 0,
        },
    })
}

fn read_from_canonical_dats(opts: &DatShardOptions) -> Result<LoadedBundle> {
    // Each canonical DAT is independently optional — the merge caller
    // in `read_input_bundle` may have already provided some namespaces
    // via `--input`. Iterations default to 0 for any DAT that wasn't
    // passed.
    let mut records: BTreeMap<(String, u32), Vec<u8>> = BTreeMap::new();

    let portal_iter = if let Some(portal) = opts.eor_portal.as_deref() {
        let db = DatDatabase::new(portal)
            .map_err(|e| ToolError::DatOpen(portal.to_path_buf(), e.to_string()))?;
        let it = db.header.master_map_id;
        ingest_dat_into(EOR_PORTAL_NAMESPACE, &db, &mut records)?;
        it
    } else {
        0
    };

    let cell_iter = if let Some(path) = opts.eor_cell.as_deref() {
        let db = DatDatabase::new(path)
            .map_err(|e| ToolError::DatOpen(path.to_path_buf(), e.to_string()))?;
        let it = db.header.master_map_id;
        ingest_dat_into(EOR_CELL_NAMESPACE, &db, &mut records)?;
        it
    } else {
        0
    };

    let local_iter = if let Some(path) = opts.eor_local.as_deref() {
        let db = DatDatabase::new(path)
            .map_err(|e| ToolError::DatOpen(path.to_path_buf(), e.to_string()))?;
        let it = db.header.master_map_id;
        ingest_dat_into("eor/local", &db, &mut records)?;
        it
    } else {
        0
    };

    Ok(LoadedBundle {
        records,
        source_meta: SourceMeta {
            portal_dat_iteration: portal_iter,
            cell_dat_iteration: cell_iter,
            local_dat_iteration: local_iter,
        },
    })
}

fn ingest_dat_into(
    namespace: &str,
    db: &DatDatabase,
    records: &mut BTreeMap<(String, u32), Vec<u8>>,
) -> Result<()> {
    for &id in db.files.keys() {
        let bytes = db
            .get_file(id)
            .map_err(|e| ToolError::Validation(format!("read {namespace}/{id:#x}: {e}")))?;
        records.insert((namespace.to_owned(), id), bytes);
    }
    Ok(())
}

/// Boot-pack inclusion test. The obj-3 minimum-viable policy.
/// Phase 5.1's [`compute_boot_keep_set`] supersedes this with the
/// transitive walk through LandblockInfo placements. This helper
/// stays exposed for unit tests and as the "fast" answer when the
/// caller doesn't need walk-discovered records.
pub fn is_boot_essential(namespace: &str, file_id: u32, boot_landblock: u32) -> bool {
    if namespace == EOR_PORTAL_NAMESPACE && BOOT_ESSENTIAL_PORTAL_IDS.contains(&file_id) {
        return true;
    }
    if namespace == EOR_CELL_NAMESPACE {
        for cell_id in spawn_neighborhood_cells(boot_landblock) {
            if file_id == ((cell_id << 16) | 0xFFFF) || file_id == ((cell_id << 16) | 0xFFFE) {
                return true;
            }
        }
    }
    false
}

/// Phase 5.1 — compute the full boot-pack keep set, including the
/// transitive walk through the spawn neighborhood's LandblockInfo
/// placements. Returns every `(namespace, file_id)` pair the boot
/// pack should include.
///
/// Inclusion rules:
/// 1. Catalog essentials ([`BOOT_ESSENTIAL_PORTAL_IDS`]).
/// 2. 9-cell spawn neighborhood — each cell's CellLandblock
///    (`0xXXYYFFFF`) and LandblockInfo (`0xXXYYFFFE`).
/// 3. For each in-bundle LandblockInfo from (2): parse the
///    placements and walk every model id transitively via
///    [`holtburger_dat::walk::collect_model_dependencies`]. Adds
///    GfxObj/SetupModel/Surface/SurfaceTexture/Texture/Palette
///    records reachable from each placement.
///
/// Walks accept missing records as terminal-leaf events: a
/// reference into a record not present in the input bundle just
/// stops the descent at that branch (no error). LandblockInfo
/// records that fail to parse are skipped; their placements
/// don't contribute to the keep set.
pub fn compute_boot_keep_set(
    bundle: &LoadedBundle,
    boot_landblock: u32,
) -> HashSet<(String, u32)> {
    let mut keep: HashSet<(String, u32)> = HashSet::new();

    for &id in BOOT_ESSENTIAL_PORTAL_IDS {
        keep.insert((EOR_PORTAL_NAMESPACE.to_string(), id));
    }

    for cell_id in spawn_neighborhood_cells(boot_landblock) {
        let terrain = (cell_id << 16) | 0xFFFF;
        let info = (cell_id << 16) | 0xFFFE;
        keep.insert((EOR_CELL_NAMESPACE.to_string(), terrain));
        keep.insert((EOR_CELL_NAMESPACE.to_string(), info));
    }

    let bundle_source = BundleSource {
        records: &bundle.records,
    };
    for cell_id in spawn_neighborhood_cells(boot_landblock) {
        let info_id = (cell_id << 16) | 0xFFFE;
        let key = (EOR_CELL_NAMESPACE.to_string(), info_id);
        let Some(bytes) = bundle.records.get(&key) else {
            continue;
        };
        let Ok(info) = LandblockInfo::unpack(bytes) else {
            continue;
        };
        for stab in &info.objects {
            collect_model_dependencies(&bundle_source, stab.id, &mut keep);
        }
        for building in &info.buildings {
            collect_model_dependencies(&bundle_source, building.model_id, &mut keep);
        }
    }

    keep
}

/// `ResourceSource` adapter for the in-memory `LoadedBundle`.
/// Lets `holtburger_dat::walk` consume bundle records by
/// `(namespace, file_id)` without any additional plumbing.
struct BundleSource<'a> {
    records: &'a BTreeMap<(String, u32), Vec<u8>>,
}

impl<'a> ResourceSource for BundleSource<'a> {
    fn get_file_by_key(&self, key: ResourceKey<'_>) -> DatResult<Vec<u8>> {
        self.records
            .get(&(key.namespace.to_owned(), key.file_id))
            .cloned()
            .ok_or_else(|| {
                DatError::Other(format!(
                    "BundleSource: missing {}:{:#010X}",
                    key.namespace, key.file_id
                ))
            })
    }
    fn get_metadata_by_key(&self, key: ResourceKey<'_>) -> Option<FileMetadata> {
        self.records
            .get(&(key.namespace.to_owned(), key.file_id))
            .map(|b| FileMetadata {
                id: key.file_id,
                size: b.len() as u32,
                is_pruned: false,
            })
    }
    fn has_namespace(&self, namespace: &str) -> bool {
        self.records.keys().any(|(ns, _)| ns == namespace)
    }
}

/// Spawn-area 9-cell neighborhood. AC landblock IDs are encoded
/// as `0xXXYY` where `XX` is the world-X column and `YY` is the
/// world-Y row, both 0..255. The 9 cells are the boot landblock
/// itself plus its 8 grid neighbors.
pub fn spawn_neighborhood_cells(boot_landblock: u32) -> Vec<u32> {
    let bx = (boot_landblock >> 8) & 0xFF;
    let by = boot_landblock & 0xFF;
    let mut out = Vec::with_capacity(9);
    for dx in -1i32..=1 {
        for dy in -1i32..=1 {
            let nx = bx as i32 + dx;
            let ny = by as i32 + dy;
            if !(0..=255).contains(&nx) || !(0..=255).contains(&ny) {
                continue;
            }
            out.push(((nx as u32) << 8) | (ny as u32));
        }
    }
    out
}

pub fn write_shards(
    bundle: &LoadedBundle,
    output_dir: &Path,
) -> Result<BTreeMap<String, ShardEntry>> {
    let shards_dir = output_dir.join("shards");
    std::fs::create_dir_all(&shards_dir)
        .map_err(|e| ToolError::Validation(format!("create shards dir {shards_dir:?}: {e}")))?;

    let mut entries: BTreeMap<String, ShardEntry> = BTreeMap::new();
    let mut written: HashSet<String> = HashSet::new();

    for ((namespace, file_id), bytes) in &bundle.records {
        let hash = sha256_hex(bytes);
        let shard_relative = format!("shards/{hash}.bin");

        if written.insert(hash.clone()) {
            let shard_path = output_dir.join(&shard_relative);
            std::fs::write(&shard_path, bytes)
                .map_err(|e| ToolError::Validation(format!("write {shard_path:?}: {e}")))?;
        }

        entries.insert(
            format_shard_key(namespace, *file_id),
            ShardEntry {
                sha256: hash,
                size: bytes.len() as u64,
                url: shard_relative,
            },
        );
    }

    Ok(entries)
}

pub fn write_boot_pack(
    bundle: &LoadedBundle,
    boot_landblock: u32,
    output_dir: &Path,
) -> Result<BootPack> {
    let boot_path = output_dir.join("boot.hba");
    let mut writer = HbaStreamWriter::create(&boot_path)
        .map_err(|e| ToolError::HbaWrite(boot_path.clone(), e.to_string()))?;
    writer.set_compression(true);

    // Phase 5.1 — compute the full boot keep set including the
    // transitive walk through LandblockInfo placements. The walk
    // adds every GfxObj/SetupModel/Surface/SurfaceTexture/Texture/
    // Palette record reachable from the boot-landblock 9-cell
    // neighborhood, so the page can render the spawn area without
    // any shard fetches.
    let keep = compute_boot_keep_set(bundle, boot_landblock);

    let mut covers = Vec::new();
    for ((namespace, file_id), bytes) in &bundle.records {
        if !keep.contains(&(namespace.clone(), *file_id)) {
            continue;
        }
        // Type id is not preserved by the LoadedBundle (the bytes
        // are post-decompression record bodies). For boot-pack
        // emission we only need the namespace/file-id round-trip;
        // pass `0` for the type id. ManifestResourceSource ignores
        // it on the read side.
        writer
            .add(namespace, *file_id, 0, bytes.clone())
            .map_err(|e| ToolError::HbaWrite(boot_path.clone(), e.to_string()))?;
        covers.push(format_shard_key(namespace, *file_id));
    }

    writer
        .finish()
        .map_err(|e| ToolError::HbaWrite(boot_path.clone(), e.to_string()))?;

    let bytes = std::fs::read(&boot_path)
        .map_err(|e| ToolError::Validation(format!("re-read boot pack {boot_path:?}: {e}")))?;
    Ok(BootPack {
        url: "boot.hba".into(),
        size: bytes.len() as u64,
        sha256: sha256_hex(&bytes),
        covers,
    })
}

/// Compute sha256 of `bytes` and return both the full 32-byte
/// digest and its 16-byte truncation (the form stored in
/// [`NamespaceCatalog`] entries). Single-pass; avoids re-hashing.
fn sha256_full_and_trunc(bytes: &[u8]) -> ([u8; 32], [u8; 16]) {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let full: [u8; 32] = hasher.finalize().into();
    let mut trunc = [0u8; 16];
    trunc.copy_from_slice(&full[..16]);
    (full, trunc)
}

/// Encode 16 bytes as 32 lowercase hex chars. Mirrors the
/// `hex_encode_16` in `holtburger-resource-http::manifest_source`
/// — kept inline here because that helper isn't exported and
/// adding a re-export of a wasm-only crate's helper isn't worth it.
fn hex_encode_16(bytes: &[u8; 16]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(32);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Phase 5.2 obj 5 — write shards under a 2-level prefix directory
/// keyed by truncated sha256 (16 bytes / 32 hex chars), AND build
/// the per-namespace catalog entry list.
///
/// On-disk layout: `<output_dir>/shards/{first2}/{trunc32}.bin`,
/// where `first2` is the first 2 hex chars of the truncated digest
/// and `trunc32` is the full 32-char truncated hex. Mirrors
/// [`DEFAULT_SHARD_URL_TEMPLATE_PREFIXED`] which substitutes
/// `{sha256_prefix2}` and `{sha256}` (the runtime supplies the
/// truncated digest in both slots; see
/// `holtburger-resource-http::manifest_source` v2 prefetch path).
///
/// Dedupes by truncated digest. Truncation to 128 bits keeps
/// collision resistance to 2^64 — far beyond any realistic AC asset
/// count — while halving the catalog size compared to a full
/// 32-byte hash. The dev http.server can serve thousands of files
/// per directory comfortably; the prefix split keeps any single
/// directory under ~3500 entries (885k records / 256 prefixes).
pub fn write_shards_v2(
    bundle: &LoadedBundle,
    output_dir: &Path,
) -> Result<V2WriteShardsResult> {
    let shards_dir = output_dir.join("shards");
    std::fs::create_dir_all(&shards_dir)
        .map_err(|e| ToolError::Validation(format!("create shards dir {shards_dir:?}: {e}")))?;

    let mut written: HashSet<[u8; 16]> = HashSet::new();
    let mut catalogs: HashMap<String, Vec<CatalogEntry>> = HashMap::new();

    for ((namespace, file_id), bytes) in &bundle.records {
        let (_full, trunc) = sha256_full_and_trunc(bytes);
        let trunc_hex = hex_encode_16(&trunc);
        let prefix2 = &trunc_hex[..2];

        if written.insert(trunc) {
            let prefix_dir = shards_dir.join(prefix2);
            std::fs::create_dir_all(&prefix_dir).map_err(|e| {
                ToolError::Validation(format!("create shard prefix dir {prefix_dir:?}: {e}"))
            })?;
            let shard_path = prefix_dir.join(format!("{trunc_hex}.bin"));
            std::fs::write(&shard_path, bytes)
                .map_err(|e| ToolError::Validation(format!("write {shard_path:?}: {e}")))?;
        }

        catalogs.entry(namespace.clone()).or_default().push(CatalogEntry {
            file_id: *file_id,
            sha256_truncated: trunc,
            size: bytes.len() as u64,
        });
    }

    Ok(V2WriteShardsResult {
        catalogs,
        unique_shard_count: written.len(),
    })
}

/// Output of [`write_shards_v2`]: the per-namespace catalog entry
/// vectors (unsorted; [`NamespaceCatalog::new`] will sort) plus the
/// dedupe count for status reporting.
pub struct V2WriteShardsResult {
    pub catalogs: HashMap<String, Vec<CatalogEntry>>,
    pub unique_shard_count: usize,
}

/// Phase 5.2 obj 5 — write per-namespace [`NamespaceCatalog`]
/// binaries under `<output_dir>/manifest/{namespace_slug}.bin`.
/// Returns the sorted namespace list for inclusion in the v2
/// top-level manifest.
///
/// Catalogs are emitted as raw `.bin` (no bake-time gzip — the
/// brief defers gzip to deployment-time `Content-Encoding: gzip`
/// at the CDN edge, which is also the http.server / `python -m
/// http.server` dev story).
pub fn write_namespace_catalogs(
    catalogs: HashMap<String, Vec<CatalogEntry>>,
    output_dir: &Path,
) -> Result<Vec<String>> {
    let manifest_dir = output_dir.join("manifest");
    std::fs::create_dir_all(&manifest_dir).map_err(|e| {
        ToolError::Validation(format!("create manifest dir {manifest_dir:?}: {e}"))
    })?;

    let mut namespaces: Vec<String> = catalogs.keys().cloned().collect();
    namespaces.sort();

    for (namespace, entries) in catalogs {
        let catalog = NamespaceCatalog::new(namespace.clone(), 0, entries);
        let slug = namespace_slug(&namespace);
        let path = manifest_dir.join(format!("{slug}.bin"));
        let mut f = std::fs::File::create(&path).map_err(|e| {
            ToolError::Validation(format!("create catalog {path:?}: {e}"))
        })?;
        catalog.write_to(&mut f).map_err(|e| {
            ToolError::Validation(format!("write catalog {path:?}: {e}"))
        })?;
    }

    Ok(namespaces)
}

/// Phase 5.2 obj 5 — emit convention-URL symlinks at
/// `<output_dir>/shards/{namespace_slug}/0x{file_id:08X}.bin`,
/// each pointing to the canonical truncated-sha256 shard. Lets
/// pages configure `shard_url_template = "shards/{namespace_slug}/
/// {file_id_hex}.bin"` to fetch by `(namespace, file_id)` directly
/// without ever consulting a catalog. Both URLs serve the same
/// bytes.
///
/// Uses unix symlinks. On non-unix the call is a no-op + warning;
/// the dev workflow targets Linux exclusively (live stack is on
/// Tailscale-on-Linux per `docs/emit-dynamic-site.md`).
///
/// Idempotent: removes any pre-existing symlink at the target path
/// before linking, so re-bakes don't accumulate stale links.
pub fn write_convention_symlinks(
    catalogs: &HashMap<String, Vec<CatalogEntry>>,
    output_dir: &Path,
) -> Result<usize> {
    let shards_dir = output_dir.join("shards");
    let mut linked = 0usize;

    for (namespace, entries) in catalogs {
        let slug = namespace_slug(namespace);
        let ns_dir = shards_dir.join(&slug);
        std::fs::create_dir_all(&ns_dir).map_err(|e| {
            ToolError::Validation(format!("create symlink ns dir {ns_dir:?}: {e}"))
        })?;

        for entry in entries {
            let trunc_hex = hex_encode_16(&entry.sha256_truncated);
            // Relative path from `shards/<slug>/` up to
            // `shards/<prefix2>/<trunc_hex>.bin`.
            let target = format!("../{}/{}.bin", &trunc_hex[..2], trunc_hex);
            let link_path = ns_dir.join(format!("0x{:08X}.bin", entry.file_id));

            // Idempotent: remove existing link/file before
            // re-linking. Tolerate ENOENT (expected on first bake).
            let _ = std::fs::remove_file(&link_path);

            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(&target, &link_path).map_err(|e| {
                    ToolError::Validation(format!(
                        "symlink {link_path:?} -> {target}: {e}"
                    ))
                })?;
                linked += 1;
            }

            #[cfg(not(unix))]
            {
                log::warn!(
                    "convention-URL symlink skipped on non-unix: {link_path:?} -> {target}"
                );
                let _ = (target, link_path); // suppress unused warnings
            }
        }
    }

    Ok(linked)
}

/// Phase 5.2 obj 5 — end-to-end v2 orchestration. Reads input,
/// writes shards under the 2-level prefix layout, builds + writes
/// per-namespace catalogs, writes convention-URL symlinks, writes
/// the boot pack, writes `manifest.json` (v2 schema).
///
/// Returns a [`V2BakeResult`] with the in-memory manifest + counts
/// for status logging. The on-disk top-level `manifest.json` is
/// ≈800 bytes – 2 KB regardless of input size — the dominant
/// per-record listings live in the lazy-loaded per-namespace
/// catalogs.
pub fn shard_bundle_v2(opts: &DatShardOptions) -> Result<V2BakeResult> {
    std::fs::create_dir_all(&opts.output_dir).map_err(|e| {
        ToolError::Validation(format!("create output dir {:?}: {e}", opts.output_dir))
    })?;

    let bundle = read_input_bundle(opts)?;
    let total_records = bundle.records.len();

    let mut v2_shards = write_shards_v2(&bundle, &opts.output_dir)?;
    let mut unique_shard_count = v2_shards.unique_shard_count;

    // `--tex-bc7`: stream the BC7 blobs into the same shard layout and
    // splice their catalog entries into the namespace map, BEFORE the
    // catalog / symlink / manifest.json writes below. That ordering is
    // what makes the namespace self-declaring: `write_namespace_catalogs`
    // derives `manifest.namespaces` from this map's keys, and the client
    // only fetches a catalog for a namespace the manifest declares
    // (`manifest_source.rs:566`).
    let mut tex_bc7_records = 0usize;
    let mut tex_bc7_bytes = 0u64;
    let mut tex_bc7_skipped = 0usize;
    if let Some(tex_dir) = opts.tex_bc7.as_deref() {
        let ingest = ingest_tex_bc7_dir(tex_dir, &opts.output_dir)?;
        tex_bc7_records = ingest.entries.len();
        tex_bc7_bytes = ingest.total_bytes;
        tex_bc7_skipped = ingest.skipped.len();
        for (path, reason) in &ingest.skipped {
            log::warn!("--tex-bc7: skipped {path:?}: {reason}");
        }
        // The two dedupe sets are independent, so a BC7 blob whose
        // bytes exactly equal a DAT record's would be counted twice
        // here. Both writers emit identical bytes to the identical
        // content-addressed path, so the only consequence is the
        // count; a 20-byte "HBC7" header makes the collision
        // impossible in practice anyway.
        unique_shard_count += ingest.unique_shard_count;
        v2_shards
            .catalogs
            .entry(TEX_BC7_NAMESPACE.to_string())
            .or_default()
            .extend(ingest.entries);
    }

    let boot_pack_v1 = write_boot_pack(&bundle, opts.boot_landblock, &opts.output_dir)?;
    let boot_covers_count = boot_pack_v1.covers.len();
    // v2 wire format drops `covers` from BootPack — see
    // `holtburger_manifest::v2::BootPackV2` for the rationale
    // (boot-pack hit checks go through HbaReader::exists_by_key
    // at runtime, no need to ship the covers list to clients).
    let boot_pack: BootPackV2 = boot_pack_v1.into();

    write_convention_symlinks(&v2_shards.catalogs, &opts.output_dir)?;

    let namespaces = write_namespace_catalogs(v2_shards.catalogs, &opts.output_dir)?;
    let catalog_count = namespaces.len();

    let manifest = ManifestV2 {
        version: MANIFEST_V2_VERSION,
        generated_at: iso_8601_now(),
        source: bundle.source_meta,
        boot_pack,
        catalog_version: 1,
        namespaces,
        shard_url_template: DEFAULT_SHARD_URL_TEMPLATE_PREFIXED.into(),
        catalog_url_template: Some(DEFAULT_CATALOG_URL_TEMPLATE.into()),
    };

    let manifest_path = opts.output_dir.join("manifest.json");
    let json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| ToolError::Validation(format!("serialize v2 manifest: {e}")))?;
    std::fs::write(&manifest_path, &json).map_err(|e| {
        ToolError::Validation(format!("write {manifest_path:?}: {e}"))
    })?;

    Ok(V2BakeResult {
        manifest,
        total_records,
        unique_shard_count,
        catalog_count,
        boot_covers_count,
        tex_bc7_records,
        tex_bc7_bytes,
        tex_bc7_skipped,
    })
}

/// Phase 5.2 obj 5 — top-level dispatcher. Routes `opts` to the v1
/// or v2 emitter based on `opts.manifest_version`. CLI defaults to
/// 2 (the new wire format); `--manifest-version=1` keeps the
/// legacy emission for one release cycle.
pub fn shard_bundle_dispatch(opts: &DatShardOptions) -> Result<BakeOutput> {
    if opts.manifest_version != MANIFEST_V2_VERSION && opts.tex_bc7.is_some() {
        // v1 has no per-namespace catalogs and its top-level shard map
        // is the 203 MB cliff v2 exists to fix. Rather than emit a
        // manifest that silently omits the BC7 records, refuse.
        return Err(ToolError::Validation(format!(
            "--tex-bc7 requires --manifest-version={MANIFEST_V2_VERSION} (v1 has no per-namespace catalogs)"
        )));
    }
    match opts.manifest_version {
        1 => shard_bundle(opts).map(BakeOutput::V1),
        MANIFEST_V2_VERSION => shard_bundle_v2(opts).map(BakeOutput::V2),
        other => Err(ToolError::Validation(format!(
            "unsupported manifest version {other}: this build supports 1 or 2"
        ))),
    }
}

/// End-to-end orchestration. Reads the input, writes shards, writes
/// the boot pack, writes manifest.json. Returns the in-memory
/// manifest so callers / tests can inspect it without re-reading
/// the JSON.
pub fn shard_bundle(opts: &DatShardOptions) -> Result<Manifest> {
    std::fs::create_dir_all(&opts.output_dir).map_err(|e| {
        ToolError::Validation(format!("create output dir {:?}: {e}", opts.output_dir))
    })?;

    let bundle = read_input_bundle(opts)?;
    let shards = write_shards(&bundle, &opts.output_dir)?;
    let boot_pack = write_boot_pack(&bundle, opts.boot_landblock, &opts.output_dir)?;

    let manifest = Manifest {
        version: MANIFEST_VERSION,
        generated_at: iso_8601_now(),
        source: bundle.source_meta,
        boot_pack,
        shards,
    };
    let manifest_path = opts.output_dir.join("manifest.json");
    let json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| ToolError::Validation(format!("serialize manifest: {e}")))?;
    std::fs::write(&manifest_path, json)
        .map_err(|e| ToolError::Validation(format!("write {manifest_path:?}: {e}")))?;

    Ok(manifest)
}

fn iso_8601_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (year, month, day, hour, min, sec) = unix_to_components(secs);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}Z")
}

fn unix_to_components(mut t: u64) -> (i32, u32, u32, u32, u32, u32) {
    let sec = (t % 60) as u32;
    t /= 60;
    let min = (t % 60) as u32;
    t /= 60;
    let hour = (t % 24) as u32;
    let mut days = (t / 24) as i64;
    let mut year = 1970i32;
    loop {
        let yd = if is_leap(year) { 366 } else { 365 };
        if days < yd {
            break;
        }
        days -= yd;
        year += 1;
    }
    let months_lengths: [u32; 12] = [
        31,
        if is_leap(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 0;
    while month < 12 && days >= months_lengths[month] as i64 {
        days -= months_lengths[month] as i64;
        month += 1;
    }
    (year, (month + 1) as u32, (days as u32) + 1, hour, min, sec)
}

fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_hex_u32_accepts_prefixed_and_bare() {
        assert_eq!(parse_hex_u32("0xA9B4"), Ok(0xA9B4));
        assert_eq!(parse_hex_u32("a9b4"), Ok(0xA9B4));
        assert_eq!(parse_hex_u32("0X1234"), Ok(0x1234));
        assert!(parse_hex_u32("not-hex").is_err());
    }

    #[test]
    fn spawn_neighborhood_default_is_nine_cells_around_holtburg() {
        let cells = spawn_neighborhood_cells(0xA9B4);
        assert_eq!(cells.len(), 9);
        assert!(cells.contains(&0xA9B4));
        assert!(cells.contains(&0xA8B3));
        assert!(cells.contains(&0xAAB5));
    }

    #[test]
    fn spawn_neighborhood_clamps_at_world_edge() {
        let cells = spawn_neighborhood_cells(0x0000);
        assert_eq!(cells.len(), 4);
        assert!(cells.contains(&0x0000));
        assert!(cells.contains(&0x0001));
        assert!(cells.contains(&0x0100));
        assert!(cells.contains(&0x0101));
    }

    #[test]
    fn compute_boot_keep_set_includes_essentials_and_spawn_cells() {
        // The walk is a no-op on an empty bundle (no LandblockInfo
        // records to chase placements out of), so the keep set
        // should match the obj-3 minimum-viable: catalog
        // essentials + 9-cell terrain + LandblockInfo records.
        let bundle = LoadedBundle {
            records: BTreeMap::new(),
            source_meta: SourceMeta {
                portal_dat_iteration: 0,
                cell_dat_iteration: 0,
                local_dat_iteration: 0,
            },
        };
        let keep = compute_boot_keep_set(&bundle, 0xA9B4);
        // Catalog tables: 6 + UI font + 2 glyph atlases + gmDefaultMap = 10 portal records.
        assert!(keep.contains(&(EOR_PORTAL_NAMESPACE.to_string(), CharGen::FILE_ID)));
        assert!(keep.contains(&(EOR_PORTAL_NAMESPACE.to_string(), SkillTable::FILE_ID)));
        assert!(keep.contains(&(EOR_PORTAL_NAMESPACE.to_string(), UI_FONT_ID)));
        assert!(keep.contains(&(EOR_PORTAL_NAMESPACE.to_string(), UI_FONT_ATLAS_FG_ID)));
        assert!(keep.contains(&(EOR_PORTAL_NAMESPACE.to_string(), UI_FONT_ATLAS_BG_ID)));
        // Spawn 9-cell × 2 (terrain + LBI) = 18 cell records.
        assert!(keep.contains(&(EOR_CELL_NAMESPACE.to_string(), 0xA9B4_FFFF)));
        assert!(keep.contains(&(EOR_CELL_NAMESPACE.to_string(), 0xA9B4_FFFE)));
        assert!(keep.contains(&(EOR_CELL_NAMESPACE.to_string(), 0xA8B3_FFFF)));
        // 10 catalog + 18 cell = 28 entries (no walk-discovered
        // records for an empty bundle).
        assert_eq!(keep.len(), 10 + 18);
        // Far-away cells are not in the keep set.
        assert!(!keep.contains(&(EOR_CELL_NAMESPACE.to_string(), 0x0000_FFFF)));
    }

    /// Build a well-formed HBC7 blob for `w`×`h`.
    fn hbc7_blob(w: u32, h: u32) -> Vec<u8> {
        let (bx, by) = (w.div_ceil(4), h.div_ceil(4));
        let mut out = Vec::with_capacity(HBC7_HEADER_LEN + (bx * by) as usize * BC7_BLOCK_BYTES);
        out.extend_from_slice(HBC7_MAGIC);
        for v in [w, h, bx, by] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        // Distinct per-dims body so two blobs never dedupe by accident.
        for i in 0..(bx * by) as usize * BC7_BLOCK_BYTES {
            out.push((i as u8) ^ (w as u8));
        }
        out
    }

    #[test]
    fn validate_hbc7_accepts_padded_and_rejects_malformed() {
        // Exact multiple of 4 and a non-multiple (the padded case the
        // container spec calls out) both validate.
        assert_eq!(validate_hbc7(&hbc7_blob(256, 256)), Ok((256, 256)));
        assert_eq!(validate_hbc7(&hbc7_blob(30, 6)), Ok((30, 6)));

        // Truncated body — the concurrent-encode case.
        let mut short = hbc7_blob(64, 64);
        short.truncate(short.len() - 16);
        assert!(validate_hbc7(&short).is_err());

        // Bad magic.
        let mut wrong_magic = hbc7_blob(64, 64);
        wrong_magic[0] = b'X';
        assert!(validate_hbc7(&wrong_magic).is_err());

        // Header-only, empty, and a block grid that doesn't cover the
        // declared dims.
        assert!(validate_hbc7(&hbc7_blob(64, 64)[..HBC7_HEADER_LEN]).is_err());
        assert!(validate_hbc7(&[]).is_err());
        let mut bad_grid = hbc7_blob(64, 64);
        bad_grid[12..16].copy_from_slice(&8u32.to_le_bytes()); // blocks_x 16 -> 8
        assert!(validate_hbc7(&bad_grid).is_err());
    }

    #[test]
    fn parse_hbc7_file_name_accepts_both_spellings() {
        assert_eq!(
            parse_hbc7_file_name(Path::new("/x/0x06003789.hbc7")),
            Ok(0x0600_3789)
        );
        assert_eq!(
            parse_hbc7_file_name(Path::new("/x/06003789.hbc7")),
            Ok(0x0600_3789)
        );
        assert_eq!(
            parse_hbc7_file_name(Path::new("/x/0x0600378e.hbc7")),
            Ok(0x0600_378E)
        );
        assert!(parse_hbc7_file_name(Path::new("/x/README.hbc7")).is_err());
    }

    #[test]
    fn ingest_tex_bc7_dir_writes_content_addressed_shards() {
        let tmp = std::env::temp_dir().join(format!(
            "hb-tex-bc7-ingest-{}",
            std::process::id()
        ));
        let src = tmp.join("blocks");
        let out = tmp.join("out");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&src).expect("mk src");

        let a = hbc7_blob(256, 256);
        let b = hbc7_blob(64, 64);
        std::fs::write(src.join("0x06003789.hbc7"), &a).expect("write a");
        std::fs::write(src.join("0x0600378E.hbc7"), &b).expect("write b");
        // A duplicate of `a` under a different id must dedupe to ONE
        // shard file but still get its own catalog entry.
        std::fs::write(src.join("0x06003790.hbc7"), &a).expect("write dup");
        // Mid-write blob → skipped, not fatal.
        std::fs::write(src.join("0x060037FF.hbc7"), &b[..b.len() - 16]).expect("write partial");
        // Non-.hbc7 sibling → ignored silently.
        std::fs::write(src.join("encode-ledger.jsonl"), b"{}\n").expect("write ledger");

        let ingest = ingest_tex_bc7_dir(&src, &out).expect("ingest");
        assert_eq!(ingest.entries.len(), 3);
        assert_eq!(ingest.unique_shard_count, 2, "identical blobs share a shard");
        assert_eq!(ingest.skipped.len(), 1);
        assert_eq!(ingest.total_bytes, (a.len() * 2 + b.len()) as u64);

        // Every entry's shard file exists at the v2 path and holds the
        // exact source bytes.
        for entry in &ingest.entries {
            let hex = hex_encode_16(&entry.sha256_truncated);
            let path = out.join("shards").join(&hex[..2]).join(format!("{hex}.bin"));
            let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
            assert_eq!(bytes.len() as u64, entry.size);
            let expect = if entry.file_id == 0x0600_378E { &b } else { &a };
            assert_eq!(&bytes, expect, "shard bytes for 0x{:08X}", entry.file_id);
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn tex_bc7_requires_manifest_v2() {
        let opts = DatShardOptions {
            input_hba: None,
            eor_portal: None,
            eor_cell: None,
            eor_local: None,
            boot_landblock: 0xA9B4,
            output_dir: std::env::temp_dir().join("hb-tex-bc7-v1-reject"),
            manifest_version: 1,
            tex_bc7: Some(PathBuf::from("/nonexistent")),
        };
        let err = shard_bundle_dispatch(&opts).expect_err("v1 + --tex-bc7 must be refused");
        assert!(
            err.to_string().contains("--tex-bc7"),
            "error should name the flag, got: {err}"
        );
    }

    #[test]
    fn boot_essential_filter_picks_essentials_and_spawn_cells() {
        assert!(is_boot_essential(
            EOR_PORTAL_NAMESPACE,
            CharGen::FILE_ID,
            0xA9B4
        ));
        assert!(is_boot_essential(EOR_CELL_NAMESPACE, 0xA9B4_FFFF, 0xA9B4));
        assert!(is_boot_essential(EOR_CELL_NAMESPACE, 0xA9B4_FFFE, 0xA9B4));
        assert!(is_boot_essential(EOR_CELL_NAMESPACE, 0xA8B3_FFFF, 0xA9B4));
        assert!(!is_boot_essential(EOR_CELL_NAMESPACE, 0x0000_FFFF, 0xA9B4));
        assert!(!is_boot_essential(
            EOR_PORTAL_NAMESPACE,
            0x0100_0827,
            0xA9B4
        ));
    }
}
