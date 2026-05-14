//! `Scene` DBObj (DAT prefix `0x12`) — a flat list of `ObjectDesc` rows that
//! the procedural scenery bake (`ACE.Server.Entity.Scenery.Load`) walks per
//! cell vertex. One Scene = one bucket of candidate placements selected by
//! the `(terrain_type, scene_type)` lookup in Region 0x13's `SceneInfo`.
//!
//! Wire format mirrors ACE's `Scene.Unpack` (23 lines at
//! `~/ace-server/Source/ACE.DatLoader/FileTypes/Scene.cs`):
//!
//! ```text
//!     id      :  4 bytes   (u32)
//!     count   :  4 bytes   (u32)   ← from List<T>.Unpack extension
//!     objects : count × 72 bytes   (ObjectDesc rows)
//! ```
//!
//! The u32-count + read-N pattern matches `region.rs:SceneDesc::unpack`,
//! which also leans on ACE's `UnpackableExtensions.cs:174` `List<T>.Unpack`
//! convention. We hand-roll the read to stay consistent with the rest of
//! the `file_type/` parsers — no `binrw` derive, mirrors `region.rs`.

use crate::file_type::object_desc::ObjectDesc;
use binrw::{
    BinResult,
    io::{Read, Seek},
};

/// One scenery scene as published in `client_portal.dat` under the `0x12`
/// prefix.
///
/// `id` echoes the file's DBObj ID (e.g. `0x1200_07AB`). `objects` is the
/// candidate placement list the bake walks per matching landblock vertex.
#[derive(Debug, Clone, PartialEq)]
pub struct Scene {
    pub id: u32,
    pub objects: Vec<ObjectDesc>,
}

impl Scene {
    /// Read one `Scene` from `reader`. Mirrors ACE's `Scene.Unpack`.
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        use binrw::BinRead;

        let id = u32::read_le(reader)?;
        let num = u32::read_le(reader)?;
        let mut objects = Vec::with_capacity(num as usize);
        for _ in 0..num {
            objects.push(ObjectDesc::unpack(reader)?);
        }
        Ok(Scene { id, objects })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_type::object_desc::OBJECT_DESC_PACKED_SIZE;
    use binrw::io::Cursor;

    /// Smallest-possible Scene wire form: id + count=0, 8 bytes total.
    /// Confirms the count-of-zero path doesn't try to read a phantom
    /// ObjectDesc and that the cursor lands exactly at end-of-buffer.
    #[test]
    fn scene_unpack_zero_objects() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x1200_07ABu32.to_le_bytes()); // id
        buf.extend_from_slice(&0u32.to_le_bytes()); // count=0

        assert_eq!(buf.len(), 8);

        let mut cursor = Cursor::new(&buf);
        let scene = Scene::unpack(&mut cursor).expect("unpack zero-object scene");

        assert_eq!(scene.id, 0x1200_07AB);
        assert!(scene.objects.is_empty());
        assert_eq!(cursor.position() as usize, buf.len());
    }

    /// Scene with a single ObjectDesc — verifies the count→loop wiring,
    /// the ObjectDesc reader is invoked exactly once, and a sample field
    /// round-trips end-to-end.
    #[test]
    fn scene_unpack_one_object() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x1200_0042u32.to_le_bytes()); // id
        buf.extend_from_slice(&1u32.to_le_bytes()); // count=1

        // One ObjectDesc, all-zero except for obj_id + a distinguishable
        // weenie_obj so we can spot it at the end of the payload.
        buf.extend_from_slice(&0x0100_AAAAu32.to_le_bytes()); // obj_id
        // Frame = Vector3(3 × f32) + Quaternion(4 × f32) = 7 f32 = 28 bytes
        for _ in 0..7 {
            buf.extend_from_slice(&0f32.to_le_bytes());
        }
        // 8 f32 scalars (freq, displace_x/y, min/max_scale, max_rotation,
        // min/max_slope) = 32 bytes
        for _ in 0..8 {
            buf.extend_from_slice(&0f32.to_le_bytes());
        }
        // align, orient, weenie_obj — 12 bytes
        buf.extend_from_slice(&0u32.to_le_bytes()); // align
        buf.extend_from_slice(&0u32.to_le_bytes()); // orient
        buf.extend_from_slice(&0xDEAD_BEEFu32.to_le_bytes()); // weenie_obj

        // Sanity: id(4) + count(4) + 76 ObjectDesc = 84
        assert_eq!(buf.len(), 8 + OBJECT_DESC_PACKED_SIZE);

        let mut cursor = Cursor::new(&buf);
        let scene = Scene::unpack(&mut cursor).expect("unpack 1-object scene");

        assert_eq!(scene.id, 0x1200_0042);
        assert_eq!(scene.objects.len(), 1);
        assert_eq!(scene.objects[0].obj_id, 0x0100_AAAA);
        assert_eq!(scene.objects[0].weenie_obj, 0xDEAD_BEEF);
        assert_eq!(scene.objects[0].base_loc.origin.x, 0.0);
        assert_eq!(scene.objects[0].freq, 0.0);
        assert_eq!(cursor.position() as usize, buf.len());
    }

    /// Multi-object guard: count=3 must produce three rows, with each
    /// distinguishable by its obj_id. Catches off-by-one inside the loop.
    #[test]
    fn scene_unpack_three_objects() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x1200_0500u32.to_le_bytes()); // id
        buf.extend_from_slice(&3u32.to_le_bytes()); // count=3

        for tag in [0x0100_0001u32, 0x0100_0002, 0x0100_0003] {
            buf.extend_from_slice(&tag.to_le_bytes()); // obj_id
            // Pad the rest of the 72-byte ObjectDesc with zeros.
            for _ in 0..(OBJECT_DESC_PACKED_SIZE - 4) {
                buf.push(0u8);
            }
        }

        assert_eq!(buf.len(), 8 + 3 * OBJECT_DESC_PACKED_SIZE);

        let mut cursor = Cursor::new(&buf);
        let scene = Scene::unpack(&mut cursor).expect("unpack 3-object scene");

        assert_eq!(scene.objects.len(), 3);
        assert_eq!(scene.objects[0].obj_id, 0x0100_0001);
        assert_eq!(scene.objects[1].obj_id, 0x0100_0002);
        assert_eq!(scene.objects[2].obj_id, 0x0100_0003);
        assert_eq!(cursor.position() as usize, buf.len());
    }
}
