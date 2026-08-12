//! relief_v2_probe — s13 lane R evidence tool (NOT a shipped producer).
//!
//! Answers "did relief v2 actually change anything?" by running the REAL
//! shipped height chain over real `client_portal.dat` pixels and dumping the
//! competing variants side by side, so the 07-30 look and today's look can be
//! compared on identical input.
//!
//! The shipped runtime chain (apps/holtburger-web/src/lib.rs:12238) is
//!   `relief_height_classed(pixels, w, h, relief_class_for(rs_id), rs_id)`
//! and its output drives the statics-atlas `nra` R,G + POM height
//! (lib.rs:12201-12206). This probe reproduces it exactly, plus the two
//! historical variants it replaced:
//!
//!   flush     — `Some(Flush)`: macro suppressed. This is what the classifier
//!               margin-fallback demoted paneling/pagoda/torii to on 07-30.
//!   prev2     — correct class, but micro is the raw content-BLIND
//!               `micro_height` (the pre-2026-07-31 grain: value noise that
//!               dips at random, i.e. "dents ON the stones").
//!   v2        — correct class + content-FOLLOWING micro (today's shipped
//!               `relief_height_classed`).
//!   macroonly — `relief_height`: seam + pillow, no micro at all.
//!
//! Composition of prev2 mirrors height_seam.rs:767-771 exactly.
//!
//! Usage: cargo run --release --example relief_v2_probe -- --out DIR 0x06004381 ...

use holtburger_dat::file_type::{Palette, Texture, TextureDecodeError};
use holtburger_dat::height_seam::{
    self, ReliefClass, MICRO_DETAIL_FULL,
};
use holtburger_dat::DatDatabase;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

fn resolve_dat_path() -> Option<PathBuf> {
    if let Some(p) = holtburger_dat::utils::get_portal_dat_path() {
        return Some(p);
    }
    let home = std::env::var("HOME").ok()?;
    let p = PathBuf::from(home).join("ac_base_dats/client_portal.dat");
    p.exists().then_some(p)
}

/// Same table the wasm bakes in via `include_str!` (lib.rs:12164), read from
/// the repo at runtime so this native probe sees byte-identical content.
fn load_classes() -> HashMap<u32, ReliefClass> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../data/tex-relief-classes.compact.json");
    let mut map = HashMap::new();
    let Ok(txt) = fs::read_to_string(path) else {
        eprintln!("WARN: cannot read {path}");
        return map;
    };
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(&txt) else { return map };
    if let Some(obj) = doc.get("classes").and_then(|c| c.as_object()) {
        for (k, v) in obj {
            let Some(hex) = k.strip_prefix("0x") else { continue };
            let Ok(did) = u32::from_str_radix(hex, 16) else { continue };
            let Some(cls) =
                v.as_str().and_then(|s| s.bytes().next()).and_then(ReliefClass::from_code)
            else {
                continue;
            };
            map.insert(did, cls);
        }
    }
    map
}

/// Separable gaussian, used only for the DIAGNOSTIC darkness field below.
fn blur(src: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    let r = (sigma * 3.0).ceil().max(1.0) as isize;
    let mut k = Vec::new();
    let mut sum = 0.0f32;
    for i in -r..=r {
        let v = (-(i * i) as f32 / (2.0 * sigma * sigma)).exp();
        k.push(v);
        sum += v;
    }
    for v in k.iter_mut() {
        *v /= sum;
    }
    let mut tmp = vec![0.0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut a = 0.0;
            for (j, kv) in k.iter().enumerate() {
                let xx = (x as isize + j as isize - r).clamp(0, w as isize - 1) as usize;
                a += src[y * w + xx] * kv;
            }
            tmp[y * w + x] = a;
        }
    }
    let mut out = vec![0.0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut a = 0.0;
            for (j, kv) in k.iter().enumerate() {
                let yy = (y as isize + j as isize - r).clamp(0, h as isize - 1) as usize;
                a += tmp[yy * w + x] * kv;
            }
            out[y * w + x] = a;
        }
    }
    out
}

/// Reimplementation of the private `micro_detail_dark` (height_seam.rs:654-679)
/// for measurement only — same formula, same sigma, same MICRO_DETAIL_FULL.
fn darkness(rgba: &[u8], w: usize, h: usize) -> Vec<f32> {
    let n = w * h;
    let mut lum = vec![0.0f32; n];
    for i in 0..n {
        lum[i] = (0.299 * rgba[i * 4] as f32
            + 0.587 * rgba[i * 4 + 1] as f32
            + 0.114 * rgba[i * 4 + 2] as f32)
            / 255.0;
    }
    let sigma = (0.008 * w.min(h) as f32).max(0.8) * 2.5;
    let lo = blur(&lum, w, h, sigma);
    lum.iter().zip(lo).map(|(l, m)| ((m - l) / MICRO_DETAIL_FULL).clamp(0.0, 1.0)).collect()
}

