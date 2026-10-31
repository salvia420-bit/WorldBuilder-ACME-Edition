// tests/entity_batch_realboot.test.mjs — R3-4 `?entityBatch` after the first
// REAL app boot (2026-10-31, laptop SwiftShader, Holtburg spawn, 60 rigs;
// /mnt/.../perf/rust-boot-smoke-r3-batch-on/smoke.json): the footprint, the
// page-full refusals and the recovery after a GL context loss. On the shared
// world of tests/entity_batch_rig.mjs (the REAL EntityManager spawning
// 17-part rigs, three r184 over the recording fake WebGL2) and on the kit
// allocator directly.
//
//   1. equal composites of TWO SURFACES share one layer (the value key is
//      bytes + page key, no surface DID); the same bytes under another
//      sampler state never share;
//   2. a composite whose legacy 2D texture is already resident (the legacy
//      leaves drew first, as in the app) is copied from that texture's OWN
//      levels: no scratch upload (no texStorage2D / texSubImage2D /
//      generateMipmap during the admission), every copy reads the legacy GL
//      texture, and a layer costs exactly the legacy texture's bytes (the
//      same levels, no 2x);
//   3. a cap refusal books no budget bytes (the real boot booked 65 MB of
//      bytes the allocator then refused);
//   4. the kit allocator at the cap: default options refuse as before; the
//      opt-in `fitToCap` makes a smaller page, `reclaimIdle` destroys
//      idle-only pages (never a page with a live layer); `wouldAcquire`
//      agrees with `acquire` over a seeded random run; the kit pages carry
//      both and the stated cap (128 MiB, `?gpuBatchVramMB`);
//   5. page exhaustion never refuses a whole rig: under a small cap a rig
//      keeps its refused leaves legacy and batches the rest, a rig left with
//      fewer than two leaves WAITS holding no layer (`pageFull`), nothing is
//      churn or legacy; when the cap frees, the waiting rig and (after
//      ENTITY_BATCH_PAGEFULL_RETRY_FRAMES) the partial rig batch every leaf;
//   6. recovery: one reset per transition (not per tick while lost), with
//      `stats().context`; after a loss + restore every rig re-plans at the
//      FIRST sync and is batched again within 10 frames — with every leaf,
//      even the ones the full cap refused before the loss — also when the
//      batch saw no canvas event at all;
//   7. layers only for leaves that draw: a hidden (culled) rig admits
//      nothing until it is seen; an active rig hidden for
//      ENTITY_BATCH_HIDDEN_HOLD_FRAMES frees its batch;
//   8. (guard) translucent / luminous leaves never get a layer;
//   9. `stats().footprint` against the cap.
// Checks 1-7 and 9 fail on the pre-change tree.
//
// Run from apps/holtburger-web/:  node tests/entity_batch_realboot.test.mjs

import * as R from "./entity_batch_rig.mjs";
import assert from "node:assert/strict";

const { THREE, EB, KIT, D, ADAPTER } = R;
const AP = await import("../scene3d/gpu_batch/array_pages.js");
const PA = await import("../scene3d/gpu_batch/page_allocator.js");
const UB = await import("../scene3d/gpu_batch/upload_budget.js");
const { createFakeWebGL2, fakeCanvas } = await import("./helpers/fake_webgl2.mjs");
const { check, done } = R.suite("entity_batch_realboot");

await check("0. the batch module exists", () => R.requireBatch());

const PAL = (k) => ({ paletteId: 0x04000b00 + k, subPalettes: Uint32Array.of(0x0400aa00 + k, 0, 8) });
const eb = (w) => w.em._entityBatch;
/** Members a fully planned fixture rig batches (A, A2, B, C, E, H1, H2, CLIP). */
const FULL_MEMBERS = 8;
/** The plan's legacy candidates the cap refused. */
const pageFullLeaves = (b) => (b.plan ? b.plan.legacy.filter((c) => c.reason === "pageFull").length : 0);

function rgbaDesc(w, h, extra = {}) {
  return {
    format: "rgba8", width: w, height: h, levels: PA.fullMipLevels(w, h), colorSpace: THREE.SRGBColorSpace,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter, anisotropy: 1, ...extra,
  };
}
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

