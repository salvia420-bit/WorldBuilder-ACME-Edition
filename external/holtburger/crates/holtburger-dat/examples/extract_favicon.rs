//! extract_favicon — pull one icon/texture DID (0x06xxxxxx) from
//! client_portal.dat, decode to RGBA8, and write the raw pixels + dims.
//! Usage: cargo run -p holtburger-dat --example extract_favicon -- 0x06001382 /tmp/favicon.rgba
//! Prints: "<width> <height> <out_path>" on success.

use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::{Palette, Texture, TextureDecodeError};
use std::path::PathBuf;
use std::process::ExitCode;

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
    let args: Vec<String> = std::env::args().collect();
    let did = args.get(1).map_or(0x0600_1382, |s| {
        let t = s.trim_start_matches("0x").trim_start_matches("0X");
        u32::from_str_radix(t, 16)
            .or_else(|_| s.parse::<u32>())
            .unwrap_or(0x0600_1382)
    });
    let out = args
        .get(2)
        .cloned()
        .unwrap_or_else(|| "/tmp/favicon.rgba".to_string());

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
    let bytes = match dat.get_file(did) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("fetch {did:#010X}: {e}");
            return ExitCode::from(2);
        }
    };
    let tex = match Texture::unpack(&bytes) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("Texture::unpack {did:#010X}: {e}");
            return ExitCode::from(2);
        }
    };
    let rgba = tex.to_rgba8(|pal_id| {
        let pb = dat
            .get_file(pal_id)
            .map_err(|e| TextureDecodeError::PaletteFetch(format!("{pal_id:#010X}: {e}")))?;
        Palette::unpack(&pb)
            .map_err(|e| TextureDecodeError::PaletteFetch(format!("{pal_id:#010X}: {e}")))
    });
    let rgba = match rgba {
        Ok(p) => p,
        Err(e) => {
            eprintln!("decode {did:#010X}: {e}");
            return ExitCode::from(2);
        }
    };
    if let Err(e) = std::fs::write(&out, &rgba) {
        eprintln!("write {out}: {e}");
        return ExitCode::from(2);
    }
    println!("{} {} {}", tex.width, tex.height, out);
    ExitCode::SUCCESS
}
