// tests/rust_particles_parity.test.mjs — ?rustParticles (lane A) through the
// REAL compiled wasm and the real bridge: every scenario of
// tools/rust_parity/gen_particles.mjs runs twice on the real ParticleManager,
// once on the JS path (flag off, recording RNG) and once on the Rust path
// (flag on, the kernel replaying those draws), and what lands in the three.js
// objects is compared tick by tick: each bucket's instance matrices + colours
// (bit-exact; 1 f32 ulp in buckets fed by a trig-type emitter, velocities
// 1e-3), counts, capacities and creation order, kid records, removals (ids in
// callback order), the RP6 / cell / shared-bucket counters, the FX seed
// stream, every emitter's scalars, and (toggle scenario) the slot meshes a
// reader sees through `emitter.parts` plus the runtime instancing toggle.
//
// Part 3 — the 2026-10-26 review regressions, through the bridge: the route
// table stays bounded and drops replaced base materials (GC-checked), a
// rejected register releases its route, a same-id overwrite's orphan leaves
// the kernel (no ghost, no removal of the survivor), Q_* field reads and
// tier-1 lights make no emitterState round trip, culled / saturated moving-rig
// emitters resolve their anchor no more than the JS path, film mode's query
// reads identical samples without building proxy meshes. Checks that need a
// newer pkg export than the one loaded print SKIP.
//
// Run: node tests/rust_particles_parity.test.mjs (HB_PKG=<dir> for another
// pkg; prints SKIP and exits 0 when the pkg has no SceneParticles).

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import v8 from "node:v8";
import vm from "node:vm";

import * as THREE from "three";

import { recordRng } from "../tools/rust_parity/fixture_util.mjs";
import {
  installGlobals,
  loadModules,
  Harness,
  POJO,
  SCENARIOS,
  NODE_ONLY_SCENARIOS,
} from "../tools/rust_parity/gen_particles.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PKG = process.env.HB_PKG || "pkg";
const pkgDir = join(here, "..", PKG);

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail != null ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}

installGlobals("");
// after installGlobals: the particle modules read the URL flags at load
const { L } = await import("../scene3d/rust/particles.js");

// ---- layout.rs ↔ the bridge's L table (no wasm needed) ----
{
  const src = readFileSync(join(here, "..", "..", "..", "crates", "holtburger-scene", "src", "particles", "layout.rs"), "utf8");
  const bad = [];
  let n = 0;
  for (const m of src.matchAll(/pub const ([A-Z0-9_]+): (?:usize|u32) = (\d+);/g)) {
    n += 1;
    if (L[m[1]] !== Number(m[2])) bad.push(`${m[1]}: rust ${m[2]} js ${L[m[1]]}`);
  }
  check(`layout.rs ↔ scene3d/rust/particles.js L (${n} constants)`, bad.length === 0 && n > 100, bad.slice(0, 6).join("; ") || null);
}

// ---- the wasm pkg (SKIP before the orchestrator's build) ----
let ns = null;
let memory = null;
try {
  if (process.env.HB_PARTICLES_FAKE) {
    // Test seam: a module exporting { SceneParticles, sceneCoreAbi, memory }
    // with the pkg's API (a kernel stand-in), instead of the compiled pkg.
    const fake = await import(pathToFileURL(process.env.HB_PARTICLES_FAKE).href);
    ns = { SceneParticles: fake.SceneParticles, sceneCoreAbi: fake.sceneCoreAbi };
    memory = fake.memory;
    console.log(`rust particles parity: using the stand-in ${process.env.HB_PARTICLES_FAKE}`);
  } else {
  if (!existsSync(join(pkgDir, "holtburger_web.js"))) throw new Error(`no ${PKG}/holtburger_web.js`);
  ns = await import(pathToFileURL(join(pkgDir, "holtburger_web.js")).href);
  if (typeof ns.SceneParticles !== "function") {
    console.log(`rust particles parity: SKIP — SceneParticles missing from ${PKG} (stale pkg; rebuild with the scene core)`);
    process.exit(failed > 0 ? 1 : 0);
  }
  const out = await ns.default({ module_or_path: readFileSync(join(pkgDir, "holtburger_web_bg.wasm")) });
  memory = out.memory;
  }
} catch (e) {
  console.log(`rust particles parity: SKIP — wasm pkg not loadable in Node: ${String(e?.message ?? e).slice(0, 160)}`);
  process.exit(failed > 0 ? 1 : 0);
}

