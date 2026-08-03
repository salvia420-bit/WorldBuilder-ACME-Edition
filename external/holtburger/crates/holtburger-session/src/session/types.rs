use crate::capture::CaptureWriter;
use anyhow::{Result, anyhow};
pub use async_trait::async_trait;
use holtburger_protocol::crypto::Isaac;
use holtburger_protocol::messages::*;
use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::time::Duration;
// `web_time::Instant` is `std::time::Instant` on native and a
// `performance.now()`-backed shim on wasm32 — needed because
// `std::time::Instant::now()` panics on `wasm32-unknown-unknown`.
use web_time::Instant;

#[cfg(not(target_arch = "wasm32"))]
use tokio::net::UdpSocket;

pub(crate) const MAX_CACHED_PACKETS: usize = 512;
/// Rust review 2026-08-03 (F-sweep): hard ceiling on the out-of-order S2C
/// reorder buffer (`Session::pending_server_packets`).
///
/// The C2S retransmit cache has always had [`MAX_CACHED_PACKETS`]; its inbound
/// twin had NO bound at all, so a server (or anything that can pass the
/// checksum) streaming ever-higher sequence numbers grew the map without limit
/// for the ~180 s it takes [`RETRANSMIT_GIVE_UP_REQUESTS`] to fire at the 1 Hz
/// request cadence. `MAX_RETRANSMIT_SEQUENCE_WINDOW + 2` is the real bound:
/// `send_request_retransmit` refuses a gap wider than the window, so a packet
/// further ahead than that can never be ordered and buffering it is pure waste.
pub(crate) const MAX_PENDING_SERVER_PACKETS: usize =
    MAX_RETRANSMIT_SEQUENCE_WINDOW as usize + 2;
pub(crate) const MAX_RETRANSMIT_SEQUENCE_IDS: usize = 115;
/// Rust review 2026-08-03 (F-sweep): per-group slot ceiling for the inbound
/// fragment reassembler (`Session::process_fragment`).
///
/// `FragmentHeader::count` is a wire `u16`, so one 16-byte fragment header could
/// reserve 65535 `Option<Vec<u8>>` slots (~768 KB on wasm32) for a message that
/// never completes; combined with `MAX_PENDING_FRAGMENT_GROUPS` (256) that is
/// ~200 MB of bookkeeping an attacker gets for ~4 KB of traffic.
///
/// 16384 fragments x `MAX_FRAGMENT_PAYLOAD` (448 B) = a ~7 MB reassembled
/// message, which is far above anything the AC protocol actually sends (the
/// largest real S2C blobs — character list, allegiance roster, DDD chunks — are
/// well under 1 MB). Tune upward if a legitimate transfer is ever seen to
/// exceed it; the rejection is logged at `warn`.
pub(crate) const MAX_FRAGMENTS_PER_MESSAGE: usize = 16384;
pub(crate) const MAX_RETRANSMIT_SEQUENCE_WINDOW: u32 = 256;
pub(crate) const REQUEST_RETRANSMIT_INTERVAL: Duration = Duration::from_secs(1);
// conn-fix (2026-07-18): give-up ceiling for consecutive retransmit
// requests with zero ordering progress (~3 min at the 1 Hz cadence).
// A healthy server answers a retransmit request within a round-trip;
// a server that ignores 180 in a row has dropped this session.
pub(crate) const RETRANSMIT_GIVE_UP_REQUESTS: u32 = 180;
pub(crate) const DEFAULT_LOGIN_PROTOCOL_VERSION: &str = "1802";

// `Transport` is cfg-split between native (Send + Sync, async-trait Send
// futures) and wasm32 (no thread bounds, async-trait `?Send` futures).
// The browser is single-threaded and `wasm-bindgen-futures` returns
// `!Send` futures from JS-interop calls (`web_sys::WebSocket` callbacks,
// Closure-bridged event handlers), so requiring Send on the wasm path
// would make `WsTransport` (Phase 2 of emit-dynamic-site) unimplementable.
// Native sessions retain the Send + Sync bound — nothing in the codebase
// spawns a Session across threads today, but keeping the contract avoids
// quietly weakening it for native callers.
#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
pub trait Transport: Send + Sync {
    async fn send_to(&self, buf: &[u8], addr: SocketAddr) -> Result<usize>;
    async fn recv_from(&self, buf: &mut [u8]) -> Result<(usize, SocketAddr)>;
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
pub trait Transport {
    async fn send_to(&self, buf: &[u8], addr: SocketAddr) -> Result<usize>;
    async fn recv_from(&self, buf: &mut [u8]) -> Result<(usize, SocketAddr)>;
}

// `ActionSink` — the minimal "can send a `GameAction`" capability the
// client-side movement/prediction integrator (`holtburger-core`'s
// `MovementSystem`/`TickSpine`) needs from a session. Introduced for the
// transport-in-worker port: the movement methods used to take a concrete
// `&mut Session`, but under `?netWorker` the real `Session` lives in a Web
// Worker and the main-thread recv loop drives a `RemoteSessionProxy`
// instead. Both implement `ActionSink`, so the movement methods take
// `&mut dyn ActionSink` and neither cares which is behind it. The movement
// runtime path uses ONLY `send_action` (verified: no `Session` field reads
// in `movement/system.rs`, `tick_spine.rs`, `simulation.rs`,
// `movement/handle.rs`), so a one-method trait suffices. Cfg-split Send
// exactly like `Transport`: native futures stay `Send` (the CLI's tokio
// runtime), wasm is single-threaded `?Send`.
#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
pub trait ActionSink: Send {
    async fn send_action(&mut self, action: GameAction) -> Result<()>;
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
pub trait ActionSink {
    async fn send_action(&mut self, action: GameAction) -> Result<()>;
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
impl ActionSink for Session {
    async fn send_action(&mut self, action: GameAction) -> Result<()> {
        // Inherent `Session::send_action` (send.rs), not this trait method.
        Session::send_action(self, action).await
    }
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
impl ActionSink for Session {
    async fn send_action(&mut self, action: GameAction) -> Result<()> {
        Session::send_action(self, action).await
    }
}

// UDP-backed Transport is native-only — wasm32 builds plug in their own
// (e.g. `WsTransport` in Phase 2 of emit-dynamic-site) via
// `Session::new_with_transport`.
#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
impl Transport for UdpSocket {
    async fn send_to(&self, buf: &[u8], addr: SocketAddr) -> Result<usize> {
        self.send_to(buf, addr).await.map_err(|e| anyhow!(e))
    }

