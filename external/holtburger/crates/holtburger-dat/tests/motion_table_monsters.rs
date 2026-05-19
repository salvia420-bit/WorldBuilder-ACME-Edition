//! Validate the swing-classification spec against MONSTER motion tables.
//!
//! The spec ([[swing-classification-spec-2026-05-19]]) was derived from
//! exactly one motion table (0x09000001 — human character). The spec §7
//! explicitly flagged "Probe ran on ONE motion table — monster tables likely
//! follow the same pattern but not verified."
//!
//! This test verifies. It does two passes:
//!
//! 1. **Sweep** — list every retail motion table (0x09000000..=0x0900FFFF)
//!    with key metadata (cycle count, modifier count, link count, distinct
//!    stances, attack-link count, magic-link count).
//! 2. **Deep probe** — for a stratified sample (small/medium/large by total
//!    activity), dump the per-stance attack/cast structure so we can compare
//!    against the human-pattern findings.
//!
//! Run with `cargo test -p holtburger-dat --test motion_table_monsters -- --nocapture`.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Cursor;

use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::motion_table::{MotionData, MotionTable};

mod common;
use common::motion_command_names::{MotionCommandClass, motion_command_class, motion_command_name};

const HUMAN_MOTION_TABLE_ID: u32 = 0x0900_0001;

fn fmt_cmd_short(value: u32) -> String {
    match motion_command_name(value) {
        Some(name) => name.to_string(),
        None => format!("0x{:08X}", value),
    }
}

#[derive(Debug, Clone)]
struct TableMetadata {
    id: u32,
    cycles: usize,
    modifiers: usize,
    link_groups: usize,
    link_destinations: usize,
    stances_present: BTreeSet<u32>,
    attack_links: usize, // links whose to_substate resolves to AttackHi/Med/Low
    magic_links: usize,  // links whose to_substate resolves to MagicGesture
    from_substates: BTreeSet<u32>, // distinct from_substates seen on attack/magic links
    attack_anim_counts: BTreeMap<usize, usize>, // n_anims -> occurrences (for spec §7 "exactly 1 anim" assumption)
    has_swing_links_with_non_one_anim: bool,
    /// Attack (melee) substate appears as both a link destination AND a cycle key.
    /// Spec violation if non-zero.
    cycle_attack_only_collisions: usize,
    /// Magic-gesture substate appears as both a link destination AND a cycle key.
    /// EXPECTED — the link is the cast-startup anim, the cycle is the held end pose.
    cycle_magic_collisions: usize,
    modifier_attack_collisions: usize,
}

fn analyze(id: u32, mt: &MotionTable) -> TableMetadata {
    let mut stances_present = BTreeSet::new();
    for k in mt.style_defaults.keys() {
        stances_present.insert(*k);
    }
    for k in mt.cycles.keys() {
        let stance_low16 = (k >> 16) & 0xFFFF;
        stances_present.insert(0x8000_0000 | stance_low16);
    }
    for k in mt.modifiers.keys() {
        let stance_low16 = (k >> 16) & 0xFFFF;
        stances_present.insert(0x8000_0000 | stance_low16);
    }
    for k in mt.links.keys() {
        let stance_low16 = (k >> 16) & 0xFFFF;
        stances_present.insert(0x8000_0000 | stance_low16);
    }

    let mut attack_links = 0;
    let mut magic_links = 0;
    let mut from_substates: BTreeSet<u32> = BTreeSet::new();
    let mut attack_anim_counts: BTreeMap<usize, usize> = BTreeMap::new();
    let mut has_swing_links_with_non_one_anim = false;

    // Track attack (melee) substates and magic substates separately —
    // they have different expected collision behavior with cycles.
    let mut attack_substates: BTreeSet<u32> = BTreeSet::new();
    let mut magic_substates: BTreeSet<u32> = BTreeSet::new();
    for (outer_key, inner) in &mt.links {
        let from_substate_low16 = outer_key & 0xFFFF;
        for (to_key, motion_data) in inner.iter() {
            let to_substate_low16 = to_key & 0xFFFF;
            let attack_candidate = 0x1000_0000 | to_substate_low16;
            let magic_candidate = 0x4000_0000 | to_substate_low16;
            let class = motion_command_class(attack_candidate);
            let is_attack = matches!(
                class,
                MotionCommandClass::AttackHigh
                    | MotionCommandClass::AttackMedium
                    | MotionCommandClass::AttackLow
            );
            let is_magic = motion_command_class(magic_candidate) == MotionCommandClass::MagicGesture;
            if is_attack || is_magic {
                from_substates.insert(from_substate_low16);
                *attack_anim_counts.entry(motion_data.anims.len()).or_default() += 1;
                if motion_data.anims.len() != 1 {
                    has_swing_links_with_non_one_anim = true;
                }
                if is_attack {
                    attack_links += 1;
                    attack_substates.insert(to_substate_low16);
                }
                if is_magic {
                    magic_links += 1;
                    magic_substates.insert(to_substate_low16);
                }
            }
        }
    }

    // Cross-check against cycles. Attack collisions = spec violation.
    // Magic collisions = expected (cast-link + held-cycle pair).
    let mut cycle_attack_only_collisions = 0;
    let mut cycle_magic_collisions = 0;
    for k in mt.cycles.keys() {
        let sub = k & 0xFFFF;
        if attack_substates.contains(&sub) {
            cycle_attack_only_collisions += 1;
        }
        if magic_substates.contains(&sub) {
            cycle_magic_collisions += 1;
        }
    }
    let mut modifier_attack_collisions = 0;
    for k in mt.modifiers.keys() {
        let sub = k & 0xFFFF;
        if attack_substates.contains(&sub) || magic_substates.contains(&sub) {
            modifier_attack_collisions += 1;
        }
    }

    let link_destinations: usize = mt.links.values().map(|m| m.len()).sum();

    TableMetadata {
        id,
        cycles: mt.cycles.len(),
        modifiers: mt.modifiers.len(),
        link_groups: mt.links.len(),
        link_destinations,
        stances_present,
        attack_links,
        magic_links,
        from_substates,
        attack_anim_counts,
        has_swing_links_with_non_one_anim,
        cycle_attack_only_collisions,
        cycle_magic_collisions,
        modifier_attack_collisions,
    }
}

