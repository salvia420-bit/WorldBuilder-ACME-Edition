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

#![cfg(target_arch = "wasm32")]

use std::rc::Rc;

use holtburger_dat::{ResourceKey, ResourceSource};
use holtburger_resource_http::{ManifestResourceSource, RecordingSource};
use wasm_bindgen::prelude::*;

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
pub async fn ensure_walk_prefetched<F>(
    source: &Rc<ManifestResourceSource>,
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
