//! WebSocket listener and per-connection forwarder.
//!
//! Each connection negotiates its destination via a one-time JSON
//! handshake (see `handshake.rs`) — the client announces which ACE
//! host + login/world ports it wants to talk to, the bridge resolves
//! the hostname, replies with the resolved IP, and only then enters
//! binary forwarding mode. The binary frame format itself
//! (`[port:u16][payload]`, see `frame.rs`) is unchanged.
//!
//! When a connection ends, however it ends, the bridge sends ACE a
//! Disconnect for the session it carried (see `disconnect.rs`).
//!
//! Admission (connection caps, Origin, the target allowlist) is in
//! `admission.rs`; the binary runs [`run_admitted`] with the policy its
//! flags describe.

use crate::admission::{
    Admission, ConnLimiter, FrameBucket, HANDSHAKE_TIMEOUT, MAX_WS_MESSAGE_BYTES, TargetPolicy,
};
use crate::capture::{Direction, PcapCapture};
use crate::config::Config;
use crate::disconnect::{self, SessionIdSlot};
use crate::frame;
use crate::handshake::{ClientHello, ServerHello, HANDSHAKE_VERSION};
use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::{lookup_host, TcpListener, TcpStream, UdpSocket};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
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
/// net-3 (R2-net 2026-10-08): SO_RCVBUF for the per-connection ACE-facing
/// UDP socket; same value as holtburger-session's native `Session::new`.
const UDP_RECV_BUFFER_SIZE_BYTES: usize = 2 * 1024 * 1024;

/// Shared per-connection liveness clock (millis since the connection's
/// own epoch; 0 = never happened).
struct LinkState {
    epoch: Instant,
    /// Last datagram accepted from ACE; seeded to "now" on the FIRST
    /// ws→udp send so a never-answered flow also trips the reaper.
    last_udp_in_ms: AtomicU64,
    /// Last WS frame (any kind) received from the browser.
    last_ws_in_ms: AtomicU64,
    /// net-transport-2: the ACE session id from the last S2C
    /// ConnectRequest, for the Disconnect sent at teardown.
    session: SessionIdSlot,
}

