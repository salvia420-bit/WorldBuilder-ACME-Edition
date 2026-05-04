//! `ManifestResourceSource` — Phase 5.0 obj 4 implementation.
//!
//! Reads a `holtburger_manifest::Manifest` over HTTP, fetches the
//! boot pack at `connect()` time, and lazily fetches individual
//! shards on demand via the new explicit `prefetch()` method.
//!
//! # Audit findings (commit boundary 1 of Phase 5.0)
//!
//! ## (a) The `ResourceSource` trait surface is sync
//!
//! `holtburger_dat::ResourceSource` is sync. No `.await` in
//! `get_file_by_key`. Phase 5.0 keeps the trait sync; all
//! *fetching* moves to a new explicit `prefetch(&[ResourceKey])`
//! async surface called from each wasm-bindgen export before any
//! `get_file_by_key`.
//!
//! ## (b) Per-call construction pattern (legacy)
//!
//! Pre-Phase-5.0, every wasm-bindgen export in
//! `apps/holtburger-web/src/lib.rs` constructed its own
//! `HttpResourceSource::connect(asset_url)` per invocation. With
//! `ManifestResourceSource`, a single instance is constructed
//! once at page-init time (objective 5 hoist) and shared across
//! all callsites via a thread-local; `prefetch()` populates the
//! shared shard cache before each `fetch_*` body runs.
//!
//! ## (c) Records are addressed by `(namespace, file_id)`
//!
//! Manifest shard map is keyed by
//! `<namespace>:0x{file_id:08X}` strings (see
//! `holtburger_manifest::format_shard_key`); the resource source
//! composes the lookup key straight from a
//! `holtburger_dat::ResourceKey` via
//! `holtburger_manifest::key_for_resource`.
//!
//! # Pipeline
//!
//! ```text
//!   index.html
//!     │
//!     ├─→ init_resource_source(manifest_url)
//!     │     │
//!     │     ├─→ fetch manifest.json
//!     │     ├─→ parse Manifest
//!     │     ├─→ fetch boot_pack.url (HBA bytes)
//!     │     ├─→ verify boot_pack.sha256
//!     │     └─→ HbaReader::from_bytes(boot_bytes)
//!     │
//!     └─→ fetch_landblock_heightmaps(cell_ids)
//!           │
//!           ├─→ source.prefetch(keys) ─async─→ futures::try_join_all
//!           │                                    │
//!           │                                    ├─→ fetch shard URL N
//!           │                                    └─→ fetch shard URL M
//!           ├─→ for each key: source.get_file_by_key(key) ─sync─→ ...
//!           └─→ existing parse + tessellate logic
//! ```

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use holtburger_dat::{
    DatError, FileMetadata, HbaReader, ResourceKey, ResourceSource, Result as DatResult,
};
use holtburger_manifest::{Manifest, key_for_resource, sha256_hex};

use crate::http::{HttpError, fetch_bytes, join_url};

/// Failure surfaces for [`ManifestResourceSource::connect`].
#[derive(Debug)]
pub enum ManifestConnectError {
    /// Couldn't reach `fetch()` / network error / non-2xx response /
    /// body read error.
    Http(HttpError),
    /// `manifest.json` didn't parse as a [`Manifest`].
    ManifestParse(String),
    /// `boot.hba` bytes didn't parse as a valid HBA archive.
    BootParse(String),
    /// Boot pack sha256 didn't match the manifest.
    BootHashMismatch { expected: String, got: String },
}

impl std::fmt::Display for ManifestConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ManifestConnectError::Http(e) => write!(f, "{e}"),
            ManifestConnectError::ManifestParse(s) => write!(f, "manifest.json parse: {s}"),
            ManifestConnectError::BootParse(s) => write!(f, "boot.hba parse: {s}"),
            ManifestConnectError::BootHashMismatch { expected, got } => write!(
                f,
                "boot.hba hash mismatch: manifest expected {expected}, got {got}"
            ),
        }
    }
}

impl std::error::Error for ManifestConnectError {}

impl From<HttpError> for ManifestConnectError {
    fn from(value: HttpError) -> Self {
        ManifestConnectError::Http(value)
    }
}

