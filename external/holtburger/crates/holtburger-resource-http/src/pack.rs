//! `PackSource` / `CompositeSource` — pipeline re-engineering T12 (ST2,
//! SPEC.md §1.1; pass 3 S1.3, pass 2 S2–S4 as amended by T10's landed
//! emitter).
//!
//! Client-side consumption of the `HBP1` pack container and `HBSI1`
//! spatial index that `dat-shard --emit-packs` (T10) writes. The BYTE
//! TRUTH for both formats is `apps/holtburger-tools/src/pack_format.rs`
//! (module docs there record T10's layout deltas D1/D4: 44 B PLACEMENTS
//! rows, 24 B padded HBSI1 pack rows, 16 B per-LB SPAWNS/EVENTS
//! preambles, 64-cell supergrid). This module re-implements the READ
//! side only — the tools crate is a native-only binary crate and depends
//! the wrong way for the wasm client, so the layouts are mirrored here
//! and pinned against T10's real baked region by
//! `tests/pack_source_region.rs`.
//!
//! Data flow (pass 3 S1):
//!
//! ```text
//!   PackFetchController (JS) — fetches, verifies sha256 vs CAS name
//!        │  verified ArrayBuffer
//!        ▼
//!   insert_pack(hash16, bytes)  — CRC + pinned-index membership check
//!        ▼
//!   PackSource : ResourceSource — sync record reads over resident packs
//!   CompositeSource = PackSource → legacy source (fallback)
//! ```
//!
//! Target-agnostic on purpose: native `cargo test` exercises the exact
//! code the wasm client runs (zstd is the only cfg fork, mirroring
//! `holtburger-dat/src/archive.rs`: C-backed `zstd` native, pure-Rust
//! `ruzstd` on wasm32).
//!
//! What this module does NOT do (by design):
//! - fetch anything — the JS controller is the sole fetch authority
//!   (pass 3 D-03.3); wasm consumes pushed, verified bytes;
//! - verify sha256 — hash-on-receipt happens in the controller BEFORE
//!   admission (pass 3 D-03.5); `insert_pack` re-checks the container
//!   CRC32 (decode-time corruption backstop, pass 3 S5) and that the
//!   hash is listed by the pinned index (deploy-skew guard);
//! - prove absence — `key_known_absent` is `false` here: a resident
//!   tile pack lacking a record does not prove the record absent
//!   globally (shared packs may be un-fetched; the legacy lane may
//!   carry it). The composite forwards absence proofs to the legacy
//!   source's catalogs only.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use holtburger_dat::{
    DatError, FileMetadata, ResourceKey, ResourceSource, Result as DatResult,
};

// ---------------------------------------------------------------------------
// container constants (mirror of pack_format.rs — the byte truth)
// ---------------------------------------------------------------------------

pub const HBP1_MAGIC: &[u8; 4] = b"HBP1";
pub const HBP1_TRAILING_MAGIC: &[u8; 4] = b"1PBH";
pub const HBP1_VERSION: u8 = 1;
pub const HBP1_HEADER_LEN: usize = 32;
pub const HBP1_SECTION_ENTRY_LEN: usize = 16;
pub const HBP1_FOOTER_LEN: usize = 8;

pub mod pack_kind {
    pub const TILE: u8 = 0;
    pub const INTERIOR: u8 = 1;
    pub const META_SHARED: u8 = 2;
    pub const PREVIEW: u8 = 3;
    pub const ENV: u8 = 4;
    pub const CORE: u8 = 5;
    pub const TERRAIN_SLICE_COLOR: u8 = 6;
    pub const TERRAIN_SLICE_NRA: u8 = 7;
}

pub mod section_kind {
    pub const TERRAIN: u16 = 0x01;
    pub const LBINFO: u16 = 0x02;
    pub const ENVCELLS: u16 = 0x03;
    pub const PLACEMENTS: u16 = 0x04;
    pub const SPAWNS: u16 = 0x05;
    pub const EVENTS: u16 = 0x06;
    pub const RECORDS: u16 = 0x07;
    pub const REFS: u16 = 0x08;
    pub const GEOM: u16 = 0x09;
    pub const TEXREF: u16 = 0x0A;
    pub const PVW: u16 = 0x0B;
}

pub mod codec {
    pub const RAW: u8 = 0;
    pub const ZSTD: u8 = 1;
}

pub const HBSI_MAGIC: &[u8; 4] = b"HBSI";
pub const HBSI_TRAILING_MAGIC: &[u8; 4] = b"ISBH";
pub const HBSI_VERSION: u8 = 1;
pub const HBSI_HEADER_LEN: usize = 24;
pub const HBSI_TILE_GRID_LEN: usize = 128 * 128 * 2;
pub const HBSI_PACK_ENTRY_LEN: usize = 24;
pub const TILE_EMPTY: u16 = 0xFFFF;

/// CRC32-IEEE — same function/polynomial as the HBNS catalog footer
/// (`holtburger_manifest::catalog::crc32_ieee`, made pub by T10).
use holtburger_manifest::catalog::crc32_ieee;

// ---------------------------------------------------------------------------
// zstd (cfg fork mirrors holtburger-dat/src/archive.rs)
// ---------------------------------------------------------------------------

