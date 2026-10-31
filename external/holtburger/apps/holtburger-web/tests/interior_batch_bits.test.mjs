// tests/interior_batch_bits.test.mjs — R3-5 `?interiorBatch` cell-visibility
// bits (scene3d/gpu_batch/interior_batch.js; design §2.7, proof §6.1).
//
//   B1  ibPackCell / ibUnpackCell / ibBitOf / ibSetBit round-trip at random
//       and edge rows, cells and cast bits; a line-for-line JS port of the
//       GLSL `hbIbHidden` (f32 attribute arithmetic included) agrees with
//       ibBitOf on every sampled code; the 24-bit float words ibSetBit writes
//       survive an f32 round-trip; the row cap keeps every code under 2^23
//       (at and above 2^23 `int( code + 0.5 )` in f32 is NOT exact: proven).
//   B2  PER-PASS REPLAY. Two worlds, one per cells.js module instance (flag
//       off / `?interiorBatch=on`), built from the same fixture and driven by
//       the same scripted session, rendered through three r184 (fake WebGL2)
//       in every pass that can draw interiors (design T1: unsplit world pass,
//       split world pass, cells pass, drawOutdoorRemainder, the sun shadow
//       raster). Every frame, every pass: the set of interior mesh-groups the
//       flag-off world DRAWS equals the set the flag-on world draws (legacy
//       draws, plus each batched member whose batch object was drawn and whose
//       DRAW bit — CAST bit and base cast for the shadow raster — the shader
//       decode reads as set); every batch object is visible iff any of its
//       cells has its DRAW bit. Walks: an outdoor doorway approach (the set
//       changing every few frames), going indoors (the indoor split arms and
//       the set narrows to the portal set, castOn flips on: interiors cast),
//       a sealed dungeon frame, back outdoors (castOn flips off), an evict +
//       rebuild, a park + unpark, all through the REAL LandblockLRU; and the
//       same under `?cellBugParity=retail` (every EnvCell drawn).
//   B3  the backstop: bitMismatch stays 0 over every walk; a stray
//       `container.visible` write outside the tick is detected (counted) and
//       the bits converge to the container.
//   B4  recorded walks (`tests/fixtures/interior_batch_walk_*.json`, captured
//       live by `window.__interiorBatch.recordWalk(n)`) replay through B2's
//       comparison when present.
//
// Run: node tests/interior_batch_bits.test.mjs   (needs `three` resolvable)

import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as R from "./interior_batch_rig.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
globalThis.window ??= {};
globalThis.location = { search: R.BASE_SEARCH };
globalThis.window.location = globalThis.location;
globalThis.window.requestAnimationFrame ??= () => 1;

const M = await import("../scene3d/materials.js");
const adapter = await import("../scene3d/adapter.js");
const KIT = await import("../scene3d/gpu_batch/kit.js");
const IB = await import("../scene3d/gpu_batch/interior_batch.js");
const PP = await import("../scene3d/portal_punch.js");
const { LandblockLRU } = await import("../scene3d/landblock_lru.js");
const deps = { M, adapter };

const cellsOff = await R.loadCells("");
const cellsOn = await R.loadCells("interiorBatch=on");
const cellsOffParity = await R.loadCells("cellBugParity=retail");
const cellsOnParity = await R.loadCells("cellBugParity=retail&interiorBatch=on");

let failures = 0;
let passes = 0;
async function t(name, fn) {
  try { await fn(); passes++; console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name); console.log(e); }
}

// --- B1 -------------------------------------------------------------------------
let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };

/** The GLSL decode, line for line, with the attribute in f32 (hbIbCell is a float attribute). */
function glslHidden(data, attr, base) {
  const f32 = Math.fround;
  const a = f32(attr);
  const c = Math.trunc(f32(a + 0.5)); // int( hbIbCell + 0.5 )
  const row = c >> 12;
  const bit = (c >> 1) & 2047;
  const q = (bit / 96) | 0;
  const w = bit - q * 96;
  const o = (row * IB.IB_TEXELS_PER_ROW + base + q) * 4;
  const tx = [data[o], data[o + 1], data[o + 2], data[o + 3]];
  const ch = (w / 24) | 0;
  const f = ch === 0 ? tx[0] : ch === 1 ? tx[1] : ch === 2 ? tx[2] : tx[3];
  return (((f | 0) >> (w - ch * 24)) & 1) === 0;
}

