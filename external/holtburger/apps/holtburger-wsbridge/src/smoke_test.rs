//! End-to-end smoke test: WS client → bridge (with handshake) → UDP echo →
//! bridge → WS client.

#![cfg(test)]

use crate::bridge;
use crate::config::Config;
use crate::frame;
use crate::handshake::{ClientHello, ServerHello, HANDSHAKE_VERSION};
use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;

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

async fn open_ws_with_handshake(
    bridge_addr: SocketAddr,
    host: &str,
    login_port: u16,
    world_port: u16,
) -> Result<
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
> {
    let url = format!("ws://{bridge_addr}/");
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await?;
    let hello = ClientHello {
        v: HANDSHAKE_VERSION,
        host: host.to_string(),
        login_port,
        world_port: Some(world_port),
    };
    ws.send(Message::Text(serde_json::to_string(&hello)?.into()))
        .await?;
    let reply = tokio::time::timeout(Duration::from_secs(2), ws.next())
        .await
        .map_err(|_| anyhow::anyhow!("handshake reply timeout"))?
        .ok_or_else(|| anyhow::anyhow!("ws closed before handshake reply"))??;
    let text = match reply {
        Message::Text(t) => t,
        other => anyhow::bail!("expected text handshake reply, got {other:?}"),
    };
    let parsed: ServerHello = serde_json::from_str(&text)?;
    if !parsed.ok {
        anyhow::bail!("bridge rejected handshake: {:?}", parsed.error);
    }
    Ok(ws)
}

async fn round_trip(
    bridge_addr: SocketAddr,
    login_port: u16,
    world_port: u16,
    dst_port: u16,
    expected_tag: u8,
    body: &[u8],
) -> Result<()> {
    let mut ws =
        open_ws_with_handshake(bridge_addr, "127.0.0.1", login_port, world_port).await?;

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

fn test_cfg(listen: SocketAddr) -> Config {
    Config {
        listen,
        default_world_port_offset: 1,
    }
}

#[tokio::test]
async fn round_trip_login_and_world_ports() -> Result<()> {
    let _ = env_logger::builder()
        .is_test(true)
        .filter_level(log::LevelFilter::Debug)
        .try_init();

    let login_port = spawn_tagged_echo(0xAA).await?;
    let world_port = spawn_tagged_echo(0xBB).await?;
    assert_ne!(login_port, world_port);

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let bridge_addr = listener.local_addr()?;
    let cfg = test_cfg(bridge_addr);
    let (_done_tx, done_rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = tokio::select! {
            res = bridge::accept_loop(cfg, listener) => res,
            _ = done_rx => Ok(()),
        };
    });

    tokio::time::sleep(Duration::from_millis(50)).await;

    round_trip(bridge_addr, login_port, world_port, login_port, 0xAA, b"hello-login").await?;
    round_trip(bridge_addr, login_port, world_port, world_port, 0xBB, b"hello-world").await?;

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
    let cfg = test_cfg(bridge_addr);
    tokio::spawn(async move {
        let _ = bridge::accept_loop(cfg, listener).await;
    });
    tokio::time::sleep(Duration::from_millis(50)).await;

    let mut ws =
        open_ws_with_handshake(bridge_addr, "127.0.0.1", login_port, world_port).await?;

    let bogus = frame::encode_frame(65535, b"nope")?;
    ws.send(Message::Binary(bogus.into())).await?;

    let result = tokio::time::timeout(Duration::from_secs(2), ws.next()).await;
    match result {
        Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_))) => Ok(()),
        Ok(Some(Ok(other))) => {
            anyhow::bail!("expected close after bogus port, got {other:?}")
        }
        Err(_) => anyhow::bail!("timed out waiting for bridge to close on bogus port"),
    }
}

#[tokio::test]
async fn rejects_handshake_with_unresolvable_host() -> Result<()> {
    let _ = env_logger::builder()
        .is_test(true)
        .filter_level(log::LevelFilter::Debug)
        .try_init();

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let bridge_addr = listener.local_addr()?;
    let cfg = test_cfg(bridge_addr);
    tokio::spawn(async move {
        let _ = bridge::accept_loop(cfg, listener).await;
    });
    tokio::time::sleep(Duration::from_millis(50)).await;

    let url = format!("ws://{bridge_addr}/");
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await?;
    let hello = ClientHello {
        v: HANDSHAKE_VERSION,
        host: "this-host-cannot-resolve.invalid".into(),
        login_port: 9000,
        world_port: Some(9001),
    };
    ws.send(Message::Text(serde_json::to_string(&hello)?.into()))
        .await?;

    let reply = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .map_err(|_| anyhow::anyhow!("handshake reply timeout"))?
        .ok_or_else(|| anyhow::anyhow!("ws closed without reply"))??;
    let text = match reply {
        Message::Text(t) => t,
        other => anyhow::bail!("expected text handshake reply, got {other:?}"),
    };
    let parsed: ServerHello = serde_json::from_str(&text)?;
    assert!(!parsed.ok, "expected ok=false for unresolvable host");
    assert!(parsed.error.is_some());
    Ok(())
}
