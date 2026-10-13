//! net-transport-4 (2026-10-13): a server RejectRetransmit (retail EmptyAck)
//! must let ordering step over the rejected S2C id instead of stalling every
//! later packet until the retransmit give-up ends the session (retail
//! `SharedNet::HandleEmptyAck`, acclient.c:372177). Kept in its own module so
//! the helpers stay local; they mirror the ones in `tests.rs`.

use super::types::{MAX_RETRANSMIT_SEQUENCE_WINDOW, RETRANSMIT_GIVE_UP_REQUESTS};
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

    async fn sent_packets(&self) -> Vec<Vec<u8>> {
        self.sent.lock().await.clone()
    }
}

#[async_trait]
impl Transport for ScriptedTransport {
    async fn send_to(&self, buf: &[u8], _addr: SocketAddr) -> Result<usize> {
        self.sent.lock().await.push(buf.to_vec());
        Ok(buf.len())
    }

    async fn recv_from(&self, buf: &mut [u8]) -> Result<(usize, SocketAddr)> {
        let mut recv = self.recv.lock().await;
        let Some(data) = recv.pop_front() else {
            return Err(anyhow!("Empty"));
        };
        buf[..data.len()].copy_from_slice(&data);
        Ok((data.len(), "127.0.0.1:9000".parse().unwrap()))
    }
}

