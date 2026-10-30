//! Lane B — rig part poses (and, for later stages, their local matrices).
//!
//! The JS it replaces, operation for operation: `scene3d/motion/
//! motion_sequence.js` `poseRigAt` (with `poseInPlaceExact` and
//! `inPlaceDisplacement`) — the per-part pose of a rig at one global frame of
//! a baked clip: the position and quaternion written into each part Group.
//!
//! The clip buffers (`partFrames` / `posFrames` / `rootFrames` of animation.js
//! `buildSequenceDescriptor`) are registered ONCE per descriptor
//! ([`RigSet::register`]); a pose is then one call per posed entity per frame
//! ([`RigSet::pose`]) that writes [`POSE_FLOATS_PER_PART`] f64 per part
//! (`px py pz qx qy qz qw`) into [`RigSet::out`]. The JS bridge
//! (scene3d/rust/rig.js) writes those into the part's position and the
//! quaternion's raw fields — no `onChange`, so no Euler re-derivation — and
//! three composes and multiplies the part matrices in its scene walk exactly
//! as before.
//!
//! [`RigSet::pose_matrices`] additionally writes each part's local matrix,
//! `Matrix4.compose(position, quaternion, (1,1,1))` — what
//! `Object3D.updateMatrix` computes for a unit-scale, pivot-less part
//! ([`MATRIX_FLOATS_PER_PART`] f64 per part). The bridge does NOT use it:
//! measured (docs/2026-10-26-rust-rig.md "Measurements"), writing the 16
//! elements from JS costs more than three's own compose while three keeps a
//! matrix per part object. It is here, pinned bit for bit, for the stages that
//! move the matrices themselves into Rust.
//!
//! Why one call per ENTITY and not one per frame: the lane doc ("Ordering").
//!
//! Exactness: no transcendental function is involved, so every output is
//! bit-identical to the JS (f64 throughout; the clip buffers are the f32
//! values a `Float32Array` holds, widened exactly as a JS read widens them).
//! Pinned by tests/rig_parity.rs against tools/rust_parity/gen_rig.mjs.

use crate::math::{Mat4, Quat, Vec3};

/// `FLOATS_PER_PART_PER_FRAME` of motion_sequence.js: `(x, y, z, qw, qx, qy, qz)`.
pub const FLOATS_PER_PART_PER_FRAME: usize = 7;
/// One `rootFrames` row: `[tx, ty, tz, qw, qx, qy, qz]` (AC w-first).
pub const ROOT_FLOATS_PER_FRAME: usize = 7;
/// [`RigSet::pose`] output per part: `px, py, pz, qx, qy, qz, qw` (the
/// arguments of poseRigAt's `position.set` / `quaternion.set`).
pub const POSE_FLOATS_PER_PART: usize = 7;
/// [`RigSet::pose_matrices`] output per part: the pose, then the local
/// matrix's `e0, e1, e2, e4, e5, e6, e8, e9, e10` (`Matrix4.elements`; the rest
/// is fixed by `compose`: `e3 = e7 = e11 = 0`, `e12..e14 = p`, `e15 = 1`).
pub const MATRIX_FLOATS_PER_PART: usize = 16;

/// `|x| < IDENT_EPS` on all three vector components of the inverse root
/// rotation skips the rotation in `poseInPlaceExact` (`1e-7` there).
const IDENT_EPS: f64 = 1e-7;

/// Which branch of `poseRigAt` runs. The JS bridge picks it exactly as
/// `poseRigAt` does: `inPlace && !RENDER_ROOT_MOTION` selects an in-place
/// mode, `IN_PLACE_EXACT` (the `?inPlaceExact` flag) selects the exact one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PoseMode {
    /// Raw part frames plus the `posFrames` root motion (one-shots, held
    /// state cycles, `?renderRootMotion=on`).
    Raw,
    /// In place by subtracting the mean drift of all parts
    /// (`inPlaceDisplacement`; `?inPlaceExact=off`, or no root frames).
    InPlaceMean,
    /// In place by undoing the folded root frame exactly
    /// (`poseInPlaceExact`); falls back to [`PoseMode::InPlaceMean`] when the
    /// descriptor carries no valid `rootFrames`, as `poseRigAt` does.
    InPlaceExact,
}

