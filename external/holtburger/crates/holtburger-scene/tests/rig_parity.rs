//! rig.rs vs the real `poseRigAt` + three r184 `Object3D.updateMatrix`
//! (fixture: apps/holtburger-web/tools/rust_parity/gen_rig.mjs). No
//! transcendental function is involved, so every value is bit-exact: part
//! positions and quaternions (`RigSet::pose`, what the bridge writes) and the
//! local matrix of every posed part (`RigSet::pose_matrices`), in all three
//! branches (raw + posFrames, in place by mean drift, in place exact).

mod common;
use common::*;
use holtburger_scene::rig::{MATRIX_FLOATS_PER_PART, POSE_FLOATS_PER_PART, PoseMode, RigDescriptor, RigSet};
use serde_json::Value;

fn opt_f32s(v: &Value) -> Option<Vec<f32>> {
    if v.is_null() { None } else { Some(hex_f32s(v)) }
}

#[test]
fn rig_pose_matches_pose_rig_at_and_update_matrix() {
    let Some(fx) = fixture("rig") else {
        eprintln!("rig fixture missing — run node tools/rust_parity/gen_rig.mjs (from apps/holtburger-web)");
        return;
    };
    // The fixture records the pose_matrices layout (the pose is its first 7).
    assert_eq!(fx["outStride"].as_u64(), Some(MATRIX_FLOATS_PER_PART as u64), "output layout");
    let descs = fx["descs"].as_array().expect("descs");
    let mut set = RigSet::new();
    let mut ids = Vec::new();
    for d in descs {
        let name = d["name"].as_str().unwrap_or("?");
        let pc = d["partCount"].as_u64().unwrap() as u32;
        let nf = d["numFrames"].as_u64().unwrap() as u32;
        let rd = RigDescriptor::new(pc, nf, hex_f32s(&d["partFrames"]), opt_f32s(&d["posFrames"]), opt_f32s(&d["rootFrames"]))
            .unwrap_or_else(|| panic!("{name}: descriptor rejected"));
        // A rootFrames of the wrong length is dropped, as poseInPlaceExact
        // refuses it (→ mean drift).
        let want_root = d["rootFrames"].as_array().is_some_and(|a| a.len() == nf as usize * 7);
        assert_eq!(rd.has_root_frames(), want_root, "{name}: root frames kept");
        ids.push(set.register(rd));
    }
    assert_eq!(set.len(), descs.len());
    let poses = fx["poses"].as_array().expect("poses");
    assert!(poses.len() >= 100, "fixture too small: {}", poses.len());
    let mut parts_checked = 0usize;
    let mut nan_parts = 0usize;
    for (i, ps) in poses.iter().enumerate() {
        let di = ps["desc"].as_u64().unwrap() as usize;
        let name = descs[di]["name"].as_str().unwrap_or("?");
        let frame = ps["frame"].as_u64().unwrap() as u32;
        let mode = ps["mode"].as_u64().unwrap() as u32;
        let n = ps["n"].as_u64().unwrap() as u32;
        assert!(PoseMode::from_u32(mode).is_some());
        let what = format!("pose #{i} ({name}, global {}, frame {frame}, mode {mode}, n {n})", ps["globalFrame"]);
        let parts = ps["parts"].as_array().unwrap();
        // The bridge's call: position + quaternion.
        assert_eq!(set.pose(ids[di], frame, mode, n), n, "{what}: parts written");
        let out = set.out();
        for part in parts {
            let p = part[0].as_u64().unwrap() as usize;
            let want = hex_f64s(&part[1]);
            let got = &out[p * POSE_FLOATS_PER_PART..(p + 1) * POSE_FLOATS_PER_PART];
            assert_bits_eq(&format!("{what} part {p} pose"), got, &want[..POSE_FLOATS_PER_PART]);
            if want.iter().any(|v| v.is_nan()) {
                nan_parts += 1;
            }
            parts_checked += 1;
        }
        // The same pose with three's local matrices.
        assert_eq!(set.pose_matrices(ids[di], frame, mode, n), n, "{what}: parts written (matrices)");
        let out = set.out();
        for part in parts {
            let p = part[0].as_u64().unwrap() as usize;
            let want = hex_f64s(&part[1]);
            let got = &out[p * MATRIX_FLOATS_PER_PART..(p + 1) * MATRIX_FLOATS_PER_PART];
            assert_bits_eq(&format!("{what} part {p} matrix"), got, &want);
        }
    }
    assert!(parts_checked > 1000, "parts checked: {parts_checked}");
    // The empty / short posFrames cases must actually have produced NaN poses.
    assert!(nan_parts > 0, "no NaN case exercised");
}
