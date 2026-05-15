//! F.37 walk-result dedup primitive — a thread-local map of
//! `(cache_key) → Shared<Future<Result<T, E>>>` that lets concurrent
//! invocations with the same cache key share a single underlying
//! future.
//!
//! Architectural twin of `holtburger-resource-http::inflight::InflightMap`
//! (F.35). InflightMap dedups concurrent HTTP fetches by URL;
//! WalkDedupMap dedups concurrent walks by `(export, args)`.
//!
//! The primitive is generic over the future output type so it can
//! be unit-tested natively without wasm32/JsValue dependencies.
//! Wasm32 use lives in the `prefetch` module which instantiates it
//! over `Result<(), JsValue>`.
//!
//! # Correctness invariants
//!
//! 1. The map borrow is **never held across `.await`**. Phase 1
//!    (latch-or-start) and phase 3 (cleanup) borrow it briefly;
//!    phase 2 (await) runs unborrowed.
//! 2. `Shared` requires `Output: Clone`. The caller's `T` and `E`
//!    must be `Clone`.
//! 3. On error the entry is removed so a transient failure
//!    doesn't latch.
//! 4. On wasm32 the future is `!Send`; the unsafe-Send shim mirrors
//!    `inflight::InflightMap`'s pattern.

use std::cell::RefCell;
use std::collections::HashMap;
use std::hash::Hash;

use futures::FutureExt;
use futures::future::Shared;

// `WalkCacheKey` is defined in `prefetch.rs`; the dedup primitive
// itself is key-type-generic so it can be unit-tested without
// pulling that key into the test fixture.

#[cfg(not(target_arch = "wasm32"))]
type DedupInnerFuture<T, E> = futures::future::BoxFuture<'static, Result<T, E>>;

#[cfg(target_arch = "wasm32")]
type DedupInnerFuture<T, E> = futures::future::LocalBoxFuture<'static, Result<T, E>>;

type DedupFuture<T, E> = Shared<DedupInnerFuture<T, E>>;

/// `(cache_key) → Shared<Future>` map. Concurrent callers passing
/// the same key share a single underlying future. After the future
/// resolves the entry is dropped so the map doesn't grow
/// unboundedly and a transient error doesn't latch.
pub struct WalkDedupMapT<K, T, E>
where
    K: Eq + Hash,
{
    map: RefCell<HashMap<K, DedupFuture<T, E>>>,
}

// The wasm-bindgen module that drives wasm32 use of this primitive
// is single-threaded; the unsafe Send/Sync mirrors
// `inflight::InflightMap`'s recipe — required to satisfy static
// trait bounds (e.g. `ResourceSource: Send + Sync`) inherited from
// upstream consumers without actually crossing threads.
#[cfg(target_arch = "wasm32")]
unsafe impl<K: Eq + Hash, T, E> Send for WalkDedupMapT<K, T, E> {}
#[cfg(target_arch = "wasm32")]
unsafe impl<K: Eq + Hash, T, E> Sync for WalkDedupMapT<K, T, E> {}

impl<K, T, E> Default for WalkDedupMapT<K, T, E>
where
    K: Eq + Hash,
{
    fn default() -> Self {
        Self::new()
    }
}

// Constructors don't need the `Clone` bounds — only `get_or_install`
// + `cleanup_resolved` do, because those are where `Shared`'s
// `Output: Clone` constraint bites.
impl<K, T, E> WalkDedupMapT<K, T, E>
where
    K: Eq + Hash,
{
    pub fn new() -> Self {
        Self {
            map: RefCell::new(HashMap::new()),
        }
    }
}

