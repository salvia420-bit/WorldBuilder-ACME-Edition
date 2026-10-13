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
//! - `gmCCommunicationSystem::HandleRangedTalkEvent` (434662): a ranged line
//!   shows only if `ACCWeenieObject::ObjectsInRange(player, sender, range,
//!   0, 0)` (436730) — both objects known and centre distance <= range.
//! - `ClientCommunicationSystem::HandleFailureEvent` (413716): a WeenieError
//!   code its switch has no case for falls to the default, which prints
//!   nothing (`weenie_error_chat_line_with`); every other case's text and
//!   text type come from the generated `holtburger_core::retail_failure_table`.
//! - `ClientCombatSystem::HandleAttackerNotificationEvent` (408294) /
//!   `HandleDefenderNotificationEvent` (409442) / the two evasion handlers
//!   (409275, 409355): the melee / missile hit and evade lines, with the verb
//!   from `CombatSystem::InqCombatHitAdjectives` (500139) and the type word
//!   from `AppraisalSystem::DamageTypeToString` (479074).

use holtburger_common::position::WorldPosition;
use holtburger_protocol::errors::WeenieError;

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

/// Retail `eTextType` Magic (ACE `ChatMessageType.Magic`): the text type an
/// expired-enchantment line is printed under.
pub(crate) const TEXT_TYPE_MAGIC: u32 = 0x07;

/// chat-errors-4 (2026-10-13): retail
/// `ClientMagicSystem::NotifyOfEnchantmentRemoval` (acclient.c:405087) — the
/// line for one removed enchantment `eid` (spell id in the low 16 bits, layer
/// in the high 16). A cooldown id (spell `>= 0x8000`) prints nothing, and so
/// does a spell the SpellTable doesn't know (`name` None: `InqSpellBase`
/// failed, or the table isn't loaded yet). Vitae (666) reads "Vitae penalty".
/// Retail appends "\n"; the chat log adds its own line break.
pub(crate) fn enchantment_expired_line(eid: u32, name: Option<&str>) -> Option<String> {
    const VITAE: u32 = holtburger_core::client::character_info::VITAE_SPELL_ID as u32;
    let spell_id = eid & 0xFFFF;
    if spell_id >= 0x8000 {
        return None;
    }
    let name = name?;
    let penalty = if spell_id == VITAE { " penalty" } else { "" };
    Some(format!("{name}{penalty} has expired."))
}

/// chat-errors-4: the expired lines for one `Magic_RemoveEnchantment` /
/// `RemoveMultipleEnchantments` (0x02C3 / 0x02C5), in wire order. Retail's
/// handlers pass `fNotify = 1` from the UI dispatch (acclient.c:699765,
/// :700487) — the Dispel pair passes 0 and never reaches here. No line when
/// the Magic text type is globally squelched (`IsSquelched(0, …, 7)`).
/// `spell_name` looks a spell id up in the SpellTable.
pub(crate) fn enchantment_expired_lines<'a, F>(
    eids: &[u32],
    globals_mask: u32,
    spell_name: F,
) -> Vec<String>
where
    F: Fn(u32) -> Option<&'a str>,
{
    if !textbox_visible(TEXT_TYPE_MAGIC, globals_mask) {
        return Vec::new();
    }
    eids.iter()
        .filter_map(|&eid| enchantment_expired_line(eid, spell_name(eid & 0xFFFF)))
        .collect()
}

/// chat-errors-4: parse `?buffExpiryLine=off` (or `&…`). DEFAULT-ON
/// off-escape shape (`off`/`0`/`false`); `=off` keeps enchantment expiry
/// silent again (the registry and buff HUD still update).
pub(crate) fn buff_expiry_line_enabled(search: &str) -> bool {
    let trimmed = search.strip_prefix('?').unwrap_or(search);
    !trimmed.split('&').any(|kv| {
        matches!(
            kv,
            "buffExpiryLine=off" | "buffExpiryLine=0" | "buffExpiryLine=false"
        )
    })
}

#[cfg(test)]
mod enchantment_expiry_tests {
    use super::*;

    #[test]
    fn vitae_reads_penalty() {
        assert_eq!(
            enchantment_expired_line(666, Some("Vitae")),
            Some("Vitae penalty has expired.".to_string())
        );
    }

    #[test]
    fn cooldown_ids_print_nothing() {
        assert_eq!(enchantment_expired_line(0x8001, Some("x")), None);
        assert_eq!(enchantment_expired_line(0x8000, Some("x")), None);
        assert_eq!(enchantment_expired_line(0xFFFF, Some("x")), None);
    }

    #[test]
    fn unknown_spell_prints_nothing() {
        assert_eq!(enchantment_expired_line(2, None), None);
    }

    #[test]
    fn named_spell_line() {
        assert_eq!(
            enchantment_expired_line(2, Some("Strength Self I")),
            Some("Strength Self I has expired.".to_string())
        );
    }

    #[test]
    fn layer_bits_are_masked() {
        assert_eq!(
            enchantment_expired_line(0x0002 | (3 << 16), Some("Strength Self I")),
            Some("Strength Self I has expired.".to_string())
        );
        // Vitae on a non-zero layer still gets " penalty".
        assert_eq!(
            enchantment_expired_line(666 | (1 << 16), Some("Vitae")),
            Some("Vitae penalty has expired.".to_string())
        );
        // A cooldown id on a layer stays silent.
        assert_eq!(enchantment_expired_line(0x8001 | (2 << 16), Some("x")), None);
    }