impl PoseMode {
    /// The wire value the JS bridge passes: 0 raw, 1 mean drift, 2 exact.
    pub fn from_u32(m: u32) -> Option<PoseMode> {
        match m {
            0 => Some(PoseMode::Raw),
            1 => Some(PoseMode::InPlaceMean),
            2 => Some(PoseMode::InPlaceExact),
            _ => None,
        }
    }
}

/// One registered sequence descriptor (animation.js `buildSequenceDescriptor`,
/// or a drone gesture clip): the clip buffers, copied into Rust once.
#[derive(Clone, Debug)]
pub struct RigDescriptor {
    part_count: usize,
    num_frames: usize,
    /// `numFrames * partCount * 7` f32, `[(x,y,z, qw,qx,qy,qz) per part] per frame`.
    part_frames: Vec<f32>,
    /// `None` = the JS `posFrames` is absent/falsy (root motion reads 0).
    /// `Some` keeps ANY length: a read past the end is `undefined` in JS and
    /// turns the part position into NaN, which [`RigDescriptor::pose_into`]
    /// reproduces (an empty `posFrames` poses NaN — see drone/gestures.js).
    pos_frames: Option<Vec<f32>>,
    /// Only when `len == numFrames * 7` (the `poseInPlaceExact` gate).
    root_frames: Option<Vec<f32>>,
    /// `inPlaceDisplacement(desc)`: a `Float32Array(numFrames * 3)`, so every
    /// value is rounded to f32 on store exactly as the JS cache is.
    in_place_disp: Vec<f32>,
}

impl RigDescriptor {
    /// Validate and take the buffers. `None` when the shape cannot be posed
    /// by `poseRigAt` without reading out of range (zero parts or frames, or
    /// `part_frames.len() != num_frames * part_count * 7`); the bridge keeps
    /// such descriptors on the JS path. A `root_frames` of the wrong length is
    /// dropped (the JS exact pose returns false and falls back to mean drift).
    pub fn new(
        part_count: u32,
        num_frames: u32,
        part_frames: Vec<f32>,
        pos_frames: Option<Vec<f32>>,
        root_frames: Option<Vec<f32>>,
    ) -> Option<RigDescriptor> {
        let pc = part_count as usize;
        let nf = num_frames as usize;
        if pc == 0 || nf == 0 {
            return None;
        }
        let want = nf.checked_mul(pc)?.checked_mul(FLOATS_PER_PART_PER_FRAME)?;
        if part_frames.len() != want {
            return None;
        }
        let root_frames = root_frames.filter(|rf| Some(rf.len()) == nf.checked_mul(ROOT_FLOATS_PER_FRAME));
        let in_place_disp = in_place_displacement(&part_frames, pc, nf);
        Some(RigDescriptor { part_count: pc, num_frames: nf, part_frames, pos_frames, root_frames, in_place_disp })
    }

    pub fn part_count(&self) -> usize {
        self.part_count
    }

    pub fn num_frames(&self) -> usize {
        self.num_frames
    }

    pub fn has_root_frames(&self) -> bool {
        self.root_frames.is_some()
    }

    pub fn has_pos_frames(&self) -> bool {
        self.pos_frames.is_some()
    }

    /// f32 values held (part + pos + root frames + the displacement cache).
    pub fn float_count(&self) -> usize {
        self.part_frames.len()
            + self.pos_frames.as_ref().map_or(0, |v| v.len())
            + self.root_frames.as_ref().map_or(0, |v| v.len())
            + self.in_place_disp.len()
    }

