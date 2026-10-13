//! Entry point for the `holtburger-wsbridge` binary — the server-side WS↔UDP
//! bridge that sits in front of an ACE server.
//!
//! See `ARCHITECTURE.md` next to this file for the design and frame protocol.
//! The shared library that backs both this binary and `holtburger-wsshim`
//! lives in `src/lib.rs`.

use anyhow::{Context, Result};
use clap::Parser;
use holtburger_wsbridge::{bridge, capture, config};
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let cli = config::Cli::parse();
    // test-tooling-4: opt-in pcap capture (`--capture` / HB_BRIDGE_CAPTURE).
    let capture_path =
        capture::resolve_capture_path(cli.capture.clone(), std::env::var_os(capture::CAPTURE_ENV));
    // net-transport-5: target allowlist, Origin rules, connection caps.
    let admission = cli.admission()?;
    let cfg = config::Config::from_cli(cli)?;
    let capture = match capture_path {
        Some(path) => Some(Arc::new(
            capture::PcapCapture::create(&path)
                .with_context(|| format!("create capture file {}", path.display()))?,
        )),
        None => None,
    };
    bridge::run_admitted(cfg, admission, capture).await
}
