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

use std::sync::Arc;

use holtburger_dat::{ResourceKey, ResourceSource};
use holtburger_resource_http::{ManifestResourceSource, RecordingSource};
use wasm_bindgen::prelude::*;

pub use crate::walk_dedup::WalkDedupMap;

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
    run_walk_loop(source, initial_keys, walk).await
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
                run_walk_loop(&source, &initial_refs, walk).await
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
) -> Result<(), JsValue>
where
    F: Fn(&dyn ResourceSource),
{
    if !initial_keys.is_empty() {
        source
            .prefetch(initial_keys)
            .await
            .map_err(|e| JsValue::from_str(&format!("prefetch initial: {e}")))?;
    }
    let inner: &ManifestResourceSource = source.as_ref();
    let inner_dyn: &dyn ResourceSource = inner;
    let recorder = RecordingSource::new(inner_dyn);
    let mut prev_total: usize = 0;
    for _round in 0..8 {
        walk(&recorder);
        let misses = recorder.take_misses();
        if misses.is_empty() {
            break;
        }
        let new_total = prev_total + misses.len();
        if new_total == prev_total {
            break;
        }
        prev_total = new_total;
        let keys: Vec<ResourceKey<'_>> = misses
            .iter()
            .map(|(ns, id)| ResourceKey::new(ns.as_str(), *id))
            .collect();
        // Permanent-miss tolerance: prefetch may report
        // `UnknownKey` if a key isn't in the manifest at all.
        // Stop iterating; the final walk just won't see those
        // records (matches today's "best-effort" semantics on
        // legacy HttpResourceSource for missing keys).
        if let Err(e) = source.prefetch(&keys).await {
            log::warn!("prefetch round failure (continuing): {e}");
            break;
        }
    }
    Ok(())
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

