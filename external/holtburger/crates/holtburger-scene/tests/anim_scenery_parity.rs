//! anim_scenery.rs vs the real animated_scenery.js + three r184 AnimationMixer
//! (fixture: apps/holtburger-web/tools/rust_parity/gen_anim_scenery.mjs).
//!
//! Exact: clip times and durations, action / mixer clocks, orbit angles, every
//! template-part POSITION (pure lerp), and every quaternion of clips whose
//! keyframes never take `slerpFlat`'s acos/sin branch ("creep", "still": the
//! lerp-and-normalize branch and sample copies are sqrt-only). Within 1e-15
//! absolute (unit quaternion components, V8 fdlibm vs host libm): quaternions
//! through the slerp branch and the orbit quaternion (`setFromAxisAngle`).
//! Within 1 f32 ulp: pose-table rows (they carry those quaternions).
#![cfg(feature = "lane-anim-scenery")]

mod common;
use common::*;
use holtburger_scene::anim_scenery::{AnimScenery, Clip, GROUP_STRIDE, Group, Omega, PART_STRIDE, ROW_FLOATS};
use holtburger_scene::math::{Mat4, Vec3};
use serde_json::Value;
use std::collections::HashMap;

fn mat_opt(v: &Value) -> Option<Mat4> {
    if v.is_null() {
        return None;
    }
    let e = hex_f64s(v);
    let mut a = [0.0f64; 16];
    a.copy_from_slice(&e[..16]);
    Some(Mat4::from_elements(a))
}

#[test]
fn clips_match_three_animation_mixer() {
    let Some(fx) = fixture("anim_scenery") else {
        eprintln!("anim_scenery fixture missing — run node tools/rust_parity/gen_anim_scenery.mjs (from apps/holtburger-web)");
        return;
    };
    let clips = fx["clips"].as_array().expect("clips");
    assert!(clips.len() >= 6);
    for c in clips {
        let name = c["name"].as_str().unwrap_or("?");
        let trig_free = name.starts_with("creep") || name.starts_with("still");
        let frames = hex_f32s(&c["frames"]);
        let np = c["numParts"].as_u64().unwrap() as usize;
        let nf = c["numFrames"].as_u64().unwrap() as usize;
        let fps = hex_f64(&c["fps"]);
        let closed = c["closedLoop"].as_bool().unwrap();
        let clip = Clip::build(&frames, np, nf, fps, closed).unwrap_or_else(|| panic!("{name}: clip refused"));
        assert_bits_eq(&format!("{name} duration"), &[clip.duration], &[hex_f64(&c["duration"])]);
        let times: Vec<f64> = clip.times.iter().map(|&t| t as f64).collect();
        let want: Vec<f64> = hex_f32s(&c["times"]).iter().map(|&t| t as f64).collect();
        assert_bits_eq(&format!("{name} times"), &times, &want);
        let mut g = Group::new(0, clip, None);
        for (i, s) in c["steps"].as_array().unwrap().iter().enumerate() {
            g.step(hex_f64(&s["dt"]), 15.0);
            assert_bits_eq(&format!("{name}#{i} action time"), &[g.time], &[hex_f64(&s["time"])]);
            assert_bits_eq(&format!("{name}#{i} mixer time"), &[g.mixer_time], &[hex_f64(&s["mixerTime"])]);
            let want = hex_f64s(&s["parts"]);
            for p in 0..np {
                let w = &want[p * 7..p * 7 + 7];
                assert_bits_eq(&format!("{name}#{i} part {p} position"), &g.obj_pos[p * 3..p * 3 + 3], &w[..3]);
                let q = &g.obj_quat[p * 4..p * 4 + 4];
                if trig_free {
                    assert_bits_eq(&format!("{name}#{i} part {p} quaternion"), q, &w[3..]);
                } else {
                    assert_abs(&format!("{name}#{i} part {p} quaternion"), q, &w[3..], 1e-15);
                }
            }
        }
    }
}

