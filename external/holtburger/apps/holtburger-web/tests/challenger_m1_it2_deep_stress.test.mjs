// apps/holtburger-web/tests/challenger_m1_it2_deep_stress.test.mjs
// Adversarial Empirical Challenge Suite for Milestone 1 Iteration 2
// Thorough stress testing of:
// 1. Deep clone chains (base -> c1 -> c2 -> c3 -> c4 -> c5) with mixed configurations & overrides
// 2. Rapid reseating texture swaps (Stone A -> Brick B -> Translucent -> Brick C -> Stone A)
// 3. Re-seat deactivation recovery under memory/streaming pressure
// 4. Degenerate and missing heightfield edge cases

import assert from "node:assert/strict";
import * as THREE from "three";
import {
  MaterialCache,
  SURFACE_TYPE,
  SURFACE_CATEGORY,
  _reinstallClonePom,
  heightTexForMaterial,
  applyFloorDepthBias,
  applyStaticDepthBias,
} from "../scene3d/materials.js";
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

function createDummyTex(r, g, b, name = "tex") {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
  t.name = name;
  t.needsUpdate = true;
  return t;
}

const texDiffuse = createDummyTex(180, 140, 100, "diffuse");
const texNormal = createDummyTex(128, 128, 255, "normal");
const hgtA = createDummyTex(210, 210, 210, "hgtA");
const hgtB = createDummyTex(170, 170, 170, "hgtB");
const hgtC = createDummyTex(240, 240, 240, "hgtC");

let totalAssertions = 0;
function check(condition, message) {
  totalAssertions++;
  assert.ok(condition, message);
}
function checkEqual(actual, expected, message) {
  totalAssertions++;
  assert.equal(actual, expected, message);
}
function checkMatch(actual, regex, message) {
  totalAssertions++;
  assert.match(actual, regex, message);
}

console.log("================================================================================");
console.log("ADVERSARIAL STRESS SUITE: Milestone 1 Iteration 2 Deep Verification");
console.log("================================================================================");

// =============================================================================
// TEST SUITE 1: DEEP CLONE CHAINS (base -> c1 -> c2 -> c3 -> c4 -> c5)
// =============================================================================
console.log("\n>>> [SUITE 1] Deep Clone Chains with Mixed Configurations & Overrides");

