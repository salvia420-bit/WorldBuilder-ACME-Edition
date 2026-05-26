//! Wave 8 / Phase 8.4 (2026-05-26) — full-MotionCommand classifier
//! data-presence audit against retail MT `0x09000001` (player) plus a
//! handful of NPC MTs sampled by sweep.
//!
//! The Wave 8 classifier extension wires the FULL ACE `MotionCommand`
//! enum into `scene3d/entities.js::classifyMotionCommand` — emotes,
//! reactions, stationary held poses, interactions, idle ambients,
//! extended attacks, and held cycles. This example loads the canonical
//! player motion table and probes each new classifier entry to confirm:
//!
//!   1. Emotes / reactions / interactions / idle ambients / extended
//!      attacks should appear in `links[(stance, Ready)][cmd]` (the
//!      one-shot link table — same place swings + casts live per
//!      swing-classification spec §1).
//!
//!   2. Stationary held poses / held cycles should appear in
//!      `cycles[(stance, cmd)]` (the loop table — same place
//!      WalkForward / RunForward live).
//!
//! Sample NPC MTs are picked by scanning every motion table in the
//! `0x09000000..=0x0900FFFF` range and selecting the first 3 with
//! ≥100 cycles (proxy for "rich animation set" — i.e. humanoid NPCs).
//!
//! ## Citations
//!
//! - `external/ACE/Source/ACE.Entity/Enum/MotionCommand.cs` — canonical
//!   enum (all line numbers in the inventory doc).
//! - `external/holtburger/docs/swing-classification-spec-2026-05-19.md`
//!   §1, §8 — `links[(stance, Ready)][cmd]` is the contract.
//! - `external/holtburger/docs/wave-8-motion-command-inventory-2026-05-26.md`
//!   — the category breakdown this audit covers.
//!
//! ## Usage
//!
//!   HOLTBURGER_PORTAL_DAT=$HOME/ac_base_dats/client_portal.dat \
//!     cargo run --quiet -p holtburger-dat --example wave_8_motion_inventory

use binrw::io::Cursor;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::MotionTable;
use std::path::PathBuf;
use std::process::ExitCode;

const PLAYER_MT_ID: u32 = 0x0900_0001;

// Player + creature stances per `MotionStance.cs`. NonCombat is the
// universal idle stance — emotes/swings/etc. all key off it.
const STANCE_NONCOMBAT: u32 = 0x8000_003D;
const STANCE_HAND_COMBAT: u32 = 0x8000_003C;
const STANCE_MAGIC: u32 = 0x8000_0049;

// Ready substate (low-16=0x0003). Wave 1.7 → "links outer key = stance
// + Ready" is the contract for emote/swing/cast one-shots.
const READY_LOW: u32 = 0x0003;

/// Full ACE `MotionCommand` symbol table for this audit. Wave 8 new
/// entries (categories 2-8 from inventory) — used for both the
/// MT-presence sweep and the human-readable report.
const CATEGORY_2_EMOTES: &[(u32, &str)] = &[
    (0x1300_004C, "Cheer"),
    (0x1000_004D, "ChestBeat"),
    (0x1000_004E, "TippedLeft"),
    (0x1000_004F, "TippedRight"),
    (0x1000_0057, "Sanctuary"),
    (0x1000_006B, "HeadThrow"),
    (0x1000_006C, "FistSlam"),
    (0x1000_006D, "BreatheFlame"),
    (0x1000_006E, "SpinAttack"),
    (0x1300_0079, "ShakeFist"),
    (0x1300_007A, "Beckon"),
    (0x1300_007B, "BeSeeingYou"),
    (0x1300_007C, "BlowKiss"),
    (0x1300_007D, "BowDeep"),
    (0x1300_007E, "ClapHands"),
    (0x1300_007F, "Cry"),
    (0x1300_0080, "Laugh"),
    (0x1300_0081, "MimeEat"),
    (0x1300_0082, "MimeDrink"),
    (0x1300_0083, "Nod"),
    (0x1300_0084, "Point"),
    (0x1300_0085, "ShakeHead"),
    (0x1300_0086, "Shrug"),
    (0x1300_0087, "Wave"),
    (0x1300_0088, "Akimbo"),
    (0x1300_0089, "HeartyLaugh"),
    (0x1300_008A, "Salute"),
    (0x1300_008B, "ScratchHead"),
    (0x1300_008C, "SmackHead"),
    (0x1300_008D, "TapFoot"),
    (0x1300_008E, "WaveHigh"),
    (0x1300_008F, "WaveLow"),
    (0x1300_0090, "YawnStretch"),
    (0x1300_0091, "Cringe"),
    (0x1300_0092, "Kneel"),
    (0x1300_0093, "Plead"),
    (0x1300_0094, "Shiver"),
    (0x1300_0095, "Shoo"),
    (0x1300_0096, "Slouch"),
    (0x1300_0097, "Spit"),
    (0x1300_0098, "Surrender"),
    (0x1300_0099, "Woah"),
    (0x1300_009A, "Winded"),
    (0x1200_009B, "YMCA"),
    (0x1300_00CA, "Pray"),
    (0x1300_00CB, "Mock"),
    (0x1300_00CC, "Teapot"),
    (0x1200_00D4, "Flatulence"),
    (0x1200_00DF, "Demonet"),
    (0x1300_0119, "WarmHands"),
    (0x4200_00F9, "ATOYOT"),
    (0x1300_0135, "Helper"),
    (0x1300_014A, "NudgeLeft"),
    (0x1300_014B, "NudgeRight"),
    (0x1300_014C, "PointLeft"),
    (0x1300_014D, "PointRight"),
    (0x1300_014E, "PointDown"),
    (0x1300_014F, "Knock"),
    (0x1300_0150, "ScanHorizon"),
    (0x1300_0151, "DrudgeDance"),
    (0x1300_0152, "HaveASeat"),
];

