//! scene3d/particles/particle_emitter_info.js — the emitter info record and
//! its per-particle random draws (`getRandom*`) and `shouldEmitParticle`.
//! Draw ORDER matters: the parity tests replay the JS stream.

use super::layout::*;
use crate::math::{Vec3, js_max, js_min};
use crate::rng::Rng;

/// `ParticleType` (particle.js). Unknown (0) and any other value take the
/// `default:` branches of the init and update switches, so they share `Other`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PType {
    Other,
    Still,
    LocalVelocity,
    ParabolicLVGA,
    ParabolicLVGAGR,
    Swarm,
    Explode,
    Implode,
    ParabolicLVLA,
    ParabolicLVLALR,
    ParabolicGVGA,
    ParabolicGVGAGR,
    GlobalVelocity,
}

impl PType {
    /// The JS `switch (info.particleType)` compares with `===`, so only the
    /// exact integers 1..12 select a case.
    pub fn from_f64(v: f64) -> PType {
        if v == 1.0 {
            PType::Still
        } else if v == 2.0 {
            PType::LocalVelocity
        } else if v == 3.0 {
            PType::ParabolicLVGA
        } else if v == 4.0 {
            PType::ParabolicLVGAGR
        } else if v == 5.0 {
            PType::Swarm
        } else if v == 6.0 {
            PType::Explode
        } else if v == 7.0 {
            PType::Implode
        } else if v == 8.0 {
            PType::ParabolicLVLA
        } else if v == 9.0 {
            PType::ParabolicLVLALR
        } else if v == 10.0 {
            PType::ParabolicGVGA
        } else if v == 11.0 {
            PType::ParabolicGVGAGR
        } else if v == 12.0 {
            PType::GlobalVelocity
        } else {
            PType::Other
        }
    }

    /// The trig-bearing types (Swarm, Explode, Implode, the GR spins): their
    /// positions/rotations may differ from V8 by one ulp.
    pub fn uses_trig(self) -> bool {
        matches!(
            self,
            PType::Swarm
                | PType::Explode
                | PType::Implode
                | PType::ParabolicLVGAGR
                | PType::ParabolicLVLALR
                | PType::ParabolicGVGAGR
        )
    }
}

/// `EmitterType` values compared with `===`.
pub const EMITTER_BIRTHRATE_PER_SEC: f64 = 1.0;
pub const EMITTER_BIRTHRATE_PER_METER: f64 = 2.0;

#[derive(Clone, Debug)]
pub struct Info {
    pub emitter_type: f64,
    pub ptype: PType,
    pub birthrate: f64,
    /// The quality-capped `maxParticles` (= `parts.length`).
    pub max_particles: f64,
    pub total_particles: f64,
    pub total_seconds: f64,
    pub lifespan: f64,
    pub lifespan_rand: f64,
    pub offset_dir: Vec3,
    pub min_offset: f64,
    pub max_offset: f64,
    pub a: Vec3,
    pub min_a: f64,
    pub max_a: f64,
    pub b: Vec3,
    pub min_b: f64,
    pub max_b: f64,
    pub c: Vec3,
    pub min_c: f64,
    pub max_c: f64,
    pub scale_rand: f64,
    pub start_scale: f64,
    pub final_scale: f64,
    pub trans_rand: f64,
    pub start_trans: f64,
    pub final_trans: f64,
    pub is_parent_local: bool,
    pub billboard: bool,
}

#[inline]
fn v3(d: &[f64], i: usize) -> Vec3 {
    Vec3::new(d[i], d[i + 1], d[i + 2])
}

/// particle_emitter_info.js `clamp(v, lo, hi)` = `Math.max(lo, Math.min(hi, v))`.
#[inline]
fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    js_max(lo, js_min(hi, v))
}

impl Info {
    pub fn from_desc(d: &[f64]) -> Info {
        Info {
            emitter_type: d[D_EMITTER_TYPE],
            ptype: PType::from_f64(d[D_PARTICLE_TYPE]),
            birthrate: d[D_BIRTHRATE],
            max_particles: d[D_MAX_PARTICLES],
            total_particles: d[D_TOTAL_PARTICLES],
            total_seconds: d[D_TOTAL_SECONDS],
            lifespan: d[D_LIFESPAN],
            lifespan_rand: d[D_LIFESPAN_RAND],
            offset_dir: v3(d, D_OFFSET_DIR),
            min_offset: d[D_MIN_OFFSET],
            max_offset: d[D_MAX_OFFSET],
            a: v3(d, D_A),
            min_a: d[D_MIN_A],
            max_a: d[D_MAX_A],
            b: v3(d, D_B),
            min_b: d[D_MIN_B],
            max_b: d[D_MAX_B],
            c: v3(d, D_C),
            min_c: d[D_MIN_C],
            max_c: d[D_MAX_C],
            scale_rand: d[D_SCALE_RAND],
            start_scale: d[D_START_SCALE],
            final_scale: d[D_FINAL_SCALE],
            trans_rand: d[D_TRANS_RAND],
            start_trans: d[D_START_TRANS],
            final_trans: d[D_FINAL_TRANS],
            is_parent_local: d[D_PARENT_LOCAL] != 0.0,
            billboard: d[D_BILLBOARD] != 0.0,
        }
    }