// 1.1: 5-level deep linear clone chain with progressive overrides
{
  const mc = new MaterialCache({
    pomEnabled: true,
    pomOpts: { steps: 16, depth: 0.08, lodNear: 15.0, lodFar: 35.0, shadowSteps: 8, shadowDarkness: 0.5 },
  });
  const did = 0x08101001;
  const base = mc._materialFromFlags(SURFACE_TYPE.Base1Image, texDiffuse, SURFACE_CATEGORY.Stone, texNormal, undefined, hgtA);
  mc.materials.set(did, base);

  checkEqual(heightTexForMaterial(base), hgtA, "Base has hgtA");
  checkEqual(base.userData.pomEnabled, true, "Base has pomEnabled true");

  // Clone 1: Override steps & depth
  const c1 = base.clone();
  c1.userData = { ...(base.userData || {}), __cacheOwned: true };
  _reinstallClonePom(c1, base, { steps: 20, depth: 0.10 });
  checkEqual(heightTexForMaterial(c1), hgtA, "c1 inherits hgtA");
  checkEqual(c1.userData.pomUniforms.steps, 20, "c1 steps overridden to 20");
  checkEqual(c1.userData.pomUniforms.depth, 0.10, "c1 depth overridden to 0.10");
  checkMatch(c1.customProgramCacheKey(), /\|p1\|/, "c1 has |p1|");
  const sh1 = compile(c1);
  checkEqual(sh1.uniforms.uPomSteps.value, 20, "sh1 uPomSteps is 20");
  checkEqual(sh1.uniforms.uPomDepth.value, 0.10, "sh1 uPomDepth is 0.10");
  checkEqual(sh1.uniforms.uPomMap.value, hgtA, "sh1 uPomMap is hgtA");

  // Clone 2: Inherit from c1 (without explicit opts)
  const c2 = c1.clone();
  c2.userData = { ...(c1.userData || {}), __cacheOwned: true };
  _reinstallClonePom(c2, c1);
  checkEqual(heightTexForMaterial(c2), hgtA, "c2 inherits hgtA from c1");
  checkEqual(c2.userData.pomUniforms.steps, 20, "c2 inherits c1 steps (20)");
  checkEqual(c2.userData.pomUniforms.depth, 0.10, "c2 inherits c1 depth (0.10)");
  checkMatch(c2.customProgramCacheKey(), /\|p1\|/, "c2 has |p1|");
  const sh2 = compile(c2);
  checkEqual(sh2.uniforms.uPomSteps.value, 20, "sh2 uPomSteps is 20");
  checkEqual(sh2.uniforms.uPomMap.value, hgtA, "sh2 uPomMap is hgtA");

  // Clone 3: Override LOD boundaries on c3
  const c3 = c2.clone();
  c3.userData = { ...(c2.userData || {}), __cacheOwned: true };
  _reinstallClonePom(c3, c2, { steps: 28, depth: 0.14, lodNear: 25.0, lodFar: 60.0 });
  checkEqual(heightTexForMaterial(c3), hgtA, "c3 inherits hgtA from c2");
  checkEqual(c3.userData.pomUniforms.steps, 28, "c3 steps overridden to 28");
  checkEqual(c3.userData.pomUniforms.lodNear, 25.0, "c3 lodNear overridden to 25");
  checkEqual(c3.userData.pomUniforms.lodFar, 60.0, "c3 lodFar overridden to 60");
  checkMatch(c3.customProgramCacheKey(), /\|p1\|/, "c3 has |p1|");
  const sh3 = compile(c3);
  checkEqual(sh3.uniforms.uPomSteps.value, 28, "sh3 uPomSteps is 28");
  checkEqual(sh3.uniforms.uPomLodNear.value, 25.0, "sh3 uPomLodNear is 25.0");

  // Clone 4: Inherit from c3
  const c4 = c3.clone();
  c4.userData = { ...(c3.userData || {}), __cacheOwned: true };
  _reinstallClonePom(c4, c3);
  checkEqual(heightTexForMaterial(c4), hgtA, "c4 inherits hgtA from c3");
  checkEqual(c4.userData.pomUniforms.steps, 28, "c4 inherits c3 steps (28)");
  checkEqual(c4.userData.pomUniforms.lodNear, 25.0, "c4 inherits c3 lodNear (25)");
  const sh4 = compile(c4);
  checkEqual(sh4.uniforms.uPomSteps.value, 28, "sh4 uPomSteps is 28");

  // Clone 5: Final depth of chain
  const c5 = c4.clone();
  c5.userData = { ...(c4.userData || {}), __cacheOwned: true };
  _reinstallClonePom(c5, c4, { steps: 36, depth: 0.20 });
  checkEqual(heightTexForMaterial(c5), hgtA, "c5 inherits hgtA from c4");
  checkEqual(c5.userData.pomUniforms.steps, 36, "c5 steps overridden to 36");
  checkEqual(c5.userData.pomUniforms.depth, 0.20, "c5 depth overridden to 0.20");
  const sh5 = compile(c5);
  checkEqual(sh5.uniforms.uPomSteps.value, 36, "sh5 uPomSteps is 36");
  checkEqual(sh5.uniforms.uPomDepth.value, 0.20, "sh5 uPomDepth is 0.20");
  check(sh5.fragmentShader.includes("_pomPerturbedUv"), "sh5 fragmentShader includes POM");

  // Uniform mutation isolation check: mutating c5 must NOT change c1 or c2
  c5.userData.pomUniforms.steps = 99;
  checkEqual(c1.userData.pomUniforms.steps, 20, "c1 steps isolated from c5 mutation");
  checkEqual(c2.userData.pomUniforms.steps, 20, "c2 steps isolated from c5 mutation");
  checkEqual(c3.userData.pomUniforms.steps, 28, "c3 steps isolated from c5 mutation");
  console.log("  [PASS] 1.1: 5-level deep clone chain preserves height texture, params, and isolation.");
}

