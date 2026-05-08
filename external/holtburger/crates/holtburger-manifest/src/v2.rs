//! Manifest schema **version 2** — Phase 5.2 scale fix.
//!
//! Phase 5.0's [`crate::Manifest`] (v1) lists every shard inline:
//! a real-world bake against `dats/assets.hba` produces a
//! 203 MB `manifest.json` because `eor/cell` interior EnvCells
//! dominate (805k of 885k records, ~230 bytes per JSON entry).
//! v2 lifts the architecture from O(N-records) manifest size to
//! O(1) by moving per-shard listings out of the top-level manifest
//! and deriving shard URLs by convention. This module hosts the
//! v2 schema and the URL-template helpers shared between
//! `dat-shard` (emission) and `ManifestResourceSource` (consumption).
//! The per-namespace catalog binary format lands in
//! `crate::catalog::NamespaceCatalog` (objective 3).
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
//!    [`ManifestV2::shard_url_template`] + (when present) a
//!    [`crate::catalog::NamespaceCatalog`] for batch sha256
//!    verification.
//! 4. **`covers` short-circuit** — `manifest_source.rs::boot_serves`
//!    (line 278) treats the boot pack's `covers` list as the
//!    authoritative-fast-path "this key is already in memory"
//!    check. v2 drops `covers` from the wire (see audit (c) §5)
//!    and uses `HbaReader::exists_by_key` directly — same O(1)
//!    semantics, no scaling with boot-pack size in the JSON.
//! 5. **`format_shard_key` / `parse_shard_key` round-trip** —
//!    used by the manifest map keys + `prefetch` lookups +
//!    `boot_pack.covers` entries. The string format
//!    `<namespace>:0x{file_id:08X}` is part of the wire
//!    contract; v2 keeps both helpers + the
//!    `key_for_resource` convenience.
//!
//! ## (c) What v2 simplifies away
//!
//! 1. **Per-shard `url: String`** — derived from
//!    [`ManifestV2::shard_url_template`] +
//!    `(namespace, file_id, sha256_hex)` substitution. ~30 bytes
//!    per entry × 885k = ~25 MB savings.
//! 2. **Per-shard `size: u64`** — HTTP `Content-Length` provides
//!    it on each fetch; not needed for the in-memory lookup.
//!    ~10 bytes per JSON entry × 885k = ~10 MB savings.
//! 3. **Per-shard `sha256: String`** — moved into the per-namespace
//!    [`crate::catalog::NamespaceCatalog`] binary format
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
//! 5. **`BootPack.covers: Vec<String>`** — Phase 5.1b's transitive
//!    boot walk produces ~635 covers for the Holtburg spawn area;
//!    each ~30 bytes formatted = ~19 KB. v2 drops this from the
//!    wire ([`BootPackV2`] omits it) and answers
//!    "is X in the boot pack" via `HbaReader::exists_by_key` —
//!    the parsed boot reader already does the lookup in O(1)
//!    via its hash-mapped namespace spans. The covers list was
//!    only ever a linear-scan fast-path; dropping it doesn't
//!    change runtime semantics. Brings the v2 manifest under
//!    the brief's 2 KB target.
//!
//! Net effect: top-level v2 `manifest.json` shrinks from
//! 203 MB → ≈ 800 bytes – 2 KB regardless of world size.
//! Per-namespace catalogs scale O(N-records-in-namespace), but
//! load lazily and gzip well (~19 bytes per entry raw,
//! ~6-8 MB gzipped for `eor/cell`'s 805k entries).
//!
//! # Phase 5.2 implementation status
//!
//! - **obj 1** (this audit) — comment block + module declaration.
//! - **obj 2** (this commit) — [`ManifestV2`] schema +
//!   [`MANIFEST_V2_VERSION`] + [`namespace_slug`] +
//!   URL-template render helpers. 4 tests.
//! - **obj 3** — [`crate::catalog::NamespaceCatalog`] binary
//!   format + codec. 5 tests.
//! - **obj 4-7** — wire into `ManifestResourceSource`,
//!   `dat-shard`, service worker. (Separate crates.)
//! - **obj 8-11** — smoke harness + native invariant + live-ACE
//!   validation + docs.

use holtburger_dat::ResourceKey;
use serde::{Deserialize, Serialize};

use crate::{BootPack, SourceMeta};

