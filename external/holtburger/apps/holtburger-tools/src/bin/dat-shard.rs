//! `dat-shard` CLI front-end. See `holtburger_tools::dat_shard` for
//! the implementation. Phase 5.0 obj 3 of `docs/thorough.md`.

use std::path::PathBuf;

use clap::Parser;
use holtburger_tools::dat_shard::{DEFAULT_BOOT_LANDBLOCK, DatShardOptions, parse_hex_u32, shard_bundle};
use holtburger_tools::error::Result;

#[derive(Parser, Debug)]
#[command(
    author,
    version,
    about = "Slice a holtburger asset bundle into content-addressable shards + a manifest + a boot pack"
)]
struct Args {
    /// Existing HBA bundle to shard. Mutually-exclusive with
    /// `--eor-portal` / `--eor-cell` / `--eor-local`.
    #[arg(long, value_name = "HBA", conflicts_with_all = ["eor_portal", "eor_cell", "eor_local"])]
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
    /// (`0xA9B4`, default Holtburg).
    #[arg(long, value_parser = parse_hex_u32, default_value_t = DEFAULT_BOOT_LANDBLOCK)]
    boot_landblock: u32,

    /// Output directory. Created if missing. Will contain
    /// `manifest.json`, `shards/`, and `boot.hba`.
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
        }
    }
}

fn main() -> Result<()> {
    env_logger::init();
    let opts = Args::parse().into_options();
    println!("dat-shard: starting...");
    let manifest = shard_bundle(&opts)?;
    println!(
        "dat-shard: done — {} shards, {} boot covers, manifest.json at {:?}",
        manifest.shards.len(),
        manifest.boot_pack.covers.len(),
        opts.output_dir.join("manifest.json"),
    );
    Ok(())
}
