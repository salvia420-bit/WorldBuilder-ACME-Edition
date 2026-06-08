//! `impl DatPack for RenderTexture` — delegates to the new
//! `RenderTexture::pack` (E12 design §B, WRITE-NEW type 0x15) and enforces the
//! count invariant.
//!
//! `RenderTexture` stores no explicit texture-id count field — the count is
//! derived from `textures.len()` and written as an `i32` (the exact inverse of
//! the parser's `i32` count read), so the count invariant holds by
//! construction; the only way it can be violated is a length that cannot be
//! represented in the `i32` wire count. The guard checks that bound up front
//! and fails closed with [`WriteError::InvariantViolation`] (rather than
//! leaking the raw `binrw::Error` from the `i32::try_from` in
//! `RenderTexture::write`), so an over-long list is rejected attributably
//! instead of producing a truncated/negative on-wire count.

use holtburger_dat::DatFileType;
use holtburger_dat::file_type::RenderTexture;

use crate::DatPack;
use crate::error::{Result, WriteError};

impl DatPack for RenderTexture {
    fn pack(&self) -> Result<Vec<u8>> {
        // Fail closed: validate the count is wire-representable before bytes.
        validate_count(self.id, self.textures.len())?;

        Ok(RenderTexture::pack(self)?)
    }

    fn type_id(&self) -> u32 {
        DatFileType::RenderTexture as u32
    }

    fn id(&self) -> u32 {
        self.id
    }
}

/// §B count invariant: the texture-id count emitted is the `i32` form of
/// `textures.len()`. Reject any length that does not fit an `i32` (which would
/// otherwise serialize as a negative/truncated count the reader cannot
/// honour). Split out from `pack` so the boundary can be exercised by a
/// negative test without allocating billions of entries.
fn validate_count(file_id: u32, len: usize) -> Result<()> {
    if i32::try_from(len).is_err() {
        return Err(WriteError::InvariantViolation {
            type_id: DatFileType::RenderTexture as u32,
            file_id,
            reason: format!(
                "render-texture id count {len} exceeds i32::MAX and cannot be emitted as the wire count"
            ),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt(id: u32, textures: Vec<u32>) -> RenderTexture {
        RenderTexture {
            id,
            unknown: -1,
            unknown_byte: 1,
            textures,
        }
    }

    #[test]
    fn render_texture_pack_round_trips_byte_and_structurally_equal() {
        let r = rt(0x1500_0000, vec![0x0600_1234, 0x0600_1235]);

        let bytes = DatPack::pack(&r).expect("valid RenderTexture must pack");

        let reparsed = RenderTexture::unpack(&bytes).expect("packed bytes must re-unpack");
        assert_eq!(reparsed.id, r.id);
        assert_eq!(reparsed.unknown, r.unknown);
        assert_eq!(reparsed.unknown_byte, r.unknown_byte);
        assert_eq!(reparsed.textures, r.textures);

        assert_eq!(bytes, r.pack().expect("underlying pack"));

        // id(4) + unknown(4) + unknown_byte(1) + count(4) + 2 ids(8) = 21.
        assert_eq!(bytes.len(), 21);

        let bytes2 = DatPack::pack(&reparsed).expect("re-parsed must pack");
        assert_eq!(
            bytes, bytes2,
            "RenderTexture pack must be byte-for-byte idempotent"
        );

        assert_eq!(DatPack::type_id(&r), DatFileType::RenderTexture as u32);
        assert_eq!(DatPack::id(&r), 0x1500_0000);
    }

    #[test]
    fn empty_render_texture_round_trips() {
        let r = rt(0x1500_0001, vec![]);
        let bytes = DatPack::pack(&r).expect("empty RenderTexture must pack");
        assert_eq!(bytes.len(), 13); // id + unknown + byte + count
        let reparsed = RenderTexture::unpack(&bytes).expect("must re-unpack");
        assert!(reparsed.textures.is_empty());
    }

    #[test]
    fn negative_oversized_count_is_invariant_violation_not_panic() {
        let oversized = (i32::MAX as usize) + 1;
        let err = validate_count(0x1500_0042, oversized)
            .expect_err("oversized count must be rejected");
        match err {
            WriteError::InvariantViolation { type_id, file_id, reason } => {
                assert_eq!(type_id, DatFileType::RenderTexture as u32);
                assert_eq!(file_id, 0x1500_0042);
                assert!(reason.contains("exceeds i32::MAX"), "reason: {reason}");
            }
            other => panic!("expected InvariantViolation, got {other:?}"),
        }
        validate_count(0, 256).expect("256-entry list must validate");
    }
}
