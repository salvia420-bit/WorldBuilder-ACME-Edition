//! Entry point for the `holtburger-wsshim` binary — the client-side UDP↔WS
//! shim that sits in front of an unmodified `holtburger-cli` and tunnels its
//! UDP traffic to a remote `holtburger-wsbridge`.
//!
//! See `ARCHITECTURE.md` next to the bridge crate for the design and frame
//! protocol; the `holtburger_wsbridge::shim` module docs cover the cli/shim
//! contract specifically.

use anyhow::Result;
use clap::Parser;
use holtburger_wsbridge::shim;

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let cli = shim::Cli::parse();
    let cfg = shim::Config::from_cli(cli)?;
    shim::run(cfg).await
}
