//! Client-side UDP↔WS shim — the mirror of [`crate::bridge`].
//!
//! Listens on the same `(host, login_port)` and `(host, login_port + 1)` pair
//! that an unmodified `holtburger-cli` already dials when it expects to be
//! talking to ACE, and forwards every datagram across one upstream WebSocket
//! connection to a remote [`crate::bridge`]. The framing is the same
//! `[port:u16 BE][ac_packet]` shape — see [`crate::frame`].
//!
//! Single-tenant by design: one WS connection upstream, one
//! `holtburger-cli` downstream. The shim remembers the cli's UDP source
//! address (its ephemeral local port) the first time a datagram arrives in
//! either direction, and uses that same address as the destination for every
//! WS→UDP frame. That works because [`holtburger-session::Session::new`] at
//! `crates/holtburger-session/src/session/api.rs:9-10` binds exactly one
//! `0.0.0.0:0` socket and reuses it for both login and world traffic.
//!
//! Lifecycle:
//! ```text
//!     ┌──────────────────┐  udp  ┌─────────┐  ws   ┌────────────────┐
//!     │ holtburger-cli   │──────▶│ wsshim  │──────▶│ wsbridge → ACE │
//!     │ (unmodified)     │◀──────│         │◀──────│                │
//!     └──────────────────┘       └─────────┘       └────────────────┘
//!     binds 0.0.0.0:0    listens listen_login_port  binds 0.0.0.0:0
//!                                listen_world_port  per ws connection
//! ```

use crate::frame;
use anyhow::{Context, Result, anyhow};
use clap::Parser;
use futures_util::{SinkExt, Stream, StreamExt};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::UdpSocket;
use tokio::sync::RwLock;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

#[derive(Parser, Debug)]
#[command(
    author,
    version,
    about = "UDP↔WS shim in front of an unmodified holtburger-cli. Forwards the cli's UDP traffic over WebSocket to a remote holtburger-wsbridge.",
    long_about = None,
)]
pub struct Cli {
    /// WebSocket URL of the upstream `holtburger-wsbridge`.
    /// Example: `ws://1.2.3.4:8080/`.
    #[arg(long)]
    pub bridge: String,

    /// Local IP address to listen on. Point `holtburger-cli`'s `--host` at
    /// this address so it dials the shim instead of ACE directly.
    #[arg(long, default_value = "127.0.0.1")]
    pub listen_host: String,

    /// Local UDP port that stands in for ACE's login port — i.e. the port
    /// `holtburger-cli` will dial. The shim binds one socket here and a
    /// second on `listen-login-port + 1` to match the `login_port`
    /// / `login_port + 1` convention the holtburger session enforces in
    /// `crates/holtburger-session/src/session/auth.rs:41-44`.
    #[arg(long, default_value_t = 9000)]
    pub listen_login_port: u16,

    /// Override the local world UDP port. Defaults to `listen-login-port + 1`.
    #[arg(long)]
    pub listen_world_port: Option<u16>,

    /// The ACE login port the *bridge* expects to see on the wire — i.e. what
    /// gets stamped into outgoing WS frames and what the bridge will send back
    /// in inbound WS frames. Almost always equal to `--listen-login-port`;
    /// override only if ACE is on non-standard UDP ports while
    /// `holtburger-cli` is dialing the conventional ones (or vice versa).
    /// Defaults to `--listen-login-port`.
    #[arg(long)]
    pub ace_login_port: Option<u16>,

    /// Override the ACE world port the bridge expects on the wire.
    /// Defaults to `ace-login-port + 1`.
    #[arg(long)]
    pub ace_world_port: Option<u16>,
}

/// Resolved runtime configuration.
///
/// `listen_*_port` is where the shim binds locally — that's what
/// `holtburger-cli` dials. `ace_*_port` is the wire label the bridge
/// expects/produces — that's the actual ACE UDP port. The two pairs are equal
/// in the common case but split apart when either side has been moved off the
/// standard `9000`/`9001` numbers.
#[derive(Clone, Debug)]
pub struct Config {
    pub bridge_url: String,
    pub listen_ip: IpAddr,
    pub listen_login_port: u16,
    pub listen_world_port: u16,
    pub ace_login_port: u16,
    pub ace_world_port: u16,
}

impl Config {
    pub fn from_cli(cli: Cli) -> Result<Self> {
        let listen_ip: IpAddr = cli.listen_host.parse().with_context(|| {
            format!(
                "invalid --listen-host (expected IP literal): {}",
                cli.listen_host
            )
        })?;

        let listen_world_port = match cli.listen_world_port {
            Some(p) => p,
            None => cli
                .listen_login_port
                .checked_add(1)
                .ok_or_else(|| anyhow!("listen-login-port + 1 overflows u16"))?,
        };
        if listen_world_port == cli.listen_login_port {
            return Err(anyhow!(
                "listen-login-port and listen-world-port must differ (got {} and {})",
                cli.listen_login_port,
                listen_world_port
            ));
        }

        let ace_login_port = cli.ace_login_port.unwrap_or(cli.listen_login_port);
        let ace_world_port = match cli.ace_world_port {
            Some(p) => p,
            None => ace_login_port
                .checked_add(1)
                .ok_or_else(|| anyhow!("ace-login-port + 1 overflows u16"))?,
        };
        if ace_world_port == ace_login_port {
            return Err(anyhow!(
                "ace-login-port and ace-world-port must differ (got {} and {})",
                ace_login_port,
                ace_world_port
            ));
        }

        Ok(Config {
            bridge_url: cli.bridge,
            listen_ip,
            listen_login_port: cli.listen_login_port,
            listen_world_port,
            ace_login_port,
            ace_world_port,
        })
    }
}

