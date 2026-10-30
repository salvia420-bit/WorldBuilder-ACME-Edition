//! The event and audit protocol of the lane W kernel: the Rust half of
//! apps/holtburger-web/scene3d/rust/world.js (`WORLD_OP`, `WORLD_SEC`,
//! `WORLD_KIND`, `WORLD_TILE_STATE`). tests/world_parity.rs compares every
//! table here with the copy the fixture generator wrote from the JS, so a drift
//! on either side fails `cargo test`.
//!
//! Every value travels as an f64. A u32 field is valid when it is an integer in
//! `[0, 2^32)`; an optional one is `-1` (any negative value) when absent.

/// Protocol version (`SceneWorld.abi()`; the bridge refuses a mismatch).
pub const ABI: u32 = 1;

/// "Absent" for a u32 field (an event's `-1`).
pub const NONE: u32 = u32::MAX;

/// An id further than this past a table's end is refused (counted `badField`):
/// three's ids are dense, and a corrupt one must not allocate billions of slots.
pub const MAX_ID_GAP: u32 = 65_536;

// Event opcodes. Layout after the opcode, in f64s (`n` = a count):
/// h, kind, lbKey|-1, reg|-1
pub const OP_TRACK: u32 = 1;
/// h
pub const OP_DISPOSE: u32 = 2;
/// h, gid, start, count
pub const OP_GEOM_ADD: u32 = 3;
/// h, gid
pub const OP_GEOM_DEL: u32 = 4;
/// h, n, (gid, start, count) x n — after `optimize()`
pub const OP_GEOM_RANGES: u32 = 5;
/// h, iid, gid
pub const OP_INST_ADD: u32 = 6;
/// h, iid
pub const OP_INST_DEL: u32 = 7;
/// h, iid, m0..m15 — the f32 values three stored
pub const OP_INST_MATRIX: u32 = 8;
/// h, iid, gid — `setGeometryIdAt`
pub const OP_INST_GID: u32 = 9;
/// h, iid, visible — a raw `setVisibleAt` (diagnostic mirror only)
pub const OP_INST_VIS_RAW: u32 = 10;
/// h, maxInstanceCount — `setInstanceCount`
pub const OP_INST_COUNT: u32 = 11;
/// h, iid, active, gid, visible — the track of a non-empty object
pub const OP_INST_SNAP: u32 = 12;
/// h, gid, active, start, count — the track of a non-empty object
pub const OP_GEOM_SNAP: u32 = 13;
/// h, iid, lbKey — chunk / atlas landblock membership
pub const OP_ATTR_LB: u32 = 20;
/// kind, lbKey, visible — chunk `_setLbVisible`, atlas park / unpark
pub const OP_LB_VIS: u32 = 21;
/// h, iid, tile, lbKey|-1, cellId|-1 — a pool member, born invisible
pub const OP_POOL_ATTR: u32 = 22;
/// reg, tile, np, (h, n, ids x n) x np
pub const OP_POOL_COMMIT: u32 = 23;
/// reg, tile
pub const OP_POOL_PARK: u32 = 24;
/// reg, tile
pub const OP_POOL_ADOPT: u32 = 25;
/// reg, tile
pub const OP_POOL_CLEAR_PARKED: u32 = 26;
/// reg, tile
pub const OP_POOL_RELEASE: u32 = 27;
/// reg, lbKey
pub const OP_POOL_HIDE_LB: u32 = 28;
/// reg, lbKey
pub const OP_POOL_SHOW_LB: u32 = 29;
/// reg, tile, n, cellIds x n — `cellSetChanged`'s render set
pub const OP_POOL_CELLSET: u32 = 30;
/// reg, visible, n, cellIds x n — `setCellsVisible`
pub const OP_POOL_CELLS_VIS: u32 = 31;
/// reg, n, cellIds x n
pub const OP_POOL_RELEASE_CELLS: u32 = 32;
/// reg — `PoolRegistry.dispose()`
pub const OP_POOL_REG_RESET: u32 = 33;
/// lru, lbKey, mergedIntoParked
pub const OP_LRU_TRACK: u32 = 40;
/// lru, lbKey
pub const OP_LRU_PARK: u32 = 41;
/// lru, lbKey
pub const OP_LRU_UNPARK: u32 = 42;
/// lru, lbKey
pub const OP_LRU_EVICT: u32 = 43;
/// lru, lbKey — the stale pool copy of a resident landblock dropped
pub const OP_LRU_DROP_POOL: u32 = 44;
/// scene, lbKey
pub const OP_OBJR_HIDE: u32 = 50;
/// scene, lbKey
pub const OP_OBJR_SHOW: u32 = 51;
/// scene, lbKey
pub const OP_OBJR_FORGET: u32 = 52;
/// grid, tile, from, to, sinceMs, parkedAtMs
pub const OP_TILE_STATE: u32 = 60;
/// scene, nIn, cellIds x nIn, nOut, cellIds x nOut
pub const OP_CELL_PVS: u32 = 70;
/// seq — a recorder checkpoint (no-op)
pub const OP_MARK: u32 = 99;

