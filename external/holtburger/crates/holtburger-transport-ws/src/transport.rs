//! Browser-side `WsTransport` — implements `holtburger_session::Transport`
//! over `web_sys::WebSocket`.

use std::cell::RefCell;
use std::net::{IpAddr, SocketAddr};
use std::rc::Rc;

use anyhow::{Result, anyhow};
use async_trait::async_trait;
use futures::channel::{mpsc, oneshot};
use futures::lock::Mutex as FutMutex;
use futures::{SinkExt, StreamExt};
use holtburger_session::Transport;
use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::{BinaryType, CloseEvent, Event, MessageEvent, WebSocket};

use crate::frame;

/// Result of `WsTransport::connect`. Distinguishes the failure modes a
/// caller might want to display differently — couldn't even construct a
/// `WebSocket` (bad URL), the WS handshake itself failed (server down,
/// blocked, etc.), or the bridge's per-connection JSON handshake (host
/// resolution, port allowlist) was rejected.
#[derive(Debug)]
pub enum ConnectError {
    BadUrl(String),
    Handshake(String),
    /// The bridge replied to the JSON handshake with `ok: false`.
    BridgeRejected(String),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::BadUrl(s) => write!(f, "ws bad url: {s}"),
            ConnectError::Handshake(s) => write!(f, "ws handshake failed: {s}"),
            ConnectError::BridgeRejected(s) => write!(f, "bridge rejected handshake: {s}"),
        }
    }
}

impl std::error::Error for ConnectError {}

#[derive(serde::Serialize)]
struct ClientHello<'a> {
    v: u32,
    host: &'a str,
    login_port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    world_port: Option<u16>,
}