impl<K, T, E> WalkDedupMapT<K, T, E>
where
    K: Eq + Hash + Clone,
    T: Clone,
    E: Clone,
{

    /// Look up an existing in-flight `Shared` future for `key`, or
    /// install a new one built from `factory`. Returns the
    /// `Shared` future for the caller to `.await`.
    ///
    /// The factory closure runs at most once per key while a
    /// future is in flight — concurrent callers passing the same
    /// key all observe the same single shared future. Once the
    /// future resolves, callers should call
    /// [`cleanup_resolved`](Self::cleanup_resolved) to remove the
    /// entry (or it stays forever, which would defeat the dedup +
    /// error-non-latching invariants).
    pub fn get_or_install<F>(&self, key: &K, factory: F) -> DedupFuture<T, E>
    where
        F: FnOnce() -> DedupInnerFuture<T, E>,
    {
        let mut guard = self.map.borrow_mut();
        if let Some(existing) = guard.get(key) {
            return existing.clone();
        }
        let fut = factory();
        let shared = fut.shared();
        guard.insert(key.clone(), shared.clone());
        shared
    }

    /// Remove the entry for `key` if (a) it's present and (b) the
    /// stored `Shared` has resolved. The resolved check avoids a
    /// TOCTOU race where caller A finishes await + cleanup while
    /// caller B is still installing a fresh future for the same
    /// key — caller A would otherwise rip B's future out from
    /// under it. `Shared::peek().is_some()` proves the stored
    /// future is the same one that just completed.
    pub fn cleanup_resolved(&self, key: &K) {
        let mut guard = self.map.borrow_mut();
        if let Some(existing) = guard.get(key) {
            if existing.peek().is_some() {
                guard.remove(key);
            }
        }
    }

    /// Number of keys currently in flight. Test/diagnostics only.
    #[allow(dead_code)]
    pub fn in_flight_count(&self) -> usize {
        self.map.borrow().len()
    }
}

// ============================================================
// Specialization used by the wasm-bindgen prefetch module:
// `K = WalkCacheKey`, `T = ()`, `E = JsValue` on wasm32; on native
// the same type is reachable for testing through a `()` error
// type so the unit tests can run without wasm-bindgen.
// ============================================================

