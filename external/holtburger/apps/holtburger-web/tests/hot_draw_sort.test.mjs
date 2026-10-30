// tests/hot_draw_sort.test.mjs — lane F hot spots (2026-10-26):
// `?hotDrawSort` per-item memo comparator in scene3d/draw_sort_program.js.
//
// CLAIM: the memo comparator returns the same SIGN as the shipped comparator
// for every pair V8's TimSort asks about, so three's opaque list comes out in
// the same order element by element — ties (equal keys down to `id`) included —
// and it asks `renderer.properties` about exactly the same materials each frame.
//
// HOW: a pooled render list built like three r184's WebGLRenderList
// (getNextRenderItem re-points pooled item objects every render(), `id` =
// object.id, multi-group objects share an id), objects of seven three classes
// under tagged / untagged / not-yet-attached groups, the ?punchRetail phase
// function (a verbatim copy of atmosphere_pipeline.js `_punchPhase`/`_phaseOf`,
// with ?terrainLast toggling between frames), ~400 materials over ~80 programs
// (some uncompiled, programs re-bound between frames), renderOrder / groupOrder
// classes, duplicate z, and the ?depthBandSort key on some frames (through the
// real depth_band_sort.js list wrapper, so `depthBandsLive` is the live binding).
// Each frame sorts the same input with both comparators and compares.
// `info.render.frame` advances after the sort, as three does.
//
// Run:   cd apps/holtburger-web && node tests/hot_draw_sort.test.mjs [--bench]
// (also covers retention [6] and the aborted-sort premises [7] on three's real WebGLRenderer)

import * as THREE from "three";
import { _makeReferenceSort, makeProgramSort, __setHotDrawSortForTest, hotDrawSortEnabled } from "../scene3d/draw_sort_program.js";
import { installDepthBandSort } from "../scene3d/depth_band_sort.js";

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// ── atmosphere_pipeline.js _punchPhase / _phaseOf (verbatim logic) ──────────
let _terrainLastNow = false;
function _punchPhase(obj) {
  const cached = obj.__hbPunchPhase;
  if (cached !== undefined) return cached;
  let p = 0;
  let attached = false;
  for (let o = obj; o; o = o.parent) {
    const tag = o.userData?.__punchPhase;
    if (tag !== undefined) { p = tag; attached = true; break; }
    if (!o.parent) { attached = o.isScene === true; break; }
  }
  if (attached) obj.__hbPunchPhase = p;
  return p;
}
function phaseOf(obj) {
  const p = _punchPhase(obj);
  return p === 0 && _terrainLastNow ? 3 : p;
}

// ── fake renderers (properties = three's WeakMap semantics, get() creates) ──
function fakeRenderer(label) {
  const map = new WeakMap();
  const asked = new Set();
  const r = {
    label,
    info: { render: { frame: 0 } },
    properties: {
      get(m) {
        asked.add(m);
        let p = map.get(m);
        if (p === undefined) { p = {}; map.set(m, p); }
        return p;
      },
    },
    asked,
    bind(m, prog) { const p = map.get(m) || {}; map.set(m, p); p.currentProgram = prog; },
    // three-like render(): sort the opaque list through renderLists (so the
    // depth-band wrapper can run), then advance info.render.frame.
    renderLists: null,
    state: { buffers: { depth: { getReversed: () => true } } },
    render(scene, camera) {
      const list = this.renderLists.get(scene, 0);
      list.sort(this._opaqueSort, null);
      this.info.render.frame++;
    },
    _opaqueSort: null,
  };
  r.renderLists = {
    _list: { opaque: [], sort(opaqueSort) { if (this.opaque.length > 1) this.opaque.sort(opaqueSort); } },
    get() { return this._list; },
  };
  return r;
}