    /// The mean-drift displacement of frame `f` (`inPlaceDisplacement(desc)`
    /// rows), as the f32 the JS cache stores.
    pub fn in_place_displacement_row(&self, f: usize) -> [f32; 3] {
        let d = &self.in_place_disp;
        [d[f * 3], d[f * 3 + 1], d[f * 3 + 2]]
    }

    /// Pose `n` parts at frame `frame` into `out` ([`POSE_FLOATS_PER_PART`]
    /// f64 per part, part `p` at `p * POSE_FLOATS_PER_PART`): exactly the
    /// values poseRigAt passes to `position.set` / `quaternion.set`. `frame`
    /// is the value `poseRigAt` indexes with (`globalFrame | 0`, clamped to
    /// `[0, numFrames)`; clamped again here); `n` is
    /// `Math.min(partCount, partGroups.length)` (clamped to `partCount` and to
    /// what `out` holds). Returns the number of parts written.
    pub fn pose_into(&self, frame: u32, mode: PoseMode, n: usize, out: &mut [f64]) -> usize {
        let n = n.min(out.len() / POSE_FLOATS_PER_PART);
        self.pose_each(frame, mode, n, |p, px, py, pz, qx, qy, qz, qw| {
            let o = &mut out[p * POSE_FLOATS_PER_PART..(p + 1) * POSE_FLOATS_PER_PART];
            o[0] = px;
            o[1] = py;
            o[2] = pz;
            o[3] = qx;
            o[4] = qy;
            o[5] = qz;
            o[6] = qw;
        })
    }

    /// [`RigDescriptor::pose_into`] plus each part's local matrix
    /// ([`MATRIX_FLOATS_PER_PART`] f64 per part): `Matrix4.compose(position,
    /// quaternion, (1,1,1))`, i.e. three's `Object3D.updateMatrix` for a
    /// unit-scale part without a pivot (×1 is exact, so this IS three's
    /// compose bit for bit).
    pub fn pose_matrices_into(&self, frame: u32, mode: PoseMode, n: usize, out: &mut [f64]) -> usize {
        let n = n.min(out.len() / MATRIX_FLOATS_PER_PART);
        self.pose_each(frame, mode, n, |p, px, py, pz, qx, qy, qz, qw| {
            let m = Mat4::compose(Vec3::new(px, py, pz), Quat::new(qx, qy, qz, qw), Vec3::ONE);
            let e = &m.e;
            let o = &mut out[p * MATRIX_FLOATS_PER_PART..(p + 1) * MATRIX_FLOATS_PER_PART];
            o[0] = px;
            o[1] = py;
            o[2] = pz;
            o[3] = qx;
            o[4] = qy;
            o[5] = qz;
            o[6] = qw;
            o[7] = e[0];
            o[8] = e[1];
            o[9] = e[2];
            o[10] = e[4];
            o[11] = e[5];
            o[12] = e[6];
            o[13] = e[8];
            o[14] = e[9];
            o[15] = e[10];
        })
    }

