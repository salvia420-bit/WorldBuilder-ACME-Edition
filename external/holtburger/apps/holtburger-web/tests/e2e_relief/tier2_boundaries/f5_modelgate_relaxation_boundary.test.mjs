/**
 * apps/holtburger-web/tests/e2e_relief/tier2_boundaries/f5_modelgate_relaxation_boundary.test.mjs
 *
 * Tier 2: Boundary & Corner Cases — F5: ModelGate Threshold Relaxation
 */

import { describe, test, equal, passesModelGate, CONSTANTS } from "../harness.mjs";

export function runTests() {
  describe("F5: ModelGate Threshold Relaxation — Boundary & Corner Cases", () => {
    test("B5-1: Exactly on bbox boundary (2.000m vs 1.999m)", () => {
      const gate = CONSTANTS.MODELGATE_RELAXED;
      const atBbox = { bbox_extent_m: 2.0, total_area_m2: 15.0, median_edge_m: 0.8, double_sided_frac: 0.0 };
      const belowBbox = { bbox_extent_m: 1.999, total_area_m2: 15.0, median_edge_m: 0.8, double_sided_frac: 0.0 };

      equal(passesModelGate(atBbox, gate), true, "Exactly 2.0m extent passes gate");
      equal(passesModelGate(belowBbox, gate), false, "1.999m extent fails gate");
    });

    test("B5-2: Exactly on area boundary (10.000m² vs 9.999m²)", () => {
      const gate = CONSTANTS.MODELGATE_RELAXED;
      const atArea = { bbox_extent_m: 3.0, total_area_m2: 10.0, median_edge_m: 0.8, double_sided_frac: 0.0 };
      const belowArea = { bbox_extent_m: 3.0, total_area_m2: 9.999, median_edge_m: 0.8, double_sided_frac: 0.0 };

      equal(passesModelGate(atArea, gate), true, "Exactly 10.0m² area passes gate");
      equal(passesModelGate(belowArea, gate), false, "9.999m² area fails gate");
    });

    test("B5-3: Exactly on median edge boundary (0.600m vs 0.599m)", () => {
      const gate = CONSTANTS.MODELGATE_RELAXED;
      const atEdge = { bbox_extent_m: 3.0, total_area_m2: 15.0, median_edge_m: 0.60, double_sided_frac: 0.0 };
      const belowEdge = { bbox_extent_m: 3.0, total_area_m2: 15.0, median_edge_m: 0.599, double_sided_frac: 0.0 };

      equal(passesModelGate(atEdge, gate), true, "Exactly 0.60m median edge passes gate");
      equal(passesModelGate(belowEdge, gate), false, "0.599m median edge fails gate");
    });

    test("B5-4: Exactly on double-sided fraction ceiling (25.0% vs 25.1%)", () => {
      const gate = CONSTANTS.MODELGATE_RELAXED;
      const atCeil = { bbox_extent_m: 3.0, total_area_m2: 15.0, median_edge_m: 0.8, double_sided_frac: 0.25 };
      const aboveCeil = { bbox_extent_m: 3.0, total_area_m2: 15.0, median_edge_m: 0.8, double_sided_frac: 0.251 };

      equal(passesModelGate(atCeil, gate), true, "25.0% double-sided fraction passes gate");
      equal(passesModelGate(aboveCeil, gate), false, "25.1% double-sided fraction fails gate");
    });

    test("B5-5: Degenerate geometry (0 dimensions, negative values) safely rejected", () => {
      const gate = CONSTANTS.MODELGATE_RELAXED;
      const zeroModel = { bbox_extent_m: 0.0, total_area_m2: 0.0, median_edge_m: 0.0, double_sided_frac: 0.0 };
      const negativeModel = { bbox_extent_m: -5.0, total_area_m2: -20.0, median_edge_m: -1.0, double_sided_frac: 0.0 };

      equal(passesModelGate(zeroModel, gate), false, "Zero-extent model rejected");
      equal(passesModelGate(negativeModel, gate), false, "Negative-dimension model rejected");
    });
  });
}
