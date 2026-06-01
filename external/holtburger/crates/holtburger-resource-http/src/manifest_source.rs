//! `ManifestResourceSource` — Phase 5.0 obj 4 + Phase 5.2 obj 4.
//!
//! Reads a manifest over HTTP, fetches the boot pack at `connect()`
//! time, and lazily fetches individual shards on demand via the
//! explicit `prefetch()` method.
//!
//! Phase 5.0 (v1) was a flat `manifest.json` with one
//! `(namespace:0xFILEID) → (sha256, size, url)` row per shard. Real-
//! world Dereth bakes produced 203 MB of JSON because `eor/cell`
//! dominated the entry count.
//!
//! Phase 5.2 (v2) lifts the per-shard listing out of the top-level
//! manifest. The top-level shrinks to ≈2 KB (boot pack + namespaces
//! + URL templates); each namespace's per-record listing lives in
//! a lazily-fetched compact binary `NamespaceCatalog` at
//! `manifest/<namespace_slug>.bin`. Convention-URL mode (no catalog
//! at all) is also supported — shard URLs derive from
//! `(namespace, file_id)` directly via the `shard_url_template` and
//! 404 is treated as "record doesn't exist" silent-skip.
//!
//! `connect()` sniffs the `version` field via the cheap
//! [`ManifestVersionProbe`] deserializer, dispatches to v1 or v2,
//! and returns a wrapper enum. Both halves implement
//! [`ResourceSource`] so consumers don't care which wire format
//! they're talking to. v1 stays one release cycle to drain
//! in-flight CDN deploys; the warning log makes that visible.
//!
//! # Testing
//!
//! This crate is `#![cfg(target_arch = "wasm32")]` because every
//! HTTP path goes through `web_sys::fetch`. Pure-data unit tests
//! for the v2 dispatch logic live in `holtburger-manifest::v2`
//! (cross-platform), exercising:
//!
//! - [`ManifestVersionProbe`] sniff against v1 / v2 / unknown /
//!   malformed JSON inputs
//! - URL-template rendering in catalog mode + convention-URL mode
//! - `ManifestV2::shard_url` / `catalog_url` round-trips
//!
//! Integration tests covering the full connect → prefetch → fetch
//! chain are deferred to the Node smoke harness (Phase 5.2 obj 8 —
//! `apps/holtburger-web/smoke_test.cjs`), which spins up an HTTP
//! server, bakes a v2 manifest fixture via `dat-shard`, and
//! exercises the wasm bundle end-to-end against it.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use holtburger_dat::{
    DatError, FileMetadata, HbaReader, ResourceKey, ResourceSource, Result as DatResult,
};
use holtburger_manifest::{
    Manifest, sha256_hex,
    catalog::NamespaceCatalog,
    v2::{MANIFEST_V2_VERSION, ManifestV2, ManifestVersionProbe, render_shard_url_full},
};

use crate::concurrency::{DEFAULT_FETCH_CONCURRENCY, Semaphore};
use crate::http::{HttpError, fetch_bytes, join_url};
use crate::inflight::InflightMap;
use crate::manifest_source_v1::ManifestResourceSourceV1;

/// F1 tuning hook: a JS global `globalThis.__hbFetchConcurrency` (a positive
/// number set before boot) overrides [`DEFAULT_FETCH_CONCURRENCY`] for the
/// per-source shard-fetch cap, so the value can be A/B-tuned without a wasm
/// rebuild. Absent / non-numeric / < 1 → the compiled default. Reads the
/// global via `js_sys::global()` so it works in both window + worker contexts.
pub(crate) fn configured_fetch_concurrency() -> usize {
    let g = js_sys::global();
    let v = js_sys::Reflect::get(
        g.as_ref(),
        &wasm_bindgen::JsValue::from_str("__hbFetchConcurrency"),
    )
    .ok()
    .and_then(|val| val.as_f64());
    match v {
        Some(n) if n >= 1.0 => n as usize,
        _ => DEFAULT_FETCH_CONCURRENCY,
    }
}

