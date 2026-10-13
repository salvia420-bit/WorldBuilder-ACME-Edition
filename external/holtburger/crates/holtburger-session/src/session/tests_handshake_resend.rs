//! net-transport-3 (2026-10-13): handshake robustness. The ConnectResponse is
//! re-sent every 1/3 s until the server's first real packet (retail
//! `ClientNet::ProcessConnection` case 4, acclient.c:372867), a duplicated
//! ConnectRequest no longer re-keys ISAAC, and the LoginRequest is still sent
//! exactly once (a second one breaks vanilla ACE). Kept in its own module so
//! the helpers stay local; they mirror the ones in `tests.rs`.

use super::types::CONNECT_RESPONSE_RESEND_INTERVAL;
use super::{Session, SessionEvent, Transport};
use anyhow::Result;
use async_trait::async_trait;
use byteorder::{ByteOrder, LittleEndian};
use holtburger_protocol::crypto::Isaac;
use holtburger_protocol::messages::transport::{self, packet_flags};
use holtburger_protocol::messages::*;
use holtburger_protocol::traits::{ProtocolPack, ProtocolUnpack};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, mpsc};
use web_time::Instant;

const SERVER: &str = "127.0.0.1:9000";
const ACTIVATION: &str = "127.0.0.1:9001";
const COOKIE: u64 = 0x1122_3344_5566_7788;
const SERVER_SEED: u32 = 0x1234_5678;
const CLIENT_SEED: u32 = 0x9ABC_DEF0;

type SentEntry = (Instant, SocketAddr, Vec<u8>);
type Inbound = mpsc::UnboundedSender<Vec<u8>>;

/// Delivers whatever the test pushes into its channel, then waits forever (a
/// server that has gone quiet), so the receive loop can only wake on its own
/// timers. Every send and every delivery is time-stamped.
#[derive(Clone)]
struct GatedTransport {
    sent: Arc<Mutex<Vec<SentEntry>>>,
    delivered_at: Arc<Mutex<Vec<Instant>>>,
    inbound: Arc<Mutex<mpsc::UnboundedReceiver<Vec<u8>>>>,
}

impl GatedTransport {
    async fn sent_packets(&self) -> Vec<SentEntry> {
        self.sent.lock().await.clone()
    }

    async fn connect_responses(&self) -> Vec<SentEntry> {
        self.sent
            .lock()
            .await
            .iter()
            .filter(|(_, _, bytes)| is_connect_response(bytes))
            .cloned()
            .collect()
    }

    async fn delivered_at(&self) -> Vec<Instant> {
        self.delivered_at.lock().await.clone()
    }
}

#[async_trait]
impl Transport for GatedTransport {
    async fn send_to(&self, buf: &[u8], addr: SocketAddr) -> Result<usize> {
        let entry = (Instant::now(), addr, buf.to_vec());
        self.sent.lock().await.push(entry);
        Ok(buf.len())
    }

    async fn recv_from(&self, buf: &mut [u8]) -> Result<(usize, SocketAddr)> {
        let mut inbound = self.inbound.lock().await;
        let Some(data) = inbound.recv().await else {
            return std::future::pending::<Result<(usize, SocketAddr)>>().await;
        };
        buf[..data.len()].copy_from_slice(&data);
        self.delivered_at.lock().await.push(Instant::now());
        Ok((data.len(), SERVER.parse().unwrap()))
    }
}

/// A session built like production (`new_with_transport`, packet sequence 0)
/// over a [`GatedTransport`], plus the sender that feeds it server packets.
fn gated_session() -> (Session, GatedTransport, Inbound) {
    let (inbound_tx, inbound_rx) = mpsc::unbounded_channel();
    let transport = GatedTransport {
        sent: Arc::new(Mutex::new(Vec::new())),
        delivered_at: Arc::new(Mutex::new(Vec::new())),
        inbound: Arc::new(Mutex::new(inbound_rx)),
    };
    let handle = transport.clone();
    let server_addr = SERVER.parse().unwrap();
    let session = Session::new_with_transport(Box::new(transport), server_addr);
    (session, handle, inbound_tx)
}

/// Queue one server packet for the session to receive.
fn push(inbound: &Inbound, packet: Vec<u8>) {
    inbound.send(packet).expect("the session holds the receiver");
}

/// The server times of the TimeSync events, in order.
fn time_syncs(events: &[SessionEvent]) -> Vec<f64> {
    events
        .iter()
        .filter_map(|event| match event {
            SessionEvent::TimeSync(time) => Some(*time),
            SessionEvent::Message(_) => None,
        })
        .collect()
}

