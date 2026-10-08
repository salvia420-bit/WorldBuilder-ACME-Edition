//! R-chat (round 2, 2026-10-08) — retail chat-line wording and the
//! client-side hear / squelch decisions, kept as pure functions so the
//! native `cargo test -p holtburger-web --lib chat_format` covers them. The
//! recv-loop arms (`session/messages/chat.rs`, `session/messages/game_event.rs`)
//! only call in; they own the event pushes.
//!
//! Retail sources (acclient.c):
//! - `ClientCommunicationSystem::Handle_Communication__HearSpeech` (413338):
//!   own line → `You say, "%s"`; others → `%s says, "%s"` after `CanHear`.
//! - `Handle_Communication__HearDirectSpeech` (413504): sender == target →
//!   `You think, "%s"`; otherwise `%s tells you, "%s"`, and only a sender in
//!   the player range `0x50000001..=0x6FFFFFFF` becomes the reply target.
//! - `Handle_Communication__ChannelBroadcast` (412975): an empty sender name
//!   is the local player's own send; heard and sent sentences differ per
//!   channel. Names from `ChannelSystem::GetChannelName` (507680).
//! - `Handle_Communication__HearEmote` (422448): name, then `' '` unless the
//!   text starts with an apostrophe, then the text; a trailing `^` / `&`
//!   (ACE's Olthoi-player name suffix) is trimmed off the name first.
//! - `ClientCommunicationSystem::Pose` (425512): `%p` in the broadcast emote
//!   becomes "his" when PropertyInt Gender (0x71) is 1 (or absent), else "her".
//! - `gmCCommunicationSystem::CanHear` (434317) + `SquelchDB::IsSquelched`
//!   (714573) + `LogTextTypeEnumMapper::IsLegalChannel` (713311).

/// First guid of the player range (retail HearDirectSpeech reply gate).
pub(crate) const FIRST_PLAYER_GUID: u32 = 0x5000_0001;
/// Last guid of the player range.
pub(crate) const LAST_PLAYER_GUID: u32 = 0x6FFF_FFFF;

/// Legacy `ChatChannel` ids that have their own retail sentences.
pub(crate) const CHANNEL_ABUSE: u32 = 0x0000_0001;
pub(crate) const CHANNEL_HELP: u32 = 0x0000_0400;
pub(crate) const CHANNEL_FELLOW: u32 = 0x0000_0800;
pub(crate) const CHANNEL_VASSALS: u32 = 0x0000_1000;
pub(crate) const CHANNEL_PATRON: u32 = 0x0000_2000;
pub(crate) const CHANNEL_MONARCH: u32 = 0x0000_4000;
pub(crate) const CHANNEL_COVASSALS: u32 = 0x0100_0000;
pub(crate) const CHANNEL_ALLEGIANCE_BROADCAST: u32 = 0x0200_0000;
pub(crate) const CHANNEL_FELLOW_BROADCAST: u32 = 0x0400_0000;

/// Retail `eTextType` values (same numbering as ACE `ChatMessageType`)
/// that the legacy-channel sentences are printed under.
pub(crate) const TEXT_TYPE_CHANNEL: u32 = 0x08;
pub(crate) const TEXT_TYPE_CHANNEL_SEND: u32 = 0x09;
pub(crate) const TEXT_TYPE_SOCIAL: u32 = 0x0A;
pub(crate) const TEXT_TYPE_SOCIAL_SEND: u32 = 0x0B;
pub(crate) const TEXT_TYPE_EMOTE: u32 = 0x0C;
pub(crate) const TEXT_TYPE_ABUSE: u32 = 0x0E;
pub(crate) const TEXT_TYPE_HELP: u32 = 0x0F;
pub(crate) const TEXT_TYPE_SPELLCASTING: u32 = 0x11;
pub(crate) const TEXT_TYPE_FELLOWSHIP: u32 = 0x13;

