// tools/rust_parity/model_terrain_fx.mjs — `ModelScatterPlanner`, a
// line-for-line JS transcription of crates/holtburger-scene/src/terrain_fx.rs
// (`ScatterPlanner`), plus `ModelSceneScatterPlanner`, the same surface as the
// wasm glue (src/scene_wasm/terrain_fx.rs) on a fake wasm memory. Used by
// tests/rust_terrain_fx_parity.test.mjs Part 1 (no wasm needed) to pin the
// kernel's logic against the fixture and to drive the real bridge + pool hook.
// Keep it in step with terrain_fx.rs.

import { scatterHashU32 } from "../../scene3d/terrain_scatter.js";

export const PENDING = 2;

export function wrapSlotToCell(slot, minCell, grid) {
  const g = grid >= 1 ? grid : 1;
  const m = (slot - minCell) % g;
  return minCell + (m < 0 ? m + g : m);
}

const hash01 = (a, b, c, seed) => scatterHashU32(a, b, c, seed) / 4294967296;

export class ModelScatterPlanner {
  constructor(cfg) {
    this.cfg = cfg;
    const n = cfg.count;
    this.cellX = new Int32Array(n).fill(0x7fffffff);
    this.cellY = new Int32Array(n).fill(0x7fffffff);
    this.resolved = new Uint8Array(n);
    this.out = new Uint8Array(n);
    this.cursor = 0;
    this.lastMin = null;
    this.lines = []; // FIFO; lines[k] has seq frontSeq + k
    this.frontSeq = 0;
    this.bySlot = [new Array(cfg.grid).fill(null), new Array(cfg.grid).fill(null)];
    this.fr = { phase: "done", cx: 0, cy: 0, gxMin: 0, gyMin: 0, written: 0, edgeWritten: 0, scanned: 0, scanI: 0 };
    const cap = Math.max(1, Math.min(Math.max(cfg.edgeBudget, cfg.sliceSize), cfg.count));
    this.batch = new Int32Array(cap * 3);
    this.batchLen = 0;
    this.outcome = new Uint8Array(cap);
    this.stats = new Uint32Array(8);
    this.desync = 0;
    this.stops = 0;
  }

  static create(cfg) {
    if (!(cfg.grid > 0) || cfg.count !== cfg.grid * cfg.grid) return null;
    if (!(cfg.scanBudget > 0) || !(cfg.sliceSize > 0) || !(cfg.edgeBudget > 0)) return null;
    if (!(cfg.cellSize > 0) || !Number.isFinite(cfg.radius) || !Number.isFinite(cfg.jitter)) return null;
    return new ModelScatterPlanner(cfg);
  }

  begin(cx, cy, gxMin, gyMin) {
    this.fr = { phase: "edge", cx, cy, gxMin, gyMin, written: 0, edgeWritten: 0, scanned: 0, scanI: this.cursor };
    this.batchLen = 0;
    if (this.lastMin !== null) {
      this.enqueueScrolled(0, this.lastMin[0], gxMin);
      this.enqueueScrolled(1, this.lastMin[1], gyMin);
    }
    this.lastMin = [gxMin, gyMin];
    this.run();
    this.writeStats();
    return this.batchLen;
  }

  resume(n) {
    n = Math.min(n, this.batchLen);
    for (let k = 0; k < n; k++) {
      const i = this.batch[k * 3];
      const o = this.outcome[k];
      const out = (o >> 1) & 1;
      if (out !== this.out[i]) { this.desync += 1; this.out[i] = out; }
      this.resolved[i] = o & 1;
    }
    for (let k = n; k < this.batchLen; k++) {
      const i = this.batch[k * 3];
      if (this.resolved[i] === PENDING) { this.resolved[i] = 0; this.desync += 1; }
    }
    this.batchLen = 0;
    if (this.fr.phase !== "done") this.run();
    this.writeStats();
    return this.batchLen;
  }

