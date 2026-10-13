//! net-transport-6 (2026-10-13): the session feeds retail's Link Status
//! packet counters (`crate::link_status`) from its real send, retransmit and
//! receive paths — `ClientNet::AddToPerfCounter` (acclient.c:370154) counters
//! 9 (sent, retransmissions included), 10 (re-sent for the server's NAK) and
//! 3/4/5 (checksum-valid packets received). Kept in its own module so the
//! helpers stay local; they mirror the ones in `tests.rs`.

use super::{Session, Transport};
use anyhow::{Result, anyhow};
use async_trait::async_trait;
use holtburger_protocol::messages::transport::{self, packet_flags};
use holtburger_protocol::messages::*;
use holtburger_protocol::traits::ProtocolPack;
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use web_time::Instant;

#[derive(Clone)]
struct ScriptedTransport {
    sent: Arc<Mutex<Vec<Vec<u8>>>>,
    recv: Arc<Mutex<VecDeque<Vec<u8>>>>,
}

impl ScriptedTransport {
    fn new(recv_packets: Vec<Vec<u8>>) -> Self {
        Self {
            sent: Arc::new(Mutex::new(Vec::new())),
            recv: Arc::new(Mutex::new(recv_packets.into_iter().collect())),
        }
    }

    async fn sent_count(&self) -> usize {
        self.sent.lock().await.len()
    }
}

#[async_trait]
impl Transport for ScriptedTransport {
    async fn send_to(&self, buf: &[u8], _addr: SocketAddr) -> Result<usize> {
        self.sent.lock().await.push(buf.to_vec());
        Ok(buf.len())
    }

    async fn recv_from(&self, buf: &mut [u8]) -> Result<(usize, SocketAddr)> {
        let Some(data) = self.recv.lock().await.pop_front() else {
            return Err(anyhow!("Empty"));
        };
        buf[..data.len()].copy_from_slice(&data);
        Ok((data.len(), "127.0.0.1:9000".parse().unwrap()))
    }
}

/// A cleartext server packet with a valid (unencrypted) checksum.
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
            ..Default::default()
        },
        &body,
    )
}

/// The server's cleartext NAK for C2S `sequences` (ACE borrows its last data
/// sequence for it).
fn build_nak_packet(borrowed_sequence: u32, sequences: &[u32]) -> Vec<u8> {
    let mut payload = (sequences.len() as u32).to_le_bytes().to_vec();
    for sequence in sequences {
        payload.extend_from_slice(&sequence.to_le_bytes());
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

fn session_with(transport: &ScriptedTransport) -> Session {
    let mut session = Session::new_test();
    session.transport = Box::new(transport.clone());
    session
}

#[tokio::test]
async fn sent_packets_are_counted() {
    let transport = ScriptedTransport::new(Vec::new());
    let mut session = session_with(&transport);

    session.send_ack(1).await.unwrap();
    session.send_disconnect().await.unwrap();

    assert_eq!(transport.sent_count().await, 2);
    assert_eq!(session.link_status.current().pkts_sent, 2);
    assert_eq!(session.link_status.current().pkts_received, 0);
    assert_eq!(session.link_status.current().pkts_retransmitted, 0);
}

#[tokio::test]
async fn a_nak_counts_one_retransmission_and_the_resend_as_sent() {
    let requested = 9u32;
    let transport = ScriptedTransport::new(vec![build_nak_packet(12, &[requested])]);
    let mut session = session_with(&transport);

    // The C2S packet the server will NAK (cached for retransmit).
    session
        .send_packet(
            PacketHeader {
                sequence: requested,
                flags: packet_flags::BLOB_FRAGMENTS,
                id: session.client_id,
                ..Default::default()
            },
            &[0xAA, 0xBB, 0xCC, 0xDD],
        )
        .await
        .unwrap();

    // The NAK arrives on the validated path and queues the retransmission.
    let events = session.recv_message().await.unwrap();
    assert!(events.is_empty());
    assert!(session.flush_pending_control_packets().await.unwrap());
    assert_eq!(transport.sent_count().await, 2, "original + retransmission");

    let snap = session.link_status.current();
    assert_eq!(snap.pkts_sent, 2, "the retransmission is a sent packet too");
    assert_eq!(snap.pkts_retransmitted, 1);
    assert_eq!(snap.pkts_received, 1, "the NAK packet itself");
    assert_eq!(snap.pkts_naked, 0, "retail never counts counter 6");

    // Fold the snapshot in (the clock was armed by the first send moments
    // ago): retail GetAveragePacketLoss = 2 * 1 / (1 received + 2 sent).
    assert!(
        session
            .link_status
            .heartbeat(Instant::now() + Duration::from_secs(3))
    );
    assert_eq!(session.link_status.packet_loss(), (2.0f64 / 3.0) as f32);
}

#[tokio::test]
async fn a_nak_for_an_uncached_packet_counts_no_retransmission() {
    // Retail answers it with an EmptyAck and counts nothing
    // (`FlowQueue::TransmitAcks`).
    let transport = ScriptedTransport::new(vec![build_nak_packet(12, &[77])]);
    let mut session = session_with(&transport);

    session.recv_message().await.unwrap();
    session.flush_pending_control_packets().await.unwrap();

    let snap = session.link_status.current();
    assert_eq!(snap.pkts_retransmitted, 0);
    assert_eq!(snap.pkts_received, 1);
}

#[tokio::test]
async fn only_checksum_valid_packets_count_as_received() {
    let mut corrupt = build_single_fragment_packet(2, &[1, 2, 3]);
    corrupt[8] ^= 0xFF; // PacketHeader.checksum is bytes 8..12
    let transport = ScriptedTransport::new(vec![corrupt]);
    let mut session = session_with(&transport);

    // Dropped, then the scripted socket runs dry.
    assert!(session.recv_message().await.is_err());
    assert_eq!(session.link_status.current().pkts_received, 0);

    let transport = ScriptedTransport::new(vec![build_single_fragment_packet(2, &[1, 2, 3])]);
    let mut session = session_with(&transport);
    let events = session.recv_message().await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(session.link_status.current().pkts_received, 1);
}

#[tokio::test]
async fn a_clean_link_reports_zero_loss() {
    let transport = ScriptedTransport::new(vec![build_single_fragment_packet(2, &[1, 2, 3])]);
    let mut session = session_with(&transport);

    session.send_ack(1).await.unwrap();
    session.recv_message().await.unwrap();
    assert!(
        session
            .link_status
            .heartbeat(Instant::now() + Duration::from_secs(3))
    );
    assert_eq!(session.link_status.packet_loss(), 0.0);
}
