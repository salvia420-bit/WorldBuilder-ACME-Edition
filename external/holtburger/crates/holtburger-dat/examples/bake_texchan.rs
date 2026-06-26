//! bake_texchan — Phase-5 S5 producer (the OFFLINE half of the migration).
//!
//! Bakes per-surface material-detail sidecars (texchan: normal + roughness
//! + AO) from real `client_portal.dat`. Replicates the runtime's exact
//! ingest chain (`apps/holtburger-web/src/lib.rs::fetch_surface_pixels_impl`):
//!
//!   Surface(0x08) -> SurfaceTexture(0x05).highest_res() -> Texture(0x06)
//!     -> actual_dimensions() -> to_rgba8(palette) -> normal_from_luminance(_,1.0)
//!
//! so the baked NORMAL channel is byte-identical to what the runtime
//! generates at ingest (the S6 bit-compare proves it). roughness + AO are
//! the new channels, ALSO generated at strength 1.0 — per-category strength
//! stays a runtime JS concern (materials.js normalScale/detail tables),
//! exactly as the runtime already applies it. Nothing per-category is baked
//! into pixels, so the bake needs no classifier (S3 dropped).
//!
//! Keyed by content-hash (`texchan::fingerprint`) so surfaces with identical
//! decoded pixels dedup to one artifact; `texchan-manifest.json` maps
//! surfaceDid -> stem for the S6 consumer. Skipped: LUMINOUS (emissive —
//! the runtime bakes no normal; bump on glow looks wrong), solid 1x1, and
//! non-textured surfaces (no gradient / no texture).
//!
//! Deterministic: DIDs sorted, fixed field order, dedup picks the first
//! (lowest) DID's content. Re-run -> byte-identical artifacts.
//!
//! Usage: `cargo run --example bake_texchan -- [--limit N] [--out DIR]`
//!   --limit N : bake only the first N (sorted) surface DIDs (0/absent = all)
//!   --out DIR : output dir (default $HOLTBURGER_DIST/suite or
//!               /mnt/wbterminal2/holtburger-dist/suite)

use holtburger_dat::file_type::{Palette, Surface, SurfaceTexture, Texture, TextureDecodeError};
use holtburger_dat::normal_gen::{ao_from_luminance, normal_from_luminance, roughness_from_luminance};
use holtburger_dat::surface_classify::surface_type_flags::LUMINOUS;
use holtburger_dat::DatDatabase;
use holtburger_suite_bake::texchan::{fingerprint, TexChan};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const SURFACE_TYPE_ID: u32 = 0x0800_0000; // 0x08 Surface DID space
const SURFACE_TYPE_MASK: u32 = 0xFF00_0000;

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

/// Streamed SHA-256 of a file (the 926 MB portal.dat must not be slurped).
fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = BufReader::new(File::open(path)?);
    let mut h = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}

#[derive(Default)]
struct Stats {
    scanned: u64,
    baked: u64,            // surfaceDids that produced a texchan
    unique_artifacts: u64, // distinct content-hash stems written
    dedup_reuse: u64,      // surfaceDids that reused an existing stem
    skip_reject_ff: u64,   // 0x__FFxxxx derived id rejected (base-dats rule)
    skip_surface_parse: u64,
    skip_solid_or_untextured: u64,
    skip_chain: u64, // surf_tex / highres / texture fetch or parse failed
    skip_decode: u64,
    skip_luminous: u64,
    skip_empty_normal: u64,
}

