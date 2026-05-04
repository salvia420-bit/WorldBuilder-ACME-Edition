use crate::Result;
use binrw::{BinRead, binread, io::Cursor};
use holtburger_common::{Quaternion, Vector3};
use std::collections::HashMap;

#[derive(BinRead, Debug, Clone)]
#[br(little)]
pub struct Frame {
    pub origin: Vector3,
    pub orientation: Quaternion,
}

#[derive(BinRead, Debug, Clone)]
#[br(little)]
pub struct Stab {
    pub id: u32,
    pub frame: Frame,
}

#[binread]
#[derive(Debug, Clone)]
#[br(little)]
pub struct BuildInfo {
    pub model_id: u32,
    pub frame: Frame,
    pub num_leaves: u32,
    #[br(temp)]
    pub num_portals: u16,
    #[br(count = num_portals)]
    pub portals: Vec<PortalInternal>,
}

#[binread]
#[derive(Debug, Clone)]
#[br(little)]
pub struct PortalInternal {
    pub flags: u16,
    pub other_cell_id: u16,
    pub other_portal_id: u16,
    #[br(temp)]
    pub num_stabs: u16,
    #[br(count = num_stabs)]
    pub stab_list: Vec<u16>,
    #[br(pad_after = (4 - ((8 + num_stabs as u64 * 2) % 4)) % 4)]
    pub _align: (),
}

#[derive(BinRead, Debug, Clone)]
#[br(little)]
pub struct CellLandblock {
    pub id: u32,
    pub has_objects: u32, // 1 if true
    #[br(count = 81)]
    pub terrain: Vec<u16>,
    #[br(count = 81)]
    pub height: Vec<u8>,
    #[br(pad_after = (4 - (8 + 81*2 + 81) % 4))]
    pub _align: (),
}

// Bit packing of `CellLandblock.terrain[i]`. Layout from upstream ACE
// `ACE.DatLoader/FileTypes/CellLandblock.cs` (corroborated by the
// DatReaderWriter `dats.xml` schema):
//
//   bits 0-1   road type (0..3; 0 = none)
//   bits 2-6   terrain type (0..31; one of the 32 base materials)
//   bits 7-10  unused
//   bits 11-15 scenery (0..31; per-vertex prop index into the region's scene table)
//
// The brief's hypothesis ("scenery in the low 5 bits") was inverted —
// scenery is in the *high* 5 bits. ACE source is authoritative.
pub const TERRAIN_MASK_ROAD: u16 = 0x0003;
pub const TERRAIN_SHIFT_ROAD: u16 = 0;
pub const TERRAIN_MASK_TYPE: u16 = 0x007C;
pub const TERRAIN_SHIFT_TYPE: u16 = 2;
pub const TERRAIN_MASK_SCENERY: u16 = 0xF800;
pub const TERRAIN_SHIFT_SCENERY: u16 = 11;

impl CellLandblock {
    pub fn unpack(data: &[u8]) -> Result<Self> {
        let mut cursor = Cursor::new(data);
        let lb = Self::read(&mut cursor)?;
        Ok(lb)
    }

    /// Returns height at (x, y) vertex in landblock [0, 8]
    pub fn get_height(&self, x: usize, y: usize) -> f32 {
        if x > 8 || y > 8 {
            return 0.0;
        }
        let idx = x * 9 + y;
        self.height[idx] as f32 * 2.0
    }

    /// Raw `terrain[]` u16 at vertex `(x, y)`. Out-of-range returns `0`.
    pub fn terrain_at(&self, x: usize, y: usize) -> u16 {
        if x > 8 || y > 8 {
            return 0;
        }
        self.terrain[x * 9 + y]
    }

    /// Base terrain type (0..31) at vertex `(x, y)` — index into the
    /// region's 32-entry surface table (Grassland, LushGrass, BarrenRock, …).
    pub fn terrain_type(&self, x: usize, y: usize) -> u8 {
        ((self.terrain_at(x, y) & TERRAIN_MASK_TYPE) >> TERRAIN_SHIFT_TYPE) as u8
    }

    /// Road overlay type (0..3) at vertex `(x, y)`. `0` = no road.
    pub fn road_type(&self, x: usize, y: usize) -> u8 {
        ((self.terrain_at(x, y) & TERRAIN_MASK_ROAD) >> TERRAIN_SHIFT_ROAD) as u8
    }

