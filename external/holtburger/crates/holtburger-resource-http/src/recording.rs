//! `RecordingSource` — the miss-recording `ResourceSource` wrapper.
//!
//! Split out of `manifest_source.rs` (A15 S2, 2026-07-24) for one reason:
//! `manifest_source` is `#[cfg(target_arch = "wasm32")]` because every path in
//! it goes through `web_sys::fetch`, but this wrapper is pure std + the
//! `ResourceSource` trait. Living here makes it natively testable, which is
//! what lets `get_file_shared_forwards_through_every_wrapper` (apps/
//! holtburger-web) assert Arc pointer identity through the REAL type instead
//! of a stand-in. Same public path (`holtburger_resource_http::RecordingSource`)
//! — no caller changes.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use holtburger_dat::{FileMetadata, ResourceKey, ResourceSource, Result as DatResult};

/// `ResourceSource` wrapper that records every key whose
/// `get_file_by_key` call returns `Err`. Lets a caller run a
/// best-effort sync walk against an under-hydrated source, collect
/// every key the walk asked for and missed, prefetch them, and
/// re-run the walk. Repeat until the miss set is empty.
///
/// Used by Phase 5.0b's `fetch_*` exports to drive iterative
/// shard discovery without async-ifying every helper function in
/// `apps/holtburger-web`. Phase 5.1's `dat-shard` boot-pack
/// transitive walk uses the same pattern against `HbaReader`-backed
/// sources where misses are permanent (then the recorded set tells
/// the caller which records to skip rather than prefetch).
pub struct RecordingSource<'a> {
    inner: &'a (dyn ResourceSource + 'a),
    misses: Mutex<HashSet<(String, u32)>>,
}

impl<'a> RecordingSource<'a> {
    pub fn new(inner: &'a (dyn ResourceSource + 'a)) -> Self {
        Self {
            inner,
            misses: Mutex::new(HashSet::new()),
        }
    }

    /// Drain the recorded miss set, returning each
    /// `(namespace, file_id)` pair the wrapped source returned
    /// `Err` for since the last `take_misses` call.
    pub fn take_misses(&self) -> Vec<(String, u32)> {
        let mut guard = self.misses.lock().expect("recording-source mutex poisoned");
        std::mem::take(&mut *guard).into_iter().collect()
    }
}

impl<'a> ResourceSource for RecordingSource<'a> {
    fn get_file_by_key(&self, key: ResourceKey<'_>) -> DatResult<Vec<u8>> {
        match self.inner.get_file_by_key(key) {
            Ok(b) => Ok(b),
            Err(e) => {
                self.misses
                    .lock()
                    .expect("recording-source mutex poisoned")
                    .insert((key.namespace.to_owned(), key.file_id));
                Err(e)
            }
        }
    }

    /// A15 S2 forward — must record the miss exactly like `get_file_by_key`,
    /// or a hot reader switched to the shared path would stop feeding the
    /// iterative shard-discovery loop and the walk would conclude early.
    fn get_file_shared(&self, key: ResourceKey<'_>) -> DatResult<Arc<Vec<u8>>> {
        match self.inner.get_file_shared(key) {
            Ok(b) => Ok(b),
            Err(e) => {
                self.misses
                    .lock()
                    .expect("recording-source mutex poisoned")
                    .insert((key.namespace.to_owned(), key.file_id));
                Err(e)
            }
        }
    }

    fn get_metadata_by_key(&self, key: ResourceKey<'_>) -> Option<FileMetadata> {
        self.inner.get_metadata_by_key(key)
    }

    fn has_namespace(&self, namespace: &str) -> bool {
        self.inner.has_namespace(namespace)
    }

    fn key_known_absent(&self, key: ResourceKey<'_>) -> bool {
        self.inner.key_known_absent(key)
    }
}
