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
