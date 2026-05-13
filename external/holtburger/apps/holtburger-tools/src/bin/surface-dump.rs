//! Phase 1.5 — single-DID surface introspection.
//!
//! Mirrors `worldbuilder-terminal surface --did 0xXXXXXXXX --dump` from
//! §Phase 1.5 Objective #5. Implemented as a Rust binary in
//! holtburger-tools because adding subcommands to the C# WB.Terminal
//! is much higher friction (its CommandEngine pattern is large + per-op
//! switch-arm registration) and `surface-classify-audit.rs` already
//! lives here.
//!
//! Usage:
//!
//!     surface-dump --did 0x080000DD
//!     surface-dump --did 0x08000914 --preview /tmp/foo.ppm
//!     surface-dump --did 0x080000DD --landblock 0xA9B4 --sample-uses
//!
//! Output (per §Phase 1.5):
//!   1. Heuristic category for the surface.
//!   2. SurfaceStats (mean, sat, hue, lum, variance).
//!   3. Texture preview saved as PPM (skip with `--no-preview`).
//!   4. Sample-use count: polygons in the landblock that reference
//!      this surface (skip unless `--sample-uses` set; needs `--landblock`).
//!   5. Suggested override label if the heuristic is "in the gray zone"
//!      (close to a rule boundary).

use anyhow::{Context, Result};
use clap::Parser;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::env_cell::surface_did_for_envcell_index;
use holtburger_dat::file_type::{
    EnvCell, GfxObj, Palette, SetupModel, Surface, SurfaceTexture, Texture, TextureDecodeError,
};
use holtburger_dat::landblock::LandblockInfo;
use holtburger_dat::surface_classify::{classify, compute_stats, SurfaceCategory, SurfaceStats};
use std::collections::BTreeMap;
use std::io::{Cursor, Write as _};
use std::path::{Path, PathBuf};

#[derive(Parser, Debug)]
struct Cli {
    /// Surface DID (hex). Required.
    #[arg(long)]
    did: String,

    /// Path to portal DAT.
    #[arg(long, default_value = "/home/wbterminal/ac_base_dats/client_portal.dat")]
    portal_dat: PathBuf,

    /// Path to cell DAT (only needed when `--sample-uses` is set).
    #[arg(long, default_value = "/home/wbterminal/ac_base_dats/client_cell_1.dat")]
    cell_dat: PathBuf,

    /// Landblock to scan for `--sample-uses` polygon refs. Defaults
    /// to Holtburg LB 0xA9B4.
    #[arg(long, default_value = "0xA9B4")]
    landblock: String,

    /// Count polygon-references for this surface across the named
    /// landblock. Off by default (only does the local DID dump).
    #[arg(long)]
    sample_uses: bool,

    /// Path to write a PPM preview of the decoded texture. If
    /// omitted, defaults to
    /// `/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave2-p15/dump_<did>.ppm`.
    #[arg(long)]
    preview: Option<PathBuf>,

    /// Skip writing the preview file entirely.
    #[arg(long)]
    no_preview: bool,
}

fn parse_hex(s: &str) -> Result<u32> {
    let stripped = s.trim_start_matches("0x").trim_start_matches("0X");
    Ok(u32::from_str_radix(stripped, 16).context("parse hex")?)
}

/// Decode one surface to (stats, surface_type, rgba pixels, w, h, solid?).
fn decode_surface(
    portal: &DatDatabase,
    did: u32,
) -> Result<(SurfaceStats, u32, Vec<u8>, u32, u32, bool)> {
    let bytes = portal
        .get_file(did)
        .with_context(|| format!("get_file 0x{did:08X}"))?;
    let surface = Surface::unpack(&bytes).context("Surface::unpack")?;
    let surface_type = surface.surface_type;

    let (pixels, w, h, solid) = if let Some(argb) = surface.solid_color() {
        let a = ((argb >> 24) & 0xFF) as u8;
        let r = ((argb >> 16) & 0xFF) as u8;
        let g = ((argb >> 8) & 0xFF) as u8;
        let b = (argb & 0xFF) as u8;
        (vec![r, g, b, a], 1u32, 1u32, true)
    } else {
        let (st_id, _) = surface
            .textured()
            .context("surface neither solid_color nor textured")?;
        let stb = portal
            .get_file(st_id)
            .with_context(|| format!("get_file SurfaceTexture 0x{st_id:08X}"))?;
        let stx = SurfaceTexture::unpack(&stb).context("SurfaceTexture::unpack")?;
        let rs_id = stx.highest_res().context("SurfaceTexture has no highest_res")?;
        let tb = portal
            .get_file(rs_id)
            .with_context(|| format!("get_file Texture 0x{rs_id:08X}"))?;
        let tex = Texture::unpack(&tb).context("Texture::unpack")?;
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
            .context("Texture::to_rgba8")?;
        (rgba, tex.width as u32, tex.height as u32, false)
    };

    let stats = compute_stats(&pixels, w, h);
    Ok((stats, surface_type, pixels, w, h, solid))
}

