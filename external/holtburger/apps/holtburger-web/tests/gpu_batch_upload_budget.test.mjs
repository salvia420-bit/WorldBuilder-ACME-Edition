// tests/gpu_batch_upload_budget.test.mjs — R3-3 K2: the per-frame upload cap
// (scene3d/gpu_batch/upload_budget.js; docs/2026-10-29-round3-gpu-driven.md
// §R3-3 item 4, lessons doc L12).
//
// Locks:
//   1. ONE byte budget per frame shared by every upload kind (layer admits,
//      row-texture growth, kit geometry); layer admits ALSO counted (16);
//      the plan's start values (8 MiB, 16 admits);
//   2. the oversize rule: a single upload larger than the frame budget goes
//      ALONE as the frame's first spend, and only then;
//   3. the FIFO: strict arrival order, a refused head blocks the queue (no
//      overtaking), so a big job never starves; a fresh frame always moves
//      the head; cancel drops matching jobs;
//   4. a long random stream: every frame stays within its cap (or is a
//      single oversize spend), every job runs exactly once, in order;
//   5. the kit singleton reads its two knobs once, clamped;
//   6. (K3, 2026-10-30) the cap holds per UPLOAD frame: geometry / row growth
//      reach GL at three's NEXT render, which in the app falls in the NEXT
//      rAF frame next to that frame's layer admits (render loop first) — so
//      deferred bytes are booked in the charging frame AND carried until the
//      frame that begins after their upload. A consumer model (layers upload
//      in the tick, geometry at the next render) runs the app's order, the
//      flipped one (portal / targetFps pacing) and paced renders (every 3rd
//      rAF, tickets landed by the render): every rAF frame's uploaded bytes
//      stay within the cap, or are one oversize upload alone; and the exact
//      case (geometry charged in tick N, a layer wanting tick N+1) waits;
//   7. tickets: carried until landed (in parts) and once more; dropped before
//      the upload -> no longer carried; dropped after a partial upload ->
//      carried once; expired after DEFERRED_HOLD_FRAMES; the oversize waits
//      for nothing else to reach GL in its frame;
//   8. the S1 timing fields: per-kind ms / maxMs / timed and the geometry
//      phases are numbers; addMs accumulates and ignores garbage.
// (Test 3's FIFO runs on LAYER jobs since K3: a geometry job now carries its
// bytes into the next frame by contract; 3b locks that FIFO behaviour.)
//
// Run from apps/holtburger-web/:  node tests/gpu_batch_upload_budget.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const UB = await import("../scene3d/gpu_batch/upload_budget.js");
const KIT = await import("../scene3d/gpu_batch/kit.js");
const MiB = 1024 * 1024;

test("1. one byte budget for every kind, admits counted, the plan's start values", () => {
  assert.equal(UB.UPLOAD_BYTES_PER_FRAME_DEFAULT, 8 * MiB);
  assert.equal(UB.UPLOAD_ADMITS_PER_FRAME_DEFAULT, 16);
  const b = new UB.UploadBudget({ bytesPerFrame: 10 * MiB, admitsPerFrame: 2 });
  b.beginFrame(1);
  assert.equal(b.trySpend(4 * MiB, UB.UPLOAD_KIND.GEOMETRY), true);
  assert.equal(b.trySpend(4 * MiB, UB.UPLOAD_KIND.ROW_GROW), true);
  assert.equal(b.trySpend(3 * MiB, UB.UPLOAD_KIND.LAYER), false, "geometry + rows already used the bytes");
  assert.equal(b.trySpend(2 * MiB, UB.UPLOAD_KIND.LAYER), true);
  assert.equal(b.remainingBytes(), 0);
  b.beginFrame(1);
  assert.equal(b.remainingBytes(), 0, "beginFrame is idempotent per id");
  b.beginFrame(2);
  assert.equal(b.trySpend(1, UB.UPLOAD_KIND.LAYER), true);
  assert.equal(b.trySpend(1, UB.UPLOAD_KIND.LAYER), true);
  assert.equal(b.trySpend(1, UB.UPLOAD_KIND.LAYER), false, "admit cap");
  assert.equal(b.trySpend(1, UB.UPLOAD_KIND.GEOMETRY), true, "the admit cap does not block other kinds");
  assert.deepEqual(b.stats.byKind, { layer: 2 * MiB + 2, rowGrow: 4 * MiB, geometry: 4 * MiB + 1 });
});

