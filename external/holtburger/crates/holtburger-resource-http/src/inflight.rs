//! In-flight URL-fetch dedup primitive — F.35.
//!
//! Background. `ManifestResourceSource::prefetch` (both v1 and v2)
//! ran a `try_join_all` over per-URL `fetch_bytes` calls. When N
//! concurrent callers each invoked `prefetch(keys)` with overlapping
//! URLs (e.g. 119 entity-rig spawns sharing ~50 mesh URLs), each
//! caller independently fired its own copy of the per-URL fetch.
//! Browser HTTP/1.1's per-host 6-connection cap then queued the
//! redundant duplicates — ~600 GETs for ~50 unique URLs, 13-second
//! drain times observed (D-polish, Phase E, F.D).
//!
//! Fix. A process-global (per-source-instance) URL → in-flight-future
//! map. `get_or_fetch(url, factory)`:
//!   - Acquires the map mutex briefly, looks up the URL.
//!   - If present, clones the existing `Shared` future and awaits it
//!     (so a single underlying fetch resolves all waiters).
//!   - If absent, builds a `Shared` future from the supplied factory,
//!     stores it, then awaits.
//!   - On completion (Ok or Err), removes the entry so future
//!     prefetches re-fetch and a transient failure doesn't latch.
//!
//! Critical correctness invariants
//! --------------------------------
//! 1. The mutex is `std::sync::Mutex` and is **never held across an
//!    `.await`**. We acquire it twice per call — once to insert/lookup
//!    the future at start, once at end to remove on completion.
//! 2. `futures::future::Shared` requires `Future::Output: Clone`.
//!    `HttpError` doesn't implement `Clone`, so the inflight map
//!    stores `Result<Vec<u8>, Arc<E>>`. The caller unwraps the
//!    `Arc` and folds it back into `PrefetchError::Http` at the
//!    call site.
//! 3. On error, the entry is **removed** before propagating, so a
//!    transient failure doesn't permanently latch the URL to a
//!    failed result. The next prefetch retries.
//! 4. On wasm32 the underlying `fetch_bytes` future is NOT `Send`
//!    (it captures `js_sys::Object` and `JsFuture`'s
//!    `Rc<RefCell<Inner>>`). The trait `ResourceSource: Send + Sync`
//!    is a static bound only — wasm32 is single-threaded so no
//!    actual cross-thread access happens. We therefore use
//!    `LocalBoxFuture` (no `Send`) and an `unsafe impl Send + Sync`
//!    on the map wrapper, gated on `cfg(target_arch = "wasm32")`.
//!    Native test builds use the real `Send`-bound `BoxFuture` so
//!    cargo-test miri-style checks still cover the dedup logic.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::Shared;

// ---------------------------------------------------------------
// `MaybeSend` future type — `BoxFuture` on native, `LocalBoxFuture`
// on wasm32. Both wrap `Pin<Box<dyn Future>>`; the difference is the
// `Send` bound. `Shared` over the local variant is not itself `Send`,
// which is why the `InflightMap` wrapper below applies the
// unsafe-Send shim only when `cfg(target_arch = "wasm32")`.
// ---------------------------------------------------------------

#[cfg(not(target_arch = "wasm32"))]
type InflightInnerFuture<E> =
    futures::future::BoxFuture<'static, InflightResult<E>>;

#[cfg(target_arch = "wasm32")]
type InflightInnerFuture<E> =
    futures::future::LocalBoxFuture<'static, InflightResult<E>>;

type InflightFuture<E> = Shared<InflightInnerFuture<E>>;

/// `Result` shape stored inside the dedup map. The `Arc<E>` wrap is
/// required because `Shared` demands `Future::Output: Clone`, and
/// `HttpError` (and most error types in this codebase) don't
/// derive `Clone`. Cloning the `Arc` is cheap; cloning a `Vec<u8>`
/// is fine because the existing `shards` cache already clones on
/// every `get_file_by_key` call.
pub type InflightResult<E> = Result<Vec<u8>, Arc<E>>;

/// Internal inner state. On native this is `Send + Sync` naturally
/// (its only fields are `Mutex<HashMap<String, Shared<BoxFuture>>>`
/// which is itself `Send + Sync` given the `BoxFuture` `Send` bound).
/// On wasm32 the inner future is not `Send`, so the wrapper applies
/// `unsafe impl Send + Sync` via [`InflightMap`] below — wasm32 is
/// single-threaded so the contract isn't actually exercised in
/// practice, the impl just satisfies static trait bounds inherited
/// from `ResourceSource: Send + Sync`.
struct InflightInner<E: 'static> {
    map: Mutex<HashMap<String, InflightFuture<E>>>,
}

