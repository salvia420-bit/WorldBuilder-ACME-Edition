//! Lane E — the CPU side of the terrain VFX families: the per-frame
//! re-scatter PLAN of the shared scatter pool (scene3d/terrain_scatter.js,
//! `?rustTerrainFx`). Lane notes:
//! apps/holtburger-web/docs/2026-10-26-rust-anim-terrain.md.
//!
//! # What this replaces
//!
//! Every terrain VFX family that scatters instances around the player — rock
//! pebbles and grit, sand streamers, snow spindrift, dirt haze (and grass /
//! ground fog when they opt in) — owns a `createScatterPool` pool. Its
//! `update()` decides each frame which instances to re-scatter: first the
//! slot lines a window scroll re-assigned (the EDGE queue, `edgeBudget`), then
//! a round-robin SCAN of up to `scanBudget` instances from a cursor, re-placing
//! at most `sliceSize`. The scan's per-instance TEST (`gx !== cellX[i] ||
//! gy !== cellY[i] || resolvedFlags[i] === 0 || backInRange(i)`, two
//! `wrapSlotToCell`s first) is most of the pool's CPU time: ~2,048 instances a
//! frame for the ultra pebble pool, 1070 profiles 2026-10-23 ~0.1 ms/frame.
//!
//! This kernel runs that decision — the edge queue, the scan, the budgets, the
//! cursor, and the parts of `scatterInstance` that feed later tests (the cell,
//! `outFlags`, the out-of-range `resolvedFlags`) — over flat mirrors of the
//! pool's arrays, and emits the instances to re-scatter as `(i, gx, gy)`
//! triples in EXACTLY the JS order. JS still scatters each one (oracle sample,
//! family / road / exclude gates, the consumer's `fill`, the attribute and
//! matrix writes, the upload ranges), so everything that lands in a buffer is
//! produced by the same JS as before, in the same order.
//!
//! # The one thing the kernel cannot know: an oracle outcome
//!
//! Whether a scattered instance RESOLVED (`resolvedFlags[i]`: 0 when the
//! oracle returned null — an unbaked landblock) is decided by JS. A later test
//! of that instance in the SAME frame (an edge line crossing another, the scan
//! crossing a freshly drained line) needs it. The kernel marks such an
//! instance PENDING and, when it is about to test it again, stops and hands
//! the batch so far to JS; JS scatters the batch, writes each instance's
//! `resolvedFlags | outFlags << 1` into the outcome buffer, and calls
//! [`ScatterPlanner::resume`]. A frame therefore takes 1 + (batches) calls:
//! one when nothing moved, typically 2-3 while walking.
//!
//! Exactness: integer index arithmetic, `scatterHashU32` (Math.imul =
//! wrapping_mul), and the jitter / distance arithmetic in the JS order (f64,
//! sqrt correctly rounded on both sides). No transcendental function.

use std::collections::VecDeque;

/// `resolved` value for a scattered instance whose oracle outcome JS has not
/// reported yet.
pub const PENDING: u8 = 2;

/// Layout of [`ScatterPlanner::stats`] (u32 each).
pub const STAT_WRITTEN: usize = 0;
pub const STAT_EDGE_WRITTEN: usize = 1;
pub const STAT_SCANNED: usize = 2;
pub const STAT_CURSOR: usize = 3;
pub const STAT_BATCH: usize = 4;
pub const STAT_DONE: usize = 5;
pub const STAT_DESYNC: usize = 6;
pub const STAT_STOPS: usize = 7;
pub const STATS_LEN: usize = 8;

/// terrain_scatter.js `scatterHashU32(a, b, c, seed)` (FNV-1a words + the
/// murmur3 fmix32 avalanche; `Math.imul` is a wrapping u32 multiply).
#[inline]
pub fn scatter_hash_u32(a: i32, b: i32, c: i32, seed: i32) -> u32 {
    let mut h: u32 = (seed as u32) ^ 2166136261u32;
    h = (h ^ (a as u32)).wrapping_mul(16777619);
    h = (h ^ (b as u32)).wrapping_mul(16777619);
    h = (h ^ (c as u32)).wrapping_mul(16777619);
    h ^= h >> 16;
    h = h.wrapping_mul(2246822507);
    h ^= h >> 13;
    h = h.wrapping_mul(3266489909);
    h ^= h >> 16;
    h
}

