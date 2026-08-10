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
    /// RELIEF-IN-BAKE — relief VARIANT geometry ("GEOMR"), same row layout as
    /// `GEOM`. Absent on every pre-relief dist.
    pub const GEOM_RELIEF: u16 = 0x0C;
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

/// T15 (ST5) — PVW stream index (pass 2 S3 kind 0x0B; byte truth
/// `pack_format.rs::build_pvw_stream`): `[count u32]` × `[rs_id u32]
/// [offset u32][size u32]`, then the concatenated HBC7 payload rows.
/// Returns `(rs_id, offset_in_body, size)` rows + the body start offset.
pub fn parse_pvw_index(payload: &[u8]) -> Result<(Vec<(u32, usize, usize)>, usize), String> {
    if payload.len() < 4 {
        return Err("PVW stream shorter than count".into());
    }
    let count = u32::from_le_bytes(payload[..4].try_into().unwrap()) as usize;
    let index_len = 4 + count * 12;
    if payload.len() < index_len {
        return Err("PVW index truncated".into());
    }
    let body_len = payload.len() - index_len;
    let mut rows = Vec::with_capacity(count);
    for i in 0..count {
        let e = 4 + i * 12;
        let rs = u32::from_le_bytes(payload[e..e + 4].try_into().unwrap());
        let off = u32::from_le_bytes(payload[e + 4..e + 8].try_into().unwrap()) as usize;
        let size = u32::from_le_bytes(payload[e + 8..e + 12].try_into().unwrap()) as usize;
        if off + size > body_len {
            return Err(format!("PVW 0x{rs:08X} overruns stream"));
        }
        rows.push((rs, off, size));
    }
    Ok((rows, index_len))
}

