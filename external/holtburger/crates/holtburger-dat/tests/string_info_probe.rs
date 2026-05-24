//! Throwaway diagnostic for the Milestone D StringInfo follow-on.
//! Dumps every StringInfo BaseProperty key from MasterProperty so we
//! can correlate to retail Layout records and isolate the wire layout.

use binrw::io::Cursor;
use holtburger_dat::file_type::{BasePropertyType, MasterProperty};
use holtburger_dat::DatDatabase;

mod common;
use common::get_portal_dat_path;

#[test]
fn dump_string_info_properties() {
    let Some(portal) = get_portal_dat_path() else {
        println!("Skipping: portal.dat not found");
        return;
    };
    let dat = DatDatabase::new(&portal).unwrap();
    let bytes = dat.get_file(0x39000001).unwrap();
    let master = MasterProperty::read_le(&mut Cursor::new(&bytes)).unwrap();

    let mut keys: Vec<_> = master
        .properties
        .iter()
        .filter(|(_, d)| matches!(d.property_type, BasePropertyType::StringInfo))
        .map(|(k, d)| (*k, d.name))
        .collect();
    keys.sort();
    println!("StringInfo properties in MasterProperty (total: {}):", keys.len());
    for (k, name) in keys.iter().take(40) {
        let s = master
            .enum_mapper
            .id_to_string_map
            .get(name)
            .cloned()
            .unwrap_or_else(|| "?".to_string());
        println!("  master_key=0x{k:08X} name=0x{name:08X} ({s})");
    }
}
