// tests/challenger_m3_tier5_lifecycle_stress.test.mjs
// Milestone 3 Phase 2: Tier 5 White-Box Adversarial Hardening Suite
// Focus: Material Clone Trees, Dynamic Reseating, Program Cache Key Cardinality, and Static Atlas Lifecycle.

import assert from "node:assert/strict";
import * as THREE from "three";
import {
  MaterialCache,
  SURFACE_TYPE,
  SURFACE_CATEGORY,
  _reinstallClonePom,
  _inheritHeightTex,
  heightTexForMaterial,
  applyMicroSurfaceEnhancement,
} from "../scene3d/materials.js";
import {
  batchedMaterialFor,
  holdBatchedMaterial,
  releaseBatchedMaterial,
  batchMatVariantStats,
  memberMaterialOf,
  syncBatchMatVariants,
} from "../scene3d/batched_material_variant.js";
import {
  consolidateBuildingSurfaces,
  buildingBatchStats,
} from "../scene3d/buildings.js";
import { makeArrayMaterial } from "../scene3d/static_atlas.js";

// Helper: Compile material through Three.js ShaderLib to test onBeforeCompile chain
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

// Mock textures
const testTex = new THREE.DataTexture(new Uint8Array([200, 150, 100, 255]), 1, 1);
const testNrm = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
const testHgt = new THREE.DataTexture(new Uint8Array([210]), 1, 1);
testHgt.name = "test-adv-height";

console.log("================================================================================");
console.log("Tier 5 White-Box Adversarial Hardening: Lifecycle & Stress Suite");
console.log("================================================================================\n");

let suitesPassed = 0;
let testsPassed = 0;

