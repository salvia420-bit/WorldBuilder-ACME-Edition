// tests/rust_world_shadow.test.mjs — lane W `?rustWorld` shadow mode
// (docs/2026-10-26-rust-world.md): the static world's residency and visibility
// tables mirrored in the kernel, audited against what three.js and the JS
// residency actually hold, over scripted worlds driven through the REAL
// producers (tools/rust_parity/gen_world_scenarios.mjs: chunk buckets with and
// without ?statGeomDedup, atlas buckets, building batches, the pool registry,
// the SlotGrid + adapter driving a real LandblockLRU, pools and ?objRadius).
//
//   M — the kernel is the JS reference model (tools/rust_parity/gen_world_model.mjs,
//       the spec the Rust kernel ports). Always runs:
//       M1 every checkpoint of every scenario audits 0 mismatches, 0 integrity;
//       M2 no behaviour change: the armed run's JS state equals a disarmed run's
//          at every checkpoint (instance tables, matrices, geometry ranges, LRU,
//          grid, pools, objRadius);
//       M3 replay: the recorded stream replayed in ONE batch into a fresh kernel
//          audits 0 at every checkpoint (what cargo does with the fixtures), and
//          single perturbations of an arena are caught in the right category;
//       M4 every semantic hook is load-bearing: knocking out any one of them
//          makes the audit (or the integrity counters) fail;
//       M5 a foreign setVisibleAt is caught (model) but explained (raw), a film
//          watch is skipped, the cell PVS delta round-trips;
//       M6 flag grammar, the stale-pkg disarm, the S0 census;
//       M7 (2026-10-29) ?objRadius x pools through the grid (objrPool): the
//          forget lifts the registry's sticky hide, the walked-back landblock's
//          pooled statics show again; the pre-fix forget replayed is caught by
//          the poolHideOrphan category.
//   W — the same scenarios and the fixtures (crates/holtburger-scene/tests/fixtures/world_*.json)
//       through the REAL compiled `SceneWorld` from `${HB_PKG || "pkg"}/holtburger_web.js`,
//       plus M5's unpinned rules (cell PVS, late-track snapshots, LRU_DROP_POOL)
//       and M7's pre-fix drift; prints `SKIP — <reason>` and exits 0 when the pkg
//       or the class is missing (the M7 drift line SKIPs on a pkg built before
//       the poolHideOrphan category).
//
// Run from apps/holtburger-web/:  node tests/rust_world_shadow.test.mjs
//   (HB_PKG=pkg-rustcore for the orchestrator's dev build)

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const pkgDir = process.env.HB_PKG || "pkg";

const S = await import("../tools/rust_parity/gen_world_scenarios.mjs");
const { WorldModel, MISMATCH_KEYS, INTEGRITY_KEYS } = await import("../tools/rust_parity/gen_world_model.mjs");
const M = await S.loadModules();
const W = M.world;
const core = await import("../scene3d/rust/scene_core.js");
const THREE = M.THREE;

let passed = 0, failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail != null && detail !== "" ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}

const NAMES = Object.keys(S.SCENARIOS);
const sum = (cps, f) => cps.reduce((a, cp) => a + f(cp), 0);
const mm = (cp) => (cp.audit && typeof cp.audit.mismatches === "number" ? cp.audit.mismatches : 1e9);
const integ = (cp) => (cp.audit && cp.audit.report ? cp.audit.report.integrityTotal : 1e9);
const catOf = (k) => (cp) => (cp.audit && cp.audit.report ? cp.audit.report.last.cat[k] : 0);

// ── M1 + M2 ─────────────────────────────────────────────────────────────────
console.log("rustWorld — M1/M2: every scenario audits clean; armed == disarmed");
const armed = {};
for (const name of NAMES) {
  const r = await S.runScenario(name, { kernel: new WorldModel() });
  armed[name] = r;
  const bad = r.checkpoints.filter((cp) => mm(cp) !== 0 || integ(cp) !== 0);
  check(`M1 ${name}: ${r.checkpoints.length} checkpoints, 0 mismatches, 0 integrity`, bad.length === 0,
    bad.length ? `${bad[0].label}: ${JSON.stringify(bad[0].audit && bad[0].audit.report && bad[0].audit.report.last)}` : `${r.events.length} event f64s`);
  check(`M1 ${name}: bridge clean (no hook / kernel errors, nothing untracked)`,
    r.stats.hookErrors === 0 && r.stats.kernelErrors === 0 && r.stats.untrackedPosts === 0 && r.stats.opaqueIterables === 0,
    JSON.stringify({ h: r.stats.hookErrors, k: r.stats.kernelErrors, u: r.stats.untrackedPosts, e: r.stats.lastError }));
  const and = sum(r.checkpoints, (cp) => (cp.audit && cp.audit.report ? cp.audit.report.andDivergence : 0));
  console.log(`    ${name}: R2 AND-form divergence over the checkpoints = ${and} (diagnostic)`);
  const off = await S.runScenario(name, { arm: false });
  let diff = -1;
  for (let i = 0; i < r.checkpoints.length; i++) if (r.checkpoints[i].state !== (off.checkpoints[i] && off.checkpoints[i].state)) { diff = i; break; }
  check(`M2 ${name}: JS state identical flag on vs off at every checkpoint`, diff === -1 && off.checkpoints.length === r.checkpoints.length,
    diff >= 0 ? `first difference at "${r.checkpoints[diff].label}"` : "");
}
{
  // The scenarios are not vacuous: they hide, park, release and move things.
  const g = armed.grid.checkpoints;
  const c = armed.chunk.checkpoints;
  const vis = (cp) => cp.census.visible, act = (cp) => cp.census.active;
  check("M1 coverage: chunk hides instances (park, objRadius) and shows them again",
    c.some((cp) => vis(cp) < act(cp)) && c.some((cp) => vis(cp) === 0 && act(cp) > 0) && vis(c[0]) === act(c[0]) && act(c[0]) > 300);
  check("M1 coverage: grid parks tiles, drains a teleport and re-adopts",
    g.some((cp) => (cp.census.tiles["4"] || 0) >= 12) && g.some((cp) => cp.census.lru.parked > 50) && g.some((cp) => cp.census.pools.parkedTiles > 0));
  const p = armed.pool.checkpoints;
  check("M1 coverage: pools commit parked, hide landblocks and cells",
    p.some((cp) => cp.census.pools.parkedTiles > 0 && cp.census.visible < cp.census.active) && p.some((cp) => cp.census.pools.hiddenLbs > 0));
}

