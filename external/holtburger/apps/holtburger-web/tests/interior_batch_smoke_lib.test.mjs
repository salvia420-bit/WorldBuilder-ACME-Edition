// tests/interior_batch_smoke_lib.test.mjs — node dry run of the R3-5
// `?interiorBatch` SwiftShader smoke arms (harness/glsl_smoke/interior_batch_lib.mjs)
// on three r184 + the recording fake WebGL2, so the browser smoke
// (harness/glsl_smoke/interior_batch_smoke.mjs, orchestrator-run) cannot fail
// on a JS error, a wrong arm shape or a world that never batches. The pixels
// themselves are the browser's to compare (the fake GL rasterises nothing).
//
//   D1  every arm runs with the flag off and on (real clock: the per-sync
//       budget may spread the set-up, the arm ticks until settled): the off
//       load never arms the batch; the on load settles to an active chunk,
//       its decoded bits equal the container set, it issues fewer draw
//       calls; both loads see the same visible cell set; the frame has the
//       canvas size. punch: the real cells.js tickPortalPunch fed the real
//       PortalPunchPass in both loads (the doorway is punched, its screen
//       rect is on the canvas), the world-only reference frame is there.
//       shadowmap: BasicShadowMap, a depth readback of mapSize^2 texels.
//   D2  the layers arm walks every admitted layer and level.
//   D3  the page imports the lib and the app modules it hands the arms
//       (incl. portal_punch.js); the runner serves every path the page and
//       the cells.js graph import (three, three/addons, postprocessing,
//       /app/), gates each arm, and PARSES (compiled, not run: it launches a
//       browser).
//   D5  (2026-10-31, POM members) the +pom arms (LIB.POM_ARMS, `&pom=1`: the
//       rig's POM material cache, cells un-baked): D1's gates, the on load
//       batched POM members (POM slots next to the flag-only props) with no
//       texture re-plan; the pom arm's close camera frames cell 0 (at least a
//       quarter of the canvas, within the POM band); the layers arm walks the
//       R8 height layers; the page passes `pom` through and the runner loads
//       and gates the arms.
//   D4  (realboot 2026-10-31) the +pools arms (LIB.POOL_ARMS, `&pools=1`:
//       the env-cell draw pools armed as index.js arms them): both loads arm
//       the pools and read the same pool state, the on load is not disarmed,
//       batches what the pools leave (D1's gates), and its diag reads the
//       pools; the page passes `pools` through and the runner gates them.
//
// Run: node tests/interior_batch_smoke_lib.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import * as R from "./interior_batch_rig.mjs";
import { createFakeWebGL2, fakeCanvas } from "./helpers/fake_webgl2.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
globalThis.window ??= {};
globalThis.location = { search: R.BASE_SEARCH };
globalThis.window.location = globalThis.location;
globalThis.window.requestAnimationFrame ??= () => 1;

const M = await import("../scene3d/materials.js");
const adapter = await import("../scene3d/adapter.js");
const KIT = await import("../scene3d/gpu_batch/kit.js");
const IB = await import("../scene3d/gpu_batch/interior_batch.js");
const LIB = await import("../harness/glsl_smoke/interior_batch_lib.mjs");
const PP = await import("../scene3d/portal_punch.js");
const cellsOff = await R.loadCells("");
const cellsOn = await R.loadCells("interiorBatch=on");

let failures = 0;
let passes = 0;
async function t(name, fn) {
  try { await fn(); passes++; console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name); console.log(e); }
}

function renderer() {
  const gl = createFakeWebGL2();
  const r = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl, LIB.CANVAS, LIB.CANVAS), context: gl });
  r.shadowMap.enabled = true;
  return r;
}

async function load(arm, on, pools = false, pom = false) {
  KIT.resetKit();
  IB.disposeInteriorBatches();
  IB.__setInteriorBatchEnvForTest(on ? { mode: "on" } : null);
  await R.resetPools();
  const mods = { M, adapter, cells: on ? cellsOn : cellsOff, IB, KIT, PP };
  const l = console.warn;
  console.warn = () => {};
  try { return await LIB.runArm(THREE, renderer(), mods, arm, { ticks: 6, pools, pom }); } finally { console.warn = l; }
}