fn retail_portal_dat_path() -> Option<std::path::PathBuf> {
    if let Some(p) = holtburger_dat::utils::get_portal_dat_path() {
        return Some(p);
    }
    let c = std::path::PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
    c.exists().then_some(c)
}

#[test]
fn validate_swing_pattern_against_all_motion_tables() {
    let path = match retail_portal_dat_path() {
        Some(p) => p,
        None => {
            eprintln!("[validate_swing_pattern] SKIP — no client_portal.dat");
            return;
        }
    };
    let dat = DatDatabase::new(&path).expect("open portal");

    let mut ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|id| (0x0900_0000..=0x0900_FFFF).contains(id))
        .collect();
    ids.sort();
    assert!(!ids.is_empty(), "no motion tables found in portal");

    let mut all: Vec<TableMetadata> = Vec::with_capacity(ids.len());
    for id in &ids {
        let bytes = dat.get_file(*id).expect("get_file");
        let mt = MotionTable::read(&mut Cursor::new(bytes)).expect("parse motion table");
        all.push(analyze(*id, &mt));
    }

    // ========================================================================
    // PASS 1: Aggregate stats across all 436 tables.
    // ========================================================================
    eprintln!("==== SWING-PATTERN VALIDATION ACROSS ALL {} MOTION TABLES ====", all.len());
    let total = all.len();
    let with_any_swing = all.iter().filter(|t| t.attack_links + t.magic_links > 0).count();
    let with_attack_swings = all.iter().filter(|t| t.attack_links > 0).count();
    let with_magic_swings = all.iter().filter(|t| t.magic_links > 0).count();
    let with_attack_cycle_collisions = all.iter().filter(|t| t.cycle_attack_only_collisions > 0).count();
    let with_magic_cycle_collisions = all.iter().filter(|t| t.cycle_magic_collisions > 0).count();
    let with_modifier_collisions = all.iter().filter(|t| t.modifier_attack_collisions > 0).count();
    let with_multi_anim_swings = all.iter().filter(|t| t.has_swing_links_with_non_one_anim).count();

    eprintln!("  tables with ≥1 attack-link:  {}/{} ({:.1}%)", with_attack_swings, total, 100.0 * with_attack_swings as f32 / total as f32);
    eprintln!("  tables with ≥1 magic-link:   {}/{} ({:.1}%)", with_magic_swings, total, 100.0 * with_magic_swings as f32 / total as f32);
    eprintln!("  tables with ANY swing/cast:  {}/{}", with_any_swing, total);
    eprintln!("  tables with attack-cycle collision (SPEC VIOLATION if >0): {}/{}", with_attack_cycle_collisions, total);
    eprintln!("  tables with magic-cycle collision (EXPECTED — gesture+held-pose pair): {}/{}", with_magic_cycle_collisions, total);
    eprintln!("  tables with modifier collision (attack/magic substate also in modifiers): {}/{}", with_modifier_collisions, total);
    eprintln!("  tables with multi-anim swing links (spec assumes anims=1): {}/{}", with_multi_anim_swings, total);

    // Aggregate the distinct from_substates across all swing links —
    // validates "Ready is the only from_substate" claim.
    let mut all_from_substates: BTreeMap<u32, usize> = BTreeMap::new();
    for t in &all {
        for fs in &t.from_substates {
            *all_from_substates.entry(*fs).or_default() += 1;
        }
    }
    eprintln!("  distinct from_substates seen on swing/cast links (across all tables):");
    for (sub, count) in &all_from_substates {
        // Resolve via several plausible prefixes
        let candidates = [
            0x4100_0000 | sub,
            0x4000_0000 | sub,
            0x4500_0000 | sub,
            0x4400_0000 | sub,
            0x4300_0000 | sub,
            0x6500_0000 | sub,
            0x1000_0000 | sub,
            0x8000_0000 | sub,
            0x2500_0000 | sub,
        ];
        let name = candidates
            .iter()
            .find_map(|c| motion_command_name(*c))
            .unwrap_or("?");
        eprintln!(
            "    substate 0x{:04X} ({}): seen in {} tables",
            sub, name, count
        );
    }

    // Aggregate anim counts on swing links.
    let mut anim_count_dist: BTreeMap<usize, usize> = BTreeMap::new();
    for t in &all {
        for (n, count) in &t.attack_anim_counts {
            *anim_count_dist.entry(*n).or_default() += count;
        }
    }
    eprintln!("  swing-link anim-count distribution:");
    for (n, count) in &anim_count_dist {
        eprintln!("    anims={}: {} link entries", n, count);
    }

    // ========================================================================
    // PASS 2: Stratified deep dive — smallest, mid, biggest tables with swings.
    // ========================================================================
    eprintln!();
    eprintln!("==== DEEP DIVE: tables with swing/cast activity, by size buckets ====");

    let mut with_swing: Vec<&TableMetadata> = all.iter().filter(|t| t.attack_links + t.magic_links > 0).collect();
    with_swing.sort_by_key(|t| t.attack_links + t.magic_links);

    let pick_ids: Vec<u32> = if with_swing.is_empty() {
        Vec::new()
    } else {
        let n = with_swing.len();
        let mut ids = vec![
            with_swing[0].id,                              // smallest
            with_swing[n / 4].id,                          // 25th percentile
            with_swing[n / 2].id,                          // median
            with_swing[3 * n / 4].id,                      // 75th percentile
            with_swing[n - 1].id,                          // largest
        ];
        // Add the human MT for control comparison.
        if !ids.contains(&HUMAN_MOTION_TABLE_ID) {
            ids.push(HUMAN_MOTION_TABLE_ID);
        }
        ids.sort();
        ids.dedup();
        ids
    };

    eprintln!("  Sampled tables: {:?}", pick_ids.iter().map(|i| format!("0x{:08X}", i)).collect::<Vec<_>>());

    for id in &pick_ids {
        let t = all.iter().find(|t| t.id == *id).unwrap();
        eprintln!();
        eprintln!("==================================================================");
        eprintln!("Motion table 0x{:08X}", id);
        eprintln!("  cycles={} modifiers={} link_groups={} link_destinations={}", t.cycles, t.modifiers, t.link_groups, t.link_destinations);
        eprintln!("  stances ({}): {}",
            t.stances_present.len(),
            t.stances_present.iter()
                .map(|s| fmt_cmd_short(*s))
                .collect::<Vec<_>>()
                .join(", "));
        eprintln!("  attack_links={} magic_links={}", t.attack_links, t.magic_links);
        eprintln!("  from_substates seen on swing/cast links: {:?}",
            t.from_substates.iter().map(|s| format!("0x{:04X}", s)).collect::<Vec<_>>());
        eprintln!("  cycle_attack_only_collisions={} (VIOLATION if >0), cycle_magic_collisions={} (expected), modifier_collisions={}",
            t.cycle_attack_only_collisions, t.cycle_magic_collisions, t.modifier_attack_collisions);
        eprintln!("  anim_counts on swing links: {:?}", t.attack_anim_counts);

        // Re-parse and dump per-stance swing breakdown.
        let bytes = dat.get_file(*id).expect("get_file");
        let mt = MotionTable::read(&mut Cursor::new(bytes)).expect("parse");
        dump_swings_per_stance(&mt);
    }
}

