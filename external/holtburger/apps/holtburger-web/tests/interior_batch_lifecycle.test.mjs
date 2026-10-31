// tests/interior_batch_lifecycle.test.mjs — R3-5 `?interiorBatch` lifecycle
// (scene3d/gpu_batch/interior_batch.js + the cells.js hooks; design §2.8-2.10,
// proof §6.1 L1-L9). Real cells.js builds, real MaterialCache members, three
// r184's WebGLRenderer on the recording fake WebGL2 (tests/interior_batch_rig.mjs).
//
//   L1  FLAG-OFF GOLDEN: build + 200 ticks (+ a render each) of the fixture
//       landblock produce exactly tests/fixtures/interior_batch_flag_off.golden.json
//       — the scene-graph shape (names, types, layers, visible, castShadow,
//       own-property keys, userData keys, attribute sets), the material
//       program keys, the hashes of every shader source three compiled and of
//       every program cache key, the draw count, the visibility trace, the
//       scene3d keys, the interior globals, the canvas listeners and the kit
//       summary (all null). The golden was generated from the PRE-CHANGE tree
//       (HEAD cells.js, no interior_batch.js). Also: no interior-batch root,
//       no `window.__interiorBatch`, no `userData.__ib`, no
//       `scene3d.interiorBatchHooks`, and the module never created its state.
//       Regenerate (only for an intended flag-off change elsewhere, from a tree
//       WITHOUT this lane): node tests/interior_batch_lifecycle.test.mjs --write-golden
//   L2  state order: pending -> planned -> admitting -> warming -> building ->
//       overlap -> active; nothing is merged or charged while no cell of the
//       chunk is drawn.
//   L3  overlap never suppresses legacy before every class material drew;
//       BATCH_OVERLAP_GIVEUP_FRAMES on screen without that draw -> legacy.
//   L4  the frustum sentinel on real three r184: projectObject and the shadow
//       renderObject skip the mesh; Raycaster hits, Box3.setFromObject,
//       ragdoll_env's _collectTargets and a child's collection (a child mesh
//       still draws, a child PointLight still lights) are unchanged; restore
//       deletes the own property; a mesh that turned frustumCulled off keeps
//       its chunk legacy.
//   L5  drift: a same-page map swap rewrites the slot row only (no geometry,
//       no teardown); a page-key change tears the chunk down in the same sync
//       (legacy draws in that frame's render) and re-plans; a drift that keeps
//       coming back ends legacy ("unstable").
//   L6  evict / park / unpark through the REAL LandblockLRU, with the
//       landblock_lru.js hook (the orchestrator patch, called here as the
//       patch calls it) and without it (the per-sync reconcile): pages,
//       slots, bit rows, tickets, class and depth materials all released,
//       no orphan objects; with the hook no ghost frame, without it exactly
//       one; the unpark frame (LRU after the sync, before the render) has no
//       HOLE either way: the batch at once with the hook, the legacy meshes
//       for that frame without it (park hands them their draw back).
//   L7  context loss + restore: torn down at the event, no GL delete of an
//       object of the lost context afterwards, re-planned and rebuilt with the
//       same bytes on the restored one.
//   L8  the upload budget: the geometry is charged in the sync that starts
//       the merge (here, frozen clock, the sync that also adds the objects;
//       a sliced merge is tests/interior_batch_budget.test.mjs P2) and its
//       ticket lands from three's upload callbacks; a refused spend allocates
//       nothing (legacy keeps drawing); a chunk over the whole per-frame cap
//       is admitted ALONE.
//   L9  walls-first: nothing is registered before envCellLoadedLbs; a build
//       cancelled between walls and statics registers nothing.
//   L10 `?interiorBatch=plan`: the census (candidates, eligible, reasons,
//       keys, projected draws / bytes) with no draw change, no stamp, no kit.
//   L11 the live seam `window.__interiorBatch.off`, and the wireframe disarm.
//
// Run: node tests/interior_batch_lifecycle.test.mjs   (needs `three` resolvable)

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import * as R from "./interior_batch_rig.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const GOLDEN = path.join(HERE, "fixtures", "interior_batch_flag_off.golden.json");

globalThis.window ??= {};
globalThis.location = { search: R.BASE_SEARCH };
globalThis.window.location = globalThis.location;
globalThis.window.requestAnimationFrame ??= () => 1;