    fn names(id: u32) -> Option<&'static str> {
        match id {
            2 => Some("Strength Self I"),
            666 => Some("Vitae"),
            0x8001 => Some("Cooldown"),
            _ => None,
        }
    }

    #[test]
    fn lines_in_wire_order_skipping_cooldowns_and_unknowns() {
        let eids: [u32; 4] = [2 | (1 << 16), 0x8001, 999, 666];
        assert_eq!(
            enchantment_expired_lines(&eids, 0, names),
            vec![
                "Strength Self I has expired.".to_string(),
                "Vitae penalty has expired.".to_string(),
            ]
        );
        // The lookup receives the layer-stripped spell id.
        let seen: std::cell::RefCell<Vec<u32>> = std::cell::RefCell::new(Vec::new());
        let lines = enchantment_expired_lines(&[2 | (5 << 16)], 0, |id| {
            seen.borrow_mut().push(id);
            names(id)
        });
        assert_eq!(lines, vec!["Strength Self I has expired.".to_string()]);
        assert_eq!(seen.into_inner(), vec![2u32]);
    }

    #[test]
    fn magic_global_squelch_drops_every_line() {
        let eids: [u32; 2] = [2, 666];
        assert!(enchantment_expired_lines(&eids, 1 << TEXT_TYPE_MAGIC, names).is_empty());
        // Another type's squelch bit leaves the Magic lines alone.
        assert_eq!(enchantment_expired_lines(&eids, 1 << 6, names).len(), 2);
        assert_eq!(enchantment_expired_lines(&eids, !(1 << TEXT_TYPE_MAGIC), names).len(), 2);
    }

    #[test]
    fn buff_expiry_line_escape() {
        assert!(buff_expiry_line_enabled(""));
        assert!(buff_expiry_line_enabled("?diag=1"));
        assert!(buff_expiry_line_enabled("?buffExpiryLine=on"));
        assert!(!buff_expiry_line_enabled("?buffExpiryLine=off"));
        assert!(!buff_expiry_line_enabled("?a=1&buffExpiryLine=0"));
        assert!(!buff_expiry_line_enabled("buffExpiryLine=false"));
    }
}

/// Retail `eTextType` 0 (ACE `ChatMessageType.Default`): the text type the
/// QueryAgeResponse line is printed under.
pub(crate) const QUERY_AGE_TEXT_TYPE: u32 = 0x00;

/// chat-errors-8 (2026-10-13): retail
/// `ClientCommunicationSystem::Handle_Character__QueryAgeResponse`
/// (acclient.c:413309) — an empty target name (what ACE always sends, the
/// reply to the player's own `/age`) reads `You have played for %s.`,
/// otherwise `%s has played for %s.`, at text type 0. Retail appends "\n";
/// the chat log adds its own line break.
pub(crate) fn query_age_line(target_name: &str, age: &str) -> String {
    if target_name.is_empty() {
        format!("You have played for {age}.")
    } else {
        format!("{target_name} has played for {age}.")
    }
}

/// chat-errors-8: parse `?retailStatusCmds=off` (or `&…`). DEFAULT-ON
/// off-escape shape (`off`/`0`/`false`); `=off` drops the retail age line
/// (app/client_events.js prints its old `<name|?> <age>` line again, and
/// app/slash_commands.js forwards `/age` / `/birth` to the server).
pub(crate) fn retail_status_cmds_enabled(search: &str) -> bool {
    let trimmed = search.strip_prefix('?').unwrap_or(search);
    !trimmed.split('&').any(|kv| {
        matches!(
            kv,
            "retailStatusCmds=off" | "retailStatusCmds=0" | "retailStatusCmds=false"
        )
    })
}

#[cfg(test)]
mod query_age_tests {
    use super::*;

    #[test]
    fn own_age_reads_you_have_played_for() {
        assert_eq!(query_age_line("", "1d 2h"), "You have played for 1d 2h.");
        assert_eq!(
            query_age_line("", "1y 2mo 3w 4d 5h 6m 7s"),
            "You have played for 1y 2mo 3w 4d 5h 6m 7s."
        );
    }

    #[test]
    fn named_age_reads_has_played_for() {
        assert_eq!(query_age_line("Bob", "3h"), "Bob has played for 3h.");
    }

    #[test]
    fn age_line_is_default_text_type() {
        assert_eq!(QUERY_AGE_TEXT_TYPE, 0);
        // Type 0 is not a squelchable channel: the line always shows.
        assert!(textbox_visible(QUERY_AGE_TEXT_TYPE, u32::MAX));
    }

    #[test]
    fn retail_status_cmds_escape() {
        assert!(retail_status_cmds_enabled(""));
        assert!(retail_status_cmds_enabled("?diag=1"));
        assert!(retail_status_cmds_enabled("?retailStatusCmds=on"));
        assert!(!retail_status_cmds_enabled("?retailStatusCmds=off"));
        assert!(!retail_status_cmds_enabled("?a=1&retailStatusCmds=0"));
        assert!(!retail_status_cmds_enabled("retailStatusCmds=false"));
    }
}

/// chat-errors-3 (2026-10-13): retail `HandleRangedTalkEvent` (acclient.c
/// 434662) prints a HearRangedSpeech line only when
/// `ACCWeenieObject::ObjectsInRange(player_id, sender_id, range, 0, 0)`
/// (:436730) holds — 0 when either object is missing from CObjectMaint,
/// otherwise `get_distance_to_object(.., use_radii 0)` (the 3D centre
/// distance) `<= range`. ACE broadcasts a ranged Say emote to everyone within
/// LocalBroadcastRange (96 m) but writes the emote's Extent into the range
/// field (EmoteManager.cs `EmoteType.Say`), so the client gate is what keeps
/// far-off NPC chatter out. The local player's own line passes (retail's
/// distance to itself is 0). `WorldPosition::distance_to` measures in the
/// global frame across landblocks.
pub(crate) fn ranged_speech_in_range(
    player: Option<&WorldPosition>,
    sender: Option<&WorldPosition>,
    is_self: bool,
    range: f32,
) -> bool {
    if is_self {
        return true;
    }
    match (player, sender) {
        (Some(p), Some(s)) => p.distance_to(s) <= range,
        _ => false,
    }
}

/// chat-errors-3 (2026-10-13): parse `?rangedSpeechGate=off` (or `&…`).
/// DEFAULT-ON off-escape shape (`off`/`0`/`false`); `=off` shows every
/// HearRangedSpeech line ACE sends again (the squelch check still runs).
pub(crate) fn ranged_speech_gate_enabled(search: &str) -> bool {
    let trimmed = search.strip_prefix('?').unwrap_or(search);
    !trimmed.split('&').any(|kv| {
        matches!(
            kv,
            "rangedSpeechGate=off" | "rangedSpeechGate=0" | "rangedSpeechGate=false"
        )
    })
}

/// combat-magic-3 (2026-10-13): retail `AppraisalSystem::DamageTypeToString`
/// (acclient.c:479074) names, in its bit order. Health / Stamina / Mana
/// (0x80 / 0x100 / 0x200) have no name.
const RETAIL_DAMAGE_TYPE_NAMES: [(u32, &str); 9] = [
    (0x1, "Slashing"),
    (0x2, "Piercing"),
    (0x4, "Bludgeoning"),
    (0x8, "Cold"),
    (0x10, "Fire"),
    (0x20, "Acid"),
    (0x40, "Electrical"),
    (0x400, "Nether"),
    (0x1000_0000, "Prismatic"),
];

