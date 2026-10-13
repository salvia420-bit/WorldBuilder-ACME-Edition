use super::{Session, SessionEvent, Transport};
use anyhow::{Result, anyhow};
use async_trait::async_trait;
use byteorder::{ByteOrder, LittleEndian};
use holtburger_protocol::messages::transport::{self, packet_flags};
use holtburger_protocol::messages::*;
use holtburger_protocol::traits::{ProtocolPack, ProtocolUnpack};
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::Mutex;

type SentPacket = (SocketAddr, Vec<u8>);
type RecvPacket = (Vec<u8>, SocketAddr);
type RecvQueue = Arc<Mutex<VecDeque<RecvPacket>>>;

#[derive(Clone)]
struct ScriptedTransport {
    sent: Arc<Mutex<Vec<SentPacket>>>,
    recv: Arc<Mutex<Vec<Vec<u8>>>>,
    recv_addr: SocketAddr,
}

impl ScriptedTransport {
    fn new(recv_packets: Vec<Vec<u8>>, recv_addr: SocketAddr) -> Self {
        Self {
            sent: Arc::new(Mutex::new(Vec::new())),
            recv: Arc::new(Mutex::new(recv_packets)),
            recv_addr,
        }
    }

    async fn sent_packets(&self) -> Vec<Vec<u8>> {
        self.sent
            .lock()
            .await
            .iter()
            .map(|(_, bytes)| bytes.clone())
            .collect()
    }

    async fn sent_entries(&self) -> Vec<(SocketAddr, Vec<u8>)> {
        self.sent.lock().await.clone()
    }
}

#[async_trait]
impl Transport for ScriptedTransport {
    async fn send_to(&self, buf: &[u8], addr: SocketAddr) -> Result<usize> {
        self.sent.lock().await.push((addr, buf.to_vec()));
        Ok(buf.len())
    }

    async fn recv_from(&self, buf: &mut [u8]) -> Result<(usize, SocketAddr)> {
        let mut recv = self.recv.lock().await;
        if recv.is_empty() {
            return Err(anyhow!("Empty"));
        }

        let data = recv.remove(0);
        buf[..data.len()].copy_from_slice(&data);
        Ok((data.len(), self.recv_addr))
    }
}

#[derive(Clone)]
struct SequencedTransport {
    sent: Arc<Mutex<Vec<SentPacket>>>,
    recv: RecvQueue,
}

impl SequencedTransport {
    fn new(recv_packets: Vec<(Vec<u8>, SocketAddr)>) -> Self {
        Self {
            sent: Arc::new(Mutex::new(Vec::new())),
            recv: Arc::new(Mutex::new(recv_packets.into_iter().collect())),
        }
    }
}

#[async_trait]
impl Transport for SequencedTransport {
    async fn send_to(&self, buf: &[u8], addr: SocketAddr) -> Result<usize> {
        self.sent.lock().await.push((addr, buf.to_vec()));
        Ok(buf.len())
    }

    async fn recv_from(&self, buf: &mut [u8]) -> Result<(usize, SocketAddr)> {
        let mut recv = self.recv.lock().await;
        if let Some((data, addr)) = recv.pop_front() {
            buf[..data.len()].copy_from_slice(&data);
            Ok((data.len(), addr))
        } else {
            Err(anyhow!("Empty"))
        }
    }
}

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

fn unpack_header(packet: &[u8]) -> PacketHeader {
    let mut offset = 0;
    PacketHeader::unpack(packet, &mut offset).expect("packet header should unpack")
}

fn build_connect_request_packet(connect_request: ConnectRequestData) -> Vec<u8> {
    let mut payload = vec![0u8; transport::CONNECT_REQUEST_SIZE];
    LittleEndian::write_f64(&mut payload[0..8], connect_request.time);
    LittleEndian::write_u64(&mut payload[8..16], connect_request.cookie);
    LittleEndian::write_u32(&mut payload[16..20], u32::from(connect_request.client_id));
    LittleEndian::write_u32(&mut payload[20..24], connect_request.server_seed);
    LittleEndian::write_u32(&mut payload[24..28], connect_request.client_seed);

    build_transport_packet(
        PacketHeader {
            flags: packet_flags::CONNECT_REQUEST,
            size: payload.len() as u16,
            ..Default::default()
        },
        &payload,
    )
}

fn build_connect_response_packet(cookie: u64, client_id: u16) -> Vec<u8> {
    build_transport_packet(
        PacketHeader {
            flags: packet_flags::CONNECT_RESPONSE,
            id: client_id,
            size: transport::CONNECT_RESPONSE_SIZE as u16,
            ..Default::default()
        },
        &cookie.to_le_bytes(),
    )
}

fn build_single_fragment_packet(sequence: u32, payload: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    FragmentHeader {
        sequence: 1,
        id: 1,
        count: 1,
        index: 0,
        size: (transport::FRAGMENT_HEADER_SIZE + payload.len()) as u16,
        queue: transport::queues::GENERAL,
    }
    .pack(&mut body);
    body.extend_from_slice(payload);

    build_transport_packet(
        PacketHeader {
            sequence,
            flags: packet_flags::BLOB_FRAGMENTS,
            size: body.len() as u16,
            ..Default::default()
        },
        &body,
    )
}

#[tokio::test]
async fn test_payload_offset_handshake() {
    let session = Session::new("127.0.0.1:9000".parse().unwrap())
        .await
        .unwrap();

    assert_eq!(
        session.get_payload_offset(packet_flags::CONNECT_RESPONSE, &[0u8; 100]),
        8
    );

    assert_eq!(
        session.get_payload_offset(
            packet_flags::ACK_SEQUENCE | packet_flags::CONNECT_RESPONSE,
            &[0u8; 100]
        ),
        12
    );

    assert_eq!(
        session.get_payload_offset(packet_flags::ECHO_RESPONSE, &[0u8; 100]),
        8
    );
}

#[tokio::test]
async fn test_payload_hash_handshake() {
    let session = Session::new("127.0.0.1:9000".parse().unwrap())
        .await
        .unwrap();

    let payload = vec![1u8; 32];
    let hash = session
        .calculate_payload_hash(packet_flags::CONNECT_REQUEST, &payload)
        .unwrap();
    assert!(hash > 0);

    let expected = holtburger_protocol::crypto::Hash32::compute(&payload);
    assert_eq!(hash, expected);
}

#[tokio::test]
async fn test_payload_hash_blobs() {
    let session = Session::new("127.0.0.1:9000".parse().unwrap())
        .await
        .unwrap();

    let mut payload = vec![0u8; 16];
    LittleEndian::write_u16(&mut payload[10..12], 20);
    payload.extend_from_slice(&[1, 2, 3, 4]);

    let hash = session
        .calculate_payload_hash(packet_flags::BLOB_FRAGMENTS, &payload)
        .unwrap();

    let h1 = holtburger_protocol::crypto::Hash32::compute(&payload[0..16]);
    let h2 = holtburger_protocol::crypto::Hash32::compute(&payload[16..20]);
    assert_eq!(hash, h1.wrapping_add(h2));
}

#[test]
fn test_echo_response_hash_size() {
    let session = Session::new_test();
    let mut payload = vec![0u8; 8];
    payload[0] = 0xAA;
    payload[7] = 0xBB;

    let hash = session
        .calculate_payload_hash(packet_flags::ECHO_RESPONSE, &payload)
        .unwrap();
    let expected = holtburger_protocol::crypto::Hash32::compute(&payload);
    assert_eq!(hash, expected);
}

#[test]
fn test_encrypted_checksum_xor_logic() {
    let mut session = Session::new_test();
    let seed = 0x99E77855;
    session.isaac_c2s = Some(holtburger_protocol::crypto::Isaac::new(seed));

    let expected_key = 0xAD497DF3;

    let header = PacketHeader {
        sequence: 10,
        flags: packet_flags::ENCRYPTED_CHECKSUM,
        checksum: 0,
        id: 123,
        time: 1000,
        size: 4,
        iteration: 0,
    };

    let payload = vec![0x11, 0x22, 0x33, 0x44];

    let header_hash = header.calculate_checksum();
    let payload_hash = session
        .calculate_payload_hash(header.flags, &payload)
        .unwrap();

    let final_checksum = header_hash.wrapping_add(payload_hash ^ expected_key);

    assert_eq!(
        session.isaac_c2s.as_ref().unwrap().current_key,
        expected_key
    );

    assert_eq!(
        header_hash.wrapping_add(payload_hash ^ expected_key),
        final_checksum
    );
}