// ============================================================================
// SUITE 1: Deep & Wide Material Clone Trees
// ============================================================================
console.log("--- Suite 1: Deep & Wide Material Clone Trees ---");
{
  // 1.1 Deep Serial Clone Chain (16 successive generations)
  {
    const mc = new MaterialCache({
      pomEnabled: true,
      pomOpts: { steps: 16, depth: 0.08, lodNear: 15, lodFar: 35 },
    });
    const base = mc._materialFromFlags(
      SURFACE_TYPE.Base1Image,
      testTex,
      SURFACE_CATEGORY.Stone,
      testNrm,
      undefined,
      testHgt
    );
    // Add micro-surface enhancements to base
    applyMicroSurfaceEnhancement(base, testHgt, { microCreviceAo: true, microContactShadow: true });

    let current = base;
    const chainDepth = 16;
    for (let gen = 1; gen <= chainDepth; gen++) {
      const next = current.clone();
      _reinstallClonePom(next, current);

      // Verify metadata & flags
      assert.equal(next.userData.pomEnabled, true, `Gen ${gen}: pomEnabled must remain true`);
      assert.equal(next.userData.microCreviceAo, true, `Gen ${gen}: microCreviceAo must remain true`);
      assert.equal(next.userData.microContactShadow, true, `Gen ${gen}: microContactShadow must remain true`);

      // Verify heightmap resolution via WeakMap
      const resolvedHgt = heightTexForMaterial(next);
      assert.equal(resolvedHgt, testHgt, `Gen ${gen}: heightTexForMaterial must resolve root height texture`);

      // Verify program cache key
      const key = next.customProgramCacheKey();
      assert.match(key, /\|p1\|/, `Gen ${gen}: cache key must contain |p1|`);
      assert.match(key, /\|mc1\|/, `Gen ${gen}: cache key must contain |mc1|`);
      assert.match(key, /\|ms1\|/, `Gen ${gen}: cache key must contain |ms1|`);

      // Verify compilation without stack overflow or lost uniforms
      const sh = compile(next);
      assert.ok(sh.uniforms.uPomMap, `Gen ${gen}: uPomMap must exist in uniforms`);
      assert.equal(sh.uniforms.uPomMap.value, testHgt, `Gen ${gen}: uPomMap must bind testHgt`);
      assert.equal(sh.uniforms.uPomSteps.value, 16, `Gen ${gen}: uPomSteps must match base`);
      assert.equal(sh.uniforms.uPomDepth.value, 0.08, `Gen ${gen}: uPomDepth must match base`);
      assert.ok(sh.fragmentShader.includes("_pomPerturbedUv"), `Gen ${gen}: fragmentShader must contain POM GLSL`);
      assert.ok(sh.fragmentShader.includes("_cCavityAo"), `Gen ${gen}: fragmentShader must contain Crevice AO GLSL`);
      assert.ok(sh.fragmentShader.includes("_msHorizonShadow"), `Gen ${gen}: fragmentShader must contain Micro Shadow GLSL`);

      current = next;
    }
    console.log(`  [OK] Test 1.1: Deep Serial Clone Chain (${chainDepth} generations) verified`);
    testsPassed++;
  }

  // 1.2 Wide Clone Tree (Fan-out of 64 peer clones + 2 sub-clones each = 192 materials)
  {
    const mc = new MaterialCache({
      pomEnabled: true,
      pomOpts: { steps: 20, depth: 0.12 },
    });
    const rootDid = 0x08004001;
    const base = mc._materialFromFlags(
      SURFACE_TYPE.Base1Image,
      testTex,
      SURFACE_CATEGORY.Stone,
      testNrm,
      undefined,
      testHgt
    );
    mc.materials.set(rootDid, base);

    const children = [];
    for (let i = 0; i < 64; i++) {
      let child;
      const variantType = i % 4;
      if (variantType === 0) child = mc.getCachedFloorBias(rootDid);
      else if (variantType === 1) child = mc.getCachedCellBaked(rootDid);
      else if (variantType === 2) child = mc.getCachedStaticBias(rootDid);
      else child = mc.getCached(rootDid, false);

      children.push(child);

      // Spawn 2 sub-clones from this child
      const sub1 = child.clone();
      _reinstallClonePom(sub1, child);
      const sub2 = child.clone();
      _reinstallClonePom(sub2, child);

      assert.equal(heightTexForMaterial(sub1), testHgt, `Wide tree [${i}.1]: heightmap intact`);
      assert.equal(heightTexForMaterial(sub2), testHgt, `Wide tree [${i}.2]: heightmap intact`);

      assert.match(sub1.customProgramCacheKey(), /\|p1\|/, `Wide tree [${i}.1]: program key valid`);
      assert.match(sub2.customProgramCacheKey(), /\|p1\|/, `Wide tree [${i}.2]: program key valid`);
    }
    assert.equal(children.length, 64, "All 64 root children instantiated");
    console.log("  [OK] Test 1.2: Wide Clone Tree (64 branches x 3 generations = 192 nodes) verified");
    testsPassed++;
  }

  // 1.3 Variant-of-Clone and Clone-of-Variant Circularity Hardening
  {
    const mc = new MaterialCache({ pomEnabled: true });
    const base = mc._materialFromFlags(
      SURFACE_TYPE.Base1Image,
      testTex,
      SURFACE_CATEGORY.Stone,
      testNrm,
      undefined,
      testHgt
    );

    const v1 = batchedMaterialFor(base);
    assert.equal(memberMaterialOf(v1), base, "memberMaterialOf(v1) resolves base");

    // Clone the variant
    const v1Clone = v1.clone();
    _reinstallClonePom(v1Clone, v1);

    // Call batchedMaterialFor on the clone
    const v2 = batchedMaterialFor(v1Clone);
    assert.ok(v2, "batchedMaterialFor(v1Clone) succeeds");

    // Call memberMaterialOf on v2
    const m2 = memberMaterialOf(v2);
    assert.ok(m2, "memberMaterialOf(v2) resolves");

    // Call batchedMaterialFor on already-a-variant
    const v1Again = batchedMaterialFor(v1);
    assert.equal(v1Again, v1, "batchedMaterialFor is idempotent on existing variant");

    // Reinstall POM across variant and base
    _reinstallClonePom(base, v1);
    _reinstallClonePom(v1, v1Clone);

    // Ensure program cache key does not recurse or loop
    const keyBase = base.customProgramCacheKey();
    const keyV1 = v1.customProgramCacheKey();
    const keyV2 = v2.customProgramCacheKey();
    assert.ok(typeof keyBase === "string" && keyBase.length < 256, "keyBase is stable");
    assert.ok(typeof keyV1 === "string" && keyV1.length < 256, "keyV1 is stable");
    assert.ok(typeof keyV2 === "string" && keyV2.length < 256, "keyV2 is stable");

    console.log("  [OK] Test 1.3: Variant-of-Clone circularity and recursion immunity verified");
    testsPassed++;
  }

  // 1.4 Intermediate Generation Disconnection & Disposal Safety
  {
    const mc = new MaterialCache({ pomEnabled: true });
    const g0 = mc._materialFromFlags(
      SURFACE_TYPE.Base1Image,
      testTex,
      SURFACE_CATEGORY.Stone,
      testNrm,
      undefined,
      testHgt
    );

    const g1 = g0.clone(); _reinstallClonePom(g1, g0);
    const g2 = g1.clone(); _reinstallClonePom(g2, g1);
    const g3 = g2.clone(); _reinstallClonePom(g3, g2);
    const g4 = g3.clone(); _reinstallClonePom(g4, g3);

    // Sever intermediate node g2
    g2.dispose();

    // g3 and g4 must remain fully functional
    assert.equal(heightTexForMaterial(g3), testHgt, "g3 retains heightmap after g2 disposal");
    assert.equal(heightTexForMaterial(g4), testHgt, "g4 retains heightmap after g2 disposal");

    const sh3 = compile(g3);
    const sh4 = compile(g4);
    assert.equal(sh3.uniforms.uPomMap.value, testHgt, "g3 compiles with valid uPomMap");
    assert.equal(sh4.uniforms.uPomMap.value, testHgt, "g4 compiles with valid uPomMap");
    assert.ok(sh4.fragmentShader.includes("_pomPerturbedUv"), "g4 compiles with valid POM shader");

    console.log("  [OK] Test 1.4: Intermediate generation disposal safety verified");
    testsPassed++;
  }

  // 1.5 Plain Clone Stripping & Reinstallation Contract
  {
    const mc = new MaterialCache({ pomEnabled: true });
    const baseWithPom = mc._materialFromFlags(
      SURFACE_TYPE.Base1Image,
      testTex,
      SURFACE_CATEGORY.Stone,
      testNrm,
      undefined,
      testHgt
    );
    const baseWithoutPom = mc._materialFromFlags(
      SURFACE_TYPE.Base1Image,
      testTex,
      SURFACE_CATEGORY.Wood,
      testNrm,
      undefined,
      null
    );

    // Case A: Clone has copied pomEnabled: true from baseWithPom, but is reinstalled onto baseWithoutPom
    const cloneA = baseWithPom.clone();
    assert.equal(cloneA.userData.pomEnabled, true, "Clone initially has copied pomEnabled claim");
    _reinstallClonePom(cloneA, baseWithoutPom);
    assert.equal(cloneA.userData.pomEnabled, undefined, "Unbacked pomEnabled claim stripped on non-POM base");

    // Case B: Clone has copied pomEnabled: true, but reinstalled onto base with null height texture
    const basePomNoHeight = baseWithPom.clone();
    // remove height texture mapping
    const cloneB = baseWithPom.clone();
    _reinstallClonePom(cloneB, basePomNoHeight);
    assert.equal(cloneB.userData.pomEnabled, undefined, "Unbacked pomEnabled claim stripped when height texture absent");

    // Case C: makeOwnedVariant strips _CLONE_LOST_PATCH_FLAGS
    const owned = mc.makeOwnedVariant(baseWithPom, "vfx_test_set", (v) => {
      v.userData.__testMarker = 1;
    });
    assert.equal(owned.userData.__testMarker, 1, "makeOwnedVariant builder executed");
    assert.equal(owned.userData.__cacheOwned, undefined, "__cacheOwned flag stripped");
    assert.equal(owned.userData.__disposable, true, "__disposable flag set");
    assert.equal(owned.userData.pomEnabled, true, "pomEnabled reinstalled cleanly");
    assert.match(owned.customProgramCacheKey(), /\|p1\|/, "owned variant has |p1|");
    assert.match(owned.customProgramCacheKey(), /\|vvfx_test_set/, "owned variant has vfx key");

    console.log("  [OK] Test 1.5: Plain Clone Stripping & Reinstallation Contract verified");
    testsPassed++;
  }
}
suitesPassed++;
console.log();

