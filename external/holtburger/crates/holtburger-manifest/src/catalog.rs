//! Per-namespace binary catalog format — Phase 5.2 obj 3.
//!
//! [`NamespaceCatalog`] replaces the per-shard rows in v1's
//! top-level `manifest.json` (~230 bytes / entry verbose JSON) with
//! a compact binary entry stream (~19 bytes / entry, ~6× smaller
//! before gzip). One catalog file per namespace, fetched lazily
//! by `ManifestResourceSource` on first record-miss in that
//! namespace. See [`crate::v2`] module docs for the full v1 → v2
//! audit; [`crate::v2::ManifestV2::catalog_url_template`] holds
//! the URL template under which catalogs live.
//!
//! # Wire format (version 1)
//!
//! ```text
//! Header (16 bytes, little-endian):
//!   Offset  Size  Field
//!   ------  ----  -----
//!   0       4     magic           = b"HBNS"
//!   4       1     version         = 1
//!   5       1     flags           (bit 0: full-32-byte sha256;
//!                                  bits 1-7 reserved, must be 0)
//!   6       2     reserved        = 0
//!   8       4     entry_count     (u32 LE)
//!   12      4     reserved2       = 0
//!
//! Entry stream (variable, repeats entry_count times):
//!   - varint file_id_delta: ULEB128. Delta from previous
//!     entry's file_id (first entry's "previous" is 0).
//!   - 16 bytes (or 32 if flags bit 0 set): truncated or full
//!     sha256 of the record bytes.
//!   - varint size: ULEB128. Record size in bytes.
//!
//! Footer (8 bytes, little-endian):
//!   - 4 bytes: CRC32 (IEEE / zlib polynomial 0xEDB88320,
//!     init 0xFFFFFFFF, final XOR 0xFFFFFFFF) over the header
//!     + entry stream (NOT including the footer itself).
//!   - 4 bytes: trailing magic = b"SNBH" (HBNS reversed).
//! ```
//!
//! Entries are sorted by `file_id` ascending. Lookup uses binary
//! search for O(log n) cost.
//!
//! # Empirical sizing on a real-world bake
//!
//! - file_id_delta: ~1.2 bytes avg (sorted, sparse u32 deltas)
//! - sha256_truncated: 16 bytes
//! - size: ~2 bytes avg (most records 1-1000 KB)
//! - **Total: ~19 bytes per entry**
//!
//! For `eor/cell` 805k entries: 19 MB raw, ~6-8 MB gzipped.
//! For `eor/portal` 80k entries: 1.5 MB raw, <1 MB gzipped.

use std::io::{self, Write};

/// Leading magic bytes (`HBNS`). Identifies the file as a
/// holtburger-namespace-catalog binary.
pub const CATALOG_MAGIC: [u8; 4] = *b"HBNS";

/// Trailing magic bytes (`SNBH`). Reversed leading magic; placed
/// at end-of-file to detect truncation.
pub const CATALOG_TRAILING_MAGIC: [u8; 4] = *b"SNBH";

/// Catalog wire-format version. Bumped on incompatible layout
/// changes; consumers reject unknown versions on read.
pub const CATALOG_FORMAT_VERSION: u8 = 1;

/// Flags bit 0: each entry carries a 32-byte sha256 instead of
/// the truncated 16-byte default. Use only when the deployment
/// genuinely needs full 256-bit collision resistance (e.g. an
/// untrusted CDN); the default 128-bit truncation is collision-
/// resistant to 2^64, far beyond any realistic AC asset count.
pub const CATALOG_FLAG_FULL_SHA256: u8 = 1 << 0;

const HEADER_SIZE: usize = 16;
const FOOTER_SIZE: usize = 8;

/// One per-record listing. The catalog stores the digest in
/// truncated form by default (16 bytes); see
/// [`CATALOG_FLAG_FULL_SHA256`] for the full-hash mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogEntry {
    pub file_id: u32,
    /// Truncated sha256 (first 16 bytes of the 32-byte digest).
    /// When [`NamespaceCatalog::flags`] has [`CATALOG_FLAG_FULL_SHA256`]
    /// set the on-disk format stores the full 32 bytes; the
    /// extra 16 bytes are not exposed in this struct (callers
    /// truncate to 128 bits at parse time and use the truncated
    /// hash for batch verification).
    pub sha256_truncated: [u8; 16],
    /// Decompressed size in bytes. Mirrors HTTP `Content-Length`
    /// for the canonical shard fetch.
    pub size: u64,
}

