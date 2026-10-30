//! Lane D — the per-DID template pose of DAT-animated scenery
//! (scene3d/animated_scenery.js, `?rustAnimScenery`). Lane notes:
//! apps/holtburger-web/docs/2026-10-26-rust-anim-terrain.md.
//!
//! # What this replaces
//!
//! animated_scenery.js keeps ONE shared driver per animation DID (a "group"):
//! a three.js `AnimationMixer` playing one `LoopRepeat` action of a clip built
//! by `buildSceneryAnimationClip` (a position `VectorKeyframeTrack` + a
//! `QuaternionKeyframeTrack` per part, linear interpolation), plus the retail
//! SetOmega orbit (`_advanceOrbit`). Every frame it advances every group, and
//! with `?animSceneryGpu` (default on) writes one row of the pose texture per
//! (DID, part) (`_updateGpuPoseRows` → `writePoseRow`). This kernel does all
//! of that in ONE call ([`AnimScenery::advance`]):
//!
//! - the mixer step: `AnimationMixer.update` → `AnimationAction._update`
//!   (`_updateTime` with LoopRepeat × Infinity, weight 1, time scale 1) →
//!   `Interpolant.evaluate` (the cached-index seek, `LinearInterpolant`,
//!   `QuaternionLinearInterpolant` → `Quaternion.slerpFlat`) →
//!   `PropertyMixer.accumulate` / `apply` (accu0/accu1 interleave; the binding
//!   is only written when the two differ, exactly like three) — three r184,
//!   operation for operation;
//! - the orbit: `orbitAngle = (orbitAngle + rad * hz * dt) % (2π)`,
//!   `orbitQ.setFromAxisAngle(axis, orbitAngle)`;
//! - the rows: `P = compose(part.position, part.quaternion, 1)`,
//!   `M = post ? P × post : P`, `writePoseRow(row, M, omega ? orbitQ : null)`.
//!
//! Outputs (flat, read by scene3d/rust/anim_scenery.js through views):
//! - [`AnimScenery::parts_out`]: per group, at its parts offset, `PART_STRIDE`
//!   f64 per part — the template part's `position` and `quaternion` exactly as
//!   three's `PropertyBinding` leaves them (the bridge writes them back, so the
//!   JS that still reads the template — CPU-posed slots, legacy per-mesh
//!   instances — sees bit-identical values);
//! - [`AnimScenery::group_out`]: per group slot, `GROUP_STRIDE` f64 — orbit
//!   quaternion, orbit angle, mixer time, action time;
//! - [`AnimScenery::rows_out`]: `ROW_FLOATS` f32 per pose-table row (row k+1 of
//!   anim_scenery_gpu.js at k * 32), and [`AnimScenery::rows_written`]: 1 when
//!   this frame's advance wrote row k (its group is in this kernel and has the
//!   part), the same condition under which `_updateGpuPoseRows` writes it.
//!
//! Exactness: everything is the JS arithmetic in the JS order, f64, with f32
//! keyframes and f32 row stores. `slerpFlat`'s slerp branch (`acos` / `sin`)
//! and the orbit's `sin` / `cos` are the only transcendental functions: V8's
//! fdlibm and the host libm may differ there by an ulp (lib.rs contract).

use crate::math::{Mat4, Quat, Vec3, js_max};

/// f64 per template part in [`AnimScenery::parts_out`]: px py pz qx qy qz qw.
pub const PART_STRIDE: usize = 7;
/// f64 per group slot in [`AnimScenery::group_out`]: orbit qx qy qz qw, orbit
/// angle, mixer time, action time.
pub const GROUP_STRIDE: usize = 7;
/// f32 per pose-table row (anim_scenery_gpu.js `POSE_TEXELS_PER_ROW * 4`).
pub const ROW_FLOATS: usize = 32;
/// animated_scenery.js `DEFAULT_ANIM_FPS` (the clip builder's fallback rate).
pub const DEFAULT_ANIM_FPS: f64 = 30.0;

/// Where `Interpolant.evaluate` landed for one `t`: a sample copy
/// (`copySampleValue_`, before the start / after the end) or the interval
/// `[i1 - 1, i1]` to interpolate.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Seek {
    Copy(usize),
    Interp { i1: usize, t0: f64, t1: f64 },
}

#[inline]
fn pp_at(pp: &[f32], i: isize) -> Option<f64> {
    if i >= 0 && (i as usize) < pp.len() { Some(pp[i as usize] as f64) } else { None }
}

