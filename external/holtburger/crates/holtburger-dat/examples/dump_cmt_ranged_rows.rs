//! dump_cmt_ranged_rows — Wave 2 / Phase 6 audit script.
//!
//! Opens `client_portal.dat`, locates CombatManeuverTable record
//! `0x30000000`, and prints unique `(stance, attack_height, attack_type,
//! motion)` rows for the ranged stances (BowCombat / CrossbowCombat /
//! ThrownWeaponCombat / SlingCombat / AtlatlCombat).
//!
//! Used to discover which `AttackType` enum code the retail
//! `AimHighN` / `AimLowN` motions live under, so
//! `ui/ac_attack_type_for_weapon.js` can return the correct value for
//! `equipMask & MISSILE_WEAPON` instead of leaving it as `Undef`.
//!
//! Usage:
//!   `cargo run -p holtburger-dat --example dump_cmt_ranged_rows`
//!
//! Looks up the DAT path via `HOLTBURGER_PORTAL_DAT` (set by tests) or
//! falls back to `~/ac_base_dats/client_portal.dat`. Exit 2 if neither
//! exists; stderr explains.
//!
//! Cross-reference for the stance codes:
//!   `~/ace-server/Source/ACE.Entity/Enum/MotionStance.cs`
//!   - BowCombat          = 0x8000003F
//!   - CrossbowCombat     = 0x80000041
//!   - SlingCombat        = 0x80000043
//!   - ThrownWeaponCombat = 0x80000047
//!   - AtlatlCombat       = 0x8000013B
//!
//! Cross-reference for the AttackType codes (the column we want to
//! discover):
//!   `~/ace-server/Source/ACE.Entity/Enum/AttackType.cs`
//!   - Undef = 0x00, Punch = 0x01, Thrust = 0x02, Slash = 0x04, Kick = 0x08, ...

use binrw::BinRead;
use binrw::io::Cursor;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::CombatManeuverTable;
use std::path::PathBuf;
use std::process::ExitCode;

const STANCE_HAND_COMBAT: u32 = 0x8000_003C;
const STANCE_NONCOMBAT: u32 = 0x8000_003D;
const STANCE_SWORD_COMBAT: u32 = 0x8000_003E;
const STANCE_BOW_COMBAT: u32 = 0x8000_003F;
const STANCE_SWORD_SHIELD_COMBAT: u32 = 0x8000_0040;
const STANCE_CROSSBOW_COMBAT: u32 = 0x8000_0041;
const STANCE_UNUSED_COMBAT: u32 = 0x8000_0042;
const STANCE_SLING_COMBAT: u32 = 0x8000_0043;
const STANCE_TWO_HANDED_SWORD_COMBAT: u32 = 0x8000_0044;
const STANCE_TWO_HANDED_STAFF_COMBAT: u32 = 0x8000_0045;
const STANCE_DUAL_WIELD_COMBAT: u32 = 0x8000_0046;
const STANCE_THROWN_WEAPON_COMBAT: u32 = 0x8000_0047;
const STANCE_GRAZE: u32 = 0x8000_0048;
const STANCE_MAGIC: u32 = 0x8000_0049;
const STANCE_ATLATL_COMBAT: u32 = 0x8000_013B;
const STANCE_THROWN_SHIELD_COMBAT: u32 = 0x8000_013C;

fn stance_name(s: u32) -> &'static str {
    match s {
        STANCE_HAND_COMBAT => "HandCombat",
        STANCE_NONCOMBAT => "NonCombat",
        STANCE_SWORD_COMBAT => "SwordCombat",
        STANCE_BOW_COMBAT => "BowCombat",
        STANCE_SWORD_SHIELD_COMBAT => "SwordShieldCombat",
        STANCE_CROSSBOW_COMBAT => "CrossbowCombat",
        STANCE_UNUSED_COMBAT => "UnusedCombat",
        STANCE_SLING_COMBAT => "SlingCombat",
        STANCE_TWO_HANDED_SWORD_COMBAT => "TwoHandedSwordCombat",
        STANCE_TWO_HANDED_STAFF_COMBAT => "TwoHandedStaffCombat",
        STANCE_DUAL_WIELD_COMBAT => "DualWieldCombat",
        STANCE_THROWN_WEAPON_COMBAT => "ThrownWeaponCombat",
        STANCE_GRAZE => "Graze",
        STANCE_MAGIC => "Magic",
        STANCE_ATLATL_COMBAT => "AtlatlCombat",
        STANCE_THROWN_SHIELD_COMBAT => "ThrownShieldCombat",
        _ => "Unknown",
    }
}