    /// poseRigAt for parts `0..n`: calls `put(p, px, py, pz, qx, qy, qz, qw)`
    /// per part with the values poseRigAt writes. Returns the parts posed.
    fn pose_each<F>(&self, frame: u32, mode: PoseMode, n: usize, mut put: F) -> usize
    where
        F: FnMut(usize, f64, f64, f64, f64, f64, f64, f64),
    {
        let pc = self.part_count;
        let f = (frame as usize).min(self.num_frames - 1);
        let n = n.min(pc);
        let pf = &self.part_frames;
        if let (PoseMode::InPlaceExact, Some(rf)) = (mode, self.root_frames.as_ref()) {
            // poseInPlaceExact
            let r = f * ROOT_FLOATS_PER_FRAME;
            let tx = rf[r] as f64;
            let ty = rf[r + 1] as f64;
            let tz = rf[r + 2] as f64;
            // R⁻¹ = conj(R) for a unit quaternion (w-first).
            let iw = rf[r + 3] as f64;
            let ix = -(rf[r + 4] as f64);
            let iy = -(rf[r + 5] as f64);
            let iz = -(rf[r + 6] as f64);
            let ident = ix.abs() < IDENT_EPS && iy.abs() < IDENT_EPS && iz.abs() < IDENT_EPS;
            for p in 0..n {
                let base = (f * pc + p) * FLOATS_PER_PART_PER_FRAME;
                let mut px = pf[base] as f64 - tx;
                let mut py = pf[base + 1] as f64 - ty;
                let mut pz = pf[base + 2] as f64 - tz;
                let mut qw = pf[base + 3] as f64;
                let mut qx = pf[base + 4] as f64;
                let mut qy = pf[base + 5] as f64;
                let mut qz = pf[base + 6] as f64;
                if !ident {
                    // v' = v + 2w(u×v) + 2u×(u×v), u = (ix, iy, iz), w = iw.
                    let cx = iy * pz - iz * py;
                    let cy = iz * px - ix * pz;
                    let cz = ix * py - iy * px;
                    let ccx = iy * cz - iz * cy;
                    let ccy = iz * cx - ix * cz;
                    let ccz = ix * cy - iy * cx;
                    px += 2.0 * (iw * cx + ccx);
                    py += 2.0 * (iw * cy + ccy);
                    pz += 2.0 * (iw * cz + ccz);
                    // q' = R⁻¹ ⊗ q (Hamilton, w-first).
                    let w2 = iw * qw - ix * qx - iy * qy - iz * qz;
                    let x2 = iw * qx + ix * qw + iy * qz - iz * qy;
                    let y2 = iw * qy - ix * qz + iy * qw + iz * qx;
                    let z2 = iw * qz + ix * qy - iy * qx + iz * qw;
                    qw = w2;
                    qx = x2;
                    qy = y2;
                    qz = z2;
                }
                put(p, px, py, pz, qx, qy, qz, qw);
            }
            return n;
        }
        // The root offset added to every part: minus the mean drift (in
        // place) or the posFrames root motion (raw).
        let (rx, ry, rz) = match mode {
            PoseMode::InPlaceExact | PoseMode::InPlaceMean => {
                let d = &self.in_place_disp;
                (-(d[f * 3] as f64), -(d[f * 3 + 1] as f64), -(d[f * 3 + 2] as f64))
            }
            // `posFrames ? posFrames[f * 3 + k] : 0` — past the end is
            // `undefined`, and `x + undefined` is NaN.
            PoseMode::Raw => match self.pos_frames.as_ref() {
                None => (0.0, 0.0, 0.0),
                Some(v) => {
                    let at = |i: usize| v.get(i).map_or(f64::NAN, |x| *x as f64);
                    (at(f * 3), at(f * 3 + 1), at(f * 3 + 2))
                }
            },
        };
        for p in 0..n {
            let base = (f * pc + p) * FLOATS_PER_PART_PER_FRAME;
            // position.set(pf + r), quaternion.set(qx, qy, qz, qw) from the
            // w-first frame.
            put(
                p,
                pf[base] as f64 + rx,
                pf[base + 1] as f64 + ry,
                pf[base + 2] as f64 + rz,
                pf[base + 4] as f64,
                pf[base + 5] as f64,
                pf[base + 6] as f64,
                pf[base + 3] as f64,
            );
        }
        n
    }
}

