//! net-transport-6 (2026-10-13): the keepalive ping's round-trip clock, kept
//! pure and `wasm32 OR test` gated (like `session_liveness`) so it is
//! unit-tested natively (`cargo test -p holtburger-web --lib ping_round_trip`).
//!
//! `PingRequest` (0x01E9) and `PingResponse` (0x01EA) carry no payload, so a
//! response cannot name the request it answers. Retail measures from its one
//! outstanding request (`gmLinkStatusUI::RecvNotice_Ping` takes `cur_time -
//! m_lastPingRequestTime`; `gmLinkStatusUI::Update`, acclient.c:226356, asks
//! for a ping on open and every 120 s). holtburger pings far more often: the
//! direct-mode recv loop's 5 s arm plus `SessionCommand::ForceKeepalive`,
//! which the 2.5 s `setInterval` and the 2 s keepalive worker both drive; in
//! `?netWorker` mode the worker's own 2.5 s timer plus those forwarded pings.
//!
//! The old bookkeeping was one `Option<Instant>` that every send overwrote, so
//! a second ping sent while the first was in flight moved the stamp forward
//! and the first response measured from the wrong send (too short); in worker
//! mode the worker's pings never stamped it at all. Keeping the first stamp
//! alone is not enough either: once the RTT is longer than the ~1 s gap
//! between pings, each later response answers an older unstamped ping but
//! would be credited to the newest stamp, so a slow link settled at the ping
//! gap and never measured slow. Here:
//!
//! * answerable pings are COUNTED until answered, and a send is stamped only
//!   when none is outstanding. ACE answers PingRequests in order, so the
//!   first response after a stamp is that ping's own answer, and the answers
//!   to pings sent while it was out just drain the count. While the RTT
//!   stays above the ping gap the count never drains, so the reading holds
//!   its last true (slow) value; the next stamp comes once it drains;
//! * only pings the server will answer are counted. ACE drops every
//!   GameAction while `session.Player == null` (InboundMessageManager.cs
//!   `HandleGameAction`) or the session is not `WorldConnected`
//!   (GameActionPacket.cs), so a ping from character select or EnteringWorld
//!   would be counted forever and an older stamp would inflate the first
//!   in-world RTT. ACE also sends an unsolicited PingResponse every 100 s at
//!   character select (Session.cs `lastCharacterSelectPingReply`); with
//!   nothing outstanding it is ignored;
//! * the in-world edge (`PlayerCreate`, [`PingRoundTrip::note_entered_world`])
//!   forgets everything outstanding: after a logoff neither loop leaves its
//!   in-world state, so its character-select pings are counted although ACE
//!   answers none of them;
//! * when pings are outstanding and nothing has been answered for
//!   [`PING_STAMP_STALE_AFTER`], they are presumed lost and forgotten, so the
//!   next send stamps again.
//!
//! Timing cannot tell a ping that is lost while the link keeps answering the
//! others from a link one ping gap slower, so such a ping keeps the count
//! from draining and the reading holds its last value (one gap long if the
//! lost ping was the stamped one) until the link is quiet for the stale
//! window or the next login. Both directions are NAK-retransmitted, so this
//! is rare. Forgetting it sooner would under-count
//! a genuinely slow link, and an under-count credits every answer to a later
//! send again (the bug above). For the same reason a forgotten ping that is
//! answered after all (an RTT above the stale window, or a ping sent just
//! before `PlayerCreate` that ACE still answered) is credited to the next
//! stamp, once. A FIFO of send times would mis-pair every response after one
//! lost ping instead of holding the last true reading.

use std::time::Duration;
use web_time::Instant;

use holtburger_protocol::opcodes::{GameActionOpcode, GameEventOpcode, GameOpcode};

/// Outstanding pings with nothing answered for this long are presumed lost
/// and forgotten, so the next send stamps again. An RTT above it cannot be
/// measured (the late answers are credited to the next stamp), so it is kept
/// well above the link indicator's 3 s "bad" bar (status-indicators.js
/// `linkTierFor`): a genuinely slow link still measures slow.
pub(crate) const PING_STAMP_STALE_AFTER: Duration = Duration::from_secs(10);

