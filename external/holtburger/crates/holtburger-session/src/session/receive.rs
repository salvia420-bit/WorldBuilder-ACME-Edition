use super::types::{ReceivedPacket, Session, SessionEvent};
use crate::capture::Direction;
use crate::optional_header::OptionalHeaderCursor;
use anyhow::{Result, anyhow};
use byteorder::{ByteOrder, LittleEndian};
use holtburger_common::sequence::is_newer_u32;
use holtburger_protocol::messages::transport::{self, packet_flags};
use holtburger_protocol::messages::*;
use holtburger_protocol::traits::ProtocolUnpack;
use web_time::Instant;

// A02 Opt-1 (net-review, fixed 2026-07-10): the recv scratch was
// `[0u8; 1024 * 128]` — 128 KB zeroed per inbound packet on the hot path
// (tens of MB of memset across a teleport burst). Nothing larger than 4 KB
// can arrive: ACE caps client/server packets at 1024 B
// (`ClientPacket.MaxPacketSize`) and the wsbridge kills any WS frame over
// its 4096 B `frame::MAX_PACKET_BYTES`. A hypothetical oversized native-UDP
// datagram truncates, fails the checksum, and is dropped — same outcome as
// before (the old buffer would merely have failed later, at parse).
const RECV_SCRATCH_BYTES: usize = 4096;

impl Session {
    async fn recv_raw_packet_with_addr(
        &mut self,
        buf: &mut [u8],
    ) -> Result<(PacketHeader, Vec<u8>, std::net::SocketAddr)> {
        loop {
            let (len, addr) = self.transport.recv_from(buf).await?;

            let expected_addr = self.server_source_addr;
            let pending_addr = self.pending_server_source_addr;
            let addr_allowed =
                addr == expected_addr || pending_addr.is_some_and(|candidate| addr == candidate);

            if !addr_allowed {
                if let Some(candidate) = pending_addr {
                    log::warn!(
                        "Ignoring inbound packet from unexpected source {}; expected {} or {}",
                        addr,
                        expected_addr,
                        candidate
                    );
                } else {
                    log::warn!(
                        "Ignoring inbound packet from unexpected source {}; expected {}",
                        addr,
                        expected_addr
                    );
                }
                continue;
            }

            if pending_addr.is_some_and(|candidate| addr == candidate) {
                log::debug!(
                    "Inbound packet confirmed activation source {}; switching expected source from {}",
                    addr,
                    expected_addr
                );
                self.server_source_addr = addr;
                self.pending_server_source_addr = None;
            }

            if len < transport::HEADER_SIZE {
                return Err(anyhow!("Packet too short"));
            }

            self.bytes_in = self.bytes_in.wrapping_add(len as u64);
            self.last_recv_time = Instant::now();

            if let Some(ref mut capture) = self.capture {
                let _ = capture.write_entry(Direction::Inbound, addr, &buf[..len]);
            }

            let mut offset = 0;
            let header = PacketHeader::unpack(&buf[..transport::HEADER_SIZE], &mut offset)
                .ok_or_else(|| anyhow!("Failed to unpack packet header"))?;
            let data = buf[transport::HEADER_SIZE..len].to_vec();

            log::trace!(
                "<<< Inbound from {}: Seq={} ID={} Flags={:X} Size={} Hex: {:02X?}",
                addr,
                header.sequence,
                header.id,
                header.flags,
                len,
                &buf[..len]
            );

            return Ok((header, data, addr));
        }
    }