/// `inPlaceDisplacement(desc)` — the per-frame common translation of all
/// parts relative to frame 0, in the JS accumulation order, stored as f32.
fn in_place_displacement(pf: &[f32], pc: usize, nf: usize) -> Vec<f32> {
    let mut disp = vec![0.0f32; nf * 3];
    if pc > 0 && nf > 0 {
        let pcf = pc as f64;
        let mut c0x = 0.0f64;
        let mut c0y = 0.0f64;
        let mut c0z = 0.0f64;
        for p in 0..pc {
            let b = p * FLOATS_PER_PART_PER_FRAME;
            c0x += pf[b] as f64;
            c0y += pf[b + 1] as f64;
            c0z += pf[b + 2] as f64;
        }
        c0x /= pcf;
        c0y /= pcf;
        c0z /= pcf;
        for f in 0..nf {
            let mut cx = 0.0f64;
            let mut cy = 0.0f64;
            let mut cz = 0.0f64;
            for p in 0..pc {
                let b = (f * pc + p) * FLOATS_PER_PART_PER_FRAME;
                cx += pf[b] as f64;
                cy += pf[b + 1] as f64;
                cz += pf[b + 2] as f64;
            }
            // Float32Array store: round to nearest, ties to even (`as f32`).
            disp[f * 3] = (cx / pcf - c0x) as f32;
            disp[f * 3 + 1] = (cy / pcf - c0y) as f32;
            disp[f * 3 + 2] = (cz / pcf - c0z) as f32;
        }
    }
    disp
}

/// The registered descriptors plus the shared pose output buffer.
///
/// Ids are `slot + 1` (0 is never an id, so JS can use it as "not
/// registered"); a freed slot is reused by the next registration. The output
/// buffer only grows in [`RigSet::register`] (sized for the
/// [`MATRIX_FLOATS_PER_PART`] layout of the largest descriptor) — a pose never
/// allocates, so the pointer the bridge caches stays valid between
/// registrations.
#[derive(Debug, Default)]
pub struct RigSet {
    slots: Vec<Option<RigDescriptor>>,
    free: Vec<usize>,
    out: Vec<f64>,
    live: usize,
    floats: usize,
}

impl RigSet {
    pub fn new() -> RigSet {
        RigSet::default()
    }

    /// Register a descriptor; returns its id (never 0).
    pub fn register(&mut self, d: RigDescriptor) -> u32 {
        let need = d.part_count * MATRIX_FLOATS_PER_PART;
        if self.out.len() < need {
            self.out.resize(need, 0.0);
        }
        self.floats += d.float_count();
        self.live += 1;
        let slot = match self.free.pop() {
            Some(s) => {
                self.slots[s] = Some(d);
                s
            }
            None => {
                self.slots.push(Some(d));
                self.slots.len() - 1
            }
        };
        (slot + 1) as u32
    }

    /// Drop a descriptor. False when `id` is not registered.
    pub fn unregister(&mut self, id: u32) -> bool {
        let Some(slot) = (id as usize).checked_sub(1) else { return false };
        let Some(entry) = self.slots.get_mut(slot) else { return false };
        let Some(d) = entry.take() else { return false };
        self.floats -= d.float_count();
        self.live -= 1;
        self.free.push(slot);
        true
    }

    pub fn get(&self, id: u32) -> Option<&RigDescriptor> {
        let slot = (id as usize).checked_sub(1)?;
        self.slots.get(slot)?.as_ref()
    }

    /// Pose descriptor `id` at `frame` in `mode` (0 raw, 1 mean drift, 2
    /// exact — [`PoseMode::from_u32`]) for `n` parts into [`RigSet::out`]
    /// ([`POSE_FLOATS_PER_PART`] layout). Returns the parts written; 0 for an
    /// unknown id or mode (the bridge then poses that rig through the JS path).
    pub fn pose(&mut self, id: u32, frame: u32, mode: u32, n: u32) -> u32 {
        let Some(mode) = PoseMode::from_u32(mode) else { return 0 };
        let Some(slot) = (id as usize).checked_sub(1) else { return 0 };
        let Some(Some(d)) = self.slots.get(slot) else { return 0 };
        d.pose_into(frame, mode, n as usize, &mut self.out) as u32
    }