await check("1. equal composites of two surfaces share one layer; another sampler state never does", async () => {
  const w = await R.world(true);
  // The recolored path: surface A2 composes to EXACTLY A's bytes (two
  // surfaces of one texture under one palette, as AC's shared SurfaceTextures do).
  const orig = w.wasm.fetchEntitySurfacesPixels;
  w.wasm.fetchEntitySurfacesPixels = async (dids, paletteId) => {
    const out = await orig(dids, paletteId);
    const a = out.find((_, i) => (dids[i] >>> 0) === D.A);
    return out.map((s, i) => ((dids[i] >>> 0) === D.A2 && a ? { ...s, pixels: a.pixels.slice() } : s));
  };
  const inst = await w.spawn(0x55000101, 10, 10, 0, PAL(1));
  w.settle();
  assert.equal(inst._hbBatch.status, "active");
  const leafA = R.leavesOf(inst).find((l) => l.userData.surfaceDid === D.A);
  const leafA2 = R.leavesOf(inst).find((l) => l.userData.surfaceDid === D.A2);
  assert.notEqual(leafA.material, leafA2.material, "two surfaces: two materials");
  assert.notEqual(leafA.material.map, leafA2.material.map, "and two textures");
  const rowA = inst._hbBatch.plan.memberRefs.get(leafA.material);
  const rowA2 = inst._hbBatch.plan.memberRefs.get(leafA2.material);
  assert.equal(rowA.contentKey, rowA2.contentKey, "one value key");
  assert.equal(rowA.page, rowA2.page);
  assert.equal(rowA.layer, rowA2.layer, "one layer");
  const s = eb(w).stats();
  assert.equal(s.kit.pages.live, FULL_MEMBERS - 1, "7 layers for 8 members");
  assert.ok(s.layers.crossSurfaceJoins >= 1, JSON.stringify(s.layers));
  // The same bytes under another wrap: another page key, another value key.
  const keys = new EB.PaletteKeys();
  const px = leafA.material.map.image.data.slice();
  const t1 = ADAPTER.surfacePixelsToTexture(px, 64, 64);
  const t2 = ADAPTER.surfacePixelsToTexture(px.slice(), 64, 64);
  t2.wrapT = THREE.ClampToEdgeWrapping;
  assert.notEqual(keys.keyFor(t1, D.A), keys.keyFor(t2, D.A), "another sampler state never shares");
});

await check("2. a resident legacy composite is copied from its own levels: no scratch upload, the legacy bytes exactly", async () => {
  const calls = [];
  let recording = false;
  const w = await R.world(true, { onCall: (n, a) => { if (recording) calls.push([n, Array.from(a)]); } });
  const inst = await w.spawn(0x55000201, 10, 10, 0, PAL(2));
  // The app's order: the legacy leaves draw before the batch plans (three uploads the composites).
  recording = true;
  w.renderer.render(w.scene, w.camera);
  recording = false;
  const legacyStorage = new Map(); // "WxH" -> levels three allocated
  for (const [n, a] of calls) if (n === "texStorage2D" && a[0] === w.gl.TEXTURE_2D) legacyStorage.set(`${a[3]}x${a[4]}`, a[1]);
  assert.ok(legacyStorage.size >= 5, `legacy uploads seen: ${[...legacyStorage.keys()]}`);
  const legacyGl = new Set();
  for (const l of R.leavesOf(inst)) {
    const p = w.renderer.properties.get(l.material.map);
    if (p && p.__webglTexture) legacyGl.add(p.__webglTexture);
  }
  calls.length = 0;
  recording = true;
  w.tickOnly(); // the plan + every admission (16 admits a frame)
  recording = false;
  const b = inst._hbBatch;
  assert.ok(b.status === "warming" || b.status === "building" || b.status === "overlap" || b.status === "active", b.status);
  const names = calls.map((c) => c[0]);
  assert.equal(names.filter((n) => n === "texStorage2D").length, 0, "no 2D texture allocated (no scratch)");
  assert.equal(names.filter((n) => n === "texSubImage2D" || n === "texImage2D").length, 0, "no 2D upload");
  assert.equal(names.filter((n) => n === "generateMipmap").length, 0, "no re-mip: the legacy texture's own levels");
  const attaches = calls.filter((c) => c[0] === "framebufferTexture2D" && c[1][3]);
  assert.ok(attaches.length > 0);
  for (const [, a] of attaches) assert.ok(legacyGl.has(a[3]), "every copy reads a legacy GL texture");
  const st = eb(w).stats().layers;
  assert.equal(st.fromLegacy, FULL_MEMBERS, JSON.stringify(st));
  assert.equal(st.scratch, 0);
  // A layer costs exactly what three allocated for the legacy texture.
  let copies = 0;
  for (const row of b.plan.memberRefs.values()) {
    const d = row.page.desc;
    const levels = legacyStorage.get(`${d.width}x${d.height}`);
    assert.equal(d.levels, levels, `${d.width}x${d.height}: the legacy chain`);
    let bytes = 0;
    for (let l = 0; l < levels; l += 1) { const [lw, lh] = PA.levelSize(d.width, d.height, l); bytes += lw * lh * 4; }
    assert.equal(row.page.layerBytes, bytes, "layer bytes = the legacy texture's bytes");
    copies += levels;
  }
  assert.equal(names.filter((n) => n === "copyTexSubImage3D").length, copies, "one GPU copy per level per layer");
  w.settle();
  assert.equal(b.status, "active");
  const v = eb(w).verify();
  assert.deepEqual([v.rowMismatches, v.stateMismatches, v.parkMismatches, v.attrMismatches], [0, 0, 0, 0]);
});

