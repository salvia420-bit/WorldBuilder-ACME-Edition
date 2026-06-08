//! scenery-cross-check — a READ-ONLY *difference-characterizer* over two
//! scenery bakes (M4-step2).
//!
//! ## What this is — and what it is EMPHATICALLY NOT
//!
//! The fork's bake (`holtburger-scenery-bake` / `Scenery.cs` verbatim port)
//! is the **bit-parity authority**: it reproduces ACE `Scenery.cs` exactly,
//! down to the deliberate retail "bugs" (the `23399` frequency multiplier with
//! no object-index term, the `cellX*8+cellY` road-stride off-by-one, the
//! slope check left as a no-op TODO). Those are not defects — they are the
//! contract the client and server both depend on.
//!
//! Upstream merklejerk's `derive_generated_scenery`
//! (`static_outdoor_scene.rs`) DELIBERATELY diverges from ACE: it adds
//! `template_index` to the noise multiplier, "corrects" the road stride to
//! `x*9+y` with a `road_width=5.0` edge model, and runs always-on
//! point-spacing / building-occupancy / slope rejection gates ACE lacks.
//!
//! Therefore this oracle is a **DRIFT DETECTOR / difference characterizer**:
//! it diffs two scenery-JSONL streams, classifies the diffs, and (when told
//! the candidate is upstream) FILTERS OUT the four known/expected
//! fork-vs-upstream divergence classes so that only *unexpected* deltas — the
//! sign of real, accidental fork drift — are reported.
//!
//! ## Reach (be honest about it)
//!
//! There are two modes, with very different reach:
//!
//!  - **fork-vs-fork (NO flag) — the PRIMARY golden-regression gate.** No
//!    expected classes exist, so EVERY delta (added/removed/changed) is
//!    signal. This is where real drift is caught.
//!  - **fork-vs-upstream (`--expect-upstream-divergence`) — a characterizer of
//!    the four known divergences, NOT a full prover.** With only two streams
//!    and no ACE reference, ADD/REMOVE deltas cannot be disambiguated by
//!    evidence, so this mode attributes EVERY off-road ADDED to
//!    FrequencyGateNoise and EVERY off-road REMOVED to SlopeGate/Occupancy.
//!    The only drift channel it can surface in this mode is a matched-key,
//!    off-road pose CHANGE. To make ADD/REMOVE attribution evidence-bearing
//!    you would need the 3-way ACE-ref vs fork vs upstream diff REPORT §OPP#3
//!    describes; that is out of scope for this two-stream tool. The report
//!    counts kind-only-attributed (weakly attributed) EXPECTED deltas
//!    separately so the operator can see how much was absorbed by the blanket
//!    rule rather than by a positive class signal.
//!
//! It is **NEVER an equality gate** and **NEVER a merge source**.
//!  - It must NEVER be promoted into a `fork == upstream` equality gate. The
//!    expected divergences are EXPECTED, not bugs; flagging them would emit
//!    false positives and tempt a maintainer to "fix" the fork toward
//!    upstream, which would silently break the ACE bit-parity contract.
//!  - It must NEVER be used to pull upstream's corrected math into the fork.
//!  - It is **READ-ONLY**: it parses `*.scenery.jsonl`, prints a report to
//!    stdout, and mutates no bake. (See the AVOID list, items #2 and #3, in
//!    `REPORT.md` §OPP#3.)
//!
//! ## How the diff is keyed
//!
//! Placements are joined on the **addressable `stable_id`** (the M4-step1
//! identity key: `landblock-static/{lb:08x}/generatedscenery/{scene:08x}/
//! {terrain_index}/{template_index}/{source_did:08x}`), NOT on list position
//! — list order is an implementation detail and is not the identity. If a
//! stream predates M4-step1 (a legacy golden bake with no `stable_id` field),
//! we fall back to a composite key `(obj_id, round(x), round(y), round(z))`
//! and note the **degraded join** prominently in the report.
//!
//! ## CLI
//!
//! ```text
//! scenery-cross-check --baseline <dir> --candidate <dir>
//!                     [--expect-upstream-divergence] [--region <hex>]
//! ```
//!
//! Both dirs hold per-LB `0x<LBHEX>.scenery.jsonl` files (the V2 format
//! written by `scenery-bake.rs::write_placement_line`). Placements are grouped
//! by landblock and joined per-LB.
//!
//! `--expect-upstream-divergence` activates the pre-registered EXPECTED
//! registry — use it ONLY when `baseline == fork` and `candidate == upstream`.
//! Without it (fork-vs-fork, mode-vs-mode, or a golden-regression check) there
//! are NO expected classes, so every delta is signal.
//!
//! `--region <hex>` (e.g. `0x01`) restricts the comparison to landblocks whose
//! high byte matches that region, for scoping a run to one map region.
//!
//! ## Exit code
//!
//! Exits non-zero **only** when UNEXPECTED deltas exist, so it can gate
//! accidental fork drift in CI. EXPECTED (pre-registered) deltas never fail
//! the run.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::Parser;
use serde::Deserialize;

#[derive(Parser)]
#[command(
    about = "READ-ONLY drift detector / difference-characterizer over two scenery bakes (NEVER an equality gate, NEVER a merge source)"
)]
struct Args {
    /// Baseline bake directory. Holds per-LB `0x<LBHEX>.scenery.jsonl` files.
    /// When `--expect-upstream-divergence` is set this is the FORK (ACE
    /// bit-parity authority) side.
    #[arg(long)]
    baseline: PathBuf,
    /// Candidate bake directory. Holds per-LB `0x<LBHEX>.scenery.jsonl` files.
    /// When `--expect-upstream-divergence` is set this is the UPSTREAM
    /// (`derive_generated_scenery`) side.
    #[arg(long)]
    candidate: PathBuf,
    /// Activate the pre-registered fork-vs-upstream EXPECTED-divergence
    /// registry. ONLY valid when baseline == fork and candidate == upstream.
    /// Tags deltas matching the four known classes as EXPECTED instead of
    /// reporting them as drift.
    #[arg(long)]
    expect_upstream_divergence: bool,
    /// Restrict the comparison to landblocks whose high byte equals this
    /// region (e.g. `--region 0x01` or `--region 01`).
    #[arg(long)]
    region: Option<String>,
}

/// One placement as parsed from a `*.scenery.jsonl` line. Mirrors
/// `scenery-bake.rs::write_placement_line`. `stable_id` is optional because
/// legacy (pre-M4-step1) golden bakes do not carry it.
///
/// We do NOT use `#[serde(deny_unknown_fields)]` — forward-compat with future
/// appended fields matters as much here as it does for the wasm reader.
#[derive(Debug, Clone, Deserialize)]
struct PlacementLine {
    /// GfxObj (`0x01xxxxxx`) / SetupModel (`0x02xxxxxx`) DID, hex string.
    obj_id: String,
    x: f64,
    y: f64,
    z: f64,
    qw: f64,
    qx: f64,
    qy: f64,
    qz: f64,
    scale: f64,
    #[serde(default)]
    #[allow(dead_code)]
    source_cell_x: Option<u32>,
    #[serde(default)]
    #[allow(dead_code)]
    source_cell_y: Option<u32>,
    #[serde(default)]
    #[allow(dead_code)]
    source_obj_idx: Option<u32>,
    /// SetupModel ambient-chain DID, hex string. Debug/trace only.
    #[serde(default)]
    #[allow(dead_code)]
    default_script_id: Option<String>,
    /// Addressable identity (M4-step1, V2). Absent on legacy golden bakes.
    #[serde(default)]
    stable_id: Option<String>,
}

