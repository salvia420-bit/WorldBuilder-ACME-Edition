//! UI-surface self-events (SG-C3, 2026-06-09): StartBarber (0x0075),
//! ChannelList (0x0148), ChannelIndex (0x0149), QueryAgeResponse (0x01C3),
//! UpdateHAR (0x0257 — house access records), AvailableHouses (0x0271).
//! maps-chargen-barber-1 (2026-10-13): + the barber's reply, the C2S
//! FinishBarber (0x0311) action.
pub mod actions;
pub mod events;

pub use actions::*;
pub use events::*;