fn main() -> ExitCode {
    // --- args ---
    let mut limit: usize = 0;
    let mut out_dir: Option<PathBuf> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--limit" => limit = args.next().and_then(|v| v.parse().ok()).unwrap_or(0),
            "--out" => out_dir = args.next().map(PathBuf::from),
            other => {
                eprintln!("unknown arg: {other}");
                return ExitCode::from(2);
            }
        }
    }
    let out = out_dir.unwrap_or_else(dist_suite_dir);

    // --- open dat ---
    let dat_path = match resolve_dat_path() {
        Some(p) => p,
        None => {
            eprintln!("client_portal.dat not found (set HOME or HOLTBURGER_DIST)");
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

    // --- enumerate surface DIDs (sorted = deterministic) ---
    let mut dids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|id| (id & SURFACE_TYPE_MASK) == SURFACE_TYPE_ID)
        .collect();
    dids.sort_unstable();

    if let Err(e) = fs::create_dir_all(&out) {
        eprintln!("create {}: {e}", out.display());
        return ExitCode::from(2);
    }

    let mut stats = Stats::default();
    let mut manifest: BTreeMap<String, String> = BTreeMap::new(); // "0x%08X" did -> stem
    let mut written: HashSet<String> = HashSet::new();

    for &did in &dids {
        if limit != 0 && stats.scanned as usize >= limit {
            break;
        }
        stats.scanned += 1;

        // base-dats rule: reject 0x__FFxxxx derived ids.
        if ((did >> 16) & 0xFF) == 0xFF {
            stats.skip_reject_ff += 1;
            continue;
        }

        let tc = match build_texchan(&dat, did, &mut stats) {
            Some(tc) => tc,
            None => continue,
        };

        let stem = format!("0x{:016X}", fingerprint(&tc));
        manifest.insert(format!("0x{did:08X}"), stem.clone());

        if written.insert(stem.clone()) {
            let path = out.join(format!("{stem}.texchan.bin"));
            if let Err(e) = fs::write(&path, tc.encode()) {
                eprintln!("write {}: {e}", path.display());
                return ExitCode::from(2);
            }
            stats.unique_artifacts += 1;
        } else {
            stats.dedup_reuse += 1;
        }
        stats.baked += 1;
    }

    // --- manifest ---
    let manifest_path = out.join("texchan-manifest.json");
    if let Err(e) = fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest).unwrap()) {
        eprintln!("write manifest: {e}");
        return ExitCode::from(2);
    }

    // --- coverage ---
    let coverage = serde_json::json!({
        "scanned": stats.scanned,
        "baked": stats.baked,
        "uniqueArtifacts": stats.unique_artifacts,
        "dedupReuse": stats.dedup_reuse,
        "skipped": {
            "rejectFf": stats.skip_reject_ff,
            "surfaceParse": stats.skip_surface_parse,
            "solidOrUntextured": stats.skip_solid_or_untextured,
            "chain": stats.skip_chain,
            "decode": stats.skip_decode,
            "luminous": stats.skip_luminous,
            "emptyNormal": stats.skip_empty_normal,
        },
        "limit": limit,
    });
    if let Err(e) = fs::write(
        out.join("texchan-coverage.json"),
        serde_json::to_vec_pretty(&coverage).unwrap(),
    ) {
        eprintln!("write coverage: {e}");
        return ExitCode::from(2);
    }

    // --- bake-source provenance (bake-base-dats-only rule) ---
    match sha256_file(&dat_path) {
        Ok(sha) => {
            let _ = fs::write(
                out.join("bake-source.sha256"),
                format!("{sha}  {}\n", dat_path.display()),
            );
        }
        Err(e) => eprintln!("warn: bake-source sha failed: {e}"),
    }

    println!(
        "texchan bake: scanned={} baked={} unique={} dedup_reuse={} | skip ff={} parse={} solid/untex={} chain={} decode={} lum={} empty={}",
        stats.scanned, stats.baked, stats.unique_artifacts, stats.dedup_reuse,
        stats.skip_reject_ff, stats.skip_surface_parse, stats.skip_solid_or_untextured,
        stats.skip_chain, stats.skip_decode, stats.skip_luminous, stats.skip_empty_normal,
    );
    println!("out: {}", out.display());
    ExitCode::SUCCESS
}

/// Replicate the runtime ingest chain for one surface DID and bake a
/// TexChan, or `None` (with a skip-reason counted) when it has no detail.
fn build_texchan(dat: &DatDatabase, did: u32, stats: &mut Stats) -> Option<TexChan> {
    let bytes = match dat.get_file(did) {
        Ok(b) => b,
        Err(_) => {
            stats.skip_chain += 1;
            return None;
        }
    };
    let surface = match Surface::unpack(&bytes) {
        Ok(s) => s,
        Err(_) => {
            stats.skip_surface_parse += 1;
            return None;
        }
    };
    let surface_type = surface.surface_type;

    // Solid (1x1, no texture) -> runtime emits no normal. Skip.
    if surface.solid_color().is_some() {
        stats.skip_solid_or_untextured += 1;
        return None;
    }
    let surf_tex_id = match surface.textured() {
        Some((id, _)) => id,
        None => {
            stats.skip_solid_or_untextured += 1;
            return None;
        }
    };

    // LUMINOUS -> runtime skips normal/height (bump on glow looks wrong).
    if (surface_type & LUMINOUS) != 0 {
        stats.skip_luminous += 1;
        return None;
    }

    let stb = match dat.get_file(surf_tex_id) {
        Ok(b) => b,
        Err(_) => {
            stats.skip_chain += 1;
            return None;
        }
    };
    let surf_tex = match SurfaceTexture::unpack(&stb) {
        Ok(s) => s,
        Err(_) => {
            stats.skip_chain += 1;
            return None;
        }
    };
    let rs_id = match surf_tex.highest_res() {
        Some(id) => id,
        None => {
            stats.skip_chain += 1;
            return None;
        }
    };
    let tb = match dat.get_file(rs_id) {
        Ok(b) => b,
        Err(_) => {
            stats.skip_chain += 1;
            return None;
        }
    };
    let tex = match Texture::unpack(&tb) {
        Ok(t) => t,
        Err(_) => {
            stats.skip_chain += 1;
            return None;
        }
    };
    let (w, h) = tex.actual_dimensions();

    let rgba = tex.to_rgba8(|pal_id| {
        let pb = dat
            .get_file(pal_id)
            .map_err(|e| TextureDecodeError::PaletteFetch(format!("{pal_id:#010X}: {e}")))?;
        Palette::unpack(&pb)
            .map_err(|e| TextureDecodeError::PaletteFetch(format!("Palette::unpack {pal_id:#010X}: {e}")))
    });
    let pixels = match rgba {
        Ok(p) => p,
        Err(_) => {
            stats.skip_decode += 1;
            return None;
        }
    };

    // Same generation the runtime runs at ingest, strength 1.0 (byte-identical
    // normal). roughness/AO are the new channels, also at 1.0.
    let normal = normal_from_luminance(&pixels, w, h, 1.0);
    if normal.is_empty() {
        stats.skip_empty_normal += 1;
        return None;
    }
    let roughness = roughness_from_luminance(&pixels, w, h, 1.0);
    let ao = ao_from_luminance(&pixels, w, h, 1.0);

    Some(TexChan {
        width: w,
        height: h,
        normal: Some(normal),
        roughness: Some(roughness),
        ao: Some(ao),
    })
}