const CATEGORY_3_REACTIONS: &[(u32, &str)] = &[
    (0x1000_0051, "Twitch1"),
    (0x1000_0052, "Twitch2"),
    (0x1000_0053, "Twitch3"),
    (0x1000_0054, "Twitch4"),
    (0x1000_0055, "StaggerBackward"),
    (0x1000_0056, "StaggerForward"),
    (0x4000_00E4, "TwitchSubstate1"),
    (0x4000_00E5, "TwitchSubstate2"),
    (0x4000_00E6, "TwitchSubstate3"),
];

const CATEGORY_5_STATIONARY: &[(u32, &str)] = &[
    (0x4000_0011, "Dead"),
    (0x4100_0012, "Crouch"),
    (0x4100_0013, "Sitting"),
    (0x4100_0014, "Sleeping"),
    (0x4300_00EA, "ShakeFistState"),
    (0x4300_00EB, "PrayState"),
    (0x4300_00EC, "BowDeepState"),
    (0x4300_00ED, "ClapHandsState"),
    (0x4300_00EE, "CrossArmsState"),
    (0x4300_00EF, "ShiverState"),
    (0x4300_00F0, "PointState"),
    (0x4300_00F1, "WaveState"),
    (0x4300_00F2, "AkimboState"),
    (0x4300_00F3, "SaluteState"),
    (0x4300_00F4, "ScratchHeadState"),
    (0x4300_00F5, "TapFootState"),
    (0x4300_00F6, "LeanState"),
    (0x4300_00F7, "KneelState"),
    (0x4300_00F8, "PleadState"),
    (0x4300_00FA, "SlouchState"),
    (0x4300_00FB, "SurrenderState"),
    (0x4300_00FC, "WoahState"),
    (0x4300_00FD, "WindedState"),
    (0x4300_0118, "SnowAngelState"),
    (0x4300_011A, "CurtseyState"),
    (0x4300_011B, "AFKState"),
    (0x4300_011C, "MeditateState"),
    (0x4300_013D, "SitState"),
    (0x4300_013E, "SitCrossleggedState"),
    (0x4300_013F, "SitBackState"),
    (0x4300_0140, "PointLeftState"),
    (0x4300_0141, "PointRightState"),
    (0x4300_0142, "TalktotheHandState"),
    (0x4300_0143, "PointDownState"),
    (0x4300_0144, "DrudgeDanceState"),
    (0x4300_0145, "PossumState"),
    (0x4300_0146, "ReadState"),
    (0x4300_0147, "ThinkerState"),
    (0x4300_0148, "HaveASeatState"),
    (0x4300_0149, "AtEaseState"),
];

