// 2026-10-22 — ?batchedRunsSorted (scene3d/batched_runs.js, improvement hunt B9
// second half, findings-round1 `gl-driver-1`): a SORTED BatchedMesh (transparent
// static buckets) draws CONSECUTIVE repeats of one range as one instanced run,
// keeping three's draw order entry for entry.
//
// What is pinned here, without a GPU:
//   * `buildConsecutiveRuns`: layout, run boundaries, malformed lists, no-gain,
//     buffer growth, and — by emulating the patched vertex lookup — that the
//     (range, id) SEQUENCE a run draw reaches is three's canonical sequence (the
//     order, not just the multiset; blending depends on it);
//   * that the grouping builder would NOT keep that order (so the builder choice
//     is load-bearing), and that a mesh whose `sortObjects` flips on an
//     unchanged list is re-derived by the right builder;
//   * the renderBufferDirect wrapper over a real three r184 sorted bucket: the
//     instanced call, the texture swap/restore, no-gain and seam step-asides,
//     the separate sorted stats and frame counters, the DoubleSide two-pass, and
//     ?bmIndirectPerCamera's per-camera textures.
// The GPU half (same pixels as `=off` with overlapping blended instances) is
// harness/glsl_smoke/batched_runs_sorted_smoke.mjs (headless Chromium).
//
// Run:
//   cd apps/holtburger-web/
//   node tests/batched_runs_sorted.test.mjs

import * as THREE from "three";
import { readFileSync } from "node:fs";
import {
  buildConsecutiveRuns, buildRuns, makeRunBuffers, RUN_MARKER, hasConsecutiveRepeat,
  installBatchedRuns, uninstallBatchedRuns, markBatchedRuns, prepareRunDraw,
  getBatchedRunsStats, batchedRunsSortedEnabled, batchedRunsFrameTotals,
  __setBatchedRunsChunksForTest, __setBatchedRunsSortedOffForTest, __pendingForTest,
} from "../scene3d/batched_runs.js";
import {
  installBatchedIndirectPerCamera, uninstallBatchedIndirectPerCamera, getBatchedIndirectPerCameraStats,
} from "../scene3d/batched_indirect_per_camera.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

/** The patched vertex lookup, in DRAW ORDER: run r, instance i -> ids[runStart_r + i]. */
function emulateSeq(layout, runs) {
  if (layout[0] !== RUN_MARKER) return null;
  const out = [];
  for (let r = 0; r < runs.r; r++) {
    for (let i = 0; i < runs.inst[r]; i++) out.push(`${runs.starts[r]}:${runs.counts[r]}:${layout[layout[1 + r] + i]}`);
  }
  return out;
}
const canonSeq = (s, c, d, n) => { const o = []; for (let k = 0; k < n; k++) o.push(`${s[k]}:${c[k]}:${d[k]}`); return o; };

// --- flag defaults + source pins ---------------------------------------------------------
{
  check("flag: ?batchedRunsSorted is ON by default (node: no URL)", batchedRunsSortedEnabled() === true);
  const src = readFileSync(new URL("../scene3d/batched_runs.js", import.meta.url), "utf8");
  check("flag: batchedRunsSorted reads with the !(off|0|false|no) escape idiom",
    /get\("batchedRunsSorted"\)[\s\S]{0,120}return !\(v === "off" \|\| v === "0" \|\| v === "false" \|\| v === "no"\)/.test(src));
  check("header: cites the GL ES 3.0.6 §2.9.3 instancing loop and the §2.1 order rule",
    src.includes("GL ES 3.0.6 §2.9.3") && src.includes("one primitive must be drawn completely"));
}

