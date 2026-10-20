// tests/csm_offscreen_casters.test.mjs
//
// 2026-10-20 (improvement hunt shadows-restore-8) — `?csmOffscreenCasters=on`
// (DEFAULT OFF): rigs the render cull hid only for being off the screen keep
// casting when their shadow can reach the view (lighting.js
// selectOffscreenCasters → shadowMap.__hbShadowOnlyRoots → shadow_caster_list.js
// collects the meshes below the hidden root, matrices refreshed).
//
// THE BUG. entities.js hides a culled rig's ROOT; a hidden root puts nothing in
// any shadow map, so at low sun the long shadow of a rig just off the screen
// edge vanished and popped back as the camera turned.
//
// Drives the REAL lighting tick (setupSceneLighting + tickLightingForCellState,
// csm.js stable cascades) → the ?shadowCasterList wrapper (+ ?shadowStaticCache)
// → three r184's REAL WebGLShadowMap (extracted from three.module.js) on a stub
// renderer that logs each shadow draw with the world matrix it used; the
// per-frame matrix walk runs with skip_hidden_matrix.js installed, as in the app.
//
//   O1  flag off (default): nothing stamped; the off-screen rig draws in no
//       map (the bug); its walk is a hidden move
//   O2  flag on, 15 deg sun: exactly the off-screen rig whose shadow reaches
//       the view is picked — not one behind the camera casting away, not one
//       hidden ON screen (another cull), not a state-hidden one, not a
//       film-hidden one, not an attached one
//   O3  its meshes are drawn into the cascades, at THIS frame's pose (the root
//       moved after the tick and the scene walk skipped it); the main pass
//       still sees root.visible === false
//   O4  the mover scan counts it as drawn: walking it marks cascades
//   O5  80 deg sun: not picked (its shadow stays under it, off screen)
//   O6  a root visible again by raster time is drawn once, not twice
//   O7  at most 32, nearest first
//   O8  the faded (night) sun drops the set
//   O9  flag reader: exact `on`
//
// Run:  cd apps/holtburger-web && node tests/csm_offscreen_casters.test.mjs

import * as THREE from "three";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

globalThis.window = globalThis.window || {};
globalThis.location = { search: "" };
window.location = globalThis.location;

const L = await import("../scene3d/lighting.js");
const SCL = await import("../scene3d/shadow_caster_list.js");
const { installSkipHiddenMatrix } = await import("../scene3d/skip_hidden_matrix.js");
installSkipHiddenMatrix(THREE, { force: true });

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
  console.log("csm_offscreen_casters: three.module.js layout changed — re-anchor the extraction.");
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const WebGLShadowMap = new Function("THREE", "with (THREE) {\n" + src.slice(a, b) + "\nreturn WebGLShadowMap; }")(THREE);

function makeRenderer() {
  const draws = [];
  let lights = [];
  const stub = {
    getRenderTarget: () => null,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    setRenderTarget() {},
    clear() {},
    initRenderTarget() {},
    copyTextureToTexture() {},
    getContext: () => ({ NO_ERROR: 0, getError: () => 0 }),
    domElement: { addEventListener() {} },
    state: {
      setBlending() {}, setScissorTest() {}, viewport() {},
      buffers: { depth: { getReversed: () => false, setTest() {}, setMask() {} }, color: { setClear() {} } },
    },
    renderBufferDirect(camera, scene, geometry, material, object) {
      const li = lights.findIndex((l) => l.shadow.camera === camera);
      const e = object.matrixWorld.elements;
      draws.push({ li, name: object.name, x: e[12], y: e[13], z: e[14] });
    },
  };
  const sm = new WebGLShadowMap(stub, { update: (o) => o.geometry }, { maxTextureSize: 16384 });
  sm.enabled = true;
  sm.type = THREE.PCFShadowMap;
  stub.shadowMap = sm;
  SCL.installShadowCasterList(stub, { force: true });
  return { stub, sm, draws, setLights(ls) { lights = ls; } };
}

