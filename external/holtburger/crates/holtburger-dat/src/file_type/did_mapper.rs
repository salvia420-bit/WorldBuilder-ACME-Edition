//! DidMapper (DAT type 0x25, ID range `0x25000000..=0x25FFFFFF`).
//!
//! Maps client/server enum values to DataIDs and to string names —
//! used during DAT-content load to resolve enum-typed references to
//! actual records. Retail has 22 records. The record at 0x25000000
//! is the index describing every other DidMapper (per ACE).
//!
//! DRW calls this `EnumIDMap` / `DataIDMapper`. ACE's `DidMapper.cs`
//! is the canonical wire-format reference (credited to "OptimShi" in
//! ACE's source).
//!
//! Wire layout (per ACE `Source/ACE.DatLoader/FileTypes/DidMapper.cs`):
//!
//! ```text
//!   u32             id
//!
//!   u8              client_id_numbering_type
//!   CompressedUInt  num_client_enum_to_id
//!   N × (u32 enum + u32 data_id)
//!
//!   u8              client_name_numbering_type
//!   CompressedUInt  num_client_enum_to_name
//!   N × (u32 enum + PString<u8> name)
//!
//!   u8              server_id_numbering_type
//!   CompressedUInt  num_server_enum_to_id
//!   N × (u32 enum + u32 data_id)
//!
//!   u8              server_name_numbering_type
//!   CompressedUInt  num_server_enum_to_name
//!   N × (u32 enum + PString<u8> name)
//! ```

use crate::utils::read_compressed_u32;
use binrw::io::Seek;
use std::collections::HashMap;
use std::io::Read;

#[derive(Debug, Clone, serde::Serialize)]
pub struct DidMapper {
    pub id: u32,

    /// NumberingType is u8 (ACE's enum is incomplete; raw byte
    /// matches all observed values). See `enum_mapper.rs` for the
    /// known 0..=4 meanings.
    pub client_id_numbering_type: u8,
    pub client_enum_to_id: HashMap<u32, u32>,

    pub client_name_numbering_type: u8,
    pub client_enum_to_name: HashMap<u32, String>,

    pub server_id_numbering_type: u8,
    pub server_enum_to_id: HashMap<u32, u32>,

    pub server_name_numbering_type: u8,
    pub server_enum_to_name: HashMap<u32, String>,
}

impl DidMapper {
    pub fn read_le<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<Self> {
        use binrw::BinRead;

        let id = u32::read_le(reader)?;

        let client_id_numbering_type = u8::read(reader)?;
        let n = read_compressed_u32(reader)? as usize;
        let mut client_enum_to_id = HashMap::with_capacity(n);
        for _ in 0..n {
            client_enum_to_id.insert(u32::read_le(reader)?, u32::read_le(reader)?);
        }

        let client_name_numbering_type = u8::read(reader)?;
        let n = read_compressed_u32(reader)? as usize;
        let mut client_enum_to_name = HashMap::with_capacity(n);
        for _ in 0..n {
            client_enum_to_name.insert(u32::read_le(reader)?, read_pstring_byte(reader)?);
        }

        let server_id_numbering_type = u8::read(reader)?;
        let n = read_compressed_u32(reader)? as usize;
        let mut server_enum_to_id = HashMap::with_capacity(n);
        for _ in 0..n {
            server_enum_to_id.insert(u32::read_le(reader)?, u32::read_le(reader)?);
        }

        let server_name_numbering_type = u8::read(reader)?;
        let n = read_compressed_u32(reader)? as usize;
        let mut server_enum_to_name = HashMap::with_capacity(n);
        for _ in 0..n {
            server_enum_to_name.insert(u32::read_le(reader)?, read_pstring_byte(reader)?);
        }

        Ok(Self {
            id,
            client_id_numbering_type,
            client_enum_to_id,
            client_name_numbering_type,
            client_enum_to_name,
            server_id_numbering_type,
            server_enum_to_id,
            server_name_numbering_type,
            server_enum_to_name,
        })
    }
}

fn read_pstring_byte<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<String> {
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

    /// Minimal DidMapper: id + 4 empty sub-tables.
    #[test]
    fn minimal_did_mapper_round_trips() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0x25000000u32.to_le_bytes());
        for _ in 0..4 {
            bytes.push(1); // numbering_type
            bytes.push(0); // CompressedUInt count = 0
        }

        let mut cursor = Cursor::new(&bytes);
        let m = DidMapper::read_le(&mut cursor).expect("parse");
        assert_eq!(m.id, 0x25000000);
        assert!(m.client_enum_to_id.is_empty());
        assert!(m.client_enum_to_name.is_empty());
        assert!(m.server_enum_to_id.is_empty());
        assert!(m.server_enum_to_name.is_empty());
        assert_eq!(cursor.position() as usize, bytes.len(), "no leftover bytes");
    }
}
