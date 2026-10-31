// tests/interior_batch_pools.test.mjs — R3-5 `?interiorBatch` with the env-cell
// draw pools ARMED (`?drawPools`, DEFAULT ON since 2026-10-25: the shipped
// configuration). Realboot fix 2026-10-31: the first real boot showed the
// batch disarmed ("draw-pools") whenever pool_envcells.js
// envCellPoolsActive() was true, i.e. always; yet the pools take only the
// cell SHELL surfaces their class registry admits and leave every cell-static
// prop and every refused (fused passthrough) surface on the legacy producer,
// which is exactly the batch's target.
//
// The world: the suites' fixture landblock (tests/interior_batch_rig.mjs)
// with page-dim surfaces in its shells (POOL_CELLS: the pools take those, the
// 16-64 px ones are refused `needsResample` and fused as today), the pooled
// world armed EXACTLY as scene3d/index.js arms it (`initPoolWorld({ THREE,
// group: staticsGroup })` + `armEnvCellPoolGroups({ staticsGroup, cellsGroup,
// indoorLayer: 1 })`, under the default chain with frameWork=off: stage A,
// rig.mjs POOL_SEARCH), built by the real cells.js, the real PoolRegistry
// (real THREE.BatchedMesh pools under cellsGroup), rendered through three r184
// on the recording fake WebGL2 in every pass that draws interiors.
//
//   Q1  ARMS: with the pools active the batch arms (no "draw-pools" disarm),
//       plans, and its chunk goes active; stats().pools reads the pools.
//   Q2  MEMBERS: the batch's members are exactly the non-pooled eligible
//       meshes: per cell, (the member set the batch takes from the SAME
//       fixture with the pools off) minus (the surfaces the pools hold), and
//       no pooled surface ever; every prop as with the pools off. The pooled
//       split comes from the pools' state: the offer stamp (`__ibPool`) =
//       the registry's per-cell index = the fixture's page-dim surfaces.
//   Q3  POOLED SHELLS UNTOUCHED: no pool BatchedMesh (or pool member) is a
//       batch member, suppressed, re-layered or re-parented; every frame the
//       pools' per-cell state and drawn instances are the same with the batch
//       on as off; the registry's census reads the same at the end.
//   Q4  BITS, both halves: every frame of the walks (an outdoor doorway
//       approach, going indoors with the split armed and castOn, a sealed
//       frame, out again, evict + rebuild, park + unpark through the real
//       LandblockLRU; ?cellBugParity=retail; recorded live walks when
//       present), for every planned cell DRAW bit = container.visible, and
//       for every pooled cell the registry's hide state says the same
//       (cells.js flips both halves from one tick); bitMismatch 0,
//       pools.visDiverged 0.
//   Q5  DRAW SETS: every frame, every pass, (legacy interior draws + batch
//       members whose bits are set + pool instances drawn) with the batch on
//       = (legacy interior draws + pool instances drawn) with it off; the on
//       world really batched.
//   Q6  A SPLIT THAT DOES NOT ADD UP keeps the cell's SURFACES legacy (its
//       props still batch): the stamp missing while the registry holds the
//       cell's instances; the stamp's legacy count not the container's.
//   Q7  LAYERS: batch objects sit on the containers' mask, which is the
//       pools' (RENDER_LAYER_INDOOR), under a worldRoot sibling of cellsGroup.
// Q1, Q2, Q5, Q6, Q7 fail on the pre-change tree (it disarms: no chunk, no
// member, no batch draw, no stamp); Q3/Q4 assert the on world batched.
//
// Run: node tests/interior_batch_pools.test.mjs   (needs `three` resolvable)

import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
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

const OUT = (R.LB | 0x31) >>> 0;
const C = R.CELL;
const hex = (id) => (id >>> 0).toString(16);

// --- worlds -------------------------------------------------------------------

/** A fixture world; `pools` arms the pooled world first (as index.js does). */
async function world({ pools = true, batch = true, cells = null } = {}) {
  KIT.resetKit();
  IB.disposeInteriorBatches();
  IB.__setInteriorBatchEnvForTest(batch ? { mode: "on", now: R.FROZEN_CLOCK } : null);
  await R.resetPools();
  const w = await R.makeWorld(deps, { pools: true });
  w.pools = pools ? await R.armPools(w) : null;
  const lru = new LandblockLRU({ scene3d: w.scene3d, maxResident: 64, getCurrentLbId: () => 0 });
  w.scene3d.landblockLru = lru;
  w.lru = lru;
  lru.track(R.LB);
  w.cells = cells || (batch ? cellsOn : cellsOff);
  await R.build(w.cells, w, { table: R.POOL_CELLS });
  return w;
}

