//! `GameMessage` arms: Everything else: echoed GameActions, PlaySound,
//! EnvironChange, and the catch-all arm for unhandled messages.
//!
//! Moved verbatim from the inbound `match message` (2026-10-05 recv_loop
//! split); see `session::messages::dispatch_game_message` for the routing.

use crate::*;
use crate::session::{LoopCtx, LoopFlow};
use holtburger_protocol::messages::{GameAction, GameMessage};

pub(super) async fn handle(ctx: &mut LoopCtx, message: GameMessage) -> LoopFlow {
    let LoopCtx { queued_events, .. } = &mut *ctx;
    match message {
        GameMessage::GameAction(action_msg) => {
            // Server can echo a GameAction::LoginComplete
            // back as confirmation — already InWorld at
            // that point, so just log for visibility.
            // Future steps (chat, equipment, etc.) will
            // dispatch on action_msg.action variants.
            if matches!(
                action_msg.action,
                GameAction::LoginComplete(_)
            ) {
                log::debug!(
                    "recv_loop: server-echoed LoginComplete"
                );
            }
        }
        GameMessage::PlaySound(data) => {
            // Task F (ambient-sounds-chain, 2026-05-12):
            // ACE broadcast `GameMessageSound` (opcode
            // 0xF750) — server-triggered audio for
            // lifestone bind, switch activation, hotspot
            // trigger, craft event, etc. Wire layout:
            // `[u32 guid, u32 sound_id, f32 volume]`
            // (16 bytes total incl. the 4-byte opcode).
            //
            // The parser is `PlaySoundData` in
            // `crates/holtburger-protocol/src/messages/
            // effects/types.rs` — pre-existing from the
            // protocol-crate buildout; the `target` /
            // `sound_id` / `volume` field names track
            // ACE's GameMessageSound constructor 1:1.
            //
            // Forward to JS as a kind=16 SoundTriggered
            // ClientEvent. JS-side (`index.html`'s
            // `drainEvents` block) looks up the entity
            // in `liveScene3d.entityManager.entityMap`,
            // reads `inst.soundTableDid` (Task E
            // plumbing), resolves the Sound enum via
            // `soundTableCache.resolveSound(...)`, and
            // plays the resulting Wave at the entity's
            // current world position via
            // `audioManager.play(...)` scaled by
            // `entry.volume * scale`.
            //
            // Soft cases handled JS-side (each logs
            // debug + skips, never errors):
            //   - entity GUID unknown (despawned mid-
            //     flight between ACE send and client
            //     recv)
            //   - entity has no SoundTable
            //     (`inst.soundTableDid == 0`)
            //   - Sound enum has no entry in the
            //     resolved SoundTable
            //   - `scale <= 0` (treated as 1.0 with a
            //     one-shot warn)
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_SOUND_TRIGGERED,
                string_payload: None,
                u32_payload: Some(u32::from(data.target)),
                u32_payload_2: Some(data.sound_id),
                f32_payload: Some(data.volume),
            });
        }
        GameMessage::EnvironChange(data) => {
            // AdminEnvirons (0xEA60) — server-pushed fog/sound
            // environment change. Forward the raw
            // EnvironChangeType to JS as a kind=60 ClientEvent;
            // the drainEvents handler applies the fog tint
            // override (0x00-0x06) or plays the environ sound
            // (0x65-0x7B). Retail: acclient.c:396298.
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_ENVIRON_CHANGE,
                string_payload: None,
                u32_payload: Some(data.change_type),
                u32_payload_2: None,
                f32_payload: None,
            });
        }
        _ => {
            // Other GameMessages are dropped silently —
            // VectorUpdate (step 2b extension — not
            // strictly needed for position rendering),
            // vitals / equipment / inventory panels
            // (step 4 follow-on for non-chat surfaces),
            // interactive entities (step 5) all live
            // downstream. The recv loop's job here is
            // to stay alive + deliver the InWorld
            // signal + relay position-bearing messages
            // + relay chat.
        }
    }
    LoopFlow::Continue
}