/// AttackConditions bits the hit lines print (protocol
/// `combat::types::AttackConditions`; ACE's Overpower 0x8 prints nothing).
const ATTACK_CONDITION_CRITICAL_PROTECTION: u64 = 0x1;
const ATTACK_CONDITION_RECKLESSNESS: u64 = 0x2;
const ATTACK_CONDITION_SNEAK_ATTACK: u64 = 0x4;

/// combat-magic-3: the `<type> ` word of a hit line. Retail's
/// HandleAttacker/DefenderNotificationEvent run `DamageTypeToString` (names
/// '/'-joined), `__strlwr` it and append `' '` only when it is non-empty, so
/// a mask with no named bit reads "... points of damage!".
pub(crate) fn retail_damage_type_word(damage_type: u32) -> String {
    let mut word = String::new();
    for &(bit, name) in RETAIL_DAMAGE_TYPE_NAMES.iter() {
        if damage_type & bit != 0 {
            if !word.is_empty() {
                word.push('/');
            }
            word.push_str(name);
        }
    }
    if !word.is_empty() {
        word.make_ascii_lowercase();
        word.push(' ');
    }
    word
}

/// combat-magic-3: retail `CombatSystem::InqCombatHitAdjectives`
/// (acclient.c:500139) — the `(singular, plural)` hit verb. An EXACT-value
/// switch on the damage type (a multi-bit mask, Stamina, Mana or the 0x10000000
/// bit falls to "hit"/"hits"); `severity` (damage / MaxHealth) picks the tier
/// at `> 0.1` / `> 0.25` / `> 0.5`. (Retail sets no verb for a negative
/// severity; ACE never sends one, so that case keeps the lowest tier.)
pub(crate) fn combat_hit_adjectives(damage_type: u32, severity: f64) -> (&'static str, &'static str) {
    let tiers: [(&'static str, &'static str); 4] = match damage_type {
        0x1 => [("scratch", "scratches"), ("cut", "cuts"), ("slash", "slashes"), ("mangle", "mangles")],
        0x2 => [("nick", "nicks"), ("stab", "stabs"), ("impale", "impales"), ("gore", "gores")],
        0x4 => [("graze", "grazes"), ("bash", "bashes"), ("smash", "smashes"), ("crush", "crushes")],
        0x8 => [("numb", "numbs"), ("chill", "chills"), ("frost", "frosts"), ("freeze", "freezes")],
        0x10 => [("singe", "singes"), ("scorch", "scorches"), ("burn", "burns"), ("incinerate", "incinerates")],
        0x20 => [("blister", "blisters"), ("sear", "sears"), ("corrode", "corrodes"), ("dissolve", "dissolves")],
        0x40 => [("spark", "sparks"), ("shock", "shocks"), ("jolt", "jolts"), ("blast", "blasts")],
        0x80 => [("drain", "drains"), ("exhaust", "exhausts"), ("siphon", "siphons"), ("deplete", "depletes")],
        0x400 => [("scar", "scars"), ("twist", "twists"), ("wither", "withers"), ("eradicate", "eradicates")],
        _ => return ("hit", "hits"),
    };
    let tier = if severity > 0.5 {
        3
    } else if severity > 0.25 {
        2
    } else if severity > 0.1 {
        1
    } else {
        0
    };
    tiers[tier]
}

/// combat-magic-3: the attacker-line prefix — "Critical hit!  " (two
/// spaces), then "Sneak Attack! " (bit 0x4), then "Recklessness! " (bit 0x2)
/// (acclient.c HandleAttackerNotificationEvent :408411-408417).
pub(crate) fn attacker_hit_prefix(critical: bool, attack_conditions: u64) -> String {
    let mut s = String::new();
    if critical {
        s.push_str("Critical hit!  ");
    }
    if attack_conditions & ATTACK_CONDITION_SNEAK_ATTACK != 0 {
        s.push_str("Sneak Attack! ");
    }
    if attack_conditions & ATTACK_CONDITION_RECKLESSNESS != 0 {
        s.push_str("Recklessness! ");
    }
    s
}

/// combat-magic-3: the defender-line prefix — "Critical hit! " (ONE space),
/// "Sneak Attack! ", "Reckless! " (acclient.c HandleDefenderNotificationEvent
/// :409442).
pub(crate) fn defender_hit_prefix(critical: bool, attack_conditions: u64) -> String {
    let mut s = String::new();
    if critical {
        s.push_str("Critical hit! ");
    }
    if attack_conditions & ATTACK_CONDITION_SNEAK_ATTACK != 0 {
        s.push_str("Sneak Attack! ");
    }
    if attack_conditions & ATTACK_CONDITION_RECKLESSNESS != 0 {
        s.push_str("Reckless! ");
    }
    s
}

/// combat-magic-3: retail `ClientCombatSystem::HandleAttackerNotificationEvent`
/// (acclient.c:408294) — `"You %s %s for %d point%s of %sdamage!"` after the
/// prefix, then (bit 0x1) the target's Critical Protection suffix. Retail
/// appends "\n"; the chat log adds its own line break.
pub(crate) fn format_attacker_hit_line(
    defender_name: &str,
    damage_type: u32,
    severity: f64,
    damage: u32,
    critical: bool,
    attack_conditions: u64,
) -> String {
    let (verb, _) = combat_hit_adjectives(damage_type, severity);
    let mut line = attacker_hit_prefix(critical, attack_conditions);
    line.push_str(&format!(
        "You {verb} {defender_name} for {damage} point{s} of {ty}damage!",
        s = if damage == 1 { "" } else { "s" },
        ty = retail_damage_type_word(damage_type),
    ));
    if attack_conditions & ATTACK_CONDITION_CRITICAL_PROTECTION != 0 {
        line.push_str(
            " Your target's Critical Protection augmentation allows them to avoid your critical hit!",
        );
    }
    line
}

