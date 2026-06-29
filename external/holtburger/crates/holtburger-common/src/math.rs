use binrw::{BinRead, BinWrite};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, BinRead, BinWrite, PartialEq, Default)]
#[br(little)]
#[bw(little)]
pub struct Vector3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vector3 {
    pub fn new(x: f32, y: f32, z: f32) -> Self {
        Self { x, y, z }
    }

    pub fn zero() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        }
    }

    pub fn dot(&self, other: &Self) -> f32 {
        self.x * other.x + self.y * other.y + self.z * other.z
    }

    pub fn cross(&self, other: &Self) -> Self {
        Self {
            x: self.y * other.z - self.z * other.y,
            y: self.z * other.x - self.x * other.z,
            z: self.x * other.y - self.y * other.x,
        }
    }

    pub fn length_squared(&self) -> f32 {
        self.dot(self)
    }

    pub fn length(&self) -> f32 {
        self.length_squared().sqrt()
    }

    pub fn distance(&self, other: &Self) -> f32 {
        (*self - *other).length()
    }

    pub fn normalize(&self) -> Self {
        let len = self.length();
        if len > 0.0 { *self / len } else { *self }
    }

    /// Calculates the AC heading (radians) required to face from this position to a target.
    /// AC heading convention: 0 is West, 90 is North, 180 is East, 270 is South.
    pub fn heading_to(&self, target: &Vector3) -> f32 {
        let diff = *target - *self;
        if diff.length_squared() < 1e-6 {
            return 0.0;
        }
        // math_rad = atan2(-dx, dy) where math 0 = North
        let math_rad = f32::atan2(-diff.x, diff.y);
        let mut heading_deg = 450.0 - math_rad.to_degrees();
        heading_deg %= 360.0;
        if heading_deg < 0.0 {
            heading_deg += 360.0;
        }
        heading_deg.to_radians()
    }
}

impl std::ops::Add for Vector3 {
    type Output = Self;
    fn add(self, other: Self) -> Self {
        Self {
            x: self.x + other.x,
            y: self.y + other.y,
            z: self.z + other.z,
        }
    }
}

impl std::ops::Sub for Vector3 {
    type Output = Self;
    fn sub(self, other: Self) -> Self {
        Self {
            x: self.x - other.x,
            y: self.y - other.y,
            z: self.z - other.z,
        }
    }
}

impl std::ops::Mul<f32> for Vector3 {
    type Output = Self;
    fn mul(self, rhs: f32) -> Self {
        Self {
            x: self.x * rhs,
            y: self.y * rhs,
            z: self.z * rhs,
        }
    }
}