// ── M7 ?objRadius x pools: the forget fix and the poolHideOrphan cross-check ─
// (2026-10-29, lane W review r2.) objrPool is the grid with ?objRadius's pool
// hides wired as index.js wires them: landblock A hidden for distance, its tile
// parked and released, a crossing far away forgets it, a walk back re-bakes it.
// `preFixForget` replays the forget as it was before the object_radius.js fix
// (the registry's sticky hide left behind).
console.log("rustWorld — M7: ?objRadius x pools (hide, release, forget, walk back); the poolHideOrphan cross-check");
const FORGET = "a crossing far away: objRadius forgets them";
const BACK = "walked back onto A: re-baked, its pooled statics visible";
const orphanOf = (cp) => (cp.audit && cp.audit.report ? cp.audit.report.last.cat.poolHideOrphan : undefined);
const stateAt = (r, label) => JSON.parse(r.checkpoints.find((c) => c.label === label).state);
const allOf = (arr, v) => arr.length > 0 && arr.every((x) => x === v);
{
  const r = armed.objrPool;
  const hid = stateAt(r, "walked 3 east: A hidden (objRadius + the registry's copy)").poolVis;
  const back = stateAt(r, BACK).poolVis;
  check("M7 objrPool: A's pooled statics hide for distance and are VISIBLE again after park, release, forget and the walk back",
    allOf(hid.A, 0) && allOf(back.A, 1) && allOf(back.A2, 1), JSON.stringify({ hid, back }));
  const f = stateAt(r, FORGET);
  const pre = stateAt(r, "pressure released the parked tiles (baked marks gone)");
  check("M7 objrPool: the forget lifts the registry's copy with objRadius's own (both emptied by it)",
    pre.regHidden.length > 0 && pre.objr.length === pre.regHidden.length && f.regHidden.length === 0 && f.objr.length === 0,
    `${pre.regHidden.length}/${pre.objr.length} -> ${f.regHidden.length}/${f.objr.length}`);
  check("M7 objrPool: poolHideOrphan 0 at every checkpoint, and the bridge's stat reads 0",
    r.checkpoints.every((cp) => orphanOf(cp) === 0) && r.stats.poolHideOrphan === 0, r.checkpoints.map(orphanOf).join(" "));
  const p = armed.pool.checkpoints;
  check("M7 a registry driven alone (pool: hides, no objRadius section) is not cross-checked: poolHideOrphan 0",
    p.some((cp) => cp.census.pools.hiddenLbs > 0) && p.every((cp) => orphanOf(cp) === 0), p.map(orphanOf).join(" "));
}
const preFix = await S.runScenario("objrPool", { kernel: new WorldModel(), opts: { preFixForget: true } });
{
  const i0 = preFix.checkpoints.findIndex((c) => c.label === FORGET);
  const before = preFix.checkpoints.slice(0, i0), after = preFix.checkpoints.slice(i0);
  const back = stateAt(preFix, BACK).poolVis;
  check("M7 the pre-fix forget (replayed): the walked-back landblocks' pooled statics stay INVISIBLE (the product bug)",
    i0 > 0 && allOf(back.A, 0) && allOf(back.A2, 0), JSON.stringify(back));
  check("M7 …and the audit now sees it: poolHideOrphan > 0 from the forget on (0 before), the only category counted",
    before.every((cp) => orphanOf(cp) === 0 && mm(cp) === 0) && after.every((cp) => orphanOf(cp) > 0 && mm(cp) === orphanOf(cp)) &&
    preFix.checkpoints.every((cp) => integ(cp) === 0), preFix.checkpoints.map(orphanOf).join(" "));
  check("M7 …and the bridge's stats carry it (stats().poolHideOrphan, inside stats().mismatches)",
    preFix.stats.poolHideOrphan > 0 && preFix.stats.mismatches >= preFix.stats.poolHideOrphan, JSON.stringify({ o: preFix.stats.poolHideOrphan, m: preFix.stats.mismatches }));
  const and = sum(preFix.checkpoints, (cp) => cp.audit.report.andDivergence);
  console.log(`    pre-fix objrPool: R2 AND-form divergence over the checkpoints = ${and} (the AND form reads the registry's own copy; diagnostic)`);
}

// ── M3 replay + perturbations ───────────────────────────────────────────────
console.log("rustWorld — M3: one-batch replay audits clean; perturbations are caught");
function replayTo(events, end) {
  const k = new WorldModel();
  const n = k.apply(events.subarray(0, end));
  return { k, n };
}
for (const name of NAMES) {
  const r = armed[name];
  let bad = null;
  for (const cp of r.checkpoints) {
    const { k, n } = replayTo(r.events, cp.eventsEnd);
    const m = k.audit(cp.audit.arena);
    if (n < 0 || m !== 0 || JSON.stringify(JSON.parse(k.census())) !== JSON.stringify(cp.census)) { bad = `${cp.label}: apply ${n}, audit ${m}`; break; }
  }
  check(`M3 ${name}: replayed in one batch, every checkpoint audits 0 with the same census`, bad === null, bad || "");
}