/// v2 boot-pack metadata. Same shape as v1 [`crate::BootPack`] minus
/// the `covers: Vec<String>` field — v2 drops it from the wire so
/// the top-level manifest stays ≈2 KB regardless of boot-pack size.
/// On a real-world Dereth bake the boot pack covers ~635 keys
/// (Phase 5.1b transitive walk) which would inflate v2's manifest
/// by ~19 KB if covers were preserved verbatim.
///
/// Runtime correctness without covers: the v2
/// `ManifestResourceSource` answers "is this key in the boot pack"
/// via `HbaReader::exists_by_key` (O(1) hash lookup over the
/// already-parsed boot pack). The covers list was only ever a
/// linear-scan fast-path; dropping it doesn't change semantics.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct BootPackV2 {
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

impl From<BootPack> for BootPackV2 {
    fn from(v1: BootPack) -> Self {
        Self {
            url: v1.url,
            size: v1.size,
            sha256: v1.sha256,
        }
    }
}

/// The v2 schema version. Bumped from [`crate::MANIFEST_VERSION`]
/// (1). Consumers route on `version` field; v1 stays parseable for
/// one release cycle to drain in-flight CDN deploys.
pub const MANIFEST_V2_VERSION: u32 = 2;

/// Default content-addressable shard URL template. The `{sha256}`
/// token expands to the lowercase 64-char hex digest. Suitable for
/// flat one-dir layouts; for million-file bundles use
/// [`DEFAULT_SHARD_URL_TEMPLATE_PREFIXED`] instead.
pub const DEFAULT_SHARD_URL_TEMPLATE: &str = "shards/{sha256}.bin";

/// 2-level prefix split: `shards/{first 2 hex chars}/{full hash}.bin`.
/// Avoids the 885k-files-in-one-dir problem on ext4 / NTFS / APFS.
/// `{sha256_prefix2}` expands to the first 2 chars of `{sha256}`;
/// `{sha256}` expands to the full digest. Both substitutions happen
/// in [`ManifestV2::shard_url`].
pub const DEFAULT_SHARD_URL_TEMPLATE_PREFIXED: &str =
    "shards/{sha256_prefix2}/{sha256}.bin";

/// Default per-namespace catalog URL template. The `{namespace_slug}`
/// token expands to the namespace with `'/'` replaced by `'-'`,
/// e.g. `"eor/portal"` → `"eor-portal"`.
pub const DEFAULT_CATALOG_URL_TEMPLATE: &str = "manifest/{namespace_slug}.bin";

/// Top-level v2 manifest. Lists boot pack + namespaces +
/// URL-template strings; **does NOT list individual shards**.
/// Per-record listings live in lazy-loaded
/// [`crate::catalog::NamespaceCatalog`] binaries when present, or
/// are derived purely from convention URLs when not.
///
/// Total wire size on a real-world bake: ≈ 800 bytes – 2 KB.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ManifestV2 {
    /// Schema-version sentinel. Always equal to
    /// [`MANIFEST_V2_VERSION`] for v2-emitted manifests; consumers
    /// route on this field after a [`ManifestVersionProbe`] sniff.
    pub version: u32,
    /// ISO 8601 UTC timestamp when the manifest was produced.
    /// Free-form `String` — no chrono dep. Producers should write
    /// `YYYY-MM-DDTHH:MM:SSZ`.
    pub generated_at: String,
    /// Provenance. Same shape as v1 (DAT iteration counters).
    pub source: SourceMeta,
    /// Bootstrap pack metadata. v2 uses [`BootPackV2`] (no
    /// `covers` field) — see that type's docs for the rationale.
    pub boot_pack: BootPackV2,
    /// Bumps when any per-namespace catalog or shard hash changes.
    /// Lets the page cheaply detect "are my cached catalogs
    /// stale?" by comparing the top-level manifest's
    /// `catalog_version` against its cached value.
    pub catalog_version: u32,
    /// All namespaces present in the bundle, e.g.
    /// `["eor/portal", "eor/cell", "eor/local", "holtburger/core"]`.
    /// Drives namespace-catalog discovery: the page only fetches a
    /// catalog for a namespace declared here.
    pub namespaces: Vec<String>,
    /// URL template for individual shard fetches. Tokens
    /// substituted by [`ManifestV2::shard_url`]:
    ///
    /// | Token | Substitution |
    /// |---|---|
    /// | `{sha256}` | full lowercase hex sha256 |
    /// | `{sha256_prefix2}` | first 2 chars of the hex sha256 |
    /// | `{namespace_slug}` | namespace with `/` → `-` |
    /// | `{file_id_hex}` | `0x{file_id:08X}` uppercase |
    ///
    /// Default (flat): [`DEFAULT_SHARD_URL_TEMPLATE`].
    /// Default (2-level split): [`DEFAULT_SHARD_URL_TEMPLATE_PREFIXED`].
    pub shard_url_template: String,
    /// Optional URL template for per-namespace catalogs. Token
    /// `{namespace_slug}` is substituted by
    /// [`ManifestV2::catalog_url`]. Default:
    /// [`DEFAULT_CATALOG_URL_TEMPLATE`]. Absent / `None` → no
    /// catalogs available; page falls through to convention-URL
    /// mode without sha256 verification.
    pub catalog_url_template: Option<String>,
}

