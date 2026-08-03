//! AC SurfaceTexture (DatFileType 0x05) — a list of mip-level [`Texture`]
//! IDs for one logical "skin". The terrain-atlas pipeline takes the
//! highest-res mip (last entry in `textures`).
//!
//! Format: `[u32 id][i32 unknown][u8 unknown_byte][i32 count][u32 texture_id]*count`.

use binrw::{BinRead, BinResult, BinWrite, binread};
use std::io::{Read, Seek, Write};

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

    /// Serialize this SurfaceTexture back into the canonical DAT body layout —
    /// `[u32 id][i32 unknown_int][u8 unknown_byte][i32 count][u32 texture_id]*count`
    /// — the exact inverse of [`SurfaceTexture::unpack`] / [`parse_texture_ids`].
    /// The texture-id count is derived from `textures.len()` (written as an
    /// `i32`, matching the read side) so `unpack(pack(x)) == x` holds
    /// byte-for-byte.
    pub fn write<W: Write + Seek>(&self, writer: &mut W) -> BinResult<()> {
        self.id.write_le(writer)?;
        self.unknown_int.write_le(writer)?;
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
    /// parity against retail SurfaceTextures.
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
    // Rust review 2026-08-03 (F5): see `file_type/palette.rs` — negative count
    // sign-extended into `with_capacity`. This parser runs for EVERY rendered
    // surface, so one poisoned 0x05 record took down the renderer.
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

    #[test]
    fn pack_is_exact_inverse_of_unpack() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x05001234u32.to_le_bytes()); // id
        buf.extend_from_slice(&7i32.to_le_bytes()); // unknown_int
        buf.push(2); // unknown_byte
        buf.extend_from_slice(&3i32.to_le_bytes()); // count
        buf.extend_from_slice(&0x06001000u32.to_le_bytes());
        buf.extend_from_slice(&0x06001001u32.to_le_bytes());
        buf.extend_from_slice(&0x06001002u32.to_le_bytes());

        let st = SurfaceTexture::unpack(&buf).unwrap();
        let packed = st.pack().unwrap();
        assert_eq!(packed, buf, "pack must be the exact byte inverse of unpack");

        let reparsed = SurfaceTexture::unpack(&packed).unwrap();
        assert_eq!(reparsed.id, st.id);
        assert_eq!(reparsed.unknown_int, st.unknown_int);
        assert_eq!(reparsed.unknown_byte, st.unknown_byte);
        assert_eq!(reparsed.textures, st.textures);
        assert_eq!(reparsed.highest_res(), Some(0x06001002));
    }
}
