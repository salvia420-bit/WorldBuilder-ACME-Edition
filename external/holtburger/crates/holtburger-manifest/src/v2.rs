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

use std::collections::BTreeMap;

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
    /// T10 additive v2+ field: HBSI1 spatial-index pointer. `None` on
    /// legacy-only bakes (field omitted from the JSON entirely, so
    /// pre-pack manifests round-trip byte-identical). Presence routes
    /// pack-capable clients onto the HBP1 pack path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub world_index: Option<WorldIndexRef>,
    /// T10 additive v2+ field: pack URL template
    /// ([`DEFAULT_PACK_URL_TEMPLATE`]). Emitted iff `world_index` is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack_url_template: Option<String>,
    /// 2026-10-06 additive v2+ field: per-namespace REGIONAL catalogs,
    /// keyed by namespace (in practice only `eor/cell`). The whole-namespace
    /// `eor-cell.bin` is 805k entries / 15.4 MB (sha256 prefixes — it does
    /// not compress: 14 MB on the wire), and the FIRST lookup of any cell
    /// record — terrain heightmaps included — blocks on all of it; a
    /// Holtburg session needed 296 of those entries. A regioned namespace
    /// instead fetches the catalog of the landblock region a key falls in
    /// (see [`CatalogRegions`]). Absent ⇒ the whole-namespace catalog, as
    /// before; older clients ignore the field (no `deny_unknown_fields`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_regions: Option<BTreeMap<String, CatalogRegions>>,
}

/// Region split of one namespace's catalog (`catalog_regions` above).
///
/// Cell-dat file ids are landblock-keyed: `0xXXYYnnnn`, landblock
/// `(lbx, lby) = (id >> 24, (id >> 16) & 0xFF)`. The 256×256 landblock grid
/// is cut into `lb_block`×`lb_block` squares, numbered row-major on x:
/// `region = (lbx / lb_block) * (256 / lb_block) + (lby / lb_block)`.
/// Each region's catalog is an ordinary HBNS [`crate::catalog::NamespaceCatalog`]
/// holding exactly the namespace entries whose ids fall in it; a region with
/// no entries has no file (404 ⇒ empty region, every key in it absent).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct CatalogRegions {
    /// URL template with `{namespace_slug}` and `{region}` (3 lowercase
    /// hex digits, zero-padded), relative to the manifest like every other
    /// URL, e.g. `manifest/regions/{namespace_slug}/{region}.bin`.
    pub url_template: String,
    /// Region edge in landblocks. A power of two in `1..=256`.
    pub lb_block: u16,
}

/// Default region-catalog URL template.
pub const DEFAULT_CATALOG_REGION_URL_TEMPLATE: &str =
    "manifest/regions/{namespace_slug}/{region}.bin";

impl CatalogRegions {
    /// True when `lb_block` is a power of two in `1..=256`.
    pub fn is_valid(&self) -> bool {
        self.lb_block >= 1 && self.lb_block <= 256 && self.lb_block.is_power_of_two()
    }

    /// Region index of `file_id`, or `None` for an invalid split.
    pub fn region_of(&self, file_id: u32) -> Option<u32> {
        if !self.is_valid() {
            return None;
        }
        let b = u32::from(self.lb_block);
        let per_axis = 256 / b;
        let lbx = file_id >> 24;
        let lby = (file_id >> 16) & 0xFF;
        Some((lbx / b) * per_axis + (lby / b))
    }

    /// Number of regions the split defines (`(256 / lb_block)^2`).
    pub fn region_count(&self) -> u32 {
        if !self.is_valid() {
            return 0;
        }
        let per_axis = 256 / u32::from(self.lb_block);
        per_axis * per_axis
    }

    /// Render the catalog URL of `region` for `namespace`.
    pub fn region_url(&self, namespace: &str, region: u32) -> String {
        self.url_template
            .replace("{namespace_slug}", &namespace_slug(namespace))
            .replace("{region}", &format!("{region:03x}"))
    }
}

/// Cheap version-only probe deserializer. The v2 connect path
/// uses this to route between v1 and v2 parsers without
/// allocating the full structure first.
#[derive(Deserialize, Debug, Clone, Copy)]
pub struct ManifestVersionProbe {
    pub version: u32,
}

