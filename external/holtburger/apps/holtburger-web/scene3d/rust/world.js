// scene3d/rust/world.js — lane W bridge: the static world's residency and
// visibility tables mirrored in Rust, SHADOW mode (`?rustWorld`, DEFAULT OFF;
// `=on`/1/true/yes opts in). Stage 2 S0 + S2 of
// docs/2026-10-26-rust-residency-design.md (R2).
//
// Lane notes (what landed, invariants, risks, commands): docs/2026-10-26-rust-world.md.
// Kernel: crates/holtburger-scene/src/world/ (pure Rust). wasm glue:
// src/scene_wasm/world.rs (`SceneWorld`). JS reference model of the same
// kernel (node tests, the fixture generator): tools/rust_parity/gen_world_model.mjs.
//
// NO BEHAVIOUR CHANGE. Shadow mode only WATCHES: the producers post the events
// they already perform (one flag-gated line each:
// `globalThis.__hbRustWorld?.x(...)`, which evaluates nothing when the flag is
// off), the kernel keeps its own tables, and a 1 Hz audit compares the kernel's
// answers with what three.js and the JS residency actually hold.
// `__rustWorld.stats().mismatches` must stay 0.
//
// TWO KINDS OF EVENT.
//   * STRUCTURE — what three's BatchedMesh API did to a tracked draw object:
//     add / delete geometry, add / delete instance, setMatrixAt (the f32 values
//     three stored), setGeometryIdAt, setVisibleAt (recorded RAW, as a
//     diagnostic only), setInstanceCount, optimize, dispose. Captured by a
//     per-object prototype inserted at `track()` (one per original prototype,
//     shared), so EVERY mutation path is mirrored — the atlas alone has six
//     unwind paths — and three's own internal calls (deleteGeometry →
//     deleteInstance) arrive as the individual deletes three performs. An own
//     property would show up in `hasOwnProperty` checks (film's batch watch);
//     the prototype does not.
//   * SEMANTICS — the decisions the kernel must reproduce: which landblock /
//     tile / cell an instance belongs to (attribution), and the residency /
//     visibility events (LRU track / park / unpark / evict, the chunk and atlas
//     per-landblock show / hide seams, the pool registry's commit / park /
//     adopt / release / landblock hides / cell PVS, ?objRadius, grid tile
//     states, the cell PVS delta). The kernel derives every instance's
//     visibility from THESE — never from the raw setVisibleAt stream — and the
//     audit compares the derived value with three's `_instanceInfo`.
//
// The queue is a growable Float64Array of [op, args...] records (layouts:
// WORLD_OP below; the Rust decoder in crates/holtburger-scene/src/world/events.rs
// is the spec's other half). It is flushed to the kernel in ONE call at each
// audit and whenever it passes FLUSH_AT values — event calls, never a call per
// object per frame. Shadow mode has no per-frame call at all.
//
// FILM. A film take that holds a batch hide shadows the mesh's setVisibleAt with
// an own-property watch (film/runtime/take_player.js). Those objects are SKIPPED
// by the audit while held (counted `filmHeld`): film's restore rule ("only if no
// foreign write since") is not a residency fact the kernel can derive.
//
// Kernel lookup: `sceneWasmClass("SceneWorld")`, lazily at the first flush —
// events posted before the pkg booted are buffered (bounded). A missing or stale
// pkg disarms the bridge for the session, warned once; nothing else changes.

import { sceneWasmClass, sceneCoreAvailable, rustFlag } from "./scene_core.js";

/** Version of the event / audit protocol; `SceneWorld.abi()` must match. */
export const WORLD_ABI = 1;

/** Event opcodes. Layout after the opcode, in f64s (`n` = a count). */
export const WORLD_OP = Object.freeze({
  TRACK: 1, //            h, kind, lbKey|-1, reg|-1
  DISPOSE: 2, //          h
  GEOM_ADD: 3, //         h, gid, start, count
  GEOM_DEL: 4, //         h, gid
  GEOM_RANGES: 5, //      h, n, (gid, start, count) x n            (after optimize)
  INST_ADD: 6, //         h, iid, gid
  INST_DEL: 7, //         h, iid
  INST_MATRIX: 8, //      h, iid, m0..m15                           (the f32 three stored)
  INST_GID: 9, //         h, iid, gid                               (setGeometryIdAt)
  INST_VIS_RAW: 10, //    h, iid, visible                           (diagnostic only)
  INST_COUNT: 11, //      h, maxInstanceCount                       (setInstanceCount)
  INST_SNAP: 12, //       h, iid, active, gid, visible              (track of a non-empty object)
  GEOM_SNAP: 13, //       h, gid, active, start, count              (track of a non-empty object)
  ATTR_LB: 20, //         h, iid, lbKey                             (chunk / atlas membership)
  LB_VIS: 21, //          kind, lbKey, visible                      (chunk _setLbVisible, atlas park/unpark)
  POOL_ATTR: 22, //       h, iid, tile, lbKey|-1, cellId|-1         (pool member, born invisible)
  POOL_COMMIT: 23, //     reg, tile, np, (h, n, ids x n) x np
  POOL_PARK: 24, //       reg, tile
  POOL_ADOPT: 25, //      reg, tile
  POOL_CLEAR_PARKED: 26, // reg, tile
  POOL_RELEASE: 27, //    reg, tile
  POOL_HIDE_LB: 28, //    reg, lbKey
  POOL_SHOW_LB: 29, //    reg, lbKey
  POOL_CELLSET: 30, //    reg, tile, n, cellIds x n                 (cellSetChanged's render set)
  POOL_CELLS_VIS: 31, //  reg, visible, n, cellIds x n              (setCellsVisible)
  POOL_RELEASE_CELLS: 32, // reg, n, cellIds x n
  POOL_REG_RESET: 33, //  reg                                       (registry dispose: parked tiles + records go)
  LRU_TRACK: 40, //       lru, lbKey, mergedIntoParked
  LRU_PARK: 41, //        lru, lbKey
  LRU_UNPARK: 42, //      lru, lbKey
  LRU_EVICT: 43, //       lru, lbKey
  LRU_DROP_POOL: 44, //   lru, lbKey                                (stale pool copy of a resident LB dropped)
  OBJR_HIDE: 50, //       scene, lbKey
  OBJR_SHOW: 51, //       scene, lbKey
  OBJR_FORGET: 52, //     scene, lbKey
  TILE_STATE: 60, //      grid, tile, from, to, sinceMs, parkedAtMs
  CELL_PVS: 70, //        scene, nIn, cellIds x nIn, nOut, cellIds x nOut
  MARK: 99, //            seq                                       (recorder checkpoint; no-op)
});

/** Draw-object kinds. */
export const WORLD_KIND = Object.freeze({ OTHER: 0, CHUNK: 1, ATLAS: 2, POOL: 3, BUILDING: 4 });
const KIND_BY_NAME = { chunk: 1, atlas: 2, pool: 3, building: 4 };

