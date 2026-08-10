//! `dat-shard` CLI front-end. See `holtburger_tools::dat_shard` for
//! the implementation. Phase 5.0 obj 3 of `docs/thorough.md`;
//! v2 emission landed in Phase 5.2 obj 5 (`docs/manifest.md`).

use std::path::PathBuf;

use clap::Parser;
use holtburger_tools::boot_verify::{EXIT_NOT_FULLY_PACKABLE, format_report, verify_boot_pack};
use holtburger_tools::dat_shard::{
    BakeOutput, DEFAULT_MANIFEST_VERSION, DatShardOptions, parse_hex_u32, shard_bundle_dispatch,
};
use holtburger_tools::error::{Result, ToolError};
use holtburger_tools::pack_bake::{PackBakeOptions, RegionRect, emit_packs};
use holtburger_tools::pack_format::PACK_ZSTD_LEVEL;

#[derive(Parser, Debug)]
#[command(
    author,
    version,
    about = "Slice a holtburger asset bundle into content-addressable shards + a manifest + a boot pack"
)]
struct Args {
    /// Existing HBA bundle to shard. Can be combined with
    /// `--eor-portal` / `--eor-cell` / `--eor-local` — when both are
    /// passed, the HBA is read first (so non-retail namespaces like
    /// `holtburger/core` are preserved) and the canonical DATs layer
    /// on top (so `eor/cell|portal|local` records the HBA may have
    /// pruned re-appear).
    #[arg(long, value_name = "HBA")]
    input: Option<PathBuf>,

    /// Canonical retail `client_portal.dat`. Read into the
    /// `eor/portal` namespace.
    #[arg(long, value_name = "DAT")]
    eor_portal: Option<PathBuf>,

    /// Canonical retail `client_cell_1.dat`. Read into the
    /// `eor/cell` namespace.
    #[arg(long, value_name = "DAT")]
    eor_cell: Option<PathBuf>,

    /// Canonical retail `client_local_English.dat`. Read into the
    /// `eor/local` namespace.
    #[arg(long, value_name = "DAT")]
    eor_local: Option<PathBuf>,

    /// Directory of `<rsId>.hbc7` BC7 texture blobs (e.g.
    /// `0x06003789.hbc7`) to publish into the `holtburger/tex-bc7`
    /// namespace, addressed by RenderSurface id so the client can
    /// fetch them lazily like any other shard. Streamed
    /// record-by-record — the blobs never enter the in-memory bundle,
    /// so a ~2 GB BC7 set costs ~0.1 MB of bake RSS. Requires
    /// `--manifest-version=2`. Composable with `--input` /
    /// `--eor-*`; also valid on its own, which produces a side-car
    /// bundle holding only the BC7 namespace.
    #[arg(long, value_name = "DIR")]
    tex_bc7: Option<PathBuf>,

    /// Directory of `<rsId>.hbc7` PREVIEW blobs (quarter-res level0 +
    /// mip chain, P1 of the 2026-08-04 progressive-texture plan) to
    /// publish into `holtburger/tex-bc7-pre`. Same container,
    /// validation, and streaming as `--tex-bc7`.
    #[arg(long, value_name = "DIR")]
    tex_bc7_pre: Option<PathBuf>,

    /// Directory of `<rsId>.ktx2` XUBC7 payloads (P2) to publish into
    /// `holtburger/tex-xu7`. Validated by KTX2 identifier only — the
    /// supercompressed contents are opaque to the bake and must be
    /// served identity (already Zstd inside).
    #[arg(long, value_name = "DIR")]
    tex_xu7: Option<PathBuf>,

    /// Spawn-area landblock for boot-pack inclusion. Hex
    /// (`0xA9B4`, default Holtburg). String-default rather than
    /// typed-default so the value flows through `parse_hex_u32`
    /// once — clap's `default_value_t` would display the u32 as
    /// decimal then re-parse that as hex, scrambling the value.
    #[arg(long, value_parser = parse_hex_u32, default_value = "0xA9B4")]
    boot_landblock: u32,

    /// Manifest schema version to emit (1 or 2). Phase 5.2 obj 5
    /// added v2 as the new default; v1 stays available for one
    /// release cycle to drain in-flight CDN deploys. v2 emission
    /// produces a ≈2 KB top-level JSON + per-namespace binary
    /// catalogs in `manifest/` + 2-level-prefix shard layout +
    /// convention-URL symlinks.
    #[arg(long, value_name = "VERSION", default_value_t = DEFAULT_MANIFEST_VERSION)]
    manifest_version: u32,

    /// Output directory. Created if missing. Will contain
    /// `manifest.json`, `shards/`, `boot.hba`, and (v2 only)
    /// `manifest/<namespace>.bin` per-namespace catalogs.
    #[arg(long, value_name = "DIR")]
    output: PathBuf,