/// `scatterHash01` = `scatterHashU32(...) / 4294967296`.
#[inline]
pub fn scatter_hash01(a: i32, b: i32, c: i32, seed: i32) -> f64 {
    scatter_hash_u32(a, b, c, seed) as f64 / 4294967296.0
}

/// `wrapSlotToCell(slot, minCell, gridSize)`.
#[inline]
pub fn wrap_slot_to_cell(slot: i64, min_cell: i64, grid: i64) -> i64 {
    let g = if grid >= 1 { grid } else { 1 };
    let m = (slot - min_cell) % g;
    min_cell + if m < 0 { m + g } else { m }
}

/// The pool constants the plan depends on (createScatterPool's, after its
/// own clamping).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlannerConfig {
    pub count: usize,
    pub grid: usize,
    pub cell_size: f64,
    pub radius: f64,
    pub jitter: f64,
    pub seed: i32,
    /// `shape !== "square"`: placement rejects cells outside the disc.
    pub disc: bool,
    pub scan_budget: usize,
    pub slice_size: usize,
    pub edge_budget: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Line {
    axis: u8,
    slot: u32,
    next: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Edge,
    Scan,
    Done,
}

#[derive(Clone, Copy, Debug)]
struct Frame {
    phase: Phase,
    cx: f64,
    cy: f64,
    gx_min: i32,
    gy_min: i32,
    written: usize,
    edge_written: usize,
    scanned: usize,
    scan_i: usize,
}

enum Test {
    Pass,
    Fail,
    Unknown,
}

/// The re-scatter planner of one scatter pool.
#[derive(Debug)]
pub struct ScatterPlanner {
    cfg: PlannerConfig,
    cell_x: Vec<i32>,
    cell_y: Vec<i32>,
    resolved: Vec<u8>,
    out: Vec<u8>,
    cursor: usize,
    last_min: Option<(i32, i32)>,
    // The edge FIFO. `lines[k]` carries sequence number `front_seq + k`;
    // `by_slot[axis][slot]` holds the sequence of that slot's queued line.
    lines: VecDeque<Line>,
    front_seq: u64,
    by_slot: [Vec<Option<u64>>; 2],
    fr: Frame,
    batch: Vec<i32>,
    batch_len: usize,
    outcome: Vec<u8>,
    stats: [u32; STATS_LEN],
    desync: u32,
    stops: u32,
}

impl ScatterPlanner {
    /// None when the configuration is not a pool's (count = grid², budgets >= 1).
    pub fn new(cfg: PlannerConfig) -> Option<ScatterPlanner> {
        if cfg.grid == 0 || cfg.count != cfg.grid.checked_mul(cfg.grid)? {
            return None;
        }
        if cfg.scan_budget == 0 || cfg.slice_size == 0 || cfg.edge_budget == 0 {
            return None;
        }
        if !(cfg.cell_size > 0.0) || !cfg.radius.is_finite() || !cfg.jitter.is_finite() {
            return None;
        }
        // At most max(edge budget, slice) scatters a frame (see `scan`).
        let cap = cfg.edge_budget.max(cfg.slice_size).min(cfg.count).max(1);
        let n = cfg.count;
        Some(ScatterPlanner {
            cfg,
            // createScatterPool's "no real cell" start value.
            cell_x: vec![0x7fff_ffff; n],
            cell_y: vec![0x7fff_ffff; n],
            resolved: vec![0; n],
            out: vec![0; n],
            cursor: 0,
            last_min: None,
            lines: VecDeque::new(),
            front_seq: 0,
            by_slot: [vec![None; cfg.grid], vec![None; cfg.grid]],
            fr: Frame { phase: Phase::Done, cx: 0.0, cy: 0.0, gx_min: 0, gy_min: 0, written: 0, edge_written: 0, scanned: 0, scan_i: 0 },
            batch: vec![0; cap * 3],
            batch_len: 0,
            outcome: vec![0; cap],
            stats: [0; STATS_LEN],
            desync: 0,
            stops: 0,
        })
    }

    pub fn config(&self) -> &PlannerConfig {
        &self.cfg
    }

