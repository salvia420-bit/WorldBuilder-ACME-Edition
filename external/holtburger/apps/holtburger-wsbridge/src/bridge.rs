//! WebSocket listener and per-connection forwarder.

use crate::config::Config;
use crate::frame;
use anyhow::{Context, Result, anyhow};
use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio_tungstenite::tungstenite::Message;

/// Bind the WS listen socket and accept connections forever.
///
/// Each accepted TCP connection is upgraded to a WebSocket and handed to
/// [`handle_connection`] on its own task. The accept loop never returns under
/// normal operation; only socket-level errors propagate up.
pub async fn run(cfg: Config) -> Result<()> {
    let listener = TcpListener::bind(cfg.listen)
        .await
        .with_context(|| format!("bind {}", cfg.listen))?;
    accept_loop(cfg, listener).await
}

/// Same as [`run`] but consumes a pre-bound listener. Used by integration
/// tests that need the actual bound address before starting clients.
pub async fn accept_loop(cfg: Config, listener: TcpListener) -> Result<()> {
    log::info!(
        "listening on ws://{}  →  udp {}:{} (login) / {}:{} (world)",
        listener.local_addr()?,
        cfg.ace_ip,
        cfg.ace_login_port,
        cfg.ace_ip,
        cfg.ace_world_port,
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

/// Upgrade a TCP stream to WebSocket and forward bytes between it and a
/// freshly-bound UDP socket pointed at the configured ACE host.
async fn handle_connection(cfg: Arc<Config>, tcp: TcpStream, peer: SocketAddr) -> Result<()> {
    log::info!("[{peer}] accepted; upgrading to ws");
    let ws = tokio_tungstenite::accept_async(tcp)
        .await
        .with_context(|| format!("[{peer}] websocket handshake"))?;

    let udp = UdpSocket::bind("0.0.0.0:0")
        .await
        .with_context(|| format!("[{peer}] bind ephemeral udp socket"))?;
    let local = udp.local_addr().ok();
    log::info!("[{peer}] udp socket bound to {local:?}");
    let udp = Arc::new(udp);

    let (ws_sink, ws_stream) = ws.split();

    // Two concurrent halves; either one returning shuts the connection down.
    let to_udp = forward_ws_to_udp(Arc::clone(&cfg), Arc::clone(&udp), ws_stream, peer);
    let to_ws = forward_udp_to_ws(Arc::clone(&cfg), udp, ws_sink, peer);

    tokio::select! {
        res = to_udp => {
            log::debug!("[{peer}] ws→udp half exited: {res:?}");
            res
        }
        res = to_ws => {
            log::debug!("[{peer}] udp→ws half exited: {res:?}");
            res
        }
    }
}

/// Pump WS binary frames out as UDP datagrams.
async fn forward_ws_to_udp<S>(
    cfg: Arc<Config>,
    udp: Arc<UdpSocket>,
    mut ws_stream: S,
    peer: SocketAddr,
) -> Result<()>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    while let Some(msg) = ws_stream.next().await {
        let msg = msg.with_context(|| format!("[{peer}] ws read"))?;
        match msg {
            Message::Binary(bytes) => {
                let (port, payload) = frame::decode_frame(&bytes)
                    .with_context(|| format!("[{peer}] decode ws frame"))?;
                if !cfg.is_ace_port(port) {
                    return Err(anyhow!(
                        "[{peer}] ws frame destination port {port} not on allowlist \
                         (login={}, world={})",
                        cfg.ace_login_port,
                        cfg.ace_world_port
                    ));
                }
                let dst = SocketAddr::new(cfg.ace_ip, port);
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
            Message::Ping(_) | Message::Pong(_) => {
                // tokio-tungstenite handles ping/pong automatically.
            }
            Message::Text(_) | Message::Frame(_) => {
                return Err(anyhow!("[{peer}] non-binary ws frame is not part of the protocol"));
            }
        }
    }
    Ok(())
}

/// Pump UDP datagrams out as WS binary frames.
async fn forward_udp_to_ws<S>(
    cfg: Arc<Config>,
    udp: Arc<UdpSocket>,
    mut ws_sink: S,
    peer: SocketAddr,
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

        if src.ip() != cfg.ace_ip {
            log::warn!(
                "[{peer}] dropping datagram from unexpected source ip {}: expected {}",
                src.ip(),
                cfg.ace_ip
            );
            continue;
        }
        if !cfg.is_ace_port(src.port()) {
            log::warn!(
                "[{peer}] dropping datagram from {src}: source port not on allowlist \
                 (login={}, world={})",
                cfg.ace_login_port,
                cfg.ace_world_port
            );
            continue;
        }

        let payload = &buf[..len];
        let frame = frame::encode_frame(src.port(), payload)
            .with_context(|| format!("[{peer}] encode ws frame from {src}"))?;
        ws_sink
            .send(Message::Binary(frame.into()))
            .await
            .with_context(|| format!("[{peer}] ws send"))?;
        log::trace!("[{peer}] udp→ws {len} bytes ← {src}");
    }
}
