//! `page-resample` — derive a PAGE-DIM corpus tier from an existing texture
//! source corpus (T22 deviation D2; T00 re-key 2026-08-09 §4).
//!
//! WHAT IT DOES
//! -----------
//! Reads a directory of `0xRRRRRRRR.png` texture sources (the upscale corpus
//! the XUBC7 full tier is encoded from) and writes a DERIVED tier in which
//! every member's dims equal its ARRAY-PAGE dims — the square pow2 page
//! 256²/512²/1024²/2048² that `scene3d/pool_class_key.js` will demand of the
//! class's one `texStorage3D` allocation. After a bake over this tier,
//! `needsResample()` reads ZERO for every covered member and "any two members
//! of a class share any layer" stops being a hope.
//!
//! WHY A DERIVED TIER AND NOT AN IN-PLACE EDIT
//! -------------------------------------------
//! `/mnt/wbterminal2/upscale-corpus`, `/mnt/wbterminal2/xubc7-corpus` and
//! `/mnt/wbterminal2/xubc7-corpus-q75` are owner-facing measurement artifacts
//! (T16 GATE-Q75 / the B4a election reads them). Mutating them in place would
//! destroy the A/B those decisions rest on. So this tool never writes to
//! `--src`; it produces a new directory that is a COMPLETE encode input —
//! resampled members as fresh PNGs, identity members as symlinks back to the
//! source (byte-identical by construction, no duplication of the 2.6 k
//! already-square members) — and a plan + sha256 manifest + PROVENANCE.md
//! recording exactly what came from where.
//!
//! DETERMINISM
//! -----------
//! The kernel is integer-exact (`page_resample::resample_planar`); rows are
//! processed in rsId order; the PNG encoder settings are pinned here rather
//! than left to the crate default. `--verify-deterministic` re-encodes every
//! resampled member a second time in-process and fails on any byte
//! difference, which is the same shape `dat-shard --verify-deterministic`
//! uses.
//!
//! TYPICAL USE (the promotion path — see PROVENANCE.md in the output)
//! ------------------------------------------------------------------
//! ```text
//!   page-resample --src /mnt/wbterminal2/upscale-corpus/out/statics-remacri \
//!                 --out /mnt/wbterminal2/reeng/page-resample/src-statics-pages
//!   # then, on the buildbox, the UNCHANGED T16 encode command per member:
//!   basisu -xubc7 -quality 75 -mipmap -output_file <rsId>.ktx2 <rsId>.png
//! ```
//! The encoder is not asked to resample (`basisu -resample` is a box filter
//! too, but it is not reproducible outside that binary and it would put the
//! resample decision behind a flag no test can see).

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use clap::Parser;
use holtburger_tools::error::{Result, ToolError};
use holtburger_tools::page_resample::{PageAction, plan_page, resample_planar};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Parser, Debug)]
#[command(
    author,
    version,
    about = "Derive a page-dim texture corpus tier (T22 D2 — the pool class key's resample)"
)]
struct Args {
    /// Source PNG corpus (`0xRRRRRRRR.png`). NEVER written to.
    #[arg(long, value_name = "DIR")]
    src: PathBuf,

    /// Output directory for the derived tier. Created if missing.
    #[arg(long, value_name = "DIR")]
    out: PathBuf,

    /// Only consider these rsIds (one hex id per line, `#` comments ok).
    #[arg(long, value_name = "FILE")]
    ids: Option<PathBuf>,

    /// Emit the plan + report and write no images.
    #[arg(long)]
    plan_only: bool,

    /// Copy identity members instead of symlinking them. Slower and 1.6 GB
    /// heavier on a full corpus; use it when the consumer cannot follow
    /// links (rsync without `-L`, a container bind-mount).
    #[arg(long)]
    copy_identity: bool,

    /// Re-encode every resampled member a second time and fail on any byte
    /// difference (intra-run determinism check).
    #[arg(long)]
    verify_deterministic: bool,
}

