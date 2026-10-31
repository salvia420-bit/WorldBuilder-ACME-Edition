// tests/interior_batch_budget.test.mjs — R3-5 `?interiorBatch` per-sync CPU
// budget (scene3d/gpu_batch/interior_batch.js; design §2.4 "CPU", rework 1).
// A dungeon arrival must not plan a whole landblock, set up every class or
// merge a whole ~1 MiB chunk in ONE sync: planning, class-material set-up and
// merging share `?interiorBatchMergeMs` (default 2 ms), each one unit at
// least per sync (a cell, a new class, a merged entry). Driven through the
// module's clock seam (`__setInteriorBatchEnvForTest({ now })`), so the
// slicing is deterministic on any machine.
//
//   P1  planning is sliced: a 120-cell landblock (real cells.js build, real
//       MaterialCache members) with a clock that advances 0.25 ms a read
//       plans at most 9 cells a sync over several syncs (status "planning"
//       in between), and the finished plan (census, chunks, cell order,
//       every entry's batch key) is the plan of a frozen-clock world.
//   P2  merging is sliced: the chunk's ticket is charged ONCE, before the
//       merge, for exactly the bytes the merge then allocates; the merge runs
//       over several syncs (at most 9 entries a sync) with no batch object in
//       the scene and legacy drawing; the sync that finishes adds every
//       object; the batch geometries equal the frozen-clock world's bytes.
//   P3  one unit a sync when every clock read is past the budget (the
//       four-cell fixture, 3 ms a read): <= 1 cell planned, <= 1 new class
//       entry, <= 1 program warm (a class compile or the depth warm), <= 1
//       merged entry per sync, and the result is still the frozen-clock
//       result; the chunk activates.
//   P4  the per-member caches: planning the 120-cell landblock asks each
//       member's program key function at most once (the shared members of
//       many cells), and interiorTextureInfo re-describes a texture on a
//       version bump / new image / UV transform change only.
//   P5  (informational) real clock, default budget: the largest plan /
//       merge slice and sync of the 120-cell landblock's arrival.
//
// Run: node tests/interior_batch_budget.test.mjs   (needs `three` resolvable)

import assert from "node:assert/strict";
import * as THREE from "three";
import * as R from "./interior_batch_rig.mjs";

globalThis.window ??= {};
globalThis.location = { search: R.BASE_SEARCH };
globalThis.window.location = globalThis.location;
globalThis.window.requestAnimationFrame ??= () => 1;

const M = await import("../scene3d/materials.js");
const adapter = await import("../scene3d/adapter.js");
const KIT = await import("../scene3d/gpu_batch/kit.js");
const IB = await import("../scene3d/gpu_batch/interior_batch.js");
const { LandblockLRU } = await import("../scene3d/landblock_lru.js");
const deps = { M, adapter };
const cellsOn = await R.loadCells("interiorBatch=on");

let failures = 0;
let passes = 0;
async function t(name, fn) {
  try { await fn(); passes++; console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name); console.log(e); }
}

const N = 120;
const BIG = R.bigTable(N);
const BIG_IDS = Object.keys(BIG).map((n) => R.CELL(+n));
const stepClock = (ms) => { let t = 0; return () => (t += ms); };

async function world(now, { table = BIG, ids = BIG_IDS, mergeMs = 2 } = {}) {
  KIT.resetKit();
  IB.disposeInteriorBatches();
  IB.__setInteriorBatchEnvForTest({ mode: "on", now, mergeMs });
  const w = await R.makeWorld(deps);
  const lru = new LandblockLRU({ scene3d: w.scene3d, maxResident: 64, getCurrentLbId: () => 0 });
  w.scene3d.landblockLru = lru;
  lru.track(R.LB);
  await R.build(cellsOn, w, table === R.CELLS ? {} : { table });
  w.state = { player: (R.LB | 0x31) >>> 0, indoor: false, frustum: ids.slice(), walk: [], bfs: [] };
  w.sh = R.makeSession(w.state);
  return w;
}
const S = () => IB.__interiorBatchStateForTest();
const rec = () => S().lbs.get(R.LB);
const chunk = () => rec().chunks[0];
const tick = (w) => R.tick(cellsOn, w, w.sh);
const batchDraws = (recs) => recs.filter((r) => r.object.userData?.interiorBatch).length;
const legacyDraws = (recs) => recs.filter((r) => /^(surfaces-fused-opaque|cellstatic-)/.test(r.object.name)).length;
const mergedEntries = (ch) => {
  let n = 0;
  for (let k = 0; k < ch.batches.length; k += 1) {
    const b = ch.batches[k];
    if (k < ch.mergeAt) n += b.entries.length;
    else if (b.job) n += b.job.k;
  }
  return n;
};

