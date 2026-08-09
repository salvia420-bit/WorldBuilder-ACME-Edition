//! `HBP1` pack container + `HBSI1` spatial index — writers and readers.
//!
//! Pipeline re-engineering T10 (SPEC.md §1.1; byte layouts are normative in
//! `docs/reengineering/pass-02-world-pack-format.md` S2–S4, as amended by
//! pass-12 D-12.6 for the terrain t128 slice). This module is the container
//! layer only; partition/tiering/closure policy lives in [`crate::pack_bake`].
//!
//! Conventions shared with the HBNS catalog format (`holtburger-manifest`):
//! little-endian, leading + reversed trailing magic, CRC32-IEEE footer
//! (`holtburger_manifest::catalog::crc32_ieee` — the SAME function).
//!
//! Determinism (pass 2 D-02.6, normative): section table in ascending kind
//! order; record streams sorted by `(ns_ordinal, file_id)`; namespace table
//! sorted; fixed zstd level; **no timestamps anywhere in a pack**. Re-baking
//! unchanged input reproduces byte-identical packs.
//!
//! Layout deltas vs pass 2 (recorded in the T10 report):
//!  * `PLACEMENTS` rows are **44 B**: the pass 2 D-02.9 field list
//!    (`obj_id u32 | pos 3×f32 | quat 4×f32 | scale f32 | cell_xy u16 |
//!    obj_idx u16` = 40 B) plus a 4-byte reserved tail so the stated
//!    "44 B rows" figure and the field list both hold.
//!  * pack kinds 6/7 (terrain t128 slice, one per channel) extend the S2
//!    registry per D-12.6 — each slice is a single CAS file shaped as an
//!    HBP1 pack holding one PVW section (29 HBC7 payloads keyed by rsId).

use std::collections::BTreeMap;

use holtburger_manifest::catalog::crc32_ieee;

/// Leading magic of a pack file.
pub const HBP1_MAGIC: &[u8; 4] = b"HBP1";
/// Trailing magic (reversed), after the CRC32 footer word.
pub const HBP1_TRAILING_MAGIC: &[u8; 4] = b"1PBH";
/// Pack container version.
pub const HBP1_VERSION: u8 = 1;
/// Header length (S2).
pub const HBP1_HEADER_LEN: usize = 32;
/// Section-table entry length (S2).
pub const HBP1_SECTION_ENTRY_LEN: usize = 16;
/// Footer length: crc32 + trailing magic.
pub const HBP1_FOOTER_LEN: usize = 8;

/// Pack kinds (S2 + T10 extension 6/7 per D-12.6).
pub mod pack_kind {
    pub const TILE: u8 = 0;
    pub const INTERIOR: u8 = 1;
    pub const META_SHARED: u8 = 2;
    pub const PREVIEW: u8 = 3;
    pub const ENV: u8 = 4;
    pub const CORE: u8 = 5;
    /// T10 / D-12.6: terrain t128 boot slice, color channel.
    pub const TERRAIN_SLICE_COLOR: u8 = 6;
    /// T10 / D-12.6: terrain t128 boot slice, nra channel.
    pub const TERRAIN_SLICE_NRA: u8 = 7;
}

/// Section kinds (S3 registry).
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

/// Shared-directory kinds for HBSI1 (S4 `[kind u8][ord u8][pack_ord u16]`
/// rows). The `ord` byte is the supergrid ordinal for regional kinds
/// (row-major over the 8×8 grid of 32×32-LB cells), 0 otherwise.
pub mod shared_kind {
    pub const CORE: u8 = 0;
    pub const META_COMMONS: u8 = 1;
    pub const META_REGIONAL: u8 = 2;
    pub const ENV_COMMONS: u8 = 3;
    pub const ENV_REGIONAL: u8 = 4;
    pub const PVW_COMMONS: u8 = 5;
    pub const PVW_REGIONAL: u8 = 6;
    pub const TERRAIN_T128_COLOR: u8 = 7;
    pub const TERRAIN_T128_NRA: u8 = 8;
}

/// Section codecs.
pub mod codec {
    pub const RAW: u8 = 0;
    pub const ZSTD: u8 = 1;
}

/// Fixed zstd level (pass 2 D-02.6: "fixed zstd level 19, no dictionaries
/// in v1"). A CLI override exists for bake-time experiments but the level
/// is part of the deterministic-emission contract — CI bakes at default.
pub const PACK_ZSTD_LEVEL: i32 = 19;

