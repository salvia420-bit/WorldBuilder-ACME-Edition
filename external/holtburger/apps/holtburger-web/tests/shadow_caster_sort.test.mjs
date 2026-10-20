// tests/shadow_caster_sort.test.mjs
//
// 2026-10-20 (improvement hunt shadows-restore-6) — `?shadowCasterSort`
// (scene3d/shadow_caster_list.js, DEFAULT ON, `=off` escape): the caster list
// handed to three's shadow pass is stable-sorted by depth-program kind, so the
// shared depth materials stop re-resolving their program on every
// batched / instanced / plain (and shared-alphaTest) transition.
//
// Drives three r184's REAL WebGLShadowMap (extracted from three.module.js, as
// in test_shadow_caster_list.mjs) on a stub renderer whose renderBufferDirect
// replays WebGLRenderer.setProgram's needsProgramChange chain per material
// (written out here from three's source, independently of the module's
// counter) and updates the material's properties the way getProgram does.
//
//   K1  depthProgramKind bits (batched / colour, instanced / colour / morph,
//       skinned, morph targets, shared alphaTest; per-material variants and
//       custom depth materials never set the alphaTest bit)
//   K2  bug trigger: walk order (sort seam off) re-resolves the shared depth
//       materials on most draws of an interleaved scene; sorted, at most one
//       re-resolve per (material, kind) per light
//   K3  pixel-identical: per light the SAME multiset of draws (object, depth
//       material, group) and the same frustum-test count as three's own walk;
//       within a kind the walk order is kept (stable)
//   K4  the opt-in counter (`programStats`) equals the stub's replay of three,
//       sorted and unsorted; off = no wrapper, nothing counted
//   K5  run stats: lastRunsBefore (walk order) > lastRunsAfter = lastKinds;
//       a single-kind list is never reordered
//   K6  VSM rasters keep walk order
//   K7  the ?shadowStaticCache path (managed lights): NORMAL and REFRESH lists
//       sorted too, same draws as three's walk
//   K8  flag reader (absent ⇒ on; off/0/false/no ⇒ off); ?shadowProgramStats
//       exact opt-in
//
// Run:  cd apps/holtburger-web && node tests/shadow_caster_sort.test.mjs

import * as THREE from "three";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

globalThis.window = globalThis.window || {};
globalThis.location = { search: "" };
window.location = globalThis.location;

const SCL = await import("../scene3d/shadow_caster_list.js");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass += 1; console.log(`  [OK] ${name}`); }
  else { fail += 1; console.error(`  [FAIL] ${name}${extra ? ` — ${extra}` : ""}`); }
}