/// combat-magic-3: retail `ClientCombatSystem::HandleDefenderNotificationEvent`
/// (acclient.c:409442) — prefix, attacker, `' '`, plural verb, `" your "`,
/// body part, `" for "`, N, `" point"`, s, `" of "`, type word, `"damage!"`,
/// then (bit 0x1) your Critical Protection suffix. `body_part` is
/// the lower-cased `BodyPartToString` name; an empty one reads `" you"` in
/// place of `" your <part>"` (retail's `LowerCaseRemoveUnderscores` failed).
pub(crate) fn format_defender_hit_line(
    attacker_name: &str,
    damage_type: u32,
    severity: f64,
    damage: u32,
    body_part: &str,
    critical: bool,
    attack_conditions: u64,
) -> String {
    let (_, verbs) = combat_hit_adjectives(damage_type, severity);
    let mut line = defender_hit_prefix(critical, attack_conditions);
    let target = if body_part.is_empty() {
        "you".to_string()
    } else {
        format!("your {body_part}")
    };
    line.push_str(&format!(
        "{attacker_name} {verbs} {target} for {damage} point{s} of {ty}damage!",
        s = if damage == 1 { "" } else { "s" },
        ty = retail_damage_type_word(damage_type),
    ));
    if attack_conditions & ATTACK_CONDITION_CRITICAL_PROTECTION != 0 {
        line.push_str(" Your Critical Protection augmentation allows you to avoid a critical hit!");
    }
    line
}

/// combat-magic-3: retail `HandleEvasionAttackerNotificationEvent`
/// (acclient.c:409355) — defender + `" evaded your attack."`.
pub(crate) fn format_evasion_attacker_line(defender_name: &str) -> String {
    format!("{defender_name} evaded your attack.")
}

/// combat-magic-3: retail `HandleEvasionDefenderNotificationEvent`
/// (acclient.c:409275) — `"You evaded "` + attacker + `"!"`.
pub(crate) fn format_evasion_defender_line(attacker_name: &str) -> String {
    format!("You evaded {attacker_name}!")
}

#[cfg(test)]
mod combat_hit_tests {
    use super::*;

    const SLASH: u32 = 0x1;
    const PIERCE: u32 = 0x2;
    const BLUDGEON: u32 = 0x4;
    const FIRE: u32 = 0x10;
    const ELECTRIC: u32 = 0x40;
    const HEALTH: u32 = 0x80;
    const STAMINA: u32 = 0x100;
    const NETHER: u32 = 0x400;
    const PRISMATIC: u32 = 0x1000_0000;

    #[test]
    fn attacker_crit_sneak_pierce_line() {
        assert_eq!(
            format_attacker_hit_line("Drudge", PIERCE, 0.3, 37, true, ATTACK_CONDITION_SNEAK_ATTACK),
            "Critical hit!  Sneak Attack! You impale Drudge for 37 points of piercing damage!"
        );
    }

    #[test]
    fn one_damage_reads_point() {
        assert_eq!(
            format_attacker_hit_line("Drudge", SLASH, 0.01, 1, false, 0),
            "You scratch Drudge for 1 point of slashing damage!"
        );
        assert_eq!(
            format_defender_hit_line("Drudge", SLASH, 0.01, 1, "hand", false, 0),
            "Drudge scratches your hand for 1 point of slashing damage!"
        );
        // Zero is plural, as retail's `hp != 1` test.
        assert_eq!(
            format_attacker_hit_line("Drudge", SLASH, 0.0, 0, false, 0),
            "You scratch Drudge for 0 points of slashing damage!"
        );
    }

    #[test]
    fn nether_has_its_own_verbs() {
        assert_eq!(combat_hit_adjectives(NETHER, 0.05), ("scar", "scars"));
        assert_eq!(combat_hit_adjectives(NETHER, 0.2), ("twist", "twists"));
        assert_eq!(combat_hit_adjectives(NETHER, 0.4), ("wither", "withers"));
        assert_eq!(combat_hit_adjectives(NETHER, 0.6), ("eradicate", "eradicates"));
        assert_eq!(
            format_attacker_hit_line("Shadow", NETHER, 0.6, 120, false, 0),
            "You eradicate Shadow for 120 points of nether damage!"
        );
    }

    #[test]
    fn verb_is_an_exact_value_switch() {
        // A multi-bit mask, the Prismatic bit (alone or OR-ed in), Stamina and
        // Mana all fall to "hit" / "hits".
        assert_eq!(combat_hit_adjectives(SLASH | PIERCE, 0.6), ("hit", "hits"));
        assert_eq!(combat_hit_adjectives(SLASH | PRISMATIC, 0.6), ("hit", "hits"));
        assert_eq!(combat_hit_adjectives(PRISMATIC, 0.6), ("hit", "hits"));
        assert_eq!(combat_hit_adjectives(STAMINA, 0.6), ("hit", "hits"));
        assert_eq!(combat_hit_adjectives(0x200, 0.6), ("hit", "hits"));
        assert_eq!(combat_hit_adjectives(0, 0.6), ("hit", "hits"));
        assert_eq!(
            format_attacker_hit_line("Drudge", SLASH | PIERCE, 0.6, 50, false, 0),
            "You hit Drudge for 50 points of slashing/piercing damage!"
        );
        assert_eq!(
            format_defender_hit_line("Drudge", SLASH | PIERCE, 0.6, 50, "foot", false, 0),
            "Drudge hits your foot for 50 points of slashing/piercing damage!"
        );
    }

    #[test]
    fn severity_tiers_split_strictly_above_the_bounds() {
        assert_eq!(combat_hit_adjectives(BLUDGEON, 0.1), ("graze", "grazes"));
        assert_eq!(combat_hit_adjectives(BLUDGEON, 0.11), ("bash", "bashes"));
        assert_eq!(combat_hit_adjectives(BLUDGEON, 0.25), ("bash", "bashes"));
        assert_eq!(combat_hit_adjectives(BLUDGEON, 0.26), ("smash", "smashes"));
        assert_eq!(combat_hit_adjectives(BLUDGEON, 0.5), ("smash", "smashes"));
        assert_eq!(combat_hit_adjectives(BLUDGEON, 0.51), ("crush", "crushes"));
        assert_eq!(combat_hit_adjectives(FIRE, 0.9), ("incinerate", "incinerates"));
        assert_eq!(combat_hit_adjectives(ELECTRIC, 0.0), ("spark", "sparks"));
        assert_eq!(combat_hit_adjectives(HEALTH, 0.3), ("siphon", "siphons"));
    }

