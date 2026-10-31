// tests/gpu_particles.test.mjs — `?gpuParticles` (round 3 R3-7a, DEFAULT OFF):
// particle motion evaluated in the bucket vertex shader
// (scene3d/particles/gpu_particles.js + the gated hooks in particle_manager.js).
// Design: /mnt/wbterminal1/tmp/claude-scratch/rustcore-2026-10-29/r3-7a/design/design.md
//
// Every behaviour runs on the REAL ParticleManager / ParticleEmitter / Particle
// code through tools/rust_parity/gen_particles.mjs's Harness and scenarios, each
// twice in one process (flag off, flag on) with the same scripted clock, RNG and
// camera, plus a randomized all-types corpus and a 60 Hz velocity run.
//   A  reader grammar (`rustFlag("gpuParticles", false)`, memo, seam)
//   F  flag off = the pre-change code: a per-tick digest of every bucket's bytes,
//      update ranges, versions, program keys and onBeforeCompile OUTPUT, the
//      RNG / seed streams, per-tick call counts and the window keys, against
//      tests/fixtures/gpu_particles_flag_off.golden.json (captured on a scratch
//      copy of HEAD before the change); no gpu state/global with the flag off
//   E  flag on: emission / kill / RNG order identical to flag off (every
//      particle born and killed at the same tick, every emitter scalar and
//      particle field bit-identical), and the per-frame per-particle JS update
//      (Particle.update outside init, updateMatrix, setMatrixAt / setColorAt) and
//      the per-frame instance-matrix re-upload no longer run (spies, versions)
//   T  the twins: the f64 twin is Object.is-equal to Particle.update; the f32
//      GLSL twin (tests/helpers/gpu_particles_f32.mjs, reading the real record /
//      row tables) is within 1e-4 relative of particle.js for EVERY type,
//      persistent and parented, random seeds and ages, incl. particles living
//      across epoch rebases (T5); hi/lo time (T3, with the single-float negative
//      control); analytic velocity (+ a moving parent-local anchor's, and its
//      loss once the anchor stops) vs the flag-off finite difference (T4, at
//      60 Hz and at 30 Hz: the lag reads the measured tick dt)
//   P  per instance: the f32 twin evaluated from the gpu tables + index lists
//      equals the flag-off bucket matrices / colours (membership, order — the
//      alpha sort included — billboards, shared buckets, two managers; the
//      suite-local anchorTurn scenario: parent-local GR emitters on an anchor
//      turning in place); bucket sets, layers, renderOrder, frustumCulled;
//      upload discipline (the index list re-uploaded per tick, ranged
//      texture uploads, the anchor-velocity
//      row through a stop, P5r: pending ranges merge per texture row while
//      nothing uploads, P5c: a restored context uploads both tables whole);
//      thaw; eligibility (sky chain, Unknown / non-integer types, the legacy
//      escapes in a child process, a failed self-check, ?rustParticles: the
//      bridge is never asked, spy-counted); the runtime instancing
//      toggle; film-mode samples (P9 / P9b); P10 record / row accounting every
//      tick (finish, destroy, same-id overwrite, conversion); P11 a failed
//      bucket attach; P12 the fxGlow provider's twins (+ HB_GP_FXCOLOR), P12b
//      HB_GP_FXCOLOR on every gpu FX bucket program and on no stock one
//   G  the GLSL: the constants / forms the twin uses, the record layout, no
//      backticks / quotes; G4 the quaternion helpers as written vs three and
//      hbGpSinCos as written vs the twin + sin / cos; G5 the whole header evaluated as written (tests/helpers/
//      gpu_particles_glsl_eval.mjs) == the f32 twin bit for bit, with negative
//      controls; G5b the same at texture-row boundaries (records and rows at
//      255 / 256 / 511 / 512 / 767; out-of-range texelFetch throws); the
//      patch (header once before <common>, hbGpEval first, #undef before
//      every later #define instanceMatrix, idempotent) on stock /
//      FX tier variants / alpha / glow; program keys; the additive-fog live
//      switch keeps the patch; a broken source fails the self-check; H6 the
//      self-check per shader template (MeshStandard) + compile-time failures
//   R  the spawn record + row layout
//   S  the SwiftShader smoke's node half (2026-10-31, after the smoke failed
//      S2 / S4 / S6 / S7): buildSmokeData's cases; the kernel verdicts S2..S6
//      on the header evaluated under SwiftShader's own sin / cos polynomial
//      (the failing readback, reproduced bit for bit by the control that puts
//      the driver's sin / cos back); no driver transcendental in the header;
//      S7n the stock bucket programs AS THREE r184 BUILDS THEM (real
//      WebGLRenderer over tests/helpers/fake_webgl2.mjs, the uniforms it
//      uploads) evaluated per vertex and rasterized: every S7 centroid within
//      1 px of the smoke's CPU projection with the shared camera
//      (tests/helpers/gpu_particles_smoke_scene.mjs), 213 of 213 off with the
//      pre-fix one
//
// Run: node tests/gpu_particles.test.mjs   (~16 s, two short child processes)
// Golden: node tests/gpu_particles.test.mjs --write-flag-off-golden <out.json>
//   Captured 2026-10-30 on a scratch copy of HEAD BEFORE R3-7a (the flag-off
//   identity proof). Regenerate it only when the gen_particles scenarios or an
//   intended flag-off behaviour change, on a tree whose flag-off path is the
//   trusted one, and say so in the commit.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as THREE from "three";

import { inputRng, recordRng } from "../tools/rust_parity/fixture_util.mjs";
import * as GEN from "../tools/rust_parity/gen_particles.mjs";
import { scenarioDigest, installCallSpies, materialSignature } from "./helpers/gpu_particles_flag_off_digest.mjs";
import { makeCorpusScenario } from "./helpers/gpu_particles_corpus.mjs";

const SELF = fileURLToPath(import.meta.url);
const HERE = dirname(SELF);
const APP = join(HERE, "..");
const GOLDEN = join(HERE, "fixtures", "gpu_particles_flag_off.golden.json");
const ARGS = process.argv.slice(2);

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail != null && detail !== "" ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}
const section = (s) => console.log(`\n== ${s}`);

const DIGEST_SCENARIOS = () => ({ ...GEN.SCENARIOS, ...GEN.NODE_ONLY_SCENARIOS });

async function loadAll() {
  const M = await GEN.loadModules();
  M.particle = await import("../scene3d/particles/particle.js");
  return M;
}

async function digestAll(M, legacy) {
  const set = legacy ? GEN.LEGACY_SCENARIOS : DIGEST_SCENARIOS();
  const out = {};
  for (const [name, fn] of Object.entries(set)) {
    out[name] = await scenarioDigest(M, GEN, recordRng, name, fn);
  }
  return out;
}

