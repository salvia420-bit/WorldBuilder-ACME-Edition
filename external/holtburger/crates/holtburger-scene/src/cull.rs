//! Lane C — the static world's per-frame cull (scene3d/culling.js
//! `FrustumCuller`, statics.js `cullStaticsGroup` / `_cullStaticsWalk`).
//!
//! # What is here
//!
//! - [`Plane`], [`Frustum`], [`Sphere`]: three.js r184 `Plane.setComponents` /
//!   `normalize` / `distanceToPoint`, `Frustum.setFromProjectionMatrix` (both
//!   coordinate systems, `reversedDepth` true and false) /
//!   `intersectsSphere`, and `Sphere.applyMatrix4`, copied operation for
//!   operation (node_modules/three/src/math/{Plane,Frustum,Sphere}.js). They
//!   are meant to move into [`crate::math`] (the orchestrator owns it); they
//!   live here until then and are pinned bit-exact by tests/cull_parity.rs.
//! - [`statics_sphere_visible`]: the walk's per-node verdict — the frustum
//!   test, then the opt-in `?cullDist` horizon (`FrustumCuller.getDistanceSq`
//!   against `(cullHorizon + r)²`).
//! - [`StaticsCull`]: the flat registry the bridge (scene3d/rust/cull.js)
//!   keeps in sync with `staticsGroup.children`. A slot holds an AC-space cull
//!   sphere (or none). One [`StaticsCull::frame`] call per walk builds the
//!   frustum from the AC-space MVP the JS culler already computed and writes
//!   one visibility bit per slot.
//!
//! # The cut
//!
//! The walk's per-node POLICY (which nodes it skips, forces visible or
//! hidden: particles, frozen anchors, animated-scenery buckets, dead batches,
//! film hides, nodes without bounds, light owners) reads JavaScript objects
//! and changes only when a node is added, removed or re-marked, so the bridge
//! evaluates it in JS on those events. What runs here is the part that ran
//! for every node on every moving frame: six plane tests and the distance
//! test, over immobile data. JS reads the bits and applies them.
//!
//! # Exactness
//!
//! No transcendental function is involved: the plane extraction is adds,
//! subtracts, one `sqrt` (correctly rounded in IEEE-754, as is V8's
//! `Math.sqrt`) and one division per plane; the tests are multiply-adds in
//! the JS evaluation order. So every plane coefficient and every verdict is
//! bit-identical to the JS (Rust does not contract `a * b + c` into a fused
//! multiply-add).

use crate::math::{Mat4, Vec3};

/// `THREE.WebGLCoordinateSystem`.
pub const WEBGL_COORDINATE_SYSTEM: u32 = 2000;
/// `THREE.WebGPUCoordinateSystem`.
pub const WEBGPU_COORDINATE_SYSTEM: u32 = 2001;

/// `THREE.Plane`: `normal · p + constant = 0`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Plane {
    pub normal: Vec3,
    pub constant: f64,
}

impl Default for Plane {
    /// three's `new Plane()`: normal (1, 0, 0), constant 0.
    fn default() -> Self {
        Plane { normal: Vec3::new(1.0, 0.0, 0.0), constant: 0.0 }
    }
}

impl Plane {
    /// `Plane.setComponents(x, y, z, w)`.
    #[inline]
    pub const fn from_components(x: f64, y: f64, z: f64, w: f64) -> Plane {
        Plane { normal: Vec3::new(x, y, z), constant: w }
    }

    /// `Plane.normalize`:
    /// `inverseNormalLength = 1.0 / normal.length()`,
    /// `normal.multiplyScalar(inverseNormalLength)`,
    /// `constant *= inverseNormalLength`.
    /// A zero normal divides by zero exactly as three does (Infinity, then
    /// NaN components), and every test against it then passes (NaN compares
    /// false), as in JS.
    #[inline]
    pub fn normalize(self) -> Plane {
        let inverse_normal_length = 1.0 / self.normal.length();
        Plane {
            normal: self.normal.scale(inverse_normal_length),
            constant: self.constant * inverse_normal_length,
        }
    }

    /// `Plane.distanceToPoint(point)` = `normal.dot(point) + constant`.
    #[inline]
    pub fn distance_to_point(&self, point: Vec3) -> f64 {
        self.normal.dot(point) + self.constant
    }

    /// `[normal.x, normal.y, normal.z, constant]`.
    #[inline]
    pub fn to_array(&self) -> [f64; 4] {
        [self.normal.x, self.normal.y, self.normal.z, self.constant]
    }
}

