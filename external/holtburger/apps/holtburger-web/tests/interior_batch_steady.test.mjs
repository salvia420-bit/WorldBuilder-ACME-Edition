// tests/interior_batch_steady.test.mjs — R3-5 `?interiorBatch` steady state
// (scene3d/gpu_batch/interior_batch.js; design §2.11 "On, per frame"). Once
// every chunk is active and the camera rests, a frame's work in this module
// is the visibility notes, the reconcile, the slot drift compares and the
// bits flush — and none of it allocates.
//
//   A1  V8's sampling heap profiler (inspector, one sample per ~64 bytes
//       allocated, objects freed by a GC kept in the profile) over 4000
//       steady syncs + notes of the fixture. Function inlining is off for
//       this process (v8 --no-turbo-inlining / --no-maglev-inlining), so an
//       allocation is booked to the function that makes it, not to its
//       caller. A probe function proves the sampler sees short-lived garbage.
//       No function of interior_batch.js allocates per sync (a site sampled
//       50 times or more in 4000 syncs) except syncInteriorBatches, and that
//       one at most 48 bytes a sync: the app's rAF timestamp handed to
//       kitBeginFrame (the kit's frame id, shared with every kit consumer)
//       is a double V8 boxes for the call. Sites sampled a few times in the
//       whole run (interrupt-time allocations booked to whatever runs) are
//       not per-sync work.
//   A2  the same with the env-cell draw pools ARMED (`?drawPools`, default
//       on; rig.mjs armPools, as index.js arms them): the per-sync pools read
//       and the backstop's pooled-half compare allocate nothing either. Run
//       in a CHILD process (this file with `--pools`, sequential, one node at
//       a time): profiled after A1 in the same process, the second world's
//       re-tiered loops book Map-iterator allocations (~40 B in
//       _planPending / _advanceChunks) that a fresh process never shows —
//       JIT state, not the module.
//   A3  (2026-10-31, POM members) the same on the rig's POM material cache
//       (cells un-baked: real POM chains, height layers + POM extension rows,
//       the per-sync POM row rewrite) in a child process (`--pom`); the sites
//       counted widen to the kit code that path runs (class_materials.js
//       pomStateOf, layer_state.js writePom).
//   A4  (2026-10-31, AO / roughness / emissive members) the same on the
//       rig's texchan + luminous material cache (AO / roughness layers, the
//       per-sync extension-row rewrite: aoMapIntensity, the emissive uniform)
//       in a child process (`--maps`); the sites widen to class_materials.js
//       extraMapStateOf and layer_state.js writeExt / packExtState.
//
// Run: node tests/interior_batch_steady.test.mjs   (needs `three` resolvable)

import assert from "node:assert/strict";
import v8 from "node:v8";
import inspector from "node:inspector";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

v8.setFlagsFromString("--no-turbo-inlining");
v8.setFlagsFromString("--no-maglev-inlining");

const R = await import("./interior_batch_rig.mjs");
globalThis.window ??= {};
globalThis.location = { search: R.BASE_SEARCH };
globalThis.window.location = globalThis.location;
globalThis.window.requestAnimationFrame ??= () => 1;

const M = await import("../scene3d/materials.js");
const adapter = await import("../scene3d/adapter.js");
const KIT = await import("../scene3d/gpu_batch/kit.js");
const IB = await import("../scene3d/gpu_batch/interior_batch.js");
const cellsOn = await R.loadCells("interiorBatch=on");

let failures = 0;
let passes = 0;
async function t(name, fn) {
  try { await fn(); passes++; console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name); console.log(e); }
}

const session = new inspector.Session();
session.connect();
const post = (m, p = {}) => new Promise((res, rej) => session.post(m, p, (e, r) => (e ? rej(e) : res(r))));

const kept = [];
function allocProbe(i) { return { i, tag: "probe", list: [i, i + 1, i + 2, i + 3] }; }

/** Leaf allocations (selfSize > 0) of the sampled profile, per (url, function). */
function leaves(profile) {
  const out = [];
  const walk = (n) => {
    if (n.selfSize > 0) out.push({ url: n.callFrame.url, fn: n.callFrame.functionName || "(anonymous)", line: n.callFrame.lineNumber + 1, bytes: n.selfSize });
    for (const c of n.children || []) walk(c);
  };
  walk(profile.head);
  return out;
}