/// All entries for one namespace. Sorted by `file_id` ascending
/// — delta encoding requires it on write, and binary-search
/// [`Self::lookup`] requires it on read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NamespaceCatalog {
    pub namespace: String,
    pub flags: u8,
    pub entries: Vec<CatalogEntry>,
}

/// Errors surfaced by [`NamespaceCatalog::read_from`].
#[derive(thiserror::Error, Debug)]
pub enum CatalogError {
    /// Leading magic (`HBNS`) didn't match.
    #[error("bad magic — not a NamespaceCatalog binary")]
    BadMagic,
    /// Trailing magic (`SNBH`) didn't match. Implies truncation
    /// or end-of-file corruption.
    #[error("bad trailing magic — file truncated or corrupted")]
    BadTrailingMagic,
    /// Header version byte is not [`CATALOG_FORMAT_VERSION`].
    #[error("unsupported catalog version {0} (this build expects v{CATALOG_FORMAT_VERSION})")]
    UnsupportedVersion(u8),
    /// Unknown flag bits set. Reserved bits must be zero so
    /// future flag additions don't silently misparse.
    #[error("unknown flag bits 0x{0:02x}")]
    UnknownFlags(u8),
    /// Footer CRC32 didn't match the computed CRC32 of header +
    /// entries.
    #[error("crc32 mismatch: header+entries hash to {got:08x}, footer says {expected:08x}")]
    CrcMismatch { expected: u32, got: u32 },
    /// `entry_count` × per-entry size exceeds available bytes.
    #[error("entry count overflow: declared {declared} but only {available} bytes remain")]
    EntryCountOverflow { declared: u64, available: usize },
    /// Ran out of bytes mid-entry — varint EOF or hash EOF.
    #[error("truncated input at offset {0}")]
    Truncated(usize),
}

impl NamespaceCatalog {
    /// Build a new catalog. Sorts entries by `file_id` before
    /// returning; the caller doesn't need to pre-sort. Call sites
    /// that already have sorted entries pay only the O(n)
    /// stable-sort cost on already-sorted input.
    pub fn new(namespace: String, flags: u8, mut entries: Vec<CatalogEntry>) -> Self {
        entries.sort_by_key(|e| e.file_id);
        Self {
            namespace,
            flags,
            entries,
        }
    }

    /// Find an entry by `file_id`. O(log n) binary search.
    pub fn lookup(&self, file_id: u32) -> Option<&CatalogEntry> {
        self.entries
            .binary_search_by_key(&file_id, |e| e.file_id)
            .ok()
            .map(|i| &self.entries[i])
    }

    /// Serialize the catalog to `out`. Returns the same `out`
    /// on success so callers can chain.
    pub fn write_to<W: Write>(&self, out: &mut W) -> io::Result<()> {
        let body = self.encode_body();
        let crc = crc32_ieee(&body);
        out.write_all(&body)?;
        out.write_all(&crc.to_le_bytes())?;
        out.write_all(&CATALOG_TRAILING_MAGIC)?;
        Ok(())
    }

