// tests/helpers/gpu_particles_smoke_data.mjs — data + verdicts for the
// `?gpuParticles` (R3-7a) SwiftShader readback smoke
// (harness/glsl_smoke/gpu_particles_smoke.mjs + gpu_particles_page.html).
//
// buildSmokeData() runs gen_particles / corpus scenarios flag off and flag on in
// node (the real ParticleManager) and, at chosen ticks, dumps:
//   - the production GLSL header + call (gpu_particles.js),
//   - the record and row tables (Float32Array, base64),
//   - every gpu bucket instance: its record index, the program variant it was
//     drawn with (HB_GP_FXCOLOR / HB_FX_MOTION), the FLAG-OFF bucket's f32
//     instance matrix + colour (the CPU reference) and the f32 twin's output
//     (tests/helpers/gpu_particles_f32.mjs, for the velocity row);
//   - S5 specials: index 0, a zeroed record, a translucency >= 1 record;
//   - two large-clock replays (+12,345.678 s with no rebase, +16,000 s rebased).
// evaluateSmoke(data, result) turns the page's readback into the S1-S7 checks
// (S7's CPU projection: smokeExpectedPixel, tests/helpers/gpu_particles_smoke_scene.mjs,
// the module the page frames the case with).
// Only scenarios without gpu-ineligible emitters are dumped (no bucket splits).
// tests/gpu_particles.test.mjs section S runs both halves in node: the kernel
// verdicts on the header evaluated under SwiftShader's sin / cos, and S7's
// centroids through the program three r184 builds for the stock bucket.

import * as THREE from "three";

import * as GEN from "../../tools/rust_parity/gen_particles.mjs";
import { recordRng } from "../../tools/rust_parity/fixture_util.mjs";
import { makeCorpusScenario } from "./gpu_particles_corpus.mjs";
import { evalGpF32 } from "./gpu_particles_f32.mjs";
import { smokeExpectedPixel } from "./gpu_particles_smoke_scene.mjs";

const b64 = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString("base64");
export const fromB64 = (s) => {
  const b = Buffer.from(s, "base64");
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};

/** The scenario plan: [name, scenario factory, ticks to dump]. */
function plan(GP) {
  return [
    ["corpus", makeCorpusScenario(GEN, GP, { seed: 11, ticks: 40 }), [10, 25, 39]],
    ["facing", GEN.SCENARIOS.facing, [5, 15, 30]],
    ["dynamic", GEN.SCENARIOS.dynamic, [10, 40]],
    ["cull", GEN.SCENARIOS.cull, [45, 85]],
    ["twoManagers", GEN.NODE_ONLY_SCENARIOS.twoManagers, [10, 19]],
    ["clock12345", makeCorpusScenario(GEN, GP, { seed: 23, ticks: 30, clock: 12345.678, rebase: 1e9 }), [20, 29], true],
    ["clock16000", makeCorpusScenario(GEN, GP, { seed: 31, ticks: 30, clock: 16000 }), [20, 29], true],
  ];
}

async function runOne(M, GP, fn, on, want) {
  GP.__resetGpParticlesForTest();
  M.core.__setRustFlagForTest("gpuParticles", on);
  const h = new GEN.Harness(M, {
    onManager(mgr, index, hh) { hh.rngs.set(mgr, recordRng(0x0c0ffee + 977 * index).rng); },
  });
  const caps = new Map();
  let k = 0;
  const origTick = h.tick.bind(h);
  h.tick = async (dt) => {
    const snap = await origTick(dt);
    if (want.includes(k)) {
      const buckets = [];
      const one = (key, b, shared, mi) => {
        const im = b.im;
        const n = im.count | 0;
        buckets.push({
          key, shared, mi, n, gp: b.gp === true, alpha: b.alpha === true, fx: im.userData.particleFx === true,
          mat: Array.from(im.instanceMatrix.array.subarray(0, n * 16)), col: Array.from(im.instanceColor.array.subarray(0, n * 3)),
        });
      };
      h.mgrs.forEach((mgr, i) => { for (const [key, b] of mgr._instBuckets) one(key, b, false, i); });
      for (const [key, b] of M.pm.sharedAlphaBuckets.buckets) one(key, b, true, -1);
      const T = GP.gpTables();
      const legacy = [];
      for (const mgr of h.mgrs) for (const [, e] of mgr.particleTable) if (on && e._gp !== true && (e.numParticles | 0) > 0) legacy.push(e.id);
      caps.set(k, {
        buckets, legacy,
        rec: T ? Float32Array.from(T.records.data) : null, recRows: T ? T.records.rows : 0, recNext: T ? T.records.next : 0,
        row: T ? Float32Array.from(T.rows.data) : null, rowRows: T ? T.rows.rows : 0,
      });
    }
    k++;
    return snap;
  };
  try { await fn(h); } finally { M.time.setRng(null); M.core.__setRustFlagForTest("gpuParticles", undefined); GP.setGpRebaseSeconds(null); }
  return caps;
}

