//! CombatManeuverTable (DAT type 0x30, ID range `0x30000000..=0x3000FFFF`).
//!
//! Lookup table mapping (MotionStance, AttackHeight, AttackType) tuples
//! to the MotionCommand the client should animate when the player
//! initiates an attack. ACE's `CombatManeuverTable.cs` (the
//! server-authoritative reference) iterates the flat list and
//! re-indexes it into a Stance → Height → Type → [Motion] tree;
//! holtburger keeps the flat list and lets callers index as they need.
//!
//! Wire layout:
//!
//! ```text
//!   u32  id                       (DBObjHeaderFlags.HasId)
//!   u32  num_combat_maneuvers
//!   [CombatManeuver; N]           (20 bytes each, four u32 enum codes
//!                                  + one u32 MinSkillLevel)
//! ```
//!
//! Real-record cross-check: CombatManeuverTable 0x30000000 is 2048
//! bytes = 8-byte header + 102 × 20-byte maneuvers (102 = 0x66, the
//! count word right after the id).

use binrw::BinRead;

/// One row in a [`CombatManeuverTable`]. All five fields are raw u32
/// enum codes — see ACE `MotionStance`, `AttackHeight`, `AttackType`,
/// and `MotionCommand` for the canonical value lists. ACE notes that
/// every retail `MinSkillLevel` is 0; we still expose it because the
/// wire format reserves the slot.
#[derive(BinRead, Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[br(little)]
pub struct CombatManeuver {
    pub style: u32,
    pub attack_height: u32,
    pub attack_type: u32,
    pub min_skill_level: u32,
    pub motion: u32,
}

#[binrw::binread]
#[derive(Debug, Clone, serde::Serialize)]
#[br(little)]
pub struct CombatManeuverTable {
    pub id: u32,
    #[br(temp)]
    num_combat_maneuvers: u32,
    #[br(count = num_combat_maneuvers)]
    pub combat_maneuvers: Vec<CombatManeuver>,
}

impl CombatManeuverTable {
    pub fn unpack(data: &[u8]) -> binrw::BinResult<Self> {
        use binrw::BinRead;
        let mut cursor = binrw::io::Cursor::new(data);
        Self::read_le(&mut cursor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use binrw::io::Cursor;

    /// First 20 bytes of CMT 0x30000000's flat list (entry 0 as seen
    /// in retail). Lets us validate field order without needing the
    /// full 102-entry table inline.
    const CMT_0X30000000_ENTRY_0: &[u8] = &[
        0x3C, 0x00, 0x00, 0x80, // style = 0x8000003C (MotionStance)
        0x01, 0x00, 0x00, 0x00, // attack_height = 1
        0x08, 0x00, 0x00, 0x00, // attack_type = 8
        0x00, 0x00, 0x00, 0x00, // min_skill_level = 0
        0x68, 0x00, 0x00, 0x10, // motion = 0x10000068 (MotionCommand)
    ];

    /// Wrapper with `num_combat_maneuvers = 1` so the table parser
    /// reads exactly the one entry we supplied. Validates the
    /// id + count + List layout.
    fn cmt_single_entry_fixture() -> Vec<u8> {
        let mut out = Vec::with_capacity(8 + 20);
        out.extend_from_slice(&0x30000000u32.to_le_bytes());
        out.extend_from_slice(&1u32.to_le_bytes());
        out.extend_from_slice(CMT_0X30000000_ENTRY_0);
        out
    }

    #[test]
    fn combat_maneuver_decodes_field_order() {
        let mut cursor = Cursor::new(CMT_0X30000000_ENTRY_0);
        let m = CombatManeuver::read_le(&mut cursor).expect("read entry 0");
        assert_eq!(m.style, 0x8000003C);
        assert_eq!(m.attack_height, 1);
        assert_eq!(m.attack_type, 8);
        assert_eq!(m.min_skill_level, 0, "ACE observes all retail rows are 0");
        assert_eq!(m.motion, 0x10000068);
    }

    #[test]
    fn cmt_table_round_trips_single_entry() {
        let bytes = cmt_single_entry_fixture();
        let mut cursor = Cursor::new(&bytes);
        let cmt = CombatManeuverTable::read_le(&mut cursor).expect("parse single-entry CMT");
        assert_eq!(cmt.id, 0x30000000);
        assert_eq!(cmt.combat_maneuvers.len(), 1);
        assert_eq!(cmt.combat_maneuvers[0].motion, 0x10000068);
    }

    #[test]
    fn cmt_header_size_math_matches_retail() {
        // Retail 0x30000000 is 2048 bytes = 8 header + 102 × 20 entries.
        assert_eq!(8 + 102 * 20, 2048);
    }
}
