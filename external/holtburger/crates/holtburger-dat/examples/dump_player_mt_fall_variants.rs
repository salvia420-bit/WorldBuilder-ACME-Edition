//! Wave 5 (movement-animation overhaul, 2026-05-26) — investigation pass.
//!
//! Dumps which fall-related `MotionCommand`s are populated in the player
//! `MotionTable` `0x09000001`. The plan needs to know:
//!
//! - `Falling = 0x40000015` — looping in-air state, expected in `cycles`.
//! - `FallDown = 0x10000050` — one-shot lead-in, expected in `links`.
//! - `Fallen = 0x40000008` — one-shot post-fall recovery, expected in
//!   `links`.
//! - `Land = 0x4100002B` — one-shot landing impact, expected in `links`.
//!
//! Player stances per `external/ACE/Source/ACE.Entity/Enum/MotionStance.cs`.
//!
//! Usage:
//!   `HOLTBURGER_PORTAL_DAT=$HOME/ac_base_dats/client_portal.dat \
//!    cargo run -p holtburger-dat --example dump_player_mt_fall_variants`

use binrw::io::Cursor;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::MotionTable;
use std::path::PathBuf;
use std::process::ExitCode;

const PLAYER_MT_ID: u32 = 0x0900_0001;

const FALLING: u32 = 0x4000_0015;
const FALL_DOWN: u32 = 0x1000_0050;
const FALLEN: u32 = 0x4000_0008;
const LAND: u32 = 0x4100_002B;
const READY: u32 = 0x4100_0003;

fn fall_cmd_name(c: u32) -> &'static str {
    match c {
        FALLING => "Falling",
        FALL_DOWN => "FallDown",
        FALLEN => "Fallen",
        LAND => "Land",
        READY => "Ready",
        _ => "?",
    }
}

const PLAYER_STANCES: &[(u32, &str)] = &[
    (0x8000_003C, "HandCombat"),
    (0x8000_003D, "NonCombat"),
    (0x8000_003E, "SwordCombat"),
    (0x8000_003F, "BowCombat"),
    (0x8000_0040, "SwordShieldCombat"),
    (0x8000_0041, "CrossbowCombat"),
    (0x8000_0043, "SlingCombat"),
    (0x8000_0044, "TwoHandedSwordCombat"),
    (0x8000_0045, "TwoHandedStaffCombat"),
    (0x8000_0046, "DualWieldCombat"),
    (0x8000_0047, "ThrownWeaponCombat"),
    (0x8000_0049, "Magic"),
];

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

fn cycle_key(stance: u32, command: u32) -> u32 {
    ((stance & 0xFFFF) << 16) | (command & 0x000F_FFFF)
}

