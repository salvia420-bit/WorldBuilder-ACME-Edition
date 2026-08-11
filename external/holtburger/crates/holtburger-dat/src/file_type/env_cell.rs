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

/// `CellPortal.flags` bit 0 — `exact_match`.
///
/// Retail `CCellPortal::UnPack` (`acclient.c:362388`):
/// `this->exact_match = v5 & 1;` — a plain, UNINVERTED bit test. ACE
/// names it `PortalFlags.ExactMatch = 0x1`
/// (`external/ACE/Source/ACE.Entity/Enum/PortalFlags.cs:8`); DRW agrees
/// (`dats.xml:219`).
pub const CELL_PORTAL_FLAG_EXACT_MATCH: u16 = 0x0001;

/// `CellPortal.flags` bit 1 — `portal_side`, **STORED INVERTED**.
///
/// This is the trap in the record. Retail does NOT read the bit
/// directly; `CCellPortal::UnPack` (`acclient.c:362389`) reads
///
/// ```text
/// this->portal_side = ((unsigned int)(unsigned __int8)~(_BYTE)v5 >> 1) & 1;
/// ```
///
/// i.e. `portal_side = !(flags & 0x2)`, and `CCellPortal::Pack`
/// (`acclient.c:362359`) is the exact inverse: `if (!this->portal_side)
/// v3 |= 2u;`. `CBldPortal::UnPack` (`acclient.c:362517`) uses the
/// identical expression, so the inversion is a property of the WIRE
/// FORMAT, not of one record type.
///
/// ACE and DRW both name the raw bit `PortalSide = 0x2` and stop there
/// — neither carries the inversion, so reading `flags & 0x2` as
/// "portal_side" (the obvious thing) yields the OPPOSITE side on every
/// portal in the game. Use [`CellPortal::portal_side`], never the bit.
pub const CELL_PORTAL_FLAG_PORTAL_SIDE: u16 = 0x0002;

/// `CellPortal.flags` bit 2 — the other cell is ABSENT (leads outdoors).
///
/// Unnamed in both ACE `PortalFlags.cs` and DRW `dats.xml` (their enums
/// stop at 0x2), but load-bearing in retail: `CCellPortal::UnPack`
/// (`acclient.c:362395-362398`) reads the `other_cell_id` u16 off the
/// wire and then DISCARDS it when this bit is set —
///
/// ```text
/// if ( v5 & 4 )  this->other_cell_id = -1;
/// else           this->other_cell_id = block_mask | v7;
/// ```
///
/// — and `CCellPortal::Pack` (`acclient.c:362361`) re-derives the bit
/// from `other_cell_id == -1`. So the wire `other_cell_id` is only
/// meaningful when this bit is CLEAR; when it is set, the portal exits
/// the EnvCell graph entirely (to an outdoor LandCell).
pub const CELL_PORTAL_FLAG_LEADS_OUTDOORS: u16 = 0x0004;

/// The three `CellPortal.flags` bits retail defines. Any bit outside
/// this mask is undocumented in all three oracles; the parity sweep in
/// `tests/cell_portal_flags_parity.rs` measures how many real portals
/// carry one (answer on the retail baseline: zero).
pub const CELL_PORTAL_KNOWN_FLAGS: u16 = CELL_PORTAL_FLAG_EXACT_MATCH
    | CELL_PORTAL_FLAG_PORTAL_SIDE
    | CELL_PORTAL_FLAG_LEADS_OUTDOORS;

/// Low word written into a resolved cell id when a portal leads
/// outdoors. Retail stores the whole id as `-1`
/// (`acclient.c:362396`); we keep the landblock high word and set the
/// low word to `0xFFFF` because every consumer in this codebase keys
/// the outdoor test on `(cell_id & 0xFFFF) >= 0xFFFE` and needs the
/// landblock to stay recoverable from the same u32.
pub const CELL_PORTAL_OUTDOOR_CELL_LOW_WORD: u32 = 0xFFFF;

/// EnvCell portal record — 4 × u16 = 8 bytes per record.
///
/// Mirrors retail `CCellPortal::UnPack` at `acclient.c:362379` + DRW
/// `dats.xml:2596-2601` (4 ushort fields: Flags, PolygonId, OtherCellId,
/// OtherPortalId).
///
/// `flags` is kept as the RAW wire u16 so `pack` stays byte-identical to
/// `unpack`; the three documented bits are read through the accessors
/// below ([`CellPortal::exact_match`], [`CellPortal::portal_side`],
/// [`CellPortal::leads_outdoors`]) because one of them is stored
/// inverted and a bare `flags & 0x2` gets it wrong.
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

impl CellPortal {
    /// `exact_match` — retail `acclient.c:362388` (`v5 & 1`).
    ///
    /// Set when the portal polygon and the matching polygon in
    /// `other_cell` are geometrically identical, which lets retail skip
    /// re-clipping the view against the far side.
    #[inline]
    pub fn exact_match(&self) -> bool {
        (self.flags & CELL_PORTAL_FLAG_EXACT_MATCH) != 0
    }

