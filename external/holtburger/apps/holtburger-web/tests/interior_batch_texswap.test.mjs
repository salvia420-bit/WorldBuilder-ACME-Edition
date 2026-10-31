// tests/interior_batch_texswap.test.mjs — texture swaps of `?interiorBatch`
// members (scene3d/gpu_batch/interior_batch.js "TEXTURE SWAPS"). Real boot,
// laptop, inside Holtburg room 0xA9B40121 (2026-10-31): textureReplans 8,
// teardowns 9, builds 1, activations 0 after 300 s, unitReasons
// {replan:map 8}: texture streaming swapped member maps one after another and
// every swap re-planned the chunk at once, only for the next swap to tear the
// rebuild down again. Real cells.js builds, real MaterialCache members, three
// r184's WebGLRenderer on the recording fake WebGL2 (tests/interior_batch_rig.mjs).
//
//   TS1 a burst of K swaps (each to another page key) on one chunk: the first
//       tears the chunk down in its sync, every swap frame's render draws the
//       new map through LEGACY (no batch draw), the chunk holds nothing while
//       it settles, and it re-plans exactly IB_TEXTURE_SETTLE_SYNCS after the
//       LAST swap: one teardown, one rebuild, textureReplans + 1, the other
//       K - 1 swaps coalesced; the rebuilt slots carry the latest maps.
//   TS2 a stream that never stops (a swap every 25 syncs, under the quiet
//       window) still re-plans: exactly IB_TEXTURE_SETTLE_MAX_SYNCS after
//       its first swap (no batch draw before), textureSettlesMaxed; the next
//       swap tears the rebuild down (counted: the cap counts rebuilds) and
//       opens a new wait; once the stream stops, one more rebuild.
//   TS3 a SAME-PAGE swap whose admit the frame's upload budget defers: the
//       chunk hands back in that sync (legacy draws the new map, no batch draw
//       of the stale layer), re-plans after the window onto the new content,
//       the old content released.
//   TS4 (regression guard: the in-place path predates this suite) a same-page
//       swap with room keeps the chunk ACTIVE, rewrites only the member's
//       state row (the new layer), releases the old content, no geometry /
//       teardown / rebuild, bits clean.
//   TS5 no leak: a swap that lands while the rebuild's geometry ticket is
//       still open (not uploaded yet) drops it in that sync; the chunk holds
//       no layer / slot / row / class / ticket / bit row for its whole settle;
//       dispose returns every content key the test touched to refcount <= 0.
//   TS6 a texchan ARRIVAL during a swap settle restarts the wait (coalesced,
//       not a second teardown, not counted in mapArrivals) and the re-plan
//       takes the new map AND the planes.
//
// TS1-TS3, TS5 and TS6 fail on the pre-change module (every swap re-planned
// at the next sync; a deferred same-page swap kept the batch drawing the
// stale layer): see the lane report for the run through a load hook.
//
// Run: node tests/interior_batch_texswap.test.mjs   (needs `three` resolvable)

import assert from "node:assert/strict";
import * as R from "./interior_batch_rig.mjs";

globalThis.window ??= {};
globalThis.location = { search: R.BASE_SEARCH };
globalThis.window.location = globalThis.location;
globalThis.window.requestAnimationFrame ??= () => 1;

const M = await import("../scene3d/materials.js");
const adapter = await import("../scene3d/adapter.js");
const KIT = await import("../scene3d/gpu_batch/kit.js");
const AP = await import("../scene3d/gpu_batch/array_pages.js");
const IB = await import("../scene3d/gpu_batch/interior_batch.js");
const deps = { M, adapter };
const cellsOn = await R.loadCells("interiorBatch=on");

// (`??`: the pre-change module has no such exports; the mutation run then
// fails on behaviour, not on an undefined constant.)
const SETTLE = IB.IB_TEXTURE_SETTLE_SYNCS ?? 60;
const MAX = IB.IB_TEXTURE_SETTLE_MAX_SYNCS ?? 600;

let failures = 0;
let passes = 0;
async function t(name, fn) {
  try { await fn(); passes++; console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name); console.log(e); }
}

