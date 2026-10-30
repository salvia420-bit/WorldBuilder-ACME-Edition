// tests/rust_terrain_fx_parity.test.mjs — `?rustTerrainFx` (the scatter
// pool's per-frame re-scatter PLAN in Rust) against the pool's own loops,
// through the REAL bridge (scene3d/rust/terrain_fx.js) and the REAL hook in
// scene3d/terrain_scatter.js (`opts.scanPlanner`), into REAL three r184
// InstancedMesh buffers. Lane notes: docs/2026-10-26-rust-anim-terrain.md.
//
// Part 1 (always runs; no wasm needed) — against `ModelSceneScatterPlanner`
// (tools/rust_parity/model_terrain_fx.mjs, a line-for-line JS transcription
// of crates/holtburger-scene/src/terrain_fx.rs) on a fake wasm memory:
//   F  the checked-in fixture (crates/holtburger-scene/tests/fixtures/
//      terrain_fx.json) still equals what today's pool records, and the model
//      replays every case exactly (each scatter, in order; written / scanned /
//      cursor / edge counts; queued lines; zero outFlags disagreements);
//   C  every gen_terrain_fx case, flag off (the pool's loops) vs the planner,
//      headless AND with three (InstancedMesh + InstancedBufferAttributes):
//      every attribute array, the instanceMatrix, the upload ranges, the
//      per-instance flags / cells, the oracle call sequence and the pool
//      stats, frame by frame — identical;
//   R  the real rock fields (terrain_rock.js createPebbleField /
//      createGritField with three: their own fill, gates, light and grit
//      travel), flag off vs on — identical buffers and uniforms;
//   Q  the pool's other consumers — terrain_grass.js (CPU path, one field and
//      three LOD rings, off-road toggles, a region invalidation) and
//      ground_fog.js — flag off vs on, once they opt in (SKIP lines until then);
//   X  a kernel that throws mid-session: the pool falls back to its loops
//      and keeps running.
// Part 2 (after the orchestrator's wasm build) — F and C against the COMPILED
//   `SceneScatterPlanner` from `${HB_PKG || "pkg"}/` (exact: no trig in this
//   kernel). Prints `SKIP — …` and exits 0 (when Part 1 passed) if absent.
//
// Run: node tests/rust_terrain_fx_parity.test.mjs   (HB_PKG=pkg-rustcore for a dev build)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const pkgDir = process.env.HB_PKG || "pkg";

const THREE = await import("three");
const SC = await import("../scene3d/terrain_scatter.js");
const gen = await import("../tools/rust_parity/gen_terrain_fx.mjs");
const model = await import("../tools/rust_parity/model_terrain_fx.mjs");
const core = await import("../scene3d/rust/scene_core.js");
const bridge = await import("../scene3d/rust/terrain_fx.js");
const fu = await import("../tools/rust_parity/fixture_util.mjs");
const ROCK = await import("../scene3d/terrain_rock.js");

let passed = 0, failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail != null && detail !== "" ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}

