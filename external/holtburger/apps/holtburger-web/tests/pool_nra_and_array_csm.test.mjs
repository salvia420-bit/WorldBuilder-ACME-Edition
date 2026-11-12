// tests/pool_nra_and_array_csm.test.mjs
//
// Verification of:
// 1. Array/Pool CSM Receiver Patches:
//    - makeArrayMaterial (static_atlas.js) installs CSM receiver hook and appends |c2 to cache key
//    - ClassMaterialRegistry (pool_material.js) passes csmState to makeArrayMaterial and preserves
//      customProgramCacheKey composition with baked direct lighting (|k1s, |c2)
// 2. Async NRA Maps (_nraPending):
//    - ClassMaterialRegistry.admit enqueues materials with missing roughness/AO maps into _nraPending
//    - drainNraPending() repacks and uploads layers once async .texchan.bin maps attach
//    - Census accurately reports nraPending count
//    - Expired tries (>600) and unowned layers are dropped cleanly without exceptions

import * as THREE from "three";
import { setupCsm } from "../scene3d/csm.js";
import { makeArrayMaterial, buildDiffuseArray, buildNraArray } from "../scene3d/static_atlas.js";
import { ClassMaterialRegistry, drainPoolNraPending } from "../scene3d/pool_material.js";

globalThis.window = globalThis.window || {};
globalThis.location = { search: "" };
window.location = globalThis.location;

let passed = 0;
let failed = 0;

