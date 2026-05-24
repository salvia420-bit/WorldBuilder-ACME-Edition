//! PaletteSet (DAT type 0x0F, ID range `0x0F000000..=0x0F00FFFF`).
//!
//! DRW calls this `PalSet` / `DB_TYPE_PAL_SET`. Just a list of
//! Palette (0x04) DataIDs that participate in a single
//! color-variant set — the per-variant overlays referenced by
//! `ClothingTable::ClothingSubPalEffects.CloSubPalette::palette_set`.
//!
//! Wire layout (DRW `<type name="PalSet">`):
//!
//! ```text
//!   u32  id                  (DBObjHeaderFlags.HasId)
//!   u32  num_palettes
//!   [u32; num_palettes]      // each is a Palette DataID
//! ```
//!
//! Real-record cross-check: PaletteSet 0x0F000001 is 24 bytes =
//! 4-byte id + 4-byte count(4) + 4 × 4-byte palette IDs
//! (0x040005F3, 0x040005F4, 0x040005F5, 0x040005F2).

#[allow(unused_imports)]
use binrw::BinRead;

#[binrw::binread]
#[derive(Debug, Clone, serde::Serialize)]
#[br(little)]
pub struct PaletteSet {
    pub id: u32,
    #[br(temp)]
    num_palettes: u32,
    #[br(count = num_palettes)]
    pub palettes: Vec<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use binrw::io::Cursor;

    const PALSET_0X0F000001: &[u8] = &[
        0x01, 0x00, 0x00, 0x0F, // id
        0x04, 0x00, 0x00, 0x00, // num_palettes = 4
        0xF3, 0x05, 0x00, 0x04, // 0x040005F3
        0xF4, 0x05, 0x00, 0x04, // 0x040005F4
        0xF5, 0x05, 0x00, 0x04, // 0x040005F5
        0xF2, 0x05, 0x00, 0x04, // 0x040005F2
    ];

    #[test]
    fn palset_decodes_known_record() {
        assert_eq!(PALSET_0X0F000001.len(), 24);
        let mut cursor = Cursor::new(PALSET_0X0F000001);
        let set = PaletteSet::read_le(&mut cursor).expect("parse");
        assert_eq!(set.id, 0x0F000001);
        assert_eq!(
            set.palettes,
            vec![0x040005F3, 0x040005F4, 0x040005F5, 0x040005F2]
        );
    }
}