/** material -> surface did, from the world's own MaterialCache (the build's cached members). */
function didMap(w) {
  const m = new Map();
  for (const didS of Object.keys({ ...R.SURF, ...R.SURF_POOLED })) {
    const did = +didS >>> 0;
    for (const fn of ["getCached", "getCachedCellBaked", "getCachedStaticBias"]) {
      try { const mat = w.mc[fn](did); if (mat) m.set(mat, did); } catch (_) { /* not that ladder */ }
    }
  }
  return m;
}

/** Every batch entry as `cell|kind|mesh|did`. */
function memberKeys(w) {
  const S = IB.__interiorBatchStateForTest();
  const dids = didMap(w);
  const out = new Set();
  for (const rec of S.lbs.values()) {
    for (const ch of rec.chunks) {
      for (const b of ch.batches) {
        for (const e of b.entries) {
          const did = dids.get(e.member);
          assert.ok(did !== undefined, `member material of ${e.mesh.name} resolves to a fixture surface`);
          out.add(`${hex(ch.cellPlans[e.cellIdx].cell.cellId)}|${e.kind}|${e.mesh.name}|${hex(did)}`);
        }
      }
    }
  }
  return out;
}

function settle(w, frustum = R.CELL_IDS.slice(), n = 4) {
  const sh = R.makeSession({ player: OUT, indoor: false, frustum, walk: [], bfs: [] });
  for (let f = 0; f < n; f += 1) { R.tick(w.cells, w, sh); R.renderPass(w, R.MASK_BOTH); }
  return IB.interiorBatchDiag();
}

function poolMeshes(reg) {
  return [...reg.pools.values()].map((p) => p.mesh);
}

// --- Q1 / Q7 ---------------------------------------------------------------------

await t("Q1 the pools armed as index.js arms them: the batch arms, plans and goes active; stats().pools reads them", async () => {
  const w = await world();
  assert.equal(w.pools.envcells.envCellPoolsActive(), true, "premise: the env-cell pools are active");
  const census = w.pools.envcells.envCellPoolCensus();
  assert.equal(census.surfacesPooled, 4, `premise: the four page-dim shell surfaces pooled (${JSON.stringify(census)})`);
  const d = settle(w);
  assert.equal(IB.__interiorBatchStateForTest().disarmed, null, "not disarmed");
  assert.deepEqual(d.disarmed, {}, `no disarm counted (stats().disarmed ${JSON.stringify(d.disarmed)})`);
  assert.equal(d.chunks.active, 1, `the chunk is active: ${JSON.stringify(d.chunks)} legacy ${JSON.stringify(d.legacyReasons)} unit ${JSON.stringify(d.unitReasons)}`);
  assert.ok(d.objects > 0 && d.drawnObjects > 0, `batch objects drawn (${d.objects}/${d.drawnObjects})`);
  assert.equal(d.pools.active, true);
  assert.equal(d.pools.cells, 3, "three planned cells share their shell with a pool");
  assert.equal(d.pools.surfacesPooled, 4, "pooled shell groups: 1 + 2 + 0 + 1");
  assert.equal(d.pools.surfacesLegacy, 7, "legacy shell groups: 3 + 1 + 2 + 1");
  assert.equal(d.pools.partitionRefused, 0);
});

await t("Q7 layers: batch objects on the containers' mask = the pools' (RENDER_LAYER_INDOOR), under a worldRoot sibling of cellsGroup", async () => {
  const w = await world();
  settle(w);
  const S = IB.__interiorBatchStateForTest();
  const masks = new Set([...w.scene3d.cellContainers3d.values()].map((c) => c.layers.mask));
  assert.deepEqual([...masks], [2], "premise: containers on layer 1");
  for (const pm of poolMeshes(w.pools.reg)) assert.equal(pm.layers.mask, 2, `${pm.name}: the pool is on layer 1`);
  let n = 0;
  for (const rec of S.lbs.values()) {
    assert.equal(rec.group.layers.mask, 2);
    for (const ch of rec.chunks) for (const b of ch.batches) { assert.equal(b.mesh.layers.mask, 2, b.mesh.name); n += 1; }
  }
  assert.ok(n > 0, "batch objects exist");
  assert.equal(S.root.parent, w.worldRoot, "the batch root is a worldRoot child");
  assert.notEqual(S.root.parent, w.scene3d.cellsGroup);
  assert.equal(S.root.layers.mask, w.scene3d.cellsGroup.layers.mask);
});

