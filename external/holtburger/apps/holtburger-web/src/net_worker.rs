//! net_worker — transport-in-worker port (the "RemoteSessionProxy" design).
//!
//! # Why
//! holtburger-web sessions drop from vanilla ACE with `Reason: Network
//! Timeout`: ACE reaps a session after 60s with no inbound client packet
//! (reset by ANY inbound packet, upstream of dispatch). Every prior
//! keepalive path ran on the browser MAIN THREAD, so it dies when the main
//! thread is saturated (long synchronous landblock bake/decode) or the tab
//! is hidden/occluded and its timers are throttled. The shipped
//! `keepalive_worker` heartbeat (2026-07-07) beats *timer throttling* but
//! still routes through the main-thread wasm executor, so it does NOT
//! survive a fully frozen / 100%-saturated main thread.
//!
//! # What moves
//! Only the raw wire I/O — the `WsTransport` (WebSocket) and the
//! `holtburger_session::Session` state machine (ISAAC crypto, packet /
//! fragment sequencing, fragment reassembly, ACK generation, keepalive
//! ping) — moves into a dedicated Web Worker with its OWN wasm instance.
//! Everything else stays exactly where it is on the main thread: the recv
//! loop, the entire `GameMessage` dispatch `match`, the per-rAF
//! `TickMovement` physics/prediction integrator, all ~60 `Rc<RefCell<…>>`
//! world/collision/pose cells, and every synchronous render read
//! (`getRenderSet*`, `getLocalPlayerPose`, `terrainHeightAt`, collision
//! sweeps, …). Those are driven by / read by the render loop each frame and
//! CANNOT tolerate an async worker boundary — so they don't cross one.
//!
//! # How
//! The main-thread recv loop keeps calling `session.recv_message()`,
//! `session.send_action()`, `session.send_message()` verbatim — but
//! `session` is now a [`LoopSession`] enum that is either the real
//! `Session` (direct mode, unchanged default) or a [`RemoteSessionProxy`]
//! that shuttles those three operations across `postMessage`:
//!
//! ```text
//! main thread (recv loop, dispatch, TickMovement)     net_worker (own wasm)
//!   RemoteSessionProxy                                   WsTransport + Session
//!    ├─ send_action/send_message ─ postMessage(tx) ──▶  session.send_action/…
//!    │                                                  keepalive IntervalStream
//!    └─ recv_message() ◀── postMessage(rx bytes) ─────  session.recv_message()
//! ```
//!
//! The decisive win: the worker runs `session.recv_message()` in its own
//! loop (which **auto-ACKs** every inbound packet — see
//! `session/receive.rs` `queue_ack` + `flush_pending_control_packets`) AND
//! pings on its own `setInterval`-backed timer, all with **zero main-thread
//! involvement**. So even if the main thread is frozen solid for minutes,
//! ACE keeps seeing inbound ACK/ping packets and never times the session
//! out. When the main thread thaws, `recv_message()` drains the buffered
//! inbound bytes and dispatch catches up.
//!
//! # Boundary encoding — no new serde
//! Outbound crosses as the EXISTING wire codec: the proxy packs a
//! `GameMessage` (for an action: `GameMessage::GameAction(GameActionMessage
//! { sequence: 0, action })` — the placeholder sequence is discarded, the
//! worker's own `send_action` re-assigns `game_action_sequence`) via
//! `ProtocolPack` and the worker `ProtocolUnpack`s it. Inbound crosses as
//! the raw decrypted/reassembled game-message payload bytes that
//! `Session::recv_message` already yields as `SessionEvent::Message`.
//! `SessionCommand` / `ClientEvent` / `EntityUpdate` never cross — they stay
//! main-thread — so none of them need serde.

#![cfg(target_arch = "wasm32")]

use std::cell::RefCell;
use std::net::SocketAddr;

use anyhow::{anyhow, Result};
use futures::channel::mpsc;
use futures::StreamExt;
use js_sys::{Function, Uint8Array};
use wasm_bindgen::prelude::*;