    /// Encode header + entries into a buffer (no footer). The
    /// CRC32 is computed over this buffer; splitting the
    /// computation out lets callers re-use the buffer for both
    /// hashing and writing without two passes.
    fn encode_body(&self) -> Vec<u8> {
        // Reserve a tight estimate. ~19 bytes/entry on average;
        // pre-size avoids reallocations on large catalogs.
        let mut body = Vec::with_capacity(HEADER_SIZE + self.entries.len() * 24);

        // Header.
        body.extend_from_slice(&CATALOG_MAGIC);
        body.push(CATALOG_FORMAT_VERSION);
        body.push(self.flags);
        body.extend_from_slice(&[0u8; 2]); // reserved
        body.extend_from_slice(&(self.entries.len() as u32).to_le_bytes());
        body.extend_from_slice(&[0u8; 4]); // reserved2

        // Entry stream.
        let full_hash = (self.flags & CATALOG_FLAG_FULL_SHA256) != 0;
        let mut prev_file_id: u32 = 0;
        for entry in &self.entries {
            let delta = entry
                .file_id
                .checked_sub(prev_file_id)
                .expect("entries must be sorted ascending by file_id");
            write_uleb128(&mut body, delta as u64);
            body.extend_from_slice(&entry.sha256_truncated);
            if full_hash {
                // Full-hash mode requires storing 32 bytes per
                // entry. The struct only carries 16; producers
                // using full-hash mode would need to re-hash here.
                // Phase 5.2 obj 3 ships truncated-only; opting
                // into full hash is a future extension that
                // requires extending CatalogEntry too. Until
                // then, error rather than emit wrong bytes.
                panic!("CATALOG_FLAG_FULL_SHA256 not supported in obj 3 codec");
            }
            write_uleb128(&mut body, entry.size);
            prev_file_id = entry.file_id;
        }
        body
    }

    /// Parse a catalog binary from `bytes`. Verifies magic +
    /// version + flags + footer CRC32 + trailing magic before
    /// returning entries.
    pub fn read_from(bytes: &[u8], namespace: impl Into<String>) -> Result<Self, CatalogError> {
        if bytes.len() < HEADER_SIZE + FOOTER_SIZE {
            return Err(CatalogError::Truncated(bytes.len()));
        }
        // Header.
        if bytes[..4] != CATALOG_MAGIC {
            return Err(CatalogError::BadMagic);
        }
        let version = bytes[4];
        if version != CATALOG_FORMAT_VERSION {
            return Err(CatalogError::UnsupportedVersion(version));
        }
        let flags = bytes[5];
        let unknown_flags = flags & !CATALOG_FLAG_FULL_SHA256;
        if unknown_flags != 0 {
            return Err(CatalogError::UnknownFlags(unknown_flags));
        }
        let full_hash = (flags & CATALOG_FLAG_FULL_SHA256) != 0;
        if full_hash {
            return Err(CatalogError::UnknownFlags(CATALOG_FLAG_FULL_SHA256));
        }
        // bytes[6..8] reserved (ignore).
        let entry_count = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
        // bytes[12..16] reserved2 (ignore).

        // Footer.
        let footer_start = bytes.len() - FOOTER_SIZE;
        let footer = &bytes[footer_start..];
        let stored_crc = u32::from_le_bytes([footer[0], footer[1], footer[2], footer[3]]);
        if footer[4..8] != CATALOG_TRAILING_MAGIC {
            return Err(CatalogError::BadTrailingMagic);
        }

        // CRC32 over header + entries (everything before the footer).
        let body = &bytes[..footer_start];
        let computed_crc = crc32_ieee(body);
        if computed_crc != stored_crc {
            return Err(CatalogError::CrcMismatch {
                expected: stored_crc,
                got: computed_crc,
            });
        }

        // Entry stream.
        let entry_bytes = &bytes[HEADER_SIZE..footer_start];
        let mut entries = Vec::with_capacity(entry_count as usize);
        let mut offset = 0usize;
        let mut prev_file_id: u32 = 0;
        for _ in 0..entry_count {
            let absolute = HEADER_SIZE + offset;
            let delta = read_uleb128(entry_bytes, &mut offset)
                .ok_or(CatalogError::Truncated(absolute))?;
            let file_id = prev_file_id
                .checked_add(delta as u32)
                .ok_or(CatalogError::EntryCountOverflow {
                    declared: entry_count as u64,
                    available: entry_bytes.len(),
                })?;
            if entry_bytes.len() < offset + 16 {
                return Err(CatalogError::Truncated(HEADER_SIZE + offset));
            }
            let mut hash = [0u8; 16];
            hash.copy_from_slice(&entry_bytes[offset..offset + 16]);
            offset += 16;
            let absolute = HEADER_SIZE + offset;
            let size =
                read_uleb128(entry_bytes, &mut offset).ok_or(CatalogError::Truncated(absolute))?;
            entries.push(CatalogEntry {
                file_id,
                sha256_truncated: hash,
                size,
            });
            prev_file_id = file_id;
        }
        if offset != entry_bytes.len() {
            return Err(CatalogError::EntryCountOverflow {
                declared: entry_count as u64,
                available: entry_bytes.len(),
            });
        }

        Ok(Self {
            namespace: namespace.into(),
            flags,
            entries,
        })
    }
}