const CATEGORY_6_INTERACTION: &[(u32, &str)] = &[
    (0x4000_0016, "Reload"),
    (0x4000_0017, "Unload"),
    (0x4000_0018, "Pickup"),
    (0x4000_0019, "StoreInBackpack"),
    (0x4000_001A, "Eat"),
    (0x4000_001B, "Drink"),
    (0x4000_001C, "Reading"),
    (0x1000_00A0, "EnterPortal"),
    (0x1000_00A1, "ExitPortal"),
    (0x8000_00E8, "BowNoAmmo"),
    (0x8000_00E9, "CrossBowNoAmmo"),
    (0x4000_0136, "Pickup5"),
    (0x4000_0137, "Pickup10"),
    (0x4000_0138, "Pickup15"),
    (0x4000_0139, "Pickup20"),
];

const CATEGORY_7_IDLE: &[(u32, &str)] = &[
    (0x1000_009C, "EnterGame"),
    (0x1000_009D, "ExitGame"),
    (0x1000_009E, "OnCreation"),
    (0x1000_009F, "OnDestruction"),
    (0x1000_00E2, "Blink"),
    (0x1000_00E3, "Bite"),
    (0x1000_011E, "LogOut"),
];

/// Resolve the portal DAT path the same way other examples do.
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

/// Compose the cycle / link outer-key the same way `MotionTable.cycles`
/// keys are formed: `(stance_low16 << 16) | cmd_low20`. Mirrors
/// `external/holtburger/crates/holtburger-dat/examples/dump_player_mt_fall_variants.rs`.
fn cycle_key(stance: u32, command: u32) -> u32 {
    ((stance & 0xFFFF) << 16) | (command & 0x000F_FFFF)
}

/// Count present entries in `mt.links[(stance, Ready)][cmd]` for each of
/// the candidate commands.
fn count_present_links(mt: &MotionTable, stance: u32, candidates: &[(u32, &str)]) -> usize {
    let outer = cycle_key(stance, READY_LOW);
    let inner = mt.links.get(&outer);
    candidates
        .iter()
        .filter(|(cmd, _)| {
            inner
                .and_then(|m| m.get(cmd))
                .map(|md| !md.anims.is_empty())
                .unwrap_or(false)
        })
        .count()
}

/// Same as count but enumerate by name.
fn present_link_names<'a>(
    mt: &MotionTable,
    stance: u32,
    candidates: &'a [(u32, &'a str)],
) -> Vec<&'a str> {
    let outer = cycle_key(stance, READY_LOW);
    let inner = mt.links.get(&outer);
    candidates
        .iter()
        .filter_map(|(cmd, name)| {
            if inner
                .and_then(|m| m.get(cmd))
                .map(|md| !md.anims.is_empty())
                .unwrap_or(false)
            {
                Some(*name)
            } else {
                None
            }
        })
        .collect()
}

/// Walk the cycles map looking for `cmd_low` matches under any stance,
/// returning the distinct stance/value pairs found.
fn present_cycle_names_any_stance<'a>(
    mt: &MotionTable,
    candidates: &'a [(u32, &'a str)],
) -> Vec<&'a str> {
    let mut hits = std::collections::BTreeSet::new();
    for (cmd, name) in candidates.iter() {
        let cmd_low = *cmd & 0xFFFF;
        for (k, v) in mt.cycles.iter() {
            let k_cmd_low = *k & 0xFFFF;
            if k_cmd_low == cmd_low && !v.anims.is_empty() {
                hits.insert(*name);
                break;
            }
        }
    }
    hits.into_iter().collect()
}

