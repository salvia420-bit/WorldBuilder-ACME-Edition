//! `GameMessage` arms: Chat and broadcast text: server messages, speech,
//! emotes, death messages, TurbineChat.
//!
//! Moved verbatim from the inbound `match message` (2026-10-05 recv_loop
//! split); see `session::messages::dispatch_game_message` for the routing.
//!
//! R-chat (round 2, 2026-10-08): the lines now use the retail wording
//! (`crate::chat_format`, acclient.c HearSpeech / HearEmote /
//! HearSoulEmote / TextboxString) and the retail client-side squelch
//! (`gmCCommunicationSystem::CanHear`) against the mirrored squelch DB;
//! a PlayerKilled broadcast about the local player is left to the
//! personal Victim/Killer notification (`crate::death_chat`).

use crate::*;
use crate::chat_format::{
    can_hear, format_emote_line, format_hear_speech, strip_name_markers, textbox_visible,
    TEXT_TYPE_EMOTE,
};
use crate::death_chat::player_killed_line_visible;
use crate::session::{LoopCtx, LoopFlow};
use holtburger_protocol::messages::GameMessage;

/// The local player's guid, `0` before the eager WorldState exists (a `0`
/// never matches a sender, so pre-world lines behave as "someone else").
fn local_player_guid(
    world: &std::rc::Rc<std::cell::RefCell<Option<holtburger_world::WorldState>>>,
) -> u32 {
    world
        .try_borrow()
        .ok()
        .and_then(|w| w.as_ref().map(|w| w.player.guid.0))
        .unwrap_or(0)
}

/// `(sender's squelch row (mask, is_account), global per-type mask)` from
/// the mirrored squelch DB (`SetSquelchDb`); `(None, 0)` before it arrives.
fn squelch_inputs(
    latest_squelch: &std::rc::Rc<std::cell::RefCell<Option<SquelchSnapshot>>>,
    sender: u32,
) -> (Option<(u32, bool)>, u32) {
    let Ok(cell) = latest_squelch.try_borrow() else {
        return (None, 0);
    };
    let Some(snap) = cell.as_ref() else {
        return (None, 0);
    };
    let entry = if sender == 0 {
        None
    } else {
        snap.characters
            .iter()
            .find(|e| e.target_guid == sender)
            .map(|e| (e.mask, e.is_account))
    };
    let globals_mask = snap.globals_mask;
    (entry, globals_mask)
}

