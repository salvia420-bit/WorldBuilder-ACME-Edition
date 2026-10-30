//! three.js r184 math, operation for operation.
//!
//! Every function here mirrors the named three.js method (node_modules/three
//! 0.184.0, src/math/*.js) in the same operation order, in f64, so a kernel
//! built on it reproduces the JS it replaces bit for bit. When you add a
//! function, copy the three.js body; do not "simplify" an expression (`a * (1
//! / s)` and `a / s` are different floats).
//!
//! Layout matches three.js: [`Mat4::e`] is column-major, exactly
//! `Matrix4.elements`.

/// `THREE.Vector3`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// `THREE.Quaternion` (x, y, z, w).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Quat {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub w: f64,
}

/// `THREE.Matrix4`; `e` is `Matrix4.elements` (column-major).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mat4 {
    pub e: [f64; 16],
}

impl Default for Quat {
    fn default() -> Self {
        Quat::IDENTITY
    }
}

impl Default for Mat4 {
    fn default() -> Self {
        Mat4::IDENTITY
    }
}

impl Vec3 {
    pub const ZERO: Vec3 = Vec3 { x: 0.0, y: 0.0, z: 0.0 };
    pub const ONE: Vec3 = Vec3 { x: 1.0, y: 1.0, z: 1.0 };

    #[inline]
    pub const fn new(x: f64, y: f64, z: f64) -> Vec3 {
        Vec3 { x, y, z }
    }

    /// `Vector3.add`.
    #[inline]
    pub fn add(self, v: Vec3) -> Vec3 {
        Vec3::new(self.x + v.x, self.y + v.y, self.z + v.z)
    }

    /// `Vector3.sub`.
    #[inline]
    pub fn sub(self, v: Vec3) -> Vec3 {
        Vec3::new(self.x - v.x, self.y - v.y, self.z - v.z)
    }

    /// `Vector3.multiply` (component-wise).
    #[inline]
    pub fn mul(self, v: Vec3) -> Vec3 {
        Vec3::new(self.x * v.x, self.y * v.y, self.z * v.z)
    }

    /// `Vector3.multiplyScalar`.
    #[inline]
    pub fn scale(self, s: f64) -> Vec3 {
        Vec3::new(self.x * s, self.y * s, self.z * s)
    }

    /// `Vector3.divideScalar` = `multiplyScalar(1 / scalar)`.
    #[inline]
    pub fn div_scalar(self, s: f64) -> Vec3 {
        self.scale(1.0 / s)
    }

    /// `Vector3.dot`.
    #[inline]
    pub fn dot(self, v: Vec3) -> f64 {
        self.x * v.x + self.y * v.y + self.z * v.z
    }

    /// `Vector3.crossVectors(self, v)`.
    #[inline]
    pub fn cross(self, v: Vec3) -> Vec3 {
        let (ax, ay, az) = (self.x, self.y, self.z);
        let (bx, by, bz) = (v.x, v.y, v.z);
        Vec3::new(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx)
    }

    /// `Vector3.lengthSq`.
    #[inline]
    pub fn length_sq(self) -> f64 {
        self.x * self.x + self.y * self.y + self.z * self.z
    }

    /// `Vector3.length`.
    #[inline]
    pub fn length(self) -> f64 {
        (self.x * self.x + self.y * self.y + self.z * self.z).sqrt()
    }

    /// `Vector3.normalize` = `divideScalar(this.length() || 1)`. JS `||`
    /// replaces both 0 and NaN with 1.
    #[inline]
    pub fn normalize(self) -> Vec3 {
        let l = self.length();
        let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
        self.div_scalar(l)
    }

    /// `Vector3.distanceToSquared`.
    #[inline]
    pub fn distance_to_squared(self, v: Vec3) -> f64 {
        let dx = self.x - v.x;
        let dy = self.y - v.y;
        let dz = self.z - v.z;
        dx * dx + dy * dy + dz * dz
    }

    /// `Vector3.applyQuaternion` (q assumed unit length).
    #[inline]
    pub fn apply_quat(self, q: Quat) -> Vec3 {
        let (vx, vy, vz) = (self.x, self.y, self.z);
        let (qx, qy, qz, qw) = (q.x, q.y, q.z, q.w);
        // t = 2 * cross( q.xyz, v );
        let tx = 2.0 * (qy * vz - qz * vy);
        let ty = 2.0 * (qz * vx - qx * vz);
        let tz = 2.0 * (qx * vy - qy * vx);
        // v + q.w * t + cross( q.xyz, t );
        Vec3::new(
            vx + qw * tx + qy * tz - qz * ty,
            vy + qw * ty + qz * tx - qx * tz,
            vz + qw * tz + qx * ty - qy * tx,
        )
    }

