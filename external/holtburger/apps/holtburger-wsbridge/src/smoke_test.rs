//! End-to-end smoke test: WS client → bridge → UDP echo → bridge → WS client.
//!
//! Two UDP echo servers stand in for ACE's login (`:9000`) and world (`:9001`)
//! ports. We verify both directions of the bridge by sending frames addressed
//! to each port and asserting the echo comes back over the WS connection
//! tagged with the correct source port.

#![cfg(test)]

use crate::bridge;
use crate::config::Config;
use crate::frame;
use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;

/// Spawn a UDP echo server bound to `127.0.0.1:0`. Returns its actual port.
/// Echoes back every datagram to its sender, prepended with `tag`.
async fn spawn_tagged_echo(tag: u8) -> Result<u16> {
    let sock = UdpSocket::bind("127.0.0.1:0").await?;
    let port = sock.local_addr()?.port();
    tokio::spawn(async move {
        let mut buf = [0u8; 2048];
        loop {
            let (len, src) = match sock.recv_from(&mut buf).await {
                Ok(pair) => pair,
                Err(_) => return,
            };
            let mut reply = Vec::with_capacity(len + 1);
            reply.push(tag);
            reply.extend_from_slice(&buf[..len]);
            if sock.send_to(&reply, src).await.is_err() {
                return;
            }
        }
    });
    Ok(port)
}

/// Drive a single end-to-end WS↔UDP round-trip and assert the echo returns
/// tagged with the right source port.
async fn round_trip(
    bridge_addr: SocketAddr,
    dst_port: u16,
    expected_tag: u8,
    body: &[u8],
) -> Result<()> {
    let url = format!("ws://{bridge_addr}/");
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await?;

    let frame = frame::encode_frame(dst_port, body)?;
    ws.send(Message::Binary(frame.into())).await?;

    let resp = tokio::time::timeout(Duration::from_secs(2), ws.next())
        .await
        .map_err(|_| anyhow::anyhow!("timed out waiting for echo on port {dst_port}"))?
        .ok_or_else(|| anyhow::anyhow!("ws closed before echo arrived"))??;

    let bytes = match resp {
        Message::Binary(b) => b,
        other => anyhow::bail!("expected binary frame, got {other:?}"),
    };
    let (src_port, payload) = frame::decode_frame(&bytes)?;
    assert_eq!(src_port, dst_port, "echoed src port should match dst port");
    assert_eq!(payload[0], expected_tag, "echo tag mismatch");
    assert_eq!(&payload[1..], body, "echo body mismatch");
    ws.close(None).await.ok();
    Ok(())
}

#[tokio::test]
async fn round_trip_login_and_world_ports() -> Result<()> {
    let _ = env_logger::builder()
        .is_test(true)
        .filter_level(log::LevelFilter::Debug)
        .try_init();

    // Two UDP echos standing in for ACE's login + world sockets.
    let login_port = spawn_tagged_echo(0xAA).await?;
    let world_port = spawn_tagged_echo(0xBB).await?;
    assert_ne!(login_port, world_port);

    // Configure + start the bridge.
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let bridge_addr = listener.local_addr()?;
    let cfg = Config {
        listen: bridge_addr,
        ace_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
        ace_login_port: login_port,
        ace_world_port: world_port,
    };
    let (_done_tx, done_rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        // accept_loop runs forever; let it die when the test process exits.
        let _ = tokio::select! {
            res = bridge::accept_loop(cfg, listener) => res,
            _ = done_rx => Ok(()),
        };
    });

    // Give the listener a moment to be polled.
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Login round-trip.
    round_trip(bridge_addr, login_port, 0xAA, b"hello-login").await?;

    // World round-trip on the same WS connection? Each round_trip call opens
    // its own WS — that's fine: a fresh connection still binds its own UDP
    // socket and the accept loop spawns a fresh handler. Same bridge.
    round_trip(bridge_addr, world_port, 0xBB, b"hello-world").await?;

    Ok(())
}

#[tokio::test]
async fn rejects_frame_to_unknown_port() -> Result<()> {
    let _ = env_logger::builder()
        .is_test(true)
        .filter_level(log::LevelFilter::Debug)
        .try_init();

    let login_port = spawn_tagged_echo(0xAA).await?;
    let world_port = spawn_tagged_echo(0xBB).await?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let bridge_addr = listener.local_addr()?;
    let cfg = Config {
        listen: bridge_addr,
        ace_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
        ace_login_port: login_port,
        ace_world_port: world_port,
    };
    tokio::spawn(async move {
        let _ = bridge::accept_loop(cfg, listener).await;
    });
    tokio::time::sleep(Duration::from_millis(50)).await;

    let url = format!("ws://{bridge_addr}/");
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await?;

    // 65535 is reserved-ish and not on the allowlist.
    let bogus = frame::encode_frame(65535, b"nope")?;
    ws.send(Message::Binary(bogus.into())).await?;

    // Expect the bridge to close the connection rather than silently forward.
    let result = tokio::time::timeout(Duration::from_secs(2), ws.next()).await;
    match result {
        Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_))) => Ok(()),
        Ok(Some(Ok(other))) => anyhow::bail!(
            "expected close after bogus port, got {other:?}"
        ),
        Err(_) => anyhow::bail!("timed out waiting for bridge to close on bogus port"),
    }
}
