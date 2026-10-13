use super::types::{
    CachedPacket, MAX_CACHED_PACKETS, MAX_PENDING_SERVER_PACKETS, MAX_RETRANSMIT_SEQUENCE_IDS,
    MAX_RETRANSMIT_SEQUENCE_WINDOW, REQUEST_RETRANSMIT_INTERVAL, RETRANSMIT_GIVE_UP_REQUESTS,
    ReceivedPacket, Session,
};
use crate::optional_header::OptionalHeaderCursor;
use anyhow::{Result, anyhow};
use byteorder::{ByteOrder, LittleEndian};
use holtburger_common::sequence::is_newer_u32;
use holtburger_protocol::messages::transport::{self, packet_flags};
use holtburger_protocol::messages::*;
use holtburger_protocol::traits::{ProtocolPack, ProtocolUnpack};
use web_time::Instant;

impl Session {
    pub(crate) fn maybe_cache_packet(
        &mut self,
        header: &PacketHeader,
        packet: &[u8],
        addr: std::net::SocketAddr,
    ) {
        if header.sequence < 2 || (header.flags & packet_flags::REQUEST_RETRANSMIT) != 0 {
            return;
        }

        self.cached_packets
            .entry(header.sequence)
            .or_insert(CachedPacket {
                addr,
                bytes: packet.to_vec(),
            });

        while self.cached_packets.len() > MAX_CACHED_PACKETS {
            let Some((&oldest_sequence, _)) = self.cached_packets.first_key_value() else {
                break;
            };
            self.cached_packets.remove(&oldest_sequence);
        }
    }

    // A02-F8 verify (2026-07-10): ACE stamps its outgoing AckSequence with
    // `lastReceivedPacketSequence` (NetworkSession.cs:929 — INCLUSIVE
    // received), so strictly-greater retention would suffice. Kept at `>=`
    // deliberately: ACE's own retransmit-cache prune uses the identical rule
    // (`cachedPackets.Keys.Where(x => x < sequence)` removed,
    // NetworkSession.cs:669) — we mirror the reference implementation at the
    // cost of retaining at most ONE already-acked packet (≤1 KB).
    pub(crate) fn acknowledge_sequence(&mut self, sequence: u32) {
        self.cached_packets
            .retain(|cached_sequence, _| *cached_sequence >= sequence);
    }

    pub(crate) fn current_client_sequence(&self) -> u32 {
        self.packet_sequence.saturating_sub(1)
    }

    /// Rust review 2026-08-03 (F-sweep): bounded insert into the out-of-order
    /// S2C reorder buffer. Replaces two identical bare
    /// `pending_server_packets.entry(seq).or_insert(packet)` call sites in
    /// `receive.rs`, which had no size limit of any kind — see
    /// [`MAX_PENDING_SERVER_PACKETS`].
    ///
    /// Two bounds, in order:
    /// 1. Drop anything further ahead than the retransmit window. We could
    ///    never close such a gap anyway — `send_request_retransmit` refuses
    ///    `missing_span > MAX_RETRANSMIT_SEQUENCE_WINDOW + 1` — so holding the
    ///    packet only costs memory.
    /// 2. An explicit ceiling, mirroring `maybe_cache_packet`'s
    ///    `MAX_CACHED_PACKETS` prune. Evicts the HIGHEST sequence, not the
    ///    lowest: the entries nearest `expected` are the ones about to be
    ///    consumed by `take_pending_server_packet`.
    pub(crate) fn buffer_out_of_order_packet(&mut self, sequence: u32, packet: ReceivedPacket) {
        let expected = self.last_server_seq.wrapping_add(1);
        if sequence.wrapping_sub(expected) > MAX_RETRANSMIT_SEQUENCE_WINDOW {
            log::debug!(
                "dropping S2C packet {} — more than {} ahead of expected {}",
                sequence,
                MAX_RETRANSMIT_SEQUENCE_WINDOW,
                expected
            );
            return;
        }

        // net-4: a buffered packet proves `sequence` exists, so the gap below
        // it stays armed for the timer-driven re-NAK.
        self.note_server_seq_seen(sequence);

        // net-transport-4: a rejected id that turns up after all (an earlier
        // copy still in flight) is held like any other, not skipped over.
        self.lost_server_seqs.remove(&sequence);

        self.pending_server_packets
            .entry(sequence)
            .or_insert(packet);

        while self.pending_server_packets.len() > MAX_PENDING_SERVER_PACKETS {
            let Some((&highest, _)) = self.pending_server_packets.last_key_value() else {
                break;
            };
            self.pending_server_packets.remove(&highest);
        }
    }

