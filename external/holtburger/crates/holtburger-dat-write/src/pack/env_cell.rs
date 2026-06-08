//! `impl DatPack for EnvCell` — delegates to the existing `EnvCell::pack`
//! (E12 design §B, WRAP type 0x0D) and enforces the flag/presence
//! invariants the underlying pack does NOT itself check.
//!
//! `EnvCell::pack` gates two optional sections on the `flags` bitfield,
//! exactly as the reader does:
//! - `HasStaticObjs` (`0x02`) gates the `static_objects` block.
//! - `HasRestrictionObj` (`0x08`) gates the `restriction_obj` DWORD.
//!
//! The pack writes the static-objects block only when the flag is set, and
//! the `restriction_obj` only when its flag is set AND the field is `Some`.
//! That means a record whose in-memory `flags` disagree with the populated
//! fields would silently round-trip with dropped data. The guard below fails
//! closed up front so such a record never reaches the byte path.

use std::io::Cursor;

use holtburger_dat::DatFileType;
use holtburger_dat::file_type::EnvCell;
use holtburger_dat::file_type::env_cell::{
    ENVCELL_FLAG_HAS_RESTRICTION_OBJ, ENVCELL_FLAG_HAS_STATIC_OBJS,
};

use crate::DatPack;
use crate::error::{Result, WriteError};

impl DatPack for EnvCell {
    fn pack(&self) -> Result<Vec<u8>> {
        // Fail closed: validate before producing any bytes.
        validate(self)?;

        let mut buf = Vec::new();
        let mut cursor = Cursor::new(&mut buf);
        EnvCell::pack(self, &mut cursor)?;
        Ok(buf)
    }

    fn type_id(&self) -> u32 {
        DatFileType::EnvCell as u32
    }

    fn id(&self) -> u32 {
        self.id
    }
}

fn validate(cell: &EnvCell) -> Result<()> {
    let type_id = DatFileType::EnvCell as u32;
    let file_id = cell.id;

    // HasStaticObjs (0x02) gates the static_objects block.
    let has_static = (cell.flags & ENVCELL_FLAG_HAS_STATIC_OBJS) != 0;
    if !has_static && !cell.static_objects.is_empty() {
        return Err(violation(
            type_id,
            file_id,
            format!(
                "HasStaticObjs clear but {} static objects present (would be dropped on write)",
                cell.static_objects.len()
            ),
        ));
    }

    // HasRestrictionObj (0x08) gates the restriction_obj DWORD. The pack
    // writes it only when BOTH the flag is set and the field is Some, so a
    // mismatch in either direction silently drops/omits data.
    let has_restriction = (cell.flags & ENVCELL_FLAG_HAS_RESTRICTION_OBJ) != 0;
    if has_restriction != cell.restriction_obj.is_some() {
        return Err(violation(
            type_id,
            file_id,
            format!(
                "HasRestrictionObj flag ({has_restriction}) disagrees with restriction_obj presence ({})",
                cell.restriction_obj.is_some()
            ),
        ));
    }

    Ok(())
}

fn violation(type_id: u32, file_id: u32, reason: String) -> WriteError {
    WriteError::InvariantViolation {
        type_id,
        file_id,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_dat::graphics::Frame;
    use std::io::Cursor;

    fn base_cell() -> EnvCell {
        EnvCell {
            id: 0x0D00_0042,
            flags: 0,
            cell_id: 0x0001_0100,
            surfaces: vec![0x0001, 0x0002],
            environment_id: 7,
            cell_structure: 3,
            position: Frame::default(),
            portals: vec![],
            visible_cells: vec![0x0101, 0x0102],
            static_objects: vec![],
            restriction_obj: None,
        }
    }

    #[test]
    fn env_cell_pack_round_trips_byte_and_structurally_equal() {
        let cell = base_cell();

        let bytes = DatPack::pack(&cell).expect("valid EnvCell must pack");

        let mut cursor = Cursor::new(bytes.clone());
        let reparsed = EnvCell::unpack(&mut cursor).expect("packed bytes must re-unpack");

        assert_eq!(reparsed.id, cell.id);
        assert_eq!(reparsed.flags, cell.flags);
        assert_eq!(reparsed.cell_id, cell.cell_id);
        assert_eq!(reparsed.surfaces, cell.surfaces);
        assert_eq!(reparsed.environment_id, cell.environment_id);
        assert_eq!(reparsed.cell_structure, cell.cell_structure);
        assert_eq!(reparsed.visible_cells, cell.visible_cells);
        assert_eq!(reparsed.restriction_obj, cell.restriction_obj);

        // Byte idempotence through the guarded path.
        let bytes2 = DatPack::pack(&reparsed).expect("re-parsed EnvCell must pack");
        assert_eq!(bytes, bytes2, "EnvCell pack must be byte-for-byte idempotent");

        assert_eq!(DatPack::type_id(&cell), DatFileType::EnvCell as u32);
        assert_eq!(DatPack::id(&cell), 0x0D00_0042);
    }

    #[test]
    fn env_cell_with_restriction_obj_round_trips() {
        let mut cell = base_cell();
        cell.flags = ENVCELL_FLAG_HAS_RESTRICTION_OBJ;
        cell.restriction_obj = Some(0x1234_5678);

        let bytes = DatPack::pack(&cell).expect("valid EnvCell with restriction must pack");
        let mut cursor = Cursor::new(bytes.clone());
        let reparsed = EnvCell::unpack(&mut cursor).expect("must re-unpack");
        assert_eq!(reparsed.restriction_obj, Some(0x1234_5678));

        let bytes2 = DatPack::pack(&reparsed).expect("re-parsed must pack");
        assert_eq!(bytes, bytes2);
    }

    #[test]
    fn negative_restriction_flag_without_field_is_rejected() {
        let mut cell = base_cell();
        cell.flags = ENVCELL_FLAG_HAS_RESTRICTION_OBJ; // set but field is None
        let err = DatPack::pack(&cell)
            .expect_err("HasRestrictionObj without field must be rejected");
        match err {
            WriteError::InvariantViolation { reason, .. } => {
                assert!(reason.contains("HasRestrictionObj"), "reason: {reason}");
            }
            other => panic!("expected InvariantViolation, got {other:?}"),
        }
    }
}