// ---------------------------------------------------------------------------
// Digests of what a pool leaves in its buffers.
// ---------------------------------------------------------------------------
function fold(h, a) {
  if (!a) return Math.imul(h ^ 0x9e3779b9, 16777619) >>> 0;
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const n4 = bytes.length >> 2;
  const u = new Uint32Array(a.buffer, a.byteOffset, n4);
  for (let i = 0; i < n4; i++) h = Math.imul(h ^ u[i], 16777619) >>> 0;
  for (let i = n4 << 2; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
  return h;
}
function poolDigest(pool) {
  let h = 2166136261;
  for (const name of Object.keys(pool.arrays).sort()) h = fold(h, pool.arrays[name]);
  h = fold(h, pool._cellX);
  h = fold(h, pool._cellY);
  h = fold(h, pool._live);
  h = fold(h, pool._resolved);
  const m = pool.mesh;
  if (m) {
    h = fold(h, m.instanceMatrix.array);
    h = Math.imul(h ^ m.instanceMatrix.version, 16777619) >>> 0;
  }
  return h;
}
function rangesOf(pool) {
  const out = [];
  const m = pool.mesh;
  if (!m) return "[]";
  out.push(m.instanceMatrix.updateRanges.map((r) => [r.start, r.count]));
  for (const name of Object.keys(pool.attributes).sort()) {
    const a = pool.attributes[name];
    out.push([name, a.version, a.updateRanges.map((r) => [r.start, r.count])]);
  }
  return JSON.stringify(out);
}
const STAT_KEYS = ["centerX", "centerY", "cursor", "frames", "scans", "rescatters", "lastScanned", "lastRescattered",
  "fullRescatters", "teleports", "live", "degenerate", "nullSamples", "familyRejects", "roadRejects", "excludeRejects",
  "edgeRescatters", "edgePending", "outOfRange", "noHeight", "fillRejects", "fillErrors", "allocations"];
function statsOf(pool) {
  const s = pool.stats();
  return JSON.stringify(STAT_KEYS.map((k) => s[k]));
}

/** A counting oracle wrapper: folds every sample's (x, y) and result. */
function tracedOracle(env) {
  const inner = gen.makeOracle(env);
  const tr = { h: 2166136261, n: 0 };
  const dv = new DataView(new ArrayBuffer(16));
  return {
    tr,
    sample(x, y, out) {
      const r = inner.sample(x, y, out);
      dv.setFloat64(0, x); dv.setFloat64(8, y);
      for (let i = 0; i < 4; i++) tr.h = Math.imul(tr.h ^ dv.getUint32(i * 4), 16777619) >>> 0;
      tr.h = Math.imul(tr.h ^ (r ? 1 : 0), 16777619) >>> 0;
      tr.n += 1;
      return r;
    },
  };
}

function makeGpuOpts() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  return { THREE, geometry, material: new THREE.MeshBasicMaterial() };
}

/** Run one gen case; `planner`: factory or null. Per-frame digests. */
function runPoolCase(c, planner, withThree) {
  const env = gen.makeEnv(c);
  const oracle = tracedOracle(env);
  const extra = { oracle, ...(withThree ? makeGpuOpts() : {}) };
  const pool = gen.buildPool(SC, c, env, planner, extra);
  const frames = [];
  const path = gen.walkPath(c.path);
  for (let f = 0; f < path.length; f++) {
    env.frame = f;
    if (gen.INVALIDATE_AT.has(f)) pool.invalidate();
    // An interior-mask style region invalidation mid-walk (syncResolved path).
    if (f === 77) pool.invalidateRegion(path[f][0] - 6, path[f][1] - 6, path[f][0] + 6, path[f][1] + 6);
    const [x, y] = path[f];
    const r = pool.update(1 / 60, x, y, 20);
    frames.push({ r, d: poolDigest(pool), ranges: rangesOf(pool), stats: statsOf(pool), oracle: `${oracle.tr.n}:${oracle.tr.h}` });
  }
  const st = pool.stats();
  pool.dispose();
  return { frames, planner: st.scanPlanner || null };
}

function compareFrames(label, a, b) {
  let first = -1, what = "";
  for (let i = 0; i < a.frames.length; i++) {
    const x = a.frames[i], y = b.frames[i];
    if (!y) { first = i; what = "missing frame"; break; }
    for (const k of ["r", "d", "ranges", "stats", "oracle"]) {
      if (x[k] !== y[k]) { first = i; what = k; break; }
    }
    if (first >= 0) break;
  }
  check(label, first < 0 && a.frames.length === b.frames.length,
    first < 0 ? `${a.frames.length} frames identical${b.planner ? `; planner stops ${b.planner.stops}, desync ${b.planner.desync}` : ""}`
      : `first difference at frame ${first} (${what})`);
}

