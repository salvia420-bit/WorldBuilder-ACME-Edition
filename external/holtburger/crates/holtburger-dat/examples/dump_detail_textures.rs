//! dump_detail_textures — T7 grounding probe.
//!
//! Opens `client_portal.dat`, parses the Region (DID `0x13000000`), and
//! walks `terrain_info.land_surfaces.tex_merge.terrain_desc` printing the
//! per-terrain-type base texture, detail texture DID, and both tiling
//! values. Used to decide whether the detail texture is effectively one
//! global landscape texture (acclient `GetDetailTex(0)`) or genuinely
//! per-type.

use binrw::io::Cursor;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::Region;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;

const REGION_FILE_ID: u32 = 0x1300_0000;

fn resolve_dat_path() -> Option<PathBuf> {
    if let Some(path) = holtburger_dat::utils::get_portal_dat_path() {
        return Some(path);
    }
    if let Ok(home) = std::env::var("HOME") {
        let p = PathBuf::from(home).join("ac_base_dats/client_portal.dat");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn main() -> ExitCode {
    let dat_path = match resolve_dat_path() {
        Some(p) => p,
        None => {
            eprintln!("client_portal.dat not found");
            return ExitCode::from(2);
        }
    };
    let dat = match DatDatabase::new(&dat_path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("open {}: {e}", dat_path.display());
            return ExitCode::from(2);
        }
    };
    let bytes = match dat.get_file(REGION_FILE_ID) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("Region not in DAT: {e}");
            return ExitCode::from(2);
        }
    };
    let region = match Region::unpack(&mut Cursor::new(&bytes)) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Region parse: {e}");
            return ExitCode::from(2);
        }
    };

    let td = &region.terrain_info.land_surfaces.tex_merge.terrain_desc;
    println!("terrain_desc count = {}", td.len());
    println!(
        "{:>4}  {:<10} {:<12} {:<8} {:<12} {:<8}",
        "type", "base_tex", "base_tiling", "", "detail_tex", "det_tile"
    );
    let mut unique_detail: BTreeMap<u32, u32> = BTreeMap::new();
    let mut unique_det_tiling: BTreeMap<u32, u32> = BTreeMap::new();
    for d in td {
        let t = &d.terrain_tex;
        println!(
            "{:>4}  0x{:08X} {:<12} {:<8} 0x{:08X} {:<8}",
            d.terrain_type, t.texture_id, t.tex_tiling, "", t.detail_texture_id, t.detail_tex_tiling
        );
        *unique_detail.entry(t.detail_texture_id).or_insert(0) += 1;
        *unique_det_tiling.entry(t.detail_tex_tiling).or_insert(0) += 1;
    }
    println!("\nunique detail_texture_id -> count:");
    for (k, v) in &unique_detail {
        println!("  0x{k:08X} -> {v}");
    }
    println!("unique detail_tex_tiling -> count:");
    for (k, v) in &unique_det_tiling {
        println!("  {k} -> {v}");
    }

    // Decode each unique detail texture to report native dims/format.
    use holtburger_dat::file_type::{Palette, SurfaceTexture, Texture, TextureDecodeError};
    println!("\ndecoded detail textures:");
    for surf_id in unique_detail.keys() {
        let surf_id = *surf_id;
        let b = match dat.get_file(surf_id) {
            Ok(b) => b,
            Err(e) => {
                println!("  0x{surf_id:08X}: fetch err {e}");
                continue;
            }
        };
        let surf = match SurfaceTexture::unpack(&b) {
            Ok(s) => s,
            Err(e) => {
                println!("  0x{surf_id:08X}: SurfaceTexture::unpack err {e}");
                continue;
            }
        };
        let tex_id = match surf.highest_res() {
            Some(t) => t,
            None => {
                println!("  0x{surf_id:08X}: empty mip list");
                continue;
            }
        };
        let tb = dat.get_file(tex_id).unwrap();
        let tex = Texture::unpack(&tb).unwrap();
        let rgba = tex.to_rgba8(|pal_id| {
            let pb = dat
                .get_file(pal_id)
                .map_err(|e| TextureDecodeError::PaletteFetch(format!("{pal_id:#010X}: {e}")))?;
            Palette::unpack(&pb)
                .map_err(|e| TextureDecodeError::PaletteFetch(format!("{pal_id:#010X}: {e}")))
        });
        match rgba {
            Ok(px) => println!(
                "  0x{surf_id:08X} -> tex 0x{tex_id:08X}  {}x{}  rgba_len={}",
                tex.width,
                tex.height,
                px.len()
            ),
            Err(e) => println!("  0x{surf_id:08X} -> tex 0x{tex_id:08X}  decode err {e}"),
        }
    }
    ExitCode::SUCCESS
}