fn print_player_mt_report(mt: &MotionTable) {
    println!("============================================================");
    println!("# Player MotionTable 0x{:08X} — Wave 8 classifier audit", PLAYER_MT_ID);
    println!("============================================================");
    println!(
        "# cycles: {} entries, modifiers: {} entries, links: {} outer keys",
        mt.cycles.len(),
        mt.modifiers.len(),
        mt.links.len(),
    );
    println!();

    // Category 2 — Emotes: should live in links[(NonCombat, Ready)][cmd].
    let emotes_in_links = count_present_links(mt, STANCE_NONCOMBAT, CATEGORY_2_EMOTES);
    let emotes_total = CATEGORY_2_EMOTES.len();
    println!(
        "## Category 2 — Emotes ({}/{} present in links[(NonCombat, Ready)][cmd])",
        emotes_in_links, emotes_total
    );
    let present_emotes = present_link_names(mt, STANCE_NONCOMBAT, CATEGORY_2_EMOTES);
    if present_emotes.is_empty() {
        println!("  (none found)");
    } else {
        for name in &present_emotes {
            println!("  - {name}");
        }
    }
    println!();

    // Category 3 — Reactions: should live in links[(stance, Ready)][cmd].
    let reactions_noncombat = count_present_links(mt, STANCE_NONCOMBAT, CATEGORY_3_REACTIONS);
    let reactions_handcombat = count_present_links(mt, STANCE_HAND_COMBAT, CATEGORY_3_REACTIONS);
    println!(
        "## Category 3 — Reactions ({}/{} NonCombat, {}/{} HandCombat in links[(stance, Ready)][cmd])",
        reactions_noncombat,
        CATEGORY_3_REACTIONS.len(),
        reactions_handcombat,
        CATEGORY_3_REACTIONS.len(),
    );
    println!();

    // Category 5 — Stationary poses: should live in cycles[(stance, cmd)].
    let stationary_any = present_cycle_names_any_stance(mt, CATEGORY_5_STATIONARY);
    println!(
        "## Category 5 — Stationary poses ({}/{} present in cycles under ANY stance)",
        stationary_any.len(),
        CATEGORY_5_STATIONARY.len(),
    );
    if !stationary_any.is_empty() {
        for name in &stationary_any {
            println!("  - {name}");
        }
    }
    println!();

    // Category 6 — Interactions: should live in links[(stance, Ready)][cmd].
    let interaction_noncombat = count_present_links(mt, STANCE_NONCOMBAT, CATEGORY_6_INTERACTION);
    println!(
        "## Category 6 — Interactions ({}/{} present in links[(NonCombat, Ready)][cmd])",
        interaction_noncombat,
        CATEGORY_6_INTERACTION.len(),
    );
    let present_interactions = present_link_names(mt, STANCE_NONCOMBAT, CATEGORY_6_INTERACTION);
    if !present_interactions.is_empty() {
        for name in &present_interactions {
            println!("  - {name}");
        }
    }
    println!();

    // Category 7 — Idle ambient: should live in links[(stance, Ready)][cmd].
    let idle_present = count_present_links(mt, STANCE_NONCOMBAT, CATEGORY_7_IDLE);
    println!(
        "## Category 7 — Idle ambient ({}/{} present in links[(NonCombat, Ready)][cmd])",
        idle_present,
        CATEGORY_7_IDLE.len(),
    );
    let present_idle = present_link_names(mt, STANCE_NONCOMBAT, CATEGORY_7_IDLE);
    if !present_idle.is_empty() {
        for name in &present_idle {
            println!("  - {name}");
        }
    }
    println!();

    // Magic-stance reactions / interactions probe (rare but checks coverage)
    let magic_reactions = count_present_links(mt, STANCE_MAGIC, CATEGORY_3_REACTIONS);
    let magic_emotes = count_present_links(mt, STANCE_MAGIC, CATEGORY_2_EMOTES);
    println!(
        "## Magic-stance probe — emotes {}/{}, reactions {}/{}",
        magic_emotes,
        emotes_total,
        magic_reactions,
        CATEGORY_3_REACTIONS.len(),
    );
    println!();

    // Where do reactions actually live? Probe all three tables.
    // (Wave 8 finding from initial example run: reactions were 0/9 in
    // links — investigate cycles + modifiers + full link sweep before
    // declaring the data missing.)
    println!("## Reaction-location sweep (all stances, all tables):");
    let mut reactions_anywhere = 0usize;
    for (cmd, name) in CATEGORY_3_REACTIONS {
        let cmd_low = cmd & 0xFFFF;
        let cycle_hits = mt.cycles.iter().filter(|(k, _)| (**k & 0xFFFF) == cmd_low).count();
        let modifier_hits = mt.modifiers.iter().filter(|(k, _)| (**k & 0xFFFF) == cmd_low).count();
        let mut link_hits = 0;
        for inner in mt.links.values() {
            for k in inner.keys() {
                if (*k & 0xFFFF) == cmd_low {
                    link_hits += 1;
                }
            }
        }
        if cycle_hits + modifier_hits + link_hits > 0 {
            reactions_anywhere += 1;
        }
        println!(
            "  {name} (low=0x{cmd_low:04X}): cycles={cycle_hits} modifiers={modifier_hits} links={link_hits}"
        );
    }
    println!(
        "  (reactions present anywhere: {}/{})",
        reactions_anywhere,
        CATEGORY_3_REACTIONS.len()
    );
    println!();

    // Structured summary for the .mjs assertion wrapper.
    println!("PLAYER_MT_ID=0x{:08X}", PLAYER_MT_ID);
    println!("EMOTES_PRESENT={emotes_in_links}");
    println!("EMOTES_TOTAL={emotes_total}");
    println!("REACTIONS_NONCOMBAT={reactions_noncombat}");
    println!("REACTIONS_HANDCOMBAT={reactions_handcombat}");
    println!("STATIONARY_ANY={}", stationary_any.len());
    println!("STATIONARY_TOTAL={}", CATEGORY_5_STATIONARY.len());
    println!("INTERACTIONS_PRESENT={interaction_noncombat}");
    println!("INTERACTIONS_TOTAL={}", CATEGORY_6_INTERACTION.len());
    println!("IDLE_PRESENT={idle_present}");
    println!("IDLE_TOTAL={}", CATEGORY_7_IDLE.len());
}

