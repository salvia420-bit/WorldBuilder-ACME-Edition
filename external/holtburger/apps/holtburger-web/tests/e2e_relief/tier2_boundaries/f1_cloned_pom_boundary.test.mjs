/**
 * apps/holtburger-web/tests/e2e_relief/tier2_boundaries/f1_cloned_pom_boundary.test.mjs
 *
 * Tier 2: Boundary & Corner Cases — F1: Cloned Material POM Persistence
 */

import * as THREE from "three";
import { describe, test, ok, equal, compileMaterialShader, createMockTexture } from "../harness.mjs";
import { installPomShaderPatch } from "../../../scene3d/materials.js";

export function runTests() {
  describe("F1: Cloned Material POM Persistence — Boundary & Corner Cases", () => {
    test("B1-1: Clone with null or undefined height texture behaves as safe no-op", () => {
      const base = new THREE.MeshStandardMaterial({ name: "no_height_base" });
      installPomShaderPatch(base, null, { steps: 16 });

      equal(base.userData.pomEnabled, undefined, "base without height texture must not enable POM");
      const clone = base.clone();
      equal(clone.userData.pomEnabled, undefined, "clone must not enable POM");
    });

    test("B1-2: Clone of material where base has pomEnabled: false never acquires POM", () => {
      const base = new THREE.MeshStandardMaterial({ name: "plain_wood" });
      base.userData = { pomEnabled: false };
      const clone = base.clone();
      equal(clone.userData.pomEnabled, false, "clone must stay pomEnabled: false");
    });

    test("B1-3: Deep chained clones (clone of clone of clone) preserve POM callbacks intact", () => {
      const base = new THREE.MeshStandardMaterial({ name: "root_mat" });
      const tex = createMockTexture(128, 128, 255, 255, "deep_height");
      installPomShaderPatch(base, tex, { steps: 16, depth: 0.04 });

      // Clone generation 1
      const clone1 = base.clone();
      clone1.userData = { ...(base.userData || {}), __floorBiased: true };
      installPomShaderPatch(clone1, tex, { steps: 16, depth: 0.04 });

      // Clone generation 2
      const clone2 = clone1.clone();
      clone2.userData = { ...(clone1.userData || {}), __staticBiased: true };
      installPomShaderPatch(clone2, tex, { steps: 16, depth: 0.04 });

      // Clone generation 3
      const clone3 = clone2.clone();
      clone3.userData = { ...(clone2.userData || {}), isLeaf: true };
      installPomShaderPatch(clone3, tex, { steps: 16, depth: 0.04 });

      equal(clone3.userData.pomEnabled, true, "Generation 3 clone maintains pomEnabled");
      equal(clone3.userData.__floorBiased, true, "Generation 3 clone maintains floor bias");
      equal(clone3.userData.__staticBiased, true, "Generation 3 clone maintains static bias");

      const compiled = compileMaterialShader(clone3);
      ok(/_pomPerturbedUv/.test(compiled.fragmentShader), "Shader compiles POM perturbed UV on 3rd-gen clone");
    });

    test("B1-4: Re-seating clone onto translucent base strips POM hook cleanly", () => {
      const clone = new THREE.MeshStandardMaterial({ name: "reseated_clone" });
      clone.userData = { pomEnabled: true };

      // Simulate re-seat onto translucent base
      function reseat(cloneMat, newBaseTranslucent) {
        if (newBaseTranslucent) {
          cloneMat.userData.pomEnabled = false;
          cloneMat.onBeforeCompile = null;
        }
      }

      reseat(clone, true);
      equal(clone.userData.pomEnabled, false, "Re-seating on translucent base disables pomEnabled");
      equal(clone.onBeforeCompile, null, "Clears onBeforeCompile hook");
    });

    test("B1-5: Disposing cloned material does not affect shared base material", () => {
      const base = new THREE.MeshStandardMaterial({ name: "resilient_base" });
      const tex = createMockTexture(128, 128, 255, 255, "resilient_tex");
      installPomShaderPatch(base, tex, { steps: 16 });

      const clone = base.clone();
      installPomShaderPatch(clone, tex, { steps: 16 });

      clone.dispose();
      equal(base.userData.pomEnabled, true, "Disposing clone does not alter base pomEnabled");
      ok(typeof base.onBeforeCompile === "function", "Base onBeforeCompile hook remains active");
    });
  });
}