/** Audit arena sections (all f64; a section starts with its code, 0 ends the arena). */
export const WORLD_SEC = Object.freeze({
  END: 0,
  OBJECTS: 1, //   nObj, (h, mode 0 full | 1 skipped (film) | 2 deferred (not this window), len, (flags bit0 active | bit1 visible, gid) x len) x nObj
  LRU: 2, //       lru, nLive, lbKeys, nParked, lbKeys
  GRID: 3, //      grid, n, (tile, state, sinceMs, parkedAtMs) x n
  OBJR: 4, //      scene, n, lbKeys
  CELLS: 5, //     scene, n, cellIds
  POOLREG: 6, //   reg, nParkedTiles, tiles, nHiddenLbs, lbKeys
  MATRICES: 7, //  h, n, (iid, m0..m15) x n
  RANGES: 8, //    h, n, (gid, start, count) x n
  POOLRECS: 9, //  reg, n, (tile, h, live, nHiddenCellIds, iids) x n
  UNTRACKED: 10, // n — chunk / atlas / pool / building BatchedMeshes in the scene the bridge never tracked
});

/** SlotGrid states as numbers (residency_grid.js SLOT_STATE). */
export const WORLD_TILE_STATE = Object.freeze({ EMPTY: 0, FETCHING: 1, STAGED: 2, LIVE: 3, PARKED: 4, QUARANTINED: 5 });

/** "None" in an event slot that may be absent (lbKey, cellId, reg). */
export const WORLD_NONE = -1;

const OP = WORLD_OP;
const SEC = WORLD_SEC;
const FLUSH_AT = 1 << 16; // f64s queued before an early flush (512 KB)
const MAX_UNRESOLVED = 1 << 22; // f64s buffered while the pkg has not booted (32 MB) — then disarm
const AUDIT_EVERY_MS = 1000;
const MATRIX_AUDIT_EVERY = 10; // every Nth periodic audit also compares matrices + ranges
// A periodic audit compares the instance tables of a rotating window of objects
// holding at most this many slots (the next window starts where this one
// stopped, so every object is covered within a few seconds); the residency
// sections are complete every time. An explicit `audit()` compares everything.
const AUDIT_WINDOW_SLOTS = 4096;

let _flag = null;
/** `?rustWorld` (read once; `__setRustWorldFlagForTest` overrides). */
export function rustWorldEnabled() {
  if (_flag === null) _flag = rustFlag("rustWorld", false);
  return _flag;
}
/** Test seam: true / false forces the flag; null re-reads it. */
export function __setRustWorldFlagForTest(v) {
  _flag = v === null || v === undefined ? null : !!v;
}

function _stateCode(s) {
  const c = WORLD_TILE_STATE[s];
  return c === undefined ? -2 : c;
}

// ---------------------------------------------------------------------------
// The structural mirror: one wrapped prototype per original prototype.
// ---------------------------------------------------------------------------

const _wrappedProtos = new WeakMap(); // original prototype -> wrapped prototype

function _wrappedProtoFor(base) {
  let P = _wrappedProtos.get(base);
  if (P) return P;
  P = Object.create(base);
  // Every wrapper calls the ORIGINAL first and posts only on success (a three
  // throw — capacity, an invalid id — leaves nothing to mirror). The bridge is
  // looked up per call, so objects outlive re-arms (tests) harmlessly.
  P.addGeometry = function (geometry, reservedVertexCount, reservedIndexCount) {
    const gid = base.addGeometry.call(this, geometry, reservedVertexCount, reservedIndexCount);
    const b = globalThis.__hbRustWorld;
    if (b) b._onGeomAdd(this, gid);
    return gid;
  };
  P.deleteGeometry = function (geometryId) {
    const info = this._geometryInfo;
    const live = !!(info && geometryId >= 0 && geometryId < info.length && info[geometryId] && info[geometryId].active);
    const r = base.deleteGeometry.call(this, geometryId);
    if (live) {
      const b = globalThis.__hbRustWorld;
      if (b) b._onGeomDel(this, geometryId);
    }
    return r;
  };
  P.addInstance = function (geometryId) {
    const iid = base.addInstance.call(this, geometryId);
    const b = globalThis.__hbRustWorld;
    if (b) b._onInstAdd(this, iid, geometryId);
    return iid;
  };
  P.deleteInstance = function (instanceId) {
    const r = base.deleteInstance.call(this, instanceId);
    const b = globalThis.__hbRustWorld;
    if (b) b._onInstDel(this, instanceId);
    return r;
  };
  P.setMatrixAt = function (instanceId, matrix) {
    const r = base.setMatrixAt.call(this, instanceId, matrix);
    const b = globalThis.__hbRustWorld;
    if (b) b._onMatrix(this, instanceId);
    return r;
  };
  P.setGeometryIdAt = function (instanceId, geometryId) {
    const r = base.setGeometryIdAt.call(this, instanceId, geometryId);
    const b = globalThis.__hbRustWorld;
    if (b) b._onGid(this, instanceId, geometryId);
    return r;
  };
  P.setVisibleAt = function (instanceId, visible) {
    const r = base.setVisibleAt.call(this, instanceId, visible);
    const b = globalThis.__hbRustWorld;
    if (b) b._onVis(this, instanceId, visible);
    return r;
  };
  P.setInstanceCount = function (maxInstanceCount) {
    const r = base.setInstanceCount.call(this, maxInstanceCount);
    const b = globalThis.__hbRustWorld;
    if (b) b._onCount(this, maxInstanceCount);
    return r;
  };
  P.optimize = function () {
    const r = base.optimize.call(this);
    const b = globalThis.__hbRustWorld;
    if (b) b._onOptimize(this);
    return r;
  };
  P.dispose = function () {
    const r = base.dispose.call(this);
    const b = globalThis.__hbRustWorld;
    if (b) b._onDispose(this);
    return r;
  };
  Object.defineProperty(P, "__hbRustWorldProto", { value: base });
  _wrappedProtos.set(base, P);
  return P;
}

// The userData markers of the four batch kinds the shadow tracks.
function _isShadowKind(o) {
  const ud = o && o.isBatchedMesh ? o.userData : null;
  return !!ud && (ud.__staticBatchCrossLb === true || ud.__statAtlasCrossLb === true ||
    ud.__drawPool === true || ud.__buildingBatch === true);
}