/// `PLACEMENTS` row length (see module notes).
pub const PLACEMENT_ROW_LEN: usize = 44;

/// One section, pre-compression.
#[derive(Debug, Clone)]
pub struct SectionOut {
    pub kind: u16,
    pub codec: u8,
    pub raw: Vec<u8>,
}

/// Serialize a whole HBP1 pack deterministically. `namespaces` must be
/// sorted (asserted); `sections` are sorted by kind here (duplicate kinds
/// are a hard error — producers MUST NOT emit two sections of one kind).
pub fn write_hbp1(
    kind: u8,
    origin: u32,
    namespaces: &[String],
    mut sections: Vec<SectionOut>,
    content_epoch: u64,
    zstd_level: i32,
) -> Result<Vec<u8>, String> {
    if namespaces.len() > 255 {
        return Err("more than 255 namespaces".into());
    }
    if !namespaces.is_sorted() {
        return Err("namespace table must be sorted".into());
    }
    sections.sort_by_key(|s| s.kind);
    for w in sections.windows(2) {
        if w[0].kind == w[1].kind {
            return Err(format!("duplicate section kind 0x{:02X}", w[0].kind));
        }
    }
    if sections.len() > u16::MAX as usize {
        return Err("too many sections".into());
    }

    // Compress section bodies first so offsets are known.
    let mut stored: Vec<(u16, u8, Vec<u8>, u32)> = Vec::with_capacity(sections.len());
    for s in &sections {
        let raw_size = u32::try_from(s.raw.len()).map_err(|_| "section > 4 GiB")?;
        match s.codec {
            codec::RAW => stored.push((s.kind, codec::RAW, s.raw.clone(), raw_size)),
            codec::ZSTD => {
                let body = zstd::encode_all(s.raw.as_slice(), zstd_level)
                    .map_err(|e| format!("zstd encode section 0x{:02X}: {e}", s.kind))?;
                stored.push((s.kind, codec::ZSTD, body, raw_size));
            }
            other => return Err(format!("unknown codec {other}")),
        }
    }

    let ns_table_len = namespaces.len() * 32;
    let table_len = stored.len() * HBP1_SECTION_ENTRY_LEN;
    let payload_len: usize = stored.iter().map(|(_, _, b, _)| b.len()).sum();
    let total =
        HBP1_HEADER_LEN + ns_table_len + table_len + payload_len + HBP1_FOOTER_LEN;
    let mut out = Vec::with_capacity(total);

    // Header (32 B).
    out.extend_from_slice(HBP1_MAGIC);
    out.push(HBP1_VERSION);
    out.push(kind);
    out.extend_from_slice(&0u16.to_le_bytes()); // flags
    out.extend_from_slice(&origin.to_le_bytes());
    out.extend_from_slice(&(stored.len() as u16).to_le_bytes());
    out.push(namespaces.len() as u8);
    out.push(0); // reserved
    out.extend_from_slice(&content_epoch.to_le_bytes());
    out.extend_from_slice(&0u64.to_le_bytes()); // reserved

    // Namespace table (sorted, 32 B zero-padded each).
    for ns in namespaces {
        let bytes = ns.as_bytes();
        if bytes.len() > 32 {
            return Err(format!("namespace {ns:?} longer than 32 bytes"));
        }
        out.extend_from_slice(bytes);
        out.extend(std::iter::repeat_n(0u8, 32 - bytes.len()));
    }

    // Section table, ascending kind; offsets from file start.
    let mut offset = HBP1_HEADER_LEN + ns_table_len + table_len;
    for (kind, cd, body, raw_size) in &stored {
        out.extend_from_slice(&kind.to_le_bytes());
        out.push(*cd);
        out.push(0);
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(&raw_size.to_le_bytes());
        offset += body.len();
    }
    for (_, _, body, _) in &stored {
        out.extend_from_slice(body);
    }

    // Footer.
    let crc = crc32_ieee(&out);
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(HBP1_TRAILING_MAGIC);
    Ok(out)
}

