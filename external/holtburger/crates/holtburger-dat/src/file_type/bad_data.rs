//! AC BadData (file ID `0x0E00001A`, a Table 0x0E-prefixed record) — a
//! map of WCIDs that are "bad" and should not exist. The value is always
//! 1 (likely a bool).
//!
//! Format (mirrors `ACE.DatLoader/FileTypes/BadData.cs::Unpack` plus the
//! `Dictionary<uint, uint>.UnpackPackedHashTable` extension):
//! ```text
//! [u32 id]
//! [u16 total_objects]
//! [u16 bucket_size]                 // C# ignores this
//! ( [u32 key] [u32 value] ) * total_objects
//! ```
//!
//! Read-only; no write path.

use crate::{EOR_PORTAL_NAMESPACE, ResourceKey, StaticResourceKey};
use binrw::{BinRead, BinResult};
use std::collections::HashMap;
use std::io::{Read, Seek};

/// Well-known DAT file ID for the BadData table.
pub const FILE_ID: u32 = 0x0E00_001A;

#[derive(Debug, Clone, serde::Serialize)]
pub struct BadData {
    pub id: u32,
    /// Map of "bad" WCID -> value (always 1 in retail data).
    pub bad: HashMap<u32, u32>,
}

impl BadData {
    pub const FILE_ID: u32 = FILE_ID;

    pub fn read<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        Self::read_internal(reader)
    }

    pub fn unpack(data: &[u8]) -> Result<Self, binrw::Error> {
        let mut cursor = std::io::Cursor::new(data);
        Self::read_internal(&mut cursor)
    }

    fn read_internal<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let id = u32::read_le(reader)?;
        let bad = parse_packed_hash_table(reader)?;
        Ok(Self { id, bad })
    }

    /// `true` if `wcid` is flagged as bad.
    pub fn is_bad(&self, wcid: u32) -> bool {
        self.bad.contains_key(&wcid)
    }
}

impl StaticResourceKey for BadData {
    const RESOURCE_KEY: ResourceKey<'static> =
        ResourceKey::new(EOR_PORTAL_NAMESPACE, Self::FILE_ID);
}

impl BinRead for BadData {
    type Args<'a> = ();

    fn read_options<R: Read + Seek>(
        reader: &mut R,
        _endian: binrw::Endian,
        _args: Self::Args<'_>,
    ) -> BinResult<Self> {
        Self::read_internal(reader)
    }
}

/// Mirrors `Dictionary<uint, uint>.UnpackPackedHashTable`: a u16 length,
/// a u16 bucket size (ignored), then `length` (u32 key, u32 value) pairs.
fn parse_packed_hash_table<R: Read + Seek>(reader: &mut R) -> BinResult<HashMap<u32, u32>> {
    let total_objects = u16::read_le(reader)? as usize;
    let _bucket_size = u16::read_le(reader)?;
    let mut out = HashMap::with_capacity(total_objects);
    for _ in 0..total_objects {
        let key = u32::read_le(reader)?;
        let value = u32::read_le(reader)?;
        out.insert(key, value);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpacks_bad_data_table() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&FILE_ID.to_le_bytes());
        buf.extend_from_slice(&2u16.to_le_bytes()); // total_objects
        buf.extend_from_slice(&8u16.to_le_bytes()); // bucket_size (ignored)
        buf.extend_from_slice(&0x0000_1000u32.to_le_bytes());
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&0x0000_2000u32.to_le_bytes());
        buf.extend_from_slice(&1u32.to_le_bytes());

        let bd = BadData::unpack(&buf).unwrap();
        assert_eq!(bd.id, FILE_ID);
        assert_eq!(bd.bad.len(), 2);
        assert_eq!(bd.bad.get(&0x0000_1000), Some(&1));
        assert_eq!(bd.bad.get(&0x0000_2000), Some(&1));
        assert!(bd.is_bad(0x0000_1000));
        assert!(!bd.is_bad(0x9999_9999));
    }

    #[test]
    fn unpacks_empty_bad_data_table() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&FILE_ID.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        let bd = BadData::unpack(&buf).unwrap();
        assert!(bd.bad.is_empty());
    }

    #[test]
    fn resource_key_uses_portal_namespace() {
        assert_eq!(BadData::RESOURCE_KEY.namespace, EOR_PORTAL_NAMESPACE);
        assert_eq!(BadData::RESOURCE_KEY.file_id, FILE_ID);
    }
}