/** Section offsets of an arena (tests only). */
function arenaIndex(a) {
  const out = { objects: [], lru: [], grid: [], objr: [], poolreg: [], poolrecs: [], matrices: [], ranges: [] };
  let i = 0;
  while (i < a.length) {
    const sec = a[i++];
    if (sec === 0) break;
    if (sec === 1) {
      const n = a[i++];
      for (let q = 0; q < n; q++) { const len = a[i + 2]; out.objects.push({ at: i, h: a[i], mode: a[i + 1], len }); i += 3 + 2 * len; }
    } else if (sec === 2) { out.lru.push(i); const nl = a[i + 1]; const np = a[i + 2 + nl]; i += 3 + nl + np; }
    else if (sec === 3) { out.grid.push(i); i += 2 + 4 * a[i + 1]; }
    else if (sec === 4 || sec === 5) { if (sec === 4) out.objr.push(i); i += 2 + a[i + 1]; }
    else if (sec === 6) { out.poolreg.push(i); const np = a[i + 1]; const nh = a[i + 2 + np]; i += 3 + np + nh; }
    else if (sec === 9) { out.poolrecs.push(i); const n = a[i + 1]; let k = i + 2; for (let q = 0; q < n; q++) k += 4 + a[k + 3]; i = k; }
    else if (sec === 7) { out.matrices.push(i); i += 2 + 17 * a[i + 1]; }
    else if (sec === 8) { out.ranges.push(i); i += 2 + 3 * a[i + 1]; }
    else if (sec === 10) { i += 1; }
    else throw new Error(`bad section ${sec}`);
  }
  return out;
}
// `want`: the exact per-category counts the edit must produce (and nothing else).
function perturb(name, label, edit, want) {
  const r = armed[name];
  const cp = r.checkpoints.find((c) => c.label === label);
  const { k } = replayTo(r.events, cp.eventsEnd);
  const a = Float64Array.from(cp.audit.arena);
  const ix = arenaIndex(a);
  const what = edit(a, ix);
  const m = k.audit(a);
  const rep = JSON.parse(k.report());
  const total = Object.values(want).reduce((x, y) => x + y, 0);
  const ok = m === total && MISMATCH_KEYS.every((key) => rep.last.cat[key] === (want[key] || 0));
  check(`M3 perturbation caught (${name}: ${what})`, ok, `mismatches ${m}, ${JSON.stringify(Object.fromEntries(Object.entries(rep.last.cat).filter(([, v]) => v)))}`);
}
const firstActive = (a, o) => { for (let s = 0; s < o.len; s++) if ((a[o.at + 3 + 2 * s] & 1) === 1) return o.at + 3 + 2 * s; return -1; };
perturb("chunk", "park L2 (warm park hides its bucket instances)", (a, ix) => {
  const o = ix.objects.find((x) => x.len > 0); const p = firstActive(a, o); a[p] ^= 2; return "one instance's visible bit";
}, { vis: 1, raw: 1 }); // both the derived and the raw mirror disagree with the edited arena
perturb("chunk", "fed four landblocks over two regions", (a, ix) => {
  const o = ix.objects.find((x) => x.len > 0); const p = firstActive(a, o); a[p + 1] += 1; return "one instance's geometry id";
}, { gid: 1 });
perturb("chunk", "unpark L2 (afterUnpark: not hidden)", (a, ix) => {
  const o = ix.objects.find((x) => x.len > 0); const p = firstActive(a, o); a[p] &= ~1; return "one instance deactivated";
}, { active: 1 });
perturb("chunk", "park L2 (warm park hides its bucket instances)", (a, ix) => {
  const at = ix.lru[0]; const nl = a[at + 1]; const p = at + 3 + nl; a[p] = 0x7f7f0000; return "a parked landblock renamed";
}, { lru: 2 });
perturb("grid", "stood still (hysteresis parks)", (a, ix) => {
  const at = ix.grid[0]; a[at + 3] = a[at + 3] === 3 ? 4 : 3; return "one tile's state";
}, { tileState: 1 });
perturb("grid", "stood still (hysteresis parks)", (a, ix) => {
  const at = ix.grid[0]; a[at + 4] += 0.5; return "one tile's sinceMs";
}, { tileTime: 1 });
perturb("chunk", "objRadius 1 around L1 hides L3 + L4", (a, ix) => {
  const at = ix.objr[0]; a[at + 2] = 0x01020000; return "an objRadius-hidden landblock renamed";
}, { objr: 2 });
perturb("chunk", "fed four landblocks over two regions", (a, ix) => {
  const at = ix.matrices[0]; a[at + 2 + 1 + 12] += 0.25; return "one matrix element";
}, { matrix: 1 });
perturb("chunk", "optimize tick", (a, ix) => {
  const at = ix.ranges.find((p) => a[p + 1] > 0); a[at + 2 + 1] += 3; return "one geometry range start";
}, { ranges: 1 });
perturb("pool", "T2 parked mid-feed, committed parked", (a, ix) => {
  const at = ix.poolreg[0]; a[at + 2] = 0x7777; return "a parked tile renamed";
}, { poolReg: 2 });
perturb("pool", "adopt T2", (a, ix) => {
  const at = ix.poolrecs[0]; a[at + 2 + 2] = a[at + 2 + 2] ? 0 : 1; return "one record's live flag";
}, { poolRec: 1 });
perturb("objrPool", "walked 3 east: A hidden (objRadius + the registry's copy)", (a, ix) => {
  const at = ix.poolreg[0]; const np = a[at + 1]; a[at + 3 + np] = 0x7e7e0000;
  return "a pool-hidden landblock renamed to one no objRadius set holds";
}, { poolReg: 2, poolHideOrphan: 1 });
{
  // An object only one side knows.
  const r = armed.chunk;
  const cp = r.checkpoints[1];
  const { k } = replayTo(r.events, cp.eventsEnd);
  const a = Array.from(cp.audit.arena);
  const ix = arenaIndex(Float64Array.from(a));
  const o = ix.objects[ix.objects.length - 1];
  // drop the last object record (3 + 2*len values) and decrement nObj
  a.splice(o.at, 3 + 2 * o.len);
  a[1] -= 1;
  const m1 = k.audit(Float64Array.from(a));
  const rep = JSON.parse(k.report());
  check("M3 an object the arena lacks is counted missingObject", m1 === 1 && rep.last.cat.missingObject === 1, `${m1}`);
  const b = Array.from(cp.audit.arena);
  b.splice(2, 0, 999999, 0, 0); b[1] += 1;
  const m2 = k.audit(Float64Array.from(b));
  const rep2 = JSON.parse(k.report());
  check("M3 an object the kernel lacks is counted unknownObject", m2 === 1 && rep2.last.cat.unknownObject === 1, `${m2}`);
  check("M3 a malformed arena is refused (-1)", k.audit(Float64Array.of(1, 5, 7)) === -1 && k.audit(Float64Array.of(42)) === -1);
  check("M3 a malformed event batch is refused (-1)", new WorldModel().apply(Float64Array.of(1, 1, 1)) === -1 && new WorldModel().apply(Float64Array.of(77, 0)) === -1);
}