/// Write an unsigned ULEB128 varint. Each output byte's high bit
/// signals continuation; low 7 bits hold value.
fn write_uleb128(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let mut byte = (value & 0x7F) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
            out.push(byte);
        } else {
            out.push(byte);
            return;
        }
    }
}

/// Read an unsigned ULEB128 varint from `bytes` starting at
/// `*offset`. Advances `*offset` past the consumed bytes on
/// success. Returns `None` on EOF or overflow (>10 bytes).
fn read_uleb128(bytes: &[u8], offset: &mut usize) -> Option<u64> {
    let mut value: u64 = 0;
    let mut shift = 0u32;
    let mut consumed = 0usize;
    while *offset + consumed < bytes.len() {
        let byte = bytes[*offset + consumed];
        consumed += 1;
        // Per spec: at most 10 bytes for a 64-bit varint.
        if consumed > 10 {
            return None;
        }
        value |= ((byte & 0x7F) as u64) << shift;
        if byte & 0x80 == 0 {
            *offset += consumed;
            return Some(value);
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
    None
}

/// CRC32 IEEE (zlib / PNG / ITU-V.42) over `bytes`. Polynomial
/// 0xEDB88320, init 0xFFFFFFFF, final XOR 0xFFFFFFFF. The same
/// algorithm as `crc32fast` / `flate2`.
///
/// Inline implementation (no extra dependency). Public since the
/// pipeline re-engineering (T10): the HBP1/HBSI1 pack containers
/// reuse the exact HBNS footer convention (crc32 + reversed
/// trailing magic), so the bake tool needs the same function —
/// exporting it keeps the two footers provably the same algorithm.
pub fn crc32_ieee(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in bytes {
        crc ^= b as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320u32 & mask);
        }
    }
    crc ^ 0xFFFF_FFFF
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_entry(file_id: u32) -> CatalogEntry {
        // Distinct hash per id for round-trip equality.
        let mut hash = [0u8; 16];
        hash[..4].copy_from_slice(&file_id.to_le_bytes());
        hash[4..8].copy_from_slice(&file_id.to_be_bytes());
        // Distinct size per id, exercising 1-, 2-, and 3-byte
        // varint widths.
        let size = (file_id as u64).wrapping_mul(127).wrapping_add(1);
        CatalogEntry {
            file_id,
            sha256_truncated: hash,
            size,
        }
    }

    fn synthetic_catalog(count: u32) -> NamespaceCatalog {
        let entries = (0..count).map(|i| synthetic_entry(0x0100_0000 + i)).collect();
        NamespaceCatalog::new("eor/portal".into(), 0, entries)
    }

    /// (a) Write a 100-entry catalog, parse it back, assert
    /// every entry round-trips bit-exact.
    #[test]
    fn write_read_round_trip() {
        let original = synthetic_catalog(100);
        let mut buf = Vec::new();
        original.write_to(&mut buf).expect("write");
        // The 100-entry catalog should be small (~2 KB) — pin
        // the order-of-magnitude so a regression in the entry
        // stream layout shows up.
        assert!(buf.len() < 4_096, "catalog too large: {} bytes", buf.len());
        assert!(buf.len() > 1_024, "catalog suspiciously small: {} bytes", buf.len());

        let parsed =
            NamespaceCatalog::read_from(&buf, "eor/portal").expect("read");
        assert_eq!(parsed, original);
        assert_eq!(parsed.entries.len(), 100);
    }

    /// (b) Lookup returns the right entry for present file_ids
    /// and `None` for absent ones.
    #[test]
    fn lookup_hits_and_misses() {
        let catalog = synthetic_catalog(50);

        // Every emitted file_id resolves.
        for i in 0..50u32 {
            let id = 0x0100_0000 + i;
            let entry = catalog.lookup(id).unwrap_or_else(|| panic!("hit {id:#x}"));
            assert_eq!(entry.file_id, id);
            assert_eq!(entry.size, (id as u64).wrapping_mul(127).wrapping_add(1));
        }

        // Below, between, and above the range — all miss.
        assert!(catalog.lookup(0x0100_0000 - 1).is_none());
        assert!(catalog.lookup(0x0100_0000 + 50).is_none());
        assert!(catalog.lookup(u32::MAX).is_none());
    }

    /// (c) Reading bytes whose leading magic isn't `HBNS`
    /// returns [`CatalogError::BadMagic`].
    #[test]
    fn bad_magic_detection() {
        let mut buf = Vec::new();
        synthetic_catalog(10)
            .write_to(&mut buf)
            .expect("write");
        // Corrupt the leading magic.
        buf[0] = b'X';
        let err = NamespaceCatalog::read_from(&buf, "eor/portal").unwrap_err();
        assert!(matches!(err, CatalogError::BadMagic), "got {err:?}");

        // Restore + corrupt trailing magic.
        let mut buf2 = Vec::new();
        synthetic_catalog(10).write_to(&mut buf2).expect("write");
        let n = buf2.len();
        buf2[n - 1] = b'X';
        let err = NamespaceCatalog::read_from(&buf2, "eor/portal").unwrap_err();
        assert!(matches!(err, CatalogError::BadTrailingMagic), "got {err:?}");

        // Truncated short of the header threshold.
        let err = NamespaceCatalog::read_from(b"HBNS\x01", "eor/portal").unwrap_err();
        assert!(matches!(err, CatalogError::Truncated(_)), "got {err:?}");
    }

    /// (d) Tampering with the entry stream fails the CRC check.
    #[test]
    fn crc_mismatch_detection() {
        let mut buf = Vec::new();
        synthetic_catalog(10).write_to(&mut buf).expect("write");

        // Flip a byte in the first entry's hash. The footer's
        // CRC was computed pre-flip, so the post-flip CRC
        // mismatches.
        let entry_byte = HEADER_SIZE + 5; // past the file_id varint
        buf[entry_byte] ^= 0xFF;

        let err = NamespaceCatalog::read_from(&buf, "eor/portal").unwrap_err();
        match err {
            CatalogError::CrcMismatch { expected, got } => {
                assert_ne!(expected, got);
            }
            other => panic!("expected CrcMismatch, got {other:?}"),
        }
    }

    /// (e) ULEB128 varints round-trip correctly across the
    /// 1/2/3/4/5-byte width boundaries — the values where
    /// each new continuation byte starts being used.
    #[test]
    fn varint_width_boundaries() {
        let cases: &[u64] = &[
            0,
            1,
            0x7F,        // last 1-byte value
            0x80,        // first 2-byte value
            0x3FFF,      // last 2-byte value
            0x4000,      // first 3-byte value
            0x1F_FFFF,   // last 3-byte value
            0x20_0000,   // first 4-byte value
            0x0FFF_FFFF, // last 4-byte value
            0x1000_0000, // first 5-byte value
            u32::MAX as u64,
            u64::MAX,
        ];
        for &value in cases {
            let mut buf = Vec::new();
            write_uleb128(&mut buf, value);
            let mut offset = 0;
            let parsed = read_uleb128(&buf, &mut offset).expect("read");
            assert_eq!(parsed, value, "round-trip {value:#x}");
            assert_eq!(offset, buf.len(), "consumed all bytes for {value:#x}");
        }

        // Encoded width matches the canonical ULEB128 sizing.
        let mut buf = Vec::new();
        write_uleb128(&mut buf, 0x7F);
        assert_eq!(buf.len(), 1);
        let mut buf = Vec::new();
        write_uleb128(&mut buf, 0x80);
        assert_eq!(buf.len(), 2);
        let mut buf = Vec::new();
        write_uleb128(&mut buf, 0x4000);
        assert_eq!(buf.len(), 3);

        // EOF on read returns None rather than panicking.
        let mut offset = 0;
        assert!(read_uleb128(&[0x80, 0x80], &mut offset).is_none());

        // Overflow (>10 continuation bytes) returns None.
        let oversized = [0x80u8; 11];
        let mut offset = 0;
        assert!(read_uleb128(&oversized, &mut offset).is_none());
    }
}
