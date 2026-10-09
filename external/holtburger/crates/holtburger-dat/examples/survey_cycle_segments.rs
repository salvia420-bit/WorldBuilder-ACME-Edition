//! 2026-10-08 (OpenAC comparison, resume) — two portal.dat censuses the
//! round-1 animation findings left open.
//!
//! 1. csequence-5: retail `CSequence::append_animation` makes the LAST
//!    appended node `first_cyclic`, so a cycle MotionData with N > 1 AnimData
//!    plays anims 0..N-2 once and loops only anim N-1. How many CYCLES (not
//!    links) have more than one AnimData?
//! 2. hookFrameExit (anim-hooks-1): hooks fire when a frame is LEFT
//!    (`CSequence::update_internal` runs `execute_hooks` for frames
//!    [old, new) and clamps to the segment end; `advance_to_next_animation`
//!    runs none), so a hook authored on a segment's last frame never fires.
//!    How many hooks that the direction filter would pass sit on the last
//!    frame of a moving cycle / link segment, and of which types?
//!
//! The segment's frame range follows `AnimSequenceNode::set_animation_id`
//! (acclient.c:341108-341127): high_frame < 0 means the last frame, low and
//! high clamp to num_frames - 1, and low > high raises high to low. A forward
//! segment (framerate >= 0) ends on `high`; a reversed one ends on `low`.
//!
//! Run: `cargo run -p holtburger-dat --example survey_cycle_segments`
use binrw::io::Cursor;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::{Animation, MotionTable};
use std::collections::{BTreeMap, HashMap};

const HOOK_NAMES: [&str; 27] = [
    "NoOp", "Sound", "SoundTable", "Attack", "AnimationDone", "ReplaceObject", "Ethereal",
    "TransparentPart", "Luminous", "LuminousPart", "Diffuse", "DiffusePart", "Scale",
    "CreateParticle", "DestroyParticle", "StopParticle", "NoDraw", "DefaultScript",
    "DefaultScriptPart", "CallPES", "Transparent", "SoundTweaked", "SetOmega",
    "TextureVelocity", "TextureVelocityPart", "SetLight", "CreateBlockingParticle",
];

fn hook_name(t: u32) -> String {
    HOOK_NAMES
        .get(t as usize)
        .map(|s| (*s).to_string())
        .unwrap_or_else(|| format!("type{t}"))
}

/// The segment's last-played frame after retail's clamps, or None when the
/// animation has no frames.
fn last_frame(low: i32, high: i32, framerate: f32, n: i32) -> Option<i32> {
    if n <= 0 {
        return None;
    }
    let mut hi = if high < 0 { n - 1 } else { high };
    let lo = if low >= n { n - 1 } else { low };
    hi = hi.min(n - 1);
    if lo > hi {
        hi = lo;
    }
    Some(if framerate < 0.0 { lo.max(0) } else { hi })
}

