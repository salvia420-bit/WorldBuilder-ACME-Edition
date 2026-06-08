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
//!
//! Read-only; no write path.

use binrw::{BinRead, BinResult, binread};
use std::io::{Read, Seek};

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
}

fn parse_texture_ids<R: Read + Seek>(
    reader: &mut R,
    _endian: binrw::Endian,
    _args: (),
) -> BinResult<Vec<u32>> {
    // List<uint>.Unpack reads an Int32 count, then that many u32 entries.
    let count = i32::read_le(reader)? as usize;
    let mut out = Vec::with_capacity(count);
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
}
