//! net-1 (R2-net 2026-10-08): the recv loop's dead-session decision, kept
//! pure and non-wasm-gated so it is unit-tested natively.
//!
//! Retail `ClientNet::ProcessConnection` (acclient.c:372842) declares the
//! link dead only when
//! `cur_time - lastDidUseTime_ < 140.0 && local_time - m_LocalTimeLastGotData > 140.0`
//! (acclient.c:372914-372915). `lastDidUseTime_` is the time of the PREVIOUS
//! net pump (`SharedNet::UseTime` stamps it after reading the socket), so a
//! client that itself stalled for 140 s or more does not blame the server on
//! the first pump after the stall: it reads its socket first and judges on
//! the next pump. OpenAC `WorldSession.IsServerSilent` matches.
//!
//! holtburger-web's equivalent of the "pump" is the recv loop's 5 s
//! keepalive tick, and its inbound stamp is `last_recv_instant`, refreshed
//! by every decoded game message AND every TimeSync (the TimeSync is
//! encrypted, so it proves the S2C ISAAC stream still validates; ACE sends
//! one every 20 s in every state, including character select, where it
//! sends no game messages at all). The old detector used 90 s, game
//! messages only and no stall guard, so it falsely disconnected a healthy
//! session idling at character select or chargen.

use std::time::Duration;
use web_time::Instant;

/// Retail's server-silence threshold (acclient.c:372914-372915).
pub(crate) const SERVER_SILENCE_TIMEOUT: Duration = Duration::from_secs(140);

/// No inbound decode at all this long after the recv loop started: the
/// handshake never completed (unchanged conn-fix 2026-07-18 rule).
pub(crate) const NEVER_HEARD_TIMEOUT: Duration = Duration::from_secs(60);

/// `true` when the recv loop should give the session up as dead.
///
/// * `last_inbound` — the last decoded game message or TimeSync (`None` =
///   nothing yet since the loop started).
/// * `loop_started` — when the recv loop began.
/// * `prev_tick` — the previous keepalive tick (retail `lastDidUseTime_`).
/// * `now` — this tick.
/// * `silence` — the threshold ([`SERVER_SILENCE_TIMEOUT`]).
///
/// The stall guard: if this tick comes `silence` or more after the previous
/// one, the loop itself was not running (frozen main thread, suspended
/// tab), so nothing is judged on this tick; the recv arm gets to drain
/// whatever queued up first, and the next tick judges normally. Silence
/// must be strictly past the threshold.
pub(crate) fn session_presumed_dead(
    last_inbound: Option<Instant>,
    loop_started: Instant,
    prev_tick: Instant,
    now: Instant,
    silence: Duration,
) -> bool {
    if now.saturating_duration_since(prev_tick) >= silence {
        return false;
    }
    match last_inbound {
        Some(last) => now.saturating_duration_since(last) > silence,
        None => now.saturating_duration_since(loop_started) > NEVER_HEARD_TIMEOUT,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    /// Every test instant is `origin + offset` (any `x - d` below stays at
    /// or after the origin), so nothing underflows on a freshly booted host.
    fn origin() -> Instant {
        Instant::now()
    }

    #[test]
    fn session_presumed_dead_recent_inbound_is_alive() {
        let t0 = origin();
        let now = t0 + secs(1000);
        assert!(!session_presumed_dead(
            Some(now - secs(20)),
            t0,
            now - secs(5),
            now,
            SERVER_SILENCE_TIMEOUT,
        ));
    }

    #[test]
    fn session_presumed_dead_char_select_timesync_cadence_is_alive() {
        // Character select: ACE sends only a TimeSync every 20 s. 100 s of
        // that cadence never trips the detector (the old 90 s message-only
        // rule did, because TimeSync never stamped it).
        let t0 = origin();
        for k in 1..=20u64 {
            let now = t0 + secs(5 * k);
            let last_timesync = t0 + secs((5 * k / 20) * 20);
            assert!(!session_presumed_dead(
                Some(last_timesync),
                t0,
                now - secs(5),
                now,
                SERVER_SILENCE_TIMEOUT,
            ));
        }
    }

    #[test]
    fn session_presumed_dead_silence_past_140s_is_dead() {
        let t0 = origin();
        let now = t0 + secs(1000);
        assert!(session_presumed_dead(
            Some(now - secs(141)),
            t0,
            now - secs(5),
            now,
            SERVER_SILENCE_TIMEOUT,
        ));
    }

    #[test]
    fn session_presumed_dead_threshold_is_strictly_past() {
        let t0 = origin();
        let now = t0 + secs(1000);
        assert!(!session_presumed_dead(
            Some(now - SERVER_SILENCE_TIMEOUT),
            t0,
            now - secs(5),
            now,
            SERVER_SILENCE_TIMEOUT,
        ));
        // 90 s (the old threshold) is no longer dead.
        assert!(!session_presumed_dead(
            Some(now - secs(91)),
            t0,
            now - secs(5),
            now,
            SERVER_SILENCE_TIMEOUT,
        ));
    }

    #[test]
    fn session_presumed_dead_client_stall_is_not_blamed_on_server() {
        // The loop itself was frozen for 200 s: the first tick after the
        // stall does not judge; the next tick 5 s later does (here the
        // server really was silent, so it is dead then).
        let t0 = origin();
        let stalled_tick = t0 + secs(1000);
        let last = stalled_tick - secs(200);
        let prev = stalled_tick - secs(200);
        assert!(!session_presumed_dead(
            Some(last),
            t0,
            prev,
            stalled_tick,
            SERVER_SILENCE_TIMEOUT,
        ));
        let next_tick = stalled_tick + secs(5);
        assert!(session_presumed_dead(
            Some(last),
            t0,
            stalled_tick,
            next_tick,
            SERVER_SILENCE_TIMEOUT,
        ));
        // ...but if the recv arm drained queued traffic in between (stamping
        // `last_inbound`), the next tick sees a live session.
        assert!(!session_presumed_dead(
            Some(stalled_tick + secs(1)),
            t0,
            stalled_tick,
            next_tick,
            SERVER_SILENCE_TIMEOUT,
        ));
    }

    #[test]
    fn session_presumed_dead_stall_guard_is_the_threshold() {
        // A tick gap just under the threshold still judges (retail `< 140.0`).
        let t0 = origin();
        let now = t0 + secs(1000);
        assert!(session_presumed_dead(
            Some(now - secs(300)),
            t0,
            now - secs(139),
            now,
            SERVER_SILENCE_TIMEOUT,
        ));
        assert!(!session_presumed_dead(
            Some(now - secs(300)),
            t0,
            now - SERVER_SILENCE_TIMEOUT,
            now,
            SERVER_SILENCE_TIMEOUT,
        ));
    }

    #[test]
    fn session_presumed_dead_never_heard_uses_handshake_timeout() {
        let t0 = origin();
        assert!(session_presumed_dead(
            None,
            t0,
            t0 + secs(56),
            t0 + secs(61),
            SERVER_SILENCE_TIMEOUT,
        ));
        assert!(!session_presumed_dead(
            None,
            t0,
            t0 + secs(25),
            t0 + secs(30),
            SERVER_SILENCE_TIMEOUT,
        ));
    }
}
