//! `impl DatPack for MotionKinematics` — delegates to the existing
//! `MotionKinematics::write` (E12 design §B, WRAP type 0xFFFF_FF01).
//!
//! MotionKinematics is the holtburger-native motion bundle (type id
//! `MOTION_KINEMATICS_TYPE_ID = 0xFFFF_FF01`, exposed as
//! `DatFileType::MotionKinematics`). Its `write` already emits both
//! `HashMap`-backed fields — `setup_model_defaults` and `motion_tables` —
//! with their keys SORTED (`motion_kinematics.rs` sorts `table_ids` and the
//! `write_u32_map` helper sorts its keys), satisfying the §B determinism
//! invariant at the source. The wrapper therefore adds no field-shape guard
//! beyond delegating to that deterministic `write`; reimplementing the
//! serialization here would duplicate logic and risk drift, which the WRAP
//! contract forbids.

use std::io::Cursor;

use holtburger_dat::DatFileType;
use holtburger_dat::file_type::MotionKinematics;

use crate::DatPack;
use crate::error::Result;

impl DatPack for MotionKinematics {
    fn pack(&self) -> Result<Vec<u8>> {
        let mut buf = Vec::new();
        let mut cursor = Cursor::new(&mut buf);
        // Delegate to the existing deterministic writer (sorts HashMap keys).
        MotionKinematics::write(self, &mut cursor)?;
        Ok(buf)
    }

    fn type_id(&self) -> u32 {
        // MotionKinematics is `MOTION_KINEMATICS_TYPE_ID` (0xFFFF_FF01),
        // exposed via the `DatFileType` enum — never a hardcoded literal.
        DatFileType::MotionKinematics as u32
    }

    fn id(&self) -> u32 {
        self.id
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_dat::file_type::{MotionKinematics, MotionKinematicsTable};
    use std::io::Cursor;

    fn base_motion() -> MotionKinematics {
        let mut mk = MotionKinematics::new();
        mk.setup_model_defaults.insert(0x0200_0002, 0x0900_0002);
        mk.setup_model_defaults.insert(0x0200_0001, 0x0900_0001);
        mk.motion_tables.insert(
            0x0900_0002,
            MotionKinematicsTable::new(0x0900_0002, 0x4100_0002),
        );
        mk.motion_tables.insert(
            0x0900_0001,
            MotionKinematicsTable::new(0x0900_0001, 0x4100_0001),
        );
        mk
    }

    #[test]
    fn motion_kinematics_pack_round_trips_byte_and_structurally_equal() {
        let mk = base_motion();

        let bytes = DatPack::pack(&mk).expect("valid MotionKinematics must pack");

        let mut cursor = Cursor::new(bytes.clone());
        let reparsed = MotionKinematics::read(&mut cursor).expect("packed bytes must re-unpack");

        assert_eq!(reparsed.id, mk.id);
        assert_eq!(reparsed.version, mk.version);
        assert_eq!(reparsed.setup_model_defaults, mk.setup_model_defaults);
        assert_eq!(reparsed.motion_tables.len(), mk.motion_tables.len());

        // Byte idempotence (and proves HashMap key emission is deterministic —
        // two packs of equal records must be byte-identical).
        let bytes2 = DatPack::pack(&reparsed).expect("re-parsed must pack");
        assert_eq!(
            bytes, bytes2,
            "MotionKinematics pack must be byte-for-byte idempotent / deterministic"
        );

        assert_eq!(DatPack::type_id(&mk), DatFileType::MotionKinematics as u32);
        assert_eq!(DatPack::type_id(&mk), 0xFFFF_FF01);
        assert_eq!(DatPack::id(&mk), MotionKinematics::FILE_ID);
    }
}
