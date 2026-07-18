//! WebSocket listener and per-connection forwarder.
//!
//! Each connection negotiates its destination via a one-time JSON
//! handshake (see `handshake.rs`) — the client announces which ACE
//! host + login/world ports it wants to talk to, the bridge resolves
//! the hostname, replies with the resolved IP, and only then enters
//! binary forwarding mode. The binary frame format itself
//! (`[port:u16][payload]`, see `frame.rs`) is unchanged.

use crate::config::Config;
use crate::frame;
use crate::handshake::{ClientHello, ServerHello, HANDSHAKE_VERSION};
use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::{lookup_host, TcpListener, TcpStream, UdpSocket};
use tokio_tungstenite::tungstenite::Message;

// conn-fix (2026-07-18): liveness limits. A WS connection whose ACE
// peer has gone silent (session booted by a duplicate login, server
// restart) used to live forever: ACE removes booted sessions from its
// map and silently DROPS their packets, so neither side ever errors,
// and the zombie flow retransmits into ACE at 1 Hz indefinitely
// ("Session for Id 0 has IP … but packet has IP …" log flood).
// The bridge is the only party that can reap these.
/// Tear down when the client has sent to ACE but nothing has come
/// back for this long (ACE's own session timeout is 60 s).
const ACE_SILENCE_TIMEOUT: Duration = Duration::from_secs(90);
/// Tear down when the browser has sent no WS frames at all for this
/// long (covers pages parked on the login form holding a socket).
const WS_IDLE_TIMEOUT: Duration = Duration::from_secs(300);
/// Bound on a single ws_sink.send — a stalled browser reader
/// otherwise blocks the udp→ws pump forever (kernel then drops
/// ACE→client datagrams with no signal).
const WS_SEND_TIMEOUT: Duration = Duration::from_secs(15);

/// Shared per-connection liveness clock (millis since the connection's
/// own epoch; 0 = never happened).
struct LinkState {
    epoch: Instant,
    /// Last datagram accepted from ACE; seeded to "now" on the FIRST
    /// ws→udp send so a never-answered flow also trips the reaper.
    last_udp_in_ms: AtomicU64,
    /// Last WS frame (any kind) received from the browser.
    last_ws_in_ms: AtomicU64,
}

impl LinkState {
    fn new() -> Self {
        let s = Self {
            epoch: Instant::now(),
            last_udp_in_ms: AtomicU64::new(0),
            last_ws_in_ms: AtomicU64::new(0),
        };
        s.last_ws_in_ms.store(1, Ordering::Relaxed);
        s
    }
    fn now_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis().max(1) as u64
    }
    fn stamp(&self, cell: &AtomicU64) {
        cell.store(self.now_ms(), Ordering::Relaxed);
    }
    fn seed_if_zero(&self, cell: &AtomicU64) {
        let _ = cell.compare_exchange(0, self.now_ms(), Ordering::Relaxed, Ordering::Relaxed);
    }
    fn age(&self, cell: &AtomicU64) -> Option<Duration> {
        let v = cell.load(Ordering::Relaxed);
        if v == 0 {
            return None;
        }
        Some(Duration::from_millis(self.now_ms().saturating_sub(v)))
    }
}

/// Watchdog arm: polls the liveness clocks and errors out (tearing
/// down the connection and its UDP socket) when a limit trips.
async fn liveness_watchdog(state: Arc<LinkState>, peer: SocketAddr) -> Result<()> {
    let mut tick = tokio::time::interval(Duration::from_secs(10));
    loop {
        tick.tick().await;
        if let Some(age) = state.age(&state.last_udp_in_ms) {
            if age > ACE_SILENCE_TIMEOUT {
                return Err(anyhow!(
                    "[{peer}] reaping: nothing from ACE for {age:?} (session presumed dead server-side)"
                ));
            }
        }
        if let Some(age) = state.age(&state.last_ws_in_ms) {
            if age > WS_IDLE_TIMEOUT {
                return Err(anyhow!(
                    "[{peer}] reaping: no WS frames from client for {age:?}"
                ));
            }
        }
    }
}

/// Resolved per-connection routing target announced by the client
/// in its handshake.
#[derive(Clone, Debug)]
pub struct ConnTarget {
    pub host: String,
    pub ip: IpAddr,
    pub login_port: u16,
    pub world_port: u16,
}

impl ConnTarget {
    pub fn is_ace_port(&self, port: u16) -> bool {
        port == self.login_port || port == self.world_port
    }
}

/// Bind the WS listen socket and accept connections forever.
pub async fn run(cfg: Config) -> Result<()> {
    let listener = TcpListener::bind(cfg.listen)
        .await
        .with_context(|| format!("bind {}", cfg.listen))?;
    accept_loop(cfg, listener).await
}

