use crate::graphics::Frame;
use binrw::{
    BinRead, BinResult, BinWrite,
    io::{Read, Seek, Write},
};

/// AC's Surface namespace prefix (DAT file type 0x08 — see
/// `crate::file_type::Surface`). EnvCell stores its surface table as
/// 16-bit indices on the wire to save bytes; callers OR each entry
/// with this constant to recover the full Surface DID. Mirrors ACE
/// `DatLoader/FileTypes/EnvCell.cs:50`:
/// `Surfaces.Add(0x08000000u | reader.ReadUInt16());`
///
/// Kept in `holtburger-dat` (not the wasm bundle) so both the parser
/// and any future native consumer of `EnvCell.surfaces` get the same
/// convention.
pub const SURFACE_DID_NAMESPACE_PREFIX: u32 = 0x0800_0000;

/// EnvCell flag bits, mirroring ACE `Source/ACE.Entity/Enum/EnvCellFlags.cs`
/// + DRW `dats.xml:222-226` + retail `acclient.c::CEnvCell::UnPack` at
/// `acclient.c:349134-349401` (`if pack_bitfield & 2` → static objects,
/// `if pack_bitfield & 8` → restriction obj). All three sources agree:
/// `SeenOutside = 0x01`, `HasStaticObjs = 0x02`, `HasRestrictionObj = 0x08`.
///
/// Note bit `0x04` is unallocated in EnvCellFlags (gap between
/// HasStaticObjs and HasRestrictionObj — not used by any oracle).
///
/// Prior to 2026-05-20 the unpack/pack here used the wrong masks
/// (`0x01` for static_objects, `0x02` for restriction_obj), which
/// silently miscategorised flag bits and consumed bytes from the wrong
/// branch. Fix tracked in [[project_envcell_flagmask_fix_2026-05-20]].
pub const ENVCELL_FLAG_SEEN_OUTSIDE: u32 = 0x01;
pub const ENVCELL_FLAG_HAS_STATIC_OBJS: u32 = 0x02;
pub const ENVCELL_FLAG_HAS_RESTRICTION_OBJ: u32 = 0x08;

/// Resolve a wire-format EnvCell surface table entry to a full Surface
/// DID by OR'ing with the namespace prefix. Trivial today; defined as a
/// helper so consumers don't open-code `0x0800_0000 | (s as u32)` and
/// risk getting the prefix wrong.
#[inline]
pub fn surface_did_for_envcell_index(wire_value: u16) -> u32 {
    SURFACE_DID_NAMESPACE_PREFIX | (wire_value as u32)
}

/// EnvCell portal record — 4 × u16 = 8 bytes per record.
///
/// Mirrors retail `CCellPortal::UnPack` at `acclient.c:362379` + DRW
/// `dats.xml:4173-4178` (4 ushort fields: Flags, PolygonId, OtherCellId,
/// OtherPortalId).
///
/// Prior to 2026-05-20 the `polygon_id: u16` field was missing from
/// this struct (only 3 × u16 = 6 bytes were read), which silently
/// consumed 2 fewer bytes per portal than the wire format actually
/// contains. Downstream `visible_cells: Vec<u16>` then started 2 bytes
/// early per portal and picked up garbage entries (e.g. an extra
/// leading `1` between the first two real entries on cells with one
/// or more portals). See [[project_envcell_flagmask_fix_2026-05-20]]
/// for the audit trail and [[project_envcell_visiblecells_investigation_2026-05-20]]
/// for the original drift report.
#[derive(Debug, Clone, BinRead, BinWrite, serde::Serialize)]
#[br(little)]
#[bw(little)]
pub struct CellPortal {
    pub flags: u16,
    pub polygon_id: u16,
    pub other_cell_id: u16,
    pub other_portal_id: u16,
}

#[derive(Debug, Clone, BinRead, BinWrite, serde::Serialize)]
#[br(little)]
#[bw(little)]
pub struct Stab {
    pub stab_id: u32,
    pub position: Frame,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct EnvCell {
    pub id: u32,
    pub flags: u32,
    pub cell_id: u32,
    pub surfaces: Vec<u16>,
    pub environment_id: u16,
    pub cell_structure: u16,
    pub position: Frame,
    pub portals: Vec<CellPortal>,
    pub visible_cells: Vec<u16>,
    pub static_objects: Vec<Stab>,
    pub restriction_obj: Option<u32>,
}

impl EnvCell {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let id = u32::read_le(reader)?;
        let flags = u32::read_le(reader)?;
        let cell_id = u32::read_le(reader)?;

        let num_surfaces = u8::read(reader)?;
        let num_portals = u8::read(reader)?;
        let num_visible_cells = u16::read_le(reader)?;

        let mut surfaces = Vec::with_capacity(num_surfaces as usize);
        for _ in 0..num_surfaces {
            surfaces.push(u16::read_le(reader)?);
        }

        let environment_id = u16::read_le(reader)?;
        let cell_structure = u16::read_le(reader)?;