const OUT = (R.LB | 0x31) >>> 0;
const INDOOR = () => ({ player: R.CELL(0), indoor: true, frustum: R.CELL_IDS, walk: R.CELL_IDS, bfs: [] });
async function onWorld(opts = {}) {
  KIT.resetKit();
  IB.disposeInteriorBatches();
  IB.__setInteriorBatchEnvForTest({ mode: "on", now: R.FROZEN_CLOCK });
  const w = await R.makeWorld(deps, opts);
  await R.build(cellsOn, w);
  w.state = opts.indoor ? INDOOR() : { player: OUT, indoor: false, frustum: R.CELL_IDS.slice(), walk: [], bfs: [] };
  w.sh = R.makeSession(w.state);
  return w;
}
const S = () => IB.__interiorBatchStateForTest();
const chunk = () => S().lbs.get(R.LB).chunks[0];
const stats = () => ({ ...S().stats });
const frame = (w, render = true) => { R.tick(cellsOn, w, w.sh); return render ? R.renderPass(w, R.MASK_BOTH) : []; };
const batchDraws = (recs) => recs.filter((r) => r.object.userData?.interiorBatch).length;
const live = (st) => st === "active" || st === "overlap";
/** The legacy draw of `member` with `tex` bound as its map (colour pass). */
const legacyDraws = (recs, member, tex) => recs.some((r) => !r.shadow && !r.object.userData?.interiorBatch && r.material === member && r.material.map === tex);
/** The chunk's live members (slot entries held by it). */
const liveMembers = () => [...S().slots.values()].filter((e) => e.chunks.has(chunk())).map((e) => e.member);

/** A fresh map for `member`: another size (another page key), or the same size (the same page key). */
function swapMap(member, seed, samePage = false) {
  const w0 = member.map.image.width;
  const s = samePage ? w0 : (w0 === 16 ? 32 : 16);
  const px = new Uint8Array(s * s * 4);
  for (let i = 0; i < px.length; i += 1) px[i] = (i * 13 + seed * 7 + 1) & 255;
  const tex = adapter.surfacePixelsToTexture(px, s, s);
  member.map = tex;
  return tex;
}

/** The chunk (the fixture's only one) holds nothing of the kit. */
function assertHoldsNothing(what) {
  const st = S();
  const kit = KIT.kitSummary();
  assert.equal(kit.pages.live, 0, `${what}: no live layer`);
  assert.equal(st.slots.size, 0, `${what}: no slot entry`);
  assert.equal(kit.stateRows.used - 1 - KIT.kitStateTable().rows._free.length, 0, `${what}: every state row freed`);
  assert.equal(st.classMats.size, 0, `${what}: class materials released`);
  assert.equal(st.depthMats.size, 0, `${what}: depth materials released`);
  assert.equal(kit.budget.openTickets, 0, `${what}: no open ticket`);
  assert.equal(chunk().row, -1, `${what}: no bit row`);
  if (st.bits) assert.equal(st.bits.rowsUsed - 1 - st.bits._free.length, 0, `${what}: bit rows freed`);
  assert.equal(chunk().batches.length, 0, `${what}: no batch`);
}

// --- TS1 ---------------------------------------------------------------------------
await t("TS1 a burst of K swaps on one chunk: one teardown, legacy draws each new map in its swap frame, ONE rebuild after the quiet window", async () => {
  const w = await onWorld();
  frame(w); frame(w);
  assert.equal(chunk().status, "active", "premise: active");
  const members = liveMembers();
  assert.ok(members.length >= 4, `premise: live members (${members.length})`);
  const s0 = stats();
  const K = 5;
  const GAP = 15; // syncs between two swaps, under the quiet window
  assert.ok(GAP * 2 < SETTLE, "premise: the gap is well inside the window");
  const last = new Map();
  let lastSwapFrame = -1;
  for (let k = 0; k < K; k += 1) {
    const m = members[k % 4]; // the 5th swaps the first member again (preview -> full -> ...)
    const before = IB.interiorTextureInfo(m.map).pageKey;
    const tex = swapMap(m, k);
    assert.notEqual(IB.interiorTextureInfo(tex).pageKey, before, "premise: another page key");
    last.set(m, tex);
    R.tick(cellsOn, w, w.sh); // the swap sync
    lastSwapFrame = S().frameNo;
    const recs = R.renderPass(w, R.MASK_BOTH);
    assert.equal(chunk().status, "pending", `swap ${k}: handed back in its sync`);
    assert.equal(batchDraws(recs), 0, `swap ${k}: no batch draw in that frame`);
    assert.ok(legacyDraws(recs, m, tex), `swap ${k}: legacy draws the new map in that frame`);
    assertHoldsNothing(`swap ${k}`);
    if (k === K - 1) break;
    for (let i = 1; i < GAP; i += 1) {
      const r = frame(w);
      assert.equal(chunk().status, "pending", `swap ${k} + ${i}: settling (no re-plan between swaps)`);
      assert.equal(batchDraws(r), 0, `swap ${k} + ${i}: legacy only`);
    }
  }
  for (let i = 1; i < SETTLE; i += 1) {
    frame(w, false);
    assert.equal(chunk().status, "pending", `last swap + ${i}: still settling`);
  }
  assert.equal(S().stats.builds, s0.builds, "no rebuild during the burst or its window");
  frame(w); // last swap + SETTLE: the re-plan (frozen clock: the whole chunk in this sync)
  assert.equal(S().frameNo - lastSwapFrame, SETTLE);
  assert.ok(live(chunk().status), `re-planned ${SETTLE} syncs after the last swap: ${chunk().status}`);
  frame(w);
  const d = S().stats;
  assert.equal(chunk().status, "active", "active again");
  assert.equal(d.builds - s0.builds, 1, "ONE rebuild");
  assert.equal(d.teardowns - s0.teardowns, 1, "one teardown");
  assert.equal(d.textureReplans - s0.textureReplans, 1, "the cap counts the rebuild once");
  assert.equal(d.textureSwapsCoalesced - (s0.textureSwapsCoalesced || 0), K - 1, "the other swaps coalesced");
  assert.equal(d.replans, s0.replans, "no other drift");
  for (const [m, tex] of last) {
    const e = S().slots.get(m);
    assert.ok(e && e.map === tex && e.mapRef.contentKey === AP.contentKeyOf(tex), "the rebuilt slot carries the latest map");
  }
  assert.equal(d.bitMismatch, 0);
  assert.equal(IB.interiorBatchDiag().settlingNow, 0);
});

