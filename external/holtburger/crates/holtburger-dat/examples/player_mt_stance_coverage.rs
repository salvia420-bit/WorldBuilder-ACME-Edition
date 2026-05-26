//! player_mt_stance_coverage — Wave 3 / Phase 3.2 (2026-05-26).
//!
//! Loads the canonical player MotionTable (DID `0x09000001`) from
//! `~/ac_base_dats/client_portal.dat` and asserts every combat stance
//! has cycle entries for the locomotion MotionCommands wired in
//! Wave 1 + Wave 2:
//!
//!   REQUIRED (cycle MUST exist):
//!     * WalkForward   (0x45000005)
//!     * RunForward    (0x44000007)
//!     * SideStepRight (0x6500000F)
//!     * TurnRight     (0x6500000D)
//!
//!   OPTIONAL (cycle MAY exist — retail collapses Left → Right with signed speed):
//!     * SideStepLeft  (0x65000010)
//!     * TurnLeft      (0x6500000E)
//!
//! ## Why SideStepLeft / TurnLeft are optional
//!
//! Per `~/ac-headers/acclient.c:332761-332775` (`InterpretedMotionState::
//! ApplyMotion`), retail collapses ALL turn-class motions into
//! `TurnRight (0x6500000D)` and ALL sidestep-class motions into
//! `SideStepRight (0x6500000F)`, storing direction as a SIGNED speed
//! in `turn_speed` / `sidestep_speed`:
//!
//! ```c
//! if ( motion == 1694498829 ) {     // TurnRight (0x6500000D)
//!   this->turn_command = 1694498829;
//!   this->turn_speed = params->speed;
//! } else if ( motion == 1694498831 ) {  // SideStepRight (0x6500000F)
//!   this->sidestep_command = 1694498831;
//!   this->sidestep_speed = params->speed;
//! }
//! ```
//!
//! (The Left-direction MotionCommands `0x6500000E` / `0x65000010` are
//! never written to the state — they're folded into Right at the
//! `ApplyMotion` entry point or arrive as negative-speed motions per
//! the wire convention.) So the MotionTable cycle for the Left-side
//! command does NOT need to exist; the playback path uses the Right-
//! side clip and flips the cycle's time direction.
//!
//! Per-stance comparison verifies the anim DID differs from NonCombat
//! for the WalkForward cycle — confirming each combat stance ships
//! its own clip. RunForward is shared across all 8 stances in retail
//! MT 0x09000001 (one universal run cycle, `0x03000002`) so we don't
//! assert distinctness on it.
//!
//! ## Citations
//!
//! MotionCommand values come from
//! `external/ACE/Source/ACE.Entity/Enum/MotionCommand.cs:11-23` (the
//! canonical ACE enum).
//!
//! MotionStance values from `MotionCommand.cs:67-80`:
//!   NonCombat            = 0x8000003D
//!   HandCombat           = 0x8000003C
//!   SwordCombat          = 0x8000003E
//!   BowCombat            = 0x8000003F
//!   SwordShieldCombat    = 0x80000040
//!   DualWieldCombat      = 0x80000046
//!   ThrownWeaponCombat   = 0x80000047
//!   Magic                = 0x80000049
//!
//! ## Usage
//!
//!   HOLTBURGER_PORTAL_DAT=$HOME/ac_base_dats/client_portal.dat \
//!     cargo run -p holtburger-dat --example player_mt_stance_coverage
//!
//! Prints a per-stance × per-motion grid + summary; exits non-zero on
//! any missing cycle entry.
//!
//! The Phase 3.2 regression `.mjs` wrapper at
//! `apps/holtburger-web/test_ac_locomotion_per_stance.mjs` invokes this
//! example via `child_process.execSync` and parses the structured PASS
//! / FAIL lines below.

use binrw::io::Cursor;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::MotionTable;
use std::path::PathBuf;
use std::process::ExitCode;

const PLAYER_MTABLE_DID: u32 = 0x0900_0001;

// MotionStance values, per `MotionCommand.cs:67-80`.
const STANCE_NONCOMBAT: u32          = 0x8000_003D;
const STANCE_HAND_COMBAT: u32        = 0x8000_003C;
const STANCE_SWORD_COMBAT: u32       = 0x8000_003E;
const STANCE_BOW_COMBAT: u32         = 0x8000_003F;
const STANCE_SWORD_SHIELD_COMBAT: u32 = 0x8000_0040;
const STANCE_DUAL_WIELD_COMBAT: u32  = 0x8000_0046;
const STANCE_THROWN_WEAPON_COMBAT: u32 = 0x8000_0047;
const STANCE_MAGIC: u32              = 0x8000_0049;

// MotionCommand values, per `MotionCommand.cs:12-23`.
const CMD_WALK_FORWARD: u32   = 0x4500_0005;
const CMD_RUN_FORWARD: u32    = 0x4400_0007;
const CMD_SIDESTEP_LEFT: u32  = 0x6500_0010;
const CMD_SIDESTEP_RIGHT: u32 = 0x6500_000F;
const CMD_TURN_LEFT: u32      = 0x6500_000E;
const CMD_TURN_RIGHT: u32     = 0x6500_000D;

