//! Parse every retail DidMapper record from `client_portal.dat` and
//! assert shape invariants. Skipped when `HOLTBURGER_PORTAL_DAT`
//! is unset.

use binrw::io::Cursor;
use holtburger_dat::file_type::DidMapper;
use holtburger_dat::{DatDatabase, DatFileType};

mod common;
use common::get_portal_dat_path;

#[test]
fn all_retail_did_mappers_parse() {
    let Some(dat_path) = get_portal_dat_path() else {
        println!("Skipping DidMapper parity: portal.dat not found");
        return;
    };

    let dat = DatDatabase::new(&dat_path).expect("open portal.dat");
    let dat_kind = dat.dat_kind();

    let mut ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|&id| DatFileType::from_id_in_dat(id, dat_kind) == DatFileType::DataIDMapper)
        .collect();
    ids.sort_unstable();

    assert!(
        !ids.is_empty(),
        "expected at least one DidMapper record in portal.dat",
    );

    let mut total_client_ids = 0;
    let mut total_client_names = 0;
    let mut total_server_ids = 0;
    let mut total_server_names = 0;

    for id in &ids {
        let bytes = dat.get_file(*id).unwrap_or_else(|e| {
            panic!("read DidMapper 0x{id:08X}: {e}");
        });
        let mut cursor = Cursor::new(&bytes);
        let m = DidMapper::read_le(&mut cursor).unwrap_or_else(|e| {
            panic!("parse DidMapper 0x{id:08X} ({} bytes): {e}", bytes.len());
        });

        assert_eq!(m.id, *id, "DidMapper 0x{id:08X} self-id mismatch");

        let consumed = cursor.position() as usize;
        assert_eq!(
            consumed,
            bytes.len(),
            "DidMapper 0x{id:08X} parser stopped at {} of {}",
            consumed,
            bytes.len(),
        );

        total_client_ids += m.client_enum_to_id.len();
        total_client_names += m.client_enum_to_name.len();
        total_server_ids += m.server_enum_to_id.len();
        total_server_names += m.server_enum_to_name.len();
    }

    println!(
        "Parsed {} DidMapper records. Totals: client_id={}, client_name={}, server_id={}, server_name={}",
        ids.len(),
        total_client_ids,
        total_client_names,
        total_server_ids,
        total_server_names
    );
}