// --- TS2 ---------------------------------------------------------------------------
await t("TS2 a swap stream longer than the max wait still re-plans (at the max), the next swap opens a new wait, one more rebuild after the stream", async () => {
  const w = await onWorld();
  frame(w); frame(w);
  assert.equal(chunk().status, "active", "premise: active");
  const m = liveMembers()[0];
  const s0 = stats();
  const GAP = 25;
  swapMap(m, 100);
  R.tick(cellsOn, w, w.sh);
  const F = S().frameNo;
  assert.equal(chunk().status, "pending");
  let rebuiltAt = -1;
  let tornAgainAt = -1;
  for (let f = 1; f <= MAX + 3 * GAP; f += 1) {
    if (f % GAP === 0) swapMap(m, 100 + f);
    R.tick(cellsOn, w, w.sh);
    const recs = R.renderPass(w, R.MASK_BOTH);
    const st = S().stats;
    if (rebuiltAt < 0 && st.builds > s0.builds) rebuiltAt = f;
    if (rebuiltAt < 0) {
      assert.equal(chunk().status, "pending", `stream + ${f}: waiting`);
      assert.equal(batchDraws(recs), 0, `stream + ${f}: legacy only`);
    } else if (tornAgainAt < 0 && st.textureReplans - s0.textureReplans === 2) tornAgainAt = f;
  }
  assert.equal(rebuiltAt, MAX, "re-planned at the max wait while the swaps kept coming");
  const d = S().stats;
  assert.equal(d.textureSettlesMaxed - (s0.textureSettlesMaxed || 0), 1, "one wait ended by the max");
  assert.ok(tornAgainAt > MAX && tornAgainAt <= MAX + GAP, `the next swap tore the rebuild down (${tornAgainAt})`);
  assert.equal(d.textureReplans - s0.textureReplans, 2, "two rebuilds, two counts");
  assert.equal(chunk().status, "pending", "a new wait");
  assert.equal(IB.interiorBatchDiag().settlingNow, 1);
  for (let i = 0; i < SETTLE + 3; i += 1) frame(w);
  assert.equal(chunk().status, "active", "the stream stopped: back");
  assert.equal(S().stats.builds - s0.builds, 2, "one rebuild per max window + one after the stream");
  assert.equal(S().slots.get(m).map, m.map, "the latest map");
  assert.equal(S().stats.bitMismatch, 0);
});

