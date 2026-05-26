//! dump_two_handed_spear_motions — Wave 8 / Phase 22 audit script.
//!
//! Confirms the "visual jab" quirk on two-handed spears (Halberd / Pike /
//! Naginata / Yari / Partizan / Glaive / Lance / etc): the wiki's "jab"
//! terminology is a *visual* description of a forward-thrust motion clip,
//! NOT a distinct AttackType or MotionCommand enum value. The clip
//! resolves via the bog-standard CMT lookup at
//! `(stance = TwoHandedSwordCombat, height, AttackType = Thrust)`.
//!
//! Why `TwoHandedSwordCombat` and not `TwoHandedStaffCombat`? See ACE's
//! `Creature_Combat.GetWeaponStance` at
//! `~/ace-server/Source/ACE.Server/WorldObjects/Creature_Combat.cs:330-334`:
//!
//! ```csharp
//! case CombatStyle.TwoHanded:
//!     // MotionStance.TwoHandedStaffCombat doesn't appear to do anything
//!     // Additionally, PropertyInt.WeaponType isn't always included, and
//!     // the 2handed weapons that do appear to use WeaponType.TwoHanded
//!     combatStance = MotionStance.TwoHandedSwordCombat;
//!     break;
//! ```
//!
//! ACE collapses ALL `CombatStyle.TwoHanded` weapons (Pike, Halberd,
//! Naginata, Tetsubo, Nodachi, two-handed sword) into one stance —
//! `TwoHandedSwordCombat (0x80000044)`. The thrust-vs-slash distinction
//! is then carried entirely by the weapon's `W_AttackType` (PropertyInt
//! 47), which already flows over the wire after Wave 6 Phase 15
//! (`apply_inventory_object_create` in `apps/holtburger-web/src/lib.rs`).
//!
//! For completeness this audit prints rows under BOTH
//! `TwoHandedSwordCombat (0x80000044)` and `TwoHandedStaffCombat
//! (0x80000045)` filtered to `attack_type & Thrust(0x02) != 0`. The
//! expected outcome (matches ACE's "Staff stance doesn't do anything"
//! comment): zero rows under `0x80000045`, real thrust rows under
//! `0x80000044`.
//!
//! Representative LSD weenies sampled (all `WeaponSkill = 41
//! TwoHandedCombat`, all `DefaultCombatStyle = 8 TwoHanded`):
//!   wcid 41046 Pike                       WeaponType=11 W_AttackType=0x02 Thrust
//!   wcid 41041 Magari Yari                WeaponType=11 W_AttackType=0x02 Thrust
//!   wcid 41635 Ravenous Two Handed Spear  WeaponType=11 W_AttackType=0x02 Thrust
//!   wcid 41708 Phantom Two Handed Spear   WeaponType=11 W_AttackType=0x02 Thrust
//!   wcid 42664 Spear of Lost Truths       WeaponType=11 W_AttackType=0x02 Thrust
//!   wcid 29974 Partizan (HeavyWeapons)    WeaponType= 5 W_AttackType=0x02 Thrust
//!   wcid 29970 Partizan (LightWeapons)    WeaponType= 5 W_AttackType=0x02 Thrust
//!
//! (Some Halberd/Glaive variants carry `Thrust|Slash = 0x06`; some
//! Tetsubo/Nodachi carry pure `Slash = 0x04`. All still route through
//! `TwoHandedSwordCombat` and have their thrust component resolved here.)
//!
//! Usage:
//!   `HOLTBURGER_PORTAL_DAT=$HOME/ac_base_dats/client_portal.dat \
//!    cargo run -p holtburger-dat --example dump_two_handed_spear_motions`
//!
//! Cross-reference for the stance / attack-height / attack-type codes:
//!   `~/ace-server/Source/ACE.Entity/Enum/MotionStance.cs:18-19`
//!     TwoHandedSwordCombat = 0x80000044, TwoHandedStaffCombat = 0x80000045
//!   `~/ace-server/Source/ACE.Entity/Enum/AttackHeight.cs:3-8`
//!     High = 1, Medium = 2, Low = 3   (NOTE: the existing
//!     `dump_cmt_ranged_rows.rs` example has these inverted; Phase 24
//!     fixes that. This new example uses the correct ACE labels.)
//!   `~/ace-server/Source/ACE.Entity/Enum/AttackType.cs`
//!     Thrust = 0x02 (and DoubleThrust = 0x80, TripleThrust = 0x100,
//!     plus Offhand* variants which are dual-wield-only).