impl<E: 'static> InflightInner<E> {
    fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
        }
    }
}

/// Process-local URL → in-flight-future map. One per
/// `ManifestResourceSource` instance.
///
/// Stores `BoxFuture` (native) / `LocalBoxFuture` (wasm32) because
/// the underlying `fetch_bytes` future is not nameable (returned by
/// `async fn`). `Shared` wraps it so multiple waiters can await the
/// same single in-flight fetch.
pub struct InflightMap<E: 'static> {
    inner: InflightInner<E>,
}

// SAFETY: OWNER-THREAD-CONFINED. The inner `JsFuture`/`Promise` types are
// genuinely `!Send` and cannot be made otherwise; this impl exists only to
// satisfy the static `Send + Sync` bounds inherited from
// `ResourceSource: Send + Sync`. It is sound because nothing ever touches this
// map from another thread:
//
//   - Today: wasm32 is single-threaded, so there IS no other thread.
//   - Under wasm-threads (SAB, §2.1): this map is reachable only through
//     `ManifestResourceSource`'s inherent async methods (`prefetch`,
//     `prefetch_urgent`, `connect`). Worker threads are handed a
//     `DecodeSource` (`apps/holtburger-web/src/decode_source.rs`, §2.1a)
//     instead — a type-erased handle exposing ONLY the synchronous
//     `ResourceSource` accessors, through which this map cannot be named.
//
// IF THAT CHANGES, THIS BECOMES UNSOUND AND THE COMPILER WILL NOT SAY SO.
// Do not hand an `Arc<ManifestResourceSource>` to a pool thread; do not drop
// the last `Arc` to one off the owner thread (that would run this map's
// destructor there). See `SCOPE-2.1-fetch-decode-boundary-2026-07-24.md` §1c.
#[cfg(target_arch = "wasm32")]
unsafe impl<E: 'static> Send for InflightInner<E> {}
#[cfg(target_arch = "wasm32")]
unsafe impl<E: 'static> Sync for InflightInner<E> {}

impl<E: 'static> Default for InflightMap<E> {
    fn default() -> Self {
        Self::new()
    }
}