#[derive(Debug, Clone, Serialize)]
struct PlanRow {
    rs_id: String,
    src_w: u32,
    src_h: u32,
    page_w: u32,
    page_h: u32,
    tier: u32,
    channels: usize,
    action: PageAction,
    src_sha256: String,
    out_sha256: String,
    out_bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
struct PlanReport {
    tool: String,
    src_dir: String,
    out_dir: String,
    /// The kernel, named in the artifact so a future reader never has to
    /// guess which filter produced these bytes.
    kernel: String,
    members: usize,
    identity: usize,
    upscaled: usize,
    downscaled: usize,
    /// `needsResample()` over the SOURCE tier — the number this run drives
    /// to zero.
    needs_resample_before: usize,
    /// `needsResample()` over the DERIVED tier. MUST be 0.
    needs_resample_after: usize,
    src_bytes: u64,
    out_bytes: u64,
    rows: Vec<PlanRow>,
}

fn parse_rs_id(stem: &str) -> Option<u32> {
    let s = stem.strip_prefix("0x").or_else(|| stem.strip_prefix("0X")).unwrap_or(stem);
    if s.len() != 8 {
        return None;
    }
    u32::from_str_radix(s, 16).ok()
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn channels_of(ct: png::ColorType) -> Result<usize> {
    Ok(match ct {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        other => {
            return Err(ToolError::Validation(format!(
                "unsupported PNG color type after normalization: {other:?}"
            )));
        }
    })
}

struct Decoded {
    w: u32,
    h: u32,
    channels: usize,
    color: png::ColorType,
    pixels: Vec<u8>,
}

fn decode_png(path: &Path) -> Result<Decoded> {
    let file = std::fs::File::open(path)
        .map_err(|e| ToolError::Validation(format!("open {path:?}: {e}")))?;
    let mut dec = png::Decoder::new(std::io::BufReader::new(file));
    // 16-bit → 8-bit, palette/tRNS expanded: the kernel is an 8-bit kernel
    // and the encoder consumes 8-bit, so normalize once, here.
    dec.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = dec
        .read_info()
        .map_err(|e| ToolError::Validation(format!("read_info {path:?}: {e}")))?;
    let mut buf = vec![0u8; reader.output_buffer_size().unwrap_or(0)];
    let info = reader
        .next_frame(&mut buf)
        .map_err(|e| ToolError::Validation(format!("decode {path:?}: {e}")))?;
    let channels = channels_of(info.color_type)?;
    if info.bit_depth != png::BitDepth::Eight {
        return Err(ToolError::Validation(format!(
            "{path:?}: bit depth {:?} survived normalization",
            info.bit_depth
        )));
    }
    buf.truncate(info.width as usize * info.height as usize * channels);
    Ok(Decoded {
        w: info.width,
        h: info.height,
        channels,
        color: info.color_type,
        pixels: buf,
    })
}

/// PNG encode with settings PINNED here — a crate-default change must not
/// silently move the corpus bytes.
fn encode_png(w: u32, h: u32, color: png::ColorType, pixels: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(color);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Balanced);
        enc.set_filter(png::Filter::Adaptive);
        let mut writer = enc
            .write_header()
            .map_err(|e| ToolError::Validation(format!("png header: {e}")))?;
        writer
            .write_image_data(pixels)
            .map_err(|e| ToolError::Validation(format!("png data: {e}")))?;
        writer
            .finish()
            .map_err(|e| ToolError::Validation(format!("png finish: {e}")))?;
    }
    Ok(out)
}

fn load_id_filter(path: &Path) -> Result<Vec<u32>> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| ToolError::Validation(format!("read {path:?}: {e}")))?;
    let mut ids = Vec::new();
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        match parse_rs_id(line) {
            Some(id) => ids.push(id),
            None => return Err(ToolError::Validation(format!("bad rsId in {path:?}: {line}"))),
        }
    }
    Ok(ids)
}

