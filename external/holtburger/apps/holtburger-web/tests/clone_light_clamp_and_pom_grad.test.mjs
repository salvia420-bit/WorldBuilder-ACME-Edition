// external/holtburger/apps/holtburger-web/tests/clone_light_clamp_and_pom_grad.test.mjs
//
// Verification suite for Area 4 (w04-materials-pom):
//   1. Derived Material Clone Parity (lightClampRetail + CSM) across all 5 clone families
//   2. Interior POM textureGrad (pre-loop dFdx/dFdy derivatives, loop-unrolling stall elimination)
//   3. Scalar Depth-Bias Consolidation (uHbLogDepthBias uniform & single WebGLProgram key)

import assert from "node:assert/strict";
import * as THREE from "three";
import {
  MaterialCache,
  SURFACE_TYPE,
  VERTEX_BAKE,
  VFX_GLOBALS,
  installLightClampShaderPatch,
  installRetailLightClamp,
  installPomShaderPatch,
  pomGradEnabled,
  setPomGradEnabled,
  applyFillDepthBias,
  applyFloorDepthBias,
  applyStaticDepthBias,
  applyLogDepthBias,
  setConsolidatedDepthBias,
  readDepthBiasConsolidatedFlag,
  FILL_DEPTH_BIAS,
  FLOOR_DEPTH_BIAS,
  STATIC_DEPTH_BIAS,
  _reinstallCloneLightClamp,
} from "../scene3d/materials.js";
import { setupCsm } from "../scene3d/csm.js";