/// Walk a GfxObj's polygons and accumulate per-surface-DID counts via
/// `gfx.surfaces[pos_surface]` and `gfx.surfaces[neg_surface]`.
fn count_polygon_refs_in_gfx(
    portal: &DatDatabase,
    gfx_id: u32,
    out: &mut BTreeMap<u32, u64>,
) {
    let Ok(bytes) = portal.get_file(gfx_id) else { return };
    let mut cursor = Cursor::new(&bytes);
    let Ok(gfx) = GfxObj::unpack(&mut cursor) else { return };
    for poly in gfx.polygons.values() {
        // pos_surface / neg_surface are i16 indices into gfx.surfaces.
        // Negative or out-of-bounds → no surface (matches the renderer
        // path's expectation that pos_surface=-1 means "no surface").
        if poly.pos_surface >= 0 {
            let idx = poly.pos_surface as usize;
            if let Some(&did) = gfx.surfaces.get(idx) {
                if did != 0 {
                    *out.entry(did).or_default() += 1;
                }
            }
        }
        if poly.neg_surface >= 0 {
            let idx = poly.neg_surface as usize;
            if let Some(&did) = gfx.surfaces.get(idx) {
                if did != 0 {
                    *out.entry(did).or_default() += 1;
                }
            }
        }
    }
}

/// Surface ID can be a raw GfxObj (0x01...) or a SetupModel (0x02...);
/// SetupModel.parts each point at a GfxObj.
fn count_polygon_refs_in_setup_or_gfx(
    portal: &DatDatabase,
    id: u32,
    out: &mut BTreeMap<u32, u64>,
) {
    let top = (id >> 24) & 0xFF;
    match top {
        0x01 => count_polygon_refs_in_gfx(portal, id, out),
        0x02 => {
            let Ok(bytes) = portal.get_file(id) else { return };
            let mut cursor = Cursor::new(&bytes);
            let Ok(setup) = SetupModel::read(&mut cursor) else { return };
            for part in setup.parts {
                count_polygon_refs_in_gfx(portal, part, out);
            }
        }
        _ => {}
    }
}

/// Tally polygon refs per surface across one landblock. Mirrors
/// `surface-classify-audit::discover_surfaces` walk but counts refs
/// instead of de-duping.
fn count_polygon_refs_in_landblock(
    portal: &DatDatabase,
    cell: &DatDatabase,
    landblock_key: u16,
) -> BTreeMap<u32, u64> {
    let mut out: BTreeMap<u32, u64> = BTreeMap::new();
    let lb_word = (landblock_key as u32) << 16;

    let info_id = lb_word | 0xFFFE;
    if let Ok(bytes) = cell.get_file(info_id) {
        if let Ok(info) = LandblockInfo::unpack(&bytes) {
            for stab in &info.objects {
                count_polygon_refs_in_setup_or_gfx(portal, stab.id, &mut out);
            }
            for b in &info.buildings {
                count_polygon_refs_in_setup_or_gfx(portal, b.model_id, &mut out);
            }
        }
    }
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
                // EnvCell-surface refs aren't polygon refs (they're
                // packed wire indices into the EnvironmentTable's
                // per-cell-template surface array), so we don't
                // overcount them here — they show up once per cell
                // template. Inside static_objects we descend into
                // GfxObj polygons.
                for wire_surf in &envcell.surfaces {
                    let did = surface_did_for_envcell_index(*wire_surf);
                    *out.entry(did).or_default() += 1;
                }
                for stab in &envcell.static_objects {
                    count_polygon_refs_in_setup_or_gfx(portal, stab.stab_id, &mut out);
                }
            }
        }
    }
    out.remove(&0);
    out
}

