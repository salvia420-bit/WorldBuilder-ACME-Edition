//! cull.rs vs three.js r184 and the JS statics walk (fixture:
//! apps/holtburger-web/tools/rust_parity/gen_cull.mjs). No transcendental
//! function is involved, so plane coefficients, distances and verdicts are
//! all bit-exact: `Frustum.setFromProjectionMatrix` over real FrustumCuller
//! MVPs (perspective / orthographic, WebGL / WebGPU, reversed depth on and
//! off), `intersectsSphere` incl. exact plane-boundary spheres,
//! statics.js `_cullStaticsWalk`'s verdicts with the `?cullDist` horizon —
//! through the pure function AND through the `StaticsCull` registry the wasm
//! bridge drives —, degenerate matrices, invalid coordinate systems,
//! `Plane.normalize` / `distanceToPoint` and `Sphere.applyMatrix4`.

mod common;
use common::*;
use holtburger_scene::cull::*;
use holtburger_scene::math::{Mat4, Vec3};
use serde_json::Value;

fn mat(v: &Value) -> Mat4 {
    let e: [f64; 16] = hex_f64s(v).try_into().expect("16 matrix elements");
    Mat4::from_elements(e)
}

fn bits(v: &Value) -> Vec<bool> {
    v.as_str().expect("bit string").chars().map(|c| c == '1').collect()
}

fn spheres(v: &Value) -> Vec<(Vec3, f64)> {
    hex_f64s(v).chunks_exact(4).map(|s| (Vec3::new(s[0], s[1], s[2]), s[3])).collect()
}

fn cs_rev(c: &Value) -> (u32, bool) {
    (c["cs"].as_u64().expect("cs") as u32, c["rev"].as_bool().expect("rev"))
}

#[test]
fn frustum_planes_and_intersects_sphere_match_three_r184() {
    let Some(fx) = fixture("cull") else {
        eprintln!("cull fixture missing — run node tools/rust_parity/gen_cull.mjs (from apps/holtburger-web)");
        return;
    };
    let cases = fx["frustums"].as_array().expect("frustums");
    assert!(cases.len() >= 100, "fixture too small: {}", cases.len());
    let (mut kept, mut tested) = (0usize, 0usize);
    let mut seen = Vec::new();
    for (i, c) in cases.iter().enumerate() {
        let (cs, rev) = cs_rev(c);
        if !seen.contains(&(cs, rev)) {
            seen.push((cs, rev));
        }
        let f = Frustum::from_projection_matrix(&mat(&c["mvp"]), cs, rev).unwrap_or_else(|| panic!("#{i}: no frustum"));
        assert_bits_eq(&format!("#{i} planes (cs {cs}, rev {rev})"), &f.to_array(), &hex_f64s(&c["planes"]));
        let want = bits(&c["inter"]);
        let sph = spheres(&c["spheres"]);
        assert_eq!(sph.len(), want.len(), "#{i}: sphere count");
        for (k, ((center, r), w)) in sph.iter().zip(&want).enumerate() {
            assert_eq!(f.intersects_sphere(*center, *r), *w, "#{i} sphere {k}: {center:?} r {r:e}");
            tested += 1;
            if *w {
                kept += 1;
            }
        }
    }
    assert!(kept > tested / 5 && kept < tested * 4 / 5, "verdict mix {kept}/{tested}");
    for want in [(2000, false), (2001, false), (2000, true), (2001, true)] {
        assert!(seen.contains(&want), "no case for {want:?}");
    }
}

