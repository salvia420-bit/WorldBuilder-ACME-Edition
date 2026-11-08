/**
 * apps/holtburger-web/tests/e2e_relief/tier1_features/f5_modelgate_relaxation.test.mjs
 *
 * Tier 1: Feature Coverage — F5: ModelGate Threshold Relaxation
 * Requirement: ORIGINAL_REQUEST §R1, PROJECT.md Feature Inventory #5
 */

import { describe, test, ok, equal, passesModelGate, CONSTANTS } from "../harness.mjs";

export function runTests() {
  describe("F5: ModelGate Threshold Relaxation — Feature Coverage", () => {
    test("F5-1: Town perimeter retaining wall passes relaxed gate (previously rejected by legacy gate)", () => {
      // Retaining wall: 2.5m long, 15 m² area, 0.8m edge length, 0% double-sided
      const retainingWall = {
        bbox_extent_m: 2.5,
        total_area_m2: 15.0,
        median_edge_m: 0.8,
        double_sided_frac: 0.0,
      };

      const legacyResult = passesModelGate(retainingWall, CONSTANTS.MODELGATE_LEGACY);
      const relaxedResult = passesModelGate(retainingWall, CONSTANTS.MODELGATE_RELAXED);

      equal(legacyResult, false, "Legacy gate (bbox 4.0m, area 50m²) must reject small retaining wall");
      equal(relaxedResult, true, "Relaxed gate (bbox 2.0m, area 10m²) must allow retaining wall to receive chamfers");
    });

    test("F5-2: Town stone steps and perimeter fixtures pass relaxed gate", () => {
      const townSteps = {
        bbox_extent_m: 2.2,
        total_area_m2: 12.0,
        median_edge_m: 0.7,
        double_sided_frac: 0.05,
      };

      ok(passesModelGate(townSteps, CONSTANTS.MODELGATE_RELAXED), "Town stone steps must pass relaxed ModelGate");
      equal(passesModelGate(townSteps, CONSTANTS.MODELGATE_LEGACY), false, "Legacy ModelGate rejected town steps");
    });

    test("F5-3: Small interior props and items are still safely rejected", () => {
      const smallProp = {
        bbox_extent_m: 0.5,
        total_area_m2: 1.2,
        median_edge_m: 0.15,
        double_sided_frac: 0.0,
      };

      equal(passesModelGate(smallProp, CONSTANTS.MODELGATE_RELAXED), false, "Small prop (<2m) must not be railed as architecture");
    });

    test("F5-4: High double-sided fraction models (foliage, banners) are rejected", () => {
      const bannerOrShrub = {
        bbox_extent_m: 6.0,
        total_area_m2: 60.0,
        median_edge_m: 1.2,
        double_sided_frac: 0.80, // 80% double-sided
      };

      equal(passesModelGate(bannerOrShrub, CONSTANTS.MODELGATE_RELAXED), false, "High double-sided ratio (>25%) must be rejected");
    });

    test("F5-5: Standard large town buildings (e.g. 6m cube) pass both legacy and relaxed gates", () => {
      const buildingCube = {
        bbox_extent_m: 6.0,
        total_area_m2: 216.0,
        median_edge_m: 1.4,
        double_sided_frac: 0.0,
      };

      ok(passesModelGate(buildingCube, CONSTANTS.MODELGATE_LEGACY), "Standard building passes legacy gate");
      ok(passesModelGate(buildingCube, CONSTANTS.MODELGATE_RELAXED), "Standard building passes relaxed gate");
    });
  });
}