  syncAll(cellX, cellY, resolved, out, gxMin, gyMin, cursor) {
    const n = this.cfg.count;
    if (cellX.length < n || cellY.length < n || resolved.length < n || out.length < n) return false;
    for (let i = 0; i < n; i++) {
      this.cellX[i] = cellX[i];
      this.cellY[i] = cellY[i];
      this.resolved[i] = resolved[i] & 1;
      this.out[i] = out[i] & 1;
    }
    this.clearLines();
    this.lastMin = [gxMin, gyMin];
    this.cursor = cursor < n ? cursor : 0;
    this.fr.phase = "done";
    this.batchLen = 0;
    this.writeStats();
    return true;
  }

  invalidate() { this.resolved.fill(0); }

  syncResolved(resolved) {
    if (resolved.length < this.cfg.count) return false;
    for (let i = 0; i < this.cfg.count; i++) this.resolved[i] = resolved[i] & 1;
    return true;
  }

  clearLines() {
    this.lines.length = 0;
    this.frontSeq = 0;
    this.bySlot[0].fill(null);
    this.bySlot[1].fill(null);
  }

  enqueueLine(axis, slot) {
    const seq = this.bySlot[axis][slot];
    if (seq !== null) { this.lines[seq - this.frontSeq].next = 0; return; }
    this.bySlot[axis][slot] = this.frontSeq + this.lines.length;
    this.lines.push({ axis, slot, next: 0 });
  }

  enqueueScrolled(axis, oldMin, newMin) {
    const g = this.cfg.grid;
    const d = newMin - oldMin;
    if (d === 0) return;
    if (Math.abs(d) >= g) { for (let k = 0; k < g; k++) this.enqueueLine(axis, k); return; }
    const c0 = d > 0 ? oldMin : newMin + g;
    for (let c = c0; c < c0 + Math.abs(d); c++) {
      const m = c % g;
      this.enqueueLine(axis, m < 0 ? m + g : m);
    }
  }

  backInRange(i) {
    if (this.out[i] !== 1) return false;
    const c = this.cfg;
    const dx = (this.cellX[i] + 0.5) * c.cellSize - this.fr.cx;
    const dy = (this.cellY[i] + 0.5) * c.cellSize - this.fr.cy;
    const r = c.radius - c.cellSize;
    return r > 0 && dx * dx + dy * dy <= r * r;
  }

  test(i, gx, gy) {
    if (gx !== this.cellX[i] || gy !== this.cellY[i]) return 1;
    const r = this.resolved[i];
    if (r === 0) return 1;
    if (r === PENDING) return -1;
    return this.backInRange(i) ? 1 : 0;
  }

  scatter(i, gx, gy) {
    this.cellX[i] = gx;
    this.cellY[i] = gy;
    const c = this.cfg;
    const jx = c.jitter > 0 ? (hash01(gx, gy, 1, c.seed) - 0.5) * c.jitter : 0;
    const jy = c.jitter > 0 ? (hash01(gx, gy, 2, c.seed) - 0.5) * c.jitter : 0;
    const x = (gx + 0.5 + jx) * c.cellSize;
    const y = (gy + 0.5 + jy) * c.cellSize;
    const dx = x - this.fr.cx;
    const dy = y - this.fr.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (c.disc && dist > c.radius) { this.resolved[i] = 1; this.out[i] = 1; } else { this.out[i] = 0; this.resolved[i] = PENDING; }
    const b = this.batchLen * 3;
    if (b + 3 > this.batch.length) {
      const nb = new Int32Array(b + 3); nb.set(this.batch); this.batch = nb;
      const no = new Uint8Array(this.batchLen + 1); no.set(this.outcome); this.outcome = no;
    }
    this.batch[b] = i; this.batch[b + 1] = gx; this.batch[b + 2] = gy;
    this.batchLen += 1;
  }

  run() {
    if (this.fr.phase === "edge") {
      if (!this.drainEdges()) return;
      this.fr.written = this.fr.edgeWritten;
      this.fr.phase = "scan";
    }
    if (this.fr.phase === "scan") {
      if (!this.scan()) return;
      this.cursor = this.fr.scanI;
      this.fr.phase = "done";
    }
  }

