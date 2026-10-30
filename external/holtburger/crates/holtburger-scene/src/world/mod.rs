//! Lane W — the static world's residency and visibility tables, in Rust
//! (stage 2 of docs/2026-10-26-rust-scene-core.md; design R2:
//! apps/holtburger-web/docs/2026-10-26-rust-residency-design.md; lane notes:
//! apps/holtburger-web/docs/2026-10-26-rust-world.md).
//!
//! # Shadow mode (S2)
//!
//! [`World`] mirrors what the JS static world holds and DERIVES what it would
//! decide, from the events the producers post (scene3d/rust/world.js):
//!
//! - **Draw objects** ([`DrawObject`]): every chunk bucket, atlas bucket, pool
//!   and building batch three.js draws, slot for slot (active, geometry id,
//!   the f32 matrix three stored), with three r184's id allocation predicted
//!   exactly and every unpredicted id counted.
//! - **Attribution**: which landblock / tile / cell owns each instance, indexed
//!   so a residency event reaches exactly the instances the JS reaches.
//! - **Residency**: the legacy LRU's per-landblock LIVE / PARKED state, the
//!   slot grid's tile states (with the `LEGAL` transition table checked), the
//!   pool registry's parked tiles, hidden landblocks and per-(tile, pool)
//!   records, the `?objRadius` hidden set and the cell PVS render set.
//! - **Visibility**: per instance, re-derived from those events with the JS
//!   rules (the chunk / atlas per-landblock seams; the pool registry's commit,
//!   park, adopt, landblock-hide and cell rules). The raw `setVisibleAt` stream
//!   is kept only as a diagnostic mirror.
//!
//! [`World::audit`] compares all of it with an arena the bridge builds from
//! three's `_instanceInfo` / matrices / geometry ranges and the JS residency,
//! and counts every disagreement by category ([`MISMATCH_KEYS`]); stream
//! plumbing errors are counted separately ([`INTEGRITY_KEYS`]). Both must stay
//! 0. The R2 "visible = no owner bit set" form is computed next to the exact
//! one as a diagnostic (`andDivergence`).
//!
//! The JS reference model of this module is
//! apps/holtburger-web/tools/rust_parity/gen_world_model.mjs: same tables,
//! same rules, same categories. tests/world_parity.rs replays the fixtures the
//! generator recorded through the real producers.
//!
//! Pure: no I/O, no clocks (times arrive inside events), no global state.

pub mod events;
pub mod objects;

mod apply;
mod audit;
mod report;

use std::collections::{BTreeMap, BTreeSet};

pub use events::{ABI, MAX_ID_GAP, NONE};
pub use objects::{DrawObject, Geom, Slot};
pub use report::{Census, KindCensus};

/// Integrity counters: the event stream's own consistency. Must stay 0.
pub const INTEGRITY_KEYS: [&str; 21] = [
    "unknownHandle",
    "badField",
    "retrack",
    "slotDesync",
    "addOverLive",
    "addBadGid",
    "delDead",
    "deadWrite",
    "gidDesync",
    "geomDelDead",
    "cascadeMiss",
    "rangeDead",
    "commitDead",
    "trackMergeDesync",
    "trackWhileParked",
    "parkDesync",
    "unparkDesync",
    "evictUnknown",
    "tileDesync",
    "illegalTransition",
    "reattr",
];

/// Audit mismatch categories. Must stay 0. Most compare the kernel with the
/// JS; `untracked` and `poolHideOrphan` count a JS-side fact the arena carries
/// (see [`World::audit`]: `poolHideOrphan` is the cross-check of the pool
/// registry's sticky landblock hides against the `?objRadius` sets, 2026-10-29).
pub const MISMATCH_KEYS: [&str; 19] = [
    "unknownObject",
    "missingObject",
    "slotsLen",
    "active",
    "gid",
    "vis",
    "raw",
    "lru",
    "tileState",
    "tileTime",
    "objr",
    "cells",
    "poolReg",
    "poolRec",
    "poolHidden",
    "matrix",
    "ranges",
    "untracked",
    "poolHideOrphan",
];

