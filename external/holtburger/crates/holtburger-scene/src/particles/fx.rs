//! scene3d/particles/particle_fx.js (`particleFxSeed`, `particleFxAge`,
//! `particleFxPacked`, `particleFxSlotVelocity`) and particle_fx_kids.js
//! (`ParticleFxKids.pushParticle`) — the per-instance FX channels the
//! instanced path writes. The JS arrays are Float32Array, so every stored
//! value is rounded to f32 exactly where the JS stores it.

use super::particle::Slot;
use crate::math::{js_max, js_min};

/// particle_fx.js `_nextSeed()` on the shared xorshift32 state (the JS keeps
/// it as an int32; the bit pattern is the same).
#[inline]
pub fn next_seed(state: &mut u32) -> f64 {
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *state = x;
    (x % 999) as f64 / 1000.0
}

/// `particleFxSeed(emitter, slot, lifetime)`.
#[inline]
pub fn seed_for(s: &mut Slot, lifetime: f64, state: &mut u32) -> f64 {
    let lt = if lifetime.is_finite() { lifetime } else { 0.0 };
    if (s.seed as f64) < 0.0 || lt + 1e-6 < (s.life as f64) {
        s.seed = next_seed(state) as f32;
    }
    s.life = lt as f32;
    s.seed as f64
}

/// `particleFxAge(p)`.
#[inline]
pub fn age(s: &Slot) -> f64 {
    if !(s.lifespan > 0.0) {
        return 0.0;
    }
    let a = s.lifetime / s.lifespan;
    if a <= 0.0 {
        0.0
    } else if a >= 1.0 {
        1.0
    } else {
        a
    }
}

/// `particleFxPacked(row, seed)`.
#[inline]
pub fn packed(row: u32, seed: f64, live: bool) -> f64 {
    let r = if live { row as i32 as f64 } else { 0.0 };
    r + js_min(0.999, js_max(0.0, seed))
}

/// JS `x || 0` for a number.
#[inline]
fn or_zero(x: f64) -> f64 {
    if x == 0.0 || x.is_nan() { 0.0 } else { x }
}

/// `particleFxSlotVelocity(emitter, slot, e, seed, nowSec, out)`; `x, y, z`
/// are the slot matrix translation (`e[12..15]`).
pub fn slot_velocity(s: &mut Slot, x: f64, y: f64, z: f64, seed: f64, now_sec: f64, lim_sq: f64) -> [f64; 3] {
    let c = &mut s.vel;
    let mut vx = 0.0;
    let mut vy = 0.0;
    let mut vz = 0.0;
    if (c[4] as f64) == seed && (c[3] as f64).is_finite() {
        let dt = now_sec - c[3] as f64;
        if !(dt > 1e-4) {
            return [or_zero(c[5] as f64), or_zero(c[6] as f64), or_zero(c[7] as f64)];
        }
        if dt < 0.5 {
            let mut rx = (x - c[0] as f64) / dt;
            let mut ry = (y - c[1] as f64) / dt;
            let mut rz = (z - c[2] as f64) / dt;
            if rx * rx + ry * ry + rz * rz > lim_sq {
                rx = 0.0;
                ry = 0.0;
                rz = 0.0;
            }
            let px = c[5] as f64;
            let py = c[6] as f64;
            let pz = c[7] as f64;
            if px.is_finite() && (px != 0.0 || py != 0.0 || pz != 0.0) {
                vx = 0.5 * (px + rx);
                vy = 0.5 * (py + ry);
                vz = 0.5 * (pz + rz);
            } else {
                vx = rx;
                vy = ry;
                vz = rz;
            }
        }
    }
    c[0] = x as f32;
    c[1] = y as f32;
    c[2] = z as f32;
    c[3] = now_sec as f32;
    c[4] = seed as f32;
    c[5] = vx as f32;
    c[6] = vy as f32;
    c[7] = vz as f32;
    [vx, vy, vz]
}

/// `ParticleFxKids.pushParticle(emitter, i, e, age, opacity, row, seed,
/// nowSec)`: appends one record to `out` (aKidPos, aKidVel, aKidRow order).
#[allow(clippy::too_many_arguments)]
pub fn kid_push(s: &mut Slot, x: f64, y: f64, z: f64, age: f64, opacity: f64, row: u32, seed: f64, now_sec: f64, out: &mut Vec<f32>) {
    let prev = &mut s.kid_prev;
    let mut vx = 0.0;
    let mut vy = 0.0;
    let mut vz = 0.0;
    if (prev[4] as f64) == seed && (prev[3] as f64).is_finite() {
        let dt = now_sec - prev[3] as f64;
        if dt > 1e-4 && dt < 0.5 {
            vx = (x - prev[0] as f64) / dt;
            vy = (y - prev[1] as f64) / dt;
            vz = (z - prev[2] as f64) / dt;
            // a teleporting parent (slot reuse within a tick) must not fling embers
            if vx * vx + vy * vy + vz * vz > 400.0 {
                vx = 0.0;
                vy = 0.0;
                vz = 0.0;
            }
        }
    }
    prev[0] = x as f32;
    prev[1] = y as f32;
    prev[2] = z as f32;
    prev[3] = now_sec as f32;
    prev[4] = seed as f32;
    // ParticleFxKidsLayer.push(x, y, z, age, vx, vy, vz, opacity, row, seed)
    out.push(x as f32);
    out.push(y as f32);
    out.push(z as f32);
    out.push(age as f32);
    out.push(vx as f32);
    out.push(vy as f32);
    out.push(vz as f32);
    out.push(opacity as f32);
    out.push(row as f32);
    out.push(seed as f32);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xorshift_matches_js_int32_ops() {
        // particle_fx.js: let _rng = 0x9e3779b9 | 0; the first four seeds and
        // states, computed with the JS expression in node 20.
        let mut st = 0x9e37_79b9u32;
        let want = [(0.992, 1_359_758_873u32), (0.759, 3_761_132_862), (0.23, 2_075_758_394), (0.052, 25_405_621)];
        for (v, s) in want {
            assert_eq!(next_seed(&mut st), v);
            assert_eq!(st, s);
        }
    }

    #[test]
    fn or_zero_semantics() {
        assert_eq!(or_zero(f64::NAN), 0.0);
        assert!(or_zero(-0.0).is_sign_positive());
        assert_eq!(or_zero(2.5), 2.5);
    }
}
