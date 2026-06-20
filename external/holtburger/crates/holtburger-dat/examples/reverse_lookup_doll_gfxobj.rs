//! Reverse-lookup: is the Beaten Doll's part_1 gfxobj (surface 0x080003E4, the
//! "white box") emitted by any ParticleEmitterInfo (0x32)? Reads setup
//! 0x02000A47 -> part gfxobjs, then scans every 0x32 record for a matching
//! gfx_obj_id / hw_gfx_obj_id.
//!
//! Usage: cargo run -p holtburger-dat --example reverse_lookup_doll_gfxobj -- [portal_dat]
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::{GfxObj, ParticleEmitter, SetupModel};
use std::collections::HashSet;
use std::env;
use std::io::Cursor;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let path = args
        .first()
        .map(|s| s.as_str())
        .unwrap_or("/home/wbterminal/ac_base_dats/client_portal.dat");
    let dat = DatDatabase::new(path).expect("open dat");

    // 1) setup 0x02000A47 -> parts (per-part gfxobj DIDs)
    let setup_id = 0x0200_0A47u32;
    let sb = dat.get_file(setup_id).expect("get setup");
    let setup = SetupModel::unpack(&mut Cursor::new(&sb)).expect("unpack setup");
    println!("Setup {setup_id:#010X}: {} parts", setup.parts.len());
    for (i, &g) in setup.parts.iter().enumerate() {
        let n_surf = dat
            .get_file(g)
            .ok()
            .and_then(|b| GfxObj::unpack(&mut Cursor::new(&b)).ok())
            .map(|go| go.surfaces.len());
        println!("  part[{i:2}] gfxobj = {g:#010X}  (surfaces: {n_surf:?})");
    }

    let target_gfx = setup.parts.get(1).copied().unwrap_or(0);
    println!("\n>>> part_1 gfxobj = {target_gfx:#010X}");
    if let Ok(gb) = dat.get_file(target_gfx) {
        if let Ok(g) = GfxObj::unpack(&mut Cursor::new(&gb)) {
            println!(
                "    surfaces: {:?}",
                g.surfaces.iter().map(|s| format!("{s:#010X}")).collect::<Vec<_>>()
            );
        }
    }

    // 2) which gfxobj(s) actually carry surface 0x080003E4?
    let target_surface = 0x0800_03E4u32;
    let mut gfx_with_surface: HashSet<u32> = HashSet::new();
    for &g in &setup.parts {
        if let Ok(b) = dat.get_file(g) {
            if let Ok(go) = GfxObj::unpack(&mut Cursor::new(&b)) {
                if go.surfaces.contains(&target_surface) {
                    gfx_with_surface.insert(g);
                }
            }
        }
    }
    println!(
        "gfxobjs (in this setup) carrying surface {target_surface:#010X}: {:?}",
        gfx_with_surface.iter().map(|g| format!("{g:#010X}")).collect::<Vec<_>>()
    );

    // 3) enumerate ALL 0x32 ParticleEmitterInfo; find any referencing the target gfxobj
    let part_gfx: HashSet<u32> = setup.parts.iter().copied().filter(|&g| g != 0).collect();
    let emitter_ids: Vec<u32> = dat.files.keys().copied().filter(|id| (id >> 24) == 0x32).collect();
    println!("\nScanning {} ParticleEmitterInfo (0x32) records ...", emitter_ids.len());

    let mut direct = 0u32;
    let mut any_part = 0u32;
    for eid in &emitter_ids {
        let Ok(eb) = dat.get_file(*eid) else { continue };
        let Ok(pe) = ParticleEmitter::unpack(&eb) else { continue };
        let g = pe.gfx_obj_id;
        let hw = pe.hw_gfx_obj_id;
        if g == target_gfx || hw == target_gfx {
            println!("  *** DIRECT MATCH emitter {eid:#010X}: gfx_obj_id={g:#010X} hw_gfx_obj_id={hw:#010X}");
            direct += 1;
        } else if part_gfx.contains(&g) || part_gfx.contains(&hw) {
            println!("  (any-part) emitter {eid:#010X}: gfx_obj_id={g:#010X} hw_gfx_obj_id={hw:#010X}");
            any_part += 1;
        }
    }
    println!("\n=== RESULT ===");
    println!("emitters emitting part_1 gfxobj {target_gfx:#010X}: {direct}");
    println!("emitters emitting ANY doll-setup part gfxobj: {any_part}");
}
