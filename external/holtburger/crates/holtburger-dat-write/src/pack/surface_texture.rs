//! `impl DatPack for SurfaceTexture` — delegates to the new
//! `SurfaceTexture::pack` (E12 design §B, WRITE-NEW type 0x05) and enforces
//! the count + highest-res invariants.
//!
//! `SurfaceTexture` stores no explicit texture-id count field — the count is
//! derived from `textures.len()` and written as an `i32` (the exact inverse
//! of the parser's `i32` count read), so the §B "emitted id count ==
//! ids.len()" invariant holds by construction; only an `i32`-unrepresentable
//! length can violate it, which the guard rejects up front.
//!
//! The §B "highest_res == last id" invariant is likewise structural:
//! [`SurfaceTexture::highest_res`] is defined as `textures.last()`, so it can
//! only ever equal the last emitted id. The guard asserts that relationship
//! defensively (and rejects a wire-unrepresentable count) so the property is
//! pinned at the write boundary, not merely assumed.

use holtburger_dat::DatFileType;
use holtburger_dat::file_type::SurfaceTexture;

use crate::DatPack;
use crate::error::{Result, WriteError};

impl DatPack for SurfaceTexture {
    fn pack(&self) -> Result<Vec<u8>> {
        // Fail closed: validate before producing bytes.
        validate(self)?;

        Ok(SurfaceTexture::pack(self)?)
    }

    fn type_id(&self) -> u32 {
        DatFileType::SurfaceTexture as u32
    }

    fn id(&self) -> u32 {
        self.id
    }
}

fn validate(st: &SurfaceTexture) -> Result<()> {
    let type_id = DatFileType::SurfaceTexture as u32;
    let file_id = st.id;

    // §B count invariant: the id count emitted is the i32 form of
    // textures.len(); reject any length that cannot be the i32 wire count.
    if i32::try_from(st.textures.len()).is_err() {
        return Err(violation(
            type_id,
            file_id,
            format!(
                "texture id count {} exceeds i32::MAX and cannot be emitted as the wire count",
                st.textures.len()
            ),
        ));
    }

    // §B highest_res invariant: highest_res() is the LAST id. This is
    // structural (it is defined as `textures.last()`), but pin it at the
    // write boundary so a future refactor that decouples the two is caught.
    match st.highest_res() {
        Some(hr) => {
            let last = st
                .textures
                .last()
                .copied()
                .expect("highest_res Some implies a last entry");
            if hr != last {
                return Err(violation(
                    type_id,
                    file_id,
                    format!("highest_res 0x{hr:08X} != last texture id 0x{last:08X}"),
                ));
            }
        }
        None => {
            if !st.textures.is_empty() {
                return Err(violation(
                    type_id,
                    file_id,
                    "highest_res is None but textures is non-empty".to_string(),
                ));
            }
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

    fn st(id: u32, textures: Vec<u32>) -> SurfaceTexture {
        SurfaceTexture {
            id,
            unknown_int: 7,
            unknown_byte: 2,
            textures,
        }
    }

    #[test]
    fn surface_texture_pack_round_trips_byte_and_structurally_equal() {
        let s = st(0x0500_1234, vec![0x0600_1000, 0x0600_1001, 0x0600_1002]);

        let bytes = DatPack::pack(&s).expect("valid SurfaceTexture must pack");

        let reparsed = SurfaceTexture::unpack(&bytes).expect("packed bytes must re-unpack");
        assert_eq!(reparsed.id, s.id);
        assert_eq!(reparsed.unknown_int, s.unknown_int);
        assert_eq!(reparsed.unknown_byte, s.unknown_byte);
        assert_eq!(reparsed.textures, s.textures);
        assert_eq!(reparsed.highest_res(), Some(0x0600_1002));

        assert_eq!(bytes, s.pack().expect("underlying pack"));

        // id(4) + unknown_int(4) + unknown_byte(1) + count(4) + 3 ids(12) = 25.
        assert_eq!(bytes.len(), 25);

        let bytes2 = DatPack::pack(&reparsed).expect("re-parsed must pack");
        assert_eq!(
            bytes, bytes2,
            "SurfaceTexture pack must be byte-for-byte idempotent"
        );

        assert_eq!(DatPack::type_id(&s), DatFileType::SurfaceTexture as u32);
        assert_eq!(DatPack::id(&s), 0x0500_1234);
    }

    #[test]
    fn empty_surface_texture_round_trips() {
        let s = st(0x0500_0001, vec![]);
        let bytes = DatPack::pack(&s).expect("empty SurfaceTexture must pack");
        let reparsed = SurfaceTexture::unpack(&bytes).expect("must re-unpack");
        assert!(reparsed.textures.is_empty());
        assert_eq!(reparsed.highest_res(), None);
    }
}