/// Parsed pack (verification / CI reader — the client-side `PackSource`
/// is T12's scope and lives in the wasm crate).
pub struct HbpReader<'a> {
    pub bytes: &'a [u8],
    pub kind: u8,
    pub origin: u32,
    pub content_epoch: u64,
    pub namespaces: Vec<String>,
    /// (kind, codec, offset, stored_size, raw_size)
    pub sections: Vec<(u16, u8, usize, usize, usize)>,
}

impl<'a> HbpReader<'a> {
    pub fn parse(bytes: &'a [u8]) -> Result<Self, String> {
        if bytes.len() < HBP1_HEADER_LEN + HBP1_FOOTER_LEN {
            return Err("shorter than header + footer".into());
        }
        if &bytes[..4] != HBP1_MAGIC {
            return Err("bad magic".into());
        }
        if bytes[4] != HBP1_VERSION {
            return Err(format!("unsupported version {}", bytes[4]));
        }
        let tail = &bytes[bytes.len() - HBP1_FOOTER_LEN..];
        if &tail[4..] != HBP1_TRAILING_MAGIC {
            return Err("bad trailing magic (truncated?)".into());
        }
        let crc_stored = u32::from_le_bytes([tail[0], tail[1], tail[2], tail[3]]);
        let crc = crc32_ieee(&bytes[..bytes.len() - HBP1_FOOTER_LEN]);
        if crc != crc_stored {
            return Err(format!("crc mismatch: stored {crc_stored:08x} computed {crc:08x}"));
        }
        let u16_at =
            |off: usize| u16::from_le_bytes([bytes[off], bytes[off + 1]]);
        let u32_at = |off: usize| {
            u32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]])
        };
        let kind = bytes[5];
        let origin = u32_at(8);
        let section_count = u16_at(12) as usize;
        let ns_count = bytes[14] as usize;
        let content_epoch = u64::from_le_bytes(bytes[16..24].try_into().unwrap());

        let mut pos = HBP1_HEADER_LEN;
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
            let kind = u16_at(pos);
            let cd = bytes[pos + 2];
            let offset = u32_at(pos + 4) as usize;
            let stored = u32_at(pos + 8) as usize;
            let raw = u32_at(pos + 12) as usize;
            if offset + stored > bytes.len() - HBP1_FOOTER_LEN {
                return Err(format!("section 0x{kind:02X} overruns file"));
            }
            sections.push((kind, cd, offset, stored, raw));
            pos += HBP1_SECTION_ENTRY_LEN;
        }
        Ok(Self { bytes, kind, origin, content_epoch, namespaces, sections })
    }

    /// Decompressed payload of section `kind`, or `None` if absent.
    pub fn section(&self, kind: u16) -> Result<Option<Vec<u8>>, String> {
        let Some(&(_, cd, offset, stored, raw)) =
            self.sections.iter().find(|s| s.0 == kind)
        else {
            return Ok(None);
        };
        let body = &self.bytes[offset..offset + stored];
        match cd {
            codec::RAW => Ok(Some(body.to_vec())),
            codec::ZSTD => {
                let out = zstd::decode_all(body)
                    .map_err(|e| format!("zstd decode section 0x{kind:02X}: {e}"))?;
                if out.len() != raw {
                    return Err(format!(
                        "section 0x{kind:02X} raw size {} != declared {raw}",
                        out.len()
                    ));
                }
                Ok(Some(out))
            }
            other => Err(format!("unknown codec {other}")),
        }
    }

    /// Parse a record-stream section into `(ns_ordinal, file_id) -> bytes`.
    pub fn record_stream(
        &self,
        kind: u16,
    ) -> Result<Option<BTreeMap<(u8, u32), Vec<u8>>>, String> {
        let Some(payload) = self.section(kind)? else {
            return Ok(None);
        };
        Ok(Some(parse_record_stream(&payload)?))
    }
}