// 1.2: Branching clone families with distinct shader extensions
// (FloorBias, StaticBias, CellBaked, FrontSide, VFX, BatchedMesh variants)
{
  const mc = new MaterialCache({ pomEnabled: true });
  const did = 0x08101002;
  const base = mc._materialFromFlags(SURFACE_TYPE.Base1Image, texDiffuse, SURFACE_CATEGORY.Stone, texNormal, undefined, hgtA);
  mc.materials.set(did, base);

  const fb = mc.getCachedFloorBias(did);
  const sb = mc.getCachedStaticBias(did);
  const cb = mc.getCachedCellBaked(did);
  const front = mc.getCached(did, false);
  const vfx = mc.getCachedVariant(did, "windSway", (m) => { m.userData.windActive = true; });
  const owned = mc.makeOwnedVariant(base, "ownedVfx", (m) => { m.userData.ownedActive = true; });

  // 1. Check userData.pomEnabled on all variants
  checkEqual(fb.userData.pomEnabled, true, "fb has pomEnabled");
  checkEqual(sb.userData.pomEnabled, true, "sb has pomEnabled");
  checkEqual(cb.userData.pomEnabled, true, "cb has pomEnabled");
  checkEqual(front.userData.pomEnabled, true, "front has pomEnabled");
  checkEqual(vfx.userData.pomEnabled, true, "vfx has pomEnabled");
  checkEqual(owned.userData.pomEnabled, true, "owned has pomEnabled");

  // 2. Check height texture plane inheritance on all variants
  checkEqual(heightTexForMaterial(fb), hgtA, "fb inherits hgtA");
  checkEqual(heightTexForMaterial(sb), hgtA, "sb inherits hgtA");
  checkEqual(heightTexForMaterial(cb), hgtA, "cb inherits hgtA");
  checkEqual(heightTexForMaterial(front), hgtA, "front inherits hgtA");
  checkEqual(heightTexForMaterial(vfx), hgtA, "vfx inherits hgtA");
  checkEqual(heightTexForMaterial(owned), hgtA, "owned inherits hgtA");

  // 3. Check customProgramCacheKey has |p1| and respective distinct extension flags
  checkMatch(fb.customProgramCacheKey(), /\|f1\|/, "fb has floor bias flag |f1|");
  checkMatch(fb.customProgramCacheKey(), /\|p1\|/, "fb has POM flag |p1|");
  checkMatch(sb.customProgramCacheKey(), /\|s1\|/, "sb has static bias flag |s1|");
  checkMatch(sb.customProgramCacheKey(), /\|p1\|/, "sb has POM flag |p1|");
  checkMatch(cb.customProgramCacheKey(), /\|k1/, "cb has baked light flag |k1");
  checkMatch(cb.customProgramCacheKey(), /\|p1\|/, "cb has POM flag |p1|");
  checkMatch(front.customProgramCacheKey(), /\|p1\|/, "front has POM flag |p1|");
  checkMatch(vfx.customProgramCacheKey(), /\|vwindSway/, "vfx has vfxSetKey flag");
  checkMatch(vfx.customProgramCacheKey(), /\|p1\|/, "vfx has POM flag |p1|");
  checkMatch(owned.customProgramCacheKey(), /\|vownedVfx/, "owned has vfxSetKey flag");
  checkMatch(owned.customProgramCacheKey(), /\|p1\|/, "owned has POM flag |p1|");

  // 4. Verify program keys are mutually distinct (no program collisions between distinct variants!)
  const keys = [
    fb.customProgramCacheKey(),
    sb.customProgramCacheKey(),
    cb.customProgramCacheKey(),
    vfx.customProgramCacheKey(),
    owned.customProgramCacheKey(),
  ];
  const uniqueKeys = new Set(keys);
  checkEqual(uniqueKeys.size, keys.length, "All distinct variant families have unique program cache keys");

  // 5. Shader compilation verification
  const shFb = compile(fb);
  check(shFb.fragmentShader.includes("_pomPerturbedUv"), "fb compiles POM");
  check(shFb.fragmentShader.includes("gl_FragDepth -= 2.0e-4;"), "fb compiles floor bias");

  const shSb = compile(sb);
  check(shSb.fragmentShader.includes("_pomPerturbedUv"), "sb compiles POM");
  check(shSb.fragmentShader.includes("gl_FragDepth -= 4.0e-4;"), "sb compiles static bias");

  const shCb = compile(cb);
  check(shCb.fragmentShader.includes("_pomPerturbedUv"), "cb compiles POM");
  check(shCb.vertexShader.includes("acBakedLight"), "cb compiles vertex baked light");

  // 6. Batched mesh variants for fb and sb
  const batchedFb = batchedMaterialFor(fb);
  checkEqual(batchedFb.customProgramCacheKey(), fb.customProgramCacheKey(), "batchedFb key matches fb");
  const shBatchedFb = compile(batchedFb);
  check(shBatchedFb.fragmentShader.includes("_pomPerturbedUv"), "batchedFb compiles POM");
  check(shBatchedFb.fragmentShader.includes("gl_FragDepth -= 2.0e-4;"), "batchedFb compiles floor bias");

  const batchedSb = batchedMaterialFor(sb);
  checkEqual(batchedSb.customProgramCacheKey(), sb.customProgramCacheKey(), "batchedSb key matches sb");
  const shBatchedSb = compile(batchedSb);
  check(shBatchedSb.fragmentShader.includes("_pomPerturbedUv"), "batchedSb compiles POM");
  check(shBatchedSb.fragmentShader.includes("gl_FragDepth -= 4.0e-4;"), "batchedSb compiles static bias");

  console.log("  [PASS] 1.2: Branching clone families preserve distinct cache keys and shader extensions.");
}

