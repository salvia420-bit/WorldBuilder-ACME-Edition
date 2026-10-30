//! scene3d/particles/particle.js — one slot: the per-particle state
//! (`Particle`) plus the slot mesh state the JS keeps on its THREE.Mesh
//! carrier (position, quaternion, uniform scale, `visible`,
//! `userData.__op`), and the `init` / `update` drivers for all 12 types.

use super::Config;
use super::info::{Info, PType};
use crate::math::{Quat, Vec3, js_max, js_min};
use crate::rng::Rng;

/// A slot of an emitter (`partStorage[i]` + `particles[i]` + `parts[i]`).
#[derive(Clone, Debug)]
pub struct Slot {
    /// `parts[i] !== null` (the slot holds a live particle).
    pub live: bool,
    // ---- the slot mesh (`THREE.Mesh` carrier) ----
    pub pos: Vec3,
    pub quat: Quat,
    /// `mesh.scale.setScalar(s)` — always uniform.
    pub scale: f64,
    pub visible: bool,
    /// `mesh.userData.__op` (setTranslucency).
    pub op: f64,
    // ---- `Particle` ----
    pub last_update_time: f64,
    pub birthtime: f64,
    pub lifespan: f64,
    pub lifetime: f64,
    pub sf_pos: Vec3,
    pub sf_quat: Quat,
    pub offset: Vec3,
    pub a: Vec3,
    pub b: Vec3,
    pub c: Vec3,
    pub start_scale: f64,
    pub final_scale: f64,
    pub start_trans: f64,
    pub final_trans: f64,
    // ---- particle_fx.js per-slot state (`_fxSeeds`, `_fxLives`, `_fxVel`) and
    // particle_fx_kids.js `_kidPrev` — Float32Array storage in the JS ----
    pub seed: f32,
    pub life: f32,
    pub vel: [f32; 8],
    pub kid_prev: [f32; 5],
}

impl Default for Slot {
    /// A fresh slot: `new THREE.Mesh` (origin, identity, unit scale,
    /// invisible) + `new Particle()` + the FX arrays' fill values.
    fn default() -> Slot {
        Slot {
            live: false,
            pos: Vec3::ZERO,
            quat: Quat::IDENTITY,
            scale: 1.0,
            visible: false,
            op: 1.0,
            last_update_time: 0.0,
            birthtime: 0.0,
            lifespan: 0.0,
            lifetime: 0.0,
            sf_pos: Vec3::ZERO,
            sf_quat: Quat::IDENTITY,
            offset: Vec3::ZERO,
            a: Vec3::ZERO,
            b: Vec3::ZERO,
            c: Vec3::ZERO,
            start_scale: 1.0,
            final_scale: 1.0,
            start_trans: 0.0,
            final_trans: 0.0,
            seed: -1.0,
            life: f32::INFINITY,
            vel: [f32::NAN; 8],
            kid_prev: [f32::NAN; 5],
        }
    }
}

/// A frame `{ position, quaternion }`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub pos: Vec3,
    pub quat: Quat,
}

impl Default for Frame {
    fn default() -> Frame {
        Frame { pos: Vec3::ZERO, quat: Quat::IDENTITY }
    }
}

pub const PI: f64 = std::f64::consts::PI;
/// particle.js `_2PI = Math.PI * 2.0`.
pub const TWO_PI: f64 = std::f64::consts::PI * 2.0;

/// `normalizeCheckSmall(v)`: true (caller zeroes) when |v|² < 1e-6, else
/// normalizes in place.
#[inline]
pub fn normalize_check_small(v: &mut Vec3) -> bool {
    if v.length_sq() < 1e-6 {
        return true;
    }
    *v = v.normalize();
    false
}

/// `localToGlobalVec(frame, v)` = `v.clone().applyQuaternion(frame.quaternion)`.
#[inline]
fn l2g(q: Quat, v: Vec3) -> Vec3 {
    v.apply_quat(q)
}

/// `setTranslucency(mesh, t)` on a carrier (opacity rides `userData.__op`).
#[inline]
pub fn set_translucency(s: &mut Slot, translucency: f64) {
    if translucency >= 1.0 {
        s.visible = false;
        s.op = 0.0;
    } else {
        s.visible = true;
        s.op = js_max(0.0, js_min(1.0, 1.0 - translucency));
    }
}