    pub(crate) fn read_ack_sequence(&self, flags: u32, data: &[u8]) -> Option<u32> {
        let offset =
            OptionalHeaderCursor::new(data, flags).find_flag_offset(packet_flags::ACK_SEQUENCE)?;
        (offset + transport::ACK_SEQUENCE_SIZE <= data.len())
            .then(|| LittleEndian::read_u32(&data[offset..offset + transport::ACK_SEQUENCE_SIZE]))
    }

    pub(crate) fn read_sequence_list(
        &self,
        flags: u32,
        data: &[u8],
        flag: u32,
    ) -> Option<Vec<u32>> {
        let offset = OptionalHeaderCursor::new(data, flags).find_flag_offset(flag)?;
        if offset + 4 > data.len() {
            return None;
        }

        let count = LittleEndian::read_u32(&data[offset..offset + 4]) as usize;
        if count > MAX_RETRANSMIT_SEQUENCE_IDS {
            return None;
        }
        let values_offset = offset + 4;
        let values_len = count.checked_mul(4)?;
        if values_offset + values_len > data.len() {
            return None;
        }

        let mut sequences = Vec::with_capacity(count);
        for index in 0..count {
            let start = values_offset + (index * 4);
            sequences.push(LittleEndian::read_u32(&data[start..start + 4]));
        }
        Some(sequences)
    }

    pub(crate) fn retransmit_sequences(&mut self, sequences: &[u32]) -> Result<()> {
        let mut retransmitted: u16 = 0;
        for sequence in sequences {
            let Some(cached_packet) = self.cached_packets.get(sequence).cloned() else {
                log::warn!(
                    "Server requested retransmit for uncached C2S packet {}",
                    sequence
                );
                continue;
            };

            log::debug!("Retransmitting cached C2S packet {}", sequence);
            let retransmission_packet = self.build_retransmission_packet(&cached_packet.bytes)?;
            self.queue_prebuilt_control_packet(
                retransmission_packet,
                cached_packet.addr,
                Instant::now(),
            );
            retransmitted = retransmitted.wrapping_add(1);
        }

        // net-transport-6 (2026-10-13): retail counter 10 —
        // `FlowQueue::TransmitAcks` adds the number of packets it re-sends
        // for the peer's NAK (the packet-loss numerator). Each one is counted
        // as sent again when it is flushed through `send_raw_packet`.
        if retransmitted > 0 {
            self.link_status.count_retransmitted(retransmitted);
        }

        Ok(())
    }

    pub(crate) fn build_retransmission_packet(&self, packet: &[u8]) -> Result<Vec<u8>> {
        let mut offset = 0;
        let mut header = PacketHeader::unpack(packet, &mut offset)
            .ok_or_else(|| anyhow!("Failed to unpack cached packet header"))?;
        let payload = &packet[transport::HEADER_SIZE..];
        let was_encrypted = (header.flags & packet_flags::ENCRYPTED_CHECKSUM) != 0;
        let original_header_hash = header.calculate_checksum();
        let payload_hash = self.calculate_payload_hash(header.flags, payload)?;
        let isaac_key = if was_encrypted {
            Some(payload_hash ^ header.checksum.wrapping_sub(original_header_hash))
        } else {
            None
        };

        header.flags |= packet_flags::RETRANSMISSION;
        let new_header_hash = header.calculate_checksum();
        header.checksum = if let Some(isaac_key) = isaac_key {
            new_header_hash.wrapping_add(payload_hash ^ isaac_key)
        } else {
            new_header_hash.wrapping_add(payload_hash)
        };

        let mut retransmission_packet = Vec::with_capacity(packet.len());
        header.pack(&mut retransmission_packet);
        retransmission_packet.extend_from_slice(payload);
        Ok(retransmission_packet)
    }

    /// `true` when a RequestRetransmit for `[last_server_seq + 1,
    /// received_sequence)` is well-formed and inside the reorder window.
    pub(crate) fn retransmit_span_in_window(&self, received_sequence: u32) -> bool {
        let desired_sequence = self.last_server_seq.wrapping_add(1);
        is_newer_u32(received_sequence, desired_sequence)
            && received_sequence.wrapping_sub(desired_sequence)
                <= MAX_RETRANSMIT_SEQUENCE_WINDOW + 1
    }

    /// net-4 (R2-net 2026-10-08): record that S2C `sequence` is known to
    /// exist (retail `SharedNet::ProcessNewestSeqNum` raising
    /// `highestIDReceived_`, acclient.c:369054). Only sequences ahead of
    /// `last_server_seq` matter; the newest one wins.
    pub(crate) fn note_server_seq_seen(&mut self, sequence: u32) {
        if !is_newer_u32(sequence, self.last_server_seq) {
            return;
        }
        match self.highest_server_seq_seen {
            Some(highest) if !is_newer_u32(sequence, highest) => {}
            _ => self.highest_server_seq_seen = Some(sequence),
        }
    }

