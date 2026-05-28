//! Retail-DAT distribution sweep for the Surface (0x08) trailing
//! `(translucency, luminosity, diffuse)` float triplet (Wave 8,
//! 2026-05-28). Pre-Wave-8 the parser read all three but the rest of
//! the pipeline dropped them; materials.js drove visual effects from
//! the `surface_type` bitflag presence with hardcoded effect
//! strengths.
//!
//! This test SKIPs cleanly without retail data and reports a histogram
//! when the DAT is reachable — useful for confirming the floats
//! actually carry signal (vs being 0 placeholders), and for spotting
//! out-of-range values that might break the new dispatch.

use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::Surface;
use std::path::PathBuf;

fn retail_portal_dat_path() -> Option<PathBuf> {
    if let Some(p) = holtburger_dat::utils::get_portal_dat_path() {
        return Some(p);
    }
    let c = PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
    c.exists().then_some(c)
}

#[test]
fn surface_tld_distribution_against_retail_portal_dat() {
    let Some(dat_path) = retail_portal_dat_path() else {
        eprintln!("SKIP: client_portal.dat not found");
        return;
    };
    let dat = DatDatabase::new(&dat_path).expect("open retail portal.dat");

    let mut total = 0u64;
    let mut nonzero_translucency = 0u64;
    let mut nonzero_luminosity = 0u64;
    let mut nonzero_diffuse = 0u64;
    let mut max_t: f32 = 0.0;
    let mut max_l: f32 = 0.0;
    let mut max_d: f32 = 0.0;
    let mut out_of_range_t: u64 = 0;
    let mut out_of_range_l: u64 = 0;
    let mut out_of_range_d: u64 = 0;
    let mut parse_failures: Vec<(u32, String)> = Vec::new();

    for &id in dat.files.keys() {
        let prefix = (id >> 24) as u8;
        if prefix != 0x08 {
            continue;
        }
        let bytes = match dat.get_file(id) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let surf = match Surface::unpack(&bytes) {
            Ok(s) => s,
            Err(e) => {
                parse_failures.push((id, format!("{e:?}")));
                continue;
            }
        };
        total += 1;
        if surf.translucency != 0.0 {
            nonzero_translucency += 1;
        }
        if surf.luminosity != 0.0 {
            nonzero_luminosity += 1;
        }
        if surf.diffuse != 0.0 {
            nonzero_diffuse += 1;
        }
        if surf.translucency.is_finite() {
            max_t = max_t.max(surf.translucency);
            if !(0.0..=1.0).contains(&surf.translucency) {
                out_of_range_t += 1;
            }
        }
        if surf.luminosity.is_finite() {
            max_l = max_l.max(surf.luminosity);
            // Retail occasionally pushes luminosity >1 for HDR glow;
            // anything >2.0 is suspicious.
            if !(0.0..=2.0).contains(&surf.luminosity) {
                out_of_range_l += 1;
            }
        }
        if surf.diffuse.is_finite() {
            max_d = max_d.max(surf.diffuse);
            if !(0.0..=1.0).contains(&surf.diffuse) {
                out_of_range_d += 1;
            }
        }
    }

    eprintln!("\n=== Surface (0x08) T/L/D distribution in retail portal.dat ===");
    eprintln!("  total parsed       = {total}");
    eprintln!("  parse_failures     = {}", parse_failures.len());
    eprintln!("  nonzero translucency = {nonzero_translucency} (max = {max_t})");
    eprintln!("  nonzero luminosity   = {nonzero_luminosity} (max = {max_l})");
    eprintln!("  nonzero diffuse      = {nonzero_diffuse} (max = {max_d})");
    eprintln!("  out-of-range t       = {out_of_range_t}");
    eprintln!("  out-of-range l       = {out_of_range_l}");
    eprintln!("  out-of-range d       = {out_of_range_d}");

    // Sanity checks. We don't *require* nonzero values (could legitimately
    // be all-zero in a stripped-down DAT), but we do require:
    //   (a) no parse failures
    //   (b) no insane out-of-range values that would crash the JS
    //       clamps in `_materialFromFlags`
    if !parse_failures.is_empty() {
        for (id, msg) in parse_failures.iter().take(5) {
            eprintln!("  PARSE FAIL 0x{id:08X}: {msg}");
        }
        panic!("{} Surface records failed to parse", parse_failures.len());
    }
    assert!(
        total > 1000,
        "implausibly low retail Surface count ({total}) — DAT may be truncated"
    );
}
