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
//! AttackHeight (High/Medium/Low per
//! `~/ace-server/Source/ACE.Entity/Enum/AttackHeight.cs:3-8`), all
//! keyed `attack_type=0x0004` (Slash):
//!
//! | stance              | height  | type      | motion       |
//! |---------------------|---------|-----------|--------------|
//! | SwordShieldCombat   | High    | Slash     | BackhandHigh |
//! | SwordShieldCombat   | Medium  | Slash     | BackhandMed  |
//! | SwordShieldCombat   | Low     | Slash     | BackhandLow  |
//!
//! (The original audit prose claimed an "inverted" height→motion
//! mapping; that was an artifact of an inverted `attack_height_name`
//! label table — see Wave 8 / Phase 24, 2026-05-26. The retail data
//! pairs height N with `Backhand{N}` as one would expect.)
//!
//! # Resolution (Wave 6 / Phase 18 — 2026-05-26)
//!
//! **The wiki is wrong; there is no runtime gate.** A read-only
//! investigation across the retail acclient.c decompile and the full
//! ACE server source found ZERO code paths that filter Backhand out
//! of the CMT result list for shield-equipped attackers. The swing
//! is whatever `CombatManeuverTable.GetMotion(stance, height, type, …)`
//! returns; both retail and ACE will gladly play `Backhand*` when
//! `stance == SwordShieldCombat` resolves to a row whose `type` matches
//! the active weapon's bitmask after the `GetAttackType` collapse.
//!
//! Sources read (line ranges in parentheses):
//!
//! - `~/ac-headers/acclient.c` (407409–410069): the only retail caller
//!   of `CombatManeuverTable::Get` (at 408537, inside
//!   `ClientCombatSystem::PlayerInReadyPosition`) treats the returned
//!   table as a boolean "do we have a combat-maneuver table at all?"
//!   gate; it never iterates the rows and never inspects shield equip.
//!   The other Backhand-related hits at lines 254022–254030, 407471,
//!   410027–410055 are **input-event keystroke IDs** (UI dispatch in
//!   `HandleMagicAction` / `HandleCombatAction` that happen to reuse
//!   the values `0x1000005E/5F/60` for AttackHeight key bindings) —
//!   they are NOT MotionCommand filters and have nothing to do with
//!   the swing path. `acclient.c:43549–43551` is just the string table
//!   for the names. No `IsBackhand && IsWieldingShield` predicate
//!   exists anywhere.
//!
//! - `ace-server/Source/ACE.Server/WorldObjects/Player_Melee.cs` (full
//!   read, 1–476): `GetSwingAnimation` at lines 440–475 looks up
//!   `CombatTable.GetMotion(stance, height, type, prevMotion)` and
//!   picks `motions[1]` for high-power / `motions[0]` for low-power
//!   when `motions.Count > 1`. **No shield branch.** The wrapping
//!   `DoSwingMotion` at 398–430 broadcasts whatever `GetSwingAnimation`
//!   returned.
//!
//! - `ace-server/Source/ACE.Server/WorldObjects/Monster_Melee.cs:164–230`
//!   (`GetCombatManeuver`): symmetric path for monsters. Also no
//!   shield-aware Backhand filter.
//!
//! - `ace-server/Source/ACE.Server/WorldObjects/Creature_Combat.cs`:
//!   all "shield" mentions are either (a) the **upstream stance picker**
//!   at lines 274–356 that sets `combatStance = SwordShieldCombat` when
//!   a shield is equipped, or (b) the **damage-mitigation math** in
//!   `GetShieldMod` at 641–718. None filter motions.
//!
//! - `ace-server/Source/ACE.Server/WorldObjects/WorldObject_Weapon.cs:1050–1162`
//!   (`GetAttackType`): collapses a weapon's `W_AttackType` bitmask to a
//!   single AttackType under each stance. For `SwordShieldCombat` it
//!   forces multi-strike weapons toward Thrust/DoubleThrust (lines
//!   1108–1130), which CAN steer the CMT key away from Slash on those
//!   weapons. But a single-bit-Slash sword (the vast majority) will
//!   still hit the `attack_type=0x04` row family, and that family
//!   contains both `Slash*` and `Backhand*` motions in retail CMT
//!   0x30000000. The 50/50 power-bar pick at `Player_Melee.cs:468` then
//!   decides which one plays.
//!
//! - `ace-server/Source/ACE.DatLoader/FileTypes/CombatManeuverTable.cs`
//!   (full read, 1–130): `GetMotion` is a pure dictionary lookup
//!   `(stance → height → type → List<MotionCommand>)`. Returns the
//!   whole list; no knowledge of shield, weapon, or attacker state.
//!
//! - Repo-wide `grep -rn Backhand ace-server/Source/`: 5 hits, all in
//!   either the `MotionCommand` enum file or comments. No filter.
//!
//! ## Implication for our renderer
//!
//! Nothing to mirror. Our `Player_Melee.GetSwingAnimation` port in
//! `apps/holtburger-web/src/lib.rs` (and the `ui/ac_combat_maneuver.js`
//! picker) does **not** need a shield-aware Backhand drop because
//! neither retail nor ACE has one. When the server resolves a Backhand
//! swing for a shielded attacker it broadcasts the resulting
//! MotionCommand verbatim via `UpdateMotion` (kind=5) and our pose
//! pipeline plays it as-is.
//!
//! The Wave 5 Phase 10 audit can be closed: this test (3 retail rows
//! found, Low/Med/High, all Slash) accurately captures the
//! source-of-truth, and the wiki's omission is a hand-built-table
//! oversight rather than a missing runtime check.
//!
//! See also: `external/holtburger/docs/shield-backhand-runtime-gate-2026-05-26.md`.
//!
//! Source-of-truth: `client_portal.dat`. Skipped when
//! `HOLTBURGER_PORTAL_DAT` is unset (mirrors
//! `combat_maneuver_table_parity.rs`).
//!
//! References:
//!   - acpedia Combat omnibus page (the claim under audit; confirmed wrong)
//!   - `ace-server/Source/ACE.Entity/Enum/MotionStance.cs`
//!     SwordShieldCombat = 0x80000040
//!   - `Chorizite/Chorizite.Common/Enums/MotionCommand.cs`
//!     BackhandHigh = 0x1000005E, BackhandMed = 0x1000005F,
//!     BackhandLow  = 0x10000060
//!   - `~/ac-headers/acclient.c:407409–410069` — full
//!     `ClientCombatSystem::PlayerInReadyPosition` /
//!     `HandleCombatAction` / `HandleMagicAction` block (the only
//!     CombatManeuverTable consumer in the client; no Backhand filter).

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
    // ACE.Entity.Enum.AttackHeight (`~/ace-server/Source/ACE.Entity/Enum/AttackHeight.cs:3-8`):
    //   High = 1, Medium = 2, Low = 3
    // Locked in by `tests/attack_height_parity.rs` to catch future drift.
    match h {
        1 => "High",
        2 => "Medium",
        3 => "Low",
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