/// Indices into [`World::integrity`] (the order of [`INTEGRITY_KEYS`]).
pub(crate) mod ik {
    pub const UNKNOWN_HANDLE: usize = 0;
    pub const BAD_FIELD: usize = 1;
    pub const RETRACK: usize = 2;
    pub const SLOT_DESYNC: usize = 3;
    pub const ADD_OVER_LIVE: usize = 4;
    pub const ADD_BAD_GID: usize = 5;
    pub const DEL_DEAD: usize = 6;
    pub const DEAD_WRITE: usize = 7;
    pub const GID_DESYNC: usize = 8;
    pub const GEOM_DEL_DEAD: usize = 9;
    pub const CASCADE_MISS: usize = 10;
    pub const RANGE_DEAD: usize = 11;
    pub const COMMIT_DEAD: usize = 12;
    pub const TRACK_MERGE_DESYNC: usize = 13;
    pub const TRACK_WHILE_PARKED: usize = 14;
    pub const PARK_DESYNC: usize = 15;
    pub const UNPARK_DESYNC: usize = 16;
    pub const EVICT_UNKNOWN: usize = 17;
    pub const TILE_DESYNC: usize = 18;
    pub const ILLEGAL_TRANSITION: usize = 19;
    pub const REATTR: usize = 20;
}

/// Indices into [`LastAudit::cat`] (the order of [`MISMATCH_KEYS`]).
pub(crate) mod mk {
    pub const UNKNOWN_OBJECT: usize = 0;
    pub const MISSING_OBJECT: usize = 1;
    pub const SLOTS_LEN: usize = 2;
    pub const ACTIVE: usize = 3;
    pub const GID: usize = 4;
    pub const VIS: usize = 5;
    pub const RAW: usize = 6;
    pub const LRU: usize = 7;
    pub const TILE_STATE: usize = 8;
    pub const TILE_TIME: usize = 9;
    pub const OBJR: usize = 10;
    pub const CELLS: usize = 11;
    pub const POOL_REG: usize = 12;
    pub const POOL_REC: usize = 13;
    pub const POOL_HIDDEN: usize = 14;
    pub const MATRIX: usize = 15;
    pub const RANGES: usize = 16;
    pub const UNTRACKED: usize = 17;
    pub const POOL_HIDE_ORPHAN: usize = 18;
}

/// The legacy LRU's per-landblock state.
pub const LRU_LIVE: u8 = 1;
pub const LRU_PARKED: u8 = 2;

/// One slot-grid record (`SlotGrid.records`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TileRec {
    pub state: u32,
    pub since: f64,
    pub parked: f64,
}

/// One pool registry's residency state.
#[derive(Clone, Debug, Default)]
pub struct PoolReg {
    /// `_parkedTiles`.
    pub parked: BTreeSet<u32>,
    /// `_hiddenLbs` (the sticky `?objRadius` hides).
    pub hidden_lbs: BTreeSet<u32>,
    /// `tiles[tile][poolKey].live`, keyed (tile, pool handle).
    pub recs: BTreeMap<(u32, u32), bool>,
}

/// The attribution indexes: landblock / tile / cell → (handle, slot).
#[derive(Clone, Debug, Default)]
pub struct Indexes {
    pub lb: BTreeMap<u32, BTreeSet<(u32, u32)>>,
    pub tile: BTreeMap<u32, BTreeSet<(u32, u32)>>,
    pub cell: BTreeMap<u32, BTreeSet<(u32, u32)>>,
}

fn index_add(map: &mut BTreeMap<u32, BTreeSet<(u32, u32)>>, key: u32, v: (u32, u32)) {
    map.entry(key).or_default().insert(v);
}

fn index_del(map: &mut BTreeMap<u32, BTreeSet<(u32, u32)>>, key: u32, v: (u32, u32)) {
    let emptied = match map.get_mut(&key) {
        Some(set) => {
            set.remove(&v);
            set.is_empty()
        }
        None => false,
    };
    if emptied {
        map.remove(&key);
    }
}

impl Indexes {
    /// Drop slot `(h, iid)` from every index its attribution put it in.
    pub(crate) fn deindex(&mut self, h: u32, iid: u32, s: &Slot) {
        if s.lb != NONE {
            index_del(&mut self.lb, s.lb, (h, iid));
        }
        if s.tile != NONE {
            index_del(&mut self.tile, s.tile, (h, iid));
        }
        if s.cell != NONE {
            index_del(&mut self.cell, s.cell, (h, iid));
        }
    }

    pub(crate) fn add_lb(&mut self, lb: u32, h: u32, iid: u32) {
        index_add(&mut self.lb, lb, (h, iid));
    }

    pub(crate) fn del_lb(&mut self, lb: u32, h: u32, iid: u32) {
        index_del(&mut self.lb, lb, (h, iid));
    }

    pub(crate) fn add_tile(&mut self, tile: u32, h: u32, iid: u32) {
        index_add(&mut self.tile, tile, (h, iid));
    }

    pub(crate) fn add_cell(&mut self, cell: u32, h: u32, iid: u32) {
        index_add(&mut self.cell, cell, (h, iid));
    }
}