// ── M4 knock-out mutants ────────────────────────────────────────────────────
console.log("rustWorld — M4: every semantic hook is load-bearing");
const MUTANTS = [
  ["track", "chunk"], ["attrLb", "chunk"], ["lbVis", "chunk"], ["lbVis", "atlas"],
  ["poolAttr", "pool"], ["poolCommit", "pool"], ["poolPark", "pool"], ["poolAdopt", "pool"],
  ["poolHideLb", "pool"], ["poolShowLb", "pool"], ["poolCellsVisible", "pool"], ["poolCellSet", "pool"],
  ["poolReleaseCells", "pool"], ["poolRelease", "pool"], ["poolClearParked", "pool"], ["poolRegReset", "pool"],
  ["lruTrack", "chunk"], ["lruPark", "chunk"], ["lruUnpark", "chunk"], ["lruEvict", "chunk"],
  ["objrHide", "chunk"], ["objrShow", "chunk"], ["objrForget", "chunk"], ["tileState", "grid"],
  ["track", "building"], ["track", "pool"], ["_onDispose", "building"], ["_onInstDel", "chunk"],
  ["_onMatrix", "atlas"], ["_onGid", "pool"], ["_onOptimize", "chunk"],
  ["_onVis", "chunk"], ["_onGeomAdd", "chunk"], ["_onGeomDel", "chunk"], ["_onInstAdd", "pool"],
  // `_onCount` is checked directly in M5: the producers only grow a full batch
  // (no free ids), so three's trailing-free-id pop never fires in a scenario.
];
for (const [hook, scen] of MUTANTS) {
  const r = await S.runScenario(scen, { kernel: new WorldModel(), mutate: (b) => { b[hook] = () => {}; } });
  const total = sum(r.checkpoints, mm) + sum(r.checkpoints, integ);
  check(`M4 without ${hook} (${scen}) the shadow fails`, total > 0, `${sum(r.checkpoints, mm)} mismatches, ${sum(r.checkpoints, integ)} integrity`);
}

// ── M5 foreign writers, film, cell PVS ──────────────────────────────────────

/**
 * The kernel rules no scenario reaches (lane W review r2, 2026-10-29), driven
 * through the bridge on `makeKernel()`: the JS model here in M5, the compiled
 * SceneWorld in W (so the Rust decoder and rules answer the same checks).
 *   - the cell PVS delta (CELL_PVS, cells.js tickCellVisibility3D) and its
 *     audit section (SEC_CELLS, category `cells`), both directions;
 *   - a late `track` of a populated object (GEOM_SNAP / INST_SNAP): three's
 *     tables and free lists carried over, so the freed ids come back first;
 *   - LRU_DROP_POOL (landblock_lru.js _discardStalePoolCopy): it ends the
 *     entries-AND-parkPool dual state with the landblock LIVE.
 */
