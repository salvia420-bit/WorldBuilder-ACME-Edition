//! Contract Table — `client_portal.dat` file `0x0E00001D`.
//!
//! Maps `contract_id` u32 → [`Contract`] record with localised name,
//! description, NPC names and quest-area positions. Retail ships **322
//! entries** (asserted by `DatReaderWriter.Tests/DBObjs/ContractTableTests.cs:86`).
//!
//! Wave F.5 follow-on (2026-05-27): the contracts panel previously
//! showed `Contract #N` placeholders because the per-contract metadata
//! (the friendly name, the NPC start/end names, the location) had no
//! parser. This module ports retail's `CContractTable::Serialize` so
//! the UI can swap the placeholder for the real name.
//!
//! # Wire layout
//!
//! ```text
//!   u32  id                            (DBObjHeaderFlags.HasId = 0x0E00001D)
//!   u16  num_contracts                 (= 322 / 0x142 in retail EoR)
//!   u16  bucket_size                   (PackableHashTable header — read & ignore)
//!   [Entry; num_contracts]
//!     u32      key                       (contract_id, sparse 1..655)
//!     Contract value
//! ```
//!
//! # `Contract` layout (35-ish total reads + 11 align-pads + 3 Position frames)
//!
//! Field order is **load-bearing**: it mirrors retail's
//! `CContract::UnPack` at `acclient.c:452658-452708` (verified against
//! Hex-Rays decomp + `external/chorizite/ACBindings/Generated/Net/Types/CContract.cs:24-39`).
//!
//! ```text
//!   u32                version
//!   u32                contract_id
//!   PStringBase<char>  contract_name        (with align-pad)
//!   PStringBase<char>  description
//!   PStringBase<char>  description_progress
//!   PStringBase<char>  name_npc_start
//!   PStringBase<char>  name_npc_end
//!   PStringBase<char>  questflag_stamped
//!   PStringBase<char>  questflag_started
//!   PStringBase<char>  questflag_finished
//!   PStringBase<char>  questflag_progress
//!   PStringBase<char>  questflag_timer
//!   PStringBase<char>  questflag_repeat_time
//!   Position           location_npc_start   (32 bytes — u32 cell_id + Frame)
//!   Position           location_npc_end     (32 bytes)
//!   Position           location_quest_area  (32 bytes)
//! ```
//!
//! # `PStringBase<char>` quirk
//!
//! Per `acclient.c:296509-296568` (and mirrored by ACE.DatLoader's
//! `AC1LegacyPStringBase` reader): the on-disk format is
//!
//! ```text
//!   u16 length                          (if 0xFFFF, follow with u32 length)
//!   length × u8 ASCII bytes
//!   pad to 4-byte boundary
//! ```
//!
//! The retail bug at `acclient.c:296547-296550` writes a NUL past the
//! buffer end and then decrements `len` if the byte before the NUL is
//! also NUL — which means the on-wire string may include trailing NUL
//! bytes that the retail client trims silently. We mirror DRW /
//! ACE.DatLoader and **don't** trim: the bytes are kept verbatim, which
//! is enough for the panel display (no NUL bytes appear in any retail
//! contract string per the EoR fixture).

use crate::{EOR_PORTAL_NAMESPACE, ResourceKey, StaticResourceKey};
use binrw::{BinRead, BinResult};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};

