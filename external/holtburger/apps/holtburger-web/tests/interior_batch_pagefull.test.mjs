// tests/interior_batch_pagefull.test.mjs — `?interiorBatch` when the kit
// pages refuse a layer (scene3d/gpu_batch/interior_batch.js "PAGE-FULL
// WAITS"; array_pages.js "WHY AN ADMIT WAS REFUSED"). The R3-5 laptop real
// boot (2026-10-31, Holtburg, quality low, `?interiorBatch=on`; smoke.json
// r3-ib-maps3): the kit pages sat at their byte cap, every new key was
// refused, unitReasons {replan:admit-failed 18}, legacyReasons
// {chunk:unstable 2}, objects 0 — each refusal tore the chunk down and
// counted toward BATCH_REPLAN_LIMIT, so both chunks went legacy for life.
// Real cells.js builds, real MaterialCache members, three r184 on the
// recording fake WebGL2 (tests/interior_batch_rig.mjs); the cap is held by
// another consumer's live layers (dummies acquired on the kit's own
// allocator), as the boot's pages were.
//
//   Q1  THE BOOT'S SEQUENCE: the cap full when the chunk admits; for more
//       than the 18 syncs that killed both boot chunks (and past
//       2 x (BATCH_REPLAN_LIMIT + 1)) the chunk WAITS in admitting — no
//       teardown, no re-plan, nothing legacy, the legacy meshes draw, the
//       allocator's refusal counter does not grow per sync (the poll asks
//       wouldAdmit); the other consumer releases (room: reclaimable pages)
//       and the chunk admits and goes ACTIVE with every member;
//   Q2  a cap that never frees: after IB_PAGEFULL_WAIT_SYNCS the refused
//       members stay legacy INDIVIDUALLY (every legacy mesh holding one
//       keeps drawing) and the rest of the chunk goes active; no re-plan;
//       room appears and, at the next IB_PAGEFULL_RETRY_SYNCS poll, the
//       chunk re-plans softly and batches every member (not counted);
//   Q3  a member the kit can never hold (a BC7 map on a context without
//       BPTC: "unsupported") stays legacy at once, without a wait, and is
//       never re-tried; the rest of the chunk goes active;
//   Q4  a context reset clears every page-full exclusion: the restored
//       pages take every member.
// Q1-Q3 fail on the pre-change tree (each refusal re-planned: chunk:unstable).
//
// Run: node tests/interior_batch_pagefull.test.mjs   (needs `three` resolvable)

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
const { BATCH_REPLAN_LIMIT } = await import("../scene3d/gpu_batch/anim_scenery_batch.js");
const { makeBc7Texture } = await import("../scene3d/bc7_textures.js");
const { LandblockLRU } = await import("../scene3d/landblock_lru.js");
const cellsOn = await R.loadCells("interiorBatch=on");
const deps = { M, adapter };

const WAIT = IB.IB_PAGEFULL_WAIT_SYNCS ?? 120;
const RETRY = IB.IB_PAGEFULL_RETRY_SYNCS ?? 600;
const BOOT_REPLANS = 18;

let failures = 0;
let passes = 0;
async function t(name, fn) {
  try { await fn(); passes++; console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name); console.log(e); }
}