    async fn recv_packet_with_addr(
        &mut self,
        buf: &mut [u8],
    ) -> Result<(PacketHeader, Vec<u8>, std::net::SocketAddr)> {
        let (header, data, addr) = self.recv_raw_packet_with_addr(buf).await?;

        if (header.flags & packet_flags::ACK_SEQUENCE) != 0
            && let Some(sequence) = self.read_ack_sequence(header.flags, &data)
        {
            self.acknowledge_sequence(sequence);
        }

        if (header.flags & packet_flags::REQUEST_RETRANSMIT) != 0
            && let Some(sequences) =
                self.read_sequence_list(header.flags, &data, packet_flags::REQUEST_RETRANSMIT)
        {
            self.retransmit_sequences(&sequences)?;
        }

        if (header.flags & packet_flags::REJECT_RETRANSMIT) != 0
            && let Some(sequences) =
                self.read_sequence_list(header.flags, &data, packet_flags::REJECT_RETRANSMIT)
        {
            log::warn!(
                "Server rejected retransmit for S2C sequences: {:?}",
                sequences
            );
        }

        if header.flags & packet_flags::ENCRYPTED_CHECKSUM != 0
            && let Some(isaac) = self.isaac_s2c.as_mut()
        {
            isaac.consume_key();
        }

        Ok((header, data, addr))
    }

    fn process_received_packet_metadata(
        &mut self,
        header: &PacketHeader,
        data: &[u8],
    ) -> Result<()> {
        if (header.flags & packet_flags::ACK_SEQUENCE) != 0
            && let Some(sequence) = self.read_ack_sequence(header.flags, data)
        {
            self.acknowledge_sequence(sequence);
        }

        if (header.flags & packet_flags::REQUEST_RETRANSMIT) != 0
            && let Some(sequences) =
                self.read_sequence_list(header.flags, data, packet_flags::REQUEST_RETRANSMIT)
        {
            self.retransmit_sequences(&sequences)?;
        }

        if (header.flags & packet_flags::REJECT_RETRANSMIT) != 0
            && let Some(sequences) =
                self.read_sequence_list(header.flags, data, packet_flags::REJECT_RETRANSMIT)
        {
            log::warn!(
                "Server rejected retransmit for S2C sequences: {:?}",
                sequences
            );
        }

        Ok(())
    }

    fn validate_received_packet_checksum(
        &mut self,
        header: &PacketHeader,
        data: &[u8],
    ) -> Result<bool> {
        let header_checksum = header.calculate_checksum();
        let payload_checksum = match self.calculate_payload_hash(header.flags, data) {
            Ok(checksum) => checksum,
            Err(err) => {
                log::debug!(
                    "Inbound packet checksum failed while hashing payload: Seq={} ID={} Flags={:X}: {}",
                    header.sequence,
                    header.id,
                    header.flags,
                    err
                );
                return Ok(false);
            }
        };

        if header.flags & packet_flags::ENCRYPTED_CHECKSUM != 0 {
            let Some(isaac) = self.isaac_s2c.as_mut() else {
                log::warn!(
                    "Inbound encrypted packet received before S2C ISAAC was initialized: Seq={} ID={} Flags={:X}",
                    header.sequence,
                    header.id,
                    header.flags
                );
                return Ok(false);
            };

            let key = header.checksum.wrapping_sub(header_checksum) ^ payload_checksum;
            if isaac.search(key) {
                isaac.consume_key_value(key);
                return Ok(true);
            }
        } else if header_checksum.wrapping_add(payload_checksum) == header.checksum {
            return Ok(true);
        }

        log::debug!(
            "Inbound packet checksum failed: Seq={} ID={} Flags={:X} Checksum={:08X}",
            header.sequence,
            header.id,
            header.flags,
            header.checksum,
        );
        Ok(false)
    }

    pub async fn recv_packet(&mut self, buf: &mut [u8]) -> Result<(PacketHeader, Vec<u8>)> {
        let (header, data, _) = self.recv_packet_with_addr(buf).await?;
        Ok((header, data))
    }