/// The join key for one placement. Prefer the addressable `stable_id`; fall
/// back to a coordinate composite for legacy bakes.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum JoinKey {
    /// The addressable M4-step1 identity (`landblock-static/.../...`).
    Stable(String),
    /// Legacy composite: obj_id + coords rounded to whole units. Coordinates
    /// are quantized to a stable integer grid so two bakes of the same content
    /// join even across `{:.6}` formatting jitter.
    Composite {
        obj_id: String,
        xi: i64,
        yi: i64,
        zi: i64,
    },
}

impl PlacementLine {
    fn join_key(&self) -> JoinKey {
        match &self.stable_id {
            Some(s) if !s.is_empty() => JoinKey::Stable(s.clone()),
            _ => JoinKey::Composite {
                obj_id: self.obj_id.clone(),
                xi: self.x.round() as i64,
                yi: self.y.round() as i64,
                zi: self.z.round() as i64,
            },
        }
    }

    fn has_stable_id(&self) -> bool {
        matches!(&self.stable_id, Some(s) if !s.is_empty())
    }
}

/// One per-LB classification result.
#[derive(Debug, Default)]
struct LbDiff {
    /// Placements present only in the candidate (keyed but no baseline match).
    added: Vec<Delta>,
    /// Placements present only in the baseline (keyed but no candidate match).
    removed: Vec<Delta>,
    /// Same key in both, differing pose / obj_id / scale.
    changed: Vec<Delta>,
    /// Same key in both, identical (within `{:.6}` tolerance).
    matched: usize,
    /// Whether this LB's join had to fall back to the composite key on either
    /// side (a degraded join — noted prominently in the report).
    degraded_join: bool,
}

/// One reported delta. Carries enough context to classify it against the
/// expected-divergence registry and to read in the report.
#[derive(Debug, Clone)]
struct Delta {
    kind: DeltaKind,
    key: JoinKey,
    /// obj_id of whichever side carries the placement (candidate for ADDED,
    /// baseline for REMOVED; baseline for CHANGED).
    obj_id: String,
    /// LB-local position (the side that defines this delta).
    x: f64,
    y: f64,
    /// Snapped terrain Z of the placement. Used by the slope-gate classifier:
    /// the only slope-correlated signal carried in the per-placement wire
    /// fields is the terrain height the placement was snapped to.
    z: f64,
    /// Source cell coords of the relevant placement (used by the OnRoad-stride
    /// classifier). `None` if the legacy line omitted them.
    source_cell_x: Option<u32>,
    source_cell_y: Option<u32>,
    /// Human-readable description of the change (CHANGED only).
    detail: String,
    /// Expected-divergence tag, once classified. `None` until classified.
    expected: Option<ExpectedClass>,
    /// True when the EXPECTED tag was assigned by delta KIND alone (the
    /// blanket ADD=>FrequencyGateNoise / REMOVE=>Slope-or-Occupancy rule) with
    /// no positive class signal behind it. The road-band attribution is the
    /// only positive signal we have, so anything tagged off the road band is
    /// weak. Surfaced separately in the report so the operator can see how much
    /// signal the blanket rule swallowed. Always false until classified and for
    /// UNEXPECTED deltas.
    weak_attribution: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeltaKind {
    Added,
    Removed,
    Changed,
}

impl DeltaKind {
    fn as_str(self) -> &'static str {
        match self {
            DeltaKind::Added => "ADDED",
            DeltaKind::Removed => "REMOVED",
            DeltaKind::Changed => "CHANGED",
        }
    }
}

/// The four PRE-REGISTERED fork-vs-upstream divergence classes from
/// `REPORT.md` §OPP#3 / the AVOID list. These are EXPECTED, not bugs — see
/// the module doc. Applied ONLY under `--expect-upstream-divergence`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExpectedClass {
    /// (a) Frequency-gate noise. Upstream `generated_template_noise` adds
    /// `template_index` to the `23399` multiplier
    /// (`cell_mat.wrapping_mul(23399 + template_index)`); ACE/fork use the
    /// constant `23399` with NO index term. => a DIFFERENT accepted SET, so
    /// ADD/REMOVE deltas where the two streams simply chose different
    /// vertices/templates.
    FrequencyGateNoise,
    /// (b) OnRoad stride. Upstream `get_road` uses the corrected `x*9+y` plus
    /// a `road_width=5.0` geometric edge model; ACE/fork use the deliberate
    /// `cellX*8+cellY` mistake. => road-band ADD/REMOVE/move deltas.
    OnRoadStride,
    /// (c) Upstream-only point-spacing (`MIN_POINT_SPACING_SQUARED = 4.0`) +
    /// building-cell occupancy gates that drop placements ACE/fork keep. =>
    /// REMOVE deltas (candidate is missing placements baseline has).
    OccupancySpacingGates,
    /// (d) Always-on slope rejection in upstream; fork exposes it as
    /// `BakeMode::Strict`, default OFF, and ACE leaves it a no-op TODO. =>
    /// REMOVE deltas.
    SlopeGate,
}

impl ExpectedClass {
    fn as_str(self) -> &'static str {
        match self {
            ExpectedClass::FrequencyGateNoise => "EXPECTED:FrequencyGateNoise(+template_index)",
            ExpectedClass::OnRoadStride => "EXPECTED:OnRoadStride(x*9+y/road_width vs cellX*8+cellY)",
            ExpectedClass::OccupancySpacingGates => {
                "EXPECTED:OccupancySpacingGates(MIN_POINT_SPACING_SQUARED=4.0 + building occupancy)"
            }
            ExpectedClass::SlopeGate => "EXPECTED:SlopeGate(always-on vs off-by-default)",
        }
    }
}

/// Road band half-width on the LB-local cell grid.
///
/// IMPORTANT CAVEAT (see correctness-parity review): this is a *positional
/// proxy only*. The real OnRoad divergence (REPORT §OPP#3 #2) is data-driven:
/// upstream indexes `terrain[x*9+y]` where ACE/fork index `terrain[cellX*8+cellY]`
/// (`height.rs::on_road`), and the cells that actually carry road bits
/// (`terrain[idx] & 0x3`) can lie ANYWHERE in a landblock — there is no
/// geometric concentration at the LB-centre cross. We do NOT read the
/// `CellLandblock` terrain road bits here (this binary is read-only over the
/// JSONL and has no DAT access), so this band is a best-effort guess that may
/// over- or under-attribute. It only affects which EXPECTED *label* a delta
/// gets (OnRoadStride vs FrequencyGateNoise/Occupancy); it never moves a delta
/// between the EXPECTED and UNEXPECTED partitions, so it cannot cause a false
/// drift report. Deliberately conservative: it claims a narrow band, not the
/// whole LB.
const ROAD_BAND_CELLS: u32 = 1;
/// LB cell-grid dimension on the SOURCE side: the bake writes
/// `source_cell_x = i / VERTEX_DIM` and `source_cell_y = i % VERTEX_DIM` with
/// `VERTEX_DIM = 9` (holtburger-scenery-bake/src/lib.rs:473-474, height.rs:60),
/// so source cells are 9-wide vertex-grid indices running 0..=8 — NOT the 8x8
/// collision-cell grid. The road-band center/clamp below is built on this same
/// 9-index grid so the legitimate 9th column (index 8) is reachable.
const LB_VERTEX_DIM: u32 = 9;

