//! Bug-A round-3 diag (2026-07-03, post-flip session 2): counters on the
//! LOCAL reconcile leash arm — the `local_retail_leash` Snapshot branch of
//! `Scene::reconcile_authoritative_body_with_remote` (spatial/scene.rs),
//! the lane the round-2 verdict left as the only live snap carrier (both
//! wire carriers counted 0 across 19 yanks). Read from the wasm
//! `leashEchoDiag` export by capture harnesses. Diagnostics ONLY —
//! nothing in product code consumes these.
//!
//! Packed read shape: `"seen,mirrorSeen,applied,gated,lastDeltaCm"`.
//! - `seen`        — Snapshot-class self echoes reaching the leash block
//!   (local player, simulating, retail leash on): the ~20 Hz broadcast
//!   echo stream, mirror up or not.
//! - `mirrorSeen`  — the subset arriving while the control mirror
//!   (`local_server_controlled`) was up — the TurnTo windows targeted
//!   casting opens.
//! - `applied`     — echoes the arm actually PULLED on
//!   (`remote_interpolate_to` invoked). Bug A's carrier: convict =
//!   `applied` climbing inside cast windows while both
//!   `pose_snap_diag` wire carriers stay 0.
//! - `gated`       — pulls suppressed by the leash echo gate
//!   (`UsePositionFromServer`, acclient.c:717529 — autonomy pinned 2 per
//!   ADJ-6 ⇒ retail ignores routine echoes). 0 until the gate is armed.
//! - `lastDeltaCm` — |body.pose − echo| at the last pull/suppress.

use std::sync::atomic::{AtomicU32, Ordering};

static SEEN: AtomicU32 = AtomicU32::new(0);
static MIRROR_SEEN: AtomicU32 = AtomicU32::new(0);
static APPLIED: AtomicU32 = AtomicU32::new(0);
static GATED: AtomicU32 = AtomicU32::new(0);
static LAST_DELTA_CM: AtomicU32 = AtomicU32::new(0);

/// A Snapshot-class self echo reached the leash block.
pub fn record_echo(mirror_up: bool) {
    SEEN.fetch_add(1, Ordering::Relaxed);
    if mirror_up {
        MIRROR_SEEN.fetch_add(1, Ordering::Relaxed);
    }
}

/// The arm pulled the runtime body toward the echo.
pub fn record_pull(delta_m: f32) {
    APPLIED.fetch_add(1, Ordering::Relaxed);
    LAST_DELTA_CM.store((delta_m.max(0.0) * 100.0) as u32, Ordering::Relaxed);
}

/// The leash echo gate suppressed a would-have-fired pull.
pub fn record_gated(delta_m: f32) {
    GATED.fetch_add(1, Ordering::Relaxed);
    LAST_DELTA_CM.store((delta_m.max(0.0) * 100.0) as u32, Ordering::Relaxed);
}

pub fn read_packed() -> String {
    format!(
        "{},{},{},{},{}",
        SEEN.load(Ordering::Relaxed),
        MIRROR_SEEN.load(Ordering::Relaxed),
        APPLIED.load(Ordering::Relaxed),
        GATED.load(Ordering::Relaxed),
        LAST_DELTA_CM.load(Ordering::Relaxed),
    )
}