    /// [`RigSet::pose`] with each part's local matrix
    /// ([`MATRIX_FLOATS_PER_PART`] layout).
    pub fn pose_matrices(&mut self, id: u32, frame: u32, mode: u32, n: u32) -> u32 {
        let Some(mode) = PoseMode::from_u32(mode) else { return 0 };
        let Some(slot) = (id as usize).checked_sub(1) else { return 0 };
        let Some(Some(d)) = self.slots.get(slot) else { return 0 };
        d.pose_matrices_into(frame, mode, n as usize, &mut self.out) as u32
    }

    /// The output buffer of the last [`RigSet::pose`] / [`RigSet::pose_matrices`].
    pub fn out(&self) -> &[f64] {
        &self.out
    }

    /// Live descriptors.
    pub fn len(&self) -> usize {
        self.live
    }

    pub fn is_empty(&self) -> bool {
        self.live == 0
    }

    /// f32 values held by all live descriptors.
    pub fn float_count(&self) -> usize {
        self.floats
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: usize = POSE_FLOATS_PER_PART;
    const M: usize = MATRIX_FLOATS_PER_PART;

    fn frames(pc: usize, nf: usize, mut f: impl FnMut(usize, usize) -> [f32; 7]) -> Vec<f32> {
        let mut v = Vec::with_capacity(pc * nf * 7);
        for fr in 0..nf {
            for p in 0..pc {
                v.extend_from_slice(&f(fr, p));
            }
        }
        v
    }

    #[test]
    fn rejects_unposeable_shapes() {
        assert!(RigDescriptor::new(0, 4, vec![], None, None).is_none());
        assert!(RigDescriptor::new(2, 0, vec![], None, None).is_none());
        assert!(RigDescriptor::new(2, 3, vec![0.0; 2 * 3 * 7 - 1], None, None).is_none());
        let d = RigDescriptor::new(2, 3, vec![0.0; 2 * 3 * 7], None, Some(vec![0.0; 3 * 7 - 1])).unwrap();
        assert!(!d.has_root_frames(), "a short rootFrames is dropped (mean-drift fallback)");
        let d = RigDescriptor::new(2, 3, vec![0.0; 2 * 3 * 7], None, Some(vec![0.0; 3 * 7])).unwrap();
        assert!(d.has_root_frames());
    }

    #[test]
    fn raw_pose_reorders_quaternion_and_composes() {
        // part p at frame f: pos (f*10+p, f, p), quat w-first (0.5,0.5,0.5,0.5).
        let pf = frames(2, 3, |f, p| [(f * 10 + p) as f32, f as f32, p as f32, 0.5, 0.5, 0.5, 0.5]);
        let pos = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0];
        let d = RigDescriptor::new(2, 3, pf, Some(pos), None).unwrap();
        let mut out = vec![0.0; 2 * P];
        assert_eq!(d.pose_into(1, PoseMode::Raw, 2, &mut out), 2);
        assert_eq!(&out[P..], &[11.0 + 4.0, 1.0 + 5.0, 1.0 + 6.0, 0.5, 0.5, 0.5, 0.5]);
        let mut outm = vec![0.0; 2 * M];
        assert_eq!(d.pose_matrices_into(1, PoseMode::Raw, 2, &mut outm), 2);
        let o = &outm[M..];
        assert_eq!(&o[..7], &out[P..]);
        let m = Mat4::compose(Vec3::new(15.0, 6.0, 7.0), Quat::new(0.5, 0.5, 0.5, 0.5), Vec3::ONE);
        assert_eq!(&o[7..], &[m.e[0], m.e[1], m.e[2], m.e[4], m.e[5], m.e[6], m.e[8], m.e[9], m.e[10]]);
    }

