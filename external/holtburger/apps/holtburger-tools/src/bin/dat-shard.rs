//! `dat-shard` CLI front-end. See `holtburger_tools::dat_shard` for
//! the implementation. Phase 5.0 obj 3 of `docs/thorough.md`;
//! v2 emission landed in Phase 5.2 obj 5 (`docs/manifest.md`).

use std::path::PathBuf;

use clap::Parser;
use holtburger_tools::dat_shard::{
    DEFAULT_MANIFEST_VERSION, DatShardOptions, parse_hex_u32, shard_bundle_dispatch,
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
        }
    }
}

fn main() -> Result<()> {
    env_logger::init();
    let opts = Args::parse().into_options();
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
    Ok(())
}