fn connect_request(cookie: u64, server_seed: u32, client_seed: u32) -> ConnectRequestData {
    ConnectRequestData {
        time: 123.5,
        cookie,
        client_id: 0x345,
        server_seed,
        client_seed,
    }
}

/// A cleartext S2C packet with a valid plain checksum.
fn build_transport_packet(header: PacketHeader, payload: &[u8]) -> Vec<u8> {
    let session = Session::new_test();
    let mut header = header;
    header.size = payload.len() as u16;
    let payload_hash = session
        .calculate_payload_hash(header.flags, payload)
        .unwrap();
    header.checksum = header.calculate_checksum().wrapping_add(payload_hash);

    let mut packet = Vec::new();
    header.pack(&mut packet);
    packet.extend_from_slice(payload);
    packet
}

/// An S2C packet with an encrypted checksum keyed by `key`, the way ACE signs
/// every packet after the handshake.
fn build_encrypted_packet(header: PacketHeader, payload: &[u8], key: u32) -> Vec<u8> {
    let session = Session::new_test();
    let mut header = header;
    header.flags |= packet_flags::ENCRYPTED_CHECKSUM;
    header.size = payload.len() as u16;
    let payload_hash = session
        .calculate_payload_hash(header.flags, payload)
        .unwrap();
    let keyed_hash = payload_hash ^ key;
    header.checksum = header.calculate_checksum().wrapping_add(keyed_hash);

    let mut packet = Vec::new();
    header.pack(&mut packet);
    packet.extend_from_slice(payload);
    packet
}

fn build_connect_request_packet(connect_request: &ConnectRequestData) -> Vec<u8> {
    let mut payload = vec![0u8; transport::CONNECT_REQUEST_SIZE];
    LittleEndian::write_f64(&mut payload[0..8], connect_request.time);
    LittleEndian::write_u64(&mut payload[8..16], connect_request.cookie);
    LittleEndian::write_u32(&mut payload[16..20], u32::from(connect_request.client_id));
    LittleEndian::write_u32(&mut payload[20..24], connect_request.server_seed);
    LittleEndian::write_u32(&mut payload[24..28], connect_request.client_seed);

    build_transport_packet(
        PacketHeader {
            flags: packet_flags::CONNECT_REQUEST,
            ..Default::default()
        },
        &payload,
    )
}

/// ACE's first packet once it has matched the ConnectResponse: an encrypted
/// TimeSync (`sendResync`), signed with the first S2C ISAAC key.
fn build_first_time_sync_packet(server_time: f64) -> Vec<u8> {
    let key = Isaac::new(SERVER_SEED).current_key;
    build_encrypted_packet(
        PacketHeader {
            sequence: 2,
            flags: packet_flags::TIME_SYNC,
            ..Default::default()
        },
        &server_time.to_le_bytes(),
        key,
    )
}

/// ACE's timer ACK: cleartext, `AckSequence` only, sent ~2 s into a session
/// whatever its state (NetworkSession.cs `nextAck`).
fn build_bare_ack_packet(borrowed_sequence: u32, acked: u32) -> Vec<u8> {
    build_transport_packet(
        PacketHeader {
            sequence: borrowed_sequence,
            flags: packet_flags::ACK_SEQUENCE,
            ..Default::default()
        },
        &acked.to_le_bytes(),
    )
}

fn unpack_header(packet: &[u8]) -> PacketHeader {
    let mut offset = 0;
    PacketHeader::unpack(packet, &mut offset).expect("packet header should unpack")
}

fn is_connect_response(packet: &[u8]) -> bool {
    (unpack_header(packet).flags & packet_flags::CONNECT_RESPONSE) != 0
}