await t("D1 every arm, flag off and on: shape, batching, bits, fewer calls, same visible set; punch fed, shadow map read", async () => {
  assert.deepEqual(LIB.ARM_NAMES, ["layers", "town", "punch", "dungeon", "sealed", "shadow", "shadowmap"]);
  for (const arm of ["town", "punch", "dungeon", "sealed", "shadow", "shadowmap"]) {
    const off = await load(arm, false);
    const on = await load(arm, true);
    for (const r of [off, on]) {
      assert.equal(r.frame.length, LIB.CANVAS * LIB.CANVAS * 4, `${arm}: canvas-size frame`);
      assert.ok(Number.isFinite(r.calls) && r.calls > 0, `${arm}: draw calls counted`);
    }
    assert.equal(off.batch, null, `${arm}: the off load never armed`);
    assert.equal(off.bits, null);
    const cov = on.coverage;
    assert.ok(on.batch && cov && cov.chunks === 1 && cov.visibleMeshes > 0 && cov.suppressed === cov.visibleMeshes,
      `${arm}: every batched mesh of a visible cell handed over: ${JSON.stringify({ batch: on.batch, cov })}`);
    assert.equal(off.coverage, null);
    assert.ok(on.bits.cells > 0 && on.bits.bad === 0, `${arm}: bits = containers ${JSON.stringify(on.bits)}`);
    assert.equal(on.batch.bitMismatch, 0);
    assert.ok(on.calls < off.calls, `${arm}: ${on.calls} < ${off.calls} calls`);
    assert.deepEqual(on.visible, off.visible, `${arm}: same visible cells`);
    assert.ok(on.visible.length > 0);
    assert.equal(on.settled, true, `${arm}: settled after ${on.ticks} ticks`);
    if (arm === "punch") {
      for (const r of [off, on]) {
        assert.equal(r.punched, true, "the real tickPortalPunch fed the real PortalPunchPass");
        const d = r.doorway;
        assert.ok(d.x0 >= 0 && d.y0 >= 0 && d.x1 <= LIB.CANVAS && d.y1 <= LIB.CANVAS && d.x1 - d.x0 > 8 && d.y1 - d.y0 > 8, `doorway on the canvas: ${JSON.stringify(d)}`);
        assert.equal(r.worldFrame.length, LIB.CANVAS * LIB.CANVAS * 4, "the world-only reference frame");
        // The browser gate needs interior pixels inside the doorway and roof outside it.
        assert.ok(r.doorwayMeshes.some((n) => /^surfaces-fused-opaque-a9b40100/.test(n)) && r.doorwayMeshes.filter((n) => /^cellstatic-a9b40100/.test(n)).length === 2,
          `cell 0 and its props behind the doorway: ${r.doorwayMeshes}`);
        assert.ok(!r.doorwayMeshes.some((n) => /a9b4010[123]/.test(n)), `cells 1-3 outside it: ${r.doorwayMeshes}`);
        assert.ok(d.x1 - d.x0 < LIB.CANVAS * 0.6 && d.y1 - d.y0 < LIB.CANVAS * 0.6, "roof left outside the doorway");
      }
      const rd = LIB.rectDiff(on.frame, on.worldFrame, on.doorway);
      assert.ok(Number.isInteger(rd.inside) && Number.isInteger(rd.outside));
    }
    if (arm === "shadowmap") {
      for (const r of [off, on]) assert.ok(r.shadowDepth instanceof Float32Array && r.shadowDepth.length === 512 * 512, "the depth readback");
      assert.equal(LIB.depthDiff(on.shadowDepth, off.shadowDepth).sameSize, true);
    } else {
      assert.equal(on.shadowDepth, undefined);
    }
  }
  IB.__setInteriorBatchEnvForTest(null);
});

await t("D2 the layers arm walks every admitted layer and level", async () => {
  const r = await load("layers", true);
  assert.ok(r.layers && r.layers.layers >= 7 && r.layers.levels > r.layers.layers, JSON.stringify(r.layers));
  assert.equal(r.layers.mismatched, 0, "dry run: both sides read through the same (fake) GL");
  IB.disposeInteriorBatches();
  IB.__setInteriorBatchEnvForTest(null);
});

