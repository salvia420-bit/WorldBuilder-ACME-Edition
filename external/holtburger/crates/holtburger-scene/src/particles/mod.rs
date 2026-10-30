//! Lane A — the particle system (scene3d/particles/*) for INSTANCED emitters.
//!
//! The JS keeps, per instanced emitter, a `ParticleEmitter` with lazily
//! built slot meshes that never render: each tick `updateParticles()` moves
//! them and `_appendInstances` copies their transform + opacity into the
//! per-(gfxobj, layer, blend) InstancedMesh buckets. This module owns that
//! whole per-tick path in flat Rust state instead — emission, per-particle
//! init/update for all 12 types (with the four legacy URL escapes), kill,
//! stop, initEnd, lazy slot growth, the RP6 culled branch (freeze / thaw /
//! virtual emit / force stop / drain), the cell and film gates, both
//! billboard passes, and the instance packing (matrix, opacity or the FX
//! channels, the `?fxMotion` velocity row, tier-1 kid records) plus the own
//! alpha buckets' back-to-front sort — and hands JS one flat output per
//! tick. JS keeps the three.js objects (buckets, materials, kids meshes),
//! the emitter creation API and the per-mesh path.
//!
//! Reference: particle.js, particle_emitter.js, particle_emitter_info.js,
//! particle_manager.js (`_tickLatched`, `_appendInstances`,
//! `_finalizeInstBuckets`, `_rp6*`, `_billboard*`), particle_fx.js and
//! particle_fx_kids.js, all as of 2026-10-26. Lane notes:
//! apps/holtburger-web/docs/2026-10-26-rust-particles.md. Buffer layout:
//! [`layout`] (mirrored in scene3d/rust/particles.js).
//!
//! Exactness: f64 in the JS operation order, f32 rounding exactly where the
//! JS stores into a Float32Array. sin/cos (Swarm, Explode init, Implode, the
//! GR spins) may differ from V8 by an ulp before the f32 store.

pub mod layout;

mod billboard;
mod buckets;
mod emitter;
mod fx;
mod info;
mod particle;
mod sort;
mod three_ext;

pub use info::PType;
pub use sort::{SortScratch, sort_back_to_front, v8_typed_sort_desc};
pub use three_ext::{to_int32, to_uint32};

use buckets::BucketTick;
use emitter::Emitter;
use layout::*;
use particle::Frame;

use crate::math::{Mat4, Quat, Vec3};
use crate::rng::Rng;

/// The module-level URL escapes of particle.js (read once at module load).
#[derive(Clone, Copy, Debug, Default)]
pub struct Config {
    pub swarm_ace: bool,
    pub init_ace: bool,
    pub rot_euler: bool,
    pub init_frame_ace: bool,
}

impl Config {
    pub fn from_slice(c: &[f64]) -> Config {
        let f = |i: usize| c.get(i).copied().unwrap_or(0.0) != 0.0;
        Config {
            swarm_ace: f(CFG_SWARM_ACE),
            init_ace: f(CFG_INIT_ACE),
            rot_euler: f(CFG_ROT_EULER),
            init_frame_ace: f(CFG_INIT_FRAME_ACE),
        }
    }
}

/// One tick's outputs (see layout.rs). Valid until the next `tick`.
#[derive(Default, Debug)]
pub struct Outputs {
    pub events: Vec<u32>,
    pub buckets: Vec<u32>,
    pub mat: Vec<f32>,
    pub col: Vec<f32>,
    pub kids: Vec<u32>,
    pub kid_data: Vec<f32>,
    pub finished: Vec<u32>,
    pub stats: Vec<f64>,
}

impl Outputs {
    fn clear(&mut self) {
        self.events.clear();
        self.buckets.clear();
        self.mat.clear();
        self.col.clear();
        self.kids.clear();
        self.kid_data.clear();
        self.finished.clear();
        self.stats.clear();
    }
}