#[cfg(not(target_arch = "wasm32"))]
fn decompress_zstd(buffer: &[u8], expected_size: usize) -> Result<Vec<u8>, String> {
    zstd::bulk::decompress(buffer, expected_size).map_err(|e| format!("zstd: {e}"))
}

#[cfg(target_arch = "wasm32")]
fn decompress_zstd(buffer: &[u8], expected_size: usize) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut decoder = ruzstd::decoding::StreamingDecoder::new(buffer)
        .map_err(|e| format!("ruzstd init: {e}"))?;
    let mut decoded = Vec::with_capacity(expected_size);
    decoder
        .read_to_end(&mut decoded)
        .map_err(|e| format!("ruzstd read: {e}"))?;
    Ok(decoded)
}

// ---------------------------------------------------------------------------
// HBP1 reader
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct SectionMeta {
    pub kind: u16,
    pub codec: u8,
    pub offset: usize,
    pub stored: usize,
    pub raw: usize,
}

/// A parsed (validated, still-compressed) pack. Owns the file bytes.
pub struct HbpPack {
    pub bytes: Vec<u8>,
    pub kind: u8,
    pub origin: u32,
    pub content_epoch: u64,
    pub namespaces: Vec<String>,
    pub sections: Vec<SectionMeta>,
}

impl HbpPack {
    /// Parse + validate (magic, version, trailing magic, CRC32, section
    /// bounds). The CRC is the decode-time corruption backstop (pass 3
    /// S5) — the integrity GATE is the controller's sha-on-receipt.
    pub fn parse(bytes: Vec<u8>) -> Result<Self, String> {
        if bytes.len() < HBP1_HEADER_LEN + HBP1_FOOTER_LEN {
            return Err("pack shorter than header + footer".into());
        }
        if &bytes[..4] != HBP1_MAGIC {
            return Err("bad pack magic".into());
        }
        if bytes[4] != HBP1_VERSION {
            return Err(format!("unsupported pack version {}", bytes[4]));
        }
        let tail = &bytes[bytes.len() - HBP1_FOOTER_LEN..];
        if &tail[4..] != HBP1_TRAILING_MAGIC {
            return Err("bad pack trailing magic (truncated?)".into());
        }
        let crc_stored = u32::from_le_bytes([tail[0], tail[1], tail[2], tail[3]]);
        let crc = crc32_ieee(&bytes[..bytes.len() - HBP1_FOOTER_LEN]);
        if crc != crc_stored {
            return Err(format!(
                "pack crc mismatch: stored {crc_stored:08x} computed {crc:08x}"
            ));
        }
        let u16_at = |off: usize| u16::from_le_bytes([bytes[off], bytes[off + 1]]);
        let u32_at = |off: usize| {
            u32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]])
        };
        let kind = bytes[5];
        let origin = u32_at(8);
        let section_count = u16_at(12) as usize;
        let ns_count = bytes[14] as usize;
        let content_epoch = u64::from_le_bytes(bytes[16..24].try_into().unwrap());

        let mut pos = HBP1_HEADER_LEN;
        if bytes.len() < pos + ns_count * 32 + section_count * HBP1_SECTION_ENTRY_LEN {
            return Err("pack tables overrun file".into());
        }
        let mut namespaces = Vec::with_capacity(ns_count);
        for _ in 0..ns_count {
            let raw = &bytes[pos..pos + 32];
            let end = raw.iter().position(|&b| b == 0).unwrap_or(32);
            namespaces.push(
                std::str::from_utf8(&raw[..end])
                    .map_err(|_| "non-utf8 namespace")?
                    .to_owned(),
            );
            pos += 32;
        }
        let mut sections = Vec::with_capacity(section_count);
        for _ in 0..section_count {
            let s = SectionMeta {
                kind: u16_at(pos),
                codec: bytes[pos + 2],
                offset: u32_at(pos + 4) as usize,
                stored: u32_at(pos + 8) as usize,
                raw: u32_at(pos + 12) as usize,
            };
            if s.offset + s.stored > bytes.len() - HBP1_FOOTER_LEN {
                return Err(format!("section 0x{:02X} overruns file", s.kind));
            }
            sections.push(s);
            pos += HBP1_SECTION_ENTRY_LEN;
        }
        Ok(Self { bytes, kind, origin, content_epoch, namespaces, sections })
    }

    /// Decompressed payload of section `kind`, or `None` when absent.
    pub fn section_raw(&self, kind: u16) -> Result<Option<Vec<u8>>, String> {
        let Some(s) = self.sections.iter().find(|s| s.kind == kind) else {
            return Ok(None);
        };
        let body = &self.bytes[s.offset..s.offset + s.stored];
        match s.codec {
            codec::RAW => Ok(Some(body.to_vec())),
            codec::ZSTD => {
                let out = decompress_zstd(body, s.raw)?;
                if out.len() != s.raw {
                    return Err(format!(
                        "section 0x{:02X} raw size {} != declared {}",
                        s.kind,
                        out.len(),
                        s.raw
                    ));
                }
                Ok(Some(out))
            }
            other => Err(format!("unknown codec {other}")),
        }
    }
}

