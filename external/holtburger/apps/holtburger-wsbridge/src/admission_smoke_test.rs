//! net-transport-5: the bridge's admission control end to end — the target
//! allowlist on the JSON handshake, the Origin check on the upgrade, the
//! connection caps at accept, and the opt-in frame rate. Unit tests for each
//! policy live in `admission.rs`.

#![cfg(test)]

use crate::admission::{Admission, AllowedTarget, OriginPolicy, TargetPolicy};
use crate::bridge;
use crate::config::Config;
use crate::frame;
use crate::handshake::{ClientHello, ServerHello, HANDSHAKE_VERSION};
use anyhow::{Result, anyhow, bail};
use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode, header};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const WAIT: Duration = Duration::from_secs(5);

/// A UDP echo standing in for one ACE port; replies `[tag] ++ datagram`.
async fn spawn_tagged_echo(tag: u8) -> Result<u16> {
    let sock = UdpSocket::bind("127.0.0.1:0").await?;
    let port = sock.local_addr()?.port();
    tokio::spawn(async move {
        let mut buf = [0u8; 2048];
        while let Ok((len, src)) = sock.recv_from(&mut buf).await {
            let mut reply = vec![tag];
            reply.extend_from_slice(&buf[..len]);
            if sock.send_to(&reply, src).await.is_err() {
                return;
            }
        }
    });
    Ok(port)
}

/// The binary's default admission, with only the local ACE at these ports
/// allow-listed (the test echoes stand in for it).
fn local_only(login_port: u16, world_port: u16) -> Admission {
    let spec = format!("localhost:{login_port}:{world_port}");
    Admission {
        targets: TargetPolicy::Only(vec![AllowedTarget::parse(&spec).unwrap()]),
        ..Admission::default()
    }
}

async fn start_bridge(admission: Admission) -> Result<SocketAddr> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let cfg = Config {
        listen: addr,
        default_world_port_offset: 1,
        ws_ping_interval: None,
    };
    tokio::spawn(async move {
        let _ = bridge::accept_loop_admitted(cfg, admission, listener, None).await;
    });
    Ok(addr)
}

/// Open a WebSocket to the bridge with an optional Origin and Host override.
/// The outer error is the test's own; the inner one is the upgrade's outcome.
async fn upgrade(
    bridge_addr: SocketAddr,
    origin: Option<&str>,
    host: Option<&str>,
) -> Result<std::result::Result<Ws, WsError>> {
    let mut request = format!("ws://{bridge_addr}/").into_client_request()?;
    if let Some(origin) = origin {
        request
            .headers_mut()
            .insert(header::ORIGIN, HeaderValue::from_str(origin)?);
    }
    if let Some(host) = host {
        request
            .headers_mut()
            .insert(header::HOST, HeaderValue::from_str(host)?);
    }
    let outcome = tokio::time::timeout(WAIT, tokio_tungstenite::connect_async(request))
        .await
        .map_err(|_| anyhow!("websocket upgrade timed out"))?;
    Ok(outcome.map(|(ws, _response)| ws))
}

/// Send the JSON hello and return the bridge's reply.
async fn hello(
    ws: &mut Ws,
    host: &str,
    login_port: u16,
    world_port: Option<u16>,
) -> Result<ServerHello> {
    let hello = ClientHello {
        v: HANDSHAKE_VERSION,
        host: host.to_string(),
        login_port,
        world_port,
    };
    ws.send(Message::Text(serde_json::to_string(&hello)?.into()))
        .await?;
    let reply = tokio::time::timeout(WAIT, ws.next())
        .await
        .map_err(|_| anyhow!("handshake reply timeout"))?
        .ok_or_else(|| anyhow!("ws closed before handshake reply"))??;
    match reply {
        Message::Text(text) => Ok(serde_json::from_str(&text)?),
        other => bail!("expected text handshake reply, got {other:?}"),
    }
}

/// A fresh connection's hello reply.
async fn hello_on_new_connection(
    bridge_addr: SocketAddr,
    host: &str,
    login_port: u16,
    world_port: Option<u16>,
) -> Result<ServerHello> {
    let mut ws = upgrade(bridge_addr, None, None).await??;
    hello(&mut ws, host, login_port, world_port).await
}

