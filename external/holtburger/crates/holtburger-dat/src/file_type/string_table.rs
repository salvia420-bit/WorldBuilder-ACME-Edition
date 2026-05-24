//! StringTable (DAT type 0x23, ID range `0x23000000..=0x24FFFFFF`).
//!
//! Per-locale string lookup. Each entry is a hashed string ID
//! (`u32` key) → `StringTableString` (UTF-16 text with up to N
//! variants for substitution + optional named variable list). DRW
//! `dats.xml` flags it `DB_TYPE_STRING_TABLE`; vitaeum's
//! `string_tables: 15` count matches the 15 retail records in
//! `client_local_English.dat`.
//!
//! Wire layout (DRW `StringTable` + `StringTableString` schemas):
//!
//! ```text
//!   u32                   id                  (DBObjHeaderFlags.HasId)
//!   u32                   language             (always 1 in retail-EN)
//!   HashTable<u32, StringTableString>          strings
//!
//!   // AC HashTable header is u8 bucket_size_index + CompressedUInt
//!   // count + entries inline (no per-bucket framing on the wire).
//!
//!   StringTableString:
//!     u32             data_id           // QualifiedDataId<StringTable>
//!     u32             num_strings
//!     [PString<u16>;  num_strings]
//!     u32             num_variables
//!     [u32;           num_variables]
//!     u8              is_var_name_table_worth_packing
//!
//!   PString<u16> = CompressedUInt length + length * u16 (UTF-16)
//! ```
//!
//! Real-record cross-check: StringTable 0x2300000A in
//! client_local_English.dat is 80 bytes — id + language=1 + a 2-entry
//! HashTable whose values decode to "Left Alt" (key 0x014152D5) and
//! "Left Ctrl" (key 0x04CD833C). Both entries have num_strings=1 and
//! num_variables=0.

use crate::utils::read_compressed_u32;
use binrw::BinRead;
use binrw::io::{Read, Seek};
use std::collections::HashMap;

/// One entry in a [`StringTable`]. The `strings` vector holds one or
/// more variants of the same logical string; clients typically pick the
/// first. `variables` holds optional named-substitution slot indices.
#[derive(Debug, Clone, serde::Serialize)]
pub struct StringTableString {
    /// QualifiedDataId<StringTable> — the StringTable this entry
    /// belongs to, repeated here. 0 in self-contained tables.
    pub data_id: u32,
    pub strings: Vec<String>,
    pub variables: Vec<u32>,
    pub is_var_name_table_worth_packing: bool,
}

impl BinRead for StringTableString {
    type Args<'a> = ();

