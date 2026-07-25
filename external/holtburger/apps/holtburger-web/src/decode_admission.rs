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

struct Waiter {
    tx: oneshot::Sender<()>,
    bytes: usize,
    urgent: bool,
}

struct Inner {
    max_jobs: usize,
    max_bytes: usize,
    urgent_reserve: usize,

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
    /// Job cap visible to the lane. The normal lane may never consume the
    /// private urgent reserve; the urgent lane sees the whole cap.
    fn job_cap(&self, urgent: bool) -> usize {
        if urgent {
            self.max_jobs
        } else {
            self.max_jobs.saturating_sub(self.urgent_reserve)
        }
    }

    fn can_admit(&self, bytes: usize, urgent: bool) -> bool {
        if self.live_jobs >= self.job_cap(urgent) {
            return false;
        }
        // `live_jobs == 0` escape: a lone job bigger than the whole byte budget
        // must still run, or the gate wedges permanently.
        self.live_bytes.saturating_add(bytes) <= self.max_bytes || self.live_jobs == 0
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
        Self {
            inner: Arc::new(Mutex::new(Inner {
                max_jobs: max_jobs.max(1),
                max_bytes,
                urgent_reserve: urgent_reserve.min(max_jobs.saturating_sub(1)),
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

    pub fn stats(&self) -> AdmissionStats {
        let g = self.lock();
        AdmissionStats {
            max_jobs: g.max_jobs,
            max_bytes: g.max_bytes,
            live_jobs: g.live_jobs,
            live_bytes: g.live_bytes,
            peak_live_jobs: g.peak_live_jobs,
            peak_live_bytes: g.peak_live_bytes,
            admits: g.admits,
            queued: g.queued,
            max_queue_ms: g.max_queue_ms,
            urgent_admits: g.urgent_admits,
            pressure_level: 0,
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
//
// `__hbDecodeMaxJobs` is the arming switch: with it absent the whole gate stays
// at `(usize::MAX, usize::MAX, 0)`, which can never enqueue a waiter, so an
// unauthored page is bit-for-bit the S1 behaviour.

/// Pure resolution of the three raw JS values into `DecodeAdmission::new`
/// arguments. Split out from the `js_sys` read so it is testable natively.
pub fn config_from_raw(
    jobs: Option<f64>,
    bytes: Option<f64>,
    reserve: Option<f64>,
) -> (usize, usize, usize) {
    let max_jobs = match jobs {
        Some(n) if n >= 1.0 && n.is_finite() => n as usize,
        // Not armed: byte/reserve values alone never bound anything, because a
        // job larger than `max_bytes` is admitted when nothing is live.
        _ => return (usize::MAX, usize::MAX, 0),
    };
    let max_bytes = match bytes {
        Some(n) if n >= 1.0 && n.is_finite() => n as usize,
        _ => usize::MAX,
    };
    let urgent_reserve = match reserve {
        Some(n) if n >= 1.0 && n.is_finite() => n as usize,
        _ => 0,
    };
    (max_jobs, max_bytes, urgent_reserve)
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
    let (jobs, bytes, reserve) = config_from_raw(
        num("__hbDecodeMaxJobs"),
        num("__hbDecodeMaxBytes"),
        num("__hbDecodeUrgentReserve"),
    );
    DecodeAdmission::new(jobs, bytes, reserve)
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
            let (j, b, r) = config_from_raw(raw.0, raw.1, raw.2);
            assert_eq!((j, b, r), (usize::MAX, usize::MAX, 0), "raw {raw:?}");
        }
        // …and the gate built from it is the S1 gate.
        let (j, b, r) = config_from_raw(None, None, None);
        let a = DecodeAdmission::new(j, b, r);
        let mut held = Vec::new();
        for _ in 0..64 {
            held.push(block(a.admit(1 << 20)));
        }
        assert_eq!(a.stats().queued, 0);
    }

    #[test]
    fn config_armed_values_reach_the_gate() {
        let (j, b, r) = config_from_raw(Some(4.0), Some(192.0 * 1048576.0), Some(2.0));
        assert_eq!((j, b, r), (4, 192 * 1048576, 2));
        let s = DecodeAdmission::new(j, b, r).stats();
        assert_eq!(s.max_jobs, 4);
        assert_eq!(s.max_bytes, 192 * 1048576);

        // Bytes omitted but jobs armed => count-only bound.
        assert_eq!(
            config_from_raw(Some(1.0), None, None),
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
}