pub async fn accept_loop(cfg: Config, listener: TcpListener) -> Result<()> {
    log::info!(
        "listening on ws://{}  (per-connection routing; default world-port offset = {:+})",
        listener.local_addr()?,
        cfg.default_world_port_offset,
    );

    let cfg = Arc::new(cfg);
    loop {
        let (tcp, peer) = match listener.accept().await {
            Ok(pair) => pair,
            Err(err) => {
                log::warn!("accept failed: {err}");
                continue;
            }
        };
        let cfg = Arc::clone(&cfg);
        tokio::spawn(async move {
            if let Err(err) = handle_connection(cfg, tcp, peer).await {
                log::info!("[{peer}] connection ended: {err:#}");
            } else {
                log::info!("[{peer}] connection closed");
            }
        });
    }
}

async fn handle_connection(cfg: Arc<Config>, tcp: TcpStream, peer: SocketAddr) -> Result<()> {
    log::info!("[{peer}] accepted; upgrading to ws");
    let ws = tokio_tungstenite::accept_async(tcp)
        .await
        .with_context(|| format!("[{peer}] websocket handshake"))?;

    let (mut ws_sink, mut ws_stream) = ws.split();

    let target = match read_handshake(&cfg, &mut ws_stream).await {
        Ok(t) => t,
        Err(e) => {
            let reply = ServerHello::err(format!("{e:#}"));
            let _ = ws_sink
                .send(Message::Text(serde_json::to_string(&reply)?.into()))
                .await;
            let _ = ws_sink.send(Message::Close(None)).await;
            return Err(e);
        }
    };

    let reply = ServerHello::ok(target.ip, target.login_port, target.world_port);
    ws_sink
        .send(Message::Text(serde_json::to_string(&reply)?.into()))
        .await
        .with_context(|| format!("[{peer}] send handshake reply"))?;

    log::info!(
        "[{peer}] routing to {} ({}:{} login, :{} world)",
        target.host,
        target.ip,
        target.login_port,
        target.world_port,
    );

    let udp = UdpSocket::bind("0.0.0.0:0")
        .await
        .with_context(|| format!("[{peer}] bind ephemeral udp socket"))?;
    let local = udp.local_addr().ok();
    log::info!("[{peer}] udp socket bound to {local:?}");
    let udp = Arc::new(udp);
    let target = Arc::new(target);
    let link = Arc::new(LinkState::new());

    let to_udp = forward_ws_to_udp(
        Arc::clone(&target),
        Arc::clone(&udp),
        ws_stream,
        peer,
        Arc::clone(&link),
    );
    let to_ws = forward_udp_to_ws(Arc::clone(&target), udp, ws_sink, peer, Arc::clone(&link));
    let watchdog = liveness_watchdog(Arc::clone(&link), peer);

    tokio::select! {
        res = to_udp => {
            log::debug!("[{peer}] ws→udp half exited: {res:?}");
            res
        }
        res = to_ws => {
            log::debug!("[{peer}] udp→ws half exited: {res:?}");
            res
        }
        res = watchdog => {
            log::debug!("[{peer}] liveness watchdog exited: {res:?}");
            res
        }
    }
}

async fn read_handshake<S>(cfg: &Config, ws_stream: &mut S) -> Result<ConnTarget>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let msg = ws_stream
        .next()
        .await
        .ok_or_else(|| anyhow!("ws closed before handshake"))?
        .context("ws read during handshake")?;

    let text = match msg {
        Message::Text(t) => t,
        Message::Binary(_) => {
            return Err(anyhow!(
                "first ws frame must be a text JSON handshake, got binary"
            ));
        }
        other => return Err(anyhow!("unexpected ws frame during handshake: {other:?}")),
    };

    let hello: ClientHello =
        serde_json::from_str(&text).context("parse handshake JSON")?;

    if hello.v != HANDSHAKE_VERSION {
        return Err(anyhow!(
            "unsupported handshake version {} (server speaks v{})",
            hello.v,
            HANDSHAKE_VERSION,
        ));
    }
    if hello.host.is_empty() {
        return Err(anyhow!("handshake host is empty"));
    }
    if hello.login_port == 0 {
        return Err(anyhow!("handshake login_port must be non-zero"));
    }
    let world_port = match hello.world_port {
        Some(p) if p == hello.login_port => {
            return Err(anyhow!(
                "handshake login_port and world_port must differ (got {} for both)",
                p
            ));
        }
        Some(p) => p,
        None => {
            let derived = i32::from(hello.login_port) + cfg.default_world_port_offset;
            if !(1..=u16::MAX as i32).contains(&derived) {
                return Err(anyhow!(
                    "derived world_port {} from login_port {} + offset {} is out of range",
                    derived,
                    hello.login_port,
                    cfg.default_world_port_offset
                ));
            }
            derived as u16
        }
    };

    let ip = resolve_host(&hello.host, hello.login_port).await?;

    Ok(ConnTarget {
        host: hello.host,
        ip,
        login_port: hello.login_port,
        world_port,
    })
}

