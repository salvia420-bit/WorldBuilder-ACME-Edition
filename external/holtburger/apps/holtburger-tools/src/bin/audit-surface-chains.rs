//! audit-surface-chains — read-only DAT integrity audit of the material
//! resolution chain (E3 of the 2026-06-07 port plan; companion to
//! `audit-polygon-sides`, which audits polygon *sides* — this audits
//! material *chains*).
//!
//! Enforces the world-completeness guarantee that "every rendered surface
//! pixel has an addressable DAT source", catching a broken surface ref
//! BEFORE a WB.Terminal export ships it. Two checks over an HBA:
//!
//!   A. model → surface: every `GfxObj.surfaces` DID must resolve to a
//!      Surface (0x08) record (dangling model→surface references).
//!   B. surface chain: for every Surface (0x08), if it is textured
//!      (`orig_texture_id != 0`), the chain
//!         Surface(0x08) → SurfaceTexture(0x05).highest_res() → Texture(0x06)
//!      must be intact, and `orig_palette_id` must resolve to a Palette
//!      (0x04). Solid-colour surfaces (no texture) are counted separately.
//!
//! Strictly diagnostic: parse + tally + print. No write / mutate / export.
//! Uses `from_id_in_dat` (the fork's indoor-cell-misclassification fix).

use std::collections::BTreeSet;
use std::io::Cursor;

use anyhow::{Context, Result};
use clap::Parser;
use holtburger_dat::file_type::{
    DatFileType, DatKind, GfxObj, Palette, Surface, SurfaceTexture, Texture,
};
use holtburger_dat::{EOR_PORTAL_NAMESPACE, HbaReader};

const SAMPLE_LIMIT: usize = 12;

#[derive(Parser, Debug)]
#[command(about = "Read-only audit of Surface→SurfaceTexture→Texture / →Palette chain integrity")]
struct Args {
    /// Path to the HBA archive (e.g. assets.hba) to audit.
    #[arg(long)]
    dats: String,
}

#[derive(Default)]
struct ChainAudit {
    gfx_objs: usize,
    referenced_surface_dids: BTreeSet<u32>,
    surface_records: BTreeSet<u32>,

    total_surfaces: usize,
    textured_surfaces: usize,
    solid_surfaces: usize,
    surface_parse_errors: usize,

    missing_surface_texture: usize,
    empty_surface_texture: usize, // SurfaceTexture has no texture entry
    missing_texture: usize,
    missing_palette: usize,

    dangling_samples: Vec<String>,
    broken_chain_samples: Vec<String>,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let archive = HbaReader::open(&args.dats)
        .with_context(|| format!("failed to open HBA archive {}", args.dats))?;
    let mut a = ChainAudit::default();

    let resolves = |did: u32| -> Option<Vec<u8>> {
        archive.get_file_in_namespace(EOR_PORTAL_NAMESPACE, did).ok()
    };

