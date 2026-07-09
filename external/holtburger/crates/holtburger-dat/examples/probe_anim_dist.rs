//! adversarial probe — replicate dat2hba derive_animation_forward_speed exactly
//! against the real player MT 0x09000001 for Walk/RunForward cycles.
use binrw::io::Cursor;
use holtburger_common::math::Vector3;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::{Animation, MotionTable};
use std::collections::HashMap;
use std::path::PathBuf;

const WALK_FWD: u32 = 0x4500_0005;
const RUN_FWD: u32 = 0x4400_0007;

fn dat_path() -> PathBuf {
    if let Some(p) = holtburger_dat::utils::get_portal_dat_path() {
        return p;
    }
    PathBuf::from(std::env::var("HOME").unwrap()).join("ac_base_dats/client_portal.dat")
}

// Faithful copy of dat2hba.rs:444-481 derive_animation_forward_speed.
fn derive_forward_speed(
    anims: &[(u32, f32)], // (anim_id, framerate) in order
    animations: &HashMap<u32, Animation>,
) -> Option<(f32, f32, usize)> {
    if anims.is_empty() {
        return None;
    }
    let mut offset = Vector3::new(0.0, 0.0, 0.0);
    let mut total_frames = 0usize;
    for (anim_id, _) in anims {
        let animation = animations.get(anim_id).expect("missing anim");
        for frame in &animation.pos_frames {
            offset = offset + frame.origin;
            total_frames += 1;
        }
    }
    if total_frames == 0 {
        return None;
    }
    let distance = offset.length();
    if distance == 0.0 {
        return Some((0.0, 0.0, 0));
    }
    let framerate = anims[0].1;
    Some((
        distance / total_frames as f32 * framerate,
        distance,
        total_frames,
    ))
}

fn main() {
    let dat = DatDatabase::new(&dat_path()).expect("open dat");
    let mt_bytes = dat.get_file(0x0900_0001).expect("get MT");
    let mt = MotionTable::read(&mut Cursor::new(&mt_bytes)).expect("parse MT");
    println!("MT 0x09000001 default_style=0x{:08X}", mt.default_style);

    // gather all referenced anim ids for Walk/Run cycles
    let mut needed: std::collections::HashSet<u32> = Default::default();
    for (key, md) in &mt.cycles {
        let cmd_low = key & 0xFFFF;
        if cmd_low == 0x0005 || cmd_low == 0x0007 {
            for a in &md.anims {
                needed.insert(a.anim_id);
            }
        }
    }
    let mut animations: HashMap<u32, Animation> = Default::default();
    for id in needed {
        let b = dat.get_file(id).expect("get anim");
        let a = Animation::read(&mut Cursor::new(&b)).expect("parse anim");
        animations.insert(a.id, a);
    }

    let mut walk_lines = Vec::new();
    let mut run_lines = Vec::new();
    for (key, md) in &mt.cycles {
        let stance = (key >> 16) & 0xFFFF;
        let cmd_low = key & 0xFFFF;
        if cmd_low != 0x0005 && cmd_low != 0x0007 {
            continue;
        }
        if md.velocity.is_some() {
            continue; // step-1 would have caught it
        }
        let anims: Vec<(u32, f32)> = md.anims.iter().map(|a| (a.anim_id, a.framerate)).collect();
        if let Some((speed, dist, nframes)) = derive_forward_speed(&anims, &animations) {
            let fr = anims.first().map(|a| a.1).unwrap_or(0.0);
            let line = format!(
                "  stance=0x{stance:04X} cmd=0x{:04X} speed={:.4} (dist={:.4}/{} frames *{:.1}fps) nanims={}",
                cmd_low, speed, dist, nframes, fr, md.anims.len()
            );
            if cmd_low == 0x0005 {
                walk_lines.push(line);
            } else {
                run_lines.push(line);
            }
        }
    }
    walk_lines.sort();
    run_lines.sort();
    println!("RUN_FORWARD derived speeds ({} stances):", run_lines.len());
    for l in &run_lines {
        println!("{l}");
    }
    println!("WALK_FORWARD derived speeds ({} stances):", walk_lines.len());
    for l in &walk_lines {
        println!("{l}");
    }

    // Also do the WALK_FWD/RUN_FWD via the resolve_stance(0)=default path explicitly
    println!("\n-- default-style resolve (stance=0) --");
    for (label, cmd) in [("WALK", WALK_FWD), ("RUN", RUN_FWD)] {
        if let Some(md) = mt.motion_data_for_cycle(0, cmd) {
            let anims: Vec<(u32, f32)> =
                md.anims.iter().map(|a| (a.anim_id, a.framerate)).collect();
            // ensure anims loaded
            let mut local: HashMap<u32, Animation> = Default::default();
            for (id, _) in &anims {
                if !animations.contains_key(id) {
                    let b = dat.get_file(*id).expect("get anim");
                    let a = Animation::read(&mut Cursor::new(&b)).expect("parse anim");
                    local.insert(a.id, a);
                }
            }
            for (k, v) in animations.iter() {
                local.entry(*k).or_insert_with(|| v.clone());
            }
            let r = derive_forward_speed(&anims, &local);
            println!("{label} default-stance velocity_present={} derived={:?}", md.velocity.is_some(), r);
        } else {
            println!("{label} default-stance: NO cycle");
        }
    }
}