impl std::ops::Div<f32> for Vector3 {
    type Output = Self;
    fn div(self, rhs: f32) -> Self {
        Self {
            x: self.x / rhs,
            y: self.y / rhs,
            z: self.z / rhs,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, BinRead, BinWrite, PartialEq, Default)]
#[br(little)]
#[bw(little)]
pub struct Quaternion {
    pub w: f32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Quaternion {
    pub fn identity() -> Self {
        Self {
            w: 1.0,
            x: 0.0,
            y: 0.0,
            z: 0.0,
        }
    }

    /// Converts a quaternion to a heading (yaw) in radians.
    /// AC heading matches the official client: 0 at West, 90 at North, 180 at East, 270 at South.
    pub fn to_heading(&self) -> f32 {
        // M21 = 2wz, M22 = 1 - 2z^2 (for yaw-only quat)
        let sin_theta = 2.0 * self.w * self.z;
        let cos_theta = 1.0 - 2.0 * self.z * self.z;

        // We use Atan2(sin, cos) to get the internal theta.
        // With this 450 offset:
        // Identity Quat (theta=0) results in Heading 90 (North).
        // 90 deg CCW Rot (theta=90) results in Heading 0 (West).
        // This matches the official AC client convention where 0 is West.
        let rad = f32::atan2(sin_theta, cos_theta);
        let mut deg = 450.0 - rad.to_degrees();

        deg %= 360.0;
        if deg < 0.0 {
            deg += 360.0;
        }

        deg.to_radians()
    }

    pub fn from_heading(heading_rad: f32) -> Self {
        let heading_deg = heading_rad.to_degrees();

        // rad = 450 - deg
        let rad = (450.0 - heading_deg).to_radians();

        let half_theta = rad * 0.5;

        let mut w = f32::cos(half_theta);
        let mut z = f32::sin(half_theta);

        // Canonicalize (w must be non-negative to prevent flips)
        if w < 0.0 {
            w = -w;
            z = -z;
        }

        Self {
            w,
            x: 0.0,
            y: 0.0,
            z,
        }
    }

    /// Rotate a vector by this quaternion. Standard `v' = q * v * q^-1`
    /// expanded to 16 mults / 12 adds — same math as
    /// `System.Numerics.Vector3.Transform(v, q)`. Used by
    /// `Aabb::transform_by` for the 8-corner rotation in
    /// Phase 6 step B's per-part AABB world transform.
    pub fn rotate_vector(&self, v: Vector3) -> Vector3 {
        let xx = self.x * self.x;
        let yy = self.y * self.y;
        let zz = self.z * self.z;
        let xy = self.x * self.y;
        let xz = self.x * self.z;
        let yz = self.y * self.z;
        let wx = self.w * self.x;
        let wy = self.w * self.y;
        let wz = self.w * self.z;
        Vector3 {
            x: v.x * (1.0 - 2.0 * (yy + zz))
                + v.y * (2.0 * (xy - wz))
                + v.z * (2.0 * (xz + wy)),
            y: v.x * (2.0 * (xy + wz))
                + v.y * (1.0 - 2.0 * (xx + zz))
                + v.z * (2.0 * (yz - wx)),
            z: v.x * (2.0 * (xz - wy))
                + v.y * (2.0 * (yz + wx))
                + v.z * (1.0 - 2.0 * (xx + yy)),
        }
    }

    /// Hamilton product `self * other` (apply `other`, then `self`).
    /// Field order is w,x,y,z throughout — same convention as the rest of
    /// this struct and `System.Numerics.Quaternion.Multiply`. Used by the
    /// DIM5-2 root-motion orientation accumulator
    /// (`build_concatenated_motion_frames`) to compose per-frame pos_frame
    /// orientations cumulatively, mirroring ACE `AFrame.cs:43-49`
    /// (`orientation = Quaternion.Multiply(a.Ori, b.Ori)`) and melt
    /// `MotionTable.cs:229` (`orientation *= posFrame.Orientation`).
    pub fn multiply(self, other: Self) -> Self {
        Self {
            w: self.w * other.w - self.x * other.x - self.y * other.y - self.z * other.z,
            x: self.w * other.x + self.x * other.w + self.y * other.z - self.z * other.y,
            y: self.w * other.y - self.x * other.z + self.y * other.w + self.z * other.x,
            z: self.w * other.z + self.x * other.y - self.y * other.x + self.z * other.w,
        }
    }

    /// Scale to unit length. Returns `self` unchanged for a zero-magnitude
    /// quaternion (degenerate; never produced by a unit-quat product but
    /// guarded to avoid NaN). Mirrors melt `MotionTable.cs:230`
    /// (`Quaternion.Normalize`) — the accumulator normalizes after each
    /// compose so float drift over a long cycle can't denormalize the frame.
    pub fn normalize(self) -> Self {
        let mag = (self.w * self.w + self.x * self.x + self.y * self.y + self.z * self.z).sqrt();
        if mag > 0.0 {
            Self {
                w: self.w / mag,
                x: self.x / mag,
                y: self.y / mag,
                z: self.z / mag,
            }
        } else {
            self
        }
    }

    /// Conjugate (negate the vector part). For a UNIT quaternion this equals
    /// the inverse, so it undoes a rotation — used by the DIM5-2 accumulator
    /// to de-accumulate orientation on reverse-played (negative-framerate)
    /// segments.
    pub fn conjugate(self) -> Self {
        Self {
            w: self.w,
            x: -self.x,
            y: -self.y,
            z: -self.z,
        }
    }

    /// Quaternion dot product (4-component). The cosine of half the angle
    /// between the two orientations; the `cosom` of [`Self::slerp`].
    pub fn dot(self, other: Self) -> f32 {
        self.w * other.w + self.x * other.x + self.y * other.y + self.z * other.z
    }

    /// Spherical-linear interpolation, a faithful port of retail
    /// `Frame::interpolate_rotation` (acclient.c:357258). `t` runs 0→1 (the
    /// driver supplies `(step+1)/num_steps`). Takes the SHORT arc (negates `to`
    /// when `cosom < 0`); falls back to linear blend when the endpoints are
    /// nearly identical (`1 - cosom <= 0.00019999999`) or when a computed scale
    /// leaves `[0, 1]` (the decomp's range guard), then normalizes — retail
    /// normalizes via `Frame::set_rotate`. (ACE uses `Quaternion.Lerp`; the
    /// decomp's true SLERP wins per project policy.)
    pub fn slerp(from: Self, to: Self, t: f32) -> Self {
        let mut cosom = from.dot(to);
        // Short-arc: flip `to` (and the dot sign) when the dot is negative.
        let to = if cosom < 0.0 {
            cosom = -cosom;
            Self {
                w: -to.w,
                x: -to.x,
                y: -to.y,
                z: -to.z,
            }
        } else {
            to
        };
        let (scale0, scale1) = if 1.0 - cosom > 0.000_199_999_99 {
            let omega = cosom.acos();
            let inv_sin = 1.0 / omega.sin();
            let s0 = (omega * (1.0 - t)).sin() * inv_sin;
            let s1 = (omega * t).sin() * inv_sin;
            // Decomp range guard: any out-of-[0,1] scale ⇒ linear fallback.
            if !(0.0..=1.0).contains(&s0) || !(0.0..=1.0).contains(&s1) {
                (1.0 - t, t)
            } else {
                (s0, s1)
            }
        } else {
            (1.0 - t, t)
        };
        Self {
            w: scale0 * from.w + scale1 * to.w,
            x: scale0 * from.x + scale1 * to.x,
            y: scale0 * from.y + scale1 * to.y,
            z: scale0 * from.z + scale1 * to.z,
        }
        .normalize()
    }

    /// Build the column-major local→global rotation basis the physics `Frame`
    /// stores (`m_fl2gv[0..9]`). Bit-for-bit the retail `Frame::cache` formula
    /// (acclient.c:356984) — and identical to constructing the basis with
    /// [`Self::rotate_vector`] on the unit axes (the `frame_from` path), so the
    /// matrix↔quaternion round-trip is exact for an orthonormal frame.
    pub fn to_rotation_matrix(self) -> [f32; 9] {
        let Self { w, x, y, z } = self;
        let (xx, yy, zz) = (x * x, y * y, z * z);
        let (xy, xz, yz) = (x * y, x * z, y * z);
        let (wx, wy, wz) = (w * x, w * y, w * z);
        [
            1.0 - 2.0 * (yy + zz),
            2.0 * (xy + wz),
            2.0 * (xz - wy),
            2.0 * (xy - wz),
            1.0 - 2.0 * (xx + zz),
            2.0 * (yz + wx),
            2.0 * (xz + wy),
            2.0 * (yz - wx),
            1.0 - 2.0 * (xx + yy),
        ]
    }

    /// Recover the unit quaternion from a column-major `m_fl2gv` rotation basis
    /// (the inverse of [`Self::to_rotation_matrix`]). Shepperd's method: pivot on
    /// the largest diagonal term for numerical stability. Sign conventions match
    /// the layout `to_rotation_matrix` writes, so `from_rotation_matrix(q.to_…)`
    /// recovers `q` (up to the usual q/−q double cover, which `slerp` resolves).
    pub fn from_rotation_matrix(m: &[f32; 9]) -> Self {
        // m is column-major: M[row][col] = (m00 m01 m02 / m10 m11 m12 / m20 m21 m22).
        let (m00, m10, m20) = (m[0], m[1], m[2]);
        let (m01, m11, m21) = (m[3], m[4], m[5]);
        let (m02, m12, m22) = (m[6], m[7], m[8]);
        let trace = m00 + m11 + m22;
        let q = if trace > 0.0 {
            let s = (trace + 1.0).sqrt() * 2.0; // 4w
            Self {
                w: 0.25 * s,
                x: (m21 - m12) / s,
                y: (m02 - m20) / s,
                z: (m10 - m01) / s,
            }
        } else if m00 > m11 && m00 > m22 {
            let s = (1.0 + m00 - m11 - m22).sqrt() * 2.0; // 4x
            Self {
                w: (m21 - m12) / s,
                x: 0.25 * s,
                y: (m01 + m10) / s,
                z: (m02 + m20) / s,
            }
        } else if m11 > m22 {
            let s = (1.0 + m11 - m00 - m22).sqrt() * 2.0; // 4y
            Self {
                w: (m02 - m20) / s,
                x: (m01 + m10) / s,
                y: 0.25 * s,
                z: (m12 + m21) / s,
            }
        } else {
            let s = (1.0 + m22 - m00 - m11).sqrt() * 2.0; // 4z
            Self {
                w: (m10 - m01) / s,
                x: (m02 + m20) / s,
                y: (m12 + m21) / s,
                z: 0.25 * s,
            }
        };
        q.normalize()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, BinRead, BinWrite, PartialEq)]
#[br(little)]
#[bw(little)]
pub struct Plane {
    pub normal: Vector3,
    pub d: f32,
}

impl Plane {
    /// Calculate the signed distance from a point to the plane.
    pub fn distance_to_point(&self, point: &Vector3) -> f32 {
        self.normal.dot(point) + self.d
    }