// --- helpers (the lifecycle suite's world) ---------------------------------------
const OUT = (R.LB | 0x31) >>> 0;
async function onWorld(before = null) {
  KIT.resetKit();
  IB.disposeInteriorBatches();
  IB.__setInteriorBatchEnvForTest({ mode: "on", now: R.FROZEN_CLOCK });
  const w = await R.makeWorld(deps, {});
  const lru = new LandblockLRU({ scene3d: w.scene3d, maxResident: 64, getCurrentLbId: () => 0 });
  w.scene3d.landblockLru = lru;
  lru.track(R.LB);
  if (before) await before(w);
  await R.build(cellsOn, w);
  w.state = { player: OUT, indoor: false, frustum: R.CELL_IDS.slice(), walk: [], bfs: [] };
  w.sh = R.makeSession(w.state);
  return w;
}
const S = () => IB.__interiorBatchStateForTest();
const rec = () => S().lbs.get(R.LB);
const chunk = () => rec().chunks[0] || { status: rec().status, reason: rec().reason }; // no chunk before the first sync
const diag = () => IB.interiorBatchDiag();
const quiet = (fn) => { const wn = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = wn; } };
const frame = (w, render = true) => quiet(() => { R.tick(cellsOn, w, w.sh); return render ? R.renderPass(w, R.MASK_BOTH) : null; });
const legacyMeshes = (w) => {
  const out = [];
  for (const c of w.scene3d.cellContainers3d.values()) c.traverse((o) => { if (o.isMesh && /^(surfaces-fused-opaque|cellstatic-)/.test(o.name)) out.push(o); });
  return out;
};
const suppressed = (m) => m.boundingSphere === IB.ibSentinel();
/** The legacy meshes the batch can take (cell 3's prop carries a translucent surface: legacy by design). */
const batchable = (w) => legacyMeshes(w).filter((m) => !/^cellstatic-a9b40103/.test(m.name));
/** Members of the chunk's current plan. */
const planned = () => {
  const s = new Set();
  for (const cp of chunk().cellPlans) for (const mp of cp.meshes) for (const e of mp.entries) s.add(e.member);
  return s;
};

const DUMMY = {
  format: "rgba8", width: 8, height: 8, levels: 4, colorSpace: THREE.SRGBColorSpace,
  wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, minFilter: THREE.LinearMipmapLinearFilter,
  magFilter: THREE.LinearFilter, anisotropy: 1,
};
/**
 * Another consumer holds every byte of the cap: live layers of a key no
 * fixture member uses, up to `bytes`, then the cap shrunk to what is reserved
 * and every free layer of every page taken. Returns the dummy content keys.
 */
function fillCap(alloc, bytes = 256 * 1024) {
  const keys = [];
  alloc.maxBytes = alloc.bytes + bytes;
  while (alloc.wouldAcquire(DUMMY, `dummy${keys.length}`)) { assert.ok(alloc.acquire(DUMMY, `dummy${keys.length}`)); keys.push(`dummy${keys.length}`); }
  alloc.maxBytes = alloc.bytes;
  for (const p of [...alloc.pages]) while (p.free.length > 0) { const ck = `dummy${keys.length}`; assert.ok(alloc.acquire(p.desc, ck)); keys.push(ck); }
  return keys;
}

// --- Q1 ----------------------------------------------------------------------------
await t("Q1 the boot's sequence: the cap full at admission -> the chunk waits (no teardown, no re-plan); room appears -> active with every member", async () => {
  let alloc = null;
  let dummies = null;
  const w = await onWorld(async (w0) => {
    alloc = KIT.kitPages(w0.renderer).alloc; // the pages the batch will use (same renderer)
    dummies = fillCap(alloc);
  });
  const cap0 = 128 * 1024 * 1024;
  frame(w);
  assert.equal(chunk().status, "admitting", `waiting: ${chunk().status} ${chunk().reason}`);
  const refused0 = alloc.stats.refused;
  assert.ok(refused0 > 0, "premise: the cap refused the chunk's layers");
  const syncs = Math.max(BOOT_REPLANS, 2 * (BATCH_REPLAN_LIMIT + 1)) + 6;
  let recs = null;
  for (let i = 0; i < syncs; i += 1) recs = frame(w);
  let d = diag();
  assert.equal(chunk().status, "admitting", `still waiting after ${syncs} syncs: ${chunk().status} ${chunk().reason}`);
  assert.deepEqual(d.legacyReasons, {}, "nothing legacy");
  assert.equal(d.replans, 0, "no re-plan");
  assert.equal(d.unitReasons["replan:admit-failed"], undefined, JSON.stringify(d.unitReasons));
  assert.equal(d.teardowns, 0, "no teardown");
  assert.equal(d.pageFull.waits, 1);
  assert.equal(d.pageFull.waitingNow, 1);
  assert.equal(alloc.stats.refused, refused0, "the wait polls wouldAdmit: no refusal counted per sync");
  assert.ok(legacyMeshes(w).every((m) => !suppressed(m)), "legacy untouched");
  assert.ok(recs.some((r) => /^surfaces-fused-opaque/.test(r.object.name)) && recs.some((r) => /^cellstatic-/.test(r.object.name)), "legacy draws");
  // The other consumer departs: its layers idle. The cap stays where it is:
  // the only room is the departed layers' pages (reclaimable, idle-only).
  for (const ck of dummies) alloc.release(ck);
  void cap0;
  for (let i = 0; i < 6 && chunk().status !== "active"; i += 1) recs = frame(w);
  d = diag();
  assert.equal(chunk().status, "active", `active: ${chunk().status} ${JSON.stringify(d.chunks)}`);
  assert.equal(d.pageFull.admittedAfterWait, 1);
  assert.equal(d.pageFull.waitingNow, 0);
  assert.equal(d.pageFull.excludedNow, 0, "every member batched");
  assert.equal(d.pageFull.legacyMembers, 0);
  assert.equal(d.replans, 0);
  assert.ok(batchable(w).every(suppressed), "every batchable legacy mesh handed over");
  assert.ok(recs.some((r) => r.object.userData?.interiorBatch), "the batch draws");
  assert.ok(alloc.stats.reclaimedPages > 0 || alloc.stats.evictions > 0, "the departed layers made the room");
});

