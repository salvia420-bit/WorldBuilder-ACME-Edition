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

/// Result of `WsTransport::connect`. Distinguishes the two failure
/// modes a caller might want to display differently — couldn't even
/// construct a `WebSocket` (bad URL) vs. handshake failed (server
/// down, blocked, etc.).
#[derive(Debug)]
pub enum ConnectError {
    BadUrl(String),
    Handshake(String),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::BadUrl(s) => write!(f, "ws bad url: {s}"),
            ConnectError::Handshake(s) => write!(f, "ws handshake failed: {s}"),
        }
    }
}

impl std::error::Error for ConnectError {}

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
}

impl WsTransport {
    /// Open `url` and resolve once the WS reaches the OPEN state, or
    /// reject if it errors out before opening. `server_ip` is the IP
    /// address the bridge fronts; it's combined with the per-frame
    /// port tag to synthesize the `SocketAddr` returned by
    /// `recv_from`, so the session's source-address allowlist
    /// (`server_source_addr` / `pending_server_source_addr`) accepts
    /// the packet.
    pub async fn connect(url: &str, server_ip: IpAddr) -> Result<Self, ConnectError> {
        let ws = WebSocket::new(url).map_err(|e| ConnectError::BadUrl(jsval_string(&e)))?;
        ws.set_binary_type(BinaryType::Arraybuffer);

        let (tx, rx) = mpsc::unbounded::<Result<(u16, Vec<u8>)>>();
        let (open_tx, open_rx) = oneshot::channel::<Result<(), String>>();
        // Shared between onopen/onerror so whichever fires first
        // resolves the handshake; the other half becomes a no-op.
        let open_tx = Rc::new(RefCell::new(Some(open_tx)));

        let on_message = {
            let tx = tx.clone();
            Closure::<dyn FnMut(MessageEvent)>::new(move |ev: MessageEvent| {
                let data = ev.data();
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
        // onopen fires exactly once; let the closure drop after the
        // browser invokes it. `forget` here intentionally leaks ~24
        // bytes per WsTransport — acceptable in exchange for not
        // having to keep an Open closure on the struct that's only
        // useful during connect.
        on_open.forget();

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

        Ok(WsTransport {
            ws,
            rx: FutMutex::new(rx),
            server_ip,
            _on_message: on_message,
            _on_close: on_close,
            _on_error: on_error,
        })
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
        let frame = frame::encode_frame(addr.port(), buf);
        self.ws
            .send_with_u8_array(&frame)
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