/// The per-tick globals, decoded.
struct TickCtx {
    now: f64,
    frame: f64,
    interval: f64,
    recheck: bool,
    stagger: bool,
    half_phase: bool,
    camera_valid: bool,
    cam: Vec3,
    planes: [f64; 24],
    max_distance: f64,
    degrade_on: bool,
    degrade_cap_on: bool,
    cull_freeze: bool,
    lean_culled: bool,
    culled_stop_seconds: f64,
    cell_gate: bool,
    bb_on: bool,
    bb_cam: Vec3,
    bb_cam_local: Vec3,
    sort_on: bool,
    sort_cam: [f64; 3],
    fx_enabled: bool,
    fx_live: bool,
    kids_on: bool,
    motion_on: bool,
    shared_on: bool,
}

impl TickCtx {
    fn from(g: &[f64]) -> TickCtx {
        let b = |i: usize| g[i] != 0.0;
        let v = |i: usize| Vec3::new(g[i], g[i + 1], g[i + 2]);
        let mut planes = [0.0f64; 24];
        planes.copy_from_slice(&g[G_PLANES..G_PLANES + 24]);
        TickCtx {
            now: g[G_NOW],
            frame: g[G_FRAME],
            interval: g[G_INTERVAL],
            recheck: b(G_RECHECK),
            stagger: b(G_STAGGER),
            half_phase: b(G_HALF_PHASE),
            camera_valid: b(G_CAMERA_VALID),
            cam: v(G_CAM_POS),
            planes,
            max_distance: g[G_MAX_DISTANCE],
            degrade_on: b(G_DEGRADE_ON),
            degrade_cap_on: b(G_DEGRADE_CAP_ON),
            cull_freeze: b(G_CULL_FREEZE),
            lean_culled: b(G_LEAN_CULLED),
            culled_stop_seconds: g[G_CULLED_STOP_SECONDS],
            cell_gate: b(G_CELL_GATE),
            bb_on: b(G_BB_ON),
            bb_cam: v(G_BB_CAM),
            bb_cam_local: v(G_BB_CAM_LOCAL),
            sort_on: b(G_SORT_ON),
            sort_cam: [g[G_SORT_CAM], g[G_SORT_CAM + 1], g[G_SORT_CAM + 2]],
            fx_enabled: b(G_FX_ENABLED),
            fx_live: b(G_FX_LIVE),
            kids_on: b(G_KIDS_ON),
            motion_on: b(G_MOTION_ON),
            shared_on: b(G_SHARED_ON),
        }
    }
}

/// `rp6DistanceCap(emitter)`.
fn rp6_distance_cap(e: &Emitter, c: &TickCtx) -> f64 {
    let cap = c.max_distance;
    if !c.degrade_cap_on {
        return cap;
    }
    let d = e.degrade_distance;
    if !d.is_finite() || !(d > cap) {
        return cap;
    }
    if !(c.degrade_on || e.force_degrade) {
        return cap;
    }
    d
}

/// `_rp6ShouldCull(emitter, camera)` on the cached sphere.
fn rp6_should_cull(e: &Emitter, c: &TickCtx) -> bool {
    let radius = e.rp6_radius;
    if radius < 0.0 {
        return false;
    }
    let p = e.rp6_center;
    let dx = p.x - c.cam.x;
    let dy = p.y - c.cam.y;
    let dz = p.z - c.cam.z;
    let dist_sq = dx * dx + dy * dy + dz * dz;
    let slack = rp6_distance_cap(e, c) + radius;
    if dist_sq > slack * slack {
        return true;
    }
    if (c.degrade_on || e.force_degrade)
        && e.degrade_distance.is_finite()
        && dist_sq > e.degrade_distance * e.degrade_distance
    {
        return true;
    }
    // !_rp6Frustum.intersectsSphere(sphere)
    let neg_radius = -radius;
    for i in 0..6 {
        let pl = &c.planes[i * 4..i * 4 + 4];
        let distance = pl[0] * p.x + pl[1] * p.y + pl[2] * p.z + pl[3];
        if distance < neg_radius {
            return true;
        }
    }
    false
}

/// The RE-ENTRY / freeze half of the due re-check in `_tickLatched`.
fn rp6_transition(e: &mut Emitter, was: bool, now_c: bool, now: f64, c: &TickCtx) {
    if now_c != was && !now_c {
        e.culled_since = None;
        e.rp6_thaw(now);
        e.set_parts_visible(true);
    } else if now_c && !was && !e.stopped && e.persistent() && c.cull_freeze {
        e.frozen_at = Some(now);
    }
}