/// `THREE.Frustum` (six planes: right, left, bottom, top, far, near — in
/// three's index order).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frustum {
    pub planes: [Plane; 6],
}

impl Default for Frustum {
    fn default() -> Self {
        Frustum { planes: [Plane::default(); 6] }
    }
}

impl Frustum {
    /// `Frustum.setFromProjectionMatrix(m, coordinateSystem, reversedDepth)`.
    ///
    /// Returns `None` where three throws ("Invalid coordinate system"): a
    /// coordinate system other than WebGL / WebGPU with `reversed_depth`
    /// false. (three has already overwritten planes 0-4 when it throws; the
    /// JS culler never reaches its walk in that case, so neither does Rust.)
    pub fn from_projection_matrix(m: &Mat4, coordinate_system: u32, reversed_depth: bool) -> Option<Frustum> {
        let me = &m.e;
        let (me0, me1, me2, me3) = (me[0], me[1], me[2], me[3]);
        let (me4, me5, me6, me7) = (me[4], me[5], me[6], me[7]);
        let (me8, me9, me10, me11) = (me[8], me[9], me[10], me[11]);
        let (me12, me13, me14, me15) = (me[12], me[13], me[14], me[15]);

        let p0 = Plane::from_components(me3 - me0, me7 - me4, me11 - me8, me15 - me12).normalize();
        let p1 = Plane::from_components(me3 + me0, me7 + me4, me11 + me8, me15 + me12).normalize();
        let p2 = Plane::from_components(me3 + me1, me7 + me5, me11 + me9, me15 + me13).normalize();
        let p3 = Plane::from_components(me3 - me1, me7 - me5, me11 - me9, me15 - me13).normalize();

        let (p4, p5) = if reversed_depth {
            (
                // far
                Plane::from_components(me2, me6, me10, me14).normalize(),
                // near
                Plane::from_components(me3 - me2, me7 - me6, me11 - me10, me15 - me14).normalize(),
            )
        } else {
            // far
            let far = Plane::from_components(me3 - me2, me7 - me6, me11 - me10, me15 - me14).normalize();
            // near
            let near = match coordinate_system {
                WEBGL_COORDINATE_SYSTEM => {
                    Plane::from_components(me3 + me2, me7 + me6, me11 + me10, me15 + me14).normalize()
                }
                WEBGPU_COORDINATE_SYSTEM => Plane::from_components(me2, me6, me10, me14).normalize(),
                _ => return None,
            };
            (far, near)
        };

        Some(Frustum { planes: [p0, p1, p2, p3, p4, p5] })
    }

    /// `Frustum.intersectsSphere(sphere)`: false as soon as one plane has the
    /// centre further than `radius` behind it (`distance < -radius`).
    #[inline]
    pub fn intersects_sphere(&self, center: Vec3, radius: f64) -> bool {
        let neg_radius = -radius;
        for plane in &self.planes {
            let distance = plane.distance_to_point(center);
            if distance < neg_radius {
                return false;
            }
        }
        true
    }

    /// The 24 plane coefficients, `[nx, ny, nz, constant]` per plane.
    pub fn to_array(&self) -> [f64; 24] {
        let mut out = [0.0f64; 24];
        for (i, p) in self.planes.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&p.to_array());
        }
        out
    }
}

/// `THREE.Sphere` (centre, radius).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sphere {
    pub center: Vec3,
    pub radius: f64,
}

impl Sphere {
    #[inline]
    pub const fn new(center: Vec3, radius: f64) -> Sphere {
        Sphere { center, radius }
    }

    /// `Sphere.applyMatrix4(matrix)`: `center.applyMatrix4(matrix)`, then
    /// `radius = radius * matrix.getMaxScaleOnAxis()` (what three's
    /// `Frustum.intersectsObject` does with a node's matrixWorld).
    #[inline]
    pub fn apply_mat4(self, m: &Mat4) -> Sphere {
        Sphere { center: self.center.apply_mat4(m), radius: self.radius * m.max_scale_on_axis() }
    }
}

/// The statics walk's per-node verdict (statics.js `_cullStaticsWalk`, the
/// node that reached the frustum test): `culler.isSphereInFrustum(sphere)`,
/// then — only when `dist_enabled` (`?cullDist=N`) — the horizon test
/// `getDistanceSq(c) > (cullHorizon + r)²`. `cam` is `FrustumCuller._camAc`,
/// `horizon` is `Math.sqrt(CULL_DIST_SQ)`.
#[inline]
pub fn statics_sphere_visible(f: &Frustum, center: Vec3, radius: f64, cam: Vec3, dist_enabled: bool, horizon: f64) -> bool {
    let mut want = f.intersects_sphere(center, radius);
    if want && dist_enabled {
        // FrustumCuller.getDistanceSq(x, y, z)
        let dx = center.x - cam.x;
        let dy = center.y - cam.y;
        let dz = center.z - cam.z;
        let dist_sq = dx * dx + dy * dy + dz * dz;
        let padded = horizon + radius;
        if dist_sq > padded * padded {
            want = false;
        }
    }
    want
}