function unpinnedRuleChecks(tag, makeKernel) {
  const kernel = makeKernel();
  const census = () => JSON.parse(kernel.census());
  const b = W.armRustWorld({ kernel, periodic: false });
  // The cell PVS delta.
  const s3 = { _lastCellVisibleSet: new Set([1, 2, 3]) };
  b.cellPvs(s3, new Set([1, 2, 3]), new Set());
  let r = b.audit();
  check(`${tag} the cell PVS delta round-trips`, r.mismatches === 0 && census().cells === 3, JSON.stringify(r.report.last.cat));
  b.cellPvs(s3, new Set([2, 4]), s3._lastCellVisibleSet);
  s3._lastCellVisibleSet = new Set([2, 4]);
  r = b.audit();
  check(`${tag} …entering and leaving cells`, r.mismatches === 0 && census().cells === 2);
  s3._lastCellVisibleSet.add(9); // rolled forward without the hook
  r = b.audit();
  check(`${tag} …and a missed delta is caught`, r.mismatches === 1 && r.report.last.cat.cells === 1);
  s3._lastCellVisibleSet.delete(9);
  b.cellPvs(s3, new Set([2, 4, 7]), s3._lastCellVisibleSet); // posted, but the JS set never rolled forward
  r = b.audit();
  check(`${tag} …and a delta the JS did not apply is caught (kernel-only cell)`, r.mismatches === 1 && r.report.last.cat.cells === 1 && census().cells === 3,
    JSON.stringify(r.report.last.cat));
  s3._lastCellVisibleSet.add(7);
  r = b.audit();
  check(`${tag} …and agrees again once it has`, r.mismatches === 0);
  // A late track of a populated object: GEOM_SNAP / INST_SNAP.
  const bm = new THREE.BatchedMesh(8, 256, 512, new THREE.MeshBasicMaterial());
  const box = new THREE.BoxGeometry(1, 1, 1);
  const g0 = bm.addGeometry(box), g1 = bm.addGeometry(box), g2 = bm.addGeometry(box);
  const ids = [bm.addInstance(g0), bm.addInstance(g1), bm.addInstance(g0), bm.addInstance(g2)];
  bm.setVisibleAt(ids[3], false);
  bm.setMatrixAt(ids[2], new THREE.Matrix4().makeTranslation(1, 2, 3));
  bm.deleteInstance(ids[1]); // a free instance id
  bm.deleteGeometry(g1); // a free geometry id (no instance left on it)
  b.track(bm, "chunk"); // late: snapshots of both tables, then the matrices
  r = b.audit({ matrices: true });
  check(`${tag} a late-tracked populated object is snapshotted (GEOM_SNAP / INST_SNAP): 0 mismatches, 0 integrity`,
    r.mismatches === 0 && r.report.integrityTotal === 0 && census().active === 3 && census().visible === 2 && census().geometries === 2,
    `${JSON.stringify(r.report.last.cat)} ${kernel.census()}`);
  const nid = bm.addInstance(g0);
  const ngid = bm.addGeometry(box);
  r = b.audit({ matrices: true });
  check(`${tag} …with three's free lists: the freed instance and geometry ids come back first, predicted`,
    nid === ids[1] && ngid === g1 && r.mismatches === 0 && r.report.integrityTotal === 0, `${nid} ${ngid} ${JSON.stringify(r.report.integrity)}`);
  bm.dispose();
  // LRU_DROP_POOL: a track while parked leaves the landblock in entries AND
  // parkPool (counted trackWhileParked); the stale pool copy's drop ends it LIVE.
  const lru = { entries: new Map(), parkPool: new Map() };
  const L = 0x10100000;
  lru.entries.set(L, {}); b.lruTrack(lru, L, false);
  lru.entries.delete(L); lru.parkPool.set(L, {}); b.lruPark(lru, L);
  r = b.audit();
  check(`${tag} LRU track / park audit clean`, r.mismatches === 0 && r.report.integrityTotal === 0);
  lru.entries.set(L, {}); b.lruTrack(lru, L, false);
  r = b.audit();
  check(`${tag} …a track while parked: the dual state is a trackWhileParked + an lru mismatch`,
    r.report.integrity.trackWhileParked === 1 && r.report.last.cat.lru === 1, JSON.stringify(r.report.last.cat));
  lru.parkPool.delete(L); b.lruDropPool(lru, L);
  r = b.audit();
  check(`${tag} …LRU_DROP_POOL ends it: the landblock LIVE, the audit clean`,
    r.mismatches === 0 && JSON.parse(kernel.census()).lru.live === 1 && JSON.parse(kernel.census()).lru.parked === 0, kernel.census());
  W.disarmRustWorld();
  return kernel;
}

/** The same sequence on the JS model with checks muted (W's census reference). */
function unpinnedRuleChecksQuiet() {
  const log = console.log;
  const [p0, f0] = [passed, failed];
  console.log = () => {};
  try { return unpinnedRuleChecks("(ref)", () => new WorldModel()); } finally { console.log = log; passed = p0; failed = f0; }
}