// --- Q2 / Q3 ---------------------------------------------------------------------

await t("Q2 members = the non-pooled eligible meshes (pools-off members minus the pooled surfaces); the split is the pools' own state", async () => {
  // Reference: the SAME fixture with the pools off (every shell surface legacy).
  const ref = await world({ pools: false });
  settle(ref);
  assert.equal(IB.interiorBatchDiag().chunks.active, 1, "premise: the pools-off reference batched");
  assert.equal([...ref.scene3d.cellContainers3d.values()].some((c) => c.userData.__ibPool), false, "pools off: no stamp");
  const off = memberKeys(ref);
  // Pools on.
  const w = await world();
  const reg = w.pools.reg;
  // The split, from the pools' state: stamp = registry index = the fixture's page-dim surfaces.
  const states = R.poolCellStates(reg);
  for (const [cellId, c] of w.scene3d.cellContainers3d) {
    const st = c.userData.__ibPool;
    const want = R.POOLED_DIDS.get(cellId);
    assert.ok(st, `${hex(cellId)}: the offer verdict is stamped`);
    assert.ok(!Object.keys(c.userData).includes("__ibPool"), "the stamp is non-enumerable");
    assert.deepEqual(st.dids.slice().sort(), want.slice().sort(), `${hex(cellId)}: stamped pooled dids`);
    assert.equal(st.pooled, want.length);
    assert.equal((states.get(cellId) || { instances: 0 }).instances, want.length, `${hex(cellId)}: registry instances = pooled`);
    assert.equal(IB.legacySurfaceCountOf(c), st.legacy, `${hex(cellId)}: the container holds exactly the legacy groups`);
    assert.equal(st.offered, R.POOL_CELLS[(cellId & 0xfff) - 0x100].surfaces.length, `${hex(cellId)}: every shell group offered`);
  }
  settle(w);
  assert.equal(IB.interiorBatchDiag().chunks.active, 1, "pools on: active");
  const on = memberKeys(w);
  const pooledKey = (k) => {
    const [cell, kind, , did] = k.split("|");
    return kind === "cells" && (R.POOLED_DIDS.get(parseInt(cell, 16) >>> 0) || []).includes(parseInt(did, 16) >>> 0);
  };
  const want = new Set([...off].filter((k) => !pooledKey(k)));
  const onlyOn = [...on].filter((k) => !want.has(k));
  const onlyWant = [...want].filter((k) => !on.has(k));
  assert.deepEqual(onlyOn, [], "no member the pools-off batch minus the pools would not have");
  assert.deepEqual(onlyWant, [], "every non-pooled eligible member batched");
  assert.ok([...off].some(pooledKey), "premise: the pools-off batch did take the page-dim surfaces");
  assert.equal([...on].filter(pooledKey).length, 0, "no pooled surface is a member");
  const props = (s) => [...s].filter((k) => k.split("|")[1] === "props").sort();
  assert.deepEqual(props(on), props(off), "every eligible prop, as with the pools off");
  assert.ok(props(on).length >= 4, `props batched (${props(on).length}: cell 3's prop has a translucent group and stays legacy whole)`);
});