    /// Start a frame (update() after its teleport check and re-centre): the
    /// window min cells this frame and the pool centre. Returns the first
    /// batch's length (0 = nothing to scatter, the frame is planned).
    pub fn begin(&mut self, cx: f64, cy: f64, gx_min: i32, gy_min: i32) -> usize {
        self.fr = Frame { phase: Phase::Edge, cx, cy, gx_min, gy_min, written: 0, edge_written: 0, scanned: 0, scan_i: self.cursor };
        self.batch_len = 0;
        // Edge-first: the lines this scroll re-assigned, before the round-robin.
        if let Some((lx, ly)) = self.last_min {
            self.enqueue_scrolled(0, lx, gx_min);
            self.enqueue_scrolled(1, ly, gy_min);
        }
        self.last_min = Some((gx_min, gy_min));
        self.run();
        self.write_stats();
        self.batch_len
    }

    /// JS scattered the last batch and wrote `resolvedFlags[i] | outFlags[i]
    /// << 1` for its first `n` entries into the outcome buffer: take them, and
    /// continue the plan. Returns the next batch's length (0 = planned).
    pub fn resume(&mut self, n: usize) -> usize {
        let n = n.min(self.batch_len);
        for k in 0..n {
            let i = self.batch[k * 3] as usize;
            let o = self.outcome[k];
            let out = (o >> 1) & 1;
            if out != self.out[i] {
                self.desync += 1;
                self.out[i] = out;
            }
            self.resolved[i] = o & 1;
        }
        if n < self.batch_len {
            // A batch JS did not fully report: whatever is still pending is
            // treated as unresolved (retried), and counted.
            for k in n..self.batch_len {
                let i = self.batch[k * 3] as usize;
                if self.resolved[i] == PENDING {
                    self.resolved[i] = 0;
                    self.desync += 1;
                }
            }
        }
        self.batch_len = 0;
        if self.fr.phase != Phase::Done {
            self.run();
        }
        self.write_stats();
        self.batch_len
    }

    /// After JS's `rescatterAll` (first frame / teleport): mirror its arrays,
    /// its window and its cursor; the edge queue is empty (clearEdgeLines).
    #[allow(clippy::too_many_arguments)]
    pub fn sync_all(&mut self, cell_x: &[i32], cell_y: &[i32], resolved: &[u8], out: &[u8], gx_min: i32, gy_min: i32, cursor: usize) -> bool {
        let n = self.cfg.count;
        if cell_x.len() < n || cell_y.len() < n || resolved.len() < n || out.len() < n {
            return false;
        }
        self.cell_x.copy_from_slice(&cell_x[..n]);
        self.cell_y.copy_from_slice(&cell_y[..n]);
        for i in 0..n {
            self.resolved[i] = resolved[i] & 1;
            self.out[i] = out[i] & 1;
        }
        self.clear_lines();
        self.last_min = Some((gx_min, gy_min));
        self.cursor = if cursor < n { cursor } else { 0 };
        self.fr.phase = Phase::Done;
        self.batch_len = 0;
        self.write_stats();
        true
    }

    /// `invalidate()`: every instance unresolved.
    pub fn invalidate(&mut self) {
        for r in self.resolved.iter_mut() {
            *r = 0;
        }
    }

    /// After a JS-side resolvedFlags edit (`invalidateRegion`): mirror it.
    pub fn sync_resolved(&mut self, resolved: &[u8]) -> bool {
        if resolved.len() < self.cfg.count {
            return false;
        }
        for i in 0..self.cfg.count {
            self.resolved[i] = resolved[i] & 1;
        }
        true
    }

    fn clear_lines(&mut self) {
        self.lines.clear();
        self.front_seq = 0;
        for axis in 0..2 {
            for s in self.by_slot[axis].iter_mut() {
                *s = None;
            }
        }
    }

    fn enqueue_line(&mut self, axis: usize, slot: usize) {
        if let Some(seq) = self.by_slot[axis][slot] {
            // scrolled again: restart it
            let pos = (seq - self.front_seq) as usize;
            self.lines[pos].next = 0;
            return;
        }
        let seq = self.front_seq + self.lines.len() as u64;
        self.lines.push_back(Line { axis: axis as u8, slot: slot as u32, next: 0 });
        self.by_slot[axis][slot] = Some(seq);
    }