/// JS `t < x` where `x` may be `undefined` (false).
#[inline]
fn lt(t: f64, x: Option<f64>) -> bool {
    match x {
        Some(v) => t < v,
        None => false,
    }
}

/// JS `t >= x` where `x` may be `undefined` (false).
#[inline]
fn ge(t: f64, x: Option<f64>) -> bool {
    match x {
        Some(v) => t >= v,
        None => false,
    }
}

/// `Interpolant.evaluate`'s interval seek (three r184), label for label.
/// `cached` is the interpolant's `_cachedIndex`, updated as three updates it.
pub fn seek(pp: &[f32], cached: &mut usize, t: f64) -> Seek {
    let n = pp.len() as isize;
    let mut i1: isize = *cached as isize;
    let mut t1 = pp_at(pp, i1);
    let mut t0 = pp_at(pp, i1 - 1);
    'validate_interval: {
        'seek: {
            let right: isize = 'linear_scan: {
                'forward_scan: {
                    if !lt(t, t1) {
                        let give_up_at = i1 + 2;
                        loop {
                            if t1.is_none() {
                                if lt(t, t0) {
                                    break 'forward_scan;
                                }
                                // after end
                                i1 = n;
                                *cached = i1 as usize;
                                return Seek::Copy((i1 - 1).max(0) as usize);
                            }
                            if i1 == give_up_at {
                                break; // this loop
                            }
                            t0 = t1;
                            i1 += 1;
                            t1 = pp_at(pp, i1);
                            if lt(t, t1) {
                                // we have arrived at the sought interval
                                break 'seek;
                            }
                        }
                        // prepare binary search on the right side of the index
                        break 'linear_scan n;
                    }
                }
                if !ge(t, t0) {
                    // looping?
                    let t1global = pp_at(pp, 1);
                    if lt(t, t1global) {
                        i1 = 2; // + 1, using the scan for the details
                        t0 = t1global;
                    }
                    // linear reverse scan
                    let give_up_at = i1 - 2;
                    loop {
                        if t0.is_none() {
                            // before start
                            *cached = 0;
                            return Seek::Copy(0);
                        }
                        if i1 == give_up_at {
                            break; // this loop
                        }
                        t1 = t0;
                        i1 -= 1;
                        t0 = pp_at(pp, i1 - 1);
                        if ge(t, t0) {
                            // we have arrived at the sought interval
                            break 'seek;
                        }
                    }
                    // prepare binary search on the left side of the index
                    let r = i1;
                    i1 = 0;
                    break 'linear_scan r;
                }
                // the interval is valid
                break 'validate_interval
            };
            // binary search
            let mut right = right;
            while i1 < right {
                let mid = (((i1 + right) as u32) >> 1) as isize;
                if t < pp[mid as usize] as f64 {
                    right = mid;
                } else {
                    i1 = mid + 1;
                }
            }
            t1 = pp_at(pp, i1);
            t0 = pp_at(pp, i1 - 1);
            // check boundary cases, again
            if t0.is_none() {
                *cached = 0;
                return Seek::Copy(0);
            }
            if t1.is_none() {
                i1 = n;
                *cached = i1 as usize;
                return Seek::Copy((i1 - 1).max(0) as usize);
            }
        } // seek
        *cached = i1 as usize;
    } // validate_interval
    match (t0, t1) {
        (Some(t0), Some(t1)) => Seek::Interp { i1: i1 as usize, t0, t1 },
        // Unreachable for a sorted, non-empty track (three would interpolate
        // with `undefined` and produce NaN); keep the copy for safety.
        _ => Seek::Copy(0),
    }
}