    /// `Vector3.applyMatrix4` (with the perspective divide).
    #[inline]
    pub fn apply_mat4(self, m: &Mat4) -> Vec3 {
        let (x, y, z) = (self.x, self.y, self.z);
        let e = &m.e;
        let w = 1.0 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
        Vec3::new(
            (e[0] * x + e[4] * y + e[8] * z + e[12]) * w,
            (e[1] * x + e[5] * y + e[9] * z + e[13]) * w,
            (e[2] * x + e[6] * y + e[10] * z + e[14]) * w,
        )
    }
}

impl Quat {
    pub const IDENTITY: Quat = Quat { x: 0.0, y: 0.0, z: 0.0, w: 1.0 };

    #[inline]
    pub const fn new(x: f64, y: f64, z: f64, w: f64) -> Quat {
        Quat { x, y, z, w }
    }

    /// `Quaternion.multiplyQuaternions(a, b)`; `a.mul(b)` is `a.multiply(b)`.
    #[inline]
    pub fn mul(self, b: Quat) -> Quat {
        let (qax, qay, qaz, qaw) = (self.x, self.y, self.z, self.w);
        let (qbx, qby, qbz, qbw) = (b.x, b.y, b.z, b.w);
        Quat::new(
            qax * qbw + qaw * qbx + qay * qbz - qaz * qby,
            qay * qbw + qaw * qby + qaz * qbx - qax * qbz,
            qaz * qbw + qaw * qbz + qax * qby - qay * qbx,
            qaw * qbw - qax * qbx - qay * qby - qaz * qbz,
        )
    }

    /// `Quaternion.premultiply(a)` = `multiplyQuaternions(a, this)`.
    #[inline]
    pub fn premul(self, a: Quat) -> Quat {
        a.mul(self)
    }

    /// `Quaternion.length`.
    #[inline]
    pub fn length(self) -> f64 {
        (self.x * self.x + self.y * self.y + self.z * self.z + self.w * self.w).sqrt()
    }

    /// `Quaternion.normalize`.
    #[inline]
    pub fn normalize(self) -> Quat {
        let l = self.length();
        if l == 0.0 {
            Quat::IDENTITY
        } else {
            let l = 1.0 / l;
            Quat::new(self.x * l, self.y * l, self.z * l, self.w * l)
        }
    }

    /// `Quaternion.invert` (three.js: conjugate; q assumed unit length).
    #[inline]
    pub fn invert(self) -> Quat {
        Quat::new(self.x * -1.0, self.y * -1.0, self.z * -1.0, self.w)
    }

    /// `Quaternion.setFromAxisAngle` (axis assumed normalized).
    #[inline]
    pub fn from_axis_angle(axis: Vec3, angle: f64) -> Quat {
        let half_angle = angle / 2.0;
        let s = half_angle.sin();
        Quat::new(axis.x * s, axis.y * s, axis.z * s, half_angle.cos())
    }

    /// `Quaternion.setFromEuler` with order `'XYZ'`.
    pub fn from_euler_xyz(x: f64, y: f64, z: f64) -> Quat {
        let (c1, c2, c3) = ((x / 2.0).cos(), (y / 2.0).cos(), (z / 2.0).cos());
        let (s1, s2, s3) = ((x / 2.0).sin(), (y / 2.0).sin(), (z / 2.0).sin());
        Quat::new(
            s1 * c2 * c3 + c1 * s2 * s3,
            c1 * s2 * c3 - s1 * c2 * s3,
            c1 * c2 * s3 + s1 * s2 * c3,
            c1 * c2 * c3 - s1 * s2 * s3,
        )
    }

    /// `Quaternion.setFromEuler` with order `'YXZ'`.
    pub fn from_euler_yxz(x: f64, y: f64, z: f64) -> Quat {
        let (c1, c2, c3) = ((x / 2.0).cos(), (y / 2.0).cos(), (z / 2.0).cos());
        let (s1, s2, s3) = ((x / 2.0).sin(), (y / 2.0).sin(), (z / 2.0).sin());
        Quat::new(
            s1 * c2 * c3 + c1 * s2 * s3,
            c1 * s2 * c3 - s1 * c2 * s3,
            c1 * c2 * s3 - s1 * s2 * c3,
            c1 * c2 * c3 + s1 * s2 * s3,
        )
    }

