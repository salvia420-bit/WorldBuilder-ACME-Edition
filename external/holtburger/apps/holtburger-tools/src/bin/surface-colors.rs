//! `surface-colors` — emit a per-surface dominant-colour JSON manifest
//! consumed by the wire-agent fill path (`apps/holtburger-web/scene3d/
//! materials.js::MaterialCache._wireframeMaterialFor`).
//!
//! Walks every Surface (DID prefix 0x08) in the retail portal DAT,
//! decodes the highest-res Texture via the same Surface →
//! SurfaceTexture → Texture chain that `surface-dump` uses, computes a
//! single dominant RGB via the "most-populated quantised bin" method
//! (4096 16-cube bins, alpha-gated to ≥128, centroid of the winning
//! bin), and writes `apps/holtburger-web/data/surface-colors.json`.
//!
//! Output format mirrors `chorizite-dump-enum-values` shape — a flat
//! JSON object with hex-stringified DID keys and `[r,g,b]` arrays:
//!
//! ```json
//! {
//!   "0x080000DD": [104, 130,  72],
//!   "0x08000914": [180, 142,  88],
//!   ...
//! }
//! ```
//!
//! Runtime side (MaterialCache) loads this JSON, looks up by DID, and
//! falls back to the existing HSL-of-DID-hash bucket when a surface
//! isn't in the manifest (custom content / future surfaces). Solid-
//! colour surfaces (Surface::solid_color) return their literal ARGB
//! triple; failed decodes (palette missing, malformed mip chain, etc.)
//! are silently dropped — MaterialCache's fallback handles them.
//!
//! Usage:
//!
//!     cargo run --release --bin surface-colors
//!     # or with explicit paths:
//!     cargo run --release --bin surface-colors -- \
//!         --portal-dat /home/wbterminal/ac_base_dats/client_portal.dat \
//!         --out apps/holtburger-web/data/surface-colors.json

use anyhow::{Context, Result};
use clap::Parser;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::{
    Palette, Surface, SurfacePixelFormat, SurfaceTexture, Texture, TextureDecodeError,
};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(about = "Emit per-surface dominant-colour JSON for the wire-agent fill path")]
struct Cli {
    /// Path to the retail client_portal.dat (surfaces live here).
    #[arg(long, default_value = "/home/wbterminal/ac_base_dats/client_portal.dat")]
    portal_dat: PathBuf,

    /// Output JSON path. Default writes alongside the holtburger-web
    /// data directory so the runtime can fetch it relative to its
    /// own URL.
    #[arg(long, default_value = "apps/holtburger-web/data/surface-colors.json")]
    out: PathBuf,

    /// Optional max number of surfaces to process (handy for smoke
    /// tests). `0` means "all".
    #[arg(long, default_value = "0")]
    limit: usize,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let portal = DatDatabase::new(&cli.portal_dat)
        .with_context(|| format!("open {}", cli.portal_dat.display()))?;

    let mut surface_ids: Vec<u32> = portal
        .files
        .keys()
        .copied()
        .filter(|id| ((id >> 24) & 0xFF) == 0x08)
        .collect();
    surface_ids.sort();

    let total = if cli.limit == 0 {
        surface_ids.len()
    } else {
        cli.limit.min(surface_ids.len())
    };
    eprintln!(
        "surface-colors: found {} surfaces in portal DAT; processing {}",
        surface_ids.len(),
        total,
    );

    let mut colors: BTreeMap<u32, [u8; 3]> = BTreeMap::new();
    let mut solid_count = 0u32;
    let mut textured_count = 0u32;
    let mut errors = 0u32;
    let report_every = (total / 20).max(1);

    for (i, did) in surface_ids.iter().take(total).enumerate() {
        if i % report_every == 0 && i > 0 {
            eprintln!(
                "  [{:>5}/{:>5}] ok={} (solid={} textured={}) err={}",
                i,
                total,
                colors.len(),
                solid_count,
                textured_count,
                errors,
            );
        }
        match dominant_for(&portal, *did) {
            Ok((rgb, was_solid)) => {
                colors.insert(*did, rgb);
                if was_solid {
                    solid_count += 1;
                } else {
                    textured_count += 1;
                }
            }
            Err(_) => {
                errors += 1;
            }
        }
    }

    eprintln!(
        "done. resolved={} (solid={} textured={}) errors={}",
        colors.len(),
        solid_count,
        textured_count,
        errors,
    );

