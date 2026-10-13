//! Admission control for the WS listener (net-transport-5, 2026-10-13).
//!
//! The bridge listens on `0.0.0.0` and used to upgrade every WebSocket, then
//! relay to whatever host and ports the client's JSON handshake named. Any web
//! page that a browser on the LAN, the tailnet or the public cloudflared tunnel
//! (`scripts/proxy.cjs`) could load was able to use it as a general UDP relay,
//! and an unbounded number of connections could exhaust its file descriptors.
//! Admission now runs in this order (after WebAC
//! services/ws-tcp-bridge/src/server.ts `admit()`, AGPL-3.0):
//!
//! 1. **Connection caps**, at accept: `--max-conns` overall, then
//!    `--max-conns-per-ip`. Loopback peers count only toward the overall cap:
//!    behind proxy.cjs, cloudflared or an SSH tunnel every peer is 127.0.0.1.
//! 2. **Origin**, during the HTTP upgrade (403 on a miss): see
//!    [`OriginPolicy::permits`].
//! 3. **Target allowlist**, after the JSON handshake has resolved the host:
//!    the resolved IP and both ports must match an `--allow-target` entry
//!    (`ServerHello` error on a miss). This is the guard that matters behind
//!    the tunnel, where the Origin is the tunnel's own host and every peer is
//!    loopback.
//!
//! The bridge also bounds the upgrade plus JSON handshake
//! ([`HANDSHAKE_TIMEOUT`], so a socket that never says hello cannot hold a cap
//! slot) and the WebSocket message size ([`MAX_WS_MESSAGE_BYTES`]). A
//! per-connection frame rate (`--max-frames-per-sec`) is opt-in.

use anyhow::{Context, Result, anyhow, bail};
use std::collections::HashMap;
use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tokio::net::lookup_host;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request};
use tokio_tungstenite::tungstenite::http::{StatusCode, header};

/// ACE's default login port; an `--allow-target` without ports means this.
pub const ACE_LOGIN_PORT: u16 = 9000;
/// ACE's default world port (login + 1).
pub const ACE_WORLD_PORT: u16 = 9001;

/// The targets a bridge started without `--allow-target` relays to. `localhost`
/// is the local ACE: the login form's default `server_host=127.0.0.1`, the
/// tunnel recipe, the multi-agent drivers and the Rynth supervisor all use it.
/// `play.coldeve.ac` is the public server the owner plays through this bridge
/// (22 bridged sessions in /mnt/wbterminal2/wsbridge_console.log, latest
/// 2026-10-08). Giving any `--allow-target` replaces this list.
pub const DEFAULT_ALLOW_TARGETS: &[&str] = &["localhost:9000:9001", "play.coldeve.ac:9000:9001"];

/// Default `--max-conns`. Each connection holds two file descriptors (the
/// WebSocket and its UDP socket); this keeps the bridge well under the usual
/// 1024 soft limit.
pub const DEFAULT_MAX_CONNS: usize = 256;

/// Default `--max-conns-per-ip` for non-loopback peers.
pub const DEFAULT_MAX_CONNS_PER_IP: usize = 16;

/// Bound on the WebSocket upgrade, and separately on the JSON handshake that
/// follows it. Every client (the browser's `WsTransport`, holtburger-wsshim)
/// sends its hello as soon as the socket opens.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

/// Largest WebSocket message or frame the bridge accepts. One frame is one AC
/// packet (at most `frame::MAX_PACKET_BYTES` + 2) or the small JSON hello;
/// tungstenite's own default (64 MiB) let one connection buffer far more.
pub const MAX_WS_MESSAGE_BYTES: usize = 64 * 1024;

/// The admission policy a bridge runs under.
#[derive(Clone, Debug)]
pub struct Admission {
    pub targets: TargetPolicy,
    pub origins: OriginPolicy,
    /// Most concurrent connections; 0 = no cap.
    pub max_conns: usize,
    /// Most concurrent connections from one non-loopback peer IP; 0 = no cap.
    pub max_conns_per_ip: usize,
    /// Most binary frames per second one connection relays to ACE (burst 2x);
    /// 0 = no limit.
    pub max_frames_per_sec: u32,
}

impl Default for Admission {
    /// The binary's defaults: [`DEFAULT_ALLOW_TARGETS`], the default Origin
    /// rules, [`DEFAULT_MAX_CONNS`], [`DEFAULT_MAX_CONNS_PER_IP`], no frame rate.
    fn default() -> Self {
        Self {
            targets: TargetPolicy::defaults(),
            origins: OriginPolicy::default(),
            max_conns: DEFAULT_MAX_CONNS,
            max_conns_per_ip: DEFAULT_MAX_CONNS_PER_IP,
            max_frames_per_sec: 0,
        }
    }
}