    /// `Quaternion.setFromRotationMatrix` (upper 3x3 assumed unscaled).
    pub fn from_rotation_matrix(m: &Mat4) -> Quat {
        let te = &m.e;
        let (m11, m12, m13) = (te[0], te[4], te[8]);
        let (m21, m22, m23) = (te[1], te[5], te[9]);
        let (m31, m32, m33) = (te[2], te[6], te[10]);
        let trace = m11 + m22 + m33;
        if trace > 0.0 {
            let s = 0.5 / (trace + 1.0).sqrt();
            Quat::new((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s)
        } else if m11 > m22 && m11 > m33 {
            let s = 2.0 * (1.0 + m11 - m22 - m33).sqrt();
            Quat::new(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s)
        } else if m22 > m33 {
            let s = 2.0 * (1.0 + m22 - m11 - m33).sqrt();
            Quat::new((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s)
        } else {
            let s = 2.0 * (1.0 + m33 - m11 - m22).sqrt();
            Quat::new((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s)
        }
    }
}

impl Mat4 {
    pub const IDENTITY: Mat4 = Mat4 {
        e: [
            1.0, 0.0, 0.0, 0.0, //
            0.0, 1.0, 0.0, 0.0, //
            0.0, 0.0, 1.0, 0.0, //
            0.0, 0.0, 0.0, 1.0,
        ],
    };

    /// From `Matrix4.elements` order.
    #[inline]
    pub const fn from_elements(e: [f64; 16]) -> Mat4 {
        Mat4 { e }
    }

    /// `Matrix4.compose(position, quaternion, scale)`.
    pub fn compose(position: Vec3, q: Quat, scale: Vec3) -> Mat4 {
        let (x, y, z, w) = (q.x, q.y, q.z, q.w);
        let (x2, y2, z2) = (x + x, y + y, z + z);
        let (xx, xy, xz) = (x * x2, x * y2, x * z2);
        let (yy, yz, zz) = (y * y2, y * z2, z * z2);
        let (wx, wy, wz) = (w * x2, w * y2, w * z2);
        let (sx, sy, sz) = (scale.x, scale.y, scale.z);
        Mat4 {
            e: [
                (1.0 - (yy + zz)) * sx,
                (xy + wz) * sx,
                (xz - wy) * sx,
                0.0,
                (xy - wz) * sy,
                (1.0 - (xx + zz)) * sy,
                (yz + wx) * sy,
                0.0,
                (xz + wy) * sz,
                (yz - wx) * sz,
                (1.0 - (xx + yy)) * sz,
                0.0,
                position.x,
                position.y,
                position.z,
                1.0,
            ],
        }
    }

    /// `Matrix4.makeRotationFromQuaternion` = `compose(_zero, q, _one)`.
    #[inline]
    pub fn from_quat(q: Quat) -> Mat4 {
        Mat4::compose(Vec3::ZERO, q, Vec3::ONE)
    }

    /// `Matrix4.multiplyMatrices(a, b)`; `a.mul(&b)` is `a.multiply(b)`.
    pub fn mul(&self, b: &Mat4) -> Mat4 {
        let ae = &self.e;
        let be = &b.e;
        let (a11, a12, a13, a14) = (ae[0], ae[4], ae[8], ae[12]);
        let (a21, a22, a23, a24) = (ae[1], ae[5], ae[9], ae[13]);
        let (a31, a32, a33, a34) = (ae[2], ae[6], ae[10], ae[14]);
        let (a41, a42, a43, a44) = (ae[3], ae[7], ae[11], ae[15]);
        let (b11, b12, b13, b14) = (be[0], be[4], be[8], be[12]);
        let (b21, b22, b23, b24) = (be[1], be[5], be[9], be[13]);
        let (b31, b32, b33, b34) = (be[2], be[6], be[10], be[14]);
        let (b41, b42, b43, b44) = (be[3], be[7], be[11], be[15]);
        let mut te = [0.0f64; 16];
        te[0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
        te[4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
        te[8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
        te[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;
        te[1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
        te[5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
        te[9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
        te[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;
        te[2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
        te[6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
        te[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
        te[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;
        te[3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
        te[7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
        te[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
        te[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
        Mat4 { e: te }
    }

    /// `Matrix4.determinant`.
    pub fn determinant(&self) -> f64 {
        let te = &self.e;
        let (n11, n12, n13, n14) = (te[0], te[4], te[8], te[12]);
        let (n21, n22, n23, n24) = (te[1], te[5], te[9], te[13]);
        let (n31, n32, n33, n34) = (te[2], te[6], te[10], te[14]);
        let (n41, n42, n43, n44) = (te[3], te[7], te[11], te[15]);
        let t11 = n23 * n34 - n24 * n33;
        let t12 = n22 * n34 - n24 * n32;
        let t13 = n22 * n33 - n23 * n32;
        let t21 = n21 * n34 - n24 * n31;
        let t22 = n21 * n33 - n23 * n31;
        let t23 = n21 * n32 - n22 * n31;
        n11 * (n42 * t11 - n43 * t12 + n44 * t13) - n12 * (n41 * t11 - n43 * t21 + n44 * t22)
            + n13 * (n41 * t12 - n42 * t21 + n44 * t23)
            - n14 * (n41 * t13 - n42 * t22 + n43 * t23)
    }

    /// `Matrix4.invert` (all zeros when singular, as three.js does).
    pub fn invert(&self) -> Mat4 {
        let te = &self.e;
        let (n11, n21, n31, n41) = (te[0], te[1], te[2], te[3]);
        let (n12, n22, n32, n42) = (te[4], te[5], te[6], te[7]);
        let (n13, n23, n33, n43) = (te[8], te[9], te[10], te[11]);
        let (n14, n24, n34, n44) = (te[12], te[13], te[14], te[15]);
        let t1 = n11 * n22 - n21 * n12;
        let t2 = n11 * n32 - n31 * n12;
        let t3 = n11 * n42 - n41 * n12;
        let t4 = n21 * n32 - n31 * n22;
        let t5 = n21 * n42 - n41 * n22;
        let t6 = n31 * n42 - n41 * n32;
        let t7 = n13 * n24 - n23 * n14;
        let t8 = n13 * n34 - n33 * n14;
        let t9 = n13 * n44 - n43 * n14;
        let t10 = n23 * n34 - n33 * n24;
        let t11 = n23 * n44 - n43 * n24;
        let t12 = n33 * n44 - n43 * n34;
        let det = t1 * t12 - t2 * t11 + t3 * t10 + t4 * t9 - t5 * t8 + t6 * t7;
        if det == 0.0 {
            return Mat4 { e: [0.0; 16] };
        }
        let det_inv = 1.0 / det;
        let mut o = [0.0f64; 16];
        o[0] = (n22 * t12 - n32 * t11 + n42 * t10) * det_inv;
        o[1] = (n31 * t11 - n21 * t12 - n41 * t10) * det_inv;
        o[2] = (n24 * t6 - n34 * t5 + n44 * t4) * det_inv;
        o[3] = (n33 * t5 - n23 * t6 - n43 * t4) * det_inv;
        o[4] = (n32 * t9 - n12 * t12 - n42 * t8) * det_inv;
        o[5] = (n11 * t12 - n31 * t9 + n41 * t8) * det_inv;
        o[6] = (n34 * t3 - n14 * t6 - n44 * t2) * det_inv;
        o[7] = (n13 * t6 - n33 * t3 + n43 * t2) * det_inv;
        o[8] = (n12 * t11 - n22 * t9 + n42 * t7) * det_inv;
        o[9] = (n21 * t9 - n11 * t11 - n41 * t7) * det_inv;
        o[10] = (n14 * t5 - n24 * t3 + n44 * t1) * det_inv;
        o[11] = (n23 * t3 - n13 * t5 - n43 * t1) * det_inv;
        o[12] = (n22 * t8 - n12 * t10 - n32 * t7) * det_inv;
        o[13] = (n11 * t10 - n21 * t8 + n31 * t7) * det_inv;
        o[14] = (n24 * t2 - n14 * t4 - n34 * t1) * det_inv;
        o[15] = (n13 * t4 - n23 * t2 + n33 * t1) * det_inv;
        Mat4 { e: o }
    }

    /// `Matrix4.decompose` → (position, quaternion, scale).
    pub fn decompose(&self) -> (Vec3, Quat, Vec3) {
        let te = &self.e;
        let position = Vec3::new(te[12], te[13], te[14]);
        let det = self.determinant();
        if det == 0.0 {
            return (position, Quat::IDENTITY, Vec3::ONE);
        }
        let mut sx = Vec3::new(te[0], te[1], te[2]).length();
        let sy = Vec3::new(te[4], te[5], te[6]).length();
        let sz = Vec3::new(te[8], te[9], te[10]).length();
        // if determinant is negative, we need to invert one scale
        if det < 0.0 {
            sx = -sx;
        }
        let mut m1 = *self;
        let inv_sx = 1.0 / sx;
        let inv_sy = 1.0 / sy;
        let inv_sz = 1.0 / sz;
        m1.e[0] *= inv_sx;
        m1.e[1] *= inv_sx;
        m1.e[2] *= inv_sx;
        m1.e[4] *= inv_sy;
        m1.e[5] *= inv_sy;
        m1.e[6] *= inv_sy;
        m1.e[8] *= inv_sz;
        m1.e[9] *= inv_sz;
        m1.e[10] *= inv_sz;
        let q = Quat::from_rotation_matrix(&m1);
        (position, q, Vec3::new(sx, sy, sz))
    }

    /// `Matrix4.getMaxScaleOnAxis`.
    pub fn max_scale_on_axis(&self) -> f64 {
        let te = &self.e;
        let scale_x_sq = te[0] * te[0] + te[1] * te[1] + te[2] * te[2];
        let scale_y_sq = te[4] * te[4] + te[5] * te[5] + te[6] * te[6];
        let scale_z_sq = te[8] * te[8] + te[9] * te[9] + te[10] * te[10];
        // Math.max: NaN in → NaN out (f64::max would drop it).
        js_max3(scale_x_sq, scale_y_sq, scale_z_sq).sqrt()
    }

    /// Store into a `Float32Array`-shaped slice (16 values), rounding each
    /// element the way a JS `Float32Array` store does (nearest, ties to even).
    #[inline]
    pub fn write_f32(&self, out: &mut [f32]) {
        for (o, v) in out[..16].iter_mut().zip(self.e.iter()) {
            *o = *v as f32;
        }
    }

    /// Load from 16 `f32`s (a `Float32Array` / instance attribute slice).
    #[inline]
    pub fn read_f32(src: &[f32]) -> Mat4 {
        let mut e = [0.0f64; 16];
        for (o, v) in e.iter_mut().zip(src[..16].iter()) {
            *o = *v as f64;
        }
        Mat4 { e }
    }
}

/// `Math.max(a, b)`: NaN if either is NaN; +0 beats -0.
#[inline]
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        // Distinguish ±0: Math.max(-0, +0) is +0.
        if a == 0.0 && (a.is_sign_negative() != b.is_sign_negative()) { 0.0 } else { a }
    } else if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)`: NaN if either is NaN; -0 beats +0.
#[inline]
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a == 0.0 && (a.is_sign_negative() != b.is_sign_negative()) { -0.0 } else { a }
    } else if a < b {
        a
    } else {
        b
    }
}

#[inline]
fn js_max3(a: f64, b: f64, c: f64) -> f64 {
    js_max(js_max(a, b), c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compose_identity() {
        let m = Mat4::compose(Vec3::ZERO, Quat::IDENTITY, Vec3::ONE);
        assert_eq!(m, Mat4::IDENTITY);
    }

    #[test]
    fn invert_roundtrip() {
        let q = Quat::new(0.1, 0.2, 0.3, 0.9).normalize();
        let m = Mat4::compose(Vec3::new(1.0, -2.0, 3.5), q, Vec3::new(2.0, 2.0, 2.0));
        let p = m.mul(&m.invert());
        for (i, v) in p.e.iter().enumerate() {
            let want = if i % 5 == 0 { 1.0 } else { 0.0 };
            assert!((v - want).abs() < 1e-12, "elem {i}: {v}");
        }
    }

    #[test]
    fn decompose_compose_roundtrip() {
        let q = Quat::new(-0.3, 0.5, 0.1, 0.8).normalize();
        let pos = Vec3::new(10.0, 20.0, -5.0);
        let s = Vec3::new(1.5, 1.5, 1.5);
        let (p2, q2, s2) = Mat4::compose(pos, q, s).decompose();
        assert!((p2.x - pos.x).abs() < 1e-12 && (s2.y - 1.5).abs() < 1e-12);
        assert!((q2.dot_abs(q) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn apply_quat_rotates() {
        // 90 degrees about +Z takes +X to +Y.
        let q = Quat::from_axis_angle(Vec3::new(0.0, 0.0, 1.0), std::f64::consts::FRAC_PI_2);
        let v = Vec3::new(1.0, 0.0, 0.0).apply_quat(q);
        assert!((v.x).abs() < 1e-15 && (v.y - 1.0).abs() < 1e-15);
    }

    #[test]
    fn js_max_min_semantics() {
        assert!(js_max(f64::NAN, 1.0).is_nan());
        assert!(js_max(-0.0, 0.0).is_sign_positive());
        assert!(js_min(-0.0, 0.0).is_sign_negative());
        assert_eq!(js_max(1.0, 2.0), 2.0);
    }

    impl Quat {
        fn dot_abs(self, o: Quat) -> f64 {
            (self.x * o.x + self.y * o.y + self.z * o.z + self.w * o.w).abs()
        }
    }
}
