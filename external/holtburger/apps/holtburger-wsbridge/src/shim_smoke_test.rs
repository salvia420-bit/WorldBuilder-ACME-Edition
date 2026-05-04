//! End-to-end test of the full Phase-1 loop:
//!
//! ```text
//!   fake holtburger-cli ──udp──▶ shim ──ws──▶ bridge ──udp──▶ echo (login)
//!                       ◀──udp── shim ◀──ws── bridge ◀──udp── echo
//! ```
//!
//! Also runs a round-trip on the world port from the same fake-cli ephemeral
//! socket — that mirrors `holtburger-session::Session`'s real behaviour of
//! using one bound UDP socket for both login and world traffic.
//!
//! The shim is given mismatched listen / ace port pairs (ephemeral listen
//! ports vs the echoes' actual ports as ace_*_port), exercising both the
//! "shim binds on ephemeral test ports" axis and the "the wire-tag port is
//! independent of the local bind" production case.

#![cfg(test)]

use crate::{bridge, config, shim};
use anyhow::Result;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, UdpSocket};

/// Spawn a UDP echo server bound to `127.0.0.1:0`. Returns its actual port.
/// Echoes back every datagram, prepended with `tag` so the test can tell
/// the two echoes apart.
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

/// Stand up the full bridge + shim stack with the given (echo, bridge, shim)
/// wiring and return the addresses the fake-cli should dial.
async fn standup() -> Result<(SocketAddr, SocketAddr)> {
    // Two echoes stand in for ACE login + world.
    let ace_login_port = spawn_tagged_echo(0xAA).await?;
    let ace_world_port = spawn_tagged_echo(0xBB).await?;
    assert_ne!(ace_login_port, ace_world_port);

    // Bridge.
    let bridge_listener = TcpListener::bind("127.0.0.1:0").await?;
    let bridge_addr = bridge_listener.local_addr()?;
    let bridge_cfg = config::Config {
        listen: bridge_addr,
        ace_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
        ace_login_port,
        ace_world_port,
    };
    tokio::spawn(async move {
        let _ = bridge::accept_loop(bridge_cfg, bridge_listener).await;
    });

    // Shim. Pre-bind both UDP sockets on ephemeral ports so the test can
    // dial them, and tag WS frames with the *echoes*' ports so they pass
    // the bridge's allowlist.
    let shim_login_sock = Arc::new(UdpSocket::bind("127.0.0.1:0").await?);
    let shim_world_sock = Arc::new(UdpSocket::bind("127.0.0.1:0").await?);
    let shim_login_addr = shim_login_sock.local_addr()?;
    let shim_world_addr = shim_world_sock.local_addr()?;
    let shim_cfg = shim::Config {
        bridge_url: format!("ws://{bridge_addr}/"),
        listen_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
        listen_login_port: shim_login_addr.port(),
        listen_world_port: shim_world_addr.port(),
        ace_login_port,
        ace_world_port,
    };

    // Dial the bridge from the shim.
    let url = format!("ws://{bridge_addr}/");
    let (ws, _) = tokio_tungstenite::connect_async(url).await?;

    tokio::spawn(async move {
        let _ =
            shim::run_with_sockets(shim_cfg, shim_login_sock, shim_world_sock, ws).await;
    });

    // Give the bridge accept loop and shim forwarders a moment to schedule.
    tokio::time::sleep(Duration::from_millis(50)).await;

    Ok((shim_login_addr, shim_world_addr))
}

/// Send `body` to `dst` from `cli` and assert the echo comes back tagged
/// with `expected_tag` from a source equal to `dst`.
async fn round_trip(
    cli: &UdpSocket,
    dst: SocketAddr,
    expected_tag: u8,
    body: &[u8],
) -> Result<()> {
    cli.send_to(body, dst).await?;
    let mut buf = [0u8; 1024];
    let (len, src) = tokio::time::timeout(Duration::from_secs(2), cli.recv_from(&mut buf))
        .await
        .map_err(|_| anyhow::anyhow!("timed out waiting for echo from {dst}"))??;
    assert_eq!(
        src, dst,
        "echo for {body:?} must come back from the same address it was sent to (got {src})"
    );
    assert!(len >= 1, "echo response too short");
    assert_eq!(buf[0], expected_tag, "wrong echo tag for {body:?}");
    assert_eq!(&buf[1..len], body, "echo body mismatch for {body:?}");
    Ok(())
}

#[tokio::test]
async fn cli_to_ace_round_trip_via_shim_and_bridge() -> Result<()> {
    let _ = env_logger::builder()
        .is_test(true)
        .filter_level(log::LevelFilter::Debug)
        .try_init();

    let (shim_login_addr, shim_world_addr) = standup().await?;

    // Fake holtburger-cli: one ephemeral UDP socket, mirrors what
    // holtburger-session does at api.rs:9-10 (`UdpSocket::bind("0.0.0.0:0")`).
    let cli = UdpSocket::bind("127.0.0.1:0").await?;

    // Login round-trip.
    round_trip(&cli, shim_login_addr, 0xAA, b"login-frame-from-cli").await?;

    // World round-trip — same cli socket, different destination, same trip.
    // Mirrors auth.rs:33-66's mid-session move from login to world port.
    round_trip(&cli, shim_world_addr, 0xBB, b"world-frame-from-cli").await?;

    Ok(())
}

#[tokio::test]
async fn cli_can_interleave_login_and_world_traffic() -> Result<()> {
    let _ = env_logger::builder()
        .is_test(true)
        .filter_level(log::LevelFilter::Debug)
        .try_init();

    let (shim_login_addr, shim_world_addr) = standup().await?;
    let cli = UdpSocket::bind("127.0.0.1:0").await?;

    // Burst on login, then world, then login again — verifies the shim's
    // shared client_addr latch isn't sticky-on-first-port and that both
    // forwarder halves stay live as multiple frames flow.
    round_trip(&cli, shim_login_addr, 0xAA, b"l1").await?;
    round_trip(&cli, shim_world_addr, 0xBB, b"w1").await?;
    round_trip(&cli, shim_login_addr, 0xAA, b"l2").await?;
    round_trip(&cli, shim_world_addr, 0xBB, b"w2").await?;

    Ok(())
}
