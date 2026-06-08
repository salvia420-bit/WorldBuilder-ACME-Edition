//! `impl DatPack for Surface` — delegates to the new `Surface::pack`
//! (E12 design §B, WRITE-NEW type 0x08) and enforces the textured-XOR-solid
//! invariant (§B.5 #7-8).
//!
//! A Surface body is MUTUALLY EXCLUSIVE: when the `surface_type` bitfield has
//! either `Base1Image (0x02)` or `Base1ClipMap (0x04)` set (mask `0x06`), the
//! body is `(orig_texture_id, orig_palette_id)` and carries NO `color_value`;
//! otherwise (solid) the body is a single ARGB `color_value` and carries NO
//! texture refs. The reader gates the two `Option` fields on exactly this
//! mask, so a record whose populated field disagrees with its own type
//! bitfield cannot be re-read after writing.
//!
//! The guard fails closed BEFORE `Surface::pack` runs:
//! - textured type (`& 0x06 != 0`) MUST carry `texture_refs` and MUST NOT
//!   carry `color_value`;
//! - solid type (`& 0x06 == 0`) MUST carry `color_value` and MUST NOT carry
//!   `texture_refs`.
//!
//! Per §B this does NOT attempt cross-record palette-index resolution — that
//! is the deferred Texture / RenderTexture work. It only enforces the
//! intra-record textured-XOR-solid routing.

use holtburger_dat::DatFileType;
use holtburger_dat::file_type::Surface;
use holtburger_dat::file_type::surface::SURFACE_TYPE_TEXTURE_MASK;

use crate::DatPack;
use crate::error::{Result, WriteError};

impl DatPack for Surface {
    fn pack(&self) -> Result<Vec<u8>> {
        // Fail closed: enforce textured-XOR-solid before producing bytes.
        validate(self)?;

        Ok(Surface::pack(self)?)
    }

    fn type_id(&self) -> u32 {
        DatFileType::Surface as u32
    }

    fn id(&self) -> u32 {
        // Surface (unlike Palette / SurfaceTexture) has NO leading id field —
        // its file id lives in the dat directory entry, not the record body,
        // so it is NOT derivable from the record. We report 0 only because the
        // trait signature is `fn id(&self) -> u32` and cannot signal "absent".
        //
        // WARNING: 0 is NOT a usable DAT key. `AddTyped::add_typed` keys an
        // entry purely by `obj.id()`, so a Surface MUST NOT be written through
        // `add_typed` (which now fail-closes on `id()==0`). Write a Surface via
        // `AddTyped::add_typed_with_id(namespace, real_did, surface)`, which
        // supplies the real DID at the container layer.
        0
    }
}

