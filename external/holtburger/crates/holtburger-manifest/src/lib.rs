//! Asset-delivery manifest schema for `emit-dynamic-site` Phase 5.0.
//!
//! The `dat-shard` tool (objective 3) reads canonical retail DATs and
//! emits one `manifest.json` plus a directory of
//! `shards/{sha256-hex}.bin` files plus a `boot.hba` precompiled
//! bootstrap pack. The browser's `ManifestResourceSource`
//! (objective 4) reads the manifest, fetches the boot pack at
//! construction, and lazily fetches individual shards on demand.
//!
//! This crate holds the schema types shared by both ends. Pure data
//! + serde derives + a thin sha256 helper. No I/O. Compiles native
//! + wasm32.
//!
//! # Wire shape (version 1)
//!
//! ```json
//! {
//!   "version": 1,
//!   "generated_at": "2026-05-04T19:00:00Z",
//!   "source": {
//!     "portal_dat_iteration": 2072,
//!     "cell_dat_iteration": 982,
//!     "local_dat_iteration": 994
//!   },
//!   "boot_pack": {
//!     "url": "boot.hba",
//!     "size": 5120000,
//!     "sha256": "abcd…",
//!     "covers": ["eor/portal:0x0E000002", "eor/cell:0xA9B4FFFF", "..."]
//!   },
//!   "shards": {
//!     "eor/portal:0x01000827": {
//!       "sha256": "9f10…",
//!       "size": 4129,
//!       "url": "shards/9f10…ef.bin"
//!     }
//!   }
//! }
//! ```
//!
//! # Shard key format
//!
//! `<namespace>:0x{file_id:08X}` — uppercase hex, 8 digits, `0x`
//! prefix. Round-trippable via [`format_shard_key`] /
//! [`parse_shard_key`]. Examples:
//!
//! - `eor/portal:0x0E000002` (CharGen)
//! - `eor/cell:0xA9B4FFFF` (Holtburg landblock terrain)
//! - `eor/cell:0xA9B4FFFE` (Holtburg LandblockInfo)

use std::collections::BTreeMap;

use holtburger_dat::ResourceKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub mod v2;

/// The manifest schema version this crate produces and parses. Phase
/// 5.0 ships v1; future schema-breaking changes should bump this and
/// keep the old parser available for migration.
pub const MANIFEST_VERSION: u32 = 1;

/// Top-level manifest as produced by `dat-shard` and consumed by
/// `ManifestResourceSource`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    /// Schema version. See [`MANIFEST_VERSION`].
    pub version: u32,
    /// ISO 8601 timestamp the manifest was generated at. Free-form
    /// string — no chrono dependency. Producers should write
    /// `YYYY-MM-DDTHH:MM:SSZ`.
    pub generated_at: String,
    /// Provenance — which DAT files the manifest was built from.
    pub source: SourceMeta,
    /// Bootstrap pack — small (~5 MB target) HBA with the records
    /// every client needs to reach the Selection screen + render
    /// the boot landblock.
    pub boot_pack: BootPack,
    /// Per-record shards. Keyed by `<namespace>:0x{file_id:08X}` so
    /// the browser can compose the lookup key from a `ResourceKey`
    /// without walking the map.
    pub shards: BTreeMap<String, ShardEntry>,
}

/// Provenance of the source DATs the manifest was built from. Lets
/// clients display "world built from build X" and lets ops verify
/// the manifest matches the canonical source.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct SourceMeta {
    pub portal_dat_iteration: u32,
    pub cell_dat_iteration: u32,
    pub local_dat_iteration: u32,
}

/// Bootstrap pack metadata. The pack itself is an HBA at
/// `<base_url>/<url>`; sha256 is over the raw HBA bytes for
/// integrity verification on the client.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct BootPack {
    pub url: String,
    pub size: u64,
    pub sha256: String,
    /// Resource keys served from the boot pack — formatted with
    /// [`format_shard_key`]. Lets `ManifestResourceSource::prefetch`
    /// short-circuit network fetches for keys the boot pack already
    /// covers.
    pub covers: Vec<String>,
}

