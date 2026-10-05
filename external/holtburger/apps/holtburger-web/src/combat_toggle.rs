//! latency (2026-10-05) — retail-style combat-mode toggle under latency.
//!
//! Retail `ClientCombatSystem::SetCombatMode` (acclient.c:408787) writes
//! `this->combatMode` LOCALLY at request time, then sends
//! `CM_Combat::Event_ChangeCombatMode`; `ToggleCombatMode` (:409413) reads
//! that local field. Our toggle read only the server-confirmed
//! `PropertyInt::CombatMode`, so a second press inside one round trip (enter
//! then immediately leave combat) re-sent the SAME target and the second
//! intent was lost until the echo landed — through a 50–150 ms tunnel the
//! toggle felt sticky.
//!
//! [`effective_combat_mode`] is the mode the toggle treats as current: the
//! last REQUESTED mode while the server has not spoken since the request
//! (confirmed mode unchanged) and the request is younger than
//! [`PENDING_COMBAT_REQUEST_TTL_MS`]; otherwise the confirmed mode. A server
//! echo (or a server-side revert: out of ammo, no caster) changes the
//! confirmed mode and immediately retires the prediction, so the server
//! stays authoritative.

use holtburger_protocol::messages::CombatMode;

/// How long an un-echoed request stays authoritative for the toggle. ACE
/// echoes `PropertyInt::CombatMode` within one round trip plus at most a
/// stance-swap animation; 2 s covers a slow tunnel without letting a lost
/// request strand the toggle.
pub(crate) const PENDING_COMBAT_REQUEST_TTL_MS: f64 = 2000.0;

/// One in-flight `ChangeCombatMode` request.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct PendingCombatRequest {
    /// The mode we asked the server for.
    pub requested: CombatMode,
    /// The server-confirmed mode when we asked.
    pub confirmed_at_request: CombatMode,
}

/// The mode the toggle should treat as current. `age_ms` = time since the
/// pending request was sent (ignored when there is none).
pub(crate) fn effective_combat_mode(
    confirmed: CombatMode,
    pending: Option<PendingCombatRequest>,
    age_ms: f64,
) -> CombatMode {
    match pending {
        Some(p)
            if confirmed == p.confirmed_at_request
                && (0.0..PENDING_COMBAT_REQUEST_TTL_MS).contains(&age_ms) =>
        {
            p.requested
        }
        _ => confirmed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(requested: CombatMode, at: CombatMode) -> Option<PendingCombatRequest> {
        Some(PendingCombatRequest { requested, confirmed_at_request: at })
    }

    #[test]
    fn no_pending_reads_confirmed() {
        assert_eq!(effective_combat_mode(CombatMode::Melee, None, 0.0), CombatMode::Melee);
    }

    #[test]
    fn unechoed_request_is_current() {
        // Pressed "enter combat" 80 ms ago; echo not back yet → a second
        // press must see Melee and therefore toggle back to NonCombat.
        let p = req(CombatMode::Melee, CombatMode::NonCombat);
        assert_eq!(effective_combat_mode(CombatMode::NonCombat, p, 80.0), CombatMode::Melee);
    }

    #[test]
    fn echo_retires_prediction() {
        let p = req(CombatMode::Melee, CombatMode::NonCombat);
        assert_eq!(effective_combat_mode(CombatMode::Melee, p, 80.0), CombatMode::Melee);
        // Server reverted to something else (e.g. out of ammo): server wins.
        let p = req(CombatMode::Missile, CombatMode::NonCombat);
        assert_eq!(effective_combat_mode(CombatMode::Melee, p, 80.0), CombatMode::Melee);
    }

    #[test]
    fn stale_request_expires() {
        let p = req(CombatMode::Melee, CombatMode::NonCombat);
        assert_eq!(
            effective_combat_mode(CombatMode::NonCombat, p, PENDING_COMBAT_REQUEST_TTL_MS),
            CombatMode::NonCombat
        );
        assert_eq!(effective_combat_mode(CombatMode::NonCombat, p, -1.0), CombatMode::NonCombat);
    }
}
