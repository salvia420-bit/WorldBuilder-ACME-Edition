//! Async counting semaphore — bounds the number of concurrent shard
//! `fetch_bytes` calls a single resource source has in flight.
//!
//! Why this exists (F1, stutter fix 2026-06-01): the per-LB prefetch
//! fan-out fired every distinct shard URL at once via `try_join_all`,
//! and 8+ overlapping `prefetch()` calls (the terrain / statics /
//! scenery / buildings bakers in `handlePositionUpdate`) stacked to a
//! measured peak of 218 concurrent fetches against an HTTP/1.1 dev
//! server (6 connections/origin), so a shard the player needs *now*
//! waited in a ~200-deep browser queue (slowest in-window fetches
//! reached ~38 s → late asset pop-in + decode-burst hitches).
//!
//! Bounding each `prefetch()` call independently does NOT bound the
//! global peak (the *overlap* is the problem), so the limiter lives on
//! the source instance and is acquired *inside* each fetch closure —
//! deduped waiters latch onto the in-flight `Shared` future via
//! `InflightMap` without consuming a permit.
//!
//! NOT "one per page" (defect 3, 2026-07-24): the page runs TWO wasm
//! instances — main thread + bake worker — and each calls
//! `init_resource_source`, so each mints its own `Semaphore`. Read
//! literally, that made the real page-wide ceiling 2×32 = 64 and half
//! defeated this fix. The budget is now SPLIT in JS before either
//! instance connects (`applyFetchConcurrencySplit()` in
//! `scene3d/bake_worker_client.js`): the main instance keeps the larger
//! share, the worker's share rides its `init` message, and the two sum
//! to [`DEFAULT_FETCH_CONCURRENCY`] (or the authored
//! `__hbFetchConcurrency`). The permit count below is therefore a
//! PER-INSTANCE share, not the page cap.
//!
//! Single-thread note: under wasm32 the executor is single-threaded,
//! but the primitive uses `Arc<Mutex<_>>` + `oneshot` (not `Rc`) so the
//! futures it produces stay `Send` and the native `tokio` unit tests
//! below exercise real cross-task contention. The mutex is never held
//! across an `.await` (mirrors the `InflightMap` invariant).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use futures::channel::oneshot;

/// Default global cap on concurrent shard fetches per resource source.
/// Well above the HTTP/1.1 per-origin ceiling (6) so interleaved
/// entity-surface fetches are never starved behind a bulk terrain/scenery
/// load (an N of 8 was measured to collapse spawn throughput), yet far
/// below the unbounded ~218 burst so the browser request queue stays
/// shallow. Override at runtime via `globalThis.__hbFetchConcurrency`
/// (read by `configured_fetch_concurrency` in `manifest_source`).
pub const DEFAULT_FETCH_CONCURRENCY: usize = 32;

struct Inner {
    permits: usize,
    waiters: VecDeque<oneshot::Sender<()>>,
}

/// A FIFO async counting semaphore. Cheap to clone (shares one `Arc`).
#[derive(Clone)]
pub struct Semaphore {
    inner: Arc<Mutex<Inner>>,
}

/// RAII permit; the slot is handed to the next waiter (or returned to
/// the pool) on drop.
pub struct SemaphorePermit {
    inner: Arc<Mutex<Inner>>,
}

impl Semaphore {
    pub fn new(permits: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                permits: permits.max(1),
                waiters: VecDeque::new(),
            })),
        }
    }

    /// Acquire one permit, parking the task (without blocking the
    /// executor) until one is free. Releases on drop of the returned
    /// guard.
    pub async fn acquire(&self) -> SemaphorePermit {
        // Fast path / enqueue under the lock; the lock is dropped before
        // the `.await` so it is never held across a suspension point.
        let rx = {
            let mut g = self.inner.lock().expect("semaphore mutex poisoned");
            if g.permits > 0 {
                g.permits -= 1;
                return SemaphorePermit {
                    inner: self.inner.clone(),
                };
            }
            let (tx, rx) = oneshot::channel();
            g.waiters.push_back(tx);
            rx
        };
        // A dropping permit hands its slot to us via `send(())` WITHOUT
        // returning the slot to the pool, so on success the slot is
        // already ours. `Err` means the source (and its waiter queue)
        // was torn down — return a best-effort permit; the count is moot.
        let _ = rx.await;
        SemaphorePermit {
            inner: self.inner.clone(),
        }
    }
}

impl Drop for SemaphorePermit {
    fn drop(&mut self) {
        let mut g = self.inner.lock().expect("semaphore mutex poisoned");
        // Hand the slot directly to the next live waiter; skip any whose
        // receiver was dropped (a cancelled `acquire`). If none remain,
        // return the permit to the pool.
        while let Some(tx) = g.waiters.pop_front() {
            if tx.send(()).is_ok() {
                return;
            }
        }
        g.permits += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn never_exceeds_permit_count() {
        const N: usize = 4;
        const TASKS: usize = 60;
        let sem = Semaphore::new(N);
        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..TASKS {
            let sem = sem.clone();
            let live = live.clone();
            let peak = peak.clone();
            handles.push(tokio::spawn(async move {
                let _p = sem.acquire().await;
                let cur = live.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(cur, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(2)).await;
                live.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        assert!(
            peak.load(Ordering::SeqCst) <= N,
            "peak {} exceeded cap {}",
            peak.load(Ordering::SeqCst),
            N
        );
        assert_eq!(live.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn all_waiters_eventually_complete() {
        let sem = Semaphore::new(2);
        let done = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..25 {
            let sem = sem.clone();
            let done = done.clone();
            handles.push(tokio::spawn(async move {
                let _p = sem.acquire().await;
                done.fetch_add(1, Ordering::SeqCst);
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        assert_eq!(done.load(Ordering::SeqCst), 25);
    }
}
