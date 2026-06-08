//! AC TabooTable (file ID `0x0E00001E`, a Table 0x0E-prefixed record) —
//! the profanity / banned-word filter. Each entry's key is a 32-bit flag
//! (only one flag set per entry); in retail data every entry shares the
//! same banned-pattern list, so the flag is effectively unused.
//!
//! Format (mirrors `ACE.DatLoader/FileTypes/TabooTable.cs::Unpack` plus
//! the `Dictionary<uint, TabooTableEntry>.Unpack(reader, length)` fixed-
//! quantity extension and `Entity/TabooTableEntry.cs::Unpack`):
//! ```text
//! [u32 id]
//! [u8  unknown_x01]                 // always 0x01 in retail
//! [u8  length]                      // entry count
//! ( [u32 key]                       // flag
//!   [u32 unknown1]                  // always 0x00010101
//!   [u16 unknown2]                  // always 0
//!   [u32 pattern_count]
//!   ( <.NET BinaryReader string> ) * pattern_count
//! ) * length
//! ```
//!
//! Each banned pattern is a lower-case `[*]word[*]` glob (the asterisks
//! are optional anchors). Strings use the .NET `BinaryReader.ReadString`
//! encoding (7-bit-encoded length prefix + Windows-1252 bytes), read via
//! [`crate::utils::read_dotnet_string`]. Read-only; no write path.

use crate::utils::read_dotnet_string;
use crate::{EOR_PORTAL_NAMESPACE, ResourceKey, StaticResourceKey};
use binrw::{BinRead, BinResult};
use std::collections::HashMap;
use std::io::{Read, Seek};

/// Well-known DAT file ID for the TabooTable.
pub const FILE_ID: u32 = 0x0E00_001E;

#[derive(Debug, Clone, serde::Serialize)]
pub struct TabooTableEntry {
    /// Always `0x00010101` in retail.
    pub unknown1: u32,
    /// Always `0` in retail.
    pub unknown2: u16,
    /// Lower-case `[*]word[*]` glob patterns.
    pub banned_patterns: Vec<String>,
}

impl TabooTableEntry {
    fn read_internal<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let unknown1 = u32::read_le(reader)?;
        let unknown2 = u16::read_le(reader)?;
        let count = u32::read_le(reader)? as usize;
        let mut banned_patterns = Vec::with_capacity(count);
        for _ in 0..count {
            banned_patterns.push(read_dotnet_string(reader)?);
        }
        Ok(Self {
            unknown1,
            unknown2,
            banned_patterns,
        })
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TabooTable {
    pub id: u32,
    /// Keyed by the (single-bit) flag value of each entry.
    pub entries: HashMap<u32, TabooTableEntry>,
}

impl TabooTable {
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
        let _unknown_x01 = u8::read_le(reader)?;
        let length = u8::read_le(reader)? as usize;
        let mut entries = HashMap::with_capacity(length);
        for _ in 0..length {
            let key = u32::read_le(reader)?;
            let entry = TabooTableEntry::read_internal(reader)?;
            entries.insert(key, entry);
        }
        Ok(Self { id, entries })
    }
}

impl StaticResourceKey for TabooTable {
    const RESOURCE_KEY: ResourceKey<'static> =
        ResourceKey::new(EOR_PORTAL_NAMESPACE, Self::FILE_ID);
}

impl BinRead for TabooTable {
    type Args<'a> = ();

    fn read_options<R: Read + Seek>(
        reader: &mut R,
        _endian: binrw::Endian,
        _args: Self::Args<'_>,
    ) -> BinResult<Self> {
        Self::read_internal(reader)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Append a .NET `BinaryReader.ReadString`-encoded string (7-bit
    /// length prefix + Windows-1252 bytes). All our test strings are
    /// short (< 0x80), so a single length byte suffices.
    fn push_dotnet_string(buf: &mut Vec<u8>, s: &str) {
        assert!(s.len() < 0x80);
        buf.push(s.len() as u8);
        buf.extend_from_slice(s.as_bytes());
    }

    #[test]
    fn unpacks_single_entry_taboo_table() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&FILE_ID.to_le_bytes()); // id
        buf.push(0x01); // unknown_x01
        buf.push(1); // length (1 entry)

        buf.extend_from_slice(&0x0000_0001u32.to_le_bytes()); // key (flag)
        buf.extend_from_slice(&0x0001_0101u32.to_le_bytes()); // unknown1
        buf.extend_from_slice(&0u16.to_le_bytes()); // unknown2
        buf.extend_from_slice(&2u32.to_le_bytes()); // pattern_count
        push_dotnet_string(&mut buf, "*badword*");
        push_dotnet_string(&mut buf, "naughty");

        let tt = TabooTable::unpack(&buf).unwrap();
        assert_eq!(tt.id, FILE_ID);
        assert_eq!(tt.entries.len(), 1);
        let entry = tt.entries.get(&1).unwrap();
        assert_eq!(entry.unknown1, 0x0001_0101);
        assert_eq!(entry.unknown2, 0);
        assert_eq!(
            entry.banned_patterns,
            vec!["*badword*".to_string(), "naughty".to_string()]
        );
    }

    #[test]
    fn unpacks_empty_taboo_table() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&FILE_ID.to_le_bytes());
        buf.push(0x01);
        buf.push(0); // length = 0
        let tt = TabooTable::unpack(&buf).unwrap();
        assert!(tt.entries.is_empty());
    }

    #[test]
    fn resource_key_uses_portal_namespace() {
        assert_eq!(TabooTable::RESOURCE_KEY.namespace, EOR_PORTAL_NAMESPACE);
        assert_eq!(TabooTable::RESOURCE_KEY.file_id, FILE_ID);
    }
}