const M = await loadModules();
M.core.__setSceneWasmForTest(ns, memory);
if (!M.core.sceneCoreAvailable()) {
  console.log(`rust particles parity: SKIP — ${PKG} scene core ABI mismatch`);
  process.exit(0);
}

const TRIG = new Set([4, 5, 6, 7, 9, 11]);
const _dv = new DataView(new ArrayBuffer(4));
function ulps(a, b) {
  if (Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b))) return 0;
  _dv.setFloat32(0, a); let ia = _dv.getInt32(0);
  _dv.setFloat32(0, b); let ib = _dv.getInt32(0);
  if (ia < 0) ia = -2147483648 - ia;
  if (ib < 0) ib = -2147483648 - ib;
  return Math.abs(ia - ib);
}

/**
 * Run one scenario on one path. Each manager draws from its own stream: on
 * the JS path a recording RNG per manager (switched in before the manager adds
 * or ticks), on the Rust path its kernel replays that manager's recording.
 * Returns { snaps, keyTrig, layerTrig, bridges, draws: [per manager], jsDrawn }.
 */
async function runPath(fn, rust, drawsByMgr, { jsAfterKernel = false } = {}) {
  M.core.__setRustFlagForTest("rustParticles", rust);
  const recs = [];
  const bridges = [];
  const jsRng = { cursor: -1, drawn: 0 };
  const h = new Harness(M, {
    onManager(mgr, index, hh) {
      if (!rust) {
        const rec = recordRng(0x0c0ffee + 977 * index);
        recs[index] = rec;
        hh.rngs.set(mgr, rec.rng);
        return;
      }
      const bridge = mgr._rustBridge();
      if (!bridge) throw new Error("no Rust bridge on the Rust path");
      bridge.sys.setScriptedRng(Float64Array.from(drawsByMgr[index] || []));
      bridges[index] = bridge;
      // No JS draws on the Rust path — except after the runtime toggle hands
      // the emitters back to JS (`jsAfterKernel`, single manager): then the JS
      // RNG continues the recorded stream right where the kernel stopped.
      hh.rngs.set(mgr, () => {
        if (!jsAfterKernel || index !== 0) throw new Error("the JS RNG was used on the Rust path");
        if (jsRng.cursor < 0) jsRng.cursor = bridge.sys.rngConsumed();
        jsRng.drawn += 1;
        return drawsByMgr[0][jsRng.cursor++];
      });
    },
  });
  const snaps = [];
  const keyTrig = new Map();
  const layerTrig = new Map();
  const origTick = h.tick.bind(h);
  h.tick = async (dt) => {
    // the bucket key every live emitter feeds (to pick the tolerance)
    h.mgrs.forEach((m, mi) => {
      for (const [, e] of m.particleTable) {
        if (e._instKey === null || e._instKey === undefined) continue;
        const raw = `${e._instKey >>> 0}|${e.renderLayer | 0}${e._instAlpha === true ? "|a" : ""}${e.skyGlow === true ? "|sky" : ""}`;
        const trig = TRIG.has(e.info.particleType);
        for (const key of [raw, `m${mi}:${raw}`]) {
          if (trig) keyTrig.set(key, true);
          else if (!keyTrig.has(key)) keyTrig.set(key, false);
        }
        const row = e._fxRow | 0;
        if (row > 0 && M.fx.particleFxTier1(row).kids > 0 && trig) {
          layerTrig.set(e.renderLayer | 0, true);
          layerTrig.set(`m${mi}:${e.renderLayer | 0}`, true);
        }
      }
    });
    const snap = await origTick(dt);
    snaps.push(snap);
    return snap;
  };
  try {
    await fn(h);
  } finally {
    M.time.setRng(null);
    M.core.__setRustFlagForTest("rustParticles", undefined);
  }
  return { snaps, keyTrig, layerTrig, bridges, draws: recs.map((r) => r.values), h, jsDrawn: jsRng.drawn };
}