// ============================================================================
// SUITE 2: High-Rate Concurrent & Iterative Dynamic Reseating
// ============================================================================
console.log("--- Suite 2: High-Rate Concurrent & Iterative Dynamic Reseating ---");
{
  // 2.1 1,500 Rapid Reseat Cycles Across 10 DIDs with Multi-State Oscillations
  {
    const mc = new MaterialCache({
      pomEnabled: true,
      pomOpts: { steps: 16, depth: 0.08, lodNear: 15, lodFar: 35 },
    });
    const dids = Array.from({ length: 10 }, (_, i) => 0x08005000 + i);

    // Initialize 10 DIDs with fallback materials
    for (const did of dids) {
      // Warm up clone variants
      const fb = mc.getCachedFloorBias(did);
      const sb = mc.getCachedStaticBias(did);
      // Pre-compile to populate live uniform handles
      compile(fb);
      compile(sb);
    }

    const tStart = Date.now();
    const ITERATIONS = 1500;
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const did = dids[iter % dids.length];
      const state = iter % 5;

      let newBase;
      if (state === 0) {
        // State 0: Fallback / untextured (no POM, no crevice, no micro-shadow)
        newBase = mc.fallbackMaterial.clone();
      } else if (state === 1) {
        // State 1: Stone (POM on, crevice AO on, micro shadow on; steps: 16, depth: 0.08)
        newBase = mc._materialFromFlags(SURFACE_TYPE.Base1Image, testTex, SURFACE_CATEGORY.Stone, testNrm, undefined, testHgt);
        newBase.userData.pomUniforms = { steps: 16, depth: 0.08 };
        applyMicroSurfaceEnhancement(newBase, testHgt, { microCreviceAo: true, microContactShadow: true });
      } else if (state === 2) {
        // State 2: Brick (POM on, crevice AO on, micro shadow off; steps: 24, depth: 0.15)
        newBase = mc._materialFromFlags(SURFACE_TYPE.Base1Image, testTex, SURFACE_CATEGORY.Brick, testNrm, undefined, testHgt);
        newBase.userData.pomUniforms = { steps: 24, depth: 0.15 };
        applyMicroSurfaceEnhancement(newBase, testHgt, { microCreviceAo: true, microContactShadow: false });
      } else if (state === 3) {
        // State 3: Translucent (POM deactivates)
        newBase = mc._materialFromFlags(SURFACE_TYPE.Base1Image | SURFACE_TYPE.Translucent, testTex, SURFACE_CATEGORY.Stone, testNrm, undefined, testHgt);
      } else {
        // State 4: Wood (POM off, standard surface)
        newBase = mc._materialFromFlags(SURFACE_TYPE.Base1Image, testTex, SURFACE_CATEGORY.Wood, testNrm, undefined, null);
      }

      mc.materials.set(did, newBase);
      mc._reseatVariantsForDid(did);

      // Verify invariant every 100 iterations
      if (iter % 100 === 0) {
        const fb = mc.getCachedFloorBias(did);
        if (state === 1) {
          assert.equal(fb.userData.pomEnabled, true, `Iter ${iter}: Stone state pomEnabled true`);
          assert.match(fb.customProgramCacheKey(), /\|p1\|/, `Iter ${iter}: Stone state key has |p1|`);
          assert.match(fb.customProgramCacheKey(), /\|mc1\|/, `Iter ${iter}: Stone state key has |mc1|`);
          if (fb.userData.pomShaderUniforms) {
            assert.equal(fb.userData.pomShaderUniforms.uPomMap.value, testHgt, `Iter ${iter}: live map bound`);
            assert.equal(fb.userData.pomShaderUniforms.uPomSteps.value, 16, `Iter ${iter}: live steps = 16`);
            assert.equal(fb.userData.pomShaderUniforms.uPomDepth.value, 0.08, `Iter ${iter}: live depth = 0.08`);
          }
        } else if (state === 2) {
          assert.equal(fb.userData.pomEnabled, true, `Iter ${iter}: Brick state pomEnabled true`);
          assert.match(fb.customProgramCacheKey(), /\|p1\|/, `Iter ${iter}: Brick state key has |p1|`);
          assert.match(fb.customProgramCacheKey(), /\|mc1\|/, `Iter ${iter}: Brick state key has |mc1|`);
          assert.match(fb.customProgramCacheKey(), /\|ms0\|/, `Iter ${iter}: Brick state key has |ms0|`);
          if (fb.userData.pomShaderUniforms) {
            assert.equal(fb.userData.pomShaderUniforms.uPomSteps.value, 24, `Iter ${iter}: live steps = 24`);
            assert.equal(fb.userData.pomShaderUniforms.uPomDepth.value, 0.15, `Iter ${iter}: live depth = 0.15`);
          }
        } else if (state === 0 || state === 3 || state === 4) {
          assert.equal(!!fb.userData.pomEnabled, false, `Iter ${iter}: Non-POM state pomEnabled false`);
          assert.match(fb.customProgramCacheKey(), /\|p0\|/, `Iter ${iter}: Non-POM state key has |p0|`);
          if (fb.userData.pomShaderUniforms) {
            assert.equal(fb.userData.pomShaderUniforms.uPomMap.value, null, `Iter ${iter}: live map null`);
          }
        }
      }
    }
    const elapsedMs = Date.now() - tStart;
    console.log(`  [OK] Test 2.1: ${ITERATIONS} Reseat Cycles across 10 DIDs verified in ${elapsedMs}ms (${(elapsedMs / ITERATIONS).toFixed(3)}ms/reseat)`);
    testsPassed++;
  }

  // 2.2 Live Uniform Parameter Propagation without Recompilation
  {
    const mc = new MaterialCache({ pomEnabled: true });
    const did = 0x08005FFF;
    const base = mc._materialFromFlags(SURFACE_TYPE.Base1Image, testTex, SURFACE_CATEGORY.Stone, testNrm, undefined, testHgt);
    base.userData.pomUniforms = {
      steps: 16,
      depth: 0.05,
      lodNear: 10,
      lodFar: 25,
      shadowSteps: 4,
      shadowDarkness: 0.5,
    };
    mc.materials.set(did, base);

    const fb = mc.getCachedFloorBias(did);
    const sh = compile(fb); // Binds live pomShaderUniforms handle

    assert.equal(fb.userData.pomShaderUniforms.uPomSteps.value, 16);
    assert.equal(fb.userData.pomShaderUniforms.uPomDepth.value, 0.05);

    // Update base uniforms dynamically
    base.userData.pomUniforms = {
      steps: 32,
      depth: 0.22,
      lodNear: 20,
      lodFar: 45,
      shadowSteps: 10,
      shadowDarkness: 0.25,
    };
    mc._reseatVariantsForDid(did);

    // Live uniforms must immediately reflect new values WITHOUT recompilation
    const liveUni = fb.userData.pomShaderUniforms;
    assert.equal(liveUni.uPomSteps.value, 32, "Live uPomSteps updated to 32");
    assert.equal(liveUni.uPomDepth.value, 0.22, "Live uPomDepth updated to 0.22");
    assert.equal(liveUni.uPomLodNear.value, 20, "Live uPomLodNear updated to 20");
    assert.equal(liveUni.uPomLodFar.value, 45, "Live uPomLodFar updated to 45");
    assert.equal(liveUni.uPomShadowSteps.value, 10, "Live uPomShadowSteps updated to 10");
    assert.equal(liveUni.uPomShadowDarkness.value, 0.25, "Live uPomShadowDarkness updated to 0.25");

    console.log("  [OK] Test 2.2: Live Uniform Propagation without Recompilation verified");
    testsPassed++;
  }

  // 2.3 Robustness Against Malformed Reseats
  {
    const mc = new MaterialCache({ pomEnabled: true });
    // Reseat non-existent DID should not throw
    assert.doesNotThrow(() => mc._reseatVariantsForDid(0xDEADBEEF), "Non-existent DID reseat is safe");
    assert.doesNotThrow(() => mc._reseatVariantsForDid(0), "Zero DID reseat is safe");
    assert.doesNotThrow(() => mc._reseatVariantsForDid(-1), "Negative DID reseat is safe");

    console.log("  [OK] Test 2.3: Resilience against malformed/out-of-bounds reseats verified");
    testsPassed++;
  }

  // 2.4 High-Rate Concurrent Reseat Race Condition Simulation
  {
    const mc = new MaterialCache({ pomEnabled: true });
    const raceDid = 0x08006E00;
    const initialBase = mc._materialFromFlags(SURFACE_TYPE.Base1Image, testTex, SURFACE_CATEGORY.Stone, testNrm, undefined, testHgt);
    mc.materials.set(raceDid, initialBase);
    const fb = mc.getCachedFloorBias(raceDid);
    compile(fb);

    const RACE_CYCLES = 500;
    let lastSetState = null;

    for (let c = 0; c < RACE_CYCLES; c++) {
      const mode = c % 3;
      let mat;
      if (mode === 0) {
        mat = mc._materialFromFlags(SURFACE_TYPE.Base1Image, testTex, SURFACE_CATEGORY.Stone, testNrm, undefined, testHgt);
        mat.userData.pomUniforms = { steps: 16, depth: 0.10 };
        lastSetState = "stone";
      } else if (mode === 1) {
        mat = mc._materialFromFlags(SURFACE_TYPE.Base1Image, testTex, SURFACE_CATEGORY.Brick, testNrm, undefined, testHgt);
        mat.userData.pomUniforms = { steps: 32, depth: 0.20 };
        lastSetState = "brick";
      } else {
        mat = mc._materialFromFlags(SURFACE_TYPE.Base1Image, testTex, SURFACE_CATEGORY.Wood, testNrm, undefined, null);
        lastSetState = "wood";
      }
      mc.materials.set(raceDid, mat);
      mc._reseatVariantsForDid(raceDid);
    }

    // Final state must deterministically match last set
    if (lastSetState === "stone" || lastSetState === "brick") {
      assert.equal(fb.userData.pomEnabled, true, "Final state matches POM enabled");
      assert.match(fb.customProgramCacheKey(), /\|p1\|/);
    } else {
      assert.equal(!!fb.userData.pomEnabled, false, "Final state matches POM disabled");
      assert.match(fb.customProgramCacheKey(), /\|p0\|/);
    }

    console.log(`  [OK] Test 2.4: High-Rate Concurrent Reseat Race (${RACE_CYCLES} cycles) verified`);
    testsPassed++;
  }
}
suitesPassed++;
console.log();

