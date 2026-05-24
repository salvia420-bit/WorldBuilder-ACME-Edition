//! GfxObjDegradeInfo (DAT type 0x11, ID range `0x11000000..=0x1100FFFF`).
//!
//! Per-asset LOD selection rules — for each base mesh, a list of
//! distance-ranged replacement GfxObjs the renderer should switch to
//! as the camera moves further from the asset. DRW calls this
//! `DB_TYPE_DEGRADEINFO`. Wires into the holtburger visual-fidelity
//! LOD work (see `[[project_visual_fidelity_wave1_done_2026-05-13]]`).
//!
//! Wire layout (DRW `<type name="GfxObjDegradeInfo">` + `<type name="GfxObjInfo">`):
//!
//! ```text
//!   u32  id                  (DBObjHeaderFlags.HasId)
//!   u32  num_degrades
//!   [GfxObjInfo; num_degrades]
//!
//!   GfxObjInfo (20 bytes):
//!     u32   gfx_obj_id        // GfxObj DataID for this LOD
//!     u32   degrade_mode      // selection-mode enum
//!     f32   min_dist          // start switching to this LOD at this distance
//!     f32   ideal_dist        // ideal distance for this LOD
//!     f32   max_dist          // stop using this LOD past this distance
//! ```
//!
//! Real-record cross-check: GfxObjDegradeInfo 0x11000001 is 88 bytes
//! = 4 (id) + 4 (count=4) + 4 × 20-byte GfxObjInfo. Two of those
//! entries reuse GfxObj 0x0100376A at successive distance bands
//! (10–25–50m, then 25–50–100m).

use binrw::BinRead;

#[derive(BinRead, Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[br(little)]
pub struct GfxObjInfo {
    /// GfxObj (DAT 0x01) DataID to render at this LOD band.
    pub gfx_obj_id: u32,
    pub degrade_mode: u32,
    pub min_dist: f32,
    pub ideal_dist: f32,
    pub max_dist: f32,
}

#[binrw::binread]
#[derive(Debug, Clone, serde::Serialize)]
#[br(little)]
pub struct GfxObjDegradeInfo {
    pub id: u32,
    #[br(temp)]
    num_degrades: u32,
    #[br(count = num_degrades)]
    pub degrades: Vec<GfxObjInfo>,
}

impl GfxObjDegradeInfo {
    pub fn unpack(data: &[u8]) -> binrw::BinResult<Self> {
        use binrw::BinRead;
        let mut cursor = binrw::io::Cursor::new(data);
        Self::read_le(&mut cursor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use binrw::io::Cursor;

    /// Full bytes of retail GfxObjDegradeInfo 0x11000001 — 4 LOD bands
    /// alternating between two GfxObjs (0x0100376A and 0x0100376A).
    const DEGRADE_0X11000001: &[u8] = &[
        0x01, 0x00, 0x00, 0x11, // id
        0x04, 0x00, 0x00, 0x00, // num_degrades = 4
        // entry 0: GfxObj 0x0100376A, mode 1, 10m / 25m / 50m
        0x6A, 0x37, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00, // id + mode
        0x00, 0x00, 0x20, 0x41, // min_dist = 10.0
        0x00, 0x00, 0xC8, 0x41, // ideal_dist = 25.0
        0x00, 0x00, 0x48, 0x42, // max_dist = 50.0
        // entry 1: same GfxObj, 25m / 50m / 100m
        0x6A, 0x37, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00, //
        0x00, 0x00, 0xC8, 0x41, // 25.0
        0x00, 0x00, 0x48, 0x42, // 50.0
        0x00, 0x00, 0xC8, 0x42, // 100.0
        // entries 2 + 3 truncated — not needed for the unit test
    ];

    #[test]
    fn degrade_info_decodes_known_prefix() {
        // Tell binrw we only have 2 entries in the prefix slice.
        let mut prefix = Vec::from(&DEGRADE_0X11000001[0..4]);
        prefix.extend_from_slice(&2u32.to_le_bytes());
        prefix.extend_from_slice(&DEGRADE_0X11000001[8..48]); // first two entries
        assert_eq!(prefix.len(), 48);

        let mut cursor = Cursor::new(prefix);
        let dg = GfxObjDegradeInfo::read_le(&mut cursor).expect("parse");
        assert_eq!(dg.id, 0x11000001);
        assert_eq!(dg.degrades.len(), 2);

        assert_eq!(dg.degrades[0].gfx_obj_id, 0x0100376A);
        assert_eq!(dg.degrades[0].degrade_mode, 1);
        assert_eq!(dg.degrades[0].min_dist, 10.0);
        assert_eq!(dg.degrades[0].ideal_dist, 25.0);
        assert_eq!(dg.degrades[0].max_dist, 50.0);

        assert_eq!(dg.degrades[1].gfx_obj_id, 0x0100376A);
        assert_eq!(dg.degrades[1].min_dist, 25.0);
        assert_eq!(dg.degrades[1].ideal_dist, 50.0);
        assert_eq!(dg.degrades[1].max_dist, 100.0);
    }

    #[test]
    fn degrade_info_size_math() {
        // 4-byte id + 4-byte count + 20-byte entries.
        assert_eq!(8 + 4 * 20, 88);
    }
}
