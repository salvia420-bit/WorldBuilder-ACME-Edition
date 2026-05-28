//! surface_type_census — distribution of Surface (0x08) flags + T/L/D floats
//! across every Surface record in a portal DAT. Grounds the "which render-state
//! gaps actually matter?" prioritization for the materials.js fidelity pass.
//!
//! Usage: `cargo run -p holtburger-dat --example surface_type_census -- <portal_dat>`

use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::Surface;
use std::env;
use std::process::ExitCode;

const BITS: &[(&str, u32)] = &[
    ("Base1Solid", 0x1),
    ("Base1Image", 0x2),
    ("Base1ClipMap", 0x4),
    ("Translucent", 0x10),
    ("Diffuse", 0x20),
    ("Luminous", 0x40),
    ("Alpha", 0x100),
    ("InvAlpha", 0x200),
    ("Additive", 0x10000),
    ("Detail", 0x20000),
    ("Gouraud", 0x10000000),
    ("Stippled", 0x40000000),
    ("Perspective", 0x80000000),
];

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() != 1 {
        eprintln!("usage: surface_type_census <portal_dat>");
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
    let mut total = 0u64;
    let mut parse_err = 0u64;
    let mut bit_counts = vec![0u64; BITS.len()];
    let (mut solid, mut textured) = (0u64, 0u64);
    // float incidence
    let (mut t_pos, mut l_pos, mut d_pos) = (0u64, 0u64, 0u64);
    let mut d_neq1 = 0u64; // diffuse > 0 and not ~1.0
    // coverage-gap counters (what our current materials.js would MISS or mis-handle)
    let mut lum_pos_no_bit = 0u64; // luminosity>0 but Luminous(0x40) unset  -> we'd miss glow
    let mut lum_bit_zero = 0u64; // Luminous bit set but luminosity==0      -> our 0.6 fallback fires
    let mut diff_pos_no_bit = 0u64; // diffuse>0 but Diffuse(0x20) unset     -> we'd miss reflectance
    let mut alpha_or_inv = 0u64; // Alpha|InvAlpha set                      -> blend mode we don't handle

    for id in ids {
        let bytes = match dat.get_file(id) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let s = match Surface::unpack(&bytes) {
            Ok(s) => s,
            Err(_) => {
                parse_err += 1;
                continue;
            }
        };
        total += 1;
        let t = s.surface_type;
        for (i, (_, bit)) in BITS.iter().enumerate() {
            if t & bit != 0 {
                bit_counts[i] += 1;
            }
        }
        if (t & 0x6) != 0 {
            textured += 1;
        } else {
            solid += 1;
        }
        if s.translucency > 0.0 {
            t_pos += 1;
        }
        if s.luminosity > 0.0 {
            l_pos += 1;
            if (t & 0x40) == 0 {
                lum_pos_no_bit += 1;
            }
        }
        if (t & 0x40) != 0 && s.luminosity == 0.0 {
            lum_bit_zero += 1;
        }
        if s.diffuse > 0.0 {
            d_pos += 1;
            if (s.diffuse - 1.0).abs() > 0.01 {
                d_neq1 += 1;
            }
            if (t & 0x20) == 0 {
                diff_pos_no_bit += 1;
            }
        }
        if (t & 0x300) != 0 {
            alpha_or_inv += 1;
        }
    }

    println!("Surface (0x08) records: {total}  (parse_err {parse_err})");
    println!("  solid(color) {solid}   textured {textured}");
    println!("\n--- surface_type bit incidence ---");
    for (i, (name, bit)) in BITS.iter().enumerate() {
        println!("  0x{:08X} {:<13} {}", bit, name, bit_counts[i]);
    }
    println!("\n--- T/L/D float incidence ---");
    println!("  translucency>0 : {t_pos}");
    println!("  luminosity>0   : {l_pos}");
    println!("  diffuse>0      : {d_pos}   (of which !=1.0: {d_neq1})");
    println!("\n--- gaps vs current materials.js (counts that would be MIS-handled) ---");
    println!("  luminosity>0 but Luminous bit UNSET (we miss glow): {lum_pos_no_bit}");
    println!("  Luminous bit set but luminosity==0 (our 0.6 fallback): {lum_bit_zero}");
    println!("  diffuse>0 but Diffuse bit UNSET (we miss reflectance): {diff_pos_no_bit}");
    println!("  Alpha|InvAlpha set (blend mode we don't implement): {alpha_or_inv}");
    ExitCode::SUCCESS
}
