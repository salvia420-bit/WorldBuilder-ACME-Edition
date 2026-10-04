//! surface_mip_census — for every textured Surface (0x08) in a portal DAT,
//! walk its SurfaceTexture level list and report what an `s3tc` upload of the
//! DAT bytes would see: the highest-res level's pixel format, how many levels
//! the list carries, whether every level shares that format, whether the
//! dimensions halve level to level, and how far the chain goes down.
//! Grounds perf T6 (OpenAC comparison 2026-10-04): native DXT upload is only
//! cheap if the DAT already carries the mip chain (WebGL cannot generate mips
//! for a compressed texture).
//!
//! Usage: `cargo run -p holtburger-dat --example surface_mip_census -- <portal_dat>`

use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::{Surface, SurfacePixelFormat, SurfaceTexture, Texture};
use std::collections::BTreeMap;
use std::env;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() != 1 {
        eprintln!("usage: surface_mip_census <portal_dat>");
        return ExitCode::from(2);
    }
    let dat = match DatDatabase::new(&args[0]) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("open dat: {e}");
            return ExitCode::from(1);
        }
    };
    let ids: Vec<u32> = dat.files.keys().copied().filter(|id| (id >> 24) == 0x08).collect();
    // format of the highest-res level -> surfaces
    let mut by_fmt: BTreeMap<String, u64> = BTreeMap::new();
    // for DXT top levels: level-count histogram, uniform format, halving, min dim
    let mut dxt_levels: BTreeMap<usize, u64> = BTreeMap::new();
    let (mut dxt, mut dxt_uniform, mut dxt_halving, mut dxt_full_chain, mut dxt_pow2) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let mut dxt_min_dim: BTreeMap<u32, u64> = BTreeMap::new();
    let mut dxt_recolor = 0u64; // Surface carries an orig_palette_id (irrelevant to DXT, but count it)
    let mut dxt_clipmap = 0u64;
    let mut dxt_bytes = 0u64; // all levels' block bytes
    let mut dxt_rgba_bytes = 0u64; // what the RGBA8 top level costs today (no mips)
    let mut examples: Vec<String> = Vec::new();
    let mut tex_cache: BTreeMap<u32, Option<(SurfacePixelFormat, i32, i32, usize)>> = BTreeMap::new();
    let mut get_tex = |id: u32| -> Option<(SurfacePixelFormat, i32, i32, usize)> {
        if let Some(v) = tex_cache.get(&id) {
            return *v;
        }
        let v = dat.get_file(id).ok().and_then(|b| Texture::unpack(&b).ok()).map(|t| {
            (t.format(), t.width, t.height, t.source_data.len())
        });
        tex_cache.insert(id, v);
        v
    };

    for id in ids {
        let Ok(bytes) = dat.get_file(id) else { continue };
        let Ok(s) = Surface::unpack(&bytes) else { continue };
        let Some((st_id, pal_id)) = s.textured() else { continue };
        let Ok(stb) = dat.get_file(st_id) else { continue };
        let Ok(st) = SurfaceTexture::unpack(&stb) else { continue };
        let Some(&top_id) = st.textures.last() else { continue };
        let Some((fmt, w, h, _)) = get_tex(top_id) else { continue };
        *by_fmt.entry(format!("{fmt:?}")).or_default() += 1;
        let is_dxt = matches!(
            fmt,
            SurfacePixelFormat::Dxt1 | SurfacePixelFormat::Dxt3 | SurfacePixelFormat::Dxt5
        );
        if !is_dxt {
            continue;
        }
        dxt += 1;
        if pal_id != 0 {
            dxt_recolor += 1;
        }
        if s.surface_type & 0x4 != 0 {
            dxt_clipmap += 1;
        }
        dxt_rgba_bytes += (w as u64) * (h as u64) * 4;
        if (w as u32).is_power_of_two() && (h as u32).is_power_of_two() {
            dxt_pow2 += 1;
        }
        *dxt_levels.entry(st.textures.len()).or_default() += 1;
        // Levels are stored low-res first, highest-res LAST.
        let mut uniform = true;
        let mut halving = true;
        let mut min_dim = u32::MAX;
        let mut prev: Option<(i32, i32)> = None;
        for &lid in st.textures.iter().rev() {
            let Some((lf, lw, lh, n)) = get_tex(lid) else {
                uniform = false;
                continue;
            };
            dxt_bytes += n as u64;
            if lf != fmt {
                uniform = false;
            }
            if let Some((pw, ph)) = prev {
                if lw != (pw / 2).max(1) || lh != (ph / 2).max(1) {
                    halving = false;
                }
            }
            prev = Some((lw, lh));
            min_dim = min_dim.min(lw.min(lh) as u32);
        }
        if uniform {
            dxt_uniform += 1;
        }
        if halving {
            dxt_halving += 1;
        }
        *dxt_min_dim.entry(min_dim).or_default() += 1;
        if uniform && halving && min_dim <= 4 {
            dxt_full_chain += 1;
        }
        if examples.len() < 8 && st.textures.len() > 1 {
            let lv: Vec<String> = st
                .textures
                .iter()
                .rev()
                .filter_map(|&l| get_tex(l).map(|(f, w, h, _)| format!("{w}x{h}:{f:?}")))
                .collect();
            examples.push(format!("surface {id:#010X} st {st_id:#010X}: {}", lv.join(" > ")));
        }
    }

    println!("top-level format of textured surfaces:");
    for (k, v) in &by_fmt {
        println!("  {k:<24} {v}");
    }
    println!("\nDXT top level: {dxt} surfaces");
    println!("  level-count histogram: {dxt_levels:?}");
    println!("  every level same format: {dxt_uniform}");
    println!("  dimensions halve level to level: {dxt_halving}");
    println!("  power-of-two top level: {dxt_pow2}");
    println!("  smallest level dim histogram: {dxt_min_dim:?}");
    println!("  uniform + halving + reaches <=4: {dxt_full_chain}");
    println!("  Surface also names a palette: {dxt_recolor}");
    println!("  Base1ClipMap set: {dxt_clipmap}");
    println!("  DAT block bytes (all levels, per-surface sum): {:.1} MiB", dxt_bytes as f64 / 1048576.0);
    println!("  RGBA8 top level today (per-surface sum, no mips): {:.1} MiB", dxt_rgba_bytes as f64 / 1048576.0);
    println!("\nexamples:");
    for e in examples {
        println!("  {e}");
    }
    ExitCode::SUCCESS
}