test("2. oversize: alone, first spend of a frame, only then", () => {
  const b = new UB.UploadBudget({ bytesPerFrame: 1 * MiB, admitsPerFrame: 16 });
  b.beginFrame(1);
  assert.equal(b.trySpend(10, UB.UPLOAD_KIND.GEOMETRY), true);
  assert.equal(b.trySpend(3 * MiB, UB.UPLOAD_KIND.GEOMETRY), false, "not first in the frame");
  b.beginFrame(2);
  assert.equal(b.canSpend(3 * MiB, UB.UPLOAD_KIND.GEOMETRY), true);
  assert.equal(b.trySpend(3 * MiB, UB.UPLOAD_KIND.GEOMETRY), true, "first spend of a fresh frame");
  assert.equal(b.stats.oversize, 1);
  assert.equal(b.trySpend(1, UB.UPLOAD_KIND.GEOMETRY), false, "nothing else that frame");
});

test("3. FIFO: no overtaking, no starvation, cancel", () => {
  const b = new UB.UploadBudget({ bytesPerFrame: 100, admitsPerFrame: 16 });
  const ran = [];
  // LAYER jobs: uploaded inside the frame that runs them (no carry), so the
  // FIFO rules are seen alone; the deferred-kind FIFO is 3b.
  const job = (id, bytes) => ({ id, bytes, kind: UB.UPLOAD_KIND.LAYER, run: () => ran.push(id) });
  b.enqueue(job("a", 60));
  b.enqueue(job("big", 250));
  b.enqueue(job("c", 10));
  b.beginFrame(1);
  assert.equal(b.drain(), 1);
  assert.deepEqual(ran, ["a"], "c fits the bytes but may not overtake the refused head");
  b.beginFrame(2);
  assert.equal(b.drain(), 1);
  assert.deepEqual(ran, ["a", "big"], "the big head goes alone on a fresh frame");
  b.beginFrame(3);
  b.enqueue(job("d", 10));
  b.enqueue(job("e", 10));
  assert.equal(b.cancel((j) => j.id === "d"), 1);
  assert.equal(b.drain(), 2);
  assert.deepEqual(ran, ["a", "big", "c", "e"]);
  assert.equal(b.pending(), 0);
  // A throwing job does not wedge the queue.
  b.enqueue({ bytes: 1, kind: "geometry", run: () => { throw new Error("x"); } });
  b.enqueue(job("f", 1));
  b.beginFrame(4);
  assert.equal(b.drain(), 2);
  assert.deepEqual(ran.at(-1), "f");
});

test("3b. FIFO of deferred jobs: their bytes land in the next frame too", () => {
  const b = new UB.UploadBudget({ bytesPerFrame: 100, admitsPerFrame: 16 });
  const ran = [];
  const geo = (id, bytes) => ({ id, bytes, kind: UB.UPLOAD_KIND.GEOMETRY, run: () => ran.push(id) });
  b.enqueue(geo("a", 60));
  b.enqueue(geo("b", 50));
  b.enqueue({ id: "l", bytes: 30, kind: UB.UPLOAD_KIND.LAYER, run: () => ran.push("l") });
  b.beginFrame(1);
  assert.equal(b.drain(), 1, "a; b does not fit beside it");
  b.beginFrame(2);
  assert.equal(b.carriedBytes, 60, "a uploads at the next render: carried into frame 2");
  assert.equal(b.drain(), 0, "b (50) does not fit beside a's 60 still landing in this frame");
  b.beginFrame(3);
  assert.equal(b.carriedBytes, 0);
  assert.equal(b.drain(), 2, "b, then l (30) beside it");
  assert.deepEqual(ran, ["a", "b", "l"]);
  b.beginFrame(4);
  assert.equal(b.carriedBytes, 50, "b carried, the layer not (it uploaded inside its frame)");
});

test("4. random stream: every frame within its cap, every job once, in order", () => {
  let s = 0xc0ffee;
  const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const cap = 8 * MiB;
  const b = new UB.UploadBudget({ bytesPerFrame: cap, admitsPerFrame: 16 });
  const ran = [];
  let next = 0;
  const kinds = [UB.UPLOAD_KIND.LAYER, UB.UPLOAD_KIND.GEOMETRY, UB.UPLOAD_KIND.ROW_GROW];
  for (let f = 0; f < 3000; f++) {
    // A streaming burst every ~200 frames.
    const arrivals = f % 200 === 0 ? 80 : (r() < 0.3 ? 1 : 0);
    for (let k = 0; k < arrivals; k++) {
      const id = next++;
      const bytes = r() < 0.02 ? Math.floor(cap * (1 + r())) : Math.floor(r() * 2 * MiB);
      b.enqueue({ id, bytes, kind: kinds[id % 3], run: () => ran.push(id) });
    }
    b.beginFrame(f);
    b.drain();
    const oversizeAlone = b.spentAdmits <= 1 && b.spentBytes > cap;
    assert.ok(b.spentBytes <= cap || oversizeAlone, `frame ${f}: ${b.spentBytes} B`);
    assert.ok(b.spentAdmits <= 16);
  }
  for (let f = 3000; b.pending() > 0 && f < 10000; f++) { b.beginFrame(f); b.drain(); }
  assert.equal(ran.length, next, "every job ran");
  for (let i = 0; i < ran.length; i++) assert.equal(ran[i], i, "arrival order");
});