/// Record-stream framing (S3): `[count u32]` then count ×
/// `[ns_ordinal u8][file_id u32][offset u32][size u32]` (13 B, offsets
/// into the post-index payload area), then payload bytes. Entries sorted
/// by `(ns_ordinal, file_id)`.
pub fn build_record_stream(entries: &BTreeMap<(u8, u32), Vec<u8>>) -> Vec<u8> {
    let index_len = 4 + entries.len() * 13;
    let payload_len: usize = entries.values().map(Vec::len).sum();
    let mut out = Vec::with_capacity(index_len + payload_len);
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    let mut offset = 0u32;
    for ((ns, fid), bytes) in entries {
        out.push(*ns);
        out.extend_from_slice(&fid.to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        offset += bytes.len() as u32;
    }
    for bytes in entries.values() {
        out.extend_from_slice(bytes);
    }
    out
}

/// Inverse of [`build_record_stream`].
pub fn parse_record_stream(
    payload: &[u8],
) -> Result<BTreeMap<(u8, u32), Vec<u8>>, String> {
    if payload.len() < 4 {
        return Err("record stream shorter than count".into());
    }
    let count =
        u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]) as usize;
    let index_len = 4 + count * 13;
    if payload.len() < index_len {
        return Err("record stream index truncated".into());
    }
    let body = &payload[index_len..];
    let mut out = BTreeMap::new();
    for i in 0..count {
        let e = 4 + i * 13;
        let ns = payload[e];
        let fid = u32::from_le_bytes(payload[e + 1..e + 5].try_into().unwrap());
        let off =
            u32::from_le_bytes(payload[e + 5..e + 9].try_into().unwrap()) as usize;
        let size =
            u32::from_le_bytes(payload[e + 9..e + 13].try_into().unwrap()) as usize;
        if off + size > body.len() {
            return Err(format!("record 0x{fid:08X} overruns stream"));
        }
        out.insert((ns, fid), body[off..off + size].to_vec());
    }
    Ok(out)
}

/// REFS section content (S3 kind 0x08).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RefsSection {
    /// `(pack hash16, pack kind)` — the packs this pack depends on.
    pub packs: Vec<([u8; 16], u8)>,
    /// `(ns_ordinal, file_id, pack_ord)` — record → pack edges. Sorted.
    pub records: Vec<(u8, u32, u8)>,
}

pub fn build_refs(refs: &RefsSection) -> Result<Vec<u8>, String> {
    if refs.packs.len() > 255 {
        return Err("more than 255 referenced packs".into());
    }
    let mut out = Vec::with_capacity(1 + refs.packs.len() * 17 + 4 + refs.records.len() * 6);
    out.push(refs.packs.len() as u8);
    for (hash, kind) in &refs.packs {
        out.extend_from_slice(hash);
        out.push(*kind);
    }
    out.extend_from_slice(&(refs.records.len() as u32).to_le_bytes());
    for (ns, fid, ord) in &refs.records {
        out.push(*ns);
        out.extend_from_slice(&fid.to_le_bytes());
        out.push(*ord);
    }
    Ok(out)
}

pub fn parse_refs(payload: &[u8]) -> Result<RefsSection, String> {
    if payload.is_empty() {
        return Err("empty REFS".into());
    }
    let pack_count = payload[0] as usize;
    let mut pos = 1;
    let mut packs = Vec::with_capacity(pack_count);
    for _ in 0..pack_count {
        if pos + 17 > payload.len() {
            return Err("REFS pack table truncated".into());
        }
        let mut hash = [0u8; 16];
        hash.copy_from_slice(&payload[pos..pos + 16]);
        packs.push((hash, payload[pos + 16]));
        pos += 17;
    }
    if pos + 4 > payload.len() {
        return Err("REFS record count truncated".into());
    }
    let rec_count =
        u32::from_le_bytes(payload[pos..pos + 4].try_into().unwrap()) as usize;
    pos += 4;
    let mut records = Vec::with_capacity(rec_count);
    for _ in 0..rec_count {
        if pos + 6 > payload.len() {
            return Err("REFS record table truncated".into());
        }
        let ns = payload[pos];
        let fid = u32::from_le_bytes(payload[pos + 1..pos + 5].try_into().unwrap());
        records.push((ns, fid, payload[pos + 5]));
        pos += 6;
    }
    Ok(RefsSection { packs, records })
}

/// TEXREF row (pass 5 S2). `pvw_pack_ord` indexes THIS pack's REFS pack
/// list; `0xFFFE` = previews carried in this pack's own PVW section;
/// `0xFFFF` = no preview (legacy-lane texture — counted by BAKE-CI).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TexRefRow {
    pub rs_id: u32,
    pub tier_bits: u8,
    pub pvw_pack_ord: u16,
    pub dims: u8,
}

