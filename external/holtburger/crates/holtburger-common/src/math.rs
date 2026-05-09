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
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, BinRead, BinWrite)]
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
        dist_sq <= r_sum * r_sum
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
}
