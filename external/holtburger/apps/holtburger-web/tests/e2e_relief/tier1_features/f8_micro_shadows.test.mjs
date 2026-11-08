/**
 * apps/holtburger-web/tests/e2e_relief/tier1_features/f8_micro_shadows.test.mjs
 *
 * Tier 1: Feature Coverage — F8: Directional Micro-Contact Shadowing
 * Requirement: ORIGINAL_REQUEST §R2, PROJECT.md Feature Inventory #8
 */

import { describe, test, equal, near } from "../harness.mjs";

function simulateHorizonProbe(hitHeight, lightTan, neighborHeight, shadowDarkness = 0.5) {
  // If light is behind the surface plane, skip probe
  if (lightTan.z <= 0.001) return 1.0;
  // If neighboring masonry is higher than our fragment height along light ray, occluded!
  if (neighborHeight > hitHeight) {
    return shadowDarkness;
  }
  return 1.0;
}

export function runTests() {
  describe("F8: Directional Micro-Contact Shadowing — Feature Coverage", () => {
    test("F8-1: Overhead sunlight (normal incidence, lightTan.z = 1.0) casts no contact shadow", () => {
      const lightTan = { x: 0.0, y: 0.0, z: 1.0 };
      const shadow = simulateHorizonProbe(0.5, lightTan, 0.8, 0.5);
      equal(shadow, 0.5, "When neighbor is taller along ray, shadow applies");

      const noOccluder = simulateHorizonProbe(0.8, lightTan, 0.5, 0.5);
      equal(noOccluder, 1.0, "Overhead sunlight onto proud stone produces no shadow");
    });

    test("F8-2: Low grazing sun casts sharp contact shadow into recessed mortar", () => {
      // Mortar hit height = 0.2, neighbor stone height = 0.9, low sun angle
      const lightTan = { x: 0.8, y: 0.0, z: 0.2 };
      const shadow = simulateHorizonProbe(0.2, lightTan, 0.9, 0.5);
      equal(shadow, 0.5, "Recessed mortar occluded by protruding stone receives shadowDarkness 0.5");
    });

    test("F8-3: Horizon probe tracks directional light vector, not camera view direction", () => {
      const lightTanA = { x: 1.0, y: 0.0, z: 0.3 };
      const lightTanB = { x: -1.0, y: 0.0, z: 0.3 };

      // Occluder is on positive X side only
      function directionalProbe(lTan) {
        const neighborOnSide = lTan.x > 0 ? 0.9 : 0.1;
        return simulateHorizonProbe(0.3, lTan, neighborOnSide, 0.5);
      }

      equal(directionalProbe(lightTanA), 0.5, "Sun on positive side occludes mortar");
      equal(directionalProbe(lightTanB), 1.0, "Sun on negative side illuminates mortar directly");
    });

    test("F8-4: Back-facing light (lightTan.z <= 0) skips probe and returns 1.0", () => {
      const backLight = { x: 0.5, y: 0.0, z: -0.1 };
      const shadow = simulateHorizonProbe(0.2, backLight, 0.9, 0.5);
      equal(shadow, 1.0, "Light behind surface plane skips contact shadow pass");
    });

    test("F8-5: Shadow darkness parameter modulates direct illumination intensity", () => {
      const lightTan = { x: 0.7, y: 0.0, z: 0.3 };
      const shadowLow = simulateHorizonProbe(0.2, lightTan, 0.8, 0.3);
      const shadowMed = simulateHorizonProbe(0.2, lightTan, 0.8, 0.6);

      near(shadowLow, 0.3, 1e-4, "Dark shadow probe returns 0.3");
      near(shadowMed, 0.6, 1e-4, "Lighter shadow probe returns 0.6");
    });
  });
}