/// Record-stream framing (pass 2 S3): `[count u32]` then count ×
/// `[ns_ordinal u8][file_id u32][offset u32][size u32]` (13 B), then the
/// payload bytes. Returns `(ns_ordinal, file_id, offset_in_body, size)`
/// rows plus the body start offset inside `payload`.
pub fn parse_record_stream_index(
    payload: &[u8],
) -> Result<(Vec<(u8, u32, usize, usize)>, usize), String> {
    if payload.len() < 4 {
        return Err("record stream shorter than count".into());
    }
    let count =
        u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]) as usize;
    let index_len = 4 + count * 13;
    if payload.len() < index_len {
        return Err("record stream index truncated".into());
    }
    let body_len = payload.len() - index_len;
    let mut rows = Vec::with_capacity(count);
    for i in 0..count {
        let e = 4 + i * 13;
        let ns = payload[e];
        let fid = u32::from_le_bytes(payload[e + 1..e + 5].try_into().unwrap());
        let off = u32::from_le_bytes(payload[e + 5..e + 9].try_into().unwrap()) as usize;
        let size = u32::from_le_bytes(payload[e + 9..e + 13].try_into().unwrap()) as usize;
        if off + size > body_len {
            return Err(format!("record 0x{fid:08X} overruns stream"));
        }
        rows.push((ns, fid, off, size));
    }
    Ok((rows, index_len))
}

// ---------------------------------------------------------------------------
// HBSI1 reader
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PackTableEntry {
    pub hash16: [u8; 16],
    pub size: u32,
    pub kind: u8,
    pub meta: u8,
}

#[derive(Debug, Clone, Default)]
pub struct SpatialIndex {
    pub epoch: u32,
    pub packs: Vec<PackTableEntry>,
    /// 128×128, row-major tile_x major (index = tile_x*128 + tile_y).
    pub tile_grid: Vec<u16>,
    /// `(lb, pack_ord)` sorted by lb (lb = lbx<<8 | lby).
    pub interiors: Vec<(u16, u16)>,
    /// `(kind, ord, pack_ord)` shared-directory rows.
    pub shared: Vec<(u8, u8, u16)>,
}

pub fn parse_hbsi1(bytes: &[u8]) -> Result<SpatialIndex, String> {
    if bytes.len() < HBSI_HEADER_LEN + HBSI_TILE_GRID_LEN + 8 {
        return Err("index shorter than minimum".into());
    }
    if &bytes[..4] != HBSI_MAGIC {
        return Err("bad index magic".into());
    }
    if bytes[4] != HBSI_VERSION {
        return Err(format!("unsupported index version {}", bytes[4]));
    }
    let tail = &bytes[bytes.len() - 8..];
    if &tail[4..] != HBSI_TRAILING_MAGIC {
        return Err("bad index trailing magic".into());
    }
    let crc_stored = u32::from_le_bytes(tail[..4].try_into().unwrap());
    if crc32_ieee(&bytes[..bytes.len() - 8]) != crc_stored {
        return Err("index crc mismatch".into());
    }
    let u32_at =
        |off: usize| u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap());
    let u16_at = |off: usize| u16::from_le_bytes([bytes[off], bytes[off + 1]]);
    let pack_count = u32_at(8) as usize;
    let interior_count = u32_at(12) as usize;
    let shared_count = u16_at(16) as usize;
    let epoch = u32_at(20);

    let need = HBSI_HEADER_LEN
        + pack_count * HBSI_PACK_ENTRY_LEN
        + HBSI_TILE_GRID_LEN
        + interior_count * 6
        + shared_count * 4
        + 8;
    if bytes.len() < need {
        return Err("index tables overrun file".into());
    }

    let mut pos = HBSI_HEADER_LEN;
    let mut packs = Vec::with_capacity(pack_count);
    for _ in 0..pack_count {
        let mut hash16 = [0u8; 16];
        hash16.copy_from_slice(&bytes[pos..pos + 16]);
        packs.push(PackTableEntry {
            hash16,
            size: u32_at(pos + 16),
            kind: bytes[pos + 20],
            meta: bytes[pos + 21],
        });
        pos += HBSI_PACK_ENTRY_LEN;
    }
    let mut tile_grid = Vec::with_capacity(128 * 128);
    for i in 0..128 * 128 {
        tile_grid.push(u16_at(pos + i * 2));
    }
    pos += HBSI_TILE_GRID_LEN;
    let mut interiors = Vec::with_capacity(interior_count);
    for _ in 0..interior_count {
        interiors.push((u16_at(pos), u16_at(pos + 2)));
        pos += 6;
    }
    let mut shared = Vec::with_capacity(shared_count);
    for _ in 0..shared_count {
        shared.push((bytes[pos], bytes[pos + 1], u16_at(pos + 2)));
        pos += 4;
    }
    Ok(SpatialIndex { epoch, packs, tile_grid, interiors, shared })
}

