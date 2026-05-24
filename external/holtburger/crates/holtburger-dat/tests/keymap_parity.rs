//! Parse every retail KeyMap record from `client_portal.dat` and
//! assert shape invariants. Skipped when `HOLTBURGER_PORTAL_DAT` is
//! unset.

use binrw::BinRead;
use binrw::io::Cursor;
use holtburger_dat::file_type::KeyMap;
use holtburger_dat::{DatDatabase, DatFileType};

mod common;
use common::get_portal_dat_path;

#[test]
fn all_retail_keymaps_parse() {
    let Some(dat_path) = get_portal_dat_path() else {
        println!("Skipping KeyMap parity: portal.dat not found");
        return;
    };

    let dat = DatDatabase::new(&dat_path).expect("open portal.dat");
    let dat_kind = dat.dat_kind();

    let mut ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|&id| DatFileType::from_id_in_dat(id, dat_kind) == DatFileType::Keymap)
        .collect();
    ids.sort_unstable();

    assert!(
        !ids.is_empty(),
        "expected at least one KeyMap record in portal.dat",
    );

    let mut total_devices: usize = 0;
    let mut total_meta_keys: usize = 0;
    let mut total_input_maps: usize = 0;
    let mut total_mappings: usize = 0;
    let mut found_known = false;

    for id in &ids {
        let bytes = dat.get_file(*id).unwrap_or_else(|e| {
            panic!("read KeyMap 0x{id:08X}: {e}");
        });
        let mut cursor = Cursor::new(&bytes);
        let km = KeyMap::read_le(&mut cursor).unwrap_or_else(|e| {
            panic!("parse KeyMap 0x{id:08X} ({} bytes): {e}", bytes.len());
        });

        assert_eq!(km.id, *id, "KeyMap 0x{id:08X} self-id mismatch");

        let consumed = cursor.position() as usize;
        assert_eq!(
            consumed,
            bytes.len(),
            "KeyMap 0x{id:08X} parser stopped at {} of {}",
            consumed,
            bytes.len(),
        );

        total_devices += km.devices.len();
        total_meta_keys += km.meta_keys.len();
        total_input_maps += km.input_maps.len();
        for map in km.input_maps.values() {
            total_mappings += map.mappings.len();
        }

        if *id == 0x14000002 {
            assert_eq!(km.name, "DefaultMap");
            assert!(km.devices.len() >= 2, "expected at least keyboard + mouse");
            assert_eq!(km.devices[0].device_type, 1, "first device is keyboard");
            found_known = true;
        }
    }

    assert!(found_known, "did not encounter known KeyMap 0x14000002");

    println!(
        "Parsed {} KeyMap records: {} devices, {} meta keys, {} input maps ({} mappings)",
        ids.len(),
        total_devices,
        total_meta_keys,
        total_input_maps,
        total_mappings,
    );
}