impl Admission {
    /// No admission control: any Origin, any target, no caps, no frame rate
    /// (the bridge before 2026-10-13). Used by the test seams
    /// `bridge::accept_loop` / `accept_loop_with_capture`.
    pub fn unrestricted() -> Self {
        Self {
            targets: TargetPolicy::Any,
            origins: OriginPolicy::any(),
            max_conns: 0,
            max_conns_per_ip: 0,
            max_frames_per_sec: 0,
        }
    }
}

fn cap_text(n: usize) -> String {
    if n == 0 {
        "unlimited".to_string()
    } else {
        n.to_string()
    }
}

impl fmt::Display for Admission {
    /// One-line summary for the startup log.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "targets {}; origins {}", self.targets, self.origins)?;
        write!(
            f,
            "; max conns {} ({} per non-loopback IP)",
            cap_text(self.max_conns),
            cap_text(self.max_conns_per_ip)
        )?;
        if self.max_frames_per_sec > 0 {
            write!(f, "; max {} frames/s per connection", self.max_frames_per_sec)?;
        }
        Ok(())
    }
}

// ─── Targets ────────────────────────────────────────────────────────────────

/// Host part of an `--allow-target` entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TargetHost {
    /// `localhost`: any loopback address (127.0.0.0/8, ::1).
    Loopback,
    /// An IP literal: exactly that address.
    Ip(IpAddr),
    /// A DNS name (lowercase): the address it resolves to.
    Name(String),
}

/// One `--allow-target HOST[:LOGIN[:WORLD]]` entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AllowedTarget {
    pub host: TargetHost,
    pub login_port: u16,
    pub world_port: u16,
}

impl AllowedTarget {
    /// Parse `HOST[:LOGIN[:WORLD]]`. LOGIN defaults to 9000 and WORLD to
    /// LOGIN + 1. `localhost` means any loopback address. An IPv6 literal with
    /// ports is bracketed (`[::1]:9000:9001`); a bare one takes no ports.
    pub fn parse(spec: &str) -> Result<Self> {
        let spec = spec.trim();
        let (host, ports) = if let Some(rest) = spec.strip_prefix('[') {
            let (host, after) = rest
                .split_once(']')
                .ok_or_else(|| anyhow!("--allow-target {spec:?}: missing ']'"))?;
            let ports = if after.is_empty() {
                None
            } else {
                Some(after.strip_prefix(':').ok_or_else(|| {
                    anyhow!("--allow-target {spec:?}: expected ':' after ']'")
                })?)
            };
            (host, ports)
        } else if spec.parse::<Ipv6Addr>().is_ok() {
            (spec, None)
        } else {
            match spec.split_once(':') {
                Some((host, ports)) => (host, Some(ports)),
                None => (spec, None),
            }
        };
        if host.is_empty() {
            bail!("--allow-target {spec:?}: empty host");
        }

        let (login_port, world_port) = match ports {
            None => (ACE_LOGIN_PORT, ACE_WORLD_PORT),
            Some(ports) => {
                let (login, world) = match ports.split_once(':') {
                    Some((login, world)) => (login, Some(world)),
                    None => (ports, None),
                };
                let login_port: u16 = login
                    .parse()
                    .with_context(|| format!("--allow-target {spec:?}: bad login port {login:?}"))?;
                let world_port: u16 = match world {
                    Some(world) => world.parse().with_context(|| {
                        format!("--allow-target {spec:?}: bad world port {world:?}")
                    })?,
                    None => login_port.checked_add(1).ok_or_else(|| {
                        anyhow!("--allow-target {spec:?}: login port + 1 overflows")
                    })?,
                };
                if login_port == 0 || world_port == 0 {
                    bail!("--allow-target {spec:?}: ports must be non-zero");
                }
                if login_port == world_port {
                    bail!("--allow-target {spec:?}: login and world ports must differ");
                }
                (login_port, world_port)
            }
        };

        let host = if host.eq_ignore_ascii_case("localhost") {
            TargetHost::Loopback
        } else if let Ok(ip) = host.parse::<IpAddr>() {
            TargetHost::Ip(ip.to_canonical())
        } else {
            TargetHost::Name(host.trim_end_matches('.').to_ascii_lowercase())
        };
        Ok(Self {
            host,
            login_port,
            world_port,
        })
    }
}

