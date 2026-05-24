//! Parse every retail LanguageString record from `client_portal.dat`
//! and assert shape invariants + the known DRW EOR-test value.
//! Skipped when `HOLTBURGER_PORTAL_DAT` is unset.

use binrw::BinRead;
use binrw::io::Cursor;
use holtburger_dat::file_type::LanguageString;
use holtburger_dat::{DatDatabase, DatFileType};

mod common;
use common::get_portal_dat_path;

#[test]
fn all_retail_language_strings_parse() {
    let Some(dat_path) = get_portal_dat_path() else {
        println!("Skipping LanguageString parity: portal.dat not found");
        return;
    };

    let dat = DatDatabase::new(&dat_path).expect("open portal.dat");
    let dat_kind = dat.dat_kind();

    let mut ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|&id| {
            DatFileType::from_id_in_dat(id, dat_kind) == DatFileType::LanguageString
        })
        .collect();
    ids.sort_unstable();

    assert!(
        !ids.is_empty(),
        "expected at least one LanguageString record in portal.dat",
    );

    let mut total_chars: usize = 0;
    let mut found_known = false;
    for id in &ids {
        let bytes = dat.get_file(*id).unwrap_or_else(|e| {
            panic!("read LanguageString 0x{id:08X}: {e}");
        });
        let mut cursor = Cursor::new(&bytes);
        let ls = LanguageString::read_le(&mut cursor).unwrap_or_else(|e| {
            panic!(
                "parse LanguageString 0x{id:08X} ({} bytes): {e}",
                bytes.len()
            );
        });

        assert_eq!(ls.id, *id, "LanguageString 0x{id:08X} self-id mismatch");
        total_chars += ls.value.chars().count();

        // Cross-check against the known DRW EOR-test value for 0x31000010.
        if *id == 0x31000010 {
            assert!(
                ls.value.starts_with("Sho men's names have the surname first"),
                "0x31000010 text does not match DRW's known value",
            );
            assert!(
                ls.value.ends_with("Shui Chon-Po."),
                "0x31000010 text does not match DRW's known value",
            );
            found_known = true;
        }
    }

    assert!(
        found_known,
        "did not encounter known retail LanguageString 0x31000010",
    );

    println!(
        "Parsed {} LanguageString records, {} total chars",
        ids.len(),
        total_chars
    );
}