/// `Quaternion.slerpFlat(dst, 0, src0, o0, src1, o1, t)` (three r184), on f32
/// keyframes read as f64. Returns (x, y, z, w).
pub fn slerp_flat(src: &[f32], o0: usize, o1: usize, t: f64) -> [f64; 4] {
    let mut x0 = src[o0] as f64;
    let mut y0 = src[o0 + 1] as f64;
    let mut z0 = src[o0 + 2] as f64;
    let mut w0 = src[o0 + 3] as f64;
    let mut x1 = src[o1] as f64;
    let mut y1 = src[o1 + 1] as f64;
    let mut z1 = src[o1 + 2] as f64;
    let mut w1 = src[o1 + 3] as f64;
    let mut t = t;
    if w0 != w1 || x0 != x1 || y0 != y1 || z0 != z1 {
        let mut dot = x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1;
        if dot < 0.0 {
            x1 = -x1;
            y1 = -y1;
            z1 = -z1;
            w1 = -w1;
            dot = -dot;
        }
        let mut s = 1.0 - t;
        if dot < 0.9995 {
            // slerp
            let theta = dot.acos();
            let sin = theta.sin();
            s = (s * theta).sin() / sin;
            t = (t * theta).sin() / sin;
            x0 = x0 * s + x1 * t;
            y0 = y0 * s + y1 * t;
            z0 = z0 * s + z1 * t;
            w0 = w0 * s + w1 * t;
        } else {
            // for small angles, lerp then normalize
            x0 = x0 * s + x1 * t;
            y0 = y0 * s + y1 * t;
            z0 = z0 * s + z1 * t;
            w0 = w0 * s + w1 * t;
            let f = 1.0 / (x0 * x0 + y0 * y0 + z0 * z0 + w0 * w0).sqrt();
            x0 *= f;
            y0 *= f;
            z0 *= f;
            w0 *= f;
        }
    }
    [x0, y0, z0, w0]
}

/// The clip `buildSceneryAnimationClip` builds from a flattened fetchAnimation
/// bundle: per part a position and a quaternion track over shared f32 times.
#[derive(Clone, Debug)]
pub struct Clip {
    pub num_parts: usize,
    pub num_frames: usize,
    /// `times[f] = f * (1 / fps)`, stored as f32 (the track's Float32Array).
    pub times: Vec<f32>,
    /// Part-major position track values: `pos[(p * num_frames + f) * 3 + k]`.
    pub pos: Vec<f32>,
    /// Part-major quaternion track values (x, y, z, w):
    /// `quat[(p * num_frames + f) * 4 + k]`.
    pub quat: Vec<f32>,
    /// `Math.max(dt, (closedLoop ? numFrames - 1 : numFrames) * dt)`.
    pub duration: f64,
}

impl Clip {
    /// `buildSceneryAnimationClip(THREE, frames, numParts, numFrames, fps,
    /// {closedLoop})`; `frames` is the f32 fetchAnimation layout, 7 per
    /// (frame, part): ox oy oz qw qx qy qz. None where the JS returns null.
    pub fn build(frames: &[f32], num_parts: usize, num_frames: usize, fps: f64, closed_loop: bool) -> Option<Clip> {
        if num_parts == 0 || num_frames == 0 {
            return None;
        }
        let expect = num_parts.checked_mul(num_frames)?.checked_mul(7)?;
        if frames.len() < expect {
            return None;
        }
        let dt = 1.0 / (if fps > 0.0 { fps } else { DEFAULT_ANIM_FPS });
        let mut times = Vec::with_capacity(num_frames);
        for f in 0..num_frames {
            times.push(((f as f64) * dt) as f32);
        }
        let mut pos = vec![0.0f32; num_parts * num_frames * 3];
        let mut quat = vec![0.0f32; num_parts * num_frames * 4];
        for p in 0..num_parts {
            for f in 0..num_frames {
                let base = (f * num_parts + p) * 7;
                let po = (p * num_frames + f) * 3;
                pos[po] = frames[base];
                pos[po + 1] = frames[base + 1];
                pos[po + 2] = frames[base + 2];
                let qo = (p * num_frames + f) * 4;
                // THREE quaternion order is (x, y, z, w).
                quat[qo] = frames[base + 4];
                quat[qo + 1] = frames[base + 5];
                quat[qo + 2] = frames[base + 6];
                quat[qo + 3] = frames[base + 3];
            }
        }
        let n = if closed_loop { num_frames as f64 - 1.0 } else { num_frames as f64 };
        let duration = js_max(dt, n * dt);
        Some(Clip { num_parts, num_frames, times, pos, quat, duration })
    }
}

/// The SetOmega orbit of a group: `parseSetOmega`'s unit axis + radians per
/// retail tick (computed in JS — `Math.hypot` — and handed over as is).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Omega {
    pub axis: Vec3,
    pub rad: f64,
}