console.log("rustWorld — M5: foreign writes, film watches, the cell PVS delta");
{
  const model = new WorldModel();
  const b = W.armRustWorld({ kernel: model, periodic: false });
  const bm = new THREE.BatchedMesh(8, 64, 128, new THREE.MeshBasicMaterial());
  b.track(bm, "chunk");
  const g = new THREE.BoxGeometry(1, 1, 1);
  const gid = bm.addGeometry(g);
  const ids = [bm.addInstance(gid), bm.addInstance(gid), bm.addInstance(gid)];
  for (const id of ids) b.attrLb(bm, id, 0x10100000);
  let r = b.audit({ matrices: true });
  check("M5 a fresh tracked object audits clean", r.mismatches === 0, JSON.stringify(r.report.last.cat));
  bm.setVisibleAt(ids[1], false); // nobody's seam: a foreign write
  r = b.audit();
  check("M5 a foreign setVisibleAt is a model mismatch, explained by the raw mirror",
    r.mismatches === 1 && r.report.last.cat.vis === 1 && r.report.last.cat.raw === 0, JSON.stringify(r.report.last.cat));
  bm.setVisibleAt(ids[1], true);
  // film/runtime/take_player.js watchBatch: an OWN setVisibleAt over ours.
  const orig = bm.setVisibleAt;
  bm.setVisibleAt = function (id, v) { return orig.call(this, id, v); };
  bm.setVisibleAt(ids[0], false);
  r = b.audit();
  check("M5 a film-held object is skipped while the watch is installed", r.mismatches === 0 && r.report.last.skipped === 1 && b.stats.filmHeld === 1);
  delete bm.setVisibleAt;
  bm.setVisibleAt(ids[0], true);
  r = b.audit();
  check("M5 …and compared again once released", r.mismatches === 0 && r.report.last.skipped === 0);
  // three r184 setInstanceCount drops trailing free ids; the kernel mirrors it.
  const big = new THREE.BatchedMesh(4, 64, 128, new THREE.MeshBasicMaterial());
  b.track(big, "chunk");
  const bg = big.addGeometry(new THREE.BoxGeometry(1, 1, 1));
  const bi = [0, 1, 2, 3].map(() => big.addInstance(bg));
  big.deleteInstance(bi[3]);
  big.deleteInstance(bi[2]);
  big.deleteInstance(bi[0]);
  big.setInstanceCount(8);
  r = b.audit();
  check("M5 setInstanceCount's trailing pop is mirrored (2 slots left, id 0 free)",
    r.mismatches === 0 && big._instanceInfo.length === 2 && big.addInstance(bg) === 0 && b.audit().mismatches === 0, JSON.stringify(r.report.last.cat));
  b._onCount = () => {};
  big.deleteInstance(1);
  big.deleteInstance(0);
  big.setInstanceCount(8);
  r = b.audit();
  check("M5 …and without the INST_COUNT event the slot table is out of step", r.report.last.cat.slotsLen === 1, JSON.stringify(r.report.last.cat));
  delete b._onCount;
  big.dispose();
  // Disposal and collection.
  bm.dispose();
  r = b.audit();
  check("M5 a disposed object leaves the kernel", r.mismatches === 0 && JSON.parse(model.census()).objects === 0);
  // An untracked shadow-kind object in a scene the bridge knows of.
  const sg = new THREE.Group();
  const lone = new THREE.BatchedMesh(4, 16, 32, new THREE.MeshBasicMaterial());
  lone.userData = { __staticBatchCrossLb: true };
  sg.add(lone);
  b.objrHide({ staticsGroup: sg, _objRadius: { hidden: new Set([0x30300000]) } }, 0x30300000);
  r = b.audit();
  check("M5 a shadow-kind BatchedMesh nobody tracked is counted untracked", r.report.last.cat.untracked === 1, JSON.stringify(r.report.last.cat));
  W.disarmRustWorld();
}
unpinnedRuleChecks("M5", () => new WorldModel());
{
  // The periodic audit's window: objects outside it are deferred (neither
  // compared nor reported missing); the next window picks up where it stopped.
  const model = new WorldModel();
  const b = W.armRustWorld({ kernel: model, periodic: false });
  const mat = new THREE.MeshBasicMaterial();
  const box = new THREE.BoxGeometry(1, 1, 1);
  const objs = [];
  for (let k = 0; k < 4; k++) {
    const bm = new THREE.BatchedMesh(64, 64, 128, mat);
    b.track(bm, "chunk");
    const g = bm.addGeometry(box);
    for (let i = 0; i < 10; i++) bm.addInstance(g);
    objs.push(bm);
  }
  objs[3].setVisibleAt(0, false); // a foreign write in the last object
  const r1 = b.audit({ windowSlots: 20 });
  const r2 = b.audit({ windowSlots: 20 });
  const r3 = b.audit();
  check("M5 windowed audits: deferred objects are neither compared nor missing; the next window catches the write",
    r1.mismatches === 0 && r1.report.last.cat.missingObject === 0 && r2.mismatches === 1 && r2.report.last.cat.vis === 1 && r3.mismatches === 1,
    `${r1.mismatches} / ${r2.mismatches} / ${r3.mismatches}`);
  W.disarmRustWorld();
}

