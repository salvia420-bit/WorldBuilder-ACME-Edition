/**
 * apps/holtburger-web/tests/e2e_relief/tier2_boundaries/f9_oblique_slope_boundary.test.mjs
 *
 * Tier 2: Boundary & Corner Cases — F9: Oblique Slope Shading
 */

import { describe, test, ok, equal, near } from "../harness.mjs";

function evaluateObliqueSlopeShading(surfaceNormalY, sunElevationY) {
  const isVertical = Math.abs(surfaceNormalY) < 0.2;
  if (!isVertical) return 1.0;
  const t = Math.max(0.0, Math.min(1.0, (sunElevationY - 0.4) / 0.5));
  const ramp = t * t * (3.0 - 2.0 * t);
  return 1.0 - 0.45 * ramp;
}

export function runTests() {
  describe("F9: Oblique Slope Shading — Boundary & Corner Cases", () => {
    test("B9-1: Perfectly vertical surface (normal.y = 0.000)", () => {
      const shade = evaluateObliqueSlopeShading(0.0, 1.0);
      near(shade, 0.55, 1e-4, "Perfect vertical wall gets full 45% attenuation under noon sun");
    });

    test("B9-2: Perfectly horizontal surface (normal.y = 1.000)", () => {
      const shade = evaluateObliqueSlopeShading(1.0, 1.0);
      equal(shade, 1.0, "Horizontal surface is completely unaffected");
    });

    test("B9-3: Exact 45-degree sloped roof boundary (normal.y = 0.7071)", () => {
      const shade = evaluateObliqueSlopeShading(Math.SQRT1_2, 0.8);
      equal(shade, 1.0, "45-degree sloped roof is treated as pitched architecture, not vertical wall");
    });

    test("B9-4: Polar sun zenith (sunElevationY = 1.0) vs Horizon boundary (sunElevationY = 0.0)", () => {
      const zenith = evaluateObliqueSlopeShading(0.0, 1.0);
      const horizon = evaluateObliqueSlopeShading(0.0, 0.0);

      near(zenith, 0.55, 1e-4, "Zenith sun produces maximum 0.55 factor");
      equal(horizon, 1.0, "Horizon sun produces 1.0 factor");
    });

    test("B9-5: Negative sun elevation (night/dusk) handled defensively without negative multipliers", () => {
      const night = evaluateObliqueSlopeShading(0.0, -0.5);
      equal(night, 1.0, "Negative sun elevation clamps to 1.0 factor");
    });
  });
}