fn dump_swings_per_stance(mt: &MotionTable) {
    let mut by_stance_class: BTreeMap<
        (u32, MotionCommandClass),
        Vec<(u32, u32, u32, i32, i32, f32, usize)>,
    > = BTreeMap::new();
    for (outer_key, inner) in &mt.links {
        let stance_low16 = (outer_key >> 16) & 0xFFFF;
        let from_substate_low16 = outer_key & 0xFFFF;
        let full_stance = 0x8000_0000_u32 | stance_low16;
        for (to_key, motion_data) in inner.iter() {
            let to_substate_low16 = to_key & 0xFFFF;
            let attack_candidate = 0x1000_0000 | to_substate_low16;
            let magic_candidate = 0x4000_0000 | to_substate_low16;
            let class_a = motion_command_class(attack_candidate);
            let class_m = motion_command_class(magic_candidate);
            let (resolved, class) = if matches!(
                class_a,
                MotionCommandClass::AttackHigh
                    | MotionCommandClass::AttackMedium
                    | MotionCommandClass::AttackLow
            ) {
                (attack_candidate, class_a)
            } else if class_m == MotionCommandClass::MagicGesture {
                (magic_candidate, class_m)
            } else {
                continue;
            };
            let (aid, low, high, fps) = motion_data
                .anims
                .first()
                .map(|a| (a.anim_id, a.low_frame, a.high_frame, a.framerate))
                .unwrap_or((0, 0, 0, 0.0));
            by_stance_class
                .entry((full_stance, class))
                .or_default()
                .push((
                    from_substate_low16,
                    resolved,
                    aid,
                    low,
                    high,
                    fps,
                    motion_data.anims.len(),
                ));
        }
    }
    if by_stance_class.is_empty() {
        eprintln!("    (no swing/cast links)");
        return;
    }
    for ((stance, class), entries) in &by_stance_class {
        eprintln!(
            "    {} / {:?}: {} entries",
            motion_command_name(*stance).unwrap_or("?"),
            class,
            entries.len()
        );
        for (from_sub, to_cmd, aid, low, high, fps, n_anims) in entries.iter().take(8) {
            let from_name = motion_command_name(0x4100_0000 | from_sub)
                .or_else(|| motion_command_name(0x4000_0000 | from_sub))
                .unwrap_or("?");
            eprintln!(
                "      from {}(0x{:04X}) → {}(0x{:08X}) anim=0x{:08X} {}..{} @{:.1}fps n={}",
                from_name,
                from_sub,
                fmt_cmd_short(*to_cmd),
                to_cmd,
                aid,
                low,
                high,
                fps,
                n_anims
            );
        }
        if entries.len() > 8 {
            eprintln!("      ... and {} more", entries.len() - 8);
        }
    }
}

