//! Parse the single retail MasterProperty record (0x39000001) and
//! assert shape invariants. Skipped when `HOLTBURGER_PORTAL_DAT` is
//! unset.

use binrw::io::Cursor;
use holtburger_dat::file_type::MasterProperty;
use holtburger_dat::{DatDatabase, DatFileType};

mod common;
use common::get_portal_dat_path;

#[test]
fn retail_master_property_parses() {
    let Some(dat_path) = get_portal_dat_path() else {
        println!("Skipping MasterProperty parity: portal.dat not found");
        return;
    };

    let dat = DatDatabase::new(&dat_path).expect("open portal.dat");
    let dat_kind = dat.dat_kind();

    let ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|&id| {
            DatFileType::from_id_in_dat(id, dat_kind) == DatFileType::MasterProperty
        })
        .collect();
    assert_eq!(
        ids.len(),
        1,
        "expected exactly one MasterProperty record in retail",
    );

    let id = ids[0];
    let bytes = dat.get_file(id).unwrap_or_else(|e| {
        panic!("read MasterProperty 0x{id:08X}: {e}");
    });
    let mut cursor = Cursor::new(&bytes);
    let master = MasterProperty::read_le(&mut cursor).unwrap_or_else(|e| {
        panic!(
            "parse MasterProperty 0x{id:08X} ({} bytes): {e}",
            bytes.len()
        );
    });

    assert_eq!(master.id, id);

    let consumed = cursor.position() as usize;
    assert_eq!(
        consumed,
        bytes.len(),
        "MasterProperty parser stopped at {} of {}",
        consumed,
        bytes.len(),
    );

    let defaulted = master
        .properties
        .values()
        .filter(|d| d.default_value.is_some())
        .count();
    let with_avail = master
        .properties
        .values()
        .filter(|d| !d.available_properties.is_empty())
        .count();

    println!(
        "Parsed MasterProperty 0x{id:08X}: enum_mapper {} id→string entries, {} BasePropertyDesc records ({} with default, {} with available_properties)",
        master.enum_mapper.id_to_string_map.len(),
        master.properties.len(),
        defaulted,
        with_avail,
    );

    assert!(
        master.enum_mapper.id_to_string_map.len() > 100,
        "enum_mapper should have hundreds of id→string entries",
    );
    assert!(
        master.properties.len() > 100,
        "MasterProperty should define hundreds of properties",
    );
}