#[derive(serde::Deserialize)]
struct ServerHello {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    ip: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

/// WebSocket-backed `Transport`.
///
/// One `WsTransport` carries both the login and world AC ports
/// multiplexed over the same upstream WS connection. Construct with
/// [`WsTransport::connect`]; pass it to
/// [`holtburger_session::Session::new_with_transport`].
pub struct WsTransport {
    ws: WebSocket,
    rx: FutMutex<mpsc::UnboundedReceiver<Result<(u16, Vec<u8>)>>>,
    server_ip: IpAddr,
    // Closures own captured state the JS side calls back into. They
    // must outlive the WebSocket, so they live on the struct and drop
    // with it.
    _on_message: Closure<dyn FnMut(MessageEvent)>,
    _on_close: Closure<dyn FnMut(CloseEvent)>,
    _on_error: Closure<dyn FnMut(Event)>,
    _on_open: Closure<dyn FnMut(Event)>,
}

impl WsTransport {
    /// Open `url`, perform the per-connection JSON handshake against
    /// the bridge, and return once the bridge confirms the resolved
    /// upstream IP. The transport's `server_ip` field (used to
    /// synthesize the `SocketAddr` returned by `recv_from`, so the
    /// session's source-address allowlist accepts the packet) is
    /// taken from the bridge's reply.
    ///
    /// `host` may be a hostname or IP literal — the bridge resolves it.
    /// `world_port` is optional; if `None`, bridge derives `login_port + 1`.
    pub async fn connect(
        url: &str,
        host: &str,
        login_port: u16,
        world_port: Option<u16>,
    ) -> Result<Self, ConnectError> {
        let ws = WebSocket::new(url).map_err(|e| ConnectError::BadUrl(jsval_string(&e)))?;
        ws.set_binary_type(BinaryType::Arraybuffer);

        let (tx, rx) = mpsc::unbounded::<Result<(u16, Vec<u8>)>>();
        let (open_tx, open_rx) = oneshot::channel::<Result<(), String>>();
        // Shared between onopen/onerror so whichever fires first
        // resolves the handshake; the other half becomes a no-op.
        let open_tx = Rc::new(RefCell::new(Some(open_tx)));
        // First text frame after WS-OPEN is the bridge's `ServerHello`.
        let (handshake_tx, handshake_rx) = oneshot::channel::<String>();
        let handshake_tx = Rc::new(RefCell::new(Some(handshake_tx)));

        let on_message = {
            let tx = tx.clone();
            let handshake_tx = Rc::clone(&handshake_tx);
            Closure::<dyn FnMut(MessageEvent)>::new(move |ev: MessageEvent| {
                let data = ev.data();
                // Text frames are only legal as the one-shot handshake reply.
                if let Some(text) = data.as_string() {
                    if let Some(slot) = handshake_tx.borrow_mut().take() {
                        let _ = slot.send(text);
                    } else {
                        let _ = tx.unbounded_send(Err(anyhow!(
                            "unexpected text ws frame after handshake: {text}"
                        )));
                    }
                    return;
                }
                // Binary frames arrive as ArrayBuffer because we set
                // binaryType=Arraybuffer above. Anything else is a
                // protocol violation.
                let array_buf: js_sys::ArrayBuffer = match data.dyn_into() {
                    Ok(buf) => buf,
                    Err(other) => {
                        let _ = tx.unbounded_send(Err(anyhow!(
                            "ws frame is not an ArrayBuffer (got {})",
                            jsval_string(&other)
                        )));
                        return;
                    }
                };
                let bytes = Uint8Array::new(&array_buf).to_vec();
                match frame::decode_frame(&bytes) {
                    Ok((port, payload)) => {
                        let _ = tx.unbounded_send(Ok((port, payload.to_vec())));
                    }
                    Err(e) => {
                        let _ = tx.unbounded_send(Err(e));
                    }
                }
            })
        };
        ws.set_onmessage(Some(on_message.as_ref().unchecked_ref()));

        let on_open = {
            let open_tx = Rc::clone(&open_tx);
            Closure::<dyn FnMut(Event)>::new(move |_ev: Event| {
                if let Some(tx) = open_tx.borrow_mut().take() {
                    let _ = tx.send(Ok(()));
                }
            })
        };
        ws.set_onopen(Some(on_open.as_ref().unchecked_ref()));
        // A13 (net-review 2026-07-09, landed 2026-07-10): keep the Open
        // closure on the struct like the other three handlers instead of
        // `forget()`ing it. The forget-leak was per-CONNECT, not per-page —
        // reconnect loops (net drops, "Account In Use" boots, soak runs)
        // accumulate it. Drop already detaches onopen.

        let on_error = {
            let tx_err = tx.clone();
            let open_tx = Rc::clone(&open_tx);
            Closure::<dyn FnMut(Event)>::new(move |ev: Event| {
                let msg = format!("ws error: {}", jsval_string(&JsValue::from(ev)));
                if let Some(tx) = open_tx.borrow_mut().take() {
                    let _ = tx.send(Err(msg.clone()));
                }
                let _ = tx_err.unbounded_send(Err(anyhow!(msg)));
            })
        };
        ws.set_onerror(Some(on_error.as_ref().unchecked_ref()));

        let on_close = {
            let mut tx_close = tx.clone();
            Closure::<dyn FnMut(CloseEvent)>::new(move |ev: CloseEvent| {
                let _ = tx_close.unbounded_send(Err(anyhow!(
                    "ws closed (code={}, reason={})",
                    ev.code(),
                    ev.reason()
                )));
                // Drop the close-side sender so the receiver eventually
                // sees None when no other handlers are still pushing.
                let _ = futures::executor::block_on(tx_close.close());
            })
        };
        ws.set_onclose(Some(on_close.as_ref().unchecked_ref()));

        match open_rx.await {
            Ok(Ok(())) => {}
            Ok(Err(msg)) => return Err(ConnectError::Handshake(msg)),
            Err(_) => {
                return Err(ConnectError::Handshake(
                    "open notifier dropped before WS resolved".into(),
                ));
            }
        }

        // Per-connection JSON handshake to the bridge.
        let hello = ClientHello {
            v: 1,
            host,
            login_port,
            world_port,
        };
        let payload = serde_json::to_string(&hello).map_err(|e| {
            ConnectError::Handshake(format!("serialize ClientHello: {e}"))
        })?;
        ws.send_with_str(&payload).map_err(|e| {
            ConnectError::Handshake(format!("send ClientHello: {}", jsval_string(&e)))
        })?;

        let reply = handshake_rx.await.map_err(|_| {
            ConnectError::Handshake("ws closed before handshake reply".into())
        })?;
        let parsed: ServerHello = serde_json::from_str(&reply).map_err(|e| {
            ConnectError::Handshake(format!("parse ServerHello: {e} (raw: {reply})"))
        })?;
        if !parsed.ok {
            return Err(ConnectError::BridgeRejected(
                parsed.error.unwrap_or_else(|| "(no error message)".into()),
            ));
        }
        let ip_str = parsed
            .ip
            .ok_or_else(|| ConnectError::Handshake("ServerHello.ok=true but ip missing".into()))?;
        let server_ip: IpAddr = ip_str.parse().map_err(|e| {
            ConnectError::Handshake(format!("ServerHello.ip parse: {e} (raw: {ip_str})"))
        })?;

        Ok(WsTransport {
            ws,
            rx: FutMutex::new(rx),
            server_ip,
            _on_message: on_message,
            _on_close: on_close,
            _on_error: on_error,
            _on_open: on_open,
        })
    }