fn scripted_session(recv_packets: Vec<Vec<u8>>) -> (Session, ScriptedTransport) {
    let transport = ScriptedTransport::new(recv_packets);
    let handle = transport.clone();
    let mut session = Session::new_test();
    session.transport = Box::new(transport);
    (session, handle)
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

/// ACE `PacketRejectRetransmit`: cleartext, `RejectRetransmit` only, and its
/// own fresh sequence (`FlushPackets` gives it `NextValue`).
fn build_reject_retransmit_packet(sequence: u32, rejected: &[u32]) -> Vec<u8> {
    let mut payload = (rejected.len() as u32).to_le_bytes().to_vec();
    for id in rejected {
        payload.extend_from_slice(&id.to_le_bytes());
    }
    build_transport_packet(
        PacketHeader {
            sequence,
            flags: packet_flags::REJECT_RETRANSMIT,
            ..Default::default()
        },
        &payload,
    )
}

fn unpack_header(packet: &[u8]) -> PacketHeader {
    let mut offset = 0;
    PacketHeader::unpack(packet, &mut offset).expect("packet header should unpack")
}

fn is_request_retransmit(packet: &[u8]) -> bool {
    (unpack_header(packet).flags & packet_flags::REQUEST_RETRANSMIT) != 0
}

fn request_retransmit_ids(packet: &[u8]) -> Vec<u32> {
    let payload = &packet[transport::HEADER_SIZE..];
    let count = LittleEndian::read_u32(&payload[0..4]) as usize;
    (0..count)
        .map(|index| LittleEndian::read_u32(&payload[4 + index * 4..8 + index * 4]))
        .collect()
}

fn force_pending_control_packets_due(session: &mut Session) {
    for pending in session.pending_control_packets.iter_mut() {
        pending.ready_at = web_time::Instant::now();
    }
}

fn single_message(events: &[SessionEvent]) -> Vec<u8> {
    assert_eq!(events.len(), 1, "expected exactly one message");
    match &events[0] {
        SessionEvent::Message(msg) => msg.clone(),
        other => panic!("expected a message, got {other:?}"),
    }
}

/// Test plan (a): 5 is lost and ACE no longer holds it; 6..8 are buffered
/// behind it; the reject for [5] arrives with its own fresh sequence 9. All of
/// 6, 7, 8 and the reject are delivered in order, nothing gives up, and the
/// cumulative ACK covers 9. Before the fix 6..9 sat in the buffer until the
/// 0.6 s re-NAK hit the 300-request give-up (~180 s) and ended the session.
#[tokio::test]
async fn test_reject_retransmit_skips_lost_id_and_delivers_buffered_packets() {
    let (mut session, sent_handle) = scripted_session(vec![
        build_single_fragment_packet(6, &[0x06]),
        build_single_fragment_packet(7, &[0x07]),
        build_single_fragment_packet(8, &[0x08]),
        build_reject_retransmit_packet(9, &[5]),
    ]);
    session.last_server_seq = 4;
    session.has_server_seq = true;
    // One request short of the give-up: the NAK for 5 brings it to the brink,
    // so any further request for 5 would end the session.
    session.retransmit_requests_since_progress = RETRANSMIT_GIVE_UP_REQUESTS - 1;

    let six = session.recv_message().await.unwrap();
    assert_eq!(single_message(&six), vec![0x06]);
    assert_eq!(session.last_server_seq, 6);
    assert!(session.lost_server_seqs.is_empty(), "5 was skipped and forgotten");
    assert_eq!(session.retransmit_requests_since_progress, 0);

    let seven = session.recv_message().await.unwrap();
    assert_eq!(single_message(&seven), vec![0x07]);
    let eight = session.recv_message().await.unwrap();
    assert_eq!(single_message(&eight), vec![0x08]);

    // The reject packet is ordered under its own sequence and carries no blob.
    let reject = session.recv_message().await.unwrap();
    assert!(reject.is_empty());
    assert_eq!(session.last_server_seq, 9);
    assert_eq!(session.highest_server_seq_seen, None);
    assert!(session.pending_server_packets.is_empty());
    assert!(session.next_retransmit_deadline().is_none());

    // Nothing left: the transport runs dry, which is not a give-up.
    let error = session.recv_message().await.unwrap_err();
    assert!(error.to_string().contains("Empty"), "unexpected error: {error}");

    force_pending_control_packets_due(&mut session);
    session.flush_pending_control_packets().await.unwrap();
    let sent = sent_handle.sent_packets().await;
    let naks: Vec<_> = sent.iter().filter(|packet| is_request_retransmit(packet)).collect();
    assert_eq!(naks.len(), 1, "5 is requested once and never again after the reject");
    assert_eq!(request_retransmit_ids(naks[0]), vec![5]);
    let ack = sent
        .iter()
        .rev()
        .find(|packet| unpack_header(packet).flags == packet_flags::ACK_SEQUENCE)
        .expect("ordered packets should be ACKed");
    assert_eq!(
        LittleEndian::read_u32(&ack[transport::HEADER_SIZE..transport::HEADER_SIZE + 4]),
        9
    );
}

/// Test plan (b), through the receive path: a reject naming an id that was
/// already delivered (6) or is already buffered (8) changes nothing, and the
/// buffered packet is still delivered.
#[tokio::test]
async fn test_reject_retransmit_for_received_ids_is_ignored() {
    let (mut session, _sent_handle) = scripted_session(vec![
        build_single_fragment_packet(8, &[0x08]),
        build_reject_retransmit_packet(7, &[6, 8]),
    ]);
    session.last_server_seq = 6;
    session.has_server_seq = true;

    let reject = session.recv_message().await.unwrap();
    assert!(reject.is_empty());
    assert_eq!(session.last_server_seq, 7);
    assert!(session.lost_server_seqs.is_empty());

    let eight = session.recv_message().await.unwrap();
    assert_eq!(single_message(&eight), vec![0x08]);
    assert_eq!(session.last_server_seq, 8);
}

/// Test plan (b), the filter itself: only ids that are ahead of ordering,
/// inside the reorder window and not already buffered are recorded.
#[test]
fn test_note_rejected_server_sequences_filters_received_and_out_of_window_ids() {
    use super::types::ReceivedPacket;

    let mut session = Session::new_test();
    session.last_server_seq = 6;
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

    let beyond_window = 7 + MAX_RETRANSMIT_SEQUENCE_WINDOW + 5;
    session.note_rejected_server_sequences(&[3, 6, 8, beyond_window, 9]);
    assert_eq!(session.lost_server_seqs.iter().copied().collect::<Vec<_>>(), vec![9]);
}

/// Test plan (c): a later timer re-NAK leaves rejected ids out, and a rejected
/// id at the head of the gap is stepped over before the request is built.
#[tokio::test]
async fn test_renak_omits_rejected_ids() {
    use super::types::ReceivedPacket;

    let (mut session, sent_handle) = scripted_session(vec![]);
    session.last_server_seq = 4;
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
    session.note_rejected_server_sequences(&[5, 7]);
    session.last_request_retransmit_time =
        Some(web_time::Instant::now() - std::time::Duration::from_millis(700));

    let error = session.recv_message().await.unwrap_err();
    assert!(error.to_string().contains("Empty"), "unexpected error: {error}");
    assert_eq!(session.last_server_seq, 5, "rejected 5 is stepped over");

    let sent = sent_handle.sent_packets().await;
    let naks: Vec<_> = sent.iter().filter(|packet| is_request_retransmit(packet)).collect();
    assert_eq!(naks.len(), 1);
    // 5 skipped, 7 rejected, 8 buffered: only 6 is still worth asking for.
    assert_eq!(request_retransmit_ids(naks[0]), vec![6]);
}

/// Test plan (c), the builder: a gap made only of rejected and buffered ids
/// queues no request and does not count toward the give-up.
#[test]
fn test_request_retransmit_with_nothing_left_to_ask_sends_nothing() {
    use super::types::ReceivedPacket;

    let mut session = Session::new_test();
    session.last_server_seq = 4;
    session.has_server_seq = true;
    session.buffer_out_of_order_packet(
        6,
        ReceivedPacket {
            header: PacketHeader {
                sequence: 6,
                ..Default::default()
            },
            data: Vec::new(),
        },
    );
    session.note_rejected_server_sequences(&[5]);

    assert!(!session.send_request_retransmit(7).unwrap());
    assert!(session.pending_control_packets.is_empty());
    assert!(session.last_request_retransmit_time.is_none());
    assert_eq!(session.retransmit_requests_since_progress, 0);
}

/// A rejected id whose packet turns up after all (an earlier copy still in
/// flight) before ordering reaches it is held and delivered, not skipped.
#[tokio::test]
async fn test_rejected_id_that_arrives_late_is_delivered() {
    let (mut session, _sent_handle) = scripted_session(vec![
        build_single_fragment_packet(6, &[0x06]),
        build_single_fragment_packet(5, &[0x05]),
    ]);
    session.last_server_seq = 4;
    session.has_server_seq = true;
    session.note_rejected_server_sequences(&[6]);

    let five = session.recv_message().await.unwrap();
    assert_eq!(single_message(&five), vec![0x05]);
    let six = session.recv_message().await.unwrap();
    assert_eq!(single_message(&six), vec![0x06]);
    assert_eq!(session.last_server_seq, 6);
    assert!(session.lost_server_seqs.is_empty());
}

/// The skip does the same ordering bookkeeping as a delivered packet: it
/// advances over a run of rejected ids, resets the give-up counter and
/// disarms the re-NAK timer once ordering reaches the newest known id.
#[test]
fn test_skip_lost_server_sequences_bookkeeping() {
    let mut session = Session::new_test();
    session.last_server_seq = 4;
    session.note_server_seq_seen(6);
    session.note_rejected_server_sequences(&[5, 6, 8]);
    session.retransmit_requests_since_progress = 123;

    session.skip_lost_server_sequences();

    assert_eq!(session.last_server_seq, 6, "stops at 7, which is not rejected");
    assert!(session.has_server_seq);
    assert_eq!(session.lost_server_seqs.iter().copied().collect::<Vec<_>>(), vec![8]);
    assert_eq!(session.retransmit_requests_since_progress, 0);
    assert_eq!(session.highest_server_seq_seen, None);
}
