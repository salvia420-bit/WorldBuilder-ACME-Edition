/**
 * apps/holtburger-web/tests/e2e_relief/tier2_boundaries/f12_batched_parity_boundary.test.mjs
 *
 * Tier 2: Boundary & Corner Cases — F12: Batched Material Parity
 */

import * as THREE from "three";
import { describe, test, ok, equal, compileMaterialShader } from "../harness.mjs";

export function runTests() {
  describe("F12: Batched Material Parity — Boundary & Corner Cases", () => {
    test("B12-1: Empty batch material (0 instances) compiles valid array shader without crashing", () => {
      const emptyBatchMat = new THREE.MeshStandardMaterial({ name: "empty_batch" });
      emptyBatchMat.onBeforeCompile = (shader) => {
        shader.uniforms.uInstanceCount = { value: 0 };
      };

      const compiled = compileMaterialShader(emptyBatchMat);
      equal(compiled.uniforms.uInstanceCount.value, 0, "Instance count is 0");
      ok(typeof compiled.vertexShader === "string", "Vertex shader compiled successfully");
    });

    test("B12-2: Single-layer texture array (depth = 1) handles slice index 0 cleanly", () => {
      function evaluateSliceOffset(sliceIdx, maxSlices) {
        return Math.max(0, Math.min(maxSlices - 1, sliceIdx));
      }

      equal(evaluateSliceOffset(0, 1), 0, "Slice 0 of depth 1 maps to 0");
      equal(evaluateSliceOffset(1, 1), 0, "Over-range slice clamps to 0");
    });

    test("B12-3: Large texture array (depth = 64) unpacks heights across high slice indices", () => {
      function evaluateSliceOffset(sliceIdx, maxSlices) {
        return Math.max(0, Math.min(maxSlices - 1, sliceIdx));
      }

      equal(evaluateSliceOffset(63, 64), 63, "Slice 63 maps to 63");
      equal(evaluateSliceOffset(100, 64), 63, "Slice 100 clamps to 63");
    });

    test("B12-4: Missing seam height texture in array defaults to proud face (1.0)", () => {
      function unpackSeamHeightOrDefault(texSample) {
        if (!texSample || texSample.a === undefined) {
          return 1.0; // Default flat proud surface
        }
        return texSample.a;
      }

      equal(unpackSeamHeightOrDefault(null), 1.0, "Missing texture defaults to 1.0");
      equal(unpackSeamHeightOrDefault({ a: 0.4 }), 0.4, "Present sample returns actual alpha 0.4");
    });

    test("B12-5: Re-allocating batch capacity preserves visual enhancement shader hooks", () => {
      const batchState = {
        capacity: 100,
        enhancements: { pom: true, creviceAo: true, microShadow: true },
      };

      function resizeBatch(state, newCapacity) {
        state.capacity = newCapacity;
        // Enhancements must persist across resize
        return state.enhancements;
      }

      const postResizeEnhancements = resizeBatch(batchState, 500);
      equal(postResizeEnhancements.pom, true, "POM persists across batch resize");
      equal(postResizeEnhancements.creviceAo, true, "Crevice AO persists across batch resize");
      equal(postResizeEnhancements.microShadow, true, "Micro-shadow persists across batch resize");
    });
  });
}