#[tokio::test]
async fn test_multi_fragment_packet_unaligned() {
    struct MultiFragMock(Arc<Mutex<Vec<Vec<u8>>>>);
    #[async_trait]
    impl Transport for MultiFragMock {
        async fn send_to(&self, _buf: &[u8], _addr: SocketAddr) -> Result<usize> {
            Ok(0)
        }
        async fn recv_from(&self, buf: &mut [u8]) -> Result<(usize, SocketAddr)> {
            let mut q = self.0.lock().await;
            if q.is_empty() {
                return Err(anyhow!("Empty"));
            }
            let data = q.remove(0);
            buf[..data.len()].copy_from_slice(&data);
            Ok((data.len(), "127.0.0.1:9000".parse().unwrap()))
        }
    }

    let hex = "71000000060000003C8E48C70B0029B157000100AD0000000000008001001D0000000900E9020000000200000001000000AE0000000000008001001D0000000900E9020000000400000001000000AF0000000000008001001D0000000900E9020000000600000001000000";
    let data = hex::decode(hex).unwrap();
    let mut header = unpack_header(&data);
    header.flags &= !packet_flags::ENCRYPTED_CHECKSUM;
    let packet = build_transport_packet(header, &data[transport::HEADER_SIZE..]);

    let q = Arc::new(Mutex::new(vec![packet]));
    let mut session = Session::new_test();
    session.transport = Box::new(MultiFragMock(q));
    session.last_server_seq = 112;
    session.has_server_seq = true;

    let events = session.recv_message().await.unwrap();

    assert_eq!(events.len(), 3);

    for (i, event) in events.iter().enumerate() {
        if let SessionEvent::Message(msg_data) = event {
            assert_eq!(msg_data.len(), 13);
            assert_eq!(msg_data[0..2], [0xE9, 0x02]);

            let vital_id = u32::from_le_bytes(msg_data[5..9].try_into().unwrap());
            let expected_id = match i {
                0 => 2,
                1 => 4,
                2 => 6,
                _ => panic!("Too many messages"),
            };
            assert_eq!(vital_id, expected_id);
        } else {
            panic!("Expected SessionEvent::Message");
        }
    }
}

#[tokio::test]
async fn test_ack_sequence_prunes_cached_packets() {
    let transport = ScriptedTransport::new(
        vec![build_transport_packet(
            PacketHeader {
                sequence: 11,
                flags: packet_flags::ACK_SEQUENCE,
                size: 4,
                ..Default::default()
            },
            &6u32.to_le_bytes(),
        )],
        "127.0.0.1:9000".parse().unwrap(),
    );

    let mut session = Session::new_test();
    session.transport = Box::new(transport);

    session
        .send_packet(
            PacketHeader {
                sequence: 5,
                flags: packet_flags::BLOB_FRAGMENTS,
                id: session.client_id,
                ..Default::default()
            },
            &[1, 2, 3, 4],
        )
        .await
        .unwrap();
    session
        .send_packet(
            PacketHeader {
                sequence: 6,
                flags: packet_flags::BLOB_FRAGMENTS,
                id: session.client_id,
                ..Default::default()
            },
            &[5, 6, 7, 8],
        )
        .await
        .unwrap();

    assert!(session.cached_packets.contains_key(&5));
    assert!(session.cached_packets.contains_key(&6));

    let mut buf = [0u8; 1024];
    let _ = session.recv_packet(&mut buf).await.unwrap();

    assert!(!session.cached_packets.contains_key(&5));
    assert!(session.cached_packets.contains_key(&6));
}

#[tokio::test]
async fn test_piggybacked_ack_still_queues_ack_for_ordered_packet() {
    let fragment_packet = build_single_fragment_packet(7, &[0xAA, 0xBB, 0xCC]);
    let fragment_payload = &fragment_packet[transport::HEADER_SIZE..];

    let mut payload = Vec::with_capacity(transport::ACK_SEQUENCE_SIZE + fragment_payload.len());
    payload.extend_from_slice(&6u32.to_le_bytes());
    payload.extend_from_slice(fragment_payload);

    let packet = build_transport_packet(
        PacketHeader {
            sequence: 7,
            flags: packet_flags::BLOB_FRAGMENTS | packet_flags::ACK_SEQUENCE,
            size: payload.len() as u16,
            ..Default::default()
        },
        &payload,
    );
    let transport = ScriptedTransport::new(vec![packet], "127.0.0.1:9000".parse().unwrap());
    let sent_handle = transport.clone();

    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    session.last_server_seq = 6;
    session.has_server_seq = true;

    let events = session.recv_message().await.unwrap();
    assert_eq!(events.len(), 1);
    // A02 Opt-2: the queued ACK sits on the coalesce deadline; force it due
    // (this test asserts the ACK is QUEUED at all, not its timing).
    for p in session.pending_control_packets.iter_mut() {
        p.ready_at = web_time::Instant::now();
    }
    assert!(session.flush_pending_control_packets().await.unwrap());

    let sent_packets = sent_handle.sent_packets().await;
    assert!(
        sent_packets
            .iter()
            .any(|packet| unpack_header(packet).flags == packet_flags::ACK_SEQUENCE)
    );

    let sent_entries = sent_handle.sent_entries().await;
    assert!(sent_entries.iter().any(|(addr, packet)| {
        *addr == session.server_addr && unpack_header(packet).flags == packet_flags::ACK_SEQUENCE
    }));
}

#[test]
fn test_payload_hash_multi_fragment_unaligned_matches_wire_layout() {
    let session = Session::new_test();
    let hex = "71000000060000003C8E48C70B0029B157000100AD0000000000008001001D0000000900E9020000000200000001000000AE0000000000008001001D0000000900E9020000000400000001000000AF0000000000008001001D0000000900E9020000000600000001000000";
    let packet = hex::decode(hex).unwrap();
    let payload = &packet[transport::HEADER_SIZE..];

    let hash = session
        .calculate_payload_hash(packet_flags::BLOB_FRAGMENTS, payload)
        .unwrap();

    let expected = holtburger_protocol::crypto::Hash32::compute(&payload[0..16])
        .wrapping_add(holtburger_protocol::crypto::Hash32::compute(
            &payload[16..29],
        ))
        .wrapping_add(holtburger_protocol::crypto::Hash32::compute(
            &payload[29..45],
        ))
        .wrapping_add(holtburger_protocol::crypto::Hash32::compute(
            &payload[45..58],
        ))
        .wrapping_add(holtburger_protocol::crypto::Hash32::compute(
            &payload[58..74],
        ))
        .wrapping_add(holtburger_protocol::crypto::Hash32::compute(
            &payload[74..87],
        ));

    assert_eq!(hash, expected);
}

#[tokio::test]
async fn test_request_retransmit_sends_cached_packet() {
    let requested_sequence = 9u32;
    let retransmit_payload = [1u32.to_le_bytes(), requested_sequence.to_le_bytes()].concat();
    let transport = ScriptedTransport::new(
        vec![build_transport_packet(
            PacketHeader {
                sequence: 12,
                flags: packet_flags::REQUEST_RETRANSMIT,
                size: retransmit_payload.len() as u16,
                ..Default::default()
            },
            &retransmit_payload,
        )],
        "127.0.0.1:9000".parse().unwrap(),
    );
    let sent_handle = transport.clone();

    let mut session = Session::new_test();
    session.transport = Box::new(transport);

    session
        .send_packet(
            PacketHeader {
                sequence: requested_sequence,
                flags: packet_flags::BLOB_FRAGMENTS,
                id: session.client_id,
                ..Default::default()
            },
            &[0xAA, 0xBB, 0xCC, 0xDD],
        )
        .await
        .unwrap();

    let original_packet = sent_handle.sent_packets().await[0].clone();

    let mut buf = [0u8; 1024];
    let _ = session.recv_packet(&mut buf).await.unwrap();
    assert!(session.flush_pending_control_packets().await.unwrap());

    let sent_packets = sent_handle.sent_packets().await;
    assert_eq!(sent_packets.len(), 2);

    let original_header = unpack_header(&original_packet);
    let retransmit_header = unpack_header(&sent_packets[1]);
    assert_eq!(retransmit_header.sequence, original_header.sequence);
    assert_eq!(retransmit_header.id, original_header.id);
    assert_eq!(
        retransmit_header.flags,
        original_header.flags | packet_flags::RETRANSMISSION
    );
}