// ── world ────────────────────────────────────────────────────────────────────
const r = rng(4242);
const scene = new THREE.Scene();
const groups = [];
for (let i = 0; i < 12; i++) {
  const g = new THREE.Group();
  if (i % 4 === 0) g.userData.__punchPhase = (i / 4) % 3;   // tagged 0 / 1 / 2
  (i % 3 === 0 ? scene : groups[(r() * groups.length) | 0] || scene).add(g);
  groups.push(g);
}
const detached = new THREE.Group(); // not under the scene yet: phase not cached
const programs = Array.from({ length: 80 }, (_, i) => ({ id: 1 + ((i * 37) % 97) }));
const matClasses = [THREE.MeshStandardMaterial, THREE.MeshBasicMaterial, THREE.MeshLambertMaterial, THREE.PointsMaterial, THREE.LineBasicMaterial, THREE.SpriteMaterial];
const materials = Array.from({ length: 400 }, (_, i) => new matClasses[i % matClasses.length]());
const geom = new THREE.BufferGeometry();
function makeObject(i) {
  const k = i % 7;
  const m = materials[(r() * materials.length) | 0];
  let o;
  if (k === 0) o = new THREE.InstancedMesh(geom, m, 1);
  else if (k === 1) o = new THREE.SkinnedMesh(geom, m);
  else if (k === 2) o = new THREE.Points(geom, m);
  else if (k === 3) o = new THREE.Line(geom, m);
  else if (k === 4) o = new THREE.Sprite(m);
  else if (k === 5) o = new THREE.BatchedMesh(1, 3, 3, m);
  else o = new THREE.Mesh(geom, m);
  const roll = r();
  o.renderOrder = roll < 0.80 ? 0 : roll < 0.88 ? -1 : roll < 0.94 ? 1 : roll < 0.98 ? 5 : 100;
  (r() < 0.05 ? detached : groups[(r() * groups.length) | 0]).add(o);
  return o;
}
const objects = Array.from({ length: 1300 }, (_, i) => makeObject(i));

const refR = fakeRenderer("ref"), newR = fakeRenderer("new");
function bindAll(frac) {
  for (const m of materials) {
    if (r() > frac) continue;
    const prog = r() < 0.05 ? undefined : programs[(r() * programs.length) | 0];
    refR.bind(m, prog); newR.bind(m, prog);
  }
}
bindAll(1);

// three's render-item pool (one per renderer, like one WebGLRenderList each)
function makePool() { return { items: [], n: 0 }; }
const poolRef = makePool(), poolNew = makePool();
function nextItem(pool, object, material, groupOrder, z, group) {
  let it = pool.items[pool.n];
  const mv = (object.isInstancedMesh ? 1 : 0) + (object.isBatchedMesh ? 2 : 0) + (object.isSkinnedMesh ? 4 : 0);
  if (it === undefined) {
    it = { id: object.id, object, geometry: geom, material, materialVariant: mv, groupOrder, renderOrder: object.renderOrder, z, group };
    pool.items[pool.n] = it;
  } else {
    it.id = object.id; it.object = object; it.geometry = geom; it.material = material; it.materialVariant = mv;
    it.groupOrder = groupOrder; it.renderOrder = object.renderOrder; it.z = z; it.group = group;
  }
  pool.n++;
  return it;
}
// One frame's projectObject: the same draws for both pools, in traversal order.
function project(frameNo) {
  const draws = [];
  const zq = [0, -0, 1.5, 1.5, 3, 7.25];
  for (const o of objects) {
    if (r() < 0.15) continue;                                   // culled this frame
    const gOrder = o.parent && o.parent.userData.__punchPhase === 2 && r() < 0.3 ? 1 : 0;
    const z = r() < 0.2 ? zq[(r() * zq.length) | 0] : (r() * 120 - 20);
    const nGroups = r() < 0.08 ? 2 : 1;                         // multi-material: same object.id twice
    for (let g = 0; g < nGroups; g++) {
      const m = g === 0 ? o.material : (r() < 0.5 ? o.material : materials[(r() * materials.length) | 0]);
      draws.push([o, m, gOrder, z, g]);
    }
  }
  if (frameNo % 9 === 0) for (let i = draws.length - 1; i > 0; i--) { const j = (r() * (i + 1)) | 0; [draws[i], draws[j]] = [draws[j], draws[i]]; }
  return draws;
}

installDepthBandSort(refR, { perOctave: 2 });
installDepthBandSort(newR, { perOctave: 2 });
const cam = new THREE.PerspectiveCamera(60, 1.6, 0.5, 2000);
cam.updateProjectionMatrix();

__setHotDrawSortForTest(false);
const refCmp = _makeReferenceSort(refR, phaseOf);
__setHotDrawSortForTest(true);
const newCmp = makeProgramSort(newR, phaseOf);
refR._opaqueSort = refCmp; newR._opaqueSort = newCmp;