  drainEdges() {
    const g = this.cfg.grid;
    const budget = this.cfg.edgeBudget;
    while (this.lines.length > 0 && this.fr.edgeWritten < budget) {
      const line = this.lines[0];
      const { axis, slot } = line;
      let k = line.next;
      while (k < g && this.fr.edgeWritten < budget) {
        const i = axis === 0 ? k * g + slot : slot * g + k;
        const gx = wrapSlotToCell(i % g, this.fr.gxMin, g);
        const gy = wrapSlotToCell((i / g) | 0, this.fr.gyMin, g);
        const t = this.test(i, gx, gy);
        if (t === 1) { this.scatter(i, gx, gy); this.fr.edgeWritten += 1; }
        else if (t === -1) { line.next = k; this.stops += 1; return false; }
        k += 1;
      }
      line.next = k;
      if (k >= g) {
        this.lines.shift();
        this.frontSeq += 1;
        this.bySlot[axis][slot] = null;
      }
    }
    return true;
  }

  scan() {
    const n = this.cfg.count;
    const g = this.cfg.grid;
    let i = this.fr.scanI;
    while (this.fr.scanned < this.cfg.scanBudget && this.fr.written < this.cfg.sliceSize && this.fr.scanned < n) {
      const gx = wrapSlotToCell(i % g, this.fr.gxMin, g);
      const gy = wrapSlotToCell((i / g) | 0, this.fr.gyMin, g);
      const t = this.test(i, gx, gy);
      if (t === 1) { this.scatter(i, gx, gy); this.fr.written += 1; }
      else if (t === -1) { this.fr.scanI = i; this.stops += 1; return false; }
      this.fr.scanned += 1;
      i += 1;
      if (i >= n) i = 0;
    }
    this.fr.scanI = i;
    return true;
  }

  writeStats() {
    const s = this.stats;
    s[0] = this.fr.phase === "edge" ? this.fr.edgeWritten : this.fr.written;
    s[1] = this.fr.edgeWritten;
    s[2] = this.fr.scanned;
    s[3] = this.cursor;
    s[4] = this.batchLen;
    s[5] = this.fr.phase === "done" ? 1 : 0;
    s[6] = this.desync;
    s[7] = this.stops;
  }
}

/**
 * The wasm glue's surface (`SceneScatterPlanner`) over the model, on a fake
 * memory whose buffer is replaced (old one detached) as it grows.
 */
export function makeModelPlannerNamespace(sceneCoreAbi) {
  const memory = { buffer: new ArrayBuffer(1 << 12) };
  let top = 64;
  let grows = 0;
  function alloc(bytes) {
    top = (top + 7) & ~7;
    if (top + bytes > memory.buffer.byteLength) {
      const nb = new ArrayBuffer(Math.max(memory.buffer.byteLength * 2, top + bytes + 64));
      new Uint8Array(nb).set(new Uint8Array(memory.buffer));
      const old = memory.buffer;
      memory.buffer = nb;
      structuredClone(old, { transfer: [old] });
      grows += 1;
    }
    const p = top;
    top += bytes;
    return p;
  }
  class ModelSceneScatterPlanner {
    constructor(count, grid, cellSize, radius, jitter, seed, disc, scanBudget, sliceSize, edgeBudget) {
      this.p = ModelScatterPlanner.create({ count, grid, cellSize, radius, jitter, seed, disc, scanBudget, sliceSize, edgeBudget });
      if (this.p) {
        this.bPtr = alloc(this.p.batch.length * 4);
        this.oPtr = alloc(this.p.outcome.length);
        this.sPtr = alloc(32);
        this._push();
      }
    }
    get ok() { return !!this.p; }
    _push() {
      const p = this.p;
      new Int32Array(memory.buffer, this.bPtr, p.batch.length).set(p.batch);
      new Uint32Array(memory.buffer, this.sPtr, 8).set(p.stats);
    }
    _pull() {
      const p = this.p;
      p.outcome.set(new Uint8Array(memory.buffer, this.oPtr, p.outcome.length));
    }
    begin(cx, cy, gxMin, gyMin) { const n = this.p ? this.p.begin(cx, cy, gxMin, gyMin) : 0; if (this.p) this._push(); return n; }
    resume(n) { if (!this.p) return 0; this._pull(); const r = this.p.resume(n); this._push(); return r; }
    syncAll(cx, cy, r, o, gxMin, gyMin, cursor) { if (!this.p) return false; const ok = this.p.syncAll(cx, cy, r, o, gxMin, gyMin, cursor); this._push(); return ok; }
    invalidate() { this.p?.invalidate(); }
    syncResolved(r) { return this.p ? this.p.syncResolved(r) : false; }
    batchPtr() { return this.bPtr; }
    batchCap() { return this.p ? this.p.batch.length : 0; }
    outcomePtr() { return this.oPtr; }
    outcomeCap() { return this.p ? this.p.outcome.length : 0; }
    statsPtr() { return this.sPtr; }
    statsLen() { return 8; }
    get cursor() { return this.p ? this.p.cursor : 0; }
    get queuedLines() { return this.p ? this.p.lines.length : 0; }
    free() { this.p = null; }
  }
  return { ns: { sceneCoreAbi: () => sceneCoreAbi, SceneScatterPlanner: ModelSceneScatterPlanner }, memory, grows: () => grows };
}