/// The kernel for one ParticleManager's instanced emitters.
pub struct ParticleSystem {
    cfg: Config,
    rng: Rng,
    emitters: Vec<Emitter>,
    handle_index: Vec<i32>,
    free_handles: Vec<u32>,
    needs_compact: bool,
    /// Per handle: the dynamic anchor frame (ANCHOR_STRIDE f64). JS writes it
    /// before a tick for every dynamic emitter whose `needs_anchor` is set.
    pub anchor_in: Vec<f64>,
    /// Per handle: FLAG_CULLED / FLAG_CELL_HIDDEN for dynamic emitters.
    pub flags_in: Vec<u32>,
    /// Per route: ROUTE_STRIDE f64. JS sizes and fills it.
    pub route_in: Vec<f64>,
    /// Per bucket key: KEY_STRIDE f64. JS sizes and fills it.
    pub key_in: Vec<f64>,
    /// Per handle (`publish`): when JS must supply the anchor (layout
    /// NEED_*), the emit clock NEED_IF_DUE compares against, and NEED_IF_SLOT's
    /// threshold.
    pub needs_anchor: Vec<u32>,
    pub anchor_last_emit: Vec<f64>,
    pub anchor_slot_free: Vec<f64>,
    /// Per handle: the Q_* row (Q_LEN f64, `publish`), read by JS field views.
    pub state_out: Vec<f64>,
    /// `film_samples` output (layout FS_*).
    pub film_out: Vec<f64>,
    pub out: Outputs,
    buckets: BucketTick,
    kid_layers: Vec<(u32, Vec<f32>)>,
    kid_layers_len: usize,
    /// Scratch for JS-side sorts of shared alpha buckets (`sort_scratch_run`).
    pub sort_mat: Vec<f32>,
    pub sort_col: Vec<f32>,
    sort_scratch: SortScratch,
}

impl ParticleSystem {
    pub fn new(cfg: Config, rng: Rng) -> ParticleSystem {
        ParticleSystem {
            cfg,
            rng,
            emitters: Vec::new(),
            handle_index: Vec::new(),
            free_handles: Vec::new(),
            needs_compact: false,
            anchor_in: Vec::new(),
            flags_in: Vec::new(),
            route_in: Vec::new(),
            key_in: Vec::new(),
            needs_anchor: Vec::new(),
            anchor_last_emit: Vec::new(),
            anchor_slot_free: Vec::new(),
            state_out: Vec::new(),
            film_out: Vec::new(),
            out: Outputs::default(),
            buckets: BucketTick::default(),
            kid_layers: Vec::new(),
            kid_layers_len: 0,
            sort_mat: Vec::new(),
            sort_col: Vec::new(),
            sort_scratch: SortScratch::default(),
        }
    }

    pub fn set_rng(&mut self, rng: Rng) {
        self.rng = rng;
    }

    pub fn rng(&self) -> &Rng {
        &self.rng
    }

    /// Live (not removed / finished) emitters.
    pub fn emitter_count(&self) -> usize {
        self.emitters.iter().filter(|e| !e.dead).count()
    }

    /// Handles in use span `[0, handle_capacity)` (the per-handle buffers).
    pub fn handle_capacity(&self) -> usize {
        self.handle_index.len()
    }

    /// Size the route / key tables (JS fills them before each tick).
    pub fn set_tables(&mut self, routes: usize, keys: usize) {
        self.route_in.resize(routes * ROUTE_STRIDE, -1.0);
        self.key_in.resize(keys * KEY_STRIDE, 0.0);
    }

    fn index_of(&self, handle: u32) -> Option<usize> {
        let i = *self.handle_index.get(handle as usize)?;
        if i < 0 {
            return None;
        }
        let i = i as usize;
        let e = self.emitters.get(i)?;
        if e.dead || e.handle != handle { None } else { Some(i) }
    }

