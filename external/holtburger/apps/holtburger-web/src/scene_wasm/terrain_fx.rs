// src/scene_wasm/terrain_fx.rs — lane E glue: `SceneScatterPlanner` over
// holtburger_scene::terrain_fx (the per-frame re-scatter plan of one
// terrain_scatter.js pool: edge queue + round-robin scan + budgets).
//
// JS side: scene3d/rust/terrain_fx.js (`?rustTerrainFx=on`), driven from the
// pool's update() through `opts.scanPlanner`. Lane notes:
// docs/2026-10-26-rust-anim-terrain.md.
//
//   const p = new SceneScatterPlanner(count, grid, cellSize, radius, jitter,
//       seed, disc, scanBudget, sliceSize, edgeBudget);   // one per pool
//   p.syncAll(cellX, cellY, resolvedFlags, outFlags, gxMin, gyMin, cursor); // after rescatterAll
//   let n = p.begin(cx, cy, gxMin, gyMin);                 // per frame
//   while (n > 0) {
//     // batch: n (i, gx, gy) i32 triples at batchPtr(); JS scatters each, then
//     // writes resolvedFlags[i] | outFlags[i] << 1 into the u8 outcome buffer
//     n = p.resume(n);
//   }
//   // stats: u32 x 8 at statsPtr() (written, edgeWritten, scanned, cursor,
//   // batch, done, desync, stops)
//
// The batch / outcome / stats buffers are allocated once (fixed capacity), so
// their pointers never move; views must still be re-checked against memory
// growth (scene_core.js views do).

use holtburger_scene::terrain_fx::{PlannerConfig, STATS_LEN, ScatterPlanner};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct SceneScatterPlanner {
    p: Option<ScatterPlanner>,
}

#[wasm_bindgen]
impl SceneScatterPlanner {
    /// The pool's constants after createScatterPool's clamping. An invalid
    /// configuration yields an inert planner (`ok` false) — the bridge then
    /// leaves the pool on its JS loops.
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        count: u32,
        grid: u32,
        cell_size: f64,
        radius: f64,
        jitter: f64,
        seed: i32,
        disc: bool,
        scan_budget: u32,
        slice_size: u32,
        edge_budget: u32,
    ) -> SceneScatterPlanner {
        let cfg = PlannerConfig {
            count: count as usize,
            grid: grid as usize,
            cell_size,
            radius,
            jitter,
            seed,
            disc,
            scan_budget: scan_budget as usize,
            slice_size: slice_size as usize,
            edge_budget: edge_budget as usize,
        };
        SceneScatterPlanner { p: ScatterPlanner::new(cfg) }
    }

    #[wasm_bindgen(getter)]
    pub fn ok(&self) -> bool {
        self.p.is_some()
    }

    /// Start a frame; returns the first batch length.
    pub fn begin(&mut self, cx: f64, cy: f64, gx_min: i32, gy_min: i32) -> u32 {
        match self.p.as_mut() {
            Some(p) => p.begin(cx, cy, gx_min, gy_min) as u32,
            None => 0,
        }
    }

    /// The last batch's outcomes are in the outcome buffer: continue.
    pub fn resume(&mut self, n: u32) -> u32 {
        match self.p.as_mut() {
            Some(p) => p.resume(n as usize) as u32,
            None => 0,
        }
    }

    #[wasm_bindgen(js_name = syncAll)]
    #[allow(clippy::too_many_arguments)]
    pub fn sync_all(&mut self, cell_x: &[i32], cell_y: &[i32], resolved: &[u8], out: &[u8], gx_min: i32, gy_min: i32, cursor: u32) -> bool {
        match self.p.as_mut() {
            Some(p) => p.sync_all(cell_x, cell_y, resolved, out, gx_min, gy_min, cursor as usize),
            None => false,
        }
    }

    pub fn invalidate(&mut self) {
        if let Some(p) = self.p.as_mut() {
            p.invalidate();
        }
    }

    #[wasm_bindgen(js_name = syncResolved)]
    pub fn sync_resolved(&mut self, resolved: &[u8]) -> bool {
        match self.p.as_mut() {
            Some(p) => p.sync_resolved(resolved),
            None => false,
        }
    }

    #[wasm_bindgen(js_name = batchPtr)]
    pub fn batch_ptr(&self) -> u32 {
        self.p.as_ref().map_or(0, |p| p.batch().as_ptr() as u32)
    }
    /// Capacity of the batch buffer in i32 (3 per entry).
    #[wasm_bindgen(js_name = batchCap)]
    pub fn batch_cap(&self) -> u32 {
        self.p.as_ref().map_or(0, |p| p.batch().len() as u32)
    }
    #[wasm_bindgen(js_name = outcomePtr)]
    pub fn outcome_ptr(&self) -> u32 {
        self.p.as_ref().map_or(0, |p| p.outcome().as_ptr() as u32)
    }
    #[wasm_bindgen(js_name = outcomeCap)]
    pub fn outcome_cap(&self) -> u32 {
        self.p.as_ref().map_or(0, |p| p.outcome().len() as u32)
    }
    #[wasm_bindgen(js_name = statsPtr)]
    pub fn stats_ptr(&self) -> u32 {
        self.p.as_ref().map_or(0, |p| p.stats().as_ptr() as u32)
    }
    #[wasm_bindgen(js_name = statsLen)]
    pub fn stats_len(&self) -> u32 {
        STATS_LEN as u32
    }
    #[wasm_bindgen(getter)]
    pub fn cursor(&self) -> u32 {
        self.p.as_ref().map_or(0, |p| p.cursor() as u32)
    }
    #[wasm_bindgen(getter, js_name = queuedLines)]
    pub fn queued_lines(&self) -> u32 {
        self.p.as_ref().map_or(0, |p| p.queued_lines() as u32)
    }
}
