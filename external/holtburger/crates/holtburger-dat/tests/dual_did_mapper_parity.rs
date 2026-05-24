//! Parse every retail DualDidMapper record from `client_portal.dat`
//! (5 records: Materials, Gems, SpellComponents, ComponentPacks,
//! TradeNotes per ACE's comment). Skipped when `HOLTBURGER_PORTAL_DAT`
//! is unset.

use binrw::io::Cursor;
use holtburger_dat::file_type::DualDidMapper;
use holtburger_dat::{DatDatabase, DatFileType};

mod common;
use common::get_portal_dat_path;

#[test]
fn all_retail_dual_did_mappers_parse() {
    let Some(dat_path) = get_portal_dat_path() else {
        println!("Skipping DualDidMapper parity: portal.dat not found");
        return;
    };

    let dat = DatDatabase::new(&dat_path).expect("open portal.dat");
    let dat_kind = dat.dat_kind();

    let mut ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|&id| DatFileType::from_id_in_dat(id, dat_kind) == DatFileType::DualDataIDMapper)
        .collect();
    ids.sort_unstable();

    assert!(
        !ids.is_empty(),
        "expected at least one DualDidMapper record in portal.dat",
    );

    let mut total_id_entries = 0;
    let mut total_name_entries = 0;

    for id in &ids {
        let bytes = dat.get_file(*id).unwrap_or_else(|e| {
            panic!("read DualDidMapper 0x{id:08X}: {e}");
        });
        let mut cursor = Cursor::new(&bytes);
        let m = DualDidMapper::read_le(&mut cursor).unwrap_or_else(|e| {
            panic!("parse DualDidMapper 0x{id:08X} ({} bytes): {e}", bytes.len());
        });

        assert_eq!(m.id, *id, "DualDidMapper 0x{id:08X} self-id mismatch");

        let consumed = cursor.position() as usize;
        assert_eq!(
            consumed,
            bytes.len(),
            "DualDidMapper 0x{id:08X} parser stopped at {} of {}",
            consumed,
            bytes.len(),
        );

        total_id_entries += m.client_enum_to_id.len() + m.server_enum_to_id.len();
        total_name_entries += m.client_enum_to_name.len() + m.server_enum_to_name.len();
    }

    println!(
        "Parsed {} DualDidMapper records, {} total id entries, {} total name entries",
        ids.len(),
        total_id_entries,
        total_name_entries
    );
}