/// One shared driver (animated_scenery.js `_didGroups` entry).
#[derive(Clone, Debug)]
pub struct Group {
    pub key: u32,
    pub clip: Clip,
    // AnimationAction
    pub time: f64,
    pub loop_count: f64,
    // AnimationMixer
    pub mixer_time: f64,
    pub accu_index: usize,
    // The interpolants' `_cachedIndex`: every track shares the clip's `times`
    // array and is evaluated at the same clip time every frame, so all of
    // them carry the same index at all times — one copy is exact.
    pub cached_index: usize,
    // PropertyMixer buffers: accu0 / accu1 per property ...
    pub accu_pos: Vec<f64>,
    pub accu_quat: Vec<f64>,
    // ... and what the binding last wrote into the template part.
    pub obj_pos: Vec<f64>,
    pub obj_quat: Vec<f64>,
    pub omega: Option<Omega>,
    pub orbit_angle: f64,
    pub orbit_q: Quat,
    /// f64 offset of this group's block in `parts_out`.
    pub parts_off: usize,
    /// Registration order (AnimScenery::register_group): the JS map holds the
    /// most recently set group of a key, so the most recently registered one
    /// is the one rows bind to.
    pub reg_seq: u64,
}

impl Group {
    /// A freshly played action on a template whose parts are fresh Groups:
    /// `saveOriginalState` latched position (0, 0, 0) and quaternion
    /// (0, 0, 0, 1) into orig, accu0 and accu1.
    pub fn new(key: u32, clip: Clip, omega: Option<Omega>) -> Group {
        let np = clip.num_parts;
        let mut accu_quat = vec![0.0f64; 2 * np * 4];
        let mut obj_quat = vec![0.0f64; np * 4];
        for p in 0..np {
            accu_quat[p * 4 + 3] = 1.0;
            accu_quat[(np + p) * 4 + 3] = 1.0;
            obj_quat[p * 4 + 3] = 1.0;
        }
        Group {
            key,
            clip,
            time: 0.0,
            loop_count: -1.0,
            mixer_time: 0.0,
            accu_index: 0,
            cached_index: 0,
            accu_pos: vec![0.0f64; 2 * np * 3],
            accu_quat,
            obj_pos: vec![0.0f64; np * 3],
            obj_quat,
            omega,
            orbit_angle: 0.0,
            orbit_q: Quat::IDENTITY,
            parts_off: 0,
            reg_seq: 0,
        }
    }

    /// `AnimationAction._updateTime(deltaTime)` for `LoopRepeat`, repetitions
    /// Infinity (so `pending` is never <= 1).
    fn update_time(&mut self, delta: f64) -> f64 {
        let duration = self.clip.duration;
        let mut time = self.time + delta;
        let mut loop_count = self.loop_count;
        if delta == 0.0 {
            // `if (loopCount === -1) return time;` — not ping-pong either way.
            return time;
        }
        if loop_count == -1.0 && delta >= 0.0 {
            loop_count = 0.0;
        }
        if time >= duration || time < 0.0 {
            // wrap around
            let loop_delta = (time / duration).floor(); // signed
            time -= duration * loop_delta;
            loop_count += loop_delta.abs();
            self.loop_count = loop_count;
            self.time = time;
        } else {
            self.loop_count = loop_count;
            self.time = time;
        }
        time
    }

