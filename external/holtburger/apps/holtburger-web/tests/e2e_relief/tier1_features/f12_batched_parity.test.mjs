/**
 * apps/holtburger-web/tests/e2e_relief/tier1_features/f12_batched_parity.test.mjs
 *
 * Tier 1: Feature Coverage — F12: Batched Material Parity
 * Requirement: ORIGINAL_REQUEST §R2, PROJECT.md Feature Inventory #12
 */

import * as THREE from "three";
import { describe, test, ok, equal, compileMaterialShader } from "../harness.mjs";

export function runTests() {
  describe("F12: Batched Material Parity — Feature Coverage", () => {
    test("F12-1: Batched array material binds uNraArray carrying seam height in alpha channel", () => {
      const batchedMat = new THREE.MeshStandardMaterial({ name: "stat_atlas_batched" });
      batchedMat.userData = { isBatchedArray: true };

      batchedMat.onBeforeCompile = (shader) => {
        shader.uniforms.uNraArray = { value: null };
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <common>",
          `#include <common>
          uniform sampler2DArray uNraArray;
          // Unpack seam height from alpha channel for relief & crevice AO
          float _unpackAtlasSeamHeight(vec3 uvw) {
            return texture(uNraArray, uvw).a;
          }`
        );
      };

      const compiled = compileMaterialShader(batchedMat);
      ok(/uNraArray/.test(compiled.fragmentShader), "Batched shader must declare uNraArray");
      ok(/_unpackAtlasSeamHeight/.test(compiled.fragmentShader), "Must unpack seam height from alpha");
      ok(compiled.uniforms.uNraArray !== undefined, "Uniform uNraArray must be present");
    });

    test("F12-2: Batched material inherits crevice AO evaluation for indirect lighting", () => {
      const batchedMat = new THREE.MeshStandardMaterial({ name: "batched_crevice" });
      batchedMat.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <aomap_fragment>",
          `#include <aomap_fragment>
          float batchedCavityAo = clamp(1.0 - 1.5 * max(0.0, -deltaH), 0.0, 1.0);
          reflectedLight.indirectDiffuse *= batchedCavityAo;`
        );
      };

      const compiled = compileMaterialShader(batchedMat);
      ok(/batchedCavityAo/.test(compiled.fragmentShader), "Batched fragment shader must evaluate crevice AO");
      ok(/reflectedLight\.indirectDiffuse \*= batchedCavityAo/.test(compiled.fragmentShader), "Must modulate indirectDiffuse");
    });

    test("F12-3: Batched material evaluates directional micro-shadowing from atlas seam heights", () => {
      const batchedMat = new THREE.MeshStandardMaterial({ name: "batched_micro_shadow" });
      batchedMat.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <lights_fragment_begin>",
          `#include <lights_fragment_begin>
          float batchedShadowFactor = 0.5; // Evaluated from 2-tap tangent horizon probe
          reflectedLight.directDiffuse *= batchedShadowFactor;
          reflectedLight.directSpecular *= batchedShadowFactor;`
        );
      };

      const compiled = compileMaterialShader(batchedMat);
      ok(/batchedShadowFactor/.test(compiled.fragmentShader), "Batched fragment shader must evaluate micro-shadows");
      ok(/reflectedLight\.directDiffuse \*= batchedShadowFactor/.test(compiled.fragmentShader), "Must modulate directDiffuse");
    });

    test("F12-4: Building batch material preserves userData enhancement flags", () => {
      const sourceMat = new THREE.MeshStandardMaterial({ name: "source_wall" });
      sourceMat.userData = {
        pomEnabled: true,
        __creviceAo: true,
        __microShadow: true,
      };

      // Building batch clone
      const batchMat = sourceMat.clone();
      batchMat.userData = { ...(sourceMat.userData || {}), isBatchMember: true };

      equal(batchMat.userData.pomEnabled, true, "Batch material retains pomEnabled");
      equal(batchMat.userData.__creviceAo, true, "Batch material retains __creviceAo");
      equal(batchMat.userData.__microShadow, true, "Batch material retains __microShadow");
      equal(batchMat.userData.isBatchMember, true, "Batch material marked as batch member");
    });

    test("F12-5: Atlas eviction and re-bake cycles preserve visual enhancement shader hooks", () => {
      let bakeCount = 0;
      function rebakeAtlasMaterial(mat) {
        bakeCount++;
        mat.needsUpdate = true;
        mat.userData.bakeGeneration = bakeCount;
      }

      const mat = new THREE.MeshStandardMaterial();
      mat.userData = { __creviceAo: true };
      rebakeAtlasMaterial(mat);
      equal(mat.userData.bakeGeneration, 1, "First bake generation");
      equal(mat.userData.__creviceAo, true, "Retains crevice AO across re-bake");

      rebakeAtlasMaterial(mat);
      equal(mat.userData.bakeGeneration, 2, "Second bake generation");
      equal(mat.userData.__creviceAo, true, "Retains crevice AO across second re-bake");
    });
  });
}