/** Build the smoke's input (JSON-safe). */
export async function buildSmokeData() {
  if (typeof globalThis.window === "undefined" || !globalThis.location) GEN.installGlobals("");
  const M = await GEN.loadModules();
  const GP = await import("../../scene3d/particles/gpu_particles.js");
  const motion = M.fx.particleFxMotionOn();
  const cases = [];
  const notes = [];
  for (const [name, fn, ticks, largeClock] of plan(GP)) {
    const off = await runOne(M, GP, fn, false, ticks);
    const on = await runOne(M, GP, fn, true, ticks);
    for (const tick of ticks) {
      const a = off.get(tick), b = on.get(tick);
      if (!a || !b || !b.rec) { notes.push(`${name}@${tick}: not captured`); continue; }
      if (b.legacy.length) { notes.push(`${name}@${tick}: legacy emitters ${b.legacy.join(",")} (skipped)`); continue; }
      const entries = [];
      const buckets = [];
      let drawsOff = 0, drawsOn = 0;
      for (const ob of a.buckets) if (ob.n > 0) drawsOff++;
      for (const nb of b.buckets) {
        if (nb.n > 0) drawsOn++;
        if (!nb.gp || nb.n === 0) continue;
        const ob = a.buckets.find((x) => x.key + "|gp" === nb.key && x.shared === nb.shared && (nb.shared || x.mi === nb.mi));
        if (!ob || ob.n !== nb.n) { notes.push(`${name}@${tick} ${nb.key}: no matching flag-off bucket`); continue; }
        const bi = buckets.length;
        const idx = [];
        for (let j = 0; j < nb.n; j++) {
          const rec = nb.col[j * 3];
          idx.push(rec);
          const tw = evalGpF32(b.rec, b.row, rec, { fxColor: nb.fx, fxMotion: nb.fx && motion });
          entries.push({
            b: bi, j, rec, fx: nb.fx, motion: nb.fx && motion,
            M: ob.mat.slice(j * 16, j * 16 + 16), C: ob.col.slice(j * 3, j * 3 + 3),
            tm: Array.from(tw.m), tc: Array.from(tw.c),
          });
        }
        buckets.push({ key: nb.key, alpha: nb.alpha, fx: nb.fx, idx });
      }
      cases.push({ name, tick, largeClock: !!largeClock, rec: b64(b.rec), recRows: b.recRows, row: b64(b.row), rowRows: b.rowRows,
        recNext: b.recNext, entries, buckets, drawsOff, drawsOn });
    }
  }
  // S5 specials on the first corpus case: index 0, a zeroed record, trans >= 1
  const c0 = cases[0];
  if (c0) {
    const rec = fromB64(c0.rec);
    const rows = c0.recRows + 1;
    const nd = new Float32Array(GP.GP_WIDTH * 4 * rows);
    nd.set(rec);
    const zero = c0.recRows * GP.GP_PER_ROW; // first record of the extra row: all zero
    const opaque = zero + 1;
    const src = c0.entries[0].rec;
    nd.set(rec.subarray(src * 32, src * 32 + 32), opaque * 32);
    nd[opaque * 32 + 5 * 4 + 2] = 1; // startTrans
    nd[opaque * 32 + 5 * 4 + 3] = 1; // finalTrans
    cases.push({ name: "special", tick: c0.tick, special: true, rec: b64(nd), recRows: rows, row: c0.row, rowRows: c0.rowRows,
      entries: [0, zero, opaque].map((r, j) => ({ b: -1, j, rec: r, fx: true, motion: motion, special: true })), buckets: [], drawsOff: 0, drawsOn: 0 });
  }
  return {
    three: THREE.REVISION,
    header: GP.GP_GLSL_HEADER,
    call: GP.GP_GLSL_CALL,
    width: GP.GP_WIDTH,
    motion,
    cases,
    notes,
  };
}

const ulp32 = (x) => {
  const a = Math.abs(Math.fround(x));
  if (a === 0) return 1.4e-45;
  return Math.pow(2, Math.floor(Math.log2(a)) - 23);
};

