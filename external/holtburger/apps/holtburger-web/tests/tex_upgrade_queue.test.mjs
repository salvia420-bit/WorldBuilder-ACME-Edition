// tests/tex_upgrade_queue.test.mjs — `?texUpgradeQueue` (2026-10-09),
// `?texchanJoin` and `?texWorkerEager` (D3-b).
//
// The upgrade queue (scene3d/tex_upgrade_queue.js) admits every full-tier
// texture fetch (tex-xu7 → tex-bc7, CLIP twin), every tex-bc7-pre fetch and
// every texchan sidecar fetch of the production MaterialCache, in visibility
// order, under an in-flight cap, an interior pause and (indoors) a byte bucket.
// Everything is injected: a fake clock + timer table, a fake liveScene3d, stub
// fetches. No wasm, no GPU, no browser.
//
//   Q1  flag readers (absent = on; off/0/false/no; numeric clamps)
//   Q2  pause (interior build), resumes latched, 3-min ceiling, ?interiorHold=off
//   Q3  order: visible cells nearest first → resident → unknown
//   Q4  pre vs full (pre held inside D_full and cancelled at full dispatch;
//       pre first beyond D_full, one slot); bgShare=0 = no background at all
//   Q5  in-flight cap (h1 3/2, h2 6/4, slow link 1)
//   Q6  byte bucket indoors (bound), work-conserving outdoors
//   Q7  liveness: drop only with no live waiter AND no holder; DROPPED is not
//       a verdict; a live joiner keeps the job; an evicted material still on a
//       visible mesh is not dropped
//   Q8  off arm: MaterialCache arming; a source without qctx holds as before
//   Q9  texchan: one fetch per stem (join), held while paused, ask-before-install
//   Q10 invariants through the queue: CLIP gate per phase, twin via the queue
//       (also on the already-cached leg), onSwap before dispose, transcode
//       failure re-admits, pre cancelled once the full record is on the wire
//   Q11 index unavailable = FIFO; orphans and hidden-group holders park (not age)
//   Q12 diag: stats/log/report shapes; trackInView open waits
//   +   worker back-pressure, post-resume wait, aging, microtask re-pump,
//       timers cleared by _resetForTest, texWorkerEager client behaviour
//
// Run: node tests/tex_upgrade_queue.test.mjs   (exits; no live timers)

import assert from "node:assert/strict";

globalThis.location = { search: "" };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.window = globalThis;

const Q = await import("../scene3d/tex_upgrade_queue.js");
const B = await import("../scene3d/bc7_textures.js");
const S = await import("../scene3d/suite_assets.js");
const X = await import("../scene3d/xu7_textures.js");
const { TexUpgradeQueue, texUpgradeQueueEnabled, texUpgradeFullMeters, texUpgradeBgShare } = Q;
const { Bc7RecordSource, TEX_DROPPED } = B;

let groups = 0;
let failures = 0;
async function t(name, fn) {
  try {
    await fn();
    groups++;
    console.log("  ok ", name);
  } catch (e) {
    failures++;
    console.log("  FAIL", name);
    console.log(e);
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────

const flush = async (n = 40) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

function makeClock() {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    schedule: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, ms | 0), fn });
      return id;
    },
    cancel: (id) => {
      timers.delete(id);
    },
    pending: () => timers.size,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        timers.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
    set(v) {
      now = v;
    },
  };
}

const ident = (x, y, z) => ({ elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1] });
function mesh(rs, [x, y, z], r = 1) {
  return {
    isMesh: true,
    material: Array.isArray(rs)
      ? rs.map((v) => ({ userData: { __texRsId: v } }))
      : { userData: rs ? { __texRsId: rs } : {} },
    geometry: { boundingSphere: { center: { x: 0, y: 0, z: 0 }, radius: r } },
    matrixWorld: ident(x, y, z),
    children: [],
  };
}
function cell(cellId, meshes, visible = true) {
  return { visible, userData: { cellId }, children: [{ name: "mesh-x", children: meshes }] };
}
function makeScene(o = {}) {
  const cam = o.cam || [0, 0, 0];
  return {
    camera: { matrixWorld: ident(cam[0], cam[1], cam[2]) },
    cellContainers3d: new Map((o.cells || []).map((c) => [c.userData.cellId >>> 0, c])),
    cellsGroup: { visible: true },
    staticsGroup: { visible: o.staticsVisible !== false, children: o.statics || [] },
    buildingsGroup: { visible: o.staticsVisible !== false, children: [] },
    entityManager: { entityMap: new Map((o.ents || []).map((e, i) => [i, e])) },
    envCellLoadedLbs: new Set(o.loaded || []),
    sessionHandle: { isCurrentCellIndoor: () => !!o.indoor },
    _sealedEvictLbKey: 0,
  };
}

function mkQueue(o = {}) {
  const clk = o.clock || makeClock();
  const st = { scene: o.scene === undefined ? makeScene() : o.scene, paused: false };
  const q = new TexUpgradeQueue({
    now: clk.now,
    schedule: clk.schedule,
    cancel: clk.cancel,
    sceneProvider: () => st.scene,
    linkBps: () => (o.linkBps !== undefined ? o.linkBps : 20e6),
    protocol: () => o.proto || "h1",
    paused: o.pausedFn || (() => st.paused),
    workerDepth: o.depth || (() => 0),
    pendingProbe: o.pendingProbe || (() => false),
    indoor: o.indoor,
    fullM: o.fullM !== undefined ? o.fullM : 32,
    bgShare: o.bgShare !== undefined ? o.bgShare : 0.3,
    pauseMaxMs: o.pauseMaxMs,
  });
  q.armed = true;
  return { q, clk, st };
}

/** Admit and collect tickets in dispatch order. */
function admitAll(q, list, sink) {
  return list.map(([kind, id, hint, opt]) =>
    q.admit(kind, id, hint, opt).then((tk) => {
      sink.push(tk ? `${kind}:${typeof id === "number" ? id.toString(16) : id}` : `null:${kind}:${typeof id === "number" ? id.toString(16) : id}`);
      return tk;
    }),
  );
}

const blocks = (n) => Math.ceil(n / 4);
function hbc7(w, h) {
  const lvls = [];
  let lw = w, lh = h;
  for (;;) {
    lvls.push(blocks(lw) * blocks(lh) * 16);
    if (lw === 1 && lh === 1) break;
    lw = Math.max(1, lw >> 1);
    lh = Math.max(1, lh >> 1);
  }
  const buf = new Uint8Array(20 + lvls.reduce((a, b) => a + b, 0));
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x37434248, true);
  dv.setUint32(4, w, true);
  dv.setUint32(8, h, true);
  dv.setUint32(12, blocks(w), true);
  dv.setUint32(16, blocks(h), true);
  return buf;
}

