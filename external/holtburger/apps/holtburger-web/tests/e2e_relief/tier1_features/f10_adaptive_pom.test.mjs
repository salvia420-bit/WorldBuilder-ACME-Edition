/**
 * apps/holtburger-web/tests/e2e_relief/tier1_features/f10_adaptive_pom.test.mjs
 *
 * Tier 1: Feature Coverage — F10: Adaptive POM & Silhouette Grazing Clamping
 * Requirement: ORIGINAL_REQUEST §R2, PROJECT.md Feature Inventory #10
 */

import { describe, test, ok, equal, near, pomGrazeWeight, CONSTANTS } from "../harness.mjs";

export function runTests() {
  describe("F10: Adaptive POM & Silhouette Grazing Clamping — Feature Coverage", () => {
    test("F10-1: Head-on view (z = 1.0) achieves full grazing weight (grazeW = 1.0)", () => {
      const { pz, grazeW } = pomGrazeWeight(1.0, true);
      equal(pz, 1.0, "Projection denominator at z=1.0 must be 1.0");
      equal(grazeW, 1.0, "Grazing weight at head-on view must be 1.0");
    });

    test("F10-2: Extreme grazing angle (z <= 0.12) clamps pz to 0.12 and zeroes graze weight (grazeW = 0.0)", () => {
      for (const z of [0.0, 0.02, 0.05, 0.10, 0.12]) {
        const { pz, grazeW } = pomGrazeWeight(z, true);
        equal(pz, CONSTANTS.GRAZE_EPSILON_BOUNDED, `pz at z=${z} must clamp to 0.12`);
        equal(grazeW, 0.0, `grazeW at z=${z} must be strictly 0.0 (preventing stalactites)`);
      }
    });

    test("F10-3: Smoothstep transition across the 0.12 to 0.45 ramp eliminates edge popping", () => {
      let prevWeight = 0.0;
      for (let z = 0.15; z <= 0.45; z += 0.05) {
        const { grazeW } = pomGrazeWeight(z, true);
        ok(grazeW >= prevWeight, `Weight at z=${z.toFixed(2)} (${grazeW.toFixed(4)}) must be >= previous (${prevWeight.toFixed(4)})`);
        ok(grazeW >= 0.0 && grazeW <= 1.0, `Weight at z=${z} must be inside [0, 1]`);
        prevWeight = grazeW;
      }
      equal(pomGrazeWeight(0.45, true).grazeW, 1.0, "Weight at z=0.45 reaches 1.0");
    });

    test("F10-4: Grazing step ramp increases raymarch steps to maintain sample spacing", () => {
      function calculateGrazingSteps(baseSteps, tanDirZ) {
        const { pz } = pomGrazeWeight(tanDirZ, true);
        return Math.floor(Math.min(64.0, baseSteps * Math.min(3.0, Math.max(1.0, 1.0 / pz)) + 0.5));
      }

      const stepsHeadOn = calculateGrazingSteps(16, 1.0);
      const stepsGlance = calculateGrazingSteps(16, 0.2);

      equal(stepsHeadOn, 16, "Head-on steps should equal base steps 16");
      ok(stepsGlance > stepsHeadOn, `Glancing steps (${stepsGlance}) must exceed head-on steps (16)`);
      ok(stepsGlance <= 64, "Steps must be clamped at 64");
    });

    test("F10-5: Bounded projection limits UV travel distance to at most ~8x depthScale", () => {
      const depthScale = 0.04;
      const { pz } = pomGrazeWeight(0.01, true); // pz clamped to 0.12
      const maxShift = depthScale / pz;

      near(maxShift, 0.04 / 0.12, 1e-4, "Maximum UV travel is bounded to depthScale / 0.12");
      ok(maxShift <= 0.35, "UV travel is strictly bounded, preventing runaway smearing");
    });
  });
}
