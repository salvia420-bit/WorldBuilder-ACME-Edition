//! verify_texchan — Phase-5 S6a byte-faithfulness gate.
//!
//! For a sample of baked surfaces, INDEPENDENTLY re-derives the normal map
//! from real `client_portal.dat` (Surface → SurfaceTexture.highest_res →
//! Texture → to_rgba8 → `normal_from_luminance(_,1.0)`) and bit-compares it
//! to the normal channel decoded from the on-disk `.texchan.bin` (resolved
//! via `texchan-manifest.json`). Proves the codec + manifest + dedup
//! pipeline faithfully stores `normal_from_luminance` output on REAL data
//! (the real-`portal.dat` golden deferred from S1). roughness/AO presence +
//! length are sanity-checked. Because two DIDs that dedup to one stem are
//! each re-derived and compared to the SHARED artifact, a wrong dedup merge
//! (two different-content surfaces collapsed) is caught here too.
//!
//! Runtime-vs-bake equivalence (the wasm path) is the S6b boot-smoke; the
//! producer calls the same Rust `normal_from_luminance` the runtime calls.
//!
//! Usage: `cargo run --release --example verify_texchan -- [--limit N] [--dir DIR]`
//! Exit 0 = all sampled artifacts faithful; 1 = a mismatch; 2 = setup error.

use holtburger_dat::file_type::{Palette, Surface, SurfaceTexture, Texture, TextureDecodeError};
use holtburger_dat::normal_gen::normal_from_luminance;
use holtburger_dat::surface_classify::surface_type_flags::LUMINOUS;
use holtburger_dat::DatDatabase;
use holtburger_suite_bake::texchan::TexChan;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;

