//! dump_cycle_velocity — T11 grounding probe.
//!
//! Reads a MotionTable (default 0x09000001, the player table) and prints, for
//! every stance that has a WalkForward / RunForward cycle, the cycle's
//! |velocity| (the T11 baseSpeed). Confirms whether retail authors the
//! locomotion ground speed on the MotionData (HAS_VELOCITY) or leaves it 0
//! (server-driven).

use binrw::io::Cursor;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::MotionTable;
use std::path::PathBuf;
use std::process::ExitCode;

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

fn mag(v: &holtburger_common::math::Vector3) -> f32 {
    (v.x * v.x + v.y * v.y + v.z * v.z).sqrt()
}

fn main() -> ExitCode {
    let mt_id: u32 = std::env::args()
        .nth(1)
        .and_then(|s| u32::from_str_radix(s.trim_start_matches("0x"), 16).ok())
        .unwrap_or(0x0900_0001);

    let dat = match resolve_dat_path().and_then(|p| DatDatabase::new(&p).ok()) {
        Some(d) => d,
        None => {
            eprintln!("portal.dat not found / unreadable");
            return ExitCode::from(2);
        }
    };
    let bytes = match dat.get_file(mt_id) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("MT 0x{mt_id:08X} not in DAT: {e}");
            return ExitCode::from(2);
        }
    };
    let mt = match MotionTable::read(&mut Cursor::new(&bytes)) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("MT parse: {e}");
            return ExitCode::from(2);
        }
    };

    println!("MotionTable 0x{mt_id:08X}  default_style=0x{:08X}", mt.default_style);
    println!("cycles with velocity (|v| > 0):");
    let mut n_with_vel = 0;
    let mut walk_run_lines = Vec::new();
    for (key, md) in &mt.cycles {
        let stance = (key >> 16) & 0xFFFF;
        let cmd_low = key & 0xFFFF;
        if let Some(v) = md.velocity {
            n_with_vel += 1;
            // WalkForward low = 0x0005, RunForward low = 0x0007.
            if cmd_low == 0x0005 || cmd_low == 0x0007 {
                let name = if cmd_low == 0x0005 { "Walk" } else { "Run " };
                walk_run_lines.push(format!(
                    "  stance=0x{stance:04X} {name} |v|={:.3}  v=({:.2},{:.2},{:.2})",
                    mag(&v), v.x, v.y, v.z
                ));
            }
        }
    }
    let mod_vel = mt.modifiers.values().filter(|m| m.velocity.is_some()).count();
    let link_vel: usize = mt
        .links
        .values()
        .flat_map(|inner| inner.values())
        .filter(|m| m.velocity.is_some())
        .count();
    let link_total: usize = mt.links.values().map(|inner| inner.len()).sum();
    println!(
        "  cycles: {} total / {} with vel | modifiers: {} total / {} with vel | links: {} total / {} with vel",
        mt.cycles.len(), n_with_vel, mt.modifiers.len(), mod_vel, link_total, link_vel
    );
    walk_run_lines.sort();
    for l in &walk_run_lines {
        println!("{l}");
    }
    if walk_run_lines.is_empty() {
        println!("  (no Walk/Run cycle carries velocity)");
    }
    ExitCode::SUCCESS
}