impl LinkState {
    fn new() -> Self {
        let s = Self {
            epoch: Instant::now(),
            last_udp_in_ms: AtomicU64::new(0),
            last_ws_in_ms: AtomicU64::new(0),
            session: SessionIdSlot::new(),
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

/// test-tooling-4: where a connection's relayed datagrams are recorded. The
/// client side of every record is the connection's own UDP socket — the
/// address ACE sees.
#[derive(Clone)]
struct CaptureTap {
    capture: Arc<PcapCapture>,
    local: SocketAddr,
}

/// Bind the WS listen socket and accept connections forever, under the
/// default admission policy ([`Admission::default`]).
pub async fn run(cfg: Config) -> Result<()> {
    run_with_capture(cfg, None).await
}

/// [`run`], recording every relayed datagram to `capture` when it is `Some`
/// (opt-in `--capture` / `HB_BRIDGE_CAPTURE`, see `capture.rs`). `None`
/// relays exactly as [`run`].
pub async fn run_with_capture(cfg: Config, capture: Option<Arc<PcapCapture>>) -> Result<()> {
    run_admitted(cfg, Admission::default(), capture).await
}

/// [`run_with_capture`] under an explicit admission policy (the binary's
/// `--allow-*` / `--max-*` flags, see `admission.rs`).
pub async fn run_admitted(
    cfg: Config,
    admission: Admission,
    capture: Option<Arc<PcapCapture>>,
) -> Result<()> {
    let listener = TcpListener::bind(cfg.listen)
        .await
        .with_context(|| format!("bind {}", cfg.listen))?;
    accept_loop_admitted(cfg, admission, listener, capture).await
}

/// Test seam: accept on a pre-bound listener with NO admission control
/// ([`Admission::unrestricted`]: any Origin, any target, no caps).
pub async fn accept_loop(cfg: Config, listener: TcpListener) -> Result<()> {
    accept_loop_with_capture(cfg, listener, None).await
}

/// [`accept_loop`] with an optional capture shared by every connection.
pub async fn accept_loop_with_capture(
    cfg: Config,
    listener: TcpListener,
    capture: Option<Arc<PcapCapture>>,
) -> Result<()> {
    accept_loop_admitted(cfg, Admission::unrestricted(), listener, capture).await
}

/// Accept connections forever under `admission`, recording to `capture`
/// when it is `Some`.
pub async fn accept_loop_admitted(
    cfg: Config,
    admission: Admission,
    listener: TcpListener,
    capture: Option<Arc<PcapCapture>>,
) -> Result<()> {
    log::info!(
        "listening on ws://{}  (per-connection routing; default world-port offset = {:+})",
        listener.local_addr()?,
        cfg.default_world_port_offset,
    );
    log::info!("admission: {admission}");
    if let Some(capture) = &capture {
        log::info!(
            "capturing every relayed datagram to {} (pcap, LINKTYPE_RAW)",
            capture.path().display()
        );
    }

    let cfg = Arc::new(cfg);
    // net-transport-5: --max-conns / --max-conns-per-ip, checked before the
    // upgrade so a flood of sockets costs one accept each, not a task.
    let limiter = ConnLimiter::new(admission.max_conns, admission.max_conns_per_ip);
    let admission = Arc::new(admission);
    let mut refused_since_report: u64 = 0;
    let mut last_refusal_report: Option<Instant> = None;
    loop {
        let (tcp, peer) = match listener.accept().await {
            Ok(pair) => pair,
            Err(err) => {
                log::warn!("accept failed: {err}");
                continue;
            }
        };
        let slot = match limiter.try_acquire(peer.ip()) {
            Ok(slot) => slot,
            Err(refusal) => {
                // At most one line a second, however hard the flood.
                refused_since_report += 1;
                if last_refusal_report.is_none_or(|t| t.elapsed() >= Duration::from_secs(1)) {
                    log::warn!(
                        "[{peer}] refused: {refusal} ({refused_since_report} since the last report)"
                    );
                    refused_since_report = 0;
                    last_refusal_report = Some(Instant::now());
                }
                drop(tcp);
                continue;
            }
        };
        let cfg = Arc::clone(&cfg);
        let admission = Arc::clone(&admission);
        let capture = capture.clone();
        tokio::spawn(async move {
            // Held for the handler's whole life, however it ends.
            let _slot = slot;
            if let Err(err) = handle_connection(cfg, admission, tcp, peer, capture).await {
                log::info!("[{peer}] connection ended: {err:#}");
            } else {
                log::info!("[{peer}] connection closed");
            }
        });
    }
}

/// net-transport-5: the WebSocket limits for every connection — one message
/// or frame is one AC packet or the JSON hello (see [`MAX_WS_MESSAGE_BYTES`]).
#[allow(clippy::field_reassign_with_default)]
fn ws_config() -> WebSocketConfig {
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(MAX_WS_MESSAGE_BYTES);
    config.max_frame_size = Some(MAX_WS_MESSAGE_BYTES);
    config
}

async fn handle_connection(
    cfg: Arc<Config>,
    admission: Arc<Admission>,
    tcp: TcpStream,
    peer: SocketAddr,
    capture: Option<Arc<PcapCapture>>,
) -> Result<()> {
    log::info!("[{peer}] accepted; upgrading to ws");
    // latency (2026-10-05): TCP_NODELAY. Each WS frame carries one small AC
    // datagram; with Nagle on, a frame written while its predecessor is
    // still unacked waits for that ACK — up to the peer's delayed-ACK timer
    // (40 ms Linux / 200 ms Windows) — on every ACE burst (a reply is
    // routinely several back-to-back datagrams). Browsers already set
    // NODELAY on their side; the bridge was the one Nagle hop. Best-effort.
    if let Err(err) = tcp.set_nodelay(true) {
        log::warn!("[{peer}] set_nodelay failed (continuing with Nagle): {err}");
    }
    // net-transport-5: the Origin check runs on the upgrade request (403 on
    // a miss), and the upgrade is bounded so a socket that never upgrades
    // cannot hold a connection slot.
    let origins = &admission.origins;
    let origin_gate = move |request: &Request, response: Response| {
        match origins.check_upgrade(request) {
            Ok(()) => Ok::<Response, ErrorResponse>(response),
            Err(refusal) => {
                log::warn!(
                    "[{peer}] refused websocket upgrade: {}",
                    refusal.body().as_deref().unwrap_or("forbidden")
                );
                Err(refusal)
            }
        }
    };
    let ws = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        tokio_tungstenite::accept_hdr_async_with_config(tcp, origin_gate, Some(ws_config())),
    )
    .await
    .map_err(|_| anyhow!("[{peer}] websocket upgrade timed out after {HANDSHAKE_TIMEOUT:?}"))?
    .with_context(|| format!("[{peer}] websocket handshake"))?;

    let (mut ws_sink, mut ws_stream) = ws.split();

    let handshake = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        read_handshake(&cfg, &admission.targets, &mut ws_stream),
    )
    .await
    .unwrap_or_else(|_| Err(anyhow!("no handshake within {HANDSHAKE_TIMEOUT:?}")));
    let target = match handshake {
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
    // net-3 (R2-net 2026-10-08): while the udp→ws pump is parked on a slow
    // browser reader, ACE's datagrams queue in this socket's kernel buffer
    // and the overflow is dropped silently (see WS_SEND_TIMEOUT). The default
    // buffer is small; a burst of lost S2C packets beyond the client's ISAAC
    // search reach kills the session. Mirror holtburger-session's native
    // `Session::new` (2 MiB). Linux clamps this to net.core.rmem_max unless
    // the host raises it, so failure (or a clamp) is logged, never fatal.
    if let Err(err) = socket2::SockRef::from(&udp).set_recv_buffer_size(UDP_RECV_BUFFER_SIZE_BYTES)
    {
        log::warn!(
            "[{peer}] failed to set udp receive buffer to {UDP_RECV_BUFFER_SIZE_BYTES} bytes: {err}"
        );
    }
    let local = udp.local_addr().ok();
    log::info!("[{peer}] udp socket bound to {local:?}");
    let tap = capture.map(|capture| CaptureTap {
        capture,
        local: local.unwrap_or_else(|| SocketAddr::from(([0, 0, 0, 0], 0))),
    });
    let udp = Arc::new(udp);
    let target = Arc::new(target);
    let link = Arc::new(LinkState::new());
    // net-transport-2: kept past the pumps for the teardown Disconnect.
    let bye_udp = Arc::clone(&udp);
    let bye_tap = tap.clone();

    let to_udp = forward_ws_to_udp(
        Arc::clone(&target),
        Arc::clone(&udp),
        ws_stream,
        peer,
        Arc::clone(&link),
        tap.clone(),
        admission.max_frames_per_sec,
    );
    let to_ws = forward_udp_to_ws(
        Arc::clone(&target),
        udp,
        ws_sink,
        peer,
        Arc::clone(&link),
        tap,
    );
    let watchdog = liveness_watchdog(Arc::clone(&link), peer);

    let res = tokio::select! {
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
    };
    end_ace_session(&bye_udp, &target, &link, peer, bye_tap.as_ref()).await;
    res
}

/// net-transport-2 (2026-10-13): after a connection ends, whichever half or
/// the watchdog ended it, send ACE one cleartext Disconnect for the session
/// it carried, from the session's own UDP socket to the login port (see
/// `disconnect.rs`). Without it ACE holds the session for its 60 s timeout.
/// Nothing is sent before a ConnectRequest has assigned a session id. Bounded
/// and best-effort: a failure is logged and the socket is dropped anyway.
async fn end_ace_session(
    udp: &UdpSocket,
    target: &ConnTarget,
    link: &LinkState,
    peer: SocketAddr,
    tap: Option<&CaptureTap>,
) {
    let Some(session_id) = link.session.get() else {
        log::debug!("[{peer}] no ACE session was set up; no Disconnect to send");
        return;
    };
    let dst = SocketAddr::new(target.ip, target.login_port);
    let packet = disconnect::disconnect_packet(session_id);
    if let Some(tap) = tap {
        tap.capture.record(Direction::ToServer, tap.local, dst, &packet);
    }
    match tokio::time::timeout(disconnect::DISCONNECT_SEND_TIMEOUT, udp.send_to(&packet, dst)).await
    {
        Ok(Ok(_)) => log::info!("[{peer}] sent ACE a Disconnect for session id {session_id} → {dst}"),
        Ok(Err(err)) => {
            log::warn!("[{peer}] Disconnect for session id {session_id} → {dst} failed: {err}")
        }
        Err(_) => log::warn!(
            "[{peer}] Disconnect for session id {session_id} → {dst} timed out after {:?}",
            disconnect::DISCONNECT_SEND_TIMEOUT
        ),
    }
}

async fn read_handshake<S>(
    cfg: &Config,
    targets: &TargetPolicy,
    ws_stream: &mut S,
) -> Result<ConnTarget>
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

    // net-transport-5: only allow-listed ACE targets. The ports are checked
    // first (no DNS for a pair no entry has), then the resolved address.
    if !targets.permits_ports(hello.login_port, world_port) {
        return Err(anyhow!(
            "target ports {}/{} are not on this bridge's --allow-target list ({targets})",
            hello.login_port,
            world_port,
        ));
    }
    let ip = resolve_host(&hello.host, hello.login_port).await?;
    if !targets.permits(&hello.host, ip, hello.login_port, world_port).await {
        return Err(anyhow!(
            "target {} ({ip}:{}/{}) is not on this bridge's --allow-target list ({targets})",
            hello.host,
            hello.login_port,
            world_port,
        ));
    }

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
    tap: Option<CaptureTap>,
    max_frames_per_sec: u32,
) -> Result<()>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    // net-transport-5: opt-in --max-frames-per-sec; `None` relays every frame.
    let mut bucket = FrameBucket::new(max_frames_per_sec, Instant::now());
    let mut over_rate: u64 = 0;
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
                let rate_limited = bucket
                    .as_mut()
                    .is_some_and(|bucket| !bucket.try_take(Instant::now()));
                if rate_limited {
                    over_rate += 1;
                    if over_rate == 1 || over_rate.is_multiple_of(1000) {
                        log::warn!(
                            "[{peer}] over --max-frames-per-sec {max_frames_per_sec}: \
                             {over_rate} frame(s) dropped so far"
                        );
                    }
                    continue;
                }
                let dst = SocketAddr::new(target.ip, port);
                // Seed the ACE-silence clock on the first outbound send
                // so a flow ACE never answers still trips the reaper.
                link.seed_if_zero(&link.last_udp_in_ms);
                // test-tooling-4: recorded BEFORE the send so the capture
                // keeps wire order against the reply the udp→ws pump records.
                if let Some(tap) = &tap {
                    tap.capture.record(Direction::ToServer, tap.local, dst, payload);
                }
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
    tap: Option<CaptureTap>,
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
        // net-transport-2: a ConnectRequest names the session to end at teardown.
        link.session.observe_s2c(payload);
        if let Some(tap) = &tap {
            tap.capture.record(Direction::ToClient, src, tap.local, payload);
        }
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
