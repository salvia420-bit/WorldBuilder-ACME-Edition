// tools/rust_parity/gen_world_model.mjs — the JS reference model of the lane W
// kernel (crates/holtburger-scene/src/world/). Same tables, same event
// semantics, same audit categories, rule for rule: the Rust kernel is a port of
// this file, and tests/rust_world_shadow.test.mjs + tools/rust_parity/gen_world.mjs
// run it against the REAL producers before any cargo build. It is also the
// kernel `tools/rust_parity/gen_world_arm.mjs` injects when the existing suites
// run with the hooks armed.
//
// Event / audit layouts: scene3d/rust/world.js (WORLD_OP, WORLD_SEC).
//
// THE VISIBILITY MODEL (what the kernel DERIVES; the raw setVisibleAt stream is
// a diagnostic only):
//   chunk / atlas instance — born visible (three's addInstance); a landblock
//     show / hide seam (`LB_VIS`: chunk `_setLbVisible`, atlas
//     park/unpark) writes it for every instance ATTRIBUTED to that landblock in
//     that kind. That is the JS rule exactly (single bit, last writer).
//   pool instance — born invisible and uncommitted (`POOL_ATTR`); the
//     registry's commit / parkTile / adoptTile / hideLb / showLb /
//     cellSetChanged / setCellsVisible re-implemented over the kernel's own
//     membership (committed slots by tile, landblock, cell), the per-(tile,
//     pool) `live` flag, the parked-tile set and the hidden-landblock set.
//   building instance — born visible, never written.
// The AND form R2 §2.2 proposes for S4 (visible = no owner bit set) is computed
// next to it as a diagnostic, `andDivergence`: for chunk / atlas,
// !(the LRU parks the landblock || ?objRadius hides it); for pools,
// committed && !parked tile && !hidden landblock && !hidden cell.

import { WORLD_OP as OP, WORLD_SEC as SEC, WORLD_KIND as K, WORLD_TILE_STATE as TS, WORLD_ABI } from "../../scene3d/rust/world.js";

const NONE = 0xffffffff; // internal "absent" for u32 fields (Rust: u32::MAX)
// An id further than this past a table's end is refused (badField): three's ids
// are dense, and a corrupt one must not allocate a gap of billions of slots.
export const MAX_ID_GAP = 65536;
const LIVE = 1;
const PARKED = 2;

// residency_grid.js LEGAL, as state codes.
const LEGAL = new Map([
  [TS.EMPTY, new Set([TS.FETCHING, TS.STAGED, TS.QUARANTINED])],
  [TS.FETCHING, new Set([TS.STAGED, TS.QUARANTINED, TS.EMPTY])],
  [TS.STAGED, new Set([TS.LIVE, TS.EMPTY])],
  [TS.LIVE, new Set([TS.PARKED, TS.EMPTY])],
  [TS.PARKED, new Set([TS.LIVE, TS.EMPTY])],
  [TS.QUARANTINED, new Set([TS.FETCHING, TS.EMPTY])],
]);

/** Record lengths for fixed-size ops (variable ones are decoded inline). */
const FIXED_LEN = new Map([
  [OP.TRACK, 5], [OP.DISPOSE, 2], [OP.GEOM_ADD, 5], [OP.GEOM_DEL, 3],
  [OP.INST_ADD, 4], [OP.INST_DEL, 3], [OP.INST_MATRIX, 19], [OP.INST_GID, 4],
  [OP.INST_VIS_RAW, 4], [OP.INST_COUNT, 3], [OP.INST_SNAP, 6], [OP.GEOM_SNAP, 6],
  [OP.ATTR_LB, 4], [OP.LB_VIS, 4], [OP.POOL_ATTR, 6],
  [OP.POOL_PARK, 3], [OP.POOL_ADOPT, 3], [OP.POOL_CLEAR_PARKED, 3], [OP.POOL_RELEASE, 3],
  [OP.POOL_HIDE_LB, 3], [OP.POOL_SHOW_LB, 3], [OP.POOL_REG_RESET, 2],
  [OP.LRU_TRACK, 4], [OP.LRU_PARK, 3], [OP.LRU_UNPARK, 3], [OP.LRU_EVICT, 3], [OP.LRU_DROP_POOL, 3],
  [OP.OBJR_HIDE, 3], [OP.OBJR_SHOW, 3], [OP.OBJR_FORGET, 3],
  [OP.TILE_STATE, 7], [OP.MARK, 2],
]);

/** Integrity counters (stream plumbing; every one must stay 0). */
export const INTEGRITY_KEYS = Object.freeze([
  "unknownHandle", "badField", "retrack", "slotDesync", "addOverLive", "addBadGid", "delDead",
  "deadWrite", "gidDesync", "geomDelDead", "cascadeMiss", "rangeDead", "commitDead",
  "trackMergeDesync", "trackWhileParked", "parkDesync", "unparkDesync", "evictUnknown",
  "tileDesync", "illegalTransition", "reattr",
]);

/**
 * Audit mismatch categories. Most compare the kernel with the JS; two count a
 * JS-side fact the arena carries: `untracked` (shadow-kind objects never
 * tracked) and `poolHideOrphan` (2026-10-29): when the arena carries at least
 * one OBJR section, every landblock in a POOLREG section's hidden list that no
 * OBJR section of the same arena lists counts 1 (per registry). The pool
 * registry's `_hiddenLbs` is a sticky COPY of ?objRadius's hide
 * (object_radius.js `_hide` is `hideLb`'s only product caller), so a registry
 * hide objRadius no longer holds is a drifted owner bit: those pooled statics
 * stay invisible until objRadius hides and shows the landblock again. Without
 * an OBJR section (?objRadius off or never ticked, or a registry driven on its
 * own as in the `pool` scenario) the check has no owner to compare with and
 * reads 0.
 */
export const MISMATCH_KEYS = Object.freeze([
  "unknownObject", "missingObject", "slotsLen", "active", "gid", "vis", "raw",
  "lru", "tileState", "tileTime", "objr", "cells", "poolReg", "poolRec", "poolHidden",
  "matrix", "ranges", "untracked", "poolHideOrphan",
]);

