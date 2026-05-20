//! AC Palette (DatFileType 0x04) — a colour lookup table referenced by
//! palettized [`Texture`] records.
//!
//! Format: `[u32 id][i32 count][u32 colour]*count`. Each colour is ARGB
//! (most-significant byte = alpha). Per-pixel decode uses the index
//! from the palettized texture's source data to look up `colors[i]`.

use binrw::{BinRead, BinResult, binread};
use std::io::{Read, Seek};

#[binread]
#[derive(Debug, Clone, serde::Serialize)]
#[br(little)]
pub struct Palette {
    pub id: u32,
    #[br(parse_with = parse_colors)]
    pub colors: Vec<u32>,
}

impl Palette {
    pub fn unpack(data: &[u8]) -> Result<Self, binrw::Error> {
        let mut cursor = std::io::Cursor::new(data);
        Self::read(&mut cursor)
    }
}

fn parse_colors<R: Read + Seek>(
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
    fn unpacks_minimal_palette() {
        // id=0x04001234, count=3, colours=ARGB(white, red, green)
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x04001234u32.to_le_bytes());
        buf.extend_from_slice(&3i32.to_le_bytes());
        buf.extend_from_slice(&0xFFFFFFFFu32.to_le_bytes());
        buf.extend_from_slice(&0xFFFF0000u32.to_le_bytes());
        buf.extend_from_slice(&0xFF00FF00u32.to_le_bytes());

        let pal = Palette::unpack(&buf).unwrap();
        assert_eq!(pal.id, 0x04001234);
        assert_eq!(pal.colors, vec![0xFFFFFFFF, 0xFFFF0000, 0xFF00FF00]);
    }
}