// --- the builder -------------------------------------------------------------------------
{
  // A A B A A A C C  (C = start 60 count 9)
  const starts = Int32Array.from([0, 0, 30, 0, 0, 0, 60, 60]);
  const counts = Int32Array.from([30, 30, 30, 30, 30, 30, 9, 9]);
  const ids = Uint32Array.from([4, 7, 1, 9, 2, 5, 3, 8]);
  const out = makeRunBuffers();
  const r = buildConsecutiveRuns(starts, counts, ids, 8, out);
  check("consecutive: A A B A A A C C makes 4 runs (A, B, A, C)", r === 4 && out.r === 4);
  check("consecutive: run ranges in list order", [...out.starts.subarray(0, 4)].join() === "0,30,0,60" && [...out.counts.subarray(0, 4)].join() === "30,30,30,9");
  check("consecutive: instance counts 2,1,3,2", [...out.inst.subarray(0, 4)].join() === "2,1,3,2");
  check("consecutive: layout = 1 + R + n", out.len === 13);
  check("consecutive: head marker", out.layout[0] === RUN_MARKER);
  check("consecutive: run starts point past the header, back to back", [...out.layout.subarray(1, 5)].join() === "5,7,8,11");
  check("consecutive: ids stay in CANONICAL order after the header", [...out.layout.subarray(5, 13)].join() === "4,7,1,9,2,5,3,8");
  check("consecutive: the emulated GPU sequence IS three's sequence (order, not just the set)",
    JSON.stringify(emulateSeq(out.layout, out)) === JSON.stringify(canonSeq(starts, counts, ids, 8)));

  // The grouping builder over the same list reaches the same SET in another ORDER —
  // exactly why a sorted bucket must never take it.
  const g = makeRunBuffers();
  const rg = buildRuns(starts, counts, ids, 8, g);
  const gs = emulateSeq(g.layout, g);
  check("contrast: the grouping builder gives 3 runs, same multiset, DIFFERENT order",
    rg === 3 && JSON.stringify([...gs].sort()) === JSON.stringify(canonSeq(starts, counts, ids, 8).sort())
      && JSON.stringify(gs) !== JSON.stringify(canonSeq(starts, counts, ids, 8)));

  const ab = makeRunBuffers();
  check("no-gain: A B A B gives R == n (consecutive) though grouping would give 2",
    buildConsecutiveRuns(Int32Array.from([0, 30, 0, 30]), Int32Array.from([30, 30, 30, 30]), Uint32Array.from([1, 2, 3, 4]), 4, ab) === 4
      && buildRuns(Int32Array.from([0, 30, 0, 30]), Int32Array.from([30, 30, 30, 30]), Uint32Array.from([1, 2, 3, 4]), 4, makeRunBuffers()) === 2);
  const sc = makeRunBuffers();
  const rsc = buildConsecutiveRuns(Int32Array.from([0, 0, 0]), Int32Array.from([30, 12, 12]), Uint32Array.from([1, 2, 3]), 3, sc);
  check("same start, another count: a new run, not malformed (grouping refuses this list)",
    rsc === 2 && [...sc.inst.subarray(0, 2)].join() === "1,2"
      && buildRuns(Int32Array.from([0, 0, 0]), Int32Array.from([30, 12, 12]), Uint32Array.from([1, 2, 3]), 3, makeRunBuffers()) === -1);
  const zc = makeRunBuffers();
  check("zero-count ranges merge like any other (GL skips them either way)",
    buildConsecutiveRuns(Int32Array.from([0, 0, 6]), Int32Array.from([0, 0, 3]), Uint32Array.from([1, 2, 3]), 3, zc) === 2 && zc.inst[0] === 2);
  const e = makeRunBuffers();
  check("empty list: R 0, layout is just the marker", buildConsecutiveRuns(new Int32Array(4), new Int32Array(4), new Uint32Array(4), 0, e) === 0 && e.len === 1 && e.layout[0] === RUN_MARKER);
  check("one entry: R 1", buildConsecutiveRuns(Int32Array.from([6]), Int32Array.from([3]), Uint32Array.from([9]), 1, makeRunBuffers()) === 1);

  // Malformed.
  const m = makeRunBuffers();
  check("malformed: a negative count -> -1", buildConsecutiveRuns(Int32Array.from([0, 0]), Int32Array.from([3, -3]), Uint32Array.from([1, 2]), 2, m) === -1);
  check("malformed: n past the starts -> -1", buildConsecutiveRuns(Int32Array.from([0]), Int32Array.from([3, 3]), Uint32Array.from([1, 2]), 2, m) === -1);
  check("malformed: n past the ids -> -1", buildConsecutiveRuns(Int32Array.from([0, 0]), Int32Array.from([3, 3]), Uint32Array.from([1]), 2, m) === -1);
  check("malformed: negative / NaN n -> -1",
    buildConsecutiveRuns(Int32Array.from([0]), Int32Array.from([3]), Uint32Array.from([1]), -1, m) === -1
      && buildConsecutiveRuns(Int32Array.from([0]), Int32Array.from([3]), Uint32Array.from([1]), NaN, m) === -1);
  check("malformed: missing arrays -> -1", buildConsecutiveRuns(null, Int32Array.from([3]), Uint32Array.from([1]), 1, m) === -1);

  // Randomised: lists with runs of repeats (what a depth sort with ties / neighbours
  // gives), buffers grow from 16, every list round-trips IN ORDER.
  let ok = true, why = "";
  const buf = makeRunBuffers();
  let seed = 4242;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let t = 0; t < 300 && ok; t++) {
    const n = 1 + Math.floor(rnd() * 2000);
    const geoms = 1 + Math.floor(rnd() * 12);
    const pRepeat = rnd();
    const s = new Int32Array(n), c = new Int32Array(n), d = new Uint32Array(n);
    let g = 0, boundaries = 0;
    for (let k = 0; k < n; k++) {
      if (k > 0 && rnd() > pRepeat) g = Math.floor(rnd() * geoms);
      s[k] = g * 1000; c[k] = 3 + g * 3; d[k] = (k * 2654435761) >>> 0 & 0xffff;
      if (k > 0 && (s[k] !== s[k - 1] || c[k] !== c[k - 1])) boundaries++;
    }
    const rr = buildConsecutiveRuns(s, c, d, n, buf);
    let instSum = 0;
    for (let q = 0; q < rr; q++) instSum += buf.inst[q];
    let mono = true;
    for (let q = 1; q < rr; q++) if (buf.layout[1 + q] <= buf.layout[q]) mono = false;
    if (rr !== boundaries + 1) { ok = false; why = `R ${rr} vs ${boundaries + 1}`; }
    else if (buf.len !== 1 + rr + n || instSum !== n || !mono) { ok = false; why = "layout shape"; }
    else if (JSON.stringify(emulateSeq(buf.layout, buf)) !== JSON.stringify(canonSeq(s, c, d, n))) { ok = false; why = `sequence t=${t}`; }
  }
  check("consecutive: 300 random lists (n<=2000, runs of repeats) round-trip IN ORDER; R = boundaries + 1", ok, why);
}