await check("3. a cap refusal books no budget bytes", () => {
  const gl = createFakeWebGL2();
  const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
  const big = ADAPTER.surfacePixelsToTexture(new Uint8Array(64 * 64 * 4).fill(3), 64, 64);
  const small = ADAPTER.surfacePixelsToTexture(new Uint8Array(8 * 8 * 4).fill(4), 8, 8);
  const lbSmall = PA.layerBytesOf(AP.describeTexture(small));
  const pages = new AP.ArrayPages(renderer, { pageBytes: 1, minLayers: 1, maxLayers: 1, maxBytes: lbSmall });
  const budget = new UB.UploadBudget({ bytesPerFrame: 1 << 20, admitsPerFrame: 4 });
  budget.beginFrame(1);
  assert.equal(pages.admit(big, budget), null, "the cap refuses the 64x64 layer");
  assert.equal(budget.stats.byKind.layer, 0, "nothing booked for it");
  assert.equal(budget.remainingBytes(), 1 << 20);
  assert.equal(budget.spentAdmits, 0);
  const r = pages.admit(small, budget);
  assert.ok(r && r.page, "a layer that fits");
  assert.equal(budget.stats.byKind.layer, lbSmall, "only the granted layer is booked");
  assert.equal(pages.stats.admitBytes, lbSmall);
});

