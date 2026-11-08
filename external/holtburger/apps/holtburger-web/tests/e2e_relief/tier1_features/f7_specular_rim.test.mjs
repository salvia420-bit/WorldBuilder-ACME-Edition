/**
 * apps/holtburger-web/tests/e2e_relief/tier1_features/f7_specular_rim.test.mjs
 *
 * Tier 1: Feature Coverage — F7: Specular Rim & Edge Curvature Highlighting
 * Requirement: ORIGINAL_REQUEST §R2, PROJECT.md Feature Inventory #7
 */

import { describe, test, equal, near, calculateSpecularRim } from "../harness.mjs";

export function runTests() {
  describe("F7: Specular Rim & Edge Curvature Highlighting — Feature Coverage", () => {
    test("F7-1: Glancing view on proud stone edge produces maximum specular rim highlight", () => {
      // dot(N, V) = 0 (glancing / grazing angle), deltaH = 1.0, gamma = 0.5
      const rim = calculateSpecularRim(1.0, 0.0, 0.5);
      near(rim, 0.5, 1e-4, "Glancing rim on proud edge with gamma=0.5 must be 0.5");
    });

    test("F7-2: Head-on view (dot(N, V) = 1.0) strictly produces zero rim highlight", () => {
      for (const d of [0.1, 0.5, 1.0, 2.0]) {
        const rim = calculateSpecularRim(d, 1.0, 0.5);
        equal(rim, 0.0, `Head-on view on edge with deltaH=${d} must produce 0.0 rim`);
      }
    });

    test("F7-3: Recessed mortar joints (deltaH <= 0) never receive specular rim highlighting", () => {
      for (const d of [-0.01, -0.2, -0.5, -1.0]) {
        const rim = calculateSpecularRim(d, 0.1, 0.5);
        equal(rim, 0.0, `Recessed mortar at deltaH=${d} must produce 0.0 rim highlight`);
      }
    });

    test("F7-4: Intermediate viewing angles ramp rim smoothly with Fresnel term (1 - |N·V|)", () => {
      // dot(N, V) = 0.5, deltaH = 0.8, gamma = 0.5
      // fresnel = 1 - 0.5 = 0.5; edgeRim = 0.5 * 0.8 * 0.5 = 0.20
      const rim = calculateSpecularRim(0.8, 0.5, 0.5);
      near(rim, 0.20, 1e-4, "Rim at 60 deg angle (N·V=0.5) must be 0.20");
    });

    test("F7-5: Gamma parameter scales specular highlight intensity predictably", () => {
      const deltaH = 0.6;
      const dotNV = 0.2; // fresnel = 0.8
      const rimLow = calculateSpecularRim(deltaH, dotNV, 0.25);
      const rimHigh = calculateSpecularRim(deltaH, dotNV, 0.50);

      near(rimLow, 0.25 * 0.6 * 0.8, 1e-4, "Low gamma rim calculation");
      near(rimHigh, 0.50 * 0.6 * 0.8, 1e-4, "High gamma rim calculation");
      near(rimHigh, rimLow * 2.0, 1e-4, "Doubling gamma doubles rim boost");
    });
  });
}