/** Replay one fixture case through a planner-shaped object (model or wasm
 *  `SceneScatterPlanner` through its views). Returns { bad, frames, notes }. */
export function replayCase(c, make, views) {
  const cfg = c.cfg;
  const hx = (h) => { const dv = new DataView(new ArrayBuffer(8)); dv.setBigUint64(0, BigInt("0x" + h)); return dv.getFloat64(0); };
  const p = make(cfg.count, cfg.gridSize, hx(cfg.cellSizeM), hx(cfg.radiusM), hx(cfg.jitter), cfg.seed, cfg.disc,
    cfg.scanBudget, cfg.sliceSize, cfg.edgeBudget);
  let bad = 0;
  const notes = [];
  const note = (m) => { bad += 1; if (notes.length < 6) notes.push(m); };
  for (const ev of c.frames) {
    if (ev.invalidate) p.invalidate();
    const cx = hx(ev.cx), cy = hx(ev.cy);
    if (ev.kind === "rescatterAll") {
      const n = cfg.count;
      if (ev.scatters.length !== n) note(`frame ${ev.frame}: rescatterAll with ${ev.scatters.length} scatters`);
      const X = new Int32Array(n), Y = new Int32Array(n), R = new Uint8Array(n), O = new Uint8Array(n);
      for (const [i, gx, gy, r, o] of ev.scatters) { X[i] = gx; Y[i] = gy; R[i] = r; O[i] = o; }
      if (!p.syncAll(X, Y, R, O, ev.gxMin, ev.gyMin, 0)) note(`frame ${ev.frame}: syncAll refused`);
      continue;
    }
    let k = 0;
    let n = p.begin(cx, cy, ev.gxMin, ev.gyMin) >>> 0;
    while (n > 0) {
      const b = views.batch(p);
      const o = views.outcome(p);
      for (let j = 0; j < n; j++) {
        const want = ev.scatters[k + j];
        if (!want || b[j * 3] !== want[0] || b[j * 3 + 1] !== want[1] || b[j * 3 + 2] !== want[2]) {
          note(`frame ${ev.frame} scatter #${k + j}: got (${b[j * 3]}, ${b[j * 3 + 1]}, ${b[j * 3 + 2]}) want ${JSON.stringify(want)}`);
          return { bad, frames: c.frames.length, notes };
        }
        o[j] = (want[3] & 1) | ((want[4] & 1) << 1);
      }
      k += n;
      n = p.resume(n) >>> 0;
    }
    if (k !== ev.scatters.length) note(`frame ${ev.frame}: planned ${k} scatters, JS made ${ev.scatters.length}`);
    const s = views.stats(p);
    if (s[0] !== ev.written || s[2] !== ev.scanned || s[3] !== ev.cursor || s[1] !== ev.edgeWritten) {
      note(`frame ${ev.frame}: stats written/scanned/cursor/edge ${s[0]}/${s[2]}/${s[3]}/${s[1]} want ${ev.written}/${ev.scanned}/${ev.cursor}/${ev.edgeWritten}`);
    }
    if (s[6] !== 0) note(`frame ${ev.frame}: desync ${s[6]}`);
    if (views.queued(p) !== ev.edgePending) note(`frame ${ev.frame}: queued lines ${views.queued(p)} want ${ev.edgePending}`);
  }
  return { bad, frames: c.frames.length, notes };
}