/// Bind both UDP sockets, dial the bridge, and run the forwarder.
///
/// Returns once the WS closes or any half of the forwarder exits.
pub async fn run(cfg: Config) -> Result<()> {
    let login_addr = SocketAddr::new(cfg.listen_ip, cfg.listen_login_port);
    let world_addr = SocketAddr::new(cfg.listen_ip, cfg.listen_world_port);

    let login_sock = Arc::new(
        UdpSocket::bind(login_addr)
            .await
            .with_context(|| format!("bind login udp socket on {login_addr}"))?,
    );
    let world_sock = Arc::new(
        UdpSocket::bind(world_addr)
            .await
            .with_context(|| format!("bind world udp socket on {world_addr}"))?,
    );

    log::info!(
        "listening udp {login_addr} (login) / {world_addr} (world); \
         tagging ws frames as ace login={}, world={}; dialing {}",
        cfg.ace_login_port,
        cfg.ace_world_port,
        cfg.bridge_url,
    );

    let request = cfg
        .bridge_url
        .as_str()
        .into_client_request()
        .with_context(|| format!("invalid bridge url: {}", cfg.bridge_url))?;
    let (ws, _resp) = tokio_tungstenite::connect_async(request)
        .await
        .with_context(|| format!("connect ws bridge {}", cfg.bridge_url))?;
    log::info!("ws connected to {}", cfg.bridge_url);

    run_with_sockets(cfg, login_sock, world_sock, ws).await
}

/// Run forwarding loops over already-bound UDP sockets and an established
/// WebSocket. Used by [`run`] and by integration tests that need to know the
/// bound UDP ports before starting a fake client.
pub async fn run_with_sockets<S>(
    cfg: Config,
    login_sock: Arc<UdpSocket>,
    world_sock: Arc<UdpSocket>,
    ws: WebSocketStream<S>,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (ws_sink, ws_stream) = ws.split();
    let client_addr: Arc<RwLock<Option<SocketAddr>>> = Arc::new(RwLock::new(None));

    let to_udp = forward_ws_to_udp(
        cfg.ace_login_port,
        cfg.ace_world_port,
        Arc::clone(&login_sock),
        Arc::clone(&world_sock),
        Arc::clone(&client_addr),
        ws_stream,
    );
    let to_ws = forward_udp_to_ws(
        cfg.ace_login_port,
        cfg.ace_world_port,
        login_sock,
        world_sock,
        client_addr,
        ws_sink,
    );

    tokio::select! {
        res = to_udp => {
            log::debug!("ws→udp half exited: {res:?}");
            res
        }
        res = to_ws => {
            log::debug!("udp→ws half exited: {res:?}");
            res
        }
    }
}

/// Pump WS binary frames out as UDP datagrams to the remembered cli source.
async fn forward_ws_to_udp<S>(
    login_port: u16,
    world_port: u16,
    login_sock: Arc<UdpSocket>,
    world_sock: Arc<UdpSocket>,
    client_addr: Arc<RwLock<Option<SocketAddr>>>,
    mut ws_stream: S,
) -> Result<()>
where
    S: Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    while let Some(msg) = ws_stream.next().await {
        let msg = msg.context("ws read")?;
        match msg {
            Message::Binary(bytes) => {
                let (port, payload) =
                    frame::decode_frame(&bytes).context("decode ws frame")?;
                let sock = if port == login_port {
                    &login_sock
                } else if port == world_port {
                    &world_sock
                } else {
                    return Err(anyhow!(
                        "ws frame source port {port} not on allowlist \
                         (login={login_port}, world={world_port})"
                    ));
                };
                let dst = match *client_addr.read().await {
                    Some(addr) => addr,
                    None => {
                        log::warn!(
                            "dropping ws frame port={port} ({} bytes): no holtburger udp source seen yet",
                            payload.len()
                        );
                        continue;
                    }
                };
                let sent = sock
                    .send_to(payload, dst)
                    .await
                    .with_context(|| format!("udp send_to {dst} via :{port}"))?;
                if sent != payload.len() {
                    return Err(anyhow!(
                        "short udp write to {dst}: {sent}/{} bytes",
                        payload.len()
                    ));
                }
                log::trace!("ws→udp {} bytes → {dst} via :{port}", payload.len());
            }
            Message::Close(_) => {
                log::debug!("ws closed by peer");
                return Ok(());
            }
            Message::Ping(_) | Message::Pong(_) => {
                // tokio-tungstenite handles ping/pong automatically.
            }
            Message::Text(_) | Message::Frame(_) => {
                return Err(anyhow!(
                    "non-binary ws frame is not part of the protocol"
                ));
            }
        }
    }
    Ok(())
}