fn main() -> ExitCode {
    match run() {
        Ok(exit) => exit,
        Err(e) => {
            eprintln!("scenery-cross-check: error: {e:#}");
            ExitCode::from(2)
        }
    }
}

fn run() -> Result<ExitCode> {
    let args = Args::parse();

    let region_filter = match &args.region {
        Some(r) => Some(parse_region(r).with_context(|| format!("parse --region {r:?}"))?),
        None => None,
    };

    let baseline = load_bake(&args.baseline, region_filter)
        .with_context(|| format!("load baseline {}", args.baseline.display()))?;
    let candidate = load_bake(&args.candidate, region_filter)
        .with_context(|| format!("load candidate {}", args.candidate.display()))?;

    // Union of all LB keys across both sides.
    let mut all_lbs: Vec<u16> = baseline.keys().chain(candidate.keys()).copied().collect();
    all_lbs.sort_unstable();
    all_lbs.dedup();

    let mut per_lb: BTreeMap<u16, LbDiff> = BTreeMap::new();
    for lb in all_lbs {
        let base = baseline.get(&lb).map(Vec::as_slice).unwrap_or(&[]);
        let cand = candidate.get(&lb).map(Vec::as_slice).unwrap_or(&[]);
        let mut diff = diff_lb(base, cand);
        if args.expect_upstream_divergence {
            classify_expected(&mut diff);
        }
        per_lb.insert(lb, diff);
    }

    print_report(&per_lb, args.expect_upstream_divergence);

    // Exit non-zero ONLY when UNEXPECTED deltas exist.
    let unexpected: usize = per_lb.values().map(unexpected_count).sum();
    if unexpected > 0 {
        Ok(ExitCode::from(1))
    } else {
        Ok(ExitCode::SUCCESS)
    }
}

/// Parse `--region` accepting `0x01`, `01`, or `1`.
fn parse_region(s: &str) -> Result<u8> {
    let t = s.trim();
    let hex = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")).unwrap_or(t);
    let v = u8::from_str_radix(hex, 16)
        .with_context(|| format!("expected a hex byte like 0x01, got {s:?}"))?;
    Ok(v)
}

/// Load every `0x<LBHEX>.scenery.jsonl` in `dir`, grouped by LB key. Skips
/// the `.sha256` sidecars and any non-`.scenery.jsonl` file. Applies the
/// optional region filter.
fn load_bake(dir: &Path, region: Option<u8>) -> Result<BTreeMap<u16, Vec<PlacementLine>>> {
    let mut out: BTreeMap<u16, Vec<PlacementLine>> = BTreeMap::new();
    let rd = fs::read_dir(dir).with_context(|| format!("read_dir {}", dir.display()))?;
    for entry in rd {
        let entry = entry?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // Match `0x<LBHEX>.scenery.jsonl` exactly — not the `.sha256` sidecar.
        if !name.ends_with(".scenery.jsonl") {
            continue;
        }
        let stem = name.trim_end_matches(".scenery.jsonl");
        let Some(lb) = parse_lb_hex(stem) else {
            // Not an LB-keyed file we recognize; skip quietly.
            continue;
        };
        if let Some(r) = region {
            if (lb >> 8) as u8 != r {
                continue;
            }
        }
        let placements = parse_jsonl(&path)
            .with_context(|| format!("parse {}", path.display()))?;
        out.entry(lb).or_default().extend(placements);
    }
    Ok(out)
}

/// Parse `0x<LBHEX>` (4 hex digits) into a u16 LB key.
fn parse_lb_hex(stem: &str) -> Option<u16> {
    let hex = stem.strip_prefix("0x").or_else(|| stem.strip_prefix("0X"))?;
    u16::from_str_radix(hex, 16).ok()
}

/// Parse one `.scenery.jsonl` file. Each non-blank line is one placement.
/// Malformed lines are reported with line number context (never a panic).
fn parse_jsonl(path: &Path) -> Result<Vec<PlacementLine>> {
    let text = fs::read_to_string(path)?;
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let p: PlacementLine = serde_json::from_str(line)
            .with_context(|| format!("line {} is not a valid placement: {line:?}", i + 1))?;
        // Reject scenery-bake `--bits` (raw IEEE-754 `to_bits()` decimal-u32)
        // input: those are still valid JSON numbers, so serde happily parses
        // them, but they are NOT coordinates and the 1e-6 pose epsilon would
        // produce nonsense deltas. Detect by the tell-tale magnitude — a wire
        // f32 coordinate's `to_bits()` is a u32 (up to ~4.3e9), wildly outside
        // any plausible LB-local coordinate (|x|,|y| <= ~256, scale small,
        // quaternion components in [-1,1]). This tool compares the `{:.6}` wire
        // form; refuse bit-format streams with a clear error rather than lie.
        if looks_like_bits_format(&p) {
            anyhow::bail!(
                "line {} looks like scenery-bake `--bits` output (raw IEEE-754 to_bits() integers, \
                 not coordinates). scenery-cross-check compares the `{{:.6}}` wire form and has no \
                 --bits mode; re-run the bake WITHOUT --bits. Offending line: {line:?}",
                i + 1
            );
        }
        out.push(p);
    }
    Ok(out)
}

/// Heuristic guard against `scenery-bake --bits` input (raw `to_bits()`
/// decimal-u32 floats). Quaternion components are unit-bounded ([-1,1]) and a
/// bit-encoded f32 is a large integer, so any |quaternion| far above 1 (or a
/// position absurdly far outside an LB) is a near-certain bit-format tell.
fn looks_like_bits_format(p: &PlacementLine) -> bool {
    // Quaternion components are mathematically in [-1,1]; allow generous slack.
    const QUAT_SANE: f64 = 4.0;
    // LB-local positions are 0..~192; terrain Z is bounded by the height table.
    // A bit-encoded f32 is at minimum ~1e6 for any normal value, so 1e6 is a
    // safe floor that no real coordinate reaches.
    const COORD_INSANE: f64 = 1.0e6;
    p.qw.abs() > QUAT_SANE
        || p.qx.abs() > QUAT_SANE
        || p.qy.abs() > QUAT_SANE
        || p.qz.abs() > QUAT_SANE
        || p.x.abs() > COORD_INSANE
        || p.y.abs() > COORD_INSANE
        || p.z.abs() > COORD_INSANE
        || p.scale.abs() > COORD_INSANE
}