/// Hex-decode a 32-char lowercase/uppercase hash into 16 bytes.
pub fn hash16_from_hex(hex: &str) -> Result<[u8; 16], String> {
    let s = hex.as_bytes();
    if s.len() != 32 {
        return Err(format!("hash16 hex must be 32 chars, got {}", s.len()));
    }
    let nib = |c: u8| -> Result<u8, String> {
        match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'a'..=b'f' => Ok(c - b'a' + 10),
            b'A'..=b'F' => Ok(c - b'A' + 10),
            _ => Err(format!("bad hex char {}", c as char)),
        }
    };
    let mut out = [0u8; 16];
    for i in 0..16 {
        out[i] = (nib(s[2 * i])? << 4) | nib(s[2 * i + 1])?;
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// PackSource
// ---------------------------------------------------------------------------

/// Where a registered record's bytes live: a refcounted decompressed
/// section payload plus a range into it. Reads copy the range out —
/// identical cost shape to the legacy boot-pack path (`HbaReader`
/// copies out of its backing buffer), never worse than the trait
/// default.
struct RecordLoc {
    section: Arc<Vec<u8>>,
    offset: usize,
    len: usize,
}

/// Per-pack residency row. `kind`/`file_len`/`records` are stored for the
/// pass-6 eviction machinery (T20: PackStore budget + tile-vacate unpin)
/// which reads them per victim; unread at T12 (store only grows).
#[allow(dead_code)]
struct ResidentPack {
    kind: u8,
    file_len: usize,
    records: usize,
}

#[derive(Default)]
struct PackStoreInner {
    /// Resident packs by hash16.
    resident: HashMap<[u8; 16], ResidentPack>,
    /// (ns_id, file_id) → payload range. ns_id indexes `ns_names`.
    records: HashMap<(u16, u32), RecordLoc>,
    /// Interned namespace strings across packs (2 today; format allows 255/pack).
    ns_names: Vec<String>,
    /// Total resident pack FILE bytes (scale: as-fetched, compressed).
    pack_file_bytes: usize,
    /// Total decompressed section bytes held by record locs (scale: resident).
    section_bytes: usize,
    hits: u64,
    misses: u64,
}

/// Insert summary returned to the admitting caller (diag surface fodder).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InsertStats {
    pub kind: u8,
    pub records_registered: usize,
    pub duplicate: bool,
}

/// Snapshot for diag (`pack_source_stats` export → `__hbFetch.packSource`).
#[derive(Debug, Clone, Copy, Default)]
pub struct PackSourceStats {
    pub packs_resident: usize,
    pub records: usize,
    pub pack_file_bytes: usize,
    pub section_bytes: usize,
    pub hits: u64,
    pub misses: u64,
}

/// Sync `ResourceSource` over resident, controller-verified packs.
///
/// Residency budgets/eviction are pass 6 / T20 scope (PackStore 96 MiB
/// [A]); at T12 the store only grows — the ON-arm boot population is the
/// spawn ring (~10 MB class on the T10 region), well under the budget,
/// and the flag's OFF arm holds nothing.
pub struct PackSource {
    index: SpatialIndex,
    inner: Mutex<PackStoreInner>,
}

impl PackSource {
    pub fn new(index: SpatialIndex) -> Self {
        Self { index, inner: Mutex::new(PackStoreInner::default()) }
    }

    /// Parse `index_bytes` (HBSI1) and build an empty source pinned to it.
    pub fn from_index_bytes(index_bytes: &[u8]) -> Result<Self, String> {
        Ok(Self::new(parse_hbsi1(index_bytes)?))
    }

    pub fn index(&self) -> &SpatialIndex {
        &self.index
    }