// AC frame (+Z up) under worldRoot, exactly as index.js builds it.
const acToWorld = (x, y, z) => new THREE.Vector3(x, z, -y);
const worldToAc = (v) => ({ x: v.x, y: -v.z, z: v.y });
const rigGeom = new THREE.BoxGeometry(1, 1, 1.8);
const rigMat = new THREE.MeshStandardMaterial();
let gid = 100;

function makeSession(search, sunElevDeg = 15) {
  globalThis.location.search = search;
  L.__resetRp5ConfigForTest(undefined);
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
  const r = makeRenderer();
  const lighting = L.setupSceneLighting(scene, { csm: true });
  const lights = lighting.csmState.lights;
  r.setLights(lights);
  const entityMap = new Map();
  // Toward the sun: from three +X, `sunElevDeg` up — shadows fall toward -X.
  const e = (sunElevDeg * Math.PI) / 180;
  const sunDirection = new THREE.Vector3(Math.cos(e), Math.sin(e), 0);
  const scene3d = {
    renderer: r.stub,
    lighting,
    camera,
    scene,
    entitiesGroup,
    entityManager: { entityMap },
    atmosphereLights: { sun: { sunDirection } },
  };
  function rig(worldPos, flags = {}) {
    const root = new THREE.Group();
    const ac = worldToAc(worldPos);
    root.position.set(ac.x, ac.y, ac.z);
    const m = new THREE.Mesh(rigGeom, rigMat);
    m.name = `rigmesh${gid}`;
    m.castShadow = true;
    m.position.set(0, 0, 0.9);
    root.add(m);
    entitiesGroup.add(root);
    const inst = { guid: gid, root, _stateVisible: true, _renderCullHidden: false, ...flags };
    root.visible = inst._stateVisible !== false && !inst._renderCullHidden && !inst._filmHidden;
    entityMap.set(gid, inst);
    gid += 1;
    return { inst, root, mesh: m };
  }
  function frame(move) {
    L.tickLightingForCellState(scene3d, null);
    if (move) move(); // entityManager.tick runs after the lighting tick
    scene.updateMatrixWorld(); // renderer.render's walk (skips hidden roots)
    r.draws.length = 0;
    r.sm.render(lights, scene, camera);
    return r.draws.slice();
  }
  return { scene, camera, lighting, lights, scene3d, entityMap, rig, frame, sm: r.sm, sunDirection };
}
const scope = (S) => S.scene3d._shadowScope;

// Rig placements (three world, camera at the origin looking down -Z).
// Off screen right (its 6 m cull sphere is ~8 m outside the right plane); at a
// 15 deg sun its shadow reaches into view, with the 6 m default height and
// with the ~2.9 m radius the mover scan measures once it casts.
const OFF_RIGHT = new THREE.Vector3(22, 0, -10);
const BEHIND = new THREE.Vector3(0, 0, 30);       // behind the camera; shadow falls behind too
const ON_SCREEN = new THREE.Vector3(0, 0, -20);   // in view but hidden (occlusion / cell gate)

// ---------------------------------------------------------------------------- O1
console.log("\n-- O1 flag off: the bug ------------------------------------------------");
{
  const S = makeSession("");
  const A = S.rig(OFF_RIGHT, { _renderCullHidden: true });
  S.frame();
  const d = [...S.frame(() => { A.root.position.x += 0.5; }), ...S.frame(), ...S.frame()];
  check("O1 nothing stamped", S.sm.__hbShadowOnlyRoots === undefined);
  check("O1 the off-screen rig draws in no cascade (bug trigger)", !d.some((x) => x.name === A.mesh.name));
  check("O1 its walk is a hidden move", S.scene3d._shadowMovers.stats.hiddenMoves >= 1);
}

