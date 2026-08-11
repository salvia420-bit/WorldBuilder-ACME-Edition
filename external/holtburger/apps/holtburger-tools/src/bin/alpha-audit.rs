//! `alpha-audit` — DAT-truth alpha census over every RenderSurface, and the
//! corpus comparison that turns the TEXBC7-ALPHA-REBAKE re-bake into one
//! command (batch-D queue item `TEXBC7-ALPHA-REBAKE`).
//!
//! TWO MODES, ONE WALK
//! -------------------
//! *DAT-truth-only* (no `--corpus*` argument) is the census: every 0x06
//! record in the portal DAT(s), classified `opaque` /
//! `fully-transparent` / `punch-through` / `gradient-alpha` against the
//! retail bytes, bucketed by class × PFID × surface class. It answers
//! "which surfaces even matter" before anyone touches an upscaler, and it
//! is the mode that runs anywhere the DATs are.
//!
//! *Corpus* mode (`--corpus DIR` / `--corpus-hba FILE`) adds the other half
//! of the comparison: for each record the upscaler produced a payload for,
//! the payload's alpha is classified the same way and the pair gets a
//! verdict — KEEP / REBAKE / SKIP — with the reason on the row.
//!
//! THE SURFACE INDEX COMES FIRST
//! -----------------------------
//! A palettized record's alpha is not a property of the record alone:
//! retail `ImgTex::CopyIntoData` makes palette index < 8 transparent when
//! the referencing Surface (0x08) is `Base1ClipMap`. So the tool walks
//! `Surface -> SurfaceTexture (0x05) -> Texture (0x06)` first and decodes
//! each record under the clipmap bit its own references imply. That index
//! is also what flags the `Base1ClipMap` rows the queue item asks for by
//! name, and what separates "referenced by a real surface" from the mip
//! rungs nothing points at directly.
//!
//! USAGE
//! -----
//! ```text
//! # census only (the box):
//! alpha-audit --dat ~/ac_base_dats/client_portal.dat --out-dir /tmp/alpha-audit
//!
//! # laptop, with the hires DAT overlaid and the corpus lanes compared:
//! alpha-audit --dat <base portal dat> --dat <hires repaired dat> \
//!             --corpus <upscale PNG lane> --corpus <xu7 ktx2 lane> \
//!             --corpus-hba <dist tex-bc7 archive> --corpus-hba-ns holtburger/tex-bc7 \
//!             --out-dir <report dir>
//! ```
//! Every path is an ARGUMENT. Nothing under `/mnt` is compiled in.
//!
//! DETERMINISM / PROVENANCE
//! ------------------------
//! Rows are emitted in ascending id order; every bucket is a `BTreeMap`;
//! there is no timestamp anywhere in the output. The summary carries the
//! sha256 of every input DAT and of every corpus payload it read, the way
//! the bake tools do — so a verdict file can always be traced to the bytes
//! that produced it.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use clap::Parser;
use holtburger_dat::file_type::{Palette, Surface, SurfaceTexture, Texture, TextureDecodeError};
use holtburger_dat::{DatDatabase, HbaReader};
use holtburger_tools::alpha_audit::{
    AlphaClass, Buckets, CorpusAlphaFacts, DatAlphaFacts, FLAG_CLIPMAP,
    FLAG_DIMS_NOT_INTEGER_SCALE, Verdict, bump, classify_corpus_payload, classify_texture, decide,
    format_carries_alpha, SURFACE_ADDITIVE, SURFACE_ALPHA, SURFACE_BASE1_CLIPMAP,
    SURFACE_BASE1_IMAGE, SURFACE_INV_ALPHA, SURFACE_TRANSLUCENT,
};
use holtburger_tools::error::{Result, ToolError};
use rayon::prelude::*;
use serde::Serialize;
use sha2::{Digest, Sha256};

const TEXTURE_TYPE_PREFIX: u32 = 0x06;
const SURFACE_TYPE_PREFIX: u32 = 0x08;
const DEFAULT_HBA_NAMESPACE: &str = "holtburger/tex-bc7";