    /// net-transport-4 (2026-10-13): the server answered a RequestRetransmit
    /// with a RejectRetransmit (retail's EmptyAck) for `sequences`. It no
    /// longer holds those packets and will never resend them. Retail removes
    /// each id from its NAK set (`SharedNet::HandleEmptyAck`,
    /// acclient.c:372177); here they are recorded so ordering steps over them
    /// ([`Self::skip_lost_server_sequences`]) and later re-NAKs leave them
    /// out (WebAC `OrderedPacketBuffer.markLost` does the same).
    ///
    /// Ids already ordered or already buffered are ignored (we have them), as
    /// are ids outside the reorder window, which ordering could never reach.
    ///
    /// Known cost: when a later packet's key search walked past a lost
    /// ENCRYPTED packet's ISAAC key, that key was parked in `Isaac::xors`, and
    /// nothing will ever consume it, so each such loss shortens the S2C search
    /// reach (`Isaac::MAXIMUM_EFFORT_LEVEL`) by one word. Retail parks one key
    /// per NAKed id and frees it here; the flat key set cannot tell which key
    /// was the lost id's. Bounded, and the trigger (a hole that outlives ACE's
    /// 120 s retransmit cache) is rare.
    pub(crate) fn note_rejected_server_sequences(&mut self, sequences: &[u32]) {
        let expected = self.last_server_seq.wrapping_add(1);
        for &sequence in sequences {
            if !is_newer_u32(sequence, self.last_server_seq)
                || sequence.wrapping_sub(expected) > MAX_RETRANSMIT_SEQUENCE_WINDOW
                || self.pending_server_packets.contains_key(&sequence)
            {
                log::debug!(
                    "Ignoring retransmit reject for S2C {}: already received or outside the window above {}",
                    sequence,
                    self.last_server_seq
                );
                continue;
            }
            self.lost_server_seqs.insert(sequence);
        }
    }

    /// net-transport-4: step ordering over rejected ids at the head of the
    /// queue, delivering nothing for them, so the packets buffered behind
    /// them flow again. Same bookkeeping as an ordered packet in
    /// `finalize_ordered_server_packet` (progress resets the give-up counter;
    /// the re-NAK timer disarms once ordering reaches the newest known id),
    /// minus the ACK: the reject itself carries a newer sequence, and its
    /// cumulative ACK covers the skipped ids. Fragment groups the lost packet
    /// left incomplete age out through the reassembler's group cap.
    pub(crate) fn skip_lost_server_sequences(&mut self) {
        loop {
            let expected = self.last_server_seq.wrapping_add(1);
            if !self.lost_server_seqs.remove(&expected) {
                return;
            }
            log::warn!(
                "Skipping S2C packet {}: the server rejected its retransmit, so its messages are lost",
                expected
            );
            self.last_server_seq = expected;
            self.has_server_seq = true;
            self.retransmit_requests_since_progress = 0;
            if let Some(highest) = self.highest_server_seq_seen
                && !is_newer_u32(highest, self.last_server_seq)
            {
                self.highest_server_seq_seen = None;
            }
        }
    }

    /// net-4: when the next timer-driven RequestRetransmit is due, or `None`
    /// when no gap is open (so an idle, in-order session never arms a timer).
    pub(crate) fn next_retransmit_deadline(&self) -> Option<Instant> {
        let highest = self.highest_server_seq_seen?;
        if !is_newer_u32(highest, self.last_server_seq) {
            return None;
        }
        Some(match self.last_request_retransmit_time {
            Some(last_request) => last_request + REQUEST_RETRANSMIT_INTERVAL,
            None => Instant::now(),
        })
    }