    /// IP the bridge resolved for the host announced in the JSON
    /// handshake. Callers use this to construct the
    /// `holtburger_session::Session`'s `server_addr`.
    pub fn server_ip(&self) -> IpAddr {
        self.server_ip
    }
}

impl Drop for WsTransport {
    fn drop(&mut self) {
        // Detach handlers so any in-flight events become no-ops, then
        // close the socket. Failures here are not actionable.
        self.ws.set_onmessage(None);
        self.ws.set_onopen(None);
        self.ws.set_onerror(None);
        self.ws.set_onclose(None);
        let _ = self.ws.close();
    }
}

#[async_trait(?Send)]
impl Transport for WsTransport {
    async fn send_to(&self, buf: &[u8], addr: SocketAddr) -> Result<usize> {
        if buf.len() > frame::MAX_PACKET_BYTES {
            return Err(anyhow!(
                "outbound packet {} bytes exceeds MAX_PACKET_BYTES={}",
                buf.len(),
                frame::MAX_PACKET_BYTES
            ));
        }
        let frame = frame::encode_frame(addr.port(), buf)?;
        // wasm-threads (SAB): `send_with_u8_array` hands the socket a Uint8Array
        // VIEW over wasm linear memory. Once that memory is shared, the view is
        // SharedArrayBuffer-backed and the DOM rejects it outright —
        // "Failed to execute 'send' on 'WebSocket': The provided ArrayBufferView
        // value must not be shared." (measured 2026-07-24, threads-lite probe).
        // Copy into a JS-heap array so the buffer handed out is never shared.
        // Correct and cheap on the non-threaded path too: one memcpy of a
        // <=MAX_PACKET_BYTES frame, on the outbound packet path only.
        let js_frame = Uint8Array::new_with_length(frame.len() as u32);
        js_frame.copy_from(&frame);
        self.ws
            .send_with_array_buffer_view(&js_frame)
            .map_err(|e| anyhow!("ws send: {}", jsval_string(&e)))?;
        Ok(buf.len())
    }

    async fn recv_from(&self, buf: &mut [u8]) -> Result<(usize, SocketAddr)> {
        let mut rx = self.rx.lock().await;
        let next = rx
            .next()
            .await
            .ok_or_else(|| anyhow!("ws stream closed"))??;
        let (port, payload) = next;
        if payload.len() > buf.len() {
            return Err(anyhow!(
                "ws payload {} bytes exceeds caller buffer {} bytes",
                payload.len(),
                buf.len()
            ));
        }
        buf[..payload.len()].copy_from_slice(&payload);
        let src = SocketAddr::new(self.server_ip, port);
        Ok((payload.len(), src))
    }
}

fn jsval_string(v: &JsValue) -> String {
    v.as_string()
        .or_else(|| js_sys::JSON::stringify(v).ok().and_then(|s| s.as_string()))
        .unwrap_or_else(|| format!("{v:?}"))
}