/// T15 (ST5) — TEXREF rows (pass 5 S2; byte truth
/// `pack_format.rs::build_texref`): `[count u32]` × `[rs_id u32]
/// [tier_bits u8][pvw_pack_ord u16][dims u8]` (8 B rows). The
/// `pvw_pack_ord` is a bake-side REFS ordinal — dropped here (the PVW
/// registration above is global by rsId, so the runtime never needs it).
pub fn parse_texref_rows(payload: &[u8]) -> Result<Vec<(u32, u8, u8)>, String> {
    if payload.len() < 4 {
        return Err("TEXREF shorter than count".into());
    }
    let count = u32::from_le_bytes(payload[..4].try_into().unwrap()) as usize;
    if payload.len() != 4 + count * 8 {
        return Err("TEXREF length mismatch".into());
    }
    let mut rows = Vec::with_capacity(count);
    for i in 0..count {
        let e = 4 + i * 8;
        rows.push((
            u32::from_le_bytes(payload[e..e + 4].try_into().unwrap()),
            payload[e + 4],
            payload[e + 7],
        ));
    }
    Ok(rows)
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

/// Per-pack residency row (pass 6 D-06.5 PackStore state, landed at T20):
/// pin-counted, UseTime-floored, evictable only when unpinned + aged.
#[allow(dead_code)]
struct ResidentPack {
    kind: u8,
    file_len: usize,
    records: usize,
    /// Grid-slot pin count (D-06.5.1): each LIVE/PARKED/STAGED slot pins its
    /// tile pack + interiors + REFS-listed shared packs; commons/index carry
    /// a session pin. Pinned packs are NEVER eviction victims.
    pin_count: u32,
    /// Clock of the last transition to pin_count == 0 (caller-supplied ms —
    /// JS holds the clock, pass 6 "Rust holds bytes, JS holds policy").
    /// `NaN` = not yet stamped; `enforce_budget` stamps it on first sight so
    /// a never-pinned pack still gets a full floor window.
    last_unpin_ms: f64,
    /// Decompressed section payloads owned by this pack — the identity
    /// anchor for record removal at eviction (RecordLoc.section ptr-eq).
    sections: Vec<Arc<Vec<u8>>>,
    /// Record keys this pack registered (first-copy winners only).
    record_keys: Vec<(u16, u32)>,
    /// T15 (ST5): PVW rsIds this pack registered (first-copy winners).
    pvw_keys: Vec<u32>,
    /// T15 (ST5): TEXREF rsIds this pack registered (first-copy winners).
    texref_keys: Vec<u32>,
    /// T13 (ST3): GEOM model ids this pack registered (first-copy winners).
    geom_keys: Vec<u32>,
    /// RELIEF-IN-BAKE: GEOMR (relief variant) model ids this pack registered.
    geom_relief_keys: Vec<u32>,
}

/// PackStore budgets + floor (pass 6 S3, all [A] — re-classed by the first
/// soak): packBytes 96 MiB, packSections 32 MiB, UseTime floor 30 s from
/// unpin, emergency minimum 5 s — NEVER 0 (D-06.5 "floors never zeroed").
pub const PACK_BUDGET_BYTES_DEFAULT: usize = 96 * 1024 * 1024;
pub const PACK_SECTION_BUDGET_BYTES_DEFAULT: usize = 32 * 1024 * 1024;
pub const PACK_FLOOR_MS_DEFAULT: f64 = 30_000.0;
pub const PACK_FLOOR_MS_MIN: f64 = 5_000.0;

struct PackStoreInner {
    /// Resident packs by hash16.
    resident: HashMap<[u8; 16], ResidentPack>,
    /// (ns_id, file_id) → payload range. ns_id indexes `ns_names`.
    records: HashMap<(u16, u32), RecordLoc>,
    /// T15 (ST5, pass 5 D-05.5): rsId → PVW payload range (HBC7 container
    /// bytes inside a PVW section). Registered at admission for SYNC
    /// frame-1 preview reads — the compressed-only material build path.
    pvw: HashMap<u32, RecordLoc>,
    /// T15 (ST5, pass 5 S2): rsId → (tier_bits, dims) from TEXREF rows.
    /// Bucket identity (dims) + tier routing (FULL present / legacy-only).
    texref: HashMap<u32, (u8, u8)>,
    /// T13 (ST3, pass 4 S1): model id → HBG1 GEOM payload range (kind 0x09
    /// sections, decompressed at admission). Registered for the SYNC
    /// `assemble_model_geometry` / `assemble_envcell_geometry` reads.
    geom: HashMap<u32, RecordLoc>,
    /// RELIEF-IN-BAKE: model id → HBG1 relief-VARIANT payload range (kind
    /// 0x0C `GEOMR` sections). Sparse by design — a variant row exists only
    /// for the models the bake's relief profile actually changes, so a miss
    /// here means "relief is a no-op for this model, read the default row",
    /// NOT "content missing". Never consulted unless the consumer's
    /// DEFAULT-OFF relief arm is live.
    geom_relief: HashMap<u32, RecordLoc>,
    /// Interned namespace strings across packs (2 today; format allows 255/pack).
    ns_names: Vec<String>,
    /// Total resident pack FILE bytes (scale: as-fetched, compressed).
    pack_file_bytes: usize,
    /// Total decompressed section bytes held by record locs (scale: resident).
    section_bytes: usize,
    hits: u64,
    misses: u64,
    /// T20 residency policy state (see the constants above).
    budget_bytes: usize,
    section_budget_bytes: usize,
    floor_ms: f64,
    evictions: u64,
    /// Enforcement passes that stayed over budget because every candidate
    /// was pinned or floored — "no evictable victim ⇒ run over and record"
    /// (the ByteBudgetLru stance, lib.rs:10385-10402, applied here).
    evict_deferrals: u64,
}

impl Default for PackStoreInner {
    fn default() -> Self {
        Self {
            resident: HashMap::new(),
            records: HashMap::new(),
            pvw: HashMap::new(),
            texref: HashMap::new(),
            geom: HashMap::new(),
            geom_relief: HashMap::new(),
            ns_names: Vec::new(),
            pack_file_bytes: 0,
            section_bytes: 0,
            hits: 0,
            misses: 0,
            budget_bytes: PACK_BUDGET_BYTES_DEFAULT,
            section_budget_bytes: PACK_SECTION_BUDGET_BYTES_DEFAULT,
            floor_ms: PACK_FLOOR_MS_DEFAULT,
            evictions: 0,
            evict_deferrals: 0,
        }
    }
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
    /// T20 residency policy readout (pass 6 S3/S5).
    pub pinned_packs: usize,
    pub pinned_bytes: usize,
    pub budget_bytes: usize,
    pub section_budget_bytes: usize,
    pub floor_ms: f64,
    pub evictions: u64,
    pub evict_deferrals: u64,
    pub over_budget: bool,
    /// T15 (ST5): registered PVW payloads / TEXREF rows (additive fields —
    /// the glue JSON gains two keys; no existing consumer reads them).
    pub pvw_rows: usize,
    pub texref_rows: usize,
    /// T13 (ST3): registered HBG1 GEOM payloads (additive field).
    pub geom_rows: usize,
    /// RELIEF-IN-BAKE: registered relief-VARIANT payloads (additive field).
    /// Always ≤ `geom_rows`; 0 on a dist baked without `--geom-relief`.
    pub geom_relief_rows: usize,
}

/// One `enforce_budget` pass's outcome.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EvictReport {
    pub evicted: usize,
    /// Candidates skipped by pin or floor while still over budget.
    pub deferred: usize,
    pub still_over: bool,
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
    /// records registered for sync reads. T15 (ST5) additionally
    /// registers PVW payloads (rsId → HBC7 bytes — the sync frame-1
    /// preview source, pass 5 D-05.5) and TEXREF rows (rsId →
    /// tier_bits/dims, pass 5 S2). REFS/PLACEMENTS/SPAWNS/EVENTS
    /// sections are not record-addressed and stay compressed in the
    /// pack bytes (their consumers land at later stages; GEOM stays
    /// encoding 0x0000 at T12 — no GEOM sections exist in T10 bakes).
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
        let mut own_sections: Vec<Arc<Vec<u8>>> = Vec::new();
        let mut own_keys: Vec<(u16, u32)> = Vec::new();

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
                // bytes identical — keep the first copy. First-copy keys are
                // remembered so eviction (T20) can unregister exactly them.
                if !inner.records.contains_key(&(ns_id, fid)) {
                    registered += 1;
                    own_keys.push((ns_id, fid));
                    inner.records.insert(
                        (ns_id, fid),
                        RecordLoc { section: body.clone(), offset: index_len + off, len: size },
                    );
                }
            }
            inner.section_bytes += body.len();
            own_sections.push(body);
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
                if !inner.records.contains_key(&(ns_id, fid)) {
                    registered += 1;
                    own_keys.push((ns_id, fid));
                    inner.records.insert(
                        (ns_id, fid),
                        RecordLoc { section: body.clone(), offset: i * 252, len: 252 },
                    );
                }
            }
            inner.section_bytes += body.len();
            own_sections.push(body);
        }

        // T15 (ST5) — PVW payloads (kind 0x0B): rsId-keyed HBC7 containers,
        // registered for SYNC reads (the frame-1 preview source). Stream
        // framing per pack_format.rs `build_pvw_stream`: [count u32] ×
        // [rs_id u32][offset u32][size u32] + payload rows. Inline
        // duplication across carriers (tile self-PVW vs PVW packs) keeps
        // the first copy, exactly like the record streams above.
        let mut own_pvw_keys: Vec<u32> = Vec::new();
        if let Some(payload) = pack.section_raw(section_kind::PVW)? {
            let (rows, index_len) = parse_pvw_index(&payload)?;
            let body = Arc::new(payload);
            for (rs, off, size) in rows {
                if !inner.pvw.contains_key(&rs) {
                    own_pvw_keys.push(rs);
                    inner.pvw.insert(
                        rs,
                        RecordLoc { section: body.clone(), offset: index_len + off, len: size },
                    );
                }
            }
            inner.section_bytes += body.len();
            own_sections.push(body);
        }

        // T15 (ST5) — TEXREF rows (kind 0x0A): rsId → (tier_bits, dims).
        // 8 B/row facts, first-copy wins (bake determinism makes dupes
        // identical across tile packs).
        let mut own_texref_keys: Vec<u32> = Vec::new();
        if let Some(payload) = pack.section_raw(section_kind::TEXREF)? {
            for (rs, tier, dims) in parse_texref_rows(&payload)? {
                if let std::collections::hash_map::Entry::Vacant(e) = inner.texref.entry(rs) {
                    e.insert((tier, dims));
                    own_texref_keys.push(rs);
                }
            }
        }

        // T13 (ST3) — HBG1 GEOM payloads (kind 0x09): model id → payload
        // range, registered for the SYNC bundle-assembly reads
        // (`assemble_model_geometry` / `assemble_envcell_geometry`). Row
        // shape per holtburger_dat::hbg1::parse_geom_section; inline
        // duplication across tile packs keeps the first copy exactly like
        // the record streams (bake determinism makes the bytes identical).
        let mut own_geom_keys: Vec<u32> = Vec::new();
        if let Some(payload) = pack.section_raw(section_kind::GEOM)? {
            let rows = holtburger_dat::hbg1::parse_geom_section(&payload)?;
            let body = Arc::new(payload);
            for (id, enc, off, size) in rows {
                if enc != holtburger_dat::hbg1::ENCODING_HBG1 {
                    // Unknown encodings are skipped (forward-compat), never
                    // an admission failure.
                    continue;
                }
                if !inner.geom.contains_key(&id) {
                    own_geom_keys.push(id);
                    inner.geom.insert(
                        id,
                        RecordLoc { section: body.clone(), offset: off, len: size },
                    );
                }
            }
            inner.section_bytes += body.len();
            own_sections.push(body);
        }

        // RELIEF-IN-BAKE — GEOMR variant payloads (kind 0x0C), same row shape
        // and same first-copy-wins rule. Absent on every pre-relief dist, so
        // this loop is a no-op there (forward/backward compatible).
        let mut own_geom_relief_keys: Vec<u32> = Vec::new();
        if let Some(payload) = pack.section_raw(section_kind::GEOM_RELIEF)? {
            let rows = holtburger_dat::hbg1::parse_geom_section(&payload)?;
            let body = Arc::new(payload);
            for (id, enc, off, size) in rows {
                if enc != holtburger_dat::hbg1::ENCODING_HBG1 {
                    continue;
                }
                if !inner.geom_relief.contains_key(&id) {
                    own_geom_relief_keys.push(id);
                    inner.geom_relief.insert(
                        id,
                        RecordLoc { section: body.clone(), offset: off, len: size },
                    );
                }
            }
            inner.section_bytes += body.len();
            own_sections.push(body);
        }

        inner.pack_file_bytes += pack.bytes.len();
        inner.resident.insert(
            hash16,
            ResidentPack {
                kind: pack.kind,
                file_len: pack.bytes.len(),
                records: registered,
                pin_count: 0,
                last_unpin_ms: f64::NAN,
                sections: own_sections,
                record_keys: own_keys,
                pvw_keys: own_pvw_keys,
                texref_keys: own_texref_keys,
                geom_keys: own_geom_keys,
                geom_relief_keys: own_geom_relief_keys,
            },
        );
        Ok(InsertStats { kind: pack.kind, records_registered: registered, duplicate: false })
    }

    // ── T20 residency policy (pass 6 D-06.5: pins, floor, budget) ─────────

    /// Pin a resident pack (grid slot / session pin). Idempotent-additive:
    /// refcounted, so each slot pins once and unpins once. Returns false
    /// for a non-resident hash (a pin BEFORE admission is a caller bug —
    /// the glue pins on STAGED, after `insert_pack`).
    pub fn pin_pack(&self, hash16: &[u8; 16]) -> bool {
        let mut inner = self.inner.lock().expect("pack store mutex poisoned");
        match inner.resident.get_mut(hash16) {
            Some(p) => {
                p.pin_count = p.pin_count.saturating_add(1);
                true
            }
            None => false,
        }
    }

    /// Drop one pin. `now_ms` (caller clock — JS holds policy time) stamps
    /// the UseTime floor when the count reaches 0. Returns false when the
    /// pack is not resident or was not pinned (audited as a pin leak by
    /// the JS ledger).
    pub fn unpin_pack(&self, hash16: &[u8; 16], now_ms: f64) -> bool {
        let mut inner = self.inner.lock().expect("pack store mutex poisoned");
        match inner.resident.get_mut(hash16) {
            Some(p) if p.pin_count > 0 => {
                p.pin_count -= 1;
                if p.pin_count == 0 {
                    p.last_unpin_ms = now_ms;
                }
                true
            }
            _ => false,
        }
    }

    /// Set budgets (ladder R3 halves them for the emergency's duration;
    /// release restores). Enforcement happens on the next `enforce_budget`.
    pub fn set_budgets(&self, budget_bytes: usize, section_budget_bytes: usize) {
        let mut inner = self.inner.lock().expect("pack store mutex poisoned");
        inner.budget_bytes = budget_bytes.max(1);
        inner.section_budget_bytes = section_budget_bytes.max(1);
    }

    /// Set the UseTime floor. CLAMPED to ≥ 5 s (`PACK_FLOOR_MS_MIN`) — the
    /// R4 emergency minimum; a floor can be LOWERED, never zeroed
    /// (D-06.5 "floors never zeroed", the deleted landblock_lru pathology).
    pub fn set_floor_ms(&self, ms: f64) {
        let mut inner = self.inner.lock().expect("pack store mutex poisoned");
        inner.floor_ms = if ms.is_finite() { ms.max(PACK_FLOOR_MS_MIN) } else { PACK_FLOOR_MS_DEFAULT };
    }

    fn over_budget(inner: &PackStoreInner) -> bool {
        inner.pack_file_bytes > inner.budget_bytes
            || inner.section_bytes > inner.section_budget_bytes
    }

    /// One eviction pass (called by the glue after inserts/unpins, and by
    /// the ladder): while over budget, evict UNPINNED packs whose floor has
    /// aged out, LRU by `last_unpin_ms`. No evictable victim ⇒ run over and
    /// record (`evict_deferrals`) — never break a pin, never violate the
    /// floor (the ByteBudgetLru stance generalized, D-06.5).
    pub fn enforce_budget(&self, now_ms: f64) -> EvictReport {
        let mut inner = self.inner.lock().expect("pack store mutex poisoned");
        let mut report = EvictReport::default();
        if !Self::over_budget(&inner) {
            return report;
        }
        // Stamp unstamped unpinned rows (insert-time packs get a full floor
        // window starting at first enforcement sight).
        for p in inner.resident.values_mut() {
            if p.pin_count == 0 && p.last_unpin_ms.is_nan() {
                p.last_unpin_ms = now_ms;
            }
        }
        loop {
            if !Self::over_budget(&inner) {
                break;
            }
            let floor = inner.floor_ms;
            let mut victim: Option<([u8; 16], f64)> = None;
            let mut deferred = 0usize;
            for (h, p) in inner.resident.iter() {
                if p.pin_count > 0 {
                    deferred += 1;
                    continue;
                }
                if now_ms - p.last_unpin_ms < floor {
                    deferred += 1;
                    continue;
                }
                match victim {
                    Some((_, best)) if p.last_unpin_ms >= best => {}
                    _ => victim = Some((*h, p.last_unpin_ms)),
                }
            }
            let Some((h, _)) = victim else {
                report.deferred = deferred;
                report.still_over = true;
                inner.evict_deferrals += 1;
                break;
            };
            let p = inner.resident.remove(&h).expect("victim vanished");
            inner.pack_file_bytes = inner.pack_file_bytes.saturating_sub(p.file_len);
            for s in &p.sections {
                inner.section_bytes = inner.section_bytes.saturating_sub(s.len());
            }
            for key in &p.record_keys {
                // Only unregister records still backed by THIS pack's
                // sections (identity check — a defensive guard; first-copy
                // bookkeeping should make it always true).
                let owned = match inner.records.get(key) {
                    Some(loc) => p.sections.iter().any(|s| Arc::ptr_eq(s, &loc.section)),
                    None => false,
                };
                if owned {
                    inner.records.remove(key);
                }
            }
            // T15 (ST5): same first-copy unregistration for PVW payloads +
            // TEXREF rows (same identity guard for the section-backed PVW).
            for rs in &p.pvw_keys {
                let owned = match inner.pvw.get(rs) {
                    Some(loc) => p.sections.iter().any(|s| Arc::ptr_eq(s, &loc.section)),
                    None => false,
                };
                if owned {
                    inner.pvw.remove(rs);
                }
            }
            for rs in &p.texref_keys {
                inner.texref.remove(rs);
            }
            // T13 (ST3): same first-copy unregistration for GEOM payloads.
            for id in &p.geom_keys {
                let owned = match inner.geom.get(id) {
                    Some(loc) => p.sections.iter().any(|s| Arc::ptr_eq(s, &loc.section)),
                    None => false,
                };
                if owned {
                    inner.geom.remove(id);
                }
            }
            // RELIEF-IN-BAKE: same first-copy unregistration for variants.
            for id in &p.geom_relief_keys {
                let owned = match inner.geom_relief.get(id) {
                    Some(loc) => p.sections.iter().any(|s| Arc::ptr_eq(s, &loc.section)),
                    None => false,
                };
                if owned {
                    inner.geom_relief.remove(id);
                }
            }
            inner.evictions += 1;
            report.evicted += 1;
        }
        report
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

    /// T15 (ST5) — the PVW preview payload (raw HBC7 container bytes) for
    /// one RenderSurface id, or `None` when no resident pack carries it.
    /// SYNC by design: PVW packs for the ring are resident before
    /// materials build (pass 3 S1.4's guarantee) — this is the frame-1
    /// preview source (pass 5 D-05.5 step 2).
    pub fn pvw_payload(&self, rs_id: u32) -> Option<Vec<u8>> {
        let inner = self.inner.lock().expect("pack store mutex poisoned");
        inner
            .pvw
            .get(&rs_id)
            .map(|loc| loc.section[loc.offset..loc.offset + loc.len].to_vec())
    }

    /// T15 (ST5) — the TEXREF row for one RenderSurface id:
    /// `(tier_bits, dims)` per pass 5 S2 (dims = `(log2 w << 4) | log2 h`
    /// of the FULL tier — bucket identity stable across preview→full).
    pub fn texref(&self, rs_id: u32) -> Option<(u8, u8)> {
        let inner = self.inner.lock().expect("pack store mutex poisoned");
        inner.texref.get(&rs_id).copied()
    }

    /// T13 (ST3) — the HBG1 GEOM payload for one model id (0x01 GfxObj,
    /// 0x02 Setup, 0x0D Environment), or `None` when no resident pack
    /// carries it (encoding-0x0000 world / non-pack content — the caller
    /// falls back to the runtime decode, counted). SYNC by design: GEOM
    /// rides the same packs as its records, resident before decode
    /// (pass 3 S1.4).
    pub fn geom_payload(&self, model_id: u32) -> Option<Vec<u8>> {
        let inner = self.inner.lock().expect("pack store mutex poisoned");
        inner
            .geom
            .get(&model_id)
            .map(|loc| loc.section[loc.offset..loc.offset + loc.len].to_vec())
    }

    /// RELIEF-IN-BAKE — the relief-VARIANT payload for one 0x01 model id, or
    /// `None` when this dist carries no variant for it. `None` is the NORMAL
    /// answer for a model relief leaves alone (and for every pre-relief
    /// dist): the caller reads the default row instead. Same sync contract as
    /// [`Self::geom_payload`].
    pub fn geom_relief_payload(&self, model_id: u32) -> Option<Vec<u8>> {
        let inner = self.inner.lock().expect("pack store mutex poisoned");
        inner
            .geom_relief
            .get(&model_id)
            .map(|loc| loc.section[loc.offset..loc.offset + loc.len].to_vec())
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
        let mut pinned_packs = 0usize;
        let mut pinned_bytes = 0usize;
        for p in inner.resident.values() {
            if p.pin_count > 0 {
                pinned_packs += 1;
                pinned_bytes += p.file_len;
                for s in &p.sections {
                    pinned_bytes += s.len();
                }
            }
        }
        PackSourceStats {
            packs_resident: inner.resident.len(),
            records: inner.records.len(),
            pack_file_bytes: inner.pack_file_bytes,
            section_bytes: inner.section_bytes,
            hits: inner.hits,
            misses: inner.misses,
            pinned_packs,
            pinned_bytes,
            budget_bytes: inner.budget_bytes,
            section_budget_bytes: inner.section_budget_bytes,
            floor_ms: inner.floor_ms,
            evictions: inner.evictions,
            evict_deferrals: inner.evict_deferrals,
            over_budget: Self::over_budget(&inner),
            pvw_rows: inner.pvw.len(),
            texref_rows: inner.texref.len(),
            geom_rows: inner.geom.len(),
            geom_relief_rows: inner.geom_relief.len(),
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

    /// T15 (ST5): PVW payload + TEXREF row registration at admission,
    /// first-copy dedup across packs, and clean unregistration when the
    /// owning pack is evicted.
    #[test]
    fn pvw_and_texref_register_and_evict() {
        // PVW stream: two rsIds with distinct payloads.
        let mut pvw = Vec::new();
        pvw.extend_from_slice(&2u32.to_le_bytes());
        for (rs, off, size) in [(0x0600_0001u32, 0u32, 10u32), (0x0600_0002, 10, 6)] {
            pvw.extend_from_slice(&rs.to_le_bytes());
            pvw.extend_from_slice(&off.to_le_bytes());
            pvw.extend_from_slice(&size.to_le_bytes());
        }
        pvw.extend(std::iter::repeat_n(0xAAu8, 10));
        pvw.extend(std::iter::repeat_n(0xBBu8, 6));
        // TEXREF: same two rsIds; 0x...01 has PVW+FULL, 0x...02 PVW only.
        let mut texref = Vec::new();
        texref.extend_from_slice(&2u32.to_le_bytes());
        for (rs, tier, dims) in [(0x0600_0001u32, 0b11u8, 0x99u8), (0x0600_0002, 0b01, 0x77)] {
            texref.extend_from_slice(&rs.to_le_bytes());
            texref.push(tier);
            texref.extend_from_slice(&0xFFFEu16.to_le_bytes()); // pvw_pack_ord (dropped)
            texref.push(dims);
        }
        let pack_a = build_pack(
            pack_kind::PREVIEW,
            0,
            &["eor/portal"],
            &[(section_kind::TEXREF, texref.clone()), (section_kind::PVW, pvw.clone())],
        );
        // A second carrier duplicating rsId 0x...01 with DIFFERENT bytes —
        // first-copy must win (bake determinism makes real dupes identical;
        // the divergence here proves which copy serves).
        let mut pvw_b = Vec::new();
        pvw_b.extend_from_slice(&1u32.to_le_bytes());
        pvw_b.extend_from_slice(&0x0600_0001u32.to_le_bytes());
        pvw_b.extend_from_slice(&0u32.to_le_bytes());
        pvw_b.extend_from_slice(&4u32.to_le_bytes());
        pvw_b.extend(std::iter::repeat_n(0xCCu8, 4));
        let pack_b = build_pack(pack_kind::TILE, (1 << 8) | 1, &["eor/cell"], &[(section_kind::PVW, pvw_b)]);
        let (ha, hb) = (sha_trunc16(&pack_a), sha_trunc16(&pack_b));
        let src = PackSource::new(build_index(&[
            PackTableEntry { hash16: ha, size: pack_a.len() as u32, kind: pack_kind::PREVIEW, meta: 0 },
            PackTableEntry { hash16: hb, size: pack_b.len() as u32, kind: pack_kind::TILE, meta: 0 },
        ]));
        src.insert_pack(ha, pack_a).expect("insert A");
        src.insert_pack(hb, pack_b).expect("insert B");

        assert_eq!(src.pvw_payload(0x0600_0001).unwrap(), vec![0xAA; 10], "first copy wins");
        assert_eq!(src.pvw_payload(0x0600_0002).unwrap(), vec![0xBB; 6]);
        assert_eq!(src.pvw_payload(0x0600_0003), None);
        assert_eq!(src.texref(0x0600_0001), Some((0b11, 0x99)));
        assert_eq!(src.texref(0x0600_0002), Some((0b01, 0x77)));
        assert_eq!(src.texref(0x0600_0003), None);
        let st = src.stats();
        assert_eq!((st.pvw_rows, st.texref_rows), (2, 2));

        // Evict pack A (the first-copy owner): its PVW/TEXREF rows go; the
        // duplicate rsId does NOT resurrect from pack B (first-copy keys are
        // per-pack — B never owned 0x...01).
        src.set_budgets(1, 1);
        src.set_floor_ms(5_000.0);
        // Pin B so A is the only victim; age A past the floor.
        src.pin_pack(&hb);
        let rep = src.enforce_budget(100_000.0);
        assert_eq!(rep.evicted, 0, "floor holds on first sight (stamps clocks)");
        let rep = src.enforce_budget(200_000.0);
        assert!(rep.evicted >= 1, "A evicts once aged: {rep:?}");
        assert_eq!(src.pvw_payload(0x0600_0001), None, "A's PVW rows unregistered");
        assert_eq!(src.pvw_payload(0x0600_0002), None);
        assert_eq!(src.texref(0x0600_0001), None);
    }

    /// T13 (ST3): GEOM payloads register at admission, serve sync, and
    /// unregister with their first-copy owner at eviction.
    #[test]
    fn geom_register_serve_and_evict() {
        let mut entries = std::collections::BTreeMap::new();
        entries.insert(0x0100_0001u32, vec![0xABu8; 10]);
        entries.insert(0x0D00_0002u32, vec![0xCDu8; 6]);
        let sec = holtburger_dat::hbg1::build_geom_section(&entries);
        let pack = build_pack(
            pack_kind::META_SHARED,
            0,
            &["eor/portal"],
            &[(section_kind::GEOM, sec)],
        );
        let keeper = build_pack(pack_kind::CORE, 0, &["eor/portal"], &[]);
        let (ha, hk) = (sha_trunc16(&pack), sha_trunc16(&keeper));
        let src = PackSource::new(build_index(&[
            PackTableEntry { hash16: ha, size: pack.len() as u32, kind: pack_kind::META_SHARED, meta: 0 },
            PackTableEntry { hash16: hk, size: keeper.len() as u32, kind: pack_kind::CORE, meta: 0 },
        ]));
        src.insert_pack(ha, pack).expect("insert");
        src.insert_pack(hk, keeper).expect("insert keeper");
        assert_eq!(src.geom_payload(0x0100_0001).unwrap(), vec![0xAB; 10]);
        assert_eq!(src.geom_payload(0x0D00_0002).unwrap(), vec![0xCD; 6]);
        assert_eq!(src.geom_payload(0x0100_0003), None);
        assert_eq!(src.stats().geom_rows, 2);

        // Evict the owner: rows unregister (same first-copy discipline as PVW).
        src.set_budgets(1, 1);
        src.set_floor_ms(5_000.0);
        src.pin_pack(&hk);
        let rep = src.enforce_budget(100_000.0);
        assert_eq!(rep.evicted, 0, "floor holds on first sight");
        let rep = src.enforce_budget(200_000.0);
        assert!(rep.evicted >= 1, "geom carrier evicts once aged: {rep:?}");
        assert_eq!(src.geom_payload(0x0100_0001), None);
        assert_eq!(src.stats().geom_rows, 0);
    }

    /// RELIEF-IN-BAKE: GEOMR rows register beside their defaults, serve sync
    /// and independently, are SPARSE (a miss means "relief is a no-op here",
    /// not "content missing"), and unregister with their owner.
    #[test]
    fn geom_relief_variants_register_sparsely_and_evict() {
        let mut default_entries = std::collections::BTreeMap::new();
        default_entries.insert(0x0100_0001u32, vec![0xABu8; 10]);
        default_entries.insert(0x0100_0002u32, vec![0xCDu8; 6]);
        // Only model ...0001 gains relief — ...0002 has no variant row.
        let mut variant_entries = std::collections::BTreeMap::new();
        variant_entries.insert(0x0100_0001u32, vec![0xEEu8; 14]);
        let pack = build_pack(
            pack_kind::META_SHARED,
            0,
            &["eor/portal"],
            &[
                (
                    section_kind::GEOM,
                    holtburger_dat::hbg1::build_geom_section(&default_entries),
                ),
                (
                    section_kind::GEOM_RELIEF,
                    holtburger_dat::hbg1::build_geom_section(&variant_entries),
                ),
            ],
        );
        let keeper = build_pack(pack_kind::CORE, 0, &["eor/portal"], &[]);
        let (ha, hk) = (sha_trunc16(&pack), sha_trunc16(&keeper));
        let src = PackSource::new(build_index(&[
            PackTableEntry { hash16: ha, size: pack.len() as u32, kind: pack_kind::META_SHARED, meta: 0 },
            PackTableEntry { hash16: hk, size: keeper.len() as u32, kind: pack_kind::CORE, meta: 0 },
        ]));
        src.insert_pack(ha, pack).expect("insert");
        src.insert_pack(hk, keeper).expect("insert keeper");
        // Defaults unaffected by the variant section's presence.
        assert_eq!(src.geom_payload(0x0100_0001).unwrap(), vec![0xAB; 10]);
        assert_eq!(src.geom_payload(0x0100_0002).unwrap(), vec![0xCD; 6]);
        assert_eq!(src.geom_relief_payload(0x0100_0001).unwrap(), vec![0xEE; 14]);
        assert_eq!(
            src.geom_relief_payload(0x0100_0002),
            None,
            "sparse by design: no variant row = relief is a no-op for this model"
        );
        let st = src.stats();
        assert_eq!((st.geom_rows, st.geom_relief_rows), (2, 1));

        src.set_budgets(1, 1);
        src.set_floor_ms(5_000.0);
        src.pin_pack(&hk);
        let _ = src.enforce_budget(100_000.0);
        assert!(src.enforce_budget(200_000.0).evicted >= 1);
        assert_eq!(src.geom_relief_payload(0x0100_0001), None);
        assert_eq!(src.stats().geom_relief_rows, 0);
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

    // ── T20 (ST7): PackStore pins / floor / budget eviction ────────────────

    /// Three distinct listable packs + their source, budget-tunable.
    fn residency_fixture() -> (PackSource, Vec<[u8; 16]>, Vec<usize>) {
        let mut packs = Vec::new();
        for i in 0..3u8 {
            let records = build_record_stream(&[(0, 0x0100_0000 + i as u32, vec![i + 1; 64])]);
            packs.push(build_pack(
                pack_kind::META_SHARED,
                i as u32,
                &["eor/portal"],
                &[(section_kind::RECORDS, records)],
            ));
        }
        let hashes: Vec<[u8; 16]> = packs.iter().map(|p| sha_trunc16(p)).collect();
        let table: Vec<PackTableEntry> = hashes
            .iter()
            .zip(&packs)
            .map(|(h, p)| PackTableEntry {
                hash16: *h,
                size: p.len() as u32,
                kind: pack_kind::META_SHARED,
                meta: 0,
            })
            .collect();
        let src = PackSource::new(build_index(&table));
        let sizes: Vec<usize> = packs.iter().map(|p| p.len()).collect();
        for (h, p) in hashes.iter().zip(packs) {
            src.insert_pack(*h, p).unwrap();
        }
        (src, hashes, sizes)
    }

    #[test]
    fn pins_and_floor_gate_eviction_and_deferrals_are_recorded() {
        let (src, hashes, _) = residency_fixture();
        // Tight budget: anything over 1 byte is over-budget → pure policy test.
        src.set_budgets(1, 1);
        // Pin all three (refcounted: pack 0 twice).
        assert!(src.pin_pack(&hashes[0]));
        assert!(src.pin_pack(&hashes[0]));
        assert!(src.pin_pack(&hashes[1]));
        assert!(src.pin_pack(&hashes[2]));
        // All pinned ⇒ no victim ⇒ run over and record.
        let r = src.enforce_budget(10_000.0);
        assert_eq!(r.evicted, 0);
        assert!(r.still_over);
        assert_eq!(src.stats().evict_deferrals, 1);
        assert_eq!(src.stats().pinned_packs, 3);
        assert!(src.stats().over_budget);
        // Unpin 1 and 2 at t=10s; floor 30 s ⇒ still deferred at t=20s.
        assert!(src.unpin_pack(&hashes[1], 10_000.0));
        assert!(src.unpin_pack(&hashes[2], 12_000.0));
        let r2 = src.enforce_budget(20_000.0);
        assert_eq!(r2.evicted, 0, "floor honored — nothing young evicts");
        // Past the floor: LRU by last_unpin — pack 1 (older unpin) goes first.
        let r3 = src.enforce_budget(41_000.0);
        assert_eq!(r3.evicted, 1);
        assert!(!src.is_pack_resident(&hashes[1]));
        assert!(src.is_pack_resident(&hashes[2]), "younger unpin survives the pass");
        // Its records unregistered with it.
        assert!(!src.serves(ResourceKey::new("eor/portal", 0x0100_0001)));
        assert!(src.serves(ResourceKey::new("eor/portal", 0x0100_0002)));
        // Pack 2 ages out on the next pass; pack 0 (pinned twice) NEVER goes.
        let r4 = src.enforce_budget(43_000.0);
        assert_eq!(r4.evicted, 1);
        assert!(src.is_pack_resident(&hashes[0]));
        assert!(r4.still_over, "pinned remainder keeps the store over budget — recorded, not broken");
        // Refcount: one unpin leaves it pinned; the second frees it.
        assert!(src.unpin_pack(&hashes[0], 50_000.0));
        let r5 = src.enforce_budget(90_000.0);
        assert_eq!(r5.evicted, 0, "still one pin held");
        assert!(src.unpin_pack(&hashes[0], 90_000.0));
        let r6 = src.enforce_budget(121_000.0);
        assert_eq!(r6.evicted, 1);
        assert_eq!(src.stats().packs_resident, 0);
        // Unpin of a non-pinned / non-resident hash reports false (JS audits).
        assert!(!src.unpin_pack(&hashes[0], 0.0));
    }

    #[test]
    fn floor_is_clamped_never_zero_and_budgets_restore() {
        let (src, hashes, sizes) = residency_fixture();
        src.set_budgets(1, 1);
        // R4 may LOWER the floor to 5 s; 0 / negative / NaN clamp, never 0.
        src.set_floor_ms(0.0);
        assert_eq!(src.stats().floor_ms, PACK_FLOOR_MS_MIN);
        src.set_floor_ms(-10.0);
        assert_eq!(src.stats().floor_ms, PACK_FLOOR_MS_MIN);
        src.set_floor_ms(f64::NAN);
        assert_eq!(src.stats().floor_ms, PACK_FLOOR_MS_DEFAULT);
        src.set_floor_ms(5_000.0);
        // Never-pinned packs get stamped at first enforcement — a pass at
        // t=0 defers, a pass past the (lowered) floor evicts.
        let r = src.enforce_budget(0.0);
        assert_eq!(r.evicted, 0);
        let r2 = src.enforce_budget(6_000.0);
        assert_eq!(r2.evicted, 3);
        assert_eq!(src.stats().packs_resident, 0);
        // Budget restore (ladder release): generous budget = never over.
        let total: usize = sizes.iter().sum();
        src.set_budgets(total * 2, total * 2);
        assert!(!src.stats().over_budget);
        let _ = hashes;
    }
}