/// Cheap version-only probe deserializer. The v2 connect path
/// uses this to route between v1 and v2 parsers without
/// allocating the full structure first.
#[derive(Deserialize, Debug, Clone, Copy)]
pub struct ManifestVersionProbe {
    pub version: u32,
}

impl ManifestV2 {
    /// Render the shard URL for `key` with hash `sha256_hex`,
    /// substituting all four template tokens.
    ///
    /// `sha256_hex` must be lowercase 64-char hex; callers
    /// produce it via [`crate::sha256_hex`]. For
    /// `{sha256_prefix2}` to expand correctly the digest must
    /// be at least 2 chars long, which it always is for sha256.
    pub fn shard_url(&self, key: ResourceKey<'_>, sha256_hex: &str) -> String {
        render_shard_url_full(&self.shard_url_template, key, sha256_hex)
    }

    /// Render the per-namespace catalog URL, or `None` if the
    /// manifest declares no catalog template.
    pub fn catalog_url(&self, namespace: &str) -> Option<String> {
        self.catalog_url_template
            .as_ref()
            .map(|t| render_catalog_url(t, namespace))
    }
}

/// Convert a namespace string to its slug form: `'/'` → `'-'`.
///
/// `"eor/portal"` ↔ `"eor-portal"`. Used as the `{namespace_slug}`
/// token expansion + the on-disk filename for catalog binaries
/// (`manifest/eor-portal.bin`). The replacement is unambiguous
/// because AC namespace strings never contain a literal `'-'`.
pub fn namespace_slug(namespace: &str) -> String {
    namespace.replace('/', "-")
}

/// Substitute the `{sha256}` token in `template`.
///
/// Standalone helper used by the simpler call sites that only
/// need full-hash substitution (e.g. unit tests). For the full
/// 4-token rendering used by [`ManifestV2::shard_url`] see
/// [`render_shard_url_full`].
pub fn render_shard_url(template: &str, sha256_hex: &str) -> String {
    template.replace("{sha256}", sha256_hex)
}

/// Substitute all 4 shard-URL tokens at once.
///
/// Order matters: `{sha256_prefix2}` must expand before
/// `{sha256}` to avoid the latter's substitution chewing
/// the literal `{sha256_prefix2}` substring.
pub fn render_shard_url_full(
    template: &str,
    key: ResourceKey<'_>,
    sha256_hex: &str,
) -> String {
    let prefix2 = if sha256_hex.len() >= 2 {
        &sha256_hex[..2]
    } else {
        sha256_hex
    };
    template
        .replace("{sha256_prefix2}", prefix2)
        .replace("{sha256}", sha256_hex)
        .replace("{namespace_slug}", &namespace_slug(key.namespace))
        .replace("{file_id_hex}", &format!("0x{:08X}", key.file_id))
}

