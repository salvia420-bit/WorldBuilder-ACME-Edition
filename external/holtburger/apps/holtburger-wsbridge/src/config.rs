//! CLI argument parsing and resolved runtime config.
//!
//! Each WS connection now carries its own destination via a one-time
//! JSON handshake (see `bridge.rs`), so the CLI no longer pins the
//! bridge to a single ACE host. The remaining knobs are the WS listen
//! address, an optional default world-port offset used when the
//! handshake omits `world_port`, and the admission policy (which
//! targets, origins and how many connections; see `admission.rs`).

use crate::admission::{self, Admission, AllowedTarget, OriginPolicy, TargetPolicy};
use anyhow::{Context, Result};
use clap::Parser;
use std::net::SocketAddr;
use std::path::PathBuf;

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

    /// Opt-in: append every relayed UDP datagram to this classic pcap file
    /// (LINKTYPE_RAW; readable by `pcap2jsonl` and Wireshark). Also settable
    /// via the HB_BRIDGE_CAPTURE environment variable; this flag wins. Off
    /// by default. LoginRequest bodies are zeroed; everything else is kept.
    #[arg(long, value_name = "FILE.pcap")]
    pub capture: Option<PathBuf>,

    /// Relay to this ACE target: HOST[:LOGIN[:WORLD]] (ports default to 9000
    /// and LOGIN+1; `localhost` = any loopback address; IPv6 as
    /// `[::1]:9000:9001`). The address the handshake's host resolves to and
    /// both ports must match an entry. Repeatable; replaces the default list
    /// (localhost:9000:9001, play.coldeve.ac:9000:9001).
    #[arg(long, value_name = "HOST[:LOGIN[:WORLD]]")]
    pub allow_target: Vec<String>,

    /// Dev opt-in: relay to any host and ports a handshake names (the bridge
    /// before 2026-10-13). Overrides --allow-target.
    #[arg(long)]
    pub allow_any_target: bool,

    /// Also accept WebSocket upgrades whose Origin is exactly ORIGIN (e.g.
    /// `https://play.example.org`); `*` accepts every Origin. Repeatable.
    /// Always accepted: no Origin (native clients such as holtburger-wsshim),
    /// a loopback or private-network origin, and an origin whose host is the
    /// request's Host (same host: proxy.cjs and its cloudflared tunnel).
    #[arg(long, value_name = "ORIGIN")]
    pub allow_origin: Vec<String>,

    /// Most concurrent WebSocket connections (0 = no cap).
    #[arg(long, default_value_t = admission::DEFAULT_MAX_CONNS)]
    pub max_conns: usize,

    /// Most concurrent connections from one peer IP (0 = no cap). Loopback
    /// peers (local clients, proxy.cjs, SSH and cloudflared tunnels) count
    /// only toward --max-conns.
    #[arg(long, default_value_t = admission::DEFAULT_MAX_CONNS_PER_IP)]
    pub max_conns_per_ip: usize,

    /// Opt-in: most binary frames per second one connection relays to ACE
    /// (bursts up to twice that); frames over the rate are dropped. 0 = no
    /// limit (the default).
    #[arg(long, default_value_t = 0)]
    pub max_frames_per_sec: u32,
}

impl Cli {
    /// The admission policy these flags describe (net-transport-5).
    pub fn admission(&self) -> Result<Admission> {
        let targets = if self.allow_any_target {
            TargetPolicy::Any
        } else if self.allow_target.is_empty() {
            TargetPolicy::defaults()
        } else {
            TargetPolicy::Only(
                self.allow_target
                    .iter()
                    .map(String::as_str)
                    .map(AllowedTarget::parse)
                    .collect::<Result<Vec<_>>>()?,
            )
        };
        Ok(Admission {
            targets,
            origins: OriginPolicy::new(&self.allow_origin),
            max_conns: self.max_conns,
            max_conns_per_ip: self.max_conns_per_ip,
            max_frames_per_sec: self.max_frames_per_sec,
        })
    }
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

    #[test]
    fn capture_flag_is_opt_in() {
        let off = Cli::try_parse_from(["holtburger-wsbridge"]).unwrap();
        assert_eq!(off.capture, None);
        let on = Cli::try_parse_from(["holtburger-wsbridge", "--capture", "s.pcap"]).unwrap();
        assert_eq!(on.capture, Some(PathBuf::from("s.pcap")));
        // The flag does not change the resolved relay config.
        let cfg = Config::from_cli(on).unwrap();
        assert_eq!(cfg.listen.port(), 8080);
    }

    fn admission_of(args: &[&str]) -> Result<Admission> {
        let mut full = vec!["holtburger-wsbridge"];
        full.extend_from_slice(args);
        Cli::try_parse_from(full)?.admission()
    }

    #[test]
    fn admission_defaults_keep_local_use_working() {
        let adm = admission_of(&[]).unwrap();
        assert_eq!(adm.targets, TargetPolicy::defaults());
        assert!(adm.targets.permits_ports(9000, 9001));
        assert_eq!(adm.origins, OriginPolicy::default());
        assert!(!adm.origins.any);
        assert_eq!(adm.max_conns, admission::DEFAULT_MAX_CONNS);
        assert_eq!(adm.max_conns_per_ip, admission::DEFAULT_MAX_CONNS_PER_IP);
        assert_eq!(adm.max_frames_per_sec, 0);
        // The listen default is unchanged.
        assert_eq!(parse(&[]).unwrap().listen.to_string(), "0.0.0.0:8080");
    }

    #[test]
    fn allow_target_is_repeatable_and_replaces_defaults() {
        let adm = admission_of(&[
            "--allow-target",
            "10.0.0.5:9100",
            "--allow-target",
            "[::1]:9000:9001",
        ])
        .unwrap();
        assert_eq!(
            adm.targets,
            TargetPolicy::Only(vec![
                AllowedTarget::parse("10.0.0.5:9100:9101").unwrap(),
                AllowedTarget::parse("::1").unwrap(),
            ])
        );
        assert!(!adm.targets.permits_ports(9200, 9201));
    }

    #[test]
    fn allow_target_rejects_garbage_and_any_target_overrides() {
        assert!(admission_of(&["--allow-target", "host:notaport"]).is_err());
        assert!(admission_of(&["--allow-target", "host:9000:9000"]).is_err());
        let adm = admission_of(&["--allow-target", "10.0.0.5", "--allow-any-target"]).unwrap();
        assert_eq!(adm.targets, TargetPolicy::Any);
    }

    #[test]
    fn origin_and_cap_flags() {
        let adm = admission_of(&[
            "--allow-origin",
            "https://Play.Example.org/",
            "--allow-origin",
            "https://other.example",
            "--max-conns",
            "0",
            "--max-conns-per-ip",
            "4",
            "--max-frames-per-sec",
            "300",
        ])
        .unwrap();
        assert!(!adm.origins.any);
        assert_eq!(
            adm.origins.allowed,
            vec!["https://play.example.org".to_string(), "https://other.example".to_string()]
        );
        assert_eq!(adm.max_conns, 0);
        assert_eq!(adm.max_conns_per_ip, 4);
        assert_eq!(adm.max_frames_per_sec, 300);
        let any = admission_of(&["--allow-origin", "*"]).unwrap();
        assert!(any.origins.any);
        assert!(admission_of(&["--max-conns", "-1"]).is_err());
    }
}