fn attack_height_name(h: u32) -> &'static str {
    // ACE.Entity.Enum.AttackHeight: Low = 1, Medium = 2, High = 3
    match h {
        1 => "Low",
        2 => "Medium",
        3 => "High",
        _ => "Unknown",
    }
}

/// Subset of `AttackType` matched at audit time. Only the single-bit
/// values are listed because the CMT keys on single bits.
fn attack_type_name(t: u32) -> &'static str {
    match t {
        0x0000 => "Undef",
        0x0001 => "Punch",
        0x0002 => "Thrust",
        0x0004 => "Slash",
        0x0008 => "Kick",
        0x0010 => "OffhandPunch",
        0x0020 => "DoubleSlash",
        0x0040 => "TripleSlash",
        0x0080 => "DoubleThrust",
        0x0100 => "TripleThrust",
        0x0200 => "OffhandThrust",
        0x0400 => "OffhandSlash",
        0x0800 => "OffhandDoubleSlash",
        0x1000 => "OffhandTripleSlash",
        0x2000 => "OffhandDoubleThrust",
        0x4000 => "OffhandTripleThrust",
        _ => "Unknown",
    }
}

/// Lookup the human-readable name for a `MotionCommand` (DAT u32 code).
/// Returns the hex string if unknown — the AC enum is ~409 entries; we
/// just hard-code the AimHigh/AimLow/aux ones we care about for the
/// audit since the diag layer already has the full JSON table.
fn motion_name(m: u32) -> String {
    let label: Option<&str> = match m {
        // AimLevel + AimHighN / AimLowN — the rows we expect for ranged.
        0x4000_001e => Some("AimLevel"),
        0x4000_001f => Some("AimHigh15"),
        0x4000_0020 => Some("AimHigh30"),
        0x4000_0021 => Some("AimHigh45"),
        0x4000_0022 => Some("AimHigh60"),
        0x4000_0023 => Some("AimHigh75"),
        0x4000_0024 => Some("AimHigh90"),
        0x4000_0025 => Some("AimLow15"),
        0x4000_0026 => Some("AimLow30"),
        0x4000_0027 => Some("AimLow45"),
        0x4000_0028 => Some("AimLow60"),
        0x4000_0029 => Some("AimLow75"),
        0x4000_002a => Some("AimLow90"),
        // Reload + the misc shoot/throw — useful sanity rows.
        0x1000_0061 => Some("Shoot"),
        _ => None,
    };
    match label {
        Some(s) => format!("{} (0x{:08X})", s, m),
        None => format!("0x{:08X}", m),
    }
}

fn is_ranged_stance(s: u32) -> bool {
    matches!(
        s,
        STANCE_BOW_COMBAT
            | STANCE_CROSSBOW_COMBAT
            | STANCE_SLING_COMBAT
            | STANCE_THROWN_WEAPON_COMBAT
            | STANCE_ATLATL_COMBAT
            | STANCE_THROWN_SHIELD_COMBAT
    )
}

