//! net-transport-6 (2026-10-13): the retail Link Status packet-loss figure.
//!
//! Port of retail `CLinkStatusAverages` (acclient.h, acclient.c:373701-373839):
//!
//! * `ClientNet::AddToPerfCounter` (acclient.c:370154) accumulates the current
//!   `CLinkStatusSnapshot`: counter 9 -> `nPktsSent` (every packet sent,
//!   retransmissions included), counter 10 -> `nPktsRetransmitted` (packets
//!   re-sent for the peer's NAK), counters 3/4/5 -> `nPktsReceived` (every
//!   checksum-valid packet received) and counter 6 -> `nPktsNAKed`. Nothing
//!   in the client increments counter 6, so `nPktsNAKed` is always 0 in
//!   retail; it is kept here only so the formula reads as retail's.
//! * `ClientNet::ProcessConnection` (acclient.c:372873-372892) takes a
//!   heartbeat once `local_time - lastHeartbeat >= 2.0`: the snapshot goes to
//!   `CLinkStatusAverages::AddSnapshot` and is then zeroed.
//! * `AddSnapshot` pushes each count into a `CAverager<unsigned short, 40>`, a
//!   40-sample ring that keeps a running total (acclient.c:373724).
//! * `CLinkStatusAverages::GetAveragePacketLoss` (acclient.c:373794):
//!   `(NAKed + retransmitted) / (received + sent)`, doubled, or 0 with no
//!   traffic. `LinkStatusHolder::OnHeartbeat` stores it as a float, and
//!   `gmLinkStatusUI::Update` (acclient.c:226356) prints it with 2 decimals
//!   followed by "%". Retail never multiplies the doubled ratio by 100.
//!
//! The averages are pure bookkeeping; `Session` feeds them from its send,
//! retransmit and receive paths (send.rs, reliability.rs, receive.rs). After
//! WebAC `packages/network/src/LinkStatusAverages.ts`, AGPL-3.0.

use std::time::Duration;
use web_time::Instant;

/// `ClientNet::ProcessConnection`: one snapshot every 2.0 s.
pub const LINK_STATUS_HEARTBEAT: Duration = Duration::from_secs(2);

/// `CAverager<unsigned short, 40>`: samples kept per counter.
pub const LINK_STATUS_AVERAGER_SAMPLES: usize = 40;

/// The packet counters of one `CLinkStatusSnapshot` (one heartbeat). Retail
/// keeps them as `unsigned __int16` and adds with wraparound.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LinkStatusSnapshot {
    pub pkts_sent: u16,
    pub pkts_retransmitted: u16,
    pub pkts_received: u16,
    pub pkts_naked: u16,
}

/// `CLinkStatusAverages::CAverager<unsigned short, 40>::AddSample`
/// (acclient.c:373724): a ring of the last 40 samples plus their total.
#[derive(Clone, Debug)]
pub struct UShortAverager {
    samples: [u16; LINK_STATUS_AVERAGER_SAMPLES],
    n_samples: usize,
    idx_first: usize,
    cur_total: f64,
}

impl Default for UShortAverager {
    fn default() -> Self {
        Self {
            samples: [0; LINK_STATUS_AVERAGER_SAMPLES],
            n_samples: 0,
            idx_first: 0,
            cur_total: 0.0,
        }
    }
}

impl UShortAverager {
    pub fn add_sample(&mut self, data: u16) {
        if self.n_samples == LINK_STATUS_AVERAGER_SAMPLES {
            // Full: the oldest sample leaves the total and its slot.
            self.cur_total -= f64::from(self.samples[self.idx_first]);
            self.samples[self.idx_first] = data;
            self.idx_first = (self.idx_first + 1) % LINK_STATUS_AVERAGER_SAMPLES;
        } else {
            self.samples[self.n_samples] = data;
            self.n_samples += 1;
        }
        self.cur_total += f64::from(data);
    }

    /// `m_CurTotal`: the sum of the samples in the ring.
    pub fn total(&self) -> f64 {
        self.cur_total
    }

