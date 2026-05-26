//! Wave 5 / Phase 10 audit (wiki-vs-data divergence finding 2026-05-26).
//!
//! The acpedia Combat omnibus page claims "shields only protect the
//! front" and visually omits Backhand under the "One-Handed (Shield)"
//! column of the per-stance maneuver table. We expected the retail
//! CMT 0x30000000 to have zero `Backhand*` rows under stance
//! `SwordShieldCombat` (0x80000040).
//!
//! **Retail data disagrees with the wiki.** CMT 0x30000000 contains
//! exactly **3** Backhand rows under SwordShieldCombat — one per
//! AttackHeight (Low/Medium/High), all keyed `attack_type=0x0004`
//! (Slash):
//!
//! | stance              | height  | type      | motion       |
//! |---------------------|---------|-----------|--------------|
//! | SwordShieldCombat   | Low     | Slash     | BackhandHigh |
//! | SwordShieldCombat   | Medium  | Slash     | BackhandMed  |
//! | SwordShieldCombat   | High    | Slash     | BackhandLow  |
//!
//! (Note the inverted height→motion mapping — Low height swings the
//! "BackhandHigh" motion, etc. That's a separate retail quirk worth
//! recording, but not in scope for this test.)
//!
//! Either the wiki is wrong (the maneuver table image was hand-built
//! and missed three rows) OR retail leaves the data in but blocks the
//! motion at runtime via a different gate (`acclient.c` swing-path
//! check, or ACE's `Player_Melee.GetSwingAnimation` filtering them
//! out). This test does NOT resolve that question — it locks in the
//! current retail-data shape so future CMT changes are caught.
//!
//! Source-of-truth: `client_portal.dat`. Skipped when
//! `HOLTBURGER_PORTAL_DAT` is unset (mirrors
//! `combat_maneuver_table_parity.rs`).
//!
//! References:
//!   - acpedia Combat omnibus page (the claim under audit; now confirmed wrong)
//!   - `ace-server/Source/ACE.Entity/Enum/MotionStance.cs`
//!     SwordShieldCombat = 0x80000040
//!   - `Chorizite/Chorizite.Common/Enums/MotionCommand.cs`
//!     BackhandHigh = 0x1000005E, BackhandMed = 0x1000005F,
//!     BackhandLow  = 0x10000060
//!   - retail behavioral check (open question): `~/ac-headers/acclient.c` swing path

use binrw::BinRead;
use binrw::io::Cursor;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::CombatManeuverTable;

mod common;
use common::get_portal_dat_path;
use common::motion_command_names::motion_command_name;

const STANCE_SWORD_SHIELD_COMBAT: u32 = 0x8000_0040;
const CMT_RETAIL_ID: u32 = 0x3000_0000;

/// Resolve the symbolic MotionCommand name, falling back to a hex string
/// for values outside the committed lookup table.
fn motion_label(value: u32) -> String {
    match motion_command_name(value) {
        Some(name) => format!("{} (0x{:08X})", name, value),
        None => format!("0x{:08X}", value),
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

#[test]
fn shield_stance_has_three_backhand_rows() {
    let Some(dat_path) = get_portal_dat_path() else {
        println!(
            "Skipping shield-stance Backhand audit: portal.dat not found \
             (set HOLTBURGER_PORTAL_DAT)"
        );
        return;
    };

    let dat = DatDatabase::new(&dat_path).expect("open portal.dat");

    let bytes = dat
        .get_file(CMT_RETAIL_ID)
        .unwrap_or_else(|e| panic!("read CombatManeuverTable 0x{CMT_RETAIL_ID:08X}: {e}"));

    let mut cursor = Cursor::new(&bytes);
    let cmt = CombatManeuverTable::read_le(&mut cursor).unwrap_or_else(|e| {
        panic!(
            "parse CombatManeuverTable 0x{CMT_RETAIL_ID:08X} ({} bytes): {e}",
            bytes.len()
        );
    });
    assert_eq!(
        cmt.id, CMT_RETAIL_ID,
        "CombatManeuverTable self-id mismatch: expected 0x{CMT_RETAIL_ID:08X}, got 0x{:08X}",
        cmt.id,
    );

    let shield_rows: Vec<&holtburger_dat::file_type::CombatManeuver> = cmt
        .combat_maneuvers
        .iter()
        .filter(|m| m.style == STANCE_SWORD_SHIELD_COMBAT)
        .collect();

    assert!(
        !shield_rows.is_empty(),
        "expected at least one row for SwordShieldCombat (0x{STANCE_SWORD_SHIELD_COMBAT:08X}); \
         CMT 0x{CMT_RETAIL_ID:08X} has {} total rows but zero shield rows — \
         either the stance constant is wrong or the CMT layout has changed",
        cmt.combat_maneuvers.len(),
    );

    let mut unique_motions: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
    for m in &shield_rows {
        unique_motions.insert(m.motion);
    }

    let backhand_rows: Vec<&holtburger_dat::file_type::CombatManeuver> = shield_rows
        .iter()
        .copied()
        .filter(|m| {
            motion_command_name(m.motion)
                .map(|n| n.to_ascii_lowercase().contains("backhand"))
                .unwrap_or(false)
        })
        .collect();

    println!(
        "Shield stance has {} maneuvers; {} unique motions; Backhand* motions found: {}",
        shield_rows.len(),
        unique_motions.len(),
        backhand_rows.len(),
    );

    println!();
    println!("Unique motions in SwordShieldCombat rows:");
    for motion in &unique_motions {
        println!("  - {}", motion_label(*motion));
    }

    println!();
    println!(
        "Wiki-vs-data finding: acpedia Combat page omits Backhand under \
         SwordShieldCombat, but retail CMT 0x{CMT_RETAIL_ID:08X} contains \
         {} Backhand* row(s):",
        backhand_rows.len(),
    );
    for m in &backhand_rows {
        println!(
            "  stance=0x{:08X} height={} type=0x{:04X} min_skill={} motion={}",
            m.style,
            attack_height_name(m.attack_height),
            m.attack_type,
            m.min_skill_level,
            motion_label(m.motion),
        );
    }

    // Lock in the retail-data shape. Future CMT changes (re-bake,
    // shard override, ACE patch) will fail this test loudly.
    assert_eq!(
        backhand_rows.len(),
        3,
        "expected exactly 3 Backhand* rows under SwordShieldCombat in retail \
         CMT 0x{CMT_RETAIL_ID:08X} (one per AttackHeight, all Slash); found {}",
        backhand_rows.len(),
    );

    let mut heights_seen: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
    for m in &backhand_rows {
        heights_seen.insert(m.attack_height);
    }
    assert_eq!(
        heights_seen,
        [1u32, 2, 3].iter().copied().collect(),
        "expected the 3 Backhand rows to cover AttackHeight Low/Medium/High (1/2/3); \
         got heights {:?}",
        heights_seen,
    );

    for m in &backhand_rows {
        assert_eq!(
            m.attack_type, 0x0004,
            "expected each Backhand row under SwordShieldCombat to be AttackType::Slash (0x04), \
             got 0x{:04X} for height {}",
            m.attack_type,
            attack_height_name(m.attack_height),
        );
    }
}
