//! MoveTo refactor phase A (2026-10-10): the movement value types moved to
//! `holtburger_world::motion::movement_types` with the rest of the
//! per-object movement stack. Re-exported here so every existing
//! `holtburger_core::client::movement_types::…` path keeps resolving.

pub use holtburger_world::motion::movement_types::*;
