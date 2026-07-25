//! Admission control for DECODE jobs (A15 §2.1, slice S1).
//!
//! Deliberately modelled line-for-line on
//! `crates/holtburger-resource-http/src/concurrency.rs::Semaphore`, and for the
//! same reason: the invariants that make that primitive pool-ready are exactly
//! the ones A15 §2.1c will need when walks dispatch to a rayon pool.
//!
//! Copied verbatim from `Semaphore`:
//! * `Arc<Mutex<_>>` + `futures::channel::oneshot` (never `Rc`), so leases and
//!   the futures holding them stay `Send`.
//! * **The mutex is never held across an `.await`.**
//! * A dropping lease hands its slot *directly* to the next live waiter rather
//!   than returning it to the pool — no thundering herd.
//! * A waiter whose receiver was dropped (a cancelled `admit`) is skipped.
//!
//! What is NEW relative to `Semaphore`, and why:
//!
//! * **Two keys, not one** (§2.2). `max_jobs` is the hard guard — always
//!   correct, needs no estimate. `max_bytes` is the shaping guard, because the
//!   §1 inventory says the peak is byte-shaped, not job-shaped (a 1024² surface
//!   batch and a 16-tri prop are both "1 job"). Byte estimates are pre-decode
//!   and can be off by 250× (a 4 KB DXT record decodes to 1 MiB), which is
//!   precisely why [`DecodeLease::revise`] exists.
//! * **An urgent lane** (§2.3), mandatory in the same commit as any bound.
//!   `prefetch_urgent` exists because FIFO queuing starved interior loads for
//!   *minutes*; a single-lane gate would reintroduce that failure one layer up.
//!   `admit_urgent` may consume the private `urgent_reserve` that the normal
//!   lane can never touch, and it queues at the FRONT, never behind normal
//!   waiters.
//! * **Stats**, because S1's whole job is the missing number (§4).
//!
//! ## Slice S1 is neutral by construction
//!
//! The global installed in `lib.rs` is `new(usize::MAX, usize::MAX, 0)`. An
//! unbounded gate can never enqueue a waiter, so no call site can ever block:
//! every `admit()` returns on the fast path having done nothing but bump a
//! counter. The bound itself (a host-supplied `set_decode_admission`) is S4.
//!
//! ## Deadlock freedom
//!
//! Nesting is strictly `admit()` → `ensure_walk_prefetched` → `prefetch` →
//! `fetch_sem.acquire()`, never the reverse (§2.4): a job holding a decode
//! lease can always make fetch progress, because fetch permits are released by
//! network completion, which never requires a decode lease. Additionally, a
//! single job larger than `max_bytes` is admitted anyway when nothing is live
//! (`live_jobs == 0`), so the byte guard can never wedge the gate shut.

#![cfg(any(target_arch = "wasm32", test))]
// The acquisition sites (§2.3) are all `#[wasm_bindgen]` exports, so on the
// native test target only the unit tests below reach this module.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use futures::channel::oneshot;

/// Monotonic milliseconds. `web-time` transparently re-exports
/// `std::time::Instant` natively and is backed by `performance.now()` on
/// wasm32, so `maxQueueMs` means the same thing in both instances and in the
/// native unit tests. (Deliberately NOT `js_sys::Date::now()` — wall clock is
/// not monotone.)
fn now_ms() -> f64 {
    use std::sync::LazyLock;
    static EPOCH: LazyLock<web_time::Instant> = LazyLock::new(web_time::Instant::now);
    EPOCH.elapsed().as_secs_f64() * 1000.0
}

/// §2.2 item 3: "sample at most once per 250 ms inside `admit`". The sample is
/// a JS `WebAssembly.Memory` read on the decode hot path; the ceiling is what
/// keeps it off the fast path's cost.
pub const PRESSURE_SAMPLE_INTERVAL_MS: f64 = 250.0;

struct Waiter {
    tx: oneshot::Sender<()>,
    bytes: usize,
    urgent: bool,
}

struct Inner {
    max_jobs: usize,
    max_bytes: usize,
    urgent_reserve: usize,

    /// §2.2 item 3 (S5): sampled-`wasm_memory_bytes()` step thresholds. Above
    /// `t1_bytes` the effective caps halve; above `t2_bytes` they quarter.
    /// `u64::MAX` (the default) is INERT — the comparison is strictly `>`, so
    /// no sample can ever trip it.
    t1_bytes: u64,
    t2_bytes: u64,
    /// 0/1/2. MONOTONE by construction: `pressure_input` only ever raises it.
    /// That is the honest reading of a monotone signal — `WebAssembly.Memory`
    /// only grows, so a sample is a HIGH-WATER MARK, not current occupancy. A
    /// gate that let the level fall would be pretending the mark had receded.
    /// The shrink is therefore permanent once tripped, and that is intended.
    pressure_level: u32,
    /// `now_ms()` of the last accepted sample (see `maybe_sample_pressure`).
    last_sample_ms: f64,

    live_jobs: usize,
    live_bytes: usize,

    peak_live_jobs: usize,
    peak_live_bytes: usize,

    admits: u64,
    urgent_admits: u64,
    queued: u64,
    max_queue_ms: f64,

    waiters: VecDeque<Waiter>,
}

impl Inner {
    /// The configured job cap after the §2.2-item-3 pressure step. Shrink-ONLY
    /// and never below 1 (a cap of 0 would wedge the gate shut forever, which
    /// is precisely the failure mode the monotone signal makes irreversible).
    /// Note `usize::MAX / 4` is still unbounded in practice, so pressure on an
    /// unarmed gate stays neutral by construction.
    fn effective_max_jobs(&self) -> usize {
        match self.pressure_level {
            0 => self.max_jobs,
            1 => (self.max_jobs / 2).max(1),
            _ => (self.max_jobs / 4).max(1),
        }
    }

