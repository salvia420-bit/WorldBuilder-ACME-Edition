//! Phase 5.0b — async prefetch driver for the manifest-mode
//! resource source.
//!
//! Each `fetch_*` wasm-bindgen export reads records by key. With
//! `ManifestResourceSource`, a record is only available after
//! `prefetch(&keys)` resolves. The challenge: many `fetch_*`
//! discover keys *dynamically* — `fetch_terrain_textures` reads
//! a SurfaceTexture, then needs the Texture it references, then
//! the Palette that Texture wants. The walk is sync; the prefetch
//! is async.
//!
//! Strategy implemented here: **iterative discovery via
//! `RecordingSource`**. Run the existing sync walk against a
//! recording wrapper that captures every `get_file_by_key` Err.
//! Each round, prefetch the captured keys, re-run the walk.
//! Terminate when no new misses appear or progress stalls.
//!
//! Trade-off: each fetch_* runs the walk N+1 times (typical N=2-4
//! for the deep ones, N=1 for the shallow). The walks are pure
//! parsing, no I/O, so the overhead is bounded by record sizes —
//! cheap relative to the network savings of not pre-loading the
//! 605 MB bundle.
//!
//! # F.37 walk-result dedup (2026-05-14)
//!
//! F.35 dedups concurrent URL fetches under
//! `ManifestResourceSource::prefetch`. But each wasm export above
//! (`fetchBuildingPlacement`, `fetchEntityAnimationKeyframes`,
//! `populateBuildingAabbsForLandblock`, …) still spins up its own
//! `RecordingSource` + iterative-prefetch loop independently of
//! every other concurrent caller. Two concurrent
//! `fetchBuildingPlacement(0x02000123)` calls each separately:
//!
//!   1. allocate a `RecordingSource`,
//!   2. run the walk against under-hydrated shards,
//!   3. take the miss set, batch a `prefetch(misses).await`,
//!   4. re-run the walk,
//!   5. terminate.
//!
//! F.35's URL dedup means both callers latch on the same in-flight
//! HTTP fetch (good), but the walk machinery still allocates
//! `RecordingSource` twice, re-parses DAT bytes twice, and may
//! issue a redundant `prefetch(empty)` round trip.
//!
//! `WalkDedupMap` adds a second cache layer: concurrent callers
//! with the same `(cache_key)` latch on a single
//! `Shared<Future<Result<(), JsValue>>>` that drives the prefetch
//! loop exactly once. After the future resolves the entry is
//! cleaned up so a later (post-completion) caller re-runs the loop
//! — by then the loop is sync-fast because all transitive keys are
//! cached in `shards`. The walk closure itself runs once per call
//! (it's the caller's job to short-circuit on already-cached
//! results); F.37's contract is "dedup the prefetch-loop overhead",
//! not "dedup the final parse".
//!
//! `cache_key` is caller-supplied. Each call site picks a key that
//! captures every input that influences the walk (e.g.
//! `("fetchBuildingPlacement", model_id)` or
//! `("fetchEntityAnimationKeyframes", setup_id, mt, stance, cmd,
//! model_changes_hash, texture_changes_hash, palette_id,
//! palette_subs_hash)`). Two callers with the same key get the
//! same Shared future; different keys run independent loops.
//!
//! Correctness mirrors the F.35 inflight primitive:
//!
//! 1. The map mutex is **never held across `.await`** — phase 1
//!    (latch-or-start) and phase 3 (cleanup) acquire it briefly;
//!    phase 2 (await) runs unlocked.
//! 2. `Shared` requires `Output: Clone`; `Result<(), JsValue>`
//!    satisfies that (`JsValue: Clone` per wasm-bindgen).
//! 3. On error the entry is **removed** before propagating so a
//!    transient failure doesn't latch.
//! 4. wasm32 is single-threaded; the `LocalBoxFuture` (no Send
//!    bound) variant + `unsafe impl Send/Sync` on the wrapper map
//!    follows the same recipe `inflight::InflightMap` uses for
//!    `ResourceSource: Send + Sync`'s static bound.
//!
//! See `inflight::InflightMap` (F.35) for the architectural twin —
//! same pattern at a different layer.