#[derive(Parser, Debug)]
#[command(
    author,
    version,
    about = "Audit RenderSurface alpha against DAT truth (TEXBC7-ALPHA-REBAKE)"
)]
struct Args {
    /// Portal DAT(s) to read RenderSurfaces from. Repeatable: a later DAT
    /// OVERRIDES an earlier one for the same id (hires-overlay semantics),
    /// and every row records which DAT it came from.
    #[arg(long = "dat", value_name = "PATH", required = true, num_args = 1..)]
    dats: Vec<PathBuf>,

    /// Corpus directory of upscaled payloads named `<rsId>.png` / `.ktx2`
    /// / `.hbc7` — the three containers the lanes ship (upscale corpus,
    /// `--tex-xu7` ingest, `--tex-bc7` ingest). Repeatable, one per lane.
    /// Omit for DAT-truth-only mode.
    #[arg(long = "corpus", value_name = "DIR")]
    corpus_dirs: Vec<PathBuf>,

    /// HBA archive whose entries are upscaled payloads (the shipped
    /// `holtburger/tex-bc7` lane). Repeatable.
    #[arg(long = "corpus-hba", value_name = "FILE")]
    corpus_hbas: Vec<PathBuf>,

    /// Namespace to read from each `--corpus-hba`.
    #[arg(long, value_name = "NS", default_value = DEFAULT_HBA_NAMESPACE)]
    corpus_hba_ns: String,

    /// Write `verdicts.jsonl`, `summary.json` and `PROVENANCE.md` here.
    /// Without it only the summary is printed.
    #[arg(long, value_name = "DIR")]
    out_dir: Option<PathBuf>,

    /// Emit rows only for records whose PFID can carry alpha. The census
    /// counters always cover every record either way.
    #[arg(long)]
    only_alpha: bool,

    /// Treat an undetermined corpus alpha as REBAKE instead of KEEP. Use on
    /// a lane where shipping an unverified payload is worse than a
    /// re-encode.
    #[arg(long)]
    strict_unknown: bool,

    /// Restrict the walk to these ids (one hex id per line, `#` comments).
    #[arg(long, value_name = "FILE")]
    ids: Option<PathBuf>,

    /// Skip the input-DAT sha256 (a 927 MB hash costs a few seconds). The
    /// summary then records `"skipped"` — never a wrong hash.
    #[arg(long)]
    no_dat_sha: bool,
}

// ---------------------------------------------------------------------------
// Surface index: what references a RenderSurface, and how
// ---------------------------------------------------------------------------

/// Everything the Surface (0x08) layer says about one RenderSurface id.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SurfaceRefs {
    /// A `Base1ClipMap` Surface references it — retail's palette-index < 8
    /// transparency applies, and this is the class the queue item asks to
    /// be flagged by name.
    clipmap: bool,
    /// A `Base1Image` (non-clipmap) Surface references it.
    image: bool,
    /// Any referencing Surface sets `Translucent` / `Alpha` / `InvAlpha` /
    /// `Additive` — blend states that make alpha load-bearing even when the
    /// texture itself is opaque.
    blended: bool,
    /// Referencing Surface ids (0x08), ascending.
    surfaces: Vec<String>,
    /// Distinct non-zero `orig_palette_id` recolours seen. > 0 means the
    /// record's decoded alpha depends on which surface you look through.
    palette_overrides: usize,
    /// It is the highest-res rung of at least one SurfaceTexture chain —
    /// i.e. what the renderer (and the upscaler) actually consumes.
    highest_res: bool,
}

impl SurfaceRefs {
    /// The census axis the queue item names: which population does this
    /// record belong to.
    fn class(&self) -> &'static str {
        if self.clipmap && self.image {
            "clipmap+image"
        } else if self.clipmap {
            "clipmap"
        } else if self.image {
            "image"
        } else {
            "unreferenced"
        }
    }
}