#[tokio::test]
async fn test_handshake_response_is_scheduled_and_flushed_outside_recv() {
    let connect_request = ConnectRequestData {
        time: 123.5,
        cookie: 0x1122_3344_5566_7788,
        client_id: 0x345,
        server_seed: 0x1234_5678,
        client_seed: 0x9ABC_DEF0,
    };
    let transport = ScriptedTransport::new(
        vec![build_connect_request_packet(connect_request.clone())],
        "127.0.0.1:9000".parse().unwrap(),
    );
    let sent_handle = transport.clone();

    let mut session = Session::new_test();
    session.transport = Box::new(transport);

    let events = session.recv_message().await.unwrap();
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], SessionEvent::TimeSync(time) if time == connect_request.time));
    assert_eq!(
        session.server_source_addr,
        "127.0.0.1:9000".parse().unwrap()
    );
    assert_eq!(
        session.pending_server_source_addr,
        Some("127.0.0.1:9001".parse().unwrap())
    );
    assert_eq!(session.pending_control_packets.len(), 1);
    assert!(sent_handle.sent_packets().await.is_empty());

    session
        .pending_control_packets
        .first_mut()
        .expect("handshake response should be queued")
        .ready_at = std::time::Instant::now() - std::time::Duration::from_millis(1);

    assert!(session.flush_pending_control_packets().await.unwrap());

    let sent_packets = sent_handle.sent_packets().await;
    assert_eq!(sent_packets.len(), 1);
    let header = unpack_header(&sent_packets[0]);
    assert_eq!(header.flags, packet_flags::CONNECT_RESPONSE);
    assert_eq!(header.sequence, 1);
    assert_eq!(header.id, 0);
    assert_eq!(header.size, transport::CONNECT_RESPONSE_SIZE as u16);
}

#[tokio::test]
async fn test_packets_from_activation_port_are_accepted_after_handshake_request() {
    let connect_request = ConnectRequestData {
        time: 123.5,
        cookie: 0x1122_3344_5566_7788,
        client_id: 0x345,
        server_seed: 0x1234_5678,
        client_seed: 0x9ABC_DEF0,
    };
    let transport = SequencedTransport::new(vec![
        (
            build_connect_request_packet(connect_request),
            "127.0.0.1:9000".parse().unwrap(),
        ),
        (
            build_transport_packet(
                PacketHeader {
                    flags: packet_flags::TIME_SYNC,
                    size: 8,
                    ..Default::default()
                },
                &1.25f64.to_le_bytes(),
            ),
            "127.0.0.1:9001".parse().unwrap(),
        ),
    ]);

    let mut session = Session::new_test();
    session.transport = Box::new(transport);

    let first_events = session.recv_message().await.unwrap();
    assert_eq!(first_events.len(), 1);
    assert!(matches!(first_events[0], SessionEvent::TimeSync(time) if time == 123.5));
    assert_eq!(
        session.server_source_addr,
        "127.0.0.1:9000".parse().unwrap()
    );
    assert_eq!(
        session.pending_server_source_addr,
        Some("127.0.0.1:9001".parse().unwrap())
    );

    let second_events = session.recv_message().await.unwrap();
    assert_eq!(second_events.len(), 1);
    assert!(matches!(second_events[0], SessionEvent::TimeSync(time) if time == 1.25));
    assert_eq!(
        session.server_source_addr,
        "127.0.0.1:9001".parse().unwrap()
    );
    assert_eq!(session.pending_server_source_addr, None);
}

#[tokio::test]
async fn test_packets_from_login_port_are_accepted_until_activation_port_is_confirmed() {
    let connect_request = ConnectRequestData {
        time: 123.5,
        cookie: 0x1122_3344_5566_7788,
        client_id: 0x345,
        server_seed: 0x1234_5678,
        client_seed: 0x9ABC_DEF0,
    };
    let boot_message = GameMessage::AccountBoot(Box::new(BootAccountData {
        reason: Some(" because the password entered for this account was not correct".to_string()),
    }));
    let mut boot_payload = Vec::new();
    boot_message.pack(&mut boot_payload);

    let transport = SequencedTransport::new(vec![
        (
            build_connect_request_packet(connect_request),
            "127.0.0.1:9000".parse().unwrap(),
        ),
        (
            build_single_fragment_packet(2, &boot_payload),
            "127.0.0.1:9000".parse().unwrap(),
        ),
    ]);

    let mut session = Session::new_test();
    session.transport = Box::new(transport);

    let first_events = session.recv_message().await.unwrap();
    assert_eq!(first_events.len(), 1);
    assert!(matches!(first_events[0], SessionEvent::TimeSync(time) if time == 123.5));
    assert_eq!(
        session.pending_server_source_addr,
        Some("127.0.0.1:9001".parse().unwrap())
    );

    let second_events = session.recv_message().await.unwrap();
    assert_eq!(second_events.len(), 1);
    assert!(matches!(second_events[0], SessionEvent::Message(ref msg) if msg == &boot_payload));
    assert_eq!(
        session.server_source_addr,
        "127.0.0.1:9000".parse().unwrap()
    );
    assert_eq!(
        session.pending_server_source_addr,
        Some("127.0.0.1:9001".parse().unwrap())
    );
}

#[tokio::test]
async fn test_connect_response_parses_cookie_from_optional_header_offset() {
    let cookie = 0x1122_3344_5566_7788u64;
    let client_id = 0x345u16;
    let transport = ScriptedTransport::new(
        vec![build_connect_response_packet(cookie, client_id)],
        "127.0.0.1:9000".parse().unwrap(),
    );

    let mut session = Session::new_test();
    session.transport = Box::new(transport);

    let events = session.recv_message().await.unwrap();
    assert!(events.is_empty());
    assert_eq!(session.connection_cookie, cookie);
    assert_eq!(session.client_id, client_id);
}

#[tokio::test]
async fn test_wrapped_server_sequence_zero_is_processed_as_expected() {
    let transport = ScriptedTransport::new(
        vec![build_single_fragment_packet(0, &[0xAA, 0xBB, 0xCC])],
        "127.0.0.1:9000".parse().unwrap(),
    );

    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    session.last_server_seq = u32::MAX;
    session.has_server_seq = true;

    let events = session.recv_message().await.unwrap();
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], SessionEvent::Message(ref msg) if msg == &vec![0xAA, 0xBB, 0xCC]));
    assert_eq!(session.last_server_seq, 0);
}

#[tokio::test]
async fn test_out_of_order_server_packet_requests_retransmit() {
    let transport = ScriptedTransport::new(
        vec![
            build_transport_packet(
                PacketHeader {
                    sequence: 4,
                    ..Default::default()
                },
                &[],
            ),
            build_transport_packet(
                PacketHeader {
                    sequence: 2,
                    ..Default::default()
                },
                &[],
            ),
        ],
        "127.0.0.1:9000".parse().unwrap(),
    );
    let sent_handle = transport.clone();

    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    session.packet_sequence = 5;
    session.last_server_seq = 1;
    session.has_server_seq = true;

    let events = session.recv_message().await.unwrap();
    assert!(events.is_empty());

    let sent_packets = sent_handle.sent_packets().await;
    let retransmit_packet = sent_packets
        .iter()
        .find(|packet| (unpack_header(packet).flags & packet_flags::REQUEST_RETRANSMIT) != 0)
        .expect("missing retransmit request packet");
    let retransmit_header = unpack_header(retransmit_packet);
    assert_eq!(retransmit_header.sequence, 4);
    assert_eq!(retransmit_header.flags, packet_flags::REQUEST_RETRANSMIT);

    let sent_entries = sent_handle.sent_entries().await;
    assert!(sent_entries.iter().any(|(addr, packet)| {
        *addr == session.server_addr
            && (unpack_header(packet).flags & packet_flags::REQUEST_RETRANSMIT) != 0
    }));

    let payload = &retransmit_packet[transport::HEADER_SIZE..];
    assert_eq!(LittleEndian::read_u32(&payload[0..4]), 2);
    assert_eq!(LittleEndian::read_u32(&payload[4..8]), 2);
    assert_eq!(LittleEndian::read_u32(&payload[8..12]), 3);
}

#[tokio::test]
async fn test_single_packet_gap_requests_retransmit() {
    let transport = ScriptedTransport::new(
        vec![build_transport_packet(
            PacketHeader {
                sequence: 3,
                ..Default::default()
            },
            &[],
        )],
        "127.0.0.1:9000".parse().unwrap(),
    );
    let sent_handle = transport.clone();

    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    session.packet_sequence = 5;
    session.last_server_seq = 1;
    session.has_server_seq = true;

    let error = session.recv_message().await.unwrap_err();
    assert!(error.to_string().contains("Empty"));

    let sent_packets = sent_handle.sent_packets().await;
    let retransmit_packet = sent_packets
        .iter()
        .find(|packet| (unpack_header(packet).flags & packet_flags::REQUEST_RETRANSMIT) != 0)
        .expect("missing retransmit request packet");

    let payload = &retransmit_packet[transport::HEADER_SIZE..];
    assert_eq!(LittleEndian::read_u32(&payload[0..4]), 1);
    assert_eq!(LittleEndian::read_u32(&payload[4..8]), 2);
}