fn resolve_dat_path() -> Option<PathBuf> {
    if let Some(path) = holtburger_dat::utils::get_portal_dat_path() {
        return Some(path);
    }
    // Final fallback: home-relative `~/ac_base_dats/client_portal.dat`.
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
        eprintln!(
            "client_portal.dat not found: set HOLTBURGER_PORTAL_DAT or place a copy at \
             ~/ac_base_dats/client_portal.dat"
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

    // Retail has exactly one CombatManeuverTable record at 0x30000000.
    let bytes = match dat.get_file(0x3000_0000) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("CMT 0x30000000 not in DAT: {e}");
            return ExitCode::from(2);
        }
    };

    let mut cursor = Cursor::new(&bytes);
    let cmt = match CombatManeuverTable::read_le(&mut cursor) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("CMT parse failed: {e}");
            return ExitCode::from(2);
        }
    };
    assert_eq!(cmt.id, 0x3000_0000);

    println!("# CombatManeuverTable 0x30000000 — ranged-stance audit");
    println!(
        "# source: {} ({} bytes, {} maneuvers)",
        dat_path.display(),
        bytes.len(),
        cmt.combat_maneuvers.len(),
    );
    println!();
    println!("## All rows where stance is a ranged stance");
    println!();
    println!(
        "{:<22} {:<8} {:<10} {:<8}   motion",
        "stance", "height", "type", "type_hex"
    );
    println!("{}", "-".repeat(80));

    let mut ranged_rows: Vec<&holtburger_dat::file_type::CombatManeuver> = cmt
        .combat_maneuvers
        .iter()
        .filter(|m| is_ranged_stance(m.style))
        .collect();
    ranged_rows.sort_by_key(|m| (m.style, m.attack_height, m.attack_type, m.motion));

    for m in &ranged_rows {
        println!(
            "{:<22} {:<8} {:<10} 0x{:<6X}   {}",
            stance_name(m.style),
            attack_height_name(m.attack_height),
            attack_type_name(m.attack_type),
            m.attack_type,
            motion_name(m.motion),
        );
    }

    if ranged_rows.is_empty() {
        println!("(no rows with a ranged stance — verify the stance code constants)");
    }

    // Per-stance distinct AttackType summary. The Wave 2 / Phase 6
    // question is: "what AttackType key do the AimHighN/AimLowN motions
    // sit under?" Print the unique types per stance so we don't have to
    // squint at the full table.
    println!();
    println!("## Distinct AttackType per ranged stance");
    println!();
    let mut summary: std::collections::BTreeMap<u32, std::collections::BTreeSet<u32>> =
        std::collections::BTreeMap::new();
    for m in &ranged_rows {
        summary
            .entry(m.style)
            .or_default()
            .insert(m.attack_type);
    }
    for (stance, types) in &summary {
        let names: Vec<String> = types
            .iter()
            .map(|t| format!("{} (0x{:X})", attack_type_name(*t), t))
            .collect();
        println!(
            "  {:<22} -> [{}]",
            stance_name(*stance),
            names.join(", "),
        );
    }

    // Sanity: also print total ranged-row count vs total CMT rows.
    println!();
    println!(
        "## Counts: {} ranged rows / {} total rows",
        ranged_rows.len(),
        cmt.combat_maneuvers.len(),
    );

    // Diag: dump distinct stances + per-stance attack types across the
    // whole table so the audit reveals what's actually present (in case
    // the ranged stance set is encoded under different codes than
    // ACE's enum).
    println!();
    println!("## Diag — distinct stances in CMT 0x30000000");
    println!();
    let mut all_stances: std::collections::BTreeMap<u32, std::collections::BTreeSet<u32>> =
        std::collections::BTreeMap::new();
    for m in &cmt.combat_maneuvers {
        all_stances
            .entry(m.style)
            .or_default()
            .insert(m.attack_type);
    }
    for (stance, types) in &all_stances {
        let names: Vec<String> = types
            .iter()
            .map(|t| format!("{} (0x{:X})", attack_type_name(*t), t))
            .collect();
        println!(
            "  0x{:08X} {:<22} -> attackTypes: [{}]",
            stance,
            stance_name(*stance),
            names.join(", "),
        );
    }

    // Diag: dump every row so we can manually verify what motion
    // commands the ranged rows (if any) actually use.
    println!();
    println!("## Diag — all 102 rows (style, height, attack_type, motion)");
    println!();
    let mut all_rows = cmt.combat_maneuvers.clone();
    all_rows.sort_by_key(|m| (m.style, m.attack_height, m.attack_type, m.motion));
    for m in &all_rows {
        println!(
            "  0x{:08X} {:<22} h={} type=0x{:04X} {:<14} motion={}",
            m.style,
            stance_name(m.style),
            m.attack_height,
            m.attack_type,
            attack_type_name(m.attack_type),
            motion_name(m.motion),
        );
    }

    ExitCode::SUCCESS
}
