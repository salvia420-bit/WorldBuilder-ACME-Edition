//! AC NameFilterTable (file ID `0x0E000020`, a Table 0x0E-prefixed
//! record) — per-language rules for validating player/creature names
//! (vowel-run limits, allowed extra characters, compound-letter groups).
//!
//! Format (mirrors `ACE.DatLoader/FileTypes/NameFilterTable.cs::Unpack`
//! plus `Entity/NameFilterLanguageData.cs::Unpack`):
//! ```text
//! [u32 id]
//! [u8  total_objects]               // read as a byte (then widened)
//! [u8  table_size]                  // ignored
//! ( [u32 key]                       // language key
//!   [u32 maximum_vowels_in_a_row]
//!   [u32 first_n_characters_must_have_a_vowel]
//!   [u32 vowel_containing_substring_length]
//!   [u32 extra_allowed_characters]
//!   [u8  unknown]
//!   [u32 num_letter_groups]
//!   ( <unicode string> ) * num_letter_groups
//! ) * total_objects
//! ```
//!
//! Each compound-letter group is a `ReadUnicodeString`: a compressed-u32
//! length followed by that many UTF-16LE code units. Read-only; no write
//! path.

use crate::utils::read_compressed_u32;
use crate::{EOR_PORTAL_NAMESPACE, ResourceKey, StaticResourceKey};
use binrw::{BinRead, BinResult};
use std::collections::HashMap;
use std::io::{Read, Seek};

/// Well-known DAT file ID for the NameFilterTable.
pub const FILE_ID: u32 = 0x0E00_0020;

#[derive(Debug, Clone, serde::Serialize)]
pub struct NameFilterLanguageData {
    pub maximum_vowels_in_a_row: u32,
    pub first_n_characters_must_have_a_vowel: u32,
    pub vowel_containing_substring_length: u32,
    pub extra_allowed_characters: u32,
    pub unknown: u8,
    pub compound_letter_groups: Vec<String>,
}

impl NameFilterLanguageData {
    fn read_internal<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let maximum_vowels_in_a_row = u32::read_le(reader)?;
        let first_n_characters_must_have_a_vowel = u32::read_le(reader)?;
        let vowel_containing_substring_length = u32::read_le(reader)?;
        let extra_allowed_characters = u32::read_le(reader)?;
        let unknown = u8::read_le(reader)?;

        // melt `NameFilterLanguageData.cs` line 25 reads this group count as a
        // PLAIN little-endian u32 (`reader.ReadUInt32()`), NOT a compressed-u32.
        // Only the inner per-string length (read_unicode_string) is compressed.
        let num_letter_groups = u32::read_le(reader)? as usize;
        let mut compound_letter_groups = Vec::with_capacity(num_letter_groups);
        for _ in 0..num_letter_groups {
            compound_letter_groups.push(read_unicode_string(reader)?);
        }

        Ok(Self {
            maximum_vowels_in_a_row,
            first_n_characters_must_have_a_vowel,
            vowel_containing_substring_length,
            extra_allowed_characters,
            unknown,
            compound_letter_groups,
        })
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct NameFilterTable {
    pub id: u32,
    /// Keyed by language key.
    pub language_data: HashMap<u32, NameFilterLanguageData>,
}

impl NameFilterTable {
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
        let total_objects = u8::read_le(reader)? as usize;
        let _table_size = u8::read_le(reader)?;
        let mut language_data = HashMap::with_capacity(total_objects);
        for _ in 0..total_objects {
            let key = u32::read_le(reader)?;
            let val = NameFilterLanguageData::read_internal(reader)?;
            language_data.insert(key, val);
        }
        Ok(Self { id, language_data })
    }
}

impl StaticResourceKey for NameFilterTable {
    const RESOURCE_KEY: ResourceKey<'static> =
        ResourceKey::new(EOR_PORTAL_NAMESPACE, Self::FILE_ID);
}

impl BinRead for NameFilterTable {
    type Args<'a> = ();

    fn read_options<R: Read + Seek>(
        reader: &mut R,
        _endian: binrw::Endian,
        _args: Self::Args<'_>,
    ) -> BinResult<Self> {
        Self::read_internal(reader)
    }
}

/// Mirrors `BinaryReaderExtensions.ReadUnicodeString`: a compressed-u32
/// length, then that many UTF-16LE code units decoded to a `String`.
fn read_unicode_string<R: Read + Seek>(reader: &mut R) -> BinResult<String> {
    let len = read_compressed_u32(reader)? as usize;
    let mut units = Vec::with_capacity(len);
    for _ in 0..len {
        units.push(u16::read_le(reader)?);
    }
    // The retail strings are restricted to the BMP; lossy decode mirrors
    // the C# `Convert.ToChar(ushort)` per-unit behaviour for any stray
    // surrogate halves.
    Ok(String::from_utf16_lossy(&units))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn push_unicode_string(buf: &mut Vec<u8>, s: &str) {
        let units: Vec<u16> = s.encode_utf16().collect();
        assert!(units.len() < 0x80); // single-byte compressed length
        buf.push(units.len() as u8);
        for u in units {
            buf.extend_from_slice(&u.to_le_bytes());
        }
    }

    #[test]
    fn unpacks_name_filter_table() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&FILE_ID.to_le_bytes()); // id
        buf.push(1); // total_objects
        buf.push(0); // table_size (ignored)

        buf.extend_from_slice(&0x0000_0001u32.to_le_bytes()); // key (language)
        buf.extend_from_slice(&3u32.to_le_bytes()); // maximum_vowels_in_a_row
        buf.extend_from_slice(&4u32.to_le_bytes()); // first_n_characters_must_have_a_vowel
        buf.extend_from_slice(&2u32.to_le_bytes()); // vowel_containing_substring_length
        buf.extend_from_slice(&0x20u32.to_le_bytes()); // extra_allowed_characters
        buf.push(7); // unknown
        buf.extend_from_slice(&2u32.to_le_bytes()); // num_letter_groups (plain u32)
        push_unicode_string(&mut buf, "ch");
        push_unicode_string(&mut buf, "th");

        let nft = NameFilterTable::unpack(&buf).unwrap();
        assert_eq!(nft.id, FILE_ID);
        assert_eq!(nft.language_data.len(), 1);
        let ld = nft.language_data.get(&1).unwrap();
        assert_eq!(ld.maximum_vowels_in_a_row, 3);
        assert_eq!(ld.first_n_characters_must_have_a_vowel, 4);
        assert_eq!(ld.vowel_containing_substring_length, 2);
        assert_eq!(ld.extra_allowed_characters, 0x20);
        assert_eq!(ld.unknown, 7);
        assert_eq!(
            ld.compound_letter_groups,
            vec!["ch".to_string(), "th".to_string()]
        );
    }

    #[test]
    fn unpacks_empty_name_filter_table() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&FILE_ID.to_le_bytes());
        buf.push(0); // total_objects
        buf.push(0); // table_size
        let nft = NameFilterTable::unpack(&buf).unwrap();
        assert!(nft.language_data.is_empty());
    }

    #[test]
    fn resource_key_uses_portal_namespace() {
        assert_eq!(NameFilterTable::RESOURCE_KEY.namespace, EOR_PORTAL_NAMESPACE);
        assert_eq!(NameFilterTable::RESOURCE_KEY.file_id, FILE_ID);
    }
}
