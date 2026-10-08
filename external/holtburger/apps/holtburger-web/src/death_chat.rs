//! death-6 (R-chat round 2, 2026-10-08) — which death lines reach the chat.
//!
//! Retail `ClientCombatSystem::HandlePlayerDeathEvent` (acclient.c:409097,
//! dispatched for 0x019E) prints NOTHING when the local player is the victim
//! or the killer — those players get their own personal line from
//! `HandleVictimNotificationEvent` (409151, 0x01AC / 0x01AD) — and prints a
//! line only when the message is non-empty. ACE sends the victim BOTH the
//! VictimNotification and the PlayerKilled broadcast (`sendSelf: true`,
//! Player_Death.cs), so without this gate the victim saw two death lines.
//! The structured kind=DEATH event is unaffected (combat HUD / plugins).

/// Whether a `PlayerKilled` (0x019E) broadcast becomes a chat line.
/// `local` is the local player's guid (0 = not known yet, never matches).
pub(crate) fn player_killed_line_visible(victim: u32, killer: u32, local: u32, msg: &str) -> bool {
    !msg.is_empty() && !(local != 0 && (local == victim || local == killer))
}

/// Whether a Victim/Killer notification becomes a chat line (non-empty only).
pub(crate) fn notification_line_visible(msg: &str) -> bool {
    !msg.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: u32 = 0x5000_0001;
    const OTHER: u32 = 0x5000_0002;
    const MOB: u32 = 0x8000_1234;

    #[test]
    fn victim_does_not_see_the_broadcast() {
        assert!(!player_killed_line_visible(ME, MOB, ME, "Me was killed by a drudge!"));
    }

    #[test]
    fn killer_does_not_see_the_broadcast() {
        assert!(!player_killed_line_visible(OTHER, ME, ME, "Other was killed by Me!"));
    }

    #[test]
    fn third_party_sees_the_broadcast() {
        assert!(player_killed_line_visible(OTHER, MOB, ME, "Other was killed by a drudge!"));
    }

    #[test]
    fn empty_message_is_skipped() {
        assert!(!player_killed_line_visible(OTHER, MOB, ME, ""));
        assert!(!notification_line_visible(""));
        assert!(notification_line_visible("You have died!"));
    }

    #[test]
    fn unknown_local_player_shows_the_line() {
        assert!(player_killed_line_visible(ME, MOB, 0, "Me was killed!"));
    }

    #[test]
    fn no_killer_still_shows_for_third_party() {
        // ACE uses ObjectGuid.Invalid (0) when there is no damager.
        assert!(player_killed_line_visible(OTHER, 0, ME, "Other died."));
    }
}
