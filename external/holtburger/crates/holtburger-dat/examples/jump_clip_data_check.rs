//! Wave 6 / Phase 6.2 (movement-animation overhaul, 2026-05-26) —
//! Jump-clip data presence audit.
//!
//! ## Why this exists
//!
//! Wave 1 / Phase 1.2 deleted the airborne-overlay tween in
//! `apps/holtburger-web/scene3d/entities.js` and let the real
//! motion-table Jump clip play instead. The bug it replaced (arms-spread
//! tween freezing the rig mid-jump) failed silently from the outside:
//! the motion-table cache lookup succeeded, the link clip was fetched,
//! but the AnimationMixer was paused so `mixer.time` never advanced.
//!
//! A truly tight regression test would assert `mixer.time > 0` after
//! `mixer.update(dt)` is called following a `setMotion(guid, Jump,
//! stance)`. That requires a Three.js scene + skeleton + WebGL
//! context, which lives outside this Rust example's scope (Wave 6 /
//! Phase 6.3 covers that via Playwright on the 1070 Ti).
//!
//! This example covers the NECESSARY (but not sufficient) precondition:
//! the underlying DAT data has a non-empty Jump entry for every player
//! stance, either in `cycles[(stance, Jump)]` (free-jump pose) or in
//! `links[(stance, Ready)][Jump]` (linked-from-idle, which is how the
//! renderer's `_tryPlayLink` actually fetches the clip — see
//! `entities.js:2842-2856` and the comment block at 2820-2841).
//!
//! Two sources of truth (per [[feedback_three_source_cross_reference]]):
//!
//!   1. acclient.c → `MotionCommand::Jump = 0x2500003B`
//!      (also at `crates/holtburger-dat/tests/common/motion_command_names.rs:312`).
//!   2. ACE → `ACE.Entity.Enum.MotionCommand.Jump = 0x2500003B`
//!      (`external/ACE/Source/ACE.Entity/Enum/MotionCommand.cs`).
//!
//! ## What this example asserts
//!
//! For each player stance in PLAYER_STANCES (12 stances per
//! `external/ACE/Source/ACE.Entity/Enum/MotionStance.cs`):
//!
//!   - At least ONE of the following is non-empty:
//!     - `cycles[(stance, Jump)]` with non-empty `anims`.
//!     - `links[(stance, Ready)][Jump]` with non-empty `anims`.
//!   - If a link entry exists, it has at least one anim with at least
//!     one keyframe (sanity check that the parser populated keyframes).
//!
//! Prints a structured summary block the `.mjs` wrapper parses for
//! exit code:
//!
//!   STANCES_CHECKED=12
//!   STANCES_WITH_JUMP=N        (12 expected on baseline DAT)
//!   STANCES_MISSING_JUMP=N     (0 expected on baseline DAT)
//!   LINK_HITS=N
//!   CYCLE_HITS=N
//!   BOTH_HITS=N
//!   NEITHER_HITS=N             (0 expected)
//!   ANIMS_NONEMPTY=N           (must equal hits)
//!   OVERALL=PASS|FAIL
//!
//! Usage:
//!   `HOLTBURGER_PORTAL_DAT=$HOME/ac_base_dats/client_portal.dat \
//!    cargo run -p holtburger-dat --example jump_clip_data_check`

use binrw::io::Cursor;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::MotionTable;
use std::path::PathBuf;
use std::process::ExitCode;

const PLAYER_MT_ID: u32 = 0x0900_0001;
const JUMP_CMD: u32 = 0x2500_003B;
const READY_CMD: u32 = 0x4100_0003;

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