async function steadyCase(pools, pom = false, maps = false) {
  KIT.resetKit();
  IB.disposeInteriorBatches();
  IB.__setInteriorBatchEnvForTest({ mode: "on", now: R.FROZEN_CLOCK });
  await R.resetPools();
  const w = await R.makeWorld({ M, adapter }, maps ? { texchan: true, luminous: R.LUMINOUS } : { pools, pom });
  if (pools) await R.armPools(w);
  await R.build(cellsOn, w, pools ? { table: R.POOL_CELLS } : (pom ? { baked: false } : {}));
  const sh = R.makeSession({ player: (R.LB | 0x31) >>> 0, indoor: false, frustum: R.CELL_IDS.slice(), walk: [], bfs: [] });
  for (let f = 0; f < 3; f += 1) { R.tick(cellsOn, w, sh); R.renderPass(w, R.MASK_BOTH); }
  const S = IB.__interiorBatchStateForTest();
  assert.equal([...S.lbs.values()][0].chunks[0].status, "active", "premise: active");
  assert.ok(S.slots.size >= 5, `premise: live slots (${S.slots.size})`);
  if (pom) assert.ok([...S.slots.values()].filter((e) => e.pom && e.pomRow > 0).length >= 4, "premise: POM slots with extension rows");
  if (maps) assert.ok([...S.slots.values()].filter((e) => e.maps.any && e.extRow > 0 && e.aoRef).length >= 5
    && [...S.slots.values()].some((e) => e.maps.emissive && e.extRow > 0), "premise: AO / roughness / emissive slots with extension rows");
  const SITES = pom || maps ? /gpu_batch\/(interior_batch|class_materials|layer_state)\.js/ : /gpu_batch\/interior_batch\.js/;
  const containers = [...w.scene3d.cellContainers3d.values()];
  const ft = w.scene3d.frameTime;
  const steady = (n) => {
    for (let i = 0; i < n; i += 1) {
      ft.tsMs += 16.7; // the app's frame clock: a new number, the same object
      for (let k = 0; k < containers.length; k += 1) IB.ibNoteVisible(containers[k], containers[k].visible);
      IB.syncInteriorBatches(w.scene3d, false, true);
    }
  };
  steady(4000); // warm: every function past its tier-up
  await post("HeapProfiler.enable");
  await post("HeapProfiler.startSampling", { samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (let i = 0; i < 2000; i += 1) kept[i & 7] = allocProbe(i); // the premise: garbage is sampled
  steady(4000);
  const { profile } = await post("HeapProfiler.stopSampling");
  await post("HeapProfiler.disable");
  const all = leaves(profile);
  const probe = all.filter((l) => l.fn === "allocProbe").reduce((n, l) => n + l.bytes, 0);
  assert.ok(probe > 0, "premise: the sampler books short-lived objects to the allocating function");
  // Samples per function of interior_batch.js (node id -> function).
  const byId = new Map();
  const index = (n) => { byId.set(n.id, n); for (const c of n.children || []) index(c); };
  index(profile.head);
  const count = new Map();
  const bytes = new Map();
  for (const sm of profile.samples || []) {
    const n = byId.get(sm.nodeId);
    if (!n || !SITES.test(n.callFrame.url)) continue;
    const fn = n.callFrame.functionName || "(anonymous)";
    count.set(fn, (count.get(fn) || 0) + 1);
  }
  for (const l of all) if (SITES.test(l.url)) bytes.set(l.fn, (bytes.get(l.fn) || 0) + l.bytes);
  const recurring = [...count.entries()].filter(([, n]) => n >= 50).map(([fn]) => fn);
  const report = recurring.map((fn) => `${fn}: ${count.get(fn)} samples, ~${((bytes.get(fn) || 0) / 4000).toFixed(1)} B/sync`);
  console.log(`      per-sync allocation sites in ${pom ? "interior_batch.js + the kit's POM path" : (maps ? "interior_batch.js + the kit's extra-map path" : "interior_batch.js")}: ${report.join("; ") || "none"}`);
  assert.deepEqual(recurring.filter((fn) => fn !== "syncInteriorBatches"), [], `per-sync allocations: ${report.join("; ")}`);
  assert.ok((bytes.get("syncInteriorBatches") || 0) / 4000 <= 48, `syncInteriorBatches: ${report.join("; ")}`);
  assert.equal(S.stats.bitMismatch, 0);
  if (pools) {
    assert.equal(S.stats.pools.active, true, "premise: the pools are armed");
    assert.ok(S.stats.pools.visChecks > 0, "premise: the backstop compared pooled halves");
    assert.equal(S.stats.pools.visDiverged, 0);
  }
  IB.disposeInteriorBatches();
  await R.resetPools();
}

const child = (flag) => () => {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), flag], { encoding: "utf8", timeout: 300000 });
  const lines = String(r.stdout || "").split("\n").filter((l) => /per-sync|ok |FAIL|passed|Error|assert/.test(l));
  for (const l of lines) console.log("    " + l.trim());
  assert.equal(r.status, 0, `child exit ${r.status}: ${String(r.stderr || "").slice(-600)}`);
};
if (process.argv.includes("--pools")) {
  await t("A2 the same with the env-cell draw pools armed", () => steadyCase(true));
} else if (process.argv.includes("--pom")) {
  await t("A3 the same with POM members (height layers + POM extension rows)", () => steadyCase(false, true));
} else if (process.argv.includes("--maps")) {
  await t("A4 the same with AO / roughness / emissive members (extra-map layers + extension rows)", () => steadyCase(false, false, true));
} else {
  await t("A1 steady state: no per-sync allocation in interior_batch.js over 4000 syncs + notes but the boxed frame timestamp (<= 48 B a sync)", () => steadyCase(false));
  await t("A2 the same with the env-cell draw pools armed (child process)", child("--pools"));
  await t("A3 the same with POM members (child process)", child("--pom"));
  await t("A4 the same with AO / roughness / emissive members (child process)", child("--maps"));
}

IB.__setInteriorBatchEnvForTest(null);
session.disconnect();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