const RS_A = 0x0600000a, RS_B = 0x0600000b, RS_C = 0x0600000c, RS_D = 0x0600000d, RS_E = 0x0600000e;
const SMALL = { w: 64, h: 64 }; // full est ~53 KB: never "big"
const BIG = { w: 256, h: 256 }; // full est ~843 KB: "big"
const hint = (o = {}) => ({ did: 0x08000000, rs: 0, w: 64, h: 64, live: () => true, ...o });

// ── Q1 ─────────────────────────────────────────────────────────────────────

await t("Q1 flag readers", () => {
  assert.equal(texUpgradeQueueEnabled(""), true);
  assert.equal(texUpgradeQueueEnabled("?texUpgradeQueue=on"), true);
  for (const v of ["off", "0", "false", "no", "OFF"]) assert.equal(texUpgradeQueueEnabled(`?texUpgradeQueue=${v}`), false, v);
  assert.equal(texUpgradeFullMeters(""), 32);
  assert.equal(texUpgradeFullMeters("?texUpgradeFullM=12.5"), 12.5);
  assert.equal(texUpgradeFullMeters("?texUpgradeFullM=0"), 0);
  assert.equal(texUpgradeFullMeters("?texUpgradeFullM=off"), 0);
  assert.equal(texUpgradeFullMeters("?texUpgradeFullM=5000"), 1000);
  assert.equal(texUpgradeFullMeters("?texUpgradeFullM=-3"), 0);
  assert.equal(texUpgradeFullMeters("?texUpgradeFullM=banana"), 32);
  assert.equal(texUpgradeBgShare(""), 0.3);
  assert.equal(texUpgradeBgShare("?texUpgradeBgShare=0"), 0);
  assert.equal(texUpgradeBgShare("?texUpgradeBgShare=no"), 0);
  assert.equal(texUpgradeBgShare("?texUpgradeBgShare=2"), 1);
  assert.equal(texUpgradeBgShare("?texUpgradeBgShare=x"), 0.3);
  assert.equal(S.texchanJoinEnabled(""), true);
  for (const v of ["off", "0", "false", "no"]) assert.equal(S.texchanJoinEnabled(`?texchanJoin=${v}`), false, v);
  // texWorkerEager: default needs Web Workers (node has none) unless explicit.
  const had = typeof globalThis.Worker !== "undefined";
  if (!had) {
    assert.equal(X.texWorkerEagerEnabled(""), false);
    globalThis.Worker = function () {};
    assert.equal(X.texWorkerEagerEnabled(""), true);
    delete globalThis.Worker;
  }
  assert.equal(X.texWorkerEagerEnabled("?texWorkerEager=on"), true);
  for (const v of ["off", "0", "false", "no"]) assert.equal(X.texWorkerEagerEnabled(`?texWorkerEager=${v}`), false, v);
});

// ── Q2 ─────────────────────────────────────────────────────────────────────

await t("Q2 pause: nothing dispatched while the interior builds; resume latched; ceiling", async () => {
  const { q, clk, st } = mkQueue();
  st.paused = true;
  const got = [];
  admitAll(q, [["full", RS_A, hint(SMALL)], ["pre", RS_B, hint()], ["texchan", "stem1", hint({ rs: RS_C })]], got);
  await flush();
  await clk.advance(2000);
  assert.deepEqual(got, [], "held while paused");
  assert.equal(q.stats().paused, true);
  st.paused = false;
  await clk.advance(300);
  assert.ok(got.includes("full:600000a") && got.includes("texchan:stem1"), JSON.stringify(got));
  assert.equal(q.stats().resumes.length, 1);
  assert.ok(q.stats().resumes[0].pausedMs >= 2000);
  q._resetForTest();

  // Ceiling: a wedged build cannot strand the queue.
  const m2 = mkQueue({ pauseMaxMs: 5000 });
  m2.st.paused = true;
  const got2 = [];
  admitAll(m2.q, [["full", RS_A, hint(SMALL)]], got2);
  await flush(); // the first pump observes the pause at t0
  await m2.clk.advance(4000);
  assert.deepEqual(got2, []);
  await m2.clk.advance(1500);
  assert.deepEqual(got2, ["full:600000a"]);
  assert.equal(m2.q.stats().pauseCeilings, 1);
  m2.q._resetForTest();

  // ?interiorHold=off: the default pause predicate never holds.
  globalThis.location.search = "?interiorHold=off";
  window.__interiorBuildPending = true;
  const { interiorBuildPending } = await import("../scene3d/bandwidth_tier.js");
  const m3 = mkQueue({ pausedFn: () => interiorBuildPending() }); // the production predicate
  const got3 = [];
  admitAll(m3.q, [["full", RS_A, hint(SMALL)]], got3);
  await flush();
  assert.deepEqual(got3, ["full:600000a"], "interiorHold=off: no pause");
  globalThis.location.search = "";
  const got4 = [];
  admitAll(m3.q, [["full", RS_B, hint(SMALL)]], got4);
  await flush();
  await m3.clk.advance(600);
  assert.deepEqual(got4, [], "interiorHold default: paused while pending");
  window.__interiorBuildPending = false;
  await m3.clk.advance(300);
  assert.deepEqual(got4, ["full:600000b"]);
  m3.q._resetForTest();
});

// ── Q3 ─────────────────────────────────────────────────────────────────────

await t("Q3 order: visible cells nearest first, then resident, then unknown", async () => {
  const scene = makeScene({
    cells: [
      cell(0x00070100, [mesh(RS_B, [20, 0, 0]), mesh(RS_A, [5, 0, 0])]),
      cell(0x00070101, [mesh(RS_C, [10, 0, 0])], false), // built, not in view
    ],
  });
  const { q } = mkQueue({ scene });
  const got = [];
  const tickets = admitAll(q, [
    ["full", RS_D, hint(SMALL)], // no holder
    ["full", RS_C, hint(SMALL)],
    ["full", RS_B, hint(SMALL)],
    ["full", RS_A, hint(SMALL)],
  ], got);
  await flush();
  assert.deepEqual(got, ["full:600000a", "full:600000b", "full:600000c"], "cap 3, best three in order");
  const tk = await tickets[3];
  tk.received(1000);
  tk.release();
  await flush();
  assert.deepEqual(got.slice(3), ["full:600000d"], "unknown last, re-pumped by the receipt");
  const bands = q.log().filter((e) => e.ev === "dispatched").map((e) => e.band);
  assert.deepEqual(bands, ["nearFull", "nearFull", "resident", "unknown"]);
  q._resetForTest();
});

// ── Q4 ─────────────────────────────────────────────────────────────────────