await check("4. the allocator at the cap: fit, reclaim idle-only pages, never a live one; wouldAcquire = acquire; the kit's cap", () => {
  const d = rgbaDesc(64, 64);
  const lb = PA.layerBytesOf(d);
  // Default options: as before (the growth page does not fit -> refused).
  const OLD = new PA.PageAllocator({ pageBytes: lb * 4, minLayers: 4, maxLayers: 64, maxBytes: lb * 12 });
  for (let i = 0; i < 10; i += 1) assert.ok(OLD.acquire(d, `o${i}`));
  assert.equal(OLD.acquire(d, "o10"), null, "pages 4 + 6, the 9-layer page passes the cap");
  // fitToCap: a smaller page, until the cap is full.
  const FIT = new PA.PageAllocator({ pageBytes: lb * 4, minLayers: 4, maxLayers: 64, maxBytes: lb * 12, fitToCap: true });
  for (let i = 0; i < 10; i += 1) assert.ok(FIT.acquire(d, `f${i}`));
  assert.equal(FIT.wouldAcquire(d, "f10"), true);
  const e10 = FIT.acquire(d, "f10");
  assert.ok(e10, "fitted");
  assert.equal(e10.page.capacity, 1, "half of the 2 layers left");
  assert.ok(FIT.acquire(d, "f11"), "the last layer");
  assert.equal(FIT.wouldAcquire(d, "f12"), false);
  assert.equal(FIT.acquire(d, "f12"), null, "cap full");
  assert.ok(FIT.bytes <= FIT.maxBytes);
  assert.ok(FIT.stats.fitted >= 2);
  assert.deepEqual(FIT.verify(), []);
  // reclaimIdle: idle-only pages of another key go; a page with a live layer stays.
  const dy = rgbaDesc(32, 32);
  const destroyed = [];
  const REC = new PA.PageAllocator({ pageBytes: lb * 4, minLayers: 4, maxLayers: 4, maxBytes: lb * 8, reclaimIdle: true, onPageDestroy: (p) => destroyed.push(p.id) });
  const xs = [];
  for (let i = 0; i < 8; i += 1) xs.push(REC.acquire(d, `x${i}`));
  const p1 = xs[0].page, p2 = xs[4].page;
  assert.notEqual(p1, p2);
  for (let i = 0; i < 4; i += 1) REC.release(`x${i}`); // page 1 all idle
  REC.release("x4"); // page 2 keeps 3 live layers
  assert.equal(REC.reclaimableBytes(), 4 * lb);
  assert.equal(REC.wouldAcquire(dy, "y0"), true);
  const y = REC.acquire(dy, "y0");
  assert.ok(y, "the idle-only page was reclaimed for the new key");
  assert.deepEqual(destroyed, [p1.id], "only the idle-only page");
  assert.equal(REC.lookup("x0"), null, "its idle content evicted");
  assert.ok(REC.lookup("x5"), "live content untouched");
  assert.equal(REC.stats.reclaimedPages, 1);
  assert.deepEqual(REC.verify(), []);
  // wouldAcquire agrees with acquire, both options on, over a seeded run.
  const descs = [rgbaDesc(64, 64), rgbaDesc(32, 64), rgbaDesc(16, 16, { wrapS: THREE.ClampToEdgeWrapping }), rgbaDesc(128, 128)];
  const A = new PA.PageAllocator({ pageBytes: 64 * 1024, minLayers: 2, maxLayers: 9, maxBytes: 600 * 1024, reclaimIdle: true, fitToCap: true });
  const r = rng(0xcafe);
  const held = new Map();
  let refusals = 0, grants = 0;
  for (let i = 0; i < 3000; i += 1) {
    if (r() < 0.6) {
      const dd = descs[Math.floor(r() * descs.length)];
      const ck = `c${Math.floor(r() * 90)}|${PA.pageKeyOf(dd)}`;
      const would = A.wouldAcquire(dd, ck);
      const e = A.acquire(dd, ck);
      assert.equal(!!e, would, `op ${i}: wouldAcquire ${would}, acquire ${!!e}`);
      if (e) { grants += 1; held.set(ck, (held.get(ck) || 0) + 1); } else refusals += 1;
    } else {
      const ks = [...held.keys()];
      if (ks.length) {
        const ck = ks[Math.floor(r() * ks.length)];
        A.release(ck);
        const n = held.get(ck) - 1;
        if (n === 0) held.delete(ck); else held.set(ck, n);
      }
    }
    const bad = A.verify();
    assert.deepEqual(bad, [], `op ${i}: ${bad.slice(0, 3).join("; ")}`);
    for (const [ck, n] of held) assert.ok(A.refCount(ck) >= n, `${ck}: a live layer was reclaimed`);
  }
  assert.ok(refusals > 0 && grants > 0 && A.stats.reclaimedPages > 0 && A.stats.fitted > 0, JSON.stringify(A.stats));
  // The kit pages: the policy and the stated cap.
  const gl = createFakeWebGL2();
  const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
  KIT.resetKit();
  const pk = KIT.kitPages(renderer);
  assert.equal(pk.alloc.reclaimIdle, true);
  assert.equal(pk.alloc.fitToCap, true);
  assert.equal(pk.alloc.maxBytes, 128 * 1024 * 1024, "the stated cap: 128 MiB");
  assert.equal(KIT.kitSummary().pages.maxBytes, 128 * 1024 * 1024);
  const save = globalThis.location;
  globalThis.location = { search: "?gpuBatchVramMB=64" };
  try {
    KIT.resetKit();
    assert.equal(KIT.kitPages(renderer).alloc.maxBytes, 64 * 1024 * 1024, "?gpuBatchVramMB");
  } finally { globalThis.location = save; KIT.resetKit(); }
});

