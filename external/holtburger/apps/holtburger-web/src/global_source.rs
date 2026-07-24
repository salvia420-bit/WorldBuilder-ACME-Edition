//! Thread-local, page-scoped `ManifestResourceSource` shared across
//! every wasm-bindgen `fetch_*` export. Phase 5.0 obj 5.
//!
//! # Why thread-local
//!
//! `wasm_bindgen_futures::spawn_local`-spawned tasks (the recv loop,
//! the catalog fetch, future tasks) need to read the same shard
//! cache as direct callers. Passing the source as a parameter ties
//! every callsite to a refactor; thread-local is module-scoped and
//! zero-overhead on wasm32 (single-threaded).
//!
//! # JS contract
//!
//! [`init_resource_source`] is called once at page-init time before
//! any other `fetch_*` or `start_session` runs. Subsequent calls
//! reset the global to the new manifest's contents — useful for
//! unit tests but never used in normal page flow.
//!
//! Each `fetch_*` export reads the global via [`global_source`]
//! and uses [`ManifestResourceSource::prefetch`] to hydrate the
//! records it'll read before any sync `get_file_by_key` call.
//!
//! # Migration shape
//!
//! Phase 5.0 obj 5 (this commit) lands the infrastructure. The
//! per-export refactor (drop `asset_url` parameter from each
//! `fetch_*`, replace inner `HttpResourceSource::connect` with
//! `global_source().prefetch(keys).await + get_file_by_key`)
//! lands together with the smoke-test rewrite in obj 9 — those
//! changes are coupled because the smoke test currently spins up
//! a Node `http.createServer` serving a single `assets.hba`, and
//! the manifest path needs a pre-baked manifest+shard fixture
//! served the same way.

#![cfg(target_arch = "wasm32")]

use std::cell::RefCell;
use std::sync::Arc;

use holtburger_resource_http::ManifestResourceSource;
use wasm_bindgen::prelude::*;

thread_local! {
    static SOURCE: RefCell<Option<Arc<ManifestResourceSource>>> = const { RefCell::new(None) };
}

/// Initialize the page-scoped resource source. Must be called once
/// at page-init time before any `fetch_*` or `start_session` runs.
///
/// Fetches `manifest.json` + the boot pack referenced from it,
/// verifies the boot pack's sha256, and parks the resulting
/// `ManifestResourceSource` in a thread-local that every other
/// wasm-bindgen export reads from.
///
/// On failure (network / parse / hash mismatch) the JS Promise
/// rejects with a descriptive error string; subsequent
/// `fetch_*` calls will see no global source and surface
/// "init_resource_source not yet called" until init succeeds.
#[wasm_bindgen]
pub async fn init_resource_source(manifest_url: String) -> Result<(), JsValue> {
    let source = ManifestResourceSource::connect(&manifest_url)
        .await
        .map_err(|e| JsValue::from_str(&format!("init_resource_source: {e}")))?;
    SOURCE.with(|cell| {
        *cell.borrow_mut() = Some(Arc::new(source));
    });
    // R-7/A07-F4: a (re-)init invalidates every absence proof from the old
    // manifest — the negative cache must not outlive the source it was
    // proven against. No-op on the normal first init (memo is empty).
    let dropped = crate::surface_neg_cache_clear_all();
    if dropped > 0 {
        log::info!("init_resource_source: cleared {dropped} negative-cache entries from prior source");
    }
    // S14 (B1): same rule for the POSITIVE caches — decoded pixels and
    // triangulations from the old manifest are stale against a new one.
    let dropped_pixels = crate::surface_pixel_cache_clear_all();
    let dropped_tris = crate::model_tri_cache_clear_all();
    if dropped_pixels > 0 || dropped_tris > 0 {
        log::info!(
            "init_resource_source: cleared {dropped_pixels} surface-cache + {dropped_tris} tri-memo entries from prior source"
        );
    }
    Ok(())
}

/// True if [`init_resource_source`] has been called and resolved
/// successfully. Smoke tests use this to gate manifest-mode
/// assertions.
#[wasm_bindgen]
pub fn has_resource_source() -> bool {
    SOURCE.with(|cell| cell.borrow().is_some())
}

/// Number of records currently in the manifest source's shard
/// cache (excludes the boot pack). Smoke tests use this to assert
/// `prefetch` actually populates the cache.
#[wasm_bindgen]
pub fn cached_shard_count() -> usize {
    SOURCE.with(|cell| {
        cell.borrow()
            .as_ref()
            .map(|s| s.cached_shard_count())
            .unwrap_or(0)
    })
}

