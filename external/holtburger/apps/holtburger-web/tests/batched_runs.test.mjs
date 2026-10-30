// 2026-10-19 — ?batchedRuns (scene3d/batched_runs.js): an opted-in, unsorted
// BatchedMesh draws its visible instances as one INSTANCED range per distinct
// geometry instead of one range per instance (ANGLE/D3D11 loops a multidraw
// range by range on Chrome's GPU-process thread).
//
// What is pinned here, without a GPU:
//   * the three r184 premises the module leans on (where the multidraw is
//     issued, which texture the batching shader samples, the chunk text);
//   * the chunk patch (and that it refuses on drift);
//   * the run builder's layout, and — by emulating the patched vertex lookup on
//     the run texture — that a run draw reaches exactly the (range, instance)
//     pairs three's own draw would, no more, no fewer;
//   * the renderBufferDirect wrapper: the swap, the restore, the instanced call
//     it hands three's multidraw, every step-aside, upload-only-on-change, and
//     the run texture's lifetime.
// The GPU half (the patched GLSL compiling and drawing the same pixels) is
// harness/glsl_smoke/batched_runs_smoke.mjs (headless Chromium).
//
// Run:
//   cd apps/holtburger-web/
//   node tests/batched_runs.test.mjs

import * as THREE from "three";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  patchBatchingChunks, installBatchedRunsChunks, buildRuns, makeRunBuffers, RUN_MARKER,
  installBatchedRuns, uninstallBatchedRuns, markBatchedRuns, isBatchedRunsMarked, prepareRunDraw,
  getBatchedRunsStats, __setBatchedRunsOffForTest, __setBatchedRunsChunksForTest, __pendingForTest,
  __setBatchedRunsSortedOffForTest,
} from "../scene3d/batched_runs.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

// --- premises, anchored in three's source --------------------------------------
{
  const require = createRequire(import.meta.url);
  const src = readFileSync(require.resolve("three").replace(/[^/\\]+$/, "") + "three.module.js", "utf8");
  check("premise: the indexed multidraw is extension.multiDrawElementsWEBGL( mode, counts, 0, type, starts, 0, drawCount )",
    src.includes("extension.multiDrawElementsWEBGL( mode, counts, 0, type, starts, 0, drawCount );"));
  check("premise: the arrays multidraw is extension.multiDrawArraysWEBGL( mode, starts, 0, counts, 0, drawCount )",
    src.includes("extension.multiDrawArraysWEBGL( mode, starts, 0, counts, 0, drawCount );"));
  check("premise: a multidraw counts ONE call however many ranges (info.update( elementCount, mode, 1 ))",
    src.includes("info.update( elementCount, mode, 1 );"));
  check("premise: renderBufferDirect hands three's multidraw the object's own arrays",
    src.includes("renderer.renderMultiDraw( object._multiDrawStarts, object._multiDrawCounts, object._multiDrawCount );"));
  check("premise: setProgram binds batchingIdTexture from object._indirectTexture at draw time",
    src.includes("p_uniforms.setValue( _gl, 'batchingIdTexture', object._indirectTexture, textures );"));
  const pars = THREE.ShaderChunk.batching_pars_vertex;
  check("premise: three's indirect ids are an R32UI usampler (uint texel 0 can carry 0xFFFFFFFF)",
    pars.includes("uniform highp usampler2D batchingIdTexture;"));
}

