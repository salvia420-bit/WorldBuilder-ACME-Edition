//! scene3d/particles/particle_emitter.js — one emitter's bookkeeping and its
//! per-tick `updateParticles()` (update → kill → maybe emit → stop), lazy
//! slot growth, `initEnd`'s burst, and the RP6 helpers of particle_manager.js
//! that touch emitter state (`_rp6Thaw`, `_rp6VirtualEmit`,
//! `_setPartsVisible`).

use super::Config;
use super::info::{EMITTER_BIRTHRATE_PER_METER, EMITTER_BIRTHRATE_PER_SEC, Info};
use super::layout::*;
use super::particle::{self, Frame, Slot, Spawn};
use super::three_ext::to_int32;
use crate::math::{Quat, Vec3};
use crate::rng::Rng;

/// particle_emitter.js `SLOT_GROW_STEP`.
pub const SLOT_GROW_STEP: usize = 8;

#[derive(Clone, Debug)]
pub struct Emitter {
    pub handle: u32,
    /// The JS emitter id (`?rp6Stagger` phase).
    pub id: u32,
    pub dead: bool,
    pub info: Info,
    pub parent_offset: Frame,
    pub num_particles: f64,
    pub total_emitted: f64,
    pub creation_time: f64,
    pub last_emit_time: f64,
    pub last_update_time: f64,
    pub last_emit_offset: Vec3,
    pub stopped: bool,
    /// `parts.length` (= capped maxParticles).
    pub max_slots: usize,
    /// `_createdSlots`: `slots.len()`.
    pub slots: Vec<Slot>,
    /// `_growing` + the target of the in-flight `_createSlots` (applied before
    /// the next tick, when the JS grow's microtasks have run).
    pub growing: bool,
    pub grow_target: usize,
    /// The anchor frame this tick (`_tickAnchorFrame()`); constant when cached.
    pub anchor: Frame,
    pub cached: bool,
    // ---- RP6 ----
    pub culled: bool,
    pub frozen_at: Option<f64>,
    pub culled_since: Option<f64>,
    pub rp6_center: Vec3,
    pub rp6_radius: f64,
    pub degrade_distance: f64,
    pub force_degrade: bool,
    // ---- render gates ----
    pub film_hidden: bool,
    // ---- buckets / FX ----
    pub route: u32,
    pub shared_eligible: bool,
    pub fx_if_create: bool,
    pub row: u32,
    pub kids_row: bool,
    pub stretch_row: bool,
    pub vel_lim_sq: f64,
    pub render_layer: u32,
    pub bb_mode: u32,
    pub bb_normal: Option<Vec3>,
}

#[inline]
fn v3(d: &[f64], i: usize) -> Vec3 {
    Vec3::new(d[i], d[i + 1], d[i + 2])
}

#[inline]
fn q4(d: &[f64], i: usize) -> Quat {
    Quat::new(d[i], d[i + 1], d[i + 2], d[i + 3])
}