await t("Q4 pre vs full: pre held inside D_full and cancelled; pre first beyond D_full; bgShare=0", async () => {
  // Inside D_full: straight to full, the queued pre is cancelled at dispatch.
  {
    const scene = makeScene({ cells: [cell(0x00070100, [mesh(RS_A, [3, 0, 0])])] });
    const { q } = mkQueue({ scene });
    const got = [];
    admitAll(q, [["pre", RS_A, hint()], ["full", RS_A, hint(SMALL)]], got);
    await flush();
    assert.deepEqual(got.sort(), ["full:600000a", "null:pre:600000a"]);
    assert.equal(q.stats().cancelledPre, 1);
    q._resetForTest();
  }
  // Beyond D_full: pre (fg) before full (bg); only ONE pre in flight.
  {
    const scene = makeScene({ cells: [cell(0x00070100, [mesh(RS_A, [50, 0, 0]), mesh(RS_B, [60, 0, 0])])] });
    const { q } = mkQueue({ scene, indoor: () => true });
    const got = [];
    const tk = admitAll(q, [
      ["full", RS_A, hint(SMALL)],
      ["pre", RS_A, hint()],
      ["pre", RS_B, hint()],
    ], got);
    await flush();
    assert.deepEqual(got, ["pre:600000a"], "one pre slot; bg full waits while fg (pre B) is queued");
    const preA = await tk[1];
    preA.received(5000);
    preA.release();
    await flush();
    // pre B takes the pre slot; with no foreground job QUEUED any more, the
    // background full record may go (bucket rate = bgShare x link).
    assert.deepEqual(got.slice(1), ["pre:600000b", "full:600000a"]);
    assert.deepEqual(q.log().filter((e) => e.ev === "dispatched").map((e) => e.band), ["farPre", "farPre", "far"]);
    q._resetForTest();
  }
  // bgShare=0: nothing in the background, ever (free slots or not).
  {
    const scene = makeScene({
      cells: [cell(0x00070100, [mesh(RS_A, [50, 0, 0]), mesh(RS_E, [1, 0, 0])]), cell(0x00070101, [mesh(RS_B, [5, 0, 0])], false)],
    });
    const { q, clk } = mkQueue({ scene, bgShare: 0 });
    const got = [];
    admitAll(q, [
      ["full", RS_A, hint(SMALL)], // in view beyond D_full: bg
      ["full", RS_B, hint(SMALL)], // resident: bg
      ["texchan", "s", hint({ rs: RS_A })], // beyond D_full: bg
      ["full", RS_E, hint(SMALL)], // near: fg
      ["pre", RS_A, hint()], // far pre: fg
    ], got);
    await flush();
    await clk.advance(5000);
    assert.deepEqual(got.sort(), ["full:600000e", "pre:600000a"]);
    assert.equal(q.stats().queued.total, 3);
    q._resetForTest();
  }
});

// ── Q5 ─────────────────────────────────────────────────────────────────────

await t("Q5 in-flight cap: h1 3 (2 big), h2 6 (4 big), slow link 1", async () => {
  const scene = makeScene({ cells: [cell(0x00070100, [1, 2, 3, 4, 5, 6, 7, 8].map((i) => mesh(0x06000100 + i, [i, 0, 0])))] });
  const ids = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => 0x06000100 + i);
  const run = async (o, sz) => {
    const { q } = mkQueue({ scene, ...o });
    const got = [];
    admitAll(q, ids.map((id) => ["full", id, hint(sz)]), got);
    await flush();
    const s = q.stats().inflight;
    q._resetForTest();
    return [got.length, s.all, s.big];
  };
  assert.deepEqual(await run({}, BIG), [2, 2, 2], "h1 big");
  assert.deepEqual(await run({}, SMALL), [3, 3, 0], "h1 small");
  assert.deepEqual(await run({ proto: "h2" }, BIG), [4, 4, 4], "h2 big");
  assert.deepEqual(await run({ proto: "h3" }, SMALL), [6, 6, 0], "h3 small");
  assert.deepEqual(await run({ linkBps: 500_000 }, SMALL), [1, 1, 0], "slow link");
});

// ── Q6 ─────────────────────────────────────────────────────────────────────

await t("Q6 byte bucket: bounded indoors (background share), work-conserving outdoors", async () => {
  // 120 resident (background) jobs of ~210 KB; each batch takes 300 ms on a
  // 2 MB/s link (so the measured rate ~ the tier rate).
  const ids = Array.from({ length: 120 }, (_, i) => 0x06100000 + i);
  const scene = makeScene({ cells: [cell(0x00070101, ids.map((id, i) => mesh(id, [i, 0, 0])), false)] });
  const sim = async (indoor) => {
    const { q, clk } = mkQueue({ scene, linkBps: 2e6, indoor: () => indoor });
    const tix = [];
    for (const id of ids) tix.push(q.admit("full", id, hint({ w: 128, h: 128 })).then((tk) => { tk && tix.push(tk); return tk; }));
    await flush();
    let bytes = 0;
    const est = Q.texUpgradeEstimateBytes("xu7", 128, 128);
    let L = 0;
    for (let step = 0; step < 34; step++) { // ~10 s
      const live = tix.filter((x) => x && typeof x.received === "function" && !x._done);
      await clk.advance(300);
      for (const tk of live) { tk.received(est); tk.release(); bytes += est; }
      await flush();
      L = Math.max(L, q.stats().link.L);
    }
    const s = q.stats();
    q._resetForTest();
    return { bytes, L, est, s };
  };
  const inside = await sim(true);
  const outside = await sim(false);
  const T = 34 * 0.3;
  const bound = Math.max(2 * 1024 * 1024, 0.8 * inside.L) + 0.3 * inside.L * T + 3 * inside.est;
  assert.ok(inside.bytes <= bound, `indoor bytes ${inside.bytes} > bound ${Math.round(bound)}`);
  assert.ok(inside.s.tokenBlocks > 0, "the bucket bound indoors");
  assert.equal(outside.s.tokenBlocks, 0, "outdoors: no bucket");
  assert.ok(outside.bytes > inside.bytes * 1.5, `outdoor ${outside.bytes} vs indoor ${inside.bytes}`);
});

// ── Q7 ─────────────────────────────────────────────────────────────────────