/// (a) No server packet after the handshake: the ConnectResponse goes out at
/// ~200 ms and again every 333 ms (~533, ~866 ms), byte-identical, to the
/// activation port, with no cap.
#[tokio::test]
async fn test_connect_response_is_resent_every_333ms_until_the_server_answers() {
    let request = connect_request(COOKIE, SERVER_SEED, CLIENT_SEED);
    let (mut session, handle, inbound) = gated_session();
    push(&inbound, build_connect_request_packet(&request));

    let before = Instant::now();
    let events = session.recv_message().await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(time_syncs(&events), [request.time]);
    assert!(session.next_handshake_deadline().is_some());

    let window = Duration::from_millis(1000);
    let waited = tokio::time::timeout(window, session.recv_message()).await;
    assert!(waited.is_err(), "nothing else arrived, so recv is still waiting");

    let responses = handle.connect_responses().await;
    // Nominally ~200, ~533 and ~866 ms. Each send is timed from the previous
    // real send, so a fourth cannot fit inside the 1 s window.
    let count = responses.len();
    assert!((2..=3).contains(&count), "expected 2-3 ConnectResponses, got {count}");

    let race_delay = Duration::from_millis(transport::ACE_HANDSHAKE_RACE_DELAY_MS);
    let first_delay = responses[0].0.duration_since(before);
    assert!(first_delay >= race_delay, "the first send keeps the 200 ms delay");
    for pair in responses.windows(2) {
        let gap = pair[1].0.duration_since(pair[0].0);
        assert!(gap >= CONNECT_RESPONSE_RESEND_INTERVAL, "re-sent after {gap:?}");
        assert_eq!(pair[1].2, pair[0].2, "a re-send is the same packet");
    }

    let activation: SocketAddr = ACTIVATION.parse().unwrap();
    for (_, addr, bytes) in &responses {
        assert_eq!(*addr, activation);
        let header = unpack_header(bytes);
        assert_eq!(header.flags, packet_flags::CONNECT_RESPONSE);
        assert_eq!(header.sequence, 1);
        assert_eq!(header.size, transport::CONNECT_RESPONSE_SIZE as u16);
        let cookie = LittleEndian::read_u64(&bytes[transport::HEADER_SIZE..]);
        assert_eq!(cookie, COOKIE);
    }

    // Nothing was ordered, so the ConnectResponses are all that went out.
    assert_eq!(handle.sent_packets().await.len(), count);
    // Still unanswered, so the timer stays armed.
    assert!(session.next_handshake_deadline().is_some());
}

/// (b) The first validated server packet that is not a ConnectRequest (ACE's
/// encrypted TimeSync, ~700 ms in) stops the re-sends for good.
#[tokio::test]
async fn test_first_server_packet_stops_connect_response_resends() {
    let request = connect_request(COOKIE, SERVER_SEED, CLIENT_SEED);
    let (mut session, handle, inbound) = gated_session();
    push(&inbound, build_connect_request_packet(&request));
    session.recv_message().await.unwrap();

    let time_sync = build_first_time_sync_packet(1.25);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(700)).await;
        push(&inbound, time_sync);
    });

    let window = Duration::from_millis(3000);
    let events = tokio::time::timeout(window, session.recv_message())
        .await
        .expect("the TimeSync should be delivered")
        .unwrap();
    assert_eq!(time_syncs(&events), [1.25]);
    assert_eq!(session.last_server_seq, 2);
    assert!(session.next_handshake_deadline().is_none());

    // Keep the loop running across several would-be re-send slots.
    let window = Duration::from_millis(1200);
    let waited = tokio::time::timeout(window, session.recv_message()).await;
    assert!(waited.is_err());

    let delivered = handle.delivered_at().await;
    assert_eq!(delivered.len(), 2);
    let time_sync_at = delivered[1];
    let responses = handle.connect_responses().await;
    // ~200 ms and ~533 ms, both before the TimeSync landed; none after it.
    assert!(!responses.is_empty());
    for (sent_at, _, _) in &responses {
        assert!(*sent_at < time_sync_at, "a ConnectResponse followed the TimeSync");
    }
}

/// (c) A duplicated ConnectRequest datagram must not re-key either ISAAC
/// stream, reset the packet sequence or queue another ConnectResponse, and
/// yields no TimeSync.
#[tokio::test]
async fn test_duplicate_connect_request_does_not_rekey_or_requeue() {
    let request = connect_request(COOKIE, SERVER_SEED, CLIENT_SEED);
    let (mut session, handle, inbound) = gated_session();
    push(&inbound, build_connect_request_packet(&request));
    push(&inbound, build_connect_request_packet(&request));

    let first = session.recv_message().await.unwrap();
    assert_eq!(time_syncs(&first), [request.time]);
    let keyed_c2s = Isaac::new(CLIENT_SEED).current_key;
    assert_eq!(session.isaac_c2s.as_ref().unwrap().current_key, keyed_c2s);
    assert_eq!(session.packet_sequence, 2);
    let resend_at = session.next_handshake_deadline();
    assert!(resend_at.is_some());

    // Move the session on, as if C2S packets had gone out since.
    session.packet_sequence = 7;
    session.isaac_c2s.as_mut().unwrap().consume_key();
    let c2s_key = session.isaac_c2s.as_ref().unwrap().current_key;
    let s2c_key = session.isaac_s2c.as_ref().unwrap().current_key;

    let second = session.recv_message().await.unwrap();
    assert!(second.is_empty(), "a duplicate carries no TimeSync");
    assert_eq!(session.isaac_c2s.as_ref().unwrap().current_key, c2s_key);
    assert_eq!(session.isaac_s2c.as_ref().unwrap().current_key, s2c_key);
    assert_eq!(session.packet_sequence, 7);
    assert_eq!(session.connection_cookie, COOKIE);
    assert_eq!(session.next_handshake_deadline(), resend_at);

    // Exactly one ConnectResponse exists, still queued or already sent.
    let queued = session.pending_control_packets.len();
    let sent = handle.connect_responses().await.len();
    assert_eq!(queued + sent, 1);
}