    /// Build a plane from three CCW-wound triangle vertices. The
    /// normal points out of the side where v0 → v1 → v2 traces
    /// counter-clockwise (right-hand rule on `(v1 - v0) × (v2 - v0)`).
    /// Returns `None` for degenerate triangles (zero or near-zero
    /// area), which would otherwise produce a NaN normal.
    pub fn from_triangle(v0: Vector3, v1: Vector3, v2: Vector3) -> Option<Self> {
        let edge1 = Vector3::new(v1.x - v0.x, v1.y - v0.y, v1.z - v0.z);
        let edge2 = Vector3::new(v2.x - v0.x, v2.y - v0.y, v2.z - v0.z);
        let cross = edge1.cross(&edge2);
        let length_sq = cross.length_squared();
        if length_sq < 1e-12 {
            return None;
        }
        let length = length_sq.sqrt();
        let normal = Vector3::new(cross.x / length, cross.y / length, cross.z / length);
        let d = -normal.dot(&v0);
        Some(Self { normal, d })
    }
}

/// 2026-05-10 indoor collision (Phase 6 step G follow-on): a
/// world-space triangle pre-transformed from EnvCell physics_polygons
/// for swept-capsule and floor-raycast queries. The wasm bundle's
/// indoor populator builds these by:
///
///   1. Reading `physics_polygons` from a parsed `Environment`
///      (`crates/holtburger-dat/src/file_type/environment.rs`).
///   2. Looking up each polygon's `vertex_ids` in the cell's
///      `vertex_array` to recover cell-local positions.
///   3. Transforming local positions to world coords via the
///      EnvCell's `position` frame (origin + rotate_vector).
///   4. Triangulating polygons with `num_pts > 3` as a fan from `v0`.
///
/// Storing world coords (not cell-local) trades memory for
/// per-tick simplicity — the integrator's swept-capsule kernel
/// can run a closed-form ray-vs-triangle test without re-running
/// the cell-frame transform every frame. Cells get re-baked when
/// the landblock unloads (matches the building AABB index's
/// lifetime semantics).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Triangle {
    pub v0: Vector3,
    pub v1: Vector3,
    pub v2: Vector3,
}

impl Triangle {
    pub fn new(v0: Vector3, v1: Vector3, v2: Vector3) -> Self {
        Self { v0, v1, v2 }
    }

    /// Plane of the triangle, derived from CCW winding via
    /// `Plane::from_triangle`. Returns `None` for degenerate
    /// triangles (collinear or coincident vertices).
    pub fn plane(&self) -> Option<Plane> {
        Plane::from_triangle(self.v0, self.v1, self.v2)
    }

    /// AABB enclosing the three vertices.
    pub fn aabb(&self) -> Aabb {
        let mut a = Aabb::empty();
        a.expand_to_include_point(self.v0);
        a.expand_to_include_point(self.v1);
        a.expand_to_include_point(self.v2);
        a
    }