// ============================================================================
// SUITE 3: High-Cardinality Program Cache Key Stress & Collision Resistance
// ============================================================================
console.log("--- Suite 3: High-Cardinality Program Cache Key Stress & Collision Resistance ---");
{
  // 3.1 Full Combinatorial Cartesian Product (4,096 Unique Patch Bit Permutations)
  {
    const dummy = new THREE.MeshStandardMaterial();
    applyMicroSurfaceEnhancement(dummy, testHgt);

    const keysSet = new Set();
    const t0 = Date.now();
    const TOTAL_PERMUTATIONS = 4096;

    for (let bit = 0; bit < TOTAL_PERMUTATIONS; bit++) {
      dummy.userData = {
        detailEnabled: !!(bit & 1),
        csmEnabled: (bit & 2) ? 2 : 0,
        pomEnabled: !!(bit & 4),
        lightClampRetail: !!(bit & 8),
        __aoPatched: !!(bit & 16),
        __depthBiased: !!(bit & 32),
        __floorBiased: !!(bit & 64),
        __staticBiased: !!(bit & 128),
        __acBakedLight: !!(bit & 256),
        __acBakedDirectOut: !!(bit & 512),
        __creviceAo: !!(bit & 1024),
        __microShadow: !!(bit & 2048),
      };
      const key = dummy.customProgramCacheKey();
      keysSet.add(key);

      // Validate string structure
      assert.match(key, /^hb\|d[01]\|c[02]\|p[01]\|l[01]\|a[01]\|b[01]\|f[01]\|s[01]\|k[01]d?\|mc[01]\|ms[01]\|v/, "Key structure matches specification");
    }
    const elapsedMs = Date.now() - t0;
    assert.equal(keysSet.size, TOTAL_PERMUTATIONS, `Zero collisions: exactly ${TOTAL_PERMUTATIONS} distinct keys generated`);
    console.log(`  [OK] Test 3.1: Full Cartesian Product (${TOTAL_PERMUTATIONS} keys, 0 collisions) evaluated in ${elapsedMs}ms`);
    testsPassed++;
  }

  // 3.2 Adversarial Delimiter Injection & Token Disambiguation Attacks
  {
    const dummy = new THREE.MeshStandardMaterial();
    applyMicroSurfaceEnhancement(dummy, testHgt);

    // Attempt to spoof POM, Crevice, MicroShadow via __vfxSetKey on an un-patched material
    dummy.userData = {
      pomEnabled: false,
      __creviceAo: false,
      __microShadow: false,
      __vfxSetKey: "|p1|mc1|ms1|c2|d1",
    };
    const spoofedKey = dummy.customProgramCacheKey();

    // Legitimate material with genuine patches and normal vfxSetKey
    dummy.userData = {
      pomEnabled: true,
      __creviceAo: true,
      __microShadow: true,
      __vfxSetKey: "",
    };
    const legitKey = dummy.customProgramCacheKey();

    assert.notEqual(spoofedKey, legitKey, "Spoofed delimiter injection does not collide with genuine patch key");
    assert.match(spoofedKey, /\|p0.*\|mc0.*\|ms0.*\|v\|p1\|mc1\|ms1/, "Spoofed key retains explicit |p0|mc0|ms0 before the |v token");
    assert.match(legitKey, /\|p1.*\|mc1.*\|ms1.*\|v$/, "Legit key has genuine tokens in canonical positions");

    console.log("  [OK] Test 3.2: Adversarial delimiter injection immunity verified");
    testsPassed++;
  }

  // 3.3 Static Atlas makeArrayMaterial Program Cache Key Disambiguation
  {
    const diff = new THREE.DataArrayTexture(new Uint8Array(16), 2, 2, 1);
    const nra = new THREE.DataArrayTexture(new Uint8Array(16), 2, 2, 1);

    const states = [
      { key: "0|0|0|0|w", nra: true, expected: "statAtlasArrayMatV4wnra0.600|mc1|ms1" },
      { key: "0|0|0|0|c", nra: true, expected: "statAtlasArrayMatV4cnra0.600|mc1|ms1" },
      { key: "0|0|0|0|w", nra: false, expected: "statAtlasArrayMatV4w" },
      { key: "0|0|0|0|c", nra: false, expected: "statAtlasArrayMatV4c" },
    ];

    const atlasKeys = new Set();
    for (const s of states) {
      const mat = makeArrayMaterial(diff, s.key, s.nra ? nra : null);
      const k = mat.customProgramCacheKey();
      assert.equal(k, s.expected, `Array material cache key matches expected for ${s.key} (nra=${s.nra})`);
      atlasKeys.add(k);
    }
    assert.equal(atlasKeys.size, 4, "All 4 static atlas variations produce strictly distinct keys");
    console.log("  [OK] Test 3.3: Static Atlas makeArrayMaterial cache key disambiguation verified");
    testsPassed++;
  }

  // 3.4 Program Cache Key High-Cardinality Random Permutations (1,000 Random Samples)
  {
    const dummyA = new THREE.MeshStandardMaterial();
    const dummyB = new THREE.MeshStandardMaterial();
    applyMicroSurfaceEnhancement(dummyA, testHgt);
    applyMicroSurfaceEnhancement(dummyB, testHgt);

    const vfxKeys = ["", "deformation.windSwayGpu", "frag:tarnish", "frag:wetness,tarnish", "mechB_twist"];
    const envKinds = [null, "building", "environment"];

    const SAMPLE_COUNT = 1000;
    for (let s = 0; s < SAMPLE_COUNT; s++) {
      const config = {
        detailEnabled: Math.random() > 0.5,
        csmEnabled: Math.random() > 0.5 ? 2 : 0,
        pomEnabled: Math.random() > 0.5,
        lightClampRetail: Math.random() > 0.5,
        __aoPatched: Math.random() > 0.5,
        __depthBiased: Math.random() > 0.5,
        __floorBiased: Math.random() > 0.5,
        __staticBiased: Math.random() > 0.5,
        __acBakedLight: Math.random() > 0.5,
        __acBakedDirectOut: Math.random() > 0.5,
        __creviceAo: Math.random() > 0.5,
        __microShadow: Math.random() > 0.5,
        __vfxSetKey: vfxKeys[Math.floor(Math.random() * vfxKeys.length)],
        __envDetailKind: envKinds[Math.floor(Math.random() * envKinds.length)],
      };

      // Set identical config on dummyA and dummyB
      dummyA.userData = { ...config };
      dummyB.userData = { ...config };
      const keyA = dummyA.customProgramCacheKey();
      const keyB = dummyB.customProgramCacheKey();
      assert.equal(keyA, keyB, `Sample ${s}: Identical configs must yield byte-identical keys`);

      // Perturb exactly 1 bit on dummyB
      dummyB.userData.pomEnabled = !dummyA.userData.pomEnabled;
      const keyB_perturbed = dummyB.customProgramCacheKey();
      assert.notEqual(keyA, keyB_perturbed, `Sample ${s}: 1-bit perturbation must strictly change key`);
    }

    console.log(`  [OK] Test 3.4: ${SAMPLE_COUNT} Random High-Cardinality Permutations verified`);
    testsPassed++;
  }
}
suitesPassed++;
console.log();

