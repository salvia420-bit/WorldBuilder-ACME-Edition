mod command_interpreter;
mod command_stacks;
mod common;
mod handle;
mod interp_state;
mod jump_charge;
mod list_engine;
mod motion_interp;
mod motion_table_manager;
mod move_to;
mod move_to_nodes;
mod movement_manager;
mod params;
mod raw_state;
#[cfg(test)]
mod retail_behavior_tests;
mod system;

pub use handle::MovementSystemHandle;
// A14-I4 (W3+ S11): jump release outcome + retail refusal codes, read by
// the wasm `JumpChargeRelease`/`JumpChargeCommence` arms to emit
// refusal-text ClientEvents.
pub use jump_charge::{JumpOutcome, JumpRefusal};
// Wave-1 step 5 (rows 12-13): the ?cmdInterp=on lane's JS-facing event
// stream, drained by the wasm TickMovement arm (ClientEvent kind 61).
pub use system::CmdInterpEvent;
pub(super) use common::{HUGE_QUANTUM, MAX_QUANTUM};
pub(super) use system::{MovementSystem, ServerControlledProjection};