use holtburger_protocol::messages::game_action::GameActionMessage;
use holtburger_protocol::messages::{GameAction, GameMessage};
use holtburger_protocol::traits::{ProtocolPack, ProtocolUnpack};
use holtburger_session::{Session, SessionEvent};

// ── boundary "kind" tags ────────────────────────────────────────────────
// Outbound (main → worker), second arg of the outbound sink:
/// bytes = `ProtocolPack` of `GameMessage::GameAction(GameActionMessage{0, action})`.
/// Worker unpacks, extracts `.action`, calls `session.send_action` (re-sequences).
pub const TX_KIND_ACTION: u8 = 0;
/// bytes = `ProtocolPack` of a plain `GameMessage`. Worker calls `session.send_message`.
pub const TX_KIND_MESSAGE: u8 = 1;

// Inbound (worker → main), first arg of the worker's post sink:
/// bytes = one decrypted/reassembled game-message payload (a `SessionEvent::Message`).
pub const RX_KIND_MESSAGE: u8 = 0;
/// bytes = a UTF-8 reason string; the proxy surfaces it as a `recv_message` `Err`.
pub const RX_KIND_DISCONNECT: u8 = 1;
/// bytes = 8-byte little-endian `f64`: the server clock in seconds (ACE
/// `Timers.PortalYearTicks` — seconds since the 2017-01-31 retail sunset,
/// NOT Unix), from the CONNECT handshake time or a TIME_SYNC (0x1000000)
/// optional header. The proxy surfaces it as `SessionEvent::TimeSync` so the
/// main recv loop can stamp `WorldState::set_server_time_sync` — native
/// parity: holtburger-core runtime.rs:118-120.
pub const RX_KIND_TIMESYNC: u8 = 2;

// ════════════════════════════════════════════════════════════════════════
// MAIN THREAD — RemoteSessionProxy + LoopSession + inbound push exports
// ════════════════════════════════════════════════════════════════════════

/// Items pushed from the worker (via JS `onmessage` → `net_proxy_push_*`)
/// into the proxy's inbound channel.
enum InboundItem {
    Message(Vec<u8>),
    TimeSync(f64),
    Disconnect(String),
}

thread_local! {
    /// Sender half of the proxy's inbound channel. Set when a proxy is
    /// constructed; `net_proxy_push_inbound` / `_disconnect` route into it.
    /// One session per page, so a single slot suffices.
    static PROXY_INBOUND_TX: RefCell<Option<mpsc::UnboundedSender<InboundItem>>> =
        const { RefCell::new(None) };
    /// Armed by `net_worker_arm` just before the client calls `start_session`
    /// in worker mode; `start_session` `take`s it to build a proxy instead of
    /// connecting a socket directly. `None` = direct (default) mode.
    static WORKER_ARM: RefCell<Option<Function>> = const { RefCell::new(None) };
}

/// Stands in for `Session` inside the main-thread recv loop. Outbound is
/// posted to the net_worker via `outbound_sink` (a JS fn that does
/// `worker.postMessage`); inbound is awaited off an mpsc fed by
/// `net_proxy_push_inbound`.
pub struct RemoteSessionProxy {
    outbound_sink: Function,
    inbound_rx: mpsc::UnboundedReceiver<InboundItem>,
}

impl RemoteSessionProxy {
    /// Build a proxy and register its inbound sender in the thread-local so
    /// `net_proxy_push_inbound` can reach it.
    pub fn new(outbound_sink: Function) -> Self {
        let (tx, rx) = mpsc::unbounded();
        PROXY_INBOUND_TX.with(|c| *c.borrow_mut() = Some(tx));
        Self {
            outbound_sink,
            inbound_rx: rx,
        }
    }

    fn post(&self, kind: u8, bytes: &[u8]) -> Result<()> {
        let arr = Uint8Array::from(bytes);
        self.outbound_sink
            .call2(&JsValue::NULL, &JsValue::from(kind), &arr)
            .map_err(|e| anyhow!("net proxy outbound sink threw: {e:?}"))?;
        Ok(())
    }

