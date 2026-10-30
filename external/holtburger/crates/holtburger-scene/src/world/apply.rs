//! Event application: the rules of tools/rust_parity/gen_world_model.mjs
//! `_apply1`, case for case. `e` is one decoded record (`e[0]` the opcode).

use std::collections::BTreeSet;

use super::events::*;
use super::objects::{DrawObject, Geom, Slot};
use super::{ik, tile_key_of_lb_key, World, LRU_LIVE, LRU_PARKED, TileRec};

impl World {
    pub(crate) fn apply1(&mut self, op: u32, e: &[f64]) {
        match op {
            OP_TRACK => {
                let (Some(h), Some(kind), Some(lb), Some(reg)) = (u32_of(e[1]), u32_of(e[2]), opt_u32(e[3]), opt_u32(e[4])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                if self.objects.contains_key(&h) {
                    self.integrity[ik::RETRACK] += 1;
                    self.dispose_object(h);
                }
                self.objects.insert(h, DrawObject::new(kind, lb, reg));
            }
            OP_DISPOSE => {
                let Some(h) = u32_of(e[1]) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                if !self.objects.contains_key(&h) {
                    self.integrity[ik::UNKNOWN_HANDLE] += 1;
                    return;
                }
                self.dispose_object(h);
            }
            OP_GEOM_ADD | OP_GEOM_SNAP => {
                let (Some(h), Some(gid)) = (u32_of(e[1]), u32_of(e[2])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let Some(o) = self.objects.get_mut(&h) else {
                    self.integrity[ik::UNKNOWN_HANDLE] += 1;
                    return;
                };
                if u64::from(gid) > o.geoms.len() as u64 + u64::from(MAX_ID_GAP) {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                }
                let g = if op == OP_GEOM_ADD {
                    if gid != o.next_geometry_id() {
                        self.integrity[ik::GID_DESYNC] += 1;
                    }
                    Geom { active: true, start: e[3], count: e[4] }
                } else {
                    Geom { active: e[3] != 0.0, start: e[4], count: e[5] }
                };
                o.set_geom(gid, g);
                if g.active {
                    o.free_geoms.remove(&gid);
                } else {
                    o.free_geoms.insert(gid);
                }
            }
            OP_GEOM_DEL => {
                let (Some(h), Some(gid)) = (u32_of(e[1]), u32_of(e[2])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let Some(o) = self.objects.get_mut(&h) else {
                    self.integrity[ik::UNKNOWN_HANDLE] += 1;
                    return;
                };
                if !o.geoms.get(gid as usize).is_some_and(|g| g.active) {
                    self.integrity[ik::GEOM_DEL_DEAD] += 1;
                    return;
                }
                // three deletes every active instance of the geometry BEFORE this
                // record (they arrive as INST_DELs); one still here was missed.
                for (s, x) in o.slots.iter_mut().enumerate() {
                    if x.active && x.gid == gid {
                        self.integrity[ik::CASCADE_MISS] += 1;
                        self.idx.deindex(h, s as u32, x);
                        x.active = false;
                        o.free.insert(s as u32);
                    }
                }
                o.geoms[gid as usize].active = false;
                o.free_geoms.insert(gid);
            }
            OP_GEOM_RANGES => {
                let (Some(h), Some(c)) = (u32_of(e[1]), u32_of(e[2])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let Some(o) = self.objects.get_mut(&h) else {
                    self.integrity[ik::UNKNOWN_HANDLE] += 1;
                    return;
                };
                for k in 0..c as usize {
                    let g = match u32_of(e[3 + 3 * k]) {
                        Some(gid) => o.geoms.get_mut(gid as usize),
                        None => None,
                    };
                    match g {
                        Some(g) if g.active => {
                            g.start = e[4 + 3 * k];
                            g.count = e[5 + 3 * k];
                        }
                        _ => self.integrity[ik::RANGE_DEAD] += 1,
                    }
                }
            }
            OP_INST_ADD => {
                let (Some(h), Some(iid), Some(gid)) = (u32_of(e[1]), u32_of(e[2]), u32_of(e[3])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let Some(o) = self.objects.get_mut(&h) else {
                    self.integrity[ik::UNKNOWN_HANDLE] += 1;
                    return;
                };
                if u64::from(iid) > o.slots.len() as u64 + u64::from(MAX_ID_GAP) {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                }
                if iid != o.next_instance_id() {
                    self.integrity[ik::SLOT_DESYNC] += 1;
                }
                if let Some(old) = o.slots.get(iid as usize) {
                    if old.active {
                        self.integrity[ik::ADD_OVER_LIVE] += 1;
                        self.idx.deindex(h, iid, old);
                    }
                }
                if !o.geoms.get(gid as usize).is_some_and(|g| g.active) {
                    self.integrity[ik::ADD_BAD_GID] += 1;
                }
                o.set_slot(iid, Slot::fresh(gid));
                o.free.remove(&iid);
            }
            OP_INST_SNAP => {
                let (Some(h), Some(iid), Some(gid)) = (u32_of(e[1]), u32_of(e[2]), u32_of(e[4])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let Some(o) = self.objects.get_mut(&h) else {
                    self.integrity[ik::UNKNOWN_HANDLE] += 1;
                    return;
                };
                if u64::from(iid) > o.slots.len() as u64 + u64::from(MAX_ID_GAP) {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                }
                let active = e[3] != 0.0;
                let vis = e[5] != 0.0;
                if let Some(old) = o.slots.get(iid as usize) {
                    if old.active {
                        self.idx.deindex(h, iid, old);
                    }
                }
                let mut s = Slot::fresh(gid);
                s.active = active;
                s.vis = vis;
                s.raw = vis;
                o.set_slot(iid, s);
                if active {
                    o.free.remove(&iid);
                } else {
                    o.free.insert(iid);
                }
            }
            OP_INST_DEL => {
                let (Some(h), Some(iid)) = (u32_of(e[1]), u32_of(e[2])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let Some(o) = self.objects.get_mut(&h) else {
                    self.integrity[ik::UNKNOWN_HANDLE] += 1;
                    return;
                };
                match o.slots.get_mut(iid as usize) {
                    Some(s) if s.active => {
                        self.idx.deindex(h, iid, s);
                        s.active = false;
                        o.free.insert(iid);
                    }
                    _ => self.integrity[ik::DEL_DEAD] += 1,
                }
            }
            OP_INST_MATRIX => {
                let (Some(h), Some(iid)) = (u32_of(e[1]), u32_of(e[2])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let Some(o) = self.objects.get_mut(&h) else {
                    self.integrity[ik::UNKNOWN_HANDLE] += 1;
                    return;
                };
                match o.active_slot_mut(iid) {
                    // A Float32Array store: round to nearest, ties to even (`as f32`).
                    Some(s) => {
                        for k in 0..16 {
                            s.m[k] = e[3 + k] as f32;
                        }
                    }
                    None => self.integrity[ik::DEAD_WRITE] += 1,
                }
            }
            OP_INST_GID => {
                let (Some(h), Some(iid), Some(gid)) = (u32_of(e[1]), u32_of(e[2]), u32_of(e[3])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let Some(o) = self.objects.get_mut(&h) else {
                    self.integrity[ik::UNKNOWN_HANDLE] += 1;
                    return;
                };
                match o.active_slot_mut(iid) {
                    Some(s) => s.gid = gid,
                    None => self.integrity[ik::DEAD_WRITE] += 1,
                }
            }
            OP_INST_VIS_RAW => {
                let (Some(h), Some(iid)) = (u32_of(e[1]), u32_of(e[2])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let Some(o) = self.objects.get_mut(&h) else {
                    self.integrity[ik::UNKNOWN_HANDLE] += 1;
                    return;
                };
                match o.active_slot_mut(iid) {
                    Some(s) => s.raw = e[3] != 0.0,
                    None => self.integrity[ik::DEAD_WRITE] += 1,
                }
            }
            OP_INST_COUNT => {
                let Some(h) = u32_of(e[1]) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let Some(o) = self.objects.get_mut(&h) else {
                    self.integrity[ik::UNKNOWN_HANDLE] += 1;
                    return;
                };
                o.pop_trailing_free();
            }
            OP_ATTR_LB => {
                let (Some(h), Some(iid), Some(lb)) = (u32_of(e[1]), u32_of(e[2]), u32_of(e[3])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let Some(o) = self.objects.get_mut(&h) else {
                    self.integrity[ik::UNKNOWN_HANDLE] += 1;
                    return;
                };
                let Some(s) = o.active_slot_mut(iid) else {
                    self.integrity[ik::DEAD_WRITE] += 1;
                    return;
                };
                if s.lb != NONE && s.lb != lb {
                    self.integrity[ik::REATTR] += 1;
                    self.idx.del_lb(s.lb, h, iid);
                }
                s.lb = lb;
                self.idx.add_lb(lb, h, iid);
            }
            OP_LB_VIS => {
                let (Some(kind), Some(lb)) = (u32_of(e[1]), u32_of(e[2])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let v = e[3] != 0.0;
                let Some(keys) = self.idx.lb.get(&lb) else {
                    return;
                };
                for &(h, iid) in keys {
                    let Some(o) = self.objects.get_mut(&h) else {
                        continue;
                    };
                    if o.kind != kind {
                        continue;
                    }
                    if let Some(s) = o.active_slot_mut(iid) {
                        s.vis = v;
                    }
                }
            }
            OP_POOL_ATTR => {
                let (Some(h), Some(iid), Some(tile), Some(lb), Some(cell)) =
                    (u32_of(e[1]), u32_of(e[2]), u32_of(e[3]), opt_u32(e[4]), opt_u32(e[5]))
                else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let Some(o) = self.objects.get_mut(&h) else {
                    self.integrity[ik::UNKNOWN_HANDLE] += 1;
                    return;
                };
                let Some(s) = o.active_slot_mut(iid) else {
                    self.integrity[ik::DEAD_WRITE] += 1;
                    return;
                };
                self.idx.deindex(h, iid, s);
                s.tile = tile;
                s.lb = lb;
                s.cell = cell;
                s.committed = false;
                s.vis = false;
                s.hidden_cell = false;
                self.idx.add_tile(tile, h, iid);
                if lb != NONE {
                    self.idx.add_lb(lb, h, iid);
                }
                if cell != NONE {
                    self.idx.add_cell(cell, h, iid);
                }
            }
            OP_POOL_COMMIT => {
                let (Some(reg), Some(tile), Some(np)) = (u32_of(e[1]), u32_of(e[2]), u32_of(e[3])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let r = self.regs.entry(reg).or_default();
                let live = !r.parked.contains(&tile);
                let mut k = 4usize;
                for _ in 0..np {
                    let hv = u32_of(e[k]);
                    let c = u32_of(e[k + 1]).unwrap_or(0) as usize; // validated by record_len
                    if let Some(h) = hv {
                        match self.objects.get_mut(&h) {
                            None => self.integrity[ik::UNKNOWN_HANDLE] += 1,
                            Some(o) => {
                                r.recs.insert((tile, h), live);
                                for q in 0..c {
                                    let s = match u32_of(e[k + 2 + q]) {
                                        Some(iid) => o.active_slot_mut(iid),
                                        None => None,
                                    };
                                    let Some(s) = s else {
                                        self.integrity[ik::COMMIT_DEAD] += 1;
                                        continue;
                                    };
                                    s.committed = true;
                                    if live && !World::lb_hidden_in(r, s.lb) {
                                        s.vis = true;
                                    }
                                }
                            }
                        }
                    }
                    k += 2 + c;
                }
            }
            OP_POOL_PARK => {
                let (Some(reg), Some(tile)) = (u32_of(e[1]), u32_of(e[2])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let r = self.regs.entry(reg).or_default();
                r.parked.insert(tile);
                for (&(_, h), live) in r.recs.range_mut((tile, 0)..=(tile, u32::MAX)) {
                    if !*live {
                        continue;
                    }
                    if let (Some(keys), Some(o)) = (self.idx.tile.get(&tile), self.objects.get_mut(&h)) {
                        for &(_, iid) in keys.range((h, 0)..=(h, u32::MAX)) {
                            if let Some(s) = o.active_slot_mut(iid) {
                                if s.committed {
                                    s.vis = false;
                                }
                            }
                        }
                    }
                    *live = false;
                }
            }
            OP_POOL_ADOPT => {
                let (Some(reg), Some(tile)) = (u32_of(e[1]), u32_of(e[2])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let r = self.regs.entry(reg).or_default();
                r.parked.remove(&tile);
                let hidden = &r.hidden_lbs;
                for (&(_, h), live) in r.recs.range_mut((tile, 0)..=(tile, u32::MAX)) {
                    if *live {
                        continue;
                    }
                    if let (Some(keys), Some(o)) = (self.idx.tile.get(&tile), self.objects.get_mut(&h)) {
                        for &(_, iid) in keys.range((h, 0)..=(h, u32::MAX)) {
                            if let Some(s) = o.active_slot_mut(iid) {
                                if !s.committed || s.hidden_cell {
                                    continue;
                                }
                                if s.lb != NONE && hidden.contains(&s.lb) {
                                    continue;
                                }
                                s.vis = true;
                            }
                        }
                    }
                    *live = true;
                }
            }
            OP_POOL_CLEAR_PARKED => {
                let (Some(reg), Some(tile)) = (u32_of(e[1]), u32_of(e[2])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                self.regs.entry(reg).or_default().parked.remove(&tile);
            }
            OP_POOL_RELEASE => {
                let (Some(reg), Some(tile)) = (u32_of(e[1]), u32_of(e[2])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let r = self.regs.entry(reg).or_default();
                r.parked.remove(&tile);
                r.recs.retain(|&(t, _), _| t != tile);
            }
            OP_POOL_HIDE_LB => {
                let (Some(reg), Some(lb)) = (u32_of(e[1]), u32_of(e[2])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let r = self.regs.entry(reg).or_default();
                if !r.hidden_lbs.insert(lb) {
                    return;
                }
                let tile = tile_key_of_lb_key(lb);
                let Some(keys) = self.idx.lb.get(&lb) else {
                    return;
                };
                for &(h, iid) in keys {
                    let Some(o) = self.objects.get_mut(&h) else {
                        continue;
                    };
                    if o.kind != KIND_POOL || o.reg != reg {
                        continue;
                    }
                    if let Some(s) = o.active_slot_mut(iid) {
                        if s.committed && s.tile == tile {
                            s.vis = false;
                        }
                    }
                }
            }
            OP_POOL_SHOW_LB => {
                let (Some(reg), Some(lb)) = (u32_of(e[1]), u32_of(e[2])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let r = self.regs.entry(reg).or_default();
                if !r.hidden_lbs.remove(&lb) {
                    return;
                }
                let tile = tile_key_of_lb_key(lb);
                let Some(keys) = self.idx.lb.get(&lb) else {
                    return;
                };
                for &(h, iid) in keys {
                    let Some(o) = self.objects.get_mut(&h) else {
                        continue;
                    };
                    if o.kind != KIND_POOL || o.reg != reg {
                        continue;
                    }
                    let Some(s) = o.active_slot_mut(iid) else {
                        continue;
                    };
                    if !s.committed || s.tile != tile {
                        continue;
                    }
                    if r.recs.get(&(s.tile, h)) != Some(&true) {
                        continue;
                    }
                    if s.hidden_cell {
                        continue;
                    }
                    s.vis = true;
                }
            }
            OP_POOL_CELLSET => {
                let (Some(reg), Some(tile), Some(c)) = (u32_of(e[1]), u32_of(e[2]), u32_of(e[3])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let want: BTreeSet<u32> = (0..c as usize).filter_map(|q| u32_of(e[4 + q])).collect();
                let r = self.regs.entry(reg).or_default();
                let hidden = &r.hidden_lbs;
                for (&(_, h), live) in r.recs.range((tile, 0)..=(tile, u32::MAX)) {
                    let live = *live;
                    let (Some(keys), Some(o)) = (self.idx.tile.get(&tile), self.objects.get_mut(&h)) else {
                        continue;
                    };
                    for &(_, iid) in keys.range((h, 0)..=(h, u32::MAX)) {
                        let Some(s) = o.active_slot_mut(iid) else {
                            continue;
                        };
                        if !s.committed || s.cell == NONE {
                            continue;
                        }
                        let w = want.contains(&s.cell);
                        if w && s.hidden_cell {
                            s.hidden_cell = false;
                            if live && !(s.lb != NONE && hidden.contains(&s.lb)) {
                                s.vis = true;
                            }
                        } else if !w && !s.hidden_cell {
                            s.hidden_cell = true;
                            s.vis = false;
                        }
                    }
                }
            }
            OP_POOL_CELLS_VIS => {
                let (Some(reg), Some(c)) = (u32_of(e[1]), u32_of(e[3])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let visible = e[2] != 0.0;
                let r = self.regs.entry(reg).or_default();
                for q in 0..c as usize {
                    let Some(cell) = u32_of(e[4 + q]) else {
                        continue;
                    };
                    let Some(keys) = self.idx.cell.get(&cell) else {
                        continue;
                    };
                    for &(h, iid) in keys {
                        let Some(o) = self.objects.get_mut(&h) else {
                            continue;
                        };
                        if o.kind != KIND_POOL || o.reg != reg {
                            continue;
                        }
                        let Some(s) = o.active_slot_mut(iid) else {
                            continue;
                        };
                        if !s.committed {
                            continue;
                        }
                        if visible && s.hidden_cell {
                            s.hidden_cell = false;
                            let live = r.recs.get(&(s.tile, h)) == Some(&true);
                            if live && !World::lb_hidden_in(r, s.lb) {
                                s.vis = true;
                            }
                        } else if !visible && !s.hidden_cell {
                            s.hidden_cell = true;
                            s.vis = false;
                        }
                    }
                }
            }
            OP_POOL_RELEASE_CELLS => {
                // The deletes follow as INST_DELs. What is decided HERE is which
                // membership records the release empties (JS prunes them).
                let (Some(reg), Some(c)) = (u32_of(e[1]), u32_of(e[2])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                self.totals.pool_release_cells += 1;
                let cells: BTreeSet<u32> = (0..c as usize).filter_map(|q| u32_of(e[3 + q])).collect();
                let r = self.regs.entry(reg).or_default();
                let mut emptied = Vec::new();
                for &(tile, h) in r.recs.keys() {
                    let mut had = 0u64;
                    let mut total = 0u64;
                    if let (Some(keys), Some(o)) = (self.idx.tile.get(&tile), self.objects.get(&h)) {
                        for &(_, iid) in keys.range((h, 0)..=(h, u32::MAX)) {
                            if let Some(s) = o.active_slot(iid) {
                                if !s.committed {
                                    continue;
                                }
                                total += 1;
                                if s.cell != NONE && cells.contains(&s.cell) {
                                    had += 1;
                                }
                            }
                        }
                    }
                    if had > 0 && had == total {
                        emptied.push((tile, h));
                    }
                }
                for k in emptied {
                    r.recs.remove(&k);
                }
            }
            OP_POOL_REG_RESET => {
                // PoolRegistry.dispose(): pools, tiles, parked marks and the cell
                // index go; `_hiddenLbs` is NOT cleared there, so it stays here too.
                let Some(reg) = u32_of(e[1]) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let r = self.regs.entry(reg).or_default();
                r.parked.clear();
                r.recs.clear();
            }
            OP_LRU_TRACK => {
                let (Some(lru), Some(lb)) = (u32_of(e[1]), u32_of(e[2])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let m = self.lrus.entry(lru).or_default();
                let st = m.get(&lb).copied();
                if e[3] != 0.0 {
                    if st != Some(LRU_PARKED) {
                        self.integrity[ik::TRACK_MERGE_DESYNC] += 1;
                    }
                    m.insert(lb, LRU_PARKED);
                } else {
                    if st == Some(LRU_PARKED) {
                        self.integrity[ik::TRACK_WHILE_PARKED] += 1;
                    }
                    m.insert(lb, LRU_LIVE);
                }
            }
            OP_LRU_PARK => {
                let (Some(lru), Some(lb)) = (u32_of(e[1]), u32_of(e[2])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let m = self.lrus.entry(lru).or_default();
                if m.get(&lb) != Some(&LRU_LIVE) {
                    self.integrity[ik::PARK_DESYNC] += 1;
                }
                m.insert(lb, LRU_PARKED);
            }
            OP_LRU_UNPARK => {
                let (Some(lru), Some(lb)) = (u32_of(e[1]), u32_of(e[2])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let m = self.lrus.entry(lru).or_default();
                if m.get(&lb) != Some(&LRU_PARKED) {
                    self.integrity[ik::UNPARK_DESYNC] += 1;
                }
                m.insert(lb, LRU_LIVE);
            }
            OP_LRU_EVICT => {
                let (Some(lru), Some(lb)) = (u32_of(e[1]), u32_of(e[2])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                if self.lrus.entry(lru).or_default().remove(&lb).is_none() {
                    self.integrity[ik::EVICT_UNKNOWN] += 1;
                }
            }
            OP_LRU_DROP_POOL => {
                let (Some(lru), Some(lb)) = (u32_of(e[1]), u32_of(e[2])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                self.lrus.entry(lru).or_default().insert(lb, LRU_LIVE);
            }
            OP_OBJR_HIDE | OP_OBJR_SHOW | OP_OBJR_FORGET => {
                let (Some(scene), Some(lb)) = (u32_of(e[1]), u32_of(e[2])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let set = self.objr.entry(scene).or_default();
                if op == OP_OBJR_HIDE {
                    set.insert(lb);
                } else {
                    set.remove(&lb);
                }
            }
            OP_TILE_STATE => {
                let (Some(grid), Some(tile), Some(from), Some(to)) = (u32_of(e[1]), u32_of(e[2]), u32_of(e[3]), u32_of(e[4])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let m = self.grids.entry(grid).or_default();
                let cur = m.get(&tile).map_or(TS_EMPTY, |r| r.state);
                if cur != from {
                    self.integrity[ik::TILE_DESYNC] += 1;
                }
                if !legal_transition(from, to) {
                    self.integrity[ik::ILLEGAL_TRANSITION] += 1;
                }
                if to == TS_EMPTY {
                    m.remove(&tile);
                } else {
                    m.insert(tile, TileRec { state: to, since: e[5], parked: e[6] });
                }
            }
            OP_CELL_PVS => {
                let (Some(scene), Some(a)) = (u32_of(e[1]), u32_of(e[2])) else {
                    self.integrity[ik::BAD_FIELD] += 1;
                    return;
                };
                let a = a as usize;
                let set = self.cells.entry(scene).or_default();
                for q in 0..a {
                    if let Some(v) = u32_of(e[3 + q]) {
                        set.insert(v);
                    }
                }
                let b = u32_of(e[3 + a]).unwrap_or(0) as usize; // validated by record_len
                for q in 0..b {
                    if let Some(v) = u32_of(e[4 + a + q]) {
                        set.remove(&v);
                    }
                }
            }
            OP_MARK => {
                self.totals.marks += 1;
            }
            _ => {}
        }
    }
}