await t("Q3 pooled shells untouched: no pool object is a member / suppressed / moved; the pools read the same with the batch on and off", async () => {
  const frames = 10;
  const runOne = async (batch) => {
    const w = await world({ batch });
    const st = { player: OUT, indoor: false, frustum: [], walk: [], bfs: [] };
    const sh = R.makeSession(st);
    const trace = [];
    for (let f = 0; f < frames; f += 1) {
      st.frustum = f % 3 === 0 ? [C(0), C(1)] : f % 3 === 1 ? [C(1), C(3)] : R.CELL_IDS.slice();
      R.tick(w.cells, w, sh);
      R.renderPass(w, R.MASK_BOTH);
      trace.push(JSON.stringify([...R.poolCellStates(w.pools.reg)].sort((a, b) => a[0] - b[0])));
    }
    const reg = w.pools.reg;
    const c = reg.census();
    return { w, trace, census: JSON.stringify({ g: c.geometry, cells: c.cells, e: { ...c.events, mutationsThisFrame: 0 }, i: [...reg.pools.values()].map((p) => [p.key, p.instances]) }) };
  };
  const a = await runOne(false);
  const b = await runOne(true);
  assert.deepEqual(b.trace, a.trace, "per frame: the pools' per-cell state is the same with the batch on");
  assert.equal(b.census, a.census, "the registry census is the same");
  const S = IB.__interiorBatchStateForTest();
  assert.equal(IB.interiorBatchDiag().chunks.active, 1, "premise: the on world batched");
  const pms = new Set(poolMeshes(b.w.pools.reg));
  assert.ok(pms.size > 0, "premise: pools exist");
  for (const pm of pms) {
    assert.equal(pm.parent, b.w.scene3d.cellsGroup, `${pm.name}: still a cellsGroup child`);
    assert.equal(Object.prototype.hasOwnProperty.call(pm, "boundingSphere") && pm.boundingSphere === IB.ibSentinel(), false, `${pm.name}: never sentinelled`);
    assert.equal(pm.visible, true);
    assert.equal(pm.layers.mask, 2);
  }
  for (const rec of S.lbs.values()) {
    for (const ch of rec.chunks) {
      for (const mi of ch.meshInfo) {
        assert.ok(!pms.has(mi.mesh) && mi.mesh.isBatchedMesh !== true && mi.mesh.userData.__poolCellId === undefined, `${mi.mesh.name}: not a pool object`);
        let o = mi.mesh;
        while (o && !(o.userData && o.userData.isEnvCell)) o = o.parent;
        assert.ok(o, `${mi.mesh.name}: a container descendant`);
      }
    }
  }
  const member = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  member.userData = { __poolCellId: C(0) };
  assert.equal(IB.interiorMeshReason(member), "pool-member", "a pool member node is never a candidate");
});

// --- Q4 / Q5 ---------------------------------------------------------------------

/** The bits test's walk shape (scripted frames + LRU events). */
function walk() {
  const frames = [];
  const out = (frustum) => ({ player: OUT, indoor: false, frustum, walk: [], bfs: [] });
  for (let f = 0; f < 5; f += 1) frames.push(out([C(0), C(1), C(2), C(3)]));
  for (let f = 0; f < 8; f += 1) frames.push(out(f % 4 < 2 ? [C(0), C(1)] : [C(1), C(3)]));
  frames.push(out([]));
  frames.push(out([C(2)]));
  for (let f = 0; f < 5; f += 1) frames.push({ player: C(0), indoor: true, frustum: [C(0), C(2), C(3)], walk: f % 2 ? [C(0), C(1)] : [C(0), C(1), C(3)], bfs: [C(1)] });
  frames.push({ player: C(0), indoor: true, sealed: true, frustum: [C(0)], walk: [C(0), C(1)], bfs: [C(1)] });
  for (let f = 0; f < 3; f += 1) frames.push(out([C(0), C(1), C(3)]));
  frames.push({ ...out([C(0), C(1)]), event: "evict" });
  frames.push({ ...out([C(0), C(1)]), event: "rebuild" });
  for (let f = 0; f < 4; f += 1) frames.push(out(f < 2 ? [C(0), C(1)] : [C(0), C(1), C(2), C(3)]));
  frames.push({ ...out([C(1)]), event: "park" });
  frames.push(out([C(1)]));
  frames.push({ ...out([C(0), C(1), C(2)]), event: "unpark" });
  for (let f = 0; f < 3; f += 1) frames.push({ player: C(3), indoor: true, frustum: [C(3)], walk: [C(3)], bfs: [] });
  for (let f = 0; f < 3; f += 1) frames.push(out([C(0), C(3)]));
  // Settled tail: past one backstop (IB_BACKSTOP_SYNCS), which compares the pooled halves too.
  while (frames.length < IB.IB_BACKSTOP_SYNCS + 4) frames.push(out(frames.length % 2 ? [C(0), C(1), C(3)] : [C(0), C(3)]));
  return frames;
}