/// Per-record shard metadata.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ShardEntry {
    pub sha256: String,
    pub size: u64,
    pub url: String,
}

/// Errors surfaced by manifest helpers.
#[derive(Error, Debug)]
pub enum ManifestError {
    #[error("invalid shard key {0:?}: expected `<namespace>:0x{{file_id:08X}}`")]
    InvalidShardKey(String),
    #[error("unsupported manifest version {0}: this build expects v1")]
    UnsupportedVersion(u32),
}

/// Format a `(namespace, file_id)` pair as a manifest shard key:
/// `<namespace>:0x{file_id:08X}`.
///
/// Round-trips via [`parse_shard_key`].
pub fn format_shard_key(namespace: &str, file_id: u32) -> String {
    format!("{namespace}:0x{file_id:08X}")
}

/// Inverse of [`format_shard_key`]. Parses `<namespace>:0xHHHHHHHH`
/// back into `(namespace, file_id)`. Tolerant of mixed-case hex.
pub fn parse_shard_key(key: &str) -> Result<(String, u32), ManifestError> {
    let (namespace, hex_part) = key
        .rsplit_once(':')
        .ok_or_else(|| ManifestError::InvalidShardKey(key.to_owned()))?;
    let hex = hex_part
        .strip_prefix("0x")
        .or_else(|| hex_part.strip_prefix("0X"))
        .ok_or_else(|| ManifestError::InvalidShardKey(key.to_owned()))?;
    let file_id = u32::from_str_radix(hex, 16)
        .map_err(|_| ManifestError::InvalidShardKey(key.to_owned()))?;
    Ok((namespace.to_owned(), file_id))
}

/// Format a `ResourceKey` as a manifest shard key. Convenience
/// wrapper around [`format_shard_key`] for the
/// `ManifestResourceSource` lookup path.
pub fn key_for_resource(key: ResourceKey<'_>) -> String {
    format_shard_key(key.namespace, key.file_id)
}

/// Compute the sha256 of a record's bytes, returning the lowercase
/// hex digest. This is the canonical hash form used in manifest
/// `sha256` fields and in shard URLs (`shards/{hex}.bin`).
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

impl Manifest {
    /// Look up the shard entry for a `ResourceKey`, returning `None`
    /// if the manifest doesn't have it. The boot pack is *not*
    /// consulted here — `ManifestResourceSource` checks the boot
    /// pack first and falls through to this method.
    pub fn shard_for(&self, key: ResourceKey<'_>) -> Option<&ShardEntry> {
        self.shards.get(&key_for_resource(key))
    }