// ── M6 flags, stale pkg, census ─────────────────────────────────────────────
console.log("rustWorld — M6: flag grammar, the stale-pkg disarm, the S0 census");
{
  check("M6 not armed in node by default (no window flag)", globalThis.__hbRustWorld === undefined && W.rustWorldBridge() === null);
  const saved = globalThis.location;
  const read = (search) => {
    globalThis.location = { search };
    core.__setRustFlagForTest("rustWorld", undefined);
    W.__setRustWorldFlagForTest(null);
    return W.rustWorldEnabled();
  };
  check("M6 ?rustWorld default OFF", read("") === false && read("?rustWorld") === false && read("?other=on") === false);
  check("M6 ?rustWorld=on / 1 / true / yes arm it", ["on", "1", "true", "yes", "ON"].every((v) => read(`?rustWorld=${v}`) === true));
  check("M6 ?rustWorld=off / 0 escapes", read("?rustWorld=off") === false && read("?rustWorld=0") === false);
  globalThis.location = saved;
  core.__setRustFlagForTest("rustWorld", undefined);
  W.__setRustWorldFlagForTest(null);

  // A booted pkg without SceneWorld: the auto kernel disarms itself, warned once.
  const warns = [];
  const w0 = console.warn;
  console.warn = (...x) => warns.push(x.join(" "));
  core.__setSceneWasmForTest({ sceneCoreAbi: () => core.SCENE_CORE_ABI }, { buffer: new ArrayBuffer(0) });
  const b = W.armRustWorld({ periodic: false });
  const bm = new THREE.BatchedMesh(4, 64, 128, new THREE.MeshBasicMaterial());
  b.track(bm, "chunk");
  b.flush();
  console.warn = w0;
  check("M6 a pkg without SceneWorld disarms the bridge (one warning), the object keeps working",
    W.rustWorldBridge() === null && globalThis.__hbRustWorld === undefined && warns.length === 1 && /SceneWorld/.test(warns[0]) &&
    bm.addGeometry(new THREE.BoxGeometry(1, 1, 1)) === 0 && bm.addInstance(0) === 0, warns.join(" | "));
  core.__setSceneWasmForTest(null, null);

  // The happy path of the same lookup: a booted pkg WITH the class (the model
  // stands in for the compiled SceneWorld) is found, abi-checked and used.
  const memory = { buffer: new ArrayBuffer(0) };
  core.__setSceneWasmForTest({ sceneCoreAbi: () => core.SCENE_CORE_ABI, SceneWorld: WorldModel }, memory);
  const b2 = W.armRustWorld({ periodic: false });
  const bm2 = new THREE.BatchedMesh(4, 64, 128, new THREE.MeshBasicMaterial());
  b2.track(bm2, "chunk");
  bm2.addInstance(bm2.addGeometry(new THREE.BoxGeometry(1, 1, 1)));
  const r2 = b2.audit({ matrices: true });
  check("M6 a pkg with SceneWorld: the bridge finds it, checks abi() and audits through it",
    W.rustWorldBridge() === b2 && b2._kernelState === 1 && b2._kernel instanceof WorldModel && r2 && r2.mismatches === 0 &&
    JSON.parse(b2._kernel.census()).active === 1, JSON.stringify(r2 && r2.report && r2.report.last.cat));
  W.disarmRustWorld();
  // …and one whose abi() differs is refused (stale pkg), warned once. Like the
  // wasm-bindgen glue, a freed StaleWorld throws on any later call
  // ("Attempt to use a moved value"), so the warning must not re-read abi().
  class StaleWorld extends WorldModel {
    free() { this._freed = true; }
    abi() { if (this._freed) throw new Error("Attempt to use a moved value"); return 99; }
  }
  const warns2 = [];
  console.warn = (...x) => warns2.push(x.join(" "));
  core.__setSceneWasmForTest({ sceneCoreAbi: () => core.SCENE_CORE_ABI, SceneWorld: StaleWorld }, memory);
  const b3 = W.armRustWorld({ periodic: false });
  b3.track(new THREE.BatchedMesh(4, 64, 128, new THREE.MeshBasicMaterial()), "chunk");
  b3.flush();
  console.warn = w0;
  check("M6 a SceneWorld with another abi() is refused: the bridge disarms, warned once",
    W.rustWorldBridge() === null && warns2.length === 1 && /abi 99 vs/.test(warns2[0]), warns2.join(" | "));
  core.__setSceneWasmForTest(null, null);

  // Boot order: events posted before the pkg booted are buffered (no kernel,
  // no namespace yet), then applied in order once SceneWorld appears.
  const b4 = W.armRustWorld({ periodic: false });
  const bm4 = new THREE.BatchedMesh(4, 64, 128, new THREE.MeshBasicMaterial());
  b4.track(bm4, "chunk");
  const g4 = bm4.addGeometry(new THREE.BoxGeometry(1, 1, 1));
  bm4.addInstance(g4);
  const early = b4.flush();
  const queued = b4._n;
  core.__setSceneWasmForTest({ sceneCoreAbi: () => core.SCENE_CORE_ABI, SceneWorld: WorldModel }, memory);
  bm4.addInstance(g4);
  const r4 = b4.audit();
  check("M6 pre-boot events are buffered, then applied in order once the pkg boots",
    early === 0 && queued > 0 && W.rustWorldBridge() === b4 && b4._kernelState === 1 && r4 && r4.mismatches === 0 &&
    JSON.parse(b4._kernel.census()).active === 2 && b4.stats.kernelErrors === 0, `${early} / ${queued} / ${r4 && r4.mismatches}`);
  W.disarmRustWorld();
  core.__setSceneWasmForTest(null, null);

  // The periodic audit (what a browser arm runs): it audits on its own about
  // once a second, and disarming stops it.
  const b5 = W.armRustWorld({ kernel: new WorldModel(), periodic: true });
  const bm5 = new THREE.BatchedMesh(4, 64, 128, new THREE.MeshBasicMaterial());
  b5.track(bm5, "chunk");
  bm5.addInstance(bm5.addGeometry(new THREE.BoxGeometry(1, 1, 1)));
  await new Promise((res) => setTimeout(res, 1150));
  const audited = b5.stats.audits;
  W.disarmRustWorld();
  await new Promise((res) => setTimeout(res, 1100));
  check("M6 the 1 Hz audit runs by itself (0 mismatches) and stops when disarmed",
    audited >= 1 && b5.stats.audits === audited && b5.stats.mismatches === 0 && b5._timer === null, `${audited} / ${b5.stats.audits}`);

  // S0: the per-group census over a small known scene.
  const s3 = { scene: new THREE.Scene(), worldRoot: new THREE.Group() };
  s3.scene.add(s3.worldRoot);
  for (const n of ["terrainGroup", "buildingsGroup", "staticsGroup", "cellsGroup", "entitiesGroup"]) { s3[n] = new THREE.Group(); s3.worldRoot.add(s3[n]); }
  const geo = new THREE.BoxGeometry(1, 1, 1), mat = new THREE.MeshBasicMaterial();
  const lod = new THREE.LOD(); lod.userData = { billboardMode: 2 }; lod.addLevel(new THREE.Mesh(geo, mat), 0); lod.addLevel(new THREE.Mesh(geo, mat), 50);
  s3.staticsGroup.add(lod, new THREE.Mesh(geo, mat));
  const hidden = new THREE.Mesh(geo, mat); hidden.visible = false; s3.staticsGroup.add(hidden);
  const anchor = new THREE.Group(); anchor.userData = { isStaticScriptAnchor: true, __anchorFrozen: true }; anchor.matrixAutoUpdate = false; s3.staticsGroup.add(anchor);
  const chunk = new THREE.BatchedMesh(4, 64, 128, mat); chunk.userData = { __staticBatchCrossLb: true };
  const cg = chunk.addGeometry(geo); chunk.addInstance(cg); const i1 = chunk.addInstance(cg); chunk.setVisibleAt(i1, false);
  s3.staticsGroup.add(chunk);
  const inst = new THREE.InstancedMesh(geo, mat, 5); s3.entitiesGroup.add(inst);
  const roots = new Map([[0x10100000, new THREE.Group()]]);
  const offA = new THREE.Group(); offA.userData = { isStaticScriptAnchor: true }; roots.get(0x10100000).add(offA);
  s3.staticsGroup.userData = { __anchorRoots: roots };
  const c = W.worldGroupCensus(s3);
  const st = c.groups.statics;
  check("M6 census: statics resident / visited / composing / frozen",
    // group, LOD + 2 levels, mesh, hidden mesh, frozen anchor, chunk bucket = 8; the hidden mesh is not visited
    st.resident === 8 && st.visited === 7 && st.frozen === 1 && st.composing === 6 && st.composingAll === 7, JSON.stringify(st));
  check("M6 census: LODs (billboard-tagged), anchors, singletons, chunk instances",
    st.lods === 1 && st.billboardLods === 1 && st.anchors === 1 && st.anchorsFrozen === 1 && st.singletonMeshes === 4 &&
    st.batched.chunk.objects === 1 && st.batched.chunk.instances === 2 && st.batched.chunk.visibleInstances === 1 && st.batched.chunk.geometries === 1,
    JSON.stringify(st));
  check("M6 census: entities, off-graph anchors, totals", c.groups.entities.instancedMeshes === 1 && c.groups.entities.instancedInstances === 5 &&
    c.groups.offGraphAnchors.anchors === 1 && c.groups.offGraphAnchors.visited === 0 && c.total.anchors === 2, JSON.stringify(c.groups.offGraphAnchors));
  check("M6 census published for frame_split.js", globalThis.__hbWorldGroupCensus === W.worldGroupCensus);
  const fs = await import("../scene3d/frame_split.js");
  globalThis.window.liveScene3d = s3;
  const fc = fs.frameSplitCensus(s3.scene);
  delete globalThis.window.liveScene3d;
  check("M6 frameSplitCensus().groups carries the per-group census", fc.groups && fc.groups.groups && fc.groups.groups.statics.resident === 8);
}

