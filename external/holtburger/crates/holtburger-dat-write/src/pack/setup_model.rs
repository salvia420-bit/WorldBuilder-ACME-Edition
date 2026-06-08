//! `impl DatPack for SetupModel` — delegates to `SetupModel::pack` and
//! enforces the placement-flag invariants (E12 design §B.5).
//!
//! SetupModel is the second guarded type: simpler than GfxObj, but it
//! proves the trait against a record whose `pack` writes several
//! `HashMap`s (holding_locations / connection_points / placement_frames /
//! lights). The underlying `SetupModel::pack` already sorts those keys for
//! deterministic output; the guards here pin the flag/array-length
//! consistency that the underlying pack does NOT itself check:
//!
//! - flag `0x01` (HasParent) gates `parent_index` (one entry per part).
//! - flag `0x02` (HasDefaultScale) gates `default_scale` (one per part).
//!
//! If a flag is set, the corresponding array must have exactly `parts.len()`
//! entries; if clear, it must be empty. Otherwise `SetupModel::pack` would
//! silently emit a record whose byte layout cannot be re-read (the reader
//! gates those arrays on the same flags and on `num_parts`).

use std::io::Cursor;

use holtburger_dat::DatFileType;
use holtburger_dat::file_type::SetupModel;

use crate::error::{Result, WriteError};
use crate::DatPack;

/// `SetupModel` flag bit: parent-index array is present iff set.
const HAS_PARENT: u32 = 0x01;
/// `SetupModel` flag bit: default-scale array is present iff set.
const HAS_DEFAULT_SCALE: u32 = 0x02;

impl DatPack for SetupModel {
    fn pack(&self) -> Result<Vec<u8>> {
        // Fail closed: validate before producing bytes.
        validate(self)?;

        let mut buf = Vec::new();
        let mut cursor = Cursor::new(&mut buf);
        SetupModel::pack(self, &mut cursor)?;
        Ok(buf)
    }

    fn type_id(&self) -> u32 {
        DatFileType::SetupModel as u32
    }

    fn id(&self) -> u32 {
        self.id
    }
}

fn validate(model: &SetupModel) -> Result<()> {
    let type_id = DatFileType::SetupModel as u32;
    let file_id = model.id;
    let num_parts = model.parts.len();

    // HasParent (0x01) gates parent_index.
    let has_parent = (model.flags & HAS_PARENT) != 0;
    if has_parent {
        if model.parent_index.len() != num_parts {
            return Err(violation(
                type_id,
                file_id,
                format!(
                    "HasParent set but parent_index.len() {} != parts.len() {num_parts}",
                    model.parent_index.len()
                ),
            ));
        }
    } else if !model.parent_index.is_empty() {
        return Err(violation(
            type_id,
            file_id,
            format!(
                "HasParent clear but parent_index.len() = {} (must be 0)",
                model.parent_index.len()
            ),
        ));
    }

    // HasDefaultScale (0x02) gates default_scale.
    let has_scale = (model.flags & HAS_DEFAULT_SCALE) != 0;
    if has_scale {
        if model.default_scale.len() != num_parts {
            return Err(violation(
                type_id,
                file_id,
                format!(
                    "HasDefaultScale set but default_scale.len() {} != parts.len() {num_parts}",
                    model.default_scale.len()
                ),
            ));
        }
    } else if !model.default_scale.is_empty() {
        return Err(violation(
            type_id,
            file_id,
            format!(
                "HasDefaultScale clear but default_scale.len() = {} (must be 0)",
                model.default_scale.len()
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
    use holtburger_common::{Sphere, Vector3};
    use std::collections::HashMap;
    use std::io::Cursor;

    fn base_model() -> SetupModel {
        SetupModel {
            id: 0x0200_0099,
            flags: 0,
            parts: vec![0x0100_0001, 0x0100_0002],
            parent_index: vec![],
            default_scale: vec![],
            holding_locations: HashMap::new(),
            connection_points: HashMap::new(),
            placement_frames: HashMap::new(),
            cyl_spheres: vec![],
            spheres: vec![],
            height: 1.5,
            radius: 0.5,
            step_up: 0.1,
            step_down: 0.2,
            sorting_sphere: Sphere {
                center: Vector3::zero(),
                radius: 1.0,
            },
            selection_sphere: Sphere {
                center: Vector3::zero(),
                radius: 2.0,
            },
            lights: HashMap::new(),
            default_animation: None,
            default_script: None,
            default_motion_table: None,
            default_sound_table: None,
            default_script_table: Some(0x0E00_0123),
        }
    }

    #[test]
    fn setup_model_pack_round_trips_byte_and_structurally_equal() {
        let model = base_model();

        let bytes = DatPack::pack(&model).expect("valid SetupModel must pack");

        let mut cursor = Cursor::new(bytes.clone());
        let reparsed = SetupModel::unpack(&mut cursor).expect("packed bytes must re-unpack");

        assert_eq!(reparsed.id, model.id);
        assert_eq!(reparsed.flags, model.flags);
        assert_eq!(reparsed.parts, model.parts);
        assert_eq!(reparsed.parent_index, model.parent_index);
        assert_eq!(reparsed.default_scale.len(), model.default_scale.len());
        assert_eq!(reparsed.height, model.height);
        assert_eq!(reparsed.radius, model.radius);
        assert_eq!(reparsed.default_script_table, model.default_script_table);

        // Byte idempotence.
        let bytes2 = DatPack::pack(&reparsed).expect("re-parsed SetupModel must pack");
        assert_eq!(bytes, bytes2, "SetupModel pack must be byte-for-byte idempotent");

        assert_eq!(DatPack::type_id(&model), DatFileType::SetupModel as u32);
        assert_eq!(DatPack::id(&model), 0x0200_0099);
    }

    #[test]
    fn setup_model_with_parent_and_scale_round_trips() {
        let mut model = base_model();
        model.flags = HAS_PARENT | HAS_DEFAULT_SCALE;
        model.parent_index = vec![0xFFFF_FFFF, 0];
        model.default_scale = vec![Vector3::new(1.0, 1.0, 1.0), Vector3::new(2.0, 2.0, 2.0)];

        let bytes = DatPack::pack(&model).expect("valid SetupModel with parent/scale must pack");
        let mut cursor = Cursor::new(bytes.clone());
        let reparsed = SetupModel::unpack(&mut cursor).expect("must re-unpack");

        assert_eq!(reparsed.parent_index, model.parent_index);
        assert_eq!(reparsed.default_scale.len(), 2);

        let bytes2 = DatPack::pack(&reparsed).expect("re-parsed must pack");
        assert_eq!(bytes, bytes2);
    }

    #[test]
    fn negative_has_parent_set_without_parent_array_is_rejected() {
        let mut model = base_model();
        model.flags = HAS_PARENT; // set but parent_index left empty
        let err = DatPack::pack(&model).expect_err("HasParent without array must be rejected");
        match err {
            WriteError::InvariantViolation { reason, .. } => {
                assert!(reason.contains("HasParent"), "reason: {reason}");
            }
            other => panic!("expected InvariantViolation, got {other:?}"),
        }
    }

    #[test]
    fn negative_scale_array_without_flag_is_rejected_not_panicked() {
        let mut model = base_model();
        model.flags = 0; // clear
        model.default_scale = vec![Vector3::new(1.0, 1.0, 1.0), Vector3::new(1.0, 1.0, 1.0)];
        let err = DatPack::pack(&model)
            .expect_err("default_scale without HasDefaultScale must be rejected");
        assert!(matches!(err, WriteError::InvariantViolation { .. }));
    }
}
