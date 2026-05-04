//! Entry point for the `holtburger-wsbridge` binary — the server-side WS↔UDP
//! bridge that sits in front of an ACE server.
//!
//! See `ARCHITECTURE.md` next to this file for the design and frame protocol.
//! The shared library that backs both this binary and `holtburger-wsshim`
//! lives in `src/lib.rs`.

use anyhow::Result;
use clap::Parser;
use holtburger_wsbridge::{bridge, config};

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let cli = config::Cli::parse();
    let cfg = config::Config::from_cli(cli)?;
    bridge::run(cfg).await
}