const FRAMES = 160;
let firstDiff = null, items = 0, askedDiff = null, bandedFrames = 0;
for (let f = 0; f < FRAMES && !firstDiff; f++) {
  _terrainLastNow = (f % 5) >= 3;
  if (f % 7 === 0) bindAll(0.1);                                   // compiles / relinks
  if (f === 40) { scene.add(detached); }                           // late attach: phase cache fills
  if (f % 13 === 0) { const o = objects[(r() * objects.length) | 0]; o.renderOrder = o.renderOrder === 0 ? 1 : 0; }
  const draws = project(f);
  poolRef.n = 0; poolNew.n = 0;
  const la = [], lb = [];
  for (const [o, m, go, z, g] of draws) { la.push(nextItem(poolRef, o, m, go, z, g)); lb.push(nextItem(poolNew, o, m, go, z, g)); }
  const band = (f % 4) === 1;
  refR.__hbDepthBand.perOctave = band ? 2 : 0;
  newR.__hbDepthBand.perOctave = band ? 2 : 0;
  if (band) bandedFrames++;
  refR.renderLists._list.opaque = la;
  newR.renderLists._list.opaque = lb;
  refR.asked.clear(); newR.asked.clear();
  refR.render(scene, cam);
  newR.render(scene, cam);
  items += la.length;
  for (let i = 0; i < la.length; i++) {
    const a = la[i], b = lb[i];
    if (a.object !== b.object || a.material !== b.material || !Object.is(a.z, b.z) || a.group !== b.group) {
      firstDiff = `frame ${f} position ${i}: ref (obj ${a.object.id}, mat ${a.material.id}, z ${a.z}) vs new (obj ${b.object.id}, mat ${b.material.id}, z ${b.z})`;
      break;
    }
  }
  if (!askedDiff) {
    const aa = [...refR.asked].map((m) => m.id).sort((x, y) => x - y).join();
    const bb = [...newR.asked].map((m) => m.id).sort((x, y) => x - y).join();
    if (aa !== bb) askedDiff = `frame ${f}: ref asked ${refR.asked.size} materials, new ${newR.asked.size}`;
  }
}

check(`[1] ${FRAMES} frames, ${items} items: identical order element by element (ties included)`, () => assert(!firstDiff, firstDiff));
check("[2] renderer.properties is asked about the same materials every frame", () => assert(!askedDiff, askedDiff));
check(`[3] the depth-band key was exercised (${bandedFrames} banded frames)`, () => assert(bandedFrames > 0 && refR.renderLists._list.opaque.some((it) => it.__hbBand > 0), "no bands"));
check("[4] flag default ON since 2026-10-26 (no location) and makeProgramSort follows it", () => {
  __setHotDrawSortForTest(undefined);
  assert(hotDrawSortEnabled() === true, "default must be on");
  const fr = fakeRenderer("x");
  // The memo comparator reads `__dspS` (its stamp) and `__dspK` (the lazy
  // program key); the reference has neither (its material memo is __dspKey).
  const isMemo = (c) => /\b__dspS\b/.test(String(c)) && /\b__dspK\b/.test(String(c));
  assert(isMemo(makeProgramSort(fr, null)), "the default must build the memo comparator");
  __setHotDrawSortForTest(false);
  assert(!isMemo(makeProgramSort(fr, null)), "flag off must build the reference comparator");
  __setHotDrawSortForTest(true);
  assert(isMemo(makeProgramSort(fr, null)), "flag on must build the memo comparator");
  __setHotDrawSortForTest(undefined);
  const src = String(_makeReferenceSort) + String(makeProgramSort(fr, null));
  assert(!/__dspO|__dspM/.test(src), "the memo must not keep the item's object or material");
});

// A cross-renderer guard: one item list sorted by two renderers' comparators
// in turn (the token keeps their memos apart).
check("[5] two renderers' comparators never read each other's memo", () => {
  const r1 = fakeRenderer("r1"), r2 = fakeRenderer("r2");
  for (const m of materials) { r1.bind(m, programs[m.id % 80]); r2.bind(m, programs[(m.id * 7) % 80]); }
  __setHotDrawSortForTest(true);
  const c1 = makeProgramSort(r1, null), c2 = makeProgramSort(r2, null);
  const ref1 = _makeReferenceSort(r1, null), ref2 = _makeReferenceSort(r2, null);
  const pool = makePool();
  const list = project(1).map(([o, m, go, z, g]) => nextItem(pool, o, m, go, z, g));
  const x1 = list.slice().sort(c1), y1 = list.slice().sort(ref1);
  const x2 = list.slice().sort(c2), y2 = list.slice().sort(ref2);
  assert(x1.every((it, i) => it === y1[i]), "renderer 1 order");
  assert(x2.every((it, i) => it === y2[i]), "renderer 2 order");
  __setHotDrawSortForTest(undefined);
});