async fn next_binary(ws: &mut Ws) -> Result<Vec<u8>> {
    match tokio::time::timeout(WAIT, ws.next())
        .await
        .map_err(|_| anyhow!("timed out waiting for a binary frame"))?
    {
        Some(Ok(Message::Binary(bytes))) => Ok(bytes),
        other => bail!("expected a binary frame, got {other:?}"),
    }
}

fn assert_refused_by_allowlist(reply: &ServerHello, what: &str) {
    assert!(!reply.ok, "{what}: handshake was accepted");
    let error = reply.error.as_deref().unwrap_or_default();
    assert!(error.contains("--allow-target"), "{what}: unexpected error {error:?}");
}

#[tokio::test]
async fn target_allowlist_admits_the_listed_ace_and_refuses_the_rest() -> Result<()> {
    let login_port = spawn_tagged_echo(0xAA).await?;
    let world_port = spawn_tagged_echo(0xBB).await?;
    let bridge_addr = start_bridge(local_only(login_port, world_port)).await?;

    // The listed target: accepted, and frames relay both ways.
    let mut ws = upgrade(bridge_addr, None, None).await??;
    let reply = hello(&mut ws, "127.0.0.1", login_port, Some(world_port)).await?;
    assert!(reply.ok, "listed target refused: {:?}", reply.error);
    for (port, tag) in [(login_port, 0xAA), (world_port, 0xBB)] {
        ws.send(Message::Binary(frame::encode_frame(port, b"hi")?.into()))
            .await?;
        let bytes = next_binary(&mut ws).await?;
        let (src_port, payload) = frame::decode_frame(&bytes)?;
        assert_eq!(src_port, port);
        assert_eq!(payload, [tag, b'h', b'i']);
    }
    ws.close(None).await.ok();

    // The name resolves to a loopback address, which the entry covers.
    let reply =
        hello_on_new_connection(bridge_addr, "localhost", login_port, Some(world_port)).await?;
    assert!(reply.ok, "localhost refused: {:?}", reply.error);

    // The same host on other ports (swapped, or a pair nobody listed).
    let reply =
        hello_on_new_connection(bridge_addr, "127.0.0.1", world_port, Some(login_port)).await?;
    assert_refused_by_allowlist(&reply, "swapped ports");
    let reply = hello_on_new_connection(bridge_addr, "127.0.0.1", 1, Some(2)).await?;
    assert_refused_by_allowlist(&reply, "ports 1/2");

    // Another host on the listed ports (TEST-NET-1; nothing is sent there).
    let reply =
        hello_on_new_connection(bridge_addr, "192.0.2.1", login_port, Some(world_port)).await?;
    assert_refused_by_allowlist(&reply, "192.0.2.1");
    assert!(reply.error.as_deref().unwrap_or_default().contains("192.0.2.1"));
    Ok(())
}

#[tokio::test]
async fn default_admission_admits_the_local_ace_ports_only() -> Result<()> {
    // Handshakes only: no datagram is relayed, so a running local ACE is
    // never touched (and no ConnectRequest means no teardown Disconnect).
    let bridge_addr = start_bridge(Admission::default()).await?;
    for (host, world_port) in [("127.0.0.1", Some(9001)), ("localhost", None)] {
        let mut ws = upgrade(bridge_addr, Some("http://127.0.0.1:8765"), None).await??;
        let reply = hello(&mut ws, host, 9000, world_port).await?;
        assert!(reply.ok, "{host}: {:?}", reply.error);
        assert_eq!(reply.login_port, Some(9000));
        assert_eq!(reply.world_port, Some(9001));
        ws.close(None).await.ok();
    }
    let reply = hello_on_new_connection(bridge_addr, "127.0.0.1", 9000, Some(9002)).await?;
    assert_refused_by_allowlist(&reply, "127.0.0.1:9000/9002");
    let reply = hello_on_new_connection(bridge_addr, "127.0.0.1", 22, Some(23)).await?;
    assert_refused_by_allowlist(&reply, "127.0.0.1:22/23");
    Ok(())
}

