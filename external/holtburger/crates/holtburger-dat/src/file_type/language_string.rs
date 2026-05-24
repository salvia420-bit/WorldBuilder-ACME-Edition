//! LanguageString (DAT type 0x31, ID range `0x31000000..=0x3100FFFF`).
//!
//! Free-form locale text record — a single Windows-1252 string used
//! for tooltips, dialog snippets, and other UI text bound to a string
//! ID rather than to a `StringTable`. DRW dats.xml calls this
//! `DB_TYPE_STRING in the client` (DRW class `LanguageString`).
//!
//! Wire layout:
//!
//! ```text
//!   u32              id                  (DBObjHeaderFlags.HasId)
//!   CompressedUInt   value_byte_length
//!   bytes[value_byte_length]             (Windows-1252)
//! ```
//!
//! Real-record cross-check: LanguageString 0x31000010 is 129 bytes:
//! 4 (id) + 1 (compressed-uint = 0x7C = 124) + 124 bytes of text
//! decoding to `"Sho men's names have the surname first, ..."` — the
//! same text DRW's own EOR test asserts on (FontTests / LanguageStringTests).

use crate::utils::read_compressed_u32;
use binrw::BinRead;
use binrw::io::{Read, Seek};

#[derive(Debug, Clone, serde::Serialize)]
pub struct LanguageString {
    pub id: u32,
    /// Decoded text. Source bytes are Windows-1252; decoded with
    /// replacement-substitution (encoding_rs::WINDOWS_1252) so that no
    /// retail record fails to parse just because of a stray byte.
    pub value: String,
}

impl LanguageString {
    /// Parse a LanguageString record from raw bytes. Mirrors the
    /// `Font::unpack` / `Texture::unpack` pattern so wasm-side callers
    /// don't take a direct `binrw` dependency.
    pub fn unpack(data: &[u8]) -> binrw::BinResult<Self> {
        let mut cursor = binrw::io::Cursor::new(data);
        <Self as binrw::BinRead>::read_options(&mut cursor, binrw::Endian::Little, ())
    }
}

impl BinRead for LanguageString {
    type Args<'a> = ();

    fn read_options<R: Read + Seek>(
        reader: &mut R,
        endian: binrw::Endian,
        _: Self::Args<'_>,
    ) -> binrw::BinResult<Self> {
        if endian != binrw::Endian::Little {
            return Err(binrw::Error::AssertFail {
                pos: reader.stream_position().unwrap_or(0),
                message: "LanguageString is little-endian only".to_string(),
            });
        }

        let id = u32::read_le(reader)?;
        let len = read_compressed_u32(reader)? as usize;
        let mut buf = vec![0u8; len];
        reader.read_exact(&mut buf)?;
        let (value, _, _) = encoding_rs::WINDOWS_1252.decode(&buf);

        Ok(Self {
            id,
            value: value.into_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use binrw::io::Cursor;

    /// Hand-built fixture matching the on-disk shape of
    /// LanguageString 0x31000010 — a known retail record. If anything
    /// about the compressed-length / Windows-1252 path breaks, this
    /// fires before the real-DAT parity test even runs.
    fn fixture_0x31000010() -> Vec<u8> {
        let text = b"Sho men's names have the surname first, and the \"first name\" last. \
                     Examples: Ninwa Xaojhen, Fenping Banli-Zan, Shui Chon-Po.";
        assert_eq!(text.len(), 124, "fixture text must be 124 bytes");
        let mut out = Vec::with_capacity(4 + 1 + 124);
        out.extend_from_slice(&0x31000010u32.to_le_bytes());
        out.push(0x7C); // compressed-uint single-byte form for 124
        out.extend_from_slice(text);
        out
    }

    #[test]
    fn language_string_parses_known_retail_record() {
        let bytes = fixture_0x31000010();
        assert_eq!(bytes.len(), 129);

        let mut cursor = Cursor::new(&bytes);
        let ls = LanguageString::read_le(&mut cursor).expect("parse 0x31000010");
        assert_eq!(ls.id, 0x31000010);
        assert!(ls.value.starts_with("Sho men's names"));
        assert!(ls.value.ends_with("Shui Chon-Po."));
        assert_eq!(ls.value.len(), 124);
    }
}