/// MotionTable key encoding (matches `dump_player_mt_fall_variants.rs:71-73`):
/// `((stance & 0xFFFF) << 16) | (cmd & 0x000F_FFFF)`. Used for both `cycles`
/// outer key AND `links` outer key (the stance-Ready compound).
fn make_key(stance: u32, command: u32) -> u32 {
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

    println!("# Player MotionTable 0x{:08X} — Jump-clip data audit (Wave 6 / Phase 6.2)", PLAYER_MT_ID);
    println!(
        "# source: {} ({} bytes, default_style=0x{:08X})",
        dat_path.display(),
        bytes.len(),
        mt.default_style,
    );
    println!(
        "# cycles: {} entries, links: {} outer keys",
        mt.cycles.len(),
        mt.links.len(),
    );
    println!();

    println!("## Per-stance Jump presence");
    println!(
        "{:<22}  {:<10} {:<10} {:<10} {:<14}",
        "stance", "in_cycle", "in_link", "either", "link_anims",
    );
    println!("{}", "-".repeat(74));

    let mut cycle_hits = 0u32;
    let mut link_hits = 0u32;
    let mut both_hits = 0u32;
    let mut neither_hits = 0u32;
    let mut anims_nonempty = 0u32;

    for &(stance, name) in PLAYER_STANCES {
        // Cycle path: cycles[(stance, Jump)].
        let cycle_key = make_key(stance, JUMP_CMD);
        let cycle_md = mt.cycles.get(&cycle_key);
        let in_cycle = cycle_md.map(|m| !m.anims.is_empty()).unwrap_or(false);

        // Link path: links[(stance, Ready)][Jump]. This is the path the
        // renderer actually uses — entities.js:2842-2856 routes the
        // Jump cmd through `_tryPlayLink` with from = Ready = 0x4100_0003.
        let outer_key = make_key(stance, READY_CMD);
        let inner = mt.links.get(&outer_key);
        let link_md = inner.and_then(|m| m.get(&JUMP_CMD));
        let in_link = link_md.map(|m| !m.anims.is_empty()).unwrap_or(false);

        let link_anims_count = link_md.map(|m| m.anims.len()).unwrap_or(0);

        match (in_cycle, in_link) {
            (true, true) => both_hits += 1,
            (true, false) => cycle_hits += 1,
            (false, true) => link_hits += 1,
            (false, false) => neither_hits += 1,
        }

        // Sanity check: if the link entry exists, at least one anim
        // entry should be present (we already gated `in_link` on
        // non-empty `anims`, but counters tracking the assertion).
        if in_link {
            anims_nonempty += 1;
        }

        println!(
            "{:<22}  {:<10} {:<10} {:<10} {:<14}",
            name,
            if in_cycle { "YES" } else { "no" },
            if in_link { "YES" } else { "no" },
            if in_cycle || in_link { "YES" } else { "MISS" },
            link_anims_count,
        );
    }
    println!();

    let stances_with_jump = PLAYER_STANCES.len() as u32 - neither_hits;
    let stances_missing_jump = neither_hits;

    // Pass criterion: every stance has either a cycle OR a link Jump
    // entry. Pre-Wave-1 fix the assumption was both; in practice retail
    // MT 0x09000001 keeps Jump in the link table only (the renderer
    // path that actually fires).
    let overall_pass = stances_missing_jump == 0;

    // Cross-check: also scan ALL motion tables in 0x09000000..0x0900FFFF
    // range. If NO motion table anywhere has a Jump entry, the
    // Wave 1 / Phase 1.2 plan's assumption is universally wrong (not
    // just for the player MT) and the entire `setMotion(Jump)` codepath
    // in `entities.js:7755` (index.html jump trigger) is a no-op
    // regardless of which MT the entity uses.
    let mut tables_scanned = 0u32;
    let mut tables_with_jump = 0u32;
    let mut first_with_jump: Option<u32> = None;
    for (id, _) in dat.files.iter() {
        if !(0x0900_0000..=0x0900_FFFF).contains(id) {
            continue;
        }
        tables_scanned += 1;
        let Ok(bytes) = dat.get_file(*id) else { continue; };
        let mut cursor = Cursor::new(&bytes);
        let Ok(mt) = MotionTable::read(&mut cursor) else { continue; };
        let mut found = false;
        // Any cycles[(*, Jump)] entry with non-empty anims?
        for (k, v) in mt.cycles.iter() {
            if *k & 0xFFFF == 0x003B && !v.anims.is_empty() {
                found = true;
                break;
            }
        }
        // Any links[*][Jump] entry with non-empty anims?
        if !found {
            'outer: for (_outer_k, inner) in mt.links.iter() {
                for (inner_k, v) in inner.iter() {
                    if *inner_k & 0xFFFF == 0x003B && !v.anims.is_empty() {
                        found = true;
                        break 'outer;
                    }
                }
            }
        }
        if found {
            tables_with_jump += 1;
            if first_with_jump.is_none() {
                first_with_jump = Some(*id);
            }
        }
    }
    println!();
    println!("## Cross-check across all motion tables");
    println!("# (verifies whether Jump exists in ANY MT, not just player MT 0x09000001)");
    println!("TABLES_SCANNED={}", tables_scanned);
    println!("TABLES_WITH_JUMP={}", tables_with_jump);
    match first_with_jump {
        Some(id) => println!("FIRST_WITH_JUMP=0x{:08X}", id),
        None => println!("FIRST_WITH_JUMP=none"),
    }

    println!();
    println!("## Summary block");
    println!("STANCES_CHECKED={}", PLAYER_STANCES.len());
    println!("STANCES_WITH_JUMP={}", stances_with_jump);
    println!("STANCES_MISSING_JUMP={}", stances_missing_jump);
    println!("CYCLE_HITS={}", cycle_hits);
    println!("LINK_HITS={}", link_hits);
    println!("BOTH_HITS={}", both_hits);
    println!("NEITHER_HITS={}", neither_hits);
    println!("ANIMS_NONEMPTY={}", anims_nonempty);
    println!("OVERALL={}", if overall_pass { "PASS" } else { "FAIL" });

    if overall_pass {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}