const M = await import("../scene3d/materials.js");
const adapter = await import("../scene3d/adapter.js");
const KIT = await import("../scene3d/gpu_batch/kit.js");
const deps = { M, adapter };
const cellsOff = await R.loadCells("");

let failures = 0;
let passes = 0;
async function t(name, fn) {
  try { await fn(); passes++; console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name); console.log(e); }
}

// --- L1 (first: nothing of the batch may have run in this process) ----------------
if (process.argv.includes("--write-golden")) {
  const snap = await R.flagOffSnapshot(cellsOff, deps, KIT);
  writeFileSync(GOLDEN, JSON.stringify(snap, null, 1) + "\n");
  console.log(`wrote ${GOLDEN}`);
  process.exit(0);
}

const IB = await import("../scene3d/gpu_batch/interior_batch.js");
const PP = await import("../scene3d/portal_punch.js");
const { LandblockLRU } = await import("../scene3d/landblock_lru.js");
const cellsOn = await R.loadCells("interiorBatch=on");
const cellsPlan = await R.loadCells("interiorBatch=plan");

await t("L1 flag off: build + 200 ticks equal the pre-change golden; nothing of the batch exists", async () => {
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
  const snap = JSON.parse(JSON.stringify(await R.flagOffSnapshot(cellsOff, deps, KIT)));
  for (const k of Object.keys(golden)) assert.deepEqual(snap[k], golden[k], `golden field ${k}`);
  assert.deepEqual(Object.keys(snap).sort(), Object.keys(golden).sort());
  assert.equal(IB.__interiorBatchStateForTest(), null, "the module never created its state");
  assert.equal(IB.__interiorBatchLbsForTest(), null);
  assert.equal(window.__interiorBatch, undefined, "no global");
  assert.ok(snap.graph.every((n) => n.name !== "interior-batch" && !/^ibatch-/.test(n.name)), "no batch objects");
  assert.ok(snap.containerUserData.every((k) => !k.includes("__ib")), "no stamps");
  assert.ok(!snap.scene3dKeys.includes("interiorBatchHooks"), "no LRU hooks");
  assert.deepEqual([snap.kit.budget, snap.kit.pages, snap.kit.stateRows], [null, null, null], "the kit allocated nothing");
  assert.equal(IB.interiorBatchMode(""), "off", "DEFAULT OFF");
  assert.equal(IB.interiorBatchMode("?interiorBatch=nope"), "off");
  for (const v of ["on", "1", "true", "yes", "ON"]) assert.equal(IB.interiorBatchMode(`?interiorBatch=${v}`), "on");
  assert.equal(IB.interiorBatchMode("?interiorBatch=plan"), "plan");
});

// --- helpers -----------------------------------------------------------------------
const OUT = (R.LB | 0x31) >>> 0;
async function onWorld(opts = {}) {
  KIT.resetKit();
  IB.disposeInteriorBatches();
  IB.__setInteriorBatchEnvForTest({ mode: opts.mode || "on", now: R.FROZEN_CLOCK });
  const w = await R.makeWorld(deps, opts);
  if (opts.lru !== false) {
    const lru = new LandblockLRU({ scene3d: w.scene3d, maxResident: 64, getCurrentLbId: () => 0 });
    w.scene3d.landblockLru = lru;
    w.lru = lru;
    lru.track(R.LB);
  }
  if (opts.build !== false) await R.build(opts.cells || cellsOn, w);
  w.state = { player: OUT, indoor: false, frustum: opts.frustum || R.CELL_IDS.slice(), walk: [], bfs: [] };
  w.sh = R.makeSession(w.state);
  w.cells = opts.cells || cellsOn;
  return w;
}
const S = () => IB.__interiorBatchStateForTest();
const rec = () => S().lbs.get(R.LB);
const chunk = () => rec().chunks[0];
const frame = (w, render = true) => { R.tick(w.cells, w, w.sh); if (render) return R.renderPass(w, R.MASK_BOTH); return null; };
const legacyMeshes = (w) => {
  const out = [];
  for (const c of w.scene3d.cellContainers3d.values()) c.traverse((o) => { if (o.isMesh && /^(surfaces-fused-opaque|cellstatic-)/.test(o.name)) out.push(o); });
  return out;
};
const drawnNames = (recs) => recs.map((r) => r.object.name);
const batchDraws = (recs) => recs.filter((r) => r.object.userData?.interiorBatch).length;

