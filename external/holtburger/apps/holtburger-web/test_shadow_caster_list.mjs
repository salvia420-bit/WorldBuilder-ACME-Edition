// 2026-10-07 — ?shadowCasterList (scene3d/shadow_caster_list.js).
//
// Drives three r184's REAL `WebGLShadowMap` (extracted from three.module.js —
// it is not exported) against a stub renderer that logs every shadow draw, and
// asserts that the candidate-list walk hands three exactly the same draws, in
// the same order, per light, as three's own whole-scene walk — across nested
// casters, hidden subtrees, layers, Lines/Points, sprites, array materials,
// alpha-tested depth variants, the VSM receiveShadow rule and a type change.
//
// Run:
//   cd apps/holtburger-web/
//   node test_shadow_caster_list.mjs

import * as THREE from "three";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  installShadowCasterList, uninstallShadowCasterList,
  getShadowCasterListStats, __setShadowCasterListOffForTest,
} from "./scene3d/shadow_caster_list.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

// --- three's own WebGLShadowMap ------------------------------------------------
const require = createRequire(import.meta.url);
const threeDir = require.resolve("three").replace(/[^/\\]+$/, "");
const src = readFileSync(threeDir + "three.module.js", "utf8");
const a = src.indexOf("const vertex = \"void main()");
const b = src.indexOf("function WebGLState(");
if (a < 0 || b < 0 || !src.slice(a, b).includes("function WebGLShadowMap(")) {
  console.log("shadow-caster-list test: three.module.js layout changed — re-anchor the extraction.");
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const WebGLShadowMap = new Function("THREE", "with (THREE) {\n" + src.slice(a, b) + "\nreturn WebGLShadowMap; }")(THREE);

// --- stub renderer: logs every draw three issues --------------------------------
let log = [];
const camLight = new Map(); // shadow camera -> light index
const stubRenderer = {
  getRenderTarget: () => null,
  getActiveCubeFace: () => 0,
  getActiveMipmapLevel: () => 0,
  setRenderTarget() {},
  clear() {},
  state: {
    setBlending() {}, setScissorTest() {}, viewport() {},
    buffers: { depth: { getReversed: () => false, setTest() {} }, color: { setClear() {} } },
  },
  renderBufferDirect(camera, scene, geometry, material, object, group) {
    const li = camLight.has(camera) ? camLight.get(camera) : "post";
    log.push(`${li}:${object.name || object.id}:${material.type}:${material.uuid.slice(0, 4)}:${group ? group.materialIndex : "-"}`);
  },
};
const objects = { update: (o) => o.geometry };
const sm = new WebGLShadowMap(stubRenderer, objects, { maxTextureSize: 16384 });
sm.enabled = true;
sm.type = THREE.PCFShadowMap;
const renderer = { shadowMap: sm };

// --- frustum tests three performs (must be identical too) ------------------------
let frustumTests = 0;
const _ios = THREE.Frustum.prototype.intersectsObject;
THREE.Frustum.prototype.intersectsObject = function (o) { frustumTests++; return _ios.call(this, o); };

// --- a deterministic scene with every shape the walk has to respect -------------
let seed = 99;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const box = new THREE.BoxGeometry(1, 1, 1);
const tex = new THREE.DataTexture(new Uint8Array(4), 1, 1);
const matPlain = new THREE.MeshStandardMaterial();
const matClip = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5 });
const matHidden = new THREE.MeshStandardMaterial(); matHidden.visible = false;
let nid = 0;
function mesh(cast, recv, mat = matPlain) {
  const m = new THREE.Mesh(box, mat);
  m.name = `m${nid++}`;
  m.castShadow = cast; m.receiveShadow = recv;
  m.position.set((rnd() - 0.5) * 300, rnd() * 5, (rnd() - 0.5) * 300);
  return m;
}
function buildScene() {
  const scene = new THREE.Scene();
  for (let r = 0; r < 60; r++) {
    const rig = new THREE.Group(); rig.name = `rig${r}`;
    rig.position.set((rnd() - 0.5) * 300, 0, (rnd() - 0.5) * 300);
    scene.add(rig);
    const nParts = 1 + Math.floor(rnd() * 6);
    for (let p = 0; p < nParts; p++) {
      const part = new THREE.Object3D(); part.name = `rig${r}p${p}`;
      rig.add(part);
      const roll = rnd();
      const m = roll < 0.1 ? mesh(true, true, matClip) : roll < 0.15 ? mesh(true, false, matHidden) : mesh(rnd() < 0.7, rnd() < 0.5);
      m.position.set(rnd(), rnd(), rnd());
      part.add(m);
      if (rnd() < 0.2) { const kid = mesh(rnd() < 0.5, true); kid.position.set(0, 1, 0); m.add(kid); } // nested under a mesh
      if (rnd() < 0.1) m.layers.set(3);                                                        // off the camera's layers
      if (rnd() < 0.1) part.visible = false;                                                  // hidden part
    }
    if (rnd() < 0.15) rig.visible = false;                                                    // culled rig
    if (rnd() < 0.3) { const sp = new THREE.Sprite(); sp.name = `sprite${r}`; sp.castShadow = true; rig.add(sp); }
  }
  // terrain-like non-casting meshes with deep non-caster children
  const terrain = new THREE.Group(); terrain.name = "terrain"; scene.add(terrain);
  for (let i = 0; i < 40; i++) { const t = mesh(false, true); t.add(new THREE.Group()); terrain.add(t); }
  // a caster parented under a NON-caster mesh, and a caster under a hidden group
  const host = mesh(false, true); host.name = "host"; scene.add(host);
  const under = mesh(true, false); under.name = "under-noncaster"; host.add(under);
  const hid = new THREE.Group(); hid.visible = false; scene.add(hid); hid.add(mesh(true, true));
  // Line / Points casters
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 1, 1)]), new THREE.LineBasicMaterial());
  line.name = "line"; line.castShadow = true; scene.add(line);
  const pts = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(5, 0, 5)]), new THREE.PointsMaterial());
  pts.name = "points"; pts.castShadow = true; scene.add(pts);
  // array material with groups
  const g2 = box.clone(); g2.clearGroups(); g2.addGroup(0, 18, 0); g2.addGroup(18, 18, 1);
  const multi = new THREE.Mesh(g2, [matPlain, matClip]); multi.name = "multi"; multi.castShadow = true; scene.add(multi);
  // a frustum-culled-off caster far away
  const far = mesh(true, false); far.name = "far-unculled"; far.frustumCulled = false; far.position.set(5000, 0, 5000); scene.add(far);
  scene.updateMatrixWorld(true);
  return scene;
}
function cascades() {
  const lights = [];
  for (const [i, half] of [[0, 30], [1, 100], [2, 300]]) {
    const L = new THREE.DirectionalLight(0xffffff, 0);
    L.castShadow = true;
    L.position.set(40, 200, 25); L.target.position.set(0, 0, 0);
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
  log = []; frustumTests = 0;
  sm.needsUpdate = true;
  sm.render(lights, scene, camera);
  return { log, frustumTests };
}

// -----------------------------------------------------------------------------
console.log("\n-- 1. three's walk vs the candidate list (PCF) --");
const base = frame();
check("1a: baseline draws something in every cascade", [0, 1, 2].every((i) => base.log.some((l) => l.startsWith(`${i}:`))),
  `draws=${base.log.length}`);
check("installs", installShadowCasterList(renderer, { force: true }) === true);
check("idempotent", installShadowCasterList(renderer, { force: true }) === true);
const got = frame();
const st = getShadowCasterListStats();
check("1b: identical draw sequence (light, object, depth material, group)", got.log.join("|") === base.log.join("|"),
  `base=${base.log.length} got=${got.log.length}`);
check("1c: identical frustum tests", got.frustumTests === base.frustumTests, `${got.frustumTests} vs ${base.frustumTests}`);
check("1d: served from the list", st.walks === 1 && st.lastListed > 0 && st.lastListed < st.lastVisited,
  `listed=${st.lastListed} visited=${st.lastVisited}`);
check("1e: the nested caster under a non-caster mesh is drawn", got.log.some((l) => l.includes(":under-noncaster:")));
check("1f: Line + Points casters drawn, sprites never", got.log.some((l) => l.includes(":line:")) && got.log.some((l) => l.includes(":points:"))
  && !got.log.some((l) => l.includes(":sprite")));

// -----------------------------------------------------------------------------
console.log("\n-- 2. visibility / layer changes between frames --");
{
  let ok = true, n = 0;
  for (let f = 0; f < 6; f++) {
    scene.traverse((o) => { if (o.name.startsWith("rig") && !o.name.includes("p") && rnd() < 0.2) o.visible = !o.visible; });
    scene.traverse((o) => { if (o.isMesh && rnd() < 0.03) o.castShadow = !o.castShadow; });
    if (f === 3) camera.layers.enable(3);
    __setShadowCasterListOffForTest(true);
    const ref = frame();
    __setShadowCasterListOffForTest(false);
    const cur = frame();
    if (ref.log.join("|") !== cur.log.join("|") || ref.frustumTests !== cur.frustumTests) ok = false;
    n += cur.log.length;
  }
  check("2a: six mutated frames, identical each time (seam off = three's walk)", ok, `draws=${n}`);
  camera.layers.disable(3);
}

// -----------------------------------------------------------------------------
console.log("\n-- 3. gated frame (RP5: autoUpdate=false, needsUpdate=false) pays nothing --");
{
  const w0 = getShadowCasterListStats().walks;
  sm.autoUpdate = false; sm.needsUpdate = false;
  log = [];
  sm.render(lights, scene, camera);
  check("3a: no walk, no draw", getShadowCasterListStats().walks === w0 && log.length === 0);
  sm.needsUpdate = true;
  log = [];
  sm.render(lights, scene, camera);
  check("3b: needsUpdate re-arms it (one walk) and three clears the flag", getShadowCasterListStats().walks === w0 + 1
    && log.length > 0 && sm.needsUpdate === false);
  sm.autoUpdate = true;
}

// -----------------------------------------------------------------------------
console.log("\n-- 4. shadow type change: three sees the real scene that frame; VSM rules --");
{
  const p0 = getShadowCasterListStats().passthrough;
  const pcfNow = frame(); // same scene state, PCF
  sm.type = THREE.VSMShadowMap;
  __setShadowCasterListOffForTest(true);
  const refVsm = frame();   // three alone (type change handled by three)
  __setShadowCasterListOffForTest(false);
  const curVsm = frame();
  check("4a: VSM (receiveShadow also rasters) identical to three", refVsm.log.join("|") === curVsm.log.join("|"),
    `ref=${refVsm.log.length} cur=${curVsm.log.length}`);
  check("4b: VSM also rasters receive-only meshes", curVsm.log.length > pcfNow.log.length,
    `vsm=${curVsm.log.length} pcf=${pcfNow.log.length}`);
  // a type flip with the list ON: the flip frame goes to three with the real scene
  sm.type = THREE.PCFShadowMap;
  const flip = frame();
  check("4c: the flip frame was a passthrough", getShadowCasterListStats().passthrough > p0);
  const after = frame();
  check("4d: back on the list after the flip, still identical", after.log.join("|") === flip.log.join("|"));
}

// -----------------------------------------------------------------------------
console.log("\n-- 5. no scene references held between frames --");
check("5a: stand-in root is empty after a raster", sm.__hbCasterList.root.children.length === 0);

uninstallShadowCasterList(renderer);
check("uninstall restores three's method", sm.render === sm.__hbCasterList?.orig || !("__hbCasterList" in sm));
const back = frame();
check("uninstalled = three's walk again", back.log.join("|") === frame().log.join("|"));
THREE.Frustum.prototype.intersectsObject = _ios;
console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
