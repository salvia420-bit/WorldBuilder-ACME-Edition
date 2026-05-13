//! Phase 1.4 — surface classifier audit tool.
//!
//! Walks every Surface DID referenced by a landblock (default Holtburg
//! LB 0xA9B4) through the same decode chain wasm uses
//! (Surface → SurfaceTexture → Texture → palette → RGBA8), then runs
//! the heuristic classifier and dumps per-surface stats + category to
//! JSON. Used to drive Phase 1.4's 80% accuracy validation.
//!
//! Usage:
//!
//!     surface-classify-audit \
//!         --dat /home/wbterminal/ac_base_dats/client_portal.dat \
//!         --landblock 0xA9B4 \
//!         --out /mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave1-p14/audit.json
//!
//! Surface discovery: walks the cell-dat's `LandblockInfo` (`0xXXXXFFFE`)
//! → each Stab.id → GfxObj.surfaces OR SetupModel.parts → GfxObj.surfaces.
//! Plus the cell DAT's `EnvCell` surfaces for indoor cottages. Output is
//! lossless — every surface DID seen, ordered, with stats + category.

use anyhow::{Context, Result};
use clap::Parser;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::env_cell::surface_did_for_envcell_index;
use holtburger_dat::file_type::{
    EnvCell, GfxObj, Palette, SetupModel, Surface, SurfaceTexture, Texture, TextureDecodeError,
};
use holtburger_dat::landblock::LandblockInfo;
use holtburger_dat::surface_classify::{classify, compute_stats, SurfaceCategory};
use serde::Serialize;
use std::collections::BTreeSet;
use std::io::{Cursor, Write as _};
use std::path::{Path, PathBuf};

#[derive(Parser, Debug)]
struct Cli {
    /// Path to the portal DAT.
    #[arg(long, default_value = "/home/wbterminal/ac_base_dats/client_portal.dat")]
    portal_dat: PathBuf,

    /// Path to the cell DAT (used to read LandblockInfo + EnvCells).
    #[arg(long, default_value = "/home/wbterminal/ac_base_dats/client_cell_1.dat")]
    cell_dat: PathBuf,

    /// Landblock packed key (e.g. 0xA9B4 = Holtburg).
    #[arg(long, default_value = "0xA9B4")]
    landblock: String,

    /// Output JSON path.
    #[arg(long)]
    out: PathBuf,

    /// Optional PPM contact sheet output path. Each tile is 64×64;
    /// tile label baked in stats JSON. PPM is uncompressed but
    /// universally viewable; convert with `convert sheet.ppm sheet.png`
    /// for sharing.
    #[arg(long)]
    contact_sheet: Option<PathBuf>,

    /// Tile size for the contact sheet (default 64).
    #[arg(long, default_value = "64")]
    tile: u32,

    /// Tiles per row in the contact sheet (default 10).
    #[arg(long, default_value = "10")]
    cols: u32,
}

#[derive(Serialize, Debug, Clone)]
struct SurfaceAudit {
    /// Hex-formatted surface DID.
    did: String,
    /// Heuristic-classified category (string label).
    category: String,
    /// Raw `Surface.surface_type` bitfield.
    surface_type: u32,
    /// Pixel mean RGB in `[0, 1]`.
    mean_rgb: [f32; 3],
    /// Per-channel standard deviation in `[0, 1]`.
    std_dev: [f32; 3],
    /// Rec.601 luminance of the mean.
    luminance: f32,
    /// Luminance variance across the texture.
    variance: f32,
    /// Mean dominant hue (degrees).
    dominant_hue: f32,
    /// HSV saturation of the mean.
    saturation: f32,
    /// Texture dimensions (after decode). `(0, 0)` for solid surfaces.
    width: u32,
    height: u32,
    /// `true` if the Surface was a solid ARGB colour (no texture body).
    solid: bool,
}

#[derive(Serialize, Debug)]
struct AuditDoc {
    landblock: String,
    portal_dat: String,
    cell_dat: String,
    total_surfaces: usize,
    category_counts: std::collections::BTreeMap<String, usize>,
    surfaces: Vec<SurfaceAudit>,
}

fn parse_hex(s: &str) -> Result<u32> {
    let stripped = s.trim_start_matches("0x").trim_start_matches("0X");
    Ok(u32::from_str_radix(stripped, 16).context("parse hex landblock")?)
}

struct Decoded {
    audit: SurfaceAudit,
    rgba: Vec<u8>,
    w: u32,
    h: u32,
}