    /// 2D-projected (XY-plane) point-in-triangle test using
    /// barycentric signs. Returns `true` when `(x, y)` lies inside
    /// the triangle's XY shadow — the floor-raycast helper uses
    /// this to gate the ray-vs-plane Z lookup against the actual
    /// triangle footprint, not its infinite plane.
    pub fn contains_xy(&self, x: f32, y: f32) -> bool {
        // Edge sign test: for each edge (a → b) compute the
        // 2D cross of (b - a) × ((x, y) - a). All three signs
        // must agree (or be zero, which puts the point on an
        // edge). Tolerance lets points fractionally outside still
        // count, accommodating shared edges between adjacent
        // triangles.
        let tol = 1e-4_f32;
        let s = |ax: f32, ay: f32, bx: f32, by: f32| -> f32 {
            (bx - ax) * (y - ay) - (by - ay) * (x - ax)
        };
        let d0 = s(self.v0.x, self.v0.y, self.v1.x, self.v1.y);
        let d1 = s(self.v1.x, self.v1.y, self.v2.x, self.v2.y);
        let d2 = s(self.v2.x, self.v2.y, self.v0.x, self.v0.y);
        let has_neg = d0 < -tol || d1 < -tol || d2 < -tol;
        let has_pos = d0 > tol || d1 > tol || d2 > tol;
        !(has_neg && has_pos)
    }

    /// Z height at `(x, y)` interpolated on the triangle's plane.
    /// Returns `None` if the plane is vertical (normal.z ≈ 0) —
    /// vertical triangles ARE walls, not floors, and have no
    /// well-defined "floor height". Caller should filter for
    /// floor-ish triangles before calling.
    pub fn z_at_xy(&self, x: f32, y: f32) -> Option<f32> {
        let plane = self.plane()?;
        if plane.normal.z.abs() < 1e-4 {
            return None;
        }
        // Plane equation: normal·p + d = 0 → solve for z.
        Some(-(plane.normal.x * x + plane.normal.y * y + plane.d) / plane.normal.z)
    }

    /// Closest point on (or inside) the triangle to `p`. Used by
    /// the swept-capsule kernel to compute the contact-point
    /// distance: project `p` onto the triangle plane, then clamp
    /// to the triangle interior via barycentric. This is Real-Time
    /// Collision Detection §5.1.5 (Christer Ericson) verbatim —
    /// straightforward but easy to get wrong, hence verbatim.
    pub fn closest_point(&self, p: Vector3) -> Vector3 {
        let ab = Vector3::new(
            self.v1.x - self.v0.x,
            self.v1.y - self.v0.y,
            self.v1.z - self.v0.z,
        );
        let ac = Vector3::new(
            self.v2.x - self.v0.x,
            self.v2.y - self.v0.y,
            self.v2.z - self.v0.z,
        );
        let ap = Vector3::new(p.x - self.v0.x, p.y - self.v0.y, p.z - self.v0.z);
        let d1 = ab.dot(&ap);
        let d2 = ac.dot(&ap);
        if d1 <= 0.0 && d2 <= 0.0 {
            return self.v0;
        }
        let bp = Vector3::new(p.x - self.v1.x, p.y - self.v1.y, p.z - self.v1.z);
        let d3 = ab.dot(&bp);
        let d4 = ac.dot(&bp);
        if d3 >= 0.0 && d4 <= d3 {
            return self.v1;
        }
        let vc = d1 * d4 - d3 * d2;
        if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
            let v = d1 / (d1 - d3);
            return Vector3::new(
                self.v0.x + ab.x * v,
                self.v0.y + ab.y * v,
                self.v0.z + ab.z * v,
            );
        }
        let cp = Vector3::new(p.x - self.v2.x, p.y - self.v2.y, p.z - self.v2.z);
        let d5 = ab.dot(&cp);
        let d6 = ac.dot(&cp);
        if d6 >= 0.0 && d5 <= d6 {
            return self.v2;
        }
        let vb = d5 * d2 - d1 * d6;
        if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
            let w = d2 / (d2 - d6);
            return Vector3::new(
                self.v0.x + ac.x * w,
                self.v0.y + ac.y * w,
                self.v0.z + ac.z * w,
            );
        }
        let va = d3 * d6 - d5 * d4;
        if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
            let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
            return Vector3::new(
                self.v1.x + (self.v2.x - self.v1.x) * w,
                self.v1.y + (self.v2.y - self.v1.y) * w,
                self.v1.z + (self.v2.z - self.v1.z) * w,
            );
        }
        let denom = 1.0 / (va + vb + vc);
        let v = vb * denom;
        let w = vc * denom;
        Vector3::new(
            self.v0.x + ab.x * v + ac.x * w,
            self.v0.y + ab.y * v + ac.y * w,
            self.v0.z + ab.z * v + ac.z * w,
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, BinRead, BinWrite)]
#[br(little)]
#[bw(little)]
pub struct Sphere {
    pub center: Vector3,
    pub radius: f32,
}

impl Sphere {
    pub fn intersects(&self, point: &Vector3, radius: f32) -> bool {
        let diff = self.center - *point;
        let dist_sq = diff.length_squared();
        let r_sum = self.radius + radius;
        // ACE `Sphere.Intersects` (Sphere.cs:258) uses strict `<` (exact-touch
        // is NOT an intersection). Faithful for every BSP bounding reject.
        dist_sq < r_sum * r_sum
    }
}

/// Axis-aligned bounding box. Phase 6 step B uses these as the
/// per-part collision primitive — built from `GfxObj.vertex_array`
/// vertex positions, transformed by part frame + placement frame,
/// and bucketed per-cell into `WorldState::scene` for swept-sphere
/// queries during the manual-drive integrator.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Aabb {
    pub min: Vector3,
    pub max: Vector3,
}

impl Aabb {
    pub fn new(min: Vector3, max: Vector3) -> Self {
        Self { min, max }
    }