#![cfg(target_arch = "wasm32")]

use std::cell::Cell;
use std::sync::Arc;

use holtburger_dat::{ResourceKey, ResourceSource};
use holtburger_resource_http::{ManifestResourceSource, PrefetchError, RecordingSource};
use wasm_bindgen::prelude::*;

use crate::batch_walk::{BatchWalkStats, RoundFailure, run_batch_walk, run_batch_walk_paced};
pub use crate::walk_dedup::WalkDedupMap;

// ============================================================
// Discovery pacing (2026-10-09 follow-up, Workstream B's walk-window long
// tasks; `?walkPace` for the legacy loop, `?interiorStabChunk` for the stab
// sub-walks)
// ============================================================
//
// A discovery round is synchronous (a full re-parse of everything the walk
// reaches). When a prefetch round completes, the walk runs its next discovery
// in the SAME task that delivered the round's last body — and so does every
// other walk woken by that delivery (one shard-fetch-worker results message
// resolves up to 64 fetches; wasm-bindgen-futures drains its whole queue per
// microtask checkpoint). On the 1070 academy profile (acad-diagF) that stacking
// was every main-thread long task of the walk window (50-72 ms). Pacing hands
// the event loop one turn (`crate::yield_to_event_loop`: a MessageChannel post,
// the interior build's own yield) before each such discovery, so each walk's
// discovery runs in its own task. Main thread only (a worker has no frames to
// protect and its queue holds decode jobs a yield would wait behind), never
// while the document is hidden (same rule as `InteriorBuildYield`).

thread_local! {
    /// (legacy-loop yields, stab sub-walk yields, ms spent away) — published
    /// as `globalThis.__hbWalkPace` after every paced turn.
    static WALK_PACE_STATS: Cell<(u32, u32, f64)> = const { Cell::new((0, 0, 0.0)) };
}

/// `?walkPace` (default on; `off|0|false|no` disables), parsed once per
/// instance over the seeded `flag_search()`.
fn walk_pace_flag() -> bool {
    static FLAG: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *FLAG.get_or_init(|| crate::batch_walk::parse_walk_pace_flag(&crate::flag_search()))
}

/// True when this wasm instance runs where a `document` exists (the page's
/// main thread). Not cached: one property read per paced round.
fn pace_context_is_main_thread() -> bool {
    js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("document"))
        .map(|d| d.is_object())
        .unwrap_or(false)
}

/// One paced turn (see the section comment). `sub_walk` only picks the
/// counter.
async fn discovery_pace_turn(sub_walk: bool) {
    if crate::js_document_hidden() {
        return;
    }
    let t0 = crate::js_perf_now();
    crate::yield_to_event_loop().await;
    let away = crate::js_perf_now() - t0;
    let (legacy, sub, away_ms) = WALK_PACE_STATS.with(|s| {
        let (mut legacy, mut sub, mut away_ms) = s.get();
        if sub_walk {
            sub += 1;
        } else {
            legacy += 1;
        }
        away_ms += away;
        s.set((legacy, sub, away_ms));
        (legacy, sub, away_ms)
    });
    let obj = js_sys::Object::new();
    let set = |k: &str, v: f64| {
        let _ = js_sys::Reflect::set(&obj, &JsValue::from_str(k), &JsValue::from_f64(v));
    };
    set("legacyYields", legacy as f64);
    set("stabSubWalkYields", sub as f64);
    set("awayMs", away_ms);
    let _ = js_sys::Reflect::set(&js_sys::global(), &JsValue::from_str("__hbWalkPace"), &obj);
}

/// `?walkPace` gate for [`run_walk_loop`]: yield one turn before a discovery
/// round that follows a prefetch round that SUSPENDED (main thread, flag on,
/// not hidden).
async fn maybe_pace_legacy_discovery() {
    if walk_pace_flag() && pace_context_is_main_thread() {
        discovery_pace_turn(false).await;
    }
}