    /// Admit a verified pack. `hash16` is the CAS name the CONTROLLER
    /// verified the bytes against (sha256-trunc16); this method checks
    /// (a) the hash is listed by the pinned index — an unlisted pack is
    /// deploy skew, refused loudly; (b) the container CRC + structure
    /// parse. Duplicate inserts are idempotent no-ops.
    ///
    /// Record-stream sections (LBINFO / ENVCELLS / RECORDS) and the
    /// fixed TERRAIN block are decompressed once at admission and their
    /// records registered for sync reads; PVW/REFS/TEXREF/PLACEMENTS/
    /// SPAWNS/EVENTS sections are not record-addressed and stay
    /// compressed in the pack bytes (their consumers land at later
    /// stages; GEOM stays encoding 0x0000 at T12 — no GEOM sections
    /// exist in T10 bakes).
    pub fn insert_pack(&self, hash16: [u8; 16], bytes: Vec<u8>) -> Result<InsertStats, String> {
        if !self.index.packs.iter().any(|p| p.hash16 == hash16) {
            return Err(format!(
                "pack {} is not listed by the pinned index (deploy skew?)",
                hex16(&hash16)
            ));
        }
        let pack = HbpPack::parse(bytes)?;
        let mut inner = self.inner.lock().expect("pack store mutex poisoned");
        if inner.resident.contains_key(&hash16) {
            return Ok(InsertStats {
                kind: pack.kind,
                records_registered: 0,
                duplicate: true,
            });
        }

        // Map this pack's ns ordinals into the interned table.
        let ns_map: Vec<u16> = pack
            .namespaces
            .iter()
            .map(|ns| {
                if let Some(i) = inner.ns_names.iter().position(|n| n == ns) {
                    i as u16
                } else {
                    inner.ns_names.push(ns.clone());
                    (inner.ns_names.len() - 1) as u16
                }
            })
            .collect();

        let mut registered = 0usize;

        // Record streams.
        for kind in [section_kind::LBINFO, section_kind::ENVCELLS, section_kind::RECORDS] {
            let Some(payload) = pack.section_raw(kind)? else { continue };
            let (rows, index_len) = parse_record_stream_index(&payload)?;
            let body = Arc::new(payload);
            for (ns_ord, fid, off, size) in rows {
                let Some(&ns_id) = ns_map.get(ns_ord as usize) else {
                    return Err(format!(
                        "record 0x{fid:08X} names ns ordinal {ns_ord} beyond table"
                    ));
                };
                // Inline duplication across tile packs (K ≤ 4) makes
                // re-registration legitimate; bake determinism makes the
                // bytes identical — keep the first copy.
                inner.records.entry((ns_id, fid)).or_insert_with(|| {
                    registered += 1;
                    RecordLoc { section: body.clone(), offset: index_len + off, len: size }
                });
            }
            inner.section_bytes += body.len();
        }

        // TERRAIN (tile packs): 4 × 252 B fixed, tile order
        // (0,0),(0,1),(1,0),(1,1); all-zero slice = LB absent from the
        // source DAT (zero-filled by the bake) — NOT a record. fid =
        // (lb << 16) | 0xFFFF in the eor/cell namespace, which tile
        // packs always carry at ordinal 0 (asserted via lookup).
        if pack.kind == pack_kind::TILE
            && let Some(payload) = pack.section_raw(section_kind::TERRAIN)?
        {
            if payload.len() != 4 * 252 {
                return Err(format!("TERRAIN section is {} bytes (expected 1008)", payload.len()));
            }
            let cell_ns = pack
                .namespaces
                .iter()
                .position(|n| n == "eor/cell")
                .ok_or("tile pack lacks eor/cell namespace")?;
            let ns_id = ns_map[cell_ns];
            let tx = ((pack.origin >> 8) & 0xFF) as u16;
            let ty = (pack.origin & 0xFF) as u16;
            let lbs: [u16; 4] = [
                ((tx * 2) << 8) | (ty * 2),
                ((tx * 2) << 8) | (ty * 2 + 1),
                ((tx * 2 + 1) << 8) | (ty * 2),
                ((tx * 2 + 1) << 8) | (ty * 2 + 1),
            ];
            let body = Arc::new(payload);
            for (i, &lb) in lbs.iter().enumerate() {
                let slice = &body[i * 252..(i + 1) * 252];
                if slice.iter().all(|&b| b == 0) {
                    continue; // absent terrain, zero-filled by the bake
                }
                let fid = ((lb as u32) << 16) | 0xFFFF;
                inner.records.entry((ns_id, fid)).or_insert_with(|| {
                    registered += 1;
                    RecordLoc { section: body.clone(), offset: i * 252, len: 252 }
                });
            }
            inner.section_bytes += body.len();
        }

        inner.pack_file_bytes += pack.bytes.len();
        inner.resident.insert(
            hash16,
            ResidentPack { kind: pack.kind, file_len: pack.bytes.len(), records: registered },
        );
        Ok(InsertStats { kind: pack.kind, records_registered: registered, duplicate: false })
    }

    /// True when this source can serve `key` right now (used by the
    /// composite AND by the legacy prefetch skip — a pack-served key
    /// must never be re-fetched per-record).
    pub fn serves(&self, key: ResourceKey<'_>) -> bool {
        let inner = self.inner.lock().expect("pack store mutex poisoned");
        match inner.ns_names.iter().position(|n| n == key.namespace) {
            Some(ns_id) => inner.records.contains_key(&(ns_id as u16, key.file_id)),
            None => false,
        }
    }

    pub fn is_pack_resident(&self, hash16: &[u8; 16]) -> bool {
        self.inner
            .lock()
            .expect("pack store mutex poisoned")
            .resident
            .contains_key(hash16)
    }

    /// Every registered `(namespace, file_id)` — diag + the region differ
    /// test's iteration surface. O(records); not for per-frame use.
    pub fn record_keys(&self) -> Vec<(String, u32)> {
        let inner = self.inner.lock().expect("pack store mutex poisoned");
        inner
            .records
            .keys()
            .map(|&(ns_id, fid)| (inner.ns_names[ns_id as usize].clone(), fid))
            .collect()
    }

    pub fn stats(&self) -> PackSourceStats {
        let inner = self.inner.lock().expect("pack store mutex poisoned");
        PackSourceStats {
            packs_resident: inner.resident.len(),
            records: inner.records.len(),
            pack_file_bytes: inner.pack_file_bytes,
            section_bytes: inner.section_bytes,
            hits: inner.hits,
            misses: inner.misses,
        }
    }

    fn read(&self, key: ResourceKey<'_>) -> Option<Vec<u8>> {
        let mut inner = self.inner.lock().expect("pack store mutex poisoned");
        let ns_id = inner.ns_names.iter().position(|n| n == key.namespace)? as u16;
        match inner.records.get(&(ns_id, key.file_id)) {
            Some(loc) => {
                let bytes = loc.section[loc.offset..loc.offset + loc.len].to_vec();
                inner.hits += 1;
                Some(bytes)
            }
            None => {
                inner.misses += 1;
                None
            }
        }
    }
}