/// The answerable `PingRequest`s still unanswered, the send time of the one
/// whose answer is next (when it went out with none outstanding) and the last
/// measured RTT.
#[derive(Clone, Debug, Default)]
pub(crate) struct PingRoundTrip {
    /// Send time of the ping whose answer is the next `PingResponse`. Taken
    /// only when no other answerable ping was outstanding, so `Some` implies
    /// `outstanding >= 1`.
    stamp: Option<Instant>,
    /// Answerable pings sent and not yet answered.
    outstanding: u32,
    /// When the outstanding pings last showed life: the send that started
    /// the run (count 0 -> 1) or the latest response. `None` while nothing is
    /// outstanding.
    progress_at: Option<Instant>,
    last_rtt: Option<Duration>,
}

impl PingRoundTrip {
    pub(crate) const fn new() -> Self {
        Self {
            stamp: None,
            outstanding: 0,
            progress_at: None,
            last_rtt: None,
        }
    }

    /// A `PingRequest` went out at `now`. `answerable` = the server will
    /// answer it (the player is in the world); other pings are not counted.
    /// Stamps only when no answerable ping is outstanding (after forgetting
    /// them once nothing has been answered for [`PING_STAMP_STALE_AFTER`]);
    /// `true` when it stamped.
    pub(crate) fn note_sent(&mut self, now: Instant, answerable: bool) -> bool {
        if !answerable {
            return false;
        }
        if self.outstanding > 0
            && self
                .progress_at
                .is_some_and(|at| now.saturating_duration_since(at) >= PING_STAMP_STALE_AFTER)
        {
            self.forget_outstanding();
        }
        let stamped = self.outstanding == 0;
        if stamped {
            self.stamp = Some(now);
            self.progress_at = Some(now);
        }
        self.outstanding = self.outstanding.saturating_add(1);
        stamped
    }

    /// A `PingResponse` arrived at `now`. It answers the oldest outstanding
    /// ping, so it returns the RTT only when that ping is the stamped one;
    /// `None` for an unsolicited response, the answer to a ping sent while
    /// another was out, or one already forgotten.
    pub(crate) fn note_response(&mut self, now: Instant) -> Option<Duration> {
        if self.outstanding == 0 {
            return None;
        }
        self.outstanding -= 1;
        self.progress_at = (self.outstanding > 0).then_some(now);
        let sent = self.stamp.take()?;
        let rtt = now.saturating_duration_since(sent);
        self.last_rtt = Some(rtt);
        Some(rtt)
    }

    /// The player just entered the world (`PlayerCreate`): forget every
    /// outstanding ping. ACE answers none at character select, yet after a
    /// logoff the loop's in-world state (and so `answerable`) stays set
    /// there, so those pings were counted. The last RTT is kept.
    pub(crate) fn note_entered_world(&mut self) {
        self.forget_outstanding();
    }

    fn forget_outstanding(&mut self) {
        self.stamp = None;
        self.outstanding = 0;
        self.progress_at = None;
    }

    /// [`Self::note_response`] in whole milliseconds.
    pub(crate) fn note_response_ms(&mut self, now: Instant) -> Option<u32> {
        self.note_response(now).map(duration_ms)
    }

    /// The last measured RTT in milliseconds, `None` before the first one.
    pub(crate) fn last_rtt_ms(&self) -> Option<u32> {
        self.last_rtt.map(duration_ms)
    }
}

fn duration_ms(d: Duration) -> u32 {
    d.as_millis().min(u32::MAX as u128) as u32
}

