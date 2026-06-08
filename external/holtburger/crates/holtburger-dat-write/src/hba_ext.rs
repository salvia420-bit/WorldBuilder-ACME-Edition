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
use crate::{DatPack, WriteError};

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

    /// Like [`AddTyped::add_typed`] but keys the entry under an explicitly
    /// supplied `id` rather than `obj.id()`. Required for body-id-less record
    /// types (e.g. `Surface`, whose DID lives in the dat-directory entry, not
    /// the record body, so `Surface::id()` is `0`) — the caller supplies the
    /// real DID at the container layer.
    fn add_typed_with_id<T: DatPack>(
        &mut self,
        namespace: &str,
        id: u32,
        obj: &T,
    ) -> Result<()>;
}

impl AddTyped for HbaWriter {
    fn add_typed<T: DatPack>(&mut self, namespace: &str, obj: &T) -> Result<()> {
        let id = obj.id();
        if id == 0 {
            return Err(zero_id_violation(obj.type_id()));
        }
        let data = obj.pack()?;
        self.add(namespace, id, obj.type_id(), data)?;
        Ok(())
    }

    fn add_typed_with_id<T: DatPack>(
        &mut self,
        namespace: &str,
        id: u32,
        obj: &T,
    ) -> Result<()> {
        let data = obj.pack()?;
        self.add(namespace, id, obj.type_id(), data)?;
        Ok(())
    }
}

impl AddTyped for HbaStreamWriter {
    fn add_typed<T: DatPack>(&mut self, namespace: &str, obj: &T) -> Result<()> {
        let id = obj.id();
        if id == 0 {
            return Err(zero_id_violation(obj.type_id()));
        }
        let data = obj.pack()?;
        self.add(namespace, id, obj.type_id(), data)?;
        Ok(())
    }

    fn add_typed_with_id<T: DatPack>(
        &mut self,
        namespace: &str,
        id: u32,
        obj: &T,
    ) -> Result<()> {
        let data = obj.pack()?;
        self.add(namespace, id, obj.type_id(), data)?;
        Ok(())
    }
}

/// `obj.id() == 0` signals a body-id-less record (e.g. `Surface`, whose DID
/// lives in the dat-directory entry, not the record body). Such a type must be
/// written with its real DID via [`AddTyped::add_typed_with_id`], never
/// silently keyed at DID 0 by `add_typed`. Fail closed.
fn zero_id_violation(type_id: u32) -> WriteError {
    WriteError::InvariantViolation {
        type_id,
        file_id: 0,
        reason: "add_typed requires a non-zero obj.id(); a body-id-less record \
                 (e.g. Surface) must be written via add_typed_with_id with its real DID"
            .to_string(),
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

    #[test]
    fn add_typed_rejects_zero_id_and_with_id_keys_distinctly() {
        // A body-id-less record (id()==0, e.g. Surface) must be REJECTED by
        // add_typed (the footgun guard), and instead written via
        // add_typed_with_id, which keys distinct real DIDs without the DID-0
        // collision the old Surface::id()==0 path would have caused.
        struct ZeroId;
        impl DatPack for ZeroId {
            fn pack(&self) -> Result<Vec<u8>> {
                Ok(vec![0xAA, 0xBB, 0xCC, 0xDD])
            }
            fn type_id(&self) -> u32 {
                DatFileType::Surface as u32
            }
            fn id(&self) -> u32 {
                0
            }
        }

        let mut writer = HbaWriter::new();
        writer.set_compression(false);

        let err = writer
            .add_typed(EOR_PORTAL_NAMESPACE, &ZeroId)
            .expect_err("add_typed must reject a zero id");
        assert!(matches!(err, crate::WriteError::InvariantViolation { .. }));

        writer
            .add_typed_with_id(EOR_PORTAL_NAMESPACE, 0x0800_0001, &ZeroId)
            .expect("explicit DID 0x08000001 ok");
        writer
            .add_typed_with_id(EOR_PORTAL_NAMESPACE, 0x0800_0002, &ZeroId)
            .expect("second distinct DID ok — no DID-0 collision");

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("ids.hba");
        writer.write(&path).expect("write hba");
        let reader = HbaReader::open(&path).expect("open hba");
        assert!(reader
            .get_file_in_namespace(EOR_PORTAL_NAMESPACE, 0x0800_0001)
            .is_ok());
        assert!(reader
            .get_file_in_namespace(EOR_PORTAL_NAMESPACE, 0x0800_0002)
            .is_ok());
    }
}