/**
 * The verdicts. `result` = the page's `window.__smoke`:
 *   { errors: [], programs: n, renderer,
 *     kernel: [{ caseIndex, out: [b64 x5] (per entry: 4 matrix columns + colour) }],
 *     prod: { compiled: [{ name, ok, log }], centroids: [{ caseIndex, b, j, x, y, cov, ortho }], fxCover: [{ name, cov }],
 *             calls: [{ caseIndex, on, off }], ortho: { left, right, bottom, top, W, H } } }
 */
export function evaluateSmoke(data, result) {
  const checks = [];
  const c = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail ?? "" });
  const r = result || {};
  const errors = [...(r.errors || []), ...(r.pageErrors || [])];
  const compiled = (r.prod && r.prod.compiled) || [];
  c("S1 every kernel + production program compiles and links (checkShaderErrors), no page / GL error",
    errors.length === 0 && (r.programs | 0) >= 2 && compiled.length > 0 && compiled.every((p) => p.ok),
    `${r.programs} kernel programs, ${compiled.length} production materials` + (errors.length ? "; " + errors.slice(0, 3).join(" | ") : "")
      + compiled.filter((p) => !p.ok).slice(0, 2).map((p) => ` ${p.name}: ${String(p.log).slice(0, 200)}`).join(""));
  const byName = new Map();
  let sN = 0, sBad = 0, s4N = 0, s4Bad = 0, colBad = 0, velN = 0, velBad = 0, s5Bad = 0, s5N = 0;
  const worst = { p: 0, r: 0, c: 0, v: 0 };
  const ex = [];
  const types = new Set();
  for (const k of r.kernel || []) {
    const cs = data.cases[k.caseIndex];
    if (!cs) continue;
    const outs = k.out.map(fromB64);
    for (let e = 0; e < cs.entries.length; e++) {
      const en = cs.entries[e];
      const m = new Float32Array(16);
      for (let col = 0; col < 4; col++) for (let q = 0; q < 4; q++) m[col * 4 + q] = outs[col][e * 4 + q];
      const cc = [outs[4][e * 4], outs[4][e * 4 + 1], outs[4][e * 4 + 2]];
      const rasterized = outs[4][e * 4 + 3] !== -12345;
      if (en.special) {
        s5N++;
        const allZero = rasterized && m.every((x) => x === 0) && cc.every((x) => x === 0);
        if (!allZero) { s5Bad++; ex.push(`S5 rec ${en.rec}: ${Array.from(m.slice(12, 15))} rasterized ${rasterized}`); }
        continue;
      }
      if (!rasterized) { sBad++; ex.push(`${cs.name} entry ${e} not rasterized`); continue; }
      // the record's ParticleType via its emitter row
      const rec = fromB64(cs.rec), row = fromB64(cs.row);
      const er = Math.round(rec[en.rec * 32 + 24]);
      types.add(Math.round(row[er * 32 + 12]));
      const M = en.M;
      const P = Math.hypot(M[12], M[13], M[14]);
      const dp = Math.hypot(m[12] - M[12], m[13] - M[13], m[14] - M[14]);
      const tolP = 1e-4 * Math.max(1, P) + 2 * ulp32(P);
      const sc = Math.hypot(M[0], M[1], M[2]);
      let dr = 0;
      for (const q of [0, 1, 2, 4, 5, 6, 8, 9, 10]) dr = Math.max(dr, Math.abs(m[q] - M[q]));
      const tolR = 1e-4 * Math.max(sc, 1);
      worst.p = Math.max(worst.p, dp / Math.max(1, P)); worst.r = Math.max(worst.r, dr / Math.max(sc, 1));
      const bad = dp > tolP || dr > tolR;
      if (cs.largeClock) { s4N++; if (bad) s4Bad++; } else { sN++; if (bad) sBad++; }
      if (bad && ex.length < 6) ex.push(`${cs.name}@${cs.tick} rec ${en.rec}: dP ${dp.toExponential(2)} dR ${dr.toExponential(2)}`);
      // S3 colour
      const dop = Math.abs(cc[0] - en.C[0]), dg = Math.abs(cc[1] - en.C[1]);
      const rowOk = en.fx ? Math.floor(cc[2]) === Math.floor(en.C[2]) : Math.abs(cc[2] - en.C[2]) <= 1e-4;
      worst.c = Math.max(worst.c, dop, dg);
      if (dop > 1e-4 || dg > 1e-4 || !rowOk) { colBad++; if (ex.length < 8) ex.push(`colour rec ${en.rec}: ${cc} vs ${en.C}`); }
      // S6 velocity row vs the analytic twin
      if (en.motion) {
        velN++;
        const vg = [m[3], m[7], m[11]], vt = [en.tm[3], en.tm[7], en.tm[11]];
        const dv = Math.hypot(vg[0] - vt[0], vg[1] - vt[1], vg[2] - vt[2]);
        const mag = Math.hypot(...vt);
        worst.v = Math.max(worst.v, dv / Math.max(mag, 1));
        if (dv > 1e-4 * Math.max(mag, 1)) { velBad++; if (ex.length < 10) ex.push(`velocity rec ${en.rec}: ${vg} vs ${vt}`); }
      }
    }
    byName.set(cs.name, true);
  }
  c("S2 kernel readback vs the flag-off CPU matrices within 1e-4 relative (every type, persistent / parented, billboard modes 0 / 2-5 / sprite)",
    sN > 200 && sBad === 0 && [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].every((t) => types.has(t)),
    `${sN} instances, ${sBad} off; types ${[...types].sort((a, b) => a - b)}; worst rel dP ${worst.p.toExponential(2)} dR ${worst.r.toExponential(2)}` + (ex.length ? "; " + ex.slice(0, 4).join(" | ") : ""));
  c("S3 colours: op and fxAge within 1e-4, the row part of b exact", colBad === 0 && sN > 0, `${colBad} off, worst ${worst.c.toExponential(2)}`);
  c("S4 the large-clock replays (+12,345.678 s hi/lo, +16,000 s rebased) meet S2", s4N > 50 && s4Bad === 0, `${s4N} instances, ${s4Bad} off`);
  c("S5 index 0, a zeroed record and trans >= 1 collapse (zero matrix + colour)", s5N === 3 && s5Bad === 0, `${s5N} specials, ${s5Bad} off`);
  c("S6 the HB_FX_MOTION velocity row vs the analytic twin within 1e-4 relative", velN > 20 && velBad === 0, `${velN} samples, ${velBad} off, worst ${worst.v.toExponential(2)}`);
  // S7 production centroids + draw counts
  const p = r.prod || {};
  let cN = 0, cBad = 0, cMiss = 0;
  for (const ce of p.centroids || []) {
    const cs = data.cases[ce.caseIndex];
    const en = cs && cs.entries.find((x) => x.b === ce.b && x.j === ce.j);
    const o = ce.ortho || p.ortho || null;
    if (!en || !o) continue;
    const [ex0, ey0] = smokeExpectedPixel(o, en.M[12], en.M[13]);
    if (!(ce.cov > 0)) { cMiss++; continue; }
    cN++;
    if (Math.hypot(ce.x - ex0, ce.y - ey0) > 1.0) { cBad++; if (ex.length < 12) ex.push(`centroid ${cs.name} ${ce.b}/${ce.j}: (${ce.x.toFixed(2)}, ${ce.y.toFixed(2)}) vs (${ex0.toFixed(2)}, ${ey0.toFixed(2)})`); }
  }
  const callsOk = (p.calls || []).length > 0 && (p.calls || []).every((x) => x.on === x.off);
  const dataDraws = data.cases.filter((x) => !x.special).every((x) => x.drawsOn === x.drawsOff);
  c("S7 production materials (real three r184 programs): coverage centroids within 1 px of the CPU projection; draw count == flag off",
    cN > 20 && cBad === 0 && cMiss <= Math.max(2, cN * 0.05) && callsOk && dataDraws && (p.fxCover || []).every((x) => x.cov > 0),
    `${cN} centroids, ${cBad} off, ${cMiss} uncovered; calls ${JSON.stringify((p.calls || []).slice(0, 4))}; fx cover ${JSON.stringify(p.fxCover || [])}`);
  return checks;
}

/**
 * Node dry run of evaluateSmoke: a readback synthesized from the f32 twin (what
 * a correct GPU returns), so the data layout and the verdict code are exercised
 * without a browser. Returns the checks.
 */
export function simulateKernelResult(data) {
  const kernel = [];
  data.cases.forEach((cs, ci) => {
    const rec = fromB64(cs.rec), row = fromB64(cs.row);
    const outs = [0, 1, 2, 3, 4].map(() => new Float32Array(cs.entries.length * 4).fill(-12345));
    cs.entries.forEach((en, e) => {
      const r = evalGpF32(rec, row, en.rec, { fxColor: en.fx, fxMotion: en.motion });
      for (let col = 0; col < 4; col++) for (let q = 0; q < 4; q++) outs[col][e * 4 + q] = r.m[col * 4 + q];
      outs[4][e * 4] = r.c[0]; outs[4][e * 4 + 1] = r.c[1]; outs[4][e * 4 + 2] = r.c[2]; outs[4][e * 4 + 3] = 1;
    });
    kernel.push({ caseIndex: ci, out: outs.map(b64) });
  });
  return { errors: [], programs: 4, kernel, prod: null };
}
