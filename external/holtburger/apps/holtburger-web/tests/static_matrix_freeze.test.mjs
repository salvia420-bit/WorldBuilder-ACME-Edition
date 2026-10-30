// tests/static_matrix_freeze.test.mjs — ?staticMatrixFreeze (2026-10-26, stage-2
// S1a; docs/2026-10-26-rust-residency-design.md §4, lane notes
// docs/2026-10-26-rust-cull.md). Shaped like tests/freeze_world_roots.test.mjs.
//
// Static draw nodes are frozen right after attach (static_batch_x.js
// `freezeStaticNodeMatrices`: world matrices computed once through the parents,
// then matrixAutoUpdate / matrixWorldAutoUpdate false on the node and its LOD
// levels, a billboard leaf excepted). The claim is EXACTNESS: every visible
// world matrix equals what three's per-frame walk computes for the unfrozen
// world, bit for bit, on every frame, with:
//   - the real builders: statics.js buildSingletonNode (singletons, LODs, a
//     mode-2 and a mode-4 billboard LOD), the walk-in InstancedMesh (+ an
//     instanced LOD), consolidateStaticSingletons (per-LB batch),
//     consolidateStaticSingletonsCrossLb (chunk buckets, frozen inside the
//     batcher), buildings.js consolidateBuildingSurfaces (building batch +
//     loners);
//   - every frame: the billboard tick, LOD.update(camera), the scene walk with
//     ?skipHiddenMatrix installed, the camera crossing landblocks;
//   - mid-run: a late singleton bake, a light attached to a frozen singleton, a
//     wireframe-style fill companion, hides / shows (objRadius-like), a real
//     LandblockLRU park → unpark of a landblock (detach / re-add);
//   - both root modes (?freezeWorldRoots off and on).
// Plus: the flag reader, frozen flags where they belong (billboard leaves keep
// composing), fewer composes per walk, and the attach sites in the shipped code.
//
// Run from apps/holtburger-web/:  node tests/static_matrix_freeze.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.requestAnimationFrame ??= () => 0;
globalThis.window.cancelAnimationFrame ??= () => {};

const THREE = await import("three");
const S = await import("../scene3d/statics.js");
const SBX = await import("../scene3d/static_batch_x.js");
const B = await import("../scene3d/buildings.js");
const F = await import("../scene3d/freeze_world_roots.js");
const { LandblockLRU } = await import("../scene3d/landblock_lru.js");
const { installSkipHiddenMatrix } = await import("../scene3d/skip_hidden_matrix.js");

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

installSkipHiddenMatrix(THREE, { force: true }); // the app runs the walk with it (default on)
SBX.__setStatBatchChunkForTest(true);

const LB1 = 0xa21e0000 >>> 0;
const LB2 = 0xa31e0000 >>> 0;
const M = 192;

function triGeom(scale = 1, offset = [0, 0, 0]) {
  const g = new THREE.BufferGeometry();
  const p = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 1, 1, 1].map((v, i) => v * scale + offset[i % 3]);
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(p), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(15), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(10), 2));
  g.setIndex([0, 1, 2, 0, 2, 3, 1, 3, 4]);
  g.computeBoundingSphere();
  return g;
}
function bandGeom(mode, dist) {
  const g = triGeom(0.5);
  g.userData = { degradeMode: mode, lodDist: dist };
  return g;
}
function placement(lb, i, opts = {}) {
  const p = { landblockId: (lb | (1 + i)) >>> 0, x: 12.5 + i * 17.25, y: 30.75 + (i % 5) * 21.5, z: 4.125 + i * 0.3,
    rotationZ: i * 0.61, scale: i % 3 === 1 ? 1.4 : 1, source: i % 2 ? "scenery" : "landblockinfo", ...opts };
  if (i % 4 === 3) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.07 * i, -0.04 * i, 0.5 * i)).normalize();
    p.qw = q.w; p.qx = q.x; p.qy = q.y; p.qz = q.z;
  }
  return p;
}