#[tokio::test]
async fn test_send_request_retransmit_wraps_sequence_window() {
    let transport = ScriptedTransport::new(vec![], "127.0.0.1:9000".parse().unwrap());
    let sent_handle = transport.clone();

    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    session.last_server_seq = u32::MAX;

    session.send_request_retransmit(1).unwrap();
    assert!(session.flush_pending_control_packets().await.unwrap());

    let sent_packets = sent_handle.sent_packets().await;
    let retransmit_packet = sent_packets
        .iter()
        .find(|packet| (unpack_header(packet).flags & packet_flags::REQUEST_RETRANSMIT) != 0)
        .expect("missing retransmit request packet");

    let payload = &retransmit_packet[transport::HEADER_SIZE..];
    assert_eq!(LittleEndian::read_u32(&payload[0..4]), 1);
    assert_eq!(LittleEndian::read_u32(&payload[4..8]), 0);
}

#[tokio::test]
async fn test_queued_ack_uses_latest_client_sequence_when_flushed() {
    let transport = ScriptedTransport::new(vec![], "127.0.0.1:9000".parse().unwrap());
    let sent_handle = transport.clone();

    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    session.packet_sequence = 2;
    session.client_id = 0x123;

    session.queue_ack(0x55).unwrap();
    // A02 Opt-2: the queued ACK is deferred by the coalesce window; force it
    // due so this test still exercises the flush-time sequence stamping.
    session.pending_control_packets[0].ready_at = web_time::Instant::now();

    let header = PacketHeader {
        sequence: session.packet_sequence,
        flags: packet_flags::BLOB_FRAGMENTS,
        id: session.client_id,
        ..Default::default()
    };
    session.packet_sequence += 1;
    session.send_packet(header, &[]).await.unwrap();

    assert!(session.flush_pending_control_packets().await.unwrap());

    let sent_packets = sent_handle.sent_packets().await;
    assert_eq!(sent_packets.len(), 2);
    assert_eq!(unpack_header(&sent_packets[0]).sequence, 2);

    let ack_header = unpack_header(&sent_packets[1]);
    assert_eq!(ack_header.flags, packet_flags::ACK_SEQUENCE);
    assert_eq!(ack_header.sequence, 2);
}

#[tokio::test]
async fn test_queue_ack_coalesces_into_one_pending_packet_with_latest_sequence() {
    // A02 Opt-2 (2026-07-10): back-to-back ordered packets must produce ONE
    // pending cleartext ACK carrying the newest (cumulative) sequence, and
    // the first ACK's deadline must survive later queue_ack calls (a steady
    // stream can't starve the ACK past one coalesce window).
    let transport = ScriptedTransport::new(vec![], "127.0.0.1:9000".parse().unwrap());
    let sent_handle = transport.clone();

    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    session.packet_sequence = 2;
    session.client_id = 0x123;

    session.queue_ack(0x10).unwrap();
    let first_deadline = session.pending_control_packets[0].ready_at;
    session.queue_ack(0x11).unwrap();
    session.queue_ack(0x12).unwrap();

    assert_eq!(session.pending_control_packets.len(), 1);
    assert_eq!(session.pending_control_packets[0].ready_at, first_deadline);

    // Not due yet: flush sends nothing.
    assert!(!session.flush_pending_control_packets().await.unwrap());

    // Force it due; the flushed ACK must carry the LATEST sequence (0x12).
    session.pending_control_packets[0].ready_at = web_time::Instant::now();
    assert!(session.flush_pending_control_packets().await.unwrap());

    let sent_packets = sent_handle.sent_packets().await;
    assert_eq!(sent_packets.len(), 1);
    let ack_header = unpack_header(&sent_packets[0]);
    assert_eq!(ack_header.flags, packet_flags::ACK_SEQUENCE);
    let payload = &sent_packets[0][transport::HEADER_SIZE..];
    assert_eq!(LittleEndian::read_u32(&payload[0..4]), 0x12);
}

#[test]
fn test_fragment_reassembler_evicts_oldest_abandoned_group_at_cap() {
    // A13 (2026-07-10): never-completed fragment groups must not accumulate
    // for the session's lifetime. Feed 300 distinct 2-fragment groups their
    // first fragment only: the map must hold the cap (256), the oldest
    // sequences must be gone, and the newest group must still assemble.
    let mut session = Session::new_test();

    for seq in 0u32..300 {
        let header = FragmentHeader {
            sequence: seq,
            count: 2,
            index: 0,
            ..Default::default()
        };
        assert!(session.process_fragment(&header, &[0xAB]).is_none());
    }

    assert_eq!(session.fragment_reassembler.len(), 256);
    assert!(!session.fragment_reassembler.contains_key(&0));
    assert!(!session.fragment_reassembler.contains_key(&43));
    assert!(session.fragment_reassembler.contains_key(&44));
    assert!(session.fragment_reassembler.contains_key(&299));

    // The surviving newest group still completes normally.
    let closing = FragmentHeader {
        sequence: 299,
        count: 2,
        index: 1,
        ..Default::default()
    };
    let assembled = session.process_fragment(&closing, &[0xCD]).unwrap();
    assert_eq!(assembled, vec![0xAB, 0xCD]);
    assert!(!session.fragment_reassembler.contains_key(&299));
}

#[test]
fn test_read_sequence_list_rejects_oversized_count() {
    let session = Session::new_test();
    let count = (crate::session::types::MAX_RETRANSMIT_SEQUENCE_IDS + 1) as u32;
    let payload = count.to_le_bytes();

    let result = session.read_sequence_list(
        packet_flags::REQUEST_RETRANSMIT,
        &payload,
        packet_flags::REQUEST_RETRANSMIT,
    );
    assert!(result.is_none());
}

#[test]
fn test_build_packet_bytes_rejects_payloads_larger_than_u16() {
    let mut session = Session::new_test();
    let payload = vec![0u8; u16::MAX as usize + 1];

    let err = session.send_packet_to_addr(
        PacketHeader {
            flags: packet_flags::BLOB_FRAGMENTS,
            sequence: 1,
            ..Default::default()
        },
        &payload,
        session.server_addr,
    );

    let runtime = tokio::runtime::Runtime::new().expect("runtime should build");
    let err = runtime.block_on(err).unwrap_err();
    assert!(err.to_string().contains("packet payload too large"));
}

#[test]
fn test_build_cleartext_control_packet_rejects_payloads_larger_than_u16() {
    let mut session = Session::new_test();
    let payload = vec![0u8; u16::MAX as usize + 1];

    let err = session
        .queue_deferred_cleartext_control_packet(
            PacketHeader {
                flags: packet_flags::ACK_SEQUENCE,
                ..Default::default()
            },
            &payload,
            session.server_addr,
            std::time::Instant::now(),
            false,
        )
        .unwrap_err();

    assert!(err.to_string().contains("packet payload too large"));
}

#[test]
fn test_handshake_request_rejects_activation_port_overflow() {
    let mut session = Session::new_test();
    session.server_addr = "127.0.0.1:65535".parse().unwrap();

    let err = session
        .handle_handshake_request(ConnectRequestData {
            time: 1.0,
            cookie: 0x1122_3344_5566_7788,
            client_id: 0x345,
            server_seed: 0x1234_5678,
            client_seed: 0x9ABC_DEF0,
        })
        .unwrap_err();

    assert!(err.to_string().contains("activation port overflow"));
}

#[tokio::test]
async fn test_first_server_packet_sequence_two_does_not_request_retransmit() {
    let transport = ScriptedTransport::new(
        vec![build_transport_packet(
            PacketHeader {
                sequence: 2,
                flags: packet_flags::TIME_SYNC,
                size: 8,
                ..Default::default()
            },
            &0.0f64.to_le_bytes(),
        )],
        "127.0.0.1:9000".parse().unwrap(),
    );
    let sent_handle = transport.clone();

    let mut session = Session::new_test();
    session.transport = Box::new(transport);

    let events = session.recv_message().await.unwrap();
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], SessionEvent::TimeSync(_)));

    let sent_packets = sent_handle.sent_packets().await;
    assert!(
        sent_packets.iter().all(|packet| {
            (unpack_header(packet).flags & packet_flags::REQUEST_RETRANSMIT) == 0
        })
    );
}