/// True for a guid in the player range (`0x50000001..=0x6FFFFFFF`).
pub(crate) fn is_player_guid(guid: u32) -> bool {
    (FIRST_PLAYER_GUID..=LAST_PLAYER_GUID).contains(&guid)
}

/// Trim ACE's Olthoi-player name suffix. Retail checks `^` first and trims
/// trailing `^`; otherwise it checks `&` and trims trailing `&`.
pub(crate) fn strip_name_markers(name: &str) -> &str {
    if name.contains('^') {
        name.trim_end_matches('^')
    } else if name.contains('&') {
        name.trim_end_matches('&')
    } else {
        name
    }
}

/// `Bob waves.` / `Bob's eyes narrow.` — no space before an apostrophe.
pub(crate) fn format_emote_line(name: &str, text: &str) -> String {
    if text.starts_with('\'') {
        format!("{name}{text}")
    } else {
        format!("{name} {text}")
    }
}

/// Local speech: the local player's own line reads `You say, "…"`.
pub(crate) fn format_hear_speech(is_self: bool, name: &str, msg: &str) -> String {
    if is_self {
        format!("You say, \"{msg}\"")
    } else {
        format!("{name} says, \"{msg}\"")
    }
}

/// Incoming tell: a tell to yourself reads `You think, "…"`.
pub(crate) fn format_tell(sender_id: u32, target_id: u32, name: &str, msg: &str) -> String {
    if sender_id == target_id {
        format!("You think, \"{msg}\"")
    } else {
        format!("{name} tells you, \"{msg}\"")
    }
}

/// The `/reply` target a tell sets: only another PLAYER (never an NPC or
/// yourself), with the name markers trimmed.
pub(crate) fn tell_reply_target(sender_id: u32, target_id: u32, name: &str) -> Option<String> {
    if sender_id == target_id || !is_player_guid(sender_id) {
        return None;
    }
    let name = strip_name_markers(name);
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Retail `ChannelSystem::GetChannelName`.
pub(crate) fn legacy_channel_name(chan: u32) -> Option<&'static str> {
    Some(match chan {
        0x0000_0001 => "Abuse",
        0x0000_0002 => "Admin",
        0x0000_0004 => "Audit",
        0x0000_0008 => "Advocate 1",
        0x0000_0010 => "Advocate 2",
        0x0000_0020 => "Advocate 3",
        0x0000_0200 => "Sentinel",
        0x0000_0400 => "Help",
        0x0000_0800 => "Fellowship",
        0x0000_1000 => "Vassals",
        0x0000_2000 => "Patron",
        0x0000_4000 => "Monarch",
        0x0100_0000 => "Co-vassals",
        0x0200_0000 => "Allegiance",
        0x0400_0000 => "FellowBroadcast",
        0x0800_0000 => "Celestial Hand",
        0x1000_0000 => "Eldrytch Web",
        0x2000_0000 => "Radiant Blood",
        0x4000_0000 => "Olthoi",
        _ => return None,
    })
}

/// One legacy `ChannelBroadcast` line. `sender` must already be marker-
/// stripped; an empty sender is the local player's own send (ACE echoes
/// your own channel line with sender `""`).
pub(crate) fn format_channel_broadcast(chan: u32, sender: &str, msg: &str) -> String {
    let name = legacy_channel_name(chan).unwrap_or("<unknown>");
    if sender.is_empty() {
        match chan {
            CHANNEL_FELLOW => format!("[Fellowship] You say, \"{msg}\""),
            CHANNEL_VASSALS | CHANNEL_PATRON | CHANNEL_MONARCH => {
                format!("You say to your {name}, \"{msg}\"")
            }
            CHANNEL_COVASSALS => format!("[Co-Vassals] You say, \"{msg}\""),
            CHANNEL_ALLEGIANCE_BROADCAST => format!("[Allegiance Broadcast] You say, \"{msg}\""),
            // Retail prints a fellowship broadcast as written.
            CHANNEL_FELLOW_BROADCAST => msg.to_string(),
            _ => format!("You say on the {name} channel, \"{msg}\""),
        }
    } else {
        match chan {
            CHANNEL_FELLOW => format!("[Fellowship] {sender} says, \"{msg}\""),
            // A line on the Vassals channel comes FROM your patron, etc.
            CHANNEL_VASSALS => format!("Your patron {sender} says to you, \"{msg}\""),
            CHANNEL_PATRON => format!("Your vassal {sender} says to you, \"{msg}\""),
            CHANNEL_MONARCH => format!("Your follower {sender} says to you, \"{msg}\""),
            CHANNEL_COVASSALS => format!("[Co-Vassals] {sender} says, \"{msg}\""),
            CHANNEL_ALLEGIANCE_BROADCAST => {
                format!("[Allegiance Broadcast] {sender} says, \"{msg}\"")
            }
            _ => format!("{sender} says on the {name} channel, \"{msg}\""),
        }
    }
}