impl fmt::Display for AllowedTarget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.host {
            TargetHost::Loopback => f.write_str("localhost")?,
            TargetHost::Ip(IpAddr::V6(v6)) => write!(f, "[{v6}]")?,
            TargetHost::Ip(ip) => write!(f, "{ip}")?,
            TargetHost::Name(name) => f.write_str(name)?,
        }
        write!(f, ":{}:{}", self.login_port, self.world_port)
    }
}

/// Which ACE targets a handshake may name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TargetPolicy {
    /// `--allow-any-target`: whatever host and ports the client names.
    Any,
    /// Only these (resolved IP and both ports must match one entry).
    Only(Vec<AllowedTarget>),
}

impl TargetPolicy {
    /// [`DEFAULT_ALLOW_TARGETS`].
    pub fn defaults() -> Self {
        TargetPolicy::Only(
            DEFAULT_ALLOW_TARGETS
                .iter()
                .map(|spec| AllowedTarget::parse(spec).expect("DEFAULT_ALLOW_TARGETS parse"))
                .collect(),
        )
    }

    /// Whether any entry has exactly these ports. Checked before the client's
    /// host is resolved, so a disallowed pair costs no DNS lookup.
    pub fn permits_ports(&self, login_port: u16, world_port: u16) -> bool {
        match self {
            TargetPolicy::Any => true,
            TargetPolicy::Only(list) => list
                .iter()
                .any(|t| t.login_port == login_port && t.world_port == world_port),
        }
    }

    /// Whether a handshake that named `host`, which resolved to `ip`, may be
    /// relayed to `ip` on these ports. Literal entries are checked first, so
    /// the common loopback case does no DNS. A name entry matches when the
    /// handshake named that host (so `ip` is its address) or when the name
    /// resolves to `ip` now.
    pub async fn permits(&self, host: &str, ip: IpAddr, login_port: u16, world_port: u16) -> bool {
        let list = match self {
            TargetPolicy::Any => return true,
            TargetPolicy::Only(list) => list,
        };
        let ip = ip.to_canonical();
        let host = host.trim().trim_end_matches('.');
        let mut names = Vec::new();
        for target in list
            .iter()
            .filter(|t| t.login_port == login_port && t.world_port == world_port)
        {
            match &target.host {
                TargetHost::Loopback => {
                    if ip.is_loopback() {
                        return true;
                    }
                }
                TargetHost::Ip(allowed) => {
                    if *allowed == ip {
                        return true;
                    }
                }
                TargetHost::Name(name) => {
                    if name.eq_ignore_ascii_case(host) {
                        return true;
                    }
                    names.push(name);
                }
            }
        }
        for name in names {
            match lookup_host(format!("{name}:{login_port}")).await {
                Ok(mut addrs) => {
                    if addrs.any(|a| a.ip().to_canonical() == ip) {
                        return true;
                    }
                }
                Err(err) => log::debug!("--allow-target {name}: resolve failed: {err}"),
            }
        }
        false
    }
}

impl fmt::Display for TargetPolicy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TargetPolicy::Any => f.write_str("ANY (--allow-any-target)"),
            TargetPolicy::Only(list) => {
                for (i, target) in list.iter().enumerate() {
                    if i > 0 {
                        f.write_str(", ")?;
                    }
                    write!(f, "{target}")?;
                }
                Ok(())
            }
        }
    }
}

// ─── Origin ─────────────────────────────────────────────────────────────────

/// Which browser origins may open a bridge WebSocket.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OriginPolicy {
    /// `--allow-origin '*'`: every Origin.
    pub any: bool,
    /// `--allow-origin` values, normalized (trimmed, lowercase, no trailing '/').
    pub allowed: Vec<String>,
}

impl OriginPolicy {
    /// From `--allow-origin` values; `*` accepts every Origin.
    pub fn new(specs: &[String]) -> Self {
        let mut policy = Self::default();
        for spec in specs {
            let origin = normalize_origin(spec);
            if origin == "*" {
                policy.any = true;
            } else if !origin.is_empty() && !policy.allowed.contains(&origin) {
                policy.allowed.push(origin);
            }
        }
        policy
    }

    /// Every Origin.
    pub fn any() -> Self {
        Self {
            any: true,
            allowed: Vec::new(),
        }
    }