/** A world whose kit cap holds about 1.5 fixture rigs of layers (fitted pages). */
async function cappedWorld(cap = 250000) {
  const w = await R.world(true);
  KIT.kitPages(w.renderer).alloc.maxBytes = cap;
  return w;
}

await check("5. page exhaustion never refuses a whole rig; the cap freeing re-batches every leaf", async () => {
  const w = await cappedWorld();
  const alloc = KIT.kitPages(w.renderer).alloc;
  const a = await w.spawn(0x55000501, 10, 10, 0, PAL(1));
  const b = await w.spawn(0x55000502, 10.4, 10, 0, PAL(2));
  w.frame(40);
  // The cap now full to the last layer (other content holds every free one).
  const dummies = [];
  for (const p of [...alloc.pages]) while (p.free.length > 0) { const ck = `dummy${dummies.length}`; alloc.acquire(p.desc, ck); dummies.push(ck); }
  const cap0 = alloc.maxBytes;
  alloc.maxBytes = alloc.bytes;
  const c = await w.spawn(0x55000503, 10.8, 10, 0, PAL(3));
  w.frame(40);
  const recs = [a, b, c].map((i) => i._hbBatch);
  const s = eb(w).stats();
  assert.deepEqual(recs.map((r) => r.status === "legacy"), [false, false, false], `nothing legacy: ${JSON.stringify(s.live)}`);
  assert.equal(s.fallbacks.unstable, undefined);
  assert.equal(s.fallbacks.nothingToBatch, undefined);
  assert.deepEqual(recs.map((r) => r.replans), [0, 0, 0], "no churn");
  assert.ok(s.layers.refusedMembers > 0, "the cap refused members");
  assert.equal(recs[0].status, "active");
  assert.equal(pageFullLeaves(recs[0]), 0, "the first rig: every leaf");
  // The second rig: refused leaves legacy (unparked, drawn), the rest parked.
  assert.equal(recs[1].status, "active");
  assert.ok(pageFullLeaves(recs[1]) > 0, "the second rig is partial");
  for (const cnd of recs[1].plan.legacy) if (cnd.reason === "pageFull") assert.notEqual(cnd.leaf.userData.hbParked, true);
  for (const leaf of recs[1].leaves) assert.equal(leaf.userData.hbParked, true);
  // The third: no layer to be had, so it waits holding nothing.
  assert.equal(recs[2].status, "pending");
  assert.equal(recs[2].reason, "pageFull");
  assert.equal(recs[2].plan, null, "a waiting rig holds no layer");
  assert.ok(s.waits.pageFull >= 1);
  assert.equal(s.kit.budget.byKind.layer, s.kit.pages.gl.admitBytes, "every booked layer byte was uploaded");
  // The cap frees: the waiting rig re-tries on its poll and batches every leaf.
  for (const ck of dummies) alloc.release(ck);
  alloc.maxBytes = cap0;
  w.em.remove(0x55000501);
  w.em.remove(0x55000502);
  const left = recs[2];
  for (let i = 0; i < 520 && !(left.status === "active" && pageFullLeaves(left) === 0); i += 1) w.frame();
  assert.equal(left.status, "active", `${left.status} ${left.reason}`);
  assert.equal(pageFullLeaves(left), 0, "every leaf batched");
  assert.equal(left.plan.memberRefs.size, FULL_MEMBERS);
  assert.equal(left.replans, 0);
});

await check("5b. an active rig with page-refused leaves re-batches them once the cap could take them", async () => {
  const w = await cappedWorld();
  const a = await w.spawn(0x55000511, 10, 10, 0, PAL(4));
  const b = await w.spawn(0x55000512, 10.4, 10, 0, PAL(5));
  w.frame(40);
  const rb = b._hbBatch;
  assert.equal(rb.status, "active");
  const refused = pageFullLeaves(rb);
  assert.ok(refused > 0, "the second rig is partial");
  w.em.remove(0x55000511); // its layers go idle: reclaimable / evictable
  w.frame(5);
  assert.ok(pageFullLeaves(rb) > 0, "no re-plan before the retry period");
  for (let i = 0; i < EB.ENTITY_BATCH_PAGEFULL_RETRY_FRAMES + 60 && pageFullLeaves(rb) > 0; i += 1) w.frame();
  for (let i = 0; i < 20 && rb.status !== "active"; i += 1) w.frame();
  assert.equal(rb.status, "active");
  assert.equal(pageFullLeaves(rb), 0, "every leaf batched");
  assert.equal(rb.plan.memberRefs.size, FULL_MEMBERS);
  assert.equal(rb.replans, 0, "the retry is not churn");
  assert.ok(eb(w).stats().waits.pageFullRetries >= 1);
  void a;
});