function batchOf(S, obj) {
  const rec = S.lbs.get(obj.userData.lbKey >>> 0);
  if (!rec) return null;
  for (const ch of rec.chunks) for (const bt of ch.batches) if (bt.mesh === obj) return bt;
  return null;
}

/** One pass's interior draw set: legacy meshes, batch members through the bits, pool instances. */
function drawnSet(recs, pass, reg) {
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
        if (on) out.add(`${e.mesh.name}#${e.start}`);
      }
      continue;
    }
    if (!/^(surfaces?-|cellstatic-|surface-)/.test(o.name || "")) continue;
    out.add(`${o.name}#${r.group ? r.group.start : 0}`);
  }
  for (const k of R.poolDrawnKeys(reg, recs)) out.add(k);
  return { set: out, batchDraws };
}

/**
 * Q4 for one frame of the on world: DRAW bits = containers; the pools' hide
 * state = containers. One PRE-EXISTING exception, flag-independent and
 * modelled exactly: an LRU park removes a landblock's containers from
 * cellContainers3d with whatever `visible` they had, and unpark re-adds them
 * as they were; the tick's hidden loop is diff-driven (it revisits only
 * `_lastCellVisibleSet`), so a cell that was visible at the park and is out
 * of the set at the unpark keeps `visible = true` and DRAWS (legacy) until it
 * re-enters the set and leaves it. Its pooled half is hidden meanwhile (the
 * pools' delta saw it leave). The bits follow the container (today's frame);
 * such a cell is returned as `stale` and must be outside this tick's set.
 */
function bothHalves(w) {
  const S = IB.__interiorBatchStateForTest();
  let cells = 0, pooled = 0;
  const stale = [];
  for (const rec of S.lbs.values()) {
    for (const ch of rec.chunks) {
      if (ch.row <= 0 || !S.bits) continue;
      for (const b of ch.batches) {
        for (const e of b.entries) {
          const c = ch.cellPlans[e.cellIdx].cell.container;
          if (!c.parent) continue; // parked / evicted: no draw either way
          assert.equal(IB.ibBitOf(S.bits.data, e.code, 0) === 1, c.visible === true, `${c.name}: DRAW bit = container.visible`);
          cells += 1;
        }
      }
    }
  }
  const states = R.poolCellStates(w.pools.reg);
  const tickSet = w.scene3d._lastCellVisibleSet; // the tick's own set (absent under ?cellBugParity)
  for (const [cellId, c] of w.scene3d.cellContainers3d) {
    const s = states.get(cellId);
    if (!s) continue;
    if (tickSet && c.visible === true && !tickSet.has(cellId)) {
      assert.equal(s.hidden, s.instances, `${hex(cellId)}: stale container, its pooled half hidden`);
      stale.push(cellId);
      continue;
    }
    assert.equal(s.hidden, c.visible ? 0 : s.instances, `${hex(cellId)}: the pooled half's hide state = container.visible`);
    pooled += 1;
  }
  return { cells, pooled, stale };
}

/**
 * Run `frames` through one pools-armed world; per frame and pass the draw
 * set (plus, batch on, the both-halves check). Sequential A then B: the
 * pooled world is a module singleton, one world at a time.
 */
async function runWalk(cellsMod, frames, batch, label) {
  const w = await world({ batch, cells: cellsMod });
  const st = { player: OUT, indoor: false, frustum: [], walk: [], bfs: [] };
  const sh = R.makeSession(st);
  let sealed = false;
  sh.currentDungeonHasOutdoorPortal = () => !sealed;
  const out = [];
  let maxBatch = 0, active = 0, halves = 0, pooledChecks = 0, lastUnpark = -1;
  const stale = [];
  for (let f = 0; f < frames.length; f += 1) {
    const fr = frames[f];
    if (fr.event === "evict") w.lru.evict(R.LB);
    if (fr.event === "rebuild") { w.lru.track(R.LB); await R.build(cellsMod, w, { table: R.POOL_CELLS }); }
    if (fr.event === "park") w.lru.park(R.LB);
    if (fr.event === "unpark") { w.lru.unpark(R.LB); lastUnpark = f; }
    Object.assign(st, fr);
    sealed = !!fr.sealed;
    R.tick(cellsMod, w, sh);
    const p = R.renderAllPasses(w, PP.collectOutdoorRemainderHidden);
    const sets = {};
    for (const pass of ["unsplit", "world", "cells", "remainder", "shadow"]) {
      const d = drawnSet(p[pass], pass, w.pools.reg);
      if (!batch) assert.equal(d.batchDraws, 0, "the batch-off world never draws a batch");
      if (pass === "unsplit") maxBatch = Math.max(maxBatch, d.batchDraws);
      sets[pass] = d.set;
    }
    if (batch) {
      let h;
      try { h = bothHalves(w); } catch (e) { console.log(`      at ${label} frame ${f} (${fr.event || "-"}) ${JSON.stringify(fr)}`); throw e; }
      halves += h.cells;
      pooledChecks += h.pooled;
      for (const id of h.stale) stale.push({ f, id, sinceUnpark: lastUnpark >= 0 ? f - lastUnpark : -1 });
      const d = IB.interiorBatchDiag();
      if (d && d.chunks && d.chunks.active) active += 1;
    }
    out.push({ sets, event: fr.event || "-" });
  }
  return { out, maxBatch, active, halves, pooledChecks, stale, diag: batch ? IB.interiorBatchDiag() : null, label };
}