function cmpArr(ctx, got, want, stride, trig, velIdx, stat) {
  if (got.length !== want.length) return `${ctx}: length ${got.length} vs ${want.length}`;
  for (let i = 0; i < got.length; i++) {
    const g = got[i], w = want[i];
    if (Object.is(g, w) || (Number.isNaN(g) && Number.isNaN(w))) { stat.exact++; continue; }
    stat.diff++;
    const k = i % stride;
    if (!trig) return `${ctx}[${i}] (elem ${k}): ${g} vs ${w}`;
    if (velIdx.includes(k)) {
      const d = Math.abs(g - w);
      if (d > 1e-3) return `${ctx}[${i}] (velocity ${k}): ${g} vs ${w}`;
    } else {
      const u = ulps(g, w);
      stat.maxUlp = Math.max(stat.maxUlp, u);
      if (u > 1) return `${ctx}[${i}] (elem ${k}): ${g} vs ${w} (${u} ulps)`;
    }
  }
  return null;
}

function compare(name, js, rs) {
  const stat = { exact: 0, diff: 0, maxUlp: 0 };
  const errs = [];
  if (js.snaps.length !== rs.snaps.length) errs.push(`tick count ${js.snaps.length} vs ${rs.snaps.length}`);
  const n = Math.min(js.snaps.length, rs.snaps.length);
  for (let t = 0; t < n && errs.length < 8; t++) {
    const a = js.snaps[t], b = rs.snaps[t];
    const ctx = `${name} tick ${t + 1}`;
    for (const list of ["own", "shared"]) {
      const ka = a[list].map((x) => x.key).join(","), kb = b[list].map((x) => x.key).join(",");
      if (ka !== kb) { errs.push(`${ctx}: ${list} buckets (creation order) [${ka}] vs [${kb}]`); continue; }
      for (let i = 0; i < a[list].length; i++) {
        const x = a[list][i], y = b[list][i];
        if (x.count !== y.count) { errs.push(`${ctx}: ${list} ${x.key} count ${x.count} vs ${y.count}`); continue; }
        if (x.cap !== y.cap) errs.push(`${ctx}: ${list} ${x.key} capacity ${x.cap} vs ${y.cap}`);
        const trig = js.keyTrig.get(x.key) === true;
        const e1 = cmpArr(`${ctx} ${list}[${x.key}].mat`, y.mat, x.mat, 16, trig, [3, 7, 11], stat);
        if (e1) errs.push(e1);
        const e2 = cmpArr(`${ctx} ${list}[${x.key}].col`, y.col, x.col, 3, false, [], stat);
        if (e2) errs.push(e2);
      }
    }
    const la = a.kids.map((k) => `${k.layer}:${k.n}:${k.cap}`).join(","), lb = b.kids.map((k) => `${k.layer}:${k.n}:${k.cap}`).join(",");
    if (la !== lb) errs.push(`${ctx}: kids layers [${la}] vs [${lb}]`);
    else {
      for (let i = 0; i < a.kids.length; i++) {
        for (const [f, stride, vel] of [["pos", 4, []], ["vel", 4, [0, 1, 2]], ["row", 2, []]]) {
          const trig = f !== "row" && js.layerTrig.get(a.kids[i].layer) === true;
          const e = cmpArr(`${ctx} kids[${a.kids[i].layer}].${f}`, b.kids[i][f], a.kids[i][f], stride, trig, vel, stat);
          if (e) errs.push(e);
        }
      }
    }
    const ra = a.removed.map((e) => e && e.id).join(","), rb = b.removed.map((e) => e && e.id).join(",");
    if (ra !== rb) errs.push(`${ctx}: removed [${ra}] vs [${rb}]`);
    if (a.stats.join(",") !== b.stats.join(",")) errs.push(`${ctx}: stats [${a.stats}] vs [${b.stats}]`);
    if (a.cellHidden !== b.cellHidden) errs.push(`${ctx}: cellHiddenLastTick ${a.cellHidden} vs ${b.cellHidden}`);
    if (a.seed !== b.seed) errs.push(`${ctx}: FX seed ${a.seed} vs ${b.seed}`);
    const ea = a.emitters.map(([e, ...r]) => `${e.id}:${r.join("/")}`).join(","), eb = b.emitters.map(([e, ...r]) => `${e.id}:${r.join("/")}`).join(",");
    if (ea !== eb) errs.push(`${ctx}: emitter scalars\n      js   ${ea}\n      rust ${eb}`);
    if (a.slots.length || b.slots.length) {
      const sa = JSON.stringify(a.slots.map(([id, rows]) => [id, rows.map((r) => r.map((v) => (typeof v === "number" ? Math.fround(v) : v)))]));
      const sb = JSON.stringify(b.slots.map(([id, rows]) => [id, rows.map((r) => r.map((v) => (typeof v === "number" ? Math.fround(v) : v)))]));
      if (sa !== sb) errs.push(`${ctx}: slot meshes (emitter.parts) differ`);
    }
  }
  return { errs, stat };
}