async fn resolve_host(host: &str, port: u16) -> Result<IpAddr> {
    let resolved: Vec<_> = lookup_host(format!("{host}:{port}"))
        .await
        .with_context(|| format!("resolve host {host}"))?
        .collect();
    if resolved.is_empty() {
        return Err(anyhow!("DNS returned no addresses for {host}"));
    }
    let ip = resolved
        .iter()
        .find(|s| s.is_ipv4())
        .map(|s| s.ip())
        .unwrap_or_else(|| resolved[0].ip());
    Ok(ip)
}

async fn forward_ws_to_udp<S>(
    target: Arc<ConnTarget>,
    udp: Arc<UdpSocket>,
    mut ws_stream: S,
    peer: SocketAddr,
    link: Arc<LinkState>,
) -> Result<()>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    while let Some(msg) = ws_stream.next().await {
        let msg = msg.with_context(|| format!("[{peer}] ws read"))?;
        link.stamp(&link.last_ws_in_ms);
        match msg {
            Message::Binary(bytes) => {
                let (port, payload) = frame::decode_frame(&bytes)
                    .with_context(|| format!("[{peer}] decode ws frame"))?;
                if !target.is_ace_port(port) {
                    return Err(anyhow!(
                        "[{peer}] ws frame destination port {port} not on allowlist \
                         (login={}, world={})",
                        target.login_port,
                        target.world_port
                    ));
                }
                let dst = SocketAddr::new(target.ip, port);
                // Seed the ACE-silence clock on the first outbound send
                // so a flow ACE never answers still trips the reaper.
                link.seed_if_zero(&link.last_udp_in_ms);
                let sent = udp
                    .send_to(payload, dst)
                    .await
                    .with_context(|| format!("[{peer}] udp send_to {dst}"))?;
                if sent != payload.len() {
                    return Err(anyhow!(
                        "[{peer}] short udp write to {dst}: {sent}/{} bytes",
                        payload.len()
                    ));
                }
                log::trace!("[{peer}] ws→udp {} bytes → {dst}", payload.len());
            }
            Message::Close(_) => {
                log::debug!("[{peer}] received ws close");
                return Ok(());
            }
            Message::Ping(_) | Message::Pong(_) => {}
            Message::Text(_) | Message::Frame(_) => {
                return Err(anyhow!(
                    "[{peer}] post-handshake non-binary ws frame is not part of the protocol"
                ));
            }
        }
    }
    Ok(())
}

async fn forward_udp_to_ws<S>(
    target: Arc<ConnTarget>,
    udp: Arc<UdpSocket>,
    mut ws_sink: S,
    peer: SocketAddr,
    link: Arc<LinkState>,
) -> Result<()>
where
    S: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let mut buf = vec![0u8; frame::MAX_PACKET_BYTES + frame::PORT_PREFIX_LEN];
    loop {
        let (len, src) = udp
            .recv_from(&mut buf)
            .await
            .with_context(|| format!("[{peer}] udp recv_from"))?;

        if src.ip() != target.ip {
            log::warn!(
                "[{peer}] dropping datagram from unexpected source ip {}: expected {}",
                src.ip(),
                target.ip
            );
            continue;
        }
        if !target.is_ace_port(src.port()) {
            log::warn!(
                "[{peer}] dropping datagram from {src}: source port not on allowlist \
                 (login={}, world={})",
                target.login_port,
                target.world_port
            );
            continue;
        }

        // Datagram accepted from ACE — the flow is alive.
        link.stamp(&link.last_udp_in_ms);

        let payload = &buf[..len];
        let frame = frame::encode_frame(src.port(), payload)
            .with_context(|| format!("[{peer}] encode ws frame from {src}"))?;
        // conn-fix (2026-07-18): bound the send. A stalled browser
        // reader used to park this pump on a full TCP window forever,
        // silently dropping ACE→client datagrams in the kernel.
        tokio::time::timeout(WS_SEND_TIMEOUT, ws_sink.send(Message::Binary(frame.into())))
            .await
            .map_err(|_| anyhow!("[{peer}] ws send stalled for {WS_SEND_TIMEOUT:?} — client reader wedged"))?
            .with_context(|| format!("[{peer}] ws send"))?;
        log::trace!("[{peer}] udp→ws {len} bytes ← {src}");
    }
}