    /// `portal_side` — retail `acclient.c:362389`, **the inverted bit**
    /// (`!(flags & 0x2)`). See [`CELL_PORTAL_FLAG_PORTAL_SIDE`].
    ///
    /// Semantics (three read-verified retail use sites, all the same
    /// rule): classify the viewpoint against the portal polygon's plane
    /// as retail's `Sidedness` — `0` when `N·P + d > +2e-4`, `1` when
    /// `< -2e-4`, `2` (on-plane) otherwise — and the portal is
    /// traversable ONLY when that class equals `portal_side`:
    ///
    /// - `PView::InitCell` (`acclient.c:461691`): `if (sidedness !=
    ///   portal_side) inflag = 1` — i.e. a portal is an OUT portal
    ///   exactly when they match.
    /// - `PView::ConstructView(CBldPortal*, …)`
    ///   (`acclient.c:462533-462540`): `if (portal_side) { if (v8 != 1)
    ///   return 0; } else if (v8) return 0;`
    /// - `CEnvCell::calc_clip_planes` (`acclient.c:348907`) hands
    ///   `portal_side` straight to `ClipPlane` as a `Sidedness`.
    ///
    /// `true` here is retail's `portal_side == 1` = the NEGATIVE
    /// halfspace of the polygon plane. Which physical side that is
    /// (room interior vs. the space beyond) is a property of the DATA,
    /// not of this flag — so it was MEASURED, in
    /// `tests/cell_portal_flags_parity.rs`, over the retail baseline:
    /// the owning cell's own geometric centroid lands on the
    /// `portal_side` side for **15,186 / 15,186** outdoor-facing and
    /// **1,840,177 / 1,840,177** cell→cell portals, none on-plane.
    /// `portal_side` names the OWNING ROOM'S INTERIOR, exactly.
    ///
    /// Consequence for anything drawing a room from OUTSIDE it (the
    /// `?portalPunch` aperture gate): retail's rule keeps the portal
    /// when the viewer matches `portal_side`, i.e. when the viewer is
    /// INSIDE the room, so an outward-looking consumer wants the
    /// negation. See `scene3d/portal_clip.js#facesAwayWithSide`.
    #[inline]
    pub fn portal_side(&self) -> bool {
        (self.flags & CELL_PORTAL_FLAG_PORTAL_SIDE) == 0
    }

    /// Retail's `Sidedness` value for `portal_side` (`0` or `1`), for
    /// call sites that compare against a classified viewpoint rather
    /// than a bool. Mirrors the `int portal_side` field retail keeps in
    /// `CCellPortal` (`acclient.h:32305`).
    #[inline]
    pub fn portal_side_sidedness(&self) -> u8 {
        u8::from(self.portal_side())
    }

    /// `flags & 4` — the portal exits the EnvCell graph to an outdoor
    /// LandCell, and the wire `other_cell_id` is meaningless.
    /// See [`CELL_PORTAL_FLAG_LEADS_OUTDOORS`].
    #[inline]
    pub fn leads_outdoors(&self) -> bool {
        (self.flags & CELL_PORTAL_FLAG_LEADS_OUTDOORS) != 0
    }

    /// Any flag bit retail does not define. Zero on the retail baseline
    /// (see the parity sweep); non-zero would mean the format carries
    /// something this decode drops on the floor.
    #[inline]
    pub fn unknown_flag_bits(&self) -> u16 {
        self.flags & !CELL_PORTAL_KNOWN_FLAGS
    }

    /// Compose the full 32-bit id of the cell on the far side, given
    /// this cell's landblock high word (`cell_id & 0xFFFF0000`) —
    /// retail's `block_mask | v7` at `acclient.c:362398`.
    ///
    /// The `leads_outdoors` branch is the part callers keep getting
    /// wrong by open-coding `landblock_high | other_cell_id`: with bit
    /// 2 set the wire `other_cell_id` is a leftover value retail never
    /// reads, so composing it can manufacture an edge to a real
    /// neighbouring cell. Returns `landblock_high | 0xFFFF` instead —
    /// see [`CELL_PORTAL_OUTDOOR_CELL_LOW_WORD`] for why not retail's
    /// bare `0xFFFFFFFF`.
    #[inline]
    pub fn resolved_other_cell_id(&self, landblock_high: u32) -> u32 {
        if self.leads_outdoors() {
            landblock_high | CELL_PORTAL_OUTDOOR_CELL_LOW_WORD
        } else {
            landblock_high | (self.other_cell_id as u32)
        }
    }
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
    fn cell_portal_flag_constants_match_acclient_ace_drw() {
        // Three-source agreement on the two NAMED bits:
        //   acclient CCellPortal::UnPack  (acclient.c:362388-362389)
        //   ACE      PortalFlags.cs:8-9
        //   DRW      dats.xml:218-221
        assert_eq!(CELL_PORTAL_FLAG_EXACT_MATCH, 0x0001);
        assert_eq!(CELL_PORTAL_FLAG_PORTAL_SIDE, 0x0002);
        // Bit 2 is acclient-only (ACE/DRW's enums stop at 0x2), read off
        // `if ( v5 & 4 ) this->other_cell_id = -1;` at acclient.c:362395.
        assert_eq!(CELL_PORTAL_FLAG_LEADS_OUTDOORS, 0x0004);
        assert_eq!(CELL_PORTAL_KNOWN_FLAGS, 0x0007);
    }