/// The retail text type a legacy channel line is printed under (drives its
/// colour: 8/9 pink, 10/19 yellow, 11 tan, 15 dark red). Port of OpenAC
/// `LegacyChannelChatType.Resolve`, checked against acclient.c 412975.
pub(crate) fn legacy_channel_text_type(chan: u32, own: bool) -> u32 {
    match chan {
        CHANNEL_FELLOW => TEXT_TYPE_FELLOWSHIP,
        CHANNEL_VASSALS | CHANNEL_PATRON | CHANNEL_MONARCH => {
            if own {
                TEXT_TYPE_SOCIAL_SEND
            } else {
                TEXT_TYPE_SOCIAL
            }
        }
        CHANNEL_COVASSALS | CHANNEL_ALLEGIANCE_BROADCAST => TEXT_TYPE_SOCIAL,
        CHANNEL_FELLOW_BROADCAST => {
            if own {
                TEXT_TYPE_FELLOWSHIP
            } else {
                TEXT_TYPE_CHANNEL
            }
        }
        CHANNEL_HELP => TEXT_TYPE_HELP,
        CHANNEL_ABUSE => TEXT_TYPE_ABUSE,
        _ => {
            if own {
                TEXT_TYPE_CHANNEL_SEND
            } else {
                TEXT_TYPE_CHANNEL
            }
        }
    }
}

/// Retail `Pose`'s `%p` substitution: "his" for Gender 1 or no Gender.
pub(crate) fn possessive_for_gender(gender: Option<i32>) -> &'static str {
    match gender {
        None | Some(1) => "his",
        Some(_) => "her",
    }
}

/// Retail `LogTextTypeEnumMapper::IsLegalChannel` (= ACE
/// `SquelchManager.IsLegalChannel`): the text types a squelch can filter.
pub(crate) fn is_legal_squelch_channel(chat_type: u32) -> bool {
    matches!(
        chat_type,
        2 | 3 | 6 | 7 | 12 | 16 | 17 | 18 | 19 | 21 | 22 | 23 | 24 | 25
    )
}

fn text_type_bit(chat_type: u32) -> u32 {
    if chat_type < 32 {
        1u32 << chat_type
    } else {
        0
    }
}

/// Retail `gmCCommunicationSystem::CanHear` minus the radar-radius gate.
/// `entry` is the sender's squelch-DB row `(filter mask, is_account)`;
/// `globals_mask` the per-type global squelch. Sender 0 always passes.
/// Order is retail `SquelchDB::IsSquelched`: globals, then (except for
/// Spellcasting) the account flag, then the character mask.
pub(crate) fn can_hear(
    sender: u32,
    chat_type: u32,
    entry: Option<(u32, bool)>,
    globals_mask: u32,
) -> bool {
    if sender == 0 {
        return true;
    }
    if !(chat_type == 1 || is_legal_squelch_channel(chat_type)) {
        return true;
    }
    let bit = text_type_bit(chat_type);
    if globals_mask & bit != 0 {
        return false;
    }
    if chat_type == TEXT_TYPE_SPELLCASTING {
        return true;
    }
    match entry {
        Some((_, true)) => false,
        Some((mask, false)) => mask & bit == 0,
        None => true,
    }
}

