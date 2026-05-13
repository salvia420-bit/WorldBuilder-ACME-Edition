//! Phase 1.5 — top-N most-used surfaces in a landblock.
//!
//! Mirrors `worldbuilder-terminal surface --hero-survey --landblock 0xA9B4`
//! from §Phase 1.5 Objective #6. Implemented as a Rust binary in
//! holtburger-tools (see surface-dump.rs's preamble for the rationale).
//!
//! Usage:
//!
//!     surface-hero-survey --landblock 0xA9B4
//!     surface-hero-survey --landblock 0xA9B4 --top 100 --json /tmp/hero.json
//!
//! Output is a polygon-reference-count ranking. Used by Phase 2.3 to
//! pick which surfaces deserve authored PBR maps.

use anyhow::{Context, Result};
use clap::Parser;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::env_cell::surface_did_for_envcell_index;
use holtburger_dat::file_type::{
    EnvCell, GfxObj, Palette, SetupModel, Surface, SurfaceTexture, Texture, TextureDecodeError,
};
use holtburger_dat::landblock::LandblockInfo;
use holtburger_dat::surface_classify::{classify, compute_stats};
use serde::Serialize;
use std::collections::BTreeMap;
use std::io::Cursor;
use std::path::PathBuf;

#[derive(Parser, Debug)]
struct Cli {
    /// Landblock key (hex, 0xAABB form). Defaults to Holtburg.
    #[arg(long, default_value = "0xA9B4")]
    landblock: String,

    /// Path to portal DAT.
    #[arg(long, default_value = "/home/wbterminal/ac_base_dats/client_portal.dat")]
    portal_dat: PathBuf,

    /// Path to cell DAT.
    #[arg(long, default_value = "/home/wbterminal/ac_base_dats/client_cell_1.dat")]
    cell_dat: PathBuf,

    /// Top-N count. Default 50 (§Phase 1.5 Objective #6).
    #[arg(long, default_value = "50")]
    top: usize,

    /// Output JSON path. If omitted, prints a table to stdout.
    #[arg(long)]
    json: Option<PathBuf>,

    /// Include heuristic-classified category in the output (slightly
    /// slower — has to decode every top-N surface). On by default.
    #[arg(long, default_value = "true")]
    with_category: bool,
}

fn parse_hex(s: &str) -> Result<u32> {
    let stripped = s.trim_start_matches("0x").trim_start_matches("0X");
    Ok(u32::from_str_radix(stripped, 16).context("parse hex")?)
}

fn count_polygon_refs_in_gfx(portal: &DatDatabase, gfx_id: u32, out: &mut BTreeMap<u32, u64>) {
    let Ok(bytes) = portal.get_file(gfx_id) else { return };
    let mut cursor = Cursor::new(&bytes);
    let Ok(gfx) = GfxObj::unpack(&mut cursor) else { return };
    for poly in gfx.polygons.values() {
        if poly.pos_surface >= 0 {
            if let Some(&did) = gfx.surfaces.get(poly.pos_surface as usize) {
                if did != 0 {
                    *out.entry(did).or_default() += 1;
                }
            }
        }
        if poly.neg_surface >= 0 {
            if let Some(&did) = gfx.surfaces.get(poly.neg_surface as usize) {
                if did != 0 {
                    *out.entry(did).or_default() += 1;
                }
            }
        }
    }
}

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
                // EnvCell surface refs are once per template; weight 1.
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

/// Decode one surface enough to get the heuristic category. Returns
/// `None` on decode failure (caller emits the row with `category=null`).
fn classify_did(portal: &DatDatabase, did: u32) -> Option<String> {
    let bytes = portal.get_file(did).ok()?;
    let surface = Surface::unpack(&bytes).ok()?;
    let surface_type = surface.surface_type;
    let (pixels, w, h) = if let Some(argb) = surface.solid_color() {
        let a = ((argb >> 24) & 0xFF) as u8;
        let r = ((argb >> 16) & 0xFF) as u8;
        let g = ((argb >> 8) & 0xFF) as u8;
        let b = (argb & 0xFF) as u8;
        (vec![r, g, b, a], 1u32, 1u32)
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
                    TextureDecodeError::PaletteFetch(format!("Palette::unpack {pal_id:#010X}: {e}"))
                })
            })
            .ok()?;
        (rgba, tex.width as u32, tex.height as u32)
    };
    let stats = compute_stats(&pixels, w, h);
    let cat = classify(&stats, surface_type);
    Some(cat.label().to_string())
}

#[derive(Serialize)]
struct HeroRow {
    rank: usize,
    did: String,
    polygon_refs: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    category: Option<String>,
}

#[derive(Serialize)]
struct HeroDoc {
    landblock: String,
    portal_dat: String,
    cell_dat: String,
    total_unique_surfaces: usize,
    top: usize,
    rows: Vec<HeroRow>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let landblock_packed = parse_hex(&cli.landblock)?;
    let landblock_word = (landblock_packed & 0xFFFF) as u16;

    eprintln!("Loading portal dat: {}", cli.portal_dat.display());
    let portal = DatDatabase::new(&cli.portal_dat)?;
    eprintln!("Loading cell dat: {}", cli.cell_dat.display());
    let cell = DatDatabase::new(&cli.cell_dat)?;

    eprintln!(
        "Counting polygon refs in landblock 0x{:04X}…",
        landblock_word
    );
    let counts = count_polygon_refs_in_landblock(&portal, &cell, landblock_word);
    eprintln!("  {} unique surface DIDs referenced", counts.len());

    // Sort by ref-count descending (tie-break: DID ascending).
    let mut ranked: Vec<(u32, u64)> = counts.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    ranked.truncate(cli.top);

    let mut rows = Vec::with_capacity(ranked.len());
    for (i, (did, refs)) in ranked.iter().enumerate() {
        let cat = if cli.with_category {
            classify_did(&portal, *did)
        } else {
            None
        };
        rows.push(HeroRow {
            rank: i + 1,
            did: format!("0x{:08X}", did),
            polygon_refs: *refs,
            category: cat,
        });
    }

    if let Some(json_path) = cli.json.as_deref() {
        if let Some(p) = json_path.parent() {
            std::fs::create_dir_all(p).ok();
        }
        let doc = HeroDoc {
            landblock: format!("0x{:04X}", landblock_word),
            portal_dat: cli.portal_dat.display().to_string(),
            cell_dat: cli.cell_dat.display().to_string(),
            total_unique_surfaces: rows.len(),
            top: cli.top,
            rows,
        };
        let s = serde_json::to_string_pretty(&doc)?;
        std::fs::write(json_path, s).with_context(|| format!("write {}", json_path.display()))?;
        eprintln!("Wrote JSON: {}", json_path.display());
    } else {
        // Table to stdout.
        println!(
            "Top {} surfaces in landblock 0x{:04X}",
            rows.len(),
            landblock_word
        );
        println!(
            "{:>4} {:>12} {:>10} {}",
            "rank", "did", "poly_refs", "category"
        );
        for r in &rows {
            println!(
                "{:>4} {:>12} {:>10} {}",
                r.rank,
                r.did,
                r.polygon_refs,
                r.category.as_deref().unwrap_or("(unknown)")
            );
        }
    }
    Ok(())
}