impl<E: 'static> InflightMap<E> {
    pub fn new() -> Self {
        Self {
            inner: InflightInner::new(),
        }
    }

    /// Acquire the existing in-flight `Shared` future for `url` or
    /// build a new one from `factory`, await it, and return the
    /// result.
    ///
    /// Multiple concurrent callers passing the same `url` will all
    /// observe the same single underlying fetch — `factory` runs at
    /// most once per URL while a fetch is in flight. Once the future
    /// resolves the entry is removed, so the next `get_or_fetch`
    /// after completion will run `factory` again (i.e. this is a
    /// dedup primitive, not a persistent cache — long-lived caching
    /// is the caller's job via `self.shards`).
    ///
    /// `factory` returns a future producing
    /// `Result<Vec<u8>, E>`; the dedup layer maps `E` into
    /// `Arc<E>` internally so multiple waiters can clone the error
    /// arm without `E: Clone`. Each `Ok` `Vec<u8>` is cloned per
    /// waiter — same semantics as the existing `shards` cache.
    #[cfg(not(target_arch = "wasm32"))]
    pub async fn get_or_fetch<F, Fut>(&self, url: &str, factory: F) -> InflightResult<E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<u8>, E>> + Send + 'static,
        E: Send + Sync,
    {
        // Phase 1: latch-or-start. Briefly hold the mutex to look up
        // an existing future for this URL, or insert a new one.
        let shared: InflightFuture<E> = {
            let mut guard = self.inner.map.lock().expect("inflight map mutex poisoned");
            if let Some(existing) = guard.get(url) {
                existing.clone()
            } else {
                let fut = factory();
                let boxed: InflightInnerFuture<E> =
                    Box::pin(async move { fut.await.map_err(Arc::new) });
                let shared = boxed.shared();
                guard.insert(url.to_owned(), shared.clone());
                shared
            }
        };

        // Phase 2: await outside the mutex.
        let result = shared.await;

        // Phase 3: cleanup. Remove the entry so transient errors
        // don't latch and the map doesn't grow unboundedly.
        self.cleanup_resolved(url);

        result
    }

    /// wasm32 variant — same algorithm, drops the `Send` bound on
    /// the factory future. See module-level docs for why.
    #[cfg(target_arch = "wasm32")]
    pub async fn get_or_fetch<F, Fut>(&self, url: &str, factory: F) -> InflightResult<E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<u8>, E>> + 'static,
        E: 'static,
    {
        let shared: InflightFuture<E> = {
            let mut guard = self.inner.map.lock().expect("inflight map mutex poisoned");
            if let Some(existing) = guard.get(url) {
                existing.clone()
            } else {
                let fut = factory();
                let boxed: InflightInnerFuture<E> =
                    Box::pin(async move { fut.await.map_err(Arc::new) });
                let shared = boxed.shared();
                guard.insert(url.to_owned(), shared.clone());
                shared
            }
        };

        let result = shared.await;
        self.cleanup_resolved(url);
        result
    }

    /// Remove the URL's entry from the map if (a) it's still present
    /// and (b) the stored `Shared` is resolved. The resolved check
    /// avoids a TOCTOU race where caller A is in phase 3 cleaning
    /// up while caller B is in phase 1 inserting a new fetch for
    /// the same URL — caller A would otherwise rip B's fresh
    /// `Shared` out from under it. `Shared::peek().is_some()` proves
    /// the stored future is the one that just resolved.
    fn cleanup_resolved(&self, url: &str) {
        let mut guard = self.inner.map.lock().expect("inflight map mutex poisoned");
        if let Some(existing) = guard.get(url) {
            if existing.peek().is_some() {
                guard.remove(url);
            }
        }
    }

    /// Number of URLs currently in flight. Test/diagnostics only.
    #[allow(dead_code)]
    pub fn in_flight_count(&self) -> usize {
        self.inner.map.lock().expect("inflight map mutex poisoned").len()
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    //! Native unit tests for the dedup primitive. The wasm-only
    //! integration is exercised through the smoke harness; what
    //! these tests prove is that the dedup primitive itself does
    //! what F.35 says it should: N concurrent requesters for the
    //! same URL all observe the same single underlying fetch.
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// Simple test error type — needs `Debug + Send + Sync` for the
    /// `Shared` machinery. `Clone` is NOT required because we wrap
    /// errors in `Arc` internally.
    #[derive(Debug)]
    struct TestError(#[allow(dead_code)] String);

    #[tokio::test]
    async fn single_caller_runs_factory_once() {
        let map: InflightMap<TestError> = InflightMap::new();
        let counter = Arc::new(AtomicUsize::new(0));
        let result = map
            .get_or_fetch("https://example.test/a", {
                let counter = counter.clone();
                || async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Ok::<_, TestError>(vec![1, 2, 3])
                }
            })
            .await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), vec![1, 2, 3]);
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        assert_eq!(map.in_flight_count(), 0, "entry should be cleaned up");
    }

    #[tokio::test]
    async fn ten_concurrent_callers_share_one_fetch() {
        // The load-bearing test for F.35. 10 concurrent tasks each
        // ask for the same URL. The mock fetch counter should reach
        // exactly 1 — i.e. the underlying fetch ran once, all 10
        // waiters latched on the shared future.
        let map: Arc<InflightMap<TestError>> = Arc::new(InflightMap::new());
        let counter = Arc::new(AtomicUsize::new(0));
        let url = "https://example.test/same";
        let body = vec![0xAB, 0xCD, 0xEF];

        let mut handles = Vec::new();
        for _ in 0..10 {
            let map = map.clone();
            let counter = counter.clone();
            let body_outer = body.clone();
            let url = url.to_owned();
            handles.push(tokio::spawn(async move {
                let result = map
                    .get_or_fetch(&url, move || {
                        let body = body_outer.clone();
                        let counter = counter.clone();
                        async move {
                            counter.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(50)).await;
                            Ok::<_, TestError>(body)
                        }
                    })
                    .await;
                result
            }));
        }

        // Wait for all to complete.
        for h in handles {
            let result = h.await.expect("task panicked");
            assert!(result.is_ok());
            assert_eq!(result.unwrap(), body);
        }

        assert_eq!(
            counter.load(Ordering::SeqCst),
            1,
            "underlying fetch should have run exactly once for 10 concurrent waiters",
        );
        assert_eq!(map.in_flight_count(), 0, "map should be empty after all done");
    }

    #[tokio::test]
    async fn overlapping_urls_dedup_independently() {
        // 4 unique URLs across 10 concurrent tasks (some sharing).
        // Tasks 0..3 want URL A; 3..5 want URL B; 5..8 want URL C;
        // 8..10 want URL D. Total tasks = 10, unique URLs = 4 →
        // exactly 4 underlying fetches.
        let map: Arc<InflightMap<TestError>> = Arc::new(InflightMap::new());
        let counter = Arc::new(AtomicUsize::new(0));
        let assignments: Vec<(&'static str, Vec<u8>)> = vec![
            ("https://example.test/A", vec![0xAA]),
            ("https://example.test/A", vec![0xAA]),
            ("https://example.test/A", vec![0xAA]),
            ("https://example.test/B", vec![0xBB]),
            ("https://example.test/B", vec![0xBB]),
            ("https://example.test/C", vec![0xCC]),
            ("https://example.test/C", vec![0xCC]),
            ("https://example.test/C", vec![0xCC]),
            ("https://example.test/D", vec![0xDD]),
            ("https://example.test/D", vec![0xDD]),
        ];

        let mut handles = Vec::new();
        for (url, body) in assignments {
            let map = map.clone();
            let counter = counter.clone();
            let body_outer = body.clone();
            handles.push(tokio::spawn(async move {
                let result = map
                    .get_or_fetch(url, move || {
                        let body = body_outer.clone();
                        let counter = counter.clone();
                        async move {
                            counter.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(50)).await;
                            Ok::<_, TestError>(body)
                        }
                    })
                    .await;
                (result, body)
            }));
        }

        for h in handles {
            let (result, expected) = h.await.expect("task panicked");
            assert!(result.is_ok());
            assert_eq!(result.unwrap(), expected);
        }

        assert_eq!(
            counter.load(Ordering::SeqCst),
            4,
            "should have exactly 4 underlying fetches for 4 unique URLs across 10 callers",
        );
    }

    #[tokio::test]
    async fn error_does_not_latch() {
        // A failed fetch should NOT permanently latch the URL to a
        // failed result. After the first call returns Err, a second
        // call should be free to retry (and the entry should be
        // cleaned up).
        let map: InflightMap<TestError> = InflightMap::new();
        let counter = Arc::new(AtomicUsize::new(0));

        // First call: returns Err.
        let result1 = map
            .get_or_fetch("https://example.test/fail", {
                let counter = counter.clone();
                || async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Err::<Vec<u8>, _>(TestError("boom".into()))
                }
            })
            .await;
        assert!(result1.is_err());
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        assert_eq!(map.in_flight_count(), 0, "entry cleaned after error");

        // Second call: should run the factory again (no latch).
        let result2 = map
            .get_or_fetch("https://example.test/fail", {
                let counter = counter.clone();
                || async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Ok::<_, TestError>(vec![1, 2, 3])
                }
            })
            .await;
        assert!(result2.is_ok());
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn sequential_calls_each_run_factory() {
        // Sanity: this is a dedup primitive, NOT a cache. Once a
        // fetch completes and the entry is cleaned up, a subsequent
        // call for the same URL re-runs the factory. (The caller's
        // shards cache handles persistent caching.)
        let map: InflightMap<TestError> = InflightMap::new();
        let counter = Arc::new(AtomicUsize::new(0));

        for _ in 0..3 {
            let _ = map
                .get_or_fetch("https://example.test/seq", {
                    let counter = counter.clone();
                    || async move {
                        counter.fetch_add(1, Ordering::SeqCst);
                        Ok::<_, TestError>(vec![1])
                    }
                })
                .await;
        }
        assert_eq!(
            counter.load(Ordering::SeqCst),
            3,
            "sequential calls should each re-run the factory",
        );
    }

    #[tokio::test]
    async fn many_callers_at_high_concurrency() {
        // Simulates the actual F.35 bug: ~119 concurrent entity
        // spawns each requesting an overlapping set of URLs. Here
        // 200 tasks share 10 URLs. Underlying fetch count should
        // be exactly 10.
        let map: Arc<InflightMap<TestError>> = Arc::new(InflightMap::new());
        let counter = Arc::new(AtomicUsize::new(0));
        let unique_urls = 10usize;
        let total_tasks = 200usize;

        let mut handles = Vec::new();
        for i in 0..total_tasks {
            let map = map.clone();
            let counter = counter.clone();
            let url = format!("https://example.test/shared-{}", i % unique_urls);
            let body = vec![(i % unique_urls) as u8];
            let body_outer = body.clone();
            handles.push(tokio::spawn(async move {
                let result = map
                    .get_or_fetch(&url, move || {
                        let body = body_outer.clone();
                        let counter = counter.clone();
                        async move {
                            counter.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(30)).await;
                            Ok::<_, TestError>(body)
                        }
                    })
                    .await;
                (result, body)
            }));
        }

        for h in handles {
            let (result, expected) = h.await.expect("task panicked");
            assert!(result.is_ok());
            assert_eq!(result.unwrap(), expected);
        }

        assert_eq!(
            counter.load(Ordering::SeqCst),
            unique_urls,
            "200 callers across 10 unique URLs → exactly 10 underlying fetches",
        );
    }

    #[tokio::test]
    async fn drain_speedup_proxy_measurement() {
        // Proxy for the F.35 drain-time gate. Mirrors the real-world
        // scenario: 119 concurrent entity spawns, each requiring an
        // overlapping set of ~50 URLs, hitting an `inflight` map
        // protected by an HTTP fetch that takes non-trivial wall
        // time. Without dedup: 119 × 50 = 5950 fetch invocations.
        // With dedup: exactly 50.
        //
        // The synchronisation barrier (`tokio::sync::Barrier`)
        // matches the real-world condition that all 119 entity-rig
        // prefetches arrive in the same tick of the renderer. The
        // 30 ms underlying fetch delay matches a realistic HTTP
        // roundtrip lower bound and gives all 119 concurrent
        // requesters a window to latch onto the same in-flight
        // shared future.
        use tokio::sync::Barrier;
        let map: Arc<InflightMap<TestError>> = Arc::new(InflightMap::new());
        let counter = Arc::new(AtomicUsize::new(0));
        let unique_urls = 50usize;
        let spawns = 119usize;
        let barrier = Arc::new(Barrier::new(spawns));

        let mut handles = Vec::new();
        for spawn_i in 0..spawns {
            let map = map.clone();
            let counter = counter.clone();
            let barrier = barrier.clone();
            handles.push(tokio::spawn(async move {
                // Hold all 119 tasks until every one has reached
                // here — then release them all at once. This
                // exactly mirrors the renderer dispatching 119
                // entity prefetches off a single tick.
                barrier.wait().await;
                let fetches = (0..unique_urls).map(|url_i| {
                    let url = format!("https://example.test/url-{url_i}");
                    let counter = counter.clone();
                    let map = map.clone();
                    async move {
                        map.get_or_fetch(&url, move || {
                            let counter = counter.clone();
                            async move {
                                counter.fetch_add(1, Ordering::SeqCst);
                                // Non-trivial fetch wall time
                                // matches the real HTTP roundtrip.
                                tokio::time::sleep(Duration::from_millis(30)).await;
                                Ok::<_, TestError>(vec![url_i as u8])
                            }
                        })
                        .await
                    }
                });
                let _ = futures::future::join_all(fetches).await;
                spawn_i
            }));
        }

        for h in handles {
            let _ = h.await.expect("task panicked");
        }

        let actual = counter.load(Ordering::SeqCst);
        // Without dedup this would be 119 × 50 = 5950. With dedup
        // it should be exactly 50.
        assert_eq!(
            actual, unique_urls,
            "F.35 dedup: 119 spawns × 50 URLs → expected {unique_urls} fetches, got {actual}",
        );
    }

    #[tokio::test]
    async fn dedup_without_overlap_window_runs_each_factory() {
        // Counterpart to the drain test: if fetches resolve before
        // the next caller arrives, there's nothing to dedup. This
        // is correct behaviour — dedup only applies to *in-flight*
        // fetches. After a fetch resolves and is cleaned up, the
        // next call re-runs the factory. This test documents that
        // semantic so future readers don't expect persistent
        // caching from this primitive (the caller's `shards`
        // HashMap handles persistent caching).
        let map: InflightMap<TestError> = InflightMap::new();
        let counter = Arc::new(AtomicUsize::new(0));

        for _ in 0..5 {
            let _ = map
                .get_or_fetch("https://example.test/no-overlap", {
                    let counter = counter.clone();
                    || async move {
                        counter.fetch_add(1, Ordering::SeqCst);
                        Ok::<_, TestError>(vec![1])
                    }
                })
                .await;
        }
        assert_eq!(
            counter.load(Ordering::SeqCst),
            5,
            "non-overlapping sequential calls should each re-run the factory",
        );
    }
}