    /// Scenery prop index (0..31) at vertex `(x, y)`. `0` = no scenery.
    pub fn scenery(&self, x: usize, y: usize) -> u8 {
        ((self.terrain_at(x, y) & TERRAIN_MASK_SCENERY) >> TERRAIN_SHIFT_SCENERY) as u8
    }
}

#[binread]
#[derive(Debug, Clone)]
#[br(little)]
pub struct LandblockInfo {
    pub id: u32,
    pub num_cells: u32,
    #[br(temp)]
    pub num_objects: u32,
    #[br(count = num_objects)]
    pub objects: Vec<Stab>,
    #[br(temp)]
    pub num_buildings: u16,
    pub pack_mask: u16,
    #[br(count = num_buildings)]
    pub buildings: Vec<BuildInfo>,
    #[br(if(pack_mask & 1 != 0))]
    pub restriction_tables: Option<RestrictionTable>,
}

impl LandblockInfo {
    pub fn unpack(data: &[u8]) -> Result<Self> {
        let mut cursor = Cursor::new(data);
        let info = Self::read(&mut cursor)?;
        Ok(info)
    }
}

#[binread]
#[derive(Debug, Clone)]
#[br(little)]
pub struct RestrictionTable {
    #[br(temp)]
    pub count: u16,
    #[br(temp)]
    pub _bucket_size: u16,
    #[br(count = count)]
    #[br(map = |v: Vec<(u32, u32)>| v.into_iter().collect())]
    pub tables: HashMap<u32, u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell_with_terrain(values: [u16; 81]) -> CellLandblock {
        CellLandblock {
            id: 0xA9B4FFFF,
            has_objects: 0,
            terrain: values.to_vec(),
            height: vec![0; 81],
            _align: (),
        }
    }

    #[test]
    fn terrain_bit_decode_isolates_each_field() {
        // Hand-packed: road=2, type=0x1F (Snow → DesolateLands), scenery=0x15.
        //   road     = 0x0003 (bits 0-1)        = 2  →            0b00000_0000_00_10
        //   type     = 0x007C (bits 2-6)        = 31 →            0b00000_0000_11_11_1
        //   scenery  = 0xF800 (bits 11-15)      = 21 →            0b10101_0000_00_00_00
        //   combined u16 (lsb first):                              0b10101_0000_11_11_10 = 0xA87E
        let packed: u16 = (21 << 11) | (31 << 2) | 2;
        assert_eq!(packed, 0xA87E);
        let mut all = [0u16; 81];
        all[0] = packed;
        let cell = cell_with_terrain(all);
        assert_eq!(cell.road_type(0, 0), 2);
        assert_eq!(cell.terrain_type(0, 0), 31);
        assert_eq!(cell.scenery(0, 0), 21);
    }

    #[test]
    fn terrain_bit_decode_zero_is_no_road_no_scenery() {
        let cell = cell_with_terrain([0u16; 81]);
        for x in 0..9 {
            for y in 0..9 {
                assert_eq!(cell.road_type(x, y), 0);
                assert_eq!(cell.terrain_type(x, y), 0); // BarrenRock
                assert_eq!(cell.scenery(x, y), 0);
            }
        }
    }

    #[test]
    fn terrain_bit_decode_max_values_clamp_to_field_widths() {
        let mut all = [0u16; 81];
        all[40] = u16::MAX; // 0xFFFF — every bit set.
        let cell = cell_with_terrain(all);
        // road = bits 0-1 = 0b11 = 3
        assert_eq!(cell.road_type(4, 4), 3);
        // type = bits 2-6 = 0b11111 = 31
        assert_eq!(cell.terrain_type(4, 4), 31);
        // scenery = bits 11-15 = 0b11111 = 31
        assert_eq!(cell.scenery(4, 4), 31);
        // Bits 7-10 are unused; the helpers must mask them out so the
        // 0xFFFF input doesn't bleed into any field.
    }

    #[test]
    fn terrain_at_out_of_bounds_returns_zero() {
        let cell = cell_with_terrain([0xA87E; 81]);
        assert_eq!(cell.terrain_at(0, 0), 0xA87E);
        assert_eq!(cell.terrain_at(8, 8), 0xA87E);
        assert_eq!(cell.terrain_at(9, 0), 0); // x > 8
        assert_eq!(cell.terrain_at(0, 9), 0); // y > 8
        assert_eq!(cell.terrain_type(99, 99), 0);
    }
}