/// Every opcode under its JS name.
pub const OPS: &[(&str, u32)] = &[
    ("TRACK", OP_TRACK),
    ("DISPOSE", OP_DISPOSE),
    ("GEOM_ADD", OP_GEOM_ADD),
    ("GEOM_DEL", OP_GEOM_DEL),
    ("GEOM_RANGES", OP_GEOM_RANGES),
    ("INST_ADD", OP_INST_ADD),
    ("INST_DEL", OP_INST_DEL),
    ("INST_MATRIX", OP_INST_MATRIX),
    ("INST_GID", OP_INST_GID),
    ("INST_VIS_RAW", OP_INST_VIS_RAW),
    ("INST_COUNT", OP_INST_COUNT),
    ("INST_SNAP", OP_INST_SNAP),
    ("GEOM_SNAP", OP_GEOM_SNAP),
    ("ATTR_LB", OP_ATTR_LB),
    ("LB_VIS", OP_LB_VIS),
    ("POOL_ATTR", OP_POOL_ATTR),
    ("POOL_COMMIT", OP_POOL_COMMIT),
    ("POOL_PARK", OP_POOL_PARK),
    ("POOL_ADOPT", OP_POOL_ADOPT),
    ("POOL_CLEAR_PARKED", OP_POOL_CLEAR_PARKED),
    ("POOL_RELEASE", OP_POOL_RELEASE),
    ("POOL_HIDE_LB", OP_POOL_HIDE_LB),
    ("POOL_SHOW_LB", OP_POOL_SHOW_LB),
    ("POOL_CELLSET", OP_POOL_CELLSET),
    ("POOL_CELLS_VIS", OP_POOL_CELLS_VIS),
    ("POOL_RELEASE_CELLS", OP_POOL_RELEASE_CELLS),
    ("POOL_REG_RESET", OP_POOL_REG_RESET),
    ("LRU_TRACK", OP_LRU_TRACK),
    ("LRU_PARK", OP_LRU_PARK),
    ("LRU_UNPARK", OP_LRU_UNPARK),
    ("LRU_EVICT", OP_LRU_EVICT),
    ("LRU_DROP_POOL", OP_LRU_DROP_POOL),
    ("OBJR_HIDE", OP_OBJR_HIDE),
    ("OBJR_SHOW", OP_OBJR_SHOW),
    ("OBJR_FORGET", OP_OBJR_FORGET),
    ("TILE_STATE", OP_TILE_STATE),
    ("CELL_PVS", OP_CELL_PVS),
    ("MARK", OP_MARK),
];

// Audit arena sections (each starts with its code; 0 ends the arena).
pub const SEC_END: u32 = 0;
/// nObj, (h, mode 0 full | 1 skipped (film) | 2 deferred (not this window), len,
/// (flags bit0 active | bit1 visible, gid) x len) x nObj
pub const SEC_OBJECTS: u32 = 1;
/// lru, nLive, lbKeys, nParked, lbKeys
pub const SEC_LRU: u32 = 2;
/// grid, n, (tile, state, sinceMs, parkedAtMs) x n
pub const SEC_GRID: u32 = 3;
/// scene, n, lbKeys
pub const SEC_OBJR: u32 = 4;
/// scene, n, cellIds
pub const SEC_CELLS: u32 = 5;
/// reg, nParkedTiles, tiles, nHiddenLbs, lbKeys
pub const SEC_POOLREG: u32 = 6;
/// h, n, (iid, m0..m15) x n
pub const SEC_MATRICES: u32 = 7;
/// h, n, (gid, start, count) x n
pub const SEC_RANGES: u32 = 8;
/// reg, n, (tile, h, live, nHiddenCellIds, iids) x n
pub const SEC_POOLRECS: u32 = 9;
/// n — shadow-kind draw objects in the scene the bridge never tracked
pub const SEC_UNTRACKED: u32 = 10;