/// `particleSpinQuat(c, t, out)`.
pub fn spin_quat(c: Vec3, t: f64, euler_legacy: bool) -> Quat {
    if euler_legacy {
        return Quat::from_euler_yxz(t * c.x, t * c.y, t * c.z);
    }
    let wx = t * c.x;
    let wy = t * c.y;
    let wz = t * c.z;
    let theta = (wx * wx + wy * wy + wz * wz).sqrt();
    if !(theta >= 0.0002) {
        return Quat::new(0.0, 0.0, 0.0, 1.0);
    }
    let axis = Vec3::new(wx / theta, wy / theta, wz / theta);
    Quat::from_axis_angle(axis, theta)
}

/// The per-particle arguments `emitParticle` draws before `init`.
#[derive(Clone, Copy, Debug)]
pub struct Spawn {
    pub random_offset: Vec3,
    pub persistent: bool,
    pub a: Vec3,
    pub b: Vec3,
    pub c: Vec3,
    pub start_scale: f64,
    pub final_scale: f64,
    pub start_trans: f64,
    pub final_trans: f64,
}

/// `Particle.init(info, parent, partIdx, parentOffset, mesh, randomOffset,
/// persistent, a, b, c, startScale, finalScale, startTrans, finalTrans,
/// anchorFrame)`, with `anchorFrame` always supplied (the emitter resolves it).
#[allow(clippy::too_many_arguments)]
pub fn init(s: &mut Slot, info: &Info, parent_offset: Frame, sp: &Spawn, anchor: Frame, now: f64, rng: &mut Rng, cfg: &Config) {
    s.last_update_time = now;
    s.birthtime = now;
    s.lifetime = 0.0;

    let raw_lifespan = info.random_lifespan(rng);
    s.lifespan = if raw_lifespan.is_finite() { raw_lifespan } else { 1.0 };

    s.sf_pos = anchor.pos;
    s.sf_quat = anchor.quat;

    // const localPt = parentOffset.position.clone().add(randomOffset);
    let local_pt = parent_offset.pos.add(sp.random_offset);
    s.offset = l2g(s.sf_quat, local_pt);

    let q = s.sf_quat;
    let legacy = cfg.init_ace;
    let (a, b, c) = (sp.a, sp.b, sp.c);
    match info.ptype {
        PType::Still => {}
        PType::LocalVelocity => {
            s.a = l2g(q, a);
        }
        PType::ParabolicLVGA => {
            if legacy {
                s.b = l2g(q, b);
            } else {
                s.b = b;
                s.a = l2g(q, a);
            }
        }
        PType::ParabolicLVGAGR => {
            if legacy {
                s.c = l2g(q, c);
            } else {
                s.c = c;
                s.b = b;
                s.a = l2g(q, a);
            }
        }
        PType::Swarm => {
            s.a = l2g(q, a);
            s.b = b;
            s.c = c;
        }
        PType::Explode => {
            s.a = a;
            s.b = b;
            let ra = rng.next_f64() * TWO_PI - PI;
            let po = rng.next_f64() * TWO_PI - PI;
            let rb = po.cos();
            let cx = ra.cos() * c.x * rb;
            let cy = ra.sin() * c.y * rb;
            let cz = if legacy { po.sin() * c.z * rb } else { po.sin() * c.z };
            s.c = Vec3::new(cx, cy, cz);
            let mut cc = s.c;
            if normalize_check_small(&mut cc) {
                cc = Vec3::ZERO;
            }
            s.c = cc;
        }
        PType::Implode => {
            s.a = a;
            s.b = b;
            s.offset = s.offset.mul(c);
            s.c = s.offset;
        }
        PType::ParabolicLVLA => {
            s.a = l2g(q, a);
            s.b = l2g(q, b);
        }
        PType::ParabolicLVLALR => {
            s.c = l2g(q, c);
            if !legacy {
                s.b = l2g(q, b);
                s.a = l2g(q, a);
            }
        }
        PType::ParabolicGVGA => {
            s.b = b;
            if !legacy {
                s.a = a;
            }
        }
        PType::ParabolicGVGAGR => {
            s.c = c;
            if !legacy {
                s.b = b;
                s.a = a;
            }
        }
        PType::GlobalVelocity => {
            s.a = a;
        }
        PType::Other => {
            s.a = a;
            s.b = b;
            s.c = c;
        }
    }

    s.start_scale = sp.start_scale;
    s.final_scale = sp.final_scale;
    s.start_trans = sp.start_trans;
    s.final_trans = sp.final_trans;

    s.scale = s.start_scale;
    set_translucency(s, s.start_trans);

    let frame = if cfg.init_frame_ace { parent_offset } else { Frame { pos: s.sf_pos, quat: s.sf_quat } };
    update(s, info.ptype, sp.persistent, frame, now, cfg);
}

