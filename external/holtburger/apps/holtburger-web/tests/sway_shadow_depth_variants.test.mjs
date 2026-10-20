// tests/sway_shadow_depth_variants.test.mjs
//
// 2026-10-20 (improvement hunt open-frontier-perf-6) — scene3d/sway_shadow.js
// used ONE MeshDepthMaterial as `customDepthMaterial` for every swaying caster.
// three r184 then skips its per-source depth-variant cache and writes each
// caster's map / alphaTest onto that one object per draw, but setProgram only
// refreshes material uniforms when the program or material.id changes — so a
// cut-out leaf drawn right after another cut-out leaf alpha-tested its shadow
// against the PREVIOUS leaf's map and alphaTest ref, and every trunk <-> leaf
// alternation crossed alphaTest over 0 (version bump -> program re-resolve).
// Now each alpha-tested caster material gets its own sway depth material and
// the rest share one.
//
//   S1  routing: opaque sway casters share one depth material (the no-arg
//       `swayDepthMaterial()`), each alpha-tested caster material gets its own,
//       stable across calls; non-sway casters are left to three.
//   S2  every depth material carries the windSwayGpu shear, the same program
//       key, the shared VFX clock BY REFERENCE, and one property order.
//   S3  real three r184 WebGLRenderer + WebGLShadowMap over the fake WebGL2
//       context, three consecutive sway casters (leaf A, leaf B, trunk):
//       - NEGATIVE CONTROL (the shipped single shared material): leaf B's
//         shadow draw still sees texture A + alphaTest 0.5, and the shared
//         material's version moves every frame;
//       - NEW: each leaf's draw binds its OWN map and alphaTest ref, no depth
//         material's version moves across a frame, and the leaves still link
//         ONE cut-out program between them (no program growth).
//   S4  disposing a caster material drops + disposes its depth material
//       (three's onMaterialDispose), the shared one is untouched.
//
// Run: node tests/sway_shadow_depth_variants.test.mjs

import * as THREE from "three";
import { createFakeWebGL2, fakeCanvas } from "./helpers/fake_webgl2.mjs";
import {
  applySwayShadow,
  swayDepthMaterial,
  swayShadowStats,
  isSwayMaterial,
} from "../scene3d/sway_shadow.js";
import { windSwayGpu } from "../scene3d/vfx/components/windSwayGpu.js";
import { VFX_GLOBALS } from "../scene3d/materials.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

const SWAY_UD = () => ({ __vfxSetKey: "deformation.windSwayGpu", __cacheOwned: true });
const mkTex = (v) => {
  const t = new THREE.DataTexture(new Uint8Array([v, v, v, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
};
function swayMat(map, alphaTest) {
  const m = new THREE.MeshStandardMaterial({ map, alphaTest, side: THREE.DoubleSide });
  m.userData = SWAY_UD();
  return m;
}

// ---------------------------------------------------------------------------
console.log("\n-- S1 routing ---------------------------------------------------");
const texA = mkTex(10), texB = mkTex(200), texC = mkTex(90);
const leafMatA = swayMat(texA, 0.5);
const leafMatB = swayMat(texB, 0.3);
const trunkMat = swayMat(texC, 0);
const bareMat = swayMat(null, 0);
{
  check("sway materials recognised", [leafMatA, leafMatB, trunkMat, bareMat].every(isSwayMaterial));
  const shared = swayDepthMaterial();
  check("opaque (alphaTest 0) casters -> the one shared depth material",
    swayDepthMaterial(trunkMat) === shared && swayDepthMaterial(bareMat) === shared);
  const dA = swayDepthMaterial(leafMatA), dB = swayDepthMaterial(leafMatB);
  check("each alpha-tested caster material -> its own depth material",
    dA !== shared && dB !== shared && dA !== dB);
  check("…stable across calls (keyed by the caster material)",
    swayDepthMaterial(leafMatA) === dA && swayDepthMaterial(leafMatB) === dB);
  check("alphaToCoverage also gets its own (three writes alphaTest 0.5 for it)", (() => {
    const m = swayMat(texA, 0); m.alphaToCoverage = true;
    return swayDepthMaterial(m) !== shared;
  })());
  const plain = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ map: texA, alphaTest: 0.5 }));
  check("a non-sway caster keeps three's own depth path", applySwayShadow(plain) === false && plain.customDepthMaterial === undefined);
  const st = swayShadowStats();
  check("stats count live / built cut-out depth materials", st.cutLive >= 2 && st.cutBuilt >= 2 && st.built === true,
    JSON.stringify(st));
}