/// Diff one LB's baseline vs candidate placement lists, joined on the
/// addressable key (falling back to the composite for legacy lines).
fn diff_lb(base: &[PlacementLine], cand: &[PlacementLine]) -> LbDiff {
    let mut diff = LbDiff::default();

    // A degraded join occurs whenever ANY line on either side lacks a
    // stable_id and we therefore key it on coordinates.
    diff.degraded_join =
        base.iter().any(|p| !p.has_stable_id()) || cand.iter().any(|p| !p.has_stable_id());

    // Build keyed maps. Duplicate keys within a side are unexpected but
    // tolerated: later wins, and we keep all of them so counts stay honest by
    // using a multimap-style Vec.
    let mut base_map: BTreeMap<JoinKey, Vec<&PlacementLine>> = BTreeMap::new();
    for p in base {
        base_map.entry(p.join_key()).or_default().push(p);
    }
    let mut cand_map: BTreeMap<JoinKey, Vec<&PlacementLine>> = BTreeMap::new();
    for p in cand {
        cand_map.entry(p.join_key()).or_default().push(p);
    }

    let mut all_keys: Vec<JoinKey> =
        base_map.keys().chain(cand_map.keys()).cloned().collect();
    all_keys.sort();
    all_keys.dedup();

    for key in all_keys {
        let bs = base_map.get(&key);
        let cs = cand_map.get(&key);
        match (bs, cs) {
            (Some(bvec), Some(cvec)) => {
                // Join pairwise by position within the key bucket (keys are
                // normally unique; this only matters for the rare dup case).
                let n = bvec.len().max(cvec.len());
                for i in 0..n {
                    match (bvec.get(i), cvec.get(i)) {
                        (Some(b), Some(c)) => {
                            if let Some(detail) = pose_diff(b, c) {
                                diff.changed.push(Delta {
                                    kind: DeltaKind::Changed,
                                    key: key.clone(),
                                    obj_id: b.obj_id.clone(),
                                    x: b.x,
                                    y: b.y,
                                    z: b.z,
                                    source_cell_x: b.source_cell_x,
                                    source_cell_y: b.source_cell_y,
                                    detail,
                                    expected: None,
                                    weak_attribution: false,
                                });
                            } else {
                                diff.matched += 1;
                            }
                        }
                        (Some(b), None) => diff.removed.push(removed_delta(&key, b)),
                        (None, Some(c)) => diff.added.push(added_delta(&key, c)),
                        (None, None) => unreachable!(),
                    }
                }
            }
            (Some(bvec), None) => {
                for b in bvec {
                    diff.removed.push(removed_delta(&key, b));
                }
            }
            (None, Some(cvec)) => {
                for c in cvec {
                    diff.added.push(added_delta(&key, c));
                }
            }
            (None, None) => unreachable!(),
        }
    }

    diff
}

fn added_delta(key: &JoinKey, p: &PlacementLine) -> Delta {
    Delta {
        kind: DeltaKind::Added,
        key: key.clone(),
        obj_id: p.obj_id.clone(),
        x: p.x,
        y: p.y,
        z: p.z,
        source_cell_x: p.source_cell_x,
        source_cell_y: p.source_cell_y,
        detail: String::new(),
        expected: None,
        weak_attribution: false,
    }
}

fn removed_delta(key: &JoinKey, p: &PlacementLine) -> Delta {
    Delta {
        kind: DeltaKind::Removed,
        key: key.clone(),
        obj_id: p.obj_id.clone(),
        x: p.x,
        y: p.y,
        z: p.z,
        source_cell_x: p.source_cell_x,
        source_cell_y: p.source_cell_y,
        detail: String::new(),
        expected: None,
        weak_attribution: false,
    }
}

/// Compare two joined placements. Returns `Some(detail)` if they differ in
/// obj_id, pose (position/rotation), or scale; `None` if identical within the
/// `{:.6}` wire precision the JSONL carries. Floats are compared at 1e-6.
fn pose_diff(b: &PlacementLine, c: &PlacementLine) -> Option<String> {
    const EPS: f64 = 1e-6;
    let mut parts = Vec::new();
    if b.obj_id != c.obj_id {
        parts.push(format!("obj_id {} -> {}", b.obj_id, c.obj_id));
    }
    for (label, bv, cv) in [
        ("x", b.x, c.x),
        ("y", b.y, c.y),
        ("z", b.z, c.z),
        ("qw", b.qw, c.qw),
        ("qx", b.qx, c.qx),
        ("qy", b.qy, c.qy),
        ("qz", b.qz, c.qz),
        ("scale", b.scale, c.scale),
    ] {
        if (bv - cv).abs() > EPS {
            parts.push(format!("{label} {bv:.6} -> {cv:.6}"));
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(", "))
    }
}

/// Tag each delta in this LB against the pre-registered expected-divergence
/// registry. Applied ONLY under `--expect-upstream-divergence` (baseline=fork
/// vs candidate=upstream).
///
/// The registry is a *characterizer*, not a prover: it does not re-run either
/// bake's acceptance math. Instead it recognizes the SHAPE each divergence
/// class produces in the diff and tags matching deltas EXPECTED. Anything it
/// cannot attribute to a known class stays UNEXPECTED (= real drift).
fn classify_expected(diff: &mut LbDiff) {
    for d in diff
        .added
        .iter_mut()
        .chain(diff.removed.iter_mut())
        .chain(diff.changed.iter_mut())
    {
        let (class, weak) = expected_class_for(d);
        d.expected = class;
        d.weak_attribution = class.is_some() && weak;
    }
}

