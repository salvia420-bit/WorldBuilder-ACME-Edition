/**
 * apps/holtburger-web/tests/e2e_relief/tier1_features/f2_distance_lod.test.mjs
 *
 * Tier 1: Feature Coverage — F2: Extended Distance LOD Range
 * Requirement: ORIGINAL_REQUEST §R1, PROJECT.md Feature Inventory #2
 */

import { describe, test, ok, equal, near, pomLodAtDistance, CONSTANTS } from "../harness.mjs";

export function runTests() {
  describe("F2: Extended Distance LOD Range — Feature Coverage", () => {
    test("F2-1: POM LOD factor is strictly 1.0 within extended near distance (0m to 15m)", () => {
      for (const dist of [0.0, 2.0, 5.0, 10.0, 14.9, 15.0]) {
        const factor = pomLodAtDistance(dist, CONSTANTS.POM_LOD_NEAR_EXTENDED, CONSTANTS.POM_LOD_FAR_EXTENDED);
        equal(factor, 1.0, `LOD factor at ${dist}m must be exactly 1.0`);
      }
    });

    test("F2-2: Smooth continuous attenuation across the 15m to 35m band without popping", () => {
      let prevFactor = 1.0;
      for (let dist = 16.0; dist < 35.0; dist += 2.0) {
        const factor = pomLodAtDistance(dist, CONSTANTS.POM_LOD_NEAR_EXTENDED, CONSTANTS.POM_LOD_FAR_EXTENDED);
        ok(factor < prevFactor, `LOD factor at ${dist}m (${factor.toFixed(4)}) must be strictly less than previous (${prevFactor.toFixed(4)})`);
        ok(factor > 0.0 && factor < 1.0, `LOD factor at ${dist}m must be strictly inside (0, 1)`);
        prevFactor = factor;
      }
    });

    test("F2-3: Exact midpoint (25m) attenuation matches smoothstep half-weight (0.500)", () => {
      const midDist = (CONSTANTS.POM_LOD_NEAR_EXTENDED + CONSTANTS.POM_LOD_FAR_EXTENDED) * 0.5;
      const factor = pomLodAtDistance(midDist, CONSTANTS.POM_LOD_NEAR_EXTENDED, CONSTANTS.POM_LOD_FAR_EXTENDED);
      near(factor, 0.5, 1e-4, "LOD factor at 25m midpoint must be 0.5");
    });

    test("F2-4: POM LOD factor is strictly 0.0 at and beyond far threshold (35m)", () => {
      for (const dist of [35.0, 36.0, 50.0, 100.0, 250.0]) {
        const factor = pomLodAtDistance(dist, CONSTANTS.POM_LOD_NEAR_EXTENDED, CONSTANTS.POM_LOD_FAR_EXTENDED);
        equal(factor, 0.0, `LOD factor at ${dist}m must be 0.0`);
      }
    });

    test("F2-5: Ultra preset extends LOD range out to 50.0m", () => {
      const ultraNear = 15.0;
      const ultraFar = CONSTANTS.POM_LOD_FAR_ULTRA; // 50.0m
      const ultraMid = (ultraNear + ultraFar) * 0.5; // 32.5m
      const factorMid = pomLodAtDistance(ultraMid, ultraNear, ultraFar);
      near(factorMid, 0.5, 1e-4, "At ultra midpoint (32.5m), factor is exactly 0.5");

      const factor35m = pomLodAtDistance(35.0, ultraNear, ultraFar);
      ok(factor35m > 0.0, `Ultra preset must still be active at 35m, got ${factor35m}`);
      near(factor35m, 0.3936, 0.01, "At 35m, ultra preset is active with ~0.394 amplitude");
      equal(pomLodAtDistance(50.0, ultraNear, ultraFar), 0.0, "LOD factor at 50m must be 0.0");
    });
  });
}