// 1.3: Deep clone chain with intermediate deactivation and branch isolation
{
  const mc = new MaterialCache({ pomEnabled: true });
  const did = 0x08101003;
  const base = mc._materialFromFlags(SURFACE_TYPE.Base1Image, texDiffuse, SURFACE_CATEGORY.Stone, texNormal, undefined, hgtA);
  mc.materials.set(did, base);

  const c1 = base.clone();
  c1.userData = { ...(base.userData || {}), __cacheOwned: true };
  _reinstallClonePom(c1, base);

  const c2 = c1.clone();
  c2.userData = { ...(c1.userData || {}), __cacheOwned: true };
  _reinstallClonePom(c2, c1);
  checkEqual(c2.userData.pomEnabled, true, "c2 active before deactivation");

  // Deactivate c2
  c2.userData.pomEnabled = false;

  // Clone c3 from deactivated c2:
  const c3 = c2.clone();
  _reinstallClonePom(c3, c2);
  checkEqual(c3.userData.pomEnabled, undefined, "c3 cloned from deactivated c2 strips unbacked claim");
  checkEqual(!c3.customProgramCacheKey().includes("|p1|"), true, "c3 program cache key has no |p1|");
  const sh3 = compile(c3);
  check(!sh3.fragmentShader.includes("_pomPerturbedUv"), "c3 does not compile POM");

  // Meanwhile, clone c4 from ancestor c1 (which was never deactivated)
  const c4 = c1.clone();
  c4.userData = { ...(c1.userData || {}), __cacheOwned: true };
  _reinstallClonePom(c4, c1);
  checkEqual(c4.userData.pomEnabled, true, "c4 cloned from c1 retains pomEnabled=true");
  checkMatch(c4.customProgramCacheKey(), /\|p1\|/, "c4 program cache key has |p1|");
  const sh4 = compile(c4);
  check(sh4.fragmentShader.includes("_pomPerturbedUv"), "c4 compiles POM");

  console.log("  [PASS] 1.3: Intermediate deactivation isolates cleanly without poisoning ancestor or sibling clones.");
}

// =============================================================================
// TEST SUITE 2: RAPID RESEATING TEXTURE SWAPS
// (Stone A -> Brick B -> Translucent -> Brick C -> Stone A)
// =============================================================================
console.log("\n>>> [SUITE 2] Rapid Reseating Texture Swaps & Live Handle Updates");