fn main() -> ExitCode {
    let Some(dat_path) = resolve_dat_path() else {
        eprintln!(
            "client_portal.dat not found: set HOLTBURGER_PORTAL_DAT or place \
             a copy at ~/ac_base_dats/client_portal.dat"
        );
        return ExitCode::from(2);
    };

    let dat = match DatDatabase::new(&dat_path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("failed to open {}: {e}", dat_path.display());
            return ExitCode::from(2);
        }
    };

    let bytes = match dat.get_file(PLAYER_MT_ID) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("MT 0x{PLAYER_MT_ID:08X} not in DAT: {e}");
            return ExitCode::from(2);
        }
    };

    let mut cursor = Cursor::new(&bytes);
    let mt = match MotionTable::read(&mut cursor) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("MotionTable parse failed: {e}");
            return ExitCode::from(2);
        }
    };
    assert_eq!(mt.id, PLAYER_MT_ID);

    println!("# Player MotionTable 0x{:08X} — fall-variant audit", PLAYER_MT_ID);
    println!(
        "# source: {} ({} bytes, default_style=0x{:08X})",
        dat_path.display(),
        bytes.len(),
        mt.default_style,
    );
    println!(
        "# cycles: {} entries, modifiers: {} entries, links: {} outer keys",
        mt.cycles.len(),
        mt.modifiers.len(),
        mt.links.len(),
    );
    println!();

    // Phase A: cycles[(stance, Falling/FallDown/Fallen/Land)]
    println!("## cycles[(stance, fall-cmd)] presence");
    println!("{:<22}  {:<10} {:<10} {:<10} {:<10}", "stance", "Falling", "FallDown", "Fallen", "Land");
    println!("{}", "-".repeat(70));
    for &(stance, name) in PLAYER_STANCES {
        let f = mt.cycles.get(&cycle_key(stance, FALLING)).is_some();
        let fd = mt.cycles.get(&cycle_key(stance, FALL_DOWN)).is_some();
        let fn_ = mt.cycles.get(&cycle_key(stance, FALLEN)).is_some();
        let l = mt.cycles.get(&cycle_key(stance, LAND)).is_some();
        println!(
            "{:<22}  {:<10} {:<10} {:<10} {:<10}",
            name,
            if f { "YES" } else { "no" },
            if fd { "YES" } else { "no" },
            if fn_ { "YES" } else { "no" },
            if l { "YES" } else { "no" },
        );
    }
    println!();

    // Phase B: links[(stance, Ready)] -> { to_cmd: MotionData }
    println!("## links[(stance, Ready)] → to-Fall variants (inner key matches full u32 cmd)");
    println!("{:<22}  {:<10} {:<10} {:<10} {:<10}", "stance", "Falling", "FallDown", "Fallen", "Land");
    println!("{}", "-".repeat(70));
    for &(stance, name) in PLAYER_STANCES {
        let outer = cycle_key(stance, READY);
        let inner = mt.links.get(&outer);
        let lookup = |cmd: u32| -> bool {
            inner
                .and_then(|m| m.get(&cmd))
                .map(|md| !md.anims.is_empty())
                .unwrap_or(false)
        };
        println!(
            "{:<22}  {:<10} {:<10} {:<10} {:<10}",
            name,
            if lookup(FALLING) { "YES" } else { "no" },
            if lookup(FALL_DOWN) { "YES" } else { "no" },
            if lookup(FALLEN) { "YES" } else { "no" },
            if lookup(LAND) { "YES" } else { "no" },
        );
    }
    println!();

    // Phase C: any fall-related entry anywhere (cycles, modifiers, link inner keys)
    const FALL_LOW_SET: [u32; 4] = [
        FALLING & 0xFFFF,
        FALL_DOWN & 0xFFFF,
        FALLEN & 0xFFFF,
        LAND & 0xFFFF,
    ];
    println!("## All MotionData entries keyed on a Fall* command (regardless of stance)");
    println!("Cycles:");
    let mut cycles: Vec<_> = mt.cycles.iter().collect();
    cycles.sort_by_key(|(k, _)| *k);
    for (k, v) in cycles.iter() {
        let cmd_low = *k & 0xFFFF;
        if FALL_LOW_SET.contains(&cmd_low) {
            let stance = (*k >> 16) & 0xFFFF;
            println!(
                "  cycles[stance_low=0x{:04X}, cmd_low=0x{:04X}] anims={} flags=0x{:02X}",
                stance,
                cmd_low,
                v.anims.len(),
                v.bitfield,
            );
        }
    }

    println!("Modifiers:");
    for (k, v) in mt.modifiers.iter() {
        let cmd_low = *k & 0xFFFF;
        if FALL_LOW_SET.contains(&cmd_low) {
            println!(
                "  modifiers[key=0x{:08X}] anims={} flags=0x{:02X}",
                k,
                v.anims.len(),
                v.bitfield,
            );
        }
    }

    println!("Links (inner keys matching full u32):");
    for (outer_k, inner) in mt.links.iter() {
        let stance_low = (outer_k >> 16) & 0xFFFF;
        for (inner_k, v) in inner.iter() {
            let inner_low = *inner_k & 0xFFFF;
            if FALL_LOW_SET.contains(&inner_low) {
                let outer_low = outer_k & 0xFFFF;
                let outer_name = fall_cmd_name(0x4100_0000 | outer_low);
                println!(
                    "  links[outer=0x{:08X} (stance_low=0x{:04X}, from_low=0x{:04X} {})][inner=0x{:08X} {}] anims={}",
                    outer_k,
                    stance_low,
                    outer_low,
                    if outer_low == 0x0003 { "Ready" } else { "?" },
                    inner_k,
                    fall_cmd_name(*inner_k),
                    v.anims.len(),
                );
                let _ = outer_name;
            }
        }
    }

    ExitCode::SUCCESS
}
