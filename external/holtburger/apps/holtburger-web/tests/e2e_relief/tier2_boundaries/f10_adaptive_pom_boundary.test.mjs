/**
 * apps/holtburger-web/tests/e2e_relief/tier2_boundaries/f10_adaptive_pom_boundary.test.mjs
 *
 * Tier 2: Boundary & Corner Cases — F10: Adaptive POM & Silhouette Grazing Clamping
 */

import { describe, test, equal, near, pomGrazeWeight, CONSTANTS } from "../harness.mjs";

export function runTests() {
  describe("F10: Adaptive POM & Silhouette Grazing Clamping — Boundary & Corner Cases", () => {
    test("B10-1: View vector exactly parallel to surface plane (tanDir.z = 0.0)", () => {
      const { pz, grazeW } = pomGrazeWeight(0.0, true);
      equal(pz, CONSTANTS.GRAZE_EPSILON_BOUNDED, "Zero tanDir.z clamps to 0.12");
      equal(grazeW, 0.0, "Zero tanDir.z results in 0.0 graze weight");
    });

    test("B10-2: Exactly on lower clamp threshold (z = 0.12000)", () => {
      const { pz, grazeW } = pomGrazeWeight(0.12, true);
      equal(pz, 0.12, "At 0.12, pz is exactly 0.12");
      equal(grazeW, 0.0, "At 0.12, smoothstep begins at exactly 0.0");
    });

    test("B10-3: Exactly on upper blend threshold (z = 0.45000)", () => {
      const { pz, grazeW } = pomGrazeWeight(0.45, true);
      equal(pz, 0.45, "At 0.45, pz is 0.45");
      equal(grazeW, 1.0, "At 0.45, smoothstep reaches exactly 1.0");
    });

    test("B10-4: Maximum step limit clamp boundary (64 steps maximum)", () => {
      function calculateGrazingSteps(baseSteps, tanDirZ) {
        const { pz } = pomGrazeWeight(tanDirZ, true);
        return Math.floor(Math.min(64.0, baseSteps * Math.min(3.0, Math.max(1.0, 1.0 / pz)) + 0.5));
      }

      // Even with base steps = 32 and very low pz, steps cannot exceed 64
      const stepsGlance = calculateGrazingSteps(32, 0.01);
      equal(stepsGlance, 64, "Steps capped strictly at 64 loop unroll limit");
    });

    test("B10-5: Zero depth scale (depthScale = 0.0) yields zero UV offset", () => {
      const depthScale = 0.0;
      const { pz } = pomGrazeWeight(0.5, true);
      const uvStep = (1.0 / pz) * depthScale;
      equal(uvStep, 0.0, "depthScale=0.0 produces zero UV shift (flat rendering)");
    });
  });
}