pub(super) async fn handle(ctx: &mut LoopCtx, message: GameMessage) -> LoopFlow {
    let LoopCtx {
        queued_events,
        latest_squelch,
        world,
        ..
    } = &mut *ctx;
    match message {
        // Phase 4 step 4: chat-bearing surfaces. Each
        // variant gets normalised into a single display
        // line + a `CHAT_CATEGORY_*` ID so JS can
        // append to the chat panel without knowing
        // each AC packet's shape. Reference handlers
        // in the cli are scattered across
        // `crates/holtburger-core/src/client/messages.rs`
        // and `apps/holtburger-cli/src/pages/game/panels/
        // chat.rs`; we don't reuse them because the cli
        // formats for stdout (ratatui spans) and we
        // format for the DOM. Categories below mirror
        // the cli's `chat_message_tags()` mapping.
        GameMessage::ServerMessage(data) => {
            // System chat — ChatMessageType in the
            // payload routes the tab (Combat → combat,
            // Magic → magic, Advancement → advancement,
            // Recall / Craft / etc. likewise).
            // ChatMessageType::WorldBroadcast lands here
            // too (server-wide announcements).
            // R-chat (2026-10-08): retail
            // `Handle_Communication__TextboxString` (acclient.c:422872)
            // appends the text as-is (no "[Server] " prefix — that made
            // ACE's `You tell X, "…"` echo read "[Server] You tell X") and
            // only when its type is not globally squelched.
            let (_, globals_mask) = squelch_inputs(latest_squelch, 0);
            if textbox_visible(data.chat_type, globals_mask) {
                let category = chat_category_for_message_type(data.chat_type);
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                    string_payload: Some(data.message.clone()),
                    u32_payload: Some(data.chat_type),
                    u32_payload_2: Some(category),
                    f32_payload: None,
                });
            }
        }
        GameMessage::HearSpeech(data) => {
            // Local say within speech-radius. chat_type
            // is usually `Speech` but ACE also uses this
            // packet for spell-casting words (chat_type
            // = Spellcasting), so the category lookup
            // routes spell incantations to the magic
            // tab instead of local.
            // R-chat (2026-10-08): ACE echoes your own Talk back to you
            // (EnqueueBroadcast sends to self first); retail
            // HearSpeech (acclient.c:413338) prints it as
            // `You say, "…"` before any CanHear check, and drops a
            // squelched sender's line.
            let local = local_player_guid(world);
            let is_self = local != 0 && data.sender == local;
            let (entry, globals_mask) = squelch_inputs(latest_squelch, data.sender);
            if is_self || can_hear(data.sender, data.chat_type, entry, globals_mask) {
                let category = chat_category_for_message_type(data.chat_type);
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                    string_payload: Some(format_hear_speech(
                        is_self,
                        strip_name_markers(&data.sender_name),
                        &data.message,
                    )),
                    u32_payload: Some(data.chat_type),
                    u32_payload_2: Some(category),
                    f32_payload: None,
                });
                // F17-5 (2026-06-09): overhead bubble companion.
                // The chat line above goes to the DOM panel; this
                // surfaces the speaker guid + raw words so JS can
                // float a fading bubble over the 3D speaker.
                // Additive — inert unless `?speechBubbles=on`.
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_OVERHEAD_SPEECH,
                    string_payload: Some(data.message.clone()),
                    u32_payload: Some(data.sender),
                    u32_payload_2: Some(category),
                    f32_payload: None,
                });
            }
        }
        GameMessage::HearRangedSpeech(data) => {
            // Greater-range speech variant (e.g. heralds,
            // World Crier). Same chat_type taxonomy as
            // HearSpeech.
            // R-chat (2026-10-08): retail HandleRangedTalkEvent
            // (acclient.c:434662) has no own-speaker sentence and drops a
            // squelched sender (IsSquelched; its range gate is not ported).
            let (entry, globals_mask) = squelch_inputs(latest_squelch, data.sender);
            if can_hear(data.sender, data.chat_type, entry, globals_mask) {
                let category = chat_category_for_message_type(data.chat_type);
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                    string_payload: Some(format_hear_speech(
                        false,
                        strip_name_markers(&data.sender_name),
                        &data.message,
                    )),
                    u32_payload: Some(data.chat_type),
                    u32_payload_2: Some(category),
                    f32_payload: None,
                });
                // F17-5 (2026-06-09): overhead bubble companion (see
                // HearSpeech arm).
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_OVERHEAD_SPEECH,
                    string_payload: Some(data.message.clone()),
                    u32_payload: Some(data.sender),
                    u32_payload_2: Some(category),
                    f32_payload: None,
                });
            }
        }
        GameMessage::EmoteText(data) => {
            // R-chat chat-2 (2026-10-08): ACE sends the RAW `/me` text
            // with the name separately (Player.cs GameMessageEmoteText(
            // guid, GetNameWithSuffix(), message)); retail HearEmote
            // (acclient.c:422448) builds `Name text` (no space before an
            // apostrophe) after trimming the `^`/`&` suffix, and only if
            // CanHear(sender, Emote) — ACE never squelch-filters emotes.
            let (entry, globals_mask) = squelch_inputs(latest_squelch, data.sender);
            if can_hear(data.sender, TEXT_TYPE_EMOTE, entry, globals_mask) {
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                    string_payload: Some(format_emote_line(
                        strip_name_markers(&data.sender_name),
                        &data.text,
                    )),
                    u32_payload: Some(0),
                    u32_payload_2: Some(CHAT_CATEGORY_EMOTE),
                    f32_payload: None,
                });
                // F17-5 (2026-06-09): overhead bubble companion. The
                // raw emote text floats over the actor (its `sender`
                // guid). Additive — inert unless `?speechBubbles=on`.
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_OVERHEAD_SPEECH,
                    string_payload: Some(data.text.clone()),
                    u32_payload: Some(data.sender),
                    u32_payload_2: Some(CHAT_CATEGORY_EMOTE),
                    f32_payload: None,
                });
            }
        }
        GameMessage::SoulEmote(data) => {
            // R-chat chat-2 (2026-10-08): same shape as EmoteText (raw
            // text + separate name). Retail HearSoulEmote
            // (acclient.c:422716) DROPS the server echo of your own soul
            // emote — Pose already printed the local `You …` line — and
            // otherwise formats it through HearEmote.
            let local = local_player_guid(world);
            let own_echo = local != 0 && data.sender == local;
            let (entry, globals_mask) = squelch_inputs(latest_squelch, data.sender);
            if can_hear(data.sender, TEXT_TYPE_EMOTE, entry, globals_mask) {
                if !own_echo {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                        string_payload: Some(format_emote_line(
                            strip_name_markers(&data.sender_name),
                            &data.text,
                        )),
                        u32_payload: Some(0),
                        u32_payload_2: Some(CHAT_CATEGORY_EMOTE),
                        f32_payload: None,
                    });
                }
                // F17-5 (2026-06-09): overhead bubble companion (see
                // EmoteText arm).
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_OVERHEAD_SPEECH,
                    string_payload: Some(data.text.clone()),
                    u32_payload: Some(data.sender),
                    u32_payload_2: Some(CHAT_CATEGORY_EMOTE),
                    f32_payload: None,
                });
            }
        }
        GameMessage::PlayerKilled(data) => {
            // Death broadcast — the formatted message
            // already reads "Player has been slain by
            // Monster!" or "Player killed by Player."
            // (PK kill). victim_id / killer_id are
            // GUIDs the wasm bundle could colour by
            // friendliness in a future step; today we
            // just surface the line.
            // death-6 (2026-10-08): retail HandlePlayerDeathEvent
            // (acclient.c:409097) prints nothing when the local player is
            // the victim or the killer (they get the personal
            // Victim/KillerNotification line instead) or when the
            // message is empty.
            let local = local_player_guid(world);
            if player_killed_line_visible(
                u32::from(data.victim_id),
                u32::from(data.killer_id),
                local,
                &data.death_message,
            ) {
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                    string_payload: Some(data.death_message.clone()),
                    u32_payload: Some(u32::from(data.killer_id)),
                    u32_payload_2: Some(CHAT_CATEGORY_DEATH),
                    f32_payload: None,
                });
            }
            // Q1a (2026-05-26): structured Death event.
            // Chorizite Character.OnDeath analogue —
            // JS-side filters by victim==local for the
            // "You died." overlay; lets plugins
            // subscribe without polling chat text.
            // (Always pushed — only the chat line is gated.)
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_DEATH,
                string_payload: Some(data.death_message.clone()),
                u32_payload: Some(u32::from(data.victim_id)),
                u32_payload_2: Some(u32::from(data.killer_id)),
                f32_payload: None,
            });
        }
        GameMessage::TurbineChat(data) => {
            // Modern (post-Turbine) channel chat —
            // General / Trade / LFG / Roleplay /
            // Allegiance / Society / Olthoi. ACE wraps
            // the receive side in a SendToRoomByName
            // event blob; the request-side payload is
            // for outbound (which we don't speak yet).
            // Response blobs are RPC echoes — silent.
            // (Retail ChatRoomTracker::GetChatFormat prints the sender's
            // name even for your own line, so no "You say" rewrite here.)
            use holtburger_protocol::messages::chat::turbine::TurbineChatPayload;
            match &data.payload {
                TurbineChatPayload::EventSendToRoom {
                    sender_name,
                    message,
                    chat_type,
                    ..
                } => {
                    let chat_type_raw = chat_type.raw();
                    let label = turbine_chat_type_label(chat_type_raw);
                    let category =
                        chat_category_for_turbine_chat_type(chat_type_raw);
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                        string_payload: Some(format!(
                            "[{label}] {sender_name} says, \"{message}\""
                        )),
                        u32_payload: Some(chat_type_raw),
                        u32_payload_2: Some(category),
                        f32_payload: None,
                    });
                }
                TurbineChatPayload::RequestSendToRoomById { .. }
                | TurbineChatPayload::Response { .. }
                | TurbineChatPayload::Unknown(_) => {
                    // RPC echo / outbound — nothing to
                    // render.
                }
            }
        }
        _ => unreachable!("GameMessage routed to the wrong handler module"),
    }
    LoopFlow::Continue
}