/// Pipeline re-engineering (T10 / SPEC §1.1): pointer to the HBSI1
/// spatial index that roots the HBP1 pack world. Additive v2+ field —
/// the manifest stays `version: 2` during coexistence (deployed
/// clients hard-fail on version ≠ 1,2), and pack-capable clients
/// route on the PRESENCE of `world_index`, never on a version bump.
/// The sentinel flips to 3 only at ST10 (legacy retirement).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct WorldIndexRef {
    /// Relative URL of the index binary, e.g.
    /// `index/{trunc-sha256-32hex}.bin`. Content-addressed —
    /// immutable by name.
    pub url: String,
    /// Byte length of the index file.
    pub size: u64,
    /// Truncated sha256 (16 bytes, 32 lowercase hex chars) of the
    /// index file bytes — what the client verifies on receipt.
    pub sha256_16: String,
}

/// Default pack URL template (SPEC §1.1 / pass 2 D-02.3). Same token
/// vocabulary as [`DEFAULT_SHARD_URL_TEMPLATE_PREFIXED`]; the digest
/// substituted is the pack's truncated sha256 (32 hex chars).
pub const DEFAULT_PACK_URL_TEMPLATE: &str = "packs/{sha256_prefix2}/{sha256}.hbp";

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

    /// The region split for `namespace`, if the manifest declares a valid one.
    pub fn catalog_regions_for(&self, namespace: &str) -> Option<&CatalogRegions> {
        self.catalog_regions
            .as_ref()?
            .get(namespace)
            .filter(|r| r.is_valid())
    }

    /// Which catalog holds `file_id` of `namespace`: `(cache_key, url)`.
    ///
    /// Regioned namespace ⇒ `("<ns>#<region:03x>", region url)`; otherwise
    /// `("<ns>", whole-namespace catalog url)`. `None` when the manifest
    /// declares no catalog template at all (convention-URL mode). The cache
    /// key is what a client keys its resident-catalog map by — a namespace
    /// string never contains `#`, so the two key spaces cannot collide.
    pub fn catalog_for_key(&self, namespace: &str, file_id: u32) -> Option<(String, String)> {
        self.catalog_url_template.as_ref()?;
        if let Some(r) = self.catalog_regions_for(namespace) {
            let region = r.region_of(file_id)?;
            return Some((format!("{namespace}#{region:03x}"), r.region_url(namespace, region)));
        }
        Some((namespace.to_string(), self.catalog_url(namespace)?))
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
            world_index: None,
            pack_url_template: None,
            catalog_regions: None,
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

    /// T10: the v2+ pack fields are strictly additive. A legacy bake
    /// (both `None`) serializes WITHOUT the keys — byte-identical to the
    /// pre-T10 wire shape — and a legacy manifest (no keys) parses with
    /// both fields `None`. A pack bake round-trips both fields, keeps
    /// `version: 2`, and presence of `world_index` is the routing signal.
    #[test]
    fn pack_fields_are_additive_and_presence_routed() {
        // Legacy emission: keys absent from the JSON entirely.
        let legacy = fixture_manifest_v2();
        let json = serde_json::to_string(&legacy).expect("serialize");
        assert!(!json.contains("world_index"));
        assert!(!json.contains("pack_url_template"));

        // Legacy parse (pre-T10 JSON) → both None.
        let back: ManifestV2 = serde_json::from_str(&json).expect("parse legacy");
        assert_eq!(back.world_index, None);
        assert_eq!(back.pack_url_template, None);

        // Pack emission: fields present, version STAYS 2.
        let mut packed = legacy;
        packed.world_index = Some(WorldIndexRef {
            url: "index/00112233445566778899aabbccddeeff.bin".into(),
            size: 489_000,
            sha256_16: "00112233445566778899aabbccddeeff".into(),
        });
        packed.pack_url_template = Some(DEFAULT_PACK_URL_TEMPLATE.into());
        let json = serde_json::to_string(&packed).expect("serialize packed");
        let back: ManifestV2 = serde_json::from_str(&json).expect("parse packed");
        assert_eq!(back.version, MANIFEST_V2_VERSION, "sentinel must stay 2");
        assert_eq!(back, packed);
        assert!(back.world_index.is_some(), "presence is the route signal");
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

    // ── 2026-10-06 regional catalogs ────────────────────────────────────

    fn regions8() -> CatalogRegions {
        CatalogRegions {
            url_template: DEFAULT_CATALOG_REGION_URL_TEMPLATE.into(),
            lb_block: 8,
        }
    }

    #[test]
    fn region_math_is_landblock_row_major() {
        let r = regions8();
        assert!(r.is_valid());
        assert_eq!(r.region_count(), 1024);
        // Holtburg 0xA9B4: lbx 0xA9 / 8 = 21, lby 0xB4 / 8 = 22 → 21*32 + 22.
        assert_eq!(r.region_of(0xA9B4_0024), Some(21 * 32 + 22));
        // LandBlockInfo / landblock records share the cell's region.
        assert_eq!(r.region_of(0xA9B4_FFFE), r.region_of(0xA9B4_0100));
        assert_eq!(r.region_of(0xA9B4_FFFF), r.region_of(0xA9B4_0100));
        // Corners.
        assert_eq!(r.region_of(0x0000_0001), Some(0));
        assert_eq!(r.region_of(0xFFFF_FFFF), Some(1023));
        // A neighbouring landblock across a region edge lands next door.
        assert_eq!(r.region_of(0xA8B4_0001), Some(21 * 32 + 22));
        assert_eq!(r.region_of(0xA7B4_0001), Some(20 * 32 + 22));
    }

    #[test]
    fn region_split_rejects_bad_block_sizes() {
        for b in [0u16, 3, 6, 257, 512] {
            let r = CatalogRegions { url_template: "x".into(), lb_block: b };
            assert!(!r.is_valid(), "lb_block {b} must be invalid");
            assert_eq!(r.region_of(0x1234_5678), None);
            assert_eq!(r.region_count(), 0);
        }
        for b in [1u16, 2, 16, 256] {
            assert!(CatalogRegions { url_template: "x".into(), lb_block: b }.is_valid());
        }
    }

    #[test]
    fn region_url_renders_slug_and_padded_hex() {
        let r = regions8();
        assert_eq!(r.region_url("eor/cell", 0), "manifest/regions/eor-cell/000.bin");
        assert_eq!(r.region_url("eor/cell", 0x2b6), "manifest/regions/eor-cell/2b6.bin");
        assert_eq!(r.region_url("eor/cell", 1023), "manifest/regions/eor-cell/3ff.bin");
    }

    #[test]
    fn catalog_for_key_routes_regioned_namespaces_only() {
        let mut m = fixture_manifest_v2();
        // No regions declared ⇒ whole-namespace catalog, keyed by namespace.
        assert_eq!(
            m.catalog_for_key("eor/cell", 0xA9B4_0024),
            Some(("eor/cell".into(), "manifest/eor-cell.bin".into()))
        );
        let mut regions = BTreeMap::new();
        regions.insert("eor/cell".to_string(), regions8());
        m.catalog_regions = Some(regions);
        assert_eq!(
            m.catalog_for_key("eor/cell", 0xA9B4_0024),
            Some(("eor/cell#2b6".into(), "manifest/regions/eor-cell/2b6.bin".into()))
        );
        // Other namespaces are untouched by a cell split.
        assert_eq!(
            m.catalog_for_key("eor/portal", 0x0100_0827),
            Some(("eor/portal".into(), "manifest/eor-portal.bin".into()))
        );
        // An invalid split is ignored, not half-applied.
        m.catalog_regions.as_mut().unwrap().get_mut("eor/cell").unwrap().lb_block = 6;
        assert_eq!(
            m.catalog_for_key("eor/cell", 0xA9B4_0024),
            Some(("eor/cell".into(), "manifest/eor-cell.bin".into()))
        );
        // Convention-URL mode stays convention-URL mode.
        m.catalog_url_template = None;
        assert_eq!(m.catalog_for_key("eor/cell", 0xA9B4_0024), None);
    }

    #[test]
    fn catalog_regions_is_additive_on_the_wire() {
        // A manifest without the field (every deployed bake before 2026-10-06)
        // parses with `None` and re-serializes WITHOUT the key.
        let m = fixture_manifest_v2();
        let json = serde_json::to_string(&m).unwrap();
        assert!(!json.contains("catalog_regions"));
        let back: ManifestV2 = serde_json::from_str(&json).unwrap();
        assert_eq!(back.catalog_regions, None);
        // With the field, it round-trips.
        let mut m2 = fixture_manifest_v2();
        let mut regions = BTreeMap::new();
        regions.insert("eor/cell".to_string(), regions8());
        m2.catalog_regions = Some(regions);
        let json2 = serde_json::to_string(&m2).unwrap();
        assert!(json2.contains("\"catalog_regions\""));
        let back2: ManifestV2 = serde_json::from_str(&json2).unwrap();
        assert_eq!(back2, m2);
    }
}