    /// `enqueueScrolled(axis, oldMin, newMin)`.
    fn enqueue_scrolled(&mut self, axis: usize, old_min: i32, new_min: i32) {
        let g = self.cfg.grid as i64;
        let d = new_min as i64 - old_min as i64;
        if d == 0 {
            return;
        }
        if d.abs() >= g {
            for k in 0..g {
                self.enqueue_line(axis, k as usize);
            }
            return;
        }
        // The cells that left are [oldMin, newMin) (d > 0) or
        // [newMin + g, oldMin + g) (d < 0); the slot of a cell is the cell
        // modulo the grid either way.
        let c0 = if d > 0 { old_min as i64 } else { new_min as i64 + g };
        let mut c = c0;
        while c < c0 + d.abs() {
            let m = c % g;
            self.enqueue_line(axis, (if m < 0 { m + g } else { m }) as usize);
            c += 1;
        }
    }

    /// `backInRange(i)`.
    #[inline]
    fn back_in_range(&self, i: usize) -> bool {
        if self.out[i] != 1 {
            return false;
        }
        let c = &self.cfg;
        let dx = (self.cell_x[i] as f64 + 0.5) * c.cell_size - self.fr.cx;
        let dy = (self.cell_y[i] as f64 + 0.5) * c.cell_size - self.fr.cy;
        let r = c.radius - c.cell_size;
        r > 0.0 && dx * dx + dy * dy <= r * r
    }

    /// `gx !== cellX[i] || gy !== cellY[i] || resolvedFlags[i] === 0 ||
    /// backInRange(i)`, or Unknown when it hinges on a pending outcome.
    #[inline]
    fn test(&self, i: usize, gx: i32, gy: i32) -> Test {
        if gx != self.cell_x[i] || gy != self.cell_y[i] {
            return Test::Pass;
        }
        match self.resolved[i] {
            0 => Test::Pass,
            PENDING => Test::Unknown,
            _ => {
                if self.back_in_range(i) {
                    Test::Pass
                } else {
                    Test::Fail
                }
            }
        }
    }

    /// The part of `scatterInstance(i, gx, gy)` later tests read: the cell,
    /// and the out-of-range decision (resolved = 1, out = 1); otherwise
    /// out = 0 and the oracle outcome is PENDING. Queues (i, gx, gy).
    fn scatter(&mut self, i: usize, gx: i32, gy: i32) {
        self.cell_x[i] = gx;
        self.cell_y[i] = gy;
        let c = self.cfg;
        let jx = if c.jitter > 0.0 { (scatter_hash01(gx, gy, 1, c.seed) - 0.5) * c.jitter } else { 0.0 };
        let jy = if c.jitter > 0.0 { (scatter_hash01(gx, gy, 2, c.seed) - 0.5) * c.jitter } else { 0.0 };
        let x = (gx as f64 + 0.5 + jx) * c.cell_size;
        let y = (gy as f64 + 0.5 + jy) * c.cell_size;
        let dx = x - self.fr.cx;
        let dy = y - self.fr.cy;
        let dist = (dx * dx + dy * dy).sqrt();
        if c.disc && dist > c.radius {
            self.resolved[i] = 1;
            self.out[i] = 1;
        } else {
            self.out[i] = 0;
            self.resolved[i] = PENDING;
        }
        let b = self.batch_len * 3;
        if b + 3 > self.batch.len() {
            // Never with a pool's budgets (cap = max(edge, slice)); grow anyway.
            self.batch.resize(b + 3, 0);
            self.outcome.resize(self.batch_len + 1, 0);
        }
        self.batch[b] = i as i32;
        self.batch[b + 1] = gx;
        self.batch[b + 2] = gy;
        self.batch_len += 1;
    }

    fn run(&mut self) {
        if self.fr.phase == Phase::Edge {
            if !self.drain_edges() {
                return;
            }
            self.fr.written = self.fr.edge_written;
            self.fr.phase = Phase::Scan;
        }
        if self.fr.phase == Phase::Scan {
            if !self.scan() {
                return;
            }
            self.cursor = self.fr.scan_i;
            self.fr.phase = Phase::Done;
        }
    }

