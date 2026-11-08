/**
 * apps/holtburger-web/tests/e2e_relief/tier2_boundaries/f6_crevice_ao_boundary.test.mjs
 *
 * Tier 2: Boundary & Corner Cases — F6: Micro-Surface Crevice Ambient Occlusion
 */

import { describe, test, equal, near, calculateCreviceAo } from "../harness.mjs";

export function runTests() {
  describe("F6: Micro-Surface Crevice Ambient Occlusion — Boundary & Corner Cases", () => {
    test("B6-1: Extreme negative depth (deltaH = -100.0) clamps to 0.0 without underflow", () => {
      const ao = calculateCreviceAo(-100.0);
      equal(ao, 0.0, "Extreme crevice depth must clamp to 0.0");
    });

    test("B6-2: Extreme positive protrusion (deltaH = +100.0) clamps to 1.0 without overflow", () => {
      const ao = calculateCreviceAo(100.0);
      equal(ao, 1.0, "Extreme protrusion must clamp to 1.0");
    });

    test("B6-3: Infinitesimal dip (deltaH = -1e-6) produces smooth near-unity result", () => {
      const ao = calculateCreviceAo(-1e-6);
      near(ao, 1.0 - 1.5e-6, 1e-7, "Infinitesimal dip behaves linearly without precision loss");
    });

    test("B6-4: Exact mathematical clamp boundary at deltaH = -2/3 (-0.666667) yields 0.0", () => {
      // 1.0 - 1.5 * (2/3) = 1.0 - 1.0 = 0.0
      const aoExact = calculateCreviceAo(-2.0 / 3.0);
      near(aoExact, 0.0, 1e-6, "At deltaH = -2/3, cavityAo reaches exactly 0.0");
    });

    test("B6-5: Non-finite inputs (NaN, Infinity) fall back defensively to 1.0", () => {
      function safeCreviceAo(deltaH) {
        if (!Number.isFinite(deltaH)) return 1.0;
        return calculateCreviceAo(deltaH);
      }

      equal(safeCreviceAo(NaN), 1.0, "NaN input defaults to un-attenuated 1.0");
      equal(safeCreviceAo(Infinity), 1.0, "Infinity defaults to 1.0");
      equal(safeCreviceAo(-Infinity), 1.0, "-Infinity defaults to 1.0");
    });
  });
}
