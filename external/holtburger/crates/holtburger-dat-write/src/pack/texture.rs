//! `impl DatPack for Texture` — delegates to the new `Texture::pack`
//! (E12 design §B, WRITE-NEW type 0x06) and enforces the INTRA-RECORD
//! invariants §B.5 #10-12.
//!
//! PALETTE-RESOLUTION DECISION (E12c slice-2, resolved): the trait
//! [`DatPack::pack`] path validates INTRA-RECORD only:
//!
//! - `width * height` vs the format's bytes-per-pixel must be consistent with
//!   `source_data.len()` (§B.5 #12) — but ONLY for the fixed-bytes-per-pixel
//!   formats. Block-compressed (`Dxt1/3/5`) and `CustomRawJpeg` carry
//!   variable-length / self-describing payloads, so their `source_data` is
//!   serialized verbatim and the width×height×bpp check is skipped (it would be
//!   meaningless / wrong for them). `Unknown` / `Other` formats are likewise
//!   not size-checked (we do not know their layout) — they round-trip verbatim.
//! - `default_palette_id` MUST be `Some` iff the format is palette-indexed
//!   (P8 / Index16, [`SurfacePixelFormat::needs_palette`]) and MUST be `None`
//!   otherwise (§B.5 #10, intra-record half). This matches exactly the
//!   condition the reader gates the trailing `Option<u32>` on, so a record that
//!   misroutes here could not be re-read after writing.
//!
//! It does NOT attempt cross-record pixel-index < palette.len() validation —
//! `DatPack::pack` has no palette parameter. That cross-record check lives in
//! the SEPARATE inherent `Texture::pack_validated` (deferred from the trait
//! path per §B.5 #11), authored next to the parser in
//! `holtburger-dat/src/file_type/texture.rs` because the orphan rule forbids an
//! inherent `impl Texture` block in this crate. It takes the resolved
//! [`Palette`] and rejects any out-of-bounds index before producing bytes.

use holtburger_dat::DatFileType;
use holtburger_dat::file_type::{SurfacePixelFormat, Texture};

use crate::DatPack;
use crate::error::{Result, WriteError};

impl DatPack for Texture {
    fn pack(&self) -> Result<Vec<u8>> {
        // Fail closed: intra-record validation before any bytes.
        validate_intra(self)?;

        Ok(Texture::pack(self)?)
    }

    fn type_id(&self) -> u32 {
        DatFileType::Texture as u32
    }

    fn id(&self) -> u32 {
        self.id
    }
}

/// Bytes-per-pixel for the fixed-layout (non-compressed, non-JPEG) formats.
/// Returns `None` for variable-length / self-describing / unknown formats,
/// which are serialized verbatim and not size-checked.
fn fixed_bytes_per_pixel(format: SurfacePixelFormat) -> Option<usize> {
    match format {
        SurfacePixelFormat::R8G8B8 | SurfacePixelFormat::CustomLscapeR8G8B8 => Some(3),
        SurfacePixelFormat::A8R8G8B8 => Some(4),
        SurfacePixelFormat::A8 | SurfacePixelFormat::CustomLscapeAlpha | SurfacePixelFormat::P8 => {
            Some(1)
        }
        SurfacePixelFormat::Index16
        | SurfacePixelFormat::R5G6B5
        | SurfacePixelFormat::A4R4G4B4 => Some(2),
        // Block-compressed / JPEG / unknown — variable length, verbatim.
        // HUD rec #203 (2026-06-16): DXT2 + DXT4 join the block-
        // compressed family alongside DXT1/DXT3/DXT5; same variable-
        // length verbatim handling.
        SurfacePixelFormat::Dxt1
        | SurfacePixelFormat::Dxt2
        | SurfacePixelFormat::Dxt3
        | SurfacePixelFormat::Dxt4
        | SurfacePixelFormat::Dxt5
        | SurfacePixelFormat::CustomRawJpeg
        | SurfacePixelFormat::Unknown
        | SurfacePixelFormat::Other(_) => None,
    }
}