// Exports added after the first SceneParticles build (an older pkg runs the
// bridge's fallbacks; checks that need them say SKIP).
const SP = ns.SceneParticles.prototype;
const feat = {
  addAt: typeof SP.addEmitterAt === "function",
  stateOut: typeof SP.stateOutPtr === "function",
  slotFree: typeof SP.anchorSlotFreePtr === "function",
  film: typeof SP.filmSamples === "function",
};
function skip(name, why) {
  console.log(`  [SKIP] ${name} — ${why}`);
}

console.log(`rust particles parity — ${PKG} SceneParticles vs the JS particle runtime`);
const all = { ...SCENARIOS, ...NODE_ONLY_SCENARIOS };
/** name → { js, rs } (Part 3 reads what the scenarios recorded on `h`). */
const runs = new Map();
for (const [name, fn] of Object.entries(all)) {
  let js, rs;
  try {
    const opts = { jsAfterKernel: name === "toggle" };
    js = await runPath(fn, false, null, opts);
    rs = await runPath(fn, true, js.draws, opts);
  } catch (e) {
    check(name, false, `threw: ${e?.stack ?? e}`);
    continue;
  }
  runs.set(name, { js, rs });
  if (name === "sameId" && !feat.addAt) {
    // without addEmitterAt the newcomer runs last in the kernel, not at the
    // orphan's table position: same draws, another order (Part 3 still checks
    // the overwrite itself)
    skip(`${name}: bit-exact`, `${PKG} has no SceneParticles.addEmitterAt`);
    continue;
  }
  const { errs, stat } = compare(name, js, rs);
  rs.bridges.forEach((b, i) => {
    const consumed = b.sys.rngConsumed();
    const overrun = b.sys.rngOverrun();
    const extra = i === 0 ? rs.jsDrawn : 0;
    if (consumed + extra !== js.draws[i].length || overrun) {
      errs.push(`RNG (manager ${i}): kernel consumed ${consumed} + JS ${extra} of ${js.draws[i].length} draws (overrun ${overrun})`);
    }
  });
  check(`${name}: ${js.snaps.length} ticks identical`, errs.length === 0,
    errs.length ? errs.slice(0, 6).join("\n    ") : `${stat.exact} floats exact, ${stat.diff} within tolerance (max ${stat.maxUlp} ulp)`);
}

// ---- Part 3: the 2026-10-26 review regressions, through the bridge ----
console.log("review regressions (route table, same-id overwrite, state reads, anchor needs, film)");

/** `gc()` without --expose-gc (null if the runtime refuses). */
function getGc() {
  if (typeof globalThis.gc === "function") return globalThis.gc;
  try {
    v8.setFlagsFromString("--expose-gc");
    return vm.runInNewContext("gc");
  } catch {
    return null;
  }
}
const gcFn = getGc();
async function collect() {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    gcFn();
  }
}

