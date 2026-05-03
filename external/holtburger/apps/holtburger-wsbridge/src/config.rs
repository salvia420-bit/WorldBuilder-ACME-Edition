//! CLI argument parsing and resolved runtime config.

use anyhow::{Context, Result, anyhow};
use clap::Parser;
use std::net::{IpAddr, SocketAddr};

/// WebSocket↔UDP bridge for the holtburger AC client.
///
/// Listens on a TCP port for WebSocket connections and proxies binary
/// frames to/from a configured ACE server's UDP login + world ports.
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
pub struct Cli {
    /// WS listen address (host:port).
    #[arg(long, default_value = "0.0.0.0:8080")]
    pub listen: String,

    /// ACE server hostname or IPv4 address.
    #[arg(long, default_value = "127.0.0.1")]
    pub ace_host: String,

    /// ACE login UDP port. World port defaults to login + 1 to match
    /// holtburger's auth.rs:41-44 convention.
    #[arg(long, default_value_t = 9000)]
    pub ace_login_port: u16,

    /// ACE world UDP port. Defaults to `ace-login-port + 1`.
    #[arg(long)]
    pub ace_world_port: Option<u16>,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub listen: SocketAddr,
    pub ace_ip: IpAddr,
    pub ace_login_port: u16,
    pub ace_world_port: u16,
}

impl Config {
    pub fn from_cli(cli: Cli) -> Result<Self> {
        let listen: SocketAddr = cli
            .listen
            .parse()
            .with_context(|| format!("invalid --listen value: {}", cli.listen))?;

        let ace_ip: IpAddr = cli
            .ace_host
            .parse()
            .with_context(|| format!("invalid --ace-host (expected IP literal): {}", cli.ace_host))?;

        let ace_world_port = match cli.ace_world_port {
            Some(p) => p,
            None => cli
                .ace_login_port
                .checked_add(1)
                .ok_or_else(|| anyhow!("ace-login-port + 1 overflows u16"))?,
        };

        if ace_world_port == cli.ace_login_port {
            return Err(anyhow!(
                "ace-login-port and ace-world-port must differ (got {} and {})",
                cli.ace_login_port,
                ace_world_port
            ));
        }

        Ok(Config {
            listen,
            ace_ip,
            ace_login_port: cli.ace_login_port,
            ace_world_port,
        })
    }

    /// Returns true if `port` is one of the two ACE ports we're willing to
    /// forward to/from. Used to drop misframed/forged traffic early.
    pub fn is_ace_port(&self, port: u16) -> bool {
        port == self.ace_login_port || port == self.ace_world_port
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
    fn defaults_world_port_to_login_plus_one() {
        let cfg = parse(&["--ace-host", "127.0.0.1"]).unwrap();
        assert_eq!(cfg.ace_login_port, 9000);
        assert_eq!(cfg.ace_world_port, 9001);
        assert!(cfg.is_ace_port(9000));
        assert!(cfg.is_ace_port(9001));
        assert!(!cfg.is_ace_port(9002));
    }

    #[test]
    fn rejects_equal_login_and_world_ports() {
        let err = parse(&[
            "--ace-host",
            "127.0.0.1",
            "--ace-login-port",
            "9000",
            "--ace-world-port",
            "9000",
        ])
        .unwrap_err();
        assert!(err.to_string().contains("must differ"));
    }

    #[test]
    fn rejects_overflow_world_port() {
        let err = parse(&["--ace-host", "127.0.0.1", "--ace-login-port", "65535"]).unwrap_err();
        assert!(err.to_string().contains("overflow"));
    }

    #[test]
    fn explicit_world_port_overrides_default() {
        let cfg = parse(&[
            "--ace-host",
            "10.0.0.1",
            "--ace-login-port",
            "9000",
            "--ace-world-port",
            "9100",
        ])
        .unwrap();
        assert_eq!(cfg.ace_login_port, 9000);
        assert_eq!(cfg.ace_world_port, 9100);
    }
}
