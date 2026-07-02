//! Reproducibility aid for the T4 lip fix: dump the REAL 9x9 terrain heights for
//! landblock 0xADB1 (the Holtburg lip at world 33360,34104) from the retail
//! cell/portal DATs, decoded through the region LandHeightTable. The `ADB1_HEIGHTS`
//! literal pinned in `holtburger-world`'s `faithful_bridge` drift test
//! (`outdoor_lip_holtburg_t4_real_holds`) is this dump's output. Skips cleanly
//! when the base DATs are absent (CI without them). Run:
//!   cargo test -p holtburger-dat --test dump_adb1_heights -- --nocapture

use holtburger_dat::file_type::Region;
use holtburger_dat::landblock::CellLandblock;
use holtburger_dat::DatDatabase;
use std::io::Cursor;

#[test]
fn dump_adb1_heights() {
    let portal = std::path::PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
    let cell = std::path::PathBuf::from("/home/wbterminal/ac_base_dats/client_cell_1.dat");
    if !portal.exists() || !cell.exists() {
        eprintln!("[dump_adb1_heights] base DATs absent — skipping");
        return;
    }
    let pdat = DatDatabase::new(&portal).expect("open portal");
    let region_bytes = pdat.get_file(0x1300_0000).expect("region 0x13000000");
    let region = Region::unpack(&mut Cursor::new(&region_bytes)).expect("parse region");
    let table = &region.land_defs.land_height_table;

    let cdat = DatDatabase::new(&cell).expect("open cell");
    let bytes = cdat.get_file(0xADB1_FFFF).expect("CellLandblock 0xADB1FFFF");
    let clb = CellLandblock::unpack(&bytes).expect("parse cell landblock");

    // At the mover's column vx=6 (x_local 144): flat 80 for vy1..5 then a 54.8°
    // drop to 46 (vy6), 40, 34 — the T4 lip the fix holds at.
    eprintln!(
        "[dump_adb1_heights] vx=6 north gradient (vy 0..8): {:?}",
        (0..9)
            .map(|vy| clb.get_height_with_table(6, vy, Some(table)))
            .collect::<Vec<_>>()
    );
    let mut lit = String::from("ADB1_HEIGHTS = [");
    for vx in 0..9usize {
        for vy in 0..9usize {
            lit.push_str(&format!("{:.1},", clb.get_height_with_table(vx, vy, Some(table))));
        }
    }
    lit.push(']');
    eprintln!("[dump_adb1_heights] {lit}");
}