    /// `drainEdgeLines(gxMin, gyMin, edgeBudget)`; false = stopped on a
    /// pending outcome (the front line keeps its position).
    fn drain_edges(&mut self) -> bool {
        let g = self.cfg.grid;
        let budget = self.cfg.edge_budget;
        while !self.lines.is_empty() && self.fr.edge_written < budget {
            let Line { axis, slot, next } = self.lines[0];
            let (axis, slot) = (axis as usize, slot as usize);
            let mut k = next as usize;
            while k < g && self.fr.edge_written < budget {
                // axis 0 = an x-scroll: slot column sx = slot, every row sy = k.
                // axis 1 = a y-scroll: slot row sy = slot, every column sx = k.
                let i = if axis == 0 { k * g + slot } else { slot * g + k };
                let gx = wrap_slot_to_cell((i % g) as i64, self.fr.gx_min as i64, g as i64) as i32;
                let gy = wrap_slot_to_cell((i / g) as i64, self.fr.gy_min as i64, g as i64) as i32;
                match self.test(i, gx, gy) {
                    Test::Pass => {
                        self.scatter(i, gx, gy);
                        self.fr.edge_written += 1;
                    }
                    Test::Fail => {}
                    Test::Unknown => {
                        self.lines[0].next = k as u32;
                        self.stops += 1;
                        return false;
                    }
                }
                k += 1;
            }
            self.lines[0].next = k as u32;
            if k >= g {
                self.lines.pop_front();
                self.front_seq += 1;
                self.by_slot[axis][slot] = None;
            }
        }
        true
    }

    /// The round-robin; false = stopped on a pending outcome.
    fn scan(&mut self) -> bool {
        let n = self.cfg.count;
        let g = self.cfg.grid;
        let mut i = self.fr.scan_i;
        while self.fr.scanned < self.cfg.scan_budget && self.fr.written < self.cfg.slice_size && self.fr.scanned < n {
            let gx = wrap_slot_to_cell((i % g) as i64, self.fr.gx_min as i64, g as i64) as i32;
            let gy = wrap_slot_to_cell((i / g) as i64, self.fr.gy_min as i64, g as i64) as i32;
            match self.test(i, gx, gy) {
                Test::Pass => {
                    self.scatter(i, gx, gy);
                    self.fr.written += 1;
                }
                Test::Fail => {}
                Test::Unknown => {
                    self.fr.scan_i = i;
                    self.stops += 1;
                    return false;
                }
            }
            self.fr.scanned += 1;
            i += 1;
            if i >= n {
                i = 0;
            }
        }
        self.fr.scan_i = i;
        true
    }

    fn write_stats(&mut self) {
        let s = &mut self.stats;
        let written = if self.fr.phase == Phase::Edge { self.fr.edge_written } else { self.fr.written };
        s[STAT_WRITTEN] = written as u32;
        s[STAT_EDGE_WRITTEN] = self.fr.edge_written as u32;
        s[STAT_SCANNED] = self.fr.scanned as u32;
        s[STAT_CURSOR] = self.cursor as u32;
        s[STAT_BATCH] = self.batch_len as u32;
        s[STAT_DONE] = (self.fr.phase == Phase::Done) as u32;
        s[STAT_DESYNC] = self.desync;
        s[STAT_STOPS] = self.stops;
    }