// ---------------------------------------------------------------------------
// R — the real rock fields.
// ---------------------------------------------------------------------------
function runRock(flagOn) {
  bridge.__setRustTerrainFxForTest(flagOn);
  const c = gen.CASES[0];
  const env = gen.makeEnv(c);
  const oracle = tracedOracle(env);
  const globals = { uTime: { value: 0 }, uWindDir: { value: new THREE.Vector2(0.6, -0.4) } };
  const peb = ROCK.createPebbleField({ THREE, oracle: () => oracle, globals, count: 2500, radiusM: 40, offRoad: true });
  const grit = ROCK.createGritField({ THREE, oracle: () => oracle, globals, count: 400, radiusM: 56 });
  const sky = { dirHeading: 135, dirPitch: 40, dirBright: 0.9, dirColorArgb: 0xffeeddcc, ambColorArgb: 0xff556677, ambBright: 0.4 };
  const path = gen.walkPath("long");
  const frames = [];
  for (let f = 0; f < path.length; f++) {
    env.frame = f;
    const [x, y] = path[f];
    globals.uWindDir.value.set(0.6 + 0.1 * Math.sin(f * 0.1), -0.4);
    const a = peb.update(1 / 60, f / 60, x, y, 20, sky);
    const b = grit.update(1 / 60, f / 60, x, y, 20);
    const u = grit.uniforms;
    frames.push({
      r: `${a}/${b}`,
      d: `${poolDigest(peb.pool)}/${poolDigest(grit.pool)}`,
      ranges: rangesOf(peb.pool) + rangesOf(grit.pool),
      stats: statsOf(peb.pool) + statsOf(grit.pool),
      oracle: `${oracle.tr.n}:${oracle.tr.h}:${u.uTravel.value}:${u.uPulseOffset.value.x}:${u.uPulseOffset.value.y}`,
    });
  }
  const st = { peb: peb.pool.stats().scanPlanner || null, grit: grit.pool.stats().scanPlanner || null };
  peb.dispose();
  grit.dispose();
  bridge.__setRustTerrainFxForTest(undefined);
  return { frames, planner: st.peb, both: st };
}

// ---------------------------------------------------------------------------
// Q — the pool's other consumers (terrain_grass.js CPU path, ground_fog.js).
// They opt in with one line each (`scanPlanner: rustScatterPlanner()`); until
// they do, their flag-on run has no planner and the check prints a SKIP line.
// ---------------------------------------------------------------------------
// HB_GRASS_MODULE / HB_FOG_MODULE: test seam — point Q at a patched copy.
const GRASS = await import(process.env.HB_GRASS_MODULE || "../scene3d/terrain_grass.js");
const FOG = await import(process.env.HB_FOG_MODULE || "../scene3d/ground_fog.js");
const FAM = await import("../scene3d/terrain_families.js");

/** A stub oracle with grass, swamp and rock codes, varied corner codes, late
 *  landblocks and a road (the real sample() contract), call-traced. */