    fn alloc_handle(&mut self) -> u32 {
        if let Some(h) = self.free_handles.pop() {
            return h;
        }
        let h = self.handle_index.len() as u32;
        self.handle_index.push(-1);
        self.anchor_in.resize(self.handle_index.len() * ANCHOR_STRIDE, 0.0);
        self.flags_in.resize(self.handle_index.len(), 0);
        self.needs_anchor.resize(self.handle_index.len(), 0);
        self.anchor_last_emit.resize(self.handle_index.len(), 0.0);
        self.anchor_slot_free.resize(self.handle_index.len(), 0.0);
        self.state_out.resize(self.handle_index.len() * Q_LEN, 0.0);
        h
    }

    /// Refresh the per-handle outputs JS reads between ticks (anchor needs,
    /// the emit clock and slot threshold, the Q_* row) for `emitters[i]` —
    /// also for one that just finished (dead), whose row then reads final.
    fn publish(&mut self, i: usize) {
        let e = &self.emitters[i];
        let hu = e.handle as usize;
        if hu >= self.needs_anchor.len() {
            return;
        }
        self.needs_anchor[hu] = e.needs_anchor();
        self.anchor_last_emit[hu] = e.last_emit_time;
        self.anchor_slot_free[hu] = e.slot_free_at();
        e.write_state(&mut self.state_out[hu * Q_LEN..hu * Q_LEN + Q_LEN]);
    }

    /// `addEmitter`'s Rust half: register the emitter and run `initEnd`'s
    /// burst. Returns the handle, or `u32::MAX` for a short descriptor.
    pub fn add_emitter(&mut self, desc: &[f64]) -> u32 {
        self.add_emitter_at(desc, u32::MAX)
    }

    /// `add_emitter`, placed in the tick order right before the live emitter
    /// `before` (any other value appends). JS uses it when an in-place
    /// `particleTable` overwrite (two same-id creates) puts the newcomer at the
    /// orphan's table position, so the kernel walks emitters in table order.
    pub fn add_emitter_at(&mut self, desc: &[f64], before: u32) -> u32 {
        if desc.len() < D_LEN {
            return u32::MAX;
        }
        let at = self.index_of(before);
        let h = self.alloc_handle();
        let mut e = Emitter::from_desc(h, desc);
        let ParticleSystem { cfg, rng, .. } = self;
        e.init_end(desc[D_INIT_NOW], desc[D_BURST], rng, cfg);
        let hu = h as usize;
        let a = e.anchor;
        self.anchor_in[hu * ANCHOR_STRIDE..hu * ANCHOR_STRIDE + ANCHOR_STRIDE]
            .copy_from_slice(&[a.pos.x, a.pos.y, a.pos.z, a.quat.x, a.quat.y, a.quat.z, a.quat.w]);
        self.flags_in[hu] = if e.culled { FLAG_CULLED } else { 0 };
        let i = match at {
            Some(i) => {
                self.emitters.insert(i, e);
                // everything from i on moved one place (dead entries keep
                // their freed, possibly reused, handles out of the index)
                for j in i..self.emitters.len() {
                    let ej = &self.emitters[j];
                    if !ej.dead {
                        self.handle_index[ej.handle as usize] = j as i32;
                    }
                }
                i
            }
            None => {
                self.handle_index[hu] = self.emitters.len() as i32;
                self.emitters.push(e);
                self.emitters.len() - 1
            }
        };
        self.publish(i);
        h
    }

    /// `destroyParticleEmitter` (no-op for an unknown handle).
    pub fn remove_emitter(&mut self, handle: u32) -> bool {
        let Some(i) = self.index_of(handle) else { return false };
        self.emitters[i].dead = true;
        self.handle_index[handle as usize] = -1;
        self.needs_anchor[handle as usize] = 0;
        self.flags_in[handle as usize] = 0;
        self.free_handles.push(handle);
        self.needs_compact = true;
        true
    }

    /// `stopParticleEmitter` (`e.stopped = true`). Republishes the emitter's
    /// row and anchor needs (a culled persistent emitter drains from now on).
    pub fn stop_emitter(&mut self, handle: u32) -> bool {
        let Some(i) = self.index_of(handle) else { return false };
        self.emitters[i].stopped = true;
        self.publish(i);
        true
    }