/// §B.5 #7-8 — textured XOR solid, gated on the `surface_type` bitfield mask
/// `0x06` (`Base1Image | Base1ClipMap`). The two bodies are mutually
/// exclusive; reject any record that misroutes.
fn validate(surface: &Surface) -> Result<()> {
    let type_id = DatFileType::Surface as u32;
    // Surface carries no body id field, so error attribution uses 0 here. This
    // is for the InvariantViolation message only; it is NOT the DAT key (see
    // the WARNING on `id()` — Surface must be keyed with its real DID via the
    // raw `add`, not via the id-less `add_typed`).
    let file_id = 0;
    let is_textured = (surface.surface_type & SURFACE_TYPE_TEXTURE_MASK) != 0;

    if is_textured {
        // Textured type: must have texture_refs, must NOT have color_value.
        if surface.texture_refs.is_none() {
            return Err(violation(
                type_id,
                file_id,
                format!(
                    "surface_type 0x{:08X} is textured (& 0x06) but texture_refs is None",
                    surface.surface_type
                ),
            ));
        }
        if surface.color_value.is_some() {
            return Err(violation(
                type_id,
                file_id,
                format!(
                    "surface_type 0x{:08X} is textured (& 0x06) but also carries a color_value \
                     (textured XOR solid violated)",
                    surface.surface_type
                ),
            ));
        }
    } else {
        // Solid type: must have color_value, must NOT have texture_refs.
        if surface.color_value.is_none() {
            return Err(violation(
                type_id,
                file_id,
                format!(
                    "surface_type 0x{:08X} is solid (& 0x06 == 0) but color_value is None",
                    surface.surface_type
                ),
            ));
        }
        if surface.texture_refs.is_some() {
            return Err(violation(
                type_id,
                file_id,
                format!(
                    "surface_type 0x{:08X} is solid (& 0x06 == 0) but also carries texture_refs \
                     (textured XOR solid violated)",
                    surface.surface_type
                ),
            ));
        }
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
    use holtburger_dat::file_type::SurfaceTextureRefs;

    fn solid(surface_type: u32, color: Option<u32>) -> Surface {
        Surface {
            surface_type,
            texture_refs: None,
            color_value: color,
            translucency: 0.0,
            luminosity: 0.25,
            diffuse: 0.75,
        }
    }

    fn textured(surface_type: u32, refs: Option<SurfaceTextureRefs>) -> Surface {
        Surface {
            surface_type,
            texture_refs: refs,
            color_value: None,
            translucency: 0.1,
            luminosity: 0.2,
            diffuse: 0.3,
        }
    }

    #[test]
    fn solid_surface_pack_round_trips_byte_and_structurally_equal() {
        // Base1Solid (0x01) → solid body.
        let s = solid(0x01, Some(0xFF8B_6442));

        let bytes = DatPack::pack(&s).expect("valid solid Surface must pack");
        assert_eq!(bytes.len(), 20);

        let reparsed = Surface::unpack(&bytes).expect("packed bytes must re-unpack");
        assert_eq!(reparsed.surface_type, 0x01);
        assert_eq!(reparsed.color_value, Some(0xFF8B_6442));
        assert!(reparsed.texture_refs.is_none());

        assert_eq!(bytes, s.pack().expect("underlying pack"));

        let bytes2 = DatPack::pack(&reparsed).expect("re-parsed must pack");
        assert_eq!(bytes, bytes2, "solid Surface pack must be byte-for-byte idempotent");

        assert_eq!(DatPack::type_id(&s), DatFileType::Surface as u32);
    }

    #[test]
    fn textured_surface_pack_round_trips_byte_and_structurally_equal() {
        // Base1Image (0x02) → textured body.
        let s = textured(
            0x02,
            Some(SurfaceTextureRefs {
                orig_texture_id: 0x0500_1000,
                orig_palette_id: 0x0400_1000,
            }),
        );

        let bytes = DatPack::pack(&s).expect("valid textured Surface must pack");
        assert_eq!(bytes.len(), 24);

        let reparsed = Surface::unpack(&bytes).expect("packed bytes must re-unpack");
        assert_eq!(reparsed.surface_type, 0x02);
        assert!(reparsed.color_value.is_none());
        assert_eq!(reparsed.textured(), Some((0x0500_1000, 0x0400_1000)));

        let bytes2 = DatPack::pack(&reparsed).expect("re-parsed must pack");
        assert_eq!(bytes, bytes2, "textured Surface pack must be byte-for-byte idempotent");
    }

    #[test]
    fn clipmap_type_takes_textured_branch() {
        // Base1ClipMap (0x04) also routes textured.
        let s = textured(
            0x04,
            Some(SurfaceTextureRefs {
                orig_texture_id: 0x0500_2222,
                orig_palette_id: 0x0400_3333,
            }),
        );
        let bytes = DatPack::pack(&s).expect("clipmap Surface must pack");
        let reparsed = Surface::unpack(&bytes).expect("must re-unpack");
        assert_eq!(reparsed.textured(), Some((0x0500_2222, 0x0400_3333)));
    }

    #[test]
    fn negative_textured_type_carrying_color_value_is_rejected() {
        // surface_type textured (Base1Image 0x02) but a color_value is set →
        // textured XOR solid violated. Must be InvariantViolation, not panic,
        // not misrouted bytes.
        let mut s = textured(
            0x02,
            Some(SurfaceTextureRefs {
                orig_texture_id: 0x0500_1000,
                orig_palette_id: 0x0400_1000,
            }),
        );
        s.color_value = Some(0xFF00_0000); // illegal under textured type
        let err = DatPack::pack(&s).expect_err("textured type with color_value must be rejected");
        match err {
            WriteError::InvariantViolation { type_id, reason, .. } => {
                assert_eq!(type_id, DatFileType::Surface as u32);
                assert!(reason.contains("textured XOR solid"), "reason: {reason}");
            }
            other => panic!("expected InvariantViolation, got {other:?}"),
        }
    }

    #[test]
    fn negative_solid_type_carrying_texture_refs_is_rejected() {
        // surface_type solid (Base1Solid 0x01) but texture_refs set → reject.
        let mut s = solid(0x01, Some(0xFF8B_6442));
        s.texture_refs = Some(SurfaceTextureRefs {
            orig_texture_id: 0x0500_0001,
            orig_palette_id: 0x0400_0001,
        });
        let err = DatPack::pack(&s).expect_err("solid type with texture_refs must be rejected");
        match err {
            WriteError::InvariantViolation { reason, .. } => {
                assert!(reason.contains("textured XOR solid"), "reason: {reason}");
            }
            other => panic!("expected InvariantViolation, got {other:?}"),
        }
    }

    #[test]
    fn negative_textured_type_missing_refs_is_rejected_not_panicked() {
        // textured type but texture_refs None → reject (the underlying
        // Surface::write would also error, but the guard catches it first).
        let s = textured(0x02, None);
        let err = DatPack::pack(&s).expect_err("textured type without refs must be rejected");
        assert!(matches!(err, WriteError::InvariantViolation { .. }));
    }

    #[test]
    fn negative_solid_type_missing_color_is_rejected_not_panicked() {
        let s = solid(0x01, None);
        let err = DatPack::pack(&s).expect_err("solid type without color must be rejected");
        assert!(matches!(err, WriteError::InvariantViolation { .. }));
    }
}