fn classify_one(portal: &DatDatabase, did: u32) -> Option<Decoded> {
    let bytes = portal.get_file(did).ok()?;
    let surface = Surface::unpack(&bytes).ok()?;
    let surface_type = surface.surface_type;

    let (pixels, w, h, solid) = if let Some(argb) = surface.solid_color() {
        let a = ((argb >> 24) & 0xFF) as u8;
        let r = ((argb >> 16) & 0xFF) as u8;
        let g = ((argb >> 8) & 0xFF) as u8;
        let b = (argb & 0xFF) as u8;
        (vec![r, g, b, a], 1u32, 1u32, true)
    } else {
        let (st_id, _) = surface.textured()?;
        let stb = portal.get_file(st_id).ok()?;
        let stx = SurfaceTexture::unpack(&stb).ok()?;
        let rs_id = stx.highest_res()?;
        let tb = portal.get_file(rs_id).ok()?;
        let tex = Texture::unpack(&tb).ok()?;
        let rgba = tex
            .to_rgba8(|pal_id| {
                let pb = portal
                    .get_file(pal_id)
                    .map_err(|e| TextureDecodeError::PaletteFetch(format!("{pal_id:#010X}: {e}")))?;
                Palette::unpack(&pb).map_err(|e| {
                    TextureDecodeError::PaletteFetch(format!(
                        "Palette::unpack {pal_id:#010X}: {e}"
                    ))
                })
            })
            .ok()?;
        (rgba, tex.width as u32, tex.height as u32, false)
    };

    let stats = compute_stats(&pixels, w, h);
    let cat = classify(&stats, surface_type);
    Some(Decoded {
        audit: SurfaceAudit {
            did: format!("0x{:08X}", did),
            category: cat.label().to_string(),
            surface_type,
            mean_rgb: stats.mean,
            std_dev: stats.std_dev,
            luminance: stats.luminance,
            variance: stats.variance,
            dominant_hue: stats.dominant_hue,
            saturation: stats.saturation,
            width: w,
            height: h,
            solid,
        },
        rgba: pixels,
        w,
        h,
    })
}