    /// After writing `boot.hba`, run the read-only boot-reachability
    /// walk against it (E4) and print whether `--boot-landblock` is
    /// *fully packable* — i.e. every GfxObj/Surface/SurfaceTexture/
    /// Texture/Palette its spawn-area placements reference made it into
    /// the boot pack. Exits non-zero (code 3) when NOT fully packable so
    /// CI can gate the generated boot pack. Additive: off by default,
    /// leaves the produced files untouched.
    #[arg(long)]
    verify_boot_reachability: bool,

    // ---- T10 pack emission (pipeline re-engineering ST1) --------------

    /// Emit the HBP1/HBSI1 pack world (T10 dual-emit). Requires
    /// `--eor-portal` + `--eor-cell` (the pack bake reads the canonical
    /// DATs on demand). Without `--legacy-layers` this SKIPS the legacy
    /// shard/catalog/boot.hba emission and only adds packs beside an
    /// existing `manifest.json`.
    #[arg(long)]
    emit_packs: bool,

    /// With `--emit-packs`: ALSO run the legacy emission (unchanged code
    /// path — the dual-emit shape SPEC §3 T10 requires). Without
    /// `--emit-packs` this flag is a no-op (legacy is the default).
    #[arg(long)]
    legacy_layers: bool,

    /// Per-LB scenery JSONL dir (`0xXXYY.scenery.jsonl`) folded into
    /// tile-pack PLACEMENTS sections + walked for closure roots.
    #[arg(long, value_name = "DIR")]
    scenery_dir: Option<PathBuf>,

    /// Per-LB spawns JSONL dir, folded verbatim (zstd) into SPAWNS.
    #[arg(long, value_name = "DIR")]
    spawns_dir: Option<PathBuf>,

    /// Per-LB events JSONL dir, folded verbatim (zstd) into EVENTS.
    #[arg(long, value_name = "DIR")]
    events_dir: Option<PathBuf>,

    /// Extra preview HBC7 dir covering xu7-only rsIds (output of
    /// `apps/holtburger-tools/scripts/derive-pvw-xu7.mjs`).
    #[arg(long, value_name = "DIR")]
    tex_pvw_extra: Option<PathBuf>,

    /// t1024 terrain payload dir (`<rsId>_color.hbc7` + `<rsId>_nra.hbc7`,
    /// e.g. apps/holtburger-web/scene3d/assets/terrain_bc7/t1024) — the
    /// t128 boot slice (one CAS file per channel) is mip-sliced from it.
    #[arg(long, value_name = "DIR")]
    terrain_bc7_dir: Option<PathBuf>,

    /// Bound the pack bake to LB rectangles `X0Y0:X1Y1` (hex corners,
    /// inclusive; repeatable). Default: full world (buildbox-scale).
    #[arg(long, value_name = "RECT")]
    pack_region: Vec<String>,

    /// zstd level for pack sections. Level is part of the deterministic
    /// emission contract — leave at default for comparable bakes.
    #[arg(long, default_value_t = PACK_ZSTD_LEVEL)]
    pack_zstd_level: i32,

    /// Re-open every emitted pack and fail loud on any dangling REFS
    /// edge or missing declared preview (generalizes
    /// `--verify-boot-reachability` to the pack world).
    #[arg(long)]
    verify_closure: bool,

    /// Re-emit each pack a second time in-process and fail on any byte
    /// difference (intra-run determinism check; BAKE-CI's double-run
    /// covers cross-run determinism).
    #[arg(long)]
    verify_deterministic: bool,

    // ---- RELIEF-IN-BAKE -----------------------------------------------

    /// With `--emit-packs`: ALSO emit relief-variant geometry (GEOMR
    /// sections) for the `set_gfx_relief(true, 0, SCALE)` profile — the
    /// material-identity rails the client ships at `subdivLevel 0`. The
    /// relief-free GEOM rows are emitted unchanged either way (they are the
    /// byte-exact differ baseline), so this is purely additive; without the
    /// flag the bake is byte-identical to a pre-RELIEF-IN-BAKE bake.
    #[arg(long, value_name = "SCALE")]
    geom_relief: Option<f32>,

    // ---- PAGE-RESAMPLE ------------------------------------------------

    /// With `--emit-packs`: FAIL the bake when any TEXREF'd rsId with a
    /// compressed full tier is stored OFF its array page — i.e. when its
    /// declared dims are not the square pow2 page (256²/512²/1024²/2048²)
    /// the pool class key allocates for its class (T22 D2 / T00 re-key
    /// 2026-08-09 §4). This is the acceptance gate for a bake over a
    /// corpus that has been through `page-resample`; without it the bake
    /// only CENSUSES the position (`texref_on_page` / `texref_off_page` in
    /// `pack-report.json`), which is the right behaviour for every
    /// pre-resample corpus.
    #[arg(long)]
    require_page_dims: bool,
}