// ---------------------------------------------------------------------------
console.log("\n-- S2 every depth material carries the sway patch ---------------");
{
  const mats = [swayDepthMaterial(), swayDepthMaterial(leafMatA), swayDepthMaterial(leafMatB)];
  for (const [i, dm] of mats.entries()) {
    const stub = {
      uniforms: {},
      vertexShader: "#include <common>\nvoid main() {\n#include <begin_vertex>\n#include <project_vertex>\n}",
      fragmentShader: "#include <common>\nvoid main() {\n}",
    };
    dm.onBeforeCompile(stub);
    check(`depth material ${i} (${dm.name}): windSwayGpu shear + uniforms`,
      stub.vertexShader.includes("VFX_WINDSWAY_BEGIN") && !!stub.uniforms.uWindAmp);
    check(`depth material ${i}: uTime IS the shared VFX clock (by reference)`, stub.uniforms.uTime === VFX_GLOBALS.uTime);
    check(`depth material ${i}: program key hb-sway-shadow-depth`, dm.customProgramCacheKey() === "hb-sway-shadow-depth");
  }
  check("one property order for all (never Object.create / .clone())",
    new Set(mats.map((m) => Object.keys(m).join(","))).size === 1 && mats.every((m) => Object.getPrototypeOf(m) === THREE.MeshDepthMaterial.prototype));
}

// ---------------------------------------------------------------------------
console.log("\n-- S3 real r184 shadow pass over fake WebGL2 ---------------------");
const gl = createFakeWebGL2();
const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
renderer.shadowMap.enabled = true;
const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
cam.position.set(0, 5, 10);
cam.lookAt(0, 0, 0);

function buildScene(depthFor) {
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(5, 10, 5);
  sun.castShadow = true;
  scene.add(sun);
  const casters = {};
  // Graph order = shadow draw order: leaf A, leaf B, trunk (consecutive leaves).
  for (const [name, mat, x] of [["leafA", leafMatA, -1], ["leafB", leafMatB, 0], ["trunk", trunkMat, 1]]) {
    const me = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    me.position.x = x;
    me.castShadow = true;
    me.receiveShadow = true;
    depthFor(me);
    scene.add(me);
    casters[name] = me;
  }
  return { scene, casters };
}

/** One frame; returns a per-shadow-draw log with the snapshot of what the draw saw. */
function frame(scene, casters, depthSet) {
  const log = [];
  const nameOf = (o) => Object.keys(casters).find((k) => casters[k] === o);
  const orig = renderer.renderBufferDirect;
  renderer.renderBufferDirect = function (camera, sc, geom, mat, obj, grp) {
    if (!depthSet.has(mat)) return orig.call(this, camera, sc, geom, mat, obj, grp);
    gl.__fake.startSnapshots();
    const r = orig.call(this, camera, sc, geom, mat, obj, grp);
    const snaps = gl.__fake.takeSnapshots() || [];
    log.push({ caster: nameOf(obj), mat, snap: snaps[snaps.length - 1] || null, program: renderer.properties.get(mat).currentProgram });
    return r;
  };
  try { renderer.render(scene, cam); } finally { renderer.renderBufferDirect = orig; }
  return log;
}
const glTexId = (t) => `tex#${renderer.properties.get(t).__webglTexture.__id}`;