fn read_u32(payload: &[u8], at: usize) -> Option<u32> {
    let bytes = payload.get(at..at + 4)?;
    Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

/// A reassembled S2C game message that is a `GameEvent` (0xF7B0) carrying
/// `PingResponse` (0x01EA): opcode, target guid, event sequence, event type.
pub(crate) fn is_ping_response_message(payload: &[u8]) -> bool {
    read_u32(payload, 0) == Some(GameOpcode::GameEvent as u32)
        && read_u32(payload, 12) == Some(GameEventOpcode::PingResponse as u32)
}

/// A packed C2S `GameAction` (0xF7B1) message carrying `PingRequest`
/// (0x01E9): opcode, action sequence, action type.
pub(crate) fn is_ping_request_message(payload: &[u8]) -> bool {
    read_u32(payload, 0) == Some(GameOpcode::GameAction as u32)
        && read_u32(payload, 8) == Some(GameActionOpcode::PingRequest as u32)
}

/// A `PlayerCreate` (0xF746): the player is in the world from here on (the
/// recv loop's `LoopState::InWorld` edge, session/messages/login.rs).
pub(crate) fn is_player_create_message(payload: &[u8]) -> bool {
    read_u32(payload, 0) == Some(GameOpcode::PlayerCreate as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_protocol::messages::game_action::GameActionMessage;
    use holtburger_protocol::messages::misc::actions::{
        LoginCompleteActionData, PingRequestActionData,
    };
    use holtburger_protocol::messages::{GameAction, GameMessage, PlayerCreateData};
    use holtburger_protocol::traits::ProtocolPack;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn packed(message: &GameMessage) -> Vec<u8> {
        let mut bytes = Vec::new();
        ProtocolPack::pack(message, &mut bytes);
        bytes
    }

    fn packed_action(action: GameAction) -> Vec<u8> {
        packed(&GameMessage::GameAction(Box::new(GameActionMessage {
            sequence: 7,
            action,
        })))
    }

    #[test]
    fn overlapping_sends_credit_the_first_send() {
        // Three drivers ping while one is in flight: the response belongs to
        // the first (ACE answers in order), so the RTT is measured from it.
        let t0 = Instant::now();
        let mut ping = PingRoundTrip::new();
        assert!(ping.note_sent(t0, true));
        assert!(
            !ping.note_sent(t0 + ms(400), true),
            "second send keeps the first stamp"
        );
        assert!(!ping.note_sent(t0 + ms(900), true));
        assert_eq!(ping.note_response_ms(t0 + ms(1000)), Some(1000));
        // The answers to the overlapped pings find nothing in flight and do
        // not overwrite the measurement.
        assert_eq!(ping.note_response_ms(t0 + ms(1400)), None);
        assert_eq!(ping.note_response_ms(t0 + ms(1900)), None);
        assert_eq!(ping.last_rtt_ms(), Some(1000));
    }

    #[test]
    fn the_next_send_after_a_response_stamps_again() {
        let t0 = Instant::now();
        let mut ping = PingRoundTrip::new();
        ping.note_sent(t0, true);
        assert_eq!(ping.note_response_ms(t0 + ms(80)), Some(80));
        assert!(ping.note_sent(t0 + ms(2500), true));
        assert_eq!(ping.note_response_ms(t0 + ms(2620)), Some(120));
        assert_eq!(ping.last_rtt_ms(), Some(120));
    }

    #[test]
    fn an_unanswered_entering_world_ping_does_not_inflate_the_next_rtt() {
        // ACE drops the EnteringWorld ping (no player yet). It must not be
        // stamped, or the first in-world response would measure from it.
        let t0 = Instant::now();
        let mut ping = PingRoundTrip::new();
        assert!(!ping.note_sent(t0, false));
        assert!(!ping.note_sent(t0 + ms(2000), false));
        assert!(
            ping.note_sent(t0 + ms(3000), true),
            "first in-world ping stamps"
        );
        assert_eq!(ping.note_response_ms(t0 + ms(3150)), Some(150));
    }

    #[test]
    fn an_unsolicited_response_is_ignored() {
        // ACE's character-select PingResponse every 100 s (Session.cs).
        let mut ping = PingRoundTrip::new();
        assert_eq!(ping.note_response_ms(Instant::now()), None);
        assert_eq!(ping.last_rtt_ms(), None);
    }

    #[test]
    fn a_stale_stamp_expires() {
        // The link goes dead: nothing sent from t0 on is answered. Once
        // nothing has been answered for the stale window, what is out is
        // forgotten and the next send stamps.
        let t0 = Instant::now();
        let mut ping = PingRoundTrip::new();
        assert!(ping.note_sent(t0, true));
        for s in 1..10 {
            assert!(!ping.note_sent(t0 + Duration::from_secs(s), true));
        }
        assert!(!ping.note_sent(t0 + PING_STAMP_STALE_AFTER - ms(1), true));
        let restamp = t0 + PING_STAMP_STALE_AFTER;
        assert!(
            ping.note_sent(restamp, true),
            "a stamp this old is replaced"
        );
        assert_eq!(ping.note_response_ms(restamp + ms(200)), Some(200));
    }

    /// One ping: when it goes out (offset from `t0`) and its round trip.
    type Sim = (Duration, Duration);

    /// Drives `clock` through `pings` (sorted by send, every one answerable)
    /// with ACE's in-order answers: an answer never overtakes an earlier one.
    /// A response due at the same instant as a send is handled first.
    /// Returns, per response, the true RTT of the ping it answers and the
    /// clock's reading.
    fn simulate(
        clock: &mut PingRoundTrip,
        t0: Instant,
        pings: &[Sim],
    ) -> Vec<(Duration, Option<Duration>)> {
        let mut answered_at = Vec::with_capacity(pings.len());
        let mut latest = Duration::ZERO;
        for &(sent, rtt) in pings {
            latest = latest.max(sent + rtt);
            answered_at.push(latest);
        }
        let mut readings = Vec::with_capacity(pings.len());
        let mut next_send = 0;
        for (i, &at) in answered_at.iter().enumerate() {
            while next_send < pings.len() && pings[next_send].0 < at {
                clock.note_sent(t0 + pings[next_send].0, true);
                next_send += 1;
            }
            readings.push((at - pings[i].0, clock.note_response(t0 + at)));
        }
        readings
    }

    /// Every reading is the true RTT of the ping its response answered.
    /// Returns how many readings there were.
    fn assert_readings_true(readings: &[(Duration, Option<Duration>)]) -> usize {
        for (i, &(truth, reading)) in readings.iter().enumerate() {
            if let Some(reading) = reading {
                assert_eq!(reading, truth, "response {i} was credited to another send");
            }
        }
        readings
            .iter()
            .filter(|(_, reading)| reading.is_some())
            .count()
    }

    /// Pings every `step_ms` from `from_ms` up to `until_ms`, each with
    /// `rtt(sent_ms)`.
    fn cadence(from_ms: u64, step_ms: u64, until_ms: u64, rtt: impl Fn(u64) -> u64) -> Vec<Sim> {
        (from_ms..until_ms)
            .step_by(step_ms as usize)
            .map(|sent| (ms(sent), ms(rtt(sent))))
            .collect()
    }

    #[test]
    fn a_slow_link_still_measures_slow() {
        // A 4 s round trip (past the indicator's 3 s "bad" bar) with pings
        // every second, for longer than the stale window. Each response
        // after the first answers a ping sent while another was out; the old
        // clock credited it to the newest stamp and read the 1 s ping gap.
        let t0 = Instant::now();
        let mut ping = PingRoundTrip::new();
        let readings = simulate(&mut ping, t0, &cadence(0, 1000, 30_000, |_| 4000));
        assert_eq!(readings.len(), 30);
        assert!(assert_readings_true(&readings) >= 1);
        assert_eq!(readings[0].1, Some(ms(4000)));
        assert_eq!(ping.last_rtt_ms(), Some(4000), "the link still reads slow");
    }

    #[test]
    fn answers_to_overlapped_pings_are_not_measured_from_a_later_send() {
        let t0 = Instant::now();
        let mut ping = PingRoundTrip::new();
        assert!(ping.note_sent(t0, true));
        assert!(!ping.note_sent(t0 + ms(1000), true));
        assert!(!ping.note_sent(t0 + ms(2000), true));
        assert_eq!(ping.note_response_ms(t0 + ms(4000)), Some(4000));
        // Two pings are still out, so this send is not stamped and the next
        // response (the t0+1 s ping's answer) measures nothing.
        assert!(!ping.note_sent(t0 + ms(4100), true), "pings are still out");
        assert_eq!(ping.note_response_ms(t0 + ms(5000)), None);
        assert_eq!(ping.note_response_ms(t0 + ms(6000)), None);
        assert_eq!(ping.note_response_ms(t0 + ms(8100)), None);
        // All answered: the next send stamps again.
        assert!(ping.note_sent(t0 + ms(9000), true));
        assert_eq!(ping.note_response_ms(t0 + ms(9300)), Some(300));
    }

    #[test]
    fn a_link_that_recovers_measures_fast_again() {
        // 4 s for the first 20 s, then 100 ms. The answers to the fast pings
        // queue behind the slow ones, the count drains, and the first ping
        // sent with nothing out measures the fast link.
        let t0 = Instant::now();
        let mut ping = PingRoundTrip::new();
        let pings = cadence(
            0,
            1000,
            40_000,
            |sent| if sent < 20_000 { 4000 } else { 100 },
        );
        let readings = simulate(&mut ping, t0, &pings);
        assert!(assert_readings_true(&readings) >= 2);
        assert_eq!(ping.last_rtt_ms(), Some(100));
    }

    #[test]
    fn overlapping_drivers_measure_every_ping_sent_with_none_out() {
        // The 2.5 s setInterval and the 2 s keepalive worker drift against
        // each other, so gaps run from 0.2 s to 2 s. Pings sent 0.2 s apart
        // overlap a 300 ms round trip; the rest each measure 300 ms.
        let t0 = Instant::now();
        let mut ping = PingRoundTrip::new();
        let mut pings = cadence(0, 2500, 60_000, |_| 300);
        pings.extend(cadence(300, 2000, 60_000, |_| 300));
        pings.sort();
        let readings = simulate(&mut ping, t0, &pings);
        let measured = assert_readings_true(&readings);
        assert!(
            measured > pings.len() / 2,
            "{measured} of {} measured",
            pings.len()
        );
        assert!(measured < pings.len(), "an overlapped ping is not measured");
    }

    #[test]
    fn a_lost_overlapped_ping_holds_the_last_true_reading() {
        // A ping lost while the link answers the rest looks like a slower
        // link, so the clock never reads short off it: it keeps its last
        // true reading until the next login (or a stale window of silence).
        let t0 = Instant::now();
        let mut ping = PingRoundTrip::new();
        assert!(ping.note_sent(t0, true));
        ping.note_sent(t0 + ms(500), true); // never answered
        assert_eq!(ping.note_response_ms(t0 + ms(1000)), Some(1000));
        for s in 2..30 {
            let sent = t0 + Duration::from_secs(s);
            assert!(!ping.note_sent(sent, true));
            assert_eq!(ping.note_response_ms(sent + ms(100)), None);
        }
        assert_eq!(ping.last_rtt_ms(), Some(1000));
        ping.note_entered_world();
        let sent = t0 + Duration::from_secs(31);
        assert!(ping.note_sent(sent, true));
        assert_eq!(ping.note_response_ms(sent + ms(100)), Some(100));
    }

    #[test]
    fn entering_the_world_forgets_character_select_pings() {
        // After a logoff the loop still counts its pings as answerable, but
        // ACE answers none at character select. Without the reset the first
        // in-world answer would be measured from the t0 stamp (6.15 s).
        let t0 = Instant::now();
        let mut ping = PingRoundTrip::new();
        assert!(ping.note_sent(t0, true));
        for s in 1..6 {
            ping.note_sent(t0 + Duration::from_secs(s), true);
        }
        ping.note_entered_world();
        let sent = t0 + Duration::from_secs(6);
        assert!(ping.note_sent(sent, true), "the first in-world ping stamps");
        assert_eq!(ping.note_response_ms(sent + ms(150)), Some(150));
    }

    #[test]
    fn ping_response_is_recognised_from_the_wire_fixture() {
        let fixture = holtburger_protocol::test_fixtures::PING_RESPONSE;
        assert!(is_ping_response_message(fixture));
        assert!(!is_ping_request_message(fixture));
        assert!(!is_player_create_message(fixture));

        // Same envelope, another event type (PlayerDescription 0x0013).
        let mut other = fixture.to_vec();
        other[12..16].copy_from_slice(&0x0013u32.to_le_bytes());
        assert!(!is_ping_response_message(&other));
    }

    #[test]
    fn ping_request_is_recognised_in_a_packed_action() {
        let ping = packed_action(GameAction::PingRequest(Box::new(PingRequestActionData)));
        assert!(is_ping_request_message(&ping));
        assert!(!is_ping_response_message(&ping));

        let login_complete =
            packed_action(GameAction::LoginComplete(Box::new(LoginCompleteActionData)));
        assert!(!is_ping_request_message(&login_complete));
    }

    #[test]
    fn player_create_is_recognised() {
        let create = packed(&GameMessage::PlayerCreate(Box::new(PlayerCreateData {
            guid: holtburger_common::Guid(0x5000_0001),
        })));
        assert!(is_player_create_message(&create));
        assert!(!is_ping_response_message(&create));
    }

    #[test]
    fn short_buffers_match_nothing() {
        for len in 0..16 {
            let bytes = vec![0u8; len];
            assert!(!is_ping_response_message(&bytes));
            assert!(!is_ping_request_message(&bytes));
            assert!(!is_player_create_message(&bytes));
        }
        // An opcode with the event type cut off.
        let fixture = holtburger_protocol::test_fixtures::PING_RESPONSE;
        assert!(!is_ping_response_message(&fixture[..15]));
    }
}