    fn should_order_server_packet(&self, header: &PacketHeader) -> bool {
        // net-2 (R2-net 2026-10-08): a CLEARTEXT RequestRetransmit does not
        // own its sequence. ACE stamps its NAKs with `CurrentValue`, the last
        // data sequence it sent (NetworkSession.cs FlushPackets `if (Flags ==
        // AckSequence || isNak) Sequence = CurrentValue`), exactly like its
        // pure ACKs. Ordering it let a NAK stand in for a lost data packet N:
        // `last_server_seq` became N, N was ACKed (ACE then pruned it from its
        // retransmit cache) and the real N was later dropped as a duplicate.
        // Retail never lets a cleartext packet satisfy a sequence
        // (`SharedNet::ProcessNewestSeqNum` acclient.c:369054 `if
        // (!(header_ & 2)) ++v2;`, `SharedNet::ProcessNewSeqNum`
        // acclient.c:372062). ACE's cleartext RejectRetransmit stays ordered:
        // ACE gives it a fresh `NextValue` sequence.
        if header.flags & packet_flags::REQUEST_RETRANSMIT != 0
            && header.flags & packet_flags::ENCRYPTED_CHECKSUM == 0
        {
            return false;
        }
        header.flags != packet_flags::ACK_SEQUENCE
            && (header.sequence != 0 || (header.flags & packet_flags::BLOB_FRAGMENTS) != 0)
    }

    fn next_expected_server_sequence(&self) -> u32 {
        self.last_server_seq.wrapping_add(1)
    }

    fn take_pending_server_packet(&mut self) -> Option<ReceivedPacket> {
        let expected = self.next_expected_server_sequence();
        self.pending_server_packets.remove(&expected)
    }

    fn finalize_ordered_server_packet(&mut self, packet: &ReceivedPacket) -> Result<()> {
        if self.should_order_server_packet(&packet.header) {
            self.last_server_seq = packet.header.sequence;
            self.has_server_seq = true;
            // conn-fix (2026-07-18): ordering progressed — reset the
            // retransmit give-up counter (see send_request_retransmit).
            self.retransmit_requests_since_progress = 0;
            // net-4: ordering caught up with the newest known sequence, so
            // the gap is closed and the re-NAK timer disarms.
            if let Some(highest) = self.highest_server_seq_seen
                && !is_newer_u32(highest, self.last_server_seq)
            {
                self.highest_server_seq_seen = None;
            }
            // net-2 (R2-net 2026-10-08): ACK only sequences that ordering
            // actually consumed, with the cumulative watermark. The old rule
            // (`sequence > 0 && flags != ACK_SEQUENCE`) also ACKed a cleartext
            // NAK's BORROWED id, and ACE prunes every cached packet below an
            // ACK (`x < sequence`), so a lost data packet could never be
            // retransmitted.
            let ack_sequence = self.last_server_seq;
            self.queue_ack(ack_sequence)?;
        }

        // net-5 (R2-net 2026-10-08): the old S2C EchoRequest reply cloned the
        // SERVER's header (its sequence and id), sent it encrypted with an
        // empty 8-byte EchoResponse body, burned a C2S ISAAC word ACE never
        // matches, and cached it in the C2S retransmit cache under the
        // server's sequence. Retail answers mask 0x2000000 with a
        // CEchoResponseHeader optional header on a LATER outgoing packet
        // (`SharedNet::ProcessOptionalHeader`, acclient.c:370711), never a new
        // packet; vanilla ACE never sends an S2C EchoRequest (it only answers
        // ours, NetworkSession.cs:439-443). OpenAC ignores it too. Deleted.

        Ok(())
    }

    /// net-4 (R2-net 2026-10-08): retail uses a CLEARTEXT packet's borrowed
    /// sequence as a loss hint. `SharedNet::ProcessNewestSeqNum`
    /// (acclient.c:369054) NAKs every id up to AND INCLUDING the borrowed id
    /// when it is newer than `highestIDReceived_`. ACE's ack-only packets (and
    /// its NAKs) carry `CurrentValue`, the last data sequence it sent, every
    /// 2 s, so a lost LAST packet of a burst is noticed within ~2.6 s instead
    /// of waiting for the next encrypted packet (up to 20 s at char select).
    /// Out-of-window hints are ignored, never fatal.
    fn note_cleartext_sequence_hint(&mut self, header: &PacketHeader) -> Result<()> {
        let sequence = header.sequence;
        if !self.has_server_seq
            || sequence == 0
            || header.flags & packet_flags::ENCRYPTED_CHECKSUM != 0
            || !is_newer_u32(sequence, self.last_server_seq)
        {
            return Ok(());
        }

        // `sequence + 1` makes the [desired, received) builder include the
        // borrowed id itself, as retail's `++v2` does.
        let target = sequence.wrapping_add(1);
        if !self.retransmit_span_in_window(target) {
            log::debug!(
                "Ignoring cleartext sequence hint {}: outside the retransmit window above {}",
                sequence,
                self.last_server_seq
            );
            return Ok(());
        }

        self.note_server_seq_seen(sequence);
        let expected = self.next_expected_server_sequence();
        if self.should_request_retransmit(expected, target) {
            self.send_request_retransmit(target)?;
        }
        Ok(())
    }