    fn read_options<R: Read + Seek>(
        reader: &mut R,
        _endian: binrw::Endian,
        _: Self::Args<'_>,
    ) -> binrw::BinResult<Self> {
        let data_id = u32::read_le(reader)?;
        let num_strings = u32::read_le(reader)?;
        let mut strings = Vec::with_capacity(num_strings as usize);
        for _ in 0..num_strings {
            strings.push(read_utf16_pstring(reader)?);
        }
        let num_variables = u32::read_le(reader)?;
        let mut variables = Vec::with_capacity(num_variables as usize);
        for _ in 0..num_variables {
            variables.push(u32::read_le(reader)?);
        }
        let is_var_name_table_worth_packing = u8::read(reader)? != 0;
        Ok(Self {
            data_id,
            strings,
            variables,
            is_var_name_table_worth_packing,
        })
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StringTable {
    pub id: u32,
    /// Locale code. Retail English DAT is always 1.
    pub language: u32,
    /// Hashed-string-id → entry. Sized to match the number of strings
    /// in the table (the wire HashTable bucket layout is purely a
    /// packing hint for the writer and is discarded on parse).
    pub strings: HashMap<u32, StringTableString>,
}

impl StringTable {
    /// Parse a StringTable record from raw bytes. Mirrors the
    /// `Texture::unpack` / `Font::unpack` pattern so wasm-side callers
    /// don't take a direct `binrw` dependency.
    pub fn unpack(data: &[u8]) -> binrw::BinResult<Self> {
        let mut cursor = binrw::io::Cursor::new(data);
        <Self as binrw::BinRead>::read_options(&mut cursor, binrw::Endian::Little, ())
    }
}

impl BinRead for StringTable {
    type Args<'a> = ();

    fn read_options<R: Read + Seek>(
        reader: &mut R,
        endian: binrw::Endian,
        _: Self::Args<'_>,
    ) -> binrw::BinResult<Self> {
        if endian != binrw::Endian::Little {
            return Err(binrw::Error::AssertFail {
                pos: reader.stream_position().unwrap_or(0),
                message: "StringTable is little-endian only".to_string(),
            });
        }

        let id = u32::read_le(reader)?;
        let language = u32::read_le(reader)?;

        // HashTable<u32, StringTableString>: u8 bucket_size_index +
        // CompressedUInt count + entries.
        let _bucket_size_index = u8::read(reader)?;
        let count = read_compressed_u32(reader)?;

        let mut strings = HashMap::with_capacity(count as usize);
        for _ in 0..count {
            let key = u32::read_le(reader)?;
            let value = StringTableString::read_le(reader)?;
            strings.insert(key, value);
        }

        Ok(Self {
            id,
            language,
            strings,
        })
    }
}

/// PStringBase<ushort> — CompressedUInt length + length × u16
/// codepoints. Decoded via `String::from_utf16_lossy` so a malformed
/// surrogate pair doesn't fail a parse.
fn read_utf16_pstring<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<String> {
    let len = read_compressed_u32(reader)? as usize;
    let mut codepoints = Vec::with_capacity(len);
    for _ in 0..len {
        codepoints.push(u16::read_le(reader)?);
    }
    Ok(String::from_utf16_lossy(&codepoints))
}

#[cfg(test)]
mod tests {
    use super::*;
    use binrw::io::Cursor;

    /// Full bytes of retail StringTable 0x2300000A — small enough
    /// (80 bytes) to embed inline. Decodes to two entries:
    ///   key 0x014152D5 → "Left Alt"
    ///   key 0x04CD833C → "Left Ctrl"
    const STRING_TABLE_0X2300000A: &[u8] = &[
        // header
        0x0A, 0x00, 0x00, 0x23, // id
        0x01, 0x00, 0x00, 0x00, // language = 1 (English)
        // HashTable header
        0x00, // bucket_size_index = 0
        0x02, // CompressedUInt count = 2
        // entry 0: key + StringTableString
        0xD5, 0x52, 0x41, 0x01, // key = 0x014152D5
        0x00, 0x00, 0x00, 0x00, // data_id = 0
        0x01, 0x00, 0x00, 0x00, // num_strings = 1
        0x08, // CompressedUInt len = 8
        b'L', 0x00, b'e', 0x00, b'f', 0x00, b't', 0x00, // "Left "
        b' ', 0x00, b'A', 0x00, b'l', 0x00, b't', 0x00, // "Alt"
        0x00, 0x00, 0x00, 0x00, // num_variables = 0
        0x00, // is_var_name_table_worth_packing = false
        // entry 1
        0x3C, 0x83, 0xCD, 0x04, // key = 0x04CD833C
        0x00, 0x00, 0x00, 0x00, // data_id = 0
        0x01, 0x00, 0x00, 0x00, // num_strings = 1
        0x09, // CompressedUInt len = 9
        b'L', 0x00, b'e', 0x00, b'f', 0x00, b't', 0x00, // "Left"
        b' ', 0x00, b'C', 0x00, b't', 0x00, b'r', 0x00, b'l', 0x00, // " Ctrl"
        0x00, 0x00, 0x00, 0x00, // num_variables = 0
        0x00, // is_var_name_table_worth_packing
    ];

    #[test]
    fn fixture_is_80_bytes() {
        assert_eq!(STRING_TABLE_0X2300000A.len(), 80);
    }

    #[test]
    fn string_table_decodes_known_record() {
        let mut cursor = Cursor::new(STRING_TABLE_0X2300000A);
        let table = StringTable::read_le(&mut cursor).expect("parse 0x2300000A");
        assert_eq!(table.id, 0x2300000A);
        assert_eq!(table.language, 1);
        assert_eq!(table.strings.len(), 2);

        let left_alt = table.strings.get(&0x014152D5).expect("Left Alt key");
        assert_eq!(left_alt.strings, vec!["Left Alt"]);
        assert!(left_alt.variables.is_empty());
        assert!(!left_alt.is_var_name_table_worth_packing);

        let left_ctrl = table.strings.get(&0x04CD833C).expect("Left Ctrl key");
        assert_eq!(left_ctrl.strings, vec!["Left Ctrl"]);
    }
}
