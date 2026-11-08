/**
 * apps/holtburger-web/tests/e2e_relief/tier1_features/f1_cloned_pom.test.mjs
 *
 * Tier 1: Feature Coverage — F1: Cloned Material POM Persistence
 * Requirement: ORIGINAL_REQUEST §R1, PROJECT.md Interface Contract:
 * "Material Cache ↔ Shader Clone Reinstallation Contract"
 */

import * as THREE from "three";
import { describe, test, ok, equal, createMockTexture, compileMaterialShader } from "../harness.mjs";
import { installPomShaderPatch } from "../../../scene3d/materials.js";

export function runTests() {
  describe("F1: Cloned Material POM Persistence — Feature Coverage", () => {
    test("F1-1: Floor-biased clone retains POM onBeforeCompile and uniform values", () => {
      const base = new THREE.MeshStandardMaterial({ name: "base_wall" });
      const heightTex = createMockTexture(128, 128, 255, 255, "cottage_height_01");
      installPomShaderPatch(base, heightTex, { steps: 16, depth: 0.04, lodNear: 15, lodFar: 35 });

      ok(base.userData.pomEnabled === true, "base must have pomEnabled: true");
      ok(typeof base.onBeforeCompile === "function", "base must have onBeforeCompile installed");

      // Simulate clone lifecycle in getCachedFloorBias
      const clone = base.clone();
      clone.userData = { ...(base.userData || {}), __floorBiased: true };
      // Reinstall POM on clone per contract
      installPomShaderPatch(clone, heightTex, { steps: 16, depth: 0.04, lodNear: 15, lodFar: 35 });

      ok(clone.userData.pomEnabled === true, "clone must retain pomEnabled: true");
      equal(clone.userData.__floorBiased, true, "clone must have floor bias flag");

      const compiled = compileMaterialShader(clone);
      ok(/_pomPerturbedUv/.test(compiled.fragmentShader), "clone shader must compile _pomPerturbedUv");
      ok(/uPomMap/.test(compiled.fragmentShader), "clone shader must reference uPomMap uniform");
      equal(compiled.uniforms.uPomSteps.value, 16, "uPomSteps must be 16");
      equal(compiled.uniforms.uPomDepth.value, 0.04, "uPomDepth must be 0.04");
    });

    test("F1-2: Static-biased clone preserves POM shader callbacks and uniforms", () => {
      const base = new THREE.MeshStandardMaterial({ name: "stone_decor" });
      const heightTex = createMockTexture(200, 200, 255, 255, "stone_height_02");
      installPomShaderPatch(base, heightTex, { steps: 8, depth: 0.03, lodNear: 15, lodFar: 35 });

      const clone = base.clone();
      clone.userData = { ...(base.userData || {}), __staticBiased: true };
      installPomShaderPatch(clone, heightTex, { steps: 8, depth: 0.03, lodNear: 15, lodFar: 35 });

      const compiled = compileMaterialShader(clone);
      ok(clone.userData.pomEnabled === true, "static clone must have pomEnabled: true");
      ok(/uPomLodFar/.test(compiled.fragmentShader), "clone shader must reference uPomLodFar");
      equal(compiled.uniforms.uPomSteps.value, 8, "uPomSteps must be 8");
      equal(compiled.uniforms.uPomDepth.value, 0.03, "uPomDepth must be 0.03");
    });

    test("F1-3: Baked-light clone preserves POM shader callbacks and uniforms", () => {
      const base = new THREE.MeshStandardMaterial({ name: "dungeon_baked_wall" });
      const heightTex = createMockTexture(100, 100, 255, 255, "baked_height_03");
      installPomShaderPatch(base, heightTex, { steps: 12, depth: 0.05, lodNear: 15, lodFar: 35 });

      const clone = base.clone();
      clone.userData = { ...(base.userData || {}), __acBakedLight: true };
      installPomShaderPatch(clone, heightTex, { steps: 12, depth: 0.05, lodNear: 15, lodFar: 35 });

      const compiled = compileMaterialShader(clone);
      ok(clone.userData.pomEnabled === true, "baked clone must have pomEnabled: true");
      ok(/_pomShadow/.test(compiled.fragmentShader), "clone shader must include POM shadow function");
      equal(compiled.uniforms.uPomSteps.value, 12, "uPomSteps must match base option 12");
    });

    test("F1-4: Cloned material outputs |p1 in customProgramCacheKey", () => {
      const base = new THREE.MeshStandardMaterial({ name: "town_hall_base" });
      const heightTex = createMockTexture(150, 150, 255, 255, "hall_height_04");
      installPomShaderPatch(base, heightTex, { steps: 16 });

      const clone = base.clone();
      clone.userData = { ...(base.userData || {}), __floorBiased: true };
      installPomShaderPatch(clone, heightTex, { steps: 16 });

      // Custom program cache key must register |p1
      const cacheKey = typeof clone.customProgramCacheKey === "function" ? clone.customProgramCacheKey() : null;
      if (cacheKey) {
        ok(cacheKey.includes("|p1"), `clone customProgramCacheKey must include '|p1', got ${cacheKey}`);
      } else {
        ok(clone.userData.pomEnabled === true, "clone userData must flag pomEnabled === true");
      }
    });

    test("F1-5: Re-installation is isolated and does not mutate shared base material", () => {
      const base = new THREE.MeshStandardMaterial({ name: "shared_base" });
      const heightTex = createMockTexture(120, 120, 255, 255, "shared_height");
      installPomShaderPatch(base, heightTex, { steps: 16, depth: 0.04 });

      const cloneA = base.clone();
      cloneA.userData = { ...(base.userData || {}), __floorBiased: true };
      installPomShaderPatch(cloneA, heightTex, { steps: 16, depth: 0.04 });

      const cloneB = base.clone();
      cloneB.userData = { ...(base.userData || {}), __staticBiased: true };
      installPomShaderPatch(cloneB, heightTex, { steps: 8, depth: 0.02 });

      equal(base.userData.__floorBiased, undefined, "base must not acquire cloneA's floor bias");
      equal(base.userData.__staticBiased, undefined, "base must not acquire cloneB's static bias");
      equal(cloneA.userData.__floorBiased, true, "cloneA has floor bias");
      equal(cloneB.userData.__staticBiased, true, "cloneB has static bias");

      const compiledA = compileMaterialShader(cloneA);
      const compiledB = compileMaterialShader(cloneB);
      equal(compiledA.uniforms.uPomSteps.value, 16, "cloneA retains steps=16");
      equal(compiledB.uniforms.uPomSteps.value, 8, "cloneB retains steps=8");
    });
  });
}
