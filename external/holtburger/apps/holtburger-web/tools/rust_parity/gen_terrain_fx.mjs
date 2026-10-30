// tools/rust_parity/gen_terrain_fx.mjs — the REAL terrain_scatter.js pool as
// the reference for crates/holtburger-scene/src/terrain_fx.rs (the per-frame
// re-scatter planner; tests/terrain_fx_parity.rs) and
// tests/rust_terrain_fx_parity.test.mjs. Lane notes:
// docs/2026-10-26-rust-anim-terrain.md.
//
// Each case builds a pool with createScatterPool (no planner: this file's
// loops, as shipped) over a stub of the terrain oracle's sample() contract
// (landblocks that bake late, a pointwise hole, roads, families), walks it
// along a scripted path (standing, walking, running diagonally across
// landblock lines, a teleport, invalidate() calls), and records, per frame,
// EVERY scatterInstance call in order — (i, gx, gy) and the resolvedFlags /
// outFlags it left — by wrapping the pool's cellX / cellY / resolvedFlags /
// outFlags typed arrays in recording proxies while the pool is constructed.
// Floats as hex (fixture_util.mjs); indices and flags as integers.
//
// Run (from apps/holtburger-web): node tools/rust_parity/gen_terrain_fx.mjs
// → crates/holtburger-scene/tests/fixtures/terrain_fx.json

import { f64hex, writeFixture } from "./fixture_util.mjs";

const scatterModule = process.env.HB_SCATTER_MODULE || "../../scene3d/terrain_scatter.js";
const SC = await import(scatterModule);
const FAM = await import("../../scene3d/terrain_families.js");

// ---------------------------------------------------------------------------
// The stub oracle: terrain_oracle.js sample(x, y, out) contract.
// ---------------------------------------------------------------------------
export function makeOracle(env) {
  return {
    sample(x, y, out) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const lbX = Math.floor(x / 192);
      const lbY = Math.floor(y / 192);
      if (lbX < 0 || lbX > 255 || lbY < 0 || lbY > 255) return null;
      if (!env.baked(lbX, lbY)) return null;
      if (env.hole && env.hole(x, y)) return null; // a pointwise miss (stress)
      const r = out || {};
      // Codes vary by 24 m vertex cell: mostly rock, some sand / grass.
      const vx = Math.round((x - lbX * 192) / 24), vy = Math.round((y - lbY * 192) / 24);
      const h = SC.scatterHashU32(lbX * 9 + vx, lbY * 9 + vy, 5, 0x1234);
      const code = h % 7 === 0 ? 1 : (h % 5 === 0 ? 3 : 13); // 1 grass, 3 sand, 13 SedimentaryRock
      let corners = r.cornerCodes;
      if (!corners || corners.length !== 4) { corners = new Uint8Array(4); r.cornerCodes = corners; }
      corners[0] = code; corners[1] = code; corners[2] = code; corners[3] = code;
      r.code = code;
      r.family = FAM.familyForCode(code);
      r.lbX = lbX; r.lbY = lbY; r.lbKey = ((lbX & 0xff) << 24) | ((lbY & 0xff) << 16);
      r.hasHeight = true;
      r.height = 20 + 0.01 * x - 0.015 * y;
      // A road along y = 34620 (+-4 m painted) through the walk.
      r.hasRoads = true;
      r.roadEdgeM = Math.abs(y - 34620) - 4;
      let n = r.normal;
      if (!n || typeof n !== "object") { n = { x: 0, y: 0, z: 1 }; r.normal = n; }
      n.x = -0.01; n.y = 0.015; n.z = 1;
      return r;
    },
  };
}

