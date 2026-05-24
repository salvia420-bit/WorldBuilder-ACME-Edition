//! DualDidMapper (DAT type 0x27, ID range `0x27000000..=0x27FFFFFF`).
//!
//! **Byte-identical wire format to [`crate::file_type::DidMapper`]
//! (DAT 0x25)** — same 4-sub-table structure, same field order.
//! Different semantics: stores `(WeenieID, W_Class)` pairs (per ACE's
//! note, "the client uses these to track spell components etc.")
//! rather than the enum→DataID mapping that DidMapper holds.
//!
//! Retail has 5 records (0x27000000..0x27000004 — Materials, Gems,
//! SpellComponents, ComponentPacks, TradeNotes per ACE's comment).
//!
//! ACE has a separate `DualDidMapper.cs` class whose `Unpack` is a
//! verbatim copy of `DidMapper.cs::Unpack`. We follow the same
//! convention here (separate struct, doc-comment captures the
//! semantic difference) so consumers can pattern-match on the type.

use crate::utils::read_compressed_u32;
use binrw::io::Seek;
use std::collections::HashMap;
use std::io::Read;

#[derive(Debug, Clone, serde::Serialize)]
pub struct DualDidMapper {
    pub id: u32,

    pub client_id_numbering_type: u8,
    /// Per ACE: `(WeenieID, W_Class)` pairs (the `_id` field naming
    /// is preserved for layout-parity with DidMapper; semantically the
    /// value is a WClass not a DataID).
    pub client_enum_to_id: HashMap<u32, u32>,

    pub client_name_numbering_type: u8,
    pub client_enum_to_name: HashMap<u32, String>,

    pub server_id_numbering_type: u8,
    pub server_enum_to_id: HashMap<u32, u32>,

    pub server_name_numbering_type: u8,
    pub server_enum_to_name: HashMap<u32, String>,
}

impl DualDidMapper {
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