// --- three's own WebGLShadowMap ---------------------------------------------------
const require = createRequire(import.meta.url);
const threeDir = require.resolve("three").replace(/[^/\\]+$/, "");
const src = readFileSync(threeDir + "three.module.js", "utf8");
const a = src.indexOf("const vertex = \"void main()");
const b = src.indexOf("function WebGLState(");
if (a < 0 || b < 0 || !src.slice(a, b).includes("function WebGLShadowMap(")) {
  console.log("shadow_caster_sort: three.module.js layout changed — re-anchor the extraction.");
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const WebGLShadowMap = new Function("THREE", "with (THREE) {\n" + src.slice(a, b) + "\nreturn WebGLShadowMap; }")(THREE);

// three r184 WebGLRenderer.setProgram's needsProgramChange terms a depth
// material in a shadow pass can trip (lights / colour space / env / fog /
// clipping / tone mapping / probe grid are constant there).
function threeNeedsProgramChange(mp, material, object, geometry) {
  if (material.version !== mp.__version) return true;
  if (object.isBatchedMesh && mp.batching === false) return true;
  if (!object.isBatchedMesh && mp.batching === true) return true;
  if (object.isBatchedMesh && mp.batchingColor === true && object.colorTexture === null) return true;
  if (object.isBatchedMesh && mp.batchingColor === false && object.colorTexture !== null) return true;
  if (object.isInstancedMesh && mp.instancing === false) return true;
  if (!object.isInstancedMesh && mp.instancing === true) return true;
  if (object.isSkinnedMesh && mp.skinning === false) return true;
  if (!object.isSkinnedMesh && mp.skinning === true) return true;
  if (object.isInstancedMesh && mp.instancingColor === true && object.instanceColor === null) return true;
  if (object.isInstancedMesh && mp.instancingColor === false && object.instanceColor !== null) return true;
  if (object.isInstancedMesh && mp.instancingMorph === true && object.morphTexture === null) return true;
  if (object.isInstancedMesh && mp.instancingMorph === false && object.morphTexture !== null) return true;
  const ma = geometry.morphAttributes;
  if (mp.morphTargets !== !!ma.position) return true;
  if (mp.morphNormals !== !!ma.normal) return true;
  if (mp.morphColors !== !!ma.color) return true;
  const attr = ma.position || ma.normal || ma.color;
  if (mp.morphTargetsCount !== (attr !== undefined ? attr.length : 0)) return true;
  return false;
}
// getProgram → updateCommonMaterialProperties: what the material now holds.
function threeResolve(mp, material, object, geometry) {
  mp.__version = material.version;
  mp.currentProgram = {};
  mp.batching = object.isBatchedMesh === true;
  mp.batchingColor = object.isBatchedMesh === true && object.colorTexture !== null;
  mp.instancing = object.isInstancedMesh === true;
  mp.instancingColor = object.isInstancedMesh === true && object.instanceColor !== null;
  mp.instancingMorph = object.isInstancedMesh === true && object.morphTexture !== null;
  mp.skinning = object.isSkinnedMesh === true;
  const ma = geometry.morphAttributes;
  mp.morphTargets = !!ma.position;
  mp.morphNormals = !!ma.normal;
  mp.morphColors = !!ma.color;
  const attr = ma.position || ma.normal || ma.color;
  mp.morphTargetsCount = attr !== undefined ? attr.length : 0;
}

// --- stub renderer --------------------------------------------------------------------
let log = [];
let replayFlips = 0;
const camLight = new Map();
const propMap = new WeakMap();
const properties = { get(m) { let r = propMap.get(m); if (!r) { r = {}; propMap.set(m, r); } return r; } };
const glStub = { NO_ERROR: 0, getError: () => 0 };
const stubRenderer = {
  properties,
  getRenderTarget: () => null,
  getActiveCubeFace: () => 0,
  getActiveMipmapLevel: () => 0,
  setRenderTarget() {},
  clear() {},
  initRenderTarget() {},
  copyTextureToTexture() {},
  getContext: () => glStub,
  domElement: { addEventListener() {} },
  state: {
    setBlending() {}, setScissorTest() {}, viewport() {},
    buffers: { depth: { getReversed: () => false, setTest() {}, setMask() {} }, color: { setClear() {} } },
  },
  renderBufferDirect(camera, scene, geometry, material, object, group) {
    const li = camLight.has(camera) ? camLight.get(camera) : "post";
    const mp = properties.get(material);
    if (threeNeedsProgramChange(mp, material, object, geometry)) {
      replayFlips += 1;
      threeResolve(mp, material, object, geometry);
    }
    log.push({ li, name: object.name, mat: material.uuid, group: group ? group.materialIndex : -1, kind: SCL.depthProgramKind(object) });
  },
};
const sm = new WebGLShadowMap(stubRenderer, { update: (o) => o.geometry }, { maxTextureSize: 16384 });
sm.enabled = true;
sm.type = THREE.PCFShadowMap;
stubRenderer.shadowMap = sm;

let frustumTests = 0;
const _ios = THREE.Frustum.prototype.intersectsObject;
THREE.Frustum.prototype.intersectsObject = function (o) { frustumTests++; return _ios.call(this, o); };

// --- scene: per-"landblock" groups interleaving every caster kind ----------------------
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const box = new THREE.BoxGeometry(1, 1, 1);
const tex = new THREE.DataTexture(new Uint8Array(4), 1, 1);
const matPlain = new THREE.MeshStandardMaterial();
const matAlphaNoMap = new THREE.MeshStandardMaterial({ alphaTest: 0.5 });      // shared depth material, alphaTest > 0
const matClip = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5 });  // three's per-material variant
const swayDepth = new THREE.MeshDepthMaterial();                               // a custom depth material (sway_shadow.js)
let nid = 0;
function place(o) {
  o.position.set((rnd() - 0.5) * 200, rnd() * 5, (rnd() - 0.5) * 200);
  o.castShadow = true;
  o.name = `${o.name || "o"}${nid++}`;
  return o;
}
const fakeBatched = (mat = matPlain) => { const m = new THREE.Mesh(box, mat); m.name = "batch"; m.isBatchedMesh = true; m.colorTexture = null; m._colorsTexture = null; return place(m); };
const plain = (mat = matPlain) => { const m = new THREE.Mesh(box, mat); m.name = mat === matAlphaNoMap ? "alpha" : mat === matClip ? "clip" : "plain"; return place(m); };
const inst = () => { const m = new THREE.InstancedMesh(box, matPlain, 3); m.name = "inst"; for (let i = 0; i < 3; i++) m.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i, 0, 0)); m.computeBoundingSphere(); return place(m); };
const sway = (batched) => { const m = batched ? fakeBatched() : plain(); m.name = batched ? "swaybatch" : "sway"; m.customDepthMaterial = swayDepth; return m; };