    fn effective_max_bytes(&self) -> usize {
        match self.pressure_level {
            0 => self.max_bytes,
            1 => (self.max_bytes / 2).max(1),
            _ => (self.max_bytes / 4).max(1),
        }
    }

    /// Job cap visible to the lane. The normal lane may never consume the
    /// private urgent reserve; the urgent lane sees the whole cap.
    ///
    /// S5: the reserve itself is NEVER scaled by pressure — starvation safety
    /// beats memory at the margin. `prefetch_urgent` exists because FIFO
    /// queuing starved interior loads for MINUTES; shrinking the reserve under
    /// memory pressure would re-create that failure exactly when the session is
    /// most fragile, to save at most one job's worth of bytes. It is only
    /// clamped to `effective_jobs - 1` — the same clamp `new()` already applies
    /// against `max_jobs` — so the normal lane always keeps one usable slot.
    fn job_cap(&self, urgent: bool) -> usize {
        let jobs = self.effective_max_jobs();
        if urgent {
            jobs
        } else {
            jobs - self.urgent_reserve.min(jobs.saturating_sub(1))
        }
    }

    fn can_admit(&self, bytes: usize, urgent: bool) -> bool {
        if self.live_jobs >= self.job_cap(urgent) {
            return false;
        }
        // `live_jobs == 0` escape: a lone job bigger than the whole byte budget
        // must still run, or the gate wedges permanently.
        self.live_bytes.saturating_add(bytes) <= self.effective_max_bytes() || self.live_jobs == 0
    }

    /// Account an admission. Callers must have checked [`Self::can_admit`]
    /// (or be the fast path of an unbounded gate).
    fn account_admit(&mut self, bytes: usize, urgent: bool) {
        self.live_jobs += 1;
        self.live_bytes = self.live_bytes.saturating_add(bytes);
        self.peak_live_jobs = self.peak_live_jobs.max(self.live_jobs);
        self.peak_live_bytes = self.peak_live_bytes.max(self.live_bytes);
        self.admits += 1;
        if urgent {
            self.urgent_admits += 1;
        }
    }

    fn unaccount_admit(&mut self, bytes: usize, urgent: bool) {
        self.live_jobs = self.live_jobs.saturating_sub(1);
        self.live_bytes = self.live_bytes.saturating_sub(bytes);
        self.admits = self.admits.saturating_sub(1);
        if urgent {
            self.urgent_admits = self.urgent_admits.saturating_sub(1);
        }
    }

    /// Hand freed capacity directly to the head of the FIFO queue, skipping
    /// waiters whose receiver was dropped. Strict FIFO: if the head cannot be
    /// admitted the pass stops (no bypass), which is what keeps a big job from
    /// being starved by a stream of small ones. Called from `Drop` and from
    /// `revise` (a downward revision frees bytes).
    fn wake_waiters(&mut self) {
        while let Some(front) = self.waiters.front() {
            let (bytes, urgent) = (front.bytes, front.urgent);
            if !self.can_admit(bytes, urgent) {
                return;
            }
            let w = self.waiters.pop_front().expect("front() just succeeded");
            // Pre-account BEFORE the send so the slot cannot be stolen by a
            // fast-path `admit` racing in between.
            self.account_admit(bytes, urgent);
            if w.tx.send(()).is_err() {
                // Cancelled `admit` — its `DecodeLease` will never exist, so
                // roll the accounting back and try the next waiter.
                self.unaccount_admit(bytes, urgent);
            }
        }
    }
}

/// Cheap to clone (shares one `Arc`).
#[derive(Clone)]
pub struct DecodeAdmission {
    inner: Arc<Mutex<Inner>>,
}

/// RAII decode permit. Held across `.await` points by design (§2.3); sound
/// because it is `Send` by construction.
pub struct DecodeLease {
    inner: Arc<Mutex<Inner>>,
    bytes: usize,
    urgent: bool,
}

/// Snapshot of the gate, mirrored field-for-field into `dat_decode_diag()`'s
/// `decodeAdmission` object (§2.6).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct AdmissionStats {
    pub max_jobs: usize,
    pub max_bytes: usize,
    /// S5: the caps actually enforced right now = configured ÷ 2^pressure_level
    /// (min 1). Equal to `max_jobs`/`max_bytes` at level 0. `pressure_level`
    /// alone cannot tell a probe what the gate is doing; these can.
    pub effective_max_jobs: usize,
    pub effective_max_bytes: usize,
    pub live_jobs: usize,
    pub live_bytes: usize,
    pub peak_live_jobs: usize,
    pub peak_live_bytes: usize,
    pub admits: u64,
    pub queued: u64,
    pub max_queue_ms: f64,
    pub urgent_admits: u64,
    /// §2.2 item 3 — the shrink-only `wasm_memory_bytes()` hysteresis
    /// multiplier. Hardcoded 0 in S1; wired in S5.
    pub pressure_level: u32,
}

impl DecodeAdmission {
    pub fn new(max_jobs: usize, max_bytes: usize, urgent_reserve: usize) -> Self {
        Self::with_pressure(max_jobs, max_bytes, urgent_reserve, u64::MAX, u64::MAX)
    }