#[tokio::test]
async fn origin_is_checked_on_the_upgrade() -> Result<()> {
    let admission = Admission {
        origins: OriginPolicy::new(&["https://friend.example".to_string()]),
        ..Admission::default()
    };
    let bridge_addr = start_bridge(admission).await?;

    for (origin, host) in [
        // A native client (holtburger-wsshim) sends no Origin.
        (None, None),
        // serve.py's page on another loopback port.
        (Some("http://127.0.0.1:8765"), None),
        (Some("http://localhost:8765"), None),
        // Same host: proxy.cjs behind the cloudflared tunnel passes Host through.
        (Some("https://game.example.test"), Some("game.example.test:8080")),
        // --allow-origin.
        (Some("https://friend.example"), None),
    ] {
        let ws = upgrade(bridge_addr, origin, host).await?;
        assert!(ws.is_ok(), "{origin:?} via {host:?} refused: {:?}", ws.err());
    }

    for (origin, host) in [
        (Some("https://evil.example"), None),
        (Some("https://evil.example"), Some("game.example.test:8080")),
        (Some("null"), None),
    ] {
        match upgrade(bridge_addr, origin, host).await? {
            Err(WsError::Http(response)) => {
                assert_eq!(response.status(), StatusCode::FORBIDDEN, "{origin:?}");
            }
            Err(other) => bail!("{origin:?}: expected HTTP 403, got {other}"),
            Ok(_) => bail!("{origin:?} via {host:?} was let through"),
        }
    }
    Ok(())
}

#[tokio::test]
async fn global_cap_refuses_the_next_connection_until_one_ends() -> Result<()> {
    let login_port = spawn_tagged_echo(0xAA).await?;
    let world_port = spawn_tagged_echo(0xBB).await?;
    let admission = Admission {
        max_conns: 1,
        ..local_only(login_port, world_port)
    };
    let bridge_addr = start_bridge(admission).await?;

    let mut first = upgrade(bridge_addr, None, None).await??;
    assert!(hello(&mut first, "127.0.0.1", login_port, Some(world_port)).await?.ok);

    // The second is dropped at accept, before any upgrade response.
    assert!(
        upgrade(bridge_addr, None, None).await?.is_err(),
        "a second connection got past --max-conns 1"
    );

    // When the first ends, its handler exits and the slot frees.
    first.close(None).await.ok();
    drop(first);
    let mut second = None;
    for _ in 0..100 {
        if let Ok(ws) = upgrade(bridge_addr, None, None).await? {
            second = Some(ws);
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let mut second =
        second.ok_or_else(|| anyhow!("the slot never freed after the first connection closed"))?;
    assert!(hello(&mut second, "127.0.0.1", login_port, Some(world_port)).await?.ok);
    Ok(())
}

#[tokio::test]
async fn loopback_peers_skip_the_per_ip_cap() -> Result<()> {
    // Behind proxy.cjs / cloudflared / an SSH tunnel every peer is 127.0.0.1;
    // a per-IP cap there would throttle the whole tunnel as one client.
    let admission = Admission {
        max_conns_per_ip: 1,
        ..Admission::default()
    };
    let bridge_addr = start_bridge(admission).await?;
    let mut open = Vec::new();
    for i in 0..3 {
        match upgrade(bridge_addr, None, None).await? {
            Ok(ws) => open.push(ws),
            Err(err) => bail!("loopback connection {i} refused: {err}"),
        }
    }
    Ok(())
}

#[tokio::test]
async fn frame_rate_limit_drops_frames_over_the_burst() -> Result<()> {
    let login_port = spawn_tagged_echo(0xAA).await?;
    let world_port = spawn_tagged_echo(0xBB).await?;
    let admission = Admission {
        max_frames_per_sec: 1,
        ..local_only(login_port, world_port)
    };
    let bridge_addr = start_bridge(admission).await?;
    let mut ws = upgrade(bridge_addr, None, None).await??;
    assert!(hello(&mut ws, "127.0.0.1", login_port, Some(world_port)).await?.ok);

    for i in 0..5u8 {
        ws.send(Message::Binary(frame::encode_frame(login_port, &[i])?.into()))
            .await?;
    }
    // 1 frame/s bursts to 2: the first two relay, the other three are dropped
    // (and the connection stays up).
    let mut echoed = Vec::new();
    while let Ok(Some(Ok(Message::Binary(bytes)))) =
        tokio::time::timeout(Duration::from_millis(500), ws.next()).await
    {
        let (_, payload) = frame::decode_frame(&bytes)?;
        echoed.push(payload[1]);
    }
    assert_eq!(echoed, vec![0, 1]);
    Ok(())
}