impl ResourceSource for PackSource {
    fn get_file_by_key(&self, key: ResourceKey<'_>) -> DatResult<Vec<u8>> {
        self.read(key).ok_or_else(|| {
            DatError::Other(format!(
                "PackSource: record not pack-resident: {}:0x{:08X}",
                key.namespace, key.file_id
            ))
        })
    }

    fn get_metadata_by_key(&self, key: ResourceKey<'_>) -> Option<FileMetadata> {
        let inner = self.inner.lock().expect("pack store mutex poisoned");
        let ns_id = inner.ns_names.iter().position(|n| n == key.namespace)? as u16;
        inner
            .records
            .get(&(ns_id, key.file_id))
            .map(|loc| FileMetadata { id: key.file_id, size: loc.len as u32, is_pruned: false })
    }

    fn has_namespace(&self, namespace: &str) -> bool {
        self.inner
            .lock()
            .expect("pack store mutex poisoned")
            .ns_names
            .iter()
            .any(|n| n == namespace)
    }

    /// A pack source can prove PRESENCE, never absence: the owning pack
    /// for an arbitrary (ns, fid) may simply not be resident (or the
    /// record may live on the legacy lane). Composite absence proofs
    /// come from the legacy catalogs only.
    fn key_known_absent(&self, _key: ResourceKey<'_>) -> bool {
        false
    }
}

// ---------------------------------------------------------------------------
// CompositeSource
// ---------------------------------------------------------------------------

/// `CompositeSource = PackSource → legacy` (pass 3 S1.3). World content
/// serves from resident packs; anything not pack-resident (equipment,
/// textures, un-fetched regions, dynamic content) falls through to the
/// legacy source unchanged — that IS the migration seam.
pub struct CompositeSource {
    pack: Arc<PackSource>,
    legacy: Arc<dyn ResourceSource>,
}

impl CompositeSource {
    pub fn new(pack: Arc<PackSource>, legacy: Arc<dyn ResourceSource>) -> Self {
        Self { pack, legacy }
    }

    pub fn pack(&self) -> &Arc<PackSource> {
        &self.pack
    }
}

impl ResourceSource for CompositeSource {
    fn get_file_by_key(&self, key: ResourceKey<'_>) -> DatResult<Vec<u8>> {
        if let Some(bytes) = self.pack.read(key) {
            return Ok(bytes);
        }
        self.legacy.get_file_by_key(key)
    }

    /// Explicit forward (the wrapper trap documented on the trait): pack
    /// hits allocate one `Arc<Vec<u8>>` copy — the boot-pack cost shape;
    /// legacy hits share the shard cache's refcount as before.
    fn get_file_shared(&self, key: ResourceKey<'_>) -> DatResult<Arc<Vec<u8>>> {
        if let Some(bytes) = self.pack.read(key) {
            return Ok(Arc::new(bytes));
        }
        self.legacy.get_file_shared(key)
    }

    fn get_metadata_by_key(&self, key: ResourceKey<'_>) -> Option<FileMetadata> {
        self.pack
            .get_metadata_by_key(key)
            .or_else(|| self.legacy.get_metadata_by_key(key))
    }

    fn has_namespace(&self, namespace: &str) -> bool {
        self.pack.has_namespace(namespace) || self.legacy.has_namespace(namespace)
    }

    /// Absence proofs forward to the LEGACY source only (its catalogs
    /// authoritatively list namespaces; packs prove presence only).
    fn key_known_absent(&self, key: ResourceKey<'_>) -> bool {
        !self.pack.serves(key) && self.legacy.key_known_absent(key)
    }
}