// ---------------------------------------------------------------------------- O2/O3
console.log("\n-- O2/O3 flag on, 15 deg sun ----------------------------------------");
{
  const S = makeSession("?csmOffscreenCasters=on");
  const A = S.rig(OFF_RIGHT, { _renderCullHidden: true });
  const B = S.rig(BEHIND, { _renderCullHidden: true });
  const C = S.rig(ON_SCREEN, { _renderCullHidden: true });
  const D = S.rig(new THREE.Vector3(32, 0, -12), { _renderCullHidden: true, _stateVisible: false });
  const E = S.rig(new THREE.Vector3(28, 0, -8), { _renderCullHidden: true, _filmHidden: true });
  const F = S.rig(new THREE.Vector3(31, 0, -9), { _renderCullHidden: true, _attachedParentGuid: 5 });
  const V = S.rig(new THREE.Vector3(2, 0, -15)); // visible, on screen
  S.frame();
  const roots = S.sm.__hbShadowOnlyRoots;
  check("O2 stamped on the shadow map", Array.isArray(roots) && roots === scope(S).offscreen.roots);
  check("O2 picks exactly the off-screen rig whose shadow reaches the view", roots.length === 1 && roots[0] === A.root,
    `picked ${roots.map((r) => [A, B, C, D, E, F, V].findIndex((x) => x.root === r)).join(",")}`);
  check("O2 stats", scope(S).stats.offscreenCasters === 1);
  // O3 — move the hidden root AFTER the tick (entity tick), then raster. The
  // scan sees a move one tick later (it runs before the entity tick), so the
  // second step's frame rasters — at that frame's pose.
  S.frame(() => { A.root.position.y += 1.5; }); // AC +Y = three -Z
  const d = S.frame(() => { A.root.position.y += 0.5; });
  const want = A.mesh.getWorldPosition(new THREE.Vector3()); // on-demand: this frame's pose
  const mine = d.filter((x) => x.name === A.mesh.name);
  check("O3 its mesh is drawn into the cascades", mine.length >= 1, `cascades ${[...new Set(mine.map((x) => x.li))].join("")}`);
  check("O3 at this frame's pose (matrices refreshed past ?skipHiddenMatrix)",
    mine.length >= 1 && mine.every((x) => Math.abs(x.x - want.x) < 1e-6 && Math.abs(x.y - want.y) < 1e-6 && Math.abs(x.z - want.z) < 1e-6),
    `drawn z=${mine[0] && mine[0].z.toFixed(3)} want ${want.z.toFixed(3)}`);
  check("O3 the main pass still sees it hidden", A.root.visible === false);
  {
    // Premise: the scene walk alone leaves a hidden rig's matrices stale, so
    // the refresh in collectShadowOnly is what put it at this frame's pose.
    const z0 = A.mesh.matrixWorld.elements[14];
    A.root.position.y += 2;
    S.scene.updateMatrixWorld();
    check("O3 premise: ?skipHiddenMatrix's walk does not move a hidden rig's mesh", A.mesh.matrixWorld.elements[14] === z0);
    A.root.position.y -= 2;
  }
  check("O3 nobody else: B / C / D / E / F never drawn", ![B, C, D, E, F].some((r) => d.some((x) => x.name === r.mesh.name)));
  check("O3 shadow_caster_list counted it", SCL.getShadowCasterListStats().lastShadowOnly === 1);

  // ------------------------------------------------------------------------ O4
  console.log("\n-- O4 mover scan ---------------------------------------------------------");
  S.frame();
  const mt0 = scope(S).stats.moverTicks;
  const hm0 = S.scene3d._shadowMovers.stats.hiddenMoves;
  S.frame(() => { A.root.position.x += 0.4; });
  S.frame(() => { A.root.position.x += 0.4; });
  check("O4 walking it marks cascades (mover ticks), not a hidden move",
    scope(S).stats.moverTicks > mt0 && S.scene3d._shadowMovers.stats.hiddenMoves === hm0,
    `moverTicks ${mt0}→${scope(S).stats.moverTicks}, hiddenMoves ${hm0}→${S.scene3d._shadowMovers.stats.hiddenMoves}`);

  // ------------------------------------------------------------------------ O6
  console.log("\n-- O6 visible again by raster time -------------------------------------");
  L.tickLightingForCellState(S.scene3d, null); // still picked this tick
  A.inst._renderCullHidden = false;
  A.root.visible = true; // the cull showed it before the raster
  S.scene.updateMatrixWorld();
  const draws = [];
  const prev = S.scene3d.renderer.renderBufferDirect;
  S.scene3d.renderer.renderBufferDirect = function (cam, sc, g, m, o) { draws.push(o.name); };
  S.sm.needsUpdate = true;
  for (const l of S.lights) l.shadow.needsUpdate = true;
  S.sm.render(S.lights, S.scene, S.camera);
  S.scene3d.renderer.renderBufferDirect = prev;
  const per = draws.filter((n) => n === A.mesh.name).length;
  check("O6 drawn once per cascade it reaches, never twice", per >= 1 && per <= 3 && SCL.getShadowCasterListStats().lastShadowOnly === 0, `draws ${per}`);

  // ------------------------------------------------------------------------ O8
  console.log("\n-- O8 faded sun ------------------------------------------------------------");
  A.inst._renderCullHidden = true;
  A.root.visible = false;
  S.frame();
  check("O8 picked by day", scope(S).offscreen.roots.length === 1);
  S.lighting.csmState.strength = 0; // what the night block sets (csmSunFade)
  // tickLightingForCellState recomputes strength from the sky; no sky here ⇒ 1.
  // Drive the gate's faded branch through a sky pitch below the horizon instead.
  S.scene3d.atmosphereSky = { _artPitchDeg: -5 };
  S.frame();
  check("O8 night: the set is dropped", scope(S).offscreen.roots.length === 0 && scope(S).stats.fadedTicks >= 1);
}