// --- L2 ----------------------------------------------------------------------------
await t("L2 state order; nothing merged or charged while no cell is drawn", async () => {
  const w = await onWorld({ frustum: [] });
  assert.equal(rec().status, "pending", "registered at the build hook, planned at the first sync");
  frame(w);
  assert.equal(rec().status, "planned");
  assert.equal(chunk().status, "building", "admitted + warm, but no cell drawn: no charge");
  assert.equal(S().stats.builds, 0);
  assert.equal(KIT.kitSummary().budget.byKind.geometry, 0, "no geometry bytes charged");
  assert.equal(chunk().batches.every((b) => !b.mesh), true, "nothing allocated");
  w.state.frustum = [R.CELL(1)];
  let recs = frame(w);
  assert.equal(chunk().status, "overlap");
  assert.ok(batchDraws(recs) > 0 && recs.some((r) => /^surfaces-fused-opaque/.test(r.object.name)), "overlap: both draw");
  // Only cell 1's batch objects are on screen: its legacy meshes go once
  // their batches drew; the chunk waits for the batches of hidden cells.
  recs = frame(w);
  assert.equal(chunk().status, "overlap", "batches of hidden cells have not drawn yet");
  const c1 = w.scene3d.cellContainers3d.get(R.CELL(1));
  const c1Batched = [];
  c1.traverse((o) => { if (o.isMesh && /^(surfaces-fused-opaque|cellstatic-)/.test(o.name)) c1Batched.push(o); });
  assert.ok(c1Batched.length === 2 && c1Batched.every((m) => m.boundingSphere === IB.ibSentinel()), "cell 1 (walls + prop) suppressed");
  assert.equal(recs.filter((r) => /^surfaces-fused-opaque-a9b40101|^cellstatic-a9b40101/.test(r.object.name)).length, 0, "and no longer drawn");
  assert.equal(chunk().overlapFrames, 0, "no give-up count: nothing pending is on screen");
  w.state.frustum = R.CELL_IDS.slice();
  frame(w); recs = frame(w);
  assert.equal(chunk().status, "active");
  assert.equal(recs.filter((r) => /^surfaces-fused-opaque|^cellstatic-a9b4010[012]/.test(r.object.name)).length, 0, "active: every batched legacy mesh stopped drawing");
  assert.ok(recs.some((r) => /^surfaces-fused-transparent/.test(r.object.name)), "transparent surfaces stay legacy");
});

// --- L3 ----------------------------------------------------------------------------
await t("L3 overlap holds until every class material drew; never drawn -> legacy after the give-up", async () => {
  const w = await onWorld();
  frame(w, false); // overlap, no render: nothing drew
  assert.equal(chunk().status, "overlap");
  for (let i = 0; i < 5; i += 1) frame(w, false);
  assert.equal(chunk().status, "overlap", "no time cap");
  assert.ok(legacyMeshes(w).every((m) => !Object.prototype.hasOwnProperty.call(m, "boundingSphere")), "legacy never suppressed before the class draws");
  for (let i = 0; i < IB_GIVEUP(); i += 1) frame(w, false);
  assert.equal(chunk().status, "legacy");
  assert.equal(chunk().reason, "never-drawn");
  assert.equal(S().stats.giveUps, 1);
  assert.ok(legacyMeshes(w).every((m) => !Object.prototype.hasOwnProperty.call(m, "boundingSphere")));
  assert.equal(w.scene3d.cellContainers3d.get(R.CELL(0)).userData.__ib, undefined, "unstamped");
  const recs = R.renderPass(w, R.MASK_BOTH);
  assert.equal(batchDraws(recs), 0);
});
function IB_GIVEUP() { return 601; }

await t("L3b a batch of visible-set cells BEHIND the camera never counts toward the give-up; it hands over when it comes into view", async () => {
  const w = await onWorld();
  const look = w.camera.quaternion.clone();
  w.camera.lookAt(w.camera.position.x, w.camera.position.y + 100, w.camera.position.z); // away from the landblock
  w.camera.updateMatrixWorld(true);
  for (let i = 0; i < IB_GIVEUP() + 20; i += 1) frame(w);
  assert.equal(chunk().status, "overlap", "nothing drew (all off-camera), nothing gave up");
  assert.equal(chunk().overlapFrames, 0);
  assert.ok(legacyMeshes(w).every((m) => !Object.prototype.hasOwnProperty.call(m, "boundingSphere")));
  w.camera.quaternion.copy(look);
  w.camera.updateMatrixWorld(true);
  frame(w); frame(w);
  assert.equal(chunk().status, "active", "in view: drawn once, handed over");
});

