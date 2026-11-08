// tests/clone_pom_persistence.test.mjs
// Milestone 1 Feature 1: Cloned Material POM Persistence Test Suite

import assert from "node:assert/strict";
import * as THREE from "three";
import {
  MaterialCache,
  SURFACE_TYPE,
  SURFACE_CATEGORY,
  _reinstallClonePom,
  heightTexForMaterial,
} from "../scene3d/materials.js";
import { setupCsm } from "../scene3d/csm.js";
import { batchedMaterialFor } from "../scene3d/batched_material_variant.js";

function compile(mat) {
  const lib = THREE.ShaderLib.standard;
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
    defines: {},
  };
  mat.onBeforeCompile(shader, null);
  return shader;
}

const tex = new THREE.DataTexture(new Uint8Array([200, 150, 100, 255]), 1, 1);
const nrm = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
const hgt = new THREE.DataTexture(new Uint8Array([200]), 1, 1);
hgt.name = "test-height";

console.log("Starting Cloned Material POM Persistence Tests...");

// 1. Negative Test: POM disabled on cache
{
  const mc = new MaterialCache({ pomEnabled: false });
  const base = mc._materialFromFlags(SURFACE_TYPE.Base1Image, tex, SURFACE_CATEGORY.Stone, nrm, undefined, hgt);
  const did = 0x08002001;
  mc.materials.set(did, base);
  const fb = mc.getCachedFloorBias(did);
  assert.equal(fb.userData?.pomEnabled, undefined, "pomEnabled undefined when cache disabled");
  assert.match(fb.customProgramCacheKey(), /\|p0\|/, "Cache key has |p0|");
  const sh = compile(fb);
  assert.equal("uPomMap" in sh.uniforms, false, "uPomMap not in uniforms");
  assert.equal(sh.fragmentShader.includes("_pomPerturbedUv"), false, "No POM GLSL");
  console.log("  [OK] Negative: pomEnabled=false produces no POM");
}

// 2. Positive Test: All 3 primary clone families retain POM
{
  const mc = new MaterialCache({ pomEnabled: true, pomOpts: { steps: 20, depth: 0.1 } });
  const base = mc._materialFromFlags(SURFACE_TYPE.Base1Image, tex, SURFACE_CATEGORY.Stone, nrm, undefined, hgt);
  const did = 0x08002002;
  mc.materials.set(did, base);

  // Floor bias (buildings.js shell path)
  const fb = mc.getCachedFloorBias(did);
  assert.equal(fb.userData.pomEnabled, true, "Floor bias pomEnabled true");
  assert.equal(fb.userData.pomUniforms.steps, 20, "Uniform steps match");
  assert.equal(fb.userData.pomUniforms.depth, 0.1, "Uniform depth match");
  assert.match(fb.customProgramCacheKey(), /\|p1\|/, "Key has |p1|");
  assert.match(fb.customProgramCacheKey(), /\|f1\|/, "Key has |f1| floor bias");
  const shFb = compile(fb);
  assert.equal(shFb.uniforms.uPomMap.value, hgt, "uPomMap bound to height texture");
  assert.equal(shFb.uniforms.uPomSteps.value, 20, "uPomSteps bound");
  assert.ok(shFb.fragmentShader.includes("_pomPerturbedUv"), "POM UV perturbation present");
  assert.ok(shFb.fragmentShader.includes("gl_FragDepth -= 2.0e-4;"), "Floor depth bias preserved");
  assert.equal(fb.userData.pomShaderUniforms, shFb.uniforms, "Live handle pomShaderUniforms populated");
  console.log("  [OK] Positive: getCachedFloorBias has functional POM + floor bias");

  // Cell baked (cells.js environment structure path)
  const cb = mc.getCachedCellBaked(did);
  assert.equal(cb.userData.pomEnabled, true, "Cell baked pomEnabled true");
  assert.match(cb.customProgramCacheKey(), /\|p1\|/, "Key has |p1|");
  assert.match(cb.customProgramCacheKey(), /\|k1/, "Key has |k1 baked light");
  const shCb = compile(cb);
  assert.ok(shCb.fragmentShader.includes("_pomPerturbedUv"), "Cell baked has POM UV");
  assert.ok(shCb.vertexShader.includes("acBakedLight"), "Cell baked has vertex light attribute");
  console.log("  [OK] Positive: getCachedCellBaked has functional POM + baked light");

  // Static bias (cells.js décor prop path)
  const sb = mc.getCachedStaticBias(did);
  assert.equal(sb.userData.pomEnabled, true, "Static bias pomEnabled true");
  assert.match(sb.customProgramCacheKey(), /\|p1\|/, "Key has |p1|");
  assert.match(sb.customProgramCacheKey(), /\|s1\|/, "Key has |s1 static bias");
  const shSb = compile(sb);
  assert.ok(shSb.fragmentShader.includes("_pomPerturbedUv"), "Static bias has POM UV");
  assert.ok(shSb.fragmentShader.includes("gl_FragDepth -= 4.0e-4;"), "Static depth bias preserved");
  console.log("  [OK] Positive: getCachedStaticBias has functional POM + static bias");
}