use binrw::BinRead;
use binrw::io::Cursor;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::CombatManeuverTable;
use std::path::PathBuf;
use std::process::ExitCode;

const STANCE_TWO_HANDED_SWORD_COMBAT: u32 = 0x8000_0044;
const STANCE_TWO_HANDED_STAFF_COMBAT: u32 = 0x8000_0045;

const ATTACK_TYPE_THRUST: u32 = 0x0002;
const ATTACK_TYPE_DOUBLE_THRUST: u32 = 0x0080;
const ATTACK_TYPE_TRIPLE_THRUST: u32 = 0x0100;
const THRUST_MASK: u32 =
    ATTACK_TYPE_THRUST | ATTACK_TYPE_DOUBLE_THRUST | ATTACK_TYPE_TRIPLE_THRUST;

fn stance_name(s: u32) -> &'static str {
    match s {
        STANCE_TWO_HANDED_SWORD_COMBAT => "TwoHandedSwordCombat",
        STANCE_TWO_HANDED_STAFF_COMBAT => "TwoHandedStaffCombat",
        _ => "Other",
    }
}

/// ACE.Entity.Enum.AttackHeight: High = 1, Medium = 2, Low = 3.
/// CITATION: `~/ace-server/Source/ACE.Entity/Enum/AttackHeight.cs:3-8`.
/// Do NOT propagate the (1=Low, 2=Medium, 3=High) mislabel from
/// `dump_cmt_ranged_rows.rs` here — Phase 24 fixes that.
fn attack_height_name(h: u32) -> &'static str {
    match h {
        1 => "High",
        2 => "Medium",
        3 => "Low",
        _ => "Unknown",
    }
}

/// `AttackType` single-bit names — subset matching what the CMT actually
/// keys on. Multi-bit weapon `W_AttackType` values (e.g. `Thrust|Slash =
/// 0x06`) get decomposed by `getCombatManeuver`'s `IsThrustSlash` branch
/// before they reach the CMT-row lookup, so the CMT itself stores
/// single-bit keys.
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

