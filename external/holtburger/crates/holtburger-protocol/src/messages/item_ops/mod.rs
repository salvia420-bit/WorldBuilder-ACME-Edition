//! Item-operation self-events (SG-C2, 2026-06-09): `SalvageOperationsResult`
//! (0x02B4) and the deprecated `InscriptionResponse` (0x00C3). See `events.rs`
//! for the verified-already-handled note on `WieldItem` /
//! `ItemServerSaysContainId`.
pub mod events;

pub use events::*;