    /// One `AnimationMixer.update(dt)` (+ the group's orbit step).
    pub fn step(&mut self, dt: f64, omega_hz: f64) {
        // mixer.update: deltaTime *= this.timeScale (1)
        let delta = dt * 1.0;
        self.mixer_time += delta;
        self.accu_index ^= 1;
        // action._update: deltaTime *= _updateTimeScale(time) (1, not paused)
        let delta = delta * 1.0;
        let t = self.update_time(delta);
        // weight 1 > 0: evaluate + accumulate every track, then apply.
        let s = seek(&self.clip.times, &mut self.cached_index, t);
        let np = self.clip.num_parts;
        let nf = self.clip.num_frames;
        let ai = self.accu_index;
        for p in 0..np {
            let mut inc_p = [0.0f64; 3];
            let mut inc_q = [0.0f64; 4];
            let pbase = p * nf * 3;
            let qbase = p * nf * 4;
            match s {
                Seek::Copy(idx) => {
                    for k in 0..3 {
                        inc_p[k] = self.clip.pos[pbase + idx * 3 + k] as f64;
                    }
                    for k in 0..4 {
                        inc_q[k] = self.clip.quat[qbase + idx * 4 + k] as f64;
                    }
                }
                Seek::Interp { i1, t0, t1 } => {
                    // LinearInterpolant.interpolate_
                    let o1 = pbase + i1 * 3;
                    let o0 = o1 - 3;
                    let weight1 = (t - t0) / (t1 - t0);
                    let weight0 = 1.0 - weight1;
                    for k in 0..3 {
                        inc_p[k] = self.clip.pos[o0 + k] as f64 * weight0 + self.clip.pos[o1 + k] as f64 * weight1;
                    }
                    // QuaternionLinearInterpolant.interpolate_
                    let alpha = (t - t0) / (t1 - t0);
                    let off = qbase + i1 * 4;
                    inc_q = slerp_flat(&self.clip.quat, off - 4, off, alpha);
                }
            }
            // PropertyMixer.accumulate(accuIndex, 1) with cumulativeWeight 0:
            // accuN := incoming. apply(accuIndex): weight 1 (no mix with the
            // original), then write the binding only when accu0 != accu1.
            let a = (ai * np + p) * 3;
            self.accu_pos[a..a + 3].copy_from_slice(&inc_p);
            let a0 = p * 3;
            let a1 = (np + p) * 3;
            let mut changed = false;
            for k in 0..3 {
                if self.accu_pos[a0 + k] != self.accu_pos[a1 + k] {
                    changed = true;
                    break;
                }
            }
            if changed {
                self.obj_pos[p * 3..p * 3 + 3].copy_from_slice(&inc_p);
            }
            let a = (ai * np + p) * 4;
            self.accu_quat[a..a + 4].copy_from_slice(&inc_q);
            let a0 = p * 4;
            let a1 = (np + p) * 4;
            let mut changed = false;
            for k in 0..4 {
                if self.accu_quat[a0 + k] != self.accu_quat[a1 + k] {
                    changed = true;
                    break;
                }
            }
            if changed {
                self.obj_quat[p * 4..p * 4 + 4].copy_from_slice(&inc_q);
            }
        }
        // _advanceOrbit(g, dt): no-op without an omega.
        if let Some(om) = self.omega {
            let step = if dt > 0.0 { om.rad * omega_hz * dt } else { 0.0 };
            self.orbit_angle = (self.orbit_angle + step) % (std::f64::consts::PI * 2.0);
            self.orbit_q = Quat::from_axis_angle(om.axis, self.orbit_angle);
        }
    }

    /// `_partMatsFor(g)[p]`: compose(part.position, part.quaternion, 1).
    pub fn part_matrix(&self, p: usize) -> Mat4 {
        let pos = Vec3::new(self.obj_pos[p * 3], self.obj_pos[p * 3 + 1], self.obj_pos[p * 3 + 2]);
        let q = Quat::new(self.obj_quat[p * 4], self.obj_quat[p * 4 + 1], self.obj_quat[p * 4 + 2], self.obj_quat[p * 4 + 3]);
        Mat4::compose(pos, q, Vec3::ONE)
    }
}

/// One pose-table row (anim_scenery_gpu.js `_rows` entry).
#[derive(Clone, Debug)]
pub struct Row {
    /// The animation DID the row reads (`_didGroups.get(r.animId)`).
    pub key: u32,
    pub part: usize,
    /// `r.post` (the `?animSceneryUnbake` matrix) or None.
    pub post: Option<Mat4>,
    /// The group slot currently registered under `key`, if any.
    pub bound: Option<usize>,
}

/// `writePoseRow(row, m, orbitQuat)` into 32 f32.
pub fn write_pose_row(out: &mut [f32], m: &Mat4, orbit: Option<Quat>) {
    for i in 0..16 {
        out[i] = m.e[i] as f32;
    }
    match orbit {
        Some(q) => {
            let r = Mat4::from_quat(q).e;
            out[16] = r[0] as f32;
            out[17] = r[1] as f32;
            out[18] = r[2] as f32;
            out[19] = 0.0;
            out[20] = r[4] as f32;
            out[21] = r[5] as f32;
            out[22] = r[6] as f32;
            out[23] = 0.0;
            out[24] = r[8] as f32;
            out[25] = r[9] as f32;
            out[26] = r[10] as f32;
            out[27] = 0.0;
        }
        None => {
            out[16] = 1.0;
            out[17] = 0.0;
            out[18] = 0.0;
            out[19] = 0.0;
            out[20] = 0.0;
            out[21] = 1.0;
            out[22] = 0.0;
            out[23] = 0.0;
            out[24] = 0.0;
            out[25] = 0.0;
            out[26] = 1.0;
            out[27] = 0.0;
        }
    }
    out[28] = 0.0;
    out[29] = 0.0;
    out[30] = 0.0;
    out[31] = 0.0;
}

