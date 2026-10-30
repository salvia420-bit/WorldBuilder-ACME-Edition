//! three.js r184 functions the particle kernel needs that `crate::math` does
//! not have yet. Each body is copied from node_modules/three/src/math/*.js in
//! the same operation order (candidates to move into math.rs + gen_math.mjs).

use crate::math::{Mat4, Quat, Vec3};

/// `Vector3.addScaledVector(v, s)`: `this.x += v.x * s` (component-wise).
#[inline]
pub fn add_scaled(a: Vec3, v: Vec3, s: f64) -> Vec3 {
    Vec3::new(a.x + v.x * s, a.y + v.y * s, a.z + v.z * s)
}

/// `Quaternion.setFromUnitVectors(vFrom, vTo)` (then `normalize()`).
pub fn quat_from_unit_vectors(v_from: Vec3, v_to: Vec3) -> Quat {
    // let r = vFrom.dot( vTo ) + 1;
    let mut r = v_from.dot(v_to) + 1.0;
    let q = if r < 1e-8 {
        // vFrom and vTo point in opposite directions
        r = 0.0;
        if v_from.x.abs() > v_from.z.abs() {
            Quat::new(-v_from.y, v_from.x, 0.0, r)
        } else {
            Quat::new(0.0, -v_from.z, v_from.y, r)
        }
    } else {
        Quat::new(
            v_from.y * v_to.z - v_from.z * v_to.y,
            v_from.z * v_to.x - v_from.x * v_to.z,
            v_from.x * v_to.y - v_from.y * v_to.x,
            r,
        )
    };
    q.normalize()
}

/// `Matrix4.makeBasis(xAxis, yAxis, zAxis)` (`set()` is row-major; the
/// elements array is column-major).
#[inline]
pub fn make_basis(x: Vec3, y: Vec3, z: Vec3) -> Mat4 {
    Mat4::from_elements([
        x.x, x.y, x.z, 0.0, //
        y.x, y.y, y.z, 0.0, //
        z.x, z.y, z.z, 0.0, //
        0.0, 0.0, 0.0, 1.0,
    ])
}

/// ECMAScript ToInt32 (`x | 0`).
pub fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    let t = x.trunc();
    // modulo 2^32 into [0, 2^32), then reinterpret as i32
    let m = t.rem_euclid(4_294_967_296.0);
    (m as u64 as u32) as i32
}

/// ECMAScript ToUint32 (`x >>> 0`).
pub fn to_uint32(x: f64) -> u32 {
    to_int32(x) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn int32_conversions() {
        assert_eq!(to_int32(3.9), 3);
        assert_eq!(to_int32(-3.9), -3);
        assert_eq!(to_int32(f64::NAN), 0);
        assert_eq!(to_int32(4_294_967_295.0), -1);
        assert_eq!(to_uint32(-1.0), 4_294_967_295);
        assert_eq!(to_int32(2_147_483_648.0), -2_147_483_648);
    }

    #[test]
    fn unit_vectors_identity_and_opposite() {
        let z = Vec3::new(0.0, 0.0, 1.0);
        let q = quat_from_unit_vectors(z, z);
        assert_eq!((q.x, q.y, q.z, q.w), (0.0, 0.0, 0.0, 1.0));
        let q2 = quat_from_unit_vectors(z, Vec3::new(0.0, 0.0, -1.0));
        assert_eq!(q2.w, 0.0);
    }
}