/// Substitute the `{namespace_slug}` token in `template`.
pub fn render_catalog_url(template: &str, namespace: &str) -> String {
    template.replace("{namespace_slug}", &namespace_slug(namespace))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_manifest_v2() -> ManifestV2 {
        ManifestV2 {
            version: MANIFEST_V2_VERSION,
            generated_at: "2026-05-06T19:00:00Z".into(),
            source: SourceMeta {
                portal_dat_iteration: 2072,
                cell_dat_iteration: 982,
                local_dat_iteration: 994,
            },
            boot_pack: BootPackV2 {
                url: "boot.hba".into(),
                size: 1_861_361,
                sha256: "1dcb277bb9dd67bfbd0a3634f451ce714f1347e75b050acfd2cc3ce33febb395"
                    .into(),
            },
            catalog_version: 1,
            namespaces: vec![
                "eor/portal".into(),
                "eor/cell".into(),
                "eor/local".into(),
                "holtburger/core".into(),
            ],
            shard_url_template: DEFAULT_SHARD_URL_TEMPLATE_PREFIXED.into(),
            catalog_url_template: Some(DEFAULT_CATALOG_URL_TEMPLATE.into()),
        }
    }

    /// (1) The canonical v2 wire shape parses into [`ManifestV2`].
    /// Catches accidental field renames or layout drift.
    #[test]
    fn parse_canonical_v2_manifest() {
        let json = r#"{
            "version": 2,
            "generated_at": "2026-05-06T19:00:00Z",
            "source": {
                "portal_dat_iteration": 2072,
                "cell_dat_iteration": 982,
                "local_dat_iteration": 994
            },
            "boot_pack": {
                "url": "boot.hba",
                "size": 1861361,
                "sha256": "1dcb277bb9dd67bfbd0a3634f451ce714f1347e75b050acfd2cc3ce33febb395"
            },
            "catalog_version": 1,
            "namespaces": ["eor/portal", "eor/cell", "eor/local", "holtburger/core"],
            "shard_url_template": "shards/{sha256_prefix2}/{sha256}.bin",
            "catalog_url_template": "manifest/{namespace_slug}.bin"
        }"#;
        let parsed: ManifestV2 = serde_json::from_str(json).expect("parse v2 manifest");
        assert_eq!(parsed, fixture_manifest_v2());
        assert_eq!(parsed.version, MANIFEST_V2_VERSION);

        // Version probe sniffs `version` without parsing the rest.
        let probe: ManifestVersionProbe =
            serde_json::from_str(json).expect("probe v2 version");
        assert_eq!(probe.version, 2);
    }

    /// (2) Serialize → parse → equal. Catches any field rename or
    /// ordering regression. Also exercises the `Option<String>`
    /// catalog template's None-variant by clearing it.
    #[test]
    fn writeback_round_trip() {
        let original = fixture_manifest_v2();
        let json = serde_json::to_string(&original).expect("serialize");
        let back: ManifestV2 = serde_json::from_str(&json).expect("parse back");
        assert_eq!(back, original);

        // Catalog-template-absent variant: convention-URL mode
        // (no catalogs, no sha256 verification).
        let mut conv_only = original;
        conv_only.catalog_url_template = None;
        let json = serde_json::to_string(&conv_only).expect("serialize");
        let back: ManifestV2 = serde_json::from_str(&json).expect("parse back");
        assert_eq!(back.catalog_url_template, None);
    }

    /// (3) `namespace_slug` is symmetric in spirit (one-way
    /// transform, but unambiguous: `'/'` → `'-'` and AC
    /// namespaces never contain a literal `'-'`). Catches any
    /// regression in the slug rule that would break catalog
    /// filename generation.
    #[test]
    fn namespace_slug_round_trip() {
        let cases = [
            ("eor/portal", "eor-portal"),
            ("eor/cell", "eor-cell"),
            ("eor/local", "eor-local"),
            ("holtburger/core", "holtburger-core"),
            ("flat", "flat"),
            ("a/b/c", "a-b-c"),
        ];
        for (input, expected) in cases {
            assert_eq!(namespace_slug(input), expected);
            // Slug → reverse-substitute → original. The reverse
            // direction isn't exposed as a helper (no caller
            // needs it), but the rule must be invertible if a
            // future caller wants to.
            assert_eq!(expected.replace('-', "/"), input);
        }
    }

    /// (4) URL-template rendering substitutes every documented
    /// token correctly. Covers the standalone helpers + the
    /// [`ManifestV2`] methods + the `{sha256_prefix2}` ordering
    /// fix (must expand before `{sha256}`).
    #[test]
    fn url_template_rendering() {
        let manifest = fixture_manifest_v2();
        let key = ResourceKey::new("eor/portal", 0x0100_0827);
        let hash = "9f10aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

        // Standalone {sha256}-only helper.
        assert_eq!(
            render_shard_url("shards/{sha256}.bin", hash),
            format!("shards/{hash}.bin"),
        );

        // ManifestV2::shard_url with the prefixed default.
        assert_eq!(
            manifest.shard_url(key, hash),
            format!("shards/9f/{hash}.bin"),
        );

        // Convention-URL template — uses {namespace_slug} +
        // {file_id_hex}, ignores {sha256}.
        let conv_template = "shards/{namespace_slug}/{file_id_hex}.bin";
        assert_eq!(
            render_shard_url_full(conv_template, key, hash),
            "shards/eor-portal/0x01000827.bin",
        );

        // Mixed template covering all four tokens at once.
        let mixed = "{namespace_slug}/{sha256_prefix2}/{file_id_hex}-{sha256}.bin";
        assert_eq!(
            render_shard_url_full(mixed, key, hash),
            format!("eor-portal/9f/0x01000827-{hash}.bin"),
        );

        // Catalog URL — present case + None case via methods.
        assert_eq!(
            manifest.catalog_url("eor/portal"),
            Some("manifest/eor-portal.bin".to_owned()),
        );
        let mut conv_only = manifest;
        conv_only.catalog_url_template = None;
        assert_eq!(conv_only.catalog_url("eor/portal"), None);

        // Standalone catalog renderer.
        assert_eq!(
            render_catalog_url("manifest/{namespace_slug}.bin", "eor/cell"),
            "manifest/eor-cell.bin",
        );

        // {sha256_prefix2} must expand before {sha256} — verified
        // implicitly above (the prefixed template renders
        // `9f/9f10aaa…` not `9f10aaa…/9f10aaa…`). Make it
        // explicit by using a degenerate template where
        // mis-ordering would visibly corrupt output.
        let degenerate = "{sha256_prefix2}{sha256}";
        assert_eq!(
            render_shard_url_full(degenerate, key, hash),
            format!("9f{hash}"),
        );
    }

    /// (5) [`ManifestVersionProbe`] is the lightweight sniff used by
    /// `ManifestResourceSource::connect` (Phase 5.2 obj 4) to route
    /// between v1 and v2 parsers without allocating either full
    /// structure first. Verify it deserializes from minimal JSON +
    /// from a v1-shaped JSON (where it must extract just the
    /// `version` field) + from a hypothetical v3 (forward-compat:
    /// the probe must succeed even on unsupported versions, so the
    /// caller can surface a precise UnsupportedVersion error
    /// instead of a parse error).
    #[test]
    fn version_probe_sniffs_all_versions() {
        // v2 — parses the canonical fixture above's version field.
        let v2_json = r#"{"version": 2, "anything": "else"}"#;
        let probe: ManifestVersionProbe =
            serde_json::from_str(v2_json).expect("probe v2");
        assert_eq!(probe.version, 2);

        // v1 — minimal JSON with just the version field.
        let v1_json = r#"{"version": 1, "shards": {}}"#;
        let probe: ManifestVersionProbe =
            serde_json::from_str(v1_json).expect("probe v1");
        assert_eq!(probe.version, 1);

        // Unknown version — probe still succeeds; caller errors.
        let v99_json = r#"{"version": 99}"#;
        let probe: ManifestVersionProbe =
            serde_json::from_str(v99_json).expect("probe v99");
        assert_eq!(probe.version, 99);

        // Malformed JSON — probe must fail with a parse error.
        let malformed = r#"{"version":"#;
        assert!(serde_json::from_str::<ManifestVersionProbe>(malformed).is_err());

        // No `version` field — required field, probe must fail.
        let missing = r#"{"foo": "bar"}"#;
        assert!(serde_json::from_str::<ManifestVersionProbe>(missing).is_err());
    }

    /// (6) Convention-URL mode (`catalog_url_template = None`) is the
    /// minimal v2 wire shape: top-level manifest declares no
    /// catalogs at all, the page derives shard URLs purely from
    /// `(namespace, file_id)` via the `shard_url_template`. Verify
    /// the manifest helpers behave correctly in this mode for the
    /// `ManifestResourceSource::prefetch` v2 path (Phase 5.2 obj 4
    /// step 5).
    #[test]
    fn convention_url_mode_helpers() {
        let conv_only_template = "shards/{namespace_slug}/{file_id_hex}.bin";
        let mut manifest = fixture_manifest_v2();
        manifest.catalog_url_template = None;
        manifest.shard_url_template = conv_only_template.into();

        // No catalog URL exposed.
        assert_eq!(manifest.catalog_url("eor/portal"), None);
        assert_eq!(manifest.catalog_url("eor/cell"), None);

        // Shard URL renders without sha256 — the empty hash arg
        // mirrors how the resource-http prefetch path invokes
        // render_shard_url_full when no catalog entry is available.
        let key = ResourceKey::new("eor/portal", 0x0100_0827);
        let url = manifest.shard_url(key, "");
        assert_eq!(url, "shards/eor-portal/0x01000827.bin");

        // The same template + a populated hash still works (the
        // hash tokens just don't appear).
        let url_with_hash = manifest.shard_url(
            key,
            "9f10aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        assert_eq!(url_with_hash, "shards/eor-portal/0x01000827.bin");
    }
}
