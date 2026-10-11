//! The per-object movement stack — retail `MovementManager` and its children
//! (`CMotionInterp`, `MoveToManager`, the `MotionTableManager` completion
//! queue) plus the parameter and state types they share.
//!
//! MoveTo refactor (2026-10-10, phase A): these modules moved here from
//! `holtburger-core/src/client/movement/` unchanged, so that the world's
//! per-object step can own one movement manager per physics object, as
//! retail's `CPhysicsObj` does (`acclient.h:30943`). `holtburger-core`
//! re-exports them under their old paths.

pub mod interp_state;
pub mod motion_interp;
pub mod motion_table_manager;
pub mod move_to;
pub mod move_to_nodes;
pub mod movement_manager;
pub mod movement_types;
pub mod params;
pub mod raw_state;
pub mod remote_mover;
pub mod root_motion;
pub mod target_voyeur;