// ── W: the compiled SceneWorld ──────────────────────────────────────────────
console.log(`rustWorld — W: the compiled SceneWorld from ${pkgDir}/`);
let ns = null;
try {
  ns = await import(join(app, pkgDir, "holtburger_web.js"));
  await ns.default({ module_or_path: readFileSync(join(app, pkgDir, "holtburger_web_bg.wasm")) });
} catch (e) {
  ns = null;
  console.log(`rust world shadow: SKIP — wasm pkg ${pkgDir}/ not loadable in Node: ${String(e.message).slice(0, 120)}`);
}
if (ns && typeof ns.SceneWorld !== "function") {
  console.log(`rust world shadow: SKIP — ${pkgDir}/ has no SceneWorld (predates lane W); rebuild with wasm-pack`);
  ns = null;
}
if (ns) {
  const probe = new ns.SceneWorld();
  check("W abi matches the bridge", (probe.abi() >>> 0) === W.WORLD_ABI, `${probe.abi()} vs ${W.WORLD_ABI}`);
  probe.free?.();
  for (const name of NAMES) {
    const k = new ns.SceneWorld();
    const r = await S.runScenario(name, { kernel: k });
    const bad = r.checkpoints.filter((cp) => mm(cp) !== 0 || integ(cp) !== 0);
    check(`W ${name}: every checkpoint audits 0 / 0 through the compiled kernel`, bad.length === 0,
      bad.length ? `${bad[0].label}: ${JSON.stringify(bad[0].audit && bad[0].audit.report && bad[0].audit.report.last)}` : "");
    let cdiff = null;
    for (let i = 0; i < r.checkpoints.length; i++) {
      if (JSON.stringify(r.checkpoints[i].census) !== JSON.stringify(armed[name].checkpoints[i].census)) { cdiff = r.checkpoints[i].label; break; }
    }
    check(`W ${name}: the compiled kernel's census equals the model's at every checkpoint`, cdiff === null, cdiff || "");
    k.free?.();
  }
  // The cargo fixtures, through the wasm kernel too.
  const fx = join(app, "..", "..", "crates", "holtburger-scene", "tests", "fixtures");
  const files = existsSync(fx) ? readdirSync(fx).filter((f) => /^world_.*\.json$/.test(f)) : [];
  const { decodeWorldValues } = await import("../tools/rust_parity/gen_world.mjs");
  for (const f of files) {
    const j = JSON.parse(readFileSync(join(fx, f), "utf8"));
    const ev = decodeWorldValues(j.events);
    const k = new ns.SceneWorld();
    let prev = 0, bad = null;
    for (const cp of j.checkpoints) {
      const n = k.apply(ev.subarray(prev, cp.events_end));
      prev = cp.events_end;
      const m = k.audit(decodeWorldValues(cp.arena));
      if (n < 0 || m !== cp.mismatches) { bad = `${cp.label}: apply ${n}, audit ${m} (want ${cp.mismatches})`; break; }
    }
    check(`W fixture ${f} replays through the compiled kernel`, bad === null, bad || `${j.checkpoints.length} checkpoints`);
    k.free?.();
  }
  // M5's unpinned rules (CELL_PVS / SEC_CELLS, GEOM_SNAP / INST_SNAP,
  // LRU_DROP_POOL) through the compiled kernel, census compared with the model's.
  const kw = unpinnedRuleChecks("W", () => new ns.SceneWorld());
  const km = unpinnedRuleChecksQuiet();
  const norm = (c) => JSON.stringify(JSON.parse(c));
  check("W the unpinned rules leave the compiled kernel's census equal to the model's", norm(kw.census()) === norm(km.census()), `${kw.census()} vs ${km.census()}`);
  kw.free?.();
  // The poolHideOrphan cross-check (2026-10-29) through the compiled kernel.
  {
    const k = new ns.SceneWorld();
    const cat = JSON.parse(k.report()).last.cat || {};
    if (!("poolHideOrphan" in cat)) {
      console.log(`  [SKIP] W objrPool pre-fix drift: ${pkgDir}/ predates the poolHideOrphan category (2026-10-29) — rebuild the pkg; then these lines must PASS`);
    } else {
      const r = await S.runScenario("objrPool", { kernel: k, opts: { preFixForget: true } });
      const got = r.checkpoints.map(orphanOf).join(" "), want = preFix.checkpoints.map(orphanOf).join(" ");
      check("W objrPool pre-fix drift: the compiled kernel counts poolHideOrphan exactly as the model, checkpoint by checkpoint",
        got === want && preFix.checkpoints.some((cp) => orphanOf(cp) > 0), `${got} vs ${want}`);
    }
    k.free?.();
  }
}

console.log(`\nrust world shadow: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