    /// A field written by JS after creation (async stamps, film mode, …).
    pub fn set_field(&mut self, handle: u32, field: u32, value: f64) -> bool {
        let Some(i) = self.index_of(handle) else { return false };
        let e = &mut self.emitters[i];
        match field {
            F_DEGRADE_DISTANCE => e.degrade_distance = value,
            F_FORCE_DEGRADE => e.force_degrade = value != 0.0,
            F_BB_MODE => e.bb_mode = to_int32(value) as u32,
            F_FILM_HIDDEN => e.film_hidden = value != 0.0,
            F_STOPPED => e.stopped = value != 0.0,
            F_ID => e.id = to_uint32(value),
            F_RP6_CX => e.rp6_center.x = value,
            F_RP6_CY => e.rp6_center.y = value,
            F_RP6_CZ => e.rp6_center.z = value,
            F_RP6_RADIUS => e.rp6_radius = value,
            _ => return false,
        }
        self.publish(i);
        true
    }

    /// Re-anchor a cached emitter (its `_scene` moved).
    pub fn set_cached_anchor(&mut self, handle: u32, f: &[f64]) -> bool {
        if f.len() < ANCHOR_STRIDE {
            return false;
        }
        let Some(i) = self.index_of(handle) else { return false };
        self.emitters[i].anchor = Frame { pos: Vec3::new(f[0], f[1], f[2]), quat: Quat::new(f[3], f[4], f[5], f[6]) };
        true
    }

    /// The emitter's scalars (Q_* layout); empty for an unknown handle.
    pub fn emitter_state(&mut self, handle: u32) -> Vec<f64> {
        let Some(i) = self.index_of(handle) else { return Vec::new() };
        let e = &mut self.emitters[i];
        e.settle_grow();
        let mut q = vec![0.0; Q_LEN];
        e.write_state(&mut q);
        q
    }

    /// Every created slot (SL_* layout, SL_STRIDE each).
    pub fn slot_snapshot(&mut self, handle: u32) -> Vec<f64> {
        let Some(i) = self.index_of(handle) else { return Vec::new() };
        let e = &mut self.emitters[i];
        e.settle_grow();
        let mut out = Vec::with_capacity(e.slots.len() * SL_STRIDE);
        for s in e.slots.iter() {
            let base = out.len();
            out.resize(base + SL_STRIDE, 0.0);
            let o = &mut out[base..base + SL_STRIDE];
            o[SL_LIVE] = s.live as u32 as f64;
            o[SL_VISIBLE] = s.visible as u32 as f64;
            o[SL_OP] = s.op;
            o[SL_POS..SL_POS + 3].copy_from_slice(&[s.pos.x, s.pos.y, s.pos.z]);
            o[SL_QUAT..SL_QUAT + 4].copy_from_slice(&[s.quat.x, s.quat.y, s.quat.z, s.quat.w]);
            o[SL_SCALE] = s.scale;
            o[SL_LAST_UPDATE_TIME] = s.last_update_time;
            o[SL_BIRTHTIME] = s.birthtime;
            o[SL_LIFESPAN] = s.lifespan;
            o[SL_LIFETIME] = s.lifetime;
            o[SL_SF_POS..SL_SF_POS + 3].copy_from_slice(&[s.sf_pos.x, s.sf_pos.y, s.sf_pos.z]);
            o[SL_SF_QUAT..SL_SF_QUAT + 4].copy_from_slice(&[s.sf_quat.x, s.sf_quat.y, s.sf_quat.z, s.sf_quat.w]);
            o[SL_OFFSET..SL_OFFSET + 3].copy_from_slice(&[s.offset.x, s.offset.y, s.offset.z]);
            o[SL_A..SL_A + 3].copy_from_slice(&[s.a.x, s.a.y, s.a.z]);
            o[SL_B..SL_B + 3].copy_from_slice(&[s.b.x, s.b.y, s.b.z]);
            o[SL_C..SL_C + 3].copy_from_slice(&[s.c.x, s.c.y, s.c.z]);
            o[SL_START_SCALE] = s.start_scale;
            o[SL_FINAL_SCALE] = s.final_scale;
            o[SL_START_TRANS] = s.start_trans;
            o[SL_FINAL_TRANS] = s.final_trans;
            o[SL_SEED] = s.seed as f64;
            o[SL_LIFE] = s.life as f64;
            for k in 0..8 {
                o[SL_VEL + k] = s.vel[k] as f64;
            }
            for k in 0..5 {
                o[SL_KID_PREV + k] = s.kid_prev[k] as f64;
            }
        }
        out
    }