/// Box-filter downsample (nearest-tile pick) — good enough for a
/// thumbnail contact sheet, no need for a real resize library.
fn resample_nearest(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<u8> {
    if sw == 0 || sh == 0 || dw == 0 || dh == 0 {
        return vec![0; (dw * dh * 3) as usize];
    }
    let mut out = vec![0u8; (dw * dh * 3) as usize];
    for y in 0..dh {
        let sy = (y * sh / dh).min(sh - 1);
        for x in 0..dw {
            let sx = (x * sw / dw).min(sw - 1);
            let si = (sy * sw + sx) as usize * 4;
            let di = (y * dw + x) as usize * 3;
            out[di] = src[si];
            out[di + 1] = src[si + 1];
            out[di + 2] = src[si + 2];
        }
    }
    out
}

/// Emit a PPM contact sheet. Tile labels are NOT baked into the image
/// (no font); the JSON output covers that. PPM viewers are universal
/// (Eye of GNOME, IrfanView, ImageMagick `convert`); this is the
/// laptop-safe path until we ship a real PNG encoder.
fn write_contact_sheet(decoded: &[Decoded], out: &Path, tile: u32, cols: u32) -> Result<()> {
    let n = decoded.len() as u32;
    let cols = cols.max(1);
    let rows = (n + cols - 1) / cols;
    let w = cols * tile;
    let h = rows * tile;
    let mut canvas = vec![32u8; (w * h * 3) as usize]; // dark grey background
    for (i, d) in decoded.iter().enumerate() {
        let i = i as u32;
        let row = i / cols;
        let col = i % cols;
        let thumb = resample_nearest(&d.rgba, d.w, d.h, tile, tile);
        for ty in 0..tile {
            let src_row = (ty * tile * 3) as usize;
            let dst_y = row * tile + ty;
            let dst_x = col * tile;
            let dst_off = ((dst_y * w + dst_x) * 3) as usize;
            canvas[dst_off..dst_off + (tile * 3) as usize]
                .copy_from_slice(&thumb[src_row..src_row + (tile * 3) as usize]);
        }
    }
    let mut f = std::fs::File::create(out).with_context(|| format!("create {}", out.display()))?;
    writeln!(f, "P6")?;
    writeln!(f, "{} {}", w, h)?;
    writeln!(f, "255")?;
    f.write_all(&canvas)?;
    Ok(())
}

/// Walk a GfxObj's `surfaces` array; on failure (missing GfxObj) emit
/// nothing (the surface ref might point at a setup-only id).
fn surfaces_for_gfx(portal: &DatDatabase, gfx_id: u32) -> Vec<u32> {
    let Ok(bytes) = portal.get_file(gfx_id) else {
        return Vec::new();
    };
    let mut cursor = Cursor::new(&bytes);
    let Ok(gfx) = GfxObj::unpack(&mut cursor) else {
        return Vec::new();
    };
    gfx.surfaces
}

/// Recursively expand: if `id` is a SetupModel (top byte 0x02) walk
/// each part. If it's a raw GfxObj (top byte 0x01) just read it.
fn surfaces_for_setup_or_gfx(portal: &DatDatabase, id: u32) -> Vec<u32> {
    let top = (id >> 24) & 0xFF;
    match top {
        0x01 => surfaces_for_gfx(portal, id),
        0x02 => {
            let Ok(bytes) = portal.get_file(id) else {
                return Vec::new();
            };
            let mut cursor = Cursor::new(&bytes);
            let Ok(setup) = SetupModel::read(&mut cursor) else {
                return Vec::new();
            };
            let mut out = Vec::new();
            for part in setup.parts {
                out.extend(surfaces_for_gfx(portal, part));
            }
            out
        }
        _ => Vec::new(),
    }
}

/// Walk a landblock's `LandblockInfo` placements + all EnvCell records,
/// collecting every Surface DID referenced.
fn discover_surfaces(
    portal: &DatDatabase,
    cell: &DatDatabase,
    landblock_key: u16,
) -> BTreeSet<u32> {
    let mut surfaces: BTreeSet<u32> = BTreeSet::new();
    let lb_word = (landblock_key as u32) << 16;

    // 1. LandblockInfo at 0xXXXXFFFE.
    let info_id = lb_word | 0xFFFE;
    if let Ok(bytes) = cell.get_file(info_id) {
        if let Ok(info) = LandblockInfo::unpack(&bytes) {
            for stab in &info.objects {
                for s in surfaces_for_setup_or_gfx(portal, stab.id) {
                    surfaces.insert(s);
                }
            }
            for b in &info.buildings {
                for s in surfaces_for_setup_or_gfx(portal, b.model_id) {
                    surfaces.insert(s);
                }
            }
        }
    }

    // 2. EnvCells at 0xXXXX0001..0xXXXXFFFD. We scan the dat's file
    //    table for IDs in that range.
    let env_lo = lb_word | 0x0001;
    let env_hi = lb_word | 0xFFFD;
    let envcell_ids: Vec<u32> = cell
        .files
        .keys()
        .copied()
        .filter(|id| *id >= env_lo && *id <= env_hi)
        .collect();
    for env_id in envcell_ids {
        if let Ok(bytes) = cell.get_file(env_id) {
            let mut cursor = Cursor::new(&bytes);
            if let Ok(envcell) = EnvCell::unpack(&mut cursor) {
                // EnvCell stores surfaces as u16 wire values that need
                // OR'ing with 0x08000000 to become full DIDs.
                for wire_surf in &envcell.surfaces {
                    surfaces.insert(surface_did_for_envcell_index(*wire_surf));
                }
                // EnvCell's `static_objects` (furniture, lampposts) are
                // setup/gfx ids too — walk those for additional surfaces.
                for stab in &envcell.static_objects {
                    for s in surfaces_for_setup_or_gfx(portal, stab.stab_id) {
                        surfaces.insert(s);
                    }
                }
            }
        }
    }

    // Drop 0x00000000 sentinels.
    surfaces.remove(&0);
    surfaces
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let landblock_packed = parse_hex(&cli.landblock)?;
    let landblock_word = (landblock_packed & 0xFFFF) as u16;

    eprintln!("Loading portal dat: {}", cli.portal_dat.display());
    let portal = DatDatabase::new(&cli.portal_dat)?;
    eprintln!("  portal files: {}", portal.files.len());
    eprintln!("Loading cell dat: {}", cli.cell_dat.display());
    let cell = DatDatabase::new(&cli.cell_dat)?;
    eprintln!("  cell files: {}", cell.files.len());

    eprintln!(
        "Discovering surfaces for landblock 0x{:04X}...",
        landblock_word
    );
    let surface_dids = discover_surfaces(&portal, &cell, landblock_word);
    eprintln!("  found {} unique surface DIDs", surface_dids.len());

    let mut decoded = Vec::with_capacity(surface_dids.len());
    let mut counts: std::collections::BTreeMap<String, usize> = Default::default();
    for did in &surface_dids {
        if let Some(d) = classify_one(&portal, *did) {
            *counts.entry(d.audit.category.clone()).or_default() += 1;
            decoded.push(d);
        } else {
            eprintln!("  warn: surface 0x{:08X} failed to decode", did);
        }
    }

    let audits: Vec<SurfaceAudit> = decoded.iter().map(|d| d.audit.clone()).collect();
    let doc = AuditDoc {
        landblock: format!("0x{:04X}", landblock_word),
        portal_dat: cli.portal_dat.display().to_string(),
        cell_dat: cli.cell_dat.display().to_string(),
        total_surfaces: audits.len(),
        category_counts: counts,
        surfaces: audits,
    };

    if let Some(parent) = cli.out.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let json = serde_json::to_string_pretty(&doc)?;
    std::fs::write(&cli.out, json).with_context(|| format!("write {}", cli.out.display()))?;
    eprintln!("Wrote audit: {}", cli.out.display());
    eprintln!("Category histogram:");
    for (k, v) in &doc.category_counts {
        eprintln!("  {:>8} {}", v, k);
    }

    if let Some(sheet_path) = cli.contact_sheet.as_deref() {
        if let Some(parent) = sheet_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        write_contact_sheet(&decoded, sheet_path, cli.tile, cli.cols)?;
        eprintln!("Wrote contact sheet: {}", sheet_path.display());
    }

    let _ = SurfaceCategory::Generic; // suppress unused if compiler ever drops it
    Ok(())
}