// --- the wrapper, over a real three r184 SORTED bucket ------------------------------------
function makeExt() {
  const calls = [];
  return {
    calls,
    multiDrawElementsWEBGL(mode, counts, co, type, offsets, oo, drawCount) {
      calls.push({ kind: "elems", n: drawCount, counts: [...counts].slice(co, co + drawCount), offsets: [...offsets].slice(oo, oo + drawCount) });
    },
    multiDrawElementsInstancedWEBGL(mode, counts, co, type, offsets, oo, inst, io, drawCount) {
      calls.push({ kind: "inst", n: drawCount, counts: [...counts].slice(co, co + drawCount), offsets: [...offsets].slice(oo, oo + drawCount), inst: [...inst].slice(io, io + drawCount) });
    },
  };
}
function makeRenderer(ext) {
  const seenTex = [];
  return {
    info: { render: { frame: 0 } },
    extensions: { has: (n) => n === "WEBGL_multi_draw" && !!ext, get: () => ext },
    seenTex,
    renderBufferDirect(camera, scene, geometry, material, object) {
      seenTex.push(object._indirectTexture);
      if (object.isBatchedMesh && object._multiDrawCount > 0) {
        this.extensions.get("WEBGL_multi_draw").multiDrawElementsWEBGL(4, object._multiDrawCounts, 0, 5125, object._multiDrawStarts, 0, object._multiDrawCount);
      }
    },
  };
}
function tri(off) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([off, 0, 0, off + 1, 0, 0, off, 1, 0]), 3));
  g.setIndex([0, 1, 2]);
  return g;
}
function camAt(z) {
  const c = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  c.position.set(0, 0, z); c.lookAt(0, 0, 0); c.updateMatrixWorld(true);
  c.matrixWorldInverse.copy(c.matrixWorld).invert();
  return c;
}
const front = camAt(50), back = camAt(-50);
/** placements: [geom "A"|"B", x, z]. Transparent + sorted, like a translucent chunk bucket. */
function makeSortedBucket(placements, { mark = true } = {}) {
  const bm = new THREE.BatchedMesh(64, 64, 64, new THREE.MeshBasicMaterial({ transparent: true }));
  const gA = bm.addGeometry(tri(0)), gB = bm.addGeometry(tri(5));
  const m = new THREE.Matrix4();
  for (const [g, x, z] of placements) {
    const id = bm.addInstance(g === "A" ? gA : gB);
    bm.setMatrixAt(id, m.makeTranslation(x, 0, z));
  }
  bm.sortObjects = true;
  bm.perObjectFrustumCulled = true;
  bm.updateMatrixWorld(true);
  if (mark) markBatchedRuns(bm);
  return bm;
}
const rebuild = (bm, c) => THREE.BatchedMesh.prototype.onBeforeRender.call(bm, null, null, c, bm.geometry, bm.material, null);
const listOf = (bm) => canonSeq(bm._multiDrawStarts, bm._multiDrawCounts, bm._indirectTexture.image.data, bm._multiDrawCount);
const startsOf = (bm) => [...bm._multiDrawStarts.subarray(0, bm._multiDrawCount)];
function runSeq(call, tex) {
  const runs = { r: call.n, starts: call.offsets, counts: call.counts, inst: call.inst };
  return emulateSeq(tex.image.data, runs);
}