function check(label, cond, extra = "") {
  if (cond) {
    passed += 1;
    console.log(`  [OK] ${label}`);
  } else {
    failed += 1;
    console.error(`  [FAIL] ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

function compile(mat) {
  const lib = THREE.ShaderLib.standard;
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
    defines: {},
  };
  if (typeof mat.onBeforeCompile === "function") {
    mat.onBeforeCompile(shader, null);
  }
  return shader;
}

console.log("Pool & Array CSM Receiver Patches & Async NRA Tests");

// Dummy textures for testing
function makeDummyTex(w = 256, h = 256) {
  const tex = new THREE.DataTexture(new Uint8Array(w * h * 4).fill(128), w, h, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

const scene = new THREE.Scene();
const csm = setupCsm(scene, {
  splits: [30, 100, 300],
  stable: true,
  sunDir: { x: 30, y: 80, z: 20 },
});

// ===========================================================================
// 1. makeArrayMaterial with and without CSM
// ===========================================================================
{
  const diffArray = buildDiffuseArray([], 256, 256, 2);
  const nraArray = buildNraArray(256, 256, 2);
  const arrays = { diff: diffArray, nra: nraArray, csmState: csm };

  // 1A. With explicit csmState
  const matCsm = makeArrayMaterial(diffArray, "256x256|r|c|m|c", nraArray, arrays, csm);
  check("makeArrayMaterial with CSM has userData.csmEnabled", matCsm.userData?.csmEnabled === true);

  const keyCsm = typeof matCsm.customProgramCacheKey === "function" ? matCsm.customProgramCacheKey() : "";
  check("makeArrayMaterial with CSM customProgramCacheKey ends with |c2", keyCsm.includes("|c2"), keyCsm);

  const compiledCsm = compile(matCsm);
  check(
    "makeArrayMaterial with CSM binds uCsmShadowMap0 uniform by reference",
    compiledCsm.uniforms.uCsmShadowMap0 === csm.uniforms.uCsmShadowMap0
  );
  check(
    "makeArrayMaterial with CSM fragment shader includes CSM receiver code",
    compiledCsm.fragmentShader.includes("uCsmShadowMap") || compiledCsm.fragmentShader.includes("uCsmMatrix")
  );

  // 1B. Without CSM (negative control)
  const arraysNoCsm = { diff: diffArray, nra: nraArray };
  const matNoCsm = makeArrayMaterial(diffArray, "256x256|r|c|m|c", nraArray, arraysNoCsm, null);
  const keyNoCsm = typeof matNoCsm.customProgramCacheKey === "function" ? matNoCsm.customProgramCacheKey() : "";
  check("makeArrayMaterial without CSM does not have userData.csmEnabled", !matNoCsm.userData?.csmEnabled);
  check("makeArrayMaterial without CSM does not carry |c2 in key", !keyNoCsm.includes("|c2"), keyNoCsm);
}

// ===========================================================================
// 2. ClassMaterialRegistry with CSM and Baked Direct Lighting
// ===========================================================================
{
  const reg = new ClassMaterialRegistry({ csmState: csm, warn: () => {} });
  const tex = makeDummyTex(256, 256);
  const member = new THREE.MeshStandardMaterial({ map: tex });

  // Regular surface
  const classEntry = reg._classOf("ec|test-csm", 256, 256, false, member);
  const classMat = classEntry && classEntry.material;
  check("ClassMaterialRegistry._classOf produces class material", !!classMat);
  check("Class material has userData.csmEnabled === true", classMat.userData?.csmEnabled === true);

  const classKey = typeof classMat.customProgramCacheKey === "function" ? classMat.customProgramCacheKey() : "";
  check("Class material customProgramCacheKey contains |c2", classKey.includes("|c2"), classKey);

  const compiledClass = compile(classMat);
  check(
    "Class material binds uCsmMatrix0 from shared uniforms",
    compiledClass.uniforms.uCsmMatrix0 === csm.uniforms.uCsmMatrix0
  );

  // Baked direct lighting surface (__acBakedLight === true)
  const bakedMember = new THREE.MeshStandardMaterial({ map: tex });
  bakedMember.userData = { __acBakedLight: true };
  const bakedClassEntry = reg._classOf("ec|test-baked-csm", 256, 256, false, bakedMember);
  const bakedMat = bakedClassEntry && bakedClassEntry.material;

  const bakedKey = typeof bakedMat.customProgramCacheKey === "function" ? bakedMat.customProgramCacheKey() : "";
  check("Baked class material key composes both |k1s and |c2", bakedKey.includes("|k1s") && bakedKey.includes("|c2"), bakedKey);
}

// ===========================================================================
// 3. Async NRA Maps and _nraPending Lifecycle
// ===========================================================================
{
  const reg = new ClassMaterialRegistry({ csmState: csm, warn: () => {} });
  const tex = makeDummyTex(256, 256);

  // Member material without roughnessMap or aoMap/height
  const member = new THREE.MeshStandardMaterial({
    map: tex,
    roughness: 0.8,
    metalness: 0.1,
  });

  const rec = { texW: 256, texH: 256 };
  const admitRes = reg.admit("256x256|r|c|m|c", member, rec);
  check("admit member with missing async maps succeeds", admitRes.ok === true && Number.isInteger(admitRes.layer));
  check("member is enqueued in _nraPending", reg._nraPending.length === 1);
  check("census reports nraPending === 1", reg.census().nraPending === 1);

  // Drain before maps arrive: should not repack yet
  const repackedBefore = reg.drainNraPending();
  check("drainNraPending returns 0 when maps not yet arrived", repackedBefore === 0);
  check("member remains in _nraPending", reg._nraPending.length === 1);

  // Simulate async arrival of roughness and AO maps (.texchan.bin loaded)
  member.roughnessMap = makeDummyTex(256, 256);
  member.aoMap = makeDummyTex(256, 256);

  const repackedAfter = reg.drainNraPending();
  check("drainNraPending repacks layer once maps arrive", repackedAfter === 1);
  check("stats.nraRepacks incremented", reg.stats.nraRepacks >= 1);
  check("_nraPending drained completely", reg._nraPending.length === 0);
  check("census reports nraPending === 0", reg.census().nraPending === 0);

  // Helper export drainPoolNraPending
  member.roughnessMap = null;
  reg._nraPending.push({ c: reg.classes.get("256x256|r|c|m|c"), layer: admitRes.layer, mat: member, tries: 0 });
  member.roughnessMap = makeDummyTex(256, 256);
  const drainedViaHelper = drainPoolNraPending(reg);
  check("drainPoolNraPending helper functions correctly", drainedViaHelper === 1);
}

// ===========================================================================
// 4. _nraPending Expiry & Unowned Layer Cleanup
// ===========================================================================
{
  const reg = new ClassMaterialRegistry({ warn: () => {} });
  const tex = makeDummyTex(256, 256);
  const member = new THREE.MeshStandardMaterial({ map: tex });

  const rec = { texW: 256, texH: 256 };
  reg.admit("256x256|r|c|m|c", member, rec);
  check("admitted second member", reg._nraPending.length === 1);

  // Simulate expiry (> 600 tries without maps attaching)
  reg._nraPending[0].tries = 601;
  const repackedExpired = reg.drainNraPending();
  check("expired pending entry does not crash and repacks 0", repackedExpired === 0);
  check("stats.nraPendingDropped incremented", reg.stats.nraPendingDropped === 1);
  check("_nraPending cleaned after expiry", reg._nraPending.length === 0);

  // Simulate release before drain
  const tex3 = makeDummyTex(256, 256);
  const member3 = new THREE.MeshStandardMaterial({ map: tex3 });
  reg.admit("256x256|r|c|m|c", member3, rec);
  check("admitted third member", reg._nraPending.length === 1);

  // Release the texture
  reg.release("256x256|r|c|m|c", tex3.uuid);
  const repackedReleased = reg.drainNraPending();
  check("released texture pruned from _nraPending without error", repackedReleased === 0);
  check("_nraPending is empty after release cleanup", reg._nraPending.length === 0);

  reg.dispose();
  check("registry dispose empties _nraPending", reg._nraPending.length === 0);
}

console.log(`\nPool & Array CSM & NRA: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