// ---------------------------------------------------------------- child modes
if (ARGS[0] === "--write-flag-off-golden" || ARGS[0] === "--flag-off-digest") {
  // Pre-change tree (golden) or a child run: flag-off digests only. Imports
  // nothing the pre-change tree lacks.
  const legacy = ARGS.includes("--legacy");
  GEN.installGlobals(legacy ? GEN.LEGACY_SEARCH : "");
  const M = await loadAll();
  const d = await digestAll(M, legacy);
  if (ARGS[0] === "--flag-off-digest") {
    process.stdout.write(JSON.stringify(d));
    process.exit(0);
  }
  const r = spawnSync(process.execPath, [SELF, "--flag-off-digest", "--legacy"], { cwd: APP, encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
  const golden = { generator: "node tests/gpu_particles.test.mjs --write-flag-off-golden <out.json> (pre-change tree)", three: THREE.REVISION, scenarios: d, legacy: JSON.parse(r.stdout) };
  writeFileSync(ARGS[1], JSON.stringify(golden, null, 0) + "\n");
  console.log(`wrote ${ARGS[1]}: ${Object.keys(d).length} scenarios + legacy`);
  process.exit(0);
}
if (ARGS[0] === "--legacy-child") {
  // P7: the escapes are read at module load, so the legacy run is its own process.
  GEN.installGlobals(GEN.LEGACY_SEARCH);
  const M = await loadAll();
  const GP = await import("../scene3d/particles/gpu_particles.js");
  M.core.__setRustFlagForTest("gpuParticles", true);
  let gpEmitters = 0;
  const res = {};
  for (const [name, fn] of Object.entries(GEN.LEGACY_SCENARIOS)) {
    GP.__resetGpParticlesForTest();
    const wrapFn = async (h) => {
      await fn(h);
      for (const m of h.mgrs) for (const [, e] of m.particleTable) if (e instanceof GP.GpParticleEmitter) gpEmitters++;
    };
    res[name] = await scenarioDigest(M, GEN, recordRng, name, wrapFn);
  }
  process.stdout.write(JSON.stringify({ gpEmitters, tables: GP.gpTables() !== null, digests: res }));
  process.exit(0);
}

// ---------------------------------------------------------------- main
GEN.installGlobals("");
const M = await loadAll();

// ===================================================================== F
section("F  flag off: the pre-change code (golden digest, no gpu state)");
const flagOffNow = await digestAll(M, false);
{
  let golden = null;
  try { golden = JSON.parse(readFileSync(GOLDEN, "utf8")); } catch (e) { golden = null; }
  check("F0 golden present (tests/fixtures/gpu_particles_flag_off.golden.json)", golden !== null && golden.three === THREE.REVISION,
    golden ? `three ${golden.three}` : "missing");
  if (golden) {
    for (const [name, d] of Object.entries(flagOffNow)) {
      const g = golden.scenarios[name];
      let firstBad = -1;
      if (g) for (let i = 0; i < Math.max(g.ticks.length, d.ticks.length); i++) if (g.ticks[i] !== d.ticks[i]) { firstBad = i; break; }
      check(`F2 ${name}: every tick's buckets / ranges / versions / keys / shaders / call counts / RNG == pre-change`,
        !!g && firstBad === -1 && JSON.stringify(g.rng) === JSON.stringify(d.rng),
        !g ? "no golden" : firstBad >= 0 ? `first differing tick ${firstBad} of ${d.ticks.length}` : `${d.ticks.length} ticks, ${d.rng.join("+")} draws`);
      check(`F1 ${name}: window keys == pre-change (no new global)`, !!g && JSON.stringify(g.windowKeys) === JSON.stringify(d.windowKeys),
        g ? d.windowKeys.filter((k) => !g.windowKeys.includes(k)).join(",") : "");
    }
    const r = spawnSync(process.execPath, [SELF, "--flag-off-digest", "--legacy"], { cwd: APP, encoding: "utf8", maxBuffer: 64 << 20 });
    const leg = r.status === 0 ? JSON.parse(r.stdout) : null;
    const gl = golden.legacy && golden.legacy.legacy;
    check("F2 legacy escapes (child process): == pre-change", !!leg && !!gl && JSON.stringify(leg.legacy.ticks) === JSON.stringify(gl.ticks),
      leg ? "" : (r.stderr || "").slice(-300));
  }
}

// From here on the gpu module is needed (the pre-change tree has none: every
// check below FAILS there).
let GP = null;
let F32 = null;
try {
  GP = await import("../scene3d/particles/gpu_particles.js");
  F32 = await import("./helpers/gpu_particles_f32.mjs");
} catch (e) {
  check("gpu_particles.js loads", false, String(e?.message ?? e));
  console.log(`\ngpu_particles: ${passed} passed, ${failed} failed`);
  process.exit(1);
}
const { evalGpF32, sinCosF32 } = F32;

// G5: the production header evaluated AS WRITTEN (tests/helpers/gpu_particles_glsl_eval.mjs,
// f32 per operation) against the f32 twin, on every instance the twin is compared on
const { compileGpHeader, compileGlslProgram, SWIFTSHADER_TRIG, swiftShaderSin } = await import("./helpers/gpu_particles_glsl_eval.mjs");
const _glslRunners = new Map();
const G5 = { n: 0, bad: 0, ex: [], err: "", types: new Set(), bb: new Set(), variants: new Set(), ctl: {}, maxRec: 0, rowEdge: 0, samples: new Map() };
// negative controls: one-token edits of the header must disagree with the twin
const G5_CONTROLS = {
  spin: { from: "vec2 h = hbGpSinCos( 0.5 * th );", to: "vec2 h = hbGpSinCos( th );", when: (ty) => ty === 4 || ty === 9 || ty === 11 },
  anchor: { from: "vec3 P = pl ? e0.xyz + r0.xyz : r0.xyz;", to: "vec3 P = r0.xyz;", when: (ty, pl) => pl },
  swarmVel: { from: "V = A + vec3( -B.x * hbGpSin(", to: "V = A + vec3( B.x * hbGpSin(", when: (ty, pl, motion) => ty === 5 && motion },
};
function glslControl(name, T, rec, key, fxColor, fxMotion, ref) {
  const c = G5.ctl[name] || (G5.ctl[name] = { n: 0, diff: 0, runs: new Map() });
  if (c.n >= 400) return;
  let run = c.runs.get(key);
  if (!run) {
    const C = G5_CONTROLS[name];
    if (!GP.GP_GLSL_HEADER.includes(C.from)) { c.missing = true; return; }
    c.runs.set(key, run = compileGpHeader(GP.GP_GLSL_HEADER.replace(C.from, C.to), { fxColor, fxMotion }));
  }
  const r = run({ instanceColor: [rec, 0, 0], textures: { uGpRec: { data: T.records.data, width: GP.GP_WIDTH }, uGpRow: { data: T.rows.data, width: GP.GP_WIDTH } } });
  c.n++;
  if (r.m.some((x, k) => x !== ref.m[k])) c.diff++;
}
function glslVsTwin(T, rec, opts) {
  const fxColor = opts.fxColor === true, fxMotion = opts.fxMotion === true;
  const key = `${+fxColor}${+fxMotion}`;
  let r;
  try {
    let run = _glslRunners.get(key);
    if (!run) _glslRunners.set(key, run = compileGpHeader(GP.GP_GLSL_HEADER, { fxColor, fxMotion }));
    r = run({ instanceColor: [rec, 0, 0], textures: { uGpRec: { data: T.records.data, width: GP.GP_WIDTH }, uGpRow: { data: T.rows.data, width: GP.GP_WIDTH } } });
  } catch (e) {
    G5.bad++;
    if (!G5.err) G5.err = String(e && e.message || e).slice(0, 200);
    return;
  }
  const tw = evalGpF32(T.records.data, T.rows.data, rec, { fxColor, fxMotion });
  G5.n++;
  G5.variants.add(key);
  G5.maxRec = Math.max(G5.maxRec, rec);
  if (rec % GP.GP_PER_ROW === GP.GP_PER_ROW - 1 || (rec > 0 && rec % GP.GP_PER_ROW === 0)) G5.rowEdge++;
  if (!tw.collapsed) {
    const er = Math.round(T.records.data[rec * GP.GP_FLOATS + 24]);
    const ty = Math.round(T.rows.data[er * GP.GP_FLOATS + 12]);
    const pl = T.rows.data[er * GP.GP_FLOATS + 13] > 0.5;
    const bb = Math.round(T.rows.data[er * GP.GP_FLOATS + 14]);
    G5.types.add(ty);
    G5.bb.add(bb);
    for (const [name, C] of Object.entries(G5_CONTROLS)) if (C.when(ty, pl, fxMotion)) glslControl(name, T, rec, key, fxColor, fxMotion, tw);
    // G5b: one sample per (type, parent-local, billboard, program), copied out
    // with the rows it reads, to be re-evaluated at texture-row boundaries
    const sk = `${ty}|${+pl}|${bb}|${key}`;
    if (!G5.samples.has(sk) && G5.samples.size < 96) {
      const mr = Math.round(T.rows.data[er * GP.GP_FLOATS + 3]);
      const cp = (d, i) => Float32Array.from(d.subarray(i * GP.GP_FLOATS, (i + 1) * GP.GP_FLOATS));
      G5.samples.set(sk, { rec: cp(T.records.data, rec), erow: cp(T.rows.data, er), mrow: cp(T.rows.data, mr), grow: cp(T.rows.data, 0),
        fxColor, fxMotion, tw: { m: Float32Array.from(tw.m), c: Float32Array.from(tw.c) } });
    }
  }
  let ok = true;
  for (let k = 0; k < 16 && ok; k++) if (!(r.m[k] === tw.m[k] || (Number.isNaN(r.m[k]) && Number.isNaN(tw.m[k])))) ok = false;
  for (let k = 0; k < 3 && ok; k++) if (Math.fround(r.c[k]) !== Math.fround(tw.c[k])) ok = false;
  if (!ok) {
    G5.bad++;
    if (G5.ex.length < 3) G5.ex.push(`rec ${rec} [${key}]: glsl m ${Array.from(r.m).map((x) => +x.toPrecision(7))} c ${r.c} vs twin m ${Array.from(tw.m).map((x) => +x.toPrecision(7))} c ${Array.from(tw.c)}`);
  }
}

// ===================================================================== A
section("A  reader grammar");
{
  const core = M.core;
  const loc = globalThis.location;
  const read = (search) => {
    loc.search = search;
    core.__setRustFlagForTest("gpuParticles", undefined);
    const v = GP.gpuParticlesEnabled();
    return v;
  };
  const on = ["?gpuParticles=on", "?gpuParticles=1", "?gpuParticles=true", "?gpuParticles=yes", "?gpuParticles=ON", "?gpuParticles=%20on%20", "?a=1&gpuParticles=Yes"];
  const off = ["", "?gpuParticles=off", "?gpuParticles=0", "?gpuParticles=false", "?gpuParticles=no", "?gpuParticles=garbage", "?gpuParticles=", "?gpuParticles", "?rustParticles=on", "?gpuparticles=on"];
  const badOn = on.filter((s) => read(s) !== true);
  const badOff = off.filter((s) => read(s) !== false);
  check("A1 on / 1 / true / yes (any case, trimmed) opt in", badOn.length === 0, badOn.join(" "));
  check("A2 absent / off / 0 / false / no / garbage / empty read OFF (DEFAULT OFF)", badOff.length === 0, badOff.join(" "));
  read("?gpuParticles=on");
  loc.search = "";
  check("A3 memoised: read once per page load", GP.gpuParticlesEnabled() === true);
  core.__setRustFlagForTest("gpuParticles", false);
  check("A4 seam __setRustFlagForTest('gpuParticles', false) forces off", GP.gpuParticlesEnabled() === false);
  core.__setRustFlagForTest("gpuParticles", undefined);
  loc.search = "";
  check("A5 cleared seam + no param → off", GP.gpuParticlesEnabled() === false);
  const src = readFileSync(join(APP, "scene3d", "particles", "gpu_particles.js"), "utf8");
  check("A6 the reader is rustFlag(\"gpuParticles\", false) (house grammar, default off)", /return rustFlag\("gpuParticles", false\);/.test(src));
  const pm = readFileSync(join(APP, "scene3d", "particles", "particle_manager.js"), "utf8");
  check("A7 particle_manager's per-tick gate is typeof-guarded (test_particles.mjs concatenation)",
    /function _gpOn\(\) \{\s*return typeof gpuParticlesEnabled === "function" && gpuParticlesEnabled\(\);/.test(pm)
    && /const gpOn = _gpOn\(\);/.test(pm));
}

// F1 continued: after every flag-off scenario there is no gpu state.
{
  check("F1 flag off: no window.__gpuParticlesDiag after every scenario", globalThis.window.__gpuParticlesDiag === undefined);
  check("F1 flag off: the gpu tables were never created", GP.gpTables() === null);
  const sc = typeof GP.__gpScratchForTest === "function" ? GP.__gpScratchForTest() : null;
  const pmSc = typeof M.pm.__gpAppendScratchForTest === "function" ? M.pm.__gpAppendScratchForTest() : null;
  check("F1 flag off: no lazily made gpu state (manager slots, camera scratch, self-check memo, renderer listener, append scratch)",
    !!sc && Object.values(sc).every((v) => v === false) && pmSc === false, JSON.stringify({ sc, pmSc }));
}

// ===================================================================== runner
const TRIG = new Set([4, 5, 6, 7, 9, 11]);
const ulp32 = (x) => {
  const a = Math.abs(Math.fround(x));
  if (a === 0) return 1.4e-45;
  const e = Math.floor(Math.log2(a));
  return Math.pow(2, e - 23);
};

function bucketKey(e) {
  return `${e._instKey >>> 0}|${e.renderLayer | 0}${e._instAlpha === true ? "|a" : ""}${e.skyGlow === true ? "|sky" : ""}`;
}

/**
 * Run one scenario on one path. `on` = the flag. Captures per tick: buckets
 * (own + shared; each additive bucket's per-emitter segments), emitter scalars,
 * every live particle's fields, removals, RNG draws, kids, call counts.
 */
async function runPath(fn, { on, perTick = null, spies = true, before = null }) {
  GP.__resetGpParticlesForTest();
  M.core.__setRustFlagForTest("gpuParticles", on);
  const recs = [];
  const h = new GEN.Harness(M, {
    onManager(mgr, index, hh) {
      const rec = recordRng(0x0c0ffee + 977 * index);
      recs[index] = rec;
      hh.rngs.set(mgr, rec.rng);
    },
  });
  if (before) before(h);
  // segments: which emitter appended how many instances to which bucket key
  const PMP = M.pm.ParticleManager.prototype;
  const origAppend = PMP._appendInstances;
  let segs = new Map();
  PMP._appendInstances = function (emitter) {
    const n = (emitter.parts || []).filter((m) => m && m.visible !== false).length;
    const k = bucketKey(emitter);
    if (!segs.has(k)) segs.set(k, []);
    segs.get(k).push([emitter.id, n, this === h.mgrs[0] ? 0 : h.mgrs.indexOf(this)]);
    return origAppend.call(this, emitter);
  };
  const origGp = PMP._gpAppend;
  if (origGp) {
    PMP._gpAppend = function (emitter) {
      const k = bucketKey(emitter);
      if (!segs.has(k)) segs.set(k, []);
      segs.get(k).push([emitter.id, -1, h.mgrs.indexOf(this)]);
      return origGp.call(this, emitter);
    };
  }
  const sp = spies ? installCallSpies(M) : null;
  let gpEmits = 0;
  const GPP = GP.GpParticleEmitter.prototype;
  const origOnEmit = GPP._gpOnEmit;
  GPP._gpOnEmit = function (i) { gpEmits++; return origOnEmit.call(this, i); };
  let recWrites = 0, rowWrites = 0, retimed = 0;
  const TBP = GP.GpTable.prototype;
  const origSet = TBP.set;
  TBP.set = function (...a) {
    const T = GP.gpTables();
    if (T && this === T.records) recWrites++; else if (T && this === T.rows) rowWrites++;
    return origSet.apply(this, a);
  };
  const origRetime = GPP._gpRetime;
  GPP._gpRetime = function () { const n = origRetime.call(this); retimed += n; return n; };
  // every emitter whose records / row were released (P10's orphan control)
  const released = [];
  const origRelease = GPP._gpRelease;
  GPP._gpRelease = function () { released.push(this); return origRelease.call(this); };
  // per-particle instance writes on PARTICLE buckets (three's InstancedMesh
  // constructor fills identity matrices before the manager stamps userData)
  const IMP = THREE.InstancedMesh.prototype;
  const origSetM = IMP.setMatrixAt, origSetC = IMP.setColorAt;
  let bucketSetM = 0, bucketSetC = 0, bucketSetCOther = 0;
  IMP.setMatrixAt = function (i, m) { if (this.userData && this.userData.isParticleInstanced === true) bucketSetM++; return origSetM.call(this, i, m); };
  IMP.setColorAt = function (i, c) {
    if (this.userData && this.userData.isParticleInstanced === true) {
      bucketSetC++;
      if (!(i === 0 && c.r === 1 && c.g === 1 && c.b === 1)) bucketSetCOther++; // not the creation / growth white
    }
    return origSetC.call(this, i, c);
  };
  const ticks = [];
  const origTick = h.tick.bind(h);
  if (sp) sp.take();
  h.tick = async (dt) => {
    segs = new Map();
    if (sp) sp.take();
    gpEmits = 0; recWrites = 0; rowWrites = 0; retimed = 0; bucketSetM = 0; bucketSetC = 0; bucketSetCOther = 0;
    const snap = await origTick(dt);
    const calls = sp ? sp.take() : null;
    const t = captureTick(h, snap, segs, calls, recs);
    t.gpEmits = gpEmits; t.recWrites = recWrites; t.rowWrites = rowWrites; t.retimed = retimed;
    t.bucketSetM = bucketSetM; t.bucketSetC = bucketSetC; t.bucketSetCOther = bucketSetCOther;
    ticks.push(t);
    if (perTick) perTick(h, t, ticks.length - 1);
    return snap;
  };
  try {
    await fn(h);
  } finally {
    PMP._appendInstances = origAppend;
    if (origGp) PMP._gpAppend = origGp;
    IMP.setMatrixAt = origSetM;
    IMP.setColorAt = origSetC;
    GPP._gpOnEmit = origOnEmit;
    TBP.set = origSet;
    GPP._gpRetime = origRetime;
    GPP._gpRelease = origRelease;
    if (sp) sp.restore();
    M.time.setRng(null);
    M.core.__setRustFlagForTest("gpuParticles", undefined);
  }
  return { h, ticks, draws: recs.map((r) => r.values), released };
}

function captureTick(h, snap, segs, calls, recs) {
  const buckets = [];
  const one = (key, b, shared, mi) => {
    const im = b.im;
    const n = im.count | 0;
    buckets.push({
      key, shared, mi, n, cap: im.instanceMatrix.count, mask: im.layers.mask, ro: im.renderOrder,
      fc: im.frustumCulled, cs: im.castShadow, inst: im.userData.isParticleInstanced === true,
      fx: im.userData.particleFx === true, gp: b.gp === true, alpha: b.alpha === true,
      mat: Float32Array.from(im.instanceMatrix.array.subarray(0, n * 16)),
      col: Float32Array.from(im.instanceColor.array.subarray(0, n * 3)),
      mver: im.instanceMatrix.version, cver: im.instanceColor.version,
      cranges: JSON.stringify(im.instanceColor.updateRanges), im,
      prog: materialSignature(im.material).split("|")[1],
    });
  };
  h.mgrs.forEach((mgr, i) => { for (const [key, b] of mgr._instBuckets) one(key, b, false, i); });
  for (const [key, b] of M.pm.sharedAlphaBuckets.buckets) one(key, b, true, -1);
  const emitters = [];
  const parts = [];
  h.mgrs.forEach((mgr, mi) => {
    for (const [id, e] of mgr.particleTable) {
      emitters.push([mi, id, e.numParticles | 0, e.totalEmitted | 0, e.stopped === true ? 1 : 0, e._rp6Culled === true ? 1 : 0, e.lastEmitTime, e.creationTime]);
      const ps = e.particles || [];
      for (let i = 0; i < (e.parts || []).length; i++) {
        if (!e.parts[i]) continue;
        const p = ps[i];
        parts.push([mi, id, i, p.birthtime, p.lastUpdateTime, p.lifetime, p.lifespan, p.offset.x, p.offset.y, p.offset.z, p.a.x, p.a.y, p.a.z, p.b.x, p.b.y, p.b.z, p.c.x, p.c.y, p.c.z, p.startScale, p.finalScale, p.startTrans, p.finalTrans]);
      }
    }
  });
  const kids = [];
  h.mgrs.forEach((mgr, mi) => {
    if (!mgr._kids) return;
    for (const [layer, l] of mgr._kids.layers) {
      const g = l.mesh.geometry;
      kids.push({ layer: `${mi}:${layer}`, n: l.n, pos: Float32Array.from(g.attributes.aKidPos.array.subarray(0, l.n * 4)),
        vel: Float32Array.from(g.attributes.aKidVel.array.subarray(0, l.n * 4)), row: Float32Array.from(g.attributes.aKidRow.array.subarray(0, l.n * 2)) });
    }
  });
  return {
    buckets, segs: new Map(segs), emitters, parts, kids, calls,
    removed: snap.removed.map((e) => (e ? e.id : null)), stats: snap.stats, rng: recs.map((r) => r.values.length),
    removedGp: snap.removed.filter((e) => e instanceof GP.GpParticleEmitter && e._gp === true).length,
    slots: snap.slots, gpTables: GP.gpTables(),
  };
}

/**
 * P10: the tables hold exactly what live gpu emitters reference. Every record /
 * row a table counts as live is referenced by one gpu emitter in a manager's
 * table (none shared); every other index below the high-water mark is on the
 * free list and zero; converted emitters hold nothing; each manager's emitter
 * set is exactly its gpu emitters with a row. A finished, destroyed, converted
 * or overwritten emitter that kept its records fails here.
 */
function gpAccounting(h) {
  const T = GP.gpTables();
  const errs = [];
  if (!T) return { errs, recs: 0, rows: 0 };
  const recRefs = new Map(), rowRefs = new Map();
  h.mgrs.forEach((mgr, mi) => {
    const members = new Set();
    for (const [id, e] of mgr.particleTable) {
      if (!(e instanceof GP.GpParticleEmitter)) continue;
      if (e._gp !== true) {
        if (e._gpRow !== 0 || (e._gpRec && e._gpRec.some((r) => r > 0))) errs.push(`${mi}:${id} converted but holds records / a row`);
        continue;
      }
      if (e._gpRec) for (const r of e._gpRec) if (r > 0) { if (recRefs.has(r)) errs.push(`record ${r} held twice`); recRefs.set(r, `${mi}:${id}`); }
      if (e._gpRow > 0) { if (rowRefs.has(e._gpRow)) errs.push(`row ${e._gpRow} held twice`); rowRefs.set(e._gpRow, `${mi}:${id}`); members.add(e); }
    }
    const st = mgr._gpState;
    if (st) {
      for (const e of st.emitters) if (!members.has(e)) errs.push(`manager ${mi} still lists emitter ${e.id} (gone / released)`);
      for (const e of members) if (!st.emitters.has(e)) errs.push(`manager ${mi} misses emitter ${e.id}`);
    } else if (members.size > 0) errs.push(`manager ${mi}: gpu emitters without a manager state`);
  });
  const table = (tb, refs, lo, name) => {
    if (tb.live !== refs.size) errs.push(`${name}s: live ${tb.live} vs referenced ${refs.size}`);
    const free = new Set(tb.free);
    for (let r = lo; r < tb.next; r++) {
      if (refs.has(r)) { if (free.has(r)) errs.push(`${name} ${r} referenced and free`); continue; }
      if (!free.has(r)) errs.push(`${name} ${r} leaked (neither referenced nor free)`);
      const o = r * GP.GP_FLOATS;
      for (let k = 0; k < GP.GP_FLOATS; k++) if (tb.data[o + k] !== 0) { errs.push(`${name} ${r} free but not zero`); break; }
    }
  };
  table(T.records, recRefs, 1, "record");
  table(T.rows, rowRefs, GP.GP_ROW.EMITTER0, "row");
  return { errs, recs: recRefs.size, rows: rowRefs.size };
}

const sameArr = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

/**
 * P2/P3: the flag-on buckets against the flag-off ones for one tick. Flag-off
 * additive buckets that mix gpu-eligible and ineligible emitters split into
 * `key|gp` + `key` on the flag-on side; their expected content is cut from the
 * flag-off instances by the per-emitter segments (an additive bucket keeps
 * table order). Returns { errs, n, worst }.
 */
function compareTick(offT, onT, h, motionOn, worst) {
  const errs = [];
  let n = 0;
  const eligibleIds = new Map(); // `${mi}:${id}` -> gp?
  h.mgrs.forEach((mgr, mi) => { for (const [id, e] of mgr.particleTable) eligibleIds.set(`${mi}:${id}`, e._gp === true); });
  const findOn = (key, shared, mi) => onT.buckets.find((b) => b.key === key && b.shared === shared && (shared || b.mi === mi));
  for (const ob of offT.buckets) {
    const seg = offT.segs.get(ob.key) || [];
    const segsHere = seg.filter((s) => ob.shared || s[2] === ob.mi);
    const kinds = new Set(segsHere.map((s) => eligibleIds.get(`${s[2]}:${s[0]}`) === true));
    const targets = [];
    if (kinds.size <= 1 || ob.n === 0) {
      const gpSide = kinds.has(true);
      targets.push({ key: gpSide ? ob.key + "|gp" : ob.key, idx: [...Array(ob.n).keys()], gp: gpSide });
    } else {
      if (ob.alpha) { errs.push(`${ob.key}: an alpha bucket mixes gpu and legacy emitters (sort domains differ)`); continue; }
      const gpIdx = [], lgIdx = [];
      let at = 0;
      for (const s of segsHere) {
        const cnt = Math.min(s[1], ob.n - at);
        for (let k = 0; k < cnt; k++) (eligibleIds.get(`${s[2]}:${s[0]}`) === true ? gpIdx : lgIdx).push(at + k);
        at += cnt;
      }
      targets.push({ key: ob.key + "|gp", idx: gpIdx, gp: true }, { key: ob.key, idx: lgIdx, gp: false });
    }
    for (const tg of targets) {
      const nb = findOn(tg.key, ob.shared, ob.mi);
      if (tg.idx.length === 0 && (!nb || nb.n === 0)) continue;
      if (!nb) { errs.push(`tick bucket ${tg.key} missing (want ${tg.idx.length})`); continue; }
      if (nb.n !== tg.idx.length) { errs.push(`${tg.key}: count ${nb.n} vs ${tg.idx.length}`); continue; }
      if (nb.mask !== ob.mask || nb.ro !== ob.ro || nb.fc !== false || nb.inst !== true || nb.cs !== false || nb.alpha !== ob.alpha) {
        errs.push(`${tg.key}: bucket state mask ${nb.mask}/${ob.mask} ro ${nb.ro}/${ob.ro} fc ${nb.fc} inst ${nb.inst} cs ${nb.cs}`);
      }
      if (kinds.size <= 1 && nb.cap !== ob.cap) errs.push(`${tg.key}: capacity ${nb.cap} vs ${ob.cap}`);
      if (tg.gp && !nb.gp) errs.push(`${tg.key}: expected a gpu bucket`);
      for (let j = 0; j < tg.idx.length; j++) {
        const i = tg.idx[j];
        n++;
        const ma = ob.mat.subarray(i * 16, i * 16 + 16);
        const ca = ob.col.subarray(i * 3, i * 3 + 3);
        let mm, cc;
        if (nb.gp) {
          const T = onT.gpTables;
          const r = evalGpF32(T.records.data, T.rows.data, nb.col[j * 3], { fxColor: nb.fx, fxMotion: nb.fx && motionOn });
          glslVsTwin(T, nb.col[j * 3], { fxColor: nb.fx, fxMotion: nb.fx && motionOn });
          if (r.collapsed) { errs.push(`${tg.key}[${j}]: collapsed`); continue; }
          mm = r.m; cc = r.c;
        } else {
          mm = nb.mat.subarray(j * 16, j * 16 + 16);
          cc = nb.col.subarray(j * 3, j * 3 + 3);
        }
        const P = Math.hypot(ma[12], ma[13], ma[14]);
        const dp = Math.hypot(mm[12] - ma[12], mm[13] - ma[13], mm[14] - ma[14]);
        const tolP = 1e-4 * Math.max(1, P) + 2 * ulp32(P);
        const sc = Math.hypot(ma[0], ma[1], ma[2]);
        let dr = 0;
        for (const k of [0, 1, 2, 4, 5, 6, 8, 9, 10]) dr = Math.max(dr, Math.abs(mm[k] - ma[k]));
        const tolR = 1e-4 * Math.max(sc, 1);
        const dop = Math.abs(cc[0] - ca[0]);
        const dg = Math.abs(cc[1] - ca[1]);
        const rowOk = nb.fx ? Math.floor(cc[2]) === Math.floor(ca[2]) : Math.abs(cc[2] - ca[2]) <= 1e-4;
        worst.dp = Math.max(worst.dp, dp / Math.max(1, P)); worst.dr = Math.max(worst.dr, dr / Math.max(sc, 1)); worst.dc = Math.max(worst.dc, dop, dg);
        if (dp > tolP || dr > tolR || dop > 1e-4 || dg > 1e-4 || !rowOk) {
          errs.push(`${tg.key}[${j}]: dP ${dp.toExponential(2)} (tol ${tolP.toExponential(1)}) dR ${dr.toExponential(2)} dop ${dop.toExponential(1)} dg ${dg.toExponential(1)} row ${rowOk}`);
        }
      }
    }
  }
  // the reverse direction: no flag-on bucket draws more than its flag-off source
  for (const nb of onT.buckets) {
    if (nb.n === 0) continue;
    const base = nb.key.endsWith("|gp") ? nb.key.slice(0, -3) : nb.key;
    if (!offT.buckets.some((b) => b.key === base && b.shared === nb.shared)) errs.push(`extra flag-on bucket ${nb.key} (${nb.n})`);
  }
  return { errs, n };
}

// ===================================================================== E + P (scenarios)
section("E/P  every gen_particles scenario, flag off vs flag on");
const motionOn = () => M.fx.particleFxMotionOn();
// Suite-local scenarios (not in the flag-off golden: they only add flag-on vs
// flag-off comparisons, and the shared gen_particles set stays as captured).
const LOCAL_SCENARIOS = {
  /**
   * An NPC turning in place: parent-local GR emitters (types 4 / 9 / 11, base
   * orientation = anchor quaternion x spin) and a parent-local mover on an
   * anchor that first moves and turns, then only turns (position bit-identical
   * tick to tick), then holds still. A row refresh keyed on the anchor's
   * position alone leaves E_QUAT stale through the turn: P3 compares the GR
   * instance matrices with the flag-off ones on every tick.
   */
  async anchorTurn(h) {
    h.defGfx(0x0100f101, {});
    h.defGfx(0x0100f102, { alpha: true });
    const rig = h.movingAnchor(1, -2, 0.5);
    const axis = new THREE.Vector3(0.3, -0.2, 1).normalize();
    rig.quaternion.setFromAxisAngle(axis, 0.3);
    rig.updateMatrixWorld(true);
    const spin = { cX: 0.4, cY: -0.3, cZ: 1.1, minC: 1, maxC: 1 };
    for (const t of [4, 9, 11]) {
      await h.add({ anchor: rig, info: GEN.POJO({ hwGfxObjId: 0x0100f101, particleType: t, isParentLocal: true, maxParticles: 10, initialParticles: 4, lifespan: 2, ...spin }) });
    }
    await h.add({ anchor: rig, info: GEN.POJO({ hwGfxObjId: 0x0100f102, particleType: 9, isParentLocal: true, maxParticles: 8, initialParticles: 3, lifespan: 2, ...spin }) });
    await h.add({ anchor: rig, info: GEN.POJO({ hwGfxObjId: 0x0100f101, particleType: 2, isParentLocal: true, maxParticles: 8, initialParticles: 3, lifespan: 2 }) });
    for (let i = 0; i < 48; i++) {
      if (i < 12) rig.position.set(1 + 0.1 * i, -2, 0.5);            // ticks 0..11: moves and turns
      if (i < 36) rig.quaternion.setFromAxisAngle(axis, 0.3 + 0.07 * i); // 12..35: turns in place; 36..47: still
      rig.updateMatrixWorld(true);
      await h.tick();
    }
  },
};
const SCEN = { ...DIGEST_SCENARIOS(), ...LOCAL_SCENARIOS };
const offRuns = new Map();
let gpRemovedTotal = 0, gpOrphanTotal = 0;
for (const [name, fn] of Object.entries(SCEN)) {
  const off = await runPath(fn, { on: false });
  offRuns.set(name, off);
  const worst = { dp: 0, dr: 0, dc: 0 };
  const errs = [];
  let instances = 0;
  let ageErr = 0, ageN = 0;
  const accErrs = [];
  let accTicks = 0, accRecsMax = 0;
  const seenInTick = new Set();
  const on = await runPath(fn, {
    on: true,
    perTick(h, t, k) {
      const offT = off.ticks[k];
      if (!offT) { errs.push(`tick ${k}: no flag-off tick`); return; }
      const r = compareTick(offT, t, h, motionOn(), worst);
      instances += r.n;
      for (const e of r.errs.slice(0, 3)) errs.push(`tick ${k}: ${e}`);
      // the record age and the f64 twin, every live particle of every gpu emitter
      const T = GP.gpTables();
      const drawn = new Set();
      for (const list of t.segs.values()) for (const s of list) if (s[1] === -1) drawn.add(`${s[2]}:${s[0]}`);
      for (const [mi, mgr] of h.mgrs.entries()) {
        for (const [, e] of mgr.particleTable) {
          if (e._gp !== true || !e._gpRec || !drawn.has(`${mi}:${e.id}`)) continue;
          for (let i = 0; i < e.parts.length; i++) {
            if (!e.parts[i]) continue;
            const p = e.particles[i];
            const r0 = e._gpRec[i];
            const res = evalGpF32(T.records.data, T.rows.data, r0, {});
            if (Number.isFinite(res.t)) {
              const d = Math.abs(res.t - p.lifetime);
              const tol = Math.pow(2, -22) * Math.max(p.lifetime, 1 / 1024) + 1e-9;
              ageN++;
              if (d > tol) { ageErr++; if (ageErr < 3) errs.push(`tick ${k}: emitter ${e.id} slot ${i} gpu age ${res.t} vs lifetime ${p.lifetime}`); }
            }
          }
        }
      }
      // P10: what the tables hold == what live gpu emitters reference
      for (const mgr of h.mgrs) for (const [, e] of mgr.particleTable) seenInTick.add(e);
      const acc = gpAccounting(h);
      accTicks++;
      accRecsMax = Math.max(accRecsMax, acc.recs);
      for (const e of acc.errs.slice(0, 2)) if (accErrs.length < 4) accErrs.push(`tick ${k}: ${e}`);
    },
  });
  for (const t of on.ticks) gpRemovedTotal += t.removedGp;
  // an overwritten same-id entry: released, never walked by a tick
  gpOrphanTotal += on.released.filter((e) => !seenInTick.has(e) && e._gpRec !== null).length;
  const sameTicks = off.ticks.length === on.ticks.length;
  let scalarsBad = -1, partsBad = -1, removedBad = -1, callsBad = -1;
  for (let k = 0; k < Math.min(off.ticks.length, on.ticks.length); k++) {
    const a = off.ticks[k], b = on.ticks[k];
    if (scalarsBad < 0 && JSON.stringify(a.emitters) !== JSON.stringify(b.emitters)) scalarsBad = k;
    if (partsBad < 0 && (a.parts.length !== b.parts.length || a.parts.some((row, i) => !sameArr(row, b.parts[i])))) partsBad = k;
    if (removedBad < 0 && JSON.stringify(a.removed) !== JSON.stringify(b.removed)) removedBad = k;
    const ca = a.calls, cb = b.calls;
    if (callsBad < 0 && (ca["ParticleEmitter.emitParticle"] !== cb["ParticleEmitter.emitParticle"]
      || ca["ParticleEmitter.killParticle"] !== cb["ParticleEmitter.killParticle"] || ca["Particle.init"] !== cb["Particle.init"])) callsBad = k;
  }
  const rngSame = off.draws.length === on.draws.length && off.draws.every((d, i) => sameArr(d, on.draws[i]));
  check(`E1 ${name}: same ticks, RNG draws (values + order) identical`, sameTicks && rngSame,
    `${off.draws.map((d) => d.length).join("+")} vs ${on.draws.map((d) => d.length).join("+")}`);
  check(`E2 ${name}: every emitter scalar identical every tick (numParticles, totalEmitted, stopped, culled, lastEmitTime)`, scalarsBad === -1, scalarsBad >= 0 ? `tick ${scalarsBad}` : "");
  check(`E3 ${name}: every live particle (slot, birth, lastUpdate, lifetime, lifespan, offset, A, B, C, lerps) bit-identical every tick`,
    partsBad === -1, partsBad >= 0 ? `tick ${partsBad}` : "");
  check(`E4 ${name}: same removals, emits, kills, inits per tick`, removedBad === -1 && callsBad === -1, `removed@${removedBad} calls@${callsBad}`);
  check(`P3 ${name}: per instance, the f32 GLSL twin from the gpu tables == the flag-off bucket (membership, order, closed forms, billboards, colours)`,
    errs.filter((e) => !/gpu age/.test(e)).length === 0,
    `${instances} instances, worst rel dP ${worst.dp.toExponential(2)} dR ${worst.dr.toExponential(2)} dCol ${worst.dc.toExponential(2)}` + (errs.length ? "; " + errs.slice(0, 3).join(" | ") : ""));
  check(`P6 ${name}: every DRAWN record's gpu age == the particle's JS lifetime (f32, hi/lo; thaws retimed)`, ageErr === 0, `${ageN} particle-ticks, ${ageErr} off`);
  // E5/E6 (per-frame work): only gpu emitters in the scenario → no per-particle JS update, no matrix re-upload
  let upd = 0, inits = 0, setM = 0, gpBuckets = 0, gpMver = 0, legacyBuckets = 0, setCOther = 0, offSetM = 0;
  for (const t of off.ticks) offSetM += t.bucketSetM;
  for (const t of on.ticks) {
    upd += t.calls["Particle.update"]; inits += t.calls["Particle.init"];
    setM += t.bucketSetM; setCOther += t.bucketSetCOther;
    for (const b of t.buckets) { if (b.gp) { gpBuckets++; if (b.mver !== 0) gpMver++; } else if (b.n > 0) legacyBuckets++; }
  }
  const legacyEmitters = on.ticks.some((t) => t.segs && [...t.segs.values()].some((s) => s.some((x) => x[1] >= 0)));
  if (!legacyEmitters) {
    check(`E5 ${name}: flag on, Particle.update runs only inside Particle.init (no per-frame per-particle update)`, upd === inits, `${upd} updates, ${inits} inits`);
    check(`E5 ${name}: flag on, no per-particle setMatrixAt / setColorAt on any bucket (only the creation / growth white)`, setM === 0 && setCOther === 0 && offSetM > 0,
      `setMatrixAt ${setM} (flag off ${offSetM}), per-particle setColorAt ${setCOther}`);
  } else {
    check(`E5 ${name}: flag on, Particle.update only for init + the legacy-path emitters`, upd < off.ticks.reduce((a, t) => a + t.calls["Particle.update"], 0) || upd === inits,
      `${upd} vs flag-off ${off.ticks.reduce((a, t) => a + t.calls["Particle.update"], 0)}`);
  }
  check(`E6 ${name}: no gpu bucket's instance matrix is ever flagged for upload (version 0)`, gpMver === 0, `${gpBuckets} gpu bucket-ticks, ${gpMver} flagged`);
  // P5 publish: the record-index list (instanceColor) goes up every tick a gpu bucket draws
  {
    const upRange = M.pm.particleUploadRangeEnabled();
    const prevVer = new Map();
    let pubN = 0, pubBad = "";
    on.ticks.forEach((t, k) => {
      for (const b of t.buckets) {
        if (!b.gp) continue;
        const pv = prevVer.get(b.im);
        prevVer.set(b.im, b.cver);
        if (b.n === 0) continue;
        pubN++;
        const wantR = JSON.stringify([{ start: 0, count: b.n * 3 }]);
        if (!pubBad && ((pv !== undefined && !(b.cver > pv)) || b.cver === 0 || (upRange && b.cranges !== wantR))) {
          pubBad = `tick ${k} ${b.key}: version ${pv} -> ${b.cver}, ranges ${b.cranges} (want ${upRange ? wantR : "any"})`;
        }
      }
    });
    check(`P5 ${name}: every drawing gpu bucket re-uploads its record-index list each tick (instanceColor version up${upRange ? ", one range [0, 3n)" : ""})`,
      pubBad === "" && (pubN > 0 || gpBuckets === 0), pubBad || `${pubN} bucket-ticks`);
  }
  check(`P10 ${name}: every tick, the tables hold exactly the records / rows live gpu emitters reference (freed ones zero, manager sets exact)`,
    accErrs.length === 0 && accTicks === on.ticks.length, accErrs.join(" | ") || `${accTicks} ticks, up to ${accRecsMax} records`);
  let offMver = 0;
  for (const t of off.ticks) for (const b of t.buckets) offMver = Math.max(offMver, b.mver);
  check(`E6 ${name}: (control) flag-off buckets re-upload their matrices`, offMver > 0 || off.ticks.every((t) => t.buckets.every((b) => b.n === 0)), `max version ${offMver}`);
  // P5 record writes = 8 per emission + 2 per retimed record
  let recBad = -1;
  on.ticks.forEach((t, k) => { if (recBad < 0 && t.recWrites !== 8 * t.gpEmits + 2 * t.retimed) recBad = k; });
  check(`P5 ${name}: record texels written per tick == 8 x emissions + 2 x retimed (no per-frame record traffic)`, recBad === -1,
    recBad >= 0 ? `tick ${recBad}: ${on.ticks[recBad].recWrites} vs ${on.ticks[recBad].gpEmits} emits ${on.ticks[recBad].retimed} retimed` : "");
  // P4 kids: identical except the seed
  let kidBad = -1;
  // toggle: after the runtime toggle back ON (tick 27) the emitters run the
  // legacy instanced path, whose kid velocity keys on `particleFxSeed`'s slot
  // seeds — never drawn for them on the gpu path (diagnostic toggle, by design)
  const kidTicks = name === "toggle" ? 27 : Math.min(off.ticks.length, on.ticks.length);
  for (let k = 0; k < kidTicks && kidBad < 0; k++) {
    const a = off.ticks[k].kids, b = on.ticks[k].kids;
    if (a.length !== b.length) { kidBad = k; break; }
    for (let j = 0; j < a.length; j++) {
      if (a[j].layer !== b[j].layer || a[j].n !== b[j].n || !sameArr(a[j].pos, b[j].pos)) { kidBad = k; break; }
      // aKidRow = (row, seed): the row part only
      for (let q = 0; q < a[j].n; q++) if (a[j].row[q * 2] !== b[j].row[q * 2]) { kidBad = k; break; }
      // velocities from position differences: equal unless a seed collision decides otherwise
      let vd = 0;
      for (let q = 0; q < a[j].vel.length; q++) if (Math.abs(a[j].vel[q] - b[j].vel[q]) > 1e-3) vd++;
      if (vd > Math.max(2, a[j].n * 0.02)) { kidBad = k; break; }
    }
  }
  check(`P4 ${name}: kid records identical except the seed field`, kidBad === -1, kidBad >= 0 ? `tick ${kidBad}` : "");
  offRuns.set(name, { off, on });
}
check("P10 (control) the scenarios finish gpu emitters through the tick's removal path and overwrite a same-id gpu entry (sameId)",
  gpRemovedTotal > 0 && gpOrphanTotal > 0, `${gpRemovedTotal} finished, ${gpOrphanTotal} orphaned`);

// P4 seed freshness: each particle's record seed is constant over its life and fresh at each respawn
section("P4  FX seeds drawn at spawn: constant per life, fresh per respawn");
{
  const lives = new Map();
  let changedInLife = 0, reusedSeeds = 0, respawns = 0;
  await runPath(GEN.SCENARIOS.types, {
    on: true,
    spies: false,
    perTick(h) {
      for (const [, e] of h.mgr.particleTable) {
        if (e._gp !== true) continue;
        for (let i = 0; i < e.parts.length; i++) {
          if (!e.parts[i]) continue;
          // one life = one (slot, birthtime): Particle.init is the only writer of birthtime
          const key = `${e.id}:${i}`;
          const birth = e.particles[i].birthtime;
          const s = e._gpSeed[i];
          const prev = lives.get(key);
          if (prev && prev.birth === birth) {
            if (prev.seed !== s) changedInLife++;
          } else if (prev) {
            respawns++;
            if (prev.seed === s) reusedSeeds++;
          }
          lives.set(key, { birth, seed: s });
        }
      }
    },
  });
  check("P4 a particle's seed never changes during its life", changedInLife === 0, `${changedInLife}`);
  check("P4 a respawned slot gets a fresh seed (collisions only by chance, < 1%)", respawns > 50 && reusedSeeds <= Math.max(1, respawns * 0.01), `${respawns} respawns, ${reusedSeeds} reused`);
}

// ===================================================================== T (corpus)
section("T  the twins vs particle.js on a randomized all-types corpus");
const corpusScenario = (opts) => makeCorpusScenario(GEN, GP, opts);

/** Reference: particle.js's own update on a clone (same frame, same clock: lifetime unchanged). */
const _refMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
function referenceOf(e, i) {
  const P = M.particle.Particle;
  const p = e.particles[i];
  const c = new P();
  c.lastUpdateTime = p.lastUpdateTime; c.birthtime = p.birthtime; c.lifespan = p.lifespan; c.lifetime = p.lifetime;
  c.startFrame.position.copy(p.startFrame.position); c.startFrame.quaternion.copy(p.startFrame.quaternion);
  c.offset.copy(p.offset); c.a.copy(p.a); c.b.copy(p.b); c.c.copy(p.c);
  c.startScale = p.startScale; c.finalScale = p.finalScale; c.startTrans = p.startTrans; c.finalTrans = p.finalTrans;
  const persistent = e.info.totalParticles === 0 && e.info.totalSeconds === 0;
  const frame = e.info.isParentLocal ? e._resolveAnchorFrame() : c.startFrame;
  const m = _refMesh;
  m.position.set(0, 0, 0); m.quaternion.set(0, 0, 0, 1); m.scale.set(1, 1, 1);
  c.update(e.info.particleType, persistent, m, frame);
  m.updateMatrix();
  return { pos: m.position.clone(), quat: m.quaternion.clone(), scale: m.scale.x, visible: m.visible, op: m.userData.__op, lifetime: c.lifetime, me: Array.from(m.matrix.elements),
    origin: frame.position.clone() };
}

async function twinCorpus(label, opts) {
  const perType = new Map();
  let t1Bad = 0, t1N = 0, lifeChanged = 0;
  const examples = [];
  let liveAcross = 0;
  const res = await runPath(corpusScenario(opts), {
    on: true,
    spies: false,
    perTick(h) {
      const T = GP.gpTables();
      const mst = h.mgr._gpState;
      for (const [, e] of h.mgr.particleTable) {
        if (e._gp !== true || e._rp6Culled === true) continue;
        const type = e.info.particleType;
        const bb = e._gpBbW | 0;
        for (let i = 0; i < e.parts.length; i++) {
          if (!e.parts[i]) continue;
          const p = e.particles[i];
          const ref = referenceOf(e, i);
          if (!Object.is(ref.lifetime, p.lifetime)) lifeChanged++;
          // T1: the f64 twin == Particle.update, Object.is on every component
          const tw = GP.gpTwinPos(p, type, e.info.isParentLocal ? e._gpF : p.startFrame.position, [0, 0, 0]);
          const trans = GP.gpSlotTrans(p);
          const vis = !(trans >= 1);
          const op = vis ? Math.max(0, Math.min(1, 1 - trans)) : 0;
          t1N++;
          if (!(Object.is(tw[0], ref.pos.x) && Object.is(tw[1], ref.pos.y) && Object.is(tw[2], ref.pos.z)
            && Object.is(GP.gpSlotScale(p), ref.scale) && vis === ref.visible && Object.is(op, ref.op))) {
            t1Bad++;
            if (examples.length < 3) examples.push(`T1 type ${type} emitter ${e.id} slot ${i}: twin ${tw} vs ${ref.pos.toArray()}`);
          }
          if (!vis) continue;
          // a particle born before the current epoch (it lived across a rebase)
          const persistentE = e.info.totalParticles === 0 && e.info.totalSeconds === 0;
          if (mst && mst.rebases > 0 && (persistentE ? p.lastUpdateTime - p.lifetime : p.lastUpdateTime) < mst.M0) liveAcross++;
          // T2: the f32 GLSL twin from the real tables vs particle.js
          const r = evalGpF32(T.records.data, T.rows.data, e._gpRec[i], { fxColor: true });
          let st = perType.get(type);
          // every 4th sample (the evaluator walks the AST per instance), FX colour with / without motion
          if (((st ? st.n : 0) & 3) === 0) glslVsTwin(T, e._gpRec[i], { fxColor: true, fxMotion: (i & 1) === 1 });
          if (!st) perType.set(type, st = { n: 0, bad: 0, maxP: 0, maxR: 0, maxC: 0 });
          st.n++;
          const P = ref.pos;
          const dP = Math.hypot(r.m[12] - P.x, r.m[13] - P.y, r.m[14] - P.z);
          const travel = Math.hypot(P.x - ref.origin.x, P.y - ref.origin.y, P.z - ref.origin.z);
          const tolP = 1e-4 * Math.max(travel, 1) + 2 * ulp32(Math.max(P.length(), ref.origin.length()));
          let dR = 0;
          if (bb === 0) for (const k of [0, 1, 2, 4, 5, 6, 8, 9, 10]) dR = Math.max(dR, Math.abs(r.m[k] - ref.me[k]));
          const tolR = 1e-4 * Math.max(ref.scale, 1);
          const fa = p.lifespan > 0 ? Math.min(1, Math.max(0, p.lifetime / p.lifespan)) : 0;
          const dC = Math.max(Math.abs(r.c[0] - op), Math.abs(r.c[1] - fa));
          st.maxP = Math.max(st.maxP, dP / Math.max(travel, 1)); st.maxR = Math.max(st.maxR, dR / Math.max(ref.scale, 1)); st.maxC = Math.max(st.maxC, dC);
          // a sample within 1e-9 of the 2e-4 spin threshold may take the other branch
          const th = Math.hypot(p.c.x * p.lifetime, p.c.y * p.lifetime, p.c.z * p.lifetime);
          const nearSpin = (type === 4 || type === 9 || type === 11) && Math.abs(th - 0.0002) < 1e-9;
          if (dP > tolP || dR > (nearSpin ? 2.1e-4 : tolR) || dC > 1e-4 || r.collapsed) {
            st.bad++;
            if (examples.length < 6) examples.push(`T2 type ${type} pl ${e.info.isParentLocal} slot ${i}: dP ${dP.toExponential(2)} tol ${tolP.toExponential(1)} dR ${dR.toExponential(2)} dC ${dC.toExponential(2)}`);
          }
        }
      }
    },
  });
  check(`T1 ${label}: f64 twin Object.is-equal to Particle.update (position, scale, visible, op) for every live particle`, t1Bad === 0 && t1N > 500 && lifeChanged === 0,
    `${t1N} particle-ticks, ${t1Bad} off` + (examples.length ? "; " + examples.join(" | ") : ""));
  const types = [...perType.keys()].sort((a, b) => a - b);
  check(`T2 ${label}: every ParticleType 1..12 covered`, types.length === 12, types.join(","));
  for (const ty of types) {
    const st = perType.get(ty);
    check(`T2 ${label}: type ${ty}: f32 GLSL twin within 1e-4 relative of particle.js (position, rotation x scale, op, fxAge)`, st.bad === 0 && st.n > 20,
      `${st.n} samples; max rel dP ${st.maxP.toExponential(2)} dR ${st.maxR.toExponential(2)} dC ${st.maxC.toExponential(2)} (f32 GPU vs f64 JS)`);
  }
  return { perType, res, liveAcross };
}

await twinCorpus("corpus", { seed: 11, ticks: 48 });
await twinCorpus("corpus at clock +12,345.678 s (no rebase: hi/lo carries it)", { seed: 23, ticks: 30, clock: 12345.678, rebase: 1e9 });
await twinCorpus("corpus at clock +16,000 s (rebased epoch)", { seed: 31, ticks: 30, clock: 16000 });
// T5: epochs rebased while particles live (the +16,000 s jump kills every
// particle in its rebase tick): every live record is retimed, T1 / T2 hold
{
  const rb = await twinCorpus("corpus with an epoch rebase every 0.75 s (particles live across rebases)", { seed: 41, ticks: 150, rebase: 0.75 });
  const st = rb.res.h.mgr._gpState;
  const retimed = rb.res.ticks.reduce((a, t) => a + t.retimed, 0);
  check("T5 the rebase corpus rebased >= 4 times, retimed the live records each time, and drew particles born before the current epoch",
    !!st && st.rebases >= 4 && retimed > 100 && rb.liveAcross > 100, `${st ? st.rebases : 0} rebases, ${retimed} records retimed, ${rb.liveAcross} drawn particle-ticks born before the epoch`);
}
GP.setGpRebaseSeconds(null);

// T3 hi/lo time
section("T3  hi/lo time split");
{
  const f = Math.fround;
  let bad = 0, n = 0, singleBad = 0;
  const R = inputRng(77);
  for (const C of [0, 1e3, 12345.678, 16000]) {
    for (let k = 0; k < 2000; k++) {
      const age = R() * R() * 30;
      const birth = C - age;
      const c = GP.gpSplitTime(C, [0, 0]);
      const b = GP.gpSplitTime(birth, [0, 0]);
      const Chi = f(c[0]), Clo = f(c[1]), Thi = f(b[0]), Tlo = f(b[1]);
      if (Chi !== c[0] || Thi !== b[0]) bad++; // hi parts exact in f32
      const ageF = f(f(Chi - Thi) + f(Clo - Tlo));
      const d = Math.abs(ageF - age);
      n++;
      if (d > Math.pow(2, -23) * age + Math.pow(2, -30)) bad++;
      const single = f(f(C) - f(birth));
      // a 10 m/s particle: the single-float clock breaks T2's 1e-4 relative bound
      if (Math.abs(single - age) * 10 > 1e-4 * Math.max(age * 10, 1)) singleBad++;
    }
  }
  check("T3 |age_f32 - age| <= 2^-23 age + 2^-30 at clocks 0 / 1e3 / 12,345.678 / 16,000 s (hi exact)", bad === 0, `${n} samples, ${bad} off`);
  check("T3 (control) a single-float clock + birth breaks the bound at 12,345.678 s", singleBad > 100, `${singleBad} samples over`);
  // the shader's own expression on the real tables: the single-float reading of the same records is wrong
  let sfBad = 0, sfN = 0;
  await runPath(corpusScenario({ seed: 5, ticks: 12, clock: 12345.678, rebase: 1e9 }), {
    on: true, spies: false,
    perTick(h) {
      const T = GP.gpTables();
      for (const [, e] of h.mgr.particleTable) {
        if (e._gp !== true || e.info.particleType !== 2) continue;
        for (let i = 0; i < e.parts.length; i++) {
          if (!e.parts[i]) continue;
          const a = evalGpF32(T.records.data, T.rows.data, e._gpRec[i], {});
          const s = evalGpF32(T.records.data, T.rows.data, e._gpRec[i], { singleFloatTime: true });
          sfN++;
          if (Math.abs(s.t - e.particles[i].lifetime) > 1e-5 && Math.abs(a.t - e.particles[i].lifetime) < 1e-6) sfBad++;
        }
      }
    },
  });
  GP.setGpRebaseSeconds(null);
  check("T3 (control) the single-float reading of the real records misses the age at 12,345.678 s; hi/lo hits it", sfBad > 0, `${sfBad}/${sfN}`);
}

// T4 analytic velocity vs the flag-off finite difference (60 Hz, then 30 Hz:
// the shader's lag and spawn-tick zero read the manager's MEASURED tick dt)
section("T4  ?fxMotion velocity: analytic (lagged 1.5 ticks) vs the flag-off smoothed finite difference");
// The rig moves at (3, 0, 1.2) m/s for MOVE ticks, then holds still for HOLD
// ticks. The flag-off velocity (particle_fx.js particleFxSlotVelocity) halves
// the anchor's share per tick once it stops; the row's anchor velocity must be
// zero from the first still tick, so from DECAY ticks after the halt both
// paths agree on the particle's own velocity.
const T4_MOVE = 70, T4_HOLD = 40, T4_DECAY = 10;
async function t4Run(hz) {
  const dt = 1 / hz;
  const step = hz === 60 ? [0.05, 0.02] : [3 / hz, 1.2 / hz];
  const scen = async (h) => {
    h.defGfx(0x0100c801, {});
    const a = h.frozenAnchor(0, 0, 0, { yaw: 0.4 });
    for (const type of [2, 3, 5, 7, 8, 10, 12]) {
      await h.add({ anchor: a, info: GEN.POJO({ particleType: type, id: 0x3200000b, hwGfxObjId: 0x0100c801, lifespan: 3, lifespanRand: 0,
        birthrate: 0.1, maxParticles: 12, initialParticles: 2, bX: 0.8, bY: 0.6, bZ: -2, cX: 0.6, cY: 0.5, cZ: 0.4, aX: 1.5 }) });
    }
    // retail-like gravity: a velocity read without the 1.5-tick lag is off by 1.5 dt |B| = 0.25 m/s
    for (const type of [3, 8, 10]) {
      await h.add({ anchor: a, info: GEN.POJO({ particleType: type, id: 0x3200000b, hwGfxObjId: 0x0100c801, lifespan: 3, lifespanRand: 0,
        birthrate: 0.1, maxParticles: 12, initialParticles: 2, bX: 0, bY: 0, bZ: -9.8, minB: 1, maxB: 1, aX: 1.5, aZ: 4 }) });
    }
    // a teleport-fast emitter: both paths zero it (|v| above 60 m/s and 1.25 x maxSpeed)
    await h.add({ anchor: a, info: GEN.POJO({ particleType: 2, id: 0x3200000b, hwGfxObjId: 0x0100c801, aX: 400, minA: 1, maxA: 1, lifespan: 3, lifespanRand: 0 }) });
    // parent-local emitters on a rig moving at (3, 0, 1.2) m/s: the flag-off
    // finite difference carries the anchor's motion, the shader adds the row's
    // anchor velocity to the analytic one
    const rig = h.movingAnchor(-2, 0.5, 0);
    for (const type of [2, 3, 7]) {
      await h.add({ anchor: rig, info: GEN.POJO({ particleType: type, id: 0x3200000b, hwGfxObjId: 0x0100c801, isParentLocal: true, lifespan: 3, lifespanRand: 0,
        birthrate: 0.1, maxParticles: 12, initialParticles: 2, bX: 0.8, bY: 0.6, bZ: -2, cX: 0.6, cY: 0.5, cZ: 0.4, aX: 1.5 }) });
    }
    for (let i = 0; i < T4_MOVE + T4_HOLD; i++) {
      const j = Math.min(i, T4_MOVE - 1);
      rig.position.set(-2 + step[0] * j, 0.5, step[1] * j);
      rig.updateMatrixWorld(true);
      await h.tick(dt);
    }
  };
  const off = await runPath(scen, { on: false, spies: false });
  // move = ticks before the halt (the original T4 sample set); hold = from T4_DECAY ticks after it
  const acc = () => ({ n: 0, bad: 0, maxRel: 0, nPl: 0, ex: [] });
  const res = { move: acc(), hold: acc(), spawnBad: 0, dtRow: new Set() };
  await runPath(scen, {
    on: true, spies: false,
    perTick(h, t, k) {
      const offT = off.ticks[k];
      const T = GP.gpTables();
      const ph = k < T4_MOVE ? res.move : (k >= T4_MOVE + T4_DECAY ? res.hold : null);
      for (const nb of t.buckets) {
        if (!nb.gp || !nb.fx) continue;
        const ob = offT.buckets.find((b) => b.key + "|gp" === nb.key);
        if (!ob || ob.n !== nb.n) continue;
        for (let j = 0; j < nb.n; j++) {
          const r = evalGpF32(T.records.data, T.rows.data, nb.col[j * 3], { fxColor: true, fxMotion: true });
          const vo = [ob.mat[j * 16 + 3], ob.mat[j * 16 + 7], ob.mat[j * 16 + 11]];
          const vg = [r.m[3], r.m[7], r.m[11]];
          const ticks = Math.round(r.t * hz);
          if (ticks === 0) { if (Math.hypot(...vg) !== 0 || Math.hypot(...vo) !== 0) res.spawnBad++; continue; }
          if (ticks < 8 || ph === null) continue;
          // the record's type: through its emitter row
          const er = Math.round(T.records.data[nb.col[j * 3] * 32 + 24]);
          const ty = Math.round(T.rows.data[er * 32 + 12]);
          res.dtRow.add(T.rows.data[Math.round(T.rows.data[er * 32 + 3]) * 32 + 2]);
          if (T.rows.data[er * 32 + 13] === 1) ph.nPl++;
          const sw = ty === 5 || ty === 7;
          const d = Math.hypot(vg[0] - vo[0], vg[1] - vo[1], vg[2] - vo[2]);
          const mag = Math.hypot(...vo);
          // tighter than the design's 5% + 0.05 / 15% + 0.1 (measured agreement ~2e-3)
          const tol = sw ? 0.05 * mag + 0.05 : 0.01 * mag + 0.01;
          ph.n++;
          ph.maxRel = Math.max(ph.maxRel, d / Math.max(mag, 1e-3));
          if (d > tol) { ph.bad++; if (ph.ex.length < 3) ph.ex.push(`tick ${k} type ${ty} age ${ticks}: gpu ${vg.map((x) => x.toFixed(3))} vs fd ${vo.map((x) => x.toFixed(3))}`); }
        }
      }
    },
  });
  return res;
}
{
  const r60 = await t4Run(60);
  const m = r60.move;
  check("T4 from the 8th tick of a particle's life: within 1% + 0.01 m/s (parabolic / velocity), 5% + 0.05 m/s (Swarm / Implode); parent-local on a moving rig included",
    m.n > 200 && m.nPl > 60 && m.bad === 0,
    `${m.n} samples (${m.nPl} parent-local on the moving rig), ${m.bad} off, max rel ${m.maxRel.toExponential(2)}` + (m.ex.length ? "; " + m.ex.join(" | ") : ""));
  check("T4 the spawn tick reads zero velocity on both paths; the teleport-fast emitter is zeroed on both", r60.spawnBad === 0, `${r60.spawnBad}`);
  const s = r60.hold;
  check(`T4 the rig stops: from ${T4_DECAY} ticks after the halt the parent-local particles' velocity has lost the anchor term on both paths (same tolerances)`,
    s.n > 200 && s.nPl > 60 && s.bad === 0,
    `${s.n} samples (${s.nPl} parent-local on the stopped rig), ${s.bad} off, max rel ${s.maxRel.toExponential(2)}` + (s.ex.length ? "; " + s.ex.join(" | ") : ""));
  const r30 = await t4Run(30);
  const a = r30.move, b = r30.hold;
  check("T4 at 30 Hz (the lag and the spawn-tick zero use the measured tick dt, here 1/30 s): moving and stopped rig, same tolerances, spawn tick zero on both paths",
    a.n > 100 && a.nPl > 30 && a.bad === 0 && b.n > 100 && b.nPl > 30 && b.bad === 0 && r30.spawnBad === 0 && r30.dtRow.size > 0 && [...r30.dtRow].every((x) => Math.abs(x - 1 / 30) < 1e-6),
    `moving ${a.n} (${a.nPl} parent-local) ${a.bad} off, max rel ${a.maxRel.toExponential(2)}; stopped ${b.n} (${b.nPl}) ${b.bad} off; spawn ${r30.spawnBad}; dt rows ${[...r30.dtRow]}`
      + ([...a.ex, ...b.ex].length ? "; " + [...a.ex, ...b.ex].slice(0, 3).join(" | ") : ""));
}

// ===================================================================== G (GLSL + patch)
section("G  GLSL source, the patch, program keys, the fog chain, the self-check");
{
  const H = GP.GP_GLSL_HEADER;
  check("G1 (H2) no backtick, quote or non-ASCII character anywhere in the gpu GLSL", !/[`'"]/.test(H + GP.GP_GLSL_CALL) && !/[^\x00-\x7f]/.test(H + GP.GP_GLSL_CALL));
  const helper = readFileSync(join(HERE, "helpers", "gpu_particles_f32.mjs"), "utf8");
  const consts = ["0.63661977", "1.5703125", "0.00048382679", "1.9515295891e-4", "8.3321608736e-3", "1.6666654611e-1",
    "2.443315711809948e-5", "1.388731625493765e-3", "4.166664568298827e-2", "0.0002", "1e-10", "1e-8"];
  check("G2 the GLSL and the f32 twin carry the same constants (Cody-Waite pi/2 split, the sin / cos polynomials, spin threshold, billboard epsilons)",
    consts.every((c) => H.includes(c) && helper.includes(c)), consts.filter((c) => !H.includes(c) || !helper.includes(c)).join(","));
  check("G2 1.5703125 + 0.00048382679 == pi / 2 (f32 split); 1.5703125 = 201 / 128 (8 significant bits: k * 1.5703125 exact for |k| < 2^16)",
    Math.abs(1.5703125 + 0.00048382679 - Math.PI / 2) < 1e-11 && 1.5703125 * 128 === 201 && Math.fround(1.5703125) === 1.5703125);
  const forms = [
    ["age = (Chi - Thi) + (Clo - Tlo)", "float t = ( m0.x - r0.w ) + ( m0.y - r2.w );"],
    ["interval = lifespan > 0 ? min(t / lifespan, 1) : 1", "float iv = ls > 0.0 ? min( t / ls, 1.0 ) : 1.0;"],
    ["scale / translucency lerps", "float sc = r5.x + ( r5.y - r5.x ) * iv;"],
    ["trans >= 1 collapses", "if ( !( tr < 1.0 ) || sc == 0.0 ) return;"],
    ["op = clamp(1 - trans)", "float op = clamp( 1.0 - tr, 0.0, 1.0 );"],
    ["types 2 / 12: t A", "if ( ty == 2 || ty == 12 ) {"],
    ["parabolic types 3/8/10 and GR 4/9/11: t A + t t / 2 B", "P += t * A + ( t * t * 0.5 ) * B;"],
    ["Swarm: cos x, SIN y, cos z, C the amplitude", "P += vec3( hbGpCos( t * B.x ) * C.x, hbGpSin( t * B.y ) * C.y, hbGpCos( t * B.z ) * C.z ) + t * A;"],
    ["Explode: (t B + C A.x + (0,0,A.z)) t", "P += ( t * B + C * A.x + vec3( 0.0, 0.0, A.z ) ) * t;"],
    ["Implode: cos(A.x t) C + t t B", "P += hbGpCos( A.x * t ) * C + ( t * t ) * B;"],
    ["GR spin: axis-angle at |C| t, threshold 2e-4, post-multiplied", "R = hbGpQMat( normalize( hbGpQMul( qf, sp ) ) );"],
    ["GR start frame: the row (parent-local) or the record", "vec4 qf = pl ? hbGpE( er, 1 ) : hbGpR( rec, 4 );"],
    ["mode 2: basis(dir x aim, dir, aim)", "R = mat3( cross( d, z ), d, z );"],
    ["modes 3/4/5 keep the CURRENT axis (identity, or the GR spun frame)", "vec3 keep = normalize( bb == 5 ? R[ 2 ] : ( bb == 4 ? R[ 1 ] : R[ 0 ] ) );"],
    ["modes 3/4/5 aim along the viewer line", "vec3 aim = d - keep * dot( d, keep );"],
    ["mode 2 aim: up minus its dir component", "vec3 z = vec3( 0.0, 0.0, 1.0 ) - d * d.z;"],
    ["the billboard reads the per-manager camera rows", "vec3 d = P - hbGpE( mr, 1 ).xyz;"],
    ["mode 5 keeps Z", "if ( bb == 5 ) R = mat3( third, aim, keep );"],
    ["mode 4 keeps Y", "else if ( bb == 4 ) R = mat3( aim, keep, third );"],
    ["mode 3 keeps X", "else R = mat3( keep, third, aim );"],
    ["POJO sprite: camWorld - P (the scene-local quirk)", "vec3 d6 = hbGpE( mr, 2 ).xyz - P;"],
    ["velocity lag 1.5 ticks", "float tv = max( t - 1.5 * m0.z, 0.0 );"],
    ["spawn-tick / teleport zero", "if ( t < 0.5 * m0.z || dot( V, V ) > e3.w ) V = vec3( 0.0 );"],
    ["FX colour (op, fxAge, (fxLive ? row : 0) + seed)", "hbGpIc = vec3( op, fa, ( hbGpE( 0, 0 ).x > 0.5 ? e2.w : 0.0 ) + r3.w );"],
    ["record addressing: 256 per texture row, 8 texels each", "return ivec2( ( i - q * 256 ) * 8 + k, q );"],
    // every remaining evaluating line of hbGpEval, pinned verbatim (the f32 twin mirrors each; the smoke runs them)
    ["record index from instanceColor.r, 0 = none", "int rec = int( hbGpRawIndex().x + 0.5 );"],
    ["record 0 / no record collapses", "if ( rec <= 0 ) return;"],
    ["emitter row from the record", "int er = int( r6.x + 0.5 );"],
    ["manager row from the emitter row", "int mr = int( e0.w + 0.5 );"],
    ["manager clock texel", "vec4 m0 = hbGpE( mr, 0 );"],
    ["type / parent-local / billboard from the emitter row", "int ty = int( e3.x + 0.5 );"],
    ["parent-local flag", "bool pl = e3.y > 0.5;"],
    ["parent-local: base = anchor + offset; else the pre-summed base", "vec3 P = pl ? e0.xyz + r0.xyz : r0.xyz;"],
    ["types 2 / 12 position", "P += t * A;"],
    ["types 2 / 12 velocity", "V = A;"],
    ["parabolic velocity", "V = A + tv * B;"],
    ["parabolic + GR types", "} else if ( ty == 3 || ty == 8 || ty == 10 || ty == 4 || ty == 9 || ty == 11 ) {"],
    ["Swarm branch", "} else if ( ty == 5 ) {"],
    ["Swarm velocity: d/dt (cos x, sin y, cos z) C at the lagged age", "V = A + vec3( -B.x * hbGpSin( tv * B.x ) * C.x, B.y * hbGpCos( tv * B.y ) * C.y, -B.z * hbGpSin( tv * B.z ) * C.z );"],
    ["Explode branch", "} else if ( ty == 6 ) {"],
    ["Explode velocity", "V = 2.0 * tv * B + C * A.x + vec3( 0.0, 0.0, A.z );"],
    ["Implode branch", "} else if ( ty == 7 ) {"],
    ["Implode velocity", "V = -A.x * hbGpSin( A.x * tv ) * C + 2.0 * tv * B;"],
    ["GR types only", "if ( ty == 4 || ty == 9 || ty == 11 ) {"],
    ["GR spin axis + rate texel", "vec4 r7 = hbGpR( rec, 7 );"],
    ["GR spin angle |C| t", "float th = r7.w * t;"],
    ["GR spin threshold", "if ( th >= 0.0002 ) {"],
    ["GR half angle: sin and cos of one reduction", "vec2 h = hbGpSinCos( 0.5 * th );"],
    ["GR spin quaternion (axis sin(h), cos(h))", "sp = vec4( r7.xyz * h.x, h.y );"],
    // sin / cos of the closed forms: + - * floor only (no driver transcendental)
    ["sin / cos: quadrant k = floor(x 2/pi + 0.5)", "float k = floor( x * 0.63661977 + 0.5 );"],
    ["sin / cos: Cody-Waite r = x - k pi/2 in two parts", "float r = ( x - k * 1.5703125 ) - k * 0.00048382679;"],
    ["sin / cos: the cephes sinf polynomial", "float s = ( ( -1.9515295891e-4 * z + 8.3321608736e-3 ) * z - 1.6666654611e-1 ) * z * r + r;"],
    ["sin / cos: the cephes cosf polynomial", "float c = ( ( 2.443315711809948e-5 * z - 1.388731625493765e-3 ) * z + 4.166664568298827e-2 ) * z * z - 0.5 * z + 1.0;"],
    ["sin / cos: the quadrant", "float q = k - 4.0 * floor( k * 0.25 );"],
    ["billboard mode + camera row on", "if ( bb != 0 && m0.w > 0.5 ) {"],
    ["POJO sprite: unit-vectors from the quad normal to the camera direction", "if ( dot( d6, d6 ) >= 1e-10 ) R = hbGpQMat( hbGpUnitVectors( hbGpE( er, 4 ).xyz, normalize( d6 ) ) );"],
    ["modes 3/4/5: the third axis", "vec3 third = cross( aim, keep );"],
    ["instance matrix: rotation x scale, translation P", "hbGpIm = mat4( vec4( R[ 0 ] * sc, 0.0 ), vec4( R[ 1 ] * sc, 0.0 ), vec4( R[ 2 ] * sc, 0.0 ), vec4( P, 1.0 ) );"],
    ["?fxMotion: the parent-local anchor's velocity is added", "if ( pl ) V += e2.xyz;"],
    ["?fxMotion velocity row", "hbGpIm[ 0 ][ 3 ] = V.x;"],
    ["FX age", "float fa = ls > 0.0 ? clamp( t / ls, 0.0, 1.0 ) : 0.0;"],
    ["stock colour (op, op, op)", "hbGpIc = vec3( op );"],
  ];
  const missing = forms.filter(([, s]) => !H.includes(s)).map(([n]) => n);
  check("G3 the GLSL carries the twin's closed forms, lerps, billboards, colour and addressing verbatim", missing.length === 0, missing.join("; "));
  check("G3 layout constants agree (2048 wide, 8 texels, 256 per row)", GP.GP_WIDTH === 2048 && GP.GP_TEXELS === 8 && GP.GP_PER_ROW === 256 && GP.GP_FLOATS === 32);
  // the f32 twin's sin / cos: within 1.5e-7 of sin / cos of the f32 argument (one ulp at 1 is 1.19e-7)
  {
    let worst = 0;
    for (const x of [0, 1e-6, -0.3, 0.7853, 0.7854, -0.7854, 1.5707963, 3.14159265, 3.5, -7.2, 100.123, -1234.5, 1999.9]) {
      const [s, c] = sinCosF32(x), xf = Math.fround(x);
      worst = Math.max(worst, Math.abs(s - Math.sin(xf)), Math.abs(c - Math.cos(xf)));
    }
    check("G3 the twin's sinCosF32 (quadrant Cody-Waite + cephes polynomials) is within 1.5e-7 of sin / cos at quadrant edges and large |x|", worst <= 1.5e-7, `worst ${worst.toExponential(2)}`);
  }

  // G4: the GLSL helpers (scalar bodies: JS once the types are dropped) evaluated
  // AS WRITTEN against three's own quaternion / matrix code and the exact reduction
  const comps = (v) => (typeof v === "number" ? [v] : [v.x, v.y, v.z, v.w].filter((c) => c !== undefined));
  const B = {
    floor: Math.floor, abs: Math.abs,
    vec4: (...a) => { const c = a.flatMap(comps); return { x: c[0], y: c[1], z: c[2], w: c[3] }; },
    dot: (a, b) => { const x = comps(a), y = comps(b); return x.reduce((acc, v, i) => acc + v * y[i], 0); },
    cross: (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }),
    normalize: (v) => { const c = comps(v); const l = Math.hypot(...c); const o = { x: c[0] / l, y: c[1] / l, z: c[2] / l }; if (c.length === 4) o.w = c[3] / l; return o; },
    mat3: (...a) => a,
  };
  const glslHelper = (name) => {
    const L = H.split("\n");
    const at = L.findIndex((l) => l.startsWith(`vec4 ${name}(`) || l.startsWith(`mat3 ${name}(`) || l.startsWith(`float ${name}(`));
    if (at < 0) return null;
    const end = L.indexOf("}", at);
    const sig = /^\w+ (\w+)\( (.*) \) \{$/.exec(L[at]);
    if (!sig || end < 0) return null;
    const params = sig[2].split(",").map((x) => x.trim().split(/\s+/).pop());
    const body = L.slice(at + 1, end).map((l) => l.replace(/^(\s*)(?:float|vec[234]|mat[34]|int|bool) (?=\w+( =|;))/, "$1let "));
    try {
      return new Function(...Object.keys(B), `return function ${name}(${params.join(", ")}) {\n${body.join("\n")}\n};`)(...Object.values(B));
    } catch (e) { return null; }
  };
  const gMul = glslHelper("hbGpQMul"), gMat = glslHelper("hbGpQMat"), gUv = glslHelper("hbGpUnitVectors");
  const RG = inputRng(1234);
  const rq = () => new THREE.Quaternion(RG() * 2 - 1, RG() * 2 - 1, RG() * 2 - 1, RG() * 2 - 1).normalize();
  const rv = () => new THREE.Vector3(RG() * 2 - 1, RG() * 2 - 1, RG() * 2 - 1).normalize();
  // hbGpSinCos AS WRITTEN (the GLSL evaluator, f32 per operation) == the twin
  // bit for bit, and within 1.5e-7 of sin / cos of its f32 argument, |x| to 2000
  let scBad = 0, scTwin = 0, scWorst = 0, scN = 0, scErr = "";
  try {
    const prog = compileGlslProgram(["#version 300 es", "#define USE_INSTANCING", "#define USE_INSTANCING_COLOR", "in vec3 instanceColor;", "uniform float uX;",
      H, "void main() {", "\tgl_Position = vec4( hbGpSinCos( uX ), hbGpSin( uX ), hbGpCos( uX ) );", "}"].join("\n"));
    const dummy = { data: new Float32Array(GP.GP_WIDTH * 4), width: GP.GP_WIDTH };
    for (let i = 0; i < 6000; i++) {
      const x = Math.fround(i < 1000 ? (RG() * 2 - 1) * Math.PI : (RG() * 2 - 1) * (i < 3000 ? 40 : 2000));
      const g = prog({ uniforms: { uX: x }, attributes: { instanceColor: [0, 0, 0] }, textures: { uGpRec: dummy, uGpRow: dummy } }).get("gl_Position");
      const tw = sinCosF32(x);
      scN++;
      if (g[0] !== tw[0] || g[1] !== tw[1] || g[2] !== tw[0] || g[3] !== tw[1]) scTwin++;
      const e = Math.max(Math.abs(g[0] - Math.sin(x)), Math.abs(g[1] - Math.cos(x)));
      scWorst = Math.max(scWorst, e);
      if (e > 1.5e-7) scBad++;
    }
  } catch (e) { scErr = String(e && e.message || e).slice(0, 200); }
  check("G4 GLSL hbGpSinCos / hbGpSin / hbGpCos as written (f32 per operation) == the twin bit for bit and within 1.5e-7 of sin / cos, |x| to 2000",
    !scErr && scN === 6000 && scTwin === 0 && scBad === 0, scErr || `${scN} samples, ${scTwin} differ from the twin, ${scBad} off, worst ${scWorst.toExponential(2)}`);
  let mulBad = 0, matBad = 0, uvBad = 0, uvAnti = 0;
  if (gMul && gMat && gUv) {
    for (let i = 0; i < 500; i++) {
      const a = rq(), b = rq();
      const g = gMul(a, b), t = new THREE.Quaternion().multiplyQuaternions(a, b);
      if (Math.max(Math.abs(g.x - t.x), Math.abs(g.y - t.y), Math.abs(g.z - t.z), Math.abs(g.w - t.w)) > 1e-12) mulBad++;
      const m = gMat(a), e = new THREE.Matrix4().makeRotationFromQuaternion(a).elements;
      const want = [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]];
      if (m.length !== 9 || m.some((v, k) => Math.abs(v - want[k]) > 1e-12)) matBad++;
      const f = rv(), to = i % 5 === 0 ? f.clone().negate() : rv();
      if (i % 5 === 0) uvAnti++;
      const u = gUv(f, to), q = new THREE.Quaternion().setFromUnitVectors(f, to);
      if (Math.max(Math.abs(u.x - q.x), Math.abs(u.y - q.y), Math.abs(u.z - q.z), Math.abs(u.w - q.w)) > 1e-12) uvBad++;
    }
  }
  check("G4 GLSL hbGpQMul as written == THREE.Quaternion.multiplyQuaternions", !!gMul && mulBad === 0, `${mulBad} off`);
  check("G4 GLSL hbGpQMat as written == THREE.Matrix4.makeRotationFromQuaternion (columns)", !!gMat && matBad === 0, `${matBad} off`);
  check("G4 GLSL hbGpUnitVectors as written == THREE.Quaternion.setFromUnitVectors (incl. anti-parallel)", !!gUv && uvBad === 0 && uvAnti > 50, `${uvBad} off`);
  // G5 (fed by every P3 / T2 comparison above): the shader text and the twin are one function
  const bbSeen = [...G5.bb].sort((a, b) => a - b).join(","), tySeen = [...G5.types].sort((a, b) => a - b);
  check("G5 the GLSL header evaluated as written (node GLSL-subset evaluator, f32 per operation) == the f32 twin bit for bit on every P3 instance and every 4th T2 sample: types 1..12, billboards 0/2/3/4/5/sprite, the stock / FX / FX + motion programs",
    G5.bad === 0 && G5.n > 20000 && tySeen.length === 12 && bbSeen === "0,2,3,4,5,6" && ["00", "10", "11"].every((v) => G5.variants.has(v)),
    `${G5.n} instances, ${G5.bad} off; types ${tySeen.join(",")} bb ${bbSeen} programs ${[...G5.variants].sort().join(",")}` + (G5.err ? `; error ${G5.err}` : "") + (G5.ex.length ? "; " + G5.ex.join(" | ") : ""));
  const ctl = Object.keys(G5_CONTROLS).map((k) => [k, G5.ctl[k] || { n: 0, diff: 0 }]);
  check("G5 (control) one-token edits of the header (GR half-angle, parent-local anchor, Swarm velocity sign) disagree with the twin on most of their instances",
    ctl.every(([, c]) => !c.missing && c.n >= 50 && c.diff > 0.8 * c.n), ctl.map(([k, c]) => `${k} ${c.diff}/${c.n}${c.missing ? " (anchor missing)" : ""}`).join(", "));
  check("G5 the scenario tables reach past the first texture row (grow: > 256 live records), incl. records at a row boundary (index % 256 == 255 or 0)",
    G5.maxRec >= GP.GP_PER_ROW && G5.rowEdge > 0, `max record ${G5.maxRec}, ${G5.rowEdge} boundary samples`);

  // G5b: every G5 sample (one per type / parent-local / billboard / program)
  // moved to records and rows AT texture-row boundaries (255 / 256 / 511 / 512 /
  // 767) of 3-row tables: hbGpAt's row / column split must address them exactly
  // (the evaluator's texelFetch throws out of range instead of aliasing a
  // negative column onto the previous row), and the relocated twin must equal
  // the sample's own twin (the relocation is faithful).
  {
    const W = GP.GP_WIDTH, FL = GP.GP_FLOATS, ROWS = 3;
    const PLACES = [[255, 256, 511], [256, 511, 255], [511, 255, 256], [512, 767, 512], [767, 512, 767], [254, 257, 510]];
    const recD = new Float32Array(W * 4 * ROWS), rowD = new Float32Array(W * 4 * ROWS);
    const runs = new Map();
    let n = 0, bad = 0, relocBad = 0, err = "";
    const ex = [];
    for (const [sk, smp] of G5.samples) {
      for (const [R, E, Mr] of PLACES) {
        recD.fill(0); rowD.fill(0);
        rowD.set(smp.grow, 0);
        rowD.set(smp.mrow, Mr * FL);
        rowD.set(smp.erow, E * FL);
        rowD[E * FL + 3] = Mr; // E_ANCHOR.w = the manager row
        recD.set(smp.rec, R * FL);
        recD[R * FL + 24] = E; // EROW.x = the emitter row
        const key = `${+smp.fxColor}${+smp.fxMotion}`;
        let run = runs.get(key);
        if (!run) runs.set(key, run = compileGpHeader(GP.GP_GLSL_HEADER, { fxColor: smp.fxColor, fxMotion: smp.fxMotion }));
        const tw = evalGpF32(recD, rowD, R, { fxColor: smp.fxColor, fxMotion: smp.fxMotion });
        n++;
        if (!sameArr(Array.from(tw.m), Array.from(smp.tw.m)) || !sameArr(Array.from(tw.c), Array.from(smp.tw.c))) { relocBad++; continue; }
        let r;
        try {
          r = run({ instanceColor: [R, 0, 0], textures: { uGpRec: { data: recD, width: W }, uGpRow: { data: rowD, width: W } } });
        } catch (e) {
          bad++;
          if (!err) err = `${sk} @ rec ${R} row ${E} mgr ${Mr}: ${String(e && e.message || e).slice(0, 160)}`;
          continue;
        }
        let ok = true;
        for (let k = 0; k < 16 && ok; k++) if (!(r.m[k] === tw.m[k] || (Number.isNaN(r.m[k]) && Number.isNaN(tw.m[k])))) ok = false;
        for (let k = 0; k < 3 && ok; k++) if (Math.fround(r.c[k]) !== Math.fround(tw.c[k])) ok = false;
        if (!ok) { bad++; if (ex.length < 2) ex.push(`${sk} @ rec ${R} row ${E} mgr ${Mr}`); }
      }
    }
    const types = new Set([...G5.samples.keys()].map((k) => +k.split("|")[0]));
    check("G5b the header addresses records and rows at texture-row boundaries (255 / 256 / 511 / 512 / 767) exactly: == the twin bit for bit, every sampled type / billboard / program",
      n >= 12 * PLACES.length && types.size === 12 && bad === 0 && relocBad === 0,
      `${G5.samples.size} samples x ${PLACES.length} placements = ${n}, ${bad} off, ${relocBad} relocations unfaithful` + (err ? `; ${err}` : "") + (ex.length ? `; ${ex.join(" | ")}` : ""));
  }

  // H1: the patch on stock, every FX tier variant, alpha, glow
  const lib = THREE.ShaderLib.basic;
  const mkShader = () => ({ vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, uniforms: {} });
  const compile = (mat) => { const s = mkShader(); mat.onBeforeCompile(s, null); return s; };
  const verify = (s, label) => {
    const vs = s.vertexShader;
    const first = vs.indexOf(GP.GP_MARKER);
    const once = first !== -1 && vs.indexOf(GP.GP_MARKER, first + 1) === -1;
    const beforeCommon = first !== -1 && first < vs.indexOf("#include <common>");
    const mainFirst = vs.includes("void main() {" + GP.GP_GLSL_CALL);
    const lines = vs.split("\n");
    let undefOk = true, defines = 0;
    let past = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("void hbGpEval()")) past = true;
      if (/^\s*#define instanceMatrix /.test(lines[i])) {
        defines++;
        if (past && !/^\s*#undef instanceMatrix\s*$/.test(lines[i - 1] || "")) undefOk = false;
      }
    }
    const again = { vertexShader: vs, fragmentShader: s.fragmentShader, uniforms: {} };
    GP.patchGpVertexShader(again, true);
    const idem = again.vertexShader === vs;
    const ok = once && beforeCommon && mainFirst && undefOk && idem && s.uniforms.uGpRec === GP.GP_UNIFORMS.uGpRec && s.uniforms.uGpRow === GP.GP_UNIFORMS.uGpRow;
    return { ok, detail: `${label}: once ${once} beforeCommon ${beforeCommon} mainFirst ${mainFirst} undef ${undefOk} (${defines} defines) idempotent ${idem}`, defines };
  };
  const results = [];
  // stock additive
  { const m = new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending }); GP.applyGpParticleMaterial(m); results.push(verify(compile(m), "stock additive")); }
  // stock alpha (the hbParticleInstAlpha patch)
  { const m = new THREE.MeshBasicMaterial(); M.pm._configureAlphaBucketMaterial(m); GP.applyGpParticleMaterial(m); const s = compile(m);
    results.push(verify(s, "stock alpha")); results.push({ ok: s.fragmentShader.includes("diffuseColor.a *= vColor.r;"), detail: "alpha frag patch kept" }); }
  // every FX tier variant (tier 1 smoke / csm, tier 2 motion / shapes / clamp)
  const csmU = { uCsmShadowMap0: { value: null }, uCsmShadowMap1: { value: null }, uCsmShadowMap2: { value: null }, uCsmMatrix0: { value: new THREE.Matrix4() },
    uCsmMatrix1: { value: new THREE.Matrix4() }, uCsmMatrix2: { value: new THREE.Matrix4() }, uCsmSplits: { value: new THREE.Vector2() }, uCsmFar: { value: 100 } };
  let fxVariants = 0, fxDefines2 = 0;
  for (const smoke of [false, true]) {
    for (const csm of smoke ? [false, true] : [false]) {
      for (let bits = 0; bits < 8; bits++) {
        M.fx._setParticleFxVariantForTest(smoke, csm ? csmU : null);
        M.fx._setParticleFxTier2VariantForTest({ motion: !!(bits & 1), shapes: !!(bits & 2), clamp: !!(bits & 4) });
        for (const additive of [true, false]) {
          const m = new THREE.MeshBasicMaterial({ map: new THREE.Texture() });
          if (!additive) M.pm._configureAlphaBucketMaterial(m);
          M.fx.applyParticleFxMaterial(m, { additive });
          const legacyKey = m.customProgramCacheKey();
          GP.applyGpParticleMaterial(m, { fx: true });
          const r = verify(compile(m), `fx s${+smoke}c${+csm} t2=${bits} ${additive ? "add" : "alpha"}`);
          results.push(r);
          if (r.defines === 2) fxDefines2++;
          results.push({ ok: m.customProgramCacheKey() === legacyKey + "|gp", detail: `key ${m.customProgramCacheKey()} vs ${legacyKey}|gp` });
          fxVariants++;
        }
        // the glow twin of an additive FX bucket
        const g = M.fx.makeParticleFxGlowMaterial(new THREE.MeshBasicMaterial({ map: new THREE.Texture() }));
        const gk = g.customProgramCacheKey();
        GP.applyGpParticleMaterial(g, { fx: true });
        results.push(verify(compile(g), `glow t2=${bits}`));
        results.push({ ok: g.customProgramCacheKey() === gk + "|gp", detail: `glow key ${g.customProgramCacheKey()}` });
      }
    }
  }
  M.fx._setParticleFxVariantForTest(null, null);
  M.fx._setParticleFxTier2VariantForTest(null);
  const badH1 = results.filter((r) => !r.ok);
  check(`H1 the patch on stock / alpha / ${fxVariants} FX tier variants / glow: header once before <common>, hbGpEval first in main, #undef before every later #define instanceMatrix, idempotent`,
    badH1.length === 0 && fxDefines2 > 0, badH1.slice(0, 3).map((r) => r.detail).join(" | ") || `${fxDefines2} programs carry FX's own redirect`);
  // H3 keys
  {
    const add = new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending });
    const legacy = new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending });
    GP.applyGpParticleMaterial(add);
    const alpha = new THREE.MeshBasicMaterial(); M.pm._configureAlphaBucketMaterial(alpha);
    const alphaLegacy = alpha.customProgramCacheKey();
    GP.applyGpParticleMaterial(alpha);
    const k1 = add.customProgramCacheKey(), k2 = add.customProgramCacheKey();
    check("H3 stock additive gpu key == hbParticleGpAdd; alpha == hbParticleInstAlpha|gp; constant per call; legacy keys untouched",
      k1 === "hbParticleGpAdd" && k1 === k2 && alpha.customProgramCacheKey() === "hbParticleInstAlpha|gp" && alphaLegacy === "hbParticleInstAlpha"
      && legacy.customProgramCacheKey() === THREE.Material.prototype.customProgramCacheKey.call(legacy),
      `${k1} / ${alpha.customProgramCacheKey()}`);
  }
  // H4 the additive-fog live switch keeps the gpu patch (on real gpu buckets)
  {
    let okFade = false, okRetail = false, buckets = 0, detail = "";
    await runPath(async (h) => {
      h.defGfx(0x0100c901, {});
      h.defGfx(0x0100c902, {});
      const a = h.frozenAnchor(0, 0, 0);
      await h.add({ anchor: a, info: GEN.POJO({ hwGfxObjId: 0x0100c901, particleType: 3, id: 0x3200000c }) });
      await h.add({ anchor: a, info: GEN.POJO({ hwGfxObjId: 0x0100c902, particleType: 5 }) });
      await h.tick();
      await h.tick();
      const gb = [...h.mgr._instBuckets.values()].filter((b) => b.gp === true);
      buckets = gb.length;
      M.pm.setAdditiveFogBlack("fade");
      okFade = gb.length > 0 && gb.every((b) => { const s = compile(b.im.material); return s.vertexShader.includes(GP.GP_MARKER) && b.im.material.customProgramCacheKey().includes("|gp"); });
      M.pm.setAdditiveFogBlack("retail");
      okRetail = gb.every((b) => { const s = compile(b.im.material); return s.vertexShader.includes(GP.GP_MARKER) && /\|gp$/.test(b.im.material.customProgramCacheKey()); });
      detail = gb.map((b) => b.im.material.customProgramCacheKey()).join(", ");
    }, { on: true, spies: false });
    check("H4 setAdditiveFogBlack('fade') then ('retail') on gpu buckets keeps the gpu patch and key", buckets > 0 && okFade && okRetail, `${buckets} buckets: ${detail}`);
  }
  // H5 a broken source fails the self-check, warns once, and the flag-on run stays legacy (P7)
  {
    const warns = [];
    const ow = console.warn;
    console.warn = (...a) => { warns.push(a.join(" ")); };
    GP.__resetGpParticlesForTest();
    GP.__setGpSelfCheckSourceForTest("// no main here\n#include <common>\n");
    const sc1 = GP.gpSelfCheck(), sc2 = GP.gpSelfCheck();
    console.warn = ow;
    check("H5 a shader without the anchors fails the self-check and warns once", sc1 === false && sc2 === false && warns.filter((w) => /gpu_particles/.test(w)).length === 1, warns.join(" | "));
    // P7: with the self-check failed the flag-on run builds zero gpu emitters and draws what flag-off draws
    let gpCount = 0;
    const off = offRuns.get("facing").off;
    const errs = [];
    const before = () => { GP.__setGpSelfCheckSourceForTest("// no main here\n"); };
    const ow2 = console.warn; console.warn = () => {};
    {
      GP.__resetGpParticlesForTest();
      before();
      M.core.__setRustFlagForTest("gpuParticles", true);
      await runPathNoReset(GEN.SCENARIOS.facing, (h, t, k) => {
        for (const [, e] of h.mgr.particleTable) if (e instanceof GP.GpParticleEmitter) gpCount++;
        const c = compareTick(off.ticks[k], t, h, motionOn(), { dp: 0, dr: 0, dc: 0 });
        for (const e of c.errs.slice(0, 2)) errs.push(`tick ${k}: ${e}`);
        for (const b of t.buckets) if (b.key.endsWith("|gp")) errs.push(`gpu bucket ${b.key}`);
        // bit-exact: the same legacy path
        const ob = off.ticks[k].buckets;
        if (ob.length !== t.buckets.length || ob.some((b, i) => !sameArr(b.mat, t.buckets[i].mat) || !sameArr(b.col, t.buckets[i].col))) errs.push(`tick ${k}: not bit-identical`);
      });
    }
    console.warn = ow2;
    GP.__setGpSelfCheckSourceForTest(null);
    check("P7 a failed self-check: zero gpu emitters, buckets bit-identical to flag off (facing)", gpCount === 0 && errs.length === 0, errs.slice(0, 3).join(" | "));
  }
}

/** runPath without the reset (the caller arranged the gpu module state). */
async function runPathNoReset(fn, perTick) {
  const recs = [];
  const h = new GEN.Harness(M, { onManager(mgr, index, hh) { const rec = recordRng(0x0c0ffee + 977 * index); recs[index] = rec; hh.rngs.set(mgr, rec.rng); } });
  const PMP = M.pm.ParticleManager.prototype;
  const origAppend = PMP._appendInstances;
  let segs = new Map();
  PMP._appendInstances = function (emitter) {
    const n = (emitter.parts || []).filter((m) => m && m.visible !== false).length;
    const k = bucketKey(emitter);
    if (!segs.has(k)) segs.set(k, []);
    segs.get(k).push([emitter.id, n, h.mgrs.indexOf(this)]);
    return origAppend.call(this, emitter);
  };
  const origTick = h.tick.bind(h);
  let k = 0;
  h.tick = async (dt) => { segs = new Map(); const snap = await origTick(dt); perTick(h, captureTick(h, snap, segs, null, recs), k++); return snap; };
  try { await fn(h); } finally { PMP._appendInstances = origAppend; M.time.setRng(null); M.core.__setRustFlagForTest("gpuParticles", undefined); }
  return { h };
}

// ===================================================================== P7 eligibility
section("P7  eligibility: sky chain, Unknown / non-integer types, legacy escapes, ?rustParticles");
{
  // types scenario: Unknown (0) and 13.5 stay on the legacy path; everything else is gpu
  const { on } = offRuns.get("types");
  const legacyIds = new Set();
  const gpTypes = new Set();
  for (const [, e] of on.h.mgr.particleTable) {
    if (e._gp === true) gpTypes.add(e.info.particleType); else legacyIds.add(e.info.particleType);
  }
  check("P7 types 1..12 take the gpu path; Unknown (0) and non-integer (13.5) stay legacy", [...legacyIds].every((t) => t === 0 || t === 13.5) && legacyIds.size === 2 && gpTypes.size === 12,
    `gpu ${[...gpTypes].sort((a, b) => a - b)} legacy ${[...legacyIds]}`);
  // the sky chain
  let skyGp = null, skyBucketGp = null;
  await runPath(async (h) => {
    h.defGfx(0x0100ca01, {});
    const a = h.frozenAnchor(0, 0, 40);
    const id = await h.add({ anchor: a, skyGlow: true, info: GEN.POJO({ hwGfxObjId: 0x0100ca01, particleType: 5 }) });
    await h.tick();
    const e = h.mgr.particleTable.get(id);
    skyGp = e ? e._gp === true : null;
    skyBucketGp = [...h.mgr._instBuckets.keys()].some((k) => k.endsWith("|gp"));
  }, { on: true, spies: false });
  check("P7 the sky chain (skyGlow) never takes the gpu path", skyGp === false && skyBucketGp === false, `emitter gp ${skyGp}, gpu bucket ${skyBucketGp}`);
  // ?rustParticles=on + the flag: no rust shell, the bridge is never asked
  {
    M.core.__setRustFlagForTest("rustParticles", true);
    let shells = 0, asked = false, gpN = 0;
    await runPath(async (h) => {
      h.defGfx(0x0100cb01, {});
      const a = h.frozenAnchor(0, 0, 0);
      for (const t of [2, 5, 9]) await h.add({ anchor: a, info: GEN.POJO({ hwGfxObjId: 0x0100cb01, particleType: t }) });
      await h.tick();
      for (const [, e] of h.mgr.particleTable) { if (e._rustShell === true) shells++; if (e._gp === true) gpN++; }
      asked = h.mgr._rustTried === true || h.mgr._rust !== null;
    }, { on: true, spies: false });
    M.core.__setRustFlagForTest("rustParticles", undefined);
    check("P7 ?gpuParticles supersedes ?rustParticles: no rust shell, the bridge is never created", shells === 0 && !asked && gpN === 3, `shells ${shells} asked ${asked} gpu ${gpN}`);
  }
  // ... and never ASKED. In node the wasm is absent, so `_rustBridge()` resets
  // `_rustTried` and returns null (rustParticlesPending): the state above cannot
  // tell an ask from none. Count the calls instead, with a flag-off control.
  {
    const PMP = M.pm.ParticleManager.prototype;
    const origBridge = PMP._rustBridge;
    let bridgeCalls = 0;
    PMP._rustBridge = function () { bridgeCalls++; return origBridge.call(this); };
    const bridgeScen = async (h) => {
      h.defGfx(0x0100cb02, {});
      const a = h.frozenAnchor(0, 0, 0);
      for (const t of [2, 5, 9]) await h.add({ anchor: a, info: GEN.POJO({ hwGfxObjId: 0x0100cb02, particleType: t }) });
      await h.tick();
    };
    const asks = {};
    M.core.__setRustFlagForTest("rustParticles", true);
    try {
      for (const on of [true, false]) {
        bridgeCalls = 0;
        await runPath(bridgeScen, { on, spies: false });
        asks[on ? "on" : "off"] = bridgeCalls;
      }
    } finally {
      PMP._rustBridge = origBridge;
      M.core.__setRustFlagForTest("rustParticles", undefined);
    }
    check("P7 with ?gpuParticles on, addEmitter never asks the Rust bridge (ParticleManager._rustBridge: 0 calls); flag off it does (spy control)",
      asks.on === 0 && asks.off >= 3, `flag on ${asks.on} calls, flag off ${asks.off}`);
  }
  // the legacy escapes (child process): zero gpu emitters, digest == flag off
  {
    const r = spawnSync(process.execPath, [SELF, "--legacy-child"], { cwd: APP, encoding: "utf8", maxBuffer: 64 << 20 });
    const child = r.status === 0 ? JSON.parse(r.stdout) : null;
    let golden = null;
    try { golden = JSON.parse(readFileSync(GOLDEN, "utf8")); } catch (_) { golden = null; }
    const want = golden && golden.legacy && golden.legacy.legacy;
    check("P7 legacy escapes on (?swarmAce / particleInitAce / particleRotAce / particleInitFrameAce): zero gpu emitters, no tables, output == flag off",
      !!child && child.gpEmitters === 0 && child.tables === false && !!want && JSON.stringify(child.digests.legacy.ticks) === JSON.stringify(want.ticks),
      child ? `gpu ${child.gpEmitters} tables ${child.tables}` : (r.stderr || "").slice(-300));
  }
}

// ===================================================================== P5 upload discipline (rows, ranges)
section("P5  upload discipline: rows per tick, ranged texture uploads");
{
  let rowBad = -1, rangesBad = -1, rangesSeen = 0, frozenWrites = 0, movingWrites = 0, rangeDetail = "";
  let detail = "", velBad = "", velN = 0;
  // ticks 30..44 the rig holds still, 45..54 it moves on at the same speed
  const HOLD = 30, RESUME = 45, END = 55;
  const stop = { bad: "", still: 0, resumed: 0 };
  await runPath(async (h) => {
    h.defGfx(0x0100cc01, {});
    const fz = h.frozenAnchor(3, 0, 0);
    const rig = h.movingAnchor(-2, 0, 0);
    await h.add({ anchor: fz, info: GEN.POJO({ hwGfxObjId: 0x0100cc01, particleType: 2, isParentLocal: true }) });
    await h.add({ anchor: fz, info: GEN.POJO({ hwGfxObjId: 0x0100cc01, particleType: 3 }) });
    await h.add({ anchor: rig, info: GEN.POJO({ hwGfxObjId: 0x0100cc01, particleType: 12, isParentLocal: true }) });
    const T = () => GP.gpTables();
    for (let i = 0; i < END; i++) {
      const x = i < HOLD ? -2 + 0.1 * i : (i < RESUME ? -2 + 0.1 * (HOLD - 1) : -2 + 0.1 * (HOLD - 1) + 0.1 * (i - RESUME + 1));
      rig.position.set(x, 0, 0);
      rig.updateMatrixWorld(true);
      // simulate three's first upload once (the next flushes are ranged)
      if (i === 2) { T().records.tex.onUpdate(T().records.tex); T().rows.tex.onUpdate(T().rows.tex); }
      const rw0 = T() ? T().rows.stats.writes : 0;
      await h.tick();
      const rows = T().rows.stats.writes - rw0;
      // the moving parent-local emitter's row: anchor velocity = 0.1 m per 1/60 s along x
      const em = [...h.mgr.particleTable.values()][2];
      const vo = em._gpRow * GP.GP_FLOATS + GP.GP_ROW.E_VEL * 4;
      const v = T().rows.data.subarray(vo, vo + 3);
      if (i >= 2 && i < HOLD) {
        velN++;
        if (!velBad && (Math.abs(v[0] - 6) > 1e-4 || Math.abs(v[1]) > 1e-6 || Math.abs(v[2]) > 1e-6)) velBad = `tick ${i}: ${Array.from(v)}`;
      }
      // the anchor stops: E_VEL reads zero from the first still tick (one
      // texel written then, none after), and (6, 0, 0) again once it moves on
      if (i >= HOLD) {
        const still = i < RESUME;
        const wantRows = i === HOLD ? 3 + 1 : (still ? 3 : 3 + 3);
        const wantV = still ? [0, 0, 0] : [6, 0, 0];
        if (still) stop.still++; else stop.resumed++;
        if (!stop.bad && (rows !== wantRows || v.some((c, q) => Math.abs(c - wantV[q]) > 1e-4) || (still && v.some((c) => c !== 0)))) {
          stop.bad = `tick ${i} (${still ? "still" : "moving again"}): E_VEL ${Array.from(v)}, ${rows} row texels (want ${wantRows})`;
        }
      }
      if (i < 3) { T().records.tex.clearUpdateRanges(); T().rows.tex.clearUpdateRanges(); }
      if (i >= 3) {
        // manager row (clock + 2 cams) + the moving parent-local emitter (anchor, quat, vel); the frozen one: nothing
        if (i < HOLD && rows !== 3 + 3 && rowBad < 0) { rowBad = i; detail = `tick ${i}: ${rows} row texels`; }
        for (const tex of [T().records.tex, T().rows.tex]) {
          for (const r of tex.updateRanges) {
            rangesSeen++;
            const startTexel = r.start / 4;
            const x = startTexel % GP.GP_WIDTH;
            if (r.start % 4 !== 0 || r.count % 4 !== 0 || x + r.count / 4 > GP.GP_WIDTH) { if (rangesBad < 0) { rangesBad = i; rangeDetail = `${tex.name} ${JSON.stringify(r)}`; } }
          }
          if (tex.updateRanges.length > Math.max(1, tex.image.height)) if (rangesBad < 0) { rangesBad = i; rangeDetail = `${tex.name} ${tex.updateRanges.length} ranges`; }
          tex.clearUpdateRanges(); // three clears them after the ranged upload
        }
      }
    }
    const e0 = [...h.mgr.particleTable.values()];
    frozenWrites = e0[0]._gpRowF ? 1 : 0;
    movingWrites = e0[2]._gpRowF ? 1 : 0;
  }, { on: true, spies: false });
  check("P5 row texels per tick == 3 (manager row) + 3 per drawn MOVING parent-local emitter; a frozen anchor writes once", rowBad === -1 && frozenWrites === 1 && movingWrites === 1, detail);
  check("P5 texture update ranges stay inside one texture row each, at most one per touched row", rangesBad === -1 && rangesSeen > 0, `${rangesSeen} ranges ${rangeDetail}`);
  check("P5 a moving parent-local emitter's row carries its anchor velocity (6, 0, 0) m/s (the ?fxMotion stretch adds it)", velBad === "" && velN > 20, velBad || `${velN} ticks`);
  check("P5 its anchor stops: E_VEL reads (0, 0, 0) from the first still tick (one texel then, no emitter texel after) and (6, 0, 0) again from the first tick it moves on",
    stop.bad === "" && stop.still === RESUME - HOLD && stop.resumed === END - RESUME, stop.bad || `${stop.still} still ticks, ${stop.resumed} moving again`);
}

// ===================================================================== P5r ranges while nothing uploads
section("P5r  no upload for a long time (every gpu bucket reaped / culled / cell-hidden, film hide, ?nullRender): ranges merge, never pile up");
{
  // unit: a 4-row table, 1-4 random texel writes per flush, 3,600 flushes, one
  // simulated upload (three: merge + texSubImage2D + clearUpdateRanges, then onUpdate) half-way
  const t = new GP.GpTable("p5r-unit", 1);
  while (t.capacity < 3 * GP.GP_PER_ROW) t.alloc();
  t.flush();
  t.tex.onUpdate(t.tex); // the first (whole) upload
  const R = inputRng(91);
  const since = new Set(); // texels written since the last upload
  let maxRanges = 0, coverBad = "", shapeBad = "", afterUpload = "", flushes = 0;
  const covered = (texel) => t.tex.updateRanges.some((r) => r.start <= texel * 4 && texel * 4 + 4 <= r.start + r.count);
  for (let k = 0; k < 3600; k++) {
    const w = 1 + Math.floor(R() * 4);
    const span = new Map(); // this flush: texture row -> [min, max] texel
    for (let q = 0; q < w; q++) {
      const r = 1 + Math.floor(R() * (t.capacity - 1));
      const kk = Math.floor(R() * GP.GP_TEXELS);
      t.set(r, kk, k, q, 0, 1);
      const tx = r * GP.GP_TEXELS + kk;
      since.add(tx);
      const row = Math.floor(tx / GP.GP_WIDTH);
      const sp = span.get(row);
      span.set(row, sp ? [Math.min(sp[0], tx), Math.max(sp[1], tx)] : [tx, tx]);
    }
    t.flush();
    flushes++;
    const rs = t.tex.updateRanges;
    maxRanges = Math.max(maxRanges, rs.length);
    for (const r of rs) {
      const x = (r.start / 4) % GP.GP_WIDTH;
      if (!shapeBad && (r.start % 4 !== 0 || r.count % 4 !== 0 || x + r.count / 4 > GP.GP_WIDTH)) shapeBad = `flush ${k}: ${JSON.stringify(r)}`;
    }
    if (!coverBad && (k % 61 === 0 || k === 3599)) for (const tx of since) if (!covered(tx)) { coverBad = `flush ${k}: texel ${tx} written since the last upload, not in a range`; break; }
    if (k === 1800) {
      t.tex.clearUpdateRanges();
      t.tex.onUpdate(t.tex);
      since.clear();
    }
    if (k === 1801) {
      const want = [...span.values()].map(([a, b]) => `${a * 4}+${(b - a + 1) * 4}`).sort().join(",");
      const got = rs.map((r) => `${r.start}+${r.count}`).sort().join(",");
      afterUpload = want === got ? "" : `got ${got} want ${want}`;
    }
  }
  check("P5r 3,600 flushes with no upload keep at most one pending range per texture row (4), each inside its row, covering every texel written since the last upload",
    maxRanges <= t.rows && maxRanges > 0 && coverBad === "" && shapeBad === "" && flushes === 3600, `max ${maxRanges} ranges on ${t.rows} rows ${coverBad} ${shapeBad}`);
  check("P5r after an upload (onUpdate) the pending ranges restart: exactly the next flush's spans", afterUpload === "", afterUpload);
  // the steady never-drawn state allocates nothing: the pending ranges are widened in place
  t.tex.clearUpdateRanges();
  t.tex.onUpdate(t.tex);
  t.set(3, 1, 1, 1, 1, 1); t.set(300, 2, 1, 1, 1, 1);
  t.flush();
  const objs = t.tex.updateRanges.slice();
  let same = true;
  for (let k = 0; k < 100; k++) {
    t.set(3 + (k % 200), k % 8, k, 0, 0, 0); t.set(300 + (k % 150), 7 - (k % 8), k, 0, 0, 0);
    t.flush();
    const rs = t.tex.updateRanges;
    if (rs.length !== objs.length || rs.some((r, i) => r !== objs[i])) same = false;
  }
  const r0 = objs[0], r1 = objs[1];
  check("P5r while nothing uploads, flushes touching the same rows widen the same range objects (no allocation per flush)",
    // texels 3*8+0 .. 102*8+3 (row 0) and 300*8+2 .. 399*8+4 (row 1)
    same && objs.length === 2 && r0.start === 24 * 4 && r0.start + r0.count === 820 * 4 && r1.start === 2402 * 4 && r1.start + r1.count === 3197 * 4,
    `${same} ${JSON.stringify(objs)}`);
  t.tex.dispose();

  // a flag-on scenario whose tables are never uploaded after the first time:
  // 300 ticks, the manager row + a moving parent-local emitter + emissions every tick
  let worst = 0, rowsH = 0, ticks = 0;
  await runPath(async (h) => {
    h.defGfx(0x0100cc11, {});
    const fz = h.frozenAnchor(3, 0, 0);
    const rig = h.movingAnchor(-2, 0, 0);
    await h.add({ anchor: fz, info: GEN.POJO({ hwGfxObjId: 0x0100cc11, particleType: 3, birthrate: 0.01, lifespan: 0.3 }) });
    await h.add({ anchor: rig, info: GEN.POJO({ hwGfxObjId: 0x0100cc11, particleType: 12, isParentLocal: true }) });
    for (let i = 0; i < 300; i++) {
      rig.position.set(-2 + 0.01 * i, 0, 0);
      rig.updateMatrixWorld(true);
      if (i === 1) { const T = GP.gpTables(); T.records.tex.onUpdate(T.records.tex); T.rows.tex.onUpdate(T.rows.tex); }
      await h.tick();
      const T = GP.gpTables();
      if (i >= 2) {
        ticks++;
        worst = Math.max(worst, T.records.tex.updateRanges.length / T.records.rows, T.rows.tex.updateRanges.length / T.rows.rows);
        rowsH = T.records.rows + T.rows.rows;
      }
    }
  }, { on: true, spies: false });
  check("P5r a flag-on scenario never drawn for 300 ticks: each table keeps at most one pending range per texture row", worst > 0 && worst <= 1 && ticks === 298,
    `worst ${worst} ranges per texture row (${rowsH} rows)`);
}

// ===================================================================== P5c context restore
section("P5c  webglcontextrestored: both tables upload whole again");
{
  // A restored context re-allocates every texture: an upload of the pending
  // ranges only would leave every record / row outside them reading zero. The
  // gpu programs' onBeforeCompile hands the renderer to the module, which
  // listens on its canvas (once per renderer).
  let ctx = null, ctxErr = "";
  try {
    await runPath(async (h) => {
      h.defGfx(0x0100cd01, {});
      const a = h.frozenAnchor(0, 0, 0);
      await h.add({ anchor: a, info: GEN.POJO({ hwGfxObjId: 0x0100cd01, particleType: 2, birthrate: 0.01, maxParticles: 20 }) });
      await h.tick();
      await h.tick();
      const T = GP.gpTables();
      const b = [...h.mgr._instBuckets.values()].find((x) => x.gp === true);
      const canvas = new EventTarget();
      let listeners = 0;
      const addL = canvas.addEventListener.bind(canvas);
      canvas.addEventListener = (type, fn, o) => { if (type === "webglcontextrestored") listeners++; return addL(type, fn, o); };
      const renderer = { domElement: canvas };
      const L = THREE.ShaderLib.basic;
      for (let i = 0; i < 3; i++) b.im.material.onBeforeCompile({ vertexShader: L.vertexShader, fragmentShader: L.fragmentShader, uniforms: {} }, renderer);
      // three's first (whole) upload of both tables, then ranged ticks
      for (const t of [T.records, T.rows]) t.tex.onUpdate(t.tex);
      await h.tick();
      await h.tick();
      const tabs = [T.records, T.rows];
      const before = tabs.map((t) => ({ fresh: t.fresh, ranges: t.tex.updateRanges.length }));
      const ver0 = tabs.map((t) => t.tex.version);
      canvas.dispatchEvent(new Event("webglcontextrestored"));
      const after = tabs.map((t, i) => ({ fresh: t.fresh, ranges: t.tex.updateRanges.length, bumped: t.tex.version > ver0[i] }));
      const full0 = tabs.map((t) => t.stats.fullUploads);
      await h.tick();
      const next = tabs.map((t, i) => ({ fresh: t.fresh, ranges: t.tex.updateRanges.length, full: t.stats.fullUploads - full0[i] }));
      // three uploads it whole, then the ranged path resumes
      for (const t of tabs) t.tex.onUpdate(t.tex);
      await h.tick();
      const resumed = T.rows.tex.updateRanges.length;
      ctx = { listeners, before, after, next, resumed };
    }, { on: true, spies: false });
  } catch (e) {
    ctxErr = String(e && e.stack || e).slice(0, 300);
  }
  const ok = !!ctx && ctx.listeners === 1
    && ctx.before.every((x) => x.fresh === false) && ctx.before[1].ranges > 0
    && ctx.after.every((x) => x.fresh === true && x.ranges === 0 && x.bumped)
    && ctx.next.every((x) => x.fresh === true && x.ranges === 0) && ctx.next[1].full === 1
    && ctx.resumed > 0;
  check("P5c after webglcontextrestored both tables are fresh (pending ranges dropped, needsUpdate): the next upload is whole, then ranged again; one listener per renderer",
    ok, ctxErr || JSON.stringify(ctx));
}

// ===================================================================== P8 toggle, P9 film
section("P8 / P9  runtime instancing toggle, film-mode samples");
{
  const { off, on } = offRuns.get("toggle");
  // the toggle scenario snaps slot meshes: from the OFF toggle (tick 15) on, the slot meshes a reader sees match flag off bit-exact
  let bad = -1;
  for (let k = 15; k < off.ticks.length; k++) {
    const a = JSON.stringify(off.ticks[k].slots), b = JSON.stringify(on.ticks[k].slots);
    if (a !== b) { bad = k; break; }
  }
  const conv = [...on.h.mgr.particleTable.values()].filter((e) => e instanceof GP.GpParticleEmitter);
  check("P8 __setParticleInstancing(false) mid-run: the gpu emitters go per-mesh and their slot meshes equal the flag-off run bit-exact (and stay legacy after ON)",
    bad === -1 && conv.length > 0 && conv.every((e) => e._gp === false && e._gpRow === 0), bad >= 0 ? `tick ${bad}` : `${conv.length} converted`);
  const fo = offRuns.get("film");
  const ok = JSON.stringify(fo.off.h.filmRows) === JSON.stringify(fo.on.h.filmRows);
  let firstDiff = -1;
  if (!ok) for (let i = 0; i < fo.off.h.filmRows.length; i++) if (fo.off.h.filmRows[i] !== fo.on.h.filmRows[i]) { firstDiff = i; break; }
  check("P9 film mode's particle query reads the same spheres + samples from the gpu twin as from the flag-off carriers (bit-exact)", ok, `first differing tick ${firstDiff}`);
}

// ===================================================================== P9b / P11 / P12 / H6
section("P9b / P11 / P12 / H6  film sizes, bucket-attach failure, glow twins, per-template self-check");
{
  // P9b: film sample sizes come from the slot geometry, as the flag-off carriers' do
  // (here its bounds differ from the instanced clone's, which was taken at attach)
  const filmScen = (rows) => async (h) => {
    const { createParticlesQuery } = await import("../scene3d/film/scene/particles_query.js");
    h.defGfx(0x0100d101, {});
    h.defGfx(0x0100d102, { alpha: true });
    const a = h.frozenAnchor(0, 0, 0.5);
    const rig = h.movingAnchor(2, 1, 0);
    await h.add({ anchor: a, info: GEN.POJO({ hwGfxObjId: 0x0100d101, particleType: 2, maxParticles: 8, initialParticles: 4, lifespan: 2 }) });
    await h.add({ anchor: rig, info: GEN.POJO({ hwGfxObjId: 0x0100d102, particleType: 3, isParentLocal: true, maxParticles: 8, initialParticles: 3 }) });
    for (const hw of [0x0100d101, 0x0100d102]) h.gfx.get(hw).geom.boundingSphere.radius *= 3;
    const q = createParticlesQuery({ liveScene3d: null, THREE, managers: () => h.mgrs, frameKey: () => h.frame });
    for (let i = 0; i < 12; i++) {
      rig.position.set(2 + 0.1 * i, 1, 0);
      rig.updateMatrixWorld(true);
      await h.tick();
      rows.push(JSON.stringify(q.snapshot().map((x) => [x.key, x.radius, x.parts])));
    }
  };
  const fOff = [], fOn = [];
  await runPath(filmScen(fOff), { on: false, spies: false });
  let gpFilm = 0;
  await runPath(filmScen(fOn), { on: true, spies: false, perTick(h) { for (const [, e] of h.mgr.particleTable) if (e._gp === true) gpFilm++; } });
  let fd = -1;
  for (let i = 0; i < fOff.length; i++) if (fOff[i] !== fOn[i]) { fd = i; break; }
  check("P9b film samples size particles from the slot geometry's bounds (as the flag-off carriers do), not the instanced clone's", fd === -1 && fOff.length === 12 && gpFilm > 0,
    fd >= 0 ? `tick ${fd}: ${fOff[fd].slice(0, 160)} vs ${fOn[fd].slice(0, 160)}` : `${gpFilm} gpu emitter-ticks`);

  // P11: an eligible emitter whose bucket attach fails (a gfxobj without vertices)
  // goes back to today's per-mesh path: no records, no row, its slots == flag off
  const attachScen = async (h) => {
    h.snapSlots = true;
    h.defGfx(0x0100d201, {});
    h.gfx.get(0x0100d201).geom = new THREE.BufferGeometry(); // `_instGeometryFor` → null
    h.defGfx(0x0100d202, {});
    const a = h.frozenAnchor(0, 0, 0);
    await h.add({ anchor: a, info: GEN.POJO({ hwGfxObjId: 0x0100d201, particleType: 3, initialParticles: 3 }) });
    await h.add({ anchor: a, info: GEN.POJO({ hwGfxObjId: 0x0100d202, particleType: 2 }) });
    for (let i = 0; i < 16; i++) await h.tick();
  };
  const ow = console.warn;
  console.warn = () => {};
  let p11 = null, p11Err = "";
  try {
    const aOff = await runPath(attachScen, { on: false, spies: false });
    const accE = [];
    const aOn = await runPath(attachScen, { on: true, spies: false, perTick(h) { for (const e of gpAccounting(h).errs) if (accE.length < 2) accE.push(e); } });
    const ems = [...aOn.h.mgr.particleTable.values()];
    let slotBad = -1;
    for (let k = 0; k < aOff.ticks.length; k++) {
      const so = aOff.ticks[k].slots.find(([id]) => id === ems[0].id), sn = aOn.ticks[k].slots.find(([id]) => id === ems[0].id);
      if (JSON.stringify(so) !== JSON.stringify(sn)) { slotBad = k; break; }
    }
    p11 = { conv: ems[0] instanceof GP.GpParticleEmitter && ems[0]._gp === false && ems[0]._gpRow === 0 && ems[0]._instKey === null,
      other: ems[1]._gp === true, slotBad, accE, ticks: aOn.ticks.length };
  } catch (e) {
    p11Err = String(e && e.stack || e).slice(0, 300);
  } finally {
    console.warn = ow;
  }
  check("P11 a failed bucket attach hands the gpu emitter back to the per-mesh path (no records / row, slots == flag off every tick); the tick never throws",
    !!p11 && p11.conv && p11.other && p11.slotBad === -1 && p11.accE.length === 0 && p11.ticks === 16, p11Err || JSON.stringify(p11));

  // P12: the glow provider's twin of a gpu FX bucket carries the gpu patch + key; a legacy bucket's does not
  const POC = await import("../scene3d/particles_over_clouds.js");
  const prov = POC.fxGlowProvider();
  const lib = THREE.ShaderLib.basic;
  const compileWith = (mat) => { const sh = { vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, uniforms: {} }; mat.onBeforeCompile(sh, null); return sh; };
  const glowRes = { gp: 0, gpOk: 0, legacy: 0, legacyOk: 0, detail: "" };
  const { off: tOff, on: tOn } = offRuns.get("types");
  for (const [run, isOn] of [[tOn, true], [tOff, false]]) {
    for (const mgr of run.h.mgrs) {
      for (const b of mgr._instBuckets.values()) {
        if (b.alpha || b.im.userData.particleFx !== true) continue;
        const g = prov.materialFor(b.im);
        if (!g) continue;
        const sh = compileWith(g);
        const has = sh.vertexShader.includes(GP.GP_MARKER) && GP.gpVerifyPatchedVertex(sh.vertexShader);
        const key = g.customProgramCacheKey();
        if (isOn && b.gp === true) {
          glowRes.gp++;
          if (has && key.endsWith("|gp") && sh.uniforms.uGpRec === GP.GP_UNIFORMS.uGpRec) glowRes.gpOk++; else if (!glowRes.detail) glowRes.detail = `gpu twin ${key} marker ${has}`;
        } else {
          glowRes.legacy++;
          if (!sh.vertexShader.includes(GP.GP_MARKER) && !key.endsWith("|gp")) glowRes.legacyOk++; else if (!glowRes.detail) glowRes.detail = `legacy twin ${key}`;
        }
      }
    }
  }
  check("P12 fxGlow provider materialFor: a gpu FX bucket's glow twin is patched (header, call, uniforms) and keyed |gp; flag-off twins are untouched",
    !!prov && glowRes.gp > 0 && glowRes.gpOk === glowRes.gp && glowRes.legacy > 0 && glowRes.legacyOk === glowRes.legacy, JSON.stringify(glowRes));
  // ... and compiles with HB_GP_FXCOLOR: without it hbGpIc = (op, op, op), and
  // particle_fx's VERT_BODY would read the opacity as the age (.g) and as
  // row + seed (.b): the wrong FX row's tint / gain / flicker phase on the glow.
  const FXDEF = "#define HB_GP_FXCOLOR\n";
  const glowDef = { gp: 0, gpOk: 0, legacy: 0, legacyOk: 0, detail: "" };
  for (const [run, isOn] of [[tOn, true], [tOff, false]]) {
    for (const mgr of run.h.mgrs) {
      for (const b of mgr._instBuckets.values()) {
        if (b.alpha || b.im.userData.particleFx !== true) continue;
        const g = prov.materialFor(b.im);
        if (!g) continue;
        const vs = compileWith(g).vertexShader;
        if (isOn && b.gp === true) {
          glowDef.gp++;
          if (vs.startsWith(FXDEF + GP.GP_MARKER)) glowDef.gpOk++; else if (!glowDef.detail) glowDef.detail = `gpu twin starts ${JSON.stringify(vs.slice(0, 40))}`;
        } else {
          glowDef.legacy++;
          if (!vs.includes("#define HB_GP_FXCOLOR")) glowDef.legacyOk++; else if (!glowDef.detail) glowDef.detail = "legacy twin defines HB_GP_FXCOLOR";
        }
      }
    }
  }
  check("P12 a gpu FX bucket's glow twin compiles with #define HB_GP_FXCOLOR first, right before the header (FX colour channels op / age / row + seed); flag-off twins never carry it",
    glowDef.gp > 0 && glowDef.gpOk === glowDef.gp && glowDef.legacy > 0 && glowDef.legacyOk === glowDef.legacy, glowDef.detail || JSON.stringify(glowDef));
  // P12b: the same for every gpu BUCKET program of every scenario: an FX bucket
  // (particleFx) carries HB_GP_FXCOLOR right before the header; a stock one does not
  const bucketDef = { fx: 0, fxOk: 0, stock: 0, stockOk: 0, detail: "" };
  for (const [name, r] of offRuns) {
    if (!r || !r.on) continue;
    const seen = new Set();
    for (const t of r.on.ticks) {
      for (const b of t.buckets) {
        if (!b.gp || seen.has(b.im.material)) continue;
        seen.add(b.im.material);
        const mat = b.im.material;
        const L = mat.isMeshStandardMaterial ? THREE.ShaderLib.physical : THREE.ShaderLib.basic;
        const sh = { vertexShader: L.vertexShader, fragmentShader: L.fragmentShader, uniforms: {} };
        mat.onBeforeCompile(sh, null);
        const vs = sh.vertexShader;
        const at = vs.indexOf(GP.GP_MARKER);
        if (b.fx) {
          bucketDef.fx++;
          if (at >= FXDEF.length && vs.slice(at - FXDEF.length, at) === FXDEF && vs.indexOf(FXDEF) === at - FXDEF.length) bucketDef.fxOk++;
          else if (!bucketDef.detail) bucketDef.detail = `${name} ${b.key}: FX bucket without HB_GP_FXCOLOR before the header`;
        } else {
          bucketDef.stock++;
          if (at >= 0 && !vs.includes("#define HB_GP_FXCOLOR")) bucketDef.stockOk++;
          else if (!bucketDef.detail) bucketDef.detail = `${name} ${b.key}: stock bucket ${at < 0 ? "unpatched" : "defines HB_GP_FXCOLOR"}`;
        }
      }
    }
  }
  check("P12b every gpu FX bucket program carries #define HB_GP_FXCOLOR right before the header; every gpu stock bucket program is patched without it",
    bucketDef.fx > 0 && bucketDef.fxOk === bucketDef.fx && bucketDef.stock > 0 && bucketDef.stockOk === bucketDef.stock, bucketDef.detail || JSON.stringify(bucketDef));

  // H6: the self-check runs on the template the bucket compiles from; a broken
  // ShaderLib.physical keeps MeshStandard-based emitters (?particleUnlit=off) on today's path
  const physVs = THREE.ShaderLib.physical.vertexShader;
  const tplScen = (out) => async (h) => {
    h.defGfx(0x0100d301, {});
    h.defGfx(0x0100d302, {});
    const g = h.gfx.get(0x0100d302);
    g.mat = new THREE.MeshStandardMaterial({ map: h.tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    g.mat.userData = { __cacheOwned: true, surfaceTypeFlags: 0x10000 };
    const a = h.frozenAnchor(0, 0, 0);
    const i1 = await h.add({ anchor: a, info: GEN.POJO({ hwGfxObjId: 0x0100d301, particleType: 2 }) });
    const i2 = await h.add({ anchor: a, info: GEN.POJO({ hwGfxObjId: 0x0100d302, particleType: 3 }) });
    for (let i = 0; i < 3; i++) await h.tick();
    out.basic = h.mgr.particleTable.get(i1)._gp === true;
    out.std = h.mgr.particleTable.get(i2)._gp === true;
    out.stdBucket = [...h.mgr._instBuckets.values()].find((b) => b.im.material.isMeshStandardMaterial === true) || null;
  };
  const warns = [];
  console.warn = (...a) => warns.push(a.join(" "));
  const good = {}, broken = {};
  try {
    await runPath(tplScen(good), { on: true, spies: false });
    THREE.ShaderLib.physical.vertexShader = physVs.replace("void main() {", "void main(){");
    await runPath(tplScen(broken), { on: true, spies: false });
  } finally {
    THREE.ShaderLib.physical.vertexShader = physVs;
    console.warn = ow;
  }
  let stdPatched = false;
  if (good.stdBucket) {
    const P = THREE.ShaderLib.physical;
    const sh = { vertexShader: P.vertexShader, fragmentShader: P.fragmentShader, uniforms: {} };
    good.stdBucket.im.material.onBeforeCompile(sh, null);
    stdPatched = GP.gpVerifyPatchedVertex(sh.vertexShader);
  }
  check("H6 a MeshStandard-based emitter is gpu with an intact ShaderLib.physical (its bucket program patched); a physical template without the anchor keeps it legacy (one warn), MeshBasic unaffected",
    good.basic === true && good.std === true && stdPatched && broken.basic === true && broken.std === false && warns.filter((w) => /gpu_particles.*physical/.test(w)).length === 1,
    JSON.stringify({ good: { basic: good.basic, std: good.std, stdPatched }, broken: { basic: broken.basic, std: broken.std }, warns: warns.slice(0, 2) }));

  // H6b: a hook chain that removes main's anchor at compile time is reported (once), not silent
  {
    GP.__resetGpParticlesForTest();
    const m = new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending });
    m.onBeforeCompile = (sh) => { sh.vertexShader = sh.vertexShader.replace("void main() {", "void main(){"); };
    GP.applyGpParticleMaterial(m);
    const w2 = [];
    console.warn = (...a) => w2.push(a.join(" "));
    let sh1, sh2;
    try { sh1 = compileWith(m); sh2 = compileWith(m); } finally { console.warn = ow; }
    const n = typeof GP.gpPatchFailures === "function" ? GP.gpPatchFailures() : -1;
    check("H6 a compile-time patch failure warns once and is counted (gpPatchFailures)", n === 2 && w2.filter((w) => /gpu_particles/.test(w)).length === 1
      && !sh1.vertexShader.includes(GP.GP_MARKER) && !sh2.vertexShader.includes(GP.GP_MARKER), `${n} failures, ${w2.length} warns`);
    GP.__resetGpParticlesForTest();
  }
}

// ===================================================================== R (record layout)
section("R  spawn record + row layout");
{
  let checked = 0, bad = 0, zeroRec = true, rowOk = true;
  const ex = [];
  await runPath(async (h) => {
    h.defGfx(0x0100cd01, {});
    const a = h.frozenAnchor(5, -1, 2, { yaw: 1.1 });
    const rig = h.movingAnchor(0, 0, 0, { parts: 1 });
    for (const [t, pl] of [[2, false], [4, false], [9, true], [7, false], [11, true]]) {
      await h.add({ anchor: pl ? rig : a, partIndex: pl ? 0 : -1, info: GEN.POJO({ hwGfxObjId: 0x0100cd01, particleType: t, isParentLocal: pl, id: 0x3200000c }) });
    }
    for (let i = 0; i < 6; i++) await h.tick();
    const T = GP.gpTables();
    const d = T.records.data;
    for (let q = 0; q < 32; q++) if (d[q] !== 0) zeroRec = false;
    const f = Math.fround;
    const st = h.mgr._gpState;
    for (const [, e] of h.mgr.particleTable) {
      for (let i = 0; i < e.parts.length; i++) {
        if (!e.parts[i]) continue;
        const p = e.particles[i];
        const r = e._gpRec[i];
        const o = r * 32;
        const pl = e.info.isParentLocal;
        const gr = [4, 9, 11].includes(e.info.particleType);
        const persistent = e.info.totalParticles === 0 && e.info.totalSeconds === 0;
        const bEff = persistent ? p.lastUpdateTime - p.lifetime : p.lastUpdateTime;
        const T0 = bEff - st.M0;
        const hi = Math.floor(T0 * 1024) / 1024;
        const sp = p.startFrame.position, q = p.startFrame.quaternion;
        const cw = Math.hypot(p.c.x, p.c.y, p.c.z);
        const want = [
          pl ? p.offset.x : sp.x + p.offset.x, pl ? p.offset.y : sp.y + p.offset.y, pl ? p.offset.z : sp.z + p.offset.z, hi,
          p.a.x, p.a.y, p.a.z, p.lifespan,
          p.b.x, p.b.y, p.b.z, T0 - hi,
          p.c.x, p.c.y, p.c.z, e._gpSeed[i],
          ...(gr && !pl ? [q.x, q.y, q.z, q.w] : [0, 0, 0, 1]),
          p.startScale, p.finalScale, p.startTrans, p.finalTrans,
          e._gpRow, 0, 0, 0,
          ...(gr ? [p.c.x / cw, p.c.y / cw, p.c.z / cw, cw] : [0, 0, 0, 0]),
        ];
        checked++;
        for (let k = 0; k < 32; k++) {
          if (k === 3 || k === 11) continue; // the time pair: checked as a sum (persistent ages re-derive bEff in f64)
          if (d[o + k] !== f(want[k])) { bad++; if (ex.length < 3) ex.push(`rec ${r} float ${k}: ${d[o + k]} vs ${f(want[k])}`); break; }
        }
        if (Math.abs(d[o + 3] + d[o + 11] - T0) > 1e-8) { bad++; ex.push(`rec ${r} time ${d[o + 3]} + ${d[o + 11]} vs ${T0}`); }
        // address: texel (8 (r mod 256) + k, r div 256) of a 2048-wide table == floats (r*8+k)*4
        const tx = 8 * (r % 256), ty = Math.floor(r / 256);
        if ((ty * 2048 + tx) * 4 !== o) { bad++; ex.push(`address ${r}`); }
        // Thi exact in f32, a multiple of 1/1024
        if (f(d[o + 3]) !== d[o + 3] || !Number.isInteger(d[o + 3] * 1024)) { bad++; ex.push(`Thi ${d[o + 3]}`); }
      }
      // emitter row
      const rd = T.rows.data, ro = e._gpRow * 32;
      if (rd[ro + 3] !== st.row || rd[ro + 11] !== (e._fxRow | 0) || rd[ro + 12] !== e.info.particleType || rd[ro + 13] !== (e.info.isParentLocal ? 1 : 0)
        || rd[ro + 15] !== f(M.fx.particleFxTeleportSpeedSq(e))) rowOk = false;
      if (e.info.isParentLocal) { const fr = e._resolveAnchorFrame(); if (rd[ro] !== f(fr.position.x) || rd[ro + 7] !== f(fr.quaternion.w)) rowOk = false; }
    }
    const mo = st.row * 32;
    const C = h.t - st.M0, chi = Math.floor(C * 1024) / 1024;
    if (T.rows.data[mo] !== f(chi) || T.rows.data[mo + 1] !== f(C - chi) || T.rows.data[mo + 3] !== 1 || st.row < 1 || st.row > 8) rowOk = false;
    if (T.rows.data[0] !== (M.fx.particleFxLive() ? 1 : 0)) rowOk = false;
  }, { on: true, spies: false });
  check("R1 every live record: k0 base + Thi, k1 A + lifespan, k2 B + Tlo, k3 C + seed, k4 start quat (non-PL GR), k5 lerps, k6 row, k7 spin axis + |C|; texel address; Thi exact",
    bad === 0 && checked > 10, `${checked} records` + (ex.length ? "; " + ex.join(" | ") : ""));
  check("R2 record 0 reserved and zero", zeroRec);
  check("R3 emitter rows (anchor + manager row, quat, fxRow, type, parentLocal, velLimitSq) and the manager row (Chi, Clo, bbOn) + global fxLive", rowOk);
}

// ===================================================================== diag
section("D  diag + teardown");
{
  let diag = null, afterDestroy = null, released = false;
  await runPath(async (h) => {
    h.defGfx(0x0100ce01, {});
    const a = h.frozenAnchor(0, 0, 0);
    const id = await h.add({ anchor: a, info: GEN.POJO({ hwGfxObjId: 0x0100ce01, particleType: 3, maxParticles: 8, initialParticles: 4 }) });
    await h.tick();
    diag = globalThis.window.__gpuParticlesDiag ? globalThis.window.__gpuParticlesDiag() : null;
    const T = GP.gpTables();
    const live0 = T.records.live;
    const e = h.mgr.particleTable.get(id);
    const recs = Array.from(e._gpRec).filter((r) => r > 0);
    h.destroy(id);
    released = recs.every((r) => T.records.data.subarray(r * 32, r * 32 + 32).every((x) => x === 0)) && T.records.live === live0 - recs.length && e._gpRow === 0;
    afterDestroy = globalThis.window.__gpuParticlesDiag();
  }, { on: true, spies: false });
  check("D1 window.__gpuParticlesDiag exists with the flag on (first gpu emitter) and reports the tables", !!diag && diag.on === true && diag.emitters === 1 && diag.records.live >= 4 && diag.selfCheck === true,
    JSON.stringify(diag && { emitters: diag.emitters, live: diag.records && diag.records.live }));
  check("D2 destroyParticleEmitter zeroes + frees its records and its row", released && afterDestroy.emitters === 0);
  GP.__resetGpParticlesForTest();
  check("D3 the test reset removes the diag global and the tables", globalThis.window.__gpuParticlesDiag === undefined && GP.gpTables() === null);
}

// ===================================================================== S (the smoke's node half)
section("S  the SwiftShader smoke's node half (harness/glsl_smoke/gpu_particles_*): S2 / S4 / S6 under SwiftShader's sin / cos, S7 through the program three r184 builds");
{
  // 2026-10-31: the orchestrator's smoke (ANGLE / SwiftShader Vulkan) failed S2 /
  // S4 / S6 (48 / 43 / 66 off, worst 2.2e-4 relative) and S7 (213 of 213
  // centroids off). S2 / S4 / S6: the shader called the driver's sin / cos, and
  // SwiftShader's are an order-5 polynomial (1.3e-4 relative near 0) times
  // Swarm amplitudes of up to 12.6 m; replaying the header under that exact
  // polynomial reproduces the failing readback bit for bit. S7: the page built
  // its orthographic frustum from WORLD bounds, three's is VIEW space.
  const SD = await import("./helpers/gpu_particles_smoke_data.mjs");
  const SC = await import("./helpers/gpu_particles_smoke_scene.mjs");
  const { createFakeWebGL2, fakeCanvas } = await import("./helpers/fake_webgl2.mjs");
  const AF = await import("../scene3d/particles/additive_fog.js");
  GP.__resetGpParticlesForTest();
  let data = null, dataErr = "";
  try { data = await SD.buildSmokeData(); } catch (e) { dataErr = String(e && e.stack || e).slice(0, 300); }
  GP.__resetGpParticlesForTest();
  const nInst = data ? data.cases.reduce((a, c) => a + c.entries.length, 0) : 0;
  check("S0 buildSmokeData (the page's input) builds in node: the S7 cases, the large-clock replays, the S5 specials",
    !!data && SC.SMOKE_S7_CASES.every((n) => data.cases.some((c) => c.name === n && !c.special)) && data.cases.some((c) => c.largeClock) && data.cases.some((c) => c.special) && nInst > 2000,
    dataErr || `${data.cases.length} cases, ${nInst} instances` + (data.notes.length ? `; notes ${data.notes.slice(0, 2).join(" | ")}` : ""));
  if (data) {
    const H = GP.GP_GLSL_HEADER;
    const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
    // the kernel arm in node: the header evaluated per instance, read back as the page lays it out
    const kernelOf = (header, builtins) => {
      const runs = new Map();
      const kernel = data.cases.map((cs, ci) => {
        const rec = SD.fromB64(cs.rec), row = SD.fromB64(cs.row);
        const outs = [0, 1, 2, 3, 4].map(() => new Float32Array(cs.entries.length * 4).fill(-12345));
        cs.entries.forEach((en, e) => {
          const key = `${+en.fx}${+en.motion}`;
          let run = runs.get(key);
          if (!run) runs.set(key, run = compileGpHeader(header, { fxColor: en.fx, fxMotion: en.motion, builtins }));
          const r = run({ instanceColor: [en.rec, 0, 0], textures: { uGpRec: { data: rec, width: GP.GP_WIDTH }, uGpRow: { data: row, width: GP.GP_WIDTH } } });
          for (let col = 0; col < 4; col++) for (let q = 0; q < 4; q++) outs[col][e * 4 + q] = r.m[col * 4 + q];
          outs[4][e * 4] = r.c[0]; outs[4][e * 4 + 1] = r.c[1]; outs[4][e * 4 + 2] = r.c[2]; outs[4][e * 4 + 3] = 1;
        });
        return { caseIndex: ci, out: outs.map(b64) };
      });
      const calls = new Map();
      for (const run of runs.values()) for (const [k, n] of run.calls) calls.set(k, (calls.get(k) || 0) + n);
      const checks = SD.evaluateSmoke(data, { errors: [], programs: 4, kernel, prod: null });
      const by = (tag) => checks.find((c) => c.name.startsWith(tag)) || { ok: false, detail: "missing" };
      return { by, calls };
    };
    const TRANSCENDENTAL = ["sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh", "pow", "exp", "exp2", "log", "log2"];
    let fixed = null, fixedErr = "";
    try { fixed = kernelOf(H, SWIFTSHADER_TRIG); } catch (e) { fixedErr = String(e && e.message || e).slice(0, 200); }
    for (const tag of ["S2", "S3", "S4", "S5", "S6"]) {
      const c = fixed ? fixed.by(tag) : { ok: false, detail: fixedErr };
      check(`${tag}n the smoke verdict ${tag} on the header evaluated under SwiftShader's sin / cos (tests/helpers/gpu_particles_glsl_eval.mjs SWIFTSHADER_TRIG, the 2026-10-31 smoke's driver)`, c.ok, String(c.detail).slice(0, 240));
    }
    const code = H.replace(/\/\/.*$/gm, ""); // comments name the forms (cos(A.x t) C ...)
    const textual = TRANSCENDENTAL.filter((n) => new RegExp(`(?<![\\w.])${n}\\s*\\(`).test(code));
    const called = fixed ? [...fixed.calls.keys()].filter((k) => TRANSCENDENTAL.includes(k)) : ["?"];
    check("S2n the header calls no driver transcendental (GLSL ES 3.00 leaves their precision open): none in its text, none among the builtins its evaluation called",
      textual.length === 0 && called.length === 0 && !!fixed && fixed.calls.has("floor"), `text ${textual.join(",") || "none"}; called ${fixed ? [...fixed.calls.keys()].sort().join(",") : fixedErr}`);
    // controls: hbGpSinCos back on the driver's builtins (the pre-fix shader's trig)
    const at = H.indexOf("vec2 hbGpSinCos( float x ) {");
    const end = at === -1 ? -1 : H.indexOf("\n}\n", at);
    const ctlH = at === -1 || end === -1 ? null : H.slice(0, at) + "vec2 hbGpSinCos( float x ) { return vec2( sin( x ), cos( x ) ); }" + H.slice(end + 2);
    let ctlSS = null, ctlExact = null, ctlErr = ctlH ? "" : "hbGpSinCos not found";
    try { if (ctlH) { ctlSS = kernelOf(ctlH, SWIFTSHADER_TRIG); ctlExact = kernelOf(ctlH, null); } } catch (e) { ctlErr = String(e && e.message || e).slice(0, 200); }
    const ssFails = !!ctlSS && ["S2", "S4", "S6"].every((t) => !ctlSS.by(t).ok);
    check("S2n (control) the driver's sin / cos in place of hbGpSinCos fails S2 / S4 / S6 under SwiftShader's polynomial (what the 2026-10-31 smoke read back)",
      ssFails, ctlErr || (ctlSS ? ["S2", "S4", "S6"].map((t) => `${t} ${ctlSS.by(t).ok ? "ok" : "FAIL"}: ${String(ctlSS.by(t).detail).slice(0, 90)}`).join(" | ") : ""));
    const exactPasses = !!ctlExact && ["S2", "S4", "S6"].every((t) => ctlExact.by(t).ok);
    check("S2n (control) the same driver-trig header passes S2 / S4 / S6 with correctly rounded sin / cos: the formulation is sound, the error was the driver's",
      exactPasses, ctlErr || (ctlExact ? ["S2", "S4", "S6"].map((t) => `${t}: ${String(ctlExact.by(t).detail).slice(0, 70)}`).join(" | ") : ""));
    const s29 = swiftShaderSin(Math.fround(-0.17283700406551361));
    check("S2n (model) SwiftShader's sin is 1.2e-4 relative low near 0 (its linear term (47 - 9 sqrt 3) / 5 = 6.28240 vs 2 pi)",
      Math.abs(s29 / Math.sin(Math.fround(-0.17283700406551361)) - 1 + 1.2e-4) < 2e-5, `sin(-0.1728) = ${s29} vs ${Math.sin(Math.fround(-0.17283700406551361))}`);

    // S7n: the stock bucket programs AS THREE r184 BUILDS THEM (real WebGLRenderer
    // over the fake context; the source the GL receives, the uniforms three
    // uploads at the draw), evaluated per vertex of the box, rasterized (pixel
    // centres) into the 256 x 256 target, coverage centroid vs smokeExpectedPixel
    const W = SC.SMOKE_W;
    const shaders = new Map(), progVs = new Map();
    let gl = null;
    gl = createFakeWebGL2({
      onCall(name, args) {
        if (name === "shaderSource") shaders.set(args[0].__id, { type: args[0].__type, src: args[1] });
        else if (name === "attachShader") {
          const sh = shaders.get(args[1].__id);
          if (sh && sh.type === gl.VERTEX_SHADER) progVs.set(args[0].__id, sh.src);
        }
      },
    });
    const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl, W, W), context: gl });
    renderer.setPixelRatio(1);
    renderer.setSize(W, W, false);
    const rt = new THREE.WebGLRenderTarget(W, W, { depthBuffer: true });
    const white = SC.smokeWhite(THREE), geom = SC.smokeBox(THREE);
    const MATS = SC.smokeMaterials({ THREE, GPM: GP, PM: M.pm, PF: M.fx, AF }, white);
    const dataTex = (f32, rows) => {
      const t = new THREE.DataTexture(f32, GP.GP_WIDTH, rows, THREE.RGBAFormat, THREE.FloatType);
      t.minFilter = THREE.NearestFilter; t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
      return t;
    };
    const pos = geom.attributes.position.array, nrm = geom.attributes.normal.array, uvs = geom.attributes.uv.array, col = geom.attributes.color.array;
    const tri = geom.index.array;
    const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const compiled = new Map();
    const runS7 = (makeMat, camFor) => {
      const R = { n: 0, bad: 0, miss: 0, clip: 0, opBad: 0, worst: 0, err: "", ex: [], vsOk: true, progs: new Set(), calls: new Set(), draws: 0 };
      const mat = makeMat();
      for (const name of SC.SMOKE_S7_CASES) {
        const cs = data.cases.find((c) => c.name === name && !c.special);
        const rec = SD.fromB64(cs.rec), row = SD.fromB64(cs.row);
        GP.GP_UNIFORMS.uGpRec.value = dataTex(rec, cs.recRows);
        GP.GP_UNIFORMS.uGpRow.value = dataTex(row, cs.rowRows);
        const o = SC.smokeOrthoBounds(cs.entries, W);
        const cam = camFor(o);
        const scene = new THREE.Scene();
        const im = SC.smokeMeshOf(THREE, geom, mat, [0]);
        scene.add(im);
        for (const en of SC.smokeS7Picks(cs)) {
          im.instanceColor.array[0] = en.rec;
          im.instanceColor.needsUpdate = true;
          im.count = 1;
          renderer.setRenderTarget(rt);
          gl.__fake.startSnapshots();
          renderer.render(scene, cam);
          const snaps = gl.__fake.takeSnapshots().filter((s) => s.kind.startsWith("draw"));
          renderer.setRenderTarget(null);
          R.draws += snaps.length;
          if (snaps.length !== 1) { R.err = R.err || `${snaps.length} draws`; continue; }
          const snap = snaps[0];
          const vs = progVs.get(snap.program);
          if (!vs) { R.err = R.err || "no vertex source for the drawn program"; continue; }
          R.progs.add(snap.program);
          if (!GP.gpVerifyPatchedVertex(vs)) R.vsOk = false;
          let prog = compiled.get(vs);
          if (!prog) {
            try { prog = compileGlslProgram(vs); } catch (e) { R.err = R.err || `compile: ${String(e && e.message || e).slice(0, 160)}`; break; }
            compiled.set(vs, prog);
          }
          const uniforms = {};
          for (const [k, v] of Object.entries(snap.uniforms)) if (v !== undefined && !(typeof v === "string" && v.startsWith("tex#"))) uniforms[k] = v;
          const textures = { uGpRec: { data: rec, width: GP.GP_WIDTH }, uGpRow: { data: row, width: GP.GP_WIDTH } };
          const win = [];
          let opOk = true;
          try {
            for (let v = 0; v < pos.length / 3; v++) {
              const out = prog({ uniforms, textures, attributes: {
                position: [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]], normal: [nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]], uv: [uvs[v * 2], uvs[v * 2 + 1]],
                color: [col[v * 3], col[v * 3 + 1], col[v * 3 + 2]], instanceColor: [en.rec, 0, 0], instanceMatrix: ident } });
              const p = out.get("gl_Position");
              if (!(p[3] > 0) || Math.abs(p[2]) > p[3]) R.clip++;
              win.push([(p[0] / p[3] + 1) * 0.5 * W, (p[1] / p[3] + 1) * 0.5 * W]);
              const vc = out.get("vColor");
              if (Math.abs(vc[0] - en.C[0]) > 1e-5 || vc[1] !== vc[0] || vc[2] !== vc[0]) opOk = false;
            }
          } catch (e) { R.err = R.err || `eval: ${String(e && e.message || e).slice(0, 160)}`; break; }
          for (const k of prog.calls.keys()) R.calls.add(k);
          if (!opOk) R.opBad++;
          // pixel-centre coverage: the union of the 12 triangles
          const cov = new Set();
          for (let t = 0; t < tri.length; t += 3) {
            const a = win[tri[t]], b = win[tri[t + 1]], c = win[tri[t + 2]];
            const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
            if (area === 0) continue;
            const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
            const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(W - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
            for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
              const px = x + 0.5, py = y + 0.5;
              const w0 = ((b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0])) * Math.sign(area);
              const w1 = ((c[0] - b[0]) * (py - b[1]) - (c[1] - b[1]) * (px - b[0])) * Math.sign(area);
              const w2 = ((a[0] - c[0]) * (py - c[1]) - (a[1] - c[1]) * (px - c[0])) * Math.sign(area);
              if (w0 >= 0 && w1 >= 0 && w2 >= 0) cov.add(y * W + x);
            }
          }
          if (cov.size === 0) { R.miss++; continue; }
          let sx = 0, sy = 0;
          for (const k of cov) { sx += (k % W) + 0.5; sy += Math.floor(k / W) + 0.5; }
          const cx = sx / cov.size, cy = sy / cov.size;
          const [ex, ey] = SC.smokeExpectedPixel(o, en.M[12], en.M[13]);
          const d = Math.hypot(cx - ex, cy - ey);
          R.n++;
          R.worst = Math.max(R.worst, d);
          if (d > 1.0) { R.bad++; if (R.ex.length < 2) R.ex.push(`${name} rec ${en.rec}: (${cx.toFixed(2)}, ${cy.toFixed(2)}) vs (${ex.toFixed(2)}, ${ey.toFixed(2)})`); }
        }
        if (R.err) break;
      }
      return R;
    };
    const fixedCam = (o) => SC.smokeOrthoCamera(THREE, o);
    // the pre-fix page camera: world bounds handed to three as the view-space frustum
    const preFixCam = (o) => {
      const cam = new THREE.OrthographicCamera(o.left, o.right, o.top, o.bottom, 0.1, 10000);
      cam.position.set(o.cx, o.cy, o.zTop + 1000);
      cam.up.set(0, 1, 0);
      cam.lookAt(o.cx, o.cy, o.zTop);
      cam.updateMatrixWorld(true);
      return cam;
    };
    const rep = (R) => `${R.n} centroids, ${R.bad} > 1 px, ${R.miss} uncovered, ${R.clip} clipped vertices, worst ${R.worst.toFixed(3)} px, ${R.opBad} colour off, ${R.draws} draws, programs ${R.progs.size}` + (R.err ? `; error ${R.err}` : "") + (R.ex.length ? `; ${R.ex.join(" | ")}` : "");
    const picks = SC.SMOKE_S7_CASES.reduce((a, n) => a + SC.smokeS7Picks(data.cases.find((c) => c.name === n && !c.special)).length, 0);
    // (the FX programs add FX's own colour / shape chain on top: compiled by S1 and
    // structurally checked by H1, not evaluated here; the page's S7 draws the stock bucket)
    for (const [label, mk] of [["stock additive", MATS.stockAdd], ["stock alpha (hbParticleInstAlpha)", MATS.stockAlpha]]) {
      const R = runS7(mk, fixedCam);
      check(`S7n ${label}: three r184's real vertex program (the gpu header, hbGpEval first, the #define redirect into project_vertex / color_vertex) puts every S7 pick's coverage centroid within 1 px of smokeExpectedPixel; op reaches vColor`,
        !R.err && R.vsOk && R.n === picks && R.bad === 0 && R.miss === 0 && R.clip === 0 && R.opBad === 0 && R.draws === picks && picks > 200, rep(R));
      if (label === "stock additive") {
        const tc = [...R.calls].filter((k) => TRANSCENDENTAL.includes(k));
        check("S7n the whole stock program (three's chunks + the header) calls no driver transcendental", !R.err && tc.length === 0, [...R.calls].sort().join(","));
        const C = runS7(mk, preFixCam);
        check("S7n (control) the pre-fix page camera (world bounds as three's view-space frustum) moves the centroids off, as the 2026-10-31 smoke saw (213 of 213 > 1 px, 0 uncovered)",
          !C.err && C.n === picks && C.bad >= 0.95 * C.n && C.worst > 8, rep(C));
      }
    }
    GP.GP_UNIFORMS.uGpRec.value = null;
    GP.GP_UNIFORMS.uGpRow.value = null;
  }
  GP.__resetGpParticlesForTest();
}

console.log(`\ngpu_particles: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