/// Every animated-scenery group and pose row of one session.
#[derive(Default, Debug)]
pub struct AnimScenery {
    groups: Vec<Option<Group>>,
    free_slots: Vec<usize>,
    /// Free blocks of `parts_out` (offset, len), reused by an equal-size group
    /// (a DID re-created after its last instance left has the same parts).
    holes: Vec<(usize, usize)>,
    parts_out: Vec<f64>,
    group_out: Vec<f64>,
    rows: Vec<Row>,
    rows_out: Vec<f32>,
    rows_written: Vec<u8>,
    next_seq: u64,
}

impl AnimScenery {
    pub fn new() -> AnimScenery {
        AnimScenery::default()
    }

    /// Register a group (`getOrCreateDidGroup` / `getOrCreateWindGroup` built
    /// a clip). `key` is the numeric animation DID (0 for a wind group, which
    /// has no pose rows). Returns the handle (slot + 1), or 0 when
    /// `buildSceneryAnimationClip` would return null.
    pub fn register_group(&mut self, key: u32, frames: &[f32], num_parts: usize, num_frames: usize, fps: f64, closed_loop: bool, omega: Option<Omega>) -> u32 {
        let Some(clip) = Clip::build(frames, num_parts, num_frames, fps, closed_loop) else {
            return 0;
        };
        let mut g = Group::new(key, clip, omega);
        g.reg_seq = self.next_seq;
        self.next_seq += 1;
        let need = num_parts * PART_STRIDE;
        let off = match self.holes.iter().position(|&(_, len)| len == need) {
            Some(h) => self.holes.swap_remove(h).0,
            None => {
                let o = self.parts_out.len();
                self.parts_out.resize(o + need, 0.0);
                o
            }
        };
        g.parts_off = off;
        let slot = match self.free_slots.pop() {
            Some(s) => s,
            None => {
                self.groups.push(None);
                self.group_out.resize(self.groups.len() * GROUP_STRIDE, 0.0);
                self.groups.len() - 1
            }
        };
        Self::write_group_out(&mut self.parts_out, &mut self.group_out, slot, &g);
        self.groups[slot] = Some(g);
        if key != 0 {
            for r in self.rows.iter_mut() {
                if r.key == key {
                    r.bound = Some(slot);
                }
            }
        }
        (slot + 1) as u32
    }

    pub fn unregister_group(&mut self, handle: u32) -> bool {
        let Some(slot) = (handle as usize).checked_sub(1) else {
            return false;
        };
        let Some(g) = self.groups.get_mut(slot).and_then(|g| g.take()) else {
            return false;
        };
        self.holes.push((g.parts_off, g.clip.num_parts * PART_STRIDE));
        self.free_slots.push(slot);
        // Its rows are unbound, NOT handed to another group of the key: the JS
        // map no longer holds a group for it either (a dispose deletes the
        // key; a concurrent replacement already took the rows over when it
        // registered — register_group rebinds them).
        for r in self.rows.iter_mut() {
            if r.bound == Some(slot) {
                r.bound = None;
            }
        }
        true
    }

    /// The most recently registered live group of `key` (what the JS map
    /// holds), if any.
    fn latest_slot_of(&self, key: u32) -> Option<usize> {
        let mut best: Option<(usize, u64)> = None;
        for (slot, g) in self.groups.iter().enumerate() {
            let Some(g) = g else { continue };
            if g.key != key {
                continue;
            }
            let newer = match best {
                None => true,
                Some((_, seq)) => g.reg_seq > seq,
            };
            if newer {
                best = Some((slot, g.reg_seq));
            }
        }
        best.map(|(slot, _)| slot)
    }

    /// The group's f64 offset in `parts_out` (u32::MAX for an unknown handle).
    pub fn parts_offset(&self, handle: u32) -> u32 {
        match self.group(handle) {
            Some(g) => g.parts_off as u32,
            None => u32::MAX,
        }
    }

    /// The group's slot (its block in `group_out` is at slot * GROUP_STRIDE).
    pub fn slot_of(&self, handle: u32) -> u32 {
        match self.group(handle) {
            Some(_) => handle - 1,
            None => u32::MAX,
        }
    }

    pub fn group(&self, handle: u32) -> Option<&Group> {
        let slot = (handle as usize).checked_sub(1)?;
        self.groups.get(slot)?.as_ref()
    }