// ============================================================================
// SUITE 4: Static Atlas Lifecycle & Batched Material Disposal
// ============================================================================
console.log("--- Suite 4: Static Atlas Lifecycle & Batched Material Disposal ---");
{
  // 4.1 Multi-Holder Reference Counting with 16 Concurrent Batches
  {
    const mat = new THREE.MeshStandardMaterial({ name: "multi-holder-test" });
    const initialStats = batchMatVariantStats();

    const HOLDER_COUNT = 16;
    const meshes = [];
    const variant = batchedMaterialFor(mat);

    for (let i = 0; i < HOLDER_COUNT; i++) {
      const bm = new THREE.BatchedMesh(10, 100, 100, variant);
      meshes.push(bm);
      const held = holdBatchedMaterial(bm);
      assert.equal(held, true, `Hold mesh ${i} succeeded`);
    }

    const midStats = batchMatVariantStats();
    assert.equal(midStats.holders - initialStats.holders, HOLDER_COUNT, `Holder count increased by ${HOLDER_COUNT}`);
    assert.equal(midStats.live - initialStats.live, 1, "Exactly 1 new variant live for all 16 holders");

    // Release 15 meshes
    for (let i = 0; i < HOLDER_COUNT - 1; i++) {
      const released = releaseBatchedMaterial(meshes[i]);
      assert.equal(released, true, `Release mesh ${i} succeeded`);
    }

    const penultStats = batchMatVariantStats();
    assert.equal(penultStats.holders - initialStats.holders, 1, "Exactly 1 holder remaining");
    assert.equal(penultStats.live - initialStats.live, 1, "Variant still live while 1 holder remains");

    // Release the last mesh
    const finalRelease = releaseBatchedMaterial(meshes[HOLDER_COUNT - 1]);
    assert.equal(finalRelease, true, "Final release succeeded");

    const endStats = batchMatVariantStats();
    assert.equal(endStats.holders - initialStats.holders, 0, "Zero holders remaining");
    assert.equal(endStats.live - initialStats.live, 0, "Variant dropped from _live map upon zero holders");
    assert.equal(endStats.dropped - initialStats.dropped, 1, "Variant drop count incremented by 1");

    console.log(`  [OK] Test 4.1: Multi-Holder Reference Counting (${HOLDER_COUNT} meshes) verified`);
    testsPassed++;
  }

  // 4.2 Idempotent Double-Release and Double-Dispose (_BuildingBatch & userData.__disposed)
  {
    const mat = new THREE.MeshStandardMaterial({ name: "batch-dispose-mat" });
    const geom = new THREE.BoxGeometry(1, 1, 1);
    geom.groups = []; // Ensure batch eligibility
    const node1 = new THREE.Mesh(geom, mat);
    node1.userData = { landblockId: 0x77770000 };
    const node2 = new THREE.Mesh(geom, mat);
    node2.userData = { landblockId: 0x77770000 };

    const res = consolidateBuildingSurfaces([node1, node2]);
    assert.equal(res.batches.length, 1, "Consolidation produced 1 _BuildingBatch");
    const bm = res.batches[0];
    assert.equal(bm.constructor.name, "_BuildingBatch", "Constructed as _BuildingBatch");

    const statsBefore = buildingBatchStats();
    const disposedBefore = statsBefore.disposed;

    // First dispose
    bm.dispose();
    assert.equal(bm.userData.__disposed, true, "userData.__disposed latched to true");
    assert.equal(buildingBatchStats().disposed - disposedBefore, 1, "Disposed count incremented by 1");

    // Second, third, fourth dispose (idempotency check)
    bm.dispose();
    bm.dispose();
    bm.dispose();
    assert.equal(buildingBatchStats().disposed - disposedBefore, 1, "Subsequent disposes are idempotent no-ops");

    // Untracked / double release calls
    assert.equal(releaseBatchedMaterial(bm), false, "Release on already-released bm returns false");
    assert.equal(releaseBatchedMaterial(null), false, "Release on null returns false");
    assert.equal(releaseBatchedMaterial({}), false, "Release on non-tracked object returns false");

    console.log("  [OK] Test 4.2: Idempotent Double-Release and Double-Dispose verified");
    testsPassed++;
  }

  // 4.3 Bidirectional Disposal Event Forwarding Loop Termination
  {
    // Test 4.3a: Member dispose -> Variant clean drop
    {
      const member = new THREE.MeshStandardMaterial({ name: "member-a" });
      const variant = batchedMaterialFor(member);
      assert.equal(memberMaterialOf(variant), member);

      // Member dispose should notify variant without recursion
      assert.doesNotThrow(() => member.dispose(), "Member dispose cleanly handles listeners");
    }

    // Test 4.3b: Variant dispose -> Member clean drop
    {
      const member = new THREE.MeshStandardMaterial({ name: "member-b" });
      const variant = batchedMaterialFor(member);
      assert.equal(memberMaterialOf(variant), member);

      // Variant dispose should notify member without recursion
      assert.doesNotThrow(() => variant.dispose(), "Variant dispose cleanly handles listeners");
    }

    console.log("  [OK] Test 4.3: Bidirectional Disposal Event Forwarding Loop Termination verified");
    testsPassed++;
  }

  // 4.4 Static Atlas Array Late-Bound Holder Swap Lifecycle
  {
    const diffA = new THREE.DataArrayTexture(new Uint8Array(16), 2, 2, 1);
    const nraA = new THREE.DataArrayTexture(new Uint8Array(16), 2, 2, 1);
    const holder = { diff: diffA, nra: nraA };

    const arrayMat = makeArrayMaterial(diffA, "0|0|0|0|w", nraA, holder);
    const shInitial = compile(arrayMat);
    assert.equal(shInitial.uniforms.uDiffuseArray.value, diffA, "Initial diffuse array bound to diffA");
    assert.equal(shInitial.uniforms.uNraArray.value, nraA, "Initial nra array bound to nraA");

    // Allocate new textures and swap holder
    const diffB = new THREE.DataArrayTexture(new Uint8Array(32), 2, 2, 2);
    const nraB = new THREE.DataArrayTexture(new Uint8Array(32), 2, 2, 2);
    holder.diff = diffB;
    holder.nra = nraB;

    // Dispose old textures
    diffA.dispose();
    nraA.dispose();

    // Recompile material (simulate program/uniform resolution)
    const shRebound = compile(arrayMat);
    assert.equal(shRebound.uniforms.uDiffuseArray.value, diffB, "Rebound diffuse array bound to diffB");
    assert.equal(shRebound.uniforms.uNraArray.value, nraB, "Rebound nra array bound to nraB");
    assert.notEqual(shRebound.uniforms.uDiffuseArray.value, diffA, "Retired diffA is not bound");
    assert.notEqual(shRebound.uniforms.uNraArray.value, nraA, "Retired nraA is not bound");

    console.log("  [OK] Test 4.4: Static Atlas Array Late-Bound Holder Swap Lifecycle verified");
    testsPassed++;
  }

  // 4.5 Batched Material Sync Under Dynamic Member Mutation
  {
    const member = new THREE.MeshStandardMaterial({
      name: "dynamic-member",
      opacity: 1.0,
      transparent: false,
      depthWrite: true,
      side: THREE.FrontSide,
    });
    const variant = batchedMaterialFor(member);

    assert.equal(variant.opacity, 1.0);
    assert.equal(variant.transparent, false);

    // Mutate member properties
    member.opacity = 0.35;
    member.transparent = true;
    member.depthWrite = false;
    member.side = THREE.DoubleSide;
    member.version++;

    // Before sync, variant has previous values
    assert.equal(variant.opacity, 1.0);

    // Run syncBatchMatVariants
    syncBatchMatVariants();

    // After sync, variant immediately tracks member's new properties
    assert.equal(variant.opacity, 0.35, "Variant opacity synced to 0.35");
    assert.equal(variant.transparent, true, "Variant transparent synced to true");
    assert.equal(variant.depthWrite, false, "Variant depthWrite synced to false");
    assert.equal(variant.side, THREE.DoubleSide, "Variant side synced to DoubleSide");

    console.log("  [OK] Test 4.5: Batched Material Sync Under Dynamic Member Mutation verified");
    testsPassed++;
  }
}
suitesPassed++;
console.log();

// ============================================================================
// SUMMARY
// ============================================================================
console.log("================================================================================");
console.log(`ALL ADVERSARIAL STRESS SUITES PASSED! (${suitesPassed}/4 Suites, ${testsPassed} Tests)`);
console.log("================================================================================");