#[cfg(target_arch = "wasm32")]
pub type WalkDedupMap =
    WalkDedupMapT<crate::prefetch::WalkCacheKey, (), wasm_bindgen::JsValue>;

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    //! Native unit tests for the dedup primitive. The wasm32
    //! integration is exercised through the smoke harness; what
    //! these tests prove is that the dedup primitive itself does
    //! what F.37 says it should: N concurrent requesters for the
    //! same cache key all observe the same single underlying
    //! future.
    //!
    //! The tests use a `(String, String)` key type (a stripped
    //! analogue of `WalkCacheKey`) and `String` error so they
    //! compile without wasm-bindgen. The wasm32 instantiation
    //! over `(WalkCacheKey, (), JsValue)` is type-identical aside
    //! from the BoxFuture / LocalBoxFuture future shape.
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use tokio::sync::Barrier;

    // Test-fixture key type. Real wasm32 use binds `WalkCacheKey`.
    type TestKey = (String, Vec<u32>);

    #[tokio::test]
    async fn single_caller_runs_factory_once() {
        let map: WalkDedupMapT<TestKey, Vec<u8>, String> = WalkDedupMapT::new();
        let counter = Arc::new(AtomicUsize::new(0));
        let key: TestKey = ("export-A".to_string(), vec![0x1234]);

        let counter_for_factory = counter.clone();
        let shared = map.get_or_install(&key, move || {
            Box::pin(async move {
                counter_for_factory.fetch_add(1, Ordering::SeqCst);
                Ok::<_, String>(vec![1, 2, 3])
            })
        });
        let result = shared.await;
        map.cleanup_resolved(&key);

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), vec![1, 2, 3]);
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        assert_eq!(map.in_flight_count(), 0, "entry should be cleaned up");
    }

    #[tokio::test]
    async fn ten_concurrent_callers_share_one_factory() {
        // The load-bearing test for F.37. 10 concurrent tasks
        // each ask for the same cache key. The mock factory
        // counter should reach exactly 1 — i.e. the underlying
        // walk-loop ran once, all 10 waiters latched on the
        // shared future. This mirrors F.35's
        // `ten_concurrent_callers_share_one_fetch` test at a
        // different layer.
        let map: Arc<WalkDedupMapT<TestKey, Vec<u8>, String>> =
            Arc::new(WalkDedupMapT::new());
        let counter = Arc::new(AtomicUsize::new(0));
        let key: TestKey = ("fetchBuildingPlacement".to_string(), vec![0x02_00_01_23]);
        let body = vec![0xAB, 0xCD, 0xEF];
        let barrier = Arc::new(Barrier::new(10));

        // Run all 10 callers in the same tokio task — the dedup
        // map's `RefCell` is `!Send`, so cross-task awaits would
        // panic on a multi-thread runtime. The barrier here just
        // proves the same-tick latch-or-start pattern: the first
        // call inserts, all subsequent calls clone. We don't
        // need separate tasks for that.
        //
        // Doing the latch in a single task with `join_all` is the
        // exact mirror of the wasm32 use case where a single
        // event-loop tick fires N concurrent
        // `ensure_walk_prefetched_keyed` calls.
        let mut sharededs = Vec::new();
        for _ in 0..10 {
            let counter = counter.clone();
            let body_outer = body.clone();
            let shared = map.get_or_install(&key, move || {
                Box::pin(async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    Ok::<_, String>(body_outer)
                })
            });
            sharededs.push(shared);
        }
        // The factory only runs when the future is polled. Drive
        // them all concurrently via `join_all`.
        let results = futures::future::join_all(sharededs.into_iter()).await;
        map.cleanup_resolved(&key);
        // The `barrier` is unused in this single-task variant —
        // kept in scope so future readers see the synchronisation
        // primitive they'd reach for in a multi-task test.
        let _ = barrier;

        for result in results {
            assert!(result.is_ok());
            assert_eq!(result.unwrap(), body);
        }

        assert_eq!(
            counter.load(Ordering::SeqCst),
            1,
            "underlying factory should have run exactly once for 10 concurrent waiters",
        );
        assert_eq!(map.in_flight_count(), 0, "map should be empty after cleanup");
    }

    #[tokio::test]
    async fn distinct_keys_run_independently() {
        // 4 unique keys across 10 concurrent callers (some
        // sharing). The dedup should give exactly 4 factory
        // invocations.
        let map: Arc<WalkDedupMapT<TestKey, Vec<u8>, String>> =
            Arc::new(WalkDedupMapT::new());
        let counter = Arc::new(AtomicUsize::new(0));
        let assignments: Vec<(TestKey, Vec<u8>)> = vec![
            (("exportA".to_string(), vec![1]), vec![0xAA]),
            (("exportA".to_string(), vec![1]), vec![0xAA]),
            (("exportA".to_string(), vec![1]), vec![0xAA]),
            (("exportB".to_string(), vec![2]), vec![0xBB]),
            (("exportB".to_string(), vec![2]), vec![0xBB]),
            (("exportC".to_string(), vec![3]), vec![0xCC]),
            (("exportC".to_string(), vec![3]), vec![0xCC]),
            (("exportC".to_string(), vec![3]), vec![0xCC]),
            (("exportD".to_string(), vec![4]), vec![0xDD]),
            (("exportD".to_string(), vec![4]), vec![0xDD]),
        ];

        let mut futures_vec = Vec::new();
        for (key, body) in &assignments {
            let counter = counter.clone();
            let body_outer = body.clone();
            let shared = map.get_or_install(key, move || {
                Box::pin(async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    Ok::<_, String>(body_outer)
                })
            });
            futures_vec.push((shared, body.clone()));
        }
        let results =
            futures::future::join_all(futures_vec.into_iter().map(|(s, b)| async move {
                let r = s.await;
                (r, b)
            }))
            .await;
        for key in assignments.iter().map(|(k, _)| k.clone()).collect::<std::collections::HashSet<_>>() {
            map.cleanup_resolved(&key);
        }

        for (result, expected) in results {
            assert!(result.is_ok());
            assert_eq!(result.unwrap(), expected);
        }

        assert_eq!(
            counter.load(Ordering::SeqCst),
            4,
            "4 unique keys across 10 concurrent callers → exactly 4 factory invocations",
        );
    }

    #[tokio::test]
    async fn error_does_not_latch() {
        // A failed loop should NOT permanently latch the key to
        // an error result. After the first call returns Err, a
        // second call should be free to retry.
        let map: WalkDedupMapT<TestKey, Vec<u8>, String> = WalkDedupMapT::new();
        let counter = Arc::new(AtomicUsize::new(0));
        let key: TestKey = ("export-fail".to_string(), vec![0x99]);

        let counter_for_factory_1 = counter.clone();
        let shared1 = map.get_or_install(&key, move || {
            Box::pin(async move {
                counter_for_factory_1.fetch_add(1, Ordering::SeqCst);
                Err::<Vec<u8>, _>("boom".to_string())
            })
        });
        let result1 = shared1.await;
        map.cleanup_resolved(&key);

        assert!(result1.is_err());
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        assert_eq!(map.in_flight_count(), 0, "entry cleaned after error");

        let counter_for_factory_2 = counter.clone();
        let shared2 = map.get_or_install(&key, move || {
            Box::pin(async move {
                counter_for_factory_2.fetch_add(1, Ordering::SeqCst);
                Ok::<_, String>(vec![1, 2, 3])
            })
        });
        let result2 = shared2.await;
        map.cleanup_resolved(&key);

        assert!(result2.is_ok());
        assert_eq!(
            counter.load(Ordering::SeqCst),
            2,
            "second call should re-run the factory (no latch)",
        );
    }

    #[tokio::test]
    async fn sequential_calls_each_run_factory() {
        // Sanity: this is a dedup primitive, NOT a persistent
        // cache. Once a future resolves and the entry is cleaned
        // up, a subsequent call re-runs the factory.
        let map: WalkDedupMapT<TestKey, Vec<u8>, String> = WalkDedupMapT::new();
        let counter = Arc::new(AtomicUsize::new(0));
        let key: TestKey = ("export-seq".to_string(), vec![0]);

        for _ in 0..3 {
            let counter_clone = counter.clone();
            let shared = map.get_or_install(&key, move || {
                Box::pin(async move {
                    counter_clone.fetch_add(1, Ordering::SeqCst);
                    Ok::<_, String>(vec![1])
                })
            });
            let _ = shared.await;
            map.cleanup_resolved(&key);
        }
        assert_eq!(
            counter.load(Ordering::SeqCst),
            3,
            "sequential calls should each re-run the factory",
        );
    }

    #[tokio::test]
    async fn high_concurrency_overlap_dedups() {
        // Proxy for the F.37 drain-time gate. Mirrors the
        // real-world scenario: 119 concurrent entity spawns,
        // each requiring an overlapping set of ~25 unique
        // setups. Without dedup: 119 × 25 = 2975 factory
        // invocations. With dedup: at most 25.
        //
        // The factories are non-trivial (50 ms simulated work)
        // so all 119 callers genuinely overlap in time.
        let map: Arc<WalkDedupMapT<TestKey, u32, String>> = Arc::new(WalkDedupMapT::new());
        let counter = Arc::new(AtomicUsize::new(0));
        let unique_keys = 25usize;
        let total_invocations = 119usize;

        let mut handles = Vec::new();
        for i in 0..total_invocations {
            let counter = counter.clone();
            let key_idx = (i % unique_keys) as u32;
            let key: TestKey = (
                "fetchEntityAnimationKeyframes".to_string(),
                vec![key_idx],
            );
            let shared = map.get_or_install(&key, move || {
                Box::pin(async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    Ok::<_, String>(key_idx)
                })
            });
            handles.push((shared, key, key_idx));
        }
        let results = futures::future::join_all(
            handles
                .into_iter()
                .map(|(s, k, expected)| async move { (s.await, k, expected) }),
        )
        .await;

        // Cleanup all unique keys.
        for i in 0..unique_keys {
            let key: TestKey = (
                "fetchEntityAnimationKeyframes".to_string(),
                vec![i as u32],
            );
            map.cleanup_resolved(&key);
        }

        for (result, _, expected) in results {
            assert!(result.is_ok());
            assert_eq!(result.unwrap(), expected);
        }

        let actual = counter.load(Ordering::SeqCst);
        // F.36's scenario: 25 unique setups × ~119 entities = ~25
        // walks instead of ~119 (≥4× reduction).
        assert_eq!(
            actual, unique_keys,
            "F.37 dedup: {total_invocations} concurrent callers × {unique_keys} unique keys → expected {unique_keys} factory invocations, got {actual}",
        );
    }

    #[tokio::test]
    async fn no_overlap_window_runs_each_factory() {
        // Counterpart to the drain test: if a future resolves
        // before the next caller arrives, there's nothing to
        // dedup. After cleanup, the next call re-runs the
        // factory. This documents that semantic (the caller's
        // own cache — e.g. JS-side `animationCache` — handles
        // persistent caching; this map is in-flight-only).
        let map: WalkDedupMapT<TestKey, Vec<u8>, String> = WalkDedupMapT::new();
        let counter = Arc::new(AtomicUsize::new(0));
        let key: TestKey = ("export-no-overlap".to_string(), vec![0]);

        for _ in 0..5 {
            let counter_clone = counter.clone();
            let shared = map.get_or_install(&key, move || {
                Box::pin(async move {
                    counter_clone.fetch_add(1, Ordering::SeqCst);
                    Ok::<_, String>(vec![1])
                })
            });
            let _ = shared.await;
            map.cleanup_resolved(&key);
        }
        assert_eq!(
            counter.load(Ordering::SeqCst),
            5,
            "non-overlapping sequential calls should each re-run the factory",
        );
    }
}

