//! cast_over_locomotion — Wave 4 / Phase 4.3 (2026-05-26).
//!
//! Loads the canonical player MotionTable (DID `0x09000001`) from
//! `~/ac_base_dats/client_portal.dat` and asserts that the data shape
//! supports layered Magic-cast playback over locomotion cycles. The
//! retail combat path overlays cast modifiers (MagicPowerUp01..N +
//! MagicBlast / MagicSelf / etc.) ON TOP of a running locomotion cycle
//! — the legs keep walking while the arms incant. This is enabled by
//! TWO separate motion-table tables:
//!
//!   * `cycles[(Magic stance, WalkForward)]` — looping locomotion clip
//!     played LoopRepeat. Drives leg motion.
//!   * `links[(Magic, Ready)][MagicPowerUpNN]` / `links[(Magic, Ready)]
//!     [MagicBlast]` etc. — one-shot cast windup / gesture. Played as
//!     an overlay action via `_tryPlayLink`. Drives arm gestures.
//!
//! Note on table choice: the `modifiers` table holds VELOCITY-CARRYING
//! one-shots (like emote overrides) — only 8 entries total in player MT
//! 0x09000001. Cast gestures live in `links`, keyed by the transition
//! `(stance, Ready) → cast_cmd`. The JS path in `entities.js::setMotion`
//! routes `cls === "cast"` through `_tryPlayLink(ready, cast_cmd)`,
//! which reads exactly this table. Per the spec at
//! `docs/swing-classification-spec-2026-05-19.md` §1: swings + cast
//! gestures live in `MotionTable.links[(stance, Ready)][cmd]` — 5,455
//! retail link entries validated, 0 in cycles.
//!
//! Both must exist with non-empty `anims` for the layered playback in
//! `playCastSequence` (entities.js:2300) to work. This example is a
//! pure data-level assertion: it does NOT run any animation; it verifies
//! the source data supports what `playCastSequence` already does at
//! runtime per the Wave 14 / Phase 45 wiring.
//!
//! ## Citations
//!
//! - `external/ACE/Source/ACE.Entity/Enum/MotionCommand.cs:80` — Magic
//!   stance value (0x80000049).
//! - `external/ACE/Source/ACE.Entity/Enum/MotionCommand.cs:50-63` —
//!   cast gestures (MagicBlast, MagicSelf, MagicHeal, etc.).
//! - `external/ACE/Source/ACE.Entity/Enum/MotionCommand.cs:118-127` —
//!   MagicPowerUp01..10 (cast windups, scarab-keyed).
//! - `~/ac-headers/acclient.c:332778-332779` — retail's
//!   `cast_command = motion` modifier-stack assignment overlaying the
//!   active forward_command (locomotion cycle).
//! - `scene3d/entities.js::playCastSequence` (Wave 14 / Phase 45) — JS
//!   runtime that drives the layered playback.
//! - `apps/holtburger-web/test_ac_cast_over_locomotion.mjs` — node wrapper.
//!
//! ## Usage
//!
//!   HOLTBURGER_PORTAL_DAT=$HOME/ac_base_dats/client_portal.dat \
//!     cargo run --quiet -p holtburger-dat --example cast_over_locomotion

use binrw::io::Cursor;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::MotionTable;
use std::path::PathBuf;
use std::process::ExitCode;

const PLAYER_MTABLE_DID: u32 = 0x0900_0001;

// Stance + locomotion under Magic per `MotionCommand.cs`.
const STANCE_MAGIC: u32 = 0x8000_0049;
const CMD_WALK_FORWARD: u32 = 0x4500_0005;
// Ready substate (0x41000003 low-16=0x0003) — the FROM key for cast
// gesture transitions. `links[cycle_key(Magic, Ready)][cast_cmd]`
// holds the windup / cast clips. Matches the JS classifier path in
// `entities.js::setMotion` which calls `_tryPlayLink(inst, setupId,
// mtableId, READY_SUBSTATE, cmd, stance)` (line ~2710).
const CMD_READY: u32 = 0x4100_0003;