    /// S5. `t1_bytes`/`t2_bytes` are sampled-`wasm_memory_bytes()` thresholds;
    /// `u64::MAX` (what `new` passes) is inert. `t2` is clamped up to `t1` so a
    /// swapped pair degrades to a single step rather than to nonsense.
    pub fn with_pressure(
        max_jobs: usize,
        max_bytes: usize,
        urgent_reserve: usize,
        t1_bytes: u64,
        t2_bytes: u64,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                max_jobs: max_jobs.max(1),
                max_bytes,
                urgent_reserve: urgent_reserve.min(max_jobs.saturating_sub(1)),
                t1_bytes,
                t2_bytes: t2_bytes.max(t1_bytes),
                pressure_level: 0,
                last_sample_ms: f64::NEG_INFINITY,
                live_jobs: 0,
                live_bytes: 0,
                peak_live_jobs: 0,
                peak_live_bytes: 0,
                admits: 0,
                urgent_admits: 0,
                queued: 0,
                max_queue_ms: 0.0,
                waiters: VecDeque::new(),
            })),
        }
    }

    /// Normal lane. `estimate_bytes` is a pre-decode guess (§2.2 item 2);
    /// correct it with [`DecodeLease::revise`] once the truth is known.
    pub async fn admit(&self, estimate_bytes: usize) -> DecodeLease {
        self.admit_lane(estimate_bytes, false).await
    }

    /// Urgent lane (player-blocking loads). Consumes the private
    /// `urgent_reserve` the normal lane can never reach, and queues at the
    /// FRONT so it is never parked behind normal waiters.
    pub async fn admit_urgent(&self, estimate_bytes: usize) -> DecodeLease {
        self.admit_lane(estimate_bytes, true).await
    }

    async fn admit_lane(&self, estimate_bytes: usize, urgent: bool) -> DecodeLease {
        // Fast path / enqueue under the lock; the guard is dropped before the
        // `.await` so the mutex is never held across a suspension point.
        let rx = {
            let mut g = self.lock();
            if g.can_admit(estimate_bytes, urgent) {
                g.account_admit(estimate_bytes, urgent);
                return DecodeLease {
                    inner: self.inner.clone(),
                    bytes: estimate_bytes,
                    urgent,
                };
            }
            let (tx, rx) = oneshot::channel();
            let w = Waiter {
                tx,
                bytes: estimate_bytes,
                urgent,
            };
            if urgent {
                g.waiters.push_front(w);
            } else {
                g.waiters.push_back(w);
            }
            g.queued += 1;
            rx
        };
        let t0 = now_ms();
        // A dropping lease hands the slot to us via `send(())` having ALREADY
        // accounted the admission, so on success it is ours. `Err` means the
        // gate was torn down — take a best-effort lease; the count is moot.
        let handed_off = rx.await.is_ok();
        {
            let mut g = self.lock();
            let waited = now_ms() - t0;
            if waited > g.max_queue_ms {
                g.max_queue_ms = waited;
            }
            if !handed_off {
                g.account_admit(estimate_bytes, urgent);
            }
        }
        DecodeLease {
            inner: self.inner.clone(),
            bytes: estimate_bytes,
            urgent,
        }
    }

    /// Feed one `wasm_memory_bytes()` sample (§2.2 item 3, S5).
    ///
    /// **This is not an occupancy input.** `WebAssembly.Memory` only grows, so
    /// `sampled_bytes` is a high-water mark; it may only ever RAISE the
    /// pressure level, i.e. only ever SHRINK the effective bounds. A falling
    /// input is meaningless here and is ignored, which is why the level is
    /// `max`-ed rather than assigned. Comparisons are strictly `>`, so the
    /// `u64::MAX` default thresholds can never trip.
    ///
    /// No waiter wake-up: raising the level can only make `can_admit` stricter,
    /// so no parked waiter can newly become admissible.
    pub fn pressure_input(&self, sampled_bytes: u64) {
        let mut g = self.lock();
        let level = if sampled_bytes > g.t2_bytes {
            2
        } else if sampled_bytes > g.t1_bytes {
            1
        } else {
            0
        };
        g.pressure_level = g.pressure_level.max(level);
    }

    /// Rate-limited wrapper for the hot path: takes the sample at most once per
    /// [`PRESSURE_SAMPLE_INTERVAL_MS`], and only CALLS `sample` when it is due
    /// — so the `js_sys` read never happens inside `admit`'s fast path, and
    /// `decode_admission` itself stays free of any JS dependency (native tests
    /// pass a plain closure).
    pub fn maybe_sample_pressure(&self, sample: impl FnOnce() -> u64) {
        {
            let mut g = self.lock();
            // Inert gate: with both thresholds at the default, no sample can
            // change anything, so do not even pay for the closure.
            if g.t1_bytes == u64::MAX && g.t2_bytes == u64::MAX {
                return;
            }
            let now = now_ms();
            if now - g.last_sample_ms < PRESSURE_SAMPLE_INTERVAL_MS {
                return;
            }
            g.last_sample_ms = now;
        }
        // Lock released before the callback: it reaches out to the host.
        let bytes = sample();
        self.pressure_input(bytes);
    }

    pub fn stats(&self) -> AdmissionStats {
        let g = self.lock();
        AdmissionStats {
            max_jobs: g.max_jobs,
            max_bytes: g.max_bytes,
            effective_max_jobs: g.effective_max_jobs(),
            effective_max_bytes: g.effective_max_bytes(),
            live_jobs: g.live_jobs,
            live_bytes: g.live_bytes,
            peak_live_jobs: g.peak_live_jobs,
            peak_live_bytes: g.peak_live_bytes,
            admits: g.admits,
            queued: g.queued,
            max_queue_ms: g.max_queue_ms,
            urgent_admits: g.urgent_admits,
            pressure_level: g.pressure_level,
        }
    }

    /// Poisoning protects no invariant here (the `missing_surfaces()` pattern,
    /// `lib.rs` ~8690) — recover rather than cascade the panic into the bake.
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl DecodeLease {
    /// Correct the byte reservation once the true size is known (e.g. after
    /// `Texture::actual_dimensions()`). Without this, byte-keying is decorative
    /// and should not ship (§2.2 / §5 "estimate quality").
    pub fn revise(&mut self, actual_bytes: usize) {
        if actual_bytes == self.bytes {
            return;
        }
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.live_bytes = g
            .live_bytes
            .saturating_sub(self.bytes)
            .saturating_add(actual_bytes);
        g.peak_live_bytes = g.peak_live_bytes.max(g.live_bytes);
        let freed = actual_bytes < self.bytes;
        self.bytes = actual_bytes;
        if freed {
            g.wake_waiters();
        }
    }

    /// The bytes currently reserved by this lease.
    #[allow(dead_code)]
    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

// --- A15 §2.5 (S4): host-supplied configuration --------------------------------
//
// The bound is NEVER a Rust-side URL flag (design §4 S0 hard constraint):
// `js_location_search()` returns "" with no `window`, so a Rust-side read would
// be silently unbounded in the bake worker — the exact defect-2/4 shape. The
// host parses `?decodeAdmission*` JS-side and hands each instance its own
// numbers through three globals, mirroring `__hbFetchConcurrency` /
// `__hbShardBudgetBytes` (`manifest_source.rs::configured_shard_budget_bytes`):
//
//   globalThis.__hbDecodeMaxJobs        u32  ≥ 1   — absent ⇒ UNBOUNDED
//   globalThis.__hbDecodeMaxBytes       f64  ≥ 1   — absent ⇒ usize::MAX
//   globalThis.__hbDecodeUrgentReserve  u32  ≥ 1   — absent ⇒ 0
//   globalThis.__hbDecodePressureT1MB   f64  > 0   — absent ⇒ INERT  (S5)
//   globalThis.__hbDecodePressureT2MB   f64  > 0   — absent ⇒ INERT  (S5)
//
// `__hbDecodeMaxJobs` is the arming switch: with it absent the whole gate stays
// at `(usize::MAX, usize::MAX, 0)`, which can never enqueue a waiter, so an
// unauthored page is bit-for-bit the S1 behaviour.

/// Resolved host configuration. S5 turned the S4 3-tuple into a struct so the
/// two pressure thresholds are named at every call site rather than being the
/// fourth and fifth anonymous number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecodeConfig {
    pub max_jobs: usize,
    pub max_bytes: usize,
    pub urgent_reserve: usize,
    /// `u64::MAX` = inert (the default; see `Inner::t1_bytes`).
    pub t1_bytes: u64,
    pub t2_bytes: u64,
}