/// Multiplex datagrams arriving on the two UDP sockets onto one WS sink,
/// tagged with the port they arrived on. Updates the shared `client_addr` so
/// the reverse path can find the cli.
async fn forward_udp_to_ws<S>(
    login_port: u16,
    world_port: u16,
    login_sock: Arc<UdpSocket>,
    world_sock: Arc<UdpSocket>,
    client_addr: Arc<RwLock<Option<SocketAddr>>>,
    mut ws_sink: S,
) -> Result<()>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let mut login_buf = vec![0u8; frame::MAX_PACKET_BYTES];
    let mut world_buf = vec![0u8; frame::MAX_PACKET_BYTES];
    loop {
        // Both UdpSocket::recv_from arms are individually cancel-safe, so it's
        // OK that select! drops the loser.
        let (port, src, payload) = tokio::select! {
            r = login_sock.recv_from(&mut login_buf) => {
                let (n, src) = r.context("udp recv login")?;
                (login_port, src, login_buf[..n].to_vec())
            }
            r = world_sock.recv_from(&mut world_buf) => {
                let (n, src) = r.context("udp recv world")?;
                (world_port, src, world_buf[..n].to_vec())
            }
        };

        // Latch the cli's UDP source so the reverse path can address replies.
        // The cli only ever uses one socket (one (ip, ephemeral_port) pair), so
        // updates from either UDP recv loop are equivalent.
        *client_addr.write().await = Some(src);

        let frame =
            frame::encode_frame(port, &payload).context("encode ws frame from udp")?;
        ws_sink
            .send(Message::Binary(frame.into()))
            .await
            .context("ws send")?;
        log::trace!("udp→ws {} bytes ← {src} via :{port}", payload.len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Config> {
        let mut full = vec!["holtburger-wsshim"];
        full.extend_from_slice(args);
        let cli = Cli::try_parse_from(full)?;
        Config::from_cli(cli)
    }

    #[test]
    fn defaults_world_port_to_login_plus_one_and_ace_to_listen() {
        let cfg = parse(&["--bridge", "ws://example:8080/"]).unwrap();
        assert_eq!(cfg.listen_login_port, 9000);
        assert_eq!(cfg.listen_world_port, 9001);
        assert_eq!(cfg.ace_login_port, 9000);
        assert_eq!(cfg.ace_world_port, 9001);
        assert_eq!(cfg.bridge_url, "ws://example:8080/");
    }

    #[test]
    fn rejects_equal_listen_login_and_world_ports() {
        let err = parse(&[
            "--bridge",
            "ws://x/",
            "--listen-login-port",
            "9000",
            "--listen-world-port",
            "9000",
        ])
        .unwrap_err();
        assert!(err.to_string().contains("listen-login-port and listen-world-port"));
    }

    #[test]
    fn rejects_equal_ace_login_and_world_ports() {
        let err = parse(&[
            "--bridge",
            "ws://x/",
            "--ace-login-port",
            "9000",
            "--ace-world-port",
            "9000",
        ])
        .unwrap_err();
        assert!(err.to_string().contains("ace-login-port and ace-world-port"));
    }

    #[test]
    fn rejects_overflow_listen_world_port() {
        let err = parse(&["--bridge", "ws://x/", "--listen-login-port", "65535"]).unwrap_err();
        assert!(err.to_string().contains("listen-login-port + 1 overflows"));
    }

    #[test]
    fn rejects_overflow_ace_world_port() {
        // Use distinct listen ports so the listen overflow check passes first.
        let err = parse(&[
            "--bridge",
            "ws://x/",
            "--listen-login-port",
            "9000",
            "--ace-login-port",
            "65535",
        ])
        .unwrap_err();
        assert!(err.to_string().contains("ace-login-port + 1 overflows"));
    }

    #[test]
    fn rejects_non_ip_listen_host() {
        let err = parse(&["--bridge", "ws://x/", "--listen-host", "not-an-ip.local"]).unwrap_err();
        assert!(err.to_string().contains("invalid --listen-host"));
    }

    #[test]
    fn explicit_listen_world_port_overrides_default() {
        let cfg = parse(&[
            "--bridge",
            "ws://x/",
            "--listen-login-port",
            "9000",
            "--listen-world-port",
            "9100",
        ])
        .unwrap();
        assert_eq!(cfg.listen_world_port, 9100);
    }

    #[test]
    fn ace_ports_can_diverge_from_listen_ports() {
        // The "ACE-on-non-standard-ports" production case: cli still dials
        // 9000/9001 but the bridge is talking to ACE on 19000/19001.
        let cfg = parse(&[
            "--bridge",
            "ws://x/",
            "--listen-login-port",
            "9000",
            "--ace-login-port",
            "19000",
        ])
        .unwrap();
        assert_eq!(cfg.listen_login_port, 9000);
        assert_eq!(cfg.listen_world_port, 9001);
        assert_eq!(cfg.ace_login_port, 19000);
        assert_eq!(cfg.ace_world_port, 19001);
    }
}
