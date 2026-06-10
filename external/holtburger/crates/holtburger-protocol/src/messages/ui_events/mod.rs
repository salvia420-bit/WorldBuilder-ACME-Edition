//! UI-surface self-events (SG-C3, 2026-06-09): StartBarber (0x0075),
//! ChannelList (0x0148), ChannelIndex (0x0149), QueryAgeResponse (0x01C3),
//! UpdateHAR (0x0257 — house access records), AvailableHouses (0x0271).
pub mod events;

pub use events::*;