impl DecodeConfig {
    /// The S1 gate, bit for bit: unbounded and pressure-inert.
    pub const UNBOUNDED: Self = Self {
        max_jobs: usize::MAX,
        max_bytes: usize::MAX,
        urgent_reserve: 0,
        t1_bytes: u64::MAX,
        t2_bytes: u64::MAX,
    };

    pub fn build(self) -> DecodeAdmission {
        DecodeAdmission::with_pressure(
            self.max_jobs,
            self.max_bytes,
            self.urgent_reserve,
            self.t1_bytes,
            self.t2_bytes,
        )
    }
}

/// Pure resolution of the raw JS values into a [`DecodeConfig`]. Split out from
/// the `js_sys` read so it is testable natively.
///
/// `t1_mb`/`t2_mb` are in MEGABYTES (the globals are named `…T1MB`/`…T2MB`, and
/// a byte count is not a thing anyone types); absent/garbage ⇒ `u64::MAX` ⇒
/// inert. They are parsed independently of the `__hbDecodeMaxJobs` arming
/// switch: on an unarmed gate the caps are `usize::MAX`, and `usize::MAX / 4`
/// is still unbounded, so pressure on an unarmed gate remains neutral.
pub fn config_from_raw(
    jobs: Option<f64>,
    bytes: Option<f64>,
    reserve: Option<f64>,
    t1_mb: Option<f64>,
    t2_mb: Option<f64>,
) -> DecodeConfig {
    // MB → bytes, saturating; anything non-finite/≤0 is inert.
    let thresh = |mb: Option<f64>| match mb {
        Some(n) if n > 0.0 && n.is_finite() => {
            let b = n * 1_048_576.0;
            if b >= u64::MAX as f64 {
                u64::MAX
            } else {
                b as u64
            }
        }
        _ => u64::MAX,
    };
    let (t1_bytes, t2_bytes) = (thresh(t1_mb), thresh(t2_mb));

    let max_jobs = match jobs {
        Some(n) if n >= 1.0 && n.is_finite() => n as usize,
        // Not armed: byte/reserve values alone never bound anything, because a
        // job larger than `max_bytes` is admitted when nothing is live.
        _ => {
            return DecodeConfig {
                t1_bytes,
                t2_bytes,
                ..DecodeConfig::UNBOUNDED
            }
        }
    };
    let max_bytes = match bytes {
        Some(n) if n >= 1.0 && n.is_finite() => n as usize,
        _ => usize::MAX,
    };
    let urgent_reserve = match reserve {
        Some(n) if n >= 1.0 && n.is_finite() => n as usize,
        _ => 0,
    };
    DecodeConfig {
        max_jobs,
        max_bytes,
        urgent_reserve,
        t1_bytes,
        t2_bytes,
    }
}