    /// Register the next pose-table row (anim_scenery_gpu.js `poseRowFor`
    /// allocating row `rows.len() + 1`), seeded as `writePoseRow(row,
    /// initMat || null, null)` seeds it. Returns the 0-based index.
    pub fn register_row(&mut self, key: u32, part: usize, post: Option<Mat4>, init: Option<Mat4>) -> u32 {
        let bound = if key == 0 { None } else { self.latest_slot_of(key) };
        self.rows.push(Row { key, part, post, bound });
        let o = self.rows_out.len();
        self.rows_out.resize(o + ROW_FLOATS, 0.0);
        write_pose_row(&mut self.rows_out[o..o + ROW_FLOATS], &init.unwrap_or(Mat4::IDENTITY), None);
        self.rows_written.push(0);
        (self.rows.len() - 1) as u32
    }

    /// `disposeAnimSceneryGpu`: the table and its rows are gone.
    pub fn clear_rows(&mut self) {
        self.rows.clear();
        self.rows_out.clear();
        self.rows_written.clear();
    }

    /// Everything gone (`disposeAnimatedScenery`).
    pub fn clear(&mut self) {
        *self = AnimScenery::default();
    }

    /// One frame: every group's mixer + orbit step, then every row. Returns
    /// the number of rows written this frame.
    pub fn advance(&mut self, dt: f64, omega_hz: f64) -> u32 {
        for slot in 0..self.groups.len() {
            if let Some(g) = self.groups[slot].as_mut() {
                g.step(dt, omega_hz);
                Self::write_group_out(&mut self.parts_out, &mut self.group_out, slot, g);
            }
        }
        let mut written = 0u32;
        for (k, r) in self.rows.iter().enumerate() {
            self.rows_written[k] = 0;
            let Some(slot) = r.bound else { continue };
            let Some(g) = self.groups[slot].as_ref() else { continue };
            if r.part >= g.clip.num_parts {
                continue;
            }
            let pm = g.part_matrix(r.part);
            let m = match r.post {
                Some(post) => pm.mul(&post),
                None => pm,
            };
            let orbit = if g.omega.is_some() { Some(g.orbit_q) } else { None };
            write_pose_row(&mut self.rows_out[k * ROW_FLOATS..(k + 1) * ROW_FLOATS], &m, orbit);
            self.rows_written[k] = 1;
            written += 1;
        }
        written
    }

    fn write_group_out(parts_out: &mut [f64], group_out: &mut [f64], slot: usize, g: &Group) {
        let np = g.clip.num_parts;
        for p in 0..np {
            let o = g.parts_off + p * PART_STRIDE;
            parts_out[o] = g.obj_pos[p * 3];
            parts_out[o + 1] = g.obj_pos[p * 3 + 1];
            parts_out[o + 2] = g.obj_pos[p * 3 + 2];
            parts_out[o + 3] = g.obj_quat[p * 4];
            parts_out[o + 4] = g.obj_quat[p * 4 + 1];
            parts_out[o + 5] = g.obj_quat[p * 4 + 2];
            parts_out[o + 6] = g.obj_quat[p * 4 + 3];
        }
        let o = slot * GROUP_STRIDE;
        group_out[o] = g.orbit_q.x;
        group_out[o + 1] = g.orbit_q.y;
        group_out[o + 2] = g.orbit_q.z;
        group_out[o + 3] = g.orbit_q.w;
        group_out[o + 4] = g.orbit_angle;
        group_out[o + 5] = g.mixer_time;
        group_out[o + 6] = g.time;
    }