    /// Whether an upgrade with this `Origin` (and `Host`) header may proceed.
    ///
    /// Always accepted: no Origin (native clients such as holtburger-wsshim
    /// send none; a browser always does); an http(s) origin on a loopback or
    /// private-network IP (the page is on this machine or this network, whose
    /// peers can reach the bridge without a browser anyway); and an origin
    /// whose host is the request's `Host` (same host: proxy.cjs serves the page
    /// and `/wsbridge` together, under the tunnel's rotating trycloudflare host
    /// or the laptop's tailnet address). Anything else needs `--allow-origin`.
    pub fn permits(&self, origin: Option<&str>, host_header: Option<&str>) -> bool {
        let Some(origin) = origin.map(str::trim).filter(|o| !o.is_empty()) else {
            return true;
        };
        if self.any {
            return true;
        }
        if self.allowed.contains(&normalize_origin(origin)) {
            return true;
        }
        let Some(origin_host) = origin_hostname(origin) else {
            return false;
        };
        if is_local_network_host(&origin_host) {
            return true;
        }
        host_header
            .map(authority_hostname)
            .is_some_and(|host| !host.is_empty() && host == origin_host)
    }

    /// The upgrade check run in tungstenite's `accept_hdr` callback: `Ok` to
    /// proceed, else the 403 response to send.
    #[allow(clippy::result_large_err)]
    pub fn check_upgrade(&self, request: &Request) -> std::result::Result<(), ErrorResponse> {
        let headers = request.headers();
        let origin = match headers.get(header::ORIGIN) {
            None => None,
            Some(value) => match value.to_str() {
                Ok(origin) => Some(origin),
                Err(_) => return Err(forbidden("Origin header is not readable")),
            },
        };
        let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
        if self.permits(origin, host) {
            Ok(())
        } else {
            Err(forbidden(&format!(
                "Origin {} is not allowed (start the bridge with --allow-origin)",
                origin.unwrap_or_default()
            )))
        }
    }
}

impl fmt::Display for OriginPolicy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.any {
            return f.write_str("ANY");
        }
        f.write_str("none, local-network, same-host")?;
        for origin in &self.allowed {
            write!(f, ", {origin}")?;
        }
        Ok(())
    }
}

fn forbidden(message: &str) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some(message.to_string()));
    *response.status_mut() = StatusCode::FORBIDDEN;
    response
}

fn normalize_origin(origin: &str) -> String {
    origin.trim().trim_end_matches('/').to_ascii_lowercase()
}

/// The lowercase host of an `http`/`https` origin, without brackets or port;
/// `None` for any other scheme, `null`, or garbage.
fn origin_hostname(origin: &str) -> Option<String> {
    let origin = normalize_origin(origin);
    let (scheme, rest) = origin.split_once("://")?;
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let authority = rest.split('/').next().unwrap_or_default();
    let host = authority_hostname(authority);
    (!host.is_empty()).then_some(host)
}

/// The lowercase host of `host[:port]` / `[v6]:port`, without brackets or port.
fn authority_hostname(authority: &str) -> String {
    let authority = authority.trim();
    let authority = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    let host = if let Some(rest) = authority.strip_prefix('[') {
        rest.split_once(']').map_or(rest, |(host, _)| host)
    } else {
        authority.split_once(':').map_or(authority, |(host, _)| host)
    };
    host.trim_end_matches('.').to_ascii_lowercase()
}

/// `localhost` (and `*.localhost`), or an IP literal on a local network.
fn is_local_network_host(host: &str) -> bool {
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    host.parse::<IpAddr>().is_ok_and(is_local_network_ip)
}

/// Loopback, RFC 1918, 100.64.0.0/10 (shared address space; Tailscale's
/// range), link-local, or IPv6 unique-local.
pub fn is_local_network_ip(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(v4) => {
            v4.is_loopback() || v4.is_private() || v4.is_link_local() || is_shared_v4(v4)
        }
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

fn is_shared_v4(v4: Ipv4Addr) -> bool {
    let [a, b, _, _] = v4.octets();
    a == 100 && (b & 0xc0) == 64
}

// ─── Connection caps ────────────────────────────────────────────────────────

/// Live connection counts behind `--max-conns` / `--max-conns-per-ip`.
#[derive(Debug)]
pub struct ConnLimiter {
    max_total: usize,
    max_per_ip: usize,
    counts: Mutex<ConnCounts>,
}

#[derive(Debug, Default)]
struct ConnCounts {
    total: usize,
    per_ip: HashMap<IpAddr, usize>,
}

/// Why a connection was refused at accept.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapRefusal {
    Global { limit: usize },
    PerIp { ip: IpAddr, limit: usize },
}

impl fmt::Display for CapRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CapRefusal::Global { limit } => {
                write!(f, "bridge is at --max-conns {limit}")
            }
            CapRefusal::PerIp { ip, limit } => {
                write!(f, "{ip} is at --max-conns-per-ip {limit}")
            }
        }
    }
}

