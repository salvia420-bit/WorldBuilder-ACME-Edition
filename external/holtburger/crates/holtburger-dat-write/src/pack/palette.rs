//! `impl DatPack for Palette` — delegates to the new `Palette::pack`
//! (E12 design §B, WRITE-NEW type 0x04) and enforces the count invariant.
//!
//! `Palette` stores no explicit colour-count field — the count is derived
//! from `colors.len()` and written as an `i32` (the exact inverse of the
//! parser's `i32` count read). The §B invariant "emitted colour count ==
//! colors.len()" is therefore structurally guaranteed by construction; the
//! only way it can be violated is if `colors.len()` cannot be represented in
//! the `i32` the wire format uses. The guard checks that bound up front and
//! fails closed with [`WriteError::InvariantViolation`] (rather than leaking
//! a raw `binrw::Error` from the `i32::try_from` in `Palette::write`), so an
//! over-long palette is rejected attributably instead of producing a
//! truncated/negative on-wire count.

use holtburger_dat::DatFileType;
use holtburger_dat::file_type::Palette;

use crate::DatPack;
use crate::error::{Result, WriteError};

impl DatPack for Palette {
    fn pack(&self) -> Result<Vec<u8>> {
        // Fail closed: validate the count is wire-representable before bytes.
        validate_color_count(self.id, self.colors.len())?;

        Ok(Palette::pack(self)?)
    }

    fn type_id(&self) -> u32 {
        DatFileType::Palette as u32
    }

    fn id(&self) -> u32 {
        self.id
    }
}

/// §B Palette count invariant: the colour count emitted on the wire is the
/// `i32` form of `colors.len()`. Reject any length that does not fit an
/// `i32` (which would otherwise serialize as a negative/truncated count the
/// reader cannot honour). Split out from `pack` so the boundary can be
/// exercised by a negative test without allocating billions of entries.
fn validate_color_count(file_id: u32, len: usize) -> Result<()> {
    if i32::try_from(len).is_err() {
        return Err(WriteError::InvariantViolation {
            type_id: DatFileType::Palette as u32,
            file_id,
            reason: format!(
                "palette colour count {len} exceeds i32::MAX and cannot be emitted as the wire count"
            ),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pal(id: u32, colors: Vec<u32>) -> Palette {
        Palette { id, colors }
    }

    #[test]
    fn palette_pack_round_trips_byte_and_structurally_equal() {
        let p = pal(0x0400_1234, vec![0xFFFF_FFFF, 0xFFFF_0000, 0xFF00_FF00]);

        let bytes = DatPack::pack(&p).expect("valid Palette must pack");

        let reparsed = Palette::unpack(&bytes).expect("packed bytes must re-unpack");
        assert_eq!(reparsed.id, p.id);
        assert_eq!(reparsed.colors, p.colors);

        // The DatPack wrapper output equals the underlying pack (count derived
        // from colors.len(), so the count == colors.len() invariant holds).
        assert_eq!(bytes, p.pack().expect("underlying pack"));

        // id (4) + count (4) + 3 colours (12) = 20 bytes.
        assert_eq!(bytes.len(), 20);

        let bytes2 = DatPack::pack(&reparsed).expect("re-parsed must pack");
        assert_eq!(bytes, bytes2, "Palette pack must be byte-for-byte idempotent");

        assert_eq!(DatPack::type_id(&p), DatFileType::Palette as u32);
        assert_eq!(DatPack::id(&p), 0x0400_1234);
    }

    #[test]
    fn empty_palette_round_trips() {
        let p = pal(0x0400_0001, vec![]);
        let bytes = DatPack::pack(&p).expect("empty Palette must pack");
        assert_eq!(bytes.len(), 8); // id + count
        let reparsed = Palette::unpack(&bytes).expect("must re-unpack");
        assert!(reparsed.colors.is_empty());
    }

    #[test]
    fn negative_oversized_count_is_invariant_violation_not_panic() {
        // A colour count beyond i32::MAX cannot be emitted as the i32 wire
        // count — the guard must reject it as an InvariantViolation rather
        // than panicking or producing a negative/truncated count. Exercised
        // via the split-out helper so no allocation is required.
        let oversized = (i32::MAX as usize) + 1;
        let err = validate_color_count(0x0400_0042, oversized)
            .expect_err("oversized palette count must be rejected");
        match err {
            WriteError::InvariantViolation { type_id, file_id, reason } => {
                assert_eq!(type_id, DatFileType::Palette as u32);
                assert_eq!(file_id, 0x0400_0042);
                assert!(reason.contains("exceeds i32::MAX"), "reason: {reason}");
            }
            other => panic!("expected InvariantViolation, got {other:?}"),
        }
        // And a representable count passes.
        validate_color_count(0, 256).expect("256-colour palette must validate");
    }
}