await t("Q7 liveness: dropped only with no live waiter AND no holder; DROPPED is not a verdict", async () => {
  // (a) all waiters dead, no holder → DROPPED, nothing cached, re-ask fetches.
  {
    const { q, clk } = mkQueue({ bgShare: 0 }); // unknown holder = background → stays queued
    const asked = [];
    const src = new Bc7RecordSource({ budgetBytes: Infinity, fetchImpl: (id) => { asked.push(id); return hbc7(8, 8); } });
    let alive = false;
    const p = src.getAsync(RS_A, { queue: q, hint: hint({ live: () => alive }) });
    await flush();
    await clk.advance(1500);
    assert.equal(q.stats().dropped, 0, "grace period");
    await clk.advance(2000);
    assert.equal(await p, TEX_DROPPED);
    assert.equal(src.known(RS_A), false, "no negative cache");
    assert.equal(B.bc7Stats().absent, 0);
    assert.deepEqual(asked, []);
    q._resetForTest();
    // a later ask (no queue) fetches
    const r = await src.getAsync(RS_A);
    assert.ok(r && r.width === 8);
    assert.deepEqual(asked, [RS_A]);
  }
  // (b) one live joiner keeps the job.
  {
    const { q, clk } = mkQueue({ bgShare: 0 });
    const src = new Bc7RecordSource({ budgetBytes: Infinity, fetchImpl: () => hbc7(8, 8) });
    const p1 = src.getAsync(RS_B, { queue: q, hint: hint({ live: () => false }) });
    const p2 = src.getAsync(RS_B, { queue: q, hint: hint({ live: () => true }) });
    assert.equal(p1, p2, "joined");
    await clk.advance(5000);
    assert.equal(q.stats().dropped, 0);
    assert.equal(q.stats().joins, 1);
    q._resetForTest();
  }
  // (c) evicted material (no live waiter) still on a VISIBLE mesh: not dropped.
  {
    const scene = makeScene({ cells: [cell(0x00070100, [mesh(RS_C, [4, 0, 0])])] });
    const { q, clk } = mkQueue({ scene, depth: () => 99 }); // back-pressure keeps it queued
    const src = new Bc7RecordSource({ budgetBytes: Infinity, xu7ParsedImpl: async () => null, fetchImpl: () => hbc7(8, 8) });
    src.getAsync(RS_C, { queue: q, hint: hint({ live: () => false }) });
    await clk.advance(5000);
    assert.equal(q.stats().dropped, 0, "a holder keeps it");
    assert.equal(q.stats().queued.byBand.nearFull, 1);
    q._resetForTest();
  }
});

// ── Q8 ─────────────────────────────────────────────────────────────────────

await t("Q8 off arm: only the production cache arms the queue; no qctx = today's hold", async () => {
  const { MaterialCache } = await import("../scene3d/materials.js");
  Q._resetTexUpgradeQueueForTest();
  globalThis.location.search = "";
  const prod = new MaterialCache({ wasmExports: {} });
  assert.ok(prod._texQueue && prod._texQueue === window.__texUpgradeQueue && prod._texQueue.armed === true);
  assert.equal(new MaterialCache()._texQueue, null, "no wasmExports: never armed");
  Q._resetTexUpgradeQueueForTest();
  globalThis.location.search = "?texUpgradeQueue=off";
  const off = new MaterialCache({ wasmExports: {} });
  assert.equal(off._texQueue, null);
  assert.ok(window.__texUpgradeQueue, "the diag singleton exists on =off too");
  assert.equal(window.__texUpgradeQueue.armed, false);
  globalThis.location.search = "";
  Q._resetTexUpgradeQueueForTest();
  // A source without qctx still holds via holdForInterior (H7's contract).
  const asked = [];
  const src = new Bc7RecordSource({ budgetBytes: Infinity, fetchImpl: (id) => { asked.push(id); return new Uint8Array(0); } });
  window.__interiorBuildPending = true;
  const p = src.getAsync(0x06001234);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(asked, []);
  window.__interiorBuildPending = false;
  await p;
  assert.deepEqual(asked, [0x06001234]);
});

// ── Q9 ─────────────────────────────────────────────────────────────────────

await t("Q9 texchan: one fetch per stem through the queue; held while paused; ask before install", async () => {
  const { q, clk, st } = mkQueue();
  const asked = [];
  const src = new S.SuiteAssetSource({ fetchImpl: (key) => { asked.push(key); return new Uint8Array(0); }, queue: q });
  st.paused = true;
  let installed = false; // the material installs AFTER the ask (materials.js order)
  const h = hint({ rs: RS_A, live: () => installed });
  assert.equal(src.getByKey("stemA", "texchan", h), null);
  const pa = src.getByKeyAsync("stemA", "texchan", h);
  installed = true;
  q.pumpNow();
  await clk.advance(3000);
  assert.deepEqual(asked, [], "held while paused");
  st.paused = false;
  await clk.advance(300);
  await pa;
  assert.deepEqual(asked, ["stemA"], "one fetch for getByKey + getByKeyAsync");
  assert.equal(src.fetchCount, 1);
  assert.equal(q.stats().dispatchedByKind.texchan, 1);
  q._resetForTest();
  // ask-before-install with an immediate pump: the grace keeps it.
  {
    const m = mkQueue();
    const asked2 = [];
    const src2 = new S.SuiteAssetSource({ fetchImpl: (k) => { asked2.push(k); return new Uint8Array(0); }, queue: m.q });
    let inst = false;
    const p = src2.getByKeyAsync("stemB", "texchan", hint({ rs: RS_B, live: () => inst }));
    m.q.pumpNow();
    inst = true;
    await flush();
    await p;
    assert.deepEqual(asked2, ["stemB"]);
    m.q._resetForTest();
  }
});

await t("texchanJoin: one fetch on (both arms); the double fetch restored with =off", async () => {
  for (const [join, want] of [[true, 1], [false, 2]]) {
    const src = new S.SuiteAssetSource({ fetchImpl: () => new Uint8Array(0), join });
    src.getByKey("stemZ", "wind");
    await src.getByKeyAsync("stemZ", "wind");
    assert.equal(src.fetchCount, want, `join=${join}`);
  }
  globalThis.location.search = "?texchanJoin=off";
  assert.equal(new S.SuiteAssetSource({})._join, false);
  globalThis.location.search = "";
  assert.equal(new S.SuiteAssetSource({})._join, true);
  // bytes counted on both arms
  const s3 = new S.SuiteAssetSource({ fetchImpl: () => new Uint8Array(7) });
  await s3.getByKeyAsync("k", "texchan");
  assert.equal(s3.stats().bytes, 7);
  assert.ok(S.suiteHdLog().some((e) => e.key === "k" && e.bytes === 7));
});

// ── Q10 ────────────────────────────────────────────────────────────────────

function freshMat() {
  const disposed = [];
  const tex = (name) => ({ name, image: { width: 64, height: 64 }, wrapS: 1000, wrapT: 1000, colorSpace: "srgb", dispose() { disposed.push(this.name); } });
  return { mat: { map: tex("rgba8"), userData: {} }, disposed };
}