// Cast windups (the 0x10000xxx high byte = "modifier" class per ACE's
// classifier; the motion-table parser keys these in `modifiers`, not
// `cycles`). MagicPowerUp01-10 cover the 8 scarabs + 2 reserved
// (Iron/Lead variants) per retail spell formula component lookup.
const MAGIC_POWER_UP_01: u32 = 0x1000_006F;
const MAGIC_POWER_UP_02: u32 = 0x1000_0070;
const MAGIC_POWER_UP_03: u32 = 0x1000_0071;
const MAGIC_POWER_UP_04: u32 = 0x1000_0072;
const MAGIC_POWER_UP_05: u32 = 0x1000_0073;
const MAGIC_POWER_UP_06: u32 = 0x1000_0074;
const MAGIC_POWER_UP_07: u32 = 0x1000_0075;
const MAGIC_POWER_UP_08: u32 = 0x1000_0076;
const MAGIC_POWER_UP_09: u32 = 0x1000_0077;
const MAGIC_POWER_UP_10: u32 = 0x1000_0078;

// Cast gestures (the 0x40000xxx high byte = "non-cyclic action" class).
// MagicBlast = ranged spell projectile, MagicSelf = self-buff gesture.
// Empirically present in retail player MT for Magic stance.
const MAGIC_BLAST: u32 = 0x4000_002B;
const MAGIC_SELF_HEAD: u32 = 0x4000_002C;
const MAGIC_SELF_HEART: u32 = 0x4000_002D;
const MAGIC_HARM: u32 = 0x4000_0030;
const MAGIC_HEAL: u32 = 0x4000_0031;

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

fn powerup_name(c: u32) -> &'static str {
    match c {
        MAGIC_POWER_UP_01 => "MagicPowerUp01",
        MAGIC_POWER_UP_02 => "MagicPowerUp02",
        MAGIC_POWER_UP_03 => "MagicPowerUp03",
        MAGIC_POWER_UP_04 => "MagicPowerUp04",
        MAGIC_POWER_UP_05 => "MagicPowerUp05",
        MAGIC_POWER_UP_06 => "MagicPowerUp06",
        MAGIC_POWER_UP_07 => "MagicPowerUp07",
        MAGIC_POWER_UP_08 => "MagicPowerUp08",
        MAGIC_POWER_UP_09 => "MagicPowerUp09",
        MAGIC_POWER_UP_10 => "MagicPowerUp10",
        _ => "Unknown",
    }
}

