//! Parse the single retail ActionMap record (0x26000000, 12,303 bytes)
//! and assert shape invariants. Skipped when `HOLTBURGER_PORTAL_DAT`
//! is unset.

use binrw::io::Cursor;
use holtburger_dat::file_type::ActionMap;
use holtburger_dat::{DatDatabase, DatFileType};

mod common;
use common::get_portal_dat_path;

#[test]
fn retail_action_map_parses() {
    let Some(dat_path) = get_portal_dat_path() else {
        println!("Skipping ActionMap parity: portal.dat not found");
        return;
    };

    let dat = DatDatabase::new(&dat_path).expect("open portal.dat");
    let dat_kind = dat.dat_kind();

    let ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|&id| DatFileType::from_id_in_dat(id, dat_kind) == DatFileType::ActionMap)
        .collect();
    assert_eq!(
        ids.len(),
        1,
        "expected exactly one ActionMap record in retail",
    );

    let id = ids[0];
    let bytes = dat.get_file(id).unwrap_or_else(|e| {
        panic!("read ActionMap 0x{id:08X}: {e}");
    });
    let mut cursor = Cursor::new(&bytes);
    let am = ActionMap::read_le(&mut cursor).unwrap_or_else(|e| {
        panic!("parse ActionMap 0x{id:08X} ({} bytes): {e}", bytes.len());
    });

    assert_eq!(am.id, id);

    let consumed = cursor.position() as usize;
    assert_eq!(
        consumed,
        bytes.len(),
        "ActionMap parser stopped at {} of {}",
        consumed,
        bytes.len(),
    );

    // ACE comment: "Will be 0x23000005" — the StringTable that holds
    // the localized action names + descriptions.
    assert_eq!(
        am.string_table_data_id, 0x23000005,
        "ActionMap.string_table_data_id should be 0x23000005 per ACE",
    );

    let total_values: usize = am.input_maps.values().map(|v| v.len()).sum();
    let total_conflict_lists: usize = am
        .conflicting_maps
        .values()
        .map(|c| c.conflicting_input_maps.len())
        .sum();

    println!(
        "Parsed ActionMap 0x{id:08X}: {} input_maps ({} values total), {} conflicting_maps ({} conflict-list entries total), string_table=0x{:08X}",
        am.input_maps.len(),
        total_values,
        am.conflicting_maps.len(),
        total_conflict_lists,
        am.string_table_data_id,
    );
}