console.log("================================================================================");
console.log("Area 4 Verification: Clone Parity, POM textureGrad, & Depth-Bias Consolidation");
console.log("================================================================================\n");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name}`);
    console.error(err);
  }
}

/** Helper to compile a material with Three.js Standard shader template, expanding normal_fragment_maps */
function compileMaterial(mat) {
  const lib = THREE.ShaderLib.standard;
  let fs = lib.fragmentShader;
  if (fs.includes("#include <normal_fragment_maps>")) {
    fs = fs.replace("#include <normal_fragment_maps>", THREE.ShaderChunk.normal_fragment_maps);
  }
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: fs,
    defines: {},
  };
  if (mat.onBeforeCompile) {
    mat.onBeforeCompile.call(mat, shader, null);
  }
  return shader;
}

const dummyTex = new THREE.DataTexture(new Uint8Array([200, 150, 100, 255]), 1, 1);
dummyTex.needsUpdate = true;
const dummyNorm = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
dummyNorm.needsUpdate = true;
const dummyHgt = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
dummyHgt.name = "test_heightmap.r8";
dummyHgt.needsUpdate = true;

// ============================================================================
// PART 1: Derived Material Clone Parity (lightClampRetail + CSM)
// ============================================================================
console.log("-- Part 1: Derived Material Clone Parity (lightClampRetail + CSM) -------------");

test("Export installRetailLightClamp exists as alias to installLightClampShaderPatch", () => {
  assert.equal(typeof installRetailLightClamp, "function", "installRetailLightClamp is a function");
  const m = new THREE.MeshStandardMaterial();
  installRetailLightClamp(m);
  assert.equal(m.userData.lightClampRetail, true, "sets lightClampRetail true");
  assert.equal(m.userData.__lightClampPatched, true, "sets __lightClampPatched true");
  const sh = compileMaterial(m);
  assert.ok(sh.uniforms.uLightColorClamp, "defines uLightColorClamp uniform");
  assert.ok(sh.fragmentShader.includes("uLightColorClamp"), "shader includes uLightColorClamp");
  assert.ok(sh.fragmentShader.includes("_lcDiffClamped"), "shader includes retail per-channel color clamp");
});

test("Export _reinstallCloneLightClamp re-installs light clamp on clone", () => {
  const base = new THREE.MeshStandardMaterial({ map: dummyTex });
  installRetailLightClamp(base);
  const clone = base.clone();
  // base.clone() drops onBeforeCompile while copying userData
  assert.equal(clone.userData.lightClampRetail, true);
  _reinstallCloneLightClamp(clone, base);
  const sh = compileMaterial(clone);
  assert.ok(sh.uniforms.uLightColorClamp, "reinstalled hook populates uLightColorClamp");
  assert.ok(sh.fragmentShader.includes("uLightColorClamp"), "reinstalled hook patches fragment shader");
  assert.ok(clone.userData.lightClampShaderUniforms, "creates live lightClampShaderUniforms handle");
});

test("All 5 cache-owned clone families preserve lightClampRetail from base material", () => {
  const cache = new MaterialCache({});
  const did = 0x08001001;
  const base = cache._materialFromFlags(SURFACE_TYPE.Base1Image, dummyTex, undefined);
  cache.materials.set(did, base);

  assert.equal(base.userData.lightClampRetail, true, "base has lightClampRetail");

  // 1. frontSideMaterials (getCached with doubleSided = false)
  const front = cache.getCached(did, false);
  assert.equal(front.userData.lightClampRetail, true, "frontSide: lightClampRetail is true");
  const shFront = compileMaterial(front);
  assert.ok(shFront.uniforms.uLightColorClamp, "frontSide: uLightColorClamp uniform bound");
  assert.ok(shFront.fragmentShader.includes("uLightColorClamp"), "frontSide: fragment shader carries clamp");

  // 2. floorBiasMaterials (getCachedFloorBias)
  const floor = cache.getCachedFloorBias(did);
  assert.equal(floor.userData.lightClampRetail, true, "floorBias: lightClampRetail is true");
  const shFloor = compileMaterial(floor);
  assert.ok(shFloor.uniforms.uLightColorClamp, "floorBias: uLightColorClamp uniform bound");
  assert.ok(shFloor.fragmentShader.includes("uLightColorClamp"), "floorBias: fragment shader carries clamp");

  // 3. cellBakedMaterials (getCachedCellBaked)
  const baked = cache.getCachedCellBaked(did);
  assert.equal(baked.userData.lightClampRetail, true, "cellBaked: lightClampRetail is true");
  const shBaked = compileMaterial(baked);
  assert.ok(shBaked.uniforms.uLightColorClamp, "cellBaked: uLightColorClamp uniform bound");
  assert.ok(shBaked.fragmentShader.includes("uLightColorClamp"), "cellBaked: fragment shader carries clamp");

  // 4. staticBiasMaterials (getCachedStaticBias)
  const stat = cache.getCachedStaticBias(did);
  assert.equal(stat.userData.lightClampRetail, true, "staticBias: lightClampRetail is true");
  const shStat = compileMaterial(stat);
  assert.ok(shStat.uniforms.uLightColorClamp, "staticBias: uLightColorClamp uniform bound");
  assert.ok(shStat.fragmentShader.includes("uLightColorClamp"), "staticBias: fragment shader carries clamp");

  // 5. vfxVariants (getCachedVariant)
  const variant = cache.getCachedVariant(did, "deformation.windSwayGpu", "cfg1", (m) => {});
  assert.equal(variant.userData.lightClampRetail, true, "variant: lightClampRetail is true");
  const shVariant = compileMaterial(variant);
  assert.ok(shVariant.uniforms.uLightColorClamp, "variant: uLightColorClamp uniform bound");
  assert.ok(shVariant.fragmentShader.includes("uLightColorClamp"), "variant: fragment shader carries clamp");

  // 6. vfxPalettedVariants (getCachedVariantFromPaletted)
  const palBase = base.clone();
  palBase.userData = { ...base.userData, __paletteKey: "pal123" };
  const palVariant = cache.getCachedVariantFromPaletted(palBase, "glow.itemFx", "cfgP", (m) => {});
  assert.equal(palVariant.userData.lightClampRetail, true, "paletted variant: lightClampRetail is true");
  const shPal = compileMaterial(palVariant);
  assert.ok(shPal.uniforms.uLightColorClamp, "paletted variant: uLightColorClamp uniform bound");
  assert.ok(shPal.fragmentShader.includes("uLightColorClamp"), "paletted variant: fragment shader carries clamp");
});

test("All 5 clone families preserve CSM receiver patches when csmState is active", () => {
  const dummyCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  const dummyScene = new THREE.Scene();
  const csmState = setupCsm(dummyCamera, dummyScene, { maxFar: 200, cascades: 3 });

  const cache = new MaterialCache({ csmState });
  const did = 0x08002001;
  const base = cache._materialFromFlags(SURFACE_TYPE.Base1Image, dummyTex, undefined);
  cache.materials.set(did, base);

  assert.equal(base.userData.csmEnabled, true, "base has csmEnabled");

  // Verify all clone families preserve CSM receiver
  const front = cache.getCached(did, false);
  const floor = cache.getCachedFloorBias(did);
  const baked = cache.getCachedCellBaked(did);
  const stat = cache.getCachedStaticBias(did);
  const variant = cache.getCachedVariant(did, "deformation.windSwayGpu", "cfg2", (m) => {});

  const clones = [
    ["frontSide", front],
    ["floorBias", floor],
    ["cellBaked", baked],
    ["staticBias", stat],
    ["variant", variant],
  ];

  for (const [name, clone] of clones) {
    assert.equal(clone.userData.csmEnabled, true, `${name}: csmEnabled is true`);
    assert.equal(clone.userData.lightClampRetail, true, `${name}: lightClampRetail is true`);
    const sh = compileMaterial(clone);
    assert.ok(sh.vertexShader.includes("vCsmWorldPos"), `${name}: vertex shader includes vCsmWorldPos`);
    assert.ok(sh.fragmentShader.includes("float _csmShadowFactor("), `${name}: fragment shader includes _csmShadowFactor`);
    assert.ok(sh.fragmentShader.includes("uLightColorClamp"), `${name}: fragment shader also includes light clamp`);
    assert.equal(sh.uniforms.uCsmShadowMap0, csmState.uniforms.uCsmShadowMap0, `${name}: CSM uniforms bound by reference`);
  }
});

test("Reseating onto base without light clamp or CSM cleanly gates the clone hooks", () => {
  const dummyCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  const dummyScene = new THREE.Scene();
  const csmState = setupCsm(dummyCamera, dummyScene, { maxFar: 200, cascades: 3 });

  const cache = new MaterialCache({ csmState });
  const did = 0x08003001;
  const base = cache._materialFromFlags(SURFACE_TYPE.Base1Image, dummyTex, undefined);
  cache.materials.set(did, base);

  const floor = cache.getCachedFloorBias(did);
  assert.equal(floor.userData.csmEnabled, true);
  assert.equal(floor.userData.lightClampRetail, true);

  // New base without CSM or light clamp (e.g. wireframe or translucent)
  const bareBase = new THREE.MeshStandardMaterial({ map: dummyTex });
  bareBase.userData = { csmEnabled: false, lightClampRetail: false };
  cache.materials.set(did, bareBase);

  cache._reseatVariantsForDid(did);

  assert.equal(floor.userData.csmEnabled, false, "csmEnabled gated off on reseat");
  assert.equal(floor.userData.lightClampRetail, false, "lightClampRetail gated off on reseat");

  const sh = compileMaterial(floor);
  assert.ok(!sh.vertexShader.includes("vCsmWorldPos"), "CSM vertex text gated off");
  assert.ok(!sh.fragmentShader.includes("float _csmShadowFactor("), "CSM fragment text gated off");
  assert.ok(!sh.fragmentShader.includes("uLightColorClamp"), "light clamp text gated off");
});

// ============================================================================
// PART 2: Interior POM textureGrad
// ============================================================================
console.log("\n-- Part 2: Interior POM textureGrad --------------------------------------------");

test("pomGradEnabled correctly respects URL and override switches", () => {
  setPomGradEnabled(null);
  assert.equal(pomGradEnabled("?pomGrad=on"), true, "pomGrad=on is true");
  assert.equal(pomGradEnabled("?pomGrad=1"), true, "pomGrad=1 is true");
  assert.equal(pomGradEnabled("?pomGrad=off"), false, "pomGrad=off is false");
  assert.equal(pomGradEnabled("?pomGrad=0"), false, "pomGrad=0 is false");

  setPomGradEnabled(true);
  assert.equal(pomGradEnabled(), true, "explicit setPomGradEnabled(true)");
  setPomGradEnabled(false);
  assert.equal(pomGradEnabled(), false, "explicit setPomGradEnabled(false)");
  setPomGradEnabled(null);
});

test("installPomShaderPatch with pomGrad uses pre-loop dFdx/dFdy derivatives and textureGrad", () => {
  const mat = new THREE.MeshStandardMaterial({
    map: dummyTex,
    normalMap: dummyNorm,
  });

  installPomShaderPatch(mat, dummyHgt, { grad: true, steps: 16, depth: 0.08 });
  const sh = compileMaterial(mat);
  const fs = sh.fragmentShader;

  // 1. Fragment global derivative vector declarations
  assert.ok(fs.includes("vec2 _pomGx = vec2(0.0);"), "declares _pomGx global in fragment shader");
  assert.ok(fs.includes("vec2 _pomGy = vec2(0.0);"), "declares _pomGy global in fragment shader");

  // 2. Unconditional derivative computation before LOD branch / loops
  assert.ok(fs.includes("_pomGx = dFdx(vMapUv);"), "computes _pomGx = dFdx(vMapUv) in <map_fragment>");
  assert.ok(fs.includes("_pomGy = dFdy(vMapUv);"), "computes _pomGy = dFdy(vMapUv) in <map_fragment>");

  // 3. In-loop height samples use textureGrad
  assert.ok(
    fs.includes("textureGrad(uPomMap, currentUv, _pomGx, _pomGy).r"),
    "samples heightmap in raymarching loop using textureGrad"
  );
  assert.ok(
    fs.includes("textureGrad(uPomMap, prevUv, _pomGx, _pomGy).r"),
    "samples heightmap in secant refinement using textureGrad"
  );
  assert.ok(
    fs.includes("textureGrad(uPomMap, _pomUvG, _pomGx, _pomGy).r"),
    "samples hit-depth in self-shadowing using textureGrad"
  );

  // 4. Zero divergent implicit-gradient texture2D(uPomMap) in loops
  assert.ok(
    !fs.includes("texture2D(uPomMap"),
    "zero texture2D(uPomMap) invocations remain in the shader"
  );

  // 5. Diffuse and normal map samples use textureGrad with precomputed gradients
  assert.ok(
    fs.includes("textureGrad(map, _pomUv, _pomGx, _pomGy)"),
    "diffuse sample uses textureGrad with _pomGx, _pomGy"
  );
  assert.ok(
    fs.includes("textureGrad( normalMap, _pomUv, _pomGx, _pomGy )"),
    "normal map sample uses textureGrad with _pomGx, _pomGy"
  );
});

test("installPomShaderPatch with grad=false cleanly restores legacy texture2D", () => {
  const mat = new THREE.MeshStandardMaterial({
    map: dummyTex,
    normalMap: dummyNorm,
  });

  installPomShaderPatch(mat, dummyHgt, { grad: false });
  const sh = compileMaterial(mat);
  const fs = sh.fragmentShader;

  assert.ok(!fs.includes("vec2 _pomGx"), "no _pomGx declared in legacy mode");
  assert.ok(fs.includes("texture2D(uPomMap, currentUv).r"), "uses texture2D(uPomMap) in legacy mode");
  assert.ok(fs.includes("texture2D(map, _pomUv)"), "uses texture2D(map) in legacy mode");
  assert.ok(fs.includes("texture2D( normalMap, _pomUv )"), "uses texture2D(normalMap) in legacy mode");
});

// ============================================================================
// PART 3: Scalar Depth-Bias Consolidation
// ============================================================================
console.log("\n-- Part 3: Scalar Depth-Bias Consolidation -------------------------------------");

test("Depth bias functions expose unified uHbLogDepthBias uniform", () => {
  const mFill = new THREE.MeshStandardMaterial();
  applyFillDepthBias(mFill);
  assert.equal(mFill.userData.uHbLogDepthBias, FILL_DEPTH_BIAS, "fill depth bias value is 2.0e-4");
  const shFill = compileMaterial(mFill);
  assert.equal(shFill.uniforms.uHbLogDepthBias.value, FILL_DEPTH_BIAS, "uniform uHbLogDepthBias matches FILL_DEPTH_BIAS");

  const mFloor = new THREE.MeshStandardMaterial();
  applyFloorDepthBias(mFloor);
  assert.equal(mFloor.userData.uHbLogDepthBias, FLOOR_DEPTH_BIAS, "floor depth bias value is -2.0e-4");
  const shFloor = compileMaterial(mFloor);
  assert.equal(shFloor.uniforms.uHbLogDepthBias.value, FLOOR_DEPTH_BIAS, "uniform uHbLogDepthBias matches FLOOR_DEPTH_BIAS");

  const mStatic = new THREE.MeshStandardMaterial();
  applyStaticDepthBias(mStatic);
  assert.equal(mStatic.userData.uHbLogDepthBias, STATIC_DEPTH_BIAS, "static depth bias value is -4.0e-4");
  const shStatic = compileMaterial(mStatic);
  assert.equal(shStatic.uniforms.uHbLogDepthBias.value, STATIC_DEPTH_BIAS, "uniform uHbLogDepthBias matches STATIC_DEPTH_BIAS");
});

test("Consolidated depth-bias mode shares single program cache key and uniform shader body", () => {
  setConsolidatedDepthBias(true);
  try {
    const mFill = new THREE.MeshStandardMaterial();
    const mFloor = new THREE.MeshStandardMaterial();
    const mStatic = new THREE.MeshStandardMaterial();

    applyFillDepthBias(mFill);
    applyFloorDepthBias(mFloor);
    applyStaticDepthBias(mStatic);

    const keyFill = mFill.customProgramCacheKey();
    const keyFloor = mFloor.customProgramCacheKey();
    const keyStatic = mStatic.customProgramCacheKey();

    // In consolidated mode, all depth-biased materials share the exact same program cache key |b1|f0|s0
    assert.equal(keyFill, keyFloor, "fill and floor share program cache key");
    assert.equal(keyFloor, keyStatic, "floor and static share program cache key");
    assert.ok(keyFill.includes("|b1|f0|s0"), `cache key has consolidated token: ${keyFill}`);

    const shFill = compileMaterial(mFill);
    const shFloor = compileMaterial(mFloor);
    const shStatic = compileMaterial(mStatic);

    // Fragment shader GLSL body is identical across all three, referencing uHbLogDepthBias
    assert.equal(shFill.fragmentShader, shFloor.fragmentShader, "fill and floor have identical fragment shader");
    assert.equal(shFloor.fragmentShader, shStatic.fragmentShader, "floor and static have identical fragment shader");
    assert.ok(shFill.fragmentShader.includes("uniform float uHbLogDepthBias;"), "declares uniform float uHbLogDepthBias");
    assert.ok(shFill.fragmentShader.includes("gl_FragDepth += uHbLogDepthBias;"), "adds uHbLogDepthBias to gl_FragDepth");

    // But uniforms differ by value
    assert.equal(shFill.uniforms.uHbLogDepthBias.value, 2.0e-4);
    assert.equal(shFloor.uniforms.uHbLogDepthBias.value, -2.0e-4);
    assert.equal(shStatic.uniforms.uHbLogDepthBias.value, -4.0e-4);
  } finally {
    setConsolidatedDepthBias(null);
  }
});

test("Dynamic depth bias update on existing material updates live uniform without recompilation", () => {
  const m = new THREE.MeshStandardMaterial();
  applyFillDepthBias(m);
  const sh = compileMaterial(m);

  assert.equal(m.userData.depthBiasUniforms.uHbLogDepthBias.value, 2.0e-4);

  // Re-apply a different bias value
  applyFloorDepthBias(m);
  assert.equal(m.userData.depthBiasUniforms.uHbLogDepthBias.value, -2.0e-4, "updated live uniform value to floor bias");

  applyStaticDepthBias(m);
  assert.equal(m.userData.depthBiasUniforms.uHbLogDepthBias.value, -4.0e-4, "updated live uniform value to static bias");
});

test("applyLogDepthBias allows custom scalar delta", () => {
  const m = new THREE.MeshStandardMaterial();
  applyLogDepthBias(m, -1.5e-4);
  assert.equal(m.userData.uHbLogDepthBias, -1.5e-4);
  const sh = compileMaterial(m);
  assert.equal(sh.uniforms.uHbLogDepthBias.value, -1.5e-4);
  assert.ok(m.customProgramCacheKey().includes("|b1|f0|s0"));
});

// ============================================================================
// SUMMARY
// ============================================================================
console.log("\n================================================================================");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("================================================================================");

if (failed > 0) {
  process.exit(1);
} else {
  console.log("ALL TESTS PASSED SUCCESSFULLY.");
}