    #[test]
    fn unnamed_types_read_of_damage() {
        assert_eq!(retail_damage_type_word(HEALTH), "");
        assert_eq!(retail_damage_type_word(STAMINA | 0x200), "");
        assert_eq!(retail_damage_type_word(0), "");
        assert_eq!(
            format_attacker_hit_line("Drudge", HEALTH, 0.3, 12, false, 0),
            "You siphon Drudge for 12 points of damage!"
        );
        assert_eq!(
            format_defender_hit_line("Drudge", HEALTH, 0.3, 12, "chest", false, 0),
            "Drudge siphons your chest for 12 points of damage!"
        );
    }

    #[test]
    fn damage_type_word_uses_the_appraisal_names() {
        assert_eq!(retail_damage_type_word(ELECTRIC), "electrical ");
        assert_eq!(retail_damage_type_word(PRISMATIC), "prismatic ");
        assert_eq!(retail_damage_type_word(NETHER), "nether ");
        // Bit order, '/'-joined, unnamed bits skipped.
        assert_eq!(
            retail_damage_type_word(PRISMATIC | HEALTH | FIRE | SLASH),
            "slashing/fire/prismatic "
        );
    }

    #[test]
    fn defender_bludgeon_chest_line() {
        assert_eq!(
            format_defender_hit_line("Banderling", BLUDGEON, 0.2, 18, "chest", false, 0),
            "Banderling bashes your chest for 18 points of bludgeoning damage!"
        );
        assert_eq!(
            format_defender_hit_line("Banderling", BLUDGEON, 0.2, 18, "upper arm", false, 0),
            "Banderling bashes your upper arm for 18 points of bludgeoning damage!"
        );
        // No body-part name: " you" in place of " your <part>".
        assert_eq!(
            format_defender_hit_line("Banderling", BLUDGEON, 0.2, 18, "", false, 0),
            "Banderling bashes you for 18 points of bludgeoning damage!"
        );
    }

    #[test]
    fn prefixes_differ_per_side() {
        let all = ATTACK_CONDITION_SNEAK_ATTACK | ATTACK_CONDITION_RECKLESSNESS;
        assert_eq!(attacker_hit_prefix(true, all), "Critical hit!  Sneak Attack! Recklessness! ");
        assert_eq!(defender_hit_prefix(true, all), "Critical hit! Sneak Attack! Reckless! ");
        assert_eq!(attacker_hit_prefix(false, 0), "");
        assert_eq!(defender_hit_prefix(false, 0), "");
        // Overpower (0x8) prints nothing.
        assert_eq!(attacker_hit_prefix(false, 0x8), "");
        assert_eq!(defender_hit_prefix(false, 0x8), "");
        assert_eq!(
            format_defender_hit_line(
                "Banderling",
                BLUDGEON,
                0.6,
                40,
                "head",
                false,
                ATTACK_CONDITION_RECKLESSNESS
            ),
            "Reckless! Banderling crushes your head for 40 points of bludgeoning damage!"
        );
        assert_eq!(
            format_attacker_hit_line("Drudge", SLASH, 0.6, 40, false, ATTACK_CONDITION_RECKLESSNESS),
            "Recklessness! You mangle Drudge for 40 points of slashing damage!"
        );
    }

    #[test]
    fn critical_protection_suffixes() {
        assert_eq!(
            format_attacker_hit_line(
                "Drudge",
                SLASH,
                0.3,
                25,
                false,
                ATTACK_CONDITION_CRITICAL_PROTECTION
            ),
            "You slash Drudge for 25 points of slashing damage! Your target's Critical \
             Protection augmentation allows them to avoid your critical hit!"
        );
        assert_eq!(
            format_defender_hit_line(
                "Drudge",
                SLASH,
                0.3,
                25,
                "abdomen",
                false,
                ATTACK_CONDITION_CRITICAL_PROTECTION
            ),
            "Drudge slashes your abdomen for 25 points of slashing damage! Your Critical \
             Protection augmentation allows you to avoid a critical hit!"
        );
        // No bit 0x1, no suffix.
        assert!(!format_attacker_hit_line("Drudge", SLASH, 0.3, 25, true, 0x6).contains("Protection"));
        assert!(!format_defender_hit_line("Drudge", SLASH, 0.3, 25, "abdomen", true, 0x6)
            .contains("Protection"));
    }

    #[test]
    fn evasion_lines() {
        assert_eq!(format_evasion_defender_line("Drudge Skulker"), "You evaded Drudge Skulker!");
        assert_eq!(format_evasion_attacker_line("Drudge Skulker"), "Drudge Skulker evaded your attack.");
    }
}

/// vendor-buy-2 (2026-10-08 round 5): the transient line for an
/// InventoryServerSaveFailed (0x00A0). Retail's dispatch blames the
/// outstanding request's object and `ACCWeenieObject::ServerSaysAttemptFailed`
/// (acclient.c:439317) builds the text from that request; a purchase or sale
/// (IR_SHOP_EVENT) has no case and code 0 no suffix, so a refused shop event
/// prints nothing. ACE sends exactly that refusal as the event naming the
/// player (Player_Commerce.cs, `InventoryServerSaveFailed(Session, Guid.Full)`),
/// so a player guid gives `None`.
///
/// messages-objects-1 (2026-10-13): this is now only the
/// `?retailAttemptFailed=off` escape path. By default the 0xA0 arm prints
/// retail's pending-request line from `inventory_request::attempt_failed_lines`
/// (src/inventory_request.rs), and kind=48 carries that line instead of the
/// Debug label.
pub(crate) fn inventory_save_failed_chat_line(
    item_guid: u32,
    player_guid: u32,
    code: u32,
    label: &str,
) -> Option<String> {
    if item_guid != 0 && item_guid == player_guid {
        return None;
    }
    Some(if code == 0 {
        "You can't wield that!".to_string()
    } else {
        format!("[Wield failed] {label}")
    })
}

/// The JS chat categories a failure line is pushed at: the numbers of
/// lib.rs's wasm-only `CHAT_CATEGORY_SYSTEM` / `CHAT_CATEGORY_MAGIC` /
/// `CHAT_CATEGORY_TRANSIENT` (`session/messages/game_event.rs` asserts they
/// agree at compile time).
pub(crate) const FAILURE_CATEGORY_SYSTEM: u32 = 0;
pub(crate) const FAILURE_CATEGORY_MAGIC: u32 = 7;
pub(crate) const FAILURE_CATEGORY_TRANSIENT: u32 = 9;