// 3. CSM + POM Coexistence (?csm=on)
{
  const scene = new THREE.Scene();
  const csmState = setupCsm(scene, { sunDir: { x: 60, y: 80, z: 30 } });
  const mc = new MaterialCache({ pomEnabled: true, csmState });
  const base = mc._materialFromFlags(SURFACE_TYPE.Base1Image, tex, SURFACE_CATEGORY.Stone, nrm, undefined, hgt);
  const did = 0x08002003;
  mc.materials.set(did, base);

  const fb = mc.getCachedFloorBias(did);
  assert.match(fb.customProgramCacheKey(), /\|c2\|/, "Key has |c2|");
  assert.match(fb.customProgramCacheKey(), /\|p1\|/, "Key has |p1|");
  const sh = compile(fb);
  assert.ok(sh.vertexShader.includes("vCsmWorldPos"), "CSM vertex position present");
  assert.ok(sh.fragmentShader.includes("_pomPerturbedUv"), "POM UV perturbation present");
  assert.ok(sh.fragmentShader.includes("_csmShadowFactor"), "CSM shadow factor present");
  assert.equal(sh.uniforms.uPomMap.value, hgt, "POM map bound");
  assert.ok("uCsmShadowMap0" in sh.uniforms, "CSM shadow map bound");
  console.log("  [OK] CSM + POM: Both shader hooks coexist cleanly");
  csmState.dispose?.();
}

// 4. Batched Mesh Parity
{
  const mc = new MaterialCache({ pomEnabled: true });
  const base = mc._materialFromFlags(SURFACE_TYPE.Base1Image, tex, SURFACE_CATEGORY.Stone, nrm, undefined, hgt);
  const did = 0x08002004;
  mc.materials.set(did, base);
  const fb = mc.getCachedFloorBias(did);
  const bv = batchedMaterialFor(fb);
  assert.equal(bv.customProgramCacheKey(), fb.customProgramCacheKey(), "Batched variant key matches clone");
  const shBv = compile(bv);
  assert.ok(shBv.fragmentShader.includes("_pomPerturbedUv"), "Batched variant compiles POM");
  console.log("  [OK] Batched parity: batchedMaterialFor inherits POM hooks");
}

// 5. Re-Seat Deactivation and Activation
{
  const mc = new MaterialCache({ pomEnabled: true });
  const D = 0x08002005;
  // Start with fallback material (no POM)
  const fromFallback = mc.getCachedFloorBias(D);
  assert.equal(fromFallback.userData.pomEnabled, undefined, "Fallback clone has no pomEnabled");

  // Re-seat onto real stone base with POM
  const baseStone = mc._materialFromFlags(SURFACE_TYPE.Base1Image, tex, SURFACE_CATEGORY.Stone, nrm, undefined, hgt);
  mc.materials.set(D, baseStone);
  mc._reseatVariantsForDid(D);
  assert.equal(fromFallback.userData.pomEnabled, true, "Re-seated clone gains pomEnabled=true");
  assert.match(fromFallback.customProgramCacheKey(), /\|p1\|/, "Re-seated key has |p1|");
  const shReseat = compile(fromFallback);
  assert.ok(shReseat.fragmentShader.includes("_pomPerturbedUv"), "Re-seated clone compiles POM");

  // Re-seat onto translucent base (POM should deactivate)
  const baseTrans = mc._materialFromFlags(SURFACE_TYPE.Base1Image | SURFACE_TYPE.Translucent, tex, SURFACE_CATEGORY.Stone, nrm, undefined, hgt);
  mc.materials.set(D, baseTrans);
  mc._reseatVariantsForDid(D);
  assert.equal(fromFallback.userData.pomEnabled, false, "Translucent re-seat deactivates pomEnabled");
  assert.match(fromFallback.customProgramCacheKey(), /\|p0\|/, "Translucent re-seat key has |p0|");
  const shTrans = compile(fromFallback);
  assert.equal(shTrans.fragmentShader.includes("_pomPerturbedUv"), false, "Translucent re-seat removes POM shader");
  console.log("  [OK] Re-seat: Dynamic activation and deactivation verified");
}

console.log("\nALL CLONED MATERIAL POM PERSISTENCE TESTS PASSED.");
