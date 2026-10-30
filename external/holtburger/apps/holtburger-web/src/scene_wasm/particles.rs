// Lane glue for holtburger_scene::particles (lane A, docs/2026-10-26-rust-particles.md).
//
// `SceneParticles` wraps one `ParticleSystem` (one per JS ParticleManager that
// has instanced emitters). The JS bridge is scene3d/rust/particles.js:
//   - addEmitter(desc) / removeEmitter / stopEmitter / setField /
//     setCachedAnchor when emitters come and go or JS stamps a field;
//   - ONE tick(globals) per manager tick, after writing the per-handle /
//     per-route / per-key input buffers through views (`*InPtr` / `*InLen`);
//   - outputs read through views (`eventsPtr`, `bucketsPtr`, `matPtr`, …)
//     right after tick(), before the next call into this object.
// Layout of every buffer: crates/holtburger-scene/src/particles/layout.rs.

use holtburger_scene::particles::{Config, ParticleSystem};
use holtburger_scene::rng::Rng;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct SceneParticles {
    sys: ParticleSystem,
}

#[wasm_bindgen]
impl SceneParticles {
    /// `new SceneParticles(seedLo, seedHi, config)` — config is the CFG_*
    /// block (particle.js legacy escapes); the RNG is SplitMix64(seed).
    #[wasm_bindgen(constructor)]
    pub fn new(seed_lo: u32, seed_hi: u32, config: &[f64]) -> SceneParticles {
        let seed = ((seed_hi as u64) << 32) | seed_lo as u64;
        SceneParticles { sys: ParticleSystem::new(Config::from_slice(config), Rng::seeded(seed)) }
    }

    /// Test seam: replay these draws instead of the seeded stream.
    #[wasm_bindgen(js_name = setScriptedRng)]
    pub fn set_scripted_rng(&mut self, values: &[f64]) {
        self.sys.set_rng(Rng::scripted(values.to_vec()));
    }

    /// Draws consumed from a scripted stream (-1 when seeded).
    #[wasm_bindgen(js_name = rngConsumed)]
    pub fn rng_consumed(&self) -> i32 {
        match self.sys.rng().consumed() {
            Some(n) => n as i32,
            None => -1,
        }
    }

    #[wasm_bindgen(js_name = rngOverrun)]
    pub fn rng_overrun(&self) -> bool {
        self.sys.rng().overrun()
    }

    /// Register one emitter and run its initEnd burst; returns the handle
    /// (0xFFFFFFFF for a short descriptor).
    #[wasm_bindgen(js_name = addEmitter)]
    pub fn add_emitter(&mut self, desc: &[f64]) -> u32 {
        self.sys.add_emitter(desc)
    }

    /// `addEmitter`, placed right before the live emitter `before` in the
    /// tick order (0xFFFFFFFF appends) — the in-place table overwrite case.
    #[wasm_bindgen(js_name = addEmitterAt)]
    pub fn add_emitter_at(&mut self, desc: &[f64], before: u32) -> u32 {
        self.sys.add_emitter_at(desc, before)
    }

    #[wasm_bindgen(js_name = removeEmitter)]
    pub fn remove_emitter(&mut self, handle: u32) -> bool {
        self.sys.remove_emitter(handle)
    }

    #[wasm_bindgen(js_name = stopEmitter)]
    pub fn stop_emitter(&mut self, handle: u32) -> bool {
        self.sys.stop_emitter(handle)
    }

    #[wasm_bindgen(js_name = setField)]
    pub fn set_field(&mut self, handle: u32, field: u32, value: f64) -> bool {
        self.sys.set_field(handle, field, value)
    }

    #[wasm_bindgen(js_name = setCachedAnchor)]
    pub fn set_cached_anchor(&mut self, handle: u32, frame: &[f64]) -> bool {
        self.sys.set_cached_anchor(handle, frame)
    }

    /// Size the route / key input tables (counts, not floats).
    #[wasm_bindgen(js_name = setTables)]
    pub fn set_tables(&mut self, routes: u32, keys: u32) {
        self.sys.set_tables(routes as usize, keys as usize);
    }

    #[wasm_bindgen(js_name = emitterState)]
    pub fn emitter_state(&mut self, handle: u32) -> Vec<f64> {
        self.sys.emitter_state(handle)
    }

