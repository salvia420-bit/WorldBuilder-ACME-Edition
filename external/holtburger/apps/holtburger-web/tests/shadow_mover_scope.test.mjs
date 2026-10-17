// ?shadowMoverScope (scene3d/lighting.js, DEFAULT ON, `=off` escape) — fps
// wave 1, 2026-10-17. The static-shadow gate re-rasters only the cascades a
// rig change actually touches, ignores rigs that draw nothing (hidden), and
// keeps the staleness ceiling per cascade.
//
// Drives the REAL lighting tick (setupSceneLighting + tickLightingForCellState,
// csm.js cascade fit) against three r184's REAL WebGLShadowMap (extracted from
// three.module.js as in test_shadow_caster_list.mjs — it is not exported) on a
// stub renderer that records which cascade maps three actually rendered.
//
//   A  first gated frame warms all 3 cascades; then each cascade's 12-frame
//      ceiling, staggered (one cascade per ceiling frame), every 12 frames
//   B  a rig walking where only the FAR cascade's frustum reaches re-renders
//      only that cascade
//   C  a HIDDEN rig walking inside every cascade re-renders nothing; its
//      visibility flip re-renders the cascades holding it
//   D  a rig walking far outside every cascade re-renders nothing
//   E  despawn: the cascades holding its last pose re-render (old shadow out)
//   F  guid reused by a new instance: old + new sphere
//   G  a mark three has not consumed yet (no render that frame) stays armed
//   H  lag bound: a rig walking through the cascades leaves no cascade showing
//      a stale pose of it for two consecutive frames (ceiling disabled)
//   I  a camera move (refit) still re-renders all 3
//   J  single-shadow path (?shadows=on): the sun's frustum scopes it the same way
//   K  `?shadowMoverScope=off`: the RP5 hash — any rig moving anywhere, hidden
//      or not, re-renders every cascade
//   L  the flag reader
//
// Run:  cd apps/holtburger-web && node tests/shadow_mover_scope.test.mjs

import * as THREE from "three";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

globalThis.window = globalThis.window || {};
globalThis.location = { search: "" };
window.location = globalThis.location;

const L = await import("../scene3d/lighting.js");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass += 1; console.log(`  [OK] ${name}`); }
  else { fail += 1; console.error(`  [FAIL] ${name}${extra ? ` — ${extra}` : ""}`); }
}