    /// `m_nSamples`.
    pub fn len(&self) -> usize {
        self.n_samples
    }

    pub fn is_empty(&self) -> bool {
        self.n_samples == 0
    }
}

/// Retail `CLinkStatusAverages` (packet counters only) plus the current
/// snapshot (`ClientNet::m_CurrentLinkStatus`) and the stored figure
/// (`LinkStatusHolder::m_fPacketLoss`).
#[derive(Clone, Debug, Default)]
pub struct LinkStatusAverages {
    current: LinkStatusSnapshot,
    sent: UShortAverager,
    retransmitted: UShortAverager,
    received: UShortAverager,
    naked: UShortAverager,
    last_heartbeat: Option<Instant>,
    packet_loss: f32,
}

impl LinkStatusAverages {
    pub fn new() -> Self {
        Self::default()
    }

    /// Counter 9 (`SharedNet::SendPacket`): one packet went out,
    /// retransmissions included.
    pub fn count_sent(&mut self) {
        self.current.pkts_sent = self.current.pkts_sent.wrapping_add(1);
    }

    /// Counter 10 (`FlowQueue::TransmitAcks`): `n` packets re-sent for the
    /// peer's NAK.
    pub fn count_retransmitted(&mut self, n: u16) {
        self.current.pkts_retransmitted = self.current.pkts_retransmitted.wrapping_add(n);
    }

    /// Counters 3/4/5 (`SharedNet::SplitPacketData`): one checksum-valid
    /// packet arrived.
    pub fn count_received(&mut self) {
        self.current.pkts_received = self.current.pkts_received.wrapping_add(1);
    }

    /// `CLinkStatusAverages::AddSnapshot` (acclient.c:373814), packet-count
    /// averagers only.
    pub fn add_snapshot(&mut self, snap: &LinkStatusSnapshot) {
        self.sent.add_sample(snap.pkts_sent);
        self.retransmitted.add_sample(snap.pkts_retransmitted);
        self.received.add_sample(snap.pkts_received);
        self.naked.add_sample(snap.pkts_naked);
    }

    /// `CLinkStatusAverages::GetAveragePacketLoss` (acclient.c:373794):
    /// `v3 / v1 + v3 / v1`, with `v1 = received + sent` and
    /// `v3 = NAKed + retransmitted`, over the 40-snapshot window.
    pub fn average_packet_loss(&self) -> f64 {
        let total = self.received.total() + self.sent.total();
        if total > 0.0 {
            let lost = self.naked.total() + self.retransmitted.total();
            lost / total + lost / total
        } else {
            0.0
        }
    }

    /// The heartbeat of `ClientNet::ProcessConnection` (acclient.c:372873):
    /// once [`LINK_STATUS_HEARTBEAT`] has passed since the last one, fold the
    /// current snapshot into the averagers, zero it and refresh the stored
    /// figure (`LinkStatusHolder::OnHeartbeat`). The first call only arms the
    /// clock (retail starts it at connection time). `true` when a heartbeat
    /// was taken.
    pub fn heartbeat(&mut self, now: Instant) -> bool {
        let Some(last) = self.last_heartbeat else {
            self.last_heartbeat = Some(now);
            return false;
        };
        if now.saturating_duration_since(last) < LINK_STATUS_HEARTBEAT {
            return false;
        }
        self.last_heartbeat = Some(now);
        let snap = std::mem::take(&mut self.current);
        self.add_snapshot(&snap);
        self.packet_loss = self.average_packet_loss() as f32;
        true
    }

    /// `LinkStatusHolder::GetPacketLossPercentage` (acclient.c:77339): the
    /// doubled ratio as of the last heartbeat, which retail prints as a
    /// percentage without scaling it.
    pub fn packet_loss(&self) -> f32 {
        self.packet_loss
    }

