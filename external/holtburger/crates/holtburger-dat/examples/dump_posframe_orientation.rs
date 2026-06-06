//! dump_posframe_orientation — DIM5-2 root-motion ORIENTATION DAT-gate probe.
//!
//! Question: does ANY reachable animation cycle carry a NON-IDENTITY
//! `pos_frame.orientation` quaternion? This decides whether the DIM5-2
//! orientation accumulator (which we implement regardless, because it is
//! no-op-correct for an identity quaternion) produces a visible change, and
//! which cycle to eye-test later.
//!
//! For each MotionTable in a reachable set, this walks EVERY MotionData found
//! in `cycles`, `modifiers` and `links` (so we don't miss combat swings /
//! turn-in-place / lunge / knockback, which often live in links/modifiers),
//! resolves each `AnimData.anim_id` (high byte 0x03 == Animation file), loads
//! the Animation, and inspects each `pos_frame.orientation`.
//!
//! Per cycle it reports the MAX rotation angle (deg) of any pos_frame
//! orientation away from identity:
//!     angle = 2 * acos(min(1, |w|))   [radians] -> degrees
//! and flags any cycle whose max angle exceeds ~1 degree.
//!
//! Run:
//!   PATH="$HOME/.cargo/bin:$PATH" capped-build \
//!     cargo run --release -p holtburger-dat --example dump_posframe_orientation
//! Optional args: a space-separated list of MT ids (hex, 0x-prefixed ok) to
//! scan instead of the built-in reachable set.

use binrw::io::Cursor;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::{Animation, MotionData, MotionTable};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::ExitCode;

fn resolve_dat_path() -> Option<PathBuf> {
    if let Some(p) = holtburger_dat::utils::get_portal_dat_path() {
        return Some(p);
    }
    if let Ok(home) = std::env::var("HOME") {
        let p = PathBuf::from(home).join("ac_base_dats/client_portal.dat");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// Rotation angle (degrees) of a quaternion away from identity.
/// |w| is clamped to 1.0 to guard against tiny FP overshoot in acos.
fn angle_deg(q: &holtburger_common::Quaternion) -> f32 {
    let w = q.w.abs().min(1.0);
    (2.0 * w.acos()).to_degrees()
}

/// Threshold above which we treat a cycle's authored orientation as a real,
/// visible (non-identity) rotation worth eye-testing.
const FLAG_DEG: f32 = 1.0;

struct CycleHit {
    mt_id: u32,
    bucket: &'static str, // "cycle" | "modifier" | "link"
    key: String,          // human key (style/command)
    max_deg: f32,
    n_pos_frames: usize,
    n_nonident: usize,    // pos_frames whose angle > FLAG_DEG
    worst_quat: holtburger_common::Quaternion,
}

/// Inspect one MotionData's anims. Returns (max_angle_deg, total_pos_frames,
/// n_nonident_frames, worst_quat). Loads any anim it hasn't seen yet into
/// `cache`. Only anim_ids with high byte 0x03 (Animation files) are loaded.
fn inspect_md(
    md: &MotionData,
    dat: &DatDatabase,
    cache: &mut HashMap<u32, Option<Animation>>,
) -> (f32, usize, usize, holtburger_common::Quaternion) {
    let mut max_deg = 0.0f32;
    let mut total = 0usize;
    let mut n_nonident = 0usize;
    let mut worst = holtburger_common::Quaternion::identity();
    for a in &md.anims {
        let id = a.anim_id;
        // Animation files have high byte 0x03 in AC's DAT id space.
        if (id >> 24) != 0x03 {
            continue;
        }
        let entry = cache.entry(id).or_insert_with(|| {
            dat.get_file(id)
                .ok()
                .and_then(|b| Animation::read(&mut Cursor::new(&b)).ok())
        });
        let Some(anim) = entry.as_ref() else { continue };
        for f in &anim.pos_frames {
            total += 1;
            let d = angle_deg(&f.orientation);
            if d > FLAG_DEG {
                n_nonident += 1;
            }
            if d > max_deg {
                max_deg = d;
                worst = f.orientation;
            }
        }
    }
    (max_deg, total, n_nonident, worst)
}

fn scan_mt(
    mt_id: u32,
    dat: &DatDatabase,
    cache: &mut HashMap<u32, Option<Animation>>,
    hits: &mut Vec<CycleHit>,
) -> Option<(usize, usize, usize)> {
    let bytes = match dat.get_file(mt_id) {
        Ok(b) => b,
        Err(_) => return None,
    };
    let mt = match MotionTable::read(&mut Cursor::new(&bytes)) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("  MT 0x{mt_id:08X} parse error: {e}");
            return None;
        }
    };

    let mut n_cycles = 0usize;
    let mut n_mods = 0usize;
    let mut n_links = 0usize;

    // cycles: key = (style<<16 | command_low) per the parser comment.
    for (key, md) in &mt.cycles {
        n_cycles += 1;
        let (max_deg, total, n_ni, worst) = inspect_md(md, dat, cache);
        if max_deg > FLAG_DEG {
            let stance = (key >> 16) & 0xFFFF;
            let cmd = key & 0xFFFF;
            hits.push(CycleHit {
                mt_id,
                bucket: "cycle",
                key: format!("stance=0x{stance:04X} cmd=0x{cmd:04X}"),
                max_deg,
                n_pos_frames: total,
                n_nonident: n_ni,
                worst_quat: worst,
            });
        }
    }

    for (key, md) in &mt.modifiers {
        n_mods += 1;
        let (max_deg, total, n_ni, worst) = inspect_md(md, dat, cache);
        if max_deg > FLAG_DEG {
            hits.push(CycleHit {
                mt_id,
                bucket: "modifier",
                key: format!("modkey=0x{key:08X}"),
                max_deg,
                n_pos_frames: total,
                n_nonident: n_ni,
                worst_quat: worst,
            });
        }
    }

    for (from_cmd, inner) in &mt.links {
        for (to_cmd, md) in inner {
            n_links += 1;
            let (max_deg, total, n_ni, worst) = inspect_md(md, dat, cache);
            if max_deg > FLAG_DEG {
                hits.push(CycleHit {
                    mt_id,
                    bucket: "link",
                    key: format!("from=0x{from_cmd:08X} -> to=0x{to_cmd:08X}"),
                    max_deg,
                    n_pos_frames: total,
                    n_nonident: n_ni,
                    worst_quat: worst,
                });
            }
        }
    }

    Some((n_cycles, n_mods, n_links))
}