/// Failure surfaces for [`ManifestResourceSource::prefetch`].
#[derive(Debug)]
pub enum PrefetchError {
    /// Network / HTTP / body failure on a shard fetch.
    Http(HttpError),
    /// A requested key isn't in the manifest's shard map and isn't
    /// covered by the boot pack.
    UnknownKey { namespace: String, file_id: u32 },
    /// Shard sha256 didn't match the manifest.
    HashMismatch {
        namespace: String,
        file_id: u32,
        expected: String,
        got: String,
    },
}

impl std::fmt::Display for PrefetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PrefetchError::Http(e) => write!(f, "{e}"),
            PrefetchError::UnknownKey { namespace, file_id } => {
                write!(f, "unknown shard {namespace}:0x{file_id:08X}")
            }
            PrefetchError::HashMismatch {
                namespace,
                file_id,
                expected,
                got,
            } => write!(
                f,
                "shard {namespace}:0x{file_id:08X} hash mismatch: expected {expected}, got {got}"
            ),
        }
    }
}

impl std::error::Error for PrefetchError {}

impl From<HttpError> for PrefetchError {
    fn from(value: HttpError) -> Self {
        PrefetchError::Http(value)
    }
}

/// Owned `(namespace, file_id)` cache key — `ResourceKey<'a>` is
/// borrowing, but the shard cache outlives any single call.
type OwnedKey = (String, u32);

fn owned(key: ResourceKey<'_>) -> OwnedKey {
    (key.namespace.to_owned(), key.file_id)
}

/// HTTP+manifest-backed `ResourceSource`. Holds the parsed
/// [`Manifest`] + the boot pack's [`HbaReader`] in memory plus an
/// `Arc<Mutex<HashMap>>` shard cache populated lazily via
/// [`prefetch`].
///
/// `Arc<Mutex<...>>` (rather than `Rc<RefCell<...>>`) is what the
/// `ResourceSource: Send + Sync` trait bound demands. wasm32 is
/// single-threaded so the mutex never actually contends, but the
/// trait requires the bound for native callers; the same pattern
/// is used by the existing `HttpResourceSource` (which holds a
/// `Send + Sync` `HbaReader<Vec<u8>>` directly).
pub struct ManifestResourceSource {
    manifest: Manifest,
    boot: HbaReader<Vec<u8>>,
    shards: Arc<Mutex<HashMap<OwnedKey, Vec<u8>>>>,
    base_url: String,
}

impl ManifestResourceSource {
    /// Fetch `manifest_url`, parse it, fetch the referenced boot
    /// pack, verify its sha256, and return a ready resource source.
    /// All subsequent record fetches go through [`prefetch`] +
    /// [`get_file_by_key`].
    pub async fn connect(manifest_url: &str) -> Result<Self, ManifestConnectError> {
        let manifest_bytes = fetch_bytes(manifest_url).await?;
        let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|e| ManifestConnectError::ManifestParse(e.to_string()))?;

        let base_url = url_dirname(manifest_url);
        let boot_url = join_url(manifest_url, &manifest.boot_pack.url);
        let boot_bytes = fetch_bytes(&boot_url).await?;

        let got_hash = sha256_hex(&boot_bytes);
        if got_hash != manifest.boot_pack.sha256 {
            return Err(ManifestConnectError::BootHashMismatch {
                expected: manifest.boot_pack.sha256.clone(),
                got: got_hash,
            });
        }

        let boot = HbaReader::<Vec<u8>>::from_bytes(boot_bytes)
            .map_err(|e| ManifestConnectError::BootParse(e.to_string()))?;

