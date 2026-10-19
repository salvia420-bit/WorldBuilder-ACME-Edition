// 2026-10-19 — ?depthBandSort (scene3d/depth_band_sort.js): a coarse depth band
// between renderOrder and the program key in the opaque sort, nearer first,
// under reversed-Z only (default off; `on` = one band per octave, `=N` = N).
//
// Run:
//   cd apps/holtburger-web/
//   node tests/depth_band_sort.test.mjs

import { register } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const VENDOR_CLOUDS = pathToFileURL(path.join(APP, "vendor", "takram-three-clouds", "build", "index.js")).href;
register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function resolve(spec, ctx, next) {
        if (spec === "@takram/three-clouds") return { url: ${JSON.stringify(VENDOR_CLOUDS)}, shortCircuit: true };
        return next(spec, ctx);
      }`,
    ),
);

const THREE = await import("three");
const B = await import("../scene3d/depth_band_sort.js");
const { makeProgramSort } = await import("../scene3d/draw_sort_program.js");

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const src = (rel) => readFileSync(path.join(APP, rel), "utf8");

console.log("-- D1 flag reader --------------------------------------------------------");
{
  const R = B.parseDepthBandSort;
  check("absent / empty -> 0 (off)", R("") === 0 && R("?foo=1") === 0 && R("?depthBandSort=") === 0);
  check("on / true / yes (any case) -> one band per octave", ["on", "ON", "true", "yes"].every((v) => R(`?depthBandSort=${v}`) === 1));
  check("a number -> that many bands per octave", R("?depthBandSort=2") === 2 && R("?depthBandSort=0.5") === 0.5 && R("?depthBandSort=1") === 1);
  check("clamped to [0.25, 8]", R("?depthBandSort=0.01") === 0.25 && R("?depthBandSort=100") === 8);
  check("off / 0 / false / no / negative / garbage -> 0", ["off", "0", "false", "no", "-2", "abc"].every((v) => R(`?depthBandSort=${v}`) === 0));
}

// three keys an item on (P·V·centre).z, no divide; the project negates it under reversed-Z.
function keyAt(cam, depth, negate) {
  const v = new THREE.Vector4(0.3, -0.2, -depth, 1).applyMatrix4(cam.projectionMatrix);
  return negate ? -v.z : v.z;
}

console.log("-- D2 depth recovered from the sort key (conventional and reversed) ----");
{
  const conv = new THREE.PerspectiveCamera(60, 1.6, 0.1, 5000);
  const rev = new THREE.PerspectiveCamera(60, 1.6, 0.1, 5000);
  rev._reversedDepth = true; rev.updateProjectionMatrix();
  const depths = [0.5, 1.5, 3, 7, 33, 100, 900, 4000];
  const band = (cam, d, negate, k) => {
    const e = cam.projectionMatrix.elements;
    return B.depthBandOf(keyAt(cam, d, negate), e[10], e[14], negate, k);
  };
  const want = (d, k) => (d > 1 ? Math.floor(Math.log2(d) * k) : 0);
  check("conventional projection, raw clip z", depths.every((d) => band(conv, d, false, 1) === want(d, 1)), depths.map((d) => band(conv, d, false, 1)).join(","));
  check("reversed projection, negated key (the shipped reversed-Z path)", depths.every((d) => band(rev, d, true, 1) === want(d, 1)), depths.map((d) => band(rev, d, true, 1)).join(","));
  check("reversed projection, raw key", depths.every((d) => band(rev, d, false, 1) === want(d, 1)));
  check("conventional matrix, negated key (frame 1 before three flips the camera)", depths.every((d) => band(conv, d, true, 1) === want(d, 1)));
  check("two bands per octave", depths.every((d) => band(rev, d, true, 2) === want(d, 2)));
  const bands = depths.map((d) => band(rev, d, true, 1));
  check("bands never decrease with depth", bands.every((b, i) => i === 0 || b >= bands[i - 1]));
  check("behind the eye / inside 1 m -> band 0", band(rev, 0.2, true, 1) === 0 && B.depthBandOf(keyAt(rev, -5, true), rev.projectionMatrix.elements[10], rev.projectionMatrix.elements[14], true, 1) === 0);
}

// A stand-in for three's WebGLRenderList / renderLists / render() call order.
function fakeRenderer({ reversed = true, sortFix = true } = {}) {
  const lists = new Map();
  const renderLists = {
    get(scene, depth) {
      const k = `${scene.id}:${depth}`;
      if (!lists.has(k)) lists.set(k, { opaque: [], sort(o) { if (this.opaque.length > 1) this.opaque.sort(o); } });
      return lists.get(k);
    },
  };
  if (sortFix) renderLists.__hbRevSortFix = true;
  const programs = new WeakMap();
  const r = {
    renderLists,
    info: { render: { frame: 0 } },
    properties: { get: (m) => ({ currentProgram: programs.get(m) || null }) },
    state: { buffers: { depth: { getReversed: () => reversed } } },
    sortCalls: [],
    opaqueSort: null,
    items: null,
    render(scene, camera) {
      r.info.render.frame++;
      const list = r.renderLists.get(scene, 0);
      list.opaque.length = 0;
      for (const it of r.items) list.opaque.push({ ...it, z: keyAt(camera, it.depth, sortFix && reversed) });
      let live = false; // read DURING the sort: the flag is only up inside it
      list.sort((a, b) => { if (B.depthBandsLive) live = true; return r.opaqueSort(a, b); });
      r.sortCalls.push({ scene: scene.id, live, order: list.opaque.map((i) => i.name) });
      return list.opaque;
    },
    setProgram(m, id) { programs.set(m, { id }); },
  };
  return r;
}

console.log("-- D3 install + sort integration (program sort) ------------------------");
{
  globalThis.window = {};
  const r = fakeRenderer();
  const matA = new THREE.MeshBasicMaterial(), matB = new THREE.MeshBasicMaterial();
  r.setProgram(matA, 1); r.setProgram(matB, 2);
  let n = 0;
  const item = (name, material, depth, renderOrder = 0) => ({ id: n++, name, object: {}, material, materialVariant: 0, groupOrder: 0, renderOrder, depth });
  // Programs 1 (A) and 2 (B), each with a near item (band 1: 2-4 m) and a far one
  // (band 8: 256-512 m). The program sort alone draws both A items first, so the
  // far A wall goes down before the near B prop that covers it.
  r.items = [
    item("far-A", matA, 300), item("near-B", matB, 3.5), item("near-A", matA, 3), item("far-B", matB, 280),
    item("sky", matB, 5000, -1),
  ];
  r.opaqueSort = makeProgramSort(r, null);
  check("installs", B.installDepthBandSort(r, { perOctave: 0 }) === true && typeof window.__depthBandSort.set === "function");
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
  cam._reversedDepth = true; cam.updateProjectionMatrix();
  r.render({ id: 1 }, cam);
  let last = r.sortCalls.at(-1);
  check("0 bands (default): the program sort exactly — programs grouped, renderOrder first",
    last.live === false && last.order.join(",") === "sky,near-A,far-A,near-B,far-B", last.order.join(","));
  check("__depthBandSort.set clamps and reports", window.__depthBandSort.set(100) === 8 && window.__depthBandSort.set(-1) === 0 && window.__depthBandSort.set(1) === 1);
  r.render({ id: 1 }, cam);
  last = r.sortCalls.at(-1);
  check("1 band/octave: nearer bands first, programs grouped inside a band, renderOrder still first",
    last.live === true && last.order.join(",") === "sky,near-A,near-B,far-A,far-B", last.order.join(","));
  check("depthBandsLive is false outside the sort", B.depthBandsLive === false);
  const st = window.__depthBandSort.stats();
  check("stats count the banded sort", st.banded >= 1 && st.items >= 5 && st.perOctave === 1);
  delete globalThis.window;
}

console.log("-- D4 inert under the log buffer and for ortho cameras ----------------");
{
  const r = fakeRenderer({ reversed: false, sortFix: false });
  const m = new THREE.MeshBasicMaterial(); r.setProgram(m, 1);
  r.items = [{ id: 1, name: "a", object: {}, material: m, materialVariant: 0, groupOrder: 0, renderOrder: 0, depth: 300 },
    { id: 2, name: "b", object: {}, material: m, materialVariant: 0, groupOrder: 0, renderOrder: 0, depth: 3 }];
  r.opaqueSort = makeProgramSort(r, null);
  B.installDepthBandSort(r, { perOctave: 1 });
  const s0 = B.getDepthBandSortStats();
  r.render({ id: 2 }, new THREE.PerspectiveCamera(60, 1, 0.1, 5000));
  check("log depth: no bands (no early-Z to feed)", r.sortCalls.at(-1).live === false && B.getDepthBandSortStats().skippedLog === s0.skippedLog + 1);
  const r2 = fakeRenderer();
  r2.setProgram(m, 1);
  r2.items = r.items;
  r2.opaqueSort = makeProgramSort(r2, null);
  B.installDepthBandSort(r2, { perOctave: 1 });
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const s1 = B.getDepthBandSortStats();
  r2.items = r2.items.map((i) => ({ ...i, depth: i.depth / 10 }));
  r2.render({ id: 3 }, ortho);
  check("ortho camera: no bands", r2.sortCalls.at(-1).live === false && B.getDepthBandSortStats().skippedOrtho === s1.skippedOrtho + 1);
}

console.log("-- D5 nested render() keeps each sort's own camera ----------------------");
{
  const r = fakeRenderer();
  const m = new THREE.MeshBasicMaterial(); r.setProgram(m, 1);
  r.items = [{ id: 1, name: "a", object: {}, material: m, materialVariant: 0, groupOrder: 0, renderOrder: 0, depth: 50 },
    { id: 2, name: "b", object: {}, material: m, materialVariant: 0, groupOrder: 0, renderOrder: 0, depth: 5 }];
  r.opaqueSort = makeProgramSort(r, null);
  const persp = new THREE.PerspectiveCamera(60, 1, 0.1, 5000); persp._reversedDepth = true; persp.updateProjectionMatrix();
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  // three's own nesting: a render() that renders another scene first (an
  // onBeforeRender target, a probe) re-enters through renderer.render.
  const inner = r.render;
  r.render = function (scene, camera) {
    if (scene.id === 4) r.render({ id: 5 }, ortho);
    return inner.call(this, scene, camera);
  };
  B.installDepthBandSort(r, { perOctave: 1 });
  r.render({ id: 4 }, persp);
  check("the nested ortho sort is not banded; the outer one bands with its own perspective camera",
    r.sortCalls.length === 2 && r.sortCalls[0].scene === 5 && r.sortCalls[0].live === false &&
    r.sortCalls[1].scene === 4 && r.sortCalls[1].live === true && r.sortCalls[1].order.join(",") === "b,a",
    JSON.stringify(r.sortCalls));
}

console.log("-- D5b a context restore (three rebuilds renderer.renderLists) ----------");
{
  const r = fakeRenderer();
  const m = new THREE.MeshBasicMaterial(); r.setProgram(m, 1);
  r.items = [{ id: 1, name: "a", object: {}, material: m, materialVariant: 0, groupOrder: 0, renderOrder: 0, depth: 50 },
    { id: 2, name: "b", object: {}, material: m, materialVariant: 0, groupOrder: 0, renderOrder: 0, depth: 5 }];
  r.opaqueSort = makeProgramSort(r, null);
  const persp = new THREE.PerspectiveCamera(60, 1, 0.1, 5000); persp._reversedDepth = true; persp.updateProjectionMatrix();
  B.installDepthBandSort(r, { perOctave: 1 });
  r.render({ id: 6 }, persp);
  const wraps = B.getDepthBandSortStats().listWraps;
  // initGLContext: a fresh WebGLRenderLists (shader_logdepth.js re-applies its
  // sort-key fix to it from its own webglcontextrestored listener).
  const fresh = fakeRenderer().renderLists;
  r.renderLists = fresh;
  r.render({ id: 6 }, persp);
  check("after a restore the new render lists are wrapped and the sort still bands",
    r.renderLists === fresh && fresh.__hbDepthBandGet === true && B.getDepthBandSortStats().listWraps === wraps + 1 &&
    r.sortCalls.at(-1).live === true && r.sortCalls.at(-1).order.join(",") === "b,a", JSON.stringify(r.sortCalls.at(-1)));
  r.render({ id: 6 }, persp);
  check("…once (no re-wrap while the lists stay the same)", B.getDepthBandSortStats().listWraps === wraps + 1);
}

console.log("-- D6 wiring ---------------------------------------------------------------");
{
  const dsp = src("scene3d/draw_sort_program.js");
  check("program sort: the band key sits right after renderOrder, ahead of the program",
    /if \(a\.renderOrder !== b\.renderOrder\) return a\.renderOrder - b\.renderOrder;\s*if \(depthBandsLive && a\.__hbBand !== b\.__hbBand\) return a\.__hbBand - b\.__hbBand;\s*if \(a\.material\.id !== b\.material\.id\) \{\s*const pa = programKey/.test(dsp) &&
    /import \{ depthBandsLive \} from "\.\/depth_band_sort\.js";/.test(dsp));
  const ap = src("scene3d/atmosphere_pipeline.js");
  check("phase-only sort (?drawSortProgram=off arm): the same band key",
    /function punchPhaseOpaqueSort\(a, b\) \{[\s\S]{0,400}if \(a\.renderOrder !== b\.renderOrder\) return a\.renderOrder - b\.renderOrder;\s*if \(depthBandsLive && a\.__hbBand !== b\.__hbBand\) return a\.__hbBand - b\.__hbBand;\s*if \(a\.material\.id !== b\.material\.id\)/.test(ap) &&
    /import \{ depthBandsLive \} from "\.\/depth_band_sort\.js";/.test(ap));
  const idx = src("scene3d/index.js");
  check("index.js installs it right after the program sort", /installDrawSortProgram\(renderer\);\s*(\/\/[^\n]*\n\s*)+installDepthBandSort\(renderer\);/.test(idx));
}

console.log(`\ndepth band sort: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