/// Decide which expected-divergence class (if any) a delta belongs to.
///
/// Ordering matters — the road-band test is the most specific, so it runs
/// first. The remaining attribution is by delta KIND, mirroring the shapes the
/// REPORT §OPP#3 classes produce:
///   - ADDED  (only in upstream candidate): a different accepted SET, i.e. the
///     `+template_index` frequency-gate noise picked vertices the fork didn't.
///   - REMOVED (only in fork baseline): upstream's extra always-on rejection
///     gates dropped placements the fork keeps. Two pre-registered classes
///     both produce REMOVEs — the always-on slope check (d) and the
///     point-spacing/occupancy gates (c). We split them with a Z heuristic
///     (`on_steep_terrain`) that is, honestly, a WEAK PROXY: absolute snapped Z
///     is not a slope signal (slope is the terrain GRADIENT; see
///     `STEEP_TERRAIN_Z`). The split only affects which EXPECTED label appears
///     in the report; both halves are EXPECTED and filtered, so it never moves
///     a delta into or out of the UNEXPECTED (drift) count.
///   - CHANGED with a position move: a road-stride relocation.
///
/// STRUCTURAL LIMIT (see guardrail review): with only two streams and no ACE
/// reference, ADD/REMOVE deltas are NOT discriminable by evidence. Under
/// `--expect-upstream-divergence` every off-road ADDED is attributed to
/// FrequencyGateNoise and every off-road REMOVED to SlopeGate/Occupancy, so in
/// this mode the ONLY channel that can surface real fork drift is a
/// matched-key pose CHANGE that is not road-band. An accidental fork-vs-ACE
/// drift that manifests purely as an added/dropped placement would be absorbed
/// into an EXPECTED class here. That is acceptable for this mode (it is a
/// characterizer of the four known divergences, not a prover) but it is why the
/// PRIMARY golden-regression gate is the fork-vs-fork mode (NO flag), where
/// there are no expected classes and every delta — ADD/REMOVE/CHANGE alike — is
/// signal. To triangulate ADD/REMOVE drift one would need the 3-way ACE-ref vs
/// fork vs upstream diff REPORT §OPP#3 describes; that is out of scope for this
/// two-stream tool.
/// Returns `(class, weak)`. `weak == true` means the class was assigned by
/// delta KIND alone (the blanket ADD/REMOVE rule) with no positive signal;
/// `weak == false` means a positive signal (the road-band match) backed it.
/// `weak` is meaningless when `class` is `None`.
fn expected_class_for(d: &Delta) -> (Option<ExpectedClass>, bool) {
    // (b) OnRoad stride — the ONE positive (non-blanket) signal we have: a
    // delta whose source cell sits in the road band. Strong attribution.
    if in_road_band(d) {
        return (Some(ExpectedClass::OnRoadStride), false);
    }
    match d.kind {
        // (a) Different accepted set from the +template_index noise multiplier.
        // Blanket KIND-only attribution => WEAK: with no ACE reference we cannot
        // confirm the add really came from the noise term rather than real drift.
        DeltaKind::Added => (Some(ExpectedClass::FrequencyGateNoise), true),
        DeltaKind::Removed => {
            // (d) vs (c): split by the Z proxy (see `STEEP_TERRAIN_Z` — a weak
            // proxy, NOT a real slope signal). Either way this is blanket
            // KIND-only attribution => WEAK; the Z split only picks the label.
            if on_steep_terrain(d) {
                (Some(ExpectedClass::SlopeGate), true)
            } else {
                (Some(ExpectedClass::OccupancySpacingGates), true)
            }
        }
        // A pose move with no key change reads as a road-stride relocation;
        // off-road pose changes are genuine drift, so only road-band CHANGEs
        // are tagged (handled by in_road_band above) — others stay UNEXPECTED.
        DeltaKind::Changed => (None, false),
    }
}

/// Z threshold used to split SlopeGate from OccupancySpacingGates among
/// REMOVED deltas.
///
/// CAVEAT (see correctness-parity review): absolute snapped Z is NOT a slope
/// signal. The fork's own slope path rejects on the terrain-normal cosine
/// (`height::normal_z_at`, lib.rs:543-547), i.e. the GRADIENT, which is
/// uncorrelated with absolute height — a flat high plateau is not steep, and a
/// steep low hillside is. Terrain Z is also a data-driven 256-entry
/// `land_height_table` lookup (height.rs:54), not a clean "0..255 m band", and
/// retail peaks exceed 200 m while most playable terrain is well below it.
/// We use Z only because it is the single terrain-correlated field carried in
/// the per-placement JSONL wire fields; the binary has no DAT access and cannot
/// compute the real normal here. This split is therefore a best-effort proxy
/// that may mislabel SlopeGate vs OccupancySpacingGates. BOTH labels are
/// EXPECTED, so the mislabel never affects the EXPECTED/UNEXPECTED partition or
/// the exit code — only the attribution shown in the report. To make the split
/// trustworthy one would have to fold the terrain-normal (`normal_z_at`) into
/// the wire fields so the classifier could read the actual gradient.
const STEEP_TERRAIN_Z: f64 = 200.0;

/// Does this delta sit on steep/extreme terrain (the slope-gate signal)?
fn on_steep_terrain(d: &Delta) -> bool {
    d.z >= STEEP_TERRAIN_Z
}

/// Is this delta's source cell (or, for legacy lines without source cells, its
/// LB-local position) inside the road band near the LB-centre cross? Used to
/// attribute road-stride divergences.
fn in_road_band(d: &Delta) -> bool {
    // Prefer the explicit source cell coords if the line carried them.
    if let (Some(cx), Some(cy)) = (d.source_cell_x, d.source_cell_y) {
        return cell_in_road_band(cx) || cell_in_road_band(cy);
    }
    // Legacy fallback: map the LB-local position (0..192 m, 24 m per cell) to a
    // vertex-grid cell index (0..=8) and test the same band. The position
    // 192.0 maps to index 8, the legitimate 9th column, so we clamp against
    // LB_VERTEX_DIM-1 = 8, not 7.
    let cx = (d.x / 24.0).floor().clamp(0.0, (LB_VERTEX_DIM - 1) as f64) as u32;
    let cy = (d.y / 24.0).floor().clamp(0.0, (LB_VERTEX_DIM - 1) as f64) as u32;
    cell_in_road_band(cx) || cell_in_road_band(cy)
}

/// A cell index is in the road band if it is within `ROAD_BAND_CELLS` of the
/// 9-vertex-grid mid-line. NOTE this is a positional proxy ONLY — the real
/// road bits (`terrain[x*9+y] & 0x3` vs `terrain[cellX*8+cellY] & 0x3` in
/// `height.rs::on_road`) are data-driven and can fall on any cell, so this
/// band may over- or under-attribute OnRoadStride. It never affects the
/// EXPECTED/UNEXPECTED partition (see `ROAD_BAND_CELLS` doc), only the label.
/// Built on the 9-index vertex grid (mid = 4, band = 3..=5) so the 9th column
/// (index 8) is a representable cell and the clamp does not silently drop it.
fn cell_in_road_band(c: u32) -> bool {
    let mid = LB_VERTEX_DIM / 2; // 4 (mid of the 0..=8 vertex grid)
    let lo = mid.saturating_sub(ROAD_BAND_CELLS);
    let hi = (mid + ROAD_BAND_CELLS).min(LB_VERTEX_DIM - 1);
    c >= lo && c <= hi
}

/// Count UNEXPECTED deltas in one LB (those with no expected tag).
fn unexpected_count(diff: &LbDiff) -> usize {
    diff.added
        .iter()
        .chain(diff.removed.iter())
        .chain(diff.changed.iter())
        .filter(|d| d.expected.is_none())
        .count()
}