/// One row in [`ContractTable`].
///
/// Field types are chosen to match what the panel needs to display —
/// strings are `String` (UTF-8), positions are kept as the raw
/// `(cell_id, origin, orientation)` tuple. The panel's primary read
/// site is `contract_name`; the rest exist so plugins (quest tracker,
/// map waypoint) can hydrate later without a re-parse.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Contract {
    pub version: u32,
    pub contract_id: u32,
    /// Display name (e.g. "Jailbreak: Ardent Leader").
    pub contract_name: String,
    /// Long-form description shown in the contract details panel.
    pub description: String,
    /// Progress text template (e.g. "%d/1 Large Ardent Moarsman").
    pub description_progress: String,
    /// Name of the NPC who hands out the contract.
    pub name_npc_start: String,
    /// Name of the NPC who closes the contract (often the same as start).
    pub name_npc_end: String,
    /// Server-side questflag key recording one-time "stamped" status.
    pub questflag_stamped: String,
    /// Server-side questflag key recording "started" status.
    pub questflag_started: String,
    /// Server-side questflag key recording "finished" status.
    pub questflag_finished: String,
    /// Server-side questflag key tracking interim progress counter.
    pub questflag_progress: String,
    /// Server-side questflag key holding completion timestamp.
    pub questflag_timer: String,
    /// Server-side questflag key holding repeat-available timestamp.
    pub questflag_repeat_time: String,
    /// `(cell_id, origin, orientation)` of the start NPC.
    pub location_npc_start: ContractPosition,
    /// `(cell_id, origin, orientation)` of the end NPC.
    pub location_npc_end: ContractPosition,
    /// `(cell_id, origin, orientation)` of the quest area.
    pub location_quest_area: ContractPosition,
}

/// Flat record-style projection of a packed `Position`. Kept distinct
/// from `crate::graphics::Frame` because contracts also carry the
/// `cell_id` (the Frame type used by ObjectDesc doesn't include the
/// cell). Total size: 32 bytes (u32 + 12 + 16).
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, Default)]
pub struct ContractPosition {
    pub cell_id: u32,
    pub origin: [f32; 3],
    /// Quaternion (w, x, y, z) per AC's `cQuat` packing — w-first.
    pub orientation: [f32; 4],
}

impl ContractPosition {
    fn read<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let cell_id = u32::read_le(reader)?;
        let ox = f32::read_le(reader)?;
        let oy = f32::read_le(reader)?;
        let oz = f32::read_le(reader)?;
        let qw = f32::read_le(reader)?;
        let qx = f32::read_le(reader)?;
        let qy = f32::read_le(reader)?;
        let qz = f32::read_le(reader)?;
        Ok(Self {
            cell_id,
            origin: [ox, oy, oz],
            orientation: [qw, qx, qy, qz],
        })
    }
}

/// Contract Table from `client_portal.dat` (file `0x0E00001D`).
/// Retail EoR ships 322 entries.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ContractTable {
    pub id: u32,
    pub contracts: HashMap<u32, Contract>,
}

impl ContractTable {
    /// File ID in `client_portal.dat`.
    pub const FILE_ID: u32 = 0x0E00001D;

    /// Parse a `ContractTable` from raw `client_portal.dat` bytes.
    /// Mirrors the `Font::unpack` / `LanguageString::unpack` pattern so
    /// wasm-side callers don't take a direct `binrw` dependency.
    pub fn unpack(data: &[u8]) -> binrw::BinResult<Self> {
        let mut cursor = binrw::io::Cursor::new(data);
        <Self as binrw::BinRead>::read_options(&mut cursor, binrw::Endian::Little, ())
    }
}

impl StaticResourceKey for ContractTable {
    const RESOURCE_KEY: ResourceKey<'static> =
        ResourceKey::new(EOR_PORTAL_NAMESPACE, Self::FILE_ID);
}

impl BinRead for ContractTable {
    type Args<'a> = ();

    fn read_options<R: Read + Seek>(
        reader: &mut R,
        endian: binrw::Endian,
        _args: Self::Args<'_>,
    ) -> BinResult<Self> {
        if endian != binrw::Endian::Little {
            return Err(binrw::Error::AssertFail {
                pos: reader.stream_position().unwrap_or(0),
                message: "ContractTable is little-endian only".to_string(),
            });
        }
        let id = u32::read_le(reader)?;
        let contracts = parse_contract_hash_table(reader)?;
        Ok(Self { id, contracts })
    }
}