/** Plan + chunk keys + batch bytes of the live state (comparable across worlds). */
function snapshot() {
  const r = rec();
  const ch = r.chunks.map((c) => ({
    status: c.status,
    cells: c.cellPlans.map((cp) => cp.cell.cellId),
    batches: c.batches.map((b) => ({
      key: b.key.replace(/\|p\d+\|(\d+|-)$/, ""),
      entries: b.entries.map((e) => `${e.mesh.name}:${e.start}:${e.count}`),
      position: b.geometry ? Array.from(b.geometry.attributes.position.array) : null,
      normal: b.geometry ? Array.from(b.geometry.attributes.normal.array) : null,
      uv: b.geometry ? Array.from(b.geometry.attributes.uv.array) : null,
      index: b.geometry ? Array.from(b.geometry.index.array) : null,
      cells: b.geometry ? Array.from(b.geometry.attributes.hbIbCell.array, (c) => c % 4096) : null,
      bytes: b.cpuBytes,
    })),
  }));
  return { plan: JSON.parse(JSON.stringify(r.plan)), chunks: ch };
}

async function frozenReference(table, ids) {
  const w = await world(R.FROZEN_CLOCK, { table, ids });
  for (let f = 0; f < 4; f += 1) { tick(w); R.renderPass(w, R.MASK_BOTH); }
  assert.equal(chunk().status, "active", "premise: the frozen-clock world activates in its first frames");
  return snapshot();
}

const refBig = await frozenReference(BIG, BIG_IDS);

// --- P1 + P2 -------------------------------------------------------------------
let p2World = null;
await t("P1 planning: a 120-cell landblock plans over several syncs, <= 9 cells a sync, to the frozen-clock plan", async () => {
  const w = await world(stepClock(0.25));
  assert.equal(rec().status, "pending");
  tick(w);
  assert.equal(rec().status, "planning", "the first sync did not plan the whole landblock");
  const perSync = [rec().planning.i];
  let guard = 0;
  while (rec().status === "planning" && guard++ < 400) {
    const before = rec().planning.i;
    tick(w);
    perSync.push(rec().status === "planning" ? rec().planning.i - before : N - before);
  }
  assert.equal(rec().status, "planned");
  assert.ok(perSync.length > 3, `planned over ${perSync.length} syncs`);
  assert.ok(perSync.every((n) => n >= 1 && n <= 9), `cells per sync: ${perSync.join(",")}`);
  assert.ok(S().stats.planSlices >= perSync.length);
  assert.deepEqual(JSON.parse(JSON.stringify(rec().plan)), refBig.plan, "the census of a one-shot plan");
  assert.deepEqual(chunk().cellPlans.map((cp) => cp.cell.cellId), refBig.chunks[0].cells);
  p2World = w;
});