impl Emitter {
    /// Build from an `add_emitter` descriptor (before initEnd).
    pub fn from_desc(handle: u32, d: &[f64]) -> Emitter {
        let info = Info::from_desc(d);
        let max_slots = if d[D_MAX_PARTICLES] > 0.0 { d[D_MAX_PARTICLES] as usize } else { 0 };
        let created = (d[D_CREATED_SLOTS].max(0.0) as usize).min(max_slots);
        let mut slots = Vec::with_capacity(created);
        slots.resize(created, Slot::default());
        Emitter {
            handle,
            id: to_int32(d[D_ID]) as u32,
            dead: false,
            info,
            parent_offset: Frame { pos: v3(d, D_PO_POS), quat: q4(d, D_PO_QUAT) },
            num_particles: 0.0,
            total_emitted: 0.0,
            creation_time: 0.0,
            last_emit_time: d[D_LAST_EMIT_TIME],
            last_update_time: d[D_LAST_UPDATE_TIME],
            last_emit_offset: v3(d, D_LAST_EMIT_OFFSET),
            stopped: false,
            max_slots,
            slots,
            growing: false,
            grow_target: 0,
            anchor: Frame { pos: v3(d, D_ANCHOR_POS), quat: q4(d, D_ANCHOR_QUAT) },
            cached: d[D_CACHED] != 0.0,
            culled: d[D_RP6_CULLED] != 0.0,
            frozen_at: None,
            culled_since: None,
            rp6_center: v3(d, D_RP6_CENTER),
            rp6_radius: d[D_RP6_RADIUS],
            degrade_distance: d[D_DEGRADE_DISTANCE],
            force_degrade: d[D_FORCE_DEGRADE] != 0.0,
            film_hidden: d[D_FILM_HIDDEN] != 0.0,
            route: to_int32(d[D_ROUTE]) as u32,
            shared_eligible: d[D_SHARED_ELIGIBLE] != 0.0,
            fx_if_create: d[D_FX_IF_CREATE] != 0.0,
            row: to_int32(d[D_ROW]) as u32,
            kids_row: d[D_KIDS_ROW] != 0.0,
            stretch_row: d[D_STRETCH_ROW] != 0.0,
            vel_lim_sq: d[D_VEL_LIM_SQ],
            render_layer: to_int32(d[D_RENDER_LAYER]) as u32,
            bb_mode: to_int32(d[D_BB_MODE]) as u32,
            bb_normal: if d[D_HAS_BB_NORMAL] != 0.0 { Some(v3(d, D_BB_NORMAL)) } else { None },
        }
    }

    /// `_isPersistentEmitter` / `firstParticle`.
    #[inline]
    pub fn persistent(&self) -> bool {
        self.info.persistent()
    }

    /// Land an in-flight lazy grow (the JS `_createSlots` microtasks have run
    /// by the time the next tick or query happens).
    pub fn settle_grow(&mut self) {
        if self.growing {
            let target = self.grow_target.min(self.max_slots);
            while self.slots.len() < target {
                self.slots.push(Slot::default());
            }
            self.growing = false;
        }
    }

    /// `_growSlots()`.
    fn grow_slots(&mut self) {
        if self.growing {
            return;
        }
        let max = to_int32(self.info.max_particles) as i64;
        let created = self.slots.len() as i64;
        if created >= max {
            return;
        }
        self.growing = true;
        self.grow_target = (created + SLOT_GROW_STEP as i64).min(max) as usize;
    }

    /// `getNextParticleIdx()` (every created slot is renderable here: the
    /// instanced path's carrier factory never returns null).
    fn next_particle_idx(&mut self) -> Option<usize> {
        for i in 0..self.slots.len() {
            if !self.slots[i].live {
                return Some(i);
            }
        }
        self.grow_slots();
        None
    }

    /// `_emitterOrigin(out)`: parentOffset rotated by the anchor frame, plus
    /// the anchor position.
    #[inline]
    pub fn emitter_origin(&self) -> Vec3 {
        self.parent_offset.pos.apply_quat(self.anchor.quat).add(self.anchor.pos)
    }

    /// `stopEmitter()`.
    pub fn stop_emitter(&mut self, now: f64) -> bool {
        if !self.stopped {
            if self.info.total_seconds > 0.0 && self.creation_time + self.info.total_seconds < now {
                self.stopped = true;
            }
            if self.info.total_particles > 0.0 && self.total_emitted >= self.info.total_particles {
                self.stopped = true;
            }
        }
        self.stopped
    }

    /// `recordParticleEmission()`.
    fn record_emission(&mut self, now: f64) {
        self.num_particles += 1.0;
        self.total_emitted += 1.0;
        self.last_emit_offset = self.emitter_origin();
        self.last_emit_time = now;
    }

    /// `shouldEmitParticle()`.
    pub fn should_emit(&self, now: f64) -> bool {
        let offset = if self.info.emitter_type == EMITTER_BIRTHRATE_PER_METER {
            self.emitter_origin().sub(self.last_emit_offset)
        } else {
            Vec3::ZERO
        };
        self.info.should_emit(self.num_particles, self.total_emitted, offset, self.last_emit_time, now)
    }