/// Await `fut` and report whether it SUSPENDED (returned `Pending` at least
/// once). A prefetch that completes on its first poll (every key already
/// resident: `prefetch_impl` returns before its first await) leaves the walk
/// in the caller's own turn — like a walk's first discovery, which is never
/// paced — so pacing it would only add an event-loop turn to every warm call
/// (the F.37 "sync-fast re-run", every cached `fetch_animation` /
/// `fetch_physics_script` …). Only a prefetch that waited resumes inside
/// whatever task delivered its wake-up, which is the stacking `?walkPace`
/// splits.
async fn await_noting_suspend<Fut>(fut: Fut) -> (Fut::Output, bool)
where
    Fut: std::future::Future,
{
    let mut fut = std::pin::pin!(fut);
    let mut suspended = false;
    let out = std::future::poll_fn(|cx| {
        let polled = std::future::Future::poll(fut.as_mut(), cx);
        if polled.is_pending() {
            suspended = true;
        }
        polled
    })
    .await;
    (out, suspended)
}

// ============================================================
// Discovery-walk marker (2026-07-02 hardening)
// ============================================================

thread_local! {
    /// Depth of RecordingSource discovery walks currently on the stack.
    /// wasm32 is single-threaded and `walk` closures are synchronous (no
    /// `.await` inside a walk), so a plain Cell is race-free; a depth
    /// counter (not a bool) keeps hypothetical nesting safe.
    static DISCOVERY_WALK_DEPTH: Cell<u32> = const { Cell::new(0) };
}

/// True while [`run_walk_loop`] is running its `walk` closure against the
/// RecordingSource. Decode impls (`fetch_surface_pixels_impl`,
/// `fetch_entity_surface_pixels_impl`) consult this to suppress their
/// per-failure console warns during discovery rounds — a get-miss there is
/// the loop's NORMAL record-finding mechanism (round N's misses are round
/// N+1's prefetch list), not an error. Warning on it flooded the console
/// with transient "palette fetch failed … record not prefetched" noise
/// (~40 lines per cold LB, 2026-07-02) that drowned real failures; only a
/// FINAL (post-loop, real-source) decode failure should reach the console.
pub fn in_discovery_walk() -> bool {
    DISCOVERY_WALK_DEPTH.with(|d| d.get() > 0)
}

/// RAII guard so a panicking walk can't leave the flag stuck on.
struct DiscoveryWalkGuard;
impl DiscoveryWalkGuard {
    fn new() -> Self {
        DISCOVERY_WALK_DEPTH.with(|d| d.set(d.get() + 1));
        DiscoveryWalkGuard
    }
}
impl Drop for DiscoveryWalkGuard {
    fn drop(&mut self) {
        DISCOVERY_WALK_DEPTH.with(|d| d.set(d.get().saturating_sub(1)));
    }
}

/// Total attempts per prefetch round (1 initial + retries). See the retry
/// block in [`run_walk_loop`].
const PREFETCH_ROUND_TRIES: u32 = 3;

/// §2.1b — ONE discovery round, extracted as a **relocatable unit**.
///
/// This is the entire poolable half of [`run_walk_loop`]: a synchronous walk
/// against a `RecordingSource`, returning the records the walk missed. Per
/// `SCOPE-2.1-fetch-decode-boundary-2026-07-24.md` §1b the pipeline is
/// decode-as-DISCOVERY — round N's misses are round N+1's fetch list — so the
/// thread boundary cannot be a single fetch-then-decode handoff. It has to be
/// this unit, invoked once per round.
///
/// Deliberately captures NO owner-thread state, so §2.1c can dispatch it to a
/// worker without touching its body:
///
/// - `source` is a plain `&dyn ResourceSource`. Today the driver passes the
///   `ManifestResourceSource`; under the pool it will be a `DecodeSource`
///   (§2.1a), which cannot name the `!Send` prefetch machinery.
/// - the returned misses are OWNED `(String, u32)` pairs — `Send` data, ready
///   to message back to the owner thread.
/// - `RecordingSource`'s miss set is a `Mutex<HashSet<_>>`, already thread-safe.
///
/// `DiscoveryWalkGuard` stays `thread_local!` on purpose: it suppresses decode
/// warnings *for the walk currently on this stack*, so per-thread depth is the
/// correct semantics under a pool, not a §2.2-style bug.
///
/// Behaviour note: the driver used to build ONE `RecordingSource` outside the
/// loop and drain it per round. A fresh recorder per round is equivalent —
/// `take_misses` fully drains — and is what makes the unit self-contained.
fn discovery_round<F>(source: &dyn ResourceSource, walk: &F) -> Vec<(String, u32)>
where
    F: Fn(&dyn ResourceSource) + ?Sized,
{
    let recorder = RecordingSource::new(source);
    {
        // Mark the walk as a discovery run so decode impls keep their
        // per-failure console warns quiet (see `in_discovery_walk`).
        let _discovery = DiscoveryWalkGuard::new();
        walk(&recorder);
    }
    recorder.take_misses()
}