/// Every section under its JS name.
pub const SECTIONS: &[(&str, u32)] = &[
    ("END", SEC_END),
    ("OBJECTS", SEC_OBJECTS),
    ("LRU", SEC_LRU),
    ("GRID", SEC_GRID),
    ("OBJR", SEC_OBJR),
    ("CELLS", SEC_CELLS),
    ("POOLREG", SEC_POOLREG),
    ("MATRICES", SEC_MATRICES),
    ("RANGES", SEC_RANGES),
    ("POOLRECS", SEC_POOLRECS),
    ("UNTRACKED", SEC_UNTRACKED),
];

// Draw-object kinds.
pub const KIND_OTHER: u32 = 0;
pub const KIND_CHUNK: u32 = 1;
pub const KIND_ATLAS: u32 = 2;
pub const KIND_POOL: u32 = 3;
pub const KIND_BUILDING: u32 = 4;

pub const KINDS: &[(&str, u32)] = &[
    ("OTHER", KIND_OTHER),
    ("CHUNK", KIND_CHUNK),
    ("ATLAS", KIND_ATLAS),
    ("POOL", KIND_POOL),
    ("BUILDING", KIND_BUILDING),
];

// residency_grid.js SLOT_STATE as numbers.
pub const TS_EMPTY: u32 = 0;
pub const TS_FETCHING: u32 = 1;
pub const TS_STAGED: u32 = 2;
pub const TS_LIVE: u32 = 3;
pub const TS_PARKED: u32 = 4;
pub const TS_QUARANTINED: u32 = 5;

pub const TILE_STATES: &[(&str, u32)] = &[
    ("EMPTY", TS_EMPTY),
    ("FETCHING", TS_FETCHING),
    ("STAGED", TS_STAGED),
    ("LIVE", TS_LIVE),
    ("PARKED", TS_PARKED),
    ("QUARANTINED", TS_QUARANTINED),
];

/// residency_grid.js `LEGAL`: may a slot go `from` → `to`?
pub fn legal_transition(from: u32, to: u32) -> bool {
    matches!(
        (from, to),
        (TS_EMPTY, TS_FETCHING)
            | (TS_EMPTY, TS_STAGED)
            | (TS_EMPTY, TS_QUARANTINED)
            | (TS_FETCHING, TS_STAGED)
            | (TS_FETCHING, TS_QUARANTINED)
            | (TS_FETCHING, TS_EMPTY)
            | (TS_STAGED, TS_LIVE)
            | (TS_STAGED, TS_EMPTY)
            | (TS_LIVE, TS_PARKED)
            | (TS_LIVE, TS_EMPTY)
            | (TS_PARKED, TS_LIVE)
            | (TS_PARKED, TS_EMPTY)
            | (TS_QUARANTINED, TS_FETCHING)
            | (TS_QUARANTINED, TS_EMPTY)
    )
}

/// `v` as a u32 when it is an integer in `[0, 2^32)` (the model's `u32()`).
/// NaN, infinities, fractions and negatives are `None`; `-0.0` is `Some(0)`.
#[inline]
pub fn u32_of(v: f64) -> Option<u32> {
    if v >= 0.0 && v < 4_294_967_296.0 && v.fract() == 0.0 { Some(v as u32) } else { None }
}

/// An optional u32 field: any negative value is [`NONE`] (the model's `optU32()`).
#[inline]
pub fn opt_u32(v: f64) -> Option<u32> {
    if v < 0.0 { Some(NONE) } else { u32_of(v) }
}