/**
 * Finding 1: every base material a route was built on stays reachable from
 * the bridge. Rounds of "evicted + re-minted" materials (a fresh material +
 * texture per round for one alpha gfxobj — what `?matBudgetMB`'s LRU does),
 * two rounds' emitters alive at a time (one static, one on a moving rig),
 * then every emitter destroyed and the idle buckets reaped.
 */
async function routeChurn(rust, rounds) {
  M.core.__setRustFlagForTest("rustParticles", rust);
  M.time.setRng(recordRng(0x7a11).rng);
  const out = { refs: [], maxRoutes: 0, bridge: null };
  try {
    const h = new Harness(M);
    const HW = 0x0100a501;
    h.defGfx(HW, { alpha: true });
    const a = h.frozenAnchor(1, 2, 0.5);
    const rig = h.movingAnchor(-2, 1, 0);
    let prev = [];
    for (let r = 0; r < rounds; r++) {
      const tex = new THREE.DataTexture(new Uint8Array(32 * 32 * 4).fill(r & 255), 32, 32);
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
      mat.userData = { __cacheOwned: true, surfaceTypeFlags: 0x100 };
      h.gfx.get(HW).mat = mat;
      out.refs.push({ mat: new WeakRef(mat), tex: new WeakRef(tex), px: new WeakRef(tex.image.data) });
      const ids = [
        await h.add({ anchor: a, info: POJO({ hwGfxObjId: HW, maxParticles: 8, initialParticles: 3 }) }),
        await h.add({ anchor: rig, info: POJO({ hwGfxObjId: HW, particleType: 3, maxParticles: 6 }) }),
      ];
      for (let t = 0; t < 3; t++) {
        rig.position.x = -2 + 0.05 * (r * 4 + t);
        await h.tick();
      }
      for (const id of prev) h.destroy(id);
      prev = ids;
      await h.tick();
      if (h.mgr._rust) out.maxRoutes = Math.max(out.maxRoutes, h.mgr._rust.inputs.routeList.length);
    }
    for (const id of prev) h.destroy(id);
    h.gfx.get(HW).mat = null;
    for (let t = 0; t < 200; t++) await h.tick(); // idle buckets reap after 180 ticks
    out.bridge = h.mgr._rust;
    out.tableSize = h.mgr.particleTable.size;
  } finally {
    M.time.setRng(null);
    M.core.__setRustFlagForTest("rustParticles", undefined);
  }
  return out;
}

{
  const ROUNDS = 30;
  const js = await routeChurn(false, ROUNDS);
  const rs = await routeChurn(true, ROUNDS);
  const inp = rs.bridge ? rs.bridge.inputs : null;
  check("route table: bounded by the live routes, ids reused, empty once every emitter is gone",
    !!inp && rs.maxRoutes <= 2 && inp.routeList.length <= 2 && inp.liveRouteCount() === 0 &&
      inp.routeIds.size === 0 && inp.freeRoutes.length === inp.routeList.length &&
      rs.bridge.sys.routeInLen() <= 2 * L.ROUTE_STRIDE && rs.bridge.emitterCount === 0 && rs.tableSize === 0,
    inp ? `${ROUNDS} materials: peak ${rs.maxRoutes} routes, routeList ${inp.routeList.length}, live ${inp.liveRouteCount()}, ` +
      `routeIds ${inp.routeIds.size}, free ${inp.freeRoutes.length}, kernel route floats ${rs.bridge.sys.routeInLen()}` : "no bridge");
  if (!gcFn) {
    skip("route table: replaced materials collectable", "no gc() in this runtime");
  } else {
    await collect();
    const alive = (o) => ["mat", "tex", "px"].map((k) => o.refs.filter((r) => r[k].deref() !== undefined).length);
    const [jm, jt, jp] = alive(js);
    const [rm, rt, rp] = alive(rs);
    check("route table: replaced base materials / textures / pixel buffers collectable after their emitters",
      rm === 0 && rt === 0 && rp === 0 && jm === 0,
      `rust ${rm}/${rt}/${rp} of ${ROUNDS} alive (materials/textures/pixels), js ${jm}/${jt}/${jp}`);
  }
}