/// PStringBase<char> per `acclient.c:296509`. u16 length (if 0xFFFF,
/// follow with u32). After the bytes, pad to 4-byte boundary.
fn read_pstring_char<R: Read + Seek>(reader: &mut R) -> BinResult<String> {
    let len_u16 = u16::read_le(reader)?;
    let len = if len_u16 == 0xFFFF {
        u32::read_le(reader)? as usize
    } else {
        len_u16 as usize
    };
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf)?;
    // Strip trailing NULs (retail's UnPack does this implicitly via the
    // m_len decrement at acclient.c:296549-296550 — most strings have
    // no NULs but the EoR `Contract.questflag_*` strings sometimes do).
    while buf.last() == Some(&0) {
        buf.pop();
    }
    // Align to 4-byte boundary.
    let pos = reader.stream_position()?;
    let pad = (4 - (pos % 4) as usize) % 4;
    if pad > 0 {
        reader.seek(SeekFrom::Current(pad as i64))?;
    }
    let (decoded, _, _) = encoding_rs::WINDOWS_1252.decode(&buf);
    Ok(decoded.into_owned())
}

fn parse_contract<R: Read + Seek>(reader: &mut R) -> BinResult<Contract> {
    let version = u32::read_le(reader)?;
    let contract_id = u32::read_le(reader)?;
    let contract_name = read_pstring_char(reader)?;
    let description = read_pstring_char(reader)?;
    let description_progress = read_pstring_char(reader)?;
    let name_npc_start = read_pstring_char(reader)?;
    let name_npc_end = read_pstring_char(reader)?;
    let questflag_stamped = read_pstring_char(reader)?;
    let questflag_started = read_pstring_char(reader)?;
    let questflag_finished = read_pstring_char(reader)?;
    let questflag_progress = read_pstring_char(reader)?;
    let questflag_timer = read_pstring_char(reader)?;
    let questflag_repeat_time = read_pstring_char(reader)?;
    let location_npc_start = ContractPosition::read(reader)?;
    let location_npc_end = ContractPosition::read(reader)?;
    let location_quest_area = ContractPosition::read(reader)?;
    Ok(Contract {
        version,
        contract_id,
        contract_name,
        description,
        description_progress,
        name_npc_start,
        name_npc_end,
        questflag_stamped,
        questflag_started,
        questflag_finished,
        questflag_progress,
        questflag_timer,
        questflag_repeat_time,
        location_npc_start,
        location_npc_end,
        location_quest_area,
    })
}