#[tokio::test]
async fn test_retransmit_uses_cached_packet_with_piggybacked_ack() {
    let requested_sequence = 9u32;
    let retransmit_payload = [1u32.to_le_bytes(), requested_sequence.to_le_bytes()].concat();
    let transport = ScriptedTransport::new(
        vec![build_transport_packet(
            PacketHeader {
                sequence: 50,
                flags: packet_flags::REQUEST_RETRANSMIT,
                size: retransmit_payload.len() as u16,
                ..Default::default()
            },
            &retransmit_payload,
        )],
        "127.0.0.1:9000".parse().unwrap(),
    );
    let sent_handle = transport.clone();

    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    session.has_server_seq = true;
    session.last_server_seq = 42;

    session
        .send_packet(
            PacketHeader {
                sequence: requested_sequence,
                flags: packet_flags::BLOB_FRAGMENTS,
                id: session.client_id,
                ..Default::default()
            },
            &[0xAA, 0xBB, 0xCC, 0xDD],
        )
        .await
        .unwrap();

    let original_packet = sent_handle.sent_packets().await[0].clone();
    let original_header = unpack_header(&original_packet);
    assert_ne!(original_header.flags & packet_flags::ACK_SEQUENCE, 0);

    let mut buf = [0u8; 1024];
    let _ = session.recv_packet(&mut buf).await.unwrap();
    assert!(session.flush_pending_control_packets().await.unwrap());

    let sent_packets = sent_handle.sent_packets().await;
    assert_eq!(sent_packets.len(), 2);

    let retransmit_header = unpack_header(&sent_packets[1]);
    assert_eq!(retransmit_header.sequence, original_header.sequence);
    assert_eq!(
        retransmit_header.flags,
        original_header.flags | packet_flags::RETRANSMISSION
    );
}

// ── net-transport-1 (2026-10-13): outbound fragmentation ────────────────
// These replace the R-14 stopgap tests, which pinned the old behaviour of
// dropping every C2S message over 448 B.

/// One C2S packet as ACE's `ClientPacket.Unpack` reads it: the packet header,
/// then (after the optional piggybacked ACK word) one fragment header and its
/// data. Asserts the packet holds exactly one fragment.
fn parse_c2s_fragment_packet(packet: &[u8]) -> (PacketHeader, FragmentHeader, Vec<u8>) {
    let header = unpack_header(packet);
    assert_ne!(header.flags & packet_flags::BLOB_FRAGMENTS, 0, "not a fragment packet");
    assert_eq!(header.size as usize, packet.len() - transport::HEADER_SIZE);
    let mut offset = transport::HEADER_SIZE;
    if header.flags & packet_flags::ACK_SEQUENCE != 0 {
        offset += transport::ACK_SEQUENCE_SIZE;
    }
    let frag = FragmentHeader::unpack(packet, &mut offset).expect("fragment header should unpack");
    let data_len = (frag.size as usize)
        .checked_sub(transport::FRAGMENT_HEADER_SIZE)
        .expect("fragment size covers its header");
    assert_eq!(offset + data_len, packet.len(), "exactly one fragment per packet");
    let data = packet[offset..offset + data_len].to_vec();
    (header, frag, data)
}

/// ACE `MessageBuffer.TryGetMessage`: sort a split message's fragments by
/// index and concatenate their data.
fn reassemble_like_ace(mut fragments: Vec<(FragmentHeader, Vec<u8>)>) -> Vec<u8> {
    fragments.sort_by_key(|(frag, _)| frag.index);
    fragments.into_iter().flat_map(|(_, data)| data).collect()
}

fn packed_message(message: &GameMessage) -> Vec<u8> {
    let mut buf = Vec::new();
    ProtocolPack::pack(message, &mut buf);
    buf
}

/// The 448/449 boundary (retail `NetBlob::Fragmentize`: `bufSize / 0x1C0`,
/// +1 for a remainder). `GameMessage::Unknown` packs as opcode + raw bytes,
/// so the payload size is exact (a string16 body only grows in 4-byte steps).
#[tokio::test]
async fn test_fragment_boundary_448_is_one_packet_449_is_two() {
    use holtburger_protocol::messages::transport::MAX_FRAGMENT_PAYLOAD;

    fn raw_message(total_len: usize) -> GameMessage {
        // Opaque test opcode; the transport never looks inside the payload.
        GameMessage::Unknown(0x1234_5678, (0..total_len - 4).map(|i| i as u8).collect())
    }

    let transport = ScriptedTransport::new(vec![], "127.0.0.1:9000".parse().unwrap());
    let sent_handle = transport.clone();
    let mut session = Session::new_test();
    session.transport = Box::new(transport);

    let frag_seq_before = session.fragment_sequence;
    let frag_id_before = session.fragment_id;
    let pkt_seq_before = session.packet_sequence;

    // Exactly 448 B: one packet, one unsplit fragment of 464 B.
    let at_limit = raw_message(MAX_FRAGMENT_PAYLOAD);
    let at_limit_bytes = packed_message(&at_limit);
    assert_eq!(at_limit_bytes.len(), MAX_FRAGMENT_PAYLOAD);
    session.send_message(&at_limit).await.unwrap();

    let sent = sent_handle.sent_packets().await;
    assert_eq!(sent.len(), 1);
    let (header, frag, data) = parse_c2s_fragment_packet(&sent[0]);
    assert_eq!(header.sequence, pkt_seq_before);
    assert_eq!(frag.sequence, frag_seq_before);
    assert_eq!(frag.id, frag_id_before);
    assert_eq!(frag.count, 1);
    assert_eq!(frag.index, 0);
    assert_eq!(frag.size as usize, transport::FRAGMENT_HEADER_SIZE + MAX_FRAGMENT_PAYLOAD);
    assert_eq!(data, at_limit_bytes);

    // 449 B: two packets (448 + 1), one shared fragment sequence.
    let over_limit = raw_message(MAX_FRAGMENT_PAYLOAD + 1);
    let over_limit_bytes = packed_message(&over_limit);
    assert_eq!(over_limit_bytes.len(), MAX_FRAGMENT_PAYLOAD + 1);
    session.send_message(&over_limit).await.unwrap();

    let sent = sent_handle.sent_packets().await;
    assert_eq!(sent.len(), 3);
    let mut fragments = Vec::new();
    for (i, packet) in sent[1..].iter().enumerate() {
        let (header, frag, data) = parse_c2s_fragment_packet(packet);
        assert_eq!(header.sequence, pkt_seq_before + 1 + i as u32);
        assert_eq!(frag.sequence, frag_seq_before + 1, "next message, next fragment sequence");
        assert_eq!(frag.id, frag_id_before + 1);
        assert_eq!(frag.count, 2);
        assert_eq!(frag.index, i as u16);
        assert_eq!(data.len(), if i == 0 { MAX_FRAGMENT_PAYLOAD } else { 1 });
        fragments.push((frag, data));
    }
    assert_eq!(reassemble_like_ace(fragments), over_limit_bytes);

    // Fragment sequence/id advance once per MESSAGE; packet sequence once
    // per fragment.
    assert_eq!(session.fragment_sequence, frag_seq_before + 2);
    assert_eq!(session.fragment_id, frag_id_before + 2);
    assert_eq!(session.packet_sequence, pkt_seq_before + 3);
}

