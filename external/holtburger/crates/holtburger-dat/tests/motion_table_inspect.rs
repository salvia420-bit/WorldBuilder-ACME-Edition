//! Inspection probe for retail motion table `0x09000001` — the canonical
//! human/character motion table that drives all combat swings.
//!
//! Unblocks the swing-pose follow-on per
//! `external/holtburger/docs/motion-table-acclient-audit-2026-05-19.md` §5
//! and [[project_holtburger_motion_table_combat_path]].
//!
//! Run with `cargo test -p holtburger-dat --test motion_table_inspect -- --nocapture`.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Cursor;

use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::motion_table::{MotionData, MotionTable};

mod common;
use common::motion_command_names::{MotionCommandClass, motion_command_class, motion_command_name};

const HUMAN_MOTION_TABLE_ID: u32 = 0x0900_0001;

fn fmt_cmd(value: u32) -> String {
    match motion_command_name(value) {
        Some(name) => format!("{:<32} 0x{:08X}", name, value),
        None => format!("{:<32} 0x{:08X}", "(unknown)", value),
    }
}

/// Inspect motion table 0x09000001 (human character). Prints a structured
/// report covering: stances present, cycles per stance with command-name
/// classification, attack commands grouped by AttackHigh/Med/Low, and the
/// link/modifier surface size.
///
/// This is a probe, not an assertion test — it always passes (subject to the
/// portal-dat being available); the value is in the stderr output. Use it as
/// the ground-truth input for the swing-pose classifier spec.
#[test]
fn inspect_human_motion_table_0x09000001() {
    let path = match common::get_portal_dat_path() {
        Some(p) => p,
        None => {
            let fallback =
                std::path::PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
            if !fallback.exists() {
                eprintln!("[inspect_human_motion_table] SKIP — no client_portal.dat available");
                return;
            }
            fallback
        }
    };

    let dat = DatDatabase::new(&path).expect("open client_portal.dat");
    let bytes = dat
        .get_file(HUMAN_MOTION_TABLE_ID)
        .expect("motion table 0x09000001 must exist in retail portal");
    let mt = MotionTable::read(&mut Cursor::new(bytes))
        .expect("MotionTable::read should succeed on retail 0x09000001");

    eprintln!("====================================================================");
    eprintln!(
        "Motion table 0x{:08X} (human character) — default_style 0x{:08X} ({})",
        mt.id,
        mt.default_style,
        motion_command_name(mt.default_style).unwrap_or("?")
    );
    eprintln!("  style_defaults: {} entries", mt.style_defaults.len());
    eprintln!("  cycles:         {} entries", mt.cycles.len());
    eprintln!("  modifiers:      {} entries", mt.modifiers.len());
    eprintln!("  links:          {} outer groups", mt.links.len());
    eprintln!();

    // ===== 1. STYLE DEFAULTS (stance → default substate) =====
    eprintln!("STYLE DEFAULTS — every stance's default substate (post-equip pose):");
    let mut sd_keys: Vec<&u32> = mt.style_defaults.keys().collect();
    sd_keys.sort();
    for stance in sd_keys {
        let substate = mt.style_defaults.get(stance).copied().unwrap_or(0);
        eprintln!("  {}  →  {}", fmt_cmd(*stance), fmt_cmd(substate));
    }
    eprintln!();

    // ===== 2. STANCES INVOLVED (high 16 bits of cycle keys) =====
    // Cycles are keyed (stance << 16) | substate. The high 16 of the u32 key
    // are the LOW 16 of the MotionCommand stance (per MotionStance enum:
    // NonCombat = 61, SwordCombat = 62, etc.). Reconstruct the full
    // MotionCommand by OR-ing with 0x80000000.
    let mut cycles_by_stance: BTreeMap<u32, Vec<(u32, &MotionData)>> = BTreeMap::new();
    for (&cycle_key, motion_data) in mt.cycles.iter() {
        let stance_low16 = (cycle_key >> 16) & 0xFFFF;
        let substate = cycle_key & 0xFFFF;
        let full_stance = 0x8000_0000_u32 | stance_low16;
        cycles_by_stance
            .entry(full_stance)
            .or_default()
            .push((substate, motion_data));
    }
    // Add any stances that have only style_defaults entries.
    for stance in mt.style_defaults.keys() {
        cycles_by_stance.entry(*stance).or_default();
    }
    eprintln!("STANCES present in cycles + style_defaults: {} distinct", cycles_by_stance.len());
    for stance in cycles_by_stance.keys() {
        let cnt = cycles_by_stance.get(stance).map(|v| v.len()).unwrap_or(0);
        eprintln!("  {} — {} cycle entries", fmt_cmd(*stance), cnt);
    }
    eprintln!();

    // ===== 3. PER-STANCE CYCLE INVENTORY with classification =====
    eprintln!("PER-STANCE CYCLES (sorted by substate; classified):");
    for (stance, mut cycles) in cycles_by_stance.clone() {
        cycles.sort_by_key(|(k, _)| *k);
        if cycles.is_empty() {
            continue;
        }
        eprintln!("  Stance {} ({} cycles):",
            motion_command_name(stance).unwrap_or("?"),
            cycles.len());
        for (substate_low16, motion_data) in cycles {
            // The substate stored in the cycle key is the LOW 16 bits of the
            // command. To classify, reconstruct candidate full commands by
            // probing both the 0x10000000 and 0x40000000 prefixes (the two
            // most common). We pick the one that resolves to a known name.
            let candidates = [
                0x1000_0000 | substate_low16,
                0x4000_0000 | substate_low16,
                0x4500_0000 | substate_low16,
                0x4400_0000 | substate_low16,
                0x4100_0000 | substate_low16,
                0x4300_0000 | substate_low16,
                0x6500_0000 | substate_low16,
                0x2500_0000 | substate_low16,
                0x8500_0000 | substate_low16,
            ];
            let resolved = candidates
                .iter()
                .copied()
                .find(|v| motion_command_name(*v).is_some());
            let display = match resolved {
                Some(full) => format!("{} (substate 0x{:04X})",
                    fmt_cmd(full),
                    substate_low16),
                None => format!("(unknown substate 0x{:04X}, raw key 0x{:08X})",
                    substate_low16,
                    (stance & 0xFFFF) << 16 | substate_low16),
            };
            let class = resolved.map(motion_command_class).unwrap_or(MotionCommandClass::Misc);
            let extras = {
                let mut e = String::new();
                if !motion_data.anims.is_empty() {
                    e.push_str(&format!(" anims={}", motion_data.anims.len()));
                }
                if let Some(v) = motion_data.velocity {
                    e.push_str(&format!(" vel=({:.2},{:.2},{:.2})", v.x, v.y, v.z));
                }
                if let Some(o) = motion_data.omega {
                    e.push_str(&format!(" omega=({:.2},{:.2},{:.2})", o.x, o.y, o.z));
                }
                if motion_data.bitfield & 0x01 != 0 {
                    e.push_str(" CLEAR_MODIFIERS");
                }
                e
            };
            eprintln!("    [{:?}] {}{}", class, display, extras);
        }
        eprintln!();
    }

    // ===== 4. MODIFIERS PER STANCE (this is where swings live!) =====
    // Cycles hold the base looping anim per (stance, substate). Modifiers
    // hold the *overlay* anims that can be layered on top — including
    // attack swings, magic gestures, kicks, etc. Per acclient.c's
    // CMotionTable::GetObjectSequence + MotionState model, modifiers are
    // appended via add_motion in the sequence chain.
    let mut modifiers_by_stance: BTreeMap<u32, Vec<(u32, &MotionData)>> = BTreeMap::new();
    for (&mod_key, motion_data) in mt.modifiers.iter() {
        let stance_low16 = (mod_key >> 16) & 0xFFFF;
        let substate_low16 = mod_key & 0xFFFF;
        let full_stance = 0x8000_0000_u32 | stance_low16;
        modifiers_by_stance
            .entry(full_stance)
            .or_default()
            .push((substate_low16, motion_data));
    }
    eprintln!("MODIFIERS PER STANCE (sorted by substate; classified):");
    for (stance, mut mods) in modifiers_by_stance.clone() {
        mods.sort_by_key(|(k, _)| *k);
        eprintln!("  Stance {} ({} modifiers):",
            motion_command_name(stance).unwrap_or("?"),
            mods.len());
        for (substate_low16, motion_data) in mods {
            let candidates = [
                0x1000_0000 | substate_low16,
                0x4000_0000 | substate_low16,
                0x4500_0000 | substate_low16,
                0x4400_0000 | substate_low16,
                0x4100_0000 | substate_low16,
                0x4300_0000 | substate_low16,
                0x6500_0000 | substate_low16,
                0x2500_0000 | substate_low16,
                0x1300_0000 | substate_low16,
            ];
            let resolved = candidates
                .iter()
                .copied()
                .find(|v| motion_command_name(*v).is_some());
            let display = match resolved {
                Some(full) => fmt_cmd(full),
                None => format!("(unknown substate 0x{:04X})", substate_low16),
            };
            let class = resolved.map(motion_command_class).unwrap_or(MotionCommandClass::Misc);
            let extras = {
                let mut e = String::new();
                if !motion_data.anims.is_empty() {
                    e.push_str(&format!(" anims={}", motion_data.anims.len()));
                    if let Some(a) = motion_data.anims.first() {
                        e.push_str(&format!(" anim0=(id=0x{:08X} {}..{} @{:.1}fps)",
                            a.anim_id, a.low_frame, a.high_frame, a.framerate));
                    }
                }
                if let Some(v) = motion_data.velocity {
                    e.push_str(&format!(" vel=({:.2},{:.2},{:.2})", v.x, v.y, v.z));
                }
                if let Some(o) = motion_data.omega {
                    e.push_str(&format!(" omega=({:.2},{:.2},{:.2})", o.x, o.y, o.z));
                }
                if motion_data.bitfield & 0x01 != 0 {
                    e.push_str(" CLEAR_MODIFIERS");
                }
                e
            };
            eprintln!("    [{:?}] {}{}", class, display, extras);
        }
        eprintln!();
    }

    // ===== 5. ATTACK COMMANDS ROLLUP (the key output for swing-pose spec) =====
    eprintln!("ATTACK ROLLUP — swing commands present in MODIFIERS:");
    let mut attacks_by_class: BTreeMap<MotionCommandClass, BTreeMap<u32, BTreeSet<u32>>> =
        BTreeMap::new();
    for (mod_key, _motion_data) in mt.modifiers.iter() {
        let stance_low16 = (mod_key >> 16) & 0xFFFF;
        let substate_low16 = mod_key & 0xFFFF;
        let full_stance = 0x8000_0000_u32 | stance_low16;
        let candidates = [
            0x1000_0000 | substate_low16,
            0x4000_0000 | substate_low16,
        ];
        let resolved = candidates
            .iter()
            .copied()
            .find(|v| motion_command_name(*v).is_some())
            .unwrap_or(0x1000_0000 | substate_low16);
        let class = motion_command_class(resolved);
        if matches!(
            class,
            MotionCommandClass::AttackHigh
                | MotionCommandClass::AttackMedium
                | MotionCommandClass::AttackLow
        ) {
            attacks_by_class
                .entry(class)
                .or_default()
                .entry(resolved)
                .or_default()
                .insert(full_stance);
        }
    }
    for class in [
        MotionCommandClass::AttackHigh,
        MotionCommandClass::AttackMedium,
        MotionCommandClass::AttackLow,
    ] {
        if let Some(per_class) = attacks_by_class.get(&class) {
            eprintln!(
                "  {:?}: {} distinct commands across {} stance-pairs",
                class,
                per_class.len(),
                per_class.values().map(|s| s.len()).sum::<usize>()
            );
            for (cmd, stances) in per_class {
                let stance_names: Vec<&str> = stances
                    .iter()
                    .map(|s| motion_command_name(*s).unwrap_or("?"))
                    .collect();
                eprintln!(
                    "    {}  in [{}]",
                    fmt_cmd(*cmd),
                    stance_names.join(", ")
                );
            }
        }
    }
    eprintln!();

    // ===== 5. LINKS SHAPE (transitions between substates) =====
    // CRITICAL: links is where SWINGS live. `links[(stance, from_substate)]
    // → { to_substate → MotionData }`. The MotionData IS the transition
    // animation. For swings: from_substate is Ready (0x03) or some other
    // ready-state, to_substate is AttackHi/Med/Lo, MotionData has 1 anim
    // (the swing keyframes).
    let mut link_stance_pairs: BTreeMap<u32, usize> = BTreeMap::new();
    for outer_key in mt.links.keys() {
        let stance_low16 = (outer_key >> 16) & 0xFFFF;
        let full_stance = 0x8000_0000_u32 | stance_low16;
        let count = mt.links.get(outer_key).map(|m| m.len()).unwrap_or(0);
        *link_stance_pairs.entry(full_stance).or_default() += count;
    }
    eprintln!("LINKS BY STANCE — outgoing transition count per stance:");
    for (stance, count) in link_stance_pairs {
        eprintln!("  {} — {} link destinations", fmt_cmd(stance), count);
    }
    eprintln!();

    // ===== 6. SWING LINKS (the actual swing classifier input) =====
    // Walk every link entry, classify the to_substate by resolving against
    // the 0x10000xxx (attack) and 0x40000xxx (magic-gesture) prefixes.
    // Group by stance + attack class. This is the spec input for the JS
    // classifyMotionCommand function.
    eprintln!("SWING LINKS — link entries whose to_substate resolves to an attack:");
    #[derive(Clone)]
    struct SwingEntry {
        from_stance: u32,
        from_substate: u32,
        to_command: u32,
        to_class: MotionCommandClass,
        anims: usize,
        anim0_id: u32,
        anim0_low: i32,
        anim0_high: i32,
        anim0_fps: f32,
    }
    let mut swing_links: Vec<SwingEntry> = Vec::new();
    for (outer_key, inner) in mt.links.iter() {
        let from_stance_low16 = (outer_key >> 16) & 0xFFFF;
        let from_substate_low16 = outer_key & 0xFFFF;
        let from_stance_full = 0x8000_0000_u32 | from_stance_low16;
        for (to_key, motion_data) in inner.iter() {
            let to_substate_low16 = to_key & 0xFFFF;
            // Try attack prefix first; if that doesn't classify as an
            // attack, try magic-gesture prefix.
            let attack_candidate = 0x1000_0000 | to_substate_low16;
            let magic_candidate = 0x4000_0000 | to_substate_low16;
            let class = motion_command_class(attack_candidate);
            let (to_full, to_class) = if matches!(
                class,
                MotionCommandClass::AttackHigh
                    | MotionCommandClass::AttackMedium
                    | MotionCommandClass::AttackLow
            ) {
                (attack_candidate, class)
            } else {
                let mc = motion_command_class(magic_candidate);
                if mc == MotionCommandClass::MagicGesture {
                    (magic_candidate, mc)
                } else {
                    continue;
                }
            };
            let (anim0_id, anim0_low, anim0_high, anim0_fps) =
                motion_data.anims.first().map(|a| (a.anim_id, a.low_frame, a.high_frame, a.framerate)).unwrap_or((0, 0, 0, 0.0));
            swing_links.push(SwingEntry {
                from_stance: from_stance_full,
                from_substate: from_substate_low16,
                to_command: to_full,
                to_class,
                anims: motion_data.anims.len(),
                anim0_id,
                anim0_low,
                anim0_high,
                anim0_fps,
            });
        }
    }
    eprintln!("  Found {} swing/magic link entries", swing_links.len());
    // Group by (stance, to_class)
    let mut by_stance_class: BTreeMap<(u32, MotionCommandClass), Vec<&SwingEntry>> =
        BTreeMap::new();
    for s in &swing_links {
        by_stance_class
            .entry((s.from_stance, s.to_class))
            .or_default()
            .push(s);
    }
    for ((stance, class), entries) in &by_stance_class {
        let stance_name = motion_command_name(*stance).unwrap_or("?");
        eprintln!("  {} / {:?}: {} entries", stance_name, class, entries.len());
        for e in entries.iter().take(50) {
            let to_name = motion_command_name(e.to_command).unwrap_or("?");
            let from_substate_full = 0x4100_0000 | e.from_substate;
            let from_name = motion_command_name(from_substate_full)
                .or_else(|| motion_command_name(0x4000_0000 | e.from_substate))
                .unwrap_or("?");
            eprintln!(
                "    from {:>20}(0x{:04X})  →  {:<22}(0x{:08X})  anim=0x{:08X} {}..{} @{:.1}fps n={}",
                from_name, e.from_substate, to_name, e.to_command,
                e.anim0_id, e.anim0_low, e.anim0_high, e.anim0_fps, e.anims
            );
        }
        if entries.len() > 50 {
            eprintln!("    ... and {} more", entries.len() - 50);
        }
    }
    eprintln!();

    // ===== 6. SUMMARY of CLEAR_MODIFIERS flag distribution =====
    let mut clear_modifiers_count = 0;
    let mut total_md = 0;
    for md in mt.cycles.values().chain(mt.modifiers.values()) {
        total_md += 1;
        if md.bitfield & 0x01 != 0 {
            clear_modifiers_count += 1;
        }
    }
    eprintln!(
        "CLEAR_MODIFIERS flag (bitfield bit 0): {}/{} MotionData entries set",
        clear_modifiers_count, total_md
    );

    eprintln!("====================================================================");
}