fn main() {
    let db = DatDatabase::new("/home/wbterminal/ac_base_dats/client_portal.dat").unwrap();
    let mut mt_ids: Vec<u32> = db.files.keys().copied().filter(|id| id >> 24 == 0x09).collect();
    mt_ids.sort();
    let mut anims: HashMap<u32, Option<Animation>> = HashMap::new();
    let mut get_anim = |id: u32| -> Option<Animation> {
        anims
            .entry(id)
            .or_insert_with(|| {
                let bytes = db.get_file(id).ok()?;
                Animation::read(&mut Cursor::new(&bytes)).ok()
            })
            .clone()
    };

    let (mut tables, mut cycles, mut multi_cycles, mut tables_with_multi) = (0usize, 0usize, 0usize, 0usize);
    let mut multi_examples: Vec<String> = Vec::new();
    let mut multi_by_len: BTreeMap<usize, usize> = BTreeMap::new();
    // (kind, hook type) → count of hooks on a segment's last frame.
    let mut last_hooks: BTreeMap<(&str, String), usize> = BTreeMap::new();
    let mut last_examples: Vec<String> = Vec::new();
    let (mut segs_cycle, mut segs_link) = (0usize, 0usize);
    let (mut segs_cycle_hit, mut segs_link_hit) = (0usize, 0usize);
    let mut player_hits: Vec<String> = Vec::new();
    // (kind, covered by a segment that starts on that frame) → hooks.
    let mut coverage: BTreeMap<(&str, bool), usize> = BTreeMap::new();

    for mt_id in mt_ids {
        let Ok(bytes) = db.get_file(mt_id) else { continue };
        let Ok(mt) = MotionTable::read(&mut Cursor::new(&bytes)) else { continue };
        tables += 1;
        let mut this_multi = false;
        let mut segments: Vec<(&str, String, u32, i32, i32, f32)> = Vec::new();
        for (key, md) in &mt.cycles {
            cycles += 1;
            if md.anims.len() > 1 {
                multi_cycles += 1;
                this_multi = true;
                *multi_by_len.entry(md.anims.len()).or_default() += 1;
                if multi_examples.len() < 20 {
                    multi_examples.push(format!(
                        "mt=0x{mt_id:08X} cycle=0x{key:08X} anims={}",
                        md.anims
                            .iter()
                            .map(|a| format!("0x{:08X}[{}..{}]@{:.1}", a.anim_id, a.low_frame, a.high_frame, a.framerate))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
            }
            for a in &md.anims {
                segments.push(("cycle", format!("0x{key:08X}"), a.anim_id, a.low_frame, a.high_frame, a.framerate));
            }
        }
        for (from, inner) in &mt.links {
            for (to, md) in inner {
                for a in &md.anims {
                    segments.push(("link", format!("0x{from:08X}->0x{to:08X}"), a.anim_id, a.low_frame, a.high_frame, a.framerate));
                }
            }
        }
        if this_multi {
            tables_with_multi += 1;
        }
        // Every (anim, start frame) a segment of this table begins on: a hook
        // on one segment's last frame is "covered" when another segment
        // starts on that frame of the same animation (AC splits one long
        // animation into back-to-back segments; the boundary frame's hooks
        // fire once, when the following segment leaves it).
        let mut starts: std::collections::HashSet<(u32, i32)> = std::collections::HashSet::new();
        for (_, _, anim_id, low, high, framerate) in &segments {
            if let Some(anim) = get_anim(*anim_id) {
                let n = anim.part_frames.len() as i32;
                if let Some(end) = last_frame(*low, *high, *framerate, n) {
                    // The start is the other end of the clamped range.
                    let lo = if *low >= n { n - 1 } else { *low };
                    let hi = if *high < 0 { n - 1 } else { (*high).min(n - 1) }.max(lo);
                    let start = if end == hi && *framerate >= 0.0 { lo } else { hi };
                    starts.insert((*anim_id, start));
                }
            }
        }
        for (kind, key, anim_id, low, high, framerate) in segments {
            if anim_id >> 24 != 0x03 {
                continue;
            }
            let Some(anim) = get_anim(anim_id) else { continue };
            let n = anim.part_frames.len() as i32;
            // A 0-fps segment never leaves a frame: nothing fires either way.
            if framerate.abs() <= 2.0e-4 {
                continue;
            }
            let Some(last) = last_frame(low, high, framerate, n) else { continue };
            if kind == "cycle" { segs_cycle += 1 } else { segs_link += 1 }
            // Only hooks the direction filter would pass: Both (0), or the
            // segment's playback direction (CSequence::execute_hooks dir).
            let seg_dir = if framerate < 0.0 { -1 } else { 1 };
            let hooks: Vec<_> = anim.part_frames[last as usize]
                .hooks
                .iter()
                .filter(|h| h.direction == 0 || h.direction == seg_dir || !(-1..=1).contains(&h.direction))
                .collect();
            if hooks.is_empty() {
                continue;
            }
            if kind == "cycle" { segs_cycle_hit += 1 } else { segs_link_hit += 1 }
            let covered = starts.contains(&(anim_id, last));
            *coverage.entry((kind, covered)).or_default() += hooks.len();
            if mt_id == 0x0900_0001 {
                player_hits.push(format!("{kind} {key} anim=0x{anim_id:08X} frame={last}/{n} [{}]",
                    hooks.iter().map(|h| hook_name(h.hook_type)).collect::<Vec<_>>().join(",")));
            }
            for h in hooks {
                *last_hooks.entry((kind, hook_name(h.hook_type))).or_default() += 1;
                if last_examples.len() < 25 && h.hook_type != 4 {
                    last_examples.push(format!(
                        "{kind} mt=0x{mt_id:08X} key={key} anim=0x{anim_id:08X} frame={last}/{n} fr={framerate:.1} hook={} dir={}",
                        hook_name(h.hook_type),
                        h.direction
                    ));
                }
            }
        }
    }

    println!("== csequence-5: cycles with more than one AnimData ==");
    println!("tables={tables} cycles={cycles} multi_anim_cycles={multi_cycles} tables_with_one={tables_with_multi}");
    for (len, count) in &multi_by_len {
        println!("  anims={len}: {count} cycles");
    }
    for e in &multi_examples {
        println!("  {e}");
    }
    println!();
    println!("== hookFrameExit: hooks on a segment's LAST frame (never fire under frame-exit) ==");
    println!(
        "cycle segments={segs_cycle} with last-frame hooks={segs_cycle_hit}; link segments={segs_link} with last-frame hooks={segs_link_hit}"
    );
    for ((kind, name), count) in &last_hooks {
        println!("  {kind:5} {name:20} {count}");
    }
    for ((kind, covered), n) in &coverage {
        println!(
            "  {kind:5} {}: {n} hooks",
            if *covered { "covered (another segment starts on that frame)" } else { "UNCOVERED" }
        );
    }
    println!("examples (AnimationDone excluded):");
    for e in &last_examples {
        println!("  {e}");
    }
    println!("player table 0x09000001: {} segments with a last-frame hook", player_hits.len());
    for e in player_hits.iter().take(40) {
        println!("  {e}");
    }
}