/// Print the summary (counts per class per LB + totals) followed by the
/// UNEXPECTED delta list.
fn print_report(per_lb: &BTreeMap<u16, LbDiff>, expect_upstream: bool) {
    println!("=== scenery-cross-check ===");
    println!(
        "MODE: {}",
        if expect_upstream {
            "fork(baseline) vs upstream(candidate) — pre-registered EXPECTED-divergence registry ACTIVE"
        } else {
            "fork-vs-fork / mode-vs-mode / golden-regression — NO expected classes; every delta is signal"
        }
    );
    println!(
        "NOTE: READ-ONLY drift detector / difference characterizer. NEVER an equality gate, NEVER a merge source."
    );
    println!();

    let mut tot_added = 0usize;
    let mut tot_removed = 0usize;
    let mut tot_changed = 0usize;
    let mut tot_matched = 0usize;
    let mut tot_expected = 0usize;
    let mut tot_weak = 0usize;
    let mut tot_unexpected = 0usize;
    let mut any_degraded = false;

    println!("--- per-landblock ---");
    for (lb, diff) in per_lb {
        let exp = expected_count(diff);
        let unexp = unexpected_count(diff);
        tot_added += diff.added.len();
        tot_removed += diff.removed.len();
        tot_changed += diff.changed.len();
        tot_matched += diff.matched;
        tot_expected += exp;
        tot_weak += weak_attribution_count(diff);
        tot_unexpected += unexp;
        if diff.degraded_join {
            any_degraded = true;
        }
        // Only print LBs that have something to say.
        if diff.added.is_empty()
            && diff.removed.is_empty()
            && diff.changed.is_empty()
            && diff.matched == 0
        {
            continue;
        }
        println!(
            "0x{lb:04X}: matched={} added={} removed={} changed={} | expected={} unexpected={}{}",
            diff.matched,
            diff.added.len(),
            diff.removed.len(),
            diff.changed.len(),
            exp,
            unexp,
            if diff.degraded_join {
                "  [DEGRADED JOIN: composite-key fallback — a stream lacks stable_id]"
            } else {
                ""
            },
        );
    }
    println!();

    println!("--- totals ---");
    println!("matched={tot_matched}");
    println!("added={tot_added}  removed={tot_removed}  changed={tot_changed}");
    if expect_upstream {
        println!("expected (pre-registered upstream divergence, FILTERED OUT) = {tot_expected}");
        println!(
            "  of which WEAKLY-ATTRIBUTED (tagged by ADD/REMOVE kind alone, no positive signal — \
             this mode cannot distinguish these from real ADD/REMOVE drift; the fork-vs-fork mode \
             can) = {tot_weak}"
        );
    }
    println!("UNEXPECTED (real drift signal) = {tot_unexpected}");
    if any_degraded {
        println!(
            "WARNING: at least one landblock used the DEGRADED composite-key join (a stream lacks stable_id — legacy pre-M4-step1 bake). Joins are coordinate-rounded and may mis-pair near-coincident placements."
        );
    }
    println!();

    // UNEXPECTED delta list.
    println!("--- UNEXPECTED deltas (these are the drift signal) ---");
    if tot_unexpected == 0 {
        println!("(none — no accidental drift detected)");
    } else {
        for (lb, diff) in per_lb {
            for d in diff
                .added
                .iter()
                .chain(diff.removed.iter())
                .chain(diff.changed.iter())
            {
                if d.expected.is_some() {
                    continue;
                }
                print_delta(*lb, d);
            }
        }
    }

    if expect_upstream && tot_expected > 0 {
        println!();
        println!("--- EXPECTED deltas (pre-registered upstream divergence — NOT drift, do NOT 'fix') ---");
        for (lb, diff) in per_lb {
            for d in diff
                .added
                .iter()
                .chain(diff.removed.iter())
                .chain(diff.changed.iter())
            {
                let Some(cls) = d.expected else { continue };
                let weak = if d.weak_attribution { " {WEAK: kind-only}" } else { "" };
                println!(
                    "0x{lb:04X} {} [{}]{weak} {}",
                    d.kind.as_str(),
                    cls.as_str(),
                    key_str(&d.key)
                );
            }
        }
    }
}

fn print_delta(lb: u16, d: &Delta) {
    let detail = if d.detail.is_empty() {
        format!("obj_id={} x={:.6} y={:.6}", d.obj_id, d.x, d.y)
    } else {
        d.detail.clone()
    };
    println!(
        "0x{lb:04X} {} {}  ({detail})",
        d.kind.as_str(),
        key_str(&d.key),
    );
}

fn key_str(key: &JoinKey) -> String {
    match key {
        JoinKey::Stable(s) => s.clone(),
        JoinKey::Composite { obj_id, xi, yi, zi } => {
            format!("composite({obj_id}@{xi},{yi},{zi})")
        }
    }
}

fn expected_count(diff: &LbDiff) -> usize {
    diff.added
        .iter()
        .chain(diff.removed.iter())
        .chain(diff.changed.iter())
        .filter(|d| d.expected.is_some())
        .count()
}