function familyOracle(env) {
  const tr = { n: 0, h: 2166136261 };
  const dv = new DataView(new ArrayBuffer(16));
  const CODES = [1, 4, 9, 13, 21, 3, 4, 28];
  return {
    tr,
    sample(x, y, out) {
      tr.n += 1;
      dv.setFloat64(0, x); dv.setFloat64(8, y);
      for (let i = 0; i < 4; i++) tr.h = Math.imul(tr.h ^ dv.getUint32(i * 4), 16777619) >>> 0;
      const lbX = Math.floor(x / 192), lbY = Math.floor(y / 192);
      if (!env.baked(lbX, lbY)) { tr.h = Math.imul(tr.h ^ 7, 16777619) >>> 0; return null; }
      const r = out || {};
      const vx = Math.round((x - lbX * 192) / 24), vy = Math.round((y - lbY * 192) / 24);
      const code = CODES[SC.scatterHashU32(lbX * 9 + vx, lbY * 9 + vy, 5, 0x77) % CODES.length];
      let c = r.cornerCodes;
      if (!c || c.length !== 4) { c = new Uint8Array(4); r.cornerCodes = c; }
      c[0] = code; c[1] = CODES[(code + 1) % CODES.length]; c[2] = code; c[3] = CODES[(code + 3) % CODES.length];
      r.code = code; r.family = FAM.familyForCode(code); r.lbX = lbX; r.lbY = lbY; r.lbKey = ((lbX & 0xff) << 24) | ((lbY & 0xff) << 16);
      r.hasHeight = true; r.height = 20 + 0.01 * x - 0.015 * y;
      r.hasRoads = true; r.roadEdgeM = Math.abs(y - 34620) - 4;
      let n = r.normal;
      if (!n || typeof n !== "object") { n = { x: 0, y: 0, z: 1 }; r.normal = n; }
      n.x = -0.01; n.y = 0.015; n.z = 1;
      return r;
    },
  };
}
function runGrassField(reach, flagOn) {
  bridge.__setRustTerrainFxForTest(flagOn);
  const env = gen.makeEnv(gen.CASES[0]);
  const oracle = familyOracle(env);
  const p = GRASS.createTerrainGrassProvider({ THREE, parent: new THREE.Group(),
    config: { blades: 4096, density: 1, radiusM: 30, stomp: false, offRoad: true, seed: 7777, reach, gpu: false } });
  const path = gen.walkPath("long");
  const frames = [];
  for (let f = 0; f < path.length; f++) {
    env.frame = f;
    if (f === 40) p.setOffRoad(false);
    if (f === 60) p.setOffRoad(true);
    if (f === 77) for (const pool of p._pools) pool.invalidateRegion(path[f][0] - 9, path[f][1] - 9, path[f][0] + 9, path[f][1] + 9);
    p.update(1 / 60, { scene3d: null, tSec: f / 60, dt: 1 / 60, playerPos: { x: path[f][0], y: path[f][1], z: 20 }, hasPlayer: true,
      camera: null, quality: null, oracle, trail: null });
    const pools = p._pools;
    frames.push({ r: pools.map((q) => q.stats().lastRescattered).join(), d: pools.map(poolDigest).join(), ranges: pools.map(rangesOf).join(),
      stats: pools.map(statsOf).join(), oracle: `${oracle.tr.n}:${oracle.tr.h}` });
  }
  const planners = p._pools.map((q) => q.stats().scanPlanner || null);
  try { p.dispose(); } catch (_) { /* fail-soft */ }
  bridge.__setRustTerrainFxForTest(undefined);
  return { frames, planner: planners[0] || null, planners };
}
function runFogField(flagOn) {
  bridge.__setRustTerrainFxForTest(flagOn);
  const env = gen.makeEnv(gen.CASES[0]);
  const oracle = familyOracle(env);
  const fog = FOG.createGroundFog({ THREE, name: "fog", oracle: () => oracle, families: [FAM.FAM_SWAMP], count: 24, radiusM: 56, seed: 0x1234 });
  const path = gen.walkPath("long");
  const frames = [];
  for (let f = 0; f < path.length; f++) {
    env.frame = f;
    if (f === 55) fog.pool.invalidate();
    const r = fog.update(1 / 60, f / 60, path[f][0], path[f][1], 20);
    frames.push({ r, d: poolDigest(fog.pool), ranges: rangesOf(fog.pool), stats: statsOf(fog.pool), oracle: `${oracle.tr.n}:${oracle.tr.h}` });
  }
  const planner = fog.pool.stats().scanPlanner || null;
  try { fog.dispose(); } catch (_) { /* fail-soft */ }
  bridge.__setRustTerrainFxForTest(undefined);
  return { frames, planner, planners: [planner] };
}
function familyChecks(tag) {
  for (const reach of [1, 4]) {
    const off = runGrassField(reach, false);
    const on = runGrassField(reach, true);
    if (on.planners.some((x) => x === null)) {
      console.log(`  [SKIP] ${tag} grass (CPU path, reach ${reach}) — terrain_grass.js does not pass scanPlanner: rustScatterPlanner()`);
      continue;
    }
    check(`${tag} grass (CPU path, reach ${reach}, ${on.planners.length} ring(s)) on the planner, no desync`,
      on.planners.every((x) => x.failed === false && x.desync === 0), JSON.stringify(on.planners.map((x) => x.stops)));
    compareFrames(`${tag} grass (CPU path, reach ${reach}): every ring's buffers, ranges, flags, oracle calls, stats`, off, on);
  }
  const off = runFogField(false);
  const on = runFogField(true);
  if (on.planner === null) {
    console.log(`  [SKIP] ${tag} ground fog — ground_fog.js does not pass scanPlanner: rustScatterPlanner()`);
  } else {
    compareFrames(`${tag} ground fog: buffers, ranges, flags, oracle calls, stats`, off, on);
  }
}

