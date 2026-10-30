//! The audit: tools/rust_parity/gen_world_model.mjs `audit` and
//! `_andDivergence`, rule for rule.
//!
//! The arena holds f64 values the JS read from three.js and the JS residency.
//! Where the model puts arena values into a JS `Set` (SameValueZero), the
//! kernel uses [`key`]: the f64's bits with `-0` folded into `+0` and every NaN
//! into one, so membership agrees with the model value for value.

use std::collections::BTreeSet;

use super::events::*;
use super::{mk, LastAudit, World, LRU_LIVE};

/// SameValueZero as a set key.
#[inline]
fn key(v: f64) -> u64 {
    if v == 0.0 {
        0
    } else if v.is_nan() {
        0x7ff8_0000_0000_0000
    } else {
        v.to_bits()
    }
}

#[inline]
fn key32(v: u32) -> u64 {
    key(f64::from(v))
}

fn key_set(vals: &[f64]) -> BTreeSet<u64> {
    vals.iter().map(|&v| key(v)).collect()
}

/// `Object.is`, but NaN equals NaN (the model's `f64same`).
#[inline]
fn f64_same(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan())
}

fn sample(last: &mut LastAudit, msg: String) {
    if last.samples.len() < 16 {
        last.samples.push(msg);
    }
}

/// `_setDiff`: |js \ kernel| + |kernel \ js|, counted into `cat`.
fn set_diff(last: &mut LastAudit, cat: usize, js: &BTreeSet<u64>, kernel: &BTreeSet<u64>, what: &str) {
    for v in js {
        if !kernel.contains(v) {
            last.cat[cat] += 1;
            sample(last, format!("{what}: js has {}", f64::from_bits(*v)));
        }
    }
    for v in kernel {
        if !js.contains(v) {
            last.cat[cat] += 1;
            sample(last, format!("{what}: kernel has {}", f64::from_bits(*v)));
        }
    }
}