impl Args {
    fn shard_options(&self) -> DatShardOptions {
        DatShardOptions {
            input_hba: self.input.clone(),
            eor_portal: self.eor_portal.clone(),
            eor_cell: self.eor_cell.clone(),
            eor_local: self.eor_local.clone(),
            boot_landblock: self.boot_landblock,
            output_dir: self.output.clone(),
            manifest_version: self.manifest_version,
            tex_bc7: self.tex_bc7.clone(),
            tex_bc7_pre: self.tex_bc7_pre.clone(),
            tex_xu7: self.tex_xu7.clone(),
        }
    }

    fn pack_options(&self) -> Result<PackBakeOptions> {
        let (Some(portal), Some(cell)) = (&self.eor_portal, &self.eor_cell) else {
            return Err(ToolError::Validation(
                "--emit-packs requires --eor-portal and --eor-cell (the pack \
                 bake reads the canonical DATs on demand)"
                    .into(),
            ));
        };
        let regions = if self.pack_region.is_empty() {
            None
        } else {
            Some(
                self.pack_region
                    .iter()
                    .map(|s| RegionRect::parse(s))
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(ToolError::Validation)?,
            )
        };
        Ok(PackBakeOptions {
            eor_portal: portal.clone(),
            eor_cell: cell.clone(),
            scenery_dir: self.scenery_dir.clone(),
            spawns_dir: self.spawns_dir.clone(),
            events_dir: self.events_dir.clone(),
            tex_bc7: self.tex_bc7.clone(),
            tex_bc7_pre: self.tex_bc7_pre.clone(),
            tex_xu7: self.tex_xu7.clone(),
            tex_pvw_extra: self.tex_pvw_extra.clone(),
            terrain_bc7_dir: self.terrain_bc7_dir.clone(),
            regions,
            boot_landblock: self.boot_landblock,
            output_dir: self.output.clone(),
            zstd_level: self.pack_zstd_level,
            verify_closure: self.verify_closure,
            verify_deterministic: self.verify_deterministic,
            geom_relief_scale: self.geom_relief,
            require_page_dims: self.require_page_dims,
        })
    }
}

fn main() -> Result<()> {
    env_logger::init();
    let args = Args::parse();

    // T10 dual-emit routing: legacy runs unless --emit-packs was given
    // WITHOUT --legacy-layers. The legacy path is byte-identical to the
    // pre-T10 emitter (it is the same code).
    let run_legacy = !args.emit_packs || args.legacy_layers;
    if args.emit_packs {
        // Validate pack options BEFORE the (long) legacy bake runs.
        args.pack_options()?;
    }
    if run_legacy {
        run_legacy_bake(&args)?;
    }
    if args.emit_packs {
        let popts = args.pack_options()?;
        println!("dat-shard: emitting HBP1/HBSI1 packs (T10)...");
        let report = emit_packs(&popts)?;
        println!(
            "dat-shard: packs — {} packs / {:.1} MB (+ index {:.1} KB), \
             {} tiles / {} interiors / {} LBs, scope {}",
            report.packs_emitted,
            report.pack_bytes_total as f64 / (1024.0 * 1024.0),
            report.index_bytes as f64 / 1024.0,
            report.tiles,
            report.interiors,
            report.landblocks,
            report.scope,
        );
        println!(
            "dat-shard: texref — {} rows, missingPvw={}, legacyOnly={}, \
             pvw bytes {:.2} MB (pre {} / full {} / extra {}, unsliceable {})",
            report.texref_rows,
            report.texref_missing_pvw,
            report.texref_legacy_only,
            report.pvw_bytes_total as f64 / (1024.0 * 1024.0),
            report.pvw_from_pre,
            report.pvw_from_full,
            report.pvw_from_extra,
            report.pvw_unsliceable,
        );
        if report.texref_missing_pvw > 0 {
            eprintln!(
                "dat-shard: WARNING {} TEXREF'd rsId(s) have a compressed full \
                 tier but no preview (D-05.5.4 coverage violation — see \
                 pvw_wanted_from_xu7 in pack-report.json; run \
                 scripts/derive-pvw-xu7.mjs and re-bake with --tex-pvw-extra)",
                report.texref_missing_pvw
            );
        }
    }
    Ok(())
}