/// §B.5 #10 (intra-record half) + #12 — palette-id presence routing and
/// width×height×bpp vs source length. Does NOT touch palette contents.
fn validate_intra(tex: &Texture) -> Result<()> {
    let type_id = DatFileType::Texture as u32;
    let file_id = tex.id;
    let format = tex.format();

    // §B.5 #10 (intra half): default_palette_id present XOR not, gated on the
    // exact `needs_palette()` condition the reader uses for the Option field.
    let needs_pal = format.needs_palette();
    match (needs_pal, tex.default_palette_id) {
        (true, None) => {
            return Err(violation(
                type_id,
                file_id,
                format!(
                    "format {format:?} is palette-indexed but default_palette_id is None \
                     (indexed-format record requires a default_palette_id)"
                ),
            ));
        }
        (false, Some(pid)) => {
            return Err(violation(
                type_id,
                file_id,
                format!(
                    "format {format:?} is not palette-indexed but carries a \
                     default_palette_id 0x{pid:08X} (would not round-trip — the reader \
                     only reads the trailing id for P8/Index16)"
                ),
            ));
        }
        _ => {}
    }

    // §B.5 #12: width × height × bpp == source_data.len() for fixed formats.
    if let Some(bpp) = fixed_bytes_per_pixel(format) {
        if tex.width < 0 || tex.height < 0 {
            return Err(violation(
                type_id,
                file_id,
                format!(
                    "format {format:?} has negative dimensions {}x{}",
                    tex.width, tex.height
                ),
            ));
        }
        let w = tex.width as usize;
        let h = tex.height as usize;
        let expected = w
            .checked_mul(h)
            .and_then(|px| px.checked_mul(bpp))
            .ok_or_else(|| {
                violation(
                    type_id,
                    file_id,
                    format!("width*height*bpp overflowed for {format:?} {w}x{h}"),
                )
            })?;
        if tex.source_data.len() != expected {
            return Err(violation(
                type_id,
                file_id,
                format!(
                    "source_data.len()={} != width*height*bpp={} \
                     (format {format:?}, {w}x{h}, {bpp} bytes/pixel)",
                    tex.source_data.len(),
                    expected
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

// NOTE: the cross-record `Texture::pack_validated(&self, palette: &Palette)`
// path (§B.5 #11) is authored next to the parser in
// `holtburger-dat/src/file_type/texture.rs` — the orphan rule forbids an
// inherent `impl Texture` here. Its negative (out-of-bounds index) test lives
// there too; this module covers the trait/intra-record half only.

#[cfg(test)]
mod tests {
    use super::*;

    fn tex(
        id: u32,
        format: u32,
        width: i32,
        height: i32,
        data: Vec<u8>,
        pal: Option<u32>,
    ) -> Texture {
        Texture {
            id,
            _unknown: 0,
            width,
            height,
            format_raw: format,
            length: data.len() as i32,
            source_data: data,
            default_palette_id: pal,
        }
    }

    #[test]
    fn non_palettized_texture_round_trips_byte_and_structurally_equal() {
        // CustomLscapeR8G8B8 (243): 2x2, 3 bpp = 12 bytes.
        let t = tex(0x0600_1234, 243, 2, 2, vec![1u8; 12], None);

        let bytes = DatPack::pack(&t).expect("valid Texture must pack");

        let reparsed = Texture::unpack(&bytes).expect("packed bytes must re-unpack");
        assert_eq!(reparsed.id, t.id);
        assert_eq!(reparsed.width, t.width);
        assert_eq!(reparsed.height, t.height);
        assert_eq!(reparsed.format_raw, t.format_raw);
        assert_eq!(reparsed.source_data, t.source_data);
        assert!(reparsed.default_palette_id.is_none());

        assert_eq!(bytes, t.pack().expect("underlying pack"));

        let bytes2 = DatPack::pack(&reparsed).expect("re-parsed must pack");
        assert_eq!(bytes, bytes2, "Texture pack must be byte-for-byte idempotent");

        assert_eq!(DatPack::type_id(&t), DatFileType::Texture as u32);
        assert_eq!(DatPack::id(&t), 0x0600_1234);
    }

    #[test]
    fn palettized_p8_round_trips_with_palette_id() {
        // P8 (41): 3x1, 1 bpp = 3 bytes; requires default_palette_id.
        let t = tex(0x0600_5555, 41, 3, 1, vec![0u8, 1, 2], Some(0x0400_1000));
        let bytes = DatPack::pack(&t).expect("valid P8 Texture must pack");
        let reparsed = Texture::unpack(&bytes).expect("re-unpack");
        assert_eq!(reparsed.format(), SurfacePixelFormat::P8);
        assert_eq!(reparsed.default_palette_id, Some(0x0400_1000));
        let bytes2 = DatPack::pack(&reparsed).expect("re-pack");
        assert_eq!(bytes, bytes2);
    }

    #[test]
    fn jpeg_texture_round_trips_verbatim_no_size_check() {
        // CustomRawJpeg (500): header dims 0,0; arbitrary payload, no size check.
        let t = tex(0x0600_9999, 500, 0, 0, vec![0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3], None);
        let bytes = DatPack::pack(&t).expect("JPEG Texture must pack verbatim");
        let reparsed = Texture::unpack(&bytes).expect("re-unpack");
        assert_eq!(reparsed.source_data, t.source_data);
    }

    #[test]
    fn negative_indexed_format_missing_palette_id_is_rejected() {
        // P8 without default_palette_id → InvariantViolation (indexed-format
        // record requires default_palette_id), not panic, not bad bytes.
        let t = tex(0x0600_0042, 41, 2, 2, vec![0u8; 4], None);
        let err = DatPack::pack(&t).expect_err("P8 without palette id must be rejected");
        match err {
            WriteError::InvariantViolation { type_id, file_id, reason } => {
                assert_eq!(type_id, DatFileType::Texture as u32);
                assert_eq!(file_id, 0x0600_0042);
                assert!(reason.contains("palette-indexed"), "reason: {reason}");
            }
            other => panic!("expected InvariantViolation, got {other:?}"),
        }
    }

    #[test]
    fn negative_non_indexed_format_carrying_palette_id_is_rejected() {
        // A8R8G8B8 (21) with a default_palette_id → would not round-trip.
        let t = tex(0x0600_0043, 21, 1, 1, vec![0u8; 4], Some(0x0400_2000));
        let err = DatPack::pack(&t).expect_err("non-indexed with palette id must be rejected");
        assert!(matches!(err, WriteError::InvariantViolation { .. }));
    }

    #[test]
    fn negative_size_mismatch_is_rejected_not_panicked() {
        // A8R8G8B8 (21): 2x2 needs 16 bytes; supply 10 → reject.
        let t = tex(0x0600_0044, 21, 2, 2, vec![0u8; 10], None);
        let err = DatPack::pack(&t).expect_err("size mismatch must be rejected");
        match err {
            WriteError::InvariantViolation { reason, .. } => {
                assert!(reason.contains("width*height*bpp"), "reason: {reason}");
            }
            other => panic!("expected InvariantViolation, got {other:?}"),
        }
    }

    // The cross-record `pack_validated` in-bounds-accept / out-of-bounds-reject
    // tests live next to the inherent method in
    // holtburger-dat/src/file_type/texture.rs (orphan rule — see the NOTE above).
}