        let position = Frame::read_le(reader)?;

        let mut portals = Vec::with_capacity(num_portals as usize);
        for _ in 0..num_portals {
            portals.push(CellPortal::read_le(reader)?);
        }

        let mut visible_cells = Vec::with_capacity(num_visible_cells as usize);
        for _ in 0..num_visible_cells {
            visible_cells.push(u16::read_le(reader)?);
        }

        let mut static_objects = Vec::new();
        if (flags & ENVCELL_FLAG_HAS_STATIC_OBJS) != 0 {
            // HasStaticObjs = 0x02 (see EnvCellFlags constants above)
            let num_objs = u32::read_le(reader)?;
            for _ in 0..num_objs {
                static_objects.push(Stab::read_le(reader)?);
            }
        }

        let mut restriction_obj = None;
        if (flags & ENVCELL_FLAG_HAS_RESTRICTION_OBJ) != 0 {
            // HasRestrictionObj = 0x08 (see EnvCellFlags constants above)
            restriction_obj = Some(u32::read_le(reader)?);
        }

        Ok(EnvCell {
            id,
            flags,
            cell_id,
            surfaces,
            environment_id,
            cell_structure,
            position,
            portals,
            visible_cells,
            static_objects,
            restriction_obj,
        })
    }

    pub fn pack<W: Write + Seek>(&self, writer: &mut W) -> BinResult<()> {
        self.id.write_le(writer)?;
        self.flags.write_le(writer)?;
        self.cell_id.write_le(writer)?;

        let num_surfaces = u8::try_from(self.surfaces.len()).map_err(|e| binrw::Error::Custom {
            pos: writer.stream_position().unwrap_or(0),
            err: Box::new(e),
        })?;
        num_surfaces.write_le(writer)?;

        let num_portals = u8::try_from(self.portals.len()).map_err(|e| binrw::Error::Custom {
            pos: writer.stream_position().unwrap_or(0),
            err: Box::new(e),
        })?;
        num_portals.write_le(writer)?;

        let num_visible_cells =
            u16::try_from(self.visible_cells.len()).map_err(|e| binrw::Error::Custom {
                pos: writer.stream_position().unwrap_or(0),
                err: Box::new(e),
            })?;
        num_visible_cells.write_le(writer)?;

        for &surf in &self.surfaces {
            surf.write_le(writer)?;
        }

        self.environment_id.write_le(writer)?;
        self.cell_structure.write_le(writer)?;

        self.position.write_le(writer)?;

        for portal in &self.portals {
            portal.write_le(writer)?;
        }

        for &vis in &self.visible_cells {
            vis.write_le(writer)?;
        }

        if (self.flags & ENVCELL_FLAG_HAS_STATIC_OBJS) != 0 {
            (self.static_objects.len() as u32).write_le(writer)?;
            for obj in &self.static_objects {
                obj.write_le(writer)?;
            }
        }

        if let Some(res) = self
            .restriction_obj
            .filter(|_| (self.flags & ENVCELL_FLAG_HAS_RESTRICTION_OBJ) != 0)
        {
            res.write_le(writer)?;
        }

        Ok(())
    }

    pub fn prune(&mut self) {
        // Surfaces are visual mappings, we can nuke them for lite archives.
        self.surfaces.clear();
        // Static objects are usually decorations, but some might be relevant?
        // For now let's keep them as they are "Stabs" which might be interaction targets.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn surface_did_for_envcell_index_or_masks_with_namespace_prefix() {
        // Pin the namespace prefix to the documented 0x08 byte. If a
        // future refactor changes the prefix to 0x05 (Surface vs
        // SurfaceTexture confusion) or strips the OR, this test fails
        // and the EnvCell triangulator's surface lookup goes silent
        // (flat-grey textures everywhere).
        assert_eq!(SURFACE_DID_NAMESPACE_PREFIX, 0x0800_0000);
        assert_eq!(surface_did_for_envcell_index(0x0000), 0x0800_0000);
        assert_eq!(surface_did_for_envcell_index(0xABCD), 0x0800_ABCD);
        assert_eq!(surface_did_for_envcell_index(0xFFFF), 0x0800_FFFF);
    }

    #[test]
    fn envcell_flag_constants_match_ace_drw_acclient() {
        // Pin the EnvCellFlags bits to the three-source oracle agreement:
        //   ACE  Source/ACE.Entity/Enum/EnvCellFlags.cs
        //   DRW  dats.xml:222-226
        //   acclient.c::CEnvCell::UnPack (acclient.c:349300, 349373)
        //
        // Prior to 2026-05-20 the code below used (0x01, 0x02) which
        // shifts every cell's flag-branch interpretation by one bit.
        // See [[project_envcell_flagmask_fix_2026-05-20]] for context.
        assert_eq!(ENVCELL_FLAG_SEEN_OUTSIDE, 0x01);
        assert_eq!(ENVCELL_FLAG_HAS_STATIC_OBJS, 0x02);
        assert_eq!(ENVCELL_FLAG_HAS_RESTRICTION_OBJ, 0x08);
        // Bit 0x04 is intentionally unassigned per EnvCellFlags enum.
    }