    /// Mirror of `Session::recv_message`: yields the next game-message
    /// payload(s), or `Err` on disconnect (the recv loop then pushes a
    /// `Disconnected` client event and exits — identical to the direct path).
    pub async fn recv_message(&mut self) -> Result<Vec<SessionEvent>> {
        match self.inbound_rx.next().await {
            Some(InboundItem::Message(bytes)) => Ok(vec![SessionEvent::Message(bytes)]),
            Some(InboundItem::TimeSync(t)) => Ok(vec![SessionEvent::TimeSync(t)]),
            Some(InboundItem::Disconnect(reason)) => Err(anyhow!("{reason}")),
            // Channel closed with the sender still registered would be a bug;
            // treat as a disconnect so the loop tears down cleanly.
            None => Err(anyhow!("net worker inbound channel closed")),
        }
    }

    /// Mirror of `Session::send_action`. The worker's `Session` assigns the
    /// real `game_action_sequence`; the `0` here is a discarded placeholder.
    pub async fn send_action(&mut self, action: GameAction) -> Result<()> {
        let gam = GameActionMessage {
            sequence: 0,
            action,
        };
        let mut buf = Vec::new();
        ProtocolPack::pack(&GameMessage::GameAction(Box::new(gam)), &mut buf);
        self.post(TX_KIND_ACTION, &buf)
    }

    /// Mirror of `Session::send_message`.
    pub async fn send_message(&mut self, message: &GameMessage) -> Result<()> {
        let mut buf = Vec::new();
        ProtocolPack::pack(message, &mut buf);
        self.post(TX_KIND_MESSAGE, &buf)
    }
}

/// The recv loop's `session`: either the real `Session` (direct mode,
/// default) or a [`RemoteSessionProxy`]. Exposes exactly the four members
/// the loop touches so the 10k-line loop body is otherwise unchanged.
pub enum LoopSession {
    Direct(Session),
    Proxy(RemoteSessionProxy),
}

impl LoopSession {
    pub async fn recv_message(&mut self) -> Result<Vec<SessionEvent>> {
        match self {
            LoopSession::Direct(s) => s.recv_message().await,
            LoopSession::Proxy(p) => p.recv_message().await,
        }
    }

    pub async fn send_action(&mut self, action: GameAction) -> Result<()> {
        match self {
            LoopSession::Direct(s) => s.send_action(action).await,
            LoopSession::Proxy(p) => p.send_action(action).await,
        }
    }

    pub async fn send_message(&mut self, message: &GameMessage) -> Result<()> {
        match self {
            LoopSession::Direct(s) => s.send_message(message).await,
            LoopSession::Proxy(p) => p.send_message(message).await,
        }
    }

    /// The recv loop's keepalive arm reads this to decide whether to send a
    /// proactive ping. In proxy mode the *worker* owns keepalive, so we
    /// return "just sent" (now) → `elapsed()` is ~0 → the main arm's `> 5s`
    /// gate never fires. The worker's autonomous timer is the sole keepalive.
    pub fn last_send_time(&self) -> web_time::Instant {
        match self {
            LoopSession::Direct(s) => s.last_send_time,
            LoopSession::Proxy(_) => web_time::Instant::now(),
        }
    }
}

// The movement/prediction integrator (`holtburger-core`) sends
// `MoveToState`/`Jump`/`AutonomousPosition` through `&mut dyn ActionSink`.
// `LoopSession` implements it so the same integrator code drives either a
// direct `Session` or the `RemoteSessionProxy` unchanged.
#[async_trait::async_trait(?Send)]
impl holtburger_session::ActionSink for LoopSession {
    async fn send_action(&mut self, action: GameAction) -> Result<()> {
        LoopSession::send_action(self, action).await
    }
}

/// Arm worker mode for the NEXT `start_session` call: `sink(kind, bytes)`
/// posts one outbound wire message to the net_worker. Called by
/// `net_worker_client.js` immediately before `start_session`.
#[wasm_bindgen]
pub fn net_worker_arm(outbound_sink: Function) {
    WORKER_ARM.with(|c| *c.borrow_mut() = Some(outbound_sink));
}