fn run_legacy_bake(args: &Args) -> Result<()> {
    let verify_boot = args.verify_boot_reachability;
    let opts = args.shard_options();
    println!(
        "dat-shard: starting (manifest v{})...",
        opts.manifest_version
    );
    let bake = shard_bundle_dispatch(&opts)?;
    println!(
        "dat-shard: done — manifest v{}, {} unique shards, {} boot covers, manifest.json at {:?}",
        bake.manifest_version(),
        bake.unique_shard_count(),
        bake.boot_covers_count(),
        opts.output_dir.join("manifest.json"),
    );
    if let BakeOutput::V2(ref r) = bake
        && opts.tex_bc7.is_some()
    {
        println!(
            "dat-shard: tex-bc7 — {} records, {} bytes ({:.1} MB), {} skipped",
            r.tex_bc7_records,
            r.tex_bc7_bytes,
            r.tex_bc7_bytes as f64 / (1024.0 * 1024.0),
            r.tex_bc7_skipped,
        );
        if r.tex_bc7_skipped > 0 {
            eprintln!(
                "dat-shard: {} --tex-bc7 file(s) failed the HBC7 header/size check and were NOT published (re-run with RUST_LOG=warn for per-file reasons)",
                r.tex_bc7_skipped
            );
        }
    }
    if let BakeOutput::V2(ref r) = bake
        && opts.tex_bc7_pre.is_some()
    {
        println!(
            "dat-shard: tex-bc7-pre — {} records, {} bytes ({:.1} MB), {} skipped",
            r.tex_bc7_pre_records,
            r.tex_bc7_pre_bytes,
            r.tex_bc7_pre_bytes as f64 / (1024.0 * 1024.0),
            r.tex_bc7_pre_skipped,
        );
        if r.tex_bc7_pre_skipped > 0 {
            eprintln!(
                "dat-shard: {} --tex-bc7-pre file(s) failed the HBC7 header/size check and were NOT published",
                r.tex_bc7_pre_skipped
            );
        }
    }
    if let BakeOutput::V2(ref r) = bake
        && opts.tex_xu7.is_some()
    {
        println!(
            "dat-shard: tex-xu7 — {} records, {} bytes ({:.1} MB), {} skipped",
            r.tex_xu7_records,
            r.tex_xu7_bytes,
            r.tex_xu7_bytes as f64 / (1024.0 * 1024.0),
            r.tex_xu7_skipped,
        );
        if r.tex_xu7_skipped > 0 {
            eprintln!(
                "dat-shard: {} --tex-xu7 file(s) failed the KTX2 identifier check and were NOT published",
                r.tex_xu7_skipped
            );
        }
    }

    if verify_boot {
        // The boot pack is always written to `<output>/boot.hba` by
        // `write_boot_pack`. Re-open it read-only and walk it.
        let boot_hba = opts.output_dir.join("boot.hba");
        let result = verify_boot_pack(&boot_hba, opts.boot_landblock)?;
        print!("{}", format_report(&result, opts.boot_landblock));
        if !result.fully_packable {
            eprintln!(
                "dat-shard: boot landblock 0x{:04X} is NOT fully packable ({} dangling DID(s)) — boot pack gate FAILED",
                opts.boot_landblock,
                result.missing_dids.len()
            );
            std::process::exit(EXIT_NOT_FULLY_PACKABLE);
        }
        println!(
            "dat-shard: boot landblock 0x{:04X} is fully packable (visual chain) ✅",
            opts.boot_landblock
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn verify_boot_reachability_is_off_by_default() {
        let args = Args::try_parse_from(["dat-shard", "--input", "bundle.hba", "--output", "out"])
            .expect("default args should parse");
        assert!(!args.verify_boot_reachability);
    }

    #[test]
    fn verify_boot_reachability_flag_parses() {
        let args = Args::try_parse_from([
            "dat-shard",
            "--input",
            "bundle.hba",
            "--output",
            "out",
            "--boot-landblock",
            "0xA9B4",
            "--verify-boot-reachability",
        ])
        .expect("verify-boot-reachability args should parse");
        assert!(args.verify_boot_reachability);
        assert_eq!(args.boot_landblock, 0xA9B4);
    }

    #[test]
    fn tex_bc7_flag_is_optional_and_parses() {
        let bare = Args::try_parse_from(["dat-shard", "--input", "bundle.hba", "--output", "out"])
            .expect("default args should parse");
        assert!(bare.tex_bc7.is_none(), "--tex-bc7 must be opt-in");

        let with_dir = Args::try_parse_from([
            "dat-shard",
            "--output",
            "out",
            "--tex-bc7",
            "/mnt/blocks",
        ])
        .expect("--tex-bc7 alone should parse (side-car bundle)");
        assert_eq!(
            with_dir.tex_bc7.as_deref(),
            Some(std::path::Path::new("/mnt/blocks"))
        );
        // Default manifest version must be the v2 the flag requires.
        assert_eq!(with_dir.manifest_version, DEFAULT_MANIFEST_VERSION);
    }

    #[test]
    fn cli_help_lists_verify_boot_reachability_flag() {
        let help = Args::command().render_long_help().to_string();
        assert!(
            help.contains("--verify-boot-reachability"),
            "help should advertise the new flag, got:\n{help}"
        );
        assert!(help.contains("fully packable"));
    }
}