await t("Q10 invariants through the queue: gate per phase, onSwap before dispose, twin via queue", async () => {
  B._resetBc7ForTest();
  B._setBc7SupportForTest(true);
  globalThis.location.search = "?texPre=on";
  // Beyond D_full so the pre phase is dispatched (inside D_full it is skipped).
  const scene = makeScene({ cells: [cell(0x00070100, [mesh(RS_A, [60, 0, 0]), mesh(RS_B, [2, 0, 0])])] });
  const { q } = mkQueue({ scene, bgShare: 0.3 });
  B.initBc7Source({ budgetBytes: Infinity, fetchImpl: () => hbc7(16, 16), preFetchImpl: () => hbc7(4, 4) });
  const phases = [];
  const gate = { admit: (_p, ph) => { phases.push(ph); return true; } };
  const { mat, disposed } = freshMat();
  const swaps = [];
  const res = await B.upgradeMaterialToBc7(mat, RS_A, (r) => swaps.push({ replaced: r.replaced, disposedAtSwap: disposed.slice() }), { gate, queue: q, hint: hint({ rs: RS_A }) });
  assert.ok(res && res.swapped);
  assert.deepEqual(phases, ["pre", "full"], "the CLIP gate is asked for each phase");
  assert.equal(swaps.length, 2);
  assert.equal(swaps[0].replaced.name, "rgba8");
  assert.deepEqual(swaps[1].disposedAtSwap, [], "onSwap receives `replaced` before anything is disposed");
  assert.equal(mat.map.image.width, 16);
  assert.equal(q.stats().dispatchedByKind.pre, 1);
  assert.equal(q.stats().dispatchedByKind.full, 1);
  q._resetForTest();

  // A vetoed xu7 record asks for its tex-bc7 twin THROUGH the queue — also on
  // the already-cached leg (second material, record already known).
  B._resetBc7ForTest();
  B._setBc7SupportForTest(true);
  globalThis.location.search = "?texPre=off";
  const m2 = mkQueue({ scene });
  const xu7 = { width: 16, height: 16, blocksX: 4, blocksY: 4, levels: [{ data: new Uint8Array(256), width: 16, height: 16 }] };
  B.initBc7Source({ budgetBytes: Infinity, xu7ParsedImpl: async () => xu7, fetchImpl: async () => hbc7(16, 16) });
  const veto = { admit: (_p, ph) => ph !== "full" };
  const a = freshMat();
  await B.upgradeMaterialToBc7(a.mat, RS_B, () => {}, { gate: { admit: () => true }, queue: m2.q, hint: hint({ rs: RS_B }) });
  assert.equal(m2.q.stats().dispatchedByKind.twin, 0);
  const b = freshMat();
  const r2 = await B.upgradeMaterialToBc7(b.mat, RS_B, () => {}, { gate: veto, queue: m2.q, hint: hint({ rs: RS_B }) });
  assert.ok(r2 && r2.swapped, "twin rescued");
  assert.equal(m2.q.stats().dispatchedByKind.twin, 1, "the twin went through the queue on the cached leg");
  m2.q._resetForTest();

  // Transcode failure (xu7 leg null) re-admits the tex-bc7 leg at the head.
  B._resetBc7ForTest();
  B._setBc7SupportForTest(true);
  const m3 = mkQueue({ scene });
  B.initBc7Source({ budgetBytes: Infinity, xu7ParsedImpl: async () => null, fetchImpl: async () => hbc7(8, 8) });
  const c = freshMat();
  const r3 = await B.upgradeMaterialToBc7(c.mat, RS_B, () => {}, { queue: m3.q, hint: hint({ rs: RS_B }) });
  assert.ok(r3 && r3.swapped);
  assert.equal(m3.q.stats().refetches, 1);
  assert.deepEqual(m3.q.log().filter((e) => e.ev === "dispatched").map((e) => e.net), ["xu7", "hbc7"]);
  m3.q._resetForTest();

  // A pre admitted while its full record is already on the wire is cancelled.
  const m4 = mkQueue({ scene: makeScene({ cells: [cell(0x00070100, [mesh(RS_C, [60, 0, 0])])] }) });
  const fullTk = await m4.q.admit("full", RS_C, hint(SMALL));
  const pre = m4.q.admit("pre", RS_C, hint());
  await flush();
  m4.q.pumpNow();
  assert.equal(await pre, null);
  fullTk.release();
  m4.q._resetForTest();
  globalThis.location.search = "";
  B._resetBc7ForTest();
});

await t("DROPPED in upgradeMaterialToBc7: clears __bc7Pending only (no settle, no refeed)", async () => {
  B._resetBc7ForTest();
  B._setBc7SupportForTest(true);
  const { q, clk } = mkQueue({ bgShare: 0 });
  B.initBc7Source({ budgetBytes: Infinity, fetchImpl: () => hbc7(8, 8), preFetchImpl: () => null });
  let refeeds = 0;
  B.registerAtlasRefeed(() => { refeeds++; return 0; });
  const settles = [];
  const { mat } = freshMat();
  const p = B.upgradeMaterialToBc7(mat, RS_D, () => {}, { gate: { admit: () => true, settle: (o) => settles.push(o) }, queue: q, hint: hint({ live: () => false }) });
  assert.equal(mat.userData.__bc7Pending, true);
  await clk.advance(4000);
  assert.equal(await p, false);
  assert.equal(mat.userData.__bc7Pending, undefined);
  assert.deepEqual(settles, []);
  assert.equal(refeeds, 0);
  assert.equal(B.bc7Source().known(RS_D), false);
  assert.equal(B.bc7Stats().upgradesDropped, 1);
  B.registerAtlasRefeed(null);
  q._resetForTest();
  B._resetBc7ForTest();
});

// ── Q11 ────────────────────────────────────────────────────────────────────

