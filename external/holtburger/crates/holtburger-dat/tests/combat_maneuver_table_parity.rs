//! Parse every retail CombatManeuverTable record from
//! `client_portal.dat` and assert shape invariants + ACE's observation
//! that all retail `MinSkillLevel` rows are 0.
//! Skipped when `HOLTBURGER_PORTAL_DAT` is unset.

use binrw::BinRead;
use binrw::io::Cursor;
use holtburger_dat::file_type::CombatManeuverTable;
use holtburger_dat::{DatDatabase, DatFileType};

mod common;
use common::get_portal_dat_path;

#[test]
fn all_retail_combat_maneuver_tables_parse() {
    let Some(dat_path) = get_portal_dat_path() else {
        println!("Skipping CombatManeuverTable parity: portal.dat not found");
        return;
    };

    let dat = DatDatabase::new(&dat_path).expect("open portal.dat");
    let dat_kind = dat.dat_kind();

    let mut ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|&id| {
            DatFileType::from_id_in_dat(id, dat_kind) == DatFileType::CombatManeuverTable
        })
        .collect();
    ids.sort_unstable();

    assert!(
        !ids.is_empty(),
        "expected at least one CombatManeuverTable record in portal.dat",
    );

    let mut total_maneuvers: usize = 0;
    let mut nonzero_min_skill_seen = false;
    for id in &ids {
        let bytes = dat.get_file(*id).unwrap_or_else(|e| {
            panic!("read CombatManeuverTable 0x{id:08X}: {e}");
        });
        let mut cursor = Cursor::new(&bytes);
        let cmt = CombatManeuverTable::read_le(&mut cursor).unwrap_or_else(|e| {
            panic!(
                "parse CombatManeuverTable 0x{id:08X} ({} bytes): {e}",
                bytes.len()
            );
        });

        assert_eq!(cmt.id, *id, "CombatManeuverTable 0x{id:08X} self-id mismatch");

        // Size math: 4 (id) + 4 (count) + 20-byte entries accounts for
        // the whole record.
        let predicted = 8 + 20 * cmt.combat_maneuvers.len();
        assert_eq!(
            predicted,
            bytes.len(),
            "CombatManeuverTable 0x{id:08X} size mismatch: predicted {} != actual {}",
            predicted,
            bytes.len(),
        );

        // ACE asserts every retail MinSkillLevel is 0; flag if we ever
        // see otherwise so future game data surprises don't go silent.
        for m in &cmt.combat_maneuvers {
            if m.min_skill_level != 0 {
                nonzero_min_skill_seen = true;
            }
        }

        total_maneuvers += cmt.combat_maneuvers.len();
    }

    assert!(
        !nonzero_min_skill_seen,
        "ACE's 'all retail MinSkillLevels are 0' claim no longer holds — investigate",
    );

    println!(
        "Parsed {} CombatManeuverTable records, {} total maneuvers",
        ids.len(),
        total_maneuvers
    );
}