function sameSets(a, b, label) {
  assert.equal(a.out.length, b.out.length);
  for (let f = 0; f < a.out.length; f += 1) {
    for (const pass of Object.keys(a.out[f].sets)) {
      const sa = a.out[f].sets[pass], sb = b.out[f].sets[pass];
      const onlyA = [...sa].filter((x) => !sb.has(x));
      const onlyB = [...sb].filter((x) => !sa.has(x));
      assert.ok(onlyA.length === 0 && onlyB.length === 0, `${label} frame ${f} (${a.out[f].event}) pass ${pass}: off-only ${JSON.stringify(onlyA)} on-only ${JSON.stringify(onlyB)}`);
    }
  }
}

await t("Q4 + Q5 the walk: every frame, every pass, batch-on draws = batch-off draws (legacy + pools); DRAW bits = containers = the pools' hide state", async () => {
  const frames = walk();
  const a = await runWalk(cellsOff, frames, false, "walk");
  const b = await runWalk(cellsOn, frames, true, "walk");
  sameSets(a, b, "walk");
  assert.ok(b.maxBatch >= 3, `the on world really batched (batch draws in a pass: ${b.maxBatch})`);
  assert.ok(b.active >= frames.length - 10, `active for most of the walk (${b.active}/${frames.length})`);
  assert.ok(b.halves > 100 && b.pooledChecks > 50, `checked (${b.halves} member bits, ${b.pooledChecks} pooled cells)`);
  // The pre-existing unpark staleness (bothHalves): seen right at the unpark
  // (cell 3: visible at the park, out of the set at the unpark), never elsewhere.
  assert.ok(b.stale.length > 0, "premise: the walk reaches the unpark staleness");
  for (const x of b.stale) assert.ok(x.sinceUnpark >= 0 && x.sinceUnpark <= 1 && x.id === C(3), `stale only at the unpark: ${JSON.stringify(x)}`);
  assert.ok(a.out.some((fr) => [...fr.sets.unsplit].some((k) => k.startsWith("pool:"))), "premise: the pools drew");
  assert.ok(a.out.some((fr) => [...fr.sets.cells].some((k) => k.startsWith("pool:"))), "premise: the pools drew in the cells pass");
  assert.equal(b.diag.bitMismatch, 0, "backstop: no bit / container disagreement");
  assert.equal(b.diag.pools.visDiverged, 0, "backstop: no pool / container disagreement");
  assert.ok(b.diag.pools.visChecks > 0, "the backstop compared the pooled halves");
});

await t("Q4 + Q5 under ?cellBugParity=retail (every EnvCell drawn; the pools set every cell visible)", async () => {
  const frames = walk().slice(0, 22);
  const a = await runWalk(cellsOffParity, frames, false, "parity");
  const b = await runWalk(cellsOnParity, frames, true, "parity");
  sameSets(a, b, "parity");
  assert.ok(b.maxBatch >= 3, `batched (${b.maxBatch})`);
  assert.equal(b.diag.bitMismatch, 0);
  assert.equal(b.diag.pools.visDiverged, 0);
});