    /// Empty AABB sentinel — `min > max` on all axes so any
    /// `expand_to_include_point` call replaces the bounds wholesale.
    /// Use as the seed when accumulating a fresh AABB across vertices.
    pub fn empty() -> Self {
        Self {
            min: Vector3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY),
            max: Vector3::new(f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.min.x > self.max.x || self.min.y > self.max.y || self.min.z > self.max.z
    }

    pub fn expand_to_include_point(&mut self, p: Vector3) {
        if p.x < self.min.x {
            self.min.x = p.x;
        }
        if p.y < self.min.y {
            self.min.y = p.y;
        }
        if p.z < self.min.z {
            self.min.z = p.z;
        }
        if p.x > self.max.x {
            self.max.x = p.x;
        }
        if p.y > self.max.y {
            self.max.y = p.y;
        }
        if p.z > self.max.z {
            self.max.z = p.z;
        }
    }

    pub fn translate(&self, offset: Vector3) -> Self {
        Self {
            min: self.min + offset,
            max: self.max + offset,
        }
    }

    pub fn center(&self) -> Vector3 {
        Vector3 {
            x: (self.min.x + self.max.x) * 0.5,
            y: (self.min.y + self.max.y) * 0.5,
            z: (self.min.z + self.max.z) * 0.5,
        }
    }

    pub fn half_extents(&self) -> Vector3 {
        Vector3 {
            x: (self.max.x - self.min.x) * 0.5,
            y: (self.max.y - self.min.y) * 0.5,
            z: (self.max.z - self.min.z) * 0.5,
        }
    }

    /// Inflate the AABB on all axes — used to convert sphere-vs-AABB
    /// sweep into ray-vs-(inflated-AABB), which is the standard trick
    /// for Minkowski-style swept-sphere collision.
    pub fn inflate(&self, amount: f32) -> Self {
        Self {
            min: Vector3::new(self.min.x - amount, self.min.y - amount, self.min.z - amount),
            max: Vector3::new(self.max.x + amount, self.max.y + amount, self.max.z + amount),
        }
    }

    /// Phase 6 step B follow-up: transform a part-local AABB by an
    /// affine `(rotation, translation)` and return the world-space
    /// AABB that bounds the rotated cube. Standard 8-corner technique:
    /// enumerate the 8 corners of `self`, rotate each by the
    /// quaternion, translate by `origin`, take the per-axis min/max
    /// of all 8 rotated corners. The resulting AABB is generally
    /// larger than the input — a 1×1×1 cube rotated 45° yaw becomes
    /// an AABB ±√2 in the rotation plane — and that conservative
    /// expansion is exactly what the swept-sphere collision wants
    /// (the visible mesh stays inside the AABB after rotation).
    ///
    /// Used by `populateBuildingAabbsForLandblock` to lift each
    /// per-part AABB (which `walk_setup_parts_with_geom` returns in
    /// the building's local space) into the global world frame
    /// before bucketing into `SpatialScene::building_aabb_index`.
    pub fn transform_by(&self, rotation: Quaternion, origin: Vector3) -> Self {
        if self.is_empty() {
            return *self;
        }
        let corners = [
            Vector3::new(self.min.x, self.min.y, self.min.z),
            Vector3::new(self.max.x, self.min.y, self.min.z),
            Vector3::new(self.min.x, self.max.y, self.min.z),
            Vector3::new(self.max.x, self.max.y, self.min.z),
            Vector3::new(self.min.x, self.min.y, self.max.z),
            Vector3::new(self.max.x, self.min.y, self.max.z),
            Vector3::new(self.min.x, self.max.y, self.max.z),
            Vector3::new(self.max.x, self.max.y, self.max.z),
        ];
        let mut out = Self::empty();
        for c in corners {
            let r = rotation.rotate_vector(c);
            out.expand_to_include_point(Vector3::new(
                r.x + origin.x,
                r.y + origin.y,
                r.z + origin.z,
            ));
        }
        out
    }
}

impl Default for Aabb {
    fn default() -> Self {
        Self::empty()
    }
}

/// 6-plane view frustum, used for AABB-vs-frustum culling per
/// WB.GameScene.cs:1584 + EnvCellManager.GetVisibleCells. Each plane
/// is normalized so that `plane.distance_to_point(p) >= 0` means `p`
/// is on the inside (visible) side. AABBs are culled when ANY plane
/// reports the AABB's most-positive corner as negative — the standard
/// "n-vertex test".
///
/// 2026-05-25: added for the Phase 4 PView port — see
/// docs/cell-portal-method.md §"Known scope gap" #3 (LandCell↔EnvCell
/// visibility via outdoor frustum culling).
#[derive(Debug, Clone, Copy)]
pub struct Frustum {
    /// Plane order: left, right, bottom, top, near, far. Each
    /// pre-normalized; `distance_to_point >= 0` iff inside.
    pub planes: [Plane; 6],
}

impl Frustum {
    /// Build a frustum from 6 pre-normalized planes (left, right,
    /// bottom, top, near, far). All planes face inward (positive
    /// distance = inside).
    pub fn new(planes: [Plane; 6]) -> Self {
        Self { planes }
    }