    /// `emitParticle()`.
    pub fn emit_particle(&mut self, now: f64, rng: &mut Rng, cfg: &Config) {
        let Some(idx) = self.next_particle_idx() else { return };
        {
            let s = &mut self.slots[idx];
            s.live = true;
            s.visible = true;
        }
        let info = &self.info;
        let persistent = info.persistent();
        let random_offset = info.random_offset(rng);
        let a = info.random_a(rng);
        let b = info.random_b(rng);
        let c = info.random_c(rng);
        let start_scale = info.random_start_scale(rng);
        let final_scale = info.random_final_scale(rng);
        let start_trans = info.random_start_trans(rng);
        let final_trans = info.random_final_trans(rng);
        let sp = Spawn { random_offset, persistent, a, b, c, start_scale, final_scale, start_trans, final_trans };
        let anchor = self.anchor;
        let po = self.parent_offset;
        particle::init(&mut self.slots[idx], &self.info, po, &sp, anchor, now, rng, cfg);
        self.record_emission(now);
    }

    /// `killParticle(i)`.
    fn kill_particle(&mut self, i: usize) {
        let s = &mut self.slots[i];
        if !(s.lifetime < s.lifespan) {
            s.visible = false;
            s.live = false;
            self.num_particles -= 1.0;
        }
    }

    /// `updateParticles()`: false when the emitter is stopped and empty.
    pub fn update_particles(&mut self, now: f64, rng: &mut Rng, cfg: &Config) -> bool {
        if self.info.max_particles > 0.0 {
            let persistent = self.persistent();
            let ptype = self.info.ptype;
            let parent_local = self.info.is_parent_local;
            for i in 0..self.slots.len() {
                if !self.slots[i].live {
                    continue;
                }
                let frame = if parent_local {
                    self.anchor
                } else {
                    let s = &self.slots[i];
                    Frame { pos: s.sf_pos, quat: s.sf_quat }
                };
                particle::update(&mut self.slots[i], ptype, persistent, frame, now, cfg);
                self.kill_particle(i);
            }
        }
        let mut has_particles = true;
        if !self.stopped {
            if self.should_emit(now) {
                self.emit_particle(now, rng, cfg);
            }
            self.stop_emitter(now);
        } else {
            has_particles = self.num_particles != 0.0;
        }
        self.last_update_time = now;
        has_particles
    }

    /// `initEnd()` (run at add time with the add-time clock).
    pub fn init_end(&mut self, now: f64, burst: f64, rng: &mut Rng, cfg: &Config) {
        self.creation_time = now;
        let mut i = 0.0;
        while i < burst {
            self.emit_particle(now, rng, cfg);
            i += 1.0;
        }
    }

    /// particle_manager.js `_rp6Thaw(emitter, now)`.
    pub fn rp6_thaw(&mut self, now: f64) -> f64 {
        let at = self.frozen_at.take();
        let Some(at) = at else { return 0.0 };
        let dt = now - at;
        if !(dt > 0.0) {
            return 0.0;
        }
        for s in self.slots.iter_mut() {
            if s.live {
                s.last_update_time += dt;
            }
        }
        dt
    }

    /// particle_manager.js `_rp6VirtualEmit(emitter, now)`.
    pub fn rp6_virtual_emit(&mut self, now: f64) -> bool {
        if !self.should_emit(now) {
            return false;
        }
        self.total_emitted += 1.0;
        self.last_emit_offset = self.emitter_origin();
        self.last_emit_time = now;
        true
    }

    /// particle_manager.js `_setPartsVisible(emitter, visible)`.
    pub fn set_parts_visible(&mut self, visible: bool) {
        for s in self.slots.iter_mut() {
            if s.live {
                s.visible = visible;
            }
        }
    }