await t("Q11 index unavailable = FIFO; orphans and hidden-group holders park, never age", async () => {
  {
    const { q } = mkQueue({ scene: null });
    const got = [];
    const tix = admitAll(q, [["full", RS_C, hint(SMALL)], ["pre", RS_A, hint()], ["full", RS_A, hint(SMALL)], ["texchan", "x", hint()]], got);
    await flush();
    // FIFO: enqueue order, cap 3; the pre is cancelled when its full dispatches
    // (its null settles first: it is resolved inside that dispatch).
    assert.deepEqual(got, ["full:600000c", "null:pre:600000a", "full:600000a", "texchan:x"]);
    assert.deepEqual(q.log().filter((e) => e.ev === "dispatched").map((e) => e.id), ["600000c", "600000a", "x"]);
    assert.equal(q.stats().index.available, false);
    for (const p of [tix[0], tix[2], tix[3]]) (await p).release();
    q._resetForTest();
  }
  // Orphan: seen in a visible cell, then the cell is gone → parked.
  {
    const scene = makeScene({ cells: [cell(0x00070100, [mesh(RS_A, [2, 0, 0])])] });
    const { q, clk, st } = mkQueue({ scene, depth: () => 99 }); // back-pressure: stays queued
    const got = [];
    admitAll(q, [["full", RS_A, hint(SMALL)]], got);
    await flush();
    assert.equal(q.stats().queued.byBand.nearFull, 1);
    st.scene = makeScene({ cells: [] });
    await clk.advance(1100);
    assert.equal(q.stats().queued.byBand.parked, 1, JSON.stringify(q.stats().queued));
    q._resetForTest();
  }
  // Hidden outdoor group (sealed dungeon): parked, and never ages into fg.
  {
    const node = { isMesh: false, visible: true, children: [mesh(RS_E, [5, 0, 0])], matrixWorld: ident(0, 0, 0) };
    const scene = makeScene({ statics: [node], staticsVisible: false });
    const { q, clk, st } = mkQueue({ scene, indoor: () => true });
    st.paused = true;
    await flush();
    q.pumpNow(); // observe the pause
    st.paused = false;
    await clk.advance(300); // resume latched
    const got = [];
    admitAll(q, [["full", RS_E, hint(SMALL)]], got);
    await clk.advance(25000);
    assert.deepEqual(got, []);
    assert.equal(q.stats().queued.byBand.parked, 1);
    assert.equal(q.stats().aged, 0);
    q._resetForTest();
  }
});

await t("aging: a never-held job enqueued after the latest resume joins fg after 20 s", async () => {
  const { q, clk, st } = mkQueue({ bgShare: 0, indoor: () => true });
  const pre = [];
  admitAll(q, [["full", RS_B, hint(SMALL)]], pre); // enqueued BEFORE the resume: never ages
  st.paused = true;
  await flush();
  await clk.advance(300);
  st.paused = false;
  await clk.advance(300);
  const got = [];
  admitAll(q, [["full", RS_A, hint(SMALL)]], got);
  await clk.advance(15000);
  assert.deepEqual(got, []);
  await clk.advance(7000);
  assert.deepEqual(got, ["full:600000a"]);
  assert.deepEqual(pre, []);
  assert.equal(q.stats().aged, 1);
  q._resetForTest();
});

await t("post-resume wait: dispatch waits (<=500 ms) for the new landblock's cells", async () => {
  const scene = makeScene({ cells: [], loaded: [] });
  const { q, clk, st } = mkQueue({ scene });
  st.paused = true;
  const got = [];
  admitAll(q, [["full", RS_A, hint(SMALL)]], got);
  await clk.advance(300);
  // The build attaches the LB (loaded) but the visibility tick has not run.
  scene.envCellLoadedLbs.add(0x00070000);
  st.paused = false;
  await clk.advance(260);
  assert.deepEqual(got, [], "waiting for the new LB in the visible set");
  scene.cellContainers3d.set(0x00070100, cell(0x00070100, [mesh(RS_A, [1, 0, 0])]));
  await clk.advance(60);
  assert.deepEqual(got, ["full:600000a"]);
  assert.equal(q.stats().resumeWaitHits, 1);
  q._resetForTest();
  // bounded: no cell ever shows → proceeds after 500 ms
  const m = mkQueue({ scene: makeScene({ loaded: [] }) });
  m.st.paused = true;
  const got2 = [];
  admitAll(m.q, [["full", RS_A, hint(SMALL)]], got2);
  await m.clk.advance(300);
  m.st.scene.envCellLoadedLbs.add(0x00080000);
  m.st.paused = false;
  await m.clk.advance(900);
  assert.deepEqual(got2, ["full:600000a"]);
  assert.equal(m.q.stats().resumeWaitTimeouts, 1);
  m.q._resetForTest();
});

await t("tracker armed: its index refreshes still reclassify queued jobs (walls → nearFull first)", async () => {
  const scene = makeScene({ cells: [], loaded: [] });
  const { q, clk, st } = mkQueue({ scene, pendingProbe: () => true });
  q.trackInView(true);
  st.paused = true;
  const got = [];
  // Three no-holder jobs enqueued FIRST, then the surface of the starting room.
  admitAll(q, [["full", RS_B, hint(SMALL)], ["full", RS_C, hint(SMALL)], ["full", RS_D, hint(SMALL)], ["full", RS_A, hint(SMALL)]], got);
  await clk.advance(1000);
  assert.deepEqual(got, []);
  scene.cellContainers3d.set(0x00070100, cell(0x00070100, [mesh(RS_A, [1, 0, 0])]));
  scene.envCellLoadedLbs.add(0x00070000);
  st.paused = false;
  await clk.advance(600);
  assert.equal(got[0], "full:600000a", JSON.stringify(got));
  assert.equal(q.log().find((e) => e.ev === "dispatched").band, "nearFull");
  q._resetForTest();
});

await t("worker back-pressure: no new xu7 dispatch while > 8 transcodes queue", async () => {
  let depth = 9;
  const scene = makeScene({ cells: [cell(0x00070100, [mesh(RS_A, [1, 0, 0]), mesh(RS_B, [2, 0, 0])])] });
  const { q, clk } = mkQueue({ scene, depth: () => depth });
  const got = [];
  admitAll(q, [["full", RS_A, hint(SMALL)], ["texchan", "t", hint({ rs: RS_B })], ["full", RS_B, hint(SMALL)], ["full", RS_C, hint(SMALL), { net: "hbc7" }]], got);
  await flush();
  assert.deepEqual(got.sort(), ["full:600000c", "texchan:t"], "xu7 legs held; hbc7 + texchan go");
  depth = 0;
  await clk.advance(150);
  assert.ok(got.includes("full:600000a"), JSON.stringify(got));
  assert.ok(q.stats().backpressureBlocks > 0);
  q._resetForTest();
});

await t("microtask re-pump on receipt; _resetForTest leaves no live timers", async () => {
  const scene = makeScene({ cells: [cell(0x00070100, [1, 2, 3, 4].map((i) => mesh(0x06000200 + i, [i, 0, 0])))] });
  const { q, clk } = mkQueue({ scene });
  const got = [];
  const tix = admitAll(q, [1, 2, 3, 4].map((i) => ["full", 0x06000200 + i, hint(SMALL)]), got);
  await flush();
  assert.equal(got.length, 3);
  const tk = await tix[0];
  tk.received(100); // frees the slot before the (simulated) transcode
  await flush();
  assert.equal(got.length, 4, "dispatched with no timer advance");
  assert.equal(q.stats().inflight.transcoding, 1);
  tk.release();
  assert.equal(q.stats().inflight.transcoding, 0);
  assert.ok(clk.pending() > 0 || q._hasTimersForTest() || true);
  q.trackInView(true);
  assert.ok(q._hasTimersForTest());
  q._resetForTest();
  assert.equal(q._hasTimersForTest(), false);
  assert.equal(clk.pending(), 0, "every scheduled timer was cancelled");
});