/// pk-3 (2026-10-08 round 5): the chat category for a WeenieError line —
/// Magic for the codes retail's HandleFailureEvent prints at text type 7
/// (`holtburger_core::errors::retail_text_type`), System otherwise.
/// (Moved here from `session/messages/game_event.rs` by chat-errors-1.)
/// chat-errors-2 (2026-10-13): with `retail_text` (`?retailFailureText`,
/// default on) the generated retail table decides first — text type 0x1A
/// (the spew box) → Transient, 0 → System. Type 7 keeps the pk-3 rule
/// (rynth's AI chat ring drops category 7, so no line moves INTO Magic).
pub(crate) fn failure_chat_category(error: WeenieError, retail_text: bool) -> u32 {
    if retail_text {
        match holtburger_core::errors::retail_failure_text_type(error) {
            Some(0x1A) => return FAILURE_CATEGORY_TRANSIENT,
            Some(0) => return FAILURE_CATEGORY_SYSTEM,
            _ => {}
        }
    }
    if holtburger_core::errors::retail_text_type(error) == Some(7) {
        FAILURE_CATEGORY_MAGIC
    } else {
        FAILURE_CATEGORY_SYSTEM
    }
}

/// chat-errors-2 (2026-10-13): parse `?retailFailureText=off` (or `&…`).
/// DEFAULT-ON off-escape shape (`off`/`0`/`false`); `=off` brings back the
/// pre-table templates / sentence-case lines and their System category.
pub(crate) fn retail_failure_text_enabled(search: &str) -> bool {
    let trimmed = search.strip_prefix('?').unwrap_or(search);
    !trimmed.split('&').any(|kv| {
        matches!(
            kv,
            "retailFailureText=off" | "retailFailureText=0" | "retailFailureText=false"
        )
    })
}

/// chat-errors-1 (2026-10-13): parse `?retailSilentFailures=off` (or `&…`).
/// DEFAULT-ON off-escape shape (`off`/`0`/`false`); `=off` brings back the
/// sentence-case line for the codes `weenie_error_chat_line` silences.
pub(crate) fn retail_silent_failures_enabled(search: &str) -> bool {
    let trimmed = search.strip_prefix('?').unwrap_or(search);
    !trimmed.split('&').any(|kv| {
        matches!(
            kv,
            "retailSilentFailures=off" | "retailSilentFailures=0" | "retailSilentFailures=false"
        )
    })
}

/// chat-errors-1 (2026-10-13): the `(text, category)` chat line for a
/// WeenieError / WeenieErrorWithString (0x028A / 0x028B) outside the
/// spell-cast subset, and for a refused UseDone with no retail transient
/// text. Retail `Handle_Communication__WeenieError` (acclient.c:420742) and
/// `…WithString` (:422430) hand every code to
/// `ClientCommunicationSystem::HandleFailureEvent` (:413716), whose default
/// prints nothing — so the codes ACE sends routinely that have no case
/// (`holtburger_core::errors::is_silent_failure`: ITeleported after every
/// portal, TurbineChatIsEnabled at every login) give `None` while
/// `retail_silent` holds (`?retailSilentFailures`, default on). Every other
/// code keeps its template / sentence-case text (round-2 use-3 keeps the
/// non-retail ACE codes readable).
/// chat-errors-2 (2026-10-13): `retail_text` (`?retailFailureText`, default
/// on) prints every code HandleFailureEvent has a case for with retail's own
/// text and category (`holtburger_core::errors::retail_failure_line`,
/// `failure_chat_category`); `false` restores the pre-table lines.
pub(crate) fn weenie_error_chat_line_with(
    error: WeenieError,
    parameter: Option<&str>,
    retail_silent: bool,
    retail_text: bool,
) -> Option<(String, u32)> {
    if retail_silent && holtburger_core::errors::is_silent_failure(error) {
        return None;
    }
    Some((
        holtburger_core::errors::format_weenie_error_with(error, parameter, retail_text),
        failure_chat_category(error, retail_text),
    ))
}