// ── three r184's real WebGLRenderer (fake WebGL2) ───────────────────────────
// [6] RETENTION. three's WebGLRenderList.finish() nulls object / geometry /
// material / group on the pooled items a shorter frame leaves unused, so what
// left the scene can be collected. The memo must not undo that: evict most of
// the scene (a teleport into a sealed dungeon, an LRU sweep), keep sorting a
// smaller list, collect, and count what is still reachable — flag on must keep
// no more than flag off. (The first cut kept item.object / item.material in the
// memo and pinned every evicted mesh until its slot was reused.)
// [7] THE ABORTED SORT. The stamp is one per (comparator, info.render.frame);
// r184 bumps the frame right after the sort, and a render() that throws before
// its end leaves its list on renderListStack for good (no try/finally), so the
// next render sorts a DEEPER list. Pin both premises and the outcome.
globalThis.window ??= {};
window.location ??= { search: "" };
window.requestAnimationFrame ??= () => 0;
const { createFakeWebGL2, fakeCanvas } = await import("./helpers/fake_webgl2.mjs");
const { installDrawSortProgram, setDrawSortPhase } = await import("../scene3d/draw_sort_program.js");
const { setFlagsFromString } = await import("node:v8");
const { runInNewContext } = await import("node:vm");
setFlagsFromString("--expose-gc");
const gc = globalThis.gc || runInNewContext("gc");
const settle = async () => { for (let k = 0; k < 4; k++) { gc(); await new Promise((r) => setTimeout(r, 10)); } };
function realRenderer(hot, phase) {
  __setHotDrawSortForTest(hot);
  const gl = createFakeWebGL2({ maxTextures: 16, maxCombined: 32 }).__fake.plain();
  const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
  installDrawSortProgram(renderer);
  if (phase) setDrawSortPhase(renderer, phase, null);
  return renderer;
}
async function retentionArm(hot) {
  const renderer = realRenderer(hot, (o) => o.__hbPunchPhase ?? (o.id % 3));
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 1000);
  const shared = [new THREE.MeshLambertMaterial(), new THREE.MeshStandardMaterial(), new THREE.MeshBasicMaterial()];
  const mk = (i, perLb) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3 * 300), 3));
    const m = new THREE.Mesh(g, perLb ? new THREE.MeshBasicMaterial({ color: i & 0xffffff }) : shared[i % 3]);
    m.frustumCulled = false;
    m.position.set((i % 30) - 15, ((i / 30) | 0) % 20 - 10, -20 - (i % 97) * 0.1);
    scene.add(m);
    return m;
  };
  let outdoor = [];
  for (let i = 0; i < 600; i++) outdoor.push(mk(i, i % 3 === 0));
  for (let f = 0; f < 3; f++) renderer.render(scene, cam);       // 600 items sorted, all stamped
  const meshRefs = [], matRefs = [];
  for (let i = 100; i < 600; i++) {                                // the purge: 500 leave, are disposed
    const m = outdoor[i];
    scene.remove(m);
    m.geometry.dispose();
    if (!shared.includes(m.material)) { m.material.dispose(); matRefs.push(new WeakRef(m.material)); }
    meshRefs.push(new WeakRef(m));
  }
  outdoor = outdoor.slice(0, 100);
  for (let i = 0; i < 60; i++) mk(10000 + i, i % 2 === 0);        // the dungeon: still sorting, a shorter list
  for (let f = 0; f < 5; f++) renderer.render(scene, cam);
  const sorted = renderer.renderLists.get(scene, 0).opaque.length;
  await settle();
  const r = { meshes: meshRefs.filter((w) => w.deref() !== undefined).length, mats: matRefs.filter((w) => w.deref() !== undefined).length,
    evicted: meshRefs.length, evictedMats: matRefs.length, sorted };
  renderer.dispose();
  __setHotDrawSortForTest(undefined);
  return r;
}
const retOff = await retentionArm(false);
await settle();
const retOn = await retentionArm(true);
check(`[6] evicted meshes / materials still reachable: flag off ${retOff.meshes}/${retOff.evicted}, ${retOff.mats}/${retOff.evictedMats}; flag on ${retOn.meshes}/${retOn.evicted}, ${retOn.mats}/${retOn.evictedMats}`, () => {
  assert(retOff.sorted > 100 && retOn.sorted === retOff.sorted, `the shrunk list kept sorting (${retOff.sorted} / ${retOn.sorted} items)`);
  assert(retOn.meshes <= retOff.meshes && retOn.mats <= retOff.mats, "the memo must not keep anything three released");
  assert(retOn.meshes < retOn.evicted / 10, "most evicted meshes must be collectable");
});

