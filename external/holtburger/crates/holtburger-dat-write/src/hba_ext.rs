//! Type-aware container helpers: `add_typed` on `HbaWriter` and
//! `HbaStreamWriter` (E12 design §B.2 / §B.3).
//!
//! Mirrors C# `DatEasyWriter.Save<T>`: serialize a typed record via
//! [`DatPack`], then forward `(namespace, obj.id(), obj.type_id(), bytes)`
//! to the container's existing raw `add`. The raw `add(Vec<u8>)` path is
//! left untouched — `add_typed` is purely additive sugar that removes the
//! need for callers to hand-serialize and hand-supply the `type_id`.
//!
//! IDs are user-provided (taken from the record), not auto-allocated, and
//! iteration / namespace auto-routing are out of scope for E12b (the caller
//! supplies the namespace explicitly). The container's deterministic
//! ordering, duplicate-`(namespace, file_id)` rejection, compression toggle
//! and pruned-flag handling are all inherited for free from the underlying
//! `add`.

use holtburger_dat::{HbaStreamWriter, HbaWriter};

use crate::error::Result;
use crate::DatPack;

/// Extension trait adding a type-aware write to a DAT container writer.
///
/// Implemented for both the in-memory [`HbaWriter`] and the streaming
/// [`HbaStreamWriter`]. The method delegates to the writer's raw `add`, so
/// it shares its duplicate-rejection and ordering semantics.
pub trait AddTyped {
    /// Pack `obj` (running its invariant guards) and add it to this
    /// container under `namespace`, keyed by `obj.id()` with `obj.type_id()`.
    ///
    /// Returns [`crate::WriteError::InvariantViolation`] if the record fails
    /// its guards (no bytes are written), or the container's
    /// [`holtburger_dat::DatError`] (bridged) on a duplicate key /
    /// namespace error.
    fn add_typed<T: DatPack>(&mut self, namespace: &str, obj: &T) -> Result<()>;
}

impl AddTyped for HbaWriter {
    fn add_typed<T: DatPack>(&mut self, namespace: &str, obj: &T) -> Result<()> {
        let data = obj.pack()?;
        self.add(namespace, obj.id(), obj.type_id(), data)?;
        Ok(())
    }
}

impl AddTyped for HbaStreamWriter {
    fn add_typed<T: DatPack>(&mut self, namespace: &str, obj: &T) -> Result<()> {
        let data = obj.pack()?;
        self.add(namespace, obj.id(), obj.type_id(), data)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::Vector3;
    use holtburger_common::properties::GfxObjFlags;
    use holtburger_dat::file_type::GfxObj;
    use holtburger_dat::graphics::CVertexArray;
    use holtburger_dat::{DatFileType, EOR_PORTAL_NAMESPACE, HbaReader};
    use std::collections::HashMap;

    fn simple_gfx_obj(id: u32) -> GfxObj {
        GfxObj {
            id,
            flags: GfxObjFlags::NONE,
            surfaces: vec![0x0800_0001],
            vertex_array: CVertexArray {
                vertex_type: 1,
                vertices: HashMap::new(),
            },
            physics_polygons: HashMap::new(),
            physics_bsp: None,
            sort_center: Vector3::zero(),
            polygons: HashMap::new(),
            drawing_bsp: None,
            did_degrade: None,
        }
    }

    #[test]
    fn add_typed_writes_entry_readable_by_namespace_and_id() {
        let obj = simple_gfx_obj(0x0100_00AB);
        let expected = DatPack::pack(&obj).expect("pack");

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("typed.hba");

        let mut writer = HbaWriter::new();
        writer.set_compression(false);
        writer
            .add_typed(EOR_PORTAL_NAMESPACE, &obj)
            .expect("add_typed must succeed for a valid GfxObj");
        writer.write(&path).expect("write hba");

        // Re-open and find the entry by (namespace, file_id).
        let reader = HbaReader::open(&path).expect("open hba");
        let bytes = reader
            .get_file_in_namespace(EOR_PORTAL_NAMESPACE, 0x0100_00AB)
            .expect("entry must be retrievable by (namespace, file_id)");
        assert_eq!(bytes, expected, "stored bytes must equal DatPack::pack output");

        // The type_id stored in the index must be DatFileType::Model.
        let mut found_type = None;
        for entry in reader.entries() {
            let entry = entry.expect("entry must decode");
            if entry.file_id == 0x0100_00AB {
                found_type = Some(entry.type_id);
            }
        }
        assert_eq!(found_type, Some(DatFileType::Model as u32));
    }

    #[test]
    fn add_typed_propagates_invariant_violation_without_writing() {
        // A GfxObj whose flag/presence is inconsistent must be rejected by
        // add_typed (the guard fires inside pack()) with no entry added.
        let mut obj = simple_gfx_obj(0x0100_00CD);
        obj.flags = GfxObjFlags::HAS_DRAWING; // no drawing_bsp → violation

        let mut writer = HbaWriter::new();
        let err = writer
            .add_typed(EOR_PORTAL_NAMESPACE, &obj)
            .expect_err("inconsistent GfxObj must be rejected by add_typed");
        assert!(matches!(
            err,
            crate::WriteError::InvariantViolation { .. }
        ));
    }
}