/// chat-errors-1's three-argument form (retail table on), kept for its tests.
#[cfg(test)]
pub(crate) fn weenie_error_chat_line(
    error: WeenieError,
    parameter: Option<&str>,
    retail_silent: bool,
) -> Option<(String, u32)> {
    weenie_error_chat_line_with(error, parameter, retail_silent, true)
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
    fn a_refused_shop_event_adds_no_line() {
        const ME: u32 = 0x5000_0001;
        assert_eq!(inventory_save_failed_chat_line(ME, ME, 0, "None"), None);
        assert_eq!(
            inventory_save_failed_chat_line(0x8000_0001, ME, 0, "None").as_deref(),
            Some("You can't wield that!")
        );
        assert_eq!(
            inventory_save_failed_chat_line(0x8000_0001, ME, 0x1D, "YoureTooBusy").as_deref(),
            Some("[Wield failed] YoureTooBusy")
        );
        assert_eq!(
            inventory_save_failed_chat_line(0, 0, 0, "None").as_deref(),
            Some("You can't wield that!"),
            "no player yet: keep the old line"
        );
    }

    #[test]
    fn textbox_global_squelch() {
        assert!(!textbox_visible(6, 1 << 6));
        assert!(textbox_visible(5, 1 << 6));
        // System (5) is not a legal squelch channel.
        assert!(textbox_visible(5, 0xFFFF_FFFF));
        assert!(textbox_visible(6, 0));
    }

    fn pos(landblock: u32, x: f32, y: f32, z: f32) -> WorldPosition {
        WorldPosition {
            landblock_id: holtburger_common::Guid(landblock),
            coords: holtburger_common::Vector3::new(x, y, z),
            rotation: holtburger_common::Quaternion::identity(),
        }
    }

    #[test]
    fn ranged_speech_unknown_object_drops_the_line() {
        // chat-errors-3: retail ObjectsInRange returns 0 when either object
        // is missing from the object table.
        let me = pos(0xA9B4_0019, 84.0, 7.0, 94.0);
        assert!(!ranged_speech_in_range(Some(&me), None, false, 20.0));
        assert!(!ranged_speech_in_range(None, Some(&me), false, 20.0));
        assert!(!ranged_speech_in_range(None, None, false, 1000.0));
    }

    #[test]
    fn ranged_speech_own_line_always_passes() {
        assert!(ranged_speech_in_range(None, None, true, 0.0));
        let me = pos(0xA9B4_0019, 84.0, 7.0, 94.0);
        assert!(ranged_speech_in_range(Some(&me), Some(&me), true, 1.0));
    }

    #[test]
    fn ranged_speech_range_is_inclusive_centre_distance() {
        let me = pos(0xA9B4_0019, 10.0, 10.0, 0.0);
        // 3-4-5: exactly 5 m apart.
        let npc = pos(0xA9B4_0019, 13.0, 14.0, 0.0);
        assert!(ranged_speech_in_range(Some(&me), Some(&npc), false, 5.0));
        // Distance = range + 0.01 → dropped.
        assert!(!ranged_speech_in_range(Some(&me), Some(&npc), false, 4.99));
        // Full 3D (not xy-only): 12 m straight up is out of a 10 m range.
        let above = pos(0xA9B4_0019, 10.0, 10.0, 12.0);
        assert!(!ranged_speech_in_range(Some(&me), Some(&above), false, 10.0));
        // ACE's 96 m broadcast vs a 20 m Extent: a sender 50 m off is out.
        let far = pos(0xA9B4_0019, 60.0, 10.0, 0.0);
        assert!(!ranged_speech_in_range(Some(&me), Some(&far), false, 20.0));
    }

    #[test]
    fn ranged_speech_measures_across_landblocks() {
        // Adjacent landblocks (X 0xA9 → 0xAA), 10 m apart globally; the
        // landblock-local coords alone would read 182 m.
        let me = pos(0xA9B4_003D, 187.0, 96.0, 50.0);
        let npc = pos(0xAAB4_0005, 5.0, 96.0, 50.0);
        assert!(ranged_speech_in_range(Some(&me), Some(&npc), false, 20.0));
        assert!(ranged_speech_in_range(Some(&npc), Some(&me), false, 10.0));
        assert!(!ranged_speech_in_range(Some(&me), Some(&npc), false, 9.99));
    }

    #[test]
    fn ranged_speech_gate_escape() {
        assert!(ranged_speech_gate_enabled(""));
        assert!(ranged_speech_gate_enabled("?diag=1"));
        assert!(ranged_speech_gate_enabled("?rangedSpeechGate=on"));
        assert!(!ranged_speech_gate_enabled("?rangedSpeechGate=off"));
        assert!(!ranged_speech_gate_enabled("?a=1&rangedSpeechGate=0"));
        assert!(!ranged_speech_gate_enabled("rangedSpeechGate=false"));
    }

    #[test]
    fn weenie_errors_retail_never_prints_add_no_line() {
        use WeenieError as E;
        // chat-errors-1: no HandleFailureEvent case → no line.
        assert_eq!(weenie_error_chat_line(E::ITeleported, None, true), None);
        assert_eq!(weenie_error_chat_line(E::TurbineChatIsEnabled, None, true), None);
        assert_eq!(weenie_error_chat_line(E::ILeftTheWorld, None, true), None);
        // 0x51B has its case ("You have entered the %s channel.").
        assert_eq!(
            weenie_error_chat_line(E::YouHaveEnteredTheChannel, Some("General"), true),
            Some((
                "You have entered the General channel.".to_string(),
                FAILURE_CATEGORY_SYSTEM
            ))
        );
        // pk-3: the type-7 refusals stay in the Magic category.
        assert_eq!(
            weenie_error_chat_line(E::PKLiteMayNotUsePortal, None, true),
            Some((
                "Lite Player Killers may not interact with that portal!".to_string(),
                FAILURE_CATEGORY_MAGIC
            ))
        );
        // Non-retail ACE codes keep the readable fallback (round-2 use-3).
        assert_eq!(
            weenie_error_chat_line(E::TradeNonCombatMode, None, true),
            Some(("Trade non combat mode.".to_string(), FAILURE_CATEGORY_SYSTEM))
        );
    }

    #[test]
    fn retail_silent_failures_escape() {
        use WeenieError as E;
        assert!(retail_silent_failures_enabled(""));
        assert!(retail_silent_failures_enabled("?diag=1"));
        assert!(retail_silent_failures_enabled("?retailSilentFailures=on"));
        assert!(!retail_silent_failures_enabled("?retailSilentFailures=off"));
        assert!(!retail_silent_failures_enabled("?a=1&retailSilentFailures=0"));
        assert!(!retail_silent_failures_enabled("retailSilentFailures=false"));
        // `=off` restores the old lines.
        assert_eq!(
            weenie_error_chat_line(E::ITeleported, None, false),
            Some(("I teleported.".to_string(), FAILURE_CATEGORY_SYSTEM))
        );
        assert_eq!(
            weenie_error_chat_line(E::TurbineChatIsEnabled, None, false),
            Some(("Turbine chat is enabled.".to_string(), FAILURE_CATEGORY_SYSTEM))
        );
    }

    #[test]
    fn retail_failure_lines_take_retail_text_and_category() {
        use WeenieError as E;
        // chat-errors-2: spew-box (0x1A) codes are Transient lines …
        assert_eq!(
            weenie_error_chat_line_with(E::YouAreNotInAllegiance, None, true, true),
            Some(("You are not in an allegiance!".to_string(), FAILURE_CATEGORY_TRANSIENT))
        );
        assert_eq!(
            weenie_error_chat_line_with(E::YoureTooBusy, None, true, true),
            Some(("You're too busy!".to_string(), FAILURE_CATEGORY_TRANSIENT))
        );
        // … type-0 codes stay System …
        assert_eq!(
            weenie_error_chat_line_with(E::YouDoNotHaveAuthorityInAllegiance, None, true, true),
            Some((
                "You do not have the authority within your allegiance to do that.".to_string(),
                FAILURE_CATEGORY_SYSTEM
            ))
        );
        // … and type 7 keeps today's category: pk-3's Magic set stays Magic,
        // every other type-7 line stays System (no line moves into Magic).
        assert_eq!(
            weenie_error_chat_line_with(E::PKLiteMayNotUsePortal, None, true, true)
                .map(|(_, c)| c),
            Some(FAILURE_CATEGORY_MAGIC)
        );
        assert_eq!(
            weenie_error_chat_line_with(E::YouMustLinkToPortalToRecall, None, true, true),
            Some((
                "You must have linked with a portal in order to recall to it!".to_string(),
                FAILURE_CATEGORY_SYSTEM
            ))
        );
        assert_eq!(failure_chat_category(E::YourSpellFizzled, true), FAILURE_CATEGORY_SYSTEM);
        // The silence rule still runs first.
        assert_eq!(weenie_error_chat_line_with(E::ITeleported, None, true, true), None);
        // Parameterised lines substitute every slot.
        assert_eq!(
            weenie_error_chat_line_with(E::IsAtFullHealth, Some("Bob"), true, true),
            Some(("Bob is already at full health!".to_string(), FAILURE_CATEGORY_TRANSIENT))
        );
    }

    #[test]
    fn retail_failure_text_escape() {
        use WeenieError as E;
        assert!(retail_failure_text_enabled(""));
        assert!(retail_failure_text_enabled("?diag=1"));
        assert!(retail_failure_text_enabled("?retailFailureText=on"));
        assert!(!retail_failure_text_enabled("?retailFailureText=off"));
        assert!(!retail_failure_text_enabled("?a=1&retailFailureText=0"));
        assert!(!retail_failure_text_enabled("retailFailureText=false"));
        // `=off`: the old sentence and the old System category.
        assert_eq!(
            weenie_error_chat_line_with(E::YouAreNotInAllegiance, None, true, false),
            Some(("You are not in allegiance.".to_string(), FAILURE_CATEGORY_SYSTEM))
        );
        assert_eq!(
            weenie_error_chat_line_with(E::YoureTooBusy, None, true, false),
            Some(("You're too busy!".to_string(), FAILURE_CATEGORY_SYSTEM))
        );
        assert_eq!(
            failure_chat_category(E::PKLiteMayNotUsePortal, false),
            FAILURE_CATEGORY_MAGIC
        );
    }
}