    fn compact(&mut self) {
        self.emitters.retain(|e| !e.dead);
        for h in self.handle_index.iter_mut() {
            *h = -1;
        }
        for (i, e) in self.emitters.iter().enumerate() {
            self.handle_index[e.handle as usize] = i as i32;
        }
        self.needs_compact = false;
    }

    /// One ParticleManager tick for every instanced emitter (the Rust half of
    /// `_tickLatched` + `_appendInstances` + the own-bucket part of
    /// `_finalizeInstBuckets`). `g` is the G_* globals block.
    pub fn tick(&mut self, g: &[f64]) {
        self.out.clear();
        if g.len() < G_LEN {
            return;
        }
        if self.needs_compact {
            self.compact();
        }
        let c = TickCtx::from(g);
        let now = c.now;
        self.buckets.begin(&self.key_in);
        for k in self.kid_layers.iter_mut() {
            k.1.clear();
        }
        self.kid_layers_len = 0;
        let mut seed_state = to_uint32(g[G_FX_SEED]);
        let mut stats = [0.0f64; S_LEN];
        let mut kids_mgr_done = false;

        let ParticleSystem {
            cfg,
            rng,
            emitters,
            anchor_in,
            flags_in,
            route_in,
            buckets,
            kid_layers,
            kid_layers_len,
            out,
            ..
        } = self;

        for e in emitters.iter_mut() {
            if e.dead {
                continue;
            }
            e.settle_grow();
            let hu = e.handle as usize;
            let flags = flags_in.get(hu).copied().unwrap_or(0);
            if !e.cached {
                if let Some(a) = anchor_in.get(hu * ANCHOR_STRIDE..hu * ANCHOR_STRIDE + ANCHOR_STRIDE) {
                    e.anchor = Frame { pos: Vec3::new(a[0], a[1], a[2]), quat: Quat::new(a[3], a[4], a[5], a[6]) };
                }
            }

            // ---- RP6 re-check (cached spheres here; dynamic ones decided by JS) ----
            if e.cached {
                let due = if c.stagger {
                    let phase = if c.half_phase { (e.id >> 1) as f64 } else { e.id as f64 };
                    (c.frame + phase) % c.interval == 0.0
                } else {
                    c.recheck
                };
                if due {
                    let was = e.culled;
                    let now_c = if c.camera_valid { rp6_should_cull(e, &c) } else { false };
                    e.culled = now_c;
                    rp6_transition(e, was, now_c, now, &c);
                }
            } else {
                let now_c = flags & FLAG_CULLED != 0;
                let was = e.culled;
                if now_c != was {
                    e.culled = now_c;
                    rp6_transition(e, was, now_c, now, &c);
                }
            }

            // ---- the culled branch ----
            if e.culled {
                if !e.stopped && !e.persistent() && c.cull_freeze {
                    e.rp6_virtual_emit(now);
                }
                e.stop_emitter(now);
                if !e.stopped && to_int32(e.info.total_particles) > 0 {
                    match e.culled_since {
                        None => e.culled_since = Some(now),
                        Some(since) => {
                            if now - since >= c.culled_stop_seconds {
                                e.stopped = true;
                                stats[S_FORCE_STOPPED] += 1.0;
                            }
                        }
                    }
                }
                let mut drained = false;
                if e.stopped {
                    e.rp6_thaw(now);
                    drained = !e.update_particles(now, rng, cfg);
                    if drained {
                        e.dead = true;
                        out.finished.push(e.handle);
                    }
                }
                // ?particleCulledLean: an instanced emitter's carriers draw
                // nothing, so the per-tick hide is skipped when lean.
                if !drained && !c.lean_culled {
                    e.set_parts_visible(false);
                }
                continue;
            }

            if !e.update_particles(now, rng, cfg) {
                e.dead = true;
                out.finished.push(e.handle);
                continue;
            }
            if e.film_hidden {
                continue;
            }
            if c.cell_gate && (flags & FLAG_CELL_HIDDEN) != 0 {
                stats[S_CELL_HIDDEN] += 1.0;
                stats[S_CELL_PARTICLE_TICKS] += to_int32(e.num_particles) as f64;
                continue;
            }
            if c.bb_on {
                if e.info.billboard {
                    billboard::sprite(&mut e.slots, e.bb_normal, c.bb_cam);
                } else if e.bb_mode != 0 {
                    billboard::retail(&mut e.slots, e.bb_mode, c.bb_cam_local);
                }
            }
            append_instances(
                e,
                &c,
                route_in,
                buckets,
                &mut out.events,
                kid_layers,
                kid_layers_len,
                &mut seed_state,
                &mut kids_mgr_done,
            );
        }

        // ---- _finalizeInstBuckets (own alpha buckets) + the flat outputs ----
        if c.sort_on {
            buckets.sort_own_alpha(c.sort_cam);
        }
        let mut first = 0u32;
        for u in buckets.used() {
            let n = u.count() as u32;
            out.buckets.extend_from_slice(&[u.kind, u.key, n, first]);
            out.mat.extend_from_slice(&u.mat);
            out.col.extend_from_slice(&u.col);
            first += n;
        }
        let mut first_kid = 0u32;
        for (layer, data) in kid_layers.iter().take(*kid_layers_len) {
            let n = (data.len() / KID_STRIDE) as u32;
            out.kids.extend_from_slice(&[*layer, n, first_kid]);
            out.kid_data.extend_from_slice(data);
            first_kid += n;
        }
        stats[S_REJECTED_SCENE] = buckets.rejected_scene;
        stats[S_REJECTED_MAT] = buckets.rejected_mat;
        stats[S_FX_SEED] = seed_state as f64;
        out.stats.extend_from_slice(&stats);

        // ---- every row JS reads until the next tick (the finished ones read
        // final), then the finished emitters free their handles ----
        let mut any_dead = false;
        for i in 0..self.emitters.len() {
            if self.emitters[i].dead {
                any_dead = true;
            }
            self.publish(i);
        }
        for &h in self.out.finished.iter() {
            let hu = h as usize;
            self.handle_index[hu] = -1;
            self.needs_anchor[hu] = 0;
            self.flags_in[hu] = 0;
            self.free_handles.push(h);
        }
        if any_dead {
            self.needs_compact = true;
        }
    }

