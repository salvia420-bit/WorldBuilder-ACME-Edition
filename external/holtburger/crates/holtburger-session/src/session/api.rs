use super::types::{MockTransport, Session, Transport};
use anyhow::Result;
use std::collections::{BTreeMap, HashMap};

#[cfg(not(target_arch = "wasm32"))]
use socket2::SockRef;

#[cfg(not(target_arch = "wasm32"))]
const UDP_RECV_BUFFER_SIZE_BYTES: usize = 2 * 1024 * 1024;

// The UDP-backed `Session::new` is native-only. Wasm32 callers construct a
// session via `Session::new_with_transport` with a non-UDP transport
// (Phase 2 of emit-dynamic-site uses `WsTransport`). Splitting it into its
// own impl block lets the rest of the constructors compile unconditionally.
#[cfg(not(target_arch = "wasm32"))]
impl Session {
    /// Build a Session that owns a fresh UDP socket bound to `0.0.0.0:0`.
    /// This is the production path for the native `holtburger-cli` and any
    /// other UDP-direct caller.
    pub async fn new(server_addr: std::net::SocketAddr) -> Result<Self> {
        let socket = tokio::net::UdpSocket::bind("0.0.0.0:0").await?;
        if let Err(err) = SockRef::from(&socket).set_recv_buffer_size(UDP_RECV_BUFFER_SIZE_BYTES) {
            log::warn!(
                "failed to set UDP receive buffer size to {} bytes: {}",
                UDP_RECV_BUFFER_SIZE_BYTES,
                err
            );
        }
        Ok(Self::new_with_transport(Box::new(socket), server_addr))
    }
}

impl Session {
    /// Build a Session over a caller-provided transport. Initial state is
    /// identical to [`Self::new`]; only the transport differs.
    ///
    /// Used today by tests via [`Self::new_test`] and intended in the
    /// near future by the WASM client (Phase 2 of `emit-dynamic-site`),
    /// which will pass a `WsTransport` so the session can run in a browser
    /// with no UDP socket of its own.
    pub fn new_with_transport(
        transport: Box<dyn Transport>,
        server_addr: std::net::SocketAddr,
    ) -> Self {
        Self {
            transport,
            server_addr,
            server_source_addr: server_addr,
            pending_server_source_addr: None,
            isaac_c2s: None,
            isaac_s2c: None,
            packet_sequence: 0,
            fragment_sequence: 1,
            fragment_id: 1,
            connection_cookie: 0,
            client_id: 0,
            last_server_seq: 1,
            has_server_seq: false,
            fragment_reassembler: HashMap::new(),
            pending_server_packets: BTreeMap::new(),
            pending_control_packets: Vec::new(),
            last_request_retransmit_time: None,
            cached_packets: BTreeMap::new(),
            capture: None,
            game_action_sequence: 0,
            bytes_in: 0,
            bytes_out: 0,
            last_recv_time: std::time::Instant::now(),
            last_send_time: std::time::Instant::now(),
        }
    }

    pub fn set_capture(&mut self, path: &str) -> Result<()> {
        self.capture = Some(crate::capture::CaptureWriter::create(path)?);
        Ok(())
    }

    pub fn new_test() -> Self {
        // Same defaults as `new_with_transport` but with `packet_sequence`
        // bumped to 1 so test-side send paths exercise non-zero sequence
        // handling without first running the handshake (which `auth.rs:39`
        // would normally use to set the sequence to 2).
        let mut session = Self::new_with_transport(
            Box::new(MockTransport),
            "127.0.0.1:9000".parse().unwrap(),
        );
        session.packet_sequence = 1;
        session
    }
}
