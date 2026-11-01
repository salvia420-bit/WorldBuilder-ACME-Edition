//! `SessionCommand` arm: holtburger vehicles (HBV1) — send one vehicle game action.
//!
//! The JS vehicle module (`scene3d/vehicle/`, `?vehicles=on`) builds the message through the `vehicle*`
//! SessionHandle methods; the session never sends a vehicle action on its own, so a client without the flag
//! stays a standard client (DESIGN.md §5: no session that has not asked ever receives a vehicle message).

use crate::*;
use crate::session::{LoopCtx, LoopFlow};

pub(super) async fn handle(ctx: &mut LoopCtx, cmd: SessionCommand) -> LoopFlow {
    let LoopCtx {
        session,
        queued_events,
        state,
        ..
    } = &mut *ctx;
    match cmd {
        SessionCommand::VehicleSend { msg } => {
            if !matches!(state, LoopState::InWorld { .. }) {
                return LoopFlow::Continue;
            }
            use holtburger_protocol::messages::GameAction;
            let is_input = matches!(
                msg,
                holtburger_protocol::messages::vehicle::VehicleC2S::Input { .. }
            );
            send_or_disconnect!(
                queued_events,
                e,
                session.send_action(GameAction::Vehicle(Box::new(msg))).await.map(|_| ()),
                "recv_loop: send_action(Vehicle): {e}",
                "vehicle send: {e}",
                LoopFlow::Exit
            );
            crate::vehicle_link::note_sent(is_input);
        }
        _ => unreachable!("SessionCommand routed to the wrong handler module"),
    }
    LoopFlow::Continue
}