// One world: the same construction and per-frame mutations for both arms.
function buildWorld(freeze, frozenRoots) {
  SBX.__setStaticMatrixFreezeForTest(freeze);
  SBX.__resetStatBatchXForTest();
  SBX.__resetStaticMatrixFreezeForTest();
  F.__unpatchAddForTest(THREE);
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group(); worldRoot.name = "worldRoot"; worldRoot.rotation.x = -Math.PI / 2; scene.add(worldRoot);
  const staticsGroup = new THREE.Group(); staticsGroup.name = "statics";
  const buildingsGroup = new THREE.Group(); buildingsGroup.name = "buildings";
  worldRoot.add(staticsGroup, buildingsGroup);
  if (frozenRoots) F.freezeWorldRoots(THREE, [scene, worldRoot, staticsGroup, buildingsGroup], { force: true });
  const camera = new THREE.PerspectiveCamera(55, 1.6, 0.5, 4000);
  scene.add(camera);
  const s3 = { scene, worldRoot, staticsGroup, buildingsGroup, camera, staticsBakedLbs: new Set([LB1, LB2]),
    buildingsBakedLbs: new Set([LB1, LB2]), envCellLoadedLbs: new Set(), activeLights: [], terrainMaterials: [] };
  const mats = [new THREE.MeshStandardMaterial({ color: 0x808080 }), new THREE.MeshStandardMaterial({ color: 0x408040 })];
  const attach = (n) => { staticsGroup.add(n); SBX.freezeStaticNodeMatrices(n); }; // statics.js `_attachStaticNode`
  const attachBuilding = (n) => { buildingsGroup.add(n); SBX.freezeStaticNodeMatrices(n); }; // buildings.js `_attachFlatBuildingNode`
  const build = (lb, i, levels) => S.__lodTestSeams.buildSingletonNode({
    placement: placement(lb, i), modelId: 0x01000100 + i, surfaceDid: 0x08000100 + (i % 2), geom: triGeom(1 + (i % 3) * 0.5),
    degradedLevels: levels, mat: mats[i % 2], staticsShadow: false,
  }).node;
  // (a) plain singletons, (b) LODs (2 and 3 bands), (c) billboard LODs: mode 2 and mode 4
  for (let i = 0; i < 6; i++) attach(build(LB1, i, null));
  attach(build(LB1, 6, [{ geometry: triGeom(0.5), dist: 60, degradeMode: 1 }]));
  attach(build(LB1, 7, [{ geometry: triGeom(0.5), dist: 40, degradeMode: 1 }, { geometry: triGeom(0.25), dist: 120, degradeMode: 1 }]));
  const bb2 = build(LB1, 8, [{ geometry: bandGeom(2, 30), dist: 30, degradeMode: 2 }]);
  const bb4 = build(LB2, 9, [{ geometry: bandGeom(4, 25), dist: 25, degradeMode: 4 }]);
  attach(bb2);
  attach(bb4);
  // (d) a walk-in InstancedMesh and an instanced LOD
  const inst = new THREE.InstancedMesh(triGeom(1), mats[0], 3);
  for (let k = 0; k < 3; k++) inst.setMatrixAt(k, new THREE.Matrix4().makeTranslation(0xa3 * M + 20 + k * 9, 0x1e * M + 40, 2));
  inst.computeBoundingSphere();
  inst.userData = { landblockId: LB2 };
  attach(inst);
  const ilod = new THREE.LOD();
  const i0 = new THREE.InstancedMesh(triGeom(1), mats[1], 2), i1 = new THREE.InstancedMesh(triGeom(0.5), mats[1], 2);
  for (const im of [i0, i1]) { im.setMatrixAt(0, new THREE.Matrix4().makeTranslation(31120, 5770, 3)); im.setMatrixAt(1, new THREE.Matrix4().makeTranslation(31150, 5790, 3)); im.computeBoundingSphere(); }
  ilod.addLevel(i0, 0); ilod.addLevel(i1, 70);
  ilod.userData = { isInstancedLod: true, landblockId: LB2 };
  attach(ilod);
  // (e) a per-LB batch (statics.js consolidateStaticSingletons) and (f) chunk
  // buckets (the cross-LB batcher adds + freezes them itself)
  const pl = [];
  for (let i = 10; i < 14; i++) { const n = build(LB2, i, null); n.material = mats[0]; pl.push(n); }
  for (const n of S.consolidateStaticSingletons(pl)) attach(n);
  const ch = [];
  for (let i = 14; i < 20; i++) { const n = build(LB1, i, null); n.material = mats[i % 2]; ch.push(n); }
  const cres = SBX.consolidateStaticSingletonsCrossLb(ch, s3, LB1);
  for (const n of cres ? cres.out : ch) attach(n);
  // (g) buildings: flattened loners + a per-(LB, material) batch
  const bmat = new THREE.MeshStandardMaterial({ color: 0x777777 });
  const bnodes = [];
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(triGeom(2), i < 3 ? bmat : new THREE.MeshStandardMaterial());
    m.position.set(31104 + 10 + i * 25, 5760 + 15 + i * 7, 1.5);
    m.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.3 * i);
    m.userData = { landblockId: (LB1 | 0xfffe) >>> 0, surfaceDid: 0x08000300 };
    bnodes.push(m);
  }
  for (const n of B.consolidateBuildingSurfaces(bnodes).out) attachBuilding(n);

  const byName = (name) => { let r = null; scene.traverse((o) => { if (!r && o.name === name) r = o; }); return r; };
  const W = { scene, worldRoot, staticsGroup, buildingsGroup, camera, s3, bb2, bb4, inst, ilod, cres };
  const lru = new LandblockLRU({ scene3d: s3, maxResident: 50 });
  lru.track(LB1); lru.track(LB2);
  let late = null, light = null, fill = null, hiddenAtAttach = null, parkedFirst = null, pendingAt7 = -1;
  function step(f) {
    // The camera walks east across LB1 → LB2 (a landblock crossing at ~f 9) at
    // shifting heights: LOD bands and billboard facings change every frame.
    const x = 31104 + 20 + f * 22, y = 5760 + 60 + Math.sin(f * 0.4) * 30;
    camera.position.set(x, 6 + f * 0.8, -y);
    camera.lookAt(x + 40, 2, -(y + 30 * Math.cos(f * 0.3)));
    camera.updateMatrixWorld(true);
    if (f === 2) { late = build(LB1, 30, null); attach(late); } // a late per-LB bake
    if (f === 3) { light = new THREE.PointLight(0xffffff, 1, 10); light.position.set(0, 0, 3); staticsGroup.children[1].add(light); } // lighting.js
    if (f === 4) {
      // materials.js addFillCompanions: a sibling copying the source pose
      const src = staticsGroup.children[2];
      fill = new THREE.Mesh(src.geometry, new THREE.MeshBasicMaterial());
      fill.position.copy(src.position); fill.quaternion.copy(src.quaternion); fill.scale.copy(src.scale);
      fill.matrixAutoUpdate = src.matrixAutoUpdate;
      if (!src.matrixAutoUpdate) { fill.matrix.copy(src.matrix); fill.matrixWorldNeedsUpdate = true; }
      fill.userData = { __wireFillSource: true, landblockId: src.userData.landblockId };
      staticsGroup.add(fill);
    }
    if (f === 5) { staticsGroup.children[0].visible = false; bb2.visible = false; } // objRadius-like hides
    if (f === 7) { staticsGroup.children[0].visible = true; bb2.visible = true; }
    if (f === 6) { hiddenAtAttach = build(LB1, 31, null); hiddenAtAttach.visible = false; attach(hiddenAtAttach); } // objRadius late hide
    if (f === 9) hiddenAtAttach.visible = true;
    if (f === 8) {
      parkedFirst = build(LB2, 32, [{ geometry: triGeom(0.5), dist: 50, degradeMode: 1 }]); // baked …
      attach(parkedFirst);
      lru.park(LB2); // … and parked before its first walk; detaches LB2's nodes (walk-in instance, LODs, batch, ...)
    }
    if (f === 10) lru.unpark(LB2);
    if (f === 7) pendingAt7 = SBX.staticMatrixFreezeStats().pending;
    // per frame, in the app's order: the cull pass (statics.js cullStaticsGroup
    // runs the freeze tick first), then the billboard rAF (it reads LOD
    // matrixWorld BEFORE this frame's walk — the hazard a freeze at attach hits)
    SBX.tickStaticMatrixFreeze();
    S.tickStaticsBillboards(s3);
  }
  // after the walk: what the renderer's projectObject does with every LOD
  function afterWalk() { staticsGroup.traverse((o) => { if (o.isLOD) o.update(camera); }); }
  return { W, step, afterWalk, byName, get late() { return late; }, get light() { return light; }, get fill() { return fill; },
    get hiddenAtAttach() { return hiddenAtAttach; }, get parkedFirst() { return parkedFirst; }, get pendingAt7() { return pendingAt7; } };
}