// ---------------------------------------------------------------------------
// The registry the bridge drives.
// ---------------------------------------------------------------------------

/// Input block (f64), written by JS through a view before [`StaticsCull::frame`]:
/// `FrustumCuller._mvp.elements` (16, column-major: projection ·
/// matrixWorldInverse · worldRoot.matrixWorld).
pub const IN_MVP: usize = 0;
/// `FrustumCuller._camAc` x, y, z (the camera in AC space).
pub const IN_CAM: usize = 16;
/// The camera's `coordinateSystem` (2000 WebGL / 2001 WebGPU).
pub const IN_COORDINATE_SYSTEM: usize = 19;
/// The camera's `reversedDepth` (0 / 1).
pub const IN_REVERSED_DEPTH: usize = 20;
/// The distance horizon is armed (`CULL_DIST_SQ !== Infinity`) (0 / 1).
pub const IN_DIST_ENABLED: usize = 21;
/// `Math.sqrt(CULL_DIST_SQ)` (metres; ignored when the horizon is off).
pub const IN_HORIZON: usize = 22;
/// Length of the input block.
pub const IN_LEN: usize = 24;

/// A registration record: `[slot, has_sphere (0/1), cx, cy, cz, radius]`.
pub const RECORD_LEN: usize = 6;
/// Slot ids above this are refused (a corrupt record, never a real scene).
pub const MAX_SLOTS: usize = 1 << 22;

/// The statics cull registry: one AC-space cull sphere per slot (or none),
/// one visibility bit per slot out.
#[derive(Clone, Debug)]
pub struct StaticsCull {
    input: Vec<f64>,
    has_sphere: Vec<u8>,
    cx: Vec<f64>,
    cy: Vec<f64>,
    cz: Vec<f64>,
    radius: Vec<f64>,
    bits: Vec<u32>,
    frustum: Frustum,
    spheres_tested: u32,
    spheres_visible: u32,
    frames: u64,
}

impl Default for StaticsCull {
    fn default() -> Self {
        StaticsCull::new()
    }
}

impl StaticsCull {
    pub fn new() -> StaticsCull {
        StaticsCull {
            input: vec![0.0; IN_LEN],
            has_sphere: Vec::new(),
            cx: Vec::new(),
            cy: Vec::new(),
            cz: Vec::new(),
            radius: Vec::new(),
            bits: Vec::new(),
            frustum: Frustum::default(),
            spheres_tested: 0,
            spheres_visible: 0,
            frames: 0,
        }
    }

    /// The input block (its address never changes: the Vec is never resized).
    #[inline]
    pub fn input(&self) -> &[f64] {
        &self.input
    }

    #[inline]
    pub fn input_mut(&mut self) -> &mut [f64] {
        &mut self.input
    }

    /// Slots known (highest registered slot + 1).
    #[inline]
    pub fn slot_count(&self) -> usize {
        self.has_sphere.len()
    }

    fn ensure_slot(&mut self, slot: usize) {
        if slot >= self.has_sphere.len() {
            let n = slot + 1;
            self.has_sphere.resize(n, 0);
            self.cx.resize(n, 0.0);
            self.cy.resize(n, 0.0);
            self.cz.resize(n, 0.0);
            self.radius.resize(n, 0.0);
        }
    }

    /// Register (`Some`) or clear (`None`) one slot's sphere. False for a slot
    /// past [`MAX_SLOTS`].
    pub fn set_slot(&mut self, slot: usize, sphere: Option<Sphere>) -> bool {
        if slot >= MAX_SLOTS {
            return false;
        }
        self.ensure_slot(slot);
        match sphere {
            Some(s) => {
                self.has_sphere[slot] = 1;
                self.cx[slot] = s.center.x;
                self.cy[slot] = s.center.y;
                self.cz[slot] = s.center.z;
                self.radius[slot] = s.radius;
            }
            None => {
                self.has_sphere[slot] = 0;
                self.cx[slot] = 0.0;
                self.cy[slot] = 0.0;
                self.cz[slot] = 0.0;
                self.radius[slot] = 0.0;
            }
        }
        true
    }