/// Read this instance's host-supplied bound off `js_sys::global()` — which in
/// the bake worker is the WORKER's scope, so each instance gets its own budget
/// (§2.5 (ii)). Called once, at the `DECODE_ADMISSION` `LazyLock` init.
#[cfg(target_arch = "wasm32")]
pub fn configured_decode_admission() -> DecodeAdmission {
    let g = js_sys::global();
    let num = |k: &str| {
        js_sys::Reflect::get(g.as_ref(), &wasm_bindgen::JsValue::from_str(k))
            .ok()
            .and_then(|v| v.as_f64())
    };
    config_from_raw(
        num("__hbDecodeMaxJobs"),
        num("__hbDecodeMaxBytes"),
        num("__hbDecodeUrgentReserve"),
        num("__hbDecodePressureT1MB"),
        num("__hbDecodePressureT2MB"),
    )
    .build()
}

impl Drop for DecodeLease {
    fn drop(&mut self) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.live_jobs = g.live_jobs.saturating_sub(1);
        g.live_bytes = g.live_bytes.saturating_sub(self.bytes);
        g.wake_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    /// The wasm executor is single-threaded, so the tests are too: drive
    /// futures by hand rather than relying on a multi-thread runtime (which
    /// this crate's dev-deps deliberately do not enable).
    fn poll_once<F: std::future::Future>(fut: &mut std::pin::Pin<Box<F>>) -> Option<F::Output> {
        use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
        fn noop(_: *const ()) {}
        fn clone(p: *const ()) -> RawWaker {
            RawWaker::new(p, &VTABLE)
        }
        static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, noop, noop, noop);
        let waker = unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) };
        let mut cx = Context::from_waker(&waker);
        match fut.as_mut().poll(&mut cx) {
            Poll::Ready(v) => Some(v),
            Poll::Pending => None,
        }
    }

    fn block(fut: impl std::future::Future<Output = DecodeLease>) -> DecodeLease {
        let mut f = Box::pin(fut);
        poll_once(&mut f).expect("expected immediate admission")
    }

    #[test]
    fn unbounded_gate_never_queues_s1_neutrality() {
        let a = DecodeAdmission::new(usize::MAX, usize::MAX, 0);
        let mut held = Vec::new();
        for i in 0..1000 {
            held.push(block(a.admit(i * 4096)));
        }
        let s = a.stats();
        assert_eq!(s.queued, 0, "an unbounded gate must never enqueue");
        assert_eq!(s.admits, 1000);
        assert_eq!(s.live_jobs, 1000);
        assert_eq!(s.peak_live_jobs, 1000);
        drop(held);
        let s = a.stats();
        assert_eq!(s.live_jobs, 0);
        assert_eq!(s.live_bytes, 0);
        assert_eq!(s.peak_live_jobs, 1000, "peak is a high-water mark");
    }

    #[test]
    fn bounds_live_jobs_and_hands_off_fifo() {
        let a = DecodeAdmission::new(2, usize::MAX, 0);
        let l0 = block(a.admit(0));
        let _l1 = block(a.admit(0));
        assert_eq!(a.stats().live_jobs, 2);

        // Two more must park, in order.
        let order = Rc::new(RefCell::new(Vec::<u32>::new()));
        let mk = |tag: u32| {
            let a = a.clone();
            let order = order.clone();
            Box::pin(async move {
                let lease = a.admit(0).await;
                order.borrow_mut().push(tag);
                lease
            })
        };
        let mut w2 = mk(2);
        let mut w3 = mk(3);
        assert!(poll_once(&mut w2).is_none());
        assert!(poll_once(&mut w3).is_none());
        assert_eq!(a.stats().queued, 2);

        // Dropping one lease hands the slot to the FIRST waiter only.
        drop(l0);
        assert_eq!(a.stats().live_jobs, 2, "slot handed off, not returned");
        let l2 = poll_once(&mut w2).expect("first waiter got the slot");
        assert!(poll_once(&mut w3).is_none(), "second waiter still parked");
        assert_eq!(*order.borrow(), vec![2]);

        drop(l2);
        let _l3 = poll_once(&mut w3).expect("second waiter got the next slot");
        assert_eq!(*order.borrow(), vec![2, 3]);
        assert!(a.stats().peak_live_jobs <= 2, "cap never exceeded");
    }

    #[test]
    fn cancelled_waiter_is_skipped() {
        let a = DecodeAdmission::new(1, usize::MAX, 0);
        let l0 = block(a.admit(0));
        let mut cancelled = Box::pin(a.admit(0));
        let mut live = Box::pin(a.admit(0));
        assert!(poll_once(&mut cancelled).is_none());
        assert!(poll_once(&mut live).is_none());
        // Drop the first waiter's future => its oneshot receiver dies.
        drop(cancelled);
        drop(l0);
        let _l = poll_once(&mut live).expect("live waiter admitted past the cancelled one");
        let s = a.stats();
        assert_eq!(s.live_jobs, 1, "the cancelled hand-off was rolled back");
        assert_eq!(s.admits, 2, "cancelled admissions are not counted");
    }

    #[test]
    fn urgent_reserve_is_private_to_the_urgent_lane() {
        let a = DecodeAdmission::new(3, usize::MAX, 1);
        let _n0 = block(a.admit(0));
        let _n1 = block(a.admit(0));
        // Normal lane is done: 2 of 3, with 1 held back for urgent.
        let mut n2 = Box::pin(a.admit(0));
        assert!(poll_once(&mut n2).is_none(), "normal lane must not eat the reserve");
        // Urgent takes the reserved slot immediately, without queueing behind n2.
        let u = block(a.admit_urgent(0));
        let s = a.stats();
        assert_eq!(s.live_jobs, 3);
        assert_eq!(s.urgent_admits, 1);
        drop(u);
        assert!(
            poll_once(&mut n2).is_none(),
            "the freed slot is reserve again, still not the normal lane's"
        );
    }

    #[test]
    fn urgent_waiter_jumps_the_queue() {
        let a = DecodeAdmission::new(1, usize::MAX, 0);
        let l0 = block(a.admit(0));
        let mut normal = Box::pin(a.admit(0));
        assert!(poll_once(&mut normal).is_none());
        let mut urgent = Box::pin(a.admit_urgent(0));
        assert!(poll_once(&mut urgent).is_none());
        drop(l0);
        let u = poll_once(&mut urgent).expect("urgent jumped ahead of the parked normal waiter");
        assert!(poll_once(&mut normal).is_none());
        drop(u);
        let _n = poll_once(&mut normal).expect("normal drains after urgent");
    }

    #[test]
    fn byte_budget_bounds_live_bytes() {
        let a = DecodeAdmission::new(usize::MAX, 1000, 0);
        let l0 = block(a.admit(600));
        let mut over = Box::pin(a.admit(600));
        assert!(poll_once(&mut over).is_none(), "1200 > 1000 must park");
        assert_eq!(a.stats().live_bytes, 600);
        drop(l0);
        let _l = poll_once(&mut over).expect("bytes freed => admitted");
        assert_eq!(a.stats().live_bytes, 600);
        assert_eq!(a.stats().peak_live_bytes, 600);
    }

    #[test]
    fn oversized_lone_job_is_admitted_not_wedged() {
        let a = DecodeAdmission::new(usize::MAX, 1000, 0);
        let _l = block(a.admit(50_000));
        assert_eq!(a.stats().live_bytes, 50_000);
    }

    #[test]
    fn revise_corrects_accounting_and_wakes_on_shrink() {
        let a = DecodeAdmission::new(usize::MAX, 1000, 0);
        let mut l0 = block(a.admit(900));
        let mut parked = Box::pin(a.admit(400));
        assert!(poll_once(&mut parked).is_none());
        // The estimate was 900 but the record actually decoded to 100.
        l0.revise(100);
        assert_eq!(a.stats().live_bytes, 100 + 400, "waiter woke on the shrink");
        let _p = poll_once(&mut parked).expect("shrink freed the budget");
        // Upward revision is accounted too, and moves the peak.
        l0.revise(2_000);
        let s = a.stats();
        assert_eq!(s.live_bytes, 2_400);
        assert_eq!(s.peak_live_bytes, 2_400);
        drop(l0);
        assert_eq!(a.stats().live_bytes, 400, "drop releases the REVISED amount");
    }

    #[test]
    fn stats_pressure_level_is_zero_in_s1() {
        let a = DecodeAdmission::new(4, 1024, 1);
        let s = a.stats();
        assert_eq!(s.pressure_level, 0);
        assert_eq!(s.max_jobs, 4);
        assert_eq!(s.max_bytes, 1024);
        assert_eq!(s.max_queue_ms, 0.0);
    }

    // --- S4: host-supplied config -------------------------------------------

    #[test]
    fn config_absent_jobs_is_unbounded_bit_for_bit_s1() {
        // The arming switch is `__hbDecodeMaxJobs` ALONE. Bytes/reserve without
        // it must not bound anything, or an unauthored page silently changes.
        for raw in [
            (None, None, None),
            (None, Some(64.0 * 1048576.0), Some(2.0)),
            (Some(0.0), Some(1024.0), Some(1.0)),
            (Some(f64::NAN), None, None),
            (Some(-4.0), None, None),
        ] {
            let c = config_from_raw(raw.0, raw.1, raw.2, None, None);
            assert_eq!(c, DecodeConfig::UNBOUNDED, "raw {raw:?}");
        }
        // …and the gate built from it is the S1 gate.
        let a = config_from_raw(None, None, None, None, None).build();
        let mut held = Vec::new();
        for _ in 0..64 {
            held.push(block(a.admit(1 << 20)));
        }
        assert_eq!(a.stats().queued, 0);
    }

    #[test]
    fn config_armed_values_reach_the_gate() {
        let c = config_from_raw(Some(4.0), Some(192.0 * 1048576.0), Some(2.0), None, None);
        assert_eq!(
            (c.max_jobs, c.max_bytes, c.urgent_reserve),
            (4, 192 * 1048576, 2)
        );
        let s = c.build().stats();
        assert_eq!(s.max_jobs, 4);
        assert_eq!(s.max_bytes, 192 * 1048576);

        // Bytes omitted but jobs armed => count-only bound.
        let c = config_from_raw(Some(1.0), None, None, None, None);
        assert_eq!(
            (c.max_jobs, c.max_bytes, c.urgent_reserve),
            (1, usize::MAX, 0),
            "jobs alone is a legal (count-only) arming"
        );
        // Reserve is clamped to max_jobs-1 by `new` so the normal lane is never
        // fully starved: 1x8MiB+1 (the Arm-T shape) keeps one usable slot.
        let s = DecodeAdmission::new(1, 8 * 1048576, 1).stats();
        assert_eq!(s.max_jobs, 1);
    }

    #[test]
    fn urgent_reserve_accounting_under_a_bound() {
        // Arm-B shape at small scale: 4 jobs, 2 reserved for urgent.
        let a = DecodeAdmission::new(4, usize::MAX, 2);
        let n0 = block(a.admit(10));
        let _n1 = block(a.admit(10));
        // Normal lane is capped at max_jobs - urgent_reserve = 2.
        let mut n2 = Box::pin(a.admit(10));
        assert!(poll_once(&mut n2).is_none(), "normal lane stops at 2 of 4");
        assert_eq!(a.stats().queued, 1);

        // Both reserved slots are still reachable by the urgent lane.
        let u0 = block(a.admit_urgent(100));
        let u1 = block(a.admit_urgent(100));
        let s = a.stats();
        assert_eq!(s.live_jobs, 4);
        assert_eq!(s.live_bytes, 220);
        assert_eq!(s.urgent_admits, 2);
        assert_eq!(s.admits, 4);

        // A third urgent job has nothing left and parks (the reserve is a
        // reserve, not an exemption).
        let mut u2 = Box::pin(a.admit_urgent(100));
        assert!(poll_once(&mut u2).is_none());

        // Freeing an URGENT slot hands off to the urgent waiter at the FRONT,
        // never to the normal waiter parked earlier.
        drop(u0);
        let u2 = poll_once(&mut u2).expect("urgent waiter takes the freed urgent slot");
        assert!(poll_once(&mut n2).is_none(), "normal still below the reserve line");

        // Freeing a NORMAL slot is NOT enough: the normal lane's ceiling is
        // `max_jobs - urgent_reserve` on TOTAL live jobs, so with two urgent
        // jobs still running the normal waiter stays parked. That is the point
        // of a reserve — urgent occupancy is never billed to the normal lane's
        // budget, but it does consume the machine.
        drop(n0);
        assert_eq!(a.stats().live_jobs, 3);
        assert!(poll_once(&mut n2).is_none(), "3 live >= the normal ceiling of 2");

        // Drain the urgent lane and the normal waiter finally gets in.
        drop((u1, u2));
        let _n2 = poll_once(&mut n2).expect("normal lane re-opens once live drops below 2");
        let s = a.stats();
        assert_eq!(s.live_jobs, 2);
        assert_eq!(s.urgent_admits, 3);
        assert_eq!(s.peak_live_jobs, 4);
        assert!(s.queued >= 2, "an armed gate queues: {}", s.queued);
    }

    // --- S5: wasm-memory pressure hysteresis (§2.2 item 3) -------------------

    const MB: u64 = 1_048_576;

    /// 8 jobs / 1 MiB of estimate budget / 1 urgent slot, tripping at 100 MB
    /// and 200 MB of sampled linear memory.
    fn pressured() -> DecodeAdmission {
        DecodeAdmission::with_pressure(8, 1024, 1, 100 * MB, 200 * MB)
    }

    #[test]
    fn pressure_below_t1_leaves_full_caps() {
        let a = pressured();
        for sample in [0, 1, 50 * MB, 100 * MB] {
            a.pressure_input(sample);
            let s = a.stats();
            assert_eq!(s.pressure_level, 0, "sample {sample} must not trip T1");
            assert_eq!(s.effective_max_jobs, 8);
            assert_eq!(s.effective_max_bytes, 1024);
        }
        // …and the gate admits the full eight (7 normal + the urgent reserve).
        let mut held = Vec::new();
        for _ in 0..7 {
            held.push(block(a.admit(1)));
        }
        held.push(block(a.admit_urgent(1)));
        assert_eq!(a.stats().live_jobs, 8);
    }

    #[test]
    fn crossing_t1_halves_the_caps_for_newcomers_not_for_running_jobs() {
        let a = pressured();
        // Fill to the un-pressured normal cap (8 - 1 reserved = 7).
        let mut held: Vec<DecodeLease> = (0..7).map(|_| block(a.admit(1))).collect();
        assert_eq!(a.stats().live_jobs, 7);

        a.pressure_input(150 * MB);
        let s = a.stats();
        assert_eq!(s.pressure_level, 1);
        assert_eq!(s.effective_max_jobs, 4, "8 / 2");
        assert_eq!(s.effective_max_bytes, 512, "1024 / 2");
        assert_eq!(s.max_jobs, 8, "the CONFIGURED cap is not rewritten");

        // Running jobs are not evicted — the gate has no such power — but they
        // are now over the new cap, so the next newcomer parks…
        assert_eq!(a.stats().live_jobs, 7, "already-admitted work runs on");
        let mut newcomer = Box::pin(a.admit(1));
        assert!(poll_once(&mut newcomer).is_none(), "newcomer sees the new cap");

        // …and stays parked until live drops below the HALVED normal cap of 3,
        // i.e. four drains, not one.
        for _ in 0..4 {
            held.pop();
            assert!(poll_once(&mut newcomer).is_none(), "still ≥ 3 live");
        }
        assert_eq!(a.stats().live_jobs, 3);
        held.pop();
        let _n = poll_once(&mut newcomer).expect("2 live < the halved normal cap of 3");
    }

    #[test]
    fn crossing_t2_quarters_the_caps_min_one() {
        let a = pressured();
        a.pressure_input(500 * MB);
        let s = a.stats();
        assert_eq!(s.pressure_level, 2);
        assert_eq!(s.effective_max_jobs, 2, "8 / 4");
        assert_eq!(s.effective_max_bytes, 256, "1024 / 4");

        // Floor of 1: a cap of 0 would wedge the gate shut forever, and the
        // monotone level means "forever" is not an exaggeration.
        let tiny = DecodeAdmission::with_pressure(2, 3, 0, MB, 2 * MB);
        tiny.pressure_input(9 * MB);
        let s = tiny.stats();
        assert_eq!(s.pressure_level, 2);
        assert_eq!(s.effective_max_jobs, 1, "2 / 4 floors at 1, never 0");
        assert_eq!(s.effective_max_bytes, 1, "3 / 4 floors at 1, never 0");
        let _l = block(tiny.admit(0));
        assert_eq!(tiny.stats().live_jobs, 1, "a quartered gate still admits");
    }

    #[test]
    fn pressure_level_is_monotone_because_the_signal_is() {
        let a = pressured();
        a.pressure_input(250 * MB);
        assert_eq!(a.stats().pressure_level, 2);
        // `wasm_memory_bytes()` is a HIGH-WATER MARK: it cannot actually fall,
        // and a host that reports a smaller number (a fresh instance, a relay
        // mixing the two instances' samples, a rounding artefact) must NOT be
        // able to re-open the gate. If this ever fails, someone has started
        // treating the sample as live occupancy.
        for sample in [150 * MB, 50 * MB, 0] {
            a.pressure_input(sample);
            assert_eq!(
                a.stats().pressure_level,
                2,
                "level fell after a smaller sample ({sample}) — the monotone \
                 ratchet has been broken; wasm memory NEVER shrinks, so a \
                 falling sample is noise, not recovery"
            );
            assert_eq!(a.stats().effective_max_jobs, 2);
        }
    }

    #[test]
    fn urgent_reserve_is_untouched_at_every_pressure_level() {
        // Reserve 1 of 8: still 1 at level 1 (4 jobs) and level 2 (2 jobs), so
        // the urgent lane keeps a slot the normal lane can never take. It is
        // never SCALED — starvation safety beats memory at the margin.
        for (sample, jobs, normal_cap) in [(0u64, 8usize, 7usize), (150 * MB, 4, 3), (250 * MB, 2, 1)]
        {
            let a = pressured();
            a.pressure_input(sample);
            assert_eq!(a.stats().effective_max_jobs, jobs);

            let _held: Vec<DecodeLease> = (0..normal_cap).map(|_| block(a.admit(0))).collect();
            let mut over = Box::pin(a.admit(0));
            assert!(
                poll_once(&mut over).is_none(),
                "normal lane must stop at {normal_cap} under sample {sample}"
            );
            // The reserved slot is still there for the urgent lane.
            let _u = block(a.admit_urgent(0));
            let s = a.stats();
            assert_eq!(s.live_jobs, normal_cap + 1);
            assert_eq!(s.urgent_admits, 1);
        }
    }

    #[test]
    fn default_thresholds_are_inert_and_the_sampler_is_rate_limited() {
        // `new` ⇒ u64::MAX thresholds ⇒ even an absurd sample changes nothing,
        // and the closure is never even called (comparison is strictly `>`).
        let a = DecodeAdmission::new(4, 1024, 1);
        a.pressure_input(u64::MAX);
        assert_eq!(a.stats().pressure_level, 0);
        let mut calls = 0u32;
        for _ in 0..10 {
            a.maybe_sample_pressure(|| {
                calls += 1;
                u64::MAX
            });
        }
        assert_eq!(calls, 0, "an inert gate must not pay for the JS sample");

        // Armed: the first call samples, the rest are inside the 250 ms window.
        let b = pressured();
        let mut calls = 0u32;
        for _ in 0..10 {
            b.maybe_sample_pressure(|| {
                calls += 1;
                150 * MB
            });
        }
        assert_eq!(calls, 1, "at most one sample per {PRESSURE_SAMPLE_INTERVAL_MS} ms");
        assert_eq!(b.stats().pressure_level, 1, "the one sample did land");
    }

    #[test]
    fn config_parses_pressure_thresholds_in_megabytes() {
        // `?decodePressure=1024:1536` shape, alongside an armed cap.
        let c = config_from_raw(Some(4.0), None, Some(1.0), Some(1024.0), Some(1536.0));
        assert_eq!(c.max_jobs, 4);
        assert_eq!(c.t1_bytes, 1024 * MB);
        assert_eq!(c.t2_bytes, 1536 * MB);

        // Absent / garbage ⇒ inert, and inert is the DEFAULT.
        for raw in [
            (None, None),
            (Some(0.0), Some(0.0)),
            (Some(-1.0), Some(f64::NAN)),
            (Some(f64::INFINITY), None),
        ] {
            let c = config_from_raw(Some(4.0), None, None, raw.0, raw.1);
            assert_eq!((c.t1_bytes, c.t2_bytes), (u64::MAX, u64::MAX), "raw {raw:?}");
        }
        assert_eq!(
            config_from_raw(None, None, None, None, None),
            DecodeConfig::UNBOUNDED
        );

        // Thresholds are independent of the arming switch, and remain neutral
        // on an unarmed gate because usize::MAX/4 is still unbounded.
        let c = config_from_raw(None, None, None, Some(1.0), Some(2.0));
        assert_eq!(c.max_jobs, usize::MAX);
        let a = c.build();
        a.pressure_input(64 * MB);
        assert_eq!(a.stats().pressure_level, 2);
        let mut held = Vec::new();
        for _ in 0..64 {
            held.push(block(a.admit(1 << 20)));
        }
        assert_eq!(a.stats().queued, 0, "quartered infinity is still unbounded");

        // A swapped pair degrades to one step rather than to nonsense.
        let s = config_from_raw(Some(4.0), None, None, Some(200.0), Some(100.0))
            .build()
            .stats();
        assert_eq!(s.pressure_level, 0);
        let a = config_from_raw(Some(4.0), None, None, Some(200.0), Some(100.0)).build();
        a.pressure_input(250 * MB);
        assert_eq!(a.stats().pressure_level, 2, "t2 clamped up to t1");
        assert_eq!(a.stats().effective_max_jobs, 1);
    }
}