fn pearson(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    if n == 0 {
        return f32::NAN;
    }
    let (ma, mb) = (
        a[..n].iter().sum::<f32>() / n as f32,
        b[..n].iter().sum::<f32>() / n as f32,
    );
    let (mut num, mut da, mut db) = (0.0f64, 0.0f64, 0.0f64);
    for i in 0..n {
        let (x, y) = ((a[i] - ma) as f64, (b[i] - mb) as f64);
        num += x * y;
        da += x * x;
        db += y * y;
    }
    if da <= 0.0 || db <= 0.0 {
        return f32::NAN;
    }
    (num / (da.sqrt() * db.sqrt())) as f32
}

fn write_u8(path: &PathBuf, v: &[f32]) {
    let b: Vec<u8> = v.iter().map(|x| (x.clamp(0.0, 1.0) * 255.0) as u8).collect();
    let _ = fs::write(path, b);
}

fn main() -> ExitCode {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut out = PathBuf::from("/tmp/relief-probe");
    if let Some(i) = args.iter().position(|a| a == "--out") {
        if i + 1 < args.len() {
            out = PathBuf::from(args.remove(i + 1));
            args.remove(i);
        }
    }
    let dids: Vec<u32> = args
        .iter()
        .filter_map(|a| u32::from_str_radix(a.trim_start_matches("0x"), 16).ok())
        .collect();
    if dids.is_empty() {
        eprintln!("usage: relief_v2_probe [--out DIR] 0x06004381 [...]");
        return ExitCode::from(2);
    }
    fs::create_dir_all(&out).ok();

    let Some(dat_path) = resolve_dat_path() else {
        eprintln!("client_portal.dat not found");
        return ExitCode::from(2);
    };
    let dat = match DatDatabase::new(&dat_path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("open {}: {e}", dat_path.display());
            return ExitCode::from(2);
        }
    };
    let classes = load_classes();
    eprintln!("class table entries: {}", classes.len());

    let mut rows = Vec::new();
    for did in dids {
        let Ok(tb) = dat.get_file(did) else {
            eprintln!("0x{did:08X}: not in dat");
            continue;
        };
        let tex = match Texture::unpack(&tb) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("0x{did:08X}: unpack {e}");
                continue;
            }
        };
        let rgba = match tex.to_rgba8(|pal_id| {
            let pb = dat
                .get_file(pal_id)
                .map_err(|e| TextureDecodeError::PaletteFetch(format!("{pal_id:#010X}: {e}")))?;
            Palette::unpack(&pb)
                .map_err(|e| TextureDecodeError::PaletteFetch(format!("{pal_id:#010X}: {e}")))
        }) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("0x{did:08X}: decode {e}");
                continue;
            }
        };
        let (w, h) = tex.actual_dimensions();
        let (wu, hu) = (w as usize, h as usize);
        if wu * hu == 0 || rgba.len() < wu * hu * 4 {
            eprintln!("0x{did:08X}: bad dims {w}x{h} len={}", rgba.len());
            continue;
        }
        let cls = classes.get(&did).copied();

        // ── the four variants ────────────────────────────────────────────
        let v2 = height_seam::relief_height_classed(&rgba, w, h, cls, did);
        let flush = height_seam::relief_height_classed(&rgba, w, h, Some(ReliefClass::Flush), did);
        let macroonly = height_seam::relief_height(&rgba, w, h);
        // pre-2026-07-31: correct class, content-BLIND micro. Composition
        // mirrors height_seam.rs:767-771.
        let prev2 = if let Some(c) = cls {
            let dir_u = matches!(c, ReliefClass::Timber | ReliefClass::Plank)
                .then(|| height_seam::grain_dir_u(&rgba, w, h))
                .unwrap_or(true);
            let micro = height_seam::micro_height(c, w, h, did, dir_u);
            match (macroonly.is_empty(), micro.is_empty()) {
                (true, true) => Vec::new(),
                (false, true) => macroonly.clone(),
                (true, false) => micro,
                (false, false) => macroonly
                    .iter()
                    .zip(micro.iter())
                    .map(|(m, u)| (m - (1.0 - u)).clamp(0.0, 1.0))
                    .collect(),
            }
        } else {
            macroonly.clone()
        };

        // ── metrics ──────────────────────────────────────────────────────
        let dark = darkness(&rgba, wu, hu);
        // Rank the macro field once: the bottom decile IS the carved joint and
        // the top decile IS the proud face, by construction. Rank-based (not
        // threshold-based) so a saturated field still yields both populations.
        let mut order: Vec<usize> = (0..macroonly.len()).collect();
        order.sort_by(|&a, &b| {
            macroonly[a].partial_cmp(&macroonly[b]).unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut face_minus_joint = f32::NAN;
        let mut face_idx: Vec<usize> = Vec::new();
        if order.len() >= 20 {
            let d = order.len() / 10;
            let joint_mean =
                order[..d].iter().map(|&i| macroonly[i] as f64).sum::<f64>() / d as f64;
            let face_mean = order[order.len() - d..]
                .iter()
                .map(|&i| macroonly[i] as f64)
                .sum::<f64>()
                / d as f64;
            face_minus_joint = (face_mean - joint_mean) as f32;
            // FACE population = upper half of the macro field. On these texels
            // the v2 composition `(m - dip).clamp(0,1)` cannot clamp, so the
            // measured dip is the true micro dip. This is exactly the owner's
            // question: on the stone FACES, do the dents follow the art?
            face_idx = order[order.len() / 2..].to_vec();
        }
        // micro dip vs the texture's own dark detail: the v2 claim is that
        // the dip FOLLOWS content (r high), where pre-v2 noise does not (r~0).
        let dip = |f: &Vec<f32>| -> Vec<f32> {
            if f.is_empty() {
                return Vec::new();
            }
            f.iter().zip(macroonly.iter()).map(|(v, m)| (m - v).max(0.0)).collect()
        };
        // Whole-tile r is CONFOUNDED: in a deep joint the macro is already ~0,
        // so `(m - dip).clamp(0,1)` pins the measured dip to 0 precisely where
        // `dark` peaks, forcing r negative regardless of behaviour. Report it
        // for transparency but judge on the face-restricted r.
        let r_v2 = if v2.is_empty() { f32::NAN } else { pearson(&dip(&v2), &dark) };
        let r_prev2 = if prev2.is_empty() { f32::NAN } else { pearson(&dip(&prev2), &dark) };
        let sub = |f: &[f32]| -> Vec<f32> { face_idx.iter().map(|&i| f[i]).collect() };
        let (mut rf_v2, mut rf_prev2) = (f32::NAN, f32::NAN);
        let (mut dipface_v2, mut dipface_prev2) = (f32::NAN, f32::NAN);
        if !face_idx.is_empty() {
            let dk = sub(&dark);
            if !v2.is_empty() {
                let dv = sub(&dip(&v2));
                rf_v2 = pearson(&dv, &dk);
                dipface_v2 = dv.iter().sum::<f32>() / dv.len() as f32;
            }
            if !prev2.is_empty() {
                let dp = sub(&dip(&prev2));
                rf_prev2 = pearson(&dp, &dk);
                dipface_prev2 = dp.iter().sum::<f32>() / dp.len() as f32;
            }
        }

        let span = |f: &Vec<f32>| -> (f32, f32) {
            if f.is_empty() {
                return (f32::NAN, f32::NAN);
            }
            (
                f.iter().cloned().fold(f32::INFINITY, f32::min),
                f.iter().cloned().fold(f32::NEG_INFINITY, f32::max),
            )
        };

        let stem = format!("{:08X}", did);
        let _ = fs::write(out.join(format!("{stem}-albedo.raw")), &rgba[..wu * hu * 4]);
        // the art's OWN pore-scale dark detail — the signal v2 claims the micro
        // dip now follows. Dumped so the claim can be checked by eye, not just
        // by correlation coefficient.
        write_u8(&out.join(format!("{stem}-dark.raw")), &dark);
        for (nm, f) in [("v2", &v2), ("flush", &flush), ("prev2", &prev2), ("macroonly", &macroonly)]
        {
            if !f.is_empty() {
                write_u8(&out.join(format!("{stem}-h-{nm}.raw")), f);
                let n = height_seam::seam_normal_rgb8(f, w, h, 1.0);
                if !n.is_empty() {
                    let _ = fs::write(out.join(format!("{stem}-n-{nm}.raw")), &n);
                }
            }
        }

        let (v2lo, v2hi) = span(&v2);
        let (fllo, flhi) = span(&flush);
        rows.push(format!(
            r#"{{"did":"0x{did:08X}","w":{w},"h":{h},"class":"{}","macroAllowed":{},"faceMinusJoint":{:.4},"rFaceV2":{:.4},"rFacePreV2":{:.4},"dipOnFaceV2":{:.4},"dipOnFacePreV2":{:.4},"rWholeV2":{:.4},"rWholePreV2":{:.4},"v2Span":[{:.4},{:.4}],"flushSpan":[{:.4},{:.4}],"v2Empty":{},"flushEmpty":{},"macroEmpty":{}}}"#,
            cls.map(|c| format!("{c:?}")).unwrap_or_else(|| "NONE".into()),
            cls.map(|c| c.allows_macro()).unwrap_or(false),
            face_minus_joint,
            rf_v2,
            rf_prev2,
            dipface_v2,
            dipface_prev2,
            r_v2,
            r_prev2,
            v2lo,
            v2hi,
            fllo,
            flhi,
            v2.is_empty(),
            flush.is_empty(),
            macroonly.is_empty(),
        ));
        eprintln!(
            "0x{did:08X} {w}x{h} class={:?} macro={} face-joint={:.3} rFACE v2={:+.3} pre={:+.3}  dipFACE v2={:.4} pre={:.4}",
            cls,
            cls.map(|c| c.allows_macro()).unwrap_or(false),
            face_minus_joint,
            rf_v2,
            rf_prev2,
            dipface_v2,
            dipface_prev2
        );
    }
    let json = format!("[\n  {}\n]\n", rows.join(",\n  "));
    let _ = fs::write(out.join("metrics.json"), &json);
    println!("{json}");
    ExitCode::SUCCESS
}
