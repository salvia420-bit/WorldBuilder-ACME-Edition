//! P11 (2026-07-04) — survey every MotionTable's Dead (0x11) cycles for
//! freeze-frame (fr≈0) and PAST-END (low_frame >= anim.num_frames) authoring,
//! quantifying the blast radius of the retail frame-range clamp fix
//! (AnimSequenceNode::set_animation_id, acclient.c:341108-341127).
use binrw::io::Cursor;
use holtburger_dat::file_type::{Animation, MotionTable};
use holtburger_dat::DatDatabase;

fn main() {
    let db = DatDatabase::new("/home/wbterminal/ac_base_dats/client_portal.dat").unwrap();
    let mut mt_ids: Vec<u32> = db.files.keys().copied().filter(|id| id >> 24 == 0x09).collect();
    mt_ids.sort();
    let (mut tables, mut with_dead, mut freeze, mut past_end, mut anim_missing) =
        (0usize, 0usize, 0usize, 0usize, 0usize);
    let mut past_end_examples: Vec<String> = Vec::new();
    for mt_id in mt_ids {
        let Ok(bytes) = db.get_file(mt_id) else { continue };
        let Ok(mt) = MotionTable::read(&mut Cursor::new(&bytes)) else { continue };
        tables += 1;
        let mut this_dead = false;
        let mut this_freeze = false;
        let mut this_past = false;
        for (key, md) in &mt.cycles {
            if key & 0xFFFF != 0x11 {
                continue;
            }
            this_dead = true;
            for ad in &md.anims {
                if ad.framerate.abs() <= 2.0e-4 {
                    this_freeze = true;
                }
                if ad.anim_id >> 24 != 0x03 {
                    continue;
                }
                let Ok(ab) = db.get_file(ad.anim_id) else { anim_missing += 1; continue };
                let Ok(anim) = Animation::read(&mut Cursor::new(&ab)) else { continue };
                let n = anim.part_frames.len() as i32;
                if ad.low_frame >= n {
                    this_past = true;
                    if past_end_examples.len() < 12 {
                        past_end_examples.push(format!(
                            "mt=0x{mt_id:08X} key=0x{key:X} anim=0x{:08X} low={} n={} fr={}",
                            ad.anim_id, ad.low_frame, n, ad.framerate
                        ));
                    }
                }
            }
        }
        if this_dead { with_dead += 1; }
        if this_freeze { freeze += 1; }
        if this_past { past_end += 1; }
    }
    println!("tables={tables} with_dead_cycle={with_dead} freeze_frame_dead={freeze} PAST_END_dead={past_end} anim_missing={anim_missing}");
    for e in past_end_examples { println!("  {e}"); }
}
