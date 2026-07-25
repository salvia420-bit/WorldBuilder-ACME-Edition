//! §2.1a — the pool-facing decode handle.
//!
//! `SCOPE-2.1-fetch-decode-boundary-2026-07-24.md` §1c: the wasm-threads (SAB)
//! work does NOT need the `unsafe impl Send/Sync` on the inflight/walk-dedup
//! maps removed — `JsFuture` is genuinely `!Send`, so they cannot be made
//! honestly shareable. What it needs is a *proof the pool can never reach
//! them*. This type is that proof, by construction.
//!
//! [`DecodeSource`] exposes ONLY the synchronous `ResourceSource` surface —
//! the byte accessors that read `boot` (owned `Vec<u8>`) and `shards`
//! (`Arc<Mutex<HashMap<_, Vec<u8>>>>`), both genuinely `Send + Sync` data. The
//! async surface that owns the `!Send` machinery — `ManifestResourceSource::
//! prefetch` / `prefetch_urgent` / `connect`, and through them `InflightMap`
//! (`inflight.rs`) and `WalkDedupMap` (`walk_dedup.rs`) — is unreachable
//! through this handle because those are inherent methods on the concrete
//! type, not trait methods, and this type erases the concrete type.
//!
//! # Safety argument for handing this to another thread
//!
//! Two things make a pool thread holding a `DecodeSource` sound even though
//! the pointee (a `ManifestResourceSource`) transitively owns `!Send` state:
//!
//! 1. **Unreachable, not absent.** The `!Send` state is still *in* the
//!    pointee; the pool simply has no way to name a method that touches it.
//!    Calling any of the five trait methods only reads `boot`/`shards`.
//! 2. **Never the last `Arc`.** `global_source::SOURCE` is a `thread_local!`
//!    on the owner thread that holds its own `Arc` for the page lifetime, so a
//!    `DecodeSource` dropped on a pool thread only does an atomic refcount
//!    decrement — it can never run the pointee's destructor, which would drop
//!    `Shared<LocalBoxFuture>` off-thread. **This invariant is load-bearing:**
//!    if the global source is ever cleared while pool threads hold handles,
//!    revisit this. (`init_resource_source` *replaces* the `Arc` rather than
//!    clearing it, and does so on the owner thread.)
//!
//! Note that `global_source::SOURCE` being `thread_local!` is *correct* here
//! and must NOT be "fixed" the way §2.2 converted the decode caches: it is
//! precisely what stops a pool thread from obtaining the concrete
//! `ManifestResourceSource` in the first place.
//!
//! # What this does not do
//!
//! Nothing dispatches to a pool yet — that is §2.1c. This is the handle that
//! makes such a dispatch expressible without widening the `unsafe` surface.

#![cfg(any(target_arch = "wasm32", test))]

use std::sync::Arc;

use holtburger_dat::{FileMetadata, ResourceKey, ResourceSource, Result as DatResult};

/// Pool-facing, clonable, type-erased view of a resource source exposing only
/// the synchronous byte accessors. See the module docs for the safety
/// argument. `Send + Sync` come from `ResourceSource`'s own supertraits.
#[derive(Clone)]
pub struct DecodeSource(Arc<dyn ResourceSource>);

impl DecodeSource {
    pub fn new(inner: Arc<dyn ResourceSource>) -> Self {
        Self(inner)
    }
}

// Forwards ALL SIX methods, including the three provided ones. `exists_by_key`
// and `key_known_absent` have defaults, but concrete sources override them
// (the trait docs for `key_known_absent` say "wrappers forward to their inner
// source"), so relying on the defaults here would silently change behaviour —
// `key_known_absent` in particular gates the negative cache, and defaulting it
// to `false` would only lose absence proofs, which is the quiet direction.
impl ResourceSource for DecodeSource {
    fn get_file_by_key(&self, key: ResourceKey<'_>) -> DatResult<Vec<u8>> {
        self.0.get_file_by_key(key)
    }