    /// When the next tick may read the anchor frame (dynamic emitters get one
    /// from JS only then, layout NEED_*):
    /// - a parent-local update while particles live: always (the drain of a
    ///   stopped emitter included);
    /// - a per-second emitter: once its birthrate has elapsed and a slot is
    ///   free or may free (the emit and virtual-emit tests);
    /// - a per-metre emitter: once a slot is free or may free (its origin only
    ///   matters to a test that can pass);
    /// - never once stopped otherwise;
    /// and, for a persistent emitter that is not stopped, not on a culled tick
    /// (its culled branch neither emits virtually nor drains). Conservative:
    /// JS may resolve an unused frame, never skip a used one.
    pub fn needs_anchor(&self) -> u32 {
        if self.dead || self.cached {
            return NEED_NEVER;
        }
        let skip = if self.persistent() && !self.stopped { NEED_SKIP_IF_CULLED } else { 0 };
        if self.info.is_parent_local && self.num_particles > 0.0 {
            return NEED_ALWAYS | skip;
        }
        if self.stopped {
            return NEED_NEVER;
        }
        if self.info.emitter_type == EMITTER_BIRTHRATE_PER_METER {
            return NEED_IF_SLOT | skip;
        }
        if self.info.emitter_type == EMITTER_BIRTHRATE_PER_SEC {
            return NEED_IF_DUE | NEED_IF_SLOT | skip;
        }
        NEED_NEVER
    }

    /// NEED_IF_SLOT's threshold: `-inf` while a slot is free (`numParticles <
    /// maxParticles`, the emit test's own comparison), else the earliest time
    /// a live particle can die in an update (`!(lifetime < lifespan)`):
    /// `lastUpdateTime + lifespan`, or `+ lifespan - lifetime` for a
    /// persistent emitter (lifetime accumulates). Kills are the only way a
    /// saturated emitter's count drops before its emit test, and a thaw only
    /// moves deaths later, so `now >= threshold - margin` covers every emit.
    pub fn slot_free_at(&self) -> f64 {
        if self.num_particles < self.info.max_particles {
            return f64::NEG_INFINITY;
        }
        let persistent = self.persistent();
        let mut t = f64::INFINITY;
        for s in self.slots.iter() {
            if !s.live {
                continue;
            }
            let d = if persistent { s.last_update_time + (s.lifespan - s.lifetime) } else { s.last_update_time + s.lifespan };
            if d.is_nan() {
                return f64::NEG_INFINITY;
            }
            if d < t {
                t = d;
            }
        }
        t
    }

    /// `_createdSlots` once an in-flight lazy grow has landed (what
    /// `settle_grow` would make it), without landing it.
    pub fn settled_slot_count(&self) -> usize {
        if self.growing { self.slots.len().max(self.grow_target.min(self.max_slots)) } else { self.slots.len() }
    }

    /// The Q_* row (layout.rs) into `q` (Q_LEN f64), with settled slots.
    pub fn write_state(&self, q: &mut [f64]) {
        q[Q_NUM_PARTICLES] = self.num_particles;
        q[Q_TOTAL_EMITTED] = self.total_emitted;
        q[Q_CREATION_TIME] = self.creation_time;
        q[Q_LAST_EMIT_TIME] = self.last_emit_time;
        q[Q_LAST_UPDATE_TIME] = self.last_update_time;
        q[Q_STOPPED] = self.stopped as u32 as f64;
        q[Q_CREATED_SLOTS] = self.settled_slot_count() as f64;
        q[Q_CULLED] = self.culled as u32 as f64;
        q[Q_LAST_EMIT_OFFSET] = self.last_emit_offset.x;
        q[Q_LAST_EMIT_OFFSET + 1] = self.last_emit_offset.y;
        q[Q_LAST_EMIT_OFFSET + 2] = self.last_emit_offset.z;
        q[Q_FROZEN_AT] = self.frozen_at.unwrap_or(f64::NAN);
        q[Q_CULLED_SINCE] = self.culled_since.unwrap_or(f64::NAN);
        q[Q_GROWING] = 0.0;
    }
}