await t("D3 the page imports the lib + modules; the runner serves every import root and gates each arm", () => {
  const page = readFileSync(path.join(APP, "harness/glsl_smoke/interior_batch_page.html"), "utf8");
  for (const p of ["/app/harness/glsl_smoke/interior_batch_lib.mjs", "/app/scene3d/materials.js", "/app/scene3d/adapter.js", "/app/scene3d/cells.js",
    "/app/scene3d/gpu_batch/interior_batch.js", "/app/scene3d/gpu_batch/kit.js", "/app/scene3d/portal_punch.js"]) assert.ok(page.includes(p), p);
  for (const k of ['"three": "/three/three.module.js"', '"three/addons/": "/three-addons/"', '"postprocessing": "/pp/index.js"']) assert.ok(page.includes(k), k);
  assert.ok(!/[`]/.test(page.split("<script type=\"module\">")[0]), "no template literal in the import map");
  const runner = readFileSync(path.join(APP, "harness/glsl_smoke/interior_batch_smoke.mjs"), "utf8");
  for (const k of ["/three-addons/", "/three/", "/pp/", "/app/", "interior_batch_page.html"]) assert.ok(runner.includes(k), k);
  for (const arm of LIB.ARM_NAMES) assert.ok(runner.includes(`"${arm}"`) || runner.includes(`arm=${arm}`), arm);
  for (const g of ["the doorway was punched", "within 4 depth ulps", "the on load settled"]) assert.ok(runner.includes(g), `gate: ${g}`);
  assert.ok(runner.includes("capped-build node harness/glsl_smoke/interior_batch_smoke.mjs"), "the run command is documented");
  // The runner parses: compiled as an async function body (its imports and
  // import.meta stripped), never called.
  const body = runner
    .replace(/^import\s[^;]*;$/gm, "")
    .replace(/import\.meta\.url/g, JSON.stringify("file:///runner.mjs"))
    .replace(/await import\(/g, "await (async () => ({}))(");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction(body), "the runner parses");
  // The module graph the page loads needs exactly those bare specifiers.
  const bare = new Set();
  const seen = new Set();
  const visit = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gms)) {
      const s = m[1];
      if (s.startsWith(".")) visit(path.resolve(path.dirname(f), s.split("?")[0])); else bare.add(s);
    }
  };
  for (const f of ["scene3d/cells.js", "scene3d/materials.js", "scene3d/adapter.js", "harness/glsl_smoke/interior_batch_lib.mjs"]) visit(path.join(APP, f));
  for (const s of bare) assert.ok(s === "three" || s === "postprocessing" || s.startsWith("three/addons/"), `the page import map resolves ${s}`);
});

await t("D4 the +pools arms: pools armed in both loads, same pool state, the on load batches what they leave", async () => {
  assert.deepEqual(LIB.POOL_ARMS, ["town", "dungeon", "shadowmap"]);
  for (const arm of LIB.POOL_ARMS) {
    const off = await load(arm, false, true);
    const on = await load(arm, true, true);
    for (const r of [off, on]) {
      assert.ok(r.pools && r.pools.active === true && r.pools.surfacesPooled === 4 && r.pools.cells.length === 3, `${arm}: pools armed ${JSON.stringify(r.pools)}`);
      assert.ok(r.pools.meshes.length > 0 && r.pools.meshes.every((m) => m.cellsChild && m.mask === 2 && !m.sentinel), `${arm}: pool objects ${JSON.stringify(r.pools.meshes)}`);
    }
    assert.equal(JSON.stringify(on.pools), JSON.stringify(off.pools), `${arm}: the pools read the same in both loads`);
    assert.equal(off.batch, null, `${arm}: the off load never armed the batch`);
    assert.deepEqual(on.batch.disarmed, {}, `${arm}: not disarmed`);
    assert.ok(on.batch.pools && on.batch.pools.active === true && on.batch.pools.cells === 3 && on.batch.pools.partitionRefused === 0 && on.batch.pools.visDiverged === 0,
      `${arm}: batch.pools ${JSON.stringify(on.batch.pools)}`);
    const cov = on.coverage;
    assert.ok(cov && cov.chunks === 1 && cov.visibleMeshes > 0 && cov.suppressed === cov.visibleMeshes, `${arm}: handed over ${JSON.stringify(cov)}`);
    assert.ok(on.bits.cells > 0 && on.bits.bad === 0 && on.batch.bitMismatch === 0, `${arm}: bits ${JSON.stringify(on.bits)}`);
    assert.ok(on.calls < off.calls, `${arm}: ${on.calls} < ${off.calls} calls`);
    assert.deepEqual(on.visible, off.visible);
    assert.equal(on.settled, true);
    if (arm === "shadowmap") assert.equal(LIB.depthDiff(on.shadowDepth, off.shadowDepth).sameSize, true);
  }
  const page = readFileSync(path.join(APP, "harness/glsl_smoke/interior_batch_page.html"), "utf8");
  assert.ok(page.includes('get("pools") === "1"') && /runArm\([^)]*pools/.test(page) && page.includes("out.pools = r.pools"), "the page passes pools through");
  const runner = readFileSync(path.join(APP, "harness/glsl_smoke/interior_batch_smoke.mjs"), "utf8");
  assert.ok(runner.includes("for (const arm of LIB.POOL_ARMS)") && runner.includes("&pools=1&interiorBatch=on"), "the runner loads the +pools arms");
  for (const g of ["the pools armed and took the page-dim shell surfaces", "the batch is not disarmed and reads the pools", "the pools read the same in both loads"]) assert.ok(runner.includes(g), `gate: ${g}`);
  IB.disposeInteriorBatches();
  IB.__setInteriorBatchEnvForTest(null);
  await R.resetPools();
});

await t("D5 the +pom arms: the POM cache world batches its POM members; the close frame; the R8 readback; page + runner", async () => {
  assert.deepEqual(LIB.POM_ARMS, ["pom", "shadowmap"]);
  for (const arm of LIB.POM_ARMS) {
    const off = await load(arm, false, false, true);
    const on = await load(arm, true, false, true);
    assert.equal(off.batch, null, `${arm}: the off load never armed`);
    const cov = on.coverage;
    assert.ok(on.batch && cov && cov.chunks === 1 && cov.visibleMeshes > 0 && cov.suppressed === cov.visibleMeshes,
      `${arm}: every batched mesh of a visible cell handed over: ${JSON.stringify({ batch: on.batch, cov })}`);
    assert.ok(on.bits.cells > 0 && on.bits.bad === 0 && on.batch.bitMismatch === 0, `${arm}: bits ${JSON.stringify(on.bits)}`);
    assert.ok(on.calls < off.calls, `${arm}: ${on.calls} < ${off.calls} calls`);
    assert.deepEqual(on.visible, off.visible);
    assert.equal(on.settled, true, `${arm}: settled after ${on.ticks} ticks`);
    assert.ok(on.batch.pomSlots >= 4 && on.batch.slots > on.batch.pomSlots && on.batch.textureReplans === 0,
      `${arm}: POM members batched next to the flag-only props ${JSON.stringify({ pomSlots: on.batch.pomSlots, slots: on.batch.slots, unit: on.batch.unitReasons })}`);
    if (arm === "pom") {
      for (const r of [off, on]) assert.ok(r.cell0Rect && r.cell0Rect.share >= 0.25, `the close camera frames cell 0: ${JSON.stringify(r.cell0Rect)}`);
    }
    if (arm === "shadowmap") assert.equal(LIB.depthDiff(on.shadowDepth, off.shadowDepth).sameSize, true);
  }
  const L = await load("layers", true, false, true);
  assert.ok(L.layers && L.layers.pomLayers >= 4 && L.layers.layers > L.layers.pomLayers && L.layers.mismatched === 0, JSON.stringify(L.layers));
  const page = readFileSync(path.join(APP, "harness/glsl_smoke/interior_batch_page.html"), "utf8");
  assert.ok(page.includes('get("pom") === "1"') && /runArm\([^)]*pom \}/.test(page), "the page passes pom through");
  const runner = readFileSync(path.join(APP, "harness/glsl_smoke/interior_batch_smoke.mjs"), "utf8");
  assert.ok(runner.includes("for (const arm of LIB.POM_ARMS)") && runner.includes("&pom=1&interiorBatch=on") && runner.includes("arm=layers&pom=1&interiorBatch=on"), "the runner loads the +pom arms");
  for (const g of ["the POM members batched", "the R8 height layers too"]) assert.ok(runner.includes(g), `gate: ${g}`);
  IB.disposeInteriorBatches();
  IB.__setInteriorBatchEnvForTest(null);
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
