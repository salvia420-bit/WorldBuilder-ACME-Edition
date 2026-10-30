// scene3d/rust/terrain_fx.js — lane E bridge: the scatter pool's per-frame
// re-scatter PLAN from Rust (`?rustTerrainFx`, DEFAULT ON since 2026-10-26; `=off` escape).
//
// Lane notes (the measurements, what moved and what did not, the protocol):
// docs/2026-10-26-rust-anim-terrain.md. Kernel:
// crates/holtburger-scene/src/terrain_fx.rs. wasm glue:
// src/scene_wasm/terrain_fx.rs (`SceneScatterPlanner`).
//
// WHAT IT REPLACES. terrain_scatter.js `update()` decides, each frame, which
// instances to re-scatter: the edge queue (slot lines a window scroll
// re-assigned), then a round-robin scan of up to `scanBudget` instances — a
// per-instance TEST over the pool's typed arrays (~2,048 a frame for the ultra
// pebble pool). Under the flag a consumer hands its pool `scanPlanner:
// rustScatterPlanner()`; the pool then asks the planner (`plan`) instead of
// running those loops, and scatters exactly the instances it returns, in the
// order it returns them, with its own `scatterInstance` (oracle, gates, the
// consumer's fill, every buffer write). The planner mirrors the four arrays
// the TEST reads (cellX, cellY, resolvedFlags, outFlags); the only thing it
// cannot compute — whether a scattered instance's oracle sample resolved — JS
// reports after each batch (`resume`).
//
// Hook protocol with terrain_scatter.js (`opts.scanPlanner`):
//   factory.attach(cfg) → planner | null     at createScatterPool
//   planner.plan(gxMin, gyMin, cx, cy, scatter, resolvedFlags, outFlags)
//     → { written, edgeWritten, scanned, cursor } | null (failed: JS loops take over)
//   planner.sync(cellX, cellY, resolvedFlags, outFlags, gxMin, gyMin, cursor)   after rescatterAll
//   planner.invalidate()                      after invalidate()
//   planner.syncResolved(resolvedFlags)       after invalidateRegion()
//   planner.dispose()                         at pool dispose()

import { sceneWasmClass, sceneWasmMemory, rustFlag } from "./scene_core.js";

let _flag = null;
/** `?rustTerrainFx` (read once; `__setRustTerrainFxForTest` overrides). */
export function rustTerrainFxEnabled() {
  if (_flag === null) _flag = rustFlag("rustTerrainFx", true);
  return _flag;
}

const _stats = { attached: 0, refused: 0, frames: 0, batches: 0, scattered: 0, failures: 0, syncs: 0 };
/** Diag snapshot (`window.__rustTerrainFx.stats()`). */
export function rustTerrainFxStats() {
  return { enabled: rustTerrainFxEnabled(), available: !!sceneWasmClass("SceneScatterPlanner"), ..._stats };
}

/** A typed-array view on wasm memory that re-creates itself on growth. */
class _View {
  constructor(Ctor) { this._Ctor = Ctor; this._buf = null; this._ptr = -1; this._len = -1; this._v = null; }
  get(ptr, len) {
    const mem = sceneWasmMemory();
    if (!mem) return null;
    const buf = mem.buffer;
    if (buf !== this._buf || ptr !== this._ptr || len !== this._len || this._v === null) {
      this._buf = buf; this._ptr = ptr; this._len = len;
      this._v = len > 0 ? new this._Ctor(buf, ptr, len) : new this._Ctor(0);
    }
    return this._v;
  }
}

class RustScatterPlanner {
  constructor(k, cfg) {
    this.k = k;
    this.cfg = cfg;
    this.failed = false;
    this._batchV = new _View(Int32Array);
    this._outV = new _View(Uint8Array);
    this._statsV = new _View(Uint32Array);
    // The batch copied out before scattering: a consumer callback that
    // reached wasm (none does today) could otherwise detach the view mid-batch.
    this._copy = new Int32Array(Math.max(3, k.batchCap() >>> 0));
    this._st = { written: 0, edgeWritten: 0, scanned: 0, cursor: 0 };
  }

  _stats() {
    return this._statsV.get(this.k.statsPtr() >>> 0, this.k.statsLen() >>> 0);
  }

