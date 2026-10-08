use crate::WorldEvent;
use crate::state::WorldState;
use holtburger_protocol::messages::{GameEvent, GameEventMessage};

pub(crate) fn handle_event(
    state: &mut WorldState,
    event: &GameEventMessage,
    events: &mut Vec<WorldEvent>,
) -> bool {
    match &event.event {
        GameEvent::RegisterTrade(data) => {
            state.register_trade(data.initiator, data.partner, events);
            true
        }
        GameEvent::AddToTrade(data) => {
            state.add_trade_item(data.trade_side, data.object_guid, events);
            true
        }
        GameEvent::AcceptTrade(data) => {
            state.accept_trade(data.who_accepted, events);
            true
        }
        GameEvent::ResetTrade(_) => {
            state.reset_trade(events);
            true
        }
        // trade-1 (2026-10-08): retail treats these three differently.
        // ClientTradeSystem::Handle_Trade__Recv_DeclineTrade (acclient.c
        // 410398) clears only the decliner's accepted flag.
        GameEvent::DeclineTrade(data) => {
            state.decline_trade(data.who_declined, events);
            true
        }
        // gmSecureTradeUI::RecvNotice_ClearTradeAcceptance → Reset →
        // FlushTradeLists (both offers emptied). ACE ClearTradeAcceptance
        // empties ItemsInTradeWindow for both players (failed finalize).
        GameEvent::ClearTradeAcceptance => {
            state.reset_trade(events);
            true
        }
        // Handle_Trade__Recv_TradeFailure → Trade::RemoveItem(item, 1).
        GameEvent::TradeFailure(data) => {
            state.trade_failure(data.object_guid, events);
            true
        }
        GameEvent::CloseTrade(_) => {
            state.close_trade(events);
            true
        }
        GameEvent::ApproachVendor(data) => {
            state.set_vendor_state(data, events);
            true
        }
        _ => false,
    }
}