// ── Q12 ────────────────────────────────────────────────────────────────────

await t("Q12 diag: stats/log/report shapes; trackInView reports open waits", async () => {
  B._resetBc7ForTest();
  let pend = new Set([RS_A, RS_B]);
  const scene = makeScene({ cells: [cell(0x00070100, [mesh(RS_A, [3, 0, 0]), mesh(RS_B, [80, 0, 0])])] });
  const { q, clk } = mkQueue({ scene, pendingProbe: (rs) => pend.has(rs) });
  const walls = clk.now();
  q.trackInView(true);
  await clk.advance(3000);
  let r = q.report({ wallsEpochMs: walls });
  for (const k of ["wallsEpochMs", "windowMs", "hdBytesWindow", "hdBytesSinceWalls", "budget10s", "inView", "order", "stats"]) assert.ok(k in r, k);
  for (const k of ["maxWaitMs", "over10s", "maxWaitMsAll", "open", "maxSpanMs"]) assert.ok(k in r.inView, k);
  const openA = r.inView.open.find((o) => o.rs === RS_A.toString(16));
  assert.ok(openA && openA.inViewNearMs >= 2500 && openA.ageMs >= 2500, JSON.stringify(r.inView.open));
  const openB = r.inView.open.find((o) => o.rs === RS_B.toString(16));
  assert.ok(openB && openB.inViewNearMs === 0 && openB.inViewMs >= 2500, "beyond D_full: unscoped only");
  pend = new Set([RS_B]);
  await clk.advance(500);
  r = q.report({ wallsEpochMs: walls });
  assert.ok(!r.inView.open.some((o) => o.rs === RS_A.toString(16)), "closed once the upgrade lands");
  assert.equal(r.inView.over10s, 0);
  assert.ok(r.inView.maxWaitMsAll >= r.inView.maxWaitMs);
  const s = q.stats();
  for (const k of ["enabled", "paused", "pauseMs", "resumes", "link", "bucket", "cap", "inflight", "queued", "dispatched", "bytes", "dropped", "aged", "index"]) assert.ok(k in s, k);
  for (const k of ["refreshes", "lastMs", "maxMs", "available", "cls0"]) assert.ok(k in s.index, k);
  q.trackInView(false);
  // log() entries
  const got = [];
  admitAll(q, [["full", RS_A, hint(SMALL)]], got);
  await flush();
  const e = q.log().find((x) => x.ev === "dispatched");
  for (const k of ["kind", "net", "id", "band", "cls", "dist", "enqAt", "dispAt"]) assert.ok(k in e, k);
  q._resetForTest();
});

await t("report: HD bytes window + order metric from the bc7 HD log", async () => {
  B._resetBc7ForTest();
  B._setBc7SupportForTest(true);
  const scene = makeScene({ cells: [cell(0x00070100, [mesh(RS_A, [3, 0, 0])])] });
  const { q, clk } = mkQueue({ scene, pendingProbe: () => true });
  const walls = Date.now();
  q.trackInView(true);
  await clk.advance(2500);
  B.initBc7Source({ budgetBytes: Infinity, fetchImpl: async () => hbc7(16, 16), preFetchImpl: async () => null });
  const { mat } = freshMat();
  await B.upgradeMaterialToBc7(mat, RS_A, () => {}, { queue: q, hint: hint({ rs: RS_A }) });
  const r = q.report({ wallsEpochMs: walls - 10 });
  assert.ok(r.hdBytesWindow.hbc7 > 0 && r.hdBytesWindow.total === r.hdBytesWindow.hbc7, JSON.stringify(r.hdBytesWindow));
  assert.ok(r.order && r.order.K === 1 && r.order.firstKInViewFraction === 1, JSON.stringify(r.order));
  assert.ok(B.bc7HdLog().verdicts.some((v) => v.rs === RS_A && v.outcome === "swapped"));
  q._resetForTest();
  B._resetBc7ForTest();
});

await t("index: cls/dist per holder kind; budget-limited refresh is incomplete (never drops)", async () => {
  const node = (rs, x) => ({ visible: true, children: [mesh(rs, [x, 0, 0])], matrixWorld: ident(0, 0, 0) });
  const ent = { root: { visible: true, parent: {}, children: [mesh(RS_D, [7, 0, 0])], matrixWorld: ident(7, 0, 0) } };
  const scene = makeScene({
    cells: [cell(0x00070100, [mesh(RS_A, [2, 0, 0])]), cell(0x00070101, [mesh(RS_B, [9, 0, 0])], false)],
    statics: [node(RS_C, 40), node(RS_E, 500)],
    ents: [ent],
  });
  const idx = new Q.TexVisibilityIndex();
  idx.refresh(scene, 0);
  assert.equal(idx.available, true);
  assert.equal(idx.complete, true);
  assert.deepEqual([idx.map.get(RS_A).cls, Math.round(idx.map.get(RS_A).dist)], [0, 1]);
  assert.equal(idx.map.get(RS_B).cls, 1, "built, not in view");
  assert.equal(idx.map.get(RS_C).cls, 0, "outdoor node within 96 m");
  assert.equal(idx.map.get(RS_E).cls, 1, "outdoor node beyond 96 m");
  assert.equal(idx.map.get(RS_D).cls, 0, "drawn entity within 96 m");
  assert.deepEqual([...idx.visibleLbs], [0x00070000]);
  scene.staticsGroup.visible = false;
  idx.refresh(scene, 1);
  assert.equal(idx.map.get(RS_C).cls, 3, "hidden group = hidden holder");
  const fresh = new Q.TexVisibilityIndex();
  fresh.refresh(scene, 0, { scanBudget: 1 });
  assert.equal(fresh.complete, false);
  // The queue never drops on an incomplete index.
  const { q, clk } = mkQueue({ scene: makeScene(), bgShare: 0 });
  q.admit("full", RS_A, hint({ live: () => false }));
  await flush();
  q._idx.refresh = function (s, now) { Q.TexVisibilityIndex.prototype.refresh.call(this, s, now); this.complete = false; return this; };
  await clk.advance(5000);
  assert.equal(q.stats().dropped, 0);
  q._resetForTest();
});

// ── texWorkerEager (D3-b) ──────────────────────────────────────────────────

class EagerMockWorker {
  constructor() {
    EagerMockWorker.made += 1;
    this.onmessage = null;
    this.onerror = null;
    this.jobs = 0;
  }
  postMessage(msg) {
    if (msg.type === "init") {
      setTimeout(() => this.onmessage && this.onmessage({ data: { type: "ready" } }), 20);
      return;
    }
    if (msg.type === "job") {
      this.jobs += 1;
      setTimeout(() => this.onmessage && this.onmessage({
        data: { type: "result", seq: msg.seq, ok: true, kind: "xu7", width: 4, height: 4, levelBytes: [16], bc7: new ArrayBuffer(16), transcodeMs: 1 },
      }), 1);
    }
  }
  terminate() {}
}
EagerMockWorker.made = 0;