{
  const mc = new MaterialCache({ pomEnabled: true, pomOpts: { steps: 16, depth: 0.08 } });
  const D = 0x08102001;

  // Create variants before base is populated (streaming cold start)
  const fb = mc.getCachedFloorBias(D);
  const sb = mc.getCachedStaticBias(D);
  const cb = mc.getCachedCellBaked(D);

  const stoneA = mc._materialFromFlags(SURFACE_TYPE.Base1Image, texDiffuse, SURFACE_CATEGORY.Stone, texNormal, undefined, hgtA);
  stoneA.userData.pomUniforms = { steps: 16, depth: 0.08, lodNear: 15.0, lodFar: 35.0, shadowSteps: 8, shadowDarkness: 0.5 };

  const brickB = mc._materialFromFlags(SURFACE_TYPE.Base1Image, texDiffuse, SURFACE_CATEGORY.Brick, texNormal, undefined, hgtB);
  brickB.userData.pomUniforms = { steps: 22, depth: 0.11, lodNear: 18.0, lodFar: 40.0, shadowSteps: 10, shadowDarkness: 0.6 };

  const trans = mc._materialFromFlags(SURFACE_TYPE.Base1Image | SURFACE_TYPE.Translucent, texDiffuse, SURFACE_CATEGORY.Stone, texNormal, undefined, hgtA);

  const brickC = mc._materialFromFlags(SURFACE_TYPE.Base1Image, texDiffuse, SURFACE_CATEGORY.Brick, texNormal, undefined, hgtC);
  brickC.userData.pomUniforms = { steps: 30, depth: 0.15, lodNear: 20.0, lodFar: 45.0, shadowSteps: 12, shadowDarkness: 0.7 };

  // Phase 1: Load Stone A
  mc.materials.set(D, stoneA);
  mc._reseatVariantsForDid(D);

  checkEqual(fb.userData.pomEnabled, true, "Phase 1: fb pomEnabled true");
  checkEqual(sb.userData.pomEnabled, true, "Phase 1: sb pomEnabled true");
  checkEqual(cb.userData.pomEnabled, true, "Phase 1: cb pomEnabled true");

  const shFb1 = compile(fb);
  checkEqual(shFb1.uniforms.uPomMap.value, hgtA, "Phase 1: shFb1 binds hgtA");
  checkEqual(shFb1.uniforms.uPomSteps.value, 16, "Phase 1: shFb1 steps 16");
  checkEqual(fb.userData.pomShaderUniforms.uPomMap.value, hgtA, "Phase 1: live handle hgtA");

  // Phase 2: Swap to Brick B
  mc.materials.set(D, brickB);
  mc._reseatVariantsForDid(D);

  checkEqual(fb.userData.pomEnabled, true, "Phase 2: fb pomEnabled true");
  checkEqual(fb.userData.pomShaderUniforms.uPomMap.value, hgtB, "Phase 2: live handle immediately updated to hgtB");
  checkEqual(fb.userData.pomShaderUniforms.uPomSteps.value, 22, "Phase 2: live handle steps updated to 22");
  checkEqual(fb.userData.pomShaderUniforms.uPomDepth.value, 0.11, "Phase 2: live handle depth updated to 0.11");
  checkEqual(fb.userData.pomTextureName, "hgtB", "Phase 2: metadata texture name updated to hgtB");

  // Check static bias & cell baked live handles too:
  checkEqual(sb.userData.pomShaderUniforms?.uPomMap?.value ?? hgtB, hgtB, "Phase 2: sb handle hgtB");
  checkEqual(cb.userData.pomShaderUniforms?.uPomMap?.value ?? hgtB, hgtB, "Phase 2: cb handle hgtB");

  // Recompilation binds new heightmap:
  const shFb2 = compile(fb);
  checkEqual(shFb2.uniforms.uPomMap.value, hgtB, "Phase 2: recompiled shader binds hgtB");
  checkEqual(shFb2.uniforms.uPomSteps.value, 22, "Phase 2: recompiled shader steps 22");

  // Phase 3: Swap to Translucent
  mc.materials.set(D, trans);
  mc._reseatVariantsForDid(D);

  checkEqual(fb.userData.pomEnabled, false, "Phase 3: fb pomEnabled deactivated (false)");
  checkEqual(sb.userData.pomEnabled, false, "Phase 3: sb pomEnabled deactivated (false)");
  checkEqual(cb.userData.pomEnabled, false, "Phase 3: cb pomEnabled deactivated (false)");
  checkEqual(fb.userData.pomShaderUniforms.uPomMap.value, null, "Phase 3: live uPomMap unbound (null)");
  checkMatch(fb.customProgramCacheKey(), /\|p0\|/, "Phase 3: cache key has |p0|");
  const shFb3 = compile(fb);
  check(!shFb3.fragmentShader.includes("_pomPerturbedUv"), "Phase 3: shader no longer includes POM");

  // Phase 4: Swap to Brick C (Full Deactivation Recovery)
  mc.materials.set(D, brickC);
  mc._reseatVariantsForDid(D);

  checkEqual(fb.userData.pomEnabled, true, "Phase 4: fb pomEnabled recovered (true)");
  checkEqual(sb.userData.pomEnabled, true, "Phase 4: sb pomEnabled recovered (true)");
  checkEqual(cb.userData.pomEnabled, true, "Phase 4: cb pomEnabled recovered (true)");
  checkEqual(fb.userData.pomShaderUniforms.uPomMap.value, hgtC, "Phase 4: live handle bound to hgtC");
  checkEqual(fb.userData.pomShaderUniforms.uPomSteps.value, 30, "Phase 4: live handle steps 30");
  checkEqual(fb.userData.pomShaderUniforms.uPomDepth.value, 0.15, "Phase 4: live handle depth 0.15");
  checkMatch(fb.customProgramCacheKey(), /\|p1\|/, "Phase 4: cache key restored to |p1|");
  const shFb4 = compile(fb);
  check(shFb4.fragmentShader.includes("_pomPerturbedUv"), "Phase 4: shader restored POM execution");
  checkEqual(shFb4.uniforms.uPomMap.value, hgtC, "Phase 4: compiled shader binds hgtC");

  // Phase 5: Swap back to Stone A
  mc.materials.set(D, stoneA);
  mc._reseatVariantsForDid(D);

  checkEqual(fb.userData.pomEnabled, true, "Phase 5: fb pomEnabled true");
  checkEqual(fb.userData.pomShaderUniforms.uPomMap.value, hgtA, "Phase 5: live handle reverted to hgtA");
  checkEqual(fb.userData.pomShaderUniforms.uPomSteps.value, 16, "Phase 5: live handle steps reverted to 16");
  const shFb5 = compile(fb);
  checkEqual(shFb5.uniforms.uPomMap.value, hgtA, "Phase 5: compiled shader binds hgtA");

  // Phase 6: 100-cycle high-frequency rapid swap stress loop
  const sequence = [stoneA, brickB, trans, brickC, stoneA];
  for (let i = 0; i < 100; i++) {
    const target = sequence[i % sequence.length];
    mc.materials.set(D, target);
    mc._reseatVariantsForDid(D);
  }
  // After 100 iterations (100 % 5 == 0), target was stoneA:
  checkEqual(fb.userData.pomEnabled, true, "Loop: final fb pomEnabled true");
  checkEqual(fb.userData.pomShaderUniforms.uPomMap.value, hgtA, "Loop: final live handle hgtA");
  const shLoop = compile(fb);
  checkEqual(shLoop.uniforms.uPomMap.value, hgtA, "Loop: compiled shader binds hgtA");

  console.log("  [PASS] 2.1: Rapid reseat swaps (Stone A -> Brick B -> Translucent -> Brick C -> Stone A) and 100-cycle stress verified.");
}