#[test]
fn statics_walk_verdicts_match_the_js_walk_with_the_horizon() {
    let Some(fx) = fixture("cull") else {
        eprintln!("cull fixture missing — run node tools/rust_parity/gen_cull.mjs (from apps/holtburger-web)");
        return;
    };
    let cases = fx["statics"].as_array().expect("statics");
    assert!(cases.len() >= 100, "fixture too small: {}", cases.len());
    let (mut kept, mut tested) = (0usize, 0usize);
    for (i, c) in cases.iter().enumerate() {
        let (cs, rev) = cs_rev(c);
        let mvp = mat(&c["mvp"]);
        let f = Frustum::from_projection_matrix(&mvp, cs, rev).expect("frustum");
        let cam = {
            let v = hex_f64s(&c["cam"]);
            Vec3::new(v[0], v[1], v[2])
        };
        let dist_on = c["distOn"].as_bool().expect("distOn");
        assert!(dist_on, "the generator arms ?cullDist");
        let horizon = hex_f64(&c["horizon"]);
        let want = bits(&c["want"]);
        let sph = spheres(&c["spheres"]);
        assert_eq!(sph.len(), want.len(), "#{i}: node count");

        // 1. The pure per-node verdict.
        for (k, ((center, r), w)) in sph.iter().zip(&want).enumerate() {
            assert_eq!(statics_sphere_visible(&f, *center, *r, cam, dist_on, horizon), *w, "#{i} node {k}: {center:?} r {r:e}");
            tested += 1;
            if *w {
                kept += 1;
            }
        }

        // 2. The registry the bridge drives: one record per node, one frame.
        let mut k = StaticsCull::new();
        let mut recs = Vec::with_capacity(sph.len() * RECORD_LEN);
        for (slot, (center, r)) in sph.iter().enumerate() {
            recs.extend_from_slice(&[slot as f64, 1.0, center.x, center.y, center.z, *r]);
        }
        assert_eq!(k.apply_records(&recs), Some(sph.len()));
        let inp = k.input_mut();
        inp[IN_MVP..IN_MVP + 16].copy_from_slice(&mvp.e);
        inp[IN_CAM] = cam.x;
        inp[IN_CAM + 1] = cam.y;
        inp[IN_CAM + 2] = cam.z;
        inp[IN_COORDINATE_SYSTEM] = cs as f64;
        inp[IN_REVERSED_DEPTH] = if rev { 1.0 } else { 0.0 };
        inp[IN_DIST_ENABLED] = 1.0;
        inp[IN_HORIZON] = horizon;
        assert_eq!(k.frame(), Some(sph.len()));
        assert_bits_eq(&format!("#{i} registry planes"), &k.frustum().to_array(), &f.to_array());
        for (slot, w) in want.iter().enumerate() {
            assert_eq!(k.visible(slot), *w, "#{i} slot {slot}");
        }

        // The JS walk's counters: every node tested, `culled` = the hidden ones.
        let culled = want.iter().filter(|w| !**w).count();
        assert_eq!(c["tested"].as_u64(), Some(sph.len() as u64), "#{i} tested");
        assert_eq!(c["culled"].as_u64(), Some(culled as u64), "#{i} culled");
        assert_eq!(k.last_counts(), (sph.len() as u32, (sph.len() - culled) as u32), "#{i} kernel counts");
    }
    assert!(kept > tested / 10 && kept < tested * 9 / 10, "verdict mix {kept}/{tested}");
}

#[test]
fn degenerate_matrices_and_invalid_coordinate_systems() {
    let Some(fx) = fixture("cull") else {
        eprintln!("cull fixture missing — run node tools/rust_parity/gen_cull.mjs (from apps/holtburger-web)");
        return;
    };
    let cases = fx["degenerate"].as_array().expect("degenerate");
    assert!(cases.len() >= 10);
    let mut throws = 0;
    for (i, c) in cases.iter().enumerate() {
        let (cs, rev) = cs_rev(c);
        let got = Frustum::from_projection_matrix(&mat(&c["mvp"]), cs, rev);
        if c["throws"].as_bool() == Some(true) {
            assert!(got.is_none(), "degenerate #{i}: three throws (cs {cs}, rev {rev}), Rust must refuse");
            throws += 1;
            continue;
        }
        let f = got.unwrap_or_else(|| panic!("degenerate #{i}: refused a frustum three builds (cs {cs}, rev {rev})"));
        assert_bits_eq(&format!("degenerate #{i} planes"), &f.to_array(), &hex_f64s(&c["planes"]));
        let want = bits(&c["inter"]);
        for (k, ((center, r), w)) in spheres(&c["spheres"]).iter().zip(&want).enumerate() {
            assert_eq!(f.intersects_sphere(*center, *r), *w, "degenerate #{i} sphere {k}");
        }
    }
    assert!(throws > 0, "no throwing case exercised");
}

#[test]
fn plane_normalize_distance_and_sphere_apply_matrix4() {
    let Some(fx) = fixture("cull") else {
        eprintln!("cull fixture missing — run node tools/rust_parity/gen_cull.mjs (from apps/holtburger-web)");
        return;
    };
    let planes = fx["planes"].as_array().expect("planes");
    assert!(planes.len() >= 50);
    for (i, c) in planes.iter().enumerate() {
        let comp = hex_f64s(&c["comp"]);
        let p = Plane::from_components(comp[0], comp[1], comp[2], comp[3]).normalize();
        assert_bits_eq(&format!("plane #{i}"), &p.to_array(), &hex_f64s(&c["plane"]));
        let pts = hex_f64s(&c["points"]);
        let dist: Vec<f64> = pts.chunks_exact(3).map(|q| p.distance_to_point(Vec3::new(q[0], q[1], q[2]))).collect();
        assert_bits_eq(&format!("plane #{i} distances"), &dist, &hex_f64s(&c["dist"]));
    }
    let sa = fx["sphereApply"].as_array().expect("sphereApply");
    assert!(sa.len() >= 50);
    for (i, c) in sa.iter().enumerate() {
        let cen = hex_f64s(&c["c"]);
        let s = Sphere::new(Vec3::new(cen[0], cen[1], cen[2]), hex_f64(&c["r"])).apply_mat4(&mat(&c["m"]));
        assert_bits_eq(&format!("sphere #{i}"), &[s.center.x, s.center.y, s.center.z, s.radius], &hex_f64s(&c["out"]));
    }
}