test("5. the kit budget: one shared instance, URL knobs read once and clamped", () => {
  const saved = globalThis.location;
  try {
    globalThis.location = { search: "?gpuBatchUploadMB=2&gpuBatchAdmits=4" };
    KIT.resetKit();
    const b = KIT.kitBudget();
    assert.equal(b.bytesPerFrame, 2 * MiB);
    assert.equal(b.admitsPerFrame, 4);
    assert.equal(KIT.kitBudget(), b, "one budget for every consumer");
    KIT.kitBeginFrame(7);
    b.trySpend(MiB, "geometry");
    KIT.kitBeginFrame(7);
    assert.equal(b.spentBytes, MiB, "a second consumer in the same frame does not refill it");
    globalThis.location = { search: "?gpuBatchUploadMB=99999&gpuBatchAdmits=0" };
    KIT.resetKit();
    assert.equal(KIT.kitBudget().bytesPerFrame, 8 * MiB, "out-of-range knobs keep the default");
    assert.equal(KIT.kitBudget().admitsPerFrame, 16);
  } finally {
    globalThis.location = saved;
    KIT.resetKit();
  }
});

// ---------------------------------------------------------------------------
// 6. Per UPLOAD frame.
// ---------------------------------------------------------------------------
const K = UB.UPLOAD_KIND;

/**
 * The consumer model. Each rAF frame f: the render (three uploads every
 * geometry charged since the last render, landing its ticket) and the tick
 * (beginFrame(f); geometry spends in arrival order, then layer admits, which
 * upload right there). `order`: "render-first" (the app: scene3d/index.js's
 * rAF is registered before the consumers'), "tick-first" (a setTimeout-armed
 * render rAF: portal / ?targetFps pacing). `pace`: a render every `pace` rAF
 * frames. Returns per rAF frame the bytes that reached GL in it.
 */
function uploadModel({ order, pace = 1, tickets = false, frames = 900, seed = 1, cap = 256 * 1024 }) {
  const b = new UB.UploadBudget({ bytesPerFrame: cap, admitsPerFrame: 16 });
  let s = seed >>> 0;
  const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const size = (max) => (r() < 0.03 ? Math.floor(cap * (1 + r())) : 1 + Math.floor(r() * max));
  const wantGeo = [];
  const wantLayers = [];
  const toUpload = [];
  const rows = [];
  let row = null;
  const put = (n) => { row.bytes += n; row.items += 1; };
  const render = () => {
    for (const u of toUpload) { put(u.bytes); if (u.ticket) b.land(u.ticket, u.bytes); }
    toUpload.length = 0;
  };
  const tick = (f) => {
    b.beginFrame(f);
    while (wantGeo.length > 0) {
      const n = wantGeo[0];
      let t = null;
      if (tickets) { t = b.spendDeferred(n, K.GEOMETRY); if (!t) break; } else if (!b.trySpend(n, K.GEOMETRY)) break;
      wantGeo.shift();
      toUpload.push({ bytes: n, ticket: t });
    }
    while (wantLayers.length > 0 && b.trySpend(wantLayers[0], K.LAYER)) put(wantLayers.shift());
  };
  for (let f = 0; ; f++) {
    if (f < frames) {
      // A crossing burst every 60 frames, a trickle between.
      const n = f % 60 === 0 ? 12 : (r() < 0.35 ? 1 : 0);
      for (let k = 0; k < n; k++) { wantGeo.push(size(cap / 2)); wantLayers.push(size(cap / 3)); }
    } else if (wantGeo.length + wantLayers.length + toUpload.length === 0) break;
    assert.ok(f < frames + 5000, `${order}/${pace}: the queues drain (liveness)`);
    row = { f, bytes: 0, items: 0 };
    const renders = f % pace === 0;
    if (order === "tick-first") { tick(f); if (renders) render(); } else { if (renders) render(); tick(f); }
    rows.push(row);
  }
  return { rows, b, cap };
}