function _isWrapped(bm) {
  const p = Object.getPrototypeOf(bm);
  return !!(p && Object.prototype.hasOwnProperty.call(p, "__hbRustWorldProto"));
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

class RustWorldBridge {
  /**
   * @param {object} [opts]
   * @param {object|null} [opts.kernel]  a kernel with apply / audit / report /
   *   census (tests: the JS model or a compiled SceneWorld). Omitted ⇒ the
   *   pkg's SceneWorld, resolved lazily.
   * @param {boolean} [opts.record]  keep a copy of every event (fixtures).
   */
  constructor({ kernel = null, record = false } = {}) {
    this._kernel = kernel;
    this._kernelState = kernel ? 1 : 0; // 0 unresolved, 1 ready, 2 unavailable
    this._auto = !kernel;
    this._q = new Float64Array(4096);
    this._n = 0;
    this._flushAt = FLUSH_AT; // moves up while the pkg has not booted (no retry per event)
    this._rec = record ? [] : null;
    this._handles = new WeakMap(); // draw object -> handle
    this._objs = new Map(); // handle -> { ref, kind }
    this._nextHandle = 1;
    this._ownerIds = new WeakMap(); // lru / grid / registry / scene3d -> id
    this._owners = new Map(); // id -> { ref, type, objr, cells }
    this._nextOwner = 1;
    this._armed = true;
    this._timer = null;
    this._audits = 0;
    this._auditCursor = 0;
    this.stats = {
      events: 0, flushes: 0, tracked: 0, disposed: 0, collected: 0, disposedUnseen: 0,
      audits: 0, mismatches: 0, lastMismatches: 0, filmHeld: 0,
      integrity: 0, andDivergence: 0,
      // The last audit's `poolHideOrphan` category (pool-registry landblock
      // hides no ?objRadius set holds; also inside `mismatches`). -1: the
      // kernel's report has no such category (a pkg built before 2026-10-29).
      poolHideOrphan: 0,
      hookErrors: 0, kernelErrors: 0, opaqueIterables: 0, untrackedPosts: 0,
      lastError: null,
    };
  }

  // ── queue ────────────────────────────────────────────────────────────────

  _reserve(k) {
    const need = this._n + k;
    if (need <= this._q.length) return;
    let cap = this._q.length * 2;
    while (cap < need) cap *= 2;
    const q = new Float64Array(cap);
    q.set(this._q.subarray(0, this._n));
    this._q = q;
  }

  /** Append a prebuilt record (a Float64Array of exactly its length). */
  _post(arr) {
    const len = arr.length;
    this._reserve(len);
    this._q.set(arr, this._n);
    this._n += len;
    this.stats.events += 1;
    if (this._n >= this._flushAt) this.flush();
  }

  // Small fixed records are written straight into the queue (no allocation).
  _p(a, b, c, d, e, f, g) {
    const n = arguments.length;
    this._reserve(n);
    const q = this._q;
    const o = this._n;
    q[o] = a;
    if (n > 1) q[o + 1] = b;
    if (n > 2) q[o + 2] = c;
    if (n > 3) q[o + 3] = d;
    if (n > 4) q[o + 4] = e;
    if (n > 5) q[o + 5] = f;
    if (n > 6) q[o + 6] = g;
    this._n = o + n;
    this.stats.events += 1;
    if (this._n >= this._flushAt) this.flush();
  }

  _fail(err) {
    this.stats.hookErrors += 1;
    if (!this.stats.lastError) this.stats.lastError = String(err && err.message ? err.message : err);
  }

  // ── ids ──────────────────────────────────────────────────────────────────

  _ownerId(o, type) {
    if (!o || (typeof o !== "object" && typeof o !== "function")) return WORLD_NONE;
    let id = this._ownerIds.get(o);
    if (id === undefined) {
      id = this._nextOwner++;
      this._ownerIds.set(o, id);
      this._owners.set(id, { ref: new WeakRef(o), type, objr: false, cells: false });
    }
    return id;
  }

  _h(bm) {
    const h = bm ? this._handles.get(bm) : undefined;
    return h === undefined ? 0 : h;
  }

  // ── structure (called by the wrapped prototype) ─────────────────────────

  /**
   * Start mirroring a draw object. `kind`: "chunk" | "atlas" | "pool" |
   * "building". `lbKey`: a building batch's landblock. `reg`: a pool's
   * PoolRegistry. Call right after construction (an already-populated object
   * is snapshotted).
   */
  track(bm, kind, lbKey, reg) {
    if (!this._armed || !bm) return;
    try {
      if (this._handles.has(bm)) return;
      if (typeof bm.addInstance !== "function" || !Array.isArray(bm._instanceInfo)) return;
      if (!_isWrapped(bm)) Object.setPrototypeOf(bm, _wrappedProtoFor(Object.getPrototypeOf(bm)));
      const h = this._nextHandle++;
      this._handles.set(bm, h);
      const k = KIND_BY_NAME[kind] || 0;
      this._objs.set(h, { ref: new WeakRef(bm), kind: k });
      this.stats.tracked += 1;
      const lb = lbKey == null ? WORLD_NONE : ((lbKey >>> 0) & 0xffff0000) >>> 0;
      const rid = reg ? this._ownerId(reg, "poolreg") : WORLD_NONE;
      this._p(OP.TRACK, h, k, lb, rid);
      // Late track (normally empty): snapshot geometry and instance tables so
      // the kernel's free lists equal three's.
      const gi = bm._geometryInfo;
      if (Array.isArray(gi)) {
        for (let g = 0; g < gi.length; g++) {
          const x = gi[g];
          this._p(OP.GEOM_SNAP, h, g, x && x.active ? 1 : 0, x ? x.start : 0, x ? x.count : 0);
        }
      }
      const info = bm._instanceInfo;
      for (let i = 0; i < info.length; i++) {
        const x = info[i];
        this._p(OP.INST_SNAP, h, i, x.active ? 1 : 0, x.geometryIndex, x.visible ? 1 : 0);
        if (x.active) this._onMatrix(bm, i);
      }
    } catch (e) { this._fail(e); }
  }

  _onGeomAdd(bm, gid) {
    const h = this._h(bm);
    if (!h) return;
    try {
      const x = bm._geometryInfo[gid];
      this._p(OP.GEOM_ADD, h, gid, x ? x.start : 0, x ? x.count : 0);
    } catch (e) { this._fail(e); }
  }

  _onGeomDel(bm, gid) {
    const h = this._h(bm);
    if (h) this._p(OP.GEOM_DEL, h, gid);
  }

  _onInstAdd(bm, iid, gid) {
    const h = this._h(bm);
    if (h) this._p(OP.INST_ADD, h, iid, gid);
  }

  _onInstDel(bm, iid) {
    const h = this._h(bm);
    if (h) this._p(OP.INST_DEL, h, iid);
  }

  _onMatrix(bm, iid) {
    const h = this._h(bm);
    if (!h) return;
    try {
      const d = bm._matricesTexture.image.data;
      const s = this._mscratch || (this._mscratch = new Float64Array(19));
      s[0] = OP.INST_MATRIX; s[1] = h; s[2] = iid;
      const o = iid * 16;
      for (let k = 0; k < 16; k++) s[3 + k] = d[o + k];
      this._post(s);
    } catch (e) { this._fail(e); }
  }

  _onGid(bm, iid, gid) {
    const h = this._h(bm);
    if (h) this._p(OP.INST_GID, h, iid, gid);
  }

  _onVis(bm, iid, visible) {
    const h = this._h(bm);
    if (h) this._p(OP.INST_VIS_RAW, h, iid, visible ? 1 : 0);
  }

  _onCount(bm, max) {
    const h = this._h(bm);
    if (h) this._p(OP.INST_COUNT, h, max);
  }

  _onOptimize(bm) {
    const h = this._h(bm);
    if (!h) return;
    try {
      const gi = bm._geometryInfo;
      const live = [];
      for (let g = 0; g < gi.length; g++) if (gi[g] && gi[g].active) live.push(g, gi[g].start, gi[g].count);
      const rec = new Float64Array(3 + live.length);
      rec[0] = OP.GEOM_RANGES; rec[1] = h; rec[2] = live.length / 3;
      rec.set(live, 3);
      this._post(rec);
    } catch (e) { this._fail(e); }
  }

  _onDispose(bm) {
    const h = this._h(bm);
    if (!h) return;
    this._handles.delete(bm);
    this._objs.delete(h);
    this.stats.disposed += 1;
    this._p(OP.DISPOSE, h);
  }

  // ── semantics: chunk / atlas ─────────────────────────────────────────────

  // Membership keys travel EXACTLY as the JS indexes them (the chunk seam masks
  // its argument with `_lbKeyOfId`, the atlas seam looks up `lbKey >>> 0`
  // unmasked), so a caller passing a full landblock id misses in both.

  /** A chunk / atlas instance joined the membership keyed `lbKey`. */
  attrLb(bm, iid, lbKey) {
    if (!this._armed) return;
    const h = this._h(bm);
    if (!h) { this.stats.untrackedPosts += 1; return; }
    this._p(OP.ATTR_LB, h, iid, lbKey >>> 0);
  }

  /** `_setLbVisible` (chunk) / `parkStaticAtlasForLb` / `unparkStaticAtlasForLb` (atlas). */
  lbVis(kind, lbKey, visible) {
    if (!this._armed) return;
    this._p(OP.LB_VIS, KIND_BY_NAME[kind] || 0, lbKey >>> 0, visible ? 1 : 0);
  }

  // ── semantics: pools (pool_registry.js; hooks sit at each method's entry) ─

  /** `_feedMember`: a pool instance was added, born invisible, uncommitted. */
  poolAttr(bm, iid, tileKey, lbKey, cellId) {
    if (!this._armed) return;
    const h = this._h(bm);
    if (!h) { this.stats.untrackedPosts += 1; return; }
    this._p(OP.POOL_ATTR, h, iid, tileKey >>> 0,
      lbKey == null ? WORLD_NONE : lbKey >>> 0, cellId == null ? WORLD_NONE : cellId >>> 0);
  }

  /** `beginFeed().commit()`: `touched` is the job's poolKey -> membership map. */
  poolCommit(reg, tileKey, touched) {
    if (!this._armed) return;
    try {
      const parts = [];
      let np = 0;
      for (const mem of touched.values()) {
        const h = this._h(mem && mem.pool && mem.pool.mesh);
        if (!h) { this.stats.untrackedPosts += 1; continue; }
        const ids = mem.instanceIds || [];
        parts.push(h, ids.length);
        for (const id of ids) parts.push(id);
        np += 1;
      }
      const rec = new Float64Array(4 + parts.length);
      rec[0] = OP.POOL_COMMIT; rec[1] = this._ownerId(reg, "poolreg"); rec[2] = tileKey >>> 0; rec[3] = np;
      rec.set(parts, 4);
      this._post(rec);
    } catch (e) { this._fail(e); }
  }

  poolPark(reg, tileKey) { if (this._armed) this._p(OP.POOL_PARK, this._ownerId(reg, "poolreg"), tileKey >>> 0); }
  poolAdopt(reg, tileKey) { if (this._armed) this._p(OP.POOL_ADOPT, this._ownerId(reg, "poolreg"), tileKey >>> 0); }
  poolClearParked(reg, tileKey) { if (this._armed) this._p(OP.POOL_CLEAR_PARKED, this._ownerId(reg, "poolreg"), tileKey >>> 0); }
  poolRelease(reg, tileKey) { if (this._armed) this._p(OP.POOL_RELEASE, this._ownerId(reg, "poolreg"), tileKey >>> 0); }
  poolHideLb(reg, lbKey) { if (this._armed) this._p(OP.POOL_HIDE_LB, this._ownerId(reg, "poolreg"), lbKey >>> 0); }
  poolShowLb(reg, lbKey) { if (this._armed) this._p(OP.POOL_SHOW_LB, this._ownerId(reg, "poolreg"), lbKey >>> 0); }
  /** `PoolRegistry.dispose()` (its pools' disposes arrive as structure events). */
  poolRegReset(reg) { if (this._armed) this._p(OP.POOL_REG_RESET, this._ownerId(reg, "poolreg")); }

  // A cell list is read only when it is an Array or a Set: a one-shot iterator
  // would be consumed here and starve the registry. Anything else is counted
  // (and the audit then shows the gap) instead.
  _ids(it) {
    if (Array.isArray(it)) return it;
    if (it instanceof Set) return [...it];
    this.stats.opaqueIterables += 1;
    return null;
  }

  /** `cellSetChanged(tileKey, renderSet)` (a Set of cellIds that should show). */
  poolCellSet(reg, tileKey, renderSet) {
    if (!this._armed) return;
    try {
      const ids = this._ids(renderSet);
      if (!ids) return;
      const rec = new Float64Array(4 + ids.length);
      rec[0] = OP.POOL_CELLSET; rec[1] = this._ownerId(reg, "poolreg"); rec[2] = tileKey >>> 0; rec[3] = ids.length;
      for (let i = 0; i < ids.length; i++) rec[4 + i] = ids[i] >>> 0;
      this._post(rec);
    } catch (e) { this._fail(e); }
  }

  /** `setCellsVisible(cellIds, visible)`. */
  poolCellsVisible(reg, cellIds, visible) {
    if (!this._armed) return;
    try {
      const ids = this._ids(cellIds);
      if (!ids) return;
      const rec = new Float64Array(4 + ids.length);
      rec[0] = OP.POOL_CELLS_VIS; rec[1] = this._ownerId(reg, "poolreg"); rec[2] = visible ? 1 : 0; rec[3] = ids.length;
      for (let i = 0; i < ids.length; i++) rec[4 + i] = ids[i] >>> 0;
      this._post(rec);
    } catch (e) { this._fail(e); }
  }

  /** `releaseCells(cellIds)` (its deletes arrive as structure events). */
  poolReleaseCells(reg, cellIds) {
    if (!this._armed) return;
    try {
      const ids = this._ids(cellIds);
      if (!ids) return;
      const rec = new Float64Array(3 + ids.length);
      rec[0] = OP.POOL_RELEASE_CELLS; rec[1] = this._ownerId(reg, "poolreg"); rec[2] = ids.length;
      for (let i = 0; i < ids.length; i++) rec[3 + i] = ids[i] >>> 0;
      this._post(rec);
    } catch (e) { this._fail(e); }
  }

  // ── owners: registered at construction, so the audit covers each one even
  //    before (or without) its first event — a missing event hook then shows
  //    up as a mismatch instead of an owner the audit never looks at ────────

  ownerLru(lru) {
    if (!this._armed) return;
    this._ownerId(lru, "lru");
    if (lru && lru.scene3d) this._ownerId(lru.scene3d, "scene");
  }
  ownerGrid(grid) { if (this._armed) this._ownerId(grid, "grid"); }
  ownerPoolReg(reg) { if (this._armed) this._ownerId(reg, "poolreg"); }

  // ── semantics: the legacy LRU (landblock_lru.js) ─────────────────────────

  lruTrack(lru, lbKey, merged) { if (this._armed) this._p(OP.LRU_TRACK, this._lruId(lru), lbKey >>> 0, merged ? 1 : 0); }
  lruPark(lru, lbKey) { if (this._armed) this._p(OP.LRU_PARK, this._lruId(lru), lbKey >>> 0); }
  lruUnpark(lru, lbKey) { if (this._armed) this._p(OP.LRU_UNPARK, this._lruId(lru), lbKey >>> 0); }
  lruEvict(lru, lbKey) { if (this._armed) this._p(OP.LRU_EVICT, this._lruId(lru), lbKey >>> 0); }
  lruDropPool(lru, lbKey) { if (this._armed) this._p(OP.LRU_DROP_POOL, this._lruId(lru), lbKey >>> 0); }

  _lruId(lru) {
    const id = this._ownerId(lru, "lru");
    if (lru && lru.scene3d) this._ownerId(lru.scene3d, "scene");
    return id;
  }

  // ── semantics: ?objRadius (object_radius.js) ─────────────────────────────

  _scene(scene3d, what) {
    const id = this._ownerId(scene3d, "scene");
    const o = this._owners.get(id);
    if (o) o[what] = true;
    return id;
  }
  objrHide(scene3d, lbKey) { if (this._armed) this._p(OP.OBJR_HIDE, this._scene(scene3d, "objr"), lbKey >>> 0); }
  objrShow(scene3d, lbKey) { if (this._armed) this._p(OP.OBJR_SHOW, this._scene(scene3d, "objr"), lbKey >>> 0); }
  objrForget(scene3d, lbKey) { if (this._armed) this._p(OP.OBJR_FORGET, this._scene(scene3d, "objr"), lbKey >>> 0); }

  // ── semantics: the slot grid (residency_grid.js SlotGrid.setState) ───────

  tileState(grid, tile, from, to, rec) {
    if (!this._armed) return;
    this._p(OP.TILE_STATE, this._ownerId(grid, "grid"), tile >>> 0, _stateCode(from), _stateCode(to),
      rec ? rec.sinceMs : 0, rec ? rec.parkedAtMs : 0);
  }

  // ── semantics: the cell PVS delta (cells.js tickCellVisibility3D) ────────

  /** Called before `lastVisible` rolls forward to `visibleSet`. */
  cellPvs(scene3d, visibleSet, lastVisible) {
    if (!this._armed) return;
    try {
      let nIn = 0, nOut = 0;
      for (const id of visibleSet) if (!lastVisible.has(id)) nIn += 1;
      for (const id of lastVisible) if (!visibleSet.has(id)) nOut += 1;
      if (nIn === 0 && nOut === 0) return;
      const rec = new Float64Array(4 + nIn + nOut);
      rec[0] = OP.CELL_PVS; rec[1] = this._scene(scene3d, "cells"); rec[2] = nIn;
      let k = 3;
      for (const id of visibleSet) if (!lastVisible.has(id)) rec[k++] = id >>> 0;
      rec[k++] = nOut;
      for (const id of lastVisible) if (!visibleSet.has(id)) rec[k++] = id >>> 0;
      this._post(rec);
    } catch (e) { this._fail(e); }
  }

  /** Recorder checkpoint (no-op in the kernel). */
  mark(seq) { if (this._armed) this._p(OP.MARK, seq); }

  // ── kernel ───────────────────────────────────────────────────────────────

  _resolveKernel() {
    if (this._kernelState !== 0) return this._kernel;
    if (!this._auto) return this._kernel;
    const C = sceneWasmClass("SceneWorld");
    if (C) {
      try {
        const k = new C();
        // Read once: wasm-bindgen's glue throws on any call after free()
        // (2026-10-29: the warning used to re-read it and lost the ABI text).
        const abi = k.abi() >>> 0;
        if (abi === WORLD_ABI) {
          this._kernel = k;
          this._kernelState = 1;
          return k;
        }
        try { k.free?.(); } catch (_) {}
        this._unavailable(`SceneWorld abi ${abi} vs ${WORLD_ABI} (stale pkg?)`);
      } catch (e) {
        this._unavailable(`SceneWorld unavailable: ${String(e && e.message || e)}`);
      }
      return null;
    }
    // A booted pkg without the class (or a stale one): final. Not booted yet:
    // keep buffering (bounded by MAX_UNRESOLVED in flush).
    if (globalThis.__hbSceneWasm || sceneCoreAvailable()) this._unavailable("the wasm pkg has no SceneWorld (predates lane W)");
    return null;
  }

  _unavailable(why) {
    this._kernelState = 2;
    this._kernel = null;
    // eslint-disable-next-line no-console
    try { console.warn(`[rustWorld] ${why}; shadow mode disarmed (nothing else changes).`); } catch (_) {}
    disarmRustWorld();
  }

  /** Hand every queued event to the kernel (one call). Returns events applied, 0 while buffering, or -1. */
  flush() {
    if (this._n === 0) return 0;
    const k = this._resolveKernel();
    if (!k && this._kernelState === 0) {
      // The pkg has not booted yet: keep buffering, retry after another FLUSH_AT.
      if (this._n < MAX_UNRESOLVED) { this._flushAt = this._n + FLUSH_AT; return 0; }
      this._unavailable("the wasm pkg never booted while events piled up");
    }
    const view = this._q.subarray(0, this._n);
    if (this._rec) this._rec.push(Float64Array.from(view));
    let applied = -1;
    if (k) {
      try {
        applied = k.apply(view);
      } catch (e) {
        this.stats.kernelErrors += 1;
        this.stats.lastError = this.stats.lastError || String(e && e.message || e);
      }
    }
    this._n = 0;
    this._flushAt = FLUSH_AT;
    this.stats.flushes += 1;
    if (k && typeof applied === "number" && applied < 0) {
      this.stats.kernelErrors += 1;
      this.stats.lastError = this.stats.lastError || "kernel refused an event batch (decode error)";
    }
    return applied;
  }

  /** The recorded stream (record mode): every event so far, in post order. */
  recorded() {
    if (!this._rec) return null;
    const parts = this._n > 0 ? [...this._rec, this._q.subarray(0, this._n)] : this._rec;
    let len = 0;
    for (const c of parts) len += c.length;
    const out = new Float64Array(len);
    let o = 0;
    for (const c of parts) { out.set(c, o); o += c.length; }
    return out;
  }

  // ── audit ────────────────────────────────────────────────────────────────

  /**
   * Build the audit arena from what three.js and the JS residency hold right
   * now (WORLD_SEC layout). `matrices`: add the per-instance matrices and the
   * geometry ranges (heavier; tests and every Nth periodic audit).
   */
  buildAuditArena({ matrices = false, windowSlots = 0 } = {}) {
    const out = [];
    // Objects: collected ones leave first (posted, so the kernel drops them).
    const live = [];
    let disposedUnseen = 0;
    for (const [h, rec] of this._objs) {
      const bm = rec.ref.deref();
      if (!bm) {
        this._objs.delete(h);
        this.stats.collected += 1;
        this._p(OP.DISPOSE, h);
        continue;
      }
      // three's dispose() nulls the matrices texture. Disposed without our
      // event (a missed dispose path): not listed, so the kernel reports it
      // missing — never healed here.
      if (bm._matricesTexture === null) { disposedUnseen += 1; continue; }
      live.push([h, bm]);
    }
    this.stats.disposedUnseen = disposedUnseen;
    // The window (periodic audits): objects from the cursor on until the slot
    // budget is spent; the rest are listed `deferred` (mode 2), so the kernel
    // neither compares them nor reports them missing.
    let inWindow = null;
    if (windowSlots > 0 && live.length > 0) {
      inWindow = new Set();
      const start = this._auditCursor % live.length;
      let slots = 0;
      for (let k = 0; k < live.length; k++) {
        const [h, bm] = live[(start + k) % live.length];
        if (k > 0 && slots + bm._instanceInfo.length > windowSlots) { this._auditCursor = start + k; break; }
        inWindow.add(h);
        slots += bm._instanceInfo.length;
        if (k === live.length - 1) this._auditCursor = start + k + 1;
      }
    }
    out.push(SEC.OBJECTS, live.length);
    let filmHeld = 0;
    for (const [h, bm] of live) {
      if (inWindow && !inWindow.has(h)) { out.push(h, 2, 0); continue; }
      // Film's batch watch is an OWN setVisibleAt over our prototype's.
      if (Object.prototype.hasOwnProperty.call(bm, "setVisibleAt")) {
        out.push(h, 1, 0);
        filmHeld += 1;
        continue;
      }
      const info = bm._instanceInfo;
      out.push(h, 0, info.length);
      for (let i = 0; i < info.length; i++) {
        const x = info[i];
        out.push((x.active ? 1 : 0) | (x.visible ? 2 : 0), x.geometryIndex);
      }
    }
    this.stats.filmHeld = filmHeld;
    if (typeof window !== "undefined" && window && window.liveScene3d) this._ownerId(window.liveScene3d, "scene");
    for (const [id, o] of this._owners) {
      const obj = o.ref.deref();
      if (!obj) continue;
      if (o.type === "lru" && obj.entries instanceof Map && obj.parkPool instanceof Map) {
        out.push(SEC.LRU, id, obj.entries.size, ...obj.entries.keys(), obj.parkPool.size, ...obj.parkPool.keys());
      } else if (o.type === "grid" && obj.records instanceof Map) {
        out.push(SEC.GRID, id, obj.records.size);
        for (const [tile, r] of obj.records) out.push(tile, _stateCode(r.state), r.sinceMs, r.parkedAtMs);
      } else if (o.type === "poolreg") {
        const pt = obj._parkedTiles instanceof Set ? obj._parkedTiles : new Set();
        const hl = obj._hiddenLbs instanceof Set ? obj._hiddenLbs : new Set();
        out.push(SEC.POOLREG, id, pt.size, ...pt, hl.size, ...hl);
        if (obj.tiles instanceof Map) {
          const recs = [];
          let n = 0;
          for (const [tile, byTile] of obj.tiles) {
            for (const mem of byTile.values()) {
              const h = this._h(mem && mem.pool && mem.pool.mesh);
              if (!h) continue;
              const hid = mem.hiddenCells ? [...mem.hiddenCells] : [];
              recs.push(tile, h, mem.live ? 1 : 0, hid.length, ...hid);
              n += 1;
            }
          }
          out.push(SEC.POOLRECS, id, n, ...recs);
        }
      } else if (o.type === "scene") {
        // Every known scene (the LRU's, liveScene3d, any that posted): its
        // ?objRadius set and cell render set, when it has them.
        const hidObj = obj._objRadius && obj._objRadius.hidden instanceof Set ? obj._objRadius.hidden : null;
        if (o.objr || hidObj) {
          const hid = hidObj || new Set();
          out.push(SEC.OBJR, id, hid.size, ...hid);
        }
        const csObj = obj._lastCellVisibleSet instanceof Set ? obj._lastCellVisibleSet : null;
        if (o.cells || csObj) {
          const cs = csObj || new Set();
          out.push(SEC.CELLS, id, cs.size, ...cs);
        }
      }
    }
    // Coverage: a draw object of a shadowed kind the bridge never saw (a missing
    // `track` hook) is invisible to every comparison above, so it is counted.
    out.push(SEC.UNTRACKED, this._countUntracked());
    if (matrices) {
      for (const [h, bm] of live) {
        if (inWindow && !inWindow.has(h)) continue;
        const info = bm._instanceInfo;
        const d = bm._matricesTexture && bm._matricesTexture.image ? bm._matricesTexture.image.data : null;
        if (!d) continue;
        let n = 0;
        for (let i = 0; i < info.length; i++) if (info[i].active) n += 1;
        out.push(SEC.MATRICES, h, n);
        for (let i = 0; i < info.length; i++) {
          if (!info[i].active) continue;
          out.push(i);
          for (let k = 0; k < 16; k++) out.push(d[i * 16 + k]);
        }
        const gi = bm._geometryInfo || [];
        let ng = 0;
        for (const g of gi) if (g && g.active) ng += 1;
        out.push(SEC.RANGES, h, ng);
        for (let g = 0; g < gi.length; g++) if (gi[g] && gi[g].active) out.push(g, gi[g].start, gi[g].count);
      }
    }
    out.push(SEC.END);
    return Float64Array.from(out);
  }

  _countUntracked() {
    const scenes = new Set();
    const seen = new Set();
    let n = 0;
    const visit = (o) => {
      if (seen.has(o)) return;
      seen.add(o);
      if (_isShadowKind(o) && !this._handles.has(o)) n += 1;
    };
    for (const o of this._owners.values()) {
      const obj = o.ref.deref();
      if (!obj) continue;
      if (o.type === "lru" && obj.scene3d) scenes.add(obj.scene3d);
      else if (o.type === "scene") scenes.add(obj);
      else if (o.type === "poolreg" && obj.pools instanceof Map) for (const p of obj.pools.values()) if (p && p.mesh) visit(p.mesh);
    }
    if (typeof window !== "undefined" && window && window.liveScene3d) scenes.add(window.liveScene3d);
    // The shadow kinds are direct children of these groups (chunk / atlas
    // buckets of staticsGroup, building batches of buildingsGroup, envcell pools
    // of cellsGroup); pools elsewhere are reached through their registry above.
    for (const s3 of scenes) {
      for (const g of [s3.staticsGroup, s3.buildingsGroup, s3.cellsGroup]) {
        const kids = g && g.children;
        if (Array.isArray(kids)) for (const c of kids) visit(c);
      }
    }
    return n;
  }

  /**
   * One audit: flush, build the arena, let the kernel compare. Returns
   * `{ mismatches, report }` (null when no kernel).
   */
  audit({ matrices = false, windowSlots = 0 } = {}) {
    if (!this._armed) return null;
    try {
      const arena = this.buildAuditArena({ matrices, windowSlots });
      this.flush(); // after the arena: collected objects' DISPOSE posts go too
      const k = this._kernel;
      if (!k || this._kernelState !== 1) return null;
      const m = k.audit(arena);
      this.stats.audits += 1;
      if (typeof m === "number" && m >= 0) {
        this.stats.lastMismatches = m;
        this.stats.mismatches += m;
      } else {
        this.stats.kernelErrors += 1;
      }
      const rep = this.report();
      if (rep) {
        this.stats.integrity = rep.integrityTotal | 0;
        this.stats.andDivergence = rep.andDivergence | 0;
        const orphan = rep.last && rep.last.cat ? rep.last.cat.poolHideOrphan : undefined;
        this.stats.poolHideOrphan = typeof orphan === "number" ? orphan : -1;
      }
      return { mismatches: m, report: rep, arena };
    } catch (e) {
      this._fail(e);
      return null;
    }
  }

  /** The kernel's report (parsed JSON), or null. */
  report() {
    const k = this._kernel;
    if (!k || typeof k.report !== "function") return null;
    try {
      const r = k.report();
      return typeof r === "string" ? JSON.parse(r) : r;
    } catch (e) { this._fail(e); return null; }
  }

  /** The kernel's table census (parsed JSON), or null. */
  census() {
    this.flush();
    const k = this._kernel;
    if (!k || typeof k.census !== "function") return null;
    try {
      const r = k.census();
      return typeof r === "string" ? JSON.parse(r) : r;
    } catch (e) { this._fail(e); return null; }
  }

  _startTimer() {
    if (this._timer || typeof setInterval !== "function" || typeof window === "undefined") return;
    this._timer = setInterval(() => {
      if (globalThis.__hbRustWorld !== this) return;
      this._audits += 1;
      this.audit({ matrices: this._audits % MATRIX_AUDIT_EVERY === 0, windowSlots: AUDIT_WINDOW_SLOTS });
    }, AUDIT_EVERY_MS);
  }

  _stopTimer() {
    if (this._timer) { try { clearInterval(this._timer); } catch (_) {} this._timer = null; }
  }
}

// ---------------------------------------------------------------------------
// arming
// ---------------------------------------------------------------------------

/** The armed bridge, or null. Producers reach it as `globalThis.__hbRustWorld`. */
let _bridge = null;

export function rustWorldBridge() { return _bridge; }

/**
 * Arm shadow mode. `kernel`: inject one (tests); omitted ⇒ the pkg's
 * SceneWorld, resolved at the first flush. `periodic`: the 1 Hz audit
 * (default: in a browser). Returns the bridge.
 */
export function armRustWorld({ kernel = null, record = false, periodic } = {}) {
  disarmRustWorld();
  _bridge = new RustWorldBridge({ kernel, record });
  globalThis.__hbRustWorld = _bridge;
  if (periodic === undefined ? typeof window !== "undefined" : periodic) _bridge._startTimer();
  _installDiag();
  return _bridge;
}

/** Stop posting (wrapped objects keep their prototype; it posts nowhere). */
export function disarmRustWorld() {
  const b = _bridge;
  if (!b) return;
  b._armed = false;
  b._stopTimer();
  _bridge = null;
  if (globalThis.__hbRustWorld === b) globalThis.__hbRustWorld = undefined;
}

function _installDiag() {
  if (typeof window === "undefined" || !window) return;
  try {
    window.__rustWorld = {
      stats: () => (_bridge ? { enabled: true, ..._bridge.stats } : { enabled: false }),
      audit: (opts) => (_bridge ? _bridge.audit(opts || { matrices: true }) : null),
      report: () => (_bridge ? _bridge.report() : null),
      census: () => (_bridge ? _bridge.census() : null),
      groups: () => worldGroupCensus(window.liveScene3d),
      // The S0 recorder on a live session: `record()` starts keeping every event
      // handed to the kernel from now on; `recorded()` returns them as a
      // Float64Array (tools/rust_parity/gen_world.mjs `encodeWorldValues` turns
      // that into a fixture's `events`), `record(false)` stops and drops them.
      // Note the kernel has seen everything before `record()`, so a replay of a
      // mid-session recording needs the kernel's state at that point too.
      record: (on = true) => { if (_bridge) { _bridge.flush(); _bridge._rec = on ? [] : null; } return !!(_bridge && _bridge._rec); },
      recorded: () => (_bridge ? _bridge.recorded() : null),
    };
  } catch (_) { /* diag only */ }
}

// ---------------------------------------------------------------------------
// S0: the per-group structural census (also `frameSplitCensus().groups`)
// ---------------------------------------------------------------------------

function _batchKindOf(o) {
  const ud = o.userData || {};
  if (ud.__staticBatchCrossLb) return "chunk";
  if (ud.__statAtlasCrossLb) return "atlas";
  if (ud.__drawPool) return "pool";
  if (ud.__buildingBatch) return "building";
  if (ud.__staticBatch) return "lbBatch";
  if (ud.__terrainBatch || /terrain/i.test(o.name || "")) return "terrain";
  return "other";
}

function _freshGroupCensus() {
  return {
    resident: 0, // every node (what three's matrix walk visits without ?skipHiddenMatrix)
    visited: 0, // reachable without crossing visible === false (projectObject, each shadow walk)
    composing: 0, // visited and matrixAutoUpdate (composes every frame under ?skipHiddenMatrix)
    composingAll: 0, // resident and matrixAutoUpdate (composes every frame without it)
    frozen: 0, // matrixAutoUpdate === false
    groups: 0,
    lods: 0,
    billboardLods: 0, // userData.billboardMode >= 2 (statics.js tagBillboardLod)
    anchors: 0, // userData.isStaticScriptAnchor
    anchorsFrozen: 0,
    singletonMeshes: 0, // plain Mesh (not batched / instanced / skinned)
    skinnedMeshes: 0,
    instancedMeshes: 0,
    instancedInstances: 0, // sum of InstancedMesh.count
    lights: 0,
    batched: {}, // kind -> { objects, slots, instances (active), visibleInstances, geometries }
  };
}

function _censusNode(o, c, visited) {
  c.resident += 1;
  const mau = o.matrixAutoUpdate !== false;
  if (mau) c.composingAll += 1; else c.frozen += 1;
  if (visited) {
    c.visited += 1;
    if (mau) c.composing += 1;
  }
  const ud = o.userData || {};
  if (o.isGroup) c.groups += 1;
  if (o.isLOD) {
    c.lods += 1;
    if ((ud.billboardMode ?? 0) >= 2) c.billboardLods += 1;
  }
  if (ud.isStaticScriptAnchor) {
    c.anchors += 1;
    if (ud.__anchorFrozen) c.anchorsFrozen += 1;
  }
  if (o.isLight) c.lights += 1;
  if (o.isBatchedMesh) {
    const k = _batchKindOf(o);
    const b = c.batched[k] || (c.batched[k] = { objects: 0, slots: 0, instances: 0, visibleInstances: 0, geometries: 0 });
    b.objects += 1;
    const info = Array.isArray(o._instanceInfo) ? o._instanceInfo : [];
    b.slots += info.length;
    for (const x of info) {
      if (!x.active) continue;
      b.instances += 1;
      if (x.visible) b.visibleInstances += 1;
    }
    const gi = Array.isArray(o._geometryInfo) ? o._geometryInfo : [];
    for (const g of gi) if (g && g.active) b.geometries += 1;
  } else if (o.isInstancedMesh) {
    c.instancedMeshes += 1;
    c.instancedInstances += o.count | 0;
  } else if (o.isSkinnedMesh) {
    c.skinnedMeshes += 1;
  } else if (o.isMesh) {
    c.singletonMeshes += 1;
  }
}

function _censusWalk(root, c, visitedIn) {
  // Iterative: anchors / rigs nest deep enough to make recursion a risk.
  const stack = [root, visitedIn];
  while (stack.length > 0) {
    const vis = stack.pop();
    const o = stack.pop();
    const visited = vis && o.visible !== false;
    _censusNode(o, c, visited);
    const kids = o.children;
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i], visited);
  }
}