/// A 1000-character book page (the textarea cap for 343 of 348 LSD books)
/// packs to ~1 KB. It must go out as 3 retail fragments, each in its own
/// encrypted packet with the ACK piggyback, consecutive packet sequences,
/// successive C2S ISAAC keys and a retransmit-cache entry, and ACE-style
/// reassembly must give back the exact packed message.
#[tokio::test]
async fn test_long_book_page_is_sent_as_three_fragments() {
    use holtburger_protocol::crypto::Isaac;
    use holtburger_protocol::messages::book::BookModifyPageActionData;
    use holtburger_protocol::messages::game_action::{GameAction, GameActionMessage};
    use holtburger_protocol::messages::transport::MAX_FRAGMENT_PAYLOAD;

    let transport = ScriptedTransport::new(vec![], "127.0.0.1:9000".parse().unwrap());
    let sent_handle = transport.clone();

    let seed = 0x99E7_7855;
    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    // >= 2 so the retransmit cache keeps the packets (`maybe_cache_packet`).
    session.packet_sequence = 5;
    session.client_id = 0x0B;
    session.has_server_seq = true;
    session.last_server_seq = 42;
    session.isaac_c2s = Some(Isaac::new(seed));
    let mut expected_keys = Isaac::new(seed);

    let book_page = GameMessage::GameAction(Box::new(GameActionMessage {
        sequence: 7,
        action: GameAction::BookModifyPage(Box::new(BookModifyPageActionData {
            object_guid: holtburger_common::Guid(0x8000_1234),
            page_num: 0,
            text: "x".repeat(1000),
        })),
    }));
    let packed = packed_message(&book_page);
    assert_eq!(packed.len().div_ceil(MAX_FRAGMENT_PAYLOAD), 3);

    let frag_seq_before = session.fragment_sequence;
    let frag_id_before = session.fragment_id;
    session.send_message(&book_page).await.unwrap();

    let sent = sent_handle.sent_packets().await;
    assert_eq!(sent.len(), 3, "one packet per fragment");

    let mut fragments = Vec::new();
    for (i, packet) in sent.iter().enumerate() {
        assert!(
            packet.len()
                <= transport::HEADER_SIZE
                    + transport::ACK_SEQUENCE_SIZE
                    + transport::FRAGMENT_HEADER_SIZE
                    + MAX_FRAGMENT_PAYLOAD,
            "datagram over 488 B"
        );
        let (header, frag, data) = parse_c2s_fragment_packet(packet);

        assert_eq!(header.sequence, 5 + i as u32, "consecutive packet sequences");
        assert_eq!(
            header.flags,
            packet_flags::BLOB_FRAGMENTS
                | packet_flags::ACK_SEQUENCE
                | packet_flags::ENCRYPTED_CHECKSUM
        );
        assert_eq!(header.id, 0x0B);
        assert_eq!(
            LittleEndian::read_u32(&packet[transport::HEADER_SIZE..transport::HEADER_SIZE + 4]),
            42,
            "every fragment packet carries the ACK piggyback"
        );

        assert_eq!(frag.sequence, frag_seq_before, "one fragment sequence per message");
        assert_eq!(frag.id, frag_id_before);
        assert_eq!(frag.count, 3);
        assert_eq!(frag.index, i as u16);
        assert_eq!(frag.queue, transport::queues::GENERAL);
        assert!(frag.size as usize <= transport::FRAGMENT_HEADER_SIZE + MAX_FRAGMENT_PAYLOAD);
        if i < 2 {
            assert_eq!(data.len(), MAX_FRAGMENT_PAYLOAD, "retail fills every chunk but the last");
        }

        // The encrypted checksum validates against the NEXT C2S ISAAC key,
        // taken in packet order.
        let header_hash = header.calculate_checksum();
        let payload_hash = session
            .calculate_payload_hash(header.flags, &packet[transport::HEADER_SIZE..])
            .unwrap();
        assert_eq!(
            header.checksum,
            header_hash.wrapping_add(payload_hash ^ expected_keys.current_key),
            "packet {i} checksum"
        );
        expected_keys.consume_key();

        assert!(
            session.cached_packets.contains_key(&header.sequence),
            "packet {} must be in the retransmit cache",
            header.sequence
        );
        fragments.push((frag, data));
    }
    assert_eq!(
        session.isaac_c2s.as_ref().unwrap().current_key,
        expected_keys.current_key,
        "exactly one ISAAC key per packet"
    );

    // Arrival order does not matter: ACE sorts by index before joining.
    fragments.reverse();
    assert_eq!(reassemble_like_ace(fragments), packed);

    assert_eq!(session.fragment_sequence, frag_seq_before + 1);
    assert_eq!(session.fragment_id, frag_id_before + 1);
    assert_eq!(session.packet_sequence, 8);
}

/// CharacterCreate packs ~396 B before its two string16s (104 B appearance,
/// a 55-slot end-of-retail skill array), so a long account name (ACE accepts
/// up to 50 characters) plus a character name crosses 448 B. Under R-14 that
/// chargen was silently dropped; it must now go out as two fragments.
#[tokio::test]
async fn test_character_create_with_long_names_is_sent_as_two_fragments() {
    use holtburger_protocol::messages::character::{
        CharacterCreateAppearanceData, CharacterCreateRequestData, SkillAdvancementClass,
    };
    use holtburger_protocol::messages::transport::MAX_FRAGMENT_PAYLOAD;

    let create = GameMessage::CharacterCreate(Box::new(CharacterCreateRequestData {
        account_name: "a".repeat(50),
        unknown_constant: 1,
        heritage: 1,
        gender: 1,
        appearance: CharacterCreateAppearanceData {
            eyes: 1,
            nose: 1,
            mouth: 1,
            hair_color: 1,
            eye_color: 1,
            hair_style: 1,
            headgear_style: 0xFFFF_FFFF,
            headgear_color: 0,
            shirt_style: 1,
            shirt_color: 1,
            pants_style: 1,
            pants_color: 1,
            footwear_style: 1,
            footwear_color: 1,
            skin_hue: 0.5,
            hair_hue: 0.5,
            headgear_hue: 0.0,
            shirt_hue: 0.5,
            pants_hue: 0.5,
            footwear_hue: 0.5,
        },
        template_option: 0,
        strength_ability: 100,
        endurance_ability: 10,
        coordination_ability: 100,
        quickness_ability: 100,
        focus_ability: 10,
        self_ability: 10,
        character_slot: 0,
        class_id: 0,
        skill_advancement_classes: vec![SkillAdvancementClass::Untrained; 55],
        name: "Sir Reginald Longname".to_string(),
        start_area: 0,
        is_admin: false,
        is_sentinel: false,
    }));
    let packed = packed_message(&create);
    assert!(
        packed.len() > MAX_FRAGMENT_PAYLOAD,
        "fixture must exceed one fragment, got {} B",
        packed.len()
    );
    assert_eq!(packed.len().div_ceil(MAX_FRAGMENT_PAYLOAD), 2);

    let transport = ScriptedTransport::new(vec![], "127.0.0.1:9000".parse().unwrap());
    let sent_handle = transport.clone();
    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    let frag_seq_before = session.fragment_sequence;

    session.send_message(&create).await.unwrap();

    let sent = sent_handle.sent_packets().await;
    assert_eq!(sent.len(), 2, "chargen must not be dropped");
    let fragments: Vec<_> = sent
        .iter()
        .enumerate()
        .map(|(i, packet)| {
            let (_, frag, data) = parse_c2s_fragment_packet(packet);
            assert_eq!(frag.sequence, frag_seq_before);
            assert_eq!(frag.count, 2);
            assert_eq!(frag.index, i as u16);
            (frag, data)
        })
        .collect();
    assert_eq!(reassemble_like_ace(fragments), packed);
}

// ── R2-net (2026-10-08): net-2 / net-3 / net-4 / net-5 ──────────────────

/// A transport whose receive side never yields (a quiet server), so the
/// receive loop can only wake on its own timers.
#[derive(Clone)]
struct SilentTransport {
    sent: Arc<Mutex<Vec<SentPacket>>>,
}

impl SilentTransport {
    fn new() -> Self {
        Self {
            sent: Arc::new(Mutex::new(Vec::new())),
        }
    }

    async fn sent_packets(&self) -> Vec<Vec<u8>> {
        self.sent
            .lock()
            .await
            .iter()
            .map(|(_, bytes)| bytes.clone())
            .collect()
    }
}

#[async_trait]
impl Transport for SilentTransport {
    async fn send_to(&self, buf: &[u8], addr: SocketAddr) -> Result<usize> {
        self.sent.lock().await.push((addr, buf.to_vec()));
        Ok(buf.len())
    }

    async fn recv_from(&self, _buf: &mut [u8]) -> Result<(usize, SocketAddr)> {
        std::future::pending::<Result<(usize, SocketAddr)>>().await
    }
}

fn force_pending_control_packets_due(session: &mut Session) {
    for pending in session.pending_control_packets.iter_mut() {
        pending.ready_at = web_time::Instant::now();
    }
}

fn request_retransmit_ids(packet: &[u8]) -> Vec<u32> {
    let payload = &packet[transport::HEADER_SIZE..];
    let count = LittleEndian::read_u32(&payload[0..4]) as usize;
    (0..count)
        .map(|index| LittleEndian::read_u32(&payload[4 + index * 4..8 + index * 4]))
        .collect()
}

fn is_request_retransmit(packet: &[u8]) -> bool {
    (unpack_header(packet).flags & packet_flags::REQUEST_RETRANSMIT) != 0
}