    /// `(i, gx, gy)` triples of the current batch (first `batch_len()`).
    pub fn batch(&self) -> &[i32] {
        &self.batch
    }
    pub fn batch_len(&self) -> usize {
        self.batch_len
    }
    /// The outcome buffer JS writes before `resume`.
    pub fn outcome(&self) -> &[u8] {
        &self.outcome
    }
    pub fn outcome_mut(&mut self) -> &mut [u8] {
        &mut self.outcome
    }
    pub fn stats(&self) -> &[u32] {
        &self.stats
    }
    pub fn cursor(&self) -> usize {
        self.cursor
    }
    pub fn done(&self) -> bool {
        self.fr.phase == Phase::Done
    }
    /// Mirrors (tests / diag).
    pub fn cells(&self) -> (&[i32], &[i32]) {
        (&self.cell_x, &self.cell_y)
    }
    pub fn resolved(&self) -> &[u8] {
        &self.resolved
    }
    pub fn out_flags(&self) -> &[u8] {
        &self.out
    }
    pub fn queued_lines(&self) -> usize {
        self.lines.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_matches_known_values() {
        // Spot values from terrain_scatter.js scatterHashU32 (node, 2026-10-26).
        assert_eq!(scatter_hash_u32(0, 0, 0, 0), 1577672556);
        assert_eq!(scatter_hash_u32(12, -7, 1, 0x520c4bed), 2650851772);
        assert_eq!(scatter_hash_u32(-123456, 98765, 19, -1), 770330033);
        assert_eq!(scatter_hash_u32(5, 6, 7, 0x520c4bed ^ 0x47524954), 265399245);
    }

    #[test]
    fn wrap_is_the_js_torus() {
        assert_eq!(wrap_slot_to_cell(3, 10, 5), 13);
        assert_eq!(wrap_slot_to_cell(0, -7, 5), -5);
        assert_eq!(wrap_slot_to_cell(4, -7, 5), -6);
    }

    fn cfg(grid: usize) -> PlannerConfig {
        PlannerConfig {
            count: grid * grid,
            grid,
            cell_size: 2.0,
            radius: grid as f64,
            jitter: 1.0,
            seed: 7,
            disc: true,
            scan_budget: grid * grid,
            slice_size: grid * grid,
            edge_budget: grid * grid,
        }
    }

    #[test]
    fn stationary_resolved_pool_plans_nothing() {
        let c = cfg(8);
        let mut p = ScatterPlanner::new(c).unwrap();
        let g = c.grid as i64;
        let (gx_min, gy_min) = (100, 200);
        let mut cx = Vec::new();
        let mut cy = Vec::new();
        for i in 0..c.count as i64 {
            cx.push(wrap_slot_to_cell(i % g, gx_min, g) as i32);
            cy.push(wrap_slot_to_cell(i / g, gy_min, g) as i32);
        }
        // Everything resolved and in range (out = 0).
        assert!(p.sync_all(&cx, &cy, &vec![1; c.count], &vec![0; c.count], gx_min as i32, gy_min as i32, 0));
        assert_eq!(p.begin(216.0, 416.0, gx_min as i32, gy_min as i32), 0);
        assert!(p.done());
        assert_eq!(p.stats()[STAT_SCANNED] as usize, c.count);
    }

    #[test]
    fn fresh_pool_scatters_everything_once() {
        let c = cfg(4);
        let mut p = ScatterPlanner::new(c).unwrap();
        // Unsynced pool: every test passes (no real cell); with scan budget =
        // count every instance is scattered once and none is re-tested.
        let n = p.begin(8.0, 8.0, 2, 2);
        assert_eq!(n, c.count);
        assert!(p.done());
        // Report what JS would: out-of-disc ones resolved + out, the rest
        // unresolved (an unbaked landblock) — the next frame retries those.
        let mut retry = 0;
        for k in 0..n {
            let i = p.batch()[k * 3] as usize;
            let o = if p.out_flags()[i] == 1 { 3 } else { 0 };
            if o == 0 {
                retry += 1;
            }
            p.outcome_mut()[k] = o;
        }
        assert!(retry > 0 && retry < c.count);
        assert_eq!(p.resume(n), 0);
        assert_eq!(p.stats()[STAT_DESYNC], 0);
        assert_eq!(p.begin(8.0, 8.0, 2, 2), retry);
    }

    #[test]
    fn scan_crossing_a_drained_line_stops_for_its_outcome() {
        let c = cfg(4);
        let g = c.grid as i64;
        let mut p = ScatterPlanner::new(c).unwrap();
        let (gx_min, gy_min) = (2i64, 2i64);
        let mut cx = Vec::new();
        let mut cy = Vec::new();
        for i in 0..c.count as i64 {
            cx.push(wrap_slot_to_cell(i % g, gx_min, g) as i32);
            cy.push(wrap_slot_to_cell(i / g, gy_min, g) as i32);
        }
        assert!(p.sync_all(&cx, &cy, &vec![1; c.count], &vec![0; c.count], 2, 2, 0));
        // One column east: the x-line of slot (2 mod 4) = 2 is drained first
        // (4 instances), then the scan reaches instance 2 of that column and
        // must learn its outcome.
        let n = p.begin(10.0, 8.0, 3, 2);
        assert!(n >= 1, "the drained column is in the first batch");
        assert!(!p.done(), "stopped on a pending re-test");
        assert_eq!(p.stats()[STAT_STOPS], 1);
        for k in 0..n {
            let i = p.batch()[k * 3] as usize;
            p.outcome_mut()[k] = 1 | (p.out_flags()[i] << 1);
        }
        let n2 = p.resume(n);
        // Everything resolved now: nothing else to scatter this frame.
        assert_eq!(n2, 0);
        assert!(p.done());
    }
}