/// Human-readable name for the MotionCommand u32 codes we expect to
/// surface in this audit. Inline subset of `tests/common/
/// motion_command_names.rs` (the full 409-entry table lives there but
/// examples can't import from `tests/`). Anything we don't hard-code
/// prints as hex — that's fine for an audit script.
fn motion_name(m: u32) -> String {
    let label: Option<&str> = match m {
        // Base thrust family (single-thrust at each height).
        0x1000_0058 => Some("ThrustMed"),
        0x1000_0059 => Some("ThrustLow"),
        0x1000_005a => Some("ThrustHigh"),
        // Multi-thrust variants (DoubleThrust / TripleThrust per height).
        0x1000_0125 => Some("DoubleThrustLow"),
        0x1000_0126 => Some("DoubleThrustMed"),
        0x1000_0127 => Some("DoubleThrustHigh"),
        0x1000_0128 => Some("TripleThrustLow"),
        0x1000_0129 => Some("TripleThrustMed"),
        0x1000_012a => Some("TripleThrustHigh"),
        // Offhand thrust variants (DualWieldCombat — shouldn't appear
        // under TwoHanded stances but we name them anyway in case the
        // dump surfaces something unexpected).
        0x1000_0176 => Some("OffhandThrustHigh"),
        0x1000_0177 => Some("OffhandThrustMed"),
        0x1000_0178 => Some("OffhandThrustLow"),
        0x1000_017f => Some("OffhandDoubleThrustLow"),
        0x1000_0180 => Some("OffhandDoubleThrustMed"),
        0x1000_0181 => Some("OffhandDoubleThrustHigh"),
        0x1000_0182 => Some("OffhandTripleThrustLow"),
        0x1000_0183 => Some("OffhandTripleThrustMed"),
        0x1000_0184 => Some("OffhandTripleThrustHigh"),
        _ => None,
    };
    match label {
        Some(s) => format!("{} (0x{:08X})", s, m),
        None => format!("0x{:08X}", m),
    }
}

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

    println!("# CombatManeuverTable 0x30000000 — two-handed-spear visual-jab audit");
    println!(
        "# source: {} ({} bytes, {} maneuvers)",
        dat_path.display(),
        bytes.len(),
        cmt.combat_maneuvers.len(),
    );
    println!();
    println!(
        "## Filter: stance in {{TwoHandedSwordCombat (0x80000044), \
         TwoHandedStaffCombat (0x80000045)}} AND (attack_type & Thrust-family != 0)"
    );
    println!(
        "## Thrust-family mask = Thrust (0x02) | DoubleThrust (0x80) | TripleThrust (0x100)"
    );
    println!();
    println!(
        "{:<22} {:<8} {:<14} {:<10}   motion",
        "stance", "height", "type", "type_hex"
    );
    println!("{}", "-".repeat(80));

    let mut rows: Vec<&holtburger_dat::file_type::CombatManeuver> = cmt
        .combat_maneuvers
        .iter()
        .filter(|m| {
            (m.style == STANCE_TWO_HANDED_SWORD_COMBAT
                || m.style == STANCE_TWO_HANDED_STAFF_COMBAT)
                && (m.attack_type & THRUST_MASK) != 0
        })
        .collect();
    rows.sort_by_key(|m| (m.style, m.attack_height, m.attack_type, m.motion));

    for m in &rows {
        println!(
            "{:<22} {:<8} {:<14} 0x{:<8X}   {}",
            stance_name(m.style),
            attack_height_name(m.attack_height),
            attack_type_name(m.attack_type),
            m.attack_type,
            motion_name(m.motion),
        );
    }

    if rows.is_empty() {
        println!(
            "(no matching rows — verify the stance and attack-type filter constants)"
        );
    }

    // Diag — per-stance row counts so the "Staff stance doesn't do
    // anything" claim is reproducible.
    println!();
    println!("## Per-stance counts (matching the filter)");
    let mut by_stance: std::collections::BTreeMap<u32, usize> = Default::default();
    for m in &rows {
        *by_stance.entry(m.style).or_default() += 1;
    }
    for stance in &[
        STANCE_TWO_HANDED_SWORD_COMBAT,
        STANCE_TWO_HANDED_STAFF_COMBAT,
    ] {
        println!(
            "  0x{:08X} {:<22} -> {} rows",
            stance,
            stance_name(*stance),
            by_stance.get(stance).copied().unwrap_or(0)
        );
    }

    // Diag — every TwoHanded* row regardless of attack-type filter, so
    // the audit shows the full TwoHandedSword stance contents (Slash,
    // Thrust, DoubleSlash, etc) in context.
    println!();
    println!("## Diag — ALL rows under TwoHandedSwordCombat / TwoHandedStaffCombat");
    let mut all_twoh: Vec<&holtburger_dat::file_type::CombatManeuver> = cmt
        .combat_maneuvers
        .iter()
        .filter(|m| {
            m.style == STANCE_TWO_HANDED_SWORD_COMBAT
                || m.style == STANCE_TWO_HANDED_STAFF_COMBAT
        })
        .collect();
    all_twoh.sort_by_key(|m| (m.style, m.attack_height, m.attack_type, m.motion));
    for m in &all_twoh {
        println!(
            "  0x{:08X} {:<22} h={} ({:<6}) type=0x{:04X} {:<16} motion={}",
            m.style,
            stance_name(m.style),
            m.attack_height,
            attack_height_name(m.attack_height),
            m.attack_type,
            attack_type_name(m.attack_type),
            motion_name(m.motion),
        );
    }

    ExitCode::SUCCESS
}
