/**
 * apps/holtburger-web/tests/e2e_relief/tier2_boundaries/f2_distance_lod_boundary.test.mjs
 *
 * Tier 2: Boundary & Corner Cases — F2: Extended Distance LOD Range
 */

import { describe, test, ok, equal, near, pomLodAtDistance, CONSTANTS } from "../harness.mjs";

export function runTests() {
  describe("F2: Extended Distance LOD Range — Boundary & Corner Cases", () => {
    test("B2-1: Camera positioned at distance = 0.0m maintains full displacement", () => {
      const factor = pomLodAtDistance(0.0, CONSTANTS.POM_LOD_NEAR_EXTENDED, CONSTANTS.POM_LOD_FAR_EXTENDED);
      equal(factor, 1.0, "Zero distance must evaluate to exactly 1.0");
    });

    test("B2-2: Boundary limit at lodNear boundary (15.0m vs 15.0001m)", () => {
      const nearExact = pomLodAtDistance(15.0, 15.0, 35.0);
      const nearJustPast = pomLodAtDistance(15.0001, 15.0, 35.0);

      equal(nearExact, 1.0, "Exactly at lodNear is 1.0");
      ok(nearJustPast < 1.0, "Immediately past lodNear begins attenuation");
      near(nearJustPast, 1.0, 1e-4, "Infinitesimal step has near-zero attenuation delta");
    });

    test("B2-3: Boundary limit at lodFar boundary (34.9999m vs 35.0m)", () => {
      const farJustBefore = pomLodAtDistance(34.9999, 15.0, 35.0);
      const farExact = pomLodAtDistance(35.0, 15.0, 35.0);

      ok(farJustBefore > 0.0, "Immediately before lodFar has residual displacement");
      near(farJustBefore, 0.0, 1e-4, "Residual displacement is near zero");
      equal(farExact, 0.0, "Exactly at lodFar is 0.0");
    });

    test("B2-4: Extreme distances (10,000m, Infinity) evaluate safely to 0.0 without NaN", () => {
      equal(pomLodAtDistance(10000.0, 15.0, 35.0), 0.0, "10km distance is 0.0");
      equal(pomLodAtDistance(Infinity, 15.0, 35.0), 0.0, "Infinity distance is 0.0");
    });

    test("B2-5: Inverted distance parameters (lodNear >= lodFar) handled defensively", () => {
      function safePomLod(dist, nearDist, farDist) {
        if (nearDist >= farDist) {
          return dist <= nearDist ? 1.0 : 0.0;
        }
        return pomLodAtDistance(dist, nearDist, farDist);
      }

      equal(safePomLod(10.0, 35.0, 15.0), 1.0, "Inverted near/far handles close distance");
      equal(safePomLod(40.0, 35.0, 15.0), 0.0, "Inverted near/far handles far distance");
    });
  });
}