    /// Film mode's per-emitter particle sample (layout FS_*, into `film_out`):
    /// for every live emitter `[handle, n]`, then the first `max` slots that
    /// are live, visible, at a finite position and whose
    /// `clamp01(isFinite(op) ? op : 1)` exceeds `op_min` — the sample
    /// film/scene/particles_query.js `sphereOf` takes from `emitter.parts`,
    /// for every emitter in one call and without building slot meshes.
    pub fn film_samples(&mut self, max: usize, op_min: f64) {
        self.film_out.clear();
        for e in self.emitters.iter() {
            if e.dead {
                continue;
            }
            let head = self.film_out.len();
            self.film_out.push(e.handle as f64);
            self.film_out.push(0.0);
            let mut n = 0usize;
            for s in e.slots.iter() {
                if n >= max {
                    break;
                }
                if !s.live || !s.visible {
                    continue;
                }
                let raw = if s.op.is_finite() { s.op } else { 1.0 };
                let op = if raw < 0.0 {
                    0.0
                } else if raw > 1.0 {
                    1.0
                } else {
                    raw
                };
                if op <= op_min {
                    continue;
                }
                if !(s.pos.x.is_finite() && s.pos.y.is_finite() && s.pos.z.is_finite()) {
                    continue;
                }
                self.film_out.extend_from_slice(&[s.pos.x, s.pos.y, s.pos.z, s.scale, s.op]);
                n += 1;
            }
            self.film_out[head + 1] = n as f64;
        }
    }

    /// Size the JS sort scratch (`sort_mat` / `sort_col`) for `n` instances.
    pub fn sort_scratch_reserve(&mut self, n: usize) {
        self.sort_mat.resize(n * MAT_STRIDE, 0.0);
        self.sort_col.resize(n * COL_STRIDE, 0.0);
    }