await t("Q4 + Q5 recorded live walks (tests/fixtures/interior_batch_walk_*.json) with the pools armed, when present", async () => {
  const dir = path.join(HERE, "fixtures");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^interior_batch_walk_.*\.json$/.test(f)) : [];
  if (files.length === 0) { console.log("      (no recorded walks yet: window.__interiorBatch.recordWalk(n) on the next live session)"); return; }
  for (const f of files) {
    const rec = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    const frames = (rec.frames || rec).map((fr) => {
      const ids = new Set((fr.visible || []).map((v) => v & 0xfff));
      const fixture = R.CELL_IDS.filter((id) => ids.has(id & 0xfff));
      return { player: fr.isIndoor ? R.CELL(0) : OUT, indoor: !!fr.isIndoor, frustum: fixture, walk: fr.isIndoor ? fixture : [], bfs: [] };
    });
    const a = await runWalk(cellsOff, frames, false, f);
    const b = await runWalk(cellsOn, frames, true, f);
    sameSets(a, b, f);
    assert.equal(b.diag.bitMismatch, 0, f);
    assert.equal(b.diag.pools.visDiverged, 0, f);
  }
});

// --- Q6 ---------------------------------------------------------------------------

await t("Q6 a split that does not add up keeps the cell's surfaces legacy (props still batch)", async () => {
  for (const tamper of ["unstamped", "legacy-count"]) {
    const w = await world();
    const c0 = w.scene3d.cellContainers3d.get(C(0));
    if (tamper === "unstamped") delete c0.userData.__ibPool; // the registry still holds cell 0's instance
    else c0.userData.__ibPool.legacy -= 1; // the container holds one group more than the offer left
    const d = settle(w);
    assert.equal(d.chunks.active, 1, `${tamper}: the chunk still goes active`);
    assert.equal(d.pools.partitionRefused, 1, `${tamper}: one cell refused`);
    assert.equal(d.unitReasons["cells:pool-split"], 1, `${tamper}: counted`);
    const keys = memberKeys(w);
    const c0keys = [...keys].filter((k) => k.startsWith(hex(C(0)) + "|"));
    assert.equal(c0keys.filter((k) => k.split("|")[1] === "cells").length, 0, `${tamper}: no cell-0 surface batched`);
    assert.ok(c0keys.filter((k) => k.split("|")[1] === "props").length >= 2, `${tamper}: cell 0's props batched (${c0keys})`);
    const fused = c0.children.find((ch) => ch.name.startsWith("mesh-")).children.find((m) => m.userData.fusedKind === "opaque");
    assert.equal(Object.prototype.hasOwnProperty.call(fused, "boundingSphere"), false, `${tamper}: cell 0's shell keeps drawing legacy`);
    assert.ok([...keys].some((k) => k.startsWith(hex(C(3)) + "|cells|")), `${tamper}: the other cells' surfaces still batch`);
  }
});

await t("Q8 the backstop counts a pooled half that disagrees with its container (pools.visDiverged); the bits keep following the container", async () => {
  const w = await world();
  const st = { player: OUT, indoor: false, frustum: R.CELL_IDS.slice(), walk: [], bfs: [] };
  const sh = R.makeSession(st);
  for (let f = 0; f < 4; f += 1) { R.tick(cellsOn, w, sh); R.renderPass(w, R.MASK_BOTH); }
  assert.equal(IB.interiorBatchDiag().chunks.active, 1, "premise: active");
  // A writer that is not the tick hides cell 0's pooled half (container stays visible).
  w.pools.reg.setCellsVisible([C(0)], false);
  for (let f = 0; f < IB.IB_BACKSTOP_SYNCS + 1; f += 1) R.tick(cellsOn, w, sh);
  const d = IB.interiorBatchDiag();
  assert.ok(d.pools.visChecks > 0, "the backstop compared the pooled halves");
  assert.ok(d.pools.visDiverged >= 1, `the divergence is counted (${JSON.stringify(d.pools)})`);
  assert.equal(d.bitMismatch, 0, "the bits still equal the containers");
  const c0 = w.scene3d.cellContainers3d.get(C(0));
  assert.equal(c0.visible, true);
  assert.equal(c0.userData.__ib.chunk.drawState[c0.userData.__ib.cell], 1, "cell 0 still drawn by its container's verdict");
});

IB.disposeInteriorBatches();
IB.__setInteriorBatchEnvForTest(null);
await R.resetPools();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