// --- L4 ----------------------------------------------------------------------------
await t("L4 the sentinel on real three r184: no main / shadow draw; raycast, Box3, ragdoll targets, child draws and lights unchanged", async () => {
  const w = await onWorld({ build: false, lru: false });
  const g = new THREE.BoxGeometry(2, 2, 2);
  const mat = new THREE.MeshStandardMaterial();
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  m.layers.enableAll();
  m.position.set(R.LB_X + 110, 5, -(R.LB_Y + 80));
  const child = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshStandardMaterial());
  child.name = "child";
  child.layers.enableAll();
  m.add(child);
  w.scene.add(m);
  w.scene.updateMatrixWorld(true);
  const draws = (shadow) => R.renderPass(w, R.MASK_BOTH, { shadow }).filter((r) => r.object === m && r.shadow === shadow).length;
  assert.equal(draws(false), 1, "premise: drawn");
  assert.equal(draws(true), 1, "premise: casts");
  const ray = new THREE.Raycaster(new THREE.Vector3(R.LB_X + 110, 50, -(R.LB_Y + 80)), new THREE.Vector3(0, -1, 0));
  const hitsBefore = ray.intersectObject(m, false).map((h) => [h.distance, h.faceIndex]);
  const boxBefore = new THREE.Box3().setFromObject(m);
  const src = readFileSync(path.join(APP, "scene3d/ragdoll_env.js"), "utf8");
  const a = src.indexOf("function _collectTargets(");
  const body = src.slice(a, src.indexOf("\n  return out;\n}\n", a) + "\n  return out;\n}\n".length);
  const collect = new Function("MAX_RAY_TARGETS", "MAX_SCENE_VISITS", `return ${body}`)(64, 3000);
  const stt = { targets: [], stack: [], bs: new THREE.Vector3() };
  const tBefore = collect([w.scene], new THREE.Vector3(R.LB_X + 110, 5, -(R.LB_Y + 80)), 10, stt).slice();
  IB.suppressLegacy(m);
  assert.equal(m.boundingSphere, IB.ibSentinel());
  assert.equal(Object.keys(m).includes("boundingSphere"), false, "non-enumerable");
  assert.equal(draws(false), 0, "projectObject skips it");
  assert.equal(draws(true), 0, "the shadow renderObject skips it");
  const childDraws = R.renderPass(w, R.MASK_BOTH).filter((r) => r.object === child).length;
  assert.equal(childDraws, 1, "projectObject still recurses into its children");
  assert.deepEqual(ray.intersectObject(m, false).map((h) => [h.distance, h.faceIndex]), hitsBefore, "raycast unchanged");
  assert.ok(new THREE.Box3().setFromObject(m).equals(boxBefore), "Box3.setFromObject unchanged");
  assert.deepEqual(collect([w.scene], new THREE.Vector3(R.LB_X + 110, 5, -(R.LB_Y + 80)), 10, stt).slice(), tBefore, "ragdoll targets unchanged");
  // A child light of a suppressed mesh is still collected: the lit draw's program has a point light.
  const pl = new THREE.PointLight(0xffffff, 1, 10);
  pl.layers.enableAll();
  m.add(pl);
  w.gl.__fake.startSnapshots();
  R.renderPass(w, R.MASK_BOTH);
  const snaps = w.gl.__fake.takeSnapshots();
  assert.ok(snaps.some((sn) => Object.keys(sn.uniforms).some((k) => k.startsWith("pointLights[0]"))), "the child PointLight lights the scene");
  IB.restoreLegacy(m);
  assert.equal(Object.prototype.hasOwnProperty.call(m, "boundingSphere"), false, "restore deletes the own property");
  assert.equal(draws(false), 1);
  // A candidate that turned frustumCulled off keeps its chunk legacy at activation.
  const w2 = await onWorld();
  frame(w2, true); // overlap
  const victim = legacyMeshes(w2).find((x) => /^cellstatic-a9b40100-02000011/.test(x.name));
  victim.frustumCulled = false;
  frame(w2, true);
  assert.notEqual(chunk().status, "active");
  assert.ok((S().stats.unitReasons["replan:frustum-culled-off"] || 0) >= 1);
  assert.ok(legacyMeshes(w2).every((x) => !Object.prototype.hasOwnProperty.call(x, "boundingSphere")));
});