function visibleMatrices(scene) {
  const out = [];
  const names = [];
  scene.traverse((o) => {
    for (let p = o; p; p = p.parent) if (p.visible === false) return; // stale by design (skip_hidden_matrix), both arms
    out.push(...o.matrixWorld.elements);
    names.push(o.name || o.type);
  });
  return { out, names };
}

// `walks` renderer.render calls a frame: 2 = the indoor split (the world pass
// and the cells pass each walk the scene; index.js / atmosphere_pipeline.js
// cellsRenderPass), where the second walk re-marks the bands the first pass's
// LOD.update hid.
function runArm(freeze, frozenRoots, frames, walks = 1) {
  const w = buildWorld(freeze, frozenRoots);
  if (frozenRoots) F.freezeWorldRoots(THREE, [], { force: true }); // (re-)arm the add patch for this arm
  else F.__unpatchAddForTest(THREE);
  const perFrame = [];
  for (let f = 0; f < frames; f++) {
    w.step(f);
    for (let k = 0; k < walks; k++) {
      w.W.scene.updateMatrixWorld(); // renderer.render's walk
      w.afterWalk();
    }
    perFrame.push(visibleMatrices(w.W.scene));
  }
  return { w, perFrame };
}

function compareArms(frozenRoots, walks = 1) {
  const A = runArm(false, frozenRoots, 14, walks);
  const Bz = runArm(true, frozenRoots, 14, walks);
  let bad = "";
  let nodes = 0;
  for (let f = 0; f < A.perFrame.length; f++) {
    const a = A.perFrame[f], b = Bz.perFrame[f];
    if (a.out.length !== b.out.length) { bad ||= `frame ${f}: ${a.out.length / 16} vs ${b.out.length / 16} visible nodes`; continue; }
    nodes += a.out.length / 16;
    for (let i = 0; i < a.out.length; i++) {
      if (!Object.is(a.out[i], b.out[i])) { bad ||= `frame ${f} ${a.names[Math.floor(i / 16)]} elem ${i % 16}: ${a.out[i]} vs ${b.out[i]}`; break; }
    }
  }
  return { A, B: Bz, bad, nodes };
}

