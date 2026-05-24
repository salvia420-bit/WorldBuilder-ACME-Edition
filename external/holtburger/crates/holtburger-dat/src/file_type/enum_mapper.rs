//! EnumMapper (DAT type 0x22, ID range `0x22000000..=0x22FFFFFF`).
//!
//! Maps numeric enum IDs to their human-readable string names —
//! used as a debug/serialization lookup so that values from various
//! engine enums (UI element types, action IDs, etc.) can be
//! displayed by name. Retail has 40 records.
//!
//! Wire layout (per ACE `Source/ACE.DatLoader/FileTypes/EnumMapper.cs`).
//! Note: this is the STANDALONE EnumMapper format. The embedded form
//! used inside MasterProperty (see
//! [`crate::file_type::EnumMapperData`]) has a DIFFERENT layout —
//! standalone has a u8 NumberingType byte where embedded has an
//! "Unknown" u32. Don't confuse them.
//!
//! ```text
//!   u32             id
//!   u32             base_enum_map           (m_base_emp_did)
//!   u8              numbering_type          (NumberingType enum)
//!   CompressedUInt  num_enums
//!   N × { u32 key + PString<u8> value }
//! ```

use crate::utils::read_compressed_u32;
use binrw::io::Seek;
use std::collections::HashMap;
use std::io::Read;

/// NumberingType is stored as a raw u8 — ACE's enum in
/// `ACE.Entity.Enum.NumberingType` only covers values 0-4 (Undefined,
/// Normal=Sequential, Bitfield, Bitfield32, Bitfield64) but retail
/// records hold values up to at least 7 (seen in EnumMapper
/// 0x2200001B). ACE's enum is incomplete; the wire is whatever the
/// engine writes. Consumers can interpret per ACE's known values:
///   0 = Undefined / 1 = Normal/Sequential / 2 = Bitfield /
///   3 = Bitfield32 / 4 = Bitfield64 / 5..=7 = unknown
pub type NumberingType = u8;

#[derive(Debug, Clone, serde::Serialize)]
pub struct EnumMapper {
    pub id: u32,
    /// DataID of a parent EnumMapper this one extends (0 if none).
    pub base_enum_map: u32,
    pub numbering_type: NumberingType,
    pub id_to_string_map: HashMap<u32, String>,
}

impl EnumMapper {
    pub fn read_le<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<Self> {
        use binrw::BinRead;

        let id = u32::read_le(reader)?;
        let base_enum_map = u32::read_le(reader)?;
        let numbering_type = u8::read(reader)?;

        let num_enums = read_compressed_u32(reader)? as usize;
        let mut id_to_string_map = HashMap::with_capacity(num_enums);
        for _ in 0..num_enums {
            let key = u32::read_le(reader)?;
            let value = read_pstring_byte_compressed(reader)?;
            id_to_string_map.insert(key, value);
        }

        Ok(Self {
            id,
            base_enum_map,
            numbering_type,
            id_to_string_map,
        })
    }
}

fn read_pstring_byte_compressed<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<String> {
    let len = read_compressed_u32(reader)? as usize;
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf)?;
    let (decoded, _, _) = encoding_rs::WINDOWS_1252.decode(&buf);
    Ok(decoded.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use binrw::io::Cursor;

    #[test]
    fn minimal_enum_mapper_round_trips() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0x22000001u32.to_le_bytes()); // id
        bytes.extend_from_slice(&0u32.to_le_bytes()); // base_enum_map
        bytes.push(1); // numbering_type = Normal
        bytes.push(2); // CompressedUInt count = 2
        // entry 0
        bytes.extend_from_slice(&0u32.to_le_bytes()); // key
        bytes.push(7); // PString len = 7
        bytes.extend_from_slice(b"Invalid");
        // entry 1
        bytes.extend_from_slice(&1u32.to_le_bytes()); // key
        bytes.push(2); // PString len = 2
        bytes.extend_from_slice(b"OK");

        let mut cursor = Cursor::new(&bytes);
        let mapper = EnumMapper::read_le(&mut cursor).expect("parse");
        assert_eq!(mapper.id, 0x22000001);
        assert_eq!(mapper.numbering_type, 1, "Normal");
        assert_eq!(mapper.id_to_string_map.len(), 2);
        assert_eq!(mapper.id_to_string_map.get(&0).map(|s| s.as_str()), Some("Invalid"));
        assert_eq!(mapper.id_to_string_map.get(&1).map(|s| s.as_str()), Some("OK"));
        assert_eq!(cursor.position() as usize, bytes.len(), "no leftover bytes");
    }
}