/// Find a few NPC motion tables for the cross-check pass. Scans the DAT
/// for MT IDs in `0x09000000..=0x0900FFFF`, parses each, and selects the
/// first 3 with ≥100 cycles (humanoid-rich tables) excluding the player
/// MT.
fn pick_npc_motion_tables(dat: &DatDatabase, max: usize) -> Vec<(u32, MotionTable)> {
    let mut found = Vec::new();
    let mut ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|id| (0x0900_0000..=0x0900_FFFF).contains(id))
        .collect();
    ids.sort_unstable();
    for id in ids {
        if id == PLAYER_MT_ID {
            continue;
        }
        let bytes = match dat.get_file(id) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let mut cursor = Cursor::new(&bytes);
        let mt = match MotionTable::read(&mut cursor) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if mt.cycles.len() >= 100 {
            found.push((id, mt));
            if found.len() >= max {
                break;
            }
        }
    }
    found
}

fn print_npc_summary(id: u32, mt: &MotionTable) {
    let emotes = count_present_links(mt, STANCE_NONCOMBAT, CATEGORY_2_EMOTES);
    let reactions = count_present_links(mt, STANCE_NONCOMBAT, CATEGORY_3_REACTIONS);
    let interactions = count_present_links(mt, STANCE_NONCOMBAT, CATEGORY_6_INTERACTION);
    let stationary = present_cycle_names_any_stance(mt, CATEGORY_5_STATIONARY).len();
    let idle = count_present_links(mt, STANCE_NONCOMBAT, CATEGORY_7_IDLE);
    println!(
        "  NPC MT 0x{:08X} — cycles={} links_outers={} | emotes={}/{} reactions={}/{} interactions={}/{} stationary={}/{} idle={}/{}",
        id,
        mt.cycles.len(),
        mt.links.len(),
        emotes,
        CATEGORY_2_EMOTES.len(),
        reactions,
        CATEGORY_3_REACTIONS.len(),
        interactions,
        CATEGORY_6_INTERACTION.len(),
        stationary,
        CATEGORY_5_STATIONARY.len(),
        idle,
        CATEGORY_7_IDLE.len(),
    );
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

    // -- Player MT --
    let bytes = match dat.get_file(PLAYER_MT_ID) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("MT 0x{PLAYER_MT_ID:08X} not in DAT: {e}");
            return ExitCode::from(2);
        }
    };
    let mut cursor = Cursor::new(&bytes);
    let player_mt = match MotionTable::read(&mut cursor) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("MotionTable parse failed: {e}");
            return ExitCode::from(2);
        }
    };
    assert_eq!(player_mt.id, PLAYER_MT_ID);
    print_player_mt_report(&player_mt);

    // -- NPC MTs (cross-check sample) --
    println!();
    println!("============================================================");
    println!("# NPC MotionTable cross-check (≥100 cycles, first 3 found)");
    println!("============================================================");
    let npcs = pick_npc_motion_tables(&dat, 3);
    if npcs.is_empty() {
        println!("  (no NPC MTs found with ≥100 cycles)");
    } else {
        for (id, mt) in &npcs {
            print_npc_summary(*id, mt);
        }
    }

    // Final assertion: at least 20 emotes wired in player MT links[(NonCombat, Ready)].
    let emotes_in_links = count_present_links(&player_mt, STANCE_NONCOMBAT, CATEGORY_2_EMOTES);
    if emotes_in_links < 20 {
        eprintln!(
            "FAIL: only {} emotes in player MT links[(NonCombat, Ready)], expected ≥20",
            emotes_in_links
        );
        println!("OVERALL=FAIL");
        return ExitCode::from(1);
    }
    println!();
    println!("OVERALL=PASS");
    ExitCode::SUCCESS
}