  /** One frame's plan; scatters through `scatter(i, gx, gy)` as it goes. */
  plan(gxMin, gyMin, cx, cy, scatter, resolvedFlags, outFlags) {
    if (this.failed) return null;
    const k = this.k;
    try {
      _stats.frames += 1;
      let n = k.begin(cx, cy, gxMin, gyMin) >>> 0;
      while (n > 0) {
        _stats.batches += 1;
        _stats.scattered += n;
        const cap = k.batchCap() >>> 0;
        const b = this._batchV.get(k.batchPtr() >>> 0, cap);
        if (this._copy.length < cap) this._copy = new Int32Array(cap);
        const c = this._copy;
        const m = n * 3;
        for (let j = 0; j < m; j += 1) c[j] = b[j];
        for (let j = 0; j < m; j += 3) scatter(c[j], c[j + 1], c[j + 2]);
        const o = this._outV.get(k.outcomePtr() >>> 0, k.outcomeCap() >>> 0);
        for (let j = 0, q = 0; j < n; j += 1, q += 3) {
          const i = c[q];
          o[j] = (resolvedFlags[i] & 1) | ((outFlags[i] & 1) << 1);
        }
        n = k.resume(n) >>> 0;
      }
      const s = this._stats();
      const st = this._st;
      st.written = s[0];
      st.edgeWritten = s[1];
      st.scanned = s[2];
      st.cursor = s[3];
      return st;
    } catch (_) {
      this.failed = true;
      _stats.failures += 1;
      return null;
    }
  }

  /** The cursor the planner holds (the JS loops resume from it on failure). */
  cursor() {
    try { return this._stats()[3] >>> 0; } catch (_) { return 0; }
  }

  desyncs() {
    try { return this._stats()[6] >>> 0; } catch (_) { return 0; }
  }

  sync(cellX, cellY, resolvedFlags, outFlags, gxMin, gyMin, cursor) {
    if (this.failed) return false;
    try {
      _stats.syncs += 1;
      return this.k.syncAll(cellX, cellY, resolvedFlags, outFlags, gxMin | 0, gyMin | 0, cursor >>> 0) === true;
    } catch (_) {
      this.failed = true;
      _stats.failures += 1;
      return false;
    }
  }

  invalidate() {
    if (this.failed) return;
    try { this.k.invalidate(); } catch (_) { this.failed = true; _stats.failures += 1; }
  }

  syncResolved(resolvedFlags) {
    if (this.failed) return;
    try { this.k.syncResolved(resolvedFlags); } catch (_) { this.failed = true; _stats.failures += 1; }
  }

  stats() {
    let s = null;
    try { s = this._stats(); } catch (_) { s = null; }
    return {
      failed: this.failed,
      lastWritten: s ? s[0] : 0,
      lastScanned: s ? s[2] : 0,
      cursor: s ? s[3] : 0,
      desync: s ? s[6] : 0,
      stops: s ? s[7] : 0,
      queuedLines: (() => { try { return this.k.queuedLines >>> 0; } catch (_) { return 0; } })(),
    };
  }

  dispose() {
    const k = this.k;
    this.k = null;
    this.failed = true;
    try { k?.free?.(); } catch (_) { /* already freed */ }
  }
}

const _factory = {
  /** createScatterPool's constants → a planner, or null (JS loops). */
  attach(cfg) {
    const C = sceneWasmClass("SceneScatterPlanner");
    if (!C || !cfg) { _stats.refused += 1; return null; }
    let k = null;
    try {
      k = new C(cfg.count >>> 0, cfg.gridSize >>> 0, Number(cfg.cellSizeM), Number(cfg.radiusM), Number(cfg.jitter),
        cfg.seed | 0, cfg.disc === true, cfg.scanBudget >>> 0, cfg.sliceSize >>> 0, cfg.edgeBudget >>> 0);
    } catch (_) {
      k = null;
    }
    if (!k || k.ok !== true) {
      try { k?.free?.(); } catch (_) {}
      _stats.refused += 1;
      return null;
    }
    _stats.attached += 1;
    if (typeof window !== "undefined" && window && !window.__rustTerrainFx) {
      try { window.__rustTerrainFx = { stats: rustTerrainFxStats }; } catch (_) { /* diag only */ }
    }
    return new RustScatterPlanner(k, cfg);
  },
};

/**
 * What a terrain VFX consumer passes as createScatterPool's `scanPlanner`:
 * the factory under `?rustTerrainFx`, else null (the pool's own loops).
 */
export function rustScatterPlanner() {
  return rustTerrainFxEnabled() ? _factory : null;
}

/** Test seam: force the flag (`undefined` re-reads `rustFlag`). */
export function __setRustTerrainFxForTest(on) {
  _flag = on === undefined ? null : !!on;
}

/** Test seam: zero the counters. */
export function __resetRustTerrainFxForTest() {
  for (const key of Object.keys(_stats)) _stats[key] = 0;
}
