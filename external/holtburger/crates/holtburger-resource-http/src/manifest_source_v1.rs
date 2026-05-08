//! v1 `ManifestResourceSource` — Phase 5.0 obj 4 implementation.
//!
//! This module is the pre-Phase-5.2 wire format: a single
//! `manifest.json` listing every shard verbose-mapped from
//! `<namespace>:0x{file_id:08X}` to `(sha256, size, url)`. Real-world
//! bakes against the full Dereth DATs produced 203 MB of JSON, which
//! Phase 5.2 collapsed by moving to a top-level pointer + lazy
//! per-namespace binary catalogs (see `manifest_source.rs` for the
//! v2 implementation).
//!
//! Kept callable so [`super::ManifestResourceSource::connect`] can
//! still serve in-flight v1 deployments for one release cycle. New
//! code should never construct this directly — go through the
//! version-sniffing wrapper.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use holtburger_dat::{
    DatError, FileMetadata, HbaReader, ResourceKey, ResourceSource, Result as DatResult,
};
use holtburger_manifest::{Manifest, key_for_resource, sha256_hex};

use crate::http::{fetch_bytes, join_url};
use crate::manifest_source::{
    ManifestConnectError, OwnedKey, PrefetchError, owned, url_dirname,
};

/// v1 manifest source. Reads the full `shards` map at connect time
/// and fetches individual shards on demand via [`prefetch`]. New
/// callers should use the v2 path; the v2 wrapper falls back to
/// this implementation when it sees `version: 1`.
pub struct ManifestResourceSourceV1 {
    manifest: Manifest,
    boot: HbaReader<Vec<u8>>,
    shards: Arc<Mutex<HashMap<OwnedKey, Vec<u8>>>>,
    base_url: String,
}

impl ManifestResourceSourceV1 {
    /// Build the v1 source from already-fetched manifest bytes plus
    /// the original manifest URL (used to anchor relative shard
    /// URLs). Fetches the boot pack itself.
    pub(crate) async fn from_manifest_bytes(
        manifest: Manifest,
        manifest_url: &str,
    ) -> Result<Self, ManifestConnectError> {
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

    pub(crate) async fn prefetch(
        &self,
        keys: &[ResourceKey<'_>],
    ) -> Result<(), PrefetchError> {
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
                if let Some(entry) = shard {
                    let url = join_url(&self.base_url_with_slash(), &entry.url);
                    to_fetch.push((owned(*key), entry, url));
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

    fn boot_serves(&self, key: ResourceKey<'_>) -> bool {
        if self.manifest.boot_covers(key) {
            return true;
        }
        self.boot.exists_by_key(key)
    }

    pub(crate) fn cached_shard_count(&self) -> usize {
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

impl ResourceSource for ManifestResourceSourceV1 {
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
            "ManifestResourceSource(v1): record not prefetched: {}:0x{:08X}; call prefetch() first",
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
        self.manifest.shards.keys().any(|k| k.starts_with(&prefix))
    }
}