    #[wasm_bindgen(js_name = slotSnapshot)]
    pub fn slot_snapshot(&mut self, handle: u32) -> Vec<f64> {
        self.sys.slot_snapshot(handle)
    }

    #[wasm_bindgen(js_name = emitterCount)]
    pub fn emitter_count(&self) -> u32 {
        self.sys.emitter_count() as u32
    }

    #[wasm_bindgen(js_name = handleCapacity)]
    pub fn handle_capacity(&self) -> u32 {
        self.sys.handle_capacity() as u32
    }

    /// The manager tick (G_* globals block).
    pub fn tick(&mut self, globals: &[f64]) {
        self.sys.tick(globals);
    }

    // ---- input buffers (JS writes through views) ----
    #[wasm_bindgen(js_name = anchorInPtr)]
    pub fn anchor_in_ptr(&self) -> u32 {
        self.sys.anchor_in.as_ptr() as u32
    }
    #[wasm_bindgen(js_name = anchorInLen)]
    pub fn anchor_in_len(&self) -> u32 {
        self.sys.anchor_in.len() as u32
    }
    #[wasm_bindgen(js_name = flagsInPtr)]
    pub fn flags_in_ptr(&self) -> u32 {
        self.sys.flags_in.as_ptr() as u32
    }
    #[wasm_bindgen(js_name = flagsInLen)]
    pub fn flags_in_len(&self) -> u32 {
        self.sys.flags_in.len() as u32
    }
    #[wasm_bindgen(js_name = routeInPtr)]
    pub fn route_in_ptr(&self) -> u32 {
        self.sys.route_in.as_ptr() as u32
    }
    #[wasm_bindgen(js_name = routeInLen)]
    pub fn route_in_len(&self) -> u32 {
        self.sys.route_in.len() as u32
    }
    #[wasm_bindgen(js_name = keyInPtr)]
    pub fn key_in_ptr(&self) -> u32 {
        self.sys.key_in.as_ptr() as u32
    }
    #[wasm_bindgen(js_name = keyInLen)]
    pub fn key_in_len(&self) -> u32 {
        self.sys.key_in.len() as u32
    }
    #[wasm_bindgen(js_name = needsAnchorPtr)]
    pub fn needs_anchor_ptr(&self) -> u32 {
        self.sys.needs_anchor.as_ptr() as u32
    }
    #[wasm_bindgen(js_name = needsAnchorLen)]
    pub fn needs_anchor_len(&self) -> u32 {
        self.sys.needs_anchor.len() as u32
    }
    #[wasm_bindgen(js_name = anchorLastEmitPtr)]
    pub fn anchor_last_emit_ptr(&self) -> u32 {
        self.sys.anchor_last_emit.as_ptr() as u32
    }
    #[wasm_bindgen(js_name = anchorLastEmitLen)]
    pub fn anchor_last_emit_len(&self) -> u32 {
        self.sys.anchor_last_emit.len() as u32
    }
    #[wasm_bindgen(js_name = anchorSlotFreePtr)]
    pub fn anchor_slot_free_ptr(&self) -> u32 {
        self.sys.anchor_slot_free.as_ptr() as u32
    }
    #[wasm_bindgen(js_name = anchorSlotFreeLen)]
    pub fn anchor_slot_free_len(&self) -> u32 {
        self.sys.anchor_slot_free.len() as u32
    }
    /// Per-handle Q_* rows (re-read the pointer after addEmitter / tick).
    #[wasm_bindgen(js_name = stateOutPtr)]
    pub fn state_out_ptr(&self) -> u32 {
        self.sys.state_out.as_ptr() as u32
    }
    #[wasm_bindgen(js_name = stateOutLen)]
    pub fn state_out_len(&self) -> u32 {
        self.sys.state_out.len() as u32
    }

    // ---- film mode's particle sample (layout FS_*) ----
    #[wasm_bindgen(js_name = filmSamples)]
    pub fn film_samples(&mut self, max: u32, op_min: f64) {
        self.sys.film_samples(max as usize, op_min);
    }
    #[wasm_bindgen(js_name = filmOutPtr)]
    pub fn film_out_ptr(&self) -> u32 {
        self.sys.film_out.as_ptr() as u32
    }
    #[wasm_bindgen(js_name = filmOutLen)]
    pub fn film_out_len(&self) -> u32 {
        self.sys.film_out.len() as u32
    }

