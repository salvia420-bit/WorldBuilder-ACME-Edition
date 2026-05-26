use crate::WorldEvent;
use crate::state::WorldState;
use holtburger_protocol::errors::WeenieError;
use holtburger_protocol::messages::{GameEvent, GameEventMessage, GameMessage};

pub(crate) fn handle_message(
    state: &mut WorldState,
    message: &GameMessage,
    events: &mut Vec<WorldEvent>,
) -> bool {
    match message {
        GameMessage::SetState(data) => state.apply_set_state_update(data, events),
        GameMessage::GameEvent(event) => handle_event(state, event, events),
        // CMT Wave 10 / Phase 31 (2026-05-26): ACE's `GameMessageScript`
        // (opcode `PlayEffect = 0xF755`) — server-authored visual scripts
        // (PlayScript::Launch, PlayScript::Explode, etc.). The wire
        // decoder + round-trip tests pre-date this phase (see
        // `crates/holtburger-protocol/src/messages/effects/types.rs`);
        // Wave 10's contribution is the world-side stub handler that
        // (a) proves the recv loop doesn't crash on PlayEffect, and
        // (b) emits a `WorldEvent::PlayEffect` for Wave 11's JS-side
        // VFX consumer to subscribe to. The diag log line uses "PlayScript"
        // wording per the Phase 31 spec, since the `script_id` field maps
        // to the `PlayScript` enum at `ACE.Entity/Enum/PlayScript.cs`.
        GameMessage::PlayEffect(data) => {
            log::debug!(
                "PlayScript received: target=0x{:08X} script={} speed={}",
                u32::from(data.target),
                data.script_id,
                data.speed,
            );
            events.push(WorldEvent::PlayEffect {
                target: data.target,
                script_id: data.script_id,
                speed: data.speed,
            });
            true
        }
        _ => false,
    }
}

pub(crate) fn handle_event(
    state: &mut WorldState,
    event: &GameEventMessage,
    events: &mut Vec<WorldEvent>,
) -> bool {
    match &event.event {
        GameEvent::UseDone(data) => {
            events.push(WorldEvent::UseDone { error: data.error });
            true
        }
        GameEvent::WeenieError(data) => {
            events.push(WorldEvent::WeenieError { error: data.error });
            if data.error == WeenieError::TradeComplete {
                state.handle_trade_complete(events);
            }
            true
        }
        GameEvent::WeenieErrorWithString(data) => {
            events.push(WorldEvent::WeenieErrorWithString {
                error: data.error,
                parameter: data.parameter.clone(),
            });
            true
        }
        _ => false,
    }
}