/// `Particle.update(particleType, persistent, mesh, parent)`.
pub fn update(s: &mut Slot, ptype: PType, persistent: bool, parent: Frame, now: f64, cfg: &Config) {
    let elapsed = now - s.last_update_time;
    if persistent {
        s.lifetime += elapsed;
        s.last_update_time = now;
    } else {
        s.lifetime = elapsed;
    }

    let lt = s.lifetime;
    let (ox, oy, oz) = (s.offset.x, s.offset.y, s.offset.z);
    let (px, py, pz) = (parent.pos.x, parent.pos.y, parent.pos.z);

    match ptype {
        PType::Still => {
            s.pos = Vec3::new(px + ox, py + oy, pz + oz);
        }
        PType::LocalVelocity | PType::GlobalVelocity => {
            s.pos = Vec3::new(lt * s.a.x + px + ox, lt * s.a.y + py + oy, lt * s.a.z + pz + oz);
        }
        PType::ParabolicLVGA | PType::ParabolicLVLA | PType::ParabolicGVGA => {
            let half_t2 = lt * lt * 0.5;
            s.pos = Vec3::new(
                px + ox + lt * s.a.x + half_t2 * s.b.x,
                py + oy + lt * s.a.y + half_t2 * s.b.y,
                pz + oz + lt * s.a.z + half_t2 * s.b.z,
            );
        }
        PType::ParabolicLVGAGR | PType::ParabolicLVLALR | PType::ParabolicGVGAGR => {
            let half_t2 = lt * lt * 0.5;
            s.pos = Vec3::new(
                px + half_t2 * s.b.x + lt * s.a.x + ox,
                py + half_t2 * s.b.y + lt * s.a.y + oy,
                pz + half_t2 * s.b.z + lt * s.a.z + oz,
            );
            let spin = spin_quat(s.c, lt, cfg.rot_euler);
            // mesh.quaternion.copy(parent.quaternion).multiply(spin).normalize()
            s.quat = parent.quat.mul(spin).normalize();
        }
        PType::Swarm => {
            let base_x = lt * s.a.x + px + ox;
            let base_y = lt * s.a.y + py + oy;
            let base_z = lt * s.a.z + pz + oz;
            if cfg.swarm_ace {
                s.pos = Vec3::new(
                    (lt * s.b.x).cos() + (s.c.x + base_x),
                    (lt * s.b.y).sin() + (s.c.y + base_y),
                    (lt * s.b.z).cos() + (s.c.z + base_z),
                );
            } else {
                s.pos = Vec3::new(
                    (lt * s.b.x).cos() * s.c.x + base_x,
                    (lt * s.b.y).sin() * s.c.y + base_y,
                    (lt * s.b.z).cos() * s.c.z + base_z,
                );
            }
        }
        PType::Explode => {
            let ax = s.a.x;
            let az = if cfg.init_ace { 0.0 } else { s.a.z };
            s.pos = Vec3::new(
                (lt * s.b.x + s.c.x * ax) * lt + ox + px,
                (lt * s.b.y + s.c.y * ax) * lt + oy + py,
                (lt * s.b.z + s.c.z * ax + az) * lt + oz + pz,
            );
        }
        PType::Implode => {
            let cos_scale = (s.a.x * lt).cos();
            let lt2 = lt * lt;
            s.pos = Vec3::new(
                cos_scale * s.c.x + lt2 * s.b.x + px + ox,
                cos_scale * s.c.y + lt2 * s.b.y + py + oy,
                cos_scale * s.c.z + lt2 * s.b.z + pz + oz,
            );
        }
        PType::Other => {}
    }

    let interval = if s.lifespan > 0.0 { js_min(s.lifetime / s.lifespan, 1.0) } else { 1.0 };
    let current_scale = s.start_scale + (s.final_scale - s.start_scale) * interval;
    let current_trans = s.start_trans + (s.final_trans - s.start_trans) * interval;
    s.scale = current_scale;
    set_translucency(s, current_trans);
}