/// One admitted connection's place under the caps; freed on drop, so the
/// handler task releases it however it ends.
#[derive(Debug)]
pub struct ConnSlot {
    limiter: Arc<ConnLimiter>,
    per_ip: Option<IpAddr>,
}

impl ConnLimiter {
    /// `0` disables a cap.
    pub fn new(max_total: usize, max_per_ip: usize) -> Arc<Self> {
        Arc::new(Self {
            max_total,
            max_per_ip,
            counts: Mutex::new(ConnCounts::default()),
        })
    }

    fn lock(&self) -> MutexGuard<'_, ConnCounts> {
        self.counts.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Admit a connection from `peer`, or say which cap refuses it. Loopback
    /// peers count only toward the overall cap.
    pub fn try_acquire(
        self: &Arc<Self>,
        peer: IpAddr,
    ) -> std::result::Result<ConnSlot, CapRefusal> {
        let peer = peer.to_canonical();
        let mut guard = self.lock();
        let counts = &mut *guard;
        if self.max_total != 0 && counts.total >= self.max_total {
            return Err(CapRefusal::Global {
                limit: self.max_total,
            });
        }
        let per_ip = if self.max_per_ip != 0 && !peer.is_loopback() {
            if counts.per_ip.get(&peer).copied().unwrap_or(0) >= self.max_per_ip {
                return Err(CapRefusal::PerIp {
                    ip: peer,
                    limit: self.max_per_ip,
                });
            }
            Some(peer)
        } else {
            None
        };
        counts.total += 1;
        if let Some(ip) = per_ip {
            *counts.per_ip.entry(ip).or_insert(0) += 1;
        }
        drop(guard);
        Ok(ConnSlot {
            limiter: Arc::clone(self),
            per_ip,
        })
    }

    /// Connections currently admitted.
    pub fn active(&self) -> usize {
        self.lock().total
    }

    /// Connections currently counted against `ip`'s per-IP cap.
    pub fn active_for(&self, ip: IpAddr) -> usize {
        self.lock().per_ip.get(&ip.to_canonical()).copied().unwrap_or(0)
    }
}

impl Drop for ConnSlot {
    fn drop(&mut self) {
        let mut guard = self.limiter.lock();
        let counts = &mut *guard;
        counts.total = counts.total.saturating_sub(1);
        if let Some(ip) = self.per_ip {
            let left = match counts.per_ip.get_mut(&ip) {
                Some(n) => {
                    *n = n.saturating_sub(1);
                    *n
                }
                None => 0,
            };
            if left == 0 {
                counts.per_ip.remove(&ip);
            }
        }
    }
}

// ─── Frame rate ─────────────────────────────────────────────────────────────

/// Per-connection token bucket behind `--max-frames-per-sec`: `rate` frames a
/// second, bursts up to twice that.
#[derive(Clone, Debug)]
pub struct FrameBucket {
    rate: f64,
    burst: f64,
    tokens: f64,
    last: Instant,
}

impl FrameBucket {
    /// `None` when `per_sec` is 0 (no limit).
    pub fn new(per_sec: u32, now: Instant) -> Option<Self> {
        if per_sec == 0 {
            return None;
        }
        let rate = f64::from(per_sec);
        Some(Self {
            rate,
            burst: rate * 2.0,
            tokens: rate * 2.0,
            last: now,
        })
    }