// --- TS3 ---------------------------------------------------------------------------
await t("TS3 a same-page swap the upload budget defers hands the chunk back in that sync (legacy draws the new map, no stale batch draw)", async () => {
  const w = await onWorld();
  frame(w); frame(w);
  assert.equal(chunk().status, "active", "premise: active");
  const member = w.mc.getCachedCellBaked(0x08000101);
  const e = S().slots.get(member);
  assert.ok(e && e.slot > 0, "premise: a live slot");
  const oldKey = e.mapRef.contentKey;
  const pages = KIT.kitPages(w.renderer);
  const budget = KIT.kitBudget();
  const s0 = stats();
  const def0 = pages.stats.deferred;
  const a0 = budget.admitsPerFrame;
  const tex = swapMap(member, 7, true);
  assert.equal(IB.interiorTextureInfo(tex).pageKey, e.mapRef.page.key, "premise: the same page key");
  let recs;
  budget.admitsPerFrame = 0; // this frame has no room for a layer
  try {
    R.tick(cellsOn, w, w.sh);
    recs = R.renderPass(w, R.MASK_BOTH);
  } finally { budget.admitsPerFrame = a0; }
  assert.ok(pages.stats.deferred > def0, "premise: the admit was deferred");
  assert.equal(live(chunk().status), false, `handed back in the sync (${chunk().status})`);
  assert.equal(batchDraws(recs), 0, "no batch draw of the stale layer");
  assert.ok(legacyDraws(recs, member, tex), "legacy draws the new map in that frame");
  assert.equal(S().stats.slotRewrites, s0.slotRewrites, "not rewritten in place");
  assert.equal(S().stats.textureReplans - s0.textureReplans, 1);
  for (let i = 1; i < SETTLE; i += 1) frame(w, false);
  assert.equal(chunk().status, "pending", "settling");
  frame(w); frame(w);
  assert.equal(chunk().status, "active", "re-planned after the window");
  const e1 = S().slots.get(member);
  assert.equal(e1.map, tex);
  assert.equal(e1.mapRef.contentKey, AP.contentKeyOf(tex), "the new content");
  assert.ok(pages.alloc.refCount(oldKey) <= 0, "the old content released");
  assert.equal(S().stats.bitMismatch, 0);
});

// --- TS4 ---------------------------------------------------------------------------
await t("TS4 (regression guard) a same-page swap with room: ACTIVE, only the member's state row rewritten, the old content released, nothing rebuilt", async () => {
  const w = await onWorld();
  frame(w); frame(w);
  assert.equal(chunk().status, "active", "premise: active");
  const member = w.mc.getCachedCellBaked(0x08000102);
  const e = S().slots.get(member);
  assert.ok(e && e.slot > 0, "premise: a live slot");
  const pages = KIT.kitPages(w.renderer);
  const oldKey = e.mapRef.contentKey;
  const rows = KIT.kitStateTable().rows;
  const fpr = rows.floatsPerRow;
  const before = Float32Array.from(rows.data);
  const geoms = chunk().batches.map((b) => b.geometry);
  const meshes = chunk().batches.map((b) => b.mesh);
  const s0 = stats();
  const tex = swapMap(member, 9, true);
  const recs = frame(w);
  const d = S().stats;
  assert.equal(chunk().status, "active", "no teardown");
  assert.equal(d.slotRewrites - s0.slotRewrites, 1, "rewritten in place");
  assert.deepEqual([d.builds, d.teardowns, d.textureReplans, d.replans], [s0.builds, s0.teardowns, s0.textureReplans, s0.replans]);
  assert.deepEqual(chunk().batches.map((b) => b.geometry), geoms, "no geometry change");
  assert.deepEqual(chunk().batches.map((b) => b.mesh), meshes, "the same batch objects");
  assert.equal(e.map, tex);
  assert.equal(e.mapRef.contentKey, AP.contentKeyOf(tex));
  assert.equal(pages.alloc.refCount(e.mapRef.contentKey), 1, "the new content held once");
  assert.ok(pages.alloc.refCount(oldKey) <= 0, "the old content released");
  assert.equal(rows.data.length, before.length);
  const changedRows = new Set();
  for (let i = 0; i < before.length; i += 1) if (rows.data[i] !== before[i] && !(Number.isNaN(rows.data[i]) && Number.isNaN(before[i]))) changedRows.add((i / fpr) | 0);
  assert.deepEqual([...changedRows], [e.slot], "only the member's state row changed");
  assert.equal(rows.data[e.slot * fpr + 9], e.mapRef.layer, "it carries the new layer");
  assert.ok(batchDraws(recs) > 0, "the batch draws");
  assert.ok(!recs.some((r) => !r.object.userData?.interiorBatch && r.material === member), "legacy stays handed over");
  assert.equal(d.bitMismatch, 0);
});

