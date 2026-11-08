/**
 * apps/holtburger-web/tests/e2e_relief/tier2_boundaries/f8_micro_shadows_boundary.test.mjs
 *
 * Tier 2: Boundary & Corner Cases — F8: Directional Micro-Contact Shadowing
 */

import { describe, test, equal } from "../harness.mjs";

function simulateHorizonProbe(hitHeight, lightTan, neighborHeight, shadowDarkness = 0.5) {
  if (lightTan.z <= 0.001) return 1.0;
  if (neighborHeight > hitHeight) {
    return shadowDarkness;
  }
  return 1.0;
}

export function runTests() {
  describe("F8: Directional Micro-Contact Shadowing — Boundary & Corner Cases", () => {
    test("B8-1: Horizon grazing boundary with lightTan.z exactly at epsilon threshold (0.001)", () => {
      const atEps = { x: 1.0, y: 0.0, z: 0.001 };
      const aboveEps = { x: 1.0, y: 0.0, z: 0.0011 };

      equal(simulateHorizonProbe(0.2, atEps, 0.8, 0.5), 1.0, "At <= 0.001, probe skips to avoid singularity");
      equal(simulateHorizonProbe(0.2, aboveEps, 0.8, 0.5), 0.5, "Just above 0.001, horizon probe runs and detects occluder");
    });

    test("B8-2: Boundary shadow darkness values (0.0 pitch black vs 1.0 unshadowed)", () => {
      const lightTan = { x: 0.8, y: 0.0, z: 0.3 };
      const blackShadow = simulateHorizonProbe(0.2, lightTan, 0.8, 0.0);
      const noShadow = simulateHorizonProbe(0.2, lightTan, 0.8, 1.0);

      equal(blackShadow, 0.0, "shadowDarkness=0.0 drops direct illumination to 0");
      equal(noShadow, 1.0, "shadowDarkness=1.0 keeps illumination full");
    });

    test("B8-3: Identical fragment and occluder heights (coplanar surface) produce no shadow", () => {
      const lightTan = { x: 0.8, y: 0.0, z: 0.3 };
      const shadow = simulateHorizonProbe(0.5, lightTan, 0.5, 0.5);
      equal(shadow, 1.0, "Coplanar neighbor does not occlude fragment");
    });

    test("B8-4: Light vector with zero horizontal component (purely normal light)", () => {
      const pureNormal = { x: 0.0, y: 0.0, z: 1.0 };
      const shadow = simulateHorizonProbe(0.2, pureNormal, 0.8, 0.5);
      equal(shadow, 0.5, "Directly occluded overhead cavity takes shadow");
    });

    test("B8-5: Zero-length light vector input handled safely", () => {
      const zeroLight = { x: 0.0, y: 0.0, z: 0.0 };
      const shadow = simulateHorizonProbe(0.2, zeroLight, 0.8, 0.5);
      equal(shadow, 1.0, "Zero light vector safely returns 1.0 without dividing by zero");
    });
  });
}