thread_local! {
    /// Process-global walk-dedup map. Wasm32 is single-threaded so
    /// `thread_local!` is the canonical "global state" pattern —
    /// avoids the synchronization overhead a `Mutex`-backed static
    /// would impose (and the `lazy_static` boilerplate).
    static WALK_DEDUP: WalkDedupMap = WalkDedupMap::new();
}

/// Iteratively prefetch every record `walk` reads.
///
/// 1. Prefetch `initial_keys` (the well-known top-level entries
///    a fetch_* always touches — e.g. the 33 SurfaceTexture IDs
///    for `fetch_terrain_textures`).
/// 2. Run `walk` against a `RecordingSource` wrapping the manifest
///    source; collect the keys whose `get_file_by_key` errored.
/// 3. Prefetch the collected keys; goto 2.
/// 4. Stop when no new misses appear, when progress stalls (some
///    keys really aren't in the manifest), or after 8 rounds
///    (defensive cap).
///
/// The caller then runs the same walk against the real source
/// for the final result; cache hits are sync.
///
/// Concurrent callers passing the same `cache_key` to
/// [`ensure_walk_prefetched_keyed`] share a single prefetch loop;
/// see the F.37 module docs above. This non-keyed entry point
/// uses a per-call unique key (so two concurrent calls re-walk
/// independently). Hot paths that fire many concurrent
/// invocations with overlapping args should call
/// [`ensure_walk_prefetched_keyed`] directly.
pub async fn ensure_walk_prefetched<F>(
    source: &Arc<ManifestResourceSource>,
    initial_keys: &[ResourceKey<'_>],
    walk: F,
) -> Result<(), JsValue>
where
    F: Fn(&dyn ResourceSource),
{
    run_walk_loop(source, initial_keys, walk, false).await
}

/// streamFix urgent lane (2026-07-02): non-keyed urgent variant of
/// [`ensure_walk_prefetched`] — every prefetch round rides
/// [`ManifestResourceSource::prefetch_urgent`] (fetch-semaphore bypass +
/// distinct inflight keys + default browser fetch priority). For
/// PLAYER-BLOCKING walks only: the current landblock's (and its 3×3
/// ring's) statics/buildings/terrain bakes, which pre-fix sat behind the
/// speculative ring bakers' FIFO backlog for tens of seconds after a
/// rapid multi-town @telepoi run. Mirrors the interiors' urgent lane
/// (`ensure_walk_prefetched_keyed_urgent`, geom-audit 2026-07-02).
pub async fn ensure_walk_prefetched_urgent<F>(
    source: &Arc<ManifestResourceSource>,
    initial_keys: &[ResourceKey<'_>],
    walk: F,
) -> Result<(), JsValue>
where
    F: Fn(&dyn ResourceSource),
{
    run_walk_loop(source, initial_keys, walk, true).await
}

/// F.37 walk-result-dedup variant. Concurrent callers passing the
/// same `cache_key` share a single prefetch loop via a `Shared`
/// future; the first caller's loop runs once, subsequent callers
/// `.await` the shared completion.
///
/// `cache_key` MUST capture every argument that affects the walk's
/// transitive miss set. The standard recipe:
///
/// ```ignore
/// let cache_key = WalkCacheKey::from_args(
///     "fetchEntityAnimationKeyframes",
///     &[setup_id, mtable_id, stance, motion_cmd, palette_id],
///     &model_changes_flat,
///     &texture_changes_flat,
/// );
/// ```
///
/// After the shared loop resolves the cache entry is dropped, so
/// a subsequent call for the same key after completion will
/// re-run the loop. By then the shards cache holds all transitive
/// keys so the re-run is sync-fast.
///
/// `walk` runs at most **once** while the shared loop is in
/// flight, against a `RecordingSource` wrapping the manifest. The
/// caller's post-`await` walk against the real source still runs
/// per-call (cheap; all bytes are cached) — F.37 dedups the
/// *prefetch loop*, not the final parse.
pub async fn ensure_walk_prefetched_keyed<F>(
    cache_key: WalkCacheKey,
    source: &Arc<ManifestResourceSource>,
    initial_keys: &[ResourceKey<'_>],
    walk: F,
) -> Result<(), JsValue>
where
    F: Fn(&dyn ResourceSource) + 'static,
{
    ensure_walk_prefetched_keyed_impl(cache_key, source, initial_keys, walk, false).await
}

/// Urgent-lane variant of [`ensure_walk_prefetched_keyed`] — the loop's
/// prefetch rounds ride [`ManifestResourceSource::prefetch_urgent`]
/// (semaphore bypass + distinct inflight keys + default fetch priority)
/// so a player-blocking walk (current-LB interior stab records) is not
/// FIFO-starved behind the speculative ring bakers' flood.
pub async fn ensure_walk_prefetched_keyed_urgent<F>(
    cache_key: WalkCacheKey,
    source: &Arc<ManifestResourceSource>,
    initial_keys: &[ResourceKey<'_>],
    walk: F,
) -> Result<(), JsValue>
where
    F: Fn(&dyn ResourceSource) + 'static,
{
    ensure_walk_prefetched_keyed_impl(cache_key, source, initial_keys, walk, true).await
}

async fn ensure_walk_prefetched_keyed_impl<F>(
    cache_key: WalkCacheKey,
    source: &Arc<ManifestResourceSource>,
    initial_keys: &[ResourceKey<'_>],
    walk: F,
    urgent: bool,
) -> Result<(), JsValue>
where
    F: Fn(&dyn ResourceSource) + 'static,
{
    // Phase 1: latch-or-start. Briefly access the thread-local map
    // to look up an existing future for this key, or insert a new
    // one. The thread-local borrow is dropped before the await.
    let shared = WALK_DEDUP.with(|map| {
        map.get_or_install(&cache_key, || {
            // The factory closure builds a future that drives the
            // loop. It captures `source` (cheap `Arc` clone) and
            // `walk` (the per-call FnMut wrapped owned). The
            // `initial_keys` need to be owned to live in the
            // future; we copy them into a `Vec<OwnedKey>`.
            let owned_initial: Vec<(String, u32)> = initial_keys
                .iter()
                .map(|k| (k.namespace.to_string(), k.file_id))
                .collect();
            let source = source.clone();
            Box::pin(async move {
                let initial_refs: Vec<ResourceKey<'_>> = owned_initial
                    .iter()
                    .map(|(ns, id)| ResourceKey::new(ns.as_str(), *id))
                    .collect();
                run_walk_loop(&source, &initial_refs, walk, urgent).await
            })
        })
    });

    // Phase 2: await outside the thread-local borrow.
    let result = shared.await;

    // Phase 3: cleanup. Remove the entry so transient errors
    // don't latch and the map doesn't grow unboundedly.
    WALK_DEDUP.with(|map| map.cleanup_resolved(&cache_key));

    result
}

/// Inner loop — same algorithm as the original `ensure_walk_prefetched`
/// body. Factored out so [`ensure_walk_prefetched`] and the dedup-shared
/// future built by [`ensure_walk_prefetched_keyed`] both run identical
/// code.
async fn run_walk_loop<F>(
    source: &Arc<ManifestResourceSource>,
    initial_keys: &[ResourceKey<'_>],
    walk: F,
    // Urgent walks (player-blocking interior loads) ride
    // `prefetch_urgent` for every round — see the keyed-urgent entry.
    urgent: bool,
) -> Result<(), JsValue>
where
    F: Fn(&dyn ResourceSource),
{
    let do_prefetch = |keys: Vec<(String, u32)>| async move {
        let refs: Vec<ResourceKey<'_>> = keys
            .iter()
            .map(|(ns, id)| ResourceKey::new(ns.as_str(), *id))
            .collect();
        if urgent {
            source.prefetch_urgent(&refs).await
        } else {
            source.prefetch(&refs).await
        }
    };
    // `?walkPace`: did the prefetch round just before the next discovery
    // SUSPEND (see `await_noting_suspend`)? Never true for a walk's first
    // discovery without initial keys, nor after a fully-resident prefetch.
    let mut pace_next = false;
    if !initial_keys.is_empty() {
        let owned: Vec<(String, u32)> = initial_keys
            .iter()
            .map(|k| (k.namespace.to_string(), k.file_id))
            .collect();
        let (initial, suspended) = await_noting_suspend(do_prefetch(owned)).await;
        initial.map_err(|e| JsValue::from_str(&format!("prefetch initial: {e}")))?;
        pace_next = suspended;
    }
    let inner: &ManifestResourceSource = source.as_ref();
    let inner_dyn: &dyn ResourceSource = inner;
    let mut prev_misses: Vec<(String, u32)> = Vec::new();
    for _round in 0..8 {
        // `?walkPace` (default on, main thread only): a discovery that follows
        // a prefetch round that SUSPENDED (the initial-keys prefetch or the
        // previous round's) runs in its own task — see the pacing section
        // above. A fully-resident (warm) prefetch completes on its first poll
        // and is not paced. `walkPace=off`: no yield (the pre-follow-up loop).
        if pace_next {
            maybe_pace_legacy_discovery().await;
        }
        // §2.1b: the poolable half. Runs in-place today; §2.1c replaces this
        // one line with a dispatch, and the driver below is unchanged.
        let misses = discovery_round(inner_dyn, &walk);
        if misses.is_empty() {
            break;
        }
        // Stall guard: if this round's miss SET is identical to the previous
        // round's, the prefetch resolved nothing — those keys are permanently
        // absent from the manifest (the module's "some keys really aren't in
        // the manifest" case). Stop instead of burning the full round cap
        // re-walking + re-prefetching the same keys. (The old `prev_total +
        // misses.len() == prev_total` guard was dead code: `misses` is
        // non-empty past the check above, so the sum always grew.)
        let mut this_misses: Vec<(String, u32)> = misses.clone();
        this_misses.sort();
        this_misses.dedup();
        if this_misses == prev_misses {
            break;
        }
        prev_misses = this_misses;
        let keys: Vec<ResourceKey<'_>> = misses
            .iter()
            .map(|(ns, id)| ResourceKey::new(ns.as_str(), *id))
            .collect();
        // Transient-failure retry (2026-07-02 hardening): a single dropped
        // shard fetch (serve.py tunnel hiccup, load spike) used to `break`
        // the WHOLE loop here on the first error, leaving every deeper
        // record unfetched — the final walk then decoded empty/white and
        // the statics bake PERMANENTLY cached that output for the session
        // (the silent-white-props class). Retry the round a bounded number
        // of times; a retry rides the F.35 inflight/URL dedup so shards
        // that DID resolve aren't re-fetched. Only after the retries
        // exhaust do we stop discovering (the pre-hardening behavior —
        // still correct for the permanent UnknownKey / not-in-manifest
        // class, which fails every attempt identically).
        let mut round_ok = false;
        let mut round_suspended = false;
        for attempt in 1..=PREFETCH_ROUND_TRIES {
            let (round, suspended) = if urgent {
                await_noting_suspend(source.prefetch_urgent(&keys)).await
            } else {
                await_noting_suspend(source.prefetch(&keys)).await
            };
            round_suspended |= suspended;
            match round {
                Ok(()) => {
                    round_ok = true;
                    break;
                }
                Err(e) if attempt < PREFETCH_ROUND_TRIES => {
                    log::warn!(
                        "prefetch round failed (attempt {attempt}/{PREFETCH_ROUND_TRIES}, retrying): {e}"
                    );
                }
                Err(e) => {
                    log::warn!(
                        "prefetch round failed after {PREFETCH_ROUND_TRIES} attempts (stopping discovery): {e}"
                    );
                }
            }
        }
        if !round_ok {
            break;
        }
        pace_next = round_suspended;
    }
    Ok(())
}

// ============================================================
// A0 hardening (`?interiorStabBatch`, 2026-10-09) — batch-mode keyed walk
// ============================================================

thread_local! {
    /// Dedup map for [`ensure_walk_prefetched_keyed_batch`]. Separate from
    /// `WALK_DEDUP` because the shared output differs (stats, infallible), so
    /// a batch-mode key can never latch onto a legacy loop or vice versa.
    static BATCH_WALK_DEDUP: crate::walk_dedup::WalkDedupMapT<
        WalkCacheKey,
        BatchWalkStats,
        std::convert::Infallible,
    > = crate::walk_dedup::WalkDedupMapT::new();
}

/// Keyed walk in BATCH MODE (`crate::batch_walk::run_batch_walk`): like
/// [`ensure_walk_prefetched_keyed_urgent`] / [`ensure_walk_prefetched_keyed`]
/// (same `RecordingSource` discovery rounds, same 3 tries per round, same
/// stall guard and 8-round cap, same F.37 sharing between concurrent callers
/// passing the same `cache_key`), except that a round's keys that still fail
/// after the last try are EXCLUDED and discovery continues instead of
/// stopping. It never fails; it returns what it did.
///
/// No initial keys by design: the walk's top records are its first discovery
/// round's misses, so they get the same retry/exclusion treatment as every
/// other record.
///
/// Used by `fetch_env_cells_in_landblock` (`?interiorStabBatch` ON) for the
/// landblock's stab batch when `?interiorStabChunk=off` AND its per-stab
/// fallback walks (`rounds > 0` on a fallback = it still had misses — the build
/// log's `perStabFallback`). Unpaced: exactly the pre-follow-up loop. Existing
/// callers of the legacy loop are untouched.
pub(crate) async fn ensure_walk_prefetched_keyed_batch<F>(
    cache_key: WalkCacheKey,
    source: &Arc<ManifestResourceSource>,
    walk: F,
    urgent: bool,
) -> BatchWalkStats
where
    F: Fn(&dyn ResourceSource) + 'static,
{
    ensure_walk_prefetched_keyed_batch_paced(cache_key, source, walk, urgent, false).await
}

/// [`ensure_walk_prefetched_keyed_batch`] with discovery pacing:
/// `pace = true` (the `?interiorStabChunk` sub-walks) hands the event loop one
/// turn before every discovery round that follows a prefetch round — main
/// thread only, not while the document is hidden (see the pacing section at
/// the top of this file) — so each sub-walk's synchronous discovery runs in
/// its own task. `pace = false` is the unpaced loop. Same dedup map, same keys:
/// a caller latching onto an existing walk gets that walk's pacing.
pub(crate) async fn ensure_walk_prefetched_keyed_batch_paced<F>(
    cache_key: WalkCacheKey,
    source: &Arc<ManifestResourceSource>,
    walk: F,
    urgent: bool,
    pace: bool,
) -> BatchWalkStats
where
    F: Fn(&dyn ResourceSource) + 'static,
{
    let label = cache_key.export();
    // Phase 1: latch-or-start (borrow released before the await).
    let shared = BATCH_WALK_DEDUP.with(|map| {
        map.get_or_install(&cache_key, || {
            let source = source.clone();
            Box::pin(async move {
                Ok::<BatchWalkStats, std::convert::Infallible>(
                    run_batch_walk_loop(&source, walk, urgent, label, pace).await,
                )
            })
        })
    });
    // Phase 2: await outside the thread-local borrow.
    let result = shared.await;
    // Phase 3: cleanup (a later caller re-runs the — then sync-fast — loop).
    BATCH_WALK_DEDUP.with(|map| map.cleanup_resolved(&cache_key));
    match result {
        Ok(stats) => stats,
        Err(never) => match never {},
    }
}

/// The batch loop bound to the manifest source: discovery = one
/// [`discovery_round`] (the same relocatable unit `run_walk_loop` uses);
/// prefetch = one `prefetch[_urgent]` round, with `PrefetchError::PartialRound`
/// naming exactly the keys that did not land and every other error failing the
/// round as a whole. `pace`: see [`ensure_walk_prefetched_keyed_batch_paced`].
async fn run_batch_walk_loop<F>(
    source: &Arc<ManifestResourceSource>,
    walk: F,
    urgent: bool,
    label: &'static str,
    pace: bool,
) -> BatchWalkStats
where
    F: Fn(&dyn ResourceSource),
{
    let inner: &ManifestResourceSource = source.as_ref();
    let inner_dyn: &dyn ResourceSource = inner;
    let discover = || discovery_round(inner_dyn, &walk);
    let prefetch = move |keys: Vec<(String, u32)>| async move {
        let refs: Vec<ResourceKey<'_>> = keys
            .iter()
            .map(|(ns, id)| ResourceKey::new(ns.as_str(), *id))
            .collect();
        let round = if urgent {
            inner.prefetch_urgent(&refs).await
        } else {
            inner.prefetch(&refs).await
        };
        round.map_err(|e| match e {
            PrefetchError::PartialRound { failed, detail } => RoundFailure {
                failed: Some(failed),
                detail,
            },
            other => RoundFailure {
                failed: None,
                detail: other.to_string(),
            },
        })
    };
    let warn = move |msg: String| {
        log::warn!("[{label}] {msg}");
    };
    if pace {
        // `?interiorStabChunk` sub-walks: one event-loop turn before each
        // discovery that follows a round (main thread only, not while hidden).
        run_batch_walk_paced(
            Vec::new(),
            discover,
            prefetch,
            || async {
                if pace_context_is_main_thread() {
                    discovery_pace_turn(true).await;
                }
            },
            warn,
        )
        .await
    } else {
        run_batch_walk(Vec::new(), discover, prefetch, warn).await
    }
}

// ============================================================
// WalkCacheKey — a stable, collision-resistant key that captures
// the discriminating args of a wasm-export walk invocation.
// ============================================================

/// Stable cache key for [`ensure_walk_prefetched_keyed`].
///
/// Construction recipe:
///
/// ```ignore
/// let key = WalkCacheKey::new("fetchBuildingPlacement")
///     .with_u32(model_id);
/// ```
///
/// Or for many-arg exports:
///
/// ```ignore
/// let key = WalkCacheKey::new("fetchEntityAnimationKeyframes")
///     .with_u32(setup_id)
///     .with_u32(mtable_id)
///     .with_u32(motion_command)
///     .with_u32(stance)
///     .with_u32(palette_id)
///     .with_u32_slice(&model_changes)
///     .with_u32_slice(&texture_changes)
///     .with_u32_slice(&palette_subs_flat);
/// ```
///
/// The key serializes to `(export_name, [u32])`. Equality is
/// structural; hashing uses the `Hash` impl below.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WalkCacheKey {
    export: &'static str,
    args: Vec<u32>,
}

impl WalkCacheKey {
    pub fn new(export: &'static str) -> Self {
        Self {
            export,
            args: Vec::new(),
        }
    }

    pub fn with_u32(mut self, v: u32) -> Self {
        self.args.push(v);
        self
    }

    pub fn with_u32_slice(mut self, vs: &[u32]) -> Self {
        // A length-then-elements encoding avoids the
        // `with_u32_slice(&[1, 2]).with_u32(3)` collision with
        // `with_u32(1).with_u32_slice(&[2, 3])` (otherwise both
        // would serialize as [1, 2, 3]). Push the slice's len
        // first so the boundary is preserved.
        self.args.push(vs.len() as u32);
        self.args.extend_from_slice(vs);
        self
    }

    /// For test introspection only.
    #[allow(dead_code)]
    pub fn args(&self) -> &[u32] {
        &self.args
    }

    /// For test introspection only.
    #[allow(dead_code)]
    pub fn export(&self) -> &'static str {
        self.export
    }
}