/// Heuristic gray-zone check: returns a suggested label if the surface
/// sits within 0.05 of a rule boundary (per §Phase 1.5 Objective #5).
/// This is best-effort — the alternatives marked are the rules the
/// heuristic *almost* fired on.
fn suggest_override(stats: &SurfaceStats, surface_type: u32, current: SurfaceCategory) -> Option<String> {
    let sat = stats.saturation;
    let lum = stats.luminance;
    let hue = stats.dominant_hue;
    let var = stats.variance;
    let translucent = (surface_type & 0x10) != 0;
    let luminous = (surface_type & 0x40) != 0;

    // Stone-rough boundary: sat in [0.20, 0.30] with low lum often
    // means "blue-grey stone the rule missed".
    if matches!(current, SurfaceCategory::Generic)
        && lum >= 0.10
        && (0.20..=0.30).contains(&sat)
        && var < 0.08
    {
        return Some("Stone (gray-zone: sat ∈ [0.20,0.30], close to Stone-rough's 0.25 cap)".into());
    }
    // Dirt hue band: 50–60° is right outside Rule 8's 55° upper bound.
    if matches!(current, SurfaceCategory::Generic)
        && (50.0..=65.0).contains(&hue)
        && (0.15..=0.45).contains(&sat)
        && lum < 0.55
    {
        return Some("Dirt (gray-zone: hue ∈ [50,65], just outside Rule 8's 15-55 band)".into());
    }
    // Translucent + saturated red → Cloth/banner (no heuristic rule).
    if matches!(current, SurfaceCategory::Generic)
        && translucent
        && !luminous
        && sat > 0.7
        && (hue < 20.0 || hue > 340.0)
    {
        return Some("Cloth (translucent + saturated red, no heuristic rule fires)".into());
    }
    // Snow-on-grey: Snow rule fires for any near-white smooth surface
    // (var < 0.02, sat < 0.12, lum > 0.78). A solid-grey surface that
    // gets Snow but lacks contextual snow signal should go Generic.
    if matches!(current, SurfaceCategory::Snow)
        && stats.std_dev[0] < 0.02
        && stats.std_dev[1] < 0.02
        && stats.std_dev[2] < 0.02
    {
        return Some("Generic (uniform light grey, no contextual snow signal — Snow rule fires on any near-white smooth surface)".into());
    }
    None
}

/// PPM writer (matches the surface-classify-audit pattern). Universal
/// viewer support (Eye of GNOME, ImageMagick `convert`, IrfanView).
fn write_ppm(path: &Path, rgba: &[u8], w: u32, h: u32) -> Result<()> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).ok();
    }
    let mut f = std::fs::File::create(path).with_context(|| format!("create {}", path.display()))?;
    writeln!(f, "P6")?;
    writeln!(f, "{} {}", w, h)?;
    writeln!(f, "255")?;
    for i in 0..(w * h) as usize {
        f.write_all(&rgba[i * 4..i * 4 + 3])?;
    }
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let did = parse_hex(&cli.did)?;
    let landblock_key = (parse_hex(&cli.landblock)? & 0xFFFF) as u16;

    eprintln!("Loading portal dat: {}", cli.portal_dat.display());
    let portal = DatDatabase::new(&cli.portal_dat)?;

    let (stats, surface_type, pixels, w, h, solid) = decode_surface(&portal, did)?;
    let category = classify(&stats, surface_type);

    println!("Surface DID:       0x{:08X}", did);
    println!("Category (heuristic): {}", category.label());
    println!("Solid:             {}", solid);
    println!("Dimensions:        {}x{}", w, h);
    println!("surface_type:      {:#x}", surface_type);
    println!("                   (Translucent=0x10, Luminous=0x40, Base1ClipMap=0x4,");
    println!("                    Additive=0x10000, Diffuse=0x20)");
    println!("--- SurfaceStats ---");
    println!(
        "Mean RGB:          ({:.4}, {:.4}, {:.4})",
        stats.mean[0], stats.mean[1], stats.mean[2]
    );
    println!(
        "Std dev:           ({:.4}, {:.4}, {:.4})",
        stats.std_dev[0], stats.std_dev[1], stats.std_dev[2]
    );
    println!("Luminance:         {:.4}", stats.luminance);
    println!("Variance (lum):    {:.6}", stats.variance);
    println!("Dominant hue:      {:.1}°", stats.dominant_hue);
    println!("Saturation:        {:.4}", stats.saturation);

    if let Some(s) = suggest_override(&stats, surface_type, category) {
        println!("--- Suggested override ---");
        println!("{}", s);
    } else {
        println!("--- Suggested override ---");
        println!("(none — heuristic confident or already covered by overrides)");
    }

    if !cli.no_preview {
        let path = cli.preview.unwrap_or_else(|| {
            PathBuf::from(format!(
                "/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave2-p15/dump_0x{:08X}.ppm",
                did
            ))
        });
        write_ppm(&path, &pixels, w, h)?;
        println!("--- Preview ---");
        println!("Wrote PPM preview: {}", path.display());
    }

    if cli.sample_uses {
        eprintln!("Loading cell dat: {}", cli.cell_dat.display());
        let cell = DatDatabase::new(&cli.cell_dat)?;
        eprintln!("Counting polygon refs in landblock 0x{:04X}…", landblock_key);
        let counts = count_polygon_refs_in_landblock(&portal, &cell, landblock_key);
        let count = counts.get(&did).copied().unwrap_or(0);
        println!("--- Sample uses ---");
        println!("Polygons in LB 0x{:04X} referencing 0x{:08X}: {}", landblock_key, did, count);
    }
    Ok(())
}
