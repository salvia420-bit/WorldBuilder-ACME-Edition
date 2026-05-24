//! Parse every retail PaletteSet and GfxObjDegradeInfo record from
//! `client_portal.dat` and assert shape invariants. Skipped when
//! `HOLTBURGER_PORTAL_DAT` is unset.

use binrw::BinRead;
use binrw::io::Cursor;
use holtburger_dat::file_type::{GfxObjDegradeInfo, PaletteSet};
use holtburger_dat::{DatDatabase, DatFileType};

mod common;
use common::get_portal_dat_path;

#[test]
fn all_retail_palette_sets_parse() {
    let Some(dat_path) = get_portal_dat_path() else {
        println!("Skipping PaletteSet parity: portal.dat not found");
        return;
    };

    let dat = DatDatabase::new(&dat_path).expect("open portal.dat");
    let dat_kind = dat.dat_kind();

    let mut ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|&id| DatFileType::from_id_in_dat(id, dat_kind) == DatFileType::PaletteSet)
        .collect();
    ids.sort_unstable();

    assert!(
        !ids.is_empty(),
        "expected at least one PaletteSet record in portal.dat",
    );

    let mut total_palettes: usize = 0;
    let mut found_known = false;

    for id in &ids {
        let bytes = dat.get_file(*id).unwrap_or_else(|e| {
            panic!("read PaletteSet 0x{id:08X}: {e}");
        });
        let mut cursor = Cursor::new(&bytes);
        let set = PaletteSet::read_le(&mut cursor).unwrap_or_else(|e| {
            panic!("parse PaletteSet 0x{id:08X} ({} bytes): {e}", bytes.len());
        });

        assert_eq!(set.id, *id, "PaletteSet 0x{id:08X} self-id mismatch");

        let predicted = 8 + 4 * set.palettes.len();
        assert_eq!(
            predicted,
            bytes.len(),
            "PaletteSet 0x{id:08X} size mismatch: predicted {} != actual {}",
            predicted,
            bytes.len(),
        );

        total_palettes += set.palettes.len();

        if *id == 0x0F000001 {
            assert_eq!(
                set.palettes,
                vec![0x040005F3, 0x040005F4, 0x040005F5, 0x040005F2]
            );
            found_known = true;
        }
    }

    assert!(found_known, "did not encounter known PaletteSet 0x0F000001");

    println!(
        "Parsed {} PaletteSet records, {} total palette references",
        ids.len(),
        total_palettes
    );
}

#[test]
fn all_retail_gfx_obj_degrade_info_parse() {
    let Some(dat_path) = get_portal_dat_path() else {
        println!("Skipping GfxObjDegradeInfo parity: portal.dat not found");
        return;
    };

    let dat = DatDatabase::new(&dat_path).expect("open portal.dat");
    let dat_kind = dat.dat_kind();

    let mut ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|&id| DatFileType::from_id_in_dat(id, dat_kind) == DatFileType::DegradeInfo)
        .collect();
    ids.sort_unstable();

    assert!(
        !ids.is_empty(),
        "expected at least one GfxObjDegradeInfo record in portal.dat",
    );

    let mut total_degrades: usize = 0;
    let mut found_known = false;

    for id in &ids {
        let bytes = dat.get_file(*id).unwrap_or_else(|e| {
            panic!("read GfxObjDegradeInfo 0x{id:08X}: {e}");
        });
        let mut cursor = Cursor::new(&bytes);
        let dg = GfxObjDegradeInfo::read_le(&mut cursor).unwrap_or_else(|e| {
            panic!(
                "parse GfxObjDegradeInfo 0x{id:08X} ({} bytes): {e}",
                bytes.len()
            );
        });

        assert_eq!(dg.id, *id, "GfxObjDegradeInfo 0x{id:08X} self-id mismatch");

        let predicted = 8 + 20 * dg.degrades.len();
        assert_eq!(
            predicted,
            bytes.len(),
            "GfxObjDegradeInfo 0x{id:08X} size mismatch: predicted {} != actual {}",
            predicted,
            bytes.len(),
        );

        // Note: distances are NOT monotonic in retail data — some
        // entries (e.g. DegradeInfo 0x11000114 entry 1: min=10,
        // ideal=20, max=4) have ideal > max. That's a mode-specific
        // interpretation, not a wire-format invariant. We just check
        // the floats are finite to catch byte-order mistakes.
        for entry in &dg.degrades {
            assert!(
                entry.min_dist.is_finite()
                    && entry.ideal_dist.is_finite()
                    && entry.max_dist.is_finite(),
                "DegradeInfo 0x{id:08X} has non-finite distance — likely misaligned",
            );
        }

        total_degrades += dg.degrades.len();

        if *id == 0x11000001 {
            assert_eq!(dg.degrades.len(), 4);
            assert_eq!(dg.degrades[0].gfx_obj_id, 0x0100376A);
            assert_eq!(dg.degrades[0].min_dist, 10.0);
            assert_eq!(dg.degrades[0].max_dist, 50.0);
            found_known = true;
        }
    }

    assert!(
        found_known,
        "did not encounter known GfxObjDegradeInfo 0x11000001",
    );

    println!(
        "Parsed {} GfxObjDegradeInfo records, {} total LOD entries",
        ids.len(),
        total_degrades
    );
}