fn resolve_dat_path() -> Option<PathBuf> {
    if let Some(p) = holtburger_dat::utils::get_portal_dat_path() {
        return Some(p);
    }
    if let Ok(home) = std::env::var("HOME") {
        let p = PathBuf::from(home).join("ac_base_dats/client_portal.dat");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn dist_suite_dir() -> PathBuf {
    let base = std::env::var("HOLTBURGER_DIST")
        .unwrap_or_else(|_| "/mnt/wbterminal2/holtburger-dist".to_string());
    PathBuf::from(base).join("suite")
}

/// Re-derive (w, h, normal) for one surface DID via the runtime chain, or
/// `None` for the skip-cases the producer also skips.
fn fresh_normal(dat: &DatDatabase, did: u32) -> Option<(u32, u32, Vec<u8>)> {
    let bytes = dat.get_file(did).ok()?;
    let surface = Surface::unpack(&bytes).ok()?;
    if surface.solid_color().is_some() {
        return None;
    }
    let surf_tex_id = surface.textured()?.0;
    if (surface.surface_type & LUMINOUS) != 0 {
        return None;
    }
    let surf_tex = SurfaceTexture::unpack(&dat.get_file(surf_tex_id).ok()?).ok()?;
    let rs_id = surf_tex.highest_res()?;
    let tex = Texture::unpack(&dat.get_file(rs_id).ok()?).ok()?;
    let (w, h) = tex.actual_dimensions();
    let rgba = tex
        .to_rgba8(|pal_id| {
            let pb = dat
                .get_file(pal_id)
                .map_err(|e| TextureDecodeError::PaletteFetch(format!("{pal_id:#010X}: {e}")))?;
            Palette::unpack(&pb).map_err(|e| {
                TextureDecodeError::PaletteFetch(format!("Palette::unpack {pal_id:#010X}: {e}"))
            })
        })
        .ok()?;
    let normal = normal_from_luminance(&rgba, w, h, 1.0);
    if normal.is_empty() {
        return None;
    }
    Some((w, h, normal))
}

fn main() -> ExitCode {
    let mut limit: usize = 0;
    let mut dir: Option<PathBuf> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--limit" => limit = args.next().and_then(|v| v.parse().ok()).unwrap_or(0),
            "--dir" => dir = args.next().map(PathBuf::from),
            other => {
                eprintln!("unknown arg: {other}");
                return ExitCode::from(2);
            }
        }
    }
    let dir = dir.unwrap_or_else(dist_suite_dir);

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

    let manifest_path = dir.join("texchan-manifest.json");
    let manifest: BTreeMap<String, String> = match std::fs::read(&manifest_path) {
        Ok(b) => serde_json::from_slice(&b).unwrap_or_default(),
        Err(e) => {
            eprintln!("read {}: {e}", manifest_path.display());
            return ExitCode::from(2);
        }
    };
    if manifest.is_empty() {
        eprintln!("manifest empty/unparsed: {}", manifest_path.display());
        return ExitCode::from(2);
    }

    let mut checked = 0u64;
    let mut ok = 0u64;
    let mut normal_mismatch = 0u64;
    let mut dim_mismatch = 0u64;
    let mut channel_bad = 0u64;
    let mut missing_artifact = 0u64;
    let mut skipped_rederive = 0u64;

    // manifest is BTreeMap → already sorted by "0x%08X" did string.
    for (did_str, stem) in &manifest {
        if limit != 0 && checked >= limit as u64 {
            break;
        }
        let did = match u32::from_str_radix(did_str.trim_start_matches("0x"), 16) {
            Ok(d) => d,
            Err(_) => continue,
        };
        checked += 1;

        let (w, h, fresh) = match fresh_normal(&dat, did) {
            Some(v) => v,
            None => {
                // The producer would also have skipped this; if it's in the
                // manifest yet we can't re-derive, the chains diverged.
                skipped_rederive += 1;
                continue;
            }
        };

        let bin_path = dir.join(format!("{stem}.texchan.bin"));
        let raw = match std::fs::read(&bin_path) {
            Ok(b) => b,
            Err(_) => {
                missing_artifact += 1;
                eprintln!("MISSING {did_str} -> {}", bin_path.display());
                continue;
            }
        };
        let tc = match TexChan::decode(&raw) {
            Ok(t) => t,
            Err(e) => {
                channel_bad += 1;
                eprintln!("DECODE {did_str} -> {bin_path:?}: {e:?}");
                continue;
            }
        };

        if tc.width != w || tc.height != h {
            dim_mismatch += 1;
            eprintln!("DIM {did_str}: baked {}x{} != fresh {w}x{h}", tc.width, tc.height);
            continue;
        }
        let px = (w as usize) * (h as usize);
        let baked_normal = match &tc.normal {
            Some(n) => n,
            None => {
                channel_bad += 1;
                eprintln!("NO-NORMAL {did_str}");
                continue;
            }
        };
        let rough_ok = tc.roughness.as_ref().map(|r| r.len() == px).unwrap_or(false);
        let ao_ok = tc.ao.as_ref().map(|a| a.len() == px).unwrap_or(false);
        if !rough_ok || !ao_ok {
            channel_bad += 1;
            eprintln!("CHAN {did_str}: rough_ok={rough_ok} ao_ok={ao_ok}");
            continue;
        }
        if *baked_normal != fresh {
            normal_mismatch += 1;
            eprintln!("NORMAL-MISMATCH {did_str} (stem {stem})");
            continue;
        }
        ok += 1;
    }

    println!(
        "verify_texchan: checked={checked} ok={ok} | normal_mismatch={normal_mismatch} dim_mismatch={dim_mismatch} channel_bad={channel_bad} missing_artifact={missing_artifact} skipped_rederive={skipped_rederive}"
    );

    let failures = normal_mismatch + dim_mismatch + channel_bad + missing_artifact + skipped_rederive;
    if failures == 0 && ok > 0 {
        println!("BYTE-FAITHFUL ✅ ({ok} surfaces: baked normal == fresh normal_from_luminance; rough/ao present)");
        ExitCode::SUCCESS
    } else {
        eprintln!("FAILURES: {failures}");
        ExitCode::from(1)
    }
}