    /// Build a portal with only `flags` varying — the other three u16s
    /// are irrelevant to the bit decode.
    fn portal_with_flags(flags: u16) -> CellPortal {
        CellPortal {
            flags,
            polygon_id: 3,
            other_cell_id: 0x0102,
            other_portal_id: 1,
        }
    }

    #[test]
    fn cell_portal_portal_side_is_stored_inverted() {
        // THE bit that makes this task exist. Retail:
        //   unpack  portal_side = !(flags & 2)   (acclient.c:362389)
        //   pack    if (!portal_side) v3 |= 2    (acclient.c:362359)
        // so bit CLEAR means portal_side == 1 (true), and bit SET means
        // portal_side == 0 (false) — the opposite of what ACE's
        // `PortalSide = 0x2` name suggests to a reader.
        assert!(portal_with_flags(0x0000).portal_side());
        assert!(portal_with_flags(CELL_PORTAL_FLAG_EXACT_MATCH).portal_side());
        assert!(!portal_with_flags(CELL_PORTAL_FLAG_PORTAL_SIDE).portal_side());
        assert!(!portal_with_flags(0x0003).portal_side());
        // The `Sidedness`-valued form retail actually compares against.
        assert_eq!(portal_with_flags(0x0000).portal_side_sidedness(), 1);
        assert_eq!(
            portal_with_flags(CELL_PORTAL_FLAG_PORTAL_SIDE).portal_side_sidedness(),
            0
        );
    }

    #[test]
    fn cell_portal_exact_match_and_leads_outdoors_are_plain_bits() {
        assert!(!portal_with_flags(0x0000).exact_match());
        assert!(portal_with_flags(0x0001).exact_match());
        assert!(portal_with_flags(0x0007).exact_match());

        assert!(!portal_with_flags(0x0003).leads_outdoors());
        assert!(portal_with_flags(0x0004).leads_outdoors());
        assert!(portal_with_flags(0x0007).leads_outdoors());

        assert_eq!(portal_with_flags(0x0007).unknown_flag_bits(), 0);
        assert_eq!(portal_with_flags(0x8008).unknown_flag_bits(), 0x8008);
    }

    #[test]
    fn cell_portal_resolved_other_cell_id_drops_the_wire_id_when_outdoors() {
        // With bit 2 CLEAR the wire id composes with the landblock high
        // word, exactly as retail's `block_mask | v7`.
        let indoor = CellPortal {
            flags: 0x0000,
            polygon_id: 0,
            other_cell_id: 0x0135,
            other_portal_id: 0,
        };
        assert_eq!(indoor.resolved_other_cell_id(0x7D64_0000), 0x7D64_0135);

        // With bit 2 SET retail throws the wire id away (it writes -1).
        // Composing it instead — which is what every open-coded
        // `landblock_high | other_cell_id` in this repo did — would
        // fabricate an edge to cell 0x7D640135, a real neighbouring
        // room, from a portal that actually exits to the landscape.
        let outdoor = CellPortal {
            flags: CELL_PORTAL_FLAG_LEADS_OUTDOORS,
            polygon_id: 0,
            other_cell_id: 0x0135,
            other_portal_id: 0,
        };
        assert_eq!(outdoor.resolved_other_cell_id(0x7D64_0000), 0x7D64_FFFF);
        // …and it still reads as outdoors under the `>= 0xFFFE` value
        // test every consumer in this codebase uses today.
        assert!(outdoor.resolved_other_cell_id(0x7D64_0000) & 0xFFFF >= 0xFFFE);
    }

    #[test]
    fn cell_portal_flags_survive_a_wire_roundtrip_unchanged() {
        // The accessors must not tempt anyone into normalising `flags`
        // on unpack: `pack` has to reproduce the input byte-for-byte,
        // including a bit combination we never generate ourselves.
        for flags in [0x0000u16, 0x0001, 0x0002, 0x0004, 0x0007, 0x0005] {
            let original = EnvCell {
                id: 0x7D64_0100,
                flags: 0,
                cell_id: 0x7D64_0100,
                surfaces: vec![],
                environment_id: 0x0D01,
                cell_structure: 0,
                position: Frame::default(),
                portals: vec![portal_with_flags(flags)],
                visible_cells: vec![],
                static_objects: vec![],
                restriction_obj: None,
            };
            let mut data = Vec::new();
            original.pack(&mut Cursor::new(&mut data)).unwrap();
            let decoded = EnvCell::unpack(&mut Cursor::new(&data)).unwrap();
            assert_eq!(decoded.portals.len(), 1);
            assert_eq!(
                decoded.portals[0].flags, flags,
                "flags 0x{:04X} did not survive the roundtrip",
                flags
            );
            assert_eq!(
                decoded.portals[0].portal_side(),
                (flags & CELL_PORTAL_FLAG_PORTAL_SIDE) == 0
            );
        }
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