pub mod tier_bits {
    pub const PVW_PRESENT: u8 = 1 << 0;
    pub const FULL_XU7_PRESENT: u8 = 1 << 1;
    pub const FULL_LOSSY: u8 = 1 << 2;
    pub const OFFLINE_NRA: u8 = 1 << 3; // reserved, 0 in v1
    pub const TEXCHAN_SIDECAR: u8 = 1 << 4; // reserved, 0 in v1
}

pub const PVW_ORD_SELF: u16 = 0xFFFE;
pub const PVW_ORD_NONE: u16 = 0xFFFF;

pub fn build_texref(rows: &[TexRefRow]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + rows.len() * 8);
    out.extend_from_slice(&(rows.len() as u32).to_le_bytes());
    for r in rows {
        out.extend_from_slice(&r.rs_id.to_le_bytes());
        out.push(r.tier_bits);
        out.extend_from_slice(&r.pvw_pack_ord.to_le_bytes());
        out.push(r.dims);
    }
    out
}

pub fn parse_texref(payload: &[u8]) -> Result<Vec<TexRefRow>, String> {
    if payload.len() < 4 {
        return Err("TEXREF shorter than count".into());
    }
    let count =
        u32::from_le_bytes(payload[..4].try_into().unwrap()) as usize;
    if payload.len() != 4 + count * 8 {
        return Err("TEXREF length mismatch".into());
    }
    let mut rows = Vec::with_capacity(count);
    for i in 0..count {
        let e = 4 + i * 8;
        rows.push(TexRefRow {
            rs_id: u32::from_le_bytes(payload[e..e + 4].try_into().unwrap()),
            tier_bits: payload[e + 4],
            pvw_pack_ord: u16::from_le_bytes(payload[e + 5..e + 7].try_into().unwrap()),
            dims: payload[e + 7],
        });
    }
    Ok(rows)
}