    #[test]
    fn envcell_pack_unpack_roundtrip_with_static_objs_flag() {
        // Roundtrip a cell that sets `HasStaticObjs` (0x02) — the bit
        // that used to be miscategorised as `HasRestrictionObj` by the
        // buggy 0x01/0x02 masks. With the correct masks, packing a
        // cell whose flags carry 0x02 must write the static-objects
        // block (count + Stabs), and unpacking must read them back.
        let original = EnvCell {
            id: 0x0D02_0001,
            flags: ENVCELL_FLAG_HAS_STATIC_OBJS,
            cell_id: 0x0D02_0001,
            surfaces: vec![],
            environment_id: 0x0D01,
            cell_structure: 0,
            position: Frame::default(),
            portals: vec![],
            visible_cells: vec![],
            static_objects: vec![Stab {
                stab_id: 0x0200_1234,
                position: Frame::default(),
            }],
            restriction_obj: None,
        };

        let mut data = Vec::new();
        original.pack(&mut Cursor::new(&mut data)).unwrap();
        let decoded = EnvCell::unpack(&mut Cursor::new(&data)).unwrap();

        assert_eq!(decoded.flags, ENVCELL_FLAG_HAS_STATIC_OBJS);
        assert_eq!(decoded.static_objects.len(), 1);
        assert_eq!(decoded.static_objects[0].stab_id, 0x0200_1234);
        assert_eq!(decoded.restriction_obj, None);
    }

    #[test]
    fn envcell_pack_unpack_roundtrip_with_restriction_obj_flag() {
        // Roundtrip a cell that sets `HasRestrictionObj` (0x08) — the
        // bit that the old 0x01/0x02 masks completely missed, meaning
        // the restriction-obj u32 was silently dropped during unpack
        // and never emitted during pack (even when present).
        let original = EnvCell {
            id: 0x0D02_0002,
            flags: ENVCELL_FLAG_HAS_RESTRICTION_OBJ,
            cell_id: 0x0D02_0002,
            surfaces: vec![],
            environment_id: 0x0D01,
            cell_structure: 0,
            position: Frame::default(),
            portals: vec![],
            visible_cells: vec![],
            static_objects: vec![],
            restriction_obj: Some(0xCAFE_F00D),
        };

        let mut data = Vec::new();
        original.pack(&mut Cursor::new(&mut data)).unwrap();
        let decoded = EnvCell::unpack(&mut Cursor::new(&data)).unwrap();

        assert_eq!(decoded.flags, ENVCELL_FLAG_HAS_RESTRICTION_OBJ);
        assert!(decoded.static_objects.is_empty());
        assert_eq!(decoded.restriction_obj, Some(0xCAFE_F00D));
    }

    #[test]
    fn envcell_pack_unpack_roundtrip_with_seen_outside_only_no_extras() {
        // Cell with SeenOutside (0x01) but neither static-objs nor
        // restriction-obj must NOT read/write any optional trailers.
        // Under the old 0x01 mask, this cell would have incorrectly
        // tried to read a u32 num_objs (then N Stabs) past the end of
        // the wire data, corrupting downstream parsers.
        let original = EnvCell {
            id: 0x0D02_0003,
            flags: ENVCELL_FLAG_SEEN_OUTSIDE,
            cell_id: 0x0D02_0003,
            surfaces: vec![],
            environment_id: 0x0D01,
            cell_structure: 0,
            position: Frame::default(),
            portals: vec![],
            visible_cells: vec![],
            static_objects: vec![],
            restriction_obj: None,
        };

        let mut data = Vec::new();
        original.pack(&mut Cursor::new(&mut data)).unwrap();
        let decoded = EnvCell::unpack(&mut Cursor::new(&data)).unwrap();

        assert_eq!(decoded.flags, ENVCELL_FLAG_SEEN_OUTSIDE);
        assert!(decoded.static_objects.is_empty());
        assert_eq!(decoded.restriction_obj, None);
    }

    #[test]
    fn test_env_cell_prune() {
        let mut cell = EnvCell {
            id: 0x01000001,
            flags: 0,
            cell_id: 0x01000001,
            surfaces: vec![1, 2, 3],
            environment_id: 0x0D01,
            cell_structure: 1,
            position: Frame::default(),
            portals: vec![],
            visible_cells: vec![],
            static_objects: vec![],
            restriction_obj: None,
        };

        assert_eq!(cell.surfaces.len(), 3);
        cell.prune();
        assert_eq!(cell.surfaces.len(), 0);

        let mut data = Vec::new();
        let mut writer = Cursor::new(&mut data);
        cell.pack(&mut writer).unwrap();

        let mut reader = Cursor::new(data);
        let unpacked = EnvCell::unpack(&mut reader).unwrap();
        assert_eq!(unpacked.surfaces.len(), 0);
        assert_eq!(unpacked.environment_id, 0x0D01);
    }
}
