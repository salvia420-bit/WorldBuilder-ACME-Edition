//! Bug-A round-2 diag (2026-07-03, cmdInterp post-flip wave):
//! per-carrier counters for LOCAL-player pose snaps, read from the wasm
//! `localPoseSnapDiag` export by capture harnesses. Diagnostics ONLY —
//! nothing in product code consumes these.
//!
//! Carriers:
//! - 1 = `apply_public_position_update` local arm (a PublicUpdatePosition
//!   for OUR OWN guid applied unconditionally — retail's full-autonomy
//!   client gates this via `UsePositionFromServer`, acclient.c:717529;
//!   suspected bug-A carrier).
//! - 2 = `apply_self_position_pack` FORCED arm (teleport /
//!   force_position sequence advance — the retail-legit snap).

use std::sync::atomic::{AtomicU32, Ordering};

static PUBLIC_SNAPS: AtomicU32 = AtomicU32::new(0);
static FORCED_SNAPS: AtomicU32 = AtomicU32::new(0);
static LAST_DELTA_CM: AtomicU32 = AtomicU32::new(0);
static LAST_CARRIER: AtomicU32 = AtomicU32::new(0);

pub fn record(carrier: u32, delta_m: f32) {
    match carrier {
        1 => {
            PUBLIC_SNAPS.fetch_add(1, Ordering::Relaxed);
        }
        2 => {
            FORCED_SNAPS.fetch_add(1, Ordering::Relaxed);
        }
        _ => return,
    }
    LAST_DELTA_CM.store((delta_m.max(0.0) * 100.0) as u32, Ordering::Relaxed);
    LAST_CARRIER.store(carrier, Ordering::Relaxed);
}

pub fn read_packed() -> String {
    format!(
        "{},{},{},{}",
        PUBLIC_SNAPS.load(Ordering::Relaxed),
        FORCED_SNAPS.load(Ordering::Relaxed),
        LAST_DELTA_CM.load(Ordering::Relaxed),
        LAST_CARRIER.load(Ordering::Relaxed),
    )
}