// --- Q2 ----------------------------------------------------------------------------
await t("Q2 a cap that never frees: after the bounded wait the refused members stay legacy individually, the rest batch; room -> the retry batches all", async () => {
  let alloc = null;
  let dummies = null;
  const held = [];
  const w = await onWorld(async (w0) => {
    const pages = KIT.kitPages(w0.renderer);
    alloc = pages.alloc;
    // Another consumer already holds the props' textures (the 16x16 surfaces): resident, live.
    for (const did of [0x08000111, 0x08000112]) {
      const tex = w0.mc.materials.get(did).map;
      const r = pages.admit(tex, null);
      assert.ok(r && r.page, "premise: pre-admitted");
      held.push(r.contentKey);
    }
    dummies = fillCap(alloc);
  });
  frame(w);
  assert.equal(chunk().status, "admitting", "premise: waiting on the cap");
  for (let i = 0; i < WAIT + 4 && chunk().status === "admitting"; i += 1) frame(w);
  for (let i = 0; i < 6 && chunk().status !== "active"; i += 1) frame(w);
  let d = diag();
  assert.equal(chunk().status, "active", `the rest goes active: ${chunk().status} ${chunk().reason} ${JSON.stringify(d.chunks)}`);
  assert.equal(d.replans, 0, "not a re-plan");
  assert.deepEqual(d.legacyReasons, {});
  assert.ok(d.pageFull.legacyMembers >= 3 && d.pageFull.excludedNow === d.pageFull.legacyMembers, JSON.stringify(d.pageFull));
  const lm = legacyMeshes(w);
  const props = lm.filter((m) => /^cellstatic-/.test(m.name) && m.material && (Array.isArray(m.material) ? m.material : [m.material]).every((x) => x.map && held.includes(`${x.map.uuid}:${x.map.version}`)));
  const fused = lm.filter((m) => /^surfaces-fused-opaque/.test(m.name));
  assert.ok(props.length >= 2, `premise: props of the pre-admitted surfaces (${props.length})`);
  assert.ok(props.every(suppressed), "the props whose layers fit: batched");
  assert.ok(fused.length > 0 && fused.every((m) => !suppressed(m)), "every mesh holding a refused member: legacy, drawn");
  const recs = frame(w);
  assert.ok(fused.every((m) => recs.some((r) => r.object === m)), "they draw");
  // Room appears; the retry comes at the next poll after IB_PAGEFULL_RETRY_SYNCS.
  for (const ck of dummies) alloc.release(ck);
  alloc.maxBytes = 128 * 1024 * 1024;
  frame(w);
  assert.ok(d.pageFull.excludedNow > 0 && diag().pageFull.excludedNow > 0, "no retry before the period");
  for (let i = 0; i < RETRY + 2 * 60 && diag().pageFull.excludedNow > 0; i += 1) frame(w, false);
  for (let i = 0; i < 8 && chunk().status !== "active"; i += 1) frame(w);
  d = diag();
  assert.equal(chunk().status, "active", `${chunk().status} ${chunk().reason}`);
  assert.equal(d.pageFull.excludedNow, 0, "every member batched");
  assert.ok(d.pageFull.retries >= 1);
  assert.equal(d.replans, 0, "the retry is not churn");
  assert.ok(batchable(w).every(suppressed), "every batchable legacy mesh handed over");
  for (const ck of held) alloc.release(ck);
});

