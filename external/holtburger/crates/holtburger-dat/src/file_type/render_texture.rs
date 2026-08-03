//! AC RenderTexture (DatFileType 0x15) — references to the textures used
//! by the client DebugConsole. Stored in `client_portal.dat` under file
//! IDs starting with `0x15` (e.g. `0x15000000` =
//! `ConsoleOutputBackgroundTexture`, `0x15000001` =
//! `ConsoleInputBackgroundTexture`, as defined in DidMapper.UNIQUEDB
//! `0x25000002`).
//!
//! Format (mirrors `ACE.DatLoader/FileTypes/RenderTexture.cs::Unpack` —
//! byte-for-byte identical to [`super::surface_texture::SurfaceTexture`]):
//! ```text
//! [u32 id]
//! [i32 unknown]
//! [u8  unknown_byte]
//! [i32 count]               // List<uint>.Unpack uses an Int32 length
//! [u32 texture_id] * count  // each is a Surface (0x06) entry
//! ```

use binrw::{BinRead, BinResult, BinWrite, binread};
use std::io::{Read, Seek, Write};

#[binread]
#[derive(Debug, Clone, serde::Serialize)]
#[br(little)]
pub struct RenderTexture {
    pub id: u32,
    pub unknown: i32,
    pub unknown_byte: u8,
    #[br(parse_with = parse_texture_ids)]
    pub textures: Vec<u32>,
}

impl RenderTexture {
    pub fn unpack(data: &[u8]) -> Result<Self, binrw::Error> {
        let mut cursor = std::io::Cursor::new(data);
        Self::read(&mut cursor)
    }

    /// First referenced Surface (0x06) ID, if any.
    pub fn first_texture(&self) -> Option<u32> {
        self.textures.first().copied()
    }

    /// Serialize this RenderTexture back into the canonical DAT body layout —
    /// `[u32 id][i32 unknown][u8 unknown_byte][i32 count][u32 texture_id]*count`
    /// — the exact inverse of [`RenderTexture::unpack`] / [`parse_texture_ids`].
    /// The texture-id count is derived from `textures.len()` (written as an
    /// `i32`, matching the read side) so `unpack(pack(x)) == x` holds
    /// byte-for-byte.
    pub fn write<W: Write + Seek>(&self, writer: &mut W) -> BinResult<()> {
        self.id.write_le(writer)?;
        self.unknown.write_le(writer)?;
        self.unknown_byte.write_le(writer)?;
        let count = i32::try_from(self.textures.len()).map_err(|e| binrw::Error::Custom {
            pos: writer.stream_position().unwrap_or(0),
            err: Box::new(e),
        })?;
        count.write_le(writer)?;
        for &texture_id in &self.textures {
            texture_id.write_le(writer)?;
        }
        Ok(())
    }

    /// Pack into a freshly allocated `Vec<u8>` — for byte-equal round-trip
    /// parity against retail RenderTextures.
    pub fn pack(&self) -> Result<Vec<u8>, binrw::Error> {
        let mut buf = std::io::Cursor::new(Vec::new());
        self.write(&mut buf)?;
        Ok(buf.into_inner())
    }
}

fn parse_texture_ids<R: Read + Seek>(
    reader: &mut R,
    _endian: binrw::Endian,
    _args: (),
) -> BinResult<Vec<u32>> {
    // List<uint>.Unpack reads an Int32 count, then that many u32 entries.
    // Rust review 2026-08-03 (F5): see `file_type/palette.rs` — negative count
    // sign-extended into `with_capacity`.
    let count = i32::read_le(reader)?.max(0) as usize;
    let mut out = Vec::with_capacity(crate::utils::safe_capacity(reader, count, 4)?);
    for _ in 0..count {
        out.push(u32::read_le(reader)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack(id: u32, unknown: i32, unknown_byte: u8, textures: &[u32]) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&id.to_le_bytes());
        buf.extend_from_slice(&unknown.to_le_bytes());
        buf.push(unknown_byte);
        buf.extend_from_slice(&(textures.len() as i32).to_le_bytes());
        for t in textures {
            buf.extend_from_slice(&t.to_le_bytes());
        }
        buf
    }

    #[test]
    fn unpacks_console_render_texture() {
        // 0x15000000 = ConsoleOutputBackgroundTexture, referencing two
        // Surface (0x06) entries.
        let buf = pack(0x15000000, 0, 1, &[0x06001234, 0x06001235]);
        let rt = RenderTexture::unpack(&buf).unwrap();
        assert_eq!(rt.id, 0x15000000);
        assert_eq!(rt.unknown, 0);
        assert_eq!(rt.unknown_byte, 1);
        assert_eq!(rt.textures, vec![0x06001234, 0x06001235]);
        assert_eq!(rt.first_texture(), Some(0x06001234));
    }

    #[test]
    fn unpacks_empty_texture_list() {
        let buf = pack(0x15000001, -1, 0, &[]);
        assert_eq!(buf.len(), 4 + 4 + 1 + 4);
        let rt = RenderTexture::unpack(&buf).unwrap();
        assert_eq!(rt.id, 0x15000001);
        assert_eq!(rt.unknown, -1);
        assert!(rt.textures.is_empty());
        assert_eq!(rt.first_texture(), None);
    }

    #[test]
    fn write_pack_is_exact_inverse_of_unpack() {
        let buf = pack(0x15000000, 0, 1, &[0x06001234, 0x06001235]);
        let rt = RenderTexture::unpack(&buf).unwrap();
        let packed = RenderTexture::pack(&rt).unwrap();
        assert_eq!(packed, buf, "pack must be the exact byte inverse of unpack");
        let reparsed = RenderTexture::unpack(&packed).unwrap();
        assert_eq!(reparsed.id, rt.id);
        assert_eq!(reparsed.unknown, rt.unknown);
        assert_eq!(reparsed.unknown_byte, rt.unknown_byte);
        assert_eq!(reparsed.textures, rt.textures);
    }
}