fn build_cleartext_nak_packet(borrowed_sequence: u32, c2s_ids: &[u32]) -> Vec<u8> {
    let mut payload = (c2s_ids.len() as u32).to_le_bytes().to_vec();
    for id in c2s_ids {
        payload.extend_from_slice(&id.to_le_bytes());
    }
    build_transport_packet(
        PacketHeader {
            sequence: borrowed_sequence,
            flags: packet_flags::REQUEST_RETRANSMIT,
            ..Default::default()
        },
        &payload,
    )
}

fn build_ack_only_packet(borrowed_sequence: u32, acked: u32) -> Vec<u8> {
    build_transport_packet(
        PacketHeader {
            sequence: borrowed_sequence,
            flags: packet_flags::ACK_SEQUENCE,
            ..Default::default()
        },
        &acked.to_le_bytes(),
    )
}

/// net-2: ACE stamps its cleartext NAK with `CurrentValue` (a BORROWED id).
/// Data packet 6 was lost; ACE's NAK (seq 6) arrives first. It must not be
/// ordered as packet 6, must not ACK 6, and the real packet 6 must still be
/// delivered when it arrives.
#[tokio::test]
async fn test_cleartext_nak_does_not_consume_lost_data_sequence() {
    let transport = ScriptedTransport::new(
        vec![
            build_cleartext_nak_packet(6, &[3]),
            build_single_fragment_packet(6, &[0xAA, 0xBB]),
        ],
        "127.0.0.1:9000".parse().unwrap(),
    );
    let sent_handle = transport.clone();

    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    session.last_server_seq = 5;
    session.has_server_seq = true;

    let first = session.recv_message().await.unwrap();
    assert!(first.is_empty());
    assert_eq!(session.last_server_seq, 5, "a cleartext NAK must not consume a sequence");

    // Flush everything the NAK caused: no ACK may go out (ACE prunes its
    // retransmit cache below an ACK), only our own request for 6 (net-4 hint).
    force_pending_control_packets_due(&mut session);
    session.flush_pending_control_packets().await.unwrap();
    let sent_before_data = sent_handle.sent_packets().await;
    assert!(
        sent_before_data
            .iter()
            .all(|packet| unpack_header(packet).flags != packet_flags::ACK_SEQUENCE),
        "no ACK may be sent for the NAK's borrowed id"
    );
    let nak = sent_before_data
        .iter()
        .find(|packet| is_request_retransmit(packet))
        .expect("the borrowed id should be requested");
    assert_eq!(request_retransmit_ids(nak), vec![6]);

    let second = session.recv_message().await.unwrap();
    assert_eq!(second.len(), 1);
    assert!(matches!(second[0], SessionEvent::Message(ref msg) if msg == &vec![0xAA, 0xBB]));
    assert_eq!(session.last_server_seq, 6);
    assert_eq!(session.highest_server_seq_seen, None);

    // The data packet itself is ACKed, with the cumulative watermark.
    force_pending_control_packets_due(&mut session);
    session.flush_pending_control_packets().await.unwrap();
    let sent = sent_handle.sent_packets().await;
    let ack = sent
        .iter()
        .rev()
        .find(|packet| unpack_header(packet).flags == packet_flags::ACK_SEQUENCE)
        .expect("ordered data packet should be ACKed");
    assert_eq!(
        LittleEndian::read_u32(&ack[transport::HEADER_SIZE..transport::HEADER_SIZE + 4]),
        6
    );
}

/// net-2 sibling: NAK (borrowed 6) arrives while 5 and 6 are both still in
/// flight; both data packets are delivered in order.
#[tokio::test]
async fn test_cleartext_nak_ahead_of_two_data_packets_delivers_both() {
    let transport = ScriptedTransport::new(
        vec![
            build_cleartext_nak_packet(6, &[3]),
            build_single_fragment_packet(5, &[0x05]),
            build_single_fragment_packet(6, &[0x06]),
        ],
        "127.0.0.1:9000".parse().unwrap(),
    );

    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    session.last_server_seq = 4;
    session.has_server_seq = true;

    assert!(session.recv_message().await.unwrap().is_empty());
    assert_eq!(session.last_server_seq, 4);

    let five = session.recv_message().await.unwrap();
    assert!(matches!(five[0], SessionEvent::Message(ref msg) if msg == &vec![0x05]));
    let six = session.recv_message().await.unwrap();
    assert!(matches!(six[0], SessionEvent::Message(ref msg) if msg == &vec![0x06]));
    assert_eq!(session.last_server_seq, 6);
}

/// net-3: a gap wider than the reorder window is dropped (retail
/// SeqIDSanityCheck), never an `Err` that disconnects the session.
#[tokio::test]
async fn test_gap_wider_than_window_is_dropped_not_fatal() {
    use crate::session::types::MAX_RETRANSMIT_SEQUENCE_WINDOW;

    let transport = ScriptedTransport::new(vec![], "127.0.0.1:9000".parse().unwrap());
    let sent_handle = transport.clone();

    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    session.last_server_seq = 1;
    session.has_server_seq = true;

    session
        .send_request_retransmit(1 + 1 + MAX_RETRANSMIT_SEQUENCE_WINDOW + 10)
        .unwrap();
    assert!(session.pending_control_packets.is_empty());
    assert!(session.last_request_retransmit_time.is_none());
    assert!(!session.flush_pending_control_packets().await.unwrap());
    assert!(sent_handle.sent_packets().await.is_empty());
}

/// net-3: the same through the receive path. An ordered packet far past the
/// window used to surface as "Abnormal server packet sequence" (a
/// disconnect); now it is dropped and the loop keeps receiving.
#[tokio::test]
async fn test_gap_wider_than_window_packet_does_not_end_session() {
    use crate::session::types::MAX_RETRANSMIT_SEQUENCE_WINDOW;

    let far_sequence = 1 + MAX_RETRANSMIT_SEQUENCE_WINDOW + 10;
    let transport = ScriptedTransport::new(
        vec![build_transport_packet(
            PacketHeader {
                sequence: far_sequence,
                ..Default::default()
            },
            &[],
        )],
        "127.0.0.1:9000".parse().unwrap(),
    );
    let sent_handle = transport.clone();

    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    session.last_server_seq = 1;
    session.has_server_seq = true;

    let error = session.recv_message().await.unwrap_err();
    assert!(error.to_string().contains("Empty"), "unexpected error: {error}");
    assert!(!error.to_string().contains("Abnormal"));
    assert!(session.pending_server_packets.is_empty());
    assert!(
        sent_handle
            .sent_packets()
            .await
            .iter()
            .all(|packet| !is_request_retransmit(packet))
    );
}

/// net-4: ACE's ack-only packet carries `CurrentValue` (its last data
/// sequence). Newer than ours means packets were lost: NAK through AND
/// INCLUDING the borrowed id, without waiting for the next encrypted packet.
#[tokio::test]
async fn test_cleartext_ack_with_newer_sequence_naks_through_it() {
    let transport = ScriptedTransport::new(
        vec![build_ack_only_packet(7, 5)],
        "127.0.0.1:9000".parse().unwrap(),
    );
    let sent_handle = transport.clone();

    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    session.last_server_seq = 5;
    session.has_server_seq = true;

    let events = session.recv_message().await.unwrap();
    assert!(events.is_empty());
    assert_eq!(session.last_server_seq, 5);
    assert_eq!(session.highest_server_seq_seen, Some(7));

    assert!(session.flush_pending_control_packets().await.unwrap());
    let sent = sent_handle.sent_packets().await;
    let nak = sent
        .iter()
        .find(|packet| is_request_retransmit(packet))
        .expect("missing retransmit request packet");
    assert_eq!(unpack_header(nak).flags, packet_flags::REQUEST_RETRANSMIT);
    assert_eq!(request_retransmit_ids(nak), vec![6, 7]);
}

/// net-4: an ack-only packet that is NOT newer is no hint.
#[tokio::test]
async fn test_cleartext_ack_at_current_sequence_requests_nothing() {
    let transport = ScriptedTransport::new(
        vec![build_ack_only_packet(5, 5)],
        "127.0.0.1:9000".parse().unwrap(),
    );

    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    session.last_server_seq = 5;
    session.has_server_seq = true;

    assert!(session.recv_message().await.unwrap().is_empty());
    assert_eq!(session.highest_server_seq_seen, None);
    assert!(session.pending_control_packets.is_empty());
    assert!(session.next_retransmit_deadline().is_none());
}

