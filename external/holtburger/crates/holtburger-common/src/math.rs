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
}