// --- L5 ----------------------------------------------------------------------------
await t("L5 drift: same-page swap = slot rewrite only; page change = teardown in the sync; a recurring drift ends legacy", async () => {
  const w = await onWorld();
  frame(w); frame(w);
  assert.equal(chunk().status, "active");
  const member = w.mc.getCachedCellBaked(0x08000101);
  const e = S().slots.get(member);
  assert.ok(e && e.slot > 0, "premise: a live slot for the member");
  const geoms = chunk().batches.map((b) => b.geometry);
  const builds = S().stats.builds;
  // Same size / format / sampler: same page key.
  const px = new Uint8Array(32 * 32 * 4).fill(77);
  member.map = adapter.surfacePixelsToTexture(px, 32, 32);
  frame(w);
  assert.equal(chunk().status, "active", "no teardown");
  assert.equal(S().stats.slotRewrites, 1);
  assert.equal(S().stats.builds, builds, "no rebuild");
  assert.deepEqual(chunk().batches.map((b) => b.geometry), geoms, "no geometry re-upload");
  assert.equal(e.map, member.map);
  const layerRow = KIT.kitStateTable().rows.data[e.slot * 16 + 9];
  assert.equal(layerRow, e.mapRef.layer, "slot row carries the new layer");
  // A different size: a different page key -> teardown now, legacy in this frame's render.
  member.map = adapter.surfacePixelsToTexture(new Uint8Array(16 * 16 * 4).fill(9), 16, 16);
  R.tick(w.cells, w, w.sh);
  assert.equal(chunk().status === "active" || chunk().status === "overlap", false, "torn down in the sync");
  const recs = R.renderPass(w, R.MASK_BOTH);
  assert.ok(recs.some((r) => /^surfaces-fused-opaque-a9b40100/.test(r.object.name)), "legacy draws in the same frame");
  frame(w); frame(w);
  assert.equal(chunk().status, "active", "re-planned and back");
  // A drift that never settles: depthWrite flips (a signature change) every frame.
  let flips = 0;
  for (let i = 0; i < 40 && chunk().status !== "legacy"; i += 1) {
    member.depthWrite = !member.depthWrite;
    member.needsUpdate = true;
    flips += 1;
    frame(w);
  }
  assert.equal(chunk().status, "legacy");
  assert.equal(chunk().reason, "unstable");
  assert.ok(flips > 8);
  assert.ok(legacyMeshes(w).every((x) => !Object.prototype.hasOwnProperty.call(x, "boundingSphere")), "legacy restored");
});

// --- L6 ----------------------------------------------------------------------------
/** Batched legacy meshes of visible cells drawn by neither themselves nor every batch holding them. */
function holes(recs) {
  const drawn = new Set(recs.map((r) => r.object));
  let n = 0;
  for (const ch of rec().chunks) {
    for (const mi of ch.meshInfo) {
      let vis = false;
      for (let o = mi.mesh.parent; o; o = o.parent) if (o.userData && o.userData.isEnvCell) { vis = o.visible === true; break; }
      if (!vis || drawn.has(mi.mesh)) continue;
      if (![...mi.batches].every((k) => ch.batches[k].mesh && drawn.has(ch.batches[k].mesh))) n += 1;
    }
  }
  return n;
}
/** Draws of legacy meshes the chunk batched. */
function legacyBatched(recs) {
  const batched = new Set();
  for (const ch of rec().chunks) for (const mi of ch.meshInfo) batched.add(mi.mesh);
  return recs.filter((r) => batched.has(r.object)).length;
}

function assertReleased(w, what) {
  const st = S();
  const kit = KIT.kitSummary();
  assert.equal(kit.pages.live, 0, `${what}: no live layer`);
  assert.equal(st.slots.size, 0, `${what}: no slot entry`);
  assert.equal(kit.stateRows.used - 1 - KIT.kitStateTable().rows._free.length, 0, `${what}: every state row freed`);
  assert.equal(st.classMats.size, 0, `${what}: class materials released`);
  assert.equal(st.depthMats.size, 0, `${what}: depth materials released`);
  assert.equal(kit.budget.openTickets, 0, `${what}: no open ticket`);
  const root = st.root;
  assert.ok(!root || root.children.length === 0, `${what}: no orphan objects`);
  if (st.bits) assert.equal(st.bits.rowsUsed - 1 - st.bits._free.length, 0, `${what}: bit rows freed`);
}