// ---------------------------------------------------------------------------
// Part 1 — the model.
// ---------------------------------------------------------------------------
console.log("rust terrain fx parity — Part 1 (model kernel, no wasm)");

let fixture = null;
try {
  fixture = JSON.parse(readFileSync(join(fu.FIXTURE_DIR, "terrain_fx.json"), "utf8"));
} catch (e) {
  check("F fixture present (node tools/rust_parity/gen_terrain_fx.mjs)", false, String(e.message).slice(0, 80));
}
if (fixture) {
  let stale = fixture.cases.length !== gen.CASES.length;
  for (let i = 0; !stale && i < gen.CASES.length; i++) {
    const now = gen.recordCase(gen.CASES[i]);
    if (JSON.stringify(now) !== JSON.stringify(fixture.cases[i])) stale = true;
  }
  check("F the checked-in fixture equals what today's pool records (regenerate with gen_terrain_fx.mjs if not)", !stale);
  for (const c of fixture.cases) {
    const r = model.replayCase(c,
      (...a) => model.ModelScatterPlanner.create({ count: a[0], grid: a[1], cellSize: a[2], radius: a[3], jitter: a[4], seed: a[5],
        disc: a[6], scanBudget: a[7], sliceSize: a[8], edgeBudget: a[9] }),
      { batch: (p) => p.batch, outcome: (p) => p.outcome, stats: (p) => p.stats, queued: (p) => p.lines.length });
    check(`F model replays "${c.name}" exactly`, r.bad === 0, r.bad ? r.notes.join(" | ") : `${r.frames} frames`);
  }
}

const M = model.makeModelPlannerNamespace(core.SCENE_CORE_ABI);
core.__setSceneWasmForTest(M.ns, M.memory);
bridge.__setRustTerrainFxForTest(true);
const factory = bridge.rustScatterPlanner();
check("C the bridge hands out a planner factory with the flag on", !!factory && typeof factory.attach === "function");
for (const c of gen.CASES) {
  for (const withThree of [false, true]) {
    const off = runPoolCase(c, null, withThree);
    const on = runPoolCase(c, factory, withThree);
    check(`C "${c.name}" (${withThree ? "three" : "headless"}) ran on the planner`, !!on.planner && on.planner.failed === false && on.planner.desync === 0,
      JSON.stringify(on.planner));
    compareFrames(`C "${c.name}" (${withThree ? "three" : "headless"}): buffers, ranges, flags, oracle calls, stats`, off, on);
  }
}
check("C the fake memory grew during the runs (views re-created)", M.grows() > 0, `grows=${M.grows()}`);
bridge.__setRustTerrainFxForTest(undefined);
{
  const off = runRock(false);
  const on = runRock(true);
  check("R the rock fields' pools ran on the planner", !!on.both.peb && !!on.both.grit && on.both.peb.desync === 0 && on.both.grit.desync === 0,
    JSON.stringify(on.both));
  compareFrames("R rock pebbles + grit (three): buffers, ranges, stats, oracle, grit travel", off, on);
}

familyChecks("Q");