// --- TS5 ---------------------------------------------------------------------------
await t("TS5 no leak: an open rebuild ticket is dropped by the next swap; a settling chunk holds nothing for its whole wait; dispose -> every touched key <= 0", async () => {
  const w = await onWorld();
  frame(w); frame(w);
  assert.equal(chunk().status, "active", "premise: active");
  const pages = KIT.kitPages(w.renderer);
  const keys = new Set();
  const collect = () => { for (const e of S().slots.values()) for (const r of [e.mapRef, e.nrmRef, e.pomRef, e.aoRef, e.rghRef]) if (r) keys.add(r.contentKey); };
  collect();
  const [m0, m1] = liveMembers();
  swapMap(m0, 31);
  R.tick(cellsOn, w, w.sh);
  for (let i = 1; i < SETTLE; i += 1) {
    assertHoldsNothing(`settle + ${i - 1}`);
    frame(w, false);
  }
  assertHoldsNothing("settle end");
  frame(w, false); // the re-plan sync; no render: three has not uploaded the merged geometry
  assert.ok(live(chunk().status), "premise: rebuilt");
  assert.ok(chunk().ticket && KIT.kitBudget().isOpen(chunk().ticket), "premise: the rebuild's geometry ticket is open");
  collect();
  swapMap(m1, 32);
  R.tick(cellsOn, w, w.sh);
  assert.equal(chunk().status, "pending");
  assert.equal(KIT.kitBudget().openTickets(), 0, "the ticket dropped on the teardown");
  assertHoldsNothing("second swap");
  for (let i = 0; i < SETTLE + 2; i += 1) frame(w);
  assert.equal(chunk().status, "active");
  collect();
  assert.ok(keys.size >= 6, `premise: keys (${keys.size})`);
  IB.disposeInteriorBatches();
  for (const k of keys) assert.ok(pages.alloc.refCount(k) <= 0, `content ${k} released`);
  assert.equal(KIT.kitSummary().pages.live, 0, "no live layer");
  const rows = KIT.kitStateTable().rows;
  assert.equal(rows._next - 1 - rows._free.length, 0, "every state row freed");
  IB.__setInteriorBatchEnvForTest({ mode: "on", now: R.FROZEN_CLOCK });
});

// --- TS6 ---------------------------------------------------------------------------
await t("TS6 a texchan arrival during a swap settle restarts the wait (coalesced, no second teardown) and the re-plan takes map + planes", async () => {
  const w = await onWorld({ texchan: { late: true }, indoor: true });
  for (let f = 0; f < 4; f += 1) frame(w);
  assert.equal(chunk().status, "active", "premise: active");
  assert.equal(IB.interiorBatchDiag().mapSlots.ao, 0, "premise: no plane yet");
  const member = w.mc.getCachedCellBaked(0x08000105); // not a texchan surface: its own map swap
  const tex = swapMap(member, 61);
  const s0 = stats();
  R.tick(cellsOn, w, w.sh);
  const F = S().frameNo;
  assert.equal(chunk().status, "pending");
  for (let i = 0; i < 10; i += 1) {
    frame(w, false);
    assert.equal(chunk().status, "pending", `swap + ${i + 1}: settling`);
  }
  w.mc.__texchan.release();
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
  assert.ok(w.mc.getCachedCellBaked(R.TEXCHAN_DIDS[0]).aoMap, "premise: the planes reached the clones");
  frame(w, false);
  const A = S().frameNo;
  let d = S().stats;
  assert.equal(d.mapArrivals, s0.mapArrivals, "no arrival teardown");
  assert.equal(d.teardowns - s0.teardowns, 1, "the swap's teardown only");
  assert.ok(d.textureSwapsCoalesced - (s0.textureSwapsCoalesced || 0) >= 5, `the arrivals coalesced (${d.textureSwapsCoalesced})`);
  while (S().frameNo < F + SETTLE) frame(w, false);
  assert.equal(chunk().status, "pending", "the wait restarted at the arrival");
  while (S().frameNo < A + SETTLE - 1) frame(w, false);
  assert.equal(chunk().status, "pending");
  frame(w); frame(w);
  d = S().stats;
  assert.equal(chunk().status, "active", "re-planned once");
  assert.equal(d.builds - s0.builds, 1, "one rebuild");
  assert.equal(S().slots.get(member).map, tex, "the new map");
  assert.ok(IB.interiorBatchDiag().mapSlots.ao >= 5, `the planes too: ${JSON.stringify(IB.interiorBatchDiag().mapSlots)}`);
  assert.equal(d.bitMismatch, 0);
  IB.disposeInteriorBatches();
  IB.__setInteriorBatchEnvForTest(null);
  KIT.resetKit();
});

console.log(`\ninterior_batch_texswap: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