// ---------------------------------------------------------------------------- O5
console.log("\n-- O5 80 deg sun ----------------------------------------------------------");
{
  const S = makeSession("?csmOffscreenCasters=on", 80);
  S.rig(OFF_RIGHT, { _renderCullHidden: true });
  S.frame();
  check("O5 high sun: its shadow stays off screen — not picked", S.sm.__hbShadowOnlyRoots.length === 0);
}

// ---------------------------------------------------------------------------- O7
console.log("\n-- O7 cap: 32 nearest -------------------------------------------------------");
{
  const S = makeSession("?csmOffscreenCasters=on");
  const rigs = [];
  for (let i = 0; i < 40; i += 1) rigs.push(S.rig(new THREE.Vector3(30 + i * 0.5, 0, -10 - (i % 3)), { _renderCullHidden: true }));
  S.frame();
  const roots = S.sm.__hbShadowOnlyRoots;
  const camPos = S.camera.getWorldPosition(new THREE.Vector3());
  const d2 = (r) => r.root.getWorldPosition(new THREE.Vector3()).distanceToSquared(camPos);
  const picked = new Set(roots);
  const maxPicked = Math.max(...rigs.filter((r) => picked.has(r.root)).map(d2));
  const minLeft = Math.min(...rigs.filter((r) => !picked.has(r.root)).map(d2));
  check("O7 32 picked", roots.length === 32, String(roots.length));
  check("O7 the nearest ones", maxPicked <= minLeft + 60, `${maxPicked.toFixed(1)} vs ${minLeft.toFixed(1)}`);
}

// ---------------------------------------------------------------------------- O9
console.log("\n-- O9 flag reader -----------------------------------------------------------");
{
  const read = (s) => {
    const S = makeSession(s);
    S.rig(OFF_RIGHT, { _renderCullHidden: true });
    S.frame();
    return S.sm.__hbShadowOnlyRoots !== undefined;
  };
  check("O9 absent ⇒ off", read("") === false);
  check("O9 on / ON ⇒ on", read("?csmOffscreenCasters=on") === true && read("?csmOffscreenCasters=ON") === true);
  check("O9 1 / true ⇒ off (exact opt-in)", read("?csmOffscreenCasters=1") === false && read("?csmOffscreenCasters=true") === false);
}

globalThis.location.search = "";
L.__resetRp5ConfigForTest(undefined);
console.log(`\ncsm_offscreen_casters: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