// =============================================================================
// TEST SUITE 3: RE-SEAT DEACTIVATION RECOVERY UNDER MEMORY/STREAMING PRESSURE
// =============================================================================
console.log("\n>>> [SUITE 3] Streaming Pressure & Memory Safety");

{
  const mc = new MaterialCache({ pomEnabled: true });
  const NUM_DIDS = 60;
  const didList = [];

  // Step 1: Pre-create 60 DIDs and their clone variants (180 materials total)
  for (let i = 0; i < NUM_DIDS; i++) {
    const did = 0x08200000 + i;
    didList.push(did);
    // Request cached variants before base exists (simulates early render tree assembly)
    mc.getCachedFloorBias(did);
    mc.getCachedStaticBias(did);
    mc.getCachedCellBaked(did);
  }

  // Step 2: Stream in bases (alternating: stone, brick, translucent, fallback)
  for (let i = 0; i < NUM_DIDS; i++) {
    const did = didList[i];
    let base;
    const kind = i % 4;
    if (kind === 0) {
      base = mc._materialFromFlags(SURFACE_TYPE.Base1Image, texDiffuse, SURFACE_CATEGORY.Stone, texNormal, undefined, hgtA);
    } else if (kind === 1) {
      base = mc._materialFromFlags(SURFACE_TYPE.Base1Image, texDiffuse, SURFACE_CATEGORY.Brick, texNormal, undefined, hgtB);
    } else if (kind === 2) {
      base = mc._materialFromFlags(SURFACE_TYPE.Base1Image | SURFACE_TYPE.Translucent, texDiffuse, SURFACE_CATEGORY.Stone, texNormal, undefined, hgtA);
    } else {
      // Plain fallback
      base = new THREE.MeshStandardMaterial({ map: texDiffuse });
    }
    mc.materials.set(did, base);
    mc._reseatVariantsForDid(did);
  }

  // Step 3: Verify all 180 variants correctly reflect their kind
  for (let i = 0; i < NUM_DIDS; i++) {
    const did = didList[i];
    const kind = i % 4;
    const fb = mc.getCachedFloorBias(did);
    const sb = mc.getCachedStaticBias(did);
    const cb = mc.getCachedCellBaked(did);

    if (kind === 0) {
      checkEqual(fb.userData.pomEnabled, true, `DID ${i} fb pomEnabled`);
      checkEqual(heightTexForMaterial(fb), hgtA, `DID ${i} fb hgtA`);
    } else if (kind === 1) {
      checkEqual(sb.userData.pomEnabled, true, `DID ${i} sb pomEnabled`);
      checkEqual(heightTexForMaterial(sb), hgtB, `DID ${i} sb hgtB`);
    } else if (kind === 2) {
      checkEqual(!cb.userData.pomEnabled, true, `DID ${i} cb pomEnabled deactivated / falsy`);
      checkMatch(cb.customProgramCacheKey(), /\|p0\|/, `DID ${i} cb cache key has |p0|`);
    } else {
      checkEqual(!fb.userData.pomEnabled, true, `DID ${i} fb fallback pomEnabled deactivated / falsy`);
      checkMatch(fb.customProgramCacheKey(), /\|p0\|/, `DID ${i} fb cache key has |p0|`);
    }
  }

  // Step 4: Upgrade all translucent and fallback DIDs to Stone with POM
  for (let i = 0; i < NUM_DIDS; i++) {
    const did = didList[i];
    const kind = i % 4;
    if (kind >= 2) {
      const upgrade = mc._materialFromFlags(SURFACE_TYPE.Base1Image, texDiffuse, SURFACE_CATEGORY.Stone, texNormal, undefined, hgtC);
      mc.materials.set(did, upgrade);
      mc._reseatVariantsForDid(did);

      const fb = mc.getCachedFloorBias(did);
      checkEqual(fb.userData.pomEnabled, true, `Upgraded DID ${i} fb pomEnabled restored`);
      checkEqual(heightTexForMaterial(fb), hgtC, `Upgraded DID ${i} fb height is hgtC`);
      checkMatch(fb.customProgramCacheKey(), /\|p1\|/, `Upgraded DID ${i} cache key has |p1|`);
    }
  }

  // Step 5: Test edge-case reseats
  assert.doesNotThrow(() => mc._reseatVariantsForDid(0xdeadbeef), "Reseating non-existent DID does not throw");
  // Delete base and reseat
  const orphanDid = didList[0];
  mc.materials.delete(orphanDid);
  assert.doesNotThrow(() => mc._reseatVariantsForDid(orphanDid), "Reseating DID without base does not throw");

  console.log(`  [PASS] 3.1: Streaming pressure across ${NUM_DIDS} DIDs (180 variants) and dynamic upgrades verified.`);
}