    #[test]
    fn raw_pose_past_the_end_of_pos_frames_is_nan_and_absent_is_zero() {
        let pf = frames(1, 2, |_, _| [1.0, 2.0, 3.0, 1.0, 0.0, 0.0, 0.0]);
        let mut out = vec![0.0; P];
        let empty = RigDescriptor::new(1, 2, pf.clone(), Some(vec![]), None).unwrap();
        empty.pose_into(0, PoseMode::Raw, 1, &mut out);
        assert!(out[0].is_nan() && out[1].is_nan() && out[2].is_nan());
        let absent = RigDescriptor::new(1, 2, pf, None, None).unwrap();
        absent.pose_into(1, PoseMode::Raw, 1, &mut out);
        assert_eq!(&out[..3], &[1.0, 2.0, 3.0]);
    }

    #[test]
    fn exact_identity_root_is_a_translation_only() {
        let pf = frames(1, 1, |_, _| [1.0, 2.0, 3.0, 1.0, 0.0, 0.0, 0.0]);
        let rf = vec![0.25, 0.5, 0.75, 1.0, 0.0, 0.0, 0.0];
        let d = RigDescriptor::new(1, 1, pf, None, Some(rf)).unwrap();
        let mut out = vec![0.0; P];
        d.pose_into(0, PoseMode::InPlaceExact, 1, &mut out);
        assert_eq!(&out[..7], &[0.75, 1.5, 2.25, 0.0, 0.0, 0.0, 1.0]);
    }

    #[test]
    fn exact_without_root_frames_falls_back_to_mean_drift() {
        let pf = frames(2, 2, |f, p| [(f * 3 + p) as f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]);
        let d = RigDescriptor::new(2, 2, pf, None, None).unwrap();
        let mut a = vec![0.0; 2 * P];
        let mut b = vec![0.0; 2 * P];
        d.pose_into(1, PoseMode::InPlaceExact, 2, &mut a);
        d.pose_into(1, PoseMode::InPlaceMean, 2, &mut b);
        assert_eq!(a, b);
        // frame 1 parts sit at x = 3, 4; the mean drift is 3 → 0, 1.
        assert_eq!((a[0], a[P]), (0.0, 1.0));
    }

    #[test]
    fn frame_and_part_counts_clamp() {
        let pf = frames(2, 2, |f, p| [(f * 10 + p) as f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]);
        let d = RigDescriptor::new(2, 2, pf, None, None).unwrap();
        let mut out = vec![0.0; 4 * P];
        assert_eq!(d.pose_into(99, PoseMode::Raw, 9, &mut out), 2);
        assert_eq!((out[0], out[P]), (10.0, 11.0));
        let mut short = vec![0.0; P + 3];
        assert_eq!(d.pose_into(0, PoseMode::Raw, 2, &mut short), 1, "never writes past `out`");
    }

    #[test]
    fn ids_reuse_slots_and_out_grows_only_on_register() {
        let mut set = RigSet::new();
        let small = RigDescriptor::new(1, 1, vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0], None, None).unwrap();
        let a = set.register(small.clone());
        assert_eq!(a, 1);
        assert_eq!(set.out().len(), M);
        let big = RigDescriptor::new(3, 1, vec![0.0; 21], None, None).unwrap();
        let b = set.register(big);
        assert_eq!(set.out().len(), 3 * M);
        assert_eq!(set.len(), 2);
        assert!(set.unregister(a));
        assert!(!set.unregister(a));
        assert_eq!(set.pose(a, 0, 0, 1), 0, "a freed id poses nothing");
        assert_eq!(set.register(small), a, "the freed slot is reused");
        assert_eq!(set.pose(b, 0, 0, 3), 3);
        assert_eq!(set.pose_matrices(b, 0, 0, 3), 3);
        assert_eq!(set.pose(b, 0, 3, 3), 0, "unknown mode");
        assert_eq!(set.pose_matrices(b, 0, 3, 3), 0, "unknown mode");
        assert_eq!(set.pose(0, 0, 0, 3), 0, "id 0 is never registered");
        assert_eq!(set.float_count(), 7 + 3 + 21 + 3);
    }
}