// a failed register releases its route (the manager drops the emitter)
{
  M.core.__setRustFlagForTest("rustParticles", true);
  M.time.setRng(recordRng(0x7a12).rng);
  const warn = console.warn;
  try {
    const h = new Harness(M);
    const HW = 0x0100a502;
    h.defGfx(HW, { alpha: true });
    const a = h.frozenAnchor(0, 0, 0);
    await h.add({ anchor: a, info: POJO({ hwGfxObjId: HW }) });
    const br = h.mgr._rust;
    const mat2 = h.gfx.get(HW).mat.clone(); // a new base material: the failing add interns a new route
    mat2.userData = { ...h.gfx.get(HW).mat.userData };
    h.gfx.get(HW).mat = mat2;
    const before = [br.inputs.liveRouteCount(), br.inputs.routeIds.size, h.mgr.particleTable.size, br.emitterCount];
    const reject = () => 0xffffffff;
    br.sys.addEmitter = reject;
    if (feat.addAt) br.sys.addEmitterAt = reject;
    console.warn = () => {};
    let idFail;
    try {
      idFail = await h.add({ anchor: a, info: POJO({ hwGfxObjId: HW, particleType: 3 }) });
    } finally {
      console.warn = warn;
      delete br.sys.addEmitter;
      delete br.sys.addEmitterAt;
    }
    const after = [br.inputs.liveRouteCount(), br.inputs.routeIds.size, h.mgr.particleTable.size, br.emitterCount];
    const len = br.inputs.routeList.length;
    const idOk = await h.add({ anchor: a, info: POJO({ hwGfxObjId: HW, particleType: 3 }) });
    await h.tick();
    check("route table: a rejected register releases its route; the next add reuses the id",
      idFail === 0 && after.join() === before.join() && idOk !== 0 && br.inputs.routeList.length === len &&
        br.inputs.liveRouteCount() === before[0] + 1,
      `ids ${idFail}/${idOk}; live routes, route keys, table, kernel: [${before}] → [${after}]; routeList ${len} → ${br.inputs.routeList.length}`);
  } catch (e) {
    check("route table: a rejected register releases its route", false, `threw: ${e?.stack ?? e}`);
  } finally {
    console.warn = warn;
    M.time.setRng(null);
    M.core.__setRustFlagForTest("rustParticles", undefined);
  }
}

// Finding 2: the orphan of an in-place overwrite (scenario sameId)
{
  const r = runs.get("sameId");
  if (!r) {
    check("same-id overwrite", false, "scenario did not run");
  } else {
    const a = r.js.h.sameIdInfo, b = r.rs.h.sameIdInfo;
    check("same-id overwrite: the orphan leaves the kernel, the survivor keeps its id and table position",
      b.orphans === 1 && !b.orphanInKernel && b.survivorPersistent && a.survivorPersistent &&
        b.kernelEmitters === b.tableShells && b.tableIds === a.tableIds && (b.placedBefore || !feat.addAt),
      `table [${b.tableIds}] (js [${a.tableIds}]), orphans ${b.orphans} (in kernel: ${b.orphanInKernel}), ` +
        `kernel ${b.kernelEmitters} = table shells ${b.tableShells}, placed before the next shell: ${b.placedBefore}`);
    // the survivor is destroyed by id at tick index 30; nothing is removed before
    check("same-id overwrite: no removal of the survivor by the orphan's finish",
      b.removed.join() === a.removed.join() && !b.removed.some((s) => Number(s.split(":")[0]) < 30),
      `removals rust [${b.removed}] js [${a.removed}]`);
  }
}