    /// One validated-or-dropped inbound packet through checksum, metadata and
    /// ordering. `Ok(Some(packet))` = deliver it now; `Ok(None)` = keep
    /// receiving (dropped, duplicate, or buffered out of order). Shared by
    /// the timer and plain paths of [`Self::recv_ordered_packet`], which used
    /// to carry two verbatim copies of this body.
    fn process_inbound_packet(
        &mut self,
        header: PacketHeader,
        data: Vec<u8>,
    ) -> Result<Option<ReceivedPacket>> {
        if !self.validate_received_packet_checksum(&header, &data)? {
            return Ok(None);
        }

        self.process_received_packet_metadata(&header, &data)?;

        let packet = ReceivedPacket { header, data };

        if !self.should_order_server_packet(&packet.header) {
            self.note_cleartext_sequence_hint(&packet.header)?;
            self.finalize_ordered_server_packet(&packet)?;
            return Ok(Some(packet));
        }

        let received_sequence = packet.header.sequence;
        let expected = self.next_expected_server_sequence();
        if !is_newer_u32(received_sequence, self.last_server_seq) {
            log::debug!(
                "Server packet {} received again; last ordered sequence is {}",
                received_sequence,
                self.last_server_seq
            );
            return Ok(None);
        }

        if received_sequence != expected {
            if !is_newer_u32(received_sequence, expected) {
                log::debug!(
                    "Server packet {} is newer than {} but not the expected sequence {}",
                    received_sequence,
                    self.last_server_seq,
                    expected
                );
                return Ok(None);
            }

            // F-sweep: bounded insert (was unbounded).
            self.buffer_out_of_order_packet(received_sequence, packet);

            if self.should_request_retransmit(expected, received_sequence) {
                self.send_request_retransmit(received_sequence)?;
            }
            return Ok(None);
        }

        self.finalize_ordered_server_packet(&packet)?;
        Ok(Some(packet))
    }

    async fn recv_ordered_packet(&mut self) -> Result<ReceivedPacket> {
        loop {
            if let Some(packet) = self.take_pending_server_packet() {
                self.finalize_ordered_server_packet(&packet)?;
                return Ok(packet);
            }

            if self.flush_pending_control_packets().await? {
                continue;
            }

            // net-4 (R2-net 2026-10-08): timer-driven re-NAK while a gap is
            // open (queued here, flushed at the loop top).
            if self.resend_request_retransmit_if_due()? {
                continue;
            }

            // Wake for whichever comes first: the next deferred control packet
            // or (net-4) the next re-NAK. Both are `None` on an idle, in-order
            // session, which then blocks on the socket alone as before.
            let deadline = match (
                self.next_pending_control_deadline(),
                self.next_retransmit_deadline(),
            ) {
                (Some(control), Some(renak)) => Some(control.min(renak)),
                (control, renak) => control.or(renak),
            };

            if let Some(deadline) = deadline {
                // Native: `web_time::Instant` re-exports `std::time::Instant`,
                // so `from_std` accepts the deadline directly.
                //
                // Wasm32: `tokio::time::sleep` is unusable here — its time
                // driver internally calls `std::time::Instant::now()`, which
                // is a panic stub on `wasm32-unknown-unknown`
                // ("time not implemented on this platform"). `gloo-timers`'s
                // `TimeoutFuture` is the equivalent setTimeout-backed
                // future that actually works in a browser. We compute the
                // wait in milliseconds via `web_time::Instant`'s `.elapsed`
                // / `.saturating_duration_since` (`web_time` is the JS
                // `performance.now()`-backed shim on wasm32) so the deadline
                // remains relative-time sound across both targets.
                #[cfg(not(target_arch = "wasm32"))]
                let timer = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline));
                #[cfg(target_arch = "wasm32")]
                let timer = gloo_timers::future::TimeoutFuture::new(
                    deadline
                        .saturating_duration_since(Instant::now())
                        .as_millis()
                        .min(u32::MAX as u128) as u32,
                );

                tokio::select! {
                    _ = timer => {
                        continue;
                    }
                    result = async {
                        let mut buf = [0u8; RECV_SCRATCH_BYTES];
                        self.recv_raw_packet_with_addr(&mut buf).await
                    } => {
                        let (header, data, _) = result?;
                        if let Some(packet) = self.process_inbound_packet(header, data)? {
                            return Ok(packet);
                        }
                        continue;
                    }
                }
            }