/// Walk every Surface (0x08) -> SurfaceTexture (0x05) -> Texture (0x06)
/// chain and fold it into a per-RenderSurface index.
///
/// Read-verified chain: `file_type/surface.rs` — `Surface.orig_texture_id`
/// is a SurfaceTexture (0x05) id despite the name; `SurfaceTexture.textures`
/// is the mip list, last = highest res.
fn build_surface_index(dats: &[LoadedDat]) -> BTreeMap<u32, SurfaceRefs> {
    let mut index: BTreeMap<u32, SurfaceRefs> = BTreeMap::new();
    let mut palette_overrides: BTreeMap<u32, BTreeSet<u32>> = BTreeMap::new();

    let mut surface_ids: BTreeSet<u32> = BTreeSet::new();
    for d in dats {
        surface_ids.extend(d.ids_with_prefix(SURFACE_TYPE_PREFIX));
    }

    for sid in surface_ids {
        let Some((db, _)) = resolve(dats, sid) else { continue };
        let Ok(bytes) = db.get_file(sid) else { continue };
        let Ok(surface) = Surface::unpack(&bytes) else { continue };
        let Some(refs) = surface.texture_refs.as_ref() else { continue };

        let clipmap = (surface.surface_type & SURFACE_BASE1_CLIPMAP) != 0;
        let image = (surface.surface_type & SURFACE_BASE1_IMAGE) != 0;
        let blended = (surface.surface_type
            & (SURFACE_TRANSLUCENT | SURFACE_ALPHA | SURFACE_INV_ALPHA | SURFACE_ADDITIVE))
            != 0;

        // The 0x05 rung. A Surface can point at a missing SurfaceTexture in
        // a partial DAT set; that is a skip, not an abort.
        let Some((st_db, _)) = resolve(dats, refs.orig_texture_id) else { continue };
        let Ok(st_bytes) = st_db.get_file(refs.orig_texture_id) else { continue };
        let Ok(st) = SurfaceTexture::unpack(&st_bytes) else { continue };
        let highest = st.highest_res();

        for &tid in &st.textures {
            let e = index.entry(tid).or_default();
            e.clipmap |= clipmap;
            e.image |= image;
            e.blended |= blended;
            e.highest_res |= Some(tid) == highest;
            let label = format!("0x{sid:08X}");
            if !e.surfaces.contains(&label) {
                e.surfaces.push(label);
            }
            if refs.orig_palette_id != 0 {
                palette_overrides.entry(tid).or_default().insert(refs.orig_palette_id);
            }
        }
    }

    for (tid, set) in palette_overrides {
        if let Some(e) = index.get_mut(&tid) {
            e.palette_overrides = set.len();
        }
    }
    index
}

// ---------------------------------------------------------------------------
// DAT set with hires-overlay semantics
// ---------------------------------------------------------------------------

struct LoadedDat {
    path: PathBuf,
    label: String,
    sha256: String,
    db: DatDatabase,
}

impl LoadedDat {
    fn ids_with_prefix(&self, prefix: u32) -> Vec<u32> {
        let mut v: Vec<u32> = self.db.files.keys().copied().filter(|id| id >> 24 == prefix).collect();
        v.sort_unstable();
        v
    }
}

/// Last DAT wins — that is what "overlay the hires DAT" means.
fn resolve(dats: &[LoadedDat], id: u32) -> Option<(&DatDatabase, &str)> {
    dats.iter().rev().find(|d| d.db.files.contains_key(&id)).map(|d| (&d.db, d.label.as_str()))
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut f = std::fs::File::open(path)
        .map_err(|e| ToolError::Validation(format!("open {path:?}: {e}")))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut f, &mut hasher)
        .map_err(|e| ToolError::Validation(format!("hash {path:?}: {e}")))?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn parse_rs_id(stem: &str) -> Option<u32> {
    let s = stem.strip_prefix("0x").or_else(|| stem.strip_prefix("0X")).unwrap_or(stem);
    if s.len() != 8 {
        return None;
    }
    u32::from_str_radix(s, 16).ok()
}

// ---------------------------------------------------------------------------
// Corpus lanes
// ---------------------------------------------------------------------------

enum CorpusLane {
    Dir { label: String, members: BTreeMap<u32, PathBuf> },
    Hba { label: String, ns: String, reader: HbaReader, ids: BTreeSet<u32> },
}

impl CorpusLane {
    fn label(&self) -> &str {
        match self {
            Self::Dir { label, .. } | Self::Hba { label, .. } => label,
        }
    }

    fn len(&self) -> usize {
        match self {
            Self::Dir { members, .. } => members.len(),
            Self::Hba { ids, .. } => ids.len(),
        }
    }