// Finding 5: Q_* reads through the published state row (no emitterState call)
{
  M.core.__setRustFlagForTest("rustParticles", true);
  M.time.setRng(recordRng(0x7a13).rng);
  const FXL = await import("../scene3d/vfx/fx_lights.js");
  try {
    const h = new Harness(M);
    h.defGfx(0x0100a601, {});
    h.defGfx(0x0100a602, { alpha: true });
    const rig = h.movingAnchor(0, 3, 0, { parts: 1 });
    const shells = [];
    let lights = 0;
    for (let i = 0; i < 24; i++) {
      const dyn = i % 4 === 3;
      const anchor = dyn ? rig : h.frozenAnchor((i % 6) * 2 - 5, Math.floor(i / 6) * 2 - 3, 0);
      const id = await h.add({ anchor, partIndex: dyn && i % 8 === 7 ? 0 : -1, info: POJO({
        hwGfxObjId: i % 2 ? 0x0100a601 : 0x0100a602, particleType: i % 13, isParentLocal: dyn && i % 8 === 3,
        totalParticles: i % 5 === 0 ? 10 : 0, maxParticles: 6 + (i % 7), initialParticles: 2, birthrate: 0.03,
      }) });
      const e = h.mgr.particleTable.get(id);
      shells.push([id, e]);
      // what particle_manager._bindTier1 does for a lit FX row
      if (FXL.bindEmitterFxLight({ emitter: e, resolvePosition: (o) => { o.set(0, 0, 0); return true; }, intensity: 10, range: 5 })) lights += 1;
    }
    const br = h.mgr._rust;
    const es = br.sys.emitterState.bind(br.sys);
    let calls = 0;
    br.sys.emitterState = (hh) => { calls += 1; return es(hh); };
    const scene3d = { activeLights: [], camera: h.cam };
    const Q = [
      ["numParticles", L.Q_NUM_PARTICLES], ["totalEmitted", L.Q_TOTAL_EMITTED], ["creationTime", L.Q_CREATION_TIME],
      ["lastEmitTime", L.Q_LAST_EMIT_TIME], ["lastUpdateTime", L.Q_LAST_UPDATE_TIME], ["_createdSlots", L.Q_CREATED_SLOTS],
      ["stopped", L.Q_STOPPED, (v) => v === 1], ["_growing", L.Q_GROWING, (v) => v === 1],
      ["_rp6Culled", L.Q_CULLED, (v) => v === 1, true],
    ];
    // every emitterState call over the frames: the Harness snapshot's field
    // reads (inside h.tick), tier-1 lights, these reads, the stops, removals
    // (the comparison below calls the unwrapped method)
    calls = 0;
    let reads = 0;
    const bad = [];
    let stopOk = true;
    for (let f = 0; f < 40; f++) {
      rig.position.set(0.1 * f, 3, 0.02 * f);
      rig.updateMatrixWorld(true);
      h.cam.position.set(30 * Math.cos(f * 0.2), 20, 30 * Math.sin(f * 0.2)); // cached shells cull in and out
      h.cam.lookAt(0, 0, 0);
      if (f === 20 || f === 31) {
        // stopped between ticks reads back at once
        const [sid, se] = shells[f === 20 ? 1 : 6];
        h.stop(sid);
        if (se._rustHandle >= 0 && se.stopped !== true) stopOk = false;
      }
      await h.tick();
      FXL.tickFxLights(scene3d, 1000 + 16 * f);
      const vals = [];
      for (const [, e] of shells) {
        if (!(e._rustHandle >= 0)) continue;
        vals.push([e, Q.map(([k]) => e[k])]);
        reads += Q.length;
      }
      for (const [e, v] of vals) {
        const row = es(e._rustHandle); // the kernel's own row, outside the counted window
        Q.forEach(([k, qi, conv, cachedOnly], j) => {
          if (cachedOnly && !e._rustCached) return;
          const want = conv ? conv(row[qi]) : row[qi];
          if (!Object.is(v[j], want) && bad.length < 6) bad.push(`tick ${f + 1} #${e.id}.${k}: ${v[j]} vs ${want}`);
        });
      }
    }
    FXL._resetFxLightsForTest();
    check("state reads: the shell fields equal the kernel's row; a stop between ticks reads back at once",
      bad.length === 0 && stopOk, bad.length ? bad.join("; ") : `${reads} reads over ${shells.length} shells × 40 ticks`);
    const what = `${reads} field reads + the Harness snapshots + 40 tickFxLights over ${lights} lights + 2 stops`;
    if (!feat.stateOut) {
      skip("state reads: no emitterState round trip per read / per lit shell", `${PKG} has no SceneParticles.stateOutPtr (fallback: ${calls} calls for ${what})`);
    } else {
      check("state reads: no emitterState round trip per read / per lit shell (tier-1 lights included)",
        calls === 0 && lights > 0, `emitterState calls: ${calls} for ${what}`);
    }
  } catch (e) {
    check("state reads", false, `threw: ${e?.stack ?? e}`);
  } finally {
    M.time.setRng(null);
    M.core.__setRustFlagForTest("rustParticles", undefined);
  }
}