    pub fn parts_out(&self) -> &[f64] {
        &self.parts_out
    }
    pub fn group_out(&self) -> &[f64] {
        &self.group_out
    }
    pub fn rows_out(&self) -> &[f32] {
        &self.rows_out
    }
    pub fn rows_written(&self) -> &[u8] {
        &self.rows_written
    }
    pub fn group_count(&self) -> usize {
        self.groups.iter().filter(|g| g.is_some()).count()
    }
    pub fn row_count(&self) -> usize {
        self.rows.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seek_walks_forward_and_wraps() {
        let times: Vec<f32> = (0..4).map(|f| ((f as f64) * (1.0 / 30.0)) as f32).collect();
        let mut c = 0usize;
        // t = 0: interval [0, 1] (i1 = 1).
        assert!(matches!(seek(&times, &mut c, 0.0), Seek::Interp { i1: 1, .. }));
        assert_eq!(c, 1);
        // Past the last key, before the duration: the last sample.
        assert_eq!(seek(&times, &mut c, 0.11), Seek::Copy(3));
        assert_eq!(c, 4);
        // Wrapped back to the start.
        assert!(matches!(seek(&times, &mut c, 0.01), Seek::Interp { i1: 1, .. }));
    }

    #[test]
    fn single_frame_clip_holds_its_sample() {
        let times = vec![0.0f32];
        let mut c = 0usize;
        assert_eq!(seek(&times, &mut c, 0.0), Seek::Copy(0));
        assert_eq!(seek(&times, &mut c, 0.02), Seek::Copy(0));
    }

    #[test]
    fn slerp_endpoints_and_identity() {
        let q = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        assert_eq!(slerp_flat(&q, 0, 4, 0.5), [0.0, 0.0, 0.0, 1.0]);
    }

    #[test]
    fn clip_rejects_short_frames() {
        assert!(Clip::build(&[0.0; 13], 1, 2, 30.0, false).is_none());
        let c = Clip::build(&[0.0; 14], 1, 2, 30.0, false).unwrap();
        assert_eq!(c.duration, 2.0 * (1.0 / 30.0));
        let c = Clip::build(&[0.0; 14], 1, 2, 30.0, true).unwrap();
        assert_eq!(c.duration, 1.0 / 30.0);
    }

    #[test]
    fn rows_follow_the_latest_group_of_a_key() {
        // Two groups registered for one key (a concurrent second
        // getOrCreateDidGroup): rows follow the newest — the one the JS map
        // holds — and are never handed to an older one.
        let mut k = AnimScenery::new();
        let z1 = [0.0f32, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0];
        let z2 = [0.0f32, 0.0, 2.0, 1.0, 0.0, 0.0, 0.0];
        let a = k.register_group(9, &z1, 1, 1, 30.0, false, None);
        let b = k.register_group(9, &z2, 1, 1, 30.0, false, None);
        assert!(a != 0 && b != 0 && a != b);
        let r = k.register_row(9, 0, None, None) as usize;
        assert_eq!(k.advance(0.016, 15.0), 1);
        assert_eq!(k.rows_out()[r * ROW_FLOATS + 14], 2.0, "a row registered after both binds to the newest");
        // Dropping the older group changes nothing for the row.
        assert!(k.unregister_group(a));
        assert_eq!(k.advance(0.016, 15.0), 1);
        assert_eq!(k.rows_out()[r * ROW_FLOATS + 14], 2.0);
        // A third group re-binds the row; dropping it leaves the row unbound
        // even though `b` (older) still holds the key.
        let c = k.register_group(9, &z1, 1, 1, 30.0, false, None);
        assert_eq!(k.advance(0.016, 15.0), 1);
        assert_eq!(k.rows_out()[r * ROW_FLOATS + 14], 1.0);
        assert!(k.unregister_group(c));
        assert_eq!(k.advance(0.016, 15.0), 0, "no hand-back to an older group of the key");
        assert_eq!(k.rows_written()[r], 0);
        assert_eq!(k.rows_out()[r * ROW_FLOATS + 14], 1.0, "an unbound row keeps its last value");
        // A new row with only `b` live binds to `b`.
        let r2 = k.register_row(9, 0, None, None) as usize;
        assert_eq!(k.advance(0.016, 15.0), 1);
        assert_eq!(k.rows_out()[r2 * ROW_FLOATS + 14], 2.0);
        assert_eq!(k.rows_written()[r], 0);
    }

    #[test]
    fn rows_bind_to_groups_by_key() {
        let mut k = AnimScenery::new();
        let r = k.register_row(7, 0, None, None);
        assert_eq!(r, 0);
        assert_eq!(k.advance(0.016, 15.0), 0, "no group yet: row not written");
        let frames = [0.0f32, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0];
        let h = k.register_group(7, &frames, 1, 1, 30.0, false, None);
        assert_eq!(h, 1);
        assert_eq!(k.advance(0.016, 15.0), 1);
        assert_eq!(k.rows_written(), &[1]);
        // The row holds compose((0, 0, 1), identity): translation z = 1.
        assert_eq!(k.rows_out()[14], 1.0);
        assert!(k.unregister_group(h));
        assert_eq!(k.advance(0.016, 15.0), 0);
        // Re-created under the same key: same block reused.
        let h2 = k.register_group(7, &frames, 1, 1, 30.0, false, None);
        assert_eq!(k.parts_offset(h2), 0);
        assert_eq!(k.advance(0.016, 15.0), 1);
    }
}