// ---------------------------------------------------------------------------
// Recording proxies on the pool's per-instance arrays.
// ---------------------------------------------------------------------------
function withRecordedArrays(count, build) {
  const RealI32 = globalThis.Int32Array;
  const RealU8 = globalThis.Uint8Array;
  const rec = { log: null, cellX: null, cellY: null, live: null, resolved: null, out: null };
  const i32 = [];
  const u8 = [];
  const wrap = (target, onSet) => new Proxy(target, {
    get(t, k) {
      const v = t[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
    set(t, k, v) {
      t[k] = v;
      if (onSet && typeof k === "string" && k.length > 0 && k.charCodeAt(0) >= 48 && k.charCodeAt(0) <= 57) onSet(+k, t[k]);
      return true;
    },
  });
  function finalizeLast() {
    const L = rec.log;
    if (!L || L.length === 0) return;
    const last = L[L.length - 1];
    if (last.length === 3) last.push(rec.resolved[last[0]], rec.out[last[0]]);
  }
  globalThis.Int32Array = new Proxy(RealI32, {
    construct(T, args) {
      const a = new T(...args);
      if (args.length === 1 && args[0] === count && i32.length < 2) {
        i32.push(a);
        if (i32.length === 1) {
          rec.cellX = a;
          return wrap(a, (i, v) => {
            if (!rec.log) return;
            finalizeLast();
            rec.log.push([i, v]);
          });
        }
        rec.cellY = a;
        return wrap(a, (i, v) => {
          if (!rec.log) return;
          const last = rec.log[rec.log.length - 1];
          if (last && last.length === 2 && last[0] === i) last.push(v);
        });
      }
      return a;
    },
  });
  globalThis.Uint8Array = new Proxy(RealU8, {
    construct(T, args) {
      const a = new T(...args);
      if (args.length === 1 && args[0] === count && u8.length < 3) {
        u8.push(a);
        if (u8.length === 1) rec.live = a;
        if (u8.length === 2) rec.resolved = a;
        if (u8.length === 3) rec.out = a;
        return wrap(a, null);
      }
      return a;
    },
  });
  let pool;
  try {
    pool = build();
  } finally {
    globalThis.Int32Array = RealI32;
    globalThis.Uint8Array = RealU8;
  }
  if (!rec.cellX || !rec.cellY || !rec.resolved || !rec.out) throw new Error("recording arrays not captured");
  return { pool, rec, begin() { rec.log = []; }, end() { finalizeLast(); const L = rec.log; rec.log = null; return L; } };
}

// ---------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------

const ROCK_LB_X = 0xa9 * 192, ROCK_LB_Y = 0xb4 * 192; // Holtburg-ish world metres

/** The scripted path: [x, y] per frame. */
export function walkPath(kind) {
  const out = [];
  let x = ROCK_LB_X + 180, y = ROCK_LB_Y + 60; // near the LB's east edge
  const push = () => out.push([x, y]);
  if (kind === "zigzag") {
    // Fast enough to out-run a tiny edge budget (lines carried across frames,
    // drained part-way), then BACK over the same slots (a queued line is
    // re-enqueued: it restarts in place), then diagonal both ways.
    for (let f = 0; f < 4; f++) push();
    for (let f = 0; f < 18; f++) { x += 1.3; push(); }
    for (let f = 0; f < 9; f++) { x -= 1.1; push(); }
    for (let f = 0; f < 14; f++) { x += 0.9; y += 1.2; push(); }
    for (let f = 0; f < 10; f++) { x -= 0.4; y -= 1.5; push(); }
    for (let f = 0; f < 30; f++) push();                      // standing: the backlog drains
    for (let f = 0; f < 25; f++) { y += 2.1; push(); }        // sprint N
    return out;
  }
  for (let f = 0; f < 6; f++) push();                         // standing
  for (let f = 0; f < 40; f++) { x += 0.21; push(); }          // walking east, across the LB line
  for (let f = 0; f < 50; f++) { x += 0.37; y += 0.29; push(); } // running NE
  if (kind !== "short") {
    for (let f = 0; f < 3; f++) push();                       // stop
    x += 640; y -= 410; push();                               // teleport (> one landblock)
    for (let f = 0; f < 30; f++) { x -= 0.55; y -= 0.42; push(); } // fast SW
    for (let f = 0; f < 20; f++) { x += 0.03 * Math.sin(f); y += 1.3; push(); } // sprint N (backlog)
  }
  return out;
}

export const CASES = [
  {
    name: "pebbles",
    opts: { count: 2500, radiusM: 40, seed: 0x520c4bed, randSalt: 0x3b, shape: "disc", jitter: 1, fadeFraction: 0.22,
      families: [FAM.FAM_ROCK], offRoad: true, offRoadVergeM: 0.5,
      attributes: [{ name: "aOffset", itemSize: 3 }, { name: "aScale", itemSize: 3 }, { name: "aNormal", itemSize: 3 }, { name: "aRock", itemSize: 3 }] },
    accept: true,
    path: "long",
  },
  {
    name: "grit",
    opts: { count: 400, radiusM: 56, seed: (0x520c4bed ^ 0x47524954) | 0, randSalt: 0x4c, shape: "disc", jitter: 1, fadeFraction: 0.25,
      families: [FAM.FAM_ROCK], attributes: [{ name: "aOffset", itemSize: 3 }, { name: "aScale", itemSize: 2 }, { name: "aGrit", itemSize: 4 }] },
    path: "long",
  },
  {
    name: "square-tight",
    opts: { count: 1600, radiusM: 30, seed: 0x5eed, shape: "square", jitter: 0.5, sliceSize: 64, scanBudget: 256, edgeBudget: 96,
      families: [FAM.FAM_SAND, FAM.FAM_ROCK], attributes: [{ name: "aOffset", itemSize: 3 }, { name: "aScale", itemSize: 2 }] },
    path: "long",
  },
  {
    name: "backlog-restart",
    opts: { count: 2500, radiusM: 20, seed: 0x0badf00d, shape: "disc", jitter: 1, sliceSize: 16, scanBudget: 64, edgeBudget: 24,
      families: [FAM.FAM_ROCK, FAM.FAM_SAND], attributes: [{ name: "aOffset", itemSize: 3 }, { name: "aScale", itemSize: 3 }] },
    path: "zigzag",
  },
  {
    name: "wide-backlog",
    opts: { count: 900, radiusM: 72, seed: -12345, shape: "disc", jitter: 0.8, sliceSize: 100, scanBudget: 300,
      attributes: [{ name: "aOffset", itemSize: 3 }, { name: "aScale", itemSize: 3 }] },
    hole: true,
    path: "long",
  },
];

/** The environment of a case: which landblocks are baked at which frame. */
export function makeEnv(c) {
  const env = { frame: 0 };
  env.baked = (lbX, lbY) => {
    // The start LB is baked; its east neighbour bakes at frame 30, the NE one
    // at 70; everything around the teleport target from frame 100 on, except
    // one that never bakes.
    if (lbX === 0xa9 && lbY === 0xb4) return true;
    if (lbX === 0xaa && lbY === 0xb4) return env.frame >= 30;
    if (lbX === 0xaa && lbY === 0xb5) return env.frame >= 70;
    if (lbX === 0xa9 && lbY === 0xb5) return env.frame >= 12;
    if (lbX >= 0xab && lbX <= 0xad && lbY >= 0xb1 && lbY <= 0xb6) return env.frame >= 100 && !(lbX === 0xac && lbY === 0xb2);
    return env.frame >= 40;
  };
  if (c.hole) env.hole = (x, y) => ((Math.floor(x / 7) * 31 + Math.floor(y / 5)) % 23) === 0;
  return env;
}

/** Build a case's pool (optionally with a planner) over its oracle. */
export function buildPool(SCmod, c, env, scanPlanner, extra) {
  const oracle = extra?.oracle || makeOracle(env);
  const o = { ...c.opts, ...(extra || {}), oracle: () => oracle, scanPlanner: scanPlanner || null };
  if (c.accept) o.accept = (s, ctx) => ctx.rand(9) < 0.8;
  o.fill = (ctx) => {
    if (ctx.arrays.aRock) ctx.set("aRock", ctx.rand(8) * 6.283, (ctx.rand(10) - 0.5) * 0.4, 0);
    if (ctx.arrays.aGrit) ctx.set("aGrit", ctx.rand(5), ctx.rand(6), ctx.rand(7), ctx.rand(8));
    if (ctx.rand(11) < 0.03) ctx.live = false; // a fill reject
    ctx.z += 0.02;
  };
  return SCmod.createScatterPool(o);
}

/** Frames at which a case calls invalidate() before its update. */
export const INVALIDATE_AT = new Set([55, 125]);

/** Record one case through the real pool (see the header). */
export function recordCase(c) {
  const env = makeEnv(c);
  const probe = buildPool(SC, c, env); // derived constants (no recording)
  const count = probe.count;
  const st0 = probe.stats();
  const cfg = {
    count, gridSize: probe.gridSize, cellSizeM: f64hex(probe.cellSizeM), radiusM: f64hex(probe.radiusM),
    jitter: f64hex(c.opts.jitter ?? 1), seed: probe.seed | 0, disc: st0.shape !== "square",
    scanBudget: st0.scanBudget, sliceSize: st0.sliceSize, edgeBudget: st0.edgeBudget,
  };
  probe.dispose();
  const R = withRecordedArrays(count, () => buildPool(SC, c, env));
  const pool = R.pool;
  const frames = [];
  const path = walkPath(c.path);
  for (let f = 0; f < path.length; f++) {
    env.frame = f;
    const [x, y] = path[f];
    const ev = { frame: f };
    if (INVALIDATE_AT.has(f)) { pool.invalidate(); ev.invalidate = true; }
    const before = pool.stats();
    R.begin();
    pool.update(1 / 60, x, y, 20);
    const scatters = R.end();
    const after = pool.stats();
    ev.kind = after.fullRescatters > before.fullRescatters ? "rescatterAll" : "update";
    ev.cx = f64hex(x);
    ev.cy = f64hex(y);
    ev.gxMin = Math.floor((x - pool.radiusM) / pool.cellSizeM);
    ev.gyMin = Math.floor((y - pool.radiusM) / pool.cellSizeM);
    ev.scatters = scatters;
    ev.written = after.lastRescattered;
    ev.scanned = after.lastScanned;
    ev.cursor = after.cursor;
    ev.edgeWritten = after.edgeRescatters - before.edgeRescatters;
    ev.edgePending = after.edgePending;
    frames.push(ev);
  }
  const fin = pool.stats();
  pool.dispose();
  return { name: c.name, cfg, frames, totals: { rescatters: fin.rescatters, fullRescatters: fin.fullRescatters, teleports: fin.teleports, nullSamples: fin.nullSamples } };
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("gen_terrain_fx.mjs");
if (isMain) {
  const cases = CASES.map(recordCase);
  const path = writeFixture("terrain_fx", { cases });
  for (const c of cases) {
    const n = c.frames.reduce((a, f) => a + f.scatters.length, 0);
    console.log(`  ${c.name}: ${c.frames.length} frames, ${n} scatters, totals ${JSON.stringify(c.totals)}`);
  }
  console.log(`wrote ${cases.length} cases → ${path}`);
}