    /// Retail's persistent/standing emitter (`totalParticles === 0 &&
    /// totalSeconds === 0`) — `firstParticle` in emitParticle/updateParticles.
    #[inline]
    pub fn persistent(&self) -> bool {
        self.total_particles == 0.0 && self.total_seconds == 0.0
    }

    /// `getRandomStartScale`.
    pub fn random_start_scale(&self, rng: &mut Rng) -> f64 {
        let r = rng.next_f64() * 2.0 - 1.0;
        clamp(r * self.scale_rand + self.start_scale, 0.1, 10.0)
    }

    /// `getRandomFinalScale`.
    pub fn random_final_scale(&self, rng: &mut Rng) -> f64 {
        let r = rng.next_f64() * 2.0 - 1.0;
        clamp(r * self.scale_rand + self.final_scale, 0.1, 10.0)
    }

    /// `getRandomStartTrans`.
    pub fn random_start_trans(&self, rng: &mut Rng) -> f64 {
        let r = rng.next_f64() * 2.0 - 1.0;
        clamp(r * self.trans_rand + self.start_trans, 0.0, 1.0)
    }

    /// `getRandomFinalTrans`.
    pub fn random_final_trans(&self, rng: &mut Rng) -> f64 {
        let r = rng.next_f64() * 2.0 - 1.0;
        clamp(r * self.trans_rand + self.final_trans, 0.0, 1.0)
    }

    /// `getRandomLifespan`.
    pub fn random_lifespan(&self, rng: &mut Rng) -> f64 {
        let r = rng.next_f64() * 2.0 - 1.0;
        js_max(0.0, r * self.lifespan_rand + self.lifespan)
    }

    /// `getRandomOffset`: three draws for the direction, a fourth for the
    /// distance only when the projected direction is not too small.
    pub fn random_offset(&self, rng: &mut Rng) -> Vec3 {
        let rx = rng.next_f64() * 2.0 - 1.0;
        let ry = rng.next_f64() * 2.0 - 1.0;
        let rz = rng.next_f64() * 2.0 - 1.0;
        let r = Vec3::new(rx, ry, rz);
        // randomAngle = r - OffsetDir * dot(OffsetDir, r);
        let dot = self.offset_dir.dot(r);
        let proj = self.offset_dir.scale(dot);
        let result = r.sub(proj);
        // normalizeCheckSmall(result) → zero (no fourth draw)
        if result.length_sq() < 1e-6 {
            return Vec3::ZERO;
        }
        let result = result.normalize();
        let t = rng.next_f64();
        let scalar = t * (self.max_offset - self.min_offset) + self.min_offset;
        result.scale(scalar)
    }

    /// `getRandomA`.
    pub fn random_a(&self, rng: &mut Rng) -> Vec3 {
        let t = rng.next_f64();
        let magnitude = (self.max_a - self.min_a) * t + self.min_a;
        self.a.scale(magnitude)
    }

    /// `getRandomB`.
    pub fn random_b(&self, rng: &mut Rng) -> Vec3 {
        let t = rng.next_f64();
        let magnitude = (self.max_b - self.min_b) * t + self.min_b;
        self.b.scale(magnitude)
    }

    /// `getRandomC`.
    pub fn random_c(&self, rng: &mut Rng) -> Vec3 {
        let t = rng.next_f64();
        let magnitude = (self.max_c - self.min_c) * t + self.min_c;
        self.c.scale(magnitude)
    }

    /// `ParticleEmitterInfo.shouldEmitParticle(numParticles, totalEmitted,
    /// emitterOffset, lastEmitTime)` with `currentTime()` = `now`.
    pub fn should_emit(&self, num_particles: f64, total_emitted: f64, offset: Vec3, last_emit_time: f64, now: f64) -> bool {
        if (self.total_particles <= 0.0 || total_emitted < self.total_particles) && num_particles < self.max_particles {
            if self.emitter_type == EMITTER_BIRTHRATE_PER_SEC {
                if now - last_emit_time > self.birthrate {
                    return true;
                }
            } else if self.emitter_type == EMITTER_BIRTHRATE_PER_METER {
                if self.birthrate * self.birthrate < offset.length_sq() {
                    return true;
                }
            }
        }
        false
    }
}