/** `pool_registry.js` tileKeyOfLbKey. */
export function tileKeyOfLbKey(lbKey) {
  const x = (lbKey >>> 24) & 0xff;
  const y = (lbKey >>> 16) & 0xff;
  return (((x >> 1) & 0xff) << 8) | ((y >> 1) & 0xff);
}

function u32(v) {
  return Number.isInteger(v) && v >= 0 && v < 4294967296 ? v : null;
}
function optU32(v) {
  if (v < 0) return NONE;
  return u32(v);
}
const sk = (h, iid) => h * 4294967296 + iid; // slot key (h < 2^21)
const skH = (k) => Math.floor(k / 4294967296);
const skI = (k) => k % 4294967296;

const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
function f32bits(v) { _f32[0] = v; return _u32[0]; }
function f64same(a, b) { return Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b)); }

function freshSlot(gid) {
  return {
    active: true, gid, vis: true, raw: true,
    lb: NONE, tile: NONE, cell: NONE, committed: true, hiddenCell: false,
    m: Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1),
  };
}

function minOf(set) {
  let m = Infinity;
  for (const v of set) if (v < m) m = v;
  return m;
}

function addTo(map, key, v) {
  let s = map.get(key);
  if (!s) { s = new Set(); map.set(key, s); }
  s.add(v);
}
function delFrom(map, key, v) {
  const s = map.get(key);
  if (!s) return;
  s.delete(v);
  if (s.size === 0) map.delete(key);
}

export class WorldModel {
  constructor() {
    this.reset();
  }

  abi() { return WORLD_ABI; }