fn hex16(bytes: &[u8; 16]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(32);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

// ---------------------------------------------------------------------------
// tests (pure-logic; the T10-region battery lives in
// tests/pack_source_region.rs)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal hand-built HBP1 writer for tests only — mirrors
    /// `pack_format.rs::write_hbp1` for RAW-codec sections (no zstd so
    /// the fixture stays dependency-light; zstd decode is covered by the
    /// T10-region tests against real packs).
    fn build_pack(kind: u8, origin: u32, namespaces: &[&str], sections: &[(u16, Vec<u8>)]) -> Vec<u8> {
        let ns_table_len = namespaces.len() * 32;
        let table_len = sections.len() * HBP1_SECTION_ENTRY_LEN;
        let mut out = Vec::new();
        out.extend_from_slice(HBP1_MAGIC);
        out.push(HBP1_VERSION);
        out.push(kind);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&origin.to_le_bytes());
        out.extend_from_slice(&(sections.len() as u16).to_le_bytes());
        out.push(namespaces.len() as u8);
        out.push(0);
        out.extend_from_slice(&0xABCD_u64.to_le_bytes());
        out.extend_from_slice(&0u64.to_le_bytes());
        for ns in namespaces {
            let b = ns.as_bytes();
            out.extend_from_slice(b);
            out.extend(std::iter::repeat_n(0u8, 32 - b.len()));
        }
        let mut offset = HBP1_HEADER_LEN + ns_table_len + table_len;
        for (kind, body) in sections {
            out.extend_from_slice(&kind.to_le_bytes());
            out.push(codec::RAW);
            out.push(0);
            out.extend_from_slice(&(offset as u32).to_le_bytes());
            out.extend_from_slice(&(body.len() as u32).to_le_bytes());
            out.extend_from_slice(&(body.len() as u32).to_le_bytes());
            offset += body.len();
        }
        for (_, body) in sections {
            out.extend_from_slice(body);
        }
        let crc = crc32_ieee(&out);
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(HBP1_TRAILING_MAGIC);
        out
    }

    fn build_record_stream(entries: &[(u8, u32, Vec<u8>)]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
        let mut offset = 0u32;
        for (ns, fid, bytes) in entries {
            out.push(*ns);
            out.extend_from_slice(&fid.to_le_bytes());
            out.extend_from_slice(&offset.to_le_bytes());
            out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
            offset += bytes.len() as u32;
        }
        for (_, _, bytes) in entries {
            out.extend_from_slice(bytes);
        }
        out
    }

    fn build_index(packs: &[PackTableEntry]) -> SpatialIndex {
        SpatialIndex {
            epoch: 1,
            packs: packs.to_vec(),
            tile_grid: vec![TILE_EMPTY; 128 * 128],
            interiors: vec![],
            shared: vec![],
        }
    }

    fn sha_trunc16(bytes: &[u8]) -> [u8; 16] {
        let hex = holtburger_manifest::sha256_hex(bytes);
        hash16_from_hex(&hex[..32]).unwrap()
    }

    struct StubLegacy;
    impl ResourceSource for StubLegacy {
        fn get_file_by_key(&self, key: ResourceKey<'_>) -> DatResult<Vec<u8>> {
            if key.file_id == 0x0100_9999 {
                Ok(vec![0xEE; 8])
            } else {
                Err(DatError::Other("stub: absent".into()))
            }
        }
        fn get_metadata_by_key(&self, key: ResourceKey<'_>) -> Option<FileMetadata> {
            (key.file_id == 0x0100_9999)
                .then_some(FileMetadata { id: key.file_id, size: 8, is_pruned: false })
        }
        fn has_namespace(&self, ns: &str) -> bool {
            ns == "eor/portal"
        }
        fn key_known_absent(&self, key: ResourceKey<'_>) -> bool {
            key.file_id == 0x0100_DEAD
        }
    }

    #[test]
    fn insert_serves_records_and_terrain() {
        let records = build_record_stream(&[
            (1, 0x0100_0001, vec![7u8; 40]),
            (1, 0x0800_0002, vec![9u8; 12]),
        ]);
        // TERRAIN: LB (2tx,2ty)=(6,8) present; (6,9) zero-filled absent;
        // (7,8) present; (7,9) zero-filled.
        let mut terrain = Vec::new();
        terrain.extend(std::iter::repeat_n(1u8, 252));
        terrain.extend(std::iter::repeat_n(0u8, 252));
        terrain.extend(std::iter::repeat_n(2u8, 252));
        terrain.extend(std::iter::repeat_n(0u8, 252));
        let pack = build_pack(
            pack_kind::TILE,
            (3 << 8) | 4,
            &["eor/cell", "eor/portal"],
            &[(section_kind::TERRAIN, terrain), (section_kind::RECORDS, records)],
        );
        let hash = sha_trunc16(&pack);
        let src = PackSource::new(build_index(&[PackTableEntry {
            hash16: hash,
            size: pack.len() as u32,
            kind: pack_kind::TILE,
            meta: 0,
        }]));
        let st = src.insert_pack(hash, pack.clone()).expect("insert");
        assert!(!st.duplicate);
        assert_eq!(st.records_registered, 4); // 2 records + 2 non-zero terrain

        // Records read back byte-identical.
        assert_eq!(
            src.get_file_by_key(ResourceKey::new("eor/portal", 0x0100_0001)).unwrap(),
            vec![7u8; 40]
        );
        // Terrain fids: tile (3,4) → LBs 0x0608 and 0x0708 non-zero.
        assert_eq!(
            src.get_file_by_key(ResourceKey::new("eor/cell", 0x0608_FFFF)).unwrap(),
            vec![1u8; 252]
        );
        assert_eq!(
            src.get_file_by_key(ResourceKey::new("eor/cell", 0x0708_FFFF)).unwrap(),
            vec![2u8; 252]
        );
        // Zero-filled terrain is ABSENT (the legacy 404-silent-skip parity).
        assert!(src.get_file_by_key(ResourceKey::new("eor/cell", 0x0609_FFFF)).is_err());
        // Metadata + namespace surface.
        assert_eq!(
            src.get_metadata_by_key(ResourceKey::new("eor/portal", 0x0800_0002)).unwrap().size,
            12
        );
        assert!(src.has_namespace("eor/cell"));
        assert!(!src.has_namespace("holtburger/tex-bc7"));
        // Absence is never proven by the pack source.
        assert!(!src.key_known_absent(ResourceKey::new("eor/portal", 0x0100_FFFF)));

        // Duplicate insert = idempotent no-op.
        let again = src.insert_pack(hash, pack).expect("re-insert");
        assert!(again.duplicate);
        assert_eq!(src.stats().packs_resident, 1);
    }

    #[test]
    fn unlisted_pack_is_refused_and_corrupt_pack_fails_crc() {
        let pack = build_pack(pack_kind::CORE, 0, &["eor/portal"], &[]);
        let hash = sha_trunc16(&pack);
        let src = PackSource::new(build_index(&[]));
        let err = src.insert_pack(hash, pack.clone()).unwrap_err();
        assert!(err.contains("not listed"), "unlisted → deploy-skew refusal: {err}");

        let src2 = PackSource::new(build_index(&[PackTableEntry {
            hash16: hash,
            size: pack.len() as u32,
            kind: pack_kind::CORE,
            meta: 0,
        }]));
        let mut bad = pack;
        let mid = bad.len() / 2;
        bad[mid] ^= 0xFF;
        assert!(src2.insert_pack(hash, bad).is_err(), "crc must catch a flip");
    }

    #[test]
    fn composite_pack_first_then_legacy_fallthrough() {
        let records = build_record_stream(&[(0, 0x0100_0001, vec![5u8; 16])]);
        let pack = build_pack(
            pack_kind::META_SHARED,
            0,
            &["eor/portal"],
            &[(section_kind::RECORDS, records)],
        );
        let hash = sha_trunc16(&pack);
        let ps = Arc::new(PackSource::new(build_index(&[PackTableEntry {
            hash16: hash,
            size: pack.len() as u32,
            kind: pack_kind::META_SHARED,
            meta: 0,
        }])));
        ps.insert_pack(hash, pack).unwrap();
        let composite = CompositeSource::new(ps.clone(), Arc::new(StubLegacy));

        // Pack-resident record: served from the pack.
        assert_eq!(
            composite.get_file_by_key(ResourceKey::new("eor/portal", 0x0100_0001)).unwrap(),
            vec![5u8; 16]
        );
        // Not in packs, legacy has it: falls through.
        assert_eq!(
            composite.get_file_by_key(ResourceKey::new("eor/portal", 0x0100_9999)).unwrap(),
            vec![0xEE; 8]
        );
        // get_file_shared forwards both arms.
        assert_eq!(
            *composite.get_file_shared(ResourceKey::new("eor/portal", 0x0100_0001)).unwrap(),
            vec![5u8; 16]
        );
        assert_eq!(
            *composite.get_file_shared(ResourceKey::new("eor/portal", 0x0100_9999)).unwrap(),
            vec![0xEE; 8]
        );
        // Nowhere: the legacy error surfaces.
        assert!(composite.get_file_by_key(ResourceKey::new("eor/portal", 0x0100_AAAA)).is_err());
        // Absence proofs come from legacy only, and never for pack-served keys.
        assert!(composite.key_known_absent(ResourceKey::new("eor/portal", 0x0100_DEAD)));
        assert!(!composite.key_known_absent(ResourceKey::new("eor/portal", 0x0100_0001)));
        // Namespace union.
        assert!(composite.has_namespace("eor/portal"));
        // Metadata: pack first, legacy second.
        assert_eq!(
            composite.get_metadata_by_key(ResourceKey::new("eor/portal", 0x0100_9999)).unwrap().size,
            8
        );
        // Stats counted.
        let st = ps.stats();
        assert!(st.hits >= 2 && st.misses >= 2, "hits {} misses {}", st.hits, st.misses);
    }

    #[test]
    fn hbsi1_parser_rejects_corruption_and_hash_hex_round_trips() {
        let idx = build_index(&[PackTableEntry {
            hash16: [0x5A; 16],
            size: 9,
            kind: pack_kind::TILE,
            meta: 3,
        }]);
        // Hand-serialize (mirror of pack_format.rs::write_hbsi1).
        let mut out = Vec::new();
        out.extend_from_slice(HBSI_MAGIC);
        out.push(HBSI_VERSION);
        out.push(0);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(idx.packs.len() as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&idx.epoch.to_le_bytes());
        for p in &idx.packs {
            out.extend_from_slice(&p.hash16);
            out.extend_from_slice(&p.size.to_le_bytes());
            out.push(p.kind);
            out.push(p.meta);
            out.extend_from_slice(&0u16.to_le_bytes());
        }
        for &ord in &idx.tile_grid {
            out.extend_from_slice(&ord.to_le_bytes());
        }
        let crc = crc32_ieee(&out);
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(HBSI_TRAILING_MAGIC);

        let parsed = parse_hbsi1(&out).expect("parse");
        assert_eq!(parsed.packs.len(), 1);
        assert_eq!(parsed.packs[0].hash16, [0x5A; 16]);
        assert_eq!(parsed.packs[0].meta, 3);
        let mut bad = out;
        bad[HBSI_HEADER_LEN + 2] ^= 1;
        assert!(parse_hbsi1(&bad).is_err(), "crc must catch index corruption");

        assert_eq!(
            hash16_from_hex("00ff10a5000000000000000000000000").unwrap()[..4],
            [0x00, 0xFF, 0x10, 0xA5]
        );
        assert!(hash16_from_hex("zz").is_err());
    }
}