await check("6. one reset per context transition, not per tick while lost; stats().context", async () => {
  const w = await R.world(true);
  await w.spawn(0x55000601, 10, 10, 0, PAL(6));
  await w.spawn(0x55000602, 10.4, 10, 0, PAL(7));
  w.settle();
  w.loseContext();
  let c = eb(w).stats().context;
  assert.equal(c.resets, 1, "the loss");
  assert.equal(c.lost, 1);
  assert.equal(c.lossOpen, true);
  assert.equal(c.lostNow, true);
  w.frame(5); // the batch keeps ticking while the context is gone
  c = eb(w).stats().context;
  assert.equal(c.resets, 1, "no reset per tick while lost");
  assert.equal(c.pendingReset, 2);
  w.restoreContext();
  c = eb(w).stats().context;
  assert.equal(c.resets, 2, "the restore");
  assert.equal(c.restored, 1);
  assert.equal(c.lossOpen, false);
  assert.equal(c.lostNow, false);
});

await check("6b. after a loss + restore every rig re-plans at the first sync and is batched again within 10 frames, with every leaf", async () => {
  const w = await cappedWorld();
  const a = await w.spawn(0x55000611, 10, 10, 0, PAL(8));
  const b = await w.spawn(0x55000612, 10.4, 10, 0, PAL(9));
  w.frame(40);
  const rb = b._hbBatch;
  assert.equal(rb.status, "active");
  assert.ok(pageFullLeaves(rb) > 0, "premise: the cap refused leaves of the second rig");
  // The first rig goes away during the loss; the restored pages start empty.
  w.loseContext();
  w.em.remove(0x55000611);
  w.frame(3);
  w.restoreContext();
  w.frame(1);
  assert.notEqual(rb.status, "pending", "re-planned at the first sync on the restored generation");
  assert.equal(eb(w).stats().context.pendingReset, 0);
  let n = 1;
  for (; n < 10 && rb.status !== "active"; n += 1) w.frame();
  assert.equal(rb.status, "active", `batched again after ${n} frames`);
  assert.ok(n <= 10);
  assert.equal(pageFullLeaves(rb), 0, "the pre-loss refusals did not outlive the pages");
  assert.equal(rb.plan.memberRefs.size, FULL_MEMBERS);
  assert.equal(rb.plan.pagesGen, KIT.kitPages(w.renderer).generation);
  assert.ok(eb(w).stats().context.replansSinceReset >= 1);
  const v = eb(w).verify();
  assert.deepEqual([v.rowMismatches, v.stateMismatches, v.parkMismatches, v.attrMismatches], [0, 0, 0, 0]);
  void a;
});

await check("6c. lost AND restored with no canvas event reaching the batch: one reset, batched again within 10 frames", async () => {
  const w = await R.world(true);
  const inst = await w.spawn(0x55000621, 10, 10, 0, PAL(10));
  w.settle();
  assert.equal(inst._hbBatch.status, "active");
  const e = eb(w);
  e._unwatchContext();
  e._watch = { renderer: w.renderer, el: null, onEvent: null }; // the batch hears no canvas event
  w.loseContext();
  w.restoreContext(); // three rebuilt its properties (a new generation); no tick in between
  assert.equal(inst._hbBatch.status, "active", "premise: nothing told the batch yet");
  w.frame(); // the first sync sees the dead generation: one reset, legacy leaves back
  assert.equal(inst._hbBatch.status, "pending");
  let n = 1;
  for (; n < 10 && inst._hbBatch.status !== "active"; n += 1) w.frame();
  assert.equal(inst._hbBatch.plan.pagesGen, KIT.kitPages(w.renderer).generation, "planned on the new generation");
  const c = e.stats().context;
  assert.deepEqual([c.lost, c.restored, c.resets], [1, 1, 1], JSON.stringify(c));
  assert.equal(inst._hbBatch.status, "active", `batched again after ${n} frames`);
  assert.ok(n <= 10);
  assert.equal(w.drawsOf().length, 7);
});

