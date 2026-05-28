//! dat_type_histogram — count DAT records by file-type prefix (high byte).
//!
//! Reads only the directory B-tree (no record bodies), so it's fast even on
//! the 927 MB retail `client_portal.dat`. For portal.dat the high byte of each
//! ID is the AC type-prefix, so this histogram is a per-type record census.
//! (For client_cell_*.dat the high byte is a landblock coord, not a type — so
//! only run this against portal.dat for a meaningful type census.)
//!
//! Built to settle the "is the material-override chain (0x16/0x17/0x18)
//! actually present in shipped retail data?" Pattern-B question.
//!
//! Usage: `cargo run -p holtburger-dat --example dat_type_histogram -- <dat_path>`

use holtburger_dat::DatDatabase;
use std::collections::BTreeMap;
use std::env;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() != 1 {
        eprintln!("usage: dat_type_histogram <dat_path>");
        return ExitCode::from(2);
    }
    let dat = match DatDatabase::new(&args[0]) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("open dat: {e}");
            return ExitCode::from(1);
        }
    };

    let mut hist: BTreeMap<u8, u64> = BTreeMap::new();
    for id in dat.files.keys() {
        *hist.entry((id >> 24) as u8).or_insert(0) += 1;
    }

    let total: u64 = hist.values().sum();
    println!("total records: {total}");
    println!("{:<8} {:>10}", "prefix", "count");
    for (prefix, count) in &hist {
        println!("0x{prefix:02X}     {count:>10}");
    }

    // Spotlight the material-override chain + the baseline material refs.
    println!("\n--- spotlight ---");
    let spot = |p: u8, name: &str| {
        println!("0x{:02X} {:<16} {}", p, name, hist.get(&p).copied().unwrap_or(0));
    };
    spot(0x16, "RenderMaterial");
    spot(0x17, "MaterialModifier");
    spot(0x18, "MaterialInstance");
    spot(0x19, "RenderMesh");
    spot(0x05, "SurfaceTexture");
    spot(0x06, "RenderSurface");
    spot(0x08, "Surface");
    ExitCode::SUCCESS
}