await t("B1 pack / bits round-trip; the GLSL port agrees with ibBitOf; f32-exact words", () => {
  const rows = IB.IB_MAX_ROW + 1;
  const data = new Float32Array(rows * IB.IB_TEXELS_PER_ROW * 4);
  const want = new Map();
  const samples = [];
  const edge = [[1, 0, 0], [1, 0, 1], [IB.IB_MAX_ROW, IB.IB_CELLS_PER_ROW - 1, 1], [IB.IB_MAX_ROW, 0, 0], [7, 95, 1], [7, 96, 0], [7, 23, 1], [7, 24, 1], [9, 1535, 0]];
  for (const e of edge) samples.push(e);
  for (let i = 0; i < 4000; i += 1) samples.push([1 + Math.floor(rnd() * IB.IB_MAX_ROW), Math.floor(rnd() * IB.IB_CELLS_PER_ROW), rnd() < 0.5 ? 1 : 0]);
  for (const [row, cell, cast] of samples) {
    const code = IB.ibPackCell(row, cell, cast);
    assert.ok(code < 2 ** 23, `code ${code} under 2^23`);
    assert.equal(Math.fround(code), code, "exact in f32");
    const u = IB.ibUnpackCell(Math.fround(code));
    assert.deepEqual([u.row, u.cell, u.baseCast], [row, cell, cast]);
    const vDraw = rnd() < 0.5 ? 1 : 0;
    const vCast = rnd() < 0.5 ? 1 : 0;
    IB.ibSetBit(data, row, 0, cell, vDraw);
    IB.ibSetBit(data, row, IB.IB_CAST_BASE, cell, vCast);
    want.set(`${row}:${cell}`, [vDraw, vCast, code]);
  }
  // f32 words: every channel holds an integer < 2^24, exact through Float32Array.
  for (let i = 0; i < data.length; i += 1) {
    assert.ok(Number.isInteger(data[i]) && data[i] >= 0 && data[i] < 2 ** 24, `word ${i}`);
    assert.equal(Math.fround(data[i]), data[i]);
  }
  for (const [, [vDraw, vCast, code]] of want) {
    assert.equal(IB.ibBitOf(data, code, 0), vDraw);
    assert.equal(IB.ibBitOf(data, code, IB.IB_CAST_BASE), vCast);
    assert.equal(glslHidden(data, code, 0), vDraw === 0, "GLSL port = ibBitOf (draw)");
    assert.equal(glslHidden(data, code, IB.IB_CAST_BASE), vCast === 0, "GLSL port = ibBitOf (cast)");
    assert.equal(Math.trunc(Math.fround(Math.fround(code) + 0.5)) & 1, code & 1, "the cast bit the depth shader reads");
  }
  // ibSetBit reports changes only.
  const d2 = new Float32Array(IB.IB_TEXELS_PER_ROW * 4 * 3);
  assert.equal(IB.ibSetBit(d2, 2, 0, 100, 1), true);
  assert.equal(IB.ibSetBit(d2, 2, 0, 100, 1), false);
  assert.equal(IB.ibSetBit(d2, 2, 0, 100, 0), true);
  // Why rows stop at 2047: at 2^23 and above `code + 0.5` rounds to even in f32.
  const big = 2049 * 4096 + 2 * 7 + 1; // row 2049, cell 7, cast 1 (odd)
  assert.notEqual(Math.trunc(Math.fround(Math.fround(big) + 0.5)), big, "premise: not exact past 2^23");
  // The shader text matches the port (no division form; the +0.5 rounding; base + q).
  const glsl = IB.ibVertexHeader();
  for (const s of ["int c = int( hbIbCell + 0.5 );", "int row = c >> 12;", "int bit = ( c >> 1 ) & 2047;", "int q = bit / 96;",
    "int w = bit - q * 96;", "texelFetch( hbIbBits, ivec2( base + q, row ), 0 )", "int ch = w / 24;",
    "return ( ( int( f ) >> ( w - ch * 24 ) ) & 1 ) == 0;"]) assert.ok(glsl.includes(s), s);
});