    async fn recv_from(&self, buf: &mut [u8]) -> Result<(usize, SocketAddr)> {
        self.recv_from(buf).await.map_err(|e| anyhow!(e))
    }
}

pub struct MockTransport;

#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
impl Transport for MockTransport {
    async fn send_to(&self, _buf: &[u8], _addr: SocketAddr) -> Result<usize> {
        Ok(0)
    }

    async fn recv_from(&self, _buf: &mut [u8]) -> Result<(usize, SocketAddr)> {
        Err(anyhow!("Mock transport"))
    }
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
impl Transport for MockTransport {
    async fn send_to(&self, _buf: &[u8], _addr: SocketAddr) -> Result<usize> {
        Ok(0)
    }

    async fn recv_from(&self, _buf: &mut [u8]) -> Result<(usize, SocketAddr)> {
        Err(anyhow!("Mock transport"))
    }
}

#[derive(Debug)]
pub struct PendingMessage {
    pub count: u16,
    pub fragments: Vec<Option<Vec<u8>>>,
    pub received_count: u16,
}

#[derive(Clone, Debug)]
pub(crate) struct CachedPacket {
    pub(crate) addr: SocketAddr,
    pub(crate) bytes: Vec<u8>,
}

#[derive(Clone, Debug)]
pub(crate) struct ReceivedPacket {
    pub(crate) header: PacketHeader,
    pub(crate) data: Vec<u8>,
}

#[derive(Clone, Debug)]
pub(crate) enum PendingControlPacketData {
    Prebuilt(Vec<u8>),
    DeferredCleartext {
        header: PacketHeader,
        payload: Vec<u8>,
        use_current_sequence: bool,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct PendingControlPacket {
    pub(crate) addr: SocketAddr,
    pub(crate) ready_at: Instant,
    pub(crate) data: PendingControlPacketData,
}

#[derive(Debug)]
pub enum SessionEvent {
    Message(Vec<u8>),
    TimeSync(f64),
}

pub struct Session {
    pub(crate) transport: Box<dyn Transport>,
    pub server_addr: SocketAddr,
    pub(crate) server_source_addr: SocketAddr,
    pub(crate) pending_server_source_addr: Option<SocketAddr>,
    pub isaac_c2s: Option<Isaac>,
    pub isaac_s2c: Option<Isaac>,
    pub packet_sequence: u32,
    pub fragment_sequence: u32,
    pub(crate) fragment_id: u32,
    pub(crate) connection_cookie: u64,
    pub client_id: u16,
    pub last_server_seq: u32,
    pub has_server_seq: bool,
    pub fragment_reassembler: HashMap<u32, PendingMessage>,
    pub(crate) pending_server_packets: BTreeMap<u32, ReceivedPacket>,
    pub(crate) pending_control_packets: Vec<PendingControlPacket>,
    pub(crate) last_request_retransmit_time: Option<Instant>,
    // conn-fix (2026-07-18): consecutive retransmit requests issued
    // without any ordering progress. Reset whenever an ordered packet
    // finalizes; when it exceeds RETRANSMIT_GIVE_UP_REQUESTS the
    // session errors out instead of re-requesting at 1 Hz forever
    // (booted/zombie sessions used to flood ACE indefinitely).
    pub(crate) retransmit_requests_since_progress: u32,
    pub(crate) cached_packets: BTreeMap<u32, CachedPacket>,
    pub capture: Option<CaptureWriter>,
    pub game_action_sequence: u32,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub last_recv_time: Instant,
    pub last_send_time: Instant,
}