console.log("-- Z1 flag reader (default ON since 2026-10-26) -------------------------");
{
  const saved = globalThis.location;
  try {
    const read = (search) => { globalThis.location = { search }; SBX.__setStaticMatrixFreezeForTest(undefined); return SBX.staticMatrixFreezeEnabled(); };
    check("absent → on", read("") === true);
    check("on / 1 / true / yes / garbage → on", ["on", "1", "true", "YES", "maybe"].every((v) => read(`?staticMatrixFreeze=${v}`) === true));
    check("off / 0 / false / no → off", ["off", "0", "false", "NO"].every((v) => read(`?staticMatrixFreeze=${v}`) === false));
  } finally {
    globalThis.location = saved;
    SBX.__setStaticMatrixFreezeForTest(undefined);
  }
  SBX.__setStaticMatrixFreezeForTest(false);
  const g = new THREE.Mesh(triGeom());
  check("flag off: the helper freezes nothing", SBX.freezeStaticNodeMatrices(g) === false && g.matrixAutoUpdate === true);
  SBX.__setStaticMatrixFreezeForTest(undefined);
}

for (const [frozenRoots, walks] of [[false, 1], [true, 1], [false, 2]]) {
  console.log(`-- Z2 exactness (freezeWorldRoots ${frozenRoots ? "on" : "off"}, ${walks} walk${walks > 1 ? "s" : ""} a frame): frozen statics == three's walk, every frame --`);
  const { A, B: Bz, bad, nodes } = compareArms(frozenRoots, walks);
  check(`every visible world matrix bit-identical over 14 frames (${nodes} node-frames)`, bad === "", bad);
  const W = Bz.w.W;
  check("the billboard LODs' leaves faced the camera (setup: the tick ran)",
    !W.bb2.levels[1].object.quaternion.equals(new THREE.Quaternion()) && !W.bb4.levels[1].object.quaternion.equals(new THREE.Quaternion()));
  const isFrozen = (o) => o.matrixAutoUpdate === false && o.matrixWorldAutoUpdate === false;
  check("frozen after their first walk: singletons, LOD wrappers, the instances, batches, buckets, building nodes",
    [W.staticsGroup.children[0], W.ilod, W.bb2, W.bb4, W.inst, Bz.w.late,
      ...W.staticsGroup.children.filter((c) => c.isBatchedMesh), ...W.buildingsGroup.children].every(isFrozen));
  const levels = [W.ilod, W.bb2, W.bb4, ...W.staticsGroup.children.filter((c) => c.isLOD)].flatMap((l) => l.levels.map((v) => v.object));
  check("LOD levels freeze once shown (some did; a band never shown stays live)", levels.some(isFrozen));
  const st = SBX.staticMatrixFreezeStats();
  check(`the queue drained what the walk computed (${JSON.stringify(st)})`, st.frozen > 20 && st.queued >= st.frozen);
  check("a node hidden at attach waited in the queue while hidden, froze once shown and walked",
    Bz.w.pendingAt7 >= 1 && isFrozen(Bz.w.hiddenAtAttach));
  check("an LOD parked before its first walk left the queue (with its levels) and stays live after unpark",
    st.droppedDetached >= 2 && Bz.w.parkedFirst.parent === W.staticsGroup &&
    [Bz.w.parkedFirst, ...Bz.w.parkedFirst.levels.map((l) => l.object)].every((o) => o.matrixAutoUpdate === true && o.matrixWorldAutoUpdate === true));
  check("billboard leaves keep composing (the tick writes them every frame)",
    [W.bb2.levels[1].object, W.bb4.levels[1].object].every((o) => o.matrixAutoUpdate === true && o.matrixWorldAutoUpdate === true));
  check("the late light and the fill companion keep auto-updating",
    Bz.w.light.matrixAutoUpdate === true && Bz.w.light.matrixWorldAutoUpdate === true && Bz.w.fill.matrixWorldAutoUpdate === true);
  check("flag off world: nothing frozen", [...A.w.W.staticsGroup.children, ...A.w.W.buildingsGroup.children].every((o) => o.userData?.__matrixFrozen !== true && o.matrixWorldAutoUpdate === true));
  check("chunk buckets exist and were queued by the batcher itself", !!W.cres && W.staticsGroup.children.some((c) => c.isBatchedMesh && c.userData.__staticBatchCrossLb === true && c.userData.__matrixFrozen === true && isFrozen(c)));
  check("a building batch and building loners are frozen", W.buildingsGroup.children.some((c) => c.isBatchedMesh) && W.buildingsGroup.children.some((c) => !c.isBatchedMesh) && W.buildingsGroup.children.every(isFrozen));
}

