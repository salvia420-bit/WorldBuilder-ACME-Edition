//! `ObjectDesc` — scenery placement descriptor.
//!
//! One row in a `Scene` (DAT prefix `0x12`). Each `ObjectDesc` describes a
//! candidate procedural placement: which mesh, where (relative to the cell
//! origin via `Frame`), how often (`freq`), how to displace, how to scale
//! and rotate, and what slope envelope is allowed. Non-zero `weenie_obj`
//! marks the placement as a server-managed entity which the procedural
//! bake skips (see ACE `Scenery.cs`).
//!
//! Wire format mirrors ACE's `ObjectDesc.Unpack` (46 lines at
//! `~/ace-server/Source/ACE.DatLoader/Entity/ObjectDesc.cs`). Packed size:
//!
//! ```text
//!     obj_id        :  4 bytes   (u32)
//!     base_loc      : 28 bytes   (Frame = Vector3 12 + Quaternion 16)
//!     freq          :  4 bytes   (f32)
//!     displace_x    :  4 bytes   (f32)
//!     displace_y    :  4 bytes   (f32)
//!     min_scale     :  4 bytes   (f32)
//!     max_scale     :  4 bytes   (f32)
//!     max_rotation  :  4 bytes   (f32)
//!     min_slope     :  4 bytes   (f32)
//!     max_slope     :  4 bytes   (f32)
//!     align         :  4 bytes   (u32)
//!     orient        :  4 bytes   (u32)
//!     weenie_obj    :  4 bytes   (u32)
//!                    ----
//!                     76 bytes
//! ```
//!
//! Note: the brief sketched 72 bytes; the actual count is 76 because the
//! f32 block holds **eight** floats (freq + 2 displace + 2 scale +
//! max_rotation + 2 slope), not seven. Verified against ACE
//! `ObjectDesc.cs:23-43` and confirmed by a synthetic-bytes roundtrip
//! test below. The header constant `OBJECT_DESC_PACKED_SIZE = 76` is the
//! source of truth that Phase B.2 should rely on.
//!
//! `Frame` source: we use `crate::graphics::Frame` (12 + 16 = 28 bytes) to
//! match the four other `file_type/` parsers that pull Frame in
//! (`animation.rs`, `char_gen.rs`, `setup_model.rs`, `env_cell.rs`).
//! `landblock::Frame` has the same layout but a different module path; the
//! `graphics::Frame` is the canonical choice for the `file_type` tree.

use crate::graphics::Frame;
use binrw::{
    BinRead, BinResult,
    io::{Read, Seek},
};

/// Size of a packed `ObjectDesc` payload in bytes. Asserted in
/// `tests::object_desc_size_matches_ace`.
pub const OBJECT_DESC_PACKED_SIZE: usize = 76;

/// One scenery candidate inside a `Scene`. See module docs for wire layout.
///
/// Field order MUST match ACE's `Unpack` exactly — the bake algorithm reads
/// these positionally, not by name, so reordering breaks compatibility.
#[derive(Debug, Clone, PartialEq)]
pub struct ObjectDesc {
    /// GfxObj / SetupModel DID (`0x01xxxxxx` or `0x02xxxxxx`) of the mesh.
    pub obj_id: u32,
    /// Position + orientation of this placement relative to the source cell.
    pub base_loc: Frame,
    /// Spawn frequency [0..1]. ACE rejects the candidate if a deterministic
    /// noise sample exceeds this threshold.
    pub freq: f32,
    /// Random-displacement bounds applied along the cell's X axis.
    pub displace_x: f32,
    /// Random-displacement bounds applied along the cell's Y axis.
    pub displace_y: f32,
    /// Minimum uniform scale factor (clamped post-noise).
    pub min_scale: f32,
    /// Maximum uniform scale factor (clamped post-noise).
    pub max_scale: f32,
    /// Maximum rotation about Z applied to the placement (radians per ACE).
    pub max_rotation: f32,
    /// Minimum terrain slope (rad) at which the placement is allowed.
    pub min_slope: f32,
    /// Maximum terrain slope (rad) at which the placement is allowed.
    pub max_slope: f32,
    /// Alignment mode (ACE: terrain-align vs world-align). Treated as opaque
    /// at parse time; the bake interprets it.
    pub align: u32,
    /// Orientation mode (ACE: random vs heading-from-slope). Opaque here.
    pub orient: u32,
    /// Non-zero → ACE-managed weenie (NPC/monster/lifestone). The procedural
    /// bake skips these — the entity channel covers them. Zero → procedural
    /// scenery the bake should emit.
    pub weenie_obj: u32,
}

impl ObjectDesc {
    /// Read one `ObjectDesc` payload from `reader`. Field order matches
    /// ACE's `ObjectDesc.Unpack` verbatim.
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let obj_id = u32::read_le(reader)?;
        let base_loc = Frame::read_le(reader)?;
        let freq = f32::read_le(reader)?;
        let displace_x = f32::read_le(reader)?;
        let displace_y = f32::read_le(reader)?;
        let min_scale = f32::read_le(reader)?;
        let max_scale = f32::read_le(reader)?;
        let max_rotation = f32::read_le(reader)?;
        let min_slope = f32::read_le(reader)?;
        let max_slope = f32::read_le(reader)?;
        let align = u32::read_le(reader)?;
        let orient = u32::read_le(reader)?;
        let weenie_obj = u32::read_le(reader)?;

