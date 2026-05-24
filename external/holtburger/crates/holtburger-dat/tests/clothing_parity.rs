//! Parse every retail ClothingTable record from `client_portal.dat`
//! and assert shape invariants. Skipped when `HOLTBURGER_PORTAL_DAT`
//! is unset.

use binrw::BinRead;
use binrw::io::Cursor;
use holtburger_dat::file_type::ClothingTable;
use holtburger_dat::{DatDatabase, DatFileType};

mod common;
use common::get_portal_dat_path;

#[test]
fn all_retail_clothing_tables_parse() {
    let Some(dat_path) = get_portal_dat_path() else {
        println!("Skipping Clothing parity: portal.dat not found");
        return;
    };

    let dat = DatDatabase::new(&dat_path).expect("open portal.dat");
    let dat_kind = dat.dat_kind();

    let mut ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|&id| DatFileType::from_id_in_dat(id, dat_kind) == DatFileType::Clothing)
        .collect();
    ids.sort_unstable();

    assert!(
        !ids.is_empty(),
        "expected at least one ClothingTable record in portal.dat",
    );

    let mut total_base_effects: usize = 0;
    let mut total_sub_pal_effects: usize = 0;
    let mut total_object_effects: usize = 0;
    let mut total_texture_swaps: usize = 0;
    let mut total_sub_palettes: usize = 0;

    let mut found_known = false;
    for id in &ids {
        let bytes = dat.get_file(*id).unwrap_or_else(|e| {
            panic!("read ClothingTable 0x{id:08X}: {e}");
        });
        let mut cursor = Cursor::new(&bytes);
        let table = ClothingTable::read_le(&mut cursor).unwrap_or_else(|e| {
            panic!(
                "parse ClothingTable 0x{id:08X} ({} bytes): {e}",
                bytes.len()
            );
        });

        assert_eq!(table.id, *id, "ClothingTable 0x{id:08X} self-id mismatch");

        // Verify the parser consumed exactly `bytes.len()` — left-over
        // bytes would mean the schema is wrong somewhere.
        let consumed = cursor.position() as usize;
        assert_eq!(
            consumed,
            bytes.len(),
            "ClothingTable 0x{id:08X} parser stopped at byte {} of {}",
            consumed,
            bytes.len(),
        );

        total_base_effects += table.clothing_base_effects.len();
        total_sub_pal_effects += table.clothing_sub_pal_effects.len();
        for base in table.clothing_base_effects.values() {
            total_object_effects += base.clo_object_effects.len();
            for obj in &base.clo_object_effects {
                total_texture_swaps += obj.clo_texture_effects.len();
            }
        }
        for sub in table.clothing_sub_pal_effects.values() {
            total_sub_palettes += sub.clo_sub_palettes.len();
        }

        // Spot-check the known first base-effect of Clothing 0x10000001.
        if *id == 0x10000001 {
            let base = table
                .clothing_base_effects
                .get(&0x02001A18)
                .expect("0x10000001 should have setup-key 0x02001A18");
            assert_eq!(
                base.clo_object_effects.len(),
                6,
                "0x10000001 base-effect for setup 0x02001A18 should have 6 object effects",
            );
            let first = &base.clo_object_effects[0];
            assert_eq!(first.index, 9);
            assert_eq!(first.model_id, 0x01004AA7);
            assert_eq!(first.clo_texture_effects.len(), 2);
            assert_eq!(first.clo_texture_effects[0].old_texture, 0x050003D5);
            assert_eq!(first.clo_texture_effects[0].new_texture, 0x0500025F);
            found_known = true;
        }
    }

    assert!(
        found_known,
        "did not encounter known retail Clothing 0x10000001",
    );

    println!(
        "Parsed {} ClothingTable records: {} base effects ({} object effects, {} texture swaps), {} sub-pal effects ({} sub-palettes)",
        ids.len(),
        total_base_effects,
        total_object_effects,
        total_texture_swaps,
        total_sub_pal_effects,
        total_sub_palettes,
    );
}