console.log("-- Z3 the walk does less: composes per walk drop ----------------------");
{
  const count = (freeze) => {
    const r = runArm(freeze, false, 6);
    const proto = THREE.Matrix4.prototype;
    const orig = proto.compose;
    let n = 0;
    proto.compose = function (...a) { n++; return orig.apply(this, a); };
    try { r.w.W.scene.updateMatrixWorld(); } finally { proto.compose = orig; }
    return n;
  };
  const a = count(false), b = count(true);
  check(`a walk composes fewer matrices (unfrozen ${a}, frozen ${b})`, b < a && b > 0);
}

console.log("-- Z4 the shipped attach sites call the helper ------------------------");
{
  const st = readFileSync(path.join(APP, "scene3d/statics.js"), "utf8");
  const bx = readFileSync(path.join(APP, "scene3d/static_batch_x.js"), "utf8");
  const at = readFileSync(path.join(APP, "scene3d/static_atlas.js"), "utf8");
  const bl = readFileSync(path.join(APP, "scene3d/buildings.js"), "utf8");
  check("statics.js: the per-LB attach goes through _attachStaticNode", /for \(const node of nodesToAdd\) _attachStaticNode\(scene3d, node\);/.test(st));
  check("statics.js: _attachStaticNode = add, then freezeStaticNodeMatrices", /function _attachStaticNode\(scene3d, node\) \{\s*scene3d\.staticsGroup\.add\(node\);\s*if \(node && node\.parent && typeof freezeStaticNodeMatrices === "function"\) freezeStaticNodeMatrices\(node\);/.test(st));
  check("static_batch_x.js: a chunk bucket is frozen after its add", /scene3d\?\.staticsGroup\?\.add\(bm\);[^\n]*\n[^\n]*\n\s*if \(bm\.parent\) freezeStaticNodeMatrices\(bm\);/.test(bx));
  check("static_atlas.js: an atlas bucket is frozen after its add", /scene3d\?\.staticsGroup\?\.add\(bm\);[^\n]*\n\s*if \(bm\.parent && typeof freezeStaticNodeMatrices === "function"\) freezeStaticNodeMatrices\(bm\);/.test(at));
  check("buildings.js: both flattened-node attach sites go through _attachFlatBuildingNode",
    /else _attachFlatBuildingNode\(scene3d, n\);/.test(bl) && /for \(const n of top\) _attachFlatBuildingNode\(scene3d, n\);/.test(bl));
  check("buildings.js: the legacy whole-placement groups are NOT frozen", /for \(const g of _pendingGroups\) scene3d\.buildingsGroup\.add\(g\);/.test(bl));
}

console.log("-- Z5 the queue lets go of what no walk reaches (two walks a frame) ---");
{
  // Review 2026-10-26: with two walks a frame an LOD's inactive bands are hidden
  // by the first pass's LOD.update and re-marked by the second walk
  // (skip_hidden_matrix.js), so they wait in the queue after their wrapper has
  // frozen. Park / evict detach (evict also disposes) the frozen wrapper but
  // leave each level's parent pointing at it. The tick has to drop such a level
  // because it is no longer under the scene. Before the fix it was re-checked
  // forever, so every evicted LOD grew the queue and pinned its geometry.
  SBX.__setStaticMatrixFreezeForTest(true);
  SBX.__resetStatBatchXForTest();
  SBX.__resetStaticMatrixFreezeForTest();
  F.__unpatchAddForTest(THREE);
  const LB3 = 0xa41e0000 >>> 0;
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group(); worldRoot.rotation.x = -Math.PI / 2; scene.add(worldRoot);
  const staticsGroup = new THREE.Group(); staticsGroup.name = "statics";
  worldRoot.add(staticsGroup);
  const camera = new THREE.PerspectiveCamera(55, 1.6, 0.5, 4000);
  scene.add(camera);
  const s3 = { scene, worldRoot, staticsGroup, camera, staticsBakedLbs: new Set([LB1, LB2, LB3]), envCellLoadedLbs: new Set(),
    activeLights: [], terrainMaterials: [] };
  const lru = new LandblockLRU({ scene3d: s3, maxResident: 50 });
  const mat = new THREE.MeshStandardMaterial();
  const K = 8;
  const bake = (lb) => {
    s3.staticsBakedLbs.add(lb);
    lru.track(lb);
    const lods = [];
    for (let i = 0; i < K; i++) {
      const n = S.__lodTestSeams.buildSingletonNode({ placement: placement(lb, i), modelId: 0x01000200 + i, surfaceDid: 0x08000100,
        geom: triGeom(1), degradedLevels: [{ geometry: triGeom(0.5), dist: 60, degradeMode: 1 }, { geometry: triGeom(0.25), dist: 150, degradeMode: 1 }],
        mat, staticsShadow: false }).node;
      staticsGroup.add(n); SBX.freezeStaticNodeMatrices(n); // statics.js `_attachStaticNode`
      lods.push(n);
    }
    return lods;
  };
  const look = (x, h, y) => { camera.position.set(x, h, -y); camera.lookAt(x + 40, 0, -(y + 20)); camera.updateMatrixWorld(true); };
  const frame = () => {
    SBX.tickStaticMatrixFreeze(); // statics.js cullStaticsGroup, before the render
    for (let k = 0; k < 2; k++) { scene.updateMatrixWorld(); staticsGroup.traverseVisible((o) => { if (o.isLOD) o.update(camera); }); }
  };
  const isFrozen = (o) => o.matrixAutoUpdate === false && o.matrixWorldAutoUpdate === false;
  const isLive = (o) => o.matrixAutoUpdate === true && o.matrixWorldAutoUpdate === true;
  const levelsOf = (lods) => lods.flatMap((l) => l.levels.map((v) => v.object));
  const stats = () => SBX.staticMatrixFreezeStats();

  look(31104 - 500, 60, 5760 + 80); // ~500 units west: band 2 is the active level everywhere
  const A = bake(LB1), Bk = bake(LB2), C = bake(LB3);
  for (let f = 0; f < 4; f++) frame();
  const all = [...A, ...Bk, ...C];
  let st = stats();
  check(`setup: the wrappers and the shown band froze; the two hidden bands of every LOD wait in the queue (${st.pending})`,
    all.every(isFrozen) && all.every((l) => isFrozen(l.levels[2].object) && !isFrozen(l.levels[0].object) && !isFrozen(l.levels[1].object)) &&
    st.pending === 2 * all.length && st.droppedDetached === 0);

  look(31104 + 20, 8, 5760 + 70); // over LB1's west edge: its LODs switch to a nearer band, LB2's (> 150 away) do not
  for (let f = 0; f < 3; f++) frame();
  const before = st.pending;
  st = stats();
  check(`a hidden band that is still attached stays queued and freezes once shown (pending ${before} → ${st.pending})`,
    st.pending < before && st.droppedDetached === 0 &&
    A.every((l) => l.levels.every((v) => !v.object.visible || isFrozen(v.object))));

  // (a) LRU evict of a landblock whose frozen LODs still have queued bands.
  const queuedA = levelsOf(A).filter((o) => !isFrozen(o)).length;
  lru.evict(LB1);
  check(`evict detached the frozen wrappers; their ${queuedA} queued bands still point at them (the case \`!parent\` missed)`,
    queuedA > 0 && A.every((l) => l.parent === null) && levelsOf(A).every((o, i) => o.parent === A[Math.floor(i / 3)]));
  frame();
  st = stats();
  check(`after the evict the tick dropped them (pending ${st.pending}, droppedDetached ${st.droppedDetached})`,
    st.pending === 4 * K && st.droppedDetached === queuedA && levelsOf(A).filter((o) => !isFrozen(o)).every(isLive));
  // (b) park then disposeParked in the same frame (no tick in between), and
  // (c) park, a few frames parked, then disposeParked.
  lru.park(LB2);
  lru.disposeParked(LB2);
  lru.park(LB3);
  for (let f = 0; f < 3; f++) frame();
  st = stats();
  check(`park → disposeParked and a parked landblock both leave the queue (pending ${st.pending})`, st.pending === 0);
  lru.disposeParked(LB3);
  for (let f = 0; f < 30; f++) frame();
  st = stats();
  check(`pending stays 0 after disposeParked and 30 more frames (${JSON.stringify(st)})`,
    st.pending === 0 && st.droppedDetached === queuedA + 4 * K && SBX.tickStaticMatrixFreeze() === 0);

  // The same churn repeated (a long tour): the queue never grows.
  const sizes = [];
  for (let k = 0; k < 4; k++) {
    look(31104 - 500, 60, 5760 + 80);
    bake(LB1);
    for (let f = 0; f < 4; f++) frame();
    sizes.push(stats().pending); // the hidden bands, waiting while resident
    lru.evict(LB1);
    for (let f = 0; f < 2; f++) frame();
    sizes.push(stats().pending);
  }
  check(`bake → evict churn leaves nothing queued (resident → evicted: ${sizes.join(", ")})`,
    sizes.every((n, i) => n === (i % 2 === 0 ? 2 * K : 0)));
}

F.__unpatchAddForTest(THREE);
SBX.__setStaticMatrixFreezeForTest(undefined);
console.log(`\n[static_matrix_freeze] ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