await t("L6 evict / park / unpark through the real LandblockLRU, with and without the hook", async () => {
  {
    const { readFileSync } = await import("node:fs");
    const lruSrc = readFileSync(new URL("../scene3d/landblock_lru.js", import.meta.url), "utf8");
    for (const call of ['s.interiorBatchHooks?.detached?.(lbKey, "evict")', 's.interiorBatchHooks?.detached?.(lbKey, "park")', 's.interiorBatchHooks?.attached?.(lbKey)'])
      assert.ok(lruSrc.includes(call), `landblock_lru.js calls ${call}`);
  }
  for (const hook of [true, false]) {
    const w = await onWorld();
    frame(w); frame(w);
    assert.equal(chunk().status, "active");
    assert.equal(typeof w.scene3d.interiorBatchHooks?.detached, "function", "flag on: the hooks are installed");
    // Since 2026-10-31 the real LandblockLRU calls the hooks itself (landblock_lru.js evict / park / unpark).
    // The no-hook arm detaches them around each LRU call to keep the reconcile fallback covered.
    const lruOp = (fn) => {
      if (hook) return fn();
      const h = w.scene3d.interiorBatchHooks;
      w.scene3d.interiorBatchHooks = undefined;
      try { return fn(); } finally { w.scene3d.interiorBatchHooks = h; }
    };
    // park -> keep everything, nothing drawn; unpark -> drawn again.
    assert.equal(lruOp(() => w.lru.park(R.LB)), true);
    let recs = R.renderPass(w, R.MASK_BOTH);
    assert.equal(batchDraws(recs), hook ? 0 : batchDraws(recs), "park");
    if (!hook) assert.ok(batchDraws(recs) > 0, "without the hook: one ghost frame (LRU after the sync)");
    frame(w);
    assert.equal(batchDraws(R.renderPass(w, R.MASK_BOTH)), 0, "parked: nothing");
    assert.equal(rec().parked, true);
    assert.equal(chunk().status, "active", "park keeps the batch");
    lruOp(() => w.lru.unpark(R.LB));
    // App order: this frame's sync already ran, the LRU unparks, then the
    // render. Every batched mesh of a visible cell is drawn by its legacy
    // mesh or by all of its batch objects: never a hole.
    recs = R.renderPass(w, R.MASK_BOTH);
    assert.equal(holes(recs), 0, `${hook ? "hook" : "no hook"}: the unpark frame has no hole`);
    if (hook) assert.ok(batchDraws(recs) > 0 && legacyBatched(recs) === 0, "with the hook: the batch at once, legacy still handed over");
    else assert.ok(batchDraws(recs) === 0 && legacyBatched(recs) > 0, "without the hook: the legacy meshes for that one frame");
    frame(w);
    recs = R.renderPass(w, R.MASK_BOTH);
    assert.ok(batchDraws(recs) > 0, "unparked: drawn again");
    assert.equal(legacyBatched(recs), 0, "and handed over again (re-suppressed)");
    assert.equal(holes(recs), 0);
    assert.equal(S().stats.bitMismatch, 0);
    // evict -> everything released.
    assert.equal(lruOp(() => w.lru.evict(R.LB)), true);
    recs = R.renderPass(w, R.MASK_BOTH);
    if (hook) assert.equal(batchDraws(recs), 0, "with the hook: no ghost frame");
    else assert.ok(batchDraws(recs) > 0, "without the hook: exactly one ghost frame");
    frame(w);
    assert.equal(batchDraws(R.renderPass(w, R.MASK_BOTH)), 0);
    assert.equal(S().lbs.has(R.LB), false, "record gone");
    assertReleased(w, hook ? "evict (hook)" : "evict (reconcile)");
  }
});