// --- the chunk patch -------------------------------------------------------------
{
  const p = patchBatchingChunks(THREE.ShaderChunk);
  check("chunks: patch applies to three r184's text", p !== null);
  check("chunks: hbBatchSlot is defined after getIndirectIndex",
    p && p.pars.indexOf("int hbBatchSlot()") > p.pars.indexOf("float getIndirectIndex( const in int i )"));
  check("chunks: hbBatchSlot sits inside #ifdef USE_BATCHING, before the colour section",
    p && p.pars.indexOf("int hbBatchSlot()") > p.pars.indexOf("#ifdef USE_BATCHING")
      && p.pars.indexOf("int hbBatchSlot()") < p.pars.indexOf("#ifdef USE_BATCHING_COLOR"));
  check("chunks: the run head test reads texel 0 as 0xFFFFFFFFu",
    p && p.pars.includes("texelFetch( batchingIdTexture, ivec2( 0 ), 0 ).r == 0xFFFFFFFFu"));
  check("chunks: the run slot is runStart[ gl_DrawID ] + gl_InstanceID",
    p && p.pars.includes("return int( getIndirectIndex( gl_DrawID + 1 ) ) + gl_InstanceID;"));
  check("chunks: batching_vertex reads hbBatchSlot()",
    p && p.vert.includes("getBatchingMatrix( getIndirectIndex( hbBatchSlot() ) )") && !p.vert.includes("gl_DrawID"));
  check("chunks: color_vertex reads hbBatchSlot()",
    p && p.color.includes("getBatchingColor( getIndirectIndex( hbBatchSlot() ) )") && !p.color.includes("getIndirectIndex( gl_DrawID )"));
  const again = patchBatchingChunks({ batching_pars_vertex: p.pars, batching_vertex: p.vert, color_vertex: p.color });
  check("chunks: patching patched text is a no-op", again && again.pars === p.pars && again.vert === p.vert);
  check("chunks: drift (anchor missing) refuses",
    patchBatchingChunks({ ...THREE.ShaderChunk, batching_vertex: "mat4 batchingMatrix = mat4(1.0);" }) === null);
  check("chunks: non-object refuses", patchBatchingChunks(null) === null);
  const fake = { ShaderChunk: { ...THREE.ShaderChunk } };
  check("chunks: install rewrites a ShaderChunk object", installBatchedRunsChunks(fake, { force: true }) === true
    && fake.ShaderChunk.batching_vertex.includes("hbBatchSlot"));
}

// --- the run builder ---------------------------------------------------------------
function emulate(layout, runs) {
  // The patched vertex lookup, run by run: head marker, then ids[ runStart_r + i ].
  const out = [];
  if (layout[0] !== RUN_MARKER) return null;
  for (let r = 0; r < runs.r; r++) {
    for (let i = 0; i < runs.inst[r]; i++) {
      const slot = layout[1 + r] + i;
      out.push(`${runs.starts[r]}:${runs.counts[r]}:${layout[slot]}`);
    }
  }
  return out.sort();
}
{
  const starts = Int32Array.from([0, 30, 0, 60, 30, 0]);
  const counts = Int32Array.from([30, 30, 30, 9, 30, 30]);
  const ids = Uint32Array.from([4, 7, 1, 9, 2, 5]);
  const out = makeRunBuffers();
  const r = buildRuns(starts, counts, ids, 6, out);
  check("runs: 6 ranges over 3 geometries make 3 runs", r === 3 && out.r === 3);
  check("runs: runs are first-seen order with their counts",
    [...out.starts.subarray(0, 3)].join() === "0,30,60" && [...out.counts.subarray(0, 3)].join() === "30,30,9");
  check("runs: instance counts", [...out.inst.subarray(0, 3)].join() === "3,2,1");
  check("runs: layout length is 1 + R + n", out.len === 10);
  check("runs: head marker", out.layout[0] === RUN_MARKER);
  check("runs: run starts point past the header, back to back",
    [...out.layout.subarray(1, 4)].join() === "4,7,9");
  check("runs: ids grouped by run, canonical order kept inside a run",
    [...out.layout.subarray(4, 10)].join() === "4,1,5,7,2,9");
  const canon = [...starts].map((s, k) => `${s}:${counts[k]}:${ids[k]}`).sort();
  check("runs: the emulated GPU lookup reaches exactly the canonical (range, instance) pairs",
    JSON.stringify(emulate(out.layout, out)) === JSON.stringify(canon));
  check("runs: one start with two counts is refused",
    buildRuns(Int32Array.from([0, 0]), Int32Array.from([3, 6]), Uint32Array.from([1, 2]), 2, makeRunBuffers()) === -1);
  // Randomised: buffers grow, every list round-trips.
  let ok = true;
  const buf = makeRunBuffers();
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let t = 0; t < 200 && ok; t++) {
    const n = 2 + Math.floor(rnd() * 400);
    const geoms = 1 + Math.floor(rnd() * 40);
    const s = new Int32Array(n), c = new Int32Array(n), d = new Uint32Array(n);
    for (let k = 0; k < n; k++) { const g = Math.floor(rnd() * geoms); s[k] = g * 1000; c[k] = 3 + g * 3; d[k] = k * 7 + 1; }
    const rr = buildRuns(s, c, d, n, buf);
    const want = [...s].map((v, k) => `${v}:${c[k]}:${d[k]}`).sort();
    if (rr < 1 || rr > geoms || buf.len !== 1 + rr + n || JSON.stringify(emulate(buf.layout, buf)) !== JSON.stringify(want)) ok = false;
  }
  check("runs: 200 random lists (n<=400, <=40 geometries) round-trip through the emulated lookup", ok);
}