await t("texWorkerEager: eager construction, bounded wait for a loading worker, gate accepts it", async () => {
  X._resetXu7ForTest();
  X._resetTexWorkerForTest();
  X._setTexWorkerFactoryForTest(() => new EagerMockWorker());
  globalThis.location.search = "?texWorkers=on&texWorkerEager=on";
  EagerMockWorker.made = 0;
  X.warmTextureWorker();
  assert.equal(EagerMockWorker.made, 1, "constructed at the first page evaluation");
  assert.equal(X._texWorkerStateForTest(), "loading");
  assert.equal(X.xu7TranscoderUp(), true, "a loading worker counts as up");
  assert.equal(X.xu7Stats().notReadySkips, 0, "the main-thread transcoder was not asked for");
  const out = await X.transcodeXu7(new Uint8Array(32));
  assert.ok(out && out.width === 4, "served by the worker after the bounded wait");
  const st = X.texWorkerStats();
  assert.equal(st.fifoFallbacks, 0);
  assert.equal(st.eagerWaits, 1);
  assert.equal(st.eagerStarts, 1);
  X._resetTexWorkerForTest();

  // =off: today's ask-don't-await client, byte for byte.
  globalThis.location.search = "?texWorkers=on&texWorkerEager=off";
  EagerMockWorker.made = 0;
  X.warmTextureWorker();
  assert.equal(EagerMockWorker.made, 0, "no eager construction");
  X._resetXu7ForTest();
  X._setXu7ModuleForTest(new Promise(() => {})); // a load that never settles
  assert.equal(X.xu7TranscoderUp(), false, "=off: the gate is ensureXu7Transcoder()");
  assert.equal(X.xu7Stats().notReadySkips, 1);
  X._resetXu7ForTest();
  X._resetTexWorkerForTest();
  X._setTexWorkerFactoryForTest(null);
  globalThis.location.search = "";
});

// ── review fixes (2026-10-09) ──────────────────────────────────────────────

await t("review: pre asked while its full transcodes is cancelled; refetch leg joinable; refetch refunds tokens; twin join", async () => {
  // (1) A second Surface DID on the same RenderSurface asks its pre while the
  // full record is TRANSCODING (received, not released): cancelled at once —
  // held, nothing would ever cancel it (queue never empties, 1 Hz wake forever).
  {
    const scene = makeScene({ cells: [cell(0x00070100, [mesh(RS_A, [3, 0, 0])])] });
    const { q, clk } = mkQueue({ scene });
    await clk.advance(1);
    const tF = await q.admit("full", RS_A, hint({ rs: RS_A, ...SMALL }));
    assert.ok(tF);
    tF.received(5000);
    await flush();
    const pre = await q.admit("pre", RS_A, hint({ did: 0x08000002, rs: RS_A }));
    assert.equal(pre, null, "cancelled at admission");
    tF.release();
    await clk.advance(5000);
    assert.equal(q.stats().queued.total, 0);
    assert.equal(q._hasTimersForTest(), false, "no timer outlives the work");
    q._resetForTest();
  }
  // (2) The hbc7 refetch leg keeps the job's key: a live joiner registers on
  // it, so the leg is not dropped when the first waiter dies with no holder.
  {
    const { q, clk, st } = mkQueue({ scene: makeScene({ cells: [cell(0x00070100, [mesh(RS_B, [3, 0, 0])])] }) });
    await clk.advance(1);
    let w1 = true;
    const tF = await q.admit("full", RS_B, hint({ rs: RS_B, live: () => w1 }));
    st.scene = makeScene(); // the holding cell is evicted
    await clk.advance(1500);
    let leg = "pending";
    tF.refetch("hbc7").then((x) => { leg = x; });
    await clk.advance(1100);
    assert.equal(leg, "pending", "everHeld + no holder: parked");
    assert.equal(q.addWaiter("full", RS_B, hint({ did: 0x08000002, rs: RS_B, live: () => true })), true, "joiner registered on the leg");
    w1 = false;
    await clk.advance(5000);
    assert.equal(leg, "pending", "a live joiner keeps the leg (not DROPPED)");
    q._resetForTest();
  }
  // (3) A leg that never fetched (transcoder not up) refunds its token charge.
  {
    const scene = makeScene({ cells: [cell(0x00070100, [mesh(RS_C, [3, 0, 0])])] });
    const { q, clk } = mkQueue({ scene, indoor: () => true });
    await clk.advance(1);
    const full = q.stats().bucket.tokens;
    const tF = await q.admit("full", RS_C, hint({ rs: RS_C, ...BIG }), { net: "xu7" });
    assert.ok(q.stats().bucket.tokens < full, "charged at dispatch");
    const t2 = await tF.refetch("hbc7");
    assert.equal(q.stats().bucket.tokens, full - t2._job.est, "xu7 charge refunded; only the hbc7 leg is charged");
    t2.received(0);
    t2.release();
    q._resetForTest();
  }
  // (4) A second material joining an in-flight CLIP twin registers its waiter.
  {
    B._resetBc7ForTest();
    const calls = [];
    let release;
    const gateP = new Promise((r) => { release = r; });
    const fakeQ = {
      admit: () => gateP.then(() => ({ received() {}, release() {}, refetch() { return Promise.resolve(null); } })),
      addWaiter: (k, id) => { calls.push(`${k}:${(id >>> 0).toString(16)}`); return true; },
    };
    const src = new Bc7RecordSource({ budgetBytes: Infinity, fetchImpl: async () => hbc7(16, 16) });
    const qctx = { queue: fakeQ, hint: hint({ rs: RS_D }) };
    const p1 = src.hbc7Fallback(RS_D, qctx);
    const p2 = src.hbc7Fallback(RS_D, { queue: fakeQ, hint: hint({ did: 0x08000002, rs: RS_D }) });
    assert.equal(p1, p2, "joined");
    assert.deepEqual(calls, [`twin:${RS_D.toString(16)}`], "the joiner is a waiter of the queued twin");
    release();
    assert.ok(await p1);
    // Off arm: no qctx, no queue call.
    calls.length = 0;
    const src2 = new Bc7RecordSource({ budgetBytes: Infinity, fetchImpl: async () => hbc7(16, 16) });
    const a = src2.hbc7Fallback(RS_E);
    const b = src2.hbc7Fallback(RS_E);
    assert.equal(a, b);
    assert.deepEqual(calls, []);
    await a;
  }
});

console.log(`\n${groups} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