        Ok(Self {
            manifest,
            boot,
            shards: Arc::new(Mutex::new(HashMap::new())),
            base_url,
        })
    }

    /// Walk `keys`, skip those served from the boot pack or already
    /// cached, look up shard URLs in the manifest, fetch in
    /// parallel, verify sha256, and insert into the shard cache.
    ///
    /// Errors: [`PrefetchError::UnknownKey`] if any key is missing
    /// from the manifest *and* the boot pack;
    /// [`PrefetchError::HashMismatch`] if a shard fetch returns
    /// wrong bytes; otherwise an HTTP-layer failure on at least
    /// one shard fetch.
    pub async fn prefetch(&self, keys: &[ResourceKey<'_>]) -> Result<(), PrefetchError> {
        // Plan: collect (key, ShardEntry, full_url) for every key
        // not already served by boot or the cache. Bail with
        // UnknownKey if any are missing from the manifest entirely.
        let mut to_fetch: Vec<(OwnedKey, holtburger_manifest::ShardEntry, String)> =
            Vec::new();
        {
            let cached = self.shards.lock().expect("shard cache mutex poisoned");
            for key in keys {
                if self.boot_serves(*key) {
                    continue;
                }
                if cached.contains_key(&owned(*key)) {
                    continue;
                }
                let shard = self.manifest.shards.get(&key_for_resource(*key)).cloned();
                match shard {
                    Some(entry) => {
                        let url = join_url(&self.base_url_with_slash(), &entry.url);
                        to_fetch.push((owned(*key), entry, url));
                    }
                    None => {
                        return Err(PrefetchError::UnknownKey {
                            namespace: key.namespace.to_owned(),
                            file_id: key.file_id,
                        });
                    }
                }
            }
        }

        if to_fetch.is_empty() {
            return Ok(());
        }

        let fetches = to_fetch.iter().map(|(_, _, url)| {
            let url = url.clone();
            async move { fetch_bytes(&url).await }
        });
        let bytes_vec = futures::future::try_join_all(fetches)
            .await
            .map_err(PrefetchError::Http)?;

        let mut cache = self.shards.lock().expect("shard cache mutex poisoned");
        for ((key, entry, _), bytes) in to_fetch.into_iter().zip(bytes_vec) {
            let got = sha256_hex(&bytes);
            if got != entry.sha256 {
                return Err(PrefetchError::HashMismatch {
                    namespace: key.0,
                    file_id: key.1,
                    expected: entry.sha256,
                    got,
                });
            }
            cache.insert(key, bytes);
        }
        Ok(())
    }

    /// True if the boot pack reader has the record for `key` —
    /// either via the manifest's `covers` list or via a fallback
    /// direct lookup against the parsed HBA.
    fn boot_serves(&self, key: ResourceKey<'_>) -> bool {
        if self.manifest.boot_covers(key) {
            return true;
        }
        // The covers list is the authoritative + fast path; this
        // fallback handles the case where a producer omitted a
        // record from `covers` but the boot HBA still contains it.
        self.boot.exists_by_key(key)
    }

    /// Manifest the source was constructed with. Smoke tests use
    /// this for round-trip checks.
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    /// Number of records currently in the shard cache (excludes
    /// the boot pack). Smoke tests use this as a
    /// "did prefetch land?" probe.
    pub fn cached_shard_count(&self) -> usize {
        self.shards.lock().expect("shard cache mutex poisoned").len()
    }

    fn base_url_with_slash(&self) -> String {
        if self.base_url.is_empty() {
            String::new()
        } else if self.base_url.ends_with('/') {
            self.base_url.clone()
        } else {
            format!("{}/", self.base_url)
        }
    }
}

impl ResourceSource for ManifestResourceSource {
    fn get_file_by_key(&self, key: ResourceKey<'_>) -> DatResult<Vec<u8>> {
        if let Ok(bytes) = self.boot.get_file_by_key(key) {
            return Ok(bytes);
        }
        if let Some(bytes) = self
            .shards
            .lock()
            .expect("shard cache mutex poisoned")
            .get(&owned(key))
        {
            return Ok(bytes.clone());
        }
        Err(DatError::Other(format!(
            "ManifestResourceSource: record not prefetched: {}:0x{:08X}; call prefetch() first",
            key.namespace, key.file_id
        )))
    }

    fn get_metadata_by_key(&self, key: ResourceKey<'_>) -> Option<FileMetadata> {
        if let Some(meta) = self.boot.get_metadata_by_key(key) {
            return Some(meta);
        }
        let cache = self.shards.lock().expect("shard cache mutex poisoned");
        cache.get(&owned(key)).map(|bytes| FileMetadata {
            id: key.file_id,
            size: bytes.len() as u32,
            is_pruned: false,
        })
    }

    fn has_namespace(&self, namespace: &str) -> bool {
        if self.boot.has_namespace(namespace) {
            return true;
        }
        let prefix = format!("{namespace}:");
        self.manifest
            .shards
            .keys()
            .any(|k| k.starts_with(&prefix))
    }
}

/// Strip the last path component from a URL. `https://x/y/m.json`
/// → `https://x/y`. Used to anchor relative shard URLs.
fn url_dirname(url: &str) -> String {
    url.rsplit_once('/')
        .map(|(d, _)| d.to_owned())
        .unwrap_or_default()
}