{
  const renderer = realRenderer(true, null);
  let throwOn = null;
  const phaseOf = (o) => { if (o === throwOn) { throwOn = null; throw new Error("phase boom"); } return o.__ph ?? 0; };
  setDrawSortPhase(renderer, phaseOf, null);
  const hot = renderer.__hbDrawSort.sort;
  let seen = new Set();
  renderer.setOpaqueSort((a, b) => { seen.add(a); seen.add(b); return hot(a, b); });
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 1000);
  const mats = [new THREE.MeshBasicMaterial(), new THREE.MeshLambertMaterial(), new THREE.MeshStandardMaterial(), new THREE.MeshPhongMaterial()];
  const geo = new THREE.BoxGeometry();
  const meshes = [];
  for (let i = 0; i < 60; i++) {
    const m = new THREE.Mesh(geo, mats[i % 4]);
    m.frustumCulled = false; m.position.z = -5 - (i % 7); m.__ph = i % 3;
    scene.add(m); meshes.push(m);
  }
  renderer.render(scene, cam);
  renderer.render(scene, cam);
  seen = new Set();
  throwOn = meshes[37];
  const f0 = renderer.info.render.frame;
  let threw = false;
  try { renderer.render(scene, cam); } catch (e) { threw = e.message === "phase boom"; }
  const aborted = seen;
  const frameAfterAbort = renderer.info.render.frame;
  for (let i = 0; i < meshes.length; i += 2) meshes[i].material = mats[(i + 1) % 4];   // re-point the scene
  scene.children.reverse();
  for (let i = 0; i < meshes.length; i += 3) meshes[i].__ph = (meshes[i].__ph + 1) % 3;
  seen = new Set();
  renderer.render(scene, cam);
  const overlap = [...seen].filter((it) => aborted.has(it)).length;
  const sortedByThree = renderer.renderLists.get(scene, 1).opaque.slice();
  const ref = _makeReferenceSort(renderer, phaseOf);
  const byRef = sortedByThree.slice().sort(ref);
  check(`[7] an aborted sort: threw, frame held (${f0} → ${frameAfterAbort}), the next sort used other items (overlap ${overlap} of ${seen.size}) and matched the reference`, () => {
    assert(threw && frameAfterAbort === f0, "the abort must leave info.render.frame where it was");
    assert(seen.size > 0 && overlap === 0, "the next render must sort a different (deeper) list");
    assert(sortedByThree.length === seen.size && sortedByThree.every((it, i) => it === byRef[i]), "three's order must equal the reference comparator's");
  });
  renderer.dispose();
  __setHotDrawSortForTest(undefined);
}

if (process.argv.includes("--bench")) {
  // Main-pass shape: ~1,550 items, phase on, sorted from traversal order.
  const br = fakeRenderer("bench");
  for (const m of materials) br.bind(m, programs[(m.id * 13) % 80]);
  const pool = makePool();
  const draws = project(2).slice(0, 1550);
  const list = draws.map(([o, m, go, z, g]) => nextItem(pool, o, m, go, z, g));
  const run = (cmp, label) => {
    const reps = 400;
    for (let i = 0; i < 50; i++) { list.slice().sort(cmp); br.info.render.frame++; }
    let t = 0;
    for (let i = 0; i < reps; i++) {
      const l = list.slice();
      const t0 = process.hrtime.bigint();
      l.sort(cmp);
      t += Number(process.hrtime.bigint() - t0);
      br.info.render.frame++;
    }
    console.log(`  bench ${label}: ${(t / reps / 1000).toFixed(1)} us per ${list.length}-item sort`);
  };
  __setHotDrawSortForTest(false);
  run(_makeReferenceSort(br, phaseOf), "shipped comparator");
  __setHotDrawSortForTest(true);
  run(makeProgramSort(br, phaseOf), "?hotDrawSort memo  ");
  __setHotDrawSortForTest(undefined);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