/// PVW stream (S3 kind 0x0B): `[count u32]` × `[rs_id u32][offset u32]
/// [size u32]` + opaque HBC7 payload rows, sorted by rs_id.
pub fn build_pvw_stream(entries: &BTreeMap<u32, Vec<u8>>) -> Vec<u8> {
    let mut out = Vec::with_capacity(
        4 + entries.len() * 12 + entries.values().map(Vec::len).sum::<usize>(),
    );
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    let mut offset = 0u32;
    for (rs, bytes) in entries {
        out.extend_from_slice(&rs.to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        offset += bytes.len() as u32;
    }
    for bytes in entries.values() {
        out.extend_from_slice(bytes);
    }
    out
}

pub fn parse_pvw_stream(payload: &[u8]) -> Result<BTreeMap<u32, Vec<u8>>, String> {
    if payload.len() < 4 {
        return Err("PVW shorter than count".into());
    }
    let count = u32::from_le_bytes(payload[..4].try_into().unwrap()) as usize;
    let index_len = 4 + count * 12;
    if payload.len() < index_len {
        return Err("PVW index truncated".into());
    }
    let body = &payload[index_len..];
    let mut out = BTreeMap::new();
    for i in 0..count {
        let e = 4 + i * 12;
        let rs = u32::from_le_bytes(payload[e..e + 4].try_into().unwrap());
        let off = u32::from_le_bytes(payload[e + 4..e + 8].try_into().unwrap()) as usize;
        let size = u32::from_le_bytes(payload[e + 8..e + 12].try_into().unwrap()) as usize;
        if off + size > body.len() {
            return Err(format!("PVW 0x{rs:08X} overruns stream"));
        }
        out.insert(rs, body[off..off + size].to_vec());
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// HBSI1 spatial index (S4)
// ---------------------------------------------------------------------------

pub const HBSI_MAGIC: &[u8; 4] = b"HBSI";
pub const HBSI_TRAILING_MAGIC: &[u8; 4] = b"ISBH";
pub const HBSI_VERSION: u8 = 1;
pub const HBSI_HEADER_LEN: usize = 24;
pub const HBSI_TILE_GRID_LEN: usize = 128 * 128 * 2;
/// Empty-tile sentinel in the tile grid.
pub const TILE_EMPTY: u16 = 0xFFFF;

/// One pack-table row: `[hash16][size u32][kind u8][meta u8]` = 24 B..
/// wait — 16 + 4 + 1 + 1 = 22; S4 declares 24 B/row, so two reserved
/// bytes pad the tail (kept zero; also documented in the T10 report).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PackTableEntry {
    pub hash16: [u8; 16],
    pub size: u32,
    pub kind: u8,
    /// tier / supergrid ordinal for shared kinds; 0 otherwise.
    pub meta: u8,
}

pub const HBSI_PACK_ENTRY_LEN: usize = 24;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SpatialIndex {
    pub epoch: u32,
    pub packs: Vec<PackTableEntry>,
    /// 128×128 tile grid, row-major tile_x major (index = tile_x*128 +
    /// tile_y), value = pack-table ordinal or [`TILE_EMPTY`].
    pub tile_grid: Vec<u16>,
    /// `(lb u16 = lbx<<8|lby, pack_ord u16)`, sorted by lb.
    pub interiors: Vec<(u16, u16)>,
    /// `(kind u8, ord u8, pack_ord u16)` shared directory rows, sorted.
    pub shared: Vec<(u8, u8, u16)>,
}

pub fn write_hbsi1(index: &SpatialIndex) -> Result<Vec<u8>, String> {
    if index.tile_grid.len() != 128 * 128 {
        return Err("tile grid must be 128x128".into());
    }
    if index.packs.len() > u16::MAX as usize {
        return Err("more than 65535 packs".into());
    }
    let mut out = Vec::with_capacity(
        HBSI_HEADER_LEN
            + index.packs.len() * HBSI_PACK_ENTRY_LEN
            + HBSI_TILE_GRID_LEN
            + index.interiors.len() * 6
            + index.shared.len() * 4
            + 8,
    );
    out.extend_from_slice(HBSI_MAGIC);
    out.push(HBSI_VERSION);
    out.push(0); // flags
    out.extend_from_slice(&0u16.to_le_bytes()); // reserved
    out.extend_from_slice(&(index.packs.len() as u32).to_le_bytes());
    out.extend_from_slice(&(index.interiors.len() as u32).to_le_bytes());
    out.extend_from_slice(&(index.shared.len() as u16).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // reserved
    out.extend_from_slice(&index.epoch.to_le_bytes());

    for p in &index.packs {
        out.extend_from_slice(&p.hash16);
        out.extend_from_slice(&p.size.to_le_bytes());
        out.push(p.kind);
        out.push(p.meta);
        out.extend_from_slice(&0u16.to_le_bytes()); // pad to 24 B
    }
    for &ord in &index.tile_grid {
        out.extend_from_slice(&ord.to_le_bytes());
    }
    for &(lb, ord) in &index.interiors {
        out.extend_from_slice(&lb.to_le_bytes());
        out.extend_from_slice(&ord.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // reserved
    }
    for &(kind, ord, pack_ord) in &index.shared {
        out.push(kind);
        out.push(ord);
        out.extend_from_slice(&pack_ord.to_le_bytes());
    }
    let crc = crc32_ieee(&out);
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(HBSI_TRAILING_MAGIC);
    Ok(out)
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
    let u32_at = |off: usize| {
        u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap())
    };
    let u16_at = |off: usize| u16::from_le_bytes([bytes[off], bytes[off + 1]]);
    let pack_count = u32_at(8) as usize;
    let interior_count = u32_at(12) as usize;
    let shared_count = u16_at(16) as usize;
    let epoch = u32_at(20);

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

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_pack() -> Vec<u8> {
        let mut records = BTreeMap::new();
        records.insert((0u8, 0x0100_0001u32), vec![1u8; 300]);
        records.insert((0u8, 0x0800_0002u32), vec![2u8; 40]);
        records.insert((1u8, 0xA9B4_FFFFu32), vec![3u8; 252]);
        let refs = RefsSection {
            packs: vec![([0xAB; 16], pack_kind::META_SHARED)],
            records: vec![(0, 0x0100_9999, 0)],
        };
        let sections = vec![
            SectionOut {
                kind: section_kind::RECORDS,
                codec: codec::ZSTD,
                raw: build_record_stream(&records),
            },
            SectionOut {
                kind: section_kind::REFS,
                codec: codec::RAW,
                raw: build_refs(&refs).unwrap(),
            },
        ];
        write_hbp1(
            pack_kind::TILE,
            (3u32 << 8) | 4,
            &["eor/cell".into(), "eor/portal".into()],
            sections,
            0xDEAD_BEEF_CAFE_F00D,
            3, // fast level for tests; determinism is level-fixed per bake
        )
        .expect("write pack")
    }

    #[test]
    fn hbp1_round_trips_and_validates() {
        let bytes = sample_pack();
        let r = HbpReader::parse(&bytes).expect("parse");
        assert_eq!(r.kind, pack_kind::TILE);
        assert_eq!(r.origin, (3 << 8) | 4);
        assert_eq!(r.content_epoch, 0xDEAD_BEEF_CAFE_F00D);
        assert_eq!(r.namespaces, vec!["eor/cell", "eor/portal"]);

        let records = r.record_stream(section_kind::RECORDS).unwrap().unwrap();
        assert_eq!(records.len(), 3);
        assert_eq!(records[&(0, 0x0100_0001)], vec![1u8; 300]);
        assert_eq!(records[&(1, 0xA9B4_FFFF)], vec![3u8; 252]);

        let refs =
            parse_refs(&r.section(section_kind::REFS).unwrap().unwrap()).unwrap();
        assert_eq!(refs.packs.len(), 1);
        assert_eq!(refs.records, vec![(0, 0x0100_9999, 0)]);

        // Absent section reads None, not an error (forward compat).
        assert!(r.section(section_kind::GEOM).unwrap().is_none());
    }

    #[test]
    fn hbp1_is_deterministic_and_tamper_evident() {
        let a = sample_pack();
        let b = sample_pack();
        assert_eq!(a, b, "same input must emit byte-identical packs");

        let mut bad = a.clone();
        let mid = bad.len() / 2;
        bad[mid] ^= 0xFF;
        assert!(HbpReader::parse(&bad).is_err(), "crc must catch a flip");

        let mut truncated = a.clone();
        truncated.truncate(truncated.len() - 3);
        assert!(HbpReader::parse(&truncated).is_err());
    }

    #[test]
    fn duplicate_section_kind_is_refused() {
        let s = |k| SectionOut { kind: k, codec: codec::RAW, raw: vec![0] };
        let err = write_hbp1(
            pack_kind::TILE,
            0,
            &[],
            vec![s(section_kind::RECORDS), s(section_kind::RECORDS)],
            0,
            3,
        )
        .unwrap_err();
        assert!(err.contains("duplicate"));
    }

    #[test]
    fn texref_and_pvw_round_trip() {
        let rows = vec![
            TexRefRow { rs_id: 0x0600_3789, tier_bits: 0b11, pvw_pack_ord: 0, dims: 0xAA },
            TexRefRow {
                rs_id: 0x0600_FFFE,
                tier_bits: 0,
                pvw_pack_ord: PVW_ORD_NONE,
                dims: 0x55,
            },
        ];
        assert_eq!(parse_texref(&build_texref(&rows)).unwrap(), rows);

        let mut pvw = BTreeMap::new();
        pvw.insert(0x0600_3789u32, vec![7u8; 100]);
        pvw.insert(0x0600_0001u32, vec![9u8; 20]);
        assert_eq!(parse_pvw_stream(&build_pvw_stream(&pvw)).unwrap(), pvw);
    }

    #[test]
    fn hbsi1_round_trips() {
        let mut tile_grid = vec![TILE_EMPTY; 128 * 128];
        tile_grid[84 * 128 + 90] = 2; // Holtburg-ish tile
        let index = SpatialIndex {
            epoch: 42,
            packs: vec![
                PackTableEntry { hash16: [1; 16], size: 100, kind: pack_kind::CORE, meta: 0 },
                PackTableEntry {
                    hash16: [2; 16],
                    size: 200,
                    kind: pack_kind::META_SHARED,
                    meta: 0,
                },
                PackTableEntry { hash16: [3; 16], size: 300, kind: pack_kind::TILE, meta: 0 },
            ],
            tile_grid,
            interiors: vec![((0xA9 << 8) | 0xB4, 2)],
            shared: vec![
                (shared_kind::CORE, 0, 0),
                (shared_kind::META_COMMONS, 0, 1),
            ],
        };
        let bytes = write_hbsi1(&index).expect("write");
        let back = parse_hbsi1(&bytes).expect("parse");
        assert_eq!(back, index);

        // Deterministic + tamper-evident.
        assert_eq!(bytes, write_hbsi1(&index).unwrap());
        let mut bad = bytes.clone();
        bad[HBSI_HEADER_LEN + 5] ^= 1;
        assert!(parse_hbsi1(&bad).is_err());
    }
}