  reset() {
    this.objects = new Map(); // h -> { kind, lb, reg, slots[], free:Set, geoms[], freeGeoms:Set }
    this.lbIndex = new Map(); // lbKey -> Set<slotKey>  (chunk / atlas ATTR_LB, pool POOL_ATTR)
    this.tileIndex = new Map(); // tile -> Set<slotKey> (pool slots)
    this.cellIndex = new Map(); // cell -> Set<slotKey> (pool slots)
    this.regs = new Map(); // reg -> { parked:Set<tile>, hiddenLbs:Set<lb>, recs: Map<"tile:h", {tile,h,live}> }
    this.lrus = new Map(); // lru -> Map<lb, LIVE|PARKED>
    this.grids = new Map(); // grid -> Map<tile, {state, since, parked}>
    this.objr = new Map(); // scene -> Set<lb>
    this.cells = new Map(); // scene -> Set<cell>
    this.integrity = Object.fromEntries(INTEGRITY_KEYS.map((k) => [k, 0]));
    this.totals = { events: 0, batches: 0, audits: 0, mismatches: 0, poolReleaseCells: 0, marks: 0 };
    this.last = { mismatches: 0, cat: Object.fromEntries(MISMATCH_KEYS.map((k) => [k, 0])), skipped: 0, andDivergence: 0, samples: [] };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  _obj(h) {
    const o = this.objects.get(h);
    if (!o) this.integrity.unknownHandle += 1;
    return o || null;
  }

  _reg(reg) {
    let r = this.regs.get(reg);
    if (!r) { r = { parked: new Set(), hiddenLbs: new Set(), recs: new Map() }; this.regs.set(reg, r); }
    return r;
  }

  _deindex(h, iid, s) {
    const key = sk(h, iid);
    if (s.lb !== NONE) delFrom(this.lbIndex, s.lb, key);
    if (s.tile !== NONE) delFrom(this.tileIndex, s.tile, key);
    if (s.cell !== NONE) delFrom(this.cellIndex, s.cell, key);
  }

  _lbHidden(reg, lb) {
    if (lb === NONE) return false;
    const r = this.regs.get(reg);
    return !!r && r.hiddenLbs.has(lb);
  }

  _disposeObject(h) {
    const o = this.objects.get(h);
    if (!o) return;
    for (let i = 0; i < o.slots.length; i++) {
      const s = o.slots[i];
      if (s && s.active) this._deindex(h, i, s);
    }
    if (o.reg !== NONE) {
      const r = this.regs.get(o.reg);
      if (r) for (const [k, rec] of [...r.recs]) if (rec.h === h) r.recs.delete(k);
    }
    this.objects.delete(h);
  }

  // Committed active pool slots of object `h` in `tile`.
  *_poolSlots(h, tile) {
    const keys = this.tileIndex.get(tile);
    if (!keys) return;
    const o = this.objects.get(h);
    if (!o) return;
    for (const key of keys) {
      if (skH(key) !== h) continue;
      const s = o.slots[skI(key)];
      if (s && s.active && s.committed) yield s;
    }
  }

  // ── events ───────────────────────────────────────────────────────────────

  /** Apply a batch. Returns records applied, or -1 (decode error: unknown op / truncated). */
  apply(ev) {
    const n = ev.length;
    let i = 0;
    let applied = 0;
    while (i < n) {
      const op = ev[i];
      let len = FIXED_LEN.get(op);
      if (len === undefined) {
        // variable-length records
        if (op === OP.GEOM_RANGES) {
          if (i + 3 > n) return -1;
          const c = u32(ev[i + 2]);
          if (c === null) return -1;
          len = 3 + 3 * c;
        } else if (op === OP.POOL_COMMIT) {
          if (i + 4 > n) return -1;
          const np = u32(ev[i + 3]);
          if (np === null) return -1;
          let k = i + 4;
          for (let p = 0; p < np; p++) {
            if (k + 2 > n) return -1;
            const c = u32(ev[k + 1]);
            if (c === null) return -1;
            k += 2 + c;
          }
          len = k - i;
        } else if (op === OP.POOL_CELLSET || op === OP.POOL_CELLS_VIS) {
          if (i + 4 > n) return -1;
          const c = u32(ev[i + 3]);
          if (c === null) return -1;
          len = 4 + c;
        } else if (op === OP.POOL_RELEASE_CELLS) {
          if (i + 3 > n) return -1;
          const c = u32(ev[i + 2]);
          if (c === null) return -1;
          len = 3 + c;
        } else if (op === OP.CELL_PVS) {
          if (i + 3 > n) return -1;
          const a = u32(ev[i + 2]);
          if (a === null || i + 3 + a + 1 > n) return -1;
          const b = u32(ev[i + 3 + a]);
          if (b === null) return -1;
          len = 4 + a + b;
        } else {
          return -1;
        }
      }
      if (i + len > n) return -1;
      this._apply1(op, ev, i);
      i += len;
      applied += 1;
    }
    this.totals.events += applied;
    this.totals.batches += 1;
    return applied;
  }

  _apply1(op, e, i) {
    const I = this.integrity;
    switch (op) {
      case OP.TRACK: {
        const h = u32(e[i + 1]), kind = u32(e[i + 2]), lb = optU32(e[i + 3]), reg = optU32(e[i + 4]);
        if (h === null || kind === null || lb === null || reg === null) { I.badField += 1; return; }
        if (this.objects.has(h)) { I.retrack += 1; this._disposeObject(h); }
        this.objects.set(h, { kind, lb, reg, slots: [], free: new Set(), geoms: [], freeGeoms: new Set() });
        return;
      }
      case OP.DISPOSE: {
        const h = u32(e[i + 1]);
        if (h === null) { I.badField += 1; return; }
        if (!this.objects.has(h)) { I.unknownHandle += 1; return; }
        this._disposeObject(h);
        return;
      }
      case OP.GEOM_ADD:
      case OP.GEOM_SNAP: {
        const h = u32(e[i + 1]), gid = u32(e[i + 2]);
        if (h === null || gid === null) { I.badField += 1; return; }
        const o = this._obj(h);
        if (!o) return;
        if (gid > o.geoms.length + MAX_ID_GAP) { I.badField += 1; return; }
        let active = true, start, count;
        if (op === OP.GEOM_ADD) {
          start = e[i + 3]; count = e[i + 4];
          const predicted = o.freeGeoms.size > 0 ? minOf(o.freeGeoms) : o.geoms.length;
          if (gid !== predicted) I.gidDesync += 1;
        } else {
          active = e[i + 3] !== 0; start = e[i + 4]; count = e[i + 5];
        }
        while (o.geoms.length <= gid) o.geoms.push({ active: false, start: 0, count: 0 });
        o.geoms[gid] = { active, start, count };
        if (active) o.freeGeoms.delete(gid); else o.freeGeoms.add(gid);
        return;
      }
      case OP.GEOM_DEL: {
        const h = u32(e[i + 1]), gid = u32(e[i + 2]);
        if (h === null || gid === null) { I.badField += 1; return; }
        const o = this._obj(h);
        if (!o) return;
        const g = o.geoms[gid];
        if (!g || !g.active) { I.geomDelDead += 1; return; }
        // three deletes every active instance of the geometry BEFORE this
        // record (they arrive as INST_DELs); one still here was missed.
        for (let s = 0; s < o.slots.length; s++) {
          const x = o.slots[s];
          if (x && x.active && x.gid === gid) {
            I.cascadeMiss += 1;
            this._deindex(h, s, x);
            x.active = false;
            o.free.add(s);
          }
        }
        g.active = false;
        o.freeGeoms.add(gid);
        return;
      }
      case OP.GEOM_RANGES: {
        const h = u32(e[i + 1]), c = u32(e[i + 2]);
        if (h === null || c === null) { I.badField += 1; return; }
        const o = this._obj(h);
        if (!o) return;
        for (let k = 0; k < c; k++) {
          const gid = u32(e[i + 3 + 3 * k]);
          const g = gid === null ? null : o.geoms[gid];
          if (!g || !g.active) { I.rangeDead += 1; continue; }
          g.start = e[i + 4 + 3 * k];
          g.count = e[i + 5 + 3 * k];
        }
        return;
      }
      case OP.INST_ADD: {
        const h = u32(e[i + 1]), iid = u32(e[i + 2]), gid = u32(e[i + 3]);
        if (h === null || iid === null || gid === null) { I.badField += 1; return; }
        const o = this._obj(h);
        if (!o) return;
        if (iid > o.slots.length + MAX_ID_GAP) { I.badField += 1; return; }
        const predicted = o.free.size > 0 ? minOf(o.free) : o.slots.length;
        if (iid !== predicted) I.slotDesync += 1;
        const old = o.slots[iid];
        if (old && old.active) { I.addOverLive += 1; this._deindex(h, iid, old); }
        const g = o.geoms[gid];
        if (!g || !g.active) I.addBadGid += 1;
        while (o.slots.length < iid) o.slots.push(null); // a desync gap (counted above)
        o.slots[iid] = freshSlot(gid);
        o.free.delete(iid);
        return;
      }
      case OP.INST_SNAP: {
        const h = u32(e[i + 1]), iid = u32(e[i + 2]), gid = u32(e[i + 4]);
        if (h === null || iid === null || gid === null) { I.badField += 1; return; }
        const o = this._obj(h);
        if (!o) return;
        if (iid > o.slots.length + MAX_ID_GAP) { I.badField += 1; return; }
        const active = e[i + 3] !== 0;
        const vis = e[i + 5] !== 0;
        while (o.slots.length < iid) o.slots.push(null);
        const old = o.slots[iid];
        if (old && old.active) this._deindex(h, iid, old);
        const s = freshSlot(gid);
        s.active = active; s.vis = vis; s.raw = vis;
        o.slots[iid] = s;
        if (active) o.free.delete(iid); else o.free.add(iid);
        return;
      }
      case OP.INST_DEL: {
        const h = u32(e[i + 1]), iid = u32(e[i + 2]);
        if (h === null || iid === null) { I.badField += 1; return; }
        const o = this._obj(h);
        if (!o) return;
        const s = o.slots[iid];
        if (!s || !s.active) { I.delDead += 1; return; }
        this._deindex(h, iid, s);
        s.active = false;
        o.free.add(iid);
        return;
      }
      case OP.INST_MATRIX: {
        const h = u32(e[i + 1]), iid = u32(e[i + 2]);
        if (h === null || iid === null) { I.badField += 1; return; }
        const o = this._obj(h);
        if (!o) return;
        const s = o.slots[iid];
        if (!s || !s.active) { I.deadWrite += 1; return; }
        for (let k = 0; k < 16; k++) s.m[k] = e[i + 3 + k];
        return;
      }
      case OP.INST_GID: {
        const h = u32(e[i + 1]), iid = u32(e[i + 2]), gid = u32(e[i + 3]);
        if (h === null || iid === null || gid === null) { I.badField += 1; return; }
        const o = this._obj(h);
        if (!o) return;
        const s = o.slots[iid];
        if (!s || !s.active) { I.deadWrite += 1; return; }
        s.gid = gid;
        return;
      }
      case OP.INST_VIS_RAW: {
        const h = u32(e[i + 1]), iid = u32(e[i + 2]);
        if (h === null || iid === null) { I.badField += 1; return; }
        const o = this._obj(h);
        if (!o) return;
        const s = o.slots[iid];
        if (!s || !s.active) { I.deadWrite += 1; return; }
        s.raw = e[i + 3] !== 0;
        return;
      }
      case OP.INST_COUNT: {
        const h = u32(e[i + 1]);
        if (h === null) { I.badField += 1; return; }
        const o = this._obj(h);
        if (!o) return;
        // three r184 setInstanceCount: drop trailing free ids.
        while (o.slots.length > 0 && o.free.has(o.slots.length - 1)) {
          o.free.delete(o.slots.length - 1);
          o.slots.pop();
        }
        return;
      }
      case OP.ATTR_LB: {
        const h = u32(e[i + 1]), iid = u32(e[i + 2]), lb = u32(e[i + 3]);
        if (h === null || iid === null || lb === null) { I.badField += 1; return; }
        const o = this._obj(h);
        if (!o) return;
        const s = o.slots[iid];
        if (!s || !s.active) { I.deadWrite += 1; return; }
        if (s.lb !== NONE && s.lb !== lb) { I.reattr += 1; delFrom(this.lbIndex, s.lb, sk(h, iid)); }
        s.lb = lb;
        addTo(this.lbIndex, lb, sk(h, iid));
        return;
      }
      case OP.LB_VIS: {
        const kind = u32(e[i + 1]), lb = u32(e[i + 2]);
        if (kind === null || lb === null) { I.badField += 1; return; }
        const v = e[i + 3] !== 0;
        const keys = this.lbIndex.get(lb);
        if (!keys) return;
        for (const key of keys) {
          const o = this.objects.get(skH(key));
          if (!o || o.kind !== kind) continue;
          const s = o.slots[skI(key)];
          if (s && s.active) s.vis = v;
        }
        return;
      }
      case OP.POOL_ATTR: {
        const h = u32(e[i + 1]), iid = u32(e[i + 2]), tile = u32(e[i + 3]), lb = optU32(e[i + 4]), cell = optU32(e[i + 5]);
        if (h === null || iid === null || tile === null || lb === null || cell === null) { I.badField += 1; return; }
        const o = this._obj(h);
        if (!o) return;
        const s = o.slots[iid];
        if (!s || !s.active) { I.deadWrite += 1; return; }
        this._deindex(h, iid, s);
        s.tile = tile; s.lb = lb; s.cell = cell;
        s.committed = false; s.vis = false; s.hiddenCell = false;
        const key = sk(h, iid);
        addTo(this.tileIndex, tile, key);
        if (lb !== NONE) addTo(this.lbIndex, lb, key);
        if (cell !== NONE) addTo(this.cellIndex, cell, key);
        return;
      }
      case OP.POOL_COMMIT: {
        const reg = u32(e[i + 1]), tile = u32(e[i + 2]), np = u32(e[i + 3]);
        if (reg === null || tile === null || np === null) { I.badField += 1; return; }
        const r = this._reg(reg);
        const live = !r.parked.has(tile);
        let k = i + 4;
        for (let p = 0; p < np; p++) {
          const h = u32(e[k]);
          const c = e[k + 1];
          const o = h === null ? null : this._obj(h);
          if (o) {
            const rk = `${tile}:${h}`;
            let rec = r.recs.get(rk);
            if (!rec) { rec = { tile, h, live }; r.recs.set(rk, rec); }
            rec.live = live;
            for (let q = 0; q < c; q++) {
              const iid = u32(e[k + 2 + q]);
              const s = iid === null ? null : o.slots[iid];
              if (!s || !s.active) { I.commitDead += 1; continue; }
              s.committed = true;
              if (live && !this._lbHidden(reg, s.lb)) s.vis = true;
            }
          }
          k += 2 + c;
        }
        return;
      }
      case OP.POOL_PARK: {
        const reg = u32(e[i + 1]), tile = u32(e[i + 2]);
        if (reg === null || tile === null) { I.badField += 1; return; }
        const r = this._reg(reg);
        r.parked.add(tile);
        for (const rec of r.recs.values()) {
          if (rec.tile !== tile || !rec.live) continue;
          for (const s of this._poolSlots(rec.h, tile)) s.vis = false;
          rec.live = false;
        }
        return;
      }
      case OP.POOL_ADOPT: {
        const reg = u32(e[i + 1]), tile = u32(e[i + 2]);
        if (reg === null || tile === null) { I.badField += 1; return; }
        const r = this._reg(reg);
        r.parked.delete(tile);
        for (const rec of r.recs.values()) {
          if (rec.tile !== tile || rec.live) continue;
          for (const s of this._poolSlots(rec.h, tile)) {
            if (s.hiddenCell) continue;
            if (this._lbHidden(reg, s.lb)) continue;
            s.vis = true;
          }
          rec.live = true;
        }
        return;
      }
      case OP.POOL_CLEAR_PARKED: {
        const reg = u32(e[i + 1]), tile = u32(e[i + 2]);
        if (reg === null || tile === null) { I.badField += 1; return; }
        this._reg(reg).parked.delete(tile);
        return;
      }
      case OP.POOL_RELEASE: {
        const reg = u32(e[i + 1]), tile = u32(e[i + 2]);
        if (reg === null || tile === null) { I.badField += 1; return; }
        const r = this._reg(reg);
        r.parked.delete(tile);
        for (const [k, rec] of [...r.recs]) if (rec.tile === tile) r.recs.delete(k);
        return;
      }
      case OP.POOL_HIDE_LB: {
        const reg = u32(e[i + 1]), lb = u32(e[i + 2]);
        if (reg === null || lb === null) { I.badField += 1; return; }
        const r = this._reg(reg);
        if (r.hiddenLbs.has(lb)) return;
        r.hiddenLbs.add(lb);
        const tile = tileKeyOfLbKey(lb);
        const keys = this.lbIndex.get(lb);
        if (!keys) return;
        for (const key of keys) {
          const o = this.objects.get(skH(key));
          if (!o || o.kind !== K.POOL || o.reg !== reg) continue;
          const s = o.slots[skI(key)];
          if (!s || !s.active || !s.committed || s.tile !== tile) continue;
          s.vis = false;
        }
        return;
      }
      case OP.POOL_SHOW_LB: {
        const reg = u32(e[i + 1]), lb = u32(e[i + 2]);
        if (reg === null || lb === null) { I.badField += 1; return; }
        const r = this._reg(reg);
        if (!r.hiddenLbs.delete(lb)) return;
        const tile = tileKeyOfLbKey(lb);
        const keys = this.lbIndex.get(lb);
        if (!keys) return;
        for (const key of keys) {
          const h = skH(key);
          const o = this.objects.get(h);
          if (!o || o.kind !== K.POOL || o.reg !== reg) continue;
          const s = o.slots[skI(key)];
          if (!s || !s.active || !s.committed || s.tile !== tile) continue;
          const rec = r.recs.get(`${s.tile}:${h}`);
          if (!rec || !rec.live) continue;
          if (s.hiddenCell) continue;
          s.vis = true;
        }
        return;
      }
      case OP.POOL_CELLSET: {
        const reg = u32(e[i + 1]), tile = u32(e[i + 2]), c = u32(e[i + 3]);
        if (reg === null || tile === null || c === null) { I.badField += 1; return; }
        const want = new Set();
        for (let q = 0; q < c; q++) want.add(e[i + 4 + q]);
        const r = this._reg(reg);
        for (const rec of r.recs.values()) {
          if (rec.tile !== tile) continue;
          for (const s of this._poolSlots(rec.h, tile)) {
            if (s.cell === NONE) continue;
            const w = want.has(s.cell);
            if (w && s.hiddenCell) {
              s.hiddenCell = false;
              if (rec.live && !this._lbHidden(reg, s.lb)) s.vis = true;
            } else if (!w && !s.hiddenCell) {
              s.hiddenCell = true;
              s.vis = false;
            }
          }
        }
        return;
      }
      case OP.POOL_CELLS_VIS: {
        const reg = u32(e[i + 1]), c = u32(e[i + 3]);
        if (reg === null || c === null) { I.badField += 1; return; }
        const visible = e[i + 2] !== 0;
        const r = this._reg(reg);
        for (let q = 0; q < c; q++) {
          const cell = u32(e[i + 4 + q]);
          const keys = cell === null ? null : this.cellIndex.get(cell);
          if (!keys) continue;
          for (const key of keys) {
            const h = skH(key);
            const o = this.objects.get(h);
            if (!o || o.kind !== K.POOL || o.reg !== reg) continue;
            const s = o.slots[skI(key)];
            if (!s || !s.active || !s.committed) continue;
            if (visible && s.hiddenCell) {
              s.hiddenCell = false;
              const rec = r.recs.get(`${s.tile}:${h}`);
              if (rec && rec.live && !this._lbHidden(reg, s.lb)) s.vis = true;
            } else if (!visible && !s.hiddenCell) {
              s.hiddenCell = true;
              s.vis = false;
            }
          }
        }
        return;
      }
      case OP.POOL_RELEASE_CELLS: {
        // The deletes follow as INST_DELs. What is decided HERE is which
        // membership records the release empties (JS prunes them).
        const reg = u32(e[i + 1]), c = u32(e[i + 2]);
        if (reg === null || c === null) { I.badField += 1; return; }
        this.totals.poolReleaseCells += 1;
        const r = this._reg(reg);
        const cells = new Set();
        for (let q = 0; q < c; q++) cells.add(e[i + 3 + q]);
        for (const [rk, rec] of [...r.recs]) {
          let had = 0, total = 0;
          for (const s of this._poolSlots(rec.h, rec.tile)) {
            total += 1;
            if (s.cell !== NONE && cells.has(s.cell)) had += 1;
          }
          if (had > 0 && had === total) r.recs.delete(rk);
        }
        return;
      }
      case OP.POOL_REG_RESET: {
        // PoolRegistry.dispose(): pools, tiles, parked marks and the cell index
        // go; `_hiddenLbs` is NOT cleared there, so it stays here too.
        const reg = u32(e[i + 1]);
        if (reg === null) { I.badField += 1; return; }
        const r = this._reg(reg);
        r.parked.clear();
        r.recs.clear();
        return;
      }
      case OP.LRU_TRACK: {
        const lru = u32(e[i + 1]), lb = u32(e[i + 2]);
        if (lru === null || lb === null) { I.badField += 1; return; }
        const m = this._lru(lru);
        const st = m.get(lb);
        if (e[i + 3] !== 0) {
          if (st !== PARKED) I.trackMergeDesync += 1;
          m.set(lb, PARKED);
        } else {
          if (st === PARKED) I.trackWhileParked += 1;
          m.set(lb, LIVE);
        }
        return;
      }
      case OP.LRU_PARK: {
        const lru = u32(e[i + 1]), lb = u32(e[i + 2]);
        if (lru === null || lb === null) { I.badField += 1; return; }
        const m = this._lru(lru);
        if (m.get(lb) !== LIVE) I.parkDesync += 1;
        m.set(lb, PARKED);
        return;
      }
      case OP.LRU_UNPARK: {
        const lru = u32(e[i + 1]), lb = u32(e[i + 2]);
        if (lru === null || lb === null) { I.badField += 1; return; }
        const m = this._lru(lru);
        if (m.get(lb) !== PARKED) I.unparkDesync += 1;
        m.set(lb, LIVE);
        return;
      }
      case OP.LRU_EVICT: {
        const lru = u32(e[i + 1]), lb = u32(e[i + 2]);
        if (lru === null || lb === null) { I.badField += 1; return; }
        const m = this._lru(lru);
        if (!m.delete(lb)) I.evictUnknown += 1;
        return;
      }
      case OP.LRU_DROP_POOL: {
        const lru = u32(e[i + 1]), lb = u32(e[i + 2]);
        if (lru === null || lb === null) { I.badField += 1; return; }
        this._lru(lru).set(lb, LIVE);
        return;
      }
      case OP.OBJR_HIDE:
      case OP.OBJR_SHOW:
      case OP.OBJR_FORGET: {
        const scene = u32(e[i + 1]), lb = u32(e[i + 2]);
        if (scene === null || lb === null) { I.badField += 1; return; }
        let set = this.objr.get(scene);
        if (!set) { set = new Set(); this.objr.set(scene, set); }
        if (op === OP.OBJR_HIDE) set.add(lb); else set.delete(lb);
        return;
      }
      case OP.TILE_STATE: {
        const grid = u32(e[i + 1]), tile = u32(e[i + 2]), from = u32(e[i + 3]), to = u32(e[i + 4]);
        if (grid === null || tile === null || from === null || to === null) { I.badField += 1; return; }
        let m = this.grids.get(grid);
        if (!m) { m = new Map(); this.grids.set(grid, m); }
        const cur = m.has(tile) ? m.get(tile).state : TS.EMPTY;
        if (cur !== from) I.tileDesync += 1;
        const legal = LEGAL.get(from);
        if (!legal || !legal.has(to)) I.illegalTransition += 1;
        if (to === TS.EMPTY) m.delete(tile);
        else m.set(tile, { state: to, since: e[i + 5], parked: e[i + 6] });
        return;
      }
      case OP.CELL_PVS: {
        const scene = u32(e[i + 1]), a = u32(e[i + 2]);
        if (scene === null || a === null) { I.badField += 1; return; }
        let set = this.cells.get(scene);
        if (!set) { set = new Set(); this.cells.set(scene, set); }
        for (let q = 0; q < a; q++) { const v = u32(e[i + 3 + q]); if (v !== null) set.add(v); }
        const b = e[i + 3 + a];
        for (let q = 0; q < b; q++) { const v = u32(e[i + 4 + a + q]); if (v !== null) set.delete(v); }
        return;
      }
      case OP.MARK:
        this.totals.marks += 1;
        return;
      default:
        return;
    }
  }

  _lru(id) {
    let m = this.lrus.get(id);
    if (!m) { m = new Map(); this.lrus.set(id, m); }
    return m;
  }

  // ── audit ────────────────────────────────────────────────────────────────

  _sample(msg) {
    if (this.last.samples.length < 16) this.last.samples.push(msg);
  }

  _setDiff(cat, a, b, what) {
    let d = 0;
    for (const v of a) if (!b.has(v)) { d += 1; this._sample(`${what}: js has ${v}`); }
    for (const v of b) if (!a.has(v)) { d += 1; this._sample(`${what}: kernel has ${v}`); }
    this.last.cat[cat] += d;
  }

  /** Compare against an audit arena (WORLD_SEC). Returns this audit's mismatches, or -1 (malformed). */
  audit(a) {
    const cat = Object.fromEntries(MISMATCH_KEYS.map((k) => [k, 0]));
    this.last = { mismatches: 0, cat, skipped: 0, andDivergence: 0, samples: [] };
    const seen = new Set();
    let sawObjects = false;
    // poolHideOrphan: every OBJR section's landblocks, and each POOLREG hidden list.
    let sawObjr = false;
    const objrUnion = new Set();
    const poolHidden = [];
    let i = 0;
    const n = a.length;
    const need = (k) => i + k <= n;
    while (i < n) {
      const sec = a[i++];
      if (sec === SEC.END) break;
      if ((sec === SEC.LRU || sec === SEC.GRID || sec === SEC.OBJR || sec === SEC.CELLS || sec === SEC.POOLREG ||
        sec === SEC.POOLRECS || sec === SEC.MATRICES || sec === SEC.RANGES) && !need(2)) return -1;
      if (sec === SEC.OBJECTS) {
        sawObjects = true;
        if (!need(1)) return -1;
        const nObj = u32(a[i++]);
        if (nObj === null) return -1;
        for (let q = 0; q < nObj; q++) {
          if (!need(3)) return -1;
          const h = a[i], mode = a[i + 1], len = u32(a[i + 2]);
          i += 3;
          if (len === null || !need(2 * len)) return -1;
          seen.add(h);
          const o = this.objects.get(h);
          if (!o) { cat.unknownObject += 1; this._sample(`object ${h}: unknown to the kernel`); i += 2 * len; continue; }
          // mode 1: a film take holds it (counted); mode 2: outside this audit's window.
          if (mode !== 0) { if (mode === 1) this.last.skipped += 1; i += 2 * len; continue; }
          const m = Math.max(len, o.slots.length);
          for (let s = 0; s < m; s++) {
            const jf = s < len ? u32(a[i + 2 * s]) : 0;
            const jg = s < len ? a[i + 2 * s + 1] : 0;
            if (jf === null) return -1;
            const jActive = (jf & 1) !== 0;
            const jVis = (jf & 2) !== 0;
            const ks = o.slots[s];
            const kActive = !!(ks && ks.active);
            if (jActive !== kActive) { cat.active += 1; this._sample(`object ${h} slot ${s}: active js ${jActive} kernel ${kActive}`); continue; }
            if (!jActive) continue;
            if (jg !== ks.gid) { cat.gid += 1; this._sample(`object ${h} slot ${s}: gid js ${jg} kernel ${ks.gid}`); }
            if (jVis !== ks.vis) { cat.vis += 1; this._sample(`object ${h} slot ${s}: visible js ${jVis} kernel ${ks.vis}`); }
            if (jVis !== ks.raw) { cat.raw += 1; this._sample(`object ${h} slot ${s}: raw js ${jVis} kernel ${ks.raw}`); }
          }
          if (len !== o.slots.length) { cat.slotsLen += 1; this._sample(`object ${h}: ${len} slots in js, ${o.slots.length} in the kernel`); }
          i += 2 * len;
        }
      } else if (sec === SEC.LRU) {
        if (!need(2)) return -1;
        const id = a[i++];
        const nl = u32(a[i++]);
        if (nl === null || !need(nl + 1)) return -1;
        const live = new Set(a.subarray(i, i + nl)); i += nl;
        const np = u32(a[i++]);
        if (np === null || !need(np)) return -1;
        const parked = new Set(a.subarray(i, i + np)); i += np;
        const m = this.lrus.get(id) || new Map();
        const kl = new Set(), kp = new Set();
        for (const [lb, st] of m) (st === LIVE ? kl : kp).add(lb);
        this._setDiff("lru", live, kl, `lru ${id} live`);
        this._setDiff("lru", parked, kp, `lru ${id} parked`);
      } else if (sec === SEC.GRID) {
        if (!need(2)) return -1;
        const id = a[i++];
        const c = u32(a[i++]);
        if (c === null || !need(4 * c)) return -1;
        const m = this.grids.get(id) || new Map();
        const js = new Set();
        for (let q = 0; q < c; q++) {
          const tile = a[i], st = a[i + 1], since = a[i + 2], parked = a[i + 3];
          i += 4;
          js.add(tile);
          const r = m.get(tile);
          if (!r || r.state !== st) { cat.tileState += 1; this._sample(`grid ${id} tile ${tile}: js ${st} kernel ${r ? r.state : "EMPTY"}`); continue; }
          if (!f64same(r.since, since) || !f64same(r.parked, parked)) { cat.tileTime += 1; this._sample(`grid ${id} tile ${tile}: times differ`); }
        }
        for (const tile of m.keys()) if (!js.has(tile)) { cat.tileState += 1; this._sample(`grid ${id} tile ${tile}: kernel only`); }
      } else if (sec === SEC.OBJR || sec === SEC.CELLS) {
        if (!need(2)) return -1;
        const id = a[i++];
        const c = u32(a[i++]);
        if (c === null || !need(c)) return -1;
        const js = new Set(a.subarray(i, i + c)); i += c;
        if (sec === SEC.OBJR) { sawObjr = true; for (const v of js) objrUnion.add(v); }
        const k = (sec === SEC.OBJR ? this.objr : this.cells).get(id) || new Set();
        this._setDiff(sec === SEC.OBJR ? "objr" : "cells", js, k, sec === SEC.OBJR ? `objRadius ${id}` : `cell pvs ${id}`);
      } else if (sec === SEC.POOLREG) {
        if (!need(2)) return -1;
        const id = a[i++];
        const np = u32(a[i++]);
        if (np === null || !need(np + 1)) return -1;
        const parked = new Set(a.subarray(i, i + np)); i += np;
        const nh = u32(a[i++]);
        if (nh === null || !need(nh)) return -1;
        const hidden = new Set(a.subarray(i, i + nh)); i += nh;
        const r = this.regs.get(id) || { parked: new Set(), hiddenLbs: new Set() };
        this._setDiff("poolReg", parked, r.parked, `pool reg ${id} parked tiles`);
        this._setDiff("poolReg", hidden, r.hiddenLbs, `pool reg ${id} hidden lbs`);
        poolHidden.push([id, hidden]);
      } else if (sec === SEC.POOLRECS) {
        if (!need(2)) return -1;
        const id = a[i++];
        const c = u32(a[i++]);
        if (c === null) return -1;
        const r = this.regs.get(id) || { recs: new Map() };
        const js = new Set();
        for (let q = 0; q < c; q++) {
          if (!need(4)) return -1;
          const tile = a[i], h = a[i + 1], live = a[i + 2] !== 0, nh = u32(a[i + 3]);
          i += 4;
          if (nh === null || !need(nh)) return -1;
          const hid = new Set(a.subarray(i, i + nh)); i += nh;
          const rk = `${tile}:${h}`;
          js.add(rk);
          const rec = r.recs.get(rk);
          if (!rec || rec.live !== live) { cat.poolRec += 1; this._sample(`pool reg ${id} record ${rk}: js live ${live} kernel ${rec ? rec.live : "none"}`); }
          const o = this.objects.get(h);
          const khid = new Set();
          if (o) {
            const keys = this.tileIndex.get(tile);
            if (keys) for (const key of keys) {
              if (skH(key) !== h) continue;
              const s = o.slots[skI(key)];
              if (s && s.active && s.committed && s.hiddenCell) khid.add(skI(key));
            }
          }
          this._setDiff("poolHidden", hid, khid, `pool reg ${id} record ${rk} hidden cells`);
        }
        for (const rk of r.recs.keys()) if (!js.has(rk)) { cat.poolRec += 1; this._sample(`pool reg ${id} record ${rk}: kernel only`); }
      } else if (sec === SEC.MATRICES) {
        if (!need(2)) return -1;
        const h = a[i++];
        const c = u32(a[i++]);
        if (c === null || !need(17 * c)) return -1;
        const o = this.objects.get(h);
        for (let q = 0; q < c; q++) {
          const iid = a[i];
          const s = o ? o.slots[iid] : null;
          let diff = !s || !s.active;
          if (!diff) for (let k = 0; k < 16; k++) if (f32bits(a[i + 1 + k]) !== f32bits(s.m[k])) { diff = true; break; }
          if (diff) { cat.matrix += 1; this._sample(`object ${h} slot ${iid}: matrix differs`); }
          i += 17;
        }
      } else if (sec === SEC.RANGES) {
        if (!need(2)) return -1;
        const h = a[i++];
        const c = u32(a[i++]);
        if (c === null || !need(3 * c)) return -1;
        const o = this.objects.get(h);
        const js = new Set();
        for (let q = 0; q < c; q++) {
          const gid = a[i], start = a[i + 1], count = a[i + 2];
          i += 3;
          js.add(gid);
          const g = o ? o.geoms[gid] : null;
          if (!g || !g.active || g.start !== start || g.count !== count) { cat.ranges += 1; this._sample(`object ${h} gid ${gid}: range differs`); }
        }
        if (o) for (let g = 0; g < o.geoms.length; g++) if (o.geoms[g] && o.geoms[g].active && !js.has(g)) { cat.ranges += 1; this._sample(`object ${h} gid ${g}: kernel only`); }
      } else if (sec === SEC.UNTRACKED) {
        if (!need(1)) return -1;
        const c = u32(a[i++]);
        if (c === null) return -1;
        if (c > 0) { cat.untracked += c; this._sample(`${c} shadow-kind draw objects were never tracked`); }
      } else {
        return -1;
      }
    }
    if (sawObjects) {
      for (const h of this.objects.keys()) if (!seen.has(h)) { cat.missingObject += 1; this._sample(`object ${h}: kernel only`); }
    }
    // The pool registry's landblock hides must be ?objRadius hides (see MISMATCH_KEYS).
    if (sawObjr) {
      for (const [id, hidden] of poolHidden) {
        for (const v of hidden) {
          if (!objrUnion.has(v)) { cat.poolHideOrphan += 1; this._sample(`pool reg ${id} hides landblock ${v}, which no ?objRadius set hides`); }
        }
      }
    }
    let total = 0;
    for (const k of MISMATCH_KEYS) total += cat[k];
    this.last.mismatches = total;
    this.last.andDivergence = this._andDivergence();
    this.totals.audits += 1;
    this.totals.mismatches += total;
    return total;
  }

  // The R2 §2.2 AND form vs the exact model (diagnostic).
  _andDivergence() {
    let d = 0;
    const lruParked = (lb) => { for (const m of this.lrus.values()) if (m.get(lb) === PARKED) return true; return false; };
    const objrHidden = (lb) => { for (const s of this.objr.values()) if (s.has(lb)) return true; return false; };
    for (const o of this.objects.values()) {
      for (const s of o.slots) {
        if (!s || !s.active) continue;
        let want;
        if (o.kind === K.CHUNK || o.kind === K.ATLAS) {
          if (s.lb === NONE) continue;
          want = !(lruParked(s.lb) || objrHidden(s.lb));
        } else if (o.kind === K.POOL) {
          if (s.tile === NONE) continue;
          const r = this.regs.get(o.reg);
          want = s.committed && !(r && r.parked.has(s.tile)) && !this._lbHidden(o.reg, s.lb) && !s.hiddenCell;
        } else {
          want = true;
        }
        if (want !== s.vis) d += 1;
      }
    }
    return d;
  }

  // ── reports ──────────────────────────────────────────────────────────────

  _integrityTotal() {
    let t = 0;
    for (const k of INTEGRITY_KEYS) t += this.integrity[k];
    return t;
  }

  report() {
    return JSON.stringify({
      abi: WORLD_ABI,
      events: this.totals.events,
      batches: this.totals.batches,
      audits: this.totals.audits,
      mismatches: this.totals.mismatches,
      last: this.last,
      andDivergence: this.last.andDivergence,
      integrity: this.integrity,
      integrityTotal: this._integrityTotal(),
    });
  }

  census() {
    const byKind = {};
    let slots = 0, active = 0, visible = 0, attributed = 0, committed = 0, geoms = 0;
    for (const o of this.objects.values()) {
      const k = String(o.kind);
      const b = byKind[k] || (byKind[k] = { objects: 0, slots: 0, active: 0, visible: 0 });
      b.objects += 1;
      b.slots += o.slots.length;
      slots += o.slots.length;
      for (const s of o.slots) {
        if (!s || !s.active) continue;
        active += 1; b.active += 1;
        if (s.vis) { visible += 1; b.visible += 1; }
        if (s.lb !== NONE) attributed += 1;
        if (o.kind === K.POOL && s.committed) committed += 1;
      }
      for (const g of o.geoms) if (g && g.active) geoms += 1;
    }
    let lruLive = 0, lruParked = 0;
    for (const m of this.lrus.values()) for (const st of m.values()) (st === LIVE ? lruLive++ : lruParked++);
    const tiles = {};
    for (const m of this.grids.values()) for (const r of m.values()) tiles[r.state] = (tiles[r.state] || 0) + 1;
    let parkedTiles = 0, hiddenLbs = 0, records = 0;
    for (const r of this.regs.values()) { parkedTiles += r.parked.size; hiddenLbs += r.hiddenLbs.size; records += r.recs.size; }
    let objrHidden = 0;
    for (const s of this.objr.values()) objrHidden += s.size;
    let cells = 0;
    for (const s of this.cells.values()) cells += s.size;
    return JSON.stringify({
      objects: this.objects.size, byKind, slots, active, visible, attributed, committed, geometries: geoms,
      lbIndex: this.lbIndex.size, tileIndex: this.tileIndex.size, cellIndex: this.cellIndex.size,
      lru: { live: lruLive, parked: lruParked }, tiles,
      pools: { regs: this.regs.size, parkedTiles, hiddenLbs, records },
      objrHidden, cells,
    });
  }
}