function buildScene() {
  const scene = new THREE.Scene();
  for (let lb = 0; lb < 30; lb++) {
    const g = new THREE.Group();
    g.name = `lb${lb}`;
    scene.add(g);
    g.add(fakeBatched(), plain(), inst(), sway(true), plain(), sway(false), fakeBatched(), plain(matAlphaNoMap), plain(matClip), inst());
    if (lb % 7 === 3) { const h = plain(); h.visible = false; g.add(h); }
    if (lb % 5 === 1) { const p = plain(); const c = inst(); c.name = `child${nid++}`; p.add(c); g.add(p); } // a caster with a caster child
  }
  scene.updateMatrixWorld(true);
  return scene;
}
function cascades() {
  const lights = [];
  for (const [i, half] of [[0, 40], [1, 100], [2, 300]]) {
    const L = new THREE.DirectionalLight(0xffffff, 0);
    L.castShadow = true;
    L.position.set(60, 200, 25); L.target.position.set(0, 0, 0);
    L.shadow.camera.left = -half; L.shadow.camera.right = half; L.shadow.camera.top = half; L.shadow.camera.bottom = -half;
    L.shadow.camera.near = 1; L.shadow.camera.far = 600; L.shadow.camera.updateProjectionMatrix();
    L.shadow.mapSize.set(256, 256);
    L.updateMatrixWorld(true); L.target.updateMatrixWorld(true);
    camLight.set(L.shadow.camera, i);
    lights.push(L);
  }
  return lights;
}
const scene = buildScene();
const lights = cascades();
const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
camera.position.set(0, 20, 50); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);

function frame() {
  log = []; frustumTests = 0; replayFlips = 0;
  sm.needsUpdate = true;
  sm.render(lights, scene, camera);
  return { log, frustumTests, flips: replayFlips };
}
const key = (d) => `${d.li}|${d.name}|${d.mat}|${d.group}`;
const isChild = (d) => d.name.startsWith("child");
// Per light, the kinds of the top-level draws never decrease.
const kindsAscend = (lg) => [0, 1, 2].every((i) => {
  const ks = lg.filter((d) => d.li === i && !isChild(d)).map((d) => d.kind);
  for (let k = 1; k < ks.length; k++) if (ks[k] < ks[k - 1]) return false;
  return true;
});
const multiset = (lg) => lg.map(key).sort().join("\n");