// --- negative control: the shipped arrangement (one shared depth material) ---
{
  const old = new THREE.MeshDepthMaterial();
  old.name = "sway-shadow-depth (pre-change, shared)";
  old.onBeforeCompile = (shader) => {
    windSwayGpu.declareUniforms(shader, windSwayGpu.defaults, VFX_GLOBALS);
    windSwayGpu.inject(shader);
  };
  old.customProgramCacheKey = () => "hb-sway-shadow-depth";
  const { scene, casters } = buildScene((me) => { me.customDepthMaterial = old; });
  frame(scene, casters, new Set([old])); // warm: compile + upload
  const v0 = old.version;
  const log = frame(scene, casters, new Set([old]));
  const b = log.find((e) => e.caster === "leafB");
  check("control: leaf B's shadow draw happened right after leaf A's",
    log.length >= 3 && log[0].caster === "leafA" && log[1].caster === "leafB", log.map((e) => e.caster).join(","));
  check("control (bug): leaf B alpha-tests against texture A, not its own B",
    b?.snap?.uniforms?.map === glTexId(texA) && b?.snap?.uniforms?.map !== glTexId(texB),
    `map=${b?.snap?.uniforms?.map} A=${glTexId(texA)} B=${glTexId(texB)}`);
  check("control (bug): leaf B's alphaTest ref is leaf A's 0.5, not its own 0.3",
    b?.snap?.uniforms?.alphaTest === 0.5, String(b?.snap?.uniforms?.alphaTest));
  check("control (churn): the shared material's version moves every frame", old.version > v0, `${v0} -> ${old.version}`);
  old.dispose();
}

// --- the change: per-caster-material depth materials ---
{
  const { scene, casters } = buildScene((me) => applySwayShadow(me));
  const dA = casters.leafA.customDepthMaterial, dB = casters.leafB.customDepthMaterial, dT = casters.trunk.customDepthMaterial;
  check("applySwayShadow routed leaf A / leaf B / trunk to own / own / shared",
    dA === swayDepthMaterial(leafMatA) && dB === swayDepthMaterial(leafMatB) && dT === swayDepthMaterial());
  const depthSet = new Set([dA, dB, dT]);
  frame(scene, casters, depthSet); // warm
  const ver = [dA.version, dB.version, dT.version];
  const log = frame(scene, casters, depthSet);
  const byName = (n) => log.filter((e) => e.caster === n);
  check("all three casters drew shadows, leaves consecutively",
    log.length >= 3 && log[0].caster === "leafA" && log[1].caster === "leafB", log.map((e) => e.caster).join(","));
  check("leaf A's draw binds texture A + alphaTest 0.5",
    byName("leafA").every((e) => e.snap?.uniforms?.map === glTexId(texA) && e.snap?.uniforms?.alphaTest === 0.5));
  check("leaf B's draw binds ITS OWN texture B + alphaTest 0.3 (the fix)",
    byName("leafB").length > 0 && byName("leafB").every((e) => e.snap?.uniforms?.map === glTexId(texB) && Math.abs(e.snap?.uniforms?.alphaTest - 0.3) < 1e-6),
    byName("leafB").map((e) => `${e.snap?.uniforms?.map}/${e.snap?.uniforms?.alphaTest}`).join(" "));
  check("trunk draws with no alpha test (opaque program)", byName("trunk").every((e) => e.snap && !("alphaTest" in e.snap.uniforms)));
  check("no depth material's version moved across the frame (no alphaTest 0-crossing)",
    dA.version === ver[0] && dB.version === ver[1] && dT.version === ver[2], `${ver} -> ${[dA.version, dB.version, dT.version]}`);
  const progA = byName("leafA")[0]?.program, progB = byName("leafB")[0]?.program, progT = byName("trunk")[0]?.program;
  check("the two leaves link ONE cut-out program between them (no program growth)", !!progA && progA === progB);
  check("…and the trunk its opaque one", !!progT && progT !== progA);
  const live = renderer.properties.get(dA).uniforms;
  check("per-caster depth material binds the shared VFX clock by reference", live?.uTime === VFX_GLOBALS.uTime);
  check("each draw ran the sway shear (uWindAmp is a live uniform)", log.every((e) => e.snap && "uWindAmp" in e.snap.uniforms));
}

// ---------------------------------------------------------------------------
console.log("\n-- S4 dispose ---------------------------------------------------");
{
  const dA = swayDepthMaterial(leafMatA);
  const shared = swayDepthMaterial();
  let disposed = 0;
  dA.addEventListener("dispose", () => { disposed += 1; });
  const before = swayShadowStats().cutLive;
  leafMatA.dispose();
  check("caster material dispose -> its depth material is disposed once", disposed === 1);
  check("…and dropped (live count down by one)", swayShadowStats().cutLive === before - 1);
  check("…a later lookup builds a fresh one; the shared one is untouched",
    swayDepthMaterial(leafMatA) !== dA && swayDepthMaterial() === shared);
}

renderer.dispose();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