/// Consume the armed outbound sink (if any). `start_session` calls this to
/// decide direct vs. proxy mode.
pub fn take_worker_arm() -> Option<Function> {
    WORKER_ARM.with(|c| c.borrow_mut().take())
}

/// Push one inbound game-message payload from the worker into the proxy.
/// Called by `net_worker_client.js` when the worker posts `{t:'rx', …}`.
#[wasm_bindgen]
pub fn net_proxy_push_inbound(bytes: Vec<u8>) {
    PROXY_INBOUND_TX.with(|c| {
        if let Some(tx) = c.borrow().as_ref() {
            let _ = tx.unbounded_send(InboundItem::Message(bytes));
        }
    });
}

/// Push a server-clock sample (seconds, ACE PortalYearTicks domain) from the
/// worker into the proxy. Called by `net_worker_client.js` on
/// `{t:'timesync', ...}` (worker post kind `RX_KIND_TIMESYNC`).
#[wasm_bindgen]
pub fn net_proxy_push_timesync(server_time: f64) {
    PROXY_INBOUND_TX.with(|c| {
        if let Some(tx) = c.borrow().as_ref() {
            let _ = tx.unbounded_send(InboundItem::TimeSync(server_time));
        }
    });
}

/// Surface a worker-side disconnect/connect-failure to the main recv loop
/// (→ `recv_message` returns `Err` → `Disconnected` event → loop exits →
/// `charlist_tx` drops → a pending `start_session` rejects). Called by
/// `net_worker_client.js` on `{t:'disconnect'|'error', …}`.
#[wasm_bindgen]
pub fn net_proxy_push_disconnect(reason: String) {
    PROXY_INBOUND_TX.with(|c| {
        if let Some(tx) = c.borrow().as_ref() {
            let _ = tx.unbounded_send(InboundItem::Disconnect(reason));
        }
    });
}

// ════════════════════════════════════════════════════════════════════════
// WORKER THREAD — owns WsTransport + Session + autonomous keepalive/ACK
// ════════════════════════════════════════════════════════════════════════

thread_local! {
    /// Sender half of the worker's outbound queue (fed by
    /// `net_worker_submit_outbound`, drained by the worker loop's select).
    static WORKER_OUTBOUND_TX: RefCell<Option<mpsc::UnboundedSender<(u8, Vec<u8>)>>> =
        const { RefCell::new(None) };
    /// `sink(kind, bytes)` posts one message from the worker to the main
    /// thread (`self.postMessage`). Provided by `net_worker.js`.
    static WORKER_SINK: RefCell<Option<Function>> = const { RefCell::new(None) };
}

/// Register the worker→main post sink. Called once by `net_worker.js` after
/// `init()`, before `net_worker_run`.
#[wasm_bindgen]
pub fn net_worker_set_sink(sink: Function) {
    WORKER_SINK.with(|c| *c.borrow_mut() = Some(sink));
}

/// Enqueue one outbound wire message received from the main thread. Called
/// by `net_worker.js` on `{t:'tx', kind, bytes}`.
#[wasm_bindgen]
pub fn net_worker_submit_outbound(kind: u8, bytes: Vec<u8>) {
    WORKER_OUTBOUND_TX.with(|c| {
        if let Some(tx) = c.borrow().as_ref() {
            let _ = tx.unbounded_send((kind, bytes));
        }
    });
}

fn worker_post(kind: u8, bytes: &[u8]) {
    WORKER_SINK.with(|c| {
        if let Some(sink) = c.borrow().as_ref() {
            let arr = Uint8Array::from(bytes);
            let _ = sink.call2(&JsValue::NULL, &JsValue::from(kind), &arr);
        }
    });
}