/// chat-errors-5 (2026-10-13): the InventoryServerSaveFailed (0x00A0) chat
/// output never carries the WeenieError Debug label ("[Wield failed]
/// AttunedItem"). The default path is messages-objects-1's
/// `inventory_request::attempt_failed_lines` — retail's
/// `ServerSaysAttemptFailed` line (acclient.c:439317) and the dispatch's
/// `HandleFailureEvent` passthrough (:394949-394965); these pin the cases
/// this finding names. `inventory_save_failed_chat_line` above is only the
/// `?retailAttemptFailed=off` escape.
#[cfg(test)]
mod inventory_save_failed_tests {
    use crate::inventory_request::{
        InventoryRequest, InventoryRequestTracker, LINE_CATEGORY_TRANSIENT, ObjectNames,
        attempt_failed_lines,
    };
    use holtburger_protocol::errors::WeenieError;

    fn sword() -> ObjectNames {
        ObjectNames {
            name: "Pyreal Sword".to_string(),
            plural_name: "Pyreal Swords".to_string(),
            stack_size: 1,
        }
    }

    #[test]
    fn an_attuned_drop_prints_only_the_retail_line() {
        // HandleFailureEvent has no case for 0x426 AttunedItem or 0x453
        // TradeItemBeingTraded: the ServerSaysAttemptFailed line is all.
        let (line, lines) = attempt_failed_lines(
            Some(InventoryRequest::Drop),
            WeenieError::AttunedItem,
            Some(&sword()),
        );
        assert_eq!(line, "The Pyreal Sword can't be dropped");
        assert_eq!(lines, vec![(line.clone(), LINE_CATEGORY_TRANSIENT)]);
        let (line, lines) = attempt_failed_lines(
            Some(InventoryRequest::PutInContainer),
            WeenieError::TradeItemBeingTraded,
            Some(&sword()),
        );
        assert_eq!(line, "The Pyreal Sword can't be put in the container");
        assert_eq!(lines, vec![(line.clone(), LINE_CATEGORY_TRANSIENT)]);
    }

    #[test]
    fn a_busy_merge_names_the_plural_and_ends_with_the_suffix() {
        let (line, lines) = attempt_failed_lines(
            Some(InventoryRequest::Merge),
            WeenieError::YoureTooBusy,
            Some(&sword()),
        );
        assert_eq!(line, "The Pyreal Swords can't be merged - you're too busy");
        assert!(line.ends_with(" - you're too busy"));
        // …then the code's own HandleFailureEvent text (0x1A).
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1], ("You're too busy!".to_string(), LINE_CATEGORY_TRANSIENT));
    }

    #[test]
    fn no_request_and_an_attuned_code_prints_nothing() {
        let mut tracker = InventoryRequestTracker::default();
        let (_, request) = tracker.attempt_failed(0x8000_0A01);
        assert_eq!(request, None);
        assert_eq!(
            attempt_failed_lines(request, WeenieError::AttunedItem, Some(&sword())),
            (String::new(), Vec::new())
        );
        assert_eq!(
            attempt_failed_lines(request, WeenieError::AttunedItem, None),
            (String::new(), Vec::new())
        );
    }

    #[test]
    fn name_templated_codes_skip_the_failure_event_passthrough() {
        // Retail has a HandleFailureEvent case for both (a `%s` name slot),
        // but the 0x00A0 dispatch (acclient.c:394960) never calls it for them.
        for error in [WeenieError::CannotCarryAnymore, WeenieError::TradeAiDoesntWant] {
            assert!(
                holtburger_core::errors::retail_failure_line(error as u32, None).is_some(),
                "{error:?} has a retail case"
            );
            let (line, lines) =
                attempt_failed_lines(Some(InventoryRequest::Give), error, Some(&sword()));
            assert_eq!(line, "The Pyreal Sword can't be given");
            assert_eq!(lines, vec![(line.clone(), LINE_CATEGORY_TRANSIENT)], "{error:?}");
        }
    }

    #[test]
    fn no_line_is_ever_the_debug_label() {
        use InventoryRequest as R;
        let requests = [
            None,
            Some(R::Merge),
            Some(R::Split),
            Some(R::Move),
            Some(R::PickUp),
            Some(R::PutInContainer),
            Some(R::Drop),
            Some(R::Wield),
            Some(R::Give),
            Some(R::ShopEvent),
        ];
        for code in 0..=0x0FFFu32 {
            let Some(error) = WeenieError::from_repr(code) else {
                continue;
            };
            let label = format!("{error:?}");
            for request in requests {
                for names in [Some(sword()), None] {
                    let (line, lines) = attempt_failed_lines(request, error, names.as_ref());
                    for text in std::iter::once(&line).chain(lines.iter().map(|(t, _)| t)) {
                        assert_ne!(text, &label, "{error:?} / {request:?}");
                        assert!(!text.contains("[Wield failed]"), "{error:?} / {request:?}");
                    }
                }
            }
        }
    }
}