/// Lookup helper to find motion tables that don't fit the swings-in-links
/// pattern. If this fails, the spec needs revision.
#[test]
fn assert_spec_assumption_swings_only_in_links() {
    let path = match retail_portal_dat_path() {
        Some(p) => p,
        None => {
            eprintln!("[assert_spec_assumption_swings_only_in_links] SKIP — no client_portal.dat");
            return;
        }
    };
    let dat = DatDatabase::new(&path).expect("open portal");

    let mut ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|id| (0x0900_0000..=0x0900_FFFF).contains(id))
        .collect();
    ids.sort();

    let mut violations: Vec<(u32, String)> = Vec::new();
    for id in &ids {
        let bytes = dat.get_file(*id).expect("get_file");
        let mt = MotionTable::read(&mut Cursor::new(bytes)).expect("parse");
        let t = analyze(*id, &mt);

        if t.cycle_attack_only_collisions > 0 {
            violations.push((
                *id,
                format!(
                    "{} MELEE attack substates ALSO present as cycle keys (spec violation)",
                    t.cycle_attack_only_collisions
                ),
            ));
        }
        // Magic-cycle collisions are EXPECTED (the gesture link plays the
        // cast-startup; the cycle holds the end pose).
        // Modifier collisions: informational only, not a spec violation.
    }

    if violations.is_empty() {
        eprintln!(
            "[assert_spec_assumption_swings_only_in_links] PASS — all {} tables: swing substates appear ONLY in links, not in cycles",
            ids.len()
        );
    } else {
        eprintln!(
            "[assert_spec_assumption_swings_only_in_links] {} VIOLATIONS:",
            violations.len()
        );
        for (id, reason) in &violations {
            eprintln!("  0x{:08X}: {}", id, reason);
        }
    }
    assert!(
        violations.is_empty(),
        "spec assumption violated by {} tables — see stderr",
        violations.len()
    );
}