function assertPerUploadFrame({ rows, cap }, tag) {
  let worst = null;
  for (const row of rows) {
    const ok = row.bytes <= cap || row.items === 1;
    if (!ok && (!worst || row.bytes > worst.bytes)) worst = row;
  }
  assert.equal(worst, null, `${tag}: a rAF frame carried ${worst && worst.bytes} B in ${worst && worst.items} uploads (cap ${cap})`);
}

test("6. the cap holds per UPLOAD frame: deferred bytes carried into the frame their render falls in", () => {
  // The exact case (render loop first, as in the app): geometry charged in
  // tick N uploads at the render of rAF N+1, BEFORE tick N+1 admits layers.
  {
    const b = new UB.UploadBudget({ bytesPerFrame: 100, admitsPerFrame: 16 });
    b.beginFrame(1);
    assert.ok(b.trySpend(60, K.GEOMETRY), "tick N: the geometry");
    b.beginFrame(2); // rAF N+1: its render uploaded the 60 B, now its tick
    assert.equal(b.trySpend(50, K.LAYER), false, "a 50 B layer would make that rAF frame 110 B: it waits");
    assert.equal(b.carriedBytes, 60, "the geometry is booked in the frame its render falls in");
    assert.ok(b.trySpend(40, K.LAYER), "40 B fit beside the geometry");
    b.beginFrame(3);
    assert.equal(b.carriedBytes, 0, "carried once");
    assert.ok(b.trySpend(50, K.LAYER), "the next frame it goes");
    // A held ticket: carried every frame until the frame after its upload.
    const t = b.spendDeferred(70, K.GEOMETRY);
    assert.equal(t, null, "70 B do not fit beside this frame's 50 B layer");
    b.beginFrame(4);
    const t2 = b.spendDeferred(70, K.GEOMETRY);
    assert.ok(t2 && b.isOpen(t2));
    for (const f of [5, 6, 7]) {
      b.beginFrame(f);
      assert.equal(b.carriedBytes, 70, `frame ${f}: not uploaded yet (no render drew it): still carried`);
      assert.equal(b.trySpend(31, K.LAYER), false, `frame ${f}: it may land in this frame's render`);
    }
    b.land(t2);
    b.beginFrame(8);
    assert.equal(b.carriedBytes, 70, "uploaded before this frame's tick (render first): booked here once more");
    b.beginFrame(9);
    assert.equal(b.carriedBytes, 0);
    assert.equal(b.heldTickets(), 0);
  }
  // The consumer model, every order the app can run.
  for (const seed of [1, 7, 42]) {
    assertPerUploadFrame(uploadModel({ order: "render-first", seed }), `render first (the app), seed ${seed}`);
    assertPerUploadFrame(uploadModel({ order: "tick-first", seed }), `tick first (paced render rAF), seed ${seed}`);
    assertPerUploadFrame(uploadModel({ order: "render-first", pace: 3, tickets: true, seed }), `render every 3rd rAF, tickets, seed ${seed}`);
    assertPerUploadFrame(uploadModel({ order: "tick-first", pace: 2, tickets: true, seed }), `tick first, render every 2nd rAF, tickets, seed ${seed}`);
    assertPerUploadFrame(uploadModel({ order: "render-first", tickets: true, seed }), `render first, tickets, seed ${seed}`);
  }
});