/**
 * Per world-group structural census (R2 §4 S0): for each world-group root
 * (terrain, buildings, statics, cells, entities, the rest of worldRoot, the
 * rest of the scene, and the ?anchorOffGraph per-landblock anchor roots), the
 * resident / visited / composing node counts, LODs (billboard-tagged too),
 * script anchors, singleton meshes, and batch objects / instances per kind.
 * Structure only: no frustum is re-derived (frame_split.js's rule).
 */
export function worldGroupCensus(scene3d) {
  const s = scene3d || null;
  const scene = s && s.scene;
  if (!scene || !Array.isArray(scene.children)) return { error: "no scene3d.scene" };
  const named = [
    ["terrain", s.terrainGroup], ["buildings", s.buildingsGroup], ["statics", s.staticsGroup],
    ["cells", s.cellsGroup], ["entities", s.entitiesGroup],
  ];
  const roots = new Map();
  for (const [name, g] of named) if (g && g.isObject3D) roots.set(g, name);
  const groups = {};
  for (const [, name] of roots) groups[name] = _freshGroupCensus();
  groups.worldRootOther = _freshGroupCensus();
  groups.sceneOther = _freshGroupCensus();
  groups.offGraphAnchors = _freshGroupCensus();
  // Visibility of a root's ancestors decides whether its subtree is visited.
  const visibleChain = (o) => {
    for (let p = o; p; p = p.parent) if (p.visible === false) return false;
    return true;
  };
  for (const [g, name] of roots) _censusWalk(g, groups[name], visibleChain(g.parent));
  const worldRoot = s.worldRoot || null;
  // The rest: everything under the scene not under a named root.
  const walkRest = (o, visited) => {
    const stack = [o, visited];
    while (stack.length > 0) {
      const vis = stack.pop();
      const n = stack.pop();
      if (roots.has(n)) continue;
      const underWorld = (() => { for (let p = n; p; p = p.parent) if (p === worldRoot) return true; return false; })();
      const c = underWorld ? groups.worldRootOther : groups.sceneOther;
      const v = vis && n.visible !== false;
      _censusNode(n, c, v);
      const kids = n.children;
      if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i], v);
    }
  };
  walkRest(scene, true);
  const anchorRoots = s.staticsGroup && s.staticsGroup.userData ? s.staticsGroup.userData.__anchorRoots : null;
  if (anchorRoots instanceof Map) {
    // Off-graph: never walked by three (the scene does not contain them).
    for (const r of anchorRoots.values()) _censusWalk(r, groups.offGraphAnchors, false);
  }
  const total = _freshGroupCensus();
  for (const c of Object.values(groups)) {
    for (const [k, v] of Object.entries(c)) {
      if (k === "batched") {
        for (const [bk, bv] of Object.entries(v)) {
          const t = total.batched[bk] || (total.batched[bk] = { objects: 0, slots: 0, instances: 0, visibleInstances: 0, geometries: 0 });
          for (const [f, n] of Object.entries(bv)) t[f] += n;
        }
      } else if (k !== "offGraph") {
        total[k] += v;
      }
    }
  }
  return {
    scales: {
      resident: "every node under the root",
      visited: "reachable without crossing visible === false (projectObject / shadow walks)",
      composing: "visited and matrixAutoUpdate — composes each frame under ?skipHiddenMatrix (default on)",
      composingAll: "resident and matrixAutoUpdate — composes each frame without ?skipHiddenMatrix",
      offGraphAnchors: "?anchorOffGraph roots: not in the scene, never walked (counted resident only)",
    },
    groups,
    total,
  };
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

// The census is published whether or not shadow mode is armed: frame_split.js
// `frameSplitCensus().groups` reads it through this global (no import, so the
// probe's module graph is unchanged).
globalThis.__hbWorldGroupCensus = worldGroupCensus;

// Armed at module evaluation so it precedes every producer event (statics.js
// imports this module; the producers reach the bridge through the global).
try {
  if (typeof window !== "undefined" && rustWorldEnabled()) armRustWorld();
} catch (_) { /* never break boot */ }

/** Test seam: the bridge class. */
export const __RustWorldBridgeForTest = RustWorldBridge;