/// net-4: a hint far beyond the window is ignored, never fatal.
#[tokio::test]
async fn test_cleartext_ack_hint_beyond_window_is_not_fatal() {
    use crate::session::types::MAX_RETRANSMIT_SEQUENCE_WINDOW;

    let transport = ScriptedTransport::new(
        vec![build_ack_only_packet(5 + MAX_RETRANSMIT_SEQUENCE_WINDOW + 100, 5)],
        "127.0.0.1:9000".parse().unwrap(),
    );

    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    session.last_server_seq = 5;
    session.has_server_seq = true;

    assert!(session.recv_message().await.unwrap().is_empty());
    assert_eq!(session.highest_server_seq_seen, None);
    assert!(session.pending_control_packets.is_empty());
}

/// net-4: a gap whose first request went out 700 ms ago (and was lost) is
/// re-requested by the receive loop itself, with no new arrival; the timer
/// then re-arms 600 ms out instead of spinning.
#[tokio::test]
async fn test_pending_gap_renaks_on_timer() {
    use crate::session::types::ReceivedPacket;

    let transport = ScriptedTransport::new(vec![], "127.0.0.1:9000".parse().unwrap());
    let sent_handle = transport.clone();

    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    session.last_server_seq = 5;
    session.has_server_seq = true;
    session.buffer_out_of_order_packet(
        8,
        ReceivedPacket {
            header: PacketHeader {
                sequence: 8,
                ..Default::default()
            },
            data: Vec::new(),
        },
    );
    assert_eq!(session.highest_server_seq_seen, Some(8));
    session.last_request_retransmit_time =
        Some(web_time::Instant::now() - std::time::Duration::from_millis(700));

    let error = session.recv_message().await.unwrap_err();
    assert!(error.to_string().contains("Empty"));

    let sent = sent_handle.sent_packets().await;
    let naks: Vec<_> = sent.iter().filter(|packet| is_request_retransmit(packet)).collect();
    assert_eq!(naks.len(), 1);
    // 8 is buffered, so only 6 and 7 are requested.
    assert_eq!(request_retransmit_ids(naks[0]), vec![6, 7]);

    let next = session
        .next_retransmit_deadline()
        .expect("gap still open, timer stays armed");
    assert!(next > web_time::Instant::now());
}

/// net-4: with a silent server the receive loop re-sends the request on the
/// 0.6 s cadence by itself — and does not busy-loop.
#[tokio::test]
async fn test_pending_gap_renaks_on_cadence_with_silent_server() {
    use crate::session::types::ReceivedPacket;

    let transport = SilentTransport::new();
    let sent_handle = transport.clone();

    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    session.last_server_seq = 5;
    session.has_server_seq = true;
    session.buffer_out_of_order_packet(
        8,
        ReceivedPacket {
            header: PacketHeader {
                sequence: 8,
                ..Default::default()
            },
            data: Vec::new(),
        },
    );
    // The first request just went out.
    session.last_request_retransmit_time = Some(web_time::Instant::now());

    let waited = tokio::time::timeout(
        std::time::Duration::from_millis(2000),
        session.recv_message(),
    )
    .await;
    assert!(waited.is_err(), "nothing was received, so recv must still be waiting");

    let sent = sent_handle.sent_packets().await;
    let naks: Vec<_> = sent.iter().filter(|packet| is_request_retransmit(packet)).collect();
    // Nominally at ~0.6 s, ~1.2 s and ~1.8 s.
    assert!(
        (2..=4).contains(&naks.len()),
        "expected 2-4 timer re-requests in 2 s, got {}",
        naks.len()
    );
    for nak in naks {
        assert_eq!(request_retransmit_ids(nak), vec![6, 7]);
    }
}

/// net-4: no gap, no timer (an idle in-order session must not wake up); and
/// the timer disarms once ordering catches up with the newest known id.
#[tokio::test]
async fn test_retransmit_timer_disarms_when_gap_closes() {
    let transport = ScriptedTransport::new(
        vec![
            build_single_fragment_packet(6, &[0x06]),
            build_single_fragment_packet(7, &[0x07]),
        ],
        "127.0.0.1:9000".parse().unwrap(),
    );

    let mut session = Session::new_test();
    assert!(session.next_retransmit_deadline().is_none());

    session.transport = Box::new(transport);
    session.last_server_seq = 5;
    session.has_server_seq = true;
    session.note_server_seq_seen(7);
    session.last_request_retransmit_time = Some(web_time::Instant::now());
    assert!(session.next_retransmit_deadline().is_some());

    session.recv_message().await.unwrap();
    assert_eq!(session.last_server_seq, 6);
    assert_eq!(session.highest_server_seq_seen, Some(7));

    session.recv_message().await.unwrap();
    assert_eq!(session.last_server_seq, 7);
    assert_eq!(session.highest_server_seq_seen, None);
    assert!(session.next_retransmit_deadline().is_none());
}

/// net-5: a server EchoRequest must not produce a packet that reuses the
/// server's sequence/id, burns a C2S ISAAC word, or lands in the C2S
/// retransmit cache. The packet is still ordered and ACKed normally.
#[tokio::test]
async fn test_server_echo_request_does_not_emit_packet_with_server_sequence() {
    let transport = ScriptedTransport::new(
        vec![build_transport_packet(
            PacketHeader {
                sequence: 2,
                flags: packet_flags::ECHO_REQUEST,
                id: 0x0B,
                ..Default::default()
            },
            &1.5f32.to_le_bytes(),
        )],
        "127.0.0.1:9000".parse().unwrap(),
    );
    let sent_handle = transport.clone();

    let seed = 0x99E7_7855;
    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    session.isaac_c2s = Some(holtburger_protocol::crypto::Isaac::new(seed));
    let c2s_key_before = session.isaac_c2s.as_ref().unwrap().current_key;

    let events = session.recv_message().await.unwrap();
    assert!(events.is_empty());
    assert_eq!(session.last_server_seq, 2);

    force_pending_control_packets_due(&mut session);
    session.flush_pending_control_packets().await.unwrap();

    let sent = sent_handle.sent_packets().await;
    assert!(
        sent.iter()
            .all(|packet| unpack_header(packet).flags & packet_flags::ECHO_RESPONSE == 0),
        "no EchoResponse packet may be emitted"
    );
    assert!(
        sent.iter().all(|packet| unpack_header(packet).sequence != 2),
        "nothing may go out under the server's sequence"
    );
    assert!(!session.cached_packets.contains_key(&2));
    assert_eq!(
        session.isaac_c2s.as_ref().unwrap().current_key,
        c2s_key_before,
        "no C2S ISAAC word may be consumed"
    );

    // The normal cleartext ACK for 2 still goes out.
    let ack = sent
        .iter()
        .find(|packet| unpack_header(packet).flags == packet_flags::ACK_SEQUENCE)
        .expect("ordered packet should still be ACKed");
    assert_eq!(
        LittleEndian::read_u32(&ack[transport::HEADER_SIZE..transport::HEADER_SIZE + 4]),
        2
    );
}

/// 2026-10-09 — `send_disconnect`: one cleartext, header-only packet with only
/// `DISCONNECT` (0x8000) set and the plain header checksum, which ACE accepts
/// and answers by terminating the session at once (`PacketHeaderDisconnect`)
/// instead of keeping it until the 60 s timeout.
#[tokio::test]
async fn test_send_disconnect_is_a_cleartext_header_only_disconnect() {
    let transport = ScriptedTransport::new(vec![], "127.0.0.1:9000".parse().unwrap());
    let sent_handle = transport.clone();
    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    session.client_id = 0x1234;

    session.send_disconnect().await.unwrap();

    let sent = sent_handle.sent_entries().await;
    assert_eq!(sent.len(), 1, "exactly one packet");
    let (addr, bytes) = &sent[0];
    assert_eq!(*addr, "127.0.0.1:9000".parse::<SocketAddr>().unwrap());
    assert_eq!(bytes.len(), transport::HEADER_SIZE, "header only");
    let header = unpack_header(bytes);
    assert_eq!(header.flags, packet_flags::DISCONNECT, "no encrypted checksum, no other flag");
    assert_eq!(header.size, 0);
    assert_eq!(header.id, 0x1234);
    // The same plain checksum the test packet builder (and ACE's VerifyCRC
    // for a cleartext packet) computes: header hash + empty payload hash.
    let mut expect = header.clone();
    expect.checksum = 0;
    let payload_hash = session.calculate_payload_hash(header.flags, &[]).unwrap();
    assert_eq!(header.checksum, expect.calculate_checksum().wrapping_add(payload_hash));
}