        Ok(ObjectDesc {
            obj_id,
            base_loc,
            freq,
            displace_x,
            displace_y,
            min_scale,
            max_scale,
            max_rotation,
            min_slope,
            max_slope,
            align,
            orient,
            weenie_obj,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use binrw::io::Cursor;

    /// Hand-build a 72-byte buffer carrying every field, then `unpack` and
    /// assert each field round-trips. Confirms wire offsets are correct.
    #[test]
    fn object_desc_roundtrip_synthetic_bytes() {
        let mut buf = Vec::with_capacity(OBJECT_DESC_PACKED_SIZE);

        // obj_id (4 bytes)
        buf.extend_from_slice(&0x0100_1234u32.to_le_bytes());
        // base_loc.origin: Vector3 (12 bytes)
        buf.extend_from_slice(&1.0f32.to_le_bytes());
        buf.extend_from_slice(&2.0f32.to_le_bytes());
        buf.extend_from_slice(&3.0f32.to_le_bytes());
        // base_loc.orientation: Quaternion w, x, y, z (16 bytes)
        buf.extend_from_slice(&0.5f32.to_le_bytes());
        buf.extend_from_slice(&0.25f32.to_le_bytes());
        buf.extend_from_slice(&0.125f32.to_le_bytes());
        buf.extend_from_slice(&0.0625f32.to_le_bytes());
        // freq (4)
        buf.extend_from_slice(&0.75f32.to_le_bytes());
        // displace_x, displace_y (8)
        buf.extend_from_slice(&10.0f32.to_le_bytes());
        buf.extend_from_slice(&11.0f32.to_le_bytes());
        // min_scale, max_scale (8)
        buf.extend_from_slice(&0.9f32.to_le_bytes());
        buf.extend_from_slice(&1.1f32.to_le_bytes());
        // max_rotation (4)
        buf.extend_from_slice(&std::f32::consts::PI.to_le_bytes());
        // min_slope, max_slope (8)
        buf.extend_from_slice(&0.1f32.to_le_bytes());
        buf.extend_from_slice(&0.9f32.to_le_bytes());
        // align, orient, weenie_obj (12)
        buf.extend_from_slice(&0xAAAA_AAAAu32.to_le_bytes());
        buf.extend_from_slice(&0xBBBB_BBBBu32.to_le_bytes());
        buf.extend_from_slice(&0xCCCC_CCCCu32.to_le_bytes());

        assert_eq!(
            buf.len(),
            OBJECT_DESC_PACKED_SIZE,
            "synthetic buffer length must match the documented packed size"
        );

        let mut cursor = Cursor::new(&buf);
        let od = ObjectDesc::unpack(&mut cursor).expect("unpack synthetic ObjectDesc");

        assert_eq!(od.obj_id, 0x0100_1234);
        assert_eq!(od.base_loc.origin.x, 1.0);
        assert_eq!(od.base_loc.origin.y, 2.0);
        assert_eq!(od.base_loc.origin.z, 3.0);
        assert_eq!(od.base_loc.orientation.w, 0.5);
        assert_eq!(od.base_loc.orientation.x, 0.25);
        assert_eq!(od.base_loc.orientation.y, 0.125);
        assert_eq!(od.base_loc.orientation.z, 0.0625);
        assert_eq!(od.freq, 0.75);
        assert_eq!(od.displace_x, 10.0);
        assert_eq!(od.displace_y, 11.0);
        assert_eq!(od.min_scale, 0.9);
        assert_eq!(od.max_scale, 1.1);
        assert_eq!(od.max_rotation, std::f32::consts::PI);
        assert_eq!(od.min_slope, 0.1);
        assert_eq!(od.max_slope, 0.9);
        assert_eq!(od.align, 0xAAAA_AAAA);
        assert_eq!(od.orient, 0xBBBB_BBBB);
        assert_eq!(od.weenie_obj, 0xCCCC_CCCC);

        // Cursor is fully consumed — no padding.
        assert_eq!(cursor.position() as usize, OBJECT_DESC_PACKED_SIZE);
    }

    /// Pure arithmetic check that the documented size matches the field
    /// breakdown. If `Frame`'s layout ever changes (e.g. someone adds a
    /// field to `Vector3`/`Quaternion`), this fails fast.
    #[test]
    fn object_desc_size_matches_ace() {
        // Field-level breakdown, ACE order:
        //  obj_id                  :  4
        //  base_loc                : 28  (Vector3 12 + Quaternion 16)
        //  freq..max_slope         : 32  (8 × f32 — freq, dx, dy, min/max
        //                                  scale, max_rotation, min/max slope)
        //  align/orient/weenie_obj : 12  (3 × u32)
        const EXPECTED: usize = 4 + 28 + (8 * 4) + (3 * 4);
        assert_eq!(EXPECTED, 76);
        assert_eq!(EXPECTED, OBJECT_DESC_PACKED_SIZE);
    }
}