{
  __setBatchedRunsChunksForTest(true);
  const ext = makeExt();
  const r = makeRenderer(ext);
  installBatchedRuns(r);

  // Depth layers with ties at one z (three's sort is stable on ties, so instance
  // order survives inside a layer): z 0: A A A, z 1: B B, z 2: A, z 3: B, z 4: A A.
  const P = [["A", -2, 0], ["A", 0, 0], ["A", 2, 0], ["B", -1, 1], ["B", 1, 1], ["A", 0, 2], ["B", 0, 3], ["A", -1, 4], ["A", 1, 4]];
  const bm = makeSortedBucket(P);
  rebuild(bm, front);
  const sA = startsOf(bm)[0], sB = startsOf(bm)[3];
  check("setup: three's transparent sort (far first) gives A A A B B A B A A",
    bm._multiDrawCount === 9 && startsOf(bm).map((s) => (s === sA ? "A" : s === sB ? "B" : "?")).join("") === "AAABBABAA", startsOf(bm).join());
  const canon = bm._indirectTexture;
  const s0 = getBatchedRunsStats();
  r.info.render.frame = 1;
  r.renderBufferDirect(front, null, bm.geometry, bm.material, bm, null);
  const c1 = ext.calls.at(-1);
  check("draw: ONE instanced multidraw of 5 consecutive runs (3,2,1,1,2)", c1.kind === "inst" && c1.n === 5 && c1.inst.join() === "3,2,1,1,2", JSON.stringify(c1));
  const runTex = r.seenTex.at(-1);
  check("draw: three bound the run texture; canonical restored; nothing pending",
    runTex !== canon && runTex.isDataTexture === true && bm._indirectTexture === canon && __pendingForTest() === null);
  check("draw: the emulated GPU sequence on the UPLOADED texture equals three's sorted sequence",
    JSON.stringify(runSeq(c1, runTex)) === JSON.stringify(listOf(bm)));
  const s1 = getBatchedRunsStats();
  check("stats: sortedDraws +1, sortedInstances +9, sortedRuns +5, one rebuild + upload (both counted as sorted)",
    s1.sortedDraws - s0.sortedDraws === 1 && s1.sortedInstances - s0.sortedInstances === 9 && s1.sortedRuns - s0.sortedRuns === 5
      && s1.sortedRebuilds - s0.sortedRebuilds === 1 && s1.sortedUploads - s0.sortedUploads === 1
      && s1.rebuilds - s0.rebuilds === 1 && s1.uploads - s0.uploads === 1);
  check("stats: the unsorted counters did not move", s1.draws === s0.draws && s1.runs === s0.runs && s1.noGain === s0.noGain);

  // The same list again (a DoubleSide transparent material draws twice per onBeforeRender).
  const v1 = runTex.version;
  r.renderBufferDirect(front, null, bm.geometry, bm.material, bm, null);
  check("two-pass / unchanged list: same runs, same texture, no rebuild, no upload",
    ext.calls.at(-1).inst.join() === "3,2,1,1,2" && r.seenTex.at(-1) === runTex && runTex.version === v1
      && getBatchedRunsStats().sortedRebuilds === s1.sortedRebuilds);

  // Frame counters: sorted draws are counted in sortedSubDraws / sortedIssued too.
  r.info.render.frame = 2;
  r.renderBufferDirect(front, null, bm.geometry, bm.material, bm, null);
  const fr = getBatchedRunsStats().frame;
  check("frame: last frame = 2 sorted draws: 18 ranges asked, 10 issued (also in subDraws/issued)",
    fr.sortedSubDraws === 18 && fr.sortedIssued === 10 && fr.subDraws === 18 && fr.issued === 10, JSON.stringify(fr));
  check("frame: running totals expose the sorted pair", batchedRunsFrameTotals().sortedSubDraws === 9 && batchedRunsFrameTotals().sortedIssued === 5);

  // The camera moves to the other side: three re-sorts (order reverses), the runs follow.
  rebuild(bm, back);
  check("setup: from behind, three's order reverses to A A B A B B A A A",
    startsOf(bm).map((s) => (s === sA ? "A" : "B")).join("") === "AABABBAAA");
  r.renderBufferDirect(back, null, bm.geometry, bm.material, bm, null);
  const c2 = ext.calls.at(-1);
  check("moved: runs 2,1,1,2,3 in the new order", c2.kind === "inst" && c2.inst.join() === "2,1,1,2,3", JSON.stringify(c2));
  check("moved: the emulated sequence equals three's new sequence", JSON.stringify(runSeq(c2, r.seenTex.at(-1))) === JSON.stringify(listOf(bm)));
  check("moved: re-derived and re-uploaded", getBatchedRunsStats().sortedRebuilds === s1.sortedRebuilds + 1 && r.seenTex.at(-1).version > v1);

  // Builder switch on an UNCHANGED list: the cached layout must not be reused across builders.
  bm.sortObjects = false;
  r.renderBufferDirect(back, null, bm.geometry, bm.material, bm, null);
  const cg = ext.calls.at(-1);
  check("flip to unsorted (same list): regrouped into 2 runs by the grouping builder", cg.kind === "inst" && cg.n === 2 && cg.inst.join() === "6,3", JSON.stringify(cg));
  bm.sortObjects = true;
  r.renderBufferDirect(back, null, bm.geometry, bm.material, bm, null);
  const cs = ext.calls.at(-1);
  check("flip back to sorted (same list): consecutive runs again, three's order (not the grouped layout)",
    cs.kind === "inst" && cs.inst.join() === "2,1,1,2,3" && JSON.stringify(runSeq(cs, r.seenTex.at(-1))) === JSON.stringify(listOf(bm)));

  // The dangerous direction on its own: a bucket first derived UNSORTED (grouped
  // layout cached), then it starts sorting (static_batch_x `_reseatBucketSort`
  // flips `sortObjects` when a surface lands) while the list is still identical.
  {
    const u = makeSortedBucket([["A", 0, 0], ["B", 0, 1], ["A", 1, 2], ["A", 2, 2]]);
    u.sortObjects = false;
    THREE.BatchedMesh.prototype.onBeforeRender.call(u, null, null, front, u.geometry, u.material, null);
    r.renderBufferDirect(front, null, u.geometry, u.material, u, null);
    const g0 = ext.calls.at(-1);
    u.sortObjects = true; // same canonical arrays, now order-bound
    r.renderBufferDirect(front, null, u.geometry, u.material, u, null);
    const s0 = ext.calls.at(-1);
    check("grouped -> sorted on an unchanged list: re-derived by the consecutive builder, three's order kept",
      g0.inst.join() === "3,1" && s0.kind === "inst" && s0.inst.join() === "1,1,2"
        && JSON.stringify(runSeq(s0, r.seenTex.at(-1))) === JSON.stringify(listOf(u)), `${g0.inst} -> ${s0.inst}`);
  }

  // Seam off -> three's draw.
  __setBatchedRunsSortedOffForTest(true);
  r.renderBufferDirect(back, null, bm.geometry, bm.material, bm, null);
  check("seam: __batchedRuns.sortedOff -> canonical draw, canonical texture", ext.calls.at(-1).kind === "elems" && ext.calls.at(-1).n === 9 && r.seenTex.at(-1) === canon);
  __setBatchedRunsSortedOffForTest(false);

  // A malformed list (negative count) hands the draw back to three.
  rebuild(bm, front);
  const fb0 = getBatchedRunsStats().fallbacks;
  const keep = bm._multiDrawCounts[4];
  bm._multiDrawCounts[4] = -3;
  r.renderBufferDirect(front, null, bm.geometry, bm.material, bm, null);
  check("malformed: a negative count -> canonical, counted as a fallback", ext.calls.at(-1).kind === "elems" && getBatchedRunsStats().fallbacks === fb0 + 1);
  bm._multiDrawCounts[4] = keep;
  r.renderBufferDirect(front, null, bm.geometry, bm.material, bm, null);
  check("malformed: repaired list -> runs again", ext.calls.at(-1).kind === "inst" && ext.calls.at(-1).inst.join() === "3,2,1,1,2");

  // No consecutive repeat -> three's draw (sortedNoGain), even though ranges repeat.
  const alt = makeSortedBucket([["A", 0, 0], ["B", 0, 1], ["A", 0, 2], ["B", 0, 3]]);
  rebuild(alt, front);
  const ng0 = getBatchedRunsStats();
  r.renderBufferDirect(front, null, alt.geometry, alt.material, alt, null);
  const ng1 = getBatchedRunsStats();
  check("no-gain: A B A B (sorted) -> canonical, sortedNoGain +1, noGain unchanged",
    ext.calls.at(-1).kind === "elems" && ext.calls.at(-1).n === 4 && ng1.sortedNoGain === ng0.sortedNoGain + 1 && ng1.noGain === ng0.noGain);

  // Not opted in -> three's draw, still counted in the sorted frame totals.
  const plain = makeSortedBucket(P, { mark: false });
  rebuild(plain, front);
  r.info.render.frame = 3;
  r.renderBufferDirect(front, null, plain.geometry, plain.material, plain, null);
  r.info.render.frame = 4;
  r.renderBufferDirect(front, null, plain.geometry, plain.material, plain, null);
  const fu = getBatchedRunsStats().frame;
  check("unmarked sorted: canonical draw, counted in sortedSubDraws == sortedIssued",
    ext.calls.at(-1).kind === "elems" && fu.sortedSubDraws === 9 && fu.sortedIssued === 9, JSON.stringify(fu));

  // prepareRunDraw's default builder follows the mesh's own sortObjects.
  rebuild(bm, front);
  const st = prepareRunDraw(bm);
  check("prepareRunDraw(mesh): a sorted mesh gets the consecutive builder by default", st && st.buf.r === 5 && st.mode === 2);
  const st2 = prepareRunDraw(bm, false);
  check("prepareRunDraw(mesh, false): forced grouping (the pool_runs call shape stays valid)", st2 && st2.buf.r === 2 && st2.mode === 1);

  uninstallBatchedRuns(r);
}