/// Manifest schema version of the connected source — `1` for v1,
/// `2` for v2 (Phase 5.2), `0` if [`init_resource_source`] hasn't
/// been called. Smoke tests use this to verify v1 / v2 dispatch
/// works as expected.
#[wasm_bindgen]
pub fn manifest_version() -> u32 {
    SOURCE.with(|cell| {
        cell.borrow()
            .as_ref()
            .map(|s| s.manifest_version())
            .unwrap_or(0)
    })
}

/// Number of per-namespace `NamespaceCatalog` binaries the v2
/// source has fetched + parsed. Always 0 for v1 (no catalogs in
/// the wire format). Smoke tests use this as a "did the lazy
/// catalog fetch land?" probe.
#[wasm_bindgen]
pub fn loaded_catalog_count() -> usize {
    SOURCE.with(|cell| {
        cell.borrow()
            .as_ref()
            .map(|s| s.loaded_catalog_count())
            .unwrap_or(0)
    })
}

/// The constant value of [`holtburger_manifest::v2::MANIFEST_V2_VERSION`].
/// Lets the Node smoke harness assert v2 schema constants without
/// re-vendoring them (Phase 5.2 obj 8 verification).
#[wasm_bindgen]
pub fn manifest_v2_version_const() -> u32 {
    holtburger_manifest::v2::MANIFEST_V2_VERSION
}

/// Get an `Arc` clone of the global source. Panics if
/// [`init_resource_source`] has not been called — the JS contract
/// is that init runs before any `fetch_*` does.
///
/// Used by future per-export refactors (obj 9) to swap the legacy
/// `HttpResourceSource::connect(asset_url)` constructor for
/// `global_source().prefetch(keys).await + get_file_by_key`.
///
/// Was `Rc<ManifestResourceSource>` until phase 4 step 3.6 — switched
/// to `Arc` so the same handle can satisfy `ContentRepository::
/// from_mounts(Vec<Arc<dyn ResourceSource>>)` for `WorldBootstrap`
/// loading. Atomic refcount overhead is negligible on single-threaded
/// wasm32.
#[allow(dead_code)] // wired up per-export in obj 9
pub fn global_source() -> Arc<ManifestResourceSource> {
    SOURCE.with(|cell| {
        cell.borrow()
            .as_ref()
            .cloned()
            .expect("init_resource_source must be called before any fetch_*")
    })
}

/// Try to get a clone of the global source, returning `None` if
/// init hasn't been called yet. Lets per-export code prefer the
/// global source when present and fall back to the legacy
/// `asset_url` path otherwise — the bridge state during the
/// obj-5 → obj-9 transition.
#[allow(dead_code)]
pub fn try_global_source() -> Option<Arc<ManifestResourceSource>> {
    SOURCE.with(|cell| cell.borrow().as_ref().cloned())
}

/// §2.1a — a pool-safe view of the global source.
///
/// Returns a [`DecodeSource`](crate::decode_source::DecodeSource): the same
/// underlying source, type-erased down to the SYNCHRONOUS `ResourceSource`
/// accessors only. This is what a worker thread may hold; the concrete
/// `Arc<ManifestResourceSource>` from [`global_source`] must NOT cross a
/// thread boundary, because its inherent `prefetch`/`connect` methods own the
/// `!Send` `JsFuture` machinery and the `unsafe impl Send/Sync` dedup maps
/// (`inflight.rs`, `walk_dedup.rs`) that are sound only while
/// owner-thread-confined.
///
/// The `thread_local!` `SOURCE` above is the structural half of that
/// confinement — a pool thread simply cannot reach it — and this function is
/// the sanctioned way across. See `decode_source.rs` for the full argument,
/// including why the owner keeping its own `Arc` for the page lifetime is
/// what makes an off-thread drop safe.
#[allow(dead_code)] // wired up in §2.1c when walks dispatch to the pool
pub fn decode_source() -> crate::decode_source::DecodeSource {
    crate::decode_source::DecodeSource::new(global_source())
}

/// Non-panicking twin of [`decode_source`].
#[allow(dead_code)]
pub fn try_decode_source() -> Option<crate::decode_source::DecodeSource> {
    // Closure, not `.map(DecodeSource::new)` — the `Arc<ManifestResourceSource>`
    // -> `Arc<dyn ResourceSource>` unsizing coercion applies at a call site but
    // not when naming a function item as a value (E0631).
    try_global_source().map(|s| crate::decode_source::DecodeSource::new(s))
}