    /// The sphere registered in `slot`, if any.
    pub fn slot(&self, slot: usize) -> Option<Sphere> {
        if slot < self.has_sphere.len() && self.has_sphere[slot] != 0 {
            Some(Sphere::new(Vec3::new(self.cx[slot], self.cy[slot], self.cz[slot]), self.radius[slot]))
        } else {
            None
        }
    }

    /// Apply a batch of [`RECORD_LEN`]-float records, in order (a later record
    /// for the same slot wins). The whole batch is validated first: a length
    /// that is not a multiple of [`RECORD_LEN`] or a slot that is not an
    /// integer in `[0, MAX_SLOTS)` applies nothing and returns `None`.
    pub fn apply_records(&mut self, records: &[f64]) -> Option<usize> {
        if records.len() % RECORD_LEN != 0 {
            return None;
        }
        for rec in records.chunks_exact(RECORD_LEN) {
            let s = rec[0];
            if !(s >= 0.0 && s < MAX_SLOTS as f64 && s == s.trunc()) {
                return None;
            }
        }
        for rec in records.chunks_exact(RECORD_LEN) {
            let slot = rec[0] as usize;
            let sphere = if rec[1] != 0.0 { Some(Sphere::new(Vec3::new(rec[2], rec[3], rec[4]), rec[5])) } else { None };
            self.set_slot(slot, sphere);
        }
        Some(records.len() / RECORD_LEN)
    }

    /// Forget every slot (the bridge re-seeds after a desync).
    pub fn clear(&mut self) {
        self.has_sphere.clear();
        self.cx.clear();
        self.cy.clear();
        self.cz.clear();
        self.radius.clear();
        self.bits.clear();
        self.spheres_tested = 0;
        self.spheres_visible = 0;
    }

    /// One walk: build the frustum from the input block and test every slot
    /// that holds a sphere. Bit `i` of [`bits`](Self::bits) is slot `i`'s
    /// verdict (1 = visible); slots without a sphere read 0. Returns the slot
    /// count, or `None` (bits untouched) where three would throw building the
    /// frustum.
    pub fn frame(&mut self) -> Option<usize> {
        let inp = &self.input;
        let mut e = [0.0f64; 16];
        e.copy_from_slice(&inp[IN_MVP..IN_MVP + 16]);
        let mvp = Mat4::from_elements(e);
        // `as u32` saturates: NaN → 0, which is no coordinate system.
        let coordinate_system = inp[IN_COORDINATE_SYSTEM] as u32;
        let reversed_depth = inp[IN_REVERSED_DEPTH] != 0.0;
        let frustum = Frustum::from_projection_matrix(&mvp, coordinate_system, reversed_depth)?;
        let cam = Vec3::new(inp[IN_CAM], inp[IN_CAM + 1], inp[IN_CAM + 2]);
        let dist_enabled = inp[IN_DIST_ENABLED] != 0.0;
        let horizon = inp[IN_HORIZON];

        let n = self.has_sphere.len();
        self.bits.clear();
        self.bits.resize(n.div_ceil(32), 0);
        let mut tested = 0u32;
        let mut visible = 0u32;
        for i in 0..n {
            if self.has_sphere[i] == 0 {
                continue;
            }
            tested += 1;
            let c = Vec3::new(self.cx[i], self.cy[i], self.cz[i]);
            if statics_sphere_visible(&frustum, c, self.radius[i], cam, dist_enabled, horizon) {
                self.bits[i >> 5] |= 1u32 << (i & 31);
                visible += 1;
            }
        }
        self.frustum = frustum;
        self.spheres_tested = tested;
        self.spheres_visible = visible;
        self.frames += 1;
        Some(n)
    }

    /// The last frame's bits (`ceil(slot_count / 32)` words).
    #[inline]
    pub fn bits(&self) -> &[u32] {
        &self.bits
    }

    /// Slot `i`'s bit from the last frame.
    #[inline]
    pub fn visible(&self, slot: usize) -> bool {
        self.bits.get(slot >> 5).is_some_and(|&w| (w >> (slot & 31)) & 1 == 1)
    }

    /// The last frame's frustum.
    #[inline]
    pub fn frustum(&self) -> &Frustum {
        &self.frustum
    }

    /// Spheres tested / found visible by the last frame (diag).
    #[inline]
    pub fn last_counts(&self) -> (u32, u32) {
        (self.spheres_tested, self.spheres_visible)
    }