// --- 2026-10-23 (review2 `batched-runs-sorted-nogain-cost`): a sorted list with NO -------
// consecutive repeat steps aside on a read-only scan, before any copy / build / layout
// write. The atlas translucent buckets are that shape for good (one geometry per member,
// static_atlas.js `_atlasDrawOrderFree` keeps them off the dedup ledger), and the default
// path re-sorts them per camera, CSM cascades included.
{
  // The scan's verdict IS the builder's: "repeat" exactly when R < n on a well-formed
  // list, and "go ask the builder" for anything it would reject.
  let ok = true, why = "";
  let seed = 977;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const b = makeRunBuffers();
  for (let t = 0; t < 400 && ok; t++) {
    const n = Math.floor(rnd() * 300);
    const geoms = 1 + Math.floor(rnd() * 40);
    const s = new Int32Array(n), c = new Int32Array(n), d = new Uint32Array(n);
    for (let k = 0; k < n; k++) { const g = Math.floor(rnd() * geoms); s[k] = g * 100; c[k] = 3 + (g % 5); d[k] = k; }
    if (n > 0 && rnd() < 0.1) c[Math.floor(rnd() * n)] = -3;
    const r = buildConsecutiveRuns(s, c, d, n, b);
    const want = r < 0 || r < n;
    if (hasConsecutiveRepeat(s, c, d, n) !== want) { ok = false; why = `t=${t} n=${n} R=${r}`; }
  }
  check("scan: hasConsecutiveRepeat == (builder rejects || R < n) over 400 random lists", ok, why);
  check("scan: lists the builder rejects go to the builder (n past an array, NaN n)",
    hasConsecutiveRepeat(Int32Array.from([0]), Int32Array.from([3, 4]), Uint32Array.from([1, 2]), 2) === true
      && hasConsecutiveRepeat(Int32Array.from([0, 6]), Int32Array.from([3, 3]), Uint32Array.from([1]), 2) === true
      && hasConsecutiveRepeat(Int32Array.from([0]), Int32Array.from([3]), Uint32Array.from([1]), NaN) === true);

  __setBatchedRunsChunksForTest(true);
  const ext = makeExt();
  const r = makeRenderer(ext);
  installBatchedRuns(r);
  // The atlas translucent shape: every member its own geometry, so R == n from any side.
  const bm = new THREE.BatchedMesh(64, 256, 256, new THREE.MeshBasicMaterial({ transparent: true }));
  const m = new THREE.Matrix4();
  for (let i = 0; i < 6; i++) {
    const id = bm.addInstance(bm.addGeometry(tri(i * 3)));
    bm.setMatrixAt(id, m.makeTranslation(0, 0, i));
  }
  bm.sortObjects = true;
  bm.perObjectFrustumCulled = true;
  bm.updateMatrixWorld(true);
  markBatchedRuns(bm);
  const s0 = getBatchedRunsStats();
  for (const c of [front, back, front, back]) {
    rebuild(bm, c);
    r.renderBufferDirect(c, null, bm.geometry, bm.material, bm, null);
  }
  const s1 = getBatchedRunsStats();
  check("distinct geometries (R == n), moving camera: three's canonical draw, 4 x sortedNoGain",
    ext.calls.at(-1).kind === "elems" && ext.calls.at(-1).n === 6 && s1.sortedNoGain - s0.sortedNoGain === 4);
  check("…and no copy / build / layout work: rebuilds, sortedRebuilds, uploads unchanged",
    s1.rebuilds === s0.rebuilds && s1.sortedRebuilds === s0.sortedRebuilds && s1.uploads === s0.uploads,
    `rebuilds +${s1.rebuilds - s0.rebuilds} sortedRebuilds +${s1.sortedRebuilds - s0.sortedRebuilds} uploads +${s1.uploads - s0.uploads}`);
  check("…and the counters it does keep are the same as before the scan (no fallback, no error)",
    s1.fallbacks === s0.fallbacks && s1.errors === s0.errors && s1.sortedDraws === s0.sortedDraws);

  // A no-gain draw leaves the bucket's run state as it was, and that state stays exact:
  // gain list L1, no-gain list L2, then L1 again and a third list L3.
  const g = makeSortedBucket([["A", -1, 0], ["A", 1, 0], ["B", 0, 1], ["B", 1, 1], ["A", 0, 2]]);
  rebuild(g, front);
  r.renderBufferDirect(front, null, g.geometry, g.material, g, null);
  const cL1 = ext.calls.at(-1), texL1 = r.seenTex.at(-1), vL1 = texL1.version;
  const okL1 = cL1.kind === "inst" && JSON.stringify(runSeq(cL1, texL1)) === JSON.stringify(listOf(g));
  // L2: the same canonical texture, rewritten in place to A B A B A (no consecutive repeat).
  const keepS = g._multiDrawStarts.slice(), keepC = g._multiDrawCounts.slice(), keepD = g._indirectTexture.image.data.slice();
  const sA = keepS[0], sB = keepS[2];
  const alt = [sA, sB, sA, sB, sA];
  for (let k = 0; k < 5; k++) { g._multiDrawStarts[k] = alt[k]; g._multiDrawCounts[k] = 3; }
  const ng0 = getBatchedRunsStats();
  r.renderBufferDirect(front, null, g.geometry, g.material, g, null);
  const ng1 = getBatchedRunsStats();
  check("gain -> no-gain on one canonical texture: canonical draw, sortedNoGain +1, nothing derived",
    ext.calls.at(-1).kind === "elems" && ng1.sortedNoGain === ng0.sortedNoGain + 1 && ng1.sortedRebuilds === ng0.sortedRebuilds);
  g._multiDrawStarts.set(keepS); g._multiDrawCounts.set(keepC); g._indirectTexture.image.data.set(keepD);
  r.renderBufferDirect(front, null, g.geometry, g.material, g, null);
  const cBack = ext.calls.at(-1);
  check("no-gain -> the earlier gain list: three's sequence, same texture, no re-upload",
    okL1 && cBack.kind === "inst" && cBack.inst.join() === "2,2,1" && r.seenTex.at(-1) === texL1 && texL1.version === vL1
      && JSON.stringify(runSeq(cBack, texL1)) === JSON.stringify(listOf(g)), `${cL1.inst} / ${cBack.inst}`);
  for (let k = 0; k < 5; k++) { g._multiDrawStarts[k] = alt[k]; g._multiDrawCounts[k] = 3; }
  r.renderBufferDirect(front, null, g.geometry, g.material, g, null);
  rebuild(g, back);
  r.renderBufferDirect(back, null, g.geometry, g.material, g, null);
  const cL3 = ext.calls.at(-1);
  check("no-gain -> a NEW gain list: re-derived, three's sequence",
    cL3.kind === "inst" && cL3.inst.join() === "1,2,2" && JSON.stringify(runSeq(cL3, r.seenTex.at(-1))) === JSON.stringify(listOf(g)), `${cL3.inst}`);

  // A malformed list with no repeat is still the builder's call: a fallback, not a no-gain.
  rebuild(bm, front);
  const f0 = getBatchedRunsStats();
  const keep = bm._multiDrawCounts[2];
  bm._multiDrawCounts[2] = -3;
  r.renderBufferDirect(front, null, bm.geometry, bm.material, bm, null);
  const f1 = getBatchedRunsStats();
  bm._multiDrawCounts[2] = keep;
  check("malformed no-repeat list: canonical draw, counted as a fallback (as before the scan)",
    ext.calls.at(-1).kind === "elems" && f1.fallbacks === f0.fallbacks + 1 && f1.sortedNoGain === f0.sortedNoGain);

  uninstallBatchedRuns(r);
  __setBatchedRunsChunksForTest(false);
}