/// A ConnectRequest with a NEW cookie is still a fresh handshake: both ISAAC
/// streams are re-keyed from its seeds and the re-send timer is re-armed.
#[tokio::test]
async fn test_connect_request_with_new_cookie_is_a_fresh_handshake() {
    let first = connect_request(COOKIE, SERVER_SEED, CLIENT_SEED);
    let second = connect_request(COOKIE + 1, 0x0BAD_F00D, 0x0D15_EA5E);
    let (mut session, _handle, inbound) = gated_session();
    push(&inbound, build_connect_request_packet(&first));
    push(&inbound, build_connect_request_packet(&second));

    session.recv_message().await.unwrap();
    session.packet_sequence = 7;

    let events = session.recv_message().await.unwrap();
    assert_eq!(time_syncs(&events), [second.time]);
    assert_eq!(session.connection_cookie, COOKIE + 1);
    let c2s_key = Isaac::new(0x0D15_EA5E).current_key;
    let s2c_key = Isaac::new(0x0BAD_F00D).current_key;
    assert_eq!(session.isaac_c2s.as_ref().unwrap().current_key, c2s_key);
    assert_eq!(session.isaac_s2c.as_ref().unwrap().current_key, s2c_key);
    assert_eq!(session.packet_sequence, 2);
    assert!(session.next_handshake_deadline().is_some());
}

/// ACE sends a bare cleartext ACK ~2 s into every session, even while DoLogin
/// is still running, so it must not end the re-sends. The encrypted TimeSync
/// ACE sends once it has matched the ConnectResponse does.
#[tokio::test]
async fn test_bare_ack_keeps_resending_but_time_sync_stops_it() {
    let request = connect_request(COOKIE, SERVER_SEED, CLIENT_SEED);
    let (mut session, _handle, inbound) = gated_session();
    push(&inbound, build_connect_request_packet(&request));
    push(&inbound, build_bare_ack_packet(0, 1));
    push(&inbound, build_first_time_sync_packet(1.25));

    session.recv_message().await.unwrap();
    assert!(session.next_handshake_deadline().is_some());

    let after_ack = session.recv_message().await.unwrap();
    assert!(after_ack.is_empty());
    // A bare ACK does not prove the server accepted the ConnectResponse.
    assert!(session.next_handshake_deadline().is_some());

    let after_sync = session.recv_message().await.unwrap();
    assert_eq!(time_syncs(&after_sync), [1.25]);
    assert!(session.next_handshake_deadline().is_none());
}

/// (d) Deliberately not retail: the LoginRequest goes out exactly once, with
/// no 2 s re-send (see `Session::send_login_request`). Nothing is armed before
/// the ConnectRequest, so a silent server leaves the loop blocked on the
/// socket.
#[tokio::test]
async fn test_login_request_is_sent_exactly_once() {
    let (mut session, handle, _inbound) = gated_session();
    session.send_login_request("acct", "secret").await.unwrap();
    assert!(session.next_handshake_deadline().is_none());

    // Past retail's 2 s `ClientNet::LogonUseTime` re-send.
    let window = Duration::from_millis(2500);
    let waited = tokio::time::timeout(window, session.recv_message()).await;
    assert!(waited.is_err());

    let sent = handle.sent_packets().await;
    assert_eq!(sent.len(), 1, "one LoginRequest and nothing else");
    let (_, addr, bytes) = &sent[0];
    assert_eq!(*addr, SERVER.parse::<SocketAddr>().unwrap());
    let header = unpack_header(bytes);
    assert_ne!(header.flags & packet_flags::LOGIN_REQUEST, 0);
    assert_eq!(header.sequence, 0);
}