/// Retail `Handle_Communication__TextboxString` / `ChannelBroadcast`:
/// server text shows unless its type is globally squelched
/// (`IsSquelched(0, …, type)`).
pub(crate) fn textbox_visible(chat_type: u32, globals_mask: u32) -> bool {
    !(is_legal_squelch_channel(chat_type) && globals_mask & text_type_bit(chat_type) != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emote_line_joins_name_and_text() {
        assert_eq!(format_emote_line("Bob", "waves."), "Bob waves.");
        assert_eq!(
            format_emote_line("Bob", "'s eyes narrow."),
            "Bob's eyes narrow."
        );
        assert_eq!(format_emote_line(strip_name_markers("Bob^"), "waves."), "Bob waves.");
    }

    #[test]
    fn name_markers_are_trimmed() {
        assert_eq!(strip_name_markers("Bob^"), "Bob");
        assert_eq!(strip_name_markers("Bob&"), "Bob");
        assert_eq!(strip_name_markers("Bob"), "Bob");
        assert_eq!(strip_name_markers(""), "");
    }

    #[test]
    fn hear_speech_self_and_other() {
        assert_eq!(format_hear_speech(true, "Bob", "hi"), "You say, \"hi\"");
        assert_eq!(format_hear_speech(false, "Bob", "hi"), "Bob says, \"hi\"");
    }

    #[test]
    fn tell_to_self_is_a_thought() {
        assert_eq!(format_tell(7, 7, "Me", "x"), "You think, \"x\"");
        assert_eq!(format_tell(8, 7, "Bob", "x"), "Bob tells you, \"x\"");
    }

    #[test]
    fn player_guid_range() {
        assert!(is_player_guid(0x5000_0001));
        assert!(is_player_guid(0x6FFF_FFFF));
        assert!(!is_player_guid(0x5000_0000));
        assert!(!is_player_guid(0x7000_0000));
        assert!(!is_player_guid(0x8000_1234));
    }

    #[test]
    fn reply_target_only_from_other_players() {
        assert_eq!(tell_reply_target(0x8000_0001, 0x5000_0002, "Town Crier"), None);
        assert_eq!(tell_reply_target(0x5000_0002, 0x5000_0002, "Me"), None);
        assert_eq!(
            tell_reply_target(0x5000_0003, 0x5000_0002, "Bob&"),
            Some("Bob".to_string())
        );
    }

    #[test]
    fn channel_own_sends() {
        assert_eq!(
            format_channel_broadcast(0x800, "", "inc"),
            "[Fellowship] You say, \"inc\""
        );
        assert_eq!(
            format_channel_broadcast(0x1000, "", "hi"),
            "You say to your Vassals, \"hi\""
        );
        assert_eq!(
            format_channel_broadcast(0x2000, "", "hi"),
            "You say to your Patron, \"hi\""
        );
        assert_eq!(
            format_channel_broadcast(0x4000, "", "hi"),
            "You say to your Monarch, \"hi\""
        );
        assert_eq!(
            format_channel_broadcast(0x0100_0000, "", "hi"),
            "[Co-Vassals] You say, \"hi\""
        );
        assert_eq!(
            format_channel_broadcast(0x0200_0000, "", "hi"),
            "[Allegiance Broadcast] You say, \"hi\""
        );
        assert_eq!(
            format_channel_broadcast(0x400, "", "help"),
            "You say on the Help channel, \"help\""
        );
        assert_eq!(format_channel_broadcast(0x0400_0000, "", "raw"), "raw");
    }

    #[test]
    fn channel_heard_lines() {
        assert_eq!(
            format_channel_broadcast(0x800, "Bob", "inc"),
            "[Fellowship] Bob says, \"inc\""
        );
        assert_eq!(
            format_channel_broadcast(0x1000, "Bob", "hi"),
            "Your patron Bob says to you, \"hi\""
        );
        assert_eq!(
            format_channel_broadcast(0x2000, "Bob", "hi"),
            "Your vassal Bob says to you, \"hi\""
        );
        assert_eq!(
            format_channel_broadcast(0x4000, "Bob", "hi"),
            "Your follower Bob says to you, \"hi\""
        );
        assert_eq!(
            format_channel_broadcast(0x0100_0000, "Bob", "hi"),
            "[Co-Vassals] Bob says, \"hi\""
        );
        assert_eq!(
            format_channel_broadcast(0x0200_0000, "Bob", "hi"),
            "[Allegiance Broadcast] Bob says, \"hi\""
        );
        assert_eq!(
            format_channel_broadcast(0x400, "Bob", "help"),
            "Bob says on the Help channel, \"help\""
        );
        assert_eq!(
            format_channel_broadcast(0x0008_0000, "Bob", "?"),
            "Bob says on the <unknown> channel, \"?\""
        );
    }

    #[test]
    fn channel_text_types() {
        assert_eq!(legacy_channel_text_type(0x800, true), 0x13);
        assert_eq!(legacy_channel_text_type(0x800, false), 0x13);
        assert_eq!(legacy_channel_text_type(0x1000, true), 0x0B);
        assert_eq!(legacy_channel_text_type(0x2000, false), 0x0A);
        assert_eq!(legacy_channel_text_type(0x0100_0000, true), 0x0A);
        assert_eq!(legacy_channel_text_type(0x0200_0000, false), 0x0A);
        assert_eq!(legacy_channel_text_type(0x0400_0000, true), 0x13);
        assert_eq!(legacy_channel_text_type(0x0400_0000, false), 0x08);
        assert_eq!(legacy_channel_text_type(0x400, false), 0x0F);
        assert_eq!(legacy_channel_text_type(0x2, true), 0x09);
        assert_eq!(legacy_channel_text_type(0x2, false), 0x08);
    }

    #[test]
    fn possessive_follows_gender() {
        assert_eq!(possessive_for_gender(Some(1)), "his");
        assert_eq!(possessive_for_gender(Some(2)), "her");
        assert_eq!(possessive_for_gender(None), "his");
    }

    #[test]
    fn can_hear_squelch_rules() {
        // No DB row → audible.
        assert!(can_hear(5, 12, None, 0));
        // Character row squelching Emote only.
        assert!(!can_hear(5, 12, Some((1 << 12, false)), 0));
        assert!(can_hear(5, 2, Some((1 << 12, false)), 0));
        // Account row blocks every legal type.
        assert!(!can_hear(5, 2, Some((0, true)), 0));
        assert!(!can_hear(5, 3, Some((0, true)), 0));
        assert!(!can_hear(5, 12, Some((0, true)), 0));
        // Non-legal type always passes.
        assert!(can_hear(5, 0, Some((0xFFFF_FFFF, true)), 0xFFFF_FFFF));
        // Spellcasting: globals only, never the row.
        assert!(can_hear(5, 17, Some((0xFFFF_FFFF, false)), 0));
        assert!(can_hear(5, 17, Some((0, true)), 0));
        assert!(!can_hear(5, 17, None, 1 << 17));
        // Global squelch of a type blocks every sender.
        assert!(!can_hear(5, 12, None, 1 << 12));
        // Sender 0 always passes.
        assert!(can_hear(0, 12, Some((0xFFFF_FFFF, true)), 0xFFFF_FFFF));
    }

    #[test]
    fn textbox_global_squelch() {
        assert!(!textbox_visible(6, 1 << 6));
        assert!(textbox_visible(5, 1 << 6));
        // System (5) is not a legal squelch channel.
        assert!(textbox_visible(5, 0xFFFF_FFFF));
        assert!(textbox_visible(6, 0));
    }
}