// ---------------------------------------------------------------------------- K1
console.log("\n-- K1 depthProgramKind ----------------------------------------------");
{
  const K = SCL.depthProgramKind;
  const im = new THREE.InstancedMesh(box, matPlain, 2);
  const imc = new THREE.InstancedMesh(box, matPlain, 2); imc.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(6), 3);
  const bm = { isBatchedMesh: true, _colorsTexture: null, material: matPlain };
  const bmc = { isBatchedMesh: true, _colorsTexture: {}, material: matPlain };
  const sk = { isSkinnedMesh: true, material: matPlain };
  const mo = { morphTargetInfluences: [0], material: matPlain };
  check("K1 plain 0, batched 1 (+2 colour), instanced 4 (+8 colour)", K(new THREE.Mesh(box, matPlain)) === 0 && K(bm) === 1 && K(bmc) === 3 && K(im) === 4 && K(imc) === 12);
  check("K1 skinned 32, morph targets 64", K(sk) === 32 && K(mo) === 64);
  check("K1 shared-material alphaTest (no map) 128; a map / alphaMap / alphaToCoverage variant 0",
    K(new THREE.Mesh(box, matAlphaNoMap)) === 128 && K(new THREE.Mesh(box, matClip)) === 0 &&
    K(new THREE.Mesh(box, new THREE.MeshStandardMaterial({ alphaTest: 0.5, alphaMap: tex }))) === 0 &&
    K(new THREE.Mesh(box, new THREE.MeshStandardMaterial({ alphaTest: 0.5, alphaToCoverage: true }))) === 0);
  const cust = new THREE.Mesh(box, matAlphaNoMap); cust.customDepthMaterial = swayDepth;
  check("K1 a custom depth material never takes the shared alphaTest bit", K(cust) === 0);
  check("K1 array material: the first group's", K(new THREE.Mesh(box, [matAlphaNoMap, matPlain])) === 128);
}

installAndRun();