    /// The snapshot being accumulated since the last heartbeat.
    pub fn current(&self) -> LinkStatusSnapshot {
        self.current
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(sent: u16, retx: u16, recv: u16) -> LinkStatusSnapshot {
        LinkStatusSnapshot {
            pkts_sent: sent,
            pkts_retransmitted: retx,
            pkts_received: recv,
            pkts_naked: 0,
        }
    }

    #[test]
    fn no_traffic_is_zero_loss() {
        let a = LinkStatusAverages::new();
        assert_eq!(a.average_packet_loss(), 0.0);
        assert_eq!(a.packet_loss(), 0.0);
    }

    #[test]
    fn packet_loss_is_retails_doubled_ratio() {
        // 2 * (NAKed + retransmitted) / (received + sent), over every
        // snapshot in the window.
        let mut a = LinkStatusAverages::new();
        a.add_snapshot(&snap(40, 2, 50));
        a.add_snapshot(&snap(10, 1, 0));
        let expected = 2.0 * 3.0 / 100.0;
        assert!((a.average_packet_loss() - expected).abs() < 1e-12);
    }

    #[test]
    fn averager_keeps_the_last_40_samples() {
        let mut avg = UShortAverager::default();
        for _ in 0..LINK_STATUS_AVERAGER_SAMPLES {
            avg.add_sample(1);
        }
        assert_eq!(avg.len(), LINK_STATUS_AVERAGER_SAMPLES);
        assert_eq!(avg.total(), 40.0);
        // The 41st sample replaces the oldest one.
        avg.add_sample(5);
        assert_eq!(avg.len(), LINK_STATUS_AVERAGER_SAMPLES);
        assert_eq!(avg.total(), 44.0);
    }

    #[test]
    fn a_lossy_snapshot_ages_out_of_the_window() {
        let mut a = LinkStatusAverages::new();
        a.add_snapshot(&snap(10, 5, 10));
        assert!(a.average_packet_loss() > 0.0);
        for _ in 0..LINK_STATUS_AVERAGER_SAMPLES {
            a.add_snapshot(&snap(10, 0, 10));
        }
        assert_eq!(a.average_packet_loss(), 0.0);
    }

    #[test]
    fn heartbeat_arms_then_snapshots_every_two_seconds() {
        let t0 = Instant::now();
        let mut a = LinkStatusAverages::new();
        assert!(!a.heartbeat(t0), "the first call only arms the clock");

        for _ in 0..18 {
            a.count_sent();
        }
        a.count_retransmitted(1);
        a.count_sent(); // the retransmission is itself a sent packet
        for _ in 0..20 {
            a.count_received();
        }
        assert!(!a.heartbeat(t0 + Duration::from_millis(1999)));
        assert_eq!(a.packet_loss(), 0.0, "nothing folded in before 2 s");

        assert!(a.heartbeat(t0 + LINK_STATUS_HEARTBEAT));
        // 2 * 1 retransmitted / (20 received + 19 sent).
        let expected = (2.0 * 1.0 / 39.0) as f32;
        assert_eq!(a.packet_loss(), expected);
        assert_eq!(a.current(), LinkStatusSnapshot::default(), "snapshot zeroed");

        // The next window is measured from this heartbeat.
        assert!(!a.heartbeat(t0 + Duration::from_millis(3999)));
        assert!(a.heartbeat(t0 + Duration::from_millis(4000)));
    }

    #[test]
    fn snapshot_counters_wrap_like_retails_ushort() {
        let mut a = LinkStatusAverages::new();
        a.count_retransmitted(u16::MAX);
        a.count_retransmitted(2);
        assert_eq!(a.current().pkts_retransmitted, 1);
    }

    #[test]
    fn naked_is_never_counted() {
        // Retail has no increment site for counter 6 (AcksReceivedCounter).
        let t0 = Instant::now();
        let mut a = LinkStatusAverages::new();
        a.heartbeat(t0);
        a.count_sent();
        a.count_received();
        a.heartbeat(t0 + LINK_STATUS_HEARTBEAT);
        assert_eq!(a.packet_loss(), 0.0);
    }
}
