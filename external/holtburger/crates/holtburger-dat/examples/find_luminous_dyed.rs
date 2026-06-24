//! find_luminous_dyed — read Setup DIDs (hex `0x..`, one per line) from stdin,
//! walk each Setup → parts (gfxobj 0x01) → surfaces (0x08) → luminosity, and
//! print the setups whose BASE surfaces are luminous (>0). Used to hunt a
//! dyed+luminous item for the R1 `?luminousEmissiveMap` eye-test. Opens the
//! portal DAT ONCE.
use binrw::io::Cursor;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::{GfxObj, SetupModel, Surface};
use std::io::BufRead;
use std::path::PathBuf;

fn dat_path() -> PathBuf {
    if let Some(p) = holtburger_dat::utils::get_portal_dat_path() {
        return p;
    }
    PathBuf::from(std::env::var("HOME").unwrap()).join("ac_base_dats/client_portal.dat")
}

fn setup_max_luminosity(dat: &DatDatabase, setup_id: u32) -> Option<f32> {
    let bytes = dat.get_file(setup_id).ok()?;
    let setup = SetupModel::unpack(&mut Cursor::new(&bytes)).ok()?;
    let mut max_lum = 0.0f32;
    let mut lum_surfaces = 0u32;
    for &part in &setup.parts {
        if (part >> 24) != 0x01 {
            continue; // only raw gfxobj parts carry surfaces
        }
        let Ok(gbytes) = dat.get_file(part) else { continue };
        let Ok(gfx) = GfxObj::unpack(&mut Cursor::new(&gbytes)) else { continue };
        for &surf_did in &gfx.surfaces {
            if (surf_did >> 24) != 0x08 {
                continue;
            }
            let Ok(sbytes) = dat.get_file(surf_did) else { continue };
            if let Ok(surf) = Surface::unpack(&sbytes) {
                if surf.luminosity > 0.0 {
                    lum_surfaces += 1;
                    if surf.luminosity > max_lum {
                        max_lum = surf.luminosity;
                    }
                }
            }
        }
    }
    if lum_surfaces > 0 { Some(max_lum) } else { None }
}

fn main() {
    let dat = DatDatabase::new(dat_path()).expect("open portal dat");
    let stdin = std::io::stdin();
    let mut checked = 0u32;
    let mut found = 0u32;
    for line in stdin.lock().lines().map_while(Result::ok) {
        let s = line.trim();
        let s = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")).unwrap_or(s);
        let Ok(setup_id) = u32::from_str_radix(s, 16) else { continue };
        checked += 1;
        if let Some(max_lum) = setup_max_luminosity(&dat, setup_id) {
            found += 1;
            println!("0x{setup_id:08X} max_luminosity={max_lum}");
        }
    }
    eprintln!("checked {checked} setups, {found} luminous");
}
