//! Parse every retail EnumMapper record from `client_portal.dat`
//! and assert shape invariants. Skipped when `HOLTBURGER_PORTAL_DAT`
//! is unset.

use binrw::io::Cursor;
use holtburger_dat::file_type::EnumMapper;
use holtburger_dat::{DatDatabase, DatFileType};

mod common;
use common::get_portal_dat_path;

#[test]
fn all_retail_enum_mappers_parse() {
    let Some(dat_path) = get_portal_dat_path() else {
        println!("Skipping EnumMapper parity: portal.dat not found");
        return;
    };

    let dat = DatDatabase::new(&dat_path).expect("open portal.dat");
    let dat_kind = dat.dat_kind();

    let mut ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|&id| DatFileType::from_id_in_dat(id, dat_kind) == DatFileType::EnumMapper)
        .collect();
    ids.sort_unstable();

    assert!(
        !ids.is_empty(),
        "expected at least one EnumMapper record in portal.dat",
    );

    let mut total_entries: usize = 0;
    let mut found_known = false;

    for id in &ids {
        let bytes = dat.get_file(*id).unwrap_or_else(|e| {
            panic!("read EnumMapper 0x{id:08X}: {e}");
        });
        let mut cursor = Cursor::new(&bytes);
        let mapper = EnumMapper::read_le(&mut cursor).unwrap_or_else(|e| {
            panic!("parse EnumMapper 0x{id:08X} ({} bytes): {e}", bytes.len());
        });

        assert_eq!(mapper.id, *id, "EnumMapper 0x{id:08X} self-id mismatch");

        let consumed = cursor.position() as usize;
        assert_eq!(
            consumed,
            bytes.len(),
            "EnumMapper 0x{id:08X} parser stopped at {} of {}",
            consumed,
            bytes.len(),
        );

        total_entries += mapper.id_to_string_map.len();

        // DRW's MasterPropertyTests EnumMapper 0x2200001B references
        // "the EnumMapper that names UIElements" — should have many
        // entries. Spot-check it exists and has plausible content.
        if *id == 0x2200001B {
            assert!(
                mapper.id_to_string_map.len() > 10,
                "0x2200001B should have many UIElement entries",
            );
            found_known = true;
        }
    }

    assert!(found_known, "expected to encounter EnumMapper 0x2200001B");

    println!(
        "Parsed {} EnumMapper records, {} total id→string entries",
        ids.len(),
        total_entries
    );
}