test("7. tickets: land in parts, drop, expire; the oversize waits for nothing else to reach GL", () => {
  const b = new UB.UploadBudget({ bytesPerFrame: 1000, admitsPerFrame: 16 });
  b.beginFrame(1);
  const t = b.spendDeferred(300, K.GEOMETRY);
  assert.equal(b.openTickets(), 1);
  b.land(t, 100);
  b.land(t, 100);
  assert.ok(b.isOpen(t), "200 of 300 B uploaded: still open");
  b.beginFrame(2);
  assert.equal(b.carriedBytes, 300);
  b.land(t, 100);
  assert.equal(b.isOpen(t), false);
  assert.equal(b.openTickets(), 0);
  b.land(t, 100); // after the last byte: ignored
  b.beginFrame(3);
  assert.equal(b.carriedBytes, 300, "landed in frame 2: carried into frame 3 once");
  b.beginFrame(4);
  assert.equal(b.carriedBytes, 0);
  // Dropped before any upload: no longer carried.
  const d = b.spendDeferred(200, K.ROW_GROW);
  b.drop(d);
  b.beginFrame(5);
  assert.equal(b.carriedBytes, 0, "a resource torn down before it uploaded carries nothing");
  // Dropped after a partial upload: what landed is carried once.
  const p = b.spendDeferred(200, K.GEOMETRY);
  b.land(p, 50);
  b.drop(p);
  b.beginFrame(6);
  assert.equal(b.carriedBytes, 200);
  b.beginFrame(7);
  assert.equal(b.carriedBytes, 0);
  assert.deepEqual([b.stats.landed, b.stats.dropped], [1, 2]);
  // Expiry: a ticket that never lands stops being carried.
  const e = b.spendDeferred(10, K.GEOMETRY);
  for (let f = 8; f < 8 + UB.DEFERRED_HOLD_FRAMES; f++) { b.beginFrame(f); assert.equal(b.carriedBytes, 10); }
  b.beginFrame(8 + UB.DEFERRED_HOLD_FRAMES);
  assert.equal(b.carriedBytes, 0, "held DEFERRED_HOLD_FRAMES frames: expired");
  assert.equal(b.stats.expired, 1);
  assert.equal(b.isOpen(e), false);
  assert.equal(b.openTickets(), 0);
  // The oversize: alone in its rAF frame.
  let f = 10000;
  b.beginFrame(f++);
  const small = b.spendDeferred(10, K.GEOMETRY);
  b.beginFrame(f++);
  assert.equal(b.canSpend(5000, K.GEOMETRY), false, "a deferred oversize waits while another geometry is still to upload (the same render)");
  assert.equal(b.canSpend(5000, K.LAYER), false, "an immediate oversize waits while bytes are carried in");
  b.land(small);
  assert.equal(b.canSpend(5000, K.GEOMETRY), true, "nothing pending: the deferred oversize can go (a separate render)");
  assert.equal(b.canSpend(5000, K.LAYER), false, "but the layer still shares this rAF frame with the landed geometry");
  b.beginFrame(f++);
  b.beginFrame(f++);
  assert.equal(b.carriedBytes, 0);
  assert.equal(b.canSpend(5000, K.LAYER), true, "nothing carried: the layer oversize goes alone");
  assert.ok(b.trySpend(5000, K.LAYER));
  assert.equal(b.trySpend(1, K.GEOMETRY), false, "and nothing else that frame");
});

test("8. the S1 timing fields: numbers per kind and per geometry phase", () => {
  const b = new UB.UploadBudget();
  for (const k of ["ms", "maxMs", "timed"]) {
    assert.deepEqual(Object.keys(b.stats[k]).sort(), ["geometry", "layer", "rowGrow"], k);
    for (const v of Object.values(b.stats[k])) assert.equal(typeof v, "number");
  }
  assert.deepEqual(Object.keys(b.stats.phaseMs).sort(), ["geometryBuild", "geometryFirstDraw", "geometryUpload"]);
  b.addMs(K.LAYER, 1.5);
  b.addMs(K.LAYER, 0.5);
  b.addMs(K.GEOMETRY, 2, "geometryBuild");
  b.addMs(K.GEOMETRY, 1, "geometryFirstDraw");
  b.addMs(K.ROW_GROW, -1);          // garbage: ignored
  b.addMs(K.ROW_GROW, Number.NaN);  // garbage: ignored
  b.addMs("nope", 3);               // unknown kind: ignored
  assert.deepEqual(b.stats.ms, { layer: 2, rowGrow: 0, geometry: 3 });
  assert.deepEqual(b.stats.maxMs, { layer: 1.5, rowGrow: 0, geometry: 2 });
  assert.deepEqual(b.stats.timed, { layer: 2, rowGrow: 0, geometry: 2 });
  assert.deepEqual(b.stats.phaseMs, { geometryBuild: 2, geometryUpload: 0, geometryFirstDraw: 1 });
  assert.equal(typeof UB.uploadNowMs(), "number");
  // Through the kit summary (what animSceneryBatchDiag().kit.budget shows).
  KIT.resetKit();
  const kb = KIT.kitSummary().budget;
  assert.equal(kb, null, "no budget before a consumer asks");
  KIT.kitBudget();
  const s = KIT.kitSummary().budget;
  for (const k of ["ms", "maxMs", "timed", "phaseMs"]) assert.ok(s[k] && Object.values(s[k]).every((v) => typeof v === "number" && Number.isFinite(v)), k);
  for (const k of ["carried", "maxCarried", "tickets", "landed", "dropped", "expired"]) assert.equal(typeof s[k], "number", k);
  KIT.resetKit();
});