    /// True if the boot pack's `covers` list mentions this key.
    pub fn boot_covers(&self, key: ResourceKey<'_>) -> bool {
        let formatted = key_for_resource(key);
        self.boot_pack.covers.iter().any(|c| *c == formatted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_manifest() -> Manifest {
        let mut shards = BTreeMap::new();
        shards.insert(
            format_shard_key("eor/portal", 0x0100_0827),
            ShardEntry {
                sha256: "9f10aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .into(),
                size: 4129,
                url: "shards/9f10aa.bin".into(),
            },
        );
        shards.insert(
            format_shard_key("eor/cell", 0xA9B4_FFFF),
            ShardEntry {
                sha256: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
                    .into(),
                size: 8192,
                url: "shards/deadbe.bin".into(),
            },
        );

        Manifest {
            version: MANIFEST_VERSION,
            generated_at: "2026-05-04T19:00:00Z".into(),
            source: SourceMeta {
                portal_dat_iteration: 2072,
                cell_dat_iteration: 982,
                local_dat_iteration: 994,
            },
            boot_pack: BootPack {
                url: "boot.hba".into(),
                size: 5_120_000,
                sha256: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
                    .into(),
                covers: vec![format_shard_key("eor/portal", 0x0E00_0002)],
            },
            shards,
        }
    }

    #[test]
    fn parse_canonical_manifest() {
        // (1) Parse — does the canonical wire shape decode into the
        // expected struct?
        let json = r#"{
            "version": 1,
            "generated_at": "2026-05-04T19:00:00Z",
            "source": {
                "portal_dat_iteration": 2072,
                "cell_dat_iteration": 982,
                "local_dat_iteration": 994
            },
            "boot_pack": {
                "url": "boot.hba",
                "size": 5120000,
                "sha256": "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
                "covers": ["eor/portal:0x0E000002"]
            },
            "shards": {
                "eor/portal:0x01000827": {
                    "sha256": "9f10aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "size": 4129,
                    "url": "shards/9f10aa.bin"
                },
                "eor/cell:0xA9B4FFFF": {
                    "sha256": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
                    "size": 8192,
                    "url": "shards/deadbe.bin"
                }
            }
        }"#;
        let parsed: Manifest = serde_json::from_str(json).expect("parse manifest");
        assert_eq!(parsed, fixture_manifest());
    }

    #[test]
    fn writeback_round_trip() {
        // (2) Serialize → parse → equal. Catches any field rename or
        // ordering regression.
        let manifest = fixture_manifest();
        let json = serde_json::to_string(&manifest).expect("serialize");
        let back: Manifest = serde_json::from_str(&json).expect("parse back");
        assert_eq!(back, manifest);
    }

    #[test]
    fn hash_determinism() {
        // (3) sha256 over the same bytes is stable across calls. Two
        // distinct byte sequences hash to distinct digests. Used to
        // pin both the shard sha256 and the manifest's boot_pack
        // sha256 across runs.
        let a = b"hello, holtburg";
        let b = b"hello, holtburg!";
        assert_eq!(sha256_hex(a), sha256_hex(a));
        assert_ne!(sha256_hex(a), sha256_hex(b));
        // Known SHA-256 digest of the empty string.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn shard_key_round_trip() {
        // (4) `format_shard_key` ↔ `parse_shard_key` is symmetric.
        // Cross-platform JSON compatibility surface: any producer
        // (Rust on macOS, Rust on Linux, future TS bindings) that
        // formats keys via this helper agrees with consumers
        // parsing via the helper.
        let cases = [
            ("eor/portal", 0x0100_0827u32),
            ("eor/cell", 0xA9B4_FFFFu32),
            ("eor/local", 0x0000_0001u32),
            ("eor/portal", 0u32),
            ("eor/portal", u32::MAX),
        ];
        for (namespace, file_id) in cases {
            let formatted = format_shard_key(namespace, file_id);
            let (parsed_ns, parsed_id) = parse_shard_key(&formatted).expect("round-trip");
            assert_eq!(parsed_ns, namespace);
            assert_eq!(parsed_id, file_id);
        }
        // Lower-case hex and missing prefix are rejected /
        // accepted per spec.
        assert!(parse_shard_key("eor/portal:0x01000827").is_ok());
        assert!(parse_shard_key("eor/portal:0x01000827".to_lowercase().as_str()).is_ok());
        assert!(parse_shard_key("eor/portal:01000827").is_err());
        assert!(parse_shard_key("no-colon").is_err());
        // Manifest method round-trip via ResourceKey.
        let manifest = fixture_manifest();
        let key = ResourceKey::new("eor/cell", 0xA9B4_FFFF);
        assert!(manifest.shard_for(key).is_some());
        let missing = ResourceKey::new("eor/cell", 0xDEAD_BEEF);
        assert!(manifest.shard_for(missing).is_none());
        let boot_key = ResourceKey::new("eor/portal", 0x0E00_0002);
        assert!(manifest.boot_covers(boot_key));
    }
}