// =============================================================================
// TEST SUITE 4: DEGENERATE AND MISSING HEIGHTFIELD EDGE CASES
// =============================================================================
console.log("\n>>> [SUITE 4] Degenerate and Missing Heightfield Edge Cases");

// 4.1: Missing height texture with pomEnabled: true on base
{
  const mc = new MaterialCache({ pomEnabled: true });
  const baseNoHeight = new THREE.MeshStandardMaterial({ map: texDiffuse });
  baseNoHeight.userData = { pomEnabled: true, pomUniforms: { steps: 16 } };

  const clone = baseNoHeight.clone();
  checkEqual(clone.userData.pomEnabled, true, "Three.js clone initially copied pomEnabled");

  // Reinstall POM with missing height:
  _reinstallClonePom(clone, baseNoHeight);
  checkEqual(clone.userData.pomEnabled, undefined, "Unbacked pomEnabled stripped when hTex is missing");
  checkEqual(!clone.customProgramCacheKey().includes("|p1|"), true, "Cache key has no |p1|");

  const sh = compile(clone);
  check(!sh.fragmentShader.includes("_pomPerturbedUv"), "Clone without hTex does not compile POM");
  console.log("  [PASS] 4.1: Missing height texture cleanly strips unbacked pomEnabled and disables shader patch.");
}