    for entry in archive.entries() {
        let entry = entry?;
        let namespace = entry.namespace_id()?;
        if namespace.as_str() != EOR_PORTAL_NAMESPACE {
            continue;
        }
        let ty = DatFileType::from_id_in_dat(entry.file_id, DatKind::Portal);

        if ty == DatFileType::Model {
            let bytes = archive.get_file_in_namespace(EOR_PORTAL_NAMESPACE, entry.file_id)?;
            if let Ok(gfx_obj) = GfxObj::unpack(&mut Cursor::new(bytes)) {
                a.gfx_objs += 1;
                for did in gfx_obj.surfaces {
                    a.referenced_surface_dids.insert(did);
                }
            }
            continue;
        }

        if ty == DatFileType::Surface {
            a.surface_records.insert(entry.file_id);
            a.total_surfaces += 1;
            let bytes = archive.get_file_in_namespace(EOR_PORTAL_NAMESPACE, entry.file_id)?;
            let surface = match Surface::unpack(&bytes) {
                Ok(s) => s,
                Err(_) => {
                    a.surface_parse_errors += 1;
                    push(
                        &mut a.broken_chain_samples,
                        format!("surface/0x{:08X}:parse-error", entry.file_id),
                    );
                    continue;
                }
            };
            match surface.textured() {
                None => {
                    a.solid_surfaces += 1;
                }
                Some((tex_id, pal_id)) => {
                    a.textured_surfaces += 1;
                    // Surface → SurfaceTexture(0x05) → highest_res() → Texture(0x06)
                    match resolves(tex_id) {
                        None => {
                            a.missing_surface_texture += 1;
                            push(
                                &mut a.broken_chain_samples,
                                format!(
                                    "surface/0x{:08X}:missing-surface-texture/0x{:08X}",
                                    entry.file_id, tex_id
                                ),
                            );
                        }
                        Some(stb) => match SurfaceTexture::unpack(&stb).ok().and_then(|st| st.highest_res()) {
                            None => {
                                a.empty_surface_texture += 1;
                                push(
                                    &mut a.broken_chain_samples,
                                    format!(
                                        "surface/0x{:08X}:surface-texture/0x{:08X}:no-texture-entry",
                                        entry.file_id, tex_id
                                    ),
                                );
                            }
                            Some(texture_did) => {
                                let ok = resolves(texture_did)
                                    .map(|tb| Texture::unpack(&tb).is_ok())
                                    .unwrap_or(false);
                                if !ok {
                                    a.missing_texture += 1;
                                    push(
                                        &mut a.broken_chain_samples,
                                        format!(
                                            "surface/0x{:08X}:missing-texture/0x{:08X}",
                                            entry.file_id, texture_did
                                        ),
                                    );
                                }
                            }
                        },
                    }
                    // orig_palette_id → Palette(0x04)
                    if pal_id != 0 {
                        let ok = resolves(pal_id)
                            .map(|pb| Palette::unpack(&pb).is_ok())
                            .unwrap_or(false);
                        if !ok {
                            a.missing_palette += 1;
                            push(
                                &mut a.broken_chain_samples,
                                format!(
                                    "surface/0x{:08X}:missing-palette/0x{:08X}",
                                    entry.file_id, pal_id
                                ),
                            );
                        }
                    }
                }
            }
        }
    }

    // A. model → surface dangling references (referenced but no Surface record).
    let mut dangling = 0usize;
    for did in &a.referenced_surface_dids {
        if !a.surface_records.contains(did) {
            dangling += 1;
            push(&mut a.dangling_samples, format!("gfx-obj-surface-ref/0x{did:08X}:no-surface-record"));
        }
    }

    print_report(&a, dangling);
    Ok(())
}

fn print_report(a: &ChainAudit, dangling: usize) {
    println!("surface-chain audit");
    println!("  gfxObjs={} referencedSurfaceDids={}", a.gfx_objs, a.referenced_surface_dids.len());
    println!(
        "  surfaces total={} textured={} solid={} parseErrors={}",
        a.total_surfaces, a.textured_surfaces, a.solid_surfaces, a.surface_parse_errors
    );
    println!(
        "  chainBreaks missingSurfaceTexture={} emptySurfaceTexture={} missingTexture={} missingPalette={}",
        a.missing_surface_texture, a.empty_surface_texture, a.missing_texture, a.missing_palette
    );
    println!("  danglingModelSurfaceRefs={}", dangling);
    print_samples("danglingSamples", &a.dangling_samples);
    print_samples("brokenChainSamples", &a.broken_chain_samples);
}

fn print_samples(label: &str, samples: &[String]) {
    if samples.is_empty() {
        return;
    }
    println!("  {label}:");
    for s in samples {
        println!("    {s}");
    }
}

fn push(samples: &mut Vec<String>, sample: String) {
    if samples.len() < SAMPLE_LIMIT {
        samples.push(sample);
    }
}