    /// A15 S2 forward. Without it this wrapper would fall back to the trait
    /// default and re-copy every record the pool reads — silently, since the
    /// default is correct, just slow.
    fn get_file_shared(&self, key: ResourceKey<'_>) -> DatResult<Arc<Vec<u8>>> {
        self.0.get_file_shared(key)
    }

    fn get_metadata_by_key(&self, key: ResourceKey<'_>) -> Option<FileMetadata> {
        self.0.get_metadata_by_key(key)
    }

    fn has_namespace(&self, namespace: &str) -> bool {
        self.0.has_namespace(namespace)
    }

    fn exists_by_key(&self, key: ResourceKey<'_>) -> bool {
        self.0.exists_by_key(key)
    }

    fn key_known_absent(&self, key: ResourceKey<'_>) -> bool {
        self.0.key_known_absent(key)
    }
}

/// Compile-time proof of the property this type exists for. If a future edit
/// gives `DecodeSource` a `!Send`/`!Sync` field, this fails to compile rather
/// than failing at runtime on a pool thread.
const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    let _ = assert_send_sync::<DecodeSource>;
};

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_dat::DatError;
    use std::collections::HashMap;

    struct Mock {
        files: HashMap<(String, u32), Vec<u8>>,
        absent: bool,
    }

    impl ResourceSource for Mock {
        fn get_file_by_key(&self, key: ResourceKey<'_>) -> DatResult<Vec<u8>> {
            self.files
                .get(&(key.namespace.to_string(), key.file_id))
                .cloned()
                .ok_or_else(|| DatError::Other("missing".into()))
        }
        fn get_metadata_by_key(&self, key: ResourceKey<'_>) -> Option<FileMetadata> {
            self.files
                .get(&(key.namespace.to_string(), key.file_id))
                .map(|b| FileMetadata {
                    id: key.file_id,
                    size: b.len() as u32,
                    is_pruned: false,
                })
        }
        fn has_namespace(&self, namespace: &str) -> bool {
            namespace == "eor/portal"
        }
        // Overridden, NOT defaulted — the forwarding test below would pass
        // vacuously against a source that just uses the trait defaults.
        fn key_known_absent(&self, _key: ResourceKey<'_>) -> bool {
            self.absent
        }
    }

    fn mock(absent: bool) -> DecodeSource {
        let mut files = HashMap::new();
        files.insert(("eor/portal".to_string(), 0x0100_0001u32), vec![1, 2, 3, 4]);
        DecodeSource::new(Arc::new(Mock { files, absent }))
    }

    /// The property §2.1a exists for: a decode handle can cross to another
    /// thread and still serve bytes. Under the pool this is how walk closures
    /// will reach records without ever touching `ManifestResourceSource`.
    #[test]
    fn decode_source_serves_bytes_from_another_thread() {
        let src = mock(false);
        let moved = src.clone();
        let got = std::thread::spawn(move || {
            moved
                .get_file_by_key(ResourceKey::new("eor/portal", 0x0100_0001))
                .map(|b| b.len())
        })
        .join()
        .expect("decode thread panicked");
        assert_eq!(got.ok(), Some(4), "bytes must be readable off-thread");
        // Original handle still usable — the clone did not consume it.
        assert!(src.has_namespace("eor/portal"));
    }

    /// Guards the wrapper trap: forwarding only the three REQUIRED methods
    /// would silently fall back to the trait defaults for the two provided
    /// ones. `key_known_absent` defaults to `false`, so a missed forward
    /// reads as "cannot prove absent" — it would quietly disable negative
    /// caching rather than fail loudly.
    #[test]
    fn decode_source_forwards_provided_methods_not_defaults() {
        let key = ResourceKey::new("eor/portal", 0x0999_9999);
        assert!(
            mock(true).key_known_absent(key),
            "key_known_absent must forward to the inner source, not default to false"
        );
        assert!(!mock(false).key_known_absent(key));
        assert!(
            mock(false).exists_by_key(ResourceKey::new("eor/portal", 0x0100_0001)),
            "exists_by_key must forward"
        );
    }
}
