//! math.rs vs three.js r184 (fixture: tools/rust_parity/gen_math.mjs).
//! Everything is bit-exact except the sin/cos-derived quaternions.

mod common;
use common::*;
use holtburger_scene::math::{Mat4, Quat, Vec3};

fn v3(a: &[f64]) -> Vec3 { Vec3::new(a[0], a[1], a[2]) }
fn q4(a: &[f64]) -> Quat { Quat::new(a[0], a[1], a[2], a[3]) }

#[test]
fn math_matches_three_r184() {
    let Some(fx) = fixture("math") else {
        eprintln!("math fixture missing — run node tools/rust_parity/gen_math.mjs");
        return;
    };
    let cases = fx["cases"].as_array().unwrap();
    assert!(cases.len() >= 100);
    for (i, c) in cases.iter().enumerate() {
        let p = v3(&hex_f64s(&c["p"]));
        let q = q4(&hex_f64s(&c["q"]));
        let s = v3(&hex_f64s(&c["s"]));
        let q2 = q4(&hex_f64s(&c["q2"]));
        let v = v3(&hex_f64s(&c["v"]));
        let m = Mat4::compose(p, q, s);
        assert_bits_eq(&format!("#{i} compose"), &m.e, &hex_f64s(&c["compose"]));
        let m2 = Mat4::compose(v, q2, Vec3::ONE);
        assert_bits_eq(&format!("#{i} compose2"), &m2.e, &hex_f64s(&c["compose2"]));
        assert_bits_eq(&format!("#{i} mul"), &m.mul(&m2).e, &hex_f64s(&c["mul"]));
        assert_bits_eq(&format!("#{i} invert"), &m.invert().e, &hex_f64s(&c["invert"]));
        assert_bits_eq(&format!("#{i} det"), &[m.determinant()], &[hex_f64(&c["det"])]);
        let (dp, dq, ds) = m.decompose();
        assert_bits_eq(&format!("#{i} decompose"), &[dp.x, dp.y, dp.z, dq.x, dq.y, dq.z, dq.w, ds.x, ds.y, ds.z], &hex_f64s(&c["decompose"]));
        let qq = q.mul(q2);
        assert_bits_eq(&format!("#{i} qmul"), &[qq.x, qq.y, qq.z, qq.w], &hex_f64s(&c["qmul"]));
        let qn = q4(&hex_f64s(&c["qnIn"])).normalize();
        assert_bits_eq(&format!("#{i} qnorm"), &[qn.x, qn.y, qn.z, qn.w], &hex_f64s(&c["qnorm"]));
        let vq = v.apply_quat(q);
        assert_bits_eq(&format!("#{i} applyQuat"), &[vq.x, vq.y, vq.z], &hex_f64s(&c["applyQuat"]));
        let vm = v.apply_mat4(&m);
        assert_bits_eq(&format!("#{i} applyMat4"), &[vm.x, vm.y, vm.z], &hex_f64s(&c["applyMat4"]));
        let vn = v.normalize();
        assert_bits_eq(&format!("#{i} vnorm"), &[vn.x, vn.y, vn.z], &hex_f64s(&c["vnorm"]));
        assert_bits_eq(&format!("#{i} maxScale"), &[m.max_scale_on_axis()], &[hex_f64(&c["maxScale"])]);
        // sin/cos: V8 fdlibm vs the host libm differ by an ulp now and then; unit
        // quaternion components, so compare absolutely (a few ulps of 1.0).
        let axis = v3(&hex_f64s(&c["axis"]));
        let qa = Quat::from_axis_angle(axis, hex_f64(&c["angle"]));
        assert_abs(&format!("#{i} axisAngle"), &[qa.x, qa.y, qa.z, qa.w], &hex_f64s(&c["axisAngle"]), 1e-15);
        let e = hex_f64s(&c["eul"]);
        let qe = Quat::from_euler_yxz(e[0], e[1], e[2]);
        assert_abs(&format!("#{i} eulerYXZ"), &[qe.x, qe.y, qe.z, qe.w], &hex_f64s(&c["eulerYXZ"]), 1e-15);
        let qx = Quat::from_euler_xyz(e[0], e[1], e[2]);
        assert_abs(&format!("#{i} eulerXYZ"), &[qx.x, qx.y, qx.z, qx.w], &hex_f64s(&c["eulerXYZ"]), 1e-15);
    }
}
