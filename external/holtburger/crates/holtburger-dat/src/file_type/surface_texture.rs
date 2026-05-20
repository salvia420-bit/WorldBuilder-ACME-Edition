//! AC SurfaceTexture (DatFileType 0x05) — a list of mip-level [`Texture`]
//! IDs for one logical "skin". The terrain-atlas pipeline takes the
//! highest-res mip (last entry in `textures`).
//!
//! Format: `[u32 id][i32 unknown][u8 unknown_byte][i32 count][u32 texture_id]*count`.

use binrw::{BinRead, BinResult, binread};
use std::io::{Read, Seek};

#[binread]
#[derive(Debug, Clone, serde::Serialize)]
#[br(little)]
pub struct SurfaceTexture {
    pub id: u32,
    pub unknown_int: i32,
    pub unknown_byte: u8,
    #[br(parse_with = parse_texture_ids)]
    pub textures: Vec<u32>,
}

impl SurfaceTexture {
    pub fn unpack(data: &[u8]) -> Result<Self, binrw::Error> {
        let mut cursor = std::io::Cursor::new(data);
        Self::read(&mut cursor)
    }

    /// Highest-resolution mip-level (last entry). Returns `None` for an
    /// empty texture list.
    pub fn highest_res(&self) -> Option<u32> {
        self.textures.last().copied()
    }
}

fn parse_texture_ids<R: Read + Seek>(
    reader: &mut R,
    _endian: binrw::Endian,
    _args: (),
) -> BinResult<Vec<u32>> {
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

    #[test]
    fn unpacks_minimal_surface_texture() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x05001234u32.to_le_bytes()); // id
        buf.extend_from_slice(&0i32.to_le_bytes()); // unknown_int
        buf.push(0); // unknown_byte
        buf.extend_from_slice(&3i32.to_le_bytes()); // count
        buf.extend_from_slice(&0x06001000u32.to_le_bytes()); // mip 0
        buf.extend_from_slice(&0x06001001u32.to_le_bytes()); // mip 1
        buf.extend_from_slice(&0x06001002u32.to_le_bytes()); // mip 2 (highest-res)

        let st = SurfaceTexture::unpack(&buf).unwrap();
        assert_eq!(st.id, 0x05001234);
        assert_eq!(st.textures.len(), 3);
        assert_eq!(st.highest_res(), Some(0x06001002));
    }
}