/// Running totals.
#[derive(Clone, Debug, Default)]
pub struct Totals {
    pub events: u64,
    pub batches: u64,
    pub audits: u64,
    pub mismatches: u64,
    pub pool_release_cells: u64,
    pub marks: u64,
}

/// The last audit's result.
#[derive(Clone, Debug, Default)]
pub struct LastAudit {
    pub mismatches: u64,
    /// Per category, in [`MISMATCH_KEYS`] order.
    pub cat: [u64; 19],
    /// Objects the arena marked skipped (a film take holds them).
    pub skipped: u64,
    /// Instances where the R2 AND form disagrees with the exact model (diagnostic).
    pub and_divergence: u64,
    /// Up to 16 human-readable mismatch descriptions.
    pub samples: Vec<String>,
}

/// The lane W kernel (see the module docs).
#[derive(Clone, Debug, Default)]
pub struct World {
    pub(crate) objects: BTreeMap<u32, DrawObject>,
    pub(crate) idx: Indexes,
    pub(crate) regs: BTreeMap<u32, PoolReg>,
    pub(crate) lrus: BTreeMap<u32, BTreeMap<u32, u8>>,
    pub(crate) grids: BTreeMap<u32, BTreeMap<u32, TileRec>>,
    pub(crate) objr: BTreeMap<u32, BTreeSet<u32>>,
    pub(crate) cells: BTreeMap<u32, BTreeSet<u32>>,
    pub(crate) integrity: [u64; 21],
    pub(crate) totals: Totals,
    pub(crate) last: LastAudit,
}

impl World {
    pub fn new() -> World {
        World::default()
    }

    /// Apply a batch of events in order. `Ok(records applied)`, or
    /// `Err(offset)` at the first record that cannot be decoded (an unknown
    /// opcode, a malformed count, a record running past the end); the records
    /// before it stay applied, as in the JS model.
    pub fn apply(&mut self, ev: &[f64]) -> Result<usize, usize> {
        let n = ev.len();
        let mut i = 0usize;
        let mut applied = 0usize;
        while i < n {
            let Some(len) = events::record_len(ev, i) else {
                return Err(i);
            };
            let op = ev[i] as u32; // record_len validated it
            self.apply1(op, &ev[i..i + len]);
            i += len;
            applied += 1;
        }
        self.totals.events += applied as u64;
        self.totals.batches += 1;
        Ok(applied)
    }

    /// The integrity counters, in [`INTEGRITY_KEYS`] order.
    pub fn integrity(&self) -> &[u64; 21] {
        &self.integrity
    }

    /// Sum of the integrity counters (must stay 0).
    pub fn integrity_total(&self) -> u64 {
        self.integrity.iter().sum()
    }

    /// The last audit's result.
    pub fn last_audit(&self) -> &LastAudit {
        &self.last
    }

    /// Mismatches over every audit so far (must stay 0).
    pub fn total_mismatches(&self) -> u64 {
        self.totals.mismatches
    }

    /// Running totals.
    pub fn totals(&self) -> &Totals {
        &self.totals
    }

    /// The tracked draw object `h`.
    pub fn object(&self, h: u32) -> Option<&DrawObject> {
        self.objects.get(&h)
    }

    /// Every tracked draw object, by handle.
    pub fn objects(&self) -> impl Iterator<Item = (&u32, &DrawObject)> {
        self.objects.iter()
    }

    /// Is `lb` parked in any LRU the kernel knows?
    pub fn lru_parked(&self, lb: u32) -> bool {
        self.lrus.values().any(|m| m.get(&lb) == Some(&LRU_PARKED))
    }

    /// Does any scene's `?objRadius` hide `lb`?
    pub fn objr_hidden(&self, lb: u32) -> bool {
        self.objr.values().any(|s| s.contains(&lb))
    }

    pub(crate) fn lb_hidden_in(reg: &PoolReg, lb: u32) -> bool {
        lb != NONE && reg.hidden_lbs.contains(&lb)
    }

    fn dispose_object(&mut self, h: u32) {
        let Some(o) = self.objects.remove(&h) else {
            return;
        };
        for (iid, s) in o.slots.iter().enumerate() {
            if s.active {
                self.idx.deindex(h, iid as u32, s);
            }
        }
        if o.reg != NONE {
            if let Some(r) = self.regs.get_mut(&o.reg) {
                r.recs.retain(|&(_, rh), _| rh != h);
            }
        }
    }
}

/// `pool_registry.js` `tileKeyOfLbKey`.
pub fn tile_key_of_lb_key(lb: u32) -> u32 {
    let x = (lb >> 24) & 0xff;
    let y = (lb >> 16) & 0xff;
    (((x >> 1) & 0xff) << 8) | ((y >> 1) & 0xff)
}

#[cfg(test)]
mod tests;