fn main() -> Result<()> {
    let args = Args::parse();
    if !args.src.is_dir() {
        return Err(ToolError::Validation(format!("--src {:?} is not a directory", args.src)));
    }
    if args.src == args.out {
        return Err(ToolError::Validation(
            "--out must differ from --src: existing corpora are never mutated in place".into(),
        ));
    }

    // Deterministic member set, rsId-ordered.
    let mut members: BTreeMap<u32, PathBuf> = BTreeMap::new();
    for entry in std::fs::read_dir(&args.src)
        .map_err(|e| ToolError::Validation(format!("read_dir {:?}: {e}", args.src)))?
    {
        let entry = entry.map_err(|e| ToolError::Validation(format!("dir entry: {e}")))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("png") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        let Some(id) = parse_rs_id(stem) else { continue };
        members.insert(id, path);
    }
    if let Some(ids) = &args.ids {
        let keep = load_id_filter(ids)?;
        members.retain(|id, _| keep.contains(id));
    }
    if members.is_empty() {
        return Err(ToolError::Validation(format!("no 0xID.png members under {:?}", args.src)));
    }

    if !args.plan_only {
        std::fs::create_dir_all(&args.out)
            .map_err(|e| ToolError::Validation(format!("create {:?}: {e}", args.out)))?;
    }

    let mut report = PlanReport {
        tool: format!("page-resample {}", env!("CARGO_PKG_VERSION")),
        src_dir: args.src.display().to_string(),
        out_dir: args.out.display().to_string(),
        kernel: "exact-rational area (integer); integer upscale = texel replication".into(),
        ..Default::default()
    };

    let bar = indicatif::ProgressBar::new(members.len() as u64);
    for (&rs, src_path) in &members {
        bar.inc(1);
        let src_bytes = std::fs::read(src_path)
            .map_err(|e| ToolError::Validation(format!("read {src_path:?}: {e}")))?;
        let src_sha = sha256_hex(&src_bytes);
        let img = decode_png(src_path)?;
        let plan = plan_page(img.w, img.h).ok_or_else(|| {
            ToolError::Validation(format!("0x{rs:08X}: zero-dimension source"))
        })?;
        report.members += 1;
        report.src_bytes += src_bytes.len() as u64;
        if plan.action != PageAction::Identity {
            report.needs_resample_before += 1;
        }

        let out_name = format!("0x{rs:08X}.png");
        let out_path = args.out.join(&out_name);
        let (out_sha, out_len) = match plan.action {
            PageAction::Identity => {
                report.identity += 1;
                if !args.plan_only {
                    let _ = std::fs::remove_file(&out_path);
                    if args.copy_identity {
                        std::fs::copy(src_path, &out_path).map_err(|e| {
                            ToolError::Validation(format!("copy {src_path:?}: {e}"))
                        })?;
                    } else {
                        let abs = src_path.canonicalize().map_err(|e| {
                            ToolError::Validation(format!("canonicalize {src_path:?}: {e}"))
                        })?;
                        std::os::unix::fs::symlink(&abs, &out_path).map_err(|e| {
                            ToolError::Validation(format!("symlink {out_path:?}: {e}"))
                        })?;
                    }
                }
                (src_sha.clone(), src_bytes.len() as u64)
            }
            PageAction::Upscale | PageAction::Downscale => {
                if plan.action == PageAction::Upscale {
                    report.upscaled += 1;
                } else {
                    report.downscaled += 1;
                }
                let pixels = resample_planar(
                    &img.pixels,
                    img.w,
                    img.h,
                    plan.page_w,
                    plan.page_h,
                    img.channels,
                );
                let encoded = encode_png(plan.page_w, plan.page_h, img.color, &pixels)?;
                if args.verify_deterministic {
                    let again = resample_planar(
                        &img.pixels,
                        img.w,
                        img.h,
                        plan.page_w,
                        plan.page_h,
                        img.channels,
                    );
                    let encoded2 = encode_png(plan.page_w, plan.page_h, img.color, &again)?;
                    if encoded2 != encoded {
                        return Err(ToolError::Validation(format!(
                            "0x{rs:08X}: NON-DETERMINISTIC re-encode"
                        )));
                    }
                }
                if !args.plan_only {
                    let _ = std::fs::remove_file(&out_path);
                    std::fs::write(&out_path, &encoded).map_err(|e| {
                        ToolError::Validation(format!("write {out_path:?}: {e}"))
                    })?;
                }
                (sha256_hex(&encoded), encoded.len() as u64)
            }
        };
        report.out_bytes += out_len;
        report.rows.push(PlanRow {
            rs_id: format!("0x{rs:08X}"),
            src_w: img.w,
            src_h: img.h,
            page_w: plan.page_w,
            page_h: plan.page_h,
            tier: plan.tier,
            channels: img.channels,
            action: plan.action,
            src_sha256: src_sha,
            out_sha256: out_sha,
            out_bytes: out_len,
        });
    }
    bar.finish_and_clear();

    // The gate this whole task exists for.
    report.needs_resample_after = report
        .rows
        .iter()
        .filter(|r| r.src_w != r.page_w || r.src_h != r.page_h)
        .filter(|r| r.action == PageAction::Identity)
        .count();
    assert_eq!(
        report.needs_resample_after, 0,
        "derived tier still has off-page members — the plan and the emitter disagree"
    );

    println!(
        "page-resample: {} members — {} identity / {} upscaled / {} downscaled; \
         needsResample {} -> 0; {:.1} MB -> {:.1} MB",
        report.members,
        report.identity,
        report.upscaled,
        report.downscaled,
        report.needs_resample_before,
        report.src_bytes as f64 / 1e6,
        report.out_bytes as f64 / 1e6,
    );

    if args.plan_only {
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
        return Ok(());
    }

    // --- provenance artifacts ------------------------------------------
    std::fs::write(
        args.out.join("page-resample-plan.json"),
        serde_json::to_string_pretty(&report).unwrap(),
    )
    .map_err(|e| ToolError::Validation(format!("write plan: {e}")))?;

    let mut sums = String::new();
    for row in &report.rows {
        let _ = writeln!(sums, "{}  {}.png", row.out_sha256, row.rs_id);
    }
    std::fs::write(args.out.join("page-resample.sha256"), &sums)
        .map_err(|e| ToolError::Validation(format!("write sha256: {e}")))?;

    // The bake's house rule: every derived artifact names its source.
    let mut src_sums = String::new();
    for row in &report.rows {
        let _ = writeln!(src_sums, "{}  {}.png", row.src_sha256, row.rs_id);
    }
    std::fs::write(args.out.join("bake-source.sha256"), &src_sums)
        .map_err(|e| ToolError::Validation(format!("write bake-source.sha256: {e}")))?;

    let provenance = format!(
        "# page-resample derived tier\n\
         \n\
         Produced by `{tool}` (T22 deviation D2 — the pool class key's page-dim\n\
         normalization; T00 re-key 2026-08-09 §4).\n\
         \n\
         - source corpus: `{src}` (NEVER modified; per-member sha256 in\n\
           `bake-source.sha256`)\n\
         - members: {members} — {identity} identity / {up} upscaled / {down} downscaled\n\
         - `needsResample()` over the source tier: {before}; over this tier: 0\n\
         - kernel: {kernel}\n\
         - identity members are {ident_mode} the source, so they are byte-identical\n\
           to it by construction\n\
         - per-member output sha256: `page-resample.sha256`; full plan (source dims,\n\
           page dims, tier, action, both hashes): `page-resample-plan.json`\n\
         \n\
         ## Promotion path (owner)\n\
         \n\
         1. Encode this tier with the UNCHANGED per-member command the live corpus\n\
            used, so the only variable is the dims:\n\
            `basisu -xubc7 -quality <q> -mipmap -output_file <rsId>.ktx2 <rsId>.png`\n\
            (buildbox job — 3,985 members ran ~17 min at -P 16 for T16).\n\
         2. Point a bake at the resulting KTX2 dir: `dat-shard … --tex-xu7 <dir>`.\n\
            The bake reads each KTX2's declared dims and writes them into the TEXREF\n\
            row, setting the `FULL_PAGE_DIMS` tier bit when they are already page\n\
            dims — so `pack-report.json`'s `texref_off_page` is the gate: it must\n\
            read 0 over the covered set.\n\
         3. Both corpora stay live (CAS): the deployed manifest/world_index selects\n\
            one. Rolling back is a redeploy, not a re-bake.\n",
        tool = report.tool,
        src = report.src_dir,
        members = report.members,
        identity = report.identity,
        up = report.upscaled,
        down = report.downscaled,
        before = report.needs_resample_before,
        kernel = report.kernel,
        ident_mode = if args.copy_identity { "COPIED from" } else { "SYMLINKED to" },
    );
    std::fs::write(args.out.join("PROVENANCE.md"), provenance)
        .map_err(|e| ToolError::Validation(format!("write PROVENANCE.md: {e}")))?;

    println!("wrote {:?} (plan + sha256 + bake-source.sha256 + PROVENANCE.md)", args.out);
    Ok(())
}
