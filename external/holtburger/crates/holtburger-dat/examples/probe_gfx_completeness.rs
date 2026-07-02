//! probe_gfx_completeness — Agent B 2026-07-02: parse the Holtburg cooking-forge
//! GfxObj + grocer-cell furniture Setups with OUR parser against the base DATs
//! and report per-polygon skip accounting (the wasm append_gfx_tris skip rules),
//! isolating parser truncation vs runtime fetch holes.
use holtburger_dat::file_type::{GfxObj, SetupModel};
use holtburger_dat::DatDatabase;
use std::io::Cursor;

const NO_POS: u8 = 0x04;

fn gfx_report(dat: &DatDatabase, id: u32) {
    let bytes = match dat.get_file(id) {
        Ok(b) => b,
        Err(e) => {
            println!("0x{id:08X}: GET FAIL {e}");
            return;
        }
    };
    let gfx = match GfxObj::unpack(&mut Cursor::new(&bytes)) {
        Ok(g) => g,
        Err(e) => {
            println!("0x{id:08X}: PARSE FAIL {e} ({} bytes)", bytes.len());
            return;
        }
    };
    let mut tris = 0usize;
    let mut skipped_no_pos = 0usize;
    let mut skipped_small = 0usize;
    let mut skipped_missing_vert = 0usize;
    let mut missing_vert_polys: Vec<u16> = Vec::new();
    for (pid, poly) in &gfx.polygons {
        if poly.vertex_ids.len() < 3 {
            skipped_small += 1;
            continue;
        }
        if (poly.stippling & NO_POS) != 0 {
            skipped_no_pos += 1;
            continue;
        }
        let mut ok = true;
        for &raw in &poly.vertex_ids {
            if raw < 0 || !gfx.vertex_array.vertices.contains_key(&(raw as u16)) {
                ok = false;
                break;
            }
        }
        if !ok {
            skipped_missing_vert += 1;
            missing_vert_polys.push(*pid);
            continue;
        }
        tris += poly.vertex_ids.len() - 2;
    }
    println!(
        "0x{id:08X}: bytes={} verts={} polys={} -> tris={} skips: no_pos={} small={} missing_vert={} {:?} did_degrade={:?}",
        bytes.len(),
        gfx.vertex_array.vertices.len(),
        gfx.polygons.len(),
        tris,
        skipped_no_pos,
        skipped_small,
        skipped_missing_vert,
        missing_vert_polys,
        gfx.did_degrade,
    );
}

fn setup_report(dat: &DatDatabase, id: u32) {
    let bytes = match dat.get_file(id) {
        Ok(b) => b,
        Err(e) => {
            println!("0x{id:08X}: GET FAIL {e}");
            return;
        }
    };
    match SetupModel::unpack(&mut Cursor::new(&bytes)) {
        Ok(s) => {
            println!(
                "0x{id:08X}: setup parts={} {:?}",
                s.parts.len(),
                s.parts.iter().map(|p| format!("0x{p:08X}")).collect::<Vec<_>>()
            );
            for p in &s.parts {
                if (p >> 24) == 0x01 {
                    gfx_report(dat, *p);
                }
            }
        }
        Err(e) => println!("0x{id:08X}: SETUP PARSE FAIL {e} ({} bytes)", bytes.len()),
    }
}

fn main() {
    let portal = DatDatabase::new("/home/wbterminal/ac_base_dats/client_portal.dat").expect("portal dat");
    println!("=== forge setup 0x0200124B ===");
    setup_report(&portal, 0x0200124B);
    println!("=== grocer stab GfxObjs ===");
    for id in [0x01000A2Fu32, 0x01000BC7] {
        gfx_report(&portal, id);
    }
    println!("=== grocer stab Setups ===");
    for id in [
        0x020000A5u32, 0x020000AA, 0x020000AB, 0x020000AC, 0x020000ED, 0x020000F0,
        0x020000F3, 0x020000F5, 0x0200010A, 0x02000121, 0x0200016D, 0x02000176,
        0x02000185, 0x020001BC, 0x02000272, 0x020002FB,
    ] {
        setup_report(&portal, id);
    }
}