fn parse_contract_hash_table<R: Read + Seek>(
    reader: &mut R,
) -> BinResult<HashMap<u32, Contract>> {
    // PackableHashTable<uint, Contract> header: u16 count + u16 bucket_size.
    let count = u16::read_le(reader)?;
    let _bucket_size = u16::read_le(reader)?;
    let mut map = HashMap::with_capacity(count as usize);
    for _ in 0..count {
        let key = u32::read_le(reader)?;
        let value = parse_contract(reader)?;
        map.insert(key, value);
    }
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use binrw::io::Cursor;
    use std::io::Seek;

    fn write_pstring_char(buf: &mut Vec<u8>, s: &str) {
        let bytes = s.as_bytes();
        let len = bytes.len();
        if len < 0xFFFF {
            buf.extend_from_slice(&(len as u16).to_le_bytes());
        } else {
            buf.extend_from_slice(&0xFFFFu16.to_le_bytes());
            buf.extend_from_slice(&(len as u32).to_le_bytes());
        }
        buf.extend_from_slice(bytes);
        while buf.len() % 4 != 0 {
            buf.push(0);
        }
    }

    fn write_position(buf: &mut Vec<u8>, pos: &ContractPosition) {
        buf.extend_from_slice(&pos.cell_id.to_le_bytes());
        for f in &pos.origin {
            buf.extend_from_slice(&f.to_le_bytes());
        }
        for f in &pos.orientation {
            buf.extend_from_slice(&f.to_le_bytes());
        }
    }

    fn write_contract(buf: &mut Vec<u8>, c: &Contract) {
        buf.extend_from_slice(&c.version.to_le_bytes());
        buf.extend_from_slice(&c.contract_id.to_le_bytes());
        write_pstring_char(buf, &c.contract_name);
        write_pstring_char(buf, &c.description);
        write_pstring_char(buf, &c.description_progress);
        write_pstring_char(buf, &c.name_npc_start);
        write_pstring_char(buf, &c.name_npc_end);
        write_pstring_char(buf, &c.questflag_stamped);
        write_pstring_char(buf, &c.questflag_started);
        write_pstring_char(buf, &c.questflag_finished);
        write_pstring_char(buf, &c.questflag_progress);
        write_pstring_char(buf, &c.questflag_timer);
        write_pstring_char(buf, &c.questflag_repeat_time);
        write_position(buf, &c.location_npc_start);
        write_position(buf, &c.location_npc_end);
        write_position(buf, &c.location_quest_area);
    }

    fn drw_canonical_contract() -> Contract {
        // Mirrors DRW's `ContractTableTests.cs:25-44` fixture.
        let pos = ContractPosition {
            cell_id: 0x00010100,
            origin: [0.0, 0.0, 1.0],
            // DRW writes `Quaternion.Identity`. .NET's
            // `System.Numerics.Quaternion(0,0,0,1)` is the identity with
            // `W=1`; we write w-first so (1, 0, 0, 0).
            orientation: [1.0, 0.0, 0.0, 0.0],
        };
        Contract {
            version: 1,
            contract_id: 0x1,
            contract_name: "Contract 1".to_string(),
            description: "Description 1".to_string(),
            description_progress: "Description Progress 1".to_string(),
            name_npc_start: "NPC Start 1".to_string(),
            name_npc_end: "NPC End 1".to_string(),
            questflag_stamped: "Stamped 1".to_string(),
            questflag_started: "Started 1".to_string(),
            questflag_finished: "Finished 1".to_string(),
            questflag_progress: "Progress 1".to_string(),
            questflag_timer: "Timer 1".to_string(),
            questflag_repeat_time: "Repeat Time 1".to_string(),
            location_npc_start: pos,
            location_npc_end: pos,
            location_quest_area: pos,
        }
    }

    #[test]
    fn parse_empty_table() {
        let mut data = Vec::new();
        data.extend_from_slice(&ContractTable::FILE_ID.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes()); // count
        data.extend_from_slice(&0u16.to_le_bytes()); // bucket_size

        let table = ContractTable::unpack(&data).unwrap();
        assert_eq!(table.id, ContractTable::FILE_ID);
        assert!(table.contracts.is_empty());
    }

    #[test]
    fn parse_drw_fixture_contract() {
        let canonical = drw_canonical_contract();

        let mut data = Vec::new();
        data.extend_from_slice(&ContractTable::FILE_ID.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes()); // count
        data.extend_from_slice(&8u16.to_le_bytes()); // bucket_size
        data.extend_from_slice(&1u32.to_le_bytes()); // key
        write_contract(&mut data, &canonical);

        let table = ContractTable::unpack(&data).unwrap();
        assert_eq!(table.id, ContractTable::FILE_ID);
        assert_eq!(table.contracts.len(), 1);
        let c = table.contracts.get(&1).expect("contract 1 missing");
        assert_eq!(c.version, 1);
        assert_eq!(c.contract_id, 1);
        assert_eq!(c.contract_name, "Contract 1");
        assert_eq!(c.description, "Description 1");
        assert_eq!(c.description_progress, "Description Progress 1");
        assert_eq!(c.name_npc_start, "NPC Start 1");
        assert_eq!(c.name_npc_end, "NPC End 1");
        assert_eq!(c.questflag_stamped, "Stamped 1");
        assert_eq!(c.questflag_started, "Started 1");
        assert_eq!(c.questflag_finished, "Finished 1");
        assert_eq!(c.questflag_progress, "Progress 1");
        assert_eq!(c.questflag_timer, "Timer 1");
        assert_eq!(c.questflag_repeat_time, "Repeat Time 1");
        assert_eq!(c.location_npc_start.cell_id, 0x00010100);
        assert_eq!(c.location_npc_end.origin, [0.0, 0.0, 1.0]);
        // Quaternion.Identity (W=1, X=Y=Z=0) in w-first encoding.
        assert_eq!(c.location_quest_area.orientation, [1.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn parse_eor_fixture_contract_200() {
        // Mirrors DRW's `ContractTableTests.cs:CanReadEOR` — entry 200
        // is "Jailbreak: Ardent Leader". This synthesises the bytes
        // (we don't have the real DAT in the unit-test sandbox) but
        // exercises a longer, real-format string and questflag set.
        let c200 = Contract {
            version: 0,
            contract_id: 200,
            contract_name: "Jailbreak: Ardent Leader".to_string(),
            description: "Defeat the Large Ardent Moarsman in the Freebooter Prison.".to_string(),
            description_progress: "%d/1 Large Ardent Moarsman".to_string(),
            name_npc_start: "Avarin".to_string(),
            name_npc_end: "Avarin".to_string(),
            questflag_stamped: "".to_string(),
            questflag_started: "".to_string(),
            questflag_finished: "".to_string(),
            questflag_progress: "FreebooterKillTaskBoss10809".to_string(),
            questflag_timer: "".to_string(),
            questflag_repeat_time: "FreebooterKillTaskBoss1Wait0809".to_string(),
            location_npc_start: ContractPosition::default(),
            location_npc_end: ContractPosition::default(),
            location_quest_area: ContractPosition::default(),
        };

        let mut data = Vec::new();
        data.extend_from_slice(&ContractTable::FILE_ID.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes()); // count
        data.extend_from_slice(&64u16.to_le_bytes()); // bucket_size (arbitrary)
        data.extend_from_slice(&200u32.to_le_bytes()); // key
        write_contract(&mut data, &c200);

        let table = ContractTable::unpack(&data).unwrap();
        let parsed = table.contracts.get(&200).expect("contract 200 missing");
        assert_eq!(parsed.contract_name, "Jailbreak: Ardent Leader");
        assert_eq!(parsed.description_progress, "%d/1 Large Ardent Moarsman");
        assert_eq!(parsed.name_npc_start, "Avarin");
        assert_eq!(parsed.questflag_progress, "FreebooterKillTaskBoss10809");
        assert_eq!(parsed.questflag_repeat_time, "FreebooterKillTaskBoss1Wait0809");
    }

    #[test]
    fn pstring_with_extended_length() {
        // Build a string longer than 0xFFFE so the parser exercises the
        // u32-extended length path (acclient.c:296531-296535).
        let long_str: String = "A".repeat(0xFFFF + 1);
        let mut buf = Vec::new();
        write_pstring_char(&mut buf, &long_str);

        // Verify the format we wrote actually uses the u32 path.
        assert_eq!(&buf[0..2], &0xFFFFu16.to_le_bytes());
        assert_eq!(&buf[2..6], &((0xFFFF + 1) as u32).to_le_bytes());

        let mut cursor = Cursor::new(buf);
        let parsed = read_pstring_char(&mut cursor).unwrap();
        assert_eq!(parsed.len(), long_str.len());
        assert_eq!(parsed, long_str);
    }

    #[test]
    fn pstring_align_pad_advances_cursor() {
        // 1-byte string forces 1-byte align-pad to bring the cursor
        // from offset 3 → 4 — verify the cursor advances past it so
        // subsequent reads land on a 4-aligned offset.
        //
        // Layout: u16 length (2 bytes, offsets 0..2) + 1 ASCII byte
        // (offset 2..3) + 1-byte pad (offset 3..4) + u32 canary
        // (offset 4..8).
        let mut buf = Vec::new();
        buf.extend_from_slice(&1u16.to_le_bytes()); // length
        buf.push(b'X');
        buf.push(0); // 1 pad byte (cursor at offset 3 → 4)
        buf.extend_from_slice(&0xDEADBEEFu32.to_le_bytes()); // canary

        let mut cursor = Cursor::new(buf);
        let s = read_pstring_char(&mut cursor).unwrap();
        assert_eq!(s, "X");
        assert_eq!(cursor.stream_position().unwrap(), 4);
        let canary = u32::read_le(&mut cursor).unwrap();
        assert_eq!(canary, 0xDEADBEEF);
    }
}