// --- L7 ----------------------------------------------------------------------------
await t("L7 context loss + restore: torn down at the event, no GL delete on the dead generation, same bytes rebuilt", async () => {
  const w = await onWorld({ recordCalls: true });
  frame(w); frame(w);
  assert.equal(chunk().status, "active");
  const before = chunk().batches.map((b) => Array.from(b.geometry.attributes.position.array).concat(Array.from(b.geometry.attributes.hbIbCell.array.map((c) => c % 4096))));
  const mark = w.calls.length;
  let maxId = 0;
  for (const [, args] of w.calls) for (const a of args) if (a && typeof a === "object" && a.__id > maxId) maxId = a.__id;
  w.loseContext();
  assert.notEqual(chunk().status, "active", "torn down at the event");
  assert.ok(legacyMeshes(w).every((x) => !Object.prototype.hasOwnProperty.call(x, "boundingSphere")), "legacy back");
  frame(w, false); // a tick while lost
  w.restoreContext();
  frame(w); frame(w); frame(w);
  assert.equal(chunk().status, "active", "rebuilt on the restored context");
  const dead = w.calls.slice(mark).filter(([n, args]) => /^delete/.test(n) && args[0] && args[0].__id <= maxId);
  assert.deepEqual(dead.map(([n]) => n), [], "no delete of a lost-context object");
  const after = chunk().batches.map((b) => Array.from(b.geometry.attributes.position.array).concat(Array.from(b.geometry.attributes.hbIbCell.array.map((c) => c % 4096))));
  assert.deepEqual(after, before, "same bytes (cell / cast fields of the codes included)");
  assert.ok(S().stats.contextResets >= 1);
});

// --- L8 ----------------------------------------------------------------------------
await t("L8 budget: charged in the sync that adds it, landed by three's upload callbacks; a refusal allocates nothing; oversize alone", async () => {
  const w = await onWorld({ frustum: [] });
  frame(w);
  assert.equal(chunk().status, "building");
  const budget = KIT.kitBudget();
  budget.bytesPerFrame = 1000; // the fixture chunk (~3 KB) is over the whole cap
  // Another consumer's upload still pending: the oversize rule waits.
  budget.beginFrame("other");
  const other = budget.spendDeferred(900, "geometry");
  assert.ok(other);
  w.state.frustum = [R.CELL(0)];
  let recs = frame(w);
  assert.equal(chunk().status, "building", "refused: still building");
  assert.equal(S().stats.builds, 0, "nothing merged");
  assert.ok(chunk().batches.every((b) => !b.mesh && !b.geometry), "nothing allocated");
  assert.equal(batchDraws(recs), 0);
  assert.ok(recs.some((r) => /^surfaces-fused-opaque-a9b40100/.test(r.object.name)), "legacy keeps drawing");
  budget.land(other);
  // `other` has reached GL (landed): only a still-OPEN deferred upload holds
  // an oversize one back, so this frame admits the chunk alone.
  const oversize = budget.stats.oversize;
  const geoBefore = budget.stats.byKind.geometry;
  recs = frame(w);
  assert.equal(chunk().status, "overlap", "admitted alone");
  assert.equal(budget.stats.oversize, oversize + 1, "the oversize rule");
  assert.equal(budget.stats.byKind.geometry - geoBefore, chunk().bytes, "charged in the sync that added the objects");
  // The objects on screen uploaded at this render; the ones of hidden cells
  // upload (and land their bytes) at their first draw: carried until then.
  const ticket = chunk().ticket;
  assert.ok(ticket.remaining > 0 && ticket.remaining < chunk().bytes, "partly landed by three's upload callbacks");
  w.state.frustum = R.CELL_IDS.slice();
  frame(w);
  assert.equal(budget.openTickets(), 0, "every byte landed once every object drew");
  assert.ok(budget.stats.landed >= 2);
  assert.ok(budget.stats.timed.geometry >= 2 && budget.stats.phaseMs.geometryBuild >= 0, "S1 timings");
});