// --- B2 -------------------------------------------------------------------------
const OUT = (R.LB | 0x31) >>> 0;
const C = R.CELL;

/** A scripted frame: the session state and LRU / stray events. */
function walk() {
  const frames = [];
  const out = (frustum) => ({ player: OUT, indoor: false, frustum, walk: [], bfs: [] });
  for (let f = 0; f < 6; f += 1) frames.push(out([C(0), C(1), C(2), C(3)]));         // warm-up: everything in view
  for (let f = 0; f < 8; f += 1) frames.push(out(f % 4 < 2 ? [C(0), C(1)] : [C(1), C(3)])); // doorway approach
  frames.push(out([]));                                                                 // nothing seen
  frames.push(out([C(2)]));
  for (let f = 0; f < 6; f += 1) frames.push({ player: C(0), indoor: true, frustum: [C(0), C(2), C(3)], walk: f % 2 ? [C(0), C(1)] : [C(0), C(1), C(3)], bfs: [C(1)] }); // indoors: split + cast
  frames.push({ player: C(0), indoor: true, sealed: true, frustum: [C(0)], walk: [C(0), C(1)], bfs: [C(1)] });
  for (let f = 0; f < 3; f += 1) frames.push(out([C(0), C(1), C(3)]));                 // out again: castOn off
  frames.push({ ...out([C(0), C(1)]), event: "evict" });
  frames.push({ ...out([C(0), C(1)]), event: "rebuild" });
  for (let f = 0; f < 4; f += 1) frames.push(out(f < 2 ? [C(0), C(1)] : [C(0), C(1), C(2), C(3)]));
  frames.push({ ...out([C(1)]), event: "park" });
  frames.push(out([C(1)]));
  frames.push({ ...out([C(0), C(1), C(2)]), event: "unpark" });
  for (let f = 0; f < 3; f += 1) frames.push({ player: C(3), indoor: true, frustum: [C(3)], walk: [C(3)], bfs: [] });
  for (let f = 0; f < 3; f += 1) frames.push(out([C(0), C(3)]));
  return frames;
}

async function twin(off, on) {
  KIT.resetKit();
  IB.disposeInteriorBatches();
  IB.__setInteriorBatchEnvForTest({ mode: "on", now: R.FROZEN_CLOCK });
  const a = await R.makeWorld(deps);
  const b = await R.makeWorld(deps);
  for (const w of [a, b]) {
    const lru = new LandblockLRU({ scene3d: w.scene3d, maxResident: 64, getCurrentLbId: () => 0 });
    w.scene3d.landblockLru = lru;
    w.lru = lru;
    lru.track(R.LB);
  }
  await R.build(off, a);
  await R.build(on, b);
  return { a, b };
}

const key = (o, start) => `${o.name}#${start}`;

function batchOf(S, obj) {
  const rec = S.lbs.get(obj.userData.lbKey >>> 0);
  if (!rec) return null;
  for (const ch of rec.chunks) for (const bt of ch.batches) if (bt.mesh === obj) return bt;
  return null;
}

/** The interior mesh-groups one pass drew (batched members resolved through the bits). */
function drawnSet(recs, pass) {
  const S = IB.__interiorBatchStateForTest();
  const out = new Set();
  let batchDraws = 0;
  for (const r of recs) {
    const o = r.object;
    if (o.userData && o.userData.interiorBatch) {
      batchDraws += 1;
      const bt = batchOf(S, o);
      assert.ok(bt, `${o.name}: a live batch`);
      for (const e of bt.entries) {
        const on = pass === "shadow"
          ? IB.ibBitOf(S.bits.data, e.code, IB.IB_CAST_BASE) === 1 && e.baseCast
          : IB.ibBitOf(S.bits.data, e.code, 0) === 1;
        if (on) out.add(key(e.mesh, e.start));
      }
      continue;
    }
    if (!/^(surfaces?-|cellstatic-|surface-)/.test(o.name || "")) continue;
    out.add(key(o, r.group ? r.group.start : 0));
  }
  return { set: out, batchDraws };
}