// --- the wrapper, over a real three BatchedMesh -------------------------------------
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
  const r = {
    info: { render: { frame: 0 } },
    extensions: { has: (n) => n === "WEBGL_multi_draw" && !!ext, get: () => ext },
    seenTex,
    // Stands in for three: binds object._indirectTexture, then issues the
    // multidraw exactly as WebGLIndexedBufferRenderer.renderMultiDraw does.
    renderBufferDirect(camera, scene, geometry, material, object) {
      seenTex.push(object._indirectTexture);
      if (object.isBatchedMesh && object._multiDrawCount > 0) {
        this.extensions.get("WEBGL_multi_draw").multiDrawElementsWEBGL(4, object._multiDrawCounts, 0, 5125, object._multiDrawStarts, 0, object._multiDrawCount);
      }
    },
  };
  return r;
}
function tri(off) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([off, 0, 0, off + 1, 0, 0, off, 1, 0]), 3));
  g.setIndex([0, 1, 2]);
  return g;
}
const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
cam.position.set(0, 0, 50); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true);
cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

function makeBucket(placements) {
  const bm = new THREE.BatchedMesh(64, 64, 64, new THREE.MeshBasicMaterial());
  const gA = bm.addGeometry(tri(0)), gB = bm.addGeometry(tri(5));
  const m = new THREE.Matrix4();
  for (const [g, x] of placements) {
    const id = bm.addInstance(g === "A" ? gA : gB);
    bm.setMatrixAt(id, m.makeTranslation(x, 0, 0));
  }
  bm.sortObjects = false;
  bm.perObjectFrustumCulled = true;
  bm.updateMatrixWorld(true);
  // three's own rebuild fills the canonical list (what the memo / sphere cache also produce).
  THREE.BatchedMesh.prototype.onBeforeRender.call(bm, null, null, cam, bm.geometry, bm.material, null);
  return bm;
}
{
  __setBatchedRunsChunksForTest(true);
  const ext = makeExt();
  const r = makeRenderer(ext);
  check("wrapper: installs", installBatchedRuns(r) === true);
  check("wrapper: idempotent", installBatchedRuns(r) === true);
  {
    // `=off` arm: chunks unpatched => the wrapper only COUNTS (three's draw, untouched).
    const src = (await import("node:fs")).readFileSync(new URL("../scene3d/batched_runs.js", import.meta.url), "utf8");
    check("wrapper: installs regardless of the flag (the off arm still counts ranges)",
      !/installBatchedRuns\(renderer[^)]*\) \{\s*if \(\(!FLAG/.test(src));
    check("wrapper: regrouping still requires the patched chunks", /!ctl\.off && _chunksPatched && \(object\._multiDrawCount \| 0\) > 1/.test(src));
    // 2026-10-22: a sorted mesh is admitted only through the order-keeping builder.
    check("wrapper: a sorted mesh needs ?batchedRunsSorted, and gets the consecutive builder",
      /so === false \|\| \(sorted && FLAG_SORTED && !ctl\.sortedOff\)/.test(src)
        && /sorted\s*\?\s*buildConsecutiveRuns\(/.test(src));
  }
  const bm = makeBucket([["A", 0], ["B", 2], ["A", 4], ["A", -4], ["B", -2]]);
  const canon = bm._indirectTexture;
  check("setup: three built 5 ranges", bm._multiDrawCount === 5);

  // Not opted in -> three's draw, untouched.
  r.renderBufferDirect(cam, null, bm.geometry, bm.material, bm, null);
  check("step-aside: an unmarked mesh draws canonically", ext.calls.at(-1).kind === "elems" && ext.calls.at(-1).n === 5);
  check("step-aside: an unmarked mesh keeps its texture", r.seenTex.at(-1) === canon);

  markBatchedRuns(bm);
  check("mark: marked", isBatchedRunsMarked(bm));
  const before = getBatchedRunsStats();
  r.renderBufferDirect(cam, null, bm.geometry, bm.material, bm, null);
  const call = ext.calls.at(-1);
  check("runs: the draw became ONE instanced multidraw of 2 runs", call.kind === "inst" && call.n === 2, JSON.stringify(call));
  check("runs: instance counts 3 + 2", call.inst.join() === "3,2");
  check("runs: per-run counts are the geometry ranges", call.counts.join() === "3,3");
  const swapped = r.seenTex.at(-1);
  check("runs: three bound the RUN texture during the draw", swapped !== canon && swapped.isDataTexture === true);
  check("runs: the canonical texture is restored after the draw", bm._indirectTexture === canon);
  check("runs: nothing pending after the draw", __pendingForTest() === null);
  const data = swapped.image.data;
  check("runs: run texture head is the marker", data[0] === RUN_MARKER);
  const runs = { r: 2, starts: call.offsets, counts: call.counts, inst: call.inst };
  const canonPairs = [];
  for (let k = 0; k < 5; k++) canonPairs.push(`${bm._multiDrawStarts[k]}:${bm._multiDrawCounts[k]}:${canon.image.data[k]}`);
  check("runs: the emulated lookup on the uploaded texture equals three's pairs",
    JSON.stringify(emulate(data, runs)) === JSON.stringify(canonPairs.sort()));
  check("runs: same format/type as three's indirect texture", swapped.format === canon.format && swapped.type === canon.type);
  const s1 = getBatchedRunsStats();
  check("stats: one run draw, 5 instances -> 2 runs, one upload",
    s1.draws - before.draws === 1 && s1.instances - before.instances === 5 && s1.runs - before.runs === 2 && s1.uploads - before.uploads === 1);

  // Unchanged canonical list -> no rebuild, no re-upload.
  const ver = swapped.version;
  r.renderBufferDirect(cam, null, bm.geometry, bm.material, bm, null);
  check("cache: an unchanged list re-uses the layout (no version bump)", r.seenTex.at(-1) === swapped && swapped.version === ver);
  check("cache: no rebuild counted", getBatchedRunsStats().rebuilds === s1.rebuilds);

  // A changed list (one instance hidden) -> rebuild + upload.
  bm.setVisibleAt(1, false);
  THREE.BatchedMesh.prototype.onBeforeRender.call(bm, null, null, cam, bm.geometry, bm.material, null);
  r.renderBufferDirect(cam, null, bm.geometry, bm.material, bm, null);
  const c2 = ext.calls.at(-1);
  check("change: hidden B instance -> runs 3 + 1", c2.kind === "inst" && c2.inst.join() === "3,1");
  check("change: the layout re-uploaded", swapped.version > ver);

  // A start whose ids match but whose RANGE moved (what a version rollback would hide).
  const s0 = bm._multiDrawStarts[0];
  bm._multiDrawStarts[0] = s0 + 999;
  r.renderBufferDirect(cam, null, bm.geometry, bm.material, bm, null);
  check("change: a moved range with identical ids is still re-derived", ext.calls.at(-1).offsets.includes(s0 + 999));
  bm._multiDrawStarts[0] = s0;
  r.renderBufferDirect(cam, null, bm.geometry, bm.material, bm, null);

  // Step-asides.
  __setBatchedRunsOffForTest(true);
  r.renderBufferDirect(cam, null, bm.geometry, bm.material, bm, null);
  check("step-aside: live seam off -> canonical", ext.calls.at(-1).kind === "elems" && r.seenTex.at(-1) === canon);
  __setBatchedRunsOffForTest(false);
  bm.sortObjects = true;
  __setBatchedRunsSortedOffForTest(true);
  r.renderBufferDirect(cam, null, bm.geometry, bm.material, bm, null);
  check("step-aside: a sorted bucket with ?batchedRunsSorted off -> canonical", ext.calls.at(-1).kind === "elems");
  __setBatchedRunsSortedOffForTest(false);
  // 2026-10-22: with it on (the default), the sorted bucket draws CONSECUTIVE runs
  // over the same canonical list — the GPU sequence is three's, entry for entry
  // (tests/batched_runs_sorted.test.mjs has the full suite).
  r.renderBufferDirect(cam, null, bm.geometry, bm.material, bm, null);
  {
    const cs = ext.calls.at(-1);
    const seq = [];
    const d = r.seenTex.at(-1).image.data;
    for (let q = 0; q < cs.n; q++) for (let i = 0; i < cs.inst[q]; i++) seq.push(`${cs.offsets[q]}:${cs.counts[q]}:${d[d[1 + q] + i]}`);
    const want = [];
    for (let k = 0; k < bm._multiDrawCount; k++) want.push(`${bm._multiDrawStarts[k]}:${bm._multiDrawCounts[k]}:${canon.image.data[k]}`);
    check("sorted: an opted-in sorted bucket draws consecutive runs in three's exact order",
      cs.kind === "inst" && cs.n < bm._multiDrawCount && seq.join() === want.join(), JSON.stringify(cs));
  }
  bm.sortObjects = false;
  __setBatchedRunsChunksForTest(false);
  r.renderBufferDirect(cam, null, bm.geometry, bm.material, bm, null);
  check("step-aside: unpatched chunks -> canonical (never the run layout through stock GLSL)", ext.calls.at(-1).kind === "elems" && r.seenTex.at(-1) === canon);
  __setBatchedRunsChunksForTest(true);

  const noRep = makeBucket([["A", 0], ["B", 2]]);
  markBatchedRuns(noRep);
  r.renderBufferDirect(cam, null, noRep.geometry, noRep.material, noRep, null);
  check("step-aside: no repeated range -> canonical (nothing to gain)", ext.calls.at(-1).kind === "elems" && ext.calls.at(-1).n === 2);

  const one = makeBucket([["A", 0]]);
  markBatchedRuns(one);
  r.renderBufferDirect(cam, null, one.geometry, one.material, one, null);
  check("step-aside: a single range -> canonical", ext.calls.at(-1).kind === "elems" && ext.calls.at(-1).n === 1);

  const plain = new THREE.Mesh(tri(0), new THREE.MeshBasicMaterial());
  r.renderBufferDirect(cam, null, plain.geometry, plain.material, plain, null);
  check("step-aside: a plain Mesh passes straight through", r.seenTex.at(-1) === undefined);

  // No WEBGL_multi_draw -> canonical.
  const r2 = makeRenderer(makeExt());
  installBatchedRuns(r2);
  r2.extensions.has = () => false;
  const fb = getBatchedRunsStats().fallbacks;
  r2.renderBufferDirect(cam, null, bm.geometry, bm.material, bm, null);
  check("step-aside: no WEBGL_multi_draw -> canonical, counted", r2.seenTex.at(-1) === canon && getBatchedRunsStats().fallbacks === fb + 1);

  // A context restore brings an unpatched extension object: re-patched on the next draw.
  const ext2 = makeExt();
  r.extensions.get = () => ext2;
  r.renderBufferDirect(cam, null, bm.geometry, bm.material, bm, null);
  check("restore: a new extension object is patched before use", ext2.calls.at(-1)?.kind === "inst");
  r.extensions.get = () => ext;

  // Frame accounting: subDraws = ranges asked for, issued = ranges after regrouping.
  r.info.render.frame = 7;
  r.renderBufferDirect(cam, null, bm.geometry, bm.material, bm, null);
  r.renderBufferDirect(cam, null, noRep.geometry, noRep.material, noRep, null);
  r.info.render.frame = 8;
  r.renderBufferDirect(cam, null, one.geometry, one.material, one, null);
  const fr = getBatchedRunsStats().frame;
  check("frame: last completed frame counts both BatchedMesh draws", fr.batchedCalls === 2, JSON.stringify(fr));
  check("frame: 4 + 2 ranges asked for, 2 + 2 issued", fr.subDraws === 6 && fr.issued === 4, JSON.stringify(fr));

  // Frame key (2026-10-26): the document timeline is read once per render()
  // call (renderer.info.render.frame), per renderer — never per BatchedMesh draw.
  {
    let reads = 0, T = 1000;
    const prevDoc = globalThis.document;
    globalThis.document = { timeline: { get currentTime() { reads += 1; return T; } } };
    try {
      r.info.render.frame = 20;
      r.renderBufferDirect(cam, null, bm.geometry, bm.material, bm, null);
      r.renderBufferDirect(cam, null, noRep.geometry, noRep.material, noRep, null);
      r.renderBufferDirect(cam, null, bm.geometry, bm.material, bm, null);
      check("frame key: one timeline read for three draws in one render()", reads === 1, `reads=${reads}`);
      r.info.render.frame = 21; // a second pass of the same display frame
      r.renderBufferDirect(cam, null, bm.geometry, bm.material, bm, null);
      check("frame key: the next render() re-reads once", reads === 2, `reads=${reads}`);
      T = 2000; r.info.render.frame = 22; // the next display frame
      r.renderBufferDirect(cam, null, bm.geometry, bm.material, bm, null);
      const fr2 = getBatchedRunsStats().frame;
      check("frame key: two passes of one display frame count as one frame", fr2.batchedCalls === 4, JSON.stringify(fr2));
      const r3 = makeRenderer(ext);
      installBatchedRuns(r3);
      r3.info.render.frame = 22;
      r3.renderBufferDirect(cam, null, bm.geometry, bm.material, bm, null);
      check("frame key: a second renderer keeps its own memo", reads === 4, `reads=${reads}`);
      uninstallBatchedRuns(r3);
    } finally {
      if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
    }
  }

  // 2026-10-30 (round 3 R3-0, lane H2): window.__batchedRuns.frameInto(out) — the
  // non-allocating twin of frame() the harness-v2 probe samples every frame with
  // (scripts/perf-worker/lib/hb_page.mjs). Same five fields as frame(), written into
  // the caller's object, which is returned (nothing allocated per call).
  {
    const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
    const prevWindow = globalThis.window;
    globalThis.window = {};
    const r4 = makeRenderer(ext);
    let api = null;
    try { installBatchedRuns(r4); api = globalThis.window.__batchedRuns || null; }
    finally { if (hadWindow) globalThis.window = prevWindow; else delete globalThis.window; }
    check("frameInto: the window seam offers frameInto next to frame()", !!api && typeof api.frame === "function" && typeof api.frameInto === "function");
    if (api && typeof api.frameInto === "function") {
      r4.info.render.frame = 40;
      r4.renderBufferDirect(cam, null, bm.geometry, bm.material, bm, null);
      r4.renderBufferDirect(cam, null, noRep.geometry, noRep.material, noRep, null);
      bm.sortObjects = true; // a sorted draw too, so sortedSubDraws / sortedIssued are not 0
      r4.renderBufferDirect(cam, null, bm.geometry, bm.material, bm, null);
      bm.sortObjects = false;
      r4.info.render.frame = 41; // rolls frame 40 into `last`
      r4.renderBufferDirect(cam, null, one.geometry, one.material, one, null);
      const want = api.frame();
      const FIELDS = ["batchedCalls", "subDraws", "issued", "sortedSubDraws", "sortedIssued"];
      check("frameInto: frame() has the five fields (sorted ones non-zero here)",
        JSON.stringify(Object.keys(want).sort()) === JSON.stringify([...FIELDS].sort()) && want.batchedCalls === 3 && want.sortedSubDraws > 0, JSON.stringify(want));
      const out = { stale: "kept" };
      const ret = api.frameInto(out);
      check("frameInto: returns the object it was given (no new object)", ret === out);
      check("frameInto: fills the same five fields with frame()'s values",
        FIELDS.every((k) => out[k] === want[k]), JSON.stringify(out));
      check("frameInto: touches nothing else on the caller's object", out.stale === "kept" && Object.keys(out).length === FIELDS.length + 1);
      const again = api.frameInto(out);
      check("frameInto: a second call reuses the same object", again === out && FIELDS.every((k) => out[k] === want[k]));
      const src = readFileSync(new URL("../scene3d/batched_runs.js", import.meta.url), "utf8");
      const body = (/frameInto: \(out\) => \{([^\n]*)\},\n/.exec(src) || [])[1] || "";
      check("frameInto: its body builds no object or array (no literal, spread or copy)",
        body.length > 0 && !/\{|\[|\.\.\.|Object\.|new /.test(body), body);
    }
    uninstallBatchedRuns(r4);
  }

  // Lifetime: the run texture is disposed with its canonical texture.
  let disposed = false;
  swapped.addEventListener("dispose", () => { disposed = true; });
  canon.dispose();
  check("lifetime: disposing the canonical texture disposes its run texture", disposed);

  // prepareRunDraw guards.
  check("guard: no indirect data -> null", prepareRunDraw({ _multiDrawCount: 3, _indirectTexture: { image: {} }, _multiDrawStarts: [], _multiDrawCounts: [] }) === null);

  uninstallBatchedRuns(r);
  check("uninstall: original restored", r.__hbBatchedRuns === undefined);
}

console.log(`\nbatched_runs: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