// --- L9 ----------------------------------------------------------------------------
await t("L9 walls-first: nothing registered before envCellLoadedLbs; a cancelled build registers nothing", async () => {
  for (const cancel of [false, true]) {
    const w = await onWorld({ build: false });
    let open;
    const gate = new Promise((r) => { open = r; });
    const l = console.log, wn = console.warn;
    console.log = () => {}; console.warn = () => {};
    let p;
    try {
      p = cellsOn.buildEnvCellsForLandblock(w.scene3d, R.LB, R.fakeWasm({ mmGate: gate }));
      await R.settle();
      assert.equal(w.scene3d.cellsGroup.children.length, 4, "walls attached");
      assert.equal(w.scene3d.envCellLoadedLbs.has(R.LB), false);
      assert.equal(IB.__interiorBatchLbsForTest(), null, "nothing registered yet");
      if (cancel) w.lru.evict(R.LB);
      open();
      await p;
    } finally { console.log = l; console.warn = wn; }
    if (cancel) {
      assert.equal(IB.__interiorBatchLbsForTest(), null, "the cancelled build registered nothing");
    } else {
      assert.equal(w.scene3d.envCellLoadedLbs.has(R.LB), true);
      assert.equal(rec().status, "pending");
      frame(w); frame(w);
      assert.equal(chunk().status, "active");
      assert.ok(chunk().batches.some((b) => b.kind === "props"), "the late statics are in the batch");
      // The stamp is invisible to serialisation: a container still clones / stringifies.
      const c0 = w.scene3d.cellContainers3d.get(R.CELL(0));
      assert.ok(c0.userData.__ib, "stamped");
      assert.equal(Object.keys(c0.userData).includes("__ib"), false, "non-enumerable");
      assert.doesNotThrow(() => JSON.stringify(c0.userData));
      assert.equal(c0.clone().userData.__ib, undefined, "a clone does not carry it");
    }
  }
});

// --- L10 ---------------------------------------------------------------------------
await t("L10 ?interiorBatch=plan: the census, no draw change, no stamp, no kit", async () => {
  const off = await (async () => {
    KIT.resetKit();
    const w = await R.makeWorld(deps);
    await R.build(cellsOff, w);
    w.state = { player: OUT, indoor: false, frustum: R.CELL_IDS.slice(), walk: [], bfs: [] };
    w.sh = R.makeSession(w.state);
    R.tick(cellsOff, w, w.sh);
    return drawnNames(R.renderPass(w, R.MASK_BOTH));
  })();
  const w = await onWorld({ mode: "plan", cells: cellsPlan });
  frame(w); frame(w);
  const recs = frame(w);
  assert.deepEqual(drawnNames(recs), off, "the plan census changes no draw");
  const plan = window.__interiorBatch.plan();
  assert.equal(plan.length, 1);
  const p = plan[0].plan;
  assert.deepEqual(p.candidates, { cells: 4, props: 4 });
  assert.deepEqual(p.eligible, { cells: 4, props: 3 });
  assert.equal(p.reasons["props:transparent"], 1);
  assert.ok(p.keys >= 4 && p.projectedDraws === p.keys && p.projectedBytes > 0 && p.chunks === 1);
  assert.ok([...w.scene3d.cellContainers3d.values()].every((c) => c.userData.__ib === undefined), "no stamps");
  const kit = KIT.kitSummary();
  assert.deepEqual([kit.budget, kit.pages, kit.stateRows], [null, null, null], "plan touches no kit");
  assert.equal(w.scene3d.interiorBatchHooks, undefined, "plan installs no LRU hook");
});

// --- L11 ---------------------------------------------------------------------------
await t("L11 the off seam and the wireframe disarm hand everything back, then re-arm", async () => {
  const w = await onWorld();
  frame(w); frame(w);
  assert.equal(chunk().status, "active");
  window.__interiorBatch.off = true;
  assert.equal(rec().chunks.every((c) => c.status === "legacy"), true);
  assert.equal(batchDraws(frame(w)), 0);
  assert.ok(legacyMeshes(w).every((x) => !Object.prototype.hasOwnProperty.call(x, "boundingSphere")));
  window.__interiorBatch.off = false;
  frame(w); frame(w); frame(w);
  assert.equal(chunk().status, "active", "re-armed");
  w.mc.wireframeMode = true;
  frame(w);
  assert.equal(S().disarmed, "wireframe");
  assert.equal(batchDraws(R.renderPass(w, R.MASK_BOTH)), 0);
  w.mc.wireframeMode = false;
  frame(w); frame(w); frame(w);
  assert.equal(chunk().status, "active", "back after the disarm");
  assert.equal(window.__interiorBatch.stats().disarmed.wireframe, 1);
  IB.disposeInteriorBatches();
  assert.equal(window.__interiorBatch, undefined, "dispose removes the global");
  assert.equal(w.scene3d.interiorBatchHooks, undefined, "and the hooks");
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