function sameSet(a, b, what) {
  const onlyA = [...a].filter((x) => !b.has(x));
  const onlyB = [...b].filter((x) => !a.has(x));
  assert.ok(onlyA.length === 0 && onlyB.length === 0, `${what}: off-only ${JSON.stringify(onlyA)} on-only ${JSON.stringify(onlyB)}`);
}

function objectVisibilityMatchesBits() {
  const S = IB.__interiorBatchStateForTest();
  if (!S) return 0;
  let n = 0;
  for (const rec of S.lbs.values()) {
    for (const ch of rec.chunks) {
      for (const bt of ch.batches) {
        if (!bt.mesh) continue;
        let any = false;
        for (const e of bt.entries) if (IB.ibBitOf(S.bits.data, e.code, 0) === 1) any = true;
        assert.equal(bt.mesh.visible, any, `${bt.mesh.name}: visible iff a DRAW bit`);
        n += 1;
      }
    }
  }
  return n;
}

async function runWalk(off, on, frames, label) {
  const { a, b } = await twin(off, on);
  const stA = { player: OUT, indoor: false, frustum: [], walk: [], bfs: [] };
  const stB = { ...stA };
  const shA = R.makeSession(stA);
  const shB = R.makeSession(stB);
  let sealedA = false, sealedB = false;
  shA.currentDungeonHasOutdoorPortal = () => !sealedA;
  shB.currentDungeonHasOutdoorPortal = () => !sealedB;
  let maxBatch = 0;
  let activeFrames = 0;
  let checked = 0;
  for (let f = 0; f < frames.length; f += 1) {
    const fr = frames[f];
    if (fr.event === "evict") { a.lru.evict(R.LB); b.lru.evict(R.LB); }
    if (fr.event === "rebuild") { a.lru.track(R.LB); b.lru.track(R.LB); await R.build(off, a); await R.build(on, b); }
    if (fr.event === "park") { assert.equal(a.lru.park(R.LB), b.lru.park(R.LB)); }
    if (fr.event === "unpark") { a.lru.unpark(R.LB); b.lru.unpark(R.LB); }
    Object.assign(stA, fr);
    Object.assign(stB, fr);
    sealedA = sealedB = !!fr.sealed;
    R.tick(off, a, shA);
    R.tick(on, b, shB);
    const pa = R.renderAllPasses(a, PP.collectOutdoorRemainderHidden);
    const pb = R.renderAllPasses(b, PP.collectOutdoorRemainderHidden);
    for (const pass of ["unsplit", "world", "cells", "remainder", "shadow"]) {
      const da = drawnSet(pa[pass], pass);
      assert.equal(da.batchDraws, 0, "the flag-off world never draws a batch");
      const db = drawnSet(pb[pass], pass);
      sameSet(da.set, db.set, `${label} frame ${f} (${fr.event || "-"}) pass ${pass}`);
      if (pass === "unsplit") maxBatch = Math.max(maxBatch, db.batchDraws);
      checked += 1;
    }
    objectVisibilityMatchesBits();
    const d = IB.interiorBatchDiag();
    if (d && d.chunks && d.chunks.active) activeFrames += 1;
    if (process.env.IBDBG) console.log(label, f, fr.event || "", JSON.stringify(d && { lbs: d.lbs, chunks: d.chunks, legacy: d.legacyReasons, unit: d.unitReasons }));
  }
  const d = IB.interiorBatchDiag();
  return { checked, maxBatch, activeFrames, diag: d, a, b };
}