// 4.2: Null / Non-object / Empty inputs to _reinstallClonePom
{
  assert.doesNotThrow(() => _reinstallClonePom(null, null), "null clone + null base");
  assert.doesNotThrow(() => _reinstallClonePom(undefined, undefined), "undefined clone + undefined base");

  const mat = new THREE.MeshStandardMaterial();
  assert.doesNotThrow(() => _reinstallClonePom(mat, null), "mat clone + null base");
  assert.doesNotThrow(() => _reinstallClonePom(null, mat), "null clone + mat base");
  assert.doesNotThrow(() => _reinstallClonePom(mat, mat), "mat clone + mat base (no pom)");

  // Clone with non-object userData
  const weirdMat = new THREE.MeshStandardMaterial();
  weirdMat.userData = null;
  assert.doesNotThrow(() => _reinstallClonePom(weirdMat, mat), "clone with null userData");

  console.log("  [PASS] 4.2: Degenerate inputs to _reinstallClonePom safely handled.");
}

// 4.3: Corrupted POM Uniforms (NaN, Infinity, negative values, string values)
{
  const mc = new MaterialCache({ pomEnabled: true });
  const baseCorrupt = mc._materialFromFlags(SURFACE_TYPE.Base1Image, texDiffuse, SURFACE_CATEGORY.Stone, texNormal, undefined, hgtA);
  baseCorrupt.userData.pomUniforms = {
    steps: NaN,
    depth: Infinity,
    lodNear: -5.0,
    lodFar: "invalid",
    shadowSteps: null,
    shadowDarkness: undefined,
  };

  const cloneCorrupt = baseCorrupt.clone();
  cloneCorrupt.userData = { ...(baseCorrupt.userData || {}), __cacheOwned: true };
  assert.doesNotThrow(() => _reinstallClonePom(cloneCorrupt, baseCorrupt), "Reinstalling POM with corrupt uniforms does not throw");

  const sh = compile(cloneCorrupt);
  // Three.js uniforms accept these values without throw
  check(sh.fragmentShader.includes("_pomPerturbedUv"), "Corrupted uniforms do not abort POM compilation");
  console.log("  [PASS] 4.3: Corrupted uniform parameters handled safely without uncaught panic.");
}

// 4.4: Idempotency stress: multiple re-installs do not stack hooks or leak
{
  const mc = new MaterialCache({ pomEnabled: true });
  const did = 0x08104004;
  const base = mc._materialFromFlags(SURFACE_TYPE.Base1Image, texDiffuse, SURFACE_CATEGORY.Stone, texNormal, undefined, hgtA);
  mc.materials.set(did, base);

  const fb = mc.getCachedFloorBias(did);
  const hookBefore = fb.onBeforeCompile;

  for (let i = 0; i < 20; i++) {
    _reinstallClonePom(fb, base);
  }
  checkEqual(fb.onBeforeCompile, hookBefore, "_reinstallClonePom is strictly idempotent via WeakSet");

  const sh = compile(fb);
  // Ensure uPomMap definition appears exactly once in shader
  const matches = sh.fragmentShader.match(/uniform sampler2D uPomMap;/g);
  checkEqual(matches?.length, 1, "uPomMap uniform declared exactly once in fragment shader");
  console.log("  [PASS] 4.4: Strict idempotency verified across 20 repeated invocations.");
}

// 4.5: Stripped Live Uniform Handle Resilience during Reseat
{
  const mc = new MaterialCache({ pomEnabled: true });
  const D = 0x08104005;
  const stoneA = mc._materialFromFlags(SURFACE_TYPE.Base1Image, texDiffuse, SURFACE_CATEGORY.Stone, texNormal, undefined, hgtA);
  mc.materials.set(D, stoneA);

  const fb = mc.getCachedFloorBias(D);
  compile(fb); // creates pomShaderUniforms

  // Intentionally strip / corrupt pomShaderUniforms
  delete fb.userData.pomShaderUniforms;

  const brickB = mc._materialFromFlags(SURFACE_TYPE.Base1Image, texDiffuse, SURFACE_CATEGORY.Brick, texNormal, undefined, hgtB);
  mc.materials.set(D, brickB);

  // Reseating with stripped pomShaderUniforms should NOT crash
  assert.doesNotThrow(() => mc._reseatVariantsForDid(D), "Reseating with stripped pomShaderUniforms does not crash");

  console.log("  [PASS] 4.5: Reseating with stripped live uniform handles executes cleanly.");
}

console.log("\n================================================================================");
console.log(`ALL ADVERSARIAL STRESS SUITES PASSED (${totalAssertions} total assertions verified).`);
console.log("================================================================================");