    /// `_sortBucketBackToFront` on the scratch (JS copies a shared bucket's
    /// first `n` instances in, then reads them back).
    pub fn sort_scratch_run(&mut self, n: usize, cam: [f64; 3], has_col: bool) {
        if self.sort_mat.len() < n * MAT_STRIDE || (has_col && self.sort_col.len() < n * COL_STRIDE) {
            return;
        }
        let ParticleSystem { sort_mat, sort_col, sort_scratch, .. } = self;
        let col = if has_col { Some(&mut sort_col[..]) } else { None };
        sort_back_to_front(&mut sort_mat[..], col, n, cam, sort_scratch);
    }
}

/// `_appendInstances(emitter)` for one live, drawn emitter.
#[allow(clippy::too_many_arguments)]
fn append_instances(
    e: &mut Emitter,
    c: &TickCtx,
    route_in: &[f64],
    buckets: &mut BucketTick,
    events: &mut Vec<u32>,
    kid_layers: &mut Vec<(u32, Vec<f32>)>,
    kid_layers_len: &mut usize,
    seed_state: &mut u32,
    kids_mgr_done: &mut bool,
) {
    // `if (!parts || !parts.length) return;`
    if e.max_slots == 0 {
        return;
    }
    let r = e.route as usize;
    let Some(&key_f) = route_in.get(r * ROUTE_STRIDE) else { return };
    if !(key_f >= 0.0) {
        return;
    }
    let sig = route_in.get(r * ROUTE_STRIDE + 1).copied().unwrap_or(0.0) as u32;
    let Some(t) = buckets.resolve(
        key_f as u32,
        sig,
        e.shared_eligible,
        c.shared_on,
        e.fx_if_create,
        c.fx_enabled,
        e.handle,
        e.num_particles,
        events,
    ) else {
        return;
    };
    let fx = t.fx;
    let kids = fx && c.kids_on && e.row > 0 && e.kids_row;
    if kids && !*kids_mgr_done {
        events.extend_from_slice(&[EV_KIDS_MGR, 0, 0]);
        *kids_mgr_done = true;
    }
    let motion = fx && e.row > 0 && c.motion_on && e.stretch_row;
    let now_sec = if kids || motion { c.now } else { 0.0 };
    let row = e.row;
    let layer = e.render_layer;
    let lim_sq = e.vel_lim_sq;
    let mut n = t.n;
    let cap = t.cap;
    {
        let (mat, col) = buckets.buffers(&t);
        for s in e.slots.iter_mut() {
            if !(n < cap) {
                break;
            }
            if !s.live || !s.visible {
                continue;
            }
            let m = Mat4::compose(s.pos, s.quat, Vec3::new(s.scale, s.scale, s.scale));
            let base = mat.len();
            for v in m.e.iter() {
                mat.push(*v as f32);
            }
            let op = s.op;
            if fx {
                let age = fx::age(s);
                let lifetime = s.lifetime;
                let seed = fx::seed_for(s, lifetime, seed_state);
                col.push(op as f32);
                col.push(age as f32);
                col.push(fx::packed(row, seed, c.fx_live) as f32);
                if kids {
                    let mut li = usize::MAX;
                    for (j, kl) in kid_layers.iter().take(*kid_layers_len).enumerate() {
                        if kl.0 == layer {
                            li = j;
                            break;
                        }
                    }
                    if li == usize::MAX {
                        events.extend_from_slice(&[EV_KIDS_LAYER, layer, 0]);
                        li = *kid_layers_len;
                        if li == kid_layers.len() {
                            kid_layers.push((layer, Vec::new()));
                        } else {
                            kid_layers[li].0 = layer;
                            kid_layers[li].1.clear();
                        }
                        *kid_layers_len += 1;
                    }
                    fx::kid_push(s, m.e[12], m.e[13], m.e[14], age, op, row, seed, now_sec, &mut kid_layers[li].1);
                }
                if motion {
                    let v = fx::slot_velocity(s, m.e[12], m.e[13], m.e[14], seed, now_sec, lim_sq);
                    mat[base + 3] = v[0] as f32;
                    mat[base + 7] = v[1] as f32;
                    mat[base + 11] = v[2] as f32;
                }
            } else {
                let o = op as f32;
                col.push(o);
                col.push(o);
                col.push(o);
            }
            n += 1.0;
        }
    }
    buckets.set_n(&t, n);
}