await t("P2 merging: one ticket charged before the merge, the merge spread over syncs with legacy drawing, objects added at once, frozen-clock bytes", async () => {
  const w = p2World;
  assert.ok(w, "premise: P1 ran");
  const budget = KIT.kitBudget();
  let guard = 0;
  while (chunk().status !== "merging" && chunk().status !== "overlap" && guard++ < 400) tick(w);
  assert.equal(chunk().status, "merging", "the chunk entered the sliced merge");
  const total = chunk().batches.reduce((n, b) => n + b.entries.length, 0);
  assert.ok(total > 200, `premise: a big chunk (${total} entries)`);
  const charged = budget.stats.byKind.geometry;
  assert.ok(chunk().ticket && charged >= chunk().bytes && chunk().bytes > 0, "charged when the merge started");
  const perSync = [mergedEntries(chunk())];
  let sawLegacyOnly = false;
  guard = 0;
  while (chunk().status === "merging" && guard++ < 2000) {
    assert.ok(chunk().batches.every((b) => !b.mesh), "no batch object before the merge completes");
    assert.ok(!rec().group || rec().group.children.length === 0, "nothing in the scene");
    if (!sawLegacyOnly && guard % 25 === 1) {
      const recs = R.renderPass(w, R.MASK_BOTH);
      assert.equal(batchDraws(recs), 0);
      assert.ok(legacyDraws(recs) > 0, "legacy keeps drawing while the merge runs");
      sawLegacyOnly = true;
    }
    const before = mergedEntries(chunk());
    tick(w);
    if (chunk().status === "merging") perSync.push(mergedEntries(chunk()) - before);
  }
  assert.ok(sawLegacyOnly);
  assert.equal(chunk().status, "overlap", "the finishing sync added the objects");
  assert.ok(perSync.length > 3, `merged over ${perSync.length} syncs`);
  assert.ok(perSync.every((n) => n >= 0 && n <= 9), `entries per sync: ${perSync.join(",")}`);
  assert.equal(budget.stats.byKind.geometry, charged, "charged once (no second spend at the add)");
  assert.ok(chunk().batches.every((b) => b.mesh && b.mesh.parent === rec().group), "every object added in that sync");
  let alloc = 0;
  for (const b of chunk().batches) {
    for (const a of Object.values(b.geometry.attributes)) alloc += a.array.byteLength;
    alloc += b.geometry.index.array.byteLength;
  }
  assert.equal(alloc, chunk().bytes, "the ticket = the allocation");
  for (let f = 0; f < 3; f += 1) { tick(w); R.renderPass(w, R.MASK_BOTH); }
  assert.equal(chunk().status, "active");
  const snap = snapshot();
  assert.deepEqual(snap.chunks.map((c) => c.batches), refBig.chunks.map((c) => c.batches), "the same geometry bytes as the one-shot merge");
  assert.ok(S().stats.mergeSlices >= perSync.length);
});

// --- P3 --------------------------------------------------------------------------
await t("P3 every clock read past the budget: one cell / one new class / one merged entry a sync; the frozen-clock result", async () => {
  const ref = await frozenReference(R.CELLS, R.CELL_IDS);
  const w = await world(stepClock(3), { table: R.CELLS, ids: R.CELL_IDS });
  let classes = 0, planned = 0;
  let guard = 0;
  let maxClass = 0, maxMerge = 0, maxPlan = 0, maxWarm = 0;
  while ((!rec().chunks.length || chunk().status !== "active") && guard++ < 300) {
    const p0 = rec().planning ? rec().planning.i : (rec().status === "pending" ? 0 : R.CELL_IDS.length);
    const c0 = S().classMats.size;
    const w0 = S().stats.classWarms + S().stats.depthWarms;
    const m0 = rec().chunks.length ? mergedEntries(chunk()) : 0;
    const wasMerging = rec().chunks.length && chunk().status === "merging";
    tick(w);
    R.renderPass(w, R.MASK_BOTH);
    const p1 = rec().planning ? rec().planning.i : (rec().status === "pending" ? 0 : R.CELL_IDS.length);
    maxPlan = Math.max(maxPlan, p1 - p0);
    maxClass = Math.max(maxClass, S().classMats.size - c0);
    maxWarm = Math.max(maxWarm, S().stats.classWarms + S().stats.depthWarms - w0);
    if (wasMerging && chunk().status === "merging") maxMerge = Math.max(maxMerge, mergedEntries(chunk()) - m0);
    planned += p1 - p0; classes += Math.max(0, S().classMats.size - c0);
  }
  assert.equal(chunk().status, "active", `active after ${guard} syncs`);
  assert.equal(maxPlan, 1, "one cell a sync");
  assert.equal(maxClass, 1, "one new class entry a sync");
  assert.equal(maxWarm, 1, "one program warm (class compile or depth warm) a sync");
  assert.ok(S().stats.classWarms >= 2, `premise: several class programs warmed (${S().stats.classWarms})`);
  assert.ok(maxMerge <= 1, `one merged entry a sync (${maxMerge})`);
  assert.ok(classes >= 3 && planned === R.CELL_IDS.length, `premise: ${classes} classes, ${planned} cells`);
  assert.deepEqual(snapshot().chunks.map((c) => c.batches), ref.chunks.map((c) => c.batches), "same result as the frozen clock");
});