    /// Extract a frustum from a **column-major** 4×4 view-projection
    /// matrix in the layout Three.js / glm / WebGL produce: `m[col*4 + row]`,
    /// so `m[0..4]` is the first column, `m[4..8]` the second, etc.
    /// Standard Gribb–Hartmann extraction; planes are normalized so
    /// `distance_to_point` is in world units.
    ///
    /// This matches `THREE.Frustum.setFromProjectionMatrix` exactly,
    /// so callers can pass `camera.projectionMatrix * camera.matrixWorldInverse`
    /// as a 16-float flat array and get the same six planes Three.js
    /// would compute itself.
    pub fn from_view_projection_matrix(m: &[f32; 16]) -> Self {
        let p = |a: f32, b: f32, c: f32, d: f32| -> Plane {
            let len = (a * a + b * b + c * c).sqrt().max(1e-12);
            Plane {
                normal: Vector3::new(a / len, b / len, c / len),
                d: d / len,
            }
        };
        // Column-major: `m[col*4 + row]`. Row r of the matrix is
        // `[m[r], m[4+r], m[8+r], m[12+r]]`. Gribb–Hartmann combines
        // row3 with each of row0..row2.
        let r0 = (m[0], m[4], m[8], m[12]); // row 0 (x)
        let r1 = (m[1], m[5], m[9], m[13]); // row 1 (y)
        let r2 = (m[2], m[6], m[10], m[14]); // row 2 (z)
        let r3 = (m[3], m[7], m[11], m[15]); // row 3 (w)
        let planes = [
            p(r3.0 + r0.0, r3.1 + r0.1, r3.2 + r0.2, r3.3 + r0.3), // left
            p(r3.0 - r0.0, r3.1 - r0.1, r3.2 - r0.2, r3.3 - r0.3), // right
            p(r3.0 + r1.0, r3.1 + r1.1, r3.2 + r1.2, r3.3 + r1.3), // bottom
            p(r3.0 - r1.0, r3.1 - r1.1, r3.2 - r1.2, r3.3 - r1.3), // top
            p(r3.0 + r2.0, r3.1 + r2.1, r3.2 + r2.2, r3.3 + r2.3), // near
            p(r3.0 - r2.0, r3.1 - r2.1, r3.2 - r2.2, r3.3 - r2.3), // far
        ];
        Self { planes }
    }

    /// Test whether an AABB is at least partially inside the frustum.
    /// Returns `true` if the AABB is fully inside OR straddles the
    /// frustum boundary. Returns `false` only when the AABB is fully
    /// outside (every plane reports the most-positive corner as
    /// negative).
    ///
    /// Standard "n-vertex test": for each plane, pick the AABB corner
    /// that's farthest in the +normal direction. If that corner is on
    /// the negative side, the whole AABB is outside.
    pub fn intersects_aabb(&self, aabb: &Aabb) -> bool {
        for plane in &self.planes {
            // Corner of AABB farthest along +plane.normal.
            let corner = Vector3::new(
                if plane.normal.x >= 0.0 { aabb.max.x } else { aabb.min.x },
                if plane.normal.y >= 0.0 { aabb.max.y } else { aabb.min.y },
                if plane.normal.z >= 0.0 { aabb.max.z } else { aabb.min.z },
            );
            if plane.distance_to_point(&corner) < 0.0 {
                return false;
            }
        }
        true
    }