    /// net-4 (R2-net 2026-10-08): re-send the RequestRetransmit for an open
    /// gap on the [`REQUEST_RETRANSMIT_INTERVAL`] timer, independent of new
    /// arrivals. Retail runs `SharedNet::EnqueueNaks` every net pump while
    /// the NAK set is non-empty (`ClientNet::ProcessConnection`,
    /// acclient.c:372842), gated at 0.6 s (acclient.c:371458). Previously a
    /// lost retransmission was only re-requested if some later out-of-order
    /// packet happened to arrive.
    ///
    /// Returns `Ok(true)` when a request was queued. Never leaves a due
    /// deadline in place without sending: an un-requestable gap is disarmed
    /// instead, so the receive loop's timer cannot spin.
    pub(crate) fn resend_request_retransmit_if_due(&mut self) -> Result<bool> {
        let Some(deadline) = self.next_retransmit_deadline() else {
            return Ok(false);
        };
        if Instant::now() < deadline {
            return Ok(false);
        }
        let Some(highest) = self.highest_server_seq_seen else {
            return Ok(false);
        };
        // `highest + 1` makes the [desired, received) builder include
        // `highest` itself; ids already buffered are skipped by the builder.
        let target = highest.wrapping_add(1);
        if !self.retransmit_span_in_window(target) {
            self.highest_server_seq_seen = None;
            return Ok(false);
        }
        if !self.send_request_retransmit(target)? {
            // net-transport-4: every id in the gap is buffered or rejected,
            // so there was nothing to ask for. Re-arm the timer one interval
            // out rather than leave a due deadline that would spin the loop.
            self.last_request_retransmit_time = Some(Instant::now());
            return Ok(false);
        }
        Ok(true)
    }

    /// Queue a RequestRetransmit for the missing ids in `[last_server_seq +
    /// 1, received_sequence)`. `Ok(true)` when one was queued; `Ok(false)`
    /// when the span is out of window or (net-transport-4) every id in it is
    /// already buffered or was rejected by the server.
    pub(crate) fn send_request_retransmit(&mut self, received_sequence: u32) -> Result<bool> {
        let desired_sequence = self.last_server_seq.wrapping_add(1);

        // net-3 (R2-net 2026-10-08): was an `Err` ("Abnormal server packet
        // sequence"), which `recv_message` propagates and the client treats
        // as a disconnect. Retail's `SharedNet::SeqIDSanityCheck`
        // (acclient.c:371343) drops an out-of-window packet and keeps the
        // session; do the same. A gap this wide cannot be closed anyway, and
        // a session that really is wedged is reaped by the client's
        // inbound-silence detector.
        if !self.retransmit_span_in_window(received_sequence) {
            log::warn!(
                "Not requesting retransmit: S2C sequence {} is outside the {}-packet window above expected {}",
                received_sequence,
                MAX_RETRANSMIT_SEQUENCE_WINDOW,
                desired_sequence
            );
            return Ok(false);
        }

        // net-transport-4: an id the server rejected is never asked for again
        // (retail `SharedNet::HandleEmptyAck` drops it from the NAK set).
        let mut needed_sequences = Vec::with_capacity(MAX_RETRANSMIT_SEQUENCE_IDS);
        let mut sequence = desired_sequence;
        while sequence != received_sequence {
            if !self.pending_server_packets.contains_key(&sequence)
                && !self.lost_server_seqs.contains(&sequence)
            {
                needed_sequences.push(sequence);
                if needed_sequences.len() >= MAX_RETRANSMIT_SEQUENCE_IDS {
                    break;
                }
            }
            sequence = sequence.wrapping_add(1);
        }
        if needed_sequences.is_empty() {
            log::debug!(
                "Not requesting retransmit: every S2C id below {} is buffered or rejected",
                received_sequence
            );
            return Ok(false);
        }

        let mut payload = Vec::with_capacity(4 + (needed_sequences.len() * 4));
        payload.extend_from_slice(&(needed_sequences.len() as u32).to_le_bytes());
        for sequence in &needed_sequences {
            payload.extend_from_slice(&sequence.to_le_bytes());
        }

        log::debug!(
            "Requesting retransmit of S2C packets {:?}",
            needed_sequences
        );
        self.queue_deferred_cleartext_control_packet(
            PacketHeader {
                flags: packet_flags::REQUEST_RETRANSMIT,
                id: self.client_id,
                ..Default::default()
            },
            &payload,
            self.server_addr,
            Instant::now(),
            true,
        )?;
        self.last_request_retransmit_time = Some(Instant::now());
        // conn-fix (2026-07-18): count consecutive requests; reset in
        // finalize_ordered_server_packet on any ordering progress. A
        // session the server no longer answers must terminate instead
        // of re-requesting at 1 Hz forever.
        self.retransmit_requests_since_progress += 1;
        if self.retransmit_requests_since_progress > RETRANSMIT_GIVE_UP_REQUESTS {
            return Err(anyhow!(
                "retransmit give-up: {} consecutive requests with no ordering progress — server presumed to have dropped this session",
                self.retransmit_requests_since_progress
            ));
        }
        Ok(true)
    }

    pub(crate) fn should_request_retransmit(&self, expected: u32, received_sequence: u32) -> bool {
        is_newer_u32(received_sequence, expected)
            && self
                .last_request_retransmit_time
                .is_none_or(|last_request| {
                    Instant::now().duration_since(last_request) > REQUEST_RETRANSMIT_INTERVAL
                })
    }
}