await check("7. layers only for leaves that draw: a hidden rig admits nothing; a long-hidden rig frees its batch", async () => {
  const w = await R.world(true);
  const a = await w.spawn(0x55000701, 10, 10, 0, PAL(11));
  const b = await w.spawn(0x55000702, 10.4, 10, 0, PAL(12));
  w.em.setVisibility(0x55000702, false);
  assert.equal(b.root.visible, false);
  w.frame(30);
  assert.equal(a._hbBatch.status, "active");
  assert.equal(b._hbBatch.status, "pending");
  assert.equal(b._hbBatch.reason, "hidden");
  assert.equal(b._hbBatch.plan, null, "nothing planned or admitted");
  assert.equal(eb(w).stats().kit.pages.live, FULL_MEMBERS, "only the visible rig's layers");
  w.em.setVisibility(0x55000702, true);
  for (let i = 0; i < 40 && b._hbBatch.status !== "active"; i += 1) w.frame();
  assert.equal(b._hbBatch.status, "active", "seen: batched");
  assert.equal(eb(w).stats().kit.pages.live, 2 * FULL_MEMBERS);
  // Hidden past the hold: the batch is freed (layers idle), re-planned once seen.
  w.em.setVisibility(0x55000702, false);
  for (let i = 0; i < EB.ENTITY_BATCH_HIDDEN_HOLD_FRAMES + 5 && b._hbBatch.status === "active"; i += 1) w.frame(1, 1 / 60, false);
  assert.equal(b._hbBatch.status, "pending");
  assert.equal(b._hbBatch.reason, "hidden");
  assert.equal(b._hbBatch.plan, null);
  const s = eb(w).stats();
  assert.equal(s.kit.pages.live, FULL_MEMBERS, "its layers are idle now");
  assert.equal(s.waits.hiddenReleases, 1);
  for (const l of R.leavesOf(b)) assert.notEqual(l.userData.hbParked, true, "legacy leaves back (hidden anyway)");
  w.em.setVisibility(0x55000702, true);
  for (let i = 0; i < 40 && b._hbBatch.status !== "active"; i += 1) w.frame();
  assert.equal(b._hbBatch.status, "active");
});

await check("8. (guard) translucent and luminous leaves never get a layer", async () => {
  const w = await R.world(true, { parts: R.LIB.MIXED_PARTS });
  const inst = await w.spawn(0x55000801, 10, 10, 0, PAL(13));
  w.settle();
  const bb = inst._hbBatch;
  assert.equal(bb.status, "active");
  const legacyMaps = new Set(bb.plan.legacy.map((c) => c.leaf.material.map).filter(Boolean));
  assert.ok(bb.plan.legacy.some((c) => c.reason === "translucent"), "premise: a translucent leaf");
  const rows = [...bb.plan.memberRefs.values()];
  for (const row of rows) assert.equal(legacyMaps.has(row.map), false, "no layer for a legacy leaf's texture");
  assert.equal(eb(w).stats().kit.pages.live, new Set(rows.map((r) => r.contentKey)).size, "the layers are the batch members'");
});

await check("9. stats().footprint against the stated cap", async () => {
  const w = await R.world(true);
  await w.spawn(0x55000901, 10, 10, 0, PAL(14));
  await w.spawn(0x55000902, 10.4, 10, 0, PAL(14)); // same palette: shares every layer
  w.settle();
  const s = eb(w).stats();
  const f = s.footprint;
  assert.ok(f, "footprint present");
  assert.equal(f.capBytes, 128 * 1024 * 1024);
  assert.equal(f.reservedBytes, s.kit.pages.bytes);
  assert.equal(f.ownLayers, FULL_MEMBERS, "two rigs, one palette: 8 layers");
  let bytes = 0;
  for (const k of Object.keys(f.byPageKey)) bytes += f.byPageKey[k].bytes;
  assert.equal(f.ownBytes, bytes);
  assert.equal(f.liveBytes, f.ownBytes, "every live layer is this consumer's");
  assert.ok(f.reservedBytes >= f.liveBytes + f.idleBytes);
  assert.equal(f.freeLayerBytes, f.reservedBytes - f.liveBytes - f.idleBytes);
});

done();
