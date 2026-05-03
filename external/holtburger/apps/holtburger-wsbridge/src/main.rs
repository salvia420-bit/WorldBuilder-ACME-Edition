//! WebSocket↔UDP bridge for the holtburger AC client.
//!
//! See `ARCHITECTURE.md` next to this file for the design and frame protocol.

mod bridge;
mod config;
mod frame;
mod smoke_test;

use anyhow::Result;
use clap::Parser;

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let cli = config::Cli::parse();
    let cfg = config::Config::from_cli(cli)?;
    bridge::run(cfg).await
}
