//! The kernel's census and report: the model's `census()` / `report()`,
//! written as JSON by hand (no dependencies). The census keys and their order
//! are the model's exactly — tests/rust_world_shadow.test.mjs compares the
//! compiled kernel's census string with the model's at every checkpoint.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use super::events::{KIND_POOL, NONE};
use super::{World, INTEGRITY_KEYS, LRU_LIVE, MISMATCH_KEYS};

/// Per-kind object census.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct KindCensus {
    pub objects: u64,
    pub slots: u64,
    pub active: u64,
    pub visible: u64,
}

/// The kernel's table census (the model's `census()`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Census {
    pub objects: u64,
    pub by_kind: BTreeMap<u32, KindCensus>,
    pub slots: u64,
    pub active: u64,
    pub visible: u64,
    pub attributed: u64,
    pub committed: u64,
    pub geometries: u64,
    pub lb_index: u64,
    pub tile_index: u64,
    pub cell_index: u64,
    pub lru_live: u64,
    pub lru_parked: u64,
    /// Tile records by state code.
    pub tiles: BTreeMap<u32, u64>,
    pub pool_regs: u64,
    pub pool_parked_tiles: u64,
    pub pool_hidden_lbs: u64,
    pub pool_records: u64,
    pub objr_hidden: u64,
    pub cells: u64,
}

fn push_str(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

impl World {
    /// The table census.
    pub fn census(&self) -> Census {
        let mut c = Census { objects: self.objects.len() as u64, ..Census::default() };
        for o in self.objects.values() {
            let b = c.by_kind.entry(o.kind).or_default();
            b.objects += 1;
            b.slots += o.slots.len() as u64;
            c.slots += o.slots.len() as u64;
            for s in &o.slots {
                if !s.active {
                    continue;
                }
                c.active += 1;
                b.active += 1;
                if s.vis {
                    c.visible += 1;
                    b.visible += 1;
                }
                if s.lb != NONE {
                    c.attributed += 1;
                }
                if o.kind == KIND_POOL && s.committed {
                    c.committed += 1;
                }
            }
            c.geometries += o.geoms.iter().filter(|g| g.active).count() as u64;
        }
        c.lb_index = self.idx.lb.len() as u64;
        c.tile_index = self.idx.tile.len() as u64;
        c.cell_index = self.idx.cell.len() as u64;
        for m in self.lrus.values() {
            for &st in m.values() {
                if st == LRU_LIVE {
                    c.lru_live += 1;
                } else {
                    c.lru_parked += 1;
                }
            }
        }
        for m in self.grids.values() {
            for r in m.values() {
                *c.tiles.entry(r.state).or_default() += 1;
            }
        }
        c.pool_regs = self.regs.len() as u64;
        for r in self.regs.values() {
            c.pool_parked_tiles += r.parked.len() as u64;
            c.pool_hidden_lbs += r.hidden_lbs.len() as u64;
            c.pool_records += r.recs.len() as u64;
        }
        c.objr_hidden = self.objr.values().map(|s| s.len() as u64).sum();
        c.cells = self.cells.values().map(|s| s.len() as u64).sum();
        c
    }

    /// The census as the model's JSON (same keys, same order).
    pub fn census_json(&self) -> String {
        let c = self.census();
        let mut out = String::with_capacity(512);
        let _ = write!(out, "{{\"objects\":{},\"byKind\":{{", c.objects);
        for (n, (k, b)) in c.by_kind.iter().enumerate() {
            if n > 0 {
                out.push(',');
            }
            let _ = write!(out, "\"{k}\":{{\"objects\":{},\"slots\":{},\"active\":{},\"visible\":{}}}", b.objects, b.slots, b.active, b.visible);
        }
        let _ = write!(
            out,
            "}},\"slots\":{},\"active\":{},\"visible\":{},\"attributed\":{},\"committed\":{},\"geometries\":{},\"lbIndex\":{},\"tileIndex\":{},\"cellIndex\":{},\"lru\":{{\"live\":{},\"parked\":{}}},\"tiles\":{{",
            c.slots, c.active, c.visible, c.attributed, c.committed, c.geometries, c.lb_index, c.tile_index, c.cell_index, c.lru_live, c.lru_parked
        );
        for (n, (state, count)) in c.tiles.iter().enumerate() {
            if n > 0 {
                out.push(',');
            }
            let _ = write!(out, "\"{state}\":{count}");
        }
        let _ = write!(
            out,
            "}},\"pools\":{{\"regs\":{},\"parkedTiles\":{},\"hiddenLbs\":{},\"records\":{}}},\"objrHidden\":{},\"cells\":{}}}",
            c.pool_regs, c.pool_parked_tiles, c.pool_hidden_lbs, c.pool_records, c.objr_hidden, c.cells
        );
        out
    }

    /// The model's `report()`: totals, the last audit (per category, samples),
    /// the AND-form divergence and the integrity counters.
    pub fn report_json(&self) -> String {
        let t = &self.totals;
        let l = &self.last;
        let mut out = String::with_capacity(1024);
        let _ = write!(
            out,
            "{{\"abi\":{},\"events\":{},\"batches\":{},\"audits\":{},\"mismatches\":{},\"last\":{{\"mismatches\":{},\"cat\":{{",
            super::ABI,
            t.events,
            t.batches,
            t.audits,
            t.mismatches,
            l.mismatches
        );
        for (n, (k, v)) in MISMATCH_KEYS.iter().zip(l.cat.iter()).enumerate() {
            if n > 0 {
                out.push(',');
            }
            let _ = write!(out, "\"{k}\":{v}");
        }
        let _ = write!(out, "}},\"skipped\":{},\"andDivergence\":{},\"samples\":[", l.skipped, l.and_divergence);
        for (n, s) in l.samples.iter().enumerate() {
            if n > 0 {
                out.push(',');
            }
            push_str(&mut out, s);
        }
        let _ = write!(out, "]}},\"andDivergence\":{},\"integrity\":{{", l.and_divergence);
        for (n, (k, v)) in INTEGRITY_KEYS.iter().zip(self.integrity.iter()).enumerate() {
            if n > 0 {
                out.push(',');
            }
            let _ = write!(out, "\"{k}\":{v}");
        }
        let _ = write!(out, "}},\"integrityTotal\":{}}}", self.integrity_total());
        out
    }
}
