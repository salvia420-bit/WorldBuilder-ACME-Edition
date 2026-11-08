/**
 * apps/holtburger-web/tests/e2e_relief/tier1_features/f6_crevice_ao.test.mjs
 *
 * Tier 1: Feature Coverage — F6: Micro-Surface Crevice Ambient Occlusion
 * Requirement: ORIGINAL_REQUEST §R2, PROJECT.md Feature Inventory #6
 */

import { describe, test, equal, near, calculateCreviceAo } from "../harness.mjs";

export function runTests() {
  describe("F6: Micro-Surface Crevice Ambient Occlusion — Feature Coverage", () => {
    test("F6-1: Flat masonry (deltaH = 0) produces no occlusion (cavityAo = 1.0)", () => {
      const ao = calculateCreviceAo(0.0);
      equal(ao, 1.0, "Flat masonry must not be attenuated by crevice AO");
    });

    test("F6-2: Shallow mortar groove (deltaH = -0.2) attenuates diffuse by 30% (cavityAo = 0.70)", () => {
      const ao = calculateCreviceAo(-0.2);
      near(ao, 0.70, 1e-4, "cavityAo for deltaH=-0.2 must be 0.70");
    });

    test("F6-3: Moderate mortar joint (deltaH = -0.5) attenuates diffuse by 75% (cavityAo = 0.25)", () => {
      const ao = calculateCreviceAo(-0.5);
      near(ao, 0.25, 1e-4, "cavityAo for deltaH=-0.5 must be 0.25");
    });

    test("F6-4: Deep crevice (deltaH <= -0.67) clamps to 0.0 without going negative", () => {
      for (const d of [-0.67, -0.80, -1.0, -2.5]) {
        const ao = calculateCreviceAo(d);
        equal(ao, 0.0, `Deep crevice at deltaH=${d} must clamp to 0.0`);
      }
    });

    test("F6-5: Proud masonry faces (deltaH > 0) never suffer crevice darkening", () => {
      for (const d of [0.01, 0.2, 0.5, 1.0]) {
        const ao = calculateCreviceAo(d);
        equal(ao, 1.0, `Proud masonry face (deltaH=${d}) must remain at 1.0`);
      }
    });
  });
}