            let mut buf = [0u8; RECV_SCRATCH_BYTES];
            let (header, data, _) = self.recv_raw_packet_with_addr(&mut buf).await?;
            if let Some(packet) = self.process_inbound_packet(header, data)? {
                return Ok(packet);
            }
        }
    }

    pub fn get_payload_offset(&self, flags: u32, data: &[u8]) -> usize {
        OptionalHeaderCursor::new(data, flags).payload_offset()
    }

    pub async fn recv_message(&mut self) -> Result<Vec<SessionEvent>> {
        let packet = self.recv_ordered_packet().await?;
        let header = packet.header;
        let data = packet.data;
        let mut events = Vec::new();

        if header.flags & packet_flags::CONNECT_REQUEST != 0 {
            let mut offset = self.get_payload_offset(header.flags, &data);
            if offset + transport::CONNECT_REQUEST_SIZE <= data.len() {
                let crd = ConnectRequestData::unpack(&data, &mut offset)
                    .ok_or_else(|| anyhow!("Failed to unpack connect request"))?;
                let server_time = self.handle_handshake_request(crd)?;
                events.push(SessionEvent::TimeSync(server_time));
            }
        }

        if header.flags & packet_flags::CONNECT_RESPONSE != 0
            && let Some(offset) = OptionalHeaderCursor::new(&data, header.flags)
                .find_flag_offset(packet_flags::CONNECT_RESPONSE)
                .filter(|&offset| offset + transport::CONNECT_RESPONSE_SIZE <= data.len())
        {
            let cookie =
                LittleEndian::read_u64(&data[offset..offset + transport::CONNECT_RESPONSE_SIZE]);
            self.handle_handshake_response(cookie, header.id);
        }

        if header.flags & packet_flags::TIME_SYNC != 0
            && let Some(offset) = OptionalHeaderCursor::new(&data, header.flags)
                .find_flag_offset(packet_flags::TIME_SYNC)
                .filter(|&offset| offset + 8 <= data.len())
        {
            let server_time = LittleEndian::read_f64(&data[offset..offset + 8]);
            events.push(SessionEvent::TimeSync(server_time));
        }

        if header.flags & packet_flags::BLOB_FRAGMENTS != 0 {
            let mut offset = self.get_payload_offset(header.flags, &data);
            while offset + transport::FRAGMENT_HEADER_SIZE <= data.len() {
                let frag_header = FragmentHeader::unpack(&data, &mut offset)
                    .ok_or_else(|| anyhow!("Failed to unpack fragment header"))?;
                let frag_data_size =
                    (frag_header.size as usize).saturating_sub(transport::FRAGMENT_HEADER_SIZE);

                if offset + frag_data_size > data.len() {
                    break;
                }
                let frag_data = &data[offset..offset + frag_data_size];

                if let Some(full) = self.process_fragment(&frag_header, frag_data) {
                    events.push(SessionEvent::Message(full));
                }
                offset += frag_data_size;
            }
        }

        Ok(events)
    }
}
