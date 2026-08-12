use crate::WorldEvent;
use crate::handlers::{fellowship, inventory, login, movement, player, properties, system, trade};
use crate::state::WorldState;
use holtburger_protocol::messages::GameMessage;

fn resolve_spell_names(state: &WorldState, events: &mut [WorldEvent]) {
    for event in events.iter_mut() {
        match event {
            WorldEvent::SpellUpdated { spell_id, name, .. } if name.is_none() => {
                *name = state.resolve_spell_name(*spell_id);
            }
            _ => {}
        }
    }
}

/// Top-level dispatcher for protocol messages.
///
/// This is the entry point for all game messages received from the server.
/// It orchestrates mutations across [PlayerState] and [WorldState].
///
/// ORACLE open defect #1 (2026-08-12): the augmentation probe lives HERE, not
/// on `WorldState::handle_message`. 5ae4efd6 put it on that inherent wrapper —
/// which its unit test exercises, and which the LIVE wasm client never calls:
/// `apps/holtburger-web/src/lib.rs:43647` invokes
/// `holtburger_world::handlers::routing::handle_message` directly. So the trace
/// was structurally incapable of recording anything in a browser session, and
/// the empty trace it produced there was a blind instrument rather than the
/// "ACE never sent it" finding its own docs invite you to read it as. This is
/// the real choke point: the inherent wrapper delegates here (via the
/// `pub use routing::handle_message` re-export in `handlers/mod.rs`), so
/// hooking here covers BOTH callers exactly once.
pub fn handle_message(state: &mut WorldState, message: &GameMessage, events: &mut Vec<WorldEvent>) {
    let aug_before = state.aug_probe();
    handle_message_dispatch(state, message, events);
    if state.aug_probe() != aug_before {
        // Variant name only — `GameMessage`'s Debug carries the whole payload
        // and we want a label, not a packet dump. Only formatted on an actual
        // transition, of which a session has a handful.
        let rendered = format!("{message:?}");
        let site = rendered.split(['(', ' ', '{']).next().unwrap_or("?");
        state.note_aug_transition(site, aug_before);
    }
}

fn handle_message_dispatch(
    state: &mut WorldState,
    message: &GameMessage,
    events: &mut Vec<WorldEvent>,
) {
    if player::handle_message(state, message, events) {
        resolve_spell_names(state, events);
        return;
    }

    if system::handle_message(state, message, events) {
        resolve_spell_names(state, events);
        return;
    }

    if movement::handle_message(state, message, events)
        || properties::handle_message(state, message, events)
        || inventory::handle_message(state, message, events)
    {
        resolve_spell_names(state, events);
        return;
    }

    if let GameMessage::GameEvent(event) = message {
        let player_handled = player::handle_event(state, event, events);

        if player_handled
            || login::handle_event(state, event, events)
            || fellowship::handle_event(state, event, events)
            || trade::handle_event(state, event, events)
            || inventory::handle_event(state, event, events)
            || system::handle_event(state, event, events)
        {
            resolve_spell_names(state, events);
        }
    }
}