// --- ?bmIndirectPerCamera: one canonical texture per camera, one run state each ------------
{
  installBatchedIndirectPerCamera(THREE, { force: true });
  __setBatchedRunsChunksForTest(true);
  const ext = makeExt();
  const r = makeRenderer(ext);
  installBatchedRuns(r);
  const P = [["A", -2, 0], ["A", 2, 0], ["B", 0, 1], ["B", 1, 1], ["A", 0, 2]];
  const bm = makeSortedBucket(P);
  const draw = (c) => { bm.onBeforeRender(r, null, c, bm.geometry, bm.material, null); r.renderBufferDirect(c, null, bm.geometry, bm.material, bm, null); return ext.calls.at(-1); };
  const pc0 = getBatchedIndirectPerCameraStats();
  const cf = draw(front);
  const texF = bm._indirectTexture;
  const seqF = listOf(bm);
  const okF = JSON.stringify(runSeq(cf, r.seenTex.at(-1))) === JSON.stringify(seqF);
  const cb = draw(back);
  const texB = bm._indirectTexture;
  const okB = JSON.stringify(runSeq(cb, r.seenTex.at(-1))) === JSON.stringify(listOf(bm));
  check("per-camera: each camera's sorted list draws as its own consecutive runs (front 2,2,1 / back 1,2,2)",
    cf.inst.join() === "2,2,1" && cb.inst.join() === "1,2,2" && okF && okB, `${cf.inst} / ${cb.inst}`);
  check("per-camera: two canonical textures (one per camera)", texF !== texB);
  const sR = getBatchedRunsStats();
  const cf2 = draw(front);
  const pc1 = getBatchedIndirectPerCameraStats();
  check("per-camera: the front camera again — its ids rolled back (no upload), runs unchanged, no run rebuild",
    cf2.inst.join() === "2,2,1" && pc1.skipped > pc0.skipped && getBatchedRunsStats().sortedRebuilds === sR.sortedRebuilds);
  uninstallBatchedRuns(r);
  uninstallBatchedIndirectPerCamera(THREE);
  __setBatchedRunsChunksForTest(false);
}

console.log(`\nbatched_runs_sorted: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
