//! `SessionCommand` arms: Housing: buy/rent/abandon, house query, guest list.
//!
//! Moved verbatim from the `recv_loop` command `select!` arm (2026-10-05
//! split); see `session::commands::handle_command` for the routing.

use crate::*;
use crate::session::{LoopCtx, LoopFlow};

pub(super) async fn handle(ctx: &mut LoopCtx, cmd: SessionCommand) -> LoopFlow {
    let LoopCtx { session, queued_events, movement, .. } = &mut *ctx;
    match cmd {
        SessionCommand::BuyHouse {
            slumlord_guid,
            item_guids,
        } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                BuyHouseActionData, GameAction,
            };
            let item_count = item_guids.len();
            let log_preview: String = item_guids
                .iter()
                .take(4)
                .map(|g| format!("0x{g:08X}"))
                .collect::<Vec<_>>()
                .join(",");
            let action = GameAction::BuyHouse(Box::new(BuyHouseActionData {
                slumlord_guid: Guid(slumlord_guid),
                item_guids: item_guids.into_iter().map(Guid).collect(),
            }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(BuyHouse): {e}",
                "buy_house: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[house/buy] slumlord=0x{slumlord_guid:08X} count={item_count} items=[{log_preview}]",
            ));
        }
        SessionCommand::HouseQuery => {
            use holtburger_protocol::messages::{
                GameAction, HouseQueryActionData,
            };
            let action = GameAction::HouseQuery(Box::new(
                HouseQueryActionData {},
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(HouseQuery): {e}",
                "house_query: {e}",
                LoopFlow::Exit
            );
            console_log_str("[house/query]");
        }
        SessionCommand::AbandonHouse => {
            use holtburger_protocol::messages::{
                AbandonHouseActionData, GameAction,
            };
            let action = GameAction::AbandonHouse(Box::new(
                AbandonHouseActionData {},
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(AbandonHouse): {e}",
                "abandon_house: {e}",
                LoopFlow::Exit
            );
            console_log_str("[house/abandon]");
        }
        SessionCommand::RentHouse {
            slumlord_guid,
            item_guids,
        } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                GameAction, RentHouseActionData,
            };
            let item_count = item_guids.len();
            let log_preview: String = item_guids
                .iter()
                .take(4)
                .map(|g| format!("0x{g:08X}"))
                .collect::<Vec<_>>()
                .join(",");
            let action = GameAction::RentHouse(Box::new(RentHouseActionData {
                slumlord_guid: Guid(slumlord_guid),
                item_guids: item_guids.into_iter().map(Guid).collect(),
            }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(RentHouse): {e}",
                "rent_house: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[house/rent] slumlord=0x{slumlord_guid:08X} count={item_count} items=[{log_preview}]",
            ));
        }
        SessionCommand::AddPermanentGuest { target_name } => {
            use holtburger_protocol::messages::{
                AddPermanentGuestActionData, GameAction,
            };
            let log_name = target_name.clone();
            let action = GameAction::AddPermanentGuest(Box::new(
                AddPermanentGuestActionData { target_name },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(AddPermanentGuest): {e}",
                "add_permanent_guest: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!("[house/add-guest] target={log_name}"));
        }
        SessionCommand::BootSpecificHouseGuest { target_name } => {
            use holtburger_protocol::messages::{
                BootSpecificHouseGuestActionData, GameAction,
            };
            let log_name = target_name.clone();
            let action = GameAction::BootSpecificHouseGuest(Box::new(
                BootSpecificHouseGuestActionData { target_name },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(BootSpecificHouseGuest): {e}",
                "boot_specific_house_guest: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!("[house/boot] target={log_name}"));
        }
        SessionCommand::RemoveAllPermanentGuests => {
            use holtburger_protocol::messages::{
                GameAction, RemoveAllPermanentGuestsActionData,
            };
            let action = GameAction::RemoveAllPermanentGuests(Box::new(
                RemoveAllPermanentGuestsActionData {},
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(RemoveAllPermanentGuests): {e}",
                "remove_all_permanent_guests: {e}",
                LoopFlow::Exit
            );
            console_log_str("[house/remove-all]");
        }
        _ => unreachable!("SessionCommand routed to the wrong handler module"),
    }
    LoopFlow::Continue
}
