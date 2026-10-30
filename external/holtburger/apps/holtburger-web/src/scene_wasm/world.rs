// src/scene_wasm/world.rs — lane W glue: `SceneWorld` over
// holtburger_scene::world::World (the static world's residency and visibility
// tables, shadow mode).
//
// JS side: scene3d/rust/world.js (`?rustWorld=on`). Lane notes (the event
// protocol, the audit, what is derived vs mirrored): docs/2026-10-26-rust-world.md.
//
//   const k = new SceneWorld();            // k.abi() must equal world.js WORLD_ABI
//   k.apply(Float64Array events);           // records applied, or -1 (decode error)
//   k.audit(Float64Array arena);            // this audit's mismatches, or -1 (malformed arena)
//   JSON.parse(k.report());                 // totals, last audit by category, integrity counters
//   JSON.parse(k.census());                 // table sizes (the JS model's census, key for key)
//
// Event calls only: the bridge flushes its queue at each 1 Hz audit and when it
// passes 64K values — never a call per object per frame (shadow mode has no
// per-frame call at all).

use holtburger_scene::world::{World, ABI};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Default)]
pub struct SceneWorld {
    inner: World,
}

#[wasm_bindgen]
impl SceneWorld {
    #[wasm_bindgen(constructor)]
    pub fn new() -> SceneWorld {
        SceneWorld { inner: World::new() }
    }

    /// The event / audit protocol version (scene3d/rust/world.js `WORLD_ABI`).
    pub fn abi(&self) -> u32 {
        ABI
    }

    /// Apply a batch of events (world.js `WORLD_OP` records). Returns the
    /// records applied, or -1 when a record cannot be decoded (the records
    /// before it stay applied).
    pub fn apply(&mut self, events: &[f64]) -> i32 {
        match self.inner.apply(events) {
            Ok(n) => i32::try_from(n).unwrap_or(i32::MAX),
            Err(_) => -1,
        }
    }

    /// Compare the tables with an audit arena (world.js `WORLD_SEC`). Returns
    /// this audit's mismatches, or -1 for a malformed arena.
    pub fn audit(&mut self, arena: &[f64]) -> i32 {
        match self.inner.audit(arena) {
            Some(m) => i32::try_from(m).unwrap_or(i32::MAX),
            None => -1,
        }
    }

    /// Totals, the last audit (per category, samples), the AND-form divergence
    /// and the integrity counters, as JSON.
    pub fn report(&self) -> String {
        self.inner.report_json()
    }

    /// The table census as JSON.
    pub fn census(&self) -> String {
        self.inner.census_json()
    }

    /// Mismatches over every audit so far.
    #[wasm_bindgen(getter)]
    pub fn mismatches(&self) -> f64 {
        self.inner.total_mismatches() as f64
    }

    /// Sum of the integrity counters.
    #[wasm_bindgen(getter, js_name = integrityTotal)]
    pub fn integrity_total(&self) -> f64 {
        self.inner.integrity_total() as f64
    }

    /// Forget everything.
    pub fn reset(&mut self) {
        self.inner = World::new();
    }
}