// Finding 3: anchor resolves of dynamic shells (scenario culledDynamic)
{
  const r = runs.get("culledDynamic");
  if (!r) {
    check("anchor needs", false, "scenario did not run");
  } else {
    const A = r.js.h.anchorResolves, B = r.rs.h.anchorResolves;
    const at = (m, phase, name) => m.get(`${phase}:${name}`) || 0;
    const names = ["plPart", "plRoot", "secSat", "meter", "secFixed", "finitePl"];
    const table = ["warm", "culled", "visible"].map((p) => `${p} ${names.map((n) => `${n} ${at(A, p, n)}/${at(B, p, n)}`).join(" ")}`);
    console.log(`    anchor resolves js/rust per phase: ${table.join(" | ")}`);
    if (!feat.slotFree) {
      skip("anchor needs: culled persistent / saturated dynamic shells resolve no more than the JS path",
        `${PKG} predates the NEED_SKIP_IF_CULLED / NEED_IF_SLOT kernel`);
    } else {
      const errs = [];
      for (const p of ["warm", "culled", "visible"]) {
        // parent-local: once per tick that reads it, exactly as the JS hoist
        for (const n of ["plPart", "plRoot"]) if (at(B, p, n) !== at(A, p, n)) errs.push(`${p} ${n} ${at(A, p, n)}/${at(B, p, n)}`);
        // emit-gated: the JS path resolves on its emits (per-metre: every tick it may emit);
        // the kernel on its due ticks with a slot free or about to free (1 ms margin)
        for (const n of ["secSat", "meter", "secFixed"]) if (at(B, p, n) > at(A, p, n) + 3) errs.push(`${p} ${n} ${at(A, p, n)}/${at(B, p, n)}`);
      }
      for (const n of ["plRoot", "secSat", "meter", "secFixed"]) {
        // culled persistent, not stopped: nothing after the cull decision lands (≤ one RP6 interval)
        if (at(B, "culled", n) > at(A, "culled", n)) errs.push(`culled ${n} ${at(A, "culled", n)}/${at(B, "culled", n)}`);
      }
      check("anchor needs: culled persistent / saturated dynamic shells resolve no more than the JS path",
        errs.length === 0, errs.length ? errs.join("; ") : "finitePl (culled, finite) is the documented residual");
    }
  }
}

// Finding 4: film mode reads the kernel's samples, not proxy meshes (scenario film)
{
  const r = runs.get("film");
  if (!r) {
    check("film query", false, "scenario did not run");
  } else {
    const a = r.js.h.filmRows, b = r.rs.h.filmRows;
    let first = -1;
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { first = i; break; }
    const nonEmpty = a.filter((s) => s.length > 20).length;
    check("film query: spheres + samples identical on both paths, no proxy meshes built",
      first < 0 && a.length === 36 && nonEmpty > 30 && r.rs.h.filmProxies === 0,
      first >= 0 ? `tick ${first + 1}:\n      js   ${String(a[first]).slice(0, 300)}\n      rust ${String(b[first]).slice(0, 300)}`
        : `${a.length} ticks, proxies ${r.rs.h.filmProxies}${feat.film ? "" : " (slotSnapshot fallback: no filmSamples in " + PKG + ")"}`);
  }
}

console.log("===========================================================");
console.log(`Result: ${passed} passed, ${failed} failed`);
console.log("===========================================================");
process.exit(failed > 0 ? 1 : 0);