    /// Test whether a point is inside the frustum.
    pub fn contains_point(&self, p: &Vector3) -> bool {
        self.planes.iter().all(|plane| plane.distance_to_point(p) >= 0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_heading_roundtrip() {
        let test_angles: [f32; 8] = [0.0, 45.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0];
        for deg in test_angles {
            let rad = deg.to_radians();
            let q = Quaternion::from_heading(rad);
            let result_rad = q.to_heading();
            let result_deg = result_rad.to_degrees();

            // Normalize result to 0-360 for comparison
            let normalized_result = (result_deg + 360.0) % 360.0;
            assert!(
                (normalized_result - deg).abs() < 1e-4,
                "Failed at {} deg: got {} deg",
                deg,
                normalized_result
            );
        }
    }

    #[test]
    fn test_cardinal_directions() {
        // West
        let q_w = Quaternion::from_heading(0.0);
        assert!((q_w.to_heading().to_degrees() - 0.0).abs() < 1e-4);

        // North
        let q_n = Quaternion::from_heading(90.0f32.to_radians());
        assert!((q_n.to_heading().to_degrees() - 90.0).abs() < 1e-4);

        // East
        let q_e = Quaternion::from_heading(180.0f32.to_radians());
        assert!((q_e.to_heading().to_degrees() - 180.0).abs() < 1e-4);

        // South
        let q_s = Quaternion::from_heading(270.0f32.to_radians());
        assert!((q_s.to_heading().to_degrees() - 270.0).abs() < 1e-4);
    }

    #[test]
    fn test_to_heading_default() {
        let q = Quaternion::default();
        let h = q.to_heading();
        assert!(
            !h.is_nan(),
            "Heading for default quaternion should not be NaN"
        );
    }

    #[test]
    fn test_to_heading_nan_input() {
        let q = Quaternion {
            w: f32::NAN,
            x: 0.0,
            y: 0.0,
            z: 0.0,
        };
        let h = q.to_heading();
        assert!(h.is_nan());
    }

    // 2026-05-10 Triangle / Plane primitives for indoor collision.

    #[test]
    fn plane_from_triangle_ccw_normal_points_up_for_floor() {
        // CCW (right-hand rule) winding on a flat z=2 floor →
        // normal points +Z.
        let plane = Plane::from_triangle(
            Vector3::new(0.0, 0.0, 2.0),
            Vector3::new(1.0, 0.0, 2.0),
            Vector3::new(0.0, 1.0, 2.0),
        )
        .expect("non-degenerate triangle");
        assert!(
            (plane.normal.z - 1.0).abs() < 1e-4,
            "floor normal.z should be +1, got {:.4}",
            plane.normal.z
        );
        assert!(
            plane.normal.x.abs() < 1e-4 && plane.normal.y.abs() < 1e-4,
            "floor normal lateral should be 0; got ({:.4}, {:.4})",
            plane.normal.x,
            plane.normal.y
        );
        assert!(
            (plane.distance_to_point(&Vector3::new(0.5, 0.5, 2.0))).abs() < 1e-4,
            "point on the plane should have distance 0"
        );
        assert!(
            (plane.distance_to_point(&Vector3::new(0.5, 0.5, 5.0)) - 3.0).abs() < 1e-4,
            "point 3 m above should have distance +3"
        );
    }

    #[test]
    fn plane_from_triangle_degenerate_returns_none() {
        // Collinear vertices (zero area) — no well-defined normal.
        let plane = Plane::from_triangle(
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(1.0, 0.0, 0.0),
            Vector3::new(2.0, 0.0, 0.0),
        );
        assert!(plane.is_none());
    }

    #[test]
    fn triangle_contains_xy_inside_and_outside() {
        let tri = Triangle::new(
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(2.0, 0.0, 0.0),
            Vector3::new(0.0, 2.0, 0.0),
        );
        assert!(tri.contains_xy(0.5, 0.5), "centre should be inside");
        assert!(tri.contains_xy(0.0, 0.0), "vertex should be inside (edge tol)");
        assert!(!tri.contains_xy(2.0, 2.0), "far corner should be outside");
        assert!(!tri.contains_xy(-1.0, 0.5), "left of v0 edge should be outside");
    }

    #[test]
    fn triangle_z_at_xy_interpolates_sloped_floor() {
        // Ramp from z=0 at (0,0) up to z=4 at (4,0); flat in y.
        let tri = Triangle::new(
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(4.0, 0.0, 4.0),
            Vector3::new(0.0, 4.0, 0.0),
        );
        let z_at_2_2 = tri
            .z_at_xy(2.0, 2.0)
            .expect("non-vertical triangle has well-defined z");
        // Plane through (0,0,0), (4,0,4), (0,4,0): z = x.
        assert!(
            (z_at_2_2 - 2.0).abs() < 1e-3,
            "z at (2,2) should be 2 (z = x along the ramp), got {:.4}",
            z_at_2_2
        );
    }

    #[test]
    fn triangle_z_at_xy_returns_none_for_vertical_wall() {
        // A vertical wall (constant y, varying x and z) has plane
        // normal in the XZ plane → normal.z ≈ 0, so z_at_xy is
        // undefined.
        let tri = Triangle::new(
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(2.0, 0.0, 0.0),
            Vector3::new(0.0, 0.0, 3.0),
        );
        assert!(tri.z_at_xy(1.0, 0.0).is_none());
    }

    #[test]
    fn triangle_closest_point_inside_projects_to_plane() {
        // Flat floor at z=0; query point above the centre.
        let tri = Triangle::new(
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(2.0, 0.0, 0.0),
            Vector3::new(0.0, 2.0, 0.0),
        );
        let p = Vector3::new(0.5, 0.5, 5.0);
        let q = tri.closest_point(p);
        // Closest point is the projection onto the plane —
        // directly below at z=0.
        assert!((q.x - 0.5).abs() < 1e-3 && (q.y - 0.5).abs() < 1e-3);
        assert!(q.z.abs() < 1e-3, "closest_point z should be 0, got {:.4}", q.z);
    }

    #[test]
    fn triangle_closest_point_outside_clamps_to_edge_or_vertex() {
        let tri = Triangle::new(
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(2.0, 0.0, 0.0),
            Vector3::new(0.0, 2.0, 0.0),
        );
        // Far past v0 in -X, -Y → closest is v0.
        let q = tri.closest_point(Vector3::new(-5.0, -5.0, 0.0));
        assert!((q.x - 0.0).abs() < 1e-3 && (q.y - 0.0).abs() < 1e-3);
        // Far past v1 in +X → closest is v1.
        let q = tri.closest_point(Vector3::new(10.0, 0.0, 0.0));
        assert!((q.x - 2.0).abs() < 1e-3 && (q.y - 0.0).abs() < 1e-3);
        // Above the (v1, v2) hypotenuse → closest is on that edge.
        // Edge midpoint is (1, 1, 0); query point (2, 2, 0) lies
        // on the line through midpoint perpendicular to the edge.
        let q = tri.closest_point(Vector3::new(2.0, 2.0, 0.0));
        assert!(
            (q.x - 1.0).abs() < 1e-3 && (q.y - 1.0).abs() < 1e-3,
            "expected hypotenuse midpoint (1, 1); got ({:.3}, {:.3})",
            q.x,
            q.y
        );
    }

    // ── DIM5-2 quaternion ops (root-motion orientation accumulator) ──────────

    fn quat_close(a: Quaternion, b: Quaternion, eps: f32) -> bool {
        (a.w - b.w).abs() < eps
            && (a.x - b.x).abs() < eps
            && (a.y - b.y).abs() < eps
            && (a.z - b.z).abs() < eps
    }

    /// 90° yaw about +Z (the only non-identity orientation authored in retail
    /// root motion — gate probe 2026-06-05 confirmed all pos_frame.orientation
    /// is pure-Z).
    fn yaw_z(deg: f32) -> Quaternion {
        let h = deg.to_radians() * 0.5;
        Quaternion { w: h.cos(), x: 0.0, y: 0.0, z: h.sin() }
    }

    #[test]
    fn quat_multiply_identity_is_noop() {
        let q = yaw_z(37.0);
        assert!(quat_close(Quaternion::identity().multiply(q), q, 1e-6));
        assert!(quat_close(q.multiply(Quaternion::identity()), q, 1e-6));
    }

    #[test]
    fn quat_multiply_composes_yaw_additively() {
        // 30° then 60° about Z == 90° about Z.
        let composed = yaw_z(30.0).multiply(yaw_z(60.0)).normalize();
        assert!(quat_close(composed, yaw_z(90.0), 1e-5));
    }

    #[test]
    fn quat_conjugate_undoes_rotation() {
        let q = yaw_z(90.0);
        // q * conj(q) == identity for a unit quaternion.
        assert!(quat_close(q.multiply(q.conjugate()).normalize(), Quaternion::identity(), 1e-5));
    }

    #[test]
    fn quat_normalize_unitizes() {
        let q = Quaternion { w: 2.0, x: 0.0, y: 0.0, z: 0.0 };
        let n = q.normalize();
        assert!(quat_close(n, Quaternion::identity(), 1e-6));
        // Zero-magnitude is returned unchanged (no NaN).
        let z = Quaternion { w: 0.0, x: 0.0, y: 0.0, z: 0.0 };
        assert!(quat_close(z.normalize(), z, 1e-6));
    }

    #[test]
    fn quat_rotate_vector_yaw_90_x_to_y() {
        // +90° about Z sends +X to +Y (right-handed).
        let v = yaw_z(90.0).rotate_vector(Vector3::new(1.0, 0.0, 0.0));
        assert!((v.x - 0.0).abs() < 1e-5 && (v.y - 1.0).abs() < 1e-5 && (v.z - 0.0).abs() < 1e-5,
            "got ({:.4},{:.4},{:.4})", v.x, v.y, v.z);
    }

    fn mat_close(a: &[f32; 9], b: &[f32; 9], eps: f32) -> bool {
        a.iter().zip(b.iter()).all(|(x, y)| (x - y).abs() < eps)
    }

    /// A non-axis-aligned unit quaternion (tilt about (1,1,0)) to exercise the
    /// non-yaw `from_rotation_matrix` pivots and the full SLERP path.
    fn tilt() -> Quaternion {
        let h = 50.0_f32.to_radians() * 0.5;
        let s = h.sin() / 2.0_f32.sqrt();
        Quaternion { w: h.cos(), x: s, y: s, z: 0.0 }.normalize()
    }

    #[test]
    fn quat_to_matrix_equals_rotate_vector_basis() {
        // to_rotation_matrix MUST equal the column-major basis built from
        // rotate_vector on the unit axes — that is exactly `frame_from`'s
        // construction and retail `Frame::cache` (acclient.c:356984). This is the
        // faithfulness anchor that lets the bridge round-trip frames losslessly.
        for q in [Quaternion::identity(), yaw_z(90.0), yaw_z(217.0), tilt()] {
            let m = q.to_rotation_matrix();
            let cx = q.rotate_vector(Vector3::new(1.0, 0.0, 0.0));
            let cy = q.rotate_vector(Vector3::new(0.0, 1.0, 0.0));
            let cz = q.rotate_vector(Vector3::new(0.0, 0.0, 1.0));
            let basis = [cx.x, cx.y, cx.z, cy.x, cy.y, cy.z, cz.x, cz.y, cz.z];
            assert!(mat_close(&m, &basis, 1e-5), "q={q:?} m={m:?} basis={basis:?}");
        }
    }

    #[test]
    fn quat_matrix_roundtrip_preserves_rotation() {
        // from_rotation_matrix inverts to_rotation_matrix over SO(3) (up to q/−q,
        // which has the same matrix). Covers trace>0 (yaw) + every diagonal pivot
        // (180° about X/Y/Z + the tilt).
        let cases = [
            Quaternion::identity(),
            yaw_z(90.0),
            yaw_z(180.0),
            Quaternion { w: 0.0, x: 1.0, y: 0.0, z: 0.0 }, // 180° about X (m00 pivot)
            Quaternion { w: 0.0, x: 0.0, y: 1.0, z: 0.0 }, // 180° about Y (m11 pivot)
            tilt(),
        ];
        for q in cases {
            let m = q.to_rotation_matrix();
            let recovered = Quaternion::from_rotation_matrix(&m);
            assert!(
                mat_close(&recovered.to_rotation_matrix(), &m, 1e-5),
                "roundtrip lost rotation: q={q:?} m={m:?} recovered={recovered:?}"
            );
        }
    }

    #[test]
    fn quat_slerp_hits_endpoints() {
        // slerp(a,b,0)==a and slerp(a,b,1)==b (compared as matrices: q/−q agnostic).
        let a = yaw_z(20.0);
        let b = tilt();
        assert!(mat_close(&Quaternion::slerp(a, b, 0.0).to_rotation_matrix(), &a.to_rotation_matrix(), 1e-5));
        assert!(mat_close(&Quaternion::slerp(a, b, 1.0).to_rotation_matrix(), &b.to_rotation_matrix(), 1e-5));
    }

    #[test]
    fn quat_slerp_midpoint_is_half_rotation() {
        // Halfway from identity to a 90° yaw is a 45° yaw (constant angular rate —
        // the property Lerp lacks and SLERP guarantees).
        let mid = Quaternion::slerp(Quaternion::identity(), yaw_z(90.0), 0.5);
        assert!(
            mat_close(&mid.to_rotation_matrix(), &yaw_z(45.0).to_rotation_matrix(), 1e-5),
            "slerp midpoint not 45°: {:?}", mid
        );
    }

    #[test]
    fn quat_slerp_takes_short_arc() {
        // identity → 270° yaw: the short way is −90°. SLERP must negate the target
        // (cosom<0) and land the midpoint at 315° (−45°), NOT 135°.
        let mid = Quaternion::slerp(Quaternion::identity(), yaw_z(270.0), 0.5);
        assert!(
            mat_close(&mid.to_rotation_matrix(), &yaw_z(315.0).to_rotation_matrix(), 1e-5),
            "short-arc failed: midpoint {:?} should be 315°, not 135°", mid
        );
    }

    #[test]
    fn quat_slerp_near_identical_linear_fallback_no_nan() {
        // Nearly equal endpoints take the linear branch (1−cosom ≤ 0.00019999999)
        // — must stay finite and land between the endpoints.
        let a = yaw_z(30.0);
        let b = yaw_z(30.01);
        let r = Quaternion::slerp(a, b, 0.5);
        assert!(r.w.is_finite() && r.x.is_finite() && r.y.is_finite() && r.z.is_finite());
        assert!(quat_close(r, a, 1e-3), "near-identical slerp drifted: {r:?}");
    }
}