// --- three's own WebGLShadowMap --------------------------------------------------
const require = createRequire(import.meta.url);
const threeDir = require.resolve("three").replace(/[^/\\]+$/, "");
const src = readFileSync(threeDir + "three.module.js", "utf8");
const a = src.indexOf("const vertex = \"void main()");
const b = src.indexOf("function WebGLState(");
if (a < 0 || b < 0 || !src.slice(a, b).includes("function WebGLShadowMap(")) {
  console.log("shadow_mover_scope: three.module.js layout changed — re-anchor the extraction.");
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const WebGLShadowMap = new Function("THREE", "with (THREE) {\n" + src.slice(a, b) + "\nreturn WebGLShadowMap; }")(THREE);

function makeRenderer() {
  const rendered = new Set();
  let lights = [];
  const stub = {
    getRenderTarget: () => null,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    setRenderTarget(rt) {
      if (!rt) return;
      const i = lights.findIndex((l) => l.shadow.map === rt);
      if (i >= 0) rendered.add(i);
    },
    clear() {},
    state: {
      setBlending() {}, setScissorTest() {}, viewport() {},
      buffers: { depth: { getReversed: () => false, setTest() {} }, color: { setClear() {} } },
    },
    renderBufferDirect() {},
  };
  const sm = new WebGLShadowMap(stub, { update: (o) => o.geometry }, { maxTextureSize: 16384 });
  sm.enabled = true;
  sm.type = THREE.PCFShadowMap;
  return { renderer: { shadowMap: sm }, sm, rendered, setLights(ls) { lights = ls; } };
}

// AC frame (+Z up) under worldRoot, exactly as index.js builds it.
function makeWorld() {
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2;
  scene.add(worldRoot);
  const entitiesGroup = new THREE.Group();
  worldRoot.add(entitiesGroup);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  camera.position.set(0, 5, 0); // looks down three -Z = AC +Y
  scene.add(camera);
  scene.updateMatrixWorld(true);
  return { scene, worldRoot, entitiesGroup, camera };
}

const rigGeom = new THREE.BoxGeometry(1, 1, 2);
const rigMat = new THREE.MeshStandardMaterial();
function makeRig(world, acX, acY, acZ = 0) {
  const root = new THREE.Group();
  root.position.set(acX, acY, acZ);
  const m = new THREE.Mesh(rigGeom, rigMat);
  m.castShadow = true;
  m.position.set(0, 0, 1);
  root.add(m);
  world.entitiesGroup.add(root);
  return { root };
}

function makeSession({ csm = true } = {}) {
  const world = makeWorld();
  const r = makeRenderer();
  const lighting = L.setupSceneLighting(world.scene, csm ? { csm: true } : { castShadow: true });
  const lights = csm ? lighting.csmState.lights : [lighting.sun];
  r.setLights(lights);
  const entityMap = new Map();
  const scene3d = {
    renderer: r.renderer,
    lighting,
    camera: world.camera,
    scene: world.scene,
    entityManager: { entityMap },
  };
  function frame(move) {
    L.tickLightingForCellState(scene3d, null);
    if (move) move(); // entityManager.tick runs after the lighting tick
    world.scene.updateMatrixWorld();
    r.rendered.clear();
    r.sm.render(lights, world.scene, world.camera);
    return [...r.rendered].sort().join("");
  }
  return { world, lighting, lights, scene3d, entityMap, frame, sm: r.sm };
}

// Which cascades hold a world-space sphere (three's own frustum test).
function holders(lights, center, radius) {
  const s = new THREE.Sphere(center, radius);
  let out = "";
  lights.forEach((l, i) => { if (l.shadow.getFrustum().intersectsSphere(s)) out += i; });
  return out;
}
const acToWorld = (x, y, z) => new THREE.Vector3(x, z, -y);

L.__resetRp5ConfigForTest(undefined);

// ---------------------------------------------------------------- A
{
  const S = makeSession();
  check("A1 first gated frame warms all 3 cascades", S.frame() === "012");
  // Ceiling after a full raster is staggered: cascade i restarts i/3 of the
  // way into the 12-frame period (frames 5 / 9 / 13 for cascades 2 / 1 / 0),
  // then each refreshes every 12 frames, never two on the same frame.
  const at = { 0: [], 1: [], 2: [] };
  let multi = false;
  for (let f = 2; f <= 37; f += 1) {
    const got = S.frame();
    if (got.length > 1) multi = true;
    for (const ch of got) at[ch].push(f);
  }
  check("A2 a static scene: first ceilings staggered (c2@5, c1@9, c0@13)", at[2][0] === 5 && at[1][0] === 9 && at[0][0] === 13, JSON.stringify(at));
  check("A3 ...then every cascade every 12 frames", [0, 1, 2].every((i) => at[i].every((f, k) => k === 0 || f - at[i][k - 1] === 12)) && at[0].length === 3);
  check("A3 ...one cascade per ceiling frame", !multi);
  check("A4 managed lights run autoUpdate=false", S.lights.every((l) => l.shadow.autoUpdate === false));
}

// ---------------------------------------------------------------- B
{
  const S = makeSession();
  S.frame();
  // Find a point on the view axis held ONLY by the far cascade.
  let farY = -1;
  for (let y = 60; y < 900; y += 5) {
    if (holders(S.lights, acToWorld(0, y, 1), 3) === "2") { farY = y; break; }
  }
  check("B0 premise: some ground point is held by cascade 2 alone", farY > 0, `farY=${farY}`);
  const rig = makeRig(S.world, 0, farY);
  S.entityMap.set(1, rig);
  const spawn = S.frame();
  check("B1 a spawn rasters only the cascade that holds it", spawn === "2", `got "${spawn}"`);
  let only2 = true;
  for (let f = 0; f < 6; f += 1) {
    const got = S.frame(() => { rig.root.position.x += 0.1; });
    if (got !== "2" && got !== "") only2 = false;
  }
  check("B2 walking there re-renders cascade 2 only", only2);
}

// ---------------------------------------------------------------- C
{
  L.__resetRp5ConfigForTest({ shadowMaxStaleFrames: 600 }); // isolate from the ceiling
  const S = makeSession();
  S.frame();
  const rig = makeRig(S.world, 0, 10);
  rig.root.visible = false;
  S.entityMap.set(7, rig);
  check("C0 premise: the rig's spot is inside every cascade", holders(S.lights, acToWorld(0, 10, 1), 2) === "012");
  let none = true;
  for (let f = 0; f < 8; f += 1) {
    if (S.frame(() => { rig.root.position.y += 0.2; }) !== "") none = false;
  }
  check("C1 a hidden rig walking inside every cascade rasters nothing", none);
  check("C2 ...and is counted as a hidden move", S.scene3d._shadowMovers.stats.hiddenMoves >= 7);
  S.frame(() => { rig.root.visible = true; }); // becomes drawn after this tick's scan
  const flip = S.frame();
  check("C3 its visibility flip re-renders the cascades holding it", flip === "012", `got "${flip}"`);
  const hiddenAncestor = makeRig(S.world, 2, 10);
  S.entityMap.set(8, hiddenAncestor);
  S.frame();
  S.world.entitiesGroup.visible = false; // e.g. portal space hides the world
  const gone = S.frame();
  check("C4 a hidden ANCESTOR is a visibility flip too", gone === "012", `got "${gone}"`);
  S.world.entitiesGroup.visible = true;
  L.__resetRp5ConfigForTest(undefined);
}

// ---------------------------------------------------------------- D
{
  L.__resetRp5ConfigForTest({ shadowMaxStaleFrames: 600 });
  const S = makeSession();
  S.frame();
  const rig = makeRig(S.world, 4000, 4000);
  S.entityMap.set(2, rig);
  check("D0 premise: 4 km away is outside every cascade", holders(S.lights, acToWorld(4000, 4000, 1), 5) === "");
  let none = true;
  for (let f = 0; f < 8; f += 1) if (S.frame(() => { rig.root.position.x += 1; }) !== "") none = false;
  check("D1 a walker outside every cascade rasters nothing", none);
  L.__resetRp5ConfigForTest(undefined);
}

// ---------------------------------------------------------------- E + F
{
  const S = makeSession();
  S.frame();
  const rig = makeRig(S.world, 0, 10);
  S.entityMap.set(3, rig);
  S.frame();
  for (let f = 0; f < 3; f += 1) S.frame();
  S.entityMap.delete(3);
  S.world.entitiesGroup.remove(rig.root);
  const out = S.frame();
  check("E1 despawn re-renders the cascades that held its last pose", out === "012", `got "${out}"`);
  check("E2 ...and drops its record", !S.scene3d._shadowMovers.recs.has(3));

  let farY = -1;
  for (let y = 60; y < 900; y += 5) if (holders(S.lights, acToWorld(0, y, 1), 3) === "2") { farY = y; break; }
  const old = makeRig(S.world, 0, farY);
  S.entityMap.set(4, old);
  S.frame();
  for (let f = 0; f < 2; f += 1) S.frame();
  S.world.entitiesGroup.remove(old.root);
  const fresh = makeRig(S.world, 4000, 4000); // same guid, new instance, out of range
  S.entityMap.set(4, fresh);
  const out2 = S.frame();
  check("F1 a reused guid erases the old instance's shadow (cascade 2)", out2 === "2", `got "${out2}"`);
}

// ---------------------------------------------------------------- G
{
  const S = makeSession();
  S.frame();
  let farY = -1;
  for (let y = 60; y < 900; y += 5) if (holders(S.lights, acToWorld(0, y, 1), 3) === "2") { farY = y; break; }
  const rig = makeRig(S.world, 0, farY);
  S.entityMap.set(5, rig);
  S.frame();
  S.frame(() => { rig.root.position.x += 0.5; });
  // Next frame's scan sees the step; skip the world render this frame.
  L.tickLightingForCellState(S.scene3d, null);
  check("G1 the mark is armed", S.lights[2].shadow.needsUpdate === true && S.sm.needsUpdate === true);
  const out = S.frame(); // nothing new moved, but the mark was never consumed
  check("G2 an unconsumed mark still rasters on the next render", out.includes("2"), `got "${out}"`);
  check("G3 three consumed it", S.lights[2].shadow.needsUpdate === false && S.sm.needsUpdate === false);
}

// ---------------------------------------------------------------- H
{
  L.__resetRp5ConfigForTest({ shadowMaxStaleFrames: 600 });
  const S = makeSession();
  S.frame();
  const rig = makeRig(S.world, -60, 5);
  S.entityMap.set(6, rig);
  S.frame();
  const trueR = 1.23; // the 1x1x2 box's bounding sphere
  // content[i] = rig pose (AC x,y) cascade i last rendered
  const pose = () => [rig.root.position.x, rig.root.position.y];
  let content = [pose(), pose(), pose()];
  const staleRun = [0, 0, 0];
  let worst = 0, rasters = 0;
  for (let f = 0; f < 140; f += 1) {
    const out = S.frame(() => { rig.root.position.x += 0.9; rig.root.position.y += 1.7; });
    rasters += out.length;
    const now = pose();
    for (let i = 0; i < 3; i += 1) {
      if (out.includes(String(i))) content[i] = now;
      const c = content[i];
      const same = c[0] === now[0] && c[1] === now[1];
      const inOld = holders([S.lights[i]], acToWorld(c[0], c[1], 1), trueR) !== "";
      const inNow = holders([S.lights[i]], acToWorld(now[0], now[1], 1), trueR) !== "";
      const stale = !same && (inOld || inNow);
      staleRun[i] = stale ? staleRun[i] + 1 : 0;
      if (staleRun[i] > worst) worst = staleRun[i];
    }
  }
  check("H1 no cascade shows a stale pose of a walker for 2 frames running", worst <= 1, `worst run ${worst}`);
  check("H2 ...while not every cascade rasters every frame", rasters < 140 * 3, `rasters=${rasters}`);
  L.__resetRp5ConfigForTest(undefined);
}

// ---------------------------------------------------------------- H (old pose)
{
  const S = makeSession();
  S.frame();
  const rig = makeRig(S.world, 0, 10);
  S.entityMap.set(12, rig);
  S.frame();
  S.frame();
  S.frame(() => { rig.root.position.set(4000, 4000, 0); }); // one step: out of every cascade
  const out = S.frame();
  check("H3 a rig stepping OUT of the cascades re-renders the ones holding its old pose", out === "012", `got "${out}"`);
}

// ---------------------------------------------------------------- I
{
  const S = makeSession();
  S.frame();
  S.frame();
  S.world.camera.position.x += 3;
  check("I1 a camera move (cascade refit) re-renders all 3", S.frame() === "012");
}

// ---------------------------------------------------------------- J
{
  const S = makeSession({ csm: false });
  check("J0 single-shadow session warms the sun's map", S.frame() === "0");
  const far = makeRig(S.world, 5000, 5000);
  S.entityMap.set(9, far);
  let none = true;
  for (let f = 0; f < 6; f += 1) if (S.frame(() => { far.root.position.x += 1; }) !== "") none = false;
  check("J1 single-shadow: a walker outside the sun's frustum rasters nothing", none);
  const near = makeRig(S.world, 3, 8);
  S.entityMap.set(10, near);
  check("J2 single-shadow: a spawn inside it rasters", S.frame() === "0");
}

// ---------------------------------------------------------------- K
{
  L.__resetRp5ConfigForTest({ shadowMoverScope: false });
  const S = makeSession();
  S.frame();
  const rig = makeRig(S.world, 4000, 4000);
  rig.root.visible = false;
  S.entityMap.set(11, rig);
  S.frame();
  S.frame(() => { rig.root.position.x += 1; }); // the step lands after this tick's scan
  let all = true;
  for (let f = 0; f < 5; f += 1) if (S.frame(() => { rig.root.position.x += 1; }) !== "012") all = false;
  check("K1 =off: a hidden walker 4 km away re-renders every cascade (RP5)", all);
  check("K2 =off: per-light autoUpdate is left to three", S.lights.every((l) => l.shadow.autoUpdate === true));
  L.__resetRp5ConfigForTest(undefined);
}

// ---------------------------------------------------------------- L
{
  const read = (search) => {
    globalThis.location.search = search;
    L.__resetRp5ConfigForTest(undefined);
    const S = makeSession();
    S.frame();
    const on = S.scene3d._shadowScope != null;
    return on;
  };
  check("L1 absent ⇒ on", read("") === true);
  check("L2 off ⇒ off", read("?shadowMoverScope=off") === false);
  check("L3 0 ⇒ off", read("?shadowMoverScope=0") === false);
  check("L4 false ⇒ off", read("?shadowMoverScope=false") === false);
  check("L5 no ⇒ off", read("?shadowMoverScope=no") === false);
  check("L6 on ⇒ on", read("?shadowMoverScope=on") === true);
  globalThis.location.search = "";
  L.__resetRp5ConfigForTest(undefined);
}

console.log(`\nshadow_mover_scope: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