impl World {
    /// Compare against an audit arena (`WORLD_SEC` layout). `Some(this audit's
    /// mismatches)`, or `None` for a malformed arena (the model's `-1`).
    ///
    /// `poolHideOrphan` (2026-10-29) cross-checks two JS tables the arena
    /// carries: when it holds at least one `OBJR` section, every landblock in a
    /// `POOLREG` section's hidden list that no `OBJR` section lists counts 1 (per
    /// registry). The registry's `_hiddenLbs` is a sticky copy of the
    /// `?objRadius` hide (object_radius.js `_hide` is `hideLb`'s only product
    /// caller); a copy the owner no longer holds keeps those pooled statics
    /// invisible. With no `OBJR` section (no `?objRadius`, or a registry driven
    /// alone) there is no owner to compare with, and it reads 0.
    pub fn audit(&mut self, a: &[f64]) -> Option<u64> {
        self.last = LastAudit::default();
        let mut seen: BTreeSet<u64> = BTreeSet::new();
        let mut saw_objects = false;
        // poolHideOrphan: every OBJR section's landblocks, and each POOLREG hidden list.
        let mut saw_objr = false;
        let mut objr_union: BTreeSet<u64> = BTreeSet::new();
        let mut pool_hidden: Vec<(f64, BTreeSet<u64>)> = Vec::new();
        let n = a.len() as u64;
        let mut i = 0usize;
        // `need(k)`: k more values are available at `i`.
        let need = |i: usize, k: u64| -> bool { i as u64 + k <= n };
        while (i as u64) < n {
            let sec_v = a[i];
            i += 1;
            if sec_v == 0.0 {
                break; // SEC_END
            }
            let sec = u32_of(sec_v)?;
            if matches!(sec, SEC_LRU | SEC_GRID | SEC_OBJR | SEC_CELLS | SEC_POOLREG | SEC_POOLRECS | SEC_MATRICES | SEC_RANGES)
                && !need(i, 2)
            {
                return None;
            }
            match sec {
                SEC_OBJECTS => {
                    saw_objects = true;
                    if !need(i, 1) {
                        return None;
                    }
                    let n_obj = u32_of(a[i])?;
                    i += 1;
                    for _ in 0..n_obj {
                        if !need(i, 3) {
                            return None;
                        }
                        let h = a[i];
                        let mode = a[i + 1];
                        let len = u32_of(a[i + 2])?;
                        i += 3;
                        if !need(i, 2 * u64::from(len)) {
                            return None;
                        }
                        let len = len as usize;
                        seen.insert(key(h));
                        let obj = match u32_of(h) {
                            Some(hh) => self.objects.get(&hh),
                            None => None,
                        };
                        let Some(o) = obj else {
                            self.last.cat[mk::UNKNOWN_OBJECT] += 1;
                            sample(&mut self.last, format!("object {h}: unknown to the kernel"));
                            i += 2 * len;
                            continue;
                        };
                        // mode 1: a film take holds it (counted); mode 2: outside
                        // this audit's window (neither compared nor counted).
                        if mode != 0.0 {
                            if mode == 1.0 {
                                self.last.skipped += 1;
                            }
                            i += 2 * len;
                            continue;
                        }
                        let m = len.max(o.slots.len());
                        for s in 0..m {
                            let (jf, jg) = if s < len { (u32_of(a[i + 2 * s])?, a[i + 2 * s + 1]) } else { (0, 0.0) };
                            let j_active = (jf & 1) != 0;
                            let j_vis = (jf & 2) != 0;
                            let ks = o.slots.get(s);
                            let k_active = ks.is_some_and(|x| x.active);
                            if j_active != k_active {
                                self.last.cat[mk::ACTIVE] += 1;
                                sample(&mut self.last, format!("object {h} slot {s}: active js {j_active} kernel {k_active}"));
                                continue;
                            }
                            if !j_active {
                                continue;
                            }
                            let Some(ks) = ks else {
                                continue;
                            };
                            if jg != f64::from(ks.gid) {
                                self.last.cat[mk::GID] += 1;
                                sample(&mut self.last, format!("object {h} slot {s}: gid js {jg} kernel {}", ks.gid));
                            }
                            if j_vis != ks.vis {
                                self.last.cat[mk::VIS] += 1;
                                sample(&mut self.last, format!("object {h} slot {s}: visible js {j_vis} kernel {}", ks.vis));
                            }
                            if j_vis != ks.raw {
                                self.last.cat[mk::RAW] += 1;
                                sample(&mut self.last, format!("object {h} slot {s}: raw js {j_vis} kernel {}", ks.raw));
                            }
                        }
                        if len != o.slots.len() {
                            self.last.cat[mk::SLOTS_LEN] += 1;
                            sample(&mut self.last, format!("object {h}: {len} slots in js, {} in the kernel", o.slots.len()));
                        }
                        i += 2 * len;
                    }
                }
                SEC_LRU => {
                    let id = a[i];
                    i += 1;
                    let nl = u32_of(a[i])?;
                    i += 1;
                    if !need(i, u64::from(nl) + 1) {
                        return None;
                    }
                    let live = key_set(&a[i..i + nl as usize]);
                    i += nl as usize;
                    let np = u32_of(a[i])?;
                    i += 1;
                    if !need(i, u64::from(np)) {
                        return None;
                    }
                    let parked = key_set(&a[i..i + np as usize]);
                    i += np as usize;
                    let mut kl = BTreeSet::new();
                    let mut kp = BTreeSet::new();
                    if let Some(m) = u32_of(id).and_then(|x| self.lrus.get(&x)) {
                        for (&lb, &st) in m {
                            if st == LRU_LIVE {
                                kl.insert(key32(lb));
                            } else {
                                kp.insert(key32(lb));
                            }
                        }
                    }
                    set_diff(&mut self.last, mk::LRU, &live, &kl, &format!("lru {id} live"));
                    set_diff(&mut self.last, mk::LRU, &parked, &kp, &format!("lru {id} parked"));
                }
                SEC_GRID => {
                    let id = a[i];
                    i += 1;
                    let c = u32_of(a[i])?;
                    i += 1;
                    if !need(i, 4 * u64::from(c)) {
                        return None;
                    }
                    let m = u32_of(id).and_then(|x| self.grids.get(&x));
                    let mut js = BTreeSet::new();
                    for _ in 0..c {
                        let (tile, st, since, parked) = (a[i], a[i + 1], a[i + 2], a[i + 3]);
                        i += 4;
                        js.insert(key(tile));
                        let r = match (m, u32_of(tile)) {
                            (Some(m), Some(t)) => m.get(&t),
                            _ => None,
                        };
                        match r {
                            Some(r) if f64::from(r.state) == st => {
                                if !f64_same(r.since, since) || !f64_same(r.parked, parked) {
                                    self.last.cat[mk::TILE_TIME] += 1;
                                    sample(&mut self.last, format!("grid {id} tile {tile}: times differ"));
                                }
                            }
                            _ => {
                                self.last.cat[mk::TILE_STATE] += 1;
                                let k = match r {
                                    Some(r) => r.state.to_string(),
                                    None => "EMPTY".to_string(),
                                };
                                sample(&mut self.last, format!("grid {id} tile {tile}: js {st} kernel {k}"));
                            }
                        }
                    }
                    if let Some(m) = m {
                        for &t in m.keys() {
                            if !js.contains(&key32(t)) {
                                self.last.cat[mk::TILE_STATE] += 1;
                                sample(&mut self.last, format!("grid {id} tile {t}: kernel only"));
                            }
                        }
                    }
                }
                SEC_OBJR | SEC_CELLS => {
                    let id = a[i];
                    i += 1;
                    let c = u32_of(a[i])?;
                    i += 1;
                    if !need(i, u64::from(c)) {
                        return None;
                    }
                    let js = key_set(&a[i..i + c as usize]);
                    i += c as usize;
                    if sec == SEC_OBJR {
                        saw_objr = true;
                        objr_union.extend(js.iter().copied());
                    }
                    let table = if sec == SEC_OBJR { &self.objr } else { &self.cells };
                    let k: BTreeSet<u64> = match u32_of(id).and_then(|x| table.get(&x)) {
                        Some(set) => set.iter().map(|&v| key32(v)).collect(),
                        None => BTreeSet::new(),
                    };
                    let (cat, what) = if sec == SEC_OBJR { (mk::OBJR, format!("objRadius {id}")) } else { (mk::CELLS, format!("cell pvs {id}")) };
                    set_diff(&mut self.last, cat, &js, &k, &what);
                }
                SEC_POOLREG => {
                    let id = a[i];
                    i += 1;
                    let np = u32_of(a[i])?;
                    i += 1;
                    if !need(i, u64::from(np) + 1) {
                        return None;
                    }
                    let parked = key_set(&a[i..i + np as usize]);
                    i += np as usize;
                    let nh = u32_of(a[i])?;
                    i += 1;
                    if !need(i, u64::from(nh)) {
                        return None;
                    }
                    let hidden = key_set(&a[i..i + nh as usize]);
                    i += nh as usize;
                    let (kp, kh): (BTreeSet<u64>, BTreeSet<u64>) = match u32_of(id).and_then(|x| self.regs.get(&x)) {
                        Some(r) => (r.parked.iter().map(|&v| key32(v)).collect(), r.hidden_lbs.iter().map(|&v| key32(v)).collect()),
                        None => (BTreeSet::new(), BTreeSet::new()),
                    };
                    set_diff(&mut self.last, mk::POOL_REG, &parked, &kp, &format!("pool reg {id} parked tiles"));
                    set_diff(&mut self.last, mk::POOL_REG, &hidden, &kh, &format!("pool reg {id} hidden lbs"));
                    pool_hidden.push((id, hidden));
                }
                SEC_POOLRECS => {
                    let id = a[i];
                    i += 1;
                    let c = u32_of(a[i])?;
                    i += 1;
                    let reg = u32_of(id).and_then(|x| self.regs.get(&x));
                    let mut js: BTreeSet<(u64, u64)> = BTreeSet::new();
                    for _ in 0..c {
                        if !need(i, 4) {
                            return None;
                        }
                        let tile = a[i];
                        let h = a[i + 1];
                        let live = a[i + 2] != 0.0;
                        let nh = u32_of(a[i + 3])?;
                        i += 4;
                        if !need(i, u64::from(nh)) {
                            return None;
                        }
                        let hid = key_set(&a[i..i + nh as usize]);
                        i += nh as usize;
                        js.insert((key(tile), key(h)));
                        let rec = match (reg, u32_of(tile), u32_of(h)) {
                            (Some(r), Some(t), Some(hh)) => r.recs.get(&(t, hh)).copied(),
                            _ => None,
                        };
                        if rec != Some(live) {
                            self.last.cat[mk::POOL_REC] += 1;
                            let k = match rec {
                                Some(v) => v.to_string(),
                                None => "none".to_string(),
                            };
                            sample(&mut self.last, format!("pool reg {id} record {tile}:{h}: js live {live} kernel {k}"));
                        }
                        let mut khid = BTreeSet::new();
                        if let (Some(t), Some(hh)) = (u32_of(tile), u32_of(h)) {
                            if let (Some(o), Some(keys)) = (self.objects.get(&hh), self.idx.tile.get(&t)) {
                                for &(_, iid) in keys.range((hh, 0)..=(hh, u32::MAX)) {
                                    if let Some(s) = o.active_slot(iid) {
                                        if s.committed && s.hidden_cell {
                                            khid.insert(key32(iid));
                                        }
                                    }
                                }
                            }
                        }
                        set_diff(&mut self.last, mk::POOL_HIDDEN, &hid, &khid, &format!("pool reg {id} record {tile}:{h} hidden cells"));
                    }
                    if let Some(r) = reg {
                        for &(t, hh) in r.recs.keys() {
                            if !js.contains(&(key32(t), key32(hh))) {
                                self.last.cat[mk::POOL_REC] += 1;
                                sample(&mut self.last, format!("pool reg {id} record {t}:{hh}: kernel only"));
                            }
                        }
                    }
                }
                SEC_MATRICES => {
                    let h = a[i];
                    i += 1;
                    let c = u32_of(a[i])?;
                    i += 1;
                    if !need(i, 17 * u64::from(c)) {
                        return None;
                    }
                    let o = u32_of(h).and_then(|x| self.objects.get(&x));
                    for _ in 0..c {
                        let iid = a[i];
                        let s = match (o, u32_of(iid)) {
                            (Some(o), Some(k)) => o.active_slot(k),
                            _ => None,
                        };
                        let diff = match s {
                            None => true,
                            // `f32bits`: Math.fround, then the bits (as f32 rounds the same way).
                            Some(s) => (0..16).any(|k| (a[i + 1 + k] as f32).to_bits() != s.m[k].to_bits()),
                        };
                        if diff {
                            self.last.cat[mk::MATRIX] += 1;
                            sample(&mut self.last, format!("object {h} slot {iid}: matrix differs"));
                        }
                        i += 17;
                    }
                }
                SEC_RANGES => {
                    let h = a[i];
                    i += 1;
                    let c = u32_of(a[i])?;
                    i += 1;
                    if !need(i, 3 * u64::from(c)) {
                        return None;
                    }
                    let o = u32_of(h).and_then(|x| self.objects.get(&x));
                    let mut js = BTreeSet::new();
                    for _ in 0..c {
                        let (gid, start, count) = (a[i], a[i + 1], a[i + 2]);
                        i += 3;
                        js.insert(key(gid));
                        let g = match (o, u32_of(gid)) {
                            (Some(o), Some(k)) => o.geoms.get(k as usize),
                            _ => None,
                        };
                        let ok = g.is_some_and(|g| g.active && g.start == start && g.count == count);
                        if !ok {
                            self.last.cat[mk::RANGES] += 1;
                            sample(&mut self.last, format!("object {h} gid {gid}: range differs"));
                        }
                    }
                    if let Some(o) = o {
                        for (gi, g) in o.geoms.iter().enumerate() {
                            if g.active && !js.contains(&key(gi as f64)) {
                                self.last.cat[mk::RANGES] += 1;
                                sample(&mut self.last, format!("object {h} gid {gi}: kernel only"));
                            }
                        }
                    }
                }
                SEC_UNTRACKED => {
                    if !need(i, 1) {
                        return None;
                    }
                    let c = u32_of(a[i])?;
                    i += 1;
                    if c > 0 {
                        self.last.cat[mk::UNTRACKED] += u64::from(c);
                        sample(&mut self.last, format!("{c} shadow-kind draw objects were never tracked"));
                    }
                }
                _ => return None,
            }
        }
        if saw_objects {
            let missing: Vec<u32> = self.objects.keys().copied().filter(|&h| !seen.contains(&key32(h))).collect();
            for h in missing {
                self.last.cat[mk::MISSING_OBJECT] += 1;
                sample(&mut self.last, format!("object {h}: kernel only"));
            }
        }
        // The pool registry's landblock hides must be `?objRadius` hides.
        if saw_objr {
            for (id, hidden) in &pool_hidden {
                for v in hidden {
                    if !objr_union.contains(v) {
                        self.last.cat[mk::POOL_HIDE_ORPHAN] += 1;
                        sample(&mut self.last, format!("pool reg {id} hides landblock {}, which no ?objRadius set hides", f64::from_bits(*v)));
                    }
                }
            }
        }
        let total: u64 = self.last.cat.iter().sum();
        self.last.mismatches = total;
        self.last.and_divergence = self.and_divergence();
        self.totals.audits += 1;
        self.totals.mismatches += total;
        Some(total)
    }

    /// The R2 §2.2 AND form ("visible = no owner bit set") against the exact
    /// model, instance by instance (a diagnostic, never part of `mismatches`).
    pub fn and_divergence(&self) -> u64 {
        let mut d = 0u64;
        for o in self.objects.values() {
            for s in &o.slots {
                if !s.active {
                    continue;
                }
                let want = if o.kind == KIND_CHUNK || o.kind == KIND_ATLAS {
                    if s.lb == NONE {
                        continue;
                    }
                    !(self.lru_parked(s.lb) || self.objr_hidden(s.lb))
                } else if o.kind == KIND_POOL {
                    if s.tile == NONE {
                        continue;
                    }
                    let r = self.regs.get(&o.reg);
                    let parked = r.is_some_and(|r| r.parked.contains(&s.tile));
                    let lb_hidden = r.is_some_and(|r| World::lb_hidden_in(r, s.lb));
                    s.committed && !parked && !lb_hidden && !s.hidden_cell
                } else {
                    true
                };
                if want != s.vis {
                    d += 1;
                }
            }
        }
        d
    }
}
