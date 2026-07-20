//! Soak-11 §5.1 observability — monotonic tallies for the Layer-1
//! arrival-placement latch (`MovementSystem::consume_pending_arrival_placement`).
//!
//! Two process-global counters, incremented once per teleport arrival that
//! reaches the latch: `engaged` (a valid de-embedded pose was found and
//! applied) and `failed` (residency present but the placement search returned
//! no pose, so the arrival pose was kept as-is). Read on demand and packed
//! `lo16 = engaged`, `hi16 = failed` for the wasm getter (`arrivalPlacementDiag`
//! in `apps/holtburger-web`), which lets a future soak assert
//! "N embedded teleports → N engagements" without depending on console scrape.
//!
//! Pure `std::sync::atomic` (no wasm-only deps) so the native `--lib` test
//! build compiles unchanged. Mirrors the `holtburger_world::pose_snap_diag`
//! free-function precedent.

use std::sync::atomic::{AtomicU32, Ordering};

static ENGAGED: AtomicU32 = AtomicU32::new(0);
static FAILED: AtomicU32 = AtomicU32::new(0);

/// A valid arrival placement was found and applied (de-embed succeeded).
pub fn note_engaged() {
    ENGAGED.fetch_add(1, Ordering::Relaxed);
}

/// The placement search found no valid pose; the arrival pose was kept.
pub fn note_failed() {
    FAILED.fetch_add(1, Ordering::Relaxed);
}

/// Packed snapshot: `lo16 = engaged`, `hi16 = failed` (each saturating at
/// 0xFFFF, which is far beyond any realistic per-session teleport count).
pub fn read_packed() -> u32 {
    let engaged = ENGAGED.load(Ordering::Relaxed).min(0xFFFF);
    let failed = FAILED.load(Ordering::Relaxed).min(0xFFFF);
    (failed << 16) | engaged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_engaged_low_failed_high() {
        // Counters are process-global; this test only asserts the packing
        // arithmetic over the read, not absolute values (other tests in the
        // same binary may have incremented them).
        note_engaged();
        note_failed();
        let packed = read_packed();
        let engaged = packed & 0xFFFF;
        let failed = packed >> 16;
        assert!(engaged >= 1, "engaged low16 should have counted at least one");
        assert!(failed >= 1, "failed high16 should have counted at least one");
    }
}
