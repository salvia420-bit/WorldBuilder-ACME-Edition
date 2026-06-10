//! Chess minigame (drudge-chess board) protocol messages.
//!
//! SG-C1a (2026-06-09): the 5 S2C GameEvents that drive the board
//! (`JoinGameResponse`, `MoveResponse`, `OpponentTurn`, `OpponentStalemate`,
//! `GameOver`) plus the `ChessMoveData` / `ChessPieceCoord` wire structs.
pub mod events;

pub use events::*;