fn main() -> ExitCode {
    let dat = match resolve_dat_path().and_then(|p| DatDatabase::new(&p).ok()) {
        Some(d) => d,
        None => {
            eprintln!("portal.dat not found / unreadable");
            return ExitCode::from(2);
        }
    };

    // Reachable MotionTable set. CLI args override.
    let args: Vec<u32> = std::env::args()
        .skip(1)
        .filter_map(|s| u32::from_str_radix(s.trim_start_matches("0x"), 16).ok())
        .collect();

    let mut targets: Vec<(u32, &'static str)> = if !args.is_empty() {
        args.iter().map(|id| (*id, "cli")).collect()
    } else {
        // Built-in reachable set: the two known player tables plus a spread of
        // common creature MotionTables (discovered by enumerating 0x09xxxxxx in
        // the DAT below). The player tables carry the locomotion + combat swing
        // + turn-in-place + jump/fall cycles that matter for DIM5-2.
        vec![
            (0x0900_0001, "player (primary)"),
            (0x0900_0202, "player (alt/0x0202)"),
        ]
    };

    // If using the built-in set, ALSO auto-discover all 0x09xxxxxx MotionTables
    // present in the DAT so we can scan the full reachable universe (creatures,
    // NPCs) and not miss a non-identity authored turn/lunge/knockback anywhere.
    let mut discovered: Vec<u32> = Vec::new();
    if args.is_empty() {
        for id in dat.files.keys().copied() {
            if (0x0900_0000..=0x0900_FFFF).contains(&id)
                && id != 0x0900_0001
                && id != 0x0900_0202
            {
                discovered.push(id);
            }
        }
        discovered.sort_unstable();
        for id in &discovered {
            targets.push((*id, "discovered 0x09"));
        }
    }

    println!(
        "DIM5-2 pos_frame.orientation DAT-gate probe — scanning {} MotionTables (flag > {FLAG_DEG} deg)",
        targets.len()
    );

    let mut cache: HashMap<u32, Option<Animation>> = HashMap::new();
    let mut hits: Vec<CycleHit> = Vec::new();
    let mut scanned = 0usize;
    let mut missing = 0usize;
    let (mut tot_cycles, mut tot_mods, mut tot_links) = (0usize, 0usize, 0usize);

    // Print the explicitly-named (non-discovered) tables individually so the
    // log clearly shows the player tables were reached.
    for (id, label) in &targets {
        match scan_mt(*id, &dat, &mut cache, &mut hits) {
            Some((c, m, l)) => {
                scanned += 1;
                tot_cycles += c;
                tot_mods += m;
                tot_links += l;
                if *label != "discovered 0x09" {
                    println!(
                        "  scanned MT 0x{id:08X} [{label}]: {c} cycles, {m} modifiers, {l} links",
                    );
                }
            }
            None => {
                missing += 1;
                if *label != "discovered 0x09" {
                    println!("  MT 0x{id:08X} [{label}]: NOT PRESENT in DAT");
                }
            }
        }
    }

    println!(
        "\nTotals: {scanned} MTs scanned ({missing} absent), {tot_cycles} cycles + {tot_mods} modifiers + {tot_links} links, {} distinct Animations loaded.",
        cache.values().filter(|v| v.is_some()).count()
    );

    hits.sort_by(|a, b| b.max_deg.partial_cmp(&a.max_deg).unwrap_or(std::cmp::Ordering::Equal));

    if hits.is_empty() {
        println!(
            "\nVERDICT: NO reachable cycle carries a pos_frame.orientation > {FLAG_DEG} deg from identity."
        );
        println!("All reachable root-motion is PURE TRANSLATION (orientation == identity).");
    } else {
        println!(
            "\nVERDICT: {} reachable MotionData(s) carry a NON-IDENTITY pos_frame.orientation > {FLAG_DEG} deg:",
            hits.len()
        );
        // Cap the printed list so a runaway doesn't flood the log; print the
        // worst offenders first.
        let show = hits.len().min(60);
        for h in hits.iter().take(show) {
            println!(
                "  MT 0x{:08X} [{}] {} : max={:.2} deg ({}/{} frames > {}deg) worst q=(w={:.4} x={:.4} y={:.4} z={:.4})",
                h.mt_id, h.bucket, h.key, h.max_deg, h.n_nonident, h.n_pos_frames, FLAG_DEG,
                h.worst_quat.w, h.worst_quat.x, h.worst_quat.y, h.worst_quat.z,
            );
        }
        if hits.len() > show {
            println!("  ... and {} more (sorted by max angle desc).", hits.len() - show);
        }
    }

    ExitCode::SUCCESS
}
