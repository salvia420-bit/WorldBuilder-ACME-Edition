//! `GameMessage` arms: Chat and broadcast text: server messages, speech,
//! emotes, death messages, TurbineChat.
//!
//! Moved verbatim from the inbound `match message` (2026-10-05 recv_loop
//! split); see `session::messages::dispatch_game_message` for the routing.

use crate::*;
use crate::session::{LoopCtx, LoopFlow};
use holtburger_protocol::messages::GameMessage;

pub(super) async fn handle(ctx: &mut LoopCtx, message: GameMessage) -> LoopFlow {
    let LoopCtx { queued_events, .. } = &mut *ctx;
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
            let category = chat_category_for_message_type(data.chat_type);
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                string_payload: Some(format!("[Server] {}", data.message)),
                u32_payload: Some(data.chat_type),
                u32_payload_2: Some(category),
                f32_payload: None,
            });
        }
        GameMessage::HearSpeech(data) => {
            // Local say within speech-radius. chat_type
            // is usually `Speech` but ACE also uses this
            // packet for spell-casting words (chat_type
            // = Spellcasting), so the category lookup
            // routes spell incantations to the magic
            // tab instead of local.
            let category = chat_category_for_message_type(data.chat_type);
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                string_payload: Some(format!(
                    "{} says, \"{}\"",
                    data.sender_name, data.message
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
        GameMessage::HearRangedSpeech(data) => {
            // Greater-range speech variant (e.g. heralds,
            // World Crier). Same chat_type taxonomy as
            // HearSpeech.
            let category = chat_category_for_message_type(data.chat_type);
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                string_payload: Some(format!(
                    "{} says, \"{}\"",
                    data.sender_name, data.message
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
        GameMessage::EmoteText(data) => {
            // EmoteText.text is already self-contained —
            // ACE pre-renders it as e.g. "Alice waves at
            // you." — so don't re-prepend the sender
            // name. Mirror the cli's display path.
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                string_payload: Some(data.text.clone()),
                u32_payload: Some(0),
                u32_payload_2: Some(CHAT_CATEGORY_EMOTE),
                f32_payload: None,
            });
            // F17-5 (2026-06-09): overhead bubble companion. The
            // pre-rendered emote text floats over the actor (its
            // `sender` guid). Additive — inert unless
            // `?speechBubbles=on`.
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_OVERHEAD_SPEECH,
                string_payload: Some(data.text.clone()),
                u32_payload: Some(data.sender),
                u32_payload_2: Some(CHAT_CATEGORY_EMOTE),
                f32_payload: None,
            });
        }
        GameMessage::SoulEmote(data) => {
            // SoulEmote.text is identical in shape to
            // EmoteText.text — pre-rendered. Same
            // formatting rule.
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                string_payload: Some(data.text.clone()),
                u32_payload: Some(0),
                u32_payload_2: Some(CHAT_CATEGORY_EMOTE),
                f32_payload: None,
            });
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
        GameMessage::PlayerKilled(data) => {
            // Death broadcast — the formatted message
            // already reads "Player has been slain by
            // Monster!" or "Player killed by Player."
            // (PK kill). victim_id / killer_id are
            // GUIDs the wasm bundle could colour by
            // friendliness in a future step; today we
            // just surface the line.
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                string_payload: Some(data.death_message.clone()),
                u32_payload: Some(u32::from(data.killer_id)),
                u32_payload_2: Some(CHAT_CATEGORY_DEATH),
                f32_payload: None,
            });
            // Q1a (2026-05-26): structured Death event.
            // Chorizite Character.OnDeath analogue —
            // JS-side filters by victim==local for the
            // "You died." overlay; lets plugins
            // subscribe without polling chat text.
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