// --- Q3 ----------------------------------------------------------------------------
await t("Q3 a member the kit can never hold stays legacy at once (no wait, never re-tried); the rest goes active", async () => {
  let bc7 = null;
  const w = await onWorld(async (w0) => {
    // A BC7 map on a context without EXT_texture_compression_bptc: describeTexture
    // admits it (eligible), the pages cannot (internal format: "unsupported").
    const levels = [];
    for (let s = 64; ; s = Math.max(1, s >> 1)) { levels.push({ data: new Uint8Array(Math.ceil(s / 4) * Math.ceil(s / 4) * 16), width: s, height: s }); if (s === 1) break; }
    bc7 = makeBc7Texture({ width: 64, height: 64, levels });
    const base = w0.mc.materials.get(0x08000105);
    base.map = bc7;
    base.needsUpdate = true;
  });
  const member = w.mc.getCachedCellBaked(0x08000105);
  assert.equal(member.map, bc7, "premise: the clone draws the BC7 map");
  assert.equal(IB.interiorArrayReason(member), null, "premise: eligible");
  for (let i = 0; i < 6 && chunk().status !== "active"; i += 1) frame(w);
  let d = diag();
  assert.equal(chunk().status, "active", `${chunk().status} ${chunk().reason} ${JSON.stringify(d.unitReasons)}`);
  assert.equal(d.pageFull.waits, 0, "no wait");
  assert.equal(d.pageFull.neverFit, 1);
  assert.equal(d.replans, 0);
  assert.ok(!planned().has(member), "out of the plan");
  const lm = batchable(w);
  const holder = lm.find((m) => /^surfaces-fused-opaque-a9b40102/.test(m.name));
  assert.ok(holder && !suppressed(holder), "the mesh holding it stays legacy");
  assert.ok(lm.filter((m) => m !== holder).every(suppressed), "every other batched mesh handed over");
  for (let i = 0; i < RETRY + 2 * 60; i += 1) frame(w, false);
  d = diag();
  assert.equal(d.pageFull.retries, 0, "never re-tried");
  assert.equal(chunk().status, "active");
});

// --- Q4 ----------------------------------------------------------------------------
await t("Q4 a context reset clears the page-full exclusions: the restored pages take every member", async () => {
  let alloc = null;
  const w = await onWorld(async (w0) => { alloc = KIT.kitPages(w0.renderer).alloc; fillCap(alloc); });
  frame(w);
  assert.equal(chunk().status, "admitting", "premise: waiting on the cap");
  for (let i = 0; i < WAIT + 4 && chunk().status === "admitting"; i += 1) frame(w);
  let d = diag();
  assert.equal(chunk().status, "pending", "premise: every member out for the cap: the chunk waits holding nothing");
  assert.ok(d.pageFull.excludedNow > 0 && d.pageFull.idleWaits >= 1, `premise: excluded (${JSON.stringify(d.pageFull)})`);
  assert.deepEqual(d.legacyReasons, {}, "not legacy");
  w.loseContext();
  frame(w, false);
  alloc.maxBytes = 128 * 1024 * 1024; // the other consumer's hold went with the lost pages; the cap as stated
  w.restoreContext();
  for (let i = 0; i < 8 && chunk().status !== "active"; i += 1) frame(w);
  d = diag();
  assert.equal(chunk().status, "active", `${chunk().status} ${chunk().reason}`);
  assert.equal(d.pageFull.excludedNow, 0, "every member on the fresh pages");
  assert.ok(batchable(w).every(suppressed));
  IB.disposeInteriorBatches();
  IB.__setInteriorBatchEnvForTest(null);
  KIT.resetKit();
});

console.log(`\ninterior_batch_pagefull: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