    write_manifest(&cli.out, &colors)?;
    eprintln!(
        "wrote {} ({:.1} KB)",
        cli.out.display(),
        std::fs::metadata(&cli.out)
            .map(|m| m.len() as f64 / 1024.0)
            .unwrap_or(0.0),
    );
    Ok(())
}

/// Returns `(rgb, was_solid)`. A solid-colour Surface short-circuits
/// to the literal ARGB triple (the `was_solid` bool is for diagnostics
/// only — the runtime treats both the same).
fn dominant_for(portal: &DatDatabase, did: u32) -> Result<([u8; 3], bool)> {
    let bytes = portal.get_file(did)?;
    let surf = Surface::unpack(&bytes)?;

    if let Some(argb) = surf.solid_color() {
        return Ok((
            [
                ((argb >> 16) & 0xFF) as u8,
                ((argb >> 8) & 0xFF) as u8,
                (argb & 0xFF) as u8,
            ],
            true,
        ));
    }

    let (st_id, pal_id) = surf.textured().context("neither solid nor textured")?;
    let stb = portal.get_file(st_id)?;
    let stx = SurfaceTexture::unpack(&stb)?;
    let rs_id = stx.highest_res().context("SurfaceTexture has no mips")?;
    let tb = portal.get_file(rs_id)?;
    let tex = Texture::unpack(&tb)?;

    let pal_fetch = |pid: u32| -> std::result::Result<Palette, TextureDecodeError> {
        let raw = portal
            .get_file(pid)
            .map_err(|e| TextureDecodeError::PaletteFetch(format!("{pid:#010X}: {e}")))?;
        Palette::unpack(&raw)
            .map_err(|e| TextureDecodeError::PaletteFetch(format!("{pid:#010X}: {e}")))
    };
    let needs_pal = matches!(
        tex.format(),
        SurfacePixelFormat::P8 | SurfacePixelFormat::Index16
    );
    let rgba = if needs_pal && pal_id != 0 {
        tex.to_rgba8(|_| pal_fetch(pal_id))?
    } else {
        tex.to_rgba8(pal_fetch)?
    };

    Ok((compute_dominant(&rgba), false))
}

/// Quantise pixels into a 16×16×16 RGB cube (4096 bins), count
/// occurrences with alpha ≥ 128, return the centroid of the most-
/// populated bin. Robust against pixel-level noise (averaging would
/// wash colourful textures into grey; pure-mode would amplify a single-
/// pixel highlight). Returns mid-grey as a last-resort fallback for
/// fully-transparent surfaces.
fn compute_dominant(rgba: &[u8]) -> [u8; 3] {
    const BINS: usize = 4096;
    let mut counts = [0u32; BINS];
    let mut sums = vec![[0u64; 3]; BINS];
    for c in rgba.chunks_exact(4) {
        if c[3] < 128 {
            continue;
        }
        let r = (c[0] >> 4) as usize;
        let g = (c[1] >> 4) as usize;
        let b = (c[2] >> 4) as usize;
        let idx = (r << 8) | (g << 4) | b;
        counts[idx] += 1;
        sums[idx][0] += c[0] as u64;
        sums[idx][1] += c[1] as u64;
        sums[idx][2] += c[2] as u64;
    }
    let (best_idx, &best_count) = counts
        .iter()
        .enumerate()
        .max_by_key(|(_, c)| **c)
        .unwrap_or((0, &0));
    if best_count == 0 {
        return [128, 128, 128];
    }
    let n = best_count as u64;
    [
        (sums[best_idx][0] / n) as u8,
        (sums[best_idx][1] / n) as u8,
        (sums[best_idx][2] / n) as u8,
    ]
}

fn write_manifest(path: &PathBuf, colors: &BTreeMap<u32, [u8; 3]>) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create dir {}", parent.display()))?;
    }
    let mut s = String::with_capacity(colors.len() * 36);
    s.push_str("{\n");
    let n = colors.len();
    for (i, (id, rgb)) in colors.iter().enumerate() {
        let comma = if i + 1 == n { "" } else { "," };
        s.push_str(&format!(
            "  \"0x{:08X}\": [{}, {}, {}]{}\n",
            id, rgb[0], rgb[1], rgb[2], comma
        ));
    }
    s.push_str("}\n");
    std::fs::write(path, s).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}
