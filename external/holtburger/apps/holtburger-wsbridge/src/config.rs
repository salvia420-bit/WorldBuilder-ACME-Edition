//! CLI argument parsing and resolved runtime config.
//!
//! Each WS connection now carries its own destination via a one-time
//! JSON handshake (see `bridge.rs`), so the CLI no longer pins the
//! bridge to a single ACE host. The remaining knobs are the WS listen
//! address and an optional default world-port offset used when the
//! handshake omits `world_port`.

use anyhow::{Context, Result};
use clap::Parser;
use std::net::SocketAddr;

#[derive(Parser, Debug)]
#[command(
    author,
    version,
    about = "WebSocket→UDP bridge in front of one or more ACE servers. Each WS connection announces its destination via a JSON handshake; binary frames after that carry only [port:u16][payload].",
    long_about = None,
)]
pub struct Cli {
    /// WS listen address (host:port).
    #[arg(long, default_value = "0.0.0.0:8080")]
    pub listen: String,

    /// Default world-port offset relative to the announced login port.
    /// Used when a handshake omits `world_port`. ACE convention is +1.
    #[arg(long, default_value_t = 1)]
    pub default_world_port_offset: i32,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub listen: SocketAddr,
    pub default_world_port_offset: i32,
}

impl Config {
    pub fn from_cli(cli: Cli) -> Result<Self> {
        let listen: SocketAddr = cli
            .listen
            .parse()
            .with_context(|| format!("invalid --listen value: {}", cli.listen))?;

        Ok(Config {
            listen,
            default_world_port_offset: cli.default_world_port_offset,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Config> {
        let mut full = vec!["holtburger-wsbridge"];
        full.extend_from_slice(args);
        let cli = Cli::try_parse_from(full)?;
        Config::from_cli(cli)
    }

    #[test]
    fn defaults_listen_and_offset() {
        let cfg = parse(&[]).unwrap();
        assert_eq!(cfg.listen.port(), 8080);
        assert_eq!(cfg.default_world_port_offset, 1);
    }

    #[test]
    fn rejects_bad_listen() {
        assert!(parse(&["--listen", "not a sockaddr"]).is_err());
    }
}