// --- P4 --------------------------------------------------------------------------
await t("P4 caches: one program-key call per member while planning 120 cells; texture info re-describes only on change", async () => {
  const w = await world(R.FROZEN_CLOCK);
  const members = new Set();
  for (const c of w.scene3d.cellContainers3d.values()) {
    c.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        // Members with their own key function (every MaterialCache member: the chain + key pair).
        if (m && m.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey) members.add(m);
      }
    });
  }
  let calls = 0;
  for (const m of members) {
    const f = m.customProgramCacheKey;
    m.customProgramCacheKey = function counted() { calls += 1; return f.call(this); };
  }
  tick(w); // plan + admit + classes + merge, one sync (frozen clock)
  assert.equal(rec().status, "planned");
  assert.ok(rec().plan.eligible.cells + rec().plan.eligible.props > 300, "premise: hundreds of ranges");
  assert.ok(calls <= members.size, `${calls} key calls for ${members.size} members`);
  const tex = adapter.surfacePixelsToTexture(new Uint8Array(8 * 8 * 4).fill(3), 8, 8);
  const a = IB.interiorTextureInfo(tex);
  assert.ok(a.desc && a.pageKey, "describable");
  assert.equal(IB.interiorTextureInfo(tex), a, "cached");
  tex.needsUpdate = true;
  const b = IB.interiorTextureInfo(tex);
  assert.notEqual(b, a, "re-described on a version bump");
  tex.offset.x = 0.5;
  assert.equal(IB.interiorTextureInfo(tex).desc, null, "a UV offset refuses at once (not versioned)");
  tex.offset.x = 0;
  assert.ok(IB.interiorTextureInfo(tex).desc);
  tex.image = { data: new Uint8Array(16 * 16 * 4), width: 16, height: 16 };
  assert.equal(IB.interiorTextureInfo(tex).desc.width, 16, "a new image is re-described");
  const m = new M.MaterialCache();
  const mat = m._materialFromFlags(0x2, tex, undefined, null, undefined, null, { translucency: 0, luminosity: 0, diffuse: 1, hasPalette: true });
  const k1 = IB.interiorProgramKeyOf(mat);
  assert.equal(k1, mat.customProgramCacheKey());
  mat.userData.lightClampRetail = !mat.userData.lightClampRetail;
  mat.needsUpdate = true;
  assert.equal(IB.interiorProgramKeyOf(mat), mat.customProgramCacheKey(), "re-read after a version bump");
  assert.notEqual(IB.interiorProgramKeyOf(mat), k1);
});

// --- P5 --------------------------------------------------------------------------
await t("P5 (informational) real clock, default budget: the arrival's largest slices", async () => {
  const w = await world(undefined, { mergeMs: undefined });
  IB.__setInteriorBatchEnvForTest({ mode: "on" });
  // A flag-off-equivalent baseline: the same tick once the landblock is legacy-only is not
  // available here, so the per-tick wall time is reported next to the module's own slices.
  let syncs = 0;
  const ticks = [];
  const t0 = performance.now();
  while ((!rec().chunks.length || chunk().status !== "active") && syncs < 3000) {
    const a = performance.now();
    tick(w);
    ticks.push(performance.now() - a);
    syncs += 1;
    if (rec().chunks.length && (chunk().status === "overlap" || chunk().status === "active")) R.renderPass(w, R.MASK_BOTH);
  }
  const steady = [];
  for (let i = 0; i < 30; i += 1) { const a = performance.now(); tick(w); steady.push(performance.now() - a); }
  const st = S().stats;
  const f = (x) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");
  const top = ticks.slice().sort((x, y) => y - x).slice(0, 3).map(f).join(", ");
  console.log(`      ${N} cells, ${chunk().batches.reduce((n, b) => n + b.entries.length, 0)} entries, ${(chunk().bytes / 1024).toFixed(0)} KiB: `
    + `active after ${syncs} syncs (${(performance.now() - t0).toFixed(0)} ms); slowest ticks ${top} ms; steady tick median `
    + `${f(steady.sort((x, y) => x - y)[15])} ms; module: max plan slice ${f(st.maxPlanMs)} ms over ${st.planSlices ?? "n/a"}, `
    + `max merge slice ${f(st.maxMergeMs)} ms over ${st.mergeSlices ?? "n/a"}, max sync ${f(st.maxSyncMs)} ms (incl. program warms)`);
  assert.equal(chunk().status, "active");
});

IB.disposeInteriorBatches();
IB.__setInteriorBatchEnvForTest(null);
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