/// Failure surfaces for [`ManifestResourceSource::connect`].
#[derive(Debug)]
pub enum ManifestConnectError {
    /// Couldn't reach `fetch()` / network error / non-2xx response /
    /// body read error.
    Http(HttpError),
    /// `manifest.json` didn't parse as a [`Manifest`] or
    /// [`ManifestV2`] at the version-detected variant.
    ManifestParse(String),
    /// `boot.hba` bytes didn't parse as a valid HBA archive.
    BootParse(String),
    /// Boot pack sha256 didn't match the manifest.
    BootHashMismatch { expected: String, got: String },
    /// `version` field was neither 1 nor 2 — older or newer than
    /// this build supports.
    UnsupportedVersion(u32),
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
            ManifestConnectError::UnsupportedVersion(v) => write!(
                f,
                "unsupported manifest version {v}: this build expects 1 or 2"
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
    /// (v1 only) A requested key isn't in the manifest's shard map
    /// and isn't covered by the boot pack. v2 uses
    /// catalog-presence-or-convention-URL semantics instead and
    /// never surfaces this variant.
    UnknownKey { namespace: String, file_id: u32 },
    /// Shard sha256 didn't match the catalog entry (v2) or the
    /// manifest entry (v1).
    HashMismatch {
        namespace: String,
        file_id: u32,
        expected: String,
        got: String,
    },
    /// (v2 only) Per-namespace catalog couldn't be fetched.
    CatalogFetch { namespace: String, source: HttpError },
    /// (v2 only) Per-namespace catalog parsed cleanly at the HTTP
    /// layer but the binary body failed magic / version / CRC /
    /// truncation checks.
    CatalogParse { namespace: String, message: String },
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
            PrefetchError::CatalogFetch { namespace, source } => write!(
                f,
                "catalog fetch failed for namespace {namespace}: {source}"
            ),
            PrefetchError::CatalogParse { namespace, message } => write!(
                f,
                "catalog parse failed for namespace {namespace}: {message}"
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
pub(crate) type OwnedKey = (String, u32);

pub(crate) fn owned(key: ResourceKey<'_>) -> OwnedKey {
    (key.namespace.to_owned(), key.file_id)
}

/// HTTP+manifest-backed `ResourceSource`. Internally an enum that
/// dispatches between the v1 (Phase 5.0) and v2 (Phase 5.2) wire
/// formats — [`connect`] sniffs the version field once and parks
/// the right inner source. All public methods delegate.
///
/// `Arc<Mutex<...>>` (rather than `Rc<RefCell<...>>`) is what the
/// `ResourceSource: Send + Sync` trait bound demands. wasm32 is
/// single-threaded so the mutex never actually contends, but the
/// trait requires the bound for native callers.
pub enum ManifestResourceSource {
    V1(ManifestResourceSourceV1),
    V2(V2Source),
}

/// Inner v2 state. Public-in-crate so the v1 file can share helper
/// types but external callers always go through [`ManifestResourceSource`].
pub struct V2Source {
    manifest: ManifestV2,
    boot: HbaReader<Vec<u8>>,
    catalogs: Arc<Mutex<HashMap<String, NamespaceCatalog>>>,
    shards: Arc<Mutex<HashMap<OwnedKey, Vec<u8>>>>,
    base_url: String,
    /// F.35: in-flight URL-fetch dedup map. When N concurrent
    /// `prefetch(keys)` calls overlap on a shard URL or catalog URL,
    /// all waiters latch onto a single underlying `fetch_bytes`
    /// resolution. Eliminates the 13-second-spawn drain (D-polish /
    /// Phase E / F.D) caused by 119 callers each independently
    /// firing redundant copies of ~50 shared URLs through the
    /// browser's 6-connection cap.
    ///
    /// `Arc<InflightMap>` so the underlying map outlives any single
    /// `prefetch` call (multiple concurrent `prefetch` invocations
    /// can be in flight simultaneously, each holding a reference).
    inflight: Arc<InflightMap<HttpError>>,
    /// F1 (2026-06-01): global cap on concurrent shard `fetch_bytes`
    /// calls. Shared across all overlapping `prefetch()` invocations
    /// (one source instance per page), so the 8+ per-LB bakers can no
    /// longer stack to a 218-deep fetch burst against the browser's
    /// 6-connection/origin HTTP/1.1 limit.
    fetch_sem: Semaphore,
}

impl ManifestResourceSource {
    /// Fetch `manifest_url`, parse it, fetch the referenced boot
    /// pack, verify its sha256, and return a ready resource source.
    /// Routes between v1 and v2 based on the manifest's `version`
    /// field.
    pub async fn connect(manifest_url: &str) -> Result<Self, ManifestConnectError> {
        let manifest_bytes = fetch_bytes(manifest_url).await?;

        let probe: ManifestVersionProbe = serde_json::from_slice(&manifest_bytes)
            .map_err(|e| ManifestConnectError::ManifestParse(e.to_string()))?;

        match probe.version {
            1 => {
                log::warn!(
                    "manifest.json is v1 (deprecated). Re-bake with `dat-shard --manifest-version=2` to drop the 203 MB top-level JSON cliff."
                );
                let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
                    .map_err(|e| ManifestConnectError::ManifestParse(e.to_string()))?;
                let v1 =
                    ManifestResourceSourceV1::from_manifest_bytes(manifest, manifest_url).await?;
                Ok(Self::V1(v1))
            }
            MANIFEST_V2_VERSION => {
                let manifest: ManifestV2 = serde_json::from_slice(&manifest_bytes)
                    .map_err(|e| ManifestConnectError::ManifestParse(e.to_string()))?;
                let v2 = V2Source::from_manifest(manifest, manifest_url).await?;
                Ok(Self::V2(v2))
            }
            other => Err(ManifestConnectError::UnsupportedVersion(other)),
        }
    }

    /// Walk `keys`, skip those served from the boot pack or already
    /// cached, ensure per-namespace catalogs are loaded (v2 only),
    /// fetch shards in parallel, verify hashes when available, and
    /// insert into the shard cache.
    pub async fn prefetch(&self, keys: &[ResourceKey<'_>]) -> Result<(), PrefetchError> {
        match self {
            Self::V1(s) => s.prefetch(keys).await,
            Self::V2(s) => s.prefetch(keys).await,
        }
    }

    /// Number of records currently in the shard cache (excludes
    /// the boot pack). Smoke tests use this as a "did prefetch
    /// land?" probe.
    pub fn cached_shard_count(&self) -> usize {
        match self {
            Self::V1(s) => s.cached_shard_count(),
            Self::V2(s) => s.cached_shard_count(),
        }
    }

    /// Manifest format version: 1 or 2. Lets callers branch on
    /// which wire format the connected source loaded.
    pub fn manifest_version(&self) -> u32 {
        match self {
            Self::V1(_) => 1,
            Self::V2(_) => MANIFEST_V2_VERSION,
        }
    }

    /// Number of per-namespace catalogs currently loaded. Always 0
    /// for v1; for v2 reflects how many `manifest/<namespace>.bin`
    /// blobs the source has fetched + parsed.
    pub fn loaded_catalog_count(&self) -> usize {
        match self {
            Self::V1(_) => 0,
            Self::V2(s) => s.loaded_catalog_count(),
        }
    }
}

impl ResourceSource for ManifestResourceSource {
    fn get_file_by_key(&self, key: ResourceKey<'_>) -> DatResult<Vec<u8>> {
        match self {
            Self::V1(s) => s.get_file_by_key(key),
            Self::V2(s) => s.get_file_by_key(key),
        }
    }

    fn get_metadata_by_key(&self, key: ResourceKey<'_>) -> Option<FileMetadata> {
        match self {
            Self::V1(s) => s.get_metadata_by_key(key),
            Self::V2(s) => s.get_metadata_by_key(key),
        }
    }

    fn has_namespace(&self, namespace: &str) -> bool {
        match self {
            Self::V1(s) => s.has_namespace(namespace),
            Self::V2(s) => s.has_namespace(namespace),
        }
    }
}

impl V2Source {
    /// Build the v2 source from already-fetched manifest bytes plus
    /// the original manifest URL (used to anchor relative shard
    /// URLs). Fetches the boot pack itself and verifies its sha256.
    async fn from_manifest(
        manifest: ManifestV2,
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
            catalogs: Arc::new(Mutex::new(HashMap::new())),
            shards: Arc::new(Mutex::new(HashMap::new())),
            base_url,
            inflight: Arc::new(InflightMap::new()),
            fetch_sem: Semaphore::new(configured_fetch_concurrency()),
        })
    }

    /// v2 prefetch: lazy-fetch any per-namespace catalogs we don't
    /// have yet (when the manifest declares a catalog template),
    /// then look up each requested key — silent-skip when the
    /// catalog confirms the record doesn't exist, otherwise build
    /// a shard URL via the `shard_url_template` and fetch in
    /// parallel. Verifies sha256 against the catalog entry when
    /// available; convention-URL mode skips verification.
    async fn prefetch(&self, keys: &[ResourceKey<'_>]) -> Result<(), PrefetchError> {
        // Step A: filter out boot-served + already-cached keys.
        let mut work_keys: Vec<OwnedKey> = Vec::new();
        {
            let cached = self.shards.lock().expect("shard cache mutex poisoned");
            for key in keys {
                if self.boot_serves(*key) {
                    continue;
                }
                if cached.contains_key(&owned(*key)) {
                    continue;
                }
                work_keys.push(owned(*key));
            }
        }
        if work_keys.is_empty() {
            return Ok(());
        }

        // Step B: figure out which namespace catalogs we still
        // need to fetch (v2 catalog-mode only). Skip if the manifest
        // declares no catalog template — that's convention-URL mode.
        if self.manifest.catalog_url_template.is_some() {
            let needed_namespaces: HashSet<String> = {
                let catalogs = self.catalogs.lock().expect("catalog cache mutex poisoned");
                work_keys
                    .iter()
                    .map(|(ns, _)| ns.clone())
                    .filter(|ns| !catalogs.contains_key(ns))
                    .filter(|ns| self.manifest.namespaces.iter().any(|n| n == ns))
                    .collect()
            };

            if !needed_namespaces.is_empty() {
                let catalog_fetches = needed_namespaces.iter().map(|ns| {
                    let url = self
                        .manifest
                        .catalog_url(ns)
                        .expect("template present; checked above");
                    let full_url = join_url(&self.base_url_with_slash(), &url);
                    let ns = ns.clone();
                    let inflight = self.inflight.clone();
                    async move {
                        // F.35: dedup via the per-URL in-flight map.
                        // Concurrent prefetch calls for the same
                        // namespace catalog all latch onto a single
                        // fetch resolution.
                        let result = {
                            let full_url_for_fetch = full_url.clone();
                            inflight
                                .get_or_fetch(&full_url, move || {
                                    let u = full_url_for_fetch.clone();
                                    async move { fetch_bytes(&u).await }
                                })
                                .await
                        };
                        match result {
                            Ok(bytes) => Ok::<(String, Option<Vec<u8>>), PrefetchError>((
                                ns,
                                Some(bytes),
                            )),
                            Err(arc_err) => {
                                // 404 on a declared namespace's catalog
                                // means the namespace is empty after
                                // bake-time pruning — treat as
                                // "no catalog, fall through to
                                // convention URLs".
                                if matches!(
                                    arc_err.as_ref(),
                                    HttpError::Http { status: 404, .. }
                                ) {
                                    Ok((ns, None))
                                } else {
                                    Err(PrefetchError::CatalogFetch {
                                        namespace: ns,
                                        source: arc_to_http_error(arc_err),
                                    })
                                }
                            }
                        }
                    }
                });

                let fetched = futures::future::try_join_all(catalog_fetches).await?;
                let mut cs = self.catalogs.lock().expect("catalog cache mutex poisoned");
                for (ns, bytes_opt) in fetched {
                    if let Some(bytes) = bytes_opt {
                        let catalog = NamespaceCatalog::read_from(&bytes, ns.clone()).map_err(
                            |e| PrefetchError::CatalogParse {
                                namespace: ns.clone(),
                                message: e.to_string(),
                            },
                        )?;
                        cs.insert(ns, catalog);
                    }
                    // 404 namespaces stay absent from the catalog
                    // map; the per-key lookup below will route
                    // them through convention-URL mode.
                }
            }
        }

        // Step C: build the shard fetch list. For each key:
        //   - catalog present + entry present → URL via template
        //     with the catalog's truncated sha256; verify on receive
        //   - catalog present + entry missing → silent skip
        //   - no catalog → URL via template using convention
        //     substitutions ({namespace_slug} + {file_id_hex});
        //     no sha256 verification, 404 = silent skip
        struct ShardTask {
            key: OwnedKey,
            url: String,
            expected_trunc: Option<[u8; 16]>,
            tolerate_404: bool,
        }

        let mut shard_tasks: Vec<ShardTask> = Vec::new();
        {
            let catalogs = self.catalogs.lock().expect("catalog cache mutex poisoned");
            for (ns, file_id) in &work_keys {
                let key_borrowed = ResourceKey {
                    namespace: ns.as_str(),
                    file_id: *file_id,
                };

                if let Some(catalog) = catalogs.get(ns) {
                    if let Some(entry) = catalog.lookup(*file_id) {
                        let hash_hex = hex_encode_16(&entry.sha256_truncated);
                        let url = render_shard_url_full(
                            &self.manifest.shard_url_template,
                            key_borrowed,
                            &hash_hex,
                        );
                        let full_url = join_url(&self.base_url_with_slash(), &url);
                        shard_tasks.push(ShardTask {
                            key: (ns.clone(), *file_id),
                            url: full_url,
                            expected_trunc: Some(entry.sha256_truncated),
                            tolerate_404: false,
                        });
                    }
                    // catalog has no entry → silent skip
                } else {
                    // No catalog for this namespace (template
                    // absent OR namespace catalog 404'd OR
                    // namespace not declared in manifest.namespaces).
                    // Convention-URL mode: substitute namespace_slug
                    // + file_id_hex; pass empty sha256 since the
                    // template shouldn't reference it in this mode.
                    let url =
                        render_shard_url_full(&self.manifest.shard_url_template, key_borrowed, "");
                    let full_url = join_url(&self.base_url_with_slash(), &url);
                    shard_tasks.push(ShardTask {
                        key: (ns.clone(), *file_id),
                        url: full_url,
                        expected_trunc: None,
                        tolerate_404: true,
                    });
                }
            }
        }

        if shard_tasks.is_empty() {
            return Ok(());
        }

        // Step D: parallel shard fetch via the in-flight URL dedup
        // map (F.35). 404 maps to None for tolerate_404 tasks; other
        // errors propagate.
        let fetches = shard_tasks.iter().map(|task| {
            let url = task.url.clone();
            let tolerate_404 = task.tolerate_404;
            let inflight = self.inflight.clone();
            let fetch_sem = self.fetch_sem.clone();
            async move {
                let result = {
                    let url_for_fetch = url.clone();
                    inflight
                        .get_or_fetch(&url, move || {
                            let u = url_for_fetch.clone();
                            async move {
                                // F1: hold a global permit only for the
                                // actual network fetch; deduped waiters
                                // latch on the Shared future permit-free.
                                let _permit = fetch_sem.acquire().await;
                                fetch_bytes(&u).await
                            }
                        })
                        .await
                };
                match result {
                    Ok(bytes) => Ok::<Option<Vec<u8>>, HttpError>(Some(bytes)),
                    Err(arc_err) => {
                        if matches!(arc_err.as_ref(), HttpError::Http { status: 404, .. })
                            && tolerate_404
                        {
                            Ok(None)
                        } else {
                            Err(arc_to_http_error(arc_err))
                        }
                    }
                }
            }
        });
        let bytes_vec = futures::future::try_join_all(fetches)
            .await
            .map_err(PrefetchError::Http)?;

        // Step E: verify + insert. Skip None results (404s).
        let mut cache = self.shards.lock().expect("shard cache mutex poisoned");
        for (task, bytes_opt) in shard_tasks.into_iter().zip(bytes_vec) {
            let Some(bytes) = bytes_opt else {
                continue;
            };
            if let Some(expected_trunc) = task.expected_trunc {
                let got_full = sha256_hex(&bytes);
                let got_trunc = &got_full[..32];
                let expected_str = hex_encode_16(&expected_trunc);
                if got_trunc != expected_str {
                    return Err(PrefetchError::HashMismatch {
                        namespace: task.key.0,
                        file_id: task.key.1,
                        expected: expected_str,
                        got: got_trunc.to_owned(),
                    });
                }
            }
            cache.insert(task.key, bytes);
        }
        Ok(())
    }

    /// True if the boot pack reader has the record for `key`. v2
    /// drops the `covers: Vec<String>` field that v1 carried in
    /// the wire format (see `holtburger_manifest::v2::BootPackV2`),
    /// so the answer comes purely from the parsed HBA via
    /// `HbaReader::exists_by_key` — already O(1) over hash-mapped
    /// namespace spans, same semantics as v1's covers walk.
    fn boot_serves(&self, key: ResourceKey<'_>) -> bool {
        self.boot.exists_by_key(key)
    }

    fn cached_shard_count(&self) -> usize {
        self.shards.lock().expect("shard cache mutex poisoned").len()
    }

    fn loaded_catalog_count(&self) -> usize {
        self.catalogs.lock().expect("catalog cache mutex poisoned").len()
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
            "ManifestResourceSource(v2): record not prefetched: {}:0x{:08X}; call prefetch() first",
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
        // v2: declared namespaces are authoritative since per-shard
        // listings live in lazy catalogs we may not have fetched.
        self.manifest.namespaces.iter().any(|n| n == namespace)
    }
}

/// Strip the last path component from a URL. `https://x/y/m.json`
/// → `https://x/y`. Used to anchor relative shard URLs.
pub(crate) fn url_dirname(url: &str) -> String {
    url.rsplit_once('/')
        .map(|(d, _)| d.to_owned())
        .unwrap_or_default()
}

/// Unwrap an `Arc<HttpError>` produced by the dedup primitive back
/// into an owned `HttpError`. When this is the sole remaining strong
/// reference (common case at error-propagation time), `try_unwrap`
/// returns the inner error directly. When other waiters still hold
/// clones, we fall back to a stringified representation via
/// `HttpError::Network` so the structural variant of `PrefetchError`
/// stays unchanged at the caller. The fallback path is rare in
/// practice — concurrent waiters typically resolve and drop their
/// `Arc` clones before any one of them propagates an error.
pub(crate) fn arc_to_http_error(arc: Arc<HttpError>) -> HttpError {
    match Arc::try_unwrap(arc) {
        Ok(e) => e,
        Err(arc) => HttpError::Network(format!("{}", arc)),
    }
}

/// Encode a 16-byte buffer as 32 lowercase hex chars. Inline impl
/// to avoid pulling the `hex` crate into this wasm-only crate just
/// for one call site (sha256_hex from holtburger-manifest already
/// covers the 32-byte case).
fn hex_encode_16(bytes: &[u8; 16]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(32);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

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

    fn get_metadata_by_key(&self, key: ResourceKey<'_>) -> Option<FileMetadata> {
        self.inner.get_metadata_by_key(key)
    }

    fn has_namespace(&self, namespace: &str) -> bool {
        self.inner.has_namespace(namespace)
    }
}
