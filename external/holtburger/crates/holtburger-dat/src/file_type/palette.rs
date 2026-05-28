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

    /// Splice a contiguous range of colours from `src` into `self`, matching
    /// retail `Palette::Modify` (acclient.c, `?Modify@Palette@@...`): for each
    /// `i` in `[offset, offset + count)`, `self.colors[i] = src.colors[i]` —
    /// source and destination share the **same absolute index**. The whole
    /// splice is rejected (no-op) when the range would exceed either palette's
    /// length, mirroring the canonical guard `offset + numcolors <= num_colors`
    /// (which rejects wholesale rather than clamping).
    ///
    /// Callers must translate their wire/asset representation into absolute
    /// `(offset, count)` first:
    /// - Wire ObjDesc sub-palettes pack offset/numColors as `/8` bytes
    ///   (`Subpalette::UnPack`: `offset = byte*8`, `numColors = (byte==0?256:byte)*8`).
    /// - ClothingTable `CloSubPaletteRange` offset/numColors are already
    ///   absolute (`ClothingTable::BuildObjDesc` copies them raw).
    pub fn splice_from(&mut self, src: &Palette, offset: usize, count: usize) {
        let Some(end) = offset.checked_add(count) else { return; };
        if end > self.colors.len() || end > src.colors.len() {
            return;
        }
        self.colors[offset..end].copy_from_slice(&src.colors[offset..end]);
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

    fn pal(colors: Vec<u32>) -> Palette {
        Palette { id: 0, colors }
    }

    #[test]
    fn splice_copies_absolute_range_dst_eq_src_index() {
        // Canonical Palette::Modify: dst[i] = src[i] for i in [offset, offset+count).
        // Source is read at the SAME absolute index as the destination — not
        // from index 0 of the replacement palette.
        let mut base = pal(vec![0; 8]);
        let src = pal((0..8u32).map(|i| 0xFF00_0000 | i).collect()); // [0..7] tagged
        base.splice_from(&src, 4, 2);
        // Only indices 4 and 5 change, and they take src[4], src[5] (NOT src[0], src[1]).
        assert_eq!(
            base.colors,
            vec![0, 0, 0, 0, 0xFF00_0004, 0xFF00_0005, 0, 0]
        );
    }

    #[test]
    fn splice_offset_zero() {
        let mut base = pal(vec![0xAAAA_AAAA; 4]);
        let src = pal(vec![1, 2, 3, 4]);
        base.splice_from(&src, 0, 3);
        assert_eq!(base.colors, vec![1, 2, 3, 0xAAAA_AAAA]);
    }

    #[test]
    fn splice_rejects_out_of_range_wholesale() {
        // acclient guard: offset + numcolors > num_colors → reject (no partial write).
        let mut base = pal(vec![9, 9, 9, 9]);
        base.splice_from(&pal(vec![1, 2, 3, 4, 5, 6]), 2, 4); // 2+4=6 > dst len 4
        assert_eq!(base.colors, vec![9, 9, 9, 9], "out-of-range splice must be a no-op");
        // Also reject when the source is too short for the absolute range.
        let mut base2 = pal(vec![9; 8]);
        base2.splice_from(&pal(vec![1, 2, 3]), 4, 2); // needs src[4..6], src len 3
        assert_eq!(base2.colors, vec![9; 8], "short-source splice must be a no-op");
    }

    #[test]
    fn splice_wire_path_x8_scaling_indices() {
        // Wire ObjDesc byte offset=8, numColors byte=1 → absolute off=64, count=8.
        // Verify the helper writes exactly [64, 72) from the same src indices.
        let mut base = pal(vec![0u32; 2048]);
        let src = pal((0..2048u32).collect());
        let off = 8usize * 8; // byte * 8
        let count = 1usize * 8; // byte * 8
        base.splice_from(&src, off, count);
        for i in 0..2048usize {
            let expect = if (64..72).contains(&i) { i as u32 } else { 0 };
            assert_eq!(base.colors[i], expect, "mismatch at {i}");
        }
    }
}