    /// Frames run (diag).
    #[inline]
    pub fn frames(&self) -> u64 {
        self.frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn persp() -> Mat4 {
        // three's makePerspective(-1, 1, 1, -1, 1, 100) (WebGL, not reversed):
        // a symmetric 90° frustum looking down -Z.
        let (near, far) = (1.0f64, 100.0f64);
        let x = 2.0 * near / 2.0;
        let y = 2.0 * near / 2.0;
        let c = -(far + near) / (far - near);
        let d = (-2.0 * far * near) / (far - near);
        Mat4::from_elements([x, 0.0, 0.0, 0.0, 0.0, y, 0.0, 0.0, 0.0, 0.0, c, -1.0, 0.0, 0.0, d, 0.0])
    }

    #[test]
    fn webgl_frustum_contains_points_in_front() {
        let f = Frustum::from_projection_matrix(&persp(), WEBGL_COORDINATE_SYSTEM, false).unwrap();
        assert!(f.intersects_sphere(Vec3::new(0.0, 0.0, -10.0), 0.0));
        assert!(!f.intersects_sphere(Vec3::new(0.0, 0.0, 10.0), 1.0), "behind the camera");
        assert!(!f.intersects_sphere(Vec3::new(0.0, 0.0, -200.0), 1.0), "past far");
        assert!(f.intersects_sphere(Vec3::new(0.0, 0.0, -200.0), 150.0), "a big sphere straddles far");
    }

    #[test]
    fn invalid_coordinate_system_is_refused_unless_reversed() {
        assert!(Frustum::from_projection_matrix(&persp(), 1234, false).is_none());
        assert!(Frustum::from_projection_matrix(&persp(), 1234, true).is_some());
    }

    #[test]
    fn plane_normalize_and_distance() {
        let p = Plane::from_components(0.0, 3.0, 4.0, 10.0).normalize();
        assert_eq!(p.normal, Vec3::new(0.0, 0.6000000000000001, 0.8));
        assert_eq!(p.constant, 2.0);
        assert_eq!(p.distance_to_point(Vec3::new(0.0, 0.0, 0.0)), 2.0);
        // A zero normal: three divides by zero; every test then passes.
        let z = Plane::from_components(0.0, 0.0, 0.0, 1.0).normalize();
        assert!(z.normal.x.is_nan() && z.constant.is_infinite());
    }

    #[test]
    fn distance_horizon_pads_by_radius() {
        let f = Frustum::from_projection_matrix(&persp(), WEBGL_COORDINATE_SYSTEM, false).unwrap();
        let cam = Vec3::ZERO;
        let c = Vec3::new(0.0, 0.0, -50.0);
        assert!(statics_sphere_visible(&f, c, 1.0, cam, false, 0.0));
        assert!(!statics_sphere_visible(&f, c, 1.0, cam, true, 40.0), "51 > 41");
        assert!(statics_sphere_visible(&f, c, 11.0, cam, true, 40.0), "50 <= 51");
    }

    #[test]
    fn registry_bits_follow_slots() {
        let mut k = StaticsCull::new();
        let recs = [
            0.0, 1.0, 0.0, 0.0, -10.0, 1.0, // slot 0: in front
            33.0, 1.0, 0.0, 0.0, 10.0, 1.0, // slot 33: behind
            34.0, 0.0, 0.0, 0.0, 0.0, 0.0, // slot 34: no sphere
            40.0, 1.0, 0.0, 0.0, -20.0, 0.5, // slot 40: in front
        ];
        assert_eq!(k.apply_records(&recs), Some(4));
        assert_eq!(k.apply_records(&[1.5, 0.0, 0.0, 0.0, 0.0, 0.0]), None, "fractional slot");
        assert_eq!(k.apply_records(&[0.0, 0.0]), None, "short record");
        k.input_mut()[IN_MVP..IN_MVP + 16].copy_from_slice(&persp().e);
        k.input_mut()[IN_COORDINATE_SYSTEM] = WEBGL_COORDINATE_SYSTEM as f64;
        assert_eq!(k.frame(), Some(41));
        assert_eq!(k.bits().len(), 2);
        assert!(k.visible(0) && !k.visible(33) && !k.visible(34) && k.visible(40));
        assert_eq!(k.last_counts(), (3, 2));
        // Clearing a slot drops its bit.
        assert_eq!(k.apply_records(&[40.0, 0.0, 0.0, 0.0, 0.0, 0.0]), Some(1));
        k.frame();
        assert!(!k.visible(40));
        // An invalid coordinate system leaves the bits as they were.
        k.input_mut()[IN_COORDINATE_SYSTEM] = 7.0;
        assert_eq!(k.frame(), None);
        assert!(k.visible(0));
    }
}
