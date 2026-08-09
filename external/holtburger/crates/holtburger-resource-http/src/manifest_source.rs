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
use crate::http::{FetchPriority, HttpError, fetch_bytes, fetch_bytes_with_priority, join_url};
use crate::inflight::InflightMap;
use crate::pack::PackSource;
use crate::shard_cache::ShardCache;
use crate::manifest_source_v1::ManifestResourceSourceV1;

/// F1 tuning hook: a JS global `globalThis.__hbFetchConcurrency` (a positive
/// number set before boot) overrides [`DEFAULT_FETCH_CONCURRENCY`] for the
/// per-source shard-fetch cap, so the value can be A/B-tuned without a wasm
/// rebuild. Absent / non-numeric / < 1 → the compiled default. Reads the
/// global via `js_sys::global()` so it works in both window + worker contexts.
///
/// SPLIT (defect 3, 2026-07-24): this is a PER-INSTANCE cap, and the page runs
/// two `ManifestResourceSource`s (main + bake worker). The page-wide budget is
/// therefore divided in JS before either instance connects —
/// `applyFetchConcurrencySplit()` in `scene3d/bake_worker_client.js` stashes the
/// authored total in `__hbFetchConcurrencyTotal`, leaves the MAIN share in
/// `__hbFetchConcurrency`, and posts the worker share in the worker's `init`
/// message (the worker sets it on its own global before wasm init). So this
/// function still reads "my share" in both contexts, and main + worker now sum
/// to the documented page cap instead of doubling it.
pub fn configured_fetch_concurrency() -> usize {
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

/// Perf hook (Goal-1, 2026-06-22): JS global `globalThis.__hbVerifyShards`. When
/// EXPLICITLY set to a falsy value (`false` / `0`), skip the per-shard sha256
/// verification of fetched shard bytes (catalog mode v2 + v1). The boot pack is
/// already sha256-verified at connect and the catalog carries a CRC32, so the
/// per-shard check is redundant defense; at large draw distance it dominates fill
/// CPU — the 1070 `pvsRingRadius=10` probe measured ~71 % of main-thread time in
/// sha256 over ~25 MB across ~2 k shards. Absent / null / non-falsy → verify
/// (default ON, behaviour unchanged). Reads the global via `js_sys::global()` so it
/// works in both window + worker contexts (same pattern as the fetch-concurrency hook).
///
/// WORKER (defect 4, 2026-07-24): `js_sys::global()` in a Web Worker is the
/// worker's own global, which the page never touched — so the bake worker used
/// to verify regardless of the page setting. The value is now forwarded in the
/// worker's `init` message and set on `self` before wasm init, so both
/// instances read the same setting.
pub fn shard_verify_enabled() -> bool {
    let g = js_sys::global();
    match js_sys::Reflect::get(
        g.as_ref(),
        &wasm_bindgen::JsValue::from_str("__hbVerifyShards"),
    ) {
        Ok(v) if v.is_undefined() || v.is_null() => true, // unset → verify (default)
        Ok(v) => !v.is_falsy(),                           // false/0 → skip; else verify
        Err(_) => true,
    }
}

/// A15 §1 memory hook (2026-07-25): JS global `globalThis.__hbShardBudgetBytes`
/// (a positive number set before `init_resource_source`) caps the resident bytes
/// of this instance's shard record cache. Absent / non-numeric / < 1 →
/// `usize::MAX`, i.e. the pre-A15 unbounded map, so the default ships
/// behaviour-neutral (the eviction branch is unreachable at that budget).
///
/// Host-side, not a Rust-side URL flag (S0 lesson): JS parses `?shardBudgetMB=`
/// and sets the global. PER-INSTANCE, like the fetch cap — the page runs two
/// `ManifestResourceSource`s (main + bake worker) with independent caches, so
/// the page total is at most twice this. `index.html` sets it on the main
/// thread and forwards the same value in the bake worker's `init` message
/// (defect-4 pattern: `js_sys::global()` in a worker is the WORKER's global,
/// which the page never touched).
pub fn configured_shard_budget_bytes() -> usize {
    let g = js_sys::global();
    let v = js_sys::Reflect::get(
        g.as_ref(),
        &wasm_bindgen::JsValue::from_str("__hbShardBudgetBytes"),
    )
    .ok()
    .and_then(|val| val.as_f64());
    match v {
        Some(n) if n >= 1.0 => n as usize,
        _ => usize::MAX,
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
    /// (v2 only, R-9 2026-07-10) A shard round completed per-key
    /// tolerantly: every fetch that succeeded (and hash-verified) was
    /// inserted into the cache; `failed` lists exactly the keys that
    /// did NOT land (fetch error or hash mismatch). `detail` carries
    /// the first failure's message as a representative. Pre-R-9 a
    /// single bad shard URL discarded the WHOLE round (`try_join_all`
    /// fail-fast) — the mass-poison feeder for the negative caches.
    PartialRound {
        failed: Vec<(String, u32)>,
        detail: String,
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
            PrefetchError::CatalogFetch { namespace, source } => write!(
                f,
                "catalog fetch failed for namespace {namespace}: {source}"
            ),
            PrefetchError::CatalogParse { namespace, message } => write!(
                f,
                "catalog parse failed for namespace {namespace}: {message}"
            ),
            PrefetchError::PartialRound { failed, detail } => {
                write!(
                    f,
                    "prefetch round partial: {} shard(s) failed (first: {detail}):",
                    failed.len()
                )?;
                for (ns, id) in failed.iter().take(8) {
                    write!(f, " {ns}:0x{id:08X}")?;
                }
                if failed.len() > 8 {
                    write!(f, " …+{}", failed.len() - 8)?;
                }
                Ok(())
            }
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
    /// A15 S2: values are `Arc<Vec<u8>>` so [`ResourceSource::get_file_shared`]
    /// hands out refcount bumps instead of full record copies.
    ///
    /// A15 §1 (2026-07-25): now a byte-budgeted LRU ([`ShardCache`]) instead of
    /// a never-evicting `HashMap`. DEFAULT budget is `usize::MAX` — the eviction
    /// path cannot fire unless the host sets `__hbShardBudgetBytes`, so this
    /// ships behaviour-neutral. See [`configured_shard_budget_bytes`] and the
    /// `shard_cache` module doc for the eviction-soundness argument.
    shards: Arc<Mutex<ShardCache<OwnedKey>>>,
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
    /// T12 (`?packSource`, SPEC §1.1 / pass 3 S1.3): the CompositeSource
    /// seam. `None` (the OFF arm / no pack dist) is byte-identical legacy
    /// behavior. When attached: reads consult packs FIRST (pack → boot →
    /// shards) and `prefetch` skips pack-served keys — a pack-resident
    /// record must never be re-fetched per-record. Attached once at boot
    /// by `pack_source_init` (main instance only at T12; the bake worker
    /// keeps the pure legacy path until the ST7 lease machinery).
    packs: Mutex<Option<Arc<PackSource>>>,
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
            Self::V2(s) => s.prefetch_impl(keys, false).await,
        }
    }

    /// Urgent-lane variant of [`Self::prefetch`] for player-blocking
    /// loads (the CURRENT landblock's interior EnvCells). Skips the
    /// shared `fetch_sem` so the request is NOT queued behind the
    /// speculative ring bakers' fetch flood — the geom-audit sessions
    /// (2026-07-02) measured the FIFO fetch-semaphore queue starving
    /// `fetchEnvCellsInLandblock` for minutes (interior never
    /// appeared). The browser's per-origin connection cap still
    /// bounds actual parallelism, and the semaphore's purpose (keep
    /// the browser queue shallow) is preserved because urgent batches
    /// are small (~100 records per landblock, one LB at a time).
    pub async fn prefetch_urgent(&self, keys: &[ResourceKey<'_>]) -> Result<(), PrefetchError> {
        match self {
            Self::V1(s) => s.prefetch(keys).await,
            Self::V2(s) => s.prefetch_impl(keys, true).await,
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

    /// Total record bytes resident in the shard cache (excludes the boot
    /// pack). A15 §1 "not transient": this map has only `insert` / `get` /
    /// `len` — **no eviction, no budget, ever** — so every DAT record the
    /// session touches stays resident for the page lifetime, in EACH of the
    /// two wasm instances. That is a memory ratchet independent of the
    /// transient decode peak, and A15's instrumentation must be able to tell
    /// them apart before a disappointing bounded-decode result is blamed on
    /// the decode bound. Reported as `shardCacheBytes` by `dat_decode_diag()`.
    ///
    /// O(n) over resident records per call — fine for a diag poll (seconds
    /// apart), deliberately not a running counter so it cannot drift from the
    /// map it describes.
    pub fn cached_shard_bytes(&self) -> usize {
        match self {
            Self::V1(s) => s.cached_shard_bytes(),
            Self::V2(s) => s.cached_shard_bytes(),
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

    /// T12 (`?packSource`): arm the CompositeSource seam — subsequent
    /// reads consult `pack` first and `prefetch` skips pack-served keys.
    /// Returns `false` (not attached) on the deprecated v1 path: v1
    /// predates the pack format and carries no seam by design.
    pub fn attach_pack_source(&self, pack: Arc<PackSource>) -> bool {
        match self {
            Self::V1(_) => false,
            Self::V2(s) => {
                s.attach_pack_source(pack);
                true
            }
        }
    }

    /// The attached pack source, if any (diag / the wasm glue).
    pub fn pack_source(&self) -> Option<Arc<PackSource>> {
        match self {
            Self::V1(_) => None,
            Self::V2(s) => s.pack_source(),
        }
    }

    /// T15 (ST5, `?texCompressedOnly`): resolve the CAS URL + truncated
    /// sha256 for one record WITHOUT fetching the record — the lane-T
    /// routing seam (pass 5 S4: full-tier upgrades ride the JS
    /// `PackFetchController`, lane T, with hash-on-receipt against this
    /// sha). Ensures the namespace catalog is resident (one catalog fetch
    /// on first ask, deduped via the in-flight map). `None` = v1 source,
    /// undeclared/empty namespace, no catalog template (convention-URL
    /// mode has no verifiable sha — the caller stays on the legacy lane),
    /// or no catalog entry for `file_id`.
    pub async fn shard_cas_info(&self, namespace: &str, file_id: u32) -> Option<(String, String)> {
        match self {
            Self::V1(_) => None,
            Self::V2(s) => s.shard_cas_info(namespace, file_id).await,
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

    /// A15 S2 forward. V2 shares its cached `Arc`; **V1 deliberately falls back
    /// to a copy** — `ManifestResourceSourceV1` is the deprecated 203 MB-JSON
    /// path (see the `connect` warning), no shipped bake uses it, and its shard
    /// map would need the same type change for zero live benefit. The V1 arm is
    /// exactly the trait default, so it is never worse than pre-S2.
    fn get_file_shared(&self, key: ResourceKey<'_>) -> DatResult<Arc<Vec<u8>>> {
        match self {
            Self::V1(s) => Ok(Arc::new(s.get_file_by_key(key)?)),
            Self::V2(s) => s.get_file_shared(key),
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

    fn key_known_absent(&self, key: ResourceKey<'_>) -> bool {
        match self {
            // v1 has no per-namespace catalogs — absence is unprovable.
            Self::V1(_) => false,
            Self::V2(s) => s.key_known_absent(key),
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
            shards: Arc::new(Mutex::new(ShardCache::new(configured_shard_budget_bytes()))),
            base_url,
            inflight: Arc::new(InflightMap::new()),
            fetch_sem: Semaphore::new(configured_fetch_concurrency()),
            packs: Mutex::new(None),
        })
    }

    /// T12: arm the composite (pack-first) read path. Idempotent-ish —
    /// a second attach replaces the first (only exercised by tests; the
    /// page attaches once at boot).
    fn attach_pack_source(&self, pack: Arc<PackSource>) {
        *self.packs.lock().expect("pack seam mutex poisoned") = Some(pack);
    }

    fn pack_source(&self) -> Option<Arc<PackSource>> {
        self.packs.lock().expect("pack seam mutex poisoned").clone()
    }

    /// Pack-resident probe used by the prefetch skip + read paths.
    fn pack_serves(&self, key: ResourceKey<'_>) -> bool {
        match &*self.packs.lock().expect("pack seam mutex poisoned") {
            Some(p) => p.serves(key),
            None => false,
        }
    }

    /// T15 (ST5): CAS URL + truncated-sha for one record, catalog-backed,
    /// record NOT fetched. See the [`ManifestResourceSource::shard_cas_info`]
    /// doc for the contract. Mirrors prefetch's Step B catalog-ensure for a
    /// single namespace (same in-flight dedup, same 404-=-empty-namespace
    /// disposition).
    async fn shard_cas_info(&self, namespace: &str, file_id: u32) -> Option<(String, String)> {
        self.manifest.catalog_url_template.as_ref()?;
        if !self.manifest.namespaces.iter().any(|n| n == namespace) {
            return None;
        }
        let have = self
            .catalogs
            .lock()
            .expect("catalog cache mutex poisoned")
            .contains_key(namespace);
        if !have {
            let url = self.manifest.catalog_url(namespace)?;
            let full_url = join_url(&self.base_url_with_slash(), &url);
            let result = {
                let u = full_url.clone();
                self.inflight
                    .get_or_fetch(&full_url, move || {
                        let u = u.clone();
                        async move { fetch_bytes(&u).await }
                    })
                    .await
            };
            match result {
                Ok(bytes) => {
                    let catalog =
                        NamespaceCatalog::read_from(&bytes, namespace.to_string()).ok()?;
                    self.catalogs
                        .lock()
                        .expect("catalog cache mutex poisoned")
                        .insert(namespace.to_string(), catalog);
                }
                // 404 = namespace empty after bake pruning; transient
                // errors likewise yield None — the caller's legacy route
                // (per-record prefetch) retries on its own schedule.
                Err(_) => return None,
            }
        }
        let catalogs = self.catalogs.lock().expect("catalog cache mutex poisoned");
        let entry = catalogs.get(namespace)?.lookup(file_id)?;
        let hash_hex = hex_encode_16(&entry.sha256_truncated);
        let key = ResourceKey { namespace, file_id };
        let url = render_shard_url_full(&self.manifest.shard_url_template, key, &hash_hex);
        Some((join_url(&self.base_url_with_slash(), &url), hash_hex))
    }

    /// v2 prefetch: lazy-fetch any per-namespace catalogs we don't
    /// have yet (when the manifest declares a catalog template),
    /// then look up each requested key — silent-skip when the
    /// catalog confirms the record doesn't exist, otherwise build
    /// a shard URL via the `shard_url_template` and fetch in
    /// parallel. Verifies sha256 against the catalog entry when
    /// available; convention-URL mode skips verification.
    ///
    /// `urgent` (2026-07-02): bypass the shared `fetch_sem` so a
    /// player-blocking batch (current-LB interior) is not FIFO-queued
    /// behind the speculative ring bakers' shard flood. See
    /// [`ManifestResourceSource::prefetch_urgent`].
    async fn prefetch_impl(&self, keys: &[ResourceKey<'_>], urgent: bool) -> Result<(), PrefetchError> {
        // Step A: filter out pack-served + boot-served + already-cached keys.
        // T12: a pack-resident record is already verified bytes in this
        // instance — re-fetching it per-record would double the wire cost
        // the pack lane exists to delete (pass 3 S1.3/S1.4).
        let pack = self.pack_source();
        let mut work_keys: Vec<OwnedKey> = Vec::new();
        {
            let mut cached = self.shards.lock().expect("shard cache mutex poisoned");
            for key in keys {
                if let Some(p) = &pack
                    && p.serves(*key)
                {
                    continue;
                }
                if self.boot_serves(*key) {
                    continue;
                }
                // `contains_touch`: "already cached, skip the fetch" IS a use of
                // the record — bumping recency here keeps the LRU from evicting
                // exactly the records this walk round just decided it needs.
                if cached.contains_touch(&owned(*key)) {
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
                    // Urgent fetches dedup under a DISTINCT inflight key:
                    // latching onto an existing normal-lane Shared would
                    // park the urgent caller in the semaphore queue it is
                    // supposed to bypass (measured: the session's physics
                    // cell loader had already enqueued the same URLs via
                    // the slow lane, re-starving the interior build). The
                    // worst case is one duplicate fetch per record —
                    // urgent batches are small and the shard cache is
                    // idempotent.
                    let dedup_key = if urgent {
                        format!("urgent:{url}")
                    } else {
                        url.clone()
                    };
                    inflight
                        .get_or_fetch(&dedup_key, move || {
                            let u = url_for_fetch.clone();
                            async move {
                                // F1: hold a global permit only for the
                                // actual network fetch; deduped waiters
                                // latch on the Shared future permit-free.
                                // Urgent batches skip the queue (player-
                                // blocking; browser cap still bounds).
                                let _permit = if urgent {
                                    None
                                } else {
                                    Some(fetch_sem.acquire().await)
                                };
                                // Speculative bulk prefetch rides the LOW
                                // browser fetch-priority so the ring
                                // bakers' flood cannot FIFO-starve player-
                                // blocking urgent batches behind the
                                // 6-connection/origin cap (measured:
                                // interiors never loaded). Urgent keeps
                                // the default (High) priority.
                                let prio = if urgent {
                                    FetchPriority::Auto
                                } else {
                                    FetchPriority::Low
                                };
                                fetch_bytes_with_priority(&u, prio).await
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
        // R-9 (2026-07-10): per-key tolerant round. `try_join_all` fail-fast
        // used to discard EVERY successfully-fetched sibling when one shard
        // URL failed — a single bad URL emptied an 80+ surface pre-warm batch
        // and fed the negative caches en masse. Now every completed fetch is
        // awaited (`join_all`), successes are verified + inserted, and the
        // round's `Err` carries ONLY the keys that did not land, so a retry
        // round shrinks to the stubborn keys (step A skips cached ones).
        let results = futures::future::join_all(fetches).await;

        // Step E: verify + insert successes; collect failures. Skip None
        // results (tolerated 404s). The per-shard sha256 verify is gated by
        // `__hbVerifyShards` (default ON) — at large draw distance it
        // dominates fill CPU (~71% on the 1070 r10 probe); see
        // shard_verify_enabled. A hash mismatch counts as a failed key (not
        // inserted) rather than aborting the round.
        let verify = shard_verify_enabled();
        let mut failed: Vec<(String, u32)> = Vec::new();
        let mut first_detail: Option<String> = None;
        {
            let mut cache = self.shards.lock().expect("shard cache mutex poisoned");
            // A15 §1: bracket the round so a batch larger than the whole budget
            // cannot evict its OWN earlier results before the caller reads them
            // (`prefetch` returning Ok must mean every landed key is readable).
            // `end_round` below drops the protection and trims to budget.
            cache.begin_round();
            for (task, result) in shard_tasks.into_iter().zip(results) {
                let bytes = match result {
                    Ok(Some(bytes)) => bytes,
                    Ok(None) => continue,
                    Err(e) => {
                        if first_detail.is_none() {
                            first_detail = Some(e.to_string());
                        }
                        failed.push(task.key);
                        continue;
                    }
                };
                if verify {
                    if let Some(expected_trunc) = task.expected_trunc {
                        let got_full = sha256_hex(&bytes);
                        let got_trunc = &got_full[..32];
                        let expected_str = hex_encode_16(&expected_trunc);
                        if got_trunc != expected_str {
                            if first_detail.is_none() {
                                first_detail = Some(format!(
                                    "shard {}:0x{:08X} hash mismatch: expected {expected_str}, got {got_trunc}",
                                    task.key.0, task.key.1
                                ));
                            }
                            failed.push(task.key);
                            continue;
                        }
                    }
                }
                cache.insert(task.key, Arc::new(bytes));
            }
            cache.end_round();
        }
        self.publish_shard_cache_diag();
        if !failed.is_empty() {
            return Err(PrefetchError::PartialRound {
                failed,
                detail: first_detail.unwrap_or_default(),
            });
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

    /// A15 §1 diag surface, published to `globalThis.__hbShardCache` at the end
    /// of every prefetch round. A JS global rather than a `#[wasm_bindgen]`
    /// export because the page runs TWO instances and the bake worker's exports
    /// are not reachable from the page — this way each context reports its own
    /// cache into its own global, and the worker's numbers can ride the existing
    /// worker→page message channel if a later commit wants them merged into
    /// `dat_decode_diag()`.
    fn publish_shard_cache_diag(&self) {
        let (bytes, count, evictions, evicted_bytes, budget) = {
            let c = self.shards.lock().expect("shard cache mutex poisoned");
            (
                c.total_bytes(),
                c.len(),
                c.evictions(),
                c.evicted_bytes(),
                c.budget(),
            )
        };
        let obj = js_sys::Object::new();
        let set = |k: &str, v: f64| {
            let _ = js_sys::Reflect::set(
                &obj,
                &wasm_bindgen::JsValue::from_str(k),
                &wasm_bindgen::JsValue::from_f64(v),
            );
        };
        set("shardCacheBytes", bytes as f64);
        set("shardCacheCount", count as f64);
        set("shardCacheEvictions", evictions as f64);
        set("shardCacheEvictedBytes", evicted_bytes as f64);
        // `usize::MAX` would round-trip as a meaningless 1.8e19; report the
        // unbounded default as -1 so JS can test for it cheaply.
        set(
            "shardCacheBudget",
            if budget == usize::MAX { -1.0 } else { budget as f64 },
        );
        let g = js_sys::global();
        let _ = js_sys::Reflect::set(
            g.as_ref(),
            &wasm_bindgen::JsValue::from_str("__hbShardCache"),
            &obj,
        );
    }

    /// See [`ManifestResourceSource::cached_shard_bytes`].
    fn cached_shard_bytes(&self) -> usize {
        // A15 §1: now the LRU's running counter rather than an O(n) re-sum. It
        // counts exactly the same thing — resident record payload, no `Arc`
        // header, no map overhead — so the number stays comparable with the
        // S1/S2 measurements. `ShardCache`'s `byte_accounting_exact_*` tests
        // pin the counter against a recomputed ground truth so it cannot drift.
        self.shards
            .lock()
            .expect("shard cache mutex poisoned")
            .total_bytes()
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

    /// Legacy owned-bytes read. Kept byte-for-byte identical for every caller
    /// that still wants a `Vec<u8>`; hot readers use [`Self::get_file_shared`].
    /// T12: packs consult FIRST (CompositeSource order, pass 3 S1.3) — bake
    /// determinism makes pack bytes identical to shard bytes for the same
    /// record, so consult order cannot change served content, only its source.
    fn get_file_by_key(&self, key: ResourceKey<'_>) -> DatResult<Vec<u8>> {
        if let Some(p) = self.pack_source()
            && let Ok(bytes) = p.get_file_by_key(key)
        {
            return Ok(bytes);
        }
        if let Ok(bytes) = self.boot.get_file_by_key(key) {
            return Ok(bytes);
        }
        if let Some(bytes) = self
            .shards
            .lock()
            .expect("shard cache mutex poisoned")
            .get(&owned(key))
        {
            return Ok((*bytes).clone());
        }
        Err(DatError::Other(format!(
            "ManifestResourceSource(v2): record not prefetched: {}:0x{:08X}; call prefetch() first",
            key.namespace, key.file_id
        )))
    }

    /// A15 S2 (design §3c) — the shared-ownership read. A cached shard costs
    /// one refcount bump; the boot pack has no resident `Arc` to share (the
    /// `HbaReader` copies out of its backing buffer), so that path allocates
    /// exactly as it did before, no worse than the trait default.
    fn get_file_shared(&self, key: ResourceKey<'_>) -> DatResult<Arc<Vec<u8>>> {
        if let Some(p) = self.pack_source()
            && let Ok(bytes) = p.get_file_by_key(key)
        {
            return Ok(Arc::new(bytes));
        }
        if let Ok(bytes) = self.boot.get_file_by_key(key) {
            return Ok(Arc::new(bytes));
        }
        if let Some(bytes) = self
            .shards
            .lock()
            .expect("shard cache mutex poisoned")
            .get(&owned(key))
        {
            return Ok(bytes);
        }
        Err(DatError::Other(format!(
            "ManifestResourceSource(v2): record not prefetched: {}:0x{:08X}; call prefetch() first",
            key.namespace, key.file_id
        )))
    }

    fn get_metadata_by_key(&self, key: ResourceKey<'_>) -> Option<FileMetadata> {
        if let Some(p) = self.pack_source()
            && let Some(meta) = p.get_metadata_by_key(key)
        {
            return Some(meta);
        }
        if let Some(meta) = self.boot.get_metadata_by_key(key) {
            return Some(meta);
        }
        let cache = self.shards.lock().expect("shard cache mutex poisoned");
        // `peek_len` (no recency bump): a metadata probe is not a record read,
        // and the data read that follows will do its own touch.
        cache.peek_len(&owned(key)).map(|size| FileMetadata {
            id: key.file_id,
            size: size as u32,
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

    /// R-7 provability probe. A record's absence is PROVEN only in catalog
    /// mode, with the key's namespace catalog loaded, when that catalog —
    /// which authoritatively lists every record in the namespace — has no
    /// entry for it. Everything else (boot-served, convention-URL mode,
    /// catalog not yet fetched, 404-empty namespace) is unprovable → false.
    /// This is what gates the wasm/JS negative caches: a transient
    /// unhydrated key errs identically to an absent one in
    /// [`Self::get_file_by_key`], so only this probe may authorize a
    /// permanent memo.
    fn key_known_absent(&self, key: ResourceKey<'_>) -> bool {
        // T12: a pack-RESIDENT record is present by construction — without
        // this guard a packs-only dist (no catalogs) or a catalog that
        // doesn't list a pack-served key would let the negative caches
        // latch a record this source is actively serving.
        if self.pack_serves(key) {
            return false;
        }
        if self.boot_serves(key) {
            return false;
        }
        if self.manifest.catalog_url_template.is_none() {
            return false;
        }
        let catalogs = self.catalogs.lock().expect("catalog cache mutex poisoned");
        match catalogs.get(key.namespace) {
            Some(catalog) => catalog.lookup(key.file_id).is_none(),
            None => false,
        }
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