fn gesture_name(c: u32) -> &'static str {
    match c {
        MAGIC_BLAST => "MagicBlast",
        MAGIC_SELF_HEAD => "MagicSelfHead",
        MAGIC_SELF_HEART => "MagicSelfHeart",
        MAGIC_HARM => "MagicHarm",
        MAGIC_HEAL => "MagicHeal",
        _ => "Unknown",
    }
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
            eprintln!("player MotionTable 0x{PLAYER_MTABLE_DID:08X} not in DAT: {e}");
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

    println!(
        "# MotionTable 0x{PLAYER_MTABLE_DID:08X} — Wave 4 / Phase 4.3 cast-over-locomotion data shape"
    );
    println!("# source: {} ({} bytes)", dat_path.display(), bytes.len());
    println!("# cycles total: {}", mtable.cycles.len());
    println!("# modifiers total: {}", mtable.modifiers.len());
    println!(
        "# links[(Magic, Ready)] inner_count: {}",
        mtable
            .links
            .get(&(((STANCE_MAGIC & 0xFFFF) << 16) | (CMD_READY & 0x000F_FFFF)))
            .map(|m| m.len())
            .unwrap_or(0)
    );
    println!();

    let mut layer1_pass: usize = 0;
    let mut layer1_fail: usize = 0;
    let mut layer2_pass: usize = 0;
    let mut layer2_fail: usize = 0;

    // ============================================================
    // Layer 1 — Magic locomotion cycle (legs).
    // ============================================================
    println!("## Layer 1 — Magic + WalkForward locomotion cycle (legs)");
    println!(
        "{:<24} {:<14} {:<12} anim_did anim_count",
        "stance", "cmd", "status"
    );
    println!("{}", "-".repeat(78));
    match mtable.motion_data_for_cycle(STANCE_MAGIC, CMD_WALK_FORWARD) {
        Some(md) if !md.anims.is_empty() => {
            println!(
                "{:<24} {:<14} {:<12} 0x{:08X} {}",
                "Magic",
                "WalkForward",
                "PASS",
                md.anims[0].anim_id,
                md.anims.len(),
            );
            layer1_pass += 1;
        }
        Some(_) => {
            println!(
                "{:<24} {:<14} {:<12} (cycle present but .anims is empty)",
                "Magic", "WalkForward", "FAIL"
            );
            layer1_fail += 1;
        }
        None => {
            println!(
                "{:<24} {:<14} {:<12} (no cycle entry)",
                "Magic", "WalkForward", "FAIL"
            );
            layer1_fail += 1;
        }
    }
    println!();

    // ============================================================
    // Layer 2 — cast windups + gestures live in `links[(Magic, Ready)]`
    // keyed by the cast MotionCommand. ≥1 powerup AND ≥1 cast gesture
    // must exist with non-empty anims for the layered playback to fire.
    //
    // Per `playCastSequence` (entities.js:2300), each spell's
    // sequence comprises ≥0 windup gestures + exactly 1 cast gesture.
    // FastCast spells skip windups but still need the cast gesture.
    // So our minimum-viable shape is: ≥1 powerup ENTRY (or non-empty
    // for FastCast-equivalent paths) + ≥1 cast gesture ENTRY.
    //
    // Lookup helper: `motion_data_for_link(stance, from_cmd, to_cmd)`
    // matches what `_tryPlayLink` does at runtime — `cycle_key(Magic,
    // Ready)` is the outer key, the cast cmd is the inner key.
    // ============================================================
    println!("## Layer 2a — MagicPowerUp windups (links / arms, keyed by [Magic, Ready] → cmd)");
    println!("{:<24} {:<14} anim_did anim_count", "name", "status");
    println!("{}", "-".repeat(78));
    let powerups = [
        MAGIC_POWER_UP_01,
        MAGIC_POWER_UP_02,
        MAGIC_POWER_UP_03,
        MAGIC_POWER_UP_04,
        MAGIC_POWER_UP_05,
        MAGIC_POWER_UP_06,
        MAGIC_POWER_UP_07,
        MAGIC_POWER_UP_08,
        MAGIC_POWER_UP_09,
        MAGIC_POWER_UP_10,
    ];
    let mut found_any_powerup = false;
    for &cmd in &powerups {
        match mtable.motion_data_for_link(STANCE_MAGIC, CMD_READY, cmd) {
            Some(md) if !md.anims.is_empty() => {
                println!(
                    "{:<24} {:<14} 0x{:08X} {}",
                    powerup_name(cmd),
                    "PRESENT",
                    md.anims[0].anim_id,
                    md.anims.len(),
                );
                found_any_powerup = true;
            }
            Some(_) => {
                println!(
                    "{:<24} {:<14} (link present but .anims is empty)",
                    powerup_name(cmd),
                    "EMPTY"
                );
            }
            None => {
                println!(
                    "{:<24} {:<14} (no link entry)",
                    powerup_name(cmd),
                    "ABSENT"
                );
            }
        }
    }
    if found_any_powerup {
        layer2_pass += 1;
    } else {
        layer2_fail += 1;
    }
    println!();

    println!("## Layer 2b — Cast gestures (links / arms, keyed by [Magic, Ready] → cmd)");
    println!("{:<24} {:<14} anim_did anim_count", "name", "status");
    println!("{}", "-".repeat(78));
    let gestures = [
        MAGIC_BLAST,
        MAGIC_SELF_HEAD,
        MAGIC_SELF_HEART,
        MAGIC_HARM,
        MAGIC_HEAL,
    ];
    let mut found_any_gesture = false;
    for &cmd in &gestures {
        match mtable.motion_data_for_link(STANCE_MAGIC, CMD_READY, cmd) {
            Some(md) if !md.anims.is_empty() => {
                println!(
                    "{:<24} {:<14} 0x{:08X} {}",
                    gesture_name(cmd),
                    "PRESENT",
                    md.anims[0].anim_id,
                    md.anims.len(),
                );
                found_any_gesture = true;
            }
            Some(_) => {
                println!(
                    "{:<24} {:<14} (link present but .anims is empty)",
                    gesture_name(cmd),
                    "EMPTY"
                );
            }
            None => {
                println!(
                    "{:<24} {:<14} (no link entry)",
                    gesture_name(cmd),
                    "ABSENT"
                );
            }
        }
    }
    if found_any_gesture {
        layer2_pass += 1;
    } else {
        layer2_fail += 1;
    }
    println!();

    // ============================================================
    // Layered playback distinctness — confirm Magic-stance walk anim
    // DID is NOT one of the powerup/gesture anim DIDs (so the layers
    // touch DIFFERENT clips).
    // ============================================================
    let walk_anim = mtable
        .motion_data_for_cycle(STANCE_MAGIC, CMD_WALK_FORWARD)
        .and_then(|md| md.anims.first())
        .map(|a| a.anim_id);
    let mut distinct_count = 0usize;
    let mut overlap_count = 0usize;
    if let Some(walk_did) = walk_anim {
        println!(
            "## Layer 1+2 distinctness — Magic walk anim DID vs cast modifier anims (no overlap allowed)"
        );
        println!(
            "{:<24} {:<14} anim_did {:<10} matches_walk",
            "name", "status", "delta"
        );
        println!("{}", "-".repeat(78));
        let to_check: Vec<u32> = powerups.iter().chain(gestures.iter()).copied().collect();
        for cmd in to_check {
            if let Some(md) = mtable.motion_data_for_link(STANCE_MAGIC, CMD_READY, cmd) {
                if let Some(a) = md.anims.first() {
                    let overlaps = a.anim_id == walk_did;
                    if overlaps {
                        overlap_count += 1;
                    } else {
                        distinct_count += 1;
                    }
                    let name = if cmd & 0xF000_0000 == 0x1000_0000 {
                        powerup_name(cmd)
                    } else {
                        gesture_name(cmd)
                    };
                    println!(
                        "{:<24} {:<14} 0x{:08X} {:<10} {}",
                        name,
                        if overlaps { "OVERLAP" } else { "DISTINCT" },
                        a.anim_id,
                        "",
                        overlaps,
                    );
                }
            }
        }
    }

    // Summary block — the .mjs wrapper greps for these structured lines.
    println!();
    println!("## Summary");
    println!("LOCOMOTION_PASS={layer1_pass}");
    println!("LOCOMOTION_FAIL={layer1_fail}");
    println!("CAST_LAYERS_PASS={layer2_pass}");
    println!("CAST_LAYERS_FAIL={layer2_fail}");
    println!("DISTINCT_LAYERS={distinct_count}");
    println!("OVERLAPPING_LAYERS={overlap_count}");
    println!("MAGIC_WALK_ANIM={}", walk_anim.map(|d| format!("0x{d:08X}")).unwrap_or_else(|| "none".into()));

    if layer1_fail > 0 || layer2_fail > 0 || overlap_count > 0 {
        println!();
        println!("OVERALL=FAIL");
        ExitCode::from(1)
    } else {
        println!();
        println!("OVERALL=PASS");
        ExitCode::SUCCESS
    }
}