    fn read(&self, id: u32) -> Option<Vec<u8>> {
        match self {
            Self::Dir { members, .. } => members.get(&id).and_then(|p| std::fs::read(p).ok()),
            Self::Hba { reader, ns, ids, .. } => {
                ids.contains(&id).then(|| reader.get_file_in_namespace(ns, id).ok()).flatten()
            }
        }
    }
}

fn load_dir_lane(dir: &Path) -> Result<CorpusLane> {
    let mut members = BTreeMap::new();
    for entry in std::fs::read_dir(dir)
        .map_err(|e| ToolError::Validation(format!("read_dir {dir:?}: {e}")))?
    {
        let entry = entry.map_err(|e| ToolError::Validation(format!("dir entry: {e}")))?;
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !matches!(ext, "png" | "ktx2" | "hbc7") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        let Some(id) = parse_rs_id(stem) else { continue };
        // A lane may ship more than one container for one id; the PNG lane
        // is the only EXACT one, so it wins whatever it is next to.
        let replace = ext == "png" || !members.contains_key(&id);
        if replace {
            members.insert(id, path);
        }
    }
    Ok(CorpusLane::Dir { label: dir.display().to_string(), members })
}

fn load_hba_lane(path: &Path, ns: &str) -> Result<CorpusLane> {
    let reader = HbaReader::open(path)
        .map_err(|e| ToolError::Validation(format!("open HBA {path:?}: {e}")))?;
    let mut ids = BTreeSet::new();
    for entry in reader.entries() {
        let entry = entry.map_err(|e| ToolError::Validation(format!("HBA entry: {e}")))?;
        let matches_ns = entry.namespace_id().map(|n| n.as_str() == ns).unwrap_or(false);
        if matches_ns && !entry.is_pruned() {
            ids.insert(entry.file_id);
        }
    }
    Ok(CorpusLane::Hba {
        label: format!("{}#{}", path.display(), ns),
        ns: ns.to_string(),
        reader,
        ids,
    })
}

// ---------------------------------------------------------------------------
// Rows + summary
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CorpusRow {
    lane: String,
    corpus_alpha_class: AlphaClass,
    verdict: Verdict,
    reason: String,
    flags: Vec<String>,
    payload_sha256: String,
    payload_bytes: u64,
    alpha: CorpusAlphaFacts,
}