fn stance_name(s: u32) -> &'static str {
    match s {
        STANCE_NONCOMBAT => "NonCombat",
        STANCE_HAND_COMBAT => "HandCombat",
        STANCE_SWORD_COMBAT => "SwordCombat",
        STANCE_BOW_COMBAT => "BowCombat",
        STANCE_SWORD_SHIELD_COMBAT => "SwordShieldCombat",
        STANCE_DUAL_WIELD_COMBAT => "DualWieldCombat",
        STANCE_THROWN_WEAPON_COMBAT => "ThrownWeaponCombat",
        STANCE_MAGIC => "Magic",
        _ => "Unknown",
    }
}

fn cmd_name(c: u32) -> &'static str {
    match c {
        CMD_WALK_FORWARD => "WalkForward",
        CMD_RUN_FORWARD => "RunForward",
        CMD_SIDESTEP_LEFT => "SideStepLeft",
        CMD_SIDESTEP_RIGHT => "SideStepRight",
        CMD_TURN_LEFT => "TurnLeft",
        CMD_TURN_RIGHT => "TurnRight",
        _ => "Unknown",
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

    let bytes = match dat.get_file(PLAYER_MTABLE_DID) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("player MotionTable 0x{:08X} not in DAT: {e}", PLAYER_MTABLE_DID);
            return ExitCode::from(2);
        }
    };

    let mut cursor = Cursor::new(&bytes);
    let mtable = match MotionTable::read(&mut cursor) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("MotionTable parse failed: {e}");
            return ExitCode::from(2);
        }
    };
    assert_eq!(mtable.id, PLAYER_MTABLE_DID);

    println!("# MotionTable 0x{:08X} — Wave 3 / Phase 3.2 per-stance locomotion coverage", PLAYER_MTABLE_DID);
    println!("# source: {} ({} bytes)", dat_path.display(), bytes.len());
    println!("# default_style = 0x{:08X} ({})", mtable.default_style, stance_name(mtable.default_style));
    println!("# total cycles in table: {}", mtable.cycles.len());
    println!();

    let stances = [
        STANCE_NONCOMBAT,
        STANCE_HAND_COMBAT,
        STANCE_SWORD_COMBAT,
        STANCE_BOW_COMBAT,
        STANCE_SWORD_SHIELD_COMBAT,
        STANCE_DUAL_WIELD_COMBAT,
        STANCE_THROWN_WEAPON_COMBAT,
        STANCE_MAGIC,
    ];

    // REQUIRED cmds must be present in every stance.
    // OPTIONAL cmds (SideStepLeft / TurnLeft) are retail-folded into
    // their Right counterpart at ApplyMotion (acclient.c:332761-332769)
    // — their MotionTable cycles MAY be absent without indicating a bug.
    let required_cmds = [
        CMD_WALK_FORWARD,
        CMD_RUN_FORWARD,
        CMD_SIDESTEP_RIGHT,
        CMD_TURN_RIGHT,
    ];
    let optional_cmds = [
        CMD_SIDESTEP_LEFT,
        CMD_TURN_LEFT,
    ];

    // Per-cell pass/fail. A REQUIRED cell is PASS iff:
    //   (1) `MotionTable.cycles[(stance, cmd)]` exists, AND
    //   (2) `MotionData.anims` is non-empty.
    // OPTIONAL cells report PRESENT / ABSENT (informational only — no fail).
    let mut total_pass: usize = 0;
    let mut total_fail: usize = 0;
    let mut optional_present: usize = 0;
    let mut optional_absent: usize = 0;
    let mut distinct_pass: usize = 0;
    let mut distinct_fail: usize = 0;

    println!("## Per-cell cycle assertion — REQUIRED cmds");
    println!(
        "{:<24} {:<14} {:<12} anim_did",
        "stance", "cmd", "status"
    );
    println!("{}", "-".repeat(70));

    // First pass — REQUIRED per-cell exists+non-empty assertion.
    let mut anim_grid: std::collections::HashMap<(u32, u32), u32> = Default::default();
    for &stance in &stances {
        for &cmd in &required_cmds {
            let key_cmd = cmd_name(cmd);
            let key_stance = stance_name(stance);
            match mtable.motion_data_for_cycle(stance, cmd) {
                Some(md) if !md.anims.is_empty() => {
                    let anim_did = md.anims[0].anim_id;
                    anim_grid.insert((stance, cmd), anim_did);
                    println!(
                        "{:<24} {:<14} {:<12} 0x{:08X}",
                        key_stance, key_cmd, "PASS", anim_did,
                    );
                    total_pass += 1;
                }
                Some(_) => {
                    println!(
                        "{:<24} {:<14} {:<12} (cycle present but .anims is empty)",
                        key_stance, key_cmd, "FAIL",
                    );
                    total_fail += 1;
                }
                None => {
                    println!(
                        "{:<24} {:<14} {:<12} (no cycle entry for this stance/cmd pair)",
                        key_stance, key_cmd, "FAIL",
                    );
                    total_fail += 1;
                }
            }
        }
    }

    // OPTIONAL per-cell — informational. Records presence/absence without
    // contributing to total_fail.
    println!();
    println!("## Per-cell cycle assertion — OPTIONAL cmds (Left-direction)");
    println!(
        "{:<24} {:<14} {:<12} anim_did",
        "stance", "cmd", "status"
    );
    println!("{}", "-".repeat(70));
    for &stance in &stances {
        for &cmd in &optional_cmds {
            let key_cmd = cmd_name(cmd);
            let key_stance = stance_name(stance);
            match mtable.motion_data_for_cycle(stance, cmd) {
                Some(md) if !md.anims.is_empty() => {
                    let anim_did = md.anims[0].anim_id;
                    anim_grid.insert((stance, cmd), anim_did);
                    println!(
                        "{:<24} {:<14} {:<12} 0x{:08X}",
                        key_stance, key_cmd, "PRESENT", anim_did,
                    );
                    optional_present += 1;
                }
                _ => {
                    println!(
                        "{:<24} {:<14} {:<12} (folded into Right at ApplyMotion w/ signed speed)",
                        key_stance, key_cmd, "ABSENT",
                    );
                    optional_absent += 1;
                }
            }
        }
    }

    // Second pass — distinctness vs NonCombat per stance.
    //
    // Each combat stance should reference a DIFFERENT anim DID for
    // WalkForward than NonCombat does (e.g. the SwordCombat walk has
    // the sword drawn; NonCombat walk does not). RunForward is
    // intentionally NOT tested for distinctness: retail MT 0x09000001
    // ships a single shared run cycle (anim DID 0x03000002) across all
    // 8 stances — the run pose holds the weapon naturally as part of
    // the run motion. This is retail-canonical content, not a bug.
    println!();
    println!("## Distinctness check — combat stance WalkForward != NonCombat WalkForward");
    println!(
        "{:<24} {:<14} {:<12} {:<12} {}",
        "stance", "cmd", "vs_noncombat", "this_did", "noncombat_did"
    );
    println!("{}", "-".repeat(86));

    let distinctness_cmds = [CMD_WALK_FORWARD];
    for &stance in &stances {
        if stance == STANCE_NONCOMBAT {
            continue;
        }
        for &cmd in &distinctness_cmds {
            let key_stance = stance_name(stance);
            let key_cmd = cmd_name(cmd);
            let this = anim_grid.get(&(stance, cmd)).copied();
            let nc = anim_grid.get(&(STANCE_NONCOMBAT, cmd)).copied();
            match (this, nc) {
                (Some(t), Some(n)) if t != n => {
                    println!(
                        "{:<24} {:<14} {:<12} 0x{:08X}    0x{:08X}",
                        key_stance, key_cmd, "DISTINCT", t, n,
                    );
                    distinct_pass += 1;
                }
                (Some(t), Some(n)) => {
                    println!(
                        "{:<24} {:<14} {:<12} 0x{:08X}    0x{:08X}",
                        key_stance, key_cmd, "SAME", t, n,
                    );
                    distinct_fail += 1;
                }
                _ => {
                    println!(
                        "{:<24} {:<14} {:<12} (one or both missing — see per-cell pass above)",
                        key_stance, key_cmd, "N/A",
                    );
                    distinct_fail += 1;
                }
            }
        }
    }

    // RunForward shared-clip diag — informational, not a fail-channel.
    // Confirms the retail one-clip-shared-across-stances behavior.
    println!();
    println!("## Diag — RunForward anim DID per stance (retail shares a single clip across all stances)");
    println!(
        "{:<24} run_anim_did",
        "stance"
    );
    println!("{}", "-".repeat(45));
    for &stance in &stances {
        if let Some(did) = anim_grid.get(&(stance, CMD_RUN_FORWARD)) {
            println!("{:<24} 0x{:08X}", stance_name(stance), did);
        }
    }

    // Summary block — the .mjs wrapper greps for these structured lines.
    println!();
    println!("## Summary");
    println!("CELL_PASS={}", total_pass);
    println!("CELL_FAIL={}", total_fail);
    println!("OPTIONAL_PRESENT={}", optional_present);
    println!("OPTIONAL_ABSENT={}", optional_absent);
    println!("DISTINCT_PASS={}", distinct_pass);
    println!("DISTINCT_FAIL={}", distinct_fail);
    let required_cells = stances.len() * required_cmds.len();
    let optional_cells = stances.len() * optional_cmds.len();
    println!("REQUIRED_CELLS={}", required_cells);
    println!("OPTIONAL_CELLS={}", optional_cells);

    if total_fail > 0 || distinct_fail > 0 {
        println!();
        println!("OVERALL=FAIL");
        ExitCode::from(1)
    } else {
        println!();
        println!("OVERALL=PASS");
        ExitCode::SUCCESS
    }
}