/// Worker entry: connect the socket, log in, then run the wire loop forever
/// (recv → post inbound; autonomous keepalive ping; drain outbound → send).
/// Returns only on disconnect/error (after posting a disconnect to main).
/// `net_worker.js` calls this fire-and-forget; the returned Promise is the
/// long-running loop task.
#[wasm_bindgen]
pub async fn net_worker_run(
    bridge_url: String,
    server_host: String,
    server_port: u16,
    username: String,
    password: String,
) {
    console_error_panic_hook::set_once();

    let transport =
        match holtburger_transport_ws::WsTransport::connect(&bridge_url, &server_host, server_port, None)
            .await
        {
            Ok(t) => t,
            Err(e) => {
                worker_post(RX_KIND_DISCONNECT, format!("WsTransport::connect: {e}").as_bytes());
                return;
            }
        };
    let ip = transport.server_ip();
    let mut session =
        Session::new_with_transport(Box::new(transport), SocketAddr::new(ip, server_port));

    if let Err(e) = session.send_login_request(&username, &password).await {
        worker_post(RX_KIND_DISCONNECT, format!("send_login_request: {e}").as_bytes());
        return;
    }

    // Outbound queue fed by `net_worker_submit_outbound`.
    let (out_tx, mut out_rx) = mpsc::unbounded::<(u8, Vec<u8>)>();
    WORKER_OUTBOUND_TX.with(|c| *c.borrow_mut() = Some(out_tx));

    // Autonomous keepalive — a worker-owned wall-clock timer that survives a
    // frozen/saturated main thread. 2.5s gives ~24 pings inside ACE's 60s
    // window, so even a lossy freeze keeps the session alive.
    let mut keepalive = gloo_timers::future::IntervalStream::new(2_500);

    loop {
        tokio::select! {
            recv = session.recv_message() => {
                match recv {
                    Ok(events) => {
                        for ev in events {
                            match ev {
                                SessionEvent::Message(bytes) => {
                                    worker_post(RX_KIND_MESSAGE, &bytes);
                                }
                                // P4.2 TIMESYNC (2026-07-27): forward the
                                // server clock instead of dropping it — the
                                // browser otherwise never has a server-time
                                // base and `WorldState::current_server_time`
                                // free-runs on its Unix wall-clock fallback
                                // (~47 years ahead of ACE's PortalYearTicks
                                // domain).
                                SessionEvent::TimeSync(server_time) => {
                                    worker_post(
                                        RX_KIND_TIMESYNC,
                                        &server_time.to_le_bytes(),
                                    );
                                }
                            }
                        }
                    }
                    Err(e) => {
                        worker_post(RX_KIND_DISCONNECT, format!("recv_message: {e}").as_bytes());
                        return;
                    }
                }
            }
            _ = keepalive.next() => {
                // Ping only once the CONNECT handshake has keyed the c2s ISAAC
                // cipher (before that a send would be malformed). Once keyed a
                // ping is always safe: pre-InWorld it's dropped by ACE's inbound
                // state gate but the packet still resets the 60s server timeout.
                if session.isaac_c2s.is_some() {
                    use holtburger_protocol::messages::misc::actions::PingRequestActionData;
                    if let Err(e) = session
                        .send_action(GameAction::PingRequest(Box::new(PingRequestActionData)))
                        .await
                    {
                        log::warn!("net_worker: keepalive PingRequest send failed: {e}");
                    }
                }
            }
            out = out_rx.next() => {
                let Some((kind, bytes)) = out else { return };
                let mut offset = 0;
                let Some(message) = GameMessage::unpack(&bytes, &mut offset) else {
                    log::warn!("net_worker: dropped un-unpackable outbound (kind={kind})");
                    continue;
                };
                let res = if kind == TX_KIND_ACTION {
                    match message {
                        GameMessage::GameAction(gam) => session.send_action(gam.action).await,
                        // Shouldn't happen (action kind always packs a GameAction),
                        // but send it verbatim rather than silently dropping.
                        other => session.send_message(&other).await,
                    }
                } else {
                    session.send_message(&message).await
                };
                if let Err(e) = res {
                    log::warn!("net_worker: outbound send failed: {e}");
                }
            }
        }
    }
}