// X — a kernel that throws mid-session.
{
  const real = M.ns.SceneScatterPlanner;
  class Throwing extends real {
    constructor(...a) { super(...a); this._n = 0; }
    begin(...a) { if (++this._n > 20) throw new Error("trap"); return super.begin(...a); }
  }
  core.__setSceneWasmForTest({ ...M.ns, SceneScatterPlanner: Throwing }, M.memory);
  bridge.__setRustTerrainFxForTest(true);
  const c = gen.CASES[0];
  let threw = null, res = null;
  try { res = runPoolCase(c, bridge.rustScatterPlanner(), false); } catch (e) { threw = e; }
  check("X a throwing kernel: the pool falls back to its loops and keeps running", threw === null && res && res.planner === null && res.frames.length > 100,
    threw ? String(threw.message) : `planner after: ${JSON.stringify(res && res.planner)}`);
  bridge.__setRustTerrainFxForTest(undefined);
  core.__setSceneWasmForTest(M.ns, M.memory);
}
const part1Failed = failed;

// ---------------------------------------------------------------------------
// Part 2 — the compiled kernel.
// ---------------------------------------------------------------------------
console.log("rust terrain fx parity — Part 2 (compiled SceneScatterPlanner)");
let ns, out;
try {
  ns = await import(join(app, pkgDir, "holtburger_web.js"));
  out = await ns.default(readFileSync(join(app, pkgDir, "holtburger_web_bg.wasm")));
} catch (e) {
  console.log(`rust terrain fx parity: Part 1 ${passed} passed, ${failed} failed; Part 2 SKIP — wasm pkg ${pkgDir}/ not loadable in Node: ${String(e.message).slice(0, 100)}`);
  process.exit(part1Failed === 0 ? 0 : 1);
}
if (typeof ns.SceneScatterPlanner !== "function" || typeof ns.sceneCoreAbi !== "function") {
  console.log(`rust terrain fx parity: Part 1 ${passed} passed, ${failed} failed; Part 2 SKIP — ${pkgDir}/ has no SceneScatterPlanner (rebuild with wasm-pack)`);
  process.exit(part1Failed === 0 ? 0 : 1);
}
core.__setSceneWasmForTest(ns, out.memory);
if (fixture) {
  const bv = new Map();
  const view = (Ctor, key, ptr, len) => {
    let v = bv.get(key);
    const buf = out.memory.buffer;
    if (!v || v.buffer !== buf || v.byteOffset !== ptr || v.length !== len) { v = new Ctor(buf, ptr, len); bv.set(key, v); }
    return v;
  };
  for (const c of fixture.cases) {
    const r = model.replayCase(c, (...a) => new ns.SceneScatterPlanner(...a), {
      batch: (p) => view(Int32Array, "b", p.batchPtr(), p.batchCap()),
      outcome: (p) => view(Uint8Array, "o", p.outcomePtr(), p.outcomeCap()),
      stats: (p) => view(Uint32Array, "s", p.statsPtr(), p.statsLen()),
      queued: (p) => p.queuedLines,
    });
    check(`W wasm replays "${c.name}" exactly`, r.bad === 0, r.bad ? r.notes.join(" | ") : `${r.frames} frames`);
  }
}
bridge.__setRustTerrainFxForTest(true);
const wf = bridge.rustScatterPlanner();
for (const c of gen.CASES) {
  const off = runPoolCase(c, null, true);
  const on = runPoolCase(c, wf, true);
  check(`W "${c.name}" ran on the wasm planner`, !!on.planner && on.planner.desync === 0, JSON.stringify(on.planner));
  compareFrames(`W "${c.name}" (three): buffers, ranges, flags, oracle calls, stats`, off, on);
}
bridge.__setRustTerrainFxForTest(undefined);
{
  const off = runRock(false);
  const on = runRock(true);
  compareFrames("W rock pebbles + grit (three), wasm planner", off, on);
}
familyChecks("W");
console.log(`\nrust terrain fx parity: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
