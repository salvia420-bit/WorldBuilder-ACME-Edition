//! Manifest schema **version 2** — Phase 5.2 scale fix.
//!
//! Phase 5.0's [`crate::Manifest`] (v1) lists every shard inline:
//! a real-world bake against `dats/assets.hba` produces a
//! 203 MB `manifest.json` because `eor/cell` interior EnvCells
//! dominate (805k of 885k records, ~230 bytes per JSON entry).
//! v2 lifts the architecture from O(N-records) manifest size to
//! O(1) by moving per-shard listings out of the top-level manifest
//! and deriving shard URLs by convention. This module hosts the
//! v2 schema, the per-namespace `crate::catalog::NamespaceCatalog`
//! binary format, and the URL-template helpers shared between
//! `dat-shard` (emission) and `ManifestResourceSource` (consumption).
//!
//! # v1 → v2 audit
//!
//! ## (a) v1 fields (current shape — see [`crate::Manifest`])
//!
//! - `version: u32` — schema-version sentinel; load-bearing.
//! - `generated_at: String` — ISO 8601 timestamp; informational.
//! - `source: SourceMeta` — DAT iteration provenance; load-bearing
//!   (operators verify against canonical retail builds).
//! - `boot_pack: BootPack` — `{url, size, sha256, covers: Vec<String>}`;
//!   load-bearing (consumed by
//!   `ManifestResourceSource::connect` to fetch + hash-verify the
//!   pack at construction time).
//! - `shards: BTreeMap<String, ShardEntry>` — keyed by
//!   `<namespace>:0x{file_id:08X}` (see
//!   [`crate::format_shard_key`]). Each entry carries
//!   `{sha256: String, size: u64, url: String}`. **This map is the
//!   203 MB cliff.** v2 eliminates it from the top-level manifest.
//!
//! ## (b) Load-bearing across v1 callers (must preserve)
//!
//! Identified by reading
//! `crates/holtburger-resource-http/src/manifest_source.rs`
//! (entire file, ~420 LOC) end-to-end:
//!
//! 1. **Boot pack metadata** —
//!    `manifest_source.rs::connect` (line 181-207) calls
//!    `fetch_bytes(&boot_url)`, computes `sha256_hex`, asserts
//!    against `manifest.boot_pack.sha256`, and parses with
//!    `HbaReader::from_bytes`. v2 reuses [`crate::BootPack`]
//!    verbatim.
//! 2. **Source provenance** — `manifest()` getter at
//!    `manifest_source.rs:290` returns `&Manifest`; smoke
//!    harness (`apps/holtburger-web/smoke_test.cjs`) reads
//!    `source.portal_dat_iteration` for round-trip checks.
//!    v2 reuses [`crate::SourceMeta`] verbatim.
//! 3. **`(namespace, file_id) → bytes` lookup contract** —
//!    `ResourceSource::get_file_by_key` (line 312+) returns
//!    `Vec<u8>` for any key the manifest covers. v1 satisfies
//!    this by reading `manifest.shards.get(&key_for_resource(*key))`
//!    inside `prefetch` and stashing fetched bytes in a
//!    `HashMap<OwnedKey, Vec<u8>>` shard cache. v2 satisfies
//!    the same contract via convention shard URLs derived from
//!    a `shard_url_template` + (when present) a
//!    `crate::catalog::NamespaceCatalog` for batch sha256
//!    verification.
//! 4. **`covers` short-circuit** — `manifest_source.rs::boot_serves`
//!    (line 278) treats the boot pack's `covers` list as the
//!    authoritative-fast-path "this key is already in memory"
//!    check. v2 keeps `covers` on [`crate::BootPack`] unchanged.
//! 5. **`format_shard_key` / `parse_shard_key` round-trip** —
//!    used by the manifest map keys + `prefetch` lookups +
//!    `boot_pack.covers` entries. The string format
//!    `<namespace>:0x{file_id:08X}` is part of the wire
//!    contract; v2 keeps both helpers + the
//!    `key_for_resource` convenience.
//!
//! ## (c) What v2 simplifies away
//!
//! 1. **Per-shard `url: String`** — derived from a
//!    `shard_url_template` +
//!    `(namespace, file_id, sha256_hex)` substitution. ~30 bytes
//!    per entry × 885k = ~25 MB savings.
//! 2. **Per-shard `size: u64`** — HTTP `Content-Length` provides
//!    it on each fetch; not needed for the in-memory lookup.
//!    ~10 bytes per JSON entry × 885k = ~10 MB savings.
//! 3. **Per-shard `sha256: String`** — moved into the per-namespace
//!    `crate::catalog::NamespaceCatalog` binary format
//!    (truncated to 16 bytes for ~6× space win) and consulted
//!    only when sha256 verification is desired. ~70 bytes per JSON
//!    entry × 885k = ~62 MB savings (and dropping it entirely
//!    when the catalog is absent is also a valid mode).
//! 4. **Top-level `shards: BTreeMap<String, ShardEntry>` in JSON**
//!    — replaced by lazy-loaded per-namespace binary catalogs at
//!    `manifest/<namespace_slug>.bin`, fetched on first
//!    record-miss in that namespace. Shard URLs derive from a
//!    convention template; the catalog supplies sha256 +
//!    canonical size *only* when batch verification matters.
//!
//! Net effect: top-level v2 `manifest.json` shrinks from
//! 203 MB → ≈ 800 bytes – 2 KB regardless of world size.
//! Per-namespace catalogs scale O(N-records-in-namespace), but
//! load lazily and gzip well (~19 bytes per entry raw,
//! ~6-8 MB gzipped for `eor/cell`'s 805k entries).
//!
//! # Phase 5.2 implementation status
//!
//! - **obj 1** (this stub) — audit comment block + `pub mod`
//!   declaration. Compiles native + wasm32. No tests.
//! - **obj 2** — define `ManifestV2`, `MANIFEST_V2_VERSION`,
//!   `namespace_slug`, URL-template render helpers. 4 tests.
//! - **obj 3** — define `crate::catalog::NamespaceCatalog`
//!   binary format + codec (lives in `catalog.rs`). 5 tests.
//! - **obj 4-7** — wire into `ManifestResourceSource`,
//!   `dat-shard`, service worker. (Separate crates.)
//! - **obj 8-11** — smoke harness + native invariant + live-ACE
//!   validation + docs.

// Implementation lands in objective 2. Stub keeps the module
// declaration round-tripping through `lib.rs` so subsequent
// objectives don't need to re-edit the lib.rs `pub mod` line.