/// One JSONL row. The first six fields are the contract the queue item
/// names — `id`, `datAlphaClass`, `corpusAlphaClass`, `verdict`, `reason` —
/// so `jq -r 'select(.verdict=="REBAKE") | .id'` is the whole re-bake list.
/// Everything after them is the evidence.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditRow {
    id: String,
    dat: String,
    dat_alpha_class: AlphaClass,
    /// The class of the lane that produced `verdict`. Absent in
    /// DAT-truth-only mode and when no lane carries a payload.
    #[serde(skip_serializing_if = "Option::is_none")]
    corpus_alpha_class: Option<AlphaClass>,
    /// The strongest verdict across lanes (REBAKE > SKIP > KEEP), so a
    /// consumer can filter on one field. Absent in DAT-truth-only mode.
    #[serde(skip_serializing_if = "Option::is_none")]
    verdict: Option<Verdict>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    dat_alpha: DatAlphaFacts,
    surface_class: String,
    refs: SurfaceRefs,
    /// Present only in corpus mode; one entry per lane that has a payload.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    corpus: Vec<CorpusRow>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    tool: String,
    mode: String,
    dats: Vec<DatProvenance>,
    corpus_lanes: Vec<LaneProvenance>,
    strict_unknown: bool,
    /// Every 0x06 record seen (after `--ids`, before `--only-alpha`).
    records: u64,
    /// Records whose PFID can carry alpha at all.
    alpha_capable_records: u64,
    /// Records whose decoded plane actually bears alpha.
    alpha_bearing_records: u64,
    rows_emitted: u64,
    by_alpha_class: Buckets,
    by_format: Buckets,
    by_alpha_source: Buckets,
    by_surface_class: Buckets,
    /// class × surface class — the "which surfaces even matter" cross-tab.
    class_by_surface_class: Buckets,
    /// `Base1ClipMap` rows only, by alpha class. The queue item's flagged
    /// population.
    clipmap_by_alpha_class: Buckets,
    /// Highest-res rungs only (what the upscaler consumes), by alpha class.
    highest_res_by_alpha_class: Buckets,
    decode_failures: u64,
    decode_failure_reasons: Buckets,
    // --- corpus mode only ---
    corpus_matched: u64,
    corpus_missing: u64,
    by_verdict: Buckets,
    by_flag: Buckets,
    rebake_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DatProvenance {
    path: String,
    label: String,
    sha256: String,
    texture_records: u64,
    surface_records: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaneProvenance {
    label: String,
    members: u64,
    payloads_read: u64,
}

fn strongest(a: Verdict, b: Verdict) -> Verdict {
    // REBAKE dominates: if ANY lane must be re-encoded, the id must be.
    match (a, b) {
        (Verdict::Rebake, _) | (_, Verdict::Rebake) => Verdict::Rebake,
        (Verdict::Skip, _) | (_, Verdict::Skip) => Verdict::Skip,
        _ => Verdict::Keep,
    }
}

// ---------------------------------------------------------------------------

fn main() -> Result<()> {
    let args = Args::parse();

    // --- inputs -------------------------------------------------------
    let mut dats = Vec::new();
    for path in &args.dats {
        if !path.is_file() {
            return Err(ToolError::Validation(format!("--dat {path:?} is not a file")));
        }
        let db = DatDatabase::new(path)
            .map_err(|e| ToolError::DatOpen(path.clone(), e.to_string()))?;
        let label = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("dat")
            .to_string();
        let sha256 =
            if args.no_dat_sha { "skipped".to_string() } else { sha256_file(path)? };
        dats.push(LoadedDat { path: path.clone(), label, sha256, db });
    }

    let id_filter: Option<BTreeSet<u32>> = match &args.ids {
        Some(p) => {
            let text = std::fs::read_to_string(p)
                .map_err(|e| ToolError::Validation(format!("read {p:?}: {e}")))?;
            let mut set = BTreeSet::new();
            for line in text.lines() {
                let line = line.split('#').next().unwrap_or("").trim();
                if line.is_empty() {
                    continue;
                }
                match parse_rs_id(line) {
                    Some(id) => {
                        set.insert(id);
                    }
                    None => {
                        return Err(ToolError::Validation(format!("bad id in {p:?}: {line}")));
                    }
                }
            }
            Some(set)
        }
        None => None,
    };

    let mut lanes: Vec<CorpusLane> = Vec::new();
    for dir in &args.corpus_dirs {
        if !dir.is_dir() {
            return Err(ToolError::Validation(format!("--corpus {dir:?} is not a directory")));
        }
        lanes.push(load_dir_lane(dir)?);
    }
    for hba in &args.corpus_hbas {
        if !hba.is_file() {
            return Err(ToolError::Validation(format!("--corpus-hba {hba:?} is not a file")));
        }
        lanes.push(load_hba_lane(hba, &args.corpus_hba_ns)?);
    }
    let corpus_mode = !lanes.is_empty();

    // --- the Surface (0x08) index -------------------------------------
    eprintln!("alpha-audit: indexing Surface -> SurfaceTexture -> Texture chains…");
    let surface_index = build_surface_index(&dats);

    // --- the record set ------------------------------------------------
    let mut ids: BTreeSet<u32> = BTreeSet::new();
    for d in &dats {
        ids.extend(d.ids_with_prefix(TEXTURE_TYPE_PREFIX));
    }
    if let Some(keep) = &id_filter {
        ids.retain(|id| keep.contains(id));
    }
    let ids: Vec<u32> = ids.into_iter().collect();
    eprintln!(
        "alpha-audit: {} RenderSurface records across {} DAT(s); {} referenced by a Surface",
        ids.len(),
        dats.len(),
        surface_index.len()
    );

    // --- classify (parallel; DatDatabase reads are positional/pread) ---
    let bar = indicatif::ProgressBar::new(ids.len() as u64);
    let empty_refs = SurfaceRefs::default();
    let mut rows: Vec<AuditRow> = ids
        .par_iter()
        .map(|&id| {
            bar.inc(1);
            let refs = surface_index.get(&id).unwrap_or(&empty_refs).clone();
            let (db, dat_label) = resolve(&dats, id).expect("id came from a loaded DAT");
            let dat_alpha = match db.get_file(id).ok().and_then(|b| Texture::unpack(&b).ok()) {
                Some(tex) => classify_texture(&tex, refs.clipmap, 0, |pid| {
                    let bytes = db
                        .get_file(pid)
                        .map_err(|e| TextureDecodeError::PaletteFetch(e.to_string()))?;
                    Palette::unpack(&bytes)
                        .map_err(|e| TextureDecodeError::PaletteFetch(e.to_string()))
                }),
                None => DatAlphaFacts {
                    class: AlphaClass::Undetermined,
                    source: holtburger_tools::alpha_audit::AlphaSource::Unsupported,
                    format: "unparseable".into(),
                    format_raw: 0,
                    width: 0,
                    height: 0,
                    stats: Default::default(),
                    partial_frac: 0.0,
                    zero_frac: 0.0,
                    effectively_binary: false,
                    decode_error: Some("record did not parse as a Texture".into()),
                },
            };
            let surface_class = refs.class().to_string();
            AuditRow {
                id: format!("0x{id:08X}"),
                dat: dat_label.to_string(),
                dat_alpha_class: dat_alpha.class,
                corpus_alpha_class: None,
                verdict: None,
                reason: None,
                dat_alpha,
                surface_class,
                refs,
                corpus: Vec::new(),
            }
        })
        .collect();
    bar.finish_and_clear();

    // --- corpus comparison ---------------------------------------------
    let mut lane_reads: Vec<u64> = vec![0; lanes.len()];
    if corpus_mode {
        eprintln!("alpha-audit: comparing {} corpus lane(s)…", lanes.len());
        let bar = indicatif::ProgressBar::new(rows.len() as u64);
        for (row, &id) in rows.iter_mut().zip(ids.iter()) {
            bar.inc(1);
            // `par_iter().map().collect()` over an indexed iterator is
            // order-preserving, so this zip is sound — but every verdict on
            // every row depends on it, so it is checked rather than assumed.
            assert_eq!(row.id, format!("0x{id:08X}"), "row/id order diverged");
            for (li, lane) in lanes.iter().enumerate() {
                let Some(bytes) = lane.read(id) else { continue };
                lane_reads[li] += 1;
                let facts = classify_corpus_payload(&bytes);
                let (verdict, reason, mut flags) =
                    decide(row.dat_alpha_class, facts.class, args.strict_unknown);
                let mut flags: Vec<String> = flags.drain(..).map(String::from).collect();
                if row.refs.clipmap {
                    flags.push(FLAG_CLIPMAP.to_string());
                }
                // Dimension sanity: the upscaler is an integer scaler, so a
                // payload whose dims are not an integer multiple of the DAT
                // record's is a second, independent finding.
                let (dw, dh) = (row.dat_alpha.width, row.dat_alpha.height);
                if dw > 0 && dh > 0 && facts.width > 0 && facts.height > 0 {
                    let non_integer = !facts.width.is_multiple_of(dw)
                        || !facts.height.is_multiple_of(dh)
                        || facts.width / dw != facts.height / dh;
                    if non_integer {
                        flags.push(FLAG_DIMS_NOT_INTEGER_SCALE.to_string());
                    }
                }
                row.corpus.push(CorpusRow {
                    lane: lane.label().to_string(),
                    corpus_alpha_class: facts.class,
                    verdict,
                    reason: reason.to_string(),
                    flags,
                    payload_sha256: sha256_hex(&bytes),
                    payload_bytes: bytes.len() as u64,
                    alpha: facts,
                });
            }
            if row.corpus.is_empty() {
                row.verdict = Some(Verdict::Skip);
                row.reason = Some("no corpus lane carries a payload for this record".into());
            } else {
                let v = row.corpus.iter().map(|c| c.verdict).fold(Verdict::Keep, strongest);
                // The lane that PRODUCED the winning verdict is the one whose
                // class and reason get promoted — a summary that promoted a
                // KEEP lane's class beside a REBAKE verdict would read as a
                // contradiction.
                let winner = row.corpus.iter().find(|c| c.verdict == v);
                row.corpus_alpha_class = winner.map(|c| c.corpus_alpha_class);
                row.reason = winner.map(|c| c.reason.clone());
                row.verdict = Some(v);
            }
        }
        bar.finish_and_clear();
    }

    // --- census ---------------------------------------------------------
    let mut s = Summary {
        tool: format!("alpha-audit {}", env!("CARGO_PKG_VERSION")),
        mode: if corpus_mode { "corpus".into() } else { "dat-truth-only".into() },
        strict_unknown: args.strict_unknown,
        ..Default::default()
    };
    for d in &dats {
        s.dats.push(DatProvenance {
            path: d.path.display().to_string(),
            label: d.label.clone(),
            sha256: d.sha256.clone(),
            texture_records: d.ids_with_prefix(TEXTURE_TYPE_PREFIX).len() as u64,
            surface_records: d.ids_with_prefix(SURFACE_TYPE_PREFIX).len() as u64,
        });
    }
    for (li, lane) in lanes.iter().enumerate() {
        s.corpus_lanes.push(LaneProvenance {
            label: lane.label().to_string(),
            members: lane.len() as u64,
            payloads_read: lane_reads[li],
        });
    }

    for row in &rows {
        s.records += 1;
        let cls = row.dat_alpha_class.as_str();
        bump(&mut s.by_alpha_class, cls);
        bump(&mut s.by_format, row.dat_alpha.format.clone());
        bump(&mut s.by_alpha_source, format!("{:?}", row.dat_alpha.source));
        bump(&mut s.by_surface_class, row.surface_class.clone());
        bump(&mut s.class_by_surface_class, format!("{}/{}", row.surface_class, cls));
        if row.refs.clipmap {
            bump(&mut s.clipmap_by_alpha_class, cls);
        }
        if row.refs.highest_res {
            bump(&mut s.highest_res_by_alpha_class, cls);
        }
        if row.dat_alpha_class.bears_alpha() {
            s.alpha_bearing_records += 1;
        }
        if let Some(e) = &row.dat_alpha.decode_error {
            s.decode_failures += 1;
            bump(&mut s.decode_failure_reasons, e.clone());
        }
        if corpus_mode {
            if row.corpus.is_empty() {
                s.corpus_missing += 1;
            } else {
                s.corpus_matched += 1;
            }
            if let Some(v) = row.verdict {
                bump(&mut s.by_verdict, v.as_str());
                if v == Verdict::Rebake {
                    s.rebake_ids.push(row.id.clone());
                }
            }
            for c in &row.corpus {
                for f in &c.flags {
                    bump(&mut s.by_flag, f.clone());
                }
            }
        }
    }
    // Alpha CAPABILITY is a property of the PFID, so it is counted off the
    // format label rather than the decoded class.
    s.alpha_capable_records = rows
        .iter()
        .filter(|r| {
            format_carries_alpha(holtburger_dat::file_type::SurfacePixelFormat::from_u32(
                r.dat_alpha.format_raw,
            ))
        })
        .count() as u64;

    if args.only_alpha {
        rows.retain(|r| {
            format_carries_alpha(holtburger_dat::file_type::SurfacePixelFormat::from_u32(
                r.dat_alpha.format_raw,
            ))
        });
    }
    s.rows_emitted = rows.len() as u64;

    // --- output ---------------------------------------------------------
    print_summary(&s);

    if let Some(dir) = &args.out_dir {
        std::fs::create_dir_all(dir)
            .map_err(|e| ToolError::Validation(format!("create {dir:?}: {e}")))?;
        let mut jsonl = String::new();
        for row in &rows {
            let _ = writeln!(jsonl, "{}", serde_json::to_string(row).unwrap());
        }
        std::fs::write(dir.join("verdicts.jsonl"), &jsonl)
            .map_err(|e| ToolError::Validation(format!("write verdicts.jsonl: {e}")))?;
        std::fs::write(dir.join("summary.json"), serde_json::to_string_pretty(&s).unwrap())
            .map_err(|e| ToolError::Validation(format!("write summary.json: {e}")))?;
        std::fs::write(dir.join("PROVENANCE.md"), provenance_md(&s))
            .map_err(|e| ToolError::Validation(format!("write PROVENANCE.md: {e}")))?;
        eprintln!("alpha-audit: wrote {dir:?} (verdicts.jsonl + summary.json + PROVENANCE.md)");
    }

    Ok(())
}

fn print_summary(s: &Summary) {
    println!("=== alpha-audit ({}) ===", s.mode);
    for d in &s.dats {
        println!(
            "  dat {} — {} RenderSurface / {} Surface records; sha256 {}",
            d.label, d.texture_records, d.surface_records, d.sha256
        );
    }
    for l in &s.corpus_lanes {
        println!("  lane {} — {} members, {} read", l.label, l.members, l.payloads_read);
    }
    println!(
        "  {} records — {} alpha-capable PFID / {} actually bearing alpha; {} decode failures",
        s.records, s.alpha_capable_records, s.alpha_bearing_records, s.decode_failures
    );
    let table = |name: &str, b: &Buckets| {
        if b.is_empty() {
            return;
        }
        println!("  {name}:");
        for (k, v) in b {
            println!("    {k:<28} {v}");
        }
    };
    table("by alpha class", &s.by_alpha_class);
    table("by PFID", &s.by_format);
    table("by surface class", &s.by_surface_class);
    table("surface class / alpha class", &s.class_by_surface_class);
    table("Base1ClipMap rows by alpha class", &s.clipmap_by_alpha_class);
    table("highest-res rungs by alpha class", &s.highest_res_by_alpha_class);
    table("decode failures", &s.decode_failure_reasons);
    if !s.corpus_lanes.is_empty() {
        println!("  corpus: {} matched / {} missing", s.corpus_matched, s.corpus_missing);
        table("by verdict", &s.by_verdict);
        table("by flag", &s.by_flag);
        println!("  REBAKE ids: {}", s.rebake_ids.len());
    }
}

fn provenance_md(s: &Summary) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "# alpha-audit report\n");
    let _ = writeln!(
        out,
        "Produced by `{}` (batch-D `TEXBC7-ALPHA-REBAKE` — the audit half).\n\
         Mode: **{}**. `--strict-unknown`: {}.\n",
        s.tool, s.mode, s.strict_unknown
    );
    let _ = writeln!(out, "## Inputs\n");
    for d in &s.dats {
        let _ = writeln!(
            out,
            "- `{}` — sha256 `{}` ({} RenderSurface, {} Surface records)",
            d.path, d.sha256, d.texture_records, d.surface_records
        );
    }
    for l in &s.corpus_lanes {
        let _ = writeln!(out, "- corpus lane `{}` — {} members, {} read", l.label, l.members, l.payloads_read);
    }
    let _ = writeln!(
        out,
        "\n## Census\n\n\
         - records: {}\n- alpha-capable PFID: {}\n- actually bearing alpha: {}\n\
         - decode failures: {}\n- rows emitted: {}\n",
        s.records, s.alpha_capable_records, s.alpha_bearing_records, s.decode_failures,
        s.rows_emitted
    );
    let _ = writeln!(out, "By alpha class:\n");
    for (k, v) in &s.by_alpha_class {
        let _ = writeln!(out, "- `{k}`: {v}");
    }
    let _ = writeln!(out, "\nBase1ClipMap rows by alpha class:\n");
    for (k, v) in &s.clipmap_by_alpha_class {
        let _ = writeln!(out, "- `{k}`: {v}");
    }
    if !s.corpus_lanes.is_empty() {
        let _ = writeln!(out, "\n## Verdicts\n");
        for (k, v) in &s.by_verdict {
            let _ = writeln!(out, "- `{k}`: {v}");
        }
        let _ = writeln!(out, "\nFlags:\n");
        for (k, v) in &s.by_flag {
            let _ = writeln!(out, "- `{k}`: {v}");
        }
        let _ = writeln!(out, "\n### REBAKE set ({} ids)\n", s.rebake_ids.len());
        for id in &s.rebake_ids {
            let _ = writeln!(out, "- `{id}`");
        }
    }
    let _ = writeln!(
        out,
        "\n## Reading a row\n\n\
         `verdicts.jsonl` is one JSON object per RenderSurface, ascending id.\n\
         `datAlphaClass` is the retail truth; `corpus[]` carries one entry per\n\
         lane with that lane's class, its own verdict and the payload sha256.\n\
         The top-level `verdict` is the strongest across lanes (REBAKE > SKIP >\n\
         KEEP). A `fully-transparent` DAT record is ALWAYS `SKIP`: it carries\n\
         zero information, so no re-encode of it can be an improvement — the\n\
         same invariant the client-side veto (062e5ce3) rests on.\n"
    );
    out
}