/// The length in f64s of the record starting at `ev[i]`, or `None` for an
/// unknown opcode, a malformed count or a record running past the end (the
/// model's decode-error `-1`).
pub fn record_len(ev: &[f64], i: usize) -> Option<usize> {
    let n = ev.len() as u64;
    let at = i as u64;
    if at >= n {
        return None;
    }
    let op = u32_of(ev[i])?;
    let count = |k: u64| -> Option<u64> {
        if at + k >= n {
            return None;
        }
        u32_of(ev[(at + k) as usize]).map(u64::from)
    };
    let len: u64 = match op {
        OP_DISPOSE | OP_POOL_REG_RESET | OP_MARK => 2,
        OP_GEOM_DEL | OP_INST_DEL | OP_INST_COUNT | OP_POOL_PARK | OP_POOL_ADOPT | OP_POOL_CLEAR_PARKED
        | OP_POOL_RELEASE | OP_POOL_HIDE_LB | OP_POOL_SHOW_LB | OP_LRU_PARK | OP_LRU_UNPARK | OP_LRU_EVICT
        | OP_LRU_DROP_POOL | OP_OBJR_HIDE | OP_OBJR_SHOW | OP_OBJR_FORGET => 3,
        OP_INST_ADD | OP_INST_GID | OP_INST_VIS_RAW | OP_ATTR_LB | OP_LB_VIS | OP_LRU_TRACK => 4,
        OP_TRACK | OP_GEOM_ADD => 5,
        OP_INST_SNAP | OP_GEOM_SNAP | OP_POOL_ATTR => 6,
        OP_TILE_STATE => 7,
        OP_INST_MATRIX => 19,
        OP_GEOM_RANGES => 3 + 3 * count(2)?,
        OP_POOL_CELLSET | OP_POOL_CELLS_VIS => 4 + count(3)?,
        OP_POOL_RELEASE_CELLS => 3 + count(2)?,
        OP_POOL_COMMIT => {
            let np = count(3)?;
            let mut k = at + 4;
            for _ in 0..np {
                if k + 2 > n {
                    return None;
                }
                let c = u32_of(ev[(k + 1) as usize])?;
                k += 2 + u64::from(c);
            }
            k - at
        }
        OP_CELL_PVS => {
            let a = count(2)?;
            let b = count(3 + a)?;
            4 + a + b
        }
        _ => return None,
    };
    if at + len > n {
        return None;
    }
    Some(len as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn u32_fields() {
        assert_eq!(u32_of(0.0), Some(0));
        assert_eq!(u32_of(-0.0), Some(0));
        assert_eq!(u32_of(4_294_967_295.0), Some(u32::MAX));
        assert_eq!(u32_of(4_294_967_296.0), None);
        assert_eq!(u32_of(1.5), None);
        assert_eq!(u32_of(-1.0), None);
        assert_eq!(u32_of(f64::NAN), None);
        assert_eq!(opt_u32(-1.0), Some(NONE));
        assert_eq!(opt_u32(7.0), Some(7));
        assert_eq!(opt_u32(f64::NAN), None);
    }

    #[test]
    fn record_lengths_and_truncation() {
        assert_eq!(record_len(&[OP_TRACK as f64, 1.0, 1.0, -1.0, -1.0], 0), Some(5));
        assert_eq!(record_len(&[OP_TRACK as f64, 1.0, 1.0, -1.0], 0), None, "truncated");
        assert_eq!(record_len(&[77.0, 0.0], 0), None, "unknown op");
        assert_eq!(record_len(&[1.5, 0.0], 0), None, "fractional op");
        // GEOM_RANGES with two ranges.
        let r = [OP_GEOM_RANGES as f64, 1.0, 2.0, 0.0, 0.0, 3.0, 1.0, 3.0, 3.0];
        assert_eq!(record_len(&r, 0), Some(9));
        assert_eq!(record_len(&r[..8], 0), None);
        // POOL_COMMIT: two parts of 1 and 2 ids.
        let c = [OP_POOL_COMMIT as f64, 1.0, 5.0, 2.0, 7.0, 1.0, 0.0, 8.0, 2.0, 3.0, 4.0];
        assert_eq!(record_len(&c, 0), Some(11));
        assert_eq!(record_len(&c[..10], 0), None);
        // CELL_PVS: 2 in, 1 out.
        let p = [OP_CELL_PVS as f64, 1.0, 2.0, 10.0, 11.0, 1.0, 12.0];
        assert_eq!(record_len(&p, 0), Some(7));
        assert_eq!(record_len(&p[..6], 0), None);
        // A count that is not an integer.
        assert_eq!(record_len(&[OP_POOL_RELEASE_CELLS as f64, 1.0, 0.5], 0), None);
    }

    #[test]
    fn legal_transitions_are_the_grids() {
        assert!(legal_transition(TS_EMPTY, TS_FETCHING));
        assert!(legal_transition(TS_LIVE, TS_PARKED));
        assert!(legal_transition(TS_PARKED, TS_LIVE));
        assert!(!legal_transition(TS_EMPTY, TS_LIVE));
        assert!(!legal_transition(TS_PARKED, TS_STAGED));
        assert!(!legal_transition(TS_LIVE, TS_LIVE));
        assert!(!legal_transition(9, TS_EMPTY));
    }
}