    /// Take one frame's token if one is available.
    pub fn try_take(&mut self, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        if now > self.last {
            self.last = now;
        }
        self.tokens = (self.tokens + elapsed * self.rate).min(self.burst);
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    fn target(spec: &str) -> AllowedTarget {
        AllowedTarget::parse(spec).unwrap()
    }

    #[test]
    fn allow_target_parses_host_and_ports() {
        assert_eq!(
            target("localhost"),
            AllowedTarget {
                host: TargetHost::Loopback,
                login_port: 9000,
                world_port: 9001
            }
        );
        assert_eq!(
            target("10.0.0.5:9100"),
            AllowedTarget {
                host: TargetHost::Ip(ip("10.0.0.5")),
                login_port: 9100,
                world_port: 9101
            }
        );
        assert_eq!(
            target("Play.Coldeve.AC.:9000:9005"),
            AllowedTarget {
                host: TargetHost::Name("play.coldeve.ac".into()),
                login_port: 9000,
                world_port: 9005
            }
        );
        assert_eq!(target("::1").host, TargetHost::Ip(ip("::1")));
        assert_eq!(
            target("[::1]:9000:9001"),
            AllowedTarget {
                host: TargetHost::Ip(ip("::1")),
                login_port: 9000,
                world_port: 9001
            }
        );
        // An IPv4-mapped literal is stored as the IPv4 address.
        assert_eq!(target("[::ffff:127.0.0.1]").host, TargetHost::Ip(ip("127.0.0.1")));
    }

    #[test]
    fn allow_target_rejects_bad_specs() {
        for bad in [
            "",
            ":9000",
            "host:notaport",
            "host:9000:x",
            "host:0",
            "host:9000:9000",
            "host:65535",
            "host:9000:9001:9002",
            "[::1",
            "[::1]9000",
        ] {
            assert!(AllowedTarget::parse(bad).is_err(), "{bad:?} should not parse");
        }
    }

    #[test]
    fn allow_target_display_round_trips() {
        for spec in [
            "localhost:9000:9001",
            "10.0.0.5:9100:9101",
            "[::1]:9000:9001",
            "play.coldeve.ac:9000:9001",
        ] {
            assert_eq!(target(spec).to_string(), spec);
            assert_eq!(target(&target(spec).to_string()), target(spec));
        }
    }

    #[test]
    fn default_targets_are_loopback_and_coldeve_on_ace_ports() {
        let TargetPolicy::Only(list) = TargetPolicy::defaults() else {
            panic!("defaults must be a list");
        };
        assert_eq!(list, vec![target("localhost:9000:9001"), target("play.coldeve.ac:9000:9001")]);
    }

    #[tokio::test]
    async fn default_targets_admit_local_ace_only_on_its_ports() {
        let policy = TargetPolicy::defaults();
        for (host, addr) in [
            ("127.0.0.1", "127.0.0.1"),
            ("localhost", "127.0.0.1"),
            ("::1", "::1"),
            ("localhost", "::1"),
        ] {
            assert!(policy.permits(host, ip(addr), 9000, 9001).await, "{host} → {addr}");
        }
        // Any loopback address counts as local, and so does its IPv4-mapped form.
        assert!(policy.permits("127.0.1.1", ip("127.0.1.1"), 9000, 9001).await);
        let mapped = ip("::ffff:127.0.0.1");
        assert!(policy.permits("::ffff:127.0.0.1", mapped, 9000, 9001).await);
        // Wrong ports to the local ACE.
        assert!(!policy.permits_ports(9000, 9002));
        assert!(!policy.permits_ports(22, 23));
        assert!(!policy.permits("127.0.0.1", ip("127.0.0.1"), 53, 54).await);
        // Any other host (TEST-NET-1; play.coldeve.ac never resolves there).
        assert!(!policy.permits("192.0.2.7", ip("192.0.2.7"), 9000, 9001).await);
        // The coldeve entry admits a handshake that named it, at its resolved IP.
        let coldeve = ip("51.79.80.150");
        assert!(policy.permits("play.coldeve.ac", coldeve, 9000, 9001).await);
        assert!(policy.permits("PLAY.coldeve.ac.", coldeve, 9000, 9001).await);
        assert!(!policy.permits("play.coldeve.ac", coldeve, 9000, 9002).await);
    }

    #[tokio::test]
    async fn explicit_targets_match_resolved_ip_and_both_ports() {
        let policy = TargetPolicy::Only(vec![target("10.1.2.3:9100:9101")]);
        assert!(policy.permits_ports(9100, 9101));
        assert!(policy.permits("10.1.2.3", ip("10.1.2.3"), 9100, 9101).await);
        // A name the client used that resolved to the allowed IP.
        assert!(policy.permits("ace.lan", ip("10.1.2.3"), 9100, 9101).await);
        assert!(!policy.permits("10.1.2.4", ip("10.1.2.4"), 9100, 9101).await);
        assert!(!policy.permits("10.1.2.3", ip("10.1.2.3"), 9100, 9102).await);
        assert!(!policy.permits("127.0.0.1", ip("127.0.0.1"), 9100, 9101).await);
        // A name entry that does not resolve admits nothing but its own name.
        let named = TargetPolicy::Only(vec![target("allowed.invalid:9000:9001")]);
        assert!(!named.permits("127.0.0.1", ip("127.0.0.1"), 9000, 9001).await);
        assert!(named.permits("allowed.invalid", ip("203.0.113.9"), 9000, 9001).await);
        // --allow-any-target.
        assert!(TargetPolicy::Any.permits_ports(1, 2));
        assert!(TargetPolicy::Any.permits("8.8.8.8", ip("8.8.8.8"), 53, 54).await);
    }

    #[test]
    fn origin_policy_defaults() {
        let policy = OriginPolicy::default();
        // No Origin: native clients (holtburger-wsshim, tungstenite, node `ws`).
        assert!(policy.permits(None, Some("127.0.0.1:8080")));
        assert!(policy.permits(Some(""), Some("127.0.0.1:8080")));
        // serve.py page → bridge on another loopback port; localhost vs 127.0.0.1.
        assert!(policy.permits(Some("http://127.0.0.1:8765"), Some("127.0.0.1:8080")));
        assert!(policy.permits(Some("http://localhost:8765"), Some("127.0.0.1:8080")));
        assert!(policy.permits(Some("http://[::1]:8765"), Some("127.0.0.1:8080")));
        assert!(policy.permits(Some("http://app.localhost:8765"), Some("127.0.0.1:8080")));
        // Pages on this LAN / tailnet.
        assert!(policy.permits(Some("http://100.116.47.66:8765"), Some("127.0.0.1:8080")));
        assert!(policy.permits(Some("http://192.168.1.20:8765"), Some("127.0.0.1:8080")));
        // Same host: proxy.cjs behind the cloudflared tunnel (Host passes through).
        assert!(policy.permits(
            Some("https://determine-aurora-dental-tactics.trycloudflare.com"),
            Some("determine-aurora-dental-tactics.trycloudflare.com")
        ));
        assert!(policy.permits(Some("https://Game.Example.org"), Some("game.example.org:8080")));
        // Anything else.
        assert!(!policy.permits(Some("https://evil.example"), Some("127.0.0.1:8080")));
        assert!(!policy.permits(Some("https://evil.example"), None));
        assert!(!policy.permits(Some("https://evil.example"), Some("other.example")));
        assert!(!policy.permits(Some("null"), Some("127.0.0.1:8080")));
        assert!(!policy.permits(Some("file://"), Some("127.0.0.1:8080")));
        assert!(!policy.permits(Some("chrome-extension://abc"), Some("abc")));
        assert!(!policy.permits(Some("http://8.8.8.8"), Some("127.0.0.1:8080")));
        // A loopback-looking label inside a public name is not loopback.
        assert!(!policy.permits(Some("http://127.0.0.1.evil.example"), Some("127.0.0.1:8080")));
        assert!(!policy.permits(Some("http://localhost.evil.example"), Some("127.0.0.1:8080")));
    }

    #[test]
    fn origin_policy_allow_list_and_wildcard() {
        let policy = OriginPolicy::new(&["https://Play.Example.org/".to_string()]);
        assert!(!policy.any);
        assert_eq!(policy.allowed, vec!["https://play.example.org".to_string()]);
        assert!(policy.permits(Some("https://play.example.org"), Some("bridge.example.net")));
        assert!(!policy.permits(Some("http://play.example.org"), Some("bridge.example.net")));
        assert!(!policy.permits(Some("https://evil.example"), Some("bridge.example.net")));

        let any = OriginPolicy::new(&["*".to_string()]);
        assert!(any.any);
        assert!(any.permits(Some("https://evil.example"), None));
        assert!(any.permits(Some("null"), None));
    }

    #[test]
    fn local_network_ip_ranges() {
        for local in [
            "127.0.0.1",
            "127.8.9.10",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.0.1",
            "169.254.1.1",
            "100.64.0.1",
            "100.127.215.75",
            "::1",
            "fd7a:115c:a1e0::1",
            "fe80::1",
            "::ffff:192.168.0.1",
        ] {
            assert!(is_local_network_ip(ip(local)), "{local}");
        }
        for public in [
            "8.8.8.8",
            "51.79.80.150",
            "100.128.0.1",
            "100.63.255.255",
            "172.32.0.1",
            "2001:4860:4860::8888",
        ] {
            assert!(!is_local_network_ip(ip(public)), "{public}");
        }
    }

    #[test]
    fn check_upgrade_reads_origin_and_host_headers() {
        let request = |origin: Option<&str>, host: &str| {
            let mut builder = Request::builder().uri("/").header(header::HOST, host);
            if let Some(origin) = origin {
                builder = builder.header(header::ORIGIN, origin);
            }
            builder.body(()).unwrap()
        };
        let policy = OriginPolicy::default();
        assert!(policy.check_upgrade(&request(None, "127.0.0.1:8080")).is_ok());
        let local_page = request(Some("http://127.0.0.1:8765"), "127.0.0.1:8080");
        assert!(policy.check_upgrade(&local_page).is_ok());
        assert!(policy.check_upgrade(&request(Some("https://t.example"), "t.example")).is_ok());
        let refused = policy
            .check_upgrade(&request(Some("https://evil.example"), "127.0.0.1:8080"))
            .unwrap_err();
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        assert!(refused.body().as_deref().unwrap_or_default().contains("https://evil.example"));
    }

    #[test]
    fn conn_limiter_global_cap_frees_on_drop() {
        let limiter = ConnLimiter::new(2, 0);
        let a = limiter.try_acquire(ip("127.0.0.1")).unwrap();
        let _b = limiter.try_acquire(ip("10.0.0.9")).unwrap();
        assert_eq!(limiter.active(), 2);
        assert_eq!(
            limiter.try_acquire(ip("10.0.0.10")).unwrap_err(),
            CapRefusal::Global { limit: 2 }
        );
        drop(a);
        assert_eq!(limiter.active(), 1);
        let _c = limiter.try_acquire(ip("10.0.0.10")).unwrap();
        assert_eq!(limiter.active(), 2);
    }

    #[test]
    fn conn_limiter_per_ip_cap_exempts_loopback() {
        let limiter = ConnLimiter::new(0, 2);
        let peer = ip("100.127.215.75");
        let a = limiter.try_acquire(peer).unwrap();
        let _b = limiter.try_acquire(peer).unwrap();
        assert_eq!(limiter.active_for(peer), 2);
        assert_eq!(
            limiter.try_acquire(peer).unwrap_err(),
            CapRefusal::PerIp { ip: peer, limit: 2 }
        );
        // Another address is unaffected.
        let _other = limiter.try_acquire(ip("192.168.1.4")).unwrap();
        // The IPv4-mapped form of the same peer is the same peer.
        assert!(limiter.try_acquire(ip("::ffff:100.127.215.75")).is_err());
        drop(a);
        assert_eq!(limiter.active_for(peer), 1);
        let _c = limiter.try_acquire(peer).unwrap();
        // Loopback peers (proxy.cjs, tunnels, local agents) skip the per-IP cap.
        let local: Vec<_> = (0..10)
            .map(|_| limiter.try_acquire(ip("127.0.0.1")).unwrap())
            .collect();
        assert_eq!(limiter.active_for(ip("127.0.0.1")), 0);
        // _b, _other and _c, plus the loopback ten.
        assert_eq!(limiter.active(), 3 + local.len());
        drop(local);
        assert_eq!(limiter.active(), 3);
    }

    #[test]
    fn conn_limiter_zero_means_unlimited() {
        let limiter = ConnLimiter::new(0, 0);
        let slots: Vec<_> = (0..300)
            .map(|_| limiter.try_acquire(ip("10.0.0.1")).unwrap())
            .collect();
        assert_eq!(limiter.active(), 300);
        assert_eq!(limiter.active_for(ip("10.0.0.1")), 0);
        drop(slots);
        assert_eq!(limiter.active(), 0);
    }

    #[test]
    fn frame_bucket_limits_rate_with_double_burst() {
        assert!(FrameBucket::new(0, Instant::now()).is_none());
        let t0 = Instant::now();
        let mut bucket = FrameBucket::new(10, t0).unwrap();
        // Burst: twice the rate, all at once.
        for i in 0..20 {
            assert!(bucket.try_take(t0), "burst frame {i}");
        }
        assert!(!bucket.try_take(t0));
        // 150 ms refills 1.5 frames at 10/s: one whole frame.
        let t1 = t0 + Duration::from_millis(150);
        assert!(bucket.try_take(t1));
        assert!(!bucket.try_take(t1));
        // A long idle refills only up to the burst.
        let t2 = t1 + Duration::from_secs(60);
        for i in 0..20 {
            assert!(bucket.try_take(t2), "refilled frame {i}");
        }
        assert!(!bucket.try_take(t2));
        // A clock that steps back neither refills nor panics.
        assert!(!bucket.try_take(t0));
    }

    #[test]
    fn admission_display_summarizes_policy() {
        let text = Admission::default().to_string();
        assert!(text.contains("localhost:9000:9001"), "{text}");
        assert!(text.contains("play.coldeve.ac:9000:9001"), "{text}");
        assert!(text.contains("max conns 256 (16 per non-loopback IP)"), "{text}");
        assert!(!text.contains("frames/s"), "{text}");
        let open = Admission::unrestricted().to_string();
        assert!(open.contains("ANY (--allow-any-target)"), "{open}");
        assert!(open.contains("unlimited"), "{open}");
    }
}