    // ---- outputs (valid until the next call) ----
    #[wasm_bindgen(js_name = eventsPtr)]
    pub fn events_ptr(&self) -> u32 {
        self.sys.out.events.as_ptr() as u32
    }
    #[wasm_bindgen(js_name = eventsLen)]
    pub fn events_len(&self) -> u32 {
        self.sys.out.events.len() as u32
    }
    #[wasm_bindgen(js_name = bucketsPtr)]
    pub fn buckets_ptr(&self) -> u32 {
        self.sys.out.buckets.as_ptr() as u32
    }
    #[wasm_bindgen(js_name = bucketsLen)]
    pub fn buckets_len(&self) -> u32 {
        self.sys.out.buckets.len() as u32
    }
    #[wasm_bindgen(js_name = matPtr)]
    pub fn mat_ptr(&self) -> u32 {
        self.sys.out.mat.as_ptr() as u32
    }
    #[wasm_bindgen(js_name = matLen)]
    pub fn mat_len(&self) -> u32 {
        self.sys.out.mat.len() as u32
    }
    #[wasm_bindgen(js_name = colPtr)]
    pub fn col_ptr(&self) -> u32 {
        self.sys.out.col.as_ptr() as u32
    }
    #[wasm_bindgen(js_name = colLen)]
    pub fn col_len(&self) -> u32 {
        self.sys.out.col.len() as u32
    }
    #[wasm_bindgen(js_name = kidsPtr)]
    pub fn kids_ptr(&self) -> u32 {
        self.sys.out.kids.as_ptr() as u32
    }
    #[wasm_bindgen(js_name = kidsLen)]
    pub fn kids_len(&self) -> u32 {
        self.sys.out.kids.len() as u32
    }
    #[wasm_bindgen(js_name = kidDataPtr)]
    pub fn kid_data_ptr(&self) -> u32 {
        self.sys.out.kid_data.as_ptr() as u32
    }
    #[wasm_bindgen(js_name = kidDataLen)]
    pub fn kid_data_len(&self) -> u32 {
        self.sys.out.kid_data.len() as u32
    }
    #[wasm_bindgen(js_name = finishedPtr)]
    pub fn finished_ptr(&self) -> u32 {
        self.sys.out.finished.as_ptr() as u32
    }
    #[wasm_bindgen(js_name = finishedLen)]
    pub fn finished_len(&self) -> u32 {
        self.sys.out.finished.len() as u32
    }
    #[wasm_bindgen(js_name = statsPtr)]
    pub fn stats_ptr(&self) -> u32 {
        self.sys.out.stats.as_ptr() as u32
    }
    #[wasm_bindgen(js_name = statsLen)]
    pub fn stats_len(&self) -> u32 {
        self.sys.out.stats.len() as u32
    }

    // ---- shared alpha bucket sort (JS copies n instances in, sorts, copies out) ----
    #[wasm_bindgen(js_name = sortReserve)]
    pub fn sort_reserve(&mut self, n: u32) {
        self.sys.sort_scratch_reserve(n as usize);
    }
    #[wasm_bindgen(js_name = sortMatPtr)]
    pub fn sort_mat_ptr(&self) -> u32 {
        self.sys.sort_mat.as_ptr() as u32
    }
    #[wasm_bindgen(js_name = sortMatLen)]
    pub fn sort_mat_len(&self) -> u32 {
        self.sys.sort_mat.len() as u32
    }
    #[wasm_bindgen(js_name = sortColPtr)]
    pub fn sort_col_ptr(&self) -> u32 {
        self.sys.sort_col.as_ptr() as u32
    }
    #[wasm_bindgen(js_name = sortColLen)]
    pub fn sort_col_len(&self) -> u32 {
        self.sys.sort_col.len() as u32
    }
    #[wasm_bindgen(js_name = sortRun)]
    pub fn sort_run(&mut self, n: u32, cx: f64, cy: f64, cz: f64, has_col: bool) {
        self.sys.sort_scratch_run(n as usize, [cx, cy, cz], has_col);
    }
}