#[test]
fn module_frames_match_animated_scenery() {
    let Some(fx) = fixture("anim_scenery") else {
        eprintln!("anim_scenery fixture missing — run node tools/rust_parity/gen_anim_scenery.mjs (from apps/holtburger-web)");
        return;
    };
    let m = &fx["module"];
    let events = m["events"].as_array().expect("events");
    let frames = m["frames"].as_array().expect("frames");
    let mut k = AnimScenery::new();
    let mut handles: HashMap<u32, (u32, usize)> = HashMap::new(); // key -> (handle, numParts)
    let mut row_keys: Vec<(u32, usize)> = Vec::new();
    let mut frames_seen = 0usize;
    let mut row_ulps_max = 0u32;
    // The fixture snapshots a frame AFTER the module loop's reclaim, while the
    // groups that reclaim disposed are unregistered by the events recorded
    // right after the frame (phase "afterFrame": the JS advanced them and
    // wrote their rows in that frame, then disposed them). So the live-group
    // set is checked once those events are applied.
    let mut pending_live: Option<(usize, Vec<u32>)> = None;
    let check_live = |pending: &mut Option<(usize, Vec<u32>)>, handles: &HashMap<u32, (u32, usize)>| {
        if let Some((pf, want)) = pending.take() {
            let mut live: Vec<u32> = handles.keys().copied().collect();
            live.sort_unstable();
            assert_eq!(live, want, "frame {pf}: live groups once the frame's disposals are applied");
        }
    };
    for ev in events {
        if ev["phase"].as_str() != Some("afterFrame") {
            check_live(&mut pending_live, &handles);
        }
        match ev["kind"].as_str().unwrap() {
            "registerGroup" => {
                let key = ev["key"].as_u64().unwrap() as u32;
                let np = ev["numParts"].as_u64().unwrap() as usize;
                let nf = ev["numFrames"].as_u64().unwrap() as usize;
                let omega = if ev["omega"].is_null() {
                    None
                } else {
                    let o = hex_f64s(&ev["omega"]);
                    Some(Omega { axis: Vec3::new(o[0], o[1], o[2]), rad: o[3] })
                };
                let h = k.register_group(key, &hex_f32s(&ev["frames"]), np, nf, hex_f64(&ev["fps"]), ev["closedLoop"].as_bool().unwrap(), omega);
                assert!(h != 0, "group 0x{key:08x} refused");
                handles.insert(key, (h, np));
            }
            "unregisterGroup" => {
                let key = ev["key"].as_u64().unwrap() as u32;
                let (h, _) = handles.remove(&key).expect("unregister of an unknown group");
                assert!(k.unregister_group(h));
            }
            "registerRow" => {
                let key = ev["key"].as_u64().unwrap() as u32;
                let part = ev["part"].as_u64().unwrap() as usize;
                let idx = k.register_row(key, part, mat_opt(&ev["post"]), mat_opt(&ev["init"]));
                assert_eq!(idx as u64 + 1, ev["row"].as_u64().unwrap(), "row lockstep");
                row_keys.push((key, part));
            }
            "frame" => {
                let f = ev["frame"].as_u64().unwrap() as usize;
                let fr = &frames[f];
                assert_eq!(fr["frame"].as_u64().unwrap() as usize, f);
                let written = k.advance(hex_f64(&fr["dt"]), hex_f64(&fr["omegaHz"]));
                frames_seen += 1;
                // Rows: written exactly where _updateGpuPoseRows writes them.
                let mut want_written = 0u32;
                for (ri, (key, part)) in row_keys.iter().enumerate() {
                    let w = handles.get(key).is_some_and(|&(_, np)| *part < np);
                    assert_eq!(k.rows_written()[ri] == 1, w, "frame {f} row {} written flag", ri + 1);
                    if w {
                        want_written += 1;
                    }
                }
                assert_eq!(written, want_written, "frame {f} rows written");
                // Every row's content (written or kept) is the table's.
                let rows = fr["rows"].as_array().unwrap();
                assert_eq!(rows.len(), row_keys.len(), "frame {f} row count");
                for (ri, r) in rows.iter().enumerate() {
                    let want = hex_f32s(r);
                    let got = &k.rows_out()[ri * ROW_FLOATS..(ri + 1) * ROW_FLOATS];
                    for (i, (g, w)) in got.iter().zip(&want).enumerate() {
                        let d = ulps_f32(*g, *w);
                        assert!(d <= 1, "frame {f} row {} [{i}]: got {g:e} want {w:e} ({d} ulps)", ri + 1);
                        row_ulps_max = row_ulps_max.max(d);
                    }
                }
                // Template parts, orbit, clocks of every group still live
                // after the frame (see `pending_live`).
                let groups = fr["groups"].as_object().unwrap();
                let mut want_live: Vec<u32> = Vec::new();
                for (key_s, gv) in groups {
                    let key: u32 = key_s.parse().unwrap();
                    want_live.push(key);
                    let (h, np) = *handles.get(&key).unwrap_or_else(|| panic!("frame {f}: group 0x{key:08x} not registered"));
                    let off = k.parts_offset(h) as usize;
                    let slot = k.slot_of(h) as usize;
                    let want = hex_f64s(&gv["parts"]);
                    for p in 0..np {
                        let got = &k.parts_out()[off + p * PART_STRIDE..off + (p + 1) * PART_STRIDE];
                        let w = &want[p * 7..p * 7 + 7];
                        assert_bits_eq(&format!("frame {f} 0x{key:08x} part {p} position"), &got[..3], &w[..3]);
                        assert_abs(&format!("frame {f} 0x{key:08x} part {p} quaternion"), &got[3..], &w[3..], 1e-15);
                    }
                    let go = &k.group_out()[slot * GROUP_STRIDE..(slot + 1) * GROUP_STRIDE];
                    assert_abs(&format!("frame {f} 0x{key:08x} orbit"), &go[..4], &hex_f64s(&gv["orbit"]), 1e-15);
                    assert_bits_eq(&format!("frame {f} 0x{key:08x} orbit angle"), &go[4..5], &[hex_f64(&gv["orbitAngle"])]);
                }
                want_live.sort_unstable();
                pending_live = Some((f, want_live));
            }
            other => panic!("unknown event {other}"),
        }
    }
    check_live(&mut pending_live, &handles);
    assert_eq!(frames_seen, frames.len(), "every recorded frame replayed");
    eprintln!("anim_scenery module: {frames_seen} frames, max row diff {row_ulps_max} f32 ulp");
}
