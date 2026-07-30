//! `dat-shard` CLI front-end. See `holtburger_tools::dat_shard` for
//! the implementation. Phase 5.0 obj 3 of `docs/thorough.md`;
//! v2 emission landed in Phase 5.2 obj 5 (`docs/manifest.md`).

use std::path::PathBuf;

use clap::Parser;
use holtburger_tools::boot_verify::{EXIT_NOT_FULLY_PACKABLE, format_report, verify_boot_pack};
use holtburger_tools::dat_shard::{
    BakeOutput, DEFAULT_MANIFEST_VERSION, DatShardOptions, parse_hex_u32, shard_bundle_dispatch,
};
use holtburger_tools::error::Result;

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
}

impl Args {
    fn into_options(self) -> DatShardOptions {
        DatShardOptions {
            input_hba: self.input,
            eor_portal: self.eor_portal,
            eor_cell: self.eor_cell,
            eor_local: self.eor_local,
            boot_landblock: self.boot_landblock,
            output_dir: self.output,
            manifest_version: self.manifest_version,
            tex_bc7: self.tex_bc7,
        }
    }
}

fn main() -> Result<()> {
    env_logger::init();
    let args = Args::parse();
    let verify_boot = args.verify_boot_reachability;
    let opts = args.into_options();
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
