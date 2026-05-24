//! Parse every retail StringTable record from `client_local_English.dat`
//! and assert shape invariants. Skipped when `HOLTBURGER_LOCAL_DAT` is
//! unset.

use binrw::BinRead;
use binrw::io::Cursor;
use holtburger_dat::file_type::StringTable;
use holtburger_dat::{DatDatabase, DatFileType};

mod common;

fn get_local_dat_path() -> Option<std::path::PathBuf> {
    std::env::var_os("HOLTBURGER_LOCAL_DAT").map(std::path::PathBuf::from)
}

#[test]
fn all_retail_string_tables_parse() {
    let Some(dat_path) = get_local_dat_path() else {
        println!("Skipping StringTable parity: HOLTBURGER_LOCAL_DAT not set");
        let _unused = common::get_portal_dat_path;
        return;
    };

    let dat = DatDatabase::new(&dat_path).expect("open local_English.dat");
    let dat_kind = dat.dat_kind();

    let mut ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|&id| DatFileType::from_id_in_dat(id, dat_kind) == DatFileType::StringTable)
        .collect();
    ids.sort_unstable();

    assert!(
        !ids.is_empty(),
        "expected at least one StringTable record in local_English.dat",
    );

    let mut total_entries: usize = 0;
    let mut total_string_variants: usize = 0;
    let mut found_known = false;

    for id in &ids {
        let bytes = dat.get_file(*id).unwrap_or_else(|e| {
            panic!("read StringTable 0x{id:08X}: {e}");
        });
        let mut cursor = Cursor::new(&bytes);
        let table = StringTable::read_le(&mut cursor).unwrap_or_else(|e| {
            panic!(
                "parse StringTable 0x{id:08X} ({} bytes): {e}",
                bytes.len()
            );
        });

        assert_eq!(table.id, *id, "StringTable 0x{id:08X} self-id mismatch");
        assert_eq!(
            table.language, 1,
            "StringTable 0x{id:08X} language should be 1 (English)",
        );

        // Parser must consume exactly bytes.len() — left-over bytes
        // would indicate a schema bug.
        let consumed = cursor.position() as usize;
        assert_eq!(
            consumed,
            bytes.len(),
            "StringTable 0x{id:08X} parser stopped at {} of {}",
            consumed,
            bytes.len(),
        );

        total_entries += table.strings.len();
        for entry in table.strings.values() {
            total_string_variants += entry.strings.len();
        }

        // Spot-check the known small table 0x2300000A.
        if *id == 0x2300000A {
            assert_eq!(table.strings.len(), 2);
            let left_alt = table
                .strings
                .get(&0x014152D5)
                .expect("0x2300000A should have key 0x014152D5");
            assert_eq!(left_alt.strings, vec!["Left Alt"]);
            let left_ctrl = table
                .strings
                .get(&0x04CD833C)
                .expect("0x2300000A should have key 0x04CD833C");
            assert_eq!(left_ctrl.strings, vec!["Left Ctrl"]);
            found_known = true;
        }
    }

    assert!(found_known, "did not encounter known StringTable 0x2300000A");

    println!(
        "Parsed {} StringTable records, {} total entries ({} string variants)",
        ids.len(),
        total_entries,
        total_string_variants,
    );
}