function installAndRun() {
  // ---------------------------------------------------------------------------- K2/K3
  console.log("\n-- K2/K3 walk order vs sorted ------------------------------------------");
  const base = frame(); // three's own walk (not installed yet)
  // Installed on the renderer three's WebGLShadowMap draws through (in the app
  // renderer.shadowMap's own renderer), so the counter wraps the right method.
  check("installs", SCL.installShadowCasterList(stubRenderer, { force: true }) === true);
  // Warm both arms once so first-use resolves do not count.
  SCL.__setShadowCasterSortOffForTest(true);
  frame();
  const off = frame();
  SCL.__setShadowCasterSortOffForTest(false);
  frame();
  const on = frame();
  const perLight = (lg) => [0, 1, 2].map((i) => lg.filter((d) => d.li === i).length);
  console.log(`    draws/light ${perLight(on.log).join("/")}; re-resolves per frame: walk order ${off.flips}, sorted ${on.flips}`);
  check("K2 bug trigger: walk order re-resolves on a large share of draws", off.flips > on.log.length / 4, `${off.flips} of ${on.log.length}`);
  // Bound: per light, each depth material re-resolves at most once per kind it
  // draws, plus two per nested caster (it is drawn inside its parent's run: in
  // and back out of its kind — the walk keeps a candidate's subtree with it).
  let bound = 0;
  for (let i = 0; i < 3; i += 1) {
    const lg = on.log.filter((d) => d.li === i);
    bound += new Set(lg.map((d) => `${d.mat}|${d.kind}`)).size + 2 * lg.filter(isChild).length;
  }
  check("K2 sorted: ≤ one re-resolve per (depth material, kind) per light (+2 per nested caster)", on.flips <= bound, `${on.flips} ≤ ${bound}`);
  check("K2 sorted: ≥ 10× fewer re-resolves", on.flips * 10 <= off.flips, `${on.flips} vs ${off.flips}`);
  check("K3 identical draw multiset per light vs three's own walk", multiset(on.log) === multiset(base.log) && multiset(off.log) === multiset(base.log),
    `on=${on.log.length} base=${base.log.length}`);
  check("K3 identical frustum-test count", on.frustumTests === base.frustumTests && off.frustumTests === base.frustumTests);
  check("K3 seam off = three's walk order exactly", off.log.map(key).join("\n") === base.log.map(key).join("\n"));
  // Stable: within each kind, the walk-order subsequence of the top-level
  // candidates is kept (a nested caster — "child…" — rides with its parent).
  let stable = true;
  for (let i = 0; i < 3 && stable; i += 1) {
    const kindsSeen = new Set(base.log.filter((d) => d.li === i).map((d) => d.kind));
    for (const k of kindsSeen) {
      const s1 = on.log.filter((d) => d.li === i && d.kind === k && !isChild(d)).map(key).join(",");
      const s0 = base.log.filter((d) => d.li === i && d.kind === k && !isChild(d)).map(key).join(",");
      if (s1 !== s0) stable = false;
    }
  }
  check("K3 stable within a kind (walk order kept)", stable);
  check("K3 sorted: top-level kinds ascend per light", kindsAscend(on.log));
  check("K3 walk order: they do not (negative control)", !kindsAscend(off.log));

  // ---------------------------------------------------------------------------- K4
  console.log("\n-- K4 the opt-in counter --------------------------------------------");
  const p0 = SCL.getShadowCasterListStats().programChanges;
  frame();
  check("K4 off by default: nothing counted, renderBufferDirect not wrapped", SCL.getShadowCasterListStats().programChanges === p0 &&
    stubRenderer.renderBufferDirect.name === "renderBufferDirect");
  SCL.__setShadowProgramStatsForTest(true);
  const c1 = frame();
  const sOn = SCL.getShadowCasterListStats();
  check("K4 sorted: counter == three's replay", sOn.lastProgramChanges === c1.flips, `${sOn.lastProgramChanges} vs ${c1.flips}`);
  SCL.__setShadowCasterSortOffForTest(true);
  const c2 = frame();
  const sOff = SCL.getShadowCasterListStats();
  check("K4 walk order: counter == three's replay", sOff.lastProgramChanges === c2.flips && c2.flips > c1.flips, `${sOff.lastProgramChanges} vs ${c2.flips}`);
  SCL.__setShadowCasterSortOffForTest(false);
  check("K4 renderBufferDirect restored after each raster", stubRenderer.renderBufferDirect.name === "renderBufferDirect");
  check("K4 programDraws counts every shadow draw", sOff.programDraws >= c1.log.length + c2.log.length);
  SCL.__setShadowProgramStatsForTest(false);

  // ---------------------------------------------------------------------------- K5
  console.log("\n-- K5 run stats ------------------------------------------------------");
  frame();
  const st = SCL.getShadowCasterListStats();
  console.log(`    kinds ${st.lastKinds}, runs walk-order ${st.lastRunsBefore} → handed ${st.lastRunsAfter}`);
  check("K5 runs: walk order > handed = kinds", st.lastRunsBefore > st.lastRunsAfter && st.lastRunsAfter === st.lastKinds && st.lastKinds >= 4);
  {
    const s2 = new THREE.Scene();
    for (let i = 0; i < 20; i++) s2.add(plain());
    s2.updateMatrixWorld(true);
    const r0 = SCL.getShadowCasterListStats().reorders;
    sm.needsUpdate = true;
    sm.render(lights, s2, camera);
    const st2 = SCL.getShadowCasterListStats();
    check("K5 a single-kind list is never reordered", st2.reorders === r0 && st2.lastKinds === 1 && st2.lastRunsBefore === 1);
  }

  // ---------------------------------------------------------------------------- K6
  console.log("\n-- K6 VSM keeps walk order -------------------------------------------");
  {
    SCL.__setShadowCasterListOffForTest(true);
    sm.type = THREE.VSMShadowMap;
    const ref = frame(); // three's own walk, VSM (type change frame)
    SCL.__setShadowCasterListOffForTest(false);
    frame(); // the wrapper's type-change passthrough frame
    const cur = frame();
    check("K6 VSM: same draws, same order as three", cur.log.map(key).join("\n") === ref.log.map(key).join("\n"), `${cur.log.length} vs ${ref.log.length}`);
    sm.type = THREE.PCFShadowMap;
    frame();
  }

  // ---------------------------------------------------------------------------- K7
  console.log("\n-- K7 ?shadowStaticCache path ----------------------------------------");
  {
    // A dynamic root (rigs) plus the static scene; managed lights.
    const dyn = new THREE.Group(); dyn.name = "entities";
    scene.add(dyn);
    const dynSet = new Set();
    for (let i = 0; i < 8; i++) { const o = i % 2 ? plain() : inst(); dyn.add(o); dynSet.add(o.name); }
    scene.updateMatrixWorld(true);
    sm.__hbShadowDynamicRoot = dyn;
    // Fresh lights so the first managed raster is NORMAL (no map yet).
    const ml = cascades();
    for (const l of ml) l.userData.hbShadowManaged = true;
    SCL.__setShadowCasterListOffForTest(true);
    log = []; sm.needsUpdate = true; sm.render(ml, scene, camera);
    const ref = log.slice();
    // three's own pass made the maps; drop them: every light NORMAL ⇒ the
    // cache path hands the raster back to the plain (sorted) single pass.
    for (const l of ml) { l.shadow.map = null; l.userData.hbShadowReason = 4; }
    SCL.__setShadowCasterListOffForTest(false);
    const sc0a = SCL.getShadowStaticCacheStats();
    log = []; sm.needsUpdate = true; sm.render(ml, scene, camera);
    const plainPass = log.slice();
    const sc0 = SCL.getShadowStaticCacheStats();
    check("K7 all-NORMAL raster (handed back to the single pass): same draws as three, kinds ascend",
      sc0.passthrough === sc0a.passthrough + 1 && multiset(plainPass) === multiset(ref) && kindsAscend(plainPass));
    // Mixed: light 0 has no map (NORMAL: statics + dynamics in one list), 1 / 2
    // were refit (FRUSTUM ⇒ REFRESH: static pass, blit, dynamic pass).
    ml[0].shadow.map = null;
    for (const l of ml) l.userData.hbShadowReason = 4;
    log = []; sm.needsUpdate = true; sm.render(ml, scene, camera);
    const mixed = log.slice();
    const sc1 = SCL.getShadowStaticCacheStats();
    check("K7 mixed raster: 1 NORMAL + 2 REFRESH, same draws as three",
      sc1.normal === sc0.normal + 1 && sc1.refresh === sc0.refresh + 2 && multiset(mixed) === multiset(ref),
      JSON.stringify({ normal: sc1.normal - sc0.normal, refresh: sc1.refresh - sc0.refresh, n: mixed.length, r: ref.length }));
    const l0 = mixed.filter((d) => d.li === 0);
    const l12 = mixed.filter((d) => d.li !== 0);
    check("K7 NORMAL list (statics + dynamics) ascends", kindsAscend(l0));
    check("K7 REFRESH: static pass and dynamic pass each ascend",
      kindsAscend(l12.filter((d) => !dynSet.has(d.name))) && kindsAscend(l12.filter((d) => dynSet.has(d.name))));
    scene.remove(dyn);
    delete sm.__hbShadowDynamicRoot;
  }

  // ---------------------------------------------------------------------------- K8
  console.log("\n-- K8 flag readers ----------------------------------------------------");
  check("K8 ?shadowCasterSort absent ⇒ on", SCL.shadowCasterSortFlag("") === true && SCL.shadowCasterSortFlag("?x=1") === true);
  check("K8 off/0/false/no ⇒ off", ["off", "0", "false", "no", "OFF"].every((v) => SCL.shadowCasterSortFlag(`?shadowCasterSort=${v}`) === false));
  check("K8 ?shadowProgramStats exact opt-in", SCL.shadowProgramStatsFlag("") === false && SCL.shadowProgramStatsFlag("?shadowProgramStats=on") === true &&
    SCL.shadowProgramStatsFlag("?shadowProgramStats=1") === false);
  check("K8 module default (no URL): sort on", SCL.shadowCasterSortEnabled() === true);
}

THREE.Frustum.prototype.intersectsObject = _ios;
console.log(`\nshadow_caster_sort: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
