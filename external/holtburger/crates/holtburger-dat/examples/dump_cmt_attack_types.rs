//! dump_cmt_attack_types — PARITY-C (2026-08-13).
//!
//! Prints every distinct `attack_type` key present in retail
//! CombatManeuverTable `0x30000000`, with the row count for each.
//!
//! Purpose: settle whether the CMT is keyed on SINGLE-bit `AttackType`
//! values, which decides whether a multi-bit wire `W_AttackType`
//! (e.g. `Thrust|Slash = 0x06`) can ever hit a row.
//!
//! Usage: `cargo run -p holtburger-dat --example dump_cmt_attack_types`
use binrw::BinRead;
use binrw::io::Cursor;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::CombatManeuverTable;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;

fn resolve_dat_path() -> Option<PathBuf> {
    if let Some(path) = holtburger_dat::utils::get_portal_dat_path() {
        return Some(path);
    }
    if let Ok(home) = std::env::var("HOME") {
        let p = PathBuf::from(home).join("ac_base_dats/client_portal.dat");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn main() -> ExitCode {
    let Some(dat_path) = resolve_dat_path() else {
        eprintln!("client_portal.dat not found");
        return ExitCode::from(2);
    };
    let dat = match DatDatabase::new(&dat_path) {
        Ok(d) => d,
        Err(e) => { eprintln!("open failed: {e}"); return ExitCode::from(2); }
    };
    let bytes = match dat.get_file(0x3000_0000) {
        Ok(b) => b,
        Err(e) => { eprintln!("CMT missing: {e}"); return ExitCode::from(2); }
    };
    let mut cursor = Cursor::new(&bytes);
    let cmt = match CombatManeuverTable::read_le(&mut cursor) {
        Ok(c) => c,
        Err(e) => { eprintln!("parse failed: {e}"); return ExitCode::from(2); }
    };
    let mut counts: BTreeMap<u32, usize> = BTreeMap::new();
    for m in &cmt.combat_maneuvers {
        *counts.entry(m.attack_type).or_default() += 1;
    }
    println!("# CMT 0x30000000 — {} maneuvers", cmt.combat_maneuvers.len());
    println!("attack_type  rows  multi_bit?");
    for (t, n) in &counts {
        println!("0x{:04X}       {:<5} {}", t, n, if t.count_ones() > 1 { "MULTI-BIT" } else { "single" });
    }
    // Rows reachable for a Thrust|Slash (0x06) sword in SwordCombat.
    let sword = 0x8000_003Eu32;
    for probe in [0x06u32, 0x02, 0x04, 0xA0, 0x20, 0x80] {
        let n = cmt.combat_maneuvers.iter()
            .filter(|m| m.style == sword && m.attack_type == probe).count();
        println!("SwordCombat rows for attack_type 0x{:02X}: {}", probe, n);
    }
    ExitCode::SUCCESS
}
