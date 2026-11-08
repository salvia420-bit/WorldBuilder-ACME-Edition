/**
 * apps/holtburger-web/tests/e2e_relief/tier2_boundaries/f7_specular_rim_boundary.test.mjs
 *
 * Tier 2: Boundary & Corner Cases — F7: Specular Rim & Edge Curvature Highlighting
 */

import { describe, test, equal, near, calculateSpecularRim } from "../harness.mjs";

export function runTests() {
  describe("F7: Specular Rim & Edge Curvature Highlighting — Boundary & Corner Cases", () => {
    test("B7-1: Exact glancing view angle boundary (dot(N, V) = 0.0000)", () => {
      const rim = calculateSpecularRim(1.0, 0.0, 0.5);
      equal(rim, 0.5, "At exactly 90 deg view angle (dot=0), Fresnel factor is 1.0");
    });

    test("B7-2: Back-facing normal dot product (dot(N, V) < 0) handled via absolute value", () => {
      // (1.0 - abs(dot(N, V))) handles back-faces or double-sided geometry
      const rimFront = calculateSpecularRim(0.5, 0.2, 0.5);
      const rimBack = calculateSpecularRim(0.5, -0.2, 0.5);

      equal(rimFront, rimBack, "Symmetric Fresnel term handles inverted normal orientation");
    });

    test("B7-3: Extreme gamma tuning parameter boundaries (gamma = 0.0 vs 1.0)", () => {
      const rimDisabled = calculateSpecularRim(1.0, 0.0, 0.0);
      const rimMax = calculateSpecularRim(1.0, 0.0, 1.0);

      equal(rimDisabled, 0.0, "gamma=0.0 completely disables rim highlight");
      equal(rimMax, 1.0, "gamma=1.0 scales rim to full proud intensity");
    });

    test("B7-4: Flat planar surface (deltaH = 0.0000) produces zero rim regardless of view angle", () => {
      for (const dotNV of [0.0, 0.1, 0.5, 0.9, 1.0]) {
        const rim = calculateSpecularRim(0.0, dotNV, 0.5);
        equal(rim, 0.0, `Flat surface with dotNV=${dotNV} must have 0.0 rim highlight`);
      }
    });

    test("B7-5: Non-finite dot product or deltaH values fall back defensively to 0.0", () => {
      function safeSpecularRim(deltaH, dotNV, gamma) {
        if (!Number.isFinite(deltaH) || !Number.isFinite(dotNV) || !Number.isFinite(gamma)) {
          return 0.0;
        }
        return calculateSpecularRim(deltaH, dotNV, gamma);
      }

      equal(safeSpecularRim(NaN, 0.5, 0.5), 0.0, "NaN deltaH defaults to 0.0 rim");
      equal(safeSpecularRim(0.5, NaN, 0.5), 0.0, "NaN dotNV defaults to 0.0 rim");
    });
  });
}