/// Count EXPECTED deltas that were attributed by delta KIND alone (the blanket
/// ADD/REMOVE rule) with no positive signal — the deltas the operator should
/// be aware were absorbed without evidence.
fn weak_attribution_count(diff: &LbDiff) -> usize {
    diff.added
        .iter()
        .chain(diff.removed.iter())
        .chain(diff.changed.iter())
        .filter(|d| d.expected.is_some() && d.weak_attribution)
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    // A V2 placement line carrying a stable_id. `sid` is the addressable key;
    // the rest are the wire fields.
    fn line_v2(
        sid: &str,
        obj_id: &str,
        x: f64,
        y: f64,
        z: f64,
        qz: f64,
        scale: f64,
        scx: u32,
        scy: u32,
    ) -> String {
        format!(
            "{{\"obj_id\":\"{obj_id}\",\"x\":{x:.6},\"y\":{y:.6},\"z\":{z:.6},\"qw\":1.000000,\"qx\":0.000000,\"qy\":0.000000,\"qz\":{qz:.6},\"scale\":{scale:.6},\"source_cell_x\":{scx},\"source_cell_y\":{scy},\"source_obj_idx\":0,\"default_script_id\":\"0x00000000\",\"stable_id\":\"{sid}\"}}"
        )
    }

    // A legacy V1 line WITHOUT stable_id (and without source cells, to exercise
    // the position-based road-band fallback path too if needed).
    fn line_v1(obj_id: &str, x: f64, y: f64, z: f64) -> String {
        format!(
            "{{\"obj_id\":\"{obj_id}\",\"x\":{x:.6},\"y\":{y:.6},\"z\":{z:.6},\"qw\":1.000000,\"qx\":0.000000,\"qy\":0.000000,\"qz\":0.000000,\"scale\":1.000000,\"source_cell_x\":0,\"source_cell_y\":0,\"source_obj_idx\":0,\"default_script_id\":\"0x00000000\"}}"
        )
    }

    fn sid(n: u32) -> String {
        // Stable id with a non-road-band source cell baked into the path so the
        // OnRoad classifier doesn't accidentally grab it. terrain_index varies.
        format!("landblock-static/a9b40000/generatedscenery/12000abc/{n}/0/02000246")
    }

    fn parse_lines(lines: &[String]) -> Vec<PlacementLine> {
        lines
            .iter()
            .map(|l| serde_json::from_str(l).expect("valid line"))
            .collect()
    }

    #[test]
    fn parses_v2_line_with_stable_id() {
        let p: PlacementLine =
            serde_json::from_str(&line_v2(&sid(7), "0x02000246", 1.0, 2.0, 3.0, 0.0, 1.0, 0, 0))
                .unwrap();
        assert!(p.has_stable_id());
        assert_eq!(p.join_key(), JoinKey::Stable(sid(7)));
    }

    #[test]
    fn falls_back_to_composite_key_for_legacy_line() {
        let p: PlacementLine = serde_json::from_str(&line_v1("0x02000246", 10.4, 20.6, 30.5)).unwrap();
        assert!(!p.has_stable_id());
        assert_eq!(
            p.join_key(),
            JoinKey::Composite {
                obj_id: "0x02000246".to_string(),
                xi: 10,
                yi: 21,
                zi: 31, // 30.5 rounds half-to-even/away depending; f64::round is half-away => 31
            }
        );
    }

    #[test]
    fn classifies_matched_added_removed_changed_no_expect() {
        // Baseline has keys 1,2,3 (3 will be CHANGED, 2 only-baseline=REMOVED).
        // Candidate has keys 1,3,4 (4 only-candidate=ADDED, 1 identical=MATCHED).
        let base = parse_lines(&[
            line_v2(&sid(1), "0x02000246", 10.0, 10.0, 5.0, 0.0, 1.0, 2, 2), // MATCHED
            line_v2(&sid(2), "0x02000246", 20.0, 20.0, 5.0, 0.0, 1.0, 2, 6), // REMOVED (off-road col 6/row? row2 -> not road)
            line_v2(&sid(3), "0x02000246", 30.0, 30.0, 5.0, 0.0, 1.0, 0, 6), // CHANGED below
        ]);
        let cand = parse_lines(&[
            line_v2(&sid(1), "0x02000246", 10.0, 10.0, 5.0, 0.0, 1.0, 2, 2), // identical -> MATCHED
            line_v2(&sid(3), "0x02000246", 30.0, 35.0, 5.0, 0.0, 1.0, 0, 6), // y moved -> CHANGED
            line_v2(&sid(4), "0x02000246", 40.0, 40.0, 5.0, 0.0, 1.0, 7, 7), // ADDED
        ]);

        let diff = diff_lb(&base, &cand);
        assert_eq!(diff.matched, 1, "key 1 identical");
        assert_eq!(diff.added.len(), 1, "key 4 only in candidate");
        assert_eq!(diff.removed.len(), 1, "key 2 only in baseline");
        assert_eq!(diff.changed.len(), 1, "key 3 pose differs");
        assert!(!diff.degraded_join, "all lines carry stable_id");

        // No --expect-upstream-divergence => everything is UNEXPECTED.
        // (classify_expected not called.)
        assert_eq!(unexpected_count(&diff), 3);
        assert_eq!(expected_count(&diff), 0);
    }

    #[test]
    fn degraded_join_flagged_when_stable_id_absent() {
        let base = parse_lines(&[line_v1("0x02000246", 10.0, 10.0, 5.0)]);
        let cand = parse_lines(&[line_v1("0x02000246", 10.0, 10.0, 5.0)]);
        let diff = diff_lb(&base, &cand);
        assert!(diff.degraded_join, "neither line has stable_id");
        assert_eq!(diff.matched, 1, "composite key joins them");
    }

    #[test]
    fn expected_frequency_gate_noise_tags_added() {
        // Upstream (candidate) accepted a placement at an off-road cell the
        // fork didn't: ADDED => FrequencyGateNoise under --expect.
        let base: Vec<PlacementLine> = vec![];
        let cand = parse_lines(&[line_v2(&sid(9), "0x02000246", 40.0, 40.0, 5.0, 0.0, 1.0, 7, 1)]);
        let mut diff = diff_lb(&base, &cand);
        classify_expected(&mut diff);
        assert_eq!(diff.added.len(), 1);
        assert_eq!(diff.added[0].expected, Some(ExpectedClass::FrequencyGateNoise));
        assert_eq!(unexpected_count(&diff), 0, "tagged EXPECTED => filtered out");
    }

    #[test]
    fn expected_occupancy_spacing_gate_tags_removed() {
        // Fork (baseline) kept a placement upstream's spacing/occupancy gate
        // dropped: REMOVED at an off-road cell => OccupancySpacingGates.
        let base = parse_lines(&[line_v2(&sid(11), "0x02000246", 20.0, 20.0, 5.0, 0.0, 1.0, 1, 7)]);
        let cand: Vec<PlacementLine> = vec![];
        let mut diff = diff_lb(&base, &cand);
        classify_expected(&mut diff);
        assert_eq!(diff.removed.len(), 1);
        assert_eq!(
            diff.removed[0].expected,
            Some(ExpectedClass::OccupancySpacingGates)
        );
        assert_eq!(unexpected_count(&diff), 0);
    }

    #[test]
    fn expected_slope_gate_tags_removed_on_steep_terrain() {
        // Fork (baseline) kept a placement on steep upland terrain that
        // upstream's always-on slope check rejected: REMOVED at high Z, off the
        // road band => SlopeGate.
        let base = parse_lines(&[line_v2(&sid(12), "0x02000246", 20.0, 20.0, 230.0, 0.0, 1.0, 1, 7)]);
        let cand: Vec<PlacementLine> = vec![];
        let mut diff = diff_lb(&base, &cand);
        classify_expected(&mut diff);
        assert_eq!(diff.removed.len(), 1);
        assert_eq!(diff.removed[0].expected, Some(ExpectedClass::SlopeGate));
        assert_eq!(unexpected_count(&diff), 0);
    }

    #[test]
    fn expected_onroad_stride_tags_road_band_cell() {
        // A delta whose source cell sits in the road band => OnRoadStride,
        // regardless of ADD/REMOVE. Cell (4, 0) is in the centre-cross band.
        let base = parse_lines(&[line_v2(&sid(13), "0x02000246", 96.0, 0.0, 5.0, 0.0, 1.0, 4, 0)]);
        let cand: Vec<PlacementLine> = vec![];
        let mut diff = diff_lb(&base, &cand);
        classify_expected(&mut diff);
        assert_eq!(diff.removed.len(), 1);
        assert_eq!(diff.removed[0].expected, Some(ExpectedClass::OnRoadStride));
        assert_eq!(unexpected_count(&diff), 0);
    }

    #[test]
    fn expected_slope_or_occupancy_distinct_from_road() {
        // Confirm that the road-band test takes precedence: an ADDED in the
        // road band is OnRoadStride, not FrequencyGateNoise.
        let base: Vec<PlacementLine> = vec![];
        let cand = parse_lines(&[line_v2(&sid(15), "0x02000246", 96.0, 96.0, 5.0, 0.0, 1.0, 4, 4)]);
        let mut diff = diff_lb(&base, &cand);
        classify_expected(&mut diff);
        assert_eq!(diff.added[0].expected, Some(ExpectedClass::OnRoadStride));
    }

    #[test]
    fn unexpected_changed_pose_off_road_is_drift() {
        // A pose CHANGED off-road is genuine drift even under --expect: it is
        // not attributable to any of the 4 known classes. This is the case the
        // oracle MUST still flag so it can gate accidental fork drift.
        let base = parse_lines(&[line_v2(&sid(21), "0x02000246", 20.0, 20.0, 5.0, 0.0, 1.0, 0, 7)]);
        let cand = parse_lines(&[line_v2(&sid(21), "0x02000246", 20.0, 20.0, 5.0, 0.5, 1.0, 0, 7)]);
        let mut diff = diff_lb(&base, &cand);
        classify_expected(&mut diff);
        assert_eq!(diff.changed.len(), 1, "qz moved");
        assert_eq!(diff.changed[0].expected, None, "off-road pose change = drift");
        assert_eq!(unexpected_count(&diff), 1);
    }

    #[test]
    fn pose_diff_within_six_decimals_is_matched() {
        // Two values that differ below the {:.6} wire precision are MATCHED.
        let b: PlacementLine =
            serde_json::from_str(&line_v2(&sid(1), "0x02000246", 10.0000001, 10.0, 5.0, 0.0, 1.0, 0, 0))
                .unwrap();
        let c: PlacementLine =
            serde_json::from_str(&line_v2(&sid(1), "0x02000246", 10.0000002, 10.0, 5.0, 0.0, 1.0, 0, 0))
                .unwrap();
        assert!(pose_diff(&b, &c).is_none(), "sub-1e-6 difference is not a change");
    }

    #[test]
    fn bits_format_input_is_rejected_not_misparsed() {
        // scenery-bake --bits emits each f32 as its to_bits() decimal-u32.
        // Those are valid JSON numbers serde parses fine, but they are not
        // coordinates; the oracle must refuse them, not silently compare bit
        // integers at the 1e-6 epsilon.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("0xA9B4.scenery.jsonl");
        // bits of: x=10.0f32, y=20.0f32, z=5.0f32, qw=1.0f32, qz=0, scale=1.0f32
        let bits_line = format!(
            "{{\"obj_id\":\"0x02000246\",\"x\":{},\"y\":{},\"z\":{},\"qw\":{},\"qx\":0,\"qy\":0,\"qz\":0,\"scale\":{},\"stable_id\":\"{}\"}}",
            10.0f32.to_bits(),
            20.0f32.to_bits(),
            5.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            sid(1),
        );
        std::fs::write(&path, format!("{bits_line}\n")).unwrap();
        let err = parse_jsonl(&path).unwrap_err();
        assert!(
            format!("{err:#}").contains("--bits"),
            "bit-format input must be refused with a --bits hint, got: {err:#}"
        );
    }

    #[test]
    fn malformed_line_errors_not_panics() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("0xA9B4.scenery.jsonl");
        std::fs::write(&path, "{not valid json}\n").unwrap();
        let err = parse_jsonl(&path).unwrap_err();
        assert!(format!("{err:#}").contains("not a valid placement"));
    }

    #[test]
    fn load_bake_skips_sha256_and_keys_by_lb() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("0xA9B4.scenery.jsonl"),
            format!("{}\n", line_v2(&sid(1), "0x02000246", 1.0, 2.0, 3.0, 0.0, 1.0, 0, 0)),
        )
        .unwrap();
        // sidecar must be ignored.
        std::fs::write(dir.path().join("0xA9B4.scenery.jsonl.sha256"), "deadbeef\n").unwrap();
        // unrelated file must be ignored.
        std::fs::write(dir.path().join("bake-source.sha256"), "deadbeef\n").unwrap();

        let bake = load_bake(dir.path(), None).unwrap();
        assert_eq!(bake.len(), 1, "exactly one LB");
        assert_eq!(bake[&0xA9B4].len(), 1);
    }

    #[test]
    fn region_filter_restricts_landblocks() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("0xA9B4.scenery.jsonl"),
            format!("{}\n", line_v2(&sid(1), "0x02000246", 1.0, 2.0, 3.0, 0.0, 1.0, 0, 0)),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("0x01B4.scenery.jsonl"),
            format!("{}\n", line_v2(&sid(1), "0x02000246", 1.0, 2.0, 3.0, 0.0, 1.0, 0, 0)),
        )
        .unwrap();
        // region 0xA9 -> only 0xA9B4 survives.
        let bake = load_bake(dir.path(), Some(0xA9)).unwrap();
        assert_eq!(bake.len(), 1);
        assert!(bake.contains_key(&0xA9B4));
    }

    #[test]
    fn parse_region_accepts_prefixed_and_bare() {
        assert_eq!(parse_region("0x01").unwrap(), 0x01);
        assert_eq!(parse_region("A9").unwrap(), 0xA9);
        assert_eq!(parse_region("ff").unwrap(), 0xFF);
        assert!(parse_region("zz").is_err());
    }

    #[test]
    fn empty_lb_lists_produce_no_deltas() {
        let diff = diff_lb(&[], &[]);
        assert_eq!(diff.matched, 0);
        assert_eq!(unexpected_count(&diff), 0);
        assert!(!diff.degraded_join);
    }

    #[test]
    fn source_cell_eight_is_representable_and_off_band() {
        // The bake writes source cells as 9-wide vertex-grid indices (0..=8;
        // `i / VERTEX_DIM`, VERTEX_DIM=9). Cell index 8 — the legitimate 9th
        // column — must be a representable cell and must fall OUTSIDE the
        // centre road band (3..=5), so a delta there is NOT mislabeled
        // OnRoadStride. This locks the grid-width fix (LB_VERTEX_DIM=9) against
        // regression to the old 8-wide assumption that clamped cell 8 to 7.
        assert!(!cell_in_road_band(8), "cell 8 is off the 3..=5 road band");
        assert!(cell_in_road_band(4), "centre cell 4 is in the band");
        // A REMOVED at source cell (8, 8) classifies by KIND (Occupancy), not
        // OnRoadStride, proving cell 8 is treated as a real off-band cell.
        let base = parse_lines(&[line_v2(&sid(31), "0x02000246", 190.0, 190.0, 5.0, 0.0, 1.0, 8, 8)]);
        let cand: Vec<PlacementLine> = vec![];
        let mut diff = diff_lb(&base, &cand);
        classify_expected(&mut diff);
        assert_eq!(
            diff.removed[0].expected,
            Some(ExpectedClass::OccupancySpacingGates),
            "cell 8 is off-band, so kind-attributed, not OnRoadStride"
        );
    }

    #[test]
    fn kind_only_attribution_is_flagged_weak_road_band_is_strong() {
        // ADDED off-road => FrequencyGateNoise, attributed by KIND alone => WEAK.
        let base: Vec<PlacementLine> = vec![];
        let cand = parse_lines(&[line_v2(&sid(41), "0x02000246", 40.0, 40.0, 5.0, 0.0, 1.0, 7, 1)]);
        let mut diff = diff_lb(&base, &cand);
        classify_expected(&mut diff);
        assert_eq!(diff.added[0].expected, Some(ExpectedClass::FrequencyGateNoise));
        assert!(diff.added[0].weak_attribution, "kind-only attribution is weak");
        assert_eq!(weak_attribution_count(&diff), 1);

        // REMOVED in the road band => OnRoadStride, backed by the positional
        // signal => NOT weak (strong attribution).
        let base = parse_lines(&[line_v2(&sid(42), "0x02000246", 96.0, 0.0, 5.0, 0.0, 1.0, 4, 0)]);
        let cand: Vec<PlacementLine> = vec![];
        let mut diff = diff_lb(&base, &cand);
        classify_expected(&mut diff);
        assert_eq!(diff.removed[0].expected, Some(ExpectedClass::OnRoadStride));
        assert!(!diff.removed[0].weak_attribution, "road-band attribution is strong");
        assert_eq!(weak_attribution_count(&diff), 0);
    }
}