await t("B2 per-pass replay: every pass, every frame, the flag-on world draws exactly the flag-off interior set", async () => {
  const frames = walk();
  const r = await runWalk(cellsOff, cellsOn, frames, "walk");
  assert.equal(r.checked, frames.length * 5);
  assert.ok(r.maxBatch >= 4, `the on world really batched (batch draws in a pass: ${r.maxBatch})`);
  assert.ok(r.activeFrames >= frames.length - 8, `active for most of the walk (${r.activeFrames}/${frames.length})`);
  assert.equal(r.diag.bitMismatch, 0, "B3: no bit / container disagreement over the walk");
  // The indoor stretch rastered interior casters in both worlds (the walk proves CAST, not just DRAW).
  const shadowDraws = r.b.draws.filter((x) => x.shadow && x.object.userData?.interiorBatch).length;
  assert.ok(shadowDraws > 0, "batch casters drew in the shadow raster indoors");
});

await t("B2 per-pass replay under ?cellBugParity=retail (every EnvCell drawn)", async () => {
  const frames = walk().slice(0, 24);
  const r = await runWalk(cellsOffParity, cellsOnParity, frames, "parity");
  assert.ok(r.maxBatch >= 4, `batched (${r.maxBatch})`);
  assert.equal(r.diag.bitMismatch, 0);
});

// --- B3 -------------------------------------------------------------------------
await t("B3 a stray container.visible write outside the tick is detected and the bits converge", async () => {
  const { b } = await twin(cellsOff, cellsOn);
  const st = { player: OUT, indoor: false, frustum: [C(0), C(1), C(2), C(3)], walk: [], bfs: [] };
  const sh = R.makeSession(st);
  for (let f = 0; f < 4; f += 1) { R.tick(cellsOn, b, sh); R.renderPass(b, R.MASK_BOTH); }
  assert.equal(IB.interiorBatchDiag().chunks.active, 1, "premise: active");
  assert.equal(IB.interiorBatchDiag().bitMismatch, 0);
  // A writer that is not the tick hides cell 2 behind the batch's back. The
  // tick keeps it visible next frame (it is in the set and its visible loop
  // writes true) — so make the stray write stick: cell 2 leaves the set
  // without the hidden loop seeing it (registry swap trick: drop it from
  // lastVisible), the way an unknown writer would leave it.
  const c2 = b.scene3d.cellContainers3d.get(C(2));
  st.frustum = [C(0), C(1), C(3)];
  b.scene3d._lastCellVisibleSet.delete(C(2)); // the tick's hidden loop will not touch it
  c2.visible = false; // the stray write
  let seen = 0;
  for (let f = 0; f < IB.IB_BACKSTOP_SYNCS + 2 && seen === 0; f += 1) { R.tick(cellsOn, b, sh); seen = IB.interiorBatchDiag().bitMismatch; }
  assert.ok(seen > 0, "the backstop counted the disagreement");
  const S = IB.__interiorBatchStateForTest();
  const ib = c2.userData.__ib;
  assert.equal(ib.chunk.drawState[ib.cell], 0, "the bits followed the container");
  const e = ib.chunk.batches.flatMap((x) => x.entries).find((x) => x.cellIdx === ib.cell);
  assert.equal(IB.ibBitOf(S.bits.data, e.code, 0), 0);
});

// --- B4 -------------------------------------------------------------------------
await t("B4 recorded live walks (tests/fixtures/interior_batch_walk_*.json) replay through B2", async () => {
  const dir = path.join(HERE, "fixtures");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^interior_batch_walk_.*\.json$/.test(f)) : [];
  if (files.length === 0) { console.log("      (no recorded walks yet: window.__interiorBatch.recordWalk(n) on the next live session)"); return; }
  for (const f of files) {
    const rec = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    const frames = (rec.frames || rec).map((fr) => {
      // The recorded OUTPUT (the container.visible set) drives the fixture's
      // cells through the frustum set; the fixture LB stands in for the live one.
      const ids = new Set((fr.visible || []).map((v) => v & 0xfff));
      const fixture = R.CELL_IDS.filter((id) => ids.has(id & 0xfff));
      return { player: fr.isIndoor ? R.CELL(0) : OUT, indoor: !!fr.isIndoor, frustum: fixture, walk: fr.isIndoor ? fixture : [], bfs: [] };
    });
    const r = await runWalk(cellsOff, cellsOn, frames, f);
    assert.equal(r.diag.bitMismatch, 0, f);
  }
});

IB.disposeInteriorBatches();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
